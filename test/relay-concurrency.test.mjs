/**
 * Relay concurrency matrix: workstream F3 of `docs/REFACTOR-P2-PLAN.md` §1.
 *
 * The relay's lease/settlement logic is timing-sensitive by construction — heartbeats
 * renew a lease window, a sweep expires it, a takeover re-offers the freed index — and
 * the production paths are only otherwise exercised by suites that sleep. This file
 * makes every scenario **deterministic**:
 *
 *   * the clock is injected (`new RabbitState({ now: clock.now, ... })`), so "exactly
 *     at the grace boundary" is a number, not a race;
 *   * expiry is driven by `relay.sweep()` (`RelayServer#sweep` → `state.sweepExpired()`)
 *     instead of by the background interval;
 *   * persistence is an in-memory ledger with the same methods `Persistence` exposes,
 *     so a "relay restart" replays exactly the rows a restart would replay, with no
 *     disk I/O.
 *
 * The construction mirrors the real one: `createRelayServer({ state, persist: false })`
 * with an injected `RabbitState`, exactly as `src/relay/server.mjs` accepts
 * (`options.state`). One unavoidable detail is documented at `openRelay()`: the server
 * always adopts its own `Persistence` and hands it to the injected state
 * (`server.mjs`: `this.state.setPersistence(this.persistence)`); with `persist: false`
 * that object is disabled, so the in-memory ledger is re-attached for the scenario.
 *
 * Scenario matrix (and what each row asserts):
 *
 * | scenario                                  | asserted outcome                                              |
 * |-------------------------------------------|---------------------------------------------------------------|
 * | heartbeat at the exact grace boundary     | renewed; the same-clock sweep then expires nothing            |
 * | sweep at the boundary first               | expired + `task.degraded='partial'`; halt=never late re-claim  |
 * | halt=now takeover, owner races successor  | exactly one running lease for the new attempt; old owner gets `LEASE_EXPIRED_TAKEN_OVER` |
 * | takeover of a writing task                | `LEASE_TAKEOVER_REFUSED` / `write_not_idempotent`; no re-offer  |
 * | restart mid-task (running lease)          | task/lease replayed; result dedupe index survives; no silent loss |
 * | restart with an unstarted lease           | offer journal lost ⇒ R8: no re-offer with an unknown command  |
 * | duplicate offer re-delivery               | same `(task_id, attempt, dedupe_key)` identity, at-least-once  |
 * | duplicate result delivery                 | `deduped:true`, same seq, one stored record                   |
 *
 * Everything asserted here is the *current* contract, quoted from the source comments
 * where the behaviour is deliberate (e.g. the `halt=never` late re-claim and the R8
 * offer-journal rule). No product code is modified by this suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRelayServer } from '../src/relay/server.mjs';
import { RabbitState, computeDedupeKey, rfc3339 } from '../src/relay/state.mjs';

const OP = 'p2-concurrency-operator-token';
const T0 = Date.parse('2026-11-19T00:00:00Z');

/** Deterministic millisecond clock; every value the relay reads comes from here. */
function makeClock(start = T0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; return value; },
    set: (ms) => { value = ms; return value; },
  };
}

/**
 * In-memory `Persistence` for the `RabbitState` seam.
 *
 * Only the members the state/server startup path calls are implemented, and the row
 * shapes match `src/relay/persistence.mjs` (`saveDevices` field list, ledger `ts`
 * prefix). `dir` stays undefined on purpose: the offer journal lives on disk next to
 * the ledger, so a memory-only persistence is exactly the documented "journal lost on
 * restart" case asserted below.
 */
