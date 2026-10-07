/**
 * W2M Rabbit relay test suite — node:test + node:assert, zero dependencies.
 * Run: node --test w2m/test/relay.test.mjs
 *
 * Covers task-7 acceptance: pairing (ok/bad/expired), 401 auth, SSE ready +
 * monotonic seq, replay by seq / Last-Event-ID, multi-device dispatch, heartbeat
 * renewal, lease expiry, dedupe, all six §6.3 states, report generation,
 * 64 KiB frame cap.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  MAX_FRAME_BYTES,
  ProtocolError,
  RabbitState,
  computeCommandHash,
  computeDedupeKey,
  jcs,
  rfc3339,
  satisfiesRange,
  sha256Hex,
} from '../src/relay/state.mjs';
import { aggregate, aggregateTask, renderReportMarkdown } from '../src/relay/report.mjs';
import { createRelayServer, normalizeBasePath, SlidingWindowRateLimiter } from '../src/relay/server.mjs';
import { Persistence } from '../src/relay/persistence.mjs';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const T0 = Date.parse('2026-10-07T12:00:00Z');

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
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      // the TLS test uses a self-signed fixture certificate
      rejectUnauthorized: false,
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
    if (payload) req.end(payload);
    else req.end();
  });
}

/** Chunked (no content-length) request, used to exercise the streaming frame cap. */
function requestChunked(url, { method = 'POST', token, chunks = [], headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let gotResponse = false;
    let settled = false;
    const fail = (err) => { if (!settled && !gotResponse) { settled = true; reject(err); } };
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
        ...headers,
      },
    }, (res) => {
      gotResponse = true;
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(bufs).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', fail);
    for (const chunk of chunks) {
      try { req.write(chunk); } catch (err) { fail(err); break; }
    }
    try { req.end(); } catch (err) { fail(err); }
  });
}

function parseFrame(raw) {
  const frame = { comment: false, id: null, event: null, data: null, json: null, raw };
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) { frame.comment = true; frame.commentText = line.slice(1).trim(); continue; }
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') frame.id = value;
    else if (field === 'event') frame.event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length > 0) {
    frame.data = dataLines.join('\n');
    try { frame.json = JSON.parse(frame.data); } catch { frame.json = null; }
  }
  return frame;
}

function openSse(url, { token, headers = {}, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const frames = [];
    const waiters = new Set();
    let buffer = '';
    let ended = false;

    const pump = () => {
      for (const w of [...waiters]) if (w()) waiters.delete(w);
    };

    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (raw.trim() === '') continue;
          frames.push(parseFrame(raw));
        }
        pump();
      });
      res.on('end', () => { ended = true; pump(); });
      res.on('error', () => { ended = true; pump(); });

      const client = {
        status: res.statusCode,
        headers: res.headers,
        frames,
        get ended() { return ended; },
        waitFor(pred, timeoutMs2 = timeoutMs, from = 0) {
          return new Promise((res2, rej2) => {
            let timer = null;
            const check = () => {
              const hit = frames.slice(from).find((f) => pred(f));
              if (hit) {
                if (timer) clearTimeout(timer);
                waiters.delete(check);
                res2(hit);
                return true;
              }
              return false;
            };
            if (check()) return;
            waiters.add(check);
            timer = setTimeout(() => {
              waiters.delete(check);
              rej2(new Error(`SSE timeout after ${timeoutMs2}ms; frames=${JSON.stringify(frames.map((f) => f.event ?? 'comment'))}`));
            }, timeoutMs2);
          });
        },
        waitForIndex(pred, timeoutMs2 = timeoutMs, from = 0) {
          return new Promise((res2, rej2) => {
            const check = () => {
              const i = frames.findIndex((f, idx) => idx >= from && pred(f));
              if (i !== -1) { waiters.delete(check); res2({ frame: frames[i], index: i }); return true; }
              return false;
            };
            if (check()) return;
            waiters.add(check);
            setTimeout(() => {
              waiters.delete(check);
              rej2(new Error(`SSE timeout after ${timeoutMs2}ms; frames=${JSON.stringify(frames.map((f) => f.event ?? 'comment'))}`));
            }, timeoutMs2);
          });
        },
        close() {
          waiters.clear();
          req.destroy();
        },
      };
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * v0.1.2 §5: `POST /v1/task` takes the OPERATOR token, not a device token.
 * Tests opt out of persistence by default so nothing is written to the real
 * `~/.w2m` state dir; persistence tests pass an explicit `stateDir`.
 */
const OP = 'test-operator-token';
const SERVER_URL = new URL('../src/relay/server.mjs', import.meta.url).href;

async function startRelay(options = {}) {
  // Persistence is opt-in by stateDir so no test ever touches the real ~/.w2m.
  const persist = options.persist ?? (options.stateDir !== undefined);
  const relay = createRelayServer({ logger: null, operatorToken: OP, ...options, persist });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  return relay;
}

/** Dispatch a task with the operator credential. */
function postTask(relay, body, token = OP) {
  return request(`${relay.url}/v1/task`, { method: 'POST', token, body });
}

async function withRelay(options, fn) {
  const relay = await startRelay(options);
  try {
    return await fn(relay);
  } finally {
    await relay.close();
  }
}

/** Isolated state dir for the persistence tests. */
function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-relay-test-'));
}

function removeStateDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

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
      // §2.2: the boot code is one-time, so each pair mints a fresh one unless
      // the caller explicitly wants to exercise a specific code.
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

function makeEnvelope(over = {}) {
  const env = {
    envelope_version: '1.0',
    task_id: 'TASK',
    attempt: 1,
    dedupe_key: 'dk',
    machine_id: 'm1',
    machine_name: 'm1',
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
  return env;
}

/** Envelope for a real task created through the relay. */
function envelopeForTask(taskId, machineId, over = {}) {
  return makeEnvelope({
    task_id: taskId,
    machine_id: machineId,
    machine_name: machineId,
    dedupe_key: computeDedupeKey(taskId, over.index ?? 0, CMD_HASH, BASE_TREE),
    ...over,
  });
}

/* ---- pure aggregation fixtures ---- */

function fakeTask(over = {}) {
  const taskId = over.task_id ?? 'TASK'; // matches makeEnvelope()'s default task_id
  const commandHash = over.command_hash ?? computeCommandHash(ARGV, 'direct-exec', '.');
  const baseTree = over.base_tree === undefined ? BASE_TREE : over.base_tree;
  const leases = new Map();
  for (const spec of over.machines ?? []) {
    const m = typeof spec === 'string' ? { machine_id: spec } : spec;
    leases.set(m.machine_id, {
      machine_id: m.machine_id,
      machine_name: m.machine_id,
      index: 0,
      attempt: 1,
      state: m.state ?? 'done',
      refusal_reason: m.refusal_reason ?? null,
      dedupe_key: computeDedupeKey(taskId, 0, commandHash, baseTree),
    });
  }
  return {
    task_id: taskId,
    mode: 'replicate',
    command_argv: ARGV,
    cwd_rel: '.',
    index_total: 1,
    timeout_ms: 1000,
    write: false,
    base_commit: over.base_commit === undefined ? BASE_COMMIT : over.base_commit,
    base_tree: baseTree,
    requirements: {},
    compare_policy: {},
    halt: over.halt ?? 'never',
    created_by: 'test',
    created_at_ms: T0,
    command_hash: commandHash,
    attempt: 1,
    leases,
    cancelled: false,
    cancel_reason: null,
    degraded: null,
    deadline_ms: T0 + 1000,
    result_seqs: [],
  };
}

function rec(machineId, envelope, missing = []) {
  return {
    machine_id: machineId,
    envelope,
    attempt: envelope.attempt ?? 1,
    dedupe_key: envelope.dedupe_key,
    received_at_ms: 1,
    effective_status: missing.length > 0 ? 'unverifiable' : envelope.status,
    validation: { missing, problems: [], envelope_sha256_ok: null },
  };
}

/* ================================================================== */
/* pure helpers                                                        */
/* ================================================================== */

describe('pure helpers', () => {
  it('rfc3339 is second-precision UTC', () => {
    assert.equal(rfc3339(T0), '2026-10-07T12:00:00Z');
    assert.match(rfc3339(Date.now()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('jcs sorts keys deterministically', () => {
    assert.equal(jcs({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  });

  it('sha256 is lowercase hex', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('computeDedupeKey follows §4.4 and never includes attempt', () => {
    const k = computeDedupeKey('01J', 0, CMD_HASH, BASE_TREE);
    assert.equal(k, sha256Hex(`01J|0|${CMD_HASH}|${BASE_TREE}`));
    assert.match(k, /^[0-9a-f]{64}$/);
  });

  it('satisfiesRange handles the §6.1 toolchain gate', () => {
    assert.equal(satisfiesRange('v24.21.0', '>=20'), true);
    assert.equal(satisfiesRange('v18.0.0', '>=20'), false);
    assert.equal(satisfiesRange('v20.0.0', '>=20 <25'), true);
    assert.equal(satisfiesRange('v25.1.0', '>=20 <25'), false);
    assert.equal(satisfiesRange(null, '>=20'), false);
    assert.equal(satisfiesRange('nonsense', '>=20'), false);
  });
});

/* ================================================================== */
/* pairing (§2)                                                        */
/* ================================================================== */

describe('pairing (§2)', () => {
  it('exchanges a one-time code for a device_token', async () => {
    await withRelay({}, async (relay) => {
      assert.match(relay.pairingCode, /^PAIR-[A-Z0-9]{8}$/);
      const { token, body } = await pairDevice(relay, 'm1', { code: relay.pairingCode });
      assert.ok(typeof token === 'string' && token.length >= 32);
      assert.equal(body.protocol_version, 1);
      assert.match(body.rabbit_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

      const devices = await request(`${relay.url}/v1/devices`, { token });
      assert.equal(devices.status, 200);
      assert.equal(devices.json.devices.length, 1);
      assert.equal(devices.json.devices[0].machine_id, 'm1');
      assert.equal(devices.json.devices[0].device_token, undefined, 'device_token must never leak');
    });
  });

  it('rejects an unknown pairing code with PAIRING_INVALID', async () => {
    await withRelay({}, async (relay) => {
      const res = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: { pairing_code: 'PAIR-00000000', machine_id: 'm1' },
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'PAIRING_INVALID');
    });
  });

  it('rejects a reused pairing code', async () => {
    await withRelay({}, async (relay) => {
      await pairDevice(relay, 'm1', { code: relay.pairingCode });
      const res = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: { pairing_code: relay.pairingCode, machine_id: 'm2' },
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'PAIRING_INVALID');
      assert.match(res.json.error.message, /already used/);
    });
  });

  it('rejects an expired pairing code with PAIRING_EXPIRED after 24h', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now }, async (relay) => {
      clock.advance(24 * 60 * 60 * 1000 - 1);
      const ok = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: { pairing_code: relay.pairingCode, machine_id: 'm1' },
      });
      assert.equal(ok.status, 200, 'code must still be valid 1ms before the 24h TTL');

      const code2 = relay.state.createPairingCode();
      clock.advance(24 * 60 * 60 * 1000 + 1);
      const expired = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: { pairing_code: code2, machine_id: 'm2' },
      });
      assert.equal(expired.status, 400);
      assert.equal(expired.json.error.code, 'PAIRING_EXPIRED');
    });
  });
});

/* ================================================================== */
/* auth (§1 / §7)                                                      */
/* ================================================================== */

describe('auth (§1/§7)', () => {
  let relay;
  before(async () => { relay = await startRelay({}); });
  after(async () => { await relay.close(); });

  it('GET /healthz is public', async () => {
    const res = await request(`${relay.url}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.protocol_version, 1);
  });

  it('every protected route answers 401 without a token, with the §7 shape', async () => {
    // v0.1.2 §5: POST /v1/task no longer answers UNAUTHORIZED — it demands the
    // operator token. Every other protected route is unchanged.
    const routes = [
      ['GET', '/v1/stream?machine_id=m1', 'UNAUTHORIZED'],
      ['POST', '/v1/heartbeat', 'UNAUTHORIZED'],
      ['POST', '/v1/result', 'UNAUTHORIZED'],
      ['POST', '/v1/task', 'OPERATOR_REQUIRED'],
      ['GET', '/v1/devices', 'UNAUTHORIZED'],
      ['GET', '/v1/tasks', 'UNAUTHORIZED'],
      ['GET', '/v1/tasks/whatever', 'UNAUTHORIZED'],
      ['GET', '/v1/tasks/whatever/report?format=json', 'UNAUTHORIZED'],
    ];
    for (const [method, path, code] of routes) {
      const res = await request(`${relay.url}${path}`, { method, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path} must be 401`);
      assert.equal(res.json.error.code, code, `${method} ${path}`);
      assert.equal(typeof res.json.error.message, 'string');
      assert.equal(typeof res.json.error.detail, 'object');
      assert.deepEqual(Object.keys(res.json), ['error'], '§7 shape: the body is exactly {error:{...}}');
    }
    const deviceRoute = await request(`${relay.url}/v1/devices`);
    assert.deepEqual(deviceRoute.json, {
      error: { code: 'UNAUTHORIZED', message: 'missing or invalid device_token', detail: {} },
    }, 'unchanged v1 device-auth error body');
  });

  it('rejects a bogus bearer token', async () => {
    const res = await request(`${relay.url}/v1/devices`, { token: 'not-a-real-token' });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'UNAUTHORIZED');
  });

  it('POST /v1/pair needs no bearer token', async () => {
    const res = await request(`${relay.url}/v1/pair`, {
      method: 'POST',
      body: { pairing_code: relay.pairingCode, machine_id: 'auth-m1' },
    });
    assert.equal(res.status, 200);
  });

  it('checks auth before routing, then answers 404 NOT_FOUND', async () => {
    const unauth = await request(`${relay.url}/v1/nope`);
    assert.equal(unauth.status, 401, 'auth is checked before routing');
    assert.equal(unauth.json.error.code, 'UNAUTHORIZED');

    const { token } = await pairDevice(relay, 'router-m1');
    const authed = await request(`${relay.url}/v1/nope`, { token });
    assert.equal(authed.status, 404);
    assert.equal(authed.json.error.code, 'NOT_FOUND');
    assert.equal(typeof authed.json.error.message, 'string');
  });
});

