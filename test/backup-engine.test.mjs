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
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { runBackup, selectSessions, normalizeScope, blockObjectPath } from '../src/backup/engine.mjs';
import { ensureLayout, repoPaths } from '../src/backup/layout.mjs';
import { sha256Hex } from '../src/backup/manifest.mjs';
import { framesFor, header, runtimeValidHome } from './helpers/backup-fixture.mjs';
import { readIndex } from '../src/backup/repo.mjs';
import { readCurrent, listOldVersions } from '../src/backup/rotation.mjs';
import { readSnapshot } from '../src/backup/repo.mjs';
import { scanHome } from '../src/backup/scan.mjs';
import { openObject } from '../src/backup/crypto.mjs';
import { openRepoKey, readRepoKeys } from '../src/backup/keystore.mjs';
import { findHarnessInstallation } from '../src/backup/runtime-validate.mjs';

const HARNESS = findHarnessInstallation();

/** Identity-faking DPAPI transport: protect echoes base64, unprotect decodes it. */
function fakeRunner(command, args, input = '') {
  const text = args.join(' ');
  if (text.includes('ProtectedData]::Protect') || text.includes('ProtectedData]::Unprotect')) {
    return { ok: true, status: 0, stdout: input, stderr: '', error: '' };
  }
  return { ok: true, status: 0, stdout: 'ok', stderr: '', error: '' };
}
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

/**
 * A home with one registered session whose log file is larger than a tiny injected cap.
 *
 * The event payload is random bytes, not a repeated character: zstd compresses repetition to almost nothing, and a
 * fixture that stays below the cap would let the refusal tests pass without exercising the refusal.
 *
 * @param {{sizeBytes?: number}} [options]
 */
