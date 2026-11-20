/**
 * Chunked sealed format v2 for `old/` full copies (`docs/REFACTOR-P2-PLAN.md` §2, slice O1).
 *
 * ## Why a second container exists
 *
 * A v1 whole-file copy (`rotation.mjs`'s `oldFormat: 'full'`) is **one** AES-256-GCM object: `crypto.sealObject`
 * encrypts the entire file in one call and `crypto.openObject` must hold the whole ciphertext to verify the tag.
 * Verify therefore bounds it by `oldCopyMaxBytes` and the process-wide heap guard before it reads it, and a 500 MB
 * copy is a 500 MB allocation. That is the P2 risk this format removes: `v2` splits the plaintext into
 * independent records so a reader can authenticate one chunk at a time and hold **one chunk**, not the file.
 *
 * This file is additive. Nothing in `rotation`/`old-restore` writes or reads v2 yet (that is O3/O4), and every
 * existing `.enc` stays a v1 object: `verify` sniffs the magic and keeps the v1 path exactly as it was.
 *
 * ## Byte layout
 *
 *     magic    "W2MOLD2\n"                                          8 B, ASCII
 *     header   {"v":2,"alg":"aes-256-gcm","chunkBytes":N,"size":S,"sha256":"<hex>"}\n   plaintext JSON + '\n'
 *     chunks   [ nonce(12) | ciphertext | tag(16) ] x M               M = ceil(S / chunkBytes), 0 when S == 0
 *
 * The header is **plaintext on purpose**: its fields are metadata that leak nothing (an algorithm name, a chunk
 * size, the plaintext length and digest the record already states in the clear in `manifest.json`/`old/`). What it
 * must not be is *unauthenticated in effect* -- and it is not: every chunk's AAD names the header's `sha256` and
 * `size`, so changing either makes every chunk fail authentication. `chunkBytes` and `v` decide the framing; a
 * change to either produces chunks that do not authenticate (or a named header refusal). The header is newline
 * terminated, which is what makes the plaintext JSON self-delimiting without a binary length prefix.
 *
 * ## AAD
 *
 *     w2m-session-backup/old-chunked|<sha256>|<size>|<chunkIndex>
 *
 * Distinct from the v1 copy namespace (`w2m-session-backup/old|<sha256>|<length>`, `crypto.OLD_COPY_KIND`) and
 * from block objects, so a v2 chunk cannot be passed off as either -- and the index in the AAD is what makes a
 * reordered or duplicated record fail even though its ciphertext is intact.
 *
 * ## What a failure means (and what GCM cannot tell)
 *
 * GCM cannot distinguish "wrong key" from "altered bytes": both are one tag failure. This format adds two pieces
 * of structure that *can* be told apart, and names them:
 *
 *   * `BACKUP_CHUNKED_TRUNCATED` -- the file ends before the header's `size` implies; a pure framing fact.
 *   * `BACKUP_CHUNKED_ORDER` -- the record fails under its own index but is proven to belong to a **neighbouring**
 *     slot (it authenticates under that slot's AAD), or its nonce already appeared at another index (a
 *     duplicated record). A reorder of records whose indices are more than `ORDER_PROBE_WINDOW` apart cannot be
 *     proven from the bytes -- the AAD only binds an index the reader must guess -- so it reports
 *     `BACKUP_CHUNKED_AUTH_FAILED`, the same ambiguity `crypto.mjs` documents for a wrong credential. Naming a
 *     cause the bytes do not prove is exactly the mistake the 2026-11-17 drill made four times.
 *   * `BACKUP_CHUNKED_AUTH_FAILED` -- everything else that fails authentication (altered ciphertext/tag/nonce, a
 *     different DEK, a header identity the AAD does not match).
 *   * `BACKUP_CHUNKED_HEADER_INVALID` -- not this format, or a header that is malformed / names unknown fields /
 *     a version, algorithm or chunk size this build refuses / an identity the caller says it is not.
 *   * `BACKUP_CHUNKED_TRAILING` -- the declared chunks decode and authenticate, and then the file continues. A
 *     writer never produces that shape (it renames a complete temp file into place), so it is corruption to name,
 *     not a longer file to accept.
 *
 * ## Reading is synchronous on purpose
 *
 * `openChunkedStream` runs the whole stream before returning and calls `onChunk` synchronously. "Streaming" here
 * means **bounded memory**, not asynchrony: the rest of the backup engine is synchronous (`sealObject`,
 * `openObject`, `rebuildFile`, `verifyRepo`), and an async reader would force every caller to become async for no
 * safety. The one thing a callback must not do is retain the `plaintext` view past the call -- for a file source it
 * is a slice of a per-record buffer that is released afterwards, and `openChunkedBuffer` copies when it collects.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { AEAD, DEK_LENGTH, NONCE_LENGTH, TAG_LENGTH, isDek } from './crypto.mjs';

/** Magic at the start of a chunked-v2 file. Eight ASCII bytes, so the sniff is one `subarray.equals`. */
export const CHUNKED_MAGIC = Buffer.from('W2MOLD2\n', 'ascii');

