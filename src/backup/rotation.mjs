/**
 * Rotation: keep a restorable record of each superseded session version under `old/<workspace>/<session>/`.
 *
 * ## What `old/` holds, and why it is not a copy of the file
 *
 * The plan wrote `old/<ws>/<sid>/<ts>-<sha12>.zst.enc`, i.e. the previous session file encrypted and copied.
 * That duplicates the repository's own storage: the bytes of that version are already in `objects/`, and a
 * 114 MB session that changes daily would add 1.1 GB of copies for a ten-version window -- the very cost that
 * content-addressed deduplication exists to remove.
 *
 * So a version record is written instead: the same shape the manifest uses for a file (path, size, digest,
 * blocks), plus when the version was superseded. It restores byte-exactly from `objects/`, takes a few hundred
 * bytes, and keeps the user-visible property that matters -- **old versions, grouped by session**.
 *
 * ## When rotation happens
 *
 * Only when the session's content digest changed since the previous snapshot. Unchanged content does not rotate:
 * daily backups of a quiet session would otherwise manufacture a "version" per day, and the ten-version window
 * would silently mean ten days rather than ten changes.
 *
 * ## The bound
 *
 * `keepOldPerSession` (default 10) is enforced after every rotation, newest first. Pruning is part of rotation
 * rather than a separate chore so the window can never grow unobserved.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readJsonSafe, writeJsonAtomic } from './atomic.mjs';

/** Format of one version record. */
export const OLD_FORMAT = 'w2m-session-backup/old-version';

/** Version of one version record. Frozen by `test/backup-rotation.test.mjs`. */
export const OLD_VERSION = 1;

/** Format of a `current/` pointer. */
export const CURRENT_FORMAT = 'w2m-session-backup/current';

/** Version of a `current/` pointer. */
export const CURRENT_VERSION = 1;

/** Default number of old versions kept per session. */
export const DEFAULT_KEEP_OLD = 10;

/** Named rotation failures. */
export const ROTATION_CODES = Object.freeze({
  ENTRY_INVALID: 'BACKUP_ROTATION_ENTRY_INVALID',
  WRITE_FAILED: 'BACKUP_ROTATION_WRITE_FAILED',
});

/** A rotation failure with a stable code. */
export class RotationError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'RotationError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

/** Require the six fields a session entry must carry to be recorded. */
function requireEntry(entry) {
  const bad = (field) => {
    throw new RotationError(ROTATION_CODES.ENTRY_INVALID, `session entry is missing ${field}`);
  };
  if (entry === null || typeof entry !== 'object') throw new RotationError(ROTATION_CODES.ENTRY_INVALID, 'session entry is not an object');
  for (const field of ['rel', 'session_id', 'workspace', 'sha256', 'size']) if (!(field in entry)) bad(field);
  if (!Array.isArray(entry.blocks)) bad('blocks');
  return entry;
}

/** `current/<workspace>/<session>.json` -- one pointer per session. */
export function currentRel(entry) {
  requireEntry(entry);
  return ['current', entry.workspace, `${entry.session_id}.json`].join('/');
}

/** Absolute `current/` pointer path. */
export function currentPath(root, entry) {
  return path.join(path.resolve(root), ...currentRel(entry).split('/'));
}

/**
 * Read the `current/` pointer for a session.
 *
 * @returns {{rel: string, session_id: string, workspace: string, sha256: string, size: number, blocks: Array<object>,
 *   snapshot_id: string, updated_at: string} | null}
 */
export function readCurrent(root, entry) {
  const file = currentPath(root, entry);
  const parsed = readJsonSafe(file);
  if (parsed === null || parsed?.format !== CURRENT_FORMAT) return null;
  if (typeof parsed.sha256 !== 'string' || !Array.isArray(parsed.blocks)) return null;
  return parsed;
}

/** Absolute path of a version record: `old/<ws>/<sid>/<stamp>-<sha12>.json`. */
export function oldVersionPath(root, entry, stamp, sha = entry.sha256) {
  // A stamp becomes part of a file name, so anything that is not [0-9A-Za-z._-] is dropped and runs of dots are
  // collapsed: `../../escape` must not survive as `....escape`, or the "old/" directory could be escaped by a
  // caller that passes a path fragment where a timestamp was expected.
  const stampSafe =
    String(stamp)
      .replace(/[^0-9A-Za-z._-]/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+/, '') || 'version';
  const short = String(sha).slice(0, 12);
  return path.join(path.resolve(root), 'old', entry.workspace, entry.session_id, `${stampSafe}-${short}.json`);
}

/**
 * Write the version record for the version being superseded.
 *
 * @param {{root: string, previous: object, snapshotId: string, now?: Date}} input
 * @returns {{file: string, record: object}}
 */
