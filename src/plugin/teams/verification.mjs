/**
 * Teams V2 verification: one isolated, deterministic verifier with four modes.
 *
 * The important boundary is context isolation: this function accepts checks, evidence and a
 * process trace, and rejects executor context. A future LLM judge can replace the aggregation
 * function through the same result shape, but it must keep the same isolation rule.
 */

import { TEAMS_V2_CODE, digestJson, fail } from './v2-store.mjs';

export const VERIFY_MODES = Object.freeze(['score', 'reflexion', 'debate', 'process']);
export const VERIFIER_ID = 'builtin-evidence-v1';
export const DEFAULT_VERIFY_THRESHOLD = 0.8;

const FORBIDDEN_CONTEXT_KEYS = [
  'executor_context',
  'executor_trace',
  'raw_context',
  'messages',
  'transcript',
];

const text = (value, max = 4_000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
};

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeStatus(value) {
  const status = text(value, 20).toLowerCase();
  return ['pass', 'fail', 'missing'].includes(status) ? status : 'missing';
}

/**
 * @param {any[]} input
 * @returns {object[]}
 */
function normalizeChecks(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 40).map((check, index) => ({
    id: text(check?.id, 80) || `c${index + 1}`,
    status: normalizeStatus(check?.status),
    weight: clamp(check?.weight, 0.01, 10, 1),
    critical: check?.critical === true,
    detail: text(check?.detail, 500) || null,
  }));
}

/**
 * @param {object[]} checks
 * @param {number} threshold
 * @returns {object}
 */
function scoreChecks(checks, threshold) {
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const passedWeight = checks
    .filter((check) => check.status === 'pass')
    .reduce((sum, check) => sum + check.weight, 0);
  const criticalFailure = checks.some((check) => check.critical && check.status !== 'pass');
  const findings = checks
    .filter((check) => check.status !== 'pass')
    .map((check) => `${check.id}:${check.status}${check.detail === null ? '' : `:${check.detail}`}`);
  const score = totalWeight === 0 ? 0 : passedWeight / totalWeight;
  const verdict = criticalFailure || score < threshold ? 'fail' : 'pass';
  return {
    verdict,
    score: Number(score.toFixed(4)),
    threshold,
    critical_failure: criticalFailure,
    findings,
  };
}

/**
 * @param {object} verification
 * @returns {object}
 */
function withEnvelope(verification) {
  return {
    ok: true,
    verifier_id: VERIFIER_ID,
    context_isolated: true,
    verification_id: `v_${digestJson(verification).slice(0, 16)}`,
    ...verification,
  };
}

/**
 * Verify a single artifact/step.
 *
 * @param {object} input
 * @param {string} [input.mode]
 * @param {any[]} [input.checks]
 * @param {any[]} [input.evidence]
 * @param {any[]} [input.step_trace]
 * @param {any[]} [input.support]
 * @param {any[]} [input.challenge]
 * @param {string} [input.artifact_summary]
 * @param {number} [input.threshold]
 * @returns {{ok: true, verdict: string, mode: string, score: number, threshold: number}}|{ok: false, code: string, detail?: any}
 */
export function verify(input = {}) {
  for (const key of FORBIDDEN_CONTEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined && input[key] !== null) {
      return fail(TEAMS_V2_CODE.CONTEXT_NOT_ISOLATED, { field: key });
    }
  }
  const mode = text(input.mode, 30).toLowerCase() || 'score';
  if (!VERIFY_MODES.includes(mode)) {
    return fail(TEAMS_V2_CODE.CHECKS_REQUIRED, { field: 'mode', mode });
  }
  const threshold = clamp(input.threshold, 0.5, 1, DEFAULT_VERIFY_THRESHOLD);
  const checks = normalizeChecks(input.checks ?? input.evidence);

  if (mode === 'process') {
    if (!Array.isArray(input.step_trace) || input.step_trace.length === 0) {
      return fail(TEAMS_V2_CODE.PROCESS_TRACE_REQUIRED);
    }
    const trace = input.step_trace.slice(0, 64).map((step, index) => ({
      step_id: text(step?.step_id, 64) || `s${index + 1}`,
      status: text(step?.status, 20).toLowerCase() || 'pending',
      depends_on: Array.isArray(step?.depends_on)
        ? step.depends_on.map((value) => text(value, 64)).filter(Boolean)
        : [],
      evidence: Array.isArray(step?.evidence) ? step.evidence.length : 0,
    }));
    const byId = new Map(trace.map((step) => [step.step_id, step]));
    const findings = [];
    for (const step of trace) {
      if (step.status === 'failed' || step.status === 'skipped')
        findings.push(`${step.step_id}:${step.status}`);
      if (step.status === 'done' && step.evidence === 0)
        findings.push(`${step.step_id}:done-without-evidence`);
      for (const dependency of step.depends_on) {
        const source = byId.get(dependency);
        if (source === undefined) findings.push(`${step.step_id}:missing-dependency:${dependency}`);
        else if (source.status !== 'done') findings.push(`${step.step_id}:dependency-not-done:${dependency}`);
      }
    }
    const done = trace.filter((step) => step.status === 'done').length;
    const score = trace.length === 0 ? 0 : done / trace.length;
    return withEnvelope({
      mode,
      verdict: findings.length === 0 && score >= threshold ? 'pass' : 'fail',
      score: Number(score.toFixed(4)),
      threshold,
      checks,
      findings,
      step_trace: trace,
    });
  }

  if (mode === 'debate') {
    const support = normalizeChecks(input.support);
    const challenge = normalizeChecks(input.challenge);
    if (support.length === 0 && challenge.length === 0) {
      return fail(TEAMS_V2_CODE.CHECKS_REQUIRED, { mode });
    }
    const supportScore = scoreChecks(support, threshold);
    const challengeScore = scoreChecks(challenge, threshold);
    let verdict = 'fail';
    let resolution = 'challenge-prevails';
    if (challengeScore.critical_failure) {
      verdict = 'fail';
      resolution = 'challenge-critical';
    } else if (supportScore.verdict === 'pass' && challengeScore.verdict === 'fail') {
      verdict = 'pass';
      resolution = 'support-prevails';
    } else if (supportScore.verdict === 'pass' && challengeScore.verdict === 'pass') {
      verdict = 'escalate';
      resolution = 'both-sides-hold';
    }
    return withEnvelope({
      mode,
      verdict,
      score: supportScore.score,
      threshold,
      resolution,
      support: supportScore,
      challenge: challengeScore,
      checks: [...support, ...challenge],
      findings: [...supportScore.findings, ...challengeScore.findings],
    });
  }

  const scored = scoreChecks(checks, threshold);
  if (checks.length === 0) return fail(TEAMS_V2_CODE.CHECKS_REQUIRED, { mode });
  if (mode === 'reflexion') {
    return withEnvelope({
      mode,
      ...scored,
      checks,
      lesson: scored.findings.length === 0 ? null : `retry after: ${scored.findings.slice(0, 3).join('; ')}`,
      next_action: scored.verdict === 'pass' ? 'stop' : 'retry',
    });
  }
  return withEnvelope({ mode: 'score', ...scored, checks });
}
