/**
 * Backup scope expansion: what a backup copies besides the session logs, and what it must never copy.
 *
 * ## The gap this module closes
 *
 * `docs/BACKUP-SCOPE.md` measured the v3.5.0 backup against a real `$DSH_HOME`: 42 files of 13,462, byte coverage
 * ~22.6%. The session logs and attachment objects are the user's primary record, but they are not the whole
 * machine: the workspace registry (`storages/workspace.json`), the plugin rows (`cordis.patch.yml`,
 * `profiles/<p>/...`), and the other plugins' state (`xclient/`, `storages/dsh-context/`, `llm-deepseek/`,
 * `fang/`) all live in the same home, and without them "restore onto a fresh machine" does not produce a usable
 * DSH -- the sessions exist and are invisible, or the plugins that produced them are never loaded.
 *
 * ## The four rules that make an expanded scope safe
 *
 *   1. **Explicit, enumerable scopes.** `sessions`, `attachments`, `registry`, `config`, `state`, `restore_copies`.
 *      Nothing is backed up because a walker happened to find it; each file is named by a rule in this file.
 *   2. **The exclusions are data, not silence.** Anything deliberately left out (runtimes, dependency trees, the
 *      proxy binaries, derived caches, restore copies when their scope is narrowed, credential files unless opted
 *      in) is returned in `skipped` with a class and a reason. A reader can see the decision instead of wondering
 *      why the repository is smaller than the home.
 *   3. **Credentials are opt-in.** `.credentials.yaml`, `xclient/device.key`, `xclient/gpw-folders.json.key` and
 *      `.anonymous-user-id` are identity: whoever holds the repository holds the account login / device identity /
 *      folder-policy key. They are skipped by default with `class: 'credential'`; `includeSecrets: true` includes
 *      them and the engine warns loudly. Default off is the only safe default for an unencrypted repository.
 *   4. **The repository never backs itself up.** `collectScopeFiles` takes `excludeRoots` (absolute directories:
 *      the repository root, before or after it is created) and every candidate -- including the restore copies and
 *      any future scope -- is skipped with a `self-reference` reason when its resolved **real path** lies inside
 *      one of those roots. The walkers never descend into an excluded root. This is what makes backing up the
 *      restore copies safe even when `backupDir` is misconfigured to a path inside `$DSH_HOME`.
 *
 * ## Caps, because "back everything up" can quietly become 10 GB
 *
 * A regular file larger than {@link MAX_SCOPE_FILE_BYTES} is skipped as `too-large` (a session log is handled by
 * the session path, not here; a multi-GB file under a state directory is almost certainly not state). The whole
 * expanded set is capped at {@link MAX_SCOPE_TOTAL_BYTES}; exceeding it is a **refusal** (`BACKUP_SCOPE_TOO_LARGE`)
 * returned before the engine opens a lock, writes a block, or creates the repository -- so a refused run writes
 * nothing at all.
 *
 * Restore copies (`restore_copies`) are recovery material, not state: one pre-restore copy of a session log can be
 * tens of MB, so that scope has its own caps -- {@link MAX_RESTORE_COPY_FILE_BYTES} per file and
 * {@link MAX_RESTORE_COPY_TOTAL_BYTES} for the directory. Exceeding either is a **reported skip**, never a refusal:
 * the directory is not backed up and the rest of the scopes still run.
 *
 * ## Symlinks are never followed
 *
 * A link under the home can point anywhere, including outside it; following one would make the backup read files
 * the operator never scoped, and (on restore) write outside the target home. Every symlink is reported in
 * `skipped` with `class: 'symlink'` and is not traversed.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The six scopes a run can select. Order is canonical: status output and plans follow it. */
export const BACKUP_SCOPES = Object.freeze(['sessions', 'attachments', 'registry', 'config', 'state', 'restore_copies']);

/** What an absent `scopes` value means: every scope (the P0/P3 default). */
export const DEFAULT_BACKUP_SCOPES = Object.freeze([...BACKUP_SCOPES]);

/** Named scope failure codes. */
export const SCOPE_CODES = Object.freeze({
  UNKNOWN: 'BACKUP_SCOPE_UNKNOWN',
  TOO_LARGE: 'BACKUP_SCOPE_TOO_LARGE',
  TARGET_ESCAPE: 'BACKUP_SCOPE_TARGET_ESCAPE',
});

