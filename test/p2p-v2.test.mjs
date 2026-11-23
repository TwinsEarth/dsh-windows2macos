/**
 * P2P V2 core: tagged multiplex, the V1-to-WebTorrent stream adapter, the share/attach lifecycle
 * and the inert Cordis mount. The WebTorrent engine is a deterministic fake here; the live
 * WebTorrent-over-real-V1 proof is `test/p2p-v2-live.mjs` behind its own optional script.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TORRENT_FRAME_HEADER_BYTES,
  TORRENT_FRAME_MAGIC,
  decodeTorrentFrame,
  encodeTorrentFrame,
  isTorrentFrame,
  normalizeInfoHash,
  shareIdFor,
} from '../src/agent/webtorrent/multiplex.mjs';
import { createTorrentPeerAdapter } from '../src/agent/webtorrent/peer-adapter.mjs';
import { P2PV2Service, P2P_V2_CODE } from '../src/agent/webtorrent/service.mjs';
import {
  TORRENT_DEFAULT_TRANSPORT,
  TORRENT_TRANSPORT_CODE,
  createTorrentTransportRegistry,
  getTorrentTransport,
} from '../src/agent/webtorrent/transports/registry.mjs';
import {
  WEBRTC_V1_TRANSPORT_CODE,
  createWebRtcV1Transport,
} from '../src/agent/webtorrent/transports/webrtc-v1.mjs';
import {
  apply,
  buildTools,
  normalizePluginConfig,
  P2P_V2_ROW_ID,
  TOOL_NAMES,
} from '../src/plugin/p2p-v2-plugin.mjs';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');

function patchRow(id) {
  const lines = patch.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(`- id: ${id}`));
  assert.ok(start >= 0, `row ${id} is missing from cordis.patch.yml`);
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    if (index > start && /^ {4}- id:/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join('\n');
}

function json(value) {
  return JSON.parse(value);
}

function fakeTorrent(infoHash, name = 'sample.bin') {
  const torrent = new EventEmitter();
  torrent.infoHash = infoHash;
  torrent.infoHashBuffer = Buffer.from(infoHash, 'hex');
  torrent.magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${name}`;
  torrent.name = name;
  torrent.length = 1024;
  torrent.downloaded = 0;
  torrent.uploaded = 0;
  torrent.progress = 0;
  torrent.done = false;
  torrent.numPeers = 0;
  torrent.downloadSpeed = 0;
  torrent.uploadSpeed = 0;
  torrent.files = [{ name, path: name, length: 1024 }];
  torrent.added = [];
  torrent.removed = [];
  torrent.destroyed = false;
  torrent.addPeer = (peer) => {
    torrent.added.push(peer);
    torrent.numPeers += 1;
    return peer;
  };
  torrent.removePeer = (peer) => {
    torrent.removed.push(peer);
    torrent.numPeers = Math.max(0, torrent.numPeers - 1);
  };
  torrent.destroy = (callback) => {
    torrent.destroyed = true;
    setTimeout(() => callback?.(), 0);
  };
  return torrent;
}

function fakeClient() {
  const client = new EventEmitter();
  client.torrents = [];
  client.seed = (source, _opts, callback) => {
    const torrent = fakeTorrent(HASH_A, 'sample.bin');
    client.torrents.push(torrent);
    setTimeout(() => {
      torrent.done = true;
      torrent.progress = 1;
      callback(torrent);
    }, 0);
    return torrent;
  };
  client.add = (magnet) => {
    const hash = String(magnet).includes(HASH_B) ? HASH_B : HASH_A;
    const torrent = fakeTorrent(hash, 'sample.bin');
    torrent.done = false;
    client.torrents.push(torrent);
    setTimeout(() => {
      torrent.emit('infoHash');
      torrent.emit('ready');
    }, 0);
    return torrent;
  };
  client.destroy = (callback) => {
    client.destroyed = true;
    setTimeout(() => callback?.(), 0);
  };
  return client;
}

function fakePool(machineId = 'machine-a') {
  const handlers = new Set();
  const sent = [];
  const connected = new Map();
  const failures = new Set();
  const pool = {
    machineId,
    sent,
    ensureCalls: [],
    closed: false,
    connected,
    failures,
    failPeer(peer) {
      failures.add(peer);
    },
    connectPeer(peer, patch = {}) {
      connected.set(peer, {
        peer,
        role: 'client',
        state: 'connected',
        ok: true,
        path: 'direct',
        rtt_ms: 12,
        secure: 'dtls',
        sends: 3,
        bytes_sent: 512,
        last_error: null,
        ...patch,
      });
    },
    async ensure(peer) {
      pool.ensureCalls.push(peer);
      if (failures.has(peer)) {
        return { ok: false, code: 'WEBRTC_PEER_UNREACHABLE', detail: `${peer} is offline` };
      }
      return { ok: true, peer };
    },
    async send(peer, payload) {
      sent.push({ peer, payload });
      return { ok: true, peer, bytes: Buffer.byteLength(payload) };
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(peer, payload) {
      for (const handler of handlers) handler({ peer, payload });
    },
    diagnostics() {
      return {
        peer_count: connected.size,
        closed: pool.closed,
        peers: [...connected.values()],
        signal_url: 'wss://signal.example/room?token=secret-token',
        signal_token: '<redacted>',
      };
    },
    closePeer: () => {
      pool.closed = true;
    },
  };
  return pool;
}

/** A transport with the same byte-plane contract as `webrtc-v1`, but no pool behind it. */
function fakeTransport(name = 'fake-p1', machineId = 'machine-a') {
  const handlers = new Set();
  const sent = [];
  const calls = { ensure: [], send: [], destroy: 0 };
  const transport = {
    name,
    machineId,
    sent,
    calls,
    async ensure(peer) {
      calls.ensure.push(peer);
      return { ok: true, peer };
    },
    async send(peer, payload) {
      calls.send.push({ peer, payload });
      sent.push({ peer, payload });
      return { ok: true, peer, bytes: Buffer.byteLength(payload) };
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(event) {
      for (const handler of [...handlers]) handler(event);
    },
    destroy() {
      calls.destroy += 1;
      handlers.clear();
      return { ok: true };
    },
  };
  return transport;
}

function tempFile(name = 'sample.bin') {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-p2p-v2-'));
  writeFileSync(join(dir, name), Buffer.alloc(1024, 7));
  return { dir, path: join(dir, name) };
}

function fakeContext() {
  const definitions = [];
  const registered = [];
  const effects = [];
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (definition) => { definitions.push(definition); registered.push(definition.name); } },
    inject: (services, callback) => callback({ tools: { register: (definition) => ctx.tools.register(definition) } }),
    effect: (setup) => effects.push(setup),
  };
  return { ctx, definitions, registered, effects };
}

