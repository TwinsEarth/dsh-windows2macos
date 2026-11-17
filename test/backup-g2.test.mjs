/**
 * Gate G2, completed: the three halves of the workspace-registry write protocol.
 *
 *   1. **pause the client** -- refuse to write a home whose client is running (`client.mjs`);
 *   2. **write + read back** -- atomic write and verification (`registry.mjs`, covered in `backup-access`);
 *   3. **re-check after the client saves** -- sample the registry again and re-apply if the client overwrote it
 *      (`registry-watch.mjs`).
 *
 * The tests use injected process lists and injected timers, so the protocol is exercised without spawning
 * `tasklist` and without waiting 20 seconds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { CLIENT_CODES, clientGate, detectClientRunning } from '../src/backup/client.mjs';
import { recheckRegistry, scheduleRegistryRecheck, DEFAULT_RECHECK_DELAYS } from '../src/backup/registry-watch.mjs';
import { applyRegistryRestore, planRegistryRestores } from '../src/backup/registry.mjs';
import { planRestore } from '../src/backup/restore.mjs';
import { runBackup } from '../src/backup/engine.mjs';
import { main } from '../src/backup/cli.mjs';
import { makeHome, registryDocument, runtimeValidHome, tempDir } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const SESSION = 'session-aaaaaaaa-0001';

/** A `spawnSync`-shaped fake that prints `stdout`. */
function fakeRunner(stdout, status = 0) {
  return () => ({ status, stdout, stderr: '', error: undefined });
}

describe('G2: is the client running?', () => {
  it('finds the Windows client by image name, and reports a clean machine as not running', () => {
    const running = detectClientRunning({
      platform: 'win32',
      runner: fakeRunner('"chrome.exe","1234","Console","1","10,000 K"\n"DeepSeek Harness.exe","5678","Console","1","500,000 K"\n'),
    });
    assert.equal(running.running, true);
    assert.equal(running.source, 'DeepSeek Harness.exe');

    const stopped = detectClientRunning({ platform: 'win32', runner: fakeRunner('"chrome.exe","1234","Console","1","10,000 K"\n') });
    assert.equal(stopped.running, false);
  });

  it('finds the client on linux/mac via ps', () => {
    const running = detectClientRunning({ platform: 'linux', runner: fakeRunner('/usr/bin/node\n/opt/DeepSeek Harness/deepseek-harness\n') });
    assert.equal(running.running, true);
    const stopped = detectClientRunning({ platform: 'darwin', runner: fakeRunner('/usr/bin/node\n') });
    assert.equal(stopped.running, false);
  });

  it('distinguishes "could not tell" from "not running"', () => {
    const failed = detectClientRunning({ platform: 'win32', runner: fakeRunner('', 1) });
    assert.equal(failed.running, null);
    const threw = detectClientRunning({
      platform: 'win32',
      runner: () => {
        throw new Error('no process list in this sandbox');
      },
    });
    assert.equal(threw.running, null);
    const unsupported = detectClientRunning({ platform: 'aix' });
    assert.equal(unsupported.running, null);
  });
});

describe('G2: the pause gate', () => {
  it('refuses a running client, unless the caller accepts a live home', () => {
    const running = () => ({ running: true, detail: 'DeepSeek Harness.exe is running', method: 'process-list', source: 'DeepSeek Harness.exe' });
    const refused = clientGate({ check: running });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason_code, CLIENT_CODES.RUNNING);
    assert.match(refused.detail, /--allow-live-home/u);

    const accepted = clientGate({ check: running, allowLiveHome: true });
    assert.equal(accepted.ok, true);
    assert.match(accepted.detail, /read-back/u);
  });

  it('accepts a stopped client and a client it could not inspect', () => {
    assert.equal(clientGate({ check: () => ({ running: false, detail: 'none' }) }).ok, true);
    const unknown = clientGate({ check: () => ({ running: null, detail: 'no process list' }) });
    assert.equal(unknown.ok, true);
    assert.match(unknown.detail, /could not confirm/u);
  });

  it('makes a restore plan refuse while the client runs, before any credential work', () => {
    const source = runtimeValidHome();
    const repo = tempDir('w2m-g2-repo-');
    const run = runBackup({ root: repo.dir, dshHome: source.home, password: PASSWORD, platform: 'linux', machineKey: false });
    assert.equal(run.ok, true, run.detail);
    try {
      const refused = planRestore({
        root: repo.dir,
        dshHome: source.home,
        platform: 'linux',
        machineKey: false,
        clientCheck: () => ({ running: true, detail: 'DeepSeek Harness.exe is running' }),
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, CLIENT_CODES.RUNNING);

      const accepted = planRestore({
        root: repo.dir,
        dshHome: source.home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        clientCheck: () => ({ running: true, detail: 'DeepSeek Harness.exe is running' }),
        allowLiveHome: true,
      });
      assert.equal(accepted.ok, true, accepted.detail);
    } finally {
      repo.cleanup();
      source.cleanup();
    }
  });
});

