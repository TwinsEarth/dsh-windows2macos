/**
 * P4: task dispatch and the P2P V2 torrent plane share one WebRTC pair, but not one parser.
 *
 * The regression is deliberately end-to-end at the frame boundary: a fake pool fans the exact
 * sequence -- `task.offer` JSON, one tagged WebTorrent chunk, `result.ack` JSON -- to the real
 * deliver phase and the real P2P V2 service at the same time. `deliver.mjs` must consume both JSON
 * control frames and ignore the tagged chunk; the V2 service must do the inverse. Neither side may
 * see the other's frame as an orphan, a malformed JSON warning or a task type.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDeliverPhase } from '../src/agent/lifecycle/deliver.mjs';
import { P2PV2Service, P2P_V2_CODE } from '../src/agent/webtorrent/service.mjs';
import {
  TORRENT_FRAME_HEADER_BYTES,
  TORRENT_FRAME_MAGIC,
  encodeTorrentFrame,
} from '../src/agent/webtorrent/multiplex.mjs';
import { normalizePluginConfig as normalizePluginConfigBase, TOOL_NAMES } from '../src/plugin/p2p-v2-plugin.mjs';
import { pushOfferBestPath } from '../src/plugin/tools/dispatch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HASH_A = 'a'.repeat(40);
const PEER = 'machine-peer-a';

/** Every created directory is removed at exit, including on a failing assertion. */
const scratchDirs = [];
process.on('exit', () => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can keep a handle for a moment */
    }
  }
});

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function fakeTorrent(infoHash = HASH_A, name = 'sample.bin') {
  const torrent = new EventEmitter();
  torrent.infoHash = infoHash;
  torrent.infoHashBuffer = Buffer.from(infoHash, 'hex');
  torrent.magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${name}`;
  torrent.name = name;
  torrent.length = 1024;
  torrent.downloaded = 0;
  torrent.uploaded = 0;
  torrent.progress = 1;
  torrent.done = true;
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
  client.seed = (_source, _opts, callback) => {
    const torrent = fakeTorrent();
    client.torrents.push(torrent);
    setTimeout(() => callback?.(torrent), 0);
    return torrent;
  };
  client.add = () => {
    const torrent = fakeTorrent();
    client.torrents.push(torrent);
    return torrent;
  };
  client.destroy = (callback) => {
    client.destroyed = true;
    setTimeout(() => callback?.(), 0);
  };
  return client;
}

/** One broadcast bus shared by the deliver phase and the V2 transport. */
function fakePool(machineId = 'machine-local') {
  const handlers = new Set();
  const sent = [];
  const ensureCalls = [];
  const pool = {
    machineId,
    sent,
    ensureCalls,
    async ensure(peer) {
      ensureCalls.push(peer);
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
      for (const handler of [...handlers]) handler({ peer, payload });
    },
    diagnostics() {
      return { ok: true, peer_count: 1, peers: [{ peer: PEER, state: 'connected' }] };
    },
  };
  return pool;
}

function scopedConfig(root) {
  return normalizePluginConfigBase({
    stateDir: join(root, 'state'),
    downloadRoot: join(root, 'downloads'),
    allowedRoots: [root],
  }, {
    dshHome: join(root, 'dsh'),
    projectDir: ROOT,
  });
}

/** A deliver phase whose heartbeat records exactly which parsed frames reached it. */
function makeDeliver(pool, root) {
  const frames = [];
  const deps = {
    log: () => {},
    identity: { machine_id: 'machine-local', machine_name: 'local', device_token: 'test-token' },
    platform: { os: 'win32', os_version: '10.0', arch: 'x64', shell: 'pwsh', shell_version: '7' },
    caps: {},
    state: {},
    spool: { saveEnvelope: () => {}, ack: () => {} },
    stateDir: root,
    project: root,
    baseUrl: 'http://127.0.0.1:1',
    options: {
      webrtcPool: pool,
      webrtcDataMaxAttempts: 3,
      webrtcAckTimeoutMs: 80,
      webrtcRetryDelayMs: 5,
      webrtcResultBudgetMs: 500,
    },
    p2pMode: 'relay',
    deviceKey: null,
    deviceKeyError: null,
    deviceKeyMigratedFrom: null,
    peerKeys: new Map(),
    onP2PStatus: () => {},
    p2pPort: null,
    p2pPortError: null,
    p2pAckTimeoutMs: 80,
    p2pChannelLingerMs: 0,
    redactOutput: true,
    tmpDir: root,
    objectMode: 'temp',
    toolchainInfo: async () => ({}),
    http: {
      postJson: async () => ({ ok: true }),
      postJsonWithRetry: async () => ({ ok: true }),
      relayErrorCode: () => null,
      getJson: async () => ({ json: {} }),
    },
    heartbeat: {
      handleP2PMessage(event) {
        const frame = JSON.parse(Buffer.from(event.payload).toString('utf8'));
        frames.push({
          type: frame.type,
          task_id: frame.task_id ?? null,
          peer: event.peer?.machine_id ?? event.peer,
          transport: event.channel?.stack ?? null,
        });
      },
    },
  };
  const deliver = createDeliverPhase(deps);
  return { deliver, frames };
}

function taskOffer(taskId) {
  return {
    type: 'task.offer',
    task_id: taskId,
    machine_id: PEER,
    origin_machine_id: 'machine-local',
    p2p: { mode: 'auto' },
  };
}

describe('task dispatch / P2P V2 frame isolation', () => {
  it('routes the same-peer JSON, torrent, JSON sequence to exactly one consumer per frame', async () => {
    const root = scratch('w2m-p2p-v2-dispatch-');
    writeFileSync(join(root, 'seed.bin'), Buffer.alloc(1024, 7));

    const pool = fakePool();
    const service = new P2PV2Service(scopedConfig(root), {
      getPool: () => pool,
      webTorrentFactory: () => fakeClient(),
    });
    const shared = await service.share({ path: join(root, 'seed.bin') });
    assert.equal(shared.ok, true, JSON.stringify(shared));
    const attached = await service.attach({
      share_id: shared.share.share_id,
      machine_id: PEER,
      transport: 'webrtc-v1',
    });
    assert.equal(attached.ok, true, JSON.stringify(attached));

    const { deliver, frames } = makeDeliver(pool, root);
    deliver.attachWebRtc();

    const offer = Buffer.from(JSON.stringify(taskOffer('task-isolation-1')));
    const tagged = encodeTorrentFrame(HASH_A, Buffer.alloc(128, 9));
    const ack = Buffer.from(JSON.stringify({ type: 'result.ack', task_id: 'task-isolation-1' }));

    // Same peer, same bus, in the exact order from the P4 regression: offer, torrent, ack.
    pool.emit(PEER, offer);
    const afterOffer = service.status();
    assert.deepEqual(frames.map((frame) => frame.type), ['task.offer']);
    assert.equal(frames[0].peer, PEER);
    assert.equal(frames[0].transport, 'webrtc-v1');
    assert.equal(afterOffer.stats.frames_in, 0, 'V2 must not count a JSON task.offer as a torrent frame');
    assert.equal(afterOffer.stats.orphan_frames, 0);

    pool.emit(PEER, tagged);
    const afterTorrent = service.status();
    assert.deepEqual(frames.map((frame) => frame.type), ['task.offer'], 'deliver must not parse a tagged chunk');
    assert.equal(afterTorrent.stats.frames_in, 1);
    assert.equal(afterTorrent.stats.bytes_in, 128);
    assert.equal(afterTorrent.stats.orphan_frames, 0, 'the attached adapter must claim the tagged frame');

    pool.emit(PEER, ack);
    const afterAck = service.status();
    assert.deepEqual(frames.map((frame) => frame.type), ['task.offer', 'result.ack']);
    assert.equal(frames.at(-1).peer, PEER);
    assert.equal(frames.at(-1).transport, 'webrtc-v1');
    assert.equal(afterAck.stats.frames_in, 1, 'V2 must not count JSON result.ack as a torrent frame');
    assert.equal(afterAck.stats.orphan_frames, 0);
    assert.equal(frames.at(-1).task_id, 'task-isolation-1');

    await service.stopAll();
  });

  it('keeps task dispatch on webrtc-v1 and leaves task.* types outside the p2p_v2 surface', async () => {
    const pool = fakePool();
    const result = await pushOfferBestPath(null, pool, taskOffer('task-isolation-2'), {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.transport, 'webrtc-v1');
    assert.equal(result.fallback_from, null);
    assert.equal(pool.sent.length, 1);
    assert.equal(pool.sent[0].peer, PEER);
    assert.equal(JSON.parse(pool.sent[0].payload.toString()).type, 'task.offer');

    assert.equal(TOOL_NAMES.length, 7);
    assert.equal(TOOL_NAMES.some((name) => name.startsWith('task.') || name.startsWith('task_')), false);
    assert.equal(Object.keys(P2P_V2_CODE).some((key) => key.startsWith('TASK_')), false);
    assert.equal(P2P_V2_CODE.TORRENT_ADD_FAILED, 'P2P_V2_TORRENT_ADD_FAILED');
  });

  it('does not mistake the torrent magic for JSON and does not treat a short JSON frame as torrent data', () => {
    const offer = Buffer.from(JSON.stringify(taskOffer('task-isolation-3')));
    assert.equal(offer.subarray(0, TORRENT_FRAME_MAGIC.length).equals(TORRENT_FRAME_MAGIC), false);
    assert.ok(offer.length > TORRENT_FRAME_HEADER_BYTES);
    const tagged = encodeTorrentFrame(HASH_A, Buffer.from('piece'));
    assert.equal(tagged.subarray(0, TORRENT_FRAME_MAGIC.length).equals(TORRENT_FRAME_MAGIC), true);
  });
});
