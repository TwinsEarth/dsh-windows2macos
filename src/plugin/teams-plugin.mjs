/**
 * Teams sub-plugin: opt-in, read-mostly, and deliberately not in the dispatch path.
 *
 * The product promise is a shared room with a visible roster and one transport rule, not a new way
 * to command machines. Approval and dispatch stay in `w2m-joint` (operator CLI) and the settings
 * page; this plugin exposes two reads plus one data-plane send so a model can see the team and move artifact bytes without acquiring dispatch authority.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  TEAMS_DEFAULT_PROJECT_ID,
  TeamsService,
  normalizeTeamProjectId,
  safeTeamRelayUrl,
} from './teams/service.mjs';
import {
  TEAM_CONTROL_CHANNEL,
  TEAM_DATA_CHANNEL,
  TEAM_DATA_MAX_ATTEMPTS,
} from './teams/transport-policy.mjs';
import { getSharedWebRtcPool } from './webrtc-pool-registry.mjs';

const require = createRequire(import.meta.url);

/** Plugin row id in `cordis.patch.yml`. */
export const TEAMS_ROW_ID = 'dsh-teams';

/** Cordis plugin name. */
export const name = 'w2m-dsh-teams';

/** The Teams surface adds only reads; the five primitives remain in the main plugin. */
export const inject = [];

/** Stable tool names; asserted against the main plugin so a duplicate fails the tests. */
export const TOOL_NAMES = ['w2m_team_status', 'w2m_team_room', 'w2m_team_artifact'];

/** Default threshold for a heartbeat to be called stale. */
export const DEFAULT_STALE_AFTER_MS = 90_000;

const json = (value) => JSON.stringify(value, null, 2);

/**
 * @param {string} id
 * @returns {typeof import('../../lib/tool-kit.js').defineTool}
 */
function loadDefineTool() {
  return require('../../lib/tool-kit.js').defineTool;
}

/**
 * Normalize the row config. Accepts both camelCase (the yml style used by other rows) and
 * snake_case (the shape this service uses internally). No credential is invented: when nothing is
 * configured, the device's own `device.json` is used, exactly like every other tool.
 *
 * @param {object} [config]
 * @returns {object}
 */
export function normalizePluginConfig(config = {}) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const rabbitUrl =
    typeof raw.rabbitUrl === 'string' && raw.rabbitUrl.trim() !== ''
      ? raw.rabbitUrl.trim()
      : typeof raw.rabbit_url === 'string'
        ? raw.rabbit_url.trim()
        : '';
  const stateDir =
    typeof raw.stateDir === 'string' && raw.stateDir.trim() !== ''
      ? raw.stateDir.trim()
      : typeof raw.state_dir === 'string'
        ? raw.state_dir.trim()
        : '';
  const deviceFile =
    typeof raw.deviceFile === 'string' && raw.deviceFile.trim() !== ''
      ? raw.deviceFile.trim()
      : typeof raw.device_file === 'string'
        ? raw.device_file.trim()
        : '';
  const rawProject = raw.projectId ?? raw.project_id;
  const projectId = normalizeTeamProjectId(rawProject, TEAMS_DEFAULT_PROJECT_ID);
  const rawStale = Number(raw.staleAfterMs ?? raw.stale_after_ms);
  const staleAfterMs =
    Number.isFinite(rawStale) && rawStale >= 1_000
      ? Math.min(24 * 60 * 60 * 1_000, Math.round(rawStale))
      : DEFAULT_STALE_AFTER_MS;
  const rawDelay = Number(raw.dataRetryDelayMs ?? raw.data_retry_delay_ms);
  const dataRetryDelayMs =
    Number.isFinite(rawDelay) && rawDelay >= 0 ? Math.min(5_000, Math.round(rawDelay)) : 1_000;
  return {
    rabbit_url: rabbitUrl,
    state_dir: stateDir,
    device_file: deviceFile,
    project_id: projectId ?? TEAMS_DEFAULT_PROJECT_ID,
    project_id_input: rawProject ?? null,
    stale_after_ms: staleAfterMs,
    data_retry_delay_ms: dataRetryDelayMs,
    auto_start: raw.autoStart === true || raw.auto_start === true,
    tool_count: TOOL_NAMES.length,
  };
}

