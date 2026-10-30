/**
 * Artifact Ferry v1（本地最小闭环）：chunkFile → ArtifactRef → sink 接收端。
 *
 * 不变式：
 *   · 控制面只持引用（ref/rootCid/size/chunkCount），字节永远在本机或 sink；
 *   · 发送端流式分块，内存与文件大小无关；每块 SHA-256；
 *   · 接收端逐块校验、位图持久化、可断点续传；finalize 重算根才原子落盘；
 *   · 路径只允许 sink 根下的相对路径（拒绝绝对路径/.. /盘符/UNC）。
 * 本阶段不做远端 P2P 拉取：`pull` 明确返回 P2P_UNAVAILABLE，绝不回落 relay blob。
 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createManifest, chunkLengths, chunkRange } from './manifest.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ROOT = /^sha256:[0-9a-f]{64}$/;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function safeRelative(input) {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, code: 'PATH_REQUIRED' };
  const raw = input.replace(/\\/g, '/');
  if (raw.includes('\0')) return { ok: false, code: 'PATH_NUL' };
  if (isAbsolute(input) || /^[A-Za-z]:/.test(raw) || raw.startsWith('//')) return { ok: false, code: 'PATH_ABSOLUTE' };
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return { ok: false, code: 'PATH_TRAVERSAL' };
  return { ok: true, relative: parts.join('/') };
}

/** 流式分块：只读一块、算一块的哈希；返回 rootCid 与块清单。 */
export function chunkFile(filePath, { chunkBytes = 1024 * 1024 } = {}) {
  const stat = statSync(filePath);
  const plan = chunkLengths(stat.size, chunkBytes);
  if (plan.ok !== true) return plan;
  const fd = openSync(filePath, 'r');
  const chunks = [];
  try {
    for (let index = 0; index < plan.count; index += 1) {
      const length = index === plan.count - 1 ? plan.lastChunkBytes : plan.chunkBytes;
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, index * plan.chunkBytes);
      if (read !== length) return { ok: false, code: 'XFER_READ_SHORT' };
      const digest = sha256(buf);
      chunks.push({ index, cid: 'sha256:' + digest, sha256: digest, size: length });
    }
  } finally {
    closeSync(fd);
  }
  const built = createManifest({
    sizeBytes: stat.size,
    chunkBytes: plan.chunkBytes,
    chunkHashes: chunks.map((chunk) => chunk.sha256),
    objectId: sha256(`${stat.size}:${plan.chunkBytes}:${chunks.map((c) => c.sha256).join('')}`).slice(0, 32),
    kind: 'file',
    sinkKind: 'cache',
    relPath: basename(filePath),
  });
  if (built.ok !== true) return built;
  return {
    ok: true,
    rootCid: 'sha256:' + built.manifest.root_sha256,
    rootHex: built.manifest.root_sha256,
    size: stat.size,
    chunkBytes: plan.chunkBytes,
    chunkCount: plan.count,
    chunks,
  };
}

/** 控制面引用：只含元数据，不含字节、块清单或路径。 */
export function createRefV2({ rootCid, size, chunkCount, chunkBytes, originPeer, sinkHint = 'workspace://artifacts', mediaType = 'application/octet-stream', refId = null }) {
  if (typeof rootCid !== 'string' || !ROOT.test(rootCid)) return { ok: false, code: 'ARTIFACT_ROOT_INVALID' };
  if (!Number.isSafeInteger(size) || size < 0) return { ok: false, code: 'ARTIFACT_SIZE_INVALID' };
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) return { ok: false, code: 'ARTIFACT_CHUNKS_INVALID' };
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) return { ok: false, code: 'ARTIFACT_CHUNK_SIZE_INVALID' };
  if (typeof originPeer !== 'string' || originPeer === '') return { ok: false, code: 'ARTIFACT_ORIGIN_REQUIRED' };
  return { ok: true, ref: { v: 2, ref: refId ?? rootCid, rootCid, size, chunkCount, chunkBytes, mediaType, originPeer, sinkHint } };
}

