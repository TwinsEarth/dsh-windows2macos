/**
 * Garbage collection: delete only what nothing references, and refuse to guess when a reference is unreadable.
 *
 * The dangerous direction is over-deletion, so every "unreadable root" case is asserted to leave the whole store
 * intact. The useful direction is under-deletion, asserted by orphan removal and by the reference counts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { collectOrphanFullCopies, gc, collectReferences, listFullCopies, listObjects, STALE_TMP_MS } from '../src/backup/gc.mjs';
import { LOCK_FILE } from '../src/backup/locks.mjs';
import { ensureLayout, repoPaths } from '../src/backup/layout.mjs';
import { buildManifest } from '../src/backup/manifest.mjs';
import { commitSnapshot, makeSnapshotId } from '../src/backup/repo.mjs';
import { OLD_FORMAT, writeCurrentPointer, recordSupersededVersion, listOldVersions, measureOldUsage } from '../src/backup/rotation.mjs';
import { MIN_SCRYPT, randomDek, wrapDek } from '../src/backup/crypto.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

const KDF = { algo: 'scrypt', N: MIN_SCRYPT.N, r: MIN_SCRYPT.r, p: MIN_SCRYPT.p, keylen: 32 };

/**
 * A repository with one committed snapshot whose single session file has `content`.
 *
 * The file is a session-shaped path name so the manifest's path validation accepts it; the bytes are arbitrary
 * because gc only reads block digests.
 */
function repoWithSnapshot(content = Buffer.from('block-bytes'.repeat(64))) {
  const { dir, cleanup } = tempDir('w2m-gc-');
  const root = join(dir, 'repo');
  ensureLayout(root);
  const home = join(dir, 'home');
  const file = join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001', 'session.v4.jsonl.zstd');
  mkdirSync(join(home, 'sessions', '--E-GPT--', 'session-aaaaaaaa-0001'), { recursive: true });
  writeFileSync(file, content);
  const snapshotId = makeSnapshotId(new Date('2026-11-17T14:00:00.000Z'), 'deadbeef');
  const manifest = buildManifest({
    snapshotId,
    createdAt: new Date('2026-11-17T14:00:00.000Z'),
    dshHome: home,
    sessions: [{ rel: 'sessions/--E-GPT--/session-aaaaaaaa-0001/session.v4.jsonl.zstd', file, session_id: 'session-aaaaaaaa-0001', workspace: '--E-GPT--', format_version: 4, flags: { registered: true, archived: false, pinned: false } }],
  });
  const keys = wrapDek(randomDek(), [{ kind: 'password', secret: 'pw' }], { kdf: KDF });
  commitSnapshot({ root, manifest, keys });
  return { dir, root, home, cleanup, snapshotId, manifest };
}

/** Write an object file with a made-up but well-formed content address. */
function putObject(root, sha256, bytes = 10) {
  const dir = join(repoPaths(root).objects, sha256.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sha256), Buffer.alloc(bytes, 1));
  return join(dir, sha256);
}

describe('gc: reference collection', () => {
  it('counts snapshot blocks plus old-version and current-pointer references', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const entry = manifest.files[0];
      writeCurrentPointer({ root, entry, snapshotId: '20261117T140000Z-deadbeef' });
      recordSupersededVersion({
        root,
        previous: { ...entry, snapshot_id: '20261117T130000Z-deadbeef', updated_at: '2026-11-17T13:00:00.000Z' },
        snapshotId: '20261117T140000Z-deadbeef',
      });
      const refs = collectReferences(root);
      assert.equal(refs.ok, true, JSON.stringify(refs.problems));
      assert.equal(refs.counts.snapshots, 1);
      assert.equal(refs.counts.old, 1);
      assert.equal(refs.counts.current, 1);
      for (const block of entry.blocks) assert.ok(refs.blocks.has(block.sha256));
    } finally {
      cleanup();
    }
  });
});

