/**
 * Per-peer lifecycle for `webrtc-v1`.
 *
 * The transport in `transport.mjs` is deliberately 1:1: one room, one peer, one ICE generation,
 * one Noise session. A fleet is many pairs, so something has to own the map from peer id to
 * transport and the decision every pair must make identically:
 *
 *   - which side is `host` and which is `client`;
 *   - which signaling room the two sides meet in;
 *   - where the peer's pinned Noise key comes from;
 *   - when a failed pair is allowed to reconnect instead of being reused;
 *   - how a caller sees the state of every pair without opening one socket per status call.
 *
 * That is this module. It is not a dispatcher and it does not decide delivery policy: it turns
 * `(peerMachineId)` into a started `webrtc-v1` transport, and `send()` is a thin wrapper over the
 * transport's own send. `deliver.mjs` and the dispatcher still decide whether to use it.
 *
 * ## Deterministic room and role
 *
 * Both machines derive the same values from the same two machine ids. There is no negotiation
 * field to disagree about and no relay round trip before the handshake:
 *
 *   room = `w2m-pair-` + sha256(sorted(machine_a, machine_b))[0:24]
 *   host = the lexicographically smaller machine id
 *
 * A string comparison is used rather than a locale-aware one because the two machines may run
 * different locales and the result must be identical byte-for-byte. The room is a hash rather than
 * the ids themselves so a signaling server log does not disclose the fleet topology.
 *
 * ## Key resolution
 *
 * The peer's static key is read from `GET /v1/peer/<machine_id>` (`peer.static_key`), which is the
 * same record the UDP P2P path already trusts for its Noise handshake. The key is cached briefly:
 * a key rotation is rare, and a dispatch that resolves the same peer five times must not make five
 * relay reads. A missing key is a named refusal; the pool never substitutes a fresh key, because
 * pinning is the entire point.
 *
 * ## Failure and reconnect
 *
 * A failed pair stays visible in `diagnostics()` but is not reused. The next `ensure()` closes the
 * dead transport and starts a new one. That is the smallest useful retry model and leaves the
 * "33 attempts, then give up" decision where it belongs: in the Teams data-plane policy, not in
 * the transport pool.
 */

import { createHash } from 'node:crypto';

import { createWebRtcTransport } from './transport.mjs';
import { redactSignalingUrl } from './signaling.mjs';

/** Named pool failures. */
export const WEBRTC_POOL_CODE = Object.freeze({
  BAD_CONFIG: 'WEBRTC_POOL_BAD_CONFIG',
  SELF_PEER: 'WEBRTC_POOL_SELF_PEER',
  PEER_KEY_MISSING: 'WEBRTC_POOL_PEER_KEY_MISSING',
  START_FAILED: 'WEBRTC_POOL_START_FAILED',
  NOT_READY: 'WEBRTC_POOL_NOT_READY',
  SEND_FAILED: 'WEBRTC_POOL_SEND_FAILED',
  CLOSED: 'WEBRTC_POOL_CLOSED',
});

/** How long a resolved peer key is reused before the relay is asked again. */
export const PEER_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Which side of a pair is the signaling host.
 *
 * @param {string} machineId
 * @param {string} peerMachineId
 * @returns {'host'|'client'|null} Null when either id is unusable or the two are equal.
 */
export function pairRole(machineId, peerMachineId) {
  if (typeof machineId !== 'string' || machineId === '') return null;
  if (typeof peerMachineId !== 'string' || peerMachineId === '') return null;
  if (machineId === peerMachineId) return null;
  return machineId < peerMachineId ? 'host' : 'client';
}

/**
 * The deterministic signaling room for one pair.
 *
 * The ordering is fixed (`a` then `b`, after sorting) so `pairRoom(a, b) === pairRoom(b, a)`.
 *
 * @param {string} machineId
 * @param {string} peerMachineId
 * @returns {string|null} Null when either id is unusable.
 */
export function pairRoom(machineId, peerMachineId) {
  if (typeof machineId !== 'string' || machineId === '') return null;
  if (typeof peerMachineId !== 'string' || peerMachineId === '') return null;
  if (machineId === peerMachineId) return null;
  const [first, second] = machineId < peerMachineId ? [machineId, peerMachineId] : [peerMachineId, machineId];
  const digest = createHash('sha256').update(`${first}\u0000${second}`, 'utf8').digest('hex');
  return `w2m-pair-${digest.slice(0, 24)}`;
}

