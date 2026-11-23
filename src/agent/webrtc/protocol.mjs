/**
 * W2M WebRTC transport, wire protocol.
 *
 * The data plane is a WebRTC DataChannel, but a DataChannel is only a byte pipe: it gives us
 * DTLS between two ICE endpoints and nothing about *who* those endpoints are. This module defines
 * the small application protocol that runs inside it:
 *
 *   frame   = kind u8 | session u32be | body
 *   HELLO / HELLO_ACK  the W2M Noise handshake bodies (plaintext, but authenticated inside)
 *   DATA               one application payload, already Noise-sealed before it reaches the wire
 *   CHUNK              one fragment of a payload larger than `MAX_FRAGMENT_BYTES`
 *   PING / PONG        authenticated keepalive/probe
 *   BYE                authenticated close
 *
 * The 5-byte header is deliberately the same shape `src/agent/p2p.mjs` uses, because the Noise
 * implementation in `crypto.mjs` encrypts a *complete frame* and authenticates its header as AAD.
 * Reusing the shape means the WebRTC path can reuse the audited CryptoSession instead of growing a
 * second handshake, while remaining a separate transport.
 *
 * Fragmentation is application-level because DataChannel implementations disagree about the
 * maximum message size: node-datachannel and browsers often cap near 64 KiB, while the reference
 * W2M remote transport uses 4 MiB messages. A 4 MiB payload split into 16 KiB fragments is
 * portable, and the receiver reassembles before Noise decryption? No — each fragment is sealed
 * separately, so a relay sees only ciphertext and a dropped fragment is a dropped fragment, never
 * half a plaintext message.
 */

import { randomBytes } from 'node:crypto';

/** Protocol name carried in the signaling `join` and in diagnostics. */
export const WEBRTC_PROTOCOL = 'w2m-webrtc/1';

/** Transport name this implementation registers under. */
export const WEBRTC_TRANSPORT = 'webrtc-v1';

/** Frame kinds. Values 1-8 match `p2p.mjs` for familiarity; 9 is WebRTC-only. */
export const FRAME_KIND = Object.freeze({
  HELLO: 1,
  HELLO_ACK: 2,
  DATA: 3,
  ACK: 4,
  DONE: 5,
  PING: 6,
  PONG: 7,
  BYE: 8,
  CHUNK: 9,
});

/** Bytes of `kind + session` in front of every frame. */
export const FRAME_HEADER_BYTES = 5;

/** Bytes of `id u32 | seq u16 | total u16` in front of a CHUNK body. */
export const CHUNK_HEADER_BYTES = 8;

/** Largest signaling message accepted from the control plane. SDP is normally far below this. */
export const MAX_SIGNAL_BYTES = 64 * 1024;

/** Largest application payload this transport will carry in one logical message. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Largest fragment placed in one DataChannel message. */
export const MAX_FRAGMENT_BYTES = 16 * 1024;

/** How many incomplete messages one peer may hold at once. */
export const MAX_REASSEMBLY_ENTRIES = 8;

/** A fragment set older than this is discarded; a lost fragment must not pin memory forever. */
export const FRAGMENT_TTL_MS = 30_000;

/** Application payloads above this size are refused rather than silently truncated. */
export const WEBRTC_CODE = Object.freeze({
  OK: 'WEBRTC_OK',
  BAD_FRAME: 'WEBRTC_BAD_FRAME',
  UNKNOWN_KIND: 'WEBRTC_UNKNOWN_KIND',
  MESSAGE_TOO_LARGE: 'WEBRTC_MESSAGE_TOO_LARGE',
  MESSAGE_INCOMPLETE: 'WEBRTC_MESSAGE_INCOMPLETE',
  MESSAGE_CORRUPT: 'WEBRTC_MESSAGE_CORRUPT',
  SIGNAL_TOO_LARGE: 'WEBRTC_SIGNAL_TOO_LARGE',
  BAD_JSON: 'WEBRTC_BAD_JSON',
});

