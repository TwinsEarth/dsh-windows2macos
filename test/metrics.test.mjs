/**
 * Prometheus metrics tests — node:test + node:assert, zero dependencies.
 * Run: node --test --test-force-exit test/metrics.test.mjs
 *
 * Uses the established harness pattern from `test/relay.test.mjs`: a REAL
 * in-process relay, driven over HTTP, so the metrics are rendered from state that
 * was produced by actual requests rather than by hand-built fixtures.
 *
 * The central case is `never-reported machines have no series` -- written so that
 * emitting `0` instead of nothing fails it.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { AGGREGATE_STATUSES } from '../src/relay/report.mjs';
import { computeCommandHash, computeDedupeKey, sha256Hex } from '../src/relay/state.mjs';
import { createRelayServer } from '../src/relay/server.mjs';
import {
  METRICS_CONTENT_TYPE,
  METRIC_PREFIX,
  collectMetrics,
  escapeLabelValue,
  renderMetrics,
} from '../src/relay/metrics.mjs';

/* ------------------------------------------------------------------ */
/* harness (mirrors test/relay.test.mjs)                               */
/* ------------------------------------------------------------------ */

const T0 = Date.parse('2026-10-07T12:00:00Z');
const OP = 'test-operator-token';

function makeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (ms) => { t = ms; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, { method = 'GET', token, body, rawBody, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = rawBody !== undefined
      ? Buffer.from(rawBody, 'utf8')
      : (body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8'));
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

function openSse(url, { token, headers = {}, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const frames = [];
    const waiters = new Set();
    let buffer = '';
    const pump = () => { for (const w of [...waiters]) if (w()) waiters.delete(w); };
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const frame = { raw, event: null, json: null };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            if (line.startsWith('data:')) { try { frame.json = JSON.parse(line.slice(5).trim()); } catch { /* ignore */ } }
          }
          if (frame.event) frames.push(frame);
        }
        pump();
      });
      res.on('end', pump);
      resolve({
        frames,
        close: () => req.destroy(),
        waitFor(pred, ms = timeoutMs) {
          return new Promise((res2, rej2) => {
            const check = () => {
              const hit = frames.find(pred);
              if (hit) { waiters.delete(check); res2(hit); return true; }
              return false;
            };
            if (check()) return;
            waiters.add(check);
            setTimeout(() => {
              waiters.delete(check);
              rej2(new Error(`SSE timeout; frames=${JSON.stringify(frames.map((f) => f.event))}`));
            }, ms);
          });
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startRelay(options = {}) {
  const relay = createRelayServer({ logger: null, operatorToken: OP, persist: false, ...options });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  return relay;
}

async function withRelay(options, fn) {
  const relay = await startRelay(options);
  try {
    return await fn(relay);
  } finally {
    await relay.close();
  }
}

const dirs = [];
after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const DEFAULT_PLATFORM = { os: 'windows', os_version: '10.0.26100', arch: 'x64', shell: 'pwsh', shell_version: '7.4.0' };
const DEFAULT_CAPS = {
  case_sensitive_fs: false, symlinks: false, exec_bit: false,
  python: null, npm: null, node: 'v24.21.0', write: true,
};

async function pairDevice(relay, machineId, extra = {}) {
  const { code, ...rest } = extra;
  const res = await request(`${relay.url}/v1/pair`, {
    method: 'POST',
    body: {
      pairing_code: code ?? relay.state.createPairingCode(),
      machine_id: machineId,
      machine_name: machineId,
      platform: DEFAULT_PLATFORM,
      caps: DEFAULT_CAPS,
      ...rest,
    },
  });
  assert.equal(res.status, 200, `pair failed: ${res.text}`);
  return { token: res.json.device_token, body: res.json };
}

const ARGV = ['node', '--test'];
const CMD_HASH = computeCommandHash(ARGV, 'direct-exec', '.');
const BASE_COMMIT = 'c0ffee1';
const BASE_TREE = 'tree-abc';

function taskBody(over = {}) {
  return {
    mode: 'replicate',
    command_argv: ARGV,
    cwd_rel: '.',
    index_total: 1,
    timeout_ms: 300_000,
    write: false,
    base_commit: BASE_COMMIT,
    base_tree: BASE_TREE,
    requirements: {},
    compare_policy: { strip_ansi: true, normalize_crlf: true },
    halt: 'never',
    created_by: 'test',
    ...over,
  };
}

function envelopeForTask(taskId, machineId, over = {}) {
  return {
    envelope_version: '1.0',
    task_id: taskId,
    attempt: 1,
    dedupe_key: computeDedupeKey(taskId, over.index ?? 0, CMD_HASH, BASE_TREE),
    machine_id: machineId,
    machine_name: machineId,
    platform: DEFAULT_PLATFORM,
    caps: DEFAULT_CAPS,
    index: 0,
    index_total: 1,
    mode: 'replicate',
    cwd_rel: '.',
    base_commit: BASE_COMMIT,
    base_tree: BASE_TREE,
    pre_tree_fingerprint: BASE_TREE,
    post_tree_fingerprint: BASE_TREE,
    fingerprint_algo: 'git-temp-index-tree/v1',
    fingerprint_error: null,
    head_commit: BASE_COMMIT,
    dirty_before: false,
    command_argv: ARGV,
    command_hash: CMD_HASH,
    shell_id: 'direct-exec',
    started_at: '2026-10-07T12:00:00Z',
    ended_at: '2026-10-07T12:00:01Z',
    duration_ms: 1000,
    exit_code: 0,
    status: 'ok',
    refusal_reason: null,
    stdout_sha256: sha256Hex('hello'),
    stdout_bytes: 5,
    stderr_sha256: sha256Hex(''),
    stderr_bytes: 0,
    warnings: [],
    envelope_sha256: 'ignored-by-the-relay',
    ...over,
  };
}

const postTask = (relay, body, token = OP) => request(`${relay.url}/v1/task`, { method: 'POST', token, body });
const heartbeat = (relay, token, body) => request(`${relay.url}/v1/heartbeat`, { method: 'POST', token, body });
const submitResult = (relay, token, body) => request(`${relay.url}/v1/result`, { method: 'POST', token, body });

/** Parse the exposition body into `name{labels} -> number`, plus the header lines. */
function parseMetrics(text) {
  const samples = new Map();
  const types = new Map();
  const helps = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('# TYPE ')) {
      const parts = line.split(' ');
      types.set(parts[2], parts[3]);
      continue;
    }
    if (line.startsWith('# HELP ')) {
      const rest = line.slice(7);
      const name = rest.split(' ')[0];
      helps.set(name, rest.slice(name.length + 1));
      continue;
    }
    if (line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})? (.+)$/.exec(line);
    assert.ok(match, `unparsable metric line: ${JSON.stringify(line)}`);
    samples.set(`${match[1]}${match[2] ?? ''}`, Number(match[3]));
  }
  return { samples, types, helps };
}

/** Metric names and label NAMES only (not HELP prose, which may contain the word "key"). */
function metricAndLabelNames(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? /.exec(line);
    if (!match || line.startsWith('#')) continue;
    names.add(match[1]);
    if (match[3]) {
      for (const pair of match[3].split(',')) names.add(pair.split('=')[0].trim());
    }
  }
  return [...names];
}