/** One regular file larger than this is skipped (`too-large`) rather than backed up as scope state. */
export const MAX_SCOPE_FILE_BYTES = 8 * 1024 * 1024;

/** Total cap on the expanded (non-session) set. Exceeding it refuses the run before anything is written. */
export const MAX_SCOPE_TOTAL_BYTES = 256 * 1024 * 1024;

/** The home-root directory a restore writes its pre-restore copies into (`.w2m-restore-backups/<timestamp>/...`). */
export const RESTORE_COPY_ROOT = '.w2m-restore-backups';

/**
 * One restore-copy file larger than this is skipped as `too-large`. Much larger than
 * {@link MAX_SCOPE_FILE_BYTES} on purpose: a pre-restore copy of a session log is the whole session.
 */
export const MAX_RESTORE_COPY_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Per-scope total cap for `restore_copies`. Unlike {@link MAX_SCOPE_TOTAL_BYTES} this is not a refusal: over the
 * cap the directory is skipped as one `cap` row and the rest of the scopes still run.
 */
export const MAX_RESTORE_COPY_TOTAL_BYTES = 1024 * 1024 * 1024;

/** The reason every `restore-copy` manifest entry records. */
export const RESTORE_COPY_REASON =
  'pre-restore copy written by w2m before overwriting a home file: the last-resort undo of a restore';

/** Why the restore-copy directory is skipped when its scope is narrowed away. */
export const RESTORE_COPY_EXCLUDED_REASON =
  "w2m's own pre-restore copies; the backup must not copy its own last-resort copies (self-reference)";

/** The reason every candidate inside the repository (or any excluded root) is skipped with. */
export const SELF_REFERENCE_REASON = 'inside the backup repository or an excluded root (self-reference)';

/** Guard for the inventory walk: a home larger than this is reported `truncated` instead of walked forever. */
export const MAX_INVENTORY_FILES = 200_000;

/** The warning any output that mentions credential inclusion must carry, verbatim. */
export const SECRETS_WARNING =
  '包含凭据：任何拿到仓库的人都能登录此账户/使用设备身份（backupIncludeSecrets=true；仓库泄露 = 身份泄露）';

/** Files under `$DSH_HOME` that are credentials or identity keys. */
export const CREDENTIAL_FILES = Object.freeze([
  '.credentials.yaml',
  '.anonymous-user-id',
  'xclient/device.key',
  'xclient/gpw-folders.json.key',
  // The machine-sealed repository-key envelope: key material, useless on another machine (DPAPI is per-user) but
  // still a key file, so it follows the same opt-in rule as the identity keys.
  'xclient/backup/machine.key',
]);

/**
 * The backup plugin's own **transient progress file** (`xclient/w2m-backup/worker.json`, v3.6/S8).
 *
 * It is host liveness state, not user state: the plugin-side worker runner rewrites it while a run is scanning the
 * home. Backing it up would (a) race that scan — an atomic-write temp collected and then renamed away is a
 * collected-then-ENOENT path for the engine — and (b) put "this run is at stage store" into the run's own snapshot.
 * The settled `state.json` in the same directory stays in scope: it is verdict/reminder state a restore benefits
 * from. Both the final name and its atomic-write temporaries are excluded.
 */
export const BACKUP_WORKER_STATE_REL = 'xclient/w2m-backup/worker.json';

/** Is this home-relative path the backup plugin's transient progress file (or one of its temp writes)? */
export function isBackupWorkerStateRel(rel) {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean === BACKUP_WORKER_STATE_REL) return true;
  const cut = clean.lastIndexOf('/') + 1;
  if (cut === 0) return false;
  const dir = clean.slice(0, cut);
  const base = clean.slice(cut);
  return dir === 'xclient/w2m-backup/' && base.startsWith('.worker.json.tmp-');
}

/** Root configuration file (the global plugin rows). */
const ROOT_CONFIG_FILE = 'cordis.patch.yml';

