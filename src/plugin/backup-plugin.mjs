/**
 * Host half of the archive backup subplugin: `@twinsearth/w2m-dsh-plugin/dsh-backup-plugin`.
 *
 * ## Why this row exists next to `dsh-backup`
 *
 * `dsh-backup` mounts the scheduled, content-addressed **repository** engine: a 22:00 timer, rotation, a
 * sealed/unsealed repository and the panel routes. This row mounts the **archive tool surface** the
 * BackUP-dsh-plugin contract defines -- `backup_create`, `backup_verify`, `backup_restore`,
 * `backup_import_session_zip`, `backup_status` and `backup_list` -- whose backups are self-contained ZIP
 * files rather than a repository. They are different products with different blast radii, so they are two
 * rows, each `disabled: true` in `cordis.patch.yml`: the package carrying a fleet plugin never arms either
 * one on install, and an operator enables whichever it wants. Because this row has no timer and no panel
 * route, the two rows **coexist**: one scheduled repository plus one on-demand archive surface.
 *
 * ## What it owns, and what it deliberately delegates
 *
 * This file is a composition root: resolve configuration, request the `tools` service, and bind six
 * definitions to the engine. Nothing about hashing, the ZIP container, session framing or the registry is
 * implemented here -- those are `src/backup/zip.mjs`, `zip-archive.mjs`, `session-zip.mjs` and the already
 * tested `registry.mjs`. The configuration resolver reuses `resolveDshHome` / `defaultBackupDir` from the
 * `dsh-backup` host half instead of growing a second answer to "where is DSH home".
 *
 * ## It is stateless, and mount does no disk work
 *
 * Every call resolves its inputs and reads or writes exactly one archive; no timer, no state file, no
 * catch-up work at mount. That is the deliberate difference from `dsh-backup` after the v3.5.1 host crash:
 * enabling a row must never start a scan or a write. `ctx.effect` is still registered (when the host
 * provides it) so the plugin has an owner and an explicit dispose path, and it disposes nothing because
 * there is nothing to release.
 *
 * ## Restore is plan-first and needs an explicit confirmation
 *
 * `backup_restore` with `mode: "plan"` writes nothing. `mode: "apply"` requires `confirm: "restore"`; without
 * it the engine refuses with `BACKUP_RESTORE_CONFIRM_REQUIRED` before touching a file. Every existing file
 * apply would overwrite is copied to `<DSH_HOME>/.w2m-restore-backups/` first, and the copies are reported as
 * `pre_restore` -- a restore with no way back is not offered.
 *
 * ## `forceRunning`
 *
 * The explicit way past a session-id collision on `backup_restore` / `backup_import_session_zip`. With
 * `keepSessionIds` / `keepIds`, an id that already exists is refused (`BACKUP_SESSION_ID_CONFLICT`) because
 * overwriting a log in place is data loss. `forceRunning: true` is the caller saying it accepts that risk after a
 * copy has been made: the existing session directory is moved to
 * `<DSH_HOME>/.w2m-restore-backups/sessions-<UTC>/<projectKey>/<id>/` first, then replaced by the restored log, and
 * the replacement is reported in `replaced` (`{session_id, backup, file}`). It is not about the DSH client running:
 * registry writes still go through `registry.mjs`'s plan -> atomic write -> read-back protocol and still return the
 * residual client-overwrite warning, because no tool can stop the client from saving its in-memory registry.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  listZipBackups,
  createZipBackup,
  restoreZipBackup,
  verifyZipBackup,
  RESTORE_CONFIRM_TOKEN,
  ZIP_ARCHIVE_CODES,
} from '../backup/zip-archive.mjs';
import { attachRootSessions, importOfficialSessionZip, sessionWorkspaceSlug } from '../backup/session-zip.mjs';
import { defaultBackupDir, resolveDshHome } from './backup.mjs';
import { loadDefineTool } from './tools/shared.mjs';

/** The plugin name the row mounts (`name:` in the patch is the package subpath). */
export const name = 'w2m-dsh-backup-plugin';

