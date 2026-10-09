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

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

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
 * Absolute path of the bundled DSH dependency directory, or `null` when absent.
 *
 * `DSH_RUNTIME_DEPS` overrides the guess, which keeps tests hermetic.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|null}
 */
export function dshDependenciesDir(env = process.env) {
  const override = env.DSH_RUNTIME_DEPS && env.DSH_RUNTIME_DEPS.trim() !== '';
  const dir = override ? env.DSH_RUNTIME_DEPS : join(dshHome(env), DSH_RUNTIME_RELATIVE);
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
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
  if (exe.includes('/') || exe.includes('\\')) return exe;
  const env = options.env ?? process.env;
  const extraDirs = options.extraDirs ?? bundledBinDirs(env);
  return findExecutable(exe, { env, extraDirs }) ?? exe;
}
