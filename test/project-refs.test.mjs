/**
 * Project refs and merge bookkeeping tests (v1.3.13-beta.3 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectRefs } from '../src/relay/project-refs.mjs';

const P = 'prj-refs';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const PATCH = 'd'.repeat(64);

function setup() {
  const events = [];
  const refs = createProjectRefs({ onEvent: (event) => events.push(event) });
  return { refs, events };
}

describe('project refs', () => {
  it('refuses the first advance unless the caller names the empty head it saw', () => {
    const { refs } = setup();
    const refused = refs.advance({ projectId: P, branch: 'main', from: A, to: B });
    assert.equal(refused.code, 'REF_UNINITIALIZED');
    const accepted = refs.advance({ projectId: P, branch: 'main', from: null, to: A });
    assert.equal(accepted.ok, true);
    assert.equal(refs.head({ projectId: P, branch: 'main' }).version, 1);
  });

  it('refuses an advance built on a stale head, and refuses a no-op', () => {
    const { refs } = setup();
    refs.advance({ projectId: P, branch: 'main', from: null, to: A });
    const stale = refs.advance({ projectId: P, branch: 'main', from: C, to: B });
    assert.equal(stale.code, 'REF_BASE_MISMATCH');
    assert.equal(stale.expected, A);
    const noop = refs.advance({ projectId: P, branch: 'main', from: A, to: A });
    assert.equal(noop.code, 'REF_NO_CHANGE');
  });

  it('queues a patch, answers a second identical submission as already_merged, and advances on merge', () => {
    const { refs, events } = setup();
    refs.advance({ projectId: P, branch: 'main', from: null, to: A });
    const first = refs.enqueue({ projectId: P, branch: 'main', patchSha256: PATCH, baseCommit: A, sourceTaskId: 't-1' });
    assert.equal(first.already_merged, false);
    const settled = refs.complete({ queueId: first.item.queue_id, outcome: 'merged', headCommit: B });
    assert.equal(settled.ok, true);
    assert.equal(refs.head({ projectId: P, branch: 'main' }).head_commit, B);
    const second = refs.enqueue({ projectId: P, branch: 'main', patchSha256: PATCH, baseCommit: A });
    assert.equal(second.already_merged, true);
    assert.ok(events.some((event) => event.type === 'merge.merged'));
  });

  it('does not advance on a conflict, and keeps the conflict artifact hash', () => {
    const { refs } = setup();
    refs.advance({ projectId: P, branch: 'main', from: null, to: A });
    const item = refs.enqueue({ projectId: P, branch: 'main', patchSha256: PATCH, baseCommit: A });
    const settled = refs.complete({ queueId: item.item.queue_id, outcome: 'conflict', conflictSha256: 'e'.repeat(64) });
    assert.equal(settled.ok, true);
    assert.equal(refs.head({ projectId: P, branch: 'main' }).head_commit, A);
    assert.equal(settled.item.conflict_sha256, 'e'.repeat(64));
  });

  it('refuses a merge whose base is no longer the head, leaving the item queued', () => {
    const { refs } = setup();
    refs.advance({ projectId: P, branch: 'main', from: null, to: A });
    const item = refs.enqueue({ projectId: P, branch: 'main', patchSha256: PATCH, baseCommit: C });
    const settled = refs.complete({ queueId: item.item.queue_id, outcome: 'merged', headCommit: B });
    assert.equal(settled.code, 'REF_ADVANCE_REFUSED');
    assert.equal(refs.listQueue({ projectId: P })[0].state, 'queued');
  });
});