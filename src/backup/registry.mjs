/**
 * Workspace-registry restore: gate G2 from the 2026-11-17 retrospective.
 *
 * ## The failure G2 exists for
 *
 * A restored session was written to `sessions/`, hand-added to `storages/workspace.json`, and the client -- which
 * holds the registry in memory -- saved its own copy over it. The session was on disk and invisible in the UI,
 * with no error anywhere. The registry is **client-owned state**; a writer must assume its own write can be
 * replaced.
 *
 * ## The protocol this module implements
 *
 *   * plan first: compute the exact document and every action, without writing (`planRegistryRestore`);
 *   * write atomically (`writeJsonAtomic`) after nothing else is half-done;
 *   * **read back and compare** the parts the plan promised (`verifyRegistryWrite`);
 *   * always report the residual risk: the client may overwrite it again, so the caller re-checks after the client
 *     saves (the host route does; the offline CLI prints the warning).
 *
 * ## What a restore may change
 *
 * Only: the session id is present in the matching workspace's `sessionIds`; archived/pinned flags match the
 * backup. **Workspaces are never invented**: the backup records a workspace slug (derived from a directory name),
 * and the inverse mapping to an absolute path is ambiguous. A restore into a home that does not already contain
 * that workspace is refused with the registered list, unless the operator passes an explicit path.
 */

import path from 'node:path';

import { readJsonSafe, writeJsonAtomic } from './atomic.mjs';
import { readWorkspaceRegistry } from '../util/dsh-workspace.mjs';
import { workspaceRegistryPath } from '../util/dsh-workspace.mjs';

/** Named registry-refusal codes. */
export const REGISTRY_CODES = Object.freeze({
  UNREADABLE: 'BACKUP_REGISTRY_UNREADABLE',
  WORKSPACE_UNKNOWN: 'BACKUP_RESTORE_WORKSPACE_UNKNOWN',
  WRITE_FAILED: 'BACKUP_REGISTRY_WRITE_FAILED',
  VERIFY_FAILED: 'BACKUP_REGISTRY_VERIFY_FAILED',
});

/** The residual risk every successful restore must state (it is not a bug, it is the protocol). */
export const CLIENT_OVERWRITE_WARNING =
  'the DSH client keeps this registry in memory and saves it on its own schedule; an entry written while the client ' +
  'is running can be replaced. Re-open the session list, and if the session is missing run the restore again after ' +
  'restarting the app.';

/**
 * The directory-name slug DSH derives from a workspace path (`E:\GPT` -> `--E-GPT--`).
 *
 * Measured against the real registry: `E:\GPT` -> `--E-GPT--`, `E:\ToFuture` -> `--E-ToFuture--`,
 * `C:\Users\...\deepseek-harness\default-workspace` -> `--C-Users-...--`.
 *
 * @param {string} workspacePath
 * @returns {string}
 */
export function workspaceSlug(workspacePath) {
  const normalized = String(workspacePath).replace(/^([A-Za-z]):[\\/]/, '$1-').replace(/[\\/]/g, '-');
  return `--${normalized}--`;
}

/**
 * Find the registry workspace whose path (or slug) matches a backup's workspace name.
 *
 * @param {ReturnType<typeof readWorkspaceRegistry>} registry
 * @param {string} workspaceName slug from the backup manifest (`--E-GPT--`)
 * @returns {{id: string, path: string|null, title: string|null, sessionIds: string[]} | null}
 */
export function findWorkspaceForSlug(registry, workspaceName) {
  const wanted = String(workspaceName);
  for (const workspace of registry.workspaces) {
    if (workspace.path !== null && workspaceSlug(workspace.path) === wanted) return { ...workspace };
    if (workspace.id === wanted) return { ...workspace };
  }
  return null;
}

