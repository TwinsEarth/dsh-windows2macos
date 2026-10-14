/**
 * Numeric authority: who may do what, expressed as an integer.
 *
 * ## Why an integer rather than a list of names
 *
 * The roadmap has authority appearing in four of its five layers -- the permission model, the approval
 * flow, committee voting weights, and the defence hierarchy where a Coordinator outranks an Analyst. An
 * enumerated set of role names would have to be re-partitioned by each of those layers, and each
 * re-partition would be a place for two of them to disagree. An integer orders every actor on one axis,
 * so "does A outrank B" is a comparison rather than a lookup table that has to be kept in step.
 *
 * The model is Unix-like on purpose: `matching_exempt_level` mirrors root's exemption from file
 * permission checks. That is a *deliberate* hole in the rules, so it is the most carefully bounded thing
 * in this file -- see `evaluate`.
 *
 * ## The four bands
 *
 * | Band | Range | May |
 * |---|---|---|
 * | ordinary | 0–49 | create goals and session data within its own scope |
 * | captain | 50–69 | create team goals, manage team membership |
 * | org admin | 70–89 | create organisation goals, register actors, set overrides |
 * | system admin | 90+ | create global goals, configure across organisations, override any lower constraint |
 *
 * ## What this module deliberately does not do
 *
 * It does not decide *what* an action is, only whether an actor's level satisfies a stated rule. Action
 * classification -- is this a write, a scope change, a registration -- belongs to whatever knows the
 * action, and putting it here would mean this file had to be edited every time a new action appeared.
 * That is how an authority model becomes a bottleneck and then gets bypassed.
 */

/** The bands, as data rather than as branches, so a reader can enumerate them. */
export const AUTHORITY_BANDS = Object.freeze([
  { name: 'ordinary', min: 0, max: 49, may: 'create goals and session data within its own scope' },
  { name: 'captain', min: 50, max: 69, may: 'create team goals, manage team membership' },
  { name: 'org_admin', min: 70, max: 89, may: 'create organisation goals, register actors, set overrides' },
  { name: 'system_admin', min: 90, max: null, may: 'create global goals, configure across organisations, override any lower constraint' },
]);

/** The highest level this model will accept. Above it, a level is a mistake rather than a promotion. */
export const AUTHORITY_MAX = 100;

/** Verdicts an authority check can reach. */
export const AUTHORITY_VERDICT = Object.freeze({
  ALLOW: 'allow',
  NEEDS_APPROVAL: 'needs_approval',
  DENY: 'deny',
});

/**
 * Is this a usable authority level?
 *
 * Rejects non-integers as well as out-of-range values. `50.5` is not "between captain and org admin"; it
 * is a value nobody defined, and accepting it would make band boundaries behave differently for actors
 * that are supposed to be equal.
 *
 * @param {unknown} level
 * @returns {boolean}
 */
export function isAuthorityLevel(level) {
  return Number.isInteger(level) && level >= 0 && level <= AUTHORITY_MAX;
}

/**
 * Which band a level falls in, or `null` for a value that is not a level.
 *
 * @param {unknown} level
 * @returns {{name: string, min: number, max: number|null, may: string}|null}
 */
export function bandOf(level) {
  if (!isAuthorityLevel(level)) return null;
  for (const band of AUTHORITY_BANDS) {
    if (level >= band.min && (band.max === null || level <= band.max)) return band;
  }
  return null;
}

/**
 * A rule about an action.
 *
 * `minLevel` is the floor for performing it at all. `matchingExemptLevel`, when present, is the level at
 * or above which the *membership* part of the rule is skipped -- the Unix-root analogy. `scope` names what
 * the action is performed against, so a refusal can say which rule refused it.
 *
 * @typedef {object} AuthorityRule
 * @property {string} action
 * @property {number} minLevel
 * @property {number|null} [matchingExemptLevel]
 * @property {string|null} [scope]
 * @property {string} [why]
 */

/**
 * Cheap structural validation, separate from evaluation.
 *
 * A malformed rule is a configuration defect and should be caught where it is written, not silently
 * treated as a rule that permits nothing -- "denied" and "misconfigured" look identical from the outside
 * and only one of them means someone should fix something.
 *
 * @param {unknown} rule
 * @returns {string|null} a reason, or `null` when the rule is well formed.
 */
