/**
 * The dependency graph of a fleet's tasks, as pure functions.
 *
 * ## Why this is separate from the relay's own validation
 *
 * The relay refuses a graph it cannot store (unknown prerequisite, cycle, a self-edge), but that is one call at one moment.
 * A reader looking at a task board asks a different question: of the tasks I can see, which are READY, which are WAITING on
 * something that is still running, and which are BLOCKED because a prerequisite failed or was cancelled? That question
 * depends on the tasks' current states, so it is answered here, over whatever list the reader has.
 *
 * ## The rule that makes "blocked" honest
 *
 * A prerequisite that is missing from the visible list is treated as WAITING, never as ready: the list may be truncated by a
 * limit, and inferring "no dependency" from "not in this page" is how a board would show work as available that is not.
 */
export const TASK_GRAPH_REFUSAL = Object.freeze({
  UNKNOWN_NODE: 'GRAPH_UNKNOWN_NODE',
  CYCLE: 'GRAPH_CYCLE',
  BAD_NODE: 'GRAPH_BAD_NODE',
});

const DONE = new Set(['completed', 'done']);
const FAILED = new Set(['failed', 'cancelled', 'refused']);
// States that mean the task is already in flight. It is not 'ready': ready means work that can be STARTED.
const ACTIVE = new Set(['running', 'queued', 'offered', 'preparing', 'finalizing', 'active']);
/**
 * v1.2.7: the relay's scheduler reports 'waiting' for a task whose prerequisites are unsettled. Reading that as "ready" was the
 * exact board/scheduler disagreement this set closes.
 */
const WAITING = new Set(['waiting']);

/**
 * @param {{nodes?: Array<{task_id?: string, depends_on?: string[]}>}} input
 * @returns {{ok: true, nodes: Map<string, string[]>} | {ok: false, code: string, detail: object}}
 */
export function buildGraph({ nodes = [] } = {}) {
  if (!Array.isArray(nodes)) return { ok: false, code: TASK_GRAPH_REFUSAL.BAD_NODE, detail: {} };
  const map = new Map();
  for (const node of nodes) {
    const id = typeof node?.task_id === 'string' && node.task_id !== '' ? node.task_id : null;
    if (id === null) return { ok: false, code: TASK_GRAPH_REFUSAL.BAD_NODE, detail: { node } };
    const deps = Array.isArray(node.depends_on) ? node.depends_on.filter((dep) => typeof dep === 'string' && dep !== '') : [];
    map.set(id, deps);
  }
  return { ok: true, nodes: map };
}

/**
 * A stable topological order, or the cycle that prevents one.
 *
 * Ties are broken by id so the same graph renders in the same order on every machine -- a board that reshuffles between two
 * reads looks like it is changing.
 *
 * @param {Map<string, string[]>} graph
 * @returns {{ok: true, order: string[]} | {ok: false, code: string, detail: {cycle: string[]}}}
 */
export function topoOrder(graph) {
  const indegree = new Map();
  const dependents = new Map();
  for (const id of graph.keys()) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const [id, deps] of graph.entries()) {
    for (const dep of deps) {
      // A prerequisite OUTSIDE this page is not an edge in it. The relay refuses an unknown prerequisite when the task is
      // created, so a missing one here means the reader's list is truncated -- and treating that as a broken graph would
      // make an ordinary limited read report a cycle.
      if (!graph.has(dep)) continue;
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(id);
    }
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const next of (dependents.get(id) ?? []).slice().sort()) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) { ready.push(next); ready.sort(); }
    }
  }
  if (order.length !== graph.size) {
    const remaining = [...graph.keys()].filter((id) => !order.includes(id));
    return { ok: false, code: TASK_GRAPH_REFUSAL.CYCLE, detail: { cycle: remaining } };
  }
  return { ok: true, order };
}

/**
 * Classify one task against the states of the tasks a reader can see.
 *
 * @param {{task_id: string, depends_on?: string[], status?: string, statuses?: Map<string, string>}} input
 * @returns {'ready'|'waiting'|'blocked'|'done'|'active'|'unknown'}
 */
export function classifyTask({ task_id, depends_on = [], status = null, statuses = new Map() } = {}) {
  if (typeof task_id !== 'string' || task_id === '') return 'unknown';
  if (typeof status === 'string' && DONE.has(status)) return 'done';
  if (typeof status === 'string' && FAILED.has(status)) return 'blocked';
  let waiting = false;
  for (const dep of depends_on) {
    const depStatus = statuses.get(dep);
    if (depStatus === undefined) { waiting = true; continue; }
    if (FAILED.has(depStatus)) return 'blocked';
    if (!DONE.has(depStatus)) waiting = true;
  }
  if (waiting) return 'waiting';
  // In flight ONLY once its prerequisites are satisfied: a queued task behind a failed prerequisite is blocked, not active.
  if (typeof status === 'string' && WAITING.has(status)) return 'waiting';
  if (typeof status === 'string' && ACTIVE.has(status)) return 'active';
  return 'ready';
}

/**
 * The whole board, in one pass: every visible task classified, and the readies in dependency order.
 *
 * @param {{tasks?: Array<{task_id?: string, depends_on?: string[], status?: string}>}} input
 * @returns {{ok: true, by_task: Record<string, string>, ready: string[], waiting: string[], blocked: string[], done: string[], active: string[], order: string[]} |
 *           {ok: false, code: string, detail: object}}
 */
export function buildBoard({ tasks = [] } = {}) {
  const built = buildGraph({ nodes: tasks });
  if (built.ok !== true) return built;
  const statuses = new Map();
  for (const task of tasks) {
    const id = typeof task?.task_id === 'string' ? task.task_id : null;
    if (id !== null) statuses.set(id, typeof task?.status === 'string' ? task.status : 'unknown');
  }
  const byTask = {};
  const buckets = { ready: [], waiting: [], blocked: [], done: [], active: [] };
  for (const [id, deps] of built.nodes.entries()) {
    const kind = classifyTask({ task_id: id, depends_on: deps, status: statuses.get(id), statuses });
    byTask[id] = kind;
    if (kind === 'done') buckets.done.push(id);
    else if (kind === 'active') buckets.active.push(id);
    else if (kind === 'blocked') buckets.blocked.push(id);
    else if (kind === 'waiting') buckets.waiting.push(id);
    else buckets.ready.push(id);
  }
  const order = topoOrder(built.nodes);
  return {
    ok: true,
    by_task: byTask,
    ready: buckets.ready.sort(),
    waiting: buckets.waiting.sort(),
    blocked: buckets.blocked.sort(),
    done: buckets.done.sort(),
    active: buckets.active.sort(),
    order: order.ok === true ? order.order : [],
  };
}