describe('gc: deleting orphans', () => {
  it('removes an unreferenced block and keeps every referenced one', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      // The referenced blocks must exist as objects, or "kept" would be asserted about files that never existed.
      for (const block of manifest.files[0].blocks) putObject(root, block.sha256, block.length);
      const orphan = 'f'.repeat(64);
      putObject(root, orphan, 32);
      const before = listObjects(root).length;
      const result = gc({ root });
      assert.equal(result.ok, true);
      assert.equal(result.safe, true);
      assert.equal(result.blocks.removed, 1);
      assert.equal(result.blocks.reclaimed_bytes, 32);
      assert.equal(result.blocks.kept, before - 1);
      assert.equal(existsSync(join(repoPaths(root).objects, orphan.slice(0, 2), orphan)), false);
      for (const block of manifest.files[0].blocks) {
        assert.equal(existsSync(join(repoPaths(root).objects, block.sha256.slice(0, 2), block.sha256)), true);
      }
    } finally {
      cleanup();
    }
  });

  it('reports what it would delete in a dry run, and deletes nothing', () => {
    const { root, cleanup } = repoWithSnapshot();
    try {
      const orphan = 'e'.repeat(64);
      const file = putObject(root, orphan, 8);
      const result = gc({ root, dryRun: true });
      assert.equal(result.safe, true);
      assert.equal(result.blocks.removed, 1);
      assert.equal(result.blocks.reclaimed_bytes, 8);
      assert.equal(existsSync(file), true, 'a dry run must not delete');
    } finally {
      cleanup();
    }
  });

  it('prunes old versions by the retention window in the same pass', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const entry = manifest.files[0];
      for (let index = 0; index < 4; index += 1) {
        recordSupersededVersion({
          root,
          previous: {
            ...entry,
            sha256: String(index + 1).repeat(64),
            blocks: [{ index: 0, offset: 0, length: entry.size, sha256: String(index + 1).repeat(64) }],
            updated_at: new Date(Date.UTC(2026, 10, 17, index, 0, 0)).toISOString(),
          },
          snapshotId: `20261117T0${index}0000Z-deadbeef`,
          now: new Date(Date.UTC(2026, 10, 17, index, 0, 0)),
        });
      }
      const result = gc({ root, keepOldPerSession: 1 });
      assert.equal(result.safe, true);
      assert.equal(result.old_versions.pruned, 3);
    } finally {
      cleanup();
    }
  });
});

