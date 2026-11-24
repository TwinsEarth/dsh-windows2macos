/**
 * Teams V2 framework registry: a native adapter boundary, not a dependency on three Python
 * frameworks.
 *
 * Every framework is described by the same small contract. `builtin` is the only runnable
 * implementation in this package: it is the deterministic DAG/ledger executor. LangGraph,
 * CrewAI and AutoGen are declared so a plan can record its preference and a caller can see why
 * it fell back, but their adapters are deliberately not shipped here. An adapter registers a
 * `run` function and becomes runnable without changing the orchestrator or the tool surface.
 */

import { TEAMS_V2_CODE, fail } from './v2-store.mjs';

/** Registered external adapters. Process-local; an adapter is not a dependency declaration. */
const ADAPTERS = new Map();

/** Stable names accepted by the V2 tools. `auto` is a selector, not a provider. */
export const FRAMEWORK_NAMES = Object.freeze(['auto', 'builtin', 'langgraph', 'crewai', 'autogen']);

/** Declarative catalog. No URL, credential or executable path belongs in this table. */
export const FRAMEWORK_CATALOG = Object.freeze({
  builtin: Object.freeze({
    name: 'builtin',
    label: 'Built-in DAG executor',
    runnable: true,
    capabilities: Object.freeze(['dag', 'ledger', 'verification', 'cache', 'evolution']),
    reason: null,
  }),
  langgraph: Object.freeze({
    name: 'langgraph',
    label: 'LangGraph',
    runnable: false,
    capabilities: Object.freeze(['dag', 'state', 'checkpoint']),
    reason: 'adapter-not-installed',
  }),
  crewai: Object.freeze({
    name: 'crewai',
    label: 'CrewAI',
    runnable: false,
    capabilities: Object.freeze(['roles', 'sequential', 'delegation']),
    reason: 'adapter-not-installed',
  }),
  autogen: Object.freeze({
    name: 'autogen',
    label: 'AutoGen',
    runnable: false,
    capabilities: Object.freeze(['conversation', 'debate', 'multi-agent']),
    reason: 'adapter-not-installed',
  }),
});

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
}

/**
 * Normalize a framework request. An unknown name is rejected; it is not silently downgraded.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string|null}
 */
export function normalizeFramework(value, fallback = 'auto') {
  const name = text(value) ?? text(fallback) ?? 'auto';
  return FRAMEWORK_NAMES.includes(name) ? name : null;
}

/**
 * Register a native adapter for a framework. The adapter contract is one function:
 * `run(step, context) -> {ok, output}`. This package calls no external process; the adapter is
 * supplied by the host that actually has the framework.
 *
 * @param {unknown} name
 * @param {{run?: Function}} adapter
 * @returns {{ok: true, name: string, runnable: true, reason: null}|{ok: false, code: string, detail?: any}}
 */
export function registerFrameworkAdapter(name, adapter) {
  const normalized = normalizeFramework(name);
  if (normalized === null || normalized === 'auto') {
    return fail(TEAMS_V2_CODE.FRAMEWORK_INVALID, { framework: String(name ?? '') });
  }
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.run !== 'function') {
    return fail(TEAMS_V2_CODE.FRAMEWORK_UNAVAILABLE, { framework: normalized, reason: 'adapter-has-no-run' });
  }
  ADAPTERS.set(normalized, adapter);
  return { ok: true, name: normalized, runnable: true, reason: null };
}

/**
 * @param {unknown} name
 * @returns {object|null}
 */
export function getFrameworkAdapter(name) {
  const normalized = normalizeFramework(name);
  return normalized === null ? null : (ADAPTERS.get(normalized) ?? null);
}

/** Test hook: forget registered adapters so a selection test starts from the shipped catalog. */
export function resetFrameworkAdaptersForTests() {
  ADAPTERS.clear();
}

/**
 * The built-in executor: a local handler table, not a shell. A handler receives `{step, context}`
 * and returns whatever the ledger should record. There is no default command and no dispatch.
 *
 * @param {Record<string, Function>} [handlers]
 * @returns {{name: string, runnable: true, run: (step: object, context?: object) => Promise<object>}}
 */
export function createBuiltinExecutor(handlers = {}) {
  const table = handlers !== null && typeof handlers === 'object' ? handlers : {};
  return {
    name: 'builtin',
    runnable: true,
    async run(step = {}, context = {}) {
      const key = text(step?.task_type) ?? text(step?.agent) ?? 'default';
      const handler = table[key] ?? table.default;
      if (typeof handler !== 'function') {
        return fail(TEAMS_V2_CODE.FRAMEWORK_UNAVAILABLE, { framework: 'builtin', reason: 'no-handler', key });
      }
      try {
        const output = await handler({ step, context });
        return { ok: true, framework: 'builtin', output };
      } catch (error) {
        return fail(TEAMS_V2_CODE.FRAMEWORK_UNAVAILABLE, {
          framework: 'builtin',
          reason: 'handler-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/**
 * A read-only catalog safe to return from a tool. It contains no credentials and no paths.
 * `runnable` becomes true only when an adapter has actually been registered.
 *
 * @returns {object[]}
 */
export function listFrameworks() {
  return Object.values(FRAMEWORK_CATALOG).map((entry) => {
    const installed = entry.name === 'builtin' || ADAPTERS.has(entry.name);
    return {
      name: entry.name,
      label: entry.label,
      runnable: installed,
      capabilities: [...entry.capabilities],
      reason: installed ? null : entry.reason,
    };
  });
}

/**
 * Choose a framework from a task shape and explicitly report whether it can run here.
 *
 * The fallback is part of the result: `requested=langgraph, effective=builtin` is visible to the
 * caller instead of pretending that a missing adapter succeeded.
 *
 * @param {{requested?: unknown, task_type?: unknown, complexity?: unknown, requires?: unknown}} [input]
 * @returns {{requested: string, selected: string, effective: string, runnable: boolean,
 *   reason: string|null, capabilities: string[]}}
 */
export function selectFramework(input = {}) {
  const requested = normalizeFramework(input.requested, 'auto');
  if (requested === null) {
    return {
      requested: null,
      selected: 'builtin',
      effective: 'builtin',
      runnable: true,
      reason: 'unknown-framework',
      capabilities: [...FRAMEWORK_CATALOG.builtin.capabilities],
    };
  }
  const taskType = text(input.task_type) ?? 'general';
  const complexity = Number.isFinite(Number(input.complexity))
    ? Math.max(0, Math.min(1, Number(input.complexity)))
    : 0;
  const requires = Array.isArray(input.requires)
    ? input.requires.map((value) => text(value)).filter((value) => value !== null)
    : [];

  let selected = 'builtin';
  if (requested !== 'auto') selected = requested;
  else if (requires.some((value) => ['debate', 'conversation'].includes(value)) || taskType === 'debate')
    selected = 'autogen';
  else if (
    requires.some((value) => ['roles', 'sequential', 'delegation'].includes(value)) ||
    taskType === 'role-play'
  )
    selected = 'crewai';
  else if (requires.some((value) => ['dag', 'checkpoint', 'state'].includes(value)) || complexity >= 0.6)
    selected = 'langgraph';

  const descriptor = FRAMEWORK_CATALOG[selected] ?? FRAMEWORK_CATALOG.builtin;
  const installed = descriptor.name === 'builtin' || ADAPTERS.has(descriptor.name);
  const effective = installed ? descriptor.name : 'builtin';
  return {
    requested,
    selected: descriptor.name,
    effective,
    runnable: installed,
    reason: installed ? null : descriptor.reason,
    capabilities: [...descriptor.capabilities],
  };
}