function memoryPersistence({ now = () => Date.now() } = {}) {
  const file = { devices: {}, ledger: [], warnings: [] };
  return {
    enabled: true,
    dir: undefined,
    devicesMissing: false,
    append(entry) {
      file.ledger.push({ ts: rfc3339(now()), ...entry });
      return true;
    },
    saveDevices(devices) {
      const out = {};
      const iterable = devices instanceof Map ? devices.values() : Object.values(devices ?? {});
      for (const device of iterable) {
        out[device.machine_id] = {
          machine_name: device.machine_name ?? device.machine_id,
          platform: device.platform ?? {},
          caps: device.caps ?? {},
          user_id: device.user_id ?? null,
          device_token: device.device_token ?? null,
          paired_at: rfc3339(device.paired_at_ms ?? now()),
          re_paired: device.re_paired === true,
          fleet_id: device.fleet_id ?? null,
          fleet_source: device.fleet_source ?? null,
        };
      }
      file.devices = out;
      return true;
    },
    loadDevices() { return { devices: file.devices, corrupt: false, missing: false }; },
    loadLedger() { return file.ledger.map((entry) => ({ ...entry })); },
    loadClusterLedger() { return []; },
    warn(message) { file.warnings.push(String(message)); },
    noteAppendSuccess() { return true; },
    noteAppendFailure() { return false; },
    /** Test-only: the rows a restart would replay. */
    rows() { return file.ledger; },
    warnings() { return file.warnings; },
  };
}

/** Options that make the boundary arithmetic in this suite obvious: 2 missed beats + 500 ms grace = 2500 ms. */
const STATE_OPTIONS = Object.freeze({
  heartbeatIntervalMs: 1_000,
  missedHeartbeats: 2,
  leaseGraceMs: 500,
  // Well above the advances used here: presence is a different clock in these scenarios.
  silenceMs: 10 * 60_000,
});

/** Start a relay with an injected state + clock, and attach the in-memory persistence before any write. */
function openRelay({ clock = makeClock(), persistence = memoryPersistence({ now: clock.now }) } = {}) {
  const state = new RabbitState({ now: clock.now, ...STATE_OPTIONS });
  const relay = createRelayServer({ state, persist: false, logger: null, operatorToken: OP });
  // The server adopts its own Persistence and calls `state.setPersistence` on the injected
  // state (`src/relay/server.mjs`). With persist:false that backend is disabled, so the
  // scenario's in-memory ledger is attached afterwards — same seam, same way.
  state.setPersistence(persistence);
  return { relay, state, clock, persistence };
}

/**
 * Restart the relay the way `RelayServer`'s §7 startup recovery does it: fresh state,
 * then `state.restore({devices, ledger})`. Mirrors `src/relay/server.mjs`'s
 * `if (this.persistence.enabled) { ... this.state.restore(...) }` block.
 */
function restartRelay({ clock, persistence }) {
  const reopened = openRelay({ clock, persistence });
  const snapshot = persistence.loadDevices();
  persistence.devicesMissing = snapshot.missing;
  const ledger = persistence.loadLedger();
  const imported = persistence.loadClusterLedger().map((record) => record.entry);
  const mergedLedger = imported.length === 0 ? ledger : [...ledger, ...imported];
  const revived = reopened.state.restore({ devices: snapshot.devices, ledger: mergedLedger });
  return { ...reopened, revived };
}

/** Pair one machine and mark it online, as the real `/v1/pair` path results in. */
function pairMachine(state, machineId, caps = { write: true }) {
  const code = state.createPairingCode({ ttlMs: 60_000 });
  const paired = state.pair({
    pairing_code: code,
    machine_id: machineId,
    machine_name: machineId,
    platform: { os: 'windows', arch: 'x64' },
    caps,
  });
  state.setOnline(machineId, true);
  return paired;
}

function createTask(state, targetMachines, overrides = {}) {
  const created = state.createTask({
    mode: 'replicate',
    command_argv: ['node', '--test'],
    cwd_rel: '.',
    index_total: 1,
    timeout_ms: 300_000,
    write: false,
    base_tree: 'tree-abc',
    halt: 'never',
    target_machines: targetMachines,
    ...overrides,
  });
  const task = state.getTask(created.task_id);
  assert.ok(task !== null, `createTask returned ${JSON.stringify(created)} but the task is not stored`);
  return { created, task };
}

const leaseOf = (task, machineId) => {
  const lease = task.leases.get(machineId);
  assert.ok(lease !== undefined, `expected a lease for ${machineId} on task ${task.task_id}`);
  return lease;
};

