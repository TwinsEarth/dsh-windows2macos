/**
 * v1.7.9 — lists are inherited across upgrades, restarts and uninstall/reinstall; only explicit operator actions change
 * them.
 *
 * The guarantee is structural: the signed lists and their MAC key live under `$DSH_HOME/xclient`, outside the plugin
 * package, so replacing the package (upgrade) or removing it (uninstall) cannot take the policy with it. This test pins
 * the file-level behavior — key reuse, re-sign on every boot without data loss, and no implicit deletion — plus the
 * default location being outside any plugin installation directory.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';

import {
  ensureFoldersKey,
  foldersFileOf,
  foldersKeyFileOf,
  readFolders,
  resetFolders,
  writeFolders,
} from '../src/plugin/gpw.mjs';

const fixtures = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gpw-persist-'));
  fixtures.push(dir);
  return dir;
}
after(() => {
  for (const dir of fixtures) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* locked on Windows; the residue report catches it */
    }
  }
});

const WORK = process.platform === 'win32' ? 'C:\\work\\data' : '/work/data';
const SECRET = process.platform === 'win32' ? 'C:\\secrets' : '/secrets';

describe('GPW list inheritance (v1.7.9)', () => {
  it('keeps the key across boots and re-signs the lists without losing rows', () => {
    const dir = fixture();
    const file = join(dir, 'gpw-folders.json');
    const first = ensureFoldersKey(file);
    assert.equal(first.created, true);
    writeFolders(file, { whitelist: [WORK], blacklist: [SECRET] }, first.key);

    // "upgrade": a brand-new plugin instance resolves the same sidecar key and sees the same signed lists.
    const second = ensureFoldersKey(file);
    assert.equal(second.created, false, 'an upgrade must reuse the existing key');
    assert.equal(second.key, first.key);
    const read = readFolders(file, second.key);
    assert.equal(read.tampered, false);
    assert.deepEqual(read.whitelist, [WORK]);
    assert.deepEqual(read.blacklist, [SECRET]);

    // every boot re-signs the file; the rows must survive that rewrite
    writeFolders(file, read, second.key);
    const again = readFolders(file, second.key);
    assert.deepEqual(again.whitelist, [WORK]);
    assert.deepEqual(again.blacklist, [SECRET]);
  });

  it('survives an uninstall/reinstall cycle because the files are outside the plugin package', () => {
    const dir = fixture();
    const file = join(dir, 'gpw-folders.json');
    const { key } = ensureFoldersKey(file);
    writeFolders(file, { whitelist: [WORK], blacklist: [SECRET] }, key);
    // Uninstall deletes the package directory only; nothing in this module deletes the state files.
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(foldersKeyFileOf(file)), true);
    const reinstall = ensureFoldersKey(file);
    assert.equal(reinstall.created, false);
    const read = readFolders(file, reinstall.key);
    assert.equal(read.tampered, false);
    assert.deepEqual(read.whitelist, [WORK]);
    assert.deepEqual(read.blacklist, [SECRET]);
  });

  it('is read-only for casual edits; GPW itself can still rewrite it', () => {
    const dir = fixture();
    const file = join(dir, 'gpw-folders.json');
    const { key } = ensureFoldersKey(file);
    writeFolders(file, { whitelist: [WORK], blacklist: [] }, key);
    if (process.platform === 'win32') {
      assert.equal((statSync(file).mode & 0o200) === 0, true, 'the file carries no owner-write bit on Windows read-only');
      assert.throws(() => writeFileSync(file, 'tampered', 'utf8'), 'an external write fails against the read-only file');
    }
    // GPW's own write path clears the flag first, so an explicit operator change still lands.
    writeFolders(file, { whitelist: [WORK], blacklist: [SECRET] }, key);
    const read = readFolders(file, key);
    assert.deepEqual(read.blacklist, [SECRET]);
  });

  it('changes only through an explicit operator action, never implicitly', () => {
    const dir = fixture();
    const file = join(dir, 'gpw-folders.json');
    const { key } = ensureFoldersKey(file);
    writeFolders(file, { whitelist: [WORK], blacklist: [SECRET] }, key);
    // A read/mount cycle does not remove anything.
    for (let i = 0; i < 3; i += 1) readFolders(file, key);
    assert.deepEqual(readFolders(file, key).whitelist, [WORK]);
    // Explicit removal removes exactly the named row.
    writeFolders(file, { whitelist: [], blacklist: [SECRET] }, key);
    assert.deepEqual(readFolders(file, key).whitelist, []);
    assert.deepEqual(readFolders(file, key).blacklist, [SECRET]);
    // Explicit reset empties both and re-signs.
    resetFolders(file, key);
    const reset = readFolders(file, key);
    assert.equal(reset.tampered, false);
    assert.deepEqual(reset.whitelist, []);
    assert.deepEqual(reset.blacklist, []);
  });

  it('defaults to $DSH_HOME/xclient, outside any plugin installation directory', () => {
    const file = foldersFileOf({});
    assert.match(file, /[\\/]xclient[\\/]gpw-folders\.json$/);
    assert.equal(/node_modules/.test(file), false, 'never inside an installed plugin package');
    assert.equal(/w2m-dsh-plugin/.test(file), false);
    assert.equal(file, foldersFileOf({ foldersFile: file }));
  });
});
