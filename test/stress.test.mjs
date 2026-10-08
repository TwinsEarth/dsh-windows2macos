/**
 * W2M stress suite — bounded load with no lost or duplicated work.
 *
 * Run: <bundled node> --test --test-force-exit test/stress.test.mjs
 *
 * What this file proves, and why every assertion is on an observable fact
 * rather than a timing print:
 *
 *   1. Volume    — 200 tasks dispatched at a live relay: every task_id unique,
 *                  every task retrievable by id, and the relay's own counts
 *                  (`/healthz` and `GET /v1/tasks`) agree with what was sent.
 *   2. Duplicate — 24 concurrent redeliveries of one instance: stored exactly
 *                  once, proved in the relay's ledger rather than from the
 *                  response code alone, plus the documented §4.4 triple-key
 *                  boundary (a different `attempt` is a different instance).
 *   3. Leases    — 50 devices: no lease lost, split indices follow the §4.2
 *                  contract (`index = i % index_total`), and `aggregate()` over
 *                  the whole set terminates with a verdict from
 *                  AGGREGATE_STATUSES — with controls that show the verdict is
 *                  not hard-wired to `consistent`.
 *   4. Burst     — a `/v1/pair` burst past the limit is refused, the refusals
 *                  are counted, failed attempts consume the same budget, and a
 *                  control run with the limiter disabled proves the 429s came
 *                  from the limiter and not from the request shape.
 *
 * Fleet onboarding uses `pairingCodeReusable: true` — the documented mode for
 * scripted onboarding (PROTOCOL.md §2.2 rule 3). With rotation on, a successful
 * pairing retires *every* outstanding code, so pre-minting one code per machine
 * is not a supported workflow; see the report for the evidence and the ruling.
 *
 * Synchronisation rule: no `sleep`. Every await is on a response whose arrival
 * implies the relay finished that unit of work, or on a synchronous state read.
 *
 * Scope: this file only. The harness (request / startRelay / withRelay /
 * pairDevice / taskBody) is copied from test/relay.test.mjs so the two suites
 * share no mutable state and neither can break the other by editing helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { buildEnvelope } from '../src/agent/agent.mjs';
import { AGGREGATE_STATUSES, aggregateTask } from '../src/relay/report.mjs';
import { ACTIVE_LEASE_STATES, COMPARABLE_FIELDS, computeCommandHash, computeDedupeKey, jcs, sha256Hex } from '../src/relay/state.mjs';
import { createRelayServer } from '../src/relay/server.mjs';

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

/** v0.1.2 §5: POST /v1/task takes the OPERATOR token, not a device token. */
const OP = 'stress-operator-token';

const ARGV = ['node', '--test'];
const SHELL_ID = 'direct-exec';
const CWD_REL = '.';
const BASE_COMMIT = 'c0ffee1';
const BASE_TREE = 'tree-stress';
const CMD_HASH = computeCommandHash(ARGV, SHELL_ID, CWD_REL);

const PLATFORM = {
  os: 'windows', os_version: '10.0.26100', arch: 'x64', shell: 'pwsh', shell_version: '7.4.0',
};
const CAPS = {
  case_sensitive_fs: false, symlinks: false, exec_bit: false,
  python: null, npm: null, node: 'v24.21.0', write: true,
};

function request(url, { method = 'GET', token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
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
    if (payload) req.end(payload);
    else req.end();
  });
}

