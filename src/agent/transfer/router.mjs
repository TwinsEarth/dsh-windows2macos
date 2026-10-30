/**
 * P0-a: route `xfer.*` frames that arrive on a real P2PChannel.
 *
 * The router owns no transport: it is handed the frame and a channel, and it
 * uses the existing chunk source/client primitives. Registering a source or a
 * receiver is explicit, so an unregistered frame is dropped (never guessed).
 * One listener per channel is the caller's job; this router never attaches one.
 */
import { createChunkSource, createWantClient } from './want-block.mjs';

export function createXferFrameRouter() {
  const sources = new Map();    // rootCid -> { chunked, filePath, transferId, source }
  const receivers = new Map();  // transferId -> { receiver, client }

  const parse = (payload) => {
    if (Buffer.isBuffer(payload) || typeof payload === 'string') {
      try { return JSON.parse(Buffer.from(payload).toString('utf8')); } catch { return null; }
    }
    return payload !== null && typeof payload === 'object' ? payload : null;
  };

  return {
    registerSource(rootCid, { chunked, filePath, transferId = null } = {}) {
      if (typeof rootCid !== 'string' || rootCid === '') return { ok: false, code: 'XFER_ROOT_INVALID' };
      sources.set(rootCid, { chunked, filePath, transferId, source: null, sourceTransferId: null });
      return { ok: true };
    },
    registerReceiver(transferId, receiver, rootCid) {
      if (typeof transferId !== 'string' || transferId === '') return { ok: false, code: 'XFER_TRANSFER_INVALID' };
      const client = createWantClient({ transferId, rootCid, receiver });
      if (client.ok !== true) return client;
      receivers.set(transferId, { receiver, client });
      return { ok: true };
    },
    unregister(rootCid) { sources.delete(rootCid); },
    has(rootCid) { return sources.has(rootCid); },
    /** Send the next want window for a registered receiver over a channel. */
    request(transferId, channel) {
      const entry = receivers.get(transferId);
      if (entry === undefined || typeof channel?.send !== 'function') return { ok: false, code: 'XFER_RECEIVER_UNKNOWN' };
      const missing = entry.client.missing();
      if (missing.length === 0) return { ok: true, requested: 0 };
      const frames = entry.client.requestFrames(missing);
      for (const frame of frames) channel.send(JSON.stringify(frame));
      return { ok: true, requested: missing.length };
    },
    /**
     * @returns {boolean} true when the frame belonged to this layer (handled or refused)
     */
    handle(payload, { channel } = {}) {
      const frame = parse(payload);
      if (frame === null || typeof frame.type !== 'string' || !frame.type.startsWith('xfer.')) return false;
      if (typeof channel?.send !== 'function') return true;
      if (frame.type === 'xfer.want') {
        const entry = sources.get(frame.rootCid) ?? sources.get(frame.transferId);
        if (entry === undefined) return true; // unknown source: drop, do not leak why
        if (entry.source === null || entry.sourceTransferId !== frame.transferId) {
          entry.source = createChunkSource({ chunked: entry.chunked, filePath: entry.filePath, transferId: frame.transferId });
          entry.sourceTransferId = frame.transferId;
        }
        const served = entry.source.handle(frame);
        if (served.ok !== true) { channel.send(JSON.stringify({ type: 'xfer.error', transferId: frame.transferId, code: served.code })); return true; }
        for (const outgoing of served.frames) channel.send(JSON.stringify(outgoing));
        return true;
      }
      if (frame.type === 'xfer.chunk') {
        const entry = receivers.get(frame.transferId);
        if (entry === undefined) return true;
        entry.receiver.writeChunk(frame.index, Buffer.from(String(frame.data), 'base64'), frame.sha256);
        return true;
      }
      if (frame.type === 'xfer.error') {
        const entry = receivers.get(frame.transferId);
        if (entry !== undefined) entry.lastError = frame.code ?? 'XFER_PEER_ERROR';
        return true;
      }
      return true;
    },
  };
}
