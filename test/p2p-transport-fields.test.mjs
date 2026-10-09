/**
 * v0.4.0 relay pass-through: `origin_machine_id` / `p2p` on offers, `transport` / `p2p` on results.
 *
 * Three separate claims are made here, and each one is worth stating before the tests:
 *
 *   1. **A task's routing facts reach every offer.** `origin_machine_id` and `p2p.mode` are typed at
 *      dispatch time and must arrive at the machine that has to run the command. They are also part
 *      of the *re-offered* offer (reconnect `redeliverPendingOffers`, and the restart replay), so
 *      that a machine which was offline at dispatch sees the same facts when the work comes back.
 *
 *   2. **A bad value is refused, never half-applied.** `POST /v1/task` is all-or-nothing: a rejected
 *      task must not appear in `GET /v1/tasks` and must not have emitted an offer. A partial write
 *      here would be worse than the rejection, because the operator would have a task they cannot
 *      explain.
 *
 *   3. **A transport is not a result.** `transport`/`p2p` are neither required (§5.1) nor comparable
 *      (§5.3) fields. The regression test below is the one that matters: two byte-identical
 *      envelopes that differ *only* in whether `transport: 'p2p'` is present must aggregate to the
 *      same verdict. If `transport` ever enters `COMPARABLE_FIELDS`, a working cross-network run
 *      would be reported `divergent` -- the machine answered over the fast path and the other did
 *      not -- and the operator would be sent to look for a difference in output that does not exist.
 *
 * Harness: a local copy of the helpers in test/relay.test.mjs, matching the convention stated in
 * test/p2p-signaling.test.mjs -- suites must not be able to break each other by editing a shared
 * module. Persistence is off (`persist: false`), so nothing here touches a real `~/.w2m`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createRelayServer } from '../src/relay/server.mjs';
import {
  COMPARABLE_FIELDS,
  MAX_ORIGIN_MACHINE_ID_LENGTH,
  P2P_MODES,
  REQUIRED_ENVELOPE_FIELDS,
  computeCommandHash,
  computeDedupeKey,
  sha256Hex,
} from '../src/relay/state.mjs';

const OP = 'transport-operator-token';

const DEFAULT_PLATFORM = {
  os: 'windows',
  os_version: '10.0.26100',
  arch: 'x64',
  shell: 'pwsh',
  shell_version: '7.4.0',
};
const DEFAULT_CAPS = {
  case_sensitive_fs: false,
  symlinks: false,
  exec_bit: false,
  python: null,
  npm: null,
  node: 'v24.21.0',
  write: true,
};

const ARGV = ['node', '--test'];
const CMD_HASH = computeCommandHash(ARGV, 'direct-exec', '.');
const BASE_COMMIT = 'c0ffee1';
const BASE_TREE = 'tree-abc';

/* ------------------------------------------------------------------ */
/* harness (local copy — see the header note)                          */
/* ------------------------------------------------------------------ */

function request(url, { method = 'GET', token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function parseFrame(raw) {
  const frame = { comment: false, id: null, event: null, data: null, json: null, raw };
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      frame.comment = true;
      continue;
    }
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
    try {
      frame.json = JSON.parse(frame.data);
    } catch {
      frame.json = null;
    }
  }
  return frame;
}

/** SSE reader: keeps every frame and lets a test await the one it wants. */
function openSse(url, { token, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const frames = [];
    const waiters = new Set();
    let buffer = '';
    let ended = false;

    const pump = () => {
      for (const w of [...waiters]) if (w()) waiters.delete(w);
    };

    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
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
        res.on('end', () => {
          ended = true;
          pump();
        });
        res.on('error', () => {
          ended = true;
          pump();
        });

        const client = {
          status: res.statusCode,
          frames,
          get ended() {
            return ended;
          },
          /** Await the first frame at or after `from` matching `pred`. */
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
                rej2(
                  new Error(
                    `SSE timeout after ${timeoutMs2}ms; frames=${JSON.stringify(frames.map((f) => f.event ?? 'comment'))}`,
                  ),
                );
              }, timeoutMs2);
            });
          },
          close() {
            waiters.clear();
            req.destroy();
          },
        };
        resolve(client);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function startRelay(options = {}) {
  const relay = createRelayServer({ logger: null, operatorToken: OP, persist: false, ...options });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  return relay;
}

