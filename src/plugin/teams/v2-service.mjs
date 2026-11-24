/**
 * Teams V2 service: the only stateful layer behind the five new tools.
 *
 * It owns local files and pure planning/verification/cost/evolution functions. It does not own
 * dispatch, relay transport, approvals or machine execution; those remain in `w2m_run`,
 * `w2m-joint` and the existing Teams read-only service.
 */

import { existsSync, readdirSync } from 'node:fs';
import {
  TEAMS_V2_CODE,
  evolutionPath,
  fail,
  normalizeAgentId,
  normalizePlanId,
  planPath,
  readJsonFile,
  resolveTeamsV2Root,
  writeJsonAtomic,
} from './v2-store.mjs';
import { applyStep, createPlan, replan, summarizePlan } from './orchestrator.mjs';
import { verify } from './verification.mjs';
import { createCostLedger, quoteCost, recordCost, summarizeCost } from './cost.mjs';
import { addCandidate, checkStop, promoteCandidate, rollback, summarizeEvolution } from './evolution.mjs';
import { listFrameworks, normalizeFramework, selectFramework } from './frameworks.mjs';

export const TEAMS_V2_VERSION = '2.0.0';

/**
 * @param {unknown} value
 * @returns {string}
 */
function idText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {any} plan
 * @returns {boolean}
 */
function validPlan(plan) {
  return (
    plan !== null &&
    typeof plan === 'object' &&
    plan.schema === 'w2m.teams.v2.plan/1' &&
    normalizePlanId(plan.plan_id) !== null &&
    Array.isArray(plan.steps)
  );
}

/**
 * Create the local V2 service.
 *
 * @param {{stateDir?: string, now?: () => number}} [options]
 * @returns {object}
 */
