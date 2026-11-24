/**
 * Teams V2 prompt evolution: candidates, snapshots, promotion and rollback.
 *
 * This is intentionally prompt-level, not strategy-level reinforcement learning. A candidate is
 * a string plus metrics; `promote` requires non-regression against the current baseline, and every
 * promotion keeps the previous version so `rollback` is always possible. Stop rules are explicit
 * because an unbounded self-improvement loop is a bug, not a feature.
 */

import { TEAMS_V2_CODE, fail, normalizeAgentId } from './v2-store.mjs';

export const METRIC_DIRECTIONS = Object.freeze({
  pass_rate: 'higher',
  quality: 'higher',
  cost_units: 'lower',
  latency_ms: 'lower',
  hallucination_rate: 'lower',
});

const text = (value, max = 8_000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const metricValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1_000_000, number)) : null;
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} metrics
 * @returns {object}
 */
function normalizeMetrics(metrics) {
  if (!isRecord(metrics)) return {};
  const result = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (Object.prototype.hasOwnProperty.call(METRIC_DIRECTIONS, key)) {
      const number = metricValue(value);
      if (number !== null) result[key] = number;
    }
  }
  return result;
}

/**
 * @returns {object}
 */
function emptyEvolution() {
  return {
    agent_id: null,
    baseline: null,
    versions: [],
    candidates: [],
    next_id: 1,
    created_at: null,
    updated_at: null,
  };
}

/**
 * @param {object|null} evolution
 * @param {string} agentId
 * @returns {object}
 */
function ensureEvolution(evolution, agentId) {
  const base = evolution === null || evolution === undefined ? emptyEvolution() : structuredClone(evolution);
  base.agent_id = base.agent_id ?? agentId;
  base.baseline = base.baseline ?? null;
  base.versions = Array.isArray(base.versions) ? base.versions : [];
  base.candidates = Array.isArray(base.candidates) ? base.candidates : [];
  base.next_id = Number.isFinite(Number(base.next_id)) ? Number(base.next_id) : 1;
  return base;
}

/**
 * Compare a candidate with a baseline. Direction matters; a missing baseline metric is neutral
 * rather than a win.
 *
 * @param {object} candidateMetrics
 * @param {object|null} baselineMetrics
 * @returns {{regressions: string[], improvements: string[], compared: number}}
 */
export function compareMetrics(candidateMetrics, baselineMetrics) {
  const regressions = [];
  const improvements = [];
  let compared = 0;
  if (!isRecord(baselineMetrics)) return { regressions, improvements, compared };
  for (const [key, direction] of Object.entries(METRIC_DIRECTIONS)) {
    const candidate = metricValue(candidateMetrics?.[key]);
    const baseline = metricValue(baselineMetrics[key]);
    if (candidate === null || baseline === null) continue;
    compared += 1;
    const epsilon = Math.max(1e-9, Math.abs(baseline) * 0.005);
    if (direction === 'higher') {
      if (candidate < baseline - epsilon) regressions.push(key);
      else if (candidate > baseline + epsilon) improvements.push(key);
    } else {
      if (candidate > baseline + epsilon) regressions.push(key);
      else if (candidate < baseline - epsilon) improvements.push(key);
    }
  }
  return { regressions, improvements, compared };
}

/**
 * @param {object|null} evolution
 * @param {string} agentId
 * @param {{prompt: string, metrics?: object, notes?: string, now?: number}} input
 * @returns {{ok: true, evolution: object, candidate: object}|{ok: false, code: string, detail?: any}}
 */
export function addCandidate(evolution, agentId, input = {}) {
  const id = normalizeAgentId(agentId);
  if (id === null) return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'agent_id' });
  const prompt = text(input.prompt);
  if (prompt === '') return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'prompt' });
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const copy = ensureEvolution(evolution, id);
  copy.created_at = copy.created_at ?? new Date(now).toISOString();
  copy.updated_at = new Date(now).toISOString();
  const candidate = {
    candidate_id: `cand_${copy.next_id}`,
    prompt,
    metrics: normalizeMetrics(input.metrics),
    notes: text(input.notes, 2_000) || null,
    status: 'candidate',
    comparison: compareMetrics(normalizeMetrics(input.metrics), copy.baseline?.metrics ?? null),
    created_at: new Date(now).toISOString(),
  };
  copy.next_id += 1;
  copy.candidates.push(candidate);
  copy.candidates = copy.candidates.slice(-100);
  return { ok: true, evolution: copy, candidate };
}

/**
 * @param {object|null} evolution
 * @param {string} agentId
 * @param {{candidate_id: string, now?: number}} input
 * @returns {{ok: true, evolution: object, version: object}|{ok: false, code: string, detail?: any}}
 */
