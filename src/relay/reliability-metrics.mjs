/**
 * Reliability metrics registry (M7, v1.3.10-beta.22 slice).
 *
 * M7 requires every capability to be measurable from relay-owned data with one definition per metric. This registry is that
 * definition: it declares which metric names exist, which labels each one may carry, and which are histograms. An undeclared
 * name, or a label the definition does not allow, is refused immediately rather than producing a surprise on a dashboard.
 *
 * Cardinality is a rule, not a suggestion: high-cardinality identifiers (task ids, dedupe keys, review ids) are REJECTED as
 * label keys, because one label per task is how a metrics endpoint becomes a memory leak.
 */
export const FORBIDDEN_LABELS = Object.freeze(['task_id', 'dedupe_key', 'review_id', 'lock_id', 'notification_id', 'session_id']);

const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000];

/** name -> {type, labels, buckets?}: the whole contract, in one place. */
export const METRIC_DEFINITIONS = Object.freeze({
  wm_tasks_total: { type: 'counter', labels: ['status', 'mode'] },
  wm_task_duration_ms: { type: 'histogram', labels: ['status', 'mode'], buckets: DEFAULT_BUCKETS },
  wm_task_requeued_total: { type: 'counter', labels: ['reason'] },
  wm_lease_expired_total: { type: 'counter', labels: ['reason'] },
  wm_result_duplicate_total: { type: 'counter', labels: [] },
  wm_dependency_released_total: { type: 'counter', labels: [] },
  wm_grant_issued_total: { type: 'counter', labels: ['machine_scope'] },
  wm_grant_denied_total: { type: 'counter', labels: ['code'] },
  wm_grant_expired_total: { type: 'counter', labels: [] },
  wm_maintenance_requests_total: { type: 'counter', labels: ['action', 'outcome'] },
  wm_maintenance_rollback_total: { type: 'counter', labels: [] },
  wm_blob_upload_sessions_total: { type: 'counter', labels: ['state'] },
  wm_blob_chunks_total: { type: 'counter', labels: ['retried'] },
  wm_blob_resume_total: { type: 'counter', labels: [] },
  wm_blob_bytes_total: { type: 'counter', labels: ['mode'] },
  wm_blob_sha_mismatch_total: { type: 'counter', labels: [] },
  wm_agent_outbox_depth: { type: 'gauge', labels: [] },
  wm_agent_outbox_dropped_total: { type: 'counter', labels: [] },
  wm_worktree_active: { type: 'gauge', labels: [] },
  wm_worktree_cleaned_total: { type: 'counter', labels: [] },
  wm_merge_queue_depth: { type: 'gauge', labels: ['project', 'branch'] },
  wm_merge_conflict_total: { type: 'counter', labels: [] },
  wm_merge_merged_total: { type: 'counter', labels: [] },
  wm_project_events_total: { type: 'counter', labels: ['type'] },
  wm_event_lag_ms: { type: 'histogram', labels: ['client'], buckets: DEFAULT_BUCKETS },
  wm_sse_reconnects_total: { type: 'counter', labels: [] },
  wm_lock_acquired_total: { type: 'counter', labels: ['kind'] },
  wm_lock_conflict_total: { type: 'counter', labels: ['kind'] },
  wm_lock_force_released_total: { type: 'counter', labels: [] },
  wm_review_pending: { type: 'gauge', labels: [] },
  wm_review_decision_total: { type: 'counter', labels: ['decision'] },
  wm_review_latency_ms: { type: 'histogram', labels: [], buckets: DEFAULT_BUCKETS },
  wm_notification_sent_total: { type: 'counter', labels: ['kind'] },
  wm_notification_digest_total: { type: 'counter', labels: [] },
  wm_notification_unread: { type: 'gauge', labels: [] },
  wm_p2p_push_attempts_total: { type: 'counter', labels: [] },
  wm_p2p_push_success_total: { type: 'counter', labels: [] },
  wm_p2p_fallback_total: { type: 'counter', labels: [] },
  wm_p2p_crypto_refusals_total: { type: 'counter', labels: [] },
  wm_relay_restarts_total: { type: 'counter', labels: [] },
});

export class MetricsError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'MetricsError';
    this.code = code;
    this.detail = detail;
  }
}

const labelKey = (labels) => Object.keys(labels ?? {}).sort().map((name) => name + "=" + labels[name]).join(",");

const escapeLabel = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");

export function normalizeLabels(name, labels) {
  const definition = METRIC_DEFINITIONS[name];
  if (definition === undefined) throw new MetricsError('UNKNOWN_METRIC', 'metric is not declared in METRIC_DEFINITIONS', { name });
  const allowed = new Set(definition.labels);
  const result = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (FORBIDDEN_LABELS.includes(key)) throw new MetricsError('FORBIDDEN_LABEL', 'high-cardinality label is not allowed', { name, label: key });
    if (!allowed.has(key)) throw new MetricsError('UNKNOWN_LABEL', 'label is not declared for this metric', { name, label: key, allowed: definition.labels });
    const text = String(value);
    if (text === '' || text.length > 128 || /[\n\r]/.test(text)) throw new MetricsError('INVALID_LABEL_VALUE', 'label value must be 1..128 characters on one line', { name, label: key });
    result[key] = text;
  }
  return result;
}

