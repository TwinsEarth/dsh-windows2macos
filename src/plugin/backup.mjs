/**
 * Host half of the backup subplugin: `@twinsearth/w2m-dsh-plugin/dsh-backup`.
 *
 * ## Why this is a subplugin and not part of the always-on plugin
 *
 * v3.4.6 mounted the two read-only backup routes (`status`, `scan`) from the plugin root, because nothing behind
 * them writes. This version adds the first path that **does** write a repository -- and a timer that may write it
 * unattended. Both must be an explicit operator decision, so they live behind a `cordis.patch.yml` row that is
 * absent by default: enabling the row is the decision, and `ctx.effect` guarantees the timer dies with it.
 *
 * ## What it composes, and what it owns
 *
 * It owns two things: the timer (through `createDailyScheduler`) and the `POST /api/w2m/backup/run` route. The
 * work itself is delegated to `src/backup/engine.mjs`, which has no Cordis dependency and is tested without one.
 * This file is a composition root: paths, configuration, logging, lifecycle. Nothing about hashing, encryption or
 * rotation is implemented here.
 *
 * ## Unattended runs have no password
 *
 * A scheduled run cannot prompt. It opens the repository with the **machine** envelope (the DPAPI-protected key),
 * which is why that envelope exists. On a platform without an OS keystore the scheduled run refuses with
 * `BACKUP_NO_PERMISSION` and logs it; the operator's path is the offline CLI's password unlock
 * (`w2m-backup run --password-stdin`), which is an explicit human action rather than a stored secret. Storing the
 * password in configuration to make the timer work would trade the whole point of the encryption for convenience,
 * so it is not offered.
 *
 * ## The route requires a confirmation token
 *
 * A `POST` from the panel model is not a button click -- it is a network request a stale page can replay. The body
 * must carry `{"confirm":"run"}` (plus the scope), so "run a backup now" is never the meaning of an accidental
 * empty POST.
 */

import { applyRestore, planRestore } from '../backup/restore.mjs';
import { buildArchive } from '../backup/archive.mjs';
import { describeUnlock, unlockRepo } from '../backup/unlock.mjs';
import { verifyRepo } from '../backup/verify.mjs';
import os from 'node:os';
import path from 'node:path';

import { createDailyScheduler, DEFAULT_CATCH_UP_MS } from './schedule.mjs';
import { runBackup, SCOPES } from '../backup/engine.mjs';
import { describeBackupSchedule, normalizeBackupSchedule } from '../backup/schedule.mjs';
import { DEFAULT_KEEP_OLD } from '../backup/rotation.mjs';

export const name = 'w2m-dsh-backup';

/** No services are required to mount; the route asks for `connection` opportunistically. */
export const inject = [];

/** Path of the write route (GET reads the state, POST runs a backup). */
export const BACKUP_RUN_ROUTE_PATH = '/api/w2m/backup/run';

/** Restore plan/apply route (v3.4.8). A POST needs `{"confirm":"restore"}`. */
export const BACKUP_RESTORE_ROUTE_PATH = '/api/w2m/backup/restore';

/** Archive-pack route (v3.4.8). A POST needs `{"confirm":"archive"}`. */
export const BACKUP_ARCHIVE_ROUTE_PATH = '/api/w2m/backup/archive';

/** Full verification route (v3.4.8, read-only). */
export const BACKUP_VERIFY_ROUTE_PATH = '/api/w2m/backup/verify';

/** Unlock probe route (v3.4.8): GET describes, POST with `{"confirm":"unlock"}` attempts. */
export const BACKUP_UNLOCK_ROUTE_PATH = '/api/w2m/backup/unlock';

/** Confirmation token for the restore route. */
export const RESTORE_CONFIRM_TOKEN = 'restore';

/** Confirmation token for the archive route. */
export const ARCHIVE_CONFIRM_TOKEN = 'archive';

/** Confirmation token for the unlock attempt. */
export const UNLOCK_CONFIRM_TOKEN = 'unlock';

/** Confirmation token a POST must carry. */
export const RUN_CONFIRM_TOKEN = 'run';

const NO_STORE = { 'cache-control': 'no-store' };

/** `$DSH_HOME`, then `~/.dsh`. */
export function resolveDshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return explicit !== '' ? path.resolve(explicit) : path.join(os.homedir(), '.dsh');
}

