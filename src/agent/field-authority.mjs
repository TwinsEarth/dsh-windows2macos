/**
 * Field-level acceptance driven by the authority model — MMP P1/P2's missing half.
 *
 * ## What was missing, and how it was found
 *
 * `ROADMAP.md` describes v4.8.0 as *"a CAT7 seven-field cognitive block, **per-field acceptance driven by §2's
 * authority model**, and lineage"*, and marks it **shipped in 0.9.9**. Reading the tree to check that claim:
 * the block, the lineage, the absent-not-null refusal and the missing-parent refusal are all real and all
 * asserted. But **`blocks.mjs` does not import `authority.mjs` at all**, and `defaultChoose` — the only
 * chooser that ships — refuses `confidence` by name and accepts everything else.
 *
 * So "driven by the authority model" was a description of an intention, and the one field rule that existed
 * was hard-coded. This module is the connection that was claimed and not built.
 *
 * ## The rule that makes it safe
 *
 * **A field with no declared rule is REFUSED.** Not accepted, and not escalated. This is the same decision
 * `authority.mjs` already states for exemptions — *"the tempting default is 'absent means unconstrained', and
 * it is wrong in the one direction that matters"* — and `permission.mjs` states for capabilities: an omission
 * must never become a grant. Three modules, one rule, because the failure mode is identical in all three: a
 * table that grants what it has not heard of grants whatever is added next.
 *
 * ## Ordering, which is the part that is easy to get silently wrong
 *
 * Three refusals can apply to one field, and they are checked in this order:
 *
 *   1. **not a CAT7 field** — refused before any rule is consulted, because a rule cannot make a field exist;
 *   2. **no declared rule** — refused, because an undeclared field is one nobody decided about;
 *   3. **the authority verdict** — `allow` accepts, anything else refuses with the model's own reason.
 *
 * Step 3 never *grants* on a non-allow verdict. A `needs_approval` on a field is a refusal here rather than a
 * queue: an accepted block is a stored fact, and storing a field as though a supervisor had approved it when
 * nobody has is worse than omitting it.
 */
import { CAT7_FIELDS } from './blocks.mjs';
import { AUTHORITY_VERDICT, evaluate } from './authority.mjs';

/** Why a field was not accepted, as codes rather than prose. */
export const FIELD_REFUSAL = Object.freeze({
  NOT_A_FIELD: 'FIELD_NOT_A_FIELD',
  UNDECLARED: 'FIELD_UNDECLARED',
  BELOW_AUTHORITY: 'FIELD_BELOW_AUTHORITY',
  MALFORMED_RULE: 'FIELD_MALFORMED_RULE',
  ALWAYS_REFUSED: 'FIELD_ALWAYS_REFUSED',
});

/**
 * What each field costs to accept.
 *
 * Only the four **receiver-choosable** fields can be governed this way, because `acceptBlock` copies the
 * three inherited ones (`origin`, `observed_at`, `lineage`) without consulting a chooser at all — a receiver
 * that could set them could assert a provenance it does not have. The two choosable fields that do not appear
 * here are governed on purpose and the code says which reason applies to each.
 *
 * The levels follow `AUTHORITY_BANDS`: `ordinary` may say what was observed and what it means; `captain` may
 * assert what supports it. A field is a claim about how far the assertion reaches, so its cost is its reach.
 */
export const FIELD_LEVELS = Object.freeze({
  subject: 0,
  body: 0,
  evidence: 50,
});

/**
 * Fields a receiver is refused whatever its authority, and why.
 *
 * `confidence` is **not** in {@link FIELD_LEVELS} at any level. A level can be raised, and if this field were
 * merely expensive then a system administrator would be *permitted by this model* to adopt the sender's own
 * certainty about the sender's own assertion — the one transfer of belief `blocks.mjs` calls a hard invariant
 * rather than a default. This table is what makes that invariant reachable from here, so the refusal is
 * reported with the same words `acceptBlock` uses instead of a second, drifting explanation.
 */
export const NEVER_ACCEPTED = Object.freeze({
  confidence: 'a receiver does not adopt the sender\'s certainty (invariant, not a default)',
});

/**
 * The authority rule for one field, or `null` when the field has no declared rule.
 *
 * Returned in the shape `authority.evaluate` accepts, so the two models cannot drift into different notions
 * of what a rule is.
 *
 * @param {string} field
 * @returns {{action: string, minLevel: number, matchingExemptLevel: null}|null}
 */
export function ruleForField(field) {
  if (!Object.prototype.hasOwnProperty.call(FIELD_LEVELS, field)) return null;
  return { action: `accept_field:${field}`, minLevel: FIELD_LEVELS[field], matchingExemptLevel: null };
}

