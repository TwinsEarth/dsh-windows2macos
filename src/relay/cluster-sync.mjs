/**
 * W2M relay v3.0.0 — relay-to-relay cluster sync.
 *
 * Design: `docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md`.
 *
 * Three relays (primary / tencent / vultr) each pull a durable-state snapshot from every peer on a
 * schedule: 60–600 s after boot (random, so a rolling restart never makes three nodes sync at once),
 * then once per hour with jitter. What is synchronized:
 *
 *   - devices: `devices.json` semantics (machine record + device token + fleet binding) — a standby
 *     relay cannot authenticate a machine whose token it never saw, so this is the one place a secret
 *     has to travel, and it travels only inside the AEAD envelope;
 *   - ledger: append-only task facts (`task.created`, `lease.changed`, `result.stored`,
 *     `task.cancelled`) — replayed into the live tables and persisted to `cluster/ledger.jsonl`.
 *
 * Never synchronized: blobs (data-plane red line), operator tokens / signing secrets (per-relay
 * authority), ephemeral presence/leases/remote frames, fleet chat and fleet memory (not durable).
 *
 * The peer surface is two GET routes, authenticated with an HMAC over method/path/timestamp/nonce and
 * answered with an AES-256-GCM envelope (`enc`), so the payload stays confidential even when the
 * relays talk over plain HTTP. Nothing in this module logs payload contents.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { ProtocolError } from './state.mjs';

export const CLUSTER_FEATURE = 'relay-cluster-sync-v1';
export const CLUSTER_PROTOCOL_VERSION = 1;

export const CLUSTER_ROUTES = Object.freeze([
  '/v1/cluster/ping',
  '/v1/cluster/snapshot',
  '/v1/cluster/devices',
]);

export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_BOOT_MIN_MS = 60 * 1000;
export const DEFAULT_BOOT_MAX_MS = 10 * 60 * 1000;
export const DEFAULT_JITTER_MS = 5 * 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_DEVICE_PAGE_SIZE = 25;
export const DEFAULT_AUTH_SKEW_MS = 120 * 1000;
export const DEFAULT_NONCE_RETENTION_MS = 10 * 60 * 1000;
export const CLUSTER_NODE_ID_RE = /^node-[0-9a-f]{8,32}$/;
const MAX_PEER_PAGES = 100;

const HMAC_DOMAIN = 'w2m-cluster-auth-v1';
const ENVELOPE_AAD_DOMAIN = 'w2m-cluster-envelope-v1';

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

function parsePeers(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (err) {
      throw new Error(`cluster peers must be a JSON array (${err.message})`, { cause: err });
    }
  }
  if (!Array.isArray(list)) throw new Error('cluster peers must be an array');
  const peers = [];
  const seen = new Set();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') throw new Error('cluster peer must be an object');
    const url = typeof entry.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : '';
    if (!/^https?:\/\/[^/\s]+/i.test(url)) throw new Error(`cluster peer url is invalid: ${JSON.stringify(entry.url)}`);
    const id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : url;
    if (!/^node-[0-9a-f]{8,32}$/.test(id)) throw new Error(`cluster peer id must look like node-<8-32 hex>: ${JSON.stringify(id)}`);
    if (seen.has(id)) throw new Error(`duplicate cluster peer id: ${id}`);
    seen.add(id);
    peers.push({ id, url });
  }
  if (peers.length === 0) throw new Error('cluster peers must not be empty');
  return peers;
}

function parseSecret(raw) {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 32) throw new Error('cluster secret must be 32 bytes');
    return Buffer.from(raw);
  }
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('cluster secret is required (base64, 32 bytes)');
  let buf;
  try { buf = Buffer.from(raw.trim(), 'base64'); } catch { throw new Error('cluster secret must be base64'); }
  if (buf.length !== 32) throw new Error('cluster secret must decode to 32 bytes');
  return buf;
}

function positiveInt(value, fallback, name, { min = 1 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`cluster ${name} must be an integer >= ${min}`);
  return n;
}

/**
 * Validate/normalize a cluster configuration.
 *
 * `enabled: false` (or no configuration at all) leaves the relay byte-for-byte a 2.1.5 relay: no
 * routes, no scheduler, no feature flag. Explicitly-enabled-but-incomplete configuration throws,
 * because starting a relay that silently is not syncing is worse than not starting it.
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeClusterConfig(raw = {}) {
  const enabled = raw.enabled === true || (raw.enabled === undefined && (raw.peers !== undefined || raw.secret !== undefined));
  const intervalMs = positiveInt(raw.intervalMs, DEFAULT_SYNC_INTERVAL_MS, 'intervalMs', { min: 1000 });
  const bootMinMs = positiveInt(raw.bootMinMs, DEFAULT_BOOT_MIN_MS, 'bootMinMs', { min: 0 });
  const bootMaxMs = positiveInt(raw.bootMaxMs, DEFAULT_BOOT_MAX_MS, 'bootMaxMs', { min: bootMinMs });
  if (bootMaxMs < bootMinMs) throw new Error('cluster bootMaxMs must be >= bootMinMs');
  const jitterMs = positiveInt(raw.jitterMs, DEFAULT_JITTER_MS, 'jitterMs', { min: 0 });
  const chunkBytes = positiveInt(raw.chunkBytes, 2 * 1024 * 1024, 'chunkBytes', { min: 1024 });
  const requestTimeoutMs = positiveInt(raw.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs', { min: 1000 });
  const devicePageSize = positiveInt(raw.devicePageSize, DEFAULT_DEVICE_PAGE_SIZE, 'devicePageSize', { min: 1 });
  const config = {
    enabled,
    nodeId: typeof raw.nodeId === 'string' && raw.nodeId !== '' ? raw.nodeId : null,
    peers: [],
    secret: null,
    intervalMs,
    bootMinMs,
    bootMaxMs,
    jitterMs,
    chunkBytes,
    requestTimeoutMs,
    devicePageSize,
    authSkewMs: positiveInt(raw.authSkewMs, DEFAULT_AUTH_SKEW_MS, 'authSkewMs', { min: 1000 }),
    allowIps: Array.isArray(raw.allowIps) ? raw.allowIps.map(String).filter(Boolean) : [],
  };
  if (config.nodeId !== null && !CLUSTER_NODE_ID_RE.test(config.nodeId)) {
    throw new Error('cluster nodeId must look like node-<8-32 hex>');
  }
  if (!enabled) return config;
  config.peers = parsePeers(raw.peers);
  config.secret = parseSecret(raw.secret);
  return config;
}

/* ------------------------------------------------------------------ */
/* crypto                                                              */
/* ------------------------------------------------------------------ */