const notices = (state) => state.eventsSince(0).filter((event) => event.type === 'notice');
const offersFor = (state, taskId) => state.eventsSince(0)
  .filter((event) => event.type === 'task.offer' && event.task_id === taskId);

/** A §5.1 envelope whose fields all name the task's own facts, so it validates as `ok`. */
function resultEnvelope(task, machineId, attempt = 1) {
  const lease = leaseOf(task, machineId);
  return {
    envelope_version: '1',
    task_id: task.task_id,
    attempt,
    dedupe_key: lease.dedupe_key,
    machine_id: machineId,
    machine_name: machineId,
    platform: { os: 'windows', arch: 'x64' },
    caps: { write: true },
    index: 0,
    index_total: task.index_total,
    mode: task.mode,
    cwd_rel: task.cwd_rel,
    base_commit: task.base_commit,
    base_tree: task.base_tree,
    pre_tree_fingerprint: null,
    post_tree_fingerprint: null,
    fingerprint_algo: 'sha256-v1',
    fingerprint_error: null,
    head_commit: null,
    dirty_before: null,
    command_argv: task.command_argv,
    command_hash: task.command_hash,
    shell_id: 'direct-exec',
    started_at: rfc3339(T0),
    ended_at: rfc3339(T0 + 120),
    duration_ms: 120,
    exit_code: 0,
    status: 'ok',
    refusal_reason: null,
    stdout_sha256: '0'.repeat(64),
    stdout_bytes: 0,
    stderr_sha256: '0'.repeat(64),
    stderr_bytes: 0,
    warnings: [],
    envelope_sha256: null,
  };
}

/* ================================================================== */
/* heartbeat vs expiry at the grace boundary                           */
/* ================================================================== */

describe('relay-concurrency: heartbeat vs expiry at the boundary', () => {
  it('renews at the exact boundary, and a same-clock sweep then expires nothing', async () => {
    const { relay, state, clock } = openRelay();
    try {
      pairMachine(state, 'mac-a');
      const { task } = createTask(state, ['mac-a']);
      const lease = leaseOf(task, 'mac-a');
      const windowMs = state.leaseWindowMs();
      assert.equal(lease.state, 'offered');
      assert.equal(lease.lease_until_ms, lease.last_heartbeat_ms + windowMs, 'the lease window is the injected 2×1000 + 500 ms');

      // "Exactly at the grace boundary": `isLeaseExpired` uses `now >= lease_until_ms`,
      // so this instant is the last possible moment a renewal can win.
      const boundary = lease.lease_until_ms;
      clock.set(boundary);
      const renewed = state.heartbeat({ task_id: task.task_id, machine_id: 'mac-a' });
      assert.equal(renewed.cancel, false, `expected a renewal, got ${JSON.stringify(renewed)}`);
      assert.equal(renewed.lease_until, rfc3339(boundary + windowMs), 'the renewal must restart the whole window');
      assert.equal(lease.state, 'running', 'a lease heartbeat moves offered → running');
      assert.equal(lease.last_heartbeat_ms, boundary);

      const expired = state.sweepExpired();
      assert.deepEqual(
        expired.map((entry) => entry.lease.machine_id),
        [],
        'a lease renewed at the boundary must not be expired by a sweep at the same clock',
      );
      assert.equal(lease.state, 'running');
    } finally {
      await relay.close();
    }
  });

  it('a sweep at the boundary first expires it; halt=never lets the live owner re-claim', async () => {
    const { relay, state, clock } = openRelay();
    try {
      pairMachine(state, 'mac-a');
      const { task } = createTask(state, ['mac-a']);
      const lease = leaseOf(task, 'mac-a');
      clock.set(lease.lease_until_ms);

      const expired = state.sweepExpired();
      assert.deepEqual(
        expired.map((entry) => [entry.task.task_id, entry.lease.machine_id]),
        [[task.task_id, 'mac-a']],
        'a sweep at the boundary must expire the lease (`isLeaseExpired` is now >= lease_until)',
      );
      assert.equal(lease.state, 'expired');
      assert.equal(task.degraded, 'partial', 'halt=never expiry is book-keeping: the task is marked partial');

      // Documented rule (src/relay/state/leases.mjs, `leaseHeartbeat`): "A live heartbeat is
      // stronger evidence than a timer: with halt=never nobody took the work away, so the
      // late-but-alive agent re-claims its own lease." (expired → running with expired_at null)
      const late = state.heartbeat({ task_id: task.task_id, machine_id: 'mac-a' });
      assert.equal(late.cancel, false, `a halt=never late heartbeat re-claims rather than cancelling: ${JSON.stringify(late)}`);
      assert.equal(lease.state, 'running');
      assert.equal(lease.expired_at_ms, null);
    } finally {
      await relay.close();
    }
  });
});

