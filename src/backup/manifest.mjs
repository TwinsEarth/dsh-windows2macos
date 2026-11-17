/**
 * The backup manifest: schema v1, frozen by `test/backup-protocol.test.mjs`.
 *
 * ## Why the schema is frozen before anything writes one
 *
 * A repository outlives the build that made it. The sessions in it are the user's primary record, and the
 * manifest is the only thing that says which blocks belong to which file -- so a field that changes meaning
 * between versions is a silent data-loss bug that shows up a year later, during a restore. v3.4.6 therefore
 * publishes the exact field list, refuses unknown keys in both directions, and pins the block size and hash
 * algorithm as *data in the manifest* rather than as constants the reader re-derives.
 *
 * ## The three invariants, and why each is checked rather than assumed
 *
 *   1. **Blocks tile the file.** Every block has `index`, `offset`, `length`, `sha256`; the offsets are
 *      contiguous from 0 and the lengths sum to `size`. An index/offset gap is how "restore produced a file
 *      that opens but is subtly short" happens.
 *   2. **Paths are POSIX-relative and unique.** A restore joins `rel` onto a directory; `..`, a drive letter,
 *      or a backslash is a write outside the target. Case-insensitive duplicates are refused because the
 *      destination filesystem usually is.
 *   3. **Counts are derived, not trusted.** `counts.*` must equal what the `files` array measures, so a
 *      manifest cannot advertise 14 sessions while listing 13.
 *
 * ## What is NOT here
 *
 * No encryption and no filesystem layout: `crypto.mjs` seals a payload, `layout.mjs` says where files go.
 * This module owns the plaintext structure only, which is what makes it testable without a key.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The `format` string of a manifest. A new value is a new protocol, not a new version. */
export const MANIFEST_FORMAT = 'w2m-session-backup/manifest';

/** The only manifest version this build writes and reads. */
export const MANIFEST_VERSION = 1;

/** Block size, in bytes. Part of the protocol: a reader must not guess it. */
export const BLOCK_SIZE = 4 * 1024 * 1024;

/** Block digest algorithm. `sha256` is the only one v1 accepts. */
export const BLOCK_ALGO = 'sha256';

/** Cipher name recorded in the manifest; `crypto.mjs` is the implementation. */
export const MANIFEST_CIPHER = 'aes-256-gcm';

/** Top-level keys of a v1 manifest, exactly. Unknown keys are refused (a typo must not be silently ignored). */
export const MANIFEST_KEYS = Object.freeze([
  'format',
  'version',
  'snapshot_id',
  'created_at',
  'dsh_home',
  'block_size',
  'block_algo',
  'cipher',
  'counts',
  'files',
  'registry',
  'exclusions',
]);

/** Required keys of every file entry. */
export const FILE_KEYS = Object.freeze(['rel', 'kind', 'size', 'mtime_ms', 'sha256', 'blocks']);

/** Keys a session entry additionally carries. */
export const SESSION_KEYS = Object.freeze(['session_id', 'workspace', 'format_version', 'flags']);

/** Keys an attachment entry additionally carries. */
export const ATTACHMENT_KEYS = Object.freeze(['attachment_id']);

/** Required keys of a block entry. */
export const BLOCK_KEYS = Object.freeze(['index', 'offset', 'length', 'sha256']);

/** Counts a manifest must carry, all derived from `files`. */
export const COUNT_KEYS = Object.freeze(['files', 'bytes', 'blocks', 'block_bytes', 'sessions', 'attachments']);

/** Registry counts carried alongside the files. */
export const REGISTRY_KEYS = Object.freeze(['workspaces', 'registered', 'archived', 'pinned']);