/** Windows default; a home-relative directory elsewhere (a hard-coded `D:\` never exists on macOS). */
export function defaultBackupDir(platform = process.platform) {
  return platform === 'win32' ? 'D:\\DeepSeekHarness\\BackUP' : path.join(os.homedir(), 'DSH-BackUP');
}

/**
 * Normalize the row's configuration into everything `apply` needs.
 *
 * @param {object} [config]
 * @param {{env?: Record<string, string|undefined>, platform?: string}} [deps]
 * @returns {{ok: true, enabled: boolean, backup_dir: string, times: string[], time_zone: string, catch_up_ms: number,
 *   scope: string, keep_old_per_session: number, dsh_home: string}
 *   | {ok: false, reason_code: string, detail: string}}
 */
export function normalizeConfig(config = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const schedule = normalizeBackupSchedule({
    enabled: config.backupEnabled ?? config.enabled ?? true,
    times: config.backupTimes ?? config.times,
    timeZone: config.backupTimeZone ?? config.timeZone,
    catchUpMs: config.backupCatchUpMs,
  });
  if (schedule.ok !== true) return schedule;

  const dirValue =
    (typeof config.backupDir === 'string' && config.backupDir.trim() !== '' ? config.backupDir.trim() : null) ??
    (typeof env.W2M_BACKUP_DIR === 'string' && env.W2M_BACKUP_DIR.trim() !== '' ? env.W2M_BACKUP_DIR.trim() : null) ??
    defaultBackupDir(platform);

  const scope = typeof config.backupScope === 'string' && SCOPES.includes(config.backupScope) ? config.backupScope : 'all';
  const machineKey = config.backupMachineKey !== false && env.W2M_BACKUP_NO_MACHINE_KEY !== '1';
  const keepOld = Number.isSafeInteger(config.keepOldPerSession) && config.keepOldPerSession >= 0
    ? config.keepOldPerSession
    : DEFAULT_KEEP_OLD;
  const dshHome = typeof config.dshHome === 'string' && config.dshHome.trim() !== ''
    ? path.resolve(config.dshHome.trim())
    : resolveDshHome(env);

  return {
    ok: true,
    enabled: schedule.enabled,
    backup_dir: path.resolve(dirValue),
    times: schedule.times,
    time_zone: schedule.time_zone,
    catch_up_ms: schedule.catch_up_ms,
    scope,
    machine_key: machineKey,
    keep_old_per_session: keepOld,
    dsh_home: dshHome,
  };
}