/* ================================================================== */
/* lease takeover                                                      */
/* ================================================================== */

describe('relay-concurrency: lease takeover', () => {
  it('halt=now: exactly one running lease for the new attempt; the old owner is refused by name', async () => {
    const { relay, state, clock } = openRelay();
    try {
      pairMachine(state, 'mac-a');
      pairMachine(state, 'mac-b');
      const { task } = createTask(state, ['mac-a'], { halt: 'now' });
      const oldLease = leaseOf(task, 'mac-a');
      const boundary = oldLease.lease_until_ms;

      clock.set(boundary);
      const expired = state.sweepExpired();
      assert.equal(expired.length, 1, 'the expired lease must be written off exactly once');
      assert.equal(task.attempt, 2, 'halt=now advances the attempt before re-offering');
      const codes = notices(state).map((notice) => notice.code);
      assert.ok(codes.includes('LEASE_EXPIRED'), `expected a LEASE_EXPIRED notice, got ${JSON.stringify(codes)}`);
      assert.ok(codes.includes('LEASE_TAKEOVER'), `expected a LEASE_TAKEOVER notice, got ${JSON.stringify(codes)}`);

      const successor = leaseOf(task, 'mac-b');
      assert.equal(successor.state, 'offered');
      assert.equal(successor.attempt, 2);
      assert.equal(
        successor.dedupe_key,
        computeDedupeKey(task.task_id, 0, task.command_hash, task.base_tree),
        'the successor carries the §4.4 dedupe key for the same index',
      );

      // The race, at one fixed instant: the expired owner's late heartbeat vs the successor's
      // acceptance heartbeat. The loser's refusal is a named value, not an error.
      const loser = state.heartbeat({ task_id: task.task_id, machine_id: 'mac-a' });
      assert.equal(loser.cancel, true, `the expired owner must be told to stop: ${JSON.stringify(loser)}`);
      assert.equal(loser.reason, 'LEASE_EXPIRED_TAKEN_OVER');
      const winner = state.heartbeat({ task_id: task.task_id, machine_id: 'mac-b' });
      assert.equal(winner.cancel, false, `the successor must acquire the lease: ${JSON.stringify(winner)}`);

      assert.equal(oldLease.state, 'expired', 'the loser must not be resurrected by a late heartbeat');
      assert.equal(successor.state, 'running');
      const runningForCurrentAttempt = [...task.leases.values()]
        .filter((lease) => lease.attempt === task.attempt && lease.state === 'running');
      assert.deepEqual(
        runningForCurrentAttempt.map((lease) => lease.machine_id),
        ['mac-b'],
        'exactly one machine may hold the current attempt of the index',
      );
    } finally {
      await relay.close();
    }
  });

  it('refuses to take over a writing task and never re-offers it', async () => {
    const { relay, state, clock } = openRelay();
    try {
      pairMachine(state, 'mac-a', { write: true });
      pairMachine(state, 'mac-b', { write: true });
      const { task } = createTask(state, ['mac-a'], { halt: 'now', write: true });
      const lease = leaseOf(task, 'mac-a');
      const offersBefore = offersFor(state, task.task_id).length;
      clock.set(lease.lease_until_ms);

      const expired = state.sweepExpired();
      assert.equal(expired.length, 1);
      assert.equal(lease.state, 'expired');
      const refused = notices(state).find((notice) => notice.code === 'LEASE_TAKEOVER_REFUSED');
      assert.ok(refused !== undefined, `expected LEASE_TAKEOVER_REFUSED, got ${JSON.stringify(notices(state).map((n) => n.code))}`);
      assert.equal(refused.reason, 'write_not_idempotent');
      assert.equal(task.leases.has('mac-b'), false, 'a writing task must not be handed to a second machine');
      assert.equal(offersFor(state, task.task_id).length, offersBefore, 'a refused takeover emits no offer');
    } finally {
      await relay.close();
    }
  });
});

