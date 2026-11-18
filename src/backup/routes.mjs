/**
 * Read-only backup routes: `/api/w2m/backup/status` and `/api/w2m/backup/scan`.
 *
 * ## Why these two exist in v3.4.6 and the write routes do not
 *
 * The panel that will call them (v3.4.9) must be able to answer "is a repository configured, where is it, does
 * it exist, how much would a backup copy" **before** any code is allowed to write. Keeping that answer on the
 * host (rather than in the browser) means the path and the counts are resolved by the same modules the CLI and
 * the future engine use.
 *
 * Nothing here writes: no `mkdir`, no descriptor, no scan side effects. `ensureLayout` is deliberately not
 * called -- `status` answers "not initialised yet" instead of initialising, because a status card that creates
 * a repository on a drive the operator did not mean to use is a worse failure than a card that says "未初始化".
 *
 * ## Refusal shape
 *
 * The house shape, same as every other W2M route: HTTP status + `{ok:false, reason_code, detail}` where
 * `reason_code` is a stable code from `layout.mjs` / `crypto.mjs`, never a sentence a client has to parse.
 */

import os from 'node:os';
import path from 'node:path';

import { inspectLayout, resolveBackupDir, LAYOUT_CODES, BackupLayoutError } from './layout.mjs';
import { openRepo } from './repo.mjs';
import { DEFAULT_OLD_USAGE_REMINDER_BYTES, buildOldUsageReport, measureOldUsage } from './rotation.mjs';
import { readBackupState } from './runtime-verdict.mjs';
import { scanHome, summarize } from './scan.mjs';
import { UNENCRYPTED_WARNING, availablePaths, keysEncryption, passwordHintState, readRepoKeys } from './keystore.mjs';

/** Path of the read-only status route. */
export const BACKUP_STATUS_ROUTE_PATH = '/api/w2m/backup/status';

/** Path of the read-only scan route. */
export const BACKUP_SCAN_ROUTE_PATH = '/api/w2m/backup/scan';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * `$DSH_HOME`, then `~/.dsh`. Same precedence as every other W2M entry point, kept local so this module does
 * not have to import a subplugin just for a path.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return explicit !== '' ? path.resolve(explicit) : path.join(os.homedir(), '.dsh');
}

/** The schedule shape the status card shows. The engine ships in v3.4.7 behind the `dsh-backup` row. */
export const DEFAULT_SCHEDULE = Object.freeze({
  enabled: false,
  times: ['22:00:00'],
  time_zone: 'Asia/Shanghai',
  implemented: true,
  engine: 'v3.4.7',
  note: 'a schedule is armed only while the dsh-backup subplugin row is mounted and enabled; until then the default is documented, not running',
});

/**
 * Build the status payload. Pure read: no filesystem writes, no repository initialisation.
 *
 * @param {{backupDir?: string|null, dshHome?: string|null, env?: Record<string, string|undefined>}} [options]
 * @returns {object}
 */
