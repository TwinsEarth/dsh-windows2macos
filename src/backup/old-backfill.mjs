/**
 * Backfill: give every existing `old/` record the optional sealed whole-file copy it predates.
 *
 * ## Why this is a separate command and not "the next run will fix it"
 *
 * `oldFormat: 'full'` (docs/BACKUP-DESIGN.md §24, `rotation.mjs`) writes the extra `<record>.json.enc` only at
 * the moment a version is superseded. A repository created before that option therefore holds records that
 * reference `objects/` and nothing else; turning `full` on leaves every existing record without a copy until
 * that session happens to change again -- and the oldest versions, which are exactly the ones a migration is
 * for, may never change again. `old-backfill` is the one-shot migration: for each record that lacks a copy,
 * rebuild the version's plaintext from the record's own blocks (through `materialize.rebuildFile`, the same
 * single implementation restore uses), verify it against the record's `sha256`/`size`, seal it under the
 * `old` identity (`crypto.OLD_COPY_KIND`) exactly as `full` rotation would, write it beside the record, and
 * add the record's additive `full_copy: {file, sha256, size}` field. The record's `format`/`version` stay
 * untouched, so an old reader keeps listing and restoring it.
 *
 * ## What it will and will not do
 *
 *   * a record that already has a usable copy is **skipped**: a second run writes nothing (idempotent);
 *   * a copy is judged complete **by its own format** (the rule `verify`/`old-restore` use):
 *     a v1 object must be exactly `size + SEALED_COPY_OVERHEAD` bytes (a crash during the copy write leaves a
 *     short file, and the record's length is the authoritative statement about it), and a chunked-v2 file must
 *     match the length its own plaintext header implies (`chunked.measureChunkedFile` -- the record count comes
 *     from the header's `chunkBytes`, so the v1 arithmetic is wrong for it by construction). Anything else, or
 *     metadata that disagrees with the record, is rebuilt and rewritten (`repaired`);
 *   * a `.json.enc` no record references is counted as an `orphan` and **left alone**: `gc` deletes
 *     unreferenced copies on its next safe run, which is the only place deletion of them belongs;
 *   * a record whose blocks cannot rebuild its recorded bytes is reported (`BACKUP_OLD_RECORD_INVALID` /
 *     `BACKUP_OLD_BACKFILL_FAILED`), never guessed around: writing a copy of something else beside the record
 *     would be worse than leaving the copy absent.
 *
 * ## Which format a repair writes (and why it is v1)
 *
 * A repair/backfill writes the **v1** whole-file object under the `old` identity: that is the shape this
 * migration command has always produced, it is readable by every build that can read `old/` at all, and its
 * fixed overhead is what `SEALED_COPY_OVERHEAD` names. New copies written by **rotation** are chunked-v2 (§28);
 * this command does not rewrite those either. The one record edit a repair can therefore need even when the
 * copy's metadata matched is to **drop** a `full_copy.format` claim a v2 record carries, because the file it
 * just put back is a v1 object -- the record must describe the file it names.
 *
 * The copy name is the record's own name plus {@link FULL_COPY_SUFFIX} -- the same `<record>.json.enc` that
 * `rotation.oldFullCopyPath` produces in `full` mode. It is derived from the record file on disk rather than
 * re-derived from the record's `workspace`/`session_id` fields, so the copy always lands beside the record the
 * rest of the code walks, and a record whose fields disagree with its location cannot be written elsewhere.
 *
 * ## Ordering, the lock, and the dry run
 *
 * A real run takes the repository lock (a backfill must not race the scheduled run that could prune the very
 * record being updated), opens the repository key, then rebuilds. The sealed copy is written first and the
 * record second, exactly as rotation does: a crash between the two leaves an unreferenced `.enc` (harmless,
 * collected by gc), never a record that promises a copy which is not on disk. A dry run takes no lock and
 * opens no key -- the same rule `run --dry-run` follows -- so it cannot write anything (not even the optional
 * machine-envelope upgrade `openRepoKey` may perform); it projects what a real run would do from the records'
 * structure alone, and therefore reports `bytes_written: 0`.
 *
 * ## Refusals are results, not throws
 *
 * Like `openRepoKey`/`runBackup`, expected failures are returned as `{ok:false, reason_code, detail}`:
 * `BACKUP_NO_PERMISSION` when the repository key cannot be opened, `BACKUP_LOCKED` when another writer holds
 * the lock, `BACKUP_REPO_NOT_INITIALIZED` when the directory is not this repository format (a migration command
 * must never mint `keys.json` inside an arbitrary directory), plus the layout/rotation codes it reuses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { writeFileAtomic, writeJsonAtomic } from './atomic.mjs';
import { isChunkedV2, measureChunkedFile } from './chunked.mjs';
import { NONCE_LENGTH, OBJECT_MAGIC, OLD_COPY_KIND, TAG_LENGTH, isDek, sealObject } from './crypto.mjs';
import { listFullCopies } from './gc.mjs';
import { LAYOUT_CODES, readDescriptor, validateDescriptor } from './layout.mjs';
import { withRepoLock } from './locks.mjs';
import { rebuildFile } from './materialize.mjs';
import { NO_PERMISSION, openRepoKey } from './keystore.mjs';
import { REPO_CODES } from './repo.mjs';
import {
  FULL_COPY_SUFFIX,
  OLD_FORMAT,
  ROTATION_CODES,
  fullCopyPathFor,
  listOldVersions,
  oldFullCopyPath,
} from './rotation.mjs';

/** Named failures this command adds. Everything else it reports reuses an existing code. */
export const BACKFILL_CODES = Object.freeze({
  /** The record does not describe the bytes its own blocks rebuild (or names a copy path outside `old/`). */
  RECORD_INVALID: 'BACKUP_OLD_RECORD_INVALID',
  /** The bytes could not be rebuilt or written: the store, the disk, or the record update failed. */
  COPY_FAILED: 'BACKUP_OLD_BACKFILL_FAILED',
});

