/**
 * Wiring fleet scoping into the relay's decisions (v0.7.7).
 *
 * The property under test is that **the migration cannot be an outage and cannot be a silent
 * grant**:
 *
 *   * a relay with no fleet configured keeps behaving exactly as it did, so deploying this cannot
 *     take the existing four devices down;
 *   * once a relay *is* scoped, a device with no fleet reaches **nothing** — it is not quietly
 *     handed the run of someone else's fleet, which is the failure that would make the whole
 *     feature decorative;
 *   * a device that *has* a fleet reaches its own fleet and nothing else **in either mode**, so
 *     isolation does not depend on the relay's configuration;
 *   * the fleet always comes from the device record, which the relay wrote from the pairing
 *     code — never from the request.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  scopeFleetId,
  targetsFor,
  fleetForPairingCode,
  deviceFleetFields,
  describeScope,
  WIRING_REFUSAL,
} from '../src/chatops/fleet-wiring.mjs';

const A = 'aaaaaaaa';
const B = 'bbbbbbbb';

const dev = (id, fleet = null, online = true) => ({ machine_id: id, fleet_id: fleet, online });

/** The shared relay's actual state at the time of writing: four devices, no fleets anywhere. */
const LEGACY_FLEET = [dev('jp-shared'), dev('win-desktop'), dev('macmini'), dev('e94f1ce8', null, false)];

describe('a relay with no fleet keeps the old behaviour, so the deploy is not an outage', () => {
  it('reaches every device when the requester has no fleet either', () => {
    const result = targetsFor({ devices: LEGACY_FLEET, requester: dev('win-desktop'), relayFleetId: null });
    assert.equal(result.ok, true);
    assert.equal(result.legacy, true);
    assert.deepEqual(result.targets.map((d) => d.machine_id), ['jp-shared', 'win-desktop', 'macmini']);
  });

  it('names the legacy path in the result, rather than leaving it to be inferred', () => {
    // "4 targets" does not tell an operator whether isolation is on.
    const result = targetsFor({ devices: LEGACY_FLEET, requester: dev('win-desktop') });
    assert.equal(result.legacy, true);
    assert.match(describeScope({ scope: scopeFleetId({ device: dev('win-desktop') }), targetCount: 3 }), /legacy/);
  });

  it('still honours an explicit target list', () => {
    const result = targetsFor({ devices: LEGACY_FLEET, requester: dev('win-desktop'), targetMachines: ['macmini'] });
    assert.deepEqual(result.targets.map((d) => d.machine_id), ['macmini']);
  });

  it('still skips offline devices and says which', () => {
    const result = targetsFor({ devices: LEGACY_FLEET, requester: dev('win-desktop') });
    assert.deepEqual(result.skippedOffline, ['e94f1ce8']);
  });
});

describe('an operator is not a device, and an invalid one is', () => {
  it('refuses a requester that maps to no device', () => {
    // A token that resolves to a machine id not in the table is a broken caller, not an operator.
    const result = targetsFor({ devices: LEGACY_FLEET, requester: 'not-a-device', relayFleetId: A });
    assert.equal(result.ok, false);
    assert.equal(result.reason, WIRING_REFUSAL.UNKNOWN_TOKEN);
  });

  it('treats an ABSENT requester as the operator on an unscoped relay', () => {
    // `POST /v1/task` authenticates with the operator token and `authorizeTaskDispatch` returns
    // `{ role: 'operator', machine_id: null }` — so there is no device, legitimately, on the most
    // common dispatch path. A first version of this refused it as `unknown_token`, which broke 74
    // relay tests at once by turning every operator-token dispatch into an error.
    const result = targetsFor({ devices: LEGACY_FLEET, requester: undefined, relayFleetId: null });
    assert.equal(result.ok, true);
    assert.equal(result.legacy, true);
    assert.equal(result.legacyReason, 'operator');
    assert.equal(result.targets.length, 3);
  });

  it('refuses an absent requester once the relay is scoped', () => {
    // No fleet to attribute the request to, and handing it the run of the fleet is the silent
    // grant this work exists to remove.
    const result = targetsFor({ devices: LEGACY_FLEET, requester: null, relayFleetId: A });
    assert.equal(result.ok, false);
    assert.equal(result.reason, WIRING_REFUSAL.REQUESTER_HAS_NO_FLEET);
  });

  it('distinguishes the two legacy reasons, so a log says which rule applied', () => {
    const operator = targetsFor({ devices: LEGACY_FLEET, requester: undefined, relayFleetId: null });
    const fleetless = targetsFor({ devices: LEGACY_FLEET, requester: dev('win-desktop'), relayFleetId: null });
    assert.equal(operator.legacyReason, 'operator');
    assert.equal(fleetless.legacyReason, 'fleetless');
  });
});

describe('a scoped relay does not hand a fleetless device the run of it', () => {
  it('refuses a fleetless requester once the relay belongs to a fleet', () => {
    // The failure this prevents: a device that predates fleets silently reaching every machine in
    // someone's fleet, which would make the isolation decorative.
    const result = targetsFor({ devices: LEGACY_FLEET, requester: dev('win-desktop'), relayFleetId: A });
    assert.equal(result.ok, false);
    assert.equal(result.reason, WIRING_REFUSAL.REQUESTER_HAS_NO_FLEET);
    assert.equal(result.legacy, false);
  });

  it('says why, in a sentence an operator can act on', () => {
    const scope = scopeFleetId({ device: dev('win-desktop'), relayFleetId: A });
    assert.match(scope.text, /不属于任何舰队/);
  });

  // The "requester maps to no device" case moved to its own block below, because an ABSENT
  // requester turned out to be a legitimate operator rather than a broken one.
});