async function startRelay(options = {}) {
  // Persistence is opt-in by stateDir so no test ever touches the real ~/.w2m.
  const persist = options.persist ?? (options.stateDir !== undefined);
  const relay = createRelayServer({ logger: null, operatorToken: OP, ...options, persist });
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

function pairRequest(relay, machineId, pairingCode, extra = {}) {
  return request(`${relay.url}/v1/pair`, {
    method: 'POST',
    body: {
      pairing_code: pairingCode,
      machine_id: machineId,
      machine_name: machineId,
      platform: PLATFORM,
      caps: CAPS,
      ...extra,
    },
  });
}

/** Pair one device with a freshly minted code (rotation-safe: one pairing). */
async function pairDevice(relay, machineId, extra = {}) {
  const res = await pairRequest(relay, machineId, relay.state.createPairingCode(), extra);
  assert.equal(res.status, 200, `pair failed for ${machineId}: ${res.text}`);
  return { token: res.json.device_token, body: res.json };
}

/**
 * Pair N devices concurrently. Requires a relay started with
 * `pairingCodeReusable: true`: one live code serves the whole fleet, which is
 * the documented scripted-onboarding mode (PROTOCOL.md §2.2 rule 3).
 */
async function pairFleet(relay, machineIds) {
  assert.equal(relay.state.pairingCodeReusable, true, 'pairFleet needs a reusable pairing code');
  assert.equal(relay.pairRateLimitPerMinute, 0,
    'pairFleet needs the pair rate limiter off: a fleet shares one client IP');
  const code = relay.state.createPairingCode();
  const responses = await Promise.all(machineIds.map((id) => pairRequest(relay, id, code)));
  const bad = responses.filter((r) => r.status !== 200);
  assert.equal(bad.length, 0, `fleet pairing failed: ${bad.map((r) => `${r.status} ${r.text}`).join(' | ')}`);
  return new Map(machineIds.map((id, i) => [id, responses[i].json.device_token]));
}

const postTask = (relay, body, token = OP) => request(`${relay.url}/v1/task`, { method: 'POST', token, body });
const postResult = (relay, token, envelope) => request(`${relay.url}/v1/result`, { method: 'POST', token, body: envelope });
const getJson = (relay, path, token) => request(`${relay.url}${path}`, { token });

function taskBody(over = {}) {
  return {
    mode: 'replicate',
    command_argv: ARGV,
    cwd_rel: CWD_REL,
    index_total: 1,
    timeout_ms: 300_000,
    write: false,
    base_commit: BASE_COMMIT,
    base_tree: BASE_TREE,
    requirements: {},
    compare_policy: { strip_ansi: true, normalize_crlf: true },
    halt: 'never',
    created_by: 'stress',
    ...over,
  };
}

/**
 * A complete §5.1 envelope built by the AGENT's own builder, so the relay sees
 * a genuinely verified `envelope_sha256` instead of a hand-rolled placeholder.
 */
function envelopeFor(task, machineId, over = {}) {
  const index = over.index ?? 0;
  const indexTotal = over.index_total ?? 1;
  return buildEnvelope({
    envelope_version: '1.0',
    task_id: task.task_id,
    attempt: 1,
    dedupe_key: computeDedupeKey(task.task_id, index, CMD_HASH, BASE_TREE),
    machine_id: machineId,
    machine_name: machineId,
    platform: PLATFORM,
    caps: CAPS,
    index,
    index_total: indexTotal,
    mode: 'replicate',
    cwd_rel: CWD_REL,
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
    shell_id: SHELL_ID,
    started_at: '2026-10-07T12:00:00Z',
    ended_at: '2026-10-07T12:00:01Z',
    duration_ms: 1000,
    exit_code: 0,
    status: 'ok',
    refusal_reason: null,
    stdout_sha256: sha256Hex('stress'),
    stdout_bytes: 6,
    stderr_sha256: sha256Hex(''),
    stderr_bytes: 0,
    warnings: [],
    ...over,
  });
}

/** Run `fn` over `items` in bounded waves (keeps the socket table sane). */
async function mapChunked(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. volume: nothing dropped, nothing silently merged                 */
/* ------------------------------------------------------------------ */

describe('stress / dispatch volume', () => {
  it('200 concurrent dispatches: ids unique, all retrievable, relay counts agree', async () => {
    const N = 200;
    await withRelay({}, async (relay) => {
      const reader = await pairDevice(relay, 'reader-0');

      const responses = await Promise.all(
        Array.from({ length: N }, (_, i) => postTask(relay, taskBody({ created_by: `stress-${i}` }))),
      );

      // (a) every dispatch was accepted — a rejected create is a silent drop
      const accepted = responses.filter((r) => r.status === 200);
      assert.equal(accepted.length, N, `only ${accepted.length}/${N} dispatches were accepted`);

      // (b) every task_id is unique — a collision would overwrite a task record
      const ids = responses.map((r) => r.json.task_id);
      assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), 'a task_id is missing/empty');
      assert.equal(new Set(ids).size, N, 'task_id collision: two dispatches share one id');

      // (c) the relay's own ledger holds exactly N tasks
      assert.equal(relay.state.tasks.size, N, 'relay task ledger lost a record');
      assert.equal(relay.state.stats().tasks, N);

      const health = await getJson(relay, '/healthz');
      assert.equal(health.status, 200);
      assert.equal(health.json.tasks, N, '/healthz disagrees with the dispatched count');
      assert.equal(health.json.results, 0, 'a task was dispatched but a result already exists');

      // (d) the public list agrees — with an explicit limit that covers the set
      const listed = await getJson(relay, `/v1/tasks?limit=${N + 50}`, reader.token);
      assert.equal(listed.status, 200);
      assert.equal(listed.json.tasks.length, N, 'GET /v1/tasks dropped tasks inside the requested window');
      assert.deepEqual(
        new Set(listed.json.tasks.map((t) => t.task_id)),
        new Set(ids),
        'GET /v1/tasks returned a different set of ids than were dispatched',
      );

      // Every returned summary is internally consistent with the dispatched task.
      assert.ok(
        listed.json.tasks.every((t) => t.mode === 'replicate' && t.index_total === 1 && t.cancelled === false),
        'a listed task summary does not match what was dispatched',
      );

      // (e) every task is retrievable individually
      const fetched = await mapChunked(ids, 50, (id) => getJson(relay, `/v1/tasks/${id}`, reader.token));
      assert.equal(fetched.filter((r) => r.status === 200).length, N, 'a dispatched task is not retrievable by id');
      assert.ok(
        fetched.every((r, i) => r.json?.task?.task_id === ids[i]),
        'GET /v1/tasks/{id} answered with the wrong task',
      );

      // (f) documented boundary: the default page is 50 and carries no total, so
      // a reader cannot tell "50 tasks exist" from "200 exist, here are 50".
      // Asserted as an observed fact; see the report for why it is a gap.
      const defaultPage = await getJson(relay, '/v1/tasks', reader.token);
      assert.equal(defaultPage.json.tasks.length, 50, 'documented default limit changed');
      assert.ok(!('total' in defaultPage.json) && !('has_more' in defaultPage.json),
        'pagination metadata appeared; update this boundary assertion');
    });
  });
});

