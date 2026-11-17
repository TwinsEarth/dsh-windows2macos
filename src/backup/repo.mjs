/**
 * The backup repository as a lifecycle: descriptor, snapshots, and the append-only index.
 *
 * ## Where this sits between `layout` and the engine
 *
 * `layout.mjs` answers "where is the repository and is it safe to create". `repo.mjs` answers "what is in it":
 * which snapshots exist, what the index says, and how a snapshot is committed. The v3.4.7 engine then only has
 * to decide *what to back up*; the repository protocol -- snapshot ids, the two files a snapshot owns, the
 * index line's exact shape -- is frozen here, in one place, with the strict validation to prove it.
 *
 * ## The two files a snapshot owns
 *
 *   snapshots/<id>/manifest.json   paths + hashes + blocks (see `manifest.mjs`)
 *   snapshots/<id>/keys.json       the wrapped DEK envelopes (see `crypto.mjs`)
 *
 * A half-written snapshot is a directory without both files, which is why a snapshot is staged in `tmp/` and
 * renamed into place only when both files are written. A reader therefore never sees a snapshot directory that
 * exists but cannot be opened, except after a crash between the rename and the index append -- and that case is
 * exactly what a torn index line and a missing index entry report.
 *
 * ## The index is append-only, and its last line may be torn
 *
 * `index.jsonl` is one JSON object per line and a crash can leave the final line incomplete. `readIndex`
 * therefore reports a torn tail instead of rejecting the file, and refuses to invent the missing entry. That is
 * the difference between "the index lost its newest line, the snapshot is still on disk and can be re-indexed"
 * and "the index is corrupt, give up".
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  LAYOUT_CODES,
  REPO_VERSION,
  inspectLayout,
  readDescriptor,
  repoPaths,
  validateDescriptor,
} from './layout.mjs';
import {
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  canonicalJson,
  manifestDigest,
  manifestSummary,
  readManifest,
  validateManifest,
} from './manifest.mjs';
import { validateKeysFile } from './crypto.mjs';

/** Format string of one `index.jsonl` line. */
export const INDEX_FORMAT = 'w2m-session-backup/index';

/** Version of an index line. Frozen by `test/backup-repo.test.mjs`. */
export const INDEX_VERSION = 1;

/** Keys of an index line, exactly. Nothing here identifies a session path: the index is counts and ids. */
export const INDEX_KEYS = Object.freeze([
  'format',
  'version',
  'snapshot_id',
  'created_at',
  'files',
  'bytes',
  'blocks',
  'sessions',
  'attachments',
  'digest',
]);

/** Snapshot ids this module mints: `YYYYMMDDTHHMMSSZ-<8 hex>`, so lexicographic order is chronological. */
export const SNAPSHOT_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** Named repository failure codes. A caller matches on these, never on a message. */
export const REPO_CODES = Object.freeze({
  NOT_INITIALIZED: 'BACKUP_REPO_NOT_INITIALIZED',
  ID_INVALID: 'BACKUP_REPO_SNAPSHOT_ID_INVALID',
  SNAPSHOT_EXISTS: 'BACKUP_REPO_SNAPSHOT_EXISTS',
  SNAPSHOT_INVALID: 'BACKUP_REPO_SNAPSHOT_INVALID',
  SNAPSHOT_MISSING: 'BACKUP_REPO_SNAPSHOT_MISSING',
  INDEX_LINE_INVALID: 'BACKUP_REPO_INDEX_LINE_INVALID',
  WRITE_FAILED: 'BACKUP_REPO_WRITE_FAILED',
});

/** A repository protocol failure with a stable code. */
export class BackupRepoError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'BackupRepoError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }

  toRefusal() {
    return { ok: false, reason_code: this.code, detail: this.detail };
  }
}

