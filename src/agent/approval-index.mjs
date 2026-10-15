/**
 * The cross-session pending-approval index (roadmap v4.9.0).
 *
 * ## The problem
 *
 * `approval-broker.mjs` answers approvals **per session**: a request belongs to one IM window, and the
 * operator answers it there. That is right for the person who is *in* that conversation and wrong for a
 * supervisor, who by definition is not — the design's own words are that a supervisor reviews all agents'
 * pending approvals *from one queue*. Without this file, a request raised in a session nobody is watching
 * sits until its deadline delegates it, and the fact that it was waiting is recorded only inside the
 * session that could not answer it.
 *
 * ## What the index does and, more importantly, does not do
 *
 * It **presents** pending work across sessions, filtered by what the viewer has the authority to act on,
 * and it **verifies** authority at the moment of decision. It does not decide anything itself: `decide()`
 * returns a verdict and the caller settles the broker. That split exists because the broker already owns
 * settlement — the timer, the abort listener and the delegate all settle one record — and a second settler
 * would be a second owner of the same promise.
 *
 * ## Why the filter is authority-based rather than a flag
 *
 * Every actor above the ordinary band can in principle approve *something*; what differs is what. So
 * `listFor` answers "what may this actor act on" rather than "is this actor a supervisor", and the answer
 * is per request. An index that showed everything to everyone above a threshold would make the threshold
 * the whole policy, and the authority model would be decoration.
 *
 * ## The three refusals, each for a different reason
 *
 *   * **Self-approval** is refused: an actor that can approve its own request has no supervisor.
 *   * **Peer approval** is refused: two captains approving each other is a ring, not a chain, and the
 *     chain's whole purpose is that a decision can be escalated past the level that wanted it.
 *   * **A vanished request** is refused rather than ignored, because "already answered" and "never
 *     existed" look identical from a stale queue row and only one means someone should fix their view.
 */

import { AUTHORITY_VERDICT, isAuthorityLevel, mayApprove, requiredApproverLevel } from './authority.mjs';

/** Why the index refused to let an actor act. Codes, so a caller can branch without matching prose. */
export const INDEX_REFUSAL = Object.freeze({
  UNKNOWN_REQUEST: 'APPROVAL_UNKNOWN_REQUEST',
  ALREADY_SETTLED: 'APPROVAL_ALREADY_SETTLED',
  SELF_APPROVAL: 'APPROVAL_SELF_APPROVAL',
  INSUFFICIENT_AUTHORITY: 'APPROVAL_INSUFFICIENT_AUTHORITY',
  NO_SUBJECT_LEVEL: 'APPROVAL_NO_SUBJECT_LEVEL',
  BAD_ACTOR: 'APPROVAL_BAD_ACTOR',
});

/**
 * How long a settled request stays visible to a supervisor.
 *
 * A queue that empties the instant a decision is made cannot answer "did I already deal with that", which
 * is the question a supervisor returning to a busy queue actually has. Kept short deliberately: this is a
 * receipt, not a history, and the audit trail is the place for history.
 */
export const SETTLED_RETENTION_MS = 120_000;

/**
 * Create an index over one or more sessions' pending approvals.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] Injected clock, so a test can advance time without waiting.
 * @param {(event: string, detail?: object) => void} [options.audit] Called on every state change.
 * @param {number} [options.settledRetentionMs]
 */
