/**
 * The offsite mirror: a second copy of the sealed blocks and the snapshot metadata on another disk.
 *
 * ## Why a mirror and not "the backup directory is on the other drive"
 *
 * The primary repository is the one the engine writes, locks and verifies. Copying it with an external tool is
 * either a full recursive copy (rewrites every block on every run, and a block is up to 4 MiB) or a
 * "newest-file" heuristic that can copy a snapshot directory before its blocks. This module performs the copy
 * with the repository protocol's own vocabulary: it reads a **committed** snapshot through `repo.mjs`, knows
 * exactly which content addresses that snapshot needs, and copies only the ones the mirror does not already
 * have -- repairing the ones it has in the wrong byte length, because a file name is not proof of content.
 *
 * ## What is copied, and what is never touched
 *
 *   * `objects/<aa>/<sha256>` -- the **already sealed** blocks, byte for byte. This module never holds the DEK,
 *     never decrypts and never writes plaintext session bytes. A mirror is exactly as confidential as the
 *     primary: both are ciphertext.
 *   * `snapshots/<id>/manifest.json` and `snapshots/<id>/keys.json` -- the encrypted manifest and the wrapped
 *     DEK envelopes. Both are public metadata by design (the manifest is paths and hashes; the envelopes are
 *     wrapped keys, not keys).
 *   * `backup.json` and `keys.json` at the mirror root -- **without these the copy is not a repository**: a
 *     reader can rebuild a file from `objects/` given a manifest, but `openRepo(mirror)` cannot even report
 *     `initialized: true` without a descriptor, and unwrapping the DEK needs the authoritative envelopes file.
 *     They are wrapped-key envelopes only; no plaintext secret and no password is copied.
 *   * one line in `index.jsonl` for the snapshot, appended only if the mirror index does not already name it.
 *   * `old/` -- the **whole superseded-version tree**: every `<ts>-<sha12>.json` record and its paired
 *     `<ts>-<sha12>.json.enc` sealed copy. These are not needed to open a snapshot (the record restores from
 *     `objects/`), but they are the only thing that restores a version whose blocks are gone, which is exactly the
 *     disaster a mirror exists for. `old/` is copied after the snapshot itself and is never a precondition for it;
 *     it does grow without a total cap (§21.2/§24.3), so the mirrored tree grows with it and is not deduplicated.
 *
 * ## Idempotent by construction, but not blind
 *
 * Every write is skipped when the destination already matches the source: an object must exist at its content
 * address **and have the source's byte length** (a truncated or externally damaged copy is rewritten, not
 * trusted), a version record must be byte-identical (records are small, so the content check is cheap), a sealed
 * whole-file copy must have the source's byte length (the mirror never holds the DEK, so length is the cheap
 * check), snapshot and root metadata files are compared byte for byte, and the index by snapshot id. An intact
 * mirror therefore re-syncs with zero writes and reports `copied.repaired: 0`, so a scheduled mirror costs the
 * size of the new session versions, not the size of the repository.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './atomic.mjs';
import { repoPaths } from './layout.mjs';
import { readIndex, readSnapshot, serializeIndexEntry } from './repo.mjs';

/** Named mirror failures. A caller matches on the code, never on a message. */
export const MIRROR_CODES = Object.freeze({
  INVALID: 'BACKUP_MIRROR_INVALID',
  FAILED: 'BACKUP_MIRROR_FAILED',
  /** The mirror's real path (through a symlink/junction) is the repository, inside it, or inside the home. */
  SYMLINK: 'BACKUP_MIRROR_SYMLINK',
});

/** A mirror failure with a stable code, carrying the partial copy counts a failure did achieve. */
export class MirrorError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'MirrorError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

/** Name of the authoritative wrapped-key file at the repository root (same file `keystore.mjs` writes). */
const REPO_KEYS_FILE = 'keys.json';

/** The two files a snapshot directory owns. */
const SNAPSHOT_FILES = Object.freeze(['manifest.json', 'keys.json']);

