/**
 * P5 integration matrix: 2 seeds + 2 leechers over four independent `webrtc-v1` bindings.
 *
 * This test isolates orchestration and finalization from the torrent engine and the native WebRTC
 * addon. Every seed and leecher has its own service, transport binding and device key. The pool is a
 * deterministic byte plane: it records peers and accepts sends, but does not open a real socket.
 * The torrent engine is a deterministic content registry so the row can assert two complete,
 * byte-identical files without starting four native WebTorrent clients in one process.
 *
 * Real WebTorrent + real `webrtc-v1` bytes are covered separately by `p2p-v2-p5-live.mjs` and the
 * real-provider worker harness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { P2PV2Service } from '../src/agent/webtorrent/service.mjs';
import { normalizePluginConfig } from '../src/plugin/p2p-v2-plugin.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function infoHashFor(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

function fakeTorrent({ infoHash, content, name = 'payload.bin', done = true }) {
  const torrent = new EventEmitter();
  torrent.infoHash = infoHash;
  torrent.infoHashBuffer = Buffer.from(infoHash, 'hex');
  torrent.magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
  torrent.name = name;
  torrent.length = content.length;
  torrent.downloaded = done ? content.length : 0;
  torrent.uploaded = 0;
  torrent.progress = done ? 1 : 0;
  torrent.done = done;
  torrent.numPeers = 0;
  torrent.downloadSpeed = 0;
  torrent.uploadSpeed = 0;
  torrent.files = [{ name, path: name, length: content.length }];
  torrent.addPeer = () => {};
  torrent.destroy = () => {};
  return torrent;
}

/**
 * A content registry shared by four services. `seed()` publishes bytes; `add()` copies those bytes
 * into the staging directory after the service has attached its peer, then emits `done`.
 */
function createFakeEngineFactory(registry) {
  return ({ cfg: _cfg }) => {
    const client = new EventEmitter();
    client.seed = (source, _opts, callback) => {
      const content = readFileSync(source);
      const infoHash = infoHashFor(content);
      const name = source.split(/[\\/]/).pop();
      registry.set(infoHash, { content, name });
      const torrent = fakeTorrent({ infoHash, content, name, done: true });
      queueMicrotask(() => callback(torrent));
      return torrent;
    };
    client.add = (magnet, opts = {}) => {
      const match = /btih:([0-9a-f]{40})/i.exec(String(magnet));
      assert.ok(match, `fake engine: invalid magnet ${magnet}`);
      const infoHash = match[1].toLowerCase();
      const entry = registry.get(infoHash);
      const staging = opts.path;
      const torrent = fakeTorrent({
        infoHash,
        content: entry?.content ?? Buffer.alloc(0),
        name: entry?.name ?? 'payload.bin',
        done: false,
      });
      setTimeout(() => {
        if (entry !== undefined && typeof staging === 'string') {
          mkdirSync(staging, { recursive: true });
          writeFileSync(join(staging, entry.name), entry.content);
          torrent.downloaded = entry.content.length;
          torrent.progress = 1;
          torrent.done = true;
          torrent.numPeers = 1;
          torrent.emit('done');
        }
      }, 250).unref?.();
      queueMicrotask(() => torrent.emit('ready'));
      return torrent;
    };
    client.destroy = () => {};
    return client;
  };
}

/**
 * A deterministic byte plane with the same small surface the `webrtc-v1` binding requires. It
 * accepts every peer and records frames; it never opens a socket.
 */
function makeFakePool(machineId) {
  const handlers = new Set();
  const peers = new Set();
  const frames = [];
  return {
    machineId,
    async ensure(peer) {
      peers.add(peer);
      return { ok: true, peer, role: machineId < peer ? 'host' : 'client' };
    },
    async send(peer, payload) {
      frames.push({ peer, bytes: payload.length });
      return { ok: true, peer, bytes: payload.length };
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    diagnostics() {
      return { peer_count: peers.size, frames: frames.length };
    },
  };
}

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms`);
}

describe('P5 integration: two seeds and two leechers', () => {
  it('delivers a complete, SHA-256-identical file to both leechers', async () => {
    const ids = ['seed-a', 'seed-b', 'leech-c', 'leech-d'];
    const registry = new Map();
    const engineFactory = createFakeEngineFactory(registry);
    const base = mkdtempSync(join(tmpdir(), 'w2m-p5-integration-'));
    const cfgFor = (id) =>
      normalizePluginConfig({
        readyTimeoutMs: 20_000,
        metadataTimeoutMs: 10_000,
        stateDir: join(base, id, 'state'),
        downloadRoot: join(base, id, 'downloads'),
        allowedRoots: [base],
      });

    const seedDir = join(base, 'seed');
    mkdirSync(seedDir);
    const content = Buffer.alloc(1024 * 1024, 0);
    for (let index = 0; index < content.length; index += 1) content[index] = (index * 13 + 5) % 251;
    writeFileSync(join(seedDir, 'payload.bin'), content);
    const digest = sha256(content);

    const pools = Object.fromEntries(ids.map((id) => [id, makeFakePool(id)]));
    const services = Object.fromEntries(
      ids.map((id) => [id, new P2PV2Service(cfgFor(id), { getPool: () => pools[id], webTorrentFactory: engineFactory })]),
    );

    try {
      const seedA = await services['seed-a'].share({ path: join(seedDir, 'payload.bin'), name: 'payload.bin' });
      const seedB = await services['seed-b'].share({ path: join(seedDir, 'payload.bin'), name: 'payload.bin' });
      assert.equal(seedA.ok, true, JSON.stringify(seedA));
      assert.equal(seedB.ok, true, JSON.stringify(seedB));
      assert.equal(seedA.share.info_hash, seedB.share.info_hash);
      const magnet = seedA.share.magnet_uri;

      const destC = join(base, 'leech-c', 'dest');
      const destD = join(base, 'leech-d', 'dest');
      const [attachedC, addedC, attachedD, addedD] = await Promise.all([
        services['seed-a'].attach({ share_id: seedA.share.share_id, machine_id: 'leech-c' }),
        services['leech-c'].add({ magnet, path: destC, peers: ['seed-a'] }),
        services['seed-b'].attach({ share_id: seedB.share.share_id, machine_id: 'leech-d' }),
        services['leech-d'].add({ magnet, path: destD, peers: ['seed-b'] }),
      ]);

      for (const result of [attachedC, addedC, attachedD, addedD]) {
        assert.equal(result.ok, true, JSON.stringify(result));
      }
      assert.equal(addedC.share.transport, 'webrtc-v1');
      assert.equal(addedD.share.transport, 'webrtc-v1');

      await waitFor(() => services['leech-c'].status().shares[0]?.done === true, 5_000);
      await waitFor(() => services['leech-d'].status().shares[0]?.done === true, 5_000);

      const fileC = join(destC, 'payload.bin');
      const fileD = join(destD, 'payload.bin');
      assert.equal(sha256(readFileSync(fileC)), digest);
      assert.equal(sha256(readFileSync(fileD)), digest);
      assert.equal(readFileSync(fileC).length, content.length);
      assert.equal(readFileSync(fileD).length, content.length);
      assert.equal(services['leech-c'].status().shares[0].finalized, true);
      assert.equal(services['leech-d'].status().shares[0].finalized, true);
    } finally {
      // The deterministic pool owns no socket; stopAll() would wait on transport shutdown that
      // this row deliberately does not exercise. Test-force-exit clears the remaining timers.
      void Promise.allSettled(Object.values(services).map((service) => service.stopAll()));
    }
  });
});
