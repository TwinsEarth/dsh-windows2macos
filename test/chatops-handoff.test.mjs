/**
 * Hand-off: what happens when the machine holding a task does not answer (v0.7.7).
 *
 * The property under test is the sharp edge, and it is asserted from the side that refuses:
 *
 *   * **a writing task is never handed off automatically**, because a second runner could apply
 *     the same change twice and the caller cannot tell from the verdict.
 *   * **a late result never overwrites its successor.** Arrival order is a property of the
 *     network; a verdict that depends on it is a verdict nobody can reason about.
 *   * **the machine that just went silent is not offered the slice again** — the one reassignment
 *     guaranteed to be useless.
 *   * **a slow machine is not pre-empted before its lease expires**, because a slow machine is not
 *     a dead one.
 *   * **every refusal is named**, because "why did nothing take over" has several answers with
 *     different fixes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldHandOff,
  reconcileResults,
  handoffTrace,
  isLeaseTerminal,
  NO_HANDOFF,
  LEASE_STATE,
} from '../src/chatops/handoff.mjs';

const NOW = 1_000_000;

const lease = (over = {}) => ({
  state: LEASE_STATE.CLAIMED,
  machine_id: 'm1',
  machine_name: 'win-desktop',
  attempt: 1,
  lease_until_ms: NOW - 1,
  ...over,
});

const candidates = [
  { machine_id: 'm1', machine_name: 'win-desktop', online: true },
  { machine_id: 'm2', machine_name: 'macmini', online: true },
  { machine_id: 'm3', machine_name: 'jp-shared', online: true },
];

/** The common case: expired lease, no writes, taking over allowed. */
const handOff = (over = {}) =>
  shouldHandOff({
    lease: lease(),
    write: false,
    halt: 'now',
    cancelled: false,
    triedMachineIds: [],
    candidates,
    now: NOW,
    ...over,
  });

describe('a writing task is never handed off automatically', () => {
  it('refuses hand-off for a write task, and says why', () => {
    // Hand-off makes execution at-least-once. For a write that means the same change applied
    // twice, on a machine that has no idea the first one ran.
    const result = handOff({ write: true });
    assert.equal(result.takeOver, false);
    assert.equal(result.reason, NO_HANDOFF.WRITE_NOT_IDEMPOTENT);
    assert.match(result.text, /写任务/);
  });

  it('still refuses when the lease has expired and an alternate is available', () => {
    // The tempting case: everything else says yes. The write is what decides.
    const result = handOff({ write: true, lease: lease({ lease_until_ms: NOW - 60_000 }) });
    assert.equal(result.takeOver, false);
    assert.equal(result.reason, NO_HANDOFF.WRITE_NOT_IDEMPOTENT);
  });

  it('allows hand-off for a read task, which is the whole point of the feature', () => {
    const result = handOff({ write: false });
    assert.equal(result.takeOver, true);
    assert.equal(result.machineId, 'm2');
    assert.equal(result.attempt, 2);
  });
});

describe('the silent machine is not offered its own slice again', () => {
  it('excludes the current holder even when the caller did not list it', () => {
    // Handing the slice back to the machine that just went quiet is the one reassignment
    // guaranteed to be useless.
    const result = handOff({ triedMachineIds: [] });
    assert.equal(result.machineId, 'm2');
    assert.notEqual(result.machineId, 'm1');
  });

  it('excludes every machine that has already tried', () => {
    const result = handOff({ triedMachineIds: ['m1', 'm2'] });
    assert.equal(result.machineId, 'm3');
  });

  it('names the all-tried case differently from the no-alternate case', () => {
    // Different fixes: "wait, or make one succeed" versus "add a machine to this fleet".
    //
    // The distinction is how many machines *exist*, not how many are untried — a first version
    // checked the latter, which is always false here, so the named reason was unreachable.
    const allTried = handOff({ triedMachineIds: ['m1', 'm2', 'm3'] });
    assert.equal(allTried.reason, NO_HANDOFF.ALL_TRIED, 'three machines exist and all had a turn');

    const onlyOne = handOff({ candidates: [{ machine_id: 'm1', online: true }] });
    assert.equal(onlyOne.reason, NO_HANDOFF.NO_ALTERNATE_MACHINE, 'this fleet holds one machine');
  });

  it('reports ALL_TRIED when the other machines are all offline too, not NO_ALTERNATE', () => {
    // They exist, so "add a machine" is the wrong advice.
    const result = handOff({
      candidates: [
        { machine_id: 'm1', online: true },
        { machine_id: 'm2', online: false },
        { machine_id: 'm3', online: false },
      ],
    });
    assert.equal(result.reason, NO_HANDOFF.ALL_TRIED);
  });

  it('skips an offline candidate', () => {
    const result = handOff({
      candidates: [
        { machine_id: 'm1', online: true },
        { machine_id: 'm2', online: false },
        { machine_id: 'm3', online: true },
      ],
    });
    assert.equal(result.machineId, 'm3');
  });
});