/** A named protocol refusal. Callers record `code`, never a bare `throw new Error`. */
export class WebRtcProtocolError extends Error {
  /**
   * @param {string} code One of `WEBRTC_CODE`.
   * @param {string} detail Human-readable, safe to log.
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'WebRtcProtocolError';
    this.code = code;
    this.detail = detail;
  }
}

/** @param {unknown} value @returns {value is Buffer} */
function isBuffer(value) {
  return Buffer.isBuffer(value);
}

/**
 * Encode one frame.
 *
 * @param {number} kind
 * @param {number} session 32-bit; the Noise handshake session id.
 * @param {Buffer} [body]
 * @returns {Buffer}
 */
export function encodeFrame(kind, session, body = Buffer.alloc(0)) {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) {
    throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, `kind must be a u8, got ${String(kind)}`);
  }
  if (!Number.isInteger(session) || session < 0 || session > 0xffffffff) {
    throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, `session must be a u32, got ${String(session)}`);
  }
  const inner = body === undefined ? Buffer.alloc(0) : isBuffer(body) ? body : Buffer.from(body);
  if (inner.length > MAX_MESSAGE_BYTES + CHUNK_HEADER_BYTES) {
    throw new WebRtcProtocolError(WEBRTC_CODE.MESSAGE_TOO_LARGE, `frame body is ${inner.length} bytes`);
  }
  const out = Buffer.alloc(FRAME_HEADER_BYTES + inner.length);
  out.writeUInt8(kind, 0);
  out.writeUInt32BE(session >>> 0, 1);
  inner.copy(out, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Decode one frame without interpreting its body.
 *
 * @param {Buffer} value
 * @returns {{kind: number, session: number, body: Buffer}}
 */
export function decodeFrame(value) {
  if (!isBuffer(value) || value.length < FRAME_HEADER_BYTES) {
    throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, 'frame is shorter than the 5-byte header');
  }
  const kind = value.readUInt8(0);
  if (!Object.values(FRAME_KIND).includes(kind)) {
    throw new WebRtcProtocolError(WEBRTC_CODE.UNKNOWN_KIND, `unknown frame kind ${kind}`);
  }
  return {
    kind,
    session: value.readUInt32BE(1),
    body: value.subarray(FRAME_HEADER_BYTES),
  };
}

/**
 * Encode a JSON control frame. JSON is used only for PING/PONG/BYE and tests; application payloads
 * are opaque bytes and never serialized here.
 *
 * @param {number} kind
 * @param {number} session
 * @param {unknown} value
 * @returns {{frame: Buffer, bytes: number}}
 */
export function encodeJsonFrame(kind, session, value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new WebRtcProtocolError(
      WEBRTC_CODE.BAD_JSON,
      error instanceof Error ? error.message : String(error),
    );
  }
  const body = Buffer.from(text, 'utf8');
  return { frame: encodeFrame(kind, session, body), bytes: body.length };
}

/**
 * Decode a JSON control frame. Returns a named refusal instead of throwing so a live channel can
 * drop one bad frame and keep its session.
 *
 * @param {Buffer} frame
 * @returns {{ok: true, kind: number, session: number, value: unknown} | {ok: false, code: string, detail: string}}
 */
export function decodeJsonFrame(frame) {
  let parsed;
  try {
    parsed = decodeFrame(frame);
  } catch (error) {
    return {
      ok: false,
      code: error instanceof WebRtcProtocolError ? error.code : WEBRTC_CODE.BAD_FRAME,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return {
      ok: true,
      kind: parsed.kind,
      session: parsed.session,
      value: JSON.parse(parsed.body.toString('utf8')),
    };
  } catch (error) {
    return {
      ok: false,
      code: WEBRTC_CODE.BAD_JSON,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Encode one fragment header and payload.
 *
 * @param {number} id Message id, nonzero u32.
 * @param {number} seq Zero-based fragment index.
 * @param {number} total Fragment count.
 * @param {Buffer} data
 * @returns {Buffer}
 */
export function encodeChunk(id, seq, total, data) {
  if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) {
    throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, `chunk id must be a nonzero u32, got ${String(id)}`);
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
    throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, `chunk seq must be a u16, got ${String(seq)}`);
  }
  if (!Number.isInteger(total) || total < 1 || total > 0xffff) {
    throw new WebRtcProtocolError(
      WEBRTC_CODE.BAD_FRAME,
      `chunk total must be 1..65535, got ${String(total)}`,
    );
  }
  if (seq >= total) {
    throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, `chunk seq ${seq} is outside total ${total}`);
  }
  const payload = isBuffer(data) ? data : Buffer.from(data ?? []);
  if (payload.length > MAX_FRAGMENT_BYTES) {
    throw new WebRtcProtocolError(
      WEBRTC_CODE.MESSAGE_TOO_LARGE,
      `fragment is ${payload.length} bytes, cap is ${MAX_FRAGMENT_BYTES}`,
    );
  }
  const out = Buffer.alloc(CHUNK_HEADER_BYTES + payload.length);
  out.writeUInt32BE(id >>> 0, 0);
  out.writeUInt16BE(seq, 4);
  out.writeUInt16BE(total, 6);
  payload.copy(out, CHUNK_HEADER_BYTES);
  return out;
}

/**
 * @param {Buffer} value
 * @returns {{id: number, seq: number, total: number, data: Buffer}}
 */