/* ================================================================== */
/* relay restart mid-task                                              */
/* ================================================================== */

describe('relay-concurrency: relay restart mid-task', () => {
  it('replays a running lease and its result dedupe index; nothing is silently lost', async () => {
    const clock = makeClock();
    const persistence = memoryPersistence({ now: clock.now });
    const first = openRelay({ clock, persistence });
    let restarted;
    try {
      pairMachine(first.state, 'mac-a');
      const { task } = createTask(first.state, ['mac-a']);
      first.state.heartbeat({ task_id: task.task_id, machine_id: 'mac-a' });
      const lease = leaseOf(task, 'mac-a');
      assert.equal(lease.state, 'running');
      assert.equal(first.persistence.rows().filter((row) => row.type === 'lease.changed').length, 1, 'the running state must be in the ledger');

      restarted = restartRelay({ clock, persistence });
      assert.deepEqual(restarted.revived, { revived_devices: 1, revived_tasks: 1 });

      const recovered = restarted.state.getTask(task.task_id);
      assert.ok(recovered !== null, '§7 startup recovery rebuilds tasks from the ledger (src/relay/state.mjs `restore`: "rebuild the device table, token index, tasks, leases and the result/dedupe index from a devices snapshot + ledger replay")');
      const recoveredLease = leaseOf(recovered, 'mac-a');
      assert.equal(recoveredLease.state, 'running', 'a lease that was running at the restart is replayed as running, not silently expired');
      assert.equal(recoveredLease.dedupe_key, lease.dedupe_key, 'the dedupe identity survives the restart');
      assert.equal(recovered.attempt, 1);

      // A machine that reconnects after the restart can submit its result: the result path
      // does not depend on in-memory state that the restart lost.
      const envelope = resultEnvelope(recovered, 'mac-a');
      const stored = restarted.state.submitResult(envelope);
      assert.equal(stored.deduped, false);
      assert.equal(stored.task_id, task.task_id);
      assert.equal(recoveredLease.state, 'done');
      assert.equal(restarted.state.taskResults(task.task_id).size, 1);

      // §1 idempotent POST /v1/result: the same instance key redelivered after the
      // restart (actually: twice in one process) is deduped with the same seq.
      const again = restarted.state.submitResult(envelope);
      assert.equal(again.deduped, true, 'a duplicate result must be deduped by (machine_id, dedupe_key, attempt)');
      assert.equal(again.seq, stored.seq, 'the dedupe must return the original seq, not a new one');
      assert.equal(restarted.state.taskResults(task.task_id).size, 1, 'the duplicate must not store a second record');
    } finally {
      await first.relay.close();
      if (restarted !== undefined) await restarted.relay.close();
    }
  });

  it('loses the offer journal with a memory-only restart and therefore refuses to re-offer (R8)', async () => {
    const clock = makeClock();
    const persistence = memoryPersistence({ now: clock.now });
    const first = openRelay({ clock, persistence });
    let restarted;
    try {
      pairMachine(first.state, 'mac-a');
      const { task } = createTask(first.state, ['mac-a']);
      assert.equal(leaseOf(task, 'mac-a').state, 'offered', 'the fixture needs an offered-but-unstarted lease');

      restarted = restartRelay({ clock, persistence });
      const recovered = restarted.state.getTask(task.task_id);
      assert.ok(recovered !== null, `restore() must rebuild task ${task.task_id}; tasks=${[...restarted.state.tasks.keys()].join(',')}`);
      const recoveredLease = leaseOf(recovered, 'mac-a');
      assert.equal(recoveredLease.state, 'offered', 'the offered lease survives the restart');
      assert.equal(
        recovered.offer_unavailable,
        true,
        'the command journal lives on disk; a memory-only replay has no argv and must say so',
      );
      // Documented rule (`src/relay/state/leases.mjs` `emitOffer`): "R8: a replayed task
      // without its journal cannot be offered with an unknown command." It expires the
      // lease instead of emitting an offer whose command_argv is empty.
      const offersBefore = offersFor(restarted.state, task.task_id).length;
      const redelivered = restarted.state.redeliverPendingOffers('mac-a');
      assert.equal(redelivered.count, 1, `the pending offer is considered once: ${JSON.stringify(redelivered)}`);
      assert.equal(offersFor(restarted.state, task.task_id).length, offersBefore, 'no offer with an empty command may be emitted');
      assert.equal(recoveredLease.state, 'expired', 'the un-replayable lease is expired rather than executed blind');
    } finally {
      await first.relay.close();
      if (restarted !== undefined) await restarted.relay.close();
    }
  });
});