/** Per-profile files that decide which plugin bundles load and at which versions. */
const PROFILE_FILES = Object.freeze(['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);

/** Directories whose whole subtree belongs to the `state` scope, with the reason reported per file. */
const STATE_ROOTS = Object.freeze([
  { rel: 'xclient', reason: 'xclient plugin state (device/queue/decision-center/gpw/fang bridge)', recursive: true },
  { rel: 'storages/dsh-context', reason: 'dsh-context plugin persistent state', recursive: true },
  { rel: 'llm-deepseek', reason: 'LLM provider configuration (model/parameters)', recursive: true },
  { rel: 'fang', reason: 'dsh-fang/contract interop state', recursive: true },
]);

/** Exclusion classes, in the order a report should prefer them when a row mixes classes. */
const CLASS_ORDER = Object.freeze(['credential', 'self-copy', 'restore-copy', 'cache', 'reinstallable', 'not-in-scope', 'in-scope', 'symlink', 'cap', 'unknown']);

/** Human explanation for each exclusion class. */
const CLASS_REASON = Object.freeze({
  reinstallable: 'reinstallable: runtime/dependency/proxy binaries come back from the installer or pnpm install',
  cache: 'derived cache: rebuilt on demand, and restoring it would restore a stale projection',
  'self-copy': "w2m's own pre-restore copy: it is itself a last-resort copy and would make the backup self-referential",
  'restore-copy': 'pre-restore copy from a w2m restore: recovery material carried by the restore_copies scope',
  credential: 'credential/identity file: excluded unless backupIncludeSecrets is explicitly enabled',
  'not-in-scope': 'in scope for a complete backup but not present in this snapshot (created or changed after it)',
  'in-scope': 'in scope and covered by this backup',
  symlink: 'symlink: never followed, because the target can be outside the home',
  cap: 'over the per-file scope cap, so it is not backed up as state',
  unknown: 'not classified by the scope rules (a future plugin/state directory)',
});

/**
 * Validate a scopes value.
 *
 * Absent means **every scope** (the approved default). A non-array, or an array containing anything that is not one
 * of {@link BACKUP_SCOPES}, is refused by name: silently dropping an unknown scope would make a typo look like a
 * narrower backup that succeeded.
 *
 * @param {unknown} value
 * @returns {{ok: true, scopes: string[]} | {ok: false, reason_code: string, detail: string}}
 */
export function resolveBackupScopes(value) {
  if (value === undefined || value === null) return { ok: true, scopes: [...DEFAULT_BACKUP_SCOPES] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason_code: SCOPE_CODES.UNKNOWN,
      detail: `scopes must be an array of ${BACKUP_SCOPES.join(', ')}, got ${JSON.stringify(value)}`,
    };
  }
  const wanted = new Set();
  for (const raw of value) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!BACKUP_SCOPES.includes(name)) {
      return {
        ok: false,
        reason_code: SCOPE_CODES.UNKNOWN,
        detail: `unknown backup scope ${JSON.stringify(raw)}; expected one of ${BACKUP_SCOPES.join(', ')}`,
      };
    }
    wanted.add(name);
  }
  // Canonical order, so two equivalent requests produce the same plan/manifest and a test can compare them.
  return { ok: true, scopes: BACKUP_SCOPES.filter((name) => wanted.has(name)) };
}

