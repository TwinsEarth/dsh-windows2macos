import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createRefV3, merkleRootSha256, verifyRefV3 } from '../src/agent/transfer/artifact-ref-v3.mjs';
import { chunkFile, createRefV2 } from '../src/agent/transfer/ferry.mjs';

describe('ArtifactRef v3 (optional, dual-hash)', () => {
  it('builds a sha256 v3 ref with a Merkle root and verifies it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-v3-'));
    const file = join(dir, 'f.bin');
    writeFileSync(file, Buffer.alloc(200 * 1024, 9));
    const chunked = chunkFile(file, { chunkBytes: 64 * 1024 });
    const merkleRoot = merkleRootSha256(chunked.chunks.map((chunk) => chunk.sha256));
    assert.match(merkleRoot, /^[0-9a-f]{64}$/);
    assert.equal(merkleRoot, merkleRootSha256(chunked.chunks.map((chunk) => chunk.sha256)), 'deterministic');
    const created = createRefV3({ rootCid: chunked.rootCid, sha256Root: chunked.rootCid, merkleRoot, chunkBytes: chunked.chunkBytes, chunkCount: chunked.chunkCount, size: chunked.size, originPeer: 'peer-a' });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.ref.version, 3);
    assert.equal(created.ref.hashAlg, 'sha256');
    assert.equal(created.ref.rootCid, chunked.rootCid.replace(/^sha256:/, ''));
    assert.equal(verifyRefV3(created.ref).ok, true);
    const bad = { ...created.ref, chunkCount: created.ref.chunkCount + 1 };
    assert.equal(verifyRefV3(bad).code, 'REF_V3_INCONSISTENT');
  });

  it('falls back to sha256 and records the fallback when BLAKE3 is unavailable', () => {
    const created = createRefV3({
      rootCid: 'a'.repeat(64),
      sha256Root: 'a'.repeat(64),
      merkleRoot: 'b'.repeat(64),
      hashAlg: 'blake3',
      blake3Available: false,
      chunkBytes: 1024, chunkCount: 1, size: 10,
    });
    assert.equal(created.ok, true);
    assert.equal(created.ref.hashAlg, 'sha256');
    assert.equal(created.ref.fallbackFrom, 'blake3');
    assert.equal(verifyRefV3(created.ref).ok, true);
  });

  it('refuses a blake3 v3 ref on a runtime without BLAKE3', () => {
    const ref = { version: 3, rootCid: 'c'.repeat(64), sha256Root: 'a'.repeat(64), merkleRoot: 'b'.repeat(64), hashAlg: 'blake3', chunkBytes: 1024, chunkCount: 1, size: 10, originPeer: null };
    assert.equal(verifyRefV3(ref).code, 'XFER_BLAKE3_UNAVAILABLE');
    assert.equal(verifyRefV3(ref, { blake3Available: true }).ok, true);
  });

  it('does not change v2 refs', () => {
    const v2 = createRefV2({ rootCid: 'sha256:' + 'd'.repeat(64), size: 10, chunkCount: 1, chunkBytes: 1024, originPeer: 'p' });
    assert.equal(v2.ok, true);
    assert.equal(v2.ref.v, 2);
  });
});
