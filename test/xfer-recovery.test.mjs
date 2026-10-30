import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { chunkFile, createReceiver, createRefV2, verifyRefV2 } from '../src/agent/transfer/ferry.mjs';

describe('P0-c: ref invariants and conflict recovery', () => {
  it('rejects a ref whose chunkCount does not match size/chunkBytes', () => {
    const ref = createRefV2({ rootCid: 'sha256:' + 'a'.repeat(64), size: 32768, chunkCount: 64, chunkBytes: 262144, originPeer: 'p' }).ref;
    const checked = verifyRefV2(ref);
    assert.equal(checked.ok, false);
    assert.equal(checked.code, 'ARTIFACT_REF_INCONSISTENT');
  });

  it('lets a receiver evict a conflicting block and recover with a correct source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-recover-'));
    const data = Buffer.alloc(32 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 7) % 251;
    const file = join(dir, 'source.bin');
    writeFileSync(file, data);
    const chunked = chunkFile(file, { chunkBytes: 16 * 1024 });
    const ref = createRefV2({ rootCid: chunked.rootCid, size: chunked.size, chunkCount: chunked.chunkCount, chunkBytes: chunked.chunkBytes, originPeer: 'peer-a' }).ref;
    const receiver = createReceiver({ stateDir: join(dir, 'state'), sinkRoot: join(dir, 'sink'), ref, destination: 'out.bin' });
    assert.equal(receiver.ok, true);
    // A poisoned but self-consistent block: correct length, hash computed by the attacker.
    const poisoned = Buffer.alloc(16 * 1024, 0xaa);
    const poisonedHash = createHash('sha256').update(poisoned).digest('hex');
    const first = receiver.writeChunk(0, poisoned, poisonedHash);
    assert.equal(first.ok, true);
    // The honest block for the same index now conflicts, but the conflict is recoverable.
    const honest = Buffer.from(data.subarray(0, 16 * 1024));
    const honestHash = createHash('sha256').update(honest).digest('hex');
    const conflict = receiver.writeChunk(0, honest, honestHash);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'XFER_CHUNK_CONFLICT');
    assert.equal(conflict.recoverable, true);
    assert.equal(receiver.evictChunk(0).ok, true);
    assert.equal(receiver.writeChunk(0, honest, honestHash).ok, true);
    const second = Buffer.from(data.subarray(16 * 1024));
    const secondHash = createHash('sha256').update(second).digest('hex');
    assert.equal(receiver.writeChunk(1, second, secondHash).ok, true);
    const finalized = receiver.finalizeTransfer(ref.rootCid);
    assert.equal(finalized.ok, true, finalized.code);
    assert.deepEqual(readFileSync(finalized.path), data);
  });
});