async function withRelay(fn, options = {}) {
  const relay = await startRelay(options);
  try {
    return await fn(relay);
  } finally {
    await relay.close();
  }
}

async function pairDevice(relay, machineId) {
  const res = await request(`${relay.url}/v1/pair`, {
    method: 'POST',
    body: {
      pairing_code: relay.state.createPairingCode(),
      machine_id: machineId,
      machine_name: machineId,
      platform: DEFAULT_PLATFORM,
      caps: DEFAULT_CAPS,
    },
  });
  assert.equal(res.status, 200, `pair failed: ${res.text}`);
  return { token: res.json.device_token, machineId };
}

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
    compare_policy: {},
    halt: 'never',
    created_by: 'test',
    ...over,
  };
}

const postTask = (relay, body, token = OP) =>
  request(`${relay.url}/v1/task`, { method: 'POST', token, body });
const postResult = (relay, token, body) => request(`${relay.url}/v1/result`, { method: 'POST', token, body });
const taskList = (relay, token) => request(`${relay.url}/v1/tasks`, { token });

/** Envelope for a real task created through the relay; comparable fields all match the task. */
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

/** The per-machine record for `machineId` in either aggregate or report JSON. */
const machineIn = (body, machineId) => body.machines.find((m) => m.machine_id === machineId);

/* ================================================================== */

describe('v0.4.0 task body: origin_machine_id and p2p reach every offer', () => {
  it('carries origin_machine_id and p2p.mode verbatim on a live SSE offer', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const sse = await openSse(`${relay.url}/v1/stream`, { token: a.token });
      try {
        await sse.waitFor((f) => f.event === 'ready');

        const created = await postTask(
          relay,
          taskBody({
            origin_machine_id: 'win-desktop',
            p2p: { mode: 'auto' },
          }),
        );
        assert.equal(created.status, 200, created.text);

        const offer = await sse.waitFor(
          (f) => f.event === 'task.offer' && f.json?.task_id === created.json.task_id,
        );
        assert.equal(offer.json.origin_machine_id, 'win-desktop');
        assert.deepEqual(offer.json.p2p, { mode: 'auto' });
      } finally {
        sse.close();
      }
    });
  });

  it('keeps both fields on a re-offered offer, so a reconnect sees the same routing facts', async () => {
    // The offer is emitted more than once in real life (a stream that was down at dispatch time is
    // re-stated on reconnect). If the fields only existed on the first emission, the direct-push
    // path would work exactly once and then silently stop.
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const created = await postTask(
        relay,
        taskBody({
          origin_machine_id: 'mac-mini',
          p2p: { mode: 'direct' },
        }),
      );
      assert.equal(created.status, 200, created.text);
      const taskId = created.json.task_id;

      const sse = await openSse(`${relay.url}/v1/stream`, { token: a.token });
      try {
        const offer = await sse.waitFor((f) => f.event === 'task.offer' && f.json?.task_id === taskId);
        assert.equal(offer.json.origin_machine_id, 'mac-mini');
        assert.deepEqual(offer.json.p2p, { mode: 'direct' });
      } finally {
        sse.close();
      }
    });
  });

  it('answers null (not a missing key) when the caller supplied neither field', async () => {
    // `null` is the v0.3.9 shape: "the dispatcher did not say". One shape for both cases is what
    // lets a consumer read the field without a presence check.
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const sse = await openSse(`${relay.url}/v1/stream`, { token: a.token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const created = await postTask(relay, taskBody());
        const offer = await sse.waitFor(
          (f) => f.event === 'task.offer' && f.json?.task_id === created.json.task_id,
        );
        assert.equal(offer.json.origin_machine_id, null);
        assert.equal(offer.json.p2p, null);
      } finally {
        sse.close();
      }
    });
  });

  it('accepts an origin_machine_id of exactly the maximum length', async () => {
    await withRelay(async (relay) => {
      await pairDevice(relay, 'machine-a');
      const longest = 'm'.repeat(MAX_ORIGIN_MACHINE_ID_LENGTH);
      const created = await postTask(relay, taskBody({ origin_machine_id: longest }));
      assert.equal(created.status, 200, created.text);
      assert.equal(relay.state.getTask(created.json.task_id).origin_machine_id, longest);
    });
  });
});

