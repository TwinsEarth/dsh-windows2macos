/**
 * Gate G2's first-class **register** path: make sessions that are already on disk visible to the client.
 *
 * ## The failure this replaces
 *
 * The 2026-11-17 recovery drill ended with a session file sitting in `sessions/` and no registry entry, so the UI
 * did not list it. The repair was an ad-hoc script that copied `workspace.json`, added the session id and wrote the
 * document back. That script had two defects the drill only found afterwards:
 *
 *   1. it wrote the registry without the G2 protocol (no client gate, no read-back, no post-save re-check), so the
 *      running client's next save could silently replace the entry -- the exact R1 failure G2 exists for;
 *   2. it rebuilt the archived/pinned flags from defaults (`archived: false`), so registering a *registered and
 *      archived* session **unarchived** it. The flags are client-owned state: a writer that is not changing them
 *      must read them and pass them through, never invent them.
 *
 * ## The pipeline (one plan, then one apply)
 *
 *   resolve every `--session` on disk (the same walker the doctor uses)
 *   -> G2 half one: refuse while the client runs, unless `allowLiveHome`
 *   -> read the registry view to compute the flags the session already has (never default them to false)
 *   -> copy `workspace.json` to `<DSH_HOME>/.w2m-restore-backups/register-<ts>/workspace.json`
 *   -> plan the whole document once (`planRegistryRestores`)
 *   -> atomic write + read-back verification (`applyRegistryRestore`)
 *   -> optional post-save re-check (`recheckRegistry`, the CLI's `--registry-recheck`)
 *
 * A session that is already registered is a **no-op for that id**: it is reported as `already_registered` and left
 * out of the plan, so its current archived/pinned state cannot be touched at all.
 *
 * ## What this module deliberately does not do
 *
 * It does not create sessions (there is nothing to register), it does not edit session bytes, and it does not add a
 * host route: registering a home is an operator action with a home path, i.e. the offline CLI's job. The panel path
 * is untouched because the client is by definition live there (G2's other two halves cover it).
 *
 * ## The in-host path: `workspaceRegistry` (added after the service was found)
 *
 * The installed Harness exposes `ctx.workspaceRegistry` (`@deepseek-ai/dsh-workspace`), a Cordis service that owns
 * both the in-memory workspace domain and `storages/workspace.json`; the GUI reads the domain projection. A plugin
 * that can reach it should use {@link registerThroughHost} instead of writing the file: `attachSession` persists
 * first, mutates memory and emits `domain/changed`, so there is no "client save" left to clobber the edit. That is
 * why the plugin route prefers it, and why the file path (+ its bounded watch) is kept for the offline CLI and for
 * a profile that hides the service -- where the route says `via: 'file-write'` and repeats the residual risk
 * instead of pretending the race does not exist.
 *
 * The service validates `attachSession` against the session's **header cwd**, which is why the in-host path now
 * reads that header itself: a folder that was moved or renamed after the session was written still has a header
 * naming the directory it ran in, and the session is attached there (`cwd_fallback`) rather than refused. Only a
 * header cwd that is missing or no longer resolves falls back to the offline CLI + bounded watch, and that
 * refusal states the residual window.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { clientGate } from './client.mjs';
import { applyRegistryRestore, CLIENT_OVERWRITE_WARNING, findWorkspaceForSlug, planRegistryRestores, workspaceRegistryPath } from './registry.mjs';
import { REGISTER_RESIDUAL_RISK_LINE } from './register-watch.mjs';
import { preRestoreRoot } from './restore.mjs';
import { readSessionHeader } from './scan.mjs';
import { listSessionDirs, pickSessionFile } from '../fix/session.mjs';
import { readWorkspaceRegistry } from '../util/dsh-workspace.mjs';

/** Named register refusals. */
export const REGISTER_CODES = Object.freeze({
  /** No session ids were supplied: there is nothing to register. */
  NO_SESSION: 'BACKUP_REGISTER_NO_SESSION',
  /** A requested session id has no directory under `sessions/` in this home. */
  SESSION_MISSING: 'BACKUP_REGISTER_SESSION_MISSING',
  /** The registry copy that is the way back could not be written; nothing was changed. */
  BACKUP_FAILED: 'BACKUP_REGISTER_BACKUP_FAILED',
  /** The in-host path was asked for but this profile exposes no `workspaceRegistry` service. */
  HOST_UNAVAILABLE: 'BACKUP_REGISTER_HOST_UNAVAILABLE',
  /** No workspace — from the caller, the registry view, or the session's own header cwd — can hold a session. */
  HOST_WORKSPACE_UNKNOWN: 'BACKUP_REGISTER_HOST_WORKSPACE_UNKNOWN',
  /**
   * The host workspace service refused `attachSession` for a session: the service's own validation, or the
   * session's header cwd is missing/does not resolve so no host workspace may accept it.
   */
  HOST_ATTACH_FAILED: 'BACKUP_REGISTER_HOST_ATTACH_FAILED',
});

