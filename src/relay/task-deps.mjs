/**
 * Task dependencies: a task may name prerequisites, and the graph is validated where the task is CREATED.
 *
 * ## Why the refusal belongs at enqueue time
 *
 * A dependency checked when a worker picks the task up puts the refusal on a machine that did not create the problem, at a
 * time when the operator has long stopped looking. Everything here is a pure function over the tasks already known, so the
 * relay can answer "is this graph sound" before it stores anything.
 *
 * ## What is refused, and why each one is a refusal rather than a warning
 *
 * - a dependency on a task that does not exist: it can never complete, so the task can never be ready;
 * - a self-dependency and any cycle: no topological order exists, so "ready" would never arrive;
 * - a duplicate id in the list: the same edge stated twice is not two edges, and accepting it would make the stored list
 *   disagree with the graph it describes.
 */
export const TASK_DEPS_REFUSAL = Object.freeze({
  DEPENDS_ON_NOT_ARRAY: 'TASK_DEPENDS_ON_NOT_ARRAY',
  DEPENDENCY_UNKNOWN: 'TASK_DEPENDENCY_UNKNOWN',
  DEPENDENCY_SELF: 'TASK_DEPENDENCY_SELF',
  DEPENDENCY_DUPLICATE: 'TASK_DEPENDENCY_DUPLICATE',
  DEPENDENCY_CYCLE: 'TASK_DEPENDENCY_CYCLE',
  MAX_DEPENDENCIES: 'TASK_DEPENDENCY_TOO_MANY',
});

/** A cap exists so a hostile caller cannot make the cycle check quadratic without bound. */
export const MAX_DEPENDENCIES = 32;

/**
 * Walk the ancestors of a task id and report whether a new edge would close a cycle.
 *
 * @param {string} from the dependency being added
 * @param {string} target the task being created
 * @param {Map<string, object>} tasksById
 * @returns {string[]|null} the cycle path when one exists, null otherwise
 */
export function wouldCycle(from, target, tasksById) {
  const seen = new Set();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === target) return [target, from];
    if (seen.has(id)) continue;
    seen.add(id);
    const task = tasksById.get(id) ?? null;
    const deps = Array.isArray(task?.depends_on) ? task.depends_on : [];
    for (const dep of deps) stack.push(dep);
  }
  return null;
}

/**
 * @param {{task_id?: string|null, depends_on?: unknown, tasksById?: Map<string, object>}} input
 * @returns {{ok: true, depends_on: string[]} | {ok: false, code: string, detail?: object}}
 */
export function validateTaskDependencies({ task_id = null, depends_on = null, tasksById = new Map() } = {}) {
  if (depends_on === undefined || depends_on === null) return { ok: true, depends_on: [] };
  if (!Array.isArray(depends_on)) return { ok: false, code: TASK_DEPS_REFUSAL.DEPENDS_ON_NOT_ARRAY };
  if (depends_on.length > MAX_DEPENDENCIES) {
    return { ok: false, code: TASK_DEPS_REFUSAL.MAX_DEPENDENCIES, detail: { count: depends_on.length, max: MAX_DEPENDENCIES } };
  }
  const list = [];
  for (const dep of depends_on) {
    if (typeof dep !== 'string' || dep === '') {
      return { ok: false, code: TASK_DEPS_REFUSAL.DEPENDENCY_UNKNOWN, detail: { dependency: dep } };
    }
    if (task_id !== null && dep === task_id) return { ok: false, code: TASK_DEPS_REFUSAL.DEPENDENCY_SELF, detail: { task_id } };
    if (list.includes(dep)) return { ok: false, code: TASK_DEPS_REFUSAL.DEPENDENCY_DUPLICATE, detail: { dependency: dep } };
    if (!tasksById.has(dep)) return { ok: false, code: TASK_DEPS_REFUSAL.DEPENDENCY_UNKNOWN, detail: { dependency: dep } };
    const cycle = task_id === null ? null : wouldCycle(dep, task_id, tasksById);
    if (cycle !== null) return { ok: false, code: TASK_DEPS_REFUSAL.DEPENDENCY_CYCLE, detail: { path: cycle } };
    list.push(dep);
  }
  return { ok: true, depends_on: list };
}

/**
 * What a task may do, given its prerequisites' states.
 *
 * @param {{depends_on?: string[], tasksById?: Map<string, object>}} input
 * @returns {'ready'|'blocked'|'waiting'}
 */
export function readinessOf({ depends_on = [], tasksById = new Map() } = {}) {
  let waiting = false;
  for (const dep of depends_on) {
    const task = tasksById.get(dep) ?? null;
    const status = typeof task?.status === 'string' ? task.status : 'unknown';
    if (status === 'failed' || status === 'cancelled' || status === 'refused') return 'blocked';
    if (status !== 'completed' && status !== 'done') waiting = true;
  }
  return waiting ? 'waiting' : 'ready';
}
