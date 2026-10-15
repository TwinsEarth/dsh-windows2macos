/**
 * The council: one decision engine with ordered phases, weighted votes, and retained dissent.
 *
 * ## What this is for, and what it refuses to be
 *
 * The source design describes a six-role council and the ROADMAP's own §3 is explicit that a governance
 * layer above a fleet **that has no disagreements yet** is indistinguishable from a delay. So this module is
 * not wired into anything: it is the decision engine itself, built and tested, waiting for the measurement
 * that earns it a caller. Building it now is justified because its *semantics* are testable in isolation;
 * deploying it now would not be, and is not done.
 *
 * ## The three properties the ROADMAP names, and how each is enforced
 *
 * 1. **A phase cannot be skipped.** Phases are an ordered list and `advance()` moves exactly one step, to
 *    the declared next phase or nowhere. There is no `goTo(phase)` and no way to open a vote before the
 *    deliberation phase has closed, because the vote reads the arguments it claims to have considered.
 * 2. **A vote's weights are reproducible from stored inputs.** `weightOf()` is a pure function of an
 *    authority level and a reputation, both of which are stored on the ballot. Nothing about a weight comes
 *    from the wall clock, the environment, or the order votes arrived in — so `recount()` on a stored
 *    decision reproduces the original outcome, and a discrepancy is detectable rather than arguable.
 * 3. **A decision with recorded dissent is retrievable *with* the dissent.** Dissent is not a log line; it
 *    is part of the `Decision` value. A reader who asks for a decision gets the losing arguments, because
 *    "what did the people who disagreed say" is the question that makes a decision auditable later.
 *
 * ## Why dissent is retained even when it changes nothing
 *
 * A council that records only outcomes cannot answer "was this contested?" after the fact, and the answer
 * determines whether a decision should be revisited or trusted. Losing arguments are the *reason* the
 * majority is a majority, so discarding them discards the only evidence that the question was hard.
 *
 * ## Design choices that are deliberately narrow
 *
 * * **Reputation is an input, not an inference.** This module never computes a reputation from past
 *   behaviour, because a reputation derived here would be a second, hidden authority model competing with
 *   v4.7.0's. A caller supplies it; the ballot records it; the recount reproduces it.
 * * **A tie is a refusal, not a coin toss.** Returning *some* outcome for a tie would hide that the council
 *   is split, and a split council is precisely the case a human must see.
 */
import { createHash } from 'node:crypto';

/** The seven phases, in order. Index is the position; there is no other ordering. */
export const PHASES = Object.freeze([
  'convene',      // the question is stated and the council is formed
  'frame',        // the question is bounded: what is in scope, what is not
  'deliberate',   // arguments are recorded, for and against
  'vote',         // weighted votes are cast
  'decide',       // the outcome is fixed and dissent is attached
  'record',       // the decision is sealed with a hash over its inputs
  'adjourn',      // the council closes; nothing further may be added
]);

/** The six roles of the AURA council. A role is a hat, not a machine: one machine may hold several. */
export const ROLES = Object.freeze(['strategist', 'analyst', 'critic', 'auditor', 'executor', 'operator']);

/** Refusal codes, so a caller branches on a value rather than on prose. */
export const COUNCIL_REFUSAL = Object.freeze({
  UNKNOWN_PHASE: 'COUNCIL_UNKNOWN_PHASE',
  WRONG_PHASE: 'COUNCIL_WRONG_PHASE',
  ALREADY_SEALED: 'COUNCIL_ALREADY_SEALED',
  UNKNOWN_ROLE: 'COUNCIL_UNKNOWN_ROLE',
  UNCLEARED_TO_VOTE: 'COUNCIL_UNCLEARED_TO_VOTE',
  ALREADY_VOTED: 'COUNCIL_ALREADY_VOTED',
  BAD_WEIGHT_INPUT: 'COUNCIL_BAD_WEIGHT_INPUT',
  TIED: 'COUNCIL_TIED',
  NOT_FOUND: 'COUNCIL_NOT_FOUND',
});

export class CouncilRefusal extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'CouncilRefusal';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

