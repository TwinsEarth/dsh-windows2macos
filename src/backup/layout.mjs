/**
 * Backup repository layout: where the repository lives, what is inside it, and the named ways its creation
 * can fail.
 *
 * ## Why the layout is a module and not a string constant in the engine
 *
 * v3.4.6 freezes the *shape* of the repository before anything writes to it (the same reason the session
 * format had to be understood before the 2026-11-17 recovery drill could succeed). A path decided inside the
 * engine is a path the CLI, the routes and the tests each re-derive slightly differently; this module is the
 * one place that says `objects/<aa>/<sha256>` and the one place that refuses a dangerous target.
 *
 * ## The repository, in one picture
 *
 *   <root>/backup.json                      descriptor: format, version, block size, cipher (plaintext)
 *   <root>/objects/<aa>/<sha256>            content-addressed ENCRYPTED blocks (dedupe unit)
 *   <root>/snapshots/<snapshot>/manifest.json  paths + sizes + hashes (no message text; see BACKUP-DESIGN)
 *   <root>/snapshots/<snapshot>/keys.json      wrapped DEK envelopes (account / machine / password)
 *   <root>/current/<workspace>/<session>/...   the latest version of each session file, as encrypted blobs
 *   <root>/old/<workspace>/<session>/<ts>-<sha12>.zst.enc   superseded versions (v3.4.7 rotation)
 *   <root>/archive/<date>/archived-sessions-<ts>.tar.zst    archived-session packs (v3.4.8)
 *   <root>/index.jsonl                      append-only snapshot log: counts and ids, no paths
 *   <root>/tmp/                             staging area; anything here is disposable
 *
 * ## What this module refuses, and why each refusal is a code
 *
 * The first real run is the one that has to be safe, because it happens unattended on a machine whose D:
 * drive the operator believes exists. Three failures are specific and must not be reported as "EPERM":
 *
 *   * the drive does not exist (`BACKUP_DRIVE_MISSING`) -- a configuration mistake, not a permission one;
 *   * the directory exists but cannot be written (`BACKUP_DIR_NOT_WRITABLE`) -- fix permissions, or pick a
 *     directory;
 *   * the directory exists, is not empty, and is not this format (`BACKUP_DIR_NOT_A_REPO`) -- **never**
 *     initialise over somebody else's data.
 *
 * It also refuses a root *inside* `$DSH_HOME` (`BACKUP_DIR_INSIDE_SOURCE`): a backup that grows inside the
 * tree it copies will be scanned by its own next run, which is how a 172 MB repository becomes 1 GB of its
 * own history. That check is the one that would have prevented the worst possible first-run mistake, and it is
 * cheap.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomic } from './atomic.mjs';

/** The descriptor's `format` string. Bumping it is a new repository kind, not a new version. */
export const REPO_FORMAT = 'w2m-session-backup';

/** The descriptor's `version`. v1 is frozen by `test/backup-protocol.test.mjs`. */
export const REPO_VERSION = 1;

/** Descriptor file name, relative to the repository root. */
export const DESCRIPTOR_FILE = 'backup.json';

/** Cipher written by v3.4.6 (the only one this version can create). */
export const REPO_CIPHER = 'aes-256-gcm';

/**
 * Repository protection modes recorded by the descriptor's additive `encryption` field.
 *
 *   * `none` -- the data key is stored in clear in `keys.json` (an `open` envelope): the repository is
 *     deliberately unencrypted. The file layout, blocks and manifests are unchanged; anyone who can read the
 *     directory can decrypt the backup.
 *   * `sealed` -- the DEK is wrapped under the account/machine/password envelopes. This is the mode every
 *     repository created before the field existed is treated as having.
 */
export const REPO_ENCRYPTION_MODES = Object.freeze(['none', 'sealed']);

/** Default protection mode for a **new** repository: unencrypted (the user's 2026-11-17 decision). */
export const DEFAULT_REPO_ENCRYPTION = 'none';

/** The mode an existing descriptor means. A missing field means `sealed`: old repositories were sealed. */
export function descriptorEncryption(descriptor) {
  if (descriptor === null || descriptor === undefined) return null;
  return descriptor.encryption === 'none' ? 'none' : 'sealed';
}

/** Block size recorded by the descriptor. Kept in step with `manifest.mjs#BLOCK_SIZE` by the protocol test. */
export const REPO_BLOCK_SIZE = 4 * 1024 * 1024;