/**
 * Mount the backup subplugin.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] row configuration (`backupDir`, `backupTimes`, `backupTimeZone`, `backupScope`,
 *   `keepOldPerSession`, `backupEnabled`)
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  if (cfg.ok !== true) {
    ctx.logger?.warn?.(`w2m-dsh-backup: not mounted: ${cfg.reason_code}: ${cfg.detail}`);
    return;
  }
  if (cfg.enabled !== true) {
    ctx.logger?.info?.('w2m-dsh-backup: mounted but disabled by configuration');
    return;
  }

  const state = {
    mounted_at: new Date().toISOString(),
    backup_dir: cfg.backup_dir,
    dsh_home: cfg.dsh_home,
    times: cfg.times,
    time_zone: cfg.time_zone,
    scope: cfg.scope,
    runs: 0,
    failures: 0,
    last_run: null,
    last_result: null,
    last_error: null,
    running: false,
  };

  /** Run one backup and never throw: the timer and the route both need a result, not an exception. */
  const runNow = (reason, request) => {
    if (state.running) {
      return { ok: false, reason_code: 'BACKUP_BUSY', detail: 'a backup is already running', reason };
    }
    state.running = true;
    try {
      const result = runBackup({
        root: cfg.backup_dir,
        dshHome: cfg.dsh_home,
        scope: request?.scope ?? cfg.scope,
        selected: request?.selected ?? [],
        keepOldPerSession: cfg.keep_old_per_session,
        machineKey: cfg.machine_key,
        dryRun: request?.dryRun === true,
      });
      if (result.ok === true) {
        state.runs += 1;
        state.last_run = new Date().toISOString();
        state.last_result = {
          snapshot_id: result.snapshot_id,
          sessions: result.sessions,
          files: result.files,
          blocks_new: result.blocks_new,
          blocks_reused: result.blocks_reused,
          dedupe_ratio: result.dedupe_ratio,
          duration_ms: result.duration_ms,
          rotated: result.rotated,
        };
        ctx.logger?.info?.(
          `w2m-dsh-backup: ${reason} backup ${result.snapshot_id}: ${result.sessions} session(s), ` +
            `${result.blocks_new} new block(s), ${result.blocks_reused} reused`,
        );
      } else {
        state.failures += 1;
        state.last_error = { at: new Date().toISOString(), reason_code: result.reason_code, detail: result.detail };
        ctx.logger?.warn?.(`w2m-dsh-backup: ${reason} backup refused: ${result.reason_code}: ${result.detail}`);
      }
      return result;
    } catch (error) {
      state.failures += 1;
      state.last_error = { at: new Date().toISOString(), reason_code: error?.code ?? 'BACKUP_FAILED', detail: error?.message ?? String(error) };
      ctx.logger?.warn?.(`w2m-dsh-backup: ${reason} backup threw: ${error?.message ?? error}`);
      return { ok: false, reason_code: error?.code ?? 'BACKUP_FAILED', detail: error?.message ?? String(error) };
    } finally {
      state.running = false;
    }
  };

  const scheduler = createDailyScheduler({
    run: () => runNow('scheduled'),
    times: cfg.times,
    timeZone: cfg.time_zone,
    catchUpMs: cfg.catch_up_ms || DEFAULT_CATCH_UP_MS,
    onError: (error) => ctx.logger?.warn?.(`w2m-dsh-backup: scheduler error: ${error.message}`),
  });
  scheduler.start();
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => scheduler.stop(), 'w2m: backup schedule');
  }

  // The write route: present only while this row is mounted, and refused unless enabled.
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['connection'], (webCtx) => {
      const registry = webCtx?.connection?.fetch;
      if (registry === undefined || typeof registry.register !== 'function') return;
      registry.register({
        path: BACKUP_RUN_ROUTE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const describe = () => ({
            ok: true,
            enabled: true,
            backup_dir: cfg.backup_dir,
            dsh_home: cfg.dsh_home,
            schedule: describeBackupSchedule({ enabled: true, times: cfg.times, timeZone: cfg.time_zone }),
            scheduler: scheduler.describe(),
            state,
          });
          if (request.method === 'GET') return Response.json(describe(), { headers: NO_STORE });
          if (request.method !== 'POST') {
            return Response.json({ ok: false, reason_code: 'METHOD_NOT_ALLOWED', detail: `${request.method} is not a method this route answers` }, { status: 405, headers: NO_STORE });
          }
          let body = null;
          try {
            body = await request.json();
          } catch {
            /* refused below */
          }
          if (body === null || typeof body !== 'object' || body.confirm !== RUN_CONFIRM_TOKEN) {
            return Response.json(
              { ok: false, reason_code: 'BACKUP_CONFIRM_REQUIRED', detail: `a JSON body with {"confirm":"${RUN_CONFIRM_TOKEN}"} is required` },
              { status: 400, headers: NO_STORE },
            );
          }
          if (body.scope !== undefined && !SCOPES.includes(body.scope)) {
            return Response.json(
              { ok: false, reason_code: 'BACKUP_SCOPE_INVALID', detail: `scope must be one of ${SCOPES.join(', ')}` },
              { status: 400, headers: NO_STORE },
            );
          }
          const result = runNow('manual', {
            scope: body.scope,
            selected: Array.isArray(body.selected) ? body.selected : [],
            dryRun: body.dryRun === true,
          });
          // 200 even for a refusal: the panel renders the reason code, and a 4xx/5xx would show as a broken
          // request rather than as the named reason the engine produced.
          return Response.json(result, { headers: NO_STORE });
        },
      });
    });
  }

  // v3.4.8: restore / archive / verify / unlock. Every writing route needs its own confirmation token; the
  // read-only describe routes need none. The panel never supplies a password: it unlocks through the machine
  // envelope, and a password-only repository is refused with the reason that names the CLI command to run.
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['connection'], (webCtx) => {
      const registry = webCtx?.connection?.fetch;
      if (registry === undefined || typeof registry.register !== 'function') return;
      const readBody = async (request) => {
        try {
          return await request.json();
        } catch {
          return null;
        }
      };
      const refuse = (reason_code, detail, status = 400) => Response.json({ ok: false, reason_code, detail }, { status, headers: NO_STORE });
      const unlockInput = () => ({ root: cfg.backup_dir, dshHome: cfg.dsh_home, machineKey: cfg.machine_key });

      registry.register({
        path: BACKUP_UNLOCK_ROUTE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method === 'GET') {
            return Response.json(describeUnlock(unlockInput()), { headers: NO_STORE });
          }
          if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          const body = await readBody(request);
          if (body === null || body.confirm !== UNLOCK_CONFIRM_TOKEN) {
            return refuse('BACKUP_CONFIRM_REQUIRED', `a JSON body with {"confirm":"${UNLOCK_CONFIRM_TOKEN}"} is required`);
          }
          const result = unlockRepo(unlockInput());
          return Response.json({ ok: result.ok, via: result.via, reason_code: result.reason_code, detail: result.detail, attempts: result.attempts }, { headers: NO_STORE });
        },
      });

      registry.register({
        path: BACKUP_VERIFY_ROUTE_PATH,
        methods: ['GET'],
        fetch: async (request) => {
          if (request.method !== 'GET') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          // Read-only but expensive: it decrypts every block of every snapshot to re-hash it.
          const result = verifyRepo({ ...unlockInput(), futureAppend: true });
          state.last_verify = { at: new Date().toISOString(), ok: result.ok, counts: result.counts, problems: result.problems.length };
          return Response.json(result, { headers: NO_STORE });
        },
      });

      registry.register({
        path: BACKUP_ARCHIVE_ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          const body = await readBody(request);
          if (body === null || body.confirm !== ARCHIVE_CONFIRM_TOKEN) {
            return refuse('BACKUP_CONFIRM_REQUIRED', `a JSON body with {"confirm":"${ARCHIVE_CONFIRM_TOKEN}"} is required`);
          }
          const scope = body.scope ?? 'archived';
          if (!['archived', 'all', 'selected'].includes(scope)) {
            return refuse('BACKUP_SCOPE_INVALID', 'scope must be archived, all or selected');
          }
          const result = buildArchive({
            ...unlockInput(),
            snapshotId: typeof body.snapshot === 'string' ? body.snapshot : null,
            scope,
            sessionIds: Array.isArray(body.sessions) ? body.sessions : [],
          });
          state.last_archive = { at: new Date().toISOString(), ok: result.ok, file: result.file ?? null, sessions: result.sessions ?? 0 };
          return Response.json(result, { headers: NO_STORE });
        },
      });

      registry.register({
        path: BACKUP_RESTORE_ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          const body = await readBody(request);
          if (body === null || body.confirm !== RESTORE_CONFIRM_TOKEN) {
            return refuse('BACKUP_CONFIRM_REQUIRED', `a JSON body with {"confirm":"${RESTORE_CONFIRM_TOKEN}"} is required`);
          }
          const plan = planRestore({
            ...unlockInput(),
            snapshotId: typeof body.snapshot === 'string' ? body.snapshot : null,
            sessionIds: Array.isArray(body.sessions) ? body.sessions : [],
            keepBoth: body.keepBoth === true,
            allowStaticValidation: body.allowStaticValidation === true,
            workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : null,
          });
          if (plan.ok !== true || body.apply !== true) {
            // No confirmation of the *write* yet: return the plan so the panel can show exactly what would happen.
            return Response.json(plan, { headers: NO_STORE });
          }
          const applied = applyRestore({ plan, dshHome: cfg.dsh_home });
          state.last_restore = {
            at: new Date().toISOString(),
            ok: applied.ok,
            sessions: applied.restored?.length ?? 0,
            pre_restore_dir: applied.pre_restore_dir ?? null,
          };
          return Response.json(applied, { headers: NO_STORE });
        },
      });
    });
  }

  ctx.logger?.info?.(
    `w2m-dsh-backup: mounted; ${cfg.times.join(', ')} ${cfg.time_zone} -> ${cfg.backup_dir} (scope ${cfg.scope})`,
  );
}
