/**
 * v3.7.5 portability regressions.
 *
 * Three findings from the five-machine run, each of which failed for a reason that has nothing to do with the
 * machine it failed on:
 *
 *   1. `scripts/p2p-handshake-check.mjs` hardcoded `C:/Users/fangw/.dsh/xclient/device.json`, so a bare call on
 *      macOS or Linux died with ENOENT and read as "the script is broken" rather than "this machine is not paired".
 *   2. `findHarnessInstallation` knew only the Windows layout, so a restore on macOS refused with
 *      `BACKUP_RUNTIME_UNAVAILABLE` while `/Applications/DeepSeek Harness.app` was installed.
 *   3. The six-row surface probe published `fallback: true` from a single 800 ms round, which a cold start can
 *      miss entirely; the snapshot then stayed wrong for the 30 s poll.
 *
 * The first two are driven here as real functions with fake environments and a fake install tree, because both are
 * pure lookups. The third lives inside `lib/client.js`, which is a browser bundle assembled as one factory and
 * cannot be imported as a module, so its guard reads the shipped source the same way the bundle's other guards do.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveDevicePath } from '../scripts/p2p-handshake-check.mjs';
import { findHarnessInstallation } from '../src/backup/runtime-validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function temporaryDirectory(label) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return base;
}

describe('p2p handshake script resolves its own device.json', () => {
  it('follows DSH_HOME instead of a fixed Windows user path', () => {
    const home = path.join(temporaryDirectory('w2m-device'), 'profile');
    const resolved = resolveDevicePath([], { DSH_HOME: home });
    assert.equal(resolved, path.join(home, 'xclient', 'device.json'));
  });

  it('keeps an explicit --device value untouched', () => {
    const explicit = path.join(temporaryDirectory('w2m-device-explicit'), 'other-device.json');
    assert.equal(resolveDevicePath(['--device', explicit], { DSH_HOME: '/ignored' }), explicit);
  });

  it('does not carry a hardcoded user path in the shipped script', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'p2p-handshake-check.mjs'), 'utf8');
    assert.ok(!/C:\/Users|\/Users\/fangw/.test(source), 'the script must not embed one person\'s device.json path');
    assert.ok(source.includes('resolveStateDir'), 'the default must come from the shared state-dir resolver');
  });
});

describe('the macOS bundle layout is an installation the runtime can use', () => {
  it('finds <HOME>/Applications/DeepSeek Harness.app/Contents with Resources/app.asar and MacOS binary', () => {
    const home = temporaryDirectory('w2m-app-home');
    const contents = path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents');
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Resources', 'app.asar'), 'fake asar');
    const runtime = path.join(contents, 'MacOS', 'DeepSeek Harness');
    fs.writeFileSync(runtime, 'fake binary');

    const found = findHarnessInstallation({ env: { HOME: home }, platform: 'darwin' });
    assert.notEqual(found, null);
    assert.equal(found.source, 'HOME-Applications');
    assert.equal(found.root, contents);
    // The spelling depends on the volume's case sensitivity (this suite may run on a case-insensitive one), so the
    // assertion is that the reported ASAR exists and is the one under Contents -- not which spelling found it.
    assert.ok(fs.existsSync(found.asar), 'the reported ASAR must exist');
    assert.equal(path.basename(found.asar), 'app.asar');
    assert.equal(path.dirname(path.dirname(found.asar)), contents);
    assert.equal(found.runtime, runtime);
  });

  it('accepts the lowercase resources spelling that Windows installs use', () => {
    const root = temporaryDirectory('w2m-app-win');
    const contents = path.join(root, 'DeepSeek Harness');
    fs.mkdirSync(path.join(contents, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'resources', 'app.asar'), 'fake asar');
    fs.writeFileSync(path.join(contents, 'DeepSeek Harness.exe'), 'fake binary');

    const found = findHarnessInstallation({ env: { W2M_DSH_ROOT: contents }, platform: 'win32' });
    assert.notEqual(found, null);
    assert.equal(found.asar, path.join(contents, 'resources', 'app.asar'));
    assert.equal(found.runtime, path.join(contents, 'DeepSeek Harness.exe'));
  });

  it('still returns null when no candidate carries an ASAR', () => {
    const empty = temporaryDirectory('w2m-app-empty');
    assert.equal(findHarnessInstallation({ env: { HOME: empty, W2M_DSH_ROOT: empty }, platform: 'darwin' }), null);
  });
});

describe('the surface probe retries before it publishes a fallback', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

  it('carries a slower second-round budget', () => {
    assert.ok(source.includes('W2M_PROBE_RETRY_TIMEOUT_MS = 2_000'), 'the retry budget must exist and be slower than 800 ms');
  });

  it('runs the second round only when the first answered nothing', () => {
    const block = source.slice(source.indexOf('async function probeW2mSurfaces'), source.indexOf('function syncW2mSurfaceEntries'));
    assert.ok(block.includes('result.definite === true'), 'the retry must be gated on a definite answer from round one');
    assert.ok(block.includes('probeW2mSurface(key, fetchImpl, W2M_PROBE_RETRY_TIMEOUT_MS)'), 'round two must use the slower budget');
  });
});
