/**
 * P2P want-block 协议（传输无关的最小实现）。
 *
 * 帧只在两台机器之间流动，绝不经过 relay：
 *   xfer.want   { transferId, rootCid, indices }
 *   xfer.chunk  { transferId, index, sha256, size, data(base64) }
 *   xfer.error  { transferId, code, index? }
 * 接收端把 chunk 交给 createReceiver().writeChunk；全部到齐后 finalize。
 * 传输由调用方注入（P2PChannel / 测试用 duplex），本模块不发起 HTTP。
 */
import { createHash } from 'node:crypto';
import { readSync, openSync, closeSync } from 'node:fs';

export const WANT = 'xfer.want';
export const CHUNK = 'xfer.chunk';
export const ERROR = 'xfer.error';
export const MAX_WINDOW = 8;
export const MAX_CHUNK_B64 = 3 * 1024 * 1024;

const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** 发送端：按请求读取文件块并编码为帧。 */
export function createChunkSource({ chunked, filePath, transferId = null }) {
  if (chunked === null || typeof chunked !== 'object' || !Array.isArray(chunked.chunks)) return { ok: false, code: 'XFER_SOURCE_INVALID' };
  const tid = transferId ?? chunked.rootCid;
  return {
    ok: true,
    handle(frame) {
      if (frame?.type !== WANT) return { ok: false, code: 'XFER_FRAME_UNEXPECTED' };
      if (frame.transferId !== tid) return { ok: false, code: 'XFER_TRANSFER_MISMATCH' };
      if (frame.rootCid !== chunked.rootCid) return { ok: false, code: 'XFER_ROOT_MISMATCH' };
      const indices = Array.isArray(frame.indices) ? frame.indices : [];
      if (indices.length === 0 || indices.length > MAX_WINDOW) return { ok: false, code: 'XFER_WINDOW_INVALID' };
      const out = [];
      const fd = openSync(filePath, 'r');
      try {
        for (const index of indices) {
          const chunk = chunked.chunks[index];
          if (!Number.isInteger(index) || chunk === undefined) { out.push({ type: ERROR, transferId: tid, code: 'XFER_CHUNK_INDEX_INVALID', index }); continue; }
          const buf = Buffer.alloc(chunk.size);
          const read = readSync(fd, buf, 0, chunk.size, index * chunked.chunkBytes);
          if (read !== chunk.size) { out.push({ type: ERROR, transferId: tid, code: 'XFER_READ_SHORT', index }); continue; }
          out.push({ type: CHUNK, transferId: tid, index, sha256: chunk.sha256, size: chunk.size, data: buf.toString('base64') });
        }
      } finally { closeSync(fd); }
      return { ok: true, frames: out };
    },
  };
}

/** 接收端：把帧写入 createReceiver；缺失块由 receiver 的位图反推。 */
export function createWantClient({ transferId, rootCid, receiver }) {
  if (typeof transferId !== 'string' || !isHex64(rootCid?.replace(/^sha256:/, ''))) return { ok: false, code: 'XFER_ROOT_INVALID' };
  return {
    ok: true,
    missing() {
      const have = receiver.have();
      const total = receiver.progress().total;
      const out = [];
      for (let index = 0; index < total; index += 1) if (!have.has(index)) out.push(index);
      return out;
    },
    requestFrames(indices) {
      return [{ type: WANT, transferId, rootCid, indices: indices.slice(0, MAX_WINDOW) }];
    },
    accept(frame) {
      if (frame?.type === ERROR) return { ok: false, code: frame.code ?? 'XFER_PEER_ERROR', index: frame.index ?? null };
      if (frame?.type !== CHUNK) return { ok: false, code: 'XFER_FRAME_UNEXPECTED' };
      if (frame.transferId !== transferId) return { ok: false, code: 'XFER_TRANSFER_MISMATCH' };
      if (String(frame.data ?? '').length > MAX_CHUNK_B64) return { ok: false, code: 'XFER_CHUNK_TOO_LARGE' };
      const data = Buffer.from(String(frame.data), 'base64');
      const written = receiver.writeChunk(frame.index, data, frame.sha256);
      if (written.ok !== true) return written;
      return { ok: true, index: frame.index, complete: receiver.progress().complete };
    },
  };
}

/** 两帧之间的纯函数检查：块哈希与大小必须与声明一致（不依赖 receiver）。 */
export function verifyChunkFrame(frame) {
  if (frame?.type !== CHUNK) return { ok: false, code: 'XFER_FRAME_UNEXPECTED' };
  if (!Number.isInteger(frame.index) || frame.index < 0) return { ok: false, code: 'XFER_CHUNK_INDEX_INVALID' };
  if (!isHex64(frame.sha256)) return { ok: false, code: 'XFER_CHUNK_HASH_INVALID' };
  const data = Buffer.from(String(frame.data ?? ''), 'base64');
  if (data.length !== frame.size) return { ok: false, code: 'XFER_CHUNK_LENGTH_INVALID' };
  const digest = createHash('sha256').update(data).digest('hex');
  if (digest !== frame.sha256) return { ok: false, code: 'XFER_CHUNK_HASH_MISMATCH' };
  return { ok: true, data };
}