/** Size of an existing regular file, or `null` when it is missing, unreadable, or not a file. */
function sizeIfFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Read a file, or `null` when it is missing/unreadable (which the caller reports in its own words). */
function readIfExists(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** True when two file contents are byte-identical. */
function sameBytes(left, right) {
  return left !== null && right !== null && left.length === right.length && left.equals(right);
}

/** The refusal shape for a mirror location that cannot be used. */
function invalid(detail) {
  return { ok: false, reason_code: MIRROR_CODES.INVALID, detail };
}

/** The refusal shape for a mirror whose real path (through a symlink/junction) is not a separate location. */
function symlinked(detail) {
  return { ok: false, reason_code: MIRROR_CODES.SYMLINK, detail };
}

/**
 * The relative path from `root` to `candidate` when it is `root` itself or below it, otherwise `null`.
 *
 * Decided with `path.relative`, never by string prefix: `D:\BackUP2` is not inside `D:\BackUP`. A path on another
 * drive has no relative form, so `path.relative` returns an absolute path and that is treated as "outside" --
 * cross-drive is exactly what a mirror is for, not an error.
 */
function containmentRelative(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? relative : null;
}

/** Filesystem codes that mean "the component is not there (yet)", not "the component cannot be inspected". */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Resolve `target` to the path the filesystem actually uses, tolerating components that do not exist yet.
 *
 * The deepest existing component is resolved with `fs.realpathSync` -- which follows symlinks and, on Windows,
 * junctions -- and the not-yet-created remainder is appended to that real path. A mirror normally does not exist
 * before its first sync, so a missing suffix is expected and must stay usable. What is not expected is a component
 * that exists but cannot be resolved (`ELOOP`, `EACCES`, a broken junction): its containment cannot be verified,
 * so the failure is reported back and the caller refuses the path instead of assuming it is outside.
 *
 * @param {string} target
 * @returns {{ok: true, real: string} | {ok: false, code: string, at: string}}
 */
function realPathTolerant(target) {
  const wanted = path.resolve(target);
  let current = wanted;
  for (;;) {
    let present = false;
    let failed = null;
    try {
      fs.lstatSync(current);
      present = true;
    } catch (error) {
      if (!ABSENT_CODES.has(error?.code)) failed = error?.code ?? 'unknown';
    }
    if (failed !== null) return { ok: false, code: failed, at: current };
    if (present) {
      try {
        const real = fs.realpathSync(current);
        const rest = path.relative(current, wanted);
        return { ok: true, real: rest === '' ? real : path.resolve(real, rest) };
      } catch (error) {
        return { ok: false, code: error?.code ?? 'unknown', at: current };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // No component of the path exists (a disconnected drive, for example). There is no existing link to
      // follow, so the resolved lexical path is the most truthful real path this validation can state.
      return { ok: true, real: wanted };
    }
    current = parent;
  }
}

/**
 * Refuse a write whose ancestors inside the mirror, once links are followed, leave their lexical place.
 *
 * `resolveMirrorRoot` checks the mirror root once, before the first write. A junction created **inside** the mirror
 * tree (or the root swapped for one) between that check and the write would make the copy land somewhere else --
 * the repository, the home, or an arbitrary directory. This guard is the re-check at write time: every existing
 * ancestor between the target and the mirror root must resolve to itself, and the target must stay under the root.
 *
 * @param {string} realRoot the validated mirror root (real path)
 * @param {string} target the file about to be written
 * @throws {MirrorError} `BACKUP_MIRROR_SYMLINK` / `BACKUP_MIRROR_INVALID`
 */
function guardWritablePath(realRoot, target) {
  const wanted = path.resolve(target);
  const resolved = realPathTolerant(wanted);
  if (resolved.ok !== true) {
    throw new MirrorError(MIRROR_CODES.INVALID, `cannot resolve ${wanted} before writing it: ${resolved.code}`);
  }
  // Compare the canonical target with the canonical root. On macOS `/var` is a symlink to `/private/var`, so a
  // lexical prefix comparison would reject an honest path whose *parent* was already resolved while the target
  // still carries the unresolved alias. Resolving first keeps the containment rule without treating the system
  // alias above the root as an escape inside it.
  const canonical = path.resolve(resolved.real);
  if (containmentRelative(realRoot, canonical) === null) {
    throw new MirrorError(
      MIRROR_CODES.SYMLINK,
      `${wanted} resolves to ${canonical}, outside the validated mirror root ${realRoot}`,
    );
  }
}

/**
 * Resolve and validate the mirror root.
 *
 * Refusals name the reason rather than returning a bare `false`, and each one is a case where copying would be
 * actively harmful rather than merely useless:
 *
 *   * the mirror is the repository root, or **inside** it -- the mirror would copy the repository into itself,
 *     and the next run would copy its own copy;
 *   * the mirror is inside (or is) the DSH home being backed up -- the offsite copy would live in the tree the
 *     primary backup scans, so the next backup would capture the mirror and grow the repository with its own
 *     history;
 *   * a symlink or Windows junction redirects the mirror into the repository or the home even though the lexical
 *     path looks outside -- `path.resolve` does not follow links, so the check is repeated on real paths;
 *   * the mirror path exists and is a file, not a directory -- a write into it can only fail after blocks were
 *     already copied, and the failure would look like a broken mirror rather than a wrong path.
 *
 * Containment is decided on resolved paths with `path.relative`, never by string prefix: `D:\BackUP2` is not
 * inside `D:\BackUP`. A path on another drive has no relative form, so `path.relative` returns an absolute path
 * and that is treated as "outside" -- cross-drive is exactly what a mirror is for, not an error.
 *
 * The real-path comparison resolves the deepest existing component with `fs.realpathSync` and appends the
 * not-yet-created remainder, so a mirror that does not exist before its first sync is still accepted (including
 * several missing levels) while a path whose existing component cannot be resolved is refused with a named
 * reason instead of being assumed safe.
 *
 * @param {{repoRoot?: string, dshHome?: string|null, mirrorRoot?: string}} input
 * @returns {{ok: true, root: string} | {ok: false, reason_code: string, detail: string}}
 */
export function resolveMirrorRoot(input = {}) {
  const raw = input?.mirrorRoot;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return invalid(`mirrorRoot must be a non-empty path string, got ${raw === undefined ? 'undefined' : JSON.stringify(raw)}`);
  }
  if (typeof input.repoRoot !== 'string' || input.repoRoot.trim() === '') {
    return invalid('the repository root is required to validate a mirror location');
  }
  const mirror = path.resolve(raw.trim());
  const repo = path.resolve(input.repoRoot.trim());
  const relativeToRepo = containmentRelative(repo, mirror);
  if (relativeToRepo !== null) {
    return relativeToRepo === ''
      ? invalid(`${mirror} is the repository root itself; a mirror must be a separate location from the repository it copies`)
      : invalid(`${mirror} is inside the repository root (${repo}); a mirror copied into the repository would be captured by its own next run`);
  }
  const home = typeof input.dshHome === 'string' && input.dshHome.trim() !== '' ? path.resolve(input.dshHome.trim()) : null;
  if (home !== null && containmentRelative(home, mirror) !== null) {
    return invalid(`${mirror} is inside (or is) the DSH home being backed up (${home}); the offsite copy must not live in the tree the primary backup scans`);
  }

  // The lexical checks above use `path.resolve` output, which does not follow links. A symlink or junction can
  // point the mirror's real target inside the repository (or the home) while the path string looks outside; the
  // copies would then land in the tree the mirror must never touch. Repeat the same containment checks on real
  // paths. A path that cannot be resolved is refused rather than assumed outside.
  const mirrorReal = realPathTolerant(mirror);
  if (mirrorReal.ok !== true) {
    return invalid(`could not resolve the real path of ${mirror} (${mirrorReal.code} at ${mirrorReal.at}); refusing the mirror rather than assuming its containment is safe`);
  }
  const repoReal = realPathTolerant(repo);
  if (repoReal.ok !== true) {
    return invalid(`could not resolve the real path of the repository root ${repo} (${repoReal.code} at ${repoReal.at}); the mirror's containment cannot be verified`);
  }
  const realRelativeToRepo = containmentRelative(repoReal.real, mirrorReal.real);
  if (realRelativeToRepo !== null) {
    return symlinked(
      realRelativeToRepo === ''
        ? `${mirror} resolves to the repository root itself once links are followed (real path ${mirrorReal.real}); a symlink or junction must not turn the mirror into the repository it copies`
        : `${mirror} resolves inside the repository root (${repoReal.real}) once links are followed (real path ${mirrorReal.real}); a symlink or junction would copy the repository into itself`,
    );
  }
  if (home !== null) {
    const homeReal = realPathTolerant(home);
    if (homeReal.ok !== true) {
      return invalid(`could not resolve the real path of the DSH home ${home} (${homeReal.code} at ${homeReal.at}); the mirror's containment cannot be verified`);
    }
    if (containmentRelative(homeReal.real, mirrorReal.real) !== null) {
      return symlinked(
        `${mirror} resolves inside (or is) the DSH home being backed up once links are followed (real path ${mirrorReal.real}); a symlink or junction would put the offsite copy in the tree the primary backup scans`,
      );
    }
  }

  let stat = null;
  try {
    stat = fs.statSync(mirror);
  } catch (error) {
    // ENOENT is the normal case (the first sync creates it). ENOTDIR means a parent component is a file: the
    // path cannot be created, and syncToMirror reports that as the named write failure it is, with the primary
    // backup still committed. Any other error is an inspection failure and is refused up front.
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      return invalid(`could not inspect ${mirror}: ${error?.code ?? 'unknown'}`);
    }
  }
  if (stat !== null && !stat.isDirectory()) {
    return invalid(`${mirror} exists and is a file, not a directory; a mirror must be a directory`);
  }
  return { ok: true, root: mirror };
}