describe('G2: re-check after the client saves', () => {
  /** A home plus a one-session registry plan, already applied. */
  function appliedPlan() {
    const home = makeHome({ sessions: [{ workspace: '--E-GPT--', id: SESSION }], registry: registryDocument({ sessionIds: [] }) });
    const plan = planRegistryRestores({ dshHome: home.home, sessions: [{ session_id: SESSION, workspace: '--E-GPT--' }] });
    const applied = applyRegistryRestore({ dshHome: home.home, plan });
    assert.equal(applied.ok, true, applied.detail);
    return { home, plan };
  }

  it('confirms a registry that still holds, and repairs one the client overwrote', () => {
    const { home, plan } = appliedPlan();
    try {
      const healthy = recheckRegistry({ dshHome: home.home, plan });
      assert.equal(healthy.ok, true);
      assert.equal(healthy.rewrote, false);

      // The client saves its in-memory copy: the session disappears.
      fs.writeFileSync(join(home.home, 'storages', 'workspace.json'), JSON.stringify(registryDocument({ sessionIds: [] })));
      const repaired = recheckRegistry({ dshHome: home.home, plan });
      assert.equal(repaired.ok, true);
      assert.equal(repaired.rewrote, true);
      const registry = JSON.parse(fs.readFileSync(join(home.home, 'storages', 'workspace.json'), 'utf8'));
      assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [SESSION]);
    } finally {
      home.cleanup();
    }
  });

  it('runs the schedule with injected timers, and reports each sample', async () => {
    const { home, plan } = appliedPlan();
    try {
      const timers = { pending: [], setTimeout: (fn, ms) => { timers.pending.push({ fn, ms }); return ms; }, clearTimeout: () => {} };
      const results = [];
      const schedule = scheduleRegistryRecheck({
        dshHome: home.home,
        plan,
        delaysMs: [10, 20],
        timers,
        onResult: (result) => results.push(result),
      });
      assert.deepEqual(timers.pending.map((row) => row.ms), [10, 20]);
      assert.deepEqual([...DEFAULT_RECHECK_DELAYS], [2000, 8000, 20000]);

      timers.pending[0].fn(); // the client has not saved yet: holds
      fs.writeFileSync(join(home.home, 'storages', 'workspace.json'), JSON.stringify(registryDocument({ sessionIds: [] })));
      timers.pending[1].fn(); // the client saved: repaired

      const final = await schedule.promise;
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((row) => row.ok), [true, true]);
      assert.deepEqual(results.map((row) => row.rewrote), [false, true]);
      assert.equal(final.length, 2);
    } finally {
      home.cleanup();
    }
  });

  it('cancel() empties the schedule without a sample', async () => {
    const { home, plan } = appliedPlan();
    try {
      const timers = { pending: [], setTimeout: (fn, ms) => { timers.pending.push({ fn, ms }); return ms; }, clearTimeout: () => {} };
      const schedule = scheduleRegistryRecheck({ dshHome: home.home, plan, delaysMs: [10], timers });
      schedule.cancel();
      const results = await schedule.promise;
      assert.deepEqual(results, []);
    } finally {
      home.cleanup();
    }
  });
});

describe('G2: the CLI gate', () => {
  function cliFixture() {
    const source = runtimeValidHome();
    const repo = tempDir('w2m-g2-cli-repo-');
    const run = runBackup({ root: repo.dir, dshHome: source.home, password: PASSWORD, platform: 'linux', machineKey: false });
    assert.equal(run.ok, true, run.detail);
    return { source, repo };
  }

  function runCli(args, io) {
    const stdout = [];
    const stderr = [];
    const code = main(args, { ...io, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  it('refuses to apply while the client runs, and proceeds with --allow-live-home', () => {
    const { source, repo } = cliFixture();
    try {
      const env = { ...process.env, DSH_HOME: source.home };
      const base = ['restore', '--apply', '--dsh-home', source.home, '--backup-dir', repo.dir, '--no-machine-key'];
      const refused = runCli(base, { env, password: PASSWORD, clientCheck: () => ({ running: true, detail: 'client is running' }) });
      assert.equal(refused.code, 1);
      assert.match(refused.stdout, /BACKUP_CLIENT_RUNNING/u);

      const accepted = runCli([...base, '--allow-live-home'], { env, password: PASSWORD, clientCheck: () => ({ running: true, detail: 'client is running' }) });
      assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    } finally {
      repo.cleanup();
      source.cleanup();
    }
  });
});