const seriesFor = (text, name) => {
  const { samples } = parseMetrics(text);
  return [...samples.entries()].filter(([key]) => key.startsWith(`${name}{`) || key === name);
};

/* ================================================================== */
/* exposition format                                                   */
/* ================================================================== */

describe('metrics: exposition format', () => {
  it('emits HELP/TYPE headers, sorted samples and a trailing newline', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      await pairDevice(relay, 'm1');
      const text = renderMetrics(relay.state, { nowMs: relay.state.nowMs() });

      assert.ok(text.endsWith('\n'), 'the body ends with exactly one newline');
      assert.equal(text.endsWith('\n\n'), false, 'and not two');

      const parsed = parseMetrics(text);
      for (const [name, type] of parsed.types) {
        assert.ok(parsed.helps.has(name), `${name} has a HELP line`);
        assert.ok(['gauge', 'counter', 'histogram', 'summary', 'untyped'].includes(type), `${name} TYPE ${type}`);
      }
      // every sample has a declared family
      for (const key of parsed.samples.keys()) {
        const name = key.split('{')[0];
        assert.ok(parsed.types.has(name), `${name} is declared with # TYPE`);
      }

      // deterministic: two renders of unchanged state are byte-identical
      assert.equal(renderMetrics(relay.state, { nowMs: relay.state.nowMs() }), text);
    });
  });

  it('uses snake_case w2m_ names and the 0.0.4 content type', async () => {
    await withRelay({}, async (relay) => {
      const text = renderMetrics(relay.state, { nowMs: 0 });
      for (const name of parseMetrics(text).types.keys()) {
        assert.match(name, /^[a-z][a-z0-9_]*$/, `metric name ${name} is snake_case`);
        assert.ok(name.startsWith(METRIC_PREFIX), `${name} carries the ${METRIC_PREFIX} prefix`);
      }
      assert.equal(METRICS_CONTENT_TYPE, 'text/plain; version=0.0.4; charset=utf-8');
    });
  });

  it('never reads the wall clock: the same state renders identically at a fixed nowMs', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      await pairDevice(relay, 'm1');
      // A task gives the render something time-dependent to get wrong: its verdict is
      // `pending` until the deadline passes, then `timeout` (report.mjs).
      await postTask(relay, taskBody({ timeout_ms: 300_000 }));

      const a = renderMetrics(relay.state, { nowMs: T0 });
      await sleep(20); // real time passes; the fake clock does not move
      const b = renderMetrics(relay.state, { nowMs: T0 });
      assert.equal(a, b, 'identical inputs must give byte-identical output');

      clock.advance(10 * 60_000); // past the deadline
      const later = renderMetrics(relay.state, { nowMs: clock.now() });
      assert.notEqual(later, a, 'nowMs genuinely drives the verdicts');
      assert.equal(parseMetrics(a).samples.get('w2m_task_status_total{status="pending"}'), 1);
      assert.equal(parseMetrics(later).samples.get('w2m_task_status_total{status="timeout"}'), 1);
    });
  });

  /* ---- the null-vs-zero contract ---- */

  it('NEVER-REPORTED machines have NO rtt series at all (not a 0)', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'silent');
      const created = await postTask(relay, taskBody());
      // a heartbeat with no rtt_ms: the v0.2.3 shape, liveness without latency
      await heartbeat(relay, token, { task_id: created.json.task_id, machine_id: 'silent', phase: 'running' });

      const text = renderMetrics(relay.state, { nowMs: relay.state.nowMs() });

      // The whole point: absent, not zero. The FAMILY header is still emitted (it
      // documents the semantics), but there must be no SAMPLE line for this machine.
      assert.deepEqual(seriesFor(text, `${METRIC_PREFIX}rtt_ms`), [],
        'a machine that never reported must produce no w2m_rtt_ms SAMPLE');
      assert.deepEqual(seriesFor(text, `${METRIC_PREFIX}rtt_stale`), [],
        'and no staleness companion sample either');
      assert.equal(/^w2m_rtt_ms\{/m.test(text), false, 'not even one sample line');
      assert.match(text, /# TYPE w2m_rtt_ms gauge/, 'the family header still documents the metric');
      assert.match(text, /NO series here: absent, not 0/);

      // Guards against the tempting-but-wrong implementation: if a 0 were emitted,
      // these would find it. `absent()` cannot be faked by a zero.
      const withZero = text.split('\n').filter((l) => /^w2m_rtt_ms\{.*\} 0$/.test(l));
      assert.deepEqual(withZero, [], 'emitting 0 would read as "instantaneous"');

      // the device is nevertheless visible as a device
      assert.equal(parseMetrics(text).samples.get('w2m_devices'), 1);
      assert.equal(parseMetrics(text).samples.get('w2m_devices_online'), 1);
    });
  });

  it('a reported 0 IS emitted (0 is a measurement, not an absence)', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'instant');
      const created = await postTask(relay, taskBody());
      const hb = await heartbeat(relay, token, {
        task_id: created.json.task_id, machine_id: 'instant', phase: 'running', rtt_ms: 0,
      });
      assert.equal(hb.status, 200);

      const text = renderMetrics(relay.state, { nowMs: relay.state.nowMs() });
      const series = seriesFor(text, `${METRIC_PREFIX}rtt_ms`);
      assert.deepEqual(series, [['w2m_rtt_ms{machine_id="instant"}', 0]]);
      assert.equal(parseMetrics(text).samples.get('w2m_rtt_stale{machine_id="instant"}'), 0,
        'a fresh 0ms measurement is not stale');
    });
  });

  it('distinguishes a slow machine from a gone one via the stale companion', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, rttStaleMs: 30_000, pairRateLimitPerMinute: 0 }, async (relay) => {
      const slow = await pairDevice(relay, 'slow');
      const slowTask = await postTask(relay, taskBody());
      await heartbeat(relay, slow.token, {
        task_id: slowTask.json.task_id, machine_id: 'slow', rtt_ms: 800,
      });

      const gone = await pairDevice(relay, 'gone');
      const goneTask = await postTask(relay, taskBody());
      await heartbeat(relay, gone.token, {
        task_id: goneTask.json.task_id, machine_id: 'gone', rtt_ms: 40,
      });

      clock.advance(60_000); // only 'gone' stops reporting

      const healthy = await postTask(relay, taskBody());
      await heartbeat(relay, slow.token, {
        task_id: healthy.json.task_id, machine_id: 'slow', rtt_ms: 850,
      });

      const text = renderMetrics(relay.state, { nowMs: clock.now() });
      const { samples } = parseMetrics(text);

      assert.equal(samples.get('w2m_rtt_ms{machine_id="slow"}'), 850);
      assert.equal(samples.get('w2m_rtt_stale{machine_id="slow"}'), 0, 'genuinely slow, but alive');
      assert.equal(samples.get('w2m_rtt_ms{machine_id="gone"}'), 40);
      assert.equal(samples.get('w2m_rtt_stale{machine_id="gone"}'), 1, 'the number is historical');

      // The PromQL an operator would actually write:
      //   w2m_rtt_ms > 500 and on(machine_id) w2m_rtt_stale == 0
      const trulySlow = [...samples.entries()]
        .filter(([k]) => k.startsWith('w2m_rtt_ms{'))
        .filter(([, v]) => v > 500)
        .filter(([k]) => {
          const id = /machine_id="([^"]*)"/.exec(k)[1];
          return samples.get(`w2m_rtt_stale{machine_id="${id}"}`) === 0;
        });
      assert.deepEqual(trulySlow, [['w2m_rtt_ms{machine_id="slow"}', 850]]);
    });
  });

  /* ---- status series ---- */

  it('emits one task-status series per AGGREGATE_STATUSES entry, imported not hardcoded', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      await pairDevice(relay, 'm1');
      const text = renderMetrics(relay.state, { nowMs: relay.state.nowMs() });
      const { samples } = parseMetrics(text);

      assert.ok(AGGREGATE_STATUSES.length >= 11, `the authoritative list has the v0.3.4 verdicts (${AGGREGATE_STATUSES.length})`);
      for (const status of AGGREGATE_STATUSES) {
        assert.ok(
          samples.has(`w2m_task_status_total{status="${status}"}`),
          `every verdict needs a series so a dashboard can plot a fixed set: missing ${status}`,
        );
      }
      assert.equal(
        [...samples.keys()].filter((k) => k.startsWith('w2m_task_status_total{')).length,
        AGGREGATE_STATUSES.length,
        'exactly one series per verdict, no extras',
      );
      // the list is derived from report.mjs, so a verdict added there shows up here
      assert.deepEqual(
        [...samples.keys()].filter((k) => k.startsWith('w2m_task_status_total{')).map((k) => /status="([^"]+)"/.exec(k)[1]),
        [...AGGREGATE_STATUSES],
      );
    });
  });

  it('counts real verdicts: pending, then consistent after a result', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const created = await postTask(relay, taskBody());
      const taskId = created.json.task_id;

      const before = parseMetrics(renderMetrics(relay.state, { nowMs: relay.state.nowMs() })).samples;
      assert.equal(before.get('w2m_tasks'), 1);
      assert.equal(before.get('w2m_task_status_total{status="pending"}'), 1);
      assert.equal(before.get('w2m_task_status_total{status="consistent"}'), 0);

      await submitResult(relay, token, envelopeForTask(taskId, 'm1'));

      const after = parseMetrics(renderMetrics(relay.state, { nowMs: relay.state.nowMs() })).samples;
      assert.equal(after.get('w2m_task_status_total{status="pending"}'), 0, 'the verdict moved');
      assert.equal(after.get('w2m_task_status_total{status="consistent"}'), 1);
      assert.equal(after.get('w2m_results'), 1);
    });
  });

  it('counts leases by state', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      await pairDevice(relay, 'm2');
      const created = await postTask(relay, taskBody());
      await heartbeat(relay, a.token, { task_id: created.json.task_id, machine_id: 'm1', phase: 'running' });

      const { samples } = parseMetrics(renderMetrics(relay.state, { nowMs: relay.state.nowMs() }));
      assert.equal(samples.get('w2m_leases{state="running"}'), 1, 'm1 acknowledged the offer');
      assert.equal(samples.get('w2m_leases{state="offered"}'), 1, 'm2 has not');
      assert.equal(samples.get('w2m_devices'), 2);
    });
  });

  /* ---- escaping ---- */

  it('escapes label values so a hostile machine_id cannot break the body', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      // A machine id carrying a quote, a backslash and a newline. machine_name is
      // free-form client input, so this is reachable without any bug.
      const nasty = 'a"b\\c\nd';
      const { token } = await pairDevice(relay, nasty);
      const created = await postTask(relay, taskBody());
      await heartbeat(relay, token, { task_id: created.json.task_id, machine_id: nasty, rtt_ms: 5 });

      const text = renderMetrics(relay.state, { nowMs: relay.state.nowMs() });

      // every line still parses, and the count of lines equals the count of samples
      const sampleLines = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
      for (const line of sampleLines) {
        assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9eE.+]+$/, `unparsable: ${line}`);
      }
      assert.equal(text.includes('a"b'), false, 'the raw quote must not survive');

      const { samples } = parseMetrics(text);
      const key = [...samples.keys()].find((k) => k.startsWith('w2m_rtt_ms{'));
      assert.equal(key, 'w2m_rtt_ms{machine_id="a\\"b\\\\c\\nd"}');
      assert.equal(samples.get(key), 5);
    });
  });

  it('escapeLabelValue implements the three defined escapes', () => {
    assert.equal(escapeLabelValue('plain'), 'plain');
    assert.equal(escapeLabelValue('a"b'), 'a\\"b');
    assert.equal(escapeLabelValue('a\\b'), 'a\\\\b');
    assert.equal(escapeLabelValue('a\nb'), 'a\\nb');
    assert.equal(escapeLabelValue('a\r\nb'), 'a\\nb', 'CRLF folds into one escaped newline');
    assert.equal(escapeLabelValue('a\rb'), 'a\\nb', 'a bare CR would break the line structure');
  });

  /* ---- secrets ---- */

  it('never leaks a signing secret or the operator token', async () => {
    const SECRET = 'super-secret-signing-key-0123456789';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-metrics-'));
    dirs.push(dir);
    await withRelay({
      signingSecret: SECRET,
      operatorToken: OP,
      stateDir: dir,
      persist: false,
      pairRateLimitPerMinute: 0,
    }, async (relay) => {
      const paired = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: {
          pairing_code: relay.state.createPairingCode(),
          machine_id: 'm1', machine_name: 'm1', platform: DEFAULT_PLATFORM, caps: DEFAULT_CAPS,
        },
      });
      assert.equal(paired.status, 200);
      const deviceToken = paired.json.device_token;

      const text = renderMetrics(relay.state, { nowMs: relay.state.nowMs() });
      assert.equal(text.includes(SECRET), false, 'the signing secret must never reach a metrics scrape');
      assert.equal(text.includes(SECRET.slice(0, 12)), false, 'not even a prefix');
      assert.equal(text.includes(deviceToken), false, 'nor a device token');
      assert.equal(text.includes(OP), false, 'nor the operator token');
      // no metric name or label NAME is credential-shaped (HELP prose may legitimately
      // contain the word "key", as in "dedupe key").
      for (const name of metricAndLabelNames(text)) {
        assert.equal(/token|secret|credential/i.test(name), false, `${name} is credential-shaped`);
      }
    });
  });

  /* ---- robustness ---- */

  it('renders an empty relay without inventing series', async () => {
    await withRelay({}, async (relay) => {
      const text = renderMetrics(relay.state, { nowMs: relay.state.nowMs() });
      const { samples, types } = parseMetrics(text);
      assert.equal(samples.get('w2m_devices'), 0);
      assert.equal(samples.get('w2m_devices_online'), 0);
      assert.equal(samples.get('w2m_tasks'), 0);
      assert.equal(samples.get('w2m_results'), 0);
      assert.deepEqual(seriesFor(text, `${METRIC_PREFIX}rtt_ms`), []);
      assert.deepEqual(seriesFor(text, `${METRIC_PREFIX}leases`), []);
      assert.equal(samples.get('w2m_task_status_total{status="pending"}'), 0, 'verdict series exist even at zero');
      assert.ok(types.size >= 7);
    });
  });

  it('collectMetrics exposes the numbers separately from the text', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const created = await postTask(relay, taskBody());
      await heartbeat(relay, token, { task_id: created.json.task_id, machine_id: 'm1', rtt_ms: 12.5 });

      const data = collectMetrics(relay.state, { nowMs: clock.now() });
      assert.equal(data.nowMs, clock.now());
      assert.deepEqual(data.gauges, { devices: 1, devices_online: 1, tasks: 1, results: 0 });
      assert.equal(data.taskStatus.get('pending'), 1);
      assert.deepEqual(data.rtt, [{ machine_id: 'm1', rtt_ms: 12.5, stale: false, age_ms: 0 }]);
      assert.deepEqual(data.leases, [['running', 1]]);
    });
  });

  it('rejects a missing state instead of throwing a TypeError from deep inside', () => {
    assert.throws(() => collectMetrics(null), /state is required/);
    assert.throws(() => renderMetrics(undefined), /state is required/);
  });

  it('quotes a real scrape end to end through a live relay', async () => {
    // The route itself is wired by the Lead; this proves the renderer works against
    // state produced by a full request cycle, including SSE.
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const created = await postTask(relay, taskBody());
        await sse.waitFor((f) => f.event === 'task.offer');
        await heartbeat(relay, token, {
          task_id: created.json.task_id, machine_id: 'm1', phase: 'running', progress: 0.5, rtt_ms: 33,
        });
        await submitResult(relay, token, envelopeForTask(created.json.task_id, 'm1'));

        const text = renderMetrics(relay.state, { nowMs: clock.now() });
        const { samples } = parseMetrics(text);
        assert.equal(samples.get('w2m_devices'), 1);
        assert.equal(samples.get('w2m_results'), 1);
        assert.equal(samples.get('w2m_task_status_total{status="consistent"}'), 1);
        assert.equal(samples.get('w2m_leases{state="done"}'), 1);
        assert.equal(samples.get('w2m_rtt_ms{machine_id="m1"}'), 33);
        assert.equal(samples.get('w2m_rtt_stale{machine_id="m1"}'), 0);
      } finally {
        sse.close();
      }
    });
  });
});