/** Named manifest failure codes. */
export const MANIFEST_CODES = Object.freeze({
  SHAPE: 'MANIFEST_SHAPE',
  KEY_UNKNOWN: 'MANIFEST_KEY_UNKNOWN',
  KEY_MISSING: 'MANIFEST_KEY_MISSING',
  TYPE: 'MANIFEST_TYPE',
  VALUE: 'MANIFEST_VALUE',
  SHA256: 'MANIFEST_SHA256',
  REL_PATH: 'MANIFEST_REL_PATH',
  REL_DUPLICATE: 'MANIFEST_REL_DUPLICATE',
  BLOCK_GAP: 'MANIFEST_BLOCK_GAP',
  SIZE_MISMATCH: 'MANIFEST_SIZE_MISMATCH',
  COUNT_MISMATCH: 'MANIFEST_COUNT_MISMATCH',
  KIND: 'MANIFEST_KIND',
  VERSION_UNSUPPORTED: 'MANIFEST_VERSION_UNSUPPORTED',
  IO: 'MANIFEST_IO',
});

/** A manifest failure with a stable code. */
export class ManifestError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'ManifestError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Lowercase hex SHA-256 of a buffer. */
export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Normalise a repository-relative path to the one form the protocol allows.
 *
 * Accepts either separator and returns forward slashes; refuses anything that could escape the restore target
 * or that compares differently on Windows (`C:\x`, `\\server\share`, `..`, a leading slash, an empty segment).
 *
 * @param {string} rel
 * @returns {string}
 * @throws {ManifestError} `MANIFEST_REL_PATH`
 */
export function normalizeRelPath(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new ManifestError(MANIFEST_CODES.REL_PATH, 'a relative path must be a non-empty string');
  }
  if (rel.includes('\0')) throw new ManifestError(MANIFEST_CODES.REL_PATH, 'a relative path must not contain NUL');
  if (path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new ManifestError(MANIFEST_CODES.REL_PATH, `absolute path is not allowed: ${rel}`);
  }
  if (rel.startsWith('\\\\') || rel.startsWith('//')) {
    throw new ManifestError(MANIFEST_CODES.REL_PATH, `UNC path is not allowed: ${rel}`);
  }
  // Split on a SINGLE separator so `a//b` keeps an empty segment and is refused: quietly collapsing double
  // separators would make two different strings normalise to one path, which is the kind of leniency a
  // restore should not have.
  const segments = rel.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ManifestError(MANIFEST_CODES.REL_PATH, `path has an empty, '.' or '..' segment: ${rel}`);
    }
  }
  return segments.join('/');
}

/**
 * Canonical JSON: sorted keys, no whitespace, no `undefined`.
 *
 * The digest of a manifest must not depend on property insertion order or a printer's newline choices, or two
 * readers of the same snapshot would compute two different digests.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {ManifestError} `MANIFEST_TYPE` for values JSON cannot represent unambiguously
 */
export function canonicalJson(value) {
  const encode = (node, where) => {
    if (node === null) return 'null';
    const type = typeof node;
    if (type === 'boolean') return node ? 'true' : 'false';
    if (type === 'number') {
      if (!Number.isFinite(node)) throw new ManifestError(MANIFEST_CODES.TYPE, `non-finite number at ${where}`);
      return JSON.stringify(node);
    }
    if (type === 'string') return JSON.stringify(node);
    if (Array.isArray(node)) return `[${node.map((item, index) => encode(item, `${where}[${index}]`)).join(',')}]`;
    if (type === 'object') {
      const keys = Object.keys(node).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(node[key], `${where}.${key}`)}`).join(',')}}`;
    }
    throw new ManifestError(MANIFEST_CODES.TYPE, `${type} at ${where} is not serialisable`);
  };
  return encode(value, '$');
}

/**
 * Split a buffer into blocks and hash each one.
 *
 * The last block may be shorter than `blockSize`; every other block is exactly `blockSize`. An empty file has
 * zero blocks and a `sha256` of the empty string's digest, which is a valid (if rare) session log shape.
 *
 * @param {Buffer} buffer
 * @param {number} [blockSize]
 * @returns {Array<{index: number, offset: number, length: number, sha256: string}>}
 */
