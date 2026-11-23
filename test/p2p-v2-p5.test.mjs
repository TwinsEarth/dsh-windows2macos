/**
 * P5 unit matrix: multiplex / peer adapter / transport registry.
 *
 * These tests are deliberately independent of a real torrent engine or a real WebRTC provider.
 * They pin the byte-plane contracts the live P5 suite depends on:
 *
 *   - only tagged frames belong to P2P V2, so JSON task dispatch can share the V1 bus;
 *   - the adapter writes one tagged frame per torrent write and reports failures by name;
 *   - the registry is a definition registry, not a connection owner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TORRENT_FRAME_MAGIC,
  TORRENT_FRAME_HEADER_BYTES,
  TORRENT_FRAME_MAX_CHUNK_BYTES,
  decodeTorrentFrame,
  encodeTorrentFrame,
  isTorrentFrame,
  normalizeInfoHash,
  shareIdFor,
} from '../src/agent/webtorrent/multiplex.mjs';
import {
  TORRENT_ADAPTER_MAX_WRITE_BYTES,
  createTorrentPeerAdapter,
} from '../src/agent/webtorrent/peer-adapter.mjs';
import {
  TORRENT_DEFAULT_TRANSPORT,
  TORRENT_TRANSPORT_CODE,
  createTorrentTransportRegistry,
  hasTorrentTransport,
  listTorrentTransports,
  getTorrentTransport,
} from '../src/agent/webtorrent/transports/registry.mjs';
import { createWebRtcV1Transport } from '../src/agent/webtorrent/transports/webrtc-v1.mjs';

const HASH = 'fdebc6a7cb3e8a22c55ba18456767a8768d1cd09';

function writeAsync(adapter, chunk) {
  return new Promise((resolve, reject) => {
    adapter.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

describe('P5 multiplex contract', () => {
  it('round-trips a 1 MiB torrent chunk with its info hash', () => {
    const payload = Buffer.alloc(1024 * 1024, 7);
    const frame = encodeTorrentFrame(HASH, payload);
    assert.equal(frame.subarray(0, TORRENT_FRAME_MAGIC.length).equals(TORRENT_FRAME_MAGIC), true);
    assert.equal(frame.length, TORRENT_FRAME_HEADER_BYTES + payload.length);
    const decoded = decodeTorrentFrame(frame);
    assert.equal(decoded.infoHash, HASH);
    assert.equal(decoded.payload.length, payload.length);
    assert.equal(decoded.payload.equals(payload), true);
  });

  it('never mistakes a JSON task frame for a torrent frame', () => {
    const json = Buffer.from(JSON.stringify({ type: 'task.offer', id: 'task-1' }));
    assert.equal(isTorrentFrame(json), false);
    assert.equal(decodeTorrentFrame(json), null);
  });

  it('rejects a frame with a truncated or wrong header', () => {
    assert.equal(decodeTorrentFrame(Buffer.from([0x57, 0x32])), null);
    const wrong = Buffer.concat([Buffer.from('W2MX2\0'), Buffer.alloc(20, 1), Buffer.from('payload')]);
    assert.equal(decodeTorrentFrame(wrong), null);
  });

  it('rejects a tagged frame with an empty payload', () => {
    const frame = Buffer.concat([TORRENT_FRAME_MAGIC, Buffer.from(HASH, 'hex')]);
    assert.equal(decodeTorrentFrame(frame), null);
  });

  it('accepts the documented maximum chunk and rejects one byte over', () => {
    const max = Buffer.alloc(TORRENT_FRAME_MAX_CHUNK_BYTES, 3);
    assert.equal(decodeTorrentFrame(encodeTorrentFrame(HASH, max)).payload.length, max.length);
    assert.throws(
      () => encodeTorrentFrame(HASH, Buffer.alloc(TORRENT_FRAME_MAX_CHUNK_BYTES + 1)),
      /cap is/,
    );
  });

  it('normalizes string and buffer info hashes and rejects malformed hashes', () => {
    assert.equal(normalizeInfoHash(HASH.toUpperCase()), HASH);
    assert.equal(normalizeInfoHash(Buffer.from(HASH, 'hex')), HASH);
    assert.equal(normalizeInfoHash('not-a-hash'), null);
    assert.throws(() => encodeTorrentFrame('not-a-hash', Buffer.from('x')), /40 hex/);
  });

  it('derives a stable share id from the info hash', () => {
    assert.equal(shareIdFor(HASH), shareIdFor(HASH.toUpperCase()));
    assert.equal(shareIdFor(HASH).length, 24);
    assert.notEqual(shareIdFor(HASH), shareIdFor('0'.repeat(40)));
  });
});

describe('P5 peer adapter contract', () => {
  it('writes exactly one tagged frame and records bytes', async () => {
    const sent = [];
    const adapter = createTorrentPeerAdapter({
      peer: 'machine-b',
      infoHash: HASH,
      transport: {
        name: 'webrtc-v1',
        async send(peer, frame) {
          sent.push({ peer, frame });
          return { ok: true };
        },
      },
    });
    await writeAsync(adapter, Buffer.from('chunk-bytes'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].peer, 'machine-b');
    const decoded = decodeTorrentFrame(sent[0].frame);
    assert.equal(decoded.infoHash, HASH);
    assert.equal(decoded.payload.toString(), 'chunk-bytes');
    assert.equal(adapter.stats.chunks_out, 1);
    assert.equal(adapter.stats.bytes_out, 11);
    assert.equal(adapter.transport, 'webrtc-v1');
    adapter.destroy();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(adapter.diagnostics().connected, false);
  });

  it('feeds decoded payload bytes into the readable side', async () => {
    const adapter = createTorrentPeerAdapter({
      peer: 'machine-b',
      infoHash: HASH,
      transport: { name: 'webrtc-v1', async send() { return { ok: true }; } },
    });
    const read = new Promise((resolve) => { adapter.once('data', resolve); });
    assert.equal(adapter.feed(Buffer.from('inbound')), true);
    assert.equal((await read).toString(), 'inbound');
    assert.equal(adapter.stats.chunks_in, 1);
    assert.equal(adapter.stats.bytes_in, 7);
    adapter.destroy();
  });

  it('refuses a torrent write larger than the frame cap', async () => {
    const adapter = createTorrentPeerAdapter({
      peer: 'machine-b',
      infoHash: HASH,
      transport: { name: 'webrtc-v1', async send() { return { ok: true }; } },
    });
    await assert.rejects(
      writeAsync(adapter, Buffer.alloc(TORRENT_ADAPTER_MAX_WRITE_BYTES + 1)),
      (error) => error.code === 'P2P_V2_CHUNK_TOO_LARGE',
    );
    assert.equal(adapter.stats.errors, 1);
    assert.equal(adapter.stats.last_error.code, 'P2P_V2_CHUNK_TOO_LARGE');
  });

  it('turns a refused transport send into a named adapter error', async () => {
    const adapter = createTorrentPeerAdapter({
      peer: 'machine-b',
      infoHash: HASH,
      transport: {
        name: 'webrtc-v1',
        async send() { return { ok: false, code: 'WEBRTC_POOL_NOT_READY', detail: 'peer not ready' }; },
      },
    });
    await assert.rejects(
      writeAsync(adapter, Buffer.from('x')),
      (error) => error.code === 'WEBRTC_POOL_NOT_READY',
    );
    assert.equal(adapter.stats.errors, 1);
    assert.equal(adapter.diagnostics().last_error.detail, 'peer not ready');
  });

  it('destroy ends the logical stream without touching the borrowed transport', async () => {
    let transportClosed = false;
    const adapter = createTorrentPeerAdapter({
      peer: 'machine-b',
      infoHash: HASH,
      transport: {
        name: 'webrtc-v1',
        async send() { return { ok: true }; },
        close() { transportClosed = true; },
      },
    });
    adapter.destroy();
    assert.equal(adapter.destroyed, true);
    assert.equal(transportClosed, false);
    assert.equal(adapter.diagnostics().connected, false);
  });
});

describe('P5 transport registry and binding', () => {
  it('ships webrtc-v1 as the only built-in default', () => {
    assert.equal(TORRENT_DEFAULT_TRANSPORT, 'webrtc-v1');
    assert.equal(hasTorrentTransport('webrtc-v1'), true);
    assert.equal(listTorrentTransports().includes('webrtc-v1'), true);
    assert.equal(getTorrentTransport().name, 'webrtc-v1');
  });

  it('names an unknown transport instead of silently falling back', () => {
    assert.throws(
      () => getTorrentTransport('p2p-v2-unknown'),
      (error) => error.code === TORRENT_TRANSPORT_CODE.UNKNOWN,
    );
  });

  it('rejects a definition whose reported name disagrees with its key', () => {
    const registry = createTorrentTransportRegistry();
    assert.throws(
      () => registry.register('custom', { name: 'other', create() {} }),
      (error) => error.code === TORRENT_TRANSPORT_CODE.INVALID_TRANSPORT,
    );
  });

  it('registers definitions per instance and does not leak into the process registry', () => {
    const registry = createTorrentTransportRegistry();
    const definition = registry.register('custom', { create() { return {}; } });
    assert.equal(definition.name, 'custom');
    assert.deepEqual(registry.list(), ['custom']);
    assert.equal(registry.has('custom'), true);
    assert.equal(registry.has('webrtc-v1'), false);
  });

  it('binds webrtc-v1 to a pool and unsubscribes only its own handler on destroy', async () => {
    let poolHandler = null;
    let unsubscribed = 0;
    const pool = {
      machineId: 'machine-a',
      async ensure(peer) { return { ok: true, peer, role: 'host' }; },
      async send(peer, payload) { return { ok: true, peer, bytes: payload.length }; },
      onMessage(handler) {
        poolHandler = handler;
        return () => { unsubscribed += 1; };
      },
      diagnostics() { return { peer_count: 1 }; },
    };
    const binding = createWebRtcV1Transport({ pool });
    const seen = [];
    const off = binding.onMessage((event) => seen.push(event.peer));

    assert.equal((await binding.ensure('machine-b')).ok, true);
    assert.equal((await binding.send('machine-b', Buffer.from('x'))).bytes, 1);
    poolHandler({ peer: 'machine-b', payload: Buffer.from('frame') });
    assert.deepEqual(seen, ['machine-b']);
    off();
    assert.equal(unsubscribed, 1);

    const destroyed = binding.destroy();
    assert.equal(destroyed.ok, true);
    assert.equal(binding.destroyed, true);
    assert.equal((await binding.send('machine-b', Buffer.from('x'))).code, 'P2P_V2_TRANSPORT_CLOSED');
    assert.equal(pool.diagnostics().peer_count, 1);
  });

  it('contains a throwing consumer without starving a second torrent stream', () => {
    const pool = {
      machineId: 'machine-a',
      async ensure() { return { ok: true }; },
      async send() { return { ok: true }; },
      onMessage(handler) { this.handler = handler; return () => {}; },
    };
    const binding = createWebRtcV1Transport({ pool });
    const seen = [];
    binding.onMessage(() => { throw new Error('consumer failed'); });
    binding.onMessage((event) => seen.push(event));
    pool.handler({ peer: 'machine-b' });
    assert.equal(seen.length, 1);
  });
});
