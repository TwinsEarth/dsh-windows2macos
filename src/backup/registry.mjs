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
 *   * plan first: compute the exact document and every action, without writing;
 *   * write atomically (`writeJsonAtomic`) after nothing else is half-done;
 *   * **read back and compare** the parts the plan promised;
 *   * always report the residual risk: the client may overwrite it again, so the caller re-checks after the client
 *     saves (the host route does; the offline CLI prints the warning).
 *
 * ## One document, many sessions
 *
 * The first version planned one session at a time, and each plan copied the *original* document -- applying three
 * plans in a row therefore left only the third session registered. The planner is now **per restore**, not per
 * session: it owns one mutable copy of the document and returns one write. That also makes "restore into a
 * brand-new home" expressible: with no registry file yet, one document can be created (only when the operator
 * named a directory, so no workspace is ever invented by default).
 */

import fs from 'node:fs';
import path from 'node:path';

import { readJsonSafe, writeJsonAtomic } from './atomic.mjs';

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

/** The registry document lives at `storages/workspace.json`. */
export function workspaceRegistryPath(dshHome) {
  return path.join(dshHome, 'storages', 'workspace.json');
}

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

/** A workspace id derived from a path, stable across restores. */
function workspaceIdForPath(workspacePath) {
  const slug = workspaceSlug(workspacePath).replace(/^-+|-+$/g, '').toLowerCase();
  return `restored-${slug}`;
}

/** A fresh registry document in the shape the client writes. */
function newRegistryDocument(workspaceId, workspacePath) {
  const now = new Date().toISOString();
  const pathApi =
    /^[A-Za-z]:[\\/]/u.test(workspacePath) || workspacePath.startsWith('\\\\') ? path.win32 : path;
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: workspaceId,
      workspaceIds: [workspaceId],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        [workspaceId]: {
          path: workspacePath,
          title: pathApi.basename(workspacePath) || workspacePath,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  };
}

/**
 * Find the workspace record (in the *document being planned*) that matches a backup workspace slug.
 *
 * Matching is by the slug the client derives from `path`, because a backup records the directory name, not the
 * absolute path.
 *
 * @param {object} document
 * @param {string} workspaceName
 * @returns {{id: string, record: object} | null}
 */
function findWorkspaceInDocument(document, workspaceName) {
  const workspaces = document?.tables?.workspaces;
  if (workspaces === null || typeof workspaces !== 'object') return null;
  const wanted = String(workspaceName);
  for (const [id, record] of Object.entries(workspaces)) {
    if (typeof record?.path === 'string' && workspaceSlug(record.path) === wanted) return { id, record };
  }
  return null;
}

/**
 * Find the registered workspace whose path (or id) matches a backup's workspace name.
 *
 * Accepts either the raw document (`{tables:{workspaces}}`) or the reader's view (`{workspaces:[...]}`), because
 * callers legitimately hold both: planning has the document, verification has the reader.
 *
 * @param {object} registry
 * @param {string} workspaceName slug from the backup manifest (`--E-GPT--`)
 * @returns {{id: string, path: string|null, title: string|null, sessionIds: string[]} | null}
 */
export function findWorkspaceForSlug(registry, workspaceName) {
  const wanted = String(workspaceName);
  const rows = Array.isArray(registry?.workspaces)
    ? registry.workspaces
    : Object.entries(registry?.tables?.workspaces ?? {}).map(([id, record]) => ({ id, ...record }));
  for (const workspace of rows) {
    if (typeof workspace?.path === 'string' && workspaceSlug(workspace.path) === wanted) return { ...workspace };
    if (workspace?.id === wanted) return { ...workspace };
  }
  return null;
}

/**
 * Plan the registry change for **one restore** (any number of sessions), without writing it.
 *
 * `baseDocument` (v3.5.0 P0) makes the backed-up registry document the starting point: all workspaces (with their
 * `path`/`title`/order), `global.defaultWorkspaceId` and archived/pinned **workspace-level** data survive, and a
 * session is matched against the document's own paths instead of being guessed from directory slugs. The restored
 * sessions are then added/updated on top. Without it, the pre-expansion behaviour (match the live registry by slug,
 * create one only when the operator named a directory) is unchanged.
 *
 * @param {{
 *   dshHome: string,
 *   sessions: Array<{session_id: string, workspace: string, archived?: boolean, pinned?: boolean}>,
 *   workspacePath?: string|null,
 *   allowCreateRegistry?: boolean,
 *   baseDocument?: object|null,
 * }} input
 * @returns {{
 *   ok: boolean, reason_code: string|null, detail: string|null, file: string,
 *   document: object|null, changed: boolean, actions: string[],
 *   created_document: boolean, created_workspaces: string[],
 *   base_document_restored: boolean,
 *   assignments: Array<{session_id: string, workspace_id: string, archived: boolean, pinned: boolean}>,
 * }}
 */