/* ------------------------------------------------------------------ */
/* 2. duplicate suppression                                            */
/* ------------------------------------------------------------------ */

describe('stress / duplicate suppression', () => {
  it('24 concurrent redeliveries of one instance are recorded exactly once', async () => {
    const REDELIVERIES = 24;
    await withRelay({}, async (relay) => {
      const device = await pairDevice(relay, 'dup-1');

      const created = (await postTask(relay, taskBody())).json;
      // `createTask` returns a SUMMARY; the leases/anchors live on the record.
      assert.deepEqual(Object.keys(created).sort(), ['leases', 'seq', 'task_id']);
      const task = relay.state.getTask(created.task_id);
      assert.ok(task, 'the full task record is not reachable via getTask');

      const envelope = envelopeFor(task, 'dup-1');
      const bodies = Array.from({ length: REDELIVERIES }, () => envelope);

      const responses = await Promise.all(bodies.map((b) => postResult(relay, device.token, b)));
      assert.equal(responses.filter((r) => r.status === 200).length, REDELIVERIES,
        `a redelivery was rejected: ${responses.map((r) => r.status).join(',')}`);

      // The HTTP answers alone are not the proof — the ledger is.
      const stored = responses.filter((r) => r.json?.deduped === false);
      const deduped = responses.filter((r) => r.json?.deduped === true);
      assert.equal(stored.length, 1, `${stored.length} concurrent redeliveries were stored, expected 1`);
      assert.equal(deduped.length, REDELIVERIES - 1, 'a redelivery was not recognised as a duplicate');
      assert.equal(stored[0].json.seq, deduped[0].json.seq, 'the duplicate reports a different seq');

      assert.equal(relay.state.results.size, 1, 'the relay recorded more than one result row');
      assert.equal(relay.state.stats().results, 1);
      assert.equal(relay.state.taskResults(created.task_id).size, 1, 'the task holds more than one result');
      assert.equal(task.result_seqs.length, 1, 'the task ledger appended more than one result seq');

      const dedupeIndex = relay.state.dedupeReport();
      assert.deepEqual(Object.keys(dedupeIndex), [envelope.dedupe_key], 'dedupe index lost the key');
      assert.equal(dedupeIndex[envelope.dedupe_key].length, 1, 'dedupe index holds more than one instance');

      // The stored envelope was complete and its hash verified — a dedupe that
      // "works" by storing garbage would still be a defect.
      const record = [...relay.state.results.values()][0];
      assert.deepEqual(record.validation.missing, [], 'the stored envelope is missing required fields');
      assert.deepEqual(record.validation.problems, []);
      assert.equal(record.validation.envelope_sha256_ok, true, 'the stored envelope hash did not verify');
      assert.equal(record.effective_status, 'ok');

      // §4.4 boundary: the idempotency key is the TRIPLE, so a later attempt is
      // a new instance rather than a duplicate. Asserting this stops a future
      // "dedupe on dedupe_key alone" change from silently dropping retries.
      const second = await postResult(relay, device.token, buildEnvelope({ ...envelope, attempt: 2 }));
      assert.equal(second.json.deduped, false, 'a new attempt was swallowed as a duplicate');
      assert.equal(relay.state.results.size, 2, 'the new attempt was not recorded');
    });
  });
});

