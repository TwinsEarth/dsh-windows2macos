/**
 * Restore: plan first, then apply — and the four gates from the recovery retrospective.
 *
 * What these tests are allowed to assume: `runtimeValidSessionLog()` produces a log the **installed Harness** accepts
 * (verified in `backup-runtime.test.mjs`). What they must pin here: restore refuses anything the gates refuse, writes
 * nothing before the plan passes, copies what it will replace, and leaves the registry in a state that reads back.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { runBackup } from '../src/backup/engine.mjs';
import { applyRestore, planRestore } from '../src/backup/restore.mjs';
import { findHarnessInstallation } from '../src/backup/runtime-validate.mjs';
import {
  makeHome,
  registryDocument,
  runtimeValidHome,
  runtimeValidSessionLog,
  sessionLog,
  tempDir,
} from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const SESSION = 'session-aaaaaaaa-0001';
const HARNESS = findHarnessInstallation();

/** Run one backup of `home` into a new temporary repository. */
function repoFor(home) {
  const repo = tempDir('w2m-restore-repo-');
  const run = runBackup({ root: repo.dir, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false });
  assert.equal(run.ok, true, run.detail);
  return repo;
}

/** A home whose registry knows the fixture workspace. */
function emptyTargetHome(registry = registryDocument({ sessionIds: [] })) {
  const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: SESSION }], registry });
  fs.rmSync(join(home.home, 'sessions', '--E-GPT--', SESSION), { recursive: true, force: true });
  return home;
}

/** The restored log inside a home. */
function logPath(homeDir, sessionId = SESSION) {
  return join(homeDir, 'sessions', '--E-GPT--', sessionId, 'session.v4.jsonl.zstd');
}

describe('restore: the plan refuses what the gates refuse', () => {
  it('refuses a log the installed Harness rejects (G1+G5), and says which gate spoke', () => {
    const formatOnly = makeHome({
      sessions: [{ workspace: '--E-GPT--', id: SESSION }],
      registry: registryDocument({ sessionIds: [SESSION] }),
    });
    const repo = repoFor(formatOnly.home);
    const target = emptyTargetHome();
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(plan.ok, false);
      const expected = HARNESS === null ? ['BACKUP_RUNTIME_UNAVAILABLE', 'BACKUP_RUNTIME_REJECTED'] : ['BACKUP_RUNTIME_REJECTED'];
      assert.ok(expected.includes(plan.reason_code), `${plan.reason_code}: ${plan.detail}`);

      const allowed = planRestore({
        root: repo.dir,
        dshHome: target.home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        allowStaticValidation: true,
      });
      assert.equal(allowed.ok, true, allowed.detail);
      assert.equal(allowed.summary.sessions, 1);
    } finally {
      repo.cleanup();
      formatOnly.cleanup();
      target.cleanup();
    }
  });

  it('refuses a workspace this home does not register, unless an explicit path is supplied', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const other = emptyTargetHome(registryDocument({ workspace: 'E:\\ToFuture', workspaceId: 'w2', sessionIds: [] }));
    try {
      const refused = planRestore({ root: repo.dir, dshHome: other.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, 'BACKUP_REGISTRY_WRITE_FAILED');
      assert.match(refused.detail, /does not register/u);

      const attached = planRestore({
        root: repo.dir,
        dshHome: other.home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        workspacePath: 'E:\\GPT',
      });
      assert.equal(attached.ok, true, attached.detail);
      assert.equal(attached.registry[0].plan.workspace_id, 'restored-e-gpt');
    } finally {
      repo.cleanup();
      source.cleanup();
      other.cleanup();
    }
  });
});

