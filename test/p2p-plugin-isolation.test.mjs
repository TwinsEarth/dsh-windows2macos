/**
 * `test/p2p-plugin.test.mjs` must leave the machine's own identity directory alone, and must end by itself.
 *
 * The bundle's config (`cordis.patch.yml`) starts the agent, and two cases in that file apply the bundle's config
 * as it ships. With the pin on `autoStartAgent` written *before* the spread, those two cases turned it back on:
 * the real failover stack came up inside the test process with no `stateDir`, which is the machine's own
 * `<DSH_HOME>/xclient`, or `~/.dsh/xclient` when `DSH_HOME` is unset.
 *
 * Measured with a write probe while it happened, 1.1 s into a run of that file:
 *
 *     writeBootstrapCache    bootstrap.json
 *     saveIdentity           device.json        the machine name, replaced by the host name
 *     DeviceKey.save         device.key
 *     publishState           agent-state.json   rewritten for as long as the process lived
 *     appendFailoverLog      relay-failover.log every ten seconds, three production relays probed each time
 *
 * and nothing in that harness could stop the stack, so `node --test` without `--test-force-exit` no longer
 * ended at all on this one file.
 *
 * So the two cases are run here in a child process with a home directory that has never seen this plugin, and
 * the absence of the damage is what is asserted: no identity directory afterwards, and a process that ended on
 * its own. A stack that comes back rewrites the identity within a second or two, well inside the time allowed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SUITE = path.join(ROOT, 'test', 'p2p-plugin.test.mjs');

/** The two cases in that file that apply the bundle's config. Anything else there sets its own relay and state. */
const CASES = 'config the bundle actually ships|bundled empty list';

/** Everything a directory holds, relative to it, for a failure message. */
function inventory(directory) {
  const out = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk('');
  return out;
}

describe('test/p2p-plugin.test.mjs on a machine it has never met', () => {
  it('leaves the identity directory absent, and ends by itself', { timeout: 120_000 }, async (t) => {
    // `os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere, and that is the `~` of `~/.dsh`.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-fresh-home-'));
    const identity = path.join(home, '.dsh', 'xclient');
    t.after(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });
    const env = { ...process.env };
    delete env.DSH_HOME;
    delete env.DSH_DEVICE_FILE;
    // The runner marks its own children with this. Left in place, a child `node --test` takes itself for a
    // recursive run and runs nothing at all.
    delete env.NODE_TEST_CONTEXT;
    env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;

    // No `--test-force-exit`: ending without help is half of what this test is about.
    const limitMs = 30_000;
    const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=${CASES}`, SUITE], {
      env,
      encoding: 'utf8',
      timeout: limitMs,
    });
    const output = `${run.stdout}\n${run.stderr}`;
    const leftBehind = () => JSON.stringify(fs.existsSync(identity) ? inventory(identity) : []);
    if (run.error?.code === 'ETIMEDOUT') {
      assert.fail(`the suite did not end within ${String(limitMs)}ms on its own: something it started was still `
        + `running. It left ${leftBehind()} in the identity directory.\n${output}`);
    }
    assert.equal(run.error, undefined, `node itself failed to start: ${String(run.error)}`);
    assert.match(output, /# pass 2\b/u, `both cases that apply the bundle's config must have run:\n${output}`);
    assert.match(output, /# fail 0\b/u, `the two cases must pass:\n${output}`);

    assert.equal(fs.existsSync(identity), false, `the suite wrote the machine's identity directory: ${leftBehind()}`);
    assert.equal(run.signal, null, `the child had to be killed (${String(run.signal)}): something it started was still running`);
    assert.equal(run.status, 0, `the child exited ${String(run.status)}:\n${output}`);
  });
});
