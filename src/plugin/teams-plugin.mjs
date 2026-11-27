/**
 * Teams sub-plugin: opt-in, read-mostly, and deliberately not in the dispatch path.
 *
 * The product promise is a shared room with a visible roster and one transport rule, not a new way
 * to command machines. Approval and dispatch stay in `w2m-joint` (operator CLI) and the settings
 * page; this plugin exposes two reads plus one data-plane send so a model can see the team and move artifact bytes without acquiring dispatch authority.
 */

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
import { loadDefineTool } from './tools/shared.mjs';
import { createTeamsV2Service, TEAMS_V2_VERSION } from './teams/v2-service.mjs';

/** Plugin row id in `cordis.patch.yml`. */
export const TEAMS_ROW_ID = 'dsh-teams';

/** Cordis plugin name. */
export const name = 'w2m-dsh-teams';

/** The Teams surface adds only reads; the five primitives remain in the main plugin. */
export const inject = [];

/** Stable tool names; asserted against the main plugin so a duplicate fails the tests. */
export const TOOL_NAMES = [
  'w2m_team_status',
  'w2m_team_room',
  'w2m_team_artifact',
  'w2m_team_orchestrate',
  'w2m_team_verify',
  'w2m_team_cost',
  'w2m_team_evolve',
  'w2m_team_frameworks',
];

/** The original three read/data tools, kept for callers that mount without a V2 service. */
export const LEGACY_TOOL_NAMES = ['w2m_team_status', 'w2m_team_room', 'w2m_team_artifact'];

/** Default threshold for a heartbeat to be called stale. */
export const DEFAULT_STALE_AFTER_MS = 90_000;

const json = (value) => JSON.stringify(value, null, 2);

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
  const rawAttempts = Number(raw.dataMaxAttempts ?? raw.data_max_attempts);
  const dataMaxAttempts =
    Number.isFinite(rawAttempts) && rawAttempts >= 1
      ? Math.min(TEAM_DATA_MAX_ATTEMPTS, Math.round(rawAttempts))
      : TEAM_DATA_MAX_ATTEMPTS;
  return {
    rabbit_url: rabbitUrl,
    state_dir: stateDir,
    device_file: deviceFile,
    project_id: projectId ?? TEAMS_DEFAULT_PROJECT_ID,
    project_id_input: rawProject ?? null,
    stale_after_ms: staleAfterMs,
    data_retry_delay_ms: dataRetryDelayMs,
    data_max_attempts: dataMaxAttempts,
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
    data_max_attempts: config.data_max_attempts ?? TEAM_DATA_MAX_ATTEMPTS,
    auto_start: config.auto_start === true,
    teams_v2_version: TEAMS_V2_VERSION,
    tools: [...TOOL_NAMES],
  };
}

/**
 * The V2 tool surface: five local tools for orchestration, verification, cost, evolution and
 * framework choice. They never register with `w2m_run`, `w2m-joint` or the relay; `create` and
 * `step` only write a local JSON ledger.
 *
 * @param {{v2: object, defineTool: Function, output?: object}} args
 * @returns {object[]}
 */