/** How many `register-<ts>` registry copies are kept by default (0 = keep all). */
export const DEFAULT_KEEP_REGISTER_BACKUPS = 10;

/** Compact, sortable timestamp used in directory names: `20261117T152201Z`. */
function compactStamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** `register-<compact timestamp>` under the pre-restore root; the name sorts after the restore timestamps. */
function registerDirName(now) {
  return `register-${compactStamp(now)}`;
}

/** A named refusal in the shape both plan and apply return. */
function refusal(reason_code, detail, extra = {}) {
  return {
    ok: false,
    reason_code,
    detail,
    dsh_home: null,
    workspace_path: null,
    requested: [],
    sessions: [],
    registered: [],
    already_registered: [],
    unknown: [],
    registry: null,
    actions: [],
    changed: false,
    backup_file: null,
    keep_pre_restore: DEFAULT_KEEP_REGISTER_BACKUPS,
    pruned_register_backups: null,
    verified: false,
    warning: null,
    ...extra,
  };
}

/**
 * Every on-disk session of a home, keyed by its session id.
 *
 * The walker (`listSessionDirs`) is the same one the doctor and the backup scanner use, so "exists on disk" means
 * exactly the same thing to register as it does to the backup that must capture it. The workspace slug is the
 * directory segment the client used (`sessions/--E-GPT--/<id>/` -> `--E-GPT--`).
 *
 * @param {string} dshHome
 * @returns {Map<string, {session_id: string, workspace: string, dir: string}>}
 */
export function indexSessionsOnDisk(dshHome) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  const byId = new Map();
  for (const dir of listSessionDirs(sessionsRoot)) {
    const parts = path.relative(sessionsRoot, dir).split(path.sep).filter((part) => part !== '');
    // `sessions/<workspace>/<session-id>` is the layout; anything shallower is a malformed home, not a workspace.
    if (parts.length < 2) continue;
    const sessionId = parts[parts.length - 1];
    const workspace = parts[parts.length - 2];
    if (sessionId === '' || workspace === '') continue;
    if (!byId.has(sessionId)) byId.set(sessionId, { session_id: sessionId, workspace, dir });
  }
  return byId;
}

/**
 * List this home's register copies of `workspace.json`, newest first by name (names are sortable timestamps).
 *
 * @param {string} dshHome
 * @returns {Array<{name: string, dir: string}>}
 */
export function listRegisterBackups(dshHome) {
  const root = preRestoreRoot(dshHome);
  let names = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^register-\d{8}T\d{6}Z$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.sort().reverse().map((name) => ({ name, dir: path.join(root, name) }));
}

/**
 * Keep only the newest `keep` register copies; `0` keeps all, and the copy of the current run is never deleted.
 *
 * The current run's copy is passed as `protect`: a clock that moved between plan and prune (or another writer's
 * newer timestamp) must not turn "register" into "delete the way back". An undeletable old copy is harmless and
 * stays listed rather than failing the register.
 *
 * @param {{dshHome: string, keep?: number, protect?: string|null, dryRun?: boolean}} input
 * @returns {{ok: boolean, keep: number, dry_run: boolean, scanned: number, kept: string[],
 *   removed: string[], removed_count: number, protected: string|null}}
 */
