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
 * ## Protection is convenience-first, and `none` is the default
 *
 * The user's decision (2026-11-17, `docs/BACKUP-DESIGN.md` §25) is explicit: this product does **not** pursue
 * absolute confidentiality. Three states exist -- no protection (the default), account-id compare (a
 * convenience), and a 4-6 digit PIN (a convenience threshold when the account does not match). A scheduled run
 * therefore writes an **unencrypted** repository by default (`backupEncryption: none`): the data key sits next
 * to the data, and anyone who can read the repository directory can restore it. That is what "default is
 * unencrypted" means, and the panel says so in words.
 *
 * An operator who wants the old behaviour (machine envelope under DPAPI, so an unattended run types no
 * password) sets `backupEncryption: sealed`. On a platform without an OS keystore a `sealed` scheduled run
 * refuses with `BACKUP_NO_PERMISSION` and logs it; the operator's path is the offline CLI
 * (`w2m-backup run --password-stdin`), which is an explicit human action rather than a stored secret. Storing
 * the password in configuration to make the timer work trades the little protection there is for convenience,
 * so it is not offered.
 *
 * ## The account path is a compare-only identity binding, and only for sealed repositories
 *
 * The user's decision (2026-11-17, `docs/BACKUP-DESIGN.md` §25): read the host's **account identifier**, compare
 * it with the id the repository is bound to, and allow the account path when they match; on a mismatch fall back
 * to the password path. It is deliberately **not** a secret and never replaces the password envelope -- anyone
 * who knows the id and has the files could derive the same KEK, which is the accepted trade-off. With
 * `backupAccountBinding` on (the default) the route reads the id through `createAccountIdentity({ctx}).identify()`
 * (best effort, never throws: signed out or no account service simply yields `null`), passes it to the run (which
 * binds it after a successful commit) and to the unlock probes, where it is only compared. An **unencrypted**
 * repository is never bound: it opens with no credential, so binding it would silently re-seal the default mode
 * after the first run. The account id is masked in every response (`account.id_hint`, last four characters only).
 *
 * ## The route requires a confirmation token
 *
 * A `POST` from the panel model is not a button click -- it is a network request a stale page can replay. The body
 * must carry `{"confirm":"run"}` (plus the scope), so "run a backup now" is never the meaning of an accidental
 * empty POST.
 */

import { applyRestore, planRestore } from '../backup/restore.mjs';
import { buildArchive } from '../backup/archive.mjs';
import { DEFAULT_RECHECK_DELAYS, scheduleRegistryRecheck } from '../backup/registry-watch.mjs';
import { describeUnlock, unlockRepo } from '../backup/unlock.mjs';
import { verifyRepo } from '../backup/verify.mjs';
import { createAccountIdentity } from '../chatops/account.mjs';
import os from 'node:os';
import path from 'node:path';