export function ruleProblem(rule) {
  if (rule === null || typeof rule !== 'object') return 'rule must be an object';
  if (typeof rule.action !== 'string' || rule.action.trim() === '') return 'rule.action must be a non-empty string';
  if (!isAuthorityLevel(rule.minLevel)) return `rule.minLevel must be an integer 0..${AUTHORITY_MAX}`;
  if (rule.matchingExemptLevel !== undefined && rule.matchingExemptLevel !== null
    && !isAuthorityLevel(rule.matchingExemptLevel)) {
    return `rule.matchingExemptLevel must be an integer 0..${AUTHORITY_MAX} or null`;
  }
  return null;
}

/**
 * Evaluate one rule against one actor.
 *
 * The order of the three checks is the whole security property, so it is stated rather than implied:
 *
 *   1. **Exemption**, and only when the rule names one. An exempt actor skips the *membership* check --
 *      not the level check, and not the existence of the rule. This is the Unix-root analogy: root
 *      bypasses a file's permission bits, not the fact that the file must exist.
 *   2. **Membership**, when the rule has a scope and the caller supplied one. An actor outside the scope
 *      needs a supervisor, not a refusal, which is why this yields `needs_approval` rather than `deny`.
 *   3. **Level**, the plain floor.
 *
 * A rule with no `matchingExemptLevel` exempts **nobody**. That is the decision most worth stating: the
 * tempting default is "absent means unconstrained", and it is wrong in the one direction that matters --
 * a rule author who forgets the field would silently create an unrestricted action.
 *
 * @param {AuthorityRule} rule
 * @param {{level: number, inScope?: boolean|null, id?: string|null}} actor
 * @returns {{verdict: string, action: string|null, level: number|null, exempt: boolean, reason: string}}
 */
export function evaluate(rule, actor) {
  const problem = ruleProblem(rule);
  if (problem !== null) {
    return {
      verdict: AUTHORITY_VERDICT.DENY,
      action: rule?.action ?? null,
      level: actor?.level ?? null,
      exempt: false,
      reason: `malformed rule: ${problem}`,
    };
  }
  if (!isAuthorityLevel(actor?.level)) {
    return {
      verdict: AUTHORITY_VERDICT.DENY,
      action: rule.action,
      level: actor?.level ?? null,
      exempt: false,
      reason: `actor has no usable authority level (got ${JSON.stringify(actor?.level ?? null)})`,
    };
  }

  const exemptLevel = rule.matchingExemptLevel ?? null;
  const exempt = exemptLevel !== null && actor.level >= exemptLevel;

  // 2. Membership, skipped entirely for an exempt actor.
  if (!exempt && rule.scope !== undefined && rule.scope !== null && actor.inScope === false) {
    return {
      verdict: AUTHORITY_VERDICT.NEEDS_APPROVAL,
      action: rule.action,
      level: actor.level,
      exempt: false,
      reason: `outside the scope of "${rule.action}" (${rule.scope}); a supervisor within it may approve`,
    };
  }

  // 3. The floor. Checked even for an exempt actor -- see the header.
  if (actor.level < rule.minLevel) {
    return {
      verdict: AUTHORITY_VERDICT.NEEDS_APPROVAL,
      action: rule.action,
      level: actor.level,
      exempt,
      reason: `level ${actor.level} is below the minimum ${rule.minLevel} for "${rule.action}"`,
    };
  }

  return {
    verdict: AUTHORITY_VERDICT.ALLOW,
    action: rule.action,
    level: actor.level,
    exempt,
    reason: exempt
      ? `allowed: level ${actor.level} meets the exemption ${exemptLevel} for "${rule.action}"`
      : `allowed: level ${actor.level} meets the minimum ${rule.minLevel} for "${rule.action}"`,
  };
}

/**
 * Evaluate several rules, stopping at the first one that is not a plain allow.
 *
 * ## Why it stops, rather than evaluating everything
 *
 * An earlier draft evaluated all rules and returned the strictest verdict. It is the more obvious design
 * and the less useful one, for two reasons that both matter to the person reading the answer:
 *
 *   * **`decisive` must be unique.** With every rule evaluated, a list can hold several non-allow
 *     decisions and the caller has to pick one -- and whichever it picks, the *stated* reason for a
 *     refusal stops being the reason. An operator asking "why was this not allowed" needs one rule.
 *   * **The unevaluated rules may not even apply.** A rule is evaluated against an actor, and an actor's
 *     scope can be learned from the outcome of an earlier rule; continuing past a gate would evaluate
 *     later rules against a context the gate had already made moot.
 *
 * Stopping at the *first* non-allow -- not merely at the first deny -- follows from the same argument. A
 * gate is a gate whether it says `deny` or `needs_approval`, and in both cases the caller's next action
 * is determined and the rest of the list is decoration.
 *
 * @param {AuthorityRule[]} rules
 * @param {{level: number, inScope?: boolean|null, id?: string|null}} actor
 * @returns {{verdict: string, decisions: object[], decisive: object|null}}
 */
