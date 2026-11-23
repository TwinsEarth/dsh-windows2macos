/**
 * P2P V2 service: WebTorrent for file pieces, a named torrent transport for peer bytes.
 *
 * This module is intentionally below the Cordis plugin. It knows nothing about tools, routes or
 * DSH; it owns one optional WebTorrent client, a map of shares, and a map of logical torrent
 * streams over shared transport bindings. The plugin layer normalizes configuration and exposes
 * tools.
 *
 * Two planes, one pair:
 *
 *   task.offer / result.ack / teams / view.*   -> JSON, existing `webrtc-v1` dispatcher
 *   BitTorrent wire chunks                    -> tagged with TORRENT_FRAME_MAGIC + info hash
 *
 * The tag is what lets one DataChannel carry both without either consumer parsing the other's
 * bytes. The V2 service never closes a pair: `webrtc-v1` is a transport binding borrowed from the
 * process-wide pool and may also carry task dispatch for the same peer.
 */

import { mkdirSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  P2P_V2_ENGINE_CODE,
  createWebTorrentClient,
  loadWebTorrentModule,
} from './engine.mjs';
import { createTorrentPeerAdapter } from './peer-adapter.mjs';
import { decodeTorrentFrame, normalizeInfoHash, shareIdFor } from './multiplex.mjs';
import { TORRENT_DEFAULT_TRANSPORT, torrentTransportRegistry } from './transports/registry.mjs';

/** Named failures the service and tools expose. */
export const P2P_V2_CODE = Object.freeze({
  POOL_UNAVAILABLE: 'P2P_V2_POOL_UNAVAILABLE',
  POOL_INVALID: 'P2P_V2_POOL_INVALID',
  ENGINE_UNAVAILABLE: P2P_V2_ENGINE_CODE.WEBTORRENT_UNAVAILABLE,
  ENGINE_INVALID: P2P_V2_ENGINE_CODE.WEBTORRENT_INVALID,
  ENGINE_LOAD_FAILED: P2P_V2_ENGINE_CODE.WEBTORRENT_LOAD_FAILED,
  SOURCE_NOT_FOUND: 'P2P_V2_SOURCE_NOT_FOUND',
  SOURCE_INVALID: 'P2P_V2_SOURCE_INVALID',
  DEST_INVALID: 'P2P_V2_DEST_INVALID',
  SHARE_LIMIT: 'P2P_V2_SHARE_LIMIT',
  SHARE_NOT_FOUND: 'P2P_V2_SHARE_NOT_FOUND',
  TORRENT_ADD_FAILED: 'P2P_V2_TORRENT_ADD_FAILED',
  TORRENT_READY_TIMEOUT: 'P2P_V2_TORRENT_READY_TIMEOUT',
  PEER_REQUIRED: 'P2P_V2_PEER_REQUIRED',
  PEER_SELF: 'P2P_V2_PEER_SELF',
  PEER_LIMIT: 'P2P_V2_PEER_LIMIT',
  PEER_UNREACHABLE: 'P2P_V2_PEER_UNREACHABLE',
  PEERS_UNREACHABLE: 'P2P_V2_PEERS_UNREACHABLE',
  PEER_ATTACH_FAILED: 'P2P_V2_PEER_ATTACH_FAILED',
  TORRENT_PEER_FAILED: 'P2P_V2_TORRENT_PEER_FAILED',
  SHARE_STOP_FAILED: 'P2P_V2_SHARE_STOP_FAILED',
  TRANSPORT_UNKNOWN: 'P2P_V2_TRANSPORT_UNKNOWN',
  TRANSPORT_INVALID: 'P2P_V2_TRANSPORT_INVALID',
  TRANSPORT_CREATE_FAILED: 'P2P_V2_TRANSPORT_CREATE_FAILED',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function int(value, fallback, min = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Seed and wait for the engine's own `seed` callback. WebTorrent calls it after the torrent
 * metadata exists; a file seed is usually immediate, a directory seed may hash for a while.
 *
 * @param {object} client
 * @param {string} source
 * @param {object} opts
 * @param {number} timeoutMs
 * @returns {Promise<{ok: true, torrent: object}|{ok: false, code: string, detail: string}>}
 */
function seedTorrent(client, source, opts, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let returned = null;
    const destroyReturned = () => {
      try {
        returned?.destroy?.();
      } catch {
        // The client error path already lost this torrent; destroying is best effort.
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener?.('error', onClientError);
      if (result.ok !== true) destroyReturned();
      resolve(result);
    };
    const onClientError = (error) =>
      finish({ ok: false, code: 'P2P_V2_TORRENT_ADD_FAILED', detail: errorDetail(error) });
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          code: P2P_V2_CODE.TORRENT_READY_TIMEOUT,
          detail: `seed() did not finish within ${timeoutMs} ms`,
        }),
      timeoutMs,
    );
    timer.unref?.();
    client.once?.('error', onClientError);
    try {
      returned = client.seed(source, opts, (torrent) => {
        finish({ ok: true, torrent: torrent ?? returned });
      });
    } catch (error) {
      finish({ ok: false, code: 'P2P_V2_TORRENT_ADD_FAILED', detail: errorDetail(error) });
      return;
    }
    if (returned !== null && returned !== undefined && returned.done === true) {
      // Some engines call the callback synchronously; this is only a fallback for those that do
      // not and already have a complete local seed.
      queueMicrotask(() => {
        if (!settled) finish({ ok: true, torrent: returned });
      });
    }
  });
}

