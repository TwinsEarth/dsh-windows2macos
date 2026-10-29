import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { chunkFile, createReceiver, createRefV2 } from '../src/agent/transfer/ferry.mjs';
import { createChunkSource, createWantClient, verifyChunkFrame, MAX_WINDOW, WANT } from '../src/agent/transfer/want-block.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-want-'));
  const data = Buffer.alloc(2 * 1024 * 1024 + 777);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 17) % 251;
  const file = join(dir, 'source.bin');
  writeFileSync(file, data);
  const chunked = chunkFile(file, { chunkBytes: 1024 * 1024 });
  const ref = createRefV2({ rootCid: chunked.rootCid, size: chunked.size, chunkCount: chunked.chunkCount, chunkBytes: chunked.chunkBytes, originPeer: 'm-1' }).ref;
  const sinkRoot = mkdtempSync(join(tmpdir(), 'w2m-want-sink-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'w2m-want-state-'));
  const receiver = createReceiver({ stateDir, sinkRoot, ref, destination: 'out.bin' });
  const source = createChunkSource({ chunked, filePath: file, transferId: receiver.transferId });
  const client = createWantClient({ transferId: receiver.transferId, rootCid: ref.rootCid, receiver });
  return { data, chunked, source, receiver, client, ref };
}

describe('P2P want-block (transport-injected)', () => {
  it('pulls all chunks in windows through the protocol and finalizes', () => {
    const { data, source, receiver, client, ref } = setup();
    let guard = 0;
    while (!receiver.progress().complete) {
      guard += 1;
      assert.ok(guard < 20, 'protocol must terminate');
      const missing = client.missing();
      for (let offset = 0; offset < missing.length; offset += MAX_WINDOW) {
        const request = client.requestFrames(missing.slice(offset, offset + MAX_WINDOW))[0];
        const served = source.handle(request);
        assert.equal(served.ok, true, served.code);
        for (const frame of served.frames) {
          const accepted = client.accept(frame);
          assert.equal(accepted.ok, true, JSON.stringify(accepted));
        }
      }
    }
    const done = receiver.finalizeTransfer(ref.rootCid);
    assert.equal(done.ok, true, done.code);
    assert.equal(sha256(readFileSync(done.path)), sha256(data));
  });

  it('rejects tampered chunk frames and peer errors', () => {
    const { source, receiver, client } = setup();
    const request = client.requestFrames([0])[0];
    assert.equal(request.type, WANT);
    const served = source.handle(request);
    assert.equal(served.ok, true);
    const tampered = { ...served.frames[0], data: Buffer.from('bad').toString('base64') };
    const bad = client.accept(tampered);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'XFER_CHUNK_LENGTH_INVALID');
    const error = client.accept({ type: 'xfer.error', transferId: receiver.transferId, code: 'XFER_READ_SHORT', index: 0 });
    assert.equal(error.ok, false);
    assert.equal(error.code, 'XFER_READ_SHORT');
  });

  it('refuses a request for more than the window or the wrong transfer', () => {
    const { source, client, ref, chunked, receiver } = setup();
    const tooMany = source.handle({ type: WANT, transferId: receiver.transferId, rootCid: ref.rootCid, indices: Array.from({ length: 9 }, (_, i) => i) });
    assert.equal(tooMany.code, 'XFER_WINDOW_INVALID');
    const wrong = source.handle({ type: WANT, transferId: 'x', rootCid: ref.rootCid, indices: [0] });
    assert.equal(wrong.code, 'XFER_TRANSFER_MISMATCH');
    const badRoot = source.handle({ type: WANT, transferId: receiver.transferId, rootCid: 'sha256:' + 'f'.repeat(64), indices: [0] });
    assert.equal(badRoot.code, 'XFER_ROOT_MISMATCH');
    const frame = verifyChunkFrame({ type: 'xfer.chunk', index: 0, sha256: 'a'.repeat(64), size: 3, data: Buffer.from('abc').toString('base64') });
    assert.equal(frame.ok, false);
    assert.equal(frame.code, 'XFER_CHUNK_HASH_MISMATCH');
    assert.equal(client.missing().length, chunked.chunkCount);
  });

  it('shares the same rootCid the control-plane ref carries', () => {
    const { ref, chunked } = setup();
    assert.equal(ref.rootCid, chunked.rootCid);
  });
});
