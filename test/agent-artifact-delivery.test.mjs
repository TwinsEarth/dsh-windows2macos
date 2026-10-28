/**
 * A3/S4: artifact delivery. Without a sink the bytes stay local and the result says they were not
 * delivered; with a dir sink the sealed bytes are written there and an ArtifactRef is returned.
 * Neither path contacts the relay.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { deliverArtifact } from '../src/agent/artifact-delivery.mjs';

const stateDir = () => mkdtempSync(join(tmpdir(), 'w2m-delivery-state-'));
const task = { taskId: 'task-1', machineId: 'm-1', kind: 'stdout', bytes: Buffer.from('artifact-bytes\n', 'utf8') };

describe('artifact delivery', () => {
  it('keeps bytes locally and reports DATA_PLANE_SINK_REQUIRED when no sink is configured', async () => {
    const dir = stateDir();
    const result = await deliverArtifact({ ...task, stateDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARTIFACT_NOT_DELIVERED');
    assert.equal(result.reason, 'DATA_PLANE_SINK_REQUIRED');
    assert.equal(typeof result.local.path, 'string');
    assert.equal(readFileSync(result.local.path, 'utf8'), 'artifact-bytes\n');
    assert.match(result.local.sha256, /^[0-9a-f]{64}$/);
  });

  it('writes to a configured dir sink and returns an ArtifactRef', async () => {
    const dir = stateDir();
    const sinkRoot = mkdtempSync(join(tmpdir(), 'w2m-delivery-sink-'));
    mkdirSync(join(dir, 'dataplane'), { recursive: true });
    writeFileSync(join(dir, 'dataplane', 'sink.json'), JSON.stringify({ kind: 'dir', root: sinkRoot }), 'utf8');
    const result = await deliverArtifact({ ...task, stateDir: dir });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sha256, result.ref?.cipher?.sha256 ?? result.ref?.cipher_sha256 ?? null, 'the ref names the written bytes');
    const files = readdirSync(sinkRoot);
    assert.equal(files.length, 1, 'exactly one object was written to the sink');
    assert.equal(readFileSync(join(sinkRoot, files[0]), 'utf8'), 'artifact-bytes\n');
    assert.equal(JSON.stringify(result).includes('artifact-bytes'), false, 'the result carries metadata, not the bytes');
  });

  it('falls back to local retention when the sink write fails (hash mismatch)', async () => {
    const dir = stateDir();
    const sinkRoot = mkdtempSync(join(tmpdir(), 'w2m-delivery-bad-'));
    mkdirSync(join(dir, 'dataplane'), { recursive: true });
    writeFileSync(join(dir, 'dataplane', 'sink.json'), JSON.stringify({ kind: 'dir', root: sinkRoot }), 'utf8');
    // A sink whose writeObject refuses the object.
    const result = await deliverArtifact({ ...task, stateDir: dir, sink: { kind: 'dir', writeObject: async () => ({ ok: false, code: 'OBJECT_HASH_MISMATCH' }) } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ARTIFACT_NOT_DELIVERED');
    assert.equal(result.reason, 'OBJECT_HASH_MISMATCH');
    assert.equal(typeof result.local.path, 'string');
  });
});