export function verifyRefV2(ref) {
  if (ref === null || typeof ref !== 'object' || ref.v !== 2) return { ok: false, code: 'ARTIFACT_REF_INVALID' };
  if (typeof ref.ref !== 'string' || ref.ref === '') return { ok: false, code: 'ARTIFACT_REF_INVALID' };
  if (typeof ref.rootCid !== 'string' || !ROOT.test(ref.rootCid)) return { ok: false, code: 'ARTIFACT_ROOT_INVALID' };
  if (!Number.isSafeInteger(ref.size) || ref.size < 0 || !Number.isSafeInteger(ref.chunkCount) || ref.chunkCount < 0) return { ok: false, code: 'ARTIFACT_REF_INVALID' };
  const plan = chunkLengths(ref.size, ref.chunkBytes);
  if (plan.ok !== true) return plan;
  if (plan.count !== ref.chunkCount) return { ok: false, code: 'ARTIFACT_REF_INCONSISTENT', detail: { expectedChunks: plan.count, chunkCount: ref.chunkCount } };
  if (typeof ref.originPeer !== 'string' || ref.originPeer === '') return { ok: false, code: 'ARTIFACT_ORIGIN_REQUIRED' };
  return { ok: true };
}

/** 本地引用索引（控制面的本机替身；relay 发布是下一阶段接线）。 */
export function createRefIndex({ dir }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileOf = (refId) => join(dir, sha256(String(refId)) + '.json');
  return {
    publish(ref) {
      const checked = verifyRefV2(ref);
      if (checked.ok !== true) return checked;
      const file = fileOf(ref.ref);
      writeFileSync(file, JSON.stringify(ref), { encoding: 'utf8', mode: 0o600 });
      return { ok: true, ref, path: file };
    },
    get(refId) {
      try {
        const ref = readJson(fileOf(refId));
        const checked = verifyRefV2(ref);
        return checked.ok === true ? { ok: true, ref } : checked;
      } catch { return { ok: false, code: 'ARTIFACT_REF_NOT_FOUND' }; }
    },
    list() {
      return { ok: true, refs: readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => { try { return readJson(join(dir, n)); } catch { return null; } }).filter(Boolean) };
    },
  };
}

/**
 * 接收端：位图持久化 + 逐块校验 + finalize 根校验后原子落盘。
 * @param {{stateDir:string, sinkRoot:string, ref:object, destination:string, chunkBytes?:number}} input
 */