export function splitBlocks(buffer, blockSize = BLOCK_SIZE) {
  if (!Buffer.isBuffer(buffer)) throw new ManifestError(MANIFEST_CODES.TYPE, 'splitBlocks expects a Buffer');
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
    throw new ManifestError(MANIFEST_CODES.VALUE, `block size must be a positive integer, got ${String(blockSize)}`);
  }
  const blocks = [];
  for (let offset = 0, index = 0; offset < buffer.length; offset += blockSize, index += 1) {
    const end = Math.min(offset + blockSize, buffer.length);
    blocks.push({
      index,
      offset,
      length: end - offset,
      sha256: sha256Hex(buffer.subarray(offset, end)),
    });
  }
  return blocks;
}

/**
 * Describe one file the way the manifest records it.
 *
 * Read-only. The hash and the blocks are computed from the same buffer in one pass of the file, so a manifest
 * cannot claim a digest that disagrees with its own blocks.
 *
 * @param {string} file
 * @param {{blockSize?: number}} [options]
 * @returns {{size: number, mtime_ms: number, sha256: string, blocks: Array<object>}}
 */
export function describeFile(file, options = {}) {
  let buffer;
  let stat;
  try {
    buffer = fs.readFileSync(file);
    stat = fs.statSync(file);
  } catch (error) {
    throw new ManifestError(MANIFEST_CODES.IO, `${file}: ${error?.code ?? 'unreadable'}`);
  }
  return {
    size: buffer.length,
    mtime_ms: stat.mtimeMs,
    sha256: sha256Hex(buffer),
    blocks: splitBlocks(buffer, options.blockSize ?? BLOCK_SIZE),
  };
}

/**
 * Build a manifest from scan rows.
 *
 * The caller supplies rows produced by `scan.mjs` (they carry `rel`, `kind`, and the session/attachment
 * identity); this function adds the byte-level description and the derived counts. `rel` lives at the
 * repository root, so a session log's `rel` is `sessions/<workspace>/<session>/session.v4.jsonl.zstd`.
 *
 * @param {{
 *   snapshotId: string,
 *   createdAt?: Date|string,
 *   dshHome: string,
 *   sessions?: Array<object>,
 *   attachments?: Array<object>,
 *   registry?: {workspaces?: number, registered?: number, archived?: number, pinned?: number},
 *   exclusions?: Array<{rel: string, reason: string}>,
 *   blockSize?: number
 * }} input
 * @returns {object} a v1 manifest
 * @throws {ManifestError} on an invalid input row or an unreadable file
 */
