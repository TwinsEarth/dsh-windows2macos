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
 *
 * ## `old/` has no total cap; the row configures a growth reminder (v3.5.0, §24.3)
 *
 * The user's decision is "no total limit; remind every 10 GB and let the user decide whether to clean up
 * manually". `backupOldUsageReminderGb` (default `10`, `0` = reminders off) is therefore a **reminder threshold,
 * not a cap**: the engine measures `old/` after every successful run (post-rotation, one read-only walk), and when
 * the tree has grown by at least that much since the persisted acknowledgement it adds a warning -- nothing is
 * pruned. This subplugin persists the measurement and the ack mark in the plugin state file
 * (`<DSH_HOME>/xclient/w2m-backup/state.json`, the same store the cached runtime verdict uses) as
 * `state.old_usage` / `state.old_usage_ack_bytes`, exposes them in the embedded describe, and mounts
 * `POST /api/w2m/backup/old-usage/ack` (`{"confirm":"ack"}`) for the panel's 「知道了」 button. That route sets
 * `old_usage_ack_bytes` to the size measured **now**, clears `state.old_usage.due` and deletes nothing: the only
 * cleanup path is the operator running `w2m-backup gc` (the panel's 「如何清理」 explains it and never executes it).
 */

import { applyRestore, planRestore } from '../backup/restore.mjs';
import { buildArchive } from '../backup/archive.mjs';
import { DEFAULT_RECHECK_DELAYS, scheduleRegistryRecheck } from '../backup/registry-watch.mjs';
import { applyRegister, planRegister, registerThroughHost, REGISTER_CODES } from '../backup/register.mjs';
import { DEFAULT_ROUTE_WATCH_CAP_MS, REGISTER_RESIDUAL_RISK_LINE, sampleWatchSchedule } from '../backup/register-watch.mjs';
import { RUNTIME_VERDICT_MODES, createRuntimeVerdictStore, readBackupState, writeBackupState } from '../backup/runtime-verdict.mjs';
import { describeUnlock, unlockRepo } from '../backup/unlock.mjs';
import { verifyRepo } from '../backup/verify.mjs';
import { createAccountIdentity } from '../chatops/account.mjs';
import os from 'node:os';
import path from 'node:path';

import { createDailyScheduler, DEFAULT_CATCH_UP_MS } from './schedule.mjs';
import { runBackup, SCOPES } from '../backup/engine.mjs';
import { buildStatus } from '../backup/routes.mjs';
import { describeBackupSchedule, normalizeBackupSchedule } from '../backup/schedule.mjs';
import { DEFAULT_FULL_COPY_MAX_BYTES, DEFAULT_KEEP_OLD, DEFAULT_OLD_FORMAT, DEFAULT_OLD_USAGE_REMINDER_BYTES, OLD_FORMATS, buildOldUsageReport, measureOldUsage } from '../backup/rotation.mjs';
import { REPO_ENCRYPTION_MODES } from '../backup/layout.mjs';

/** The row's `backupFullCopyMaxMb` default, expressed in MB (the engine's cap is in bytes). */
export const DEFAULT_FULL_COPY_MAX_MB = DEFAULT_FULL_COPY_MAX_BYTES / (1024 * 1024);

/** The row's `backupOldUsageReminderGb` default, in GB (the engine's threshold is in bytes). */
export const DEFAULT_OLD_USAGE_REMINDER_GB = DEFAULT_OLD_USAGE_REMINDER_BYTES / (1024 ** 3);

/** The named engine refusal that means "a human must approve this full-copy write (特批)". */
export const FULL_COPY_APPROVAL_CODE = 'BACKUP_FULL_COPY_APPROVAL_REQUIRED';

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

/** Register-repair route (v3.5.x): POST with `{"confirm":"register","session_ids":[...]}` plans, applies and
 *  watches the registry inside the host, where the client is by definition running. */
export const BACKUP_REGISTER_ROUTE_PATH = '/api/w2m/backup/register';

/**
 * Old-version usage acknowledgement route (v3.5.0, §24.3): POST with `{"confirm":"ack"}`.
 *
 * `old/` has no total cap by decision; the panel's 「知道了」 posts here to move the acknowledgement mark to the
 * bytes measured **now**, which clears the pending growth reminder. It deletes nothing and the panel has no
 * destructive action.
 */
export const BACKUP_OLD_USAGE_ACK_ROUTE_PATH = '/api/w2m/backup/old-usage/ack';

/** Confirmation token for the restore route. */
export const RESTORE_CONFIRM_TOKEN = 'restore';

/** Confirmation token for the archive route. */
export const ARCHIVE_CONFIRM_TOKEN = 'archive';

/** Confirmation token for the unlock attempt. */
export const UNLOCK_CONFIRM_TOKEN = 'unlock';

/** Confirmation token for the register repair (a file write under the client's own home). */
export const REGISTER_CONFIRM_TOKEN = 'register';

/** Confirmation token for the old-version usage acknowledgement (moves an ack mark; deletes nothing). */
export const OLD_USAGE_ACK_CONFIRM_TOKEN = 'ack';

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
 * `backupFullCopyMaxMb` caps ONE `full` whole-file copy: a session file larger than the cap makes a run refuse
 * before writing (`BACKUP_FULL_COPY_APPROVAL_REQUIRED`) until a human approves that run ("特批"). It defaults to
 * 300 MB; `0` disables the cap explicitly, and a non-integer/negative value is refused rather than coerced.
 * `backupOldUsageReminderGb` is NOT a cap on `old/`: it is the growth (since the last acknowledgement) at which a
 * run raises the manual-cleanup reminder. It defaults to 10 GB and `0` turns reminders off; a negative,
 * non-numeric or non-finite value is refused rather than coerced. The tree is measured after every successful run
 * and the measurement is persisted as `state.old_usage`; nothing is ever deleted because of it.
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
 *   full_copy_max_mb: number, full_copy_max_bytes: number,
 *   old_usage_reminder_gb: number, old_usage_reminder_bytes: number,
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
  // Backup scopes (P0): registry/config/state are part of the default because a backup that omits the
  // registry and the profile configuration cannot restore a usable home on another machine.
  const scopesRaw = config.backupScopes ?? undefined;
  if (scopesRaw !== undefined && (!Array.isArray(scopesRaw) || scopesRaw.some((name) => typeof name !== 'string'))) {
    return {
      ok: false,
      reason_code: 'BACKUP_CONFIG_INVALID',
      detail: `backupScopes must be an array of scope names, got ${JSON.stringify(scopesRaw)}`,
    };
  }
  const scopes = scopesRaw === undefined ? undefined : scopesRaw;
  // P1: credentials opt-in. Only the literal boolean true counts; anything else is off.
  const includeSecrets = config.backupIncludeSecrets === true;
  const oldFormat = config.backupOldFormat ?? DEFAULT_OLD_FORMAT;
  if (!OLD_FORMATS.includes(oldFormat)) {
    return {
      ok: false,
      reason_code: 'BACKUP_CONFIG_INVALID',
      detail: `backupOldFormat must be one of ${OLD_FORMATS.join(', ')}, got ${JSON.stringify(oldFormat)}`,
    };
  }
  // The `full` whole-file copy cap: 300 MB by default, `0` means "no cap" (explicit, documented), and anything
  // that is not a non-negative integer is refused here so a typo cannot silently disable a cost guard. The value
  // is MB on the row and bytes in the engine (which compares it with each session file's size).
  const fullCopyMaxMb = config.backupFullCopyMaxMb ?? DEFAULT_FULL_COPY_MAX_MB;
  if (!Number.isSafeInteger(fullCopyMaxMb) || fullCopyMaxMb < 0) {
    return {
      ok: false,
      reason_code: 'BACKUP_CONFIG_INVALID',
      detail: `backupFullCopyMaxMb must be a non-negative integer number of MB (0 = no cap), got ${JSON.stringify(config.backupFullCopyMaxMb)}`,
    };
  }
  const fullCopyMaxBytes = fullCopyMaxMb * 1024 * 1024;
  // The `old/` usage reminder (v3.5.0, §24.3): `old/` has **no total cap by decision**. The row configures how much
  // growth since the last acknowledgement should trigger the reminder; `0` disables reminders. It is explicitly not
  // a limit -- validating it here only means a typo fails the mount instead of surfacing as a missing reminder on
  // the 22:00 path. Non-negative numbers (including fractions) are accepted; anything else is refused by name.
  const oldUsageReminderGb = config.backupOldUsageReminderGb ?? DEFAULT_OLD_USAGE_REMINDER_GB;
  if (typeof oldUsageReminderGb !== 'number' || !Number.isFinite(oldUsageReminderGb) || oldUsageReminderGb < 0 ||
    !Number.isSafeInteger(Math.round(oldUsageReminderGb * 1024 ** 3))) {
    return {
      ok: false,
      reason_code: 'BACKUP_CONFIG_INVALID',
      detail: `backupOldUsageReminderGb must be a non-negative number of GB (0 = reminders off), got ${JSON.stringify(config.backupOldUsageReminderGb)}`,
    };
  }
  const oldUsageReminderBytes = Math.round(oldUsageReminderGb * 1024 ** 3);
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
  // The runtime verdict after the scheduled backup: `off` (default) or `nightly`. Refused here like the other
  // enum options so a typo cannot silently mean "never" when the operator asked for a nightly verdict.
  const runtimeVerify = config.backupRuntimeVerify ?? 'nightly';
  if (!RUNTIME_VERDICT_MODES.includes(runtimeVerify)) {
    return {
      ok: false,
      reason_code: 'BACKUP_CONFIG_INVALID',
      detail: `backupRuntimeVerify must be one of ${RUNTIME_VERDICT_MODES.join(', ')}, got ${JSON.stringify(runtimeVerify)}`,
    };
  }
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
    scopes,
    include_secrets: includeSecrets,
    full_copy_max_mb: fullCopyMaxMb,
    full_copy_max_bytes: fullCopyMaxBytes,
    old_usage_reminder_gb: oldUsageReminderGb,
    old_usage_reminder_bytes: oldUsageReminderBytes,
    mirror_dir: mirrorDir,
    registry_recheck_ms: registryRecheckMs,
    runtime_verify: runtimeVerify,
    dsh_home: dshHome,
  };
}

