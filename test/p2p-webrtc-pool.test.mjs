/**
 * `WebRtcTransportPool`: deterministic pairing, per-peer lifecycle, key resolution, retries and
 * diagnostics. The engine is the in-process fake; signaling, Noise and framing are the real ones.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSignalingServer } from '../src/agent/webrtc/signaling-server.mjs';
import { createWebRtcTransport } from '../src/agent/webrtc/transport.mjs';
import {
  PEER_KEY_CACHE_TTL_MS,
  WEBRTC_POOL_CODE,
  WebRtcTransportPool,
  createRelayPeerKeyResolver,
  createWebRtcTransportPool,
  pairRole,
  pairRoom,
} from '../src/agent/webrtc/pool.mjs';
import { createFakeWebRtcNetwork, makePeerKeys } from './helpers/fake-webrtc-engine.mjs';

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error(`waitFor timed out after ${timeoutMs} ms`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function makeTransportFactory(network) {
  return (options) =>
    createWebRtcTransport({
      ...options,
      providerFactory: network.factoryFor(options.role),
      connectTimeoutMs: 8_000,
      peerTimeoutMs: 8_000,
      handshakeTimeoutMs: 8_000,
      statsPollMs: 100,
    });
}

function makeKeyResolver(keys) {
  return async (peer) => ({
    key: peer === 'machine-b' ? keys.b.publicKeyBase64 : keys.a.publicKeyBase64,
    error: null,
    source: 'test',
  });
}

describe('webrtc-v1 pool', () => {
  it('derives the same room and opposite roles from either side', () => {
    assert.equal(pairRole('machine-a', 'machine-b'), 'host');
    assert.equal(pairRole('machine-b', 'machine-a'), 'client');
    assert.equal(pairRole('machine-a', 'machine-a'), null);
    assert.equal(pairRole('', 'machine-b'), null);
    assert.equal(pairRoom('machine-a', 'machine-b'), pairRoom('machine-b', 'machine-a'));
    assert.match(pairRoom('machine-a', 'machine-b'), /^w2m-pair-[0-9a-f]{24}$/);
  });

  it('starts two pools, pairs them deterministically, and carries a payload', async () => {
    const server = await createSignalingServer({ port: 0, heartbeatMs: 0 });
    const keys = makePeerKeys();
    const network = createFakeWebRtcNetwork();
    const poolA = new WebRtcTransportPool({
      machineId: 'machine-a',
      signalUrl: server.url,
      deviceKey: keys.a,
      resolvePeerKey: makeKeyResolver(keys),
      transportFactory: makeTransportFactory(network),
    });
    const poolB = new WebRtcTransportPool({
      machineId: 'machine-b',
      signalUrl: server.url,
      deviceKey: keys.b,
      resolvePeerKey: makeKeyResolver(keys),
      transportFactory: makeTransportFactory(network),
    });
    const received = [];
    poolB.onMessage((event) => received.push({ peer: event.peer, text: event.payload.toString('utf8') }));

    const prepared = await Promise.all([poolA.prepare('machine-b'), poolB.prepare('machine-a')]);
    assert.equal(prepared[0].ok, true, JSON.stringify(prepared[0]));
    assert.equal(prepared[1].ok, true, JSON.stringify(prepared[1]));
    assert.equal(poolA.roleFor('machine-b'), 'host');
    assert.equal(poolB.roleFor('machine-a'), 'client');
    assert.equal(poolA.roomFor('machine-b'), poolB.roomFor('machine-a'));

    const sent = await poolA.send('machine-b', 'pool hello');
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.bytes, 10);
    await waitFor(() => received.length === 1);
    assert.deepEqual(received[0], { peer: 'machine-a', text: 'pool hello' });
    // `path.verdict` is computed from the engine's stats poll, so give it one interval.
    await waitFor(() => poolA.diagnostics().peers[0].path === 'direct', 1_000);

    const status = poolA.diagnostics();
    assert.equal(status.ok, true);
    assert.equal(status.peer_count, 1);
    assert.equal(status.peers[0].peer, 'machine-b');
    assert.equal(status.peers[0].role, 'host');
    assert.equal(status.peers[0].ok, true);
    assert.equal(status.peers[0].path, 'direct');

    await poolA.stop();
    await poolB.stop();
    network.close();
    await server.close();
  });

  it('refuses a missing peer key and retries after the resolver starts answering', async () => {
    let calls = 0;
    const key = makePeerKeys().b.publicKeyBase64;
    const pool = new WebRtcTransportPool({
      machineId: 'machine-a',
      signalUrl: 'ws://127.0.0.1:9/signal',
      resolvePeerKey: async () => {
        calls += 1;
        return calls === 1
          ? { key: null, error: 'WEBRTC_POOL_PEER_KEY_MISSING: relay 404', source: 'relay' }
          : { key, error: null, source: 'relay' };
      },
      // A minimal transport is enough for this test: it proves the refusal happens before a start,
      // and that the second ensure() is a fresh attempt rather than a cached failure.
      transportFactory: () => ({
        ok: true,
        transport: {
          name: 'webrtc-v1',
          async start() {
            return { ok: true };
          },
          async stop() {
            return { ok: true };
          },
          async send() {
            return { ok: true };
          },
          onMessage() {
            return () => {};
          },
          paths() {
            return [];
          },
          diagnostics() {
            return { state: 'ready', path: { verdict: 'direct' } };
          },
        },
      }),
    });
    const first = await pool.ensure('machine-b');
    assert.equal(first.ok, false);
    assert.equal(first.code, WEBRTC_POOL_CODE.PEER_KEY_MISSING);
    assert.equal(pool.diagnostics().peers[0].last_error.code, WEBRTC_POOL_CODE.PEER_KEY_MISSING);
    const second = await pool.ensure('machine-b');
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(pool.diagnostics().peers[0].ok, true);
    await pool.stop();
  });

  it('resolves and caches a peer key from the relay record', async () => {
    let reads = 0;
    const resolver = createRelayPeerKeyResolver({
      ttlMs: PEER_KEY_CACHE_TTL_MS,
      getJson: async (path) => {
        reads += 1;
        assert.equal(path, '/v1/peer/machine-b');
        return { json: { peer: { static_key: makePeerKeys().b.publicKeyBase64 } } };
      },
    });
    const first = await resolver('machine-b');
    assert.equal(first.key.length > 0, true);
    assert.equal(first.source, 'relay');
    const second = await resolver('machine-b');
    assert.equal(second.source, 'cache');
    assert.equal(reads, 1);
  });

  it('does not cache a relay 404 as a key', async () => {
    const resolver = createRelayPeerKeyResolver({
      getJson: async () => {
        throw new Error('no live P2P announcement for machine-x');
      },
    });
    const answer = await resolver('machine-x');
    assert.equal(answer.key, null);
    assert.match(answer.error, /no live P2P announcement/);
  });

  it('is reachable through the package-facing lib seam', async () => {
    const seam = await import('../lib/p2p-webrtc-pool.js');
    assert.equal(typeof seam.createWebRtcTransportPool, 'function');
    assert.equal(typeof seam.WebRtcTransportPool, 'function');
    assert.equal(typeof seam.createRelayPeerKeyResolver, 'function');
    assert.equal(seam.pairRole('machine-a', 'machine-b'), 'host');
  });

  it('requires machineId and signalUrl, and returns a named bad-config result', () => {
    const built = createWebRtcTransportPool({});
    assert.equal(built.ok, false);
    assert.equal(built.code, 'WEBRTC_POOL_BAD_CONFIG');
    assert.match(built.detail, /machineId and signalUrl are required/);
  });
});