/** Version written in the header and accepted by this build. */
export const CHUNKED_VERSION = 2;

/** Value a future `full_copy.format` record field will carry for a v2 copy (O4); v1 records omit the field. */
export const CHUNKED_FORMAT = 'chunked-v2';

/** Default chunk size: 4 MiB, the same block size the deduplicated object store uses. */
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Largest chunk this build writes or accepts: 16 MiB.
 *
 * A reader's peak memory is one record (`chunkBytes + 28`), so this is the whole per-chunk budget. A file that
 * names more is refused by name instead of being read: an attacker-authored header must never be the reason a
 * host has to allocate an unbounded buffer.
 */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/** Largest plaintext header accepted, terminator included. The header this build writes is ~130 bytes. */
export const MAX_HEADER_BYTES = 4096;

/** AAD container name of one v2 chunk; mirrors `crypto.OLD_COPY_KIND`'s naming. */
export const CHUNKED_AAD_PREFIX = 'w2m-session-backup/old-chunked';

/**
 * How far the reader looks for a reordered record before it reports the ambiguity instead of a cause.
 *
 * Only an authentication **failure** probes (at most `2 * window` GCM attempts), and only when the record's
 * ciphertext length fits the candidate slot, so a swapped pair of full-chunk records is named for any distance up
 * to this window. Beyond it the bytes genuinely do not say which slot a record came from.
 */
export const ORDER_PROBE_WINDOW = 8;

/**
 * Above this many expected chunks the reader stops recording seen nonces.
 *
 * The map exists to name a duplicated record (`BACKUP_CHUNKED_ORDER`), and it grows with the chunk count. A file
 * that repeats one nonce across millions of chunks would otherwise cost more memory than the copy itself --
 * exactly the trade this format exists to refuse. A well-formed copy at the 4 MiB default is far below this.
 */
export const MAX_TRACKED_NONCES = 65536;

/** Named chunked-format failure codes. */
export const CHUNKED_CODES = Object.freeze({
  HEADER_INVALID: 'BACKUP_CHUNKED_HEADER_INVALID',
  AUTH_FAILED: 'BACKUP_CHUNKED_AUTH_FAILED',
  TRUNCATED: 'BACKUP_CHUNKED_TRUNCATED',
  ORDER: 'BACKUP_CHUNKED_ORDER',
  TRAILING: 'BACKUP_CHUNKED_TRAILING',
  ARGUMENT_INVALID: 'BACKUP_CHUNKED_ARGUMENT_INVALID',
  READ_FAILED: 'BACKUP_CHUNKED_READ_FAILED',
  WRITE_FAILED: 'BACKUP_CHUNKED_WRITE_FAILED',
});

/** A chunked-format failure with a stable code. `toRefusal()` matches the house result shape. */
export class ChunkedError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'ChunkedError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }

  toRefusal() {
    return { ok: false, reason_code: this.code, detail: this.detail };
  }
}

/** A lowercase-hex sha256, the only digest spelling the header accepts. */
const SHA256_RE = /^[0-9a-f]{64}$/u;

/** The exact header field set; anything else in the JSON is refused, so a future field cannot be half-read. */
const HEADER_FIELDS = Object.freeze(['alg', 'chunkBytes', 'sha256', 'size', 'v']);

/** The sha256 of a buffer as lowercase hex. */
function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * The AAD of one chunk: `w2m-session-backup/old-chunked|<sha256>|<size>|<chunkIndex>`.
 *
 * @param {{sha256: string, size: number, chunkIndex: number}} parts
 * @returns {string}
 */
export function chunkedAad(parts) {
  return `${CHUNKED_AAD_PREFIX}|${String(parts?.sha256 ?? '')}|${String(parts?.size ?? '')}|${String(parts?.chunkIndex ?? '')}`;
}

/** How many records a plaintext of `size` bytes needs. A 0-byte file is a header and no records. */
export function chunkCountFor(size, chunkBytes) {
  if (size === 0) return 0;
  return Math.ceil(size / chunkBytes);
}

