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
 * Accepted for contract compatibility on `backup_restore` / `backup_import_session_zip`. The DSH client
 * owns `storages/workspace.json` and rewrites it from memory, so this build never edits that document
 * directly: it plans through `registry.mjs`, writes atomically, reads back, and returns the residual
 * client-overwrite warning with every successful registration. A boolean that changed none of that would
 * be a lie in the tool schema, so it is documented as accepted-and-reported rather than honoured.
 */

import fs from 'node:fs';
import path from 'node:path';

import { listZipBackups, createZipBackup, restoreZipBackup, verifyZipBackup, ZIP_ARCHIVE_CODES } from '../backup/zip-archive.mjs';
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
      const listed = listZipBackups({ backupRoot: cfg.backup_root, limit: 500 });
      const latest = listed.archives[0] ?? null;
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
        archive_count: listed.archives.length,
        latest,
        tools: [...TOOL_NAMES],
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
      try {
        return jsonText(createZipBackup({ config: engineConfig(cfg, args), label: typeof args.label === 'string' ? args.label : '' }));
      } catch (error) {
        return jsonText(failed(ZIP_ARCHIVE_CODES.WRITE_FAILED, error));
      }
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
      try {
        return jsonText(listZipBackups({ backupRoot: cfg.backup_root, limit: Number(args.limit) || 50 }));
      } catch (error) {
        return jsonText(failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error));
      }
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
      try {
        return jsonText(verifyZipBackup({ archive: String(args.archive ?? '') }));
      } catch (error) {
        return jsonText(failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error));
      }
    },
  });

  register({
    name: 'backup_restore',
    description:
      'Plan or apply a restore. mode="plan" (default) reports files to create/conflicts and sessions to import; mode="apply" writes them and requires confirm:"restore". Every file overwritten is copied to <DSH_HOME>/.w2m-restore-backups/ first. Sessions always get new ids unless keepSessionIds=true (refused on collision). Profile files are only touched with includeProfile=true.',
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
          'Accepted for contract compatibility. This build always plans/writes the workspace registry through the read-back protocol and reports the client-overwrite warning instead of refusing while the client runs.',
      },
    },
    output: textOutput,
    async execute(args = {}) {
      try {
        return jsonText(
          restoreZipBackup({
            archive: String(args.archive ?? ''),
            config: engineConfig(cfg),
            mode: args.mode === 'apply' ? 'apply' : 'plan',
            confirm: typeof args.confirm === 'string' ? args.confirm : '',
            targetProject: asString(args.targetProject) || undefined,
            overwrite: args.overwrite === true,
            includeSessions: args.includeSessions !== false,
            includeProfile: args.includeProfile === true,
            keepSessionIds: args.keepSessionIds === true,
          }),
        );
      } catch (error) {
        return jsonText(failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error));
      }
    },
  });

  register({
    name: 'backup_import_session_zip',
    description:
      'Import an official DSH session export ZIP (session.v4.jsonl + subagents/media/files) into a workspace. New session ids are allocated unless keepIds=true; the root session is attached to the workspace registry.',
    parameters: {
      zip: { type: 'string', required: true, description: 'Absolute path to the official dsh-session-*.zip.' },
      workspace: { type: 'string', description: 'Target workspace; defaults to the configured workspace/project root.' },
      keepIds: { type: 'boolean', description: 'Keep the exported session ids; refused when they already exist.' },
      attach: { type: 'boolean', description: 'Attach the imported root session to the workspace (default true).' },
      forceRunning: {
        type: 'boolean',
        description: 'Accepted for contract compatibility; see backup_restore (registry writes always use the read-back protocol).',
      },
    },
    output: textOutput,
    async execute(args = {}) {
      const zipFile = String(args.zip ?? '');
      if (zipFile === '' || !fs.existsSync(zipFile)) {
        return jsonText({ ok: false, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_MISSING, detail: `zip not found: ${zipFile || '(empty)'}` });
      }
      const workspace = path.resolve(asString(args.workspace) || cfg.workspace);
      let imported;
      try {
        imported = importOfficialSessionZip(fs.readFileSync(zipFile), {
          dshHome: cfg.dsh_home,
          workspace,
          keepIds: args.keepIds === true,
        });
      } catch (error) {
        return jsonText(failed(ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, error));
      }
      if (imported.ok !== true) return jsonText({ ...imported, workspace });
      const attach =
        args.attach === false
          ? null
          : attachRootSessions({ dshHome: cfg.dsh_home, workspacePath: workspace, written: imported.written });
      return jsonText({
        ok: true,
        workspace,
        workspace_slug: sessionWorkspaceSlug(workspace),
        written: imported.written,
        attachments: imported.attachments,
        roots: imported.roots,
        skipped: imported.skipped,
        attach,
        force_running: args.forceRunning === true,
      });
    },
  });

  return registered;
}

/**
 * Mount the subplugin.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] row configuration (`backupRoot`, `projectRoot`, `workspace`, `includeProject`,
 *   `includeSessions`, `includeProfile`, `exclude`, `maxFileBytes`, `keepBackups`)
 * @param {{defineTool?: Function, env?: Record<string,string|undefined>, platform?: string,
 *   loadDefineTool?: Function}} [deps] injectable seams for the tests
 * @returns {Promise<{ok: boolean, mounted: boolean, name: string, registered: string[], config: object}>}
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

  return {
    ok: true,
    mounted: true,
    name,
    registered,
    disposed: () => disposed,
    config: describeConfig(cfg),
  };
}
