/**
 * `webrtc-v1` torrent transport: a thin byte plane over the shared WebRTC pool.
 *
 * This binding deliberately does **not** own the pool. It never builds, stops or closes a pair;
 * its only cleanup is dropping its own `onMessage` subscription. Task dispatch, Teams and remote
 * view borrow the same pairs, so a logical torrent stream ending must not tear those down.
 *
 * The pool is a broadcast bus: one `onMessage` subscriber sees every frame for every peer. The
 * binding fans those events out to its own handlers and contains handler failures, matching the
 * pool's contract. BitTorrent tagging stays in `../multiplex.mjs`; this layer moves the tagged
 * buffer without looking inside it.
 */

export const WEBRTC_V1_TRANSPORT_NAME = 'webrtc-v1';

export const WEBRTC_V1_TRANSPORT_CODE = Object.freeze({
  INVALID_POOL: 'P2P_V2_TRANSPORT_POOL_INVALID',
  CLOSED: 'P2P_V2_TRANSPORT_CLOSED',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function namedRefusal(code, detail) {
  return { ok: false, code, detail };
}

/**
 * Bind one torrent transport to one pool.
 *
 * @param {{pool: object}} input
 * @returns {object} A transport binding with `ensure`, `send`, `onMessage`, `destroy` and
 *   `machineId`/`diagnostics` read surfaces.
 */
export function createWebRtcV1Transport({ pool } = {}) {
  if (
    !isRecord(pool) ||
    typeof pool.ensure !== 'function' ||
    typeof pool.send !== 'function' ||
    typeof pool.onMessage !== 'function'
  ) {
    throw new TypeError('webrtc-v1 transport: pool must expose ensure(), send() and onMessage()');
  }

  /** @type {Set<(event: object) => void>} */
  const handlers = new Set();
  let unsubscribe = null;
  let destroyed = false;

  function onPoolMessage(event) {
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch {
        // A consumer's exception must not starve other torrent streams on the same pool bus.
      }
    }
  }

  return {
    name: WEBRTC_V1_TRANSPORT_NAME,

    get machineId() {
      return typeof pool.machineId === 'string' ? pool.machineId : null;
    },

    get destroyed() {
      return destroyed;
    },

    async ensure(peer) {
      if (destroyed) {
        return namedRefusal(WEBRTC_V1_TRANSPORT_CODE.CLOSED, 'webrtc-v1 transport binding is destroyed');
      }
      return pool.ensure(peer);
    },

    async send(peer, payload) {
      if (destroyed) {
        return namedRefusal(WEBRTC_V1_TRANSPORT_CODE.CLOSED, 'webrtc-v1 transport binding is destroyed');
      }
      return pool.send(peer, payload);
    },

    onMessage(handler) {
      if (typeof handler !== 'function') throw new TypeError('webrtc-v1 transport: onMessage requires a function');
      if (destroyed) return () => {};
      handlers.add(handler);
      if (unsubscribe === null) unsubscribe = pool.onMessage(onPoolMessage);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0 && unsubscribe !== null) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    },

    /**
     * Release this binding only. No `pool.stop()`, no `pool.closePeer()`, no pair teardown.
     */
    destroy() {
      if (destroyed) return { ok: true, already: true, name: WEBRTC_V1_TRANSPORT_NAME };
      destroyed = true;
      handlers.clear();
      try {
        unsubscribe?.();
      } finally {
        unsubscribe = null;
      }
      return { ok: true, already: false, name: WEBRTC_V1_TRANSPORT_NAME };
    },

    diagnostics() {
      return {
        name: WEBRTC_V1_TRANSPORT_NAME,
        destroyed,
        subscribers: handlers.size,
        machine_id: typeof pool.machineId === 'string' ? pool.machineId : null,
        pool: pool.diagnostics?.() ?? null,
      };
    },
  };
}
