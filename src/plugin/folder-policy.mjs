/**
 * GPW v2 — folder policy for the approval gate (v1.7.5-beta.1).
 *
 * Folders are classified into exactly three classes, and the class decides who answers:
 *
 *   A. blacklist  -> denied outright (also registered as a synchronous tools.guard, so order cannot save it)
 *   B. whitelist  -> allowed without a human (the whitelist is an explicit extension of the workspace)
 *   C. everything else -> a GPW pending approval (the plugin's own queue, not DSH's approval policy)
 *
 * ## Why this is a pure module
 *
 * The dangerous part of a path rule is not the decision, it is the comparison. `C:\work` must not contain
 * `C:\workshop`; a trailing separator must not change the answer; `..` must be resolved before comparing, and on Windows
 * the comparison must be case-insensitive while on POSIX it must not be. Those rules are cheap to test and expensive to
 * discover in production, so they live here with no filesystem, no session and no plugin context.
 *
 * ## Deny wins
 *
 * If a folder is on both lists the operator contradicts themselves; the safe reading of a contradiction about access is
 * the restrictive one. A call that touches one blacklisted path is denied even when another path is whitelisted.
 */

import { posix, win32 } from 'node:path';

/**
 * Normalise one configured folder.
 *
 * @param {string} folder
 * @param {{base?: string, platform?: string}} [options]
 * @returns {string} absolute, no trailing separator, lowercased on win32
 */
export function normalizeFolder(folder, options = {}) {
  if (typeof folder !== 'string' || folder.trim() === '') throw new TypeError('a folder must be a non-empty string');
  const platform = options.platform ?? process.platform;
  const base = options.base ?? process.cwd();
  const raw = folder.trim();
  const p = platform === 'win32' ? win32 : posix;
  const absolute = p.isAbsolute(raw) ? raw : p.resolve(base, raw);
  let out = p.normalize(absolute);
  while (out.length > 1 && out.endsWith(p.sep) && !/^[A-Za-z]:[\\/]$/.test(out)) out = out.slice(0, -1);
  return platform === 'win32' ? out.toLowerCase() : out;
}

/**
 * Whether `target` is inside `folder` (or is the folder itself), compared segment-wise.
 *
 * @param {string} target already normalised
 * @param {string} folder already normalised
 * @param {{platform?: string}} [options]
 * @returns {boolean}
 */
export function isInside(target, folder, options = {}) {
  const platform = options.platform ?? process.platform;
  const t = platform === 'win32' ? target.toLowerCase() : target;
  const f = platform === 'win32' ? folder.toLowerCase() : folder;
  if (t === f) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  const withSep = f.endsWith(sep) ? f : f + sep;
  return t.startsWith(withSep);
}

/**
 * Classify one target against the two lists and the workspace.
 *
 * @param {{target: string, whitelist?: string[], blacklist?: string[], workspace?: string|null,
 *          base?: string, platform?: string}} input
 * @returns {{decision: 'deny'|'allow'|'pass', target: string, folder: string|null, reason: string}}
 */
export function classifyPath(input) {
  const platform = input.platform ?? process.platform;
  const base = input.base ?? process.cwd();
  const target = normalizeFolder(input.target, { base, platform });
  const normalise = (list) => (Array.isArray(list) ? list : []).map((f) => normalizeFolder(f, { base, platform }));

  for (const folder of normalise(input.blacklist)) {
    if (isInside(target, folder, { platform })) {
      return { decision: 'deny', target, folder, reason: `the folder "${folder}" is on the blacklist` };
    }
  }
  for (const folder of normalise(input.whitelist)) {
    if (isInside(target, folder, { platform })) {
      return { decision: 'allow', target, folder, reason: `the folder "${folder}" is on the whitelist` };
    }
  }
  if (typeof input.workspace === 'string' && input.workspace !== '') {
    const workspace = normalizeFolder(input.workspace, { base, platform });
    if (isInside(target, workspace, { platform })) {
      return { decision: 'allow', target, folder: workspace, reason: 'the target is inside the workspace' };
    }
  }
  return { decision: 'pass', target, folder: null, reason: 'no list mentions this target, so GPW asks the operator' };
}

/** Fields that carry a single filesystem path in the tool schemas this plugin sees. */
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'target', 'cwd', 'old_path', 'oldPath', 'new_path', 'newPath', 'directory', 'dir', 'folder', 'root'];

