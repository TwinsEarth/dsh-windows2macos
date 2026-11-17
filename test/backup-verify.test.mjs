/**
 * Full verification: every claim of the repository — blocks decrypt, bytes hash, index and snapshot directories
 * agree, old-version records still name existing blocks — and the future-append simulation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { runBackup } from '../src/backup/engine.mjs';
import { main } from '../src/backup/cli.mjs';
import { verifyRepo } from '../src/backup/verify.mjs';
import { planRestore } from '../src/backup/restore.mjs';
import { applyRenumber, planRenumber, RENUMBER_CODES } from '../src/backup/renumber.mjs';
import { appendLegalEvent, countLogRows, futureAppendVerdict } from '../src/backup/future-append.mjs';
import { findHarnessInstallation } from '../src/backup/runtime-validate.mjs';
import {
  buildRuntimeVerdictRecord,
  createRuntimeVerdictStore,
  readBackupState,
  RUNTIME_VERDICT_EVIDENCE,
  runtimeVerdictStaleness,
  writeBackupState,
} from '../src/backup/runtime-verdict.mjs';
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
      assert.equal(result.counts.files, run.files ?? run.counts?.files ?? 1, 'the manifest file count, which now also includes registry/config/state entries');
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

describe('G5: the cached runtime verdict is a record with a timestamp, not an inference', () => {
  /** A real-shaped verify result; nothing here spawns the runtime. */
  function verifyResult(overrides = {}) {
    return {
      ok: true,
      counts: { snapshots: 2, files: 3, blocks: 4, bytes: 5, old: 0, current: 0 },
      runtime_verified: { checked: 2, failed: 0, evidence: 'installed-harness' },
      future_append: { checked: 2, failed: 0, evidence: 'static-prefilter' },
      problems: [],
      duration_ms: 42,
      ...overrides,
    };
  }

  it('copies the counts, deduplicates the reason codes, and always labels the evidence installed-harness', () => {
    const record = buildRuntimeVerdictRecord({
      verifyResult: verifyResult({
        ok: false,
        runtime_verified: { checked: 2, failed: 1 },
        problems: [{ code: 'BACKUP_RUNTIME_REJECTED' }, { code: 'BACKUP_RUNTIME_REJECTED' }, { code: 'BACKUP_FUTURE_APPEND_FAILED' }],
      }),
      startedAt: Date.UTC(2026, 10, 17, 8, 0, 0),
      finishedAt: Date.UTC(2026, 10, 17, 8, 0, 42),
      trigger: 'nightly',
    });
    assert.equal(record.evidence, RUNTIME_VERDICT_EVIDENCE);
    assert.equal(record.evidence, 'installed-harness');
    assert.equal(record.ok, false);
    assert.equal(record.checked, 2);
    assert.equal(record.failed, 1);
    assert.equal(record.snapshots, 2);
    assert.deepEqual(record.reason_codes, ['BACKUP_RUNTIME_REJECTED', 'BACKUP_FUTURE_APPEND_FAILED']);
    assert.equal(record.started_at, '2026-11-17T08:00:00.000Z');
    assert.equal(record.finished_at, '2026-11-17T08:00:42.000Z');
    assert.equal(record.trigger, 'nightly');
  });

  it('marks a record stale only after the 24 h window, and treats an unreadable timestamp as stale', () => {
    const finishedAt = Date.UTC(2026, 10, 17, 8, 0, 0);
    const record = buildRuntimeVerdictRecord({ verifyResult: verifyResult(), startedAt: finishedAt, finishedAt });
    const fresh = runtimeVerdictStaleness(record, { nowMs: finishedAt + 23 * 60 * 60 * 1000 });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.age_ms, 23 * 60 * 60 * 1000);
    const stale = runtimeVerdictStaleness(record, { nowMs: finishedAt + 25 * 60 * 60 * 1000 });
    assert.equal(stale.stale, true);
    assert.equal(runtimeVerdictStaleness(null, { nowMs: finishedAt }).stale, true);
    assert.equal(runtimeVerdictStaleness({ finished_at: 'not-a-date' }, { nowMs: finishedAt }).stale, true);
    assert.equal(runtimeVerdictStaleness(record, { nowMs: finishedAt + 2_000, staleAfterMs: 1 }).stale, true);
  });

  it('persists the record in the plugin state dir and serves it from cache without calling the verifier', () => {
    const { dir, cleanup } = tempDir('w2m-runtime-verdict-');
    const home = join(dir, 'home');
    try {
      let verifyCalls = 0;
      const store = createRuntimeVerdictStore({
        dshHome: home,
        verify: () => {
          verifyCalls += 1;
          return verifyResult();
        },
        now: () => Date.UTC(2026, 10, 17, 9, 0, 0),
      });
      const empty = store.cached();
      assert.equal(empty.cached, true);
      assert.equal(empty.record, null);
      assert.equal(empty.stale, true, 'no record is not a fresh record');
      assert.equal(store.stateFile, join(home, 'xclient', 'w2m-backup', 'state.json'));

      const outcome = store.run({ trigger: 'nightly' });
      return outcome.then(async (ran) => {
        assert.equal(verifyCalls, 1);
        assert.equal(ran.record.evidence, 'installed-harness');
        assert.equal(ran.persisted, true);
        const loaded = readBackupState(home);
        assert.equal(loaded.ok, true);
        assert.deepEqual(loaded.state.last_runtime_verify, ran.record, 'the cached record is the persisted record');
        assert.equal(loaded.state.last_runtime_verify_run.trigger, 'nightly');
        const cached = store.cached();
        assert.deepEqual(cached.record, ran.record);
        assert.equal(cached.stale, false);
        assert.equal(verifyCalls, 1, 'reading the cache never spawns the verifier');
      });
    } finally {
      cleanup();
    }
  });

  it('runs one in-flight verdict at a time, and persists a failed record instead of throwing', async () => {
    const { dir, cleanup } = tempDir('w2m-runtime-verdict-fail-');
    const home = join(dir, 'home');
    try {
      let verifyCalls = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const store = createRuntimeVerdictStore({
        dshHome: home,
        verify: async () => {
          verifyCalls += 1;
          await gate;
          return verifyResult({ ok: false, runtime_verified: { checked: 1, failed: 1 }, problems: [{ code: 'BACKUP_RUNTIME_REJECTED' }] });
        },
      });
      const first = store.run({ trigger: 'nightly' });
      const second = store.run({ trigger: 'manual-route' });
      assert.equal(first, second, 'a second request joins the in-flight verdict');
      release();
      const outcome = await first;
      assert.equal(verifyCalls, 1, 'the Harness is spawned once for two concurrent requests');
      assert.equal(outcome.record.ok, false);
      assert.equal(readBackupState(home).state.last_runtime_verify.ok, false, 'a failed verdict is still persisted');

      const throwing = createRuntimeVerdictStore({
        dshHome: home,
        verify: () => {
          throw new Error('the runtime is not installed');
        },
      });
      const thrownOutcome = await throwing.run({ trigger: 'manual-route' });
      assert.equal(thrownOutcome.ran, true);
      assert.equal(thrownOutcome.record.ok, false);
      assert.equal(thrownOutcome.record.evidence, 'installed-harness');
      assert.ok(thrownOutcome.record.reason_codes.includes('BACKUP_RUNTIME_UNAVAILABLE'));
      assert.equal(readBackupState(home).state.last_runtime_verify.runtime_available, false);
      // A caller can seed a record directly (the CLI's manual run does the same through writeBackupState).
      const seeded = writeBackupState(home, { last_runtime_verify: buildRuntimeVerdictRecord({ verifyResult: verifyResult() }) });
      assert.equal(seeded.ok, true);
      assert.equal(readBackupState(home).state.last_runtime_verify.ok, true);
    } finally {
      cleanup();
    }
  });

  it(
    'CLI run --runtime-verify runs one manual verdict after the backup and persists it (installed Harness)',
    { skip: findHarnessInstallation() === null ? 'no DeepSeek Harness installation on this machine' : false },
    () => {
      const home = runtimeValidHome();
      const { dir, cleanup } = tempDir('w2m-cli-runtime-verify-');
      try {
        const stdout = [];
        const stderr = [];
        const code = main(
          ['run', '--dsh-home', home.home, '--backup-dir', join(dir, 'repo'), '--runtime-verify', '--json'],
          { env: { ...process.env, DSH_HOME: home.home }, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
        );
        assert.equal(code, 0, stderr.join('\n'));
        const payload = JSON.parse(stdout.join('\n'));
        assert.equal(payload.ok, true, payload.detail);
        assert.equal(payload.runtime_verify.evidence, 'installed-harness');
        assert.equal(payload.runtime_verify.ok, true);
        assert.equal(payload.runtime_verify.checked, 1);
        assert.equal(payload.runtime_verify_persisted, true);
        const loaded = readBackupState(home.home);
        assert.deepEqual(loaded.state.last_runtime_verify, payload.runtime_verify, 'the manual verdict is the cached record');
      } finally {
        cleanup();
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

      // `futureAppendCheck` is a documented test seam, and the branch it drives is unreachable by construction for
      // `renumberBuffer`'s canonical output: dense seqs, header alone in frame 1, one `permission/preset` append with
      // no surface/reference -- the doctor refuses nothing that canonical result plus that append adds (the full
      // argument and the machine-check live in `docs/BACKUP-DESIGN.md` §20.5 and `test/fix-renumber.test.mjs`).
      // The seam exercises the call site deterministically: the plan must refuse before a byte is written.
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

  it('verifies an unencrypted repository with no credential at all (the default mode)', () => {
    const home = runtimeValidHome();
    const { dir, cleanup } = tempDir('w2m-verify-none-');
    try {
      const run = runBackup({ root: join(dir, 'repo'), dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(run.ok, true, run.detail);
      assert.equal(run.encryption, 'none');
      // No password and no machine key: `none` means the key is in clear in keys.json, so verification needs neither.
      const result = verifyRepo({ root: join(dir, 'repo'), dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.equal(result.counts.snapshots, 1);
      assert.ok(result.counts.files >= 1);
    } finally {
      cleanup();
      home.cleanup();
    }
  });
});

/**
 * The `oldFormat: 'full'` half of verify: a version record that carries `full_copy` promises its bytes are
 * recoverable without `objects/`, and verify now decrypts those copies instead of trusting the field.
 */
function changeSessionLog(homeDir) {
  fs.writeFileSync(
    join(homeDir, 'sessions', WORKSPACE, SESSION, 'session.v4.jsonl.zstd'),
    framesFor([
      header(SESSION),
      { type: 'turn/start', seq: 0, time: 1794842804375, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1794842804377, data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  );
}

/** Every regular file under `<root>/old`, recursively. */
function oldVersionFiles(root) {
  const base = join(root, 'old');
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(base);
  return out.sort();
}

/** A sealed repository holding exactly one rotated `full` version (a record plus its sealed `.json.enc`). */
function repoWithFullCopy(homeDir) {
  const first = repoFor(homeDir);
  changeSessionLog(homeDir);
  const second = runBackup({
    root: first.repo.dir,
    dshHome: homeDir,
    password: PASSWORD,
    platform: 'linux',
    machineKey: false,
    oldFormat: 'full',
  });
  assert.equal(second.ok, true, second.detail);
  assert.equal(second.rotated, 1, 'the fixture must rotate the previous version into old/');
  return first.repo;
}

describe('verify: sealed old/ full copies are decrypted, not trusted', () => {
  it('reports every full copy as ok on a healthy repository, with no problem added', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.ok(result.old_copies.checked > 0, 'the fixture must hold at least one record with a full copy');
      assert.equal(result.old_copies.ok, result.old_copies.checked, 'every checked copy decrypted to its record');
      assert.equal(result.old_copies.failed, 0);
      assert.equal(result.old_copies.missing, 0);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('reports a corrupt .enc as failed with the named code and the record in the detail', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      const enc = oldVersionFiles(repo.dir).find((file) => file.endsWith('.json.enc'));
      assert.ok(enc, 'the fixture must hold the sealed copy');
      const bytes = fs.readFileSync(enc);
      bytes[bytes.length - 1] ^= 0x01;
      fs.writeFileSync(enc, bytes);

      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, false);
      assert.equal(result.old_copies.checked, 1);
      assert.equal(result.old_copies.failed, 1);
      assert.equal(result.old_copies.missing, 0);
      const problem = result.problems.find((row) => row.code === 'BACKUP_VERIFY_OLD_COPY_FAILED');
      assert.ok(problem, JSON.stringify(result.problems));
      assert.match(problem.detail, /BACKUP_DECRYPT_AUTH_FAILED|does not decrypt/u);
      assert.equal(problem.file.endsWith('.json'), true, 'the problem names the version record');
      assert.ok(problem.detail.includes(problem.file), 'the detail names the record it belongs to');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('reports a deleted .enc as missing with the _MISSING code', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    try {
      const enc = oldVersionFiles(repo.dir).find((file) => file.endsWith('.json.enc'));
      fs.rmSync(enc);
      const result = verify(repo.dir, home.home);
      assert.equal(result.ok, false);
      assert.equal(result.old_copies.checked, 1);
      assert.equal(result.old_copies.missing, 1);
      assert.equal(result.old_copies.failed, 0);
      const problem = result.problems.find((row) => row.code === 'BACKUP_VERIFY_OLD_COPY_MISSING');
      assert.ok(problem, JSON.stringify(result.problems));
      assert.ok(problem.detail.includes(problem.file), 'the detail names the record it belongs to');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('leaves the counters untouched for a record without a full copy', () => {
    const home = runtimeValidHome();
    const first = repoFor(home.home);
    try {
      changeSessionLog(home.home);
      const second = runBackup({
        root: first.repo.dir,
        dshHome: home.home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
      });
      assert.equal(second.ok, true, second.detail);
      assert.equal(second.rotated, 1);
      const recordFile = oldVersionFiles(first.repo.dir).find((file) => file.endsWith('.json'));
      assert.equal(JSON.parse(fs.readFileSync(recordFile, 'utf8')).full_copy, undefined, 'the default mode writes no copy');
      const result = verify(first.repo.dir, home.home);
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.deepEqual(result.old_copies, { checked: 0, ok: 0, failed: 0, missing: 0 });
    } finally {
      first.repo.cleanup();
      home.cleanup();
    }
  });

  it('decrypts full copies in an unencrypted repository (the open envelope supplies the DEK)', () => {
    const home = runtimeValidHome();
    const { dir, cleanup } = tempDir('w2m-verify-old-copies-none-');
    try {
      const root = join(dir, 'repo');
      const first = runBackup({ root, dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(first.ok, true, first.detail);
      assert.equal(first.encryption, 'none');
      changeSessionLog(home.home);
      const second = runBackup({ root, dshHome: home.home, platform: 'linux', machineKey: false, oldFormat: 'full' });
      assert.equal(second.ok, true, second.detail);
      // No password and no machine key: `none` means keys.json carries the DEK in clear, so verify needs neither.
      const result = verifyRepo({ root, dshHome: home.home, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true, result.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; '));
      assert.ok(result.old_copies.checked > 0);
      assert.equal(result.old_copies.ok, result.old_copies.checked);
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('adds the old copies line to the human report, the block to --json, and follows the exit code', () => {
    const home = runtimeValidHome();
    const repo = repoWithFullCopy(home.home);
    const capture = () => {
      const lines = [];
      return { lines, io: { stdout: (text) => lines.push(text), stderr: (text) => lines.push(text), env: {}, password: PASSWORD } };
    };
    try {
      const json = capture();
      const code = main(['verify', '--backup-dir', repo.dir, '--dsh-home', home.home, '--no-machine-key', '--json'], json.io);
      assert.equal(code, 0, json.lines.join('\n'));
      const payload = JSON.parse(json.lines.join('\n'));
      assert.equal(payload.ok, true, payload.detail);
      assert.ok(payload.old_copies.checked > 0);
      assert.deepEqual(Object.keys(payload.old_copies).sort(), ['checked', 'failed', 'missing', 'ok']);

      const human = capture();
      assert.equal(main(['verify', '--backup-dir', repo.dir, '--dsh-home', home.home, '--no-machine-key'], human.io), 0);
      assert.match(human.lines.join('\n'), /old copies\s+: 1 ok \/ 0 failed \/ 0 missing/u);

      const enc = oldVersionFiles(repo.dir).find((file) => file.endsWith('.json.enc'));
      fs.rmSync(enc);
      const missingJson = capture();
      const missingCode = main(['verify', '--backup-dir', repo.dir, '--dsh-home', home.home, '--no-machine-key', '--json'], missingJson.io);
      assert.equal(missingCode, 1, 'a missing copy is a verification failure');
      const missingPayload = JSON.parse(missingJson.lines.join('\n'));
      assert.equal(missingPayload.old_copies.missing, 1);
      assert.ok(missingPayload.problems.some((problem) => problem.code === 'BACKUP_VERIFY_OLD_COPY_MISSING'));
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });
});