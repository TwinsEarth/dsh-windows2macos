/**
 * Reading a file out of the project, safely (v0.7.0).
 *
 * ## The two defects this file exists to make impossible
 *
 * **1. A lexical fence is not a fence.** `dsh-chatops` 0.1.0 resolved the requested
 * path and compared prefixes:
 *
 *     const abs = resolve(cwd, relPath)
 *     if (abs !== cwd && !abs.startsWith(cwd + sep)) { refuse }
 *
 * `resolve()` normalises `..` but does **not** resolve symlinks, and `statSync` and
 * `readFile` both follow them. A symlink *inside* the project pointing anywhere
 * readable — `~/.dsh/.credentials.yaml` on the machine this was audited against —
 * resolves to a path that still begins with the project root, so the check passes and
 * `/send` ships the target's contents to a chat platform. The containment check has to
 * be performed on the **real** path, which means resolving symlinks on both sides and
 * re-checking after resolution, because the target itself may be a link.
 *
 * **2. A delivery that failed must not be reported as delivered.** Only one of that
 * plugin's four channels re-threw a failed send; the other three logged, told the user
 * "❌ 发送失败", and then returned normally — so the caller counted the file as sent and
 * the model was told `已发送到 N 个 IM 窗口`. The read side here returns a discriminated
 * result rather than throwing, and the send side is required to turn a failure into a
 * failed result. Neither layer is allowed to guess.
 *
 * ## What this module is
 *
 * Pure I/O with injected `stat`/`realpath`/`readFile`, so every refusal is testable
 * without a real filesystem and without a symlink that has to exist on the host running
 * the tests. Nothing here knows about chat platforms.
 */

/**
 * Path arithmetic is done in **posix** terms, on every platform.
 *
 * Two reasons, and the second is the one that matters. A relay, a Linux VPS and a
 * container image all speak `/`; and a fence whose containment logic depends on
 * `node:path`'s platform-specific `sep` cannot be tested for symlink escapes on Windows,
 * which is where the fence is most needed and where the plugin that got this wrong was
 * developed. Choosing one separator makes the logic identical everywhere and testable
 * from a POSIX-only fixture, which is what the suite does.
 */
import { resolve, sep, isAbsolute, basename, extname } from 'node:path/posix';

/** Why a file was not sent. Reported, never thrown: a refusal is a normal answer. */
export const FILE_REFUSAL = Object.freeze({
  /** The path escaped the project root, after symlinks were resolved. */
  ESCAPED: 'escaped_project',
  /** The path is absolute, or otherwise not project-relative. */
  NOT_RELATIVE: 'not_relative',
  /** Nothing is there. */
  MISSING: 'missing',
  /** It exists and is not a regular file. */
  NOT_A_FILE: 'not_a_file',
  /** Larger than the configured ceiling. */
  TOO_LARGE: 'too_large',
  /** The extension is one the fleet refuses to move through a chat platform. */
  TYPE_REFUSED: 'type_refused',
  /** The path is structurally unusable. */
  MALFORMED: 'malformed',
});

/**
 * Extensions that are never sent, whatever the operator asks for.
 *
 * A chat platform is a third-party service and a message is not a filesystem. This is
 * deliberately a **deny-list of shapes** rather than an allow-list of extensions: the
 * useful case is "send me the log / the screenshot / the report", and an allow-list
 * would refuse the perfectly ordinary file someone actually wanted. What is refused is
 * the set whose contents are credentials or executable code, where "I asked for it" is
 * not a good enough reason.
 */
export const REFUSED_EXTENSIONS = Object.freeze([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
  '.env', '.credentials', '.secret', '.secrets',
  '.exe', '.dll', '.so', '.dylib', '.msi', '.bat', '.cmd', '.ps1', '.sh', '.app',
]);

/** Name fragments refused regardless of extension: `.env.local`, `id_rsa`, `foo.pem.bak`. */
const REFUSED_NAME_PATTERNS = Object.freeze([
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /(^|[._-])(secret|credential|password|passwd|token)s?([._-]|$)/i,
]);

