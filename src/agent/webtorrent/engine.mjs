/**
 * Loading WebTorrent without turning the package into a dependency.
 *
 * The project rule is zero runtime dependencies. WebTorrent is therefore an *optional engine*:
 * the operator may install it in a sibling directory or point `webTorrentModule` at its entry file;
 * tests inject a factory. When it is absent the V2 service still mounts and answers status, but
 * every operation that would need the engine returns `P2P_V2_WEBTORRENT_UNAVAILABLE` by name.
 *
 * The engine is deliberately configured without public trackers, DHT, LSD, uTP, UPnP or NAT-PMP
 * by default. Fleet peers arrive as explicit V1 WebRTC pairs; a public swarm would be a different
 * product and a different privacy contract.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Named failures for the optional engine. */
export const P2P_V2_ENGINE_CODE = Object.freeze({
  WEBTORRENT_UNAVAILABLE: 'P2P_V2_WEBTORRENT_UNAVAILABLE',
  WEBTORRENT_INVALID: 'P2P_V2_WEBTORRENT_INVALID',
  WEBTORRENT_LOAD_FAILED: 'P2P_V2_WEBTORRENT_LOAD_FAILED',
});

const loadCache = new Map();

/**
 * @param {unknown} value
 * @returns {value is Function}
 */
function isConstructor(value) {
  return typeof value === 'function';
}

/**
 * Resolve `webtorrent` from a package name or an explicit entry file. The explicit form exists for
 * deployments that keep the engine outside the plugin's dependency tree.
 *
 * @param {string} modulePath
 * @returns {string}
 */
function importSpecifier(modulePath) {
  if (modulePath === 'webtorrent') return modulePath;
  const looksLikePath =
    isAbsolute(modulePath) ||
    modulePath.startsWith('./') ||
    modulePath.startsWith('../') ||
    modulePath.includes('/') ||
    modulePath.includes('\\');
  if (!looksLikePath) return modulePath;
  return pathToFileURL(resolvePath(modulePath)).href;
}

/**
 * Load one WebTorrent constructor. Repeated calls with the same path share the promise, so a
 * status poll and a first share cannot race two engine loads.
 *
 * @param {{modulePath?: string, importer?: (specifier: string) => Promise<any>}} [options]
 * @returns {Promise<{ok: true, WebTorrent: Function, source: string}|{ok: false, code: string, detail: string}>}
 */
export async function loadWebTorrentModule(options = {}) {
  const modulePath =
    typeof options.modulePath === 'string' && options.modulePath !== '' ? options.modulePath : 'webtorrent';
  const importer = typeof options.importer === 'function' ? options.importer : (specifier) => import(specifier);
  if (loadCache.has(modulePath)) return loadCache.get(modulePath);

  const promise = (async () => {
    try {
      const loaded = await importer(importSpecifier(modulePath));
      const candidate = loaded?.default ?? loaded?.WebTorrent ?? loaded;
      if (!isConstructor(candidate)) {
        return {
          ok: false,
          code: P2P_V2_ENGINE_CODE.WEBTORRENT_INVALID,
          detail: `${modulePath} did not export a WebTorrent constructor`,
        };
      }
      return { ok: true, WebTorrent: candidate, source: modulePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing =
        error?.code === 'ERR_MODULE_NOT_FOUND' ||
        error?.code === 'MODULE_NOT_FOUND' ||
        /Cannot find (package|module)|not found/i.test(message);
      return {
        ok: false,
        code: missing
          ? P2P_V2_ENGINE_CODE.WEBTORRENT_UNAVAILABLE
          : P2P_V2_ENGINE_CODE.WEBTORRENT_LOAD_FAILED,
        detail: message,
      };
    }
  })();
  loadCache.set(modulePath, promise);
  return promise;
}

/** Clear the load cache. Tests use this; production has one engine per process. */
export function resetWebTorrentModuleCache() {
  loadCache.clear();
}

/**
 * Client options that keep the engine on the explicit peer plane. Trackers are opt-in because a
 * public announce would leak the info hash and the file name to third parties.
 *
 * @param {{trackers?: string[], allow_native_trackers?: boolean, max_conns?: number}} cfg
 * @returns {object}
 */
export function webTorrentClientOptions(cfg = {}) {
  const trackers = Array.isArray(cfg.trackers) ? cfg.trackers.filter((value) => typeof value === 'string') : [];
  const native = cfg.allow_native_trackers === true && trackers.length > 0;
  return {
    tracker: native ? { announce: trackers } : false,
    dht: false,
    lsd: false,
    utp: false,
    natUpnp: false,
    natPmp: false,
    ...(Number.isInteger(cfg.max_conns) && cfg.max_conns > 0 ? { maxConns: cfg.max_conns } : {}),
  };
}

/**
 * Create a WebTorrent client with the V2 privacy defaults.
 *
 * @param {Function} WebTorrent
 * @param {object} cfg
 * @returns {{ok: true, client: object}|{ok: false, code: string, detail: string}}
 */
export function createWebTorrentClient(WebTorrent, cfg = {}) {
  try {
    const client = new WebTorrent(webTorrentClientOptions(cfg));
    if (client === null || typeof client !== 'object') {
      return {
        ok: false,
        code: P2P_V2_ENGINE_CODE.WEBTORRENT_INVALID,
        detail: 'WebTorrent constructor returned no client',
      };
    }
    return { ok: true, client };
  } catch (error) {
    return {
      ok: false,
      code: P2P_V2_ENGINE_CODE.WEBTORRENT_LOAD_FAILED,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