/**
 * No service is required to mount. `tools` is requested opportunistically through `ctx.inject`: a host
 * without it still loads the plugin (and says so), instead of failing the whole profile at boot.
 */
export const inject = [];

/** The six tool names, in the BackUP-dsh-plugin contract's spelling. */
export const TOOL_NAMES = Object.freeze([
  'backup_create',
  'backup_import_session_zip',
  'backup_list',
  'backup_restore',
  'backup_status',
  'backup_verify',
]);

/** Directory names a project backup skips by default (the sibling plugin's list, unchanged). */
export const DEFAULT_EXCLUDE = Object.freeze([
  'node_modules',
  '.git',
  'dist',
  'build',
  'sessions',
  'scratch',
  'archive',
  'runtime',
  '.secrets',
  '.tmp',
  '.cache',
]);

/** Default per-entry size cap (64 MiB), matching the contract this surface implements. */
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The panel routes this row owns (v3.5.6), all below one exact path prefix.
 *
 * The row used to mount **no** routes: the six tools were the whole surface, so the archive had no
 * interface a person could click. These five routes are that interface, and they are the *same* functions
 * the tools call -- see `runCreateArchive` / `runVerifyArchive` / `runRestoreArchive` /
 * `runImportSessionZip` below, which both halves share. Nothing here duplicates the engine.
 *
 * `health` is the B1 availability probe: a constant 200 that says "this row is mounted". The client
 * registers the archive tab only after that answer, so a disabled row's tab never appears (and the
 * `dsh-backup-panel` probes in `lib/client.js` decide whether the *panel* is reachable).
 */
export const ARCHIVE_ROUTE_PREFIX = '/api/w2m/backup/archive';

/** Every path this row registers, spelled once (the client compares against these strings). */
export const ARCHIVE_ROUTE_PATHS = Object.freeze({
  status: `${ARCHIVE_ROUTE_PREFIX}/status`,
  create: `${ARCHIVE_ROUTE_PREFIX}/create`,
  verify: `${ARCHIVE_ROUTE_PREFIX}/verify`,
  restore: `${ARCHIVE_ROUTE_PREFIX}/restore`,
  importZip: `${ARCHIVE_ROUTE_PREFIX}/import-zip`,
  health: `${ARCHIVE_ROUTE_PREFIX}/health`,
});

/** The row id this surface reports in its health answer and its status payload. */
export const ARCHIVE_ROW_ID = 'dsh-backup-plugin';

/** No cache anywhere: every answer is either a live read or the result of a write. */
const NO_STORE = { 'cache-control': 'no-store' };

/** The refusal an import path outside every allowed root gets (never a read, never an import). */
export const IMPORT_PATH_REFUSED = 'BACKUP_IMPORT_PATH_REFUSED';

/** `true`/`false`, plus the strings YAML users write when they quote a boolean. */
function asBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
    if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  }
  return fallback;
}

/** A trimmed string, or the fallback when absent/blank. */
function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

/** A list from a YAML list or a comma-separated string. */
function asList(value, fallback) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return [...fallback];
}

/** A non-negative integer, or the fallback. */
function asInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

/**
 * Normalize the row's configuration into everything the tool surface needs.
 *
 * `backupRoot` and `backupDir` are accepted because the two backup products name the same idea differently;
 * `backupRoot` wins. Paths are resolved against the process, never guessed later: a tool call must report
 * the directory it really used, or `backup_status` is decoration.
 *
 * @param {object} [config]
 * @param {{env?: Record<string, string|undefined>, platform?: string, cwd?: string}} [deps]
 * @returns {object} the resolved configuration (never throws)
 */