describe('a grouped device reaches its own fleet and nothing else, in either mode', () => {
  const MIXED = [dev('a1', A), dev('a2', A), dev('b1', B), dev('b2', B), dev('loose')];

  it('reaches only its own fleet when the relay is scoped', () => {
    const result = targetsFor({ devices: MIXED, requester: dev('a1', A), relayFleetId: A });
    assert.equal(result.ok, true);
    assert.equal(result.legacy, false);
    assert.deepEqual(result.targets.map((d) => d.machine_id), ['a1', 'a2']);
  });

  it('reaches only its own fleet even when the relay is not scoped', () => {
    // Isolation must not depend on the relay's configuration: a grouped device is grouped.
    const result = targetsFor({ devices: MIXED, requester: dev('a1', A), relayFleetId: null });
    assert.equal(result.ok, true);
    assert.equal(result.legacy, false);
    assert.deepEqual(result.targets.map((d) => d.machine_id), ['a1', 'a2']);
  });

  it('never reaches the other account, from either side', () => {
    const a = targetsFor({ devices: MIXED, requester: dev('a1', A), relayFleetId: A }).targets.map((d) => d.machine_id);
    const b = targetsFor({ devices: MIXED, requester: dev('b1', B), relayFleetId: B }).targets.map((d) => d.machine_id);
    assert.equal(a.some((id) => b.includes(id)), false);
    assert.deepEqual(a, ['a1', 'a2']);
    assert.deepEqual(b, ['b1', 'b2']);
  });

  it('does not reach an ungrouped device either', () => {
    const result = targetsFor({ devices: MIXED, requester: dev('a1', A), relayFleetId: A });
    assert.equal(result.targets.some((d) => d.machine_id === 'loose'), false);
  });

  it('refuses a named target in another fleet, indistinguishably from a missing one', () => {
    const foreign = targetsFor({ devices: MIXED, requester: dev('a1', A), relayFleetId: A, targetMachines: ['b1'] });
    const missing = targetsFor({ devices: MIXED, requester: dev('a1', A), relayFleetId: A, targetMachines: ['nope'] });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, missing.reason);
  });
});

describe('the fleet comes from the pairing code', () => {
  it('reads the fleet off a code that carries one', () => {
    assert.equal(fleetForPairingCode({ code: 'PAIR-X', fleet_id: A }), A);
  });

  it('returns null for a code issued before fleets existed', () => {
    // Which is what keeps an existing relay working: the code pairs into no fleet, and the
    // relay's own mode decides what that means.
    assert.equal(fleetForPairingCode({ code: 'PAIR-OLD' }), null);
    assert.equal(fleetForPairingCode({ code: 'PAIR-OLD', fleet_id: '' }), null);
    assert.equal(fleetForPairingCode(null), null);
  });

  it('takes the fleet from the code, not from the request, when both are present', () => {
    // A device that could name its own fleet would join any fleet.
    const fields = deviceFleetFields({ codeRecord: { fleet_id: A }, requestedFleet: B });
    assert.equal(fields.fleet_id, A);
    assert.equal(fields.fleet_source, 'pairing_code');
  });

  it('records where a fleet came from, so the two paths are distinguishable', () => {
    assert.equal(deviceFleetFields({ codeRecord: { fleet_id: A } }).fleet_source, 'pairing_code');
    assert.equal(deviceFleetFields({ codeRecord: null, requestedFleet: B }).fleet_source, 'request');
    assert.equal(deviceFleetFields({ codeRecord: null }).fleet_id, null);
    assert.equal(deviceFleetFields({ codeRecord: null }).fleet_source, null);
  });
});

describe('the migration path is the one the shared relay is actually on', () => {
  it('reproduces today\'s behaviour exactly when nothing is scoped', () => {
    // Four devices, none grouped. Before this release, `targets = [...devices.values()]`, minus
    // offline ones. The new code must produce the same set, or deploying it is an outage.
    const result = targetsFor({ devices: LEGACY_FLEET, requester: dev('jp-shared'), relayFleetId: null });
    const oldRule = LEGACY_FLEET.filter((d) => d.online !== false);
    assert.deepEqual(
      result.targets.map((d) => d.machine_id).sort(),
      oldRule.map((d) => d.machine_id).sort(),
      'the legacy path must match the rule it replaces',
    );
  });

  it('changes behaviour only once an operator scopes the relay', () => {
    const before = targetsFor({ devices: LEGACY_FLEET, requester: dev('win-desktop'), relayFleetId: null });
    const after = targetsFor({ devices: LEGACY_FLEET, requester: dev('win-desktop'), relayFleetId: A });
    assert.equal(before.ok, true, 'before: the fleet keeps working');
    assert.equal(after.ok, false, 'after: a fleetless device is refused rather than granted');
  });
});
