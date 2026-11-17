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
  registerThroughHost,
} from '../src/backup/register.mjs';
import {
  REGISTER_RESIDUAL_RISK_LINE,
  sampleWatchSchedule,
  watchRegistrationSync,
  watchSampleSchedule,
} from '../src/backup/register-watch.mjs';
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
    assert.match(help.stdout, /--watch <minutes>/u);

    const missing = runCli(['register'], { env });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--session/u);

    const unknownFlag = runCli(['register', '--session', SESSION, '--wat'], { env });
    assert.equal(unknownFlag.code, 2);
  });

  it('refuses a malformed --watch value with a usage error', () => {
    const env = { ...process.env };
    for (const raw of ['-1', 'abc', '1.5', '']) {
      const bad = runCli(['register', '--session', SESSION, '--watch', raw], { env });
      assert.equal(bad.code, 2, `--watch ${JSON.stringify(raw)} must be a usage error`);
      assert.match(bad.stderr, /--watch needs a non-negative integer number of minutes/u);
    }
  });
});

describe('G2: the bounded register watch (race shrunk and quantified, not removed)', () => {
  function registryOf(homeDir) {
    return JSON.parse(fs.readFileSync(join(homeDir, 'storages', 'workspace.json'), 'utf8'));
  }

  function watchHome() {
    return makeHome({ sessions: [{ workspace: '--E-GPT--', id: SESSION }], registry: registryDocument({ sessionIds: [] }) });
  }

  /** A applied register plan plus the home it applies to. */
  function appliedRegister() {
    const home = watchHome();
    const plan = planRegister({ dshHome: home.home, sessionIds: [SESSION] });
    const applied = applyRegister({ dshHome: home.home, plan });
    assert.equal(applied.ok, true, applied.detail);
    return { home, plan };
  }

  it('samples 2/8/20/60 s, then every 60 s, and stops at the budget', () => {
    assert.deepEqual(watchSampleSchedule({ minutes: 5 }).delays_ms, [2_000, 8_000, 20_000, 60_000, 60_000, 60_000, 60_000]);
    assert.deepEqual(watchSampleSchedule({ budgetMs: 30_000 }).delays_ms, [2_000, 8_000, 20_000]);
    assert.deepEqual(watchSampleSchedule({ minutes: 0 }).delays_ms, [], 'no budget means no watch');
    // A budget that fits none of the early samples schedules nothing rather than sampling after the end.
    assert.deepEqual(watchSampleSchedule({ budgetMs: 1_999 }).delays_ms, []);
  });

  it('without a clobber reports clobbered:0 and a stable_at', () => {
    const { home, plan } = appliedRegister();
    try {
      let now = 0;
      const slept = [];
      const report = watchRegistrationSync({
        dshHome: home.home,
        plan: plan.registry,
        minutes: 5,
        sleep: (ms) => { slept.push(ms); now += ms; },
        now: () => now,
      });
      assert.deepEqual(slept, [2_000, 8_000, 20_000, 60_000, 60_000, 60_000, 60_000]);
      assert.deepEqual(Object.keys(report).sort(), ['clobbered', 'minutes', 'reapplied', 'samples', 'stable_at'].sort());
      assert.equal(report.minutes, 5);
      assert.equal(report.samples, 7);
      assert.equal(report.clobbered, 0);
      assert.equal(report.reapplied, 0);
      assert.equal(typeof report.stable_at, 'string');
    } finally {
      home.cleanup();
    }
  });

  it('detects a simulated client save, re-applies the SAME plan, and does not write a second registry copy', () => {
    const { home, plan } = appliedRegister();
    try {
      const copyRoot = join(home.home, '.w2m-restore-backups');
      const copiesBefore = fs.readdirSync(copyRoot).filter((name) => name.startsWith('register-'));
      assert.equal(copiesBefore.length, 1);
      let now = 0;
      const slept = [];
      const report = watchRegistrationSync({
        dshHome: home.home,
        plan: plan.registry,
        budgetMs: 24_000,
        sleep: (ms) => {
          slept.push(ms);
          now += ms;
          // The client saves its in-memory copy between the first and the second sample.
          if (slept.length === 2) {
            fs.writeFileSync(join(home.home, 'storages', 'workspace.json'), JSON.stringify(registryDocument({ sessionIds: [] })));
          }
        },
        now: () => now,
      });
      assert.deepEqual(slept, [2_000, 8_000], 'a 24 s budget fits exactly the 2 s and 8 s sample');
      assert.equal(report.samples, 2);
      assert.equal(report.clobbered, 1);
      assert.equal(report.reapplied, 1);
      assert.deepEqual(registryOf(home.home).tables.workspaces.w1.sessionIds, [SESSION], 'the same plan was re-applied');
      assert.equal(
        fs.readdirSync(copyRoot).filter((name) => name.startsWith('register-')).length,
        copiesBefore.length,
        'the watch re-apply never takes a second registry copy',
      );
    } finally {
      home.cleanup();
    }
  });

  it('honours the budget with an injectable clock: a sample that would land past the end is not taken', () => {
    const { home, plan } = appliedRegister();
    try {
      let now = 0;
      const samples = [];
      const report = watchRegistrationSync({
        dshHome: home.home,
        plan: plan.registry,
        budgetMs: 6_000,
        sleep: (ms) => { samples.push(ms); now += ms; },
        now: () => now,
      });
      assert.deepEqual(samples, [2_000], 'only the 2 s sample fits in 6 s (the next is 8 s)');
      assert.equal(report.samples, 1);
      assert.deepEqual(watchSampleSchedule({ budgetMs: 6_000 }).delays_ms, [2_000]);
    } finally {
      home.cleanup();
    }
  });

  it('runs the same schedule asynchronously for the host route (injected wait + clock)', async () => {
    const { home, plan } = appliedRegister();
    try {
      let now = 0;
      const waits = [];
      const report = await sampleWatchSchedule({
        dshHome: home.home,
        plan: plan.registry,
        budgetMs: 30_000,
        wait: async (ms) => { waits.push(ms); now += ms; },
        now: () => now,
      });
      assert.deepEqual(waits, [2_000, 8_000, 20_000], 'the host route is capped at 30 s');
      assert.equal(report.samples, 3);
      assert.equal(report.clobbered, 0);
      assert.equal(typeof report.stable_at, 'string');
    } finally {
      home.cleanup();
    }
  });

  it('the CLI --watch reports watch{...} and the honest residual-risk line, with an injectable clock', () => {
    const home = watchHome();
    const stdout = [];
    const stderr = [];
    try {
      let now = 0;
      const slept = [];
      const code = main(['register', '--session', SESSION, '--dsh-home', home.home, '--watch', '5', '--json'], {
        env: { ...process.env, DSH_HOME: home.home },
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        // This test runs on a machine where the real client is open; the gate is injected so the case is about
        // the watch report, not about process detection (which backup-g2's client-gate cases cover).
        clientCheck: () => ({ running: false, detail: 'test: no client' }),
        sleep: (ms) => { slept.push(ms); now += ms; },
        watchNow: () => now,
        // The first sample holds; every later sample reports the client overwrote the entry.
        watchRecheck: () => ({ ok: true, rewrote: slept.length > 1, detail: null }),
      });
      assert.equal(code, 0, stderr.join('\n'));
      const payload = JSON.parse(stdout.join('\n'));
      assert.equal(payload.watch.minutes, 5);
      assert.equal(payload.watch.samples, 7);
      assert.equal(payload.watch.clobbered, 6);
      assert.equal(payload.watch.reapplied, 6);
      assert.equal(typeof payload.watch.stable_at, 'string');
      assert.equal(payload.residual_risk, REGISTER_RESIDUAL_RISK_LINE);
      assert.match(payload.residual_risk, /a client save after the watch window can still remove it; re-run or enable the plugin route/u);
    } finally {
      home.cleanup();
    }
  });

  it('the CLI prints the watch line and the residual-risk line in human output too', () => {
    const home = watchHome();
    const stdout = [];
    const stderr = [];
    try {
      let now = 0;
      const code = main(['register', '--session', SESSION, '--dsh-home', home.home, '--watch', '1'], {
        env: { ...process.env, DSH_HOME: home.home },
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        clientCheck: () => ({ running: false, detail: 'test: no client' }),
        sleep: (ms) => { now += ms; },
        watchNow: () => now,
      });
      const text = stdout.join('\n');
      assert.equal(code, 0, stderr.join('\n') + text);
      // 1 minute fits 2 s + 8 s + 20 s; the 60 s sample would land at 90 s, past the budget.
      assert.match(text, /watch {9}: 1 min · 3 sample\(s\) · clobbered 0 · re-applied 0/u);
      assert.match(text, /residual risk : a client save after the watch window can still remove it/u);
    } finally {
      home.cleanup();
    }
  });
});

