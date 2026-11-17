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
 * ## `oldFormat`: the record (default), or the record plus a literal encrypted copy
 *
 * An operator who wants the plan's original shape can ask for it: `oldFormat: 'full'` additionally writes ONE
 * sealed whole-file copy of the superseded version beside the record, named `<ts>-<sha12>.json.enc`, and the
 * record gains `full_copy: {file, sha256, size}` pointing at it. The copy is sealed with the repository DEK via
 * `crypto.sealObject` under the distinct identity `w2m-session-backup/old|<sha256>|<length>` (see
 * `crypto.OLD_COPY_KIND`), so it can never be mistaken for a block object. The plaintext is rebuilt from the
 * version's own blocks through `materialize.rebuildFile` -- the same single implementation restore uses -- so
 * the copy really is the superseded bytes and not a re-read of a file that has already moved on.
 *
 * **Storage honesty**: `full` doubles a superseded version's bytes on top of the deduplicated blocks. That is
 * exactly the cost the default avoids, which is why `records` stays the default and `full` is opt-in.
 *
 * **Failure order**: the sealed copy is written FIRST and the record second. If the copy cannot be built or
 * written, rotation refuses with `BACKUP_ROTATION_WRITE_FAILED` and no record claims a copy exists. If the
 * record write fails after the copy was written, the leftover `.enc` is an orphan: harmless, and `gc` removes it
 * once no record references it (see `gc.mjs`). The snapshot itself was committed before rotation either way.
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
 * rather than a separate chore so the window can never grow unobserved. A pruned record's paired `full_copy`
 * file is deleted with it (record first, copy second: a crash between the two leaves an orphan `.enc`, which
 * `gc` cleans, whereas a copy-first crash would leave a record pointing at a missing copy).
 *
 * An optional age window (`maxAgeDays`) can bound the records by time as well. **Both rules apply**: a record
 * survives only if it is among the newest `keep` **and** not older than `maxAgeDays` days. A record inside the
 * newest N but older than the window is pruned by age; a recent record beyond the newest N is pruned by count.
 * `0`/absent disables the age rule explicitly (0 means "count rule only", never "prune everything").
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readJsonSafe, writeFileAtomic, writeJsonAtomic } from './atomic.mjs';
import { OLD_COPY_KIND, isDek, sealObject } from './crypto.mjs';
import { rebuildFile } from './materialize.mjs';

/** Format of one version record. */
export const OLD_FORMAT = 'w2m-session-backup/old-version';

/** Version of one version record. Frozen by `test/backup-rotation.test.mjs`. */
export const OLD_VERSION = 1;

/** The two shapes a superseded version can be kept in. */
export const OLD_FORMATS = Object.freeze(['records', 'full']);

/** Default: the deduplicated record only (the dedupe-preserving choice; `full` is opt-in). */
export const DEFAULT_OLD_FORMAT = 'records';

/** Suffix of a sealed whole-file copy: `<ts>-<sha12>.json` -> `<ts>-<sha12>.json.enc`. */
export const FULL_COPY_SUFFIX = '.enc';

/**
 * Default cap on ONE `full` whole-file copy: 300 MiB.
 *
 * `full` doubles a superseded version's bytes on top of the deduplicated blocks, so a single 1 GB session would
 * silently add 1 GB per rotation. The engine therefore refuses a `full` run *before writing anything* when a
 * session file that this run would store is larger than this cap, and requires the operator's explicit approval
 * (`allowLargeFullCopy` / CLI `--allow-large-full-copy` / the panel's 「特批并继续」 dialog). `0` disables the cap
 * (an explicit "I accept unbounded copies"); absent means this default.
 */
export const DEFAULT_FULL_COPY_MAX_BYTES = 300 * 1024 * 1024;

/** Format of a `current/` pointer. */
export const CURRENT_FORMAT = 'w2m-session-backup/current';

/** Version of a `current/` pointer. */
export const CURRENT_VERSION = 1;

/** Default number of old versions kept per session. */
export const DEFAULT_KEEP_OLD = 10;

