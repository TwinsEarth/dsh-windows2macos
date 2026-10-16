/**
 * Executable resolution shared by capability probing and task execution.
 *
 * This file exists because those two used to disagree, and the disagreement was
 * invisible until a task ran.
 *
 * The capability probe deliberately looks for a tool **on PATH first, in DSH's
 * bundled runtime second** — that is how a machine with no system `node` still
 * reports `caps.node = "v24.21.0"` and means it. The executor, by contrast,
 * spawned `argv[0]` verbatim with `shell: false`, so it could only ever find what
 * PATH held. On a machine where the tool exists *only* in the bundle, the probe
 * advertised a capability and every task that used it died at spawn with a bare
 * `crashed`. One search order has to serve both, so it lives here.
 *
 * Nothing in this module guesses: a name that cannot be found is returned
 * unchanged, so the caller still gets the real ENOENT instead of a fake path.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

/** The DSH runtime directory layout we fall back to (task-8, measured). */
export const DSH_RUNTIME_RELATIVE = join('dsh-runtimes', 'dsh-primary-runtime', 'dependencies');

/**
 * `%DSH_HOME%` (or `~/.dsh`) — the root the bundled runtimes live under.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function dshHome(env = process.env) {
  const explicit = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : null;
  return explicit ?? join(homedir(), '.dsh');
}

/**
 * The dependency directory implied by the interpreter that is running this code, or `null`.
 *
 * ## Why this exists, and why it is the first fallback
 *
 * `DSH_HOME/dsh-runtimes/<runtime>/dependencies` was the only layout this module knew. **The application moved
 * and that assumption stopped holding**: the runtime now ships inside the bundle at
 * `E:\DS\resources\runtime\primary-runtime\dependencies`, so `$DSH_HOME` contains no `dsh-runtimes/` at all, and
 * every lookup that fell back to it found nothing.
 *
 * **The measurement that located it:** twelve end-to-end tests refused with `COMMAND_EXECUTABLE_PATH_MISMATCH`.
 * They dispatch `[process.execPath, '-e', ...]` against an allow-list entry of the bare name `node`, so the
 * identity check resolves `node` and compares the two files. `process.execPath` is the **bundled** interpreter --
 * `...\dependencies\node\bin\node.exe` -- while the bare name resolved to whatever PATH held. Two different
 * files, so the refusal was correct and the lookup was wrong.
 *
 * **So the fix is discovery rather than another hardcoded path**: a bundled interpreter lives at
 * `<deps>/node/bin/node`, which means its own path *states* where `<deps>` is. That holds wherever the
 * application is installed, and it cannot go stale when the installation moves again.
 *
 * @returns {string|null}
 */
function depsDirFromExecutable() {
  const exe = process.execPath;
  if (typeof exe !== 'string' || exe === '') return null;
  const binDir = dirname(exe);
  // `<deps>/node/bin/node[.exe]` is the shipped shape on every platform.
  if (basename(binDir) !== 'bin' || basename(dirname(binDir)) !== 'node') return null;
  const deps = dirname(dirname(binDir));
  try {
    return statSync(deps).isDirectory() ? deps : null;
  } catch {
    return null;
  }
}

/**
 * Absolute path of the bundled DSH dependency directory, or `null` when absent.
 *
 * Candidates are tried in order and the **first that exists** wins:
 *
 *   1. `DSH_RUNTIME_DEPS`, the explicit override that keeps tests hermetic;
 *   2. `$DSH_HOME/dsh-runtimes/<runtime>/dependencies`, the shipped layout this module documented;
 *   3. the directory implied by `process.execPath`, which is how the bundled layout is found now that the
 *      application carries its runtime inside the bundle instead of under the home directory.
 *
 * Returning the first *existing* candidate rather than a single computed path is the part that matters: a
 * stale first guess must not shadow a real second one.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|null}
 */
export function dshDependenciesDir(env = process.env) {
  const override = env.DSH_RUNTIME_DEPS && env.DSH_RUNTIME_DEPS.trim() !== '';
  const candidates = [
    override ? env.DSH_RUNTIME_DEPS : join(dshHome(env), DSH_RUNTIME_RELATIVE),
    depsDirFromExecutable(),
  ].filter((dir) => typeof dir === 'string' && dir !== '');
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Try the next candidate; an absent guess is not an error.
    }
  }
  return null;
}

/**
 * Windows only: the extensions `CreateProcess` will accept for a bare name.
 * (`.cmd`/`.bat` are listed so we can *report* them, but they cannot be
 * started with `shell: false`, so they are never returned as executable.)
 */
const WIN_EXTENSIONS = ['.exe', '.com'];

/**
 * Find a real executable on PATH (then, optionally, in extra directories).
 *
 * @param {string} name Bare command name, e.g. `node`, `python3`.
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string[]} [options.extraDirs] Absolute directories to try after PATH.
 * @param {string[]} [options.extensions] Override the candidate extensions.
 * @returns {string|null} Absolute path.
 */
export function findExecutable(name, options = {}) {
  const env = options.env ?? process.env;
  const isWin = process.platform === 'win32';
  const extensions = options.extensions ?? (isWin ? ['', ...WIN_EXTENSIONS] : ['']);
  const dirs = [
    ...String(env.PATH ?? '')
      .split(delimiter)
      .filter((d) => d.trim() !== ''),
    ...(options.extraDirs ?? []),
  ];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, isWin ? constants.F_OK : constants.F_OK | constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * The `bin` directories inside DSH's bundled runtime tree.
 *
 * This is the second half of the probe's search order, expressed once. A tool
 * found here is a tool the probe would have reported a real version for, which
 * is exactly why the executor must be able to start it.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string[]} Existing directories, in priority order.
 */
