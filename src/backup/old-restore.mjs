/**
 * Restore one superseded version from its sealed whole-file copy under `old/`.
 *
 * ## Why this exists when a version record already restores from blocks
 *
 * `old/<ws>/<sid>/<ts>-<sha12>.json` restores a version from `objects/` (the deduplicated record, §13/§21), so a
 * version is normally recoverable without any extra file. The `oldFormat: 'full'` option (§24) additionally keeps
 * one sealed whole-file copy (`<record>.json.enc`) precisely because the deduplicated form has a failure mode a
 * copy does not: **the blocks can be gone**. `gc` never deletes a block a record references... unless the record
 * itself is unreadable, pruned, or the object store was damaged outside this code (bad disk, an external tool, a
 * partial restore of the repository directory). In that state the record still names the version, the `.enc` is
 * still on disk, and the bytes are still recoverable with the repository DEK -- but there was no command that did
 * it. This module is that command, split into the same plan/apply pair as `restore.mjs` so the operator sees what
 * would be written before anything is.
 *
 * ## What it is not
 *
 * This restores **one version, one file**, to a path the caller names (`--out`). It does not restore a whole
 * snapshot, does not write attachments, does not touch the workspace registry, and does not validate anything
 * against the installed Harness's runtime (G5): the copy is only checked by the static doctor
 * (`diagnoseSessionBuffer`, the cheap pre-filter -- §19.1). A restored log destined for the live home should
 * therefore still go through `w2m-backup restore`/`w2m-fix renumber` semantics; this command is the way to get
 * the bytes back when the repository half that `restore` needs is what is broken.
 *
 * ## The doctor gate, and `--force-invalid`
 *
 * The static doctor answers the cheap offline question "is this a v4 log the client can still append to?" If the
 * recovered bytes fail it, the plan refuses `BACKUP_OLD_RESTORE_DOCTOR_REFUSED` and nothing is written: a copy
 * that decrypts to a statically invalid log is a **recovery artifact for a human to inspect**, not something to
 * silently drop into `sessions/`. The explicit `forceInvalid` / `--force-invalid` flag is that human decision: the
 * bytes are then written, and the result carries `doctor_ok: false` so no later reader can mistake it for a
 * validated restore.
 *
 * ## Which format the copy is (`docs/BACKUP-DESIGN.md` §28)
 *
 * A copy is read by **the file's own magic**, never by `full_copy.format` on the record: a record field is a
 * claim, and the eight bytes at the head of the file are the fact (`verify.mjs` takes the same position). Two
 * formats exist:
 *
 *   * **v1** -- one sealed `crypto.openObject` under the `old` identity. The path is exactly what it was before
 *     the chunked format existed: read the file whole, decrypt in one call, verify digest/length.
 *   * **v2** (`chunked.mjs`) -- magic `W2MOLD2`, a plaintext header, then one AEAD record per chunk. The reader
 *     authenticates one record at a time and holds one chunk (default 4 MiB, 16 MiB ceiling), never the whole
 *     sealed file. Every record's AAD names the header's `sha256`/`size` and its index, so a copy retargeted at
 *     another version, a truncated file, and a reordered or duplicated record are all refused by name
 *     (`BACKUP_CHUNKED_*`), not averaged into one "authentication failed".
 *
 * Both formats refuse through the same command code: a copy that does not open as the recorded version is
 * `BACKUP_OLD_RESTORE_CORRUPT`, and the detail carries the underlying `BACKUP_CHUNKED_*` (or
 * `BACKUP_DECRYPT_*`) code so the cause survives into the operator's terminal and the `--json` payload.
 *
 * ## v2 restore streams; v1 is unchanged
 *
 * For a v2 copy the plan does not keep the recovered log: it streams the copy into the plan's own verification
 * (peak one chunk, reported as `peakChunkBytes`) and keeps a re-open closure, so `applyOldRestore` writes the
 * copy back **record by record** into a temporary sibling of the target, `fsync`s, and renames it into place --
 * the target name never holds a partially written log. The plan's `streamed` flag and `peakChunkBytes` say which
 * shape it will use; the v1 path keeps the whole recovered buffer on the plan (non-enumerable, as before) and
 * writes it with `writeFileAtomic`.
 *
 * The static doctor is the one step that still wants the whole log in memory (`diagnoseSessionBuffer` parses it),
 * and that is true for both formats: it is the recovered file's own size, so a v2 restore's *copy* reader is
 * bounded by a chunk while the doctor's materialisation is not something the container can remove. §28 states
 * that boundary rather than claiming a peak the doctor does not have.
 *
 * ## Plan and apply
 *
 * `planOldRestore` opens the record, opens the repository key (machine -> account -> password; an unencrypted
 * repository's `open` envelope works with no credential), reads and decrypts the `.enc` with the `old` identity
 * (`{sha256, length: size, kind: 'old'}` for v1; the chunked header/AAD for v2), verifies both the digest and the
 * length, runs the static doctor, and decides the target. It writes nothing to the target: the only side effect
 * is `openRepoKey`'s documented best-effort machine-envelope upgrade, which belongs to key handling, not to this
 * command. For a v1 copy the recovered plaintext travels on the plan as a **non-enumerable** `plaintext` Buffer,
 * so `JSON.stringify(plan)` stays a small report while `applyOldRestore` writes exactly the bytes the plan
 * verified. For a v2 copy no plaintext travels: the plan carries a non-enumerable `streamCopy(sink)` closure that
 * re-opens the copy (and re-verifies it, so a copy that changed after the plan is refused, not written).
 *
 * `applyOldRestore` re-checks the target against what the plan saw: a target that changed in between is refused
 * (`BACKUP_OLD_RESTORE_TARGET_CHANGED`) instead of overwritten, an existing target still needs
 * `overwrite`/`keepBoth` (`BACKUP_OLD_RESTORE_TARGET_EXISTS`), an overwrite first writes a byte-for-byte
 * `.bak-<ts>` copy, `keepBoth` leaves the existing file alone and writes `<target>.restored-<ts>` instead, and
 * the result is read back and hashed. A failed read-back is reported, never hidden. Those checks and their order
 * are identical for both formats; only the final write differs (a v2 copy is streamed into a temporary sibling
 * and renamed, so its digest is read back through a bounded buffer instead of `readFileSync`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { atomicWriteFailure, readJsonSafe, writeFileAtomic } from './atomic.mjs';
import { CHUNKED_FORMAT, ChunkedError, isChunkedV2, openChunkedStream } from './chunked.mjs';
import { OLD_COPY_KIND, isDek, openObject } from './crypto.mjs';
import { LAYOUT_CODES, readDescriptor, validateDescriptor } from './layout.mjs';
import { NO_PERMISSION, openRepoKey } from './keystore.mjs';
import { REPO_CODES } from './repo.mjs';
import { OLD_FORMAT, fullCopyPathFor, listOldVersions } from './rotation.mjs';
import { diagnoseSessionBuffer } from '../util/session-validate.mjs';

/** Named failures this command adds. Key/repository failures reuse the codes every other command reports. */
export const OLD_RESTORE_CODES = Object.freeze({
  /** No version record matches the request (or it matches several and an explicit one is required). */
  NOT_FOUND: 'BACKUP_OLD_RESTORE_NOT_FOUND',
  /** The record exists but carries no `full_copy`: there is nothing to restore from. */
  NO_FULL_COPY: 'BACKUP_OLD_RESTORE_NO_FULL_COPY',
  /** The copy is absent/unreadable, or it decrypts to bytes that do not match the record's digest/size. */
  CORRUPT: 'BACKUP_OLD_RESTORE_CORRUPT',
  /** The target exists and neither `overwrite` nor `keepBoth` was requested. */
  TARGET_EXISTS: 'BACKUP_OLD_RESTORE_TARGET_EXISTS',
  /** The target changed after the plan was made (a live client is appending to it, or someone edited it). */
  TARGET_CHANGED: 'BACKUP_OLD_RESTORE_TARGET_CHANGED',
  /** The recovered log fails the static doctor and `forceInvalid` was not requested. */
  DOCTOR_REFUSED: 'BACKUP_OLD_RESTORE_DOCTOR_REFUSED',
});

