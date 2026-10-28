/**
 * Regression for the legacy blob purge (old relays still held 215 + 242 data-plane objects).
 *
 * Properties under test:
 *   - the real layout is recursive (`blobs/<aa>/<sha>`), so a flat scan is a bug
 *   - dry-run reports count/bytes and touches nothing
 *   - delete removes every file and prunes the fan-out directories
 *   - quarantine MOVES the files out of the state tree and writes a manifest, byte-for-byte
 *   - a missing directory is a named refusal, an empty one is success
 *   - purge is idempotent
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listBlobs, purgeBlobs } from '../src/relay/purge-blobs.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'w2m-blobs-'));
function store() {
  const dir = root();
  mkdirSync(join(dir, 'aa', 'bb'), { recursive: true });
  mkdirSync(join(dir, 'cc'), { recursive: true });
  mkdirSync(join(dir, 'blob-sessions', 's1'), { recursive: true });
  writeFileSync(join(dir, 'aa', 'bb', 'f'.repeat(64)), 'hello');
  writeFileSync(join(dir, 'cc', 'e'.repeat(64)), 'world!!');
  writeFileSync(join(dir, 'blob-sessions', 's1', 'chunk-0'), 'inflight');
  return dir;
}

describe('blob purge: recursive listing', () => {
  it('finds nested fan-out files and in-flight sessions', () => {
    const dir = store();
    const listed = listBlobs(dir);
    assert.equal(listed.ok, true);
    assert.equal(listed.files.length, 3);
    assert.ok(listed.files.some((file) => file.rel === 'aa/bb/' + 'f'.repeat(64)));
    assert.ok(listed.files.some((file) => file.rel.startsWith('blob-sessions/')));
  });

  it('can exclude in-flight session directories', () => {
    const dir = store();
    const listed = listBlobs(dir, { includeSessions: false });
    assert.equal(listed.files.some((file) => file.rel.startsWith('blob-sessions/')), false);
    assert.equal(listed.files.length, 2);
  });

  it('a missing directory is a named refusal; an empty one is success', () => {
    assert.equal(listBlobs(join(root(), 'nope')).code, 'BLOBS_MISSING');
    assert.equal(purgeBlobs(root()).count, 0);
  });
});

describe('blob purge: dry run', () => {
  it('reports count and bytes without touching files', () => {
    const dir = store();
    const report = purgeBlobs(dir);
    assert.equal(report.ok, true);
    assert.equal(report.dry_run, true);
    assert.equal(report.count, 3);
    assert.equal(report.bytes, 'hello'.length + 'world!!'.length + 'inflight'.length);
    assert.equal(existsSync(join(dir, 'aa', 'bb', 'f'.repeat(64))), true);
  });
});

describe('blob purge: delete', () => {
  it('removes every file, prunes empty fan-out directories and verifies empty', () => {
    const dir = store();
    const report = purgeBlobs(dir, { apply: true });
    assert.equal(report.ok, true);
    assert.equal(report.removed, 3);
    assert.equal(report.remaining, 0);
    assert.equal(listBlobs(dir).files.length, 0);
    assert.equal(existsSync(join(dir, 'aa')), false, 'empty fan-out directory is pruned');
    assert.equal(existsSync(join(dir, 'blob-sessions')), false);
    assert.equal(existsSync(dir), true, 'the store root itself stays');
  });

  it('is idempotent', () => {
    const dir = store();
    purgeBlobs(dir, { apply: true });
    const second = purgeBlobs(dir, { apply: true });
    assert.equal(second.count, 0);
    assert.equal(second.removed, 0);
  });
});

describe('blob purge: quarantine', () => {
  it('moves the files out of the state tree and writes a manifest', () => {
    const dir = store();
    const q = join(root(), 'quarantine');
    const report = purgeBlobs(dir, { apply: true, quarantineDir: q });
    assert.equal(report.ok, true);
    assert.equal(report.quarantined, 3);
    assert.equal(report.remaining, 0);
    assert.ok(existsSync(report.manifest));
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'));
    assert.equal(manifest.count, 3);
    assert.equal(manifest.files.length, 3);
    assert.ok(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
    const moved = readFileSync(join(report.quarantine, 'aa', 'bb', 'f'.repeat(64)), 'utf8');
    assert.equal(moved, 'hello');
    assert.equal(readdirSync(dir).length, 0);
  });
});
