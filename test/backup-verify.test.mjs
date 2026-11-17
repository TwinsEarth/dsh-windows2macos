/**
 * Full verification: every claim of the repository — blocks decrypt, bytes hash, index and snapshot directories
 * agree, old-version records still name existing blocks — and the future-append simulation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { runBackup } from '../src/backup/engine.mjs';
import { verifyRepo } from '../src/backup/verify.mjs';
import { appendLegalEvent, countLogRows, futureAppendVerdict } from '../src/backup/future-append.mjs';
import { findHarnessInstallation } from '../src/backup/runtime-validate.mjs';
import { repoPaths } from '../src/backup/layout.mjs';
import { header, framesFor, makeHome, registryDocument, runtimeValidHome, runtimeValidSessionLog, tempDir } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const SESSION = 'session-aaaaaaaa-0001';
const WORKSPACE = '--E-GPT--';

function repoFor(home, options = {}) {
  const repo = tempDir('w2m-verify-repo-');
  const run = runBackup({ root: repo.dir, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, ...options });
  assert.equal(run.ok, true, run.detail);
  return { repo, run };
}

function verify(repoDir, homeDir) {
  return verifyRepo({ root: repoDir, dshHome: homeDir, password: PASSWORD, platform: 'linux', machineKey: false });
}

/** The object files of a repository, flattened. */
function objects(repoDir) {
  const root = join(repoDir, 'objects');
  const files = [];
  for (const prefix of fs.readdirSync(root)) {
    for (const name of fs.readdirSync(join(root, prefix))) files.push(join(root, prefix, name));
  }
  return files;
}

describe('verify: a healthy repository', () => {
  it('re-hashes every snapshot and reports the counts it actually walked', () => {
    const home = runtimeValidHome();
    const { repo, run } = repoFor(home.home);
    try {
      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.equal(result.counts.snapshots, 1);
      assert.equal(result.counts.files, 1);
      assert.equal(result.counts.blocks, run.blocks_total);
      assert.equal(result.future_append.checked, 1);
      assert.equal(result.future_append.failed, 0);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });
});

describe('G3: only raw bytes, plus a simulated next append', () => {
  it('counts rows without rewriting, appends one legal frame, and keeps the prefix intact', () => {
    const log = runtimeValidSessionLog(SESSION);
    const counted = countLogRows(log);
    assert.equal(counted.frames, 3, 'framesFor writes one frame per JSON line');
    assert.equal(counted.rows, 3, 'one header plus two events');
    assert.equal(counted.torn, false);

    const appended = appendLegalEvent(log);
    assert.ok(appended.subarray(0, log.length).equals(log), 'the original bytes are a prefix, untouched');
    assert.ok(appended.length > log.length);
    const verdict = futureAppendVerdict(log);
    assert.equal(verdict.ok, true, verdict.codes.join(','));
  });

  it('reports a broken log as failing the append simulation without touching it', () => {
    const broken = framesFor([
      header(SESSION),
      { type: 'turn/start', seq: 7, time: 1, data: { turn: 1 } },
    ]);
    const verdict = futureAppendVerdict(broken);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.codes.length > 0);
  });

  it(
    'asks the installed Harness about the appended artifact too, with --runtime',
    { skip: findHarnessInstallation() === null ? 'no DeepSeek Harness installation on this machine' : false },
    () => {
      const home = runtimeValidHome();
      const { repo } = repoFor(home.home);
      try {
        const result = verifyRepo({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false, runtime: true });
        assert.equal(result.ok, true, result.problems.map((problem) => problem.code + ':' + problem.detail).join('; '));
        assert.equal(result.runtime_verified.checked, 1);
        assert.equal(result.runtime_verified.failed, 0);
      } finally {
        repo.cleanup();
        home.cleanup();
      }
    },
  );
});

describe('verify: damage is named, not averaged away', () => {
  it('names a missing object', () => {
    const home = runtimeValidHome();
    const { repo } = repoFor(home.home);
    try {
      const [file] = objects(repo.dir);
      fs.rmSync(file);
      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, false);
      assert.equal(result.problems[0].code, 'BACKUP_OBJECT_MISSING');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('names a corrupted object (authenticated encryption, not a checksum guess)', () => {
    const home = runtimeValidHome();
    const { repo } = repoFor(home.home);
    try {
      const [file] = objects(repo.dir);
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 1] ^= 0x01;
      fs.writeFileSync(file, bytes);
      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, false);
      assert.equal(result.problems[0].code, 'BACKUP_DECRYPT_AUTH_FAILED');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('names a snapshot that the index does not list', () => {
    const home = runtimeValidHome();
    const { repo } = repoFor(home.home);
    try {
      const paths = repoPaths(repo.dir);
      fs.writeFileSync(paths.index, '');
      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((problem) => problem.code === 'BACKUP_INDEX_MISMATCH'), JSON.stringify(result.problems));
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('fails the future-append simulation for a log a hand-written edit would break', () => {
    // The doctor refuses this log too; the point of the simulation is that verify reports it as a *future* failure
    // of a log the backup accepted, which is exactly the class that broke the recovery drill.
    const home = makeHome({
      sessions: [{ workspace: WORKSPACE, id: SESSION }],
      registry: registryDocument({ sessionIds: [SESSION] }),
    });
    fs.writeFileSync(
      join(home.home, 'sessions', WORKSPACE, SESSION, 'session.v4.jsonl.zstd'),
      framesFor([
        header(SESSION),
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'user/message',
          seq: 1,
          time: 2,
          surfaceOp: 'append',
          data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user' },
        },
        { type: 'system/message', seq: 2, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'late' }] } },
      ]),
    );
    const { repo } = repoFor(home.home);
    try {
      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, false);
      assert.equal(result.problems[0].code, 'BACKUP_FUTURE_APPEND_FAILED');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('names a block referenced only by an old version record', () => {
    const home = makeHome({
      sessions: [{ workspace: WORKSPACE, id: SESSION }],
      registry: registryDocument({ sessionIds: [SESSION] }),
    });
    const first = repoFor(home.home);
    try {
      // Change the log so the next backup rotates the previous version into `old/`.
      fs.writeFileSync(join(home.home, 'sessions', WORKSPACE, SESSION, 'session.v4.jsonl.zstd'), runtimeValidSessionLog(SESSION));
      const second = runBackup({ root: first.repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(second.ok, true, second.detail);
      assert.equal(second.rotated, 1);

      const paths = repoPaths(first.repo.dir);
      const oldFiles = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else oldFiles.push(full);
        }
      };
      walk(paths.old);
      assert.equal(oldFiles.length, 1);
      const record = JSON.parse(fs.readFileSync(oldFiles[0], 'utf8'));
      const current = JSON.parse(fs.readFileSync(join(paths.snapshots, second.snapshot_id, 'manifest.json'), 'utf8'));
      const currentBlocks = new Set(current.files.flatMap((file) => file.blocks.map((block) => block.sha256)));
      const orphan = record.blocks.find((block) => !currentBlocks.has(block.sha256));
      assert.ok(orphan !== undefined, 'the rotated version must reference a block the new snapshot does not');

      fs.rmSync(join(paths.objects, orphan.sha256.slice(0, 2), orphan.sha256));
      const result = verify(first.repo.dir, home.home);
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((problem) => problem.code === 'BACKUP_OLD_RECORD_BLOCK_MISSING'), JSON.stringify(result.problems));
    } finally {
      first.repo.cleanup();
      home.cleanup();
    }
  });
});
