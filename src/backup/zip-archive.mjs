/**
 * The `dsh-backup-plugin` archive engine: create, list, verify and restore self-contained ZIP backups.
 *
 * ## What an archive is
 *
 * One file a person can copy to another machine. It carries the project tree, the DSH sessions bound to a
 * workspace, and (opt-in) the profile's `package.json` / patch files, with a `manifest.json` that records
 * the size and SHA-256 of every payload entry. `backup_verify` recomputes those digests from the bytes in
 * the ZIP; nothing is trusted from the ZIP headers or from the manifest alone.
 *
 * ## Why this is not the scheduled engine
 *
 * `src/backup/engine.mjs` maintains a content-addressed, optionally sealed *repository* with rotation and
 * a nightly timer, mounted by the `dsh-backup` row. This module is the model-facing archive surface of the
 * `dsh-backup-plugin` row: stateless (every call resolves its configuration, reads or writes one archive
 * and returns a report), plaintext by contract, and bounded by `maxFileBytes` per entry. The two engines
 * share the lower layers instead of re-implementing them: the scan (`scan.mjs`), the durable writer
 * (`atomic.mjs`), the digest (`manifest.mjs`) and the session frames (`fix/zstd.mjs`).
 *
 * ## Failure semantics
 *
 * Every refusal is a named `{ok:false, reason_code, detail}` value, never a throw: a tool call that cannot
 * create a backup must say why (missing project, nothing selected, id conflict, unreadable archive) in
 * terms the model can report, and a restore is refused rather than performed when the archive does not
 * verify. `restore` in `plan` mode writes nothing at all.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './atomic.mjs';
import { sha256Hex } from './manifest.mjs';
import { scanSessions } from './scan.mjs';
import { attachRootSessions, canonicalPath, decodeStoredSession, sessionWorkspaceSlug, storedSessionIds, writeSessionSet } from './session-zip.mjs';
import { readZip, writeZip } from './zip.mjs';

/** The archive's own manifest format, so a foreign ZIP is refused by name rather than misread. */
export const ZIP_ARCHIVE_FORMAT = 'w2m-dsh-backup/archive';

/** Archive manifest version. */
export const ZIP_ARCHIVE_VERSION = 1;

/** The tool that writes it (named in the manifest). */
export const ZIP_ARCHIVE_TOOL = 'w2m-dsh-backup-plugin';

/** Profile files a backup may carry (only with `includeProfile`). */
export const PROFILE_FILES = Object.freeze(['package.json', 'cordis.patch.yml', 'cordis.yml']);

/** Named refusals. */
export const ZIP_ARCHIVE_CODES = Object.freeze({
  CONFIG_INVALID: 'BACKUP_CONFIG_INVALID',
  PROJECT_MISSING: 'BACKUP_PROJECT_MISSING',
  NOTHING: 'BACKUP_NOTHING_TO_BACK_UP',
  WRITE_FAILED: 'BACKUP_WRITE_FAILED',
  ARCHIVE_MISSING: 'BACKUP_ARCHIVE_MISSING',
  ARCHIVE_UNREADABLE: 'BACKUP_ARCHIVE_UNREADABLE',
  ARCHIVE_VERIFY_FAILED: 'BACKUP_ARCHIVE_VERIFY_FAILED',
  SESSION_UNREADABLE: 'BACKUP_SESSION_UNREADABLE',
  SESSION_ID_CONFLICT: 'BACKUP_SESSION_ID_CONFLICT',
  CONFIRM_REQUIRED: 'BACKUP_RESTORE_CONFIRM_REQUIRED',
});

/** The token `backup_restore` in apply mode must carry (the same spelling the host routes use). */
export const RESTORE_CONFIRM_TOKEN = 'restore';

/**
 * Pre-restore copies live under the home root, outside every scan root.
 *
 * Deliberately the same directory name as `src/backup/scopes.mjs#RESTORE_COPY_ROOT` (the repository restore's
 * root): one home, one recovery area, and the scanners already know to skip it. The value is repeated rather than
 * imported so this stateless archive engine does not load the repository module graph just to read a string.
 */
export const RESTORE_COPY_ROOT = '.w2m-restore-backups';

const PROJECT_PREFIX = 'project/';
const SESSION_PREFIX = 'sessions/';
const PROFILE_PREFIX = 'profile/';

