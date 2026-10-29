import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createManifest, chunkLengths } from '../src/agent/transfer/manifest.mjs';
import { createObjectStore } from '../src/agent/transfer/object-store.mjs';
import { createRef, createRefRegistry, resolveLocal, verifyRef } from '../src/agent/transfer/reference.mjs';

const OBJECT = 'a'.repeat(32);
const split = (buf, chunkBytes) => {
  const out = [];
  for (let offset = 0; offset < buf.length; offset += chunkBytes) out.push(buf.subarray(offset, offset + chunkBytes));
  return out;
};
const setup = () => {
  const data = Buffer.alloc(700 * 1024 + 123);
  for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
  const chunkBytes = 256 * 1024;
  const chunks = split(data, chunkBytes);
  const hashes = chunks.map((c) => createHash('sha256').update(c).digest('hex'));
  const manifest = createManifest({ sizeBytes: data.length, chunkBytes, chunkHashes: hashes, objectId: OBJECT, taskId: 't-1', machineId: 'm-1', kind: 'stdout', sinkKind: 'cache', relPath: OBJECT + '.bin' }).manifest;
  return { data, chunks, manifest, chunkBytes };
};

describe('xfer foundation (C1/C2/C3 local)', () => {
  it('plans chunk boundaries and rejects invalid sizes', () => {
    assert.equal(chunkLengths(0).count, 0);
    assert.equal(chunkLengths(1, 262144).lastChunkBytes, 1);
    assert.equal(chunkLengths(262144, 262144).count, 1);
    assert.equal(chunkLengths(262145, 262144).count, 2);
    assert.equal(chunkLengths(-1).code, 'XFER_SIZE_INVALID');
    assert.equal(chunkLengths(10, 4096).code, 'XFER_CHUNK_SIZE_INVALID');
  });

  it('writes chunks out of order, resumes, commits and verifies', () => {
    const { data, chunks, manifest } = setup();
    const store = createObjectStore({ root: mkdtempSync(join(tmpdir(), 'w2m-xfer-store-')) });
    const begin = store.begin({ objectId: OBJECT, totalBytes: data.length, chunkBytes: manifest.chunk_bytes, rootSha256: manifest.root_sha256 });
    assert.equal(begin.ok, true, begin.code);
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const written = store.writeChunk({ objectId: OBJECT, index: i, bytes: chunks[i], chunkSha256: manifest.chunk_hashes[i] });
      assert.equal(written.ok, true, JSON.stringify(written));
    }
    const resumed = store.begin({ objectId: OBJECT, totalBytes: data.length, chunkBytes: manifest.chunk_bytes, rootSha256: manifest.root_sha256 });
    assert.equal(resumed.resumed, true);
    assert.equal(store.have(OBJECT).complete, true);
    const committed = store.commit(OBJECT);
    assert.equal(committed.ok, true, committed.code);
    assert.equal(committed.sha256, manifest.root_sha256);
    for (let i = 0; i < chunks.length; i += 1) {
      const read = store.readChunk({ objectId: OBJECT, index: i });
      assert.equal(read.ok, true, read.code);
      assert.equal(read.sha256, manifest.chunk_hashes[i]);
    }
    assert.deepEqual(Buffer.concat(chunks), data);
  });

  it('refuses a wrong root and keeps the object uncommitted', () => {
    const { data, chunks, manifest } = setup();
    const store = createObjectStore({ root: mkdtempSync(join(tmpdir(), 'w2m-xfer-bad-')) });
    const wrong = 'f'.repeat(64);
    const begin = store.begin({ objectId: OBJECT, totalBytes: data.length, chunkBytes: manifest.chunk_bytes, rootSha256: wrong });
    assert.equal(begin.ok, true);
    for (let i = 0; i < chunks.length; i += 1) store.writeChunk({ objectId: OBJECT, index: i, bytes: chunks[i] });
    const commit = store.commit(OBJECT);
    assert.equal(commit.ok, false);
    assert.equal(commit.code, 'XFER_ROOT_MISMATCH');
    assert.equal(store.has(OBJECT).complete, false);
  });

  it('detects chunk tampering instead of returning corrupt bytes', () => {
    const { data, chunks, manifest } = setup();
    const store = createObjectStore({ root: mkdtempSync(join(tmpdir(), 'w2m-xfer-tamper-')) });
    store.begin({ objectId: OBJECT, totalBytes: data.length, chunkBytes: manifest.chunk_bytes, rootSha256: manifest.root_sha256 });
    for (let i = 0; i < chunks.length; i += 1) store.writeChunk({ objectId: OBJECT, index: i, bytes: chunks[i] });
    assert.equal(store.commit(OBJECT).ok, true);
    const file = join(store.root, OBJECT + '.bin');
    const buf = readFileSync(file);
    buf[0] ^= 0xff;
    writeFileSync(file, buf);
    const read = store.readChunk({ objectId: OBJECT, index: 0 });
    assert.equal(read.ok, false);
    assert.equal(read.code, 'XFER_CHUNK_HASH_MISMATCH');
  });

  it('publishes a ref locally and resolves only a verified local object', () => {
    const { data, chunks, manifest } = setup();
    const store = createObjectStore({ root: mkdtempSync(join(tmpdir(), 'w2m-xfer-ref-')) });
    store.begin({ objectId: OBJECT, totalBytes: data.length, chunkBytes: manifest.chunk_bytes, rootSha256: manifest.root_sha256 });
    for (let i = 0; i < chunks.length; i += 1) store.writeChunk({ objectId: OBJECT, index: i, bytes: chunks[i] });
    const registry = createRefRegistry({ root: store.root });
    const ref = createRef(manifest);
    assert.equal(ref.ok, true);
    assert.equal(verifyRef(ref.ref).ok, true);
    assert.equal(registry.publish(ref.ref).ok, true);
    assert.equal(registry.get(OBJECT).ok, true);
    assert.equal(registry.list().refs.length, 1);
    const missing = resolveLocal(ref.ref, { store });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'TRANSFER_INCOMPLETE');
    assert.equal(store.commit(OBJECT).ok, true);
    const resolved = resolveLocal(ref.ref, { store });
    assert.equal(resolved.ok, true, resolved.code);
    assert.equal(readFileSync(resolved.path).length, data.length);
  });

  it('expires refs and rejects malformed ones', () => {
    const { manifest } = setup();
    const ref = createRef(manifest, { ttlMs: 1000, now: () => 1000 });
    assert.equal(verifyRef(ref.ref, { now: 5000 }).code, 'DELIVERY_STALE');
    assert.equal(verifyRef({ v: 1 }).code, 'DELIVERY_REF_INVALID');
    assert.equal(verifyRef({ ...ref.ref, chunks: -1 }).code, 'DELIVERY_REF_INVALID');
  });
});
