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
 * `keepOldPerSession` and, optionally, by the `maxOldVersionDays` age window; both are the same retention
 * function rotation uses (`rotation.mjs#pruneOldVersions`), so a scheduled gc and a rotation prune identically.
 *
 * ## Orphan whole-file copies (`oldFormat: 'full'`)
 *
 * A `full` repository keeps `<ts>-<sha12>.json.enc` beside each version record. Two harmless leftovers are
 * possible: rotation prunes a record and then deletes its copy (a crash between the two leaves the copy), or a
 * record write fails after the copy already landed. Such a copy is referenced by nothing, so gc removes every
 * `.json.enc` under `old/` that no **remaining** record points at. A copy a live record references is never
 * touched. The scan only runs on the safe path (after `collectReferences` returned no problems), so an
 * unreadable repository still deletes nothing at all.
 *
 * ## Ordering: a record pruned here cannot orphan a block in the same run
 *
 * The reference set is collected **once, before any deletion**, and every block is judged against that set.
 * The old-version prune runs after the unreferenced blocks are removed, so a block whose only reference is a
 * record that this same run prunes is still treated as referenced for the whole run and survives at least this
 * run. It becomes collectable on the *next* gc. That is deliberate: the alternative -- deleting a record and
 * then re-deciding what its blocks were worth -- is how one pass removes the last reference to data it is about
 * to delete, with no snapshot left to prove it existed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { repoPaths } from './layout.mjs';
import { readJsonSafe } from './atomic.mjs';
import { withRepoLock } from './locks.mjs';
import { readSnapshot, listSnapshots } from './repo.mjs';
import { DEFAULT_KEEP_OLD, OLD_FORMAT, ROTATION_CODES, fullCopyPathFor, measureOldUsage, pruneOldVersions, resolveMaxAgeDays } from './rotation.mjs';

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
 * Every sealed whole-file copy under `old/` (`<ts>-<sha12>.json.enc`), with its size.
 *
 * Deliberately name-based: these files are ciphertext, so gc cannot ask them what record they belong to -- the
 * records are the authority, which is why {@link collectOrphanFullCopies} re-reads them.
 *
 * @param {string} root
 * @returns {Array<{file: string, size: number}>}
 */
export function listFullCopies(root) {
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
      if (!entry.isFile() || !entry.name.endsWith('.json.enc')) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({ file: full, size: stat.size });
    }
  };
  walk(base);
  return out;
}

/**
 * Remove whole-file copies that no remaining version record references.
 *
 * Called **after** `pruneOldVersions`, so a record pruned in this same run no longer counts as a reference and
 * its copy (if the paired delete did not happen) is collected here. The reference set is re-read from the
 * records that are actually left; if any of them is unreadable the cleanup refuses to delete anything and
 * reports the problems instead -- a `.enc` whose ownership cannot be established survives to the next run, which
 * is the same posture the block collector takes.
 *
 * @param {{root: string, dryRun?: boolean}} input
 * @returns {{scanned: number, removed: number, reclaimed_bytes: number, files: string[],
 *   problems: Array<{file: string, detail: string}>}}
 */