export function createTeamsV2Service(options = {}) {
  const root = resolveTeamsV2Root(options.stateDir);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /**
   * @param {unknown} planId
   * @returns {{ok: true, plan: object}|{ok: false, code: string}}
   */
  function loadPlan(planId) {
    const id = normalizePlanId(planId);
    if (id === null) return fail(TEAMS_V2_CODE.PLAN_NOT_FOUND, { plan_id: String(planId ?? '') });
    const plan = readJsonFile(planPath(root, id));
    if (plan === null || !validPlan(plan)) return fail(TEAMS_V2_CODE.PLAN_NOT_FOUND, { plan_id: id });
    return { ok: true, plan };
  }

  /**
   * @param {object} plan
   * @returns {{ok: true}|{ok: false, code: string}}
   */
  function savePlan(plan) {
    try {
      writeJsonAtomic(planPath(root, plan.plan_id), plan);
      return { ok: true };
    } catch {
      return fail(TEAMS_V2_CODE.STATE_UNAVAILABLE, { area: 'plans' });
    }
  }

  /**
   * @param {string} agentId
   * @returns {{ok: true, evolution: object|null}|{ok: false, code: string}}
   */
  function loadEvolution(agentId) {
    const id = normalizeAgentId(agentId);
    if (id === null) return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'agent_id' });
    if (!existsSync(evolutionPath(root, id))) return { ok: true, evolution: null };
    const evolution = readJsonFile(evolutionPath(root, id));
    if (evolution === null || typeof evolution !== 'object' || evolution.agent_id !== id) {
      return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'state', agent_id: id });
    }
    return { ok: true, evolution };
  }

  /**
   * @param {object} evolution
   * @returns {{ok: true}|{ok: false, code: string}}
   */
  function saveEvolution(evolution) {
    try {
      writeJsonAtomic(evolutionPath(root, evolution.agent_id), evolution);
      return { ok: true };
    } catch {
      return fail(TEAMS_V2_CODE.STATE_UNAVAILABLE, { area: 'evolution' });
    }
  }

  /**
   * @param {object} plan
   * @param {object} extra
   * @returns {object}
   */
  function result(plan, extra = {}) {
    return { ok: true, plan: structuredClone(plan), summary: summarizePlan(plan), ...extra };
  }

  return {
    version: TEAMS_V2_VERSION,
    stateRoot: root,

    /**
     * @param {object} args
     * @returns {object}
     */
    createPlan(args = {}) {
      const candidate = createPlan({ ...args, now: args.now ?? now() });
      if (candidate.ok !== true) return candidate;
      const existing = existsSync(planPath(root, candidate.plan.plan_id));
      if (existing)
        return fail(TEAMS_V2_CODE.PLAN_INVALID, { field: 'plan_id', plan_id: candidate.plan.plan_id });
      const saved = savePlan(candidate.plan);
      if (saved.ok !== true) return saved;
      return result(candidate.plan, { warnings: candidate.warnings });
    },

    /**
     * @param {string} planId
     * @returns {object}
     */
    planStatus(planId) {
      const loaded = loadPlan(planId);
      if (loaded.ok !== true) return loaded;
      return result(loaded.plan);
    },

    /**
     * @returns {{ok: true, plans: object[]}}
     */
    listPlans() {
      const plans = [];
      try {
        const names = readdirSync(`${root}/plans`).filter(
          (name) => name.endsWith('.json') && !name.includes('.tmp.'),
        );
        for (const name of names) {
          const plan = readJsonFile(`${root}/plans/${name}`);
          if (validPlan(plan)) plans.push(summarizePlan(plan));
        }
      } catch {
        return { ok: true, plans: [] };
      }
      plans.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return { ok: true, plans };
    },

    /**
     * @param {object} args
     * @returns {object}
     */
    step(args = {}) {
      const loaded = loadPlan(args.plan_id);
      if (loaded.ok !== true) return loaded;
      const applied = applyStep(loaded.plan, { ...args, now: args.now ?? now() });
      if (applied.ok !== true) return applied;
      const saved = savePlan(applied.plan);
      if (saved.ok !== true) return saved;
      return result(applied.plan, { step: applied.step, ready: applied.ready });
    },

    /**
     * @param {object} args
     * @returns {object}
     */
    replan(args = {}) {
      const loaded = loadPlan(args.plan_id);
      if (loaded.ok !== true) return loaded;
      const patch = args.patch ?? args;
      const edited = replan(loaded.plan, { ...patch, now: args.now ?? now() });
      if (edited.ok !== true) return edited;
      const saved = savePlan(edited.plan);
      if (saved.ok !== true) return saved;
      return result(edited.plan, { warnings: edited.warnings });
    },

    /**
     * @param {object} args
     * @returns {object}
     */
    verify(args = {}) {
      return verify(args);
    },

    /**
     * @param {object} args
     * @returns {object}
     */
    cost(args = {}) {
      const op = idText(args.op).toLowerCase() || 'quote';
      if (op === 'quote') {
        return { ok: true, ...quoteCost(args) };
      }
      if (op !== 'record' && op !== 'report') {
        return fail(TEAMS_V2_CODE.COST_INPUT_INVALID, { field: 'op', op });
      }
      const loaded = loadPlan(args.plan_id);
      if (loaded.ok !== true)
        return fail(TEAMS_V2_CODE.COST_PLAN_REQUIRED, { plan_id: String(args.plan_id ?? '') });
      if (op === 'report') {
        return {
          ok: true,
          plan_id: loaded.plan.plan_id,
          summary: summarizeCost(loaded.plan.cost ?? createCostLedger()),
        };
      }
      const ledger = loaded.plan.cost ?? createCostLedger();
      const recorded = recordCost(ledger, { ...args, step_id: args.step_id });
      if (recorded.ok !== true) return recorded;
      loaded.plan.cost = recorded.ledger;
      loaded.plan.updated_at = new Date(now()).toISOString();
      const saved = savePlan(loaded.plan);
      if (saved.ok !== true) return saved;
      return {
        ok: true,
        plan_id: loaded.plan.plan_id,
        record: recorded.record,
        summary: summarizeCost(recorded.ledger),
      };
    },

    /**
     * @param {{op?: string, requested?: string, task_type?: string, complexity?: number, requires?: string[]}} [args]
     * @returns {object}
     */
    frameworks(args = {}) {
      const op = idText(args.op).toLowerCase() || 'list';
      if (op === 'list') return { ok: true, frameworks: listFrameworks() };
      if (op !== 'select') return fail(TEAMS_V2_CODE.FRAMEWORK_INVALID, { field: 'op', op });
      if (args.requested !== undefined && normalizeFramework(args.requested) === null) {
        return fail(TEAMS_V2_CODE.FRAMEWORK_INVALID, {
          field: 'framework',
          framework: String(args.requested),
        });
      }
      const choice = selectFramework(args);
      if (choice.requested === null) return fail(TEAMS_V2_CODE.FRAMEWORK_INVALID, { field: 'framework' });
      return { ok: true, ...choice };
    },

    /**
     * @param {{op?: string, agent_id?: string, candidate_id?: string, version_id?: string,
     *   prompt?: string, metrics?: object, notes?: string, max_iterations?: number,
     *   quality_threshold?: number, patience?: number, metric?: string}} [args]
     * @returns {object}
     */
    evolve(args = {}) {
      const op = idText(args.op).toLowerCase() || 'list';
      const agentId = normalizeAgentId(args.agent_id);
      if (agentId === null) return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'agent_id' });
      const loaded = loadEvolution(agentId);
      if (loaded.ok !== true) return loaded;
      if (op === 'list') {
        return { ok: true, evolution: summarizeEvolution(loaded.evolution, agentId) };
      }
      if (op === 'candidate') {
        const added = addCandidate(loaded.evolution, agentId, { ...args, now: args.now ?? now() });
        if (added.ok !== true) return added;
        const saved = saveEvolution(added.evolution);
        if (saved.ok !== true) return saved;
        return {
          ok: true,
          candidate: added.candidate,
          evolution: summarizeEvolution(added.evolution, agentId),
        };
      }
      if (op === 'promote') {
        const promoted = promoteCandidate(loaded.evolution, agentId, { ...args, now: args.now ?? now() });
        if (promoted.ok !== true) return promoted;
        const saved = saveEvolution(promoted.evolution);
        if (saved.ok !== true) return saved;
        return {
          ok: true,
          version: promoted.version,
          evolution: summarizeEvolution(promoted.evolution, agentId),
        };
      }
      if (op === 'rollback') {
        const restored = rollback(loaded.evolution, agentId, { ...args, now: args.now ?? now() });
        if (restored.ok !== true) return restored;
        const saved = saveEvolution(restored.evolution);
        if (saved.ok !== true) return saved;
        return {
          ok: true,
          baseline: restored.baseline,
          evolution: summarizeEvolution(restored.evolution, agentId),
        };
      }
      if (op === 'stop-check') {
        return checkStop(loaded.evolution, agentId, args);
      }
      return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'op', op });
    },
  };
}
