/**
 * `dsh-p2p-v2`: the file-distribution plane on top of the V1 WebRTC transport.
 *
 * The row is deliberately inert at mount: no engine import, no file hash, no socket. `share` and
 * `add` are the only operations that create a WebTorrent client; `attach` is the only operation
 * that opens a V1 pair.
 *
 * WebTorrent is an optional engine by policy: the package keeps `dependencies === {}`. The
 * operator can point `webTorrentModule` at a separately installed entry file, or tests can inject
 * `webTorrentFactory`. A missing engine is a named status, not a broken mount.
 */

import { homedir, tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { getSharedWebRtcPool } from './webrtc-pool-registry.mjs';
import { loadDefineTool } from './tools/shared.mjs';
import { sensitiveMatch } from './path-policy.mjs';
import { P2PV2Service, P2P_V2_CODE } from '../agent/webtorrent/service.mjs';

/** The Cordis plugin name. */
export const name = 'w2m-dsh-p2p-v2';

/** The patch row id. */
export const P2P_V2_ROW_ID = 'dsh-p2p-v2';

/** No host service is required to register the tool surface. */
export const inject = [];

/** The seven tools this row owns. */
export const TOOL_NAMES = Object.freeze([
  'p2p_v2_status',
  'p2p_v2_peers',
  'p2p_v2_share',
  'p2p_v2_add',
  'p2p_v2_attach',
  'p2p_v2_detach',
  'p2p_v2_stop',
]);

/** Default state directory, kept for a future metadata cache; the engine uses no state today. */
function defaultDshHome(env) {
  const value = env?.DSH_HOME ?? process.env.DSH_HOME;
  return typeof value === 'string' && value !== '' ? value : join(homedir(), '.dsh');
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry !== '') : [];
}

/**
 * Normalize the row config into the service's flat shape.
 *
 * @param {Record<string, any>} [config]
 * @param {{env?: Record<string,string|undefined>, dshHome?: string, projectDir?: string,
 *   webTorrentFactory?: Function|null, getPool?: () => object|null}} [deps]
 * @returns {object}
 */