/** Directory names inside a repository root. Frozen by the protocol test. */
export const REPO_DIRS = Object.freeze({
  objects: 'objects',
  snapshots: 'snapshots',
  current: 'current',
  old: 'old',
  archive: 'archive',
  tmp: 'tmp',
});

/** Named failure codes. A caller matches on these, never on a message. */
export const LAYOUT_CODES = Object.freeze({
  UNRESOLVED: 'BACKUP_DIR_UNRESOLVED',
  INSIDE_SOURCE: 'BACKUP_DIR_INSIDE_SOURCE',
  PATH_IS_FILE: 'BACKUP_PATH_IS_FILE',
  DRIVE_MISSING: 'BACKUP_DRIVE_MISSING',
  NOT_WRITABLE: 'BACKUP_DIR_NOT_WRITABLE',
  NOT_A_REPO: 'BACKUP_DIR_NOT_A_REPO',
  DESCRIPTOR_UNREADABLE: 'BACKUP_DESCRIPTOR_UNREADABLE',
  VERSION_UNSUPPORTED: 'BACKUP_REPO_VERSION_UNSUPPORTED',
  CREATE_FAILED: 'BACKUP_CREATE_FAILED',
});

/** A layout failure with a stable `code`, so a route or a CLI never has to parse a message. */
export class BackupLayoutError extends Error {
  /**
   * @param {string} code
   * @param {string} detail human-readable detail; must not contain credentials
   * @param {object} [extra] extra fields merged onto the error
   */
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'BackupLayoutError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }

  /** The house refusal shape for routes: `{ok:false, reason_code, detail}`. */
  toRefusal() {
    return { ok: false, reason_code: this.code, detail: this.detail };
  }
}

/**
 * The default repository directory for a platform.
 *
 * Windows: `D:\DeepSeekHarness\BackUP` (the location the operator asked for, chosen because the session store
 * lives on C: and the backup must not compete with it for space). Anywhere else: `~/DSH-BackUP`, because a
 * hard-coded D: on macOS would be a path that never exists.
 *
 * @param {{platform?: string, home?: string}} [options]
 * @returns {string}
 */
export function defaultBackupDir(options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  return platform === 'win32' ? 'D:\\DeepSeekHarness\\BackUP' : path.join(home, 'DSH-BackUP');
}

/**
 * Resolve the repository root: explicit configuration first, then `W2M_BACKUP_DIR`, then the platform default.
 *
 * @param {{explicit?: string|null, env?: Record<string, string|undefined>, platform?: string, home?: string,
 *   dshHome?: string}} [options]
 * @returns {string} absolute path (may not exist yet)
 * @throws {BackupLayoutError} `BACKUP_DIR_UNRESOLVED` for an empty explicit value
 */
export function resolveBackupDir(options = {}) {
  const env = options.env ?? process.env;
  const explicit = options.explicit ?? null;
  if (explicit !== null && typeof explicit !== 'string') {
    throw new BackupLayoutError(LAYOUT_CODES.UNRESOLVED, 'backupDir must be a string when it is given');
  }
  const resolveFor = (value) => {
    const windowsShaped = /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
    return (options.platform === 'win32' || windowsShaped ? path.win32 : path).resolve(value);
  };
  if (explicit !== null && explicit.trim() !== '') return resolveFor(explicit);
  const fromEnv = env.W2M_BACKUP_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolveFor(fromEnv);
  return resolveFor(defaultBackupDir({ platform: options.platform, home: options.home }));
}

/**
 * Every path inside a repository, derived from the root. Pure: no filesystem access.
 *
 * @param {string} root
 * @returns {{root: string, descriptor: string, index: string, objects: string, snapshots: string,
 *   current: string, old: string, archive: string, tmp: string}}
 */
export function repoPaths(root) {
  const base = path.resolve(root);
  return {
    root: base,
    descriptor: path.join(base, DESCRIPTOR_FILE),
    index: path.join(base, 'index.jsonl'),
    objects: path.join(base, REPO_DIRS.objects),
    snapshots: path.join(base, REPO_DIRS.snapshots),
    current: path.join(base, REPO_DIRS.current),
    old: path.join(base, REPO_DIRS.old),
    archive: path.join(base, REPO_DIRS.archive),
    tmp: path.join(base, REPO_DIRS.tmp),
  };
}

