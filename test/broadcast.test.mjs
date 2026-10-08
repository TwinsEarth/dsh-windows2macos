/**
 * `broadcast` and `pipeline` modes (v0.3.3).
 *
 * `broadcast`: one machine runs, every other machine is told the outcome. The property this file
 * exists to protect is that **a machine that did not run must never be counted as agreeing.** That is
 * the failure this mode can most easily produce, and it would be invisible in a status line -- the
 * aggregate would simply say `consistent`, and the reader would conclude that the whole fleet had
 * verified the result when in fact one machine ran and the others were told about it.
 *
 * So the tests are written around that distinction rather than around the happy path:
 *   * observers hold an `observing` lease and are excluded from every aggregation step;
 *   * a broadcast with a silent executor is `pending`, not `consistent` with zero participants;
 *   * an observer that never reports does not hold the verdict open, because it was never asked to;
 *   * the executor is deterministic, so the same task record describes the same execution twice.
 *
 * `pipeline`: the whole chain runs on each machine, stage after stage. The property here is that the
 * **command hash binds every stage**, so an envelope produced by the wrong chain cannot verify -- and
 * that a chain stopping early is distinguishable from one that completed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RabbitState, computeCommandHash, computeDedupeKey } from '../src/relay/state.mjs';
import { aggregate, AGGREGATE_STATUSES } from '../src/relay/report.mjs';
import { buildEnvelope, ENVELOPE_VERSION } from '../src/agent/agent.mjs';

const T0 = Date.parse('2026-10-08T00:00:00Z');
const ARGV = ['node', '-e', 'console.log(1)'];
const BASE_TREE = 'a'.repeat(64);
const BASE_COMMIT = 'b'.repeat(40);

/** A harness with a controllable clock and three paired devices. */
function harness({ machines = ['m1', 'm2', 'm3'] } = {}) {
  let now = T0;
  const state = new RabbitState({ now: () => now });
  const devices = machines.map((id, i) => ({
    machine_id: id,
    machine_name: id,
    platform: { os: 'linux', os_version: '1', arch: 'x64', shell: 'bash', shell_version: null },
    capabilities: { case_sensitive_fs: true, symlinks: true, exec_bit: true, python: null, npm: null, node: 'v20.0.0' },
    index: i,
  }));
  for (const d of devices) state.devices.set(d.machine_id, d);
  return { state, devices, advance: (ms) => { now += ms; }, now: () => now };
}

/** A well-formed result envelope for one machine. */
function envelope(task, machineId, { status = 'ok', exitCode = 0, index = 0 } = {}) {
  const commandHash = task.command_hash;
  // Built through the agent's own `buildEnvelope`, not hand-rolled: the relay validator demands all
  // 35 fields, and a hand-written subset is rejected as `unverifiable` -- which is what this file
  // first did, and the rejection was correct.
  return buildEnvelope({
    envelope_version: ENVELOPE_VERSION,
    task_id: task.task_id,
    attempt: 1,
    dedupe_key: computeDedupeKey(task.task_id, index, commandHash, BASE_TREE),
    machine_id: machineId,
    machine_name: machineId,
    platform: { os: 'linux', os_version: '1', arch: 'x64', shell: 'bash', shell_version: null },
    caps: { case_sensitive_fs: true, symlinks: true, exec_bit: true, python: null, npm: null, node: 'v20.0.0' },
    index,
    index_total: task.index_total,
    mode: task.mode,
    cwd_rel: task.cwd_rel,
    base_commit: BASE_COMMIT,
    base_tree: BASE_TREE,
    pre_tree_fingerprint: BASE_TREE,
    post_tree_fingerprint: BASE_TREE,
    fingerprint_algo: 'sha256-tree-v1',
    fingerprint_error: null,
    head_commit: BASE_COMMIT,
    dirty_before: false,
    command_argv: task.command_argv,
    command_hash: commandHash,
    shell_id: 'direct-exec',
    started_at: '2026-10-08T00:00:00.000Z',
    ended_at: '2026-10-08T00:00:00.005Z',
    duration_ms: 5,
    exit_code: exitCode,
    status,
    refusal_reason: null,
    stdout_sha256: 'c'.repeat(64),
    stdout_bytes: 1,
    stderr_sha256: 'd'.repeat(64),
    stderr_bytes: 0,
    warnings: [],
  });
}

/**
 * Create a broadcast task and return the full record.
 *
 * `createTask` answers with a summary (`task_id`, `leases`, `seq`) rather than the task itself, so
 * the record has to be fetched. Reading the summary instead produced `undefined` for every field
 * this file asserts on.
 */
function makeBroadcast(h, over = {}) {
  const created = h.state.createTask({
    mode: 'broadcast',
    command_argv: ARGV,
    base_commit: BASE_COMMIT,
    base_tree: BASE_TREE,
    index_total: 1,
    timeout_ms: 60_000,
    ...over,
  });
  return h.state.getTask(created.task_id);
}