/** Milliseconds in one day; the unit the age rule's `maxAgeDays` is expressed in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Named rotation failures. */
export const ROTATION_CODES = Object.freeze({
  ENTRY_INVALID: 'BACKUP_ROTATION_ENTRY_INVALID',
  WRITE_FAILED: 'BACKUP_ROTATION_WRITE_FAILED',
  POLICY_INVALID: 'BACKUP_ROTATION_POLICY_INVALID',
  FORMAT_INVALID: 'BACKUP_ROTATION_FORMAT_INVALID',
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

/**
 * Normalize the `oldFormat` option.
 *
 * Absent (`undefined`/`null`) means {@link DEFAULT_OLD_FORMAT}: the deduplicated record only. A value that is
 * not one of {@link OLD_FORMATS} is a configuration error naming what it refused, so a typo cannot silently
 * fall back to the default and leave the operator believing copies are being written.
 *
 * @param {unknown} value
 * @returns {{ok: true, format: 'records'|'full'} | {ok: false, reason_code: string, detail: string}}
 */
export function resolveOldFormat(value) {
  if (value === undefined || value === null) return { ok: true, format: DEFAULT_OLD_FORMAT };
  if (typeof value === 'string' && OLD_FORMATS.includes(value)) return { ok: true, format: value };
  const shown = JSON.stringify(value) ?? String(value);
  return {
    ok: false,
    reason_code: ROTATION_CODES.FORMAT_INVALID,
    detail: `oldFormat must be one of ${OLD_FORMATS.join(', ')}, got ${shown}`,
  };
}

/**
 * Normalize the `maxFullCopyBytes` option (the `full` whole-file copy cap).
 *
 * Absent (`undefined`/`null`) means {@link DEFAULT_FULL_COPY_MAX_BYTES}: a `full` run refuses oversized sessions
 * unless it is explicitly approved. `0` means "no cap" (the operator accepts whole-file copies of any size). Any
 * other value must be a non-negative safe integer; anything else is a policy error naming what it refused, so a
 * typo cannot silently turn the cap off.
 *
 * @param {unknown} value
 * @returns {{ok: true, maxBytes: number} | {ok: false, reason_code: string, detail: string}}
 */
export function resolveMaxFullCopyBytes(value) {
  if (value === undefined || value === null) return { ok: true, maxBytes: DEFAULT_FULL_COPY_MAX_BYTES };
  if (Number.isSafeInteger(value) && value >= 0) return { ok: true, maxBytes: value };
  const shown = typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value));
  return {
    ok: false,
    reason_code: ROTATION_CODES.POLICY_INVALID,
    detail: `maxFullCopyBytes must be 0 (no cap) or a non-negative integer number of bytes, got ${shown}`,
  };
}

/**
 * Absolute path of a version record: `old/<ws>/<sid>/<stamp>-<sha12>.json`.
 *
 * Exported because the record's name is the source of the paired `.enc` name ({@link oldFullCopyPath}): one
 * sanitizer, not two, or a hostile stamp could escape `old/` through only one of them.
 */
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
 * Absolute path of a sealed whole-file copy: `old/<ws>/<sid>/<stamp>-<sha12>.json.enc`.
 *
 * Derived from the record's own path (same stamp, same sha12, one sanitizer), so the pair can never disagree
 * about where the copy lives.
 */
export function oldFullCopyPath(root, entry, stamp, sha = entry.sha256) {
  return `${oldVersionPath(root, entry, stamp, sha)}${FULL_COPY_SUFFIX}`;
}

/**
 * Absolute path of the copy a version record points at, or `null` when it has none / names an unsafe path.
 *
 * The record is a file on disk and `full_copy.file` is therefore untrusted input for a delete: only a path that
 * resolves under `old/` is ever returned. A record naming `../something` (or an absolute path) is treated as
 * "no copy" rather than followed -- the same refuse-to-guess posture as `gc`'s reference collection.
 *
 * @param {string} root
 * @param {object} record
 * @returns {string|null}
 */
export function fullCopyPathFor(root, record) {
  const rel = record?.full_copy?.file;
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return null;
  const rootDir = path.resolve(root);
  const target = path.resolve(rootDir, ...rel.replace(/\\/g, '/').split('/'));
  const oldPrefix = path.join(rootDir, 'old') + path.sep;
  return target.startsWith(oldPrefix) ? target : null;
}

