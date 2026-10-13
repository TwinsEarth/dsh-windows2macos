/**
 * The two guards on lease takeover (v0.7.8).
 *
 * `_takeover` already existed and already ran on `halt=now`, so hand-off was not absent — but it
 * would re-offer a dead machine's index to **every idle device the relay holds**, with no fleet
 * filter and no consideration of whether the task writes. Both are reachable defects, and both are
 * easy to miss because this path only runs when something has already gone wrong:
 *
 *   * **a device in another account could be handed the work** — the isolation this release series
 *     is about, broken in the one code path nobody exercises on purpose;
 *   * **a writing task could be run a second time** — hand-off makes execution at-least-once, which
 *     is harmless for `node --test` and a duplicated write for anything else.
 *
 * The re-offer *shape* is deliberately unchanged: PROTOCOL v0.0.1 defines no per-index lease
 * reassignment, so takeover is expressed as a re-offer to idle machines. Narrowing that to a single
 * successor is a protocol revision, not a wiring change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../src/relay/server.mjs';

const FLEET = 'aaaaaaaa';
const OTHER = 'bbbbbbbb';
const OP = 'operator-token-for-tests';

async function liveRelay(options = {}) {
  const relay = createRelayServer({ host: '127.0.0.1', port: 0, persist: false, operatorToken: OP, ...options });
  const info = await relay.listen();
  return { relay, base: `http://127.0.0.1:${info.port ?? info.port_actual ?? relay.port}`, close: () => relay.close?.() };
}

const currentCode = (relay) => [...relay.state.pairingCodes.values()].filter((c) => !c.used).at(-1);

async function pair(base, code, machineId, name) {
  const res = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: code, machine_id: machineId, machine_name: name, platform: { os: 'linux', arch: 'x64' }, caps: {} }),
  });
  assert.equal(res.status, 200, `pairing ${name} failed`);
}

/** Dispatch a task and expire every lease so the sweep has something to act on. */
function dispatchAndExpire(relay, body = {}) {
  const result = relay.state.createTask({ command_argv: ['node', '--version'], mode: 'replicate', ...body });
  const task = relay.state.tasks.get(result.task_id);
  const past = relay.state.nowMs() - relay.state.leaseWindowMs() - 1000;
  for (const lease of task.leases.values()) {
    lease.lease_until_ms = past;
    // A lease is only swept while it is in ACTIVE_LEASE_STATES = ['queued','offered','running'].\n    // claimed is not one of them, so a first version of this helper set a state the sweep\n    // ignores and the takeover never ran -- the tests failed for the setup, not the guard.\n    lease.state = 'running';
  }
  return { taskId: result.task_id, task };
}

describe('a writing task is never taken over', () => {
  it('refuses the takeover and names the reason', async () => {
    const { relay, base, close } = await liveRelay();
    try {
      await pair(base, currentCode(relay).code, 'one', 'a');
      await pair(base, currentCode(relay).code, 'two', 'b');
      const { task } = dispatchAndExpire(relay, { write: true, write_scope: ['src/'], halt: 'now' });

      const notices = [];
      relay.state.onEvent((entry) => {
        const e = entry?.event ?? entry;
        if (e?.code) notices.push(e);
      });
      relay.state.sweepExpired();

      const refused = notices.find((n) => n.code === 'LEASE_TAKEOVER_REFUSED');
      assert.ok(refused, `expected a refusal notice, saw ${notices.map((n) => n.code).join(',')}`);
      assert.equal(refused.reason, 'write_not_idempotent');
      // And no lease was created for either machine at the new attempt.
      const attempts = [...task.leases.values()].map((l) => l.attempt);
      assert.equal(Math.max(...attempts), 1, 'no machine may hold a second attempt of a write task');
    } finally {
      await close();
    }
  });

  it('still takes over a read task, which is the whole point', async () => {
    const { relay, base, close } = await liveRelay();
    try {
      await pair(base, currentCode(relay).code, 'one', 'a');
      await pair(base, currentCode(relay).code, 'two', 'b');
      const { task } = dispatchAndExpire(relay, { halt: 'now' });
      relay.state.sweepExpired();
      const attempts = [...task.leases.values()].map((l) => l.attempt);
      assert.ok(Math.max(...attempts) >= 2, 'a read task must be re-offered');
    } finally {
      await close();
    }
  });
});

describe('a takeover never crosses fleets', () => {
  it('skips a device in another fleet and takes over within the task\'s fleet', async () => {
    const { relay, base, close } = await liveRelay({ fleetId: FLEET });
    try {
      // Two machines in the fleet, one in another.
      await pair(base, currentCode(relay).code, 'in-a1', 'a1');
      await pair(base, currentCode(relay).code, 'in-a2', 'a2');
      const otherCode = relay.state.createPairingCode({ fleetId: OTHER });
      await pair(base, otherCode, 'in-b1', 'b1');

      const { task } = dispatchAndExpire(relay, { halt: 'now' });
      const inFleetBefore = [...task.leases.keys()].sort();
      assert.deepEqual(inFleetBefore, ['in-a1', 'in-a2'], 'the old fleet, nothing from B');

      relay.state.sweepExpired();
      // Whatever happened, no lease may exist for the other account's machine.
      assert.equal(task.leases.has('in-b1'), false, 'a device in another fleet must never be handed the work');
    } finally {
      await close();
    }
  });

  it('does not hand work to a fleetless device on a scoped relay', async () => {
    const { relay, base, close } = await liveRelay({ fleetId: FLEET });
    try {
      await pair(base, currentCode(relay).code, 'in-a1', 'a1');
      await pair(base, currentCode(relay).code, 'in-a2', 'a2');
      // A machine that paired before fleets existed: no fleet, so no fleet to match.
      const looseCode = relay.state.createPairingCode({ fleetId: null });
      await pair(base, looseCode, 'loose', 'legacy');

      const { task } = dispatchAndExpire(relay, { halt: 'now' });
      relay.state.sweepExpired();
      assert.equal(task.leases.has('loose'), false, 'a fleetless device cannot take over on a scoped relay');
    } finally {
      await close();
    }
  });

  it('leaves an unscoped relay behaving as before, so the deploy is not an outage', async () => {
    const { relay, base, close } = await liveRelay();
    try {
      await pair(base, currentCode(relay).code, 'one', 'a');
      await pair(base, currentCode(relay).code, 'two', 'b');
      const { task } = dispatchAndExpire(relay, { halt: 'now' });
      const before = [...task.leases.keys()].sort();
      relay.state.sweepExpired();
      const after = [...task.leases.keys()].sort();
      assert.deepEqual(before, after, 'the same machine set, since nothing is scoped');
      assert.ok([...task.leases.values()].some((l) => l.attempt >= 2), 'and the takeover still happened');
    } finally {
      await close();
    }
  });
});
