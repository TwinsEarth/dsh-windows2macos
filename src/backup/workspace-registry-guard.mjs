/**
 * Workspace registry integrity: inspect and repair `storages/workspace.json`.
 *
 * ## Why this module exists
 *
 * The DSH client owns `storages/workspace.json` and keeps it in memory. Its `workspaceController` service
 * fails to mount when `global.workspaceIds` names a workspace the `tables.workspaces` table no longer has:
 * one dangling id is enough to make **every** workspace operation fail with
 * `workspace/create: active Service "workspaceController" is unavailable`.
 *
 * That state is easy to create by hand: an ad-hoc script deletes table rows (to clean up a rehearsal) and
 * forgets the matching ids. It happened on 2026-11-21 during a W2M real-machine drill, which is why the
 * repair path lives in the product now instead of in a throwaway snippet.
 *
 * ## The invariants
 *
 * 1. every id in `global.workspaceIds` exists as a row in `tables.workspaces` (a dangling id is fatal);
 * 2. every row is named by exactly one id in `global.workspaceIds` (an unlisted row is invisible, not fatal);
 * 3. `global.defaultWorkspaceId` is a row that is also listed in `workspaceIds`.
 *
 * The repair keeps data: a dangling id is dropped, an unlisted **row is kept and appended to the ids**, and
 * the default is reassigned to the first surviving id. The file is written atomically after the current one
 * is copied to `<file>.bak-guard-<stamp>`, and the result is read back and re-inspected before reporting.
 *
 * ## What this module does NOT do
 *
 * It does not stop the DSH client. The client holds the document in memory and may overwrite a file edited
 * underneath it, so a repair on a live process must be preceded by quitting the app (the shipped
 * `tools/dsh-workspace-guard.ps1` wrapper does exactly that for `-Fix`). It also does not touch rows' paths,
 * titles or session lists — it never deletes a workspace the user can see.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The registry document lives at `storages/workspace.json`. */
export function workspaceRegistryFile(dshHome) {
  return path.join(path.resolve(dshHome), 'storages', 'workspace.json');
}

/** ISO stamp shaped for a file name (`20261121T110231Z`). */
function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The stored session log name the client writes. */
const STORED_SESSION_FILE = 'session.v4.jsonl.zstd';

/** Whether any workspace slug under `sessions/` carries this session id. */
function sessionExists(sessionsRoot, sessionId) {
  if (!fs.existsSync(sessionsRoot)) return null; // cannot judge: a home without sessions is not "missing"
  for (const slug of fs.readdirSync(sessionsRoot)) {
    if (fs.existsSync(path.join(sessionsRoot, slug, sessionId, STORED_SESSION_FILE))) return true;
  }
  return false;
}

/**
 * Inspect the registry without writing anything.
 *
 * @param {string} dshHome
 * @returns {{ok: boolean, file: string, exists: boolean, rows: string[], ids: string[],
 *   danglingIds: string[], unlistedRows: string[], missingSessions: Array<{workspaceId: string, sessionId: string}>,
 *   defaultId: string|null, defaultOk: boolean,
 *   problems: Array<{code: string, detail: string}>, error: string|null}}
 */
