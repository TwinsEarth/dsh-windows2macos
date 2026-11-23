/**
 * P1.5 remote-view request mailbox (relay memory only).
 *
 * A viewer posts one request per target; the target consumes it. No disk, no
 * logs, no plaintext media. Every entry expires, and the newest request wins so
 * a stale viewer cannot pin a target forever.
 *
 * v3.6.0 adds two additive fields and a second mailbox:
 *
 *   - `viewer_machine_id` and `transport` let a target know whether the viewer
 *     intends to use the shared WebRTC pool, before any DataChannel exists.
 *   - `ack` / `takeAck` carry the target's one-bit answer ("the pair is warm")
 *     back to the viewer over the authenticated relay control plane. Media
 *     never enters this mailbox.
 *
 * An old viewer that sends neither field keeps the relay behaviour it had: the
 * request is treated as `transport: 'relay'` and the target starts its relay
 * frame stream.
 */
export const REMOTE_REQUEST_CODE = Object.freeze({
  OK: 'REMOTE_REQUEST_OK',
  BAD: 'REMOTE_REQUEST_BAD',
  TOO_LARGE: 'REMOTE_REQUEST_TOO_LARGE',
  NOT_FOUND: 'REMOTE_REQUEST_NOT_FOUND',
  EXPIRED: 'REMOTE_REQUEST_EXPIRED',
});

export const REMOTE_ACK_CODE = Object.freeze({
  OK: 'REMOTE_ACK_OK',
  BAD: 'REMOTE_ACK_BAD',
  NOT_FOUND: 'REMOTE_ACK_NOT_FOUND',
  FORBIDDEN: 'REMOTE_ACK_FORBIDDEN',
});

export const DEFAULT_REMOTE_REQUEST_TTL_MS = 15_000;
export const DEFAULT_REMOTE_ACK_TTL_MS = 10_000;

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value !== '' ? value : null; }
function ackKey(target, sessionId) { return `${target}\u0000${sessionId}`; }

export function createRemoteRequestBroker(options = {}) {
  const ttlMs = Number.isInteger(options.ttlMs) ? options.ttlMs : DEFAULT_REMOTE_REQUEST_TTL_MS;
  const ackTtlMs = Number.isInteger(options.ackTtlMs) ? options.ackTtlMs : DEFAULT_REMOTE_ACK_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const requests = new Map();
  const acks = new Map();

  const prune = () => {
    const at = now();
    for (const [key, entry] of requests) if (entry.expiresAt <= at) requests.delete(key);
    for (const [key, entry] of acks) if (entry.expiresAt <= at) acks.delete(key);
  };

  return {
    post(body) {
      prune();
      if (!isObject(body)) return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      if (typeof body.session_id !== 'string' || body.session_id === '') return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      if (typeof body.target !== 'string' || body.target === '') return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      if (typeof body.viewer_public_key !== 'string' || body.viewer_public_key === '') return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      const key = Buffer.from(body.viewer_public_key, 'base64');
      if (key.length !== 32) return { ok: false, code: REMOTE_REQUEST_CODE.BAD };
      const viewerMachineId = nonEmpty(body.viewer_machine_id);
      const transport = body.transport === 'webrtc' ? 'webrtc' : 'relay';
      requests.set(body.target, {
        session_id: body.session_id,
        target: body.target,
        viewer_public_key: body.viewer_public_key,
        viewer_machine_id: viewerMachineId,
        transport,
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
      return {
        ok: true,
        code: REMOTE_REQUEST_CODE.OK,
        session_id: entry.session_id,
        target: entry.target,
        viewer_public_key: entry.viewer_public_key,
        viewer_machine_id: entry.viewer_machine_id,
        transport: entry.transport,
        at: entry.at,
      };
    },

    /**
     * Record the target's answer for one viewer session.
     *
     * `ok:false` is a first-class answer: the viewer must learn that warm-up
     * failed and be able to fall back to relay instead of waiting out a timeout.
     */
    ack(body) {
      prune();
      if (!isObject(body)) return { ok: false, code: REMOTE_ACK_CODE.BAD };
      const sessionId = nonEmpty(body.session_id);
      const target = nonEmpty(body.target);
      const viewerMachineId = nonEmpty(body.viewer_machine_id);
      if (sessionId === null || target === null || viewerMachineId === null) {
        return { ok: false, code: REMOTE_ACK_CODE.BAD };
      }
      if (typeof body.ok !== 'boolean') return { ok: false, code: REMOTE_ACK_CODE.BAD };
      const code = nonEmpty(body.code) ?? (body.ok === true ? 'WEBRTC_PREPARED' : 'WEBRTC_PREPARE_FAILED');
      acks.set(ackKey(target, sessionId), {
        session_id: sessionId,
        target,
        viewer_machine_id: viewerMachineId,
        ok: body.ok,
        code,
        expiresAt: now() + ackTtlMs,
        at: now(),
      });
      return { ok: true, code: REMOTE_ACK_CODE.OK, target, session_id: sessionId };
    },
    /** Consume one ack. The HTTP layer checks the caller is the recorded viewer. */
    takeAck(target, sessionId, viewerMachineId) {
      prune();
      const key = ackKey(target, sessionId);
      const entry = acks.get(key);
      if (entry === undefined) return { ok: false, code: REMOTE_ACK_CODE.NOT_FOUND };
      if (typeof viewerMachineId !== 'string' || viewerMachineId === '' || entry.viewer_machine_id !== viewerMachineId) {
        return { ok: false, code: REMOTE_ACK_CODE.FORBIDDEN };
      }
      acks.delete(key);
      return {
        ok: true,
        code: REMOTE_ACK_CODE.OK,
        session_id: entry.session_id,
        target: entry.target,
        viewer_machine_id: entry.viewer_machine_id,
        prepared: entry.ok,
        reason: entry.code,
        at: entry.at,
      };
    },
    stats() {
      prune();
      return { targets: requests.size, acks: acks.size, ttl_ms: ttlMs, ack_ttl_ms: ackTtlMs };
    },
  };
}
