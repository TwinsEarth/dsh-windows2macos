/**
 * The mounted half of v3.4.7: the subplugin's route, its lifecycle, and the CLI commands that write.
 *
 * The route exists only while the row is mounted (a disabled row must not answer `POST /api/w2m/backup/run`), and
 * a `POST` without the confirmation token must never run a backup. Both are asserted here because they are the
 * two ways a "run backup" endpoint turns into an accident.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARCHIVE_CONFIRM_TOKEN,
  BACKUP_ARCHIVE_ROUTE_PATH,
  BACKUP_RESTORE_ROUTE_PATH,
  BACKUP_RUN_ROUTE_PATH,
  BACKUP_UNLOCK_ROUTE_PATH,
  BACKUP_VERIFY_ROUTE_PATH,
  RESTORE_CONFIRM_TOKEN,
  RUN_CONFIRM_TOKEN,
  UNLOCK_CONFIRM_TOKEN,
  apply,
  defaultBackupDir,
  normalizeConfig,
} from '../src/plugin/backup.mjs';
import { main, parseArgs } from '../src/backup/cli.mjs';
import { runBackup } from '../src/backup/engine.mjs';
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
function fakeCtx() {
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
  };
  return { ctx, registrations, disposers, logs };
}

/** A far-future slot so the timer never fires during the test. */
const NO_FIRE = { backupTimes: ['23:59:59'], backupTimeZone: 'UTC' };

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
});

describe('subplugin: the route and the timer', () => {
  it('registers one run route and starts a scheduler that the effect can stop', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-route-');
    try {
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE });
      assert.equal(fake.registrations.length, 5, 'v3.4.8 adds restore/archive/verify/unlock beside the run route');
      assert.deepEqual(
        fake.registrations.map((row) => row.path).sort(),
        [BACKUP_RUN_ROUTE_PATH, BACKUP_RESTORE_ROUTE_PATH, BACKUP_ARCHIVE_ROUTE_PATH, BACKUP_VERIFY_ROUTE_PATH, BACKUP_UNLOCK_ROUTE_PATH].sort(),
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

  it('answers a confirmed run with the engine refusal when this platform has no usable credential', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-noperm-');
    try {
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE });
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
      assert.equal(body.reason_code, 'BACKUP_NO_PERMISSION', 'a scheduled/UI run has no password and must refuse rather than write an unopenable repository');
      assert.match(body.detail, /no credential/u);
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
        apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, ...NO_FIRE });
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

  it(
    'answers a confirmed restore plan and archive on Windows (machine envelope, real DPAPI)',
    { skip: process.platform === 'win32' ? false : 'DPAPI is Windows-only' },
    async () => {
      const source = runtimeValidHome();
      const { dir, cleanup } = tempDir('w2m-route-v348-win-');
      try {
        const fake = fakeCtx();
        apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: source.home, ...NO_FIRE });
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

  it('refuses without a credential, and reports usage errors as exit 2', () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-cli-refuse-');
    try {
      const env = { W2M_BACKUP_NO_MACHINE_KEY: '1' };
      const refusal = capture();
      const code = main(['run', '--backup-dir', join(dir, 'repo'), '--dsh-home', home, '--json'], { ...refusal.io, env });
      assert.equal(code, 1);
      const payload = JSON.parse(refusal.lines.join('\n'));
      assert.equal(payload.reason_code, 'BACKUP_NO_PERMISSION');

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