/** `20261121-153000` in local time, the archive-name stamp. */
export function archiveStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** A label reduced to a filename-safe suffix (empty when nothing survives). */
export function sanitizeLabel(label) {
  return String(label ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** POSIX-separated path. */
function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

/**
 * Join an archive-relative path under `root`, refusing traversal.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {string|null} null when the joined path would leave `root`
 */
export function safeArchiveTarget(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/**
 * The directory one apply's pre-restore copies go into.
 *
 * Lives under `$DSH_HOME/.w2m-restore-backups/` -- the same root the repository restore uses, outside every scan
 * root, so a later backup can never pick a recovery copy up as a session. `plan` never creates it.
 *
 * @param {string} dshHome
 * @param {Date} [now]
 * @returns {string}
 */
export function restoreCopyDir(dshHome, now = new Date()) {
  return path.join(path.resolve(dshHome), RESTORE_COPY_ROOT, `archive-${now.toISOString().replace(/[-:.]/g, '')}`);
}

/**
 * Walk regular files under `root`, skipping excluded directory names and symlinks.
 *
 * Symlinks are reported in `skipped` rather than followed: a backup that silently materialises what a
 * link points at is a backup of something the project did not contain.
 *
 * @param {string} root
 * @param {{excludeDirs?: string[], maxFileBytes?: number}} [options]
 * @returns {{files: Array<{rel: string, abs: string, size: number, mtime_ms: number}>, skipped: Array<{path: string, source: string, reason: string}>}}
 */
export function walkProjectFiles(root, options = {}) {
  const excluded = new Set((options.excludeDirs ?? []).map((name) => String(name).toLowerCase()));
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : Number.POSITIVE_INFINITY;
  const files = [];
  const skipped = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: toPosix(path.relative(root, dir)) || '.', source: 'project', reason: `unreadable directory (${error?.code ?? 'unknown'})` });
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(dir, entry.name);
      let info;
      try {
        info = fs.lstatSync(absolute);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        skipped.push({ path: toPosix(path.relative(root, absolute)), source: 'project', reason: 'symlink' });
        continue;
      }
      if (info.isDirectory()) {
        if (excluded.has(entry.name.toLowerCase())) continue;
        visit(absolute);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > maxFileBytes) {
        skipped.push({ path: toPosix(path.relative(root, absolute)), source: 'project', reason: `larger than ${maxFileBytes} bytes` });
        continue;
      }
      files.push({ rel: toPosix(path.relative(root, absolute)), abs: absolute, size: info.size, mtime_ms: Math.round(info.mtimeMs) });
    }
  };
  visit(path.resolve(root));
  files.sort((left, right) => left.rel.localeCompare(right.rel));
  return { files, skipped };
}

/**
 * Whether `child` is inside `parent` (the backup root must not back itself up).
 *
 * @param {string} parent
 * @param {string} child
 * @returns {string|null} the first relative segment, or null when outside
 */
function insideSegments(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel).split('/')[0];
}

/**
 * The README carried in every archive (a human opening the ZIP must not need this repository).
 *
 * @param {object} manifest
 * @returns {string}
 */
function archiveReadme(manifest) {
  return [
    'W2M backup archive (dsh-backup-plugin)',
    `created_at  : ${manifest.created_at}`,
    `label       : ${manifest.label || '(none)'}`,
    `project_root: ${manifest.project_root}`,
    `workspace   : ${manifest.workspace}`,
    `project     : ${manifest.counts.project} file(s)`,
    `sessions    : ${manifest.counts.sessions}`,
    `profile     : ${manifest.counts.profile} file(s)`,
    '',
    'manifest.json lists every payload entry with its size and sha256.',
    'The archive is NOT encrypted: anyone who can read it can read the sessions it carries.',
    'Verify it with backup_verify; restore it with backup_restore (plan first).',
    '',
  ].join('\n');
}

/**
 * Create one archive.
 *
 * @param {{config: object, label?: string, now?: Date}} input `config` is the resolved tool configuration
 *   (`backupRoot`, `projectRoot`, `workspace`, `profileDir`, `dshHome`, `includeProject`,
 *   `includeSessions`, `includeProfile`, `exclude`, `maxFileBytes`, `keepBackups`, `projectRootSource`).
 * @returns {object} a summary, or `{ok:false, reason_code, detail}`
 */
