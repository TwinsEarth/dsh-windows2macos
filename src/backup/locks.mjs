/**
 * A repository lock: one writer at a time, and a stale lock that cannot wedge backups forever.
 *
 * ## The failure this prevents
 *
 * Two writers into one content-addressed store are not merely wasteful. The rotation step reads `current/`,
 * decides the previous version is superseded, writes an `old/` record and replaces `current/`; two runs doing
 * that at once can lose one of the versions, and the object store can be left with a block nobody references.
 * A lock is cheaper than reasoning about concurrent writers.
 *
 * ## Why `wx` and not a pid file that is checked first
 *
 * "Check then create" is a race with a window. `open(..., 'wx')` is the atomic primitive the OS provides: the
 * file either did not exist and is now ours, or it existed and we are refused. Stale detection happens **after**
 * the refusal, and it deletes the old file and retries exactly once -- so a legitimate concurrent writer is
 * refused, while a crashed writer is reclaimed.
 *
 * ## What "stale" means
 *
 * Three signals, in order: the file is unreadable (a crash during write), the pid is not alive, or the lock is
 * older than `staleMs`. The pid check is the strongest on the same machine; the age bound covers pid reuse and a
 * clock that jumped. Release is idempotent and only deletes the file if it still names our pid -- a second
 * `release()` after a stale reclaim must not delete the new owner's lock.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repoPaths } from './layout.mjs';

/** Lock file name inside the repository's `tmp/`. */
export const LOCK_FILE = 'backup.lock';

/** Default age after which a lock whose pid cannot be checked is considered abandoned. */
export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

/** Named lock failure codes. */
export const LOCK_CODES = Object.freeze({
  LOCKED: 'BACKUP_LOCKED',
  WRITE_FAILED: 'BACKUP_LOCK_WRITE_FAILED',
  RELEASE_FAILED: 'BACKUP_LOCK_RELEASE_FAILED',
});

/** A lock failure with a stable code. */
export class BackupLockError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'BackupLockError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }

  toRefusal() {
    return { ok: false, reason_code: this.code, detail: this.detail };
  }
}

/** True when a pid names a live process on this machine. */
export function isPidAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else: alive for our purposes.
    return error?.code === 'EPERM';
  }
}

/** Resolve the lock file path for a repository root. */
export function lockPath(root) {
  return path.join(repoPaths(root).tmp, LOCK_FILE);
}

/** Read and parse a lock file; `null` when it cannot be used. */
function readLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock may be reclaimed.
 *
 * @param {{pid?: number, started_at?: string}|null} holder
 * @param {{nowMs: number, staleMs: number, hostname: string, isAlive?: typeof isPidAlive}} options
 * @returns {{stale: boolean, reason: string}}
 */
export function isStaleLock(holder, options) {
  if (holder === null) return { stale: true, reason: 'unreadable lock file' };
  const startedMs = typeof holder.started_at === 'string' ? Date.parse(holder.started_at) : Number.NaN;
  const ageMs = Number.isNaN(startedMs) ? Number.POSITIVE_INFINITY : options.nowMs - startedMs;
  const foreignHost = typeof holder.host === 'string' && holder.host !== options.hostname;
  if (!foreignHost) {
    const alive = (options.isAlive ?? isPidAlive)(holder.pid);
    if (!alive) return { stale: true, reason: `pid ${holder.pid} is not running` };
    return { stale: false, reason: `pid ${holder.pid} is running` };
  }
  // Another machine's pid means nothing here; only age can decide, and only past the bound.
  if (ageMs > options.staleMs) return { stale: true, reason: `lock from ${holder.host} is ${Math.round(ageMs / 1000)}s old` };
  return { stale: false, reason: `lock from ${String(holder.host)} is recent` };
}

/**
 * Acquire the repository lock.
 *
 * @param {{root: string, now?: () => number, staleMs?: number, hostname?: string, isAlive?: typeof isPidAlive,
 *   pid?: number}} input
 * @returns {{acquired: boolean, path: string, holder: object|null, reclaimed: object|null}}
 * @throws {BackupLockError} `BACKUP_LOCK_WRITE_FAILED` when the lock file cannot be created for a non-lock reason
 */
export function acquireRepoLock(input) {
  const file = lockPath(input.root);
  const nowMs = (input.now ?? Date.now)();
  const hostname = input.hostname ?? os.hostname();
  const pid = input.pid ?? process.pid;
  const staleMs = Number.isSafeInteger(input.staleMs) && input.staleMs > 0 ? input.staleMs : DEFAULT_STALE_MS;
  const record = {
    format: 'w2m-session-backup/lock/1',
    pid,
    host: hostname,
    started_at: new Date(nowMs).toISOString(),
    cwd: process.cwd(),
  };

  const create = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true };
    } catch (error) {
      if (error?.code === 'EEXIST') return { ok: false, exists: true };
      throw new BackupLockError(
        LOCK_CODES.WRITE_FAILED,
        `${file}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`,
      );
    }
  };

  const first = create();
  if (first.ok === true) {
    return { acquired: true, path: file, holder: record, reclaimed: null };
  }

  const holder = readLock(file);
  const verdict = isStaleLock(holder, { nowMs, staleMs, hostname, isAlive: input.isAlive });
  if (verdict.stale !== true) {
    return { acquired: false, path: file, holder, reclaimed: null };
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    return {
      acquired: false,
      path: file,
      holder,
      reclaimed: null,
      reason: `stale lock could not be removed: ${error?.code ?? 'unknown'}`,
    };
  }
  const second = create();
  if (second.ok === true) {
    return { acquired: true, path: file, holder: record, reclaimed: { holder, verdict } };
  }
  return { acquired: false, path: file, holder: readLock(file), reclaimed: null };
}

/**
 * Acquire a lock and return a handle that releases it, or a refusal.
 *
 * @param {{root: string, now?: () => number, staleMs?: number, hostname?: string, isAlive?: typeof isPidAlive,
 *   pid?: number}} input
 * @returns {{ok: true, path: string, release: () => boolean, reclaimed: object|null} | {ok: false, reason_code: string, detail: string, holder: object|null}}
 */
export function withRepoLock(input) {
  const result = acquireRepoLock(input);
  if (result.acquired !== true) {
    const holder = result.holder;
    const who = holder === null
      ? 'an unreadable lock file'
      : `pid ${holder.pid ?? '?'} on ${holder.host ?? '?'} since ${holder.started_at ?? '?'}`;
    return {
      ok: false,
      reason_code: LOCK_CODES.LOCKED,
      detail: `${result.path} is held by ${who}${result.reason === undefined ? '' : `; ${result.reason}`}`,
      holder,
    };
  }
  const pid = input.pid ?? process.pid;
  return {
    ok: true,
    path: result.path,
    reclaimed: result.reclaimed,
    release: () => {
      const current = readLock(result.path);
      if (current !== null && current.pid !== pid) return false;
      try {
        fs.rmSync(result.path, { force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}