/** The frozen digest shape a version record carries. */
const SHA256_RE = /^[0-9a-f]{64}$/u;

/** `20261117T140000Z`: the compact timestamp the repository's `.bak-<ts>` convention uses. */
function compactStamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');
}

/** A repository-relative, forward-slash path (the form a record's `full_copy.file` stores). */
function relFromRoot(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

/** The sha256 of a buffer as lowercase hex. */
function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** True when `child` is strictly below `parent` (decided with `path.relative`, never a string prefix). */
function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The sha256 of a regular file, or `null` when it is absent/unreadable/not a regular file. */
function fileDigest(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** Read a regular file, or `null` when it is absent/unreadable/not a regular file. */
function readRegularFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** The plan label of a v1 copy; a v2 copy is labelled with `CHUNKED_FORMAT` (`chunked-v2`). */
const V1_COPY_FORMAT = 'v1';

/** Byte limit of the bounded read-back after a streamed write: one buffer, never the whole restored log. */
const READBACK_CHUNK_BYTES = 1024 * 1024;

/** The non-enumerable plan property carrying a v2 copy's re-open closure (see {@link planOldRestore}). */
const STREAM_COPY = 'streamCopy';

/** The bounded digest read-back a streamed write uses: `{bytes, sha256}`, or `null` when unreadable. */
function hashFileBounded(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    fd = fs.openSync(file, 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READBACK_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    return { bytes, sha256: hash.digest('hex') };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the read verdict is already decided */
      }
    }
  }
}