/**
 * The plaintext length of chunk `index`. Every chunk is full except the last, which may be shorter.
 *
 * @param {number} size
 * @param {number} chunkBytes
 * @param {number} index
 * @returns {number}
 */
function chunkPlaintextLength(size, chunkBytes, index) {
  const last = size - chunkBytes * index;
  return last < chunkBytes ? last : chunkBytes;
}

/** Describe a rejected option value without throwing from the describer. */
function show(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value);
}

/**
 * Normalise `chunkBytes`: absent means {@link DEFAULT_CHUNK_BYTES}; a value must be a positive safe integer no
 * larger than {@link MAX_CHUNK_BYTES}. A refused value is named, never silently clamped -- a caller that asked for
 * a 32 MiB chunk must not believe it got 16 MiB.
 *
 * @param {unknown} value
 * @returns {number}
 * @throws {ChunkedError} `BACKUP_CHUNKED_ARGUMENT_INVALID`
 */
export function resolveChunkBytes(value) {
  if (value === undefined || value === null) return DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ChunkedError(
      CHUNKED_CODES.ARGUMENT_INVALID,
      `chunkBytes must be a positive integer number of bytes (default ${DEFAULT_CHUNK_BYTES}), got ${show(value)}`,
    );
  }
  if (value > MAX_CHUNK_BYTES) {
    throw new ChunkedError(
      CHUNKED_CODES.ARGUMENT_INVALID,
      `chunkBytes ${value} is above the ${MAX_CHUNK_BYTES}-byte ceiling: one chunk is the reader's whole memory budget`,
    );
  }
  return value;
}

/**
 * True when `source` starts with the v2 magic.
 *
 * `source` is a Buffer or a file path. **Never throws**: a missing, unreadable or short file is simply "not v2",
 * because every caller asks this question about a path it is already prepared to report as absent. The magic is
 * the only thing sniffed; a file with the magic but a broken header is v2 that {@link openChunkedStream} refuses
 * with `BACKUP_CHUNKED_HEADER_INVALID`, not "v1".
 *
 * @param {Buffer|string} source
 * @returns {boolean}
 */
export function isChunkedV2(source) {
  if (Buffer.isBuffer(source)) {
    return source.length >= CHUNKED_MAGIC.length && source.subarray(0, CHUNKED_MAGIC.length).equals(CHUNKED_MAGIC);
  }
  if (typeof source !== 'string' || source === '') return false;
  let fd = null;
  try {
    fd = fs.openSync(source, 'r');
    const head = Buffer.alloc(CHUNKED_MAGIC.length);
    let total = 0;
    while (total < head.length) {
      const read = fs.readSync(fd, head, total, head.length - total, null);
      if (read === 0) return false;
      total += read;
    }
    return head.equals(CHUNKED_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the answer is already "not v2"; a close failure cannot change it */
      }
    }
  }
}

/**
 * Seal one record: `nonce | ciphertext | tag`, the same AEAD and field order `crypto.sealObject` uses.
 *
 * @param {Buffer} plaintext
 * @param {Buffer} dek
 * @param {string} aad
 * @returns {Buffer}
 */
