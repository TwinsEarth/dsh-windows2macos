/**
 * D3: git and ssh sinks behave like the dir sink (object-id addressed, hash verified, no plaintext).
 *
 * The git sink is exercised against a real temporary repository; the ssh sink is exercised against
 * an injected transport so the assertions can cover argv safety and hash checks without a server.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createGitSink } from '../src/agent/sinks/git-sink.mjs';
import { createSshSink } from '../src/agent/sinks/ssh-sink.mjs';

const fixtures = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-sink-'));
  fixtures.push(dir);
  return dir;
};
after(() => {
  for (const dir of fixtures) {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* not a repo */ }
  }
});
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ID = 'a'.repeat(32);
const BODY = Buffer.from('sealed-artifact-bytes', 'utf8');

function gitRepo() {
  const root = fixture();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'w2m@test.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'w2m test'], { cwd: root });
  return root;
}

describe('git sink', () => {
  it('writes, commits, reads back and verifies the hash', async () => {
    const root = gitRepo();
    writeFileSync(join(root, 'README.md'), 'test\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });
    const sink = createGitSink({ root });
    const written = await sink.writeObject({ objectId: ID, body: BODY });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(written.sha256, sha256(BODY));
    const log = execFileSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' });
    assert.match(log, /w2m artifact/);
    const read = await sink.readObject({ objectId: ID, expectSha256: sha256(BODY) });
    assert.equal(read.ok, true);
    assert.equal(read.bytes.toString('utf8'), BODY.toString('utf8'));
    assert.equal((await sink.listObjects()).includes(ID), true);
    const mismatch = await sink.readObject({ objectId: ID, expectSha256: 'b'.repeat(64) });
    assert.equal(mismatch.code, 'OBJECT_HASH_MISMATCH');
  });
});

describe('ssh sink', () => {
  function memoryTransport() {
    const store = new Map();
    const commands = [];
    const run = (args, input) => {
      const remote = args[args.length - 1];
      commands.push(remote);
      if (remote.includes(' && cat > ')) {
        const final = (remote.match(/\s(\S+)$/) ?? [])[1] ?? '';
        store.set(final, Buffer.from(input));
        return { ok: true, stdout: Buffer.alloc(0) };
      }
      if (remote.startsWith('cat ')) {
        const key = remote.slice(4).trim();
        if (!store.has(key)) return { ok: false, code: 'SSH_COMMAND_FAILED' };
        return { ok: true, stdout: store.get(key) };
      }
      if (remote.startsWith('ls -1 ')) {
        const prefix = remote.slice(6).trim().replace(/\/$/, '') + '/';
        return { ok: true, stdout: Buffer.from([...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).join('\n'), 'utf8') };
      }
      if (remote.startsWith('rm -f ')) { store.delete(remote.slice(6).trim()); return { ok: true, stdout: Buffer.alloc(0) }; }
      return { ok: false, code: 'SSH_COMMAND_FAILED' };
    };
    return { run, store, commands };
  }

  it('round-trips through a user-owned host and verifies hashes', async () => {
    const { run, commands } = memoryTransport();
    const sink = createSshSink({ host: 'git.example', user: 'ops', dir: '/srv/w2m/artifacts', run });
    const written = await sink.writeObject({ objectId: ID, body: BODY });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(written.sha256, sha256(BODY));
    assert.match(commands[0], /mkdir -p \/srv\/w2m\/artifacts/);
    const read = await sink.readObject({ objectId: ID, expectSha256: sha256(BODY) });
    assert.equal(read.ok, true);
    assert.equal(read.bytes.toString('utf8'), BODY.toString('utf8'));
    assert.equal((await sink.listObjects()).includes(ID), true);
    assert.equal((await sink.removeObject(ID)).ok, true);
    assert.equal((await sink.listObjects()).length, 0);
    const mismatch = await sink.readObject({ objectId: ID });
    assert.equal(mismatch.ok, false);
  });

  it('rejects a host or directory that could inject shell syntax', () => {
    assert.throws(() => createSshSink({ host: 'x;rm -rf /', user: 'ops', dir: '/srv/w2m' }), /SSH_SINK_HOST_INVALID/);
    assert.throws(() => createSshSink({ host: 'git.example', user: 'ops', dir: '/srv/w2m;rm' }), /SSH_SINK_DIR_INVALID/);
    assert.throws(() => createSshSink({ host: 'git.example', user: 'ops', dir: '/srv/../etc' }), /SSH_SINK_DIR_INVALID/);
  });
});
