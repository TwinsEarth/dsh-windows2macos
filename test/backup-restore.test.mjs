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
import { applyRestore, listPreRestoreSnapshots, planRestore, planRestoreFromArchive, prunePreRestoreSnapshots } from '../src/backup/restore.mjs';
import { compressFrame } from '../src/fix/zstd.mjs';
import { diagnoseSessionBuffer } from '../src/util/session-validate.mjs';
import { buildArchive } from '../src/backup/archive.mjs';
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
      if (HARNESS === null) {
        // No installation: the explicit flag accepts static-only evidence.
        assert.equal(allowed.ok, true, allowed.detail);
        assert.equal(allowed.summary.sessions, 1);
        assert.equal(allowed.summary.runtime_verified, 0);
      } else {
        // An installation exists: its verdict outranks the flag (the flag only relaxes "no installation").
        assert.equal(allowed.ok, false);
        assert.equal(allowed.reason_code, 'BACKUP_RUNTIME_REJECTED');
      }
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
      assert.equal(attached.registry.assignments[0].workspace_id, 'restored-e-gpt');
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
      assert.equal(fs.existsSync(join(target.home, '.w2m-restore-backups')), true);

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

  it('registers every session of a multi-session restore (one document, not last-write-wins)', () => {
    const home = makeHome({
      sessions: [
        { workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' },
        { workspace: '--E-GPT--', id: 'session-bbbbbbbb-0002' },
      ],
      registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002'] }),
    });
    for (const id of ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002']) {
      fs.writeFileSync(join(home.home, 'sessions', '--E-GPT--', id, 'session.v4.jsonl.zstd'), runtimeValidSessionLog(id));
    }
    const repo = repoFor(home.home);
    const target = emptyTargetHome();
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.candidates.length, 2);
      const applied = applyRestore({ plan, dshHome: target.home });
      assert.equal(applied.ok, true, applied.detail);
      const registry = JSON.parse(fs.readFileSync(join(target.home, 'storages', 'workspace.json'), 'utf8'));
      assert.deepEqual(registry.tables.workspaces.w1.sessionIds.sort(), ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002'].sort());
      assert.equal(applied.registry[0].verified, true);
    } finally {
      repo.cleanup();
      home.cleanup();
      target.cleanup();
    }
  });

  it('restores into a brand-new home when the operator names a directory', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const fresh = tempDir('w2m-restore-fresh-');
    try {
      // A home with no storages/workspace.json at all: the disaster-recovery case.
      fs.mkdirSync(join(fresh.dir, 'sessions'), { recursive: true });
      fs.writeFileSync(join(fresh.dir, 'sessions', '.keep'), '');
      fs.rmSync(join(fresh.dir, 'sessions', '.keep'));
      const refused = planRestore({ root: repo.dir, dshHome: fresh.dir, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(refused.ok, false);
      assert.match(refused.detail, /--workspace-path/u);

      const plan = planRestore({
        root: repo.dir,
        dshHome: fresh.dir,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        workspacePath: fresh.dir,
      });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.registry.created_document, true);
      assert.equal(plan.registry.created_workspaces.length, 1);
      const applied = applyRestore({ plan, dshHome: fresh.dir });
      assert.equal(applied.ok, true, applied.detail);
      assert.ok(fs.readFileSync(logPath(fresh.dir)).equals(runtimeValidSessionLog(SESSION)));
      const registry = JSON.parse(fs.readFileSync(join(fresh.dir, 'storages', 'workspace.json'), 'utf8'));
      assert.equal(registry.unit.name, 'workspace');
      assert.equal(registry.global.initialized, true);
      assert.deepEqual(registry.tables.workspaces[registry.global.defaultWorkspaceId].sessionIds, [SESSION]);
    } finally {
      repo.cleanup();
      source.cleanup();
      fresh.cleanup();
    }
  });

  it('skips an identical session instead of rewriting it, but still registers it', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const target = emptyTargetHome();
    try {
      const first = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      applyRestore({ plan: first, dshHome: target.home });
      const before = fs.statSync(logPath(target.home)).mtimeMs;
      const second = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(second.ok, true, second.detail);
      assert.equal(second.candidates[0].conflict, 'identical');
      const applied = applyRestore({ plan: second, dshHome: target.home });
      assert.equal(applied.ok, true);
      assert.equal(applied.restored.length, 0);
      assert.equal(applied.skipped, 1);
      assert.equal(fs.statSync(logPath(target.home)).mtimeMs, before, 'an identical file must not be touched');
    } finally {
      repo.cleanup();
      source.cleanup();
      target.cleanup();
    }
  });

  it('restores from a .tar.zst archive without a repository (the portable path)', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const target = emptyTargetHome();
    try {
      const archive = buildArchive({ root: repo.dir, dshHome: source.home, password: PASSWORD, platform: 'linux', machineKey: false, scope: 'all' });
      assert.equal(archive.ok, true, archive.detail);
      const plan = planRestoreFromArchive({
        file: archive.file,
        dshHome: target.home,
        allowStaticValidation: true, // deterministic: this test is about the archive path, not the runtime gate
      });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.source.kind, 'archive');
      assert.equal(plan.snapshot_id, plan.source.snapshot_id);
      const applied = applyRestore({ plan, dshHome: target.home });
      assert.equal(applied.ok, true, applied.detail);
      assert.ok(fs.readFileSync(logPath(target.home)).equals(runtimeValidSessionLog(SESSION)));
      const registry = JSON.parse(fs.readFileSync(join(target.home, 'storages', 'workspace.json'), 'utf8'));
      assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [SESSION]);
    } finally {
      repo.cleanup();
      source.cleanup();
      target.cleanup();
    }
  });

  it('keeps the newest pre-restore copies and prunes the older ones after a successful restore', () => {
    const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: SESSION }], registry: registryDocument({ sessionIds: [] }) });
    try {
      const root = join(home.home, '.w2m-restore-backups');
      for (const id of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']) fs.mkdirSync(join(root, id), { recursive: true });
      assert.equal(listPreRestoreSnapshots(home.home).length, 3);
      const pruned = prunePreRestoreSnapshots({ dshHome: home.home, keep: 2 });
      assert.equal(pruned.removed, 1);
      assert.deepEqual(listPreRestoreSnapshots(home.home).map((row) => row.id), ['20260102T000000Z', '20260103T000000Z']);
    } finally {
      home.cleanup();
    }
  });

  it('refuses to write a session whose file changed after the plan (the live-client case)', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const target = emptyTargetHome();
    try {
      fs.mkdirSync(join(target.home, 'sessions', '--E-GPT--', SESSION), { recursive: true });
      fs.writeFileSync(logPath(target.home), sessionLog(SESSION));
      const plan = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(plan.ok, true, plan.detail);
      // The client appends between plan and apply.
      fs.writeFileSync(logPath(target.home), sessionLog(SESSION).length > 0 ? Buffer.concat([sessionLog(SESSION), Buffer.from('appended')]) : sessionLog(SESSION));
      const applied = applyRestore({ plan, dshHome: target.home });
      assert.equal(applied.ok, false);
      assert.equal(applied.reason_code, 'BACKUP_RESTORE_TARGET_CHANGED');
      assert.match(applied.detail, /changed after the plan/u);
      assert.equal(applied.restored.length, 0, 'nothing may be written over a file that moved');
    } finally {
      repo.cleanup();
      source.cleanup();
      target.cleanup();
    }
  });

  it('heals a session the client appended to between write and verification (pre-copy + tail)', () => {
    const source = runtimeValidHome();
    const repo = repoFor(source.home);
    const target = emptyTargetHome();
    try {
      const liveBytes = sessionLog(SESSION);
      fs.mkdirSync(join(target.home, 'sessions', '--E-GPT--', SESSION), { recursive: true });
      fs.writeFileSync(logPath(target.home), liveBytes);
      const plan = planRestore({ root: repo.dir, dshHome: target.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.candidates[0].conflict, 'differs');

      // The seam below writes one legal event frame *after* the restore wrote the snapshot bytes, exactly like the
      // running client would -- the incident that motivated this repair.
      const tailEvent = compressFrame(Buffer.from(JSON.stringify({ type: 'permission/preset', seq: 2, time: Date.now(), data: { preset: 'workspace-write' } }) + '\n', 'utf8'));
      const applied = applyRestore({
        plan,
        dshHome: target.home,
        afterWrite: ({ target: file }) => {
          fs.appendFileSync(file, tailEvent);
        },
      });
      assert.equal(applied.ok, true, applied.detail);
      assert.equal(applied.healed.length, 1, 'the repair must be reported');
      assert.equal(applied.healed[0].session_id, SESSION);
      assert.equal(applied.healed[0].tail_bytes, tailEvent.length);

      const healed = fs.readFileSync(logPath(target.home));
      const expected = Buffer.concat([liveBytes, tailEvent]);
      assert.ok(healed.equals(expected), 'the healed log must be the pre-restore content plus the client tail');
      const verdict = diagnoseSessionBuffer(healed, { expectedSessionId: SESSION });
      assert.equal(verdict.ok, true, verdict.codes.join(','));
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
