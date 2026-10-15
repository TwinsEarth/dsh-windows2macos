/**
 * Live councils, and the decisions they finish — the part that must outlive a single tool call.
 *
 * ## Why this exists as a separate module
 *
 * A council runs through **seven phases across many calls**: someone convenes it, people assign roles, argue,
 * vote, and only then is an outcome fixed and sealed. A `convene()` that lived and died inside one tool
 * invocation would be a state machine nobody could ever finish, and the failure would look like "the phases
 * are wrong" rather than "the state was thrown away".
 *
 * This is the same lesson `tools.mjs` learned about the approval queue and the P2P runtime: **something that
 * must outlive a single call belongs to something other than the call.**
 *
 * ## Why decided councils are kept when live ones are dropped
 *
 * The two are different kinds of thing:
 *
 *   * a **live** council is scratch space. Losing one costs the work of getting back to that phase, and that
 *     is a real cost, so the cap is generous;
 *   * a **decided** council is the artifact. `ROADMAP.md`'s third falsifying test for v4.10.0 is that *"a
 *     decision with recorded dissent is retrievable with the dissent"* — and **retrievable means after the
 *     council that produced it is gone.** So a sealed decision is what gets evicted last.
 *
 * ## What the caps are for
 *
 * Neither map is bounded by anything but a number here, and a long-running process that convenes councils
 * fills memory. The caps are **stated and tested** rather than discovered, and eviction is **oldest-first** so
 * the behaviour is predictable: a reader can say which council survives without reading the implementation.
 */
import { PHASES, ROLES, convene, recount } from './council.mjs';

/** How many unfinished councils are held. Generous, because losing one costs redoing the phases. */
export const MAX_LIVE_COUNCILS = 64;

/** How many decided councils are held. Larger, because these are the artifact rather than the workspace. */
export const MAX_DECIDED_COUNCILS = 256;

/** Why a session operation was refused. */
export const SESSION_REFUSAL = Object.freeze({
  NO_ID: 'COUNCIL_SESSION_NO_ID',
  NOT_FOUND: 'COUNCIL_SESSION_NOT_FOUND',
  NOT_DECIDED: 'COUNCIL_SESSION_NOT_DECIDED',
  ALREADY_EXISTS: 'COUNCIL_SESSION_ALREADY_EXISTS',
});

/**
 * @param {{maxLive?: number, maxDecided?: number}} [options]
 */
export function createCouncilSessions(options = {}) {
  const maxLive = Number.isInteger(options.maxLive) ? options.maxLive : MAX_LIVE_COUNCILS;
  const maxDecided = Number.isInteger(options.maxDecided) ? options.maxDecided : MAX_DECIDED_COUNCILS;

  /** Insertion-ordered, so "oldest" is the first key — eviction needs no timestamps to be predictable. */
  const live = new Map();
  const decided = new Map();

  const requireId = (id) => typeof id === 'string' && id.trim() !== '';

  /**
   * Open a council under an id.
   *
   * The id is **required from the caller** rather than generated here, for the reason `raiseApproval` gives:
   * an id invented at this layer could not be correlated with whoever is waiting to use it.
   */
  function open(id, { question, participants = [], now } = {}) {
    if (!requireId(id)) {
      return { ok: false, reason_code: SESSION_REFUSAL.NO_ID, detail: 'opening a council needs an id the caller chose, so it can be addressed later' };
    }
    if (live.has(id) || decided.has(id)) {
      // Refused rather than replaced: silently discarding a council mid-phase would look like the phases had
      // reset, which is the most misleading possible symptom.
      return { ok: false, reason_code: SESSION_REFUSAL.ALREADY_EXISTS, detail: `a council is already open under ${JSON.stringify(id)}; choose another id or adjourn it first` };
    }
    const council = convene({ question, participants, ...(typeof now === 'function' ? { now } : {}) });
    live.set(id, council);
    while (live.size > maxLive) live.delete(live.keys().next().value);
    return { ok: true, id, phase: council.phase, phases: council.phases, roles: [...ROLES], detail: `opened at "${council.phase}"` };
  }

  /** The live council under an id, or a refusal naming what is missing. */
  function get(id) {
    if (!requireId(id)) return { ok: false, reason_code: SESSION_REFUSAL.NO_ID, detail: 'a council id is required' };
    const council = live.get(id) ?? null;
    if (council === null) {
      const wasDecided = decided.has(id);
      return {
        ok: false,
        reason_code: wasDecided ? SESSION_REFUSAL.NOT_DECIDED : SESSION_REFUSAL.NOT_FOUND,
        detail: wasDecided
          ? `${JSON.stringify(id)} has already been decided and sealed, so it cannot be advanced; read it with action="decision"`
          : `no live council under ${JSON.stringify(id)}`,
      };
    }
    return { ok: true, id, council };
  }

  /**
   * Seal a council and move it from live to decided.
   *
   * Called after `record()`. The council object stays the same; only which map holds it changes, and that is
   * the whole point — **a decided council must remain readable after it stops being advanceable.**
   */
  function seal(id) {
    const found = get(id);
    if (!found.ok) return found;
    const decision = found.council.decision;
    if (decision === null || decision === undefined) {
      return { ok: false, reason_code: SESSION_REFUSAL.NOT_DECIDED, detail: 'the council has no decision to seal; decide() must run first' };
    }
    live.delete(id);
    decided.set(id, { decision, sealed_at: new Date().toISOString() });
    while (decided.size > maxDecided) decided.delete(decided.keys().next().value);
    return { ok: true, id, decision };
  }

  /** A decided council, with its dissent, and whether its outcome reproduces from its own stored ballots. */
  function decision(id) {
    if (!requireId(id)) return { ok: false, reason_code: SESSION_REFUSAL.NO_ID, detail: 'a council id is required' };
    const held = decided.get(id);
    if (held === undefined) {
      return {
        ok: false,
        reason_code: live.has(id) ? SESSION_REFUSAL.NOT_DECIDED : SESSION_REFUSAL.NOT_FOUND,
        detail: live.has(id) ? `${JSON.stringify(id)} is still open, so nothing is decided yet` : `no decided council under ${JSON.stringify(id)}`,
      };
    }
    // `recount` is what makes "weights are reproducible" checkable rather than asserted: it recomputes from
    // the stored ballots and reports agreement. Returning it WITH the decision means a reader never has to
    // take the seal on trust.
    return { ok: true, id, ...held, recount: recount(held.decision) };
  }

  /** Ids held, oldest first, for a caller that wants to know what is here without listing contents. */
  function ids() {
    return { live: [...live.keys()], decided: [...decided.keys()] };
  }

  return { open, get, seal, decision, ids, maxLive, maxDecided, phaseNames: [...PHASES] };
}