import { createDailyScheduler, DEFAULT_CATCH_UP_MS } from './schedule.mjs';
import { runBackup, SCOPES } from '../backup/engine.mjs';
import { buildStatus } from '../backup/routes.mjs';
import { describeBackupSchedule, normalizeBackupSchedule } from '../backup/schedule.mjs';
import { DEFAULT_KEEP_OLD, DEFAULT_OLD_FORMAT, OLD_FORMATS } from '../backup/rotation.mjs';
import { REPO_ENCRYPTION_MODES } from '../backup/layout.mjs';

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
 * `backupOldVersionDays` is the age half of the retention policy: an integer >= 0, where 0 (the default) means
 * "per-session count only". `backupOldFormat` selects what a superseded version costs: `records` (the default)
 * keeps the deduplicated version record only, `full` also writes one sealed whole-file copy per rotated version
 * and therefore doubles that version's bytes. Any other value is refused rather than ignored -- an operator who
 * wrote `backupOldFormat: full` and silently got records would believe copies exist that do not.
 * `backupMirrorDir` is the offsite mirror directory; absent/empty means no mirror, and a non-string value is
 * refused rather than silently ignored (a typo in the row should not mount a plugin that silently copies
 * nowhere).
 * `backupEncryption` selects the **protection** mode used when a repository is first created: `none` (default)
 * stores the data key in clear next to the data (no credential needed), `sealed` keeps the account/machine/PIN
 * envelopes. It never changes an existing repository's mode; the CLI's `unlock --set-password` /
 * `--disable-protection` are the explicit conversion commands.
 *
 * @param {object} [config]
 * @param {{env?: Record<string, string|undefined>, platform?: string}} [deps]
 * @returns {{ok: true, enabled: boolean, backup_dir: string, times: string[], time_zone: string, catch_up_ms: number,
 *   scope: string, keep_old_per_session: number, old_version_days: number, old_format: 'records'|'full',
 *   encryption: 'none'|'sealed', mirror_dir: string|null, account_binding: boolean, dsh_home: string}
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
  // The future-append simulation costs one decode per session (measured: 4.8 s -> 26 s on a 171 MB real home).
  // It stays on by default; a host that values the time over the signal can turn it off here.
  const futureAppend = config.backupFutureAppend !== false;
  // The account path is a compare-only identity binding (docs/BACKUP-DESIGN.md §25, the user's 2026-11-17 decision).
  // When enabled, a run asks the host for its account id (best effort) and binds it after a successful run, so a
  // matching account unlocks without a password. The id is an identifier, not a secret: this never replaces the
  // password envelope, and a host without an account service simply yields `null` -- the run and the unlock
  // probes continue exactly as before.
  const accountBinding = config.backupAccountBinding !== false;
  const keepOld = Number.isSafeInteger(config.keepOldPerSession) && config.keepOldPerSession >= 0
    ? config.keepOldPerSession
    : DEFAULT_KEEP_OLD;
  // The age retention rule: 0 means "count rule only", never "prune everything". Validated here so a bad row
  // fails the mount with a configuration code instead of failing a scheduled run at 22:00.
  const oldVersionDays = config.backupOldVersionDays;
  if (oldVersionDays !== undefined && oldVersionDays !== null && (!Number.isSafeInteger(oldVersionDays) || oldVersionDays < 0)) {
    return {
      ok: false,
      reason_code: 'BACKUP_CONFIG_INVALID',
      detail: `backupOldVersionDays must be a non-negative integer, got ${JSON.stringify(oldVersionDays)}`,
    };
  }
  // The `old/` shape: `records` (default) keeps the deduplicated record only, `full` adds a sealed whole-file
  // copy per superseded version. Refused here, like the age rule, so a bad row fails the mount with a
  // configuration code instead of failing a scheduled run at 22:00.
  const oldFormat = config.backupOldFormat ?? DEFAULT_OLD_FORMAT;
  if (!OLD_FORMATS.includes(oldFormat)) {
    return {
      ok: false,
      reason_code: 'BACKUP_CONFIG_INVALID',
      detail: `backupOldFormat must be one of ${OLD_FORMATS.join(', ')}, got ${JSON.stringify(oldFormat)}`,
    };
  }
  // The protection mode for a NEW repository. `none` is the default (the user's decision: 默认是不加密); a bad
  // value fails the mount with a configuration code instead of becoming a silent surprise in a scheduled run.
  const encryption = config.backupEncryption ?? 'none';
  if (!REPO_ENCRYPTION_MODES.includes(encryption)) {
    return {
      ok: false,
      reason_code: 'BACKUP_CONFIG_INVALID',
      detail: `backupEncryption must be one of ${REPO_ENCRYPTION_MODES.join(', ')}, got ${JSON.stringify(encryption)}`,
    };
  }
  // The offsite mirror directory: absent/empty -> no mirror; a non-string given value is refused. The path is
  // resolved here, but containment (inside the repository / the home) is checked by the engine at run time,
  // because only the engine knows whether the repository will be created at that path.
  const mirrorValue = config.backupMirrorDir;
  let mirrorDir = null;
  if (mirrorValue !== undefined && mirrorValue !== null) {
    if (typeof mirrorValue !== 'string') {
      return {
        ok: false,
        reason_code: 'BACKUP_CONFIG_INVALID',
        detail: `backupMirrorDir must be a path string when it is given, got ${JSON.stringify(mirrorValue)}`,
      };
    }
    if (mirrorValue.trim() !== '') mirrorDir = path.resolve(mirrorValue.trim());
  }
  // Optional override of the post-restore registry re-check schedule (tests use a short list; a host may want a
  // longer one). Absent means the module default (2 s / 8 s / 20 s).
  const registryRecheckMs = Array.isArray(config.backupRegistryRecheckMs) && config.backupRegistryRecheckMs.length > 0 &&
    config.backupRegistryRecheckMs.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? [...config.backupRegistryRecheckMs]
    : null;
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
    future_append: futureAppend,
    account_binding: accountBinding,
    encryption,
    keep_old_per_session: keepOld,
    old_version_days: oldVersionDays ?? 0,
    old_format: oldFormat,
    mirror_dir: mirrorDir,
    registry_recheck_ms: registryRecheckMs,
    dsh_home: dshHome,
  };
}

