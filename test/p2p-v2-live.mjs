/**
 * Optional live proof: real WebTorrent over two real `webrtc-v1` pools.
 *
 * This suite is intentionally outside the default `test` script: WebTorrent is an optional engine
 * by project policy. Run it with a separately installed engine:
 *
 *   W2M_WEBTORRENT_MODULE=E:/path/node_modules/webtorrent/index.js \
 *     node --test --test-force-exit test/p2p-v2-live.mjs
 *
 * The WebRTC engine is still the deterministic fake; signaling, Noise, framing, the shared pool,
 * the tagged multiplex, WebTorrent metadata exchange and real file pieces are all real.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignalingServer } from '../src/agent/webrtc/signaling-server.mjs';
import { createWebRtcTransport } from '../src/agent/webrtc/transport.mjs';
import { WebRtcTransportPool, pairRoom } from '../src/agent/webrtc/pool.mjs';
import { createFakeWebRtcNetwork, makePeerKeys } from './helpers/fake-webrtc-engine.mjs';
import { P2PV2Service } from '../src/agent/webtorrent/service.mjs';
import { loadWebTorrentModule } from '../src/agent/webtorrent/engine.mjs';
import { normalizePluginConfig } from '../src/plugin/p2p-v2-plugin.mjs';

const MODULE_PATH = process.env.W2M_WEBTORRENT_MODULE ?? '';
const skip = MODULE_PATH === '' ? 'set W2M_WEBTORRENT_MODULE to a WebTorrent entry file' : false;

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

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms`);
}

describe('p2p v2 live WebTorrent over webrtc-v1', { skip }, () => {
  it('moves a real file between two services and two pool instances', async () => {
    const loaded = await loadWebTorrentModule({ modulePath: MODULE_PATH });
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    const WebTorrent = loaded.WebTorrent;

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
    const factory = () =>
      new WebTorrent({
        tracker: false,
        dht: false,
        lsd: false,
        utp: false,
        natUpnp: false,
        natPmp: false,
      });
    const cfg = normalizePluginConfig({ readyTimeoutMs: 30_000, metadataTimeoutMs: 15_000 });
    const serviceA = new P2PV2Service(cfg, { getPool: () => poolA, webTorrentFactory: factory });
    const serviceB = new P2PV2Service(cfg, { getPool: () => poolB, webTorrentFactory: factory });

    const base = mkdtempSync(join(tmpdir(), 'w2m-p2p-v2-live-'));
    const seedDir = join(base, 'seed');
    const destDir = join(base, 'dest');
    mkdirSync(seedDir);
    mkdirSync(destDir);
    const content = Buffer.alloc(256 * 1024, 11);
    writeFileSync(join(seedDir, 'payload.bin'), content);

    try {
      assert.equal(pairRoom('machine-a', 'machine-b'), pairRoom('machine-b', 'machine-a'));
      const shared = await serviceA.share({ path: join(seedDir, 'payload.bin'), name: 'payload.bin' });
      assert.equal(shared.ok, true, JSON.stringify(shared));
      assert.equal(shared.share.mode, 'seed');

      const [attached, added] = await Promise.all([
        serviceA.attach({ share_id: shared.share.share_id, machine_id: 'machine-b' }),
        serviceB.add({
          magnet: shared.share.magnet_uri,
          path: destDir,
          peers: ['machine-a'],
        }),
      ]);
      assert.equal(attached.ok, true, JSON.stringify(attached));
      assert.equal(added.ok, true, JSON.stringify(added));
      assert.equal(added.share.mode, 'download');

      await waitFor(() => {
        const status = serviceB.status();
        return status.shares[0]?.done === true;
      });
      const got = readFileSync(join(destDir, 'payload.bin'));
      assert.equal(got.length, content.length);
      assert.deepEqual(got, content);
      const status = serviceB.status();
      assert.equal(status.shares[0].progress, 1);
      assert.equal(status.shares[0].peers.length, 1);
      assert.equal(status.shares[0].peers[0].state, 'open');
      // The pool is borrowed: stopping the share must not close the peer.
      const before = poolB.diagnostics().peer_count;
      await serviceB.stopAll();
      assert.equal(poolB.diagnostics().peer_count, before);
    } finally {
      await serviceA.stopAll();
      await serviceB.stopAll();
      await poolA.stop();
      await poolB.stop();
      network.close();
      await server.close();
    }
  });
});