describe('gc: the age retention window', () => {
  /** A version record `days` days old, with its own block list. */
  function recordOldVersion(root, entry, name, days) {
    const sha = name.repeat(64);
    const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return recordSupersededVersion({
      root,
      previous: { ...entry, sha256: sha, blocks: [{ index: 0, offset: 0, length: 10, sha256: sha }], updated_at: when.toISOString() },
      snapshotId: `20261117T000000Z-${name.repeat(8).slice(0, 8)}`,
      now: when,
    });
  }

  it('prunes old records by the age window in addition to the per-session count', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const entry = manifest.files[0];
      recordOldVersion(root, entry, 'a', 1);
      recordOldVersion(root, entry, 'b', 50);
      recordOldVersion(root, entry, 'c', 100);
      assert.equal(listOldVersions(root).length, 3);
      const result = gc({ root, keepOldPerSession: 10, maxOldVersionDays: 30 });
      assert.equal(result.safe, true);
      assert.equal(result.old_versions.pruned, 2);
      assert.equal(result.old_versions.pruned_by_age, 2);
      assert.equal(listOldVersions(root).length, 1, 'only the record inside the age window remains');
    } finally {
      cleanup();
    }
  });

  it('never deletes a block a live snapshot references, and leaves a pruned record\'s block for the next run', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      for (const block of manifest.files[0].blocks) putObject(root, block.sha256, block.length);
      const oldBlock = 'e'.repeat(64);
      putObject(root, oldBlock, 16);
      recordOldVersion(root, manifest.files[0], 'e', 90);
      const result = gc({ root, keepOldPerSession: 10, maxOldVersionDays: 30 });
      assert.equal(result.safe, true);
      assert.equal(result.old_versions.pruned_by_age, 1);
      for (const block of manifest.files[0].blocks) {
        assert.equal(
          existsSync(join(repoPaths(root).objects, block.sha256.slice(0, 2), block.sha256)),
          true,
          'a live snapshot block must never be deleted',
        );
      }
      assert.equal(
        existsSync(join(repoPaths(root).objects, oldBlock.slice(0, 2), oldBlock)),
        true,
        'the reference set is collected before any deletion, so a block referenced only by a record pruned in this run survives at least this run',
      );
    } finally {
      cleanup();
    }
  });

  it('plans age pruning in a dry run, and deletes nothing', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const { file } = recordOldVersion(root, manifest.files[0], 'a', 90);
      const result = gc({ root, keepOldPerSession: 10, maxOldVersionDays: 30, dryRun: true });
      assert.equal(result.safe, true);
      assert.equal(result.dry_run, true);
      assert.equal(result.old_versions.pruned, 1);
      assert.equal(result.old_versions.pruned_by_age, 1);
      assert.equal(existsSync(file), true, 'a dry run must not delete');
    } finally {
      cleanup();
    }
  });

  it('uses the injected nowMs as the age-rule clock, not the wall clock', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const when = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      recordSupersededVersion({
        root,
        previous: { ...manifest.files[0], sha256: '1'.repeat(64), blocks: [{ index: 0, offset: 0, length: 10, sha256: '1'.repeat(64) }], updated_at: when.toISOString() },
        snapshotId: '20261117T000000Z-deadbeef',
        now: when,
      });
      // The record is 100 days old against the wall clock, but the injected clock is 200 days earlier: by the
      // supplied instant the record is not old at all, so the wall clock must not be what decided it.
      const result = gc({ root, keepOldPerSession: 10, maxOldVersionDays: 30, nowMs: Date.now() - 200 * 24 * 60 * 60 * 1000 });
      assert.equal(result.safe, true);
      assert.equal(result.old_versions.pruned_by_age, 0);
      assert.equal(result.old_versions.pruned, 0);
      assert.equal(listOldVersions(root).length, 1);
    } finally {
      cleanup();
    }
  });

  it('refuses an invalid age window before taking the lock and before deleting anything', () => {
    const { root, cleanup } = repoWithSnapshot();
    try {
      putObject(root, 'd'.repeat(64), 8);
      const result = gc({ root, maxOldVersionDays: -1 });
      assert.equal(result.ok, false);
      assert.equal(result.safe, false);
      assert.equal(result.reason_code, 'BACKUP_ROTATION_POLICY_INVALID');
      assert.match(result.detail, /maxAgeDays/u);
      assert.equal(existsSync(join(repoPaths(root).objects, 'd'.repeat(2), 'd'.repeat(64))), true, 'nothing may be deleted');
      assert.equal(existsSync(join(repoPaths(root).tmp, LOCK_FILE)), false, 'the policy is validated before the lock');
    } finally {
      cleanup();
    }
  });

  it('keeps the BACKUP_GC_UNSAFE refusal exactly as it was when an age window is configured', () => {
    const { root, cleanup, snapshotId, manifest } = repoWithSnapshot();
    try {
      recordOldVersion(root, manifest.files[0], 'a', 90);
      writeFileSync(join(repoPaths(root).snapshots, snapshotId, 'manifest.json'), '{ not json');
      const result = gc({ root, maxOldVersionDays: 30 });
      assert.equal(result.safe, false);
      assert.equal(result.reason_code, 'BACKUP_GC_UNSAFE');
      assert.equal(result.old_versions.pruned, 0);
      assert.equal(listOldVersions(root).length, 1, 'an unsafe gc must prune nothing');
    } finally {
      cleanup();
    }
  });
});

