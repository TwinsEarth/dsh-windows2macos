/**
 * The Noise boundary over a DataChannel-shaped `sendRaw`.
 *
 * The test drives two real `SecureChannel` instances, real X25519 keys, the real
 * `startHandshake`/`respondHandshake` and the real `CryptoSession`. Only the byte transport is a
 * function: `chanA.sendRaw` calls `chanB.handle` and vice versa, which is exactly the contract a
 * WebRTC DataChannel satisfies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceKey } from '../src/agent/crypto.mjs';
import { SecureChannel } from '../src/agent/webrtc/secure.mjs';

/**
 * @param {{keyA?: DeviceKey, keyB?: DeviceKey, peerKeyForA?: string}} [options]
 */
function pair({
  keyA = DeviceKey.generate('machine-a'),
  keyB = DeviceKey.generate('machine-b'),
  peerKeyForA = null,
} = {}) {
  const receivedB = [];
  const receivedA = [];
  const chanA = new SecureChannel({
    role: 'initiator',
    deviceKey: keyA,
    peerMachineId: 'machine-b',
    peerPublicKey: peerKeyForA ?? keyB.publicKeyBase64,
    sendRaw: (frame) => chanB.handle(frame),
  });
  const chanB = new SecureChannel({
    role: 'responder',
    deviceKey: keyB,
    peerMachineId: 'machine-a',
    peerKeys: new Map([['machine-a', keyA.publicKeyBase64]]),
    sendRaw: (frame) => chanA.handle(frame),
  });
  chanB.on('frame', ({ body }) => receivedB.push(body.toString()));
  chanA.on('frame', ({ body }) => receivedA.push(body.toString()));
  chanA.on('error', () => {});
  chanB.on('error', () => {});
  return { chanA, chanB, receivedA, receivedB };
}

describe('SecureChannel', () => {
  it('completes a real Noise handshake and carries encrypted DATA both ways', async () => {
    const { chanA, chanB, receivedA, receivedB } = pair();
    await chanA.start();
    assert.equal(chanA.state, 'secure');
    assert.equal(chanB.state, 'secure');
    assert.equal(chanA.diagnostics().stats.handshakes, 1);
    assert.equal(chanB.diagnostics().stats.handshakes, 1);

    const sent = await chanA.send('hello over noise');
    assert.equal(sent.ok, true);
    assert.deepEqual(receivedB, ['hello over noise']);

    const reply = await chanB.send('reply over noise');
    assert.equal(reply.ok, true);
    assert.deepEqual(receivedA, ['reply over noise']);
  });

  it('refuses a replayed encrypted frame after the original was accepted', async () => {
    const keyA = DeviceKey.generate('machine-a');
    const keyB = DeviceKey.generate('machine-b');
    let captured = null;
    const chanA = new SecureChannel({
      role: 'initiator',
      deviceKey: keyA,
      peerMachineId: 'machine-b',
      peerPublicKey: keyB.publicKeyBase64,
      sendRaw: (frame) => {
        captured = frame;
        return chanB.handle(frame);
      },
    });
    const chanB = new SecureChannel({
      role: 'responder',
      deviceKey: keyB,
      peerMachineId: 'machine-a',
      peerKeys: new Map([['machine-a', keyA.publicKeyBase64]]),
      sendRaw: (frame) => chanA.handle(frame),
    });
    chanA.on('error', () => {});
    chanB.on('error', () => {});
    const received = [];
    chanB.on('frame', ({ body }) => received.push(body.toString()));
    await chanA.start();
    await chanA.send('once');
    assert.deepEqual(received, ['once']);
    const replay = chanB.handle(captured);
    assert.equal(replay.ok, false);
    assert.equal(replay.code, 'P2P_CRYPTO_REPLAYED_FRAME');
    assert.deepEqual(received, ['once']);
  });

  it('refuses a HELLO from a machine whose key is not pinned', async () => {
    const keyA = DeviceKey.generate('machine-a');
    const keyB = DeviceKey.generate('machine-b');
    const wrong = DeviceKey.generate('machine-c');
    const { chanA, chanB } = pair({ keyA, keyB, peerKeyForA: wrong.publicKeyBase64 });
    const result = await chanA.start();
    assert.equal(result.ok, false);
    assert.equal(chanA.state, 'failed');
    assert.equal(chanB.state, 'failed');
    assert.equal(chanA.diagnostics().stats.dropped >= 0, true);
    assert.match(String(chanA.diagnostics().reason), /P2P_CRYPTO/);
  });

  it('authenticates PING/PONG and reports RTT', async () => {
    const { chanA } = pair();
    await chanA.start();
    const probe = await chanA.probe(2000);
    assert.equal(probe.ok, true);
    assert.ok(probe.rttMs >= 0);
  });

  it('does not send application bytes before the handshake', async () => {
    const { chanA } = pair();
    const result = await chanA.send('too early');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBRTC_SECURE_NOT_READY');
  });
});