export function normalizePluginConfig(config = {}, deps = {}) {
  const source = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const cwd = deps.cwd ?? process.cwd();
  const dshHome = path.resolve(asString(source.dshHome) || resolveDshHome(env));
  const projectRootValue = asString(source.projectRoot) || asString(env.DSH_WORKSPACE) || cwd;
  const projectRootSource = asString(source.projectRoot) ? 'config' : asString(env.DSH_WORKSPACE) ? 'env-DSH_WORKSPACE' : 'cwd';
  const projectRoot = path.resolve(projectRootValue);
  const workspace = path.resolve(asString(source.workspace) || projectRoot);
  const profileDir = path.resolve(
    asString(source.profileDir) || asString(env.DSH_PROFILE_DIR) || path.join(dshHome, 'profiles', asString(env.DSH_PROFILE) || 'desktop'),
  );
  const backupRoot = path.resolve(
    asString(source.backupRoot) || asString(source.backupDir) || asString(env.W2M_BACKUP_DIR) || path.join(dshHome, 'backups', 'w2m-dsh-backup-plugin'),
  );
  const maxFileBytes = asInt(source.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  return {
    ok: true,
    dsh_home: dshHome,
    backup_root: backupRoot,
    project_root: projectRoot,
    project_root_source: projectRootSource,
    workspace,
    profile_dir: profileDir,
    include_project: asBool(source.includeProject, true),
    include_sessions: asBool(source.includeSessions, true),
    include_profile: asBool(source.includeProfile, false),
    exclude: asList(source.exclude, DEFAULT_EXCLUDE),
    max_file_bytes: maxFileBytes < 1024 ? 1024 : maxFileBytes,
    keep_backups: asInt(source.keepBackups, 0),
    default_backup_dir: defaultBackupDir(platform),
  };
}

/**
 * The engine's configuration shape, derived from the resolved one.
 *
 * The engine is deliberately independent of the row (`backup_root` -> `backupRoot`, ...), so the mapping
 * lives in exactly one place and an override passed to a tool call only has to change the keys a caller
 * actually asked about.
 *
 * @param {object} cfg
 * @param {object} [overrides]
 * @returns {object}
 */
export function engineConfig(cfg, overrides = {}) {
  const projectRoot = asString(overrides.projectRoot) || cfg.project_root;
  return {
    dshHome: cfg.dsh_home,
    backupRoot: cfg.backup_root,
    projectRoot,
    projectRootSource: asString(overrides.projectRoot) ? 'override' : cfg.project_root_source,
    workspace: asString(overrides.workspace) || cfg.workspace,
    profileDir: cfg.profile_dir,
    includeProject: overrides.includeProject === undefined ? cfg.include_project : overrides.includeProject === true,
    includeSessions: overrides.includeSessions === undefined ? cfg.include_sessions : overrides.includeSessions === true,
    includeProfile: overrides.includeProfile === undefined ? cfg.include_profile : overrides.includeProfile === true,
    exclude: cfg.exclude,
    maxFileBytes: cfg.max_file_bytes,
    keepBackups: cfg.keep_backups,
  };
}

/** Everything `backup_status` reports about the resolved configuration. */
function describeConfig(cfg) {
  return {
    dsh_home: cfg.dsh_home,
    backup_root: cfg.backup_root,
    project_root: cfg.project_root,
    project_root_source: cfg.project_root_source,
    workspace: cfg.workspace,
    workspace_slug: sessionWorkspaceSlug(cfg.workspace),
    profile_dir: cfg.profile_dir,
    include_project: cfg.include_project,
    include_sessions: cfg.include_sessions,
    include_profile: cfg.include_profile,
    exclude: cfg.exclude,
    max_file_bytes: cfg.max_file_bytes,
    keep_backups: cfg.keep_backups,
  };
}

/** Render a tool result as pretty JSON text. */
function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

/** A refusal every tool returns for an unexpected exception instead of throwing out of the registry. */
function failed(reasonCode, error) {
  return {
    ok: false,
    reason_code: reasonCode,
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** The text output shape every tool in this package uses. */
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/**
 * The five operations, as functions **both** faces call.
 *
 * The tool bodies and the panel routes must not be two implementations: a route that re-derived the
 * engine's argument mapping would drift from the tool the moment either side changed. So every entry
 * point -- `backup_create` in a conversation, `POST …/archive/create` from the panel -- calls one of
 * these, and these call the engine once. Each returns the engine's own value (ok, or the named
 * `{ok:false, reason_code, detail}` refusal); none throws.
 */

/** List archives: the call `backup_list` and `backup_status` already make. */
export function runListArchives({ cfg, limit = 50 } = {}) {
  try {
    return listZipBackups({ backupRoot: cfg.backup_root, limit: Number(limit) || 50 });
  } catch (error) {
    return failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error);
  }
}

/** Plan (`dry_run`) or perform a create; `args` carries the same overrides `backup_create` accepts. */
export function runCreateArchive({ cfg, args = {} } = {}) {
  try {
    return createZipBackup({
      config: engineConfig(cfg, args),
      label: typeof args.label === 'string' ? args.label : '',
      dryRun: args.dry_run === true,
    });
  } catch (error) {
    return failed(ZIP_ARCHIVE_CODES.WRITE_FAILED, error);
  }
}

/** Verify one archive, read-only. */
export function runVerifyArchive({ args = {} } = {}) {
  try {
    return verifyZipBackup({ archive: String(args.archive ?? '') });
  } catch (error) {
    return failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error);
  }
}

/**
 * Plan or apply a restore.
 *
 * The mapping is the one `backup_restore` documents: `mode` defaults to `plan`, `apply` needs
 * `confirm: "restore"` (enforced by the engine, not here), sessions default on, the profile is opt-in.
 */
export function runRestoreArchive({ cfg, args = {} } = {}) {
  try {
    return restoreZipBackup({
      archive: String(args.archive ?? ''),
      config: engineConfig(cfg),
      mode: args.mode === 'apply' ? 'apply' : 'plan',
      confirm: typeof args.confirm === 'string' ? args.confirm : '',
      targetProject: asString(args.targetProject) || undefined,
      overwrite: args.overwrite === true,
      includeSessions: args.includeSessions !== false,
      includeProfile: args.includeProfile === true,
      keepSessionIds: args.keepSessionIds === true,
      forceRunning: args.forceRunning === true,
    });
  } catch (error) {
    return failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error);
  }
}

