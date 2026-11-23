/**
 * The WebRTC pool runtime.
 *
 * `webrtc-pool-registry.mjs` enforces the one-pool-per-process invariant and offers late binding,
 * but it deliberately knows nothing about how a pool is built. This module owns that half:
 *
 * - normalize one flat config shape from either the root `w2m` row or a Cordis sub-plugin;
 * - resolve the machine identity / device key / relay key resolver;
 * - build exactly one `WebRtcTransportPool` through the registry's `acquire()`;
 * - expose status and a clean owner-only `stop()`.
 *
 * `dsh-p2p-webrtc` will become the owner in P2. For P1 the root `w2m` row already uses this runtime
 * with owner `w2m-root`; when the sub-plugin is enabled first, the root borrows its pool instead
 * and never constructs a second one. The registry, not this module, decides which of those happens.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEVICE_KEY_FILE, DeviceKey } from '../../agent/crypto.mjs';
import { loadOrCreateIdentity } from '../../agent/identity.mjs';
import { createRelayPeerKeyResolver, createWebRtcTransportPool } from '../../agent/webrtc/pool.mjs';
import { redactSignalingUrl } from '../../agent/webrtc/signaling.mjs';
import {
  WEBRTC_POOL_REGISTRY_CODE,
  acquireSharedWebRtcPool,
  getSharedWebRtcPoolState,
  releaseSharedWebRtcPool,
  subscribeSharedWebRtcPool,
} from '../webrtc-pool-registry.mjs';

export const POOL_RUNTIME_CODE = {
  BAD_CONFIG: 'WEBRTC_POOL_BAD_CONFIG',
  OWNER_CONFLICT: WEBRTC_POOL_REGISTRY_CODE.OWNER_CONFLICT,
  NOT_OWNER: 'WEBRTC_POOL_NOT_OWNER',
  IDENTITY_UNAVAILABLE: 'WEBRTC_POOL_IDENTITY_UNAVAILABLE',
  DEVICE_KEY_UNAVAILABLE: 'WEBRTC_POOL_DEVICE_KEY_UNAVAILABLE',
  PEER_KEY_RESOLVER_REQUIRED: 'WEBRTC_POOL_PEER_KEY_RESOLVER_REQUIRED',
  BUILD_FAILED: WEBRTC_POOL_REGISTRY_CODE.BUILD_FAILED,
  STOP_FAILED: 'WEBRTC_POOL_STOP_FAILED',
};

const DEFAULT_OWNER = 'w2m-root';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pick(source, ...names) {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null) return source[name];
  }
  return undefined;
}

function asString(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function asFunction(value) {
  return typeof value === 'function' ? value : null;
}

function asBoolean(value) {
  return value === true;
}

function asNumber(value, minimum = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (minimum !== null && number < minimum) return null;
  return number;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map(String) : null;
}

function detailOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Accept both the snake_case shape `tools/shared.mjs` already uses and the camelCase shape a
 * Cordis schema produces. A nested `webrtc` object is merged first so a caller can hand the whole
 * normalized config rather than re-flattening it.
 */
export function normalizePoolRuntimeConfig(input = {}, deps = {}) {
  const raw = isRecord(input) ? input : {};
  const source = isRecord(raw.webrtc) ? { ...raw.webrtc, ...raw } : raw;

  return {
    owner: asString(pick(source, 'owner', 'pool_owner', 'poolOwner'), DEFAULT_OWNER),
    machine_id: asString(pick(source, 'machineId', 'machine_id')),
    machine_name: asString(pick(source, 'machineName', 'machine_name')),
    identity: isRecord(pick(source, 'identity')) ? pick(source, 'identity') : null,
    identity_file: asString(pick(source, 'identityFile', 'identity_file')),
    rabbit_url: asString(pick(source, 'rabbitUrl', 'rabbit_url')),
    signal_url: asString(pick(source, 'signalUrl', 'signal_url')),
    signal_token: asString(pick(source, 'signalToken', 'signal_token')),
    device_key: pick(source, 'deviceKey', 'device_key') ?? null,
    device_key_file: asString(pick(source, 'deviceKeyFile', 'device_key_file')),
    device_key_dir: asString(pick(source, 'deviceKeyDir', 'device_key_dir')),
    allow_create_device_key: asBoolean(pick(source, 'allowCreateDeviceKey', 'allow_create_device_key')),
    provider_command: asString(pick(source, 'providerCommand', 'provider_command')),
    provider_args: asStringArray(pick(source, 'providerArgs', 'provider_args')),
    provider_cwd: asString(pick(source, 'providerCwd', 'provider_cwd')),
    provider_env: pick(source, 'providerEnv', 'provider_env') ?? null,
    ice_servers: Array.isArray(pick(source, 'iceServers', 'ice_servers'))
      ? pick(source, 'iceServers', 'ice_servers')
      : null,
    prefer_p2p: pick(source, 'preferP2p', 'prefer_p2p') !== false,
    allow_relay: pick(source, 'allowRelay', 'allow_relay') !== false,
    max_rtt_ms: asNumber(pick(source, 'maxRttMs', 'max_rtt_ms'), 0),
    connect_timeout_ms: asNumber(pick(source, 'connectTimeoutMs', 'connect_timeout_ms'), 1),
    handshake_timeout_ms: asNumber(pick(source, 'handshakeTimeoutMs', 'handshake_timeout_ms'), 1),
    peer_timeout_ms: asNumber(pick(source, 'peerTimeoutMs', 'peer_timeout_ms'), 1),
    stats_poll_ms: asNumber(pick(source, 'statsPollMs', 'stats_poll_ms'), 0),
    max_fragment_bytes: asNumber(pick(source, 'maxFragmentBytes', 'max_fragment_bytes'), 64),
    max_peers: asNumber(pick(source, 'maxPeers', 'max_peers'), 1),
    resolve_peer_key: asFunction(pick(source, 'resolvePeerKey', 'resolve_peer_key')) ?? null,
    get_json: asFunction(pick(source, 'getJson', 'get_json')) ?? null,
    pool_factory:
      asFunction(pick(source, 'poolFactory', 'pool_factory')) ?? asFunction(deps.poolFactory) ?? null,
    load_identity: asFunction(deps.loadIdentity) ?? null,
    load_device_key: asFunction(deps.loadDeviceKey) ?? null,
  };
}