describe('p2p v2 multiplex', () => {
  it('round-trips one info hash without touching JSON frames', () => {
    const chunk = Buffer.from('bit torrent wire bytes');
    const frame = encodeTorrentFrame(HASH_A, chunk);
    assert.equal(frame.length, TORRENT_FRAME_HEADER_BYTES + chunk.length);
    assert.equal(frame.subarray(0, TORRENT_FRAME_MAGIC.length).equals(TORRENT_FRAME_MAGIC), true);
    assert.deepEqual(decodeTorrentFrame(frame), { infoHash: HASH_A, payload: chunk });
    assert.equal(isTorrentFrame(frame), true);
    assert.equal(isTorrentFrame(Buffer.from('{"type":"task.offer"}')), false);
    assert.equal(decodeTorrentFrame(Buffer.from('W2MT2\u0000short')), null);
    assert.equal(normalizeInfoHash(HASH_A.toUpperCase()), HASH_A);
    assert.equal(normalizeInfoHash(Buffer.from(HASH_A, 'hex')), HASH_A);
    assert.equal(shareIdFor(HASH_A), shareIdFor(HASH_A));
  });

  it('refuses a bad hash or an oversized chunk before putting bytes on the pool', () => {
    assert.throws(() => encodeTorrentFrame('not-a-hash', Buffer.from('x')), /infoHash/);
    assert.throws(() => encodeTorrentFrame(HASH_A, Buffer.alloc(0)), /empty chunk/);
  });
});