/**
 * Read and verify one sealed `old/` full copy, deciding the format by the file's own magic.
 *
 * v1 is the historical path, unchanged: the whole sealed object is read, opened with the `old` identity, and the
 * plaintext digest/length are compared with the record's. v2 is opened as a chunk stream: every record is
 * authenticated against the header's `sha256`/`size` and its own index, the plaintext is assembled at the offsets
 * the reader reports (peak: the log + one chunk, and the caller releases it after the doctor), and the reader's
 * report carries the peak chunk size the plan reports. `sha256`/`size` are passed as the *expected* identity, so a
 * copy that belongs to another version is refused with a header mismatch naming both identities.
 *
 * @param {{copyFile: string, dek: Buffer, record: object}} input
 * @returns {{ok: true, format: string, streamed: boolean, plaintext: Buffer, peakChunkBytes: number|null,
 *   chunks: number|null, chunkBytes: number|null} | {ok: false, detail: string}}
 */
function readFullCopy(input) {
  const { copyFile, dek, record } = input;
  if (!isChunkedV2(copyFile)) {
    const sealed = readRegularFile(copyFile);
    if (sealed === null) {
      return { ok: false, detail: `the sealed full copy at ${copyFile} is missing or not a regular file` };
    }
    let plaintext;
    try {
      plaintext = openObject(sealed, dek, { sha256: record.sha256, length: record.size, kind: OLD_COPY_KIND });
    } catch (error) {
      return {
        ok: false,
        detail:
          `the sealed full copy at ${copyFile} does not open as the recorded version: ` +
          `${error?.code ?? 'BACKUP_DECRYPT_AUTH_FAILED'}: ${error?.detail ?? error?.message ?? String(error)}`,
      };
    }
    const digest = sha256Hex(plaintext);
    if (plaintext.length !== record.size || digest !== record.sha256) {
      return {
        ok: false,
        detail: `the full copy at ${copyFile} decrypts to ${plaintext.length} bytes / ${digest}, not the recorded ${record.size} bytes / ${record.sha256}`,
      };
    }
    return {
      ok: true,
      format: V1_COPY_FORMAT,
      streamed: false,
      plaintext,
      peakChunkBytes: null,
      chunks: null,
      chunkBytes: null,
    };
  }

  // v2: the file must at least be able to hold the plaintext it claims before a buffer of that size is asked for.
  let fileBytes;
  try {
    fileBytes = fs.statSync(copyFile).size;
  } catch (error) {
    return { ok: false, detail: `the ${CHUNKED_FORMAT} full copy at ${copyFile} is unreadable: ${error?.code ?? 'stat failed'}` };
  }
  if (fileBytes < record.size) {
    return {
      ok: false,
      detail:
        `the ${CHUNKED_FORMAT} full copy at ${copyFile} is ${fileBytes} bytes, smaller than the ${record.size} ` +
        'recorded plaintext bytes: it is truncated',
    };
  }
  // One preallocated plaintext buffer (the doctor needs the whole log anyway) filled from the reader's offsets:
  // no part of the sealed file is ever held as one buffer, and no second copy of the plaintext is made.
  const plaintext = Buffer.allocUnsafe(record.size);
  let opened;
  try {
    opened = openChunkedStream(copyFile, {
      dek,
      sha256: record.sha256,
      size: record.size,
      onChunk: (chunk) => {
        chunk.plaintext.copy(plaintext, chunk.offset);
      },
    });
  } catch (error) {
    return {
      ok: false,
      detail:
        `the ${CHUNKED_FORMAT} full copy at ${copyFile} does not open as the recorded version: ` +
        `${error?.code ?? 'BACKUP_CHUNKED_AUTH_FAILED'}: ${error?.detail ?? error?.message ?? String(error)}`,
    };
  }
  const digest = sha256Hex(plaintext);
  if (opened.size !== record.size || digest !== record.sha256) {
    return {
      ok: false,
      detail:
        `the ${CHUNKED_FORMAT} full copy at ${copyFile} decrypts to ${opened.size} bytes / ${digest}, ` +
        `not the recorded ${record.size} bytes / ${record.sha256}`,
    };
  }
  return {
    ok: true,
    format: CHUNKED_FORMAT,
    streamed: true,
    plaintext,
    peakChunkBytes: opened.peakChunkBytes,
    chunks: opened.chunks,
    chunkBytes: opened.chunkBytes,
  };
}

