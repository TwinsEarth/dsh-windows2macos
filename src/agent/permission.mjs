/**
 * The permission gate: turning a declared capability table into a decision.
 *
 * ## Why this exists, and what it is not
 *
 * `scripts/layer-model.mjs` declares what each operational capability costs in authority, and **nothing used
 * it**. A table nothing consults is not a policy; it is a description of a policy that happens to be true on
 * the day it is written. This module is the thing that consults it.
 *
 * What it is **not**: it does not know what a capability *means*. Classification — is this a write, a scope
 * change, a registration — belongs to whatever knows the action, which is `authority.mjs`'s own stated rule
 * and the reason that file declines to enumerate actions. So the two files are split by that line:
 * `layer-model.mjs` says what each capability costs, `authority.mjs` owns the bands, and this module compares
 * the two and returns a verdict.
 *
 * ## The three answers, and why there are exactly three
 *
 * `ALLOW` — the actor's level meets the capability's cost.
 * `NEEDS_APPROVAL` — the actor is **one band below**, so somebody above them may authorise it.
 * `DENY` — anything else, including a capability nobody declared.
 *
 * The `NEEDS_APPROVAL` window is deliberately **one band**, not "anything below". If any shortfall could be
 * escalated, an ordinary actor could request a system-admin action and a single inattentive approver would
 * grant it; the request itself would be the attack. One band means an actor can ask for the *next* thing up
 * and no more, which is what "escalate to your supervisor" actually means.
 *
 * ## The refusal that matters most
 *
 * **An undeclared capability is DENIED.** Answering `ALLOW` for something the table has not heard of makes the
 * table grant whatever is added next, and answering `NEEDS_APPROVAL` makes it requestable. Both are worse than
 * a refusal, because both hide the omission.
 */
import { CAPABILITIES, permissionFor, isDestructive } from '../../scripts/layer-model.mjs';
import { AUTHORITY_BANDS, AUTHORITY_MAX, AUTHORITY_VERDICT, bandOf, isAuthorityLevel } from './authority.mjs';

export { AUTHORITY_VERDICT };

/** Why a decision came out the way it did. Codes, so a caller branches on a value rather than on prose. */
export const GATE_REFUSAL = Object.freeze({
  UNKNOWN_CAPABILITY: 'GATE_UNKNOWN_CAPABILITY',
  NOT_A_LEVEL: 'GATE_NOT_A_LEVEL',
  BELOW_BAND: 'GATE_BELOW_BAND',
  SUFFICIENT: 'GATE_SUFFICIENT',
  ONE_BAND_BELOW: 'GATE_ONE_BAND_BELOW',
});

/**
 * The band index a level falls in, or `-1` when the level is unusable.
 *
 * Uses `bandOf` from `authority.mjs` rather than re-deriving the bands, so a change to the band table cannot
 * make this module disagree with the one that owns it.
 */
function bandIndex(level) {
  if (!isAuthorityLevel(level)) return -1;
  const band = bandOf(level);
  if (band === null || band === undefined) return -1;
  const index = AUTHORITY_BANDS.findIndex((b) => b.name === (band.name ?? band));
  return index;
}

/**
 * Decide whether an actor may exercise a capability.
 *
 * @param {string} capability as named in the capability table
 * @param {number} level the actor's authority level
 * @returns {{
 *   verdict: string, capability: string|null, level: number|null,
 *   required: number|null, shortfall: number|null, destructive: boolean|null,
 *   reason_code: string, detail: string
 * }}
 */
