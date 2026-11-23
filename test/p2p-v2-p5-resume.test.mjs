/**
 * P5 restart/resume row: a leecher is stopped mid-transfer, its partial staging file survives,
 * and a fresh service resumes from the bytes already on disk instead of downloading the whole file.
 *
 * The torrent engine is deterministic and counts every byte it writes to staging; the byte plane is
 * the same socket-free fake used by the 2 seed + 2 leecher matrix. Real WebTorrent piece resume is
 * covered by the live harness; this row pins the service-level contract: stable staging path, no
 * half-written destination, and no full re-download after restart.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { P2PV2Service } from '../src/agent/webtorrent/service.mjs';
import { normalizePluginConfig } from '../src/plugin/p2p-v2-plugin.mjs';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function fakePool(machineId) {
  const handlers = new Set();
  return {
    machineId,
    async ensure(peer) {
      return { ok: true, peer, role: machineId < peer ? 'host' : 'client' };
    },
    async send(peer, payload) {
      return { ok: true, peer, bytes: payload.length };
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    diagnostics() {
      return { peer_count: handlers.size, frames: 0 };
    },
  };
}

function fakeTorrent({ infoHash, name, length, done = false }) {
  const torrent = new EventEmitter();
  torrent.infoHash = infoHash;
  torrent.infoHashBuffer = Buffer.from(infoHash, 'hex');
  torrent.magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
  torrent.name = name;
  torrent.length = length;
  torrent.downloaded = 0;
  torrent.uploaded = 0;
  torrent.progress = done ? 1 : 0;
  torrent.done = done;
  torrent.numPeers = 0;
  torrent.downloadSpeed = 0;
  torrent.uploadSpeed = 0;
  torrent.files = [{ name, path: name, length }];
  torrent.addPeer = () => {};
  torrent.destroy = (callback) => { callback?.(); };
  return torrent;
}

/**
 * The first `add` writes exactly half of the payload to staging and stops there. The second `add`
 * sees the existing staging file, appends only the missing tail, and completes. `written` is shared
 * by both service instances and must equal the payload length once.
 */
function resumeEngineFactory(content, name, counters) {
  const infoHash = createHash('sha1').update(content).digest('hex');
  return () => {
    const client = new EventEmitter();
    client.seed = (_source, _opts, callback) => {
      const torrent = fakeTorrent({ infoHash, name, length: content.length, done: true });
      torrent.files = [{ name, path: name, length: content.length }];
      queueMicrotask(() => callback(torrent));
      return torrent;
    };
    client.add = (_magnet, opts = {}) => {
      counters.starts += 1;
      const staging = opts.path;
      assert.equal(typeof staging, 'string');
      const torrent = fakeTorrent({ infoHash, name, length: content.length, done: false });
      setTimeout(() => {
        if (counters.attempts === 0) {
          counters.attempts += 1;
          mkdirSync(staging, { recursive: true });
          const half = Math.floor(content.length / 2);
          writeFileSync(join(staging, name), content.subarray(0, half));
          counters.written += half;
          torrent.downloaded = half;
          torrent.progress = half / content.length;
          torrent.numPeers = 1;
          torrent.emit('download', half);
          return;
        }
        const target = join(staging, name);
        const already = existsSync(target) ? statSync(target).size : 0;
        const tail = content.subarray(already);
        writeFileSync(target, tail, { flag: already === 0 ? 'w' : 'a' });
        counters.written += tail.length;
        torrent.downloaded = content.length;
        torrent.progress = 1;
        torrent.done = true;
        torrent.numPeers = 1;
        torrent.emit('done');
      }, 100).unref?.();
      queueMicrotask(() => torrent.emit('ready'));
      return torrent;
    };
    client.destroy = () => {};
    return client;
  };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms`);
}

describe('P5 resume: restart a leecher from partial staging', () => {
  it('continues from downloaded bytes without re-downloading the full file', async () => {
    const base = mkdtempSync(join(tmpdir(), 'w2m-p5-resume-'));
    const content = Buffer.alloc(1024 * 1024, 0);
    for (let index = 0; index < content.length; index += 1) content[index] = (index * 17 + 3) % 251;
    const name = 'payload.bin';
    const seedDir = join(base, 'seed');
    mkdirSync(seedDir);
    writeFileSync(join(seedDir, name), content);
    const digest = sha256(content);
    const counters = { attempts: 0, written: 0, starts: 0 };
    const factory = resumeEngineFactory(content, name, counters);
    const cfg = normalizePluginConfig({
      readyTimeoutMs: 10_000,
      metadataTimeoutMs: 10_000,
      stateDir: join(base, 'leech', 'state'),
      downloadRoot: join(base, 'leech', 'downloads'),
      allowedRoots: [base],
    });
    const pool = fakePool('leech');
    const seedService = new P2PV2Service(cfg, {
      getPool: () => fakePool('seed'),
      webTorrentFactory: () => {
        const client = new EventEmitter();
        client.seed = (_source, _opts, callback) => {
          const torrent = fakeTorrent({ infoHash: createHash('sha1').update(content).digest('hex'), name, length: content.length, done: true });
          queueMicrotask(() => callback(torrent));
          return torrent;
        };
        client.add = () => { throw new Error('seed service does not download'); };
        client.destroy = () => {};
        return client;
      },
    });
    const leecher = new P2PV2Service(cfg, { getPool: () => pool, webTorrentFactory: factory });
    let restartedService = null;
    const dest = join(base, 'leech', 'dest');
    const staging = join(base, 'leech', `.w2m-partial-${createHash('sha1').update(content).digest('hex')}`);
    try {
      const shared = await seedService.share({ path: join(seedDir, name), name });
      assert.equal(shared.ok, true, JSON.stringify(shared));
      const added = await leecher.add({
        magnet: shared.share.magnet_uri,
        path: dest,
        peers: ['seed'],
      });
      assert.equal(added.ok, true, JSON.stringify(added));
      await waitFor(() => {
        const share = leecher.status().shares[0];
        return share !== undefined && share.progress > 0 && share.progress < 1;
      });
      assert.equal(existsSync(join(dest, name)), false, 'destination must not hold a half-written file');
      assert.equal(existsSync(join(staging, name)), true, 'partial staging file must survive');

      const partialBytes = statSync(join(staging, name)).size;
      assert.equal(partialBytes, Math.floor(content.length / 2));
      // Simulate a process that dies mid-transfer: stop accepting work without waiting for the
      // socket teardown, then build a fresh service over the same state and download directory.
      void leecher.stopAll();
      await new Promise((resolve) => { setTimeout(resolve, 50); });

      restartedService = new P2PV2Service(cfg, { getPool: () => pool, webTorrentFactory: factory });
      const resumed = await restartedService.add({
        magnet: shared.share.magnet_uri,
        path: dest,
        peers: ['seed'],
      });
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      await waitFor(() => restartedService.status().shares[0]?.done === true);

      assert.equal(sha256(readFileSync(join(dest, name))), digest);
      assert.equal(statSync(join(dest, name)).size, content.length);
      assert.equal(existsSync(staging), false, 'finalize removes staging');
      assert.equal(counters.starts, 2);
      assert.equal(counters.written, content.length, `wrote ${counters.written} bytes for a ${content.length}-byte file`);
      assert.equal(restartedService.status().shares[0].finalized, true);
    } finally {
      void leecher?.stopAll();
      void restartedService?.stopAll();
      void seedService.stopAll();
    }
  });
});
