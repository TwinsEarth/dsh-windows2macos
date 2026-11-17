/**
 * Restore of the expanded scopes: the registry document is a base document (not a slug guess), config/state files
 * are written in a fixed order with pre-restore copies and `.bak`/`--keep-both` conflict handling, an unparseable
 * registry is refused by name, and `--scopes` narrows what a restore touches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { runBackup } from '../src/backup/engine.mjs';
import { applyRestore, planRestore, preRestoreRoot, RESTORE_CODES } from '../src/backup/restore.mjs';
import { put, registryDocument, runtimeValidSessionLog, tempDir } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const PLATFORM = 'linux';
const SESSION = 'session-aaaaaaaa-0001';
const WORKSPACE = '--E-GPT--';

/** A source home with a session, a registry document, one config + one state file, and a pre-restore copy. */
function sourceHome() {
  const home = tempDir('w2m-scope-restore-src-');
  put(join(home.dir, 'sessions', WORKSPACE, SESSION, 'session.v4.jsonl.zstd'), runtimeValidSessionLog(SESSION));
  put(join(home.dir, 'storages', 'workspace.json'), JSON.stringify(registryDocument({ sessionIds: [SESSION], pinned: [SESSION] }), null, 2));
  put(join(home.dir, 'cordis.patch.yml'), 'plugins:\n  - id: from-backup\n    disabled: false\n');
  put(join(home.dir, 'profiles', 'desktop', 'package.json'), '{"name":"backed-up-profile"}\n');
  put(join(home.dir, 'xclient', 'device.json'), '{"sn":"from-backup"}\n');
  put(join(home.dir, 'llm-deepseek', 'config.json'), '{"model":"from-backup"}\n');
  // P3: a pre-restore copy, so the snapshot carries a restore-copy entry a restore plan must report but never write.
  put(join(home.dir, '.w2m-restore-backups', '20260101T000000Z', 'storages', 'workspace.json'), '{"restore-copy":true}\n');
  return home;
}

/** The restore-copy rel path the P3 fixture writes (and a restore must never publish). */
const RESTORE_COPY_REL = '.w2m-restore-backups/20260101T000000Z/storages/workspace.json';

function repoFor(dshHome, extra = {}) {
  const repo = tempDir('w2m-scope-restore-repo-');
  const run = runBackup({ root: repo.dir, dshHome, password: PASSWORD, platform: PLATFORM, machineKey: false, ...extra });
  assert.equal(run.ok, true, run.detail);
  return { repo, run };
}

/** Plan/apply a restore from a repository into a (usually empty) target home. */

