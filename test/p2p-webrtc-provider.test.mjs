/**
 * The reference provider is not a package dependency. This test pins the honest failure: without
 * `node-datachannel` in `providerCwd`, the child exits by name instead of pretending to be an engine.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const provider = join(here, '..', 'src', 'agent', 'webrtc', 'providers', 'node-datachannel-provider.mjs');

describe('node-datachannel reference provider', () => {
  /** @type {string} */
  let emptyDir;

  before(() => {
    emptyDir = mkdtempSync(join(tmpdir(), 'w2m-webrtc-provider-'));
  });

  after(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('refuses to start when the optional addon is absent, with a named message', async () => {
    const child = spawn(process.execPath, [provider], {
      cwd: emptyDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const code = await new Promise((resolve) => {
      child.on('exit', resolve);
    });
    assert.equal(code, 2);
    assert.match(stderr, /node-datachannel is not installed/);
    assert.match(stderr, /Cannot find module|MODULE_NOT_FOUND/);
  });
});