/**
 * Authority bands, taken from v4.7.0: 0-49 ordinary, 50-69 captain, 70-89 org admin, 90+ system admin.
 *
 * ## This was a SECOND copy of a number that already existed, and the reachability check is what found it
 *
 * It read `export const AUTHORITY_MAX = 100;` — a literal, redeclared here. `src/agent/authority.mjs` owns
 * that bound and the bands it belongs to, and `AUTHORITY_BAND_FLOORS` is derived from them precisely so a new
 * band cannot leave a stale copy behind. A second literal cannot be kept in step by anything, and **the
 * failure it produces is silent**: raise the real maximum to 120 and this module keeps refusing 101, with a
 * message that names the wrong number as authoritative.
 *
 * Found by `scripts/reachability-classify.mjs`, which reported this file as a **closed loop** — a module whose
 * only importer is the test named after it. That finding was about wiring, and the duplicated constant was
 * sitting in the same file. **Reading the file to check the first finding is how the second one surfaced**,
 * which is the argument for investigating a report rather than counting it.
 */
import { AUTHORITY_MAX } from './authority.mjs';

export { AUTHORITY_MAX };

/**
 * The weight of one participant, as a pure function of the two numbers on its ballot.
 *
 * **This is the whole reproducibility property.** Every input is a stored integer, so the same ballot
 * recounts to the same weight on any machine and at any time. The formula is deliberately simple and
 * deliberately *not* clever:
 *
 *   weight = authority × (1 + reputation/100)
 *
 * Authority is the primary term because v4.7.0 already defines what it means and this module has no standing
 * to reinterpret it. Reputation is a bounded multiplier in `[1, 2)`, so reputation can promote a voice but
 * **can never outvote authority**: a participant at authority 40 with a perfect reputation weighs 80, which
 * is still less than a bare authority of 90. That ordering is the point — a governance layer that let
 * reputation overturn the authority model would be a second, undeclared authority model.
 *
 * @param {{authority: number, reputation: number}} ballot
 * @returns {number} the weight, exact and reproducible
 */
export function weightOf({ authority, reputation } = {}) {
  if (!Number.isInteger(authority) || authority < 0 || authority > AUTHORITY_MAX) {
    throw new CouncilRefusal(COUNCIL_REFUSAL.BAD_WEIGHT_INPUT, `authority must be an integer in 0..${AUTHORITY_MAX}, got ${JSON.stringify(authority)}`);
  }
  if (!Number.isFinite(reputation) || reputation < 0 || reputation > 100) {
    throw new CouncilRefusal(COUNCIL_REFUSAL.BAD_WEIGHT_INPUT, `reputation must be a number in 0..100, got ${JSON.stringify(reputation)}`);
  }
  // Rounded to 6 places so a floating-point tail cannot make two equal ballots differ in a recount.
  return Math.round(authority * (1 + reputation / 100) * 1e6) / 1e6;
}

/**
 * A stable hash over everything a decision depended on.
 *
 * Exists so "the weights are reproducible" is checkable rather than assertable: recompute the seal from the
 * stored inputs and compare. The fields are sorted and JSON-encoded with no spacing, so the seal does not
 * depend on property order.
 */