describe('p2p v2 transports', () => {
  it('registers webrtc-v1 by default and refuses an unknown name by code', () => {
    assert.equal(TORRENT_DEFAULT_TRANSPORT, 'webrtc-v1');
    const definition = getTorrentTransport(TORRENT_DEFAULT_TRANSPORT);
    assert.equal(definition.name, 'webrtc-v1');
    assert.equal(typeof definition.create, 'function');
    assert.equal(getTorrentTransport('webrtc-v1').create, definition.create);
    assert.throws(
      () => getTorrentTransport('no-such-transport'),
      (error) => error.code === TORRENT_TRANSPORT_CODE.UNKNOWN,
    );

    const registry = createTorrentTransportRegistry();
    const fake = { name: 'fake-reg', create: () => fakeTransport('fake-reg') };
    const registered = registry.register('fake-reg', fake);
    assert.equal(registered.name, 'fake-reg');
    assert.equal(registered.create, fake.create);
    assert.equal(registry.get('fake-reg').create, fake.create);
    assert.throws(
      () => registry.get('missing'),
      (error) => error.code === TORRENT_TRANSPORT_CODE.UNKNOWN,
    );
  });

  it('forwards ensure/send/onMessage to the pool and destroys only its binding', async () => {
    const pool = fakePool();
    const transport = createWebRtcV1Transport({ pool });
    const seen = [];
    const stop = transport.onMessage((event) => seen.push(event));

    assert.deepEqual(await transport.ensure('machine-b'), { ok: true, peer: 'machine-b' });
    assert.deepEqual(pool.ensureCalls, ['machine-b']);
    const sent = await transport.send('machine-b', Buffer.from('raw-bytes'));
    assert.equal(sent.ok, true);
    assert.equal(pool.sent[0].peer, 'machine-b');
    assert.equal(pool.sent[0].payload.toString(), 'raw-bytes');

    pool.emit('machine-b', Buffer.from('pool-incoming'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].payload.toString(), 'pool-incoming');

    stop();
    pool.emit('machine-b', Buffer.from('after-stop'));
    assert.equal(seen.length, 1);

    const destroyed = transport.destroy();
    assert.equal(destroyed.ok, true);
    assert.equal(pool.closed, false);
    assert.equal(transport.destroyed, true);
    const afterDestroy = await transport.send('machine-b', Buffer.from('nope'));
    assert.equal(afterDestroy.ok, false);
    assert.equal(afterDestroy.code, WEBRTC_V1_TRANSPORT_CODE.CLOSED);
  });
});

describe('p2p v2 peer adapter', () => {
  it('writes tagged frames through the transport and feeds decoded bytes back into the Duplex', async () => {
    const pool = fakePool();
    const transport = createWebRtcV1Transport({ pool });
    const adapter = createTorrentPeerAdapter({
      peer: 'machine-b',
      infoHash: HASH_A,
      transport,
      writeTimeoutMs: 100,
    });
    const received = [];
    adapter.on('data', (chunk) => received.push(chunk));
    await new Promise((resolve, reject) => {
      adapter.write(Buffer.from('outgoing'), (error) => (error ? reject(error) : resolve()));
    });
    assert.equal(pool.sent.length, 1);
    assert.equal(pool.sent[0].peer, 'machine-b');
    const decoded = decodeTorrentFrame(pool.sent[0].payload);
    assert.equal(decoded.infoHash, HASH_A);
    assert.equal(decoded.payload.toString(), 'outgoing');

    const incoming = encodeTorrentFrame(HASH_A, Buffer.from('incoming'));
    adapter.feed(decodeTorrentFrame(incoming).payload);
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(received[0].toString(), 'incoming');
    assert.equal(adapter.stats.chunks_in, 1);
    adapter.destroy();
  });

  it('does not close the shared pool when the logical torrent stream is destroyed', () => {
    const pool = fakePool();
    const transport = createWebRtcV1Transport({ pool });
    const adapter = createTorrentPeerAdapter({ peer: 'machine-b', infoHash: HASH_A, transport });
    adapter.destroy();
    assert.equal(pool.closed, false);
    assert.equal(transport.destroyed, false);
  });

  it('sends and receives on a fake transport without the adapter owning it', async () => {
    const transport = fakeTransport();
    const adapter = createTorrentPeerAdapter({ peer: 'machine-b', infoHash: HASH_A, transport });
    const received = [];
    const stop = transport.onMessage((event) => {
      const decoded = decodeTorrentFrame(event.payload);
      if (decoded !== null && decoded.infoHash === HASH_A) adapter.feed(decoded.payload);
    });
    adapter.on('data', (chunk) => received.push(chunk));

    await new Promise((resolve, reject) => {
      adapter.write(Buffer.from('fake-outgoing'), (error) => (error ? reject(error) : resolve()));
    });
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].peer, 'machine-b');
    assert.equal(decodeTorrentFrame(transport.sent[0].payload).payload.toString(), 'fake-outgoing');

    transport.emit({ peer: 'machine-b', payload: encodeTorrentFrame(HASH_A, Buffer.from('fake-incoming')) });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(received[0].toString(), 'fake-incoming');
    assert.equal(adapter.transport, 'fake-p1');

    stop();
    adapter.destroy();
    assert.equal(transport.calls.destroy, 0);
  });
});

