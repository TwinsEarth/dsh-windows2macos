/**
 * Durable writes: the temporary file must never be the one that survives, and a failed write must not leave a
 * name that promises content it does not have.
 *
 * The failure direction that matters for a content-addressed store is "the file exists but is short": the next
 * backup would see the name and skip the block forever. These tests pin the temp→fsync→rename order observably
 * (no `.tmp-` survivor, original preserved on failure) rather than inspecting internals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATOMIC_CODES, AtomicWriteError, readJsonSafe, writeFileAtomic, writeJsonAtomic } from '../src/backup/atomic.mjs';

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('atomic: writeFileAtomic', () => {
  it('creates the file and its parent directory, with no temporary file left behind', () => {
    const { dir, cleanup } = tempDir('w2m-atomic-');
    try {
      const file = join(dir, 'nested', 'object');
      const result = writeFileAtomic(file, Buffer.from('payload'));
      assert.equal(result.bytes, 7);
      assert.equal(readFileSync(file, 'utf8'), 'payload');
      assert.deepEqual(readdirSync(join(dir, 'nested')).filter((name) => name.includes('.tmp-')), []);
    } finally {
      cleanup();
    }
  });

  it('replaces an existing file atomically', () => {
    const { dir, cleanup } = tempDir('w2m-atomic-replace-');
    try {
      const file = join(dir, 'file');
      writeFileSync(file, 'old');
      writeFileAtomic(file, 'new');
      assert.equal(readFileSync(file, 'utf8'), 'new');
      assert.equal(readdirSync(dir).length, 1, 'exactly one file must remain: no temp survivors');
    } finally {
      cleanup();
    }
  });

  it('preserves the original when the target cannot be replaced, and leaves no temp file', () => {
    const { dir, cleanup } = tempDir('w2m-atomic-fail-');
    try {
      // A directory in the target's place makes the final rename fail on every platform.
      const target = join(dir, 'target');
      mkdirSync(target);
      assert.throws(
        () => writeFileAtomic(target, 'payload'),
        (error) => (error instanceof AtomicWriteError ? [ATOMIC_CODES.WRITE_FAILED, ATOMIC_CODES.NOT_WRITABLE, ATOMIC_CODES.DISK_FULL].includes(error.code) : false),
      );
      assert.ok(statSync(target).isDirectory(), 'the target must be untouched');
      assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), [], 'the temporary file must be cleaned up');
    } finally {
      cleanup();
    }
  });

  it('writes JSON with a trailing newline', () => {
    const { dir, cleanup } = tempDir('w2m-atomic-json-');
    try {
      const file = join(dir, 'state.json');
      writeJsonAtomic(file, { b: 1, a: [2] });
      const text = readFileSync(file, 'utf8');
      assert.ok(text.endsWith('\n'));
      assert.deepEqual(JSON.parse(text), { b: 1, a: [2] });
    } finally {
      cleanup();
    }
  });
});

describe('atomic: readJsonSafe', () => {
  it('returns the object for valid JSON, and null for missing or broken files', () => {
    const { dir, cleanup } = tempDir('w2m-atomic-read-');
    try {
      const good = join(dir, 'good.json');
      writeFileSync(good, JSON.stringify({ ok: true }));
      assert.deepEqual(readJsonSafe(good), { ok: true });
      assert.equal(readJsonSafe(join(dir, 'missing.json')), null);

      const broken = join(dir, 'broken.json');
      writeFileSync(broken, '{ nope');
      assert.equal(readJsonSafe(broken), null);

      const array = join(dir, 'array.json');
      writeFileSync(array, '[1,2]');
      assert.equal(readJsonSafe(array), null, 'a repository state file is an object; an array is not a valid one');
      assert.equal(existsSync(good), true);
    } finally {
      cleanup();
    }
  });
});
