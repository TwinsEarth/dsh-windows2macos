/** U7/无副作用：guarded-dispatch 在拒绝时不调用 inner handler。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGuardedDispatch } from '../src/relay/guarded-dispatch.mjs';

function rig() {
  let calls = 0;
  const seen = [];
  const handle = (request) => { calls += 1; seen.push(request.path); return { status: 200, body: { ok: true } }; };
  return { guarded: createGuardedDispatch({ handle }), calls: () => calls, seen };
}

describe('U7 blob 端点拒绝且无副作用', () => {
  it('PUT/GET/POST blob 与 blob-sessions → 403，inner 零调用', () => {
    for (const [method, path] of [
      ['PUT', '/v1/fleet/blobs/' + 'a'.repeat(64)],
      ['GET', '/v1/fleet/blobs/' + 'a'.repeat(64)],
      ['POST', '/v1/fleet/blob-sessions'],
      ['GET', '/v1/fleet/blobs/latest'],
    ]) {
      const r = rig();
      const result = r.guarded({ method, path, body: {} });
      assert.equal(result.status, 403, method + ' ' + path);
      assert.equal(result.body.code, 'DATA_PLANE_REFUSED');
      assert.equal(r.calls(), 0);
    }
  });
  it('clean 请求透传给 inner 一次', () => {
    const r = rig();
    const result = r.guarded({ method: 'GET', path: '/healthz' });
    assert.equal(result.status, 200);
    assert.equal(r.calls(), 1);
  });
});

describe('U3 task/result guard 无副作用', () => {
  it('task 含 patch → 422，inner 零调用', () => {
    const r = rig();
    assert.equal(r.guarded({ method: 'POST', path: '/v1/task', body: { patch: 'diff --git a/x b/x' } }).status, 422);
    assert.equal(r.calls(), 0);
  });
  it('result 含 stdout_head → 422，inner 零调用', () => {
    const r = rig();
    assert.equal(r.guarded({ method: 'POST', path: '/v1/result', body: { stdout_head: 'SECRET' } }).status, 422);
    assert.equal(r.calls(), 0);
  });
  it('干净 task/result 透传', () => {
    const r = rig();
    assert.equal(r.guarded({ method: 'POST', path: '/v1/task', body: { mode: 'replicate', machine_id: 'm1', command_argv: ['node', 'x.mjs'] } }).status, 200);
    assert.equal(r.guarded({ method: 'POST', path: '/v1/result', body: { task_id: 't1', stdout_sha256: 'a'.repeat(64) } }).status, 200);
    assert.equal(r.calls(), 2);
  });
});