describe('G2: the in-host workspace service path (no file-level race)', () => {
  /** A `ctx.workspaceRegistry` fake that records what the host would have been asked to do. */
  function fakeWorkspaceService(options = {}) {
    const attached = [];
    const resolved = [];
    const created = [];
    const service = {
      attached,
      resolved,
      created,
      async resolveByPath(workspacePath) {
        resolved.push(workspacePath);
        if (options.resolve === false) return null;
        return {
          path: workspacePath,
          async attachSession(sessionId) {
            if (options.attachThrows === true) throw new Error('the session header cwd does not resolve to the workspace path');
            attached.push(sessionId);
          },
        };
      },
      async create(workspacePath) {
        created.push(workspacePath);
        return {
          path: workspacePath,
          async attachSession(sessionId) {
            if (options.attachThrows === true) throw new Error('refused by the host service');
            attached.push(sessionId);
          },
        };
      },
    };
    return service;
  }

  function hostHome(registry = registryDocument({ sessionIds: [] })) {
    return makeHome({ sessions: [{ workspace: '--E-GPT--', id: SESSION }], registry });
  }

  it('attaches through the host service and writes nothing to workspace.json', async () => {
    const home = hostHome();
    try {
      const before = fs.readFileSync(join(home.home, 'storages', 'workspace.json'));
      const service = fakeWorkspaceService();
      const result = await registerThroughHost({ dshHome: home.home, sessionIds: [SESSION], workspaceRegistry: service });
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.via, 'host-service');
      assert.equal(result.host_service, true);
      assert.equal(result.residual_risk, null, 'the service path has no file-level residual race to announce');
      assert.deepEqual(result.registered, [SESSION]);
      assert.deepEqual(service.attached, [SESSION]);
      assert.equal(service.resolved.length, 1);
      assert.ok(service.resolved[0].endsWith('E:\\GPT'), `the workspace path comes from the registry view, got ${service.resolved[0]}`);
      assert.ok(fs.readFileSync(join(home.home, 'storages', 'workspace.json')).equals(before), 'the host service owns the write; no file edit happened');
    } finally {
      home.cleanup();
    }
  });

  it('reports already_registered and never attaches an entry that is already in the registry', async () => {
    const home = hostHome(registryDocument({ sessionIds: [SESSION] }));
    try {
      const service = fakeWorkspaceService();
      const result = await registerThroughHost({ dshHome: home.home, sessionIds: [SESSION], workspaceRegistry: service });
      assert.equal(result.ok, true, result.detail);
      assert.deepEqual(result.already_registered, [SESSION]);
      assert.deepEqual(result.registered, []);
      assert.equal(result.changed, false);
      assert.deepEqual(service.attached, []);
    } finally {
      home.cleanup();
    }
  });

  it('refuses with a named code when the profile exposes no service, instead of silently editing the file', async () => {
    const home = hostHome();
    try {
      const before = fs.readFileSync(join(home.home, 'storages', 'workspace.json'));
      const result = await registerThroughHost({ dshHome: home.home, sessionIds: [SESSION], workspaceRegistry: null });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, REGISTER_CODES.HOST_UNAVAILABLE);
      assert.match(result.detail, /w2m-backup register/u);
      assert.ok(fs.readFileSync(join(home.home, 'storages', 'workspace.json')).equals(before));
    } finally {
      home.cleanup();
    }
  });

  it('reports the service’s own attach refusal rather than falling back to a file write', async () => {
    const home = hostHome();
    try {
      const before = fs.readFileSync(join(home.home, 'storages', 'workspace.json'));
      const result = await registerThroughHost({
        dshHome: home.home,
        sessionIds: [SESSION],
        workspaceRegistry: fakeWorkspaceService({ attachThrows: true }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, REGISTER_CODES.HOST_ATTACH_FAILED);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].session_id, SESSION);
      assert.ok(fs.readFileSync(join(home.home, 'storages', 'workspace.json')).equals(before));
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