export function buildManifest(input) {
  const blockSize = input.blockSize ?? BLOCK_SIZE;
  if (!SNAPSHOT_ID_RE.test(String(input.snapshotId ?? ''))) {
    throw new ManifestError(MANIFEST_CODES.VALUE, `invalid snapshot id: ${String(input.snapshotId)}`);
  }
  const createdAt = input.createdAt instanceof Date
    ? input.createdAt.toISOString()
    : typeof input.createdAt === 'string'
      ? input.createdAt
      : new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new ManifestError(MANIFEST_CODES.VALUE, `createdAt is not a date: ${createdAt}`);
  }
  if (typeof input.dshHome !== 'string' || input.dshHome.trim() === '') {
    throw new ManifestError(MANIFEST_CODES.VALUE, 'dshHome must be a non-empty string');
  }

  const files = [];
  for (const row of input.sessions ?? []) {
    const rel = normalizeRelPath(row.rel);
    // A caller that already read the file (the engine splits it into blocks to write) passes `description`
    // so the bytes are not read twice; a caller that has not (tests, dry tooling) lets this module read them.
    const description = row.description ?? describeFile(row.file, { blockSize });
    files.push({
      rel,
      kind: 'session',
      size: description.size,
      mtime_ms: description.mtime_ms,
      sha256: description.sha256,
      blocks: description.blocks,
      session_id: String(row.session_id ?? ''),
      workspace: String(row.workspace ?? ''),
      format_version: Number.isSafeInteger(row.format_version) ? row.format_version : null,
      flags: {
        registered: row.flags?.registered === true,
        archived: row.flags?.archived === true,
        pinned: row.flags?.pinned === true,
      },
    });
  }
  for (const row of input.attachments ?? []) {
    const rel = normalizeRelPath(row.rel);
    const description = row.description ?? describeFile(row.file, { blockSize });
    files.push({
      rel,
      kind: 'attachment',
      size: description.size,
      mtime_ms: description.mtime_ms,
      sha256: description.sha256,
      blocks: description.blocks,
      attachment_id: String(row.attachment_id ?? ''),
    });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const counts = {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    blocks: files.reduce((sum, file) => sum + file.blocks.length, 0),
    block_bytes: files.reduce((sum, file) => sum + file.blocks.reduce((inner, block) => inner + block.length, 0), 0),
    sessions: files.filter((file) => file.kind === 'session').length,
    attachments: files.filter((file) => file.kind === 'attachment').length,
  };

  const registry = input.registry ?? {};
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    snapshot_id: input.snapshotId,
    created_at: createdAt,
    dsh_home: input.dshHome,
    block_size: blockSize,
    block_algo: BLOCK_ALGO,
    cipher: MANIFEST_CIPHER,
    counts,
    files,
    registry: {
      workspaces: Number.isSafeInteger(registry.workspaces) ? registry.workspaces : 0,
      registered: Number.isSafeInteger(registry.registered) ? registry.registered : 0,
      archived: Number.isSafeInteger(registry.archived) ? registry.archived : 0,
      pinned: Number.isSafeInteger(registry.pinned) ? registry.pinned : 0,
    },
    exclusions: (input.exclusions ?? []).map((entry) => ({ rel: entry.rel, reason: entry.reason })),
  };
}

/**
 * SHA-256 of the manifest's canonical JSON, lowercase hex.
 *
 * @param {object} manifest
 * @returns {string}
 */
export function manifestDigest(manifest) {
  return sha256Hex(Buffer.from(canonicalJson(manifest), 'utf8'));
}

/**
 * Validate a manifest against the v1 schema.
 *
 * Returns every problem with a `path` (JSON pointer style) and a code, rather than throwing on the first one:
 * a restore that is refused should be able to say all the reasons at once. `ok: false` with an empty list
 * cannot happen.
 *
 * @param {unknown} manifest
 * @returns {{ok: boolean, errors: Array<{code: string, path: string, detail: string}>, manifest: object|null}}
 */