export function normalizePluginConfig(config = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const dshHome =
    typeof deps.dshHome === 'string' && deps.dshHome !== '' ? resolvePath(deps.dshHome) : defaultDshHome(env);
  const stateDir =
    typeof config.stateDir === 'string' && config.stateDir !== ''
      ? resolvePath(config.stateDir)
      : join(dshHome, 'p2p-v2');
  const downloadRoot =
    typeof config.downloadRoot === 'string' && config.downloadRoot !== ''
      ? resolvePath(config.downloadRoot)
      : join(stateDir, 'downloads');
  const projectDir =
    typeof deps.projectDir === 'string' && deps.projectDir !== ''
      ? resolvePath(deps.projectDir)
      : typeof config.projectDir === 'string' && config.projectDir !== ''
        ? resolvePath(config.projectDir)
        : process.cwd();
  const allowedRoots = stringArray(config.allowedRoots).map((entry) => resolvePath(entry));
  // `default` keeps the historical convenience roots (home/tmp/project/download). `strict` is an
  // explicit opt-in that limits an otherwise-empty list to the project and download roots, so a
  // user can narrow the default without changing it for everyone.
  const allowedRootsMode = config.allowedRootsMode === 'strict' ? 'strict' : 'default';
  const rawTrackers = config.trackers ?? config.announce ?? [];
  const trackers = Array.isArray(rawTrackers)
    ? rawTrackers.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
    : [];
  return {
    dsh_home: dshHome,
    state_dir: stateDir,
    download_root: downloadRoot,
    project_dir: projectDir,
    allowed_roots: allowedRoots.length > 0
      ? allowedRoots
      : (allowedRootsMode === 'strict'
        ? [projectDir, downloadRoot].map((entry) => resolvePath(entry))
        : [homedir(), tmpdir(), projectDir, downloadRoot].map((entry) => resolvePath(entry))),
    allowed_roots_mode: allowedRoots.length > 0 ? 'explicit' : allowedRootsMode,
    web_torrent_module:
      typeof config.webTorrentModule === 'string' && config.webTorrentModule !== ''
        ? config.webTorrentModule
        : 'webtorrent',
    trackers,
    allow_native_trackers: config.allowNativeTrackers === true,
    max_shares: Number.isInteger(Number(config.maxShares)) && Number(config.maxShares) > 0 ? Number(config.maxShares) : 8,
    max_peers_per_share:
      Number.isInteger(Number(config.maxPeersPerShare)) && Number(config.maxPeersPerShare) > 0
        ? Number(config.maxPeersPerShare)
        : 16,
    max_conns: Number.isInteger(Number(config.maxConns)) && Number(config.maxConns) > 0 ? Number(config.maxConns) : 32,
    max_file_bytes:
      Number.isFinite(Number(config.maxFileBytes)) && Number(config.maxFileBytes) >= 1
        ? Number(config.maxFileBytes)
        : 10 * 1024 * 1024 * 1024,
    max_download_bytes:
      Number.isFinite(Number(config.maxDownloadBytes)) && Number(config.maxDownloadBytes) >= 1
        ? Number(config.maxDownloadBytes)
        : 10 * 1024 * 1024 * 1024,
    max_frames_per_second:
      Number.isFinite(Number(config.maxFramesPerSecond)) && Number(config.maxFramesPerSecond) >= 0
        ? Number(config.maxFramesPerSecond)
        : 2_048,
    max_buffered_bytes:
      Number.isFinite(Number(config.maxBufferedBytes)) && Number(config.maxBufferedBytes) >= 0
        ? Number(config.maxBufferedBytes)
        : 4 * 1024 * 1024,
    ready_timeout_ms:
      Number.isFinite(Number(config.readyTimeoutMs)) && Number(config.readyTimeoutMs) >= 1000
        ? Number(config.readyTimeoutMs)
        : 30_000,
    metadata_timeout_ms:
      Number.isFinite(Number(config.metadataTimeoutMs)) && Number(config.metadataTimeoutMs) >= 1000
        ? Number(config.metadataTimeoutMs)
        : 10_000,
    write_timeout_ms:
      Number.isFinite(Number(config.writeTimeoutMs)) && Number(config.writeTimeoutMs) >= 1000
        ? Number(config.writeTimeoutMs)
        : 15_000,
    web_torrent_factory: typeof deps.webTorrentFactory === 'function' ? deps.webTorrentFactory : null,
    get_pool: typeof deps.getPool === 'function' ? deps.getPool : getSharedWebRtcPool,
  };
}

/**
 * Redacted status view. No path is hidden here because the operator supplied it; module and state
 * paths are reported so a missing engine is diagnosable without reading the process environment.
 *
 * @param {object} cfg
 * @returns {object}
 */
export function describeConfig(cfg) {
  return {
    module: cfg.web_torrent_module,
    state_dir: cfg.state_dir,
    download_root: cfg.download_root,
    project_dir: cfg.project_dir,
    allowed_roots: cfg.allowed_roots,
    trackers: cfg.trackers,
    allow_native_trackers: cfg.allow_native_trackers,
    max_shares: cfg.max_shares,
    max_peers_per_share: cfg.max_peers_per_share,
    max_conns: cfg.max_conns,
    max_file_bytes: cfg.max_file_bytes,
    max_download_bytes: cfg.max_download_bytes,
    max_frames_per_second: cfg.max_frames_per_second,
    max_buffered_bytes: cfg.max_buffered_bytes,
    ready_timeout_ms: cfg.ready_timeout_ms,
    metadata_timeout_ms: cfg.metadata_timeout_ms,
    write_timeout_ms: cfg.write_timeout_ms,
  };
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/**
 * @param {unknown} path
 * @returns {{ok: true}|{ok: false, code: string, detail: string}}
 */
function guardPath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\u0000')) {
    return { ok: false, code: P2P_V2_CODE.SOURCE_INVALID, detail: 'path is required and must not contain NUL' };
  }
  const sensitive = sensitiveMatch(path);
  if (sensitive.hit) {
    return {
      ok: false,
      code: 'P2P_V2_SENSITIVE_PATH',
      detail: `refusing to expose a ${sensitive.reason} path (${sensitive.segment})`,
    };
  }
  return { ok: true };
}