/* ================================================================== */
/* SSE (§3)                                                            */
/* ================================================================== */

describe('SSE (§3)', () => {
  it('first frame is ready; id/event/data present; seq strictly increases', async () => {
    await withRelay({}, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        assert.equal(sse.status, 200);
        assert.equal(sse.headers['content-type'], 'text/event-stream; charset=utf-8');

        const ready = await sse.waitFor((f) => f.event === 'ready');
        assert.equal(sse.frames[0].event, 'ready', 'ready MUST be the first frame');
        assert.equal(ready.id, String(ready.json.seq));
        assert.equal(ready.json.protocol_version, 1);
        assert.equal(ready.json.machine_id, 'm1');
        assert.ok(Number.isInteger(ready.json.seq) && ready.json.seq >= 1);

        const created = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
        assert.equal(created.status, 200);

        const offer = await sse.waitFor((f) => f.event === 'task.offer');
        assert.equal(offer.id, String(offer.json.seq));
        assert.ok(offer.json.seq > ready.json.seq, 'offer seq must follow ready seq');
        assert.equal(offer.json.machine_id, 'm1');
        assert.deepEqual(offer.json.command_argv, ARGV);
        assert.equal(offer.json.dedupe_key, computeDedupeKey(created.json.task_id, 0, CMD_HASH, BASE_TREE));
        assert.match(offer.json.deadline, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

        const seqs = sse.frames.map((f) => f.json?.seq).filter((s) => typeof s === 'number');
        for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], 'seq must be monotonically increasing');
      } finally {
        sse.close();
      }
    });
  });

  it('emits a `: keepalive` comment every keepaliveMs', async () => {
    await withRelay({ keepaliveMs: 40 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const ka = await sse.waitFor((f) => f.comment === true, 1500);
        assert.equal(ka.commentText, 'keepalive');
      } finally {
        sse.close();
      }
    });
  });

  it('replays missed events with ?seq=<last+1>', async () => {
    await withRelay({}, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const sse1 = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      await sse1.waitFor((f) => f.event === 'ready');
      const first = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      const offer1 = await sse1.waitFor((f) => f.event === 'task.offer');
      const lastSeq = offer1.json.seq;
      sse1.close();

      // while disconnected: m2 pairs (broadcast peer.hello) and a second task is offered to m1
      await pairDevice(relay, 'm2');
      const second = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      assert.equal(second.status, 200);
      assert.notEqual(second.json.task_id, first.json.task_id);

      const sse2 = await openSse(`${relay.url}/v1/stream?machine_id=m1&seq=${lastSeq + 1}`, { token });
      try {
        const ready2 = await sse2.waitFor((f) => f.event === 'ready');
        assert.ok(ready2.json.seq > lastSeq);
        const hello = await sse2.waitFor((f) => f.event === 'peer.hello' && f.json.machine_id === 'm2');
        assert.ok(hello.json.seq >= lastSeq + 1 && hello.json.seq <= ready2.json.seq);
        const offer2 = await sse2.waitFor((f) => f.event === 'task.offer' && f.json.task_id === second.json.task_id);
        assert.ok(offer2.json.seq >= lastSeq + 1, 'replayed offer must be newer than the reconnect point');
        assert.ok(offer2.json.seq <= second.json.seq);
      } finally {
        sse2.close();
      }
    });
  });

  it('replays from Last-Event-ID + 1', async () => {
    await withRelay({}, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const sse1 = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      await sse1.waitFor((f) => f.event === 'ready');
      await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      const offer1 = await sse1.waitFor((f) => f.event === 'task.offer');
      const last = offer1.json.seq;
      sse1.close();

      const second = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      const sse2 = await openSse(`${relay.url}/v1/stream?machine_id=m1`, {
        token,
        headers: { 'last-event-id': String(last) },
      });
      try {
        await sse2.waitFor((f) => f.event === 'ready');
        const offer2 = await sse2.waitFor((f) => f.event === 'task.offer' && f.json.task_id === second.json.task_id);
        assert.ok(offer2.json.seq > last);
        const staleOffer = sse2.frames.find((f) => f.event === 'task.offer' && f.json.task_id === second.json.task_id);
        assert.ok(staleOffer, 'replay must deliver the missed offer');
      } finally {
        sse2.close();
      }
    });
  });

  it('warns when the requested seq is older than the ring buffer head', async () => {
    // Pairs 7 devices from 127.0.0.1: the §6 limiter is irrelevant here, and its
    // default of 5/min would (correctly) kick in, so it is switched off.
    await withRelay({ eventBufferSize: 5, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      for (let i = 0; i < 6; i += 1) {
        await pairDevice(relay, `filler-${i}`);
      }
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1&seq=1`, { token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const notice = await sse.waitFor((f) => f.event === 'notice' && f.json.code === 'REPLAY_TRUNCATED');
        assert.equal(notice.json.level, 'warn');
        assert.equal(notice.json.requested_seq, 1);
        assert.ok(Number.isInteger(notice.json.oldest_available_seq),
          '§8.4: the client must learn where to re-align');
        assert.ok(notice.json.oldest_available_seq > 1);
      } finally {
        sse.close();
      }
    });
  });

  it('rejects machine_id that does not match the device_token', async () => {
    await withRelay({}, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      await pairDevice(relay, 'm2');
      const res = await request(`${relay.url}/v1/stream?machine_id=m2`, { token });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'BAD_REQUEST');
    });
  });

  it('cleans up the subscriber when the client disconnects', async () => {
    await withRelay({}, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      await sse.waitFor((f) => f.event === 'ready');
      assert.equal(relay.subscribers.size, 1);
      assert.equal(relay.state.devices.get('m1').streams, 1);
      sse.close();
      for (let i = 0; i < 40 && relay.subscribers.size > 0; i += 1) await sleep(25);
      assert.equal(relay.subscribers.size, 0, 'subscriber must be removed on disconnect');
      assert.equal(relay.state.devices.get('m1').streams, 0);
      assert.equal(relay.state.devices.get('m1').online, false, 'peer.bye → offline');
    });
  });
});

/* ================================================================== */
/* tasks (§4.1 / §6.1)                                                 */
/* ================================================================== */

describe('tasks (§4)', () => {
  it('dispatches a replicate task to every paired device', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const b = await pairDevice(relay, 'm2');
      const sseA = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token: a.token });
      const sseB = await openSse(`${relay.url}/v1/stream?machine_id=m2`, { token: b.token });
      try {
        await sseA.waitFor((f) => f.event === 'ready');
        await sseB.waitFor((f) => f.event === 'ready');
        const created = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
        assert.equal(created.status, 200);
        assert.equal(created.json.leases.length, 2);
        assert.deepEqual(created.json.leases.map((l) => l.machine_id).sort(), ['m1', 'm2']);
        assert.ok(created.json.leases.every((l) => l.state === 'offered' && l.index === 0));
        assert.ok(Number.isInteger(created.json.seq));

        const offerA = await sseA.waitFor((f) => f.event === 'task.offer');
        const offerB = await sseB.waitFor((f) => f.event === 'task.offer');
        assert.equal(offerA.json.task_id, created.json.task_id);
        assert.equal(offerB.json.task_id, created.json.task_id);
        assert.equal(offerA.json.index, 0);
        assert.equal(offerB.json.index, 0);
      } finally {
        sseA.close();
        sseB.close();
      }
    });
  });

  it('honours target_machines', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      await pairDevice(relay, 'm2');
      const created = await request(`${relay.url}/v1/task`, {
        method: 'POST',
        token: OP,
        body: taskBody({ target_machines: ['m2'] }),
      });
      assert.equal(created.status, 200);
      assert.deepEqual(created.json.leases.map((l) => l.machine_id), ['m2']);
    });
  });

  it('split mode assigns indices modulo index_total', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      await pairDevice(relay, 'm2');
      await pairDevice(relay, 'm3');
      const created = await request(`${relay.url}/v1/task`, {
        method: 'POST',
        token: OP,
        body: taskBody({ mode: 'split', index_total: 2 }),
      });
      assert.equal(created.status, 200);
      const indices = Object.fromEntries(created.json.leases.map((l) => [l.machine_id, l.index]));
      assert.deepEqual(indices, { m1: 0, m2: 1, m3: 0 });
    });
  });

  it('applies the §6.1 capability gate: MISSING_NODE', async () => {
    await withRelay({}, async (relay) => {
      const weak = await pairDevice(relay, 'weak', { caps: { ...DEFAULT_CAPS, node: 'v18.0.0' } });
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=weak`, { token: weak.token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const created = await request(`${relay.url}/v1/task`, {
          method: 'POST',
          token: OP,
          body: taskBody({ requirements: { toolchain: { node: '>=20' } } }),
        });
        assert.equal(created.status, 200);
        assert.equal(created.json.leases[0].state, 'refused');
        assert.equal(created.json.leases[0].refusal_reason, 'MISSING_NODE');
        await assert.rejects(sse.waitFor((f) => f.event === 'task.offer', 200), /timeout/);
      } finally {
        sse.close();
      }
    });
  });

  it('applies the §6.1 capability gate: PLATFORM_MISMATCH', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const created = await request(`${relay.url}/v1/task`, {
        method: 'POST',
        token: OP,
        body: taskBody({ requirements: { platform: ['macos'] } }),
      });
      assert.equal(created.json.leases[0].state, 'refused');
      assert.equal(created.json.leases[0].refusal_reason, 'PLATFORM_MISMATCH');
    });
  });

  it('applies the §6.1 capability gate: READ_ONLY_MACHINE', async () => {
    await withRelay({}, async (relay) => {
      await pairDevice(relay, 'ro', { caps: { ...DEFAULT_CAPS, write: false } });
      const created = await request(`${relay.url}/v1/task`, {
        method: 'POST',
        token: OP,
        body: taskBody({ write: true, write_scope: ['src/'] }),
      });
      assert.equal(created.status, 200, created.text);
      assert.equal(created.json.leases[0].state, 'refused');
      assert.equal(created.json.leases[0].refusal_reason, 'READ_ONLY_MACHINE');
    });
  });

  it('answers NO_ONLINE_DEVICE when nothing is paired', async () => {
    await withRelay({}, async (relay) => {
      const res = await request(`${relay.url}/v1/task`, { method: 'POST', token: 'anything', body: taskBody() });
      assert.equal(res.status, 401, 'no token can exist before the first pair');
      const state = new RabbitState({ now: () => T0 });
      assert.throws(() => state.createTask(taskBody()), (err) => err instanceof ProtocolError
        && err.code === 'NO_ONLINE_DEVICE' && err.status === 503);
    });
  });

  it('answers TASK_EXISTS for a duplicate task_id', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const body = taskBody({ task_id: '01JDUPLICATE0000000000000000' });
      const first = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body });
      assert.equal(first.status, 200);
      const second = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body });
      assert.equal(second.status, 409);
      assert.equal(second.json.error.code, 'TASK_EXISTS');
    });
  });

  it('rejects malformed task bodies with BAD_REQUEST', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      for (const bad of [
        taskBody({ mode: 'nope' }),
        taskBody({ command_argv: [] }),
        taskBody({ command_argv: 'node --test' }),
        taskBody({ halt: 'maybe' }),
        taskBody({ index_total: 0 }),
      ]) {
        const res = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: bad });
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.equal(res.json.error.code, 'BAD_REQUEST');
      }
      const notJson = await request(`${relay.url}/v1/task`, {
        method: 'POST',
        token: OP,
        headers: { 'content-type': 'application/json', 'content-length': '0' },
      });
      assert.equal(notJson.status, 400, 'empty body → {} → command_argv missing');
      assert.equal(notJson.json.error.code, 'BAD_REQUEST');

      const badJson = await request(`${relay.url}/v1/task`, {
        method: 'POST', token: OP, rawBody: '{not json',
      });
      assert.equal(badJson.status, 400, 'unparsable JSON');
      assert.equal(badJson.json.error.code, 'BAD_REQUEST');
    });
  });
});