function sealRecord(plaintext, dek, aad) {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(AEAD, dek, nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * Open one record. Throws on any authentication failure; the caller decides which named code it is.
 *
 * @param {{dek: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer, aad: string}} input
 * @returns {Buffer}
 */
function openRecord(input) {
  const decipher = createDecipheriv(AEAD, input.dek, input.nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(input.tag);
  decipher.setAAD(Buffer.from(input.aad, 'utf8'));
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
}

/** True when a record authenticates under one AAD; used only to classify a failure that already happened. */
function authenticates(input) {
  try {
    openRecord(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the plaintext header for a seal: `{v, alg, chunkBytes, size, sha256}`, newline terminated.
 *
 * Field order is fixed (v, alg, chunkBytes, size, sha256), which makes the bytes a fixture can predict and keeps
 * the header readable in a hex dump. The terminator is part of the format, not decoration: it is what delimits the
 * plaintext JSON without a binary length prefix.
 *
 * @param {{sha256: string, size: number, chunkBytes: number}} input
 * @returns {Buffer}
 */
function buildHeader(input) {
  const header = {
    v: CHUNKED_VERSION,
    alg: AEAD,
    chunkBytes: input.chunkBytes,
    size: input.size,
    sha256: input.sha256,
  };
  return Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');
}

/**
 * Validate and seal every record into a caller-supplied writer.
 *
 * The whole format is written through `write(buffer)`, one magic, one header and one record at a time, so the
 * caller decides whether the output is a Buffer (`sealChunked`), a temp file (`sealChunkedToFile`) or a sink
 * (`sealChunkedToSink`). Nothing here concatenates the output.
 *
 * @param {Buffer} plaintext
 * @param {{dek: Buffer, sha256?: string, size?: number, chunkBytes?: number}} options `sha256`/`size` are
 *   verified against the plaintext when supplied and computed from it when absent; a mismatch is refused
 * @param {(buffer: Buffer) => void} write
 * @returns {{format: string, alg: string, sha256: string, size: number, chunkBytes: number, chunks: number,
 *   byteLength: number, peakChunkBytes: number}}
 * @throws {ChunkedError} `BACKUP_CHUNKED_ARGUMENT_INVALID`
 */
function writeChunked(plaintext, options, write) {
  if (options === null || typeof options !== 'object') {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, 'sealing needs an options object carrying the DEK');
  }
  if (!Buffer.isBuffer(plaintext)) {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, 'the plaintext must be a Buffer (streaming output is what v2 bounds, not the input)');
  }
  if (!isDek(options.dek)) {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, `a DEK must be ${DEK_LENGTH} bytes`);
  }
  const chunkBytes = resolveChunkBytes(options.chunkBytes);
  const digest = sha256Hex(plaintext);
  if (options.sha256 !== undefined && options.sha256 !== null && options.sha256 !== digest) {
    throw new ChunkedError(
      CHUNKED_CODES.ARGUMENT_INVALID,
      `the plaintext hashes to ${digest}, not the ${show(options.sha256)} the caller asked to seal it under: a copy must not be sealed under an identity it does not have`,
    );
  }
  if (options.size !== undefined && options.size !== null && options.size !== plaintext.length) {
    throw new ChunkedError(
      CHUNKED_CODES.ARGUMENT_INVALID,
      `the plaintext is ${plaintext.length} bytes, not the ${show(options.size)} the caller asked to seal it under`,
    );
  }
  const size = plaintext.length;
  const headerBytes = buildHeader({ sha256: digest, size, chunkBytes });
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, `the header is ${headerBytes.length} bytes, above the ${MAX_HEADER_BYTES}-byte ceiling`);
  }
  write(CHUNKED_MAGIC);
  write(headerBytes);
  let byteLength = CHUNKED_MAGIC.length + headerBytes.length;
  let peakChunkBytes = 0;
  const chunks = chunkCountFor(size, chunkBytes);
  for (let index = 0; index < chunks; index += 1) {
    const start = chunkBytes * index;
    const end = start + chunkPlaintextLength(size, chunkBytes, index);
    const aad = chunkedAad({ sha256: digest, size, chunkIndex: index });
    const record = sealRecord(plaintext.subarray(start, end), options.dek, aad);
    peakChunkBytes = Math.max(peakChunkBytes, record.length);
    byteLength += record.length;
    write(record);
  }
  return { format: CHUNKED_FORMAT, alg: AEAD, sha256: digest, size, chunkBytes, chunks, byteLength, peakChunkBytes };
}

/**
 * Seal a plaintext into chunked-v2 **bytes**.
 *
 * This is the small-input form (`sealObject`'s counterpart): the whole sealed file is one Buffer, so the caller
 * already holds plaintext + sealed bytes. Large copies use {@link sealChunkedToFile}, which never does.
 *
 * @param {Buffer} plaintext
 * @param {{dek: Buffer, sha256?: string, size?: number, chunkBytes?: number}} options
 * @returns {Buffer}
 * @throws {ChunkedError} `BACKUP_CHUNKED_ARGUMENT_INVALID` for a bad DEK, chunk size, or identity mismatch
 */
export function sealChunked(plaintext, options = {}) {
  const parts = [];
  writeChunked(plaintext, options, (buffer) => parts.push(buffer));
  return Buffer.concat(parts);
}

/**
 * Seal a plaintext into a chunked-v2 file through a temporary sibling and an atomic rename.
 *
 * This is the writer O4 will use: the sealed bytes never exist together (they are written record by record), and
 * the target name appears only after `fsync` + `rename`, so a crash cannot leave a file whose header promises
 * chunks it does not hold. The temp file is created in the **target's own directory**, so the rename never crosses
 * a filesystem (`atomic.mjs` documents the same rule; `writeFileAtomic` is not reused because it takes a whole
 * Buffer, which is the allocation this path exists to avoid).
 *
 * @param {Buffer} plaintext
 * @param {{dek: Buffer, sha256?: string, size?: number, chunkBytes?: number, writeToFile: string}} options
 * @returns {{ok: true, format: string, alg: string, file: string, sha256: string, size: number,
 *   chunkBytes: number, chunks: number, byteLength: number, peakChunkBytes: number}}
 * @throws {ChunkedError} `BACKUP_CHUNKED_ARGUMENT_INVALID` / `BACKUP_CHUNKED_WRITE_FAILED`
 */
export function sealChunkedToFile(plaintext, options = {}) {
  const target = typeof options.writeToFile === 'string' && options.writeToFile !== '' ? path.resolve(options.writeToFile) : null;
  if (target === null) {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, 'sealChunkedToFile needs options.writeToFile naming the file to write');
  }
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  let fd = null;
  let report;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'wx', 0o600);
    report = writeChunked(plaintext, options, (buffer) => {
      fs.writeSync(fd, buffer, 0, buffer.length);
    });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the failure being reported is the write */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort: a leaked temp file is reported by gc, not hidden */
    }
    if (error instanceof ChunkedError) throw error;
    throw new ChunkedError(CHUNKED_CODES.WRITE_FAILED, `${target}: ${error?.code ?? error?.message ?? String(error)}`);
  }
  return { ok: true, ...report, file: target };
}

