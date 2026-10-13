/**
 * Fleet scoping: which devices a request may reach (v0.7.6).
 *
 * This is the release that makes account isolation real, so the tests are written against the
 * *attack*, not against the happy path:
 *
 *   * **account A cannot reach account B's devices**, by broadcast, by naming one, or by any
 *     other route. There is no parameter that widens the scope, so there is nothing to test that
 *     would widen it.
 *   * **an unnamed fleet is not a wildcard.** Two devices that both have no fleet must not match
 *     each other. This is the single most dangerous mistake available here, because it silently
 *     restores the old behaviour — one pool for everything — while every test that only ever sets
 *     a fleet keeps passing.
 *   * **a refused target does not reveal whether it exists.** A caller must not be able to
 *     enumerate another account's machine ids by trying them and reading the error.
 *   * **the fleet in a statement comes from the pairing code**, never from the device. A device
 *     that could name its own fleet would join any account, and every signature would faithfully
 *     attest to a lie.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  inFleet,
  selectTargets,
  fleetFromPairingCode,
  statementForDevice,
  SCOPE_REFUSAL,
} from '../src/chatops/fleet-scope.mjs';
import { createDeviceKey } from '../src/chatops/auth.mjs';

const A = 'aaaaaaaa';
const B = 'bbbbbbbb';

const device = (id, fleet, online = true) => ({ machine_id: id, fleet_id: fleet, online });

const FLEET = [
  device('a1', A),
  device('a2', A),
  device('a3', A, false),
  device('b1', B),
  device('b2', B),
  device('orphan', undefined),
  device('orphan2', ''),
];

describe('a request reaches only its own fleet', () => {
  it('gives account A only A devices', () => {
    const result = selectTargets({ devices: FLEET, fleetId: A });
    assert.equal(result.ok, true);
    assert.deepEqual(result.targets.map((d) => d.machine_id), ['a1', 'a2']);
  });

  it('gives account B only B devices', () => {
    const result = selectTargets({ devices: FLEET, fleetId: B });
    assert.deepEqual(result.targets.map((d) => d.machine_id), ['b1', 'b2']);
  });

  it('never crosses between accounts in either direction', () => {
    const a = selectTargets({ devices: FLEET, fleetId: A }).targets.map((d) => d.machine_id);
    const b = selectTargets({ devices: FLEET, fleetId: B }).targets.map((d) => d.machine_id);
    assert.equal(a.some((id) => b.includes(id)), false);
    assert.equal(a.some((id) => id.startsWith('b')), false);
    assert.equal(b.some((id) => id.startsWith('a')), false);
  });

  it('reaches no device at all without a fleet', () => {
    for (const noFleet of [null, undefined, '', 0, {}]) {
      const result = selectTargets({ devices: FLEET, fleetId: noFleet });
      assert.equal(result.ok, false, `${JSON.stringify(noFleet)} should reach nothing`);
      assert.equal(result.reason, SCOPE_REFUSAL.NO_FLEET);
    }
  });
});

describe('an absent fleet is not a wildcard — the mistake that would undo everything', () => {
  it('does not match an ungrouped device to an ungrouped requester', () => {
    // If this passed, every device without a fleet would form one shared pool: the exact
    // pre-v0.7.6 behaviour, restored silently, with all the other tests still green.
    assert.equal(inFleet(undefined, undefined), false);
    assert.equal(inFleet('', ''), false);
    assert.equal(inFleet(undefined, A), false);
    assert.equal(inFleet(A, undefined), false);
    assert.equal(inFleet(null, null), false);
  });

  it('excludes ungrouped devices from a real fleet', () => {
    const result = selectTargets({ devices: FLEET, fleetId: A });
    const ids = result.targets.map((d) => d.machine_id);
    assert.equal(ids.includes('orphan'), false);
    assert.equal(ids.includes('orphan2'), false);
  });

  it('matches only on two non-empty equal strings', () => {
    assert.equal(inFleet(A, A), true);
    assert.equal(inFleet(A, B), false);
  });
});

describe('a named target is checked against the fleet', () => {
  it('accepts a target in the fleet', () => {
    const result = selectTargets({ devices: FLEET, fleetId: A, targetMachines: ['a1'] });
    assert.deepEqual(result.targets.map((d) => d.machine_id), ['a1']);
  });

  it('refuses a target in another account', () => {
    const result = selectTargets({ devices: FLEET, fleetId: A, targetMachines: ['b1'] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, SCOPE_REFUSAL.TARGET_OUTSIDE_FLEET);
  });

  it('refuses an ungrouped target for a fleet', () => {
    assert.equal(selectTargets({ devices: FLEET, fleetId: A, targetMachines: ['orphan'] }).ok, false);
  });

  it('gives the same answer for "not yours" and "does not exist"', () => {
    // Otherwise a caller enumerates another account's machine ids by trying them and reading the
    // error. The two refusals must be indistinguishable from outside.
    const notMine = selectTargets({ devices: FLEET, fleetId: A, targetMachines: ['b1'] });
    const notThere = selectTargets({ devices: FLEET, fleetId: A, targetMachines: ['no-such-machine'] });
    assert.equal(notMine.reason, notThere.reason);
    assert.equal(notMine.text, notThere.text);
  });

  it('refuses the whole request when one of several targets is foreign', () => {
    // Partial dispatch would leave the caller believing everything went where it asked.
    const result = selectTargets({ devices: FLEET, fleetId: A, targetMachines: ['a1', 'b1'] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, SCOPE_REFUSAL.TARGET_OUTSIDE_FLEET);
  });
});

describe('offline devices are counted, not silently dropped', () => {
  it('skips an offline device and says which', () => {
    const result = selectTargets({ devices: FLEET, fleetId: A, targetMachines: ['a3'] });
    assert.equal(result.ok, false, 'a lone offline target means nothing to run on');
    assert.equal(result.reason, SCOPE_REFUSAL.NO_DEVICE_IN_FLEET);
    assert.match(result.text, /不在线/);
  });

  it('reports the whole fleet as offline rather than as empty', () => {
    // "we tried and they were offline" and "there are none" produce the same empty result and
    // different fixes.
    const allOffline = [device('a1', A, false), device('a2', A, false)];
    const result = selectTargets({ devices: allOffline, fleetId: A });
    assert.equal(result.reason, SCOPE_REFUSAL.NO_DEVICE_IN_FLEET);
    assert.match(result.text, /不在线/);
  });

  it('distinguishes an empty fleet from an offline one', () => {
    const empty = selectTargets({ devices: [device('b1', B)], fleetId: A });
    assert.equal(empty.reason, SCOPE_REFUSAL.NO_DEVICE_IN_FLEET);
    assert.doesNotMatch(empty.text, /不在线/);
  });

  it('can include offline devices when the caller asks', () => {
    const result = selectTargets({ devices: FLEET, fleetId: A, requireOnline: false });
    assert.equal(result.targets.length, 3);
    assert.equal(result.skippedOffline.length, 0);
  });

  it('names what it skipped when it skips', () => {
    const result = selectTargets({ devices: FLEET, fleetId: A, targetMachines: ['a2', 'a3'] });
    assert.deepEqual(result.targets.map((d) => d.machine_id), ['a2']);
    assert.deepEqual(result.skippedOffline, ['a3']);
  });
});

describe('the fleet comes from the pairing code, not from the device', () => {
  it('admits a device to the code\'s fleet', () => {
    const result = fleetFromPairingCode({ code: { fleet_id: A } });
    assert.equal(result.ok, true);
    assert.equal(result.fleetId, A);
  });

  it('refuses a code with no fleet rather than defaulting to one', () => {
    // A fleetless code would hand out access to a pool with no owner.
    for (const code of [{}, { fleet_id: '' }, { fleet_id: null }]) {
      const result = fleetFromPairingCode({ code });
      assert.equal(result.ok, false, `${JSON.stringify(code)} should be refused`);
      assert.equal(result.reason, 'code_has_no_fleet');
    }
  });

  it('refuses an unknown, used or expired code', () => {
    assert.equal(fleetFromPairingCode({ code: null }).reason, 'unknown_code');
    assert.equal(fleetFromPairingCode({ code: { fleet_id: A, used: true } }).reason, 'code_used');
    assert.equal(fleetFromPairingCode({ code: { fleet_id: A, exp: 1000 }, now: 2000 }).reason, 'code_expired');
  });

  it('accepts a code that has not expired', () => {
    assert.equal(fleetFromPairingCode({ code: { fleet_id: A, exp: 5000 }, now: 4000 }).ok, true);
  });

  it('puts the code\'s fleet into the statement, not the device\'s', () => {
    // If this took `device.fleet_id`, a device would choose its own fleet and every signature in
    // auth.mjs would faithfully attest to a lie.
    const key = createDeviceKey({ machineId: 'm-1' });
    const withLie = { ...key, fleetId: B };
    const statement = statementForDevice({ device: withLie, fleetId: A, sn: 'W2M-x' });
    assert.equal(statement.fleet_id, A);
    assert.notEqual(statement.fleet_id, B);
  });

  it('signs the device\'s own key and machine id', () => {
    const key = createDeviceKey({ machineId: 'm-7' });
    const statement = statementForDevice({ device: key, fleetId: A, sn: 'W2M-y' });
    assert.equal(statement.machine_id, 'm-7');
    assert.equal(statement.public_key, key.publicKeyPem);
    assert.equal(statement.algorithm, 'ed25519');
  });

  it('always sets an expiry', () => {
    const key = createDeviceKey({ machineId: 'm-1' });
    const statement = statementForDevice({ device: key, fleetId: A, sn: 'W2M-z' });
    assert.ok(Number.isFinite(statement.expires_at_ms));
    assert.ok(statement.expires_at_ms > statement.issued_at_ms);
  });
});

describe('the shape of the fix matches the defect it replaces', () => {
  it('reproduces the old behaviour when no fleet is applied, and shows the difference', () => {
    // The relay's old rule was `targets = all`. This test states that rule explicitly, then the
    // new one, so the change is visible as a behaviour difference rather than a code diff.
    const oldRule = [...FLEET];
    assert.equal(oldRule.length, 7, 'the old rule reaches every device, including both accounts');

    const newRule = selectTargets({ devices: FLEET, fleetId: A });
    assert.deepEqual(newRule.targets.map((d) => d.machine_id), ['a1', 'a2']);
    assert.ok(newRule.targets.length < oldRule.length);
  });
});
