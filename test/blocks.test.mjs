/**
 * Cognitive memory blocks suite (v4.8.0) -- field-level acceptance and lineage.
 *
 * The harness is a local copy rather than a shared import, matching the convention in
 * test/authority.test.mjs and test/memory.test.mjs: suites here must not be able to break each other by
 * editing a common helper.
 *
 * What these tests protect, said once so a later reader need not infer it. The block model exists because
 * a fleet that repeats a claim loses the ability to tell a **fact** from an **echo**, and once that
 * distinction is gone, agreement between machines stops meaning anything. So the tests below are mostly
 * adversarial: they are about the specific ways a fabricated or self-confirming history could be made to
 * look well-formed, and each one asserts the refusal rather than the happy path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_REFUSAL,
  CAT7_FIELDS,
  INHERITED_FIELDS,
  RECEIVER_CHOOSABLE_FIELDS,
  acceptBlock,
  ancestry,
  blockHash,
  blockProblem,
  canonical,
  defaultChoose,
  isDescendantOf,
  linkFixtures,
  makeBlock,
  verifyBlock,
} from '../src/agent/blocks.mjs';

/** A well-formed block, with overrides. */
function block(over = {}) {
  return makeBlock({
    origin: 'machine-a',
    subject: 'macmini',
    body: 'node is v24.21.0',
    evidence: 'measured by probe',
    confidence: 0.9,
    observed_at: '2026-10-14T12:00:00.000Z',
    lineage: [],
    ...over,
  });
}

describe('blocks: the seven fields are fixed', () => {
  it('names exactly the seven, partitioned into inherited and choosable', () => {
    assert.equal(CAT7_FIELDS.length, 7);
    assert.deepEqual([...INHERITED_FIELDS, ...RECEIVER_CHOOSABLE_FIELDS].sort(), [...CAT7_FIELDS].sort());
    // No overlap: a field that is both inherited and choosable is a field whose authenticity is optional.
    for (const f of INHERITED_FIELDS) assert.equal(RECEIVER_CHOOSABLE_FIELDS.includes(f), false, `${f} is in both lists`);
  });

  it('refuses an unknown field, because acceptance is decided per field', () => {
    // An eighth field would be a field nobody agreed how to accept -- and silently ignoring it would mean
    // its content travelled without ever being judged.
    const b = { ...block(), extra: 'smuggled' };
    const problem = blockProblem(b);
    assert.equal(problem.code, BLOCK_REFUSAL.UNKNOWN_FIELD);
    assert.match(problem.detail, /extra/);
  });

  it('refuses each missing field by name', () => {
    for (const field of CAT7_FIELDS) {
      const b = block();
      delete b[field];
      const problem = blockProblem(b);
      assert.equal(problem.code, BLOCK_REFUSAL.MISSING_FIELD, `${field}`);
      assert.match(problem.detail, new RegExp(field));
    }
  });
});

describe('blocks: canonical form is stable, because the hash depends on it', () => {
  it('is insensitive to key order', () => {
    // Two implementations that differed here would compute different hashes for the same block and each
    // would call the other a forgery.
    assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  });

  it('preserves array order, which is meaning rather than formatting', () => {
    assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  });

  it('escapes strings rather than concatenating them ambiguously', () => {
    // Without escaping, `{"a":"1,2"}` and `{"a":1,"b":2}` could collide.
    assert.notEqual(canonical({ a: '1,2' }), canonical({ a: 1, b: 2 }));
  });

  it('refuses a value it cannot canonicalise instead of guessing', () => {
    assert.throws(() => canonical({ a: undefined }), TypeError);
    assert.throws(() => canonical({ a: () => {} }), TypeError);
  });
});

describe('blocks: a hash that does not cover the content is detectable', () => {
  it('verifies a block it built', () => {
    const b = block();
    const v = verifyBlock(b);
    assert.equal(v.ok, true);
    assert.equal(v.hash, b.hash);
  });

  it('detects an edit made after hashing', () => {
    // The whole reason the field exists: a block edited after the fact must not leave the lineage that
    // references it undisturbed.
    const b = block();
    const tampered = { ...b, body: 'node is v99.0.0' };
    const v = verifyBlock(tampered);
    assert.equal(v.ok, false);
    assert.equal(v.code, BLOCK_REFUSAL.HASH_MISMATCH);
  });

  it('computes the same hash whether or not the hash field is present', () => {
    const b = block();
    const { hash: _drop, ...withoutHash } = b;
    assert.equal(blockHash(b), blockHash(withoutHash));
  });
});