export function bundledBinDirs(env = process.env) {
  const depsDir = dshDependenciesDir(env);
  if (!depsDir) return [];
  const isWin = process.platform === 'win32';
  const candidates = [
    join(depsDir, 'node', 'bin'),
    join(depsDir, 'node'),
    join(depsDir, 'python', isWin ? '' : 'bin'),
    join(depsDir, 'pnpm', 'bin'),
  ];
  return candidates.filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * The file a bare tool name would name *inside DSH's bundled runtime*, or `null`.
 *
 * ## Why the identity check needs this and the search order must not
 *
 * `resolveCommand` keeps PATH ahead of the bundled tree, and a test guards that precedence
 * (`keeps PATH ahead of the bundled runtime`). **The two are not in conflict**: PATH decides which file a
 * *name* means, while this answers a different question -- *is this path the bundled copy of that tool?*
 *
 * **The measurement that required it:** twelve end-to-end tests refused with
 * `COMMAND_EXECUTABLE_PATH_MISMATCH`. They dispatch `[process.execPath, '-e', ...]` against an allow-list entry
 * of the bare name `node`. `process.execPath` is the bundled interpreter
 * (`<deps>\node\bin\node.exe`), but that directory is **not on this machine's PATH**, so the bare name resolved
 * to an unrelated `node.exe` shipped by another application and the two files differed.
 *
 * **The refusal was correct and the identity was wrong.** An absolute path that *is* the bundled copy of the
 * tool the entry names is the tool the entry names -- which is exactly the rule the header states, and the
 * reason `E:\Temp\evil\node.exe` must still be refused: that is a different directory, and this only ever
 * returns files under `<deps>`.
 *
 * @param {string} name Bare command name, e.g. `node`.
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|null} Absolute path when the bundled copy exists.
 */
export function bundledExecutable(name, env = process.env) {
  if (typeof name !== 'string' || name === '' || hasPathSeparator(name)) return null;
  const depsDir = dshDependenciesDir(env);
  if (depsDir === null) return null;
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['', ...WIN_EXTENSIONS] : [''];
  const bases = [
    join(depsDir, name, 'bin'),
    join(depsDir, name),
  ];
  for (const base of bases) {
    for (const ext of exts) {
      const candidate = join(base, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Resolve `argv[0]` the way the capability probe resolves a tool.
 *
 * * A name containing a path separator is the caller's own path: returned
 *   unchanged, because rewriting an explicit path would be second-guessing.
 * * Otherwise: PATH first, then DSH's bundled runtime.
 * * Not found anywhere: returned unchanged, so `spawn` still reports ENOENT and
 *   the result keeps saying `crashed` for the honest reason.
 *
 * @param {string} exe Bare command name or a path.
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string[]} [options.extraDirs] Extra directories tried after PATH.
 * @returns {string} Absolute path when one was found, else `exe`.
 */
export function resolveCommand(exe, options = {}) {
  if (typeof exe !== 'string' || exe === '') return exe;
  // Anything with a separator is a path the caller chose, not a name to look up.
  if (hasPathSeparator(exe)) return exe;
  const env = options.env ?? process.env;
  const extraDirs = options.extraDirs ?? bundledBinDirs(env);
  return findExecutable(exe, { env, extraDirs }) ?? exe;
}

/**
 * Does `value` name a path, rather than a bare command name to look up?
 *
 * Separators are platform-specific, and deliberately so. On Windows both `/` and `\` separate, so
 * `C:\x\node.exe` is a path; on POSIX only `/` does, and the same string is an ordinary *name* that
 * `spawn` would fail to find -- treating it as a path there would let a matcher compare two strings
 * that name no file at all and report an identity it never established.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasPathSeparator(value) {
  if (typeof value !== 'string') return false;
  return process.platform === 'win32'
    ? value.includes('/') || value.includes('\\')
    : value.includes('/');
}

/**
 * Is `value` a *relative* path (`./node.exe`, `bin\node.exe`)?
 *
 * A relative executable is one whose meaning is chosen by whoever picks the working directory, which
 * is exactly the party an allow-list does not control -- so the matcher refuses these outright rather
 * than comparing them against anything. `C:node.exe` on Windows (drive-relative) is relative by this
 * definition too, which is why the test is `!isAbsolute` and not "does not start with a separator".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRelativePath(value) {
  return hasPathSeparator(value) && !isAbsolute(value);
}

/** `realpath` that answers `null` instead of throwing for a path that names no file. */
function realPathOf(value) {
  const realpath = realpathSync.native ?? realpathSync;
  try {
    return realpath(value);
  } catch {
    return null;
  }
}

/**
 * Do two paths name the **same file** on this machine?
 *
 * `realpath` rather than a string comparison, because the point is the file that would be executed:
 * it resolves symlinks and junctions, Windows 8.3 short names, and the on-disk letter case. Two
 * different copies of one program are two different files and answer `false`, which is what makes
 * this usable as an identity check rather than a spelling check.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameFile(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const realA = realPathOf(a);
  const realB = realPathOf(b);
  if (realA === null || realB === null) return false;
  return process.platform === 'win32'
    ? realA.toLowerCase() === realB.toLowerCase()
    : realA === realB;
}