/**
 * Mint a snapshot id from a timestamp and 8 hex characters of entropy.
 *
 * The timestamp makes the id sortable (so "latest" is the last line, not a scan), and the entropy keeps two
 * backups in the same second from colliding -- a retry after a failed commit must be able to produce a fresh
 * id without sleeping for a clock tick.
 *
 * @param {Date} [now]
 * @param {string} [entropy] 8 lowercase hex characters; injected by tests
 * @returns {string}
 */
export function makeSnapshotId(now = new Date(), entropy = randomBytes(4).toString('hex')) {
  const compact = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = `${compact}-${String(entropy).toLowerCase()}`;
  if (!SNAPSHOT_ID_RE.test(id)) {
    throw new BackupRepoError(REPO_CODES.ID_INVALID, `generated snapshot id ${JSON.stringify(id)} does not match the frozen shape`);
  }
  return id;
}

/**
 * The paths a snapshot owns.
 *
 * @param {ReturnType<typeof repoPaths>} paths
 * @param {string} snapshotId
 * @returns {{dir: string, manifest: string, keys: string}}
 */
export function snapshotPaths(paths, snapshotId) {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_RE.test(snapshotId)) {
    throw new BackupRepoError(REPO_CODES.ID_INVALID, `snapshot id ${JSON.stringify(String(snapshotId))} does not match ${SNAPSHOT_ID_RE}`);
  }
  const dir = path.join(paths.snapshots, snapshotId);
  return { dir, manifest: path.join(dir, 'manifest.json'), keys: path.join(dir, 'keys.json') };
}

/**
 * Validate one parsed index line.
 *
 * @param {unknown} entry
 * @returns {{ok: true} | {ok: false, detail: string}}
 */
export function validateIndexEntry(entry) {
  const bad = (detail) => ({ ok: false, detail });
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return bad('the line is not an object');
  for (const key of INDEX_KEYS) if (!(key in entry)) return bad(`missing key ${key}`);
  for (const key of Object.keys(entry)) if (!INDEX_KEYS.includes(key)) return bad(`unknown key ${key}`);
  if (entry.format !== INDEX_FORMAT) return bad(`format is ${JSON.stringify(entry.format)}, not ${INDEX_FORMAT}`);
  if (entry.version !== INDEX_VERSION) return bad(`version is ${JSON.stringify(entry.version)}, not ${INDEX_VERSION}`);
  if (typeof entry.snapshot_id !== 'string' || !SNAPSHOT_ID_RE.test(entry.snapshot_id)) return bad('snapshot_id is not a repository snapshot id');
  if (typeof entry.created_at !== 'string' || Number.isNaN(Date.parse(entry.created_at))) return bad('created_at is not a date');
  for (const key of ['files', 'bytes', 'blocks', 'sessions', 'attachments']) {
    if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) return bad(`${key} is not a non-negative integer`);
  }
  if (typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.digest)) return bad('digest is not a sha256 hex string');
  return { ok: true };
}

/**
 * Read `index.jsonl` **without writing it**.
 *
 * Never throws for a bad line: a parse error or an unknown key is reported as a `problem` with its line number,
 * and the remaining lines are still read. The caller decides whether a problem is fatal; `status` shows it,
 * `verify` (v3.4.8) refuses.
 *
 * @param {string} root
 * @returns {{ok: boolean, file: string, entries: Array<object>, problems: Array<{line: number, code: string, detail: string}>, torn_tail: boolean, exists: boolean}}
 */