/**
 * Write a streamed restore into a temporary sibling of `target`, then rename it into place.
 *
 * The temporary file lives in the target's own directory (so the rename never crosses a filesystem) and its name
 * never holds a partial log: `fsync` then `rename` are the same durability order `atomic.writeFileAtomic` uses.
 * `streamCopy(write)` re-opens the sealed copy through the plan's closure, so the identity recorded at plan time
 * is verified again here -- a copy that changed in between refuses instead of writing different bytes.
 *
 * A process killed mid-write leaves a partial `.restore-tmp-*` file in the target's directory: it is plaintext,
 * it is not a target and no record refers to it, and nothing sweeps the target's directory for it (gc only walks
 * `objects/` and `tmp/`). §28 states that; the honest handling is the operator deleting it, not this function
 * guessing which files in a caller-chosen directory are its own.
 *
 * @param {{streamCopy: (write: (buffer: Buffer) => void) => object, target: string}} input
 * @returns {object} the reader's report
 * @throws {ChunkedError} when the copy no longer opens (a changed or damaged copy)
 * @throws {AtomicWriteError} `BACKUP_DISK_FULL` / `BACKUP_DIR_NOT_WRITABLE` / `BACKUP_WRITE_FAILED`
 */
function writeStreamedCopy(input) {
  const target = path.resolve(input.target);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.restore-tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'wx', 0o600);
    const opened = input.streamCopy((buffer) => {
      fs.writeSync(fd, buffer, 0, buffer.length);
    });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
    return opened;
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the failure being reported is the write */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort: a leaked temp file is a directory entry, not a wrong byte */
    }
    throw error instanceof ChunkedError ? error : atomicWriteFailure(error, target);
  }
}

/** A lookup/target failure in the house result shape (so every caller can read the same fields). */
function refusal(code, detail) {
  return {
    ok: false,
    reason_code: code,
    detail,
    record: null,
    copy_file: null,
    source_sha256: null,
    copy_format: null,
    streamed: false,
    peakChunkBytes: null,
    recovered: { bytes: 0, sha256: null, doctor_ok: false, doctor_codes: [] },
    target: null,
    apply_plan: null,
    overwrite: false,
    keep_both: false,
    force_invalid: false,
  };
}

/** The compact, JSON-safe record summary a plan reports (the full record is not needed to read the plan). */
function recordSummary(file, record) {
  return {
    file,
    session_id: record.session_id ?? null,
    rel: record.rel ?? null,
    workspace: record.workspace ?? null,
    sha256: record.sha256,
    size: record.size,
    recorded_at: record.recorded_at ?? null,
    snapshot_id: record.snapshot_id ?? null,
    full_copy: {
      file: record.full_copy.file,
      sha256: record.full_copy.sha256,
      size: record.full_copy.size,
      // The record's claim (`chunked-v2`, or absent for a v1 copy); the plan's `copy_format` is what the magic
      // bytes said, and `streamed`/`peakChunkBytes` report the reader that will actually run.
      format: record.full_copy.format ?? V1_COPY_FORMAT,
    },
  };
}

/**
 * Find the one version record a request names.
 *
 * `recordFile` is exact; `latestFor` picks the newest match; `sessionId`/`rel` alone must resolve to exactly one
 * record -- several versions of one session is the normal state, so "the version of session X" is ambiguous by
 * construction and is refused by name rather than guessed (the caller passes `--record` or `--latest-for`).
 *
 * @param {{root: string, recordFile: string|null, sessionId: string|null, rel: string|null,
 *   latestFor: string|null}} input
 * @returns {{ok: true, file: string, record: object} | {ok: false, code: string, detail: string}}
 */
function selectRecord(input) {
  const root = path.resolve(input.root);
  if (input.recordFile !== null) {
    const file = path.resolve(input.recordFile);
    if (!isInside(path.join(root, 'old'), file)) {
      return {
        ok: false,
        code: OLD_RESTORE_CODES.NOT_FOUND,
        detail: `${file} is not inside ${path.join(root, 'old')}; only a version record under old/ can be restored`,
      };
    }
    const record = readJsonSafe(file);
    if (record === null || record.format !== OLD_FORMAT) {
      return { ok: false, code: OLD_RESTORE_CODES.NOT_FOUND, detail: `${file} is not a readable version record` };
    }
    return { ok: true, file, record };
  }

  const wantedSession = input.latestFor ?? input.sessionId;
  const rows = listOldVersions(root).filter((row) => {
    if (wantedSession !== null && row.record.session_id !== wantedSession) return false;
    if (input.rel !== null && row.record.rel !== input.rel) return false;
    return true;
  });
  if (rows.length === 0) {
    const what = wantedSession === null ? 'the requested rel' : `session ${wantedSession}`;
    return { ok: false, code: OLD_RESTORE_CODES.NOT_FOUND, detail: `no old/ version record matches ${what}` };
  }
  if (rows.length > 1 && input.latestFor === null) {
    return {
      ok: false,
      code: OLD_RESTORE_CODES.NOT_FOUND,
      detail:
        `${rows.length} old/ version records match the request (${rows.length} versions of one session is normal); ` +
        'pass --record <path> or --latest-for <session-id> to choose one',
    };
  }
  const chosen = rows[0];
  return { ok: true, file: chosen.file, record: chosen.record };
}