/**
 * Import an official session-export ZIP, from a file path **or** bytes already in memory.
 *
 * The panel's upload arrives as bytes; the tool and the panel's "server path" field arrive as a path.
 * Both go through this one function so the collision rules (`keepIds` / `forceRunning`) and the
 * workspace-registry attachment cannot differ between the two faces.
 */
export function runImportSessionZip({ cfg, zip = '', buffer = null, args = {} } = {}) {
  const zipFile = String(zip ?? '');
  let bytes = buffer;
  if (bytes === null || bytes === undefined) {
    if (zipFile === '' || !fs.existsSync(zipFile)) {
      return { ok: false, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_MISSING, detail: `zip not found: ${zipFile || '(empty)'}` };
    }
    try {
      bytes = fs.readFileSync(zipFile);
    } catch (error) {
      return failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error);
    }
  }
  const workspace = path.resolve(asString(args.workspace) || cfg.workspace);
  let imported;
  try {
    imported = importOfficialSessionZip(bytes, {
      dshHome: cfg.dsh_home,
      workspace,
      keepIds: args.keepIds === true,
      replaceExisting: args.forceRunning === true,
    });
  } catch (error) {
    return failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error);
  }
  if (imported.ok !== true) return { ...imported, workspace };
  const attach =
    args.attach === false
      ? null
      : attachRootSessions({ dshHome: cfg.dsh_home, workspacePath: workspace, written: imported.written });
  return {
    ok: true,
    workspace,
    workspace_slug: sessionWorkspaceSlug(workspace),
    written: imported.written,
    replaced: imported.replaced,
    attachments: imported.attachments,
    roots: imported.roots,
    skipped: imported.skipped,
    attach,
    force_running: args.forceRunning === true,
  };
}

