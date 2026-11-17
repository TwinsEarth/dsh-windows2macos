/**
 * The mounted half of v3.4.7: the subplugin's route, its lifecycle, and the CLI commands that write.
 *
 * The route exists only while the row is mounted (a disabled row must not answer `POST /api/w2m/backup/run`), and
 * a `POST` without the confirmation token must never run a backup. Both are asserted here because they are the
 * two ways a "run backup" endpoint turns into an accident.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARCHIVE_CONFIRM_TOKEN,
  BACKUP_ARCHIVE_ROUTE_PATH,
  BACKUP_REGISTER_ROUTE_PATH,
  BACKUP_RESTORE_ROUTE_PATH,
  BACKUP_RUN_ROUTE_PATH,
  BACKUP_UNLOCK_ROUTE_PATH,
  BACKUP_VERIFY_ROUTE_PATH,
  REGISTER_CONFIRM_TOKEN,
  RESTORE_CONFIRM_TOKEN,
  RUN_CONFIRM_TOKEN,
  UNLOCK_CONFIRM_TOKEN,
  apply,
  defaultBackupDir,
  normalizeConfig,
} from '../src/plugin/backup.mjs';
import {
  buildRuntimeVerdictRecord,
  readBackupState,
  writeBackupState,
} from '../src/backup/runtime-verdict.mjs';
import { REGISTER_RESIDUAL_RISK_LINE } from '../src/backup/register-watch.mjs';
import { main, parseArgs } from '../src/backup/cli.mjs';
import { runBackup } from '../src/backup/engine.mjs';
import { bindAccount, readRepoKeys, setRepositoryPassword } from '../src/backup/keystore.mjs';
import { descriptorEncryption, readDescriptor } from '../src/backup/layout.mjs';
import { readIndex, readSnapshot } from '../src/backup/repo.mjs';
import { listOldVersions, recordSupersededVersion } from '../src/backup/rotation.mjs';
import { tempDir, makeHome, registryDocument, runtimeValidHome, sessionLog, event } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';

/** A home with one registered session. */
function homeFixture() {
  return makeHome({
    sessions: [{ workspace: '--E-GPT--', id: 'session-aaaaaaaa-0001' }],
    registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001'] }),
  });
}

/** A fake Cordis context recording registrations, effects and log lines. */
function fakeCtx(options = {}) {
  const registrations = [];
  const disposers = [];
  const logs = [];
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['connection']);
      callback({ connection: { fetch: { register: (definition) => registrations.push(definition) } } });
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    // The account path reads the optional `deepseekAccount` service the same way the real host exposes it
    // (`ctx.get`). Absent by default, which is exactly the signed-out / older-host state the plugin must tolerate.
    get: (name) => (options.services === undefined ? null : (options.services[name] ?? null)),
  };
  return { ctx, registrations, disposers, logs };
}

/** A fake identity service: the account id is already known, so `identify()` never calls getProfile. */
function fakeAccountService(userId) {
  return {
    async getDeviceIdentity() {
      return { userId, deviceId: 'device-1', osVersion: 'win32' };
    },
    async getProfile() {
      throw new Error('getProfile must not be needed when getDeviceIdentity already reports the id');
    },
  };
}

/**
 * A slot that never fires during a test.
 *
 * `backupCatchUpMs: 1` is part of "never": the backup schedule's catch-up window defaults to 12 hours, so a
 * "far-future" 23:59:59 UTC slot is still treated as *missed* (and run immediately) for the twelve hours after
 * midnight UTC -- which made these route tests time-of-day dependent. One millisecond keeps catch-up effectively
 * off for a test while staying inside the config's "positive integer" rule.
 */
const NO_FIRE = { backupTimes: ['23:59:59'], backupTimeZone: 'UTC', backupCatchUpMs: 1 };

/** The account id the compare-only binding tests use (docs/BACKUP-DESIGN.md §25). */
const ACCOUNT = 'user-1234abcd';
const OTHER_ACCOUNT = 'user-9999ffff';

