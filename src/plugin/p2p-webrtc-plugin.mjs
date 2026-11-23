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
 * The tool surface is intentionally small: status, start, stop, probe. Dispatch integration is a
 * separate step because `deliver.mjs` currently constructs the UDP node directly; wiring a second
 * transport into that path without a scheduler-level decision would create two live data planes and
 * an ambiguous fallback. This row proves the transport itself, not a half-integrated dispatcher.
 *
 * ## Why `apply()` does not spawn anything
 *
 * A mounted-but-disabled row must be inert. `apply()` normalizes configuration and registers tools;
 * `p2p_webrtc_start` is the only place that spawns an engine or opens a signaling socket. That
 * matches `desktop.mjs`'s rule: mount-time has no disk/process side effects.
 */

import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { createWebRtcTransport, WEBRTC_TRANSPORT_CODE } from '../agent/webrtc/transport.mjs';
import { describeIceServers, normalizeIceServers } from '../agent/webrtc/path.mjs';
import { redactSignalingUrl } from '../agent/webrtc/signaling.mjs';
import { loadDefineTool } from './tools/shared.mjs';

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

/** Route prefix, reserved for a later panel surface; no route is mounted in this version. */
export const P2P_WEBRTC_ROUTE_PREFIX = '/api/w2m/p2p-webrtc';

/** The patch row id. */
export const P2P_WEBRTC_ROW_ID = 'dsh-p2p-webrtc';

/** Default state directory, matching the agent's `xclient` home. */
function defaultDshHome(env) {
  const value = env?.DSH_HOME ?? process.env.DSH_HOME;
  return typeof value === 'string' && value !== '' ? value : join(homedir(), '.dsh');
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
  const peerKeys = new Map();
  if (config.peerKeys instanceof Map) {
    for (const [key, value] of config.peerKeys)
      if (typeof value === 'string') peerKeys.set(String(key), value);
  } else if (isRecord(config.peerKeys)) {
    for (const [key, value] of Object.entries(config.peerKeys))
      if (typeof value === 'string') peerKeys.set(key, value);
  }
  return {
    dsh_home: dshHome,
    signal_url: typeof config.signalUrl === 'string' ? config.signalUrl : '',
    signal_token: typeof config.signalToken === 'string' ? config.signalToken : '',
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
  };
}

/**
 * A redacted view of the configuration for `p2p_webrtc_status`.
 * @param {object} cfg
 * @returns {object}
 */
export function describeConfig(cfg) {
  return {
    signal_url: cfg.signal_url === '' ? '' : redactSignalingUrl(cfg.signal_url),
    signal_token: cfg.signal_token === '' ? null : '<redacted>',
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
 * Lifecycle owner for one transport instance.
 *
 * It creates a transport lazily and refuses a second `start` while one is ready; `stop` is
 * idempotent. The object is deliberately not an EventEmitter: the tools read snapshots, and a
 * status tool that pushed events would be a second surface to keep in sync.
 */
export class P2PWebRtcService {
  /**
   * @param {object} cfg
   * @param {{deviceKey?: object, providerFactory?: Function|null, signalingFactory?: Function|null}} [deps]
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.deps = deps;
    this.transport = null;
    this.lastStart = null;
    this.lastStop = null;
    this.createdAt = null;
  }

  /** @returns {object} Transport options derived from config plus per-start overrides. */
  #options(overrides = {}) {
    const cfg = {
      ...this.cfg,
      ...overrides,
    };
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
      iceServers: cfg.ice_servers,
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

  /**
   * Start the transport. A second call while ready returns the existing diagnostics; it does not
   * spawn a second engine.
   *
   * @param {object} [overrides]
   * @returns {Promise<object>}
   */
  async start(overrides = {}) {
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

  /** Stop and forget the transport. Idempotent. */
  async stop() {
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

  /** @returns {object} */
  status() {
    const diagnostics = this.transport?.diagnostics() ?? null;
    return {
      plugin: name,
      config: describeConfig(this.cfg),
      state: diagnostics?.state ?? 'idle',
      transport: diagnostics,
      last_start: this.lastStart,
      last_stop: this.lastStop,
      created_at: this.createdAt,
      tools: [...TOOL_NAMES],
    };
  }

  /** @returns {Promise<object>} */
  async probe(timeoutMs = 5_000) {
    if (this.transport === null) {
      return { ok: false, code: WEBRTC_TRANSPORT_CODE.NOT_READY, detail: 'transport has not been started' };
    }
    return this.transport.probe(timeoutMs);
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
      'Show the P2P WebRTC subplugin configuration and the live transport state: signaling room, selected ICE pair, direct/relay/fallback verdict, Noise state and provider status. Read-only and safe to call before starting.',
    parameters: {},
    output: textOutput,
    async execute() {
      return jsonText(service.status());
    },
  });

  register({
    name: 'p2p_webrtc_start',
    description:
      'Start the opt-in WebRTC DataChannel transport. Requires an external WebRTC engine (providerCommand) because the package has no runtime dependencies. The client needs peerPublicKey; the host needs a peerKeys map. confirm:"start" is required because this spawns a process and opens a signaling socket.',
    parameters: {
      confirm: {
        type: 'string',
        required: true,
        description: 'Literal "start". Refuses before spawning anything when it does not match.',
      },
      signalUrl: { type: 'string', description: 'Override the configured ws:// or wss:// signaling URL.' },
      room: { type: 'string', description: 'Override the signaling room (default w2m).' },
      role: { type: 'string', description: 'Override the role: host or client.' },
      peerMachineId: { type: 'string', description: 'Override the other machine id.' },
      peerPublicKey: { type: 'string', description: 'Override the pinned peer static public key (client).' },
      providerCommand: { type: 'string', description: 'Override the WebRTC engine executable or script.' },
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
      'Stop the WebRTC transport, close the signaling socket and terminate the engine process. Idempotent.',
    parameters: {},
    output: textOutput,
    async execute() {
      return jsonText(await service.stop());
    },
  });

  register({
    name: 'p2p_webrtc_probe',
    description:
      'Send an authenticated Noise PING through the live DataChannel and measure RTT; refreshes the selected ICE pair statistics. Read-only with respect to application data.',
    parameters: {
      timeoutMs: { type: 'number', description: 'Probe timeout in milliseconds (default 5000).' },
    },
    output: textOutput,
    async execute(args = {}) {
      const timeout =
        Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0
          ? Number(args.timeoutMs)
          : 5_000;
      return jsonText(await service.probe(timeout));
    },
  });

  return registered;
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
    `${name}: configured; signalUrl=${cfg.signal_url || '<unset>'} room=${cfg.room} role=${cfg.role || '<unset>'} ` +
      `provider=${cfg.provider_command || '<unset>'}`,
  );
  let disposed = false;
  ctx.effect?.(() => () => {
    disposed = true;
    void service.stop();
  });

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
    // Explicitly opt-in. The row ships disabled, and an enabled row with autoStart still states the
    // intent in configuration; this is not a mount-time surprise for a status-only mount.
    void service.start().then((result) => {
      if (result.ok !== true)
        ctx.logger?.warn?.(`${name}: autoStart failed: ${result.code}: ${result.detail}`);
    });
  }

  const dispose = () => {
    disposed = true;
    void service.stop();
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
