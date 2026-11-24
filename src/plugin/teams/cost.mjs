/**
 * Teams V2 cost ledger: cache first, route second.
 *
 * The units are deliberately abstract (`cost_units`), not currency. The package does not know a
 * provider's price sheet and must not pretend to. A provider adapter can map one unit to its own
 * billing unit; the ordering and the cache-vs-route comparison stay the same.
 */

import { TEAMS_V2_CODE, fail } from './v2-store.mjs';

/** Planning defaults, chosen to make the lever visible; they are not vendor prices. */
export const COST_UNITS = Object.freeze({
  small_input: 1,
  small_output: 2,
  large_input: 6,
  large_output: 10,
});

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
};

/**
 * @param {unknown} value
 * @returns {string}
 */
function modelTier(value) {
  return value === 'large' ? 'large' : 'small';
}

/**
 * @param {{model?: string, input_tokens?: number, output_tokens?: number}} input
 * @returns {number}
 */
export function estimateModelUnits(input = {}) {
  const tier = modelTier(input.model);
  const inputTokens = clamp(input.input_tokens, 0, 10_000_000, 0);
  const outputTokens = clamp(input.output_tokens, 0, 10_000_000, 0);
  return Number(
    (
      (inputTokens / 1_000) * COST_UNITS[`${tier}_input`] +
      (outputTokens / 1_000) * COST_UNITS[`${tier}_output`]
    ).toFixed(4),
  );
}

/**
 * A planning quote with the leverage of cache-first versus model-tier routing. The defaults are
 * assumptions, not claims: `assumption_based: true` is returned so a caller cannot mistake them
 * for measured production numbers.
 *
 * @param {{requests?: number, cache_hit_rate?: number, cache_read_cost_ratio?: number,
 *   model_route_reduction?: number, baseline_unit?: number}} [input]
 * @returns {object}
 */
export function quoteCost(input = {}) {
  const requests = clamp(input.requests, 1, 1_000_000, 100);
  const hitRate = clamp(input.cache_hit_rate, 0, 1, 0.5);
  const readRatio = clamp(input.cache_read_cost_ratio, 0, 1, 0.05);
  const routeReduction = clamp(input.model_route_reduction, 0, 1, 0.05);
  const baselineUnit = clamp(input.baseline_unit, 0.01, 1_000, COST_UNITS.large_input);
  const baseline = requests * baselineUnit;
  const cacheSaved = baseline * hitRate * (1 - readRatio);
  const routeSaved = baseline * routeReduction;
  const cacheLever = routeSaved === 0 ? null : Number((cacheSaved / routeSaved).toFixed(2));
  return {
    order: ['cache', 'route'],
    assumption_based: true,
    inputs: {
      requests,
      cache_hit_rate: hitRate,
      cache_read_cost_ratio: readRatio,
      model_route_reduction: routeReduction,
      baseline_unit: baselineUnit,
    },
    baseline_units: Number(baseline.toFixed(4)),
    cache_saved_units: Number(cacheSaved.toFixed(4)),
    route_saved_units: Number(routeSaved.toFixed(4)),
    cache_first_cost_units: Number((baseline - cacheSaved - routeSaved).toFixed(4)),
    cache_lever: cacheLever,
  };
}

/**
 * @returns {object}
 */
export function createCostLedger() {
  return {
    cache_hits: 0,
    cache_misses: 0,
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_units: 0,
    cache_saved_units: 0,
    route_saved_units: 0,
    by_step: {},
  };
}

/**
 * Record one step's cost. A cache hit avoids the model entirely; a miss records the chosen tier and
 * compares it with the large-tier baseline to make `route_saved_units` meaningful.
 *
 * @param {object} ledger
 * @param {{model?: string, cache?: string, input_tokens?: number, output_tokens?: number,
 *   step_id?: string}} input
 * @returns {{ok: true, ledger: object, record: object}|{ok: false, code: string, detail?: any}}
 */
export function recordCost(ledger, input = {}) {
  if (!['hit', 'miss'].includes(input.cache))
    return fail(TEAMS_V2_CODE.COST_INPUT_INVALID, { field: 'cache' });
  const tier = modelTier(input.model);
  const inputTokens = clamp(input.input_tokens, 0, 10_000_000, 0);
  const outputTokens = clamp(input.output_tokens, 0, 10_000_000, 0);
  const actual = estimateModelUnits({ model: tier, input_tokens: inputTokens, output_tokens: outputTokens });
  const largeBaseline = estimateModelUnits({
    model: 'large',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
  const copy = structuredClone(ledger ?? createCostLedger());
  const stepId =
    typeof input.step_id === 'string' && input.step_id.trim() !== '' ? input.step_id.trim() : null;
  const cacheHit = input.cache === 'hit';
  copy.cache_hits += cacheHit ? 1 : 0;
  copy.cache_misses += cacheHit ? 0 : 1;
  copy.model_calls += cacheHit ? 0 : 1;
  copy.input_tokens += inputTokens;
  copy.output_tokens += outputTokens;
  copy.cost_units = Number((copy.cost_units + (cacheHit ? 0 : actual)).toFixed(4));
  copy.cache_saved_units = Number((copy.cache_saved_units + (cacheHit ? largeBaseline : 0)).toFixed(4));
  copy.route_saved_units = Number(
    (copy.route_saved_units + (cacheHit ? 0 : Math.max(0, largeBaseline - actual))).toFixed(4),
  );
  if (stepId !== null) {
    const previous = copy.by_step[stepId] ?? {
      cache_hits: 0,
      cache_misses: 0,
      cost_units: 0,
      input_tokens: 0,
      output_tokens: 0,
    };
    previous.cache_hits += cacheHit ? 1 : 0;
    previous.cache_misses += cacheHit ? 0 : 1;
    previous.cost_units = Number((previous.cost_units + (cacheHit ? 0 : actual)).toFixed(4));
    previous.input_tokens += inputTokens;
    previous.output_tokens += outputTokens;
    copy.by_step[stepId] = previous;
  }
  const record = {
    step_id: stepId,
    cache: input.cache,
    model: tier,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_units: cacheHit ? 0 : actual,
    avoided_units: cacheHit ? largeBaseline : 0,
  };
  return { ok: true, ledger: copy, record };
}

/**
 * @param {object} ledger
 * @returns {object}
 */
export function summarizeCost(ledger = createCostLedger()) {
  const requests = ledger.cache_hits + ledger.cache_misses;
  return {
    ...ledger,
    requests,
    cache_hit_rate: requests === 0 ? 0 : Number((ledger.cache_hits / requests).toFixed(3)),
    cache_lever:
      ledger.route_saved_units === 0
        ? null
        : Number((ledger.cache_saved_units / ledger.route_saved_units).toFixed(2)),
    order: ['cache', 'route'],
  };
}