/**
 * Request authentication token.
 *
 * Covers the deployment path, the timestamp, the nonce and the `since` cursor, so a captured request
 * cannot be re-pointed at a different path or a different cursor while staying valid. The relay-side
 * verifier additionally enforces the timestamp window and a nonce replay cache.
 */
export function clusterAuthToken({ secret, method, path, ts, nonce, since = '' }) {
  return createHmac('sha256', secret)
    .update(`${HMAC_DOMAIN}\n${String(method).toUpperCase()}\n${path}\n${ts}\n${nonce}\n${since}`)
    .digest('base64');
}

/** Constant-time comparison of two base64 HMAC strings. */
export function safeEqualBase64(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function envelopeAad({ senderNodeId, receiverNodeId, ts, nonce }) {
  return `${ENVELOPE_AAD_DOMAIN}|${senderNodeId}|${receiverNodeId}|${ts}|${nonce}`;
}

/**
 * Encrypt a JSON payload for one specific peer.
 *
 * The receiver id is in the AAD, so an envelope addressed to relay B cannot be replayed at relay C
 * even if both share the same cluster secret.
 *
 * @param {{secret:Buffer, senderNodeId:string, receiverNodeId:string, payload:object, ts?:number, nonce?:string}} input
 * @returns {{v:number, sender_node_id:string, ts:number, nonce:string, iv:string, tag:string, ct:string}}
 */
export function sealClusterEnvelope({ secret, senderNodeId, receiverNodeId, payload, ts = Date.now(), nonce = randomBytes(16).toString('base64url') }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  cipher.setAAD(Buffer.from(envelopeAad({ senderNodeId, receiverNodeId, ts, nonce }), 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: CLUSTER_PROTOCOL_VERSION,
    sender_node_id: senderNodeId,
    receiver_node_id: receiverNodeId,
    ts,
    nonce,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * Verify + decrypt an envelope addressed to this node.
 *
 * @returns {{senderNodeId:string, ts:number, nonce:string, payload:object}}
 */
export function openClusterEnvelope({ secret, envelope, expectedSender, receiverNodeId, nowMs = Date.now(), skewMs = DEFAULT_AUTH_SKEW_MS }) {
  const refuse = (message) => { throw new ProtocolError('UNAUTHORIZED', message, { reason: 'CLUSTER_ENVELOPE' }); };
  if (envelope === null || typeof envelope !== 'object') refuse('cluster envelope is missing');
  if (envelope.v !== CLUSTER_PROTOCOL_VERSION) refuse(`unsupported cluster envelope version ${JSON.stringify(envelope.v)}`);
  if (typeof envelope.sender_node_id !== 'string' || envelope.sender_node_id !== expectedSender) refuse('cluster envelope sender does not match the peer');
  if (envelope.receiver_node_id !== receiverNodeId) refuse('cluster envelope was addressed to another relay');
  const ts = Number(envelope.ts);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > skewMs) refuse('cluster envelope timestamp is outside the allowed window');
  if (typeof envelope.nonce !== 'string' || envelope.nonce === '') refuse('cluster envelope nonce is missing');
  let iv;
  let tag;
  let ct;
  try {
    iv = Buffer.from(String(envelope.iv), 'base64');
    tag = Buffer.from(String(envelope.tag), 'base64');
    ct = Buffer.from(String(envelope.ct), 'base64');
  } catch { refuse('cluster envelope fields are not base64'); }
  if (iv.length !== 12 || tag.length !== 16) refuse('cluster envelope iv/tag have the wrong length');
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAAD(Buffer.from(envelopeAad({ senderNodeId: envelope.sender_node_id, receiverNodeId, ts, nonce: envelope.nonce }), 'utf8'));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch { refuse('cluster envelope authentication failed'); }
  let payload;
  try { payload = JSON.parse(plaintext.toString('utf8')); } catch { refuse('cluster envelope payload is not JSON'); }
  return { senderNodeId: envelope.sender_node_id, ts, nonce: envelope.nonce, payload };
}

/* ------------------------------------------------------------------ */
/* scheduling helpers (exported for tests)                             */
/* ------------------------------------------------------------------ */

/** Random first-sync delay in [bootMinMs, bootMaxMs]. */
export function bootDelayMs(config, random = Math.random) {
  const span = config.bootMaxMs - config.bootMinMs;
  return config.bootMinMs + Math.floor(random() * (span + 1));
}

/** Periodic delay: interval + [0, jitter]. */
export function periodicDelayMs(config, random = Math.random) {
  return config.intervalMs + Math.floor(random() * (config.jitterMs + 1));
}

/* ------------------------------------------------------------------ */
/* state export / merge                                               */
/* ------------------------------------------------------------------ */

/** The subset of a device record that is durable and safe to sync (inside the envelope). */
export function serializeDeviceRecord(device) {
  return {
    machine_id: device.machine_id,
    machine_name: device.machine_name,
    platform: device.platform ?? {},
    caps: device.caps ?? {},
    user_id: device.user_id ?? null,
    device_token: device.device_token ?? null,
    paired_at_ms: device.paired_at_ms ?? null,
    re_paired: device.re_paired === true,
    fleet_id: device.fleet_id ?? null,
    fleet_source: device.fleet_source ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* ClusterSync                                                        */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} ClusterSyncOptions
 * @property {import('./state.mjs').RabbitState} state
 * @property {import('./persistence.mjs').Persistence} persistence
 * @property {object} config result of normalizeClusterConfig
 * @property {string} [relayVersion]
 * @property {(message:string)=>void} [logger]
 * @property {typeof fetch} [fetchImpl]
 * @property {() => number} [now]
 * @property {() => number} [random] 0..1 source
 * @property {Function} [setTimer]
 * @property {Function} [clearTimer]
 */
export class ClusterSync {
  constructor(options = {}) {
    this.state = options.state ?? null;
    this.persistence = options.persistence ?? null;
    this.config = options.config ?? normalizeClusterConfig({});
    this.relayVersion = typeof options.relayVersion === 'string' ? options.relayVersion : 'unknown';
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._random = typeof options.random === 'function' ? options.random : Math.random;
    this._setTimer = options.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this._clearTimer = options.clearTimer ?? ((t) => clearTimeout(t));
    /** Per-page retries while pulling a peer: a slow/flaky relay-to-relay link must not lose the whole round. */
    this.retryAttempts = Number.isInteger(options.retryAttempts) && options.retryAttempts > 0 ? options.retryAttempts : 3;
    this.retryDelayMs = Number.isInteger(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : 2000;

    this.nodeId = this.config.nodeId ?? this.persistence?.loadClusterNodeId?.() ?? null;
    this.cursors = this.persistence?.loadClusterCursors?.() ?? {};
    const restored = this.persistence?.loadClusterLastSync?.() ?? null;
    this.lastSyncAtMs = Number.isFinite(restored?.at_ms) ? restored.at_ms : null;
    this.nextSyncAtMs = null;
    this.lastResults = Array.isArray(restored?.results) ? restored.results : [];
    this.lastOk = restored?.ok === true;
    this.skipped = 0;
    this.imported = { devices: 0, ledger: 0 };
    this._inFlight = false;
    this._timer = null;
    this._stopped = false;
    this._seenNonces = new Map();
    this._importedKeys = new Set();
    try {
      for (const record of this.persistence?.loadClusterLedger?.() ?? []) {
        this._importedKeys.add(`${record.origin}@${record.offset}`);
      }
    } catch { /* first use re-seeds from the same file */ }
  }

  get enabled() { return this.config.enabled === true && this.config.secret !== null; }

  /** Generate (once) and persist the stable node id. */
  ensureNodeId() {
    if (this.nodeId !== null) return this.nodeId;
    const nodeId = `node-${randomBytes(8).toString('hex')}`;
    this.nodeId = nodeId;
    this.persistence?.saveClusterNodeId?.(nodeId);
    return nodeId;
  }

  /* ---------------- scheduler ---------------- */

  start() {
    if (!this.enabled || this._timer !== null) return this._timer !== null;
    this.ensureNodeId();
    this._stopped = false;
    const delay = bootDelayMs(this.config, this._random);
    this.nextSyncAtMs = this._now() + delay;
    this._timer = this._setTimer(() => this._runScheduled(), delay);
    return true;
  }

  stop() {
    this._stopped = true;
    if (this._timer !== null) this._clearTimer(this._timer);
    this._timer = null;
    this.nextSyncAtMs = null;
  }

  _runScheduled() {
    this._timer = null;
    Promise.resolve()
      .then(() => this.tick())
      .catch((err) => this.logger?.(`[w2m-rabbit] cluster sync failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this._stopped || !this.enabled) return;
        const delay = periodicDelayMs(this.config, this._random);
        this.nextSyncAtMs = this._now() + delay;
        this._timer = this._setTimer(() => this._runScheduled(), delay);
      });
  }

  /* ---------------- one sync round ---------------- */

  /**
   * Pull one snapshot round from every peer. Never throws for a single peer failure: one unreachable
   * relay must not stop the other two from converging. Returns a summary safe to log/publish.
   */
  async tick() {
    if (!this.enabled) return { ok: false, code: 'CLUSTER_DISABLED', at_ms: this._now() };
    if (this._inFlight) {
      this.skipped += 1;
      return { ok: false, code: 'SYNC_IN_FLIGHT', skipped: this.skipped, at_ms: this._now() };
    }
    this._inFlight = true;
    const startedAt = this._now();
    const results = [];
    try {
      for (const peer of this.config.peers) {
        results.push(await this.syncPeer(peer));
      }
    } finally {
      this._inFlight = false;
      this.lastSyncAtMs = this._now();
      this.lastResults = results;
      this.lastOk = results.length > 0 && results.every((entry) => entry.ok === true);
      this.persistence?.saveClusterLastSync?.({ at_ms: this.lastSyncAtMs, ok: this.lastOk, results });
    }
    return { ok: this.lastOk, results, started_at_ms: startedAt, at_ms: this.lastSyncAtMs };
  }

  /** Pull all chunks for one peer and merge them. */
  async syncPeer(peer) {
    const previous = this.cursors[peer.id] ?? {};
    let since = Number.isInteger(previous.ledger_offset) && previous.ledger_offset >= 0 ? previous.ledger_offset : 0;
    const startOffset = since;
    let chunks = 0;
    let ledger = 0;
    let devices = 0;
    let devicePages = 0;
    try {
      // Devices travel in small dedicated pages (fetchDevicesPage); the ledger snapshot never carries
      // them, so every sync request stays small enough for the slow primary→vultr link.
      const deviceSync = await this.syncDevices(peer);
      devices += deviceSync.devices;
      devicePages = deviceSync.pages;
      for (let page = 0; page < MAX_PEER_PAGES; page += 1) {
        const envelope = await this.fetchSnapshotWithRetry(peer, since, false);
        const opened = openClusterEnvelope({
          secret: this.config.secret,
          envelope,
          expectedSender: peer.id,
          receiverNodeId: this.ensureNodeId(),
          nowMs: this._now(),
          skewMs: this.config.authSkewMs,
        });
        const payload = opened.payload;
        if (payload === null || typeof payload !== 'object' || payload.node_id !== peer.id) {
          throw new ProtocolError('UNAUTHORIZED', 'cluster snapshot payload does not belong to the peer', { peer: peer.id });
        }
        const merged = this.mergePayload(peer, payload);
        ledger += merged.ledger;
        chunks += 1;
        const next = payload.next_since?.ledger_offset;
        const nextOffset = Number.isInteger(next) && next >= 0 ? next : since;
        if (nextOffset < since) throw new ProtocolError('BAD_REQUEST', 'cluster cursor moved backwards', { peer: peer.id });
        since = nextOffset;
        if (payload.has_more !== true) break;
      }
      this.cursors[peer.id] = {
        ...previous,
        ledger_offset: since,
        last_ok_at_ms: this._now(),
        last_error: null,
        imported_ledger_total: (previous.imported_ledger_total ?? 0) + ledger,
        imported_devices_total: (previous.imported_devices_total ?? 0) + devices,
      };
      this.imported.devices += devices;
      this.imported.ledger += ledger;
      this.persistence?.saveClusterCursors?.(this.cursors);
      return { peer: peer.id, ok: true, chunks, device_pages: devicePages, ledger, devices, from_offset: startOffset, to_offset: since };
    } catch (err) {
      const code = err instanceof ProtocolError ? err.code : 'CLUSTER_SYNC_FAILED';
      this.cursors[peer.id] = {
        ...previous,
        ledger_offset: since,
        last_ok_at_ms: previous.last_ok_at_ms ?? null,
        last_error: code,
      };
      this.persistence?.saveClusterCursors?.(this.cursors);
      return { peer: peer.id, ok: false, code, detail: err instanceof Error ? err.message : String(err), chunks };
    }
  }

  /** Signed GET /v1/cluster/snapshot. Returns the envelope (still encrypted). */
  async fetchSnapshot(peer, since, includeDevices = true) {
    const path = '/v1/cluster/snapshot';
    const sinceParam = String(since);
    const devicesParam = includeDevices ? '1' : '0';
    const ts = this._now();
    const nonce = randomBytes(16).toString('base64url');
    const auth = clusterAuthToken({ secret: this.config.secret, method: 'GET', path, ts, nonce, since: sinceParam });
    const url = `${peer.url.replace(/\/+$/, '')}${path}?since=${encodeURIComponent(sinceParam)}&devices=${devicesParam}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-w2m-cluster-peer': this.ensureNodeId(),
          'x-w2m-cluster-ts': String(ts),
          'x-w2m-cluster-nonce': nonce,
          'x-w2m-cluster-auth': auth,
        },
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(this.config.requestTimeoutMs)
          : undefined,
      });
    } catch (err) {
      throw new ProtocolError('UNAUTHORIZED', `cluster peer ${peer.id} is unreachable`, { peer: peer.id, detail: String(err?.message ?? err).slice(0, 120) });
    }
    const doc = await response.json().catch(() => null);
    if (response.status !== 200) {
      const code = typeof doc?.error?.code === 'string' ? doc.error.code : `HTTP_${response.status}`;
      throw new ProtocolError('UNAUTHORIZED', `cluster peer ${peer.id} refused the snapshot: ${code}`, { peer: peer.id, status: response.status, remote_code: code });
    }
    if (doc === null || typeof doc !== 'object') throw new ProtocolError('BAD_REQUEST', `cluster peer ${peer.id} returned a non-JSON snapshot`, { peer: peer.id });
    return doc;
  }

  /**
   * One snapshot page with bounded retries.
   *
   * The cursor is not advanced until a page is merged, so retrying the same `since` is safe and
   * idempotent. A flaky relay-to-relay path (observed: a page that normally takes 2s occasionally
   * took 78s and then failed mid-body) must not cost the entire hourly round — that is how the three
   * relays would stay permanently divergent with each other's data.
   */
  async fetchSnapshotWithRetry(peer, since, includeDevices) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await this.fetchSnapshot(peer, since, includeDevices);
      } catch (err) {
        lastError = err;
        if (attempt < this.retryAttempts) {
          await new Promise((resolveDelay) => {
            const timer = setTimeout(resolveDelay, this.retryDelayMs * attempt);
            timer.unref?.();
          });
        }
      }
    }
    throw lastError;
  }

  /**
   * One page of the device registry.
   *
   * Device records carry `caps`/`platform` and are the bulky half of a snapshot (~3 MB raw / ~890 KB
   * gzipped for 196 machines on the live fleet). The primary→vultr link is measured in tens of KB/s
   * and occasionally stalls for a minute; a single multi-hundred-KB response repeatedly timed out,
   * leaving the two relays permanently divergent. Paginating devices keeps every request small; the
   * merge is idempotent LWW, so pages may be re-fetched safely.
   */
  async fetchDevicesPage(peer, offset) {
    const path = '/v1/cluster/devices';
    const offsetParam = String(offset);
    const ts = this._now();
    const nonce = randomBytes(16).toString('base64url');
    const auth = clusterAuthToken({ secret: this.config.secret, method: 'GET', path, ts, nonce, since: '' });
    const url = `${peer.url.replace(/\/+$/, '')}${path}?offset=${encodeURIComponent(offsetParam)}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-w2m-cluster-peer': this.ensureNodeId(),
          'x-w2m-cluster-ts': String(ts),
          'x-w2m-cluster-nonce': nonce,
          'x-w2m-cluster-auth': auth,
        },
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(this.config.requestTimeoutMs)
          : undefined,
      });
    } catch (err) {
      throw new ProtocolError('UNAUTHORIZED', `cluster peer ${peer.id} is unreachable (devices)`, { peer: peer.id, detail: String(err?.message ?? err).slice(0, 120) });
    }
    const doc = await response.json().catch(() => null);
    if (response.status !== 200) {
      const code = typeof doc?.error?.code === 'string' ? doc.error.code : `HTTP_${response.status}`;
      throw new ProtocolError('UNAUTHORIZED', `cluster peer ${peer.id} refused the device page: ${code}`, { peer: peer.id, status: response.status, remote_code: code });
    }
    if (doc === null || typeof doc !== 'object') throw new ProtocolError('BAD_REQUEST', `cluster peer ${peer.id} returned a non-JSON device page`, { peer: peer.id });
    return doc;
  }

  async fetchDevicesPageWithRetry(peer, offset) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await this.fetchDevicesPage(peer, offset);
      } catch (err) {
        lastError = err;
        if (attempt < this.retryAttempts) {
          await new Promise((resolveDelay) => {
            const timer = setTimeout(resolveDelay, this.retryDelayMs * attempt);
            timer.unref?.();
          });
        }
      }
    }
    throw lastError;
  }

  /** Pull every device page from one peer and merge them. */
  async syncDevices(peer) {
    let offset = 0;
    let pages = 0;
    let devices = 0;
    for (let page = 0; page < MAX_PEER_PAGES; page += 1) {
      const envelope = await this.fetchDevicesPageWithRetry(peer, offset);
      const opened = openClusterEnvelope({
        secret: this.config.secret,
        envelope,
        expectedSender: peer.id,
        receiverNodeId: this.ensureNodeId(),
        nowMs: this._now(),
        skewMs: this.config.authSkewMs,
      });
      const payload = opened.payload;
      if (payload === null || typeof payload !== 'object' || payload.node_id !== peer.id || !Array.isArray(payload.devices)) {
        throw new ProtocolError('BAD_REQUEST', 'cluster devices payload is invalid', { peer: peer.id });
      }
      const stats = this.state.mergeClusterDevices(payload.devices);
      devices += stats.added + stats.updated;
      pages += 1;
      const next = Number.isInteger(payload.next_offset) ? payload.next_offset : offset;
      if (payload.has_more === true && next <= offset) {
        throw new ProtocolError('BAD_REQUEST', 'cluster device cursor did not advance', { peer: peer.id });
      }
      offset = next;
      if (payload.has_more !== true) break;
    }
    return { devices, pages, offset };
  }

  /**
   * Merge a decrypted snapshot payload.
   * Devices are idempotent LWW; ledger records are deduped by `(origin, offset)`.
   */
  mergePayload(peer, payload) {
    const out = { devices: 0, ledger: 0 };
    if (this.state === null) return out;
    const deviceStats = this.state.mergeClusterDevices(Array.isArray(payload.devices) ? payload.devices : []);
    out.devices = deviceStats.added + deviceStats.updated;
    const records = Array.isArray(payload.ledger) ? payload.ledger : [];
    for (const record of records) {
      if (record === null || typeof record !== 'object' || typeof record.origin !== 'string' || !Number.isInteger(record.offset)
        || record.entry === null || typeof record.entry !== 'object') continue;
      // Operator keys are per-relay authority: importing one would let a key registered on one relay
      // authorise work on another. They are neither applied nor persisted into the imported ledger.
      if (record.entry.type === 'operator.key.registered') continue;
      const key = `${record.origin}@${record.offset}`;
      if (this._importedKeys.has(key)) continue;
      const applied = this.state.applyClusterLedger([{
        origin: record.origin,
        offset: record.offset,
        entry: record.entry,
      }]);
      this._importedKeys.add(key);
      const stored = { origin: record.origin, offset: record.offset, ts: record.entry.ts ?? null, entry: record.entry };
      this.persistence?.appendClusterLedger?.(stored);
      out.ledger += applied.duplicates > 0 ? 0 : 1;
    }
    return out;
  }

  /* ---------------- peer-facing routes ---------------- */

  /**
   * Handle one peer request. Returns `{status, body}`; throws ProtocolError on refusal.
   *
   * @param {{method:string, path:string, headers:object, query?:URLSearchParams, ip?:string}} request
   */
  route({ method, path, headers, query = null, ip = null }) {
    if (!this.enabled) throw new ProtocolError('NOT_FOUND', 'cluster sync is not enabled on this relay');
    if (String(method).toUpperCase() !== 'GET') throw new ProtocolError('BAD_REQUEST', 'cluster routes accept GET only');
    if (this.config.allowIps.length > 0 && (ip === null || !this.config.allowIps.includes(ip))) {
      throw new ProtocolError('UNAUTHORIZED', 'cluster source address is not allowed', { reason: 'CLUSTER_IP_NOT_ALLOWED' });
    }
    if (path === '/v1/cluster/ping') {
      this.verifyPeerRequest({ method, path, headers, since: '' });
      return {
        status: 200,
        body: {
          ok: true,
          node_id: this.ensureNodeId(),
          relay_version: this.relayVersion,
          protocol_version: CLUSTER_PROTOCOL_VERSION,
          features: [CLUSTER_FEATURE],
        },
      };
    }
    if (path === '/v1/cluster/snapshot') {
      const sinceRaw = query?.get?.('since');
      const since = sinceRaw === null || sinceRaw === undefined || sinceRaw === '' ? 0 : Number(sinceRaw);
      if (!Number.isInteger(since) || since < 0) throw new ProtocolError('BAD_REQUEST', 'cluster since must be a non-negative integer');
      const { peerId } = this.verifyPeerRequest({ method, path, headers, since: String(since) });
      // Devices are the bulky half; a fetching peer asks for them only on the first page of a round.
      // Absent/`devices=1` keeps the old behaviour for an older client.
      const includeDevices = query?.get?.('devices') !== '0';
      const payload = this.buildSnapshotPayload(peerId, since, { includeDevices });
      const envelope = sealClusterEnvelope({ secret: this.config.secret, senderNodeId: this.ensureNodeId(), receiverNodeId: peerId, payload, ts: this._now() });
      /**
       * gzip the envelope.
       *
       * Device records carry `caps`/`platform` objects and the ledger chunk is JSON: on the live
       * fleet a raw snapshot measured ~3 MB even with an empty ledger, and a 2 MB ledger chunk pushed
       * it past 5 MB. The primary→vultr path timed out on that before the bytes arrived, so the
       * default 30s request timeout was not the only problem — the response itself was too big for
       * the slower link. Gzip shrinks it by roughly 5–10x; `fetch` decompresses transparently on the
       * peer side, so the protocol is unchanged for older clients.
       */
      const raw = gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'));
      return {
        status: 200,
        raw,
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      };
    }
    if (path === '/v1/cluster/devices') {
      const offsetRaw = query?.get?.('offset');
      const offset = offsetRaw === null || offsetRaw === undefined || offsetRaw === '' ? 0 : Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0) throw new ProtocolError('BAD_REQUEST', 'cluster offset must be a non-negative integer');
      const { peerId } = this.verifyPeerRequest({ method, path, headers, since: '' });
      const payload = this.buildDevicesPayload(offset);
      const envelope = sealClusterEnvelope({ secret: this.config.secret, senderNodeId: this.ensureNodeId(), receiverNodeId: peerId, payload, ts: this._now() });
      const raw = gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'));
      return {
        status: 200,
        raw,
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      };
    }
    throw new ProtocolError('NOT_FOUND', `no cluster route for ${path}`);
  }

  /**
   * Verify the HMAC, the timestamp window, the replay cache and the peer allow-list of a peer request.
   * @returns {{peerId:string}}
   */
  verifyPeerRequest({ method, path, headers, since }) {
    const header = (name) => {
      const value = headers?.[name] ?? headers?.[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : (typeof value === 'string' ? value : null);
    };
    const peerId = header('x-w2m-cluster-peer');
    const tsRaw = header('x-w2m-cluster-ts');
    const nonce = header('x-w2m-cluster-nonce');
    const auth = header('x-w2m-cluster-auth');
    if (peerId === null || tsRaw === null || nonce === null || auth === null) {
      throw new ProtocolError('UNAUTHORIZED', 'cluster authentication headers are incomplete', { reason: 'CLUSTER_AUTH_MISSING' });
    }
    const known = this.config.peers.find((peer) => peer.id === peerId);
    if (known === undefined) {
      throw new ProtocolError('UNAUTHORIZED', 'unknown cluster peer', { reason: 'CLUSTER_PEER_UNKNOWN' });
    }
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Math.abs(this._now() - ts) > this.config.authSkewMs) {
      throw new ProtocolError('UNAUTHORIZED', 'cluster timestamp is outside the allowed window', { reason: 'CLUSTER_TS' });
    }
    if (nonce.length < 8 || nonce.length > 128) {
      throw new ProtocolError('UNAUTHORIZED', 'cluster nonce is malformed', { reason: 'CLUSTER_NONCE' });
    }
    if (this._seenNonces.has(nonce)) {
      throw new ProtocolError('UNAUTHORIZED', 'cluster nonce was already used', { reason: 'CLUSTER_REPLAY' });
    }
    const expected = clusterAuthToken({ secret: this.config.secret, method, path, ts, nonce, since });
    if (!safeEqualBase64(expected, auth)) {
      throw new ProtocolError('UNAUTHORIZED', 'cluster authentication failed', { reason: 'CLUSTER_AUTH_MISMATCH' });
    }
    this._seenNonces.set(nonce, this._now() + DEFAULT_NONCE_RETENTION_MS);
    if (this._seenNonces.size > 4096) this._pruneNonces();
    return { peerId };
  }

  _pruneNonces() {
    const cutoff = this._now();
    for (const [nonce, expiresAt] of this._seenNonces) {
      if (expiresAt <= cutoff) this._seenNonces.delete(nonce);
    }
  }

  /** Build the (plaintext) snapshot payload for one requesting peer. */
  buildSnapshotPayload(peerId, since, { includeDevices = true } = {}) {
    const devices = [];
    if (includeDevices) {
      for (const device of this.state?.devices?.values?.() ?? []) {
        devices.push(serializeDeviceRecord(device));
      }
    }
    const slice = this.persistence?.readLedgerSlice?.({ offset: since, maxBytes: this.config.chunkBytes })
      ?? { entries: [], nextOffset: since, eof: true };
    const ledger = slice.entries.map(({ offset, entry }) => ({ origin: this.ensureNodeId(), offset, entry }));
    return {
      v: CLUSTER_PROTOCOL_VERSION,
      node_id: this.ensureNodeId(),
      relay_version: this.relayVersion,
      generated_at_ms: this._now(),
      since,
      devices,
      ledger,
      next_since: { ledger_offset: slice.nextOffset },
      has_more: slice.eof !== true,
    };
  }

  /**
   * One page of devices for a peer, sorted by machine id so pages are stable across calls.
   * The merge is LWW/idempotent, so a peer may re-fetch a page after a failed round.
   */
  buildDevicesPayload(offset = 0) {
    const all = [...(this.state?.devices?.values?.() ?? [])]
      .sort((a, b) => String(a.machine_id).localeCompare(String(b.machine_id)));
    const start = Number.isInteger(offset) && offset >= 0 && offset <= all.length ? offset : 0;
    const devices = all.slice(start, start + this.config.devicePageSize).map(serializeDeviceRecord);
    const nextOffset = start + devices.length;
    return {
      v: CLUSTER_PROTOCOL_VERSION,
      node_id: this.ensureNodeId(),
      relay_version: this.relayVersion,
      generated_at_ms: this._now(),
      device_offset: start,
      devices,
      next_offset: nextOffset,
      has_more: nextOffset < all.length,
      total: all.length,
    };
  }

  /* ---------------- diagnostics ---------------- */

  status() {
    const peers = this.config.peers.map((peer) => {
      const cursor = this.cursors[peer.id] ?? {};
      return {
        id: peer.id,
        url: peer.url,
        ledger_offset: Number.isInteger(cursor.ledger_offset) ? cursor.ledger_offset : null,
        last_ok_at: Number.isFinite(cursor.last_ok_at_ms) ? rfc3339OrNull(cursor.last_ok_at_ms) : null,
        last_error: typeof cursor.last_error === 'string' ? cursor.last_error : null,
      };
    });
    return {
      enabled: this.enabled,
      feature: CLUSTER_FEATURE,
      node_id: this.nodeId,
      protocol_version: CLUSTER_PROTOCOL_VERSION,
      peers,
      last_sync_at: Number.isFinite(this.lastSyncAtMs) ? rfc3339OrNull(this.lastSyncAtMs) : null,
      next_sync_at: Number.isFinite(this.nextSyncAtMs) ? rfc3339OrNull(this.nextSyncAtMs) : null,
      last_ok: this.lastOk === true,
      skipped: this.skipped,
      imported: { devices: this.imported.devices, ledger: this.imported.ledger },
      interval_ms: this.config.intervalMs,
      jitter_ms: this.config.jitterMs,
      boot_delay_ms: { min: this.config.bootMinMs, max: this.config.bootMaxMs },
    };
  }
}

function rfc3339OrNull(ms) {
  try {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return null;
  }
}

/** Convenience factory. */
export function createClusterSync(options) {
  return new ClusterSync(options);
}
