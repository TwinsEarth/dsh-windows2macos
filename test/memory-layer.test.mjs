/**
 * The shared-memory layer, measured rather than assumed (v0.53.0).
 *
 * ## Why this suite exists
 *
 * Everything below **was already verified by hand, through real dispatches to a real machine** — field-level
 * omission at level 0, the refusal of an unproducible ancestor, the level 0/70 difference. That was evidence,
 * and it was not **repeatable**: it lived in a session, not in the suite. **A measurement that cannot be
 * re-run is a memory of a measurement.**
 *
 * ## What is asserted here that the earlier hand-run got wrong
 *
 * * **`evidence` costs 50, not 70.** The level-70 dispatch succeeded, which is true and was read as the
 *   threshold. It is not: `FIELD_LEVELS.evidence === 50`, and 49 is refused while 50 is allowed.
 * * **`confidence` is not a high-cost field.** It is `NEVER_ACCEPTED` — an **invariant, not a threshold** —
 *   so level 90 is refused exactly as level 0 is. The distinction is load-bearing: **a reader who thinks it is
 *   a threshold will try to raise it.**
 * * **`FIELD_UNDECLARED` does not mean "forbidden".** `origin`, `observed_at` and `lineage` have no rule for a
 *   receiver, and `acceptWithAuthority` still returns them in `accepted` — because they are **inherited**, not
 *   chosen. Reading `UNDECLARED` as a refusal would have the receiver drop the ancestry that makes the block
 *   meaningful.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAT7_FIELDS, BLOCK_REFUSAL, INHERITED_FIELDS, RECEIVER_CHOOSABLE_FIELDS, makeBlock, verifyBlock, acceptBlock, blockHash, ancestry, isDescendantOf, blockProblem } from '../src/agent/blocks.mjs';
import { FIELD_LEVELS, FIELD_REFUSAL, NEVER_ACCEPTED, acceptField, acceptWithAuthority, authorityChooser, ruleForField } from '../src/agent/field-authority.mjs';
import { AUTHORITY_BANDS } from '../src/agent/authority.mjs';

/** A fixed timestamp, so a hash in an assertion cannot change with the clock. */
const T = '2026-10-15T00:00:00.000Z';
const block = (over = {}) => makeBlock({
  origin: 'sender@fleet',
  subject: 'a subject',
  body: 'a body',
  evidence: 'the evidence',
  observed_at: T,
  lineage: [],
  ...over,
});

describe('CAT7: the seven fields are fixed, and the order is part of the hash', () => {
  it('names exactly seven, in canonical order', () => {
    assert.deepEqual(CAT7_FIELDS, ['origin', 'subject', 'body', 'evidence', 'confidence', 'observed_at', 'lineage']);
    assert.equal(CAT7_FIELDS.length, 7);
  });

  it('splits them into three inherited and four receiver-chosen, with no overlap', () => {
    // The split is why a receiver cannot rewrite provenance: the three it does not choose are the three that
    // carry where the block came from and when it was seen.
    assert.deepEqual(INHERITED_FIELDS, ['origin', 'observed_at', 'lineage']);
    assert.deepEqual(RECEIVER_CHOOSABLE_FIELDS, ['subject', 'body', 'evidence', 'confidence']);
    for (const f of INHERITED_FIELDS) assert.equal(RECEIVER_CHOOSABLE_FIELDS.includes(f), false, f);
    // Together they are the seven, so neither list can grow without the other shrinking.
    assert.equal(INHERITED_FIELDS.length + RECEIVER_CHOOSABLE_FIELDS.length, CAT7_FIELDS.length);
  });

  it('refuses a block that is missing a field, and one carrying a field it does not know', () => {
    const missing = block();
    delete missing.body;
    assert.equal(blockProblem(missing).code, BLOCK_REFUSAL.MISSING_FIELD);
    // The refusal explains itself: the set is closed *so that acceptance can be per field*.
    assert.equal(blockProblem({ ...block(), extra: 1 }).code, BLOCK_REFUSAL.UNKNOWN_FIELD);
  });

  it('produces a block carrying all seven plus a hash, and verifies it', () => {
    const b = block();
    for (const f of CAT7_FIELDS) assert.ok(f in b, f);
    assert.equal(typeof b.hash, 'string');
    assert.equal(verifyBlock(b).ok, true);
  });

  it('detects a tampered field, because the hash covers the canonical serialization', () => {
    const b = block();
    const tampered = { ...b, body: 'something else' };
    assert.notEqual(blockHash(tampered), b.hash);
    assert.equal(verifyBlock(tampered).ok, false);
    assert.equal(verifyBlock(tampered).code, BLOCK_REFUSAL.HASH_MISMATCH);
  });
});

