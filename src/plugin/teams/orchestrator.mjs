/**
 * Teams V2 orchestrator: a task ledger that can be edited while it runs.
 *
 * This is a planner, not a command path. It never spawns a process, sends a relay frame or calls
 * `w2m_run`. A step becomes `done` only when an isolated verification says `pass` and evidence is
 * present; every other transition is a local state change that a human or the existing joint tools
 * can inspect.
 */

import { selectFramework } from './frameworks.mjs';
import { TEAMS_V2_CODE, digestJson, fail, normalizePlanId } from './v2-store.mjs';

/** The roles named by the five-pillar model. Custom roles are deliberately not accepted yet. */
export const TEAM_ROLES = Object.freeze([
  'planner',
  'executor',
  'reviewer',
  'critic',
  'verifier',
  'auditor',
  'repairer',
  'optimizer',
]);

export const STEP_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);
export const PLAN_STATUSES = Object.freeze(['active', 'completed', 'blocked', 'aborted']);
const MAX_STEPS = 64;
const MAX_EVENTS = 200;
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const text = (value, max = 4_000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const iso = (now) => new Date(now).toISOString();
const int = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
};

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
function normalizeRole(value) {
  const role = text(value, 40).toLowerCase();
  return TEAM_ROLES.includes(role) ? role : null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeDepends(value) {
  if (!Array.isArray(value)) return [];
  const unique = [];
  for (const item of value) {
    const id = text(item, 64);
    if (id !== '' && !unique.includes(id)) unique.push(id);
  }
  return unique;
}

/**
 * @param {any[]} steps
 * @returns {{ok: true}|{ok: false, code: string, detail?: any}}
 */
export function checkGraph(steps) {
  const ids = new Set();
  for (const step of steps) {
    if (ids.has(step.step_id)) return fail(TEAMS_V2_CODE.STEP_ID_DUPLICATE, { step_id: step.step_id });
    ids.add(step.step_id);
  }
  for (const step of steps) {
    for (const dependency of step.depends_on) {
      if (!ids.has(dependency)) {
        return fail(TEAMS_V2_CODE.DEPENDENCY_MISSING, { step_id: step.step_id, dependency });
      }
    }
  }
  const indegree = new Map(steps.map((step) => [step.step_id, step.depends_on.length]));
  const children = new Map(steps.map((step) => [step.step_id, []]));
  for (const step of steps) {
    for (const dependency of step.depends_on) children.get(dependency).push(step.step_id);
  }
  const queue = steps.filter((step) => indegree.get(step.step_id) === 0).map((step) => step.step_id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    visited += 1;
    for (const child of children.get(current)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  return visited === steps.length ? { ok: true } : fail(TEAMS_V2_CODE.DEPENDENCY_CYCLE);
}

/**
 * Normalize one step without mutating input. Every returned warning is explicit; a missing
 * framework adapter falls back to `builtin` and is reported, never silently hidden.
 *
 * @param {unknown} input
 * @param {number} index
 * @param {string} planFramework
 * @param {number} now
 * @returns {{ok: true, step: object, warnings: string[]}|{ok: false, code: string, detail?: any}}
 */
export function normalizeStep(input, index, planFramework, now) {
  if (!isRecord(input)) return fail(TEAMS_V2_CODE.STEP_INVALID, { index });
  const stepId = text(input.step_id, 64) || `s${index + 1}`;
  if (!STEP_ID_RE.test(stepId)) return fail(TEAMS_V2_CODE.STEP_INVALID, { index, step_id: stepId });
  const title = text(input.title, 200);
  if (title === '') return fail(TEAMS_V2_CODE.STEP_INVALID, { index, step_id: stepId, field: 'title' });
  const agent = normalizeRole(input.agent ?? input.role ?? 'executor');
  if (agent === null) {
    return fail(TEAMS_V2_CODE.STEP_INVALID, { index, step_id: stepId, field: 'agent' });
  }
  const requested =
    input.framework === undefined ? (input.framework_preference ?? planFramework) : input.framework;
  const choice = selectFramework({
    requested,
    task_type: input.task_type,
    complexity: input.complexity,
    requires: input.requires,
  });
  const warnings = choice.runnable ? [] : [`framework:${choice.selected}:${choice.reason}`];
  return {
    ok: true,
    warnings,
    step: {
      step_id: stepId,
      title,
      agent,
      framework: choice.effective,
      framework_preference: choice.selected,
      framework_runnable: choice.runnable,
      task_type: text(input.task_type, 80) || null,
      depends_on: normalizeDepends(input.depends_on),
      acceptance: text(input.acceptance, 2_000),
      max_attempts: int(input.max_attempts, 3, 1, 10),
      status: 'pending',
      attempts: 0,
      result: null,
      verification: null,
      failure: null,
      created_at: iso(now),
      updated_at: iso(now),
    },
  };
}

/**
 * Normalize a caller-supplied result into a bounded record. Full artifacts stay outside the ledger;
 * the digest is enough to prove which bytes were reviewed.
 *
 * @param {unknown} result
 * @param {unknown} evidence
 * @returns {{ok: true, result: object, evidence: string[]}|{ok: false, code: string}}
 */
function normalizeResult(result, evidence) {
  const summary = typeof result === 'string' ? text(result) : text(result?.summary);
  const digest = result === undefined || result === null ? null : digestJson(result);
  const evidenceList = Array.isArray(evidence)
    ? evidence
        .map((item) => (typeof item === 'string' ? text(item, 500) : JSON.stringify(item).slice(0, 500)))
        .filter((item) => item !== '')
        .slice(0, 20)
    : [];
  if (summary === '' && digest === null && evidenceList.length === 0) {
    return fail(TEAMS_V2_CODE.EVIDENCE_REQUIRED);
  }
  return { ok: true, result: { summary, digest }, evidence: evidenceList };
}

/**
 * Keep only verification fields that are safe to persist. Executor context is never copied into
 * the ledger, even if a caller try to smuggle it into the verification object.
 *
 * @param {unknown} verification
 * @returns {object|null}
 */
function normalizeVerification(verification) {
  if (!isRecord(verification)) return null;
  const verdict = text(verification.verdict, 20).toLowerCase();
  if (!['pass', 'fail', 'escalate'].includes(verdict)) return null;
  return {
    mode: text(verification.mode, 30) || null,
    verdict,
    score: Number.isFinite(Number(verification.score)) ? Number(verification.score) : null,
    threshold: Number.isFinite(Number(verification.threshold)) ? Number(verification.threshold) : null,
    verification_id: text(verification.verification_id, 80) || null,
    verifier_id: text(verification.verifier_id, 80) || null,
    context_isolated: verification.context_isolated === true,
    checks: Array.isArray(verification.checks)
      ? verification.checks.slice(0, 40).map((check) => ({
          id: text(check?.id, 80),
          status: text(check?.status, 20),
          weight: Number.isFinite(Number(check?.weight)) ? Number(check.weight) : null,
          critical: check?.critical === true,
          detail: text(check?.detail, 500) || null,
        }))
      : [],
    findings: Array.isArray(verification.findings)
      ? verification.findings
          .slice(0, 20)
          .map((finding) => text(finding, 500))
          .filter((finding) => finding !== '')
      : [],
  };
}

/**
 * @param {object} plan
 * @param {string} stepId
 * @returns {object|null}
 */
function findStep(plan, stepId) {
  return plan.steps.find((step) => step.step_id === stepId) ?? null;
}

/**
 * @param {object} plan
 * @returns {string[]}
 */
export function readySteps(plan) {
  const status = new Map(plan.steps.map((step) => [step.step_id, step.status]));
  return plan.steps
    .filter(
      (step) =>
        step.status === 'pending' && step.depends_on.every((dependency) => status.get(dependency) === 'done'),
    )
    .map((step) => step.step_id);
}

/**
 * @param {object} plan
 * @returns {string[]}
 */
export function blockedSteps(plan) {
  const byId = new Map(plan.steps.map((step) => [step.step_id, step]));
  return plan.steps
    .filter((step) => {
      if (step.status === 'failed' && step.attempts >= step.max_attempts) return true;
      if (step.status !== 'pending') return false;
      return step.depends_on.some((dependency) => {
        const source = byId.get(dependency);
        return source !== undefined && source.status === 'failed' && source.attempts >= source.max_attempts;
      });
    })
    .map((step) => step.step_id);
}

/**
 * @param {object} plan
 * @returns {object}
 */
export function summarizePlan(plan) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const step of plan.steps) counts[step.status] += 1;
  const verifications = { pass: 0, fail: 0, escalate: 0, none: 0 };
  for (const step of plan.steps) {
    if (step.verification === null) verifications.none += 1;
    else if (verifications[step.verification.verdict] !== undefined)
      verifications[step.verification.verdict] += 1;
  }
  return {
    plan_id: plan.plan_id,
    goal: plan.goal,
    status: plan.status,
    version: plan.version,
    framework: plan.framework,
    framework_preference: plan.framework_preference,
    steps: plan.steps.length,
    counts,
    progress: plan.steps.length === 0 ? 0 : counts.done / plan.steps.length,
    ready: readySteps(plan),
    blocked: blockedSteps(plan),
    verifications,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    cost: plan.cost,
  };
}

/**
 * @param {object} args
 * @param {string} args.goal
 * @param {any[]} args.steps
 * @param {string} [args.framework]
 * @param {string} [args.plan_id]
 * @param {string} [args.base_commit]
 * @param {number} [args.now]
 * @returns {{ok: true, plan: object, warnings: string[]}|{ok: false, code: string, detail?: any}}
 */
export function createPlan(args = {}) {
  const goal = text(args.goal, 5_000);
  if (goal === '') return fail(TEAMS_V2_CODE.PLAN_GOAL_REQUIRED);
  if (!Array.isArray(args.steps) || args.steps.length === 0) return fail(TEAMS_V2_CODE.PLAN_STEPS_REQUIRED);
  if (args.steps.length > MAX_STEPS) return fail(TEAMS_V2_CODE.PLAN_STEPS_LIMIT, { max: MAX_STEPS });
  if (args.plan_id !== undefined) {
    const supplied = normalizePlanId(args.plan_id);
    if (supplied === null) return fail(TEAMS_V2_CODE.PLAN_INVALID, { field: 'plan_id' });
  }
  const now = Number.isFinite(Number(args.now)) ? Number(args.now) : Date.now();
  const planId =
    args.plan_id === undefined
      ? `tp_${digestJson(`${goal}\0${now}`).slice(0, 16)}`
      : normalizePlanId(args.plan_id);
  const choice = selectFramework({ requested: args.framework ?? 'auto' });
  if (choice.requested === null) return fail(TEAMS_V2_CODE.FRAMEWORK_INVALID, { framework: args.framework });
  const warnings = choice.runnable ? [] : [`framework:${choice.selected}:${choice.reason}`];
  const normalized = [];
  for (const [index, input] of args.steps.entries()) {
    const result = normalizeStep(input, index, choice.effective, now);
    if (result.ok !== true) return result;
    normalized.push(result.step);
    warnings.push(...result.warnings);
  }
  const graph = checkGraph(normalized);
  if (graph.ok !== true) return graph;
  const plan = {
    schema: 'w2m.teams.v2.plan/1',
    plan_id: planId,
    goal,
    base_commit: text(args.base_commit, 80) || null,
    framework: choice.effective,
    framework_preference: choice.selected,
    framework_runnable: choice.runnable,
    framework_reason: choice.reason,
    status: 'active',
    version: 1,
    steps: normalized,
    events: [
      {
        seq: 1,
        at: iso(now),
        type: 'created',
        detail: { steps: normalized.length, framework: choice.effective },
      },
    ],
    replans: [],
    cost: {
      cache_hits: 0,
      cache_misses: 0,
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_units: 0,
      cache_saved_units: 0,
      route_saved_units: 0,
      by_step: {},
    },
    created_at: iso(now),
    updated_at: iso(now),
  };
  return { ok: true, plan, warnings: [...new Set(warnings)] };
}

/**
 * Apply one step transition. The plan is cloned; the caller persists the returned copy.
 *
 * @param {object} plan
 * @param {{step_id: string, status: string, result?: any, evidence?: any[], verification?: any,
 *   actor?: string, now?: number}} args
 * @returns {{ok: true, plan: object, step: object, ready: string[]}|{ok: false, code: string, detail?: any}}
 */
export function applyStep(plan, args = {}) {
  const stepId = text(args.step_id, 64);
  const nextStatus = text(args.status, 20).toLowerCase();
  if (!STEP_STATUSES.includes(nextStatus))
    return fail(TEAMS_V2_CODE.STEP_TRANSITION_INVALID, { step_id: stepId, status: nextStatus });
  const step = findStep(plan, stepId);
  if (step === null) return fail(TEAMS_V2_CODE.STEP_NOT_FOUND, { step_id: stepId });
  const current = step.status;
  const allowed =
    (current === 'pending' && (nextStatus === 'running' || nextStatus === 'skipped')) ||
    (current === 'running' && (nextStatus === 'done' || nextStatus === 'failed')) ||
    (current === 'failed' && nextStatus === 'running');
  if (!allowed) {
    return fail(TEAMS_V2_CODE.STEP_TRANSITION_INVALID, { step_id: stepId, from: current, to: nextStatus });
  }
  if (nextStatus === 'running' && step.attempts >= step.max_attempts) {
    return fail(TEAMS_V2_CODE.STEP_ATTEMPTS_EXHAUSTED, { step_id: stepId, attempts: step.attempts });
  }
  if (nextStatus === 'running') {
    const dependency = step.depends_on.find((id) => findStep(plan, id)?.status !== 'done');
    if (dependency !== undefined) {
      return fail(TEAMS_V2_CODE.DEPENDENCY_MISSING, { step_id: stepId, dependency, status: 'not-done' });
    }
  }
  const now = Number.isFinite(Number(args.now)) ? Number(args.now) : Date.now();
  const copy = structuredClone(plan);
  const target = findStep(copy, stepId);
  if (nextStatus === 'running') {
    target.attempts += 1;
    target.status = 'running';
    target.failure = null;
  } else if (nextStatus === 'skipped') {
    target.status = 'skipped';
  } else if (nextStatus === 'failed') {
    target.status = 'failed';
    target.failure = text(args.result?.summary ?? args.result ?? args.failure, 2_000) || 'failed';
  } else if (nextStatus === 'done') {
    const verification = normalizeVerification(args.verification);
    if (verification === null || verification.verdict !== 'pass') {
      return fail(TEAMS_V2_CODE.VERIFICATION_REQUIRED, { step_id: stepId, expected: 'pass' });
    }
    if (verification.context_isolated !== true) {
      return fail(TEAMS_V2_CODE.CONTEXT_NOT_ISOLATED, {
        step_id: stepId,
        field: 'verification.context_isolated',
      });
    }
    const normalized = normalizeResult(args.result, args.evidence);
    if (normalized.ok !== true) return normalized;
    if (normalized.evidence.length === 0) return fail(TEAMS_V2_CODE.EVIDENCE_REQUIRED, { step_id: stepId });
    target.status = 'done';
    target.result = normalized.result;
    target.evidence = normalized.evidence;
    target.verification = verification;
    target.failure = null;
  }
  target.updated_at = iso(now);
  copy.updated_at = iso(now);
  const counts = { done: 0, failedExhausted: 0 };
  for (const item of copy.steps) {
    if (item.status === 'done') counts.done += 1;
    if (item.status === 'failed' && item.attempts >= item.max_attempts) counts.failedExhausted += 1;
  }
  copy.status =
    counts.done === copy.steps.length ? 'completed' : counts.failedExhausted > 0 ? 'blocked' : 'active';
  copy.events.push({
    seq: copy.events.length + 1,
    at: iso(now),
    type: 'step',
    step_id: stepId,
    status: nextStatus,
    actor: text(args.actor, 40) || 'local',
  });
  copy.events = copy.events.slice(-MAX_EVENTS);
  return { ok: true, plan: copy, step: target, ready: readySteps(copy) };
}

/**
 * Edit the ledger while it is running. Completed and running steps are immutable; a removal that
 * would orphan a dependent is rejected instead of silently producing a broken DAG.
 *
 * @param {object} plan
 * @param {{reason?: string, add?: any[], update?: any[], remove?: string[], now?: number}} patch
 * @returns {{ok: true, plan: object, warnings: string[]}|{ok: false, code: string, detail?: any}}
 */
export function replan(plan, patch = {}) {
  const reason = text(patch.reason, 500);
  if (reason === '') return fail(TEAMS_V2_CODE.REPLAN_REASON_REQUIRED);
  const now = Number.isFinite(Number(patch.now)) ? Number(patch.now) : Date.now();
  const copy = structuredClone(plan);
  const removed = new Set(
    Array.isArray(patch.remove) ? patch.remove.map((value) => text(value, 64)).filter(Boolean) : [],
  );
  for (const stepId of removed) {
    const target = findStep(copy, stepId);
    if (target === null) return fail(TEAMS_V2_CODE.STEP_NOT_FOUND, { step_id: stepId });
    if (target.status === 'done' || target.status === 'running') {
      return fail(TEAMS_V2_CODE.REPLAN_TARGET_LOCKED, { step_id: stepId, status: target.status });
    }
    if (copy.steps.some((step) => step.depends_on.includes(stepId))) {
      return fail(TEAMS_V2_CODE.REPLAN_DEPENDENT_EXISTS, { step_id: stepId });
    }
  }
  copy.steps = copy.steps.filter((step) => !removed.has(step.step_id));
  const warnings = [];
  if (Array.isArray(patch.add)) {
    for (const [index, input] of patch.add.entries()) {
      const result = normalizeStep(input, copy.steps.length + index, copy.framework, now);
      if (result.ok !== true) return result;
      if (findStep(copy, result.step.step_id) !== null) {
        return fail(TEAMS_V2_CODE.STEP_ID_DUPLICATE, { step_id: result.step.step_id });
      }
      copy.steps.push(result.step);
      warnings.push(...result.warnings);
    }
  }
  if (Array.isArray(patch.update)) {
    for (const input of patch.update) {
      const stepId = text(input?.step_id, 64);
      const target = findStep(copy, stepId);
      if (target === null) return fail(TEAMS_V2_CODE.STEP_NOT_FOUND, { step_id: stepId });
      if (target.status === 'done' || target.status === 'running') {
        return fail(TEAMS_V2_CODE.REPLAN_TARGET_LOCKED, { step_id: stepId, status: target.status });
      }
      const merged = {
        ...target,
        ...input,
        framework: input.framework ?? target.framework_preference ?? target.framework,
        framework_preference: input.framework_preference ?? target.framework_preference,
        status: target.status,
        attempts: target.attempts,
        result: target.result,
        verification: target.verification,
        created_at: target.created_at,
      };
      const result = normalizeStep(merged, copy.steps.indexOf(target), copy.framework, now);
      if (result.ok !== true) return result;
      Object.assign(target, result.step, {
        status: merged.status,
        attempts: merged.attempts,
        result: merged.result,
        verification: merged.verification,
        created_at: merged.created_at,
      });
      warnings.push(...result.warnings);
    }
  }
  const graph = checkGraph(copy.steps);
  if (graph.ok !== true) return graph;
  copy.version += 1;
  copy.updated_at = iso(now);
  copy.replans.push({
    version: copy.version,
    at: iso(now),
    reason,
    added: Array.isArray(patch.add) ? patch.add.length : 0,
    updated: Array.isArray(patch.update) ? patch.update.length : 0,
    removed: removed.size,
  });
  copy.replans = copy.replans.slice(-50);
  copy.events.push({
    seq: copy.events.length + 1,
    at: iso(now),
    type: 'replanned',
    detail: {
      version: copy.version,
      reason,
      added: patch.add?.length ?? 0,
      updated: patch.update?.length ?? 0,
      removed: removed.size,
    },
  });
  copy.events = copy.events.slice(-MAX_EVENTS);
  copy.status = copy.steps.every((step) => step.status === 'done') ? 'completed' : 'active';
  return { ok: true, plan: copy, warnings: [...new Set(warnings)] };
}
