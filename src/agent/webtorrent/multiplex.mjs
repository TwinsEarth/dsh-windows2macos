/**
 * The byte-level tag that lets a WebTorrent peer stream and the existing JSON frames share one
 * `webrtc-v1` DataChannel.
 *
 * `webrtc-v1` is a message bus, not a byte stream: the pool delivers one Buffer per `send()` to
 * every `onMessage()` subscriber. Task dispatch, Teams artifacts and remote view already speak JSON
 * on that bus. A WebTorrent wire is binary and has no envelope, so it needs an unambiguous tag
 * before it can be multiplexed:
 *
 *   magic (6 bytes) | info hash (20 bytes, hex-decoded) | BitTorrent wire chunk
 *
 * The magic is not a secret and not a protocol version for the wire itself; it only says "this
 * buffer belongs to `P2PV2Service`, not to the JSON dispatcher". A JSON frame can never begin with
 * it because its first byte is `{`. A BitTorrent wire chunk is stripped back to its original bytes
 * before it reaches WebTorrent, so the torrent engine sees a normal `simple-peer`-shaped stream.
 */

import { createHash } from 'node:crypto';

/** Six bytes, chosen so a UTF-8 JSON object (`{`) can never collide with it. */
export const TORRENT_FRAME_MAGIC = Buffer.from([0x57, 0x32, 0x4d, 0x54, 0x32, 0x00]); // "W2MT2\0"

/** WebTorrent reports a 40-hex-character info hash; the binary form is 20 bytes. */
export const TORRENT_INFO_HASH_BYTES = 20;

/** Header size in bytes. */
export const TORRENT_FRAME_HEADER_BYTES = TORRENT_FRAME_MAGIC.length + TORRENT_INFO_HASH_BYTES;

/** Largest chunk WebTorrent may hand to one frame. The V1 transport cap is 4 MiB; leave the header room. */
export const TORRENT_FRAME_MAX_CHUNK_BYTES = 4 * 1024 * 1024 - 64;

const HEX_40 = /^[0-9a-f]{40}$/i;

/**
 * @param {unknown} value
 * @returns {value is Buffer}
 */
function isBuffer(value) {
  return Buffer.isBuffer(value);
}

/**
 * Validate and normalize a WebTorrent info hash. `Buffer` is accepted because WebTorrent exposes
 * `torrent.infoHashBuffer`; both forms are converted to lowercase hex so peers agree on the key.
 *
 * @param {string|Buffer} value
 * @returns {string|null}
 */
export function normalizeInfoHash(value) {
  if (isBuffer(value)) {
    return value.length === TORRENT_INFO_HASH_BYTES ? value.toString('hex').toLowerCase() : null;
  }
  return typeof value === 'string' && HEX_40.test(value) ? value.toLowerCase() : null;
}

/**
 * Wrap one BitTorrent wire chunk for a specific torrent.
 *
 * @param {string|Buffer} infoHash
 * @param {Buffer|Uint8Array|string} chunk
 * @returns {Buffer}
 * @throws {TypeError} when the hash or chunk cannot be represented on the shared bus.
 */
export function encodeTorrentFrame(infoHash, chunk) {
  const hash = normalizeInfoHash(infoHash);
  if (hash === null) throw new TypeError('torrent frame: infoHash must be 40 hex characters or a 20-byte Buffer');
  const payload = isBuffer(chunk)
    ? chunk
    : chunk instanceof Uint8Array
      ? Buffer.from(chunk)
      : typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : null;
  if (payload === null) throw new TypeError('torrent frame: chunk must be a Buffer, Uint8Array or string');
  if (payload.length === 0) throw new TypeError('torrent frame: empty chunk');
  if (payload.length > TORRENT_FRAME_MAX_CHUNK_BYTES) {
    throw new TypeError(`torrent frame: chunk is ${payload.length} bytes, cap is ${TORRENT_FRAME_MAX_CHUNK_BYTES}`);
  }
  return Buffer.concat([TORRENT_FRAME_MAGIC, Buffer.from(hash, 'hex'), payload]);
}

/**
 * @param {Buffer|Uint8Array|null|undefined} value
 * @returns {{infoHash: string, payload: Buffer}|null} null when this is not a torrent-tagged frame.
 */
export function decodeTorrentFrame(value) {
  if (!isBuffer(value) && !(value instanceof Uint8Array)) return null;
  const buffer = isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (buffer.length <= TORRENT_FRAME_HEADER_BYTES) return null;
  if (!buffer.subarray(0, TORRENT_FRAME_MAGIC.length).equals(TORRENT_FRAME_MAGIC)) return null;
  const hashBytes = buffer.subarray(
    TORRENT_FRAME_MAGIC.length,
    TORRENT_FRAME_MAGIC.length + TORRENT_INFO_HASH_BYTES,
  );
  const infoHash = hashBytes.toString('hex').toLowerCase();
  if (!HEX_40.test(infoHash)) return null;
  const payload = buffer.subarray(TORRENT_FRAME_HEADER_BYTES);
  if (payload.length === 0) return null;
  return { infoHash, payload };
}

/**
 * Cheap check for the existing JSON consumers: true only for a well-formed torrent-tagged frame.
 *
 * @param {Buffer|Uint8Array|null|undefined} value
 * @returns {boolean}
 */
export function isTorrentFrame(value) {
  return decodeTorrentFrame(value) !== null;
}

/**
 * Stable `share_id` for a torrent. The info hash is already content-derived; the extra digest
 * exists only to give the tool surface a string that is not mistaken for a magnet or a path.
 *
 * @param {string|Buffer} infoHash
 * @returns {string|null}
 */
export function shareIdFor(infoHash) {
  const hash = normalizeInfoHash(infoHash);
  if (hash === null) return null;
  return createHash('sha256').update(hash).digest('hex').slice(0, 24);
}