/**
 * Build the six definitions once per mount.
 *
 * @param {{cfg: object, defineTool: Function}} input
 * @returns {Array<object>} registered definitions (in registration order)
 */
export function buildTools(input) {
  const { cfg, defineTool } = input;
  const registered = [];
  const register = (definition) => {
    const tool = defineTool(definition);
    registered.push(tool);
    return tool;
  };

  register({
    name: 'backup_status',
    description:
      'Show the archive backup subplugin configuration, resolved directories, archive count and the newest archive. Read-only.',
    parameters: {},
    output: textOutput,
    async execute() {
      const listed = runListArchives({ cfg, limit: 500 });
      const archives = Array.isArray(listed.archives) ? listed.archives : [];
      const latest = archives[0] ?? null;
      return jsonText({
        plugin: name,
        config: describeConfig(cfg),
        resolved: {
          dsh_home: cfg.dsh_home,
          backup_root: cfg.backup_root,
          project_root: cfg.project_root,
          workspace: cfg.workspace,
          profile_dir: cfg.profile_dir,
        },
        archive_count: archives.length,
        latest,
        tools: [...TOOL_NAMES],
        routes: ARCHIVE_ROUTE_PATHS,
      });
    },
  });

  register({
    name: 'backup_create',
    description:
      'Create a timestamped ZIP backup of the project files and/or the DSH sessions bound to a workspace. Returns the archive path, size and SHA-256 plus per-source counts.',
    parameters: {
      label: { type: 'string', description: 'Optional short label appended to the archive file name.' },
      projectRoot: { type: 'string', description: 'Project directory to back up; defaults to config.projectRoot or the Host working directory.' },
      workspace: { type: 'string', description: 'Workspace whose DSH sessions are included; defaults to the project root.' },
      includeProject: { type: 'boolean', description: 'Include project files (default: config.includeProject).' },
      includeSessions: { type: 'boolean', description: 'Include DSH sessions for the workspace (default: config.includeSessions).' },
      includeProfile: { type: 'boolean', description: 'Include profile package.json/cordis files (default: config.includeProfile).' },
    },
    output: textOutput,
    async execute(args = {}) {
      return jsonText(runCreateArchive({ cfg, args }));
    },
  });

  register({
    name: 'backup_list',
    description: 'List existing backup archives (newest first) with their manifest summary; unreadable archives are reported with an error field.',
    parameters: {
      limit: { type: 'number', description: 'Maximum archives to return (default 50).' },
    },
    output: textOutput,
    async execute(args = {}) {
      return jsonText(runListArchives({ cfg, limit: Number(args.limit) || 50 }));
    },
  });

  register({
    name: 'backup_verify',
    description:
      'Recompute SHA-256 for every archive entry and compare it with the manifest. Returns missing, mismatched and extra entries; does not modify anything.',
    parameters: {
      archive: { type: 'string', required: true, description: 'Absolute path to a backup ZIP.' },
    },
    output: textOutput,
    async execute(args = {}) {
      return jsonText(runVerifyArchive({ args }));
    },
  });

  register({
    name: 'backup_restore',
    description:
      'Plan or apply a restore. mode="plan" (default) reports files to create/conflicts and sessions to import; mode="apply" writes them and requires confirm:"restore". Every file overwritten is copied to <DSH_HOME>/.w2m-restore-backups/ first. Sessions always get new ids unless keepSessionIds=true (refused on collision; forceRunning=true copies each existing session directory to .w2m-restore-backups/sessions-<UTC>/ first and replaces it). Profile files are only touched with includeProfile=true.',
    parameters: {
      archive: { type: 'string', required: true, description: 'Absolute path to a backup ZIP.' },
      mode: { type: 'string', description: 'plan (default) or apply.' },
      confirm: {
        type: 'string',
        description: 'Required for mode="apply": the literal token "restore". A value that is not the token is refused before anything is written.',
      },
      targetProject: { type: 'string', description: 'Directory to restore project files into; defaults to the archive projectRoot.' },
      overwrite: { type: 'boolean', description: 'Replace existing files that differ (default false).' },
      includeSessions: { type: 'boolean', description: 'Restore DSH sessions (default true).' },
      includeProfile: { type: 'boolean', description: 'Restore profile files (default false).' },
      keepSessionIds: { type: 'boolean', description: 'Keep original session ids; refused when they already exist.' },
      forceRunning: {
        type: 'boolean',
        description:
          'Resolve a keepSessionIds collision instead of refusing: copy the existing session directory to <DSH_HOME>/.w2m-restore-backups/sessions-<UTC>/<projectKey>/<id>/ first, then replace it with the restored log. The replacements are reported in replaced[].',
      },
    },
    output: textOutput,
    async execute(args = {}) {
      return jsonText(runRestoreArchive({ cfg, args }));
    },
  });

  register({
    name: 'backup_import_session_zip',
    description:
      'Import an official DSH session export ZIP (session.v4.jsonl + subagents/media/files) into a workspace. New session ids are allocated unless keepIds=true; a keepIds collision is refused unless forceRunning=true, which copies the existing session directory to .w2m-restore-backups/sessions-<UTC>/ first and replaces it. The root session is attached to the workspace registry.',
    parameters: {
      zip: { type: 'string', required: true, description: 'Absolute path to the official dsh-session-*.zip.' },
      workspace: { type: 'string', description: 'Target workspace; defaults to the configured workspace/project root.' },
      keepIds: { type: 'boolean', description: 'Keep the exported session ids; refused when they already exist unless forceRunning=true.' },
      attach: { type: 'boolean', description: 'Attach the imported root session to the workspace (default true).' },
      forceRunning: {
        type: 'boolean',
        description:
          'Resolve a keepIds collision instead of refusing: copy the existing session directory to <DSH_HOME>/.w2m-restore-backups/sessions-<UTC>/<projectKey>/<id>/ first, then replace it with the imported log. The replacements are reported in replaced[].',
      },
    },
    output: textOutput,
    async execute(args = {}) {
      return jsonText(runImportSessionZip({ cfg, zip: String(args.zip ?? ''), args }));
    },
  });

  return registered;
}

