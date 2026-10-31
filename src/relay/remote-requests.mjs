/**
 * P1.5 remote-view request mailbox (relay memory only).
 *
 * A viewer posts one request per target; the target consumes it. No disk, no
 * logs, no plaintext media. Every entry expires, and the newest request wins so
 * a stale viewer cannot pin a target forever.
 */
export const REMOTE_REQUEST_CODE = Object.freeze({
  OK: 'REMOTE_REQUEST_OK',
  BAD: 'REMOTE_REQUEST_BAD',
  TOO_LARGE: 'REMOTE_REQUEST_TOO_LARGE',
  NOT_FOUND: 'REMOTE_REQUEST_NOT_FOUND',
  EXPIRED: 'REMOTE_REQUEST_EXPIRED',
});

export const DEFAULT_REMOTE_REQUEST_TTL_MS = 15_000;

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function createRemoteRequestBroker(options = {}) {
  const ttlMs = Number.isInteger(options.ttlMs) ? options.ttlMs : DEFAULT_REMOTE_REQUEST_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const requests = new Map();

  const prune = () => { const at = now(); for (const [key, entry] of requests) if (entry.expiresAt <= at) requests.delete(key); };

  return {
    post(body) {
      prune();
      if (!isObject(body)) return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      if (typeof body.session_id !== 'string' || body.session_id === '') return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      if (typeof body.target !== 'string' || body.target === '') return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      if (typeof body.viewer_public_key !== 'string' || body.viewer_public_key === '') return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      const key = Buffer.from(body.viewer_public_key, 'base64');
      if (key.length !== 32) return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      requests.set(body.target, {
        session_id: body.session_id,
        target: body.target,
        viewer_public_key: body.viewer_public_key,
        expiresAt: now() + ttlMs,
        at: now(),
      });
      return { ok: true, code: REMOTE_REQUEST_CODE.OK, target: body.target, ttl_ms: ttlMs };
    },
    /** Consume the pending request for one target; the target is the only reader. */
    take(target) {
      prune();
      const entry = requests.get(target);
      if (entry === undefined) return { ok: false, code: REMOTE_REQUEST_CODE.NOT_FOUND };
      requests.delete(target);
      return { ok: true, code: REMOTE_REQUEST_CODE.OK, session_id: entry.session_id, target: entry.target, viewer_public_key: entry.viewer_public_key, at: entry.at };
    },
    stats() { prune(); return { targets: requests.size, ttl_ms: ttlMs }; },
  };
}