/* ------------------------------------------------------------------ */
/* 3. many devices, their leases, and the aggregate verdict            */
/* ------------------------------------------------------------------ */

describe('stress / 50 devices with leases', () => {
  it('no lease is lost and split indices follow i % index_total', async () => {
    const DEVICES = 50;
    const INDEX_TOTAL = 7;
    const names = Array.from({ length: DEVICES }, (_, i) => `dev-${String(i).padStart(2, '0')}`);

    // The default pairing budget is 5/min/IP and the whole fleet shares
    // 127.0.0.1, so the limiter is switched off here and exercised on its own in
    // the burst suite below. Same reasoning as test/crossnetwork.test.mjs:540.
    await withRelay({ pairingCodeReusable: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      await pairFleet(relay, names);
      assert.equal(relay.state.devices.size, DEVICES, 'a device failed to pair');

      // --- replicate: every machine gets index 0 / index_total 1 (§4.2) ---
      const replicate = (await postTask(relay, taskBody())).json;
      const replicateTask = relay.state.getTask(replicate.task_id);
      assert.equal(replicate.leases.length, DEVICES, 'createTask summary lost a lease');
      // PROTOCOL.md §4.1.1 documents the create response as `"state":"queued"`,
      // but the relay has already emitted each lease's offer (state.mjs
      // `emitOffer`) by the time it answers, so the wire value is `offered`.
      assert.ok(replicate.leases.every((l) => l.state === 'offered'),
        `create response states: ${replicate.leases.map((l) => l.state).join(',')}`);
      assert.equal(replicateTask.leases.size, DEVICES, 'a lease was lost on the full record');
      assert.deepEqual(
        new Set(replicateTask.leases.keys()),
        new Set(relay.state.devices.keys()),
        'the lease set and the device set disagree — a machine was left out',
      );
      for (const lease of replicateTask.leases.values()) {
        assert.equal(lease.index, 0, 'replicate must pin every machine to index 0');
        // Dispatch emits an offer per target, so the state right after create is
        // `offered` (state.mjs `emitOffer`), not the `queued` placeholder that
        // PROTOCOL.md §4.1.1 shows in the create response. Both are active.
        assert.ok(ACTIVE_LEASE_STATES.includes(lease.state),
          `lease state ${lease.state} is not an active state`);
        assert.equal(lease.state, 'offered', `unexpected post-dispatch lease state ${lease.state}`);
      }

      // --- split: index = i % index_total, i = position in the relay's device order ---
      const split = (await postTask(relay, taskBody({ mode: 'split', index_total: INDEX_TOTAL }))).json;
      const splitTask = relay.state.getTask(split.task_id);
      assert.equal(splitTask.leases.size, DEVICES, 'a split lease was lost');
      assert.deepEqual(
        new Set(splitTask.leases.keys()),
        new Set(relay.state.devices.keys()),
        'split left a device without a lease',
      );

      const order = [...relay.state.devices.keys()];
      const expectedIndex = new Map(order.map((id, i) => [id, i % INDEX_TOTAL]));
      for (const [machineId, lease] of splitTask.leases) {
        assert.equal(lease.index, expectedIndex.get(machineId),
          `${machineId} got index ${lease.index}, contract says ${expectedIndex.get(machineId)}`);
      }

      // The distribution is order-independent: 50 items over 7 shards is 8/7/7/7/7/7/7.
      const histogram = new Array(INDEX_TOTAL).fill(0);
      for (const lease of splitTask.leases.values()) histogram[lease.index] += 1;
      assert.equal(histogram.reduce((a, b) => a + b, 0), DEVICES, 'indices do not cover every device');
      assert.equal(histogram[0], 8, `shard 0 has ${histogram[0]} devices, expected 8`);
      for (let i = 1; i < INDEX_TOTAL; i += 1) {
        assert.equal(histogram[i], 7, `shard ${i} has ${histogram[i]} devices, expected 7`);
      }

      // Every shard is claimed by at least one machine: no shard is unassigned.
      assert.equal(histogram.filter((n) => n === 0).length, 0, 'a shard has no machine assigned');
    });
  });

  it('aggregate() over 50 reporting machines terminates with a legal verdict', async () => {
    const DEVICES = 50;
    const names = Array.from({ length: DEVICES }, (_, i) => `agg-${String(i).padStart(2, '0')}`);

    // The default pairing budget is 5/min/IP and the whole fleet shares
    // 127.0.0.1, so the limiter is switched off here and exercised on its own in
    // the burst suite below. Same reasoning as test/crossnetwork.test.mjs:540.
    await withRelay({ pairingCodeReusable: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      const tokens = await pairFleet(relay, names);

      // `replicate`: one command, every machine, index 0 — the mode whose whole
      // point is that the machines are comparable. (`split` is covered by its
      // own case below, where the comparison is not meaningful by design.)
      const created = (await postTask(relay, taskBody())).json;
      const task = relay.state.getTask(created.task_id);

      // Nobody has reported yet: the aggregate must still answer, bounded.
      const before = Date.now();
      const pending = aggregateTask(relay.state, task.task_id);
      const pendingMs = Date.now() - before;
      assert.ok(AGGREGATE_STATUSES.includes(pending.status), `illegal verdict ${pending.status}`);
      assert.equal(pending.status, 'pending', 'a task with no results and a future deadline is not pending');
      assert.equal(pending.machines.length, DEVICES, 'aggregate dropped machines that have not reported');
      assert.ok(pendingMs < 5000, `aggregate took ${pendingMs}ms on an empty set`);

      // All 50 report identical, anchor-matching envelopes.
      const envelopes = [...task.leases.values()].map((lease) => envelopeFor(task, lease.machine_id));
      const submitted = await Promise.all(
        envelopes.map((e) => postResult(relay, tokens.get(e.machine_id), e)),
      );
      assert.equal(submitted.filter((r) => r.status === 200).length, DEVICES, 'a result submission failed');
      assert.ok(submitted.every((r) => r.json.deduped === false), 'two machines shared a dedupe instance');
      assert.equal(relay.state.results.size, DEVICES, 'the relay did not record all 50 results');

      const started = Date.now();
      const agg = aggregateTask(relay.state, task.task_id);
      const elapsed = Date.now() - started;

      assert.ok(AGGREGATE_STATUSES.includes(agg.status), `verdict ${agg.status} is not in AGGREGATE_STATUSES`);
      assert.equal(agg.status, 'consistent', `expected consistent, got ${agg.status}: ${JSON.stringify(agg.notes)}`);
      assert.ok(elapsed < 5000, `aggregate took ${elapsed}ms over ${DEVICES} machines`);
      assert.equal(agg.machines.length, DEVICES, 'aggregate dropped a machine — a lease was effectively lost');
      assert.equal(agg.steps.length, 4, 'the four-step contract was not walked');
      assert.equal(agg.steps[0].passed.length, DEVICES, 'Step 0 did not pass every machine');
      assert.equal(agg.steps[1].passed.length, DEVICES, 'Step 1 anchor check failed a machine');
      assert.equal(agg.steps[2].ok.length, DEVICES, 'Step 2 did not see every machine succeed');
      assert.equal(agg.steps[3].differences.length, 0, 'identical envelopes produced differences');
      assert.equal(agg.steps[3].consistent, true);

      // Control: the verdict is not hard-wired to `consistent`. Ten machines
      // report a non-zero exit and the aggregate must say so.
      const mixedId = (await postTask(relay, taskBody())).json.task_id;
      const mixed = relay.state.getTask(mixedId);
      const mixedEnvelopes = [...mixed.leases.values()].map((lease, i) => envelopeFor(mixed, lease.machine_id, {
        ...(i < 10 ? { status: 'nonzero_exit', exit_code: 1 } : {}),
      }));
      await Promise.all(mixedEnvelopes.map((e) => postResult(relay, tokens.get(e.machine_id), e)));
      const mixedAgg = aggregateTask(relay.state, mixed.task_id);
      assert.ok(AGGREGATE_STATUSES.includes(mixedAgg.status));
      assert.equal(mixedAgg.status, 'degraded', `10/50 failures produced ${mixedAgg.status}`);
      assert.equal(mixedAgg.steps[2].failed.length, 10);
      assert.equal(mixedAgg.steps[2].ok.length, 40);
    });
  });

  // ------------------------------------------------------------------
  // FIXED (was a recorded defect until report.mjs grouped Step 3 by shard)
  //
  // A `split` task hands each machine its own slice by index (state.mjs:1023, and
  // the tool contract says so: tools.mjs:1691 "use mode=split with index_total>1 to
  // hand each machine a slice"). `index` is nevertheless in COMPARABLE_FIELDS
  // (state.mjs:66-72) and Step 3 used to flag any differing comparable field, so a
  // split task that succeeded on every machine was reported `divergent` -- which
  // README.md:74 defines as "machines disagreed". Every successful fan-out raised a
  // false alarm.
  //
  // The fix compares within a shard rather than across the whole task. This test
  // asserted the needed behaviour while `todo`, and now passes for real; it is a
  // regression guard from here on.
  // ------------------------------------------------------------------
  it('a fully successful split is not reported the same way as a real disagreement', async () => {
    const DEVICES = 6;
    const INDEX_TOTAL = 3;
    const names = Array.from({ length: DEVICES }, (_, i) => `shard-${i}`);

    await withRelay({ pairingCodeReusable: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      const tokens = await pairFleet(relay, names);
      const created = (await postTask(relay, taskBody({ mode: 'split', index_total: INDEX_TOTAL }))).json;
      const task = relay.state.getTask(created.task_id);

      const envelopes = [...task.leases.values()].map((lease) => envelopeFor(task, lease.machine_id, {
        index: lease.index,
        index_total: INDEX_TOTAL,
        mode: 'split',
      }));
      await Promise.all(envelopes.map((e) => postResult(relay, tokens.get(e.machine_id), e)));
      const agg = aggregateTask(relay.state, task.task_id);

      assert.ok(AGGREGATE_STATUSES.includes(agg.status));
      assert.equal(agg.steps[2].failed.length, 0, 'every machine must have succeeded');
      assert.equal(agg.steps[2].ok.length, DEVICES);
      // The defect was that the only thing the machines "disagreed" about was which slice each was
      // told to run -- a difference the mode creates on purpose. Step 3 now compares within a shard,
      // so a successful fan-out has no differences at all. `index` is still collected per machine in
      // `step3.comparable`; it is simply not evidence of disagreement.
      assert.deepEqual(agg.steps[3].differences.map((d) => d.field), [],
        `unexpected difference set: ${JSON.stringify(agg.steps[3].differences.map((d) => d.field))}`);
      assert.equal(
        agg.steps[3].comparable.index ? Object.keys(agg.steps[3].comparable.index).length : 0,
        DEVICES,
        'the per-machine index must still be reported, even though it is not a difference',
      );

      // Independent check that shard grouping is sufficient: compared WITHIN a shard — the only
      // comparison `split` makes sense for — the machines agree on every comparable field. If this
      // ever fails, the fix in report.mjs is incomplete rather than merely mistuned.
      //
      // Driven from `step3.comparable`, not from raw envelopes: `aggregateTask` returns a projection
      // of machines that deliberately omits the envelopes, so reaching for `m.envelope` reads
      // `undefined` — which is exactly what the first version of this check did.
      const groups = new Map();
      for (const m of agg.machines) groups.set(m.index, [...(groups.get(m.index) ?? []), m.machine_id]);
      for (const field of COMPARABLE_FIELDS) {
        const perMachine = agg.steps[3].comparable[field] ?? {};
        for (const [shard, ids] of groups) {
          const values = ids.filter((id) => id in perMachine).map((id) => jcs(perMachine[id]));
          if (values.length < 2) continue;
          assert.ok(values.every((v) => v === values[0]),
            `shard ${shard} disagrees on ${field}: ${values.join(', ')}`);
        }
      }

      assert.equal(agg.status, 'consistent',
        `a successful split reported as ${agg.status}; a shard index is not a result disagreement`);
    });
  });
});