function largeHomeFixture({ sizeBytes = 8 * 1024 } = {}) {
  const blob = randomBytes(sizeBytes).toString('base64');
  return makeHome({
    sessions: [
      {
        workspace: '--E-GPT--',
        id: 'session-aaaaaaaa-0001',
        events: [event(0), event(1, 'turn/start', { turn: 1, blob })],
      },
    ],
    registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001'] }),
  });
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

  it('refuses a path the manifest cannot express before writing a single block', () => {
    const { home, cleanup } = homeFixture();
    const { root: repo, cleanup: cleanRepo } = repoFixture();
    try {
      const badScan = () => ({
        exists: true,
        scanned_at: new Date().toISOString(),
        dsh_home: home,
        zstd: true,
        totals: {},
        sessions: [
          {
            rel: '/absolute/path/session.v4.jsonl.zstd',
            file: join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd'),
            session_id: 'session-aaaaaaaa-0001',
            workspace: '--E-GPT--',
            format_version: 4,
            ok: true,
            flags: { registered: true, archived: false, pinned: false },
          },
        ],
        attachments: [],
        registry: { ok: true, workspaces: [], registered: new Set(), archived: new Set(), pinned: new Set() },
        exclusions: [],
      });
      const result = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, scan: badScan });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'MANIFEST_REL_PATH');
      assert.match(result.detail, /cannot be expressed as a manifest rel path/u);
      assert.deepEqual(readdirSync(repoPaths(repo).objects), [], 'fail-fast: no block object is written for a bad rel');
    } finally {
      cleanRepo();
      cleanup();
    }
  });

  it(
    'asks the installed Harness about the appended logs when runtime evidence is requested (G5)',
    { skip: HARNESS === null ? 'no DeepSeek Harness installation on this machine' : false },
    () => {
      const home = runtimeValidHome();
      const { root: repo, cleanup: cleanRepo } = repoFixture();
      try {
        const result = runBackup({
          root: repo,
          dshHome: home.home,
          password: PASSWORD,
          platform: 'linux',
          machineKey: false,
          runtimeFutureAppend: true,
        });
        assert.equal(result.ok, true, result.detail);
        assert.equal(result.future_append.evidence, 'static-prefilter');
        assert.equal(result.runtime_future_append.available, true);
        assert.equal(result.runtime_future_append.evidence, 'installed-harness');
        assert.equal(result.runtime_future_append.checked, result.sessions);
        assert.equal(result.runtime_future_append.failed, 0);
      } finally {
        cleanRepo();
        home.cleanup();
      }
    },
  );

  it('still reports runtime evidence as failed when the appended log is refused (no static fallback)', () => {
    const { home, cleanup } = homeFixture();
    const { root: repo, cleanup: cleanRepo } = repoFixture();
    try {
      const broken = framesFor([
        header('session-aaaaaaaa-0001'),
        { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } },
      ]);
      fs.writeFileSync(join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd'), broken);
      const result = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, runtimeFutureAppend: true });
      assert.equal(result.ok, true, result.detail);
      if (result.runtime_future_append.available === true) {
        assert.ok(result.runtime_future_append.failed >= 1, 'the runtime must not accept the broken log');
        assert.equal(result.runtime_future_append.sessions.length, result.runtime_future_append.failed);
      }
    } finally {
      cleanRepo();
      cleanup();
    }
  });

  it('reports the future-append simulation for every session it stores (G3)', () => {
    const { home, cleanup } = homeFixture();
    const { root: repo, cleanup: cleanRepo } = repoFixture();
    try {
      const result = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.future_append.checked, result.sessions);
      assert.equal(result.future_append.failed, 0);
      assert.deepEqual(result.future_append.sessions, []);
    } finally {
      cleanRepo();
      cleanup();
    }
  });

  it('still backs up a broken log -- raw bytes are the evidence -- and reports it as failing the append simulation', () => {
    const { home, cleanup } = homeFixture();
    const { root: repo, cleanup: cleanRepo } = repoFixture();
    try {
      // A seq gap: the backup must preserve it, not refuse it.
      const broken = framesFor([
        header('session-aaaaaaaa-0001'),
        { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } },
      ]);
      const target = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
      fs.writeFileSync(target, broken);

      const result = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.future_append.failed, 1);
      assert.match(result.future_append.sessions[0].rel, /session-aaaaaaaa-0001/u);

      // The stored bytes are the source bytes: hash-compare the rebuilt file later; here prove the manifest digest.
      const snapshot = readSnapshot({ root: repo, snapshotId: result.snapshot_id });
      const entry = snapshot.manifest.files.find((file) => file.rel.includes('session-aaaaaaaa-0001'));
      assert.equal(entry.sha256, sha256Hex(broken));
    } finally {
      cleanRepo();
      cleanup();
    }
  });

  it('never modifies the source logs (bytes and mtime are untouched by a backup)', () => {
    const { home, cleanup } = homeFixture();
    const { root: repo, cleanup: cleanRepo } = repoFixture();
    try {
      const target = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
      const before = { bytes: fs.readFileSync(target), mtime: fs.statSync(target).mtimeMs };
      const result = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true, result.detail);
      assert.deepEqual(fs.readFileSync(target), before.bytes, 'the source log must be byte-identical');
      assert.equal(fs.statSync(target).mtimeMs, before.mtime, 'the source log mtime must not change');
    } finally {
      cleanRepo();
      cleanup();
    }
  });

  it('a dry run on a repository that does not exist writes nothing at all (read-only means read-only)', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-dry-fresh-');
    try {
      const root = join(dir, 'repo');
      const result = runBackup({ root, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, dryRun: true });
      assert.equal(result.ok, true, result.detail);
      assert.ok(result.blocks_new > 0, 'a dry run still reports what it would write');
      assert.equal(existsSync(root), false, 'a dry run must not create the repository it describes');
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

  it('creates an unencrypted repository with no credential at all (the default), and reports it', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-default-none-');
    try {
      const root = join(dir, 'repo');
      const first = runBackup({ root, dshHome: home, platform: 'linux', machineKey: false });
      assert.equal(first.ok, true, `${first.reason_code}: ${first.detail}`);
      assert.equal(first.encryption, 'none', 'the default protection mode is none');
      assert.equal(first.unlocked_via, 'none');
      assert.equal(first.key_created, true);
      assert.deepEqual(first.available_paths, ['none']);
      assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind), ['open']);
      const second = runBackup({ root, dshHome: home, platform: 'linux', machineKey: false });
      assert.equal(second.ok, true, second.detail);
      assert.equal(second.encryption, 'none');
      assert.equal(second.blocks_new, 0, 'the second unencrypted run must still deduplicate');
      assert.equal(JSON.stringify(second).includes(JSON.parse(fs.readFileSync(join(root, 'keys.json'), 'utf8')).envelopes[0].dek), false,
        'the run result never leaks the data key');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('creates a sealed repository when a 4-digit PIN is supplied, and then refuses credential-less runs', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-pin-');
    try {
      const root = join(dir, 'repo');
      const created = runBackup({ root, dshHome: home, password: '1234', platform: 'linux', machineKey: false });
      assert.equal(created.ok, true, created.detail);
      assert.equal(created.encryption, 'sealed');
      assert.equal(created.unlocked_via, 'password');
      const refused = runBackup({ root, dshHome: home, platform: 'linux', machineKey: false });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, 'BACKUP_NO_PERMISSION');
      const reopened = runBackup({ root, dshHome: home, password: '1234', platform: 'linux', machineKey: false });
      assert.equal(reopened.ok, true, reopened.detail);
      assert.equal(reopened.encryption, 'sealed');
      assert.equal(reopened.unlocked_via, 'password');
      assert.equal(reopened.blocks_new, 0);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses an invalid encryption option, and the contradiction of none + a password, before the layout', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-enc-invalid-');
    try {
      const root = join(dir, 'repo');
      const invalid = runBackup({ root, dshHome: home, platform: 'linux', machineKey: false, encryption: 'maybe' });
      assert.equal(invalid.ok, false);
      assert.equal(invalid.reason_code, 'BACKUP_CONFIG_INVALID');
      assert.match(invalid.detail, /encryption must be one of none, sealed/u);
      assert.equal(existsSync(root), false, 'the refusal happens before ensureLayout');

      const contradiction = runBackup({ root, dshHome: home, platform: 'linux', machineKey: false, encryption: 'none', password: '1234' });
      assert.equal(contradiction.ok, false);
      assert.equal(contradiction.reason_code, 'BACKUP_CONFIG_INVALID');
      assert.match(contradiction.detail, /cannot be combined with a password/u);
      assert.equal(existsSync(root), false);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses with BACKUP_NO_PERMISSION when sealed protection is requested with no credential', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-noperm-');
    try {
      const root = join(dir, 'repo');
      const result = runBackup({ root, dshHome: home, platform: 'linux', encryption: 'sealed' });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_NO_PERMISSION');
      assert.match(result.detail, /sealed/u);
      // The refusal happens before the layout: a first run that cannot protect anything must not leave a
      // half-initialised repository behind.
      assert.equal(existsSync(root), false, 'a refused first run must not create the repository');
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

describe('engine: the backup is actually restorable', () => {
  it('reassembles every file from its blocks, byte for byte, with the repository key', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const runResult = run(root, home);
      assert.equal(runResult.ok, true, runResult.detail);
      const key = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: PLATFORM });
      assert.equal(key.ok, true, key.detail ?? '');
      const snapshot = readSnapshot({ root, snapshotId: runResult.snapshot_id });
      assert.equal(snapshot.manifest.counts.files, 4);

      for (const entry of snapshot.manifest.files) {
        const parts = [];
        for (const block of entry.blocks) {
          const object = join(repoPaths(root).objects, block.sha256.slice(0, 2), block.sha256);
          assert.ok(existsSync(object), `missing object for block ${block.sha256}`);
          parts.push(openObject(readFileSync(object), key.dek, { sha256: block.sha256, length: block.length }));
        }
        const rebuilt = Buffer.concat(parts);
        assert.equal(rebuilt.length, entry.size, `block lengths must cover ${entry.rel}`);
        assert.equal(sha256Hex(rebuilt), entry.sha256, `rebuilt bytes must hash to the manifest digest for ${entry.rel}`);
        const source = readFileSync(join(home, entry.rel));
        assert.deepEqual(rebuilt, source, `rebuilt bytes must equal the source for ${entry.rel}`);
      }
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('does not double-encrypt: a block sealed for one identity does not open under another', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const runResult = run(root, home);
      assert.equal(runResult.ok, true);
      const key = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: PLATFORM });
      const snapshot = readSnapshot({ root, snapshotId: runResult.snapshot_id });
      const entry = snapshot.manifest.files.find((row) => row.kind === 'session');
      const block = entry.blocks[0];
      const object = join(repoPaths(root).objects, block.sha256.slice(0, 2), block.sha256);
      assert.throws(
        () => openObject(readFileSync(object), key.dek, { sha256: 'f'.repeat(64), length: block.length }),
        (error) => error.code === 'BACKUP_DECRYPT_AUTH_FAILED',
        'a block must be bound to the content address it was sealed for',
      );
    } finally {
      cleanup();
      cleanHome();
    }
  });
});

