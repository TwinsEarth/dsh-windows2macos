/**
 * Git-side evidence collection: the three anchors (§6.2) plus the post-run
 * worktree state.
 *
 * The worktree fingerprint is `git-temp-index-tree/v1`, which the protocol
 * pins down as:
 *
 *     GIT_INDEX_FILE=<tmp> git read-tree HEAD
 *     GIT_INDEX_FILE=<tmp> git add -A
 *     GIT_INDEX_FILE=<tmp> git write-tree        -> tree hash
 *
 * Three lessons are baked into the implementation:
 *
 *   * **One temp index per call, never shared.**  `GIT_INDEX_FILE` is a
 *     process-wide environment variable, so a single well-known path makes
 *     concurrent fingerprint jobs collide on `<index>.lock` and interleave
 *     their contents.  Every call here mints its own random index path.
 *   * **Never `git stash create`.**  Measured: it drops untracked files, and
 *     it returns an empty string both for "clean" and for "only untracked
 *     files exist", which makes those two states indistinguishable.
 *   * **A refusal must name its reason.**  A failed fingerprint returns a
 *     reason code, never `null` presented as success.
 *
 * Read-only mode additionally redirects new objects into a temporary object
 * store (`GIT_OBJECT_DIRECTORY` + an alternate pointing at the real one), so
 * the fingerprint does not drop loose objects into `.git/objects` of a project
 * we promised not to write to.  Both modes must yield the same tree hash; the
 * test suite asserts exactly that.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runArgv } from './exec.mjs';
import { findExecutable } from './caps.mjs';

export { sha256Hex } from './exec.mjs';

/** Fingerprint algorithm identifier, as required by §5.1. */
export const FINGERPRINT_ALGO = 'git-temp-index-tree/v1';

/** Warning code for "we could not fingerprint the worktree". */
export const WARN_FINGERPRINT_UNAVAILABLE = 'FINGERPRINT_UNAVAILABLE';

/** Warning code for "the worktree was already dirty when we started". */
export const WARN_DIRTY_WORKTREE = 'DIRTY_WORKTREE';

/** Reason codes for `fingerprint_error`. */
export const FINGERPRINT_ERRORS = {
  GIT_MISSING: 'GIT_MISSING',
  NOT_A_REPO: 'NOT_A_REPO',
  NO_HEAD: 'NO_HEAD',
  READ_TREE_FAILED: 'READ_TREE_FAILED',
  ADD_FAILED: 'ADD_FAILED',
  WRITE_TREE_FAILED: 'WRITE_TREE_FAILED',
  GIT_TIMEOUT: 'GIT_TIMEOUT',
  TEMP_INDEX_FAILED: 'TEMP_INDEX_FAILED',
  BAD_TREE: 'BAD_TREE',
};

const HEX40 = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Canonical JSON (RFC 8785 / JCS) and hashing
// ---------------------------------------------------------------------------

/**
 * RFC 8785 JSON canonicalization.
 *
 * Only what the envelope needs: sorted object keys (UTF-16 code-unit order,
 * which is what `Array.prototype.sort` does by default), no insignificant
 * whitespace, and ECMAScript number formatting.  `undefined` throws instead of
 * vanishing, because a required envelope field must be written as an explicit
 * `null` rather than silently dropped.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function jcs(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`jcs: non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (type === 'undefined') throw new TypeError('jcs: undefined is not representable');
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(',')}]`;
  if (type === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const entry = value[key];
      if (entry === undefined) throw new TypeError(`jcs: property ${key} is undefined`);
      parts.push(`${JSON.stringify(key)}:${jcs(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`jcs: unsupported type ${type}`);
}

/**
 * SHA-256 over the canonical form of `value`.
 *
 * @param {unknown} value
 * @returns {string} lowercase hex
 */
export function jcsSha256(value) {
  return createHash('sha256').update(jcs(value), 'utf8').digest('hex');
}

