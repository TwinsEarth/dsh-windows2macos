/**
 * The merge rule, tested as a rule.
 *
 * These tests exist because the rule came from the operator and has two layers: **newest wins by default**, and **a
 * declared repair of the default flow outranks recency**. The second layer is the one that is easy to implement
 * backwards -- "newer always wins" is the natural default and silently drops the override -- so it gets its own
 * explicit test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { completeness, decide, mergeMemory, parseEntry } from '../src/plugin/fleet-merge.mjs';

const entry = (id, text, extra = '') => `- 〔id:${id}${extra ? ' ' + extra : ''}〕${text}`;

describe('fleet memory entry syntax', () => {
  it('parses id, fix, evidence and verified out of the metadata bracket', () => {
    const parsed = parseEntry(entry('a', 'the fact', 'fix evidence=4 verified=3'));
    assert.equal(parsed.id, 'a');
    assert.equal(parsed.fix, true);
    assert.equal(parsed.evidence, 4);
    assert.equal(parsed.verified, 3);
    assert.equal(parsed.content, 'the fact');
  });

  it('treats prose without a metadata bracket as unkeyed', () => {
    assert.equal(parseEntry('- just a bullet'), null);
    assert.equal(parseEntry('# heading'), null);
    assert.equal(parseEntry(entry('no-id-marker', 'x').replace('id:no-id-marker', '')), null, 'an entry with no id is prose');
  });

  it('computes completeness as evidence + 2 x verified', () => {
    // One reproduced fact must outrank three unreproduced ones: that is the judgement the spec records.
    assert.equal(completeness({ evidence: 3, verified: 0 }), 3);
    assert.equal(completeness({ evidence: 1, verified: 1 }), 3);
    assert.equal(completeness({ evidence: 0, verified: 2 }), 4);
  });
});

describe('the merge rule', () => {
  const L = (id, text, extra) => entry(id, text, extra);

  it('default layer: the newer publication wins', () => {
    const local = { id: 'x', fix: false, evidence: 0, verified: 0, content: 'old', raw: L('x', 'old') };
    const fleet = { id: 'x', fix: false, evidence: 0, verified: 0, content: 'new', raw: L('x', 'new') };
    const verdict = decide(local, fleet, { localAddedAtMs: 100, fleetAddedAtMs: 200 });
    assert.equal(verdict.winner, 'fleet');
    assert.equal(verdict.layer, 'default');
    assert.match(verdict.reason, /newer publication/);
  });

  /**
   * The operator's override, and the reason this whole feature exists.
   *
   * A repair that was written **earlier** must still beat a newer non-repair. If this test ever flips, the rule has
   * been silently reduced to "newest wins" and a fixed fact can be overwritten by an older understanding.
   */
  it('repair layer: a declared fix outranks a NEWER non-fix', () => {
    const local = { id: 'x', fix: true, evidence: 1, verified: 1, content: 'repaired', raw: L('x', 'repaired', 'fix evidence=1 verified=1') };
    const fleet = { id: 'x', fix: false, evidence: 9, verified: 9, content: 'newer but not declared a fix', raw: L('x', 'newer') };
    const verdict = decide(local, fleet, { localAddedAtMs: 100, fleetAddedAtMs: 999 });
    assert.equal(verdict.winner, 'local', 'an older repair still wins: "修复默认流程有最后修改权"');
    assert.equal(verdict.layer, 'repair');
  });

  it('repair vs repair: the more complete and better verified one wins', () => {
    const local = { id: 'x', fix: true, evidence: 4, verified: 3, content: 'a', raw: L('x', 'a', 'fix evidence=4 verified=3') };
    const fleet = { id: 'x', fix: true, evidence: 1, verified: 0, content: 'b', raw: L('x', 'b', 'fix evidence=1') };
    const verdict = decide(local, fleet, { localAddedAtMs: 1, fleetAddedAtMs: 999 });
    assert.equal(verdict.winner, 'local', 'completeness beats recency between two declared repairs');
    assert.equal(verdict.layer, 'repair');
    assert.match(verdict.reason, /completeness/);
  });

  it('repair vs repair with equal completeness: verification count breaks it', () => {
    // completeness is equal (2 each) but only one was actually reproduced.
    const local = { id: 'x', fix: true, evidence: 0, verified: 1, content: 'a', raw: L('x', 'a', 'fix verified=1') };
    const fleet = { id: 'x', fix: true, evidence: 2, verified: 0, content: 'b', raw: L('x', 'b', 'fix evidence=2') };
    assert.equal(completeness(local), completeness(fleet));
    const verdict = decide(local, fleet, { localAddedAtMs: 1, fleetAddedAtMs: 999 });
    assert.equal(verdict.winner, 'local');
    assert.match(verdict.reason, /verified/);
  });

  it('repair vs repair with equal scores falls through to recency', () => {
    const local = { id: 'x', fix: true, evidence: 1, verified: 1, content: 'a', raw: L('x', 'a', 'fix evidence=1 verified=1') };
    const fleet = { id: 'x', fix: true, evidence: 1, verified: 1, content: 'b', raw: L('x', 'b', 'fix evidence=1 verified=1') };
    const verdict = decide(local, fleet, { localAddedAtMs: 100, fleetAddedAtMs: 200 });
    assert.equal(verdict.winner, 'fleet');
  });

  it('a genuine tie is resolved deterministically AND recorded as a tie', () => {
    const local = { id: 'x', fix: false, evidence: 0, verified: 0, content: 'a', raw: L('x', 'a') };
    const fleet = { id: 'x', fix: false, evidence: 0, verified: 0, content: 'b', raw: L('x', 'b') };
    const first = decide(local, fleet, { localAddedAtMs: 5, fleetAddedAtMs: 5, localHash: 'abc', fleetHash: 'def' });
    const second = decide(local, fleet, { localAddedAtMs: 5, fleetAddedAtMs: 5, localHash: 'abc', fleetHash: 'def' });
    assert.equal(first.winner, second.winner, 'the tie-break must not depend on argument order alone');
    assert.equal(first.layer, 'tie');
    assert.match(first.reason, /genuine tie/);
  });
});

