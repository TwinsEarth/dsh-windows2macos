/**
 * Minimal ZIP container (stored + deflate), dependency-free.
 *
 * ## Why this exists, and why it is not a second backup engine
 *
 * The `dsh-backup-plugin` tool surface is defined by the BackUP-dsh-plugin contract
 * (`backup_create` / `backup_verify` / `backup_restore` / `backup_import_session_zip` / `backup_status` /
 * `backup_list`), whose archives are self-contained ZIP files a person can copy to another machine. This
 * module is only the container: the archive schema, the session import and the restore plan live in
 * `zip-archive.mjs` and `session-zip.mjs`, and each entry's digest is recorded in the archive's own
 * `manifest.json` rather than trusted from the ZIP headers.
 *
 * ## What it deliberately does not do
 *
 * No Zip64 (an archive over 4 GiB is refused rather than silently truncated), no encryption (the archive
 * is plaintext by contract; a sealed repository is the scheduled engine's `dsh-backup` row, not this
 * surface), and no streaming (these archives are bounded by `maxFileBytes` per entry). Entry names are
 * normalised to forward slashes because Windows archivers write backslashes; a name is otherwise kept
 * verbatim and validated by the caller before it is used as a path.
 *
 * The writer is deterministic: every entry is stamped with a fixed DOS time and CRC-32, so packing the
 * same files twice yields the same bytes. That is what lets `backup_verify` recompute the archive's own
 * SHA-256 and have it mean something.
 *
 * Ported from the sibling `BackUP-dsh-plugin` (`lib/zip.mjs`, MIT, same author) so the two plugins agree
 * on the container; the exported surface is unchanged.
 */

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Named refusals, so a caller can report why an archive was not read. */
export const ZIP_CODES = Object.freeze({
  NOT_ZIP: 'BACKUP_ZIP_NOT_ZIP',
  ZIP64: 'BACKUP_ZIP64_UNSUPPORTED',
  CORRUPT: 'BACKUP_ZIP_CORRUPT',
  METHOD: 'BACKUP_ZIP_METHOD_UNSUPPORTED',
});

/** A container refusal with a stable code. */
export class ZipError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'ZipError';
    this.code = code;
    this.detail = detail;
  }
}

/** Find the end-of-central-directory record, scanning backwards over the comment allowance. */
function findEocd(buffer) {
  if (buffer.length < 22) throw new ZipError(ZIP_CODES.NOT_ZIP, 'shorter than an end-of-central-directory record');
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) return offset;
  }
  throw new ZipError(ZIP_CODES.NOT_ZIP, 'end-of-central-directory record not found');
}

/** `dir\file` -> `dir/file`; the writer always emits forward slashes. */
export function normalizeZipName(name) {
  return String(name).replace(/\\/g, '/');
}

/**
 * Enumerate central-directory records without decompressing entry data.
 *
 * @param {Buffer} buffer
 * @returns {Array<{name: string, method: number, compressedSize: number, size: number, dataStart: number}>}
 */
export function listZipEntries(buffer) {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new ZipError(ZIP_CODES.ZIP64, 'Zip64 archives are not supported');
  }
  if (centralOffset + 46 > buffer.length) throw new ZipError(ZIP_CODES.CORRUPT, 'central directory starts past the file');
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL) {
      throw new ZipError(ZIP_CODES.CORRUPT, `bad central header #${index}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength > buffer.length) throw new ZipError(ZIP_CODES.CORRUPT, `bad name length for entry #${index}`);
    const name = normalizeZipName(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new ZipError(ZIP_CODES.CORRUPT, `bad local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw new ZipError(ZIP_CODES.CORRUPT, `entry ${name} runs past the file`);
    entries.push({ name, method, compressedSize, size, dataStart });
  }
  return entries;
}

/** Decompress one entry's data; an unsupported method is a named refusal. */
function readEntryData(buffer, entry) {
  const raw = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new ZipError(ZIP_CODES.METHOD, `compression method ${entry.method} for ${entry.name}`);
}

/**
 * Check a decompressed entry against the size its central directory declares.
 *
 * The size is not the archive's integrity check (the manifest's SHA-256 is), but a mismatch means the
 * container itself is inconsistent -- a truncated download, a corrupt central record -- and that must be
 * reported per entry rather than read as valid bytes. A declared size of 0 is accepted: some writers stream
 * with a data descriptor and leave the central field unset, and refusing those would reject valid ZIPs.
 */
function entrySizeProblem(entry, data) {
  return entry.size !== 0 && data.length !== entry.size ? `size mismatch (${data.length} != ${entry.size})` : null;
}

/**
 * Read every entry into memory.
 *
 * A single unreadable entry does not make the whole archive unreadable: it is reported under `skipped`
 * and the caller decides whether that is fatal (restore treats a missing manifest entry as fatal).
 *
 * @param {Buffer} buffer
 * @returns {{entries: Array<{name: string, data: Buffer}>, skipped: Array<{name: string, reason: string}>}}
 */
export function readZip(buffer) {
  const entries = [];
  const skipped = [];
  for (const entry of listZipEntries(buffer)) {
    try {
      const data = readEntryData(buffer, entry);
      const problem = entrySizeProblem(entry, data);
      if (problem !== null) {
        skipped.push({ name: entry.name, reason: problem });
        continue;
      }
      entries.push({ name: entry.name, data });
    } catch (error) {
      skipped.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { entries, skipped };
}

/**
 * Read one entry by name (case-sensitive, forward-slash normalised).
 *
 * @param {Buffer} buffer
 * @param {string} target
 * @returns {Buffer|null}
 */
export function readZipEntry(buffer, target) {
  const wanted = normalizeZipName(target);
  const entry = listZipEntries(buffer).find((candidate) => candidate.name === wanted);
  if (entry === undefined) return null;
  const data = readEntryData(buffer, entry);
  const problem = entrySizeProblem(entry, data);
  if (problem !== null) throw new ZipError(ZIP_CODES.CORRUPT, `${wanted}: ${problem}`);
  return data;
}

/**
 * Build a ZIP from `{ name, data }` entries.
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  const names = [];
  let offset = 0;
  for (const item of entries) {
    const name = normalizeZipName(item.name);
    if (names.includes(name)) throw new ZipError(ZIP_CODES.CORRUPT, `duplicate zip entry: ${name}`);
    names.push(name);
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.data), 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 name
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // fixed DOS time: deterministic bytes
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
