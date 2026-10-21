import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_RE_READ, MERGE_UP_TO_DATE, renderMergeHint } from '../src/plugin/merge-hint.mjs';

describe('renderMergeHint', () => {
  it('says append normally when there is no conflict', () => {
    assert.deepEqual(renderMergeHint({}), { state: MERGE_UP_TO_DATE, behind_by: 0, unread: 0, sample_count: 0, next: 'append normally' });
  });

  it('names the re-read step and counts what is unseen', () => {
    const hint = renderMergeHint({ conflict: { behind_by: 3, unread_records: [{ a: 1 }, { b: 2 }], sample: [{ a: 1 }] } });
    assert.equal(hint.state, MERGE_RE_READ);
    assert.equal(hint.behind_by, 3);
    assert.equal(hint.unread, 2);
    assert.equal(hint.sample_count, 1);
    assert.match(hint.next, /do not merge unseen records/);
  });

  it('treats a zero-valued conflict as up to date rather than a refusal', () => {
    const hint = renderMergeHint({ conflict: { behind_by: 0, unread_records: [] } });
    assert.equal(hint.state, MERGE_UP_TO_DATE);
  });
});