/**
 * Default ceiling. A chat platform will refuse a large file anyway, and the failure
 * should be ours, named, before the upload starts — not the platform's, after it has
 * half-sent something.
 */
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Create a reader bound to one project root.
 *
 * @param {object} options
 * @param {string} options.projectRoot Absolute project root. The fence is this directory.
 * @param {number} [options.maxBytes]
 * @param {string[]} [options.extraRefusedExtensions]
 * @param {string[]} [options.allowExtensions] Escape hatch: these are permitted even if refused above.
 * @param {(p: string) => Promise<{isFile: () => boolean, size: number, isSymbolicLink?: () => boolean}>} [options.lstat]
 * @param {(p: string) => Promise<string>} [options.realpath]
 * @param {(p: string) => Promise<Buffer>} [options.readFile]
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createFileReader(options) {
  const { projectRoot } = options;
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new TypeError('createFileReader requires a projectRoot');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const audit = options.audit ?? (() => {});
  const refusedExtensions = new Set(
    [...REFUSED_EXTENSIONS, ...(options.extraRefusedExtensions ?? [])].map((e) => e.toLowerCase()),
  );
  const allowedExtensions = new Set((options.allowExtensions ?? []).map((e) => e.toLowerCase()));

  const lstat = options.lstat ?? (async (p) => (await import('node:fs/promises')).lstat(p));
  const realpath = options.realpath ?? (async (p) => (await import('node:fs/promises')).realpath(p));
  const readFile = options.readFile ?? (async (p) => (await import('node:fs/promises')).readFile(p));

  /**
   * The real project root.
   *
   * A failure is **not** cached. Caching one would turn a transient problem — the
   * workspace briefly unreadable during a checkout, say — into a reader that refuses
   * every path for the rest of the process, with a stale reason.
   */
  let realRootCache = null;
  async function realRoot() {
    if (realRootCache !== null) return realRootCache;
    const resolved = await realpath(projectRoot);
    realRootCache = resolved;
    return resolved;
  }

  /** Is `candidate` the root itself or inside it? Compared after symlink resolution. */
  function contains(root, candidate) {
    if (candidate === root) return true;
    return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
  }

  /**
   * Read one project-relative file.
   *
   * @param {string} relPath
   * @returns {Promise<{ok: true, path: string, name: string, bytes: number, data: Buffer}
   *                  | {ok: false, reason: string, detail?: string}>}
   */
  async function read(relPath) {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      return refuse(FILE_REFUSAL.MALFORMED, 'empty path');
    }
    // An absolute path is not a project-relative one, and treating it as one is how a
    // "relative to the project" API quietly becomes an arbitrary-read API.
    if (isAbsolute(relPath)) return refuse(FILE_REFUSAL.NOT_RELATIVE, relPath);
    // NUL bytes cannot appear in a real path and truncate in some syscalls.
    if (relPath.includes('\u0000')) return refuse(FILE_REFUSAL.MALFORMED, 'NUL in path');

    const root = await realRoot();
    const lexical = resolve(root, relPath);

    // Cheap refusal first, so a traversal never even reaches the filesystem.
    if (!contains(root, lexical)) return refuse(FILE_REFUSAL.ESCAPED, `lexical: ${lexical}`);

    let stats;
    try {
      stats = await lstat(lexical);
    } catch {
      return refuse(FILE_REFUSAL.MISSING, relPath);
    }

    // The real check. `realpath` follows every link in every component, so a symlinked
    // directory halfway down the path is caught as surely as a symlinked leaf.
    let real;
    try {
      real = await realpath(lexical);
    } catch {
      return refuse(FILE_REFUSAL.MISSING, relPath);
    }
    if (!contains(root, real)) {
      // The one that 0.1.0 shipped: a link inside the project pointing out of it.
      return refuse(FILE_REFUSAL.ESCAPED, `resolved: ${real}`);
    }

    const name = basename(real);
    const ext = extname(name).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      if (refusedExtensions.has(ext)) return refuse(FILE_REFUSAL.TYPE_REFUSED, ext);
      if (REFUSED_NAME_PATTERNS.some((re) => re.test(name))) return refuse(FILE_REFUSAL.TYPE_REFUSED, name);
    }

    // `lstat` above describes the link; what matters for "is this a file" is the target.
    let target;
    try {
      target = await lstat(real);
    } catch {
      return refuse(FILE_REFUSAL.MISSING, relPath);
    }
    if (!target.isFile()) return refuse(FILE_REFUSAL.NOT_A_FILE, relPath);
    if (target.size > maxBytes) {
      return refuse(FILE_REFUSAL.TOO_LARGE, `${target.size} > ${maxBytes}`);
    }

    const data = await readFile(real);
    audit('file/read', { name, bytes: data.length });
    return { ok: true, path: real, name, bytes: data.length, data };
  }

  function refuse(reason, detail) {
    audit('file/refused', { reason, detail: detail ?? null });
    return { ok: false, reason, detail };
  }

  return { read, get projectRoot() { return projectRoot; }, maxBytes };
}

/**
 * Send one file to one destination, and be honest about whether it worked.
 *
 * The `send` callback is the channel's own upload. This wrapper exists so that the
 * **only** way to report success is for `send` to have resolved: a rejected send
 * becomes `{ok: false}` here, and the caller has no way to count it as delivered. That
 * is the whole fix for "the tool told the model it sent four files and sent two".
 *
 * @param {object} options
 * @param {(file: {name: string, bytes: number, data: Buffer}, caption: string) => Promise<void>} options.send
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createFileSender(options) {
  const send = options.send;
  if (typeof send !== 'function') throw new TypeError('createFileSender requires a send()');
  const audit = options.audit ?? (() => {});

  /**
   * @param {{name: string, bytes: number, data: Buffer}} file
   * @param {string} [caption]
   * @returns {Promise<{ok: true} | {ok: false, reason: string, detail?: string}>}
   */
  async function deliver(file, caption = '') {
    try {
      await send(file, caption);
      audit('file/sent', { name: file.name, bytes: file.bytes });
      return { ok: true };
    } catch (error) {
      // Named, not swallowed. A channel that logged this and returned would make the
      // count in the caller's reply a lie.
      const detail = error instanceof Error ? error.message : String(error);
      audit('file/send-failed', { name: file.name, detail });
      return { ok: false, reason: 'send_failed', detail };
    }
  }

  return { deliver };
}

/**
 * Fan one file out to several destinations and report the count truthfully.
 *
 * Returns the outcomes rather than a sentence, because the sentence 0.1.0 produced —
 * "已发送到 N 个 IM 窗口" — was composed from the number of windows it *tried*, not the
 * number that succeeded.
 *
 * @param {object} options
 * @param {Array<{window: string, deliver: (file: object, caption: string) => Promise<{ok: boolean, [k: string]: unknown}>}>} options.targets
 */
export async function fanOutFile({ targets, file, caption = '' }) {
  const results = await Promise.all(
    targets.map(async (target) => ({ window: target.window, ...(await target.deliver(file, caption)) })),
  );
  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  return {
    sent,
    attempted: results.length,
    failed: failed.map((r) => ({ window: r.window, reason: r.reason, detail: r.detail })),
    // Exactly true, and the caller is expected to use this rather than `attempted`.
    allSent: sent === results.length && results.length > 0,
    results,
  };
}