/* ================================================================== */
/* leases (§4.3)                                                       */
/* ================================================================== */

describe('leases (§4.3)', () => {
  it('heartbeat renews the lease using server time only', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now }, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const created = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      const taskId = created.json.task_id;

      clock.advance(40_000);
      const hb = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST',
        token: a.token,
        body: { task_id: taskId, machine_id: 'm1', attempt: 1, phase: 'running', progress: 0.5 },
      });
      assert.equal(hb.status, 200);
      assert.equal(hb.json.cancel, false);
      assert.equal(hb.json.lease_until, rfc3339(clock.now() + 50_000), 'lease_until = now + 20s + 30s grace');
      assert.equal(hb.json.phase, 'running');
      assert.equal(hb.json.progress, 0.5);

      clock.advance(49_000);
      assert.equal(relay.state.sweepExpired().length, 0, '49s < 50s → still alive');
      clock.advance(1_000);
      assert.equal(relay.state.sweepExpired().length, 1, 'exactly 50s → expired');
    });
  });

  it('lease expires after 20s of silence + 30s grace (halt=never)', async () => {
    const clock = makeClock();
    const state = new RabbitState({ now: clock.now });
    state.pair({ pairing_code: state.createPairingCode(), machine_id: 'm1' });
    const created = state.createTask(taskBody());
    const task = state.getTask(created.task_id);
    const lease = task.leases.get('m1');
    assert.equal(lease.state, 'offered');
    assert.equal(lease.lease_until_ms - lease.last_heartbeat_ms, 50_000);

    clock.advance(49_999);
    assert.equal(state.sweepExpired().length, 0);
    clock.advance(1);
    const expired = state.sweepExpired();
    assert.equal(expired.length, 1);
    assert.equal(lease.state, 'expired');
    assert.equal(task.degraded, 'partial', '§4.3 halt=never → book-keeping + partial');
    assert.equal(state.sweepExpired().length, 0, 'sweep is idempotent');

    // late-but-alive agent re-claims its own lease when nobody took over
    const hb = state.heartbeat({ task_id: created.task_id, machine_id: 'm1' });
    assert.equal(hb.cancel, false);
    assert.equal(lease.state, 'running');
  });

  it('heartbeat validates phase/progress and unknown tasks', async () => {
    const clock = makeClock();
    const state = new RabbitState({ now: clock.now });
    state.pair({ pairing_code: state.createPairingCode(), machine_id: 'm1' });
    const created = state.createTask(taskBody());
    assert.throws(() => state.heartbeat({ task_id: created.task_id, machine_id: 'm1', phase: 'bogus' }),
      (e) => e.code === 'BAD_REQUEST');
    assert.throws(() => state.heartbeat({ task_id: created.task_id, machine_id: 'm1', progress: 2 }),
      (e) => e.code === 'BAD_REQUEST');
    assert.throws(() => state.heartbeat({ task_id: 'nope', machine_id: 'm1' }), (e) => e.code === 'NOT_FOUND');
    assert.throws(() => state.heartbeat({ task_id: created.task_id, machine_id: 'ghost' }), (e) => e.code === 'NOT_FOUND');
  });

  it('halt=now re-offers the freed index to an idle machine at attempt+1', async () => {
    const clock = makeClock();
    const state = new RabbitState({ now: clock.now });
    state.pair({ pairing_code: state.createPairingCode(), machine_id: 'a' });
    state.pair({ pairing_code: state.createPairingCode(), machine_id: 'b' });
    const events = [];
    state.onEvent((e) => events.push(e));
    const created = state.createTask(taskBody({ halt: 'now', target_machines: ['a'] }));
    assert.equal(state.getTask(created.task_id).leases.size, 1);

    clock.advance(50_000);
    const expired = state.sweepExpired();
    assert.equal(expired.length, 1);
    assert.equal(expired[0].lease.machine_id, 'a');

    const reoffers = events.filter((e) => e.event.type === 'task.offer' && e.target === 'b');
    assert.equal(reoffers.length, 1, 'idle machine b must be offered the freed index');
    assert.equal(reoffers[0].event.attempt, 2);
    assert.equal(reoffers[0].event.index, 0);
    assert.equal(state.getTask(created.task_id).attempt, 2);
    assert.equal(state.getTask(created.task_id).leases.get('b').state, 'offered');

    const late = state.heartbeat({ task_id: created.task_id, machine_id: 'a' });
    assert.equal(late.cancel, true, 'the old owner must stop once the index was handed over');
    assert.equal(late.reason, 'LEASE_EXPIRED_TAKEN_OVER');
  });

  it('cancelTask makes the next heartbeat return cancel:true', async () => {
    const clock = makeClock();
    const state = new RabbitState({ now: clock.now });
    state.pair({ pairing_code: state.createPairingCode(), machine_id: 'm1' });
    const created = state.createTask(taskBody());
    state.cancelTask(created.task_id, 'operator');
    const hb = state.heartbeat({ task_id: created.task_id, machine_id: 'm1' });
    assert.equal(hb.cancel, true);
    assert.equal(hb.reason, 'operator');
    assert.equal(state.getTask(created.task_id).leases.get('m1').state, 'cancelled');
  });
});