export function createZipBackup(input) {
  const config = input.config;
  const now = input.now ?? new Date();
  const includeProject = config.includeProject === true;
  const includeSessions = config.includeSessions === true;
  const includeProfile = config.includeProfile === true;
  if (!includeProject && !includeSessions && !includeProfile) {
    return { ok: false, reason_code: ZIP_ARCHIVE_CODES.NOTHING, detail: 'includeProject, includeSessions and includeProfile are all off' };
  }
  const projectRoot = path.resolve(config.projectRoot);
  if (includeProject && !fs.existsSync(projectRoot)) {
    return { ok: false, reason_code: ZIP_ARCHIVE_CODES.PROJECT_MISSING, detail: `project root does not exist: ${projectRoot}` };
  }

  const manifest = {
    format: ZIP_ARCHIVE_FORMAT,
    version: ZIP_ARCHIVE_VERSION,
    tool: ZIP_ARCHIVE_TOOL,
    created_at: now.toISOString(),
    label: String(input.label ?? ''),
    dsh_home: path.resolve(config.dshHome),
    project_root: projectRoot,
    project_root_source: config.projectRootSource ?? 'config',
    workspace: path.resolve(config.workspace),
    profile_dir: path.resolve(config.profileDir),
    include: { project: includeProject, sessions: includeSessions, profile: includeProfile },
    counts: { project: 0, sessions: 0, profile: 0, skipped: 0, bytes: 0 },
    files: [],
    skipped: [],
  };
  const payload = [];

  if (includeProject) {
    const exclude = [...(config.exclude ?? [])];
    const backupSegment = insideSegments(projectRoot, config.backupRoot);
    if (backupSegment !== null) exclude.push(backupSegment);
    const walk = walkProjectFiles(projectRoot, { excludeDirs: exclude, maxFileBytes: config.maxFileBytes });
    for (const file of walk.files) {
      const data = fs.readFileSync(file.abs);
      manifest.files.push({
        rel: `${PROJECT_PREFIX}${file.rel}`,
        kind: 'project',
        size: data.length,
        mtime_ms: file.mtime_ms,
        sha256: sha256Hex(data),
      });
      payload.push({ name: `${PROJECT_PREFIX}${file.rel}`, data });
      manifest.counts.bytes += data.length;
    }
    manifest.counts.project = walk.files.length;
    manifest.skipped.push(...walk.skipped);
  }

  if (includeSessions) {
    const workspace = canonicalPath(config.workspace);
    const scan = scanSessions({ dshHome: manifest.dsh_home });
    const wantedSlug = sessionWorkspaceSlug(workspace).toLowerCase();
    for (const row of scan.sessions) {
      const cwd = row.header?.cwd ?? null;
      const matches =
        cwd !== null
          ? canonicalPath(cwd) === workspace || sessionWorkspaceSlug(cwd).toLowerCase() === wantedSlug
          : row.workspace.toLowerCase() === wantedSlug;
      if (!matches) continue;
      if (row.ok !== true) {
        manifest.skipped.push({ path: row.rel, source: 'session', reason: row.detail ?? 'unreadable session header' });
        continue;
      }
      let data;
      try {
        const info = fs.statSync(row.file);
        if (info.size > config.maxFileBytes) {
          manifest.skipped.push({ path: row.rel, source: 'session', reason: `larger than ${config.maxFileBytes} bytes` });
          continue;
        }
        data = fs.readFileSync(row.file);
      } catch (error) {
        manifest.skipped.push({ path: row.rel, source: 'session', reason: `unreadable: ${error?.code ?? 'unknown'}` });
        continue;
      }
      const rel = `${SESSION_PREFIX}${row.workspace}/${row.session_id}/${path.basename(row.file)}`;
      manifest.files.push({
        rel,
        kind: 'session',
        size: data.length,
        mtime_ms: row.mtime_ms,
        sha256: sha256Hex(data),
        session_id: row.session_id,
        workspace: row.workspace,
        parent_session: null,
      });
      payload.push({ name: rel, data });
      manifest.counts.sessions += 1;
      manifest.counts.bytes += data.length;
    }
  }

  if (includeProfile) {
    for (const name of PROFILE_FILES) {
      const file = path.join(manifest.profile_dir, name);
      if (!fs.existsSync(file)) continue;
      const info = fs.statSync(file);
      if (info.size > config.maxFileBytes) {
        manifest.skipped.push({ path: `${PROFILE_PREFIX}${name}`, source: 'profile', reason: `larger than ${config.maxFileBytes} bytes` });
        continue;
      }
      const data = fs.readFileSync(file);
      manifest.files.push({ rel: `${PROFILE_PREFIX}${name}`, kind: 'profile', size: data.length, sha256: sha256Hex(data) });
      payload.push({ name: `${PROFILE_PREFIX}${name}`, data });
      manifest.counts.profile += 1;
      manifest.counts.bytes += data.length;
    }
  }

  manifest.counts.skipped = manifest.skipped.length;
  if (payload.length === 0) {
    return {
      ok: false,
      reason_code: ZIP_ARCHIVE_CODES.NOTHING,
      detail: `nothing to back up under ${projectRoot} with the selected sources`,
      skipped: manifest.skipped,
    };
  }

  const suffix = sanitizeLabel(input.label);
  const archive = path.join(path.resolve(config.backupRoot), `backup-${archiveStamp(now)}${suffix === '' ? '' : `-${suffix}`}.zip`);
  let buffer;
  try {
    buffer = writeZip([
      { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
      { name: 'README.txt', data: archiveReadme(manifest) },
      ...payload,
    ]);
    writeFileAtomic(archive, buffer);
  } catch (error) {
    return { ok: false, reason_code: ZIP_ARCHIVE_CODES.WRITE_FAILED, detail: error?.detail ?? String(error instanceof Error ? error.message : error) };
  }

  const pruned = pruneArchives(config.backupRoot, config.keepBackups);
  const warnings = [];
  if (manifest.project_root_source === 'cwd') {
    warnings.push('projectRoot came from the Host working directory; set projectRoot in the row config or pass projectRoot explicitly');
  }
  return {
    ok: true,
    archive,
    size: buffer.length,
    sha256: sha256Hex(buffer),
    files: manifest.counts.project,
    sessions: manifest.counts.sessions,
    profile_files: manifest.counts.profile,
    skipped: manifest.counts.skipped,
    skipped_entries: manifest.skipped,
    workspace: manifest.workspace,
    project_root: manifest.project_root,
    project_root_source: manifest.project_root_source,
    pruned,
    warnings,
  };
}

/**
 * Keep only the newest `keep` archives; `0` (or anything non-positive) keeps everything.
 *
 * @param {string} backupRoot
 * @param {number} keep
 * @returns {string[]} the archives removed
 */
export function pruneArchives(backupRoot, keep) {
  if (!(Number.isSafeInteger(keep) && keep > 0)) return [];
  const root = path.resolve(backupRoot);
  if (!fs.existsSync(root)) return [];
  const archives = fs
    .readdirSync(root)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => path.join(root, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  const removed = [];
  for (const file of archives.slice(keep)) {
    try {
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch {
      /* best effort: one undeletable archive must not fail the backup that succeeded */
    }
  }
  return removed;
}

/**
 * List archives newest first, with their manifest summary.
 *
 * An archive that cannot be read is still listed, with an `error` field: hiding it would make the archive
 * count disagree with what is on disk.
 *
 * @param {{backupRoot: string, limit?: number}} input
 * @returns {{ok: true, backup_root: string, archives: Array<object>}}
 */
export function listZipBackups(input) {
  const root = path.resolve(input.backupRoot);
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(500, Math.trunc(input.limit))) : 50;
  if (!fs.existsSync(root)) return { ok: true, backup_root: root, archives: [] };
  const archives = fs
    .readdirSync(root)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => path.join(root, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
    .slice(0, limit)
    .map((file) => {
      const stat = fs.statSync(file);
      let manifest = null;
      let error = null;
      try {
        manifest = readZipArchive(file).manifest;
      } catch (problem) {
        error = problem instanceof Error ? problem.message : String(problem);
      }
      return {
        archive: file,
        name: path.basename(file),
        size: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
        created_at: manifest?.created_at ?? null,
        label: manifest?.label ?? null,
        project_root: manifest?.project_root ?? null,
        workspace: manifest?.workspace ?? null,
        files: manifest?.counts?.project ?? null,
        sessions: manifest?.counts?.sessions ?? null,
        profile_files: manifest?.counts?.profile ?? null,
        error,
      };
    });
  return { ok: true, backup_root: root, archives };
}

/**
 * Read one archive's bytes and manifest.
 *
 * @param {string} archive
 * @returns {{ok: true, archive: string, size: number, sha256: string, manifest: object, entries: Map<string, Buffer>}
 *   | {ok: false, reason_code: string, detail: string}}
 */
export function readZipArchive(archive) {
  const file = path.resolve(archive);
  if (!fs.existsSync(file)) return { ok: false, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_MISSING, detail: `archive not found: ${file}` };
  const buffer = fs.readFileSync(file);
  let zip;
  try {
    zip = readZip(buffer);
  } catch (error) {
    return { ok: false, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, detail: error instanceof Error ? error.message : String(error) };
  }
  const manifestEntry = zip.entries.find((entry) => entry.name === 'manifest.json');
  if (manifestEntry === undefined) {
    return { ok: false, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, detail: 'the archive has no manifest.json' };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (error) {
    return { ok: false, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, detail: `manifest.json is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (manifest?.format !== ZIP_ARCHIVE_FORMAT || manifest?.tool !== ZIP_ARCHIVE_TOOL) {
    return {
      ok: false,
      reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE,
      detail: `unsupported archive: format=${JSON.stringify(manifest?.format)} tool=${JSON.stringify(manifest?.tool)}`,
    };
  }
  return {
    ok: true,
    archive: file,
    size: buffer.length,
    sha256: sha256Hex(buffer),
    manifest,
    entries: new Map(zip.entries.map((entry) => [entry.name, entry.data])),
    skipped: zip.skipped,
  };
}

/**
 * Recompute every recorded digest from the archive's own bytes.
 *
 * @param {{archive: string}} input
 * @returns {object} `{ok, archive, sha256, created_at, checked, missing, mismatched, extras, totals}`
 */
export function verifyZipBackup(input) {
  const read = readZipArchive(input.archive);
  if (read.ok !== true) return { ok: false, ...read };
  const { manifest, entries } = read;
  const missing = [];
  const mismatched = [];
  const checked = [];
  for (const file of manifest.files ?? []) {
    const data = entries.get(file.rel);
    if (data === undefined) {
      missing.push(file.rel);
      continue;
    }
    const actual = sha256Hex(data);
    if (data.length !== file.size || actual !== file.sha256) {
      mismatched.push({ rel: file.rel, expected_sha256: file.sha256, actual_sha256: actual, expected_size: file.size, actual_size: data.length });
      continue;
    }
    checked.push(file.rel);
  }
  const referenced = new Set(['manifest.json', 'README.txt', ...(manifest.files ?? []).map((file) => file.rel)]);
  const extras = [...entries.keys()].filter((name) => !referenced.has(name)).sort();
  return {
    ok: missing.length === 0 && mismatched.length === 0,
    archive: read.archive,
    size: read.size,
    sha256: read.sha256,
    created_at: manifest.created_at ?? null,
    checked: checked.length,
    missing,
    mismatched,
    extras,
    totals: {
      files: manifest.counts?.project ?? 0,
      sessions: manifest.counts?.sessions ?? 0,
      profile_files: manifest.counts?.profile ?? 0,
      skipped: manifest.counts?.skipped ?? 0,
    },
  };
}

/**
 * Plan or apply a restore from one archive.
 *
 * `plan` writes nothing. `apply` must carry `confirm: "restore"` and makes a **pre-restore copy** of every file it
 * would overwrite before writing anything; a failed copy refuses the restore with nothing touched. A restore that
 * does not verify is refused before a single file is planned, and an archive whose stored sessions cannot be decoded
 * is refused by name rather than restored without them.
 *
 * @param {{archive: string, config: object, mode?: 'plan'|'apply', confirm?: string, targetProject?: string,
 *   overwrite?: boolean, includeSessions?: boolean, includeProfile?: boolean, keepSessionIds?: boolean,
 *   skipVerify?: boolean, now?: Date}} input
 * @returns {object} a plan (mode=plan) or a plan plus what was written (mode=apply)
 */
export function restoreZipBackup(input) {
  const mode = input.mode === 'apply' ? 'apply' : 'plan';
  const config = input.config;
  const read = readZipArchive(input.archive);
  if (read.ok !== true) return { ok: false, mode, ...read };
  const verification = input.skipVerify === true ? null : verifyZipBackup({ archive: input.archive });
  if (verification !== null && verification.ok !== true) {
    return { ok: false, mode, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_VERIFY_FAILED, detail: 'the archive does not verify; refusing to restore it', verification };
  }
  if (mode === 'apply' && input.confirm !== RESTORE_CONFIRM_TOKEN) {
    return {
      ok: false,
      mode,
      reason_code: ZIP_ARCHIVE_CODES.CONFIRM_REQUIRED,
      detail:
        `mode="apply" requires confirm: "${RESTORE_CONFIRM_TOKEN}" -- a restore writes over files in ` +
        `${path.resolve(input.targetProject ?? read.manifest.project_root ?? config.projectRoot)}; run mode="plan" first`,
      verification,
    };
  }
  const { manifest, entries } = read;
  const projectTarget = path.resolve(input.targetProject ?? manifest.project_root ?? config.projectRoot);
  const includeSessions = input.includeSessions !== false;
  const includeProfile = input.includeProfile === true;
  const overwrite = input.overwrite === true;
  const keepSessionIds = input.keepSessionIds === true;

  const plan = {
    archive: read.archive,
    mode,
    created_at: manifest.created_at ?? null,
    project_target: projectTarget,
    project: { create: 0, same: 0, conflicts: [] },
    sessions: { planned: 0, roots: 0, existing_ids: [] },
    profile: { files: 0, conflicts: [] },
    // Filled below: what `apply` would copy to `<DSH_HOME>/.w2m-restore-backups/` before touching the target.
    pre_restore: { dir: null, files: [] },
  };

  const projectFiles = [];
  for (const file of manifest.files ?? []) {
    if (file.kind !== 'project') continue;
    const rel = file.rel.slice(PROJECT_PREFIX.length);
    const target = safeArchiveTarget(projectTarget, rel);
    if (target === null) {
      return { ok: false, mode, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, detail: `refusing to write outside the target: ${file.rel}` };
    }
    const entry = { file, rel, target, exists: false, same: false };
    if (!fs.existsSync(target)) plan.project.create += 1;
    else {
      entry.exists = true;
      entry.same = sha256Hex(fs.readFileSync(target)) === file.sha256;
      if (entry.same) plan.project.same += 1;
      else if (overwrite) plan.project.create += 1;
      else plan.project.conflicts.push(rel);
    }
    projectFiles.push(entry);
  }

  const profileTargets = [];
  if (includeProfile) {
    for (const file of manifest.files ?? []) {
      if (file.kind !== 'profile') continue;
      const data = entries.get(file.rel);
      if (data === undefined) {
        return { ok: false, mode, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, detail: `${file.rel} is missing from the archive` };
      }
      const target = path.join(config.profileDir, file.rel.slice(PROFILE_PREFIX.length));
      profileTargets.push({ file, target, data, exists: fs.existsSync(target) });
      plan.profile.files += 1;
    }
  }

  // Everything apply would overwrite gets a copy first. A conflicting file that `overwrite:false` leaves alone is
  // not going to be touched, so it is not in the list.
  const preRestoreCandidates = [];
  for (const entry of projectFiles) {
    if (entry.exists && !entry.same && overwrite) preRestoreCandidates.push({ scope: 'project', rel: entry.rel, source: entry.target });
  }
  for (const entry of profileTargets) {
    if (entry.exists) preRestoreCandidates.push({ scope: 'profile', rel: entry.file.rel.slice(PROFILE_PREFIX.length), source: entry.target });
  }
  plan.pre_restore.files = preRestoreCandidates.map((entry) => `${entry.scope}/${entry.rel}`);

  const sessionRecords = [];
  const existing = storedSessionIds(config.dshHome);
  for (const file of manifest.files ?? []) {
    if (file.kind !== 'session') continue;
    const data = entries.get(file.rel);
    if (data === undefined) {
      return { ok: false, mode, reason_code: ZIP_ARCHIVE_CODES.ARCHIVE_UNREADABLE, detail: `${file.rel} is missing from the archive` };
    }
    const decoded = decodeStoredSession(data);
    if (decoded.ok !== true) {
      return { ok: false, mode, reason_code: ZIP_ARCHIVE_CODES.SESSION_UNREADABLE, detail: `${file.rel}: ${decoded.detail}` };
    }
    const headerId = typeof decoded.header.id === 'string' ? decoded.header.id : file.session_id;
    sessionRecords.push({ header: decoded.header, events: decoded.events, rel: file.rel, headerId });
    plan.sessions.planned += 1;
    if (decoded.header.parentSession === undefined || decoded.header.parentSession === null) plan.sessions.roots += 1;
    if (keepSessionIds && existing.has(headerId)) plan.sessions.existing_ids.push(headerId);
  }
  if (keepSessionIds && plan.sessions.existing_ids.length > 0) {
    return {
      ok: false,
      mode,
      reason_code: ZIP_ARCHIVE_CODES.SESSION_ID_CONFLICT,
      detail: `keepSessionIds was requested but these ids already exist: ${plan.sessions.existing_ids.join(', ')}`,
      plan,
      verification,
    };
  }
  if (mode === 'plan') return { ok: true, mode: 'plan', plan, verification };

  // The way back exists BEFORE the first write. A copy that cannot be made refuses the restore rather than leaving a
  // half-restored tree with no recovery material.
  const preRestoreDir = preRestoreCandidates.length === 0 ? null : restoreCopyDir(config.dshHome, input.now ?? new Date());
  const preRestoreFiles = [];
  if (preRestoreDir !== null) {
    try {
      for (const entry of preRestoreCandidates) {
        const dest = path.join(preRestoreDir, entry.scope, entry.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(entry.source, dest);
        preRestoreFiles.push(`${entry.scope}/${entry.rel}`);
      }
    } catch (error) {
      return {
        ok: false,
        mode,
        reason_code: ZIP_ARCHIVE_CODES.WRITE_FAILED,
        detail: `could not make the pre-restore copy: ${error instanceof Error ? error.message : String(error)}`,
        plan,
        verification,
      };
    }
  }
  plan.pre_restore.dir = preRestoreDir;

  let restoredFiles = 0;
  let skippedConflicts = 0;
  for (const { file, target, exists, same } of projectFiles) {
    if (exists && same) continue;
    if (exists && !overwrite) {
      skippedConflicts += 1;
      continue;
    }
    const data = entries.get(file.rel);
    if (data === undefined) continue;
    try {
      writeFileAtomic(target, data);
      restoredFiles += 1;
    } catch (error) {
      return { ok: false, mode, reason_code: ZIP_ARCHIVE_CODES.WRITE_FAILED, detail: error?.detail ?? String(error instanceof Error ? error.message : error) };
    }
  }

  let sessionRestore = null;
  if (includeSessions && sessionRecords.length > 0) {
    const written = writeSessionSet(sessionRecords, { dshHome: config.dshHome, workspace: projectTarget, keepIds: keepSessionIds });
    if (written.ok !== true) return { ok: false, mode, reason_code: written.reason_code, detail: written.detail, plan, verification };
    const attach = attachRootSessions({ dshHome: config.dshHome, workspacePath: projectTarget, written: written.written });
    sessionRestore = { written: written.written, attach };
  }

  let profileFiles = 0;
  for (const entry of profileTargets) {
    try {
      writeFileAtomic(entry.target, entry.data);
      profileFiles += 1;
    } catch (error) {
      return { ok: false, mode, reason_code: ZIP_ARCHIVE_CODES.WRITE_FAILED, detail: error?.detail ?? String(error instanceof Error ? error.message : error) };
    }
  }

  return {
    ok: true,
    mode: 'apply',
    plan,
    verification,
    restored: {
      files: restoredFiles,
      skipped_conflicts: skippedConflicts,
      sessions: sessionRestore?.written?.length ?? 0,
      profile_files: profileFiles,
      pre_restore_files: preRestoreFiles.length,
    },
    pre_restore: { dir: preRestoreDir, files: preRestoreFiles },
    sessions: sessionRestore,
  };
}

/** A one-line digest of an archive, for `backup_status`. */
export function summarizeZipArchive(archive) {
  const read = readZipArchive(archive);
  if (read.ok !== true) return read;
  return {
    ok: true,
    archive: read.archive,
    size: read.size,
    sha256: read.sha256,
    created_at: read.manifest.created_at ?? null,
    label: read.manifest.label ?? null,
    project_root: read.manifest.project_root ?? null,
    workspace: read.manifest.workspace ?? null,
    counts: read.manifest.counts ?? null,
  };
}
