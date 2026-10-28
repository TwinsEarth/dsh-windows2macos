/**
 * Relay blob purge: retire the data-plane store that old relays (1.6.4) still accepted.
 *
 * Layout note (measured on a real relay): blobs live at `<state>/blobs/<aa>/<sha256>`, i.e. ONE
 * level of fan-out directories, and `blob-sessions/` may hold in-flight chunks. The earlier
 * scrubBlobs() only looked at the top level, which is why a dry run against a real state directory
 * reported zero files while the relay was still holding megabytes.
 *
 * Rules:
 *   - dry-run by default; `apply` is required to touch anything
 *   - delete or quarantine (move outside the relay state tree); a manifest of what was removed is
 *     written next to the quarantine so an audit can prove what existed
 *   - after the purge the directory is re-listed; a non-empty result is `BLOBS_REAPPEARED`
 *     (that means something is still writing, e.g. an old relay that was not retired first)
 *   - stop the relay before applying: it keeps appending while running
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';

export const PURGE_CODES = Object.freeze({
  MISSING: 'BLOBS_MISSING',
  NOT_A_DIR: 'BLOBS_NOT_A_DIR',
  REAPPEARED: 'BLOBS_REAPPEARED',
  QUARANTINE_FAILED: 'QUARANTINE_FAILED',
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Recursively list blob files (and in-flight session dirs when asked). */
export function listBlobs(blobDir, { includeSessions = true } = {}) {
  if (!existsSync(blobDir)) return { ok: false, code: PURGE_CODES.MISSING, files: [] };
  if (!statSync(blobDir).isDirectory()) return { ok: false, code: PURGE_CODES.NOT_A_DIR, files: [] };
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        const rel = relative(blobDir, path).split('\\').join('/');
        if (!includeSessions && rel.startsWith('blob-sessions')) continue;
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({ rel: relative(blobDir, path).split('\\').join('/'), size: stat.size });
    }
  };
  walk(blobDir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { ok: true, files };
}

/** Prune empty directories under `dir`, leaving `dir` itself in place. */
function pruneEmpty(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      pruneEmpty(path);
      if (readdirSync(path).length === 0) rmdirSync(path);
    }
  }
}

/**
 * Purge the blob store.
 *
 * @param {string} blobDir `<state>/blobs`
 * @param {{apply?: boolean, quarantineDir?: string|null, now?: number, includeSessions?: boolean}} [options]
 */
export function purgeBlobs(blobDir, options = {}) {
  const listed = listBlobs(blobDir, { includeSessions: options.includeSessions !== false });
  if (listed.ok !== true) return { ok: false, ...listed, exists: false, count: 0, bytes: 0 };
  const files = listed.files;
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const base = {
    ok: true,
    dir: blobDir,
    exists: true,
    count: files.length,
    bytes,
    sample: files.slice(0, 5).map((file) => file.rel),
  };
  if (options.apply !== true) return { ...base, dry_run: true, removed: 0, quarantined: 0 };
  if (files.length === 0) return { ...base, dry_run: false, removed: 0, quarantined: 0, remaining: 0 };

  const now = Number.isInteger(options.now) ? options.now : Date.now();
  let quarantine = null;
  let manifest = null;
  if (typeof options.quarantineDir === 'string' && options.quarantineDir !== '') {
    quarantine = join(options.quarantineDir, 'purge-' + now);
    try {
      for (const file of files) {
        const target = join(quarantine, file.rel);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(join(blobDir, file.rel), target);
      }
      manifest = join(quarantine, 'manifest.json');
      writeFileSync(
        manifest,
        JSON.stringify(
          {
            at: new Date(now).toISOString(),
            source: blobDir,
            count: files.length,
            bytes,
            files: files.map((file) => ({ rel: file.rel, size: file.size, sha256: sha256(readFileSync(join(quarantine, file.rel))) })),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } catch (error) {
      return { ...base, ok: false, code: PURGE_CODES.QUARANTINE_FAILED, error: String(error) };
    }
  } else {
    for (const file of files) unlinkSync(join(blobDir, file.rel));
  }
  pruneEmpty(blobDir);

  const remaining = listBlobs(blobDir).files;
  const result = {
    ...base,
    dry_run: false,
    removed: quarantine === null ? files.length : 0,
    quarantined: quarantine === null ? 0 : files.length,
    quarantine,
    manifest,
    remaining: remaining.length,
    remaining_bytes: remaining.reduce((sum, file) => sum + file.size, 0),
  };
  if (remaining.length > 0) return { ...result, ok: false, code: PURGE_CODES.REAPPEARED };
  return result;
}