/** Tools whose argument is a command line rather than a structured path; their text is scanned for absolute paths. */
const COMMAND_TOOL = /^(bash|pwsh|powershell|shell|terminal|run_command|exec)$/i;

/**
 * Every path a tool call touches.
 *
 * Structured fields are exact; a command tool has no structured path, so absolute-looking tokens are extracted and then
 * classified. That heuristic is stated rather than hidden: it can miss a path built at runtime, and it is the only
 * information available before execution.
 *
 * @param {{name?: string, arguments?: string|object}} call
 * @returns {string[]} raw (not yet normalised) path candidates
 */
export function pathsOfToolCall(call, options = {}) {
  let args = call?.arguments;
  if (typeof args === 'string') {
    if (args.trim() === '') return [];
    try {
      args = JSON.parse(args);
    } catch {
      // Not JSON: for a command tool the raw string is the command line; otherwise it names nothing usable.
      args = null;
    }
  }
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') out.push(value);
  };
  if (args !== null && typeof args === 'object') {
    for (const field of PATH_FIELDS) push(args[field]);
    if (Array.isArray(args.targets)) for (const value of args.targets) push(value);
    if (Array.isArray(args.paths)) for (const value of args.paths) push(value);
  }
  if (out.length === 0 && COMMAND_TOOL.test(String(call?.name ?? ''))) {
    const text = typeof call?.arguments === 'string' && call.arguments.trim().startsWith('{') === false
      ? call.arguments
      : typeof args?.command === 'string'
        ? args.command
        : typeof args?.cmd === 'string'
          ? args.cmd
          : typeof call?.arguments === 'string'
            ? call.arguments
            : JSON.stringify(args ?? '');
    const matches = text.match(/(?<![^\s"'=(])(?:[A-Za-z]:[\\/][^"'\s|;&<>]*|\\\\[^"'\s|;&<>]+|\/(?:[^"'\s|;&<>]+\/?)+)/g) ?? [];
    for (const m of matches) push(m);
    // v1.7.9: relative tokens (sub/file.txt, ./x, ..\y) are resolved against the workspace base below, so a command
    // that names a subfolder is classified instead of passing through as "names no path". Only tokens that actually
    // contain a separator are taken; URLs, flags and bare words are left alone.
    if (options.allowRelative === true) {
      for (const token of text.split(/\s+/)) {
        const cleaned = token.replace(/^["'(=]+|["'),;]+$/g, '');
        if (cleaned === '' || cleaned.startsWith('-') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleaned)) continue;
        if (!/[\\/]/.test(cleaned)) continue;
        if (/[\\/]$/.test(cleaned) && cleaned.length === 1) continue;
        push(cleaned);
      }
    }
  }
  return out;
}

/**
 * Classify a whole tool call. Deny wins over allow: one blacklisted path refuses the call even when another path is
 * whitelisted because a call that writes one protected file and one ordinary file must not be approved on the strength of
 * the ordinary one.
 *
 * @param {{name?: string, arguments?: string|object, whitelist?: string[], blacklist?: string[],
 *          workspace?: string|null, base?: string, platform?: string, allowRelative?: boolean}} call
 * @returns {{decision: 'deny'|'allow'|'pass', path: string|null, folder: string|null, reason: string, paths: string[]}}
 */
export function classifyToolCall(call) {
  const candidates = pathsOfToolCall(call, { allowRelative: call.allowRelative === true });
  let weakest = { decision: 'pass', path: null, folder: null, reason: 'this call names no path', paths: [] };
  for (const candidate of candidates) {
    const result = classifyPath({
      target: candidate,
      whitelist: call.whitelist,
      blacklist: call.blacklist,
      workspace: call.workspace,
      base: call.base,
      platform: call.platform,
    });
    if (result.decision === 'deny') {
      return { decision: 'deny', path: candidate, folder: result.folder, reason: result.reason, paths: candidates };
    }
    if (result.decision === 'allow') {
      weakest = { decision: 'allow', path: candidate, folder: result.folder, reason: result.reason, paths: candidates };
    } else if (weakest.path === null) {
      weakest = { decision: 'pass', path: candidate, folder: null, reason: result.reason, paths: candidates };
    }
  }
  return weakest;
}