describe('v0.4.0 task body: a bad routing field is refused and creates nothing', () => {
  const BAD_ORIGIN = [
    ['a number', 42],
    ['a non-empty object', { machine: 'win-desktop' }],
    ['an array', ['win-desktop']],
    ['an empty string', ''],
    ['a string past the ceiling', 'x'.repeat(MAX_ORIGIN_MACHINE_ID_LENGTH + 1)],
  ];
  const BAD_P2P = [
    ['a bare string', 'auto'],
    ['a number', 7],
    ['an array', ['auto']],
    ['an object with no mode', {}],
    ['an unknown mode', { mode: 'satellite' }],
    ['a non-string mode', { mode: 1 }],
  ];

  for (const [label, value] of BAD_ORIGIN) {
    it(`refuses origin_machine_id as ${label} with BAD_REQUEST naming the field`, async () => {
      await withRelay(async (relay) => {
        const a = await pairDevice(relay, 'machine-a');
        const before = await taskList(relay, a.token);
        assert.equal(before.json.tasks.length, 0, 'the relay starts with no tasks');

        const res = await postTask(relay, taskBody({ origin_machine_id: value }));
        assert.equal(res.status, 400, res.text);
        assert.equal(res.json.error.code, 'BAD_REQUEST');
        assert.match(res.json.error.message, /origin_machine_id/);
        assert.ok('origin_machine_id' in res.json.error.detail, 'the detail names the offending field');

        const after = await taskList(relay, a.token);
        assert.equal(after.json.tasks.length, 0, 'a rejected task must not be created, even partially');
        assert.equal(relay.state.tasks.size, 0);
      });
    });
  }

  for (const [label, value] of BAD_P2P) {
    it(`refuses p2p as ${label} with BAD_REQUEST naming the field`, async () => {
      await withRelay(async (relay) => {
        const a = await pairDevice(relay, 'machine-a');
        const res = await postTask(relay, taskBody({ p2p: value }));
        assert.equal(res.status, 400, res.text);
        assert.equal(res.json.error.code, 'BAD_REQUEST');
        assert.match(res.json.error.message, /p2p\.mode|p2p/);
        assert.ok('p2p.mode' in res.json.error.detail || 'p2p' in res.json.error.detail);

        const after = await taskList(relay, a.token);
        assert.equal(after.json.tasks.length, 0, 'a rejected task must not be created, even partially');
      });
    });
  }

  it('does not emit an offer for a refused task', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const sse = await openSse(`${relay.url}/v1/stream`, { token: a.token });
      try {
        await sse.waitFor((f) => f.event === 'ready');
        const bad = await postTask(relay, taskBody({ p2p: { mode: 'nope' } }));
        assert.equal(bad.status, 400);
        // Nudge the stream with a valid task, then assert the ONLY offer is the valid one. A bare
        // sleep would be a guess about scheduling; this makes the ordering observable.
        const good = await postTask(
          relay,
          taskBody({ origin_machine_id: 'win-desktop', p2p: { mode: 'relay' } }),
        );
        assert.equal(good.status, 200, good.text);
        await sse.waitFor((f) => f.event === 'task.offer' && f.json?.task_id === good.json.task_id);
        const offers = sse.frames.filter((f) => f.event === 'task.offer');
        assert.equal(offers.length, 1, 'the refused task emitted nothing');
        assert.equal(offers[0].json.task_id, good.json.task_id);
      } finally {
        sse.close();
      }
    });
  });

  it('accepts every mode of the frozen list, and refuses one outside it', async () => {
    await withRelay(async (relay) => {
      await pairDevice(relay, 'machine-a');
      for (const mode of P2P_MODES) {
        const created = await postTask(relay, taskBody({ p2p: { mode } }));
        assert.equal(created.status, 200, `mode ${mode} must be accepted: ${created.text}`);
        assert.deepEqual(relay.state.getTask(created.json.task_id).p2p, { mode });
      }
      const outside = await postTask(relay, taskBody({ p2p: { mode: 'P2P' } }));
      assert.equal(outside.status, 400, 'an unknown mode is refused, never silently defaulted');
      assert.equal(relay.state.tasks.size, P2P_MODES.length);
    });
  });
});

