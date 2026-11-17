/**
 * The DSH workspace registry (`<DSH_HOME>/storages/workspace.json`) as data.
 *
 * ## Why this is a module and not three lines in each caller
 *
 * Two places need the same answer -- "which sessions does DSH list, which are archived, which are pinned":
 * `scripts/session-doctor.mjs` (the read-only validator added after the 2026-11-17 recovery drill) and the
 * backup scanner (`src/backup/scan.mjs`). The drill is the reason the answer must not be computed twice: a
 * session was written to disk, hand-added to the registry, overwritten by the client from its in-memory table,
 * and then invisible in the UI while every tool said it was there. Two parsers would let the two callers
 * disagree about the same file, and the disagreement would be silent.
 *
 * ## What is deliberately NOT here
 *
 * No writer. The registry is owned by the DSH client, which rewrites it from memory; a helper that offered
 * "add a session id" would invite exactly the failure above. Callers that must change it do so under the
 * read-back protocol documented in `docs/BACKUP-DESIGN.md` (gate G2), not through this module.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Registry path relative to `$DSH_HOME`. */
export const WORKSPACE_STORAGE_FILE = ['storages', 'workspace.json'];

/**
 * Absolute path of the workspace registry.
 *
 * @param {string} dshHome
 * @returns {string}
 */
export function workspaceRegistryPath(dshHome) {
  return join(dshHome, ...WORKSPACE_STORAGE_FILE);
}

/**
 * Parse the registry text.
 *
 * Never throws: a missing or unreadable registry is a state this project has to report honestly (the doctor
 * has a finding code for it), not an exception that aborts a scan. Every collection is built defensively,
 * because a hand-edited or partially-written file is precisely the input these callers exist to diagnose.
 *
 * @param {string} text
 * @returns {{
 *   ok: boolean,
 *   error: string|null,
 *   workspaces: Array<{id: string, path: string|null, title: string|null, sessionIds: string[]}>,
 *   workspaceIds: string[],
 *   defaultWorkspaceId: string|null,
 *   registered: Set<string>,
 *   archived: Set<string>,
 *   pinned: Set<string>
 * }}
 */
export function parseWorkspaceRegistry(text) {
  const empty = {
    ok: false,
    error: null,
    workspaces: [],
    workspaceIds: [],
    defaultWorkspaceId: null,
    registered: new Set(),
    archived: new Set(),
    pinned: new Set(),
  };
  let registry;
  try {
    registry = JSON.parse(text);
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    return { ...empty, error: 'the registry is not a JSON object' };
  }

  const global = registry.global !== null && typeof registry.global === 'object' ? registry.global : {};
  const tables = registry.tables !== null && typeof registry.tables === 'object' ? registry.tables : {};
  const tableWorkspaces = tables.workspaces !== null && typeof tables.workspaces === 'object' ? tables.workspaces : {};

  const registered = new Set();
  const workspaces = [];
  for (const [id, record] of Object.entries(tableWorkspaces)) {
    const sessionIds = Array.isArray(record?.sessionIds) ? record.sessionIds.map((value) => String(value)) : [];
    for (const sessionId of sessionIds) registered.add(sessionId);
    workspaces.push({
      id,
      path: typeof record?.path === 'string' ? record.path : null,
      title: typeof record?.title === 'string' ? record.title : null,
      sessionIds,
    });
  }

  const archived = new Set(
    (Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []).map((value) => String(value)),
  );
  const pinned = new Set(
    (Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : []).map((value) => String(value)),
  );

  return {
    ok: true,
    error: null,
    workspaces: workspaces.sort((a, b) => a.id.localeCompare(b.id)),
    workspaceIds: Array.isArray(global.workspaceIds) ? global.workspaceIds.map((value) => String(value)) : [],
    defaultWorkspaceId: typeof global.defaultWorkspaceId === 'string' ? global.defaultWorkspaceId : null,
    registered,
    archived,
    pinned,
  };
}

/**
 * Read and parse the registry of a DSH home.
 *
 * Never throws, for the reason in {@link parseWorkspaceRegistry}. `ok: false` with `error: null` means the
 * file does not exist; `error` non-null means it exists but could not be used.
 *
 * @param {string} dshHome
 * @returns {ReturnType<typeof parseWorkspaceRegistry> & {file: string}}
 */
export function readWorkspaceRegistry(dshHome) {
  const file = workspaceRegistryPath(dshHome);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = error?.code;
    return {
      ...parseWorkspaceRegistry('{}'),
      file,
      ok: false,
      error: code === 'ENOENT' ? null : `could not read the registry: ${code ?? 'unknown error'}`,
    };
  }
  return { ...parseWorkspaceRegistry(text), file };
}