/**
 * Seal a plaintext into a caller-supplied synchronous sink, one buffer at a time.
 *
 * The sink is `{write(buffer)}` and must consume or copy the buffer before returning: this API is deliberately
 * synchronous (see the module header), so it is a byte sink, not a Node `Writable`. A `false` return value is
 * ignored -- honouring backpressure would require making the whole seal async, and these sinks are `fs.writeSync`
 * and test collectors, not sockets.
 *
 * @param {Buffer} plaintext
 * @param {{dek: Buffer, sha256?: string, size?: number, chunkBytes?: number, sink: {write: Function}}} options
 * @returns {{ok: true, format: string, alg: string, file: null, sha256: string, size: number, chunkBytes: number,
 *   chunks: number, byteLength: number, peakChunkBytes: number}}
 * @throws {ChunkedError} `BACKUP_CHUNKED_ARGUMENT_INVALID`
 */
export function sealChunkedToSink(plaintext, options = {}) {
  const sink = options.sink;
  if (sink === null || typeof sink !== 'object' || typeof sink.write !== 'function') {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, 'sealChunkedToSink needs options.sink.write(buffer)');
  }
  const report = writeChunked(plaintext, options, (buffer) => {
    sink.write(buffer);
  });
  return { ok: true, ...report, file: null };
}

/**
 * A sequential byte source with the three operations the format needs.
 *
 * Two implementations behind one shape: a Buffer (tests, small files: every read is a view, so nothing is copied)
 * and a file (one `readSync` per request, plus the small pushback the header read needs when it over-reads into
 * the first record). `readUpTo` returns fewer bytes than asked at end of input rather than throwing, so the caller
 * can name truncation itself.
 *
 * @param {Buffer|string} source
 * @returns {{readUpTo: (length: number) => Buffer, readLine: (maxBytes: number) => Buffer|null, close: () => void}}
 */
function createSource(source) {
  if (Buffer.isBuffer(source)) {
    let cursor = 0;
    return {
      readUpTo(length) {
        const end = Math.min(cursor + length, source.length);
        const view = source.subarray(cursor, end);
        cursor = end;
        return view;
      },
      readLine(maxBytes) {
        const limit = Math.min(cursor + maxBytes, source.length);
        const index = source.subarray(cursor, limit).indexOf(0x0a);
        if (index === -1) return null;
        const line = source.subarray(cursor, cursor + index);
        cursor += index + 1;
        return line;
      },
      close() {},
    };
  }
  if (typeof source !== 'string' || source === '') {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, 'the source must be a Buffer or a file path');
  }
  const file = source;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    throw new ChunkedError(CHUNKED_CODES.READ_FAILED, `${file}: ${error?.code ?? 'unreadable'}`);
  }
  let pending = Buffer.alloc(0);
  let closed = false;
  const fill = (length) => {
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      let read;
      try {
        read = fs.readSync(fd, buffer, total, length - total, null);
      } catch (error) {
        throw new ChunkedError(CHUNKED_CODES.READ_FAILED, `${file}: ${error?.code ?? 'read failed'}`);
      }
      if (read === 0) break;
      total += read;
    }
    return buffer.subarray(0, total);
  };
  return {
    readUpTo(length) {
      if (pending.length >= length) {
        const out = pending.subarray(0, length);
        pending = pending.subarray(length);
        return out;
      }
      const head = pending;
      pending = Buffer.alloc(0);
      const rest = fill(length - head.length);
      return rest.length === 0 ? head : Buffer.concat([head, rest]);
    },
    readLine(maxBytes) {
      const head = pending;
      pending = Buffer.alloc(0);
      const block = head.length >= maxBytes ? head : Buffer.concat([head, fill(maxBytes - head.length)]);
      // Only the first `maxBytes` bytes may hold the terminator: a header longer than the cap is a refusal, not a
      // bigger allocation.
      const index = block.subarray(0, maxBytes).indexOf(0x0a);
      if (index === -1) return null;
      pending = block.subarray(index + 1);
      return block.subarray(0, index);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
      } catch {
        /* closing a descriptor that is already closed cannot change the verdict */
      }
    },
  };
}

