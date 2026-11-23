/**
 * Torrent transport registry.
 *
 * A transport is a *definition*, not a live connection: it knows how to bind to a particular
 * process pool and return the small byte-plane interface the peer adapter and service use.
 * Keeping the registry at the definition level lets one process register `webrtc-v1` once while
 * every service instance gets its own binding over the shared pool.
 *
 * The definition contract:
 *
 *   { name: string, create(context: {pool, service?, now?}) -> TransportBinding }
 *
 * A binding exposes:
 *
 *   ensure(peer) -> Promise<{ok, ...}>
 *   send(peer, payload) -> Promise<{ok, ...}>
 *   onMessage(handler) -> unsubscribe
 *   destroy() -> void|object        // release this binding, never the underlying pool/pair
 *
 * The BitTorrent frame format is transport-independent and lives in `../multiplex.mjs`; a
 * transport only moves opaque payloads.
 */

import { createWebRtcV1Transport } from './webrtc-v1.mjs';

/** Default transport name used by `share`, `add` and `attach` when the caller omits one. */
export const TORRENT_DEFAULT_TRANSPORT = 'webrtc-v1';

/** Named failures for transport selection and binding. */
export const TORRENT_TRANSPORT_CODE = Object.freeze({
  INVALID_NAME: 'P2P_V2_TRANSPORT_INVALID_NAME',
  INVALID_TRANSPORT: 'P2P_V2_TRANSPORT_INVALID',
  UNKNOWN: 'P2P_V2_TRANSPORT_UNKNOWN',
  CREATE_FAILED: 'P2P_V2_TRANSPORT_CREATE_FAILED',
});

function namedError(code, detail) {
  const error = new Error(detail);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(name) {
  if (typeof name !== 'string' || name.trim() === '' || name.includes('\u0000')) {
    throw namedError(TORRENT_TRANSPORT_CODE.INVALID_NAME, 'transport name must be a non-empty string without NUL');
  }
  return name.trim();
}

/**
 * A registry instance. Production uses the singleton at the bottom; tests use this factory so a
 * fake transport cannot leak into the next test.
 */
export function createTorrentTransportRegistry() {
  /** @type {Map<string, {name: string, create: Function}>} */
  const transports = new Map();

  function register(name, transport) {
    const normalized = normalizeName(name);
    if (!isRecord(transport) || typeof transport.create !== 'function') {
      throw namedError(
        TORRENT_TRANSPORT_CODE.INVALID_TRANSPORT,
        `transport ${JSON.stringify(normalized)} must be an object with create({pool})`,
      );
    }
    if (transport.name !== undefined && transport.name !== normalized) {
      throw namedError(
        TORRENT_TRANSPORT_CODE.INVALID_TRANSPORT,
        `transport ${JSON.stringify(normalized)} reports a different name ${JSON.stringify(transport.name)}`,
      );
    }
    const definition = Object.freeze({ name: normalized, create: transport.create });
    transports.set(normalized, definition);
    return definition;
  }

  function get(name = TORRENT_DEFAULT_TRANSPORT) {
    const normalized = normalizeName(name);
    const definition = transports.get(normalized);
    if (definition === undefined) {
      throw namedError(
        TORRENT_TRANSPORT_CODE.UNKNOWN,
        `unknown torrent transport ${JSON.stringify(normalized)}; registered: ${[...transports.keys()].join(', ')}`,
      );
    }
    return definition;
  }

  function has(name) {
    try {
      return transports.has(normalizeName(name));
    } catch {
      return false;
    }
  }

  function list() {
    return [...transports.keys()];
  }

  return { register, get, has, list };
}

const registry = createTorrentTransportRegistry();

/** Register a transport definition on the process registry. Last registration for a name wins. */
export function registerTorrentTransport(name, transport) {
  return registry.register(name, transport);
}

/** Look up a transport definition; unknown names throw a named `P2P_V2_TRANSPORT_UNKNOWN`. */
export function getTorrentTransport(name = TORRENT_DEFAULT_TRANSPORT) {
  return registry.get(name);
}

/** Whether a transport name is registered, without throwing. */
export function hasTorrentTransport(name) {
  return registry.has(name);
}

/** Registered transport names, for diagnostics and tests. */
export function listTorrentTransports() {
  return registry.list();
}

/** The process registry, injected into services and used by the named wrappers above. */
export const torrentTransportRegistry = Object.freeze({
  register: (name, transport) => registry.register(name, transport),
  get: (name) => registry.get(name),
  has: (name) => registry.has(name),
  list: () => registry.list(),
});

// The one built-in transport. `webrtc-v1` binds to the shared pool at use time; the definition
// itself owns nothing and can be looked up before a pool exists.
registerTorrentTransport(TORRENT_DEFAULT_TRANSPORT, {
  name: TORRENT_DEFAULT_TRANSPORT,
  create: createWebRtcV1Transport,
});
