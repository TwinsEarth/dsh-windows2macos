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
  NonceCache,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  canonicalString,
  createSigner,
  signRequest,
} from '../src/signing.mjs';

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
import { AGGREGATE_STATUSES, aggregate, aggregateTask, renderReportMarkdown } from '../src/relay/report.mjs';
import { createRelayServer, normalizeBasePath, SlidingWindowRateLimiter } from '../src/relay/server.mjs';

/**
 * Issue a request signed over the EXACT bytes that go on the wire.
 *
 * `signedPath` defaults to the URL path+query, which is what the relay routes on
 * when no base path is configured. Tests that mount the relay under a prefix pass
 * the routed path explicitly (see the deployment-independence case).
 */
function signedFetch(url, { method = 'POST', token, body, signer, signedPath, headers = {} } = {}) {
  const u = new URL(url);
  const raw = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const path = signedPath ?? `${u.pathname}${u.search}`;
  const signatureHeaders = signer.headers({ method, path, body: raw ?? '' });
  return request(url, {
    method,
    token,
    rawBody: raw === null ? undefined : raw,
    headers: { ...signatureHeaders, ...headers },
  });
}

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

/** Poll until `fn()` is truthy (bounded); returns the final value. */
async function waitUntil(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) return value;
    await sleep(10);
  }
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
        assert.equal(notice.json.reason, 'buffer_truncated');
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
      await pairDevice(relay, 'm1');
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
      await pairDevice(relay, 'm1');
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
      await pairDevice(relay, 'm1');
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
      await pairDevice(relay, 'm1');
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
      await pairDevice(relay, 'm1');
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

  it('a spawn failure explains itself instead of leaving the 说明 column blank', () => {
    // Measured on macOS 27.0 / arm64 (2026-10-09): a task whose argv[0] was not on PATH came back
    // `crashed` / `exit_code: null` / an empty explanation. The envelope had carried
    // `warnings: ["PATH_INVALID"]` the whole way; nothing downstream ever read it, so the three facts
    // a reader was given together said nothing at all.
    const task = fakeTask({ machines: ['m1'] });
    const env = makeEnvelope({
      machine_id: 'm1',
      status: 'crashed',
      exit_code: null,
      warnings: ['PATH_INVALID'],
    });
    const agg = aggregate(task, [rec('m1', env)]);
    assert.equal(agg.status, 'failed');
    assert.match(agg.machines[0].reasons.join(' '), /PATH_INVALID/);
    assert.match(renderReportMarkdown(agg, task), /PATH_INVALID/);
  });

  it('does not invent an explanation for a plain nonzero exit', () => {
    // The command ran and `exit_code` says what it returned; prose here would be noise.
    const task = fakeTask({ machines: ['m1'] });
    const env = makeEnvelope({ machine_id: 'm1', status: 'nonzero_exit', exit_code: 3 });
    const agg = aggregate(task, [rec('m1', env)]);
    assert.deepEqual(agg.machines[0].reasons, []);
  });

  it('degraded: every machine reported, some ok and some failed', () => {
    // v0.3.0: this used to be `partial`. `partial` also means "machines are still out", so a
    // finished task in a bad state was indistinguishable from one still in flight -- in the one
    // field a reader looks at first. Every machine here has reported, so this is a verdict.
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const e1 = makeEnvelope({ machine_id: 'm1' });
    const e2 = makeEnvelope({ machine_id: 'm2', status: 'crashed', exit_code: null });
    const agg = aggregate(task, [rec('m1', e1), rec('m2', e2)]);
    assert.equal(agg.status, 'degraded');
    assert.equal(agg.counts.ok, 1);
    assert.equal(agg.counts.failed, 1);
    assert.match(agg.notes.join(' '), /1 machine\(s\) succeeded and 1 failed/);
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

  it('pending: no result yet, and the deadline has not passed', () => {
    // `nowMs` is supplied explicitly rather than relying on the wall clock. Without it the fixture's
    // `deadline_ms` is compared against the real current time, which made this test pass only
    // because the previous code had no deadline branch -- a time bomb that goes off the moment the
    // clock passes the fixture's date, and which is exactly how v0.3.0's `timeout` state surfaced.
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const agg = aggregate(task, [], { nowMs: task.deadline_ms - 1 });
    assert.equal(agg.status, 'pending');
    assert.equal(agg.steps[2].skipped, 'no_results_yet');
  });

  it('timeout: no result and the deadline has passed', () => {
    // The other half of the same question. `pending` means more may still arrive; once the caller's
    // own deadline has passed and machines are still silent, that is a verdict, and calling it
    // `pending` forever leaves a reader unable to tell a stuck task from a slow one.
    const task = fakeTask({ machines: ['m1', 'm2'] });
    const agg = aggregate(task, [], { nowMs: task.deadline_ms });
    assert.equal(agg.status, 'timeout');
    assert.equal(agg.steps[2].skipped, 'deadline_passed');
    assert.match(agg.notes.join(' '), /deadline/);
  });

  it('timeout is not reported while a result has arrived from anyone', () => {
    // A deadline that passes after one machine reported is not a timeout: the verdict is about the
    // machine that stayed silent, which `partial` already covers.
    const task = fakeTask({ machines: [{ machine_id: 'm1' }, { machine_id: 'm2', state: 'expired' }] });
    const agg = aggregate(task, [rec('m1', makeEnvelope({ machine_id: 'm1' }))], { nowMs: task.deadline_ms + 60_000 });
    assert.equal(agg.status, 'partial');
  });

  it('cancelled: a chosen stop is a verdict, not a malfunction', () => {
    const task = fakeTask({ machines: ['m1', 'm2'] });
    task.cancelled = true;
    task.cancel_reason = 'operator stopped the rollout';
    const agg = aggregate(task, [], { nowMs: task.deadline_ms + 60_000 });
    assert.equal(agg.status, 'cancelled');
    assert.match(agg.notes.join(' '), /operator stopped the rollout/);
    assert.equal(agg.steps[2].skipped, 'task_cancelled');
  });

  it('cancelled outranks every other verdict, including a passing run', () => {
    // Once someone has deliberately stopped the work, reporting `consistent` (or `failed`, or
    // `timeout`) would describe a decision as a result. Cancellation wins.
    const task = fakeTask({ machines: ['m1', 'm2'] });
    task.cancelled = true;
    const both = ['m1', 'm2'].map((id) => rec(id, makeEnvelope({ machine_id: id })));
    const agg = aggregate(task, both);
    assert.equal(agg.status, 'cancelled');
  });

  it('the three new verdicts are in the published status list', () => {
    for (const state of ['timeout', 'cancelled', 'degraded']) {
      assert.ok(AGGREGATE_STATUSES.includes(state), `${state} must be a documented aggregate status`);
    }
    // and the six §6.3 verdicts are still there
    for (const state of ['consistent', 'divergent', 'divergent-platform', 'failed', 'partial', 'unverifiable']) {
      assert.ok(AGGREGATE_STATUSES.includes(state), `${state} must remain an aggregate status`);
    }
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

/* ================================================================== */
/* v0.1.2 §8.6 — offers lost while a stream is down                    */
/* ================================================================== */

/**
 * The release blocker: an offer is a single event. If the machine's stream is not
 * attached at that instant, the event is gone and the lease waits out its whole
 * 50s window while the machine sits online and idle. These cases pin down the
 * recovery path deterministically -- the stream is torn down and re-established
 * under test control, so nothing depends on a millisecond-wide race.
 */
describe('v0.1.2 lost-offer recovery (§8.6)', () => {
  it('re-offers work that was dispatched while the machine had no stream', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1'); // paired, never connected
      assert.equal(relay.subscribers.size, 0, 'the machine has no stream yet');

      const created = await postTask(relay, taskBody());
      assert.equal(created.status, 200);
      const task = relay.state.getTask(created.json.task_id);
      const lease = task.leases.get('m1');
      assert.equal(lease.state, 'offered', 'the offer was emitted into the void');
      assert.equal(relay.subscribers.size, 0);

      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        const ready = await sse.waitFor((f) => f.event === 'ready');
        const offer = await sse.waitFor((f) => f.event === 'task.offer');
        assert.equal(offer.json.task_id, created.json.task_id);
        assert.equal(offer.json.machine_id, 'm1');
        assert.ok(offer.json.seq > ready.json.seq, 'the re-offer is emitted during attach, after ready');
        assert.equal(lease.offered_seq, offer.json.seq, 'the lease itself was re-offered');
        assert.equal(lease.state, 'offered');
      } finally {
        sse.close();
      }
    });
  });

  it('recovers the offer across a relay restart and a stale cursor (the reported bug)', async () => {
    const dir = makeStateDir();
    try {
      /* ---- process 1: the agent is connected, works normally, then both die ---- */
      const relay1 = await startRelay({
        stateDir: dir, pairingCode: 'PAIR-REDLV001', pairRateLimitPerMinute: 0,
      });
      const { token: deviceToken } = await pairDevice(relay1, 'm1', { code: 'PAIR-REDLV001' });
      const sse1 = await openSse(`${relay1.url}/v1/stream?machine_id=m1`, { token: deviceToken });
      await sse1.waitFor((f) => f.event === 'ready');
      const first = await postTask(relay1, taskBody());
      await sse1.waitFor((f) => f.event === 'task.offer');
      // finish task 1 so its lease is terminal and must NOT be re-offered
      await request(`${relay1.url}/v1/result`, {
        method: 'POST', token: deviceToken, body: envelopeForTask(first.json.task_id, 'm1'),
      });
      // Give the OLD process a longer history than the new one -- that is the shape of
      // the diagnosis (the agent had seen ~12 events before the restart, while the
      // fresh process had produced 2). It is also what makes the stale cursor land
      // beyond everything the new process has produced, which is the case that used
      // to pass in total silence. These tasks are all completed, so they stay out of
      // the re-offer set.
      for (let i = 0; i < 3; i += 1) {
        const extra = await postTask(relay1, taskBody());
        await request(`${relay1.url}/v1/result`, {
          method: 'POST', token: deviceToken, body: envelopeForTask(extra.json.task_id, 'm1'),
        });
      }
      const staleCursor = relay1.state.lastSeq(); // everything the agent had seen
      sse1.close();
      assert.ok(await waitUntil(() => relay1.subscribers.size === 0));
      const relay1Id = relay1.relayId;
      await relay1.close();

      /* ---- process 2: same state dir (same device token), seq restarts at 1 ---- */
      const relay2 = await startRelay({ stateDir: dir, pairRateLimitPerMinute: 0 });
      try {
        assert.notEqual(relay2.relayId, relay1Id, 'a restart is a new process with a new relay_id');
        assert.equal(relay2.state.lastSeq(), 0, 'sequence numbering restarts at 1');
        assert.equal(relay2.state.getTask(first.json.task_id).leases.get('m1').state, 'done');

        // The task is dispatched INTO THE GAP: after the restart, before the agent's
        // stream is back. This is the exact window from the diagnosis.
        const second = await postTask(relay2, taskBody());
        // ...and a second ordinary event lands in the gap too, to prove the recovery
        // is not offer-specific (a lost `task.cancel` would be far worse than a
        // lost offer: the machine would keep running a cancelled command).
        await pairDevice(relay2, 'm2');
        const lastSeqBeforeAttach = relay2.state.lastSeq();
        assert.ok(lastSeqBeforeAttach >= 2);
        assert.equal(relay2.subscribers.size, 0, 'still nobody attached: the events are in the gap');
        const replayFrom = staleCursor + 1;
        assert.ok(
          replayFrom > lastSeqBeforeAttach + 1,
          `replay from ${replayFrom} provably has nothing to send (last seq ${lastSeqBeforeAttach}), and the `
          + 'cursor is beyond everything this process produced: normal replay cannot deliver anything here',
        );

        /* ---- the agent reconnects carrying the previous process's cursor ---- */
        const sse2 = await openSse(`${relay2.url}/v1/stream?machine_id=m1`, {
          token: deviceToken,
          headers: { 'last-event-id': String(staleCursor) },
        });
        try {
          const ready = await sse2.waitFor((f) => f.event === 'ready');
          assert.equal(ready.json.relay_id, relay2.relayId, 'the client can tell the relay restarted');
          assert.ok(
            staleCursor + 1 > lastSeqBeforeAttach,
            `the cursor from the previous process (${staleCursor}) points past everything this process had `
            + `produced (${lastSeqBeforeAttach}) -- the reverse of buffer truncation, and the case that used `
            + 'to pass silently',
          );
          assert.ok(ready.json.seq > lastSeqBeforeAttach, 'the fresh process numbers its frames from scratch');

          // the mismatch is now reported instead of passing silently
          const truncated = await sse2.waitFor((f) => f.event === 'notice' && f.json.code === 'REPLAY_TRUNCATED');
          assert.equal(truncated.json.level, 'warn');
          assert.equal(truncated.json.reason, 'cursor_ahead_of_relay');
          assert.equal(truncated.json.requested_seq, replayFrom);
          assert.equal(truncated.json.oldest_available_seq, 1, 'the client learns where to re-align');
          assert.equal(truncated.json.last_available_seq, lastSeqBeforeAttach);
          assert.equal(truncated.json.relay_id, relay2.relayId);

          // a plain event that fell into the same gap is recovered as well
          const gapHello = await sse2.waitFor((f) => f.event === 'peer.hello' && f.json.machine_id === 'm2');
          assert.ok(gapHello.json.seq <= lastSeqBeforeAttach, 'replayed from the ring, not re-emitted');

          // THE FIX: the offer that fell into the gap is recovered -- twice over, and
          // both copies are safe because (machine_id, task_id, attempt) is idempotent.
          // (a) the re-alignment replay hands back the original event from the ring
          const replayed = await sse2.waitFor((f) => f.event === 'task.offer'
            && f.json.task_id === second.json.task_id && f.json.seq <= lastSeqBeforeAttach);
          assert.equal(replayed.json.machine_id, 'm1');
          // (b) the re-offer re-states the lease itself, with a fresh seq
          const redelivered = await sse2.waitFor((f) => f.event === 'task.offer'
            && f.json.task_id === second.json.task_id && f.json.seq > ready.json.seq);
          assert.equal(redelivered.id, String(redelivered.json.seq));
          const lease = relay2.state.getTask(second.json.task_id).leases.get('m1');
          assert.equal(lease.offered_seq, redelivered.json.seq, 'the relay re-issued the offer');
          assert.equal(lease.state, 'offered');

          // and the already-finished tasks are not resurrected
          const offeredTaskIds = [...new Set(sse2.frames
            .filter((f) => f.event === 'task.offer')
            .map((f) => f.json.task_id))];
          assert.deepEqual(offeredTaskIds, [second.json.task_id],
            'the terminal leases must not be re-offered');
        } finally {
          sse2.close();
        }
      } finally {
        await relay2.close();
      }
    } finally {
      removeStateDir(dir);
    }
  });

  it('reports a cursor that is ahead of this process even without a restart', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      await postTask(relay, taskBody());
      const lastSeq = relay.state.lastSeq();
      const foreignCursor = lastSeq + 500;

      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, {
        token, headers: { 'last-event-id': String(foreignCursor) },
      });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const notice = await sse.waitFor((f) => f.event === 'notice' && f.json.code === 'REPLAY_TRUNCATED');
        assert.equal(notice.json.reason, 'cursor_ahead_of_relay');
        assert.equal(notice.json.requested_seq, foreignCursor + 1);
        assert.equal(notice.json.oldest_available_seq, 1);
        assert.equal(notice.json.relay_id, relay.relayId);
      } finally {
        sse.close();
      }
    });
  });

  it('never re-offers a lease that is running, done or refused', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');

      const done = await postTask(relay, taskBody());
      await request(`${relay.url}/v1/result`, {
        method: 'POST', token, body: envelopeForTask(done.json.task_id, 'm1'),
      });
      const running = await postTask(relay, taskBody());
      relay.state.heartbeat({ task_id: running.json.task_id, machine_id: 'm1', phase: 'running' });
      const refused = await postTask(relay, taskBody({ requirements: { platform: ['macos'] } }));
      const pending = await postTask(relay, taskBody()); // the positive control

      assert.equal(relay.state.getTask(done.json.task_id).leases.get('m1').state, 'done');
      assert.equal(relay.state.getTask(running.json.task_id).leases.get('m1').state, 'running');
      assert.equal(relay.state.getTask(refused.json.task_id).leases.get('m1').state, 'refused');

      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        // the positive control arriving proves the re-offer pass has already run
        const offer = await sse.waitFor((f) => f.event === 'task.offer');
        assert.equal(offer.json.task_id, pending.json.task_id);
        await sleep(30);
        assert.deepEqual(
          sse.frames.filter((f) => f.event === 'task.offer').map((f) => f.json.task_id),
          [pending.json.task_id],
          'a running lease must never be re-offered: that would execute the command twice',
        );
        assert.equal(relay.state.getTask(running.json.task_id).leases.get('m1').state, 'running');
        assert.equal(relay.state.getTask(done.json.task_id).leases.get('m1').state, 'done');
      } finally {
        sse.close();
      }
    });
  });

  it('survives a logger that throws, on startup and while re-offering', async () => {
    // `logger: null` is the documented silent value and a caller-supplied logger may
    // throw. Either one used to escape AFTER res.writeHead(), which surfaced as
    // "Cannot write headers after they are sent to the client" on the SSE path.
    await withRelay({ logger: () => { throw new Error('logger exploded'); }, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const created = await postTask(relay, taskBody()); // offer emitted with nobody attached
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const offer = await sse.waitFor((f) => f.event === 'task.offer'); // this path logs
        assert.equal(offer.json.task_id, created.json.task_id);
      } finally {
        sse.close();
      }
      const hz = await request(`${relay.url}/healthz`);
      assert.equal(hz.status, 200, 'a broken logger must not take the relay down');
    });
  });

  it('does not resurrect a lease the sweep has already expired', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const created = await postTask(relay, taskBody());
      clock.advance(50_000);
      assert.equal(relay.state.sweepExpired().length, 1, 'the lease is expired and owned by the sweep');

      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        await sleep(30);
        assert.deepEqual(sse.frames.filter((f) => f.event === 'task.offer'), [],
          'an expired lease must not be revived by a reconnect');
        assert.equal(relay.state.getTask(created.json.task_id).leases.get('m1').state, 'expired');
      } finally {
        sse.close();
      }
    });
  });
});