/**
 * A relay-backed peer-key resolver with a bounded cache.
 *
 * The resolver returns `{key, error}` rather than throwing: the pool's caller needs a named
 * refusal it can report, and a 404 from the relay is an ordinary state ("this peer has not
 * announced"), not an exception.
 *
 * @param {object} options
 * @param {(path: string) => Promise<object>} options.getJson The agent's relay client.
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now] Test seam.
 * @returns {(peerMachineId: string) => Promise<{key: string|null, error: string|null, source: string}>}
 */
export function createRelayPeerKeyResolver({ getJson, ttlMs = PEER_KEY_CACHE_TTL_MS, now = Date.now } = {}) {
  if (typeof getJson !== 'function') {
    return async () => ({
      key: null,
      error: 'WEBRTC_POOL_PEER_KEY_MISSING: no getJson client, so the peer key cannot be read',
      source: 'none',
    });
  }
  /** @type {Map<string, {key: string, at: number}>} */
  const cache = new Map();
  return async (peerMachineId) => {
    const cached = cache.get(peerMachineId);
    if (cached !== undefined && now() - cached.at < ttlMs) {
      return { key: cached.key, error: null, source: 'cache' };
    }
    try {
      const answer = await getJson(`/v1/peer/${encodeURIComponent(peerMachineId)}`);
      const key = answer?.json?.peer?.static_key;
      if (typeof key !== 'string' || key === '') {
        return {
          key: null,
          error: `WEBRTC_POOL_PEER_KEY_MISSING: ${peerMachineId} has announced no static_key`,
          source: 'relay',
        };
      }
      cache.set(peerMachineId, { key, at: now() });
      return { key, error: null, source: 'relay' };
    } catch (error) {
      return {
        key: null,
        error: `WEBRTC_POOL_PEER_KEY_MISSING: ${error instanceof Error ? error.message : String(error)}`,
        source: 'relay',
      };
    }
  };
}

/**
 * Owns one `webrtc-v1` transport per peer.
 *
 * The pool is deliberately not an EventEmitter: `onMessage()` is the only push surface, matching
 * the transport contract, and `diagnostics()` is a snapshot the plugin can serialise into a tool
 * result without subscribing to anything.
 */
