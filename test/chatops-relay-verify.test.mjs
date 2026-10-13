/**
 * The relay verifies a device's Ed25519 signature (v0.7.11).
 *
 * The property that matters is **convergence**: a fleet must be upgradable one machine at a time,
 * with no flag and no coordination, and each machine must get the strongest mechanism available
 * *to it* the moment it starts sending one.
 *
 * That gives three cases, and a relay that got any of them wrong would be worse than one with no
 * device verification at all:
 *
 *   * a device that sends **no** signature → the shared secret answers, exactly as before;
 *   * a device **with** a stored key that sends a **good** signature → verified by the key;
 *   * a device **with** a stored key that sends a **bad** signature → **refused**, and NOT quietly
 *     retried against the shared secret. Falling back would make the strong mechanism optional for
 *     anyone who can produce a malformed signature, which is everyone.
 *
 * And the operator token is not a device, so it keeps using the shared secret — consistent with
 * `authorizeTaskDispatch`, which has always reported `machine_id: null` for an operator.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRelayServer } from '../src/relay/server.mjs';
import { createDeviceSigner } from '../src/chatops/device-signing.mjs';

const OP = 'operator-token-for-tests';

async function liveRelay(options = {}) {
  const relay = createRelayServer({ host: '127.0.0.1', port: 0, persist: false, operatorToken: OP, ...options });
  const info = await relay.listen();
  return { relay, port: info.port ?? info.port_actual, close: () => relay.close?.() };
}

const currentCode = (relay) => [...relay.state.pairingCodes.values()].filter((c) => !c.used).at(-1).code;


describe('a device that signs is verified with its own key', () => {
  it('accepts a good signature from a paired device', async () => {
    const { relay, port, close } = await liveRelay();
    try {
      const device = createDeviceSigner();
      const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: currentCode(relay),
          machine_id: 'm1',
          machine_name: 'm1',
          platform: { os: 'linux', arch: 'x64' },
          caps: {},
          public_key: device.publicKeyPem,
        }),
      });
      assert.equal(res.status, 200);
      const deviceToken = (await res.json()).device_token;
      assert.ok(deviceToken, 'pairing returns a device token');

      // The relay stored the key it was given.
      assert.equal(relay.state.devices.get('m1').public_key, device.publicKeyPem);

      const { headers } = device.signRequest({ method: 'GET', path: '/v1/devices', body: '' });
      const decision = relay.verifySignature(
        { headers: { ...headers, authorization: `Bearer ${deviceToken}` } },
        { method: 'GET', signedPath: '/v1/devices', body: '' },
      );
      assert.equal(decision.ok, true, decision.error);
      assert.equal(decision.device, true, 'verified via the device key, not the shared secret');
      assert.equal(decision.machine_id, 'm1');
    } finally {
      await close();
    }
  });

  it('refuses a bad signature WITHOUT falling back to the shared secret', async () => {
    // The case that would make device keys decorative: a device registers a key, sends a malformed
    // signature, and is admitted anyway because the relay tried the other mechanism next.
    const { relay, port, close } = await liveRelay({ signingSecret: 'a-shared-secret-value' });
    try {
      const device = createDeviceSigner();
      const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: currentCode(relay),
          machine_id: 'm1',
          machine_name: 'm1',
          platform: {},
          caps: {},
          public_key: device.publicKeyPem,
        }),
      });
      const deviceToken = (await res.json()).device_token;

      // A signature over DIFFERENT bytes: structurally valid, cryptographically wrong.
      const { headers } = device.signRequest({ method: 'GET', path: '/v1/something-else', body: '' });
      const decision = relay.verifySignature(
        { headers: { ...headers, authorization: `Bearer ${deviceToken}` } },
        { method: 'GET', signedPath: '/v1/devices', body: '' },
      );
      assert.equal(decision.ok, false, 'a bad device signature must not be rescued by the shared secret');
      assert.equal(decision.code, 'SIGNATURE_BAD');
    } finally {
      await close();
    }
  });

  it('leaves a device with no stored key on the shared secret, unchanged', async () => {
    // Every device in the fleet today. Sending a signature header while holding no key on file must
    // not change what happens.
    const { relay, port, close } = await liveRelay();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairing_code: currentCode(relay), machine_id: 'old', machine_name: 'old', platform: {}, caps: {} }),
      });
      assert.equal(res.status, 200);
      assert.equal(relay.state.devices.get('old').public_key, null, 'no key was offered, none is stored');
      const deviceToken = (await res.json()).device_token;

      const decision = relay.verifySignature(
        { headers: { 'x-w2m-signature': 'v1=deadbeef', 'x-w2m-timestamp': '1', 'x-w2m-nonce': 'n'.repeat(16), authorization: `Bearer ${deviceToken}` } },
        { method: 'GET', signedPath: '/v1/devices', body: '' },
      );
      // No secret configured, so the shared-secret path reports "unsigned but fine" — which is the
      // pre-v0.7.10 behaviour, and the point is that it is reached at all.
      assert.equal(decision.ok, true);
      assert.notEqual(decision.device, true, 'not verified via a device key, because there is none');
    } finally {
      await close();
    }
  });

  it('keeps an operator-token request on the shared secret, because an operator is not a device', async () => {
    const { relay, close } = await liveRelay();
    try {
      assert.equal(relay.machineIdForRequest({ headers: { authorization: `Bearer ${OP}` } }), null);
    } finally {
      await close();
    }
  });

  it('resolves a device token to its machine, so the key can be found', async () => {
    const { relay, port, close } = await liveRelay();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairing_code: currentCode(relay), machine_id: 'm9', machine_name: 'm9', platform: {}, caps: {} }),
      });
      const { device_token: deviceToken } = await res.json();
      assert.equal(relay.machineIdForRequest({ headers: { authorization: `Bearer ${deviceToken}` } }), 'm9');
      assert.equal(relay.machineIdForRequest({ headers: {} }), null);
      assert.equal(relay.machineIdForRequest({ headers: { authorization: 'Bearer nonsense' } }), null);
    } finally {
      await close();
    }
  });
});