export function createApprovalIndex(options = {}) {
  const now = options.now ?? (() => Date.now());
  const audit = options.audit ?? (() => {});
  const settledRetentionMs = options.settledRetentionMs ?? SETTLED_RETENTION_MS;

  /** approvalId -> entry. The entry is the index's own record; the broker owns settlement. */
  const entries = new Map();

  /**
   * Register a pending approval.
   *
   * Called by whatever raised it — the bridge, in practice — so that the request becomes visible outside
   * the session that owns it. The subject's authority level is recorded **here**, at raise time, because
   * it is a fact about who asked and must not be re-derived later from a caller who might be the approver.
   * An index that let the approver supply the subject's level would let the approver lower it.
   *
   * @param {{approvalId: string, sessionKey?: string|null, subject: {id?: string|null, level: number},
   *   action: string, toolName?: string|null, reason?: string|null, openedAt?: number,
   *   deadlineAt?: number|null}} entry
   * @returns {{ok: boolean, reason_code?: string, detail?: string}}
   */
  function register(entry) {
    const approvalId = entry?.approvalId;
    if (typeof approvalId !== 'string' || approvalId === '') {
      return { ok: false, reason_code: INDEX_REFUSAL.UNKNOWN_REQUEST, detail: 'register needs an approvalId' };
    }
    if (!isAuthorityLevel(entry?.subject?.level)) {
      // Refused rather than defaulted. A request whose subject has no level cannot be placed relative to
      // any approver, and guessing a level here would be inventing the one fact the decision rests on.
      return { ok: false, reason_code: INDEX_REFUSAL.NO_SUBJECT_LEVEL, detail: `subject level must be an integer 0..100, got ${JSON.stringify(entry?.subject?.level ?? null)}` };
    }
    if (typeof entry.action !== 'string' || entry.action.trim() === '') {
      return { ok: false, reason_code: INDEX_REFUSAL.UNKNOWN_REQUEST, detail: 'register needs a non-empty action' };
    }

    const at = Number.isFinite(entry.openedAt) ? entry.openedAt : now();
    const record = {
      approvalId,
      sessionKey: entry.sessionKey ?? null,
      subjectId: entry.subject.id ?? null,
      subjectLevel: entry.subject.level,
      action: entry.action,
      toolName: entry.toolName ?? null,
      reason: entry.reason ?? null,
      openedAt: at,
      deadlineAt: Number.isFinite(entry.deadlineAt) ? entry.deadlineAt : null,
      settled: null,
      settledAt: null,
    };
    entries.set(approvalId, record);
    audit('approval-index/registered', { approval_id: approvalId, session: record.sessionKey, subject_level: record.subjectLevel, action: record.action });
    return { ok: true };
  }

  /** Retention is applied on read, so no timer is needed and a paused process cannot accumulate work. */
  function reap() {
    const cutoff = now() - settledRetentionMs;
    for (const [id, record] of entries) {
      if (record.settled !== null && record.settledAt !== null && record.settledAt < cutoff) entries.delete(id);
    }
  }

  /**
   * Can this actor act on this request? A pure question: it settles nothing.
   *
   * Split from `decide` so a caller can render a queue with reasons and only then act, without every
   * render having a side effect.
   *
   * @param {object} record
   * @param {{id?: string|null, level: number}} actor
   * @returns {{allowed: boolean, reason_code: string|null, detail: string|null, required: number|null}}
   */
  function mayAct(record, actor) {
    if (!isAuthorityLevel(actor?.level)) {
      return { allowed: false, reason_code: INDEX_REFUSAL.BAD_ACTOR, detail: `actor level must be an integer 0..100, got ${JSON.stringify(actor?.level ?? null)}`, required: null };
    }
    if (record.settled !== null) {
      return { allowed: false, reason_code: INDEX_REFUSAL.ALREADY_SETTLED, detail: `already settled as "${record.settled}"`, required: null };
    }
    const peer = mayApprove(
      { id: actor.id ?? null, level: actor.level },
      { id: record.subjectId, level: record.subjectLevel },
    );
    if (peer.ok) return { allowed: true, reason_code: null, detail: null, required: peer.required };
    // `mayApprove` already distinguishes self-approval from an insufficient level, and the distinction
    // matters to a reader: one is outranking, the other is identity. Mapped rather than re-derived, so
    // the two modules cannot drift into disagreeing about which happened.
    const selfRefused = typeof peer.reason === 'string' && peer.reason.includes('may not approve its own');
    return {
      allowed: false,
      reason_code: selfRefused ? INDEX_REFUSAL.SELF_APPROVAL : INDEX_REFUSAL.INSUFFICIENT_AUTHORITY,
      detail: peer.reason,
      required: peer.required,
    };
  }

  /**
   * Record that a request was settled, by whoever settled it.
   *
   * Separate from `decide` because not every settlement is a decision: the broker's timer delegates, the
   * host cancels on abort, and a disposal settles everything. A queue that only learned about operator
   * decisions would keep showing requests that are long gone.
   */
  function settle(approvalId, outcome) {
    const record = entries.get(approvalId);
    if (record === undefined) return { ok: false, reason_code: INDEX_REFUSAL.UNKNOWN_REQUEST };
    if (record.settled !== null) return { ok: false, reason_code: INDEX_REFUSAL.ALREADY_SETTLED, detail: `already settled as "${record.settled}"` };
    record.settled = String(outcome);
    record.settledAt = now();
    audit('approval-index/settled', { approval_id: approvalId, outcome: record.settled });
    return { ok: true };
  }

  /**
   * Decide a request as this actor, if the actor may.
   *
   * Returns the verdict and marks the entry settled so the queue stops showing it. The caller is
   * responsible for actually settling the broker's promise — this function deliberately cannot, because
   * the broker owns the resolver and a second settler would race the timer.
   *
   * @param {string} approvalId
   * @param {{id?: string|null, level: number}} actor
   * @param {string} outcome
   * @returns {{ok: boolean, reason_code: string|null, detail: string|null, approvalId: string}}
   */
  function decide(approvalId, actor, outcome) {
    const record = entries.get(approvalId);
    if (record === undefined) {
      return { ok: false, reason_code: INDEX_REFUSAL.UNKNOWN_REQUEST, detail: `no pending approval ${approvalId}`, approvalId };
    }
    const check = mayAct(record, actor);
    if (!check.allowed) return { ok: false, reason_code: check.reason_code, detail: check.detail, approvalId };

    record.settled = String(outcome);
    record.settledAt = now();
    record.decidedBy = actor.id ?? null;
    audit('approval-index/decided', { approval_id: approvalId, by: actor.id ?? null, level: actor.level, outcome: record.settled });
    return { ok: true, reason_code: null, detail: null, approvalId };
  }

  /**
   * What this actor may act on, oldest first.
   *
   * Oldest first because a queue's job is to surface what has been waiting longest — the request closest to
   * its deadline is the one whose loss costs most, and a newest-first view would hide exactly that.
   *
   * Each row carries its own verdict rather than being filtered out, so a supervisor can see that work
   * exists above their authority and is not theirs to answer. A filtered list would make the fleet look
   * idle at the moment it is most blocked.
   */
  function listFor(actor, { includeSettled = false, nowMs = null } = {}) {
    reap();
    const at = Number.isFinite(nowMs) ? nowMs : now();
    const rows = [];
    for (const record of entries.values()) {
      if (!includeSettled && record.settled !== null) continue;
      const check = record.settled !== null
        ? { allowed: false, reason_code: INDEX_REFUSAL.ALREADY_SETTLED, detail: `settled as "${record.settled}"`, required: null }
        : mayAct(record, actor);
      rows.push({
        approval_id: record.approvalId,
        session: record.sessionKey,
        action: record.action,
        tool: record.toolName,
        reason: record.reason,
        subject: { id: record.subjectId, level: record.subjectLevel },
        opened_at: new Date(record.openedAt).toISOString(),
        waiting_ms: Math.max(0, at - record.openedAt),
        deadline_at: record.deadlineAt === null ? null : new Date(record.deadlineAt).toISOString(),
        overdue: record.deadlineAt !== null && record.deadlineAt <= at && record.settled === null,
        settled: record.settled,
        may_act: check.allowed,
        required_level: check.required,
        why_not: check.allowed ? null : { reason_code: check.reason_code, detail: check.detail },
      });
    }
    rows.sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at));
    return rows;
  }

  /**
   * The shape of the queue, without the rows.
   *
   * The design asks for one queue across sessions; a supervisor's first question is usually "how much is
   * waiting and where", and a count grouped by session answers it without reading every row.
   */
  function summary(actor) {
    const rows = listFor(actor);
    const bySession = new Map();
    let actionable = 0;
    let overdue = 0;
    for (const row of rows) {
      const key = row.session ?? '(no session)';
      bySession.set(key, (bySession.get(key) ?? 0) + 1);
      if (row.may_act) actionable += 1;
      if (row.overdue) overdue += 1;
    }
    return {
      pending: rows.length,
      actionable,
      overdue,
      by_session: Object.fromEntries([...bySession.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))),
      viewer: { id: actor?.id ?? null, level: actor?.level ?? null },
    };
  }

  /** Every pending approval, unfiltered. For diagnostics and for a caller that has already authorised. */
  function all({ includeSettled = false } = {}) {
    reap();
    return [...entries.values()].filter((r) => includeSettled || r.settled === null);
  }

  return {
    register,
    settle,
    decide,
    mayAct: (approvalId, actor) => {
      const record = entries.get(approvalId);
      if (record === undefined) return { allowed: false, reason_code: INDEX_REFUSAL.UNKNOWN_REQUEST, detail: `no pending approval ${approvalId}`, required: null };
      return mayAct(record, actor);
    },
    listFor,
    summary,
    all,
    get size() {
      reap();
      return [...entries.values()].filter((r) => r.settled === null).length;
    },
    /** Exposed for diagnostics only. */
    _internals: { entries },
  };
}

/** Re-exported so a caller of this module does not have to reach into `authority.mjs` for one name. */
export { AUTHORITY_VERDICT, requiredApproverLevel };
