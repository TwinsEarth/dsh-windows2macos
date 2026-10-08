/**
 * W2M relay — Prometheus metrics (v0.3.3 "metrics" item).
 *
 * A machine-readable surface so a fleet can be monitored without a human reading
 * reports. Text exposition format 0.0.4.
 *
 * ## The rule this module exists to get right: absent is not zero
 *
 * `w2m_rtt_ms` is emitted ONLY for machines that have actually reported a
 * round-trip time. A machine that never reported has **no series at all**.
 *
 * That is not a stylistic choice. In Prometheus a `0` is a real measurement --
 * "this machine answered instantaneously" -- while a missing series is what
 * `absent()` and `unless` are for. Emitting `0` for "unknown" would make a fleet
 * of silent machines look like a fleet of perfectly fast ones, which is the
 * worst possible failure mode for a latency dashboard: it fails toward "all
 * good". The same null-vs-zero distinction runs through the rest of this project
 * (`rtt_ms: null` in `/v1/agents/{id}/status`, `avg_ms: null` in `/healthz`).
 *
 * ## Why some series carry a `stale` companion
 *
 * A machine that reported 40ms and then vanished keeps that series forever; a
 * dashboard would read "40ms" from a machine that is gone. `w2m_rtt_stale`
 * therefore distinguishes the two readings the same way `rtt_stale` does in the
 * HTTP API: a genuinely slow machine is `w2m_rtt_ms > X and w2m_rtt_stale == 0`.
 *
 * ## Determinism
 *
 * `renderMetrics` never reads the wall clock: `nowMs` is a parameter. Series are
 * sorted, so two renders of the same state are byte-identical -- which is what
 * makes the output testable instead of merely plausible.
 */

import { AGGREGATE_STATUSES, aggregate } from './report.mjs';

/** Content type for the text exposition format. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Prefix for every metric this module emits. */
export const METRIC_PREFIX = 'w2m_';

/**
 * Escape a label VALUE for the text exposition format.
 *
 * The format defines exactly three escapes: backslash, double quote and newline.
 * A bare carriage return has no escape defined and would break the line
 * structure, so it is folded into the newline escape: keeping the body parseable
 * matters more than preserving a byte that no metric label should contain.
 */
export function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Escape HELP text (only backslash and newline are meaningful there). */
function escapeHelpText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n');
}

/** `name{label="escaped",...} value`, or `name value` with no labels. */
function sample(name, labels, value) {
  const keys = Object.keys(labels ?? {});
  if (keys.length === 0) return `${name} ${value}`;
  const rendered = keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',');
  return `${name}{${rendered}} ${value}`;
}

/** A `# HELP` / `# TYPE` header followed by its samples. */
function family(name, help, type, lines) {
  return [`# HELP ${name} ${escapeHelpText(help)}`, `# TYPE ${name} ${type}`, ...lines];
}

/** Prometheus text format values are Go floats; keep integers integral. */
function formatNumber(value) {
  if (!Number.isFinite(value)) return null; // never emit NaN/Inf by accident
  return Number.isInteger(value) ? String(value) : String(value);
}

/**
 * Count leases by state across every tracked task.
 *
 * Only observed states get a series. Unlike aggregate verdicts there is no
 * frozen, exported list of lease states to iterate, and inventing one here is
 * exactly the "hardcoded list that silently misses a new member" problem -- for
 * a gauge, an absent series already reads as zero.
 */
function leaseCounts(state) {
  const counts = new Map();
  for (const task of state.tasks.values()) {
    for (const lease of task.leases.values()) {
      const key = String(lease.state);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Aggregate verdict counts, one entry per `AGGREGATE_STATUSES` member.
 *
 * The list is IMPORTED, never restated: a future verdict added to report.mjs must
 * appear here automatically. Hardcoding it would mean a new verdict silently has
 * no series, and a dashboard would show "no tasks" instead of "a state nobody
 * taught the metrics layer about".
 *
 * Results are grouped by task first so this stays O(results) rather than
 * O(tasks x results) per scrape.
 */
function taskStatusCounts(state, nowMs) {
  const byTask = new Map();
  for (const record of state.results.values()) {
    const taskId = record?.envelope?.task_id;
    if (typeof taskId !== 'string') continue;
    let bucket = byTask.get(taskId);
    if (bucket === undefined) {
      bucket = [];
      byTask.set(taskId, bucket);
    }
    bucket.push(record);
  }

  const counts = new Map(AGGREGATE_STATUSES.map((status) => [status, 0]));
  for (const task of state.tasks.values()) {
    let verdict;
    try {
      verdict = aggregate(task, byTask.get(task.task_id) ?? [], { nowMs }).status;
    } catch {
      // A task that cannot be aggregated is a bug, but a metrics scrape must never
      // be the thing that takes the relay down. It is left out of every bucket
      // rather than being counted as a verdict it does not have.
      continue;
    }
    if (counts.has(verdict)) counts.set(verdict, counts.get(verdict) + 1);
  }
  return counts;
}

/**
 * Collect every metric as plain data, separately from rendering it.
 *
 * Exported because the interesting part of this module is the numbers, and a
 * test that asserts on numbers is far clearer than one that greps text.
 *
 * @param {object} state - A `RabbitState` (or anything with the same shape).
 * @param {{nowMs?: number}} [options] - `nowMs` defaults to `state.nowMs()`.
 * @returns {{nowMs:number, gauges:object, taskStatus:Map<string,number>, leases:Array<[string,number]>, rtt:Array<{machine_id:string, rtt_ms:number, stale:boolean, age_ms:number|null}>}}
 */
export function collectMetrics(state, { nowMs } = {}) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('collectMetrics(state): state is required');
  }
  const at = nowMs ?? (typeof state.nowMs === 'function' ? state.nowMs() : 0);

  let online = 0;
  for (const device of state.devices.values()) {
    if (device.online === true) online += 1;
  }

  // ONLY machines that reported. `rtt_ms === 0` is a real measurement and is kept;
  // `null`/`undefined` means "never measured" and must produce no series at all.
  const rtt = [];
  for (const device of state.devices.values()) {
    const value = device.rtt_ms;
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value)) continue; // defensive: state validates, but never emit NaN
    const stale = typeof state.isRttStale === 'function'
      ? state.isRttStale(device, at) === true
      : false;
    const age = typeof state.rttAgeMs === 'function' ? state.rttAgeMs(device, at) : null;
    rtt.push({ machine_id: String(device.machine_id), rtt_ms: value, stale, age_ms: age });
  }
  rtt.sort((a, b) => (a.machine_id < b.machine_id ? -1 : a.machine_id > b.machine_id ? 1 : 0));

  return {
    nowMs: at,
    gauges: {
      devices: state.devices.size,
      devices_online: online,
      tasks: state.tasks.size,
      results: state.results.size,
    },
    taskStatus: taskStatusCounts(state, at),
    leases: leaseCounts(state),
    rtt,
  };
}

