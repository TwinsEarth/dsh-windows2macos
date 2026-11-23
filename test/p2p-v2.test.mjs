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
  const pool = {
    machineId,
    sent,
    ensureCalls: [],
    closed: false,
    async ensure(peer) {
      pool.ensureCalls.push(peer);
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
      return { peer_count: 1 };
    },
    closePeer: () => {
      pool.closed = true;
    },
  };
  return pool;
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

describe('p2p v2 peer adapter', () => {
  it('writes tagged frames through the pool and feeds decoded bytes back into the Duplex', async () => {
    const pool = fakePool();
    const adapter = createTorrentPeerAdapter({ peer: 'machine-b', infoHash: HASH_A, pool, writeTimeoutMs: 100 });
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received[0].toString(), 'incoming');
    assert.equal(adapter.stats.chunks_in, 1);
    adapter.destroy();
  });

  it('does not close the shared pool when the logical torrent stream is destroyed', () => {
    const pool = fakePool();
    const adapter = createTorrentPeerAdapter({ peer: 'machine-b', infoHash: HASH_A, pool });
    adapter.destroy();
    assert.equal(pool.closed, false);
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

  it('mounts six tools inertly and refuses share/add without confirmation', async () => {
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
    assert.equal(definitions.length, 6);
    assert.equal(factoryCalls, 0);
    assert.equal(dispose.mounted, true);
    assert.equal(effects.length, 1);
    const share = definitions.find((definition) => definition.name === 'p2p_v2_share');
    assert.deepEqual(json(await share.execute({ path: 'x' })), {
      ok: false,
      code: 'P2P_V2_CONFIRM_REQUIRED',
      detail: 'confirm must be the literal "share"',
    });
    const add = definitions.find((definition) => definition.name === 'p2p_v2_add');
    assert.equal(json(await add.execute({ magnet: 'magnet:x', path: 'x' })).code, 'P2P_V2_CONFIRM_REQUIRED');
    const status = definitions.find((definition) => definition.name === 'p2p_v2_status');
    assert.equal(json(await status.execute({})).engine.available, false);
    await dispose();
  });

  it('builds the same tool set over a pure service', () => {
    const service = new P2PV2Service(normalizePluginConfig({}), { getPool: () => fakePool() });
    const definitions = buildTools({ service, defineTool: (definition) => definition });
    assert.deepEqual(definitions.map((definition) => definition.name), [...TOOL_NAMES]);
    assert.equal(P2P_V2_ROW_ID, 'dsh-p2p-v2');
  });
});