describe('gc: refusing to guess', () => {
  it('refuses and deletes nothing when a snapshot manifest is unreadable', () => {
    const { root, cleanup, snapshotId } = repoWithSnapshot();
    try {
      putObject(root, 'd'.repeat(64), 4);
      const objectsBefore = listObjects(root).length;
      writeFileSync(join(repoPaths(root).snapshots, snapshotId, 'manifest.json'), '{ not json');
      const result = gc({ root });
      assert.equal(result.ok, false);
      assert.equal(result.safe, false);
      assert.equal(result.reason_code, 'BACKUP_GC_UNSAFE');
      assert.ok(result.problems.length >= 1);
      assert.equal(listObjects(root).length, objectsBefore, 'nothing may be deleted when a reference is unreadable');
    } finally {
      cleanup();
    }
  });

  it('refuses when an old-version record is unreadable', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const entry = manifest.files[0];
      const { file } = recordSupersededVersion({ root, previous: { ...entry, snapshot_id: 'x' }, snapshotId: 'y' });
      writeFileSync(file, 'not json at all');
      putObject(root, 'c'.repeat(64), 4);
      const result = gc({ root });
      assert.equal(result.safe, false);
      assert.equal(existsSync(join(repoPaths(root).objects, 'c'.repeat(2), 'c'.repeat(64))), true);
    } finally {
      cleanup();
    }
  });

  it('refuses when a current pointer is unreadable', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const entry = manifest.files[0];
      writeCurrentPointer({ root, entry, snapshotId: 'x' });
      const pointerFile = join(root, 'current', '--E-GPT--', 'session-aaaaaaaa-0001.json');
      renameSync(pointerFile, `${pointerFile}.bak`);
      writeFileSync(pointerFile, '{"broken":');
      putObject(root, 'b'.repeat(64), 4);
      const result = gc({ root });
      assert.equal(result.safe, false);
      assert.equal(result.reason_code, 'BACKUP_GC_UNSAFE');
    } finally {
      cleanup();
    }
  });

  it('is a no-op on an empty repository', () => {
    const { dir, cleanup } = tempDir('w2m-gc-empty-');
    try {
      const root = join(dir, 'repo');
      ensureLayout(root);
      const result = gc({ root });
      assert.equal(result.ok, true);
      assert.equal(result.safe, true);
      assert.equal(result.blocks.scanned, 0);
      assert.equal(result.references.snapshots, 0);
    } finally {
      cleanup();
    }
  });
});

describe('gc: leftovers and locking', () => {
  it('removes a crashed writer\'s stale temp files and keeps recent ones', () => {
    const { root, cleanup } = repoWithSnapshot();
    try {
      const objectsRoot = repoPaths(root).objects;
      const stale = join(objectsRoot, 'aa', '.object.tmp-1-1-1');
      const recent = join(objectsRoot, 'aa', '.object.tmp-2-2-2');
      mkdirSync(join(objectsRoot, 'aa'), { recursive: true });
      writeFileSync(stale, Buffer.alloc(7, 1));
      writeFileSync(recent, Buffer.alloc(9, 1));
      const old = new Date(Date.now() - STALE_TMP_MS - 60_000);
      utimesSync(stale, old, old);

      const before = gc({ root, dryRun: true });
      assert.equal(before.tmp.scanned, 2);
      assert.equal(before.tmp.removed, 1, 'only the stale temp file is reported for removal');
      assert.equal(existsSync(stale), true);

      const result = gc({ root });
      assert.equal(result.safe, true);
      assert.equal(result.tmp.removed, 1);
      assert.equal(result.tmp.reclaimed_bytes, 7);
      assert.equal(existsSync(stale), false);
      assert.equal(existsSync(recent), true, 'a recent temp file may belong to a running writer');
    } finally {
      cleanup();
    }
  });

  it('removes an empty object prefix directory, and never touches the lock', () => {
    const { root, cleanup } = repoWithSnapshot();
    try {
      const prefix = join(repoPaths(root).objects, 'ff');
      mkdirSync(prefix, { recursive: true });
      const result = gc({ root });
      assert.equal(result.safe, true);
      assert.equal(result.empty_prefixes_removed, 1);
      assert.equal(existsSync(prefix), false);
    } finally {
      cleanup();
    }
  });

  it('refuses to run while a backup lock is held', () => {
    const { root, cleanup } = repoWithSnapshot();
    try {
      putObject(root, 'e'.repeat(64), 4);
      const objectsBefore = listObjects(root).length;
      writeFileSync(
        join(repoPaths(root).tmp, LOCK_FILE),
        JSON.stringify({ format: 'w2m-session-backup/lock/1', pid: process.pid, host: os.hostname(), started_at: new Date().toISOString() }),
      );
      const result = gc({ root });
      assert.equal(result.ok, false);
      assert.equal(result.safe, false);
      assert.equal(result.reason_code, 'BACKUP_LOCKED');
      assert.equal(listObjects(root).length, objectsBefore, 'a locked gc must delete nothing');
    } finally {
      cleanup();
    }
  });
});

