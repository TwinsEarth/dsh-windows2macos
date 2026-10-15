/**
 * Choosing a level by name — the selector, and the two vocabularies it has to keep apart.
 *
 * What these protect, said once: **a person is asked to choose and never to type a number**, while a profile
 * patch written by an earlier version must keep loading. Those pull in opposite directions, and the tests pin
 * both ends so neither is quietly sacrificed for the other.
 *
 * The other property worth stating: **a name resolves to its band FLOOR.** A choice labelled "captain" that
 * resolved to the middle of the range would grant more than captain, and nothing would say so.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_BANDS, AUTHORITY_MAX, bandOf } from '../src/agent/authority.mjs';
import {
  AUTHORITY_CHOICES,
  CHOICE_REFUSAL,
  resolveAuthorityChoice,
  resolveConfiguredLevel,
} from '../src/agent/authority-choice.mjs';

describe('authority choice: the options come from the model, not from a second list', () => {
  it('offers exactly one choice per declared band, in ascending order', () => {
    assert.equal(AUTHORITY_CHOICES.length, AUTHORITY_BANDS.length);
    assert.deepEqual(
      AUTHORITY_CHOICES.map((c) => c.value),
      AUTHORITY_BANDS.map((b) => b.name),
    );
    const levels = AUTHORITY_CHOICES.map((c) => c.level);
    assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'the options must ascend, or a picker reads oddly');
  });

  it('carries the model sentence and the range with each option', () => {
    // A caller renders these; it should not have to reach into the model to say what a choice means.
    for (const c of AUTHORITY_CHOICES) {
      const band = AUTHORITY_BANDS.find((b) => b.name === c.value);
      assert.equal(c.may, band.may, c.value);
      assert.equal(typeof c.label, 'string');
      assert.ok(c.label.length > 0 && !c.label.includes('_'), `${c.value} label should read as words`);
      assert.match(c.range, /^\d+(–\d+|\+)$/);
    }
  });
});

describe('authority choice: a name resolves to its band floor, never above it', () => {
  it('resolves each name to the level at which its own band begins', () => {
    // The property that makes a label honest: a machine that picks "captain" is IN captain and no higher.
    for (const c of AUTHORITY_CHOICES) {
      const r = resolveAuthorityChoice(c.value);
      assert.equal(r.ok, true, c.value);
      assert.equal(r.level, c.level, c.value);
      const band = bandOf(r.level);
      assert.equal(band.name, c.value, `level ${r.level} should be in band ${c.value}`);
      assert.equal(r.level, band.min, 'and at its floor');
    }
  });

  it('keeps the practical consequence visible in the detail, not hidden in a table', () => {
    // `ordinary` resolves to 0 and `dispatch_writing` costs 50, so choosing it stops a machine writing.
    // That is intended, and a reader of the resolution should be able to see what they picked.
    const r = resolveAuthorityChoice('ordinary');
    assert.equal(r.level, 0);
    assert.match(r.detail, /resolves to level 0/);
    assert.match(r.detail, /within its own scope/);
  });

  it('does not resolve one band name to another band\'s level', () => {
    const seen = new Set();
    for (const c of AUTHORITY_CHOICES) {
      const r = resolveAuthorityChoice(c.value);
      assert.equal(seen.has(r.level), false, `two choices resolved to ${r.level}`);
      seen.add(r.level);
    }
  });
});

describe('authority choice: a number is refused, because a selector that takes one is a text field', () => {
  it('refuses an integer, and says that levels are chosen by name', () => {
    // A NUMBER is `NOT_A_STRING`; the string `'70'` is `UNKNOWN`, because a string was given and simply did
    // not match. The first version of this assertion expected `UNKNOWN` for both and was wrong about which
    // refusal a number earns -- the codes distinguish the two on purpose, so a caller can message them
    // differently.
    for (const bad of [70, 0]) {
      const r = resolveAuthorityChoice(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, CHOICE_REFUSAL.NOT_A_STRING, JSON.stringify(bad));
      assert.match(r.detail, /pick one of/);
    }
    for (const bad of ['70', '50']) {
      const r = resolveAuthorityChoice(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, CHOICE_REFUSAL.UNKNOWN, JSON.stringify(bad));
      assert.match(r.detail, /chosen by name and not typed/);
    }
  });

  it('refuses every near-miss spelling rather than guessing at it', () => {
    // Guessing here would silently pick a band, and the pick is a policy decision. `Captain` and `captain `
    // are refused by the CHOICE resolver on purpose -- trimming is the CONFIG resolver's job, below.
    for (const bad of ['Captain', 'CAPTAIN', 'captain ', 'org admin', 'org-admin', 'admin', 'root', 'systemadmin']) {
      const r = resolveAuthorityChoice(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.deepEqual(r.options, AUTHORITY_CHOICES.map((c) => c.value), 'every refusal lists what would work');
    }
  });

  it('distinguishes "nobody chose" from "somebody chose badly"', () => {
    // Only one of those is a mistake, and a caller needs to tell them apart to message them differently.
    for (const nothing of [null, undefined, '']) {
      const r = resolveAuthorityChoice(nothing);
      assert.equal(r.ok, false);
      assert.equal(r.code, CHOICE_REFUSAL.NOT_CHOSEN);
      assert.match(r.detail, /no authority level was chosen/);
    }
    const wrong = resolveAuthorityChoice('king');
    assert.equal(wrong.code, CHOICE_REFUSAL.UNKNOWN);
  });

  it('refuses a non-string non-null rather than coercing it', () => {
    for (const bad of [42, {}, [], true]) {
      const r = resolveAuthorityChoice(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, CHOICE_REFUSAL.NOT_A_STRING);
      assert.equal(r.level, null);
    }
  });
});

describe('authority choice: a profile patch written by an older version must still load', () => {
  it('accepts an integer level, which is what existing configs contain', () => {
    // The opposite of the selector's rule, on purpose: breaking every existing machine on upgrade is a worse
    // failure than accepting a number from a file nobody is looking at.
    const r = resolveConfiguredLevel(70);
    assert.equal(r.ok, true);
    assert.equal(r.level, 70);
    assert.equal(r.source, 'number');
    assert.match(r.detail, /band/);
  });

  it('accepts a name from a config too, and says which vocabulary it came from', () => {
    const r = resolveConfiguredLevel('captain');
    assert.equal(r.ok, true);
    assert.equal(r.level, 50);
    assert.equal(r.source, 'name');
  });

  it('trims a config value, because a file may carry stray whitespace', () => {
    // The CHOICE resolver refuses `'captain '`; this one trims first. Two callers, two rules, both stated.
    const r = resolveConfiguredLevel('  captain  ');
    assert.equal(r.ok, true);
    assert.equal(r.level, 50);
    assert.equal(resolveAuthorityChoice('  captain  ').ok, false, 'the selector still refuses it');
  });

  it('refuses an out-of-range or fractional integer instead of clamping it', () => {
    // Clamping would turn `101` into a system administrator and `-1` into an ordinary actor, silently.
    for (const bad of [AUTHORITY_MAX + 1, -1, 50.5, Number.NaN]) {
      const r = resolveConfiguredLevel(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.level, null);
      assert.equal(r.code, CHOICE_REFUSAL.UNKNOWN);
    }
  });

  it('reports "not configured" as its own state rather than as a bad choice', () => {
    for (const nothing of [null, undefined, '']) {
      const r = resolveConfiguredLevel(nothing);
      assert.equal(r.ok, false);
      assert.equal(r.code, CHOICE_REFUSAL.NOT_CHOSEN);
      assert.match(r.detail, /gate is not enforced/, 'the consequence of not choosing is said out loud');
    }
  });

  it('names both vocabularies when neither matches', () => {
    const r = resolveConfiguredLevel('king');
    assert.equal(r.ok, false);
    assert.match(r.detail, /neither a choice nor a level/);
    for (const c of AUTHORITY_CHOICES) assert.match(r.detail, new RegExp(c.value));
    assert.match(r.detail, new RegExp(`0\\.\\.${AUTHORITY_MAX}`));
  });
});