/**
 * Resolve an import path against the allowed roots, refusing anything else.
 *
 * The panel accepts a **server path** as an alternative to an upload, which means an HTTP request can
 * name a file. Restricting that to the archive root, the DSH home and the project/workspace roots (plus
 * the OS temp directory, where a browser download or a test fixture lands) keeps the route from becoming
 * a "read any file on this machine" primitive. The check is on the resolved absolute path, so `..`
 * segments cannot escape.
 *
 * @param {string} zipPath
 * @param {string[]} roots absolute directories the caller may read from
 * @returns {{ok: true, path: string}|{ok: false, reason_code: string, detail: string}}
 */
export function resolveImportPath(zipPath, roots) {
  const value = String(zipPath ?? '').trim();
  if (value === '') return { ok: false, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_MISSING, detail: 'zip is required' };
  const resolved = path.resolve(value);
  if (!resolved.toLowerCase().endsWith('.zip')) {
    return { ok: false, reason_code: IMPORT_PATH_REFUSED, detail: `not a .zip path: ${resolved}` };
  }
  const inside = (roots ?? []).some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) {
    return { ok: false, reason_code: IMPORT_PATH_REFUSED, detail: `path is outside the allowed roots (${(roots ?? []).join(', ')}): ${resolved}` };
  }
  return { ok: true, path: resolved };
}