describe('field authority: cost is per field, and one field is an invariant', () => {
  it('declares a cost only for the fields a receiver may choose', () => {
    assert.deepEqual(FIELD_LEVELS, { subject: 0, body: 0, evidence: 50 });
    // The inherited three have no cost, because a cost is what a *chooser* has to pay.
    for (const f of INHERITED_FIELDS) assert.equal(ruleForField(f), null, f);
  });

  it('allows subject and body at any level, including 0', () => {
    for (const f of ['subject', 'body']) {
      for (const level of [0, 1, 49]) {
        const r = acceptField(f, { level });
        assert.equal(r.accepted, true, `${f} at ${level}`);
        assert.equal(r.required, 0);
      }
    }
  });

  it('costs evidence exactly 50, and the boundary is 49 versus 50', () => {
    // This is the correction: a level-70 dispatch succeeded, so 70 was written down as the threshold. It is 50,
    // and the band that starts at 50 is `captain` -- which is why the number is 50 and not an arbitrary 70.
    assert.equal(FIELD_LEVELS.evidence, 50);
    const below = acceptField('evidence', { level: 49 });
    const at = acceptField('evidence', { level: 50 });
    assert.equal(below.accepted, false);
    assert.equal(below.code, FIELD_REFUSAL.BELOW_AUTHORITY);
    assert.equal(below.required, 50);
    assert.equal(at.accepted, true);
  });

  it('refuses confidence at EVERY level, because it is an invariant rather than a threshold', () => {
    // The reason string says "invariant, not a default" on purpose: a reader who thinks it is a threshold will
    // try to raise it, and this assertion is what refuses that reading.
    assert.ok(Object.hasOwn(NEVER_ACCEPTED, 'confidence'));
    for (const level of [0, 49, 50, 70, 90, 100, 1e9]) {
      const r = acceptField('confidence', { level });
      assert.equal(r.accepted, false, `confidence at ${level}`);
      assert.equal(r.code, FIELD_REFUSAL.ALWAYS_REFUSED, `confidence at ${level}`);
      assert.equal(r.required, null, 'no level can satisfy it, so no level is reported');
    }
  });

  it('refuses a name that is not one of the seven, and refuses it differently', () => {
    // A rule cannot make a field exist, so this is checked before any table lookup -- otherwise a typo in the
    // rule table could conjure a field the far end would then reject.
    const r = acceptField('bogus', { level: 100 });
    assert.equal(r.accepted, false);
    assert.equal(r.code, FIELD_REFUSAL.NOT_A_FIELD);
    assert.equal(acceptField('body ', { level: 100 }).code, FIELD_REFUSAL.NOT_A_FIELD, 'trailing space is a different name');
  });

  it('reports UNDECLARED for an inherited field, which is not the same as refusing it', () => {
    for (const f of INHERITED_FIELDS) {
      const r = acceptField(f, { level: 100 });
      assert.equal(r.code, FIELD_REFUSAL.UNDECLARED, f);
      // The message says a field the table has not heard of is refused rather than granted -- and the table has
      // not heard of these because a receiver does not choose them.
      assert.match(r.reason, /nothing may accept it/);
    }
  });
});