export function buildStatus(options = {}) {
  const env = options.env ?? process.env;
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? path.resolve(options.dshHome) : resolveDshHome(env);
  let backupDir;
  try {
    backupDir = resolveBackupDir({ explicit: options.backupDir ?? null, env, dshHome });
  } catch (error) {
    const refusal = error instanceof BackupLayoutError ? error.toRefusal() : { ok: false, reason_code: LAYOUT_CODES.UNRESOLVED, detail: String(error?.message ?? error) };
    return { ok: false, ...refusal, dsh_home: dshHome, checked_at: new Date().toISOString() };
  }
  const inspected = inspectLayout(backupDir, { dshHome });
  // The status card answers "how protected is this repository" with facts the key document carries. This is a
  // read-only read: `readRepoKeys` validates structurally and never touches a credential, and an unencrypted
  // repository is reported as such (with the honest warning) rather than hidden.
  const keys = readRepoKeys(backupDir);
  const encryption = keys.ok === true ? keysEncryption(keys.keys) : inspected.encryption;
  const available = keys.ok === true ? availablePaths(keys.keys) : [];
  // The PUBLIC "备注提示词" that may accompany a PIN (docs/BACKUP-DESIGN.md §25.5): plain text by design, shown by
  // the status and unlock payloads so an operator can be reminded of the PIN. It never contains the PIN itself.
  const passwordHint = passwordHintState(keys.ok === true ? keys.keys : null);
  const warning = encryption === 'none' ? UNENCRYPTED_WARNING : null;
  // An initialised repository additionally reports its snapshots and index health; an absent or empty one does
  // not get opened, because openRepo would only restate "not initialised" and the cheap inspection already knows.
  const repoState = inspected.error === null && inspected.initialized ? openRepo({ root: backupDir, dshHome }) : null;
  const repository = {
    ...inspected,
    ...(repoState === null
      ? {}
      : {
          snapshots: repoState.snapshots.length,
          latest:
            repoState.latest === null || repoState.latest.valid !== true
              ? null
              : {
                  snapshot_id: repoState.latest.snapshot_id,
                  created_at: repoState.latest.manifest?.created_at ?? null,
                  files: repoState.latest.manifest?.files ?? 0,
                  sessions: repoState.latest.manifest?.sessions ?? 0,
                  bytes: repoState.latest.manifest?.session_bytes ?? 0,
                  digest: repoState.latest.digest,
        // P0/P3: per-scope file counts of the latest snapshot; the panel renders them next to the scope list.
        counts_by_scope: repoState.latest.manifest?.counts_by_scope ?? null,
                },
          index: repoState.index,
        }),
    ...(repoState === null || repoState.ok ? {} : { repo_error: repoState.error }),
  };
  const ok = inspected.error === null && (repoState === null || repoState.ok);
  // The `old/` usage reminder (v3.5.0, §24.3). `old/` has no total cap by decision, so the status card answers two
  // read-only questions: how big the tree is on disk **now** (one walk -- deliberately the current size, not the
  // size the last run saw), and whether a growth reminder is pending. The acknowledgement mark and the last reminder
  // record come from the plugin's persisted state (`<DSH_HOME>/xclient/w2m-backup/state.json`); a missing state file
  // is a normal first run and the documented 10 GiB default is used. Nothing here writes or deletes.
  const persistedState = readBackupState(dshHome).state;
  const persistedUsage = persistedState.old_usage !== null && typeof persistedState.old_usage === 'object'
    ? persistedState.old_usage
    : null;
  const ackBytes = Number.isSafeInteger(persistedState.old_usage_ack_bytes) && persistedState.old_usage_ack_bytes >= 0
    ? persistedState.old_usage_ack_bytes
    : (Number.isSafeInteger(persistedUsage?.ack_bytes) && persistedUsage.ack_bytes >= 0 ? persistedUsage.ack_bytes : 0);
  const reminderBytes = Number.isSafeInteger(persistedUsage?.reminder_bytes) && persistedUsage.reminder_bytes >= 0
    ? persistedUsage.reminder_bytes
    : DEFAULT_OLD_USAGE_REMINDER_BYTES;
  const measuredOld = measureOldUsage(backupDir);
  const oldUsageReport = buildOldUsageReport({ ...measuredOld, ackBytes, reminderBytes });
  const oldUsage = {
    ...oldUsageReport,
    // The report's `due` and this `pending` are the same decision: a reminder is pending exactly when it is due.
    // Both names exist because the engine's result speaks `due` and the status card speaks "pending".
    ack_bytes: ackBytes,
    pending: oldUsageReport.due,
    last_measured_at: typeof persistedUsage?.at === 'string' ? persistedUsage.at : null,
  };
  return {
    ok,
    checked_at: new Date().toISOString(),
    dsh_home: dshHome,
    repository,
    encryption,
    available_paths: available,
    password_hint: passwordHint,
    warning,
    old_usage: oldUsage,
    // v3.5.1: a missed slot detected at mount is recorded (never run from the mount path by default). The card,
    // the CLI status and the panel read the same persisted record; an explicit run clears it.
    pending_catch_up: persistedState.pending_catch_up !== null && typeof persistedState.pending_catch_up === 'object'
      ? persistedState.pending_catch_up
      : null,
    schedule: { ...DEFAULT_SCHEDULE },
    read_only: true,
    ...(inspected.error === null ? {} : { reason_code: inspected.error.code, detail: inspected.error.detail }),
  };
}