/**
 * Wait for one event or a truthy state. WebTorrent emits `infoHash` before metadata and `ready`
 * after metadata; `add` must attach a manual peer between those two events or a magnet can never
 * discover its metadata.
 *
 * @param {object} emitter
 * @param {string} event
 * @param {number} timeoutMs
 * @param {() => boolean} [already]
 * @returns {Promise<{ok: true}|{ok: false, code: string, detail: string}>}
 */
function waitForEvent(emitter, event, timeoutMs, already) {
  if (typeof already === 'function' && already()) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      emitter.removeListener?.(event, onEvent);
      emitter.removeListener?.('error', onError);
      resolve(result);
    };
    const onEvent = () => finish({ ok: true });
    const onError = (error) =>
      finish({ ok: false, code: 'P2P_V2_TORRENT_ERROR', detail: errorDetail(error) });
    const timer = setTimeout(
      () => finish({ ok: false, code: P2P_V2_CODE.TORRENT_READY_TIMEOUT, detail: `timed out waiting for ${event}` }),
      timeoutMs,
    );
    timer.unref?.();
    emitter.once?.(event, onEvent);
    emitter.once?.('error', onError);
  });
}

/** Extract a 40-hex info hash from a magnet URI. */
export function infoHashFromMagnet(value) {
  if (typeof value !== 'string') return null;
  const match = /(?:xt=urn:btih:|btih:)([0-9a-f]{40})/i.exec(value);
  return match === null ? null : match[1].toLowerCase();
}

/**
 * One V2 service. It is deliberately not an EventEmitter: tools read snapshots, and a status
 * surface that pushed events would be a second state machine to keep in sync.
 */
export class P2PV2Service {
  /**
   * @param {object} cfg Normalized configuration from `normalizePluginConfig`.
   * @param {{getPool?: () => (object|null), webTorrentFactory?: Function|null,
   *   webTorrentModule?: string|null, transportRegistry?: {get: Function}, now?: () => string}} [deps]
   */
  constructor(cfg = {}, deps = {}) {
    this.cfg = isRecord(cfg) ? cfg : {};
    this.getPool = typeof deps.getPool === 'function' ? deps.getPool : null;
    this.webTorrentFactory = typeof deps.webTorrentFactory === 'function' ? deps.webTorrentFactory : null;
    this.webTorrentModule = typeof deps.webTorrentModule === 'string' ? deps.webTorrentModule : null;
    this.transportRegistry =
      isRecord(deps.transportRegistry) && typeof deps.transportRegistry.get === 'function'
        ? deps.transportRegistry
        : torrentTransportRegistry;
    this.now = typeof deps.now === 'function' ? deps.now : nowIso;

    this.client = null;
    this.clientPromise = null;
    this.clientSource = null;
    this.engineError = null;
    this.pool = null;
    /** @type {Map<string, {binding: object, unsubscribe: Function, pool: object}>} */
    this.transports = new Map();
    this.shares = new Map();
    this.byInfoHash = new Map();
    this.adapters = new Map();
    this.attaching = new Map();
    this.stats = {
      shares: 0,
      downloads: 0,
      peers_attached: 0,
      peer_attach_failures: 0,
      frames_in: 0,
      frames_out: 0,
      orphan_frames: 0,
      bytes_in: 0,
      bytes_out: 0,
      destroyed: 0,
    };
    this.lastError = null;
    this.createdAt = this.now();
  }