export class WebRtcTransportPool {
  /**
   * @param {object} options
   * @param {string} options.machineId This machine's id; the signaling peer id and the Noise identity.
   * @param {string} options.signalUrl `ws:`/`wss:` signaling server.
   * @param {string} [options.signalToken]
   * @param {object|null} [options.deviceKey] This machine's `DeviceKey`.
   * @param {string} [options.deviceKeyFile]
   * @param {string} [options.deviceKeyDir]
   * @param {boolean} [options.allowCreateDeviceKey]
   * @param {(peerMachineId: string) => Promise<{key: string|null, error: string|null}>} options.resolvePeerKey
   * @param {Function} [options.transportFactory] Test seam; defaults to `createWebRtcTransport`.
   * @param {number} [options.maxPeers] Refuse new pairs beyond this bound; existing pairs keep working.
   * @param {number} [options.maxRttMs]
   * @param {boolean} [options.preferP2p]
   * @param {boolean} [options.allowRelay]
   * @param {Array} [options.iceServers]
   * @param {(peerMachineId: string) => Array} [options.iceServersForPeer] Per-pair ICE override.
   * @param {string} [options.providerCommand]
   * @param {string[]} [options.providerArgs]
   * @param {string} [options.providerCwd]
   * @param {object} [options.providerEnv]
   * @param {number} [options.connectTimeoutMs]
   * @param {number} [options.handshakeTimeoutMs]
   * @param {number} [options.peerTimeoutMs]
   * @param {number} [options.statsPollMs]
   * @param {number} [options.maxFragmentBytes]
   */
  constructor(options = {}) {
    const machineId = typeof options.machineId === 'string' ? options.machineId : '';
    const signalUrl = typeof options.signalUrl === 'string' ? options.signalUrl : '';
    if (machineId === '' || signalUrl === '') {
      throw new TypeError(
        `${WEBRTC_POOL_CODE.BAD_CONFIG}: machineId and signalUrl are required (got machineId=${JSON.stringify(machineId)}, signalUrl=${JSON.stringify(signalUrl)})`,
      );
    }
    if (typeof options.resolvePeerKey !== 'function') {
      throw new TypeError(`${WEBRTC_POOL_CODE.BAD_CONFIG}: resolvePeerKey must be a function`);
    }
    this.machineId = machineId;
    this.signalUrl = signalUrl;
    this.signalToken = typeof options.signalToken === 'string' ? options.signalToken : '';
    this.resolvePeerKey = options.resolvePeerKey;
    this.transportFactory =
      typeof options.transportFactory === 'function' ? options.transportFactory : createWebRtcTransport;
    this.maxPeers =
      Number.isInteger(options.maxPeers) && options.maxPeers > 0 ? options.maxPeers : Number.MAX_SAFE_INTEGER;
    this.deviceKey = options.deviceKey ?? null;
    this.iceServersForPeer =
      typeof options.iceServersForPeer === 'function' ? options.iceServersForPeer : null;
    this.transportOptions = {
      signalUrl,
      signalToken: this.signalToken,
      machineId,
      ...(this.deviceKey === null ? {} : { deviceKey: this.deviceKey }),
      ...(typeof options.deviceKeyFile === 'string' && options.deviceKeyFile !== ''
        ? { deviceKeyFile: options.deviceKeyFile }
        : {}),
      ...(typeof options.deviceKeyDir === 'string' && options.deviceKeyDir !== ''
        ? { deviceKeyDir: options.deviceKeyDir }
        : {}),
      ...(options.allowCreateDeviceKey === true ? { allowCreateDeviceKey: true } : {}),
      ...(Array.isArray(options.iceServers) ? { iceServers: options.iceServers } : {}),
      ...(Number.isFinite(Number(options.maxRttMs)) ? { maxRttMs: Number(options.maxRttMs) } : {}),
      ...(options.preferP2p === false ? { preferP2p: false } : {}),
      ...(options.allowRelay === false ? { allowRelay: false } : {}),
      ...(typeof options.providerCommand === 'string' && options.providerCommand !== ''
        ? { providerCommand: options.providerCommand }
        : {}),
      ...(Array.isArray(options.providerArgs) ? { providerArgs: options.providerArgs.map(String) } : {}),
      ...(typeof options.providerCwd === 'string' && options.providerCwd !== ''
        ? { providerCwd: options.providerCwd }
        : {}),
      ...(options.providerEnv !== undefined ? { providerEnv: options.providerEnv } : {}),
      ...(Number.isFinite(Number(options.connectTimeoutMs)) && Number(options.connectTimeoutMs) > 0
        ? { connectTimeoutMs: Number(options.connectTimeoutMs) }
        : {}),
      ...(Number.isFinite(Number(options.handshakeTimeoutMs)) && Number(options.handshakeTimeoutMs) > 0
        ? { handshakeTimeoutMs: Number(options.handshakeTimeoutMs) }
        : {}),
      ...(Number.isFinite(Number(options.peerTimeoutMs)) && Number(options.peerTimeoutMs) > 0
        ? { peerTimeoutMs: Number(options.peerTimeoutMs) }
        : {}),
      ...(Number.isFinite(Number(options.statsPollMs)) ? { statsPollMs: Number(options.statsPollMs) } : {}),
      ...(Number.isFinite(Number(options.maxFragmentBytes)) && Number(options.maxFragmentBytes) >= 64
        ? { maxFragmentBytes: Number(options.maxFragmentBytes) }
        : {}),
    };
    /** @type {Map<string, object>} */
    this.peers = new Map();
    /** @type {Set<(event: object) => void>} */
    this.handlers = new Set();
    this.closed = false;
    this.createdAt = new Date().toISOString();
    this.stats = { sends: 0, send_failures: 0, start_failures: 0, bytes_sent: 0 };
  }

  /** The room this machine would use for a peer, without creating anything. */
  roomFor(peerMachineId) {
    return pairRoom(this.machineId, peerMachineId);
  }

  /** The role this machine would take for a peer, without creating anything. */
  roleFor(peerMachineId) {
    return pairRole(this.machineId, peerMachineId);
  }

