/**
 * Backup engine: deduplication, incrementality, scope, and the refusals that must not write anything.
 *
 * The two properties that make this engine worth having are asserted directly rather than by proxy:
 *
 *   1. **A second backup writes no blocks.** The content addresses are already on disk, so "new blocks: 0" is
 *      the deduplication working; anything else means the second daily backup rewrites 166 MB.
 *   2. **The source home is untouched.** A backup that changes what it reads is not a backup.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { runBackup, selectSessions, normalizeScope, blockObjectPath } from '../src/backup/engine.mjs';
import { ensureLayout, repoPaths } from '../src/backup/layout.mjs';
import { readIndex } from '../src/backup/repo.mjs';
import { readCurrent, listOldVersions } from '../src/backup/rotation.mjs';
import { readSnapshot } from '../src/backup/repo.mjs';
import { scanHome } from '../src/backup/scan.mjs';
import { sha256Hex } from '../src/backup/manifest.mjs';
import { tempDir, makeHome, registryDocument, sessionLog, event } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const PLATFORM = 'linux'; // no OS keystore: exercises the password envelope without DPAPI

/** A fixture home with two sessions across two workspaces. */
function homeFixture() {
  return makeHome({
    sessions: [
      { workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001', events: [event(0), event(1)] },
      { workspace: '--E-GPT--', id: 'session-bbbbbbbb-0002', events: [event(0)] },
      { workspace: '--E-ToFuture--', id: 'session-cccccccc-0003', events: [event(0)] },
    ],
    registry: registryDocument({
      sessionIds: ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002', 'session-cccccccc-0003'],
      archived: ['session-cccccccc-0003'],
      pinned: ['session-aaaaaaaa-0001'],
    }),
    attachments: [{ id: `${'ab'.repeat(32)}` }],
  });
}

/** Repository root plus cleanup. */
function repoFixture() {
  const { dir, cleanup } = tempDir('w2m-engine-');
  const root = join(dir, 'repo');
  ensureLayout(root);
  return { root, cleanup };
}

/** Every file under `root` with size and mtime. */
function treeState(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = statSync(full);
        out.set(relative(root, full).split('\\').join('/'), `${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

const run = (root, home, extra = {}) => runBackup({ root, dshHome: home, password: PASSWORD, platform: PLATFORM, ...extra });

describe('engine: scope selection', () => {
  it('validates the scope vocabulary and requires ids for "selected"', () => {
    assert.deepEqual(normalizeScope({ scope: 'all' }), { ok: true, scope: 'all', selected: [] });
    assert.equal(normalizeScope({ scope: 'nonsense' }).reason_code, 'BACKUP_SCOPE_INVALID');
    assert.equal(normalizeScope({ scope: 'selected' }).reason_code, 'BACKUP_SCOPED_NOTHING');
    assert.equal(normalizeScope({ scope: 'selected', selected: [' session-x ', ''] }).selected[0], 'session-x');
  });

  it('separates active from archived and reports unknown selected ids', () => {
    const { home, cleanup } = homeFixture();
    try {
      const scan = scanHome({ dshHome: home });
      const all = selectSessions(scan.sessions, { scope: 'all', selected: [] });
      assert.equal(all.chosen.length, 3);
      const active = selectSessions(scan.sessions, { scope: 'active', selected: [] });
      assert.deepEqual(active.chosen.map((row) => row.session_id).sort(), ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002']);
      const archived = selectSessions(scan.sessions, { scope: 'archived', selected: [] });
      assert.deepEqual(archived.chosen.map((row) => row.session_id), ['session-cccccccc-0003']);
      const selected = selectSessions(scan.sessions, { scope: 'selected', selected: ['session-aaaaaaaa-0001', 'session-missing'] });
      assert.equal(selected.chosen.length, 1);
      assert.deepEqual(selected.unknown_selected, ['session-missing']);
    } finally {
      cleanup();
    }
  });
});

describe('engine: a first and a second backup', () => {
  it('commits a snapshot, writes blocks once, and leaves the source home byte-identical', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const before = treeState(home);
      const first = run(root, home);
      assert.equal(first.ok, true, `${first.reason_code}: ${first.detail}`);
      assert.equal(first.sessions, 3);
      assert.equal(first.attachments, 1);
      assert.equal(first.key_created, true);
      assert.equal(first.unlocked_via, 'password');
      assert.ok(first.blocks_new > 0);
      assert.equal(first.blocks_reused, 0);
      assert.deepEqual(treeState(home), before, 'a backup must not touch what it reads');

      const paths = repoPaths(root);
      assert.equal(readIndex(root).entries.length, 1);
      assert.ok(readdirSync(paths.snapshots).includes(first.snapshot_id));
      assert.ok(existsSync(join(root, 'keys.json')), 'the repository key document must exist');
      const snapshot = readSnapshot({ root, snapshotId: first.snapshot_id });
      assert.equal(snapshot.manifest.counts.sessions, 3);
      assert.equal(snapshot.manifest.counts.files, 4, 'three sessions plus one attachment');
      assert.equal(snapshot.keys.format, 'w2m-session-backup/keys');

      // Every block object named in the manifest exists on disk.
      for (const file of snapshot.manifest.files) {
        for (const block of file.blocks) assert.ok(existsSync(blockObjectPath(root, block.sha256)), `missing object ${block.sha256}`);
      }
      assert.ok(!readdirSync(paths.tmp).some((name) => name.includes('.tmp-')), 'no staging file may survive');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('writes no blocks on a second backup of unchanged sessions (deduplication)', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const first = run(root, home);
      const second = run(root, home);
      assert.equal(second.ok, true, `${second.reason_code}: ${second.detail}`);
      assert.equal(second.blocks_new, 0, 'unchanged content must reuse every block');
      assert.equal(second.blocks_reused, first.blocks_new + first.blocks_reused);
      assert.equal(second.dedupe_ratio, 1);
      assert.equal(readIndex(root).entries.length, 2, 'a second snapshot is still committed');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('adds only the changed block and records the superseded version after an append', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const first = run(root, home);
      assert.equal(first.ok, true, `${first.reason_code}: ${first.detail}`);
      const target = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
      writeFileSync(target, sessionLog('session-aaaaaaaa-0001', [event(0), event(1), event(2), event(3)]));
      const second = run(root, home);
      assert.equal(second.ok, true, `${second.reason_code}: ${second.detail}`);
      assert.ok(second.blocks_new > 0, 'the appended session must produce at least one new block');
      assert.ok(second.blocks_reused > 0, 'the unchanged sessions and blocks must be reused');
      assert.equal(second.rotated, 1, 'exactly one session changed');
      assert.equal(listOldVersions(root, { sessionId: 'session-aaaaaaaa-0001' }).length, 1);
      assert.equal(listOldVersions(root, { sessionId: 'session-bbbbbbbb-0002' }).length, 0);
      const current = readCurrent(root, { session_id: 'session-aaaaaaaa-0001', workspace: '--E-GPT--', rel: 'x', sha256: '', size: 0, blocks: [] });
      assert.equal(current.snapshot_id, second.snapshot_id);
      assert.equal(current.sha256, sha256Hex(readFileSync(target)), 'the pointer must name the content now on disk');
      assert.notEqual(current.sha256, null);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('honours scope: archived sessions are only backed up by the archived scope', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const archived = run(root, home, { scope: 'archived' });
      assert.equal(archived.ok, true, `${archived.reason_code}: ${archived.detail}`);
      assert.equal(archived.sessions, 1);
      assert.equal(archived.skipped_sessions, 2);

      const selected = run(root, home, { scope: 'selected', selected: ['session-bbbbbbbb-0002'] });
      assert.equal(selected.ok, true, `${selected.reason_code}: ${selected.detail}`);
      assert.equal(selected.sessions, 1);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses a scope that selects nothing, and a dry run writes nothing', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const nothing = run(root, home, { scope: 'selected', selected: ['session-missing'] });
      assert.equal(nothing.ok, false);
      assert.equal(nothing.reason_code, 'BACKUP_SCOPED_NOTHING');
      assert.deepEqual(nothing.unknown_selected, ['session-missing']);

      const before = treeState(root);
      const dry = run(root, home, { dryRun: true });
      assert.equal(dry.ok, true, `${dry.reason_code}: ${dry.detail}`);
      assert.equal(dry.dry_run, true);
      assert.ok(dry.blocks_new > 0, 'a dry run still reports what it would write');
      assert.deepEqual(treeState(root), before, 'a dry run must not write a byte');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses with BACKUP_NO_PERMISSION when no credential can protect a new repository', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-noperm-');
    try {
      const root = join(dir, 'repo');
      const result = runBackup({ root, dshHome: home, platform: 'linux' });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_NO_PERMISSION');
      assert.match(result.detail, /no credential/u);
      assert.equal(existsSync(join(root, 'snapshots')), true, 'the layout exists, but no snapshot was written');
      assert.equal(readdirSync(join(root, 'snapshots')).length, 0);
    } finally {
      cleanup();
      cleanHome();
    }
  });
});

describe('engine: one writer, and an unwritable target', () => {
  it('refuses a second writer while a lock is held', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const lockFile = join(repoPaths(root).tmp, 'backup.lock');
      mkdirSync(join(repoPaths(root).tmp), { recursive: true });
      writeFileSync(lockFile, JSON.stringify({ format: 'w2m-session-backup/lock/1', pid: process.pid, host: 'elsewhere-host', started_at: new Date().toISOString() }));
      const result = run(root, home);
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_LOCKED');
      assert.equal(readIndex(root).entries.length, 0);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses a repository inside the DSH home with the layout code, not a write', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    try {
      const result = run(join(home, 'inside-repo'), home);
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_DIR_INSIDE_SOURCE');
      assert.equal(existsSync(join(home, 'inside-repo')), false);
    } finally {
      cleanHome();
    }
  });

  it('reports a home that does not exist instead of committing an empty snapshot', () => {
    const { root, cleanup } = repoFixture();
    try {
      const result = runBackup({ root, dshHome: join(root, '..', 'no-such-home'), password: PASSWORD, platform: PLATFORM });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_SCAN_HOME_MISSING');
      assert.equal(readIndex(root).entries.length, 0);
    } finally {
      cleanup();
    }
  });
});
