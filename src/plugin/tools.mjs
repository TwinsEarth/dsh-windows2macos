/**
 * DSH: Windows2MacOS — the DSH Cordis plugin.
 *
 * # What this exposes
 *
 * Five tools over the W2M line protocol (see `_work/w2m/PROTOCOL.md`, frozen v1):
 *
 *   w2m_devices  read-only   which machines the Rabbit currently holds leases for
 *   w2m_run      control     broadcast one argv command to the online machines
 *   w2m_wait     read-only   wait for terminal results and hand back the six-state aggregate
 *   w2m_report   read-only   the rendered report, markdown or json
 *   w2m_status   read-only   this machine's identity, Rabbit reachability, project base_commit
 *
 * The plugin is a **client of the Rabbit**. It does not execute commands, does not fork
 * processes, and does not decide whether two machines agreed — the Rabbit does that and this
 * code only reports what it was told, plus the fields it did not recognise.
 *
 * # Fail-closed choices
 *
 * * A missing configured value is a **typed error naming the setting** (`W2M_CONFIG`), never an
 *   empty success. A missing capability is a typed error naming the capability.
 * * Results are reported with their refusals intact: a non-zero exit, a `refused` machine, a
 *   `divergent` aggregate, and an `unverifiable` aggregate are all *values*, not exceptions. The
 *   only things that throw are "the tool could not run" and "the tool ran and said no".
 * * Arguments travel as an **argv array**, never a shell string (PROTOCOL §0).
 * * Every call is bounded by a wall-clock timeout and an output byte cap, so a wedged Rabbit
 *   cannot hang the session and a chatty one cannot flood it.
 * * Every call honours `exec.signal`; the signal is merged with our own timeout so a cancel
 *   produces a typed abort, not a mystery failure.
 * * This file never reads `.credentials.yaml`, and never hard-codes an endpoint: every URL comes
 *   from `config.rabbitUrl` or from `device.json`'s `rabbit_url`.
 *
 * # `@deepseek-ai/dsh-tools` and the offline fallback
 *
 * `defineTool` is imported lazily, at `apply()` time, through {@link loadDefineTool}. When the
 * package is importable — the real path, inside DSH — its `defineTool` is used unchanged. When it
 * is not — this repository has no `node_modules`, so `node --test` cannot resolve it — a minimal
 * **shim** stands in so the unit tests can still drive `apply()` and the registered definitions.
 *
 * The shim validates only the shape this file says it must (name present, `parameters` an object,
 * `execute` a function, no undeclared parameter keys). It does **not** implement argument
 * coercion, `required` enforcement, timeout enforcement, cancellation, permission gating, or
 * output rendering. **The shim is not a production path**; production semantics come from DSH's
 * own `dsh-tools`. Anything the shim accepts may still be rejected or reshaped by the real
 * implementation, and vice versa.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The base-address rules live in one place (§2), shared with the agent side. Importing them — rather
// than re-deriving them here — is what stops the plugin and the agent from disagreeing about what
// `https://host/w2m` means, which is the defect §2 exists to fix.
// `src/agent/` does not import `src/plugin/`, so the dependency runs one way and cannot cycle.
import { joinUrl, resolveBaseUrl } from '../agent/url.mjs';

/** Services this plugin needs. The harness refuses to load the plugin without them. */
export const inject = ['tools'];

/** Line protocol version this plugin speaks. Reported by `w2m_status`, never negotiated here. */
const PROTOCOL_VERSION = 1;

/** How long any single HTTP call may take before it is aborted, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** How long `w2m_status`'s reachability probe may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 3_000;

/** Wall-clock ceiling for one `w2m_wait` call, in milliseconds. */
const MAX_WAIT_MS = 600_000;

/** Wall-clock ceiling for one command handed to the machines, in milliseconds. */
const MAX_TASK_TIMEOUT_MS = 3_600_000;

/** Lower bound, in milliseconds, on the interval between two status polls. */
const MIN_POLL_MS = 25;

/** Largest JSON body this plugin will read, in bytes. Keeps a flood out of the session. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Largest report body this plugin will read, in bytes. */
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** Largest `stdout`/`stderr` excerpt returned inline by `w2m_wait`, in bytes per stream. */
const MAX_EXCERPT_BYTES = 4096;

/** HTTP statuses worth one more attempt: the request did not reach a decision. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * An error a caller can act on, carrying a stable machine-readable code.
 *
 * `code` and `hint` are duplicated into enumerable own properties so that `JSON.stringify(error)`
 * — which a tool layer may well do — still shows the caller what was wrong.
 */
class W2MError extends Error {
  /**
   * @param {string} code Stable code, e.g. `W2M_CONFIG`.
   * @param {string} message What went wrong and, when known, how to fix it.
   * @param {{hint?: string, detail?: object, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'W2MError';
    this.code = code;
    this.hint = options.hint;
    this.detail = options.detail;
  }
}

/**
 * A configured value is missing or unusable.
 *
 * The message carries the setting name, what is wrong with it, and what to set instead — a model
 * reading only the message has to be able to fix the configuration by itself. The hint repeats the
 * remediation for callers that surface hints separately.
 *
 * @param {string} setting Dotted setting name, e.g. `rabbitUrl`.
 * @param {string} why Why the value was refused.
 * @param {string} hint What to set.
 * @returns {W2MError}
 */
function configError(setting, why, hint) {
  return new W2MError('W2M_CONFIG', `W2M_CONFIG: configuration \`${setting}\` ${why}; ${hint}`, { hint });
}

// ---------------------------------------------------------------------------------------------
// Cooperative cancellation
// ---------------------------------------------------------------------------------------------

/**
 * An `AbortSignal` that fires when either input fires.
 *
 * Hand-rolled rather than `AbortSignal.any` so the plugin keeps working on the Node versions
 * this project supports without a feature probe on the hot path.
 *
 * @param {AbortSignal|undefined} a
 * @param {AbortSignal|undefined} b
 * @returns {{signal: AbortSignal, dispose: () => void}}
 */
function combineSignals(a, b) {
  const controller = new AbortController();
  const forward = (from) => () => controller.abort(from.reason);
  const listeners = [];

  for (const signal of [a, b]) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const handler = forward(signal);
    signal.addEventListener('abort', handler, { once: true });
    listeners.push([signal, handler]);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, handler] of listeners) signal.removeEventListener('abort', handler);
    },
  };
}

/**
 * Stop now when the caller has already cancelled, before doing any work.
 *
 * The abort reason is wrapped, not re-thrown raw: a caller that gets `W2M_ABORTED` back can tell
 * "you cancelled me" apart from "the Rabbit refused", which is the distinction these tools exist
 * to preserve. The original reason is kept as the cause.
 *
 * @param {AbortSignal|undefined} signal
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof W2MError) throw reason;
  throw new W2MError('W2M_ABORTED', `W2M_ABORTED: the call was cancelled${reason instanceof Error && reason.message ? ` (${reason.message})` : ''}`, {
    hint: 'the caller withdrew the request; nothing was sent',
    cause: reason,
  });
}

/**
 * Did this rejection come from an abort rather than from a real failure?
 *
 * @param {unknown} error
 * @param {AbortSignal|undefined} signal
 * @returns {boolean}
 */
function isAbort(error, signal) {
  if (signal?.aborted) return true;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return error instanceof W2MError && error.code === 'W2M_ABORTED';
}

/**
 * How long this plugin waited, and whether it needs the Rabbit operator to look.
 *
 * A `timeout` envelope is precisely the case PROTOCOL §4.3 leaves to the Rabbit's clock, so the
 * hint points there rather than pretending the local wait was authoritative.
 *
 * @param {string} taskId
 * @param {string[]} states States still running when we gave up.
 * @returns {object}
 */
function timeoutEnvelope(taskId, states) {
  return {
    ok: true,
    complete: false,
    task_id: taskId,
    state: 'timeout',
    states,
    note:
      'the wait window elapsed before every machine reached a terminal state; this is a local ' +
      'observation only, not a verdict on the machines',
    hint: 'raise wait_ms, or call w2m_wait again to continue from where this left off',
  };
}

// ---------------------------------------------------------------------------------------------
// `defineTool`: real import first, offline shim second
// ---------------------------------------------------------------------------------------------

/** Parameters the shim understands in a definition. Anything else is a typo, and is rejected. */
const ALLOWED_DEF_KEYS = new Set(['name', 'description', 'parameters', 'output', 'execute', 'presentCall']);

/**
 * Validate one parameter declaration and return a normalised copy.
 *
 * @param {string} toolName Owning tool, for messages.
 * @param {string} key Parameter name.
 * @param {unknown} decl Declaration from the definition.
 * @returns {object}
 */
function normaliseParameter(toolName, key, decl) {
  if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
    throw new TypeError(`${toolName}: parameter \`${key}\` must be an object`);
  }
  const { type } = decl;
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'array' && type !== 'object') {
    throw new TypeError(`${toolName}: parameter \`${key}\` needs a type of string|number|boolean|array|object`);
  }
  if (type === 'array' && 'items' in decl) {
    if (decl.items === null || typeof decl.items !== 'object') {
      throw new TypeError(`${toolName}: parameter \`${key}\`.items must be an object`);
    }
  }
  const copy = { ...decl };
  if (copy.required !== undefined && typeof copy.required !== 'boolean') {
    throw new TypeError(`${toolName}: parameter \`${key}\`.required must be a boolean`);
  }
  if (copy.default !== undefined) copy.required = false;
  return copy;
}