/** True when `file` resolves inside `root` (both absolute, compared by resolved path, not by string prefix). */
export function isInside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A dirent list, sorted by name, or `[]` when the directory cannot be read. */
function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** `lstat` without throwing. */
function lstatSafe(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * `realpath` without throwing.
 *
 * A path that does not exist yet (the repository is created only after the read-only scope collection) is compared
 * as its resolved form; a path that exists through a junction/symlink ancestor is compared as the target it really
 * is, which is the whole point of the self-reference guard.
 */
function realPathSafe(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** True when `file` is `root` itself or lies inside it, compared on resolved paths. */
function isInsideOrEqual(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Is this name a backup/good copy (`*.bak*`, `*.good-*`)? */
export function isBackupCopyName(name) {
  return /\.bak/i.test(name) || /\.good-/i.test(name);
}

/** Is this a credential/identity file (by its home-relative path)? */
export function isCredentialRel(rel) {
  if (CREDENTIAL_FILES.includes(rel)) return true;
  // Every `.credentials.yaml` sibling (`.credentials.yaml.bak`, timestamps, ...) is the same credential.
  return rel === '.credentials.yaml' || rel.startsWith('.credentials.yaml.') || /(^|\/)\.credentials\.yaml(\.[^/]*)?$/u.test(rel);
}

/**
 * Classify one home-relative path for the inventory/coverage report.
 *
 * This is the single source of truth for "why is this file not in the backup", reused by
 * {@link homeInventory} and by `verify.mjs` coverage. It classifies by *path shape*, not by content, because the
 * report must stay cheap enough to run over a real 13k-file home during `verify`.
 *
 * @param {string} rel
 * @returns {'in-scope'|'reinstallable'|'cache'|'self-copy'|'restore-copy'|'credential'|'unknown'}
 */
export function classifyHomePath(rel) {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = clean.split('/');
  const top = segments[0];
  if (top === 'dsh-runtimes') return 'reinstallable';
  if (top === 'xray-proxy') return 'reinstallable';
  if (top === 'node_modules') return 'reinstallable';
  if (top === 'profiles' && segments[2] === 'node_modules') return 'reinstallable';
  if (top === RESTORE_COPY_ROOT) return 'restore-copy';
  if (top === 'sessions' && segments[1] === RESTORE_COPY_ROOT) return 'self-copy';
  if (top === 'storages' && segments[1] !== undefined && isBackupCopyName(segments[1])) return 'self-copy';
  if (top === 'sessions' && segments[1] === '.event-cache') return 'cache';
  if (top === 'storages' && segments[1] === 'session_projcache') return 'cache';
  if (isCredentialRel(clean)) return 'credential';
  // v3.6/S8: the backup plugin's own transient progress file is skipped, never captured, and the coverage report
  // must say so with a class instead of treating it as a gap.
  if (isBackupWorkerStateRel(clean)) return 'self-copy';
  if (top === 'sessions' || top === 'attachments') return 'in-scope';
  if (clean === 'storages/workspace.json') return 'in-scope';
  if (top === 'storages' && segments[1] === 'dsh-context') return 'in-scope';
  if (clean === ROOT_CONFIG_FILE) return 'in-scope';
  if (top === 'profiles' && segments.length >= 3 && PROFILE_FILES.includes(segments[2])) return 'in-scope';
  if (top === 'profiles' && segments.length === 2) return 'in-scope';
  if (top === 'xclient' || top === 'llm-deepseek' || top === 'fang') return 'in-scope';
  return 'unknown';
}

/** The reason reported for a class. */
export function classReason(rel, cls) {
  if (cls === 'not-in-scope') return CLASS_REASON['not-in-scope'];
  if (cls === 'unknown') return CLASS_REASON.unknown;
  return CLASS_REASON[cls] ?? CLASS_REASON.unknown;
}

/**
 * Collect the regular files the expanded scopes select, and record everything deliberately skipped.
 *
 * @param {{dshHome: string, scopes?: string[], includeSecrets?: boolean, excludeRoots?: string[]}} input
 *   `excludeRoots` is the self-reference guard: absolute directories (the backup repository itself, before or after
 *   it exists) whose contents must never be collected, even by a misconfigured `backupDir` inside `$DSH_HOME`.
 * @returns {{ok: true, dsh_home: string, scopes: string[], secrets_included: boolean,
 *   files: Array<{rel: string, file: string, kind: string, scope: string, reason: string, size: number}>,
 *   skipped: Array<{rel: string, reason: string, class: string, size?: number}>,
 *   total_bytes: number}
 *   | {ok: false, reason_code: string, detail: string, total_bytes?: number, cap_bytes?: number}}
 */
export function collectScopeFiles(input) {
  const dshHome = path.resolve(input.dshHome);
  const policy = resolveBackupScopes(input.scopes);
  if (policy.ok !== true) return policy;
  const selected = new Set(policy.scopes);
  const includeSecrets = input.includeSecrets === true;
  const excludedRoots = (Array.isArray(input.excludeRoots) ? input.excludeRoots : [])
    .filter((root) => typeof root === 'string' && root.trim() !== '')
    .map((root) => realPathSafe(root));
  const files = [];
  const skipped = [];
  const seen = new Set();
  let totalBytes = 0;
  let expandedBytes = 0;

  /**
   * Is this home-relative path the repository itself (or inside another excluded root)?
   *
   * Asked of every candidate, not only restore copies: today's scopes and any scope added later go through the
   * same check, and the walkers ask it of a directory before descending so they never enumerate the repository.
   */
  const insideExcludedRoot = (rel) => {
    if (excludedRoots.length === 0) return false;
    const real = realPathSafe(path.join(dshHome, ...String(rel).replace(/\\/g, '/').split('/')));
    return excludedRoots.some((root) => isInsideOrEqual(root, real));
  };

  const recordSkip = (rel, reason, cls, size) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    skipped.push({ rel, reason, class: cls, ...(Number.isSafeInteger(size) ? { size } : {}) });
  };

  const addFile = (rel, kind, scope, reason) => {
    const relPath = rel.replace(/\\/g, '/');
    const file = path.join(dshHome, ...relPath.split('/'));
    if (insideExcludedRoot(relPath)) {
      recordSkip(relPath, SELF_REFERENCE_REASON, 'self-copy');
      return;
    }
    if (!isInside(dshHome, file)) {
      recordSkip(relPath, 'resolves outside the DSH home', 'unknown');
      return;
    }
    const stat = lstatSafe(file);
    if (stat === null) return;
    if (stat.isSymbolicLink()) {
      recordSkip(relPath, 'symlink: not followed (the target may be outside the home)', 'symlink');
      return;
    }
    if (!stat.isFile()) return;
    if (seen.has(relPath)) return;
    seen.add(relPath);
    if (stat.size > MAX_SCOPE_FILE_BYTES) {
      skipped.push({ rel: relPath, reason: `too-large: ${stat.size} bytes > ${MAX_SCOPE_FILE_BYTES}-byte per-file cap`, class: 'cap', size: stat.size });
      return;
    }
    files.push({ rel: relPath, file, kind, scope, reason, size: stat.size });
    totalBytes += stat.size;
    expandedBytes += stat.size;
  };

  /** Record a whole-subtree exclusion, so an empty/runtime directory is still explained. */
  const recordExcludedDir = (rel, cls, reason) => {
    const dir = path.join(dshHome, ...rel.split('/'));
    const stat = lstatSafe(dir);
    if (stat === null) return;
    recordSkip(rel, reason ?? CLASS_REASON[cls], cls);
  };

  /**
   * Walk one state root recursively.
   *
   * Skips are recorded per file for `*.log`/`*.bak*` and per directory for `node_modules`, so a reader can see
   * exactly which bytes were left out and why. Symlinks are reported and never traversed.
   */
  const walkState = (relDir, reason) => {
    const dir = path.join(dshHome, ...relDir.split('/'));
    for (const entry of listDir(dir)) {
      const rel = `${relDir}/${entry.name}`;
      const full = path.join(dir, entry.name);
      const stat = lstatSafe(full);
      if (stat === null) continue;
      if (stat.isSymbolicLink()) {
        recordSkip(rel, 'symlink: not followed (the target may be outside the home)', 'symlink');
        continue;
      }
      if (stat.isDirectory()) {
        if (insideExcludedRoot(rel)) {
          recordSkip(rel, SELF_REFERENCE_REASON, 'self-copy');
          continue;
        }
        if (entry.name === 'node_modules') {
          recordExcludedDir(rel, 'reinstallable');
          continue;
        }
        walkState(rel, reason);
        continue;
      }
      if (isCredentialRel(rel) && includeSecrets !== true) {
        // Credential files are reported even inside a state root; the flag above decides inclusion.
        continue;
      }
      if (/\.log$/i.test(entry.name)) {
        recordSkip(rel, 'log file: not state, and it can be large', 'cache', stat.size);
        continue;
      }
      if (isBackupWorkerStateRel(rel)) {
        // The backup plugin's in-flight progress file: the scan can be running against the same directory that the
        // plugin rewrites, so it is never a backup candidate (see {@link BACKUP_WORKER_STATE_REL}).
        recordSkip(rel, CLASS_REASON['self-copy'], 'self-copy', stat.size);
        continue;
      }
      if (isBackupCopyName(entry.name)) {
        recordSkip(rel, 'backup copy: the live file is backed up instead', 'self-copy', stat.size);
        continue;
      }
      addFile(rel, 'state', 'state', reason);
    }
  };

  // ---- registry -------------------------------------------------------------------------------------------------
  if (selected.has('registry')) {
    addFile('storages/workspace.json', 'registry', 'registry', 'workspace registry document (workspaces, paths/order, archived/pinned, default workspace)');
  }

  // ---- config ---------------------------------------------------------------------------------------------------
  if (selected.has('config')) {
    addFile(ROOT_CONFIG_FILE, 'config', 'config', 'global plugin rows: which plugins load and their configuration');
    for (const entry of listDir(path.join(dshHome, 'profiles'))) {
      const profileDir = path.join(dshHome, 'profiles', entry.name);
      const profileStat = lstatSafe(profileDir);
      if (profileStat === null) continue;
      if (profileStat.isSymbolicLink()) {
        recordSkip(`profiles/${entry.name}`, 'symlink: not followed (the target may be outside the home)', 'symlink');
        continue;
      }
      if (!profileStat.isDirectory()) continue;
      const profileRel = `profiles/${entry.name}`;
      if (insideExcludedRoot(profileRel)) {
        recordSkip(profileRel, SELF_REFERENCE_REASON, 'self-copy');
        continue;
      }
      for (const child of listDir(profileDir)) {
        const rel = `${profileRel}/${child.name}`;
        const childStat = lstatSafe(path.join(profileDir, child.name));
        if (childStat === null) continue;
        if (childStat.isSymbolicLink()) {
          recordSkip(rel, 'symlink: not followed (the target may be outside the home)', 'symlink');
          continue;
        }
        if (childStat.isDirectory()) {
          if (child.name === 'node_modules') recordExcludedDir(rel, 'reinstallable');
          continue;
        }
        if (isBackupCopyName(child.name)) {
          recordSkip(rel, 'backup copy: the live file is backed up instead', 'self-copy');
          continue;
        }
        if (!PROFILE_FILES.includes(child.name)) continue;
        addFile(rel, 'config', 'config', `profile "${entry.name}" plugin bundle/dependency/version configuration`);
      }
    }
  }

  // ---- state ----------------------------------------------------------------------------------------------------
  if (selected.has('state')) {
    for (const root of STATE_ROOTS) {
      const dir = path.join(dshHome, ...root.rel.split('/'));
      const stat = lstatSafe(dir);
      if (stat === null) continue;
      if (stat.isSymbolicLink()) {
        recordSkip(root.rel, 'symlink: not followed (the target may be outside the home)', 'symlink');
        continue;
      }
      if (insideExcludedRoot(root.rel)) {
        recordSkip(root.rel, SELF_REFERENCE_REASON, 'self-copy');
        continue;
      }
      if (stat.isDirectory()) walkState(root.rel, root.reason);
      else addFile(root.rel, 'state', 'state', root.reason);
    }
  }

  // ---- credentials (P1 opt-in) ----------------------------------------------------------------------------------
  if (selected.has('state')) {
    const candidateRels = new Set(CREDENTIAL_FILES);
    // `.credentials.yaml` siblings (the client rewrites it via temp/bak files) are the same credential.
    for (const entry of listDir(dshHome)) {
      if (/^\.credentials\.yaml(\..*)?$/u.test(entry.name) && (entry.isFile?.() === true || entry.isFile === true)) candidateRels.add(entry.name);
    }
    for (const rel of [...candidateRels].sort()) {
      const file = path.join(dshHome, ...rel.split('/'));
      const stat = lstatSafe(file);
      if (stat === null || stat.isSymbolicLink() || stat.isFile() !== true) continue;
      if (includeSecrets === true) {
        addFile(rel, 'state', 'state', 'credential/identity file included because includeSecrets is enabled (repository disclosure = identity disclosure)');
      } else {
        recordSkip(rel, CLASS_REASON.credential, 'credential', stat.size);
      }
    }
  }

  // ---- restore copies (P3) ---------------------------------------------------------------------------------------
  // `.w2m-restore-backups/<timestamp>/...` is what a restore leaves on disk before it overwrites a file: the
  // last-resort undo. It is recovery material, so it is backed up only when its own scope is selected, with its own
  // caps, and it is never allowed to point the backup back at the repository (the excludeRoots guard above).
  if (selected.has('restore_copies')) {
    const rootRel = RESTORE_COPY_ROOT;
    const rootStat = lstatSafe(path.join(dshHome, rootRel));
    if (rootStat !== null && rootStat.isSymbolicLink()) {
      recordSkip(rootRel, 'symlink: not followed (the target may be outside the home)', 'symlink');
    } else if (rootStat !== null && rootStat.isDirectory()) {
      if (insideExcludedRoot(rootRel)) {
        recordSkip(rootRel, SELF_REFERENCE_REASON, 'self-copy');
      } else {
        const restoreFiles = [];
        const restoreSkipped = [];
        let restoreBytes = 0;
        let capped = false;
        const walkRestoreCopies = (relDir) => {
          for (const entry of listDir(path.join(dshHome, ...relDir.split('/')))) {
            if (capped) return;
            const rel = `${relDir}/${entry.name}`;
            const full = path.join(dshHome, ...rel.split('/'));
            const stat = lstatSafe(full);
            if (stat === null) continue;
            if (stat.isSymbolicLink()) {
              restoreSkipped.push({ rel, reason: 'symlink: not followed (the target may be outside the home)', class: 'symlink' });
              continue;
            }
            if (stat.isDirectory()) {
              if (insideExcludedRoot(rel)) {
                restoreSkipped.push({ rel, reason: SELF_REFERENCE_REASON, class: 'self-copy' });
                continue;
              }
              walkRestoreCopies(rel);
              continue;
            }
            if (!stat.isFile()) continue;
            if (insideExcludedRoot(rel)) {
              restoreSkipped.push({ rel, reason: SELF_REFERENCE_REASON, class: 'self-copy' });
              continue;
            }
            if (stat.size > MAX_RESTORE_COPY_FILE_BYTES) {
              restoreSkipped.push({
                rel,
                reason: `too-large: ${stat.size} bytes > ${MAX_RESTORE_COPY_FILE_BYTES}-byte (64 MiB) restore-copy per-file cap`,
                class: 'cap',
                size: stat.size,
              });
              continue;
            }
            restoreBytes += stat.size;
            if (restoreBytes > MAX_RESTORE_COPY_TOTAL_BYTES) {
              capped = true;
              return;
            }
            restoreFiles.push({ rel, file: full, kind: 'restore-copy', scope: 'restore_copies', reason: RESTORE_COPY_REASON, size: stat.size });
          }
        };
        walkRestoreCopies(rootRel);
        if (capped) {
          // Not a refusal: the whole directory is skipped as one reported row, and the run continues with the rest
          // of the scopes. The alternative -- failing the run -- would let 1 GiB of recovery copies disable the
          // session backup the user actually asked for.
          recordSkip(
            rootRel,
            `restore copies are over the ${MAX_RESTORE_COPY_TOTAL_BYTES}-byte (1 GiB) per-scope cap; none of them are backed up and the rest of the scopes still run`,
            'cap',
          );
        } else {
          for (const row of restoreSkipped) recordSkip(row.rel, row.reason, row.class, row.size);
          for (const row of restoreFiles) {
            if (seen.has(row.rel)) continue;
            seen.add(row.rel);
            files.push(row);
          }
          totalBytes += restoreBytes;
        }
      }
    }
  }

  // ---- always-skipped classes (recorded whether or not a scope selected them) ------------------------------------
  recordExcludedDir('dsh-runtimes', 'reinstallable', 'reinstallable: Node/Python runtimes and their dependencies come back from the installer');
  recordExcludedDir('xray-proxy', 'reinstallable', 'reinstallable: proxy binaries/configuration come back from the installer');
  if (!selected.has('restore_copies')) {
    // A narrowed run still explains the directory it left out, with the same self-copy reason the old exclusion used.
    recordExcludedDir(RESTORE_COPY_ROOT, 'self-copy', RESTORE_COPY_EXCLUDED_REASON);
  }
  recordExcludedDir('sessions/.event-cache', 'cache', 'derived projection of the session logs; the client rebuilds it on demand');
  recordExcludedDir('sessions/.w2m-restore-backups', 'self-copy', 'legacy w2m restore copies (they now live at the home root)');
  recordExcludedDir('storages/session_projcache', 'cache', 'derived sessions-list/title projection; rebuilt from the registry on demand');
  for (const entry of listDir(path.join(dshHome, 'storages'))) {
    if (isBackupCopyName(entry.name)) {
      const rel = `storages/${entry.name}`;
      recordSkip(rel, 'backup copy (`*.bak*`/`*.good-*`): the live file is backed up instead', 'self-copy');
    }
  }
  for (const entry of listDir(path.join(dshHome, 'sessions'))) {
    const stat = lstatSafe(path.join(dshHome, 'sessions', entry.name));
    if (stat === null || stat.isDirectory()) continue;
    if (isBackupCopyName(entry.name)) {
      const rel = `sessions/${entry.name}`;
      recordSkip(rel, 'backup copy (`*.bak*`/`*.good-*`): the live file is backed up instead', 'self-copy');
    }
  }

  // The total cap is a refusal, not a silent truncation: the engine must know before it writes anything. It counts
  // only the expanded (non-restore-copy) set; the restore copies have their own, non-refusing cap above.
  if (expandedBytes > MAX_SCOPE_TOTAL_BYTES) {
    return {
      ok: false,
      reason_code: SCOPE_CODES.TOO_LARGE,
      detail:
        `the expanded backup scope is ${expandedBytes} bytes, over the ${MAX_SCOPE_TOTAL_BYTES}-byte cap; ` +
        'nothing was written. Narrow the scopes (run --scopes ...) or raise the cap in code after review.',
      total_bytes: expandedBytes,
      cap_bytes: MAX_SCOPE_TOTAL_BYTES,
    };
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel));
  skipped.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    ok: true,
    dsh_home: dshHome,
    scopes: policy.scopes,
    secrets_included: includeSecrets,
    files,
    skipped,
    total_bytes: totalBytes,
  };
}

