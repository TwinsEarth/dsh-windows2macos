/**
 * Shared helpers for the W2M command-line entry points.
 *
 * Kept deliberately small and dependency-free: the interesting decisions here
 * are only "where does state live" and "how do we print an error", and both
 * have to behave identically on Windows and macOS.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Resolve the directory a W2M process keeps its durable state in.
 *
 * Precedence, highest first:
 *   1. an explicit `--state` value;
 *   2. `<DSH_HOME>/xclient/<kind>`;
 *   3. `~/.dsh/xclient/<kind>` when `DSH_HOME` is not set.
 *
 * `DSH_HOME` is honoured rather than assumed so that a machine running two
 * throwaway profiles for testing does not share one device identity with the
 * profile the user actually works in -- sharing it would silently make two
 * "machines" claim the same `machine_id`.
 *
 * @param {string|undefined} explicit Value of `--state`, if given.
 * @param {string} kind Sub-directory name, e.g. `'rabbit'` or `'localside'`.
 * @param {Record<string, string|undefined>} [env] Environment to read; tests pass a fake one.
 * @returns {string} Absolute path.
 */
export function resolveStateDir(explicit, kind, env = process.env) {
  if (explicit && explicit.trim() !== '') {
    return isAbsolute(explicit) ? explicit : resolve(explicit);
  }
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'xclient', kind);
}

/**
 * Format anything throwable as a single human-readable line.
 *
 * `String(error)` on a rejected fetch prints `TypeError: fetch failed`, which
 * hides the actual cause in `error.cause`; the CLI's whole job when it fails is
 * to say what went wrong, so the cause is unwrapped here.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function formatError(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  if (!(error instanceof Error)) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  const parts = [`${error.name}: ${error.message}`];
  let cause = error.cause;
  const seen = new Set([error]);
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    parts.push(`caused by ${cause.name}: ${cause.message}`);
    if (typeof cause.code === 'string') parts.push(`(${cause.code})`);
    cause = cause.cause;
  }
  if (typeof error.code === 'string') parts.push(`[${error.code}]`);
  return parts.join(' ');
}

/**
 * Decide whether the calling module is the process entry point.
 *
 * `import.meta.url === pathToFileURL(process.argv[1]).href` looks right and fails two ways, both observed on real
 * machines:
 *
 *   - a hand-built `file://${...}` template leaves `~` and `#` unescaped while the loader escapes them
 *     (`ADMINI%7E1`, `%23`), so the comparison is false and the command exits 0 having done nothing;
 *   - even with `pathToFileURL`, the two sides are two spellings of one file: `argv[1]` keeps the path the
 *     caller typed, while `import.meta.url` has already been resolved. On macOS `/tmp` and `/var` are symlinks,
 *     and `os.tmpdir()` lives behind `/var`, so every entry started from a temporary path took the silent
 *     branch. A pnpm install has the same shape: `node_modules/@twinsearth/...` is a link into the store.
 *
 * Comparing the resolved paths answers the question that was actually asked -- "is this the same file?" -- and
 * is indifferent to spelling. `realpathSync` needs the file to exist, so the URL comparison is kept as a fallback
 * for the case where it does not.
 *
 * @param {string} moduleUrl The caller's own `import.meta.url`.
 * @param {string|undefined} argv1 Defaults to the live `process.argv[1]`.
 * @returns {boolean} True when the caller is the entry point.
 */
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (argv1 === undefined || argv1 === '') return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return moduleUrl === pathToFileURL(argv1).href;
  }
}
