/**
 * Backup scope expansion in the engine: the default run captures registry/config/state, the P1 credential switch
 * is opt-in, a narrowed scope reproduces the pre-expansion manifest, and a dry run still writes nothing.
 *
 * These assertions are the P0/P1 acceptance properties from `docs/BACKUP-SCOPE.md` section 6, measured on a fixture
 * home shaped like the real one (workspace registry, profile configuration, xclient state, a device key).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { runBackup } from '../src/backup/engine.mjs';
import { readSnapshot } from '../src/backup/repo.mjs';
import { listOldVersions } from '../src/backup/rotation.mjs';
import { verifyRepo } from '../src/backup/verify.mjs';
import { SCOPE_CODES, SECRETS_WARNING } from '../src/backup/scopes.mjs';
import { makeHome, put, registryDocument, sessionLog, tempDir } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const PLATFORM = 'linux';
const SESSION = 'session-aaaaaaaa-0001';
const WORKSPACE = '--E-GPT--';

function repoFixture() {
  const { dir, cleanup } = tempDir('w2m-scope-run-repo-');
  return { root: join(dir, 'repo'), cleanup };
}

/** A home with one session plus one file of every expanded-scope kind (and one credential). */
function expandedHome() {
  const home = makeHome({
    sessions: [{ workspace: WORKSPACE, id: SESSION, events: [] }],
    registry: registryDocument({ sessionIds: [SESSION], pinned: [SESSION] }),
  });
  put(join(home.home, 'cordis.patch.yml'), 'plugins:\n  - id: dsh-backup\n    disabled: false\n');
  put(join(home.home, 'profiles', 'desktop', 'package.json'), '{"name":"profile-desktop","dsh":{"profile":{"bundles":["@twinsearth/w2m-dsh-plugin"]}}}\n');
  put(join(home.home, 'profiles', 'desktop', 'cordis.patch.yml'), 'plugins:\n  - id: dsh-backup\n');
  put(join(home.home, 'profiles', 'desktop', 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n');
  put(join(home.home, 'xclient', 'device.json'), '{"sn":"fixture"}\n');
  put(join(home.home, 'xclient', 'device.key'), 'private-device-key\n');
  put(join(home.home, 'xclient', 'spool', 'outbox.json'), '{}\n');
  put(join(home.home, 'storages', 'dsh-context', 'state.json'), '{"context":true}\n');
  put(join(home.home, 'llm-deepseek', 'config.json'), '{"model":"deepseek-reasoner"}\n');
  put(join(home.home, 'fang', 'contract.json'), '{"contract":true}\n');
  put(join(home.home, '.credentials.yaml'), 'token: fixture-secret\n');
  put(join(home.home, 'xclient', 'agent.log'), 'log line\n');
  // P3: a restore copy, so a default run must carry it and a narrowed run must leave it out.
  put(join(home.home, '.w2m-restore-backups', '20260101T000000Z', 'storages', 'workspace.json'), '{"old":true}\n');
  return home;
}

function backup(root, dshHome, extra = {}) {
  return runBackup({ root, dshHome, password: PASSWORD, platform: PLATFORM, machineKey: false, ...extra });
}

/** The manifest entries of a committed run, by kind. */
function entriesByKind(root, snapshotId) {
  const snapshot = readSnapshot({ root, snapshotId });
  const byKind = new Map();
  for (const entry of snapshot.manifest.files) {
    if (!byKind.has(entry.kind)) byKind.set(entry.kind, []);
    byKind.get(entry.kind).push(entry);
  }
  return { manifest: snapshot.manifest, byKind };
}

describe('backup scope expansion: a default run', () => {
  it('captures registry, config, state and restore-copy files, and records the scopes and per-scope counts', () => {
    const home = expandedHome();
    const { root, cleanup } = repoFixture();
    try {
      const result = backup(root, home.home);
      assert.equal(result.ok, true, `${result.reason_code}: ${result.detail}`);
      assert.deepEqual(result.scopes, ['sessions', 'attachments', 'registry', 'config', 'state', 'restore_copies']);
      assert.equal(result.secrets_included, false);
      const { manifest, byKind } = entriesByKind(root, result.snapshot_id);
      assert.deepEqual(manifest.scopes, ['sessions', 'attachments', 'registry', 'config', 'state', 'restore_copies']);
      assert.equal(manifest.secrets_included, false);

      const registry = byKind.get('registry').map((entry) => entry.rel);
      assert.deepEqual(registry, ['storages/workspace.json']);
      const config = byKind.get('config').map((entry) => entry.rel).sort();
      assert.deepEqual(config, [
        'cordis.patch.yml',
        'profiles/desktop/cordis.patch.yml',
        'profiles/desktop/package.json',
      ]);
      const state = byKind.get('state').map((entry) => entry.rel).sort();
      assert.deepEqual(state, [
        'fang/contract.json',
        'llm-deepseek/config.json',
        'storages/dsh-context/state.json',
        'xclient/device.json',
        'xclient/spool/outbox.json',
      ]);
      // P3: the restore copy is the sixth kind, with its own scope name.
      const restoreCopies = byKind.get('restore-copy');
      assert.deepEqual(restoreCopies.map((entry) => entry.rel), ['.w2m-restore-backups/20260101T000000Z/storages/workspace.json']);
      assert.equal(restoreCopies[0].scope, 'restore_copies');
      assert.match(restoreCopies[0].reason, /last-resort undo/u);

      // Credentials and dependency trees are excluded and *reported*, not silently missing.
      assert.equal(manifest.files.some((entry) => entry.rel === '.credentials.yaml'), false);
      assert.equal(manifest.files.some((entry) => entry.rel === 'xclient/device.key'), false);
      assert.equal(manifest.files.some((entry) => entry.rel.includes('node_modules')), false);
      const skipped = new Map(result.scope_skipped.map((row) => [row.rel, row]));
      assert.equal(skipped.get('.credentials.yaml').class, 'credential');
      assert.equal(skipped.get('xclient/device.key').class, 'credential');
      assert.equal(skipped.get('profiles/desktop/node_modules').class, 'reinstallable');

      // Every extra entry records why it is backed up, and its kind matches its scope (except restore-copy).
      for (const entry of [...byKind.get('registry'), ...byKind.get('config'), ...byKind.get('state'), ...restoreCopies]) {
        assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0, `${entry.rel} has no reason`);
        assert.equal(entry.scope, entry.kind === 'restore-copy' ? 'restore_copies' : entry.kind);
      }

      // Counts add up to the manifest files (the totals include the expanded scope).
      assert.equal(manifest.counts.files, manifest.files.length);
      assert.equal(manifest.counts.bytes, manifest.files.reduce((sum, entry) => sum + entry.size, 0));
      assert.equal(manifest.counts_by_scope.registry.files, 1);
      assert.equal(manifest.counts_by_scope.config.files, config.length);
      assert.equal(manifest.counts_by_scope.state.files, state.length);
      assert.equal(manifest.counts_by_scope.sessions.files, 1);
      assert.equal(manifest.counts_by_scope.restore_copies.files, 1);
      assert.equal(result.counts_by_scope.state.files, state.length);
      assert.equal(result.counts_by_scope.restore_copies.files, 1);
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('includes credential files only when includeSecrets is true, with a loud warning', () => {
    const home = expandedHome();
    const { root, cleanup } = repoFixture();
    try {
      const result = backup(root, home.home, { includeSecrets: true });
      assert.equal(result.ok, true, `${result.reason_code}: ${result.detail}`);
      assert.equal(result.secrets_included, true);
      const { manifest } = entriesByKind(root, result.snapshot_id);
      assert.equal(manifest.secrets_included, true);
      const rels = manifest.files.map((entry) => entry.rel);
      assert.ok(rels.includes('xclient/device.key'), 'the P1 opt-in must include the device key');
      assert.ok(rels.includes('.credentials.yaml'), 'the P1 opt-in must include the login credentials');
      assert.ok(
        result.warnings.some((line) => line === SECRETS_WARNING),
        'a credential-including run must carry the identity-leak warning',
      );
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('scopes: ["sessions"] reproduces the pre-expansion manifest (sessions only)', () => {
    const home = expandedHome();
    const { root, cleanup } = repoFixture();
    try {
      const result = backup(root, home.home, { scopes: ['sessions'] });
      assert.equal(result.ok, true, `${result.reason_code}: ${result.detail}`);
      assert.deepEqual(result.scopes, ['sessions']);
      const { manifest } = entriesByKind(root, result.snapshot_id);
      assert.equal(manifest.files.length, 1);
      assert.equal(manifest.files[0].kind, 'session');
      assert.equal(manifest.counts.sessions, 1);
      assert.equal(manifest.counts.attachments, 0);
      assert.equal(manifest.counts_by_scope.registry.files, 0);
      assert.equal(manifest.counts_by_scope.config.files, 0);
      assert.equal(manifest.counts_by_scope.state.files, 0);
      assert.equal(manifest.counts_by_scope.restore_copies.files, 0, 'a narrowed run does not capture restore copies');
      // The narrowed run explains the restore-copy directory it left out instead of silently omitting it.
      const skipped = new Map(result.scope_skipped.map((row) => [row.rel, row]));
      assert.equal(skipped.get('.w2m-restore-backups').class, 'self-copy');
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('rotates only session entries, never the expanded scope files', () => {
    const home = expandedHome();
    const { root, cleanup } = repoFixture();
    try {
      const first = backup(root, home.home);
      assert.equal(first.ok, true, first.detail);
      // Supersede the session log so rotation has a version to keep.
      put(home.files[SESSION], sessionLog(SESSION, [{ type: 'turn/start', seq: 0, time: 1794842804375, data: { turn: 1 } }]));
      const second = backup(root, home.home);
      assert.equal(second.ok, true, second.detail);
      assert.ok(second.rotated >= 1, 'the changed session must be rotated');
      const records = listOldVersions(root);
      assert.ok(records.length >= 1);
      for (const record of records) {
        assert.equal(String(record.record.rel ?? '').startsWith('sessions/'), true, `${record.record.rel} must be a session log, not scope state`);
      }
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('never collects its own repository when backupDir is misconfigured inside the home', () => {
    const home = expandedHome();
    try {
      // Nested inside a collected state root on purpose: without the self-reference guard the scope walk would
      // collect the repository's own objects/manifests as `state` and report the backup's files as home files.
      const root = join(home.home, 'xclient', 'backup-repo');
      const repoRel = 'xclient/backup-repo';
      put(join(root, 'backup.json'), '{"format":"w2m-session-backup","version":1}\n');
      put(join(root, 'objects', 'aa', 'block'), 'sealed block\n');
      put(join(root, 'snapshots', 'snap-1', 'manifest.json'), '{}\n');

      const dry = backup(root, home.home, { dryRun: true });
      assert.equal(dry.ok, true, `${dry.reason_code}: ${dry.detail}`);
      const skipped = dry.scope_skipped.find((row) => row.rel === repoRel);
      assert.ok(skipped, 'the repository root is reported as skipped');
      assert.match(skipped.reason, /self-reference/u);
      assert.equal(dry.scope_skipped.some((row) => row.rel.startsWith(`${repoRel}/`)), false, 'the walker does not descend into it');
      assert.equal(dry.counts_by_scope.state.files, 5, 'no repository file was counted as state');
      // The restore copies (outside the repository) are still collected: the guard is path containment, not a ban.
      assert.equal(dry.counts_by_scope.restore_copies.files, 1);
      assert.ok(dry.files > 0);

      // A real (non-dry) run against that path is refused before any write by the existing layout rule: a repository
      // must live outside the home it backs up. Two independent guards, not one.
      const refused = backup(root, home.home);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, 'BACKUP_DIR_INSIDE_SOURCE');
    } finally {
      home.cleanup();
    }
  });

  it('verify counts restore copies in their own coverage bucket and compares them without gap noise', () => {
    const home = expandedHome();
    const { root, cleanup } = repoFixture();
    try {
      const result = backup(root, home.home);
      assert.equal(result.ok, true, `${result.reason_code}: ${result.detail}`);
      const verified = verifyRepo({ root, dshHome: home.home, password: PASSWORD, platform: PLATFORM, machineKey: false });
      assert.equal(verified.ok, true, verified.problems.map((problem) => `${problem.code}:${problem.detail}`).join('; '));
      assert.equal(verified.coverage.scopes.includes('restore_copies'), true);
      assert.equal(verified.coverage.covered.by_scope.restore_copies.files, 1);
      assert.ok(verified.coverage.covered.by_scope.restore_copies.bytes > 0);
      // The restore copy the snapshot holds is still on disk, so it is not a gap.
      assert.equal(verified.coverage.gaps.some((rel) => rel.startsWith('.w2m-restore-backups')), false);
      // Uncovered aggregation classifies the directory as `restore-copy`, not `self-copy` (it is backed up now).
      const uncovered = verified.coverage.uncovered.find((row) => row.rel === '.w2m-restore-backups');
      assert.equal(uncovered, undefined, 'a covered restore copy is not part of the uncovered report');

      // A narrowed snapshot records no restore-copy scope: the same home must not report gap noise for it.
      const { root: narrowedRoot, cleanup: narrowedCleanup } = repoFixture();
      try {
        const narrowed = backup(narrowedRoot, home.home, { scopes: ['sessions'] });
        assert.equal(narrowed.ok, true, `${narrowed.reason_code}: ${narrowed.detail}`);
        const narrowedVerify = verifyRepo({ root: narrowedRoot, dshHome: home.home, password: PASSWORD, platform: PLATFORM, machineKey: false });
        assert.equal(narrowedVerify.ok, true, narrowedVerify.problems.map((problem) => `${problem.code}:${problem.detail}`).join('; '));
        assert.equal(narrowedVerify.coverage.gaps.some((rel) => rel.startsWith('.w2m-restore-backups')), false);
        // Outside the snapshot it is plainly visible in the uncovered report as recovery material.
        const leftover = narrowedVerify.coverage.uncovered.find((row) => row.rel === '.w2m-restore-backups');
        assert.equal(leftover?.class, 'restore-copy');
      } finally {
        narrowedCleanup();
      }
    } finally {
      cleanup();
      home.cleanup();
    }
  });

  it('refuses an unknown scope (and an invalid includeSecrets value is simply false, never consent)', () => {
    const home = expandedHome();
    const { root, cleanup } = repoFixture();
    try {
      const refused = backup(root, home.home, { scopes: ['sessions', 'everything'] });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, SCOPE_CODES.UNKNOWN);
      assert.equal(fs.existsSync(root), false, 'a refused configuration writes nothing, not even the repository');
      const coerced = backup(root, home.home, { includeSecrets: 1 });
      assert.equal(coerced.ok, true, coerced.detail);
      assert.equal(coerced.secrets_included, false, 'only a literal true is consent');
    } finally {
      cleanup();
      home.cleanup();
    }
  });
});

describe('backup scope expansion: a dry run', () => {
  it('reports the old shape plus the scope counts and writes nothing', () => {
    const home = expandedHome();
    const { root, cleanup } = repoFixture();
    try {
      const result = backup(root, home.home, { dryRun: true });
      assert.equal(result.ok, true, `${result.reason_code}: ${result.detail}`);
      assert.equal(result.dry_run, true);
      assert.equal(fs.existsSync(root), false, 'a dry run must not create the repository');
      assert.deepEqual(result.scopes, ['sessions', 'attachments', 'registry', 'config', 'state', 'restore_copies']);
      assert.equal(result.secrets_included, false);
      assert.ok(result.files > 1, 'the dry run reports the expanded file count');
      assert.equal(result.counts_by_scope.config.files, 3);
      assert.equal(result.counts_by_scope.state.files, 5);
      assert.equal(result.counts_by_scope.restore_copies.files, 1);
      assert.ok(Array.isArray(result.scope_skipped));
      assert.ok(result.blocks_new > 0);
      assert.equal(result.blocks_reused, 0);
      const secretsDry = backup(root, home.home, { dryRun: true, includeSecrets: true });
      assert.equal(secretsDry.secrets_included, true);
      assert.ok(secretsDry.warnings.includes(SECRETS_WARNING));
    } finally {
      cleanup();
      home.cleanup();
    }
  });
});