function buildV2Tools({ v2, defineTool, output }) {
  const resultOutput = output ?? { type: 'json' };
  const statusJson = (result) => json(result);

  return [
    defineTool({
      name: 'w2m_team_orchestrate',
      description:
        'Create and edit a local Teams V2 task ledger. Actions: create, status, list, step, replan. ' +
        'A step may move pending→running, running→done|failed, and failed→running; done requires a passing, ' +
        'context-isolated verification and non-empty evidence (TEAM_V2_VERIFICATION_REQUIRED / ' +
        'TEAM_V2_CONTEXT_NOT_ISOLATED / TEAM_V2_EVIDENCE_REQUIRED). ' +
        'Replan adds/updates/removes pending steps with a reason and rejects completed/running edits. ' +
        'This is not a dispatcher: it does not approve, relay or execute anything.',
      parameters: {
        action: {
          type: 'string',
          enum: ['create', 'status', 'list', 'step', 'replan'],
          description: 'create (default) | status | list | step | replan',
        },
        plan_id: { type: 'string', description: 'plan id for status/step/replan' },
        goal: { type: 'string', description: 'create: the user-facing outcome this ledger serves' },
        steps: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'create: step objects with step_id/title/agent and optional depends_on, framework, acceptance, max_attempts',
        },
        framework: {
          type: 'string',
          enum: ['auto', 'builtin', 'langgraph', 'crewai', 'autogen'],
          description:
            'create: preferred framework; non-builtin adapters fall back to builtin and report the reason',
        },
        base_commit: { type: 'string', description: 'create: optional git commit the plan is anchored to' },
        step_id: { type: 'string', description: 'step: step id to transition' },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'done', 'failed', 'skipped'],
          description: 'step: target status; pending is never a write',
        },
        result: {
          type: 'object',
          additionalProperties: true,
          description: 'step done/failed: a bounded result summary and/or digest source',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'step done: non-empty evidence references; at least one is required',
        },
        verification: {
          type: 'object',
          additionalProperties: true,
          description:
            'step done: an isolated verification object with verdict=pass and optionally score/checks',
        },
        actor: { type: 'string', description: 'optional actor label recorded in the event ledger' },
        reason: { type: 'string', description: 'replan: required reason for changing a running ledger' },
        add: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'replan: steps to append',
        },
        update: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'replan: pending steps to replace fields on',
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'replan: pending step ids to remove; no dependent may remain',
        },
      },
      output: resultOutput,
      async execute(args = {}) {
        try {
          const action = typeof args.action === 'string' ? args.action.toLowerCase() : 'create';
          let result;
          if (action === 'create') result = v2.createPlan(args);
          else if (action === 'status') result = v2.planStatus(args.plan_id);
          else if (action === 'list') result = v2.listPlans();
          else if (action === 'step') result = v2.step(args);
          else if (action === 'replan') result = v2.replan(args);
          else result = { ok: false, code: 'TEAM_V2_ACTION_INVALID', detail: { action } };
          return statusJson(result);
        } catch (error) {
          return statusJson({
            ok: false,
            code: 'TEAM_V2_ORCHESTRATE_FAILED',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
      presentCall: () => ({ card: 'generic', title: 'w2m team orchestrate', kind: 'write', rawInput: {} }),
    }),
    defineTool({
      name: 'w2m_team_verify',
      description:
        'Run one context-isolated verifier: score (weighted checks), reflexion (score plus a retry lesson), ' +
        'debate (support vs challenge, with escalate when both hold), or process (step-trace integrity). ' +
        'The verifier accepts checks/evidence/step_trace only; executor_context, executor_trace and raw_context ' +
        'are rejected with TEAM_V2_CONTEXT_NOT_ISOLATED. The default is one small, deterministic verifier; ' +
        'there is deliberately no multi-verifier vote.',
      parameters: {
        mode: {
          type: 'string',
          enum: ['score', 'reflexion', 'debate', 'process'],
          description: 'verification mode; default score',
        },
        checks: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'check objects: id, status pass|fail|missing, weight, critical, detail',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'evidence refs; used as checks when checks are absent',
        },
        step_trace: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'process: ordered step objects with step_id/status/depends_on/evidence',
        },
        artifact_summary: { type: 'string', description: 'optional summary of the artifact under review' },
        support: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'debate: checks supporting the artifact',
        },
        challenge: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'debate: checks challenging the artifact',
        },
        threshold: { type: 'number', description: 'pass threshold between 0.5 and 1; default 0.8' },
      },
      output: resultOutput,
      async execute(args = {}) {
        try {
          return statusJson(v2.verify(args));
        } catch (error) {
          return statusJson({
            ok: false,
            code: 'TEAM_V2_VERIFY_FAILED',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
      presentCall: () => ({ card: 'generic', title: 'w2m team verify', kind: 'read', rawInput: {} }),
    }),
    defineTool({
      name: 'w2m_team_cost',
      description:
        'Quote and record an abstract cost ledger in the fixed order cache-first, route-second. ' +
        'quote returns assumption_based planning units (not a vendor bill); record stores cache hit/miss, ' +
        'model tier and tokens under a plan; report returns totals, hit rate and the cache-vs-route lever. ' +
        'No currency is claimed and no provider price sheet is embedded.',
      parameters: {
        op: {
          type: 'string',
          enum: ['quote', 'record', 'report'],
          description: 'quote (default) | record | report',
        },
        plan_id: { type: 'string', description: 'record/report: plan id whose ledger receives the entry' },
        step_id: { type: 'string', description: 'record: optional step id for the per-step breakdown' },
        model: { type: 'string', enum: ['small', 'large'], description: 'record: model tier; default small' },
        cache: {
          type: 'string',
          enum: ['hit', 'miss'],
          description: 'record: a cache hit avoids the model call',
        },
        input_tokens: { type: 'number', description: 'record/quote: input token count' },
        output_tokens: { type: 'number', description: 'record/quote: output token count' },
        requests: { type: 'number', description: 'quote: request count; default 100' },
        cache_hit_rate: { type: 'number', description: 'quote: expected hit rate 0..1; default 0.5' },
        cache_read_cost_ratio: {
          type: 'number',
          description: 'quote: cache-read cost as a fraction of a normal call; default 0.05',
        },
        model_route_reduction: {
          type: 'number',
          description: 'quote: route saving fraction 0..1; default 0.05',
        },
        baseline_unit: { type: 'number', description: 'quote: abstract units per request; default 6' },
      },
      output: resultOutput,
      async execute(args = {}) {
        try {
          return statusJson(v2.cost(args));
        } catch (error) {
          return statusJson({
            ok: false,
            code: 'TEAM_V2_COST_FAILED',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
      presentCall: () => ({ card: 'generic', title: 'w2m team cost', kind: 'write', rawInput: {} }),
    }),
    defineTool({
      name: 'w2m_team_evolve',
      description:
        'Maintain prompt-level evolution records per local agent: candidate (prompt plus metrics), list, ' +
        'promote (only when no tracked metric regresses against the baseline), rollback to any prior version, ' +
        'and stop-check for iteration limit, quality threshold and consecutive-no-improvement. ' +
        'Every promotion keeps the previous version; this never rewrites a running prompt in place.',
      parameters: {
        op: {
          type: 'string',
          enum: ['candidate', 'list', 'promote', 'rollback', 'stop-check'],
          description: 'candidate (default) | list | promote | rollback | stop-check',
        },
        agent_id: { type: 'string', description: 'stable local agent/role id, e.g. reviewer or planner' },
        prompt: { type: 'string', description: 'candidate: the proposed prompt text' },
        metrics: {
          type: 'object',
          additionalProperties: true,
          description: 'candidate: pass_rate/quality/cost_units/latency_ms/hallucination_rate',
        },
        notes: { type: 'string', description: 'candidate: optional human note' },
        candidate_id: { type: 'string', description: 'promote: candidate id such as cand_1' },
        version_id: { type: 'string', description: 'rollback: version id such as v1' },
        max_iterations: { type: 'number', description: 'stop-check: promoted-version limit; default 10' },
        quality_threshold: { type: 'number', description: 'stop-check: metric threshold 0..1; default 0.9' },
        patience: { type: 'number', description: 'stop-check: consecutive no-improvement count; default 3' },
        metric: { type: 'string', description: 'stop-check: metric key; default pass_rate' },
      },
      output: resultOutput,
      async execute(args = {}) {
        try {
          return statusJson(v2.evolve(args));
        } catch (error) {
          return statusJson({
            ok: false,
            code: 'TEAM_V2_EVOLVE_FAILED',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
      presentCall: () => ({ card: 'generic', title: 'w2m team evolve', kind: 'write', rawInput: {} }),
    }),
    defineTool({
      name: 'w2m_team_frameworks',
      description:
        'List or select the framework adapter boundary. builtin is the only runnable adapter in this package; ' +
        'langgraph/crewai/autogen are declared with capabilities but are not installed. select reports both ' +
        'the requested framework and the effective one, so a fallback is visible instead of silent.',
      parameters: {
        op: { type: 'string', enum: ['list', 'select'], description: 'list (default) | select' },
        requested: {
          type: 'string',
          enum: ['auto', 'builtin', 'langgraph', 'crewai', 'autogen'],
          description: 'select: preferred framework',
        },
        task_type: { type: 'string', description: 'select: a task shape such as dag, role-play or debate' },
        complexity: { type: 'number', description: 'select: 0..1; >=0.6 prefers langgraph' },
        requires: {
          type: 'array',
          items: { type: 'string' },
          description: 'select: required capabilities such as dag, roles, debate',
        },
      },
      output: resultOutput,
      async execute(args = {}) {
        try {
          return statusJson(v2.frameworks(args));
        } catch (error) {
          return statusJson({
            ok: false,
            code: 'TEAM_V2_FRAMEWORKS_FAILED',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
      presentCall: () => ({ card: 'generic', title: 'w2m team frameworks', kind: 'read', rawInput: {} }),
    }),
  ];
}

/**
 * Build the two tool definitions without registering them. A test can mount a fake context and
 * inspect exactly what would be registered.
 *
 * @param {{service: TeamsService, defineTool: Function, output?: object, v2?: object}} args
 * @returns {object[]}
 */
export function buildTools({ service, defineTool, output, v2 } = {}) {
  if (service === null || typeof service !== 'object') throw new TypeError('TeamsService is required');
  if (typeof defineTool !== 'function') throw new TypeError('defineTool is required');
  const resultOutput = output ?? { type: 'json' };

  const legacy = [
    defineTool({
      name: 'w2m_team_status',
      description:
        'Report the Teams view: the two-plane transport policy (control over relay TCP, bulk data over ' +
        'WebRTC with a configured attempt count (default 33, never above it) and an alert on exhaustion), the pairing/relay state, the machine ' +
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
        'shared pool, up to the configured attempt count (default 33, never above it), no relay fallback. On exhaustion it returns ' +
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
  return v2 === undefined || v2 === null
    ? legacy
    : [...legacy, ...buildV2Tools({ v2, defineTool, output: resultOutput })];
}

/**
 * Mount. Registers tools only; performs no network request and reads no `device.json` until a tool
 * is called, so a disabled row has no effect and a status-only mount cannot fail at startup.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] row configuration
 * @param {{defineTool?: Function, loadDefineTool?: Function, service?: TeamsService,
 *   requestImpl?: Function, env?: object, now?: () => number, deviceToken?: string,
 *   device?: object, listPlansImpl?: Function, v2?: object}} [deps]
 * @returns {Promise<Function>} disposer carrying the mount report
 */
export async function apply(ctx, config = {}, deps = {}) {
  const cfg = normalizePluginConfig(config);
  const service =
    deps.service instanceof TeamsService
      ? deps.service
      : new TeamsService(cfg, {
          ...deps,
          getWebRtcPool: deps.getWebRtcPool ?? getSharedWebRtcPool,
        });
  const v2 = deps.v2 ?? createTeamsV2Service({ stateDir: cfg.state_dir });
  ctx?.logger?.info?.(
    `${name}: configured; relay=${safeTeamRelayUrl(cfg.rabbit_url) || 'device-or-env'} room=${cfg.project_id} ` +
      `control=${TEAM_CONTROL_CHANNEL} data=${TEAM_DATA_CHANNEL} max_attempts=${cfg.data_max_attempts}`,
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
    for (const definition of buildTools({ service, defineTool, v2 })) {
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
    v2,
    config: describeConfig(cfg),
  })) {
    dispose[key] = value;
  }
  Object.defineProperty(dispose, 'name', { value: name, configurable: true });
  return dispose;
}