  /**
   * Start a pair if it is not already up, and return its transport.
   *
   * Concurrent callers share one start. A failed start is NOT cached: the next caller retries, which
   * is what makes "prepare at dispatch, retry at result time" work without a timer.
   *
   * @param {string} peerMachineId
   * @returns {Promise<object>} `{ok:true, transport, peer, role, room}` or `{ok:false, code, detail, peer}`
   */
  async ensure(peerMachineId) {
    if (this.closed)
      return { ok: false, code: WEBRTC_POOL_CODE.CLOSED, detail: 'pool is stopped', peer: peerMachineId };
    const role = pairRole(this.machineId, peerMachineId);
    if (role === null) {
      return {
        ok: false,
        code: peerMachineId === this.machineId ? WEBRTC_POOL_CODE.SELF_PEER : WEBRTC_POOL_CODE.BAD_CONFIG,
        detail:
          peerMachineId === this.machineId
            ? 'a peer cannot be this machine'
            : 'peerMachineId is empty or invalid',
        peer: peerMachineId ?? null,
      };
    }
    const current = this.peers.get(peerMachineId);
    if (current?.ok === true && current.transport !== null) {
      return {
        ok: true,
        transport: current.transport,
        peer: peerMachineId,
        role: current.role,
        room: current.room,
      };
    }
    if (current?.inflight instanceof Promise) return current.inflight;
    if (current === undefined && this.peers.size >= this.maxPeers) {
      return {
        ok: false,
        code: WEBRTC_POOL_CODE.NOT_READY,
        detail: `maxPeers=${this.maxPeers} reached; existing pairs keep working and this new pair was refused`,
        peer: peerMachineId,
      };
    }

    const record = {
      peer: peerMachineId,
      role,
      room: pairRoom(this.machineId, peerMachineId),
      transport: null,
      ok: null,
      inflight: null,
      last_error: null,
      last_started_at: null,
      last_used_at: null,
      starts: 0,
      sends: 0,
      bytes_sent: 0,
    };
    this.peers.set(peerMachineId, record);
    record.inflight = this.#startPair(record);
    const result = await record.inflight;
    record.inflight = null;
    return result;
  }

  /**
   * Start a pair without sending anything. Used by a dispatcher right after it hands a task to a
   * peer, so the peer's result path has a live transport to land on.
   *
   * @param {string} peerMachineId
   */
  async prepare(peerMachineId) {
    const ready = await this.ensure(peerMachineId);
    return ready.ok === true
      ? { ok: true, peer: peerMachineId, role: ready.role, room: ready.room }
      : { ok: false, code: ready.code, detail: ready.detail, peer: peerMachineId };
  }

  /**
   * Send one payload to one peer, starting the pair if needed.
   *
   * @param {string} peerMachineId
   * @param {Buffer|string|Uint8Array} payload
   * @returns {Promise<{ok:boolean, peer:string, bytes?:number, fragments?:number, code?:string, detail?:string}>}
   */
  async send(peerMachineId, payload) {
    const ready = await this.ensure(peerMachineId);
    if (ready.ok !== true) {
      this.stats.send_failures += 1;
      return {
        ok: false,
        peer: peerMachineId,
        code: ready.code,
        detail: ready.detail,
        attempts: 0,
      };
    }
    const bytes = Buffer.isBuffer(payload)
      ? payload.length
      : payload instanceof Uint8Array
        ? payload.byteLength
        : typeof payload === 'string'
          ? Buffer.byteLength(payload, 'utf8')
          : Buffer.byteLength(JSON.stringify(payload ?? ''), 'utf8');
    const record = this.peers.get(peerMachineId);
    const result = await ready.transport.send(peerMachineId, payload);
    this.stats.sends += 1;
    if (record !== undefined) {
      record.sends += 1;
      record.last_used_at = new Date().toISOString();
    }
    if (result.ok === true) {
      this.stats.bytes_sent += bytes;
      if (record !== undefined) record.bytes_sent += bytes;
      return { ok: true, peer: peerMachineId, bytes, fragments: result.fragments ?? null };
    }
    this.stats.send_failures += 1;
    if (record !== undefined)
      record.last_error = {
        code: result.code ?? WEBRTC_POOL_CODE.SEND_FAILED,
        detail: result.detail ?? null,
      };
    // A transport that is no longer ready must not be reused: the next call should build a new
    // pair rather than send into a dead DataChannel forever.
    if (
      result.code === 'WEBRTC_NOT_READY' ||
      result.code === 'WEBRTC_UNKNOWN_PEER' ||
      result.code === 'WEBRTC_CLOSED' ||
      result.code === 'WEBRTC_STOPPED'
    ) {
      await this.closePeer(peerMachineId, 'reconnect');
    }
    return {
      ok: false,
      peer: peerMachineId,
      code: result.code ?? WEBRTC_POOL_CODE.SEND_FAILED,
      detail: result.detail ?? null,
      bytes,
      fragments: result.fragments ?? null,
    };
  }