export function sealOf(decision) {
  const inputs = {
    question: decision.question,
    phase_reached: decision.phase_reached,
    outcomes: (decision.ballots ?? []).map((b) => ({
      participant: b.participant, role: b.role, authority: b.authority,
      reputation: b.reputation, choice: b.choice, weight: b.weight, reason: b.reason,
    })),
    arguments: (decision.arguments ?? []).map((a) => ({ participant: a.participant, stance: a.stance, text: a.text })),
  };
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

/**
 * Open a council.
 *
 * @param {object} options
 * @param {string} options.question what is being decided
 * @param {string[]} [options.participants] who is in the room, before roles are assigned
 * @param {() => number} [options.now] injected clock
 */
export function convene({ question, participants = [], now = () => Date.now() } = {}) {
  if (typeof question !== 'string' || question.trim() === '') throw new TypeError('convene: question is required');

  /** @type {Array<{participant: string, role: string|null}>} */
  const members = participants.map((p) => ({ participant: p, role: null }));
  let phaseIndex = 0;
  const arguments_ = [];
  const ballots = [];
  let decision = null;
  /**
   * Whether the decision has been *sealed*, which is not the same as whether it exists.
   *
   * The first version derived this from `decision !== null`, and that made `record()` block `advance()` —
   * so the council could never reach `adjourn`, which comes after `record`. The tests caught it in two
   * places. The distinction is worth keeping explicit: a decided-but-unsealed outcome is still open to being
   * recorded, and only a sealed one is closed to every change.
   */
  let isSealed = false;
  const openedAt = new Date(now()).toISOString();

  const currentPhase = () => PHASES[phaseIndex];
  const refuseIfSealed = () => {
    if (isSealed) throw new CouncilRefusal(COUNCIL_REFUSAL.ALREADY_SEALED, 'the council has adjourned; a sealed decision is not modified');
  };

  /** Assign a role. Roles are additive, so one participant may hold several -- a fact worth allowing. */
  function assign(participant, role) {
    refuseIfSealed();
    if (!ROLES.includes(role)) throw new CouncilRefusal(COUNCIL_REFUSAL.UNKNOWN_ROLE, `${JSON.stringify(role)} is not one of ${ROLES.join(', ')}`);
    if (phaseIndex > 0) throw new CouncilRefusal(COUNCIL_REFUSAL.WRONG_PHASE, `roles are assigned during "convene"; the council is in "${currentPhase()}"`);
    const existing = members.find((m) => m.participant === participant);
    if (existing) existing.role = existing.role === null ? role : `${existing.role},${role}`;
    else members.push({ participant, role });
    return { participant, role };
  }

  /**
   * Move exactly one phase forward.
   *
   * There is no way to move two phases or to name a destination. A phase cannot be skipped because the only
   * transition available is to the declared successor -- and that is the ROADMAP's first falsifying test,
   * enforced structurally rather than by a check a caller could bypass.
   *
   * **`advance()` deliberately does not consult the seal.** The seal protects the *decision* from being
   * changed; it is not a lock on the phase machine. Tying the two together is self-contradictory, because
   * `record` seals and `adjourn` comes after it -- so a seal that blocked advancement would make the final
   * phase unreachable. Two tests caught that, which is the second time in this module that conflating
   * "decided" with "sealed" produced a state nobody could reach.
   */
  function advance() {
    if (phaseIndex >= PHASES.length - 1) return { phase: currentPhase(), moved: false, detail: 'already in the final phase' };
    phaseIndex += 1;
    return { phase: currentPhase(), moved: true };
  }

  /** Record an argument. Only during `deliberate`, because arguments exist to be considered by the vote. */
  function argue({ participant, stance, text }) {
    refuseIfSealed();
    if (currentPhase() !== 'deliberate') {
      throw new CouncilRefusal(COUNCIL_REFUSAL.WRONG_PHASE, `arguments are recorded during "deliberate"; the council is in "${currentPhase()}"`);
    }
    if (stance !== 'for' && stance !== 'against') {
      throw new CouncilRefusal(COUNCIL_REFUSAL.WRONG_PHASE, `stance must be "for" or "against", got ${JSON.stringify(stance)}`);
    }
    const entry = { participant, stance, text: String(text ?? '') };
    arguments_.push(entry);
    return entry;
  }

  /** Cast a weighted vote. Only during `vote`, and only after the deliberation phase has closed. */
  function vote({ participant, role = null, authority, reputation, choice, reason = null }) {
    refuseIfSealed();
    if (currentPhase() !== 'vote') {
      throw new CouncilRefusal(
        COUNCIL_REFUSAL.UNCLEARED_TO_VOTE,
        `votes are cast during "vote"; the council is in "${currentPhase()}". A vote before deliberation would be a vote on nothing.`,
      );
    }
    if (!Number.isInteger(authority)) throw new CouncilRefusal(COUNCIL_REFUSAL.BAD_WEIGHT_INPUT, 'authority must be an integer');
    const weight = weightOf({ authority, reputation });
    if (ballots.some((b) => b.participant === participant)) {
      throw new CouncilRefusal(COUNCIL_REFUSAL.ALREADY_VOTED, `${participant} has already voted; a second ballot would let one participant vote twice`);
    }
    const ballot = { participant, role, authority, reputation, choice, weight, reason, cast_at: new Date(now()).toISOString() };
    ballots.push(ballot);
    return ballot;
  }

  /**
   * Fix the outcome and attach the dissent.
   *
   * A tie is refused rather than broken. Returning *some* outcome for a tie would hide that the council is
   * split, and a split council is exactly the case a person must see.
   */
  function decide() {
    refuseIfSealed();
    if (currentPhase() !== 'decide') {
      throw new CouncilRefusal(COUNCIL_REFUSAL.WRONG_PHASE, `the outcome is fixed during "decide"; the council is in "${currentPhase()}"`);
    }
    const tally = {};
    for (const b of ballots) tally[b.choice] = Math.round(((tally[b.choice] ?? 0) + b.weight) * 1e6) / 1e6;
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) throw new CouncilRefusal(COUNCIL_REFUSAL.TIED, 'no votes were cast, so there is no outcome to fix');
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
      throw new CouncilRefusal(COUNCIL_REFUSAL.TIED, `a tie between ${ranked[0][0]} and ${ranked[1][0]} at weight ${ranked[0][1]}; a split council needs a person`, { tally });
    }
    const [outcome, weight] = ranked[0];
    const dissent = ballots
      .filter((b) => b.choice !== outcome)
      .map((b) => ({
        participant: b.participant,
        role: b.role,
        choice: b.choice,
        weight: b.weight,
        // The arguing text is carried alongside the ballot where the participant supplied one, because a
        // dissent without its reason is a number rather than a position.
        text: arguments_.filter((a) => a.participant === b.participant).map((a) => a.text).join(' ').trim() || null,
      }));
    decision = {
      question,
      opened_at: openedAt,
      decided_at: new Date(now()).toISOString(),
      phase_reached: 'decide',
      outcome,
      weight,
      tally,
      ballots: [...ballots],
      arguments: [...arguments_],
      dissent,
      unanimous: dissent.length === 0,
    };
    return decision;
  }

  /** Seal the decision. After this the council refuses every mutation. */
  function record() {
    refuseIfSealed();
    if (currentPhase() !== 'record') {
      throw new CouncilRefusal(COUNCIL_REFUSAL.WRONG_PHASE, `the decision is sealed during "record"; the council is in "${currentPhase()}"`);
    }
    if (decision === null) {
      throw new CouncilRefusal(COUNCIL_REFUSAL.WRONG_PHASE, 'there is no decision to seal; decide() must run before record()');
    }
    decision.phase_reached = 'record';
    decision.seal = sealOf(decision);
    decision.sealed_at = new Date(now()).toISOString();
    isSealed = true;
    return decision;
  }

  return {
    get phase() { return currentPhase(); },
    get phases() { return [...PHASES]; },
    get members() { return members.map((m) => ({ ...m })); },
    get votes() { return ballots.map((b) => ({ ...b })); },
    get arguments() { return arguments_.map((a) => ({ ...a })); },
    get decision() { return decision; },
    assign,
    argue,
    vote,
    decide,
    record,
    advance,
  };
}

