/**
 * P1.5 encrypted relay media broker (in-memory only).
 *
 * The relay never sees a JPEG or a session key:
 *   - payloads are opaque ciphertext, size-capped to fit the relay frame budget;
 *   - one newest frame per session (latest-frame-wins), no history;
 *   - every entry expires; nothing is written to disk or logged.
 *
 * HTTP/agent wiring is a separate slice; this module is the safety contract.
 */
export const REMOTE_MEDIA_CODE = Object.freeze({
  OK: 'REMOTE_MEDIA_OK',
  BAD_SESSION: 'REMOTE_MEDIA_BAD_SESSION',
  BAD_PAYLOAD: 'REMOTE_MEDIA_BAD_PAYLOAD',
  TOO_LARGE: 'REMOTE_MEDIA_TOO_LARGE',
  NOT_FOUND: 'REMOTE_MEDIA_NOT_FOUND',
  EXPIRED: 'REMOTE_MEDIA_EXPIRED',
});

export const DEFAULT_REMOTE_MEDIA_MAX_BYTES = 47 * 1024;
export const DEFAULT_REMOTE_MEDIA_TTL_MS = 15_000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {{maxBytes?: number, ttlMs?: number, now?: () => number}} [options]
 */
export function createRemoteMediaBroker(options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : DEFAULT_REMOTE_MEDIA_MAX_BYTES;
  const ttlMs = Number.isInteger(options.ttlMs) ? options.ttlMs : DEFAULT_REMOTE_MEDIA_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sessions = new Map();

  const prune = () => {
    const at = now();
    for (const [id, entry] of sessions) if (entry.expiresAt <= at) sessions.delete(id);
  };

  return {
    maxBytes,
    ttlMs,
    /** Open or refresh a session addressed to one target machine. */
    open(sessionId, targetMachineId) {
      if (typeof sessionId !== 'string' || sessionId === '' || typeof targetMachineId !== 'string' || targetMachineId === '') {
        return { ok: false, code: REMOTE_MEDIA_CODE.BAD_SESSION };
      }
      sessions.set(sessionId, { target: targetMachineId, frame: null, expiresAt: now() + ttlMs });
      return { ok: true, code: REMOTE_MEDIA_CODE.OK, session_id: sessionId, target: targetMachineId };
    },
    /** Store one opaque ciphertext frame (latest wins). */
    put(sessionId, targetMachineId, ciphertext) {
      prune();
      const entry = sessions.get(sessionId);
      if (entry === undefined) return { ok: false, code: REMOTE_MEDIA_CODE.NOT_FOUND };
      if (entry.target !== targetMachineId) return { ok: false, code: REMOTE_MEDIA_CODE.BAD_SESSION };
      if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength === 0) return { ok: false, code: REMOTE_MEDIA_CODE.BAD_PAYLOAD };
      if (ciphertext.byteLength > maxBytes) return { ok: false, code: REMOTE_MEDIA_CODE.TOO_LARGE };
      entry.frame = { ciphertext: Buffer.from(ciphertext), bytes: ciphertext.byteLength, at: now() };
      entry.expiresAt = now() + ttlMs;
      return { ok: true, code: REMOTE_MEDIA_CODE.OK, bytes: ciphertext.byteLength };
    },
    /** Read and consume the newest frame, or report why not. */
    take(sessionId, targetMachineId) {
      prune();
      const entry = sessions.get(sessionId);
      if (entry === undefined) return { ok: false, code: REMOTE_MEDIA_CODE.EXPIRED };
      if (entry.target !== targetMachineId) return { ok: false, code: REMOTE_MEDIA_CODE.BAD_SESSION };
      if (entry.frame === null) return { ok: false, code: REMOTE_MEDIA_CODE.NOT_FOUND };
      const frame = entry.frame;
      entry.frame = null;
      return { ok: true, code: REMOTE_MEDIA_CODE.OK, ...frame };
    },
    close(sessionId) { sessions.delete(sessionId); },
    stats() { prune(); return { sessions: sessions.size, maxBytes, ttlMs }; },
  };
}

/** Validate the JSON body of a frame write without decoding the ciphertext. */
export function parseRemoteFrame(body) {
  if (!isObject(body)) return { ok: false, code: REMOTE_MEDIA_CODE.BAD_PAYLOAD };
  if (typeof body.session_id !== 'string' || body.session_id === '') return { ok: false, code: REMOTE_MEDIA_CODE.BAD_SESSION };
  if (typeof body.target !== 'string' || body.target === '') return { ok: false, code: REMOTE_MEDIA_CODE.BAD_SESSION };
  if (typeof body.ct !== 'string' || body.ct === '') return { ok: false, code: REMOTE_MEDIA_CODE.BAD_PAYLOAD };
  let ciphertext;
  try { ciphertext = Buffer.from(body.ct, 'base64'); } catch { return { ok: false, code: REMOTE_MEDIA_CODE.BAD_PAYLOAD }; }
  return { ok: true, session_id: body.session_id, target: body.target, ciphertext };
}