/**
 * Every regular file in the primary `old/` tree that belongs to the version tree.
 *
 * `old/` holds two kinds of files: `<ts>-<sha12>.json` version records and their optional `<ts>-<sha12>.json.enc`
 * sealed whole-file copies. Anything else under `old/` (a crashed writer's temporary file, a human's note) is not
 * part of the protocol and is not copied: a mirror reproduces the version tree, not an arbitrary directory.
 *
 * The walk lists with `withFileTypes` and only follows directory entries; a symlink or Windows junction is neither
 * a directory nor a regular file, so it is skipped instead of followed out of `old/`. A listing failure other than
 * "the directory is not there" is reported: silently treating an unreadable `old/` as empty would claim the
 * mirror is complete when it is not.
 *
 * @param {string} root primary repository root
 * @returns {{ok: true, files: Array<{file: string, rel: string[]}>} | {ok: false, detail: string}}
 */
function listPrimaryOldFiles(root) {
  const base = path.join(path.resolve(root), 'old');
  const files = [];
  const walk = (dir, parts) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      return `could not list ${dir}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const problem = walk(full, [...parts, entry.name]);
        if (problem !== null) return problem;
        continue;
      }
      // `isFile()` is false for symlinks/junctions: they are skipped, never followed.
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.json.enc')) continue;
      files.push({ file: full, rel: [...parts, entry.name] });
    }
    return null;
  };
  const problem = walk(base, []);
  return problem === null ? { ok: true, files } : { ok: false, detail: problem };
}

/**
 * Copy one committed snapshot to the mirror.
 *
 * The steps run in dependency order: objects first (a manifest names them), then the snapshot's own files, then
 * the repository metadata that makes the mirror openable, then the index line that records the commit. An
 * interrupted copy therefore never leaves an index line pointing at a snapshot whose blocks are absent; it
 * leaves extra objects and, at worst, a snapshot directory the index does not name yet, which the next sync of
 * the same snapshot completes.
 *
 * Failures throw a {@link MirrorError}: the location's refusal code (`BACKUP_MIRROR_INVALID`, or
 * `BACKUP_MIRROR_SYMLINK` when a link redirects the mirror) when it is refused, and `BACKUP_MIRROR_FAILED` (with
 * `copied` carrying the partial counts) when a read or write fails. The engine treats both as a warning on a
 * committed backup -- the primary is never rolled back because a copy failed.
 *
 * `copied.files`/`copied.bytes` count the snapshot's own written bytes; `copied.old_files`/`copied.old_bytes` count
 * the `old/` version tree written by the same sync; `copied.repaired` is the subset of all those writes that
 * replaced a file already present with the wrong content (truncated object, damaged metadata, torn copy). An intact
 * mirror therefore reports `{files: 0, bytes: 0, repaired: 0, old_files: 0, old_bytes: 0}` on a re-sync (with
 * `skipped.old_files` naming the version-tree files that were already present).
 *
 * @param {{root: string, mirrorRoot: string, dshHome?: string|null, snapshotId: string, now?: Date}} input
 * @returns {{ok: true, root: string,
 *   copied: {files: number, bytes: number, repaired: number, old_files: number, old_bytes: number},
 *   skipped: {files: number, bytes: number, old_files: number},
 *   index_appended: boolean, descriptor_copied: boolean}}
 * @throws {MirrorError}
 */
export function syncToMirror(input) {
  const resolved = resolveMirrorRoot({ repoRoot: input.root, dshHome: input.dshHome, mirrorRoot: input.mirrorRoot });
  if (resolved.ok !== true) throw new MirrorError(resolved.reason_code ?? MIRROR_CODES.INVALID, resolved.detail);
  const root = path.resolve(input.root);
  const mirror = resolved.root;
  // The root was validated a moment ago; resolve it again now, because the write-time guard needs a real path and
  // because a root swapped for a junction in between must not redirect this sync.
  const mirrorReal = realPathTolerant(mirror);
  if (mirrorReal.ok !== true) {
    throw new MirrorError(MIRROR_CODES.INVALID, `cannot resolve the mirror root ${mirror}: ${mirrorReal.code}`);
  }
  const guardRoot = mirrorReal.real;
  const primaryPaths = repoPaths(root);
  const mirrorPaths = repoPaths(mirror);
  const copied = { files: 0, bytes: 0, repaired: 0, old_files: 0, old_bytes: 0 };
  const skipped = { files: 0, bytes: 0, old_files: 0 };
  /** A named copy failure carrying the counts the partial copy did achieve. */
  const fail = (detail) => new MirrorError(MIRROR_CODES.FAILED, detail, { copied: { ...copied } });

  try {
    // Read the committed snapshot through the protocol: this validates the exact shape the copy relies on and
    // gives the manifest whose block list is the whole definition of "what this snapshot needs".
    const snapshot = readSnapshot({ root, snapshotId: input.snapshotId });
    try {
      fs.mkdirSync(mirrorPaths.objects, { recursive: true });
      fs.mkdirSync(mirrorPaths.snapshots, { recursive: true });
    } catch (error) {
      throw fail(`could not create the mirror layout under ${mirror}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
    }

    // (b) Objects, deduplicated by content address. The address proves what the source bytes *are*, not what a
    // file in the mirror actually contains: a truncated/damaged copy (bad disk, an external tool, a crash outside
    // writeFileAtomic) would otherwise stay "already present" forever. So an existing object is reused only when
    // it is a regular file of exactly the source's byte length; anything else is rewritten and counted as
    // repaired. Byte length is the cheap check that needs no decryption -- this module never holds the DEK.
    const blockShas = new Set();
    for (const file of snapshot.manifest.files) for (const block of file.blocks ?? []) blockShas.add(block.sha256);
    for (const sha256 of blockShas) {
      const sourceObject = path.join(primaryPaths.objects, sha256.slice(0, 2), sha256);
      const mirrorObject = path.join(mirrorPaths.objects, sha256.slice(0, 2), sha256);
      const sourceSize = sizeIfFile(sourceObject);
      const mirrorSize = sizeIfFile(mirrorObject);
      if (sourceSize !== null && mirrorSize === sourceSize) {
        skipped.files += 1;
        skipped.bytes += mirrorSize;
        continue;
      }
      const sealed = readIfExists(sourceObject);
      if (sealed === null) throw fail(`the primary repository has no sealed block ${sha256}, so the mirror copy would be incomplete`);
      guardWritablePath(guardRoot, mirrorObject);
      try {
        writeFileAtomic(mirrorObject, sealed);
      } catch (error) {
        throw fail(`writing ${mirrorObject}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      }
      copied.files += 1;
      copied.bytes += sealed.length;
      if (mirrorSize !== null) copied.repaired += 1;
    }

    // (c) The snapshot's own two files: the encrypted manifest and the wrapped-key envelopes. They are small, so
    // they are compared byte for byte (a same-length corruption is caught too); only an exact copy is skipped.
    const mirrorSnapshotDir = path.join(mirrorPaths.snapshots, input.snapshotId);
    guardWritablePath(guardRoot, path.join(mirrorSnapshotDir, 'x'));
    try {
      fs.mkdirSync(mirrorSnapshotDir, { recursive: true });
    } catch (error) {
      throw fail(`could not create ${mirrorSnapshotDir}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
    }
    for (const name of SNAPSHOT_FILES) {
      const bytes = readIfExists(path.join(snapshot.dir, name));
      if (bytes === null) throw fail(`the primary snapshot has no ${name} under ${snapshot.dir}`);
      const mirrorFile = path.join(mirrorSnapshotDir, name);
      guardWritablePath(guardRoot, mirrorFile);
      const existing = readIfExists(mirrorFile);
      if (sameBytes(existing, bytes)) {
        skipped.files += 1;
        skipped.bytes += bytes.length;
        continue;
      }
      try {
        writeFileAtomic(mirrorFile, bytes);
      } catch (error) {
        throw fail(`writing ${mirrorFile}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      }
      copied.files += 1;
      copied.bytes += bytes.length;
      if (existing !== null) copied.repaired += 1;
    }

    // (d) Repository metadata. `backup.json` is what lets `openRepo(mirror)` report `initialized: true`, and the
    // root `keys.json` holds the authoritative wrapped-DEK envelopes; without both, the objects and manifests on
    // the mirror would be unreadable and the "offsite backup" would not restore. They are compared byte for byte
    // and rewritten when damaged (a name-only "already present" would keep a corrupt descriptor forever).
    let descriptorCopied = false;
    for (const [name, source] of [['backup.json', primaryPaths.descriptor], [REPO_KEYS_FILE, path.join(root, REPO_KEYS_FILE)]]) {
      const bytes = readIfExists(source);
      if (bytes === null) throw fail(`the primary repository has no ${name}, so the mirror would not open as a repository`);
      const target = path.join(mirror, name);
      guardWritablePath(guardRoot, target);
      const existing = readIfExists(target);
      if (sameBytes(existing, bytes)) {
        skipped.files += 1;
        skipped.bytes += bytes.length;
        continue;
      }
      try {
        writeFileAtomic(target, bytes);
      } catch (error) {
        throw fail(`writing ${target}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      }
      copied.files += 1;
      copied.bytes += bytes.length;
      if (existing !== null) copied.repaired += 1;
      if (name === 'backup.json') descriptorCopied = true;
    }

    // (e) The index line, appended only when the mirror does not already name the snapshot. `index.jsonl` is
    // append-only: a plain append of one complete line is safe (a crash leaves a torn final line, which
    // `readIndex` reports honestly and excludes from `entries`), and the id check makes a repeated sync a no-op.
    // The torn line itself is not rewritten: it may be the beginning of this snapshot's own append, in which case
    // completing the line (separated by a newline, so nothing is glued) records the snapshot exactly once and
    // leaves the torn fragment to be reported as a problem, never as a duplicate entry.
    let indexAppended = false;
    const mirrorIndex = readIndex(mirror);
    if (!mirrorIndex.entries.some((entry) => entry.snapshot_id === input.snapshotId)) {
      const primaryIndex = readIndex(root);
      const entry = primaryIndex.entries.find((row) => row.snapshot_id === input.snapshotId);
      if (entry === undefined) throw fail(`the primary index has no entry for ${input.snapshotId}; refusing to append a line the mirror cannot verify`);
      let line;
      try {
        line = serializeIndexEntry(entry);
      } catch (error) {
        throw fail(`the primary index entry for ${input.snapshotId} is invalid: ${error?.detail ?? (error instanceof Error ? error.message : String(error))}`);
      }
      let separator = '';
      const existing = readIfExists(mirrorPaths.index);
      if (existing !== null && existing.length > 0) {
        const text = existing.toString('utf8');
        if (!text.endsWith('\n')) separator = '\n';
      }
      guardWritablePath(guardRoot, mirrorPaths.index);
      try {
        fs.mkdirSync(path.dirname(mirrorPaths.index), { recursive: true });
        fs.appendFileSync(mirrorPaths.index, `${separator}${line}`, 'utf8');
      } catch (error) {
        throw fail(`appending to ${mirrorPaths.index}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      }
      indexAppended = true;
    }

    // (f) The whole `old/` version tree: records and their sealed whole-file copies. It is supplemental to the
    // snapshot (nothing here is needed by `openRepo(mirror)` or `rebuildFile`), so it runs last; but a mirror that
    // could not hand back a superseded version would not be a disaster copy of the version history. The tree is
    // never pruned here: a mirror is additive, and `old/` keeps growing until the operator's `gc` prunes the
    // primary (§24.3) is an honest property of the feature, not something this loop is allowed to guess around.
    const oldTree = listPrimaryOldFiles(root);
    if (oldTree.ok !== true) throw fail(oldTree.detail);
    for (const row of oldTree.files) {
      const mirrorFile = path.join(mirror, 'old', ...row.rel);
      // Before the directory is created: a junction placed inside mirror/old between the root check and this write
      // must refuse the copy rather than redirect it outside the mirror.
      guardWritablePath(guardRoot, mirrorFile);
      const existingSize = sizeIfFile(mirrorFile);
      const isRecord = row.rel[row.rel.length - 1].endsWith('.json');
      if (isRecord) {
        // Small: compare the bytes, so a same-length corruption of a record is repaired too.
        const bytes = readIfExists(row.file);
        if (bytes === null) throw fail(`the primary old/ record ${row.file} is unreadable`);
        if (sameBytes(readIfExists(mirrorFile), bytes)) {
          skipped.old_files += 1;
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(mirrorFile), { recursive: true });
          writeFileAtomic(mirrorFile, bytes);
        } catch (error) {
          throw fail(`writing ${mirrorFile}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
        }
        copied.old_files += 1;
        copied.old_bytes += bytes.length;
        if (existingSize !== null) copied.repaired += 1;
        continue;
      }
      // A sealed whole-file copy is ciphertext and this module never holds the DEK, so byte length is the cheap
      // integrity check (exactly the rule applied to object blocks): an intact copy is skipped, a truncated one is
      // rewritten. A same-length corruption is reported by `verify` (which decrypts it) or by a restore.
      const sourceSize = sizeIfFile(row.file);
      if (sourceSize === null) throw fail(`the primary old/ copy ${row.file} is unreadable`);
      if (existingSize === sourceSize) {
        skipped.old_files += 1;
        continue;
      }
      const sealed = readIfExists(row.file);
      if (sealed === null) throw fail(`the primary old/ copy ${row.file} is unreadable`);
      try {
        fs.mkdirSync(path.dirname(mirrorFile), { recursive: true });
        writeFileAtomic(mirrorFile, sealed);
      } catch (error) {
        throw fail(`writing ${mirrorFile}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      }
      copied.old_files += 1;
      copied.old_bytes += sealed.length;
      if (existingSize !== null) copied.repaired += 1;
    }

    return { ok: true, root: mirror, copied, skipped, index_appended: indexAppended, descriptor_copied: descriptorCopied };
  } catch (error) {
    if (error instanceof MirrorError) throw error;
    throw new MirrorError(MIRROR_CODES.FAILED, `${mirror}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`, {
      copied: { ...copied },
    });
  }
}
