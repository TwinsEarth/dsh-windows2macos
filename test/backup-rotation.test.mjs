/**
 * Rotation: a restorable record of every superseded session version, grouped by session and bounded.
 *
 * The two behaviours worth pinning are the ones a user would notice if they broke: an unchanged session must NOT
 * invent a new version (or "keep 10" really means "10 days"), and a changed one must leave a record whose block
 * list restores the previous bytes exactly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CURRENT_FORMAT,
  DEFAULT_FULL_COPY_MAX_BYTES,
  DEFAULT_KEEP_OLD,
  DEFAULT_OLD_FORMAT,
  OLD_FORMAT,
  OLD_FORMATS,
  OLD_VERSION,
  ROTATION_CODES,
  RotationError,
  currentPath,
  currentRel,
  fullCopyPathFor,
  listOldVersions,
  oldFullCopyPath,
  oldVersionPath,
  pruneOldVersions,
  readCurrent,
  recordSupersededVersion,
  resolveMaxAgeDays,
  resolveMaxFullCopyBytes,
  resolveOldFormat,
  rotateForEntry,
  selectPrunable,
  writeCurrentPointer,
} from '../src/backup/rotation.mjs';
import { MIN_SCRYPT, OLD_COPY_KIND, openObject, randomDek, sealObject } from '../src/backup/crypto.mjs';
import { ensureLayout, repoPaths } from '../src/backup/layout.mjs';
import { openRepoKey } from '../src/backup/keystore.mjs';
import { SEALED_COPY_OVERHEAD, backfillOldFullCopies } from '../src/backup/old-backfill.mjs';
import { formatOldBackfill, main, parseArgs } from '../src/backup/cli.mjs';
import { readJsonSafe } from '../src/backup/atomic.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

const ENTRY = {
  rel: 'sessions/--E-GPT--/session-aaaaaaaa-0001/session.v4.jsonl.zstd',
  session_id: 'session-aaaaaaaa-0001',
  workspace: '--E-GPT--',
  sha256: 'a'.repeat(64),
  size: 10,
  blocks: [{ index: 0, offset: 0, length: 10, sha256: 'a'.repeat(64) }],
};

const CHANGED = { ...ENTRY, sha256: 'b'.repeat(64), blocks: [{ index: 0, offset: 0, length: 12, sha256: 'b'.repeat(64) }] };

describe('rotation: current pointers', () => {
  it('derives a per-session pointer path and writes it atomically', () => {
    const { dir, cleanup } = tempDir('w2m-rot-current-');
    try {
      assert.equal(currentRel(ENTRY), 'current/--E-GPT--/session-aaaaaaaa-0001.json');
      const pointer = writeCurrentPointer({ root: dir, entry: ENTRY, snapshotId: '20261117T140000Z-deadbeef' });
      assert.equal(pointer.format, CURRENT_FORMAT);
      const file = currentPath(dir, ENTRY);
      assert.equal(existsSync(file), true);
      const read = readCurrent(dir, ENTRY);
      assert.equal(read.sha256, ENTRY.sha256);
      assert.equal(read.snapshot_id, '20261117T140000Z-deadbeef');
    } finally {
      cleanup();
    }
  });

  it('returns null for an absent or foreign pointer instead of throwing', () => {
    const { dir, cleanup } = tempDir('w2m-rot-missing-');
    try {
      assert.equal(readCurrent(dir, ENTRY), null);
    } finally {
      cleanup();
    }
  });
});

describe('rotation: records', () => {
  it('writes a record under old/<workspace>/<session>/<stamp>-<sha12>.json', () => {
    const { dir, cleanup } = tempDir('w2m-rot-record-');
    try {
      const previous = {
        ...ENTRY,
        snapshot_id: '20261117T140000Z-deadbeef',
        updated_at: '2026-11-17T14:00:00.000Z',
        rel: ENTRY.rel,
      };
      const { file, record } = recordSupersededVersion({ root: dir, previous, snapshotId: '20261117T150000Z-feedface', now: new Date('2026-11-17T15:00:00.000Z') });
      assert.match(file, /old[\\/]--E-GPT--[\\/]session-aaaaaaaa-0001[\\/]20261117T140000Z-aaaaaaaaaaaa\.json$/u);
      assert.equal(record.format, OLD_FORMAT);
      assert.equal(record.sha256, ENTRY.sha256);
      assert.equal(record.superseded_by, '20261117T150000Z-feedface');
      assert.deepEqual(record.blocks, ENTRY.blocks);
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(parsed.format, OLD_FORMAT);
    } finally {
      cleanup();
    }
  });

  it('refuses an entry without a block list, because a version record that cannot restore is a lie', () => {
    const { dir, cleanup } = tempDir('w2m-rot-invalid-');
    try {
      assert.throws(
        () => recordSupersededVersion({ root: dir, previous: { ...ENTRY, blocks: undefined }, snapshotId: 'x' }),
        (error) => error instanceof RotationError && error.code === 'BACKUP_ROTATION_ENTRY_INVALID',
      );
    } finally {
      cleanup();
    }
  });
});

describe('rotation: the decision', () => {
  it('does not rotate when the content digest is unchanged', () => {
    const { dir, cleanup } = tempDir('w2m-rot-unchanged-');
    try {
      writeCurrentPointer({ root: dir, entry: ENTRY, snapshotId: '20261117T140000Z-deadbeef' });
      const result = rotateForEntry({ root: dir, entry: ENTRY, snapshotId: '20261117T150000Z-feedface' });
      assert.equal(result.unchanged, true);
      assert.equal(result.rotated, false);
      assert.equal(listOldVersions(dir).length, 0, 'an unchanged session must not manufacture a version');
    } finally {
      cleanup();
    }
  });

  it('rotates when the digest changed, and moves the pointer forward', () => {
    const { dir, cleanup } = tempDir('w2m-rot-change-');
    try {
      writeCurrentPointer({ root: dir, entry: ENTRY, snapshotId: '20261117T140000Z-deadbeef' });
      const result = rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface' });
      assert.equal(result.rotated, true);
      assert.equal(result.previous_sha256, ENTRY.sha256);
      assert.equal(listOldVersions(dir).length, 1);
      const pointer = readCurrent(dir, CHANGED);
      assert.equal(pointer.sha256, CHANGED.sha256);
      assert.equal(pointer.snapshot_id, '20261117T150000Z-feedface');
    } finally {
      cleanup();
    }
  });

  it('writes nothing in a dry run', () => {
    const { dir, cleanup } = tempDir('w2m-rot-dry-');
    try {
      writeCurrentPointer({ root: dir, entry: ENTRY, snapshotId: '20261117T140000Z-deadbeef' });
      const before = readJsonSafe(currentPath(dir, ENTRY));
      const result = rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', dryRun: true });
      assert.equal(result.rotated, true);
      assert.deepEqual(readJsonSafe(currentPath(dir, ENTRY)), before);
      assert.equal(listOldVersions(dir).length, 0);
    } finally {
      cleanup();
    }
  });
});

describe('rotation: the retention window', () => {
  it('keeps the newest N versions per session and prunes the rest', () => {
    const { dir, cleanup } = tempDir('w2m-rot-prune-');
    try {
      // Five distinct versions, recorded oldest-first.
      for (let index = 0; index < 5; index += 1) {
        const sha = String(index + 1).repeat(64);
        recordSupersededVersion({
          root: dir,
          previous: { ...ENTRY, sha256: sha, blocks: [{ index: 0, offset: 0, length: 10, sha256: sha }], updated_at: new Date(Date.UTC(2026, 10, 17, index, 0, 0)).toISOString() },
          snapshotId: `20261117T0${index}0000Z-deadbeef`,
          now: new Date(Date.UTC(2026, 10, 17, index, 0, 0)),
        });
      }
      assert.equal(listOldVersions(dir).length, 5);
      const pruned = pruneOldVersions({ root: dir, keep: 2 });
      assert.equal(pruned.kept, 2);
      assert.equal(pruned.removed.length, 3);
      assert.equal(listOldVersions(dir).length, 2);
    } finally {
      cleanup();
    }
  });

  it('prunes nothing in a dry run', () => {
    const { dir, cleanup } = tempDir('w2m-rot-prune-dry-');
    try {
      recordSupersededVersion({ root: dir, previous: ENTRY, snapshotId: 'x' });
      const result = pruneOldVersions({ root: dir, keep: 0, dryRun: true });
      assert.equal(result.removed.length, 1);
      assert.equal(listOldVersions(dir).length, 1);
    } finally {
      cleanup();
    }
  });

  it('uses the documented default window', () => {
    assert.equal(DEFAULT_KEEP_OLD, 10);
    const { dir, cleanup } = tempDir('w2m-rot-default-');
    try {
      assert.equal(listOldVersions(dir).length, 0);
    } finally {
      cleanup();
    }
  });
});

/** A fixed instant so age decisions are deterministic. */
const NOW = new Date('2026-11-17T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO timestamp `daysAgo` days before {@link NOW}. */
const at = (daysAgo) => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

/** One `listOldVersions`-shaped row, with the recorded stamp controlled by `daysAgo`. */
const row = (name, daysAgo) => ({
  file: `old/${name}.json`,
  record: { session_id: 'session-aaaaaaaa-0001', workspace: '--E-GPT--', recorded_at: at(daysAgo), sha256: name.repeat(64) },
});

/** Write one version record whose `recorded_at`/stamp is `daysAgo` days before {@link NOW}. */
function writeVersion(root, name, daysAgo) {
  const sha = name.repeat(64);
  return recordSupersededVersion({
    root,
    previous: { ...ENTRY, sha256: sha, blocks: [{ index: 0, offset: 0, length: 10, sha256: sha }], updated_at: at(daysAgo) },
    snapshotId: `20261117T000000Z-${name.repeat(8).slice(0, 8)}`,
    now: new Date(NOW.getTime() - daysAgo * DAY_MS),
  });
}

describe('rotation: the retention policy (count and age)', () => {
  it('keeps the newest N records when the age rule is off (undefined, null and 0)', () => {
    const rows = [row('a', 1), row('b', 2), row('c', 3)];
    assert.deepEqual(resolveMaxAgeDays(undefined), { ok: true, maxAgeDays: 0 });
    assert.deepEqual(resolveMaxAgeDays(null), { ok: true, maxAgeDays: 0 });
    assert.deepEqual(resolveMaxAgeDays(0), { ok: true, maxAgeDays: 0 });
    assert.deepEqual(resolveMaxAgeDays(7), { ok: true, maxAgeDays: 7 });
    for (const maxAgeDays of [undefined, null, 0]) {
      const decision = selectPrunable(rows, { keep: 2, maxAgeDays, now: NOW });
      assert.deepEqual(decision.kept.map((entry) => entry.file), ['old/a.json', 'old/b.json']);
      assert.deepEqual(decision.pruned.map((entry) => entry.reason), ['count']);
    }
  });

  it('prunes a recent record beyond the newest N by count', () => {
    const decision = selectPrunable([row('a', 1), row('b', 2), row('c', 3)], { keep: 2, maxAgeDays: 365, now: NOW });
    assert.deepEqual(decision.kept.map((entry) => entry.file), ['old/a.json', 'old/b.json']);
    assert.deepEqual(decision.pruned.map((entry) => entry.row.file), ['old/c.json']);
    assert.equal(decision.pruned[0].reason, 'count');
  });

  it('prunes a record inside the newest N but older than maxAgeDays by age', () => {
    const decision = selectPrunable([row('young', 1), row('old', 10)], { keep: 10, maxAgeDays: 5, now: NOW });
    assert.deepEqual(decision.kept.map((entry) => entry.file), ['old/young.json']);
    assert.deepEqual(decision.pruned.map((entry) => entry.row.file), ['old/old.json']);
    assert.equal(decision.pruned[0].reason, 'age');
  });

  it('applies both rules in one pass: a row survives only if it satisfies both', () => {
    // Newest first. `c` is within the newest 3 but older than the window; `d` is beyond the newest 3.
    const decision = selectPrunable([row('a', 1), row('b', 2), row('c', 40), row('d', 45)], { keep: 3, maxAgeDays: 30, now: NOW });
    assert.deepEqual(decision.kept.map((entry) => entry.file), ['old/a.json', 'old/b.json']);
    assert.deepEqual(
      decision.pruned.map((entry) => [entry.row.file, entry.reason]),
      [['old/c.json', 'age'], ['old/d.json', 'count']],
    );
  });

  it('accepts now as a Date or epoch milliseconds, and does not age-prune an unreadable timestamp', () => {
    const rows = [row('a', 1), row('b', 10)];
    assert.deepEqual(selectPrunable(rows, { keep: 10, maxAgeDays: 5, now: NOW }), selectPrunable(rows, { keep: 10, maxAgeDays: 5, now: NOW.getTime() }));
    const unreadable = { file: 'old/x.json', record: { recorded_at: 'not a date' } };
    const decision = selectPrunable([unreadable], { keep: 10, maxAgeDays: 1, now: NOW });
    assert.equal(decision.kept.length, 1, 'an unreadable timestamp is not evidence that the record is old');
  });

  it('refuses an invalid maxAgeDays with the named policy code, before touching the filesystem', () => {
    for (const bad of [-1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY, true]) {
      const verdict = resolveMaxAgeDays(bad);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason_code, ROTATION_CODES.POLICY_INVALID);
      assert.throws(
        () => selectPrunable([row('a', 1)], { keep: 10, maxAgeDays: bad, now: NOW }),
        (error) => error instanceof RotationError && error.code === 'BACKUP_ROTATION_POLICY_INVALID',
        `selectPrunable must refuse ${String(bad)}`,
      );
    }
    const { dir, cleanup } = tempDir('w2m-rot-policy-');
    try {
      assert.throws(
        () => pruneOldVersions({ root: dir, maxAgeDays: -2 }),
        (error) => error instanceof RotationError && error.code === 'BACKUP_ROTATION_POLICY_INVALID',
      );
    } finally {
      cleanup();
    }
    // A direct rotateForEntry call must refuse before writing a version record, not after.
    const rotation = tempDir('w2m-rot-policy-write-');
    try {
      writeCurrentPointer({ root: rotation.dir, entry: ENTRY, snapshotId: '20261117T140000Z-deadbeef' });
      assert.throws(
        () => rotateForEntry({ root: rotation.dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', maxAgeDays: -2 }),
        (error) => error instanceof RotationError && error.code === 'BACKUP_ROTATION_POLICY_INVALID',
      );
      assert.equal(listOldVersions(rotation.dir).length, 0, 'the refusal happens before the version record is written');
    } finally {
      rotation.cleanup();
    }
  });

  it('pruneOldVersions applies the age rule alongside the count rule', () => {
    const { dir, cleanup } = tempDir('w2m-rot-prune-age-');
    try {
      writeVersion(dir, 'a', 1);
      writeVersion(dir, 'b', 2);
      writeVersion(dir, 'c', 40);
      writeVersion(dir, 'd', 45);
      assert.equal(listOldVersions(dir).length, 4);
      const result = pruneOldVersions({ root: dir, keep: 3, maxAgeDays: 30, now: NOW });
      assert.equal(result.kept, 2);
      assert.equal(result.removed.length, 2);
      assert.equal(result.pruned_by_age, 1);
      assert.deepEqual(listOldVersions(dir).map((entry) => entry.record.sha256[0]), ['a', 'b']);
    } finally {
      cleanup();
    }
  });

  it('prunes nothing in a dry run, even with the age rule enabled', () => {
    const { dir, cleanup } = tempDir('w2m-rot-prune-age-dry-');
    try {
      writeVersion(dir, 'a', 40);
      const result = pruneOldVersions({ root: dir, keep: 10, maxAgeDays: 30, now: NOW, dryRun: true });
      assert.equal(result.removed.length, 1);
      assert.equal(result.pruned_by_age, 1);
      assert.equal(listOldVersions(dir).length, 1);
    } finally {
      cleanup();
    }
  });

  it('rotateForEntry passes maxAgeDays through and reports the age-pruned count', () => {
    const { dir, cleanup } = tempDir('w2m-rot-age-passthrough-');
    try {
      writeVersion(dir, 'a', 40);
      writeCurrentPointer({ root: dir, entry: ENTRY, snapshotId: '20261117T120000Z-deadbeef', now: NOW });
      const result = rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T130000Z-feedface', keep: 10, maxAgeDays: 30, now: NOW });
      assert.equal(result.rotated, true);
      assert.equal(result.pruned_by_age, 1);
      assert.equal(listOldVersions(dir).length, 1, 'only the version recorded by this rotation remains');
    } finally {
      cleanup();
    }
  });
});

describe('rotation: old version paths', () => {
  it('keeps the file name inside old/ even for a hostile stamp', () => {
    const file = oldVersionPath('D:\\repo', { ...ENTRY }, '../../escape', ENTRY.sha256);
    assert.match(file, /old[\\/]--E-GPT--[\\/]session-aaaaaaaa-0001[\\/]escape-aaaaaaaaaaaa\.json$/u);
    assert.ok(!file.includes('..'));
    assert.equal(join('D:\\repo', 'old', '--E-GPT--', 'session-aaaaaaaa-0001', `escape-${'a'.repeat(12)}.json`), file);
  });

  it('derives the full copy name from the record name, so escaping is impossible through either', () => {
    const record = oldVersionPath('D:\\repo', { ...ENTRY }, '../../escape', ENTRY.sha256);
    const copy = oldFullCopyPath('D:\\repo', { ...ENTRY }, '../../escape', ENTRY.sha256);
    assert.equal(`${record}.enc`, copy);
    assert.match(copy, /escape-aaaaaaaaaaaa\.json\.enc$/u);
    assert.ok(!copy.includes('..'));
  });

  it('refuses a record full_copy path that would leave old/', () => {
    const { dir, cleanup } = tempDir('w2m-rot-full-path-');
    try {
      assert.equal(fullCopyPathFor(dir, { full_copy: { file: 'old/--E-GPT--/session-x/a.json.enc' } }), join(dir, 'old', '--E-GPT--', 'session-x', 'a.json.enc'));
      for (const bad of ['../escape.json.enc', 'current/x.json.enc', join(dir, 'old', 'x.json.enc'), 42, null]) {
        const record = bad === null ? { full_copy: null } : { full_copy: { file: bad } };
        assert.equal(fullCopyPathFor(dir, record), null, `must refuse ${JSON.stringify(bad)}`);
      }
    } finally {
      cleanup();
    }
  });
});

/** Store `bytes` as one sealed block under `objects/` and return the entry fields describing them. */
function storedVersion(root, dek, bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const block = { index: 0, offset: 0, length: bytes.length, sha256 };
  const object = join(repoPaths(root).objects, sha256.slice(0, 2), sha256);
  mkdirSync(dirname(object), { recursive: true });
  writeFileSync(object, sealObject(bytes, dek, { sha256, length: bytes.length }));
  return { sha256, size: bytes.length, blocks: [block] };
}

/** Write a `current/` pointer whose blocks really exist, so a `full` rotation can rebuild the version. */
function pointAtStoredVersion(root, dek, bytes, extra = {}) {
  const previous = {
    ...ENTRY,
    ...storedVersion(root, dek, bytes),
    snapshot_id: '20261117T140000Z-deadbeef',
    updated_at: '2026-11-17T14:00:00.000Z',
    ...extra,
  };
  // The pointer's own `updated_at` is what rotation stamps the record/copy name from, so pin it to the same
  // instant rather than to the wall clock (otherwise the expected file name is untestable).
  writeCurrentPointer({ root, entry: previous, snapshotId: previous.snapshot_id, now: new Date(previous.updated_at) });
  return previous;
}

const ROTATION_NOW = new Date('2026-11-17T15:00:00.000Z');

describe('rotation: oldFormat (records vs the literal full copy)', () => {
  it('defaults to records, accepts full, and refuses anything else with the named code', () => {
    assert.equal(DEFAULT_OLD_FORMAT, 'records');
    assert.deepEqual([...OLD_FORMATS], ['records', 'full']);
    assert.deepEqual(resolveOldFormat(undefined), { ok: true, format: 'records' });
    assert.deepEqual(resolveOldFormat(null), { ok: true, format: 'records' });
    assert.deepEqual(resolveOldFormat('records'), { ok: true, format: 'records' });
    assert.deepEqual(resolveOldFormat('full'), { ok: true, format: 'full' });
    for (const bad of ['FULL', 'record', 1, true]) {
      const refused = resolveOldFormat(bad);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, ROTATION_CODES.FORMAT_INVALID);
      assert.match(refused.detail, /oldFormat must be one of records, full/u);
    }
    const { dir, cleanup } = tempDir('w2m-rot-format-');
    try {
      writeCurrentPointer({ root: dir, entry: ENTRY, snapshotId: '20261117T140000Z-deadbeef' });
      assert.throws(
        () => rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', format: 'FULL' }),
        (error) => error instanceof RotationError && error.code === ROTATION_CODES.FORMAT_INVALID,
        'a direct caller must be refused before any write',
      );
      assert.equal(listOldVersions(dir).length, 0);
    } finally {
      cleanup();
    }
  });

  it('writes the record plus one sealed whole-file copy, which decrypts to the superseded bytes', () => {
    const { dir, cleanup } = tempDir('w2m-rot-full-');
    try {
      const dek = randomDek();
      const bytes = Buffer.from('the superseded version, byte for byte\n');
      const previous = pointAtStoredVersion(dir, dek, bytes);
      const result = rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', format: 'full', dek, now: ROTATION_NOW });
      assert.equal(result.rotated, true);
      assert.ok(result.full_copy, 'full mode must report the copy it wrote');
      const rows = listOldVersions(dir);
      assert.equal(rows.length, 1);
      const { record } = rows[0];
      // The record stays the same versioned shape: `full_copy` is an additive field older readers ignore.
      assert.equal(record.format, OLD_FORMAT);
      assert.equal(record.version, OLD_VERSION);
      assert.equal(record.full_copy.sha256, previous.sha256);
      assert.equal(record.full_copy.size, bytes.length);
      assert.equal(record.full_copy.file, result.full_copy.file);
      assert.match(record.full_copy.file, /^old\/--E-GPT--\/session-aaaaaaaa-0001\/20261117T140000Z-[0-9a-f]{12}\.json\.enc$/u);
      const copyFile = fullCopyPathFor(dir, record);
      assert.equal(copyFile, oldFullCopyPath(dir, previous, '20261117T140000Z'));
      assert.equal(existsSync(copyFile), true);
      const opened = openObject(readFileSync(copyFile), dek, {
        sha256: record.full_copy.sha256,
        length: record.full_copy.size,
        kind: OLD_COPY_KIND,
      });
      assert.deepEqual(opened, bytes, 'the copy must decrypt to the superseded bytes');
      assert.equal(createHash('sha256').update(opened).digest('hex'), record.full_copy.sha256);
      // The copy is NOT a block: the same bytes under the block identity must not authenticate.
      assert.throws(
        () => openObject(readFileSync(copyFile), dek, { sha256: record.full_copy.sha256, length: record.full_copy.size }),
        (error) => error.code === 'BACKUP_DECRYPT_AUTH_FAILED',
        'a whole-file copy must not open as a block object',
      );
    } finally {
      cleanup();
    }
  });

  it('writes no sealed copy in records mode (the default)', () => {
    const { dir, cleanup } = tempDir('w2m-rot-records-');
    try {
      const dek = randomDek();
      pointAtStoredVersion(dir, dek, Buffer.from('records mode\n'));
      const result = rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', now: ROTATION_NOW });
      assert.equal(result.rotated, true);
      assert.equal(result.full_copy, null);
      const rows = listOldVersions(dir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].record.full_copy, undefined);
      const names = readdirSync(join(dir, 'old', '--E-GPT--', 'session-aaaaaaaa-0001'));
      assert.deepEqual(names.filter((name) => name.endsWith('.json.enc')), [], 'records mode writes no .enc');
      assert.equal(names.filter((name) => name.endsWith('.json')).length, 1);
    } finally {
      cleanup();
    }
  });

  it('prunes the paired sealed copy together with its record', () => {
    const { dir, cleanup } = tempDir('w2m-rot-full-prune-');
    try {
      const dek = randomDek();
      pointAtStoredVersion(dir, dek, Buffer.from('prune me\n'));
      rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', format: 'full', dek, now: ROTATION_NOW });
      const copyFile = fullCopyPathFor(dir, listOldVersions(dir)[0].record);
      assert.equal(existsSync(copyFile), true);
      const pruned = pruneOldVersions({ root: dir, keep: 0, now: ROTATION_NOW });
      assert.equal(pruned.removed.length, 1);
      assert.equal(pruned.full_copies_removed, 1);
      assert.equal(listOldVersions(dir).length, 0);
      assert.equal(existsSync(copyFile), false, 'a pruned record must take its copy with it');
    } finally {
      cleanup();
    }
  });

  it('refuses rotation with BACKUP_ROTATION_WRITE_FAILED when the copy cannot be written', () => {
    const { dir, cleanup } = tempDir('w2m-rot-full-fail-');
    try {
      const dek = randomDek();
      const previous = pointAtStoredVersion(dir, dek, Buffer.from('cannot copy me\n'));
      // A file where `old/` should be: the copy's atomic write cannot create its parent directory.
      writeFileSync(join(dir, 'old'), 'not a directory');
      assert.throws(
        () => rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', format: 'full', dek, now: ROTATION_NOW }),
        (error) => error instanceof RotationError && error.code === ROTATION_CODES.WRITE_FAILED,
        'the failure must be the named rotation write code, not a raw fs error',
      );
      assert.equal(listOldVersions(dir).length, 0, 'no record may claim a copy that was never written');
      assert.equal(readCurrent(dir, ENTRY).sha256, previous.sha256, 'the current pointer must not move on a refused rotation');
    } finally {
      cleanup();
    }
  });

  it('refuses rotation when the copy cannot be rebuilt from the stored blocks', () => {
    const { dir, cleanup } = tempDir('w2m-rot-full-missing-');
    try {
      const dek = randomDek();
      const previous = pointAtStoredVersion(dir, dek, Buffer.from('blocks that will go missing\n'));
      rmSync(join(repoPaths(dir).objects, previous.sha256.slice(0, 2), previous.sha256));
      assert.throws(
        () => rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', format: 'full', dek, now: ROTATION_NOW }),
        (error) => error instanceof RotationError && error.code === ROTATION_CODES.WRITE_FAILED,
      );
      assert.equal(listOldVersions(dir).length, 0, 'a copy that cannot be built must not produce a record');
    } finally {
      cleanup();
    }
  });

  it('refuses full mode without a DEK instead of writing a record without its copy', () => {
    const { dir, cleanup } = tempDir('w2m-rot-full-nodek-');
    try {
      pointAtStoredVersion(dir, randomDek(), Buffer.from('needs a key\n'));
      assert.throws(
        () => rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', format: 'full', now: ROTATION_NOW }),
        (error) => error instanceof RotationError && error.code === ROTATION_CODES.WRITE_FAILED,
      );
      assert.equal(listOldVersions(dir).length, 0);
    } finally {
      cleanup();
    }
  });
});