/**
 * Bytes a **v1** sealed whole-file copy adds around its plaintext: `MAGIC | nonce | ciphertext | tag`.
 *
 * The expected on-disk length of a v1 copy is therefore the plaintext size (the record's `size`) plus this
 * constant. A `.enc` of any other length is a torn write and is repaired. A chunked-v2 copy has no such constant
 * -- its length follows the header's `chunkBytes` -- so {@link copyIsComplete} asks `measureChunkedFile` instead.
 */
export const SEALED_COPY_OVERHEAD = OBJECT_MAGIC.length + NONCE_LENGTH + TAG_LENGTH;

/** The frozen digest shape a version record carries. */
const SHA256_RE = /^[0-9a-f]{64}$/u;

/** A success result's zeroed counters (also the base of every refusal, so the shape never varies). */
function emptyResult(dryRun) {
  return {
    ok: true,
    backfilled: 0,
    repaired: 0,
    skipped: 0,
    orphans: 0,
    failed: [],
    bytes_written: 0,
    dry_run: dryRun === true,
    reason_code: null,
    detail: null,
  };
}

/** A refusal in the house shape: still a complete result, so every caller can read the same fields. */
function refusal(reasonCode, detail, dryRun) {
  return { ...emptyResult(dryRun), ok: false, reason_code: reasonCode, detail };
}

/** A filesystem error rendered without leaking a message shape the caller has to parse. */
function describeError(error) {
  return error?.detail ?? error?.message ?? String(error);
}

/** A repository-relative, forward-slash path (the form a record's `full_copy.file` stores). */
function relFromRoot(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * Normalize `limit`: absent means "no limit"; any non-negative safe integer is accepted (0 = plan only,
 * which is a useful way to ask for the orphan count without writing). Anything else is refused by name so a
 * typo cannot silently mean "unlimited".
 *
 * @param {unknown} value
 * @returns {{ok: true, limit: number|null} | {ok: false, detail: string}}
 */
export function resolveBackfillLimit(value) {
  if (value === undefined || value === null) return { ok: true, limit: null };
  if (Number.isSafeInteger(value) && value >= 0) return { ok: true, limit: value };
  const shown = typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value));
  return { ok: false, detail: `limit must be a non-negative integer, got ${shown}` };
}

/** The size of a regular file, or `null` when it is absent/unreadable/not a file. */
function fileSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * True when the copy on disk is a complete copy of `record`'s bytes **in the format the file actually is**.
 *
 * The format is decided by the file's own magic, never by `full_copy.format` (a record field is a claim; §28):
 * a v1 object must have the exact `size + SEALED_COPY_OVERHEAD` length, and a chunked-v2 file must have the
 * length its own plaintext header implies and name the record's identity. A v2 header that does not parse (a file
 * torn inside its header) is incomplete, so it is repaired like a short v1 copy rather than skipped forever. A
 * missing file is incomplete, which is what makes the "repair a deleted `.enc`" path work.
 *
 * @param {string} copyFile
 * @param {object} record
 * @param {number} expectedSize `record.size + SEALED_COPY_OVERHEAD` (the v1 length)
 * @returns {boolean}
 */