/** Which display row a path belongs to in the inventory/coverage report. */
export function displayRel(rel) {
  const parts = rel.split('/');
  const top = parts[0];
  if (top === 'profiles' && parts.length >= 3) {
    if (parts[2] === 'node_modules') return parts.slice(0, 3).join('/');
    return parts.slice(0, 2).join('/');
  }
  if (top === 'storages' || top === 'xclient') {
    return parts.length >= 2 ? parts.slice(0, 2).join('/') : top;
  }
  if (top === 'sessions' && (parts[1] === '.event-cache' || parts[1] === '.w2m-restore-backups')) return parts.slice(0, 2).join('/');
  return top;
}

/** Pick the dominant class of a row: the class with the most bytes, ties by {@link CLASS_ORDER}. */
function dominantClass(classes) {
  let best = 'unknown';
  let bestBytes = -1;
  for (const [cls, bytes] of classes) {
    if (bytes > bestBytes || (bytes === bestBytes && CLASS_ORDER.indexOf(cls) < CLASS_ORDER.indexOf(best))) {
      best = cls;
      bestBytes = bytes;
    }
  }
  return best;
}

/**
 * Inventory a DSH home: how many bytes/files it holds, and how each top-level area classifies.
 *
 * This exists for two callers: `verify`'s coverage report ("how much of the home does this repository cover, and
 * what is the rest?") and the status/CLI surfaces that want to show where the bytes are. It walks the tree and
 * stats files -- it never reads file contents and never follows symlinks. `node_modules`, `dsh-runtimes` and
 * `xray-proxy` are aggregated on the walk without per-file processing beyond `stat`, and a home larger than
 * {@link MAX_INVENTORY_FILES} is reported `truncated: true` rather than walked indefinitely.
 *
 * Rows are produced for top-level entries, and additionally for `profiles` children (and each
 * `profiles/<p>/node_modules`), `storages` children and `xclient` children, so a coverage report can say "these
 * config files are covered, that dependency tree is not" instead of only "profiles/ is 190 MB".
 *
 * @param {{dshHome: string}} input
 * @returns {{ok: boolean, dsh_home: string, exists: boolean, bytes: number, files: number, truncated: boolean,
 *   top: Array<{rel: string, bytes: number, files: number, class: string, reason: string}>}}
 */