/**
 * Decide the target path and whether writing it is allowed.
 *
 * `target.path` is the path the caller asked about (the one guarded against concurrent change);
 * `target.write_path` is where apply actually writes (`keepBoth` + an existing target resolves to a
 * `.restored-<ts>` sibling, the same spelling `restore.mjs` uses).
 *
 * @param {{recordFile: string, outFile: string|null, overwrite: boolean, keepBoth: boolean, now: Date,
 *   bytes: number, sha256: string}} input
 * @returns {{ok: true, target: object, apply_plan: object} | {ok: false, code: string, detail: string}}
 */
function resolveTarget(input) {
  const targetPath = input.outFile === null ? `${input.recordFile}.restored` : path.resolve(input.outFile);
  let exists = false;
  let existingSha = null;
  try {
    const stat = fs.statSync(targetPath);
    exists = true;
    if (stat.isFile()) existingSha = fileDigest(targetPath);
  } catch {
    exists = false;
  }
  const stamp = compactStamp(input.now);
  const writePath = exists && input.keepBoth === true ? `${targetPath}.restored-${stamp}` : targetPath;
  const mode = !exists ? 'create' : input.keepBoth === true ? 'keep-both' : 'overwrite';
  if (exists && input.overwrite !== true && input.keepBoth !== true) {
    return {
      ok: false,
      code: OLD_RESTORE_CODES.TARGET_EXISTS,
      detail:
        `${targetPath} already exists; pass --overwrite (a .bak-<ts> copy is written first) ` +
        'or --keep-both (write the restored log beside it)',
    };
  }
  return {
    ok: true,
    target: { path: targetPath, exists, existing_sha256: existingSha, write_path: writePath },
    apply_plan: {
      mode,
      target: writePath,
      backs_up_existing: exists && input.keepBoth !== true,
      bytes: input.bytes,
      sha256: input.sha256,
    },
  };
}

/**
 * Plan one restore from a sealed whole-file copy.
 *
 * Pure with respect to the caller's files: no target is written, no `.bak` is made, no directory is created. The
 * repository key IS opened (the copy must be decrypted to be verified), which is the one operation with a possible
 * side effect -- `openRepoKey`'s documented best-effort machine-envelope upgrade; an unencrypted repository opens
 * with no credential and no write at all.
 *
 * @param {{root: string, dshHome: string, recordFile?: string|null, sessionId?: string|null, rel?: string|null,
 *   latestFor?: string|null, outFile?: string|null, overwrite?: boolean, keepBoth?: boolean,
 *   forceInvalid?: boolean, password?: string|Buffer|null, accountId?: string|null, machineKey?: boolean,
 *   platform?: string, runner?: Function, now?: Date}} input
 * @returns {object} a plan; `ok:false` carries `reason_code`/`detail`. The verified plaintext is a
 *   non-enumerable `plaintext` Buffer on the plan.
 */