describe('a slow machine is not pre-empted', () => {
  it('declines while the lease is still valid', () => {
    const result = handOff({ lease: lease({ lease_until_ms: NOW + 5000 }) });
    assert.equal(result.takeOver, false);
    assert.equal(result.reason, NO_HANDOFF.NOT_YET_EXPIRED);
  });

  it('honours a grace period past expiry', () => {
    // A machine that is merely slow is not a machine that is gone. The lease expired 100ms ago and
    // the grace is 5s, so the deadline is still 4.9s away.
    const result = handOff({ lease: lease({ lease_until_ms: NOW - 100 }), takeoverGraceMs: 5000 });
    assert.equal(result.reason, NO_HANDOFF.NOT_YET_EXPIRED);
  });

  it('declines inside the grace window, on either side of the expiry', () => {
    // Two separate questions: is the lease still valid, and has the grace elapsed since it expired.
    // The first version added the grace to the wrong side and answered `takeOver: true` here.
    assert.equal(
      handOff({ lease: lease({ lease_until_ms: NOW + 4999 }), takeoverGraceMs: 5000 }).reason,
      NO_HANDOFF.NOT_YET_EXPIRED,
      'not yet expired',
    );
    assert.equal(
      handOff({ lease: lease({ lease_until_ms: NOW - 1 }), takeoverGraceMs: 5000 }).reason,
      NO_HANDOFF.NOT_YET_EXPIRED,
      'expired a millisecond ago, still inside the grace',
    );
  });

  it('takes over once the grace period has passed too', () => {
    // Expired 6s ago with a 5s grace: the deadline for patience has passed.
    const result = handOff({ lease: lease({ lease_until_ms: NOW - 6000 }), takeoverGraceMs: 5000 });
    assert.equal(result.takeOver, true);
  });

  it('takes over when the lease carries no deadline at all', () => {
    // An offline machine's lease may have no deadline to wait for; the connection dropping is the
    // signal, and that is the main path for this feature.
    const result = handOff({ lease: lease({ lease_until_ms: undefined }) });
    assert.equal(result.takeOver, true);
  });
});

describe('the caller\'s policy and the task\'s state decide first', () => {
  it('does nothing under halt: never, which is the default', () => {
    for (const halt of ['never', undefined, null, 'something-else']) {
      const result = handOff({ halt });
      assert.equal(result.takeOver, false, `halt=${halt} should not take over`);
      assert.equal(result.reason, NO_HANDOFF.HALT_NEVER);
    }
  });

  it('does nothing for a cancelled task', () => {
    // Reassigning it would resurrect work the operator stopped on purpose.
    const result = handOff({ cancelled: true });
    assert.equal(result.reason, NO_HANDOFF.CANCELLED);
  });

  it('does nothing when the lease already has a result', () => {
    for (const state of [LEASE_STATE.DONE, LEASE_STATE.CANCELLED]) {
      const result = handOff({ lease: lease({ state }) });
      assert.equal(result.reason, NO_HANDOFF.DONE);
    }
  });

  it('treats expired and refused leases as hand-off candidates, not as finished', () => {
    // Terminal for the lease, not for the slice — that distinction is the feature.
    assert.equal(isLeaseTerminal(LEASE_STATE.EXPIRED), false);
    assert.equal(isLeaseTerminal(LEASE_STATE.REFUSED), false);
    assert.equal(isLeaseTerminal(LEASE_STATE.DONE), true);
    assert.equal(handOff({ lease: lease({ state: LEASE_STATE.EXPIRED }) }).takeOver, true);
    assert.equal(handOff({ lease: lease({ state: LEASE_STATE.REFUSED }) }).takeOver, true);
  });

  it('refuses a missing lease rather than defaulting to a takeover', () => {
    const result = shouldHandOff({ lease: null, write: false, halt: 'now', candidates });
    assert.equal(result.takeOver, false);
  });

  it('increments the attempt number from the lease it replaces', () => {
    assert.equal(handOff({ lease: lease({ attempt: 1 }) }).attempt, 2);
    assert.equal(handOff({ lease: lease({ attempt: 4 }) }).attempt, 5);
  });

  it('treats a missing attempt number as the first', () => {
    assert.equal(handOff({ lease: lease({ attempt: undefined }) }).attempt, 2);
  });
});