describe('restore of the expanded scopes', () => {
  it('writes config and state files, and replaces a conflicting file only after a .bak copy', () => {
    const source = sourceHome();
    const { repo } = repoFor(source.dir);
    const target = tempDir('w2m-scope-restore-tgt-');
    try {
      // The target has an older, different config file and no files for the other scopes.
      put(join(target.dir, 'cordis.patch.yml'), 'plugins:\n  - id: live-only\n');
      put(join(target.dir, 'xclient', 'keep.json'), '{"live":true}\n');
      const plan = planRestore({ root: repo.dir, dshHome: target.dir, password: PASSWORD, platform: PLATFORM, machineKey: false, allowStaticValidation: true });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.files_summary.registry, 1);
      assert.equal(plan.files_summary.config, 2);
      assert.equal(plan.files_summary.state, 2);
      assert.equal(plan.files_summary.conflicts, 1);
      assert.equal(plan.registry_from_backup_document, true);
      const conflicting = plan.files.find((row) => row.rel === 'cordis.patch.yml');
      assert.equal(conflicting.conflict, 'differs');
      assert.equal(conflicting.resolution, 'backup-and-replace');

      const applied = applyRestore({ plan, dshHome: target.dir });
      assert.equal(applied.ok, true, `${applied.reason_code}: ${applied.detail}`);
      assert.equal(applied.files.written, 4);
      assert.equal(applied.files.config, 2);
      assert.equal(applied.files.state, 2);
      assert.equal(applied.files.registry, 1);
      assert.equal(applied.files.conflicts, 1);
      assert.equal(applied.registry_from_backup_document, true);
      assert.equal(fs.readFileSync(join(target.dir, 'cordis.patch.yml'), 'utf8'), 'plugins:\n  - id: from-backup\n    disabled: false\n');
      assert.equal(fs.readFileSync(join(target.dir, 'profiles', 'desktop', 'package.json'), 'utf8'), '{"name":"backed-up-profile"}\n');
      assert.equal(fs.readFileSync(join(target.dir, 'xclient', 'device.json'), 'utf8'), '{"sn":"from-backup"}\n');
      assert.equal(fs.readFileSync(join(target.dir, 'llm-deepseek', 'config.json'), 'utf8'), '{"model":"from-backup"}\n');
      // The overwritten config's old bytes survive beside it, and the untouched live state file is untouched.
      const backups = fs.readdirSync(target.dir).filter((name) => name.startsWith('cordis.patch.yml.bak-'));
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(join(target.dir, backups[0]), 'utf8'), 'plugins:\n  - id: live-only\n');
      assert.equal(fs.readFileSync(join(target.dir, 'xclient', 'keep.json'), 'utf8'), '{"live":true}\n');
      // The registry document came from the backup, so the workspace path and pinned flag survive.
      const registry = JSON.parse(fs.readFileSync(join(target.dir, 'storages', 'workspace.json'), 'utf8'));
      assert.equal(registry.tables.workspaces.w1.path, 'E:\\GPT');
      assert.deepEqual(registry.global.pinnedSessionIds, [SESSION]);
      // Pre-restore copies include the files that were overwritten.
      const copies = fs.readdirSync(preRestoreRoot(target.dir));
      assert.equal(copies.length, 1);
      assert.ok(fs.existsSync(join(preRestoreRoot(target.dir), copies[0], 'cordis.patch.yml')));
    } finally {
      target.cleanup();
      repo.cleanup();
      source.cleanup();
    }
  });

  it('keepBoth writes the restored copy as <rel>.restored-<ts> and leaves the live file alone', () => {
    const source = sourceHome();
    const { repo } = repoFor(source.dir);
    const target = tempDir('w2m-scope-restore-keep-');
    try {
      put(join(target.dir, 'cordis.patch.yml'), 'plugins:\n  - id: live-only\n');
      const plan = planRestore({ root: repo.dir, dshHome: target.dir, password: PASSWORD, platform: PLATFORM, machineKey: false, allowStaticValidation: true, keepBoth: true });
      assert.equal(plan.ok, true, plan.detail);
      const applied = applyRestore({ plan, dshHome: target.dir });
      assert.equal(applied.ok, true, applied.detail);
      assert.equal(fs.readFileSync(join(target.dir, 'cordis.patch.yml'), 'utf8'), 'plugins:\n  - id: live-only\n');
      const restoredName = fs.readdirSync(target.dir).find((name) => name.startsWith('cordis.patch.yml.restored-'));
      assert.ok(restoredName, 'the restored copy must be written beside the live file');
      assert.equal(fs.readFileSync(join(target.dir, restoredName), 'utf8'), 'plugins:\n  - id: from-backup\n    disabled: false\n');
    } finally {
      target.cleanup();
      repo.cleanup();
      source.cleanup();
    }
  });

  it('refuses by name when the snapshot carries a registry file that is not a registry document', () => {
    const source = tempDir('w2m-scope-restore-badreg-');
    try {
      put(join(source.dir, 'sessions', WORKSPACE, SESSION, 'session.v4.jsonl.zstd'), runtimeValidSessionLog(SESSION));
      put(join(source.dir, 'storages', 'workspace.json'), 'this is not json\n');
      const { repo } = repoFor(source.dir);
      const target = tempDir('w2m-scope-restore-badreg-tgt-');
      try {
        const plan = planRestore({ root: repo.dir, dshHome: target.dir, password: PASSWORD, platform: PLATFORM, machineKey: false, allowStaticValidation: true });
        assert.equal(plan.ok, false);
        assert.equal(plan.reason_code, RESTORE_CODES.REGISTRY_INVALID);
        assert.match(plan.detail, /registry/u);
        const broken = planRestore({ root: repo.dir, dshHome: target.dir, password: PASSWORD, platform: PLATFORM, machineKey: false, allowStaticValidation: true, scopes: ['sessions'], workspacePath: target.dir });
        assert.equal(broken.ok, true, 'a restore that excludes the registry scope does not need the document');
        assert.equal(broken.registry_from_backup_document, false);
      } finally {
        target.cleanup();
        repo.cleanup();
      }
    } finally {
      source.cleanup();
    }
  });

  it('--scopes narrows the restore: config only writes no session and no registry', () => {
    const source = sourceHome();
    const { repo } = repoFor(source.dir);
    const target = tempDir('w2m-scope-restore-config-');
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.dir, password: PASSWORD, platform: PLATFORM, machineKey: false, allowStaticValidation: true, scopes: ['config'] });
      assert.equal(plan.ok, true, `${plan.reason_code}: ${plan.detail}`);
      assert.deepEqual(plan.scopes, ['config']);
      assert.equal(plan.summary.sessions, 0);
      assert.equal(plan.files_summary.config, 2);
      assert.equal(plan.files_summary.state, 0);
      assert.equal(plan.files_summary.registry, 0);
      const applied = applyRestore({ plan, dshHome: target.dir });
      assert.equal(applied.ok, true, applied.detail);
      assert.equal(fs.existsSync(join(target.dir, 'sessions')), false, 'the session scope was not selected');
      assert.equal(fs.existsSync(join(target.dir, 'storages', 'workspace.json')), false, 'the registry scope was not selected');
      assert.equal(fs.existsSync(join(target.dir, 'cordis.patch.yml')), true);
    } finally {
      target.cleanup();
      repo.cleanup();
      source.cleanup();
    }
  });

  it('a dry-run apply reports the file counts and writes nothing', () => {
    const source = sourceHome();
    const { repo } = repoFor(source.dir);
    const target = tempDir('w2m-scope-restore-dry-');
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.dir, password: PASSWORD, platform: PLATFORM, machineKey: false, allowStaticValidation: true });
      assert.equal(plan.ok, true, plan.detail);
      const dry = applyRestore({ plan, dshHome: target.dir, dryRun: true });
      assert.equal(dry.ok, true);
      assert.equal(dry.dry_run, true);
      assert.equal(dry.files.written, 0);
      assert.equal(dry.files.config, 2);
      assert.equal(dry.files.state, 2);
      assert.equal(dry.files.registry, 1);
      assert.equal(dry.files_summary.config, 2);
      assert.equal(fs.existsSync(join(target.dir, 'cordis.patch.yml')), false);
      assert.equal(fs.existsSync(join(target.dir, 'storages', 'workspace.json')), false);
    } finally {
      target.cleanup();
      repo.cleanup();
      source.cleanup();
    }
  });

  it('reports restore copies as skipped recovery material and never writes them back', () => {
    const source = sourceHome();
    const { repo } = repoFor(source.dir);
    const target = tempDir('w2m-scope-restore-copies-tgt-');
    try {
      const plan = planRestore({ root: repo.dir, dshHome: target.dir, password: PASSWORD, platform: PLATFORM, machineKey: false, allowStaticValidation: true });
      assert.equal(plan.ok, true, `${plan.reason_code}: ${plan.detail}`);
      // The plan names them, marks them skipped, and never puts them into the writable `files` set.
      assert.deepEqual(plan.restore_copies, {
        count: 1,
        skipped: true,
        detail: 'pre-restore copies are recovery material, not live state',
      });
      assert.equal(plan.files.some((row) => row.kind === 'restore-copy'), false);
      assert.equal(plan.files.some((row) => String(row.rel).startsWith('.w2m-restore-backups')), false);

      const applied = applyRestore({ plan, dshHome: target.dir });
      assert.equal(applied.ok, true, `${applied.reason_code}: ${applied.detail}`);
      // The restore-copy bytes are not published into the target home.
      assert.equal(fs.existsSync(join(target.dir, ...RESTORE_COPY_REL.split('/'))), false, 'the snapshot restore copy must not be written');
      assert.equal(applied.files.written, 4, 'registry/config/state behaviour is unchanged');
      assert.equal(applied.files.config, 2);
      assert.equal(applied.files.state, 2);
      // The pre-restore directory the restore itself makes for overwritten files is distinct from the snapshot copy.
      const restoreRoot = join(target.dir, '.w2m-restore-backups');
      if (fs.existsSync(restoreRoot)) {
        const dirs = fs.readdirSync(restoreRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
        for (const dir of dirs) {
          assert.notEqual(dir.name, '20260101T000000Z', 'the restore must not recreate the snapshot restore-copy directory');
        }
      }
      // A narrowed restore that excludes restore copies does not report them at all.
      const narrowed = planRestore({ root: repo.dir, dshHome: target.dir, password: PASSWORD, platform: PLATFORM, machineKey: false, allowStaticValidation: true, scopes: ['config'] });
      assert.equal(narrowed.ok, true, narrowed.detail);
      assert.equal(narrowed.restore_copies.count, 0);
      assert.equal(narrowed.restore_copies.skipped, true);
    } finally {
      target.cleanup();
      repo.cleanup();
      source.cleanup();
    }
  });
});