/**
 * True when `child` is `parent` or inside it, by resolved path rather than by string prefix.
 *
 * `path.relative` is used because `C:\DSH` is a string prefix of `C:\DSH-backup` while being no parent at all.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const windowsShaped = (candidate) => /^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith('\\\\');
  const pathApi = windowsShaped(parent) || windowsShaped(child) ? path.win32 : path;
  const from = pathApi.resolve(parent);
  const to = pathApi.resolve(child);
  const rel = pathApi.relative(from, to);
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}

/** Read the descriptor, or `null` when it does not exist. @throws {BackupLayoutError} when unreadable. */
export function readDescriptor(root) {
  const file = path.join(path.resolve(root), DESCRIPTOR_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new BackupLayoutError(LAYOUT_CODES.DESCRIPTOR_UNREADABLE, `${file}: ${error?.code ?? 'unreadable'}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BackupLayoutError(
      LAYOUT_CODES.DESCRIPTOR_UNREADABLE,
      `${file}: not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackupLayoutError(LAYOUT_CODES.DESCRIPTOR_UNREADABLE, `${file}: not a JSON object`);
  }
  return parsed;
}

/**
 * Validate a descriptor as *this* format.
 *
 * A higher `version` is refused rather than upgraded implicitly (`VERSION_UNSUPPORTED`): a newer repository
 * may have block-level semantics this version would misread, and silently writing v1 data into it is the
 * destructive half of the mistake.
 *
 * @param {object} descriptor
 * @returns {{ok: true, descriptor: object} | {ok: false, error: BackupLayoutError}}
 */
export function validateDescriptor(descriptor) {
  if (descriptor?.format !== REPO_FORMAT) {
    return {
      ok: false,
      error: new BackupLayoutError(
        LAYOUT_CODES.NOT_A_REPO,
        `the directory holds a ${JSON.stringify(String(descriptor?.format ?? 'unknown'))} descriptor, not ${REPO_FORMAT}`,
      ),
    };
  }
  if (!Number.isSafeInteger(descriptor?.version) || descriptor.version < 1) {
    return {
      ok: false,
      error: new BackupLayoutError(LAYOUT_CODES.DESCRIPTOR_UNREADABLE, 'the descriptor has no usable version'),
    };
  }
  if (descriptor.version > REPO_VERSION) {
    return {
      ok: false,
      error: new BackupLayoutError(
        LAYOUT_CODES.VERSION_UNSUPPORTED,
        `repository version ${descriptor.version} is newer than this build understands (${REPO_VERSION})`,
      ),
    };
  }
  // Additive field (`encryption: 'none' | 'sealed'`). Absent means `sealed` (every pre-existing repository);
  // an unknown value is refused rather than read as one of the modes, because guessing here would decide
  // whether a repository opens with a credential.
  if (descriptor.encryption !== undefined && !REPO_ENCRYPTION_MODES.includes(descriptor.encryption)) {
    return {
      ok: false,
      error: new BackupLayoutError(
        LAYOUT_CODES.DESCRIPTOR_UNREADABLE,
        `the descriptor names encryption ${JSON.stringify(String(descriptor.encryption))}, which is not one of ${REPO_ENCRYPTION_MODES.join(', ')}`,
      ),
    };
  }
  return { ok: true, descriptor };
}

/** Free bytes on the volume holding `root`, or `null` when the platform cannot say. Never throws. */
export function freeBytes(root) {
  try {
    const stat = fs.statfsSync(path.resolve(root));
    return Number(stat.bsize) * Number(stat.bavail);
  } catch {
    return null;
  }
}

/**
 * Inspect a repository **without creating or modifying anything**.
 *
 * This is what `GET /api/w2m/backup/status` and `w2m-backup status` call. It must answer for three states that
 * are all normal: not configured yet (directory absent), configured but empty (exists, not initialised), and
 * an initialised repository. "Cannot tell" is reported as `error` rather than thrown, because a status card
 * that fails to render is worse than one that says why.
 *
 * @param {string} root
 * @param {{dshHome?: string|null}} [options]
 * @returns {{
 *   root: string, exists: boolean, is_file: boolean, initialized: boolean, writable: boolean|null,
 *   format: string|null, version: number|null, block_size: number|null, cipher: string|null,
 *   encryption: 'none'|'sealed'|null, created_at: string|null, free_bytes: number|null, dsh_home: string|null,
 *   counts: {objects: number, snapshots: number, old: number},
 *   error: {code: string, detail: string}|null
 * }}
 */
export function inspectLayout(root, options = {}) {
  const paths = repoPaths(root);
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? path.resolve(options.dshHome) : null;
  const report = {
    root: paths.root,
    exists: false,
    is_file: false,
    initialized: false,
    // `null`, not `false`: a directory that does not exist yet cannot be probed for writability without
    // creating it, and creating it is exactly what a read-only status check must not do.
    writable: null,
    format: null,
    version: null,
    block_size: null,
    cipher: null,
    // `'none' | 'sealed' | null`: null means "no descriptor yet", so there is no mode to report. An existing
    // descriptor without the field means `sealed` (descriptorEncryption handles that).
    encryption: null,
    created_at: null,
    free_bytes: null,
    dsh_home: dshHome,
    counts: { objects: 0, snapshots: 0, old: 0 },
    error: null,
  };

  let stat;
  try {
    stat = fs.statSync(paths.root);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      report.error = { code: LAYOUT_CODES.CREATE_FAILED, detail: `could not stat ${paths.root}: ${error?.code ?? 'unknown'}` };
    }
    return report;
  }
  report.exists = true;
  if (!stat.isDirectory()) {
    report.is_file = true;
    report.error = { code: LAYOUT_CODES.PATH_IS_FILE, detail: `${paths.root} is not a directory` };
    return report;
  }

  report.free_bytes = freeBytes(paths.root);
  try {
    fs.accessSync(paths.root, fs.constants.W_OK);
    report.writable = true;
  } catch (error) {
    report.error = { code: LAYOUT_CODES.NOT_WRITABLE, detail: `${paths.root}: ${error?.code ?? 'not writable'}` };
  }

  try {
    const descriptor = readDescriptor(paths.root);
    if (descriptor !== null) {
      const validated = validateDescriptor(descriptor);
      if (validated.ok) {
        report.initialized = true;
        report.format = String(descriptor.format);
        report.version = Number(descriptor.version);
        report.block_size = Number.isSafeInteger(descriptor.block_size) ? descriptor.block_size : null;
        report.cipher = typeof descriptor.cipher === 'string' ? descriptor.cipher : null;
        report.encryption = descriptorEncryption(descriptor);
        report.created_at = typeof descriptor.created_at === 'string' ? descriptor.created_at : null;
      } else if (report.error === null) {
        report.error = { code: validated.error.code, detail: validated.error.detail };
      }
    }
  } catch (error) {
    if (report.error === null) {
      report.error = { code: error.code ?? LAYOUT_CODES.DESCRIPTOR_UNREADABLE, detail: error.detail ?? String(error?.message ?? error) };
    }
  }

  if (report.initialized) {
    report.counts = {
      objects: countEntries(paths.objects),
      snapshots: countEntries(paths.snapshots),
      old: countEntries(paths.old),
    };
  }
  return report;
}

