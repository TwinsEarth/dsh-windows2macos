/**
 * Does `--fleet` actually reach a device record? (v0.7.7)
 *
 * The wiring has three links, and a break in any one of them is **silent**:
 *
 *   relay `--fleet X`  ->  the pairing code carries `fleet_id: X`
 *                      ->  `pair()` writes that fleet onto the device
 *                      ->  `createTask` filters targets to that fleet
 *
 * A missing first or second link means every device is fleetless, every device is "legacy", and
 * the only evidence is that isolation does not happen. That is exactly the kind of failure this
 * whole workstream is about, so it is tested by running a real relay rather than by reading the
 * code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../src/relay/server.mjs';

const FLEET = 'aaaaaaaa';

/** A relay on an ephemeral port, with its state in memory and no persistence. */
async function liveRelay(options = {}) {
  const relay = createRelayServer({
    host: '127.0.0.1',
    port: 0,
    persist: false,
    operatorToken: 'operator-token-for-tests',
    // The option under test. Omitted, the relay is unscoped and behaves as it did before v0.7.7.
    ...options,
  });
  const info = await relay.listen();
  const base = `http://127.0.0.1:${info.port ?? info.port_actual ?? relay.port ?? relay.address()?.port}`;
  return { relay, base, close: () => relay.close?.() };
}

/** The pairing code the relay is currently offering. */
function currentCode(relay) {
  const codes = [...relay.state.pairingCodes.values()].filter((c) => !c.used);
  return codes.at(-1) ?? null;
}

async function pair(base, code, machineId, name) {
  const res = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: code, machine_id: machineId, machine_name: name, platform: { os: 'linux', arch: 'x64' }, caps: {} }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('a code minted by a scoped relay carries its fleet', () => {
  it('puts the fleet on the code, which is the link that is easy to omit', async () => {
    const { relay, close } = await liveRelay({ fleetId: FLEET });
    try {
      const code = currentCode(relay);
      assert.ok(code, 'the relay should be offering a code');
      assert.equal(code.fleet_id, FLEET, 'a code with no fleet pairs a device into no fleet, silently');
    } finally {
      await close();
    }
  });

  it('leaves the fleet null on an unscoped relay', async () => {
    const { relay, close } = await liveRelay();
    try {
      const code = currentCode(relay);
      assert.equal(code.fleet_id, null);
    } finally {
      await close();
    }
  });

  it('lets a caller mint a code for another fleet explicitly', async () => {
    // What a relay serving several fleets needs — and the only way to get a code whose fleet
    // differs from the relay's own.
    const { relay, close } = await liveRelay({ fleetId: FLEET });
    try {
      const code = relay.state.createPairingCode({ fleetId: 'bbbbbbbb' });
      assert.equal(relay.state.pairingCodes.get(code).fleet_id, 'bbbbbbbb');
    } finally {
      await close();
    }
  });
});

describe('pairing writes the fleet onto the device', () => {
  it('copies the code\'s fleet, with its provenance', async () => {
    const { relay, base, close } = await liveRelay({ fleetId: FLEET });
    try {
      const code = currentCode(relay).code;
      const res = await pair(base, code, 'machine-1', 'win-desktop');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const device = relay.state.devices.get('machine-1');
      assert.equal(device.fleet_id, FLEET);
      assert.equal(device.fleet_source, 'pairing_code', 'the provenance must be recorded, not inferred');
    } finally {
      await close();
    }
  });

  it('records a fleetless device as such rather than omitting the field', async () => {
    const { relay, base, close } = await liveRelay();
    try {
      const code = currentCode(relay).code;
      await pair(base, code, 'machine-1', 'win-desktop');
      const device = relay.state.devices.get('machine-1');
      assert.equal(device.fleet_id, null);
      assert.equal(device.fleet_source, null);
    } finally {
      await close();
    }
  });

  it('puts the fleet into the persisted shape, so a restart keeps it', async () => {
    // `devices.json` is what a restart reads. A fleet that lives only in memory is a fleet that
    // disappears on the next deploy, which is exactly when an operator is looking.
    const { relay, base, close } = await liveRelay({ fleetId: FLEET });
    try {
      await pair(base, currentCode(relay).code, 'machine-1', 'win-desktop');
      const publicDevice = relay.state.listDevices().find((d) => d.machine_id === 'machine-1');
      assert.equal(publicDevice.fleet_id, FLEET);
    } finally {
      await close();
    }
  });
});

