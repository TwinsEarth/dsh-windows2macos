import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { chunkFile, createReceiver, createRefV2 } from '../src/agent/transfer/ferry.mjs';
import { createXferFrameRouter } from '../src/agent/transfer/router.mjs';

class FakeChannel extends EventEmitter {
  constructor() { super(); this.peer = null; }
  send(payload) { this.peer?.emit('message', Buffer.from(String(payload), 'utf8')); }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

describe('P0-a: xfer frame router on a channel', () => {
  it('serves a registered source and lets a registered receiver finalize', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-router-'));
    const data = Buffer.alloc(96 * 1024 + 5);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 13) % 251;
    const file = join(dir, 'source.bin');
    writeFileSync(file, data);
    const chunked = chunkFile(file, { chunkBytes: 16 * 1024 });
    const ref = createRefV2({ rootCid: chunked.rootCid, size: chunked.size, chunkCount: chunked.chunkCount, chunkBytes: chunked.chunkBytes, originPeer: 'peer-a' }).ref;
    const receiver = createReceiver({ stateDir: join(dir, 'state'), sinkRoot: join(dir, 'sink'), ref, destination: 'out.bin' });

    const a = new FakeChannel(); const b = new FakeChannel();
    a.peer = b; b.peer = a;
    const routerA = createXferFrameRouter();
    const routerB = createXferFrameRouter();
    a.on('message', (payload) => routerA.handle(payload, { channel: a }));
    b.on('message', (payload) => routerB.handle(payload, { channel: b }));
    assert.equal(routerA.registerSource(ref.rootCid, { chunked, filePath: file }).ok, true);
    assert.equal(routerB.registerReceiver(receiver.transferId, receiver, ref.rootCid).ok, true);

    let guard = 0;
    while (!receiver.progress().complete) {
      guard += 1;
      assert.ok(guard < 50, 'router transfer must terminate');
      routerB.request(receiver.transferId, b);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalized = receiver.finalizeTransfer(ref.rootCid);
    assert.equal(finalized.ok, true, finalized.code);
    assert.equal(sha256(readFileSync(finalized.path)), sha256(data));
  });

  it('drops a want for an unknown source without sending an error', () => {
    const channel = new FakeChannel();
    const sent = [];
    channel.send = (payload) => sent.push(payload);
    const router = createXferFrameRouter();
    assert.equal(router.handle(JSON.stringify({ type: 'xfer.want', transferId: 't', rootCid: 'sha256:' + 'a'.repeat(64), indices: [0] }), { channel }), true);
    assert.equal(sent.length, 0);
    assert.equal(router.handle(JSON.stringify({ type: 'task.offer' }), { channel }), false);
  });
});
