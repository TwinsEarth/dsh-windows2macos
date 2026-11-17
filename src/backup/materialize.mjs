/**
 * Materialising stored files: turn a manifest entry's blocks back into the exact bytes.
 *
 * Used by verify (to check the whole store), archive (to pack a snapshot) and restore (to publish bytes back into
 * the home). One implementation matters: the engine sealed each block with an identity bound to its content
 * address, so the reader must pass exactly `{sha256, length}` -- a second implementation that guessed the AAD
 * would fail only on the machine that tried to restore.
 */

import fs from 'node:fs';
import path from 'node:path';

import { repoPaths } from './layout.mjs';
import { openObject } from './crypto.mjs';

/** Absolute path of a block object. */
export function objectFile(root, sha256) {
  return path.join(repoPaths(root).objects, sha256.slice(0, 2), sha256);
}

/**
 * Rebuild one file from its manifest entry.
 *
 * @param {{root: string, entry: object, dek: Buffer}} input
 * @returns {{ok: true, buffer: Buffer} | {ok: false, code: string, detail: string}}
 */
export function rebuildFile(input) {
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
 * @param {{root: string, entry: object, dek: Buffer}} input
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
