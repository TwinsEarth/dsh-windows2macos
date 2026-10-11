/**
 * The command allow-list matcher: parse the configured entries, then match one argv against them.
 *
 * This is the rule that decides whether an offer may run. It lives in its own module because it has
 * **two** callers that must agree: the agent, which enforces the list on the machine that actually
 * executes the command, and the plugin, whose dispatch-time pre-flight exists so a dispatcher does
 * not send work the target would refuse. A second, independently written pre-flight is how the two
 * ends drift apart, and a pre-flight that is *stricter* than the gate is the worse direction: the
 * agent would have run the command, and the dispatch never happened.
 *
 * The comparison is deliberately token-wise and not executable-only. An entry is a **prefix
 * sequence**: `"node --test"` means `['node','--test']`, which allows `['node','--test','--reporter=tap']`
 * and refuses `['node','-e','...']` and a bare `['node']`. Comparing only `argv[0]`, as the plugin's
 * pre-flight used to, can never match a multi-token entry at all -- the documented config
 * `['node --test','git status --porcelain']` would refuse `["node","--test"]`.
 */

import { basename, extname } from 'node:path';

/**
 * Parse `--allowed-commands`.
 *
 * Accepts the JSON array form the CLI documents (`'["node --test","git status"]'`),
 * an already-parsed array of strings, or an array of arrays for entries whose
 * executable path contains spaces.  Each string entry is split on whitespace
 * into a **prefix sequence**.
 *
 * Commas are deliberately *not* a separator: `["node --test, git status"]`
 * would silently authorise something nobody meant.
 *
 * @param {string|Array<string|string[]>} input
 * @returns {string[][]} Prefixes.
 */
export function parseAllowedCommands(input) {
  let parsed = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (text === '') return [];
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const err = new TypeError(
        `--allowed-commands must be a JSON array, e.g. '["node --test","git status"]' (${error.message})`,
      );
      err.code = 'ALLOWED_COMMANDS_INVALID';
      throw err;
    }
  }
  if (!Array.isArray(parsed)) {
    const err = new TypeError('allowed commands must be a JSON array');
    err.code = 'ALLOWED_COMMANDS_INVALID';
    throw err;
  }
  const prefixes = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      const parts = entry.split(/\s+/).filter((part) => part !== '');
      if (parts.length === 0) {
        const err = new TypeError('allowed command entries must not be empty');
        err.code = 'ALLOWED_COMMANDS_INVALID';
        throw err;
      }
      prefixes.push(parts);
      continue;
    }
    if (Array.isArray(entry) && entry.length > 0 && entry.every((part) => typeof part === 'string')) {
      prefixes.push([...entry]);
      continue;
    }
    const err = new TypeError('allowed command entries must be strings or arrays of strings');
    err.code = 'ALLOWED_COMMANDS_INVALID';
    throw err;
  }
  return prefixes;
}

/** Executable name without directory or extension (`C:\x\node.exe` -> `node`). */
function execName(value) {
  const base = basename(value);
  const ext = extname(base);
  return ext === '' ? base : base.slice(0, -ext.length);
}

/** Windows paths are case-insensitive; POSIX ones are not. */
function sameName(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The stable codes this matcher refuses with.
 *
 * `COMMAND_NOT_ALLOWED` is deliberately the **same literal** the agent writes into a result
 * envelope's `refusal_reason` (`REFUSAL.COMMAND_NOT_ALLOWED` in `src/agent/agent.mjs`) and the same
 * one the plugin's dispatch pre-flight reports: the whole reason this matcher is shared is that the
 * two ends must not be able to disagree about *why* a command was refused, and two spellings of one
 * refusal would be a disagreement of exactly that kind.
 *
 * `COMMAND_ARGV_EMPTY` is the matcher's own precondition. It is a separate code because it is a
 * separate fault — a caller that passed nothing has a bug, not a policy problem — and collapsing it
 * into `COMMAND_NOT_ALLOWED` would send the reader to the allow-list to fix a caller.
 */
export const MATCH_REFUSAL = Object.freeze({
  ARGV_EMPTY: 'COMMAND_ARGV_EMPTY',
  NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',
});

/**
 * Why this argv is not covered by this list, and what would change it.
 *
 * The entries are echoed because they are the *only* thing that would make the same call succeed,
 * and a caller reading this deserves them without a second call. They are configuration, never
 * credentials: the parse path refuses a secret-looking key before a list ever reaches here.
 *
 * @param {string[]} argv
 * @param {string[][]} prefixes
 * @returns {string}
 */
function allowListMissDetail(argv, prefixes) {
  if (prefixes.length === 0) {
    return (
      'the configured allow-list is empty, so every command is refused; add an entry naming what ' +
      `this machine may run - an entry of \`${argv[0]}\` would allow \`${argv.join(' ')}\``
    );
  }
  const entries = prefixes.map((prefix) => prefix.join(' ')).join(', ');
  return (
    `no configured entry is a prefix of this argv; the allow-list entries are ${entries}. Add one ` +
    `that covers \`${argv.join(' ')}\`, or run a command the list already covers`
  );
}

/**
 * Default-deny prefix match.
 *
 * `['node','--test']` is allowed by the prefix `node --test`, and so is
 * `['node','--test','--reporter=tap']`; `['node','-e','...']` and a bare
 * `['node']` are refused.
 *
 * A refusal is a **named** one: `reason_code` is a stable, greppable code and `detail` says what
 * would change it. `allowed` and `prefix` keep the shape this function has always returned, because
 * both callers read exactly those two fields and the codes are additive.
 *
 * @param {string[]} argv
 * @param {string[][]} prefixes
 * @returns {{allowed: boolean, prefix: string[]|null, reason_code: string|null, detail: string|null}}
 */
export function matchAllowedCommand(argv, prefixes) {
  const entries = Array.isArray(prefixes) ? prefixes : [];
  if (!Array.isArray(argv) || argv.length === 0) {
    return {
      allowed: false,
      prefix: null,
      reason_code: MATCH_REFUSAL.ARGV_EMPTY,
      detail:
        'there is no argv to compare, and this matcher is default-deny; pass a non-empty array of ' +
        'strings whose first element is the executable',
    };
  }
  for (const prefix of entries) {
    if (!Array.isArray(prefix) || prefix.length === 0) continue;
    if (argv.length < prefix.length) continue;
    if (!sameName(argv[0], prefix[0]) && !sameName(execName(argv[0]), prefix[0])) continue;
    let ok = true;
    for (let i = 1; i < prefix.length; i += 1) {
      if (argv[i] !== prefix[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { allowed: true, prefix, reason_code: null, detail: null };
  }
  return {
    allowed: false,
    prefix: null,
    reason_code: MATCH_REFUSAL.NOT_ALLOWED,
    detail: allowListMissDetail(argv, entries.filter((prefix) => Array.isArray(prefix) && prefix.length > 0)),
  };
}
