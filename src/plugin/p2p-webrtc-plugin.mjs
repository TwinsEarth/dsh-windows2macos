/**
 * `dsh-p2p-webrtc`: the mountable P2P-first WebRTC surface.
 *
 * This subplugin is deliberately separate from the UDP P2P implementation and from the relay. It
 * adds a second transport stack, not a replacement:
 *
 *   - `webrtc-v1` is a real `P2PTransport` shape (`start/stop/send/onMessage/paths/diagnostics`);
 *   - it is opt-in, and the bundle row ships `disabled: true`;
 *   - it refuses to start unless an external WebRTC engine command is configured (the package
 *     stays zero-dependency by policy);
 *   - the Noise handshake is the existing W2M one, so a relay/TURN path sees only ciphertext.
 *
 * ## v3.6.0 P2: this row is the shared pool provider
 *
 * `mode: 'pool'` (the production profile) makes `autoStart` build the one process-wide
 * `webrtc-v1` pool through `pool-runtime.mjs`, with owner `dsh-p2p-webrtc`. The root `w2m` row and
 * the desktop / Teams / P2P-V2 surfaces acquire that same pool from the registry; they never build
 * a second one. `mode: 'single'` keeps the original one-transport lifecycle for compatibility and
 * for a deliberate one-pair test.
 *
 * ## Stop semantics
 *
 * `p2p_webrtc_stop` closes one peer and never calls `pool.stop()`: the desktop viewer and Teams
 * data plane are consumers of the same pool, and stopping the provider to close one view would
 * tear them down underneath the operator. A whole-pool stop requires `confirm: "pool-stop"` and is
 * refused by the runtime when this process merely borrowed the pool.
 *
 * ## Why `apply()` does not spawn anything unless `autoStart` is set
 *
 * A mounted-but-disabled row must be inert. `apply()` normalizes configuration and registers tools.
 * With `autoStart: true` it awaits the pool build, because the production profile wants the pool
 * published before the desktop row's first `/start`; a build failure is logged with its named code
 * and does not block the mount. Otherwise `p2p_webrtc_start` is the first place that spawns an
 * engine or opens a signaling socket.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadIdentity } from '../agent/identity.mjs';
import { createWebRtcTransport, WEBRTC_TRANSPORT_CODE } from '../agent/webrtc/transport.mjs';
import { describeIceServers, normalizeIceServers } from '../agent/webrtc/path.mjs';
import { buildIceServersForPeer, describeTurnServers, normalizeTurnServers } from '../agent/webrtc/turn-pool.mjs';
import { redactSignalingUrl } from '../agent/webrtc/signaling.mjs';
import { createWebRtcPoolRuntime } from './p2p-webrtc/pool-runtime.mjs';
import { loadDefineTool, request } from './tools/shared.mjs';

/** The Cordis plugin name. */
export const name = 'w2m-dsh-p2p-webrtc';

/** No host service is required to register tools; `tools` is optional at mount time. */
export const inject = [];

/** The four tools this row owns. */
export const TOOL_NAMES = Object.freeze([
  'p2p_webrtc_status',
  'p2p_webrtc_start',
  'p2p_webrtc_stop',
  'p2p_webrtc_probe',
]);

/** Route prefix for the one-click repair surface. */
export const P2P_WEBRTC_ROUTE_PREFIX = '/api/w2m/p2p-webrtc';
/** POST-only repair route used by the remote desktop panel. */
export const P2P_WEBRTC_REPAIR_PATH = `${P2P_WEBRTC_ROUTE_PREFIX}/repair`;

/** The patch row id. */
export const P2P_WEBRTC_ROW_ID = 'dsh-p2p-webrtc';

/** The pool owner this row publishes under when it builds the shared pool. */
export const P2P_WEBRTC_POOL_OWNER = 'dsh-p2p-webrtc';

/** `pool` is the production provider; `single` keeps the original one-pair lifecycle. */
export const P2P_WEBRTC_MODES = Object.freeze(['pool', 'single']);

/** Named refusals the pool-backed tool surface can return without a runtime exception. */
export const P2P_WEBRTC_POOL_CODE = Object.freeze({
  STOP_REFUSED: 'WEBRTC_POOL_STOP_REFUSED',
  PEER_REQUIRED: 'WEBRTC_POOL_PEER_REQUIRED',
  NOT_READY: 'WEBRTC_POOL_NOT_READY',
  PEER_NOT_LIVE: 'WEBRTC_POOL_PEER_NOT_LIVE',
  NOT_OWNER: 'WEBRTC_POOL_NOT_OWNER',
});

/** Default state directory, matching the agent's `xclient` home. */
function defaultDshHome(env) {
  const value = env?.DSH_HOME ?? process.env.DSH_HOME;
  return typeof value === 'string' && value !== '' ? value : join(homedir(), '.dsh');
}

/**
 * Provider scripts shipped in this package. Keep this as a path probe rather than a hard import:
 * the package has no runtime dependency on `node-datachannel`, and an installed package may run
 * from either `src/` (development) or `lib/` (published entrypoints).
 *
 * @returns {string[]}
 */
function packagedProviderScripts() {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, '..', 'agent', 'webrtc', 'providers', 'node-datachannel-provider.mjs'),
    join(here, '..', 'src', 'agent', 'webrtc', 'providers', 'node-datachannel-provider.mjs'),
  ];
}

/**
 * A one-click relay repair may need to find the provider the operator already installed but did
 * not wire into `providerCommand`. Only known local directories are probed; nothing is installed
 * or downloaded, and the configured provider always wins.
 *
 * @param {object} cfg normalized plugin config
 * @param {{env?: Record<string,string|undefined>, providerDirs?: string[]}} [deps]
 * @returns {{ok:true, source:'config'|'factory'|'auto', provider_command?:string, provider_args?:string[],
 *   provider_cwd?:string, checked?:string[]}|{ok:false, code:string, detail:string, checked:string[]}}
 */