/**
 * Read and validate the plaintext header.
 *
 * @param {{readLine: (maxBytes: number) => Buffer|null}} source
 * @returns {{header: {v: number, alg: string, chunkBytes: number, size: number, sha256: string}, bytes: number}}
 * @throws {ChunkedError} `BACKUP_CHUNKED_HEADER_INVALID`
 */
function readHeader(source) {
  const line = source.readLine(MAX_HEADER_BYTES);
  if (line === null) {
    throw new ChunkedError(
      CHUNKED_CODES.HEADER_INVALID,
      `the plaintext header is not newline-terminated within ${MAX_HEADER_BYTES} bytes (or the file ends inside it)`,
    );
  }
  let header;
  try {
    header = JSON.parse(line.toString('utf8'));
  } catch {
    throw new ChunkedError(CHUNKED_CODES.HEADER_INVALID, 'the plaintext header is not valid JSON');
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new ChunkedError(CHUNKED_CODES.HEADER_INVALID, 'the plaintext header is not a JSON object');
  }
  const fields = Object.keys(header).sort();
  if (fields.join(',') !== HEADER_FIELDS.join(',')) {
    throw new ChunkedError(
      CHUNKED_CODES.HEADER_INVALID,
      `the header carries ${fields.length === 0 ? 'no fields' : fields.join(', ')}, not exactly ${HEADER_FIELDS.join(', ')}`,
    );
  }
  if (header.v !== CHUNKED_VERSION) {
    throw new ChunkedError(CHUNKED_CODES.HEADER_INVALID, `the header names v ${show(header.v)}, not ${CHUNKED_VERSION}`);
  }
  if (header.alg !== AEAD) {
    throw new ChunkedError(CHUNKED_CODES.HEADER_INVALID, `the header names AEAD ${show(header.alg)}, not ${AEAD}`);
  }
  if (!Number.isSafeInteger(header.chunkBytes) || header.chunkBytes < 1 || header.chunkBytes > MAX_CHUNK_BYTES) {
    throw new ChunkedError(
      CHUNKED_CODES.HEADER_INVALID,
      `the header names chunkBytes ${show(header.chunkBytes)}; this build accepts 1..${MAX_CHUNK_BYTES}`,
    );
  }
  if (!Number.isSafeInteger(header.size) || header.size < 0) {
    throw new ChunkedError(CHUNKED_CODES.HEADER_INVALID, `the header names size ${show(header.size)}; a plaintext length must be a non-negative integer`);
  }
  if (typeof header.sha256 !== 'string' || !SHA256_RE.test(header.sha256)) {
    throw new ChunkedError(CHUNKED_CODES.HEADER_INVALID, 'the header has no lowercase-hex sha256 of the plaintext');
  }
  return { header, bytes: line.length + 1 };
}

/**
 * Work out whether a failed record is *provably* a reorder, and name it.
 *
 * Two proofs are available from the bytes, and both are used; anything else stays the authentication ambiguity:
 *
 *   1. **the nonce already appeared** at another index -- a record was duplicated into this slot;
 *   2. **the record authenticates under a neighbouring slot's AAD** (within {@link ORDER_PROBE_WINDOW}, and only
 *      when its ciphertext length fits that slot) -- the records were swapped.
 *
 * @param {{dek: Buffer, record: Buffer, index: number, chunks: number, header: object,
 *   seenNonces: Map<string, number>}} input
 * @returns {{code: string, detail: string}}
 */