export function readIndex(root) {
  const file = repoPaths(root).index;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, file, entries: [], problems: [], torn_tail: false, exists: false };
    }
    return {
      ok: false,
      file,
      entries: [],
      problems: [{ line: 0, code: REPO_CODES.INDEX_LINE_INVALID, detail: `could not read ${file}: ${error?.code ?? 'unknown'}` }],
      torn_tail: false,
      exists: false,
    };
  }
  const entries = [];
  const problems = [];
  const lines = text.split('\n');
  let lastLineIndex = -1;
  for (let index = 0; index < lines.length; index += 1) if (lines[index].trim() !== '') lastLineIndex = index;
  const tornTail = text.length > 0 && !text.endsWith('\n') && lastLineIndex === lines.length - 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (tornTail && index === lastLineIndex) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      problems.push({ line: index + 1, code: REPO_CODES.INDEX_LINE_INVALID, detail: `not JSON: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const verdict = validateIndexEntry(parsed);
    if (!verdict.ok) {
      problems.push({ line: index + 1, code: REPO_CODES.INDEX_LINE_INVALID, detail: verdict.detail });
      continue;
    }
    entries.push(parsed);
  }
  return { ok: problems.length === 0, file, entries, problems, torn_tail: tornTail, exists: true };
}

/**
 * Build the index line for a validated manifest.
 *
 * Counts only -- no `rel`, no workspace, no session id. The index answers "how much, when, which digest", and
 * a reader that needs paths opens the snapshot's manifest. That split is what lets `status` be read on an
 * unlocked machine without touching file names.
 *
 * @param {object} manifest
 * @returns {object}
 */
export function indexEntry(manifest) {
  const verdict = validateManifest(manifest);
  if (!verdict.ok) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_INVALID, `the manifest is not a v1 manifest: ${verdict.errors.map((error) => `${error.code}@${error.path}`).join(', ')}`);
  }
  const summary = manifestSummary(manifest);
  return {
    format: INDEX_FORMAT,
    version: INDEX_VERSION,
    snapshot_id: manifest.snapshot_id,
    created_at: manifest.created_at,
    files: summary.files,
    bytes: manifest.counts.bytes,
    blocks: summary.blocks,
    sessions: summary.sessions,
    attachments: summary.attachments,
    digest: summary.digest,
  };
}

/** Serialise one index line, canonical JSON plus the newline the append format requires. */
export function serializeIndexEntry(entry) {
  const verdict = validateIndexEntry(entry);
  if (!verdict.ok) throw new BackupRepoError(REPO_CODES.INDEX_LINE_INVALID, verdict.detail);
  return `${canonicalJson(entry)}\n`;
}

/**
 * Append one entry to the index and read it back.
 *
 * The read-back is not ceremony: the index is the only record that a snapshot was committed, and a partial
 * append (full disk, crash) must be *detected at commit time*, not discovered during a restore. Verification is
 * on by default for that reason; the engine may pass `{verify: false}` only when it immediately reads the whole
 * index anyway.
 *
 * @param {{root: string, entry: object, verify?: boolean}} input
 * @returns {{appended: true, file: string, line: string}}
 */
export function appendIndex(input) {
  const line = serializeIndexEntry(input.entry);
  const file = repoPaths(input.root).index;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, 'utf8');
  } catch (error) {
    throw new BackupRepoError(REPO_CODES.WRITE_FAILED, `${file}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
  }
  if (input.verify === false) return { appended: true, file, line };
  const index = readIndex(input.root);
  const last = index.entries[index.entries.length - 1];
  if (last === undefined || last.snapshot_id !== input.entry.snapshot_id || last.digest !== input.entry.digest) {
    throw new BackupRepoError(
      REPO_CODES.INDEX_LINE_INVALID,
      `the appended line for ${input.entry.snapshot_id} was not readable back${index.problems.length > 0 ? `: ${index.problems.map((problem) => problem.detail).join('; ')}` : ''}`,
    );
  }
  return { appended: true, file, line };
}

/**
 * Read one committed snapshot: manifest and key envelopes, both strictly validated.
 *
 * @param {{root: string, snapshotId: string}} input
 * @returns {{snapshot_id: string, dir: string, manifest: object, keys: object, digest: string}}
 */