export function validateManifest(manifest) {
  const errors = [];
  const fail = (code, at, detail) => errors.push({ code, path: at, detail });
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  if (!isObject(manifest)) {
    fail(MANIFEST_CODES.SHAPE, '$', 'the manifest is not an object');
    return { ok: false, errors, manifest: null };
  }

  for (const key of MANIFEST_KEYS) {
    if (!(key in manifest)) fail(MANIFEST_CODES.KEY_MISSING, `$.${key}`, 'required key is missing');
  }
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key)) fail(MANIFEST_CODES.KEY_UNKNOWN, `$.${key}`, 'unknown key in a v1 manifest');
  }

  if (manifest.format !== MANIFEST_FORMAT) {
    fail(MANIFEST_CODES.VALUE, '$.format', `expected ${MANIFEST_FORMAT}, got ${JSON.stringify(manifest.format)}`);
  }
  if (manifest.version !== MANIFEST_VERSION) {
    if (Number.isSafeInteger(manifest.version) && manifest.version > MANIFEST_VERSION) {
      fail(MANIFEST_CODES.VERSION_UNSUPPORTED, '$.version', `manifest version ${manifest.version} is newer than ${MANIFEST_VERSION}`);
    } else {
      fail(MANIFEST_CODES.VALUE, '$.version', `expected ${MANIFEST_VERSION}, got ${JSON.stringify(manifest.version)}`);
    }
  }
  if (typeof manifest.snapshot_id !== 'string' || !SNAPSHOT_ID_RE.test(manifest.snapshot_id)) {
    fail(MANIFEST_CODES.VALUE, '$.snapshot_id', 'snapshot_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}');
  }
  if (typeof manifest.created_at !== 'string' || Number.isNaN(Date.parse(manifest.created_at))) {
    fail(MANIFEST_CODES.VALUE, '$.created_at', 'created_at must be an ISO date string');
  }
  if (typeof manifest.dsh_home !== 'string' || manifest.dsh_home.trim() === '') {
    fail(MANIFEST_CODES.VALUE, '$.dsh_home', 'dsh_home must be a non-empty string');
  }
  if (manifest.block_size !== BLOCK_SIZE) {
    fail(MANIFEST_CODES.VALUE, '$.block_size', `v1 fixes the block size at ${BLOCK_SIZE}, got ${JSON.stringify(manifest.block_size)}`);
  }
  if (manifest.block_algo !== BLOCK_ALGO) {
    fail(MANIFEST_CODES.VALUE, '$.block_algo', `v1 only accepts ${BLOCK_ALGO}`);
  }
  if (manifest.cipher !== MANIFEST_CIPHER) {
    fail(MANIFEST_CODES.VALUE, '$.cipher', `v1 only accepts ${MANIFEST_CIPHER}`);
  }

  const checkCounts = (counts, at) => {
    if (!isObject(counts)) {
      fail(MANIFEST_CODES.TYPE, at, 'counts must be an object');
      return;
    }
    for (const key of COUNT_KEYS) {
      if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) {
        fail(MANIFEST_CODES.VALUE, `${at}.${key}`, 'count must be a non-negative integer');
      }
    }
    for (const key of Object.keys(counts)) {
      if (!COUNT_KEYS.includes(key)) fail(MANIFEST_CODES.KEY_UNKNOWN, `${at}.${key}`, 'unknown count key');
    }
  };
  checkCounts(manifest.counts, '$.counts');

  const files = Array.isArray(manifest.files) ? manifest.files : null;
  if (files === null) {
    fail(MANIFEST_CODES.TYPE, '$.files', 'files must be an array');
  } else {
    const seen = new Set();
    let bytes = 0;
    let blocks = 0;
    let blockBytes = 0;
    let sessionCount = 0;
    let attachmentCount = 0;
    files.forEach((entry, index) => {
      const at = `$.files[${index}]`;
      if (!isObject(entry)) {
        fail(MANIFEST_CODES.TYPE, at, 'a file entry must be an object');
        return;
      }
      for (const key of FILE_KEYS) {
        if (!(key in entry)) fail(MANIFEST_CODES.KEY_MISSING, `${at}.${key}`, 'required key is missing');
      }
      if (entry.kind !== 'session' && entry.kind !== 'attachment') {
        fail(MANIFEST_CODES.KIND, `${at}.kind`, `expected "session" or "attachment", got ${JSON.stringify(entry.kind)}`);
      }
      const allowed = entry.kind === 'attachment' ? [...FILE_KEYS, ...ATTACHMENT_KEYS] : [...FILE_KEYS, ...SESSION_KEYS];
      for (const key of Object.keys(entry)) {
        if (!allowed.includes(key)) fail(MANIFEST_CODES.KEY_UNKNOWN, `${at}.${key}`, `unknown key for a ${entry.kind} entry`);
      }

      let rel = null;
      try {
        rel = normalizeRelPath(entry.rel);
      } catch (error) {
        fail(error.code ?? MANIFEST_CODES.REL_PATH, `${at}.rel`, error.detail ?? String(error.message));
      }
      if (rel !== null) {
        const folded = rel.toLowerCase();
        if (seen.has(folded)) fail(MANIFEST_CODES.REL_DUPLICATE, `${at}.rel`, `duplicate path (case-insensitively): ${rel}`);
        else seen.add(folded);
      }

      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        fail(MANIFEST_CODES.VALUE, `${at}.size`, 'size must be a non-negative integer');
      }
      if (typeof entry.mtime_ms !== 'number' || !Number.isFinite(entry.mtime_ms) || entry.mtime_ms <= 0) {
        fail(MANIFEST_CODES.VALUE, `${at}.mtime_ms`, 'mtime_ms must be a positive number');
      }
      if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
        fail(MANIFEST_CODES.SHA256, `${at}.sha256`, 'sha256 must be 64 lowercase hex characters');
      }

      const list = Array.isArray(entry.blocks) ? entry.blocks : null;
      if (list === null) {
        fail(MANIFEST_CODES.TYPE, `${at}.blocks`, 'blocks must be an array');
        return;
      }
      let expectedOffset = 0;
      let listed = 0;
      list.forEach((block, blockIndex) => {
        const blockAt = `${at}.blocks[${blockIndex}]`;
        if (!isObject(block)) {
          fail(MANIFEST_CODES.TYPE, blockAt, 'a block must be an object');
          return;
        }
        for (const key of BLOCK_KEYS) {
          if (!(key in block)) fail(MANIFEST_CODES.KEY_MISSING, `${blockAt}.${key}`, 'required key is missing');
        }
        for (const key of Object.keys(block)) {
          if (!BLOCK_KEYS.includes(key)) fail(MANIFEST_CODES.KEY_UNKNOWN, `${blockAt}.${key}`, 'unknown block key');
        }
        if (block.index !== blockIndex) {
          fail(MANIFEST_CODES.BLOCK_GAP, `${blockAt}.index`, `expected ${blockIndex}, got ${JSON.stringify(block.index)}`);
        }
        if (block.offset !== expectedOffset) {
          fail(MANIFEST_CODES.BLOCK_GAP, `${blockAt}.offset`, `expected ${expectedOffset}, got ${JSON.stringify(block.offset)}`);
        }
        if (!Number.isSafeInteger(block.length) || block.length <= 0 || block.length > BLOCK_SIZE) {
          fail(MANIFEST_CODES.VALUE, `${blockAt}.length`, `length must be 1..${BLOCK_SIZE}`);
        } else {
          expectedOffset += block.length;
          listed += block.length;
        }
        if (typeof block.sha256 !== 'string' || !SHA256_HEX.test(block.sha256)) {
          fail(MANIFEST_CODES.SHA256, `${blockAt}.sha256`, 'sha256 must be 64 lowercase hex characters');
        }
        blocks += 1;
      });
      if (listed !== entry.size) {
        fail(MANIFEST_CODES.SIZE_MISMATCH, `${at}.blocks`, `blocks cover ${listed} of ${entry.size} bytes`);
      }
      blockBytes += listed;
      if (Number.isSafeInteger(entry.size)) bytes += entry.size;

      if (entry.kind === 'session') {
        if (typeof entry.session_id !== 'string' || !SESSION_ID_RE.test(entry.session_id)) {
          fail(MANIFEST_CODES.VALUE, `${at}.session_id`, 'session_id must be a plain identifier');
        }
        if (typeof entry.workspace !== 'string' || entry.workspace === '') {
          fail(MANIFEST_CODES.VALUE, `${at}.workspace`, 'workspace must be a non-empty string');
        }
        if (entry.format_version !== null && !Number.isSafeInteger(entry.format_version)) {
          fail(MANIFEST_CODES.VALUE, `${at}.format_version`, 'format_version must be an integer or null');
        }
        if (entry.flags !== undefined) {
          if (!isObject(entry.flags)) {
            fail(MANIFEST_CODES.TYPE, `${at}.flags`, 'flags must be an object');
          } else {
            for (const key of Object.keys(entry.flags)) {
              if (!['registered', 'archived', 'pinned'].includes(key)) {
                fail(MANIFEST_CODES.KEY_UNKNOWN, `${at}.flags.${key}`, 'unknown flag');
              } else if (typeof entry.flags[key] !== 'boolean') {
                fail(MANIFEST_CODES.TYPE, `${at}.flags.${key}`, 'flag must be a boolean');
              }
            }
          }
        }
        if (rel !== null && typeof entry.session_id === 'string') {
          const expected = `sessions/${entry.workspace}/${entry.session_id}/`;
          if (!rel.startsWith(expected)) {
            fail(MANIFEST_CODES.REL_PATH, `${at}.rel`, `a session log must live under ${expected}, got ${rel}`);
          }
        }
        sessionCount += 1;
      } else {
        if (typeof entry.attachment_id !== 'string' || !SHA256_HEX.test(entry.attachment_id)) {
          fail(MANIFEST_CODES.SHA256, `${at}.attachment_id`, 'attachment_id must be 64 lowercase hex characters');
        }
        if (rel !== null && typeof entry.attachment_id === 'string') {
          const expected = `attachments/v1/objects/${entry.attachment_id.slice(0, 2)}/${entry.attachment_id}`;
          if (rel !== expected) {
            fail(MANIFEST_CODES.REL_PATH, `${at}.rel`, `an attachment object must live at ${expected}, got ${rel}`);
          }
        }
        attachmentCount += 1;
      }
    });

    if (isObject(manifest.counts)) {
      const computed = {
        files: files.length,
        bytes,
        blocks,
        block_bytes: blockBytes,
        sessions: sessionCount,
        attachments: attachmentCount,
      };
      for (const [key, value] of Object.entries(computed)) {
        if (manifest.counts[key] !== value) {
          fail(MANIFEST_CODES.COUNT_MISMATCH, `$.counts.${key}`, `declared ${JSON.stringify(manifest.counts[key])}, files say ${value}`);
        }
      }
    }
  }

  if (!isObject(manifest.registry)) {
    fail(MANIFEST_CODES.TYPE, '$.registry', 'registry must be an object');
  } else {
    for (const key of REGISTRY_KEYS) {
      if (!Number.isSafeInteger(manifest.registry[key]) || manifest.registry[key] < 0) {
        fail(MANIFEST_CODES.VALUE, `$.registry.${key}`, 'registry count must be a non-negative integer');
      }
    }
    for (const key of Object.keys(manifest.registry)) {
      if (!REGISTRY_KEYS.includes(key)) fail(MANIFEST_CODES.KEY_UNKNOWN, `$.registry.${key}`, 'unknown registry key');
    }
  }

  if (!Array.isArray(manifest.exclusions)) {
    fail(MANIFEST_CODES.TYPE, '$.exclusions', 'exclusions must be an array');
  } else {
    manifest.exclusions.forEach((entry, index) => {
      const at = `$.exclusions[${index}]`;
      if (!isObject(entry) || typeof entry.rel !== 'string' || typeof entry.reason !== 'string') {
        fail(MANIFEST_CODES.TYPE, at, 'an exclusion must be {rel, reason}');
      }
    });
  }

  return { ok: errors.length === 0, errors, manifest: errors.length === 0 ? manifest : null };
}

/**
 * Parse and validate manifest JSON.
 *
 * @param {string} text
 * @returns {{ok: boolean, errors: Array<object>, manifest: object|null}}
 */
export function readManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [{ code: MANIFEST_CODES.SHAPE, path: '$', detail: `not JSON: ${error instanceof Error ? error.message : String(error)}` }],
      manifest: null,
    };
  }
  return validateManifest(parsed);
}

/** The counts a status card shows, without the file list. */
export function manifestSummary(manifest) {
  return {
    snapshot_id: manifest?.snapshot_id ?? null,
    created_at: manifest?.created_at ?? null,
    files: manifest?.counts?.files ?? 0,
    session_bytes: manifest?.counts?.bytes ?? 0,
    blocks: manifest?.counts?.blocks ?? 0,
    sessions: manifest?.counts?.sessions ?? 0,
    attachments: manifest?.counts?.attachments ?? 0,
    digest: manifest === undefined || manifest === null ? null : manifestDigest(manifest),
  };
}