export function pruneRegisterBackups(input) {
  const keep = Number.isSafeInteger(input.keep) && input.keep >= 0 ? input.keep : DEFAULT_KEEP_REGISTER_BACKUPS;
  const dryRun = input.dryRun === true;
  const protectedPath = typeof input.protect === 'string' && input.protect !== '' ? path.resolve(input.protect) : null;
  const backups = listRegisterBackups(input.dshHome);
  const kept = [];
  const removed = [];
  if (keep === 0) {
    return { ok: true, keep: 0, dry_run: dryRun, scanned: backups.length, kept: backups.map((row) => row.name), removed: [], removed_count: 0, protected: protectedPath };
  }
  const keepPaths = new Set(backups.slice(0, keep).map((row) => path.resolve(row.dir)));
  if (protectedPath !== null) keepPaths.add(path.dirname(protectedPath));
  for (const backup of backups) {
    if (keepPaths.has(path.resolve(backup.dir))) {
      kept.push(backup.name);
      continue;
    }
    if (dryRun) {
      removed.push(backup.name);
      continue;
    }
    try {
      fs.rmSync(backup.dir, { recursive: true, force: true });
      removed.push(backup.name);
    } catch {
      // An undeletable old copy is harmless; it stays visible in the list.
      kept.push(backup.name);
    }
  }
  return { ok: true, keep, dry_run: dryRun, scanned: backups.length, kept, removed, removed_count: removed.length, protected: protectedPath };
}

/**
 * Plan a register run: resolve the sessions on disk, run G2's client gate, compute the flags the registry already
 * holds, and plan **one** registry document for every new id. No write happens here.
 *
 * `already_registered` ids are left out of the plan entirely. That is the defence against the drill's second bug:
 * there is no code path that could write a default `archived: false` over a state the client owns.
 *
 * @param {{
 *   dshHome: string, sessionIds: string[], workspacePath?: string|null, allowLiveHome?: boolean,
 *   clientCheck?: Function, keepPreRestoreBackups?: number, now?: Date, platform?: string, runner?: Function,
 * }} input
 * @returns {object} a plan -- `ok:false` carries `reason_code`/`detail`; nothing was written either way
 */
export function planRegister(input = {}) {
  const dshHome = typeof input.dshHome === 'string' && input.dshHome.trim() !== '' ? path.resolve(input.dshHome) : null;
  const requested = [...new Set((Array.isArray(input.sessionIds) ? input.sessionIds : []).map((value) => String(value ?? '')).filter((value) => value !== ''))];
  const now = input.now instanceof Date ? input.now : new Date();
  const workspacePath = typeof input.workspacePath === 'string' && input.workspacePath.trim() !== '' ? path.resolve(input.workspacePath.trim()) : null;
  const keepPreRestore = Number.isSafeInteger(input.keepPreRestoreBackups) && input.keepPreRestoreBackups >= 0
    ? input.keepPreRestoreBackups
    : DEFAULT_KEEP_REGISTER_BACKUPS;
  if (dshHome === null) {
    return refusal(REGISTER_CODES.NO_SESSION, 'planRegister needs a dshHome', { requested });
  }
  if (requested.length === 0) {
    return refusal(REGISTER_CODES.NO_SESSION, 'register needs at least one session id (--session <id>, repeatable)', { dsh_home: dshHome, workspace_path: workspacePath });
  }

  // G2 half one, first: a home whose client is running is a home whose registry is about to be saved over. The
  // refusal exists so the operator can quit the client and rerun; --allow-live-home accepts the read-back +
  // post-save re-check protocol instead (and the caller should then pass --registry-recheck).
  const gateRequested = typeof input.clientCheck === 'function' || input.allowLiveHome === false;
  if (gateRequested) {
    const gate = clientGate({
      allowLiveHome: input.allowLiveHome === true,
      check: typeof input.clientCheck === 'function' ? input.clientCheck : undefined,
      platform: input.platform,
      runner: input.runner,
    });
    if (gate.ok !== true) {
      return refusal(gate.reason_code, gate.detail, { dsh_home: dshHome, workspace_path: workspacePath, requested, client: gate.detection ?? null });
    }
  }

  const onDisk = indexSessionsOnDisk(dshHome);
  const unknown = requested.filter((sessionId) => !onDisk.has(sessionId));
  if (unknown.length > 0) {
    return refusal(
      REGISTER_CODES.SESSION_MISSING,
      `no session directory under ${path.join(dshHome, 'sessions')} for: ${unknown.join(', ')}; register only makes an on-disk session visible, it does not create one`,
      { dsh_home: dshHome, workspace_path: workspacePath, requested, unknown },
    );
  }

  // The registry view is the only source of the flags: a writer that is not changing archived/pinned must quote
  // the current values, and defaulting them is exactly the bug this path exists to not repeat.
  const view = readWorkspaceRegistry(dshHome);
  const sessions = requested.map((sessionId) => {
    const row = onDisk.get(sessionId);
    return {
      session_id: sessionId,
      workspace: row.workspace,
      dir: row.dir,
      archived: view.archived.has(sessionId),
      pinned: view.pinned.has(sessionId),
      status: view.ok === true && view.registered.has(sessionId) ? 'already_registered' : 'new',
    };
  });
  const alreadyRegistered = sessions.filter((session) => session.status === 'already_registered').map((session) => session.session_id);
  const fresh = sessions.filter((session) => session.status === 'new');
  const registryFile = workspaceRegistryPath(dshHome);
  const backupFile = fs.existsSync(registryFile)
    ? path.join(preRestoreRoot(dshHome), registerDirName(now), 'workspace.json')
    : null;
  const common = { dsh_home: dshHome, workspace_path: workspacePath, requested, sessions, already_registered: alreadyRegistered, keep_pre_restore: keepPreRestore, backup_file: backupFile };

  // Everything requested is already registered: a successful no-op that writes nothing (not even a copy).
  if (fresh.length === 0) {
    return { ...refusal(null, null, { ...common, backup_file: null }), ok: true, changed: false, verified: true };
  }

  const registry = planRegistryRestores({
    dshHome,
    sessions: fresh.map((session) => ({ session_id: session.session_id, workspace: session.workspace, archived: session.archived, pinned: session.pinned })),
    workspacePath,
    // Registering into a home with no registry at all is the disaster-recovery case; like restore, it is only
    // allowed when the operator named a directory (an id is not a workspace path).
    allowCreateRegistry: true,
  });
  if (registry.ok !== true) {
    return { ...refusal(registry.reason_code ?? 'BACKUP_REGISTRY_UNREADABLE', registry.detail, common), registry };
  }

  return {
    ...refusal(null, null, common),
    ok: true,
    registry,
    registered: fresh.map((session) => session.session_id),
    actions: registry.actions,
    changed: registry.changed === true,
    verified: false,
    created_workspaces: registry.created_workspaces ?? [],
  };
}