/* ================================================================== */
/* results (§5) / dedupe (§4.4)                                        */
/* ================================================================== */

describe('results & dedupe', () => {
  it('a repeated envelope is deduped, a distinct machine is not dropped', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const b = await pairDevice(relay, 'm2');
      const created = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      const taskId = created.json.task_id;

      const envA = envelopeForTask(taskId, 'm1');
      const first = await request(`${relay.url}/v1/result`, { method: 'POST', token: a.token, body: envA });
      assert.equal(first.status, 200);
      assert.equal(first.json.deduped, false);
      assert.equal(first.json.task_id, taskId);

      const repeat = await request(`${relay.url}/v1/result`, { method: 'POST', token: a.token, body: envA });
      assert.equal(repeat.status, 200);
      assert.equal(repeat.json.deduped, true, 'identical redelivery must dedupe');

      // same dedupe_key (replicate!) but another machine → must still be recorded
      const envB = envelopeForTask(taskId, 'm2');
      assert.equal(envB.dedupe_key, envA.dedupe_key, 'replicate mode shares one dedupe_key by §4.4');
      const second = await request(`${relay.url}/v1/result`, { method: 'POST', token: b.token, body: envB });
      assert.equal(second.json.deduped, false);

      const view = await request(`${relay.url}/v1/tasks/${taskId}`, { token: a.token });
      assert.equal(view.status, 200);
      assert.equal(view.json.aggregate.status, 'consistent');
      assert.equal(view.json.aggregate.machines.length, 2);
    });
  });

  it('records an envelope with missing required fields as unverifiable (§5.1)', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const created = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      const env = envelopeForTask(created.json.task_id, 'm1');
      delete env.stdout_bytes;
      delete env.warnings;
      const res = await request(`${relay.url}/v1/result`, { method: 'POST', token: a.token, body: env });
      assert.equal(res.status, 200, 'a malformed envelope is accepted and booked, not rejected');
      const view = await request(`${relay.url}/v1/tasks/${created.json.task_id}`, { token: a.token });
      assert.equal(view.json.aggregate.status, 'unverifiable');
      assert.deepEqual(view.json.aggregate.machines[0].reasons[0], 'missing required fields: stdout_bytes,warnings');
    });
  });

  it('returns 404 for an unknown task_id', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const res = await request(`${relay.url}/v1/result`, {
        method: 'POST', token: a.token, body: makeEnvelope({ task_id: 'ghost' }),
      });
      assert.equal(res.status, 404);
      assert.equal(res.json.error.code, 'NOT_FOUND');
    });
  });

  it('rejects a non-object result body with BAD_REQUEST', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const res = await request(`${relay.url}/v1/result`, {
        method: 'POST', token: a.token, headers: { 'content-type': 'application/json' },
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'BAD_REQUEST');
    });
  });
});

/* ================================================================== */
/* frame limit (64 KiB)                                                */
/* ================================================================== */

describe('frame limit', () => {
  it(`rejects a >${MAX_FRAME_BYTES}B body with 413 FRAME_TOO_LARGE (content-length)`, async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
      const res = await request(`${relay.url}/v1/result`, {
        method: 'POST',
        token: a.token,
        rawBody: big,
      });
      assert.equal(res.status, 413);
      assert.equal(res.json.error.code, 'FRAME_TOO_LARGE');
      assert.equal(res.json.error.detail.limit_bytes, MAX_FRAME_BYTES);
    });
  });

  it('rejects a chunked >64 KiB body with 413 FRAME_TOO_LARGE', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const chunk = Buffer.from(`{"pad":"${'y'.repeat(8 * 1024)}"}`, 'utf8');
      const chunks = Array.from({ length: 10 }, () => chunk);
      const res = await requestChunked(`${relay.url}/v1/result`, { token: a.token, chunks });
      assert.equal(res.status, 413);
      assert.equal(res.json.error.code, 'FRAME_TOO_LARGE');
    });
  });

  it('accepts a body just under the limit', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const created = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      const env = envelopeForTask(created.json.task_id, 'm1', { stdout_head: 'z'.repeat(60 * 1024) });
      const res = await request(`${relay.url}/v1/result`, { method: 'POST', token: a.token, body: env });
      assert.equal(res.status, 200, res.text.slice(0, 200));
    });
  });
});

/* ================================================================== */
/* six-state aggregation (§6.3) — pure                                 */
/* ================================================================== */

describe('six-state aggregation (§6.3)', () => {
  it('consistent: all comparable fields equal', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1' });
    const e2 = makeEnvelope({ machine_id: 'm2', machine_name: 'm2' });
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2)]);
    assert.equal(agg.status, 'consistent');
    assert.deepEqual(agg.differences, []);
    assert.equal(agg.counts.ok, 2);
  });

  it('divergent: differences outside stdout with identical toolchain/platform', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1' });
    const e2 = makeEnvelope({ machine_id: 'm2', head_commit: 'deadbeef' });
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2)]);
    assert.equal(agg.status, 'divergent');
    assert.deepEqual(agg.differences.map((d) => d.field), ['head_commit']);
  });

  it('divergent: stdout drift with identical toolchain/platform is NOT platform divergence', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1' });
    const e2 = makeEnvelope({ machine_id: 'm2', stdout_sha256: sha256Hex('different'), stdout_bytes: 9 });
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2)]);
    assert.equal(agg.status, 'divergent');
  });

  it('divergent-platform: toolchain differs and drift is stdout-only', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1', toolchain: { node: 'v24.21.0' } });
    const e2 = makeEnvelope({
      machine_id: 'm2',
      toolchain: { node: 'v20.11.0' },
      stdout_sha256: sha256Hex('different'),
      stdout_bytes: 9,
    });
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2)]);
    assert.equal(agg.status, 'divergent-platform');
    assert.equal(agg.steps[3].platform_only, true);
    assert.deepEqual(agg.differences.map((d) => d.field).sort(), ['stdout_bytes', 'stdout_sha256']);
  });

  it('failed: every machine ended in {nonzero_exit,timeout,crashed}', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1', status: 'nonzero_exit', exit_code: 1 });
    const e2 = makeEnvelope({ machine_id: 'm2', status: 'timeout', exit_code: null });
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2)]);
    assert.equal(agg.status, 'failed');
    assert.equal(agg.counts.failed, 2);
    assert.equal(agg.counts.ok, 0);
  });

  it('partial: some ok, some failed', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1' });
    const e2 = makeEnvelope({ machine_id: 'm2', status: 'crashed', exit_code: null });
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2)]);
    assert.equal(agg.status, 'partial');
    assert.equal(agg.counts.ok, 1);
    assert.equal(agg.counts.failed, 1);
  });

  it('unverifiable: missing required field on any machine refuses aggregation', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1' });
    const e2 = makeEnvelope({ machine_id: 'm2' });
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2, ['stdout_bytes'])]);
    assert.equal(agg.status, 'unverifiable');
    assert.equal(agg.steps[1].violations.length, 1);
    assert.equal(agg.steps[2].skipped, 'step1_unverifiable');
  });

  it('unverifiable: base_commit / pre_tree_fingerprint anchor violations', () => {
    const t1 = fakeTask({ machines: ['m1', 'm2'] });
    const agg1 = aggregate(t1, [
      rec('m1', makeEnvelope({ machine_id: 'm1' })),
      rec('m2', makeEnvelope({ machine_id: 'm2', base_commit: 'other' })),
    ]);
    assert.equal(agg1.status, 'unverifiable');

    const t2 = fakeTask({ machines: ['m1', 'm2'] });
    const agg2 = aggregate(t2, [
      rec('m1', makeEnvelope({ machine_id: 'm1' })),
      rec('m2', makeEnvelope({ machine_id: 'm2', pre_tree_fingerprint: 'dirty-tree' })),
    ]);
    assert.equal(agg2.status, 'unverifiable');

    const t3 = fakeTask({ machines: ['m1', 'm2'] });
    const agg3 = aggregate(t3, [
      rec('m1', makeEnvelope({ machine_id: 'm1' })),
      rec('m2', makeEnvelope({ machine_id: 'm2', command_hash: sha256Hex('other') })),
    ]);
    assert.equal(agg3.status, 'unverifiable');
  });

  it('step order matters: Step 1 wins over a would-be consistent Step 3', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1' });
    const e2 = makeEnvelope({ machine_id: 'm2', stdout_bytes: 5 }); // identical
    // machine 2 has a missing field, everything else compares equal
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2, ['stderr_bytes'])]);
    assert.equal(agg.status, 'unverifiable', 'not consistent');
  });

  it('Step 0 does not block other machines', () => {
    const task = fakeTask({
      machines: [{ machine_id: 'm1' }, { machine_id: 'm2' }, { machine_id: 'm3', state: 'refused', refusal_reason: 'MISSING_NODE' }],
    });
    const agg = aggregate(task, [
      rec('m1', makeEnvelope({ machine_id: 'm1' })),
      rec('m2', makeEnvelope({ machine_id: 'm2' })),
    ]);
    assert.equal(agg.status, 'consistent');
    assert.equal(agg.counts.refused, 1);
    const refused = agg.machines.find((m) => m.machine_id === 'm3');
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.refusal_reason, 'MISSING_NODE');
  });

  it('refused: every machine refused (gate) with no results', () => {
    const task = fakeTask({
      machines: [{ machine_id: 'm1', state: 'refused', refusal_reason: 'PLATFORM_MISMATCH' }],
    });
    const agg = aggregate(task, []);
    assert.equal(agg.status, 'refused');
    assert.equal(agg.counts.refused, 1);
  });

  it('refused: an envelope with status=refused is booked without blocking others', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const agg = aggregate(task, [
      rec('m1', makeEnvelope({ machine_id: 'm1' })),
      rec('m2', makeEnvelope({ machine_id: 'm2', status: 'refused', refusal_reason: 'READ_ONLY_MACHINE', exit_code: null })),
    ]);
    assert.equal(agg.status, 'consistent');
    assert.equal(agg.counts.refused, 1);
  });

  it('pending: no result yet', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const agg = aggregate(task, []);
    assert.equal(agg.status, 'pending');
  });

  it('partial: an expired lease is booked as partial (§4.3)', () => {
    const task = fakeTask({ machines: [{ machine_id: 'm1' }, { machine_id: 'm2', state: 'expired' }] });
    const agg = aggregate(task, [rec('m1', makeEnvelope({ machine_id: 'm1' }))]);
    assert.equal(agg.status, 'partial');
    assert.equal(agg.counts.expired, 1);
  });

  it('aggregateTask pulls results straight out of a RabbitState', () => {
    const clock = makeClock();
    const state = new RabbitState({ now: clock.now });
    state.pair({ pairing_code: state.createPairingCode(), machine_id: 'm1' });
    const created = state.createTask(taskBody());
    state.submitResult(envelopeForTask(created.task_id, 'm1', {
      dedupe_key: computeDedupeKey(created.task_id, 0, CMD_HASH, BASE_TREE),
    }));
    const agg = aggregateTask(state, created.task_id);
    assert.equal(agg.status, 'consistent');
    assert.throws(() => aggregateTask(state, 'nope'), (e) => e.code === 'NOT_FOUND');
  });
});