export function inspectWorkspaceRegistry(dshHome) {
  const file = workspaceRegistryFile(dshHome);
  const sessionsRoot = path.join(path.resolve(dshHome), 'sessions');
  const empty = {
    ok: false, file, exists: false, rows: [], ids: [], danglingIds: [], unlistedRows: [], missingSessions: [],
    defaultId: null, defaultOk: false, problems: [], error: null,
  };
  if (!fs.existsSync(file)) {
    return { ...empty, error: 'registry file is missing' };
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ...empty, exists: true, error: `registry is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rows = Object.keys(document?.tables?.workspaces ?? {});
  const ids = Array.isArray(document?.global?.workspaceIds) ? document.global.workspaceIds.map(String) : [];
  const danglingIds = ids.filter((id) => !rows.includes(id));
  const unlistedRows = rows.filter((id) => !ids.includes(id));
  const missingSessions = [];
  for (const [workspaceId, row] of Object.entries(document?.tables?.workspaces ?? {})) {
    for (const sessionId of Array.isArray(row?.sessionIds) ? row.sessionIds : []) {
      if (sessionExists(sessionsRoot, String(sessionId)) === false) missingSessions.push({ workspaceId, sessionId: String(sessionId) });
    }
  }
  const defaultId = typeof document?.global?.defaultWorkspaceId === 'string' ? document.global.defaultWorkspaceId : null;
  const defaultOk = defaultId !== null && rows.includes(defaultId) && ids.includes(defaultId);
  const problems = [];
  if (danglingIds.length > 0) problems.push({ code: 'WORKSPACE_ID_DANGLING', detail: `workspaceIds names ${danglingIds.length} row(s) the table does not have (fatal for workspaceController)` });
  if (unlistedRows.length > 0) problems.push({ code: 'WORKSPACE_ROW_UNLISTED', detail: `${unlistedRows.length} table row(s) are not named by workspaceIds (invisible in the UI)` });
  if (missingSessions.length > 0) problems.push({ code: 'WORKSPACE_SESSION_MISSING', detail: `${missingSessions.length} session id(s) listed by a workspace row have no session log on disk` });
  if (!defaultOk) problems.push({ code: 'WORKSPACE_DEFAULT_INVALID', detail: `defaultWorkspaceId ${defaultId ?? '(missing)'} is not a listed row` });
  return { ok: problems.length === 0 && document?.unit?.name === 'workspace', file, exists: true, rows, ids, danglingIds, unlistedRows, missingSessions, defaultId, defaultOk, problems, error: null };
}

/**
 * Repair the registry. Copies the current file first, never deletes a visible row, then re-inspects.
 *
 * @param {string} dshHome
 * @param {{now?: Date}} [options]
 * @returns {{ok: boolean, changed: boolean, file: string, backup: string|null, before: object, after: object,
 *   error: string|null}}
 */
export function repairWorkspaceRegistry(dshHome, options = {}) {
  const before = inspectWorkspaceRegistry(dshHome);
  if (before.error !== null) return { ok: false, changed: false, file: before.file, backup: null, before, after: before, error: before.error };
  if (before.ok) return { ok: true, changed: false, file: before.file, backup: null, before, after: before, error: null };

  const document = JSON.parse(fs.readFileSync(before.file, 'utf8'));
  const sessionsRoot = path.join(path.resolve(dshHome), 'sessions');
  const rows = Object.keys(document.tables.workspaces ?? {});
  const ids = Array.isArray(document.global.workspaceIds) ? document.global.workspaceIds.map(String) : [];
  const keptIds = ids.filter((id) => rows.includes(id));
  for (const row of rows) if (!keptIds.includes(row)) keptIds.push(row);
  // A row's session list may name a session that no longer exists; that reference is dropped (the row stays).
  for (const row of Object.values(document.tables.workspaces ?? {})) {
    if (!Array.isArray(row?.sessionIds)) continue;
    row.sessionIds = row.sessionIds.filter((sessionId) => sessionExists(sessionsRoot, String(sessionId)) !== false);
  }
  const defaultId = typeof document.global.defaultWorkspaceId === 'string' ? document.global.defaultWorkspaceId : null;
  const nextDefault = defaultId !== null && keptIds.includes(defaultId) ? defaultId : keptIds[0] ?? null;

  const backup = `${before.file}.bak-guard-${stamp(options.now)}`;
  fs.copyFileSync(before.file, backup);
  document.global.workspaceIds = keptIds;
  document.global.defaultWorkspaceId = nextDefault;
  const temp = `${before.file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  try {
    const handle = fs.openSync(temp, 'r+');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  } catch { /* fsync is best effort on some filesystems */ }
  fs.renameSync(temp, before.file);

  const after = inspectWorkspaceRegistry(dshHome);
  return { ok: after.ok, changed: true, file: before.file, backup, before, after, error: after.ok ? null : 'repair did not converge' };
}
