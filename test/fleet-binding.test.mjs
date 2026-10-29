import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diagnoseFleetBinding, shouldRejoin, FLEET_BINDING_CODE } from '../src/plugin/fleet-binding.mjs';

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const devices = (entry) => response(200, { devices: entry === null ? [] : [entry] });

describe('fleet binding diagnostics', () => {
  it('reports bound when the relay records a fleet_id', async () => {
    const block = await diagnoseFleetBinding({
      relayUrl: 'http://relay.example', token: 't', machineId: 'm1',
      fetchImpl: async () => devices({ machine_id: 'm1', fleet_id: 'fleet-a' }),
    });
    assert.equal(block.state, 'bound');
    assert.equal(block.code, FLEET_BINDING_CODE.BOUND);
    assert.equal(block.fleet_id, 'fleet-a');
  });

  it('reports FLEET_UNBOUND for a valid token with fleet_id=null', async () => {
    const block = await diagnoseFleetBinding({
      relayUrl: 'http://relay.example', token: 't', machineId: 'm1', fleetKey: 'k',
      fetchImpl: async () => devices({ machine_id: 'm1', fleet_id: null }),
    });
    assert.equal(block.state, 'unbound');
    assert.equal(block.code, 'FLEET_UNBOUND');
    assert.equal(block.fleet_id, null);
    assert.equal(block.fleet_key_configured, true);
    assert.match(block.remedy, /re-admits/i);
  });

  it('distinguishes unpaired, token rejected and unknown', async () => {
    const unpaired = await diagnoseFleetBinding({ relayUrl: 'r', token: null, machineId: 'm1', fetchImpl: async () => devices(null) });
    assert.equal(unpaired.code, FLEET_BINDING_CODE.UNPAIRED);
    const rejected = await diagnoseFleetBinding({ relayUrl: 'r', token: 't', machineId: 'm1', fetchImpl: async () => response(401, {}) });
    assert.equal(rejected.code, FLEET_BINDING_CODE.TOKEN_REJECTED);
    const missing = await diagnoseFleetBinding({ relayUrl: 'r', token: 't', machineId: 'm1', fetchImpl: async () => devices(null) });
    assert.equal(missing.code, FLEET_BINDING_CODE.UNKNOWN);
    const network = await diagnoseFleetBinding({ relayUrl: 'r', token: 't', machineId: 'm1', fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(network.code, FLEET_BINDING_CODE.UNKNOWN);
  });

  it('re-admits only when token is valid, fleet is missing and a key exists', () => {
    assert.equal(shouldRejoin({ token: 't', fleetId: null, fleetKey: 'k' }), true);
    assert.equal(shouldRejoin({ token: 't', fleetId: 'f', fleetKey: 'k' }), false);
    assert.equal(shouldRejoin({ token: 't', fleetId: null, fleetKey: null }), false);
    assert.equal(shouldRejoin({ token: '', fleetId: null, fleetKey: 'k' }), false);
  });
});
