import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  chunkFile, createReceiver, createRefIndex, createRefV2, safeRelative, verifyRefV2,
} from '../src/agent/transfer/ferry.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-ferry-'));
  const data = Buffer.alloc(2 * 1024 * 1024 + 777);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 31) % 253;
  const file = join(dir, 'source.bin');
  writeFileSync(file, data);
  const chunked = chunkFile(file, { chunkBytes: 1024 * 1024 });
  assert.equal(chunked.ok, true, chunked.code);
  const refResult = createRefV2({
    rootCid: chunked.rootCid,
    size: chunked.size,
    chunkCount: chunked.chunkCount,
    chunkBytes: chunked.chunkBytes,
    originPeer: 'm-1',
    sinkHint: 'workspace://artifacts',
  });
  assert.equal(refResult.ok, true, refResult.code);
  return { data, chunked, ref: refResult.ref, sinkRoot: mkdtempSync(join(tmpdir(), 'w2m-ferry-sink-')), stateDir: mkdtempSync(join(tmpdir(), 'w2m-ferry-state-')) };
}

const partsOf = (data, chunkBytes) => {
  const out = [];
  for (let offset = 0; offset < data.length; offset += chunkBytes) out.push(data.subarray(offset, offset + chunkBytes));
  return out;
};

describe('artifact ferry local loop', () => {
  it('chunks a file into 1 MiB pieces with a stable root', () => {
    const { chunked, data } = setup();
    assert.equal(chunked.chunkCount, 3);
    assert.equal(chunked.chunks[2].size, 777);
    assert.equal(chunked.size, data.length);
    assert.match(chunked.rootCid, /^sha256:[0-9a-f]{64}$/);
  });

  it('receives out of order, resumes from the bitmap, finalizes and matches bytes', () => {
    const { chunked, data, ref, sinkRoot, stateDir } = setup();
    const parts = partsOf(data, chunked.chunkBytes);
    let receiver = createReceiver({ stateDir, sinkRoot, ref, destination: 'run/out.bin' });
    assert.equal(receiver.ok, true, receiver.code);
    assert.equal(receiver.writeChunk(1, parts[1], chunked.chunks[1].sha256).ok, true);
    assert.equal(receiver.writeChunk(2, parts[2], chunked.chunks[2].sha256).ok, true);
    assert.deepEqual(receiver.progress().received, 2);
    // 模拟崩溃后重启：位图仍在，缺第 0 块。
    receiver = createReceiver({ stateDir, sinkRoot, ref, destination: 'run/out.bin' });
    assert.equal(receiver.ok, true, receiver.code);
    assert.equal(receiver.progress().received, 2);
    assert.equal(receiver.writeChunk(0, parts[0], chunked.chunks[0].sha256).ok, true);
    const done = receiver.finalizeTransfer(ref.rootCid);
    assert.equal(done.ok, true, done.code);
    assert.equal(done.verified, true);
    assert.equal(sha256(readFileSync(done.path)), sha256(data));
  });

  it('rejects a tampered chunk and keeps it missing', () => {
    const { chunked, ref, sinkRoot, stateDir } = setup();
    const receiver = createReceiver({ stateDir, sinkRoot, ref, destination: 'x.bin' });
    const write = receiver.writeChunk(0, Buffer.alloc(chunked.chunks[0].size), chunked.chunks[0].sha256);
    assert.equal(write.ok, false);
    assert.equal(write.code, 'XFER_CHUNK_HASH_MISMATCH');
    assert.equal(receiver.progress().received, 0);
  });

  it('refuses absolute paths, traversal, drives and UNC roots', () => {
    assert.equal(safeRelative('/etc/passwd').code, 'PATH_ABSOLUTE');
    assert.equal(safeRelative('../secret').code, 'PATH_TRAVERSAL');
    assert.equal(safeRelative('C:/Windows/system.ini').code, 'PATH_ABSOLUTE');
    assert.equal(safeRelative('//server/share/x').code, 'PATH_ABSOLUTE');
    assert.equal(safeRelative('ok/dir/file.bin').ok, true);
    const { ref, sinkRoot, stateDir } = setup();
    assert.equal(createReceiver({ stateDir, sinkRoot, ref, destination: '../escape.bin' }).code, 'PATH_TRAVERSAL');
  });

  it('verifies and publishes a control-plane ref locally', () => {
    const { ref } = setup();
    assert.equal(verifyRefV2(ref).ok, true);
    assert.equal(verifyRefV2({ ...ref, rootCid: 'md5:abc' }).code, 'ARTIFACT_ROOT_INVALID');
    const index = createRefIndex({ dir: mkdtempSync(join(tmpdir(), 'w2m-refidx-')) });
    assert.equal(index.publish(ref).ok, true);
    assert.equal(index.get(ref.ref).ok, true);
    assert.equal(index.list().refs.length, 1);
  });

  it('reports P2P_UNAVAILABLE instead of falling back to relay', async () => {
    const { ref, sinkRoot, stateDir } = setup();
    const receiver = createReceiver({ stateDir, sinkRoot, ref, destination: 'x.bin' });
    const pulled = await receiver.pullFrom('m-2');
    assert.equal(pulled.ok, false);
    assert.equal(pulled.code, 'P2P_UNAVAILABLE');
  });
});
