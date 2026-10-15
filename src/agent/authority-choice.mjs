/**
 * Choosing an authority level by name, so nobody has to remember what 70 means.
 *
 * ## Why this exists
 *
 * `actorAuthorityLevel` is an integer in `0..100`, and the four bands it falls into have names, prose about
 * what each may do, and *gaps*. Asking a person to type a number means asking them to hold all of that in
 * their head, and the failure mode of getting it wrong is silent: `69` and `70` look equally arbitrary and
 * land in different bands, and a machine configured one point low **refuses a dispatch it should have run**
 * with no indication that a threshold was the reason.
 *
 * This module turns the number into a choice. A caller presents {@link AUTHORITY_CHOICES} — four names with
 * the sentence each one means — and gets back the level. **The number is never asked for.**
 *
 * ## Why a name resolves to its band FLOOR
 *
 * Each band spans a range and this picks the bottom of it, deliberately. The floor is the level at which the
 * band's own description becomes true, and it is what `bandOf` answers with: a machine at the floor is *in*
 * that band and no higher. Resolving to the midpoint or the ceiling would mean a choice labelled "captain"
 * silently granted more than captain.
 *
 * **The consequence is worth stating plainly, because it decides what a machine can do:** `ordinary` resolves
 * to `0`, and `dispatch_writing` costs `50`. So a machine whose operator picks "ordinary" **cannot dispatch a
 * write at all** — it escalates, and an approver must answer. That is the intended reading of the label. It
 * is also why this is a policy decision rather than a convenience: **the name a person picks decides what the
 * machine is allowed to do.**
 *
 * ## Why a number is refused rather than accepted alongside the names
 *
 * A selector that also accepted integers would be a text field with a helpful hint, and every reason above
 * would apply again. Refusing them keeps one way in, and the refusal names the four that exist.
 */
import { AUTHORITY_BANDS, AUTHORITY_BAND_FLOORS, AUTHORITY_MAX, isAuthorityLevel } from './authority.mjs';

/** Why a choice was refused. */
export const CHOICE_REFUSAL = Object.freeze({
  UNKNOWN: 'AUTHORITY_CHOICE_UNKNOWN',
  NOT_A_STRING: 'AUTHORITY_CHOICE_NOT_A_STRING',
  NOT_CHOSEN: 'AUTHORITY_CHOICE_NOT_CHOSEN',
});

/**
 * The options to present, in ascending order, each with the sentence it stands for.
 *
 * Built from `AUTHORITY_BANDS` rather than written out, so a band added to the model appears here without
 * anybody remembering to add it — and, more importantly, **a band cannot be described in two places
 * differently**.
 */
export const AUTHORITY_CHOICES = Object.freeze(
  AUTHORITY_BANDS.map((band) => ({
    /** The value a caller stores. Never a number. */
    value: band.name,
    /** What to show a person. */
    label: band.name.replace(/_/g, ' '),
    /** The level this resolves to, and the reason it is that one. */
    level: AUTHORITY_BAND_FLOORS[band.name.toUpperCase()],
    /** What picking this permits, in the model's own words. */
    may: band.may,
    /** The range, so a caller can show it without reading the model. */
    range: band.max === null ? `${band.min}+` : `${band.min}–${band.max}`,
  })),
);

/**
 * Resolve a named choice to a level.
 *
 * @param {string|null|undefined} choice
 * @returns {{ok: boolean, level: number|null, choice: string|null, code: string|null, detail: string,
 *   options: string[]}}
 */
export function resolveAuthorityChoice(choice) {
  const options = AUTHORITY_CHOICES.map((c) => c.value);

  if (choice === null || choice === undefined || choice === '') {
    // Not the same as a wrong answer. "Nobody chose" is a state a caller has to be able to tell from "somebody
    // chose badly", because only one of them is a mistake.
    return {
      ok: false,
      level: null,
      choice: null,
      code: CHOICE_REFUSAL.NOT_CHOSEN,
      detail: `no authority level was chosen; pick one of ${options.join(', ')}`,
      options,
    };
  }

  if (typeof choice !== 'string') {
    return {
      ok: false,
      level: null,
      choice: null,
      code: CHOICE_REFUSAL.NOT_A_STRING,
      detail: `${JSON.stringify(choice)} is not a choice; pick one of ${options.join(', ')} by name`,
      options,
    };
  }

  const found = AUTHORITY_CHOICES.find((c) => c.value === choice);
  if (found === undefined) {
    return {
      ok: false,
      level: null,
      choice: null,
      code: CHOICE_REFUSAL.UNKNOWN,
      detail: `${JSON.stringify(choice)} is not one of ${options.join(', ')}; if it looks like a number, note that levels are chosen by name and not typed`,
      options,
    };
  }

  return {
    ok: true,
    level: found.level,
    choice: found.value,
    code: null,
    detail: `${found.value} resolves to level ${found.level} (${found.range}): ${found.may}`,
    options,
  };
}

/**
 * Resolve a plugin configuration value, which may be a name or already a level.
 *
 * ## Why this one DOES accept a number, when the selector does not
 *
 * These are different callers with different constraints. A person choosing is asked to choose, and the whole
 * point is that they are not asked for a number. A **profile patch** is written by hand or by an earlier
 * version of this plugin, and a config that used to hold `70` must not start refusing to load because the
 * interface changed — that would break every existing machine on upgrade, which is the failure this module's
 * own docstring warns about.
 *
 * So: a `string` is resolved as a choice, an integer is accepted as-is **only if it is a usable level**, and
 * anything else is refused with a message naming both vocabularies.
 *
 * @param {unknown} value
 * @returns {{ok: boolean, level: number|null, source: string|null, code: string|null, detail: string}}
 */
export function resolveConfiguredLevel(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    const r = resolveAuthorityChoice(value.trim());
    if (r.ok) return { ok: true, level: r.level, source: 'name', code: null, detail: r.detail };
    // A config may hold EITHER vocabulary, so a string that is not a band name is not simply unknown -- the
    // caller is told both what the names are and that an integer would also have worked. Reusing the
    // selector's message here was the first version's mistake: it told a config author about names only,
    // while the function's own contract promised numbers too.
    return {
      ok: false,
      level: null,
      source: null,
      code: r.code === CHOICE_REFUSAL.NOT_CHOSEN ? CHOICE_REFUSAL.NOT_CHOSEN : CHOICE_REFUSAL.UNKNOWN,
      detail: `${JSON.stringify(value)} is neither a choice nor a level; choose one of ${AUTHORITY_CHOICES.map((c) => c.value).join(', ')}, or a direct level as an integer 0..${AUTHORITY_MAX}`,
    };
  }
  if (isAuthorityLevel(value)) {
    return {
      ok: true,
      level: value,
      source: 'number',
      code: null,
      detail: `level ${value} was configured directly; it is in the "${(AUTHORITY_BANDS.find((b) => value >= b.min && (b.max === null || value <= b.max)) ?? {}).name ?? 'unknown'}" band`,
    };
  }
  if (value === null || value === undefined || value === '') {
    return { ok: false, level: null, source: null, code: CHOICE_REFUSAL.NOT_CHOSEN, detail: 'no authority level is configured, so the permission gate is not enforced' };
  }
  return {
    ok: false,
    level: null,
    source: null,
    code: CHOICE_REFUSAL.UNKNOWN,
    detail: `${JSON.stringify(value)} is neither a choice nor a level; choose one of ${AUTHORITY_CHOICES.map((c) => c.value).join(', ')}, or an integer 0..${AUTHORITY_MAX}`,
  };
}