  /**
   * Observe every frame from every current and future pair.
   *
   * Handler exceptions are contained: one tool's callback must not tear down the DataChannel or
   * starve the other handlers. The exception is recorded in the pair's `last_error` instead.
   *
   * @param {(event: {peer: string, payload: Buffer, transport: string, role: string, room: string}) => void} handler
   * @returns {() => void} Unsubscribe.
   */
  onMessage(handler) {
    if (typeof handler !== 'function') return () => {};
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Close one pair and remove it from the map. */
  async closePeer(peerMachineId, reason = 'close') {
    const record = this.peers.get(peerMachineId);
    if (record === undefined) return { ok: true, peer: peerMachineId, closed: false };
    this.peers.delete(peerMachineId);
    const transport = record.transport;
    record.transport = null;
    record.ok = false;
    if (transport !== null) {
      try {
        await transport.stop?.();
      } catch (error) {
        record.last_error = {
          code: WEBRTC_POOL_CODE.SEND_FAILED,
          detail: `stop failed (${reason}): ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return { ok: true, peer: peerMachineId, closed: transport !== null };
  }

  /** Close every pair. Idempotent. */
  async stop() {
    if (this.closed) return { ok: true, peers: 0 };
    this.closed = true;
    const peers = [...this.peers.keys()];
    await Promise.all(peers.map((peer) => this.closePeer(peer, 'pool-stop')));
    return { ok: true, peers: peers.length };
  }

  /** A diagnostics snapshot for one peer, or null. Every field is safe to serialise. */
  peerStatus(peerMachineId) {
    const record = this.peers.get(peerMachineId);
    if (record === undefined) return null;
    const diagnostics = record.transport?.diagnostics?.() ?? null;
    return {
      peer: peerMachineId,
      role: record.role,
      room: record.room,
      ok: record.ok === true,
      state: diagnostics?.state ?? (record.inflight === null ? 'failed' : 'starting'),
      path: diagnostics?.path?.verdict ?? null,
      path_reason: diagnostics?.path?.reason ?? null,
      rtt_ms: diagnostics?.path?.rtt_ms ?? null,
      secure: diagnostics?.secure?.state ?? null,
      provider_ready: diagnostics?.provider?.ready ?? null,
      signal_peer: diagnostics?.signal_peer ?? null,
      started_at: record.last_started_at,
      last_used_at: record.last_used_at,
      starts: record.starts,
      sends: record.sends,
      bytes_sent: record.bytes_sent,
      // A transport can fail after `start()` returned ok (ICE drops, provider closes). Keep the
      // record-level error, but fall back to the transport's own last_error so the real cause is
      // visible instead of collapsing to null.
      last_error: record.last_error ?? diagnostics?.last_error ?? null,
    };
  }

  /** A diagnostics snapshot for the whole pool. */
  diagnostics() {
    return {
      ok: !this.closed,
      name: 'webrtc-v1-pool',
      machine_id: this.machineId,
      signal_url: this.signalUrl === '' ? '' : redactSignalingUrl(this.signalUrl),
      signal_token: this.signalToken === '' ? null : '<redacted>',
      closed: this.closed,
      created_at: this.createdAt,
      max_peers: this.maxPeers === Number.MAX_SAFE_INTEGER ? null : this.maxPeers,
      peer_count: this.peers.size,
      peers: [...this.peers.keys()]
        .sort()
        .map((peer) => this.peerStatus(peer))
        .filter((entry) => entry !== null),
      stats: { ...this.stats },
    };
  }

  /**
   * Build and start one transport. Never throws; every failure becomes a named result.
   *
   * @param {object} record
   * @returns {Promise<object>}
   */
  async #startPair(record) {
    record.starts += 1;
    let key;
    try {
      const resolved = await this.resolvePeerKey(record.peer);
      key = typeof resolved?.key === 'string' && resolved.key !== '' ? resolved.key : null;
      if (key === null) {
        record.ok = false;
        record.last_error = {
          code: WEBRTC_POOL_CODE.PEER_KEY_MISSING,
          detail: resolved?.error ?? `no static_key for ${record.peer}`,
        };
        this.stats.start_failures += 1;
        return {
          ok: false,
          code: WEBRTC_POOL_CODE.PEER_KEY_MISSING,
          detail: record.last_error.detail,
          peer: record.peer,
        };
      }
    } catch (error) {
      record.ok = false;
      record.last_error = {
        code: WEBRTC_POOL_CODE.PEER_KEY_MISSING,
        detail: error instanceof Error ? error.message : String(error),
      };
      this.stats.start_failures += 1;
      return {
        ok: false,
        code: WEBRTC_POOL_CODE.PEER_KEY_MISSING,
        detail: record.last_error.detail,
        peer: record.peer,
      };
    }

    const peerKeys = new Map([[record.peer, key]]);
    let perPeerIce = null;
    if (this.iceServersForPeer !== null) {
      try {
        const candidate = this.iceServersForPeer(record.peer);
        if (Array.isArray(candidate)) perPeerIce = candidate;
      } catch (error) {
        record.ok = false;
        record.last_error = {
          code: WEBRTC_POOL_CODE.START_FAILED,
          detail: `iceServersForPeer failed: ${error instanceof Error ? error.message : String(error)}`,
        };
        this.stats.start_failures += 1;
        return {
          ok: false,
          code: record.last_error.code,
          detail: record.last_error.detail,
          peer: record.peer,
        };
      }
    }
    const options = {
      ...this.transportOptions,
      ...(perPeerIce === null ? {} : { iceServers: perPeerIce }),
      role: record.role,
      room: record.room,
      peerId: this.machineId,
      peerMachineId: record.peer,
      ...(record.role === 'client' ? { peerPublicKey: key, peerKeys: null } : { peerKeys }),
    };
    let built;
    try {
      built = this.transportFactory(options);
    } catch (error) {
      record.ok = false;
      record.last_error = {
        code: WEBRTC_POOL_CODE.START_FAILED,
        detail: error instanceof Error ? error.message : String(error),
      };
      this.stats.start_failures += 1;
      return {
        ok: false,
        code: WEBRTC_POOL_CODE.START_FAILED,
        detail: record.last_error.detail,
        peer: record.peer,
      };
    }
    if (built?.ok !== true || built.transport === null || built.transport === undefined) {
      record.ok = false;
      record.last_error = {
        code: built?.code ?? WEBRTC_POOL_CODE.START_FAILED,
        detail: built?.detail ?? 'transport factory refused',
      };
      this.stats.start_failures += 1;
      return { ok: false, code: record.last_error.code, detail: record.last_error.detail, peer: record.peer };
    }

    const transport = built.transport;
    record.transport = transport;
    transport.onMessage((event) => {
      for (const handler of this.handlers) {
        try {
          handler({
            peer: record.peer,
            payload: event?.payload,
            transport: 'webrtc-v1',
            role: record.role,
            room: record.room,
          });
        } catch (error) {
          record.last_error = {
            code: WEBRTC_POOL_CODE.SEND_FAILED,
            detail: `message handler threw: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
    });

    let started;
    try {
      started = await transport.start();
    } catch (error) {
      started = {
        ok: false,
        code: WEBRTC_POOL_CODE.START_FAILED,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (started?.ok !== true) {
      record.ok = false;
      record.last_error = {
        code: started?.code ?? WEBRTC_POOL_CODE.START_FAILED,
        detail: started?.detail ?? null,
      };
      this.stats.start_failures += 1;
      try {
        await transport.stop?.();
      } catch {
        /* the failure is already recorded */
      }
      record.transport = null;
      return { ok: false, code: record.last_error.code, detail: record.last_error.detail, peer: record.peer };
    }
    record.ok = true;
    record.last_started_at = new Date().toISOString();
    record.last_error = null;
    return { ok: true, transport, peer: record.peer, role: record.role, room: record.room };
  }
}

/**
 * Convenience constructor for callers that do not want the `new`-and-validate shape.
 *
 * @param {ConstructorParameters<typeof WebRtcTransportPool>[0]} options
 * @returns {{ok:true, pool:WebRtcTransportPool} | {ok:false, code:string, detail:string}}
 */
export function createWebRtcTransportPool(options = {}) {
  try {
    return { ok: true, pool: new WebRtcTransportPool(options) };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? WEBRTC_POOL_CODE.BAD_CONFIG,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