export function collectOrphanFullCopies(input) {
  const root = path.resolve(input.root);
  const copies = listFullCopies(root);
  const old = readOldRecords(root);
  if (old.problems.length > 0) {
    return { scanned: copies.length, removed: 0, reclaimed_bytes: 0, files: [], problems: old.problems };
  }
  const referenced = new Set();
  for (const row of old.records) {
    const file = fullCopyPathFor(root, row.record);
    if (file !== null) referenced.add(path.resolve(file));
  }
  let removed = 0;
  let reclaimed = 0;
  const files = [];
  for (const copy of copies) {
    if (referenced.has(path.resolve(copy.file))) continue;
    files.push(copy.file);
    if (input.dryRun === true) {
      removed += 1;
      reclaimed += copy.size;
      continue;
    }
    try {
      fs.rmSync(copy.file, { force: true });
      removed += 1;
      reclaimed += copy.size;
    } catch {
      // Reported through the count only: an undeletable orphan stays visible instead of failing the whole gc.
    }
  }
  return { scanned: copies.length, removed, reclaimed_bytes: reclaimed, files, problems: [] };
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
 * `maxOldVersionDays` applies the age half of the retention policy in addition to the per-session count
 * (`keepOldPerSession`); absent/0 disables the age rule. An invalid value is refused before the lock and before
 * any walk, so a configuration mistake is never reported in the vocabulary of a damaged repository. A finite
 * `nowMs` is the clock for both time-based decisions (stale temp files and the age rule), so tests can pin it.
 *
 * @param {{root: string, dryRun?: boolean, keepOldPerSession?: number, maxOldVersionDays?: number|null,
 *   nowMs?: number, staleTmpMs?: number}} input
 * @returns {{
 *   ok: boolean, safe: boolean, dry_run: boolean, detail?: string,
 *   references: {blocks: number, snapshots: number, old: number, current: number},
 *   blocks: {scanned: number, removed: number, reclaimed_bytes: number, kept: number},
 *   old_versions: {pruned: number, pruned_by_age: number, full_copies_pruned: number},
 *   orphan_full_copies: {scanned: number, removed: number, reclaimed_bytes: number},
 *   tmp: {scanned: number, removed: number, reclaimed_bytes: number},
 *   empty_prefixes_removed: number,
 *   old_usage: {before: {bytes: number, files: number}, after: {bytes: number, files: number}},
 *   problems: Array<object>, reason_code: string|null
 * }}
 */
export function gc(input) {
  const root = path.resolve(input.root);
  const dryRun = input.dryRun === true;
  const agePolicy = resolveMaxAgeDays(input.maxOldVersionDays);
  if (agePolicy.ok !== true) {
    // Fail fast and write nothing: an invalid retention window is a configuration error, not a state of the
    // repository, so it must not be discovered after the object walk (and must never delete anything).
    return {
      ok: false,
      safe: false,
      dry_run: dryRun,
      references: { blocks: 0, snapshots: 0, old: 0, current: 0 },
      blocks: { scanned: 0, removed: 0, reclaimed_bytes: 0, kept: 0 },
      old_versions: { pruned: 0, pruned_by_age: 0, full_copies_pruned: 0 },
      orphan_full_copies: { scanned: 0, removed: 0, reclaimed_bytes: 0 },
      tmp: { scanned: 0, removed: 0, reclaimed_bytes: 0 },
      empty_prefixes_removed: 0,
      problems: [],
      reason_code: agePolicy.reason_code ?? ROTATION_CODES.POLICY_INVALID,
      detail: agePolicy.detail,
    };
  }
  const lock = withRepoLock({ root });
  if (lock.ok !== true) {
    return {
      ok: false,
      safe: false,
      dry_run: dryRun,
      references: { blocks: 0, snapshots: 0, old: 0, current: 0 },
      blocks: { scanned: 0, removed: 0, reclaimed_bytes: 0, kept: 0 },
      old_versions: { pruned: 0, pruned_by_age: 0, full_copies_pruned: 0 },
      orphan_full_copies: { scanned: 0, removed: 0, reclaimed_bytes: 0 },
      tmp: { scanned: 0, removed: 0, reclaimed_bytes: 0 },
      empty_prefixes_removed: 0,
      problems: [{ file: lock.path, detail: lock.detail }],
      reason_code: lock.reason_code,
    };
  }
  try {
    // The `old/` tree is measured before and after this pass. The walk is read-only and is the same one the engine
    // uses for the usage reminder (§24.3): it answers "did the cleanup change the old-version tree", and it gives
    // the CLI the `old usage before/after` line without a second command. `old/` itself is still never deleted
    // wholesale -- gc only applies the same retention window rotation does.
    const oldUsageBefore = measureOldUsage(root);
    const references = collectReferences(root);
    if (!references.ok) {
      return {
        ok: false,
        safe: false,
        dry_run: dryRun,
        references: { blocks: references.blocks.size, ...references.counts },
        blocks: { scanned: 0, removed: 0, reclaimed_bytes: 0, kept: 0 },
        old_versions: { pruned: 0, pruned_by_age: 0, full_copies_pruned: 0 },
      orphan_full_copies: { scanned: 0, removed: 0, reclaimed_bytes: 0 },
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
      maxAgeDays: agePolicy.maxAgeDays,
      // One clock for both time-based decisions of the run: stale-tmp aging and the age retention rule. Tests
      // inject it, so a policy is asserted against a fixed instant rather than against the wall clock.
      now: Number.isFinite(input.nowMs) ? input.nowMs : undefined,
      dryRun,
    });
    const leftovers = collectTmpLeftovers({ root, dryRun, nowMs: input.nowMs, staleMs: input.staleTmpMs });
    // `full` repositories: a `.json.enc` no remaining record references is a leftover from a crash between
    // "prune the record" and "delete the copy" (or from a failed record write after the copy landed). Only the
    // safe path reaches here, so an unreadable reference has already refused the whole run.
    const orphans = collectOrphanFullCopies({ root, dryRun });
    for (const problem of orphans.problems) failed.push(problem);
    const emptyPrefixesRemoved = dryRun ? 0 : removeEmptyPrefixes(root);
    const oldUsageAfter = measureOldUsage(root);

    return {
      ok: failed.length === 0,
      safe: true,
      dry_run: dryRun,
      references: { blocks: references.blocks.size, ...references.counts },
      blocks: { scanned: objects.length, removed, reclaimed_bytes: reclaimed, kept: objects.length - removed },
      old_versions: { pruned: pruned.removed.length, pruned_by_age: pruned.pruned_by_age, full_copies_pruned: pruned.full_copies_removed },
      orphan_full_copies: { scanned: orphans.scanned, removed: orphans.removed, reclaimed_bytes: orphans.reclaimed_bytes },
      tmp: { scanned: leftovers.scanned, removed: leftovers.removed, reclaimed_bytes: leftovers.reclaimed_bytes },
      empty_prefixes_removed: emptyPrefixesRemoved,
      old_usage: { before: oldUsageBefore, after: oldUsageAfter },
      problems: failed.map((row) => ({ file: row.file, detail: row.detail })),
      reason_code: failed.length === 0 ? null : GC_CODES.FAILED,
    };
  } finally {
    lock.release();
  }
}
