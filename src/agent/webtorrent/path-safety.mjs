/**
 * Path scope checks for the P2P V2 file plane.
 *
 * The V2 service is below the plugin layer, so it cannot import the plugin's GPW policy module
 * without pointing an edge upward. This module implements the same sensitive-floor semantics and
 * the same realpath-prefix idea for the two operations that actually touch user paths: seeding a
 * source and choosing a download destination. The plugin still runs `guardPath` first; the service
 * runs this second gate so a direct caller cannot bypass it.
 */

import { accessSync, constants, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

const SENSITIVE_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', 'credentials']);
const SENSITIVE_EXT = /\.(pem|key|pfx|p12|jks|kdbx)$/i;
const SENSITIVE_NAMES = new Set([
  '.env',
  'id_rsa',
  'id_ed25519',
  'wallet.dat',
  'login data',
  'gpw-folders.json',
  'gpw-folders.json.key',
]);

/** Same sensitive floor as `src/plugin/path-policy.mjs#sensitiveMatch`. */
export function sensitiveMatch(raw) {
  const lowered = String(raw).toLowerCase();
  for (const segment of lowered.split(/[\\/]+/)) {
    if (SENSITIVE_SEGMENTS.has(segment)) return { hit: true, reason: 'SENSITIVE_SEGMENT', segment };
    if (SENSITIVE_NAMES.has(segment)) return { hit: true, reason: 'SENSITIVE_NAME', segment };
    if (SENSITIVE_EXT.test(segment)) return { hit: true, reason: 'SENSITIVE_EXTENSION', segment };
  }
  return { hit: false };
}

function isWindows(platform) {
  return platform === 'win32';
}

/** A lexical key that makes Windows comparisons case-insensitive and separator-insensitive. */
export function canonicalKey(raw, { platform = process.platform } = {}) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text === '' || text.includes('\u0000')) return null;
  const win = isWindows(platform);
  if (win) {
    text = text.replace(/^\\\\[?.]\\UNC\\(.*)$/i, '\\\\$1').replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, '');
    text = text.replace(/\//g, '\\');
  }
  const segments = [];
  const drive = win ? /^([A-Za-z]):(.*)$/.exec(text) : null;
  let rest = text;
  if (drive !== null) {
    if (drive[2].startsWith('\\') === false) return null;
    rest = drive[2];
  }
  for (const part of rest.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    let segment = part;
    if (win) segment = segment.replace(/[. ]+$/g, '');
    if (segment !== '') segments.push(win ? segment.replace(/[A-Z]/g, (c) => c.toLowerCase()) : segment);
  }
  if (win) return (drive === null ? '' : drive[1].toLowerCase() + ':\\') + segments.join('\\');
  return '/' + segments.join('/');
}

function segmentsOf(key, platform) {
  if (typeof key !== 'string' || key === '') return null;
  if (isWindows(platform)) {
    const match = /^([A-Za-z]):\\(.*)$/.exec(key);
    return match === null ? null : [match[1] + ':', ...match[2].split('\\').filter(Boolean)];
  }
  return key.split('/').filter(Boolean);
}

/** Segment containment; `C:\work` does not contain `C:\workshop`. */
export function inside(targetKey, rootKey, platform = process.platform) {
  const target = segmentsOf(targetKey, platform);
  const root = segmentsOf(rootKey, platform);
  if (target === null || root === null || target.length < root.length) return false;
  for (let index = 0; index < root.length; index += 1) {
    if (target[index] !== root[index]) return false;
  }
  return true;
}

/**
 * Resolve symlinks in the longest existing prefix and append the non-existent tail lexically.
 * This is the same contract as the plugin's realpathPrefix: a destination may not exist yet, but a
 * symlinked parent is still resolved before the root check.
 */
export function realpathPrefix(raw, { platform = process.platform } = {}) {
  const key = canonicalKey(raw, { platform });
  if (key === null) return null;
  let probe = key;
  for (;;) {
    try {
      const real = realpathSync.native(probe);
      const normalized = canonicalKey(real, { platform });
      if (normalized === null) return { real: null, key, rest: key };
      const rest = key.slice(probe.length);
      return { real, key: normalized + rest, rest };
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return { real: null, key, rest: key };
      probe = parent;
    }
  }
}

function rootKey(root) {
  const resolved = resolvePath(root);
  const prefix = realpathPrefix(resolved);
  return prefix?.key ?? canonicalKey(resolved);
}

function isWithinAny(key, roots) {
  return roots.some((root) => inside(key, root));
}

/**
 * Check a path against the configured roots and the sensitive floor.
 *
 * @param {string} raw
 * @param {{roots?: string[], mustExist?: boolean, mustBeReadable?: boolean}} [options]
 * @returns {{ok: true, path: string, real: string|null, key: string}|
 *   {ok: false, code: string, detail: string}}
 */
export function checkPathScope(raw, options = {}) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\u0000')) {
    return { ok: false, code: 'PATH_INVALID', detail: 'path is required and must not contain NUL' };
  }
  const resolved = resolvePath(raw);
  const prefix = realpathPrefix(resolved);
  if (prefix === null) return { ok: false, code: 'PATH_INVALID', detail: 'path cannot be canonicalized' };
  const sensitive = sensitiveMatch(raw);
  if (sensitive.hit) {
    return {
      ok: false,
      code: 'SENSITIVE_PATH',
      detail: `refusing to use a ${sensitive.reason} path (${sensitive.segment})`,
    };
  }
  if (prefix.real !== null) {
    const realSensitive = sensitiveMatch(prefix.real);
    if (realSensitive.hit) {
      return {
        ok: false,
        code: 'SENSITIVE_PATH',
        detail: `refusing a symlink that resolves to a ${realSensitive.reason} path (${realSensitive.segment})`,
      };
    }
  }
  const roots = (Array.isArray(options.roots) ? options.roots : [])
    .map((root) => rootKey(root))
    .filter((root) => typeof root === 'string' && root !== '');
  if (roots.length === 0 || !isWithinAny(prefix.key, roots)) {
    return { ok: false, code: 'PATH_OUTSIDE_ROOT', detail: 'path is outside the configured allowed roots' };
  }
  if (options.mustExist === true) {
    try {
      accessSync(resolved, options.mustBeReadable === true ? constants.R_OK : constants.F_OK);
    } catch (error) {
      return {
        ok: false,
        code: options.mustBeReadable === true ? 'PATH_NOT_READABLE' : 'PATH_NOT_FOUND',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: true, path: resolved, real: prefix.real, key: prefix.key };
}

/** A display-safe directory key: no symlink target is leaked beyond the resolved path itself. */
export function samePath(left, right, platform = process.platform) {
  const a = canonicalKey(left, { platform });
  const b = canonicalKey(right, { platform });
  return a !== null && a === b;
}

/** The path's parent on the current platform; used to place the staging directory beside the destination. */
export function parentOf(raw) {
  return dirname(resolvePath(raw));
}

/** True when the path is absolute for the current platform. */
export function absolutePath(raw) {
  return typeof raw === 'string' && isAbsolute(resolvePath(raw));
}
