import { randomBytes } from 'node:crypto';
/**
 * Fleet admission: who may join a fleet, who may be removed, and by how many votes.
 *
 * ## Why this is a state machine and not a route handler
 *
 * Every rule the operator set is a *time window* or a *quorum*, and both are the kind of logic that reads correctly in
 * a route handler and is wrong at the edges: a decision that arrives one millisecond after the automatic one, a vote
 * whose quorum changes because a voter went offline mid-vote, a removal of the last member. None of that needs a socket,
 * so none of it is tested through one -- the routes are thin wrappers over this file.
 *
 * ## The four operator decisions this encodes (2026-10-17)
 *
 * 1. the OLD mechanism stays the default; this one is the fallback, so nothing here is on any startup path yet;
 * 2. `autoApproveMs = 10_000` -- but **never** with zero members online, because an empty fleet cannot consent;
 * 3. a fleet of 2 needs 1 vote (= 50%), 3 or more needs >= 50% rounded up;
 * 4. the quorum denominator is **currently online old members only**, so the set is **frozen when the vote opens**.
 *
 * ## Clock
 *
 * Every decision is stamped with `now()`, which the caller supplies. The default is `Date.now`; the tests pass a
 * clock they control, and production uses the relay's clock. **No client clock is ever trusted** -- three machines in
 * this fleet disagreed by tens of seconds, and a vote that opens or closes on a client clock is a vote an attacker
 * schedules.
 */

/** Request states. A request that is not `approved` grants nothing. */
export const ADMISSION = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
});

/** Operator decision: 10s, and only while at least one member is online. */
export const AUTO_APPROVE_MS = 10_000;
/** A request nobody decided expires, so a machine cannot wait forever on a fleet that is gone. */
export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Removal is immediate inside this window; after it, a vote is required. */
export const KICK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a removal vote stays open. */
export const VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The quorum, as the operator stated it: 3+ old members needs >= 50% rounded up; a fleet of 2 needs **one** vote.
 *
 * `Math.ceil(n / 2)` would demand 2 votes from a two-member fleet, which makes removal impossible -- the operator
 * called that out explicitly ("2 人小编队一人就行").
 */
export function neededVotes(onlineOldMembers) {
  const n = Number.isInteger(onlineOldMembers) && onlineOldMembers > 0 ? onlineOldMembers : 0;
  if (n === 0) return 0;
  if (n <= 2) return 1;
  return Math.ceil(n / 2);
}

/**
 * @param {{now?: () => number, autoApproveMs?: number}} [options]
 */
