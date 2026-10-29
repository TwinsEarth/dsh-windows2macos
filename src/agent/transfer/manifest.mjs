/**
 * 文件分块清单（C1 的最小可信底座）。
 *
 * 纯函数，无 I/O：给定文件大小与块大小，产出一份可独立校验的 manifest。
 * root = SHA256("w2m-xfer-root-v1" || size || chunkBytes || 逐块 SHA256)，域分离避免
 * 叶哈希/根哈希/不同切法互相混淆；manifest 本身不再包含明文内容。
 */
import { createHash } from 'node:crypto';

export const XFER_VERSION = 1;
export const DEFAULT_CHUNK_BYTES = 256 * 1024;
export const MIN_CHUNK_BYTES = 16 * 1024;
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_CHUNKS = 65536;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function chunkLengths(sizeBytes, chunkBytes = DEFAULT_CHUNK_BYTES) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return { ok: false, code: 'XFER_SIZE_INVALID' };
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES || chunkBytes > MAX_CHUNK_BYTES) return { ok: false, code: 'XFER_CHUNK_SIZE_INVALID' };
  if (sizeBytes === 0) return { ok: true, count: 0, chunkBytes, lastChunkBytes: 0 };
  const count = Math.ceil(sizeBytes / chunkBytes);
  if (count > MAX_CHUNKS) return { ok: false, code: 'XFER_TOO_MANY_CHUNKS', detail: { count, max: MAX_CHUNKS } };
  return { ok: true, count, chunkBytes, lastChunkBytes: sizeBytes % chunkBytes === 0 ? chunkBytes : sizeBytes % chunkBytes };
}

export function chunkSha256(bytes) {
  return sha256(bytes);
}

/**
 * @param {{sizeBytes:number, chunkBytes?:number, chunkHashes:string[], objectId:string, taskId?:string|null,
 *          machineId?:string|null, kind?:string, sinkKind?:string, relPath:string, cipherBytes?:number}} input
 */
export function createManifest(input) {
  const plan = chunkLengths(input.sizeBytes, input.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  if (plan.ok !== true) return plan;
  const hashes = Array.isArray(input.chunkHashes) ? input.chunkHashes : [];
  if (hashes.length !== plan.count) return { ok: false, code: 'XFER_CHUNK_COUNT_MISMATCH', detail: { expected: plan.count, got: hashes.length } };
  for (const hash of hashes) if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, code: 'XFER_CHUNK_HASH_INVALID' };
  const root = createHash('sha256')
    .update('w2m-xfer-root-v1\0')
    .update(String(input.sizeBytes) + '\0' + String(plan.chunkBytes) + '\0')
    .update(hashes.join('\0'))
    .digest('hex');
  return {
    ok: true,
    manifest: {
      v: XFER_VERSION,
      object_id: input.objectId,
      task_id: input.taskId ?? null,
      machine_id: input.machineId ?? null,
      kind: typeof input.kind === 'string' ? input.kind : 'stdout',
      sink: { kind: typeof input.sinkKind === 'string' ? input.sinkKind : 'cache', rel_path: input.relPath },
      size_bytes: input.sizeBytes,
      chunk_bytes: plan.chunkBytes,
      chunks: plan.count,
      last_chunk_bytes: plan.lastChunkBytes,
      chunk_hashes: hashes.slice(),
      root_sha256: root,
    },
  };
}

export function verifyManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') return { ok: false, code: 'XFER_MANIFEST_INVALID' };
  if (manifest.v !== XFER_VERSION) return { ok: false, code: 'XFER_MANIFEST_VERSION' };
  if (typeof manifest.object_id !== 'string' || !/^[0-9a-f]{32,64}$/.test(manifest.object_id)) return { ok: false, code: 'XFER_OBJECT_ID_INVALID' };
  if (!Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes < 0) return { ok: false, code: 'XFER_SIZE_INVALID' };
  const rebuilt = createManifest({
    sizeBytes: manifest.size_bytes,
    chunkBytes: manifest.chunk_bytes,
    chunkHashes: manifest.chunk_hashes,
    objectId: manifest.object_id,
    taskId: manifest.task_id,
    machineId: manifest.machine_id,
    kind: manifest.kind,
    sinkKind: manifest.sink?.kind,
    relPath: manifest.sink?.rel_path,
  });
  if (rebuilt.ok !== true) return rebuilt;
  if (rebuilt.manifest.root_sha256 !== manifest.root_sha256) return { ok: false, code: 'XFER_ROOT_MISMATCH' };
  return { ok: true };
}

/** 某一块在文件中的字节偏移与长度（最后一块较短）。 */
export function chunkRange(manifest, index) {
  if (!Number.isInteger(index) || index < 0 || index >= manifest.chunks) return null;
  const offset = index * manifest.chunk_bytes;
  const length = index === manifest.chunks - 1 ? manifest.last_chunk_bytes : manifest.chunk_bytes;
  return { offset, length };
}