/**
 * A config description safe to log or return from a status tool. There is no token field here, and
 * there never will be one: the device token is read from disk at call time and never copied into
 * configuration.
 *
 * @param {object} config
 * @returns {object}
 */
export function describeConfig(config = {}) {
  return {
    row: TEAMS_ROW_ID,
    rabbit_url: safeTeamRelayUrl(config.rabbit_url),
    state_dir: config.state_dir || null,
    device_file: config.device_file || null,
    project_id: config.project_id,
    stale_after_ms: config.stale_after_ms,
    data_retry_delay_ms: config.data_retry_delay_ms,
    control_channel: TEAM_CONTROL_CHANNEL,
    data_channel: TEAM_DATA_CHANNEL,
    data_max_attempts: TEAM_DATA_MAX_ATTEMPTS,
    auto_start: config.auto_start === true,
    tools: [...TOOL_NAMES],
  };
}

/**
 * Build the two tool definitions without registering them. A test can mount a fake context and
 * inspect exactly what would be registered.
 *
 * @param {{service: TeamsService, defineTool: Function, output?: object}} args
 * @returns {object[]}
 */
export function buildTools({ service, defineTool, output } = {}) {
  if (service === null || typeof service !== 'object') throw new TypeError('TeamsService is required');
  if (typeof defineTool !== 'function') throw new TypeError('defineTool is required');
  const resultOutput = output ?? { type: 'json' };

  return [
    defineTool({
      name: 'w2m_team_status',
      description:
        'Report the Teams view: the two-plane transport policy (control over relay TCP, bulk data over ' +
        'WebRTC with 33 attempts and an alert on exhaustion), the pairing/relay state, the machine ' +
        'roster with online/stale presence and user info, the shared project rooms this machine can ' +
        'read, local joint-plan summaries, and an index of the existing collaboration tools. Read-only; ' +
        'it never approves or dispatches.',
      parameters: {
        stale_after_ms: {
          type: 'number',
          description:
            'optional presence threshold in milliseconds (default 90000); values below 1000 are clamped',
        },
      },
      output: resultOutput,
      async execute(args) {
        try {
          const report = await service.status({ staleAfterMs: args?.stale_after_ms });
          return json({ ...report, project_id: service.config?.project_id ?? TEAMS_DEFAULT_PROJECT_ID });
        } catch (error) {
          return json({
            ok: false,
            code: 'TEAM_STATUS_FAILED',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
      presentCall: () => ({ card: 'generic', title: 'w2m team status', kind: 'read', rawInput: {} }),
    }),
    defineTool({
      name: 'w2m_team_room',
      description:
        'Read a shared project room (read-only): action=list returns the rooms this machine belongs to; ' +
        'action=get returns one project and its members; action=events returns the incremental event ' +
        'stream after since_seq. Mutations and dispatch are refused by design: project creation and ' +
        'membership are operator acts, and `w2m-joint dispatch` is the human command.',
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'events'],
          description: 'list (default) | get | events',
        },
        project_id: {
          type: 'string',
          description: 'project id for get/events; defaults are not guessed, the caller must name it',
        },
        since_seq: {
          type: 'number',
          description: 'events: return events with seq strictly greater than this (default 0)',
        },
      },
      output: resultOutput,
      async execute(args) {
        try {
          const result = await service.room(args ?? {});
          return json(result);
        } catch (error) {
          return json({
            ok: false,
            code: 'TEAM_ROOM_FAILED',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
      presentCall: () => ({ card: 'generic', title: 'w2m team room', kind: 'read', rawInput: {} }),
    }),
    defineTool({
      name: 'w2m_team_artifact',
      description:
        'Send one artifact to a paired machine over the Teams data plane: WebRTC DataChannel on the ' +
        'shared pool, exactly 33 attempts, no relay fallback. On exhaustion it returns ' +
        'TEAM_DATA_P2P_EXHAUSTED with an alert. The receiver writes the verified bytes through its ' +
        'artifact sink. This moves bytes; it never approves or dispatches work.',
      parameters: {
        peer: { type: 'string', description: 'target machine_id from w2m_team_status' },
        path: { type: 'string', description: 'local file to send' },
        task_id: { type: 'string', description: 'optional task id for the receiving artifact sink' },
        kind: {
          type: 'string',
          enum: ['file', 'image', 'artifact', 'blob', 'data_sync'],
          description: 'bulk kind; default artifact',
        },
        name: { type: 'string', description: 'optional display name at the receiver' },
      },
      output: resultOutput,
      async execute(args) {
        try {
          if (typeof args?.peer !== 'string' || args.peer.trim() === '')
            return json({ ok: false, code: 'TEAM_DATA_PEER_REQUIRED', transport: 'webrtc-v1' });
          if (typeof args?.path !== 'string' || args.path.trim() === '')
            return json({ ok: false, code: 'TEAM_DATA_PATH_REQUIRED', transport: 'webrtc-v1' });
          let bytes = null;
          try {
            bytes = readFileSync(args.path);
          } catch (error) {
            return json({
              ok: false,
              code: 'TEAM_DATA_PATH_UNREADABLE',
              transport: 'webrtc-v1',
              detail: error instanceof Error ? error.message : String(error),
            });
          }
          return json(
            await service.sendArtifact({
              peer: args.peer.trim(),
              bytes,
              taskId: typeof args.task_id === 'string' ? args.task_id : undefined,
              kind: typeof args.kind === 'string' ? args.kind : 'artifact',
              name: typeof args.name === 'string' ? args.name : args.path,
            }),
          );
        } catch (error) {
          return json({
            ok: false,
            code: 'TEAM_DATA_SEND_FAILED',
            transport: 'webrtc-v1',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
      presentCall: () => ({ card: 'generic', title: 'w2m team artifact', kind: 'write', rawInput: {} }),
    }),
  ];
}

/**
 * Mount. Registers tools only; performs no network request and reads no `device.json` until a tool
 * is called, so a disabled row has no effect and a status-only mount cannot fail at startup.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] row configuration
 * @param {{defineTool?: Function, loadDefineTool?: Function, service?: TeamsService,
 *   requestImpl?: Function, env?: object, now?: () => number, deviceToken?: string,
 *   device?: object, listPlansImpl?: Function}} [deps]
 * @returns {Promise<Function>} disposer carrying the mount report
 */
export async function apply(ctx, config = {}, deps = {}) {
  const cfg = normalizePluginConfig(config);
  const service = deps.service instanceof TeamsService
    ? deps.service
    : new TeamsService(cfg, {
        ...deps,
        getWebRtcPool: deps.getWebRtcPool ?? getSharedWebRtcPool,
      });
  ctx?.logger?.info?.(
    `${name}: configured; relay=${safeTeamRelayUrl(cfg.rabbit_url) || 'device-or-env'} room=${cfg.project_id} ` +
      `control=${TEAM_CONTROL_CHANNEL} data=${TEAM_DATA_CHANNEL} max_attempts=${TEAM_DATA_MAX_ATTEMPTS}`,
  );

  let disposed = false;
  ctx?.effect?.(() => () => {
    disposed = true;
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
      ctx?.logger?.warn?.(`${name}: the host provided no tools service; the Teams tools are not registered`);
      return;
    }
    for (const definition of buildTools({ service, defineTool })) {
      child.tools.register(definition);
      registered.push(definition.name);
    }
    ctx?.logger?.info?.(`${name}: registered ${registered.length} tool(s)`);
  };
  if (typeof ctx?.inject === 'function') ctx.inject(['tools'], install);
  else install(ctx);

  const dispose = () => {
    disposed = true;
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