/**
 * Apply a register plan: copy the registry document first (the way back), then write the planned document
 * atomically and verify it by reading it back.
 *
 * A no-op plan (`changed:false`) writes nothing -- not even the copy -- and reports `verified:true`, because there
 * was nothing to promise the registry did not already hold.
 *
 * @param {{dshHome?: string, plan: object, keepPreRestoreBackups?: number, now?: Date}} input
 * @returns {{
 *   ok: boolean, reason_code: string|null, detail: string|null, dsh_home: string|null,
 *   registered: string[], already_registered: string[], unknown: string[], actions: string[],
 *   verified: boolean, backup_file: string|null, changed: boolean,
 *   pruned_register_backups: object|null, warning: string|null,
 * }}
 */
export function applyRegister(input = {}) {
  const plan = input.plan;
  const dshHome = typeof input.dshHome === 'string' && input.dshHome.trim() !== '' ? path.resolve(input.dshHome) : (plan?.dsh_home ?? null);
  const keepPreRestore = Number.isSafeInteger(input.keepPreRestoreBackups) && input.keepPreRestoreBackups >= 0
    ? input.keepPreRestoreBackups
    : (Number.isSafeInteger(plan?.keep_pre_restore) ? plan.keep_pre_restore : DEFAULT_KEEP_REGISTER_BACKUPS);
  const base = {
    ok: false,
    reason_code: plan?.reason_code ?? null,
    detail: plan?.detail ?? 'there is no successful register plan to apply',
    dsh_home: dshHome,
    registered: [],
    already_registered: plan?.already_registered ?? [],
    unknown: plan?.unknown ?? [],
    actions: [],
    verified: false,
    backup_file: null,
    changed: false,
    pruned_register_backups: null,
    warning: null,
  };
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) return base;
  if (dshHome === null) return { ...base, reason_code: REGISTER_CODES.NO_SESSION, detail: 'applyRegister needs a dshHome' };
  if (plan.changed !== true) {
    return {
      ...base,
      ok: true,
      verified: true,
      registered: plan.registered ?? [],
      changed: false,
      detail: 'already registered; nothing was written',
    };
  }

  // The pre-restore copy first: after this point every file the plan changes has a way back. A failed copy with
  // the registry still untouched is a refusal, not a half-written register.
  let backupFile = null;
  if (typeof plan.backup_file === 'string' && plan.backup_file !== '') {
    backupFile = plan.backup_file;
    try {
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.copyFileSync(workspaceRegistryPath(dshHome), backupFile);
    } catch (error) {
      return {
        ...base,
        reason_code: REGISTER_CODES.BACKUP_FAILED,
        detail: `could not copy ${workspaceRegistryPath(dshHome)} to ${backupFile}: ${error?.message ?? error}; nothing was written`,
        backup_file: backupFile,
      };
    }
  }

  const applied = applyRegistryRestore({ dshHome, plan: plan.registry });
  if (applied.ok !== true) {
    return {
      ...base,
      reason_code: applied.reason_code ?? 'BACKUP_REGISTRY_WRITE_FAILED',
      detail: applied.detail,
      actions: applied.actions ?? [],
      backup_file: backupFile,
    };
  }

  // Only a successful, verified write prunes: a failed register keeps every copy, because the newest one is the
  // state the operator needs to compare against.
  const pruned = pruneRegisterBackups({ dshHome, keep: keepPreRestore, protect: backupFile });
  return {
    ...base,
    ok: true,
    detail: null,
    registered: plan.registered ?? [],
    actions: applied.actions ?? [],
    verified: applied.verified === true,
    backup_file: backupFile,
    changed: true,
    pruned_register_backups: pruned,
    warning: CLIENT_OVERWRITE_WARNING,
  };
}