export function recordSupersededVersion(input) {
  const previous = requireEntry(input.previous);
  const stamp = typeof previous.updated_at === 'string' && !Number.isNaN(Date.parse(previous.updated_at))
    ? new Date(previous.updated_at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    : (input.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const file = oldVersionPath(input.root, previous, stamp);
  const record = {
    format: OLD_FORMAT,
    version: OLD_VERSION,
    rel: previous.rel,
    session_id: previous.session_id,
    workspace: previous.workspace,
    sha256: previous.sha256,
    size: previous.size,
    blocks: previous.blocks,
    snapshot_id: previous.snapshot_id ?? null,
    superseded_by: input.snapshotId,
    recorded_at: (input.now ?? new Date()).toISOString(),
  };
  try {
    writeJsonAtomic(file, record);
  } catch (error) {
    throw new RotationError(ROTATION_CODES.WRITE_FAILED, error?.detail ?? String(error?.message ?? error));
  }
  return { file, record };
}

/** Every version record under `old/`, newest first per session. */
export function listOldVersions(root, { workspace = null, sessionId = null } = {}) {
  const base = path.join(path.resolve(root), 'old');
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const record = readJsonSafe(full);
      if (record === null || record.format !== OLD_FORMAT) continue;
      if (workspace !== null && record.workspace !== workspace) continue;
      if (sessionId !== null && record.session_id !== sessionId) continue;
      out.push({ file: full, record });
    }
  };
  walk(base);
  return out.sort((a, b) => String(b.record.recorded_at ?? '').localeCompare(String(a.record.recorded_at ?? '')));
}

/**
 * Enforce `keep` newest version records per session.
 *
 * @param {{root: string, keep?: number, dryRun?: boolean}} input
 * @returns {{kept: number, removed: Array<{file: string, session_id: string}>, failed: Array<{file: string, detail: string}>}}
 */
export function pruneOldVersions(input) {
  const keep = Number.isSafeInteger(input.keep) && input.keep >= 0 ? input.keep : DEFAULT_KEEP_OLD;
  const bySession = new Map();
  for (const row of listOldVersions(input.root)) {
    const key = `${row.record.workspace}/${row.record.session_id}`;
    const bucket = bySession.get(key) ?? [];
    bucket.push(row);
    bySession.set(key, bucket);
  }
  const removed = [];
  const failed = [];
  let kept = 0;
  for (const rows of bySession.values()) {
    // `listOldVersions` returns newest first across the whole tree, so each bucket is already newest-first.
    for (const [index, row] of rows.entries()) {
      if (index < keep) {
        kept += 1;
        continue;
      }
      if (input.dryRun === true) {
        removed.push({ file: row.file, session_id: row.record.session_id });
        continue;
      }
      try {
        fs.rmSync(row.file, { force: true });
        removed.push({ file: row.file, session_id: row.record.session_id });
      } catch (error) {
        failed.push({ file: row.file, detail: error?.code ?? 'unlink failed' });
      }
    }
  }
  return { kept, removed, failed };
}

/**
 * Rotate one session's version, then update its `current/` pointer.
 *
 * @param {{root: string, entry: object, snapshotId: string, keep?: number, now?: Date, dryRun?: boolean}} input
 * @returns {{rotated: boolean, unchanged: boolean, previous_sha256: string|null, old_file: string|null,
 *   current_file: string, pruned: Array<object>}}
 */
export function rotateForEntry(input) {
  const entry = requireEntry(input.entry);
  const previous = readCurrent(input.root, entry);
  const currentFile = currentPath(input.root, entry);
  if (previous === null) {
    if (input.dryRun !== true) writeCurrentPointer({ root: input.root, entry, snapshotId: input.snapshotId, now: input.now });
    return { rotated: false, unchanged: false, previous_sha256: null, old_file: null, current_file: currentFile, pruned: [] };
  }
  if (previous.sha256 === entry.sha256) {
    return { rotated: false, unchanged: true, previous_sha256: previous.sha256, old_file: null, current_file: currentFile, pruned: [] };
  }
  if (input.dryRun === true) {
    return { rotated: true, unchanged: false, previous_sha256: previous.sha256, old_file: null, current_file: currentFile, pruned: [] };
  }
  const recorded = recordSupersededVersion({
    root: input.root,
    previous: { ...previous, rel: previous.rel ?? entry.rel, session_id: entry.session_id, workspace: entry.workspace },
    snapshotId: input.snapshotId,
    now: input.now,
  });
  writeCurrentPointer({ root: input.root, entry, snapshotId: input.snapshotId, now: input.now });
  const pruned = pruneOldVersions({ root: input.root, keep: input.keep ?? DEFAULT_KEEP_OLD });
  return {
    rotated: true,
    unchanged: false,
    previous_sha256: previous.sha256,
    old_file: recorded.file,
    current_file: currentFile,
    pruned: pruned.removed,
  };
}

/**
 * Write the `current/` pointer for an entry.
 *
 * @param {{root: string, entry: object, snapshotId: string, now?: Date}} input
 * @returns {object} the pointer that was written
 */
export function writeCurrentPointer(input) {
  const { entry, root } = input;
  const pointer = {
    format: CURRENT_FORMAT,
    version: CURRENT_VERSION,
    rel: entry.rel,
    session_id: entry.session_id,
    workspace: entry.workspace,
    sha256: entry.sha256,
    size: entry.size,
    blocks: entry.blocks,
    snapshot_id: input.snapshotId,
    updated_at: (input.now ?? new Date()).toISOString(),
  };
  try {
    writeJsonAtomic(currentPath(root, entry), pointer);
  } catch (error) {
    throw new RotationError(ROTATION_CODES.WRITE_FAILED, error?.detail ?? String(error?.message ?? error));
  }
  return pointer;
}