describe('p2p v2 service', () => {
  it('seeds a real local file through an injected engine and returns a magnet', async () => {
    const { path } = tempFile();
    const client = fakeClient();
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => fakePool(),
      webTorrentFactory: () => client,
    });
    const result = await service.share({ path, name: 'sample.bin' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.share.info_hash, HASH_A);
    assert.match(result.share.magnet_uri, /^magnet:\?xt=urn:btih:/);
    assert.equal(service.status().engine.available, true);
    await service.stopAll();
    assert.equal(client.destroyed, true);
  });

  it('adds a torrent, attaches the V1 peer before metadata settles, and detaches without closing', async () => {
    const { dir } = tempFile();
    const pool = fakePool();
    const client = fakeClient();
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => pool,
      webTorrentFactory: () => client,
    });
    const added = await service.add({
      magnet: `magnet:?xt=urn:btih:${HASH_B}&dn=sample.bin`,
      path: dir,
      peers: ['machine-b'],
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.metadata_ready, true, JSON.stringify(added));
    assert.equal(added.share.info_hash, HASH_B);
    assert.equal(added.share.peers.length, 1);
    assert.equal(pool.ensureCalls[0], 'machine-b');
    assert.equal(client.torrents[0].added.length, 1);
    assert.equal(client.torrents[0].added[0].id, 'machine-b');

    const detached = await service.detach({ share_id: added.share.share_id, machine_id: 'machine-b' });
    assert.equal(detached.ok, true, JSON.stringify(detached));
    assert.equal(pool.closed, false);
    assert.equal(client.torrents[0].removed[0].id, 'machine-b');
    await service.stopAll();
    assert.equal(pool.closed, false);
  });

  it('names a missing optional engine and stays mounted', async () => {
    const service = new P2PV2Service(
      normalizePluginConfig({}),
      { getPool: () => fakePool(), webTorrentModule: join(tmpdir(), 'w2m-no-such-webtorrent.mjs') },
    );
    const { path } = tempFile();
    const result = await service.share({ path });
    assert.equal(result.ok, false);
    assert.equal(result.code, P2P_V2_CODE.ENGINE_UNAVAILABLE, JSON.stringify(result));
    assert.equal(service.status().engine.available, false);
  });

  it('reuses an active share and refuses a share limit before loading the engine', async () => {
    const { path } = tempFile();
    const client = fakeClient();
    const service = new P2PV2Service(normalizePluginConfig({ maxShares: 1 }), {
      getPool: () => fakePool(),
      webTorrentFactory: () => client,
    });
    assert.equal((await service.share({ path })).ok, true);
    const again = await service.share({ path });
    assert.equal(again.ok, true, JSON.stringify(again));
    const second = await service.share({ path: tempFile('other.bin').path });
    assert.equal(second.ok, false);
    assert.equal(second.code, P2P_V2_CODE.SHARE_LIMIT);
    await service.stopAll();
  });

  it('refuses an unknown transport by name before touching paths or the engine', async () => {
    const client = fakeClient();
    let factoryCalls = 0;
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => fakePool(),
      webTorrentFactory: () => {
        factoryCalls += 1;
        return client;
      },
    });
    const { path } = tempFile();
    const badShare = await service.share({ path, transport: 'no-such-transport' });
    assert.equal(badShare.ok, false, JSON.stringify(badShare));
    assert.equal(badShare.code, P2P_V2_CODE.TRANSPORT_UNKNOWN);
    assert.equal(badShare.transport, 'no-such-transport');
    assert.equal(factoryCalls, 0);

    const missingDir = join(tmpdir(), `w2m-p2p-v2-missing-${process.pid}`);
    const badAdd = await service.add({
      magnet: `magnet:?xt=urn:btih:${HASH_B}`,
      path: missingDir,
      transport: 'no-such-transport',
    });
    assert.equal(badAdd.code, P2P_V2_CODE.TRANSPORT_UNKNOWN);
    assert.equal(existsSync(missingDir), false);

    const seeded = await service.share({ path });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const badAttach = await service.attach({
      share_id: seeded.share.share_id,
      machine_id: 'machine-b',
      transport: 'no-such-transport',
    });
    assert.equal(badAttach.code, P2P_V2_CODE.TRANSPORT_UNKNOWN);
    assert.equal(badAttach.transport, 'no-such-transport');
    await service.stopAll();
  });

  it('routes adapter bytes through a registered fake transport and never calls pool.ensure', async () => {
    const { path } = tempFile();
    const pool = fakePool();
    const client = fakeClient();
    const registry = createTorrentTransportRegistry();
    let created = null;
    registry.register('fake-p1', {
      name: 'fake-p1',
      create: () => {
        created = fakeTransport('fake-p1');
        return created;
      },
    });
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => pool,
      webTorrentFactory: () => client,
      transportRegistry: registry,
    });
    const shared = await service.share({ path, peers: ['machine-b'], transport: 'fake-p1' });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    assert.equal(shared.share.transport, 'fake-p1');
    assert.equal(shared.share.peers[0].transport, 'fake-p1');
    assert.deepEqual(created.calls.ensure, ['machine-b']);
    assert.equal(pool.ensureCalls.length, 0);

    const adapter = client.torrents[0].added[0];
    const received = [];
    adapter.on('data', (chunk) => received.push(chunk));
    await new Promise((resolve, reject) => {
      adapter.write(Buffer.from('service-outgoing'), (error) => (error ? reject(error) : resolve()));
    });
    assert.equal(created.sent.length, 1);
    assert.equal(decodeTorrentFrame(created.sent[0].payload).payload.toString(), 'service-outgoing');

    created.emit({ peer: 'machine-b', payload: encodeTorrentFrame(HASH_A, Buffer.from('service-incoming')) });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(received[0].toString(), 'service-incoming');
    assert.equal(service.status().transports.find((entry) => entry.name === 'fake-p1')?.active, true);

    await service.stopAll();
    assert.equal(created.calls.destroy, 1);
    assert.equal(pool.closed, false);
  });
});