/** Does this object look like the host's `WorkspaceRegistry` service? */
function usableWorkspaceRegistry(candidate) {
  if (candidate === null || candidate === undefined || typeof candidate !== 'object') return false;
  return typeof candidate.resolveByPath === 'function' || typeof candidate.create === 'function';
}

/**
 * The one next step when the in-host service cannot attach a session: the file-level G2 path, whose bounded watch
 * is the part of the protocol the host route cannot provide for a cwd that no longer exists.
 */
export const HOST_ATTACH_ADVICE =
  'run the offline CLI `w2m-backup register --session … --watch <minutes>` with the client stopped when possible; ' +
  'the watch re-applies on clobber';

/**
 * The canonical path of an existing directory, or `null`.
 *
 * The installed `attachSession` validates a session by realpathing its header cwd and comparing that canonical
 * string with the workspace's stored path. The fallback uses **the same** fact for the same reason: a lexical
 * comparison would attach a session to a directory the service then refuses, and a weaker one would attach it to
 * the wrong real path.
 *
 * @param {string|null|undefined} candidate
 * @returns {string|null}
 */
function realDirectoryOrNull(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return null;
  try {
    const real = fs.realpathSync(path.resolve(candidate.trim()));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * A display title for a workspace created from a session's own header cwd: the sanitized final segment plus a short
 * stable id derived from the canonical path, so two directories with the same basename do not read as one project.
 *
 * @param {string} realCwd
 * @returns {string}
 */
function workspaceTitleForCwd(realCwd) {
  const base = path.basename(realCwd).replace(/[^\p{L}\p{N}._ -]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 40);
  const shortId = createHash('sha256').update(realCwd).digest('hex').slice(0, 8);
  return `${base || 'workspace'} ${shortId}`;
}

/**
 * The cwd a session's own log header declares, resolved through the filesystem.
 *
 * This is the fact the installed `attachSession` validates: it reads the header, realpaths `cwd`, and refuses when
 * the result is not the workspace's own path. Reading the same header here is what lets a moved folder be attached
 * to the directory the session actually ran in instead of the folder that replaced it.
 *
 * `problem: 'missing'` means the header is readable but carries no cwd; `'unresolvable'` means the cwd string is
 * known but no longer resolves to an existing directory; `'unreadable'` means the log/header itself could not be
 * read (no zstd support, a torn first frame, no session log). The first two are facts about the session; the third
 * is a fact about this reader, so a caller must not treat it as "the cwd is gone".
 *
 * @param {string} sessionDir
 * @returns {{cwd: string|null, real_cwd: string|null, problem: 'missing'|'unresolvable'|'unreadable'|null,
 *   detail: string|null}}
 */
function readSessionCwd(sessionDir) {
  let file = null;
  try {
    file = pickSessionFile(sessionDir);
  } catch (error) {
    return { cwd: null, real_cwd: null, problem: 'unreadable', detail: `the session directory could not be read: ${error?.message ?? error}` };
  }
  if (file === null) return { cwd: null, real_cwd: null, problem: 'unreadable', detail: 'the session directory holds no session.vN.jsonl.zstd log' };
  const header = readSessionHeader(file);
  if (header.ok !== true) return { cwd: null, real_cwd: null, problem: 'unreadable', detail: header.detail };
  const cwd = typeof header.header.cwd === 'string' && header.header.cwd.trim() !== '' ? header.header.cwd.trim() : null;
  if (cwd === null) return { cwd: null, real_cwd: null, problem: 'missing', detail: 'the session header carries no cwd' };
  const real = realDirectoryOrNull(cwd);
  if (real === null) {
    return { cwd, real_cwd: null, problem: 'unresolvable', detail: `the header cwd '${cwd}' does not resolve to an existing directory` };
  }
  return { cwd, real_cwd: real, problem: null, detail: null };
}

/** One failed session's `detail`: the id, the reason (which names its cwd string), and the offline CLI advice. */
function hostAttachFailureDetail(sessionId, reason) {
  return `session ${sessionId} could not be attached through the host workspace service: ${reason}. ${HOST_ATTACH_ADVICE}`;
}

/** The result `detail` for a failed host-service register: every refused session, then the next step. */
function hostRefusalDetail(failures, total) {
  const rows = failures.map((row) => {
    const cwd = typeof row.header_cwd === 'string' && row.header_cwd !== '' ? `header cwd '${row.header_cwd}'` : 'header cwd unknown';
    return `${row.session_id} (${cwd}${typeof row.cause === 'string' && row.cause !== '' ? `: ${row.cause}` : ''})`;
  });
  return `the host workspace service refused ${failures.length} of ${total} session(s): ${rows.join('; ')}. ${HOST_ATTACH_ADVICE}`;
}

/**
 * Register on-disk sessions **through the host's `workspaceRegistry` service** instead of writing the file.
 *
 * This is the in-host path: the service persists the domain before mutating memory and emits `domain/changed`, so
 * the GUI projection and `storages/workspace.json` move together. There is no file-level race to watch, which is
 * exactly why the plugin route prefers it; a session the service refuses (its `attachSession` validates that the
 * session is known to `sessionPersistence` and that the header cwd realpaths to the workspace's own path) is
 * reported with a named refusal rather than silently falling back to a file write.
 *
 * ## The moved-folder case
 *
 * `attachSession` compares the session's **header cwd** with the workspace path, so a home whose folder was moved
 * or renamed after the session was written cannot be registered against the current folder. The session's own
 * header still names the directory it ran in; when that directory **exists**, this function attaches there
 * (`resolveByPath`, then `create`) and reports the substitution in `cwd_fallback`. It never attaches to a different
 * real path than the header names. Only a header cwd that is missing, empty, or cannot be realpath'd (a deleted
 * drive or directory) is refused, and that refusal names the file-level path + bounded watch as the next step.
 *
 * `already_registered` is computed from the registry view for the same reporting semantics as the file path; a
 * registered session is never attached twice.
 *
 * @param {{
 *   dshHome: string, sessionIds: string[], workspaceRegistry?: object|null, workspacePath?: string|null,
 *   now?: Date,
 * }} input
 * @returns {Promise<object>} the apply-shaped result plus `via:'host-service'`, `failed: []`,
 *   `cwd_fallback: Array<{session_id, requested_path, used_path}>`, per-session `attached_workspace_id` /
 *   `workspace_path_used`, and `residual_risk: null` on success (a named refusal states the file path's residual
 *   window instead)
 */
export async function registerThroughHost(input = {}) {
  const dshHome = typeof input.dshHome === 'string' && input.dshHome.trim() !== '' ? path.resolve(input.dshHome) : null;
  const requested = [...new Set((Array.isArray(input.sessionIds) ? input.sessionIds : []).map((value) => String(value ?? '')).filter((value) => value !== ''))];
  const now = input.now instanceof Date ? input.now : new Date();
  const workspacePath = typeof input.workspacePath === 'string' && input.workspacePath.trim() !== '' ? path.resolve(input.workspacePath.trim()) : null;
  const service = input.workspaceRegistry ?? null;
  const base = {
    ok: false,
    reason_code: null,
    detail: null,
    via: 'host-service',
    dsh_home: dshHome,
    workspace_path: workspacePath,
    requested,
    sessions: [],
    registered: [],
    already_registered: [],
    unknown: [],
    failed: [],
    actions: [],
    cwd_fallback: [],
    changed: false,
    verified: false,
    backup_file: null,
    registry: null,
    host_service: true,
    residual_risk: null,
    at: now.toISOString(),
  };
  /** A named refusal in the apply-shaped base; `extra` wins over the base's placeholder reason fields. */
  const hostRefusal = (reasonCode, detail, extra = {}) => ({
    ...base,
    ...extra,
    ok: false,
    reason_code: reasonCode,
    detail,
  });
  if (dshHome === null) return hostRefusal(REGISTER_CODES.NO_SESSION, 'registerThroughHost needs a dshHome');
  if (requested.length === 0) return hostRefusal(REGISTER_CODES.NO_SESSION, 'register needs at least one session id');
  if (usableWorkspaceRegistry(service) !== true) {
    return hostRefusal(
      REGISTER_CODES.HOST_UNAVAILABLE,
      'this host exposes no workspaceRegistry service, so a session cannot be registered in-process; run the offline CLI (w2m-backup register) against a stopped home instead',
    );
  }

  const onDisk = indexSessionsOnDisk(dshHome);
  const unknown = requested.filter((sessionId) => !onDisk.has(sessionId));
  if (unknown.length > 0) {
    return hostRefusal(
      REGISTER_CODES.SESSION_MISSING,
      `no session directory under ${path.join(dshHome, 'sessions')} for: ${unknown.join(', ')}; register only makes an on-disk session visible, it does not create one`,
      { unknown },
    );
  }

  const view = readWorkspaceRegistry(dshHome);
  const sessions = requested.map((sessionId) => {
    const row = onDisk.get(sessionId);
    return {
      session_id: sessionId,
      workspace: row.workspace,
      dir: row.dir,
      header_cwd: null,
      requested_path: null,
      workspace_path_used: null,
      attached_workspace_id: null,
      cwd_fallback: false,
    };
  });
  const alreadyRegistered = sessions
    .filter((session) => view.ok === true && view.registered.has(session.session_id))
    .map((session) => session.session_id);
  const fresh = sessions.filter((session) => !alreadyRegistered.includes(session.session_id));

  const registered = [];
  const failed = [];
  const actions = [];
  const cwdFallback = [];
  for (const session of fresh) {
    // Which workspace may hold this session, in preference order: the caller-named path (the disaster-recovery
    // case), the registry view's own record for the recorded slug, then the session's own header cwd. The last one
    // is the only source that survives a moved/renamed folder, and it is the fact the service validates against.
    const matched = findWorkspaceForSlug(view, session.workspace);
    const namedPath = workspacePath ?? (typeof matched?.path === 'string' && matched.path !== '' ? matched.path : null);
    const namedCanonical = namedPath === null ? null : path.resolve(namedPath);
    const namedReal = namedCanonical === null ? null : realDirectoryOrNull(namedCanonical);
    const header = readSessionCwd(session.dir);
    session.header_cwd = header.cwd;
    session.requested_path = namedCanonical;

    // The one real path this session may be attached to. A header cwd that exists and differs from the requested
    // workspace is a moved folder (or a registry record that no longer names where the session ran): attach there.
    let targetPath = namedCanonical;
    let fallback = null;
    if (header.real_cwd !== null) {
      if (namedReal !== header.real_cwd) {
        fallback = { session_id: session.session_id, requested_path: namedCanonical, used_path: header.real_cwd };
        targetPath = header.real_cwd;
      }
    } else if (header.problem !== 'unreadable' && namedReal !== null) {
      // The header cwd is known and gone while the requested workspace exists. Attaching the session there would
      // put it in a directory it never ran in -- the silent mis-attach the service's own check prevents -- so
      // refuse, name the cwd string, and point at the file path + watch.
      failed.push({
        session_id: session.session_id,
        reason_code: REGISTER_CODES.HOST_ATTACH_FAILED,
        detail: hostAttachFailureDetail(session.session_id, header.detail ?? `its header cwd '${header.cwd ?? ''}' cannot be used`),
        header_cwd: header.cwd,
        requested_path: namedCanonical,
        used_path: null,
        cause: header.detail,
      });
      continue;
    }
    if (targetPath === null) {
      failed.push({
        session_id: session.session_id,
        reason_code: REGISTER_CODES.HOST_WORKSPACE_UNKNOWN,
        detail: `no workspace path is known for slug ${session.workspace}, and the session's header cwd cannot stand in for one (${header.detail ?? 'unreadable'}); pass an explicit workspace path, or ${HOST_ATTACH_ADVICE}`,
        header_cwd: header.cwd,
        requested_path: null,
        used_path: null,
        cause: header.detail,
      });
      continue;
    }
    session.workspace_path_used = targetPath;
    try {
      let workspace = typeof service.resolveByPath === 'function' ? await service.resolveByPath(path.resolve(targetPath)) : null;
      if (workspace === null || workspace === undefined) {
        if (typeof service.create !== 'function') {
          failed.push({ session_id: session.session_id, reason_code: REGISTER_CODES.HOST_WORKSPACE_UNKNOWN, detail: `the host service has no workspace at ${targetPath} and cannot create one; ${HOST_ATTACH_ADVICE}`, header_cwd: header.cwd, requested_path: namedCanonical, used_path: targetPath });
          continue;
        }
        // A workspace created for a moved folder is titled by the folder it is, not by the folder that replaced it.
        workspace = fallback === null
          ? await service.create(path.resolve(targetPath))
          : await service.create(path.resolve(targetPath), workspaceTitleForCwd(targetPath));
      }
      if (workspace === null || workspace === undefined || typeof workspace.attachSession !== 'function') {
        failed.push({ session_id: session.session_id, reason_code: REGISTER_CODES.HOST_WORKSPACE_UNKNOWN, detail: `the host service returned no attachable workspace for ${targetPath}; ${HOST_ATTACH_ADVICE}`, header_cwd: header.cwd, requested_path: namedCanonical, used_path: targetPath });
        continue;
      }
      await workspace.attachSession(session.session_id);
      registered.push(session.session_id);
      session.attached_workspace_id = typeof workspace.id === 'string' && workspace.id !== '' ? workspace.id : null;
      if (fallback === null) {
        actions.push(`attached ${session.session_id} to the host workspace ${targetPath}`);
      } else {
        session.cwd_fallback = true;
        cwdFallback.push(fallback);
        actions.push(`attached ${session.session_id} to the host workspace ${fallback.used_path} (its own header cwd; requested ${fallback.requested_path ?? 'none'})`);
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const reason = header.cwd === null
        ? `its header carries no readable cwd (${cause})`
        : `its header cwd '${header.cwd}' could not be attached (${cause})`;
      failed.push({
        session_id: session.session_id,
        reason_code: REGISTER_CODES.HOST_ATTACH_FAILED,
        detail: hostAttachFailureDetail(session.session_id, reason),
        header_cwd: header.cwd,
        requested_path: namedCanonical,
        used_path: targetPath,
        cause,
      });
    }
  }

  const changed = registered.length > 0;
  if (failed.length > 0) {
    return {
      ...base,
      reason_code: failed[0].reason_code,
      detail: hostRefusalDetail(failed, fresh.length),
      sessions,
      registered,
      already_registered: alreadyRegistered,
      failed,
      actions,
      cwd_fallback: cwdFallback,
      changed,
      // A partial attach changed something but not the promise: "verified" only when every fresh session landed.
      verified: false,
      // The next step is the file path + its bounded watch, so its residual window is stated here, not null.
      residual_risk: REGISTER_RESIDUAL_RISK_LINE,
    };
  }
  return {
    ...base,
    ok: true,
    detail: changed ? null : 'already registered; the host service was not called',
    sessions,
    registered,
    already_registered: alreadyRegistered,
    failed: [],
    actions,
    cwd_fallback: cwdFallback,
    changed,
    // The service persists before it mutates memory (dsh-storage-domain), so a resolved attachSession call is
    // durable by construction -- there is no read-back of a file we wrote.
    verified: true,
  };
}
