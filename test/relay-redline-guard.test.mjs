/**
 * relay 红线守卫（模块级 DP-06..DP-14）。
 * 这些用例验证 guard 的拒绝/放行语义；HTTP 路由接入后复用同一断言。
 * 未接线部分：server.mjs 调用点、真实 HTTP 的“无副作用”断言（无 ledger/无 blob）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { guardBlobRoute, guardResultEnvelope, guardTaskBody } from '../src/relay/redline-guard.mjs';

describe('DP-06..DP-14 relay 守卫', () => {
  it('DP-06 task 含 file 字段 → 422 DATA_PLANE_FORBIDDEN', () => {
    const result = guardTaskBody({ mode: 'replicate', file: 'a.txt' });
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'DATA_PLANE_FORBIDDEN');
    assert.deepEqual(result.body.detail.fields, ['file']);
  });
  it('DP-07 result 含 stdout_head → 422', () => {
    const result = guardResultEnvelope({ task_id: 't1', stdout_head: 'SECRET' });
    assert.equal(result.status, 422);
    assert.deepEqual(result.body.detail.fields, ['stdout_head']);
  });
  it('DP-08 result 含 command_argv → 422', () => {
    const result = guardResultEnvelope({ task_id: 't1', command_argv: ['node', '--token=x'] });
    assert.equal(result.status, 422);
    assert.ok(result.body.detail.fields.includes('command_argv'));
  });
  it('DP-09/DP-10 blob PUT/GET → 403 DATA_PLANE_REFUSED', () => {
    for (const method of ['PUT', 'GET']) {
      const result = guardBlobRoute(method);
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'DATA_PLANE_REFUSED');
    }
  });
  it('DP-11 blob-sessions POST → 403', () => {
    assert.equal(guardBlobRoute('POST').status, 403);
  });
  it('DP-12 超 16KiB task → 413 CONTROL_TOO_LARGE', () => {
    const result = guardTaskBody({ mode: 'replicate', note: 'x'.repeat(20000) });
    assert.equal(result.status, 413);
    assert.equal(result.body.reason, 'CONTROL_TOO_LARGE');
  });
  it('DP-13 clean task 放行', () => {
    assert.deepEqual(guardTaskBody({ mode: 'replicate', command_argv: ['node', 'x.mjs'], machine_id: 'm1', write: false }), { ok: true });
  });
  it('DP-14 clean result 放行', () => {
    assert.deepEqual(guardResultEnvelope({ task_id: 't1', stdout_sha256: 'a'.repeat(64), stdout_bytes: 12 }), { ok: true });
  });
  it('补充：NULL body / 非对象 → 400', () => {
    assert.equal(guardTaskBody(null).status, 400);
    assert.equal(guardResultEnvelope(null).status, 400);
  });
});
