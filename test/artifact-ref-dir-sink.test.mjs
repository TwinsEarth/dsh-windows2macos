/** S4: ArtifactRef v1 is random-id, metadata-only, HMAC-bound; the dir sink verifies what it returns. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createArtifactRef, verifyArtifactRef } from '../src/util/artifact-ref.mjs';
import { createDirSink } from '../src/agent/sinks/dir-sink.mjs';

const CIPHER_SHA = 'a'.repeat(64);
const base = {
  taskId: 't-1', machineId: 'm-1', kind: 'patch', relPath: 'objects/' + 'b'.repeat(32) + '.json',
  cipherSha256: CIPHER_SHA, cipherBytes: 128, plainBytes: 64, hmacKey: 'fleet-key-for-test',
};

describe('ArtifactRef v1', () => {
  it('builds a random-id, metadata-only ref and verifies it', () => {
    const built = createArtifactRef(base);
    assert.equal(built.ok, true, built.code);
    const ref = built.ref;
    assert.match(ref.object_id, /^[0-9a-f]{32}$/);
    assert.equal(ref.plain.sha256, undefined, 'no plaintext hash in the control plane');
    assert.equal(ref.cipher.sha256, CIPHER_SHA);
    assert.equal(typeof ref.hmac, 'string');
    const verified = verifyArtifactRef(ref, { hmacKey: 'fleet-key-for-test' });
    assert.equal(verified.ok, true, verified.code);
    assert.notEqual(ref.object_id, ref.cipher.sha256.slice(0, 32), 'the id is random, not content-derived');
  });

  it('rejects a tampered ref through the HMAC', () => {
    const ref = createArtifactRef(base).ref;
    const tampered = { ...ref, cipher: { ...ref.cipher, bytes: 999 } };
    const verified = verifyArtifactRef(tampered, { hmacKey: 'fleet-key-for-test' });
    assert.equal(verified.ok, false);
    assert.equal(verified.code, 'ARTIFACT_HMAC_INVALID');
  });

  it('refuses a plaintext hash in the control plane', () => {
    const ref = createArtifactRef(base).ref;
    const withPlain = { ...ref, plain: { bytes: ref.plain.bytes, sha256: 'c'.repeat(64) } };
    const verified = verifyArtifactRef(withPlain, { hmacKey: 'fleet-key-for-test' });
    assert.equal(verified.ok, false);
    assert.equal(verified.code, 'ARTIFACT_PLAINTEXT_HASH_FORBIDDEN');
    const built = createArtifactRef({ ...base, relPath: '..\\escape.json' });
    assert.equal(built.ok, false);
    assert.equal(built.code, 'ARTIFACT_PATH_INVALID');
  });
});

describe('dir sink', () => {
  it('writes atomically and reads back with a verified hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w2m-sink-'));
    const sink = createDirSink({ root });
    const objectId = 'd'.repeat(32);
    const body = JSON.stringify({ sealed: true, payload: 'x' });
    const written = await sink.writeObject({ objectId, body });
    assert.equal(written.ok, true, written.code);
    assert.equal(written.rel_path, objectId + '.json');
    const read = await sink.readObject({ objectId, expectSha256: written.sha256 });
    assert.equal(read.ok, true, read.code);
    assert.equal(read.bytes.toString('utf8'), body);
    const mismatch = await sink.readObject({ objectId, expectSha256: 'f'.repeat(64) });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'OBJECT_HASH_MISMATCH');
    const badId = await sink.readObject({ objectId: '../../etc/passwd' });
    assert.equal(badId.ok, false);
    assert.equal(badId.code, 'OBJECT_ID_INVALID');
  });
});
