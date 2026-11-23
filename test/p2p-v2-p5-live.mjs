/**
 * P5 live proof: real WebTorrent over two real `webrtc-v1` pools.
 *
 * The WebRTC engine is the deterministic in-process fake; signaling, Noise, framing, the shared
 * pool, the tagged multiplex, WebTorrent metadata exchange and real file pieces are real. The two
 * sizes below are the P5 byte-for-byte row: 256 KiB and 1 MiB.
 *
 *   W2M_WEBTORRENT_MODULE=E:/path/node_modules/webtorrent/index.js \
 *     node --test --test-force-exit test/p2p-v2-p5-live.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
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

async function waitFor(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms`);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Write the deterministic payload without holding the whole file in a Buffer. */
function writePatternFile(file, bytes) {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(Math.min(bytes, 1024 * 1024));
  for (let start = 0; start < bytes; start += chunk.length) {
    const length = Math.min(chunk.length, bytes - start);
    for (let index = 0; index < length; index += 1) chunk[index] = ((start + index) * 31 + 17) % 251;
    const slice = chunk.subarray(0, length);
    hash.update(slice);
    writeFileSync(file, slice, { flag: start === 0 ? 'w' : 'a' });
  }
  return hash.digest('hex');
}

async function sampleRssWhile(promise) {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 50);
  timer.unref?.();
  try {
    return { value: await promise, peak };
  } finally {
    clearInterval(timer);
  }
}

async function transferOneFile({ WebTorrent, bytes, label }) {
  const streamContent = bytes >= 100 * 1024 * 1024;
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
    new WebTorrent({ tracker: false, dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false });
  const base = mkdtempSync(join(tmpdir(), `w2m-p2p-v2-p5-live-${label}-`));
  const cfg = normalizePluginConfig({
    readyTimeoutMs: 60_000,
    metadataTimeoutMs: 30_000,
    stateDir: join(base, 'state'),
    downloadRoot: join(base, 'downloads'),
    allowedRoots: [base],
  });
  const serviceA = new P2PV2Service(cfg, { getPool: () => poolA, webTorrentFactory: factory });
  const serviceB = new P2PV2Service(cfg, { getPool: () => poolB, webTorrentFactory: factory });
  const seedDir = join(base, 'seed');
  const destDir = join(base, 'dest');
  mkdirSync(seedDir);
  mkdirSync(destDir);
  const contentPath = join(seedDir, 'payload.bin');
  let content = null;
  let contentSha = null;
  if (streamContent) {
    contentSha = writePatternFile(contentPath, bytes);
  } else {
    content = Buffer.alloc(bytes);
    for (let index = 0; index < content.length; index += 1) content[index] = (index * 31 + 17) % 251;
    contentSha = sha256(content);
    writeFileSync(contentPath, content);
  }

  try {
    process.stderr.write(`[p5-live] ${label} sharing\n`);
    assert.equal(pairRoom('machine-a', 'machine-b'), pairRoom('machine-b', 'machine-a'));
    const shared = await serviceA.share({ path: join(seedDir, 'payload.bin'), name: 'payload.bin' });
    process.stderr.write(`[p5-live] ${label} shared\n`);
    assert.equal(shared.ok, true, JSON.stringify(shared));
    const [attached, added] = await Promise.all([
      serviceA.attach({ share_id: shared.share.share_id, machine_id: 'machine-b' }),
      serviceB.add({ magnet: shared.share.magnet_uri, path: destDir, peers: ['machine-a'] }),
    ]);
    process.stderr.write(`[p5-live] ${label} attached\n`);
    assert.equal(attached.ok, true, JSON.stringify(attached));
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.share.mode, 'download');

    const progressSamples = [];
    await waitFor(() => {
      const share = serviceB.status().shares[0];
      if (share !== undefined && share.progress > 0 && share.progress < 1) progressSamples.push(share.progress);
      return share?.done === true;
    }, bytes >= 100 * 1024 * 1024 ? 600_000 : 120_000);

    const gotPath = join(destDir, 'payload.bin');
    if (content === null) {
      assert.equal(await sha256File(gotPath), contentSha);
      assert.equal(statSync(gotPath).size, bytes);
    } else {
      const got = readFileSync(gotPath);
      assert.equal(got.length, content.length);
      assert.equal(sha256(got), contentSha);
    }
    const status = serviceB.status();
    assert.equal(status.shares[0].progress, 1);
    assert.equal(status.shares[0].done, true);
    assert.equal(status.shares[0].peers[0].state, 'open');
    return { progressSamples, status };
  } finally {
    await serviceA.stopAll();
    await serviceB.stopAll();
    await poolA.stop();
    await poolB.stop();
    network.close();
    await server.close();
  }
}

describe('p2p v2 P5 live WebTorrent over webrtc-v1', { skip }, () => {
  const onlyLarge = process.env.W2M_P5_ONLY_LARGE === '1';
  const smallSkip = onlyLarge ? 'W2M_P5_ONLY_LARGE=1 runs only the 100 MiB row' : false;
  it('moves 256 KiB byte-for-byte', { skip: smallSkip }, async () => {
    const loaded = await loadWebTorrentModule({ modulePath: MODULE_PATH });
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    await transferOneFile({ WebTorrent: loaded.WebTorrent, bytes: 256 * 1024, label: '256k' });
  });

  it('moves 1 MiB byte-for-byte', { skip: smallSkip }, async () => {
    const loaded = await loadWebTorrentModule({ modulePath: MODULE_PATH });
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    await transferOneFile({ WebTorrent: loaded.WebTorrent, bytes: 1024 * 1024, label: '1m' });
  });

  const largeSkip = process.env.W2M_P5_LARGE === '1' ? false : 'set W2M_P5_LARGE=1 to run the 100 MiB row';
  it('moves 100 MiB with observable progress and bounded RSS', { skip: largeSkip }, async () => {
    const loaded = await loadWebTorrentModule({ modulePath: MODULE_PATH });
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    const rssBefore = process.memoryUsage().rss;
    const { value, peak } = await sampleRssWhile(
      transferOneFile({
        WebTorrent: loaded.WebTorrent,
        bytes: 100 * 1024 * 1024,
        label: '100m',
      }),
    );
    const { progressSamples } = value;
    const rssGrowth = Math.max(peak, process.memoryUsage().rss) - rssBefore;
    assert.ok(progressSamples.length >= 2, `expected progress samples, got ${progressSamples.length}`);
     assert.ok(progressSamples.every((value, index) => index === 0 || value >= progressSamples[index - 1]));
    // The payload is written to disk and hashed as a stream, so the transfer must not hold another
    // 100 MiB source copy. The fake WebRTC network still queues pieces in-process; the envelope is
    // 256 MiB so a genuine second full-file copy or an unbounded queue fails the row.
    assert.ok(rssGrowth < 256 * 1024 * 1024, `RSS grew ${rssGrowth} bytes`);
  });
});