/**
 * Mount the backup subplugin.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] row configuration (`backupDir`, `backupTimes`, `backupTimeZone`, `backupScope`,
 *   `keepOldPerSession`, `backupOldVersionDays`, `backupOldFormat`, `backupFullCopyMaxMb`, `backupMirrorDir`,
 *   `backupOldUsageReminderGb`, `backupEnabled`, `backupRuntimeVerify: 'off'|'nightly'` (default nightly))
 * @param {{runtimeVerify?: Function, registerWatch?: Function, createScheduler?: Function, now?: Function}} [deps]
 *   Injectable seams for tests. `runtimeVerify` replaces the real `verifyRepo({runtime:true})` call the cached
 *   verdict store runs (so a unit test never spawns the Harness); `registerWatch` replaces the bounded watch the
 *   register route awaits (so the route test does not sleep 30 s); `createScheduler` lets a test drive the
 *   nightly hook without waiting for 22:00.
 */
export function apply(ctx, config = {}, deps = {}) {
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
    full_copy_max_mb: cfg.full_copy_max_mb,
    encryption: cfg.encryption,
    mirror_dir: cfg.mirror_dir,
    runtime_verify_mode: cfg.runtime_verify,
    // `old/` has no total cap; this is the reminder threshold the row configures (0 = reminders off). It is exposed
    // in the describe payload so the panel's 「如何清理」 text and the reminder banner quote the number in effect.
    old_usage_reminder_gb: cfg.old_usage_reminder_gb,
    old_usage_reminder_bytes: cfg.old_usage_reminder_bytes,
    // Filled from the persisted plugin state below: the acknowledgement mark (bytes) and the last reminder record.
    old_usage_ack_bytes: 0,
    old_usage: null,
    runs: 0,
    failures: 0,
    last_run: null,
    last_result: null,
    last_error: null,
    last_runtime_verify: null,
    running: false,
  };

  // Restore the reminder state a previous process persisted: the panel must show a pending reminder left behind by
  // the 22:00 run, and the next run must measure growth against the operator's last acknowledgement. A corrupt or
  // missing state file reads as "no acknowledgement yet" (0), which errs toward reminding, never toward silence.
  try {
    const persisted = readBackupState(cfg.dsh_home).state;
    state.old_usage_ack_bytes = Number.isSafeInteger(persisted.old_usage_ack_bytes) && persisted.old_usage_ack_bytes >= 0
      ? persisted.old_usage_ack_bytes
      : 0;
    state.old_usage = persisted.old_usage !== null && typeof persisted.old_usage === 'object' ? persisted.old_usage : null;
  } catch {
    state.old_usage_ack_bytes = 0;
    state.old_usage = null;
  }

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

  /**
   * The inputs every route that has to open the repository passes: paths plus the account id (compare-only).
   *
   * It lives here, once, because the cached runtime verdict's verify function needs the same credential path as
   * the verify route that refreshes it -- a second copy would let the two disagree about which credential opened
   * the repository.
   */
  const unlockInput = async () => ({
    root: cfg.backup_dir,
    dshHome: cfg.dsh_home,
    machineKey: cfg.machine_key,
    accountId: await identifyAccountId(),
  });

  /**
   * The cached runtime verdict (G5). `cached()` never spawns; `run()` spawns the installed Harness through
   * `verifyRepo({runtime:true})` (or the injected test runner) exactly once per in-flight request and persists the
   * record under `<dshHome>/xclient/w2m-backup/state.json`.
   */
  const runtimeVerdict = createRuntimeVerdictStore({
    dshHome: cfg.dsh_home,
    verify: typeof deps.runtimeVerify === 'function'
      ? deps.runtimeVerify
      : async () => verifyRepo({ ...(await unlockInput()), futureAppend: true, runtime: true }),
    ...(typeof deps.now === 'function' ? { now: deps.now } : {}),
  });
  state.last_runtime_verify = runtimeVerdict.record();

  /**
   * Fire the nightly runtime verdict after a successful scheduled backup. Deliberately NOT awaited: the backup is
   * committed and its result is returned first, so a slow or failing verdict can only produce a log line and a
   * record -- never a failed schedule slot.
   */
  const queueNightlyRuntimeVerify = () => {
    runtimeVerdict.run({ trigger: 'nightly' })
      .then((outcome) => {
        state.last_runtime_verify = outcome.record;
        if (outcome.persisted !== true) {
          ctx.logger?.warn?.(`w2m-dsh-backup: nightly runtime verdict could not be persisted: ${outcome.persist_error ?? 'unknown error'}`);
        }
        if (outcome.record.ok === true) {
          ctx.logger?.info?.(
            `w2m-dsh-backup: nightly runtime verdict passed: checked ${outcome.record.checked}, failed ${outcome.record.failed}, ` +
              `${outcome.record.snapshots} snapshot(s), evidence ${outcome.record.evidence}`,
          );
        } else {
          ctx.logger?.warn?.(
            `w2m-dsh-backup: nightly runtime verdict failed: ${outcome.record.reason_codes.join(', ') || 'no code'} (the backup itself is committed)`,
          );
        }
      })
      .catch((error) => {
        ctx.logger?.warn?.(`w2m-dsh-backup: nightly runtime verdict threw: ${error instanceof Error ? error.message : String(error)}`);
      });
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
            scopes: cfg.scopes,
    includeSecrets: cfg.include_secrets === true,
// The cap is bytes in the engine; the row configures MB. The schedule path never sets allowLargeFullCopy:
        // a timer must not approve a write on a person's behalf, which is exactly what makes the refusal below a
        // named pending state instead of an unattended over-cap write.
        maxFullCopyBytes: cfg.full_copy_max_bytes,
        allowLargeFullCopy: request?.allowLargeFullCopy === true,
        // The usage reminder: the row configures GB, the engine takes bytes, and the acknowledgement mark is the
        // plugin's persisted state (moved only by the panel's 「知道了」 route, never by a run). The engine measures
        // `old/` after rotation; it never deletes anything because of it.
        oldUsageReminderBytes: cfg.old_usage_reminder_bytes,
        oldUsageAckBytes: state.old_usage_ack_bytes,
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
          full_copy_approved_over_cap: result.full_copy_approved_over_cap ?? [],
          full_copy_max_mb: cfg.full_copy_max_mb,
          future_append: result.future_append ?? null,
          // The `old/` measurement this run produced (bytes/files/reminder.threshold/due). It is also persisted below,
          // in the plugin state, because the panel must render a pending reminder after a page refresh.
          old_usage: result.old_usage ?? null,
          // The offsite copy is best effort: the primary result stays `ok` and the failure is visible here.
          mirror: result.mirror ?? null,
          warnings: result.warnings ?? [],
        };
        // Persist the measurement and (when due) the pending reminder. This is a state write, not a cleanup: `old/`
        // is untouched, nothing is deleted, and the record is what the panel's banner renders until the operator
        // acknowledges. A state-file failure never downgrades the committed backup -- it is logged as a warning.
        const measuredOldUsage = result.old_usage !== null && typeof result.old_usage === 'object' ? result.old_usage : null;
        if (measuredOldUsage !== null) {
          const oldUsageRecord = {
            due: measuredOldUsage.due === true,
            bytes: measuredOldUsage.bytes,
            files: measuredOldUsage.files,
            ack_bytes: state.old_usage_ack_bytes,
            reminder_bytes: measuredOldUsage.reminder_bytes,
            at: new Date().toISOString(),
          };
          state.old_usage = oldUsageRecord;
          const persistedUsage = writeBackupState(cfg.dsh_home, {
            old_usage: oldUsageRecord,
            old_usage_ack_bytes: state.old_usage_ack_bytes,
          });
          if (persistedUsage.ok !== true) {
            ctx.logger?.warn?.(`w2m-dsh-backup: the old/ usage measurement could not be persisted: ${persistedUsage.error ?? 'unknown error'}`);
          }
          if (oldUsageRecord.due === true) {
            ctx.logger?.warn?.(
              `w2m-dsh-backup: old/ grew ${measuredOldUsage.since_last_ack_bytes} bytes since the last acknowledgement ` +
                `(reminder at ${measuredOldUsage.reminder_bytes}); nothing was deleted -- manual cleanup is w2m-backup gc`,
            );
          }
        }
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
        if (result.reason_code === FULL_COPY_APPROVAL_CODE) {
          // A named PENDING state, not a lost backup: the engine refused before writing anything, so the
          // repository is untouched and the same run can be approved and retried. A scheduled run gets no person,
          // so it records the pending refusal here for the panel instead of waiting -- a timer that blocks on a
          // prompt is a dead timer. No approval is ever inferred: only an explicit panel/CLI action sets it.
          state.last_result = {
            ok: false,
            reason_code: FULL_COPY_APPROVAL_CODE,
            detail: result.detail ?? null,
            reason,
            at: new Date().toISOString(),
            scope: request?.scope ?? cfg.scope,
            selected: Array.isArray(request?.selected) ? request.selected : [],
            full_copy_approval_required: true,
            over_cap_count: Number.isFinite(Number(result.over_cap_count)) ? Number(result.over_cap_count) : 0,
            cap_bytes: Number.isFinite(Number(result.cap_bytes)) ? Number(result.cap_bytes) : cfg.full_copy_max_bytes,
            full_copy_max_mb: cfg.full_copy_max_mb,
            full_copy_oversized: Array.isArray(result.full_copy_oversized) ? result.full_copy_oversized : [],
            warnings: [
              `${FULL_COPY_APPROVAL_CODE}: ${result.over_cap_count ?? 0} session(s) exceed the ` +
                `${cfg.full_copy_max_mb} MB full-copy cap; nothing was written and the run awaits an explicit approval`,
            ],
          };
          ctx.logger?.warn?.(
            `w2m-dsh-backup: ${reason} backup refused before writing: ${FULL_COPY_APPROVAL_CODE}: ` +
              `${result.over_cap_count ?? 0} session(s) exceed the ${cfg.full_copy_max_mb} MB full-copy cap; approval required (the repository is untouched)`,
          );
        } else {
          ctx.logger?.warn?.(`w2m-dsh-backup: ${reason} backup refused: ${result.reason_code}: ${result.detail}`);
        }
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

  const createScheduler = typeof deps.createScheduler === 'function' ? deps.createScheduler : createDailyScheduler;
  const scheduler = createScheduler({
    // The scheduled path (and the missed-slot catch-up, which runs through this same function) is the one place
    // the nightly runtime verdict is attached: after the backup result is produced, never before it.
    run: async () => {
      const result = await runNow('scheduled');
      if (result?.ok === true && cfg.runtime_verify === 'nightly') queueNightlyRuntimeVerify();
      return result;
    },
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
              // P0/P1: the scopes this row runs with, and whether the row includes credentials. The panel
              // renders both (scope line + a red "credentials included" warning) from this payload.
              scopes: Array.isArray(cfg.scopes) && cfg.scopes.length > 0 ? cfg.scopes : null,
              include_secrets: cfg.include_secrets === true,
              // The `full` whole-file copy cap (MB; 0 = no cap). The panel shows it as the threshold and the
              // approval dialog quotes it, so the number on screen is the number the engine compares against.
              full_copy_max_mb: cfg.full_copy_max_mb,
              // The `old/` usage reminder threshold (GB; 0 = reminders off). A reminder, never a cap: the engine
              // measures `old/` and the state below carries the pending record the panel's banner renders.
              old_usage_reminder_gb: cfg.old_usage_reminder_gb,
              // The mode this row will create a NEW repository with. The repository's actual mode is
              // `status.repository.encryption` / `encryption` (an existing sealed repository keeps its mode).
              encryption: cfg.encryption,
              account_binding: cfg.account_binding,
              mirror_dir: cfg.mirror_dir,
              schedule: describeBackupSchedule({ enabled: true, times: cfg.times, timeZone: cfg.time_zone }),
              scheduler: scheduler.describe(),
              status,
              // The cached runtime verdict is exposed by the embedded status so the panel can render it without a
              // second request; `cached: true` is spoken here too, because this record never spawns anything.
              runtime_verify: { mode: cfg.runtime_verify, cached: true },
              state: { ...state, last_runtime_verify: runtimeVerdict.record() },
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
            // The explicit "特批" flag: only the literal `true` approves a write above the full-copy cap. The
            // dialog re-posts the same request with this field, so an approval is always a second, human click.
            allowLargeFullCopy: body.allowLargeFullCopy === true,
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
          // The payload is additive: `password_hint` is the PUBLIC "备注提示词" (plain text in keys.json by design),
          // never the PIN. The GET describe already carries it; the POST repeats it so the dialog can refresh
          // from either half without a second request.
          return Response.json(
            {
              ok: result.ok,
              via: result.via,
              encryption: result.encryption,
              account: result.account,
              password_hint: result.password_hint,
              reason_code: result.reason_code,
              detail: result.detail,
              attempts: result.attempts,
            },
            { headers: NO_STORE },
          );
        },
      });

      /**
       * The panel's 「知道了」 acknowledgement for the `old/` growth reminder (v3.5.0, §24.3).
       *
       * `old/` has no total cap by decision, so this route is **not a cleanup**: it measures the tree now, sets
       * `old_usage_ack_bytes` to that size and clears the pending record (`state.old_usage.due` becomes false). No
       * file is deleted here, and the panel exposes no destructive button -- the only cleanup path is the operator
       * running `w2m-backup gc` in a terminal, which the panel's 「如何清理」 guidance spells out. The confirmation
       * token is required because a stale page must not move the mark by accident.
       */
      registry.register({
        path: BACKUP_OLD_USAGE_ACK_ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          const body = await readBody(request);
          if (body === null || body.confirm !== OLD_USAGE_ACK_CONFIRM_TOKEN) {
            return refuse('BACKUP_CONFIRM_REQUIRED', `a JSON body with {"confirm":"${OLD_USAGE_ACK_CONFIRM_TOKEN}"} is required`);
          }
          const measured = measureOldUsage(cfg.backup_dir);
          const report = buildOldUsageReport({
            ...measured,
            ackBytes: measured.bytes,
            reminderBytes: cfg.old_usage_reminder_bytes,
          });
          const record = {
            due: false,
            bytes: measured.bytes,
            files: measured.files,
            ack_bytes: measured.bytes,
            reminder_bytes: cfg.old_usage_reminder_bytes,
            at: new Date().toISOString(),
          };
          const persisted = writeBackupState(cfg.dsh_home, { old_usage: record, old_usage_ack_bytes: measured.bytes });
          if (persisted.ok !== true) {
            return Response.json(
              {
                ok: false,
                reason_code: 'BACKUP_WRITE_FAILED',
                detail: `the acknowledgement could not be persisted: ${persisted.error ?? 'unknown error'}`,
              },
              { status: 500, headers: NO_STORE },
            );
          }
          state.old_usage_ack_bytes = measured.bytes;
          state.old_usage = record;
          ctx.logger?.info?.(
            `w2m-dsh-backup: old/ usage acknowledged at ${measured.bytes} bytes (${measured.files} file(s)); nothing was deleted`,
          );
          // The new state is returned so the panel can hide the banner without a second round-trip.
          return Response.json(
            {
              ok: true,
              deleted: false,
              old_usage_ack_bytes: measured.bytes,
              old_usage: { ...report, ack_bytes: measured.bytes, pending: false },
              state: { ...state, old_usage: record },
            },
            { headers: NO_STORE },
          );
        },
      });

      registry.register({
        path: BACKUP_VERIFY_ROUTE_PATH,
        methods: ['GET'],
        fetch: async (request) => {
          if (request.method !== 'GET') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          const runtimeParam = new URL(request.url).searchParams.get('runtime');
          // ?runtime=cached: read the persisted record and its staleness. It never spawns the runtime -- returning
          // a record with its timestamp is the honest answer, and the timestamp is what the `stale` badge says.
          if (runtimeParam === 'cached') {
            const cached = runtimeVerdict.cached();
            return Response.json({ ...cached, mode: 'cached' }, { headers: NO_STORE });
          }
          // Read-only but expensive: it decrypts every block of every snapshot to re-hash it. With ?runtime=1 it
          // also asks the installed Harness about every log and every appended log (G5), which is slower. That
          // path writes the cached verdict record before the response.
          const runtime = runtimeParam === '1';
          if (runtime === true) {
            const outcome = await runtimeVerdict.run({ trigger: 'manual-route' });
            state.last_runtime_verify = outcome.record;
            const result = outcome.verify_result ?? {
              ok: outcome.record.ok,
              reason_code: outcome.record.reason_codes[0] ?? null,
              detail: 'the runtime verdict produced no verify report',
              counts: { snapshots: outcome.record.snapshots },
              problems: [],
              runtime_verified: { checked: outcome.record.checked, failed: outcome.record.failed, evidence: outcome.record.evidence },
            };
            result.runtime_verify = outcome.record;
            result.runtime_verify_persisted = outcome.persisted;
            state.last_verify = {
              at: new Date().toISOString(),
              ok: result.ok === true,
              counts: result.counts,
              problems: Array.isArray(result.problems) ? result.problems.length : 0,
              runtime_verified: outcome.record.evidence,
            };
            return Response.json(result, { headers: NO_STORE });
          }
          const result = verifyRepo({ ...(await unlockInput()), futureAppend: true, runtime: false });
          state.last_verify = { at: new Date().toISOString(), ok: result.ok, counts: result.counts, problems: result.problems.length };
          return Response.json(result, { headers: NO_STORE });
        },
      });

      /**
       * The in-host register repair (G2, panel path).
       *
       * Preference order matters and is stated in the response:
       *
       *   1. **`ctx.workspaceRegistry`** -- the Harness's own workspace service. It persists the domain, mutates
       *      memory and emits `domain/changed`, and the GUI reads that projection; there is no file write for a
       *      later client save to clobber, so this path has no watch and `residual_risk: null`.
       *   2. **file-level G2** -- only for a profile that exposes no service (or the offline CLI). The client gate
       *      is told `allowLiveHome: true` because the host is by definition live, and the bounded watch (capped at
       *      {@link DEFAULT_ROUTE_WATCH_CAP_MS}) is the protocol instead. The response says `via: 'file-write'` and
       *      repeats the residual risk; it never silently pretends the race was removed.
       */
      const watchRegister = typeof deps.registerWatch === 'function'
        ? deps.registerWatch
        : (args) => sampleWatchSchedule({
            ...args,
            wait: (ms) => new Promise((resolve) => {
              setTimeout(resolve, ms);
            }),
            now: () => Date.now(),
          });
      const hostWorkspaceRegistry = () => {
        try {
          return typeof ctx?.get === 'function' ? (ctx.get('workspaceRegistry') ?? null) : null;
        } catch {
          return null;
        }
      };
      registry.register({
        path: BACKUP_REGISTER_ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
          const body = await readBody(request);
          if (body === null || body.confirm !== REGISTER_CONFIRM_TOKEN) {
            return refuse('BACKUP_CONFIRM_REQUIRED', `a JSON body with {"confirm":"${REGISTER_CONFIRM_TOKEN}"} is required`);
          }
          const sessionIds = Array.isArray(body.session_ids)
            ? body.session_ids.map((value) => String(value ?? '')).filter((value) => value !== '')
            : [];
          if (sessionIds.length === 0) {
            return refuse('BACKUP_REGISTER_NO_SESSION', 'session_ids must name at least one session that exists on disk');
          }
          const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : null;
          // 1) The host service: no file write, so no file-level race to watch.
          const hostOutcome = await registerThroughHost({
            dshHome: cfg.dsh_home,
            sessionIds,
            workspacePath,
            workspaceRegistry: hostWorkspaceRegistry(),
            now: new Date(),
          });
          if (hostOutcome.reason_code !== REGISTER_CODES.HOST_UNAVAILABLE) {
            state.last_register = {
              at: new Date().toISOString(),
              via: hostOutcome.via,
              ok: hostOutcome.ok,
              changed: hostOutcome.changed,
              registered: hostOutcome.registered,
              already_registered: hostOutcome.already_registered,
              failed: hostOutcome.failed,
            };
            return Response.json(hostOutcome, { headers: NO_STORE });
          }
          // 2) File-level G2 for a host without the service: plan, apply, bounded watch, residual risk said out loud.
          const plan = planRegister({
            dshHome: cfg.dsh_home,
            sessionIds,
            workspacePath,
            // Inside the host the client is running by definition: the gate's pause half cannot apply here. The
            // watch below is the half that can, and it is bounded.
            allowLiveHome: true,
            now: new Date(),
          });
          if (plan.ok !== true) {
            state.last_register = { at: new Date().toISOString(), ok: false, reason_code: plan.reason_code, detail: plan.detail };
            return Response.json(plan, { headers: NO_STORE });
          }
          const applied = applyRegister({ dshHome: cfg.dsh_home, plan });
          applied.via = 'file-write';
          applied.host_service = false;
          if (applied.ok === true && applied.changed === true) {
            applied.watch = await watchRegister({
              dshHome: cfg.dsh_home,
              plan: plan.registry,
              minutes: DEFAULT_ROUTE_WATCH_CAP_MS / 60_000,
              budgetMs: DEFAULT_ROUTE_WATCH_CAP_MS,
            });
          }
          applied.residual_risk = REGISTER_RESIDUAL_RISK_LINE;
          state.last_register = {
            at: new Date().toISOString(),
            via: applied.via,
            ok: applied.ok,
            changed: applied.changed,
            registered: applied.registered,
            already_registered: applied.already_registered,
            watch: applied.watch ?? null,
          };
          return Response.json(applied, { headers: NO_STORE });
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