function classifyFailure(input) {
  const nonce = input.record.subarray(0, NONCE_LENGTH);
  const tag = input.record.subarray(input.record.length - TAG_LENGTH);
  const ciphertext = input.record.subarray(NONCE_LENGTH, input.record.length - TAG_LENGTH);
  const repeat = input.seenNonces.get(nonce.toString('hex'));
  if (repeat !== undefined) {
    return {
      code: CHUNKED_CODES.ORDER,
      detail: `chunk ${input.index} repeats the nonce of chunk ${repeat}: the records are out of order or duplicated`,
    };
  }
  for (let delta = 1; delta <= ORDER_PROBE_WINDOW; delta += 1) {
    for (const candidate of [input.index - delta, input.index + delta]) {
      if (candidate < 0 || candidate >= input.chunks) continue;
      // A record can only be the chunk whose plaintext length its ciphertext has; checking first keeps the probe
      // from reporting a "reorder" that the lengths already rule out.
      if (chunkPlaintextLength(input.header.size, input.header.chunkBytes, candidate) !== ciphertext.length) continue;
      const aad = chunkedAad({ sha256: input.header.sha256, size: input.header.size, chunkIndex: candidate });
      if (authenticates({ dek: input.dek, nonce, ciphertext, tag, aad })) {
        return {
          code: CHUNKED_CODES.ORDER,
          detail: `chunk ${input.index} authenticates as chunk ${candidate}: the records are out of order`,
        };
      }
    }
  }
  return {
    code: CHUNKED_CODES.AUTH_FAILED,
    detail:
      `chunk ${input.index} of ${input.chunks} does not authenticate under its own index; ` +
      'the DEK is wrong, or the record was altered, or it was moved further than the reader can prove (GCM cannot tell which)',
  };
}

/**
 * Verify one chunked-v2 source **without materialising it**: one record at a time, hashing as it goes.
 *
 * Peak memory is one record (`chunkBytes + 28` bytes, at most `MAX_CHUNK_BYTES + 28`), independent of the file
 * size. The returned digest/hash are the *plaintext* identity the header promised, checked against both the header
 * and the caller's `sha256`/`size` when those are supplied -- so verify can pass the version record's identity and
 * get a refusal that names a copy belonging to another version, not a mystery authentication failure.
 *
 * @param {Buffer|string} source the sealed file's bytes or path
 * @param {{dek: Buffer, onChunk?: (chunk: {index: number, plaintext: Buffer, size: number, offset: number}) => void,
 *   sha256?: string, size?: number}} options `sha256`/`size` are the identity the caller expects the header to
 *   name (taken from the version record); a mismatch is `BACKUP_CHUNKED_HEADER_INVALID`
 * @returns {{ok: true, format: string, alg: string, sha256: string, size: number, chunkBytes: number, chunks: number,
 *   bytesRead: number, peakChunkBytes: number}}
 * @throws {ChunkedError} `BACKUP_CHUNKED_HEADER_INVALID` / `BACKUP_CHUNKED_AUTH_FAILED` / `BACKUP_CHUNKED_TRUNCATED` /
 *   `BACKUP_CHUNKED_ORDER` / `BACKUP_CHUNKED_TRAILING` / `BACKUP_CHUNKED_ARGUMENT_INVALID` / `BACKUP_CHUNKED_READ_FAILED`
 */