describe('acceptWithAuthority: the whole-block decision, and the inherited fields survive it', () => {
  const run = (level) => acceptWithAuthority(block(), { level }, { accept: acceptBlock });
  const names = (list) => list.map((x) => x.field ?? x.why);

  it('accepts the inherited fields at level 0 even though acceptField calls them UNDECLARED', () => {
    // The two APIs answer different questions. `acceptField` asks "may a receiver choose this?" and says no for
    // the inherited three; `acceptWithAuthority` carries them across because they were never the receiver's to
    // choose. **Treating UNDECLARED as a refusal here would drop the ancestry that makes the block meaningful.**
    const r = run(0);
    for (const f of INHERITED_FIELDS) assert.ok(Object.hasOwn(r.accepted, f), f);
    assert.equal(acceptField('lineage', { level: 0 }).code, FIELD_REFUSAL.UNDECLARED);
  });

  it('omits evidence at 49 and includes it at 50, and never includes confidence', () => {
    const low = run(49);
    const high = run(50);
    assert.equal(Object.hasOwn(low.accepted, 'evidence'), false);
    assert.ok(names(low.refused).includes('evidence'));
    assert.equal(Object.hasOwn(high.accepted, 'evidence'), true);
    // Not present-and-null: ABSENT. A caller testing the value cannot tell "omitted" from "empty", which is why
    // the field's presence is the thing to test.
    for (const r of [low, high, run(100)]) assert.equal(Object.hasOwn(r.accepted, 'confidence'), false);
  });

  it('records a decision per field, so a caller need not re-derive a refusal', () => {
    const seen = [];
    authorityChooser({ level: 0 }, { onDecision: (d) => seen.push(d) });
    // The chooser is standalone; the recording path is what matters, and it must fire for every field asked.
    assert.equal(seen.length, 0, 'nothing asked yet');
    const chooser = authorityChooser({ level: 0 }, { onDecision: (d) => seen.push(d) });
    chooser('evidence');
    chooser('body');
    assert.deepEqual(seen.map((d) => d.field), ['evidence', 'body']);
    assert.deepEqual(seen.map((d) => d.accepted), [false, true]);
  });
});

