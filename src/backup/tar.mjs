/**
 * A minimal ustar reader/writer for the archive feature.
 *
 * ## Why not a dependency
 *
 * The package ships with no runtime dependencies, and the archive needs exactly two operations: write entries
 * (name, bytes, mode, mtime) and read them back. ustar is a 512-byte-header format that fits in this file; a
 * dependency would be a supply-chain surface for one function.
 *
 * ## What is deliberately not supported
 *
 * No PAX/long-name extension (names longer than `prefix/name` are refused with a clear error), no symlinks, no
 * sparse files, no compression (the caller compresses the whole tar with zstd). The entries this project writes are
 * `manifest.json`, `README.txt`, and files under `sessions/`/`attachments/` -- all short ASCII paths, all regular
 * files.
 */

const BLOCK = 512;

/** The only type flag this writer emits; the reader also accepts '0'. */
const REGULAR = '0';

function octal(number, length) {
  const text = Math.max(0, Math.floor(number)).toString(8);
  if (text.length > length - 1) throw new Error(`tar field overflow: ${number} does not fit in ${length - 1} octal digits`);
  return `${text.padStart(length - 1, '0')}\0`;
}

function writeString(target, offset, value, length) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > length) throw new Error(`tar field overflow: ${JSON.stringify(String(value))} is longer than ${length}`);
  bytes.copy(target, offset, 0, bytes.length);
}

/** Split a long path into ustar's `prefix` + `name` (167 bytes total). */
function splitName(name) {
  if (name.length <= 100) return { name, prefix: '' };
  for (let index = name.length - 100; index <= name.length; index += 1) {
    if (name[index] === '/') {
      const prefix = name.slice(0, index);
      const rest = name.slice(index + 1);
      if (prefix.length <= 155 && rest.length <= 100) return { name: rest, prefix };
    }
  }
  throw new Error(`tar path too long: ${name}`);
}

/**
 * Build a tar archive.
 *
 * @param {Array<{name: string, data: Buffer|string, mode?: number, mtimeMs?: number}>} entries
 * @returns {Buffer}
 */
export function writeTar(entries) {
  const blocks = [];
  let total = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const { name, prefix } = splitName(entry.name);
    const header = Buffer.alloc(BLOCK, 0);
    writeString(header, 0, name, 100);
    writeString(header, 100, octal(entry.mode ?? 0o644, 8), 8);
    writeString(header, 108, octal(0, 8), 8); // uid
    writeString(header, 116, octal(0, 8), 8); // gid
    writeString(header, 124, octal(data.length, 12), 12);
    writeString(header, 136, octal(Math.floor((entry.mtimeMs ?? 0) / 1000), 12), 12);
    writeString(header, 148, '        ', 8); // checksum placeholder: spaces
    writeString(header, 156, REGULAR, 1);
    writeString(header, 257, 'ustar\0', 6);
    writeString(header, 263, '00', 2);
    writeString(header, 345, prefix, 155);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeString(header, 148, `${checksum.toString(8).padStart(6, '0')}\0 `, 8);
    blocks.push(header);
    blocks.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
    total += BLOCK + data.length + padding;
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(blocks, total + BLOCK * 2);
}

/** Parse a NUL-terminated string field. */
function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** Parse an octal field. */
function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/**
 * Read a tar archive produced by {@link writeTar} (or any ustar archive of regular files).
 *
 * @param {Buffer} buffer
 * @returns {Array<{name: string, data: Buffer, mode: number, mtimeMs: number}>}
 * @throws {Error} on a malformed header or an unsupported entry type
 */
export function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const mtimeMs = readOctal(header, 136, 12) * 1000;
    const typeFlag = readString(header, 156, 1) || REGULAR;
    if (typeFlag !== REGULAR) throw new Error(`unsupported tar entry type ${JSON.stringify(typeFlag)} for ${prefix}${prefix === '' ? '' : '/'}${name}`);
    const full = prefix === '' ? name : `${prefix}/${name}`;
    const start = offset + BLOCK;
    const end = start + size;
    if (end > buffer.length) throw new Error(`tar entry ${full} claims ${size} bytes past the end of the archive`);
    entries.push({ name: full, data: buffer.subarray(start, end), mode, mtimeMs });
    offset = end + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  return entries;
}