/**
 * Build the scan payload.
 *
 * @param {{dshHome?: string|null, detail?: boolean, hash?: boolean, deep?: boolean,
 *   env?: Record<string, string|undefined>, scan?: typeof scanHome}} [options]
 * @returns {object}
 */
export function buildScan(options = {}) {
  const env = options.env ?? process.env;
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? path.resolve(options.dshHome) : resolveDshHome(env);
  const run = typeof options.scan === 'function' ? options.scan : scanHome;
  const scan = run({ dshHome, hash: options.hash === true, deep: options.deep === true });
  const payload = {
    ok: true,
    read_only: true,
    scanned_at: scan.scanned_at,
    dsh_home: scan.dsh_home,
    exists: scan.exists,
    zstd: scan.zstd,
    totals: scan.totals ?? summarize(scan),
    registry: {
      ok: scan.registry?.ok === true,
      workspaces: scan.registry?.workspaces?.length ?? 0,
      registered: scan.registry?.registered?.size ?? 0,
      archived: scan.registry?.archived?.size ?? 0,
      pinned: scan.registry?.pinned?.size ?? 0,
    },
    exclusions: scan.exclusions ?? [],
  };
  if (options.detail === true) {
    payload.sessions = (scan.sessions ?? []).map((row) => ({
      session_id: row.session_id,
      workspace: row.workspace,
      rel: row.rel,
      size: row.size,
      mtime_ms: row.mtime_ms,
      format_version: row.format_version,
      ok: row.ok,
      codes: row.codes,
      flags: row.flags,
      ...(row.events === undefined ? {} : { events: row.events }),
    }));
    payload.attachments = (scan.attachments ?? []).map((row) => ({
      attachment_id: row.attachment_id,
      rel: row.rel,
      size: row.size,
      ok: row.ok,
    }));
  }
  return payload;
}

/**
 * Mount both routes on the host's Connection fetch registry.
 *
 * @param {object} ctx Cordis context
 * @param {{dshHome?: () => (string|null), backupDir?: () => (string|null|null), env?: Record<string,string|undefined>,
 *   scan?: typeof scanHome}} [deps]
 * @returns {{mounted: boolean, reason: string|null, paths: string[]}}
 */
export function registerBackupRoutes(ctx, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service', paths: [BACKUP_STATUS_ROUTE_PATH, BACKUP_SCAN_ROUTE_PATH] };
  if (typeof ctx?.inject !== 'function') return status;
  const resolve = (fn) => (typeof fn === 'function' ? fn() : null);
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    registry.register({
      path: BACKUP_STATUS_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'GET') {
          return Response.json({ ok: false, reason_code: 'METHOD_NOT_ALLOWED', detail: `${request.method} is not a method this route answers` }, { status: 405, headers: NO_STORE });
        }
        const payload = buildStatus({ backupDir: resolve(deps.backupDir), dshHome: resolve(deps.dshHome), env: deps.env });
        // 200 even when `ok:false`: "not configured yet" and "the drive is missing" are STATES the panel
        // renders, not transport failures, and a 4xx/5xx here would show as a broken panel instead of a原因.
        return Response.json(payload, { status: 200, headers: NO_STORE });
      },
    });
    registry.register({
      path: BACKUP_SCAN_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'GET') {
          return Response.json({ ok: false, reason_code: 'METHOD_NOT_ALLOWED', detail: `${request.method} is not a method this route answers` }, { status: 405, headers: NO_STORE });
        }
        let url;
        try {
          url = new URL(request.url ?? `http://local.invalid${BACKUP_SCAN_ROUTE_PATH}`);
        } catch {
          return Response.json({ ok: false, reason_code: 'URL_INVALID', detail: 'the request URL could not be parsed' }, { status: 400, headers: NO_STORE });
        }
        const detail = url.searchParams.get('detail') === '1' || url.searchParams.get('detail') === 'true';
        try {
          const payload = buildScan({ dshHome: resolve(deps.dshHome), detail, env: deps.env, scan: deps.scan });
          return Response.json(payload, { headers: NO_STORE });
        } catch (error) {
          const code = error?.code ?? 'BACKUP_SCAN_FAILED';
          return Response.json({ ok: false, reason_code: code, detail: error?.detail ?? String(error?.message ?? error) }, { status: 500, headers: NO_STORE });
        }
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}