function registryState(registry) {
  if (registry !== null && typeof registry === 'object') {
    if (typeof registry.state === 'function') return registry.state();
    if (typeof registry.getState === 'function') return registry.getState();
    if (typeof registry.get === 'function') {
      const pool = registry.get();
      return { pool, owner: null, ready: pool !== null, epoch: 0 };
    }
  }
  return { pool: null, owner: null, ready: false, epoch: 0 };
}

function defaultRegistry() {
  return {
    acquire: acquireSharedWebRtcPool,
    state: getSharedWebRtcPoolState,
    release: releaseSharedWebRtcPool,
    subscribe: subscribeSharedWebRtcPool,
  };
}

function poolOptions(config, machineId, deviceKey, resolvePeerKey) {
  return {
    machineId,
    signalUrl: config.signal_url,
    signalToken: config.signal_token,
    ...(deviceKey === null ? {} : { deviceKey }),
    ...(config.device_key_file === '' ? {} : { deviceKeyFile: config.device_key_file }),
    ...(config.device_key_dir === '' ? {} : { deviceKeyDir: config.device_key_dir }),
    ...(config.allow_create_device_key === true ? { allowCreateDeviceKey: true } : {}),
    resolvePeerKey,
    ...(config.provider_command === '' ? {} : { providerCommand: config.provider_command }),
    ...(config.provider_args === null ? {} : { providerArgs: config.provider_args }),
    ...(config.provider_cwd === '' ? {} : { providerCwd: config.provider_cwd }),
    ...(config.provider_env === null ? {} : { providerEnv: config.provider_env }),
    ...(config.ice_servers === null ? {} : { iceServers: config.ice_servers }),
    preferP2p: config.prefer_p2p,
    allowRelay: config.allow_relay,
    ...(config.max_rtt_ms === null ? {} : { maxRttMs: config.max_rtt_ms }),
    ...(config.connect_timeout_ms === null ? {} : { connectTimeoutMs: config.connect_timeout_ms }),
    ...(config.handshake_timeout_ms === null ? {} : { handshakeTimeoutMs: config.handshake_timeout_ms }),
    ...(config.peer_timeout_ms === null ? {} : { peerTimeoutMs: config.peer_timeout_ms }),
    ...(config.stats_poll_ms === null ? {} : { statsPollMs: config.stats_poll_ms }),
    ...(config.max_fragment_bytes === null ? {} : { maxFragmentBytes: config.max_fragment_bytes }),
    ...(config.max_peers === null ? {} : { maxPeers: config.max_peers }),
  };
}

/**
 * One runtime, one config. `ensure()` is idempotent and concurrent-safe; the registry guarantees
 * the process-wide one-pool invariant across runtimes.
 */
export class WebRtcPoolRuntime {
  constructor(config = {}, deps = {}) {
    this.config = normalizePoolRuntimeConfig(config, deps);
    this.deps = isRecord(deps) ? deps : {};
    this.registry = deps.registry ?? defaultRegistry();
    this.pool = null;
    this.owner = null;
    this.machineId = this.config.machine_id;
    this.deviceKey = this.config.device_key;
    this.ensuring = null;
  }

