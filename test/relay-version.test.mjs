/**
 * Relay version resolution.
 *
 * The relay runs from the plugin package, but has its own deployment release line: Relay v3.0.0 can
 * ship inside plugin v3.3.15. The explicit `W2M_RELAY_VERSION` must therefore win over the package
 * version, and an empty value must fall back to the package (the pre-v3.0.0 behaviour).
 *
 * `RELAY_VERSION` is computed when `server.mjs` is imported, so each case runs in a child process
 * with its own environment.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

function relayVersion(env) {
  const script = "import('./src/relay/server.mjs').then((m) => process.stdout.write(m.RELAY_VERSION)).catch((e) => { console.error(e); process.exit(1); });";
  const childEnv = { ...process.env, ...env };
  // An undefined override in the caller means "do not set it": delete so the child sees no variable.
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

describe('relay version resolution', () => {
  it('follows the package version when no override is set', () => {
    assert.equal(relayVersion({ W2M_RELAY_VERSION: undefined }), packageVersion);
  });

  it('follows the package version for an empty override (explicit opt-out)', () => {
    assert.equal(relayVersion({ W2M_RELAY_VERSION: '' }), packageVersion);
  });

  it('lets W2M_RELAY_VERSION declare the relay release (3.0.0)', () => {
    assert.equal(relayVersion({ W2M_RELAY_VERSION: '3.0.0' }), '3.0.0');
  });

  it('trims whitespace around the override', () => {
    assert.equal(relayVersion({ W2M_RELAY_VERSION: '  3.0.0  ' }), '3.0.0');
  });
});