describe('p2p v2 multi-peer orchestration', () => {
  it('attaches one seed with two leechers, dedupes peers, rejects self and reports swarm counts', async () => {
    const { path } = tempFile();
    const pool = fakePool();
    const client = fakeClient();
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => pool,
      webTorrentFactory: () => client,
    });
    const result = await service.share({
      path,
      peers: ['machine-b', 'machine-c', 'machine-b', 'machine-a'],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.peers_requested, 3);
    assert.equal(result.peers.length, 2, JSON.stringify(result.peers));
    assert.equal(result.peer_errors.length, 1, JSON.stringify(result.peer_errors));
    assert.equal(result.peer_errors[0].code, P2P_V2_CODE.PEER_SELF);
    assert.deepEqual(pool.ensureCalls, ['machine-b', 'machine-c']);
    assert.deepEqual(result.peers.map((peer) => peer.role), ['leecher', 'leecher']);

    const summary = result.share;
    assert.equal(summary.peer_count, 3);
    assert.equal(summary.seeders, 1);
    assert.equal(summary.leechers, 2);
    assert.equal(summary.swarm.peer_count, 3);
    assert.equal(summary.swarm.seeders, 1);
    assert.equal(summary.swarm.leechers, 2);
    assert.equal(summary.swarm.info_hash, HASH_A);
    assert.equal(summary.swarm.files.length, 1);
    assert.equal(summary.transport, 'webrtc-v1');

    const status = service.status();
    assert.equal(status.transport, 'webrtc-v1');
    assert.equal(status.peer_count, 2);
    assert.equal(status.shares[0].peer_count, 3);
    assert.equal(status.shares[0].seeders, 1);
    assert.equal(status.shares[0].leechers, 2);
    await service.stopAll();
  });

  it('joins two seeders from two leechers and reports both sides of the swarm', async () => {
    const seedA = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => fakePool('seed-a'),
      webTorrentFactory: () => fakeClient(),
    });
    const seedB = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => fakePool('seed-b'),
      webTorrentFactory: () => fakeClient(),
    });
    const sharedA = await seedA.share({ path: tempFile().path });
    const sharedB = await seedB.share({ path: tempFile().path });
    assert.equal(sharedA.ok, true, JSON.stringify(sharedA));
    assert.equal(sharedB.ok, true, JSON.stringify(sharedB));

    const leechers = [];
    for (const machineId of ['leech-a', 'leech-b']) {
      const pool = fakePool(machineId);
      const service = new P2PV2Service(normalizePluginConfig({}), {
        getPool: () => pool,
        webTorrentFactory: () => fakeClient(),
      });
      const added = await service.add({
        magnet: sharedA.share.magnet_uri,
        path: tempFile().dir,
        peers: ['seed-a', 'seed-b'],
      });
      assert.equal(added.ok, true, JSON.stringify(added));
      assert.equal(added.peers_requested, 2);
      assert.equal(added.peers.length, 2);
      assert.equal(added.peer_errors.length, 0);
      assert.deepEqual(pool.ensureCalls, ['seed-a', 'seed-b']);
      assert.equal(added.share.peer_count, 3);
      assert.equal(added.share.seeders, 2);
      assert.equal(added.share.leechers, 1);
      assert.equal(added.share.swarm.seeders, 2);
      leechers.push(service);
    }
    assert.equal(leechers.length, 2);
    for (const service of [...leechers, seedA, seedB]) await service.stopAll();
  });

  it('lets one unreachable peer fail while the rest attach', async () => {
    const { path } = tempFile();
    const pool = fakePool();
    pool.failPeer('machine-bad');
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => pool,
      webTorrentFactory: () => fakeClient(),
    });
    const shared = await service.share({
      path,
      peers: ['machine-good', 'machine-bad', 'machine-good2'],
    });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    assert.equal(shared.peers.length, 2);
    assert.equal(shared.peer_errors.length, 1);
    assert.equal(shared.peer_errors[0].code, P2P_V2_CODE.PEER_UNREACHABLE);
    assert.equal(shared.share.peer_count, 3);
    assert.equal(service.status().peer_count, 2);

    const addPool = fakePool('leech-a');
    addPool.failPeer('seed-bad');
    const leecher = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => addPool,
      webTorrentFactory: () => fakeClient(),
    });
    const added = await leecher.add({
      magnet: shared.share.magnet_uri,
      path: tempFile().dir,
      peers: ['seed-good', 'seed-bad'],
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.metadata_ready, true, JSON.stringify(added));
    assert.equal(added.peers.length, 1);
    assert.equal(added.peer_errors.length, 1);
    assert.equal(added.peer_errors[0].code, P2P_V2_CODE.PEER_UNREACHABLE);
    assert.equal(added.share.seeders, 1);
    assert.equal(added.share.leechers, 1);
    await service.stopAll();
    await leecher.stopAll();
  });

  it('names the aggregate failure and cleans up when every requested peer fails', async () => {
    const { dir } = tempFile();
    const pool = fakePool('leech-a');
    pool.failPeer('seed-a');
    pool.failPeer('seed-b');
    const client = fakeClient();
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => pool,
      webTorrentFactory: () => client,
    });
    const added = await service.add({
      magnet: `magnet:?xt=urn:btih:${HASH_B}&dn=sample.bin`,
      path: dir,
      peers: ['seed-a', 'seed-b'],
    });
    assert.equal(added.ok, false, JSON.stringify(added));
    assert.equal(added.code, P2P_V2_CODE.PEERS_UNREACHABLE);
    assert.equal(added.peers_requested, 2);
    assert.equal(added.peers.length, 0);
    assert.equal(added.peer_errors.length, 2);
    assert.deepEqual(added.cleanup_errors, []);
    assert.equal(service.status().shares.length, 0);
    assert.equal(service.status().peer_count, 0);
    assert.equal(client.torrents[0].destroyed, true);
    await service.stopAll();
  });

  it('refuses a new peer at the limit but keeps repeated attach idempotent', async () => {
    const { path } = tempFile();
    const pool = fakePool();
    const service = new P2PV2Service(normalizePluginConfig({ maxPeersPerShare: 1 }), {
      getPool: () => pool,
      webTorrentFactory: () => fakeClient(),
    });
    const shared = await service.share({ path });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    const first = await service.attach({ share_id: shared.share.share_id, machine_id: 'machine-b' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.role, 'leecher');
    const repeated = await service.attach({ share_id: shared.share.share_id, machine_id: 'machine-b' });
    assert.equal(repeated.ok, true);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.role, 'leecher');
    const overflow = await service.attach({ share_id: shared.share.share_id, machine_id: 'machine-c' });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.code, P2P_V2_CODE.PEER_LIMIT);
    assert.deepEqual(pool.ensureCalls, ['machine-b']);
    assert.equal(service.status().shares[0].peer_count, 2);
    await service.stopAll();
  });

  it('lists connected peers and attach state without dialing or leaking the signal token', async () => {
    const pool = fakePool();
    pool.connectPeer('machine-z', { role: 'server', last_error: { code: 'E_OLD' } });
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => pool,
      webTorrentFactory: () => fakeClient(),
    });
    const view = service.peers();
    assert.equal(view.ok, true);
    assert.equal(view.pool.available, true);
    assert.equal(view.pool.peer_count, 1);
    assert.equal(view.pool.peers[0].peer, 'machine-z');
    assert.equal(view.pool.peers[0].role, 'server');
    assert.equal(view.pool.peers[0].last_error.code, 'E_OLD');
    assert.deepEqual(pool.ensureCalls, []);
    const serialised = JSON.stringify(view);
    assert.equal(serialised.includes('secret-token'), false);
    assert.equal(serialised.includes('signal_url'), false);
    assert.equal(serialised.includes('signal_token'), false);

    pool.connectPeer('machine-b');
    const shared = await service.share({ path: tempFile().path, peers: ['machine-b'] });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    const before = pool.ensureCalls.length;
    const scoped = service.peers({ share_id: shared.share.share_id });
    assert.equal(scoped.ok, true);
    assert.equal(scoped.shares.length, 1);
    assert.equal(scoped.shares[0].peers.length, 1);
    assert.equal(scoped.shares[0].peers[0].role, 'leecher');
    assert.equal(pool.ensureCalls.length, before);
    assert.equal(service.peers({ share_id: 'missing-share' }).code, P2P_V2_CODE.SHARE_NOT_FOUND);

    const definitions = buildTools({ service, defineTool: (definition) => definition });
    const peersTool = definitions.find((definition) => definition.name === 'p2p_v2_peers');
    const viaTool = json(await peersTool.execute({ shareId: shared.share.share_id }));
    assert.equal(viaTool.ok, true);
    assert.equal(viaTool.shares[0].share_id, shared.share.share_id);
    assert.equal(JSON.stringify(viaTool).includes('secret-token'), false);
    await service.stopAll();
  });

  it('carries task JSON and torrent frames concurrently on the same V1 pair', async () => {
    const { path } = tempFile();
    const pool = fakePool();
    const client = fakeClient();
    const service = new P2PV2Service(normalizePluginConfig({}), {
      getPool: () => pool,
      webTorrentFactory: () => client,
    });
    const shared = await service.share({ path, peers: ['machine-b'] });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    const adapter = client.torrents[0].added[0];
    const torrentBytes = [];
    adapter.on('data', (chunk) => torrentBytes.push(chunk));
    const taskFrames = [];
    const offTask = pool.onMessage((event) => {
      if (isTorrentFrame(event.payload)) return;
      try {
        taskFrames.push(JSON.parse(event.payload.toString()));
      } catch {
        // A non-JSON non-torrent frame is not a task frame.
      }
    });

    const jsonFrame = Buffer.from(JSON.stringify({ type: 'task.offer', task_id: 'task-1' }));
    const torrentFrame = encodeTorrentFrame(HASH_A, Buffer.from('concurrent-in'));
    await Promise.all([
      new Promise((resolve, reject) => {
        adapter.write(Buffer.from('concurrent-out'), (error) => (error ? reject(error) : resolve()));
      }),
      Promise.resolve().then(() => pool.emit('machine-b', jsonFrame)),
      Promise.resolve().then(() => pool.emit('machine-b', torrentFrame)),
    ]);
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.deepEqual(taskFrames, [{ type: 'task.offer', task_id: 'task-1' }]);
    assert.equal(torrentBytes.length, 1);
    assert.equal(torrentBytes[0].toString(), 'concurrent-in');
    assert.equal(pool.sent.length, 1);
    assert.equal(pool.sent[0].peer, 'machine-b');
    const decoded = decodeTorrentFrame(pool.sent[0].payload);
    assert.equal(decoded.infoHash, HASH_A);
    assert.equal(decoded.payload.toString(), 'concurrent-out');
    assert.equal(adapter.stats.chunks_in, 1);
    assert.equal(adapter.stats.chunks_out, 1);
    assert.equal(service.status().stats.frames_in, 1);
    const peer = service.status().shares[0].peers[0];
    assert.equal(peer.machine_id, 'machine-b');
    assert.equal(peer.chunks, 2);
    assert.equal(peer.bytes > 0, true);
    offTask();
    await service.stopAll();
  });
});