const BACKFILL_KDF = { algo: 'scrypt', N: MIN_SCRYPT.N, r: MIN_SCRYPT.r, p: MIN_SCRYPT.p, keylen: 32 };
const BACKFILL_PASSWORD = 'correct horse battery staple';

/** A real repository root with an openable password envelope, plus the DEK the fixture sealed its blocks with. */
function backfillRepo(prefix) {
  const { dir, cleanup } = tempDir(prefix);
  const root = join(dir, 'repo');
  const home = join(dir, 'home');
  ensureLayout(root);
  const key = openRepoKey({
    root,
    dshHome: home,
    password: BACKFILL_PASSWORD,
    platform: 'linux',
    machineKey: false,
    kdf: BACKFILL_KDF,
  });
  assert.equal(key.ok, true, key.detail ?? 'the fixture repository must open');
  return { dir, root, home, dek: key.dek, cleanup };
}

/**
 * Store one superseded version (its blocks really exist under `objects/`) and write its record.
 *
 * `format: 'records'` (default) is exactly the pre-full-mode shape the migration exists for.
 */
function backfillVersion(root, dek, sessionId, bytes, stamp, format = 'records') {
  const previous = {
    ...ENTRY,
    session_id: sessionId,
    rel: `sessions/--E-GPT--/${sessionId}/session.v4.jsonl.zstd`,
    ...storedVersion(root, dek, bytes),
    snapshot_id: `snapshot-${stamp}`,
    updated_at: stamp,
  };
  return recordSupersededVersion({
    root,
    previous,
    snapshotId: `next-${stamp}`,
    now: new Date(stamp),
    format,
    dek: format === 'full' ? dek : undefined,
  });
}