export function openChunkedStream(source, options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, 'opening needs an options object carrying the DEK');
  }
  const { dek } = options;
  if (!isDek(dek)) {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, `a DEK must be ${DEK_LENGTH} bytes`);
  }
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
  const expectedSha = options.sha256 === undefined || options.sha256 === null ? null : options.sha256;
  const expectedSize = options.size === undefined || options.size === null ? null : options.size;
  if (expectedSha !== null && (typeof expectedSha !== 'string' || !SHA256_RE.test(expectedSha))) {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, 'the expected sha256 must be 64 lowercase hex characters');
  }
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new ChunkedError(CHUNKED_CODES.ARGUMENT_INVALID, `the expected size must be a non-negative integer, got ${show(options.size)}`);
  }

  const reader = createSource(source);
  let bytesRead = 0;
  try {
    const magic = reader.readUpTo(CHUNKED_MAGIC.length);
    bytesRead += magic.length;
    if (magic.length !== CHUNKED_MAGIC.length || !magic.equals(CHUNKED_MAGIC)) {
      throw new ChunkedError(
        CHUNKED_CODES.HEADER_INVALID,
        magic.length < CHUNKED_MAGIC.length
          ? `the file is ${magic.length} bytes, shorter than the ${CHUNKED_MAGIC.length}-byte v2 magic`
          : `the file does not start with the ${JSON.stringify(CHUNKED_MAGIC.toString('ascii'))} v2 magic`,
      );
    }
    const parsed = readHeader(reader);
    bytesRead += parsed.bytes;
    const { header } = parsed;
    if (expectedSha !== null && expectedSha !== header.sha256) {
      throw new ChunkedError(
        CHUNKED_CODES.HEADER_INVALID,
        `the header seals the plaintext with sha256 ${header.sha256}, not the expected ${expectedSha}: this copy belongs to another version`,
      );
    }
    if (expectedSize !== null && expectedSize !== header.size) {
      throw new ChunkedError(
        CHUNKED_CODES.HEADER_INVALID,
        `the header seals ${header.size} plaintext bytes, not the expected ${expectedSize}: this copy belongs to another version`,
      );
    }

    const chunks = chunkCountFor(header.size, header.chunkBytes);
    const hash = createHash('sha256');
    const seenNonces = new Map();
    const trackNonces = chunks <= MAX_TRACKED_NONCES;
    let size = 0;
    let peakChunkBytes = 0;
    for (let index = 0; index < chunks; index += 1) {
      const plaintextLength = chunkPlaintextLength(header.size, header.chunkBytes, index);
      const recordLength = NONCE_LENGTH + plaintextLength + TAG_LENGTH;
      const record = reader.readUpTo(recordLength);
      bytesRead += record.length;
      if (record.length !== recordLength) {
        throw new ChunkedError(
          CHUNKED_CODES.TRUNCATED,
          `chunk ${index} of ${chunks} is ${record.length} of ${recordLength} bytes: the file ends before the header's ${header.size} bytes`,
        );
      }
      peakChunkBytes = Math.max(peakChunkBytes, record.length);
      const nonce = record.subarray(0, NONCE_LENGTH);
      const tag = record.subarray(record.length - TAG_LENGTH);
      const ciphertext = record.subarray(NONCE_LENGTH, record.length - TAG_LENGTH);
      const aad = chunkedAad({ sha256: header.sha256, size: header.size, chunkIndex: index });
      let plaintext;
      try {
        plaintext = openRecord({ dek, nonce, ciphertext, tag, aad });
      } catch {
        const classified = classifyFailure({ dek, record, index, chunks, header, seenNonces });
        throw new ChunkedError(classified.code, classified.detail, { index, chunk_index: index });
      }
      if (trackNonces) seenNonces.set(nonce.toString('hex'), index);
      hash.update(plaintext);
      const offset = size;
      size += plaintext.length;
      if (onChunk !== null) onChunk({ index, plaintext, size: plaintext.length, offset });
    }

    if (reader.readUpTo(1).length > 0) {
      throw new ChunkedError(
        CHUNKED_CODES.TRAILING,
        `the ${chunks} chunk(s) the header declares decoded and then the file continues: the record framing and the header disagree`,
      );
    }

    const digest = hash.digest('hex');
    if (size !== header.size || digest !== header.sha256) {
      // Unreachable while the AAD binds both fields, and checked anyway: a future change to the AAD must not be
      // able to turn "the bytes are not the file this header names" into a silent success.
      throw new ChunkedError(
        CHUNKED_CODES.AUTH_FAILED,
        `the ${chunks} authenticated chunk(s) decrypt to ${size} bytes / ${digest}, not the header's ${header.size} bytes / ${header.sha256}`,
      );
    }
    return {
      ok: true,
      format: CHUNKED_FORMAT,
      alg: AEAD,
      sha256: digest,
      size,
      chunkBytes: header.chunkBytes,
      chunks,
      bytesRead,
      peakChunkBytes,
    };
  } finally {
    reader.close();
  }
}

/**
 * Whole-buffer convenience over {@link openChunkedStream}: decrypt everything and return the plaintext.
 *
 * For small files and tests only -- `bytes` is the allocation this format exists to avoid for a large copy. The
 * chunks are copied out of their record buffers, so the returned Buffer does not keep the sealed bytes alive.
 *
 * @param {Buffer|string} source
 * @param {{dek: Buffer, sha256?: string, size?: number}} options
 * @returns {{ok: true, format: string, alg: string, sha256: string, size: number, chunkBytes: number, chunks: number,
 *   bytesRead: number, peakChunkBytes: number, bytes: Buffer}}
 * @throws {ChunkedError} as {@link openChunkedStream}
 */
export function openChunkedBuffer(source, options = {}) {
  const parts = [];
  const opened = openChunkedStream(source, {
    ...options,
    onChunk: (chunk) => {
      parts.push(Buffer.from(chunk.plaintext));
    },
  });
  return { ...opened, bytes: Buffer.concat(parts, opened.size) };
}
