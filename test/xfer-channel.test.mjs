import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { chunkFile, createReceiver, createRefV2 } from '../src/agent/transfer/ferry.mjs';
import { attachChunkSource, attachWantClient } from '../src/agent/transfer/want-block.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

class FakeChannel extends EventEmitter {
  constructor() { super(); this.peer = null; this.sent = 0; }
  send(payload) {
    this.sent += 1;
    const bytes = Buffer.from(String(payload), 'utf8');
    setImmediate(() => this.peer?.emit('message', bytes));
  }
  close() { this.emit('close'); }
}

describe('P0-a: chunk frames over a MessageChannel', () => {
  it('pulls a file through the channel adapter and finalizes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-chan-'));
    const data = Buffer.alloc(300 * 1024 + 17);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 31) % 251;
    const file = join(dir, 'source.bin');
    writeFileSync(file, data);
    const chunked = chunkFile(file, { chunkBytes: 64 * 1024 });
    const ref = createRefV2({ rootCid: chunked.rootCid, size: chunked.size, chunkCount: chunked.chunkCount, chunkBytes: chunked.chunkBytes, originPeer: 'peer-a' }).ref;
    const receiver = createReceiver({ stateDir: join(dir, 'state'), sinkRoot: join(dir, 'sink'), ref, destination: 'out.bin' });

    const a = new FakeChannel();
    const b = new FakeChannel();
    a.peer = b; b.peer = a;

    const source = attachChunkSource(a, { chunked, filePath: file, transferId: receiver.transferId });
    assert.equal(source.ok, true);
    const client = attachWantClient(b, { transferId: receiver.transferId, rootCid: ref.rootCid, receiver });
    assert.equal(client.ok, true);

    let guard = 0;
    while (!receiver.progress().complete) {
      guard += 1;
      assert.ok(guard < 50, 'channel transfers must terminate');
      client.request();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalized = receiver.finalizeTransfer(ref.rootCid);
    assert.equal(finalized.ok, true, finalized.code);
    assert.equal(sha256(readFileSync(finalized.path)), sha256(data));
    assert.ok(a.sent > 0 && b.sent > 0, 'frames must travel over the channel');
    source.close(); client.close();
  });
});