function copyIsComplete(copyFile, record, expectedSize) {
  if (!isChunkedV2(copyFile)) return fileSize(copyFile) === expectedSize;
  try {
    const layout = measureChunkedFile(copyFile);
    return layout.complete === true && layout.sha256 === record.sha256 && layout.size === record.size;
  } catch {
    return false;
  }
}

/**
 * The stamp fragment of a version record's file name, `<stamp>-<sha12>.json` -> `<stamp>`.
 *
 * `rotation.oldVersionPath` built the name from a sanitized stamp, so re-sanitizing the recovered stamp is a
 * no-op and `oldFullCopyPath` reproduces the sibling name. A file that does not have that shape returns
 * `null`, and the caller falls back to the literal sibling (`<record>.json.enc`).
 */
function stampOfRecordName(file) {
  const base = path.basename(file);
  if (!base.endsWith('.json')) return null;
  const stem = base.slice(0, -'.json'.length);
  const dash = stem.lastIndexOf('-');
  return dash > 0 ? stem.slice(0, dash) : null;
}

/** The sealed copy path paired with a record file (see the module header for the naming rule). */
function copyPathForRecord(root, record, recordFile) {
  const sibling = `${recordFile}${FULL_COPY_SUFFIX}`;
  const stamp = stampOfRecordName(recordFile);
  if (stamp === null) return sibling;
  try {
    const derived = oldFullCopyPath(root, record, stamp);
    return path.resolve(derived) === path.resolve(sibling) ? derived : sibling;
  } catch {
    // The record's own fields are unusable as path components; the sibling name never depends on them.
    return sibling;
  }
}

/** Why a record cannot be backfilled, or `null` when its own fields are usable. */
function recordProblem(record) {
  if (record?.format !== OLD_FORMAT) return 'the file is not a version record';
  if (typeof record.sha256 !== 'string' || !SHA256_RE.test(record.sha256)) {
    return 'sha256 is not a lowercase 64-character digest';
  }
  if (!Number.isSafeInteger(record.size) || record.size < 0) {
    return 'size is not a non-negative safe integer';
  }
  if (!Array.isArray(record.blocks)) return 'blocks is not an array';
  for (const block of record.blocks) {
    if (block === null || typeof block !== 'object') return 'a block is not an object';
    if (typeof block.sha256 !== 'string' || !SHA256_RE.test(block.sha256)) return 'a block has no usable sha256';
    if (!Number.isSafeInteger(block.length) || block.length < 0) return 'a block has no usable length';
  }
  return null;
}

/**
 * Rebuild the record's version, verify it against the record, and write the sealed copy; then (when
 * `updateRecord` is given) update the record atomically.
 *
 * Copy first, record second (the order rotation uses): a record must never claim a copy that failed to land.
 *
 * @param {{root: string, file: string, record: object, copyFile: string, updateRecord: object|null,
 *   dek: Buffer, action: 'backfilled'|'repaired'}} input
 * @returns {{ok: true, action: string, copy: string, bytes: number} |
 *   {ok: false, reason_code: string, detail: string, bytes?: number}}
 */
function writeSealedCopy(input) {
  const rebuilt = rebuildFile({ root: input.root, entry: input.record, dek: input.dek });
  if (rebuilt.ok !== true) {
    return {
      ok: false,
      reason_code: BACKFILL_CODES.COPY_FAILED,
      detail: `the version cannot be rebuilt from the stored blocks: ${rebuilt.code}: ${rebuilt.detail}`,
    };
  }
  const buffer = rebuilt.buffer;
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (buffer.length !== input.record.size || digest !== input.record.sha256) {
    return {
      ok: false,
      reason_code: BACKFILL_CODES.RECORD_INVALID,
      detail: `the rebuilt version is ${buffer.length} bytes / ${digest}, not the recorded ${input.record.size} bytes / ${input.record.sha256}`,
    };
  }
  const sealed = sealObject(buffer, input.dek, {
    sha256: input.record.sha256,
    length: buffer.length,
    kind: OLD_COPY_KIND,
  });
  try {
    writeFileAtomic(input.copyFile, sealed);
  } catch (error) {
    return { ok: false, reason_code: BACKFILL_CODES.COPY_FAILED, detail: `${input.copyFile}: ${describeError(error)}` };
  }
  if (input.updateRecord !== null) {
    const updated = { ...input.record, full_copy: input.updateRecord };
    try {
      writeJsonAtomic(input.file, updated);
    } catch (error) {
      // The copy landed but the record does not reference it: report the failure, and leave the file for gc's
      // orphan sweep rather than pretending the migration succeeded. The bytes were written, so they are counted.
      return {
        ok: false,
        reason_code: BACKFILL_CODES.COPY_FAILED,
        bytes: sealed.length,
        detail: `the sealed copy was written but the record could not be updated: ${describeError(error)}`,
      };
    }
  }
  return { ok: true, action: input.action, copy: input.copyFile, bytes: sealed.length };
}