describe('merging two documents', () => {
  it('records a decision for every adjudicated id and never writes', () => {
    const localText = [entry('timeout', 'default timeout is 300s'), entry('memory', 'memory.jsonl rotates at 1MB')].join('\n');
    const fleetText = [entry('timeout', 'default timeout is 600s')].join('\n');
    const result = mergeMemory({ localText, fleetText, localAddedAtMs: 100, fleetAddedAtMs: 200 });

    assert.equal(result.wroteAnything, false);
    assert.equal(result.decisions.length, 1, 'one divergent id, one decision');
    assert.equal(result.decisions[0].id, 'timeout');
    assert.equal(result.decisions[0].winner, 'fleet', 'fleet is newer and neither side declares a fix');
    assert.match(result.text, /<!-- timeout -> fleet \(default\)/, 'the output explains the choice');
    assert.equal(result.removed.length, 1, 'the local-only id is reported, not silently kept');
  });

  it('keeps prose as a union and refuses a duplicated id instead of resolving it', () => {
    const localText = ['# Fleet memory', '- 〔id:dup〕first', '- 〔id:dup〕second'].join('\n');
    const fleetText = ['# Fleet memory', 'a prose line only the fleet has'].join('\n');
    const result = mergeMemory({ localText, fleetText, localAddedAtMs: 1, fleetAddedAtMs: 2 });

    assert.deepEqual(result.refused.map((r) => r.id), ['dup'], 'a broken document is refused, not merged');
    assert.ok(result.text.includes('a prose line only the fleet has'), 'prose is unioned');
    assert.ok(result.text.includes('<!-- dup REFUSED:'), 'and the refusal is auditable');
  });

  it('does not mutate its inputs', () => {
    const localText = entry('x', 'a');
    const fleetText = entry('x', 'b');
    const before = [localText, fleetText];
    mergeMemory({ localText, fleetText, localAddedAtMs: 1, fleetAddedAtMs: 2 });
    assert.deepEqual([localText, fleetText], before);
  });

  it('reports an identical id on both sides as unchanged, without a decision', () => {
    const same = entry('x', 'identical');
    const result = mergeMemory({ localText: same, fleetText: same, localAddedAtMs: 1, fleetAddedAtMs: 2 });
    assert.equal(result.unchanged, 1);
    assert.equal(result.decisions.length, 0, 'nothing diverged, so nothing was adjudicated');
  });
});
