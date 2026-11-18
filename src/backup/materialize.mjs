/**
 * Materialising stored files: turn a manifest entry's blocks back into the exact bytes.
 *
 * Used by verify (to check the whole store), archive (to pack a snapshot) and restore (to publish bytes back into
 * the home). One implementation matters: the engine sealed each block with an identity bound to its content
 * address, so the reader must pass exactly `{sha256, length}` -- a second implementation that guessed the AAD
 * would fail only on the machine that tried to restore.
 *
 * ## Two readers since 3.5.1: bytes and digest
 *
 * `rebuildFile` returns the whole file as one Buffer. That is right for restore, which must write the bytes, and
 * for small verify entries. It is **wrong** for a 118 MB session log in a 4 GB host: 3.5.0 crashed the desktop
 * host in `verifyRepo` by materialising whole files once per snapshot. `digestEntryStreaming` is the second reader:
 * it decrypts and hashes one block at a time (4 MiB in production), so a file larger than the threshold costs one
 * block of memory, not the file. Both readers go through `openObject`, so the digest they accept is the same.
 *
 * ## The memory guard
 *
 * Every materialisation asks `memoryGuard` first, with the bytes it is about to allocate. When the answer is no,
 * the caller gets the named `BACKUP_MEMORY_GUARD` refusal instead of an allocation the host cannot survive. The
 * default ceiling is 1.5 GB of `heapUsed`; callers can pass `maxHeapBytes` (0 disables it explicitly) and a
 * pre-built report to accumulate the decisions.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { repoPaths } from './layout.mjs';
import { openObject } from './crypto.mjs';
import { BACKUP_MEMORY_GUARD, checkMemory, resolveMaxHeapBytes } from './memory-guard.mjs';

/**
 * Verify entries at or above this size are digest-checked block-by-block instead of materialised whole (v3.5.1).
 * 32 MiB is well under the smallest whole-file cast the incident measured (a 45.6 MB log) and over every small
 * fixture the suites use, so a test can force either reader by passing its own threshold.
 */
export const DEFAULT_STREAM_THRESHOLD_BYTES = 32 * 1024 * 1024;

/** A single entry larger than this is refused by verify's whole-file old-copy reader instead of buffered. */
export const DEFAULT_OLD_COPY_MAX_BYTES = 512 * 1024 * 1024;

/** Absolute path of a block object. */
export function objectFile(root, sha256) {
  return path.join(repoPaths(root).objects, sha256.slice(0, 2), sha256);
}

/** The number of bytes a whole-file rebuild of this entry will allocate (plaintext plus the sealed copies). */
function materialiseBytes(entry) {
  if (Number.isSafeInteger(entry?.size) && entry.size >= 0) return entry.size;
  let total = 0;
  for (const block of entry?.blocks ?? []) if (Number.isSafeInteger(block?.length)) total += block.length;
  return total;
}

/**
 * Rebuild one file from its manifest entry.
 *
 * @param {{root: string, entry: object, dek: Buffer, maxHeapBytes?: number|null,
 *   memoryReport?: object|null}} input `maxHeapBytes` defaults to the process-wide 1.5 GB guard; `0` disables it.
 * @returns {{ok: true, buffer: Buffer} | {ok: false, code: string, detail: string}}
 */
export function rebuildFile(input) {
  const limit = resolveMaxHeapBytes(input.maxHeapBytes);
  const guard = checkMemory(input.memoryReport ?? null, {
    requestedBytes: materialiseBytes(input.entry) * 2,
    maxHeapBytes: limit.ok === true ? limit.maxHeapBytes : undefined,
    label: typeof input.entry?.rel === 'string' ? input.entry.rel : 'file materialisation',
  });
  if (guard.ok !== true) return { ok: false, code: BACKUP_MEMORY_GUARD, detail: guard.detail };
  const parts = [];
  for (const block of input.entry.blocks ?? []) {
    const file = objectFile(input.root, block.sha256);
    let sealed;
    try {
      sealed = fs.readFileSync(file);
    } catch (error) {
      return { ok: false, code: 'BACKUP_OBJECT_MISSING', detail: `${objectFile(input.root, block.sha256)}: ${error?.code ?? 'unreadable'}` };
    }
    try {
      parts.push(openObject(sealed, input.dek, { sha256: block.sha256, length: block.length }));
    } catch (error) {
      return { ok: false, code: error?.code ?? 'BACKUP_DECRYPT_AUTH_FAILED', detail: `${block.sha256}: ${error?.detail ?? error?.message ?? String(error)}` };
    }
  }
  return { ok: true, buffer: Buffer.concat(parts) };
}

