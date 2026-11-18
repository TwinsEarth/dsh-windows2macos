/**
 * Zstandard frame primitives (RFC 8878) for the session artifact container.
 *
 * A DSH session log is a sequence of independent, checksummed Zstandard frames:
 * one durable event per frame in the format these tools read. This module walks
 * that container and compresses/decompresses exactly one frame at a time, so a
 * repair appends a new frame instead of rewriting the log.
 *
 * Ported from `dsh-fix-attachments` (MIT, Copyright (c) 2026 xuzhunzhi), whose
 * implementation was written from the specification. Kept dependency-free on
 * purpose: the rest of this package has no runtime dependencies, and the only
 * thing needed here is Node's built-in zstd API (Node >= 22.15).
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

export const ZSTD_MAGIC = 0xfd2fb528; // little-endian on disk
export const CHECKSUM_OPTIONS = {
  params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
};

/** Whether this Node exposes the synchronous Zstandard API. */
export function hasZstd() {
  return typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';
}

/**
 * Walk the container and return the byte range of every complete frame.
 *
 * A trailing partial frame is reported as `tornStart` instead of throwing: a
 * crash during append can leave one, and callers must not treat it as
 * corruption of the frames that came before. A reserved bit or block type is
 * a real format error and still throws.
 *
 * @param {Buffer} buf
 * @param {number} [maxFrames]
 * @returns {{frames: Array<{start: number, end: number, hasChecksum: boolean}>, tornStart?: number}}
 */
export function scanFrames(buf, maxFrames = Number.POSITIVE_INFINITY) {
  return scanFramesWith(
    {
      length: buf.length,
      readUInt32LE: (offset) => buf.readUInt32LE(offset),
      readUInt8: (offset) => buf.readUInt8(offset),
      readUIntLE: (offset, bytes) => buf.readUIntLE(offset, bytes),
    },
    maxFrames,
  );
}

/**
 * The frame walker over any random-access byte source.
 *
 * `scanFrames` (a Buffer) and `scanFramesFromFile` (a file descriptor) are the same implementation: the walk reads
 * only frame/block **headers**, never payload bytes, so walking a 118 MB log costs kilobytes of reads. That is what
 * lets the streaming store path check for a torn tail without holding the file (v3.5.1).
 *
 * @param {{length: number, readUInt32LE: (offset: number) => number,
 *   readUInt8: (offset: number) => number, readUIntLE: (offset: number, bytes: number) => number}} reader
 * @param {number} [maxFrames]
 * @returns {{frames: Array<{start: number, end: number, hasChecksum: boolean}>, tornStart?: number}}
 */
function scanFramesWith(reader, maxFrames = Number.POSITIVE_INFINITY) {
  const length = reader.length;
  const frames = [];
  let offset = 0;
  while (offset < length) {
    const start = offset;
    if (length - offset < 4) return { frames, tornStart: start };
    if (reader.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === length) return { frames, tornStart: start };

    const descriptor = reader.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`reserved frame-header bit set at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const hasChecksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;

    const rest = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (length - offset < rest) return { frames, tornStart: start };
    offset += rest;

    for (;;) {
      if (length - offset < 3) return { frames, tornStart: start };
      const blockHeader = reader.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (hasChecksum) {
      if (length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset, hasChecksum });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * Walk the frames of a file on disk without reading the file's payload into memory.
 *
 * A 256 KiB positional window backs the header reads; frame payloads are skipped by size. Peak memory is the
 * window, not the file. Throws the same format errors as {@link scanFrames} and reports a trailing partial frame
 * as `tornStart`.
 *
 * @param {string} file
 * @param {{windowBytes?: number}} [options]
 * @returns {{frames: Array<{start: number, end: number, hasChecksum: boolean}>, tornStart?: number, file_bytes: number}}
 */
export function scanFramesFromFile(file, options = {}) {
  const windowBytes = Number.isSafeInteger(options.windowBytes) && options.windowBytes >= 4096
    ? options.windowBytes
    : 256 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let windowStart = -1;
    let window = null;
    /** Make sure [pos, pos+need) is inside the cached window; refill on a miss. */
    const ensure = (pos, need) => {
      if (window !== null && pos >= windowStart && pos + need <= windowStart + window.length) return true;
      const length = Math.min(windowBytes, size - pos);
      if (length < need) return false;
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, pos);
      window = read === length ? buffer : buffer.subarray(0, read);
      windowStart = pos;
      return window.length >= need;
    };
    const reader = {
      length: size,
      readUInt32LE(pos) {
        if (!ensure(pos, 4)) throw new Error(`short read at byte ${pos}`);
        return window.readUInt32LE(pos - windowStart);
      },
      readUInt8(pos) {
        if (!ensure(pos, 1)) throw new Error(`short read at byte ${pos}`);
        return window.readUInt8(pos - windowStart);
      },
      readUIntLE(pos, bytes) {
        if (!ensure(pos, bytes)) throw new Error(`short read at byte ${pos}`);
        return window.readUIntLE(pos - windowStart, bytes);
      },
    };
    const walked = scanFramesWith(reader);
    return { ...walked, file_bytes: size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Compress one independently decodable, checksummed frame.
 *
 * The round trip is verified here rather than trusted: the bytes this returns
 * are appended to a user's durable session log, and a silent compressor defect
 * would corrupt it one frame later.
 *
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function compressFrame(payload) {
  const frame = zlib.zstdCompressSync(payload, CHECKSUM_OPTIONS);
  if (frame.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error('compressed frame has wrong magic');
  if ((frame.readUInt8(4) & 4) === 0) throw new Error('compressed frame lacks the checksum flag');
  const back = zlib.zstdDecompressSync(frame).toString('utf8');
  if (back !== payload.toString('utf8')) throw new Error('compressed frame failed roundtrip');
  return frame;
}

/**
 * Decompress exactly one complete frame, validating its checksum.
 *
 * @param {Buffer} slice
 * @returns {string}
 */
export function decompressFrame(slice) {
  return zlib.zstdDecompressSync(slice).toString('utf8');
}
