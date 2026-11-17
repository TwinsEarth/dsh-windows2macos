/**
 * Garbage collection: remove encrypted blocks that no snapshot, version record or `current/` pointer references.
 *
 * ## The rule, and why the safe answer is "refuse" rather than "delete what looks unreferenced"
 *
 * A content-addressed store cannot tell an orphan from a block whose reference lives in a file it failed to
 * read. So `gc` **collects every root first**, and if any snapshot manifest, old version record or current
 * pointer is unreadable, it refuses to delete anything (`BACKUP_GC_UNSAFE`) and reports what it could not read.
 * The alternative -- treat unreadable as "no references" -- turns one corrupt pointer into the loss of the entire
 * block store.
 *
 * ## What is never touched
 *
 * Snapshots are not deleted by v3.4.7 gc at all; pruning snapshots is a retention decision for a later version,
 * and doing it implicitly here would make "gc" mean two different things. `old/` pruning is bounded by
 * `keepOldPerSession` and is the same function rotation uses.
 */

import fs from 'node:fs';
import path from 'node:path';

import { repoPaths } from './layout.mjs';
import { readJsonSafe } from './atomic.mjs';
import { withRepoLock } from './locks.mjs';
import { readSnapshot, listSnapshots } from './repo.mjs';
import { DEFAULT_KEEP_OLD, OLD_FORMAT, pruneOldVersions } from './rotation.mjs';

/** Named gc failure codes. */
export const GC_CODES = Object.freeze({
  UNSAFE: 'BACKUP_GC_UNSAFE',
  FAILED: 'BACKUP_GC_FAILED',
  NOT_A_REPO: 'BACKUP_REPO_NOT_INITIALIZED',
  LOCKED: 'BACKUP_LOCKED',
});

/** A content-addressed object file name. */
const OBJECT_NAME_RE = /^[0-9a-f]{64}$/;

/** How old a crashed writer's temp file must be before gc deletes it. */
export const STALE_TMP_MS = 60 * 60 * 1000;

/** Read every `current/` pointer under the repository. */
export function readCurrentPointers(root) {
  const base = path.join(path.resolve(root), 'current');
  const out = [];
  const problems = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') problems.push({ file: dir, detail: `readdir: ${error?.code ?? 'unknown'}` });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const parsed = readJsonSafe(full);
      if (parsed === null || !Array.isArray(parsed.blocks)) {
        problems.push({ file: full, detail: 'pointer is unreadable or has no block list' });
        continue;
      }
      out.push({ file: full, pointer: parsed });
    }
  };
  walk(base);
  return { pointers: out, problems };
}

/** Read every `old/` version record. */
export function readOldRecords(root) {
  const base = path.join(path.resolve(root), 'old');
  const out = [];
  const problems = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') problems.push({ file: dir, detail: `readdir: ${error?.code ?? 'unknown'}` });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const parsed = readJsonSafe(full);
      if (parsed === null || parsed.format !== OLD_FORMAT || !Array.isArray(parsed.blocks)) {
        problems.push({ file: full, detail: 'version record is unreadable or has no block list' });
        continue;
      }
      out.push({ file: full, record: parsed });
    }
  };
  walk(base);
  return { records: out, problems };
}

/**
 * Collect every live block digest.
 *
 * @param {string} root
 * @returns {{
 *   ok: boolean,
 *   blocks: Set<string>,
 *   counts: {snapshots: number, old: number, current: number},
 *   problems: Array<{file: string, detail: string}>
 * }}
 */
export function collectReferences(root) {
  const blocks = new Set();
  const problems = [];
  let snapshots = 0;
  for (const row of listSnapshots(root, { full: true })) {
    if (row.valid !== true) {
      problems.push({ file: path.join(repoPaths(root).snapshots, row.snapshot_id), detail: row.detail ?? 'snapshot is invalid' });
      continue;
    }
    try {
      const snapshot = readSnapshot({ root, snapshotId: row.snapshot_id });
      for (const file of snapshot.manifest.files) for (const block of file.blocks) blocks.add(block.sha256);
      snapshots += 1;
    } catch (error) {
      problems.push({ file: path.join(repoPaths(root).snapshots, row.snapshot_id), detail: error?.detail ?? String(error?.message ?? error) });
    }
  }
  const old = readOldRecords(root);
  problems.push(...old.problems);
  for (const row of old.records) for (const block of row.record.blocks) blocks.add(block.sha256);
  const current = readCurrentPointers(root);
  problems.push(...current.problems);
  for (const row of current.pointers) for (const block of row.pointer.blocks) blocks.add(block.sha256);
  return {
    ok: problems.length === 0,
    blocks,
    counts: { snapshots, old: old.records.length, current: current.pointers.length },
    problems,
  };
}

/**
 * Remove temp files a crashed writer left behind.
 *
 * `writeFileAtomic` cleans up after itself on failure, but a hard kill (or a power loss) cannot run that cleanup:
 * the repository then holds `.name.tmp-<pid>-<ts>-<rand>` files and possibly a staging directory under `tmp/`.
 * They are never referenced, and they would otherwise accumulate for the life of the repository. Only files older
 * than {@link STALE_TMP_MS} are touched: a temp file with a recent mtime may belong to a writer that is starting
 * right now.
 *
 * The lock file is explicitly skipped -- deleting it would let two writers in.
 *
 * @param {{root: string, dryRun?: boolean, nowMs?: number, staleMs?: number}} input
 * @returns {{scanned: number, removed: number, reclaimed_bytes: number, files: string[]}}
 */