  async #resolveIdentity() {
    if (this.config.identity !== null && typeof this.config.identity.machine_id === 'string') {
      return { ok: true, identity: this.config.identity, created: false };
    }
    if (this.config.machine_id !== '') {
      return {
        ok: true,
        identity: { machine_id: this.config.machine_id, machine_name: this.config.machine_name || null },
        created: false,
      };
    }

    const loader = this.config.load_identity ?? loadOrCreateIdentity;
    try {
      const loaded = await loader({
        ...(this.config.machine_name === '' ? {} : { name: this.config.machine_name }),
        ...(this.config.rabbit_url === '' ? {} : { rabbitUrl: this.config.rabbit_url }),
        ...(this.config.identity_file === '' ? {} : { file: this.config.identity_file }),
      });
      const identity = isRecord(loaded) && isRecord(loaded.identity) ? loaded.identity : loaded;
      if (!isRecord(identity) || typeof identity.machine_id !== 'string' || identity.machine_id === '') {
        return {
          ok: false,
          code: POOL_RUNTIME_CODE.IDENTITY_UNAVAILABLE,
          detail: 'identity loader returned no machine_id',
        };
      }
      return { ok: true, identity, created: loaded?.created === true };
    } catch (error) {
      return {
        ok: false,
        code: POOL_RUNTIME_CODE.IDENTITY_UNAVAILABLE,
        detail: detailOf(error),
      };
    }
  }

  async #resolveDeviceKey(machineId) {
    if (this.config.device_key !== null && this.config.device_key !== undefined) {
      return { ok: true, key: this.config.device_key };
    }

    const file = this.config.device_key_file;
    const dir = this.config.device_key_dir;
    if (file === '' && dir === '') return { ok: true, key: null };

    if (this.config.allow_create_device_key === false) {
      const expected = file !== '' ? file : path.join(dir, DEVICE_KEY_FILE);
      if (!existsSync(expected)) {
        return {
          ok: false,
          code: POOL_RUNTIME_CODE.DEVICE_KEY_UNAVAILABLE,
          detail: `device key was not found at ${expected} and creation is disabled`,
        };
      }
    }

    const loader = this.config.load_device_key ?? ((options) => DeviceKey.load(options));
    try {
      const loaded = await loader({
        ...(file === '' ? {} : { file }),
        ...(dir === '' ? {} : { dir }),
        machineId,
      });
      const key = isRecord(loaded) && loaded.key !== undefined ? loaded.key : loaded;
      if (key === null || key === undefined) {
        return {
          ok: false,
          code: POOL_RUNTIME_CODE.DEVICE_KEY_UNAVAILABLE,
          detail: 'device key loader returned no key',
        };
      }
      return { ok: true, key };
    } catch (error) {
      return {
        ok: false,
        code: POOL_RUNTIME_CODE.DEVICE_KEY_UNAVAILABLE,
        detail: detailOf(error),
      };
    }
  }

  async #build() {
    if (this.config.signal_url === '') {
      return {
        ok: false,
        code: POOL_RUNTIME_CODE.BAD_CONFIG,
        detail: 'signalUrl is required',
      };
    }

    const identityResult = await this.#resolveIdentity();
    if (!identityResult.ok) return identityResult;
    const machineId = identityResult.identity.machine_id;
    this.machineId = machineId;

    const keyResult = await this.#resolveDeviceKey(machineId);
    if (!keyResult.ok) return keyResult;
    this.deviceKey = keyResult.key;

    let resolvePeerKey = this.config.resolve_peer_key;
    if (resolvePeerKey === null && this.config.get_json !== null) {
      resolvePeerKey = createRelayPeerKeyResolver({ getJson: this.config.get_json });
    }
    if (typeof resolvePeerKey !== 'function') {
      return {
        ok: false,
        code: POOL_RUNTIME_CODE.PEER_KEY_RESOLVER_REQUIRED,
        detail: 'resolvePeerKey or getJson is required to build a WebRTC pool',
      };
    }

    const factory = this.config.pool_factory ?? createWebRtcTransportPool;
    let built;
    try {
      built = await factory(poolOptions(this.config, machineId, keyResult.key, resolvePeerKey));
    } catch (error) {
      return {
        ok: false,
        code: POOL_RUNTIME_CODE.BUILD_FAILED,
        detail: detailOf(error),
      };
    }

    if (built !== null && typeof built === 'object' && built.ok === false) {
      return {
        ok: false,
        code: built.code ?? POOL_RUNTIME_CODE.BUILD_FAILED,
        detail: built.detail ?? 'pool factory returned ok:false',
      };
    }

    const pool = built !== null && typeof built === 'object' && built.ok === true ? built.pool : built;
    if (pool === null || typeof pool !== 'object' || typeof pool.send !== 'function') {
      return {
        ok: false,
        code: POOL_RUNTIME_CODE.BUILD_FAILED,
        detail: 'pool factory returned no usable pool',
      };
    }
    return { ok: true, pool };
  }

  async #ensureOnce() {
    const existing = registryState(this.registry);
    if (existing.pool !== null && existing.pool !== undefined) {
      this.pool = existing.pool;
      this.owner = existing.owner ?? this.config.owner;
      return {
        ok: true,
        reused: true,
        created: false,
        pool: this.pool,
        owner: this.owner,
        status: this.status(),
      };
    }

    if (typeof this.registry.acquire !== 'function') {
      return {
        ok: false,
        code: POOL_RUNTIME_CODE.BAD_CONFIG,
        detail: 'registry has no acquire()',
      };
    }

    const acquired = await this.registry.acquire({
      owner: this.config.owner,
      create: () => this.#build(),
    });
    if (!acquired?.ok) return acquired;

    this.pool = acquired.pool;
    this.owner = acquired.owner ?? this.config.owner;
    return {
      ok: true,
      reused: acquired.reused === true,
      created: acquired.reused !== true,
      pool: this.pool,
      owner: this.owner,
      status: this.status(),
    };
  }

  /** Build or borrow the process pool. Idempotent; concurrent calls share one attempt. */
  ensure() {
    if (this.ensuring !== null) return this.ensuring;
    const promise = this.#ensureOnce().finally(() => {
      if (this.ensuring === promise) this.ensuring = null;
    });
    this.ensuring = promise;
    return promise;
  }

  status() {
    const current = registryState(this.registry);
    const pool = current.pool ?? this.pool;
    let diagnostics = null;
    if (pool !== null && typeof pool.diagnostics === 'function') {
      try {
        diagnostics = pool.diagnostics();
      } catch {
        diagnostics = null;
      }
    }
    return {
      ok: true,
      ready: pool !== null,
      owner: current.owner ?? this.owner,
      machine_id: this.machineId === '' ? null : this.machineId,
      signal_url: this.config.signal_url === '' ? null : redactSignalingUrl(this.config.signal_url),
      signal_token_present: this.config.signal_token !== '',
      device_key_present: this.deviceKey !== null && this.deviceKey !== undefined,
      diagnostics,
    };
  }

  /**
   * The owner's teardown. A borrower gets `NOT_OWNER` and leaves the pool alone; that is the
   * difference between closing a desktop view and tearing down Teams / dispatch underneath it.
   */
  async stop() {
    const current = registryState(this.registry);
    if (this.pool === null || current.pool !== this.pool) {
      return { ok: true, stopped: false, reason: 'not_current_pool' };
    }
    if (current.owner !== this.config.owner) {
      return {
        ok: false,
        code: POOL_RUNTIME_CODE.NOT_OWNER,
        detail: `pool is owned by ${JSON.stringify(current.owner)}, not ${JSON.stringify(this.config.owner)}`,
      };
    }
    if (typeof this.registry.release === 'function') {
      const released = this.registry.release(this.config.owner, this.pool);
      if (!released?.ok) return released;
    }

    const pool = this.pool;
    this.pool = null;
    if (typeof pool.stop === 'function') {
      try {
        await pool.stop();
      } catch (error) {
        return { ok: false, code: POOL_RUNTIME_CODE.STOP_FAILED, detail: detailOf(error) };
      }
    }
    return { ok: true, stopped: true };
  }

  /** Late binding for this runtime's consumers. */
  subscribe(listener, options = {}) {
    if (typeof this.registry.subscribe !== 'function') {
      throw new TypeError('registry has no subscribe()');
    }
    return this.registry.subscribe(listener, options);
  }
}

/** A per-caller runtime, without the process singleton. */
export function createWebRtcPoolRuntime(config, deps = {}) {
  return new WebRtcPoolRuntime(config, deps);
}

let globalRuntime = null;

/**
 * Production entry point. The first caller defines the runtime; every later caller gets the same
 * one. That is deliberate: a second runtime with a different signal URL would be a second pool,
 * which the registry would reject anyway.
 */
export function ensureWebRtcPoolRuntime(config = {}, deps = {}) {
  if (deps.runtime instanceof WebRtcPoolRuntime) return deps.runtime.ensure();
  if (globalRuntime === null) globalRuntime = new WebRtcPoolRuntime(config, deps);
  return globalRuntime.ensure();
}

export function getWebRtcPoolRuntime() {
  return globalRuntime;
}

/** Test-only seam; production never calls this. */
export function resetWebRtcPoolRuntimeForTests() {
  globalRuntime = null;
}