describe('dsh-p2p-v2 wiring', () => {
  it('declares the export, the lib seam and a disabled patch row', () => {
    assert.equal(pkg.exports['./dsh-p2p-v2'], './lib/p2p-v2-plugin.js');
    assert.ok(existsSync(join(ROOT, 'lib/p2p-v2-plugin.js')));
    assert.ok(existsSync(join(ROOT, 'src/plugin/p2p-v2-plugin.mjs')));
    const row = patchRow(P2P_V2_ROW_ID);
    assert.match(row, /name: '@twinsearth\/w2m-dsh-plugin\/dsh-p2p-v2'/);
    assert.match(row, /disabled: true/);
    assert.match(row, /webTorrentModule: 'webtorrent'/);
    assert.match(row, /allowNativeTrackers: false/);
    assert.match(row, /maxShares: 8/);
  });

  it('mounts seven tools inertly and refuses share/add without confirmation', async () => {
    const { ctx, definitions, registered, effects } = fakeContext();
    let factoryCalls = 0;
    const dispose = await apply(ctx, {}, {
      defineTool: (definition) => definition,
      webTorrentFactory: () => {
        factoryCalls += 1;
        return fakeClient();
      },
    });
    assert.equal(typeof dispose, 'function');
    assert.deepEqual(registered, [...TOOL_NAMES]);
    assert.equal(definitions.length, 7);
    assert.equal(factoryCalls, 0);
    assert.equal(dispose.mounted, true);
    assert.equal(effects.length, 1);
    const share = definitions.find((definition) => definition.name === 'p2p_v2_share');
    assert.equal(share.parameters.transport.type, 'string');
    assert.deepEqual(json(await share.execute({ path: 'x' })), {
      ok: false,
      code: 'P2P_V2_CONFIRM_REQUIRED',
      detail: 'confirm must be the literal "share"',
    });
    const add = definitions.find((definition) => definition.name === 'p2p_v2_add');
    assert.equal(add.parameters.transport.type, 'string');
    assert.equal(json(await add.execute({ magnet: 'magnet:x', path: 'x' })).code, 'P2P_V2_CONFIRM_REQUIRED');
    const attach = definitions.find((definition) => definition.name === 'p2p_v2_attach');
    assert.equal(attach.parameters.transport.type, 'string');
    const status = definitions.find((definition) => definition.name === 'p2p_v2_status');
    assert.equal(json(await status.execute({})).engine.available, false);
    const peers = definitions.find((definition) => definition.name === 'p2p_v2_peers');
    assert.equal(peers.parameters.shareId.type, 'string');
    const peersView = json(await peers.execute({}));
    assert.equal(peersView.ok, true);
    assert.equal(peersView.pool.available, false);
    assert.deepEqual(peersView.shares, []);
    await dispose();
  });

  it('builds the same tool set over a pure service', () => {
    const service = new P2PV2Service(normalizePluginConfig({}), { getPool: () => fakePool() });
    const definitions = buildTools({ service, defineTool: (definition) => definition });
    assert.deepEqual(definitions.map((definition) => definition.name), [...TOOL_NAMES]);
    assert.equal(P2P_V2_ROW_ID, 'dsh-p2p-v2');
  });
});
