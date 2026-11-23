/**
 * A `simple-peer`-shaped Duplex over one V1 WebRTC pair.
 *
 * WebTorrent's `Torrent.addPeer()` accepts either a peer id or an already-connected
 * `simple-peer`-like object. We use the latter: the object must expose `id`, `connected`, stream
 * methods, and `connect`/`error`/`end` events. `Peer.createWebRTCPeer()` then runs the standard
 * BitTorrent wire over it, so the torrent engine never learns that the underlying channel is the
 * W2M transport abstraction rather than a browser's `RTCPeerConnection`.
 *
 * Ownership rule: the adapter **borrows** the transport binding. `destroy()` ends only this
 * logical torrent stream and releases no transport resource; it never closes the shared pair,
 * exactly like the desktop and Teams rows. The transport is shared with task dispatch and other
 * artifacts.
 */

import { Duplex } from 'node:stream';

import { encodeTorrentFrame, normalizeInfoHash } from './multiplex.mjs';

/** Largest single write accepted from WebTorrent, matching the V1 logical message cap with margin. */
export const TORRENT_ADAPTER_MAX_WRITE_BYTES = 4 * 1024 * 1024 - 128;

/**
 * @param {unknown} value
 * @returns {value is Buffer}
 */
function isBuffer(value) {
  return Buffer.isBuffer(value);
}

/**
 * @param {Buffer|Uint8Array|string} chunk
 * @returns {Buffer}
 */
function toBuffer(chunk) {
  if (isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

/**
 * Build the writable half of the adapter.
 *
 * @param {object} input
 * @param {string} input.peer Target machine id.
 * @param {string|Buffer} input.infoHash
 * @param {{send: Function, name?: string}} input.transport Byte transport binding; only `send` is used.
 * @param {number} [input.writeTimeoutMs]
 * @param {(error: Error) => void} [input.onError]
 * @returns {Duplex & {id: string, peer: string, infoHash: string, transport: string|null, feed: (chunk: Buffer) => void, stats: object}}
 */
export function createTorrentPeerAdapter({
  peer,
  infoHash,
  transport,
  writeTimeoutMs = 15_000,
  onError = null,
}) {
  const hash = normalizeInfoHash(infoHash);
  if (hash === null) throw new TypeError('torrent peer adapter: infoHash must be 40 hex or 20-byte Buffer');
  if (typeof peer !== 'string' || peer === '') throw new TypeError('torrent peer adapter: peer is required');
  if (transport === null || typeof transport !== 'object' || typeof transport.send !== 'function') {
    throw new TypeError('torrent peer adapter: transport must expose send()');
  }

  const stats = {
    chunks_in: 0,
    bytes_in: 0,
    chunks_out: 0,
    bytes_out: 0,
    errors: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    closed_at: null,
  };

  const adapter = new Duplex({
    objectMode: false,
    highWaterMark: 1024 * 1024,
    read() {},
    write(chunk, _encoding, callback) {
      const bytes = toBuffer(chunk);
      if (bytes.length === 0) return callback();
      if (bytes.length > TORRENT_ADAPTER_MAX_WRITE_BYTES) {
        const error = new Error(
          `torrent adapter: write is ${bytes.length} bytes, cap is ${TORRENT_ADAPTER_MAX_WRITE_BYTES}`,
        );
        error.code = 'P2P_V2_CHUNK_TOO_LARGE';
        stats.errors += 1;
        stats.last_error = { code: error.code, detail: error.message };
        onError?.(error);
        return callback(error);
      }
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) callback(error);
        else callback();
      };
      const timer = setTimeout(() => {
        const error = new Error(`torrent adapter: send to ${peer} timed out after ${writeTimeoutMs} ms`);
        error.code = 'P2P_V2_SEND_TIMEOUT';
        stats.errors += 1;
        stats.last_error = { code: error.code, detail: error.message };
        onError?.(error);
        finish(error);
      }, writeTimeoutMs);
      timer.unref?.();

      let frame;
      try {
        frame = encodeTorrentFrame(hash, bytes);
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        stats.errors += 1;
        stats.last_error = { code: 'P2P_V2_ENCODE_FAILED', detail: wrapped.message };
        onError?.(wrapped);
        return finish(wrapped);
      }

      Promise.resolve(transport.send(peer, frame)).then(
        (result) => {
          if (result?.ok !== true) {
            const error = new Error(result?.detail ?? result?.code ?? 'P2P_V2_SEND_FAILED');
            error.code = result?.code ?? 'P2P_V2_SEND_FAILED';
            stats.errors += 1;
            stats.last_error = { code: error.code, detail: error.message };
            onError?.(error);
            return finish(error);
          }
          stats.chunks_out += 1;
          stats.bytes_out += bytes.length;
          finish(null);
        },
        (error) => {
          const wrapped = error instanceof Error ? error : new Error(String(error));
          stats.errors += 1;
          stats.last_error = { code: 'P2P_V2_SEND_THREW', detail: wrapped.message };
          onError?.(wrapped);
          finish(wrapped);
        },
      );
    },
    final(callback) {
      stats.closed_at = new Date().toISOString();
      callback();
    },
    destroy(error, callback) {
      stats.closed_at = stats.closed_at ?? new Date().toISOString();
      callback(error);
    },
  });

  adapter.id = peer;
  adapter.peer = peer;
  adapter.infoHash = hash;
  adapter.transport = typeof transport.name === 'string' ? transport.name : null;
  adapter.connected = true;
  // WebTorrent attaches its own error handler after `addPeer`; this guard closes the window before
  // that handler exists. Errors remain in `stats.last_error` and are still delivered to the torrent.
  adapter.on('error', () => {});
  adapter.stats = stats;
  adapter.feed = (chunk) => {
    if (adapter.destroyed || adapter.readableEnded) return false;
    const bytes = toBuffer(chunk);
    if (bytes.length === 0) return false;
    stats.chunks_in += 1;
    stats.bytes_in += bytes.length;
    return adapter.push(bytes);
  };
  adapter.diagnostics = () => ({
    peer,
    info_hash: hash,
    transport: adapter.transport,
    connected: adapter.connected === true && !adapter.destroyed,
    destroyed: adapter.destroyed,
    ...stats,
  });
  return adapter;
}