describe('ancestry and acceptance answer two different questions about a missing parent', () => {
  const parent = block({ subject: 'parent' });
  const child = block({ subject: 'child', lineage: [parent.hash] });

  it('ancestry reports the gap in `missing` rather than failing, and never calls it an error', () => {
    // Measured signature: `ancestry(block, haveMap)` returns `{chain, missing, cycle, depth}` -- there is no
    // `ok` and no `code`. The comment states why: "`missing` collects every gap rather than stopping at the
    // first, because knowing HOW MUCH of a history is absent is more useful than knowing THAT some of it is."
    const held = new Map([[child.hash, child]]);
    const partial = ancestry(child, held);
    assert.deepEqual(partial.missing, [parent.hash]);
    assert.equal(partial.cycle, null);
    // `chain` holds only the ancestors actually produced, so a gap is absent from it rather than replaced by a
    // placeholder -- the same distinction as an omitted memory field.
    assert.deepEqual(partial.chain, []);

    const full = ancestry(child, new Map([[child.hash, child], [parent.hash, parent]]));
    assert.deepEqual(full.missing, []);
    assert.deepEqual(full.chain, [parent.hash], 'the parent, and only the parent: the named lineage is the chain');
  });

  it('cannot be given a cycle by construction, because the hash covers the lineage', () => {
    // A real cycle needs a block whose hash appears in its own ancestry -- and `blockHash` covers `lineage`, so
    // rebuilding a block changes its hash and the edge no longer closes. Walking a2 -> b -> a therefore
    // produces a DIAMOND, not a cycle. This is a property worth asserting: the hash is what makes a cycle
    // unconstructible rather than merely detectable.
    const a = block({ subject: 'a' });
    const b = block({ subject: 'b', lineage: [a.hash] });
    const a2 = block({ subject: 'a', lineage: [b.hash] });
    assert.notEqual(a2.hash, a.hash, 'the lineage is part of the hash, so the rebuilt block is a different one');

    const result = ancestry(a2, new Map([[a.hash, a], [b.hash, b], [a2.hash, a2]]));
    assert.equal(result.cycle, null);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.chain, [a.hash, b.hash], 'post-order: ancestors before the blocks depending on them');
  });

  it('terminates on a CYCLE instead of recursing, reachable only from an inconsistent store', () => {
    // `CYCLE` guards input `makeBlock` cannot produce. Because `blockHash` covers `lineage`, a block whose hash
    // appears in its own ancestry would need a hash preimage -- so the walk must be handed a `have` map whose
    // keys disagree with the blocks under them. That is a corrupted or hostile store, and the walk has to
    // terminate on it rather than recursing until the stack ends.
    //
    // Measured: this pairing closes a back edge, and the returned hash is the one already on the path.
    const a = block({ subject: 'a' });
    const b = block({ subject: 'b', lineage: [a.hash] });
    const c = block({ subject: 'c', lineage: [b.hash] });
    const corrupt = new Map([[c.hash, b], [b.hash, c]]);

    const result = ancestry(c, corrupt);
    assert.notEqual(result.cycle, null, 'the walk terminates and names the offending hash');
    assert.ok([b.hash, c.hash].includes(result.cycle), `cycle ${result.cycle} is one of the blocks on the path`);
    // Terminating is the whole point: an unbounded walk on hostile input is a denial of service.
    assert.equal(typeof result.depth, 'number');
  });

  it('acceptBlock refuses MISSING_PARENT, and this is the refusal that matters most', () => {
    // `lineage` is the receiver's own set of producible ancestors. A child naming a parent outside it is
    // refused rather than re-rooted: re-rooting would turn a claim with an unverifiable history into one with
    // NO history, which reads as a fresh independent assertion. That is how a fabricated claim acquires
    // respectability, and the refusal is the feature.
    const refused = acceptBlock(child, { lineage: [] });
    assert.equal(refused.accepted, null);
    assert.equal(refused.verified, true, 'the block itself is well formed -- the ancestry is what is absent');
    assert.equal(refused.accepted_fields.length, 0);
    assert.equal(refused.refused.length, 1);
    assert.equal(refused.refused[0].field, 'lineage');
    assert.match(refused.refused[0].why, /BLOCK_MISSING_PARENT/);
    assert.match(refused.refused[0].why, /refusing rather than re-rooting/);

    // Holding the parent accepts it.
    const accepted = acceptBlock(child, { lineage: [parent.hash] });
    assert.notEqual(accepted.accepted, null);
  });

  it('answers isDescendantOf with a result object, and distinguishes an echo from corroboration', () => {
    // Measured return: `{descendant, chain, missing, checked}` -- NOT a boolean. My first version asserted
    // `true`/`false` and failed, and the reason it returns more than a boolean is the point of the function:
    // "a claim that descends from something this machine already thought is an ECHO, not corroboration, and a
    // fleet that cannot tell those apart will confidently agree with itself."
    const withoutParent = isDescendantOf(child, parent.hash, new Map([[child.hash, child]]));
    assert.equal(withoutParent.descendant, false, 'the parent is not held, so nothing was corroborated');
    assert.deepEqual(withoutParent.missing, [parent.hash]);
    assert.equal(withoutParent.checked, 0, 'no ancestor was reachable to check');

    // Holding the parent makes it a real ancestor.
    const withParent = isDescendantOf(child, parent.hash, new Map([[child.hash, child], [parent.hash, parent]]));
    assert.equal(withParent.descendant, true);
    assert.equal(withParent.checked, 1);
    assert.deepEqual(withParent.missing, []);

    // A parent is not its own child, and a hash nobody named is not an ancestor either.
    const held = new Map([[child.hash, child], [parent.hash, parent]]);
    assert.equal(isDescendantOf(parent, child.hash, held).descendant, false);
    assert.equal(isDescendantOf(child, 'not-a-hash', held).descendant, false);
  });

  it('refuses a whole block whose hash does not match, before any field decision', () => {
    // Field-level acceptance is about trust, and there is nothing to trust about a block whose content does not
    // match what it claims to be -- so this refuses entirely rather than partitioning.
    const tampered = { ...block(), body: 'rewritten' };
    const result = acceptBlock(tampered, { lineage: [] });
    assert.equal(result.accepted, null);
    assert.equal(result.verified, false);
    assert.equal(result.refused.length, CAT7_FIELDS.length, 'every field is refused, not just the changed one');
  });
});

describe('the authority bands the costs are read against', () => {
  it('places 50 at the start of captain, which is why evidence costs 50', () => {
    const band = (level) => AUTHORITY_BANDS.find((b) => level >= b.min && (b.max === null || level <= b.max));
    assert.equal(band(49).name, 'ordinary');
    assert.equal(band(50).name, 'captain');
    assert.equal(band(69).name, 'captain');
    assert.equal(band(70).name, 'org_admin');
    assert.equal(band(90).name, 'system_admin');
    // The cost is not arbitrary: it is the bottom of a band, so the rule can be stated in band terms.
    assert.equal(FIELD_LEVELS.evidence, 50);
  });

  it('covers every level with exactly one band, and leaves the top open', () => {
    for (const level of [0, 1, 49, 50, 69, 70, 89, 90, 1000]) {
      const matches = AUTHORITY_BANDS.filter((b) => level >= b.min && (b.max === null || level <= b.max));
      assert.equal(matches.length, 1, `level ${level} matched ${matches.length} bands`);
    }
    assert.equal(AUTHORITY_BANDS.find((b) => b.name === 'system_admin').max, null);
  });
});