/**
 * The archive surface's panel routes (v3.5.6), plus its availability probe.
 *
 * Six exact routes on the host's Connection registry. A row that is not mounted registers none of them,
 * so every one answers 404 -- that is what makes "the archive row is enabled" observable from a page
 * without a second cross-row service (the B1 design). The auth boundary is the one every sibling
 * `/api/w2m/*` route already has: the carrier applies its Host/Origin fence and browser-session check
 * **before** these handlers run, and only an authenticated owner Peer reaches an exact route (any other
 * principal is answered 403 by the carrier). No handler here reads or returns a credential.
 *
 * Every write route answers with the tools' own result shape (`ok` / `reason_code` / `detail`), and every
 * one calls the same `runCreateArchive` / `runVerifyArchive` / `runRestoreArchive` / `runImportSessionZip`
 * the six tools call. There is no second restore or verify implementation behind this file.
 *
 * @param {object} ctx Cordis context
 * @param {object} cfg resolved row configuration (`normalizePluginConfig` output)
 * @param {{maxImportBytes?: number}} [deps] upload cap (tests inject a small one)
 * @returns {{mounted: boolean, reason: string|null, paths: string[]}}
 */
export function registerArchiveRoutes(ctx, cfg, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service', paths: Object.values(ARCHIVE_ROUTE_PATHS) };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    const maxImportBytes = Number.isSafeInteger(deps.maxImportBytes) ? deps.maxImportBytes : 256 * 1024 * 1024;
    const json = (payload, init = {}) => Response.json(payload, { headers: NO_STORE, ...init });
    const refuse = (reason_code, detail, code = 400) => json({ ok: false, reason_code, detail }, { status: code });
    const readBody = async (request) => {
      try {
        const body = await request.json();
        return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
      } catch {
        return {};
      }
    };
    const allowedRoots = () => [cfg.backup_root, cfg.dsh_home, cfg.project_root, cfg.workspace, os.tmpdir()].map((root) => path.resolve(root));
    const describe = () => {
      const listed = runListArchives({ cfg, limit: 50 });
      const archives = Array.isArray(listed.archives) ? listed.archives : [];
      return {
        ok: true,
        row: ARCHIVE_ROW_ID,
        route_prefix: ARCHIVE_ROUTE_PREFIX,
        config: describeConfig(cfg),
        archive_root: cfg.backup_root,
        archive_count: archives.length,
        latest: archives[0] ?? null,
        archives,
        restore_confirm_token: RESTORE_CONFIRM_TOKEN,
      };
    };
    // The reads declare both methods too, so a caller that guesses wrong gets the named 405 rather than the
    // shared channel's answer; that is the same shape the sibling `/api/w2m/backup/*` routes use.
    registry.register({
      path: ARCHIVE_ROUTE_PATHS.health,
      methods: ['GET'],
      requestBody: 'buffered',
      // Constant, side-effect free, and it never touches the disk: a probe must not create the archive root.
      fetch: async () => json({ ok: true, row: ARCHIVE_ROW_ID, mounted: true }),
    });
    registry.register({
      path: ARCHIVE_ROUTE_PATHS.status,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'GET') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
        try {
          return json(describe());
        } catch (error) {
          return refuse(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error instanceof Error ? error.message : String(error), 500);
        }
      },
    });
    registry.register({
      path: ARCHIVE_ROUTE_PATHS.create,
      methods: ['POST', 'GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
        return json(runCreateArchive({ cfg, args: await readBody(request) }));
      },
    });
    registry.register({
      path: ARCHIVE_ROUTE_PATHS.verify,
      methods: ['POST', 'GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
        return json(runVerifyArchive({ args: await readBody(request) }));
      },
    });
    registry.register({
      path: ARCHIVE_ROUTE_PATHS.restore,
      methods: ['POST', 'GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
        // `mode` and `confirm` travel unchanged: the engine is the only place that decides whether an apply
        // is allowed, so this route cannot be more permissive than the tool.
        return json(runRestoreArchive({ cfg, args: await readBody(request) }));
      },
    });
    registry.register({
      path: ARCHIVE_ROUTE_PATHS.importZip,
      methods: ['POST', 'GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', `${request.method} is not a method this route answers`, 405);
        const body = await readBody(request);
        const zipPath = typeof body.zip === 'string' ? body.zip : '';
        let buffer = null;
        if (zipPath === '' && typeof body.data_base64 === 'string') {
          const encoded = body.data_base64.replace(/^data:[^;]+;base64,/u, '');
          if (encoded.length > Math.ceil(maxImportBytes * 4 / 3) + 4) {
            return refuse('BACKUP_IMPORT_TOO_LARGE', `the upload exceeds ${maxImportBytes} bytes`, 413);
          }
          buffer = Buffer.from(encoded, 'base64');
          if (buffer.length === 0) return refuse(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, 'data_base64 did not decode to any bytes');
        } else if (zipPath !== '') {
          const checked = resolveImportPath(zipPath, allowedRoots());
          if (checked.ok !== true) return refuse(checked.reason_code, checked.detail, 403);
        } else {
          return refuse(ZIP_ARCHIVE_CODES.ARCHIVE_MISSING, 'a JSON body with {"zip": "<server path>"} or {"data_base64": "…"} is required');
        }
        return json(runImportSessionZip({ cfg, zip: zipPath, buffer, args: body }));
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}


/**
 * Mount the subplugin.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] row configuration (`backupRoot`, `projectRoot`, `workspace`, `includeProject`,
 *   `includeSessions`, `includeProfile`, `exclude`, `maxFileBytes`, `keepBackups`)
 * @param {{defineTool?: Function, env?: Record<string,string|undefined>, platform?: string,
 *   loadDefineTool?: Function, maxImportBytes?: number}} [deps] injectable seams for the tests
 * @returns {Promise<{ok: boolean, mounted: boolean, name: string, registered: string[], routes: string[],
 *   routes_mounted: boolean, config: object}>}
 */
export async function apply(ctx, config = {}, deps = {}) {
  const cfg = normalizePluginConfig(config, deps);
  ctx.logger?.info?.(
    `${name}: configured; backupRoot=${cfg.backup_root} projectRoot=${cfg.project_root} ` +
      `(from ${cfg.project_root_source}) workspace=${cfg.workspace}`,
  );
  let disposed = false;
  ctx.effect?.(() => () => {
    disposed = true;
  });
  const defineTool = typeof deps.defineTool === 'function' ? deps.defineTool : (await (deps.loadDefineTool ?? loadDefineTool)()).defineTool;
  const registered = [];

  const install = (child) => {
    if (child === null || typeof child !== 'object' || child.tools === undefined || typeof child.tools.register !== 'function') {
      ctx.logger?.warn?.(`${name}: the host provided no tools service; the six backup tools are not registered`);
      return;
    }
    for (const definition of buildTools({ cfg, defineTool })) {
      child.tools.register(definition);
      registered.push(definition.name);
    }
    ctx.logger?.info?.(`${name}: registered ${registered.length} tool(s)`);
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], install);
  } else {
    install(ctx);
  }

  // v3.5.6/A1: the archive surface's panel routes, and B1's availability probe, are mounted by this row.
  // Mounting a disabled row is not possible at all (Cordis never calls apply), so "no route" is the
  // absence of this row -- exactly the signal the client probes and the 404 it expects.
  const routes = registerArchiveRoutes(ctx, cfg, deps);

  // A Cordis host treats a plugin's return value as an **effect**: a function is a disposer, anything else
  // is "Invalid effect". The mount report the tests read is therefore carried *on* the disposer (properties
  // on a function are legal), not returned as a bare object — that shape failed to mount in the real host
  // (`include:dsh-backup-plugin` fiber `failed`, diagnostic "Invalid effect") while every fake-ctx test passed.
  const dispose = () => {
    disposed = true;
  };
  for (const [key, value] of Object.entries({
    ok: true,
    mounted: true,
    registered,
    disposed: () => disposed,
    routes: [...routes.paths],
    routes_mounted: routes.mounted,
    config: describeConfig(cfg),
  })) {
    dispose[key] = value;
  }
  Object.defineProperty(dispose, 'name', { value: name, configurable: true });
  return dispose;
}