/* ================================================================== */
/* reports                                                             */
/* ================================================================== */

describe('reports', () => {
  it('renders markdown and json reports', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      await pairDevice(relay, 'm2');
      const created = await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      const taskId = created.json.task_id;
      for (const m of ['m1', 'm2']) {
        const res = await request(`${relay.url}/v1/result`, {
          method: 'POST', token: a.token, body: envelopeForTask(taskId, m),
        });
        assert.equal(res.status, 200);
      }

      const json = await request(`${relay.url}/v1/tasks/${taskId}/report?format=json`, { token: a.token });
      assert.equal(json.status, 200);
      assert.match(json.headers['content-type'], /application\/json/);
      assert.equal(json.json.status, 'consistent');
      assert.equal(json.json.task_id, taskId);
      assert.equal(json.json.steps.length, 4);
      assert.deepEqual(json.json.steps.map((s) => s.step), [0, 1, 2, 3]);

      const md = await request(`${relay.url}/v1/tasks/${taskId}/report?format=md`, { token: a.token });
      assert.equal(md.status, 200);
      assert.match(md.headers['content-type'], /text\/markdown/);
      assert.match(md.text, /# W2M 汇总报告/);
      assert.match(md.text, /consistent/);
      assert.match(md.text, /m1/);

      const def = await request(`${relay.url}/v1/tasks/${taskId}/report`, { token: a.token });
      assert.equal(def.status, 200);
      assert.equal(def.json.status, 'consistent');

      const bad = await request(`${relay.url}/v1/tasks/${taskId}/report?format=xml`, { token: a.token });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'BAD_REQUEST');
    });
  });

  it('renderReportMarkdown lists differences and steps', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const agg = aggregate(task, [
      rec('m1', makeEnvelope({ machine_id: 'm1' })),
      rec('m2', makeEnvelope({ machine_id: 'm2', head_commit: 'deadbeef' })),
    ]);
    const md = renderReportMarkdown(agg, task);
    assert.match(md, /divergent/);
    assert.match(md, /head_commit/);
    assert.match(md, /Step 3/);
    assert.match(md, /\["node","--test"\]/);
  });

  it('GET /v1/tasks lists tasks with a limit', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      for (let i = 0; i < 3; i += 1) {
        await request(`${relay.url}/v1/task`, { method: 'POST', token: OP, body: taskBody() });
      }
      const all = await request(`${relay.url}/v1/tasks`, { token: a.token });
      assert.equal(all.json.tasks.length, 3);
      const one = await request(`${relay.url}/v1/tasks?limit=1`, { token: a.token });
      assert.equal(one.json.tasks.length, 1);
      const bad = await request(`${relay.url}/v1/tasks?limit=0`, { token: a.token });
      assert.equal(bad.status, 400);
    });
  });

  it('GET /v1/tasks/{id} returns 404 for an unknown task', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');
      const res = await request(`${relay.url}/v1/tasks/nope`, { token: a.token });
      assert.equal(res.status, 404);
      assert.equal(res.json.error.code, 'NOT_FOUND');
    });
  });
});

/* ================================================================== */
/* v0.1.2 §3 — deployment base path                                    */
/* ================================================================== */

describe('v0.1.2 base path (§3)', () => {
  it('normalizeBasePath normalises the prefix', () => {
    assert.equal(normalizeBasePath(undefined), '/');
    assert.equal(normalizeBasePath(null), '/');
    assert.equal(normalizeBasePath(''), '/');
    assert.equal(normalizeBasePath('/'), '/');
    assert.equal(normalizeBasePath('w2m'), '/w2m');
    assert.equal(normalizeBasePath('/w2m/'), '/w2m');
    assert.equal(normalizeBasePath('//w2m//team//'), '/w2m/team');
    assert.equal(normalizeBasePath('/w2m'), '/w2m');
  });

  it('routes under the prefix; /healthz answers at prefix AND root', async () => {
    await withRelay({ basePath: '/w2m' }, async (relay) => {
      assert.equal(relay.basePath, '/w2m');
      assert.ok(relay.url.endsWith('/w2m'), `url should carry the prefix: ${relay.url}`);
      const origin = `http://127.0.0.1:${relay.port}`;

      const prefixedHealth = await request(`${relay.url}/healthz`);
      assert.equal(prefixedHealth.status, 200);
      const rootHealth = await request(`${origin}/healthz`);
      assert.equal(rootHealth.status, 200, '/healthz must also answer at the root');
      assert.equal(rootHealth.json.base_path, '/w2m');
      assert.equal(rootHealth.json.relay_id, relay.relayId);

      // /v1/* works under the prefix…
      const { token } = await pairDevice(relay, 'm1');
      const devices = await request(`${relay.url}/v1/devices`, { token });
      assert.equal(devices.status, 200);
      assert.equal(devices.json.devices.length, 1);

      // …and 404s outside it — including with a perfectly valid token.
      const outside = await request(`${origin}/v1/devices`, { token });
      assert.equal(outside.status, 404, 'outside the prefix must be 404, not 401 and not 502');
      assert.equal(outside.json.error.code, 'NOT_FOUND');
      assert.equal(outside.json.error.detail.base_path, '/w2m');

      const outsideAnonymous = await request(`${origin}/v1/devices`);
      assert.equal(outsideAnonymous.status, 404);
      assert.equal(outsideAnonymous.json.error.code, 'NOT_FOUND');
    });
  });

  it('accepts a trailing slash on the configured prefix', async () => {
    await withRelay({ basePath: '/team-a/w2m/' }, async (relay) => {
      assert.equal(relay.basePath, '/team-a/w2m');
      const hz = await request(`${relay.url}/healthz`);
      assert.equal(hz.status, 200);
      assert.equal(hz.json.base_path, '/team-a/w2m');
    });
  });
});

/* ================================================================== */
/* v0.1.2 §3/§4 — proxy headers                                        */
/* ================================================================== */