/**
 * The offline stand-in for `@deepseek-ai/dsh-tools`' `defineTool`.
 *
 * It normalises and checks shape only; see the file header for the full list of what it
 * deliberately does not do. The real `defineTool`'s own properties are copied onto it so anything
 * else DSH exports alongside it keeps working.
 *
 * @param {object} [real] The genuine `defineTool`, when the package resolved.
 * @returns {{defineTool: (def: object) => object, usedFallback: boolean}}
 */
function createDefineTool(real) {
  const defineTool = (definition) => {
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError('defineTool: definition must be an object');
    }

    const name = definition.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('defineTool: `name` must be a non-empty string');
    }

    for (const key of Object.keys(definition)) {
      if (!ALLOWED_DEF_KEYS.has(key)) {
        throw new TypeError(`defineTool(${name}): unsupported definition key \`${key}\``);
      }
    }

    if (typeof definition.execute !== 'function') {
      throw new TypeError(`defineTool(${name}): \`execute\` must be a function`);
    }

    const declared = definition.parameters ?? {};
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
      throw new TypeError(`defineTool(${name}): \`parameters\` must be an object`);
    }

    const parameters = {};
    for (const [key, decl] of Object.entries(declared)) {
      parameters[key] = normaliseParameter(name, key, decl);
    }

    return { ...definition, parameters };
  };

  if (real && typeof real === 'object') Object.assign(defineTool, real);
  return { defineTool, usedFallback: !real };
}

/** Cached so `apply()` can be called more than once without re-importing. */
let defineToolModule;

/**
 * Forget the resolved `defineTool`, so the next `loadDefineTool()` resolves again.
 *
 * Exists for the unit tests, which need to exercise both the real-import path and the offline
 * shim in the same process. It is not part of the plugin's runtime contract.
 */
export function resetDefineToolCacheForTests() {
  defineToolModule = undefined;
}

/**
 * Resolve `@deepseek-ai/dsh-tools` at runtime, falling back to the offline shim.
 *
 * @returns {Promise<{defineTool: Function, usedFallback: boolean, reason: string|null}>}
 */
