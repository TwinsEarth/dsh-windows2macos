/**
 * Structured intents: the deterministic half of "natural language becomes an action".
 *
 * ## What this is not
 *
 * It does not understand free text. A machine in this fleet runs an allow-list of commands; asking an LLM on the remote
 * side to invent a command would defeat the allow-list and put an unbounded decision on a machine nobody is sitting at.
 * So the caller (the DSH agent, which IS the model) turns language into one of these intents, and this module decides
 * whether that intent maps to an allowed command. Anything unrecognised is REFUSED by name, never guessed.
 *
 * ## Why a catalog instead of string templates from the caller
 *
 * A caller that supplies its own argv is `w2m_run` with extra steps. The value here is the closed set: each action has a
 * fixed argv shape, typed parameters, and a risk level, so an intent cannot smuggle an argument that the allow-list was
 * meant to stop (a path, a flag that loads code, a shell metacharacter).
 */

/** The closed set. `argv(params)` receives validated parameters only. */
export const INTENTS = {
  'run-tests': {
    risk: 'read',
    description: 'Run the project test suite: node --test',
    params: {},
    argv: () => ['node', '--test'],
  },
  'node-version': {
    risk: 'read',
    description: 'Report the Node version on the machine: node --version',
    params: {},
    argv: () => ['node', '--version'],
  },
  'git-status': {
    risk: 'read',
    description: 'Show the working tree status: git status --porcelain',
    params: {},
    argv: () => ['git', 'status', '--porcelain'],
  },
  'git-head': {
    risk: 'read',
    description: 'Report the commit HEAD points at: git rev-parse HEAD',
    params: {},
    argv: () => ['git', 'rev-parse', 'HEAD'],
  },
  'fleet-facts': {
    risk: 'read',
    description: 'Run the demo fact collector: node src/facts.mjs',
    params: {},
    argv: () => ['node', 'src/facts.mjs'],
  },
  'shard-probe': {
    risk: 'read',
    description: 'Run the demo shard probe with one non-negative integer: node src/shard.mjs <n>',
    params: { n: 'non-negative integer' },
    argv: (params) => ['node', 'src/shard.mjs', String(params.n)],
  },
};

/** The catalog as data, for a tool/README to list without duplicating it. */
export function listIntents() {
  return Object.entries(INTENTS).map(([action, spec]) => ({
    action,
    risk: spec.risk,
    description: spec.description,
    params: spec.params,
  }));
}

/** A single argument must be a plain token: no spaces, no shell metacharacters, no path separators. */
function tokenIsSafe(value) {
  return typeof value === 'string' && value !== '' && value.length <= 128 && !/[\s;&|$`<>\\/"']/.test(value);
}

/** Render an argv the way the allow-list matcher compares it (space separated), for the refusal message. */
function renderArgv(argv) {
  return argv.join(' ');
}

/**
 * Map one structured intent onto an allow-listed argv.
 *
 * @param {{action?: string, params?: object}} intent
 * @param {{allowedCommands?: string[]}} [options] the machine's allow-list, as the agent sees it
 * @returns {{ok: true, action: string, argv: string[], risk: string, command: string} |
 *           {ok: false, code: string, detail?: object, hint: string}}
 */
export function resolveIntent(intent, options = {}) {
  const action = typeof intent?.action === 'string' ? intent.action.trim() : '';
  if (action === '') {
    return { ok: false, code: 'INTENT_MISSING', hint: 'pass {"action": "<one of w2m_intent list>", "params": {...}}' };
  }
  const spec = INTENTS[action];
  if (spec === undefined) {
    return {
      ok: false,
      code: 'INTENT_UNKNOWN',
      detail: { action, known: Object.keys(INTENTS) },
      hint: 'this fleet does not invent commands: pick one of the catalog actions',
    };
  }

  const params = intent?.params ?? {};
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: 'INTENT_PARAM_INVALID', detail: { action }, hint: 'params must be an object' };
  }
  const expected = Object.keys(spec.params);
  for (const key of Object.keys(params)) {
    if (!expected.includes(key)) {
      return { ok: false, code: 'INTENT_PARAM_UNKNOWN', detail: { action, key, expected }, hint: 'unknown parameter for this action' };
    }
  }
  if (action === 'shard-probe') {
    const n = params.n;
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, code: 'INTENT_PARAM_INVALID', detail: { action, param: 'n', expected: 'non-negative integer' }, hint: 'n must be a non-negative integer' };
    }
  }
  // Only CALLER-SUPPLIED values are shape-checked: the fixed argv comes from this catalog, where a path separator is
  // normal. A metacharacter in a caller value is how a command becomes something else.
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (typeof value === 'string' && !tokenIsSafe(value)) {
      return { ok: false, code: 'INTENT_ARG_UNSAFE', detail: { action, parameter: key }, hint: 'a parameter may not contain spaces, quotes or shell metacharacters' };
    }
  }
  const argv = spec.argv(params);
  const command = renderArgv(argv);
  const allowed = Array.isArray(options.allowedCommands) ? options.allowedCommands : null;
  if (allowed !== null && !allowed.includes(command)) {
    return {
      ok: false,
      code: 'INTENT_NOT_ALLOWED',
      detail: { action, command, allowedCommands: allowed },
      hint: 'the machine allow-list does not contain this command; ask the operator to add it',
    };
  }
  return { ok: true, action, argv, risk: spec.risk, command };
}