/**
 * Render the Prometheus text exposition format.
 *
 * @param {object} state - A `RabbitState`.
 * @param {{nowMs?: number}} [options] - Deterministic clock injection.
 * @returns {string} The exposition body, ending in a single newline.
 */
export function renderMetrics(state, { nowMs } = {}) {
  const data = collectMetrics(state, { nowMs });
  const lines = [];

  lines.push(...family(
    `${METRIC_PREFIX}devices`,
    'Number of devices paired with this relay.',
    'gauge',
    [sample(`${METRIC_PREFIX}devices`, {}, data.gauges.devices)],
  ));

  lines.push(...family(
    `${METRIC_PREFIX}devices_online`,
    'Number of paired devices currently marked online.',
    'gauge',
    [sample(`${METRIC_PREFIX}devices_online`, {}, data.gauges.devices_online)],
  ));

  lines.push(...family(
    `${METRIC_PREFIX}tasks`,
    'Number of tasks the relay is tracking in memory.',
    'gauge',
    [sample(`${METRIC_PREFIX}tasks`, {}, data.gauges.tasks)],
  ));

  lines.push(...family(
    `${METRIC_PREFIX}results`,
    'Number of result envelopes recorded (per machine, dedupe key and attempt).',
    'gauge',
    [sample(`${METRIC_PREFIX}results`, {}, data.gauges.results)],
  ));

  // One series per AGGREGATE_STATUSES entry, INCLUDING zeros: a verdict that no
  // task currently holds still exists as a concept, and a dashboard that plots a
  // fixed set of statuses should not see series appear and vanish.
  //
  // TYPE is `gauge`, not `counter`, on purpose. These are current verdict counts:
  // a task moving pending -> consistent decrements one and increments another.
  // A counter that can go down makes `rate()` meaningless and breaks the
  // "counter resets to 0 on restart" contract Prometheus relies on.
  lines.push(...family(
    `${METRIC_PREFIX}task_status_total`,
    'Number of tracked tasks whose current aggregate verdict is this status.',
    'gauge',
    AGGREGATE_STATUSES.map((status) => sample(
      `${METRIC_PREFIX}task_status_total`,
      { status },
      data.taskStatus.get(status) ?? 0,
    )),
  ));

  lines.push(...family(
    `${METRIC_PREFIX}leases`,
    'Number of task leases in each lease state.',
    'gauge',
    data.leases.map(([leaseState, count]) => sample(`${METRIC_PREFIX}leases`, { state: leaseState }, count)),
  ));

  // The null-vs-zero contract, in the exposition format.
  const rttLines = [];
  for (const entry of data.rtt) {
    const formatted = formatNumber(entry.rtt_ms);
    if (formatted === null) continue;
    rttLines.push(sample(`${METRIC_PREFIX}rtt_ms`, { machine_id: entry.machine_id }, formatted));
  }
  lines.push(...family(
    `${METRIC_PREFIX}rtt_ms`,
    'Last reported round-trip time to this machine, in milliseconds. '
    + 'A machine that has never reported one has NO series here: absent, not 0.',
    'gauge',
    rttLines,
  ));

  // Companion to the above: 1 when the stored measurement is older than the
  // staleness window. Emitted only alongside an actual measurement, so a machine
  // that never reported stays absent here too.
  lines.push(...family(
    `${METRIC_PREFIX}rtt_stale`,
    '1 when this machine\'s last RTT measurement is older than the staleness window, else 0. '
    + 'Only emitted for machines that have reported an RTT.',
    'gauge',
    data.rtt.map((entry) => sample(`${METRIC_PREFIX}rtt_stale`, { machine_id: entry.machine_id }, entry.stale ? 1 : 0)),
  ));

  return `${lines.join('\n')}\n`;
}

export default renderMetrics;