describe('blocks: field-level acceptance refuses in part, and says which part', () => {
  it('accepts the body and refuses the confidence by default', () => {
    // The default is deliberately conservative: `confidence` is the sender's opinion about its own
    // assertion, and adopting it would mean this machine now asserts a certainty it never established.
    const result = acceptBlock(block());
    assert.equal(result.verified, true);
    assert.equal(result.accepted.body, 'node is v24.21.0');
    assert.equal('confidence' in result.accepted, false);
    assert.deepEqual(result.refused.map((r) => r.field), ['confidence']);
    assert.match(result.refused[0].why, /certainty/);
  });

  it('never offers an inherited field to the chooser', () => {
    // Not a policy decision: a receiver that set `origin` or `observed_at` would be manufacturing
    // provenance, and provenance that can be manufactured is not provenance. `confidence` is also absent,
    // for a different reason -- it is a hard invariant rather than a default, so it is never offered.
    const offered = [];
    acceptBlock(block(), { choose: (field) => { offered.push(field); return true; } });
    for (const field of INHERITED_FIELDS) {
      assert.equal(offered.includes(field), false, `${field} must not be offered to the chooser`);
    }
    assert.equal(offered.includes('confidence'), false, 'confidence is an invariant, not a choosable');
    assert.deepEqual(offered.sort(), ['body', 'evidence', 'subject']);
  });

  it('refuses confidence even when a custom chooser accepts everything', () => {
    // The invariant, asserted directly. Supplying a chooser used to REPLACE the default rather than refine
    // it, which made the conservative property silently optional -- and "silently optional" is how a
    // safety default stops being one.
    const result = acceptBlock(block(), { choose: () => true });
    assert.equal('confidence' in result.accepted, false);
    assert.equal(result.refused.find((r) => r.field === 'confidence').why.includes('invariant'), true);
  });

  it('carries inherited fields through unchanged even when the chooser accepts everything', () => {
    const b = block();
    const result = acceptBlock(b, { choose: () => true });
    for (const field of INHERITED_FIELDS) assert.deepEqual(result.accepted[field], b[field], field);
  });

  it('reports the refused half rather than silently dropping it', () => {
    // A filtered copy would lose the decision. "This machine declined the confidence and kept the body"
    // is evidence about the receiver and has to be inspectable.
    const result = acceptBlock(block(), { choose: (f) => f !== 'evidence' });
    assert.equal('evidence' in result.accepted, false);
    assert.equal(result.refused.length, 2);
    assert.deepEqual(result.accepted_fields.includes('evidence'), false);
  });

  it('refuses the whole block when its hash does not verify', () => {
    // Field-level acceptance is about trust. There is nothing to trust about a block whose content does
    // not match what it claims to be, so no field survives.
    const tampered = { ...block(), body: 'changed' };
    const result = acceptBlock(tampered);
    assert.equal(result.verified, false);
    assert.equal(result.accepted, null);
    assert.equal(result.accepted_fields.length, 0);
    assert.equal(result.refused.length, CAT7_FIELDS.length);
  });

  it('treats a throwing chooser as a refusal, not as an acceptance or a crash', () => {
    const result = acceptBlock(block(), { choose: (f) => { if (f === 'body') throw new Error('boom'); return true; } });
    assert.equal('body' in result.accepted, false);
    assert.match(result.refused.find((r) => r.field === 'body').why, /chooser threw/);
  });
});

describe('blocks: lineage is content, and a missing parent is a refusal', () => {
  it('refuses rather than re-roots when an ancestor cannot be produced', () => {
    // The most important refusal in the module. Re-rooting -- keeping the claim and emptying its
    // lineage -- converts an unverifiable history into no history, which reads as a fresh, independent
    // assertion. That is exactly how a fabricated claim acquires respectability.
    const parent = block({ body: 'parent', origin: 'machine-b' });
    const child = block({ body: 'child', lineage: [parent] });

    const withParent = acceptBlock(child, { lineage: [parent.hash] });
    assert.equal(withParent.accepted.body, 'child', 'a producible ancestor is accepted');

    const withoutParent = acceptBlock(child, { lineage: [] });
    assert.equal(withoutParent.accepted, null);
    assert.equal(withoutParent.refused[0].field, 'lineage');
    assert.match(withoutParent.refused[0].why, /MISSING_PARENT/);
    assert.match(withoutParent.refused[0].why, /rather than re-rooting/);
  });

  it('hashes an ancestor given as a block, so an id cannot be passed off as content', () => {
    // `observed_at` is pinned here rather than left to default. `makeBlock` stamps the current time when
    // none is given -- correctly, since a block being observed "now" is what that field means -- but two
    // blocks built a millisecond apart then differ, and comparing them would be measuring the clock
    // rather than the lineage rule under test. This cost a round: the failure looked like a hashing
    // defect and was a 1ms difference in a field the test never mentioned.
    const parent = block({ body: 'p' });
    const childBody = {
      origin: 'a',
      subject: 's',
      body: 'c',
      evidence: null,
      confidence: null,
      observed_at: '2026-10-14T12:00:00.000Z',
    };
    const asBlock = makeBlock({ ...childBody, lineage: [parent] });
    const asHash = makeBlock({ ...childBody, lineage: [parent.hash] });
    assert.deepEqual(asBlock.lineage, asHash.lineage);
    assert.equal(asBlock.hash, asHash.hash, 'a block and its hash are the same reference');
    assert.equal(asBlock.lineage[0], parent.hash, 'the ancestor reference is the block\'s own hash');
  });

  it('refuses a lineage entry that is not a sha256', () => {
    const b = { ...block(), lineage: ['not-a-hash'] };
    const problem = blockProblem(b);
    assert.equal(problem.code, BLOCK_REFUSAL.BAD_LINEAGE);
  });

  it('refuses a lineage that repeats an ancestor', () => {
    const parent = block({ body: 'p' });
    const b = { ...block(), lineage: [parent.hash, parent.hash] };
    assert.equal(blockProblem(b).code, BLOCK_REFUSAL.BAD_LINEAGE);
  });
});

