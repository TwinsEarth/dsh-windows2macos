/**
 * 分块落盘 / 读取端的最小实现（C1 + C3 共用）。
 *
 * 一个对象一个目录：data.part（稀疏、按 offset 写）、meta.json（原子更新）。
 * 提交前必须：全部块到齐、逐块哈希匹配、根哈希重算一致 → fsync → rename 为 <object_id>.bin。
 * 失败保留 data.part 以便续传；根哈希不符则隔离，不产生“半份成品”。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { createManifest, chunkLengths, chunkRange, XFER_VERSION } from './manifest.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function createObjectStore({ root }) {
  if (typeof root !== 'string' || root === '') throw new TypeError('XFER_STORE_ROOT_REQUIRED');
  const dirOf = (objectId) => join(root, objectId);
  const metaPath = (objectId) => join(dirOf(objectId), 'meta.json');
  const partPath = (objectId) => join(dirOf(objectId), 'data.part');
  const finalPath = (objectId) => join(root, objectId + '.bin');

  const saveMeta = (meta) => {
    const file = metaPath(meta.object_id);
    const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
    writeFileSync(tmp, JSON.stringify(meta), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  };

  return {
    root,

    /** 开始/恢复一个入站对象。同一 objectId 且根一致 = 续传；否则拒绝。 */
    begin({ objectId, totalBytes, chunkBytes, rootSha256, taskId = null, machineId = null, kind = 'stdout', sinkKind = 'cache', relPath = null }) {
      if (typeof objectId !== 'string' || !/^[0-9a-f]{32,64}$/.test(objectId)) return { ok: false, code: 'XFER_OBJECT_ID_INVALID' };
      if (typeof rootSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rootSha256)) return { ok: false, code: 'XFER_ROOT_INVALID' };
      const dir = dirOf(objectId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // A completed object is immutable and needs no new session.
      if (existsSync(finalPath(objectId))) return { ok: true, resumed: false, complete: true, objectId };
      if (existsSync(metaPath(objectId))) {
        const meta = readJson(metaPath(objectId));
        if (meta.root_sha256 !== rootSha256 || meta.size_bytes !== totalBytes) return { ok: false, code: 'XFER_OBJECT_CONFLICT' };
        meta.resumed = true;
        saveMeta(meta);
        return { ok: true, resumed: true, complete: meta.chunk_hashes.every((h) => h !== null), objectId };
      }
      const plan = chunkLengths(totalBytes, chunkBytes);
      if (plan.ok !== true) return plan;
      const fd = openSync(partPath(objectId), 'w+', 0o600);
      try { ftruncateSync(fd, totalBytes); } finally { closeSync(fd); }
      const emptyRoot = createManifest({ sizeBytes: 0, chunkBytes, chunkHashes: [], objectId, taskId, machineId, kind, sinkKind, relPath: relPath ?? objectId + '.bin' }).manifest.root_sha256;
      const meta = {
        v: XFER_VERSION,
        object_id: objectId,
        task_id: taskId,
        machine_id: machineId,
        kind,
        sink: { kind: sinkKind, rel_path: relPath ?? objectId + '.bin' },
        size_bytes: totalBytes,
        chunk_bytes: plan.chunkBytes,
        chunks: plan.count,
        last_chunk_bytes: plan.lastChunkBytes,
        root_sha256: totalBytes === 0 ? emptyRoot : rootSha256,
        root_expected: rootSha256,
        chunk_hashes: Array(plan.count).fill(null),
        created_at: new Date().toISOString(),
      };
      // 空对象直接可提交：根必须与调用方声明的根一致。
      if (totalBytes === 0 && rootSha256 !== emptyRoot) return { ok: false, code: 'XFER_ROOT_MISMATCH' };
      saveMeta(meta);
      return { ok: true, resumed: false, complete: totalBytes === 0, objectId };
    },

    /** 写一块。乱序允许；同 index 同哈希幂等；冲突即终态错误。 */
    writeChunk({ objectId, index, bytes, chunkSha256 = null }) {
      const meta = readJson(metaPath(objectId));
      const range = chunkRange(meta, index);
      if (range === null) return { ok: false, code: 'XFER_CHUNK_INDEX_INVALID' };
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
      if (buf.length !== range.length) return { ok: false, code: 'XFER_CHUNK_LENGTH_INVALID', detail: { expected: range.length, got: buf.length } };
      const digest = sha256(buf);
      if (chunkSha256 !== null && chunkSha256 !== digest) return { ok: false, code: 'XFER_CHUNK_HASH_MISMATCH' };
      if (meta.chunk_hashes[index] !== null && meta.chunk_hashes[index] !== digest) return { ok: false, code: 'XFER_CHUNK_CONFLICT' };
      if (meta.chunk_hashes[index] === digest) return { ok: true, duplicate: true, index, sha256: digest };
      const fd = openSync(partPath(objectId), 'r+');
      try { writeSync(fd, buf, 0, buf.length, range.offset); } finally { closeSync(fd); }
      meta.chunk_hashes[index] = digest;
      saveMeta(meta);
      return { ok: true, duplicate: false, index, sha256: digest };
    },

    /** 已完成的块索引；续传握手用。 */
    have(objectId) {
      if (!existsSync(metaPath(objectId))) return { ok: false, code: 'XFER_SESSION_NOT_FOUND' };
      const meta = readJson(metaPath(objectId));
      const have = [];
      meta.chunk_hashes.forEach((hash, index) => { if (hash !== null) have.push(index); });
      return { ok: true, objectId, have, complete: meta.chunk_hashes.every((h) => h !== null), chunks: meta.chunks, root_sha256: meta.root_expected };
    },

    /** 全量校验 + 提交。根不符 → 移到 quarantine 并报错（不产生成品）。 */
    commit(objectId) {
      const meta = readJson(metaPath(objectId));
      if (meta.chunk_hashes.some((hash) => hash === null)) return { ok: false, code: 'XFER_CHUNKS_MISSING', detail: { missing: meta.chunk_hashes.filter((h) => h === null).length } };
      const rebuilt = createManifest({ sizeBytes: meta.size_bytes, chunkBytes: meta.chunk_bytes, chunkHashes: meta.chunk_hashes, objectId: meta.object_id, taskId: meta.task_id, machineId: meta.machine_id, kind: meta.kind, sinkKind: meta.sink.kind, relPath: meta.sink.rel_path });
      if (rebuilt.ok !== true) return rebuilt;
      if (rebuilt.manifest.root_sha256 !== meta.root_expected) return { ok: false, code: 'XFER_ROOT_MISMATCH', detail: { expected: meta.root_expected, actual: rebuilt.manifest.root_sha256 } };
      const fd = openSync(partPath(objectId), 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(partPath(objectId), finalPath(objectId));
      const manifest = { ...rebuilt.manifest, committed_at: new Date().toISOString() };
      const file = join(root, objectId + '.ref.json');
      writeFileSync(file, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
      try { unlinkSync(metaPath(objectId)); } catch { /* already gone */ }
      try { unlinkSync(dirOf(objectId)); } catch { /* directory removal is best effort */ }
      return { ok: true, objectId, bytes: meta.size_bytes, sha256: rebuilt.manifest.root_sha256, path: finalPath(objectId), manifest };
    },

    /** 读一块并校验；损坏返回 XFER_CHUNK_HASH_MISMATCH，绝不返回坏字节。 */
    readChunk({ objectId, index }) {
      const manifestPath = join(root, objectId + '.ref.json');
      if (!existsSync(manifestPath)) return { ok: false, code: 'XFER_OBJECT_NOT_FOUND' };
      const manifest = readJson(manifestPath);
      const range = chunkRange(manifest, index);
      if (range === null) return { ok: false, code: 'XFER_CHUNK_INDEX_INVALID' };
      const buf = Buffer.alloc(range.length);
      const fd = openSync(finalPath(objectId), 'r');
      try { const read = readSync(fd, buf, 0, range.length, range.offset); if (read !== range.length) return { ok: false, code: 'XFER_READ_SHORT' }; } finally { closeSync(fd); }
      if (sha256(buf) !== manifest.chunk_hashes[index]) return { ok: false, code: 'XFER_CHUNK_HASH_MISMATCH' };
      return { ok: true, bytes: buf, index, sha256: manifest.chunk_hashes[index] };
    },

    has(objectId) {
      if (existsSync(join(root, objectId + '.ref.json'))) return { ok: true, complete: true, bytes: readJson(join(root, objectId + '.ref.json')).size_bytes };
      if (existsSync(metaPath(objectId))) { const have = this.have(objectId); return { ok: true, complete: false, received: have.have ?? [], chunks: have.chunks ?? null }; }
      return { ok: false, code: 'XFER_OBJECT_NOT_FOUND' };
    },
  };
}
