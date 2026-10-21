/**
 * Metrics exposition tests (restored module: src/relay/metrics.mjs).
 *
 * The original test file was overwritten during the beta.22 metrics work and is not shipped in the release asset, so this file
 * is rewritten against the restored exports. Numbers are asserted first, rendered text second.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectMetrics, escapeLabelValue, METRIC_PREFIX, METRICS_CONTENT_TYPE, renderMetrics } from '../src/relay/metrics.mjs';

const NOW = Date.parse("2026-10-22T00:00:00Z");

function fakeState({ tasks = [], devices = [], results = [] } = {}) {
  return {
    nowMs: () => NOW,
    devices: new Map(devices.map((device) => [device.machine_id, device])),
    tasks: new Map(tasks.map((task) => [task.task_id, { leases: new Map(), ...task }])),
    results: new Map(results),
    leases: new Map(),
    isRttStale: () => false,
    rttAgeMs: () => 10,
  };
}

describe("metrics exposition", () => {
  it("escapes label values for the exposition format", () => {
    assert.equal(escapeLabelValue("plain"), "plain");
    assert.equal(escapeLabelValue("a\"b"), "a\\\"b");
    assert.equal(escapeLabelValue("a\\b"), "a\\\\b");
    assert.equal(escapeLabelValue("a\nb"), "a\\nb");
    assert.equal(METRICS_CONTENT_TYPE.includes("text/plain"), true);
  });

  it("collects gauges, lease counts and rtt series", () => {
    const state = fakeState({
      devices: [
        { machine_id: "m-2", online: true, rtt_ms: 20 },
        { machine_id: "m-1", online: true, rtt_ms: 0 },
        { machine_id: "m-3", online: false, rtt_ms: null },
      ],
      tasks: [
        { task_id: "t-1", leases: new Map([["m-1", { state: "ok" }]]) },
        { task_id: "t-2", leases: new Map([["m-1", { state: "ok" }], ["m-2", { state: "expired" }]]) },
      ],
      results: [["k-1", { envelope: { task_id: "t-1" } }], ["k-2", { envelope: { task_id: "t-2" } }]],
    });
    const collected = collectMetrics(state);
    assert.equal(collected.gauges.devices, 3);
    assert.equal(collected.gauges.devices_online, 2);
    assert.equal(collected.gauges.tasks, 2);
    assert.equal(collected.gauges.results, 2);
    assert.deepEqual(collected.leases, [["expired", 1], ["ok", 2]]);
    assert.deepEqual(collected.rtt.map((entry) => entry.machine_id), ["m-1", "m-2"]);
    assert.equal(collected.rtt[0].rtt_ms, 0);
    assert.equal(collected.rtt[1].rtt_ms, 20);
    assert.ok(collected.taskStatus instanceof Map);
    assert.ok(collected.taskStatus.size > 0);
  });

  it("renders an exposition body with the documented families", () => {
    const state = fakeState({
      devices: [{ machine_id: "m-1", online: true, rtt_ms: 5 }],
      tasks: [{ task_id: "t-1", leases: new Map([["m-1", { state: "ok" }]]) }],
    });
    const text = renderMetrics(state);
    assert.ok(text.endsWith("\n"));
    assert.match(text, new RegExp("# TYPE " + METRIC_PREFIX + "devices gauge"));
    assert.match(text, new RegExp(METRIC_PREFIX + "devices 1"));
    assert.match(text, new RegExp(METRIC_PREFIX + "devices_online 1"));
    assert.match(text, new RegExp(METRIC_PREFIX + "leases\\{state=\"ok\"\\} 1"));
    assert.match(text, new RegExp(METRIC_PREFIX + "rtt_ms\\{machine_id=\"m-1\"\\} 5"));
    assert.ok(text.includes(METRIC_PREFIX + "task_status_total"));
  });

  it("refuses a missing state instead of throwing an obscure error", () => {
    assert.throws(() => collectMetrics(null), TypeError);
  });
});