export function decodeChunk(value) {
  if (!isBuffer(value) || value.length < CHUNK_HEADER_BYTES) {
    throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, 'chunk is shorter than its 8-byte header');
  }
  const id = value.readUInt32BE(0);
  const seq = value.readUInt16BE(4);
  const total = value.readUInt16BE(6);
  if (id === 0) throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, 'chunk id 0 is reserved');
  if (total === 0) throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, 'chunk total 0 is invalid');
  if (seq >= total)
    throw new WebRtcProtocolError(WEBRTC_CODE.BAD_FRAME, `chunk seq ${seq} >= total ${total}`);
  const data = value.subarray(CHUNK_HEADER_BYTES);
  if (data.length > MAX_FRAGMENT_BYTES) {
    throw new WebRtcProtocolError(WEBRTC_CODE.MESSAGE_TOO_LARGE, `fragment is ${data.length} bytes`);
  }
  return { id, seq, total, data };
}

/** A deterministic id source is injectable so tests do not assert on randomness. */
function defaultChunkId() {
  // 1..2^32-1, never 0.
  return randomBytes(4).readUInt32BE(0) || 1;
}

/**
 * Split one logical payload into frames.
 *
 * Small payloads remain a single DATA frame: a 2 KiB message does not pay an 8-byte chunk header.
 * Large payloads become CHUNK frames, each of which is Noise-sealed independently by the caller.
 */
export class Fragmenter {
  /**
   * @param {{maxFragmentBytes?: number, idSource?: () => number}} [options]
   */
  constructor({ maxFragmentBytes = MAX_FRAGMENT_BYTES, idSource = defaultChunkId } = {}) {
    if (
      !Number.isInteger(maxFragmentBytes) ||
      maxFragmentBytes < 64 ||
      maxFragmentBytes > MAX_MESSAGE_BYTES
    ) {
      throw new TypeError('Fragmenter: maxFragmentBytes must be an integer between 64 and MAX_MESSAGE_BYTES');
    }
    this.maxFragmentBytes = maxFragmentBytes;
    this.idSource = typeof idSource === 'function' ? idSource : defaultChunkId;
  }

  /**
   * @param {Buffer|string|object} payload
   * @returns {Array<{kind: number, body: Buffer}>}
   */
  split(payload) {
    let bytes;
    if (isBuffer(payload)) bytes = payload;
    else if (typeof payload === 'string') bytes = Buffer.from(payload, 'utf8');
    else bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    if (bytes.length > MAX_MESSAGE_BYTES) {
      throw new WebRtcProtocolError(
        WEBRTC_CODE.MESSAGE_TOO_LARGE,
        `payload is ${bytes.length} bytes, cap is ${MAX_MESSAGE_BYTES}`,
      );
    }
    if (bytes.length <= this.maxFragmentBytes) {
      return [{ kind: FRAME_KIND.DATA, body: bytes }];
    }
    const total = Math.ceil(bytes.length / this.maxFragmentBytes);
    if (total > 0xffff) {
      throw new WebRtcProtocolError(
        WEBRTC_CODE.MESSAGE_TOO_LARGE,
        `payload needs ${total} fragments, cap is 65535`,
      );
    }
    const id = this.idSource();
    const frames = [];
    for (let seq = 0; seq < total; seq += 1) {
      const start = seq * this.maxFragmentBytes;
      const end = Math.min(bytes.length, start + this.maxFragmentBytes);
      frames.push({ kind: FRAME_KIND.CHUNK, body: encodeChunk(id, seq, total, bytes.subarray(start, end)) });
    }
    return frames;
  }
}

/**
 * Reassemble CHUNK frames into one payload.
 *
 * The class is deliberately per-peer and bounded: an attacker who can send valid Noise frames still
 * cannot make us hold more than `maxEntries` partial messages or a message over `MAX_MESSAGE_BYTES`.
 * A duplicate fragment with different bytes is corruption, not "last write wins".
 */