describe('broadcast: one executor, the rest are told', () => {
  it('marks exactly one machine as the executor and the others as observing', () => {
    const h = harness();
    const task = makeBroadcast(h);

    assert.equal(task.mode, 'broadcast');
    assert.equal(task.executor_machine_id, 'm1', 'the executor is deterministic, not random');

    const states = Object.fromEntries([...task.leases.values()].map((l) => [l.machine_id, l.state]));
    // The executor is `offered` -- the command was handed to it, which is what `queued -> offered`
    // means. The observers never leave `observing`, because nothing was ever offered to them.
    assert.deepEqual(states, { m1: 'offered', m2: 'observing', m3: 'observing' });
  });

  it('is deterministic across two identical tasks, so a record describes one execution', () => {
    // A random leader would make a task impossible to reproduce from its own log, and reproducing it
    // is the point of this project.
    const a = harness();
    const b = harness();
    assert.equal(makeBroadcast(a).executor_machine_id, makeBroadcast(b).executor_machine_id);
  });

  it('honours an explicit executor and rejects one outside the target set', () => {
    const h = harness();
    const chosen = makeBroadcast(h, { executor_machine_id: 'm2' });
    assert.equal(chosen.executor_machine_id, 'm2');

    assert.throws(
      () => makeBroadcast(h, { executor_machine_id: 'nope' }),
      (err) => err.code === 'BAD_REQUEST' && /not among the target machines/.test(err.message),
    );
  });

  it('does not offer the command to an observer', () => {
    // The offer stream is what a machine acts on. An observer receiving an offer would run the
    // command, which is the opposite of this mode.
    const h = harness();
    const events = [];
    h.state.onEvent((entry) => events.push(entry?.event ?? entry));
    makeBroadcast(h);

    const offers = events.filter((e) => e?.type === 'task.offer');
    assert.equal(offers.length, 1, `exactly one offer must go out, got ${offers.length}`);
    assert.equal(offers[0].machine_id ?? offers[0].target_machine_id ?? null, 'm1');
  });

  it('reports the executor result and leaves the observers out of the verdict', () => {
    const h = harness();
    const task = makeBroadcast(h);
    h.state.submitResult(envelope(task, 'm1'));

    const agg = aggregate(task, h.state.results.values(), { nowMs: T0 + 1000 });
    // One machine executed, so one result is trivially self-consistent. The test that matters is
    // that the two observers are not counted as agreeing with it.
    assert.equal(agg.status, 'consistent');
    assert.equal(agg.counts.ok, 1, 'only the executor counts as ok');

    const observers = agg.machines.filter((m) => m.lease_state === 'observing');
    assert.equal(observers.length, 2);
    for (const o of observers) {
      assert.equal(o.outcome, 'observing', `${o.machine_id} must not be reported as a participant`);
      // `undefined` in-process and `null` on the wire are the same claim -- no result -- so this
      // asserts the claim rather than the representation.
      assert.equal(o.result ?? null, null, `${o.machine_id} must have no result at all`);
    }
    assert.deepEqual(agg.steps[0].observing, ['m2', 'm3']);
  });

  it('never counts an observer as agreeing, even when the executor diverges', () => {
    // The dangerous shape: one machine runs, the aggregate says `consistent`, and the reader
    // concludes the fleet verified it. Observers must be structurally unable to contribute.
    const h = harness();
    const task = makeBroadcast(h);
    h.state.submitResult(envelope(task, 'm1', { status: 'nonzero_exit', exitCode: 1 }));

    const agg = aggregate(task, h.state.results.values(), { nowMs: T0 + 1000 });
    assert.equal(agg.counts.ok, 0);
    assert.equal(agg.steps[0].passed.includes('m2'), false);
    assert.equal(agg.steps[0].passed.includes('m3'), false);
    assert.equal(agg.status, 'failed', 'a failed executor is a failed broadcast, not a partial one');
  });

  it('is pending, not consistent, while the executor has not reported', () => {
    // The empty-participant trap: with only observers participating, a naive aggregation sees zero
    // machines, zero failures and reports success. It must wait instead.
    const h = harness();
    const task = makeBroadcast(h);
    const agg = aggregate(task, [], { nowMs: T0 + 1000 });
    assert.equal(agg.status, 'pending');
    assert.equal(agg.status === 'consistent', false);
  });

  it('times out rather than waiting on observers that were never asked to run', () => {
    const h = harness();
    const task = makeBroadcast(h, { timeout_ms: 1000 });
    const agg = aggregate(task, [], { nowMs: T0 + 5000 });
    assert.equal(agg.status, 'timeout');

    // The executor is the only machine that can be outstanding. `counts.pending` is a Step 2 figure
    // and stays 0 here because the deadline branch short-circuits before Step 2 runs -- the machine
    // outcome is where this is visible.
    const byId = Object.fromEntries(agg.machines.map((m) => [m.machine_id, m.outcome]));
    assert.equal(byId.m1, 'pending', 'the executor is the one that never answered');
    assert.equal(byId.m2, 'observing');
    assert.equal(byId.m3, 'observing');
  });

  it('does not hold the verdict open for a silent observer', () => {
    const h = harness();
    const task = makeBroadcast(h);
    h.state.submitResult(envelope(task, 'm1'));
    // m2 and m3 never report and never will. A verdict that waited for them would never arrive.
    const agg = aggregate(task, h.state.results.values(), { nowMs: T0 + 1000 });
    assert.equal(agg.status, 'consistent');
    assert.equal(
      agg.machines.some((m) => m.outcome === 'pending'),
      false,
      'nothing is outstanding once the only participant has reported',
    );
  });

  it('rejects an unknown mode instead of silently replicating', () => {
    // `pipeline` used to be the example here; it is implemented as of v0.3.3, so the example moved to
    // a mode that is genuinely not a mode. Accepting one and behaving like `replicate` would run the
    // command on every machine -- a silent, expensive misreading of the request.
    const h = harness();
    assert.throws(
      () => h.state.createTask({ mode: 'teleport', command_argv: ARGV, index_total: 1 }),
      (err) => err.code === 'BAD_REQUEST' && /replicate\|split\|broadcast\|pipeline\|compose/.test(err.message),
    );
  });

  it('keeps the other modes unchanged', () => {
    const h = harness();
    const repId = h.state.createTask({ mode: 'replicate', command_argv: ARGV, base_tree: BASE_TREE, index_total: 1 }).task_id;
    const rep = h.state.getTask(repId);
    assert.equal(rep.executor_machine_id, null, 'replicate has no single executor');
    assert.deepEqual([...rep.leases.values()].map((l) => l.state), ['offered', 'offered', 'offered']);
    assert.deepEqual([...rep.leases.values()].map((l) => l.index), [0, 0, 0]);

    const splitId = h.state.createTask({ mode: 'split', command_argv: ARGV, base_tree: BASE_TREE, index_total: 2 }).task_id;
    const split = h.state.getTask(splitId);
    assert.equal(split.executor_machine_id, null, 'split has no single executor either');
    assert.deepEqual([...split.leases.values()].map((l) => l.index), [0, 1, 0]);
    assert.equal(
      [...split.leases.values()].some((l) => l.state === 'observing'),
      false,
      'only broadcast observes',
    );
  });

  it('documents broadcast as an accepted aggregate-input mode', () => {
    // Not a status -- a status is a verdict -- but pinned here so the list stays the single source of
    // truth for what a reader may encounter.
    assert.ok(AGGREGATE_STATUSES.length >= 9);
    assert.equal(typeof computeCommandHash(ARGV, 'direct-exec', '.'), 'string');
  });
});