describe('v0.1.2 trust-proxy (§3/§4)', () => {
  it('ignores X-Forwarded-* unless trustProxy is on', async () => {
    await withRelay({ trustProxy: false }, async (relay) => {
      const hz = await request(`${relay.url}/healthz`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(hz.json.effective_scheme, 'http', 'a forged X-Forwarded-Proto must be ignored');
    });
    await withRelay({ trustProxy: true }, async (relay) => {
      const forwarded = await request(`${relay.url}/healthz`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(forwarded.json.effective_scheme, 'https');
      const bare = await request(`${relay.url}/healthz`);
      assert.equal(bare.json.effective_scheme, 'http', 'falls back to the real listener scheme');
    });
  });

  it('a forged X-Forwarded-For cannot buy extra pair attempts when trustProxy is off', async () => {
    await withRelay({ pairRateLimitPerMinute: 2, trustProxy: false }, async (relay) => {
      const attempt = (ip) => request(`${relay.url}/v1/pair`, {
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
        body: { pairing_code: 'PAIR-NOSUCH00', machine_id: 'm1' },
      });
      assert.equal((await attempt('198.51.100.1')).status, 400, 'bad code, but it counts');
      assert.equal((await attempt('198.51.100.2')).status, 400);
      const third = await attempt('198.51.100.3');
      assert.equal(third.status, 429, 'rotating XFF must NOT reset the budget');
      assert.equal(third.json.error.code, 'RATE_LIMITED');
    });
  });

  it('honours the first X-Forwarded-For hop per client when trustProxy is on', async () => {
    await withRelay({ pairRateLimitPerMinute: 1, trustProxy: true }, async (relay) => {
      const attempt = (xff) => request(`${relay.url}/v1/pair`, {
        method: 'POST',
        headers: { 'x-forwarded-for': xff },
        body: { pairing_code: 'PAIR-NOSUCH00', machine_id: 'm1' },
      });
      assert.equal((await attempt('203.0.113.7')).status, 400);
      assert.equal((await attempt('203.0.113.8')).status, 400, 'a different client IP has its own budget');
      assert.equal((await attempt('203.0.113.7, 10.0.0.1')).status, 429, 'only the first hop identifies the client');
    });
  });
});

/* ================================================================== */
/* v0.1.2 §5 — operator token                                          */
/* ================================================================== */

describe('v0.1.2 operator token (§5)', () => {
  it('accepts the operator token, rejects device tokens and missing tokens', async () => {
    await withRelay({}, async (relay) => {
      const a = await pairDevice(relay, 'm1');

      const ok = await postTask(relay, taskBody());
      assert.equal(ok.status, 200, ok.text);
      assert.ok(ok.json.task_id);

      const asDevice = await postTask(relay, taskBody(), a.token);
      assert.equal(asDevice.status, 401, 'a device token must NOT be able to dispatch');
      assert.equal(asDevice.json.error.code, 'OPERATOR_REQUIRED');
      assert.equal(asDevice.json.error.detail.device_token_detected, true);
      assert.match(asDevice.json.error.message, /device_token/);
      assert.match(asDevice.json.error.message, /operator_token/);

      const missing = await request(`${relay.url}/v1/task`, { method: 'POST', body: taskBody() });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error.code, 'OPERATOR_REQUIRED');
      assert.match(missing.json.error.message, /operator token/i);

      const junk = await postTask(relay, taskBody(), 'not-the-operator-token');
      assert.equal(junk.status, 401);
      assert.equal(junk.json.error.code, 'OPERATOR_REQUIRED');
      assert.equal(junk.json.error.detail.device_token_detected, false);

      // §5.3: the operator token is NOT a master key for the device endpoints
      const wrongEndpoint = await request(`${relay.url}/v1/devices`, { token: OP });
      assert.equal(wrongEndpoint.status, 401);
      assert.equal(wrongEndpoint.json.error.code, 'UNAUTHORIZED');

      // device tokens still work on their own endpoints
      const heartbeat = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST', token: a.token, body: { task_id: ok.json.task_id, machine_id: 'm1' },
      });
      assert.equal(heartbeat.status, 200);
    });
  });

  it('--operator-token "" disables the requirement and warns loudly', async () => {
    const dir = makeStateDir();
    try {
      await withRelay({ operatorToken: '', stateDir: dir }, async (relay) => {
        assert.equal(relay.operatorTokenRequired, false);
        assert.equal(relay.operatorToken, null);
        const hz = await request(`${relay.url}/healthz`);
        assert.equal(hz.json.operator_token_required, false);
        assert.ok(
          relay.startupMessages.some((m) => /OPERATOR TOKEN DISABLED/.test(m) && /WARNING/.test(m)),
          `startup banner must warn: ${JSON.stringify(relay.startupMessages)}`,
        );

        // escape hatch = v1 semantics: a paired device may dispatch…
        const a = await pairDevice(relay, 'm1');
        assert.equal((await postTask(relay, taskBody(), a.token)).status, 200);
        // …but the endpoint is not simply unauthenticated
        const anon = await request(`${relay.url}/v1/task`, { method: 'POST', body: taskBody() });
        assert.equal(anon.status, 401);
        assert.equal(anon.json.error.code, 'UNAUTHORIZED');
      });
    } finally {
      removeStateDir(dir);
    }
  });

  it('generates a token, persists it 0600 and reuses it across restarts', async () => {
    const dir = makeStateDir();
    try {
      const first = await startRelay({ operatorToken: undefined, stateDir: dir });
      const token1 = first.operatorToken;
      assert.match(token1, /^[0-9a-f]{64}$/, 'a generated operator token is 32 random bytes');
      assert.equal(first.operatorTokenRequired, true);
      await first.close();

      const tokenFile = path.join(dir, 'operator-token.txt');
      assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), token1, '§5.1: written to <state>/operator-token.txt');

      const second = await startRelay({ operatorToken: undefined, stateDir: dir });
      assert.equal(second.operatorToken, token1, 'a restart must not silently invalidate the plugin config');
      assert.equal(second.operatorTokenSource, 'restored');
      await second.close();
    } finally {
      removeStateDir(dir);
    }
  });

  it('a supplied --pairing-code is registered and immediately usable (v0.1.2 BUG-1)', async () => {
    const dir = makeStateDir();
    try {
      await withRelay({ pairingCode: 'PAIR-FIXEDTEST', stateDir: dir }, async (relay) => {
        assert.equal(relay.pairingCode, 'PAIR-FIXEDTEST');
        const hz = await request(`${relay.url}/healthz`);
        assert.equal(hz.json.pairing_codes, 1, 'the supplied code must be registered in the state, not just advertised');

        const paired = await request(`${relay.url}/v1/pair`, {
          method: 'POST',
          body: { pairing_code: 'PAIR-FIXEDTEST', machine_id: 'scripted-m1', platform: DEFAULT_PLATFORM, caps: DEFAULT_CAPS },
        });
        assert.equal(paired.status, 200, paired.text);
        assert.ok(typeof paired.json.device_token === 'string' && paired.json.device_token.length > 0);
      });
    } finally {
      removeStateDir(dir);
    }
  });

  it('the default logger writes diagnostics to stderr, never stdout (BUG-2)', () => {
    // Done in a child process with FILE-backed stdio: capturing the parent's
    // stdout would also capture the test runner's own protocol output, and pipes
    // are unavailable under some sandboxes.
    const dir = makeStateDir();
    try {
      const outFile = path.join(dir, 'child-stdout.txt');
      const errFile = path.join(dir, 'child-stderr.txt');
      const script = [
        `import { startRelayServer } from ${JSON.stringify(SERVER_URL)};`,
        'const relay = await startRelayServer({ persist: false });',
        "process.stdout.write(JSON.stringify({ url: relay.url, relayId: relay.relayId }) + '\\n');",
        'await relay.close();',
      ].join('\n');
      const fdOut = fs.openSync(outFile, 'w');
      const fdErr = fs.openSync(errFile, 'w');
      let result;
      try {
        result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          stdio: ['ignore', fdOut, fdErr],
        });
      } finally {
        fs.closeSync(fdOut);
        fs.closeSync(fdErr);
      }
      const stdout = fs.readFileSync(outFile, 'utf8');
      const stderr = fs.readFileSync(errFile, 'utf8');
      assert.equal(result.status, 0, `child failed: ${stderr}`);

      const lines = stdout.split('\n').filter((l) => l.trim() !== '');
      assert.equal(lines.length, 1, `stdout must carry exactly the machine output, got:\n${stdout}`);
      const parsed = JSON.parse(lines[0]); // throws if prose polluted stdout
      assert.match(parsed.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(parsed.relayId, /^[0-9a-f]{16}$/);

      assert.match(stderr, /\[w2m-rabbit\]/, 'diagnostics belong on stderr');
      assert.match(stderr, /operator token/);
    } finally {
      removeStateDir(dir);
    }
  });
});

/* ================================================================== */
/* v0.1.2 §6 — /v1/pair rate limiting                                  */
/* ================================================================== */

describe('v0.1.2 pair rate limit (§6)', () => {
  it('maps the v0.1.2 error codes to the contract HTTP statuses', () => {
    // Regression guard: a code missing from ERROR_STATUS degrades to HTTP 500
    // while keeping the right `code`, so the status must be pinned explicitly.
    assert.equal(new ProtocolError('OPERATOR_REQUIRED', 'x').status, 401, '§5.2 requires 401');
    assert.equal(new ProtocolError('RATE_LIMITED', 'x').status, 429, '§6 requires 429');
    assert.equal(new ProtocolError('UNAUTHORIZED', 'x').status, 401);
    assert.equal(new ProtocolError('FRAME_TOO_LARGE', 'x').status, 413);
  });

  it('SlidingWindowRateLimiter counts every attempt, successes included', () => {
    const clock = makeClock();
    const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });
    assert.equal(limiter.hit('ip').allowed, true);
    assert.equal(limiter.hit('ip').allowed, true);
    const blocked = limiter.hit('ip');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retry_after_seconds, 60);
    assert.equal(limiter.hit('other-ip').allowed, true, 'buckets are per key');
    clock.advance(60_000);
    assert.equal(limiter.hit('ip').allowed, true, 'sliding window frees the slot');
  });

  it('answers 429 RATE_LIMITED with retry_after_seconds and Recovers after the window', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 2 }, async (relay) => {
      // A SUCCESSFUL pair rotates the code, so each attempt mints a fresh one —
      // this is exactly the "successes count too" case §6 calls out.
      const pair = () => request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: {
          pairing_code: relay.state.createPairingCode(),
          machine_id: `m-${Math.random().toString(36).slice(2)}`,
          platform: DEFAULT_PLATFORM,
          caps: DEFAULT_CAPS,
        },
      });
      assert.equal((await pair()).status, 200, 'successful pairs count toward the budget');
      assert.equal((await pair()).status, 200);

      const limited = await pair();
      assert.equal(limited.status, 429);
      assert.equal(limited.json.error.code, 'RATE_LIMITED');
      assert.ok(Number.isInteger(limited.json.error.detail.retry_after_seconds));
      assert.ok(limited.json.error.detail.retry_after_seconds >= 1
        && limited.json.error.detail.retry_after_seconds <= 60);
      assert.equal(limited.json.error.detail.limit, 2);
      assert.equal(limited.json.error.detail.window_seconds, 60);
      assert.equal(limited.headers['retry-after'], String(limited.json.error.detail.retry_after_seconds));
      assert.equal(limited.json.retry_after_seconds, limited.json.error.detail.retry_after_seconds,
        'the value is mirrored top-level as well as inside error.detail');

      clock.advance(60_001);
      const afterWindow = await pair();
      assert.equal(afterWindow.status, 200, 'the budget refills after 60s');
    });
  });

  it('pair_rate_limit 0 disables the limiter', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      for (let i = 0; i < 8; i += 1) {
        const res = await request(`${relay.url}/v1/pair`, {
          method: 'POST',
          body: { pairing_code: 'PAIR-NOSUCH00', machine_id: 'm' },
        });
        assert.equal(res.status, 400, `attempt ${i} must reach the pairing logic, not the limiter`);
      }
    });
  });
});

/* ================================================================== */
/* v0.1.2 §7 — persistence                                             */
/* ================================================================== */

