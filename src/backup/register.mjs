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
 */

import fs from 'node:fs';
import path from 'node:path';

import { clientGate } from './client.mjs';
import { applyRegistryRestore, CLIENT_OVERWRITE_WARNING, planRegistryRestores, workspaceRegistryPath } from './registry.mjs';
import { preRestoreRoot } from './restore.mjs';
import { listSessionDirs } from '../fix/session.mjs';
import { readWorkspaceRegistry } from '../util/dsh-workspace.mjs';

/** Named register refusals. */
export const REGISTER_CODES = Object.freeze({
  /** No session ids were supplied: there is nothing to register. */
  NO_SESSION: 'BACKUP_REGISTER_NO_SESSION',
  /** A requested session id has no directory under `sessions/` in this home. */
  SESSION_MISSING: 'BACKUP_REGISTER_SESSION_MISSING',
  /** The registry copy that is the way back could not be written; nothing was changed. */
  BACKUP_FAILED: 'BACKUP_REGISTER_BACKUP_FAILED',
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