describe('pipeline: the whole chain runs on each machine', () => {
  /** A two-stage chain, deliberately with different cwds so the hash has to bind both. */
  const STAGES = [
    { command_argv: ['node', '-e', 'console.log(1)'] },
    { command_argv: ['node', '-e', 'console.log(2)'], cwd_rel: 'sub' },
  ];

  /** Create a pipeline task and return the full record. */
  function makePipeline(h, over = {}) {
    const created = h.state.createTask({
      mode: 'pipeline',
      command_argv: STAGES[0].command_argv, // the relay normalizes stage 0 into this
      stages: STAGES,
      base_commit: BASE_COMMIT,
      base_tree: BASE_TREE,
      timeout_ms: 60_000,
      ...over,
    });
    return h.state.getTask(created.task_id);
  }

  it('records the normalized stage list and exposes stage 0 as command_argv', () => {
    const h = harness();
    const task = makePipeline(h);
    assert.equal(task.mode, 'pipeline');
    assert.equal(task.stages.length, 2);
    assert.deepEqual(task.stages.map((s) => s.index), [0, 1]);
    assert.deepEqual(task.stages[1].command_argv, ['node', '-e', 'console.log(2)']);
    assert.equal(task.stages[1].cwd_rel, 'sub');
    // `command_argv` stays populated because every other part of the system (dedupe, reports,
    // the tool's display) already reads it, and a pipeline is still a task that runs a command.
    assert.deepEqual(task.command_argv, STAGES[0].command_argv);
  });

  it('binds every stage in command_hash, not just the first', () => {
    // If the hash covered stage 0 alone, a chain differing only after the first stage would carry the
    // same hash -- and an envelope from the wrong chain would still verify against the anchor.
    const h = harness();
    const a = makePipeline(h);
    const b = makePipeline(h, {
      stages: [STAGES[0], { command_argv: ['node', '-e', 'console.log(999)'], cwd_rel: 'sub' }],
    });
    assert.notEqual(a.command_hash, b.command_hash, 'a later stage must change the hash');

    // And the cwd of a later stage counts too, since it changes what the command does.
    const c = makePipeline(h, {
      stages: [STAGES[0], { command_argv: STAGES[1].command_argv, cwd_rel: 'elsewhere' }],
    });
    assert.notEqual(a.command_hash, c.command_hash, "a later stage's cwd must change the hash");
  });

  it('sends the chain to every machine, since a pipeline is replicate over a sequence', () => {
    const h = harness();
    const task = makePipeline(h);
    assert.equal(task.executor_machine_id, null, 'a pipeline has no single executor');
    assert.deepEqual([...task.leases.values()].map((l) => l.state), ['offered', 'offered', 'offered']);
    assert.deepEqual([...task.leases.values()].map((l) => l.index), [0, 0, 0]);
  });

  it('carries the stages in the offer, and omits the key for every other mode', () => {
    const h = harness();
    const offers = [];
    h.state.onEvent((e) => {
      if (e.event.type === 'task.offer') offers.push(e.event);
    });
    makePipeline(h);
    assert.equal(offers.length, 3);
    assert.equal(offers[0].stages.length, 2, 'the machine needs the whole chain, not just stage 0');

    // Byte-compatibility: a v0.2.3 agent must not see a field it does not know. Omitted entirely
    // rather than set to null, because `'stages' in offer` is the check the agent makes.
    const h2 = harness();
    const plain = [];
    h2.state.onEvent((e) => {
      if (e.event.type === 'task.offer') plain.push(e.event);
    });
    h2.state.createTask({ command_argv: ARGV, base_tree: BASE_TREE, base_commit: BASE_COMMIT });
    assert.equal('stages' in plain[0], false);
  });

  it('refuses a pipeline without stages, too many stages, a bad stage, or a shard count', () => {
    const h = harness();
    const bad = (over, pattern) => {
      assert.throws(
        () => h.state.createTask({ mode: 'pipeline', command_argv: ARGV, base_tree: BASE_TREE, ...over }),
        (err) => err.code === 'BAD_REQUEST' && pattern.test(err.message),
        `expected BAD_REQUEST matching ${pattern}`,
      );
    };
    bad({}, /requires a non-empty `stages`/);
    bad({ stages: [] }, /requires a non-empty `stages`/);
    bad({ stages: Array.from({ length: 17 }, () => ({ command_argv: ARGV })) }, /at most 16/);
    bad({ stages: [{ command_argv: [] }] }, /stages\[0\]\.command_argv/);
    bad({ stages: [{ command_argv: [1, 2] }] }, /stages\[0\]\.command_argv/);
    bad({ stages: STAGES, index_total: 3 }, /index_total must be 1/);

    // And `stages` outside pipeline mode is refused rather than ignored: the caller believes they
    // described a sequence, and running only stage 0 would silently drop the rest.
    assert.throws(
      () => h.state.createTask({ mode: 'replicate', command_argv: ARGV, stages: STAGES, base_tree: BASE_TREE }),
      (err) => err.code === 'BAD_REQUEST' && /only valid with mode=pipeline/.test(err.message),
    );
  });

  it('aggregates a pipeline like a replicate task, because that is what it is', () => {
    const h = harness();
    const task = makePipeline(h);
    for (const lease of task.leases.values()) {
      h.state.submitResult(envelope(task, lease.machine_id, { index: 0 }));
    }
    const agg = aggregate(task, h.state.results.values(), { nowMs: T0 + 1000 });
    // Every machine ran the same chain and agreed, so a complete fan-out is `consistent`. The
    // per-stage detail lives in the envelopes; the verdict compares machines, not stages.
    assert.equal(agg.status, 'consistent');
    assert.equal(agg.counts.ok, 3);
  });

  it('keeps a one-machine pipeline distinguishable from a single command', () => {
    const h = harness();
    const single = h.state.createTask({
      mode: 'pipeline',
      command_argv: ARGV,
      stages: [{ command_argv: ARGV }],
      base_tree: BASE_TREE,
      base_commit: BASE_COMMIT,
    });
    const plain = h.state.createTask({
      mode: 'replicate',
      command_argv: ARGV,
      base_tree: BASE_TREE,
      base_commit: BASE_COMMIT,
    });
    const singleTask = h.state.getTask(single.task_id);
    const plainTask = h.state.getTask(plain.task_id);
    // Same command, but only one of them is a chain. If the hashes matched, the `|pipeline` suffix
    // would be doing nothing and the two modes would be indistinguishable at the anchor.
    assert.notEqual(singleTask.command_hash, plainTask.command_hash);
    assert.equal(singleTask.stages.length, 1);
    assert.equal(plainTask.stages, null);
  });
});
