/**
 * Shared fleet configuration (v0.3.3).
 *
 * One file, committed with the project, that every machine reads. The problem it solves is concrete:
 * without it, every machine needs its own copy of the same settings -- the allow-list, the timeout, the
 * update schedule -- and those copies drift. The machine that drifts is the one nobody looks at until
 * it refuses a command or installs something unexpected.
 *
 * ## Why the file lives in the project, not on the relay
 *
 * A relay-hosted config would be one place to edit, but the relay would then hold the fleet's
 * credentials, or the config would have to be split into secret and non-secret halves. The operator
 * ruled that out: **the relay must not hold credentials**. A file in the project needs nothing from
 * the relay, works when the relay is unreachable, and is reviewed in the same pull request as the code
 * it governs. The project is already shared -- that is the premise of the whole tool -- so the file
 * travels with it.
 *
 * ## The layering rule, and why it is explicit
 *
 * lowest  `.w2m.json` in the project      (shared, committed)
 *         `~/.w2m/machine.json`           (this machine only, optional, not committed)
 * highest the plugin's own config object  (what the host passed in)
 *
 * Higher layers win key by key, and `describe()` reports which layer each effective value came from.
 * That last part is the point: a setting that is present but being overridden is the failure mode of
 * every config system, and the answer has to be readable without experimenting.
 *
 * ## What may not go in the file
 *
 * No tokens and no credentials, ever. A key that looks like a secret is **refused**, not ignored --
 * silently dropping a token would mean the operator believes it is in effect, and a token in a
 * committed file is a leak that survives every later decision.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The committed file's name, at the project root. */
export const SHARED_CONFIG_NAME = '.w2m.json';

/** The per-machine override, outside any repository. */
export const MACHINE_CONFIG_NAME = 'machine.json';

/**
 * Defaults for every shared key.
 *
 * Kept as data so `describe()` can report a default as a default rather than as "unset", and so adding
 * a key is one line rather than a change in three places.
 */
export const SHARED_CONFIG_DEFAULTS = Object.freeze({
  allowedCommands: Object.freeze([]),
  defaultTimeoutMs: 300_000,
  maxOutputBytes: 2 * 1024 * 1024,
  updateTimes: Object.freeze(['00:00:00', '03:00:00', '05:00:00']),
  updateTimeZone: 'Asia/Shanghai',
  rttStaleMs: 180_000,
  writeScope: Object.freeze([]),
});

/**
 * Keys that are refused outright, with the reason.
 *
 * A substring test on the key name catches `operator_token`, `operatorToken`, `signing_secret`,
 * `signingSecret`, `apiKey` and friends without pretending to be an exhaustive list -- the point is
 * that the obvious spellings cannot slip through, and an unusual one is still refused by the
 * unknown-key check below.
 */
const FORBIDDEN_KEY_PATTERNS = [
  { re: /token/i, why: 'tokens must live in the host config or the environment, never in a committed file' },
  { re: /secret/i, why: 'secrets must live in the host config or the environment, never in a committed file' },
  { re: /password|passwd|credential|apikey|api_key/i, why: 'credentials must never be committed' },
];

/** Every key a shared file may contain, and how to validate its value. */
const KEY_VALIDATORS = {
  allowedCommands: (v) => {
    if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) return 'must be an array of strings (an argv prefix per entry)';
    return null;
  },
  defaultTimeoutMs: (v) => (Number.isInteger(v) && v > 0 && v <= 24 * 60 * 60 * 1000 ? null : 'must be an integer between 1 and 86400000'),
  maxOutputBytes: (v) => (Number.isInteger(v) && v > 0 ? null : 'must be a positive integer'),
  updateTimes: (v) => {
    if (!Array.isArray(v)) return 'must be an array of "HH:MM" or "HH:MM:SS" strings';
    // Both forms are accepted and normalized to HH:MM:SS, because the seconds field is almost always
    // ":00" and requiring it invites a typo that is refused for no reason. The check is on the
    // clock's real range, not just the digit count: "99:99" is the right shape and not a time.
    const bad = v.find((t) => {
      if (typeof t !== 'string') return true;
      const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
      if (!m) return true;
      const [h, min, sec] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
      return h > 23 || min > 59 || sec > 59;
    });
    return bad === undefined ? null : `contains ${JSON.stringify(bad)}, which is not a time of day`;
  },
  updateTimeZone: (v) => {
    if (typeof v !== 'string' || v.trim() === '') return 'must be a non-empty IANA time zone name';
    try {
      // The only honest way to check a zone name without a table is to ask the runtime to use it.
      new Intl.DateTimeFormat('en-US', { timeZone: v });
      return null;
    } catch {
      return `is not a time zone this runtime knows: ${JSON.stringify(v)}`;
    }
  },
  rttStaleMs: (v) => (Number.isInteger(v) && v > 0 ? null : 'must be a positive integer'),
  writeScope: (v) => (Array.isArray(v) && v.every((e) => typeof e === 'string') ? null : 'must be an array of strings'),
};

/**
 * Parse one config document.
 *
 * @param {string} text - File contents.
 * @param {string} source - Path, for error messages.
 * @returns {{ok: true, values: object} | {ok: false, error: string, code: string, key: string|null}}
 */