export function planRegistryRestores(input) {
  const file = workspaceRegistryPath(input.dshHome);
  const exists = fs.existsSync(file);
  const useBaseDocument = input.baseDocument !== undefined && input.baseDocument !== null;
  /** @type {object|null} */
  let document = null;
  let liveDocument = null;
  let createdDocument = false;
  const actions = [];
  const createdWorkspaces = [];

  if (useBaseDocument) {
    if (typeof input.baseDocument !== 'object' || Array.isArray(input.baseDocument) || input.baseDocument.tables === undefined) {
      return refusal(REGISTRY_CODES.UNREADABLE, `${file}: the backed-up registry document is not a workspace registry document`, file, null);
    }
    document = JSON.parse(JSON.stringify(input.baseDocument));
    liveDocument = exists ? readJsonSafe(file) : null;
  } else {
    document = exists ? readJsonSafe(file) : null;
  }
  if (!useBaseDocument && document !== null && (typeof document !== 'object' || document.tables === undefined)) {
    return refusal(REGISTRY_CODES.UNREADABLE, `${file}: not a workspace registry document`, file, document);
  }
  const requestedWorkspacePath = typeof input.workspacePath === 'string' && input.workspacePath.trim() !== ''
    ? input.workspacePath.trim()
    : null;
  // A Windows-shaped workspace in a backup can be restored into a POSIX test runner. `path.resolve` would prefix
  // the host cwd and turn `E:\GPT` into `<cwd>/E:\GPT`, changing the slug to `restored-...-e:-gpt`; the path's own
  // shape picks the parser, the same way `toRel` does.
  const workspacePathApi = requestedWorkspacePath !== null && (/^[A-Za-z]:[\\/]/u.test(requestedWorkspacePath) || requestedWorkspacePath.startsWith('\\\\'))
    ? path.win32
    : path;
  const workspacePath = requestedWorkspacePath === null ? null : workspacePathApi.resolve(requestedWorkspacePath);

  if (document === null) {
    if (exists) return refusal(REGISTRY_CODES.UNREADABLE, `${file}: not readable JSON`, file, null);
    // A brand-new home (the disaster-recovery case) has no registry yet. Creating one is only allowed when the
    // operator named a directory: otherwise there is nothing to attach the sessions to.
    if (input.allowCreateRegistry !== true || workspacePath === null) {
      return refusal(
        REGISTRY_CODES.UNREADABLE,
        `${file}: this home has no workspace registry yet; pass --workspace-path <dir> to create one and attach the restored sessions to that directory`,
        file,
        null,
      );
    }
    const workspaceId = workspaceIdForPath(workspacePath);
    document = newRegistryDocument(workspaceId, workspacePath);
    createdDocument = true;
    createdWorkspaces.push(workspaceId);
    actions.push(`create workspace registry and workspace ${workspaceId} for ${workspacePath}`);
  }

  const next = JSON.parse(JSON.stringify(document));
  next.tables = next.tables ?? {};
  next.tables.workspaces = next.tables.workspaces ?? {};
  next.global = next.global ?? {};
  next.global.workspaceIds = Array.isArray(next.global.workspaceIds) ? next.global.workspaceIds : [];

  const assignments = [];
  for (const session of input.sessions) {
    let workspace = findWorkspaceInDocument(next, session.workspace);
    if (workspace === null) {
      if (workspacePath === null) {
        const registered = Object.entries(next.tables.workspaces).map(([id, record]) => `${id}${record?.path ? ` (${record.path})` : ''}`);
        return refusal(
          REGISTRY_CODES.WORKSPACE_UNKNOWN,
          `the backup belongs to workspace ${session.workspace}, which this home does not register ` +
            `(registered: ${registered.join(', ') || 'none'}); pass --workspace-path to attach it to a directory`,
          file,
          next,
        );
      }
      // One named directory serves every unknown backup workspace: the backup keeps slugs, the target keeps paths,
      // and inventing one directory per slug would be worse than attaching them all to the directory the operator
      // actually named.
      const workspaceId = workspaceIdForPath(workspacePath);
      if (next.tables.workspaces[workspaceId] === undefined) {
        next.tables.workspaces[workspaceId] = {
          path: workspacePath,
          title: workspacePathApi.basename(workspacePath) || workspacePath,
          sessionIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        actions.push(`create workspace ${workspaceId} for ${workspacePath}`);
        createdWorkspaces.push(workspaceId);
      }
      if (!next.global.workspaceIds.includes(workspaceId)) next.global.workspaceIds.push(workspaceId);
      workspace = { id: workspaceId, record: next.tables.workspaces[workspaceId] };
    }

    workspace.record.sessionIds = Array.isArray(workspace.record.sessionIds) ? workspace.record.sessionIds : [];
    let workspaceChanged = false;
    if (!workspace.record.sessionIds.includes(session.session_id)) {
      workspace.record.sessionIds.push(session.session_id);
      actions.push(`register ${session.session_id} in workspace ${workspace.id}`);
      workspaceChanged = true;
    }
    // Only a real change moves `updatedAt`: a restore of an unchanged document must compare equal to the live one,
    // or every repeat restore would rewrite the registry for nothing.
    if (workspaceChanged) workspace.record.updatedAt = new Date().toISOString();

    const archived = session.archived === true;
    const archivedSet = new Set(Array.isArray(next.global.archivedSessionIds) ? next.global.archivedSessionIds.map(String) : []);
    if (archived !== archivedSet.has(session.session_id)) {
      if (archived) archivedSet.add(session.session_id);
      else archivedSet.delete(session.session_id);
      next.global.archivedSessionIds = [...archivedSet];
      actions.push(archived ? `archive ${session.session_id}` : `unarchive ${session.session_id}`);
    }
    const pinned = session.pinned === true;
    const pinnedSet = new Set(Array.isArray(next.global.pinnedSessionIds) ? next.global.pinnedSessionIds.map(String) : []);
    if (pinned !== pinnedSet.has(session.session_id)) {
      if (pinned) pinnedSet.add(session.session_id);
      else pinnedSet.delete(session.session_id);
      next.global.pinnedSessionIds = [...pinnedSet];
      actions.push(pinned ? `pin ${session.session_id}` : `unpin ${session.session_id}`);
    }

    assignments.push({ session_id: session.session_id, workspace_id: workspace.id, archived, pinned });
  }

  // With a backed-up base document the whole document is the deliverable: it is "changed" when it differs from the
  // live file, not only when a session had to be added (the workspace list/titles/order/default are part of it).
  let changed = actions.length > 0;
  if (useBaseDocument) {
    changed = !sameDocument(liveDocument, next);
    if (changed) actions.unshift(`replace the live registry with the backed-up document (${Object.keys(next.tables.workspaces).length} workspace(s))`);
    createdDocument = exists !== true;
  }

  return {
    ok: true,
    reason_code: null,
    detail: null,
    file,
    document: next,
    changed,
    actions,
    created_document: createdDocument,
    created_workspaces: createdWorkspaces,
    base_document_restored: useBaseDocument,
    assignments,
  };
}

/** Structural JSON equality (property order independent, because the live file and the plan are built separately). */
function sameDocument(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return canonical(left) === canonical(right);
}

/** Canonical JSON with sorted keys: enough for equality, small documents only (the registry is a few KB). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** One-session wrapper: kept for callers that only restore a single session. */
export function planRegistryRestore(input) {
  const plan = planRegistryRestores({ ...input, sessions: [{ session_id: input.sessionId, workspace: input.workspaceName, archived: input.archived, pinned: input.pinned }] });
  if (plan.ok !== true) return { ...plan, workspace_id: null };
  return { ...plan, workspace_id: plan.assignments[0]?.workspace_id ?? null };
}

/** Build a named refusal. */
function refusal(reason_code, detail, file, document) {
  return {
    ok: false,
    reason_code,
    detail,
    file,
    document,
    changed: false,
    actions: [],
    created_document: false,
    created_workspaces: [],
    base_document_restored: false,
    assignments: [],
  };
}

/**
 * Write a planned registry document and verify it by reading it back.
 *
 * @param {{dshHome: string, plan: ReturnType<typeof planRegistryRestores>}} input
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
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
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
 * Re-read the registry and confirm every promise the plan made.
 *
 * Checks registration, the workspace id, and archived/pinned flags for each session in the plan -- the things the
 * plan changed. Other fields may legitimately differ (the client's own `updatedAt`, unrelated entries).
 *
 * @param {{dshHome: string, plan: ReturnType<typeof planRegistryRestores>}} input
 * @returns {{ok: boolean, detail: string|null}}
 */
export function verifyRegistryWrite(input) {
  const plan = input.plan;
  if (plan.ok !== true || plan.changed !== true) return { ok: true, detail: null };
  const file = workspaceRegistryPath(input.dshHome);
  const document = readJsonSafe(file);
  if (document === null) return { ok: false, detail: 'the registry is not readable JSON after the write' };
  const workspaces = document?.tables?.workspaces ?? {};
  const sessionIds = new Set(Object.values(workspaces).flatMap((record) => (Array.isArray(record?.sessionIds) ? record.sessionIds : [])));
  const archived = new Set((document?.global?.archivedSessionIds ?? []).map(String));
  const pinned = new Set((document?.global?.pinnedSessionIds ?? []).map(String));
  // A base-document restore promises the whole document, not only this run's sessions: read it back and compare.
  if (plan.base_document_restored === true && !sameDocument(document, plan.document)) {
    return { ok: false, detail: 'the registry on disk differs from the backed-up document the plan wrote' };
  }
  for (const assignment of plan.assignments ?? []) {
    if (!sessionIds.has(assignment.session_id)) {
      return { ok: false, detail: `session ${assignment.session_id} is still not registered after the write (the client may have replaced the registry)` };
    }
    if (workspaces[assignment.workspace_id] === undefined) {
      return { ok: false, detail: `workspace ${assignment.workspace_id} is missing after the write` };
    }
    if (archived.has(assignment.session_id) !== (assignment.archived === true)) {
      return { ok: false, detail: `session ${assignment.session_id} archived flag does not match the plan after the write` };
    }
    if (pinned.has(assignment.session_id) !== (assignment.pinned === true)) {
      return { ok: false, detail: `session ${assignment.session_id} pinned flag does not match the plan after the write` };
    }
  }
  return { ok: true, detail: null };
}