/* ================================================================== */
/* duplicate offer / result delivery                                   */
/* ================================================================== */

describe('relay-concurrency: duplicate delivery is idempotent', () => {
  it('re-delivering the same pending offer keeps one (task_id, attempt, dedupe_key) identity', async () => {
    const { relay, state } = openRelay();
    try {
      pairMachine(state, 'mac-a');
      const { task } = createTask(state, ['mac-a']);
      const lease = leaseOf(task, 'mac-a');
      const initialOffers = offersFor(state, task.task_id);
      assert.equal(initialOffers.length, 1, 'creation emits one offer');
      const identity = ({ task_id, attempt, dedupe_key }) => ({ task_id, attempt, dedupe_key });

      // Documented (src/relay/state/leases.mjs `redeliverPendingOffers`): "a client that
      // reconnects repeatedly can see the same offer more than once. That is intentional:
      // the agent already de-duplicates by task_id". What must be stable is the identity.
      const first = state.redeliverPendingOffers('mac-a');
      const second = state.redeliverPendingOffers('mac-a');
      assert.deepEqual(first, { count: 1, task_ids: [task.task_id] });
      assert.deepEqual(second, { count: 1, task_ids: [task.task_id] });
      const offers = offersFor(state, task.task_id);
      assert.equal(offers.length, 3, 'one creation offer + two re-deliveries, deliberately at-least-once');
      const expected = identity({ ...offers[0], task_id: task.task_id, attempt: 1, dedupe_key: lease.dedupe_key });
      for (const [index, offer] of offers.entries()) {
        assert.deepEqual(
          identity(offer),
          expected,
          `offer #${index + 1} must be the same work item; got ${JSON.stringify(identity(offer))}`,
        );
      }
      assert.equal(lease.state, 'offered', 're-delivery must not advance the lease state by itself');
      assert.equal(lease.attempt, 1);
    } finally {
      await relay.close();
    }
  });

  it('a duplicate result delivery is deduped with the original seq and stores one record', async () => {
    const { relay, state, clock } = openRelay();
    try {
      pairMachine(state, 'mac-a');
      const { task } = createTask(state, ['mac-a']);
      state.heartbeat({ task_id: task.task_id, machine_id: 'mac-a' });
      const envelope = resultEnvelope(task, 'mac-a');
      const resultsBefore = state.stats().results;

      const first = state.submitResult(envelope);
      assert.equal(first.deduped, false);
      clock.advance(50); // a different instant proves the seq is the identity, not the arrival time
      const duplicate = state.submitResult({ ...envelope });
      assert.equal(duplicate.deduped, true);
      assert.equal(duplicate.task_id, task.task_id);
      assert.equal(duplicate.dedupe_key, envelope.dedupe_key);
      assert.equal(duplicate.seq, first.seq, 'the dedupe must answer with the stored seq');
      assert.equal(state.stats().results, resultsBefore + 1, 'exactly one new result record may exist');
      assert.deepEqual(state.taskResults(task.task_id).get('mac-a').seq, first.seq);
    } finally {
      await relay.close();
    }
  });
});
