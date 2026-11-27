/**
 * Teams service: a read-only product face over state that already exists.
 *
 * The five collaboration primitives (`w2m_joint_plan`, `w2m_joint_status`, `w2m_run`,
 * `w2m_council`, `w2m_tasks`) and the human dispatch gate (`w2m-joint`) are not reimplemented here.
 * What was missing was one place that answers "who is on this team, which shared room are we in,
 * and which transport carries what" without making a model re-derive it from five tool outputs.
 *
 * Everything in this service is a read. It creates no project, signs no approval and dispatches
 * nothing: those remain operator acts behind `w2m-joint` and the settings page, the decision-2
 * boundary the joint tools already document.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceFilePath } from '../../agent/identity.mjs';
import { listPlans } from '../joint-dev/plan-store.mjs';
import { request } from '../tools/shared.mjs';
import {
  TEAM_CONTROL_CHANNEL,
  TEAM_DATA_CHANNEL,
  TEAM_DATA_MAX_ATTEMPTS,
  normalizeTeamTransportPolicy,
} from './transport-policy.mjs';
import { TEAM_PRESENCE_DEFAULT_STALE_MS, presenceFromDevices } from './presence.mjs';
import { TeamsDataPlane } from './data-plane.mjs';

/** The relay's default room; every paired machine can read it. */
export const TEAMS_DEFAULT_PROJECT_ID = 'default';

/** Error codes the Teams surface returns, kept stable for callers. */
export const TEAMS_CODE = Object.freeze({
  RELAY_REQUIRED: 'TEAM_RELAY_REQUIRED',
  RELAY_UNREACHABLE: 'TEAM_RELAY_UNREACHABLE',
  RELAY_ABORTED: 'TEAM_RELAY_ABORTED',
  RELAY_HTTP_ERROR: 'TEAM_RELAY_HTTP_ERROR',
  DEVICE_TOKEN_REQUIRED: 'TEAM_DEVICE_TOKEN_REQUIRED',
  ROOM_ACTION_INVALID: 'TEAM_ROOM_ACTION_INVALID',
  PROJECT_ID_REQUIRED: 'TEAM_PROJECT_ID_REQUIRED',
  PROJECT_ID_INVALID: 'TEAM_PROJECT_ID_INVALID',
  SINCE_SEQ_INVALID: 'TEAM_SINCE_SEQ_INVALID',
});

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeTeamProjectId(value, fallback = TEAMS_DEFAULT_PROJECT_ID) {
  const text = nonEmptyString(value) ?? fallback;
  return PROJECT_ID_RE.test(text) ? text : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function boundedStaleAfterMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1_000) return TEAM_PRESENCE_DEFAULT_STALE_MS;
  return Math.min(24 * 60 * 60 * 1_000, Math.round(number));
}

/**
 * Render a relay URL without userinfo, query or fragment. The host is a routing fact; a password
 * embedded in a URL is not something a diagnostic surface should echo.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeTeamRelayUrl(value) {
  const text = nonEmptyString(value);
  if (text === null) return null;
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * The read-only Teams API.
 */
export class TeamsService {
  /**
   * @param {object} config normalized by `normalizeTeamsConfig`
   * @param {{requestImpl?: Function, env?: Record<string,string|undefined>, now?: () => number,
   *   listPlansImpl?: Function, deviceToken?: string, device?: object}} [deps]
   */
  constructor(config = {}, deps = {}) {
    this.config = config;
    this.env = deps.env ?? process.env;
    this.requestImpl = typeof deps.requestImpl === 'function' ? deps.requestImpl : request;
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    this.listPlansImpl = typeof deps.listPlansImpl === 'function' ? deps.listPlansImpl : listPlans;
    this.injectedToken = nonEmptyString(deps.deviceToken);
    this.injectedDevice = isRecord(deps.device) ? deps.device : null;
    this._device = undefined;
    this.getPool = typeof deps.getWebRtcPool === 'function' ? deps.getWebRtcPool : null;
    this.onDataPlaneAlert = deps.onDataPlaneAlert ?? null;
    this.dataPlane =
      deps.dataPlane ??
      (deps.webrtcPool !== null && typeof deps.webrtcPool === 'object'
        ? new TeamsDataPlane({
            pool: deps.webrtcPool,
            stateDir: nonEmptyString(config.state_dir) ?? undefined,
            onAlert: deps.onDataPlaneAlert,
            dataRetryDelayMs: config.data_retry_delay_ms,
            dataMaxAttempts: config.data_max_attempts,
          })
        : null);
    this._lazyDataPlane = null;
    this.policy = normalizeTeamTransportPolicy(config);
  }