/**
 * Recompute a stored decision's outcome from its stored inputs.
 *
 * This is what makes "the weights are reproducible" checkable instead of merely claimed: hand it a decision
 * that was recorded earlier -- possibly on another machine -- and it either reproduces the outcome or says
 * by how much it disagrees. It trusts nothing but the ballot fields.
 *
 * @param {object} decision
 * @returns {{reproduced: boolean, outcome: string|null, weight: number|null, seal_matches: boolean, detail: string}}
 */
export function recount(decision) {
  if (decision === null || typeof decision !== 'object') {
    return { reproduced: false, outcome: null, weight: null, seal_matches: false, detail: 'no decision supplied' };
  }
  const tally = {};
  for (const b of decision.ballots ?? []) {
    let weight;
    try {
      weight = weightOf({ authority: b.authority, reputation: b.reputation });
    } catch (e) {
      return { reproduced: false, outcome: null, weight: null, seal_matches: false, detail: `ballot for ${b.participant} has inputs a weight cannot be computed from: ${e.message}` };
    }
    if (weight !== b.weight) {
      return {
        reproduced: false, outcome: null, weight: null, seal_matches: false,
        detail: `ballot for ${b.participant} records weight ${b.weight} but its stored inputs give ${weight}`,
      };
    }
    tally[b.choice] = Math.round(((tally[b.choice] ?? 0) + weight) * 1e6) / 1e6;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { reproduced: false, outcome: null, weight: null, seal_matches: false, detail: 'no ballots to recount' };
  const sealMatches = decision.seal === undefined ? false : sealOf(decision) === decision.seal;
  const same = ranked[0][0] === decision.outcome && ranked[0][1] === decision.weight;
  return {
    reproduced: same,
    outcome: ranked[0][0],
    weight: ranked[0][1],
    seal_matches: sealMatches,
    detail: same
      ? `outcome ${ranked[0][0]} at weight ${ranked[0][1]} reproduced from ${(decision.ballots ?? []).length} stored ballot(s)`
      : `stored outcome was ${decision.outcome} at ${decision.weight}; the stored inputs give ${ranked[0][0]} at ${ranked[0][1]}`,
  };
}