export function readSnapshot(input) {
  const paths = repoPaths(input.root);
  const snapshot = snapshotPaths(paths, input.snapshotId);
  let manifestText;
  let keysText;
  try {
    manifestText = fs.readFileSync(snapshot.manifest, 'utf8');
  } catch (error) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_MISSING, `${snapshot.manifest}: ${error?.code ?? 'unreadable'}`);
  }
  try {
    keysText = fs.readFileSync(snapshot.keys, 'utf8');
  } catch (error) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_MISSING, `${snapshot.keys}: ${error?.code ?? 'unreadable'}`);
  }
  const parsed = readManifest(manifestText);
  if (!parsed.ok) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_INVALID, `manifest: ${parsed.errors.map((error) => `${error.code}@${error.path}`).join(', ')}`);
  }
  if (parsed.manifest.snapshot_id !== input.snapshotId) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_INVALID, `manifest names snapshot ${parsed.manifest.snapshot_id}, not ${input.snapshotId}`);
  }
  let keys;
  try {
    keys = JSON.parse(keysText);
  } catch (error) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_INVALID, `keys.json is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    validateKeysFile(keys);
  } catch (error) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_INVALID, `keys.json: ${error?.detail ?? String(error?.message ?? error)}`);
  }
  return {
    snapshot_id: input.snapshotId,
    dir: snapshot.dir,
    manifest: parsed.manifest,
    keys,
    digest: manifestDigest(parsed.manifest),
  };
}

/**
 * List the snapshot directories on disk, newest id first.
 *
 * `full: true` reads and validates every snapshot; the default validates only the newest one, because `status`
 * must stay cheap on a repository with a year of daily snapshots.
 *
 * @param {string} root
 * @param {{full?: boolean}} [options]
 * @returns {Array<{snapshot_id: string, valid: boolean|null, digest: string|null, manifest: object|null, detail: string|null}>}
 */
export function listSnapshots(root, options = {}) {
  const paths = repoPaths(root);
  let names;
  try {
    names = fs.readdirSync(paths.snapshots, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const ids = names.filter((name) => SNAPSHOT_ID_RE.test(name)).sort().reverse();
  const rows = [];
  for (const [index, snapshotId] of ids.entries()) {
    const check = options.full === true || index === 0;
    if (!check) {
      rows.push({ snapshot_id: snapshotId, valid: null, digest: null, manifest: null, detail: null });
      continue;
    }
    try {
      const snapshot = readSnapshot({ root, snapshotId });
      rows.push({
        snapshot_id: snapshotId,
        valid: true,
        digest: snapshot.digest,
        manifest: manifestSummary(snapshot.manifest),
        detail: null,
      });
    } catch (error) {
      rows.push({ snapshot_id: snapshotId, valid: false, digest: null, manifest: null, detail: error?.detail ?? String(error?.message ?? error) });
    }
  }
  return rows;
}

/**
 * Commit a snapshot: stage both files in `tmp/`, rename the directory into place, append the index.
 *
 * This is the only write path in v3.4.6, and it is exercised only by tests and (from v3.4.7) the engine. The
 * routes and the CLI never call it. It refuses to overwrite an existing snapshot id: a retry after a crash must
 * mint a new id rather than silently replace history.
 *
 * @param {{root: string, manifest: object, keys: object, verifyIndex?: boolean}} input
 * @returns {{snapshot_id: string, dir: string, digest: string, index_entry: object, index_file: string}}
 */
export function commitSnapshot(input) {
  const paths = repoPaths(input.root);
  const descriptor = readDescriptor(input.root);
  if (descriptor === null) {
    throw new BackupRepoError(REPO_CODES.NOT_INITIALIZED, `${paths.root} has no ${'backup.json'}; call ensureLayout first`);
  }
  const validatedDescriptor = validateDescriptor(descriptor);
  if (!validatedDescriptor.ok) throw validatedDescriptor.error;

  const verdict = validateManifest(input.manifest);
  if (!verdict.ok) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_INVALID, `manifest: ${verdict.errors.map((error) => `${error.code}@${error.path}`).join(', ')}`);
  }
  try {
    validateKeysFile(input.keys);
  } catch (error) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_INVALID, `keys.json: ${error?.detail ?? String(error?.message ?? error)}`);
  }

  const snapshotId = input.manifest.snapshot_id;
  const target = snapshotPaths(paths, snapshotId);
  if (fs.existsSync(target.dir)) {
    throw new BackupRepoError(REPO_CODES.SNAPSHOT_EXISTS, `${target.dir} already exists; a retry must mint a new snapshot id`);
  }

  const staging = path.join(paths.tmp, `snapshot-${snapshotId}-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(input.manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(staging, 'keys.json'), `${JSON.stringify(input.keys, null, 2)}\n`, 'utf8');
    fs.renameSync(staging, target.dir);
  } catch (error) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* the failure being reported is the write, not the cleanup */
    }
    throw new BackupRepoError(
      REPO_CODES.WRITE_FAILED,
      `${target.dir}: ${error?.code ?? (error instanceof Error ? error.message : String(error))}`,
    );
  }

  const entry = indexEntry(input.manifest);
  const appended = appendIndex({ root: input.root, entry, verify: input.verifyIndex !== false });
  return {
    snapshot_id: snapshotId,
    dir: target.dir,
    digest: entry.digest,
    index_entry: entry,
    index_file: appended.file,
  };
}