  /**
   * `device.json` is a local identity file, not a secret to be echoed. Read it lazily so a
   * status-only mount performs no I/O until a tool is actually called.
   *
   * @returns {Record<string, any>}
   */
  device() {
    if (this.injectedDevice !== null) return this.injectedDevice;
    if (this._device !== undefined) return this._device;
    const configuredFile = nonEmptyString(this.config.device_file);
    const configuredDir = nonEmptyString(this.config.state_dir);
    let path = configuredFile;
    if (path === null && configuredDir !== null) {
      path = deviceFilePath({ env: this.env, dir: join(configuredDir, 'xclient') });
    }
    if (path === null) path = deviceFilePath({ env: this.env });
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      this._device = isRecord(parsed) ? parsed : {};
    } catch {
      this._device = {};
    }
    return this._device;
  }

  /**
   * @returns {string|null}
   */
  deviceToken() {
    if (this.injectedToken !== null) return this.injectedToken;
    return nonEmptyString(this.device().device_token);
  }

  /**
   * An explicit relay beats the environment beats the device's own pairing record. There is no
   * shared-server fallback here: a Teams room pointed at a relay the operator did not choose is
   * the cross-network mistake `w2m_status` exists to expose.
   *
   * @returns {string|null}
   */
  relayUrl() {
    return (
      safeTeamRelayUrl(this.config.rabbit_url) ??
      safeTeamRelayUrl(this.env.W2M_RABBIT_URL) ??
      safeTeamRelayUrl(this.device().rabbit_url)
    );
  }

  /**
   * @returns {object}
   */
  relayState() {
    const url = this.relayUrl();
    return {
      configured: url !== null,
      url,
      token_present: this.deviceToken() !== null,
      machine_id: nonEmptyString(this.device().machine_id),
      machine_name: nonEmptyString(this.device().machine_name),
      rabbit_url_source:
        nonEmptyString(this.config.rabbit_url) !== null
          ? 'config'
          : nonEmptyString(this.env.W2M_RABBIT_URL) !== null
            ? 'env'
            : url !== null
              ? 'device'
              : null,
    };
  }

  /**
   * One GET over the control plane. No P2P attempt is made, which is the policy: control is relay
   * TCP, always.
   *
   * @param {string} pathname
   * @param {{query?: object, signal?: AbortSignal}} [options]
   * @returns {Promise<{ok: boolean, status?: number, data?: any, code?: string, detail?: any}>}
   */
  async relayGet(pathname, options = {}) {
    const url = this.relayUrl();
    if (url === null) return { ok: false, code: TEAMS_CODE.RELAY_REQUIRED };
    const token = this.deviceToken();
    if (token === null) return { ok: false, code: TEAMS_CODE.DEVICE_TOKEN_REQUIRED };
    try {
      const response = await this.requestImpl({
        rabbitUrl: url,
        token,
        pathname,
        method: 'GET',
        query: options.query ?? {},
        signal: options.signal,
      });
      if (response?.ok !== true) {
        return {
          ok: false,
          status: response?.status ?? null,
          code: response?.error?.code ?? TEAMS_CODE.RELAY_HTTP_ERROR,
          detail: response?.error
            ? { message: response.error.message ?? null, ...(response.error.detail ?? {}) }
            : null,
        };
      }
      return { ok: true, status: response.status ?? 200, data: response.json ?? null };
    } catch (error) {
      return {
        ok: false,
        code: error?.code === 'W2M_ABORTED' ? TEAMS_CODE.RELAY_ABORTED : TEAMS_CODE.RELAY_UNREACHABLE,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * @param {{signal?: AbortSignal, staleAfterMs?: number}} [options]
   * @returns {Promise<object>}
   */
  async status(options = {}) {
    const relay = this.relayState();
    const staleAfterMs = boundedStaleAfterMs(options.staleAfterMs ?? this.config.stale_after_ms);

    const [devicesRead, projectsRead] = await Promise.all([
      relay.configured && relay.token_present
        ? this.relayGet('/v1/devices', { signal: options.signal })
        : Promise.resolve({
            ok: false,
            code: relay.configured ? TEAMS_CODE.DEVICE_TOKEN_REQUIRED : TEAMS_CODE.RELAY_REQUIRED,
          }),
      relay.configured && relay.token_present
        ? this.relayGet('/v1/projects', { signal: options.signal })
        : Promise.resolve({
            ok: false,
            code: relay.configured ? TEAMS_CODE.DEVICE_TOKEN_REQUIRED : TEAMS_CODE.RELAY_REQUIRED,
          }),
    ]);

    const devices =
      devicesRead.ok === true && Array.isArray(devicesRead.data?.devices) ? devicesRead.data.devices : [];
    const roster = presenceFromDevices(devices, { now: this.now(), staleAfterMs });
    const projects =
      projectsRead.ok === true && Array.isArray(projectsRead.data?.projects)
        ? projectsRead.data.projects.map((project) => ({
            project_id: project?.project_id ?? null,
            name: project?.name ?? null,
            origin: project?.origin ?? null,
          }))
        : [];

    const plans = this.localPlans();
    const notes = [];
    if (!relay.configured)
      notes.push(
        'no relay is configured; set rabbitUrl or W2M_RABBIT_URL to see the roster and shared rooms',
      );
    if (relay.configured && !relay.token_present)
      notes.push('this machine is not paired, so the roster and shared rooms are unavailable');
    if (devicesRead.ok !== true) notes.push(`roster unavailable: ${devicesRead.code}`);
    if (projectsRead.ok !== true) notes.push(`projects unavailable: ${projectsRead.code}`);

    return {
      ok: true,
      generated_at: new Date(this.now()).toISOString(),
      transport: {
        control: {
          channel: TEAM_CONTROL_CHANNEL,
          max_attempts: 1,
          carries: [
            'heartbeat',
            'presence',
            'user_info',
            'roster',
            'plan',
            'approval',
            'lease',
            'task_control',
            'council',
            'room_event',
          ],
          note: 'low-volume, high-reliability: relay TCP only, never attempted over P2P',
        },
        data: {
          channel: TEAM_DATA_CHANNEL,
          transport: 'webrtc-v1',
          max_attempts: TEAM_DATA_MAX_ATTEMPTS,
          retry_delay_ms: this.policy.data_retry_delay_ms,
          carries: ['file', 'image', 'artifact', 'blob', 'data_sync'],
          on_exhausted: 'abandon after 33 failed attempts and raise an alert; never fall back to the relay',
          data_plane: this._dataPlane()?.status() ?? {
            channel: TEAM_DATA_CHANNEL,
            transport: 'webrtc-v1',
            max_attempts: TEAM_DATA_MAX_ATTEMPTS,
            available: false,
            pool: null,
            notes: ['no WebRTC pool is attached to this Teams mount; bulk sends return TEAM_DATA_POOL_REQUIRED'],
          },
        },
      },
      relay: {
        ...relay,
        devices: {
          ok: devicesRead.ok === true,
          count: devices.length,
          code: devicesRead.ok === true ? null : devicesRead.code,
        },
        projects: {
          ok: projectsRead.ok === true,
          count: projects.length,
          code: projectsRead.ok === true ? null : projectsRead.code,
        },
      },
      roster,
      projects: {
        ok: projectsRead.ok === true,
        count: projects.length,
        projects,
      },
      joint: {
        ok: plans.ok,
        state_dir: nonEmptyString(this.config.state_dir),
        total: plans.total,
        plans: plans.plans,
        latest_plan_sha256: plans.plans[0]?.plan_sha256 ?? null,
      },
      surface: {
        joint_plan: 'w2m_joint_plan',
        joint_status: 'w2m_joint_status',
        run: 'w2m_run',
        council: 'w2m_council',
        tasks: 'w2m_tasks',
        team_status: 'w2m_team_status',
        team_room: 'w2m_team_room',
        run_modes: ['replicate', 'split', 'pipeline', 'broadcast'],
      },
      dispatch_gate: {
        human_command: 'w2m-joint dispatch',
        requirements: [
          'Ed25519 operator approval',
          'explicit target_machines',
          '409 TASK_EXISTS read-back',
          'dead-lease refusal',
        ],
        model_may_approve: false,
        model_may_dispatch: false,
      },
      notes,
    };
  }

  /**
   * Resolve the data plane lazily. The main plugin may build its shared pool after this row mounts,
   * so a captured `null` at construction time must not disable the Teams data plane for the whole
   * process.
   *
   * @returns {TeamsDataPlane|null}
   */
  _dataPlane() {
    if (this.dataPlane !== null) return this.dataPlane;
    if (this._lazyDataPlane !== null || this.getPool === null) return this._lazyDataPlane;
    const pool = this.getPool();
    if (pool === null || typeof pool !== 'object' || typeof pool.send !== 'function') return null;
    this._lazyDataPlane = new TeamsDataPlane({
      pool,
      stateDir: nonEmptyString(this.config.state_dir) ?? undefined,
      onAlert: this.onDataPlaneAlert,
      dataRetryDelayMs: this.config.data_retry_delay_ms,
      dataMaxAttempts: this.config.data_max_attempts,
    });
    return this._lazyDataPlane;
  }

  /**
   * Send artifact bytes over the Teams data plane. This is the only write on this service, and it
   * is deliberately on the bulk path: a failed transfer returns TEAM_DATA_P2P_EXHAUSTED with an
   * alert and is not retried over the relay.
   *
   * @param {{peer: string, bytes: Buffer|string, taskId?: string, kind?: string, name?: string}} input
   * @returns {Promise<object>}
   */
  async sendArtifact(input = {}) {
    const plane = this._dataPlane();
    if (plane === null) {
      return { ok: false, code: 'TEAM_DATA_POOL_REQUIRED', transport: 'webrtc-v1' };
    }
    return plane.sendArtifact(input);
  }

  /**
   * @returns {{ok: boolean, plans: object[], total: number}}
   */
  localPlans() {
    const stateDir = nonEmptyString(this.config.state_dir);
    if (stateDir === null) return { ok: false, plans: [], total: 0 };
    try {
      const listed = this.listPlansImpl({ stateDir, limit: 20 });
      if (listed?.ok !== true || !Array.isArray(listed.plans)) {
        return { ok: false, plans: [], total: 0 };
      }
      return {
        ok: true,
        total: Number.isFinite(listed.total) ? listed.total : listed.plans.length,
        plans: listed.plans.map((plan) => ({
          plan_sha256: plan.plan_sha256 ?? null,
          saved_at: Number.isFinite(plan.saved_at_ms) ? new Date(plan.saved_at_ms).toISOString() : null,
        })),
      };
    } catch {
      return { ok: false, plans: [], total: 0 };
    }
  }

  /**
   * Read a shared project room. `list` needs no project id; `get` and `events` do.
   *
   * @param {{action?: string, project_id?: string, since_seq?: number, signal?: AbortSignal}} [input]
   * @returns {Promise<object>}
   */
  async room(input = {}) {
    const action = nonEmptyString(input?.action) ?? 'list';
    if (!['list', 'get', 'events'].includes(action)) {
      return { ok: false, code: TEAMS_CODE.ROOM_ACTION_INVALID, detail: { action } };
    }
    if (action === 'list') {
      const read = await this.relayGet('/v1/projects', { signal: input.signal });
      if (read.ok !== true) return { ok: false, ...stripRead(read) };
      return {
        ok: true,
        action,
        relay_time: read.data?.rabbit_time ?? null,
        projects: Array.isArray(read.data?.projects) ? read.data.projects : [],
      };
    }
    if (typeof input?.project_id !== 'string' || input.project_id.trim() === '') {
      return {
        ok: false,
        code: TEAMS_CODE.PROJECT_ID_REQUIRED,
        detail: { project_id: input?.project_id ?? null },
      };
    }
    const projectId = normalizeTeamProjectId(input.project_id);
    if (projectId === null) {
      return {
        ok: false,
        code: TEAMS_CODE.PROJECT_ID_INVALID,
        detail: { project_id: input.project_id },
      };
    }
    if (action === 'get') {
      const read = await this.relayGet(`/v1/projects/${encodeURIComponent(projectId)}`, {
        signal: input.signal,
      });
      if (read.ok !== true) return { ok: false, ...stripRead(read) };
      return {
        ok: true,
        action,
        project: read.data?.project ?? null,
        members: Array.isArray(read.data?.members) ? read.data.members : [],
        last_event_seq: Number.isFinite(read.data?.last_event_seq) ? read.data.last_event_seq : null,
        relay_time: read.data?.rabbit_time ?? null,
      };
    }
    const rawSince = input?.since_seq;
    if (rawSince !== undefined && (!Number.isInteger(Number(rawSince)) || Number(rawSince) < 0)) {
      return { ok: false, code: TEAMS_CODE.SINCE_SEQ_INVALID, detail: { since_seq: rawSince ?? null } };
    }
    const sinceSeq = rawSince === undefined ? 0 : Number(rawSince);
    const read = await this.relayGet(`/v1/projects/${encodeURIComponent(projectId)}/events`, {
      query: { since_seq: sinceSeq },
      signal: input.signal,
    });
    if (read.ok !== true) return { ok: false, ...stripRead(read) };
    return {
      ok: true,
      action,
      project_id: projectId,
      since_seq: sinceSeq,
      events: Array.isArray(read.data?.events) ? read.data.events : [],
      next_seq: Number.isFinite(read.data?.next_seq) ? read.data.next_seq : null,
      latest_seq: Number.isFinite(read.data?.latest_seq) ? read.data.latest_seq : null,
      oldest_available_seq: Number.isFinite(read.data?.oldest_available_seq)
        ? read.data.oldest_available_seq
        : null,
      truncated: read.data?.truncated === true,
      remaining: Number.isFinite(read.data?.remaining) ? read.data.remaining : null,
      relay_time: read.data?.rabbit_time ?? null,
    };
  }
}

/**
 * Drop fields that are internal to `relayGet` from a public error result. The detail may contain a
 * relay message, never a token.
 *
 * @param {object} read
 * @returns {object}
 */
function stripRead(read) {
  return {
    ...(read.status !== undefined ? { status: read.status } : {}),
    ...(read.code !== undefined ? { code: read.code } : {}),
    ...(read.detail !== undefined ? { detail: read.detail } : {}),
  };
}