describe('v0.1.2 persistence (§7)', () => {
  it('revives devices, tasks and the dedupe index after a restart', async () => {
    const dir = makeStateDir();
    try {
      const first = await startRelay({ stateDir: dir, pairingCode: 'PAIR-RESTORE1' });
      const paired = await pairDevice(first, 'm1', { code: 'PAIR-RESTORE1' });
      const deviceToken = paired.token;
      const created = await postTask(first, taskBody({ task_id: '01JRESTORE0000000000000000' }));
      const taskId = created.json.task_id;
      const envelope = envelopeForTask(taskId, 'm1');
      const stored = await request(`${first.url}/v1/result`, { method: 'POST', token: deviceToken, body: envelope });
      assert.equal(stored.json.deduped, false);
      const firstRelayId = first.relayId;
      await first.close();

      // devices.json is an atomic snapshot; the ledger is append-only JSONL
      assert.ok(fs.existsSync(path.join(dir, 'devices.json')));
      assert.ok(fs.existsSync(path.join(dir, 'ledger.jsonl')));
      assert.equal(fs.readdirSync(dir).some((f) => f.includes('.tmp-')), false, 'no temp snapshot left behind');

      const second = await startRelay({ stateDir: dir });
      try {
        assert.notEqual(second.relayId, firstRelayId, '§8.3: a restart gets a new relay_id');
        assert.equal(second.state.devices.get('m1').online, false,
          'a restored snapshot proves the device exists, not that it is connected');
        const hz = await request(`${second.url}/healthz`);
        assert.equal(hz.json.persistence.enabled, true);
        assert.equal(hz.json.persistence.revived_devices, 1);
        assert.equal(hz.json.persistence.revived_tasks, 1);
        assert.equal(hz.json.persistence.devices_corrupt, false);

        // the SAME device token still authenticates: no re-pairing needed
        const devices = await request(`${second.url}/v1/devices`, { token: deviceToken });
        assert.equal(devices.status, 200);
        assert.equal(devices.json.devices.length, 1);
        assert.equal(devices.json.devices[0].machine_id, 'm1');
        assert.equal(devices.json.devices[0].streams, 0, 'no SSE stream yet after the restart');

        // task + lease + result survived
        const view = await request(`${second.url}/v1/tasks/${taskId}`, { token: deviceToken });
        assert.equal(view.status, 200);
        assert.equal(view.json.aggregate.status, 'consistent');
        assert.equal(view.json.task.task_id, taskId);

        // dedupe index survived: the identical redelivery is still deduped
        const repeated = await request(`${second.url}/v1/result`, { method: 'POST', token: deviceToken, body: envelope });
        assert.equal(repeated.status, 200);
        assert.equal(repeated.json.deduped, true, 'the dedupe key was rebuilt from the ledger');
      } finally {
        await second.close();
      }
    } finally {
      removeStateDir(dir);
    }
  });

  it('reports a corrupt devices.json loudly instead of silently wiping it', async () => {
    const dir = makeStateDir();
    try {
      const damaged = '{ this is not json';
      fs.writeFileSync(path.join(dir, 'devices.json'), damaged);
      const relay = await startRelay({ stateDir: dir });
      try {
        const hz = await request(`${relay.url}/healthz`);
        assert.equal(hz.json.persistence.enabled, true);
        assert.equal(hz.json.persistence.devices_corrupt, true);
        assert.equal(hz.json.devices, 0, 'starts from an empty table');
        assert.ok(
          hz.json.persistence.warnings.some((w) => w.file === 'devices.json'),
          'the damage must be reported in /healthz',
        );
        assert.ok(
          relay.startupMessages.some((m) => /CORRUPT/.test(m)),
          `the startup log must say it loudly: ${JSON.stringify(relay.startupMessages)}`,
        );
        assert.equal(fs.readFileSync(path.join(dir, 'devices.json'), 'utf8'), damaged,
          'the damaged snapshot is left untouched for forensics');
      } finally {
        await relay.close();
      }
    } finally {
      removeStateDir(dir);
    }
  });

  it('skips one corrupt ledger line, keeps the rest and counts warnings', async () => {
    const dir = makeStateDir();
    try {
      const first = await startRelay({ stateDir: dir, pairingCode: 'PAIR-LEDGER01' });
      const paired = await pairDevice(first, 'm1', { code: 'PAIR-LEDGER01' });
      const created = await postTask(first, taskBody({ task_id: '01JLEDGER00000000000000000' }));
      const taskId = created.json.task_id;
      await first.close();

      const ledgerFile = path.join(dir, 'ledger.jsonl');
      const lines = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const good = lines.length;
      lines.splice(1, 0, '{"type":"task.created", THIS IS NOT JSON');
      lines.push(''); // trailing newline
      fs.writeFileSync(ledgerFile, lines.join('\n'));

      const second = await startRelay({ stateDir: dir });
      try {
        const hz = await request(`${second.url}/healthz`);
        assert.equal(hz.json.persistence.ledger_lines_skipped, 1);
        assert.equal(hz.json.persistence.ledger_lines_read, good + 1);
        assert.equal(hz.json.persistence.revived_tasks, 1, 'the intact entries still replay');
        assert.ok(hz.json.persistence.warnings.some((w) => w.file === 'ledger.jsonl' && w.line === 2));
        const view = await request(`${second.url}/v1/tasks/${taskId}`, { token: paired.token });
        assert.equal(view.status, 200, 'the relay started despite the corruption');
      } finally {
        await second.close();
      }
    } finally {
      removeStateDir(dir);
    }
  });

  it('persist:false is pure in-memory (v1 behaviour) and reports enabled:false', async () => {
    const dir = makeStateDir();
    try {
      await withRelay({ persist: false, stateDir: dir }, async (relay) => {
        const a = await pairDevice(relay, 'm1');
        await postTask(relay, taskBody());
        const hz = await request(`${relay.url}/healthz`);
        assert.equal(hz.json.persistence.enabled, false);
        assert.equal(hz.json.persistence.dir, null);
        assert.equal(hz.json.devices, 1, 'still works in memory');
        assert.equal(hz.json.tasks, 1);
        assert.equal(a.token.length > 0, true);
      });
      assert.deepEqual(fs.readdirSync(dir), [], 'nothing may be written when persistence is off');
    } finally {
      removeStateDir(dir);
    }
  });
});

/* ================================================================== */
/* v0.1.2 §4/§8 — healthz fields, SSE hardening, relay_id              */
/* ================================================================== */

describe('v0.1.2 observability (§4/§8)', () => {
  it('/healthz exposes the cross-region operations fields', async () => {
    await withRelay({ basePath: '/w2m', trustProxy: true, pairRateLimitPerMinute: 7 }, async (relay) => {
      const hz = await request(`${relay.url}/healthz`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(hz.status, 200);
      assert.equal(hz.json.ok, true);
      assert.equal(hz.json.protocol_version, 1);
      assert.equal(hz.json.relay_id, relay.relayId);
      assert.match(hz.json.relay_id, /^[0-9a-f]{16}$/);
      assert.match(hz.json.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(hz.json.rabbit_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(hz.json.effective_scheme, 'https');
      assert.equal(hz.json.base_path, '/w2m');
      assert.equal(hz.json.operator_token_required, true);
      assert.equal(hz.json.pair_rate_limit, 7);
      assert.deepEqual(
        Object.keys(hz.json.persistence).sort(),
        ['devices_corrupt', 'devices_missing', 'dir', 'enabled', 'ledger_lines_read',
          'ledger_lines_skipped', 'revived_devices', 'revived_tasks', 'warnings'],
      );
      assert.equal(hz.json.persistence.enabled, false);
      const serialized = JSON.stringify(hz.json);
      assert.equal(serialized.includes(OP), false, '/healthz must never leak the operator token');
    });
  });

  it('SSE carries the anti-buffering headers and a ready frame with relay_id', async () => {
    await withRelay({}, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        assert.equal(sse.headers['x-accel-buffering'], 'no');
        assert.equal(sse.headers['cache-control'], 'no-cache, no-transform');
        assert.match(sse.headers['content-type'], /text\/event-stream/);
        const ready = await sse.waitFor((f) => f.event === 'ready');
        assert.equal(ready.json.relay_id, relay.relayId, '§8.3: clients detect a restart via relay_id');
        assert.equal(ready.json.machine_id, 'm1');
      } finally {
        sse.close();
      }
    });
  });

  it('no HTTP response and no SSE frame leaks a credential', async () => {
    // Credentials may only appear in the /v1/pair response (which hands a machine
    // its OWN device_token) and in the startup banner on stderr. Everything here is
    // something a user would pipe into a log file, so all of it is scanned.
    const dir = makeStateDir();
    try {
      const relay = await startRelay({
        stateDir: dir, operatorToken: undefined, pairingCode: 'PAIR-NOLEAK01', pairRateLimitPerMinute: 0,
      });
      try {
        const operatorToken = relay.operatorToken;
        assert.match(operatorToken, /^[0-9a-f]{64}$/);
        const { token: deviceToken } = await pairDevice(relay, 'm1', { code: 'PAIR-NOLEAK01' });
        const created = await postTask(relay, taskBody());
        const taskId = created.json.task_id;
        await request(`${relay.url}/v1/result`, {
          method: 'POST', token: deviceToken, body: envelopeForTask(taskId, 'm1'),
        });

        const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token: deviceToken });
        const seen = [];
        const grab = async (label, promise) => {
          const res = await promise;
          seen.push([label, res.text]);
          return res;
        };

        await grab('healthz', request(`${relay.url}/healthz`));
        await grab('healthz-forwarded', request(`${relay.url}/healthz`, {
          headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' },
        }));
        await grab('devices', request(`${relay.url}/v1/devices`, { token: deviceToken }));
        await grab('tasks', request(`${relay.url}/v1/tasks`, { token: deviceToken }));
        await grab('task', request(`${relay.url}/v1/tasks/${taskId}`, { token: deviceToken }));
        await grab('task-404', request(`${relay.url}/v1/tasks/nope`, { token: deviceToken }));
        await grab('report-json', request(`${relay.url}/v1/tasks/${taskId}/report?format=json`, { token: deviceToken }));
        await grab('report-md', request(`${relay.url}/v1/tasks/${taskId}/report?format=md`, { token: deviceToken }));
        await grab('heartbeat', request(`${relay.url}/v1/heartbeat`, {
          method: 'POST', token: deviceToken, body: { task_id: taskId, machine_id: 'm1' },
        }));
        await grab('result-repeat', request(`${relay.url}/v1/result`, {
          method: 'POST', token: deviceToken, body: envelopeForTask(taskId, 'm1'),
        }));
        await grab('task-created', postTask(relay, taskBody()));
        // error paths carry `detail` too — the easiest place to leak by accident
        await grab('err-operator-missing', request(`${relay.url}/v1/task`, { method: 'POST', body: taskBody() }));
        await grab('err-operator-device-token', postTask(relay, taskBody(), deviceToken));
        await grab('err-unauthorized', request(`${relay.url}/v1/devices`));
        await grab('err-not-found', request(`${relay.url}/v1/nope`, { token: deviceToken }));
        await grab('err-bad-request', request(`${relay.url}/v1/task`, {
          method: 'POST', token: operatorToken, body: { mode: 'nope' },
        }));
        await grab('err-pairing-invalid', request(`${relay.url}/v1/pair`, {
          method: 'POST', body: { pairing_code: 'PAIR-WRONGXXX', machine_id: 'x' },
        }));

        // the pairing response legitimately carries the machine's own device_token
        const pairResponse = await request(`${relay.url}/v1/pair`, {
          method: 'POST',
          body: {
            pairing_code: relay.state.createPairingCode(),
            machine_id: 'm2', platform: DEFAULT_PLATFORM, caps: DEFAULT_CAPS,
          },
        });
        assert.equal(pairResponse.status, 200);
        assert.equal(pairResponse.text.includes(operatorToken), false, '/v1/pair must not echo the operator token');

        await sse.waitFor((f) => f.event === 'ready');
        await sleep(50); // let offer/result frames flush
        for (const frame of sse.frames) {
          assert.equal(frame.raw.includes(operatorToken), false, `SSE frame leaked the operator token: ${frame.raw}`);
          assert.equal(frame.raw.includes(deviceToken), false, `SSE frame leaked a device token: ${frame.raw}`);
        }
        sse.close();

        for (const [label, text] of seen) {
          assert.equal(text.includes(operatorToken), false, `${label} leaked the OPERATOR token`);
          assert.equal(text.includes(deviceToken), false, `${label} leaked a DEVICE token`);
        }
        const healthz = JSON.parse(seen.find(([l]) => l === 'healthz')[1]);
        // A boolean presence flag is fine; a field carrying the secret itself is not.
        assert.equal('operator_token' in healthz, false, '/healthz must not carry an operator_token field');
        assert.equal('device_token' in healthz, false, '/healthz must not carry a device_token field');
        assert.equal('token' in healthz, false, '/healthz must not carry a bare token field');
        assert.deepEqual(
          Object.keys(healthz).filter((k) => /token/i.test(k)),
          ['operator_token_required'],
          'the only token-named field is the boolean presence flag',
        );
        assert.equal(typeof healthz.operator_token_required, 'boolean');
        assert.equal(healthz.operator_token_required, true, 'presence is reported instead of the value');
      } finally {
        await relay.close();
      }
    } finally {
      removeStateDir(dir);
    }
  });
});