export function collectTmpLeftovers(input) {
  const root = path.resolve(input.root);
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const staleMs = Number.isSafeInteger(input.staleMs) && input.staleMs > 0 ? input.staleMs : STALE_TMP_MS;
  const paths = repoPaths(root);
  const candidates = [];
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
      if (entry.name === 'backup.lock') continue;
      if (!entry.name.includes('.tmp-')) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      candidates.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(paths.objects);
  walk(paths.tmp);
  let removed = 0;
  let reclaimed = 0;
  const files = [];
  for (const candidate of candidates) {
    if (nowMs - candidate.mtimeMs < staleMs) continue;
    files.push(candidate.file);
    if (input.dryRun === true) {
      removed += 1;
      reclaimed += candidate.size;
      continue;
    }
    try {
      fs.rmSync(candidate.file, { force: true });
      removed += 1;
      reclaimed += candidate.size;
    } catch {
      // Reported through the count: an undeletable leftover stays visible instead of failing the whole gc.
    }
  }
  return { scanned: candidates.length, removed, reclaimed_bytes: reclaimed, files };
}

/** Remove object prefix directories that no longer contain anything. */
function removeEmptyPrefixes(root) {
  const objectsRoot = repoPaths(root).objects;
  let removed = 0;
  let prefixes = [];
  try {
    prefixes = fs.readdirSync(objectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return 0;
  }
  for (const prefix of prefixes) {
    const dir = path.join(objectsRoot, prefix.name);
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        removed += 1;
      }
    } catch {
      // Keep the directory; it is empty, which is harmless.
    }
  }
  return removed;
}

/** List object files as `{file, sha256, size}`. */
export function listObjects(root) {
  const objectsRoot = repoPaths(root).objects;
  const out = [];
  let prefixes;
  try {
    prefixes = fs.readdirSync(objectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue;
    let names;
    try {
      names = fs.readdirSync(path.join(objectsRoot, prefix.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!OBJECT_NAME_RE.test(name)) continue;
      const file = path.join(objectsRoot, prefix.name, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      out.push({ file, sha256: name, size: stat.size });
    }
  }
  return out;
}

/**
 * Remove unreferenced blocks, prune the old-version window, and clear a crashed writer's temp files.
 *
 * Takes the repository lock: deleting blocks while a backup is writing them is the one way gc could destroy a
 * snapshot that is being committed.
 *
 * @param {{root: string, dryRun?: boolean, keepOldPerSession?: number, nowMs?: number, staleTmpMs?: number}} input
 * @returns {{
 *   ok: boolean, safe: boolean, dry_run: boolean,
 *   references: {blocks: number, snapshots: number, old: number, current: number},
 *   blocks: {scanned: number, removed: number, reclaimed_bytes: number, kept: number},
 *   old_versions: {pruned: number},
 *   tmp: {scanned: number, removed: number, reclaimed_bytes: number},
 *   empty_prefixes_removed: number,
 *   problems: Array<object>, reason_code: string|null
 * }}
 */
export function gc(input) {
  const root = path.resolve(input.root);
  const dryRun = input.dryRun === true;
  const lock = withRepoLock({ root });
  if (lock.ok !== true) {
    return {
      ok: false,
      safe: false,
      dry_run: dryRun,
      references: { blocks: 0, snapshots: 0, old: 0, current: 0 },
      blocks: { scanned: 0, removed: 0, reclaimed_bytes: 0, kept: 0 },
      old_versions: { pruned: 0 },
      tmp: { scanned: 0, removed: 0, reclaimed_bytes: 0 },
      empty_prefixes_removed: 0,
      problems: [{ file: lock.path, detail: lock.detail }],
      reason_code: lock.reason_code,
    };
  }
  try {
    const references = collectReferences(root);
    if (!references.ok) {
      return {
        ok: false,
        safe: false,
        dry_run: dryRun,
        references: { blocks: references.blocks.size, ...references.counts },
        blocks: { scanned: 0, removed: 0, reclaimed_bytes: 0, kept: 0 },
        old_versions: { pruned: 0 },
        tmp: { scanned: 0, removed: 0, reclaimed_bytes: 0 },
        empty_prefixes_removed: 0,
        problems: references.problems,
        reason_code: GC_CODES.UNSAFE,
      };
    }

    const objects = listObjects(root);
    const failed = [];
    let removed = 0;
    let reclaimed = 0;
    for (const object of objects) {
      if (references.blocks.has(object.sha256)) continue;
      if (dryRun) {
        removed += 1;
        reclaimed += object.size;
        continue;
      }
      try {
        fs.rmSync(object.file, { force: true });
        removed += 1;
        reclaimed += object.size;
      } catch (error) {
        failed.push({ file: object.file, detail: error?.code ?? 'unlink failed' });
      }
    }

    const pruned = pruneOldVersions({
      root,
      keep: Number.isSafeInteger(input.keepOldPerSession) ? input.keepOldPerSession : DEFAULT_KEEP_OLD,
      dryRun,
    });
    const leftovers = collectTmpLeftovers({ root, dryRun, nowMs: input.nowMs, staleMs: input.staleTmpMs });
    const emptyPrefixesRemoved = dryRun ? 0 : removeEmptyPrefixes(root);

    return {
      ok: failed.length === 0,
      safe: true,
      dry_run: dryRun,
      references: { blocks: references.blocks.size, ...references.counts },
      blocks: { scanned: objects.length, removed, reclaimed_bytes: reclaimed, kept: objects.length - removed },
      old_versions: { pruned: pruned.removed.length },
      tmp: { scanned: leftovers.scanned, removed: leftovers.removed, reclaimed_bytes: leftovers.reclaimed_bytes },
      empty_prefixes_removed: emptyPrefixesRemoved,
      problems: failed.map((row) => ({ file: row.file, detail: row.detail })),
      reason_code: failed.length === 0 ? null : GC_CODES.FAILED,
    };
  } finally {
    lock.release();
  }
}
