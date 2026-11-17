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
import { applyRegistryRestore, planRegistryRestores, verifyRegistryWrite } from '../src/backup/registry.mjs';
import {
  applyRegister,
  DEFAULT_KEEP_REGISTER_BACKUPS,
  planRegister,
  pruneRegisterBackups,
  REGISTER_CODES,
} from '../src/backup/register.mjs';
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

describe('G2: the first-class register path (no ad-hoc scripts)', () => {
  /** Read the registry document of a home. */
  function registryOf(homeDir) {
    return JSON.parse(fs.readFileSync(join(homeDir, 'storages', 'workspace.json'), 'utf8'));
  }

  /** A home with one on-disk session; the registry is passed in so each case states its starting state. */
  function registerHome(registry = registryDocument({ sessionIds: [] })) {
    return makeHome({ sessions: [{ workspace: '--E-GPT--', id: SESSION }], registry });
  }

  /** A `spawnSync`-shaped CLI invocation over the in-process `main` (no process spawn, no real tasklist). */
  function runCli(args, io) {
    const stdout = [];
    const stderr = [];
    const code = main(args, { ...io, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  it('registers an on-disk session: one registry write, read back, and a copy of the document it replaced', () => {
    const home = registerHome();
    try {
      const before = fs.readFileSync(join(home.home, 'storages', 'workspace.json'));
      const plan = planRegister({ dshHome: home.home, sessionIds: [SESSION], clientCheck: () => ({ running: false, detail: 'none' }) });
      assert.equal(plan.ok, true, plan.detail);
      assert.deepEqual(plan.registered, [SESSION]);
      assert.deepEqual(plan.already_registered, []);
      assert.deepEqual(plan.unknown, []);
      assert.equal(plan.changed, true);
      assert.match(plan.backup_file, /[\\/]\.w2m-restore-backups[\\/]register-\d{8}T\d{6}Z[\\/]workspace\.json$/u);

      const applied = applyRegister({ dshHome: home.home, plan });
      assert.equal(applied.ok, true, applied.detail);
      assert.equal(applied.verified, true, 'the write is verified by reading the registry back');
      assert.deepEqual(applied.registered, [SESSION]);
      assert.equal(applied.changed, true);

      const registry = registryOf(home.home);
      assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [SESSION], 'the session is in the workspace that owns the slug');
      assert.equal(fs.existsSync(applied.backup_file), true, 'the registry copy is created');
      assert.ok(fs.readFileSync(applied.backup_file).equals(before), 'the copy is the pre-register document');

      // The read-back proof is not just the apply result: re-running verification over the plan must hold too.
      assert.equal(verifyRegistryWrite({ dshHome: home.home, plan: plan.registry }).ok, true);
    } finally {
      home.cleanup();
    }
  });

  it('is a no-op for an already registered session: it is reported, never rewritten', () => {
    const home = registerHome();
    try {
      const first = applyRegister({ dshHome: home.home, plan: planRegister({ dshHome: home.home, sessionIds: [SESSION] }) });
      assert.equal(first.ok, true, first.detail);
      const written = fs.readFileSync(join(home.home, 'storages', 'workspace.json'));

      const again = planRegister({ dshHome: home.home, sessionIds: [SESSION] });
      assert.equal(again.ok, true, again.detail);
      assert.deepEqual(again.already_registered, [SESSION]);
      assert.equal(again.changed, false);
      assert.equal(again.backup_file, null, 'a no-op has nothing to copy');

      const appliedAgain = applyRegister({ dshHome: home.home, plan: again });
      assert.equal(appliedAgain.ok, true);
      assert.equal(appliedAgain.changed, false);
      assert.equal(appliedAgain.verified, true);
      assert.equal(appliedAgain.backup_file, null);
      assert.ok(fs.readFileSync(join(home.home, 'storages', 'workspace.json')).equals(written), 'the registry bytes are untouched');
    } finally {
      home.cleanup();
    }
  });

  it('preserves the archived/pinned flags it did not set (the ad-hoc repair unarchived sessions), both for a no-op and for a new registration', () => {
    // Half one: an archived+registered session is already registered, so its flags cannot be touched at all.
    const registeredArchived = registerHome(registryDocument({ sessionIds: [SESSION], archived: [SESSION], pinned: [SESSION] }));
    try {
      const plan = planRegister({ dshHome: registeredArchived.home, sessionIds: [SESSION] });
      assert.deepEqual(plan.already_registered, [SESSION]);
      const applied = applyRegister({ dshHome: registeredArchived.home, plan });
      assert.equal(applied.ok, true);
      const registry = registryOf(registeredArchived.home);
      assert.deepEqual(registry.global.archivedSessionIds, [SESSION], 'an archived session stays archived');
      assert.deepEqual(registry.global.pinnedSessionIds, [SESSION], 'a pinned session stays pinned');
    } finally {
      registeredArchived.cleanup();
    }

    // Half two: a session that is on disk and archived-but-not-registered keeps the flags the client already holds.
    const archivedUnregistered = registerHome(registryDocument({ sessionIds: [], archived: [SESSION], pinned: [SESSION] }));
    try {
      const plan = planRegister({ dshHome: archivedUnregistered.home, sessionIds: [SESSION] });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.sessions[0].archived, true, 'the flag is read from the registry view, not defaulted');
      assert.equal(plan.sessions[0].pinned, true);
      const applied = applyRegister({ dshHome: archivedUnregistered.home, plan });
      assert.equal(applied.ok, true, applied.detail);
      const registry = registryOf(archivedUnregistered.home);
      assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [SESSION]);
      assert.deepEqual(registry.global.archivedSessionIds, [SESSION], 'registering did not unarchive it');
      assert.deepEqual(registry.global.pinnedSessionIds, [SESSION], 'registering did not unpin it');
    } finally {
      archivedUnregistered.cleanup();
    }
  });

  it('creates or attaches an unknown workspace only when --workspace-path names one', () => {
    const home = registerHome(registryDocument({ workspace: 'E:\\ToFuture', workspaceId: 'w2', sessionIds: [] }));
    try {
      const before = fs.readFileSync(join(home.home, 'storages', 'workspace.json'));
      const refused = planRegister({ dshHome: home.home, sessionIds: [SESSION] });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, 'BACKUP_RESTORE_WORKSPACE_UNKNOWN');
      assert.match(refused.detail, /--workspace-path/u);
      applyRegister({ dshHome: home.home, plan: refused });
      assert.ok(fs.readFileSync(join(home.home, 'storages', 'workspace.json')).equals(before), 'a workspace refusal writes nothing');

      const attached = planRegister({ dshHome: home.home, sessionIds: [SESSION], workspacePath: 'E:\\GPT' });
      assert.equal(attached.ok, true, attached.detail);
      const applied = applyRegister({ dshHome: home.home, plan: attached });
      assert.equal(applied.ok, true, applied.detail);
      const registry = registryOf(home.home);
      assert.deepEqual(registry.tables.workspaces['restored-e-gpt'].sessionIds, [SESSION]);
      assert.ok(registry.global.workspaceIds.includes('restored-e-gpt'));
    } finally {
      home.cleanup();
    }
  });

  it('refuses an id that is not on disk, lists it, and writes nothing', () => {
    const home = registerHome();
    try {
      const before = fs.readFileSync(join(home.home, 'storages', 'workspace.json'));
      const missing = 'session-ffffffff-9999';
      const plan = planRegister({ dshHome: home.home, sessionIds: [SESSION, missing] });
      assert.equal(plan.ok, false);
      assert.equal(plan.reason_code, REGISTER_CODES.SESSION_MISSING);
      assert.deepEqual(plan.unknown, [missing], 'the refusal lists exactly the ids that were not found');

      const applied = applyRegister({ dshHome: home.home, plan });
      assert.equal(applied.ok, false);
      assert.equal(applied.reason_code, REGISTER_CODES.SESSION_MISSING);
      assert.ok(fs.readFileSync(join(home.home, 'storages', 'workspace.json')).equals(before));
      assert.equal(fs.existsSync(join(home.home, '.w2m-restore-backups')), false, 'a refusal creates nothing, not even a copy');
    } finally {
      home.cleanup();
    }
  });

  it('keeps the registry copies bounded, and never prunes the one the current run wrote', () => {
    const home = registerHome();
    try {
      const root = join(home.home, '.w2m-restore-backups');
      for (const name of ['register-20260101T000000Z', 'register-20260102T000000Z', 'register-20260103T000000Z']) {
        fs.mkdirSync(join(root, name), { recursive: true });
        fs.writeFileSync(join(root, name, 'workspace.json'), '{}');
      }
      const dry = pruneRegisterBackups({ dshHome: home.home, keep: 1, dryRun: true });
      assert.equal(dry.removed_count, 2);
      assert.equal(fs.existsSync(join(root, 'register-20260101T000000Z')), true, 'a dry run deletes nothing');

      const pruned = pruneRegisterBackups({ dshHome: home.home, keep: 2 });
      assert.equal(pruned.removed_count, 1);
      assert.equal(fs.existsSync(join(root, 'register-20260101T000000Z')), false, 'the oldest copy is pruned');
      assert.deepEqual(pruned.kept, ['register-20260103T000000Z', 'register-20260102T000000Z']);

      const all = pruneRegisterBackups({ dshHome: home.home, keep: 0 });
      assert.equal(all.removed_count, 0, 'keep=0 keeps every copy');
      assert.equal(DEFAULT_KEEP_REGISTER_BACKUPS, 10);
    } finally {
      home.cleanup();
    }
  });

  it('refuses while the client runs, and accepts --allow-live-home (then re-checks the registry)', () => {
    const home = registerHome();
    try {
      const env = { ...process.env, DSH_HOME: home.home };
      const clientCheck = () => ({ running: true, detail: 'DeepSeek Harness.exe is running', method: 'process-list', source: 'DeepSeek Harness.exe' });

      const refused = runCli(['register', '--session', SESSION, '--dsh-home', home.home, '--json'], { env, clientCheck });
      assert.equal(refused.code, 1, refused.stdout + refused.stderr);
      const refusalPayload = JSON.parse(refused.stdout);
      assert.equal(refusalPayload.reason_code, CLIENT_CODES.RUNNING);
      assert.equal(JSON.parse(fs.readFileSync(join(home.home, 'storages', 'workspace.json'), 'utf8')).tables.workspaces.w1.sessionIds.length, 0,
        'the refusal wrote nothing');

      const accepted = runCli(['register', '--session', SESSION, '--dsh-home', home.home, '--allow-live-home', '--registry-recheck', '1', '--json'], { env, clientCheck });
      assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
      const payload = JSON.parse(accepted.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.verified, true);
      assert.equal(payload.recheck.ok, true, 'the post-save re-check ran and found the entry still there');
      assert.ok(Array.isArray(payload.actions) && payload.actions.some((action) => action.includes(SESSION)));
      assert.deepEqual(JSON.parse(fs.readFileSync(join(home.home, 'storages', 'workspace.json'), 'utf8')).tables.workspaces.w1.sessionIds, [SESSION]);
    } finally {
      home.cleanup();
    }
  });

  it('documents register in the CLI usage and exits 2 without --session', () => {
    const env = { ...process.env };
    const help = runCli(['help'], { env });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /register\s+register sessions that are already on disk/u);
    assert.match(help.stdout, /--registry-recheck/u);

    const missing = runCli(['register'], { env });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--session/u);

    const unknownFlag = runCli(['register', '--session', SESSION, '--wat'], { env });
    assert.equal(unknownFlag.code, 2);
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