/** The timestamp fragment of a version record/copy name, from `previous.updated_at` or `now`. */
function versionStamp(previous, now) {
  return typeof previous.updated_at === 'string' && !Number.isNaN(Date.parse(previous.updated_at))
    ? new Date(previous.updated_at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    : (now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Repository-relative, forward-slash form of an absolute path (the form the record stores). */
function relFromRoot(root, file) {
  return path.relative(path.resolve(root), file).split(path.sep).join('/');
}

/**
 * Build and write the sealed whole-file copy of `previous`, returning the record's `full_copy` row.
 *
 * The plaintext is rebuilt from the version's stored blocks and checked against the digest/size the record
 * carries before it is sealed, so a corrupt store can never produce a copy that is silently not the version it
 * claims to be. Any failure (missing block, bad digest, unwritable target) is `BACKUP_ROTATION_WRITE_FAILED`:
 * rotation refuses rather than writing a record that promises a copy which is not there.
 *
 * @param {{root: string, previous: object, stamp: string, dek: Buffer}} input
 * @returns {{file: string, sha256: string, size: number}}
 */
function writeFullCopy(input) {
  const { previous } = input;
  if (!isDek(input.dek)) {
    throw new RotationError(
      ROTATION_CODES.WRITE_FAILED,
      'oldFormat "full" needs the repository DEK (32 bytes) to seal the whole-file copy',
    );
  }
  const rebuilt = rebuildFile({ root: input.root, entry: previous, dek: input.dek });
  if (rebuilt.ok !== true) {
    throw new RotationError(
      ROTATION_CODES.WRITE_FAILED,
      `the sealed whole-file copy cannot be built from the stored blocks: ${rebuilt.code}: ${rebuilt.detail}`,
    );
  }
  const buffer = rebuilt.buffer;
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (buffer.length !== previous.size || digest !== previous.sha256) {
    throw new RotationError(
      ROTATION_CODES.WRITE_FAILED,
      `the rebuilt superseded version is ${buffer.length} bytes / ${digest}, not the recorded ${previous.size} bytes / ${previous.sha256}`,
    );
  }
  const file = oldFullCopyPath(input.root, previous, input.stamp);
  // Same identity rule as a block object, with the container name set to `old`: the copy is bound to the whole
  // file's digest and length, so it cannot be opened as a block and a block cannot be opened as a copy.
  const sealed = sealObject(buffer, input.dek, { sha256: previous.sha256, length: buffer.length, kind: OLD_COPY_KIND });
  try {
    writeFileAtomic(file, sealed);
  } catch (error) {
    throw new RotationError(ROTATION_CODES.WRITE_FAILED, `${file}: ${error?.detail ?? error?.message ?? String(error)}`);
  }
  return { file: relFromRoot(input.root, file), sha256: previous.sha256, size: buffer.length };
}

/**
 * Write the version record for the version being superseded.
 *
 * With `format: 'full'` (or `input.format` left undefined for the default `records`) the record is written
 * exactly as before; `full` first writes the sealed whole-file copy described in this module's header and then
 * adds `full_copy` to the record. The record's own `format`/`version` fields are unchanged in both modes, so a
 * `full` record is still a `w2m-session-backup/old-version` v1 that older readers can list and restore from.
 *
 * @param {{root: string, previous: object, snapshotId: string, now?: Date, format?: 'records'|'full',
 *   dek?: Buffer, approvedOverCap?: boolean, capBytes?: number}} input `dek` is required for `full` and unused for
 *   `records`; `approvedOverCap`/`capBytes` are supplied by the engine only when the operator explicitly approved
 *   a whole-file copy larger than the configured cap (the record then carries `full_copy.approved_over_cap: true`
 *   and `full_copy.cap_bytes`, so the approval that paid for the bytes is auditable on the record itself)
 * @returns {{file: string, record: object, full_copy: object|null}}
 * @throws {RotationError} `BACKUP_ROTATION_FORMAT_INVALID`, `BACKUP_ROTATION_ENTRY_INVALID` or
 *   `BACKUP_ROTATION_WRITE_FAILED` (the last one for either the copy or the record)
 */
export function recordSupersededVersion(input) {
  const previous = requireEntry(input.previous);
  const formatPolicy = resolveOldFormat(input.format);
  if (formatPolicy.ok !== true) throw new RotationError(formatPolicy.reason_code, formatPolicy.detail);
  const stamp = versionStamp(previous, input.now);
  const file = oldVersionPath(input.root, previous, stamp);
  // Copy FIRST, record second: a record must never claim a copy that failed to land. The reverse crash window
  // (record written, copy missing) is the one that would lie, so it is not the order used here.
  const approvedOverCap = input.approvedOverCap === true;
  const fullCopy = formatPolicy.format === 'full'
    ? {
        ...writeFullCopy({ root: input.root, previous, stamp, dek: input.dek }),
        // Additive audit trail: the approval is written onto the record (not only into the run's result), so a
        // reader of `old/` can tell a deliberately approved oversized copy from one the cap never saw.
        ...(approvedOverCap
          ? {
              approved_over_cap: true,
              cap_bytes: Number.isSafeInteger(input.capBytes) && input.capBytes > 0 ? input.capBytes : DEFAULT_FULL_COPY_MAX_BYTES,
            }
          : {}),
      }
    : null;
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
    // Additive and only present in `full` mode; `sha256`/`size` are the whole-file plaintext identity that
    // `openObject(bytes, dek, {sha256, length, kind: OLD_COPY_KIND})` verifies.
    ...(fullCopy === null ? {} : { full_copy: fullCopy }),
  };
  try {
    writeJsonAtomic(file, record);
  } catch (error) {
    throw new RotationError(ROTATION_CODES.WRITE_FAILED, error?.detail ?? String(error?.message ?? error));
  }
  return { file, record, full_copy: fullCopy };
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
 * Normalize the age half of the retention policy.
 *
 * `undefined`, `null` and `0` all mean "the count rule only": 0 disables the age rule explicitly rather than
 * meaning "prune everything", because a caller that passes 0 to turn a feature off must not get the most
 * destructive possible reading of that value. A positive safe integer is the window in days; anything else
 * (a negative number, a float, a string, NaN) is a policy error naming the value it refused.
 *
 * @param {unknown} value
 * @returns {{ok: true, maxAgeDays: number} | {ok: false, reason_code: string, detail: string}}
 */
export function resolveMaxAgeDays(value) {
  if (value === undefined || value === null) return { ok: true, maxAgeDays: 0 };
  if (Number.isSafeInteger(value) && value >= 0) return { ok: true, maxAgeDays: value };
  // `JSON.stringify` turns NaN/Infinity into `null` and a Symbol into undefined, none of which names the bad
  // value; the fallback keeps the refusal readable instead of hiding what was actually passed.
  const shown = typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value));
  return {
    ok: false,
    reason_code: ROTATION_CODES.POLICY_INVALID,
    detail: `maxAgeDays must be 0 (age rule disabled) or a positive integer number of days, got ${shown}`,
  };
}

/**
 * Decide which version records of ONE session survive the retention policy.
 *
 * Pure: no filesystem access and no deletion. `records` is one session's bucket in the shape
 * `listOldVersions` returns (`{file, record}` rows, newest first); grouping is the caller's job because
 * "newest N" is per session, not across the repository.
 *
 * **Both rules apply**, so a record survives only if it is among the newest `keep` rows **and** its
 * `recorded_at` is not older than `maxAgeDays` days before `now`. A record inside the newest N but older than
 * the window is pruned by age; a recent record beyond the newest N is pruned by count. A record whose
 * `recorded_at` cannot be parsed is kept rather than age-pruned: an unreadable timestamp is not evidence that
 * the version is old, and the count rule still bounds the bucket.
 *
 * @param {Array<{file: string, record: object}>} records newest first (as `listOldVersions` returns them)
 * @param {{keep?: number, maxAgeDays?: number|null, now?: Date|number}} [options]
 * @returns {{kept: Array<{file: string, record: object}>,
 *   pruned: Array<{row: {file: string, record: object}, reason: 'count'|'age'}>}}
 * @throws {RotationError} `BACKUP_ROTATION_POLICY_INVALID` for an invalid `maxAgeDays`/`now`
 */
export function selectPrunable(records, options = {}) {
  const rows = Array.isArray(records) ? records : [];
  const keep = Number.isSafeInteger(options.keep) && options.keep >= 0 ? options.keep : DEFAULT_KEEP_OLD;
  const policy = resolveMaxAgeDays(options.maxAgeDays);
  if (policy.ok !== true) throw new RotationError(policy.reason_code, policy.detail);
  const nowValue = options.now ?? Date.now();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  if (!Number.isFinite(nowMs)) {
    throw new RotationError(ROTATION_CODES.POLICY_INVALID, `now must be a Date or epoch milliseconds, got ${String(nowValue)}`);
  }
  // `cutoffMs === null` means the age rule is off. A record exactly at the cutoff is kept: the rule prunes
  // records *older than* the window, and "one day old" at a one-day window is inside it.
  const cutoffMs = policy.maxAgeDays > 0 ? nowMs - policy.maxAgeDays * DAY_MS : null;
  const kept = [];
  const pruned = [];
  for (const [index, row] of rows.entries()) {
    // Count first: a row beyond the newest N is pruned by the count rule whether or not it is also old, so a
    // single reason (the first rule it violates) is enough to explain the decision.
    if (index >= keep) {
      pruned.push({ row, reason: 'count' });
      continue;
    }
    if (cutoffMs !== null) {
      const recordedMs = Date.parse(row?.record?.recorded_at ?? '');
      if (Number.isFinite(recordedMs) && recordedMs < cutoffMs) {
        pruned.push({ row, reason: 'age' });
        continue;
      }
    }
    kept.push(row);
  }
  return { kept, pruned };
}

/**
 * Enforce the retention policy: the newest `keep` version records per session **and** the `maxAgeDays` window.
 *
 * Both rules apply (see {@link selectPrunable}); `0`/absent `maxAgeDays` keeps the historical count-only
 * behaviour. Pruning is part of rotation rather than a separate chore so a window can never grow unobserved.
 *
 * A pruned record's paired `full_copy` file (only present in `oldFormat: 'full'` repositories) is deleted with
 * it -- **record first, copy second**. The crash window between the two is therefore "a record is gone but its
 * `.enc` remains": harmless, because nothing references it, and `gc` removes it on its next safe run. The
 * opposite order would leave a record pointing at a missing copy, which reads as corruption.
 *
 * @param {{root: string, keep?: number, maxAgeDays?: number|null, now?: Date|number, dryRun?: boolean}} input
 * @returns {{kept: number, removed: Array<{file: string, session_id: string}>,
 *   failed: Array<{file: string, detail: string}>, pruned_by_age: number, full_copies_removed: number}}
 * @throws {RotationError} `BACKUP_ROTATION_POLICY_INVALID` for an invalid `maxAgeDays`, before reading anything
 */
export function pruneOldVersions(input) {
  const keep = Number.isSafeInteger(input.keep) && input.keep >= 0 ? input.keep : DEFAULT_KEEP_OLD;
  // Validate the policy before the walk: an invalid window is a configuration mistake, and it must be reported
  // as one without first enumerating (and possibly refusing halfway through) the version tree.
  const policy = resolveMaxAgeDays(input.maxAgeDays);
  if (policy.ok !== true) throw new RotationError(policy.reason_code, policy.detail);
  const now = input.now ?? Date.now();
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
  let prunedByAge = 0;
  let fullCopiesRemoved = 0;
  for (const rows of bySession.values()) {
    // `listOldVersions` returns newest first across the whole tree, so each bucket is already newest-first.
    const decision = selectPrunable(rows, { keep, maxAgeDays: policy.maxAgeDays, now });
    kept += decision.kept.length;
    for (const { row, reason } of decision.pruned) {
      if (reason === 'age') prunedByAge += 1;
      const copy = fullCopyPathFor(input.root, row.record);
      if (input.dryRun === true) {
        removed.push({ file: row.file, session_id: row.record.session_id });
        if (copy !== null) fullCopiesRemoved += 1;
        continue;
      }
      try {
        fs.rmSync(row.file, { force: true });
        removed.push({ file: row.file, session_id: row.record.session_id });
      } catch (error) {
        failed.push({ file: row.file, detail: error?.code ?? 'unlink failed' });
        continue;
      }
      if (copy === null) continue;
      try {
        fs.rmSync(copy, { force: true });
        fullCopiesRemoved += 1;
      } catch (error) {
        // The record is already gone, so the copy is an orphan rather than a referenced file; gc removes it.
        failed.push({ file: copy, detail: error?.code ?? 'unlink failed' });
      }
    }
  }
  return { kept, removed, failed, pruned_by_age: prunedByAge, full_copies_removed: fullCopiesRemoved };
}

/**
 * Rotate one session's version, then update its `current/` pointer.
 *
 * The retention policy is applied right after the new record is written: `keep` bounds the count and
 * `maxAgeDays` (when positive) bounds the age, and a record survives only if both rules accept it.
 *
 * `format` selects the `old/` shape for the version this rotation supersedes: `records` (default) writes the
 * deduplicated record only; `full` also writes the sealed whole-file copy and requires `dek` (the repository
 * DEK) to rebuild and seal it. A bad `format` is refused before any write, like a bad retention window.
 *
 * @param {{root: string, entry: object, snapshotId: string, keep?: number, maxAgeDays?: number|null,
 *   now?: Date, dryRun?: boolean, format?: 'records'|'full', dek?: Buffer, approvedOverCap?: boolean,
 *   capBytes?: number}} input `approvedOverCap`/`capBytes` are forwarded to
 *   {@link recordSupersededVersion} (the engine sets them only for an explicitly approved over-cap copy)
 * @returns {{rotated: boolean, unchanged: boolean, previous_sha256: string|null, old_file: string|null,
 *   full_copy: object|null, current_file: string, pruned: Array<object>, pruned_by_age: number}}
 * @throws {RotationError} `BACKUP_ROTATION_ENTRY_INVALID` for an unusable entry,
 *   `BACKUP_ROTATION_FORMAT_INVALID` for an unknown `format`, `BACKUP_ROTATION_POLICY_INVALID` for an invalid
 *   `maxAgeDays`, and `BACKUP_ROTATION_WRITE_FAILED` when a `full` copy or the record cannot be written
 *   (all refusals happen before the `current/` pointer moves)
 */
export function rotateForEntry(input) {
  const entry = requireEntry(input.entry);
  // Validate the retention window and the old-version shape before the first write: a bad policy must not write
  // a version record and then fail in the prune that follows it. (`runBackup`/`gc` validate even earlier; this
  // protects direct callers.)
  const agePolicy = resolveMaxAgeDays(input.maxAgeDays);
  if (agePolicy.ok !== true) throw new RotationError(agePolicy.reason_code, agePolicy.detail);
  const formatPolicy = resolveOldFormat(input.format);
  if (formatPolicy.ok !== true) throw new RotationError(formatPolicy.reason_code, formatPolicy.detail);
  const previous = readCurrent(input.root, entry);
  const currentFile = currentPath(input.root, entry);
  if (previous === null) {
    if (input.dryRun !== true) writeCurrentPointer({ root: input.root, entry, snapshotId: input.snapshotId, now: input.now });
    return {
      rotated: false,
      unchanged: false,
      previous_sha256: null,
      old_file: null,
      full_copy: null,
      current_file: currentFile,
      pruned: [],
      pruned_by_age: 0,
    };
  }
  if (previous.sha256 === entry.sha256) {
    return {
      rotated: false,
      unchanged: true,
      previous_sha256: previous.sha256,
      old_file: null,
      full_copy: null,
      current_file: currentFile,
      pruned: [],
      pruned_by_age: 0,
    };
  }
  if (input.dryRun === true) {
    return {
      rotated: true,
      unchanged: false,
      previous_sha256: previous.sha256,
      old_file: null,
      full_copy: null,
      current_file: currentFile,
      pruned: [],
      pruned_by_age: 0,
    };
  }
  const recorded = recordSupersededVersion({
    root: input.root,
    previous: { ...previous, rel: previous.rel ?? entry.rel, session_id: entry.session_id, workspace: entry.workspace },
    snapshotId: input.snapshotId,
    now: input.now,
    format: formatPolicy.format,
    dek: input.dek,
    approvedOverCap: input.approvedOverCap,
    capBytes: input.capBytes,
  });
  writeCurrentPointer({ root: input.root, entry, snapshotId: input.snapshotId, now: input.now });
  const pruned = pruneOldVersions({ root: input.root, keep: input.keep ?? DEFAULT_KEEP_OLD, maxAgeDays: agePolicy.maxAgeDays, now: input.now });
  return {
    rotated: true,
    unchanged: false,
    previous_sha256: previous.sha256,
    old_file: recorded.file,
    full_copy: recorded.full_copy,
    current_file: currentFile,
    pruned: pruned.removed,
    pruned_by_age: pruned.pruned_by_age,
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