describe('engine: crash resilience', () => {
  it('reuses the blocks a crashed run wrote but never committed', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const first = run(root, home);
      assert.equal(first.ok, true);
      // Simulate a crash between "blocks written" and "snapshot committed": the objects stay, the snapshot and
      // the index entry are gone.
      const paths = repoPaths(root);
      for (const name of fs.readdirSync(paths.snapshots)) fs.rmSync(join(paths.snapshots, name), { recursive: true, force: true });
      fs.rmSync(paths.index, { force: true });

      const second = run(root, home);
      assert.equal(second.ok, true, second.detail);
      assert.equal(second.blocks_new, 0, 'previously written blocks must be reused, not rewritten');
      assert.equal(second.blocks_reused, first.blocks_new + first.blocks_reused);
      assert.equal(readIndex(root).entries.length, 1);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('reports the committed snapshot when only the rotation step fails', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const first = run(root, home);
      assert.equal(first.ok, true);
      // A file where the workspace's rotation directory should be makes the version-record write fail.
      fs.writeFileSync(join(root, 'old', '--E-GPT--'), 'not a directory');
      const target = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
      fs.writeFileSync(target, sessionLog('session-aaaaaaaa-0001', [event(9), event(10)]));

      const second = run(root, home);
      assert.equal(second.ok, false, 'the rotation failure must make the run report a problem');
      assert.equal(second.committed, true, 'but the snapshot itself is durable and must be reported as such');
      assert.match(second.snapshot_id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
      assert.equal(readIndex(root).entries.length, 2, 'the index still records the committed snapshot');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('reports a session captured mid-append instead of silently dropping it', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const target = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
      const bytes = fs.readFileSync(target);
      fs.writeFileSync(target, bytes.subarray(0, bytes.length - 1)); // a torn last frame

      const result = run(root, home);
      assert.equal(result.ok, true, result.detail);
      assert.deepEqual(result.torn_sessions, ['sessions/--E-GPT--/session-aaaaaaaa-0001/session.v4.jsonl.zstd']);
      assert.equal(result.sessions, 3, 'the torn session is still backed up, not skipped');

      const clean = runBackup({ root, dshHome: home, password: PASSWORD, platform: PLATFORM, scope: 'selected', selected: ['session-bbbbbbbb-0002'] });
      assert.deepEqual(clean.torn_sessions, [], 'a clean snapshot must not report a torn session');
    } finally {
      cleanup();
      cleanHome();
    }
  });
});

describe('engine: unlocking the way the scheduler will', () => {
  it('upgrades a password-only repository so a later run needs no password', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      // Seeded offline: a password, no OS keystore.
      const created = runBackup({ root, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(created.ok, true, created.detail);
      assert.equal(created.key_created, true);
      assert.equal(created.unlocked_via, 'password');
      assert.equal(created.key_upgraded, false);

      // First run on a machine that can hold a machine envelope: it upgrades the repository.
      const upgraded = runBackup({ root, dshHome: home, password: PASSWORD, platform: 'win32', runner: fakeRunner });
      assert.equal(upgraded.ok, true, upgraded.detail);
      assert.equal(upgraded.key_upgraded, true);
      assert.equal(upgraded.unlocked_via, 'password', 'the password is what opened it this time');
      assert.equal(upgraded.blocks_new, 0, 'an upgrade run must not rewrite the blocks');

      // The point: an unattended run with no password at all now succeeds.
      const scheduled = runBackup({ root, dshHome: home, platform: 'win32', runner: fakeRunner });
      assert.equal(scheduled.ok, true, scheduled.detail);
      assert.equal(scheduled.unlocked_via, 'machine');
      assert.equal(scheduled.key_upgraded, false);
      assert.equal(scheduled.blocks_new, 0);
    } finally {
      cleanup();
      cleanHome();
    }
  });
});

describe('engine: oldFormat full (a literal sealed copy of the superseded version)', () => {
  it('rotates with a decryptable whole-file copy and reports it, while the default reports none', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const first = run(root, home);
      assert.equal(first.ok, true, first.detail);
      assert.equal(first.old_format, 'records', 'records stays the default');
      assert.equal('full_old_versions' in first, false, 'the default result shape is unchanged');

      const target = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
      const superseded = readFileSync(target);
      writeFileSync(target, sessionLog('session-aaaaaaaa-0001', [event(0), event(1), event(2), event(3)]));

      const second = run(root, home, { oldFormat: 'full' });
      assert.equal(second.ok, true, second.detail);
      assert.equal(second.old_format, 'full');
      assert.equal(second.rotated, 1);
      assert.equal(second.full_old_versions.length, 1);

      const record = listOldVersions(root, { sessionId: 'session-aaaaaaaa-0001' })[0]?.record;
      assert.ok(record?.full_copy, 'the version record must name its sealed copy');
      assert.equal(record.full_copy.file, second.full_old_versions[0]);
      const key = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: PLATFORM });
      assert.equal(key.ok, true, key.detail ?? '');
      const opened = openObject(readFileSync(join(root, ...record.full_copy.file.split('/'))), key.dek, {
        sha256: record.full_copy.sha256,
        length: record.full_copy.size,
        kind: 'old',
      });
      assert.deepEqual(opened, superseded, 'the copy must be the superseded version, byte for byte');
      assert.equal(sha256Hex(opened), sha256Hex(superseded));

      // An unchanged session rotates nothing, so it gains neither a record nor a copy.
      const third = run(root, home, { oldFormat: 'full' });
      assert.equal(third.ok, true, third.detail);
      assert.equal(third.rotated, 0);
      assert.deepEqual(third.full_old_versions, []);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses an invalid oldFormat before creating the repository', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-format-invalid-');
    try {
      const repo = join(dir, 'repo');
      const result = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: PLATFORM, oldFormat: 'full-ish' });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_ROTATION_FORMAT_INVALID');
      assert.match(result.detail, /oldFormat/u);
      assert.equal(existsSync(repo), false, 'the refusal happens before ensureLayout');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('reports the committed snapshot when the full copy cannot be written', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const first = run(root, home);
      assert.equal(first.ok, true, first.detail);
      // A file where the workspace's rotation directory should be makes the sealed copy's write fail.
      writeFileSync(join(root, 'old', '--E-GPT--'), 'not a directory');
      const target = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
      writeFileSync(target, sessionLog('session-aaaaaaaa-0001', [event(9), event(10)]));

      const second = run(root, home, { oldFormat: 'full' });
      assert.equal(second.ok, false, 'the copy failure must make the run report a problem');
      assert.equal(second.reason_code, 'BACKUP_ROTATION_WRITE_FAILED');
      assert.equal(second.committed, true, 'the snapshot itself is durable and must be reported as such');
      assert.match(second.snapshot_id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
      assert.equal(readIndex(root).entries.length, 2, 'the index still records the committed snapshot');
      assert.equal(listOldVersions(root).length, 0, 'no record may claim a copy that was never written');
    } finally {
      cleanup();
      cleanHome();
    }
  });
});