/**
 * Decide whether an actor may accept one field into a stored block.
 *
 * @param {string} field
 * @param {{level: number, inScope?: boolean|null, id?: string|null}} actor
 * @returns {{accepted: boolean, field: string|null, code: string, verdict: string|null,
 *   required: number|null, reason: string}}
 */
export function acceptField(field, actor) {
  if (typeof field !== 'string' || !CAT7_FIELDS.includes(field)) {
    // Before any rule: a rule cannot make a field exist, so consulting one here would let a typo in a rule
    // table conjure a field that `verifyBlock` would then reject at the other end of the wire.
    return {
      accepted: false,
      field: typeof field === 'string' ? field : null,
      code: FIELD_REFUSAL.NOT_A_FIELD,
      verdict: null,
      required: null,
      reason: `${JSON.stringify(field)} is not one of the seven CAT7 fields`,
    };
  }

  if (Object.prototype.hasOwnProperty.call(NEVER_ACCEPTED, field)) {
    // Checked before the table, so raising a level cannot reach it. The message says it is an invariant, not a
    // threshold, because a reader who thinks it is a threshold will try to raise it.
    return {
      accepted: false,
      field,
      code: FIELD_REFUSAL.ALWAYS_REFUSED,
      verdict: AUTHORITY_VERDICT.DENY,
      required: null,
      reason: NEVER_ACCEPTED[field],
    };
  }

  const rule = ruleForField(field);
  if (rule === null) {
    // The load-bearing refusal. Accepting an undeclared field would make this table grant whatever is added
    // next; escalating it would make it requestable. Both turn an omission into a permission.
    return {
      accepted: false,
      field,
      code: FIELD_REFUSAL.UNDECLARED,
      verdict: null,
      required: null,
      reason: `no authority rule declares what ${field} costs, so nothing may accept it; a field the table has not heard of is refused rather than granted`,
    };
  }

  const decision = evaluate(rule, actor);
  if (decision.verdict === AUTHORITY_VERDICT.ALLOW) {
    return {
      accepted: true,
      field,
      code: AUTHORITY_VERDICT.ALLOW,
      verdict: decision.verdict,
      required: rule.minLevel,
      reason: decision.reason,
    };
  }
  return {
    accepted: false,
    field,
    code: decision.reason.startsWith('malformed rule:') ? FIELD_REFUSAL.MALFORMED_RULE : FIELD_REFUSAL.BELOW_AUTHORITY,
    verdict: decision.verdict,
    required: rule.minLevel,
    reason: decision.reason,
  };
}

/**
 * A `choose` function for `acceptBlock`, built from the authority model.
 *
 * Shaped to drop straight into `acceptBlock(block, { choose })`, which is the only reason it exists as a
 * separate function rather than being inlined: the block layer must not need to know about authority, and the
 * authority layer must not need to know about blocks.
 *
 * @param {{level: number, inScope?: boolean|null, id?: string|null}} actor
 * @param {{onDecision?: (result: object) => void}} [options] `onDecision` sees every field's ruling, so a
 *   caller can record refusals without re-deriving them.
 * @returns {(field: string, value: unknown, block: object) => {accept: boolean, why: string}}
 */
export function authorityChooser(actor, options = {}) {
  const onDecision = typeof options.onDecision === 'function' ? options.onDecision : null;
  return (field) => {
    const result = acceptField(field, actor);
    if (onDecision !== null) onDecision(result);
    return { accept: result.accepted, why: result.reason };
  };
}

/**
 * Accept a whole block with the authority chooser, and report both halves.
 *
 * @param {object} block
 * @param {{level: number, inScope?: boolean|null, id?: string|null}} actor
 * @param {{lineage?: string[]|null, accept?: Function}} [options] `accept` is `acceptBlock`, injected so this
 *   module does not import it in a cycle.
 * @returns {{accepted: object|null, refused: Array<object>, decisions: Array<object>}}
 */
export function acceptWithAuthority(block, actor, options = {}) {
  const accept = options.accept;
  if (typeof accept !== 'function') {
    return { accepted: null, refused: [{ field: null, why: 'no acceptBlock implementation was supplied' }], decisions: [] };
  }
  const decisions = [];
  const result = accept(block, {
    choose: authorityChooser(actor, { onDecision: (d) => decisions.push(d) }),
    ...(Object.prototype.hasOwnProperty.call(options, 'lineage') ? { lineage: options.lineage } : {}),
  });
  return { accepted: result.accepted, refused: result.refused, decisions };
}