/**
 * Open a repository **read-only**: the state a status card or a CLI prints.
 *
 * Never creates and never repairs. An absent or uninitialised directory is reported as a state with
 * `initialized: false`, not as an error -- the first backup is the thing that creates the repository, and a
 * status check must not be able to create it by accident.
 *
 * @param {{root: string, dshHome?: string|null, full?: boolean}} input
 * @returns {{
 *   ok: boolean, root: string, initialized: boolean, dsh_home: string|null,
 *   layout: object, descriptor: object|null,
 *   index: {file: string, entries: number, problems: number, torn_tail: boolean, exists: boolean, latest_digest: string|null},
 *   snapshots: Array<object>, latest: object|null, error: {code: string, detail: string}|null
 * }}
 */
export function openRepo(input) {
  const root = path.resolve(input.root);
  const layout = inspectLayout(root, { dshHome: input.dshHome ?? null });
  const state = {
    ok: layout.error === null,
    root,
    initialized: false,
    dsh_home: typeof input.dshHome === 'string' && input.dshHome !== '' ? path.resolve(input.dshHome) : null,
    layout,
    descriptor: null,
    index: { file: repoPaths(root).index, entries: 0, problems: 0, torn_tail: false, exists: false, latest_digest: null },
    snapshots: [],
    latest: null,
    error: layout.error,
  };
  if (layout.error !== null) return state;

  const descriptor = readDescriptor(root);
  if (descriptor === null) return state;
  const validated = validateDescriptor(descriptor);
  if (!validated.ok) {
    return { ...state, ok: false, error: { code: validated.error.code, detail: validated.error.detail } };
  }
  state.initialized = true;
  state.descriptor = descriptor;

  const index = readIndex(root);
  state.index = {
    file: index.file,
    entries: index.entries.length,
    problems: index.problems.length,
    torn_tail: index.torn_tail,
    exists: index.exists,
    latest_digest: index.entries.length > 0 ? index.entries[index.entries.length - 1].digest : null,
  };
  if (index.problems.length > 0) {
    state.ok = false;
    state.error = { code: REPO_CODES.INDEX_LINE_INVALID, detail: index.problems.map((problem) => `line ${problem.line}: ${problem.detail}`).join('; ') };
  }
  state.snapshots = listSnapshots(root, { full: input.full === true });
  state.latest = state.snapshots.find((row) => row.valid === true) ?? state.snapshots[0] ?? null;
  return state;
}

/** `REPO_VERSION` is re-exported for callers that print it beside a snapshot. */
export { REPO_VERSION, MANIFEST_FORMAT, MANIFEST_VERSION, LAYOUT_CODES };