export function parseSharedConfig(text, source = SHARED_CONFIG_NAME) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    // A config file that does not parse must not be treated as empty: the operator would then be
    // running on defaults while believing their settings applied.
    return { ok: false, code: 'W2M_CONFIG_UNPARSABLE', key: null, error: `${source} is not valid JSON: ${error.message}` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, code: 'W2M_CONFIG_NOT_AN_OBJECT', key: null, error: `${source} must contain a JSON object` };
  }

  const values = {};
  for (const [key, value] of Object.entries(doc)) {
    const forbidden = FORBIDDEN_KEY_PATTERNS.find((p) => p.re.test(key));
    if (forbidden) {
      return {
        ok: false,
        code: 'W2M_CONFIG_SECRET_REFUSED',
        key,
        error:
          `${source}: refusing key "${key}" because ${forbidden.why}. ` +
          'A token here would be committed, and silently ignoring it would let you believe it is in effect.',
      };
    }
    if (!Object.prototype.hasOwnProperty.call(KEY_VALIDATORS, key)) {
      // Unknown keys are refused, not ignored. A typo'd key that is silently dropped is
      // indistinguishable from a setting that is in effect, which is the worse of the two failures.
      return {
        ok: false,
        code: 'W2M_CONFIG_UNKNOWN_KEY',
        key,
        error: `${source}: unknown key "${key}"; known keys are ${Object.keys(KEY_VALIDATORS).join(', ')}`,
      };
    }
    const problem = KEY_VALIDATORS[key](value);
    if (problem !== null) {
      return { ok: false, code: 'W2M_CONFIG_BAD_VALUE', key, error: `${source}: "${key}" ${problem}` };
    }
    values[key] = value;
  }

  // `updateTimes` normalizes to the same shape the scheduler expects, so a caller cannot forget.
  if (Array.isArray(values.updateTimes)) {
    values.updateTimes = values.updateTimes.map((t) => (t.length === 5 ? `${t}:00` : t));
  }
  return { ok: true, values };
}

/**
 * Load and merge the shared layers.
 *
 * Reading is deliberately tolerant of **absence** and intolerant of **breakage**: no file is the normal
 * case and yields the defaults, while a file that exists and is wrong is a thrown error. The
 * distinction matters because "no config" and "config I could not read" must not look the same.
 *
 * @param {object} [opts] - Options.
 * @param {string} [opts.projectDir] - Project root holding the committed file.
 * @param {string} [opts.machineDir] - Directory holding the machine-local file; defaults to `~/.w2m`.
 * @param {object} [opts.explicit] - The host's own config object (highest precedence).
 * @param {(p: string) => boolean} [opts.exists] - Injected for tests.
 * @param {(p: string) => string} [opts.read] - Injected for tests.
 * @returns {{values: object, sources: object, files: object, warnings: string[]}}
 */
export function loadSharedConfig({
  projectDir = process.cwd(),
  machineDir = join(homedir(), '.w2m'),
  explicit = {},
  exists = existsSync,
  read = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const files = {
    shared: resolve(join(projectDir, SHARED_CONFIG_NAME)),
    machine: resolve(join(machineDir, MACHINE_CONFIG_NAME)),
  };

  /** @type {object} */
  const values = {};
  /** @type {Record<string, string>} */
  const sources = {};
  for (const [key, value] of Object.entries(SHARED_CONFIG_DEFAULTS)) {
    values[key] = Array.isArray(value) ? [...value] : value;
    sources[key] = 'default';
  }

  const warnings = [];
  for (const [layer, path] of [
    ['shared', files.shared],
    ['machine', files.machine],
  ]) {
    if (!exists(path)) continue; // absent is normal
    const parsed = parseSharedConfig(read(path), path);
    if (!parsed.ok) {
      // Thrown rather than downgraded to a warning: continuing on defaults while the operator believes
      // their settings are active is exactly the silent-wrong-answer this project refuses.
      const error = new Error(parsed.error);
      error.code = parsed.code;
      error.key = parsed.key;
      error.path = path;
      throw error;
    }
    for (const [key, value] of Object.entries(parsed.values)) {
      values[key] = Array.isArray(value) ? [...value] : value;
      sources[key] = layer;
    }
  }

  // The host's own config is the highest layer. Only keys the shared file knows about participate, so
  // an unrelated host setting cannot appear to come from the shared file.
  for (const key of Object.keys(KEY_VALIDATORS)) {
    if (explicit[key] === undefined) continue;
    const problem = KEY_VALIDATORS[key](explicit[key]);
    if (problem !== null) {
      const error = new Error(`host config: "${key}" ${problem}`);
      error.code = 'W2M_CONFIG_BAD_VALUE';
      error.key = key;
      throw error;
    }
    values[key] = Array.isArray(explicit[key]) ? [...explicit[key]] : explicit[key];
    sources[key] = 'explicit';
  }

  return { values, sources, files, warnings };
}

/**
 * A human-readable account of where each effective value came from.
 *
 * Exists because "the setting is there but something overrides it" is the characteristic failure of
 * layered configuration, and the answer must be readable without bisecting the layers by hand.
 *
 * @param {ReturnType<typeof loadSharedConfig>} loaded
 * @returns {string}
 */
export function describeSharedConfig(loaded) {
  const lines = ['shared config:'];
  for (const key of Object.keys(SHARED_CONFIG_DEFAULTS)) {
    const from = loaded.sources[key] ?? 'default';
    const value = loaded.values[key];
    const shown = Array.isArray(value) ? JSON.stringify(value) : String(value);
    lines.push(`  ${key} = ${shown}  [${from}]`);
  }
  lines.push(`  files: shared=${loaded.files.shared}${loaded.files.shared === loaded.files.machine ? '' : `, machine=${loaded.files.machine}`}`);
  for (const w of loaded.warnings ?? []) lines.push(`  warning: ${w}`);
  return lines.join('\n');
}