export function promoteCandidate(evolution, agentId, input = {}) {
  const id = normalizeAgentId(agentId);
  if (id === null) return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'agent_id' });
  const copy = ensureEvolution(evolution, id);
  const candidate = copy.candidates.find((item) => item.candidate_id === text(input.candidate_id, 80));
  if (candidate === undefined) return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'candidate_id' });
  if (candidate.status !== 'candidate')
    return fail(TEAMS_V2_CODE.EVOLUTION_VERSION_INELIGIBLE, { candidate_id: candidate.candidate_id });
  const comparison = compareMetrics(candidate.metrics, copy.baseline?.metrics ?? null);
  if (comparison.regressions.length > 0) {
    return fail(TEAMS_V2_CODE.EVOLUTION_VERSION_INELIGIBLE, {
      candidate_id: candidate.candidate_id,
      regressions: comparison.regressions,
    });
  }
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const versionNumber = copy.versions.filter((item) => item.kind === 'promoted').length + 1;
  const version = {
    version_id: `v${versionNumber}`,
    kind: 'promoted',
    prompt: candidate.prompt,
    metrics: candidate.metrics,
    candidate_id: candidate.candidate_id,
    parent_version: copy.baseline?.version_id ?? null,
    promoted_at: new Date(now).toISOString(),
  };
  copy.baseline = version;
  copy.versions.push(version);
  copy.updated_at = version.promoted_at;
  candidate.status = 'promoted';
  candidate.promoted_version = version.version_id;
  return { ok: true, evolution: copy, version };
}

/**
 * @param {object|null} evolution
 * @param {string} agentId
 * @param {{version_id: string, now?: number}} input
 * @returns {{ok: true, evolution: object, baseline: object}|{ok: false, code: string, detail?: any}}
 */
export function rollback(evolution, agentId, input = {}) {
  const id = normalizeAgentId(agentId);
  if (id === null) return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'agent_id' });
  const copy = ensureEvolution(evolution, id);
  const version = copy.versions.find((item) => item.version_id === text(input.version_id, 80));
  if (version === undefined)
    return fail(TEAMS_V2_CODE.EVOLUTION_VERSION_NOT_FOUND, { version_id: input.version_id });
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const marker = {
    version_id: `v${copy.versions.filter((item) => item.kind === 'promoted').length + 1}`,
    kind: 'rollback',
    prompt: version.prompt,
    metrics: version.metrics,
    restored_from: version.version_id,
    parent_version: copy.baseline?.version_id ?? null,
    promoted_at: new Date(now).toISOString(),
  };
  copy.baseline = marker;
  copy.versions.push(marker);
  copy.updated_at = marker.promoted_at;
  return { ok: true, evolution: copy, baseline: marker };
}

/**
 * Check all three stop conditions. The result is a decision, not an automatic termination; the
 * caller must stop explicitly.
 *
 * @param {object|null} evolution
 * @param {string} agentId
 * @param {{max_iterations?: number, quality_threshold?: number, patience?: number, metric?: string,
 *   now?: number}} input
 * @returns {object}
 */
export function checkStop(evolution, agentId, input = {}) {
  const id = normalizeAgentId(agentId);
  if (id === null) return fail(TEAMS_V2_CODE.EVOLUTION_INVALID, { field: 'agent_id' });
  const copy = ensureEvolution(evolution, id);
  const maxIterations = Number.isFinite(Number(input.max_iterations))
    ? Math.max(1, Math.min(1_000, Number(input.max_iterations)))
    : 10;
  const qualityThreshold = Number.isFinite(Number(input.quality_threshold))
    ? Math.max(0, Math.min(1, Number(input.quality_threshold)))
    : 0.9;
  const patience = Number.isFinite(Number(input.patience))
    ? Math.max(1, Math.min(100, Number(input.patience)))
    : 3;
  const metric =
    typeof input.metric === 'string' && input.metric.trim() !== '' ? input.metric.trim() : 'pass_rate';
  const iterations = copy.versions.filter((item) => item.kind === 'promoted').length;
  const baselineMetric = copy.baseline?.metrics?.[metric];
  const qualityReached = Number.isFinite(Number(baselineMetric))
    ? Number(baselineMetric) >= qualityThreshold
    : false;
  const history = copy.versions.filter((item) => item.kind === 'promoted').slice(-patience);
  const noImprovement =
    history.length >= patience &&
    history.every((item, index) => {
      if (index === 0) return true;
      const previous = Number(history[index - 1].metrics?.[metric]);
      const current = Number(item.metrics?.[metric]);
      if (!Number.isFinite(previous) || !Number.isFinite(current)) return true;
      return METRIC_DIRECTIONS[metric] === 'lower' ? current >= previous : current <= previous;
    });
  const reasons = [];
  if (iterations >= maxIterations) reasons.push('iteration-limit');
  if (qualityReached) reasons.push('quality-threshold');
  if (noImprovement) reasons.push('no-improvement-patience');
  return {
    ok: true,
    agent_id: id,
    metric,
    iterations,
    max_iterations: maxIterations,
    quality_threshold: qualityThreshold,
    current_metric: Number.isFinite(Number(baselineMetric)) ? Number(baselineMetric) : null,
    patience,
    should_stop: reasons.length > 0,
    reasons,
  };
}

/**
 * @param {object|null} evolution
 * @param {string} agentId
 * @returns {object}
 */
export function summarizeEvolution(evolution, agentId) {
  const copy = ensureEvolution(evolution, agentId);
  return {
    agent_id: copy.agent_id,
    baseline: copy.baseline,
    versions: copy.versions,
    candidates: copy.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      status: candidate.status,
      metrics: candidate.metrics,
      comparison: candidate.comparison,
      notes: candidate.notes,
      created_at: candidate.created_at,
    })),
    created_at: copy.created_at,
    updated_at: copy.updated_at,
  };
}