/* ================================================================== */
/* v0.3.0 — cross-machine RTT through the relay                        */
/* ================================================================== */

/**
 * The plugin may run on machine A while the agent runs on machine B, so latency
 * has to travel through the relay instead of a local state file. These cases
 * deliberately touch only relay endpoints (never `aggregate`), so they stay
 * independent of the concurrent nine-state work in report.mjs.
 */
describe('v0.3.0 relay RTT (heartbeat rtt_ms)', () => {
  /** Pair a machine and give it a task, so heartbeats are accepted. */
  async function pairWithTask(relay, machineId = 'm1') {
    const { token } = await pairDevice(relay, machineId);
    const created = await postTask(relay, taskBody());
    return { token, taskId: created.json.task_id, created };
  }

  const beat = (relay, token, body) => request(`${relay.url}/v1/heartbeat`, { method: 'POST', token, body });
  const devices = (relay, token) => request(`${relay.url}/v1/devices`, { token });
  const agentStatus = (relay, token, machineId) => request(`${relay.url}/v1/agents/${machineId}/status`, { token });

  it('records a reported rtt_ms and exposes it on /v1/devices', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay);

      const before = await devices(relay, token);
      assert.equal(before.json.devices[0].rtt_ms, null, 'never measured is null, not 0');
      assert.equal(before.json.devices[0].rtt_at, null);
      assert.equal(before.json.devices[0].rtt_age_ms, null);
      assert.equal(before.json.devices[0].rtt_stale, true, 'unknown is not fresh');
      assert.equal(before.json.devices[0].last_heartbeat_at, null);

      const hb = await beat(relay, token, { task_id: taskId, machine_id: 'm1', phase: 'running', rtt_ms: 42.5 });
      assert.equal(hb.status, 200);
      assert.equal(hb.json.cancel, false);

      const after = await devices(relay, token);
      const device = after.json.devices[0];
      assert.equal(device.rtt_ms, 42.5, 'the fractional value is preserved');
      assert.equal(device.rtt_at, rfc3339(clock.now()));
      assert.equal(device.rtt_age_ms, 0);
      assert.equal(device.rtt_stale, false);
      assert.equal(device.last_heartbeat_at, rfc3339(clock.now()));

      // the same data through the single-machine endpoint
      const status = await agentStatus(relay, token, 'm1');
      assert.equal(status.status, 200);
      assert.equal(status.json.rtt_ms, 42.5);
      assert.equal(status.json.rtt_stale, false);
      assert.equal(status.json.relay_id, relay.relayId);
    });
  });

  it('null and 0 mean different things and stay distinguishable', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token: quiet } = await pairDevice(relay, 'never-reports');
      const { token: fast, taskId } = await pairWithTask(relay, 'instant');

      const hb = await beat(relay, fast, { task_id: taskId, machine_id: 'instant', rtt_ms: 0 });
      assert.equal(hb.status, 200);

      const list = await devices(relay, quiet);
      const byId = Object.fromEntries(list.json.devices.map((d) => [d.machine_id, d]));
      assert.equal(byId['instant'].rtt_ms, 0, '0 is a measurement: extremely fast');
      assert.equal(byId['never-reports'].rtt_ms, null, 'null is the absence of a measurement');
      assert.notEqual(byId['instant'].rtt_ms, byId['never-reports'].rtt_ms);
      assert.equal(byId['instant'].rtt_stale, false, 'a 0ms measurement is fresh');
      assert.equal(byId['never-reports'].rtt_stale, true);

      // a JSON round-trip must not collapse the two
      const roundTripped = JSON.parse(JSON.stringify(byId));
      assert.equal(roundTripped['instant'].rtt_ms, 0);
      assert.equal(roundTripped['never-reports'].rtt_ms, null);
    });
  });

  it('accepts a v0.2.3 heartbeat with no rtt_ms at all, keeping everything else working', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay);

      // exactly what a v0.2.3 agent sends: no rtt_ms key
      const hb = await beat(relay, token, { task_id: taskId, machine_id: 'm1', attempt: 1, phase: 'running', progress: 0.5 });
      assert.equal(hb.status, 200, 'an old client must be unaffected');
      assert.equal(hb.json.cancel, false);
      assert.equal(hb.json.lease_until, rfc3339(clock.now() + 50_000), 'the lease still renews');

      const device = (await devices(relay, token)).json.devices[0];
      assert.equal(device.rtt_ms, null);
      assert.equal(device.rtt_at, null);
      assert.equal(device.rtt_stale, true);
      assert.equal(device.last_heartbeat_at, rfc3339(clock.now()),
        'liveness is still recorded even though latency is unknown');

      assert.equal(relay.state.getTask(taskId).leases.get('m1').state, 'running');
    });
  });

  it('ignores an invalid rtt_ms: the heartbeat still succeeds and the old value survives', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay);
      await beat(relay, token, { task_id: taskId, machine_id: 'm1', rtt_ms: 25 });
      const goodAt = clock.now();

      for (const bad of [-1, -0.5, 'abc', '12', Number.NaN, Number.POSITIVE_INFINITY, null, true, {}, [], 1e12, 86_400_001]) {
        clock.advance(1000);
        const hb = await beat(relay, token, { task_id: taskId, machine_id: 'm1', phase: 'running', rtt_ms: bad });
        assert.equal(hb.status, 200, `rtt_ms=${JSON.stringify(bad)} must not reject the heartbeat`);
        assert.equal(hb.json.cancel, false, 'the lease is still renewed');

        const device = (await devices(relay, token)).json.devices[0];
        assert.equal(device.rtt_ms, 25, `rtt_ms=${JSON.stringify(bad)} must not clobber the known value`);
        assert.equal(device.rtt_at, rfc3339(goodAt), 'and must not refresh its timestamp');
        assert.equal(device.last_heartbeat_at, rfc3339(clock.now()), 'but liveness does advance');
      }
    });
  });

  it('ignores unknown extra fields entirely (forward compatibility)', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay);
      const hb = await beat(relay, token, {
        task_id: taskId,
        machine_id: 'm1',
        rtt_ms: 12,
        // fields that do not exist yet in this relay version
        future_field: 'whatever',
        nested: { deep: [1, 2, 3] },
        rtt_ms_v2: 99,
      });
      assert.equal(hb.status, 200, 'an extra field must never reject a heartbeat');
      const device = (await devices(relay, token)).json.devices[0];
      assert.equal(device.rtt_ms, 12, 'the known field is used');
      assert.equal('future_field' in device, false, 'unknown fields are not echoed into state');
      assert.equal('nested' in device, false);
      assert.equal('rtt_ms_v2' in device, false);
    });
  });

  it('flags a measurement as stale once it ages past the window', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, rttStaleMs: 30_000, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay);
      await beat(relay, token, { task_id: taskId, machine_id: 'm1', rtt_ms: 80 });

      const read = async () => (await devices(relay, token)).json.devices[0];
      assert.equal((await read()).rtt_stale, false);
      assert.equal((await read()).rtt_age_ms, 0);

      clock.advance(30_000);
      const atBoundary = await read();
      assert.equal(atBoundary.rtt_stale, false, 'exactly at the window is still fresh');
      assert.equal(atBoundary.rtt_age_ms, 30_000);

      clock.advance(1);
      const aged = await read();
      assert.equal(aged.rtt_stale, true, 'one tick past the window is stale');
      assert.equal(aged.rtt_ms, 80, 'the number is still reported, but marked untrustworthy');
      assert.equal(aged.rtt_age_ms, 30_001);
    });
  });

  it('/healthz aggregates RTT and reports null (not 0) when there is no data', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, rttStaleMs: 30_000, pairRateLimitPerMinute: 0 }, async (relay) => {
      // no devices at all
      const empty = await request(`${relay.url}/healthz`);
      assert.deepEqual(empty.json.rtt, {
        machines_reporting: 0, min_ms: null, max_ms: null, avg_ms: null,
        machines_stale: 0, machines_unknown: 0,
      }, 'no data must be null, never 0');

      // one device that never reports
      const { token: silent } = await pairDevice(relay, 'silent');
      const unknown = await request(`${relay.url}/healthz`);
      assert.equal(unknown.json.rtt.machines_reporting, 0);
      assert.equal(unknown.json.rtt.machines_unknown, 1);
      assert.equal(unknown.json.rtt.avg_ms, null);

      // two reporting machines
      for (const [id, rtt] of [['a', 100], ['b', 200]]) {
        const { token, taskId } = await pairWithTask(relay, id);
        await beat(relay, token, { task_id: taskId, machine_id: id, rtt_ms: rtt });
      }
      const two = await request(`${relay.url}/healthz`);
      assert.equal(two.json.rtt.machines_reporting, 2);
      assert.equal(two.json.rtt.min_ms, 100);
      assert.equal(two.json.rtt.max_ms, 200);
      assert.equal(two.json.rtt.avg_ms, 150);
      assert.equal(two.json.rtt.machines_unknown, 1, 'the silent device is still counted separately');
      void silent;

      // a third, slower machine
      const { token: cToken, taskId: cTask } = await pairWithTask(relay, 'c');
      await beat(relay, cToken, { task_id: cTask, machine_id: 'c', rtt_ms: 900 });
      const three = await request(`${relay.url}/healthz`);
      assert.equal(three.json.rtt.machines_reporting, 3);
      assert.equal(three.json.rtt.min_ms, 100);
      assert.equal(three.json.rtt.max_ms, 900);
      assert.equal(three.json.rtt.avg_ms, 400, '(100+200+900)/3');
    });
  });

  it('/healthz keeps stale and unknown machines out of the aggregate', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, rttStaleMs: 30_000, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay, 'live');
      await beat(relay, token, { task_id: taskId, machine_id: 'live', rtt_ms: 50 });

      clock.advance(60_000); // the measurement goes stale, and the lease with it
      const stale = await request(`${relay.url}/healthz`);
      assert.equal(stale.json.rtt.machines_reporting, 0, 'a stale number must not describe the fleet');
      assert.equal(stale.json.rtt.machines_stale, 1);
      assert.equal(stale.json.rtt.min_ms, null);
      assert.equal(stale.json.rtt.max_ms, null);
      assert.equal(stale.json.rtt.avg_ms, null);

      // a fresh heartbeat brings it back
      const relive = await beat(relay, token, { task_id: taskId, machine_id: 'live', rtt_ms: 60 });
      assert.equal(relive.status, 200, 'the expired lease is reclaimed by a live heartbeat');
      const fresh = await request(`${relay.url}/healthz`);
      assert.equal(fresh.json.rtt.machines_reporting, 1);
      assert.equal(fresh.json.rtt.avg_ms, 60);
    });
  });

  it('GET /v1/agents/{machine_id}/status is the single-machine view', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay, 'm1');
      await beat(relay, token, { task_id: taskId, machine_id: 'm1', rtt_ms: 33 });

      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const status = await agentStatus(relay, token, 'm1');
        assert.equal(status.status, 200);
        const body = status.json;
        assert.equal(body.protocol_version, 1);
        assert.equal(body.machine_id, 'm1');
        assert.equal(body.relay_id, relay.relayId, 'a reader can spot a relay restart');
        assert.equal(body.connected, true, 'an SSE stream is attached');
        assert.equal(body.streams, 1);
        assert.equal(body.rtt_ms, 33);
        assert.equal(body.rtt_stale, false);
        assert.equal(body.rtt_age_ms, 0);
        assert.equal(body.rtt_at, rfc3339(clock.now()));
        assert.equal(body.last_heartbeat_at, rfc3339(clock.now()));
        assert.equal(body.reconnect_attempts, 0, 'the first attach is not a reconnect');
        assert.equal(body.paired_at, rfc3339(clock.now()));
        assert.ok(typeof body.machine_name === 'string');
        assert.equal('device_token' in body, false, 'no credentials in a status view');
      } finally {
        sse.close();
      }
      assert.ok(await waitUntil(() => relay.subscribers.size === 0));
      const offline = await agentStatus(relay, token, 'm1');
      assert.equal(offline.json.connected, false, 'connected tracks the live stream');
      assert.equal(offline.json.streams, 0);
    });
  });

  it('counts relay-observed reconnects per machine', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairWithTask(relay, 'm1');
      for (let i = 0; i < 3; i += 1) {
        const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, { token });
        await sse.waitFor((f) => f.event === 'ready');
        sse.close();
        assert.ok(await waitUntil(() => relay.subscribers.size === 0));
      }
      const status = await agentStatus(relay, token, 'm1');
      assert.equal(status.json.stream_connects, 3);
      assert.equal(status.json.reconnect_attempts, 2, 'three attaches = two reconnects');
    });
  });

  it('answers 404 for an unknown machine and 401 without a token', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairWithTask(relay, 'm1');
      const missing = await agentStatus(relay, token, 'ghost');
      assert.equal(missing.status, 404);
      assert.equal(missing.json.error.code, 'NOT_FOUND');

      const anonymous = await request(`${relay.url}/v1/agents/m1/status`);
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.json.error.code, 'UNAUTHORIZED');
    });
  });

  it('RTT does not survive a restart: the relay never claims stale knowledge', async () => {
    const dir = makeStateDir();
    try {
      const first = await startRelay({ stateDir: dir, pairingCode: 'PAIR-RTT00001', pairRateLimitPerMinute: 0 });
      const { token, taskId } = await pairWithTask(first, 'm1');
      await beat(first, token, { task_id: taskId, machine_id: 'm1', rtt_ms: 17 });
      const live = (await devices(first, token)).json.devices[0];
      assert.equal(live.rtt_ms, 17, 'measured before the restart');
      await first.close();

      const second = await startRelay({ stateDir: dir, pairRateLimitPerMinute: 0 });
      try {
        const restored = (await devices(second, token)).json.devices;
        assert.equal(restored.length, 1, 'the device table itself is restored');
        assert.equal(restored[0].rtt_ms, null, 'RTT is volatile: it must NOT be restored');
        assert.equal(restored[0].rtt_at, null);
        assert.equal(restored[0].rtt_stale, true, 'so a reader cannot mistake it for a fresh value');
        assert.equal(restored[0].last_heartbeat_at, null, 'nothing has been heard in this process yet');

        const status = await agentStatus(second, token, 'm1');
        assert.equal(status.json.rtt_ms, null);
        assert.equal(status.json.relay_id, second.relayId);
        assert.equal(status.json.connected, false);
      } finally {
        await second.close();
      }
    } finally {
      removeStateDir(dir);
    }
  });

  it('a v0.2.3 client completes a whole task against a v0.3.0 relay', async () => {
    // End-to-end simulation of the old agent: never sends rtt_ms, and never reads
    // anything new. Everything it used before must still work.
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'legacy');
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=legacy`, { token });
      try {
        const ready = await sse.waitFor((f) => f.event === 'ready');
        assert.equal(ready.json.protocol_version, 1, 'PROTOCOL_VERSION stays 1');
        assert.ok(ready.json.relay_id, 'the only ready-frame addition is additive');

        const created = await postTask(relay, taskBody());
        const offer = await sse.waitFor((f) => f.event === 'task.offer');
        assert.equal(offer.json.task_id, created.json.task_id);
        assert.equal('rtt_ms' in offer.json, false, 'offers are unchanged');

        const hb = await beat(relay, token, {
          task_id: created.json.task_id, machine_id: 'legacy', attempt: 1, phase: 'running', progress: 1,
        });
        assert.equal(hb.status, 200);
        assert.equal(hb.json.cancel, false);

        const result = await request(`${relay.url}/v1/result`, {
          method: 'POST', token, body: envelopeForTask(created.json.task_id, 'legacy'),
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.deduped, false);

        const view = await request(`${relay.url}/v1/tasks/${created.json.task_id}`, { token });
        assert.equal(view.status, 200);
        assert.equal(view.json.aggregate.status, 'consistent', 'the single-machine verdict is unchanged');

        const hz = await request(`${relay.url}/healthz`);
        assert.equal(hz.json.protocol_version, 1);
        assert.equal(hz.json.rtt.machines_reporting, 0, 'the old client reports no RTT, and that is fine');
        assert.equal(hz.json.rtt.avg_ms, null);
      } finally {
        sse.close();
      }
    });
  });
});

/* ================================================================== */
/* v0.3.0 — idle (diagnostic) heartbeats                               */
/* ================================================================== */

/**
 * The cross-machine view is only useful if it stays fresh while a machine has no
 * work: an IDLE machine is exactly the one an operator looks at. Without this, a
 * machine that finishes its last task freezes its RTT at the last task's value and
 * then goes stale -- which reads as "the machine is there but very slow", worse
 * than an honest "unknown".
 *
 * The dangerous half is the lease: an idle ping must never touch one.
 */
describe('v0.3.0 idle (diagnostic) heartbeats', () => {
  async function pairWithTask(relay, machineId = 'm1') {
    const { token } = await pairDevice(relay, machineId);
    const created = await postTask(relay, taskBody());
    return { token, taskId: created.json.task_id, created };
  }
  const beat = (relay, token, body) => request(`${relay.url}/v1/heartbeat`, { method: 'POST', token, body });
  const devices = (relay, token) => request(`${relay.url}/v1/devices`, { token });
  const readDevice = async (relay, token, id) =>
    (await devices(relay, token)).json.devices.find((d) => d.machine_id === id);

  it('THE INVARIANT: an idle heartbeat never resurrects an expired lease', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay, 'm1');
      clock.advance(50_000);
      assert.equal(relay.state.sweepExpired().length, 1, 'the lease is expired');
      const task = relay.state.getTask(taskId);
      const expiredAt = task.leases.get('m1').expired_at_ms;
      assert.equal(task.leases.get('m1').state, 'expired');
      assert.equal(task.degraded, 'partial');

      clock.advance(1_000); // the idle ping lands after the lease died
      const idle = await beat(relay, token, { diagnostic: true, rtt_ms: 30 });
      assert.equal(idle.status, 200);
      assert.equal(idle.json.diagnostic, true);
      assert.equal(idle.json.lease_until, null, 'no lease was involved');
      assert.equal(idle.json.cancel, false, 'and there is nothing to cancel');

      assert.equal(task.leases.get('m1').state, 'expired', 'still expired: the sweep owns this decision');
      assert.equal(task.degraded, 'partial', 'the book-keeping is not washed away');
      assert.equal(task.attempt, 1, 'and no takeover was manufactured');
      assert.equal(task.leases.get('m1').expired_at_ms, expiredAt, 'the expiry timestamp is untouched');
      assert.equal(task.leases.get('m1').lease_until_ms < clock.now(), true, 'no lease window was extended');

      // while the diagnostics DID refresh -- that is the point of the idle ping
      const device = await readDevice(relay, token, 'm1');
      assert.equal(device.rtt_ms, 30);
      assert.equal(device.rtt_stale, false);
      assert.equal(device.last_heartbeat_at, rfc3339(clock.now()));
    });
  });

  it('works for a machine that has never held a lease', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'idle-only'); // paired, no task at all
      assert.equal(relay.state.tasks.size, 0);

      const idle = await beat(relay, token, { diagnostic: true, rtt_ms: 77 });
      assert.equal(idle.status, 200, 'an idle machine must be observable without a task');
      assert.equal(idle.json.lease_until, null);
      assert.equal(idle.json.machine_id, 'idle-only');

      const device = await readDevice(relay, token, 'idle-only');
      assert.equal(device.rtt_ms, 77);
      assert.equal(device.rtt_stale, false);

      const hz = await request(`${relay.url}/healthz`);
      assert.equal(hz.json.rtt.machines_reporting, 1, 'idle machines count in the fleet aggregate');
      assert.equal(hz.json.rtt.avg_ms, 77);
    });
  });

  it('keeps the RTT fresh across a long idle period, with no flapping', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'idle');
      await beat(relay, token, { diagnostic: true, rtt_ms: 10 });

      // Sample at the WORST moment of each cycle: just before the next ping is due.
      // At 60s cadence against a 180s window the value must never be stale, or
      // `rtt_stale === false` would stop being a dependable predicate.
      for (let i = 1; i <= 10; i += 1) {
        clock.advance(60_000);
        const justBefore = await readDevice(relay, token, 'idle');
        assert.equal(justBefore.rtt_age_ms, 60_000);
        assert.equal(justBefore.rtt_stale, false,
          `minute ${i}: 60s of age against a 180s window must stay fresh (no flapping)`);
        const hb = await beat(relay, token, { diagnostic: true, rtt_ms: 10 + i });
        assert.equal(hb.status, 200);
      }

      const final = await readDevice(relay, token, 'idle');
      assert.equal(final.rtt_ms, 20);
      assert.equal(final.rtt_stale, false, 'after 10 minutes of idling the view is still live');
    });
  });

  it('goes stale only after the window is genuinely exceeded', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, rttStaleMs: 180_000, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'gone');
      await beat(relay, token, { diagnostic: true, rtt_ms: 15 });

      clock.advance(180_000);
      assert.equal((await readDevice(relay, token, 'gone')).rtt_stale, false, 'at the boundary: still fresh');
      clock.advance(1);
      const stale = await readDevice(relay, token, 'gone');
      assert.equal(stale.rtt_stale, true, 'one tick past: stale');
      assert.equal(stale.rtt_ms, 15, 'the last value is still reported, marked untrustworthy');
    });
  });

  it('a heartbeat with neither task_id nor diagnostic is refused loudly', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const res = await beat(relay, token, { phase: 'running', progress: 0.5 });
      assert.equal(res.status, 400, 'a missing task_id must not silently renew nothing');
      assert.equal(res.json.error.code, 'BAD_REQUEST');
      assert.match(res.json.error.message, /task_id/);
      assert.match(res.json.error.message, /diagnostic/);
    });
  });

  it('task_id wins when both are present, and idle diagnostics are validated too', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await pairWithTask(relay, 'm1');
      // a task_id means "this is a lease heartbeat"; the redundant flag is ignored
      const hb = await beat(relay, token, { task_id: taskId, machine_id: 'm1', diagnostic: true, rtt_ms: 5 });
      assert.equal(hb.status, 200);
      assert.equal(hb.json.diagnostic, undefined, 'the lease path answers with a lease');
      assert.equal(hb.json.lease_until, rfc3339(clock.now() + 50_000), 'the lease really was renewed');

      // validation still applies on the idle path
      const badPhase = await beat(relay, token, { diagnostic: true, phase: 'bogus' });
      assert.equal(badPhase.status, 400);
      const badProgress = await beat(relay, token, { diagnostic: true, progress: 2 });
      assert.equal(badProgress.status, 400);
    });
  });

  it('idle heartbeats are liberal about bad rtt_ms and unknown fields', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      await beat(relay, token, { diagnostic: true, rtt_ms: 40 });

      const bad = await beat(relay, token, { diagnostic: true, rtt_ms: -5, future_field: 'x' });
      assert.equal(bad.status, 200, 'a bad value must not reject an idle ping either');
      assert.equal(bad.json.rtt_ms, 40, 'the response echoes the value actually stored');
      assert.equal((await readDevice(relay, token, 'm1')).rtt_ms, 40);

      const unknownOnly = await beat(relay, token, { diagnostic: true, mystery: { deep: true } });
      assert.equal(unknownOnly.status, 200);
      assert.equal(unknownOnly.json.rtt_ms, 40, 'unknown fields neither reject nor clobber');
    });
  });

  it('an idle heartbeat from an unknown machine is a 404, and needs a token', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'known');
      const ghost = await beat(relay, token, { diagnostic: true, machine_id: 'ghost' });
      assert.equal(ghost.status, 404);
      assert.equal(ghost.json.error.code, 'NOT_FOUND');

      const anonymous = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST', body: { diagnostic: true },
      });
      assert.equal(anonymous.status, 401);
    });
  });

  it('an idle machine shows up live on the single-machine view', async () => {
    const clock = makeClock();
    await withRelay({ now: clock.now, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'watched');
      clock.advance(5000);
      await beat(relay, token, { diagnostic: true, rtt_ms: 123.5 });

      const status = await request(`${relay.url}/v1/agents/watched/status`, { token });
      assert.equal(status.status, 200);
      assert.equal(status.json.rtt_ms, 123.5);
      assert.equal(status.json.rtt_stale, false);
      assert.equal(status.json.rtt_age_ms, 0);
      assert.equal(status.json.last_heartbeat_at, rfc3339(clock.now()));
      assert.equal(status.json.connected, false, 'no stream, but the machine is demonstrably alive');
    });
  });
});

/* ================================================================== */
/* v0.3.0 §9 — request signing wired into the HTTP layer               */
/* ================================================================== */

/**
 * Until the HTTP layer calls it, HMAC support does not exist for any real
 * request. These cases pin the three-step migration discipline:
 *   no secret      -> byte-identical to today (hard backward-compat gate)
 *   secret set     -> signatures accepted, unsigned still tolerated
 *   + require flag -> unsigned becomes 401 SIGNATURE_REQUIRED
 */
describe('v0.3.0 request signing (§9)', () => {
  const SECRET = 'current-secret-0123456789';
  const OLD_SECRET = 'previous-secret-9876543210';
  const NEW_SIGNER = () => createSigner({ secret: SECRET });
  const OLD_SIGNER = () => createSigner({ secret: OLD_SECRET });

  async function readyRelay(relay) {
    const { token } = await pairDevice(relay, 'm1');
    const created = await postTask(relay, taskBody());
    return { token, taskId: created.json.task_id };
  }
  const beatBody = (taskId) => ({ task_id: taskId, machine_id: 'm1', phase: 'running' });

  /* ---- 1. the hard gate: no secret means nothing changes ---- */

  it('with no secret configured every legacy request behaves exactly as before', async () => {
    await withRelay({ pairRateLimitPerMinute: 0 }, async (relay) => {
      assert.equal(relay.signingConfigured, false);
      assert.deepEqual(relay.signingSecrets, []);

      const { token, taskId } = await readyRelay(relay); // unsigned operator task dispatch
      const hb = await request(`${relay.url}/v1/heartbeat`, { method: 'POST', token, body: beatBody(taskId) });
      assert.equal(hb.status, 200, 'an unsigned v0.2.3 heartbeat still works');
      const res = await request(`${relay.url}/v1/result`, {
        method: 'POST', token, body: envelopeForTask(taskId, 'm1'),
      });
      assert.equal(res.status, 200);
      assert.equal((await request(`${relay.url}/v1/devices`, { token })).status, 200);
      assert.equal((await request(`${relay.url}/healthz`)).status, 200);

      const hz = await request(`${relay.url}/healthz`);
      assert.deepEqual(hz.json.signing, {
        configured: false, required: false, previous_secret_accepted: false, skew_seconds: 120,
      });
    });
  });

  /* ---- 2. secret configured but not required: tolerate unsigned ---- */

  it('with a secret configured but not required, unsigned requests still succeed', async () => {
    await withRelay({ signingSecret: SECRET, pairRateLimitPerMinute: 0 }, async (relay) => {
      assert.equal(relay.signingConfigured, true);
      assert.equal(relay.requireSignature, false);

      const { token, taskId } = await readyRelay(relay);
      const hb = await request(`${relay.url}/v1/heartbeat`, { method: 'POST', token, body: beatBody(taskId) });
      assert.equal(hb.status, 200, 'turning signing on must not kick the fleet offline');
      const res = await request(`${relay.url}/v1/result`, {
        method: 'POST', token, body: envelopeForTask(taskId, 'm1'),
      });
      assert.equal(res.status, 200, 'fleet-wide rollout would be impossible otherwise');
    });
  });

  /* ---- 3. the explicit hard mode ---- */

  it('with requireSignature an unsigned write is 401 SIGNATURE_REQUIRED', async () => {
    await withRelay({ signingSecret: SECRET, requireSignature: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await readyRelay(relay);
      const hb = await request(`${relay.url}/v1/heartbeat`, { method: 'POST', token, body: beatBody(taskId) });
      assert.equal(hb.status, 401);
      assert.equal(hb.json.error.code, 'SIGNATURE_REQUIRED');
      assert.equal(hb.json.error.detail.code, 'SIGNATURE_REQUIRED');
      assert.match(hb.json.error.detail.reason, /requires a signed request/);
      assert.match(hb.json.error.detail.hint, /require-signature/);

      const unsignedTask = await postTask(relay, taskBody());
      assert.equal(unsignedTask.status, 401, 'task dispatch is a write too');
      assert.equal(unsignedTask.json.error.code, 'SIGNATURE_REQUIRED');
    });
  });

  /* ---- 4. a correct signature works ---- */

  it('accepts a correctly signed write', async () => {
    await withRelay({ signingSecret: SECRET, requireSignature: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await pairDevice(relay, 'm1');
      const created = await signedFetch(`${relay.url}/v1/task`, { token: OP, body: taskBody(), signer: NEW_SIGNER() });
      assert.equal(created.status, 200, created.text);
      const taskId = created.json.task_id;

      const hb = await signedFetch(`${relay.url}/v1/heartbeat`, { token, body: beatBody(taskId), signer: NEW_SIGNER() });
      assert.equal(hb.status, 200);

      const res = await signedFetch(`${relay.url}/v1/result`, {
        token, body: envelopeForTask(taskId, 'm1'), signer: NEW_SIGNER(),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.deduped, false);
    });
  });

  /* ---- 5. each tampering case maps to its own code ---- */

  it('detects a tampered body', async () => {
    await withRelay({ signingSecret: SECRET, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await readyRelay(relay);
      const signer = NEW_SIGNER();
      // sign one body, send another
      const signedFor = JSON.stringify(beatBody(taskId));
      const headers = signer.headers({ method: 'POST', path: '/v1/heartbeat', body: signedFor });
      const res = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST', token,
        rawBody: JSON.stringify({ ...beatBody(taskId), progress: 0.99 }), // one extra field
        headers,
      });
      assert.equal(res.status, 401);
      assert.equal(res.json.error.code, 'SIGNATURE_MISMATCH');
    });
  });

  it('detects a signature moved to another path or method', async () => {
    await withRelay({ signingSecret: SECRET, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await readyRelay(relay);
      const signer = NEW_SIGNER();
      const body = JSON.stringify(beatBody(taskId));

      const otherPath = signer.headers({ method: 'POST', path: '/v1/result', body });
      const pathRes = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST', token, rawBody: body, headers: otherPath,
      });
      assert.equal(pathRes.status, 401);
      assert.equal(pathRes.json.error.code, 'SIGNATURE_MISMATCH', 'a signature must not be movable between endpoints');

      const otherMethod = signer.headers({ method: 'GET', path: '/v1/heartbeat', body });
      const methodRes = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST', token, rawBody: body, headers: otherMethod,
      });
      assert.equal(methodRes.status, 401);
      assert.equal(methodRes.json.error.code, 'SIGNATURE_MISMATCH');
    });
  });

  it('rejects a stale timestamp and says it is the clock window', async () => {
    await withRelay({ signingSecret: SECRET, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await readyRelay(relay);
      const staleSigner = createSigner({ secret: SECRET, now: () => Date.now() - 500_000 }); // ~8 min old
      const res = await signedFetch(`${relay.url}/v1/heartbeat`, { token, body: beatBody(taskId), signer: staleSigner });
      assert.equal(res.status, 401);
      assert.equal(res.json.error.code, 'SIGNATURE_EXPIRED');
      assert.match(res.json.error.detail.reason, /outside the ±120s window/);
      assert.match(res.json.error.detail.hint, /clock/i, 'the hint points at the sending machine clock');
    });
  });

  it('rejects a replayed nonce and says it is a replay', async () => {
    await withRelay({ signingSecret: SECRET, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await readyRelay(relay);
      const fixedNonce = 'fixed-nonce-for-replay-test';
      const signer = createSigner({ secret: SECRET, makeNonce: () => fixedNonce });
      const body = beatBody(taskId);

      const first = await signedFetch(`${relay.url}/v1/heartbeat`, { token, body, signer });
      assert.equal(first.status, 200, 'the first use is legitimate');

      const replay = await signedFetch(`${relay.url}/v1/heartbeat`, { token, body, signer });
      assert.equal(replay.status, 401);
      assert.equal(replay.json.error.code, 'SIGNATURE_REPLAY', 'a replay is distinguishable from a bad signature');
      assert.match(replay.json.error.detail.reason, /already been used/);
      assert.match(replay.json.error.detail.hint, /fresh nonce/);
    });
  });

  it('rejects a partially signed request instead of falling back to unsigned', async () => {
    await withRelay({ signingSecret: SECRET, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await readyRelay(relay);
      const signer = NEW_SIGNER();
      const full = signer.headers({ method: 'POST', path: '/v1/heartbeat', body: JSON.stringify(beatBody(taskId)) });

      for (const missing of [SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER]) {
        const headers = { ...full };
        delete headers[missing];
        const res = await request(`${relay.url}/v1/heartbeat`, {
          method: 'POST', token, rawBody: JSON.stringify(beatBody(taskId)), headers,
        });
        assert.equal(res.status, 401, `missing ${missing}`);
        assert.equal(res.json.error.code, 'SIGNATURE_INCOMPLETE',
          'a half-signed request is a broken proxy or a probe, never a legacy client');
      }

      const shortNonce = { ...full, [NONCE_HEADER]: 'abc' };
      const shortRes = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST', token, rawBody: JSON.stringify(beatBody(taskId)), headers: shortNonce,
      });
      assert.equal(shortRes.status, 401);
      assert.equal(shortRes.json.error.code, 'SIGNATURE_BAD_NONCE',
        'signing.mjs checks the nonce length before the HMAC, so the code names the real cause');

      const badTs = { ...full, [TIMESTAMP_HEADER]: 'not-a-number' };
      const badTsRes = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST', token, rawBody: JSON.stringify(beatBody(taskId)), headers: badTs,
      });
      assert.equal(badTsRes.status, 401);
      assert.equal(badTsRes.json.error.code, 'SIGNATURE_BAD_TIMESTAMP');
    });
  });

  /* ---- 6. rotation ---- */

  it('accepts both secrets during a rotation, and rejects a secret that is gone', async () => {
    await withRelay({
      signingSecret: SECRET, signingSecretPrevious: OLD_SECRET, requireSignature: true, pairRateLimitPerMinute: 0,
    }, async (relay) => {
      await pairDevice(relay, 'm1');
      const current = await signedFetch(`${relay.url}/v1/task`, { token: OP, body: taskBody(), signer: NEW_SIGNER() });
      assert.equal(current.status, 200, 'the new secret works');
      const previous = await signedFetch(`${relay.url}/v1/task`, { token: OP, body: taskBody(), signer: OLD_SIGNER() });
      assert.equal(previous.status, 200, 'the old secret still works while rotating');

      // keyIndex identifies which one matched, which is how an operator knows a
      // machine has not picked up the new secret yet
      const decisionNow = relay.verifySignature(
        { headers: NEW_SIGNER().headers({ method: 'POST', path: '/v1/task', body: '{}' }) },
        { method: 'POST', signedPath: '/v1/task', body: '{}' },
      );
      assert.equal(decisionNow.ok, true);
      assert.equal(decisionNow.keyIndex, 0, 'index 0 = current secret');
      const decisionOld = relay.verifySignature(
        { headers: OLD_SIGNER().headers({ method: 'POST', path: '/v1/task', body: '{}' }) },
        { method: 'POST', signedPath: '/v1/task', body: '{}' },
      );
      assert.equal(decisionOld.keyIndex, 1, 'index 1 = previous secret');

      const hz = await request(`${relay.url}/healthz`);
      assert.equal(hz.json.signing.previous_secret_accepted, true);
    });

    await withRelay({ signingSecret: SECRET, requireSignature: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      await pairDevice(relay, 'm1');
      const retired = await signedFetch(`${relay.url}/v1/task`, { token: OP, body: taskBody(), signer: OLD_SIGNER() });
      assert.equal(retired.status, 401, 'once rotation is finished the old secret is dead');
      assert.equal(retired.json.error.code, 'SIGNATURE_MISMATCH');
      assert.match(retired.json.error.detail.hint, /rotat/i, 'the hint points at rotation, the usual cause');
      const hz = await request(`${relay.url}/healthz`);
      assert.equal(hz.json.signing.previous_secret_accepted, false);
    });
  });

  /* ---- 7. my ruling on read endpoints ---- */

  it('RULING: reads are not signature-checked unless requireSignature is on', async () => {
    await withRelay({ signingSecret: SECRET, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await readyRelay(relay);
      // A deliberately garbage signature on a read is ignored, because an unsigned
      // read is accepted anyway -- checking would be theatre while adding a new way
      // for polls and SSE reconnects to fail.
      const bogus = {
        [SIGNATURE_HEADER]: 'v1=deadbeef',
        [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
        [NONCE_HEADER]: 'garbage-nonce-1234',
      };
      const devices = await request(`${relay.url}/v1/devices`, { token, headers: bogus });
      assert.equal(devices.status, 200, 'a bad signature on a read is ignored in the default mode');
      const tasks = await request(`${relay.url}/v1/tasks`, { token, headers: bogus });
      assert.equal(tasks.status, 200);
    });

    await withRelay({ signingSecret: SECRET, requireSignature: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token } = await readyRelay(relay);
      const unsignedRead = await request(`${relay.url}/v1/devices`, { token });
      assert.equal(unsignedRead.status, 401, 'hard mode means hard mode: reads included');
      assert.equal(unsignedRead.json.error.code, 'SIGNATURE_REQUIRED');

      const signedRead = await signedFetch(`${relay.url}/v1/devices`, { method: 'GET', token, signer: NEW_SIGNER() });
      assert.equal(signedRead.status, 200);
      const signedList = await signedFetch(`${relay.url}/v1/tasks?limit=5`, { method: 'GET', token, signer: NEW_SIGNER() });
      assert.equal(signedList.status, 200, 'query strings are part of the signed path');
    });
  });

  it('always exempts /healthz and /v1/pair, even under requireSignature', async () => {
    await withRelay({ signingSecret: SECRET, requireSignature: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      const hz = await request(`${relay.url}/healthz`);
      assert.equal(hz.status, 200, 'an operations probe must never need a credential');
      assert.equal(hz.json.signing.required, true);
      assert.equal(hz.json.signing.configured, true);

      const paired = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: {
          pairing_code: relay.state.createPairingCode(),
          machine_id: 'bootstrap', platform: DEFAULT_PLATFORM, caps: DEFAULT_CAPS,
        },
      });
      assert.equal(paired.status, 200, 'pairing is the bootstrap: the two sides share no secret yet');
    });
  });

  /* ---- 8. the secret must never escape ---- */

  it('/healthz reports signature posture without leaking any secret material', async () => {
    await withRelay({
      signingSecret: SECRET, signingSecretPrevious: OLD_SECRET, requireSignature: true, pairRateLimitPerMinute: 0,
    }, async (relay) => {
      const hz = await request(`${relay.url}/healthz`);
      assert.deepEqual(hz.json.signing, {
        configured: true, required: true, previous_secret_accepted: true, skew_seconds: 120,
      });
      const raw = hz.text;
      assert.equal(raw.includes(SECRET), false, 'the current secret must never appear');
      assert.equal(raw.includes(OLD_SECRET), false, 'nor the previous one');
      assert.equal(raw.includes(SECRET.slice(0, 8)), false, 'not even a prefix');

      // and the startup banner reports the posture without the material
      const banner = relay.startupMessages.join('\n');
      assert.match(banner, /request signing=ON/);
      assert.equal(banner.includes(SECRET), false);
      assert.equal(banner.includes(OLD_SECRET), false);
    });
  });

  /* ---- 9. relay misconfiguration is never a 401 ---- */

  it('SIGNING_NOT_CONFIGURED is a relay error (500), never a client 401', async () => {
    await withRelay({ requireSignature: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      const { token, taskId } = await readyRelay(relay); // pair + task are exempt/signed-free at setup
      const res = await request(`${relay.url}/v1/heartbeat`, { method: 'POST', token, body: beatBody(taskId) });
      assert.equal(res.status, 500, 'reporting this as 401 would send everyone to debug the wrong side');
      assert.equal(res.json.error.code, 'SIGNING_NOT_CONFIGURED');
      assert.match(res.json.error.detail.reason, /no signing secret is configured/);
      assert.match(res.json.error.detail.hint, /RELAY configuration error/);

      const hz = await request(`${relay.url}/healthz`);
      assert.deepEqual(
        { configured: hz.json.signing.configured, required: hz.json.signing.required },
        { configured: false, required: true },
        '/healthz is where an operator can see the contradiction',
      );
      const banner = relay.startupMessages.join('\n');
      assert.match(banner, /CONFIGURATION ERROR/, 'the startup banner says it out loud');
    });
  });

  /* ---- 10. nonce cache lifecycle ---- */

  it('prunes the nonce cache from the maintenance tick so it cannot grow unbounded', async () => {
    await withRelay({
      signingSecret: SECRET, signingSecretConfigured: true,
      nonceCacheRetentionMs: 1000, pairRateLimitPerMinute: 0,
    }, async (relay) => {
      const { token, taskId } = await readyRelay(relay);
      for (let i = 0; i < 3; i += 1) {
        const signer = createSigner({ secret: SECRET, makeNonce: () => `nonce-${i}-padding` });
        const res = await signedFetch(`${relay.url}/v1/heartbeat`, { token, body: beatBody(taskId), signer });
        assert.equal(res.status, 200);
      }
      assert.equal(relay.nonceCache.size, 3);

      // age the entries past the retention window, then run the same maintenance
      // tick the sweep timer runs
      relay.state.nowMs = () => Date.now() + 5000;
      relay.maintenance();
      assert.equal(relay.nonceCache.size, 0, 'the timer path must actually prune');
    });
  });

  it('refuses a configured-but-unusable secret instead of silently disabling signing', async () => {
    assert.throws(
      () => createRelayServer({ signingSecret: 12345, persist: false, logger: null }),
      (err) => err.code === 'BAD_REQUEST' && /signingSecret/.test(err.message),
      'a non-string secret is a configuration mistake, not "no signing"',
    );
    const relay = createRelayServer({ signingSecret: '', persist: false, logger: null });
    assert.equal(relay.signingConfigured, false, 'an empty string is the explicit "off"');
    assert.equal(relay.startupMessages.join('\n').includes('CONFIGURATION ERROR'), false);
  });

  /* ---- 11. deployment independence ---- */

  it('signs the ROUTED path, so a base-path mount verifies the same signature', async () => {
    await withRelay({
      signingSecret: SECRET, requireSignature: true, basePath: '/w2m', pairRateLimitPerMinute: 0,
    }, async (relay) => {
      const paired = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: {
          pairing_code: relay.state.createPairingCode(),
          machine_id: 'm1', platform: DEFAULT_PLATFORM, caps: DEFAULT_CAPS,
        },
      });
      assert.equal(paired.status, 200);

      // The client signs /v1/task, NOT /w2m/v1/task -- the same signature must work
      // whether a proxy passes the prefix through or strips it.
      const signed = await signedFetch(`${relay.url}/v1/task`, {
        token: OP, body: taskBody(), signer: NEW_SIGNER(), signedPath: '/v1/task',
      });
      assert.equal(signed.status, 200, signed.text);

      const rawPathSigned = await signedFetch(`${relay.url}/v1/task`, {
        token: OP, body: taskBody(), signer: NEW_SIGNER(), signedPath: '/w2m/v1/task',
      });
      assert.equal(rawPathSigned.status, 401, 'signing the raw URL path is a mismatch: document it, do not accept both');
    });
  });

  /* ---- 12. end to end, fully signed ---- */

  it('runs a complete signed task end to end', async () => {
    await withRelay({
      signingSecret: SECRET, requireSignature: true, pairRateLimitPerMinute: 0,
    }, async (relay) => {
      const signer = NEW_SIGNER();

      const paired = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: {
          pairing_code: relay.state.createPairingCode(),
          machine_id: 'm1', machine_name: 'm1', platform: DEFAULT_PLATFORM, caps: DEFAULT_CAPS,
        },
      });
      assert.equal(paired.status, 200);
      const token = paired.json.device_token;

      // 1. the agent opens the SSE stream, signed
      const sse = await openSse(`${relay.url}/v1/stream?machine_id=m1`, {
        token,
        headers: signer.headers({ method: 'GET', path: '/v1/stream?machine_id=m1', body: '' }),
      });
      try {
        const ready = await sse.waitFor((f) => f.event === 'ready');
        assert.equal(ready.json.protocol_version, 1);

        // 2. the operator dispatches a signed task
        const created = await signedFetch(`${relay.url}/v1/task`, { token: OP, body: taskBody(), signer });
        assert.equal(created.status, 200, created.text);
        const taskId = created.json.task_id;

        // 3. the offer reaches the machine
        const offer = await sse.waitFor((f) => f.event === 'task.offer');
        assert.equal(offer.json.task_id, taskId);

        // 4. signed heartbeats renew the lease
        const hb = await signedFetch(`${relay.url}/v1/heartbeat`, {
          token, body: { task_id: taskId, machine_id: 'm1', attempt: 1, phase: 'running', progress: 0.5, rtt_ms: 12 },
          signer,
        });
        assert.equal(hb.status, 200);
        assert.equal(hb.json.cancel, false);
        assert.equal(hb.json.lease_until, rfc3339(relay.state.nowMs() + 50_000));

        // 5. a signed idle heartbeat keeps the RTT view fresh without a lease
        const idle = await signedFetch(`${relay.url}/v1/heartbeat`, {
          token, body: { diagnostic: true, rtt_ms: 12 }, signer,
        });
        assert.equal(idle.status, 200);
        assert.equal(idle.json.diagnostic, true);

        // 6. a signed result
        const result = await signedFetch(`${relay.url}/v1/result`, {
          token, body: envelopeForTask(taskId, 'm1'), signer,
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.deduped, false);

        // 7. a signed read of the verdict
        const view = await signedFetch(`${relay.url}/v1/tasks/${taskId}`, { method: 'GET', token, signer });
        assert.equal(view.status, 200);
        assert.equal(view.json.aggregate.status, 'consistent');
        assert.equal(view.json.aggregate.machines[0].outcome, 'ok');
      } finally {
        sse.close();
      }
    });
  });

  it('exposes the verify adapter over the frozen signing module contract', async () => {
    await withRelay({ signingSecret: SECRET, pairRateLimitPerMinute: 0 }, async (relay) => {
      const headers = NEW_SIGNER().headers({ method: 'POST', path: '/v1/result', body: '{"a":1}' });
      const good = relay.verifySignature({ headers }, { method: 'POST', signedPath: '/v1/result', body: '{"a":1}' });
      assert.deepEqual(good, { ok: true, signed: true, keyIndex: 0 });
      const bad = relay.verifySignature({ headers }, { method: 'POST', signedPath: '/v1/result', body: '{"a":2}' });
      assert.equal(bad.ok, false);
      assert.equal(bad.code, 'SIGNATURE_MISMATCH');
      // one cache per relay instance
      assert.ok(relay.nonceCache instanceof NonceCache);
      assert.notEqual(relay.nonceCache, createRelayServer({ persist: false, logger: null }).nonceCache);
    });
  });
});

/* ================================================================== */
/* v0.3.0 §9.4.1 — cross-team signing test vectors                     */
/* ================================================================== */

/**
 * PROTOCOL-v0.3.0.md §9.4.1 publishes these vectors so the sending side and the
 * verifying side can each compute them independently and compare. They are pinned
 * here byte-for-byte, so any change to the algorithm on EITHER side turns this red
 * instead of silently producing signatures that only one end accepts.
 *
 * The constants below must stay identical to §9.4.1.
 */
describe('signing test vectors (§9.4.1)', () => {
  const VECTOR_SECRET = 'test-secret-abc';

  const V1 = {
    method: 'POST',
    path: '/v1/heartbeat',
    timestamp: 1780000000,
    nonce: 'abcdef0123456789',
    body: '{"task_id":"T1","machine_id":"m1"}',
  };
  const V1_CANONICAL = [
    'v1',
    'POST',
    '/v1/heartbeat',
    '1780000000',
    'abcdef0123456789',
    'c132705f2342284320b7e59ef2f32f9d580f6ecf1b83116ae22b71ad6fa09d28',
  ].join('\n');
  const V1_SIGNATURE = 'v1=a8de86289154861c7289b87e3bb4f39121c5ca0f59d50f819285efe3265778db';

  const V2 = {
    method: 'GET',
    path: '/v1/stream?machine_id=m1&seq=4',
    timestamp: 1780000001,
    nonce: '0123456789abcdef',
    body: '',
  };
  const V2_CANONICAL = [
    'v1',
    'GET',
    '/v1/stream?machine_id=m1&seq=4',
    '1780000001',
    '0123456789abcdef',
    'b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad',
  ].join('\n');
  const V2_SIGNATURE = 'v1=a9c899e05b70be0c4fce37ef7cbedacd8bdf36984faeafc8499f13a135776ce6';

  it('reproduces the published canonical strings and signatures byte for byte', () => {
    assert.equal(canonicalString(V1), V1_CANONICAL);
    assert.equal(canonicalString(V2), V2_CANONICAL);
    assert.equal(signRequest({ secret: VECTOR_SECRET, ...V1 }), V1_SIGNATURE);
    assert.equal(signRequest({ secret: VECTOR_SECRET, ...V2 }), V2_SIGNATURE);
    assert.match(V1_SIGNATURE, /^v1=[0-9a-f]{64}$/);
  });

  it('proves prefix sensitivity: the same request signed with a base path differs', () => {
    const withPrefix = signRequest({ secret: VECTOR_SECRET, ...V1, path: '/w2m/v1/heartbeat' });
    assert.equal(withPrefix, 'v1=20c0f143fd27a61c86d876fdd802d143645d5238a301b7d91269205e37a6300d');
    assert.notEqual(withPrefix, V1_SIGNATURE, 'signing the wrong path can never verify');
  });

  it('a live relay accepts vector 1 exactly as published', async () => {
    // The relay clock is frozen at the vector's timestamp so this stays deterministic:
    // no sleep, no skew window dependency.
    const frozenMs = V1.timestamp * 1000;
    await withRelay({
      now: () => frozenMs,
      signingSecret: VECTOR_SECRET,
      requireSignature: true,
      pairRateLimitPerMinute: 0,
    }, async (relay) => {
      const paired = await request(`${relay.url}/v1/pair`, {
        method: 'POST',
        body: {
          pairing_code: relay.state.createPairingCode(),
          machine_id: 'm1', platform: DEFAULT_PLATFORM, caps: DEFAULT_CAPS,
        },
      });
      assert.equal(paired.status, 200);
      const token = paired.json.device_token;

      // a task literally called "T1", because the vector's body names it
      const signer = createSigner({ secret: VECTOR_SECRET, now: () => frozenMs });
      const created = await signedFetch(`${relay.url}/v1/task`, {
        token: OP, body: taskBody({ task_id: 'T1' }), signer,
      });
      assert.equal(created.status, 200, created.text);
      assert.equal(created.json.task_id, 'T1');

      // now replay the published vector verbatim: exact bytes, headers and all
      const res = await request(`${relay.url}/v1/heartbeat`, {
        method: 'POST',
        token,
        rawBody: V1.body,
        headers: {
          [SIGNATURE_HEADER]: V1_SIGNATURE,
          [TIMESTAMP_HEADER]: String(V1.timestamp),
          [NONCE_HEADER]: V1.nonce,
        },
      });
      assert.equal(res.status, 200, `the published vector must be accepted by a real relay: ${res.text}`);
      assert.equal(res.json.cancel, false);
      assert.equal(res.json.lease_until, rfc3339(frozenMs + 50_000));
    });
  });
});