describe('subplugin: configuration', () => {
  it('defaults the directory per platform and the schedule to 22:00 Asia/Shanghai', () => {
    const windows = normalizeConfig({}, { env: {}, platform: 'win32' });
    assert.equal(windows.ok, true);
    assert.equal(windows.backup_dir, 'D:\\DeepSeekHarness\\BackUP');
    assert.deepEqual(windows.times, ['22:00:00']);
    assert.equal(windows.time_zone, 'Asia/Shanghai');
    assert.equal(windows.scope, 'all');
    assert.equal(windows.keep_old_per_session, 10);
    assert.equal(windows.machine_key, true);

    const mac = normalizeConfig({}, { env: {}, platform: 'darwin' });
    assert.equal(mac.backup_dir, join(defaultBackupDir('darwin')));
  });

  it('honours the row configuration and the environment override', () => {
    const configured = normalizeConfig(
      { backupDir: 'E:\\custom', backupTimes: ['06:30'], backupTimeZone: 'UTC', backupScope: 'archived', keepOldPerSession: 3, backupMachineKey: false },
      { env: {}, platform: 'win32' },
    );
    assert.equal(configured.backup_dir, 'E:\\custom');
    assert.deepEqual(configured.times, ['06:30:00']);
    assert.equal(configured.time_zone, 'UTC');
    assert.equal(configured.scope, 'archived');
    assert.equal(configured.keep_old_per_session, 3);
    assert.equal(configured.machine_key, false);

    const fromEnv = normalizeConfig({}, { env: { W2M_BACKUP_DIR: 'F:\\env-dir', W2M_BACKUP_NO_MACHINE_KEY: '1' }, platform: 'win32' });
    assert.equal(fromEnv.backup_dir, 'F:\\env-dir');
    assert.equal(fromEnv.machine_key, false);
  });

  it('refuses an invalid schedule instead of mounting with defaults', () => {
    const bad = normalizeConfig({ backupTimes: ['25:00'] }, { env: {}, platform: 'win32' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason_code, 'BACKUP_SCHEDULE_TIME_INVALID');
  });

  it('normalizes the age retention window and refuses an invalid value', () => {
    const defaults = normalizeConfig({}, { env: {}, platform: 'win32' });
    assert.equal(defaults.ok, true);
    assert.equal(defaults.old_version_days, 0, 'the age rule is off unless configured');
    assert.equal(normalizeConfig({ backupOldVersionDays: 0 }, { env: {}, platform: 'win32' }).old_version_days, 0);
    assert.equal(normalizeConfig({ backupOldVersionDays: 7 }, { env: {}, platform: 'win32' }).old_version_days, 7);
    for (const bad of [-1, 1.5, '7', true]) {
      const refused = normalizeConfig({ backupOldVersionDays: bad }, { env: {}, platform: 'win32' });
      assert.equal(refused.ok, false, `backupOldVersionDays=${String(bad)} must be refused`);
      assert.equal(refused.reason_code, 'BACKUP_CONFIG_INVALID');
      assert.match(refused.detail, /backupOldVersionDays must be a non-negative integer/u);
    }
  });

  it('normalizes backupOldFormat and refuses an invalid value', () => {
    const defaults = normalizeConfig({}, { env: {}, platform: 'win32' });
    assert.equal(defaults.ok, true);
    assert.equal(defaults.old_format, 'records', 'records is the default: the dedupe-preserving shape');
    assert.equal(normalizeConfig({ backupOldFormat: 'records' }, { env: {}, platform: 'win32' }).old_format, 'records');
    assert.equal(normalizeConfig({ backupOldFormat: 'full' }, { env: {}, platform: 'win32' }).old_format, 'full');
    for (const bad of ['FULL', 'record', 1, true]) {
      const refused = normalizeConfig({ backupOldFormat: bad }, { env: {}, platform: 'win32' });
      assert.equal(refused.ok, false, `backupOldFormat=${String(bad)} must be refused`);
      assert.equal(refused.reason_code, 'BACKUP_CONFIG_INVALID');
      assert.match(refused.detail, /backupOldFormat must be one of records, full/u);
    }
  });

  it('normalizes the offsite mirror directory, treating absent/empty as none and refusing a non-string', () => {
    const { dir, cleanup } = tempDir('w2m-config-mirror-');
    try {
      const mirror = join(dir, 'offsite');
      const defaults = normalizeConfig({}, { env: {}, platform: 'win32' });
      assert.equal(defaults.mirror_dir, null);
      assert.equal(normalizeConfig({ backupMirrorDir: '' }, { env: {}, platform: 'win32' }).mirror_dir, null);
      assert.equal(normalizeConfig({ backupMirrorDir: '   ' }, { env: {}, platform: 'win32' }).mirror_dir, null);
      assert.equal(normalizeConfig({ backupMirrorDir: mirror }, { env: {}, platform: 'win32' }).mirror_dir, mirror);
      // Containment (inside the repository/home) is a run-time refusal, because only a run knows the repository
      // that will actually be used; the configuration layer only normalizes the path.
      assert.equal(normalizeConfig({ backupMirrorDir: join(dir, 'repo', 'mirror'), backupDir: join(dir, 'repo') }, { env: {}, platform: 'win32' }).ok, true);
      for (const bad of [42, {}, []]) {
        const refused = normalizeConfig({ backupMirrorDir: bad }, { env: {}, platform: 'win32' });
        assert.equal(refused.ok, false);
        assert.equal(refused.reason_code, 'BACKUP_CONFIG_INVALID');
        assert.match(refused.detail, /backupMirrorDir must be a path string/u);
      }
    } finally {
      cleanup();
    }
  });
  it('normalizes the account-binding switch (on by default, config can turn it off)', () => {
    assert.equal(normalizeConfig({}, { env: {}, platform: 'win32' }).account_binding, true,
      'the user decision is on by default: bind the account id after a successful sealed run');
    assert.equal(normalizeConfig({ backupAccountBinding: true }, { env: {}, platform: 'win32' }).account_binding, true);
    assert.equal(normalizeConfig({ backupAccountBinding: false }, { env: {}, platform: 'win32' }).account_binding, false);
    // Any other value is truthy-by-default rather than silently disabling a compare-only convenience path.
    assert.equal(normalizeConfig({ backupAccountBinding: 0 }, { env: {}, platform: 'win32' }).account_binding, true);
  });

  it('normalizes the protection mode (none is the default) and refuses an invalid value', () => {
    const defaults = normalizeConfig({}, { env: {}, platform: 'win32' });
    assert.equal(defaults.ok, true);
    assert.equal(defaults.encryption, 'none', 'the user decision: a new repository is unencrypted by default');
    assert.equal(normalizeConfig({ backupEncryption: 'none' }, { env: {}, platform: 'win32' }).encryption, 'none');
    assert.equal(normalizeConfig({ backupEncryption: 'sealed' }, { env: {}, platform: 'win32' }).encryption, 'sealed');
    for (const bad of ['NONE', 'encrypted', 1, true]) {
      const refused = normalizeConfig({ backupEncryption: bad }, { env: {}, platform: 'win32' });
      assert.equal(refused.ok, false, `backupEncryption=${String(bad)} must be refused`);
      assert.equal(refused.reason_code, 'BACKUP_CONFIG_INVALID');
      assert.match(refused.detail, /backupEncryption must be one of none, sealed/u);
    }
  });
});

describe('subplugin: the route and the timer', () => {
  it('registers one run route and starts a scheduler that the effect can stop', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-route-');
    try {
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE });
      assert.equal(fake.registrations.length, 6, 'v3.4.8 adds restore/archive/verify/unlock; the register repair adds the sixth');
      assert.deepEqual(
        fake.registrations.map((row) => row.path).sort(),
        [BACKUP_RUN_ROUTE_PATH, BACKUP_RESTORE_ROUTE_PATH, BACKUP_ARCHIVE_ROUTE_PATH, BACKUP_VERIFY_ROUTE_PATH, BACKUP_UNLOCK_ROUTE_PATH, BACKUP_REGISTER_ROUTE_PATH].sort(),
      );
      assert.deepEqual(fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH).methods, ['GET', 'POST']);
      assert.deepEqual(fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH).methods, ['GET', 'POST']);
      assert.equal(fake.disposers.length, 2, 'ctx.effect owns the scheduler and the post-restore registry recheck');

      const get = await fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH).fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, { method: 'GET' }));
      const state = await get.json();
      assert.equal(state.ok, true);
      assert.equal(state.enabled, true);
      assert.deepEqual(state.schedule.times, ['23:59:59']);
      assert.equal(state.schedule.time_zone, 'UTC');
      assert.equal(state.scheduler.time_zone, 'UTC');
      assert.equal(state.old_format, 'records', 'the describe payload names the default old-version shape');

      fake.disposers[0]();
      const stopped = await (await fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH).fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, { method: 'GET' }))).json();
      assert.equal(stopped.scheduler.stopped, true, 'the effect disposer must stop the timer');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('requires the confirmation token, and refuses an invalid scope before running', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-confirm-');
    try {
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE });
      const url = `http://local.invalid${BACKUP_RUN_ROUTE_PATH}`;
      const fetch = fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH).fetch;

      const noConfirm = await fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }));
      assert.equal(noConfirm.status, 400);
      assert.equal((await noConfirm.json()).reason_code, 'BACKUP_CONFIRM_REQUIRED');

      const badScope = await fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: RUN_CONFIRM_TOKEN, scope: 'everything' }) }));
      assert.equal(badScope.status, 400);
      assert.equal((await badScope.json()).reason_code, 'BACKUP_SCOPE_INVALID');

      const wrongMethod = await fetch(new Request(url, { method: 'PUT' }));
      assert.equal(wrongMethod.status, 405);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('runs an unencrypted repository by default, and refuses a sealed run when this platform has no credential', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-default-mode-');
    try {
      // Even with a resolvable host account id, an unencrypted repository must stay unencrypted: the id is a
      // convenience path for sealed repositories, not a reason to seal the default mode after the first run.
      const fake = fakeCtx({ services: { deepseekAccount: fakeAccountService(ACCOUNT) } });
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE });
      const route = fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH);
      const post = () => route.fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: RUN_CONFIRM_TOKEN }),
      }));
      const response = await post();
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true, `${body.reason_code}: ${body.detail}`);
      assert.equal(body.encryption, 'none', 'backupEncryption defaults to none: no credential is needed');
      assert.equal(body.unlocked_via, 'none');
      assert.equal(body.account_binding, undefined, 'an unencrypted repository is never account-bound');
      assert.deepEqual(readRepoKeys(join(dir, 'repo')).keys.envelopes.map((envelope) => envelope.kind), ['open']);
      assert.equal(fake.logs.some((entry) => entry.level === 'warn' && entry.message.includes('BACKUP_NO_PERMISSION')), false);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('answers a confirmed sealed run with the engine refusal when this platform has no usable credential', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-noperm-');
    try {
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, backupEncryption: 'sealed', ...NO_FIRE });
      const response = await fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH).fetch(
        new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: RUN_CONFIRM_TOKEN }),
        }),
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.reason_code, 'BACKUP_NO_PERMISSION', 'a sealed scheduled/UI run has no PIN and must refuse rather than write an unopenable repository');
      assert.match(body.detail, /sealed/u);
      assert.ok(fake.logs.some((entry) => entry.level === 'warn' && entry.message.includes('BACKUP_NO_PERMISSION')));
    } finally {
      cleanup();
      cleanHome();
    }
  });


  it(
    'answers a confirmed run on Windows with a real machine envelope (the panel path)',
    { skip: process.platform === 'win32' ? false : 'DPAPI is Windows-only' },
    async () => {
      const { home, cleanup: cleanHome } = homeFixture();
      const { dir, cleanup } = tempDir('w2m-run-win32-');
      try {
        const fake = fakeCtx();
        apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupEncryption: 'sealed', ...NO_FIRE });
        const response = await fake.registrations.find((row) => row.path === BACKUP_RUN_ROUTE_PATH).fetch(
          new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: RUN_CONFIRM_TOKEN }),
          }),
        );
        const body = await response.json();
        assert.equal(body.ok, true, body.reason_code + ': ' + body.detail);
        assert.equal(body.unlocked_via, 'machine', 'the OS keystore must be what unlocks an unattended run');
        assert.match(body.snapshot_id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u);
      } finally {
        cleanup();
        cleanHome();
      }
    },
  );

  it('exposes the v3.4.8 routes with their confirmation tokens', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-route-v348-');
    try {
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE });
      const find = (path) => fake.registrations.find((row) => row.path === path);
      const post = (path, body) => find(path).fetch(new Request(`http://local.invalid${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

      for (const [path, token] of [
        [BACKUP_RESTORE_ROUTE_PATH, RESTORE_CONFIRM_TOKEN],
        [BACKUP_ARCHIVE_ROUTE_PATH, ARCHIVE_CONFIRM_TOKEN],
        [BACKUP_UNLOCK_ROUTE_PATH, UNLOCK_CONFIRM_TOKEN],
        [BACKUP_REGISTER_ROUTE_PATH, REGISTER_CONFIRM_TOKEN],
      ]) {
        const refused = await post(path, {});
        assert.equal(refused.status, 400);
        const payload = await refused.json();
        assert.equal(payload.reason_code, 'BACKUP_CONFIRM_REQUIRED');
        assert.match(payload.detail, new RegExp(token, 'u'));
      }

      const unlock = await find(BACKUP_UNLOCK_ROUTE_PATH).fetch(new Request(`http://local.invalid${BACKUP_UNLOCK_ROUTE_PATH}`, { method: 'GET' }));
      const described = await unlock.json();
      assert.equal(described.ok, false, 'no repository yet: the describe route names that state');
      assert.equal(described.reason_code, 'BACKUP_REPO_NOT_INITIALIZED');

      const verify = await find(BACKUP_VERIFY_ROUTE_PATH).fetch(new Request(`http://local.invalid${BACKUP_VERIFY_ROUTE_PATH}`, { method: 'GET' }));
      const verified = await verify.json();
      assert.equal(verified.ok, false);
      assert.equal(verified.reason_code, 'BACKUP_REPO_NOT_INITIALIZED');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('exposes the PUBLIC password hint on the unlock and status payloads, never the PIN', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-route-hint-');
    try {
      const repo = join(dir, 'repo');
      // Seed an unencrypted repository, then give it a 4-digit PIN and its public hint (the supported path;
      // an existing PIN is never rotated, so this is how a hinted PIN repository is created).
      const seed = runBackup({ root: repo, dshHome: home, platform: 'linux', machineKey: false });
      assert.equal(seed.ok, true, seed.detail);
      const pinned = setRepositoryPassword({
        root: repo, dshHome: home, password: '1234', hint: '周六生日', platform: 'linux', machineKey: false,
      });
      assert.equal(pinned.ok, true, pinned.detail);
      assert.equal(pinned.added, true);

      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: repo, dshHome: home, backupMachineKey: false, ...NO_FIRE });
      const find = (path) => fake.registrations.find((row) => row.path === path);
      const get = async (path) => (await find(path).fetch(new Request(`http://local.invalid${path}`, { method: 'GET' }))).json();

      const described = await get(BACKUP_UNLOCK_ROUTE_PATH);
      assert.equal(described.ok, true);
      assert.deepEqual(described.password_hint, { set: true, text: '周六生日' }, 'the unlock describe carries the public hint');
      assert.equal(JSON.stringify(described).includes('"1234"'), false, 'the PIN is never part of the unlock describe');

      // The status half of the run describe carries the same additive field (the panel's status card source).
      const runDescribe = await get(BACKUP_RUN_ROUTE_PATH);
      assert.deepEqual(runDescribe.status.password_hint, { set: true, text: '周六生日' }, 'the status payload carries the public hint');
      assert.equal(JSON.stringify(runDescribe.status).includes('"1234"'), false);

      // The POST attempt carries it too: a failed attempt still tells the operator what the hint says.
      const attempted = await (await find(BACKUP_UNLOCK_ROUTE_PATH).fetch(new Request(`http://local.invalid${BACKUP_UNLOCK_ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: UNLOCK_CONFIRM_TOKEN }),
      }))).json();
      assert.equal(attempted.ok, false, 'no machine/account credential is available here, so the attempt is the unified refusal');
      assert.deepEqual(attempted.password_hint, { set: true, text: '周六生日' });
      assert.equal(JSON.stringify(attempted).includes('"1234"'), false);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it(
    'answers a confirmed restore plan and archive on Windows (machine envelope, real DPAPI)',
    { skip: process.platform === 'win32' ? false : 'DPAPI is Windows-only' },
    async () => {
      const source = runtimeValidHome();
      const { dir, cleanup } = tempDir('w2m-route-v348-win-');
      try {
        const fake = fakeCtx();
        apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: source.home, backupEncryption: 'sealed', ...NO_FIRE });
        const find = (path) => fake.registrations.find((row) => row.path === path);
        const post = (path, body) => find(path).fetch(new Request(`http://local.invalid${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

        // First backup through the run route: it creates the repository with a machine envelope.
        const runResponse = await post(BACKUP_RUN_ROUTE_PATH, { confirm: RUN_CONFIRM_TOKEN, scope: 'all' });
        assert.equal((await runResponse.json()).ok, true);

        const archive = await post(BACKUP_ARCHIVE_ROUTE_PATH, { confirm: ARCHIVE_CONFIRM_TOKEN, scope: 'all' });
        const archived = await archive.json();
        assert.equal(archived.ok, true, archived.detail);

        const restore = await post(BACKUP_RESTORE_ROUTE_PATH, { confirm: RESTORE_CONFIRM_TOKEN });
        const plan = await restore.json();
        assert.equal(plan.ok, true, plan.detail);
        assert.equal(plan.summary.sessions, 1);
        assert.equal(plan.summary.conflicts, 0, 'restoring into the same home sees its own log as identical');

        const applied = await (await post(BACKUP_RESTORE_ROUTE_PATH, { confirm: RESTORE_CONFIRM_TOKEN, apply: true })).json();
        assert.equal(applied.ok, true, applied.detail);
        assert.equal(applied.skipped, 1, 'an identical log must be skipped, not rewritten');
        assert.equal(applied.registry_recheck?.scheduled, true, 'G2 half three: the registry is re-checked after the client saves');
      } finally {
        cleanup();
        source.cleanup();
      }
    },
  );

  it('compares the host account id on the unlock describe route and only returns the masked hint', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-route-account-');
    try {
      const repo = join(dir, 'repo');
      const created = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(created.ok, true, created.detail);
      const bound = bindAccount({ root: repo, dshHome: home, accountId: ACCOUNT, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(bound.ok, true, bound.detail ?? '');

      const describedWith = async (userId, config = {}) => {
        const fake = fakeCtx({ services: { deepseekAccount: fakeAccountService(userId) } });
        apply(fake.ctx, { backupDir: repo, dshHome: home, backupMachineKey: false, ...NO_FIRE, ...config });
        const route = fake.registrations.find((row) => row.path === BACKUP_UNLOCK_ROUTE_PATH);
        const response = await route.fetch(new Request(`http://local.invalid${BACKUP_UNLOCK_ROUTE_PATH}`, { method: 'GET' }));
        return response.json();
      };

      const matched = await describedWith(ACCOUNT);
      assert.equal(matched.ok, true);
      assert.deepEqual(matched.account, { bound: true, matched: true, id_hint: '…abcd' });
      assert.equal(JSON.stringify(matched).includes(ACCOUNT), false, 'the full account id never reaches the panel');

      const mismatched = await describedWith(OTHER_ACCOUNT);
      assert.equal(mismatched.account.matched, false, 'the panel gets the "not the original account" state');
      assert.equal(JSON.stringify(mismatched).includes(OTHER_ACCOUNT), false);

      // Binding switched off: no account id is read, so nothing is compared -- the password/machine paths are
      // unchanged and the panel sees `matched: null` rather than a guess.
      const off = await describedWith(ACCOUNT, { backupAccountBinding: false });
      assert.equal(off.account.bound, true);
      assert.equal(off.account.matched, null, 'binding off means no comparison happens');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it(
    'binds the host account id after a successful run route call, then unlocks through it (Windows DPAPI)',
    { skip: process.platform === 'win32' ? false : 'DPAPI is Windows-only' },
    async () => {
      const { home, cleanup: cleanHome } = homeFixture();
      const { dir, cleanup } = tempDir('w2m-route-account-run-');
      try {
        const fake = fakeCtx({ services: { deepseekAccount: fakeAccountService(ACCOUNT) } });
        apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupEncryption: 'sealed', ...NO_FIRE });
        const find = (path) => fake.registrations.find((row) => row.path === path);
        const post = (path, body) => find(path).fetch(new Request(`http://local.invalid${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }));

        const run = await (await post(BACKUP_RUN_ROUTE_PATH, { confirm: RUN_CONFIRM_TOKEN, scope: 'all' })).json();
        assert.equal(run.ok, true, `${run.reason_code}: ${run.detail}`);
        assert.equal(run.account_binding?.bound, true, 'the run result reports the account binding');
        assert.equal(run.account_binding?.added, true);
        assert.equal(run.account_binding?.id_hint, '…abcd');

        const unlock = await (await find(BACKUP_UNLOCK_ROUTE_PATH).fetch(new Request(`http://local.invalid${BACKUP_UNLOCK_ROUTE_PATH}`, { method: 'GET' }))).json();
        assert.equal(unlock.account.matched, true, 'the host id read back through the same account service matches');

        const opened = await (await post(BACKUP_UNLOCK_ROUTE_PATH, { confirm: UNLOCK_CONFIRM_TOKEN })).json();
        assert.equal(opened.ok, true, opened.detail ?? '');
        assert.equal(opened.via, 'account', 'the matching account is the credential that opened it');
        assert.equal(JSON.stringify(opened).includes(ACCOUNT), false, 'the unlock response never carries the full id');
      } finally {
        cleanup();
        cleanHome();
      }
    },
  );

  it('registers nothing when the row is mounted but disabled', () => {
    const fake = fakeCtx();
    apply(fake.ctx, { backupEnabled: false, backupDir: 'E:\\unused' });
    assert.equal(fake.registrations.length, 0);
    assert.equal(fake.disposers.length, 0);
  });

  it('logs and skips the mount when the configuration is invalid', () => {
    const fake = fakeCtx();
    apply(fake.ctx, { backupTimes: ['99:99'], backupDir: 'E:\\unused' });
    assert.equal(fake.registrations.length, 0);
    assert.ok(fake.logs.some((entry) => entry.level === 'warn' && entry.message.includes('BACKUP_SCHEDULE_TIME_INVALID')));
  });

  it('logs and skips the mount when the retention configuration is invalid', () => {
    const fake = fakeCtx();
    apply(fake.ctx, { backupOldVersionDays: -1, backupDir: 'E:\\unused' });
    assert.equal(fake.registrations.length, 0);
    assert.ok(fake.logs.some((entry) => entry.level === 'warn' && entry.message.includes('BACKUP_CONFIG_INVALID')));
  });

  it(
    'flows an offsite mirror through the run route and the describe payload (Windows DPAPI)',
    { skip: process.platform === 'win32' ? false : 'DPAPI is Windows-only' },
    async () => {
      const { home, cleanup: cleanHome } = homeFixture();
      const { dir, cleanup } = tempDir('w2m-route-mirror-');
      try {
        const fake = fakeCtx();
        const mirror = join(dir, 'mirror');
        apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMirrorDir: mirror, backupOldVersionDays: 30, ...NO_FIRE });
        const find = (path) => fake.registrations.find((row) => row.path === path);
        const url = `http://local.invalid${BACKUP_RUN_ROUTE_PATH}`;

        const response = await find(BACKUP_RUN_ROUTE_PATH).fetch(
          new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: RUN_CONFIRM_TOKEN }) }),
        );
        const body = await response.json();
        assert.equal(body.ok, true, `${body.reason_code}: ${body.detail}`);
        assert.equal(body.mirror?.ok, true, body.mirror?.reason);
        assert.equal(body.max_old_version_days, 30, 'the configured age window reaches the engine');
        assert.equal(body.warnings, undefined, 'a successful mirror needs no warning');

        const state = await (await find(BACKUP_RUN_ROUTE_PATH).fetch(new Request(url, { method: 'GET' }))).json();
        assert.equal(state.mirror_dir, mirror);
        assert.deepEqual(state.retention, { keep_old_per_session: 10, old_version_days: 30 });
        assert.equal(state.state.last_result.mirror.ok, true);
        assert.deepEqual(state.state.last_result.warnings, []);
      } finally {
        cleanup();
        cleanHome();
      }
    },
  );
});