describe('dispatch reaches only the fleet, once anything is scoped', () => {
  it('sends the task to the scoped device and not to a fleetless one', async () => {
    const { relay, base, close } = await liveRelay({ fleetId: FLEET });
    try {
      // One device paired while the relay was scoped, so it carries the fleet.
      await pair(base, currentCode(relay).code, 'in-fleet', 'win-desktop');
      // A second device paired with an explicitly fleetless code, simulating one that predates
      // fleets. It must be invisible to a scoped dispatch.
      const looseCode = relay.state.createPairingCode({ fleetId: null });
      await pair(base, looseCode, 'loose', 'macmini');

      const result = relay.state.createTask({ command_argv: ['node', '--version'], mode: 'replicate' });
      const offered = (result.leases ?? []).map((l) => l.machine_id);
      assert.deepEqual(offered, ['in-fleet'], `offered to ${JSON.stringify(offered)}`);
    } finally {
      await close();
    }
  });

  it('keeps the old behaviour on an unscoped relay, so the deploy is not an outage', async () => {
    const { relay, base, close } = await liveRelay();
    try {
      await pair(base, currentCode(relay).code, 'one', 'a');
      await pair(base, currentCode(relay).code, 'two', 'b');
      const result = relay.state.createTask({ command_argv: ['node', '--version'], mode: 'replicate' });
      const offered = (result.leases ?? []).map((l) => l.machine_id).sort();
      assert.deepEqual(offered, ['one', 'two'], 'both fleetless devices, both reached: the pre-v0.7.7 rule');
    } finally {
      await close();
    }
  });

  it('scopes an operator dispatch to the relay\'s own fleet, rather than refusing it', async () => {
    // A first version refused this, which broke every operator dispatch on a scoped relay — and
    // broke it in the least useful way: configuring the fleet made the operator unable to dispatch.
    // The relay's own `fleetId` *is* a statement about which fleet it serves, so an operator
    // dispatch has an unambiguous scope.
    const { relay, base, close } = await liveRelay({ fleetId: FLEET });
    try {
      await pair(base, currentCode(relay).code, 'in-fleet', 'win-desktop');
      const looseCode = relay.state.createPairingCode({ fleetId: null });
      await pair(base, looseCode, 'loose', 'macmini');

      const result = relay.state.createTask({ command_argv: ['node', '--version'], mode: 'replicate' });
      const offered = (result.leases ?? []).map((l) => l.machine_id);
      assert.deepEqual(offered, ['in-fleet'], 'the operator reaches the relay\'s fleet and nothing else');
    } finally {
      await close();
    }
  });

  it('refuses a target named from outside the fleet, indistinguishably from a missing one', async () => {
    const { relay, base, close } = await liveRelay({ fleetId: FLEET });
    try {
      await pair(base, currentCode(relay).code, 'in-fleet', 'win-desktop');
      const looseCode = relay.state.createPairingCode({ fleetId: null });
      await pair(base, looseCode, 'loose', 'macmini');

      // Refused outright rather than silently dropped: a caller that named a target and got a
      // task back would believe it dispatched there.
      assert.throws(
        () => relay.state.createTask({ command_argv: ['node', '--version'], mode: 'replicate', target_machines: ['loose'] }),
        (err) => err.code === 'NO_ONLINE_DEVICE' && err.detail?.reason === 'target_outside_fleet',
      );

      // And the same for a target that exists nowhere, with the same reason — so a caller cannot
      // enumerate another account's machine ids by trying them and reading the error.
      assert.throws(
        () => relay.state.createTask({ command_argv: ['node', '--version'], mode: 'replicate', target_machines: ['no-such-machine'] }),
        (err) => err.code === 'NO_ONLINE_DEVICE' && err.detail?.reason === 'target_outside_fleet',
      );
    } finally {
      await close();
    }
  });
});