async function loadDefineTool() {
  if (!defineToolModule) {
    defineToolModule = (async () => {
      try {
        const mod = await import('@deepseek-ai/dsh-tools');
        if (typeof mod?.defineTool !== 'function') {
          return { ...createDefineTool(undefined), reason: 'the package resolved but exports no `defineTool`' };
        }
        return { defineTool: mod.defineTool, usedFallback: false, reason: null };
      } catch (error) {
        return { ...createDefineTool(undefined), reason: error instanceof Error ? error.message : String(error) };
      }
    })();
  }
  return defineToolModule;
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/**
 * Read and validate the plugin configuration.
 *
 * Only `rabbitUrl` is required, and only for the tools that talk to the Rabbit: `w2m_status` is
 * the diagnostic you reach for *when* the setup is broken, so it must still run without it.
 *
 * @param {object} config Entry configuration from the profile patch.
 * @returns {{rabbitUrl: string|null, stateDir: string|null, projectDir: string, machineName: string|null,
 *            autoStartAgent: boolean, allowedCommands: string[], pairingCode: string|null}}
 */
function readConfig(config = {}) {
  const cwd = process.cwd();
  const raw = config.rabbitUrl;
  const rabbitUrl = typeof raw === 'string' && raw.trim() !== '' ? checkedRabbitBase(raw) : null;

  const stateDir = typeof config.stateDir === 'string' && config.stateDir.trim() !== ''
    ? path.resolve(config.stateDir.trim())
    : null;

  return {
    rabbitUrl,
    stateDir,
    projectDir: typeof config.projectDir === 'string' && config.projectDir.trim() !== ''
      ? path.resolve(config.projectDir.trim())
      : cwd,
    machineName: typeof config.machineName === 'string' && config.machineName.trim() !== ''
      ? config.machineName.trim()
      : os.hostname(),
    autoStartAgent: config.autoStartAgent === true,
    allowedCommands: Array.isArray(config.allowedCommands)
      ? config.allowedCommands.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
      : [],
    pairingCode: typeof config.pairingCode === 'string' && config.pairingCode.trim() !== ''
      ? config.pairingCode.trim()
      : (typeof process.env.W2M_PAIRING_CODE === 'string' && process.env.W2M_PAIRING_CODE.trim() !== ''
        ? process.env.W2M_PAIRING_CODE.trim()
        : null),
    // §5: the operator credential. Only `w2m_run` uses it.
    operatorToken: typeof config.operatorToken === 'string' && config.operatorToken.trim() !== ''
      ? config.operatorToken.trim()
      : (typeof process.env.W2M_OPERATOR_TOKEN === 'string' && process.env.W2M_OPERATOR_TOKEN.trim() !== ''
        ? process.env.W2M_OPERATOR_TOKEN.trim()
        : null),
  };
}

/**
 * Require the Rabbit URL, naming the setting when it is absent.
 *
 * @param {{rabbitUrl: string|null}} cfg
 * @returns {string}
 */
function requireRabbit(cfg) {
  if (!cfg.rabbitUrl) {
    throw configError(
      'rabbitUrl',
      'is not set, so this tool has no Rabbit to talk to',
      'set `rabbitUrl` in this plugin\'s profile patch to the Rabbit base URL, for example http://127.0.0.1:8787',
    );
  }
  return cfg.rabbitUrl;
}

/**
 * Require the state directory, naming the setting when it is absent.
 *
 * Used by the paths that genuinely cannot work without a `device.json` — see {@link resolveToken},
 * which is the only caller, and which explains why an unset `stateDir` is not an error there.
 *
 * @param {{stateDir: string|null}} cfg
 * @returns {string}
 */
function requireStateDir(cfg) {
  if (!cfg.stateDir) {
    throw configError(
      'stateDir',
      'is not set, so device.json cannot be located',
      'set `stateDir` to the directory holding device.json (the agent writes it there after pairing)',
    );
  }
  return cfg.stateDir;
}

/**
 * Require the operator token, naming the setting when it is absent (PROTOCOL-v0.1.2 §5).
 *
 * `POST /v1/task` is the one endpoint that authorises with the operator token rather than the
 * device token. There is deliberately **no fallback** to the device token: a relay that has the
 * requirement enabled answers such an attempt with `401 OPERATOR_REQUIRED`, and a plugin that
 * quietly tried the device token first would turn a missing setting into a confusing remote
 * refusal. Failing here names the setting the operator has to set.
 *
 * @param {{operatorToken: string|null}} cfg
 * @returns {string}
 */
function requireOperatorToken(cfg) {
  if (cfg.operatorToken) return cfg.operatorToken;
  throw configError(
    'operatorToken',
    'is not set, so this tool cannot dispatch a task — a device token cannot dispatch tasks; ' +
      '`POST /v1/task` requires the operator token',
    'set `operatorToken` in this plugin\'s profile patch (or `W2M_OPERATOR_TOKEN` in the environment) ' +
      'to the value the relay printed at startup, or read it from `<state>/operator-token.txt`',
  );
}

// ---------------------------------------------------------------------------------------------
// Base URL and endpoint joining (PROTOCOL-v0.1.2 §2)
// ---------------------------------------------------------------------------------------------

/**
 * Validate a `rabbitUrl` and reduce it to a base address, as a plugin-shaped error.
 *
 * The rule itself lives in `../agent/url.mjs` (imported above) so both sides cannot drift. This
 * wrapper exists only to translate its `TypeError` into the `W2M_CONFIG` error every other
 * configuration fault in this file uses, whose message names the setting **and** what to do — the
 * caller is a model reading tool output, not a developer reading a stack trace.
 *
 * @param {unknown} raw
 * @returns {string} Base with every trailing slash removed.
 */
function checkedRabbitBase(raw) {
  try {
    return resolveBaseUrl(String(raw ?? ''));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The shared validator reports a bad scheme as "got ftp://"; naming a "scheme" is friendlier to
    // whoever has to act on it, so the plugin-shaped message says the word.
    const scheme = /got\s+([a-z][a-z0-9+.-]*:)/i.exec(reason);
    const why = scheme
      ? `uses scheme \`${scheme[1]}\`, which is not supported (only http and https are)`
      : `is not usable as a base address — ${reason}`;
    throw configError(
      'rabbitUrl',
      why,
      'set `rabbitUrl` to the relay base address, for example http://127.0.0.1:8787, ' +
        'http://100.64.0.5:8787, or https://w2m.example.com/w2m (a deployment sub-path is allowed; ' +
        'a query string or fragment is not)',
    );
  }
}

/**
 * Build a `URL` from a joined string, for `fetch`.
 *
 * The joining already produced an absolute URL; this only gives `fetch` the object it prefers, and
 * turns "not absolute after all" into a named configuration error instead of `Invalid URL`.
 *
 * @param {string} url
 * @returns {URL}
 */
function toRequestUrl(url) {
  try {
    return new URL(url);
  } catch (error) {
    throw new W2MError('W2M_CONFIG', `W2M_CONFIG: the joined endpoint \`${url}\` is not an absolute URL (${error instanceof Error ? error.message : String(error)})`, {
      hint: 'set `rabbitUrl` to an absolute base such as https://w2m.example.com/w2m',
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Agent RTT (PROTOCOL-v0.1.2 §8.2)
// ---------------------------------------------------------------------------------------------

/**
 * A status getter reachable from this process, when the plugin started relay+agent itself.
 *
 * Set by {@link startLocalStack}. Null in the normal case, where the agent runs as its own process
 * and its state is not reachable from here at all — see {@link readRtt}.
 *
 * @type {(() => object)|null}
 */
let inProcessAgentStatus = null;

/**
 * File names an agent may publish its state under, most specific first.
 *
 * The `localside/` entry is not decoration: `stateDir` here is documented as the
 * directory holding `device.json`, and `w2m-localside` keeps its own state one
 * level below it (`<DSH_HOME>/xclient/localside`, see `resolveStateDir(_, 'localside')`).
 * Without this entry the default CLI layout could never be read, and RTT would
 * silently stay unavailable in exactly the cross-region deployment it is for.
 */
const AGENT_STATE_FILES = ['agent-state.json', 'agent.json', 'localside-state.json', path.join('localside', 'agent-state.json')];

/**
 * Normalise whatever the agent published into `{last, avg, samples}`.
 *
 * Tolerant on purpose: this is a cross-process, cross-version boundary, and a reader that demanded
 * one exact spelling would report "no RTT" for a perfectly healthy agent. Field aliases cover the
 * obvious spellings; an array is read as the rolling samples; a bare number is read as the last.
 *
 * @param {unknown} rtt
 * @returns {{last: number|null, avg: number|null, samples: number[]}|null}
 */
function normaliseRtt(rtt) {
  if (rtt === null || rtt === undefined) return null;

  if (typeof rtt === 'number' && Number.isFinite(rtt)) {
    return { last: rtt, avg: rtt, samples: [rtt] };
  }

  if (Array.isArray(rtt)) {
    const samples = rtt.filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (samples.length === 0) return null;
    return { last: samples[samples.length - 1], avg: round(samples.reduce((a, b) => a + b, 0) / samples.length), samples };
  }

  if (typeof rtt !== 'object') return null;

  const pick = (...keys) => {
    for (const key of keys) {
      const value = rtt[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };
  const rawSamples = Array.isArray(rtt.samples)
    ? rtt.samples.filter((value) => typeof value === 'number' && Number.isFinite(value))
    : [];

  const last = pick('last', 'lastMs', 'last_ms', 'current');
  const avg = pick('avg', 'average', 'mean');
  if (last === null && avg === null && rawSamples.length === 0) return null;

  const samples = rawSamples.length > 0 ? rawSamples : [last ?? avg];
  return { last: last ?? samples[samples.length - 1], avg: avg ?? round(samples.reduce((a, b) => a + b, 0) / samples.length), samples };
}

/**
 * Round to one decimal: RTT is a diagnostic, and false precision invites false conclusions.
 *
 * @param {number} value
 * @returns {number}
 */
function round(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Read the local agent's round-trip time, or explain why it is unavailable (§8.2).
 *
 * §8.2 puts `rttMs` on the agent's in-memory state. When the plugin started the agent inside this
 * process, that state is reachable directly. When the agent is its own process — the normal
 * deployment — it is not, so this also looks for a state file under `stateDir`. Neither source
 * being present is reported as `available: false` with a reason, never as an error: cross-region
 * diagnosis fails loudly, but this tool must still answer when the agent has not been started.
 *
 * @param {{stateDir: string|null}} cfg
 * @returns {Promise<{available: boolean, source: string|null, last: number|null, avg: number|null,
 *                    samples: number[], ms: number|null, reason: string|null, path: string|null}>}
 */
async function readRtt(cfg) {
  const empty = {
    available: false,
    source: null,
    last: null,
    avg: null,
    samples: [],
    ms: null,
    reason: null,
    path: null,
  };

  if (inProcessAgentStatus) {
    try {
      const status = inProcessAgentStatus();
      const rtt = normaliseRtt(status?.rttMs ?? status?.rtt ?? null);
      if (rtt) return { ...empty, ...rtt, available: true, source: 'in-process-agent' };
      return { ...empty, source: 'in-process-agent', reason: 'the in-process agent has not recorded a round trip yet' };
    } catch (error) {
      return {
        ...empty,
        source: 'in-process-agent',
        reason: `the in-process agent status getter threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!cfg.stateDir) {
    return { ...empty, reason: 'stateDir is not set, so no agent state could be located' };
  }

  for (const name of AGENT_STATE_FILES) {
    const file = path.join(cfg.stateDir, name);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      const rtt = normaliseRtt(parsed?.rttMs ?? parsed?.rtt ?? null);
      if (rtt) return { ...empty, ...rtt, available: true, source: 'state-file', path: file };
    } catch {
      continue;
    }
  }

  return {
    ...empty,
    reason:
      'no agent round-trip time is available: the agent is not running in this process and no ' +
      `agent state file was found under ${cfg.stateDir}`,
  };
}


/**
 * Read a response body, refusing to buffer more than `maxBytes`.
 *
 * A body with no stream falls back to `arrayBuffer()`, which keeps the function usable with bare
 * response-like stubs.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new W2MError('W2M_TOO_LARGE', `W2M_TOO_LARGE: the Rabbit answered with ${declared} bytes, above the ${maxBytes}-byte cap`, {
      hint: 'ask for a narrower range (for example a smaller `limit` or `format: json`), or read the report from the Rabbit directly',
    });
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new W2MError('W2M_TOO_LARGE', `W2M_TOO_LARGE: the Rabbit answered with ${buffer.byteLength} bytes, above the ${maxBytes}-byte cap`);
    }
    return buffer.toString('utf8');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        size += value.byteLength;
        if (size > maxBytes) {
          throw new W2MError('W2M_TOO_LARGE', `W2M_TOO_LARGE: the Rabbit's answer passed the ${maxBytes}-byte cap and was stopped`, {
            hint: 'ask for a narrower range, or read the report from the Rabbit directly',
          });
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A reader that cannot be cancelled is not a reason to lose the result we already have.
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse the protocol's error shape: `{ error: { code, message, detail } }` (PROTOCOL §7).
 *
 * @param {string} text
 * @returns {{code: string, message: string, detail: unknown}|null}
 */
function parseErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      return { code: error.code, message: String(error.message ?? ''), detail: error.detail };
    }
  } catch {
    // Not JSON, or not our shape; fall through to the generic message.
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/**
 * Perform one request against the Rabbit.
 *
 * Resolves for every HTTP status, including 4xx and 5xx: the Rabbit's refusals are answers, and
 * the code table in PROTOCOL §7 is part of the protocol, not an exceptional path. Rejects only
 * when the call could not be made at all (transport, abort, size cap).
 *
 * @param {{rabbitUrl: string, token?: string|null, signal?: AbortSignal, timeoutMs?: number,
 *          method?: string, pathname: string, query?: object, body?: unknown,
 *          maxBytes?: number, accept?: string}} options
 * @returns {Promise<{status: number, ok: boolean, text: string, json: object|null, error: object|null}>}
 */
async function request(options) {
  const {
    rabbitUrl,
    token = null,
    signal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    method = 'GET',
    pathname,
    query,
    body,
    maxBytes = MAX_RESPONSE_BYTES,
    accept = 'application/json',
  } = options;

  throwIfAborted(signal);

  // Named here rather than left to `new URL`, whose failure would say only "Invalid URL" and send
  // the reader looking in the wrong place.
  if (typeof rabbitUrl !== 'string' || rabbitUrl === '') {
    throw new W2MError('W2M_CONFIG', 'W2M_CONFIG: no Rabbit URL was available for this call', {
      hint: 'set `rabbitUrl` in this plugin\'s profile patch, for example http://127.0.0.1:8787',
    });
  }

  // §2: base + path, joined by hand. `new URL(pathname, base)` would resolve against the origin
  // and drop a deployment sub-path (`https://h/w2m` + `/v1/task` → `https://h/v1/task` → 404).
  const target = toRequestUrl(joinUrl(rabbitUrl, pathname));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }

  const headers = { accept };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error('timeout')), timeoutMs);
  const combined = combineSignals(signal, timeoutController.signal);

  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined.signal,
    });
  } catch (error) {
    const aborted = isAbort(error, combined.signal);
    throw new W2MError(
      aborted ? 'W2M_ABORTED' : 'W2M_UNREACHABLE',
      aborted
        ? `W2M_ABORTED: the call to ${endpointOf(target)} was cancelled after ${timeoutMs} ms or by the caller`
        : `W2M_UNREACHABLE: could not reach the Rabbit at ${endpointOf(target)}: ${error instanceof Error ? error.message : String(error)}`,
      {
        hint: 'check that the Rabbit is running and that `rabbitUrl` points at it (w2m_status probes it)',
        cause: error,
      },
    );
  } finally {
    clearTimeout(timer);
    combined.dispose();
  }

  const text = await readBody(response, maxBytes);
  const contentType = response.headers?.get?.('content-type') ?? '';
  let json = null;
  if (text.trim() !== '' && (contentType.includes('json') || /^[[{]/.test(text.trim()))) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  const error = response.ok ? null : parseErrorBody(text);
  if (!error && !response.ok) {
    return {
      status: response.status,
      ok: false,
      text,
      json,
      error: { code: 'HTTP_ERROR', message: text.trim().slice(0, 400) || `HTTP ${response.status}`, detail: null },
    };
  }

  return { status: response.status, ok: response.ok, text, json, error };
}

/**
 * Render a URL for a message, without its query string, so nothing sensitive is echoed back.
 *
 * @param {URL} target
 * @returns {string}
 */
function endpointOf(target) {
  return `${target.origin}${target.pathname}`;
}

/**
 * Resolve the bearer token for the Rabbit calls.
 *
 * Absent `stateDir` means "no paired device was declared", which is a configuration the operator
 * may have chosen — the calls then go out unauthenticated and a `401` is reported as a refusal,
 * which is the accurate account of what happened. A `stateDir` that *is* set means the operator
 * pointed at a pairing, so a missing or unreadable `device.json` is named as the fault instead of
 * being turned into a mystery `401`.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {Promise<string|null>}
 */
async function resolveToken(cfg) {
  if (!cfg.stateDir) return null;
  return requireToken(await readDevice({ stateDir: requireStateDir(cfg) }));
}

// ---------------------------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------------------------

/**
 * Read `device.json` from the state directory (PROTOCOL §2.1).
 *
 * @param {{stateDir: string|null}} cfg
 * @returns {Promise<{machine_id: string|null, machine_name: string|null, device_token: string|null,
 *                    rabbit_url: string|null, path: string|null, present: boolean, error: string|null}>}
 */
async function readDevice(cfg) {
  const empty = {
    machine_id: null,
    machine_name: null,
    device_token: null,
    rabbit_url: null,
    path: null,
    present: false,
    error: null,
  };
  if (!cfg.stateDir) return empty;

  const file = path.join(cfg.stateDir, 'device.json');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ...empty, path: file };
    return { ...empty, path: file, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      machine_id: typeof parsed?.machine_id === 'string' ? parsed.machine_id : null,
      machine_name: typeof parsed?.machine_name === 'string' ? parsed.machine_name : null,
      device_token: typeof parsed?.device_token === 'string' && parsed.device_token !== '' ? parsed.device_token : null,
      rabbit_url: typeof parsed?.rabbit_url === 'string' ? parsed.rabbit_url : null,
      path: file,
      present: true,
      error: null,
    };
  } catch (error) {
    return { ...empty, path: file, present: true, error: `device.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Require a `device_token`, naming where it was looked for when it is absent.
 *
 * @param {{machine_id: string|null, device_token: string|null, path: string|null, present: boolean, error: string|null}} device
 * @returns {string}
 */
function requireToken(device) {
  if (device.device_token) return device.device_token;
  if (!device.present) {
    throw new W2MError(
      'W2M_NO_TOKEN',
      `W2M_NO_TOKEN: no paired device at \`${device.path ?? 'device.json'}\` — the file does not exist; ` +
        'start the agent once so it can pair, or set `stateDir` to the directory holding an already-paired device.json',
      { hint: 'start the agent once so it can pair, or set `stateDir` to the directory holding an already-paired device.json' },
    );
  }
  if (device.error) {
    throw new W2MError(
      'W2M_NO_TOKEN',
      `W2M_NO_TOKEN: could not read a device token from \`${device.path}\` — ${device.error}; repair or delete the file and pair again`,
      { hint: 'repair or delete the file and pair again' },
    );
  }
  throw new W2MError(
    'W2M_NO_TOKEN',
    `W2M_NO_TOKEN: \`${device.path}\` has no \`device_token\` — the device has not completed POST /v1/pair yet; run the agent once to pair it`,
    { hint: 'the device has not completed POST /v1/pair yet; run the agent once to pair it' },
  );
}

// ---------------------------------------------------------------------------------------------
// git anchors
// ---------------------------------------------------------------------------------------------

/**
 * Run `git` and return its exit code and output, never throwing for a non-zero exit.
 *
 * @param {string[]} argv Arguments after the executable.
 * @param {{cwd?: string, env?: object, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runGit(argv, options = {}) {
  const { cwd, env, timeoutMs = 10_000 } = options;
  return new Promise((resolve) => {
    execFile(
      process.env.W2M_GIT || 'git',
      argv,
      { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? (error && error.message ? error.message : ''),
        });
      },
    );
  });
}

/**
 * Resolve the project's three anchors' worth of git state.
 *
 * `base_commit` is `HEAD`. `base_tree` is the tree of the **working tree as it stands**, which is
 * what a peer's `pre_tree_fingerprint` can actually be equal to — the tree of `HEAD` would report
 * every uncommitted change as an anchor mismatch. It is computed the way PROTOCOL §5.1 names the
 * algorithm, `git-temp-index-tree/v1`, so this machine's answer and a peer's are comparable.
 *
 * @param {{projectDir: string, timeoutMs?: number}} options
 * @returns {Promise<{base_commit: string|null, base_tree: string|null, dirty: boolean|null,
 *                    branch: string|null, head_commit: string|null, error: string|null}>}
 */
async function resolveGitAnchors(options) {
  const { projectDir, timeoutMs = 10_000 } = options;
  const result = { base_commit: null, base_tree: null, dirty: null, branch: null, head_commit: null, error: null };

  const inRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, timeoutMs });
  if (inRepo.code !== 0 || inRepo.stdout.trim() !== 'true') {
    result.error = inRepo.code !== 0
      ? `\`${projectDir}\` is not a git work tree (${(inRepo.stderr.trim() || 'no diagnostic').slice(0, 200)})`
      : 'not a git work tree';
    return result;
  }

  const head = await runGit(['rev-parse', 'HEAD'], { cwd: projectDir, timeoutMs });
  if (head.code === 0) {
    result.base_commit = head.stdout.trim();
    result.head_commit = result.base_commit;
  } else {
    result.error = (head.stderr.trim() || 'HEAD could not be resolved').slice(0, 200);
  }

  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir, timeoutMs });
  if (branch.code === 0) result.branch = branch.stdout.trim();

  const status = await runGit(['status', '--porcelain'], { cwd: projectDir, timeoutMs });
  if (status.code === 0) result.dirty = status.stdout.trim() !== '';

  const tree = await resolveTreeFingerprint(projectDir, timeoutMs);
  result.base_tree = tree.value;
  if (!tree.value && !result.error) result.error = tree.error;

  return result;
}