/**
 * `command_hash` per §5.1: `sha256(JCS(argv) + "|" + shell_id + "|" + cwd_rel)`.
 *
 * @param {string[]} argv
 * @param {string} shellId
 * @param {string} cwdRel Forward-slash relative path.
 * @returns {string}
 */
export function commandHash(argv, shellId, cwdRel) {
  if (!Array.isArray(argv)) throw new TypeError('commandHash: argv must be an array');
  const material = `${jcs(argv)}|${shellId}|${normalizeRelPath(cwdRel)}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * `command_hash` for a whole pipeline (v0.3.3).
 *
 * Must produce exactly what the relay's `computePipelineCommandHash` produces, or the anchor check in
 * the relay's Step 1 sees `command_hash mismatch` and every pipeline is `unverifiable` -- which is what
 * happened on the first end-to-end run. The two implementations are deliberately independent
 * (neither imports the other) and the shared shape is asserted by a test that recomputes both, so a
 * drift in either is caught rather than silently agreeing.
 *
 * The hash binds **every** stage: bound to stage 0 alone, two chains differing after the first stage
 * would share a hash, and an envelope from the wrong chain would still verify.
 *
 * @param {Array<{command_argv: string[], cwd_rel?: string, continue_on_failure?: boolean}>} stages
 * @param {string} shellId
 * @returns {string}
 */
export function pipelineCommandHash(stages, shellId) {
  if (!Array.isArray(stages)) throw new TypeError('pipelineCommandHash: stages must be an array');
  const canonical = stages.map((s) => ({
    command_argv: s.command_argv,
    cwd_rel: normalizeRelPath(s.cwd_rel ?? '.'),
    continue_on_failure: s.continue_on_failure === true,
  }));
  const material = `${jcs(canonical)}|${shellId}|pipeline`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * `envelope_sha256` per §5.1: JCS hash of the envelope without that field.
 *
 * @param {Record<string, unknown>} envelope
 * @returns {string}
 */
export function envelopeSha256(envelope) {
  const copy = { ...envelope };
  delete copy.envelope_sha256;
  return jcsSha256(copy);
}

/**
 * Normalize a path to the contract's forward-slash relative form.
 *
 * @param {string} p
 * @returns {string} `'.'` when empty.
 */
export function normalizeRelPath(p) {
  if (p === null || p === undefined) return '.';
  let out = String(p).replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  out = out.replace(/\/{2,}/g, '/');
  out = out.replace(/\/+$/, '');
  return out === '' ? '.' : out;
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GitRunResult
 * @property {number|null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timed_out
 * @property {string|null} spawn_error
 * @property {import('./exec.mjs').ExecResult} raw
 */

/**
 * Run one git command with an argv array (no shell), always non-interactive.
 *
 * `GIT_OPTIONAL_LOCKS=0` matters for read-only mode: without it a plain
 * `git status` refreshes and rewrites `.git/index`, i.e. writes to a project
 * we promised not to touch.
 *
 * @param {string[]} args Arguments after the executable.
 * @param {object} [options]
 * @param {string} options.cwd
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.gitPath]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<GitRunResult>}
 */
export async function gitRun(args, options = {}) {
  const gitPath = options.gitPath ?? resolveGit();
  if (!gitPath) {
    return {
      code: null,
      stdout: '',
      stderr: 'git executable not found',
      timed_out: false,
      spawn_error: 'ENOENT',
      raw: null,
    };
  }
  const raw = await runArgv([gitPath, '--no-pager', ...args], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 60000,
    maxOutputBytes: 8 * 1024 * 1024,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      ...(options.env ?? {}),
    },
    signal: options.signal,
  });
  return {
    code: raw.exit_code,
    stdout: raw.stdout.toString('utf8'),
    stderr: raw.stderr.toString('utf8'),
    timed_out: raw.timed_out,
    spawn_error: raw.spawn_error ? raw.spawn_error.code : null,
    raw,
  };
}

/** @type {string|null|undefined} */
let cachedGitPath;

/** Resolve the git executable once per process. */
export function resolveGit() {
  if (cachedGitPath === undefined) {
    cachedGitPath = findExecutable('git', { env: process.env });
  }
  return cachedGitPath;
}

/** Test seam: forget the cached git path. */
export function resetGitCache() {
  cachedGitPath = undefined;
}

/**
 * `git --version` output, or `null`.
 *
 * @returns {Promise<string|null>}
 */
export async function gitVersion(options = {}) {
  const result = await gitRun(['--version'], { cwd: options.cwd ?? process.cwd(), ...options });
  if (result.code !== 0) return null;
  const match = result.stdout.match(/git version\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * Resolve a single revision to a 40-hex object id.
 *
 * @param {string} rev
 * @param {object} options
 * @returns {Promise<string|null>}
 */
export async function revParse(rev, options) {
  const result = await gitRun(['rev-parse', '--verify', '--quiet', rev], options);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return HEX40.test(value) ? value : null;
}

/**
 * Current `HEAD` commit, or `null` in an unborn/absent repository.
 *
 * @param {object} options
 * @returns {Promise<string|null>}
 */
export function headCommit(options) {
  return revParse('HEAD^{commit}', options);
}

/**
 * Tree hash of `HEAD`, or `null`.
 *
 * @param {object} options
 * @returns {Promise<string|null>}
 */
export function headTree(options) {
  return revParse('HEAD^{tree}', options);
}

/**
 * Whether the worktree (including untracked files) differs from HEAD.
 *
 * @param {object} options
 * @returns {Promise<boolean|null>} `null` when git could not answer.
 */
export async function isDirty(options) {
  const result = await gitRun(['status', '--porcelain=v1', '--untracked-files=normal', '-z'], options);
  if (result.code !== 0) return null;
  return result.stdout.length > 0;
}

/**
 * Untracked, non-ignored files, sorted, forward-slash relative paths.
 *
 * @param {object} options
 * @returns {Promise<string[]>}
 */
export async function untrackedFiles(options) {
  const result = await gitRun(['ls-files', '--others', '--exclude-standard', '-z'], options);
  if (result.code !== 0) return [];
  return splitZ(result.stdout).map(normalizeRelPath).sort();
}

/**
 * `git diff --numstat` against a base revision, in the envelope's shape.
 *
 * @param {string} base Revision to diff against.
 * @param {object} options
 * @returns {Promise<Array<{path: string, added: number, deleted: number, is_binary: boolean}>>}
 */
export async function diffNumstat(base, options) {
  const result = await gitRun(['diff', '--numstat', '-z', '--no-renames', base], options);
  if (result.code !== 0) return [];
  const records = splitZ(result.stdout);
  /** @type {Array<{path: string, added: number, deleted: number, is_binary: boolean}>} */
  const out = [];
  for (const record of records) {
    if (record === '') continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const [added, deleted, ...rest] = parts;
    const isBinary = added === '-' || deleted === '-';
    out.push({
      path: normalizeRelPath(rest.join('\t')),
      added: isBinary ? 0 : Number.parseInt(added, 10) || 0,
      deleted: isBinary ? 0 : Number.parseInt(deleted, 10) || 0,
      is_binary: isBinary,
    });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** @param {string} text */
function splitZ(text) {
  return text.split('\u0000').filter((entry) => entry !== '');
}

// ---------------------------------------------------------------------------
// Worktree fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute the `git-temp-index-tree/v1` worktree fingerprint.
 *
 * @param {object} options
 * @param {string} options.cwd Worktree root (or any path inside it).
 * @param {string} [options.tmpDir] Where the temp index/object store live.
 * @param {string} [options.gitPath]
 * @param {'temp'|'project'} [options.objectMode] `'temp'` (default) keeps new
 *   loose objects out of the project; `'project'` is the plain recipe.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{fingerprint: string|null, error: string|null, detail: string|null}>}
 */
export async function treeFingerprint(options) {
  const { cwd, tmpDir, objectMode = 'temp', timeoutMs = 60000 } = options;
  const gitPath = options.gitPath ?? resolveGit();
  if (!gitPath) {
    return { fingerprint: null, error: FINGERPRINT_ERRORS.GIT_MISSING, detail: null };
  }
  const gitOptions = { cwd, gitPath, timeoutMs, signal: options.signal };

  let scratch = null;
  let tempIndex = null;
  try {
    try {
      scratch = mkdtempSync(join(tmpDir ?? tmpdir(), 'w2m-fp-'));
    } catch (error) {
      return {
        fingerprint: null,
        error: FINGERPRINT_ERRORS.TEMP_INDEX_FAILED,
        detail: String(error?.message ?? error),
      };
    }
    // The temp index has a random name: concurrent fingerprints in this process
    // (and in sibling processes) must never share one GIT_INDEX_FILE.
    tempIndex = join(scratch, `index-${process.pid}-${randomUUID()}`);

    /** @type {Record<string,string|undefined>} */
    const env = { GIT_INDEX_FILE: tempIndex };

    if (objectMode === 'temp') {
      const objectsDir = join(scratch, 'objects');
      const alt = await gitRun(['rev-parse', '--git-path', 'objects'], gitOptions);
      if (alt.code !== 0) {
        // Not a repository (or unusable): let read-tree produce the diagnosis.
        const reason = await diagnoseFailure(gitOptions);
        return {
          fingerprint: null,
          error: reason.error,
          detail: reason.detail ?? (alt.stderr.trim() || null),
        };
      }
      try {
        mkdirSync(objectsDir, { recursive: true });
      } catch (error) {
        return {
          fingerprint: null,
          error: FINGERPRINT_ERRORS.TEMP_INDEX_FAILED,
          detail: String(error?.message ?? error),
        };
      }
      env.GIT_OBJECT_DIRECTORY = objectsDir;
      // Keep the real object database readable through an alternate, so no
      // object is ever written into the project. `--git-path objects` may be
      // relative to cwd (`.git/objects`) or already absolute.
      const altPath = alt.stdout.trim();
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = isAbsolute(altPath)
        ? altPath
        : resolve(cwd, altPath);
    }

    const readTree = await gitRun(['read-tree', 'HEAD'], { ...gitOptions, env });
    if (readTree.code !== 0) {
      const reason = await diagnoseFailure(gitOptions, readTree);
      return { fingerprint: null, error: reason.error, detail: reason.detail };
    }

    const add = await gitRun(['add', '-A'], { ...gitOptions, env });
    if (add.code !== 0) {
      return {
        fingerprint: null,
        error: FINGERPRINT_ERRORS.ADD_FAILED,
        detail: firstLine(add.stderr),
      };
    }

    const writeTree = await gitRun(['write-tree'], { ...gitOptions, env });
    if (writeTree.code !== 0) {
      return {
        fingerprint: null,
        error: FINGERPRINT_ERRORS.WRITE_TREE_FAILED,
        detail: firstLine(writeTree.stderr),
      };
    }

    const tree = writeTree.stdout.trim();
    if (!HEX40.test(tree)) {
      return {
        fingerprint: null,
        error: FINGERPRINT_ERRORS.BAD_TREE,
        detail: `unexpected write-tree output: ${tree.slice(0, 80)}`,
      };
    }
    return { fingerprint: tree, error: null, detail: null };
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Turn a failed git call into a reason code (`NOT_A_REPO`, `NO_HEAD`, ...).
 *
 * @param {object} gitOptions
 * @param {GitRunResult} [failed]
 */
async function diagnoseFailure(gitOptions, failed) {
  if (failed?.timed_out) {
    return { error: FINGERPRINT_ERRORS.GIT_TIMEOUT, detail: 'git timed out' };
  }
  const inside = await gitRun(['rev-parse', '--git-dir'], gitOptions);
  if (inside.code !== 0) {
    return { error: FINGERPRINT_ERRORS.NOT_A_REPO, detail: firstLine(inside.stderr) };
  }
  const head = await revParse('HEAD^{commit}', gitOptions);
  if (!head) {
    return { error: FINGERPRINT_ERRORS.NO_HEAD, detail: 'repository has no commits yet' };
  }
  return {
    error: FINGERPRINT_ERRORS.READ_TREE_FAILED,
    detail: firstLine(failed?.stderr ?? ''),
  };
}

/** @param {string} text */
function firstLine(text) {
  const line = String(text ?? '').split('\n').find((entry) => entry.trim() !== '');
  return line ? line.trim() : null;
}

/**
 * Collect the pre-execution anchors.
 *
 * Never throws: a missing repository or an unborn HEAD becomes
 * `fingerprint_error` plus a `FINGERPRINT_UNAVAILABLE` warning, and the relay
 * decides that the result is `unverifiable` (we still run the command, because
 * its output is usually the interesting part).
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.tmpDir]
 * @param {string} [options.gitPath]
 * @param {'temp'|'project'} [options.objectMode]
 * @returns {Promise<{head_commit: string|null, head_tree: string|null, pre_tree_fingerprint: string|null, fingerprint_error: string|null, fingerprint_error_detail: string|null, dirty_before: boolean|null, untracked: string[]}>}
 */
export async function collectPreAnchors(options) {
  const gitOptions = { cwd: options.cwd, gitPath: options.gitPath, timeoutMs: options.timeoutMs };
  const [head, dirty, untracked] = await Promise.all([
    headCommit(gitOptions),
    isDirty(gitOptions),
    untrackedFiles(gitOptions),
  ]);
  const fp = await treeFingerprint(options);
  const headTreeValue = head ? await headTree(gitOptions) : null;

  return {
    head_commit: head,
    head_tree: headTreeValue,
    pre_tree_fingerprint: fp.fingerprint,
    fingerprint_error: fp.error,
    fingerprint_error_detail: fp.detail,
    dirty_before: dirty,
    untracked,
  };
}

/**
 * Collect the post-execution worktree state.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.base] Revision to diff against (usually base_commit).
 * @param {string} [options.tmpDir]
 * @param {string} [options.gitPath]
 * @param {'temp'|'project'} [options.objectMode]
 * @returns {Promise<{head_commit: string|null, post_tree_fingerprint: string|null, fingerprint_error: string|null, fingerprint_error_detail: string|null, untracked: string[], diff_numstat: Array<object>}>}
 */
export async function collectPostState(options) {
  const gitOptions = { cwd: options.cwd, gitPath: options.gitPath, timeoutMs: options.timeoutMs };
  const [head, untracked] = await Promise.all([
    headCommit(gitOptions),
    untrackedFiles(gitOptions),
  ]);
  const numstat = options.base ? await diffNumstat(options.base, gitOptions) : [];
  const fp = await treeFingerprint(options);

  return {
    head_commit: head,
    post_tree_fingerprint: fp.fingerprint,
    fingerprint_error: fp.error,
    fingerprint_error_detail: fp.detail,
    untracked,
    diff_numstat: numstat,
  };
}

/**
 * Guard for "the project we were told to run in actually contains this cwd".
 *
 * Containment is decided with `path.relative`, which (unlike a string prefix
 * test) is correct on Windows where drive letters and path case vary.
 *
 * @param {string} projectRoot Absolute project root.
 * @param {string} cwdRel Forward-slash relative path from the offer.
 * @returns {{ok: true, cwd: string, cwd_rel: string}|{ok: false, reason: string}}
 */
export function resolveProjectCwd(projectRoot, cwdRel) {
  const root = resolve(projectRoot);
  const normalized = normalizeRelPath(cwdRel);
  const target = resolve(root, normalized.split('/').join(sep));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    return { ok: false, reason: 'CWD_OUTSIDE_PROJECT' };
  }
  return { ok: true, cwd: target, cwd_rel: normalizeRelPath(rel) };
}

/**
 * Make sure a directory exists (used for the state tree, never for the project
 * unless the caller asked for it).
 *
 * @param {string} dir
 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute parent directory of a file path. */
export function parentDir(file) {
  return dirname(file);
}