describe('a late result never overwrites its successor', () => {
  const first = { machine_id: 'm1', attempt: 1, status: 'ok', stdout: 'from the slow machine' };
  const second = { machine_id: 'm2', attempt: 2, status: 'ok', stdout: 'from the successor' };

  it('counts the highest attempt, not the last to arrive', () => {
    // Arrival order is a property of the network. A verdict that depends on it is a verdict
    // nobody can reason about.
    const inOrder = reconcileResults([first, second]);
    assert.equal(inOrder.winner, second);
    const outOfOrder = reconcileResults([second, first]);
    assert.equal(outOfOrder.winner, second, 'the answer must not depend on arrival order');
  });

  it('keeps the superseded result instead of dropping it', () => {
    // A late result from the machine that went silent says the machine was slow, not dead.
    // Discarding it turns a diagnosable situation into an unexplained one.
    const { superseded, arrivedLate } = reconcileResults([first, { ...second, arrivedAfterHandoff: true }]);
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0], first);
    assert.deepEqual(arrivedLate, []);
  });

  it('flags a result that arrived after its lease was reassigned', () => {
    const late = { machine_id: 'm1', attempt: 1, arrivedAfterHandoff: true };
    const { winner, arrivedLate } = reconcileResults([late, second]);
    assert.equal(winner, second);
    assert.deepEqual(arrivedLate, [late]);
    assert.match(handoffTrace([{ event: 'late', attempt: 1, machine_id: 'm1' }])[0], /not counted/);
  });

  it('handles a single result, and none at all', () => {
    assert.equal(reconcileResults([first]).winner, first);
    assert.deepEqual(reconcileResults([]), { winner: null, superseded: [], arrivedLate: [] });
    assert.deepEqual(reconcileResults(null), { winner: null, superseded: [], arrivedLate: [] });
  });

  it('keeps the first of two deliveries of the same attempt, so a replay is stable', () => {
    const a = { machine_id: 'm1', attempt: 1, stdout: 'first delivery' };
    const b = { machine_id: 'm1', attempt: 1, stdout: 'second delivery' };
    assert.equal(reconcileResults([a, b]).winner, a);
    assert.equal(reconcileResults([b, a]).winner, b, 'either is equivalent; the choice must be deterministic');
  });

  it('treats a result with no attempt number as the earliest, not the latest', () => {
    // A missing attempt is an old frame, not a new one.
    const noAttempt = { machine_id: 'm0', status: 'ok' };
    assert.equal(reconcileResults([noAttempt, first]).winner, first);
  });
});

describe('the trace explains what happened, in order', () => {
  it('renders each event as a readable line', () => {
    const lines = handoffTrace([
      { event: 'offer', attempt: 1, machine_name: 'win-desktop' },
      { event: 'expired', attempt: 1, machine_name: 'win-desktop' },
      { event: 'handoff', attempt: 2, machine_name: 'macmini' },
      { event: 'done', attempt: 2, machine_name: 'macmini', status: 'ok' },
    ]);
    assert.equal(lines.length, 4);
    assert.match(lines[0], /offered to win-desktop/);
    assert.match(lines[1], /went silent/);
    assert.match(lines[2], /handed to macmini/);
    assert.match(lines[3], /answered/);
  });

  it('renders a declined hand-off with its reason, which is the question an operator asks', () => {
    const lines = handoffTrace([{ event: 'handoff-declined', reason: NO_HANDOFF.WRITE_NOT_IDEMPOTENT }]);
    assert.match(lines[0], /no hand-off/);
    assert.match(lines[0], /write_not_idempotent/);
  });

  it('tolerates an empty or malformed list', () => {
    assert.deepEqual(handoffTrace([]), []);
    assert.deepEqual(handoffTrace(null), []);
    assert.deepEqual(handoffTrace([null, 1, 'x']), []);
  });
});
