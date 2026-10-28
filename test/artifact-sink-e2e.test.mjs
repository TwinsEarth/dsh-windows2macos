/**
 * A3/S4 end-to-end: no-sink degradation never touches the relay, dir/git sinks round-trip and verify
 * the object hash, and the authorization route refuses traversal/out-of-state targets.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { deliverArtifact, loadArtifactSink } from '../src/agent/artifact-delivery.mjs';
import { createGitSink } from '../src/agent/sinks/git-sink.mjs';
import { registerDataplaneSinkRoute } from '../src/plugin/dataplane-sink-route.mjs';

const task = { taskId: 'task-e2e', machineId: 'm-e2e', kind: 'stdout', bytes: Buffer.from('payload-for-sink\n', 'utf8') };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function mountRoute(stateDir) {
  let handler = null;
  const ctx = { inject(_services, callback) { callback({ connection: { fetch: { register(spec) { handler = spec.fetch; } } } }); } };
  registerDataplaneSinkRoute(ctx, { stateDir: () => stateDir });
  return (method, body) => handler({ method, json: async () => body });
}

describe('data-plane end to end', () => {
  it('no sink: keeps bytes locally and makes zero relay calls', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-e2e-state-'));
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { calls.push(args[0]); throw new Error('network must not be used'); };
    try {
      const result = await deliverArtifact({ ...task, stateDir });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'ARTIFACT_NOT_DELIVERED');
      assert.equal(result.reason, 'DATA_PLANE_SINK_REQUIRED');
      assert.equal(calls.length, 0, 'the relay was never contacted');
      assert.equal(readFileSync(result.local.path, 'utf8'), 'payload-for-sink\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('dir sink: write then read back and verify the hash', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-e2e-state-'));
    const root = mkdtempSync(join(tmpdir(), 'w2m-e2e-dir-'));
    mkdirSync(join(stateDir, 'dataplane'), { recursive: true });
    writeFileSync(join(stateDir, 'dataplane', 'sink.json'), JSON.stringify({ kind: 'dir', root }), 'utf8');
    const result = await deliverArtifact({ ...task, stateDir });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sha256, result.ref?.cipher?.sha256 ?? result.sha256);
    const sink = loadArtifactSink(stateDir);
    assert.equal(sink.kind, 'dir');
    const file = readdirSync(root)[0];
    const objectId = file.replace(/\.json$/, '');
    const read = await sink.readObject({ objectId, expectSha256: result.sha256 });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.bytes.toString('utf8'), 'payload-for-sink\n');
    const tampered = await sink.readObject({ objectId, expectSha256: 'f'.repeat(64) });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.code, 'OBJECT_HASH_MISMATCH');
  });

  it('git sink: writes a commit and reads the same bytes back', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'w2m-e2e-git-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'w2m@test.invalid']);
    git(repo, ['config', 'user.name', 'w2m test']);
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const sink = createGitSink({ root: repo });
    const result = await deliverArtifact({ ...task, stateDir: mkdtempSync(join(tmpdir(), 'w2m-e2e-state-')), sink });
    assert.equal(result.ok, true, JSON.stringify(result));
    const objectId = result.ref?.object_id ?? readdirSync(repo).find((file) => /^[0-9a-f]{32,64}\.json$/.test(file)).replace(/\\.json$/, '');
    const read = await sink.readObject({ objectId, expectSha256: result.sha256 });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.bytes.toString('utf8'), 'payload-for-sink\n');
    assert.equal(git(repo, ['log', '--oneline']).split('\n').length >= 2, true, 'a commit was created');
  });

  it('route refuses traversal, out-of-state roots, ssh relative dirs, and credentials', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-e2e-state-'));
    const outside = mkdtempSync(join(tmpdir(), 'w2m-e2e-outside-'));
    mkdirSync(join(stateDir, 'inside'), { recursive: true });
    const call = mountRoute(stateDir);
    const cases = [
      [{ kind: 'dir', root: 'relative/../../etc' }, 'SINK_ROOT_INVALID'],
      [{ kind: 'dir', root: join(stateDir, 'inside') }, 'SINK_ROOT_INSIDE_STATE'],
      [{ kind: 'dir', root: join(outside, '..', 'does-not-exist') }, 'SINK_ROOT_NOT_FOUND'],
      [{ kind: 'ssh', host: 'example.test', user: 'w2m', dir: '../escape' }, 'SINK_SSH_DIR_INVALID'],
      [{ kind: 'dir', root: outside, token: 'x' }, 'SINK_CREDENTIALS_NOT_ACCEPTED'],
    ];
    for (const [body, code] of cases) {
      const response = await call('POST', body);
      assert.equal(response.status, 400, code);
      assert.equal((await response.json()).code, code);
    }
    // A `..` segment that resolves to a real directory outside the state dir is canonicalized, not
    // stored verbatim: the saved config names the resolved path.
    const accepted = await call('POST', { kind: 'dir', root: resolve(outside, '.', '..', outside.split(/[\\/]/).pop()) });
    const body = await accepted.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.root, resolve(outside));
  });
});