export function homeInventory(input) {
  const dshHome = path.resolve(input.dshHome);
  const rows = new Map();
  let bytes = 0;
  let files = 0;
  let truncated = false;

  const bump = (rel, size) => {
    const key = displayRel(rel);
    const cls = classifyHomePath(rel);
    let row = rows.get(key);
    if (row === undefined) {
      row = { rel: key, bytes: 0, files: 0, classes: new Map() };
      rows.set(key, row);
    }
    row.bytes += size;
    row.files += 1;
    row.classes.set(cls, (row.classes.get(cls) ?? 0) + size);
  };

  const walk = (dir, relDir) => {
    if (truncated) return;
    for (const entry of listDir(dir)) {
      if (files >= MAX_INVENTORY_FILES) {
        truncated = true;
        return;
      }
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const full = path.join(dir, entry.name);
      const stat = lstatSafe(full);
      if (stat === null) continue;
      if (stat.isSymbolicLink()) {
        // Not followed and not counted: a link has no bytes of its own, and its target may be outside the home.
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!stat.isFile()) continue;
      files += 1;
      bytes += stat.size;
      bump(rel, stat.size);
    }
  };
  const exists = fs.existsSync(dshHome) && lstatSafe(dshHome)?.isDirectory() === true;
  if (exists) walk(dshHome, '');

  const top = [...rows.values()]
    .map((row) => {
      const cls = dominantClass(row.classes);
      return { rel: row.rel, bytes: row.bytes, files: row.files, class: cls, reason: classReason(row.rel, cls) };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));

  return { ok: true, dsh_home: dshHome, exists, bytes, files, truncated, top };
}