describe('engine: the oldFormat full whole-file copy cap and its explicit approval', () => {
  const CAP = 1024;

  it('refuses before writing anything when a session exceeds the cap and the run is not approved', () => {
    const { home, cleanup: cleanHome } = largeHomeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-full-cap-refuse-');
    try {
      const repo = join(dir, 'repo');
      const result = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: PLATFORM, oldFormat: 'full', maxFullCopyBytes: CAP, futureAppend: false });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_FULL_COPY_APPROVAL_REQUIRED');
      assert.deepEqual(result.codes, ['BACKUP_FULL_COPY_APPROVAL_REQUIRED'], 'the named code is in codes for a caller that reads the list');
      assert.equal(result.cap_bytes, CAP);
      assert.equal(result.over_cap_count, 1);
      assert.equal(result.full_copy_oversized.length, 1);
      const row = result.full_copy_oversized[0];
      assert.equal(row.session_id, 'session-aaaaaaaa-0001');
      assert.match(row.rel, /session-aaaaaaaa-0001/u);
      assert.ok(row.size > CAP, 'the fixture session really is over the injected cap');
      assert.equal(row.cap, CAP);
      assert.match(result.detail, /session-aaaaaaaa-0001/u, 'the detail lists the oversized session');
      assert.match(result.detail, /allowLargeFullCopy/u, 'the detail names the approval option');
      assert.equal(existsSync(repo), false, 'the refusal happens before ensureLayout: no repository is created');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses an existing repository without changing a byte (no snapshot, no old record)', () => {
    const { home, cleanup: cleanHome } = largeHomeFixture();
    const { root, cleanup } = repoFixture();
    try {
      const before = treeState(root);
      const result = run(root, home, { oldFormat: 'full', maxFullCopyBytes: CAP, futureAppend: false });
      assert.equal(result.reason_code, 'BACKUP_FULL_COPY_APPROVAL_REQUIRED');
      assert.deepEqual(treeState(root), before, 'the repository is byte-for-byte unchanged');
      assert.equal(readIndex(root).entries.length, 0);
      assert.equal(listOldVersions(root).length, 0);
      assert.deepEqual(readdirSync(repoPaths(root).snapshots), []);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('proceeds when the run is explicitly approved, listing the approval and recording it on the old version', () => {
    const { home, cleanup: cleanHome } = largeHomeFixture();
    const { root, cleanup } = repoFixture();
    try {
      // records mode ignores the cap, so the first snapshot is allowed to create the version to be superseded.
      const first = run(root, home, { futureAppend: false });
      assert.equal(first.ok, true, first.detail);

      const target = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
      const superseded = readFileSync(target);
      const blob = randomBytes(8 * 1024).toString('base64');
      writeFileSync(target, sessionLog('session-aaaaaaaa-0001', [event(0), event(1), event(2, 'turn/start', { turn: 2, blob })]));

      // Without the flag: refused, and the committed first snapshot stays the newest one.
      const refused = run(root, home, { oldFormat: 'full', maxFullCopyBytes: CAP, futureAppend: false });
      assert.equal(refused.reason_code, 'BACKUP_FULL_COPY_APPROVAL_REQUIRED');
      assert.equal(readIndex(root).entries.length, 1, 'no new snapshot was committed');

      // Explicit approval: the run writes, the result records which sessions were approved, and the version
      // record itself carries the approval next to the copy it paid for.
      const approved = run(root, home, { oldFormat: 'full', maxFullCopyBytes: CAP, allowLargeFullCopy: true, futureAppend: false });
      assert.equal(approved.ok, true, approved.detail);
      assert.equal(approved.rotated, 1);
      assert.equal(approved.full_old_versions.length, 1);
      assert.equal(approved.full_copy_approved_over_cap.length, 1);
      assert.equal(approved.full_copy_approved_over_cap[0].session_id, 'session-aaaaaaaa-0001');
      assert.ok(approved.full_copy_approved_over_cap[0].size > CAP);
      assert.equal(readIndex(root).entries.length, 2);

      const record = listOldVersions(root, { sessionId: 'session-aaaaaaaa-0001' })[0]?.record;
      assert.ok(record?.full_copy, 'the rotation wrote the sealed copy');
      assert.equal(record.full_copy.approved_over_cap, true);
      assert.equal(record.full_copy.cap_bytes, CAP);
      // The copy is still the superseded version, byte for byte, under the old-copy identity.
      const key = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: PLATFORM });
      assert.equal(key.ok, true, key.detail ?? '');
      const opened = openObject(readFileSync(join(root, ...record.full_copy.file.split('/'))), key.dek, {
        sha256: record.full_copy.sha256,
        length: record.full_copy.size,
        kind: 'old',
      });
      assert.deepEqual(opened, superseded);
      assert.equal(sha256Hex(opened), record.sha256);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('treats only a literal true as approval, and records mode ignores the cap entirely', () => {
    const { home, cleanup: cleanHome } = largeHomeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-full-cap-flag-');
    try {
      const truthy = runBackup({ root: join(dir, 'truthy'), dshHome: home, password: PASSWORD, platform: PLATFORM, oldFormat: 'full', maxFullCopyBytes: CAP, allowLargeFullCopy: 1, futureAppend: false });
      assert.equal(truthy.reason_code, 'BACKUP_FULL_COPY_APPROVAL_REQUIRED', 'a truthy non-boolean is not an approval');
      const records = runBackup({ root: join(dir, 'records'), dshHome: home, password: PASSWORD, platform: PLATFORM, maxFullCopyBytes: CAP, futureAppend: false });
      assert.equal(records.ok, true, records.detail);
      assert.equal(records.old_format, 'records');
      assert.equal('full_copy_approved_over_cap' in records, false);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('treats 0 as no cap and rejects an invalid cap before creating the repository', () => {
    const { home, cleanup: cleanHome } = largeHomeFixture();
    const { dir, cleanup } = tempDir('w2m-engine-full-cap-zero-');
    try {
      const open = runBackup({ root: join(dir, 'open'), dshHome: home, password: PASSWORD, platform: PLATFORM, oldFormat: 'full', maxFullCopyBytes: 0, futureAppend: false });
      assert.equal(open.ok, true, open.detail);
      assert.equal(open.old_format, 'full');
      assert.equal('full_copy_approved_over_cap' in open, false, 'no approval was needed, so none is claimed');

      for (const bad of [-1, 1.5, '1024', true]) {
        const repo = join(dir, `bad-${String(bad).replace(/[^0-9a-z]/gu, '')}`);
        const refused = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: PLATFORM, oldFormat: 'full', maxFullCopyBytes: bad });
        assert.equal(refused.ok, false, `maxFullCopyBytes=${String(bad)} must be refused`);
        assert.equal(refused.reason_code, 'BACKUP_ROTATION_POLICY_INVALID');
        assert.match(refused.detail, /maxFullCopyBytes must be/u);
        assert.equal(existsSync(repo), false, 'the invalid option is refused before ensureLayout');
      }
    } finally {
      cleanup();
      cleanHome();
    }
  });
});