/** Write one v1 version record that points at a sealed copy, creating both files. */
function putFullCopyRecord(root, entry, name) {
  const dir = join(root, 'old', entry.workspace, entry.session_id);
  mkdirSync(dir, { recursive: true });
  const copyName = `${name}.json.enc`;
  const copy = join(dir, copyName);
  writeFileSync(copy, Buffer.alloc(24, 7));
  const record = {
    format: OLD_FORMAT,
    version: 1,
    rel: entry.rel,
    session_id: entry.session_id,
    workspace: entry.workspace,
    sha256: entry.sha256,
    size: entry.size,
    blocks: entry.blocks,
    snapshot_id: `${name}-snap`,
    superseded_by: `${name}-next`,
    recorded_at: '2026-11-17T13:00:00.000Z',
    full_copy: { file: `old/${entry.workspace}/${entry.session_id}/${copyName}`, sha256: entry.sha256, size: entry.size },
  };
  const recordFile = join(dir, `${name}.json`);
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  return { recordFile, copy };
}

describe('gc: whole-file copies (oldFormat: full)', () => {
  it('removes a sealed copy no record references and keeps the one a record points at', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const entry = manifest.files[0];
      const { copy } = putFullCopyRecord(root, entry, '20261117T130000Z-aaaaaaaaaaaa');
      const orphan = join(root, 'old', entry.workspace, entry.session_id, '20261117T120000Z-bbbbbbbbbbbb.json.enc');
      writeFileSync(orphan, Buffer.alloc(9, 1));
      assert.equal(listFullCopies(root).length, 2);
      assert.deepEqual(collectOrphanFullCopies({ root, dryRun: true }).files, [orphan]);

      const result = gc({ root });
      assert.equal(result.safe, true);
      assert.equal(result.ok, true);
      assert.deepEqual(result.orphan_full_copies, { scanned: 2, removed: 1, reclaimed_bytes: 9 });
      assert.equal(existsSync(orphan), false);
      assert.equal(existsSync(copy), true, 'a copy a live record references must never be deleted');
      assert.equal(listOldVersions(root).length, 1);

      const second = gc({ root });
      assert.equal(second.orphan_full_copies.removed, 0, 'a second gc has nothing left to collect');
      assert.equal(existsSync(copy), true);
    } finally {
      cleanup();
    }
  });

  it('prunes a record and its paired copy together, so nothing is left for the orphan sweep', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const { recordFile, copy } = putFullCopyRecord(root, manifest.files[0], '20261117T130000Z-aaaaaaaaaaaa');
      const result = gc({ root, keepOldPerSession: 0 });
      assert.equal(result.safe, true);
      assert.equal(result.old_versions.pruned, 1);
      assert.equal(result.old_versions.full_copies_pruned, 1);
      assert.equal(result.orphan_full_copies.scanned, 0, 'the paired copy was already deleted with its record');
      assert.equal(existsSync(recordFile), false);
      assert.equal(existsSync(copy), false);
    } finally {
      cleanup();
    }
  });

  it('reports orphan copies in a dry run and deletes nothing', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      const entry = manifest.files[0];
      putFullCopyRecord(root, entry, '20261117T130000Z-aaaaaaaaaaaa');
      const orphan = join(root, 'old', entry.workspace, entry.session_id, '20261117T110000Z-cccccccccccc.json.enc');
      writeFileSync(orphan, Buffer.alloc(5, 1));
      const result = gc({ root, dryRun: true });
      assert.equal(result.dry_run, true);
      assert.equal(result.orphan_full_copies.scanned, 2);
      assert.equal(result.orphan_full_copies.removed, 1);
      assert.equal(result.orphan_full_copies.reclaimed_bytes, 5);
      assert.equal(existsSync(orphan), true, 'a dry run must not delete');
    } finally {
      cleanup();
    }
  });

  it('the unsafe refusal still wins: an unreadable reference deletes no orphan copy either', () => {
    const { root, cleanup, snapshotId, manifest } = repoWithSnapshot();
    try {
      const entry = manifest.files[0];
      const orphan = join(root, 'old', entry.workspace, entry.session_id, '20261117T110000Z-cccccccccccc.json.enc');
      mkdirSync(join(root, 'old', entry.workspace, entry.session_id), { recursive: true });
      writeFileSync(orphan, Buffer.alloc(5, 1));
      writeFileSync(join(repoPaths(root).snapshots, snapshotId, 'manifest.json'), '{ not json');
      const result = gc({ root });
      assert.equal(result.safe, false);
      assert.equal(result.reason_code, 'BACKUP_GC_UNSAFE');
      assert.equal(result.orphan_full_copies.removed, 0);
      assert.equal(existsSync(orphan), true, 'an unsafe gc deletes nothing, including orphan copies');
    } finally {
      cleanup();
    }
  });
});