/**
 * Decide what one record needs and (for a real run) do it.
 *
 * Pure planning when `dryRun` is true: no key is required and nothing is written; the outcome still reports
 * whether the record would be skipped, backfilled or repaired.
 *
 * @param {{root: string, file: string, record: object, dek: Buffer|null, dryRun: boolean}} input
 * @returns {{ok: true, action: 'skipped'|'backfilled'|'repaired', copy: string, bytes: number} |
 *   {ok: false, reason_code: string, detail: string, bytes?: number}}
 */
function backfillOne(input) {
  const { root, file, record } = input;
  const problem = recordProblem(record);
  if (problem !== null) return { ok: false, reason_code: BACKFILL_CODES.RECORD_INVALID, detail: problem };

  if (record.full_copy !== undefined && record.full_copy !== null) {
    const copyFile = fullCopyPathFor(root, record);
    if (copyFile === null) {
      return {
        ok: false,
        reason_code: BACKFILL_CODES.RECORD_INVALID,
        detail: 'full_copy.file does not name a path under old/, so it is never followed',
      };
    }
    const metadataMatches = record.full_copy.sha256 === record.sha256 && record.full_copy.size === record.size;
    const expectedSize = record.size + SEALED_COPY_OVERHEAD;
    if (metadataMatches && copyIsComplete(copyFile, record, expectedSize)) {
      return { ok: true, action: 'skipped', copy: copyFile, bytes: 0 };
    }
    if (input.dryRun === true) return { ok: true, action: 'repaired', copy: copyFile, bytes: 0 };
    // A repair writes the v1 object (this command's frozen shape), so a record that claimed the chunked-v2 format
    // must be rewritten to drop that claim -- otherwise the record would describe a container it does not name.
    const rewritesRecord = metadataMatches === false || record.full_copy.format !== undefined;
    return writeSealedCopy({
      root,
      file,
      record,
      copyFile,
      // Only rewrite the record when its metadata is what was wrong, or when the repaired file's format differs
      // from the one the record claims; a torn v1 file alone needs no record write.
      updateRecord: rewritesRecord
        ? { file: relFromRoot(root, copyFile), sha256: record.sha256, size: record.size }
        : null,
      dek: input.dek,
      action: 'repaired',
    });
  }

  const copyFile = copyPathForRecord(root, record, file);
  if (input.dryRun === true) return { ok: true, action: 'backfilled', copy: copyFile, bytes: 0 };
  return writeSealedCopy({
    root,
    file,
    record,
    copyFile,
    updateRecord: { file: relFromRoot(root, copyFile), sha256: record.sha256, size: record.size },
    dek: input.dek,
    action: 'backfilled',
  });
}

/**
 * Walk the records (bounded by `limit`), then count `.json.enc` files no record references.
 *
 * Orphans are counted **after** the writes, against the references the records now carry: a copy this run
 * created and recorded is not an orphan, while a `.enc` whose record write failed (or that predates the
 * record) is one -- and is left for gc, never deleted here.
 */