function peersOf(args) {
  return stringArray(args?.peers);
}

function transportOf(args) {
  return typeof args?.transport === 'string' && args.transport.trim() !== '' ? args.transport.trim() : undefined;
}

/**
 * Build the seven tools once per mount.
 *
 * @param {{service: P2PV2Service, defineTool: Function}} input
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
    name: 'p2p_v2_status',
    description:
      'Show the P2P V2 file plane: whether WebTorrent is available, the active shares, per-peer V1 adapters, transfer progress and the shared WebRTC pool state. Read-only and safe before any engine load.',
    parameters: {},
    output: textOutput,
    async execute() {
      return jsonText(service.status());
    },
  });

  register({
    name: 'p2p_v2_peers',
    description:
      'List peers already connected in the shared WebRTC pool and each active share\'s attach state. Strictly read-only: it never dials, never opens a pair and never exposes the signal URL or token.',
    parameters: {
      shareId: { type: 'string', description: 'Optional share id; defaults to every active share.' },
      infoHash: { type: 'string', description: 'Optional torrent info hash used instead of shareId.' },
    },
    output: textOutput,
    async execute(args = {}) {
      const query = {};
      if (typeof args.shareId === 'string' && args.shareId !== '') query.share_id = args.shareId;
      if (typeof args.infoHash === 'string' && args.infoHash !== '') query.info_hash = args.infoHash;
      return jsonText(service.peers(query));
    },
  });

  register({
    name: 'p2p_v2_share',
    description:
      'Seed one file or directory with WebTorrent and optionally attach peers by machine id over a named transport. Requires the optional WebTorrent engine and confirm:"share". The magnet URI is returned for other machines to join; file pieces travel over the transport DataChannels, not relay.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute or project-relative file or directory to seed.' },
      name: { type: 'string', description: 'Optional torrent name (defaults to the file or directory name).' },
      peers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Machine ids to attach immediately. Each id opens or reuses one shared transport pair.',
      },
      transport: {
        type: 'string',
        description: 'Torrent transport name registered in this process; defaults to "webrtc-v1".',
      },
      confirm: {
        type: 'string',
        required: true,
        description: 'Literal "share". Refuses before hashing or loading the engine when it does not match.',
      },
    },
    output: textOutput,
    async execute(args = {}) {
      if (args.confirm !== 'share') {
        return jsonText({ ok: false, code: 'P2P_V2_CONFIRM_REQUIRED', detail: 'confirm must be the literal "share"' });
      }
      const guard = guardPath(args.path);
      if (guard.ok !== true) return jsonText(guard);
      return jsonText(
        await service.share({
          path: args.path,
          name: typeof args.name === 'string' ? args.name : '',
          peers: peersOf(args),
          transport: transportOf(args),
        }),
      );
    },
  });

  register({
    name: 'p2p_v2_add',
    description:
      'Join an existing WebTorrent swarm from a magnet URI and download into a directory, optionally attaching peers by machine id over a named transport. Requires confirm:"add" because it writes files. The peer must be attached before metadata can be fetched from a trackerless magnet.',
    parameters: {
      magnet: { type: 'string', required: true, description: 'Magnet URI returned by p2p_v2_share.' },
      path: {
        type: 'string',
        description:
          'Optional destination directory; defaults to <dshHome>/p2p-v2/downloads/<infoHash>. Created when absent, but only under the configured allowed roots.',
      },
      peers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Machine ids to attach immediately. The seed machine is usually one of them.',
      },
      transport: {
        type: 'string',
        description: 'Torrent transport name registered in this process; defaults to "webrtc-v1".',
      },
      confirm: {
        type: 'string',
        required: true,
        description: 'Literal "add". Refuses before creating the destination or loading the engine when it does not match.',
      },
    },
    output: textOutput,
    async execute(args = {}) {
      if (args.confirm !== 'add') {
        return jsonText({ ok: false, code: 'P2P_V2_CONFIRM_REQUIRED', detail: 'confirm must be the literal "add"' });
      }
      if (typeof args.magnet !== 'string' || args.magnet === '') {
        return jsonText({ ok: false, code: 'P2P_V2_MAGNET_REQUIRED', detail: 'magnet is required' });
      }
      if (typeof args.path === 'string' && args.path !== '') {
        const guard = guardPath(args.path);
        if (guard.ok !== true) return jsonText(guard);
      }
      return jsonText(
        await service.add({
          magnet: args.magnet,
          path: args.path,
          peers: peersOf(args),
          transport: transportOf(args),
        }),
      );
    },
  });

  register({
    name: 'p2p_v2_attach',
    description:
      'Attach one peer to one active share over a named transport. The peer is one logical torrent stream over the shared transport binding; this never closes the pair and never starts a relay data path. Idempotent per (share, machine).',
    parameters: {
      shareId: { type: 'string', description: 'Share id returned by share/add.' },
      infoHash: { type: 'string', description: 'Torrent info hash, when shareId is not known.' },
      machineId: { type: 'string', required: true, description: 'Target machine id to attach.' },
      transport: {
        type: 'string',
        description: 'Torrent transport name; defaults to the share transport, then "webrtc-v1".',
      },
    },
    output: textOutput,
    async execute(args = {}) {
      return jsonText(
        await service.attach({
          share_id: args.shareId,
          info_hash: args.infoHash,
          machine_id: args.machineId,
          transport: transportOf(args),
        }),
      );
    },
  });

  register({
    name: 'p2p_v2_detach',
    description:
      'Detach one logical torrent stream from a peer while leaving the shared V1 WebRTC pair open. Use this when a peer should stop participating in one share but must keep task dispatch and other shares reachable.',
    parameters: {
      shareId: { type: 'string', description: 'Share id returned by share/add.' },
      infoHash: { type: 'string', description: 'Torrent info hash, when shareId is not known.' },
      machineId: { type: 'string', required: true, description: 'Target machine id to detach.' },
    },
    output: textOutput,
    async execute(args = {}) {
      return jsonText(
        await service.detach({
          share_id: args.shareId,
          info_hash: args.infoHash,
          machine_id: args.machineId,
        }),
      );
    },
  });

  register({
    name: 'p2p_v2_stop',
    description:
      'Stop one share by shareId/infoHash, or stop every share and the WebTorrent engine when no identifier is given. Destroys torrents and logical peer adapters; never stops the shared WebRTC pool.',
    parameters: {
      shareId: { type: 'string', description: 'Share id to stop; omit to stop all shares.' },
      infoHash: { type: 'string', description: 'Torrent info hash to stop.' },
    },
    output: textOutput,
    async execute(args = {}) {
      if (typeof args.shareId === 'string' || typeof args.infoHash === 'string') {
        return jsonText(await service.stop({ share_id: args.shareId, info_hash: args.infoHash }));
      }
      return jsonText(await service.stopAll());
    },
  });

  return registered;
}

/**
 * Mount the row. No engine is loaded and no socket is opened until a tool operation asks for one.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config]
 * @param {{defineTool?: Function, loadDefineTool?: Function, env?: object, dshHome?: string,
 *   webTorrentFactory?: Function|null, getPool?: () => object|null}} [deps]
 * @returns {Promise<Function>}
 */
export async function apply(ctx, config = {}, deps = {}) {
  const cfg = normalizePluginConfig(config, deps);
  const service = new P2PV2Service(cfg, {
    getPool: cfg.get_pool,
    webTorrentFactory: cfg.web_torrent_factory,
    webTorrentModule: cfg.web_torrent_module,
  });
  ctx.logger?.info?.(
    `${name}: configured; module=${cfg.web_torrent_module || '<unset>'} ` +
      `trackers=${cfg.trackers.length} native=${cfg.allow_native_trackers}`,
  );
  let disposed = false;
  ctx.effect?.(() => () => {
    disposed = true;
    void service.stopAll();
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
      ctx.logger?.warn?.(`${name}: the host provided no tools service; the V2 tools are not registered`);
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

  const dispose = () => {
    disposed = true;
    void service.stopAll();
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