/* ------------------------------------------------------------------ */
/* 4. rate limiter under a burst                                       */
/* ------------------------------------------------------------------ */

describe('stress / rate limiter burst', () => {
  it('a burst past the limit is refused and counted, so it cannot look like success', async () => {
    const LIMIT = 3;
    const BURST = 12;

    await withRelay({ pairingCodeReusable: true, pairRateLimitPerMinute: LIMIT }, async (relay) => {
      // One reusable code for the whole burst: with rotation on, a successful
      // pairing would retire the other codes and the refusal count would be
      // measuring the wrong mechanism.
      const code = relay.state.createPairingCode();
      const ids = Array.from({ length: BURST }, (_, i) => `burst-${i}`);

      const responses = await Promise.all(ids.map((id) => pairRequest(relay, id, code)));

      const ok = responses.filter((r) => r.status === 200);
      const refused = responses.filter((r) => r.status === 429);

      // (a) exactly the limit got through
      assert.equal(ok.length, LIMIT, `${ok.length} pairings got through a limit of ${LIMIT}`);
      assert.equal(refused.length, BURST - LIMIT, 'the burst was not refused past the limit');

      // (b) no silent drop and no crash: every attempt has an accounted status
      assert.equal(ok.length + refused.length, BURST,
        `unaccounted statuses: ${responses.map((r) => r.status).join(',')}`);
      assert.equal(responses.filter((r) => r.status >= 500).length, 0, 'the burst produced a 5xx');

      // (c) each refusal is a first-class, countable answer with the §6 fields
      for (const r of refused) {
        assert.equal(r.json?.error?.code, 'RATE_LIMITED', `refusal body was ${r.text}`);
        assert.ok(Number.isInteger(r.json?.retry_after_seconds) && r.json.retry_after_seconds >= 1,
          'a refusal did not carry retry_after_seconds');
        assert.equal(r.json?.error?.detail?.retry_after_seconds, r.json.retry_after_seconds,
          'the two documented retry_after_seconds locations disagree');
        assert.equal(r.json?.error?.detail?.scope, 'pair');
        assert.equal(r.headers['retry-after'], String(r.json.retry_after_seconds));
      }

      // (d) relay-side ground truth: only the admitted attempts were recorded,
      // so the refusal count and the success count cannot drift apart.
      assert.equal(relay.state.devices.size, LIMIT, 'the relay paired more devices than the limit allows');
      assert.equal(relay.state.stats().devices, LIMIT);
      const buckets = [...relay.pairLimiter.buckets.values()];
      assert.equal(buckets.length, 1, 'the burst should share one client-IP bucket');
      assert.equal(buckets[0].length, LIMIT, 'the limiter recorded refused attempts as admitted');

      // (e) the relay is still serving after the burst
      const health = await getJson(relay, '/healthz');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(health.json.pair_rate_limit, LIMIT);
      assert.equal(health.json.devices, LIMIT);
    });
  });

  it('failed pairing attempts consume the same budget (a burst of failures cannot look like success)', async () => {
    const LIMIT = 3;

    await withRelay({ pairingCodeReusable: true, pairRateLimitPerMinute: LIMIT }, async (relay) => {
      // A valid code that nobody will use until the budget is already spent.
      const validCode = relay.state.createPairingCode();

      const failures = await Promise.all(
        Array.from({ length: LIMIT }, (_, i) => pairRequest(relay, `bad-${i}`, `PAIR-BOGUS${i}`)),
      );

      // The bad attempts got past the limiter (so they were counted) and then
      // failed on the code itself — they are not 429s yet.
      assert.equal(failures.filter((r) => r.status === 429).length, 0,
        'the first attempts were rate-limited before the budget was spent');
      assert.ok(
        failures.every((r) => r.json?.error?.code === 'PAIRING_INVALID'),
        `expected PAIRING_INVALID, got ${failures.map((r) => r.json?.error?.code).join(',')}`,
      );

      // Now the budget is gone: a VALID code is refused anyway.
      const after = await pairRequest(relay, 'late-1', validCode);
      assert.equal(after.status, 429, 'failed attempts did not consume the rate-limit budget');
      assert.equal(after.json?.error?.code, 'RATE_LIMITED');
      assert.equal(relay.state.devices.size, 0, 'a refused pairing created a device');
    });
  });

  it('control: the same burst with the limiter disabled produces no refusals', async () => {
    const BURST = 12;

    await withRelay({ pairingCodeReusable: true, pairRateLimitPerMinute: 0 }, async (relay) => {
      const code = relay.state.createPairingCode();
      const ids = Array.from({ length: BURST }, (_, i) => `open-${i}`);
      const responses = await Promise.all(ids.map((id) => pairRequest(relay, id, code)));

      // Proves the 429s in the limited run came from the limiter and not from
      // the request shape, the socket layer, or an unrelated relay error.
      assert.equal(responses.filter((r) => r.status === 429).length, 0,
        'the limiter refused requests while disabled');
      assert.equal(responses.filter((r) => r.status === 200).length, BURST);
      assert.equal(relay.state.devices.size, BURST);
    });
  });

  it('documented onboarding contract: consuming a code mints the next and retires the old', async () => {
    await withRelay({}, async (relay) => {
      const first = relay.state.createPairingCode();

      const used = await pairRequest(relay, 'seq-1', first);
      assert.equal(used.status, 200, `first pairing failed: ${used.text}`);
      const next = used.json.next_pairing_code;
      assert.ok(typeof next === 'string' && next.length > 0 && next !== first,
        'a successful pairing must hand back a fresh code (PROTOCOL.md §2.2)');
      assert.ok(relay.state.pairingCodes.has(next) && relay.state.pairingCodes.get(next).used === false,
        'the advertised next code is not actually live');

      // The retired code is dead, and the advertised one works. This is the
      // documented human flow: pair A, then pair B with the code A handed back.
      const reuse = await pairRequest(relay, 'seq-2', first);
      assert.equal(reuse.status, 400, 'a consumed pairing code still paired a machine');
      assert.equal(reuse.json?.error?.code, 'PAIRING_INVALID');

      const second = await pairRequest(relay, 'seq-2', next);
      assert.equal(second.status, 200, `second pairing failed: ${second.text}`);
      assert.equal(relay.state.devices.size, 2);
    });
  });
});