/* ================================================================== */
/* v0.1.2 §3 — TLS termination (deployment form B)                     */
/* ================================================================== */

// Self-signed fixture for 127.0.0.1/localhost, valid until 2036-10-04.
// Generated once with openssl; embedded so the suite needs no external tooling.
const TLS_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUG5xkW4DDAsICThEbauwpZLDrlDcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAwNzE0MTEyNloXDTM2MTAw
NDE0MTEyNlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA3ixZLoj8AmGX4Xm4tGlR5/kqbjwtOTUReuqp93pEDZEp
Bwe+KztvbF6Q2RVCIsQihzpLBXU+AgPa7+E/U4vAmFEM5ubo/xHj79wxT856XwXW
rXocS4TyTX0Przk45ZyDmpRBObsZkO+e5OD/CSsBb0t4WUNTJjBPeNudbZiIqK+4
BU1QpsomZAEbQ01yXT1s7BAlgAjX+kZeMaAmk41S24v7kn3M1H86Zk4IpJg+714Z
/0I7RuQp6noAWxWDtnLXMdv3igPC2AH25UuC7lTp6m89EqsbT6bgf50Nmv3+FtpI
ii1d2Me4KnATdHCo0H5cVScKMnSSAweKGmJP8GI69wIDAQABo28wbTAdBgNVHQ4E
FgQUhfSqlMoKSPx3XcRlj1yXPeEcrqkwHwYDVR0jBBgwFoAUhfSqlMoKSPx3XcRl
j1yXPeEcrqkwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBANJ2xPZIEqxhK1GOlsafFDkZX42FnkG8
4840gXg49LJ1joxFXJgGsC65i7uFBBVyjFsv8PQ8P869i8jWNrTede3+5s/nBppn
iD3e5tx+Rq2fbZUEidcKicKNWs0ztX+ie7W66V4KgUp34IeTq5Kxf/hZOskWAwWq
zlvuT4JEhY+qo6nTN5SDDyxHqeAsE/TkS3QQe/1X5B6S0w/f4M/sn6BIqVEcFEUd
LWESZl6dI0NTKvAzH9ZMuYR+chma1LySiTGj953A05/q/kOmI6NBuVbj9DhUgMLJ
+SMKzFNkzygE1zxDRHnrf5qZKrezj95aMZl9niFHM4o03ANl+GItfx8=
-----END CERTIFICATE-----`;

const TLS_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDeLFkuiPwCYZfh
ebi0aVHn+SpuPC05NRF66qn3ekQNkSkHB74rO29sXpDZFUIixCKHOksFdT4CA9rv
4T9Ti8CYUQzm5uj/EePv3DFPznpfBdatehxLhPJNfQ+vOTjlnIOalEE5uxmQ757k
4P8JKwFvS3hZQ1MmME94251tmIior7gFTVCmyiZkARtDTXJdPWzsECWACNf6Rl4x
oCaTjVLbi/uSfczUfzpmTgikmD7vXhn/QjtG5CnqegBbFYO2ctcx2/eKA8LYAfbl
S4LuVOnqbz0SqxtPpuB/nQ2a/f4W2kiKLV3Yx7gqcBN0cKjQflxVJwoydJIDB4oa
Yk/wYjr3AgMBAAECggEADyiurqwnqPBVV2V7IsqLQIarTHll17qbn+vImQ6KLvRk
/KPPzk29EB0Lr3Dx4dyVqbn8FtOldw6ISHtX9Mon4+/aL4I5CsS2IE5bCi6OaIYs
QnEYfFaf3OwLJYUdl4N5JazqUZdG6uROm4Z2hrIDSqXqZwmSIzYcotecadC3uLqg
1wf4T7HzXEBeIrzqlf6zjykldbPODHyQNEd7pchqAKP6rv3JsUH8TmOAtfQuqWzL
9F4Z+rxXjo4l+QG+KxiIXhNmnKYBJxArx6Geil1qWE7NeWte6d3K7RqY24hSG1Xu
knF7qo5TyM4KeKFgX5SIzz0PFMJlS1cUGnlygaoEgQKBgQDvTdH2LZagzDsw039X
psWuOu56XJee2VdelNJir94zOY/rQ/hSrrW+iOCmgxKUQQqoAFUON1kAtfKxUODm
6qpFhpq6kBhvS4TL5PjgOGCt1e7CVdgTIFYsN7W+qlJ6OnUPaC9BjYGod31iFxFe
HGz/QcTe50RlNxuJARsk64VmoQKBgQDtrI7VTkWBthAFax55/l53QGZbKyfpTiBP
ATFWxEjXWHQZS/PW2yDZhxrbcN2XNyl7aOejIaOf2E3MoGCsdRzB7i6geWoc0z48
cIWUFBlKzDtyu5XNDgBBtMw+H8D4X5CZ6PIDVKm/sKUmGARAmHG0bfvVUHZWd4lh
8iUDf59ylwKBgQCJLVLui7OM+YX0t0iINlGbTqzl963yoSQ0U5tGdwoo0xZtBsmS
nBQS5OPij8BWu/If3BDl1VRv090LSBGkTWDN+hs4VuGq6t91Agyoe6jv/XKgdBUo
4aCEOGs2oOwmpNv1uQNd0IBC0jxNvmt2R1Uz/b+dB3Vtj+l43+lvgJM4AQKBgQCJ
h7ejIMbBtztwFzssdo/tS5uvF7rhmy7A6LzHK4/G5M1RsgyogGZy2WYmIxpmnSno
2pxnXljTbxQd25P1V1NLuOrMO1W21loGGUqClFrKWIHx8zBM1tQ5MUiajj9Yudvv
48bfPId5f9sgvvb+9fed46K9HfFMOaGKxta6PohigwKBgArgTgnXV+BaFxDIdUle
bDXUoqerJVRC3JMe6Kj9PE5qFjzryh1jhS3TviL4dA6lsjkE2rWIocHsvqQ8ETh9
y7w2vF5vwt5kkSCBNMV0R56cEONh9McoF3IaAUj+mRzflTfUnQF5kimSPXo3WYkZ
LaVs1OiuMgeq+iC/GDluXOLZ
-----END PRIVATE KEY-----`;

describe('v0.1.2 TLS (§3 form B)', () => {
  it('terminates TLS itself when tlsCert/tlsKey are given', async () => {
    const dir = makeStateDir();
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    fs.writeFileSync(certPath, TLS_CERT_PEM);
    fs.writeFileSync(keyPath, TLS_KEY_PEM);
    const relay = await startRelay({ tlsCert: certPath, tlsKey: keyPath, persist: false });
    try {
      assert.equal(relay.scheme, 'https');
      assert.match(relay.url, /^https:\/\//);
      assert.equal(relay.server.constructor.name, 'Server');
      const hz = await request(`${relay.url}/healthz`);
      assert.equal(hz.status, 200);
      assert.equal(hz.json.effective_scheme, 'https');

      const paired = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: {
          pairing_code: relay.state.createPairingCode(),
          machine_id: 'tls-m1', platform: DEFAULT_PLATFORM, caps: DEFAULT_CAPS,
        },
      });
      assert.equal(paired.status, 200);
    } finally {
      await relay.close();
      removeStateDir(dir);
    }
  });

  it('refuses half a TLS configuration and unreadable material instead of downgrading', async () => {
    assert.throws(
      () => createRelayServer({ tlsCert: 'x.pem', persist: false, logger: null }),
      (err) => err.code === 'BAD_REQUEST' && /together/.test(err.message),
    );
    assert.throws(
      () => createRelayServer({ tlsKey: 'x.pem', persist: false, logger: null }),
      (err) => err.code === 'BAD_REQUEST',
    );
    assert.throws(
      () => createRelayServer({ tlsCert: 'no-such-cert.pem', tlsKey: 'no-such-key.pem', persist: false, logger: null }),
      (err) => err.code === 'BAD_REQUEST' && /cannot read TLS material/.test(err.message),
    );
  });
});