export function planOldRestore(input) {
  if (typeof input?.root !== 'string' || input.root.trim() === '') {
    return refusal(LAYOUT_CODES.UNRESOLVED, 'planOldRestore needs a repository root path');
  }
  if (typeof input?.dshHome !== 'string' || input.dshHome.trim() === '') {
    return refusal(LAYOUT_CODES.UNRESOLVED, 'planOldRestore needs a DSH home path to open the repository key');
  }
  const root = path.resolve(input.root);
  const now = input.now instanceof Date ? input.now : new Date();
  const overwrite = input.overwrite === true;
  const keepBoth = input.keepBoth === true;
  const forceInvalid = input.forceInvalid === true;

  // Validate the repository before opening any key: a restore command pointed at the wrong directory must not
  // mint `keys.json` there.
  let descriptor;
  try {
    descriptor = readDescriptor(root);
  } catch (error) {
    return refusal(error?.code ?? LAYOUT_CODES.DESCRIPTOR_UNREADABLE, error?.detail ?? String(error?.message ?? error));
  }
  if (descriptor === null) {
    return refusal(REPO_CODES.NOT_INITIALIZED, `${root} has no backup.json; point --backup-dir at the backup repository`);
  }
  const validated = validateDescriptor(descriptor);
  if (validated.ok !== true) return refusal(validated.error.code, validated.error.detail);
  // `openRepoKey` creates a key document on first use. That is right for `run`, and wrong here: a repository
  // whose keys.json is missing cannot decrypt anything, and minting a fresh key would only produce a misleading
  // "corrupt copy" instead of "this repository has no key".
  if (!fs.existsSync(path.join(root, 'keys.json'))) {
    return refusal(NO_PERMISSION, `${root} has no keys.json; nothing can decrypt the sealed full copy`);
  }

  const selected = selectRecord({
    root,
    recordFile: typeof input.recordFile === 'string' && input.recordFile.trim() !== '' ? input.recordFile : null,
    sessionId: typeof input.sessionId === 'string' && input.sessionId.trim() !== '' ? input.sessionId : null,
    rel: typeof input.rel === 'string' && input.rel.trim() !== '' ? input.rel : null,
    latestFor: typeof input.latestFor === 'string' && input.latestFor.trim() !== '' ? input.latestFor : null,
  });
  if (selected.ok !== true) return refusal(selected.code, selected.detail);
  const recordFile = selected.file;
  const record = selected.record;
  if (record.full_copy === undefined || record.full_copy === null) {
    return refusal(
      OLD_RESTORE_CODES.NO_FULL_COPY,
      `${recordFile} has no full_copy; restore from its blocks with w2m-backup restore, or add a copy first ` +
        'with `w2m-backup old-backfill`',
    );
  }
  const copyFile = fullCopyPathFor(root, record);
  if (copyFile === null) {
    return refusal(OLD_RESTORE_CODES.CORRUPT, `${recordFile} names a full_copy outside old/, so it is never followed`);
  }
  if (
    typeof record.sha256 !== 'string' ||
    !SHA256_RE.test(record.sha256) ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0
  ) {
    return refusal(OLD_RESTORE_CODES.CORRUPT, `${recordFile} does not carry a usable sha256/size`);
  }
  if (record.full_copy.sha256 !== record.sha256 || record.full_copy.size !== record.size) {
    return refusal(
      OLD_RESTORE_CODES.CORRUPT,
      `${recordFile}: full_copy metadata (${record.full_copy.sha256} / ${record.full_copy.size}) disagrees with the ` +
        `version's own identity (${record.sha256} / ${record.size})`,
    );
  }
  // Presence is checked before the key is opened (a missing copy is the common failure and must not depend on a
  // credential); the format is decided by the file's own magic inside `readFullCopy`, never by the record field.
  let copyStat;
  try {
    copyStat = fs.statSync(copyFile);
  } catch {
    copyStat = null;
  }
  if (copyStat === null || !copyStat.isFile()) {
    return refusal(OLD_RESTORE_CODES.CORRUPT, `${recordFile} claims a full copy at ${copyFile}, but it is missing or not a regular file`);
  }

  const key = openRepoKey({
    root,
    dshHome: input.dshHome,
    accountId: input.accountId ?? null,
    password: input.password ?? null,
    machineKey: input.machineKey,
    platform: input.platform,
    runner: input.runner,
  });
  if (key.ok !== true) return refusal(NO_PERMISSION, `${key.reason_code}: ${key.detail}`);
  if (!isDek(key.dek)) return refusal(NO_PERMISSION, 'the repository key opened without a usable DEK');

  const recovered = readFullCopy({ copyFile, dek: key.dek, record });
  if (recovered.ok !== true) {
    return refusal(OLD_RESTORE_CODES.CORRUPT, `${recordFile}: ${recovered.detail}`);
  }
  const plaintext = recovered.plaintext;
  const recoveredSha = sha256Hex(plaintext);

  const doctor = diagnoseSessionBuffer(plaintext, { expectedSessionId: record.session_id ?? null });
  const doctorOk = doctor.ok === true;
  const doctorCodes = Array.isArray(doctor.codes) ? doctor.codes : [];
  if (doctorOk !== true && forceInvalid !== true) {
    // The refusal still carries the recovery facts (record, digest, doctor codes): an operator deciding whether
    // `--force-invalid` is the right next step needs to see *why* the log failed, not only that it did.
    const refused = refusal(
      OLD_RESTORE_CODES.DOCTOR_REFUSED,
      `${recordFile}: the recovered log fails the static doctor (${doctorCodes.join(', ') || 'no code'}); ` +
        'pass --force-invalid to write these bytes anyway (they are for inspection, not for sessions/)',
    );
    refused.record = recordSummary(recordFile, record);
    refused.copy_file = copyFile;
    refused.source_sha256 = record.sha256;
    refused.recovered = {
      bytes: plaintext.length,
      sha256: recoveredSha,
      doctor_ok: false,
      doctor_codes: doctorCodes,
    };
    return refused;
  }

  const target = resolveTarget({
    recordFile,
    outFile: typeof input.outFile === 'string' && input.outFile.trim() !== '' ? input.outFile : null,
    overwrite,
    keepBoth,
    now,
    bytes: plaintext.length,
    sha256: recoveredSha,
  });
  if (target.ok !== true) return refusal(target.code, target.detail);

  const plan = {
    ok: true,
    reason_code: null,
    detail: null,
    record: recordSummary(recordFile, record),
    copy_file: copyFile,
    source_sha256: record.sha256,
    // Additive format facts (the existing plan keys are unchanged): which container the copy actually is, whether
    // the reader streams it, and the largest record it held. A v1 copy reports the whole file, so its peak is
    // reported as null rather than pretending the chunked bound applies.
    copy_format: recovered.format,
    streamed: recovered.streamed,
    peakChunkBytes: recovered.peakChunkBytes,
    recovered: {
      bytes: plaintext.length,
      sha256: recoveredSha,
      doctor_ok: doctorOk,
      doctor_codes: doctorCodes,
    },
    target: target.target,
    apply_plan: target.apply_plan,
    overwrite,
    keep_both: keepBoth,
    force_invalid: forceInvalid,
  };
  // A v1 plan carries the verified bytes (non-enumerable: `--json` prints a small report, apply writes exactly
  // these bytes). A v2 plan carries a re-open closure instead -- the log is not kept in memory after the doctor,
  // and apply streams it out record by record, re-verifying the identity on the way (a copy that changed after
  // the plan is refused, not written). Neither property is enumerable, so `JSON.stringify(plan)` stays a report.
  if (recovered.streamed) {
    Object.defineProperty(plan, STREAM_COPY, {
      value: (write) =>
        openChunkedStream(copyFile, {
          dek: key.dek,
          sha256: record.sha256,
          size: record.size,
          onChunk: (chunk) => write(chunk.plaintext),
        }),
      enumerable: false,
      writable: false,
    });
  } else {
    Object.defineProperty(plan, 'plaintext', { value: plaintext, enumerable: false, writable: false });
  }
  Object.defineProperty(plan, 'record_file', { value: recordFile, enumerable: false, writable: false });
  Object.defineProperty(plan, 'source_file', { value: copyFile, enumerable: false, writable: false });
  Object.defineProperty(plan, 'copy_rel', {
    value: relFromRoot(root, copyFile),
    enumerable: false,
    writable: false,
  });
  return plan;
}

