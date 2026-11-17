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
 * have.
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
 *
 * ## Idempotent by construction
 *
 * Every write is skipped when the destination already has the same content (objects by content address, snapshot
 * and metadata files by byte comparison, the index by snapshot id). Syncing the same snapshot twice copies
 * nothing the second time, so a scheduled mirror costs the size of the new session versions, not the size of the
 * repository.
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

/** Size of an existing file, or 0 when it cannot be read. */
function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
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
 *   * the mirror path exists and is a file, not a directory -- a write into it can only fail after blocks were
 *     already copied, and the failure would look like a broken mirror rather than a wrong path.
 *
 * Containment is decided on resolved paths with `path.relative`, never by string prefix: `D:\BackUP2` is not
 * inside `D:\BackUP`. A path on another drive has no relative form, so `path.relative` returns an absolute path
 * and that is treated as "outside" -- cross-drive is exactly what a mirror is for, not an error.
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
  const relativeToRepo = path.relative(repo, mirror);
  const insideRepo = relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo));
  if (insideRepo) {
    return relativeToRepo === ''
      ? invalid(`${mirror} is the repository root itself; a mirror must be a separate location from the repository it copies`)
      : invalid(`${mirror} is inside the repository root (${repo}); a mirror copied into the repository would be captured by its own next run`);
  }
  const home = typeof input.dshHome === 'string' && input.dshHome.trim() !== '' ? path.resolve(input.dshHome.trim()) : null;
  if (home !== null) {
    const relativeToHome = path.relative(home, mirror);
    if (relativeToHome === '' || (!relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome))) {
      return invalid(`${mirror} is inside (or is) the DSH home being backed up (${home}); the offsite copy must not live in the tree the primary backup scans`);
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
 * Copy one committed snapshot to the mirror.
 *
 * The steps run in dependency order: objects first (a manifest names them), then the snapshot's own files, then
 * the repository metadata that makes the mirror openable, then the index line that records the commit. An
 * interrupted copy therefore never leaves an index line pointing at a snapshot whose blocks are absent; it
 * leaves extra objects and, at worst, a snapshot directory the index does not name yet, which the next sync of
 * the same snapshot completes.
 *
 * Failures throw a {@link MirrorError}: `BACKUP_MIRROR_INVALID` when the location is refused, and
 * `BACKUP_MIRROR_FAILED` (with `copied` carrying the partial counts) when a read or write fails. The engine
 * treats both as a warning on a committed backup -- the primary is never rolled back because a copy failed.
 *
 * @param {{root: string, mirrorRoot: string, dshHome?: string|null, snapshotId: string, now?: Date}} input
 * @returns {{ok: true, root: string,
 *   copied: {files: number, bytes: number}, skipped: {files: number, bytes: number},
 *   index_appended: boolean, descriptor_copied: boolean}}
 * @throws {MirrorError}
 */
export function syncToMirror(input) {
  const resolved = resolveMirrorRoot({ repoRoot: input.root, dshHome: input.dshHome, mirrorRoot: input.mirrorRoot });
  if (resolved.ok !== true) throw new MirrorError(MIRROR_CODES.INVALID, resolved.detail);
  const root = path.resolve(input.root);
  const mirror = resolved.root;
  const primaryPaths = repoPaths(root);
  const mirrorPaths = repoPaths(mirror);
  const copied = { files: 0, bytes: 0 };
  const skipped = { files: 0, bytes: 0 };
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

    // (b) Objects, deduplicated by content address. A block is copied only when the mirror does not already have
    // a file at that address; the sealed bytes are copied verbatim because decrypting here would create a
    // plaintext copy in memory for no reason.
    const blockShas = new Set();
    for (const file of snapshot.manifest.files) for (const block of file.blocks ?? []) blockShas.add(block.sha256);
    for (const sha256 of blockShas) {
      const mirrorObject = path.join(mirrorPaths.objects, sha256.slice(0, 2), sha256);
      let present = false;
      try {
        present = fs.statSync(mirrorObject).isFile();
      } catch {
        present = false;
      }
      if (present) {
        skipped.files += 1;
        skipped.bytes += fileSize(mirrorObject);
        continue;
      }
      const sealed = readIfExists(path.join(primaryPaths.objects, sha256.slice(0, 2), sha256));
      if (sealed === null) throw fail(`the primary repository has no sealed block ${sha256}, so the mirror copy would be incomplete`);
      try {
        writeFileAtomic(mirrorObject, sealed);
      } catch (error) {
        throw fail(`writing ${mirrorObject}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      }
      copied.files += 1;
      copied.bytes += sealed.length;
    }

    // (c) The snapshot's own two files: the encrypted manifest and the wrapped-key envelopes. Byte-identical
    // copies are skipped, so a re-sync does not rewrite files it already has.
    const mirrorSnapshotDir = path.join(mirrorPaths.snapshots, input.snapshotId);
    try {
      fs.mkdirSync(mirrorSnapshotDir, { recursive: true });
    } catch (error) {
      throw fail(`could not create ${mirrorSnapshotDir}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
    }
    for (const name of SNAPSHOT_FILES) {
      const bytes = readIfExists(path.join(snapshot.dir, name));
      if (bytes === null) throw fail(`the primary snapshot has no ${name} under ${snapshot.dir}`);
      const mirrorFile = path.join(mirrorSnapshotDir, name);
      if (sameBytes(readIfExists(mirrorFile), bytes)) {
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
    }

    // (d) Repository metadata, copied only when missing. `backup.json` is what lets `openRepo(mirror)` report
    // `initialized: true`, and the root `keys.json` holds the authoritative wrapped-DEK envelopes; without both,
    // the objects and manifests on the mirror would be unreadable and the "offsite backup" would not restore.
    let descriptorCopied = false;
    for (const [name, source] of [['backup.json', primaryPaths.descriptor], [REPO_KEYS_FILE, path.join(root, REPO_KEYS_FILE)]]) {
      const bytes = readIfExists(source);
      if (bytes === null) throw fail(`the primary repository has no ${name}, so the mirror would not open as a repository`);
      const target = path.join(mirror, name);
      if (fs.existsSync(target)) {
        skipped.files += 1;
        skipped.bytes += fileSize(target);
        continue;
      }
      try {
        writeFileAtomic(target, bytes);
      } catch (error) {
        throw fail(`writing ${target}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      }
      copied.files += 1;
      copied.bytes += bytes.length;
      if (name === 'backup.json') descriptorCopied = true;
    }

    // (e) The index line, appended only when the mirror does not already name the snapshot. `index.jsonl` is
    // append-only: a plain append of one complete line is safe (a crash leaves a torn final line, which
    // `readIndex` reports honestly), and the id check makes a repeated sync a no-op. A torn tail is not
    // "repaired" here: the mirror may be missing the line that tail was writing, and inventing it would claim a
    // snapshot the mirror's own index never recorded.
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
      try {
        fs.mkdirSync(path.dirname(mirrorPaths.index), { recursive: true });
        fs.appendFileSync(mirrorPaths.index, `${separator}${line}`, 'utf8');
      } catch (error) {
        throw fail(`appending to ${mirrorPaths.index}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      }
      indexAppended = true;
    }

    return { ok: true, root: mirror, copied, skipped, index_appended: indexAppended, descriptor_copied: descriptorCopied };
  } catch (error) {
    if (error instanceof MirrorError) throw error;
    throw new MirrorError(MIRROR_CODES.FAILED, `${mirror}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`, {
      copied: { ...copied },
    });
  }
}
