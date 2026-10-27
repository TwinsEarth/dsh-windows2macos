/** S0 数据面端口单测：Ref 校验、目标判定、NullSink 降级。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertDataPlaneTarget,
  createDataPlane,
  createNullSink,
  inspectRef,
  REF_MAX_BYTES,
} from '../src/util/data-plane.mjs';

const ref = (over = {}) => ({
  v: 1,
  sink: 'github',
  locator: 'refs/w2m/in/task-1/1',
  kind: 'patch',
  task_id: 't1',
  machine_id: 'm1',
  plain: { sha256: 'a'.repeat(64), bytes: 1024 },
  cipher: { sha256: 'b'.repeat(64), bytes: 1200 },
  ...over,
});

describe('S0 InspectRef', () => {
  it('接受纯元数据 Ref', () => {
    assert.deepEqual(inspectRef(ref()), { ok: true });
  });
  it('拒绝内容字段', () => {
    assert.equal(inspectRef(ref({ patch: 'diff --git a/x b/x' })).code, 'DATA_PLANE_FORBIDDEN');
    assert.equal(inspectRef(ref({ plain: { sha256: 'a'.repeat(64), bytes: 1, stdout: 'x' } })).code, 'DATA_PLANE_FORBIDDEN');
  });
  it('拒绝未知字段、错误版本、超长', () => {
    assert.equal(inspectRef(ref({ extra: 1 })).code, 'REF_FIELD_UNKNOWN');
    assert.equal(inspectRef(ref({ v: 2 })).code, 'REF_VERSION');
    const big = ref({ locator: 'x'.repeat(REF_MAX_BYTES) });
    assert.equal(inspectRef(big).code, 'REF_TOO_LARGE');
  });
  it('拒绝坏哈希与未知 sink/kind', () => {
    assert.equal(inspectRef(ref({ plain: { sha256: 'zz' } })).code, 'REF_PLAIN_INVALID');
    assert.equal(inspectRef(ref({ sink: 'relay' })).code, 'REF_SINK_UNKNOWN');
    assert.equal(inspectRef(ref({ kind: 'stdout2' })).code, 'REF_KIND_UNKNOWN');
  });
});

describe('S0 目标判定', () => {
  const relay = 'http://43.142.74.71:8787';
  it('允许 GitHub / SSH / 局域网 Git', () => {
    assert.deepEqual(assertDataPlaneTarget({ endpoint: 'git@github.com:u/r.git', relayBase: relay }), { ok: true, sink: 'github' });
    assert.deepEqual(assertDataPlaneTarget({ endpoint: 'ssh://backup.example.com/srv/repo.git', relayBase: relay }), { ok: true, sink: 'ssh' });
    assert.deepEqual(assertDataPlaneTarget({ endpoint: 'ssh://10.1.2.3/srv/repo.git', relayBase: relay }), { ok: true, sink: 'lan-git' });
  });
  it('拒绝 relay 端点与非私有 http', () => {
    assert.equal(assertDataPlaneTarget({ endpoint: 'http://43.142.74.71:8787/blob', relayBase: relay }).code, 'DATA_PLANE_POINTS_AT_RELAY');
    assert.equal(assertDataPlaneTarget({ endpoint: 'https://random.example.com/x', relayBase: relay }).code, 'DATA_PLANE_SCHEME_FORBIDDEN');
    assert.equal(assertDataPlaneTarget({ endpoint: 'not a url', relayBase: relay }).code, 'DATA_PLANE_ENDPOINT_INVALID');
  });
});

describe('S0 端口与降级', () => {
  it('无 sink 一律 ARTIFACT_NOT_DELIVERED', async () => {
    const plane = createDataPlane({ relayBase: 'http://43.142.74.71:8787' });
    const pushed = await plane.pushObject({ endpoint: 'git@github.com:u/r.git', ref: ref() });
    assert.equal(pushed.code, 'ARTIFACT_NOT_DELIVERED');
    const fetched = await plane.fetchObject({ endpoint: 'ssh://backup.example.com/repo', ref: ref({ sink: 'ssh' }) });
    assert.equal(fetched.code, 'ARTIFACT_NOT_DELIVERED');
    assert.equal(createNullSink().kind, 'null');
  });
  it('拒绝把数据推向 relay', async () => {
    const plane = createDataPlane({ relayBase: 'http://43.142.74.71:8787' });
    const result = await plane.pushObject({ endpoint: 'http://43.142.74.71:8787/x', ref: ref() });
    assert.equal(result.code, 'DATA_PLANE_POINTS_AT_RELAY');
  });
  it('注入的 sink 被调用且只收到 Ref', async () => {
    const seen = [];
    const plane = createDataPlane({
      relayBase: 'http://43.142.74.71:8787',
      sinks: { github: { kind: 'github', async pushObject(input) { seen.push(input); return { ok: true, ref: input.ref }; }, async fetchObject() { return { ok: true }; } } },
    });
    const result = await plane.pushObject({ endpoint: 'git@github.com:u/r.git', ref: ref(), bytes: undefined });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ref.kind, 'patch');
  });
});