/**
 * `git-temp-index-tree/v1`: hash the working tree through a throwaway index.
 *
 * A temporary `GIT_INDEX_FILE` means the real index is never touched, so asking for the anchor
 * cannot itself dirty the repository we are about to measure.
 *
 * @param {string} projectDir
 * @param {number} timeoutMs
 * @returns {Promise<{value: string|null, error: string|null}>}
 */
async function resolveTreeFingerprint(projectDir, timeoutMs) {
  // mkdtemp rather than a name in the project: nothing is left behind if we are killed.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-index-'));
  const indexPath = path.join(scratch, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    const added = await runGit(['add', '-A', '--', '.'], { cwd: projectDir, env, timeoutMs });
    if (added.code !== 0) {
      return { value: null, error: `git add for the tree fingerprint failed: ${(added.stderr.trim() || 'no diagnostic').slice(0, 200)}` };
    }
    const written = await runGit(['write-tree'], { cwd: projectDir, env, timeoutMs });
    if (written.code !== 0) {
      return { value: null, error: `git write-tree failed: ${(written.stderr.trim() || 'no diagnostic').slice(0, 200)}` };
    }
    return { value: written.stdout.trim() || null, error: null };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Command policy
// ---------------------------------------------------------------------------------------------

/**
 * Reduce an executable reference to a comparable form: basename, lower case, no `.exe`/`.cmd`/`.bat`.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeCommand(value) {
  const base = path.basename(String(value).trim().replace(/\\/g, '/')).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com)$/, '');
}

/**
 * Check `argv[0]` against the configured allow-list.
 *
 * Returns `null` when the call may proceed. When `allowedCommands` is unset or empty this plugin
 * does **not** refuse: the execution gate belongs to the machine that runs the command, and the
 * agent enforces its own `allowedCommands`. Refusing here on an empty list would either duplicate
 * that policy badly or hide it behind a silent allow, so the plugin only enforces what it was
 * explicitly told.
 *
 * @param {string[]} allowedCommands
 * @param {string[]} argv
 * @returns {{code: string, message: string, allowed: string[]}|null}
 */
function checkAllowedCommand(allowedCommands, argv) {
  if (allowedCommands.length === 0) return null;
  const allowed = new Set(allowedCommands.map(normalizeCommand));
  if (allowed.has(normalizeCommand(argv[0]))) return null;
  return {
    code: 'COMMAND_NOT_ALLOWED',
    message: `\`${argv[0]}\` is not in this plugin's allowedCommands (${[...allowed].sort().join(', ')})`,
    allowed: [...allowed].sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// Shapes shared by the tools
// ---------------------------------------------------------------------------------------------

/**
 * Strip bulky fields out of an envelope, keeping the comparable ones and a bounded excerpt.
 *
 * Comparable fields are copied through in full: silently dropping one would turn a `divergent`
 * verdict into a mystery.
 *
 * @param {object} raw
 * @param {Set<string>} comparable
 * @returns {object}
 */
function compactEnvelope(raw, comparable) {
  if (raw === null || typeof raw !== 'object') return { value: raw };

  const compact = {};
  for (const [key, value] of Object.entries(raw)) {
    if (comparable.has(key) || key === 'status' || key === 'refusal_reason') compact[key] = value;
  }
  for (const key of ['stdout_head', 'stdout_tail', 'stderr_head', 'stderr_tail']) {
    if (typeof raw[key] === 'string') compact[key] = excerpt(raw[key]);
  }
  return compact;
}

/**
 * Keep only the first `MAX_EXCERPT_BYTES` bytes of a stream.
 *
 * @param {string} value
 * @returns {string}
 */
function excerpt(value) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= MAX_EXCERPT_BYTES) return value;
  return `${buffer.subarray(0, MAX_EXCERPT_BYTES).toString('utf8')}\n…[truncated at ${MAX_EXCERPT_BYTES} bytes]`;
}

/**
 * Compare the Rabbit's envelope against the field list this plugin knows, and report what is new.
 *
 * PROTOCOL §5 says unknown fields must be ignored. Ignoring them is not the same as being blind
 * to them: a Rabbit that starts sending a field this plugin does not understand is a protocol
 * drift a reader needs to see, so the names are surfaced rather than dropped.
 *
 * @param {object} body
 * @param {{comparable: Set<string>, optional: Set<string>}} known
 * @returns {string[]}
 */
function collectUnknownFields(body, known) {
  const aggregate = aggregateOf(body);
  const machines = Array.isArray(aggregate?.machines) ? aggregate.machines : [];
  const seen = new Set();
  for (const machine of machines) {
    const envelope = machine?.envelope ?? machine?.result;
    if (envelope === null || typeof envelope !== 'object') continue;
    for (const key of Object.keys(envelope)) {
      if (!known.comparable.has(key) && !known.optional.has(key)) seen.add(key);
    }
  }
  return [...seen].sort();
}

/** Comparable fields — mirror of PROTOCOL §5.3. Only these decide consistency. */
const COMPARABLE_FIELDS = new Set([
  'task_id', 'index', 'index_total', 'mode', 'cwd_rel', 'base_commit', 'base_tree',
  'pre_tree_fingerprint', 'fingerprint_algo', 'fingerprint_error', 'head_commit', 'command_hash',
  'shell_id', 'exit_code', 'status', 'refusal_reason', 'stdout_sha256', 'stdout_bytes',
  'stdout_normalized_sha256', 'stderr_sha256', 'artifacts', 'diff_numstat', 'tests',
  'semantic_counts', 'warnings',
]);

/**
 * Optional fields — mirror of PROTOCOL §5.2. Carried, but never compared.
 *
 * `artifacts`, `tests`, and `semantic_counts` appear in both §5.2 and §5.3; the union is what
 * matters for the drift report, so they need naming only once, and `COMPARABLE_FIELDS` already
 * names them.
 */
const OPTIONAL_FIELDS = new Set([
  'stdout_head', 'stdout_tail', 'stderr_head', 'stderr_tail', 'untracked', 'toolchain',
  'lockfiles', 'unpinned_deps', 'submodules', 'lfs', 'signal',
]);

/**
 * Every aggregate status this plugin will accept as a verdict.
 *
 * The first six are §6.3's states. `pending` and `refused` are not verdicts on consistency, but the
 * Rabbit emits them for a task that has no verdict yet and for a task every machine refused, so
 * they are recognised — otherwise the one state that means "keep waiting" would be reported as an
 * unknown.
 */
const AGGREGATE_STATES = new Set([
  'consistent', 'divergent', 'divergent-platform', 'partial', 'failed', 'unverifiable',
  'pending', 'refused',
]);

/** Aggregate statuses that are not a verdict: the task may still move. */
const NON_TERMINAL_AGGREGATE = new Set(['pending']);

/** Per-machine `outcome` values that mean the machine is still working. */
const NON_TERMINAL_OUTCOME = new Set(['pending', null, undefined]);

/**
 * Find the aggregate inside a task response.
 *
 * `GET /v1/tasks/{id}` answers `{protocol_version, rabbit_time, task, leases, aggregate}`, while
 * `GET /v1/tasks/{id}/report?format=json` answers the aggregate itself. Both shapes are accepted so
 * a reader that has either one in hand can use the same normalisation.
 *
 * @param {object} body
 * @returns {object|null}
 */
function aggregateOf(body) {
  if (body === null || typeof body !== 'object') return null;
  if (body.aggregate !== null && typeof body.aggregate === 'object') return body.aggregate;
  if (typeof body.status === 'string') return body;
  return null;
}

/**
 * Normalise the aggregate the Rabbit reported.
 *
 * `known` is false for a status outside {@link AGGREGATE_STATES}: a verdict this plugin does not
 * understand is surfaced rather than trusted. `terminal` is the question the wait loop actually
 * asks — a task with no verdict yet, or with a machine whose lease is still unexpired and has not
 * reported, is not finished, and reporting it as finished would be the worst kind of quiet wrong
 * answer.
 *
 * @param {object} body A task response or a bare aggregate.
 * @returns {{state: string|null, known: boolean, terminal: boolean, states: string[], detail: object|null}}
 */
function readAggregate(body) {
  const aggregate = aggregateOf(body);
  if (aggregate === null) {
    return { state: null, known: false, terminal: false, states: [], detail: null };
  }

  const state = typeof aggregate.status === 'string' ? aggregate.status : null;
  const known = state !== null && AGGREGATE_STATES.has(state);
  const outcomes = Array.isArray(aggregate.machines)
    ? aggregate.machines.map((machine) => machine?.outcome ?? null)
    : [];

  // A status this plugin does not recognise ends the wait rather than extending it: the Rabbit has
  // stopped saying "no verdict yet", so waiting cannot turn an unknown word into a known one.
  // `known: false` is what tells the caller the verdict is unreadable.
  const terminal = state !== null
    && (!known
      || (!NON_TERMINAL_AGGREGATE.has(state) && !outcomes.some((outcome) => NON_TERMINAL_OUTCOME.has(outcome))));

  return { state, known, terminal, states: outcomes, detail: aggregate };
}

// ---------------------------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------------------------

/**
 * Build the short cross-region hints `w2m_status` returns alongside its data.
 *
 * These are the three questions §4 says an operator asks first — is the relay there, has it
 * restarted, do I have the credential it wants — answered in one place so a model does not have to
 * compare fields itself.
 *
 * @param {object} relay The relay block built by `w2m_status`.
 * @param {object} rtt The block from {@link readRtt}.
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {string[]}
 */
function statusNotes(relay, rtt, cfg) {
  const notes = [];

  if (relay.reachable === true && relay.relay_id) {
    notes.push(
      `relay_id \`${relay.relay_id}\` has been up ${Math.round((relay.uptime_ms ?? 0) / 1000)}s — ` +
        'record this id: a different one on a later call means the relay restarted and every machine reconnected to a new process',
    );
  } else if (relay.reachable === true && relay.relay_id === null) {
    notes.push('the relay answered /healthz but sent no relay_id, so it predates v0.1.2 and a restart cannot be detected from here');
  }

  if (relay.reachable === true && relay.base_path !== null && cfg.rabbitUrl) {
    notes.push(`the relay reports base_path \`${relay.base_path}\`; \`rabbitUrl\` in use is \`${cfg.rabbitUrl}\``);
  }

  if (relay.operator_token_required === true && cfg.operatorToken === null) {
    notes.push(
      'this relay requires an operator token for POST /v1/task and none is configured, so w2m_run will refuse before sending anything — set `operatorToken` or `W2M_OPERATOR_TOKEN`',
    );
  } else if (relay.operator_token_required === false) {
    notes.push('this relay does not require an operator token (an explicit escape hatch, not the default), so an unauthenticated dispatch can succeed');
  }

  if (rtt.available) {
    notes.push(`round trip to the relay: last ${rtt.last} ms, average ${rtt.avg} ms over ${rtt.samples.length} sample(s) (source: ${rtt.source})`);
  } else if (rtt.reason) {
    notes.push(`round-trip time unavailable — ${rtt.reason}`);
  }

  return notes;
}

/**
 * Register the five W2M tools.
 *
 * @param {object} ctx Cordis context, carrying the `tools` service.
 * @param {object} [config] Entry configuration from the profile patch.
 * @returns {Promise<void>} Resolves once the tools are registered. `apply` is async because
 *          resolving `@deepseek-ai/dsh-tools` is.
 */
export async function apply(ctx, config = {}) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    throw new W2MError('W2M_NO_TOOLS', 'this plugin needs the `tools` service, and ctx.tools.register is missing', {
      hint: 'load the plugin in a profile that injects the `tools` service',
    });
  }

  const cfg = readConfig(config);
  const { defineTool, usedFallback, reason } = await loadDefineTool();
  if (usedFallback) {
    ctx.logger?.warn?.(
      `w2m: @deepseek-ai/dsh-tools did not resolve (${reason}); using the offline shim. ` +
        'Argument validation, timeouts, cancellation, and rendering will come from DSH in production.',
    );
  }

  /** Text output: rendered as JSON, because every one of these tools answers with a structure. */
  const jsonOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  };

  /** The message a caller sees when a transport-level call failed. Never a silent success. */
  const transportError = (error, tool) => {
    const detail = {
      error: true,
      tool,
      code: error instanceof W2MError ? error.code : 'W2M_INTERNAL',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof W2MError && error.hint ? { hint: error.hint } : {}),
    };
    throw new Error(JSON.stringify(detail, null, 2));
  };

  // -------------------------------------------------------------------------------------------
  // 1. w2m_devices — read-only
  // -------------------------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'w2m_devices',
    description:
      'List the machines the Rabbit currently holds leases for: machine_id, name, platform, ' +
      'capabilities, and when each was last seen. Read-only. Answers "who is online" without ' +
      'running anything; a machine that is listed may still refuse the next command for a reason ' +
      'the capability gate will report.',
    parameters: {
      include_stale: {
        type: 'boolean',
        description: 'Include machines whose lease looks expired rather than only the live ones. Defaults to false.',
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const token = await resolveToken(cfg);
      const result = await request({
        rabbitUrl: base,
        token,
        signal: exec?.signal,
        pathname: '/v1/devices',
      });
      if (!result.ok) {
        throw new W2MError('W2M_RABBIT_REFUSED', `W2M_RABBIT_REFUSED: the Rabbit refused GET /v1/devices with HTTP ${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}; ${result.status === 401 ? 'this machine is not paired, or its device_token is stale — pair the agent again' : 'check the Rabbit log for the reason it gave'}`, {
          hint: result.status === 401
            ? 'this machine is not paired, or its device_token is stale; pair the agent again'
            : 'check the Rabbit log for the reason it gave',
        });
      }

      // `GET /v1/devices` answers `{protocol_version, rabbit_time, devices:[...]}`. Each entry is a
      // device record — the Rabbit's own lease bookkeeping is on the task, not here — so a device
      // is described by identity and capabilities, and "online" is the honest default for a device
      // the Rabbit still lists.
      const machines = Array.isArray(result.json?.devices)
        ? result.json.devices
        : (Array.isArray(result.json?.machines) ? result.json.machines : []);
      const includeStale = args?.include_stale === true;
      const listed = machines.filter((machine) => includeStale || String(machine?.state ?? 'online') !== 'expired');

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          rabbit_time: result.json?.rabbit_time ?? null,
          count: listed.length,
          devices: listed.map((machine) => ({
            machine_id: machine?.machine_id ?? null,
            name: machine?.machine_name ?? machine?.name ?? null,
            os: machine?.platform?.os ?? null,
            os_version: machine?.platform?.os_version ?? null,
            arch: machine?.platform?.arch ?? null,
            shell: machine?.platform?.shell ?? null,
            caps: machine?.caps ?? null,
            last_seen: machine?.last_seen ?? machine?.last_seen_at ?? null,
            state: machine?.state ?? 'online',
          })),
          excluded_stale: includeStale ? 0 : machines.length - listed.length,
          note:
            'a listed device has paired and is being tracked; it can still refuse the next command ' +
            'at the capability gate, which w2m_wait reports per machine as `refused`',
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m devices', kind: 'read', rawInput: {} }),
  }));

  // -------------------------------------------------------------------------------------------
  // 2. w2m_run — broadcast
  // -------------------------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'w2m_run',
    description:
      'Broadcast one command, as an argv array, to every online machine and return the task_id ' +
      'with its per-machine leases. The command runs on each machine in its own copy of the ' +
      'project; nothing is written unless `write` is true. Read the result with w2m_wait. ' +
      'Anchors (base_commit, base_tree) are computed here from this machine\'s working tree so ' +
      'the peers can be checked against them.',
    parameters: {
      command_argv: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'The command as an argv array, for example ["node","--test"]. Never a shell string.',
      },
      mode: {
        type: 'string',
        description: 'replicate: every machine runs the whole command. split: each machine takes its share by index. Defaults to replicate.',
        default: 'replicate',
      },
      index_total: {
        type: 'number',
        description: 'Number of slices for mode=split. Defaults to 1, which is the only value replicate accepts.',
        default: 1,
      },
      cwd_rel: {
        type: 'string',
        description: 'Working directory relative to the project root, with forward slashes. Defaults to ".".',
        default: '.',
      },
      timeout_ms: {
        type: 'number',
        description: `How long each machine may spend on the command, in milliseconds. Defaults to 300000, capped at ${MAX_TASK_TIMEOUT_MS}.`,
        default: 300_000,
      },
      write: {
        type: 'boolean',
        description: 'Allow the machines to write inside write_scope. Defaults to false, which makes the whole run read-only.',
        default: false,
      },
      write_scope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Project-relative path prefixes the machines may write, for example ["src/"]. Required in spirit when write is true.',
      },
      require_exclusive_write: {
        type: 'boolean',
        description: 'Ask the Rabbit to grant at most one writing lease at a time. Defaults to false.',
        default: false,
      },
      halt: {
        type: 'string',
        description: 'never: a machine that stops reporting is only recorded. now: other machines may take over its work. Defaults to never.',
        default: 'never',
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);

      // `required` is enforced by DSH's schema layer in production, and by the shim offline; this
      // check is here so a caller that bypassed both still gets a named reason instead of a
      // confusing failure several layers down.
      const argv = args?.command_argv;
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || part === '')) {
        throw new W2MError('W2M_INVALID_ARGV', '`command_argv` must be a non-empty array of non-empty strings', {
          hint: 'pass the command as separate array elements, for example ["node","--test"]',
        });
      }

      const mode = args?.mode ?? 'replicate';
      if (mode !== 'replicate' && mode !== 'split') {
        throw new W2MError(
          'W2M_BAD_MODE',
          `W2M_BAD_MODE: \`mode\` must be \`replicate\` or \`split\`, not \`${mode}\`; replicate runs the whole command on every machine, split hands each machine a slice by index`,
        );
      }
      const indexTotal = Number.isInteger(args?.index_total) ? args.index_total : 1;
      if (indexTotal < 1) {
        throw new W2MError(
          'W2M_BAD_INDEX',
          `W2M_BAD_INDEX: \`index_total\` is \`${args?.index_total}\` but must be an integer of at least 1 (number of slices)`,
        );
      }
      if (mode === 'replicate' && indexTotal !== 1) {
        throw new W2MError(
          'W2M_BAD_INDEX',
          `W2M_BAD_INDEX: mode=replicate means every machine runs the whole command, so \`index_total\` must be 1, not \`${indexTotal}\`; use mode=split with index_total>1 to hand each machine a slice`,
          { hint: 'use mode=split with index_total>1 to hand each machine a slice' },
        );
      }

      // Plugin-side allow-list check: only when one is configured. See checkAllowedCommand.
      const refused = checkAllowedCommand(cfg.allowedCommands, argv);
      if (refused) {
        return JSON.stringify(
          { ok: false, state: 'refused', refusal_reason: refused.code, message: refused.message, allowed: refused.allowed },
          null,
          2,
        );
      }

      const timeoutMs = Math.min(
        Math.max(1, Number.isFinite(args?.timeout_ms) ? Number(args.timeout_ms) : 300_000),
        MAX_TASK_TIMEOUT_MS,
      );
      const write = args?.write === true;
      const writeScope = Array.isArray(args?.write_scope)
        ? args.write_scope.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        : [];
      if (write && writeScope.length === 0) {
        throw new W2MError(
          'W2M_WRITE_SCOPE',
          'W2M_WRITE_SCOPE: `write` is true but `write_scope` is empty; name the project-relative prefixes the machines may write, for example ["src/"], or set write to false',
          { hint: 'name the project-relative prefixes the machines may write, for example ["src/"], or leave write false' },
        );
      }

      // §5: dispatching a task is the operator's privilege, not the device's. The operator token is
      // required and there is no device-token fallback — see requireOperatorToken.
      const token = requireOperatorToken(cfg);
      const anchors = await resolveGitAnchors({ projectDir: cfg.projectDir, timeoutMs: Math.min(15_000, timeoutMs) });

      const payload = {
        mode,
        command_argv: argv,
        cwd_rel: typeof args?.cwd_rel === 'string' && args.cwd_rel !== '' ? args.cwd_rel : '.',
        index_total: indexTotal,
        timeout_ms: timeoutMs,
        write,
        write_scope: writeScope,
        require_exclusive_write: args?.require_exclusive_write === true,
        base_commit: anchors.base_commit,
        base_tree: anchors.base_tree,
        requirements: { toolchain: {}, platform: [] },
        compare_policy: { strip_ansi: true, normalize_crlf: true, strip_trailing_blank_lines: true, redact: [] },
        halt: args?.halt === 'now' ? 'now' : 'never',
        created_by: cfg.machineName,
      };

      const result = await request({
        rabbitUrl: base,
        token,
        signal: exec?.signal,
        method: 'POST',
        pathname: '/v1/task',
        body: payload,
      });

      if (!result.ok) {
        // OPERATOR_REQUIRED gets its own guidance: it is the one refusal whose fix is a client-side
        // setting rather than something on the relay.
        const operatorRequired = result.error?.code === 'OPERATOR_REQUIRED' || result.status === 401;
        throw new W2MError(
          'W2M_RABBIT_REFUSED',
          `W2M_RABBIT_REFUSED: the Rabbit refused POST /v1/task with HTTP ${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}; ${operatorRequired ? 'this relay requires the operator token to dispatch tasks and the one sent was not accepted — set `operatorToken` (or `W2M_OPERATOR_TOKEN`) to the value the relay printed at startup; a device token cannot dispatch tasks' : result.error?.code === 'NO_ONLINE_DEVICE' ? 'no machine is currently streaming — start the agent on each machine, then w2m_devices shows who is online' : 'check the Rabbit log for the reason it gave'}`,
          {
            hint: operatorRequired
              ? 'set `operatorToken` (or `W2M_OPERATOR_TOKEN`) to the value the relay printed at startup, or read it from `<state>/operator-token.txt`'
              : result.error?.code === 'NO_ONLINE_DEVICE'
                ? 'no machine is currently streaming; start the agent on each machine (w2m_devices shows who is online)'
                : 'check the Rabbit log for the reason it gave',
          },
        );
      }

      return JSON.stringify(
        {
          ok: true,
          task_id: result.json?.task_id ?? null,
          seq: result.json?.seq ?? null,
          leases: result.json?.leases ?? [],
          anchors: {
            base_commit: anchors.base_commit,
            base_tree: anchors.base_tree,
            dirty: anchors.dirty,
            branch: anchors.branch,
            fingerprint_algo: 'git-temp-index-tree/v1',
            error: anchors.error,
          },
          note: anchors.base_tree === null
            ? 'this machine\'s working tree could not be fingerprinted, so peers have no anchor to match and the aggregate will be unverifiable'
            : 'peers are checked against base_commit + base_tree + command_hash',
        },
        null,
        2,
      );
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `w2m run ${Array.isArray(args?.command_argv) ? args.command_argv.join(' ') : ''}`.trim(),
      kind: args?.write === true ? 'write' : 'read',
      rawInput: args,
    }),
  }));

  // -------------------------------------------------------------------------------------------
  // 3. w2m_wait
  // -------------------------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'w2m_wait',
    description:
      'Wait for a task to reach a terminal state and return the six-state aggregate with a ' +
      'per-machine summary. A non-zero exit, a refusal, and a divergence are all reported as ' +
      'values, not as tool failures. If the wait window elapses first, says so and leaves the ' +
      'task runnable — call again to keep waiting.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by w2m_run.' },
      wait_ms: {
        type: 'number',
        description: `How long to wait before giving up, in milliseconds. Defaults to 120000, capped at ${MAX_WAIT_MS}.`,
        default: 120_000,
      },
      poll_ms: {
        type: 'number',
        description: `Interval between status polls, in milliseconds. Defaults to 750. Raise it to be gentler on the Rabbit; it is capped below by ${MIN_POLL_MS}.`,
        default: 750,
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : '';
      if (taskId === '') {
        throw new W2MError('W2M_BAD_TASK_ID', '`task_id` must be a non-empty string');
      }

      const waitMs = Math.min(Math.max(1, Number.isFinite(args?.wait_ms) ? Number(args.wait_ms) : 120_000), MAX_WAIT_MS);
      const pollMs = Math.min(Math.max(MIN_POLL_MS, Number.isFinite(args?.poll_ms) ? Number(args.poll_ms) : 750), 30_000);
      const token = await resolveToken(cfg);

      const deadline = Date.now() + waitMs;

      let body = null;
      let attempts = 0;
      let lastFailure = null;

      for (;;) {
        throwIfAborted(exec?.signal);
        const result = await request({
          rabbitUrl: base,
          token,
          signal: exec?.signal,
          pathname: `/v1/tasks/${encodeURIComponent(taskId)}`,
        });
        attempts += 1;

        if (!result.ok && !RETRYABLE_STATUS.has(result.status)) {
          throw new W2MError(
            'W2M_RABBIT_REFUSED',
            `W2M_RABBIT_REFUSED: the Rabbit refused GET /v1/tasks/${taskId} with HTTP ${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}; ${result.error?.code === 'NOT_FOUND' ? `check the task_id returned by w2m_run — the Rabbit does not know \`${taskId}\`` : 'check the Rabbit log for the reason it gave'}`,
            { hint: result.error?.code === 'NOT_FOUND' ? 'check the task_id returned by w2m_run' : 'check the Rabbit log' },
          );
        }

        // A retryable failure leaves us with no state to read: keep whatever the last good answer
        // said, and remember that the latest attempt did not land.
        if (result.ok) {
          body = result.json;
          lastFailure = null;
          const current = readAggregate(body);
          if (current.terminal) break;
        } else {
          lastFailure = `HTTP ${result.status}${result.error ? ` (${result.error.code})` : ''}`;
        }

        if (Date.now() >= deadline) {
          const states = readAggregate(body).states;
          const envelope = timeoutEnvelope(taskId, states.length > 0 ? states.map(String) : ['unknown']);
          // Both facts matter when nothing was ever read: how far we got, and why. Reporting only
          // the first would hide a Rabbit that answered every time with a retryable error.
          const note = body === null
            ? `no status has been read from the Rabbit yet; the task may or may not exist${lastFailure ? ` — the most recent poll did not land (${lastFailure})` : ''}`
            : (lastFailure
              ? `${envelope.note}; the most recent poll did not land (${lastFailure})`
              : envelope.note);
          return JSON.stringify(
            {
              ...envelope,
              // After the spread, so the local verdict is not overwritten by what was last seen.
              state: 'timeout',
              last_state: readAggregate(body).state,
              note,
              polls: attempts,
              ...(lastFailure ? { last_error: lastFailure } : {}),
            },
            null,
            2,
          );
        }

        const remaining = deadline - Date.now();
        await sleepWithSignal(Math.min(pollMs, Math.max(1, remaining)), exec?.signal);
      }

      const aggregate = readAggregate(body);
      const machines = Array.isArray(aggregate.detail?.machines)
        ? aggregate.detail.machines.map((machine) => {
            const envelope = machine?.envelope ?? machine?.result ?? null;
            return {
              machine_id: machine?.machine_id ?? null,
              machine_name: machine?.machine_name ?? null,
              index: machine?.index ?? null,
              lease_state: machine?.lease_state ?? null,
              outcome: machine?.outcome ?? null,
              status: machine?.status ?? null,
              refusal_reason: machine?.refusal_reason ?? null,
              exit_code: machine?.exit_code ?? null,
              reasons: machine?.reasons ?? [],
              envelope: compactEnvelope(envelope, COMPARABLE_FIELDS),
            };
          })
        : [];

      return JSON.stringify(
        {
          ok: true,
          complete: true,
          task_id: taskId,
          state: aggregate.state,
          state_known: aggregate.known,
          states: aggregate.states,
          machines,
          counts: aggregate.detail?.counts ?? null,
          differences: aggregate.detail?.differences ?? [],
          notes: aggregate.detail?.notes ?? [],
          unknown_fields: collectUnknownFields(body, { comparable: COMPARABLE_FIELDS, optional: OPTIONAL_FIELDS }),
          polls: attempts,
        },
        null,
        2,
      );
    },
    presentCall: (args) => ({ card: 'generic', title: `w2m wait ${args?.task_id ?? ''}`, kind: 'read', rawInput: args }),
  }));

  // -------------------------------------------------------------------------------------------
  // 4. w2m_report
  // -------------------------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'w2m_report',
    description:
      'Fetch the rendered report for a finished task, as markdown or json. Markdown is the ' +
      'human summary; json is the same aggregate shape w2m_wait returns. Read-only, and does ' +
      'not start, resume, or cancel anything.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by w2m_run.' },
      format: { type: 'string', description: 'md for the rendered report, json for the aggregate. Defaults to md.', default: 'md' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : '';
      if (taskId === '') {
        throw new W2MError('W2M_BAD_TASK_ID', '`task_id` must be a non-empty string');
      }
      const format = args?.format === 'json' ? 'json' : 'md';
      const token = await resolveToken(cfg);

      const result = await request({
        rabbitUrl: base,
        token,
        signal: exec?.signal,
        pathname: `/v1/tasks/${encodeURIComponent(taskId)}/report`,
        query: { format },
        maxBytes: MAX_REPORT_BYTES,
        accept: format === 'json' ? 'application/json' : 'text/markdown, text/plain',
      });

      if (!result.ok) {
        throw new W2MError(
          'W2M_RABBIT_REFUSED',
          `W2M_RABBIT_REFUSED: the Rabbit refused GET /v1/tasks/${taskId}/report with HTTP ${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}; ${result.error?.code === 'NOT_FOUND' ? 'the task may still be running — w2m_wait first, or check the task_id returned by w2m_run' : 'check the Rabbit log for the reason it gave'}`,
          { hint: result.error?.code === 'NOT_FOUND' ? 'the task may still be running; w2m_wait first' : 'check the Rabbit log' },
        );
      }

      if (format === 'json') {
        return JSON.stringify(
          { ok: true, task_id: taskId, format, report: result.json ?? result.text },
          null,
          2,
        );
      }

      return JSON.stringify(
        {
          ok: true,
          task_id: taskId,
          format,
          bytes: Buffer.byteLength(result.text, 'utf8'),
          report: result.text,
        },
        null,
        2,
      );
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `w2m report ${args?.task_id ?? ''}`,
      kind: 'read',
      rawInput: args,
    }),
  }));

  // -------------------------------------------------------------------------------------------
  // 5. w2m_status — read-only, and the only tool that works without rabbitUrl
  // -------------------------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'w2m_status',
    description:
      'Report this plugin\'s view of itself: the machine identity on disk, whether the Rabbit ' +
      'answers, the paired token presence, the relay\'s cross-region diagnostics (relay_id, ' +
      'uptime, deployment base_path, effective_scheme, whether it demands an operator token), ' +
      'this machine\'s round-trip time to the relay, and the project\'s base_commit/base_tree. ' +
      'Read-only, degrades field by field, and deliberately usable while the configuration is ' +
      'still broken, because it is the tool you reach for when w2m_devices says rabbitUrl is unset.',
    parameters: {},
    output: jsonOutput,
    async execute(_args, exec) {
      throwIfAborted(exec?.signal);
      // Read, not required: this tool exists to describe a half-configured machine, so an absent or
      // unpaired device.json is part of the answer rather than a reason to refuse. `/healthz` needs
      // no bearer token, so nothing here depends on the token being present.
      const device = await readDevice(cfg);

      // A cheap reachability probe of a documented endpoint. Without a configured URL there is
      // nothing to probe, and that is reported rather than guessed at.
      let relay = {
        configured_url: cfg.rabbitUrl,
        probed_url: null,
        reachable: null,
        http_status: null,
        protocol_version: null,
        error: null,
        // §4 cross-region diagnostics. Null until `/healthz` answers, and individually null when a
        // relay predates v0.1.2: a missing field is reported as missing, never invented.
        relay_id: null,
        uptime_ms: null,
        started_at: null,
        base_path: null,
        effective_scheme: null,
        operator_token_required: null,
        pair_rate_limit: null,
        persistence: null,
      };
      const probeBase = cfg.rabbitUrl ?? device.rabbit_url ?? null;
      if (probeBase) {
        const target = `${probeBase.replace(/\/+$/, '')}`;
        try {
          const probe = await request({
            rabbitUrl: target,
            signal: exec?.signal,
            pathname: '/healthz',
            timeoutMs: PROBE_TIMEOUT_MS,
            maxBytes: 64 * 1024,
          });
          const health = probe.json ?? {};
          relay = {
            configured_url: cfg.rabbitUrl,
            probed_url: target,
            reachable: probe.ok,
            http_status: probe.status,
            protocol_version: health.protocol_version ?? null,
            error: probe.ok ? null : (probe.error?.code ?? `HTTP ${probe.status}`),
            relay_id: health.relay_id ?? null,
            uptime_ms: typeof health.uptime_ms === 'number' ? health.uptime_ms : null,
            started_at: health.started_at ?? null,
            base_path: health.base_path ?? null,
            effective_scheme: health.effective_scheme ?? null,
            operator_token_required:
              typeof health.operator_token_required === 'boolean' ? health.operator_token_required : null,
            pair_rate_limit: typeof health.pair_rate_limit === 'number' ? health.pair_rate_limit : null,
            persistence: health.persistence ?? null,
            // Which of the §4 fields this relay actually sent. A v1 relay sends none of them, and a
            // reader should be able to tell "field absent" from "field false".
            diagnostics_present: ['relay_id', 'uptime_ms', 'base_path', 'effective_scheme', 'operator_token_required']
              .filter((key) => health[key] !== undefined && health[key] !== null),
          };
        } catch (error) {
          relay = {
            ...relay,
            configured_url: cfg.rabbitUrl,
            probed_url: target,
            reachable: false,
            http_status: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const anchors = await resolveGitAnchors({ projectDir: cfg.projectDir });
      const rtt = await readRtt(cfg);

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          identity: {
            machine_id: device.machine_id,
            machine_name: cfg.machineName,
            device_json: device.path,
            device_json_present: device.present,
            paired: device.device_token !== null,
            device_error: device.error,
          },
          relay: { ...relay, healthz: '/healthz' },
          rtt,
          config: {
            rabbitUrl: cfg.rabbitUrl,
            stateDir: cfg.stateDir,
            projectDir: cfg.projectDir,
            autoStartAgent: cfg.autoStartAgent,
            allowedCommands: cfg.allowedCommands,
            pairingCode_configured: cfg.pairingCode !== null,
            // §5: `validated` reports presence only. The plugin cannot tell a correct token from a
            // wrong one without spending a dispatch, and `required_by_relay` is what makes the two
            // halves of the mismatch (client has none / relay demands one) visible side by side.
            operatorToken_configured: cfg.operatorToken !== null,
            operatorToken_source: cfg.operatorToken !== null
              ? (typeof config?.operatorToken === 'string' && config.operatorToken.trim() !== ''
                ? 'config'
                : 'environment')
              : null,
            operatorToken_required_by_relay: relay.operator_token_required ?? null,
          },
          project: {
            base_commit: anchors.base_commit,
            base_tree: anchors.base_tree,
            head_commit: anchors.head_commit,
            branch: anchors.branch,
            dirty: anchors.dirty,
            fingerprint_algo: 'git-temp-index-tree/v1',
            error: anchors.error,
          },
          notes: statusNotes(relay, rtt, cfg),
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m status', kind: 'read', rawInput: {} }),
  }));

  // -------------------------------------------------------------------------------------------
  // Optional: bring up relay + agent in this process
  // -------------------------------------------------------------------------------------------
  if (cfg.autoStartAgent) {
    ctx.effect?.(() => startLocalStack(ctx, cfg));
  }
}

/**
 * Wait, but stop waiting the moment the caller cancels.
 *
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    const fail = (reason) => {
      if (reason instanceof W2MError) reject(reason);
      else {
        reject(new W2MError('W2M_ABORTED', `W2M_ABORTED: the wait was cancelled${reason instanceof Error && reason.message ? ` (${reason.message})` : ''}`, {
          cause: reason,
        }));
      }
    };

    if (signal?.aborted) {
      fail(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      fail(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Start the relay, then pair an agent against it, inside this process.
 *
 * Both modules are imported dynamically: this repository is written by several people at once, and
 * a plugin that refuses to load because a sibling module is not on disk yet would be useless to
 * the other four tools. A missing module is reported as a typed error naming the path and what
 * that means.
 *
 * @param {object} ctx
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {Promise<() => Promise<void>>} A disposer that stops the agent and closes the relay.
 */
async function startLocalStack(ctx, cfg) {
  const relayUrl = new URL('../relay/server.mjs', import.meta.url);
  const agentUrl = new URL('../agent/agent.mjs', import.meta.url);

  let createRelay;
  let createAgent;
  try {
    ({ createRelay } = await import(relayUrl.href));
  } catch (error) {
    throw new W2MError('W2M_MODULE_MISSING', `autoStartAgent is on but ${relayUrl.pathname} could not be imported: ${error instanceof Error ? error.message : String(error)}`, {
      hint: 'run the relay yourself and set rabbitUrl, or make sure src/relay/server.mjs is present',
    });
  }
  try {
    ({ createAgent } = await import(agentUrl.href));
  } catch (error) {
    throw new W2MError('W2M_MODULE_MISSING', `autoStartAgent is on but ${agentUrl.pathname} could not be imported: ${error instanceof Error ? error.message : String(error)}`, {
      hint: 'run the agent yourself and set rabbitUrl, or make sure src/agent/agent.mjs is present',
    });
  }

  const target = cfg.rabbitUrl ? new URL(cfg.rabbitUrl) : null;
  const relay = await createRelay({
    host: target?.hostname ?? '127.0.0.1',
    port: target?.port ? Number(target.port) : 8787,
    stateDir: cfg.stateDir,
    pairingCode: cfg.pairingCode ?? undefined,
  });
  ctx.logger?.info?.(`w2m: relay listening at ${relay.url ?? '(unknown url)'}`);

  const agent = await createAgent({
    rabbitUrl: relay.url ?? cfg.rabbitUrl,
    pairingCode: cfg.pairingCode ?? relay.pairingCode ?? undefined,
    projectDir: cfg.projectDir,
    machineName: cfg.machineName,
    stateDir: cfg.stateDir,
    allowedCommands: cfg.allowedCommands,
  });
  await agent.start();
  ctx.logger?.info?.(`w2m: agent started as ${JSON.stringify(agent.identity?.() ?? null)}`);

  // §8.2: when the agent runs inside this process its `rttMs` is reachable directly, so `w2m_status`
  // can report it without a file. When the agent is its own process this stays null and the tool
  // says so instead of guessing.
  const statusGetter = agent.status ?? agent.state ?? null;
  inProcessAgentStatus = typeof statusGetter === 'function' ? statusGetter.bind(agent) : null;

  return async () => {
    inProcessAgentStatus = null;
    await agent.stop();
    await relay.close();
  };
}