describe('gc: old/ usage before and after (24.3)', () => {
  /** Two record-only old versions of the fixture's session, each with its own block list. */
  function seedOldVersions(root, entry) {
    for (let index = 0; index < 2; index += 1) {
      const sha = String(index + 1).repeat(64);
      recordSupersededVersion({
        root,
        previous: {
          ...entry,
          sha256: sha,
          blocks: [{ index: 0, offset: 0, length: entry.size, sha256: sha }],
          updated_at: new Date(Date.UTC(2026, 10, 17, index, 0, 0)).toISOString(),
        },
        snapshotId: `20261117T0${index}0000Z-deadbeef`,
        now: new Date(Date.UTC(2026, 10, 17, index, 0, 0)),
      });
    }
  }

  it('reports the old/ tree before and after a pass, and a dry run reports it unchanged', () => {
    const { root, cleanup, manifest } = repoWithSnapshot();
    try {
      seedOldVersions(root, manifest.files[0]);

      const dry = gc({ root, dryRun: true, keepOldPerSession: 1 });
      assert.equal(dry.safe, true);
      assert.equal(dry.old_usage.before.files, 2);
      assert.ok(dry.old_usage.before.bytes > 0, 'the two record JSON files have a size');
      assert.deepEqual(dry.old_usage.after, dry.old_usage.before, 'a dry run deletes nothing, so before == after');
      assert.equal(listOldVersions(root).length, 2);

      const applied = gc({ root, keepOldPerSession: 1 });
      assert.equal(applied.safe, true);
      assert.equal(applied.old_versions.pruned, 1);
      assert.equal(applied.old_usage.before.files, 2);
      assert.equal(applied.old_usage.after.files, 1, 'the pruned record is gone from the after measurement');
      assert.ok(applied.old_usage.after.bytes < applied.old_usage.before.bytes);
      assert.equal(listOldVersions(root).length, 1);
      // The before/after numbers are the same measurement the engine uses for the usage reminder: a hand walk of
      // what remains equals the reported `after`.
      assert.deepEqual(measureOldUsage(root), applied.old_usage.after);
    } finally {
      cleanup();
    }
  });
});