/** A failed apply result in the house shape. */
function applyFailure(code, detail) {
  return {
    ok: false,
    reason_code: code,
    detail,
    file: null,
    backup_file: null,
    bytes: 0,
    sha256: null,
    doctor_ok: null,
    dry_run: false,
  };
}

/**
 * Write the bytes a plan verified.
 *
 * Order: re-check the target -> (overwrite) copy the existing bytes to `.bak-<ts>` -> write -> read back and
 * compare the digest. The read-back is the last line of defence against a disk or filesystem that lied; it never
 * replaces the check of what the plan saw.
 *
 * The write differs by the format the plan reported, and only there: a v1 plan carries the verified bytes and
 * writes them with `atomic.writeFileAtomic`; a v2 plan carries a re-open closure and streams the copy into a
 * temporary sibling of the target, `fsync`s and renames it (see {@link writeStreamedCopy}), then reads the digest
 * back through a bounded buffer. The `.bak`, the target-changed check and their order are the same for both.
 *
 * @param {{plan: object, now?: Date}} input
 * @returns {{ok: boolean, reason_code: string|null, detail: string|null, file: string|null,
 *   backup_file: string|null, bytes: number, sha256: string|null, doctor_ok: boolean|null, dry_run: boolean}}
 */
export function applyOldRestore(input) {
  const plan = input?.plan;
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    return applyFailure(
      plan?.reason_code ?? OLD_RESTORE_CODES.NOT_FOUND,
      plan?.detail ?? 'applyOldRestore needs a successful plan from planOldRestore',
    );
  }
  const streamed = plan.streamed === true;
  const plaintext = plan.plaintext;
  const streamCopy = plan[STREAM_COPY];
  if (streamed) {
    if (typeof streamCopy !== 'function') {
      return applyFailure(
        OLD_RESTORE_CODES.CORRUPT,
        'the plan does not carry the streaming reader for its chunked full copy; make a new plan with planOldRestore',
      );
    }
  } else if (!Buffer.isBuffer(plaintext)) {
    return applyFailure(
      OLD_RESTORE_CODES.CORRUPT,
      'the plan does not carry the recovered bytes; make a new plan with planOldRestore',
    );
  }
  const targetPath = plan.target?.path;
  const writePath = plan.target?.write_path;
  if (typeof targetPath !== 'string' || typeof writePath !== 'string') {
    return applyFailure(OLD_RESTORE_CODES.CORRUPT, 'the plan does not name a target path');
  }
  const now = input.now instanceof Date ? input.now : new Date();
  const expectedSha = plan.recovered?.sha256 ?? null;
  const expectedBytes = streamed ? plan.recovered?.bytes : plaintext.length;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    return applyFailure(OLD_RESTORE_CODES.CORRUPT, 'the plan does not carry the recovered length; make a new plan');
  }

  // Read the target once, reusing those bytes for both the "did it change?" check and the `.bak` copy: reading it
  // twice would let a concurrent writer make the backup differ from the file the check approved.
  let existing = null;
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) existing = fs.readFileSync(targetPath);
  } catch {
    existing = null;
  }
  const currentSha = existing === null ? null : sha256Hex(existing);
  if (currentSha !== (plan.target.existing_sha256 ?? null)) {
    return applyFailure(
      OLD_RESTORE_CODES.TARGET_CHANGED,
      `${targetPath} changed after the plan was made; re-plan to see the new state (nothing was written)`,
    );
  }
  if (existing !== null && plan.overwrite !== true && plan.keep_both !== true) {
    return applyFailure(
      OLD_RESTORE_CODES.TARGET_EXISTS,
      `${targetPath} exists and the plan did not request --overwrite or --keep-both (nothing was written)`,
    );
  }
  if (plan.recovered?.doctor_ok !== true && plan.force_invalid !== true) {
    return applyFailure(
      OLD_RESTORE_CODES.DOCTOR_REFUSED,
      'the recovered log fails the static doctor and the plan did not request --force-invalid (nothing was written)',
    );
  }

  let backupFile = null;
  try {
    if (existing !== null && plan.keep_both !== true) {
      backupFile = `${targetPath}.bak-${compactStamp(now)}`;
      writeFileAtomic(backupFile, existing);
    }
    if (streamed) {
      // The stream re-verifies the copy's identity before any byte lands under the target name; the read-back below
      // then checks the file that was renamed into place, exactly as it does for a v1 write.
      writeStreamedCopy({ streamCopy, target: writePath });
    } else {
      writeFileAtomic(writePath, plaintext);
    }
  } catch (error) {
    if (error instanceof ChunkedError) {
      return applyFailure(
        OLD_RESTORE_CODES.CORRUPT,
        `${writePath}: the ${CHUNKED_FORMAT} full copy no longer opens as the recorded version ` +
          `(it changed or was damaged after the plan): ${error.code}: ${error.detail}`,
      );
    }
    return applyFailure(
      error?.code ?? OLD_RESTORE_CODES.CORRUPT,
      `${writePath}: ${error?.detail ?? error?.message ?? String(error)}`,
    );
  }

  // v1's read-back is exactly the old one (the whole buffer, hashed); a streamed write hashes the file through a
  // bounded buffer instead of re-materialising a log that may be hundreds of megabytes.
  let readBackBytes = null;
  let readBackSha = null;
  if (streamed) {
    const hashed = hashFileBounded(writePath);
    readBackBytes = hashed === null ? null : hashed.bytes;
    readBackSha = hashed === null ? null : hashed.sha256;
  } else {
    const readBack = readRegularFile(writePath);
    readBackBytes = readBack === null ? null : readBack.length;
    readBackSha = readBack === null ? null : sha256Hex(readBack);
  }
  if (readBackBytes === null || readBackBytes !== expectedBytes || readBackSha !== expectedSha) {
    return {
      ok: false,
      reason_code: OLD_RESTORE_CODES.CORRUPT,
      detail:
        `${writePath} was written but reads back as ${readBackBytes === null ? 'missing' : `${readBackBytes} bytes / ${readBackSha}`}, ` +
        `not the recovered ${expectedBytes} bytes / ${expectedSha}`,
      file: writePath,
      backup_file: backupFile,
      bytes: 0,
      sha256: readBackSha,
      doctor_ok: plan.recovered?.doctor_ok === true,
      dry_run: false,
    };
  }
  return {
    ok: true,
    reason_code: null,
    detail: null,
    file: writePath,
    backup_file: backupFile,
    bytes: expectedBytes,
    sha256: readBackSha,
    doctor_ok: plan.recovered?.doctor_ok === true,
    dry_run: false,
  };
}