/**
 * Plan the registry change for one restored session, without writing it.
 *
 * @param {{dshHome: string, sessionId: string, workspaceName: string, archived?: boolean, pinned?: boolean,
 *   workspacePath?: string|null, registry?: ReturnType<typeof readWorkspaceRegistry>}} input
 * @returns {{ok: boolean, reason_code: string|null, detail: string|null, file: string, document: object|null,
 *   workspace_id: string|null, actions: string[], changed: boolean}}
 */
export function planRegistryRestore(input) {
  const file = workspaceRegistryPath(input.dshHome);
  const registry = input.registry ?? readWorkspaceRegistry(input.dshHome);
  if (registry.ok !== true) {
    return {
      ok: false,
      reason_code: REGISTRY_CODES.UNREADABLE,
      detail: `${registry.file}: ${registry.error ?? 'unreadable'}`,
      file,
      document: null,
      workspace_id: null,
      actions: [],
      changed: false,
    };
  }
  const document = readJsonSafe(file);
  if (document === null) {
    return {
      ok: false,
      reason_code: REGISTRY_CODES.UNREADABLE,
      detail: `${file}: not a JSON object`,
      file,
      document: null,
      workspace_id: null,
      actions: [],
      changed: false,
    };
  }

  let workspace = findWorkspaceForSlug(registry, input.workspaceName);
  let created = false;
  if (workspace === null && typeof input.workspacePath === 'string' && input.workspacePath.trim() !== '') {
    const workspacePath = path.resolve(input.workspacePath.trim());
    const id = `restored-${workspaceSlug(workspacePath).replace(/^-+|-+$/g, '').toLowerCase()}`;
    workspace = { id, path: workspacePath, title: path.basename(workspacePath) || workspacePath, sessionIds: [] };
    created = true;
  }
  if (workspace === null) {
    return {
      ok: false,
      reason_code: REGISTRY_CODES.WORKSPACE_UNKNOWN,
      detail:
        `the backup belongs to workspace ${input.workspaceName}, which this home does not register ` +
        `(registered: ${registry.workspaces.map((row) => row.id).join(', ') || 'none'}); pass --workspace-path to attach it to a directory`,
      file,
      document,
      workspace_id: null,
      actions: [],
      changed: false,
    };
  }

  const actions = [];
  const next = JSON.parse(JSON.stringify(document));
  next.tables = next.tables ?? {};
  next.tables.workspaces = next.tables.workspaces ?? {};
  if (created) {
    next.tables.workspaces[workspace.id] = {
      path: workspace.path,
      title: workspace.title,
      sessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    next.global = next.global ?? {};
    next.global.workspaceIds = Array.isArray(next.global.workspaceIds) ? next.global.workspaceIds : [];
    if (!next.global.workspaceIds.includes(workspace.id)) next.global.workspaceIds.push(workspace.id);
    actions.push(`create workspace ${workspace.id} for ${workspace.path}`);
  }
  const record = next.tables.workspaces[workspace.id] ?? next.tables.workspaces[Object.keys(next.tables.workspaces).find((id) => id === workspace.id)];
  if (record === undefined) {
    return {
      ok: false,
      reason_code: REGISTRY_CODES.UNREADABLE,
      detail: `the registry document does not contain workspace ${workspace.id}`,
      file,
      document,
      workspace_id: workspace.id,
      actions,
      changed: false,
    };
  }
  record.sessionIds = Array.isArray(record.sessionIds) ? record.sessionIds : [];
  if (!record.sessionIds.includes(input.sessionId)) {
    record.sessionIds.push(input.sessionId);
    actions.push(`register ${input.sessionId} in workspace ${workspace.id}`);
  }
  record.updatedAt = new Date().toISOString();

  const desiredArchived = input.archived === true;
  if (desiredArchived !== registry.archived.has(input.sessionId)) {
    next.global = next.global ?? {};
    const archived = new Set(Array.isArray(next.global.archivedSessionIds) ? next.global.archivedSessionIds.map(String) : []);
    if (desiredArchived) archived.add(input.sessionId);
    else archived.delete(input.sessionId);
    next.global.archivedSessionIds = [...archived];
    actions.push(desiredArchived ? `archive ${input.sessionId}` : `unarchive ${input.sessionId}`);
  }
  const desiredPinned = input.pinned === true;
  if (desiredPinned !== registry.pinned.has(input.sessionId)) {
    next.global = next.global ?? {};
    const pinned = new Set(Array.isArray(next.global.pinnedSessionIds) ? next.global.pinnedSessionIds.map(String) : []);
    if (desiredPinned) pinned.add(input.sessionId);
    else pinned.delete(input.sessionId);
    next.global.pinnedSessionIds = [...pinned];
    actions.push(desiredPinned ? `pin ${input.sessionId}` : `unpin ${input.sessionId}`);
  }

  return {
    ok: true,
    reason_code: null,
    detail: null,
    file,
    document: next,
    workspace_id: workspace.id,
    session_id: input.sessionId,
    archived: desiredArchived,
    pinned: desiredPinned,
    actions,
    changed: actions.length > 0,
  };
}

/**
 * Write a planned registry document and verify it by reading it back.
 *
 * The verification compares exactly what the plan promised -- session registered, archive/pin flags -- not the whole
 * file: another writer (the client) may legitimately touch `updatedAt` or unrelated entries.
 *
 * @param {{dshHome: string, plan: ReturnType<typeof planRegistryRestore>}} input
 * @returns {{ok: boolean, verified: boolean, reason_code: string|null, detail: string|null,
 *   actions: string[], warning: string|null}}
 */
export function applyRegistryRestore(input) {
  const plan = input.plan;
  if (plan.ok !== true) {
    return { ok: false, verified: false, reason_code: plan.reason_code, detail: plan.detail, actions: plan.actions, warning: null };
  }
  if (plan.changed !== true) {
    return { ok: true, verified: true, reason_code: null, detail: null, actions: [], warning: null };
  }
  try {
    writeJsonAtomic(plan.file, plan.document);
  } catch (error) {
    return {
      ok: false,
      verified: false,
      reason_code: REGISTRY_CODES.WRITE_FAILED,
      detail: error?.detail ?? String(error?.message ?? error),
      actions: plan.actions,
      warning: null,
    };
  }
  const verification = verifyRegistryWrite({ dshHome: input.dshHome, plan });
  return {
    ok: verification.ok,
    verified: verification.ok,
    reason_code: verification.ok ? null : REGISTRY_CODES.VERIFY_FAILED,
    detail: verification.detail,
    actions: plan.actions,
    warning: CLIENT_OVERWRITE_WARNING,
  };
}

/**
 * Re-read the registry and confirm the plan's promises hold.
 *
 * Exactly three things are checked -- registered, archived, pinned -- because those are what the plan changed.
 * Other fields (the client's own `updatedAt`, unrelated entries) may legitimately differ: the purpose here is to
 * catch the client overwriting the entry, not to demand a byte-identical file.
 *
 * @param {{dshHome: string, plan: ReturnType<typeof planRegistryRestore>}} input
 * @returns {{ok: boolean, detail: string|null}}
 */
export function verifyRegistryWrite(input) {
  const plan = input.plan;
  if (plan.ok !== true || plan.changed !== true) return { ok: true, detail: null };
  const registry = readWorkspaceRegistry(input.dshHome);
  if (registry.ok !== true) return { ok: false, detail: `the registry became unreadable after the write: ${registry.error}` };
  const sessionId = plan.session_id;
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, detail: 'the plan names no session id' };
  if (!registry.registered.has(sessionId)) {
    return { ok: false, detail: `session ${sessionId} is still not registered after the write (the client may have replaced the registry)` };
  }
  if (registry.archived.has(sessionId) !== (plan.archived === true)) {
    return { ok: false, detail: `session ${sessionId} archived flag does not match the plan after the write` };
  }
  if (registry.pinned.has(sessionId) !== (plan.pinned === true)) {
    return { ok: false, detail: `session ${sessionId} pinned flag does not match the plan after the write` };
  }
  return { ok: true, detail: null };
}
