/**
 * Shared helpers for the W2M command-line entry points.
 *
 * Kept deliberately small and dependency-free: the interesting decisions here
 * are only "where does state live" and "how do we print an error", and both
 * have to behave identically on Windows and macOS.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
 * @returns {string} Absolute path.
 */
export function resolveStateDir(explicit, kind) {
  if (explicit && explicit.trim() !== '') {
    return isAbsolute(explicit) ? explicit : resolve(explicit);
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
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