describe('v0.4.0 result envelope: transport and p2p survive the round trip', () => {
  const P2P_DETAIL = {
    mode: 'auto',
    offer_path: 'p2p',
    result_path: 'p2p',
    reason: null,
    rtt_ms: 12,
    peer: 'mac-mini',
    session: 4242,
    mapping: 'endpoint-independent',
  };

  it('exposes them on GET /v1/tasks/{id} and on the JSON report, adding no required field', async () => {
    assert.equal(
      REQUIRED_ENVELOPE_FIELDS.includes('transport'),
      false,
      'a transport is not a result: it must never make an envelope incomplete',
    );
    assert.equal(REQUIRED_ENVELOPE_FIELDS.includes('p2p'), false);
    assert.equal(
      COMPARABLE_FIELDS.includes('transport'),
      false,
      'a path difference must never turn `consistent` into `divergent`',
    );
    assert.equal(COMPARABLE_FIELDS.includes('p2p'), false);

    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const created = await postTask(relay, taskBody({ p2p: { mode: 'auto' } }));
      const taskId = created.json.task_id;

      const res = await postResult(
        relay,
        a.token,
        envelopeForTask(taskId, 'machine-a', {
          transport: 'p2p',
          p2p: P2P_DETAIL,
        }),
      );
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.deduped, false);

      const view = await request(`${relay.url}/v1/tasks/${taskId}`, { token: a.token });
      assert.equal(view.status, 200, view.text);
      const machine = machineIn(view.json.aggregate, 'machine-a');
      assert.ok(machine, 'the machine is in the aggregate');
      assert.equal(machine.transport, 'p2p');
      assert.deepEqual(machine.p2p, P2P_DETAIL);
      // The existing machine keys must all still be there: additive, not a replacement.
      for (const key of [
        'machine_id',
        'machine_name',
        'index',
        'attempt',
        'lease_state',
        'outcome',
        'status',
        'refusal_reason',
        'exit_code',
        'reasons',
      ]) {
        assert.ok(key in machine, `existing key \`${key}\` must survive`);
      }

      const report = await request(`${relay.url}/v1/tasks/${taskId}/report?format=json`, { token: a.token });
      assert.equal(report.status, 200, report.text);
      const reported = machineIn(report.json, 'machine-a');
      assert.equal(reported.transport, 'p2p');
      assert.deepEqual(reported.p2p, P2P_DETAIL);
      assert.equal(report.json.status, view.json.aggregate.status, 'the two views agree');
    });
  });

  it('reports null for a machine whose envelope carries no transport', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const created = await postTask(relay, taskBody());
      const taskId = created.json.task_id;
      const res = await postResult(relay, a.token, envelopeForTask(taskId, 'machine-a'));
      assert.equal(res.status, 200, res.text);

      const report = await request(`${relay.url}/v1/tasks/${taskId}/report?format=json`, { token: a.token });
      assert.equal(machineIn(report.json, 'machine-a').transport, null);
      assert.equal(machineIn(report.json, 'machine-a').p2p, null);
    });
  });

  it('refuses an unknown transport value by name instead of storing it', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const created = await postTask(relay, taskBody());
      const taskId = created.json.task_id;

      const res = await postResult(
        relay,
        a.token,
        envelopeForTask(taskId, 'machine-a', { transport: 'satellite' }),
      );
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.error.code, 'BAD_REQUEST');
      assert.match(res.json.error.message, /transport/);
      assert.equal(relay.state.results.size, 0, 'nothing was stored');

      const badP2p = await postResult(relay, a.token, envelopeForTask(taskId, 'machine-a', { p2p: 'p2p' }));
      assert.equal(badP2p.status, 400);
      assert.match(badP2p.json.error.message, /p2p/);
      assert.equal(relay.state.results.size, 0);

      // …and the task is still usable afterwards: the rejection is not a poisoned task.
      const good = await postResult(
        relay,
        a.token,
        envelopeForTask(taskId, 'machine-a', { transport: 'relay' }),
      );
      assert.equal(good.status, 200, good.text);
    });
  });

  it("accepts `transport: 'relay'` and an explicit null p2p", async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      const created = await postTask(relay, taskBody());
      const res = await postResult(
        relay,
        a.token,
        envelopeForTask(created.json.task_id, 'machine-a', {
          transport: 'relay',
          p2p: null,
        }),
      );
      assert.equal(res.status, 200, res.text);
      const report = await request(`${relay.url}/v1/tasks/${created.json.task_id}/report?format=json`, {
        token: a.token,
      });
      const machine = machineIn(report.json, 'machine-a');
      assert.equal(machine.transport, 'relay');
      assert.equal(machine.p2p, null);
    });
  });
});