export function createReceiver({ stateDir, sinkRoot, ref, destination, chunkBytes = null }) {
  const checked = verifyRefV2(ref);
  if (checked.ok !== true) return checked;
  const safe = safeRelative(destination);
  if (safe.ok !== true) return safe;
  const root = resolve(sinkRoot);
  const target = resolve(root, safe.relative);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return { ok: false, code: 'PATH_TRAVERSAL' };
  const transferId = sha256(ref.ref + '|' + ref.rootCid + '|' + ref.size).slice(0, 32);
  const dir = join(stateDir, transferId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bitmapPath = join(dir, 'bitmap.json');
  const partPath = join(dir, 'data.part');
  const chunk = Number.isInteger(chunkBytes) ? chunkBytes : ref.chunkBytes;
  let bitmap = null;
  if (existsSync(bitmapPath)) {
    try { bitmap = readJson(bitmapPath); } catch { bitmap = null; }
    if (bitmap !== null && (bitmap.rootCid !== ref.rootCid || bitmap.size !== ref.size || bitmap.chunkBytes !== chunk)) return { ok: false, code: 'XFER_SESSION_CONFLICT' };
  }
  if (bitmap === null) {
    const fd = openSync(partPath, 'w+', 0o600);
    try { ftruncateSync(fd, ref.size); } finally { closeSync(fd); }
    bitmap = { v: 1, transferId, rootCid: ref.rootCid, size: ref.size, chunkBytes: chunk, chunkCount: ref.chunkCount, chunks: ref.chunkCount, chunk_bytes: chunk, last_chunk_bytes: ref.chunkCount === 0 ? 0 : ref.size - (ref.chunkCount - 1) * chunk, hashes: Array(ref.chunkCount).fill(null), destination: safe.relative, updatedAt: new Date().toISOString() };
    writeFileSync(bitmapPath, JSON.stringify(bitmap), { encoding: 'utf8', mode: 0o600 });
  }
  const save = () => { bitmap.updatedAt = new Date().toISOString(); const tmp = bitmapPath + '.tmp-' + process.pid; writeFileSync(tmp, JSON.stringify(bitmap), { encoding: 'utf8', mode: 0o600 }); renameSync(tmp, bitmapPath); };
  let finalized = false;
  return {
    ok: true,
    transferId,
    have() {
      return new Set(bitmap.hashes.map((h, i) => (h === null ? null : i)).filter((i) => i !== null));
    },
    progress() {
      const received = bitmap.hashes.map((h, i) => (h === null ? null : i)).filter((i) => i !== null);
      return { total: bitmap.chunkCount, received: received.length, complete: received.length === bitmap.chunkCount, bytes: bitmap.hashes.reduce((sum, h, i) => sum + (h === null ? 0 : i === bitmap.chunkCount - 1 ? bitmap.size - i * chunk : chunk), 0) };
    },
    writeChunk(index, data, expectedSha256) {
      if (finalized) return { ok: false, code: 'XFER_ALREADY_FINALIZED' };
      const range = chunkRange(bitmap, index);
      if (range === null) return { ok: false, code: 'XFER_CHUNK_INDEX_INVALID' };
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
      if (buf.length !== range.length) return { ok: false, code: 'XFER_CHUNK_LENGTH_INVALID', detail: { expected: range.length, got: buf.length } };
      const digest = sha256(buf);
      if (typeof expectedSha256 !== 'string' || expectedSha256 !== digest) return { ok: false, code: 'XFER_CHUNK_HASH_MISMATCH', retry: index };
      if (bitmap.hashes[index] !== null && bitmap.hashes[index] !== digest) return { ok: false, code: 'XFER_CHUNK_CONFLICT', recoverable: true, retry: index };
      if (bitmap.hashes[index] === digest) return { ok: true, duplicate: true, index };
      const fd = openSync(partPath, 'r+');
      try { writeSync(fd, buf, 0, buf.length, range.offset); } finally { closeSync(fd); }
      bitmap.hashes[index] = digest;
      save();
      return { ok: true, index, sha256: digest, writtenBytes: buf.length };
    },
    finalizeTransfer(rootCid = ref.rootCid) {
      if (rootCid !== ref.rootCid) return { ok: false, code: 'XFER_ROOT_MISMATCH' };
      if (bitmap.hashes.some((h) => h === null)) return { ok: false, code: 'XFER_CHUNKS_MISSING', detail: { missing: bitmap.hashes.filter((h) => h === null).length } };
      const built = createManifest({ sizeBytes: bitmap.size, chunkBytes: bitmap.chunkBytes, chunkHashes: bitmap.hashes, objectId: transferId, kind: 'file', sinkKind: 'cache', relPath: safe.relative });
      if (built.ok !== true) return built;
      if ('sha256:' + built.manifest.root_sha256 !== rootCid) return { ok: false, code: 'XFER_ROOT_MISMATCH' };
      mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
      const fd = openSync(partPath, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(partPath, target);
      finalized = true;
      try { writeFileSync(join(dir, 'done.json'), JSON.stringify({ transferId, rootCid, size: bitmap.size, path: target, at: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 }); } catch { /* receipt is best effort */ }
      return { ok: true, path: target, verified: true, bytes: bitmap.size, transferId };
    },
    /** Explicit recovery for a conflicting source: drop the claimed block so a correct source can win. */
    evictChunk(index) {
      if (!Number.isInteger(index) || index < 0 || index >= bitmap.chunkCount) return { ok: false, code: 'XFER_CHUNK_INDEX_INVALID' };
      if (bitmap.hashes[index] === null) return { ok: true, index, alreadyMissing: true };
      bitmap.hashes[index] = null;
      save();
      return { ok: true, index, evicted: true };
    },
    /** 远端 P2P 拉取尚未接线：显式失败，不回落 relay。 */
    async pullFrom(originPeer) {
      return { ok: false, code: 'P2P_UNAVAILABLE', detail: { originPeer, why: 'want-block transport is a later slice; relay fallback is forbidden' } };
    },
  };
}