/**
 * Rebuild one file and check it against the manifest: length and digest.
 *
 * @param {{root: string, entry: object, dek: Buffer, maxHeapBytes?: number|null,
 *   memoryReport?: object|null}} input
 * @returns {{ok: true, buffer: Buffer, digest: string} | {ok: false, code: string, detail: string}}
 */
export function rebuildFileChecked(input) {
  const rebuilt = rebuildFile(input);
  if (rebuilt.ok !== true) return rebuilt;
  if (rebuilt.buffer.length !== input.entry.size) {
    return { ok: false, code: 'BACKUP_SIZE_MISMATCH', detail: `${input.entry.rel}: rebuilt ${rebuilt.buffer.length} of ${input.entry.size} bytes` };
  }
  return { ok: true, buffer: rebuilt.buffer, digest: '' };
}

/**
 * Verify one stored file **without materialising it**: decrypt and hash one block at a time (v3.5.1).
 *
 * Peak memory is one sealed object plus its plaintext (a 4 MiB block, so ~8-12 MiB including the base64 step),
 * independent of the file size. Length and digest are checked exactly as `rebuildFile` + `sha256Hex` would check
 * them; the difference is only that the bytes never exist together.
 *
 * @param {{root: string, entry: object, dek: Buffer, maxHeapBytes?: number|null,
 *   memoryReport?: object|null}} input
 * @returns {{ok: true, size: number, digest: string, blocks: number, streaming: true, peak_block_bytes: number}
 *   | {ok: false, code: string, detail: string}}
 */
export function digestEntryStreaming(input) {
  const entry = input.entry;
  const limit = resolveMaxHeapBytes(input.maxHeapBytes);
  const maxHeapBytes = limit.ok === true ? limit.maxHeapBytes : undefined;
  const hash = createHash('sha256');
  let size = 0;
  let blocks = 0;
  let peakBlock = 0;
  for (const block of entry.blocks ?? []) {
    const file = objectFile(input.root, block.sha256);
    let sealed;
    try {
      sealed = fs.readFileSync(file);
    } catch (error) {
      return { ok: false, code: 'BACKUP_OBJECT_MISSING', detail: `${file}: ${error?.code ?? 'unreadable'}` };
    }
    peakBlock = Math.max(peakBlock, sealed.length);
    const guard = checkMemory(input.memoryReport ?? null, {
      requestedBytes: sealed.length * 3,
      maxHeapBytes,
      label: `${typeof entry.rel === 'string' ? entry.rel : 'file'}#${String(block.sha256).slice(0, 12)}`,
    });
    if (guard.ok !== true) return { ok: false, code: BACKUP_MEMORY_GUARD, detail: guard.detail };
    let plaintext;
    try {
      plaintext = openObject(sealed, input.dek, { sha256: block.sha256, length: block.length });
    } catch (error) {
      return { ok: false, code: error?.code ?? 'BACKUP_DECRYPT_AUTH_FAILED', detail: `${block.sha256}: ${error?.detail ?? error?.message ?? String(error)}` };
    }
    peakBlock = Math.max(peakBlock, plaintext.length);
    hash.update(plaintext);
    size += plaintext.length;
    blocks += 1;
  }
  const digest = hash.digest('hex');
  if (Number.isSafeInteger(entry.size) && size !== entry.size) {
    return { ok: false, code: 'BACKUP_SIZE_MISMATCH', detail: `${entry.rel}: rebuilt ${size} of ${entry.size} bytes (streaming reader)` };
  }
  if (typeof entry.sha256 === 'string' && digest !== entry.sha256) {
    return { ok: false, code: 'BACKUP_MANIFEST_DIGEST_MISMATCH', detail: `${entry.rel}: rebuilt bytes hash to ${digest}, manifest says ${entry.sha256} (streaming reader)` };
  }
  return { ok: true, size, digest, blocks, streaming: true, peak_block_bytes: peakBlock };
}