describe('v0.4.0 markdown report: the trailing 路径 column', () => {
  it('prints p2p for a machine that reported one and - for a machine that did not', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      await pairDevice(relay, 'machine-b');
      const created = await postTask(relay, taskBody());
      const taskId = created.json.task_id;

      await postResult(relay, a.token, envelopeForTask(taskId, 'machine-a', { transport: 'p2p' }));
      await postResult(relay, a.token, envelopeForTask(taskId, 'machine-b'));

      const md = await request(`${relay.url}/v1/tasks/${taskId}/report?format=md`, { token: a.token });
      assert.equal(md.status, 200, md.text);

      const header = md.text.split('\n').find((line) => line.startsWith('| machine_id |'));
      assert.ok(header, 'the per-machine table header is present');
      // Every existing column keeps its name AND its position; 路径 is appended.
      assert.equal(
        header,
        '| machine_id | index | lease | 判定 | status | exit_code | 说明 | 路径 |',
        'the header is the v0.3.9 header with one column appended',
      );
      const separator = md.text.split('\n')[md.text.split('\n').indexOf(header) + 1];
      assert.equal(
        separator,
        '|---|---|---|---|---|---|---|---|',
        'the separator must match the header width',
      );

      const row = (machineId) =>
        md.text.split('\n').find((l) => l.includes(`\`${machineId}\``) && l.startsWith('| `'));
      assert.equal(row('machine-a').split('|').at(-2).trim(), 'p2p');
      assert.equal(row('machine-b').split('|').at(-2).trim(), '-', 'no transport means the column shows -');
      // The v0.3.9 columns still carry their values.
      assert.match(row('machine-a'), /✅|ok/);
    });
  });
});

describe('v0.4.0 regression: a transport difference is never a result difference', () => {
  it('THE INVARIANT: identical envelopes differing only by transport yield the same verdict', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      await pairDevice(relay, 'machine-b');

      // Two separate tasks, each dispatched to exactly one machine, so each verdict stands on its
      // own instead of one task's silent second machine muddying the other's comparison group.
      const withTransportTask = await postTask(relay, taskBody({ target_machines: ['machine-a'] }));
      assert.equal(withTransportTask.status, 200, withTransportTask.text);
      const transportTaskId = withTransportTask.json.task_id;
      const transportEnvelope = envelopeForTask(transportTaskId, 'machine-a', { transport: 'p2p' });

      const withoutTransportTask = await postTask(relay, taskBody({ target_machines: ['machine-b'] }));
      assert.equal(withoutTransportTask.status, 200, withoutTransportTask.text);
      const plainTaskId = withoutTransportTask.json.task_id;
      const plainEnvelope = envelopeForTask(plainTaskId, 'machine-b');

      // Apart from the four fields that identify the run, the two envelopes are the same object
      // shape with the same values: strip `transport` from the first and it IS the second.
      const IDENTIFYING = ['task_id', 'machine_id', 'machine_name', 'dedupe_key'];
      const shape = (env, drop) => {
        const copy = { ...env };
        for (const key of [...IDENTIFYING, ...drop]) delete copy[key];
        return JSON.stringify(copy);
      };
      assert.equal(transportEnvelope.transport, 'p2p');
      assert.equal(
        shape(transportEnvelope, ['transport']),
        shape(plainEnvelope, []),
        'the ONLY difference between the two envelopes is the transport field',
      );
      assert.equal('transport' in plainEnvelope, false, 'the second envelope carries no transport at all');
      assert.equal('p2p' in plainEnvelope, false, 'and no p2p object either');
      assert.deepEqual(
        Object.keys(transportEnvelope),
        [...Object.keys(plainEnvelope), 'transport'],
        'the transport envelope adds the field and touches nothing else',
      );

      assert.equal((await postResult(relay, a.token, transportEnvelope)).status, 200);
      assert.equal((await postResult(relay, a.token, plainEnvelope)).status, 200);

      const p2pView = await request(`${relay.url}/v1/tasks/${transportTaskId}`, { token: a.token });
      const plainView = await request(`${relay.url}/v1/tasks/${plainTaskId}`, { token: a.token });
      assert.equal(p2pView.json.aggregate.status, 'consistent');
      assert.equal(
        p2pView.json.aggregate.status,
        plainView.json.aggregate.status,
        'one machine took the direct path and the other did not; that must not read as a divergence',
      );
      assert.deepEqual(plainView.json.aggregate.differences, []);
    });
  });

  it('machines that took different paths still compare as consistent with EACH OTHER', async () => {
    // The stronger form: one task, one comparison group, two machines whose envelopes differ only
    // in `transport` (p2p vs absent). Step 3 must find zero differences.
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      await pairDevice(relay, 'machine-b');
      const created = await postTask(relay, taskBody());
      const taskId = created.json.task_id;

      assert.equal(
        (
          await postResult(
            relay,
            a.token,
            envelopeForTask(taskId, 'machine-a', {
              transport: 'p2p',
              p2p: { mode: 'auto', result_path: 'p2p' },
            }),
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await postResult(
            relay,
            a.token,
            envelopeForTask(taskId, 'machine-b', {
              transport: 'relay',
            }),
          )
        ).status,
        200,
      );

      const view = await request(`${relay.url}/v1/tasks/${taskId}`, { token: a.token });
      assert.equal(view.json.aggregate.machines.length, 2);
      assert.equal(view.json.aggregate.status, 'consistent', JSON.stringify(view.json.aggregate.differences));
      assert.deepEqual(view.json.aggregate.differences, [], 'transport/p2p never appear as a difference');
      const compared = new Set(Object.keys(view.json.aggregate.steps[3].comparable));
      assert.equal(compared.has('transport'), false);
      assert.equal(compared.has('p2p'), false);
    });
  });
});