export function decide(capability, level) {
  const required = permissionFor(capability);

  if (required === null) {
    // The most important branch. A capability the table has never heard of is refused, not permitted and not
    // escalated: either answer would turn an omission into a grant.
    return {
      verdict: AUTHORITY_VERDICT.DENY,
      capability: typeof capability === 'string' ? capability : null,
      level: isAuthorityLevel(level) ? level : null,
      required: null,
      shortfall: null,
      destructive: null,
      reason_code: GATE_REFUSAL.UNKNOWN_CAPABILITY,
      detail: `no capability named ${JSON.stringify(capability)} is declared, so nothing may exercise it; an undeclared capability is refused rather than granted`,
    };
  }

  if (!isAuthorityLevel(level)) {
    // A level nobody defined cannot be compared, and treating it as 0 would silently downgrade an actor while
    // treating it as high would silently promote one. Neither is a decision this module is entitled to make.
    return {
      verdict: AUTHORITY_VERDICT.DENY,
      capability,
      level: null,
      required,
      shortfall: null,
      destructive: isDestructive(capability),
      reason_code: GATE_REFUSAL.NOT_A_LEVEL,
      detail: `${JSON.stringify(level)} is not an authority level (an integer in 0..${AUTHORITY_MAX}), so it cannot be compared against the required ${required}`,
    };
  }

  const destructive = isDestructive(capability);

  if (level >= required) {
    return {
      verdict: AUTHORITY_VERDICT.ALLOW,
      capability,
      level,
      required,
      shortfall: 0,
      destructive,
      reason_code: GATE_REFUSAL.SUFFICIENT,
      detail: `level ${level} meets the ${required} required for ${capability}${destructive ? ' (destructive)' : ''}`,
    };
  }

  const actorBand = bandIndex(level);
  const requiredBand = bandIndex(required);
  const oneBelow = actorBand >= 0 && requiredBand >= 0 && requiredBand - actorBand === 1;

  if (oneBelow) {
    return {
      verdict: AUTHORITY_VERDICT.NEEDS_APPROVAL,
      capability,
      level,
      required,
      shortfall: required - level,
      destructive,
      reason_code: GATE_REFUSAL.ONE_BAND_BELOW,
      detail: `level ${level} is one band below the ${required} required for ${capability}, so it may be escalated to an approver${destructive ? '; the action is destructive and must not be auto-approved' : ''}`,
    };
  }

  return {
    verdict: AUTHORITY_VERDICT.DENY,
    capability,
    level,
    required,
    shortfall: required - level,
    destructive,
    reason_code: GATE_REFUSAL.BELOW_BAND,
    detail: `level ${level} is ${required - level} below the ${required} required for ${capability}, which is more than one band; the request itself is refused rather than escalated`,
  };
}

/**
 * Whether a decision may be settled automatically.
 *
 * Only `ALLOW` and only for a non-destructive capability. A destructive action that reaches an approver's
 * queue is a decision for a person even when the approver's level is far above the requirement — the level
 * answers "may this actor", not "should this happen now".
 *
 * @returns {{auto: boolean, detail: string}}
 */
export function mayAutoSettle(decision) {
  if (decision === null || typeof decision !== 'object') return { auto: false, detail: 'no decision supplied' };
  if (decision.verdict !== AUTHORITY_VERDICT.ALLOW) {
    return { auto: false, detail: `verdict is ${decision.verdict}, which is not an allow` };
  }
  if (decision.destructive === true) {
    return { auto: false, detail: `${decision.capability} is destructive, so a person settles it however high the level` };
  }
  return { auto: true, detail: `${decision.capability} is allowed and not destructive` };
}

/**
 * Check that every declared capability is reachable by somebody.
 *
 * **An unreachable capability is a defect in the table, not a safety feature.** If its minimum authority
 * exceeds `AUTHORITY_MAX`, no actor can ever exercise it and the entry is dead — which reads as policy while
 * doing nothing. Called at test time rather than at load time, because a table with a mistake in it should
 * fail its own tests rather than make a machine refuse to start.
 *
 * @returns {{ok: boolean, unreachable: string[], detail: string}}
 */
export function auditCapabilities() {
  const unreachable = [];
  for (const c of CAPABILITIES) {
    if (!Number.isInteger(c.min_authority) || c.min_authority < 0 || c.min_authority > AUTHORITY_MAX) {
      unreachable.push(`${c.name} (min_authority ${c.min_authority} is outside 0..${AUTHORITY_MAX})`);
      continue;
    }
    // Reachability by a real actor, not merely by the number: a level in a declared band must exist at or
    // above the requirement.
    const reachable = AUTHORITY_BANDS.some((b) => b.min >= c.min_authority || (b.max ?? AUTHORITY_MAX) >= c.min_authority);
    if (!reachable) unreachable.push(`${c.name} (no band reaches ${c.min_authority})`);
  }
  return {
    ok: unreachable.length === 0,
    unreachable,
    detail: unreachable.length === 0
      ? `all ${CAPABILITIES.length} declared capability(ies) are reachable by some band`
      : `${unreachable.length} declared capability(ies) no actor can exercise: ${unreachable.join('; ')}`,
  };
}