function runBackfill(input) {
  const { root, dryRun, dek } = input;
  const rows = listOldVersions(root);
  const failed = [];
  const referenced = new Set();
  // Every copy an existing record already references stays referenced even when the limit keeps this run from
  // examining that record: the orphan sweep must never call a live record's copy an orphan.
  for (const row of rows) {
    const existing = fullCopyPathFor(root, row.record);
    if (existing !== null) referenced.add(path.resolve(existing));
  }

  let backfilled = 0;
  let repaired = 0;
  let skipped = 0;
  let bytesWritten = 0;
  for (const row of rows) {
    // `limit` bounds the copies this run writes, not the records it reads: records that are already complete (or
    // that fail) cost no budget, so `--limit N` always makes progress through a partly-migrated repository.
    if (input.limit !== null && backfilled + repaired >= input.limit) break;
    const outcome = backfillOne({ root, file: row.file, record: row.record, dek, dryRun });
    if (outcome.ok !== true) {
      failed.push({ record: row.file, reason_code: outcome.reason_code, detail: outcome.detail });
      bytesWritten += outcome.bytes ?? 0;
      continue;
    }
    if (outcome.action === 'skipped') {
      skipped += 1;
      referenced.add(path.resolve(outcome.copy));
      continue;
    }
    if (outcome.action === 'backfilled') backfilled += 1;
    else repaired += 1;
    bytesWritten += outcome.bytes;
    referenced.add(path.resolve(outcome.copy));
  }

  let orphans = 0;
  for (const copy of listFullCopies(root)) {
    if (!referenced.has(path.resolve(copy.file))) orphans += 1;
  }

  return {
    ok: failed.length === 0,
    backfilled,
    repaired,
    skipped,
    orphans,
    failed,
    bytes_written: dryRun === true ? 0 : bytesWritten,
    dry_run: dryRun === true,
    reason_code: failed.length === 0 ? null : BACKFILL_CODES.COPY_FAILED,
    detail: failed.length === 0 ? null : `${failed.length} record(s) could not be backfilled; see failed`,
  };
}

/**
 * Give every existing `old/` record the sealed whole-file copy that `oldFormat: 'full'` records carry.
 *
 * Idempotent: a second run over a migrated repository reports `backfilled: 0, repaired: 0` and writes nothing.
 * A dry run writes nothing at all (it takes no lock and opens no key) and reports what a real run would do.
 *
 * @param {{root: string, dshHome: string, password?: string|Buffer|null, accountId?: string|null,
 *   platform?: string, runner?: Function, machineKey?: boolean, dryRun?: boolean, limit?: number|null}} input
 * @returns {{
 *   ok: boolean, backfilled: number, repaired: number, skipped: number, orphans: number,
 *   failed: Array<{record: string, reason_code: string, detail: string}>, bytes_written: number,
 *   dry_run: boolean, reason_code: string|null, detail: string|null
 * }}
 */
export function backfillOldFullCopies(input) {
  const dryRun = input?.dryRun === true;
  if (typeof input?.root !== 'string' || input.root.trim() === '') {
    return refusal(LAYOUT_CODES.UNRESOLVED, 'backfillOldFullCopies needs a repository root path', dryRun);
  }
  const root = path.resolve(input.root);
  const limit = resolveBackfillLimit(input.limit);
  if (limit.ok !== true) return refusal(ROTATION_CODES.POLICY_INVALID, limit.detail, dryRun);

  // Validate the repository before anything is created or locked: a migration command pointed at the wrong
  // directory must not mint keys.json (or an empty tmp/) inside it.
  let descriptor;
  try {
    descriptor = readDescriptor(root);
  } catch (error) {
    return refusal(error?.code ?? LAYOUT_CODES.DESCRIPTOR_UNREADABLE, describeError(error), dryRun);
  }
  if (descriptor === null) {
    return refusal(
      REPO_CODES.NOT_INITIALIZED,
      `${root} has no backup.json; point --backup-dir at the backup repository`,
      dryRun,
    );
  }
  const validated = validateDescriptor(descriptor);
  if (validated.ok !== true) return refusal(validated.error.code, validated.error.detail, dryRun);

  let held = null;
  try {
    if (dryRun !== true) {
      const acquired = withRepoLock({ root });
      if (acquired.ok !== true) return refusal(acquired.reason_code, acquired.detail, dryRun);
      held = acquired;
    }
    let dek = null;
    if (dryRun !== true) {
      let key;
      try {
        key = openRepoKey({
          root,
          dshHome: input.dshHome,
          accountId: input.accountId ?? null,
          password: input.password ?? null,
          platform: input.platform,
          runner: input.runner,
          machineKey: input.machineKey,
        });
      } catch (error) {
        return refusal(BACKFILL_CODES.COPY_FAILED, `opening the repository key failed: ${describeError(error)}`, dryRun);
      }
      if (key.ok !== true) {
        // The command's one permission refusal, with the keystore's own reason kept in the detail so an operator
        // can tell "wrong password" from "this keys.json is malformed".
        return refusal(NO_PERMISSION, `${key.reason_code}: ${key.detail}`, dryRun);
      }
      if (!isDek(key.dek)) return refusal(NO_PERMISSION, 'the repository key opened without a usable DEK', dryRun);
      dek = key.dek;
    }
    return runBackfill({ root, dryRun, dek, limit: limit.limit });
  } finally {
    if (held !== null) held.release();
  }
}