describe('v0.4.0 backward compatibility: a v0.3.9-shaped result still works', () => {
  it('a v0.3.9 envelope round-trips and stays consistent against another v0.3.9 envelope', async () => {
    await withRelay(async (relay) => {
      const a = await pairDevice(relay, 'machine-a');
      await pairDevice(relay, 'machine-b');
      const created = await postTask(relay, taskBody());
      const taskId = created.json.task_id;

      // Nothing v0.4.0 about these: no `transport`, no `p2p`, and no v0.4.0 task-body fields.
      const first = envelopeForTask(taskId, 'machine-a');
      const second = envelopeForTask(taskId, 'machine-b');
      assert.equal('transport' in first || 'p2p' in first, false);

      const r1 = await postResult(relay, a.token, first);
      const r2 = await postResult(relay, a.token, second);
      assert.equal(r1.status, 200, r1.text);
      assert.equal(r2.status, 200, r2.text);
      assert.equal(r1.json.deduped, false);
      assert.equal(r2.json.deduped, false);

      const view = await request(`${relay.url}/v1/tasks/${taskId}`, { token: a.token });
      assert.equal(view.json.aggregate.status, 'consistent');
      for (const machine of view.json.aggregate.machines) {
        assert.equal(machine.transport, null);
        assert.equal(machine.p2p, null);
        assert.deepEqual(machine.reasons, [], 'a missing transport must not be a reason');
      }

      // …and the markdown report renders it as `-` rather than inventing a path.
      const md = await request(`${relay.url}/v1/tasks/${taskId}/report?format=md`, { token: a.token });
      assert.match(md.text, /路径/);
      for (const machineId of ['machine-a', 'machine-b']) {
        const row = md.text.split('\n').find((l) => l.includes(`\`${machineId}\``) && l.startsWith('| `'));
        assert.equal(row.split('|').at(-2).trim(), '-', `${machineId} has no transport`);
      }
    });
  });

  it('a v0.3.9 task body (no routing fields) is byte-for-byte the old request', async () => {
    await withRelay(async (relay) => {
      await pairDevice(relay, 'machine-a');
      const created = await postTask(relay, taskBody());
      assert.equal(created.status, 200, created.text);
      const task = relay.state.getTask(created.json.task_id);
      assert.equal(task.origin_machine_id, null);
      assert.equal(task.p2p, null);
      // The offer keeps its v0.3.9 keys; the two new ones are additive and null.
      const offer = relay.state.buffer.map((e) => e.event).find((e) => e.type === 'task.offer');
      assert.equal(offer.origin_machine_id, null);
      assert.equal(offer.p2p, null);
      for (const key of [
        'task_id',
        'attempt',
        'mode',
        'index',
        'index_total',
        'command_argv',
        'cwd_rel',
        'write',
        'timeout_ms',
        'base_commit',
        'base_tree',
        'requirements',
        'compare_policy',
        'dedupe_key',
        'deadline',
      ]) {
        assert.ok(key in offer, `v0.3.9 offer key \`${key}\` must survive`);
      }
    });
  });
});
