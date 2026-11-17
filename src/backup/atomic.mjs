/**
 * Durable file writes: write to a temporary sibling, flush it, then rename over the target.
 *
 * ## Why a rename and not a plain write
 *
 * A backup repository is content-addressed: an object file's *name* is the hash of its plaintext, so a
 * half-written object is not "a file with a short read" -- it is a file whose name promises content it does not
 * have. The next backup would then legitimately conclude the block is already stored (the name exists) and never
 * repair it. `writeFileAtomic` makes the name appear only after the bytes are durable: `write` -> `fsync` ->
 * `rename` (which is atomic within a filesystem).
 *
 * ## What it does not promise
 *
 * No directory fsync (the rename itself is durable on NTFS/ext4 for the common case, and a directory fsync is not
 * expressible portably through Node). No cross-device rename: the temporary file is created in the target's own
 * directory, so a rename never crosses a mount.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Named failure codes. */
export const ATOMIC_CODES = Object.freeze({
  WRITE_FAILED: 'BACKUP_WRITE_FAILED',
  DISK_FULL: 'BACKUP_DISK_FULL',
  NOT_WRITABLE: 'BACKUP_DIR_NOT_WRITABLE',
});

/** A durable-write failure with a stable code. */
export class AtomicWriteError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'AtomicWriteError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

/** Map a filesystem failure to the code an operator can act on. */
function writeFailure(error, file) {
  const code = error?.code;
  if (code === 'ENOSPC') return new AtomicWriteError(ATOMIC_CODES.DISK_FULL, `${file}: the volume is full (ENOSPC)`);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new AtomicWriteError(ATOMIC_CODES.NOT_WRITABLE, `${file}: ${code}`);
  }
  return new AtomicWriteError(ATOMIC_CODES.WRITE_FAILED, `${file}: ${code ?? (error instanceof Error ? error.message : String(error))}`);
}

/**
 * Write `data` to `file` atomically.
 *
 * @param {string} file
 * @param {Buffer|string} data
 * @returns {{file: string, bytes: number, tmp: string}}
 */
export function writeFileAtomic(file, data) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
    return { file: target, bytes: buffer.length, tmp };
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
      /* best effort: a leaked temp file is reported by gc, not hidden */
    }
    throw writeFailure(error, target);
  }
}

/** Write JSON atomically, with a trailing newline (a diff-friendly file, and a complete one). */
export function writeJsonAtomic(file, value) {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read JSON, returning `null` instead of throwing for a missing or unparsable file.
 *
 * The repository state files are read on status paths: an unreadable pointer must report as "absent", not take
 * the whole panel down.
 *
 * @param {string} file
 * @returns {object|null}
 */
export function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
