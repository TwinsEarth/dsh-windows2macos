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
import { planRestore } from '../src/backup/restore.mjs';
import { applyRenumber, planRenumber, RENUMBER_CODES } from '../src/backup/renumber.mjs';
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

/**
 * Gate G3's evidence matrix, said once for every path that can change bytes or claims:
 *
 *   * restore publishes bytes -> the plan validates the log AND the log plus one legal append;
 *   * renumber restructures a log -> the plan carries the same after-append verdict and refuses when it fails;
 *   * verify makes claims about old bytes -> its simulation is labelled `static-prefilter` and its runtime verdict
 *     is labelled `installed-harness`, so a report cannot quote the pre-filter as the gate (G5).
 *
 * These are deliberately assertions about EVIDENCE rather than about damage: the damage cases live above and in
 * `backup-verify`/`fix-renumber`; this suite pins that no restructuring path silently skips the after-append check.
 */
describe('G3 evidence: every restructuring path re-validates the future append', () => {
  it(
    'a restore plan carries the future-append verdict for every candidate (installed-Harness evidence)',
    { skip: findHarnessInstallation() === null ? 'no DeepSeek Harness installation on this machine' : false },
    () => {
      const home = runtimeValidHome();
      const { repo } = repoFor(home.home);
      try {
        const plan = planRestore({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
        assert.equal(plan.ok, true, plan.detail);
        assert.equal(plan.candidates.length, 1);
        assert.equal(plan.candidates[0].validation.future_append, true, 'the appended log was part of the runtime batch, not skipped');
        assert.equal(plan.candidates[0].validation.runtime_verified, true);
        assert.equal(plan.summary.runtime_verified, 1);
      } finally {
        repo.cleanup();
        home.cleanup();
      }
    },
  );

  it('a renumber plan carries the future-append verdict and refuses when the appended log would fail', () => {
    const { dir, cleanup } = tempDir('w2m-g3-renumber-');
    const file = join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, runtimeValidSessionLog(SESSION));
    try {
      const plan = planRenumber({ file, allowStaticValidation: true, harness: null });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.validation.future_append, true, 'the plan result carries the after-append verdict');
      assert.equal(plan.validation.future_append_evidence, 'static-prefilter', 'static evidence is labelled as the pre-filter, never quoted as the gate');
      assert.equal(plan.validation.static_future_append.evidence, 'static-prefilter');

      // `futureAppendCheck` is a documented test seam (production passes nothing): the in-memory renumber result is
      // always dense and legal, so the "appended log would fail" branch cannot be produced by a fixture alone. With
      // the seam the branch is exercised deterministically: the plan must refuse before a byte is written.
      const refused = planRenumber({
        file,
        allowStaticValidation: true,
        harness: null,
        futureAppendCheck: () => ({ ok: false, codes: ['BACKUP_FUTURE_APPEND_SIMULATED'], detail: null, appended_bytes: 0, evidence: 'static-prefilter' }),
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, RENUMBER_CODES.STATIC_REJECTED);
      assert.match(refused.detail, /future-append simulation refused/u);
      assert.equal(refused.new_bytes, null, 'a refusal carries no bytes to write');
      const applied = applyRenumber({ plan: refused });
      assert.equal(applied.ok, false);
      assert.deepEqual(fs.readdirSync(dir), ['session.v4.jsonl.zstd'], 'the refusal left no sibling backup and did not touch the log');
    } finally {
      cleanup();
    }
  });

  it("labels verify's evidence: the after-append simulation is the pre-filter, the runtime verdict is the gate", () => {
    const home = runtimeValidHome();
    const { repo } = repoFor(home.home);
    try {
      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.equal(result.future_append.evidence, 'static-prefilter', 'the future-append block says it is not the gate');
      assert.equal(result.runtime_verified.evidence, 'installed-harness', 'the runtime block names the evidence it would come from');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });
});