export function evaluateAll(rules, actor) {
  const decisions = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const decision = evaluate(rule, actor);
    decisions.push(decision);
    if (decision.verdict !== AUTHORITY_VERDICT.ALLOW) {
      return { verdict: decision.verdict, decisions, decisive: decision };
    }
  }
  return { verdict: AUTHORITY_VERDICT.ALLOW, decisions, decisive: null };
}

/**
 * The level required to sign off on a refusal.
 *
 * One band up, floored at the captain band, because the document's approval flow is a chain --
 * captain, then org admin, then system admin -- and a chain that can be satisfied by the actor's own peer
 * group is not a chain. An actor already at the top band has no higher approver, so the top band signs
 * for itself; saying otherwise would make a system-admin action unapprovable.
 *
 * @param {number} level
 * @returns {number|null}
 */
export function requiredApproverLevel(level) {
  const band = bandOf(level);
  if (band === null) return null;
  if (band.name === 'system_admin') return 90;
  const higher = AUTHORITY_BANDS[AUTHORITY_BANDS.indexOf(band) + 1];
  return higher === undefined ? null : higher.min;
}

/**
 * Is `approver` allowed to sign off on `subject`'s pending action?
 *
 * Strictly higher, not equal-or-higher. Two captains approving each other is a peer ring, and the whole
 * point of the chain is that a decision can be escalated past the level that wanted it. Self-approval is
 * refused for the same reason, stated separately because it is the case an implementation is most likely
 * to let through by comparing only levels.
 *
 * @param {{level: number, id?: string|null}} approver
 * @param {{level: number, id?: string|null}} subject
 * @returns {{ok: boolean, reason: string, required: number|null}}
 */
export function mayApprove(approver, subject) {
  const required = requiredApproverLevel(subject?.level);
  if (required === null) {
    return { ok: false, required: null, reason: `subject has no usable authority level (got ${JSON.stringify(subject?.level ?? null)})` };
  }
  if (!isAuthorityLevel(approver?.level)) {
    return { ok: false, required, reason: `approver has no usable authority level (got ${JSON.stringify(approver?.level ?? null)})` };
  }
  if (approver.id !== undefined && approver.id !== null && approver.id === subject?.id) {
    return { ok: false, required, reason: 'an actor may not approve its own request' };
  }
  if (approver.level < required) {
    return { ok: false, required, reason: `approver level ${approver.level} is below the required ${required}` };
  }
  return { ok: true, required, reason: `approver level ${approver.level} meets the required ${required}` };
}

/**
 * Compose a child actor's authority from its parent's.
 *
 * **This never increases it.** No rule in the source design grants delegation, and the default an
 * implementation reaches for -- "a captain's delegate is a captain" -- turns any single compromised
 * actor into an escalation path. Where the source is silent, the safe reading is the narrow one, and the
 * `reason` says which of the two rules applied so a later reader can tell a deliberate cap from a bug.
 *
 * @param {{level: number, id?: string|null}} parent
 * @param {{level?: number, cap?: number|null, id?: string|null}} child
 * @returns {{level: number|null, capped: boolean, reason: string}}
 */
export function deriveAuthority(parent, child = {}) {
  if (!isAuthorityLevel(parent?.level)) {
    return { level: null, capped: false, reason: `parent has no usable authority level (got ${JSON.stringify(parent?.level ?? null)})` };
  }
  if (child.level !== undefined && !isAuthorityLevel(child.level)) {
    return { level: null, capped: false, reason: `child level is not usable (got ${JSON.stringify(child.level)})` };
  }
  const asked = child.level ?? parent.level;
  const cap = isAuthorityLevel(child.cap) ? child.cap : parent.level;
  const ceiling = Math.min(parent.level, cap);
  const level = Math.min(asked, ceiling);
  return {
    level,
    capped: level < asked,
    reason: level < asked
      ? `reduced from ${asked} to ${level}: a derived actor never exceeds its parent (${parent.level}) or its cap (${cap})`
      : `granted ${level}: within parent (${parent.level}) and cap (${cap})`,
  };
}
