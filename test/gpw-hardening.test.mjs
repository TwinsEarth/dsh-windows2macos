/**
 * v1.7.9 — GPW folder-list hardening:
 *   - lists are MAC-signed (an external edit is detected, not silently trusted),
 *   - the file is left read-only after every write (a casual agent edit fails in the filesystem),
 *   - a deleted/unsigned file is reported as tampered (fail closed at the gate),
 *   - the operator reset path clears both lists and re-signs.
 *
 * These are unit tests of the storage helpers; `gpw-folder-policy.test.mjs` covers the gate itself.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

import {
  ensureFoldersKey,
  foldersKeyFileOf,
  macOfFolders,
  readFolders,
  resetFolders,
  writeFolders,
} from '../src/plugin/gpw.mjs';

const fixtures = [];
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'gpw-hardening-'));
  fixtures.push(dir);
  return join(dir, 'gpw-folders.json');
}
after(() => {
  for (const dir of fixtures) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* locked on Windows */
    }
  }
});

const KEY = 'test-key-0123456789';

describe('GPW folder lists are MAC-signed and read-only (v1.7.9)', () => {
  it('writes a signed v2 file and reads the same lists back', () => {
    const file = tempFile();
    writeFolders(file, { whitelist: ['/data/a'], blacklist: ['/data/secret'] }, KEY);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.version, 2);
    assert.equal(typeof raw.mac, 'string');
    assert.equal(raw.mac, macOfFolders(['/data/a'], ['/data/secret'], KEY));
    const read = readFolders(file, KEY);
    assert.deepEqual(read.whitelist, ['/data/a']);
    assert.deepEqual(read.blacklist, ['/data/secret']);
    assert.equal(read.tampered, false);
    assert.equal(read.legacy, false);
  });

  it('leaves the file read-only, so an agent write fails instead of changing policy', () => {
    const file = tempFile();
    writeFolders(file, { whitelist: ['/data/a'], blacklist: [] }, KEY);
    assert.throws(() => writeFileSync(file, '{"whitelist":["/etc"],"blacklist":[]}', 'utf8'), 'a direct write must fail');
    // GPW can still rewrite: it clears the flag and replaces the file atomically.
    writeFolders(file, { whitelist: ['/data/a', '/data/b'], blacklist: [] }, KEY);
    assert.deepEqual(readFolders(file, KEY).whitelist, ['/data/a', '/data/b']);
  });

  it('reports an edit that keeps the old MAC as tampered', () => {
    const file = tempFile();
    writeFolders(file, { whitelist: ['/data/a'], blacklist: ['/data/secret'] }, KEY);
    chmodSync(file, 0o644);
    const forged = { ...JSON.parse(readFileSync(file, 'utf8')), whitelist: ['/'] };
    writeFileSync(file, JSON.stringify(forged, null, 2), 'utf8');
    const read = readFolders(file, KEY);
    assert.equal(read.tampered, true);
    assert.match(read.reason, /modified outside GPW/i);
  });

  it('reports a deleted signed file as tampered (fail closed), unless it is the first run', () => {
    const file = tempFile();
    writeFolders(file, { whitelist: ['/data/a'], blacklist: [] }, KEY);
    rmSync(file);
    assert.equal(readFolders(file, KEY).tampered, true);
    assert.equal(readFolders(file, KEY, { allowMissing: true }).tampered, false);
  });

  it('marks an unsigned legacy file as legacy; the caller migrates it exactly once', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ whitelist: ['/legacy'], blacklist: [] }, null, 2), 'utf8');
    const legacy = readFolders(file, KEY, { allowMissing: true });
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.tampered, false);
    assert.deepEqual(legacy.whitelist, ['/legacy']);
  });

  it('reset clears both lists and re-signs the file', () => {
    const file = tempFile();
    writeFolders(file, { whitelist: ['/data/a'], blacklist: ['/data/b'] }, KEY);
    resetFolders(file, KEY);
    const read = readFolders(file, KEY);
    assert.deepEqual(read.whitelist, []);
    assert.deepEqual(read.blacklist, []);
    assert.equal(read.tampered, false);
  });
});

describe('GPW signing key sidecar (v1.7.9)', () => {
  it('generates a 0600 key file once and reuses it', () => {
    const file = tempFile();
    const first = ensureFoldersKey(file);
    assert.equal(first.created, true);
    assert.equal(first.key.length, 64);
    const keyFile = foldersKeyFileOf(file);
    assert.ok(existsSync(keyFile));
    if (process.platform !== 'win32') {
      assert.equal(statSync(keyFile).mode & 0o077, 0, 'the key file must not be group/world readable');
    }
    const second = ensureFoldersKey(file);
    assert.equal(second.created, false);
    assert.equal(second.key, first.key);
  });

  it('accepts an explicit key from config without touching the sidecar', () => {
    const file = tempFile();
    const key = ensureFoldersKey(file, { foldersKey: KEY });
    assert.equal(key.key, KEY);
    assert.equal(key.created, false);
    assert.equal(existsSync(foldersKeyFileOf(file)), false);
  });
});