describe('cli: run / list / gc', () => {
  const capture = () => {
    const lines = [];
    return { lines, io: { stdout: (text) => lines.push(text), stderr: (text) => lines.push(text) } };
  };

  it('runs a backup with the password from the injected io, then lists it and shows deduplication', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-run-');
    try {
      const repo = join(dir, 'repo');
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };

      const first = capture();
      const code = main(['run', '--backup-dir', repo, '--dsh-home', home, '--json'], { ...first.io, env, password: PASSWORD });
      assert.equal(code, 0, first.lines.join('\n'));
      const firstJson = JSON.parse(first.lines.join('\n'));
      assert.equal(firstJson.ok, true, firstJson.detail);
      assert.equal(firstJson.sessions, 1);
      assert.ok(firstJson.blocks_new > 0);
      assert.equal(firstJson.encryption, 'sealed', 'a password/PIN creates a sealed repository');
      assert.equal(firstJson.unlocked_via, 'password');

      const second = capture();
      assert.equal(main(['run', '--backup-dir', repo, '--dsh-home', home, '--json'], { ...second.io, env, password: PASSWORD }), 0);
      const secondJson = JSON.parse(second.lines.join('\n'));
      assert.equal(secondJson.blocks_new, 0, 'the second CLI run must not rewrite blocks');
      assert.equal(readIndex(repo).entries.length, 2);

      const list = capture();
      assert.equal(main(['list', '--backup-dir', repo, '--json'], { ...list.io, env, password: PASSWORD }), 0);
      const listJson = JSON.parse(list.lines.join('\n'));
      assert.equal(listJson.initialized, true);
      assert.equal(listJson.snapshots.length, 2);
      assert.equal(listJson.index.entries, 2);

      const gcRun = capture();
      assert.equal(main(['gc', '--backup-dir', repo, '--dry-run', '--json'], { ...gcRun.io, env }), 0);
      const gcJson = JSON.parse(gcRun.lines.join('\n'));
      assert.equal(gcJson.safe, true);
      assert.equal(gcJson.dry_run, true);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('runs unencrypted by default without a credential, and refuses only when sealed protection is requested', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-refuse-');
    try {
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      // The default is none: no credential, no refusal, no key typing.
      const quiet = capture();
      assert.equal(main(['run', '--backup-dir', join(dir, 'repo'), '--dsh-home', home, '--json'], { ...quiet.io, env }), 0,
        quiet.lines.join('\n'));
      const payload = JSON.parse(quiet.lines.join('\n'));
      assert.equal(payload.ok, true, payload.detail);
      assert.equal(payload.encryption, 'none');
      assert.equal(payload.unlocked_via, 'none');
      assert.deepEqual(payload.available_paths, ['none']);
      assert.equal(payload.key_created, true);
      // The CLI output must never leak the data key that now sits in keys.json.
      assert.equal(quiet.lines.join('\n').includes(JSON.parse(readFileSync(join(dir, 'repo', 'keys.json'), 'utf8')).envelopes[0].dek), false);

      // Asking for sealed with no credential is the old refusal, and it still walks the exit-1 path.
      const refusal = capture();
      const code = main(['run', '--backup-dir', join(dir, 'sealed'), '--dsh-home', home, '--encrypt', 'sealed', '--json'], { ...refusal.io, env });
      assert.equal(code, 1);
      const refused = JSON.parse(refusal.lines.join('\n'));
      assert.equal(refused.reason_code, 'BACKUP_NO_PERMISSION');
      assert.match(refused.detail, /sealed/u);

      // The explicit `--encrypt none` spelling is accepted, and an invalid value is a usage error (exit 2).
      const explicit = capture();
      assert.equal(main(['run', '--backup-dir', join(dir, 'explicit'), '--dsh-home', home, '--encrypt', 'none', '--json'], { ...explicit.io, env }), 0);
      assert.equal(JSON.parse(explicit.lines.join('\n')).encryption, 'none');
      const bad = capture();
      assert.equal(main(['run', '--encrypt', 'encrypted'], { ...bad.io, env }), 2);
      assert.match(bad.lines.join('\n'), /--encrypt must be one of none, sealed/u);
      const shorthand = capture();
      assert.equal(main(['run', '--backup-dir', join(dir, 'shorthand'), '--dsh-home', home, '--no-encryption', '--json'], { ...shorthand.io, env }), 0);
      assert.equal(JSON.parse(shorthand.lines.join('\n')).encryption, 'none');

      const badScope = capture();
      assert.equal(main(['run', '--scope', 'everything'], { ...badScope.io, env, password: PASSWORD }), 2);
      assert.match(badScope.lines.join('\n'), /--scope must be one of/u);

      const badKeep = capture();
      assert.equal(main(['run', '--keep-old', 'lots'], { ...badKeep.io, env, password: PASSWORD }), 2);
      assert.match(badKeep.lines.join('\n'), /--keep-old needs a non-negative integer/u);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('set-password accepts a 4-digit PIN, prints the weak-PIN warning, and seals an unencrypted repository', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-pin-');
    try {
      const repo = join(dir, 'repo');
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      const seed = capture();
      assert.equal(main(['run', '--backup-dir', repo, '--dsh-home', home, '--json'], { ...seed.io, env }), 0, seed.lines.join('\n'));

      const set = capture();
      const code = main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--set-password', '--password-stdin', '--no-machine-key'], {
        ...set.io,
        env,
        password: '1234',
      });
      assert.equal(code, 0, set.lines.join('\n'));
      assert.match(set.lines.join('\n'), /4 位数字 PIN 只是便捷门槛，不是保密强度/u, 'the honest warning is printed');
      assert.match(set.lines.join('\n'), /protection {8}: sealed/u);
      const keys = JSON.parse(readFileSync(join(repo, 'keys.json'), 'utf8'));
      assert.deepEqual(keys.envelopes.map((envelope) => envelope.kind), ['password'], 'the open envelope is gone');
      assert.equal(descriptorEncryption(readDescriptor(repo)), 'sealed', 'the descriptor records the sealed mode');

      // The PIN alone now opens the repository; no credential is a refusal.
      const check = capture();
      assert.equal(main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--check', '--json', '--no-machine-key'], { ...check.io, env, password: '1234' }), 0);
      assert.equal(JSON.parse(check.lines.join('\n')).check.via, 'password');
      const noCredential = capture();
      assert.equal(main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--check', '--json', '--no-machine-key'], { ...noCredential.io, env }), 1);
      assert.equal(JSON.parse(noCredential.lines.join('\n')).check.reason_code, 'BACKUP_NO_PERMISSION');

      // `--enable-protection` is an alias of the set-password path; without a PIN it is refused.
      const enabled = capture();
      assert.equal(main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--enable-protection', '--json', '--no-machine-key'], { ...enabled.io, env }), 1);
      assert.equal(JSON.parse(enabled.lines.join('\n')).reason_code, 'BACKUP_PASSWORD_EMPTY');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('parses --hint, prints the public hint, and includes it in --json (no PIN rotation)', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-hint-');
    try {
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      assert.equal(parseArgs(['unlock', '--hint', '周六生日'], env).hint, '周六生日');
      assert.equal(parseArgs(['unlock', '--hint=周六生日'], env).hint, '周六生日');
      assert.equal(parseArgs(['unlock'], env).hint, null, 'absent means no hint');
      assert.match(parseArgs(['unlock', '--hint'], env).error, /--hint needs a hint text/u);
      assert.match(parseArgs(['unlock', '--hint='], env).error, /--hint needs a hint text/u);
      const usage = capture();
      assert.equal(main(['--help'], usage.io), 0);
      assert.match(usage.lines.join('\n'), /--hint <text>/u, 'the usage names the public hint flag');

      const repo = join(dir, 'repo');
      const seed = capture();
      assert.equal(main(['run', '--backup-dir', repo, '--dsh-home', home, '--json'], { ...seed.io, env }), 0, seed.lines.join('\n'));

      const set = capture();
      const code = main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--set-password', '--hint', '周六生日', '--password-stdin', '--json', '--no-machine-key'], {
        ...set.io,
        env,
        password: '1234',
      });
      assert.equal(code, 0, set.lines.join('\n'));
      const setJson = JSON.parse(set.lines.join('\n'));
      assert.equal(setJson.ok, true, setJson.detail);
      assert.equal(setJson.added, true);
      assert.deepEqual(setJson.hint, { set: true, text: '周六生日' });
      assert.equal(setJson.weak, true);
      assert.equal(Object.keys(setJson).some((key) => /pin|password/iu.test(key)), false, 'the result has no PIN field at all');

      // The describe half carries the hint in --json and prints it (with its Chinese label) in the human output.
      const described = capture();
      assert.equal(main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--json'], { ...described.io, env }), 0);
      const describedJson = JSON.parse(described.lines.join('\n'));
      assert.deepEqual(describedJson.password_hint, { set: true, text: '周六生日' });
      assert.equal(describedJson.password_required, true);

      const human = capture();
      assert.equal(main(['unlock', '--backup-dir', repo, '--dsh-home', home], { ...human.io, env }), 0);
      assert.match(human.lines.join('\n'), /密码提示：周六生日/u, 'the human describe output prints the public hint');

      // The human set-password output prints the hint too, next to the honest weak-PIN warning.
      const humanRepo = join(dir, 'repo-human');
      const seedHuman = capture();
      assert.equal(main(['run', '--backup-dir', humanRepo, '--dsh-home', home, '--json'], { ...seedHuman.io, env }), 0, seedHuman.lines.join('\n'));
      const humanSet = capture();
      assert.equal(main(['unlock', '--backup-dir', humanRepo, '--dsh-home', home, '--set-password', '--hint', '周六生日', '--password-stdin', '--no-machine-key'], {
        ...humanSet.io,
        env,
        password: '1234',
      }), 0, humanSet.lines.join('\n'));
      assert.match(humanSet.lines.join('\n'), /密码提示：周六生日/u);
      assert.match(humanSet.lines.join('\n'), /4 位数字 PIN 只是便捷门槛/u);

      // A hint equal to the PIN is refused: argv can never smuggle the PIN in as the "public" hint.
      const equalRepo = join(dir, 'repo-equal');
      const seedEqual = capture();
      assert.equal(main(['run', '--backup-dir', equalRepo, '--dsh-home', home, '--json'], { ...seedEqual.io, env }), 0, seedEqual.lines.join('\n'));
      const equal = capture();
      assert.equal(main(['unlock', '--backup-dir', equalRepo, '--dsh-home', home, '--set-password', '--hint', '1234', '--password-stdin', '--json', '--no-machine-key'], {
        ...equal.io,
        env,
        password: '1234',
      }), 1);
      assert.equal(JSON.parse(equal.lines.join('\n')).reason_code, 'BACKUP_PASSWORD_HINT_INVALID');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('disable-protection needs its confirmation token, turns sealed into open, and then unlocks with no credential', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-disable-');
    try {
      const repo = join(dir, 'repo');
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      runBackup({ root: repo, dshHome: home, password: '1234', platform: 'linux', machineKey: false });
      assert.equal(readRepoKeys(repo).keys.envelopes.map((envelope) => envelope.kind).join(','), 'password');

      const unconfirmed = capture();
      assert.equal(main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--disable-protection', '--password-stdin', '--no-machine-key'], {
        ...unconfirmed.io,
        env,
        password: '1234',
      }), 2);
      assert.match(unconfirmed.lines.join('\n'), /--confirm disable-protection/u);
      assert.deepEqual(readRepoKeys(repo).keys.envelopes.map((envelope) => envelope.kind), ['password'], 'nothing was written without confirmation');

      const disabled = capture();
      const code = main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--disable-protection', '--confirm', 'disable-protection', '--password-stdin', '--no-machine-key', '--json'], {
        ...disabled.io,
        env,
        password: '1234',
      });
      assert.equal(code, 0, disabled.lines.join('\n'));
      const payload = JSON.parse(disabled.lines.join('\n'));
      assert.equal(payload.ok, true, payload.detail);
      assert.equal(payload.changed, true);
      assert.equal(payload.mode_before, 'sealed');
      assert.equal(payload.mode_after, 'none');
      assert.equal(payload.warning, '未加密：任何能访问该目录的人都能还原备份');
      assert.deepEqual(readRepoKeys(repo).keys.envelopes.map((envelope) => envelope.kind), ['open']);

      const unlocked = capture();
      assert.equal(main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--check', '--json'], { ...unlocked.io, env }), 0);
      const unlockedPayload = JSON.parse(unlocked.lines.join('\n'));
      assert.equal(unlockedPayload.check.via, 'none', 'after disabling protection no credential is needed');
      assert.equal(unlockedPayload.encryption, 'none');
      assert.equal(unlockedPayload.warning, '未加密：任何能访问该目录的人都能还原备份');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('prints a human run summary that names the snapshot and the dedupe ratio', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-human-');
    try {
      const repo = join(dir, 'repo');
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      const first = capture();
      assert.equal(main(['run', '--backup-dir', repo, '--dsh-home', home], { ...first.io, env, password: PASSWORD }), 0);
      const text = first.lines.join('\n');
      assert.match(text, /snapshot {6}: 2026/u);
      assert.match(text, /blocks {8}: 1 new, 0 reused/u);
      assert.match(text, /unlocked via {2}: password/u);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('parses --max-old-days and --mirror, and reports missing/invalid values as usage errors', () => {
    const { dir, cleanup } = tempDir('w2m-cli-flags-');
    try {
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      for (const argv of [['--max-old-days', 'lots'], ['--max-old-days', '-1'], ['--max-old-days', '1.5'], ['--max-old-days']]) {
        const run = capture();
        assert.equal(main(['gc', '--backup-dir', join(dir, 'repo'), ...argv], { ...run.io, env }), 2, argv.join(' '));
        assert.match(run.lines.join('\n'), /--max-old-days needs a non-negative integer/u);
      }
      for (const argv of [['run', '--mirror'], ['run', '--mirror=']]) {
        const run = capture();
        assert.equal(main(argv, { ...run.io, env, password: PASSWORD }), 2, argv.join(' '));
        assert.match(run.lines.join('\n'), /--mirror needs a directory/u);
      }

      const parsed = parseArgs(['run', '--mirror', join(dir, 'offsite'), '--max-old-days', '0'], env);
      assert.equal(parsed.error, undefined);
      assert.equal(parsed.mirror, join(dir, 'offsite'));
      assert.equal(parsed.maxOldDays, 0);
      assert.equal(parseArgs(['gc', '--max-old-days=30'], env).maxOldDays, 30);
      assert.equal(parseArgs(['gc', '--max-old-days='], env).error, '--max-old-days needs a non-negative integer, got ""');
    } finally {
      cleanup();
    }
  });

  it('parses --old-format, refuses an invalid value with exit 2, and sends full through to the engine', () => {
    const { home, files, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-old-format-');
    try {
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      assert.equal(parseArgs(['run', '--old-format', 'full'], env).oldFormat, 'full');
      assert.equal(parseArgs(['run', '--old-format=records'], env).oldFormat, 'records');
      assert.equal(parseArgs(['run'], env).oldFormat, null, 'absent means the engine default (records)');
      const invalid = parseArgs(['run', '--old-format=nope'], env);
      assert.match(invalid.error, /--old-format must be one of records, full/u);
      const usage = capture();
      assert.equal(main(['run', '--old-format', 'nope'], { ...usage.io, env, password: PASSWORD }), 2);
      assert.match(usage.lines.join('\n'), /--old-format must be one of records, full/u);

      const repo = join(dir, 'repo');
      const first = capture();
      assert.equal(main(['run', '--backup-dir', repo, '--dsh-home', home, '--json'], { ...first.io, env, password: PASSWORD }), 0, first.lines.join('\n'));
      const firstJson = JSON.parse(first.lines.join('\n'));
      assert.equal(firstJson.old_format, 'records');
      assert.equal('full_old_versions' in firstJson, false);

      writeFileSync(files['session-aaaaaaaa-0001'], sessionLog('session-aaaaaaaa-0001', [event(0), event(1), event(2), event(3)]));
      const second = capture();
      assert.equal(
        main(['run', '--backup-dir', repo, '--dsh-home', home, '--old-format', 'full', '--json'], { ...second.io, env, password: PASSWORD }),
        0,
        second.lines.join('\n'),
      );
      const payload = JSON.parse(second.lines.join('\n'));
      assert.equal(payload.old_format, 'full');
      assert.equal(payload.rotated, 1);
      assert.equal(payload.full_old_versions.length, 1);
      assert.equal(existsSync(join(repo, ...payload.full_old_versions[0].split('/'))), true);

      const human = capture();
      assert.equal(
        main(['run', '--backup-dir', repo, '--dsh-home', home, '--old-format', 'full'], { ...human.io, env, password: PASSWORD }),
        0,
        human.lines.join('\n'),
      );
      const text = human.lines.join('\n');
      assert.match(text, /old format {4}: full/u);
      assert.match(text, /storage doubles/u, 'the human summary must state the doubled-storage cost');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('parses --account-id for run/unlock, binds after a run, and compares without printing the id', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-account-');
    try {
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      assert.equal(parseArgs(['unlock', '--account-id', ACCOUNT], env).accountId, ACCOUNT);
      assert.equal(parseArgs(['run', '--account-id=' + ACCOUNT], env).accountId, ACCOUNT);
      assert.equal(parseArgs(['unlock'], env).accountId, null, 'absent means no comparison');
      assert.match(parseArgs(['unlock', '--account-id'], env).error, /--account-id needs an account id/u);
      assert.match(parseArgs(['unlock', '--account-id='], env).error, /--account-id needs an account id/u);
      const usage = capture();
      assert.equal(main(['--help'], usage.io), 0);
      assert.match(usage.lines.join('\n'), /--account-id <id>/u, 'the usage names the manual account-id flag');

      const repo = join(dir, 'repo');
      const run = capture();
      assert.equal(
        main(['run', '--backup-dir', repo, '--dsh-home', home, '--account-id', ACCOUNT, '--json'], { ...run.io, env, password: PASSWORD }),
        0,
        run.lines.join('\n'),
      );
      const runJson = JSON.parse(run.lines.join('\n'));
      assert.equal(runJson.account_binding?.bound, true, 'a successful run binds the id (best effort)');
      assert.equal(runJson.account_binding?.added, true);
      assert.equal(runJson.account_binding?.id_hint, '…abcd');
      assert.equal(JSON.stringify(runJson).includes(ACCOUNT), false, 'CLI JSON never prints the full account id');

      const described = capture();
      assert.equal(
        main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--account-id', ACCOUNT, '--json'], { ...described.io, env }),
        0,
      );
      const describedJson = JSON.parse(described.lines.join('\n'));
      assert.deepEqual(describedJson.account, { bound: true, matched: true, id_hint: '…abcd' });
      assert.equal(describedJson.account_supported, true);
      assert.equal(JSON.stringify(describedJson).includes(ACCOUNT), false);

      const checked = capture();
      assert.equal(
        main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--account-id', ACCOUNT, '--check', '--json'], { ...checked.io, env }),
        0,
      );
      const checkedJson = JSON.parse(checked.lines.join('\n'));
      assert.equal(checkedJson.check.ok, true);
      assert.equal(checkedJson.check.via, 'account', 'the matching id alone opens the repository: no password needed');

      const mismatched = capture();
      assert.equal(
        main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--account-id', OTHER_ACCOUNT, '--json'], { ...mismatched.io, env }),
        0,
        'describing a mismatch is a read-only report, not a failure of the command',
      );
      assert.equal(JSON.parse(mismatched.lines.join('\n')).account.matched, false);

      const human = capture();
      assert.equal(main(['unlock', '--backup-dir', repo, '--dsh-home', home, '--account-id', ACCOUNT], { ...human.io, env }), 0);
      const text = human.lines.join('\n');
      assert.match(text, /account path {2}: matched/u);
      assert.match(text, /…abcd/u, 'the human output shows the masked hint');
      assert.equal(text.includes(ACCOUNT), false, 'the human output never prints the full account id');
    } finally {
      cleanup();
      cleanHome();
    }
  });
});

describe('engine: retention and mirror options', () => {
  it('runBackup applies maxOldVersionDays during rotation and keeps the count rule intact', () => {
    const { home, files, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-retention-');
    try {
      const repo = join(dir, 'repo');
      const base = { root: repo, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false };
      const first = runBackup({ ...base, now: new Date('2026-11-17T12:00:00.000Z') });
      assert.equal(first.ok, true, first.detail);

      // An old version record left by a previous month's rotation, outside the configured window.
      const snapshot = readSnapshot({ root: repo, snapshotId: first.snapshot_id });
      const entry = snapshot.manifest.files.find((row) => row.kind === 'session');
      assert.ok(entry, 'the snapshot must hold the session file');
      recordSupersededVersion({ root: repo, previous: entry, snapshotId: '20260101T000000Z-deadbeef', now: new Date('2026-01-01T00:00:00.000Z') });
      assert.equal(listOldVersions(repo).length, 1);

      // Change the session so the next run supersedes the previous version and prunes by the age rule.
      writeFileSync(files['session-aaaaaaaa-0001'], sessionLog('session-aaaaaaaa-0001', [event(0), event(1), event(2)]));
      const second = runBackup({ ...base, now: new Date('2026-11-17T13:00:00.000Z'), maxOldVersionDays: 30 });
      assert.equal(second.ok, true, second.detail);
      assert.equal(second.rotated, 1);
      assert.equal(second.max_old_version_days, 30);
      const remaining = listOldVersions(repo);
      assert.equal(remaining.length, 1, 'the record older than 30 days must be pruned');
      assert.ok(Date.parse(remaining[0].record.recorded_at) > Date.parse('2026-01-01T00:00:00.000Z'));

      // Absent maxOldVersionDays means the count rule only: the next rotation prunes nothing.
      writeFileSync(files['session-aaaaaaaa-0001'], sessionLog('session-aaaaaaaa-0001', [event(0), event(1), event(2), event(3)]));
      const third = runBackup({ ...base, now: new Date('2026-11-17T14:00:00.000Z') });
      assert.equal(third.ok, true, third.detail);
      assert.equal(third.max_old_version_days, 0, 'absent means the age rule is disabled, not "prune everything"');
      assert.equal(listOldVersions(repo).length, 2);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses an invalid maxOldVersionDays before creating the repository', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-retention-invalid-');
    try {
      const repo = join(dir, 'repo');
      const result = runBackup({ root: repo, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, maxOldVersionDays: -1 });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_ROTATION_POLICY_INVALID');
      assert.match(result.detail, /maxAgeDays/u);
      assert.equal(existsSync(repo), false, 'the refusal happens before ensureLayout');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('never mirrors or validates a mirror on a dry run', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-dry-mirror-');
    try {
      const repo = join(dir, 'repo');
      const result = runBackup({
        root: repo,
        dshHome: home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        dryRun: true,
        mirrorRoot: join(repo, 'inside-mirror'),
      });
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.dry_run, true);
      assert.equal('mirror' in result, false, 'a dry run writes no mirror and reports none');
      assert.equal(existsSync(join(repo, 'inside-mirror')), false);
    } finally {
      cleanup();
      cleanHome();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// G5: the cached runtime verdict (state cache, `?runtime=cached`, nightly option)
// ---------------------------------------------------------------------------------------------

/** A real-shaped runtime verify result; the injected runner returns it, so no Harness is spawned. */
function fakeRuntimeVerifyResult(overrides = {}) {
  return {
    ok: true,
    counts: { snapshots: 1, files: 1, blocks: 1, bytes: 1, old: 0, current: 0 },
    runtime_verified: { checked: 1, failed: 0, evidence: 'installed-harness' },
    future_append: { checked: 1, failed: 0, evidence: 'static-prefilter' },
    problems: [],
    duration_ms: 7,
    ...overrides,
  };
}

/** A scheduler whose `run` a test can invoke directly, without waiting for 22:00. */
function schedulerHarness() {
  const captured = { options: null };
  const createScheduler = (options) => {
    captured.options = options;
    return {
      start() {},
      stop() {},
      describe() {
        return { time_zone: options.timeZone, times: options.times, stopped: false, next_at: null };
      },
      async triggerNow() {
        await options.run({ scheduledAtMs: null, ranAtMs: Date.now(), slot: 'manual', late: false });
      },
    };
  };
  return { captured, createScheduler };
}

/** Let the fire-and-forget nightly verdict settle (it is deliberately not awaited by the schedule). */
async function flushScheduled() {
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
}

describe('subplugin: cached runtime verdict and the nightly option (G5)', () => {
  it('serves ?runtime=cached from the persisted record without spawning, marks it stale by age, and refreshes it on ?runtime=1', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cached-verify-');
    try {
      const oldFinished = Date.now() - 26 * 60 * 60 * 1000;
      const seeded = buildRuntimeVerdictRecord({
        verifyResult: fakeRuntimeVerifyResult(),
        startedAt: oldFinished - 1_000,
        finishedAt: oldFinished,
        trigger: 'nightly',
      });
      assert.equal(writeBackupState(home, { last_runtime_verify: seeded }).ok, true);

      let verifyCalls = 0;
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE }, {
        runtimeVerify: () => {
          verifyCalls += 1;
          return fakeRuntimeVerifyResult();
        },
      });
      const find = (path) => fake.registrations.find((row) => row.path === path);
      const verifyRoute = find(BACKUP_VERIFY_ROUTE_PATH);

      const cached = await (await verifyRoute.fetch(new Request(`http://local.invalid${BACKUP_VERIFY_ROUTE_PATH}?runtime=cached`, { method: 'GET' }))).json();
      assert.equal(cached.ok, true);
      assert.equal(cached.mode, 'cached');
      assert.equal(cached.cached, true);
      assert.equal(cached.stale, true, 'a 26 h old record is stale');
      assert.equal(cached.record.evidence, 'installed-harness');
      assert.equal(cached.record.checked, 1);
      assert.equal(verifyCalls, 0, 'the cached route never spawns the verifier');

      const ran = await (await verifyRoute.fetch(new Request(`http://local.invalid${BACKUP_VERIFY_ROUTE_PATH}?runtime=1`, { method: 'GET' }))).json();
      assert.equal(verifyCalls, 1);
      assert.equal(ran.runtime_verify.evidence, 'installed-harness');
      assert.equal(ran.runtime_verify_persisted, true);
      const refreshed = await (await verifyRoute.fetch(new Request(`http://local.invalid${BACKUP_VERIFY_ROUTE_PATH}?runtime=cached`, { method: 'GET' }))).json();
      assert.equal(refreshed.stale, false, '?runtime=1 updated the cache before answering');

      const status = await (await find(BACKUP_RUN_ROUTE_PATH).fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, { method: 'GET' }))).json();
      assert.equal(status.state.last_runtime_verify.evidence, 'installed-harness', 'the embedded status exposes the cached record');
      assert.equal(status.state.last_runtime_verify.checked, 1);
      assert.equal(status.runtime_verify.mode, 'off');
      assert.equal(verifyCalls, 1, 'reading the status does not spawn the verifier again');
      assert.equal(readBackupState(home).state.last_runtime_verify.evidence, 'installed-harness');
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('runs the runtime verify once per successful scheduled backup when nightly, never on the default off, and a failed verdict is a warning that still persists', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-nightly-verify-');
    try {
      // off (the default): a scheduled backup does not run a verdict at all.
      const offFake = fakeCtx();
      const offHarness = schedulerHarness();
      let offCalls = 0;
      apply(offFake.ctx, { backupDir: join(dir, 'repo-off'), dshHome: home, backupMachineKey: false, ...NO_FIRE }, {
        createScheduler: offHarness.createScheduler,
        runtimeVerify: () => {
          offCalls += 1;
          return fakeRuntimeVerifyResult();
        },
      });
      const offRun = await offHarness.captured.options.run();
      assert.equal(offRun.ok, true, offRun.detail);
      await flushScheduled();
      assert.equal(offCalls, 0, 'off is the default: no runtime verdict after a scheduled backup');

      // nightly: after the backup is produced, exactly one verdict per successful slot.
      const fake = fakeCtx();
      const harness = schedulerHarness();
      let verifyCalls = 0;
      let nextResult = fakeRuntimeVerifyResult();
      apply(fake.ctx, {
        backupDir: join(dir, 'repo-nightly'),
        dshHome: home,
        backupMachineKey: false,
        backupRuntimeVerify: 'nightly',
        ...NO_FIRE,
      }, {
        createScheduler: harness.createScheduler,
        runtimeVerify: () => {
          verifyCalls += 1;
          return nextResult;
        },
      });
      const first = await harness.captured.options.run();
      assert.equal(first.ok, true, first.detail);
      await flushScheduled();
      assert.equal(verifyCalls, 1);
      const persisted = readBackupState(home).state.last_runtime_verify;
      assert.equal(persisted.evidence, 'installed-harness');
      assert.equal(persisted.trigger, 'nightly');
      assert.equal(persisted.ok, true);

      nextResult = fakeRuntimeVerifyResult({ ok: false, runtime_verified: { checked: 1, failed: 1 }, problems: [{ code: 'BACKUP_RUNTIME_REJECTED' }], reason_code: 'BACKUP_RUNTIME_REJECTED' });
      const second = await harness.captured.options.run();
      assert.equal(second.ok, true, 'a failed verdict never fails the backup');
      await flushScheduled();
      assert.equal(verifyCalls, 2, 'one verdict per successful scheduled backup');
      assert.equal(readBackupState(home).state.last_runtime_verify.ok, false, 'the failed verdict is still persisted');
      assert.ok(
        fake.logs.some((entry) => entry.level === 'warn' && entry.message.includes('nightly runtime verdict failed')),
        'a failed verdict is a logged warning, not a failed schedule',
      );
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('refuses an unknown backupRuntimeVerify value at mount instead of silently meaning off', () => {
    const refused = normalizeConfig({ backupRuntimeVerify: 'hourly' }, { env: {}, platform: 'win32' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason_code, 'BACKUP_CONFIG_INVALID');
    assert.equal(normalizeConfig({}, { env: {}, platform: 'win32' }).runtime_verify, 'off');
    assert.equal(normalizeConfig({ backupRuntimeVerify: 'nightly' }, { env: {}, platform: 'win32' }).runtime_verify, 'nightly');
  });
});

// ---------------------------------------------------------------------------------------------
// G2: the in-host register repair route
// ---------------------------------------------------------------------------------------------

const REGISTER_SESSION = 'session-aaaaaaaa-0001';

describe('subplugin: the in-host register repair route (G2)', () => {
  /** A home with one on-disk session that the registry does not list yet. */
  function unregisteredHome() {
    return makeHome({
      sessions: [{ workspace: '--E-GPT--', id: REGISTER_SESSION }],
      registry: registryDocument({ sessionIds: [] }),
    });
  }

  const postRegister = (route, body) => route.fetch(new Request(`http://local.invalid${BACKUP_REGISTER_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

  it('falls back to the file path + bounded watch when the profile has no workspaceRegistry, and states the residual risk', async () => {
    const { home, cleanup: cleanHome } = unregisteredHome();
    const { dir, cleanup } = tempDir('w2m-route-register-file-');
    try {
      const watchCalls = [];
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE }, {
        // The 30 s watch is injected: this test is about the route contract, not about sleeping 30 s.
        registerWatch: async (args) => {
          watchCalls.push(args);
          return { minutes: 0.5, samples: 3, clobbered: 0, reapplied: 0, stable_at: '2026-11-17T08:00:03.000Z' };
        },
      });
      const route = fake.registrations.find((row) => row.path === BACKUP_REGISTER_ROUTE_PATH);
      assert.ok(route, 'the register repair route is mounted');
      assert.deepEqual(route.methods, ['POST']);

      const noConfirm = await postRegister(route, { session_ids: [REGISTER_SESSION] });
      assert.equal(noConfirm.status, 400);
      assert.equal((await noConfirm.json()).reason_code, 'BACKUP_CONFIRM_REQUIRED');

      const empty = await postRegister(route, { confirm: REGISTER_CONFIRM_TOKEN, session_ids: [] });
      assert.equal(empty.status, 400);
      assert.equal((await empty.json()).reason_code, 'BACKUP_REGISTER_NO_SESSION');

      const response = await postRegister(route, { confirm: REGISTER_CONFIRM_TOKEN, session_ids: [REGISTER_SESSION] });
      const body = await response.json();
      assert.equal(body.ok, true, body.detail);
      assert.equal(body.via, 'file-write');
      assert.equal(body.host_service, false);
      assert.deepEqual(body.registered, [REGISTER_SESSION]);
      assert.equal(body.watch.clobbered, 0);
      assert.equal(body.watch.samples, 3);
      assert.equal(body.residual_risk, REGISTER_RESIDUAL_RISK_LINE);
      assert.equal(watchCalls.length, 1);
      assert.equal(watchCalls[0].budgetMs, 30_000, 'the route watch is capped at 30 s');
      assert.equal(watchCalls[0].minutes, 0.5);
      const registry = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'));
      assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [REGISTER_SESSION]);
    } finally {
      cleanup();
      cleanHome();
    }
  });

  it('prefers ctx.workspaceRegistry: attaches there, writes no workspace.json, and has no file-level residual risk', async () => {
    const { home, cleanup: cleanHome } = unregisteredHome();
    const { dir, cleanup } = tempDir('w2m-route-register-host-');
    try {
      const attached = [];
      const resolved = [];
      const service = {
        async resolveByPath(workspacePath) {
          resolved.push(workspacePath);
          return {
            path: workspacePath,
            async attachSession(sessionId) {
              attached.push(sessionId);
            },
          };
        },
        async create() {
          throw new Error('an existing workspace must resolve, not be created');
        },
      };
      const before = readFileSync(join(home, 'storages', 'workspace.json'));
      const fake = fakeCtx({ services: { workspaceRegistry: service } });
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE }, {
        registerWatch: () => {
          throw new Error('the host-service path must not run the file-level watch');
        },
      });
      const route = fake.registrations.find((row) => row.path === BACKUP_REGISTER_ROUTE_PATH);
      const body = await (await postRegister(route, { confirm: REGISTER_CONFIRM_TOKEN, session_ids: [REGISTER_SESSION] })).json();
      assert.equal(body.ok, true, body.detail);
      assert.equal(body.via, 'host-service');
      assert.equal(body.host_service, true);
      assert.deepEqual(body.registered, [REGISTER_SESSION]);
      assert.deepEqual(attached, [REGISTER_SESSION]);
      assert.equal(resolved.length, 1);
      assert.equal(body.residual_risk, null, 'the service path has no file write for the client to overwrite');
      assert.ok(readFileSync(join(home, 'storages', 'workspace.json')).equals(before), 'no file-level write happened');
    } finally {
      cleanup();
      cleanHome();
    }
  });
});