/**
 * Mount the backup subplugin.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] row configuration (`backupDir`, `backupTimes`, `backupTimeZone`, `backupScope`,
 *   `keepOldPerSession`, `backupOldVersionDays`, `backupOldFormat`, `backupMirrorDir`, `backupEnabled`)
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
    keep_old_per_session: cfg.keep_old_per_session,
    old_version_days: cfg.old_version_days,
    old_format: cfg.old_format,
    encryption: cfg.encryption,
    mirror_dir: cfg.mirror_dir,
    runs: 0,
    failures: 0,
    last_run: null,
    last_result: null,
    last_error: null,
    running: false,
  };

  /**
   * The host's account identifier, best effort, or `null`.
   *
   * Never throws and never blocks a run or a probe on an identity problem: `identify()` reports `signed-out` as a
   * normal state, and a host without the `deepseekAccount` service has no account path at all. The raw id is used
   * only in-process (bound into a KEK and compared with the recorded binding); it is never logged or returned --
   * the audit line account.mjs emits carries the hashed account code, and every response carries `id_hint` only.
   */
  const identifyAccountId = async () => {
    if (cfg.account_binding !== true) return null;
    try {
      const identity = createAccountIdentity({
        ctx,
        audit: (event, detail) => ctx.logger?.info?.(
          `w2m-dsh-backup: ${event}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`,
        ),
      });
      const identified = await identity.identify();
      if (identified.ok !== true) return null;
      return typeof identified.userId === 'string' && identified.userId.trim() !== '' ? identified.userId : null;
    } catch {
      // A failed identity read is the machine/password paths' turn, not an error the operator has to see.
      return null;
    }
  };

  /** Run one backup and never throw: the timer and the route both need a result, not an exception. */
  const runNow = async (reason, request) => {
    if (state.running) {
      return { ok: false, reason_code: 'BACKUP_BUSY', detail: 'a backup is already running', reason };
    }
    state.running = true;
    try {
      // Account binding: the id is read here (once per run) and passed to the engine, which binds it after a
      // successful commit. `null` means "no account path on this host", never an error.
      const accountId = await identifyAccountId();
      const result = runBackup({
        root: cfg.backup_dir,
        dshHome: cfg.dsh_home,
        scope: request?.scope ?? cfg.scope,
        selected: request?.selected ?? [],
        keepOldPerSession: cfg.keep_old_per_session,
        maxOldVersionDays: cfg.old_version_days,
        oldFormat: cfg.old_format,
        encryption: cfg.encryption,
        mirrorRoot: cfg.mirror_dir,
        machineKey: cfg.machine_key,
        futureAppend: cfg.future_append,
        dryRun: request?.dryRun === true,
        accountId,
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
          old_format: result.old_format,
          full_old_versions: result.full_old_versions ?? [],
          future_append: result.future_append ?? null,
          // The offsite copy is best effort: the primary result stays `ok` and the failure is visible here.
          mirror: result.mirror ?? null,
          warnings: result.warnings ?? [],
        };
        ctx.logger?.info?.(
          `w2m-dsh-backup: ${reason} backup ${result.snapshot_id}: ${result.sessions} session(s), ` +
            `${result.blocks_new} new block(s), ${result.blocks_reused} reused`,
        );
        if (result.mirror?.ok === false) {
          ctx.logger?.warn?.(`w2m-dsh-backup: ${reason} backup ${result.snapshot_id}: the offsite mirror failed: ${result.mirror.reason_code} ${result.mirror.reason}`);
        }
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

  /** The pending post-restore registry re-check, cancelled when this row unmounts (G2 half three). */
  let activeRecheck = null;
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => activeRecheck?.cancel(), 'w2m: registry recheck');
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
          const describe = () => {
            // Read-only and cheap: the panel shows repository facts (initialized, snapshots, latest) without a
            // second round-trip, and a probe failure must not take the whole status payload down.
            let status = null;
            try {
              status = buildStatus({ backupDir: cfg.backup_dir, dshHome: cfg.dsh_home });
            } catch (error) {
              status = { ok: false, reason_code: 'BACKUP_STATUS_FAILED', detail: error?.message ?? String(error) };
            }
            return {
              ok: true,
              enabled: true,
              backup_dir: cfg.backup_dir,
              dsh_home: cfg.dsh_home,
              retention: { keep_old_per_session: cfg.keep_old_per_session, old_version_days: cfg.old_version_days },
              old_format: cfg.old_format,
              // The mode this row will create a NEW repository with. The repository's actual mode is
              // `status.repository.encryption` / `encryption` (an existing sealed repository keeps its mode).
              encryption: cfg.encryption,
              account_binding: cfg.account_binding,
              mirror_dir: cfg.mirror_dir,
              schedule: describeBackupSchedule({ enabled: true, times: cfg.times, timeZone: cfg.time_zone }),
              scheduler: scheduler.describe(),
              status,
              state,
            };
          };
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
          const result = await runNow('manual', {
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
      // Read the host account id once per request (best effort, never throws) and pass it to every path that can
      // open the repository. The describe/attempt paths only compare it; restore/archive/verify accept it as an
      // additional credential path, exactly like the CLI accepts --password. The route never receives a password.
      const unlockInput = async () => ({
        root: cfg.backup_dir,
        dshHome: cfg.dsh_home,
        machineKey: cfg.machine_key,
        accountId: await identifyAccountId(),
      });

      registry.register({
        path: BACKUP_UNLOCK_ROUTE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method === 'GET') {
            return Response.json(describeUnlock(await unlockInput()), { headers: NO_STORE });
          }
          if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          const body = await readBody(request);
          if (body === null || body.confirm !== UNLOCK_CONFIRM_TOKEN) {
            return refuse('BACKUP_CONFIRM_REQUIRED', `a JSON body with {"confirm":"${UNLOCK_CONFIRM_TOKEN}"} is required`);
          }
          const result = unlockRepo(await unlockInput());
          return Response.json(
            { ok: result.ok, via: result.via, encryption: result.encryption, account: result.account, reason_code: result.reason_code, detail: result.detail, attempts: result.attempts },
            { headers: NO_STORE },
          );
        },
      });

      registry.register({
        path: BACKUP_VERIFY_ROUTE_PATH,
        methods: ['GET'],
        fetch: async (request) => {
          if (request.method !== 'GET') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          // Read-only but expensive: it decrypts every block of every snapshot to re-hash it. With ?runtime=1 it
          // also asks the installed Harness about every log and every appended log (G5), which is slower.
          const runtime = new URL(request.url).searchParams.get('runtime') === '1';
          const result = verifyRepo({ ...(await unlockInput()), futureAppend: true, runtime });
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
            ...(await unlockInput()),
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
            ...(await unlockInput()),
            snapshotId: typeof body.snapshot === 'string' ? body.snapshot : null,
            sessionIds: Array.isArray(body.sessions) ? body.sessions : [],
            keepBoth: body.keepBoth === true,
            allowStaticValidation: body.allowStaticValidation === true,
            workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : null,
            allowLiveHome: true,
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
          if (applied.ok === true && applied.dry_run !== true) {
            // G2's third half: the client may save its in-memory registry over ours; sample after it would have.
            activeRecheck?.cancel();
            activeRecheck = scheduleRegistryRecheck({
              dshHome: cfg.dsh_home,
              plan,
              delaysMs: cfg.registry_recheck_ms,
              onResult: (result) => {
                state.last_registry_recheck = { at: new Date().toISOString(), ...result };
                if (result.ok !== true) {
                  ctx.logger?.warn?.(`w2m-dsh-backup: the registry re-check still fails after the client save: ${result.detail}`);
                } else if (result.rewrote === true) {
                  ctx.logger?.info?.(`w2m-dsh-backup: the client overwrote the restored registry entry; re-applied it (${result.delay_ms} ms sample)`);
                }
              },
            });
            applied.registry_recheck = { scheduled: true, delays_ms: [...(cfg.registry_recheck_ms ?? DEFAULT_RECHECK_DELAYS)] };
          }
          return Response.json(applied, { headers: NO_STORE });
        },
      });
    });
  }

  ctx.logger?.info?.(
    `w2m-dsh-backup: mounted; ${cfg.times.join(', ')} ${cfg.time_zone} -> ${cfg.backup_dir} (scope ${cfg.scope})`,
  );
}