export function createAdmission(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const autoApproveMs = Number.isInteger(options.autoApproveMs) ? options.autoApproveMs : AUTO_APPROVE_MS;

  /** machine_id -> {joined_at_ms, fleet_id} for every APPROVED member. */
  const members = new Map();
  let joinSeq = 0;
  /** request_id -> request record. */
  const requests = new Map();
  /** removal_id -> vote record. */
  const removals = new Map();
  let seq = 0;
  const nextId = (prefix) => { seq += 1; return prefix + '-' + String(seq).padStart(4, '0'); };

  const onlineMembers = () => [...members.keys()].filter((id) => members.get(id).online === true);

  function seedFounder(machine_id, fleet_id = 'fleet-1', online = true) {
    joinSeq += 1;
    members.set(machine_id, { joined_at_ms: now(), fleet_id, online, join_seq: joinSeq });
    return memberOf(machine_id);
  }

  function memberOf(machine_id) {
    const m = members.get(machine_id);
    return m === undefined ? null : { machine_id, joined_at_ms: m.joined_at_ms, fleet_id: m.fleet_id, online: m.online === true };
  }

  /** A pending request grants nothing: this is what the dispatch path asks. */
  function isMember(machine_id) { return members.has(machine_id); }

  function setOnline(machine_id, online) {
    const m = members.get(machine_id);
    if (m === undefined) return false;
    m.online = online === true;
    return true;
  }

  function requestAdmission({ machine_id, machine_name = null, account_fingerprint = null, fleet_id = 'fleet-1' }) {
    if (typeof machine_id !== 'string' || machine_id === '') throw new Error('machine_id is required');
    if (members.has(machine_id)) return { ok: true, already_member: true, state: ADMISSION.APPROVED, request_id: null };
    // One open request per machine: re-requesting returns the same record rather than creating a queue.
    for (const r of requests.values()) {
      if (r.machine_id === machine_id && r.state === ADMISSION.PENDING) return { ok: true, request_id: r.request_id, state: r.state, replayed: true };
    }
    // A fleet with no members has nobody to approve, so the first machine founds it.
    if (members.size === 0) {
      joinSeq += 1;
      members.set(machine_id, { joined_at_ms: now(), fleet_id, online: true, join_seq: joinSeq });
      return { ok: true, state: ADMISSION.APPROVED, request_id: null, founder: true };
    }
    const request_id = nextId('adm');
    requests.set(request_id, {
      request_id, machine_id, machine_name, account_fingerprint, fleet_id,
      state: ADMISSION.PENDING, requested_at_ms: now(), decided_at_ms: null,
      decided_by: null, auto: false,
      poll_token: randomBytes(16).toString('hex'),
    });
    return { ok: true, request_id, state: ADMISSION.PENDING, poll_token: requests.get(request_id).poll_token };
  }

  function getRequest(request_id) {
    const r = requests.get(request_id);
    return r === undefined ? null : { ...r };
  }

  /**
   * Approve or reject. `auto` is recorded, because "nobody was watching" and "a person said yes" are different facts.
   */
  function decide(request_id, { decision, decided_by = null, auto = false }) {
    const r = requests.get(request_id);
    if (r === undefined) return { ok: false, code: 'NOT_FOUND' };
    if (r.state !== ADMISSION.PENDING) return { ok: false, code: 'ALREADY_DECIDED', state: r.state };
    if (decision !== 'approve' && decision !== 'reject') return { ok: false, code: 'BAD_DECISION' };
    if (auto === true && onlineMembers().length === 0) {
      // An empty fleet cannot consent. This is the one rule that must not be relaxed for convenience.
      return { ok: false, code: 'NO_ONLINE_MEMBER' };
    }
    r.state = decision === 'approve' ? ADMISSION.APPROVED : ADMISSION.REJECTED;
    r.decided_at_ms = now();
    r.decided_by = decided_by;
    r.auto = auto === true;
    if (r.state === ADMISSION.APPROVED) {
      joinSeq += 1;
      members.set(r.machine_id, { joined_at_ms: r.decided_at_ms, fleet_id: r.fleet_id, online: true, join_seq: joinSeq });
    }
    return { ok: true, request_id, state: r.state, auto: r.auto };
  }

  /**
   * Tick: applies the automatic approval and the request TTL. Called by the caller's timer, not by a setTimeout here,
   * so a test controls time completely.
   */
  function tick() {
    const t = now();
    const decided = [];
    for (const r of requests.values()) {
      if (r.state !== ADMISSION.PENDING) continue;
      const age = t - r.requested_at_ms;
      if (age >= REQUEST_TTL_MS) { r.state = ADMISSION.EXPIRED; r.decided_at_ms = t; decided.push({ request_id: r.request_id, state: r.state }); continue; }
      if (age >= autoApproveMs && onlineMembers().length > 0) {
        r.state = ADMISSION.APPROVED; r.decided_at_ms = t; r.decided_by = 'auto'; r.auto = true;
        joinSeq += 1;
        members.set(r.machine_id, { joined_at_ms: t, fleet_id: r.fleet_id, online: true, join_seq: joinSeq });
        decided.push({ request_id: r.request_id, state: r.state, auto: true });
      }
    }
    return decided;
  }

  /**
   * Remove a member.
   *
   * Inside KICK_WINDOW_MS of joining, any online member may do it immediately. After that, a single machine may only
   * OPEN a vote: the quorum set is frozen here, at open time, so a voter going offline mid-vote cannot silently lower
   * the bar (or raise it).
   */
  function remove(target_machine_id, { requested_by, reason = null }) {
    const target = members.get(target_machine_id);
    if (target === undefined) return { ok: false, code: 'NOT_A_MEMBER' };
    if (requested_by === target_machine_id) return { ok: false, code: 'CANNOT_REMOVE_SELF' };
    if (!members.has(requested_by)) return { ok: false, code: 'NOT_A_MEMBER' };
    if (members.size <= 1) return { ok: false, code: 'LAST_MEMBER' };

    const age = now() - target.joined_at_ms;
    // Insertion order, not timestamps: two machines approved inside the same millisecond are equal on the clock but
    // still have an order, and a quorum that depends on a sub-millisecond race is not a quorum.
    const oldMembers = [...members.keys()].filter((id) => id !== target_machine_id
      && (members.get(id).join_seq ?? 0) < (target.join_seq ?? 0));
    const snapshot = oldMembers.filter((id) => members.get(id).online === true);

    if (age <= KICK_WINDOW_MS) {
      members.delete(target_machine_id);
      return { ok: true, immediate: true, removed: target_machine_id };
    }
    const removal_id = 'rmv-' + String(seq += 1).padStart(4, '0');
    const record = {
      removal_id, target_machine_id, requested_by, reason,
      snapshot: [...snapshot], recent_votes: snapshot.slice(0, 1),
      votes: new Map(), state: 'open', opened_at_ms: now(), need: neededVotes(snapshot.length),
    };
    // The requestor counts as the first yes; the operator's "a single machine may initiate" implies that much.
    if (record.recent_votes.includes(requested_by)) record.votes.set(requested_by, 'yes');
    removals.set(removal_id, record);
    return {
      ok: true, immediate: false, removal_id, need: record.need,
      snapshot: [...record.snapshot], votes: record.votes.size,
    };
  }

  /** Vote on an OPEN removal. Only the frozen snapshot may vote; the target never may. */
  function vote(removal_id, { machine_id, vote: choice }) {
    const r = removals.get(removal_id);
    if (r === undefined) return { ok: false, code: 'NOT_FOUND' };
    if (r.state !== 'open') return { ok: false, code: 'CLOSED', state: r.state };
    if (now() - r.opened_at_ms > VOTE_WINDOW_MS) { r.state = 'expired'; return { ok: false, code: 'VOTE_WINDOW_OVER' }; }
    if (machine_id === r.target_machine_id) return { ok: false, code: 'TARGET_CANNOT_VOTE' };
    if (!r.snapshot.includes(machine_id)) return { ok: false, code: 'NOT_IN_SNAPSHOT' };
    if (choice !== 'yes' && choice !== 'no') return { ok: false, code: 'BAD_VOTE' };
    r.votes.set(machine_id, choice);
    const yes = [...r.votes.values()].filter((v) => v === 'yes').length;
    const no = [...r.votes.values()].filter((v) => v === 'no').length;
    if (yes >= r.need) {
      r.state = 'carried';
      if (members.size > 1) members.delete(r.target_machine_id);
      return { ok: true, state: 'carried', yes, no, need: r.need, removed: r.target_machine_id };
    }
    // Once enough no votes exist that yes can no longer reach the bar, it is decided.
    if (no > r.snapshot.length - r.need) { r.state = 'failed'; return { ok: true, state: 'failed', yes, no, need: r.need }; }
    return { ok: true, state: 'open', yes, no, need: r.need };
  }

  function getRemoval(removal_id) {
    const r = removals.get(removal_id);
    return r === undefined ? null : { removal_id: r.removal_id, target_machine_id: r.target_machine_id, state: r.state, need: r.need, snapshot: [...r.snapshot], yes: [...r.votes.values()].filter((v) => v === 'yes').length, no: [...r.votes.values()].filter((v) => v === 'no').length, votes: r.votes.size };
  }

  /** Poll without a device token: the asking machine has none. The token is the credential, and it is not guessable from the id. */
  function poll(request_id, poll_token) {
    const r = requests.get(request_id);
    if (r === undefined || typeof poll_token !== 'string' || poll_token === '' || r.poll_token !== poll_token) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    return { ok: true, request_id, state: r.state };
  }

  function pendingFor() {
    return [...requests.values()].filter((r) => r.state === ADMISSION.PENDING).map((r) => ({ ...r }));
  }

  return { requestAdmission, decide, tick, getRequest, pendingFor, poll, remove, vote, getRemoval, isMember, memberOf, setOnline, seedFounder, _members: members };
}
