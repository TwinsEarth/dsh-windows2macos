/**
 * Reliability metrics tests (M7, v1.3.10-beta.22 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, METRIC_DEFINITIONS } from '../src/relay/reliability-metrics.mjs';

describe("reliability metrics", () => {
  it("aggregates a counter by its declared label set", () => {
    const metrics = createMetrics();
    metrics.inc('wm_tasks_total', { status: 'ok', mode: 'replicate' });
    metrics.inc('wm_tasks_total', { status: 'ok', mode: 'replicate' }, 2);
    metrics.inc('wm_tasks_total', { status: 'failed', mode: 'replicate' });
    const snapshot = metrics.snapshot();
    assert.equal(Object.values(snapshot.counters.wm_tasks_total).find((entry) => entry.labels.status === 'ok').value, 3);
    assert.equal(Object.values(snapshot.counters.wm_tasks_total).find((entry) => entry.labels.status === 'failed').value, 1);
  });
  it("refuses an undeclared metric or an undeclared label", () => {
    const metrics = createMetrics();
    assert.throws(() => metrics.inc('wm_made_up_total'), { code: 'UNKNOWN_METRIC' });
    assert.throws(() => metrics.inc('wm_tasks_total', { task_id: 't-1' }), { code: 'FORBIDDEN_LABEL' });
    assert.throws(() => metrics.inc('wm_tasks_total', { status: 'ok', extra: 'x' }), { code: 'UNKNOWN_LABEL' });
  });
  it("refuses a counter decrement and the wrong metric type", () => {
    const metrics = createMetrics();
    assert.throws(() => metrics.inc('wm_tasks_total', {}, -1), { code: 'INVALID_INCREMENT' });
    assert.throws(() => metrics.set('wm_tasks_total', {}, 1), { code: 'WRONG_METRIC_TYPE' });
    assert.throws(() => metrics.observe('wm_tasks_total', {}, 5), { code: 'WRONG_METRIC_TYPE' });
  });
  it("keeps a gauge as the last value, not an accumulator", () => {
    const metrics = createMetrics();
    metrics.set('wm_agent_outbox_depth', {}, 4);
    metrics.set('wm_agent_outbox_depth', {}, 1);
    assert.equal(Object.values(metrics.snapshot().gauges.wm_agent_outbox_depth)[0].value, 1);
  });
  it("buckets a histogram cumulatively with sum and count", () => {
    const metrics = createMetrics();
    for (const value of [3, 12, 40, 900, 70000]) metrics.observe('wm_task_duration_ms', { status: 'ok', mode: 'split' }, value);
    const entry = metrics.snapshot().histograms.wm_task_duration_ms.find((item) => item.labels.status === 'ok');
    assert.equal(entry.count, 5);
    assert.equal(entry.sum, 70000 + 900 + 40 + 12 + 3);
    assert.equal(entry.buckets.find((bucket) => bucket.le === 10).count, 1);
    assert.equal(entry.buckets.find((bucket) => bucket.le === 50).count, 3);
    assert.equal(entry.buckets.at(-1).count, 5);
  });
  it("renders Prometheus text including cumulative buckets and +Inf", () => {
    const metrics = createMetrics();
    metrics.inc('wm_tasks_total', { status: 'ok', mode: 'replicate' }, 2);
    metrics.observe('wm_review_latency_ms', {}, 30);
    const text = metrics.renderPrometheus();
    assert.match(text, /# TYPE wm_tasks_total counter/);
    assert.match(text, /wm_tasks_total\{mode="replicate",status="ok"\} 2/);
    assert.match(text, /wm_review_latency_ms_bucket\{le="25"\} 0/);
    assert.match(text, /wm_review_latency_ms_bucket\{le="50"\} 1/);
    assert.match(text, /wm_review_latency_ms_bucket\{le="\+Inf"\} 1/);
    assert.match(text, /wm_review_latency_ms_count 1/);
  });
  it("escapes label values so one value cannot forge another series", () => {
    const metrics = createMetrics();
    metrics.inc('wm_maintenance_requests_total', { action: 'restart', outcome: 'ok' }, 1);
    const text = metrics.renderPrometheus();
    assert.match(text, /action="restart"/);
    assert.equal(text.includes('\n{'), false, 'labels never introduce a new line');
  });
  it("exposes the full metric contract including histogram buckets", () => {
    const metrics = createMetrics();
    assert.ok(Object.keys(METRIC_DEFINITIONS).length >= 30);
    assert.ok(METRIC_DEFINITIONS.wm_task_duration_ms.buckets.length > 5);
    assert.equal(metrics.size().counters, 0);
    metrics.inc('wm_sse_reconnects_total');
    assert.equal(metrics.size().counters, 1);
  });
});