/** Every sealed whole-file copy under `old/` (`*.json.enc`). */
function fullCopyFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json.enc')) out.push(full);
    }
  };
  walk(join(root, 'old'));
  return out;
}

/** The record document as it is on disk. */
function readRecordJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Open a copy with the `old` identity and return its plaintext. */
function openCopy(file, dek, record) {
  return openObject(readFileSync(file), dek, {
    sha256: record.full_copy.sha256,
    length: record.full_copy.size,
    kind: OLD_COPY_KIND,
  });
}

describe('rotation: old-backfill (migrating records that predate full mode)', () => {
  it('writes exactly the missing sealed copy, verifies it against the record, and decrypts to the original bytes', () => {
    const repo = backfillRepo('w2m-rot-backfill-write-');
    try {
      const bytesA = Buffer.from('the record-only version, byte for byte\n');
      const bytesB = Buffer.from('a version that already had its full copy\n');
      const recordA = backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', bytesA, '2026-11-17T13:00:00.000Z');
      const recordB = backfillVersion(repo.root, repo.dek, 'session-bbbbbbbb-0002', bytesB, '2026-11-17T14:00:00.000Z', 'full');
      assert.equal(fullCopyFiles(repo.root).length, 1, 'the fixture starts with exactly the full record\'s copy');
      const recordBBefore = readFileSync(recordB.file);

      const result = backfillOldFullCopies({
        root: repo.root,
        dshHome: repo.home,
        password: BACKFILL_PASSWORD,
        platform: 'linux',
        machineKey: false,
      });
      assert.equal(result.ok, true, JSON.stringify(result.failed));
      assert.equal(result.backfilled, 1);
      assert.equal(result.repaired, 0);
      assert.equal(result.skipped, 1);
      assert.equal(result.orphans, 0);
      assert.deepEqual(result.failed, []);
      assert.equal(result.dry_run, false);
      assert.equal(result.reason_code, null);
      assert.equal(fullCopyFiles(repo.root).length, 2, 'backfill adds exactly one .json.enc');
      assert.equal(result.bytes_written, bytesA.length + SEALED_COPY_OVERHEAD);

      const updated = readRecordJson(recordA.file);
      assert.equal(updated.format, OLD_FORMAT, 'the record format stays the frozen v1 shape');
      assert.equal(updated.version, OLD_VERSION);
      assert.equal(updated.sha256, recordA.record.sha256);
      assert.equal(updated.full_copy.sha256, recordA.record.sha256);
      assert.equal(updated.full_copy.size, bytesA.length);
      assert.match(
        updated.full_copy.file,
        /^old\/--E-GPT--\/session-aaaaaaaa-0001\/20261117T130000Z-[0-9a-f]{12}\.json\.enc$/u,
      );
      const copyFile = join(repo.root, ...updated.full_copy.file.split('/'));
      assert.equal(existsSync(copyFile), true);
      assert.equal(fullCopyPathFor(repo.root, updated), copyFile, 'the recorded path points at the file that was written');
      assert.deepEqual(openCopy(copyFile, repo.dek, updated), bytesA, 'the copy must decrypt to the superseded bytes');
      assert.throws(
        () => openObject(readFileSync(copyFile), repo.dek, { sha256: updated.full_copy.sha256, length: updated.full_copy.size }),
        (error) => error.code === 'BACKUP_DECRYPT_AUTH_FAILED',
        'a whole-file copy must not open as a block object',
      );
      assert.equal(readFileSync(recordB.file).equals(recordBBefore), true, 'a record that already had a copy is not rewritten');
    } finally {
      repo.cleanup();
    }
  });

  it('is idempotent: the second run writes nothing and reports every record as skipped', () => {
    const repo = backfillRepo('w2m-rot-backfill-idempotent-');
    try {
      const bytesA = Buffer.from('version a\n');
      const bytesB = Buffer.from('version b\n');
      const recordA = backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', bytesA, '2026-11-17T13:00:00.000Z');
      backfillVersion(repo.root, repo.dek, 'session-bbbbbbbb-0002', bytesB, '2026-11-17T14:00:00.000Z');
      const input = { root: repo.root, dshHome: repo.home, password: BACKFILL_PASSWORD, platform: 'linux', machineKey: false };
      assert.equal(backfillOldFullCopies(input).backfilled, 2);
      const recordBefore = readFileSync(recordA.file);
      const copiesBefore = fullCopyFiles(repo.root).map((file) => readFileSync(file));

      const second = backfillOldFullCopies(input);
      assert.deepEqual(second, {
        ok: true,
        backfilled: 0,
        repaired: 0,
        skipped: 2,
        orphans: 0,
        failed: [],
        bytes_written: 0,
        dry_run: false,
        reason_code: null,
        detail: null,
      });
      assert.equal(readFileSync(recordA.file).equals(recordBefore), true, 'an already-migrated record is not rewritten');
      assert.deepEqual(fullCopyFiles(repo.root).map((file) => readFileSync(file)), copiesBefore, 'no copy is rewritten');
    } finally {
      repo.cleanup();
    }
  });

  it('refuses BACKUP_NO_PERMISSION without writing when the key cannot be opened', () => {
    const repo = backfillRepo('w2m-rot-backfill-refuse-');
    try {
      const bytes = Buffer.from('a version nobody can open\n');
      const record = backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', bytes, '2026-11-17T13:00:00.000Z');
      const recordBefore = readFileSync(record.file);
      const base = { root: repo.root, dshHome: repo.home, platform: 'linux', machineKey: false };

      for (const password of ['', 'not-the-password']) {
        const refused = backfillOldFullCopies({ ...base, password });
        assert.equal(refused.ok, false);
        assert.equal(refused.reason_code, 'BACKUP_NO_PERMISSION');
        assert.match(refused.detail, /BACKUP_NO_PERMISSION/u);
        assert.equal(refused.backfilled, 0);
        assert.equal(fullCopyFiles(repo.root).length, 0, 'a refused run writes no copy');
        assert.equal(readFileSync(record.file).equals(recordBefore), true, 'a refused run rewrites no record');
      }

      // A closed key is the same refusal, not a throw: a malformed keys.json must be reported with its detail.
      const keysFile = join(repo.root, 'keys.json');
      writeFileSync(keysFile, '{ not json');
      const corrupt = backfillOldFullCopies({ ...base, password: BACKFILL_PASSWORD });
      assert.equal(corrupt.ok, false);
      assert.equal(corrupt.reason_code, 'BACKUP_NO_PERMISSION');
      assert.equal(fullCopyFiles(repo.root).length, 0);
    } finally {
      repo.cleanup();
    }
  });

  it('repairs a short or missing .json.enc instead of trusting its length', () => {
    const repo = backfillRepo('w2m-rot-backfill-repair-');
    try {
      const bytes = Buffer.from('the bytes the copy must keep\n');
      const record = backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', bytes, '2026-11-17T13:00:00.000Z', 'full');
      const copyFile = fullCopyFiles(repo.root)[0];
      const input = { root: repo.root, dshHome: repo.home, password: BACKFILL_PASSWORD, platform: 'linux', machineKey: false };

      // A crash during the copy write leaves a short file; the record's length is the authority.
      writeFileSync(copyFile, readFileSync(copyFile).subarray(0, 12));
      const first = backfillOldFullCopies(input);
      assert.equal(first.ok, true, JSON.stringify(first.failed));
      assert.equal(first.repaired, 1);
      assert.equal(first.backfilled, 0);
      assert.equal(first.skipped, 0);
      assert.equal(first.orphans, 0);
      assert.equal(first.bytes_written, bytes.length + SEALED_COPY_OVERHEAD);
      assert.deepEqual(openCopy(copyFile, repo.dek, readRecordJson(record.file)), bytes);

      // A missing copy is repaired the same way.
      rmSync(copyFile);
      const second = backfillOldFullCopies(input);
      assert.equal(second.repaired, 1);
      assert.equal(existsSync(copyFile), true);
      assert.deepEqual(openCopy(copyFile, repo.dek, readRecordJson(record.file)), bytes);
    } finally {
      repo.cleanup();
    }
  });

  it('reports an unrebuildable record as a per-record failure instead of writing a copy of something else', () => {
    const repo = backfillRepo('w2m-rot-backfill-failed-');
    try {
      const bytes = Buffer.from('whose block will go missing\n');
      const record = backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', bytes, '2026-11-17T13:00:00.000Z');
      const object = join(repoPaths(repo.root).objects, record.record.sha256.slice(0, 2), record.record.sha256);
      rmSync(object);

      const rebuilt = backfillOldFullCopies({
        root: repo.root,
        dshHome: repo.home,
        password: BACKFILL_PASSWORD,
        platform: 'linux',
        machineKey: false,
      });
      assert.equal(rebuilt.ok, false);
      assert.equal(rebuilt.backfilled, 0);
      assert.equal(rebuilt.failed.length, 1);
      assert.equal(rebuilt.failed[0].record, record.file);
      assert.equal(rebuilt.failed[0].reason_code, 'BACKUP_OLD_BACKFILL_FAILED');
      assert.match(rebuilt.failed[0].detail, /BACKUP_OBJECT_MISSING/u);
      assert.equal(fullCopyFiles(repo.root).length, 0, 'a record that cannot rebuild gets no copy');
      assert.match(formatOldBackfill(rebuilt), /failed\s+: 1 record/u);

      // A record whose declared digest is not a sha256 is refused by code, before any rebuild.
      const invalid = { ...record.record, sha256: 'not-a-digest' };
      const invalidFile = join(dirname(record.file), '20260101T000000Z-invalid.json');
      writeFileSync(invalidFile, `${JSON.stringify(invalid, null, 2)}\n`);
      const refused = backfillOldFullCopies({
        root: repo.root,
        dshHome: repo.home,
        password: BACKFILL_PASSWORD,
        platform: 'linux',
        machineKey: false,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.failed.some((row) => row.reason_code === 'BACKUP_OLD_RECORD_INVALID'), true);
      assert.equal(fullCopyFiles(repo.root).length, 0);
    } finally {
      repo.cleanup();
    }
  });

  it('counts an unreferenced .json.enc as orphan, leaves it alone, and counts the plan in a dry run', () => {
    const repo = backfillRepo('w2m-rot-backfill-orphan-');
    try {
      const bytes = Buffer.from('a version with its full copy\n');
      backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', bytes, '2026-11-17T13:00:00.000Z', 'full');
      const referenced = fullCopyFiles(repo.root)[0];
      const orphan = join(dirname(referenced), '20260101T000000Z-ffffffffffff.json.enc');
      writeFileSync(orphan, Buffer.alloc(5, 7));

      const result = backfillOldFullCopies({
        root: repo.root,
        dshHome: repo.home,
        password: BACKFILL_PASSWORD,
        platform: 'linux',
        machineKey: false,
      });
      assert.equal(result.ok, true);
      assert.equal(result.skipped, 1, 'the record with a valid copy is skipped');
      assert.equal(result.orphans, 1, 'a copy no record references is counted');
      assert.equal(existsSync(orphan), true, 'backfill never deletes: orphan cleanup belongs to gc');
      assert.equal(existsSync(referenced), true);
      assert.match(formatOldBackfill(result), /orphan copies : 1/u);
    } finally {
      repo.cleanup();
    }
  });

  it('honours limit as the number of copies written, so skips do not consume the budget', () => {
    const repo = backfillRepo('w2m-rot-backfill-limit-');
    try {
      backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', Buffer.from('a\n'), '2026-11-17T12:00:00.000Z');
      backfillVersion(repo.root, repo.dek, 'session-bbbbbbbb-0002', Buffer.from('b\n'), '2026-11-17T13:00:00.000Z');
      backfillVersion(repo.root, repo.dek, 'session-cccccccc-0003', Buffer.from('c\n'), '2026-11-17T14:00:00.000Z', 'full');
      const input = {
        root: repo.root,
        dshHome: repo.home,
        password: BACKFILL_PASSWORD,
        platform: 'linux',
        machineKey: false,
        limit: 1,
      };
      // The full record is newest (it sorts first): one skip plus one write, and then the budget is spent.
      const first = backfillOldFullCopies(input);
      assert.equal(first.backfilled, 1);
      assert.equal(first.skipped, 1);
      assert.equal(fullCopyFiles(repo.root).length, 2);
      const second = backfillOldFullCopies(input);
      assert.equal(second.backfilled, 1);
      assert.equal(second.skipped, 2);
      assert.equal(fullCopyFiles(repo.root).length, 3);
    } finally {
      repo.cleanup();
    }
  });

  it('a dry run needs no credential, writes nothing, and reports the plan', () => {
    const repo = backfillRepo('w2m-rot-backfill-dry-');
    try {
      const bytes = Buffer.from('plan me, do not write me\n');
      const record = backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', bytes, '2026-11-17T13:00:00.000Z');
      const recordBefore = readFileSync(record.file);
      const copiesBefore = fullCopyFiles(repo.root).length;

      // No dsh-home, no password: a dry run must not need (or touch) the repository key.
      const result = backfillOldFullCopies({ root: repo.root, dryRun: true });
      assert.equal(result.ok, true);
      assert.equal(result.dry_run, true);
      assert.equal(result.backfilled, 1, 'the plan reports what a real run would backfill');
      assert.equal(result.repaired, 0);
      assert.equal(result.skipped, 0);
      assert.equal(result.bytes_written, 0);
      assert.equal(fullCopyFiles(repo.root).length, copiesBefore, 'a dry run writes no copy');
      assert.equal(readFileSync(record.file).equals(recordBefore), true, 'a dry run rewrites no record');
      assert.equal(existsSync(join(repo.root, 'tmp', 'backup.lock')), false, 'a dry run takes no lock');
      assert.match(formatOldBackfill(result), /nothing was written/u);
    } finally {
      repo.cleanup();
    }
  });
});

describe('rotation: old-backfill CLI', () => {
  const capture = (password) => {
    const lines = [];
    const io = {
      stdout: (text) => lines.push(text),
      stderr: (text) => lines.push(text),
      env: {},
      ...(password === undefined ? {} : { password }),
    };
    return { lines, io };
  };

  it('is named in usage, parses --limit, and uses exit code 2 for a bad value', () => {
    const help = capture();
    assert.equal(main(['help'], help.io), 0);
    const usage = help.lines.join('\n');
    assert.match(usage, /old-backfill/u);
    assert.match(usage, /--limit <n>/u);

    assert.equal(parseArgs(['old-backfill', '--limit', '2'], {}).limit, 2);
    assert.equal(parseArgs(['old-backfill', '--limit=0'], {}).limit, 0);
    assert.match(parseArgs(['old-backfill', '--limit'], {}).error, /--limit needs a non-negative integer/u);
    assert.match(parseArgs(['old-backfill', '--limit=abc'], {}).error, /--limit needs a non-negative integer/u);

    const bad = capture(BACKFILL_PASSWORD);
    assert.equal(main(['old-backfill', '--backup-dir', 'E:\\nowhere', '--limit', 'lots'], bad.io), 2);
  });

  it('runs the migration through the real entry point and prints the JSON result', () => {
    const repo = backfillRepo('w2m-rot-backfill-cli-');
    try {
      const bytes = Buffer.from('the CLI must migrate this version\n');
      const record = backfillVersion(repo.root, repo.dek, 'session-aaaaaaaa-0001', bytes, '2026-11-17T13:00:00.000Z');
      const argv = ['old-backfill', '--backup-dir', repo.root, '--dsh-home', repo.home, '--no-machine-key', '--json'];
      const first = capture(BACKFILL_PASSWORD);
      assert.equal(main(argv, first.io), 0, first.lines.join('\n'));
      const payload = JSON.parse(first.lines.join('\n'));
      assert.deepEqual(Object.keys(payload).sort(), [
        'backfilled',
        'bytes_written',
        'detail',
        'dry_run',
        'failed',
        'ok',
        'orphans',
        'reason_code',
        'repaired',
        'skipped',
      ]);
      assert.equal(payload.ok, true);
      assert.equal(payload.backfilled, 1);
      assert.equal(payload.dry_run, false);
      assert.equal(payload.bytes_written, bytes.length + SEALED_COPY_OVERHEAD);
      assert.equal(readRecordJson(record.file).full_copy.sha256, record.record.sha256);

      const human = capture(BACKFILL_PASSWORD);
      assert.equal(main(['old-backfill', '--backup-dir', repo.root, '--dsh-home', repo.home, '--no-machine-key', '--dry-run'], human.io), 0);
      const text = human.lines.join('\n');
      assert.match(text, /old-backfill/u);
      assert.match(text, /dry run \(nothing was written\)/u);
      assert.match(text, /nothing was written \(dry run\)/u);
      assert.match(text, /already full {2}: 1 record/u);
    } finally {
      repo.cleanup();
    }
  });

  it('exits 1 with a JSON refusal when an existing repository cannot be opened, and writes nothing', () => {
    const { dir, cleanup } = tempDir('w2m-rot-backfill-cli-refuse-');
    const root = join(dir, 'repo');
    ensureLayout(root);
    try {
      const home = join(dir, 'home');
      // A sealed repository: the CLI below has neither a password nor a machine key, so it must be refused.
      // (An *uninitialised* repository is no longer a refusal: the default protection mode is `none`, so opening
      // it legitimately creates an open envelope. This test keeps the "cannot open an existing repo" case.)
      const created = openRepoKey({ root, dshHome: home, password: BACKFILL_PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(created.ok, true, created.detail ?? '');
      const before = readFileSync(join(root, 'keys.json'), 'utf8');
      const captured = capture();
      const code = main(
        ['old-backfill', '--backup-dir', root, '--dsh-home', home, '--no-machine-key', '--json'],
        captured.io,
      );
      assert.equal(code, 1);
      const payload = JSON.parse(captured.lines.join('\n'));
      assert.equal(payload.ok, false);
      assert.equal(payload.reason_code, 'BACKUP_NO_PERMISSION');
      assert.equal(payload.backfilled, 0);
      assert.equal(readFileSync(join(root, 'keys.json'), 'utf8'), before, 'a refused backfill must not rewrite the key file');
    } finally {
      cleanup();
    }
  });
});

describe('rotation: the full-copy cap and its approval annotation', () => {
  it('normalizes the injected cap: absent = 300 MiB, 0 = no cap, anything else is refused by name', () => {
    assert.deepEqual(resolveMaxFullCopyBytes(undefined), { ok: true, maxBytes: DEFAULT_FULL_COPY_MAX_BYTES });
    assert.deepEqual(resolveMaxFullCopyBytes(null), { ok: true, maxBytes: DEFAULT_FULL_COPY_MAX_BYTES });
    assert.equal(DEFAULT_FULL_COPY_MAX_BYTES, 300 * 1024 * 1024);
    assert.deepEqual(resolveMaxFullCopyBytes(0), { ok: true, maxBytes: 0 });
    assert.deepEqual(resolveMaxFullCopyBytes(1024), { ok: true, maxBytes: 1024 });
    for (const bad of [-1, 1.5, '1024', true]) {
      const refused = resolveMaxFullCopyBytes(bad);
      assert.equal(refused.ok, false, `maxFullCopyBytes=${String(bad)} must be refused`);
      assert.equal(refused.reason_code, ROTATION_CODES.POLICY_INVALID);
      assert.match(refused.detail, /maxFullCopyBytes must be 0/u);
    }
  });

  it('annotates the copy with approved_over_cap/cap_bytes only when the engine approved it', () => {
    const { dir, cleanup } = tempDir('w2m-rot-full-approved-');
    try {
      const dek = randomDek();
      const bytes = Buffer.from('an explicitly approved over-cap version\n');
      pointAtStoredVersion(dir, dek, bytes);
      const result = rotateForEntry({
        root: dir,
        entry: CHANGED,
        snapshotId: '20261117T150000Z-feedface',
        format: 'full',
        dek,
        now: ROTATION_NOW,
        approvedOverCap: true,
        capBytes: 1024,
      });
      assert.equal(result.rotated, true);
      assert.equal(result.full_copy.approved_over_cap, true);
      assert.equal(result.full_copy.cap_bytes, 1024);
      const record = listOldVersions(dir)[0].record;
      assert.equal(record.full_copy.approved_over_cap, true);
      assert.equal(record.full_copy.cap_bytes, 1024);
      assert.equal(record.full_copy.size, bytes.length);
      const copyFile = fullCopyPathFor(dir, record);
      assert.deepEqual(
        openObject(readFileSync(copyFile), dek, { sha256: record.full_copy.sha256, length: record.full_copy.size, kind: OLD_COPY_KIND }),
        bytes,
        'the annotated copy is still the superseded bytes',
      );
    } finally {
      cleanup();
    }
  });

  it('keeps the pre-cap record shape when the copy was not over the cap', () => {
    const { dir, cleanup } = tempDir('w2m-rot-full-unannotated-');
    try {
      const dek = randomDek();
      pointAtStoredVersion(dir, dek, Buffer.from('under the cap\n'));
      rotateForEntry({ root: dir, entry: CHANGED, snapshotId: '20261117T150000Z-feedface', format: 'full', dek, now: ROTATION_NOW });
      const record = listOldVersions(dir)[0].record;
      assert.equal('approved_over_cap' in record.full_copy, false, 'no approval means no approval field');
      assert.equal('cap_bytes' in record.full_copy, false);
    } finally {
      cleanup();
    }
  });

  it('never annotates a records-mode record (it has no full copy at all)', () => {
    const { dir, cleanup } = tempDir('w2m-rot-records-approved-');
    try {
      writeCurrentPointer({ root: dir, entry: ENTRY, snapshotId: '20261117T140000Z-deadbeef' });
      const result = rotateForEntry({
        root: dir,
        entry: CHANGED,
        snapshotId: '20261117T150000Z-feedface',
        approvedOverCap: true,
        capBytes: 1024,
        now: ROTATION_NOW,
      });
      assert.equal(result.rotated, true);
      assert.equal(result.full_copy, null);
      assert.equal(listOldVersions(dir)[0].record.full_copy, undefined);
    } finally {
      cleanup();
    }
  });
});