describe('restore: the round trip', () => {
  it('restores the original bytes, registers the session, and writes nothing on a dry run', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const target = emptyTargetHome();
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.summary.conflicts, 0);
      assert.equal(plan.summary.new, 1);
      assert.equal(plan.summary.runtime_verified, HARNESS === null ? 0 : 1);

      const dry = applyRestore({ plan, dshHome: target.home, dryRun: true });
      assert.equal(dry.ok, true);
      assert.equal(dry.dry_run, true);
      assert.equal(fs.existsSync(logPath(target.home)), false, 'a dry run must not write the session');

      const applied = applyRestore({ plan, dshHome: target.home });
      assert.equal(applied.ok, true, applied.detail);
      assert.equal(applied.restored.length, 1);
      const written = fs.readFileSync(logPath(target.home));
      assert.ok(written.equals(runtimeValidSessionLog(SESSION)), 'the restored bytes must equal the backed-up bytes');
      assert.equal(fs.existsSync(join(target.home, 'sessions', '.w2m-restore-backups')), true);

      const registry = JSON.parse(fs.readFileSync(join(target.home, 'storages', 'workspace.json'), 'utf8'));
      assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [SESSION]);
      assert.equal(applied.registry[0].verified, true);
    } finally {
      repo.cleanup();
      source.cleanup();
      target.cleanup();
    }
  });

  it('keeps a different existing log: backed up first, then replaced', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const target = emptyTargetHome();
    const oldBytes = sessionLog(SESSION); // format-only, and different from the runtime-valid source
    fs.mkdirSync(join(target.home, 'sessions', '--E-GPT--', SESSION), { recursive: true });
    fs.writeFileSync(logPath(target.home), oldBytes);
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.summary.conflicts, 1);
      assert.equal(plan.candidates[0].resolution, 'backup-and-replace');

      const applied = applyRestore({ plan, dshHome: target.home });
      assert.equal(applied.ok, true, applied.detail);
      assert.ok(fs.readFileSync(logPath(target.home)).equals(runtimeValidSessionLog(SESSION)));
      const copies = fs.readdirSync(plan.pre_restore.dir, { recursive: true }).map(String);
      assert.ok(copies.some((name) => name.includes('session.v4.jsonl.zstd')), `expected a pre-restore copy, got ${copies.join(', ')}`);
      const backupDir = join(plan.pre_restore.dir, 'sessions', '--E-GPT--', SESSION, 'session.v4.jsonl.zstd');
      assert.ok(fs.readFileSync(backupDir).equals(oldBytes), 'the replaced log must be recoverable');
    } finally {
      repo.cleanup();
      source.cleanup();
      target.cleanup();
    }
  });

  it('--keep-both leaves the existing log alone and writes the restored one beside it', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const target = emptyTargetHome();
    const oldBytes = sessionLog(SESSION);
    fs.mkdirSync(join(target.home, 'sessions', '--E-GPT--', SESSION), { recursive: true });
    fs.writeFileSync(logPath(target.home), oldBytes);
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false, keepBoth: true });
      assert.equal(plan.candidates[0].resolution, 'keep-both');
      const applied = applyRestore({ plan, dshHome: target.home });
      assert.equal(applied.ok, true, applied.detail);
      assert.ok(fs.readFileSync(logPath(target.home)).equals(oldBytes), 'the original must be untouched');
      const restored = fs.readdirSync(join(target.home, 'sessions', '--E-GPT--', SESSION)).filter((name) => name.includes('.restored-'));
      assert.equal(restored.length, 1);
      assert.ok(fs.readFileSync(join(target.home, 'sessions', '--E-GPT--', SESSION, restored[0])).equals(runtimeValidSessionLog(SESSION)));
    } finally {
      repo.cleanup();
      source.cleanup();
      target.cleanup();
    }
  });

  it('refuses a plan whose repository bytes no longer match the manifest', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const target = emptyTargetHome();
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(plan.ok, true, plan.detail);
      // Corrupt the object the plan is about to restore from.
      const objectDir = join(repo.dir, 'objects');
      const prefixes = fs.readdirSync(objectDir);
      assert.ok(prefixes.length > 0);
      const [prefix] = prefixes;
      const [object] = fs.readdirSync(join(objectDir, prefix));
      const file = join(objectDir, prefix, object);
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 1] ^= 0xff;
      fs.writeFileSync(file, bytes);

      const after = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(after.ok, false);
      assert.ok(['BACKUP_DECRYPT_AUTH_FAILED', 'BACKUP_MANIFEST_DIGEST_MISMATCH'].includes(after.reason_code), after.reason_code);
      assert.equal(after.reason_code, 'BACKUP_DECRYPT_AUTH_FAILED');
    } finally {
      repo.cleanup();
      source.cleanup();
      target.cleanup();
    }
  });
});
