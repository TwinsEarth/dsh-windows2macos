/**
 * The mounted half of v3.4.7: the subplugin's route, its lifecycle, and the CLI commands that write.
 *
 * The route exists only while the row is mounted (a disabled row must not answer `POST /api/w2m/backup/run`), and
 * a `POST` without the confirmation token must never run a backup. Both are asserted here because they are the
 * two ways a "run backup" endpoint turns into an accident.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  BACKUP_RUN_ROUTE_PATH,
  RUN_CONFIRM_TOKEN,
  apply,
  defaultBackupDir,
  normalizeConfig,
} from '../src/plugin/backup.mjs';
import { main } from '../src/backup/cli.mjs';
import { readIndex } from '../src/backup/repo.mjs';
import { tempDir, makeHome, registryDocument } from './helpers/backup-fixture.mjs';

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
});

describe('subplugin: the route and the timer', () => {
  it('registers one run route and starts a scheduler that the effect can stop', async () => {
    const { home, cleanup: cleanHome } = homeFixture();
    const { dir, cleanup } = tempDir('w2m-run-route-');
    try {
      const fake = fakeCtx();
      apply(fake.ctx, { backupDir: join(dir, 'repo'), dshHome: home, backupMachineKey: false, ...NO_FIRE });
      assert.equal(fake.registrations.length, 1);
      assert.equal(fake.registrations[0].path, BACKUP_RUN_ROUTE_PATH);
      assert.deepEqual(fake.registrations[0].methods, ['GET', 'POST']);
      assert.equal(fake.disposers.length, 1, 'the timer must be owned by ctx.effect');

      const get = await fake.registrations[0].fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, { method: 'GET' }));
      const state = await get.json();
      assert.equal(state.ok, true);
      assert.equal(state.enabled, true);
      assert.deepEqual(state.schedule.times, ['23:59:59']);
      assert.equal(state.schedule.time_zone, 'UTC');
      assert.equal(state.scheduler.time_zone, 'UTC');

      fake.disposers[0]();
      const stopped = await (await fake.registrations[0].fetch(new Request(`http://local.invalid${BACKUP_RUN_ROUTE_PATH}`, { method: 'GET' }))).json();
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
      const fetch = fake.registrations[0].fetch;

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
      const response = await fake.registrations[0].fetch(
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
});
