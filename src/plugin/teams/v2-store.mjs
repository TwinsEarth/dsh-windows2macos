/**
 * Teams V2 local state: plans and prompt-evolution records.
 *
 * The store is deliberately local and boring: one JSON file per plan or agent, atomic replace,
 * bounded ids, no user-controlled path joining. V2 never dispatches; a plan is a ledger that the
 * existing joint/run tools can act on later.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Schema marker written into every persisted document. */
export const TEAMS_V2_SCHEMA = 'w2m.teams.v2/1';

/** Stable error codes returned by the V2 tools. */
export const TEAMS_V2_CODE = Object.freeze({
  STATE_UNAVAILABLE: 'TEAM_V2_STATE_UNAVAILABLE',
  PLAN_NOT_FOUND: 'TEAM_V2_PLAN_NOT_FOUND',
  PLAN_INVALID: 'TEAM_V2_PLAN_INVALID',
  PLAN_GOAL_REQUIRED: 'TEAM_V2_PLAN_GOAL_REQUIRED',
  PLAN_STEPS_REQUIRED: 'TEAM_V2_PLAN_STEPS_REQUIRED',
  PLAN_STEPS_LIMIT: 'TEAM_V2_PLAN_STEPS_LIMIT',
  STEP_NOT_FOUND: 'TEAM_V2_STEP_NOT_FOUND',
  STEP_INVALID: 'TEAM_V2_STEP_INVALID',
  STEP_ID_DUPLICATE: 'TEAM_V2_STEP_ID_DUPLICATE',
  STEP_TRANSITION_INVALID: 'TEAM_V2_STEP_TRANSITION_INVALID',
  STEP_ATTEMPTS_EXHAUSTED: 'TEAM_V2_STEP_ATTEMPTS_EXHAUSTED',
  VERIFICATION_REQUIRED: 'TEAM_V2_VERIFICATION_REQUIRED',
  EVIDENCE_REQUIRED: 'TEAM_V2_EVIDENCE_REQUIRED',
  DEPENDENCY_MISSING: 'TEAM_V2_DEPENDENCY_MISSING',
  DEPENDENCY_CYCLE: 'TEAM_V2_DEPENDENCY_CYCLE',
  REPLAN_REASON_REQUIRED: 'TEAM_V2_REPLAN_REASON_REQUIRED',
  REPLAN_TARGET_LOCKED: 'TEAM_V2_REPLAN_TARGET_LOCKED',
  REPLAN_DEPENDENT_EXISTS: 'TEAM_V2_REPLAN_DEPENDENT_EXISTS',
  FRAMEWORK_INVALID: 'TEAM_V2_FRAMEWORK_INVALID',
  FRAMEWORK_UNAVAILABLE: 'TEAM_V2_FRAMEWORK_UNAVAILABLE',
  CHECKS_REQUIRED: 'TEAM_V2_CHECKS_REQUIRED',
  CONTEXT_NOT_ISOLATED: 'TEAM_V2_CONTEXT_NOT_ISOLATED',
  PROCESS_TRACE_REQUIRED: 'TEAM_V2_PROCESS_TRACE_REQUIRED',
  EVOLUTION_INVALID: 'TEAM_V2_EVOLUTION_INVALID',
  EVOLUTION_VERSION_NOT_FOUND: 'TEAM_V2_EVOLUTION_VERSION_NOT_FOUND',
  EVOLUTION_VERSION_INELIGIBLE: 'TEAM_V2_EVOLUTION_VERSION_INELIGIBLE',
  EVOLUTION_STOP_INVALID: 'TEAM_V2_EVOLUTION_STOP_INVALID',
  COST_INPUT_INVALID: 'TEAM_V2_COST_INPUT_INVALID',
  COST_PLAN_REQUIRED: 'TEAM_V2_COST_PLAN_REQUIRED',
  JSON_INVALID: 'TEAM_V2_JSON_INVALID',
});

const PLAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Generate a deterministic-but-unique plan id from goal + time. A caller may supply its own
 * safe id; generated ids are always `tp_` followed by 16 hex characters.
 *
 * @param {string} goal
 * @param {number} [now]
 * @param {string} [salt]
 * @returns {string}
 */
export function planIdFor(goal, now = Date.now(), salt = '') {
  return `tp_${digestJson(`${goal}\u0000${now}\u0000${salt}`).slice(0, 16)}`;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizePlanId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return PLAN_ID_RE.test(text) ? text : null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeAgentId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return AGENT_ID_RE.test(text) ? text : null;
}

/**
 * Resolve the V2 state root. An explicit state directory wins; otherwise use the same `~/.dsh`
 * home the rest of the package uses.
 *
 * @param {unknown} stateDir
 * @returns {string}
 */
export function resolveTeamsV2Root(stateDir) {
  const base =
    typeof stateDir === 'string' && stateDir.trim() !== ''
      ? resolve(stateDir.trim())
      : join(homedir(), '.dsh');
  return join(base, 'teams-v2');
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return true;
}

/**
 * @param {string} path
 * @returns {any|null}
 */
export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomic JSON replace. A crash may leave a `.tmp` file, never a half-written canonical file.
 *
 * @param {string} path
 * @param {any} value
 * @returns {boolean}
 */
export function writeJsonAtomic(path, value) {
  ensureDir(join(path, '..'));
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return true;
}

/**
 * @param {string} root
 * @param {string} planId
 * @returns {string}
 */
export function planPath(root, planId) {
  return join(root, 'plans', `${planId}.json`);
}

/**
 * @param {string} root
 * @param {string} agentId
 * @returns {string}
 */
export function evolutionPath(root, agentId) {
  return join(root, 'evolution', `${agentId}.json`);
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function listPlanFiles(root) {
  const dir = join(root, 'plans');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.includes('.tmp.'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Stable, non-sensitive summary of a missing/parse state.
 *
 * @param {string} code
 * @param {Record<string, any>} [detail]
 * @returns {{ok: false, code: string, detail?: any}}
 */
export function fail(code, detail) {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}