/** Immediate children of a directory, or 0 when it is absent/unreadable. Never throws. */
function countEntries(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/** The descriptor this version writes for a fresh repository. */
export function newDescriptor(now = new Date(), encryption = DEFAULT_REPO_ENCRYPTION) {
  if (!REPO_ENCRYPTION_MODES.includes(encryption)) {
    throw new BackupLayoutError(
      LAYOUT_CODES.DESCRIPTOR_UNREADABLE,
      `encryption must be one of ${REPO_ENCRYPTION_MODES.join(', ')}, got ${JSON.stringify(String(encryption))}`,
    );
  }
  return {
    format: REPO_FORMAT,
    version: REPO_VERSION,
    block_size: REPO_BLOCK_SIZE,
    cipher: REPO_CIPHER,
    encryption,
    created_at: now.toISOString(),
  };
}

/**
 * Rewrite an existing descriptor's additive `encryption` field, atomically, and only when it differs.
 *
 * The descriptor is descriptive, not authoritative: the key document decides how a repository opens. This
 * helper keeps the metadata truthful after the key document changes mode (`setRepositoryPassword` upgrades an
 * open repository to sealed; `setEncryptionMode` downgrades a sealed one to open). Absent descriptor or an
 * unreadable one is reported as `{ok:false}` -- never created here, because a mode change is not a reason to
 * initialise a repository.
 *
 * @param {string} root
 * @param {'none'|'sealed'} encryption
 * @returns {{ok: boolean, changed: boolean, file: string, reason_code: string|null, detail: string|null}}
 */
export function syncDescriptorEncryption(root, encryption) {
  if (!REPO_ENCRYPTION_MODES.includes(encryption)) {
    throw new BackupLayoutError(
      LAYOUT_CODES.DESCRIPTOR_UNREADABLE,
      `encryption must be one of ${REPO_ENCRYPTION_MODES.join(', ')}, got ${JSON.stringify(String(encryption))}`,
    );
  }
  const file = path.join(path.resolve(root), DESCRIPTOR_FILE);
  let descriptor;
  try {
    descriptor = readDescriptor(root);
  } catch (error) {
    return { ok: false, changed: false, file, reason_code: error?.code ?? LAYOUT_CODES.DESCRIPTOR_UNREADABLE, detail: error?.detail ?? String(error?.message ?? error) };
  }
  if (descriptor === null) {
    return { ok: false, changed: false, file, reason_code: LAYOUT_CODES.NOT_A_REPO, detail: `${file} does not exist; no descriptor to update` };
  }
  if (descriptor.encryption === encryption) return { ok: true, changed: false, file, reason_code: null, detail: null };
  try {
    writeFileAtomic(file, `${JSON.stringify({ ...descriptor, encryption }, null, 2)}\n`);
  } catch (error) {
    return { ok: false, changed: false, file, reason_code: error?.code ?? LAYOUT_CODES.CREATE_FAILED, detail: error?.detail ?? String(error?.message ?? error) };
  }
  return { ok: true, changed: true, file, reason_code: null, detail: null };
}

/**
 * Create (or verify) the repository layout.
 *
 * Idempotent: an initialised repository is inspected and returned, never re-initialised and never overwritten.
 * Every failure is a `BackupLayoutError` with a code, so the CLI and the routes can say *which* of the three
 * first-run problems happened instead of printing EPERM.
 *
 * @param {string} root
 * @param {{dshHome?: string|null, now?: Date, encryption?: 'none'|'sealed'}} [options] `encryption` is written
 *   only when the descriptor does not exist yet; an existing repository is never re-initialised or re-written.
 * @returns {{
 *   created: boolean, paths: ReturnType<typeof repoPaths>, descriptor: object,
 *   free_bytes: number|null, writable_probe: string
 * }}
 */
export function ensureLayout(root, options = {}) {
  const paths = repoPaths(root);
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? path.resolve(options.dshHome) : null;

  if (dshHome !== null && isInside(dshHome, paths.root)) {
    throw new BackupLayoutError(
      LAYOUT_CODES.INSIDE_SOURCE,
      `${paths.root} is inside the DSH home being backed up (${dshHome}); a repository must live outside it`,
    );
  }

  let stat = null;
  try {
    stat = fs.statSync(paths.root);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new BackupLayoutError(LAYOUT_CODES.CREATE_FAILED, `could not stat ${paths.root}: ${error?.code ?? 'unknown'}`);
    }
  }
  if (stat !== null && !stat.isDirectory()) {
    throw new BackupLayoutError(LAYOUT_CODES.PATH_IS_FILE, `${paths.root} exists and is not a directory`);
  }

  const existing = stat === null ? null : readDescriptor(paths.root);
  if (existing !== null) {
    const validated = validateDescriptor(existing);
    if (!validated.ok) throw validated.error;
  }

  let created = false;
  try {
    for (const dir of Object.values(REPO_DIRS)) fs.mkdirSync(path.join(paths.root, dir), { recursive: true });
  } catch (error) {
    throw createFailure(error, paths.root);
  }
  if (stat === null) created = existing === null;

  const descriptor = existing ?? newDescriptor(options.now, options.encryption ?? DEFAULT_REPO_ENCRYPTION);
  if (existing === null) {
    const staging = path.join(paths.tmp, `descriptor-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(staging, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
      fs.renameSync(staging, paths.descriptor);
    } catch (error) {
      try {
        fs.rmSync(staging, { force: true });
      } catch {
        /* the failure being reported is the write, not the cleanup */
      }
      throw createFailure(error, paths.root);
    }
  }

  // A write probe rather than a permission bit: on Windows an ACL can allow `mkdir` and refuse `write`, and
  // the first real backup is the wrong time to find that out.
  const probe = path.join(paths.tmp, `write-probe-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(probe, 'w2m-backup-probe\n', 'utf8');
    fs.rmSync(probe, { force: true });
  } catch (error) {
    throw createFailure(error, paths.root);
  }

  return { created, paths, descriptor, free_bytes: freeBytes(paths.root), writable_probe: probe };
}

/** Turn a filesystem error into the specific layout code it deserves. */
function createFailure(error, root) {
  const code = error?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new BackupLayoutError(LAYOUT_CODES.NOT_WRITABLE, `${root}: ${code}`);
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new BackupLayoutError(LAYOUT_CODES.DRIVE_MISSING, `${root}: ${code} (does the drive or parent directory exist?)`);
  }
  return new BackupLayoutError(LAYOUT_CODES.CREATE_FAILED, `${root}: ${code ?? (error instanceof Error ? error.message : String(error))}`);
}