function labelsText(labels) {
  const names = Object.keys(labels ?? {}).sort();
  if (names.length === 0) return '';
  return '{' + names.map((name) => name + '="' + escapeLabel(labels[name]) + '"').join(',') + '}';
}

export function createMetrics() {
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();
  let seq = 0;

  const ensure = (store, name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };

  return {
    /** Add to a counter. The increment must be a non-negative integer so a counter can never go backwards. */
    inc(name, labels = {}, by = 1) {
      const definition = METRIC_DEFINITIONS[name];
      if (definition === undefined) throw new MetricsError('UNKNOWN_METRIC', 'metric is not declared', { name });
      if (definition.type !== 'counter') throw new MetricsError('WRONG_METRIC_TYPE', 'not a counter', { name, type: definition.type });
      if (!Number.isInteger(by) || by < 0) throw new MetricsError('INVALID_INCREMENT', 'counter increment must be a non-negative integer', { by });
      const normalized = normalizeLabels(name, labels);
      const map = ensure(counters, name);
      const key = labelKey(normalized);
      const current = map.get(key) ?? { labels: normalized, value: 0 };
      current.value += by;
      map.set(key, current);
      return current.value;
    },
    /** Set a gauge to the current value. */
    set(name, labels = {}, value) {
      const definition = METRIC_DEFINITIONS[name];
      if (definition === undefined) throw new MetricsError('UNKNOWN_METRIC', 'metric is not declared', { name });
      if (definition.type !== 'gauge') throw new MetricsError('WRONG_METRIC_TYPE', 'not a gauge', { name, type: definition.type });
      if (!Number.isFinite(value)) throw new MetricsError('INVALID_GAUGE_VALUE', 'gauge value must be finite', { value });
      const normalized = normalizeLabels(name, labels);
      ensure(gauges, name).set(labelKey(normalized), { labels: normalized, value });
      return value;
    },
    /** Record one observation into a histogram. */
    observe(name, labels = {}, valueMs) {
      const definition = METRIC_DEFINITIONS[name];
      if (definition === undefined) throw new MetricsError('UNKNOWN_METRIC', 'metric is not declared', { name });
      if (definition.type !== 'histogram') throw new MetricsError('WRONG_METRIC_TYPE', 'not a histogram', { name, type: definition.type });
      if (!Number.isFinite(valueMs) || valueMs < 0) throw new MetricsError('INVALID_OBSERVATION', 'observation must be a non-negative finite number', { value: valueMs });
      const normalized = normalizeLabels(name, labels);
      const map = ensure(histograms, name);
      const key = labelKey(normalized);
      const entry = map.get(key) ?? { labels: normalized, bucketCounts: definition.buckets.map(() => 0), sum: 0, count: 0 };
      for (let index = 0; index < definition.buckets.length; index += 1) if (valueMs <= definition.buckets[index]) entry.bucketCounts[index] += 1;
      entry.sum += valueMs;
      entry.count += 1;
      map.set(key, entry);
      seq += 1;
      return entry.count;
    },
    snapshot() {
      const out = { counters: {}, gauges: {}, histograms: {} };
      for (const [name, map] of counters) out.counters[name] = Object.fromEntries([...map.values()].map((entry) => [labelKey(entry.labels), { labels: { ...entry.labels }, value: entry.value }]));
      for (const [name, map] of gauges) out.gauges[name] = Object.fromEntries([...map.values()].map((entry) => [labelKey(entry.labels), { labels: { ...entry.labels }, value: entry.value }]));
      for (const [name, map] of histograms) {
        const definition = METRIC_DEFINITIONS[name];
        out.histograms[name] = [...map.values()].map((entry) => ({ labels: { ...entry.labels }, count: entry.count, sum: entry.sum, buckets: definition.buckets.map((le, index) => ({ le, count: entry.bucketCounts[index] })) }));
      }
      return out;
    },
    renderPrometheus() {
      const lines = [];
      for (const [name, map] of counters) {
        lines.push('# TYPE ' + name + ' counter');
        for (const entry of map.values()) lines.push(name + labelsText(entry.labels) + ' ' + entry.value);
      }
      for (const [name, map] of gauges) {
        lines.push('# TYPE ' + name + ' gauge');
        for (const entry of map.values()) lines.push(name + labelsText(entry.labels) + ' ' + entry.value);
      }
      for (const [name, map] of histograms) {
        const definition = METRIC_DEFINITIONS[name];
        lines.push('# TYPE ' + name + ' histogram');
        for (const entry of map.values()) {
          for (let index = 0; index < definition.buckets.length; index += 1) lines.push(name + "_bucket" + labelsText({ ...entry.labels, le: String(definition.buckets[index]) }) + " " + entry.bucketCounts[index]);
          lines.push(name + "_bucket" + labelsText({ ...entry.labels, le: "+Inf" }) + " " + entry.count);
          lines.push(name + "_sum" + labelsText(entry.labels) + " " + entry.sum);
          lines.push(name + "_count" + labelsText(entry.labels) + " " + entry.count);
        }
      }
      return lines.join('\n') + '\n';
    },
    size() { return { counters: counters.size, gauges: gauges.size, histograms: histograms.size, observations: seq }; },
  };
}
