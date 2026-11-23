/**
 * End-to-end `webrtc-v1`: real WebSocket signaling, real Noise, real framing, fake engine.
 *
 * The engine is fake because the package has no WebRTC dependency by policy; the parts that could
 * regress without a native stack — offer/answer ordering, DataChannel open, SDP/candidate
 * forwarding, Noise handshake, fragmentation, PING/PONG and lifecycle — are all real.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSignalingServer } from '../src/agent/webrtc/signaling-server.mjs';
import { createWebRtcTransport } from '../src/agent/webrtc/transport.mjs';
import { createFakeWebRtcNetwork, makePeerKeys } from './helpers/fake-webrtc-engine.mjs';
import { TRANSPORT } from '../src/agent/transport.mjs';

function buildPair(url, room, keys = makePeerKeys(), overrides = {}) {
  const network = createFakeWebRtcNetwork();
  const host = createWebRtcTransport({
    role: 'host',
    signalUrl: url,
    room,
    peerId: 'host-socket',
    machineId: 'machine-a',
    peerMachineId: 'machine-b',
    deviceKey: keys.a,
    peerKeys: keys.peersForA,
    providerFactory: network.factoryFor('host'),
    connectTimeoutMs: 8_000,
    peerTimeoutMs: 8_000,
    handshakeTimeoutMs: 8_000,
    statsPollMs: 100,
    ...overrides,
  });
  const client = createWebRtcTransport({
    role: 'client',
    signalUrl: url,
    room,
    peerId: 'client-socket',
    machineId: 'machine-b',
    peerMachineId: 'machine-a',
    deviceKey: keys.b,
    peerPublicKey: keys.a.publicKeyBase64,
    providerFactory: network.factoryFor('client'),
    connectTimeoutMs: 8_000,
    peerTimeoutMs: 8_000,
    handshakeTimeoutMs: 8_000,
    statsPollMs: 100,
    ...overrides,
  });
  return { network, host, client, keys };
}

describe('webrtc-v1 transport', () => {
  it('registers under the transport vocabulary and passes the shape check', async () => {
    assert.equal(TRANSPORT.WEBRTC, 'webrtc-v1');
    const server = await createSignalingServer({ port: 0, heartbeatMs: 0 });
    const keys = makePeerKeys();
    const { host, client, network } = buildPair(server.url, 'shape-room', keys);
    assert.equal(host.ok, true, host.detail);
    assert.equal(client.ok, true, client.detail);
    assert.equal(host.transport.name, 'webrtc-v1');
    await host.transport.stop();
    await client.transport.stop();
    network.close();
    await server.close();
  });

  it('connects, sends a small message and reports a direct path', async () => {
    const server = await createSignalingServer({ port: 0, heartbeatMs: 0 });
    const { host, client, network } = buildPair(server.url, 'send-room');
    const received = [];
    host.transport.onMessage(({ payload }) => received.push(payload.toString()));
    const started = await Promise.all([host.transport.start(), client.transport.start()]);
    assert.equal(started[0].ok, true, JSON.stringify(started[0]));
    assert.equal(started[1].ok, true, JSON.stringify(started[1]));

    const sent = await client.transport.send('machine-a', 'hello over the data channel');
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(received, ['hello over the data channel']);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const diagnostics = client.transport.diagnostics();
    assert.equal(diagnostics.path.verdict, 'direct', JSON.stringify(diagnostics.path));
    assert.equal(diagnostics.secure.state, 'secure');
    assert.equal(diagnostics.provider.ready, true);

    const probe = await client.transport.probe(1000);
    assert.equal(probe.ok, true, JSON.stringify(probe));

    await client.transport.stop();
    await host.transport.stop();
    network.close();
    await server.close();
  });

  it('fragments and reassembles a 64 KiB message', async () => {
    const server = await createSignalingServer({ port: 0, heartbeatMs: 0 });
    const { host, client, network } = buildPair(server.url, 'chunk-room');
    const received = [];
    host.transport.onMessage(({ payload }) => received.push(payload));
    const started = await Promise.all([host.transport.start(), client.transport.start()]);
    assert.equal(started[0].ok, true);
    assert.equal(started[1].ok, true);

    const payload = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => index % 251));
    const sent = await client.transport.send('machine-a', payload);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.ok(sent.fragments >= 4, `expected multiple fragments, got ${sent.fragments}`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], payload);

    await client.transport.stop();
    await host.transport.stop();
    network.close();
    await server.close();
  });

  it('refuses a send to a different machine id instead of misdelivering it', async () => {
    const server = await createSignalingServer({ port: 0, heartbeatMs: 0 });
    const { host, client, network } = buildPair(server.url, 'peer-room');
    const started = await Promise.all([host.transport.start(), client.transport.start()]);
    assert.equal(started[0].ok, true);
    assert.equal(started[1].ok, true);
    const result = await client.transport.send('machine-z', 'wrong peer');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBRTC_UNKNOWN_PEER');
    await client.transport.stop();
    await host.transport.stop();
    network.close();
    await server.close();
  });

  it('names a missing provider instead of falling back silently', () => {
    const created = createWebRtcTransport({
      role: 'client',
      signalUrl: 'ws://127.0.0.1:1/w2m/webrtc',
      room: 'none',
      peerMachineId: 'machine-b',
      machineId: 'machine-a',
      deviceKey: makePeerKeys().a,
      peerPublicKey: makePeerKeys().b.publicKeyBase64,
    });
    assert.equal(created.ok, true);
    // The transport can be constructed for status; `start()` is where the absence is reported.
    return created.transport.start().then((result) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'WEBRTC_PROVIDER_UNAVAILABLE');
      return created.transport.stop();
    });
  });
});