export class Reassembler {
  /**
   * @param {{ttlMs?: number, maxEntries?: number, maxMessageBytes?: number, now?: () => number}} [options]
   */
  constructor({
    ttlMs = FRAGMENT_TTL_MS,
    maxEntries = MAX_REASSEMBLY_ENTRIES,
    maxMessageBytes = MAX_MESSAGE_BYTES,
    now = Date.now,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxMessageBytes = maxMessageBytes;
    this.now = now;
    /** @type {Map<number, {total: number, parts: Map<number, Buffer>, bytes: number, createdAt: number, updatedAt: number}>} */
    this.entries = new Map();
    this.dropped = 0;
  }

  /** Discard expired and over-cap entries. Called on every push; cheap because the map is tiny. */
  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.updatedAt < cutoff) {
        this.entries.delete(id);
        this.dropped += 1;
      }
    }
    while (this.entries.size > this.maxEntries) {
      // Map iteration is insertion order: drop the oldest incomplete message.
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.dropped += 1;
    }
  }

  /**
   * @param {Buffer} body A CHUNK body (8-byte header + fragment).
   * @returns {{ok: true, payload: Buffer} | {ok: false, code: string, detail: string}}
   */
  push(body) {
    this.prune();
    let chunk;
    try {
      chunk = decodeChunk(body);
    } catch (error) {
      return {
        ok: false,
        code: error instanceof WebRtcProtocolError ? error.code : WEBRTC_CODE.BAD_FRAME,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    let entry = this.entries.get(chunk.id);
    if (entry === undefined) {
      if (this.entries.size >= this.maxEntries) {
        this.prune();
        if (this.entries.size >= this.maxEntries) {
          this.dropped += 1;
          return { ok: false, code: WEBRTC_CODE.MESSAGE_INCOMPLETE, detail: 'reassembly table is full' };
        }
      }
      entry = {
        total: chunk.total,
        parts: new Map(),
        bytes: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.entries.set(chunk.id, entry);
    }
    if (entry.total !== chunk.total) {
      this.entries.delete(chunk.id);
      return { ok: false, code: WEBRTC_CODE.MESSAGE_CORRUPT, detail: 'fragment total changed mid-message' };
    }
    const existing = entry.parts.get(chunk.seq);
    if (existing !== undefined) {
      if (isBuffer(existing) && existing.equals(chunk.data)) {
        // A duplicate is harmless; do not double-count its bytes.
        return { ok: false, code: WEBRTC_CODE.MESSAGE_INCOMPLETE, detail: 'duplicate fragment' };
      }
      this.entries.delete(chunk.id);
      return {
        ok: false,
        code: WEBRTC_CODE.MESSAGE_CORRUPT,
        detail: 'duplicate fragment with different bytes',
      };
    }
    entry.parts.set(chunk.seq, chunk.data);
    entry.bytes += chunk.data.length;
    entry.updatedAt = this.now();
    if (entry.bytes > this.maxMessageBytes) {
      this.entries.delete(chunk.id);
      return {
        ok: false,
        code: WEBRTC_CODE.MESSAGE_TOO_LARGE,
        detail: `message exceeded ${this.maxMessageBytes} bytes`,
      };
    }
    if (entry.parts.size !== entry.total) {
      return {
        ok: false,
        code: WEBRTC_CODE.MESSAGE_INCOMPLETE,
        detail: `${entry.parts.size}/${entry.total} fragments`,
      };
    }
    const parts = [];
    for (let seq = 0; seq < entry.total; seq += 1) {
      const part = entry.parts.get(seq);
      if (part === undefined) {
        return { ok: false, code: WEBRTC_CODE.MESSAGE_INCOMPLETE, detail: `missing fragment ${seq}` };
      }
      parts.push(part);
    }
    this.entries.delete(chunk.id);
    return { ok: true, payload: Buffer.concat(parts) };
  }

  /** @returns {number} incomplete messages currently held. */
  size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * Bound a JSON control message and serialize it once.
 *
 * @param {unknown} value
 * @param {number} [maxBytes]
 * @returns {{ok: true, text: string, bytes: number} | {ok: false, code: string, detail: string}}
 */
export function stringifyBounded(value, maxBytes = MAX_SIGNAL_BYTES) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    return {
      ok: false,
      code: WEBRTC_CODE.BAD_JSON,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    return { ok: false, code: WEBRTC_CODE.SIGNAL_TOO_LARGE, detail: `${bytes} bytes > ${maxBytes}` };
  }
  return { ok: true, text, bytes };
}

/**
 * Parse a JSON signaling message with a byte cap and a shape check.
 *
 * @param {string|Buffer} text
 * @param {{maxBytes?: number, type?: string}} [options]
 * @returns {{ok: true, value: any} | {ok: false, code: string, detail: string}}
 */
export function parseBoundedJson(text, { maxBytes = MAX_SIGNAL_BYTES, type = null } = {}) {
  const raw = isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  if (raw.length > maxBytes) {
    return { ok: false, code: WEBRTC_CODE.SIGNAL_TOO_LARGE, detail: `${raw.length} bytes > ${maxBytes}` };
  }
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      code: WEBRTC_CODE.BAD_JSON,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: WEBRTC_CODE.BAD_JSON, detail: 'message must be a JSON object' };
  }
  if (type !== null && value.type !== type) {
    return {
      ok: false,
      code: WEBRTC_CODE.BAD_JSON,
      detail: `expected type "${type}", got ${String(value.type)}`,
    };
  }
  return { ok: true, value };
}