function providerNodeCommand(env) {
  if (typeof env?.W2M_PROVIDER_NODE === 'string' && env.W2M_PROVIDER_NODE !== '') {
    return env.W2M_PROVIDER_NODE;
  }
  // When the host itself is a Node process, use its exact binary instead of a PATH lookup: DSH's
  // bundled runtime is often not on PATH, and `node` may resolve to an unrelated system install.
  const execPath = typeof process.execPath === 'string' ? process.execPath : '';
  if (/(?:^|[\\/])node(?:\.exe)?$/i.test(execPath)) return execPath;
  return 'node';
}

function missingProviderScript(cfg) {
  const args = Array.isArray(cfg.provider_args) ? cfg.provider_args : [];
  for (const arg of args) {
    if (typeof arg !== 'string' || !/\.(?:cjs|mjs|js)$/i.test(arg)) continue;
    const candidates = [
      resolvePath(arg),
      ...(typeof cfg.provider_cwd === 'string' && cfg.provider_cwd !== ''
        ? [resolvePath(cfg.provider_cwd, arg)]
        : []),
    ];
    if (!candidates.some((candidate) => existsSync(candidate))) return arg;
  }
  return null;
}

function discoverProviderConfig(cfg, deps = {}) {
  if (typeof cfg.provider_command === 'string' && cfg.provider_command !== '') {
    const missing = missingProviderScript(cfg);
    const missingCommand = /\.(?:cjs|mjs|js)$/i.test(cfg.provider_command)
      && !existsSync(resolvePath(cfg.provider_command))
      ? cfg.provider_command
      : null;
    const missingPath = missing ?? missingCommand;
    if (missingPath !== null) {
      return {
        ok: false,
        code: 'WEBRTC_PROVIDER_SCRIPT_MISSING',
        detail: `provider config points at a missing script: ${missingPath}`,
        source: 'config',
        checked: [missingPath],
      };
    }
    return { ok: true, source: 'config' };
  }
  if (typeof deps.poolFactory === 'function' || typeof cfg.pool_factory === 'function') {
    return { ok: true, source: 'factory' };
  }
  const env = deps.env ?? process.env;
  const dirs = [];
  const add = (value) => {
    if (typeof value !== 'string' || value === '') return;
    const resolved = resolvePath(value);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };
  if (Array.isArray(deps.providerDirs)) for (const value of deps.providerDirs) add(value);
  add(cfg.provider_cwd);
  add(env.W2M_PROVIDER_DIR);
  add(join(homedir(), '.w2m', 'webrtc-provider'));
  add(join(cfg.dsh_home, 'webrtc-provider'));
  add(join(cfg.dsh_home, '..', 'w2m-webrtc-provider'));
  add(join(homedir(), 'w2m-webrtc-provider'));

  const scripts = packagedProviderScripts();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    if (!existsSync(join(dir, 'node_modules', 'node-datachannel'))) continue;
    const localScript = join(dir, 'node-datachannel-provider.mjs');
    const script = existsSync(localScript) ? localScript : scripts.find((candidate) => existsSync(candidate));
    if (!script) continue;
    return {
      ok: true,
      source: 'auto',
      provider_command: providerNodeCommand(env),
      provider_args: [script],
      provider_cwd: dir,
      checked: dirs,
    };
  }
  return {
    ok: false,
    code: 'WEBRTC_PROVIDER_UNAVAILABLE',
    detail:
      'providerCommand is empty and no installed node-datachannel provider was found in the standard directories',
    checked: dirs,
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize the row configuration into the flat object the service and tools use.
 *
 * Camel-case keys are the patch's spelling; snake-case fields are internal. Nothing here invents a
 * credential: an empty signal token stays empty, and a missing provider command stays missing so
 * `start` can say exactly what is absent.
 *
 * @param {Record<string, any>} [config]
 * @param {{env?: Record<string,string|undefined>, dshHome?: string, providerFactory?: Function,
 *   signalingFactory?: Function, deviceKey?: object}} [deps]
 * @returns {object}
 */
export function normalizePluginConfig(config = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const dshHome =
    typeof deps.dshHome === 'string' && deps.dshHome !== '' ? resolvePath(deps.dshHome) : defaultDshHome(env);
  const rawProvider = config.providerCommand ?? '';
  let providerCommand = '';
  let providerArgs = [];
  if (Array.isArray(rawProvider)) {
    providerCommand = typeof rawProvider[0] === 'string' ? rawProvider[0] : '';
    providerArgs = rawProvider.slice(1).map(String);
  } else if (typeof rawProvider === 'string') {
    providerCommand = rawProvider;
  }
  if (Array.isArray(config.providerArgs)) providerArgs = config.providerArgs.map(String);
  const ice = normalizeIceServers(config.iceServers ?? []);
  const turn = normalizeTurnServers(config.turnServers ?? []);
  const peerKeys = new Map();
  if (config.peerKeys instanceof Map) {
    for (const [key, value] of config.peerKeys)
      if (typeof value === 'string') peerKeys.set(String(key), value);
  } else if (isRecord(config.peerKeys)) {
    for (const [key, value] of Object.entries(config.peerKeys))
      if (typeof value === 'string') peerKeys.set(key, value);
  }
  const mode =
    config.mode === 'pool' || config.mode === 'single'
      ? config.mode
      : config.autoStart === true
        ? 'pool'
        : 'single';
  return {
    dsh_home: dshHome,
    mode,
    pool_mode: mode === 'pool',
    signal_url: typeof config.signalUrl === 'string' ? config.signalUrl : '',
    signal_token: typeof config.signalToken === 'string' ? config.signalToken : '',
    rabbit_url: typeof config.rabbitUrl === 'string' ? config.rabbitUrl : '',
    room: typeof config.room === 'string' && config.room !== '' ? config.room : 'w2m',
    role: config.role === 'host' || config.role === 'client' ? config.role : '',
    peer_id: typeof config.peerId === 'string' ? config.peerId : '',
    peer_machine_id: typeof config.peerMachineId === 'string' ? config.peerMachineId : '',
    machine_id: typeof config.machineId === 'string' ? config.machineId : '',
    peer_public_key: typeof config.peerPublicKey === 'string' ? config.peerPublicKey : '',
    peer_keys: peerKeys,
    device_key_file: typeof config.deviceKeyFile === 'string' ? config.deviceKeyFile : '',
    device_key_dir: typeof config.deviceKeyDir === 'string' ? config.deviceKeyDir : '',
    allow_create_device_key: config.allowCreateDeviceKey === true,
    provider_command: providerCommand,
    provider_args: providerArgs,
    provider_cwd: typeof config.providerCwd === 'string' ? config.providerCwd : '',
    provider_env: isRecord(config.providerEnv) ? config.providerEnv : undefined,
    ice_servers: ice.ok === true ? ice.servers : [],
    ice_refused: ice.ok === true ? ice.refused : [{ entry: String(config.iceServers), reason: ice.detail }],
    turn_servers: turn.ok === true ? turn.servers : [],
    turn_refused: turn.ok === true ? turn.refused : [{ entry: String(config.turnServers), reason: turn.detail }],
    turn_policy: config.turnPolicy === 'primary' ? 'primary' : 'balanced',
    prefer_p2p: config.preferP2p !== false,
    allow_relay: config.allowRelay !== false,
    max_rtt_ms:
      Number.isFinite(Number(config.maxRttMs)) && Number(config.maxRttMs) > 0 ? Number(config.maxRttMs) : 350,
    connect_timeout_ms:
      Number.isFinite(Number(config.connectTimeoutMs)) && Number(config.connectTimeoutMs) > 0
        ? Number(config.connectTimeoutMs)
        : 30_000,
    handshake_timeout_ms:
      Number.isFinite(Number(config.handshakeTimeoutMs)) && Number(config.handshakeTimeoutMs) > 0
        ? Number(config.handshakeTimeoutMs)
        : 15_000,
    peer_timeout_ms:
      Number.isFinite(Number(config.peerTimeoutMs)) && Number(config.peerTimeoutMs) > 0
        ? Number(config.peerTimeoutMs)
        : 20_000,
    stats_poll_ms: Number.isFinite(Number(config.statsPollMs)) ? Number(config.statsPollMs) : 2_000,
    max_fragment_bytes:
      Number.isFinite(Number(config.maxFragmentBytes)) && Number(config.maxFragmentBytes) >= 64
        ? Number(config.maxFragmentBytes)
        : 16 * 1024,
    auto_start: config.autoStart === true,
    provider_factory: deps.providerFactory ?? null,
    signaling_factory: deps.signalingFactory ?? null,
    device_key: deps.deviceKey ?? null,
    identity: deps.identity ?? null,
    get_json: typeof deps.getJson === 'function' ? deps.getJson : null,
    pool_runtime: deps.poolRuntime ?? null,
    registry: deps.registry ?? null,
    pool_factory: deps.poolFactory ?? null,
    load_identity: deps.loadIdentity ?? null,
    load_device_key: deps.loadDeviceKey ?? null,
  };
}

/**
 * A redacted view of the configuration for `p2p_webrtc_status`.
 * @param {object} cfg
 * @returns {object}
 */
export function describeConfig(cfg) {
  return {
    mode: cfg.mode,
    signal_url: cfg.signal_url === '' ? '' : redactSignalingUrl(cfg.signal_url),
    signal_token: cfg.signal_token === '' ? null : '<redacted>',
    rabbit_url: cfg.rabbit_url === '' ? null : redactSignalingUrl(cfg.rabbit_url),
    room: cfg.room,
    role: cfg.role || null,
    peer_id: cfg.peer_id || null,
    peer_machine_id: cfg.peer_machine_id || null,
    machine_id: cfg.machine_id || null,
    peer_public_key: cfg.peer_public_key === '' ? null : cfg.peer_public_key,
    peer_key_count: cfg.peer_keys.size,
    device_key_file: cfg.device_key_file || null,
    device_key_dir: cfg.device_key_dir || join(cfg.dsh_home, 'xclient'),
    allow_create_device_key: cfg.allow_create_device_key,
    provider_command: cfg.provider_command || null,
    provider_args: cfg.provider_args,
    provider_cwd: cfg.provider_cwd || null,
    ice_servers: describeIceServers(cfg.ice_servers),
    ice_refused: cfg.ice_refused,
    turn_servers: describeTurnServers(cfg.turn_servers),
    turn_refused: cfg.turn_refused,
    turn_policy: cfg.turn_policy,
    prefer_p2p: cfg.prefer_p2p,
    allow_relay: cfg.allow_relay,
    max_rtt_ms: cfg.max_rtt_ms,
    connect_timeout_ms: cfg.connect_timeout_ms,
    handshake_timeout_ms: cfg.handshake_timeout_ms,
    peer_timeout_ms: cfg.peer_timeout_ms,
    stats_poll_ms: cfg.stats_poll_ms,
    max_fragment_bytes: cfg.max_fragment_bytes,
    auto_start: cfg.auto_start,
  };
}

/**
 * Resolve peer static keys from the relay without importing the whole root tool stack.
 *
 * The pool runtime accepts `getJson(pathname)` and expects the `{ok,status,json,error}` envelope
 * `request()` returns. The identity is read lazily because `autoStart` may publish the pool before
 * the first peer is dialled; a missing pairing then becomes a named `WEBRTC_POOL_PEER_KEY_MISSING`
 * in the pool record rather than a mount failure.
 *
 * @param {object} cfg normalized plugin config
 * @returns {(pathname: string) => Promise<object>}
 */
function createRelayGetJson(cfg) {
  return async (pathname) => {
    const loaded = loadIdentity({ dir: join(cfg.dsh_home, 'xclient') });
    const identity = loaded.identity ?? null;
    const rabbitUrl =
      cfg.rabbit_url !== ''
        ? cfg.rabbit_url
        : typeof identity?.rabbit_url === 'string' && identity.rabbit_url !== ''
          ? identity.rabbit_url
          : (process.env.W2M_RABBIT_URL ?? '');
    const token =
      typeof identity?.device_token === 'string' && identity.device_token !== ''
        ? identity.device_token
        : null;
    return request({
      rabbitUrl,
      token,
      method: 'GET',
      pathname,
      timeoutMs: 5_000,
      maxBytes: 64 * 1024,
    });
  };
}

/**
 * Lifecycle owner for one transport instance, or for the shared process pool in `mode: 'pool'`.
 *
 * The single-transport half is unchanged: it creates lazily, reuses a live transport and refuses a
 * second `start` while one is ready. The pool half owns a `WebRtcPoolRuntime`; `start` ensures the
 * pool and optionally one peer, `stop` closes only that peer unless the caller explicitly asks for
 * `confirm: "pool-stop"`, and `dispose` never tears down the shared pool.
 *
 * The object is deliberately not an EventEmitter: the tools read snapshots, and a status tool that
 * pushed events would be a second surface to keep in sync.
 */
export class P2PWebRtcService {
  /**
   * @param {object} cfg
   * @param {{deviceKey?: object, providerFactory?: Function|null, signalingFactory?: Function|null,
   *   poolRuntime?: object, poolFactory?: Function, registry?: object, getJson?: Function,
   *   identity?: object, loadIdentity?: Function, loadDeviceKey?: Function}} [deps]
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.deps = deps;
    this.mode = cfg.mode === 'pool' ? 'pool' : 'single';
    this.transport = null;
    this.poolRuntime = cfg.pool_runtime ?? deps.poolRuntime ?? null;
    this.pool = null;
    this.lastStart = null;
    this.lastStop = null;
    this.lastEnsure = null;
    this.createdAt = null;
  }

  /** @returns {object} Transport options derived from config plus per-start overrides. */
  #options(overrides = {}) {
    const cfg = {
      ...this.cfg,
      ...overrides,
    };
    const iceServers =
      Array.isArray(cfg.turn_servers) && cfg.turn_servers.length > 0
        ? buildIceServersForPeer({
            turnServers: cfg.turn_servers,
            iceServers: cfg.ice_servers,
            localId: cfg.machine_id,
            peerId: cfg.peer_machine_id,
            policy: cfg.turn_policy,
          })
        : cfg.ice_servers;
    return {
      role: cfg.role,
      signalUrl: cfg.signal_url,
      signalToken: cfg.signal_token,
      room: cfg.room,
      peerId: cfg.peer_id || undefined,
      peerMachineId: cfg.peer_machine_id,
      machineId: cfg.machine_id,
      peerPublicKey: cfg.peer_public_key,
      peerKeys: cfg.peer_keys,
      deviceKey: this.deps.deviceKey ?? cfg.device_key,
      deviceKeyFile: cfg.device_key_file,
      deviceKeyDir: cfg.device_key_dir,
      allowCreateDeviceKey: cfg.allow_create_device_key,
      providerCommand: cfg.provider_command,
      providerArgs: cfg.provider_args,
      providerCwd: cfg.provider_cwd,
      providerEnv: cfg.provider_env,
      providerFactory: this.deps.providerFactory ?? cfg.provider_factory,
      signalingFactory: this.deps.signalingFactory ?? cfg.signaling_factory,
      iceServers,
      turnServers: cfg.turn_servers,
      turnPolicy: cfg.turn_policy,
      preferP2p: cfg.prefer_p2p,
      allowRelay: cfg.allow_relay,
      maxRttMs: cfg.max_rtt_ms,
      connectTimeoutMs: cfg.connect_timeout_ms,
      handshakeTimeoutMs: cfg.handshake_timeout_ms,
      peerTimeoutMs: cfg.peer_timeout_ms,
      statsPollMs: cfg.stats_poll_ms,
      maxFragmentBytes: cfg.max_fragment_bytes,
    };
  }

  /** Build the pool runtime lazily; construction alone never loads a key or spawns a provider. */
  #poolRuntime(overrides = {}) {
    if (this.poolRuntime !== null) return this.poolRuntime;
    const source = { ...this.cfg, ...overrides };
    this.poolRuntime = createWebRtcPoolRuntime(
      {
        owner: P2P_WEBRTC_POOL_OWNER,
        machine_id: source.machine_id,
        identity: source.identity,
        signal_url: source.signal_url,
        signal_token: source.signal_token,
        rabbit_url: source.rabbit_url,
        device_key: this.deps.deviceKey ?? source.device_key,
        device_key_file: source.device_key_file,
        device_key_dir: source.device_key_dir || join(source.dsh_home, 'xclient'),
        allow_create_device_key: source.allow_create_device_key,
        provider_command: source.provider_command,
        provider_args: source.provider_args,
        provider_cwd: source.provider_cwd,
        provider_env: source.provider_env,
        ice_servers: source.ice_servers,
        turn_servers: source.turn_servers,
        turn_policy: source.turn_policy,
        prefer_p2p: source.prefer_p2p,
        allow_relay: source.allow_relay,
        max_rtt_ms: source.max_rtt_ms,
        connect_timeout_ms: source.connect_timeout_ms,
        handshake_timeout_ms: source.handshake_timeout_ms,
        peer_timeout_ms: source.peer_timeout_ms,
        stats_poll_ms: source.stats_poll_ms,
        max_fragment_bytes: source.max_fragment_bytes,
        get_json: (this.deps.getJson ?? source.get_json) ?? createRelayGetJson(source),
      },
      {
        registry: this.deps.registry ?? source.registry,
        poolFactory: this.deps.poolFactory ?? source.pool_factory,
        loadIdentity: this.deps.loadIdentity ?? source.load_identity,
        loadDeviceKey: this.deps.loadDeviceKey ?? source.load_device_key,
      },
    );
    return this.poolRuntime;
  }

  /** The live pool, whether this runtime built it or borrowed it. */
  #livePool() {
    if (this.pool !== null) return this.pool;
    const runtime = this.#poolRuntime();
    return runtime.pool ?? null;
  }

  /** Normalize a peer id from a tool argument or the configured default. */
  #peer(options = {}) {
    const value = options.peer_machine_id ?? options.peerMachineId ?? this.cfg.peer_machine_id;
    return typeof value === 'string' && value !== '' ? value : '';
  }

  /**
   * Probe for an already-installed provider when the row has no `providerCommand`.
   * The caller may pass the returned fields to {@link start}; this never mutates config or installs
   * anything. It is deliberately separate from `ensurePool()` so autoStart keeps its explicit
   * "no provider means a named refusal" contract.
   *
   * @returns {object}
   */
  discoverProvider() {
    return discoverProviderConfig(this.cfg, this.deps);
  }

  /**
   * Build or borrow the shared pool. A borrowed pool keeps its original owner; a conflicting
   * publication is returned as `WEBRTC_POOL_OWNER_CONFLICT` by the registry instead of replacing a
   * live desktop / Teams transport underneath the operator.
   *
   * @returns {Promise<object>}
   */
  async ensurePool(overrides = {}) {
    const provider = overrides.provider_command ?? this.cfg.provider_command;
    const poolFactory = this.deps.poolFactory ?? this.cfg.pool_factory;
    if (provider === '' && typeof poolFactory !== 'function') {
      const refusal = {
        ok: false,
        code: 'WEBRTC_PROVIDER_UNAVAILABLE',
        detail:
          'providerCommand is required to publish the shared pool; the package has no bundled WebRTC engine',
      };
      this.lastEnsure = { ...refusal, at: Date.now() };
      return refusal;
    }
    const runtime = this.#poolRuntime(overrides);
    let result;
    try {
      result = await runtime.ensure();
    } catch (error) {
      result = {
        ok: false,
        code: 'WEBRTC_POOL_BUILD_FAILED',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.lastEnsure = {
      ok: result.ok === true,
      code: result.code ?? null,
      detail: result.detail ?? null,
      owner: result.owner ?? null,
      reused: result.reused === true,
      created: result.created === true,
      at: Date.now(),
    };
    if (result.ok === true && result.pool !== undefined && result.pool !== null) this.pool = result.pool;
    return { ...result, last_ensure: this.lastEnsure };
  }

  /** A serialisable view of the shared pool, with no transport object in it. */
  #poolStatus() {
    if (this.poolRuntime === null) {
      return {
        mode: 'pool',
        ready: false,
        owner: null,
        machine_id: this.cfg.machine_id || null,
        peers: [],
        peer_count: 0,
        diagnostics: null,
        last_ensure: this.lastEnsure,
      };
    }
    const runtime = this.poolRuntime;
    let status;
    try {
      status = runtime.status();
    } catch (error) {
      return {
        mode: 'pool',
        ready: false,
        owner: null,
        machine_id: null,
        peers: [],
        peer_count: 0,
        diagnostics: null,
        error: error instanceof Error ? error.message : String(error),
        last_ensure: this.lastEnsure,
      };
    }
    const diagnostics = status.diagnostics ?? null;
    const peers = Array.isArray(diagnostics?.peers) ? diagnostics.peers : [];
    return {
      mode: 'pool',
      ready: status.ready === true,
      owner: status.owner ?? null,
      machine_id: status.machine_id ?? null,
      signal_url: status.signal_url ?? null,
      device_key_present: status.device_key_present === true,
      peers,
      peer_count: Number.isInteger(diagnostics?.peer_count) ? diagnostics.peer_count : peers.length,
      diagnostics,
      last_ensure: this.lastEnsure,
    };
  }

  /** The public `pool` field for `mode: 'single'`: explicitly not ready and never guessed. */
  #singlePoolStatus() {
    return {
      mode: 'single',
      ready: false,
      owner: null,
      machine_id: this.cfg.machine_id || null,
      peers: [],
      peer_count: 0,
      diagnostics: null,
      last_ensure: null,
    };
  }

  /**
   * Start in the configured mode. In `pool` mode this ensures the process pool and, when a peer is
   * configured or supplied, starts one pair inside it. A second call is idempotent in both modes.
   *
   * @param {object} [overrides]
   * @returns {Promise<object>}
   */
  async start(overrides = {}) {
    if (this.mode === 'pool') return this.#startPool(overrides);
    if (this.transport !== null) {
      const diagnostics = this.transport.diagnostics();
      if (diagnostics.state === 'ready' || diagnostics.state === 'connecting') {
        return { ok: true, reused: true, diagnostics };
      }
    }
    const created = createWebRtcTransport(this.#options(overrides));
    if (created.ok !== true) {
      this.lastStart = { ok: false, code: created.code, detail: created.detail, at: Date.now() };
      return this.lastStart;
    }
    this.transport = created.transport;
    this.createdAt = Date.now();
    let result;
    try {
      result = await this.transport.start();
    } catch (error) {
      result = {
        ok: false,
        code: WEBRTC_TRANSPORT_CODE.SEND_FAILED,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.lastStart = { ...result, at: Date.now() };
    if (result.ok !== true) {
      await this.transport.stop();
      this.transport = null;
    }
    return this.lastStart;
  }

  /** Pool-mode start: publish the pool, then optionally prepare one pair. */
  async #startPool(overrides = {}) {
    const ensured = await this.ensurePool(overrides);
    if (ensured.ok !== true) {
      this.lastStart = {
        ok: false,
        code: ensured.code ?? 'WEBRTC_POOL_BUILD_FAILED',
        detail: ensured.detail ?? 'pool build failed',
        at: Date.now(),
      };
      return { ...this.lastStart, pool: this.#poolStatus() };
    }
    const peer = this.#peer(overrides);
    if (peer === '') {
      this.lastStart = {
        ok: true,
        peer: null,
        state: 'pool-ready',
        reused: ensured.reused === true,
        created: ensured.created === true,
        at: Date.now(),
      };
      return { ...this.lastStart, pool: this.#poolStatus() };
    }
    const pool = this.pool ?? this.#livePool();
    if (pool === null || typeof pool.ensure !== 'function') {
      this.lastStart = {
        ok: false,
        code: P2P_WEBRTC_POOL_CODE.NOT_READY,
        detail: 'the pool reported ready but exposed no ensure()',
        peer,
        at: Date.now(),
      };
      return { ...this.lastStart, pool: this.#poolStatus() };
    }
    let ready;
    try {
      ready = await pool.ensure(peer);
    } catch (error) {
      ready = {
        ok: false,
        code: 'WEBRTC_POOL_START_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        peer,
      };
    }
    const { transport, ...publicReady } = ready;
    void transport;
    this.lastStart = { ...publicReady, at: Date.now() };
    return { ...this.lastStart, pool: this.#poolStatus() };
  }

  /**
   * Close one peer in pool mode. The pool itself stays published for the desktop viewer, Teams and
   * P2P V2; that is why this never calls `pool.stop()`.
   *
   * @param {string} peerMachineId
   * @returns {Promise<object>}
   */
  async stopPeer(peerMachineId) {
    const pool = this.#livePool();
    if (pool === null || typeof pool.closePeer !== 'function') {
      return {
        ok: false,
        code: P2P_WEBRTC_POOL_CODE.NOT_READY,
        detail: 'the shared WebRTC pool is not published; nothing was closed',
        peer: peerMachineId,
      };
    }
    const before = typeof pool.peerStatus === 'function' ? pool.peerStatus(peerMachineId) : null;
    let result;
    try {
      result = await pool.closePeer(peerMachineId, 'p2p-webrtc-stop');
    } catch (error) {
      result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    this.lastStop = {
      ok: result.ok === true,
      peer: peerMachineId,
      closed: result.closed === true,
      scope: 'peer',
      at: Date.now(),
    };
    return {
      ...this.lastStop,
      was_live: before !== null,
      pool: this.#poolStatus(),
    };
  }

  /** Pool-mode stop: one peer by default, the whole pool only with `confirm: "pool-stop"`. */
  async #stopPool(options = {}) {
    const peer = this.#peer(options);
    if (peer !== '') return this.stopPeer(peer);
    if (options.confirm !== 'pool-stop') {
      return {
        ok: false,
        code: P2P_WEBRTC_POOL_CODE.STOP_REFUSED,
        detail:
          'no peerMachineId was supplied; p2p_webrtc_stop closes one peer and never tears down the shared pool. ' +
          'Pass a peerMachineId, or confirm:"pool-stop" to stop the pool for desktop and Teams as well.',
        pool: this.#poolStatus(),
      };
    }
    const runtime = this.#poolRuntime();
    let result;
    try {
      result = await runtime.stop();
    } catch (error) {
      result = { ok: false, code: 'WEBRTC_POOL_STOP_FAILED', detail: error instanceof Error ? error.message : String(error) };
    }
    this.lastStop = { ...result, scope: 'pool', at: Date.now() };
    if (result.ok === true) this.pool = null;
    return { ...this.lastStop, pool: this.#poolStatus() };
  }

  /**
   * Single-mode stop and pool-mode default. Pool mode with no peer refuses; a peer closes only that
   * pair; `confirm: "pool-stop"` is the explicit whole-pool teardown.
   *
   * @param {{confirm?: string, peer_machine_id?: string, peerMachineId?: string}} [options]
   * @returns {Promise<object>}
   */
  async stop(options = {}) {
    if (this.mode === 'pool') return this.#stopPool(options);
    if (this.transport === null) {
      this.lastStop = { ok: true, state: 'stopped', reused: true, at: Date.now() };
      return this.lastStop;
    }
    const transport = this.transport;
    this.transport = null;
    const result = await transport.stop();
    this.lastStop = { ...result, at: Date.now() };
    return this.lastStop;
  }

  /**
   * Disposer path. Single mode stops its own transport; pool mode closes only the configured peer
   * and leaves the shared pool alive for every other consumer.
   *
   * @returns {Promise<object>}
   */
  async dispose() {
    if (this.mode !== 'pool') return this.stop();
    const peer = this.#peer();
    if (peer === '') {
      return { ok: true, scope: 'pool-provider', closed: false, detail: 'no peer configured; pool left published' };
    }
    return this.stopPeer(peer);
  }

  /** @returns {object} */
  status() {
    const peer = this.cfg.peer_machine_id;
    if (this.mode === 'pool') {
      const pool = this.#poolStatus();
      const live = this.pool ?? this.poolRuntime?.pool ?? null;
      const peerStatus = peer !== '' && live !== null && typeof live.peerStatus === 'function'
        ? live.peerStatus(peer)
        : null;
      return {
        plugin: name,
        mode: this.mode,
        config: describeConfig(this.cfg),
        state: pool.ready === true ? (peerStatus?.state ?? 'pool-ready') : 'idle',
        transport: null,
        pool,
        peer: peerStatus,
        last_start: this.lastStart,
        last_stop: this.lastStop,
        last_ensure: this.lastEnsure,
        created_at: this.createdAt,
        tools: [...TOOL_NAMES],
      };
    }
    const diagnostics = this.transport?.diagnostics() ?? null;
    return {
      plugin: name,
      mode: this.mode,
      config: describeConfig(this.cfg),
      state: diagnostics?.state ?? 'idle',
      transport: diagnostics,
      pool: this.#singlePoolStatus(),
      peer: null,
      last_start: this.lastStart,
      last_stop: this.lastStop,
      last_ensure: null,
      created_at: this.createdAt,
      tools: [...TOOL_NAMES],
    };
  }

  /**
   * Probe one live pair. Pool mode refuses a peer with no pair rather than starting a new one; a
   * probe is a measurement, not a dispatch.
   *
   * @param {number} [timeoutMs]
   * @param {{peer_machine_id?: string, peerMachineId?: string}} [options]
   * @returns {Promise<object>}
   */
  async probe(timeoutMs = 5_000, options = {}) {
    if (this.mode !== 'pool') {
      if (this.transport === null) {
        return { ok: false, code: WEBRTC_TRANSPORT_CODE.NOT_READY, detail: 'transport has not been started' };
      }
      return this.transport.probe(timeoutMs);
    }
    const peer = this.#peer(options);
    if (peer === '') {
      return {
        ok: false,
        code: P2P_WEBRTC_POOL_CODE.PEER_REQUIRED,
        detail: 'peerMachineId is required to probe a pair in the shared pool',
      };
    }
    const pool = this.#livePool();
    const status = pool !== null && typeof pool.peerStatus === 'function' ? pool.peerStatus(peer) : null;
    if (status === null) {
      return {
        ok: false,
        code: P2P_WEBRTC_POOL_CODE.PEER_NOT_LIVE,
        detail: `no live WebRTC pair for ${peer}; start it first`,
        peer,
      };
    }
    const transport = pool.peers instanceof Map ? pool.peers.get(peer)?.transport ?? null : null;
    if (transport === null || typeof transport.probe !== 'function') {
      return {
        ok: false,
        code: P2P_WEBRTC_POOL_CODE.NOT_READY,
        detail: `the pair for ${peer} exists but has no live transport`,
        peer,
      };
    }
    return transport.probe(timeoutMs);
  }
}

/** JSON output helper, matching the other subplugins. */
function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

/** Text renderer for tool output. */
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/**
 * Build the four tool definitions once per mount.
 *
 * @param {{service: P2PWebRtcService, defineTool: Function}} input
 * @returns {Array<object>}
 */
export function buildTools({ service, defineTool }) {
  const registered = [];
  const register = (definition) => {
    const tool = defineTool(definition);
    registered.push(tool);
    return tool;
  };

  register({
    name: 'p2p_webrtc_status',
    description:
      'Show the P2P WebRTC subplugin configuration, mode and shared-pool state: owner, machine id, peers, signaling room, selected ICE pair, direct/relay/fallback verdict, Noise state and provider status. In pool mode every desktop / Teams / P2P-V2 consumer is visible through this one pool. Read-only and safe to call before starting.',
    parameters: {},
    output: textOutput,
    async execute() {
      return jsonText(service.status());
    },
  });

  register({
    name: 'p2p_webrtc_start',
    description:
      'Start the WebRTC transport or publish the shared pool. In pool mode (the production profile) it builds or borrows the one process pool owned by dsh-p2p-webrtc, then prepares one pair when peerMachineId is supplied. Requires an external WebRTC engine (providerCommand) because the package has no runtime dependencies. confirm:"start" is required because this spawns a process and opens a signaling socket.',
    parameters: {
      confirm: {
        type: 'string',
        required: true,
        description: 'Literal "start". Refuses before spawning anything when it does not match.',
      },
      signalUrl: { type: 'string', description: 'Override the configured ws:// or wss:// signaling URL (used before the pool is built).' },
      room: { type: 'string', description: 'Override the signaling room (default w2m).' },
      role: { type: 'string', description: 'Override the role: host or client (single mode only).' },
      peerMachineId: { type: 'string', description: 'Peer machine id to prepare inside the pool, or the single-mode peer.' },
      peerPublicKey: { type: 'string', description: 'Override the pinned peer static public key (single-mode client).' },
      providerCommand: { type: 'string', description: 'Override the WebRTC engine executable or script (used before the pool is built).' },
    },
    output: textOutput,
    async execute(args = {}) {
      if (args.confirm !== 'start') {
        return jsonText({
          ok: false,
          code: 'WEBRTC_CONFIRM_REQUIRED',
          detail: 'confirm must be the literal "start"; nothing was started',
        });
      }
      const overrides = {};
      if (typeof args.signalUrl === 'string' && args.signalUrl !== '') overrides.signal_url = args.signalUrl;
      if (typeof args.room === 'string' && args.room !== '') overrides.room = args.room;
      if (args.role === 'host' || args.role === 'client') overrides.role = args.role;
      if (typeof args.peerMachineId === 'string' && args.peerMachineId !== '')
        overrides.peer_machine_id = args.peerMachineId;
      if (typeof args.peerPublicKey === 'string' && args.peerPublicKey !== '')
        overrides.peer_public_key = args.peerPublicKey;
      if (typeof args.providerCommand === 'string' && args.providerCommand !== '')
        overrides.provider_command = args.providerCommand;
      const result = await service.start(overrides);
      return jsonText(result);
    },
  });

  register({
    name: 'p2p_webrtc_stop',
    description:
      'Close one peer in the shared pool, or stop the single-mode transport. Pool mode never tears down the pool by default because the desktop viewer, Teams data plane and P2P V2 use it; pass confirm:"pool-stop" for an explicit whole-pool stop. Idempotent.',
    parameters: {
      confirm: {
        type: 'string',
        description: 'Literal "pool-stop" to stop the whole shared pool. Omit to close one peer only.',
      },
      peerMachineId: {
        type: 'string',
        description: 'Peer machine id to close. Defaults to the configured peerMachineId.',
      },
    },
    output: textOutput,
    async execute(args = {}) {
      const options = {};
      if (typeof args.peerMachineId === 'string' && args.peerMachineId !== '')
        options.peer_machine_id = args.peerMachineId;
      if (args.confirm === 'pool-stop') options.confirm = 'pool-stop';
      return jsonText(await service.stop(options));
    },
  });

  register({
    name: 'p2p_webrtc_probe',
    description:
      'Send an authenticated Noise PING through one live DataChannel and measure RTT; refreshes the selected ICE pair statistics. Pool mode requires peerMachineId and never starts a new pair just to probe it. Read-only with respect to application data.',
    parameters: {
      timeoutMs: { type: 'number', description: 'Probe timeout in milliseconds (default 5000).' },
      peerMachineId: { type: 'string', description: 'Peer machine id to probe (pool mode). Defaults to the configured peer.' },
    },
    output: textOutput,
    async execute(args = {}) {
      const timeout =
        Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0
          ? Number(args.timeoutMs)
          : 5_000;
      const options = {};
      if (typeof args.peerMachineId === 'string' && args.peerMachineId !== '')
        options.peer_machine_id = args.peerMachineId;
      return jsonText(await service.probe(timeout, options));
    },
  });

  return registered;
}

/**
 * Mount the POST-only repair route used by the remote desktop panel.
 *
 * The button is allowed to rebuild the shared pool, but never to stop it: stopping the pool would
 * also disconnect Teams and task delivery, and the panel has no way to tell those consumers. An
 * already-ready pool therefore answers `already_ready: true` without touching it.
 *
 * When `providerCommand` is empty, the route probes the standard local provider directories and
 * passes a discovered provider into this start only. It never installs, downloads, or writes the
 * profile; a failed probe keeps the named `WEBRTC_PROVIDER_UNAVAILABLE` refusal with `checked`
 * paths so the operator can act.
 *
 * @param {object} ctx Cordis context
 * @param {P2PWebRtcService} service the mounted p2p service
 * @returns {boolean} whether an injectable connection context was available
 */
export function registerP2pWebRtcRepairRoute(ctx, service) {
  if (typeof ctx?.inject !== 'function') return false;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') return;
    registry.register({
      path: P2P_WEBRTC_REPAIR_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        let before = null;
        try { before = service.status(); } catch { /* status is best-effort */ }
        if (before?.pool?.ready === true) {
          return Response.json(
            {
              ok: true,
              already_ready: true,
              pool: before.pool,
              status: before,
              provider: null,
              stages: [{ name: 'pool', ok: true, detail: 'already ready' }],
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        }
        let discovery = null;
        if (typeof service.discoverProvider === 'function') {
          try {
            discovery = service.discoverProvider();
          } catch (error) {
            discovery = {
              ok: false,
              code: 'WEBRTC_PROVIDER_UNAVAILABLE',
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        }
        const stages = [];
        if (discovery !== null) {
          stages.push({
            name: 'provider',
            ok: discovery.ok === true,
            code: discovery.code ?? null,
            detail: discovery.detail ?? null,
            source: discovery.source ?? null,
          });
        }
        if (discovery !== null && discovery.ok !== true) {
          return Response.json(
            {
              ok: false,
              code: discovery.code ?? 'WEBRTC_PROVIDER_UNAVAILABLE',
              detail: discovery.detail ?? 'the provider probe failed',
              provider: {
                ok: false,
                source: discovery.source ?? null,
                checked: discovery.checked ?? null,
              },
              stages,
            },
            { status: 502, headers: { 'cache-control': 'no-store' } },
          );
        }
        const overrides = discovery?.ok === true && discovery.source === 'auto'
          ? {
              provider_command: discovery.provider_command,
              provider_args: discovery.provider_args,
              provider_cwd: discovery.provider_cwd,
            }
          : {};
        let result;
        try {
          result = await service.start(overrides);
        } catch (error) {
          result = {
            ok: false,
            code: 'WEBRTC_REPAIR_FAILED',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        let after = null;
        try { after = service.status(); } catch { /* status is best-effort */ }
        const ok = result?.ok === true && after?.pool?.ready === true;
        const payload = {
          ...result,
          ok,
          pool: after?.pool ?? null,
          status: after,
          provider: discovery === null
            ? null
            : {
                ok: discovery.ok === true,
                source: discovery.source ?? null,
                provider_cwd: discovery.provider_cwd ?? null,
                checked: discovery.checked ?? null,
              },
          stages,
        };
        if (!ok && typeof payload.code !== 'string') {
          payload.code = 'WEBRTC_REPAIR_FAILED';
          if (payload.detail === undefined || payload.detail === null) {
            payload.detail = 'the repair call did not publish a ready shared pool';
          }
        }
        stages.push({
          name: 'pool',
          ok,
          code: ok ? null : (payload.code ?? null),
          detail: ok ? 'pool ready' : (payload.detail ?? null),
        });
        return Response.json(payload, {
          status: ok ? 200 : 502,
          headers: { 'cache-control': 'no-store' },
        });
      },
    });
  });
  return true;
}

/**
 * Mount the subplugin.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] row configuration
 * @param {{defineTool?: Function, loadDefineTool?: Function, env?: Record<string,string|undefined>,
 *   dshHome?: string, providerFactory?: Function, signalingFactory?: Function, deviceKey?: object}} [deps]
 * @returns {Promise<Function>} a disposer carrying the mount report (Cordis treats a function return
 *   as the effect; a bare object is "Invalid effect", the failure `backup-plugin.mjs` documented).
 */
export async function apply(ctx, config = {}, deps = {}) {
  const cfg = normalizePluginConfig(config, deps);
  const service = new P2PWebRtcService(cfg, deps);
  ctx.logger?.info?.(
    `${name}: configured; mode=${cfg.mode} signalUrl=${cfg.signal_url || '<unset>'} room=${cfg.room} role=${cfg.role || '<unset>'} ` +
      `provider=${cfg.provider_command || '<unset>'}`,
  );
  let disposed = false;
  ctx.effect?.(() => () => {
    disposed = true;
    // Pool mode closes only its configured peer. The pool itself is the process-wide provider for
    // desktop / Teams / P2P V2, so a pane unmount must not tear it down.
    void service.dispose();
  });
  registerP2pWebRtcRepairRoute(ctx, service);

  const defineTool =
    typeof deps.defineTool === 'function'
      ? deps.defineTool
      : (await (deps.loadDefineTool ?? loadDefineTool)()).defineTool;
  const registered = [];
  const install = (child) => {
    if (
      child === null ||
      typeof child !== 'object' ||
      child.tools === undefined ||
      typeof child.tools.register !== 'function'
    ) {
      ctx.logger?.warn?.(`${name}: the host provided no tools service; the WebRTC tools are not registered`);
      return;
    }
    for (const definition of buildTools({ service, defineTool })) {
      child.tools.register(definition);
      registered.push(definition.name);
    }
    ctx.logger?.info?.(`${name}: registered ${registered.length} tool(s)`);
  };
  if (typeof ctx.inject === 'function') ctx.inject(['tools'], install);
  else install(ctx);

  if (cfg.auto_start) {
    // Explicitly opt-in, but awaited in pool mode: the production profile needs the pool published
    // before the desktop row's first `/start`. A named build refusal is logged and the mount still
    // succeeds, so a missing provider or an owner conflict cannot take the whole row down.
    const result = await service.start();
    if (result.ok !== true) {
      ctx.logger?.warn?.(`${name}: autoStart failed: ${result.code ?? 'UNKNOWN'}: ${result.detail ?? 'no detail'}`);
    } else {
      ctx.logger?.info?.(
        `${name}: autoStart ${cfg.mode === 'pool' ? 'published/borrowed the shared pool' : 'started the transport'}` +
          (result.pool?.owner ? ` (pool owner=${result.pool.owner})` : ''),
      );
    }
  }

  const dispose = () => {
    disposed = true;
    void service.dispose();
  };
  for (const [key, value] of Object.entries({
    ok: true,
    mounted: true,
    registered,
    disposed: () => disposed,
    service,
    config: describeConfig(cfg),
  })) {
    dispose[key] = value;
  }
  Object.defineProperty(dispose, 'name', { value: name, configurable: true });
  return dispose;
}