  #maxShares() {
    return int(this.cfg.max_shares, 8);
  }

  #maxPeersPerShare() {
    return int(this.cfg.max_peers_per_share, 16);
  }

  #readyTimeoutMs() {
    return int(this.cfg.ready_timeout_ms, 30_000, 1_000);
  }

  #metadataTimeoutMs() {
    return int(this.cfg.metadata_timeout_ms, 10_000, 1_000);
  }

  #writeTimeoutMs() {
    return int(this.cfg.write_timeout_ms, 15_000, 1_000);
  }

  #modulePath() {
    return this.webTorrentModule ?? text(this.cfg.web_torrent_module, 'webtorrent');
  }

  /**
   * Resolve the shared pool at call time, not mount time. The root row can mount before the pool
   * exists; the same late-binding rule as the desktop route. A pool swap drops every transport
   * binding built over the previous pool, but never closes the pool itself.
   *
   * @returns {object|null}
   */
  #ensurePool() {
    const pool = this.getPool?.() ?? null;
    if (pool === null) {
      if (this.pool !== null) {
        this.#resetTransports();
        this.pool = null;
      }
      return null;
    }
    if (typeof pool !== 'object' || typeof pool.send !== 'function' || typeof pool.onMessage !== 'function') {
      this.lastError = { code: P2P_V2_CODE.POOL_INVALID, detail: 'pool must expose send() and onMessage()', at: this.now() };
      return null;
    }
    if (this.pool !== pool) {
      this.#resetTransports();
      this.pool = pool;
    }
    return pool;
  }

  /** Release every transport binding. This drops subscriptions only; pairs/pool stay alive. */
  #resetTransports() {
    for (const name of [...this.transports.keys()]) this.#dropTransport(name);
  }

  #dropTransport(name) {
    const entry = this.transports.get(name);
    if (entry === undefined) return;
    this.transports.delete(name);
    try {
      entry.unsubscribe?.();
    } catch {
      // A transport's unsubscribe is best effort; a broken binding must not block the others.
    }
    try {
      entry.binding?.destroy?.();
    } catch {
      // See above: the pool is owned elsewhere and is never torn down here.
    }
  }

  #transportName(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : TORRENT_DEFAULT_TRANSPORT;
  }

  /**
   * Look up a transport definition without requiring a pool. This makes an unknown name a named
   * refusal before `share` hashes a file, `add` creates a directory or `attach` starts a pair.
   *
   * @param {string} name
   * @returns {{ok: true, name: string, definition: object}|{ok: false, code: string, detail: string}}
   */
  #transportDefinition(name) {
    try {
      const definition = this.transportRegistry.get(name);
      if (!isRecord(definition) || typeof definition.create !== 'function') {
        return {
          ok: false,
          code: P2P_V2_CODE.TRANSPORT_INVALID,
          detail: `transport ${JSON.stringify(name)} did not provide a create({pool}) function`,
        };
      }
      return { ok: true, name, definition };
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? P2P_V2_CODE.TRANSPORT_UNKNOWN,
        detail: errorDetail(error),
      };
    }
  }

  /**
   * Create or reuse the binding for one transport over the current pool.
   *
   * @param {string} name
   * @returns {Promise<{ok: true, name: string, binding: object}|{ok: false, code: string, detail: string}>}
   */
  async #ensureTransport(name) {
    const selected = this.#transportName(name);
    const known = this.#transportDefinition(selected);
    if (known.ok !== true) return known;

    const pool = this.#ensurePool();
    if (pool === null) {
      return {
        ok: false,
        code: this.lastError?.code === P2P_V2_CODE.POOL_INVALID
          ? P2P_V2_CODE.POOL_INVALID
          : P2P_V2_CODE.POOL_UNAVAILABLE,
        detail: this.lastError?.detail ?? 'the shared WebRTC pool is not running',
      };
    }

    const cached = this.transports.get(selected);
    if (cached !== undefined && cached.pool === pool && cached.binding?.destroyed !== true) {
      return { ok: true, name: selected, binding: cached.binding };
    }
    if (cached !== undefined) this.#dropTransport(selected);

    let binding;
    try {
      binding = await Promise.resolve(
        known.definition.create({ pool, service: this, name: selected, now: this.now }),
      );
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? P2P_V2_CODE.TRANSPORT_CREATE_FAILED,
        detail: `transport ${JSON.stringify(selected)} failed to bind: ${errorDetail(error)}`,
      };
    }
    if (
      !isRecord(binding) ||
      typeof binding.name !== 'string' ||
      binding.name !== selected ||
      typeof binding.ensure !== 'function' ||
      typeof binding.send !== 'function' ||
      typeof binding.onMessage !== 'function'
    ) {
      try {
        binding?.destroy?.();
      } catch {
        // Invalid binding has no usable resources; nothing else to release.
      }
      return {
        ok: false,
        code: P2P_V2_CODE.TRANSPORT_INVALID,
        detail: `transport ${JSON.stringify(selected)} did not return a named ensure/send/onMessage binding`,
      };
    }

    let unsubscribe;
    try {
      unsubscribe = binding.onMessage((event) => this.#onTransportMessage(selected, event));
    } catch (error) {
      try {
        binding.destroy?.();
      } catch {
        // Binding failed while subscribing; there is no live handler to keep.
      }
      return {
        ok: false,
        code: P2P_V2_CODE.TRANSPORT_CREATE_FAILED,
        detail: `transport ${JSON.stringify(selected)} failed to subscribe: ${errorDetail(error)}`,
      };
    }
    if (typeof unsubscribe !== 'function') {
      try {
        binding.destroy?.();
      } catch {
        // See above.
      }
      return {
        ok: false,
        code: P2P_V2_CODE.TRANSPORT_INVALID,
        detail: `transport ${JSON.stringify(selected)} onMessage() must return an unsubscribe function`,
      };
    }

    this.transports.set(selected, { binding, unsubscribe, pool });
    return { ok: true, name: selected, binding };
  }

  #onTransportMessage(transportName, event) {
    const peer = text(event?.peer, '');
    const decoded = decodeTorrentFrame(event?.payload);
    if (decoded === null) return;
    this.stats.frames_in += 1;
    this.stats.bytes_in += decoded.payload.length;
    if (peer === '') {
      this.stats.orphan_frames += 1;
      return;
    }
    const adapter = this.adapters.get(`${peer}\u0000${decoded.infoHash}`);
    if (adapter === undefined || adapter.destroyed || adapter.transport !== transportName) {
      this.stats.orphan_frames += 1;
      return;
    }
    adapter.feed(decoded.payload);
  }

  /**
   * Load the optional engine once. A missing module is a named state, not a mount failure.
   *
   * @returns {Promise<{ok: true, client: object}|{ok: false, code: string, detail: string}>}
   */
  async #ensureClient() {
    if (this.client !== null) return { ok: true, client: this.client };
    if (this.clientPromise !== null) return this.clientPromise;

    this.clientPromise = (async () => {
      let constructor = null;
      let source = this.#modulePath();
      if (this.webTorrentFactory !== null) {
        try {
          const made = await this.webTorrentFactory({ cfg: this.cfg });
          if (isRecord(made) && typeof made.seed === 'function' && typeof made.add === 'function' && typeof made.destroy === 'function') {
            this.client = made;
            this.clientSource = 'injected';
            return { ok: true, client: made };
          }
          this.engineError = {
            code: P2P_V2_CODE.ENGINE_INVALID,
            detail: 'webTorrentFactory did not return a client with seed/add/destroy',
            at: this.now(),
          };
          return { ok: false, ...this.engineError };
        } catch (error) {
          this.engineError = {
            code: P2P_V2_CODE.ENGINE_LOAD_FAILED,
            detail: errorDetail(error),
            at: this.now(),
          };
          return { ok: false, ...this.engineError };
        }
      }

      const loaded = await loadWebTorrentModule({ modulePath: source });
      if (loaded.ok !== true) {
        this.engineError = { code: loaded.code, detail: loaded.detail, at: this.now() };
        return loaded;
      }
      constructor = loaded.WebTorrent;
      source = loaded.source;
      const created = createWebTorrentClient(constructor, this.cfg);
      if (created.ok !== true) {
        this.engineError = { code: created.code, detail: created.detail, at: this.now() };
        return created;
      }
      this.client = created.client;
      this.clientSource = source;
      this.client.on?.('error', (error) => {
        this.lastError = { code: P2P_V2_CODE.ENGINE_LOAD_FAILED, detail: errorDetail(error), at: this.now() };
      });
      this.client.on?.('warning', (warning) => {
        this.lastError = { code: 'P2P_V2_WEBTORRENT_WARNING', detail: errorDetail(warning), at: this.now() };
      });
      return { ok: true, client: this.client };
    })();

    try {
      return await this.clientPromise;
    } finally {
      this.clientPromise = null;
    }
  }

  #resolveShare(input = {}) {
    const shareId = text(input.share_id, '');
    if (shareId !== '' && this.shares.has(shareId)) return this.shares.get(shareId);
    const infoHash = normalizeInfoHash(input.info_hash) ?? infoHashFromMagnet(input.magnet);
    if (infoHash !== null && this.byInfoHash.has(infoHash)) return this.byInfoHash.get(infoHash);
    return null;
  }

  #recordShare(torrent, record) {
    this.shares.set(record.share_id, record);
    if (record.info_hash !== null) this.byInfoHash.set(record.info_hash, record);
    torrent.on?.('error', (error) => {
      record.last_error = { code: 'P2P_V2_TORRENT_ERROR', detail: errorDetail(error), at: this.now() };
      this.lastError = record.last_error;
    });
    torrent.on?.('warning', (warning) => {
      record.last_error = { code: 'P2P_V2_TORRENT_WARNING', detail: errorDetail(warning), at: this.now() };
    });
    this.stats.shares += 1;
  }

  #recordFromTorrent(torrent, { mode, inputPath, downloadPath, transport }) {
    const infoHash = normalizeInfoHash(torrent.infoHash ?? torrent.infoHashBuffer);
    if (infoHash === null) {
      return {
        ok: false,
        code: P2P_V2_CODE.TORRENT_ADD_FAILED,
        detail: 'the engine did not expose a 40-hex info hash',
      };
    }
    return {
      ok: true,
      record: {
        share_id: shareIdFor(infoHash),
        info_hash: infoHash,
        magnet_uri: text(torrent.magnetURI, ''),
        name: text(torrent.name, ''),
        mode,
        transport: transport ?? TORRENT_DEFAULT_TRANSPORT,
        input_path: inputPath ?? null,
        download_path: downloadPath ?? null,
        torrent,
        peers: new Map(),
        created_at: this.now(),
        last_error: null,
      },
    };
  }

  #torrentSummary(record) {
    const torrent = record.torrent;
    const files = Array.isArray(torrent.files)
      ? torrent.files.slice(0, 50).map((file) => ({
          name: text(file.name, ''),
          path: text(file.path, ''),
          length: Number.isInteger(file.length) ? file.length : null,
        }))
      : [];
    const localRole = record.mode === 'seed' ? 'seeder' : 'leecher';
    const peerRows = [...record.peers.values()].map((peer) => {
      const chunksIn = peer.adapter?.stats?.chunks_in ?? 0;
      const chunksOut = peer.adapter?.stats?.chunks_out ?? 0;
      const bytesIn = peer.adapter?.stats?.bytes_in ?? 0;
      const bytesOut = peer.adapter?.stats?.bytes_out ?? 0;
      return {
        machine_id: peer.machine_id,
        role: peer.role ?? (localRole === 'seeder' ? 'leecher' : 'seeder'),
        transport: peer.transport ?? record.transport ?? TORRENT_DEFAULT_TRANSPORT,
        attached_at: peer.attached_at,
        state: peer.adapter?.destroyed === true ? 'closed' : 'open',
        chunks_in: chunksIn,
        chunks_out: chunksOut,
        chunks: chunksIn + chunksOut,
        bytes_in: bytesIn,
        bytes_out: bytesOut,
        bytes: bytesIn + bytesOut,
        last_error: peer.adapter?.stats?.last_error ?? null,
      };
    });
    const peerCount = 1 + peerRows.length;
    const seeders = (localRole === 'seeder' ? 1 : 0) + peerRows.filter((peer) => peer.role === 'seeder').length;
    const leechers = (localRole === 'leecher' ? 1 : 0) + peerRows.filter((peer) => peer.role === 'leecher').length;
    const progress = Number.isFinite(torrent.progress) ? torrent.progress : 0;
    return {
      share_id: record.share_id,
      info_hash: record.info_hash,
      magnet_uri: record.magnet_uri || text(torrent.magnetURI, ''),
      name: record.name || text(torrent.name, ''),
      mode: record.mode,
      transport: record.transport ?? TORRENT_DEFAULT_TRANSPORT,
      input_path: record.input_path,
      download_path: record.download_path,
      created_at: record.created_at,
      length: Number.isFinite(torrent.length) ? torrent.length : null,
      downloaded: Number.isFinite(torrent.downloaded) ? torrent.downloaded : null,
      uploaded: Number.isFinite(torrent.uploaded) ? torrent.uploaded : null,
      progress,
      done: torrent.done === true,
      peer_count: peerCount,
      seeders,
      leechers,
      num_peers: Number.isInteger(torrent.numPeers) ? torrent.numPeers : record.peers.size,
      download_speed: Number.isFinite(torrent.downloadSpeed) ? torrent.downloadSpeed : null,
      upload_speed: Number.isFinite(torrent.uploadSpeed) ? torrent.uploadSpeed : null,
      peers: peerRows,
      files,
      file_count: Array.isArray(torrent.files) ? torrent.files.length : null,
      last_error: record.last_error,
      swarm: {
        info_hash: record.info_hash,
        transport: record.transport ?? TORRENT_DEFAULT_TRANSPORT,
        peer_count: peerCount,
        seeders,
        leechers,
        progress,
        done: torrent.done === true,
        files,
        file_count: Array.isArray(torrent.files) ? torrent.files.length : null,
      },
    };
  }

  /**
   * Seed one file or directory and, optionally, attach peers.
   *
   * @param {{path: string, name?: string, peers?: string[], transport?: string}} input
   * @returns {Promise<object>}
   */
  async share(input = {}) {
    const transportName = this.#transportName(input.transport);
    const knownTransport = this.#transportDefinition(transportName);
    if (knownTransport.ok !== true) {
      return {
        ok: false,
        code: knownTransport.code,
        transport: transportName,
        detail: knownTransport.detail,
      };
    }
    const path = text(input.path, '');
    if (path === '' || path.includes('\u0000')) {
      return { ok: false, code: P2P_V2_CODE.SOURCE_INVALID, detail: 'path is required' };
    }
    let source;
    try {
      source = resolvePath(path);
      const stat = statSync(source);
      if (!stat.isFile() && !stat.isDirectory()) {
        return { ok: false, code: P2P_V2_CODE.SOURCE_INVALID, detail: 'path must be a regular file or directory' };
      }
    } catch (error) {
      return {
        ok: false,
        code: P2P_V2_CODE.SOURCE_NOT_FOUND,
        detail: `${source ?? path}: ${errorDetail(error)}`,
      };
    }
    // Seeding the same path twice would create a second record for the same info hash and a second
    // engine torrent. Treat the path as the idempotency key while the record is live.
    const existingSeed = [...this.shares.values()].find(
      (record) => record.mode === 'seed' && record.input_path === source,
    );
    if (existingSeed !== undefined) {
      return { ok: true, reused: true, share: this.#torrentSummary(existingSeed), peers: [], peer_errors: [] };
    }
    if (this.shares.size >= this.#maxShares()) {
      return {
        ok: false,
        code: P2P_V2_CODE.SHARE_LIMIT,
        detail: `share limit ${this.#maxShares()} reached; stop one share first`,
      };
    }

    const engine = await this.#ensureClient();
    if (engine.ok !== true) return { ok: false, code: engine.code, detail: engine.detail };

    const opts = {
      ...(text(input.name, '') === '' ? {} : { name: text(input.name) }),
      announce: this.cfg.allow_native_trackers === true && Array.isArray(this.cfg.trackers) ? this.cfg.trackers : [],
    };
    const seeded = await seedTorrent(engine.client, source, opts, this.#readyTimeoutMs());
    if (seeded.ok !== true) return seeded;
    const torrent = seeded.torrent;
    if (torrent === null || typeof torrent !== 'object') {
      return { ok: false, code: P2P_V2_CODE.TORRENT_ADD_FAILED, detail: 'seed() returned no torrent' };
    }
    const made = this.#recordFromTorrent(torrent, {
      mode: 'seed',
      inputPath: source,
      downloadPath: null,
      transport: transportName,
    });
    if (made.ok !== true) return made;
    this.#recordShare(torrent, made.record);
    const attached = await this.#attachPeers(made.record, input.peers, transportName, 'leecher');
    return {
      ok: true,
      share: this.#torrentSummary(made.record),
      peers: attached.attached,
      peer_errors: attached.errors,
      peers_requested: attached.requested,
    };
  }

  /**
   * Join an existing swarm and, optionally, attach peers. The peer must be attached before the
   * `ready` event or a magnet with no tracker can never fetch metadata; this method therefore
   * waits for `infoHash`, attaches, and only then waits (bounded) for `ready`.
   *
   * @param {{magnet?: string, torrent_file?: Buffer|string, path: string, peers?: string[],
   *   transport?: string}} input
   * @returns {Promise<object>}
   */
  async add(input = {}) {
    const transportName = this.#transportName(input.transport);
    const knownTransport = this.#transportDefinition(transportName);
    if (knownTransport.ok !== true) {
      return {
        ok: false,
        code: knownTransport.code,
        transport: transportName,
        detail: knownTransport.detail,
      };
    }
    const destination = text(input.path, '');
    if (destination === '' || destination.includes('\u0000')) {
      return { ok: false, code: P2P_V2_CODE.DEST_INVALID, detail: 'path is required as the download directory' };
    }
    let dest;
    try {
      dest = resolvePath(destination);
      mkdirSync(dest, { recursive: true });
      if (!statSync(dest).isDirectory()) {
        return { ok: false, code: P2P_V2_CODE.DEST_INVALID, detail: 'path must be a directory' };
      }
    } catch (error) {
      return { ok: false, code: P2P_V2_CODE.DEST_INVALID, detail: errorDetail(error) };
    }
    if (this.shares.size >= this.#maxShares()) {
      return {
        ok: false,
        code: P2P_V2_CODE.SHARE_LIMIT,
        detail: `share limit ${this.#maxShares()} reached; stop one share first`,
      };
    }
    const magnet = text(input.magnet, '');
    const torrentId = magnet !== '' ? magnet : input.torrent_file;
    if (torrentId === undefined || torrentId === null || torrentId === '') {
      return { ok: false, code: P2P_V2_CODE.TORRENT_ADD_FAILED, detail: 'magnet or torrent_file is required' };
    }
    const infoHash = infoHashFromMagnet(magnet);
    if (infoHash !== null && this.byInfoHash.has(infoHash)) {
      return { ok: true, reused: true, share: this.#torrentSummary(this.byInfoHash.get(infoHash)) };
    }

    const engine = await this.#ensureClient();
    if (engine.ok !== true) return { ok: false, code: engine.code, detail: engine.detail };

    let torrent;
    try {
      torrent = engine.client.add(torrentId, {
        path: dest,
        announce: this.cfg.allow_native_trackers === true && Array.isArray(this.cfg.trackers) ? this.cfg.trackers : [],
      });
    } catch (error) {
      return { ok: false, code: P2P_V2_CODE.TORRENT_ADD_FAILED, detail: errorDetail(error) };
    }
    if (torrent === null || typeof torrent !== 'object') {
      return { ok: false, code: P2P_V2_CODE.TORRENT_ADD_FAILED, detail: 'add() returned no torrent' };
    }
    const hashed = await waitForEvent(torrent, 'infoHash', this.#metadataTimeoutMs(), () => torrent.infoHash !== undefined);
    if (hashed.ok !== true) {
      try {
        torrent.destroy?.();
      } catch {
        // No metadata means no usable torrent; drop it so the client does not keep a dead swarm.
      }
      return { ok: false, code: hashed.code ?? P2P_V2_CODE.TORRENT_READY_TIMEOUT, detail: hashed.detail };
    }
    const made = this.#recordFromTorrent(torrent, {
      mode: 'download',
      inputPath: null,
      downloadPath: dest,
      transport: transportName,
    });
    if (made.ok !== true) {
      try {
        torrent.destroy?.();
      } catch {
        // The record could not be built, so no tool can reach this torrent; drop it.
      }
      return made;
    }
    this.#recordShare(torrent, made.record);
    this.stats.downloads += 1;
    const attached = await this.#attachPeers(made.record, input.peers, transportName, 'seeder');
    if (attached.requested > 0 && attached.attached.length === 0) {
      const cleanup = await this.stop({ share_id: made.record.share_id });
      return {
        ok: false,
        code: P2P_V2_CODE.PEERS_UNREACHABLE,
        detail: `all ${attached.requested} requested peer(s) failed to attach`,
        share_id: made.record.share_id,
        info_hash: made.record.info_hash,
        transport: transportName,
        peers_requested: attached.requested,
        peers: [],
        peer_errors: attached.errors,
        cleanup_errors: cleanup.errors ?? [],
        metadata_ready: false,
      };
    }
    // Metadata may be available before attach; this wait is bounded and does not hold the tool
    // call until the whole file downloads. A later status poll reports progress.
    const ready = await waitForEvent(torrent, 'ready', this.#metadataTimeoutMs(), () => torrentReady(torrent));
    return {
      ok: true,
      share: this.#torrentSummary(made.record),
      peers: attached.attached,
      peer_errors: attached.errors,
      peers_requested: attached.requested,
      metadata_ready: ready.ok === true,
      metadata_failure: ready.ok === true ? null : { code: ready.code, detail: ready.detail },
    };
  }

  /**
   * Attach one peer to one share over a named transport. Repeated calls are idempotent per
   * (peer, info hash).
   *
   * @param {{share_id?: string, info_hash?: string, magnet?: string, machine_id: string,
   *   transport?: string}} input
   * @returns {Promise<object>}
   */
  async attach(input = {}) {
    const record = this.#resolveShare(input);
    if (record === null) {
      return { ok: false, code: P2P_V2_CODE.SHARE_NOT_FOUND, detail: 'share is not active on this machine' };
    }
    const machineId = text(input.machine_id, '');
    if (machineId === '') return { ok: false, code: P2P_V2_CODE.PEER_REQUIRED, detail: 'machine_id is required' };
    return this.#attachPeer(record, machineId, input.transport ?? record.transport, null);
  }

  async #attachPeer(record, machineId, transportName, role = null) {
    const selected = this.#transportName(transportName ?? record.transport);
    const selectedRole = role ?? (record.mode === 'seed' ? 'leecher' : 'seeder');
    const knownTransport = this.#transportDefinition(selected);
    if (knownTransport.ok !== true) {
      return {
        ok: false,
        code: knownTransport.code,
        share_id: record.share_id,
        machine_id: machineId,
        transport: selected,
        role: selectedRole,
        detail: knownTransport.detail,
      };
    }
    if (record.peers.has(machineId)) {
      return {
        ok: true,
        reused: true,
        share_id: record.share_id,
        machine_id: machineId,
        transport: record.peers.get(machineId)?.transport ?? selected,
        role: record.peers.get(machineId)?.role ?? selectedRole,
      };
    }
    if (record.peers.size >= this.#maxPeersPerShare()) {
      return {
        ok: false,
        code: P2P_V2_CODE.PEER_LIMIT,
        share_id: record.share_id,
        machine_id: machineId,
        transport: selected,
        role: selectedRole,
        detail: `peer limit ${this.#maxPeersPerShare()} reached`,
      };
    }
    const ensured = await this.#ensureTransport(selected);
    if (ensured.ok !== true) {
      this.stats.peer_attach_failures += 1;
      return {
        ok: false,
        code: ensured.code,
        share_id: record.share_id,
        machine_id: machineId,
        transport: selected,
        role: selectedRole,
        detail: ensured.detail,
      };
    }
    const transport = ensured.binding;
    if (typeof transport.machineId === 'string' && transport.machineId === machineId) {
      return {
        ok: false,
        code: P2P_V2_CODE.PEER_SELF,
        share_id: record.share_id,
        machine_id: machineId,
        transport: selected,
        role: selectedRole,
      };
    }
    const key = `${machineId}\u0000${record.info_hash}`;
    if (this.attaching.has(key)) return this.attaching.get(key);
    const promise = (async () => {
      const ready = await transport.ensure(machineId);
      if (ready?.ok !== true) {
        this.stats.peer_attach_failures += 1;
        return {
          ok: false,
          code: P2P_V2_CODE.PEER_UNREACHABLE,
          share_id: record.share_id,
          machine_id: machineId,
          transport: selected,
          role: selectedRole,
          detail: ready?.detail ?? ready?.code ?? `${selected}.ensure failed`,
          pool_code: ready?.code ?? null,
          transport_code: ready?.code ?? null,
        };
      }
      let adapter;
      try {
        adapter = createTorrentPeerAdapter({
          peer: machineId,
          infoHash: record.info_hash,
          transport,
          writeTimeoutMs: this.#writeTimeoutMs(),
          onError: (error) => {
            record.last_error = { code: error.code ?? 'P2P_V2_TORRENT_PEER_ERROR', detail: error.message, at: this.now() };
          },
        });
      } catch (error) {
        this.stats.peer_attach_failures += 1;
        return {
          ok: false,
          code: P2P_V2_CODE.PEER_ATTACH_FAILED,
          share_id: record.share_id,
          machine_id: machineId,
          transport: selected,
          role: selectedRole,
          detail: errorDetail(error),
        };
      }
      try {
        record.torrent.addPeer(adapter);
      } catch (error) {
        adapter.destroy();
        this.stats.peer_attach_failures += 1;
        return {
          ok: false,
          code: P2P_V2_CODE.TORRENT_PEER_FAILED,
          share_id: record.share_id,
          machine_id: machineId,
          transport: selected,
          role: selectedRole,
          detail: errorDetail(error),
        };
      }
      const peer = { machine_id: machineId, transport: selected, role: selectedRole, adapter, attached_at: this.now() };
      record.peers.set(machineId, peer);
      this.adapters.set(key, adapter);
      this.stats.peers_attached += 1;
      const cleanup = () => {
        if (record.peers.get(machineId)?.adapter === adapter) record.peers.delete(machineId);
        if (this.adapters.get(key) === adapter) this.adapters.delete(key);
      };
      adapter.once('close', cleanup);
      adapter.once('end', cleanup);
      return {
        ok: true,
        share_id: record.share_id,
        machine_id: machineId,
        transport: selected,
        role: selectedRole,
        peer: this.#torrentSummary(record).peers.find((entry) => entry.machine_id === machineId) ?? null,
      };
    })();
    this.attaching.set(key, promise);
    try {
      return await promise;
    } finally {
      this.attaching.delete(key);
    }
  }

  async #attachPeers(record, peers, transportName, role = null) {
    const attached = [];
    const errors = [];
    if (!Array.isArray(peers)) return { attached, errors, requested: 0 };
    const unique = [...new Set(peers.filter((peer) => typeof peer === 'string' && peer !== ''))];
    for (const machineId of unique) {
      const result = await this.#attachPeer(record, machineId, transportName, role);
      if (result.ok === true) attached.push(result);
      else errors.push(result);
    }
    return { attached, errors, requested: unique.length };
  }

  /**
   * Detach one logical torrent stream from a peer. This does not close the shared V1 pair.
   *
   * @param {{share_id?: string, info_hash?: string, magnet?: string, machine_id: string}} input
   * @returns {Promise<object>}
   */
  async detach(input = {}) {
    const record = this.#resolveShare(input);
    if (record === null) return { ok: false, code: P2P_V2_CODE.SHARE_NOT_FOUND, detail: 'share is not active' };
    const machineId = text(input.machine_id, '');
    if (machineId === '') return { ok: false, code: P2P_V2_CODE.PEER_REQUIRED, detail: 'machine_id is required' };
    const peer = record.peers.get(machineId);
    if (peer === undefined) return { ok: true, reused: true, share_id: record.share_id, machine_id: machineId };
    record.torrent.removePeer?.(peer.adapter);
    peer.adapter.destroy();
    record.peers.delete(machineId);
    this.adapters.delete(`${machineId}\u0000${record.info_hash}`);
    return { ok: true, share_id: record.share_id, machine_id: machineId };
  }

  /**
   * Stop one share or all shares. Torrents are destroyed; the shared pool is never stopped.
   *
   * @param {{share_id?: string, info_hash?: string, magnet?: string}} [input]
   * @returns {Promise<object>}
   */
  async stop(input = {}) {
    const record = this.#resolveShare(input);
    if (record === null) {
      if (input === undefined || Object.keys(input).length === 0) return this.stopAll();
      return { ok: false, code: P2P_V2_CODE.SHARE_NOT_FOUND, detail: 'share is not active' };
    }
    const errors = [];
    for (const peer of record.peers.values()) {
      try {
        peer.adapter.destroy();
      } catch (error) {
        errors.push(errorDetail(error));
      }
    }
    record.peers.clear();
    for (const key of [...this.adapters.keys()]) {
      if (key.endsWith(`\u0000${record.info_hash}`)) this.adapters.delete(key);
    }
    try {
      await new Promise((resolve) => {
        record.torrent.destroy(() => resolve());
      });
    } catch (error) {
      errors.push(errorDetail(error));
    }
    this.shares.delete(record.share_id);
    this.byInfoHash.delete(record.info_hash);
    this.stats.destroyed += 1;
    return { ok: true, share_id: record.share_id, info_hash: record.info_hash, errors };
  }

  /** Stop every share and the engine. Idempotent. */
  async stopAll() {
    const ids = [...this.shares.keys()];
    const errors = [];
    for (const shareId of ids) {
      const result = await this.stop({ share_id: shareId });
      if (result.ok !== true || (result.errors?.length ?? 0) > 0) errors.push(result);
    }
    this.#resetTransports();
    this.pool = null;
    if (this.client !== null) {
      try {
        await new Promise((resolve) => {
          this.client.destroy(() => resolve());
        });
      } catch (error) {
        errors.push({ code: 'P2P_V2_ENGINE_DESTROY_FAILED', detail: errorDetail(error) });
      }
    }
    this.client = null;
    this.clientSource = null;
    return { ok: errors.length === 0, shares: ids.length, errors };
  }

  /**
   * A read-only view of already-connected pool peers and each share's attach state. It never
   * dials, never starts a transport, and never copies the pool's signal URL or token.
   *
   * @param {{share_id?: string, info_hash?: string, magnet?: string}} [input]
   * @returns {object}
   */
  peers(input = {}) {
    const pool = this.getPool?.() ?? this.pool;
    const wantsShare = input !== null && typeof input === 'object' &&
      (input.share_id !== undefined || input.info_hash !== undefined || input.magnet !== undefined);
    const selected = wantsShare ? this.#resolveShare(input) : null;
    if (wantsShare && selected === null) {
      return { ok: false, code: P2P_V2_CODE.SHARE_NOT_FOUND, detail: 'share is not active on this machine' };
    }
    const diagnostics = pool?.diagnostics?.() ?? null;
    const poolPeers = Array.isArray(diagnostics?.peers)
      ? diagnostics.peers.map((entry) => ({
          peer: text(entry?.peer, ''),
          role: text(entry?.role, '') || null,
          state: text(entry?.state, '') || null,
          ok: entry?.ok === true,
          path: text(entry?.path, '') || null,
          rtt_ms: Number.isFinite(entry?.rtt_ms) ? entry.rtt_ms : null,
          secure: typeof entry?.secure === 'string' ? entry.secure : null,
          sends: Number.isInteger(entry?.sends) ? entry.sends : 0,
          bytes_sent: Number.isInteger(entry?.bytes_sent) ? entry.bytes_sent : 0,
          last_error: entry?.last_error ?? null,
        }))
      : [];
    const records = selected === null ? [...this.shares.values()] : [selected];
    return {
      ok: true,
      machine_id: typeof pool?.machineId === 'string' ? pool.machineId : null,
      pool: {
        available: pool !== null,
        closed: diagnostics?.closed === true,
        peer_count: Number.isInteger(diagnostics?.peer_count) ? diagnostics.peer_count : poolPeers.length,
        peers: poolPeers,
      },
      shares: records.map((record) => {
        const summary = this.#torrentSummary(record);
        return {
          share_id: summary.share_id,
          info_hash: summary.info_hash,
          name: summary.name,
          mode: summary.mode,
          transport: summary.transport,
          peer_count: summary.peer_count,
          seeders: summary.seeders,
          leechers: summary.leechers,
          peers: summary.peers,
        };
      }),
    };
  }

  /** A diagnostics snapshot for `p2p_v2_status`. */
  status() {
    const pool = this.getPool?.() ?? this.pool;
    const transports = [...this.transports.entries()].map(([transportName, entry]) => ({
      name: transportName,
      active: entry.binding?.destroyed !== true,
      machine_id: typeof entry.binding?.machineId === 'string' ? entry.binding.machineId : null,
      peers: [...this.adapters.values()].filter(
        (adapter) => adapter.transport === transportName && adapter.destroyed !== true,
      ).length,
    }));
    return {
      plugin: 'w2m-dsh-p2p-v2',
      created_at: this.createdAt,
      transport: TORRENT_DEFAULT_TRANSPORT,
      peer_count: [...this.adapters.values()].filter((adapter) => adapter.destroyed !== true).length,
      planes: {
        task_dispatch: { transport: TORRENT_DEFAULT_TRANSPORT, scheduler: 'w2m_run' },
        file_distribution: {
          engine: 'webtorrent',
          transport: TORRENT_DEFAULT_TRANSPORT,
          default_transport: TORRENT_DEFAULT_TRANSPORT,
        },
      },
      transports,
      engine: {
        available: this.client !== null,
        loading: this.clientPromise !== null,
        source: this.clientSource,
        error: this.engineError,
      },
      pool: {
        available: pool !== null,
        machine_id: typeof pool?.machineId === 'string' ? pool.machineId : null,
        peer_count: pool?.diagnostics?.()?.peer_count ?? null,
      },
      shares: [...this.shares.values()].map((record) => this.#torrentSummary(record)),
      stats: { ...this.stats },
      last_error: this.lastError,
    };
  }
}

/** `seed()` may be ready enough without a `ready` event once the info hash and files exist. */
function torrentReady(torrent) {
  return torrent?.infoHash !== undefined && Array.isArray(torrent?.files) && torrent.files.length > 0;
}