describe('blocks: ancestry tells a diamond from a cycle', () => {
  it('walks a chain and puts ancestors before descendants', () => {
    const a = block({ body: 'a' });
    const b = block({ body: 'b', lineage: [a] });
    const c = block({ body: 'c', lineage: [b] });
    const have = new Map([[a.hash, a], [b.hash, b]]);
    const result = ancestry(c, have);
    assert.equal(result.cycle, null);
    assert.deepEqual(result.missing, []);
    assert.equal(result.chain.includes(a.hash), true);
    assert.equal(result.chain.indexOf(a.hash) < result.chain.indexOf(b.hash), true, 'ancestor must precede its descendant');
  });

  it('treats a diamond as ordinary, and visits it once', () => {
    // A claim supported by two paths is not malformed. An earlier draft reported this as a cycle in some
    // orders, which is why the distinction is asserted rather than assumed.
    const root = block({ body: 'root' });
    const left = block({ body: 'left', lineage: [root] });
    const right = block({ body: 'right', lineage: [root] });
    const top = block({ body: 'top', lineage: [left, right] });
    const have = new Map([[root.hash, root], [left.hash, left], [right.hash, right]]);
    const result = ancestry(top, have);
    assert.equal(result.cycle, null, 'a diamond must not be reported as a cycle');
    assert.equal(result.chain.filter((h) => h === root.hash).length, 1, 'the shared ancestor is visited once');
  });

  it('reports a cycle explicitly rather than looping', () => {
    // A cycle cannot be built by `makeBlock`: a block's hash covers its lineage, so linking two blocks to
    // each other changes the hashes being linked. The first version of this test mutated `lineage` after
    // hashing and keyed the map by the recomputed digest, which left the references pointing at hashes
    // the map did not hold -- the walker reported `missing` and never met the cycle. `linkFixtures` makes
    // the reference and the key the same string, so the fixture is the shape it claims to be.
    const x = { ...block({ body: 'x' }), lineage: [] };
    const y = { ...block({ body: 'y' }), lineage: [] };
    x.lineage = [y.hash];
    y.lineage = [x.hash];
    const have = linkFixtures([x, y]);
    assert.equal(have.has(y.hash), true, 'the fixture must be keyed by the reference x uses');
    const result = ancestry(x, have);
    assert.equal(typeof result.cycle, 'string', `expected a cycle, got ${JSON.stringify(result)}`);
    assert.equal(result.missing.length, 0, 'a cycle is not a gap, and must not be reported as one');
  });

  it('collects every gap rather than stopping at the first', () => {
    const missingOne = 'a'.repeat(64);
    const missingTwo = 'b'.repeat(64);
    const known = block({ body: 'known' });
    const top = { ...block({ body: 'top' }), lineage: [missingOne, missingTwo, known.hash] };
    const result = ancestry(top, new Map([[known.hash, known]]));
    assert.equal(result.missing.length, 2);
    assert.deepEqual([...result.missing].sort(), [missingOne, missingTwo].sort());
  });

  it('stops at the depth limit rather than recursing forever', () => {
    const chain = [];
    let previous = null;
    for (let i = 0; i < 30; i += 1) {
      const b = makeBlock({ origin: 'a', subject: 's', body: `n${i}`, lineage: previous === null ? [] : [previous] });
      chain.push(b);
      previous = b;
    }
    const have = new Map(chain.map((b) => [b.hash, b]));
    const result = ancestry(chain[chain.length - 1], have, { maxDepth: 5 });
    assert.ok(result.chain.length <= 6, `expected a bounded walk, got ${result.chain.length}`);
  });
});

describe('blocks: provenance answers the question P2 actually asks', () => {
  it('recognises a claim that descends from something already thought', () => {
    // A rumour and a fact look identical once each has been repeated twice. This is the check that keeps
    // them apart: an echo is not corroboration.
    const mine = block({ origin: 'machine-a', body: 'my earlier thought' });
    const theirs = block({ origin: 'machine-b', body: 'a claim echoing it', lineage: [mine] });
    const have = new Map([[mine.hash, mine]]);

    const viaTheirs = isDescendantOf(theirs, mine.hash, have);
    assert.equal(viaTheirs.descendant, true);

    const unrelated = block({ origin: 'machine-b', body: 'independent', lineage: [] });
    assert.equal(isDescendantOf(unrelated, mine.hash, have).descendant, false);
  });
});

describe('blocks: the default chooser is conservative by construction', () => {
  it('refuses exactly the confidence and nothing else', () => {
    for (const field of RECEIVER_CHOOSABLE_FIELDS) {
      const decision = defaultChoose(field);
      const accept = typeof decision === 'boolean' ? decision : decision.accept;
      assert.equal(accept, field !== 'confidence', field);
    }
  });
});
