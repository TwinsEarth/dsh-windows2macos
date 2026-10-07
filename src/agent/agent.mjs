/**
 * The Localside agent: everything between "Rabbit hands us an offer" and
 * "Rabbit has our envelope".
 *
 * Flow, in the order the contract requires it:
 *
 *   pair -> SSE long-poll -> offer -> **spool first** -> capability gate ->
 *   anchors -> execute -> anchors -> envelope -> spool -> POST -> ack -> delete
 *
 * Notable decisions, all traceable to the protocol:
 *
 *   * `shell_id` is always `direct-exec` (§5.1); a shell is never used.
 *   * The command allow-list is **default-deny**: an empty list refuses
 *     everything, and an offer may only run an argv that *starts with* one of
 *     the configured prefixes.
 *   * Capability mismatches are `refused` with a reason code, never a silent
 *     downgrade (§6.1).
 *   * The lease is renewed by heartbeat only; the agent never decides on its
 *     own that a lease expired (§4.3) -- Rabbit's clock is authoritative.
 *   * Reconnect backoff is exactly 500ms -> 1s -> 2s -> 4s -> 8s -> 10s with
 *     50%-100% jitter, matching DSH's own behaviour so it is predictable.
 */

import { Readable } from 'node:stream';
import { access, constants as fsConstants } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import {
  EMPTY_SHA256,
  classifyExit,
  normalizeOutput,
  runArgv,
  sha256Hex,
} from './exec.mjs';
import {
  FINGERPRINT_ALGO,
  WARN_DIRTY_WORKTREE,
  WARN_FINGERPRINT_UNAVAILABLE,
  collectPostState,
  collectPreAnchors,
  commandHash,
  envelopeSha256,
  gitVersion,
  normalizeRelPath,
  resolveProjectCwd,
} from './git.mjs';
import { createSpool } from './spool.mjs';

/** Wire protocol version (§1). */
export const PROTOCOL_VERSION = 1;

/** Envelope schema version (§5.1). */
export const ENVELOPE_VERSION = '1.0';

/** v0.0.1 only ever executes directly (§5.1). */
export const SHELL_ID = 'direct-exec';

/** Reconnect backoff ladder, exactly as specified in task-8 / §3. */
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

/** Lease renewal cadence (§4.3). */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Default task timeout when the offer does not carry one. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Refusal reason codes this agent can produce. */
export const REFUSAL = {
  COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',
  PLATFORM_MISMATCH: 'PLATFORM_MISMATCH',
  READ_ONLY_MACHINE: 'READ_ONLY_MACHINE',
  CWD_OUTSIDE_PROJECT: 'CWD_OUTSIDE_PROJECT',
  INVALID_OFFER: 'INVALID_OFFER',
};

/** Required envelope fields (§5.1). Missing any one makes a result unverifiable. */
export const REQUIRED_ENVELOPE_FIELDS = [
  'envelope_version',
  'task_id',
  'attempt',
  'dedupe_key',
  'machine_id',
  'machine_name',
  'platform',
  'caps',
  'index',
  'index_total',
  'mode',
  'cwd_rel',
  'base_commit',
  'base_tree',
  'pre_tree_fingerprint',
  'post_tree_fingerprint',
  'fingerprint_algo',
  'fingerprint_error',
  'head_commit',
  'dirty_before',
  'command_argv',
  'command_hash',
  'shell_id',
  'started_at',
  'ended_at',
  'duration_ms',
  'exit_code',
  'status',
  'refusal_reason',
  'stdout_sha256',
  'stdout_bytes',
  'stderr_sha256',
  'stderr_bytes',
  'warnings',
  'envelope_sha256',
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** @param {number} ms @param {AbortSignal} [signal] */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Reconnect delay: the ladder position for `attempt`, jittered to 50%-100%.
 *
 * Jitter never exceeds the ladder value, so the sequence stays recognisable
 * (500 / 1000 / 2000 / 4000 / 8000 / 10000) while still de-synchronising
 * many clients that dropped at the same moment.
 *
 * @param {number} attempt 0-based reconnect attempt.
 * @param {() => number} [rand]
 * @returns {number} milliseconds
 */
export function backoffDelay(attempt, rand = Math.random) {
  const index = Math.max(0, Math.min(Math.trunc(attempt) || 0, BACKOFF_MS.length - 1));
  const base = BACKOFF_MS[index];
  const factor = 0.5 + Math.min(Math.max(rand(), 0), 1) * 0.5;
  return Math.round(base * factor);
}

// ---------------------------------------------------------------------------
// Command allow-list (default-deny)
// ---------------------------------------------------------------------------

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
 * Default-deny prefix match.
 *
 * `['node','--test']` is allowed by the prefix `node --test`, and so is
 * `['node','--test','--reporter=tap']`; `['node','-e','...']` and a bare
 * `['node']` are refused.
 *
 * @param {string[]} argv
 * @param {string[][]} prefixes
 * @returns {{allowed: boolean, prefix: string[]|null}}
 */
export function matchAllowedCommand(argv, prefixes) {
  if (!Array.isArray(argv) || argv.length === 0) return { allowed: false, prefix: null };
  for (const prefix of prefixes ?? []) {
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
    if (ok) return { allowed: true, prefix };
  }
  return { allowed: false, prefix: null };
}

// ---------------------------------------------------------------------------
// Capability gate (§6.1)
// ---------------------------------------------------------------------------

/** @param {string} value @returns {number[]} */
function versionParts(value) {
  return String(value)
    .trim()
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

/**
 * Compare two version strings numerically.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} -1, 0 or 1
 */
export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/** @param {number[]} a @param {number[]} b @param {number} length */
function samePrefix(a, b, length) {
  for (let i = 0; i < length; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return false;
  }
  return true;
}

/**
 * Semver-ish range check, deliberately small: `>=20`, `>=20 <22`, `^20.1`,
 * `~20`, `20`, `=20.1.0`, with `||` alternatives.
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function satisfiesVersion(version, range) {
  if (typeof range !== 'string' || range.trim() === '') return true;
  const current = versionParts(version);
  return range.split('||').some((alternative) => {
    const tokens = alternative.trim().split(/[\s,]+/).filter((token) => token !== '');
    if (tokens.length === 0) return true;
    return tokens.every((token) => {
      const match = token.match(/^(\^|~|>=|<=|==|=|>|<)?\s*(.+)$/);
      if (!match) return false;
      const op = match[1] ?? '';
      const target = versionParts(match[2]);
      switch (op) {
        case '>=':
          return compareVersions(version, match[2]) >= 0;
        case '<=':
          return compareVersions(version, match[2]) <= 0;
        case '>':
          return compareVersions(version, match[2]) > 0;
        case '<':
          return compareVersions(version, match[2]) < 0;
        case '^': {
          // `^20.1.0` means >=20.1.0 <21.0.0: the upper bound comes from the
          // *target's* major, not from the version being tested.
          const major = target[0] ?? 0;
          const upper = major > 0 ? [major + 1, 0, 0] : [0, (target[1] ?? 0) + 1, 0];
          return compareVersions(version, match[2]) >= 0 && compareVersions(version, upper.join('.')) < 0;
        }
        case '~': {
          const upper = [target[0] ?? 0, (target[1] ?? 0) + 1, 0];
          return compareVersions(version, match[2]) >= 0 && compareVersions(version, upper.join('.')) < 0;
        }
        default:
          // Bare version: prefix match (`20` matches 20.9.1, not 21.0.0).
          return samePrefix(current, target, target.length);
      }
    });
  });
}

/**
 * Evaluate §6.1 for one machine.
 *
 * Toolchain lookups consult `caps` first and fall back to `toolchain`, because
 * the contract's `caps` object only carries `python`/`npm`/`node` -- a task
 * requiring e.g. `toolchain: {git: ">=2"}` would otherwise be refused as
 * `MISSING_GIT` on a machine that has git installed.
 *
 * @param {object} offer
 * @param {object} context
 * @param {Record<string, string|null>} context.caps
 * @param {{os: string}} context.platform
 * @param {boolean} context.writable False when the machine cannot write.
 * @param {Record<string, string|null>} [context.toolchain] Extra detected tools.
 * @returns {{ok: boolean, refusal_reason: string|null, detail: string|null}}
 */
export function evaluateGate(offer, context) {
  const requirements = offer?.requirements ?? {};
  const toolchain = requirements.toolchain ?? {};
  for (const [tool, range] of Object.entries(toolchain)) {
    const have = context.caps?.[tool] ?? context.toolchain?.[tool] ?? null;
    if (have === null) {
      return { ok: false, refusal_reason: `MISSING_${tool.toUpperCase()}`, detail: `${tool} not installed` };
    }
    if (typeof range !== 'string') {
      return {
        ok: false,
        refusal_reason: `MISSING_${tool.toUpperCase()}`,
        detail: `unusable toolchain constraint for ${tool}`,
      };
    }
    if (!satisfiesVersion(have, range)) {
      return {
        ok: false,
        refusal_reason: `MISSING_${tool.toUpperCase()}`,
        detail: `${tool} ${have} does not satisfy ${range}`,
      };
    }
  }
  const platforms = requirements.platform;
  if (Array.isArray(platforms) && platforms.length > 0 && !platforms.includes(context.platform?.os)) {
    return {
      ok: false,
      refusal_reason: REFUSAL.PLATFORM_MISMATCH,
      detail: `this machine is ${context.platform?.os}`,
    };
  }
  if (offer?.write === true && context.writable === false) {
    return { ok: false, refusal_reason: REFUSAL.READ_ONLY_MACHINE, detail: 'project is not writable' };
  }
  return { ok: true, refusal_reason: null, detail: null };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/**
 * Incremental SSE frame parser (§3.1).
 *
 * Handles frames split across chunks, CRLF, multi-line `data:`, and comment
 * keepalives (`: keepalive`), which must not be mistaken for events.
 */
export class SseParser {
  constructor() {
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.id = null;
  }

  /**
   * Feed decoded text, get whatever complete events it produced.
   *
   * @param {string} chunk
   * @returns {Array<{event: string, data: string, id: string|null}>}
   */
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        if (this.data.length > 0) {
          events.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
        }
        this.event = '';
        this.data = [];
        this.id = null;
      } else if (line.startsWith(':')) {
        // keepalive / comment
      } else {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
        else if (field === 'id') this.id = value;
      }
      index = this.buffer.indexOf('\n');
    }
    return events;
  }
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Attach `envelope_sha256` (§5.1: JCS hash of the envelope without it).
 *
 * @param {object} envelope
 * @returns {object}
 */
export function buildEnvelope(envelope) {
  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (field === 'envelope_sha256') continue;
    if (!(field in envelope)) {
      throw new TypeError(`envelope is missing required field: ${field}`);
    }
  }
  return { ...envelope, envelope_sha256: envelopeSha256(envelope) };
}

/**
 * Verify a received envelope's `envelope_sha256`.
 *
 * @param {object} envelope
 * @returns {boolean}
 */
export function verifyEnvelope(envelope) {
  if (!envelope || typeof envelope.envelope_sha256 !== 'string') return false;
  return envelopeSha256(envelope) === envelope.envelope_sha256;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Lease heartbeat (§4.3). `phase` moves preparing -> running -> finalizing and
 * the response's `cancel` flag is honoured by aborting the running command.
 */
export class Heartbeat {
  /**
   * @param {object} options
   * @param {(body: object) => Promise<object|null>} options.send
   * @param {string} options.taskId
   * @param {string} options.machineId
   * @param {number} options.attempt
   * @param {number} [options.intervalMs]
   * @param {(error: unknown) => void} [options.onError]
   * @param {() => void} [options.onCancel]
   */
  constructor(options) {
    this.send = options.send;
    this.taskId = options.taskId;
    this.machineId = options.machineId;
    this.attempt = options.attempt;
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.onError = options.onError ?? (() => {});
    this.onCancel = options.onCancel ?? (() => {});
    this.phase = 'preparing';
    this.progress = 0;
    this.ticks = 0;
    this.timer = null;
    this.cancelled = false;
  }

  /** @param {'preparing'|'running'|'finalizing'} phase @param {number} [progress] */
  setPhase(phase, progress) {
    this.phase = phase;
    if (typeof progress === 'number') this.progress = progress;
  }

  /** Send one heartbeat; returns the decoded response. */
  async tick() {
    this.ticks += 1;
    try {
      const response = await this.send({
        task_id: this.taskId,
        machine_id: this.machineId,
        attempt: this.attempt,
        phase: this.phase,
        progress: this.progress,
      });
      if (response && response.cancel === true) {
        this.cancelled = true;
        this.onCancel();
      }
      return response;
    } catch (error) {
      this.onError(error);
      return null;
    }
  }

  start() {
    if (this.timer) return this;
    // Fire once immediately so Rabbit learns about the claim without waiting a
    // full interval, then keep the lease warm.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AgentOptions
 * @property {string} rabbitUrl Base URL, e.g. `http://127.0.0.1:8787`.
 * @property {string} project Absolute project root.
 * @property {string} stateDir Directory for spool/state (never the project).
 * @property {object} identity `{machine_id, machine_name, device_token, rabbit_url}`.
 * @property {Record<string, unknown>} caps
 * @property {{os: string, os_version: string, arch: string, shell: string, shell_version: string|null}} platform
 * @property {string[][]} [allowedCommands]
 * @property {boolean} [once]
 * @property {(level: string, message: string, extra?: object) => void} [log]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [heartbeatIntervalMs]
 * @property {number} [maxOutputBytes]
 * @property {'temp'|'project'} [objectMode]
 * @property {string} [tmpDir]
 * @property {number} [onceIdleMs]
 * @property {number} [resultRetries]
 */

/**
 * Build an agent instance.
 *
 * @param {AgentOptions} options
 */
export function createAgent(options) {
  const {
    rabbitUrl,
    project,
    stateDir,
    identity,
    caps,
    platform,
    once = false,
    fetchImpl = globalThis.fetch,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    maxOutputBytes,
    objectMode = 'temp',
    tmpDir,
    onceIdleMs = 0,
    resultRetries = 4,
  } = options;

  // Normalise here so every caller gets the same contract: the documented
  // `string | string[][]` form is accepted, and a bare string list such as
  // `['node --test']` cannot reach `.map((prefix) => prefix.join(' '))`.
  const allowedCommands = parseAllowedCommands(options.allowedCommands ?? []);

  if (!rabbitUrl) throw new TypeError('createAgent: rabbitUrl is required');
  if (!project) throw new TypeError('createAgent: project is required');
  if (!stateDir) throw new TypeError('createAgent: stateDir is required');
  if (!identity?.machine_id) throw new TypeError('createAgent: identity.machine_id is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('createAgent: no fetch implementation available');

  const log = options.log ?? (() => {});
  const spool = createSpool(stateDir);

  const state = {
    seq: 0,
    connected: false,
    handled: 0,
    stopped: false,
    /** @type {object|null} */
    current: null,
  };

  /** @type {object[]} */
  const queue = [];
  /**
   * Recently delivered envelopes, keyed by `dedupe_key#attempt`.
   *
   * Rabbit's idempotency triple is `(machine_id, dedupe_key, attempt)`, so:
   *
   *   * a **transport** re-delivery of the same attempt is answered from this
   *     cache (or the spool) instead of being executed twice;
   *   * a **new attempt** for the same `dedupe_key` is a genuine retry and must
   *     run again -- §4.4 keeps `attempt` out of `dedupe_key` for exactly that
   *     reason, and replaying the old envelope would leave the new lease
   *     without a result of its own.
   *
   * Bounded and memory-only: after a restart Rabbit's own accounting is the
   * backstop.
   *
   * @type {Map<string, object>}
   */
  const completed = new Map();
  const COMPLETED_CACHE_LIMIT = 64;
  let pumping = false;
  let streamAbort = null;
  let runAbort = null;
  /** @type {Heartbeat|null} */
  let heartbeat = null;
  let backoffAttempt = 0;

  /**
   * @param {string|null|undefined} dedupeKey
   * @param {number} attempt
   * @returns {string|null}
   */
  const cacheKeyFor = (dedupeKey, attempt) =>
    dedupeKey ? `${dedupeKey}#${Number(attempt) || 1}` : null;

  /** @param {string|null} key @param {object} envelope */
  function rememberCompleted(key, envelope) {
    if (!key) return;
    completed.delete(key);
    completed.set(key, envelope);
    while (completed.size > COMPLETED_CACHE_LIMIT) {
      const oldest = completed.keys().next().value;
      completed.delete(oldest);
    }
  }

  const token = () => identity.device_token;

  /** Detected tool versions, resolved once per process (git needs a spawn). */
  let toolchainCache = null;
  async function toolchainInfo() {
    if (toolchainCache) return toolchainCache;
    let git = null;
    try {
      git = await gitVersion({ cwd: project });
    } catch {
      git = null;
    }
    toolchainCache = {
      node: caps.node ?? null,
      python: caps.python ?? null,
      npm: caps.npm ?? null,
      git,
    };
    return toolchainCache;
  }

  // -- HTTP helpers --------------------------------------------------------

  /** @param {string} path @returns {string} */
  const url = (path) => new URL(path, rabbitUrl).toString();

  /**
   * POST JSON and decode the response body.
   *
   * @param {string} path
   * @param {object} body
   * @param {{auth?: boolean}} [opts]
   */
  async function postJson(path, body, opts = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (opts.auth !== false && token()) headers.authorization = `Bearer ${token()}`;
    const response = await fetchImpl(url(path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, json, text };
  }

  /** @param {string} path @param {object} body @param {number} [retries] */
  async function postJsonWithRetry(path, body, retries = resultRetries) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (state.stopped) break;
      try {
        const response = await postJson(path, body);
        if (response.ok) return response;
        if (response.status >= 400 && response.status < 500) return response; // permanent
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < retries) await sleep(backoffDelay(attempt));
    }
    if (lastError) log('warn', `${path} failed`, { error: lastError.message });
    return null;
  }

  // -- Pairing -------------------------------------------------------------

  /**
   * Exchange a one-time pairing code for a device token (§2.2).
   *
   * @param {string} pairingCode
   * @param {string} [userId]
   */
  async function pair(pairingCode, userId) {
    const body = {
      pairing_code: pairingCode,
      machine_id: identity.machine_id,
      machine_name: identity.machine_name,
      platform,
      caps,
    };
    if (userId) body.user_id = userId;
    const response = await postJson('/v1/pair', body, { auth: false });
    if (!response.ok) {
      const code = response.json?.error?.code ?? `HTTP_${response.status}`;
      const error = new Error(`pairing failed: ${code} ${response.json?.error?.message ?? ''}`.trim());
      error.code = code;
      throw error;
    }
    const version = response.json?.protocol_version;
    if (version !== undefined && version !== PROTOCOL_VERSION) {
      const error = new Error(
        `protocol mismatch: Rabbit speaks ${version}, this agent speaks ${PROTOCOL_VERSION}`,
      );
      error.code = 'PROTOCOL_MISMATCH';
      throw error;
    }
    if (typeof response.json?.device_token !== 'string' || response.json.device_token === '') {
      const error = new Error('pairing response carried no device_token');
      error.code = 'PAIRING_RESPONSE_INVALID';
      throw error;
    }
    identity.device_token = response.json.device_token;
    identity.rabbit_url = rabbitUrl;
    log('info', 'paired', { machine_id: identity.machine_id });
    return response.json;
  }

  // -- Spool flushing ------------------------------------------------------

  /** Resend envelopes that were written but never acknowledged. */
  async function flushSpool() {
    const pending = spool.pendingResults();
    if (pending.length === 0) return 0;
    log('info', `resending ${pending.length} spooled result(s)`);
    let sent = 0;
    for (const record of pending) {
      if (state.stopped) break;
      const response = await postJson('/v1/result', record.envelope);
      if (response.ok) {
        spool.ack({ task_id: record.task_id, attempt: record.attempt });
        sent += 1;
      } else {
        log('warn', `spooled result ${record.task_id} still undelivered`, {
          status: response.status,
        });
      }
    }
    return sent;
  }

  /** Warn about entries that were claimed but never finished (a crash). */
  function reportInterrupted() {
    const interrupted = spool.interruptedTasks();
    for (const record of interrupted) {
      log('warn', `interrupted task left in spool (not replayed automatically)`, {
        task_id: record.task_id,
        attempt: record.attempt,
      });
    }
    return interrupted.length;
  }

  // -- Envelope assembly ---------------------------------------------------

  /**
   * Turn a finished (or refused) run into a complete §5.1 envelope.
   *
   * @param {object} context
   */
  function makeEnvelope(context) {
    const {
      offer,
      cwdRel,
      commandArgv,
      anchorsBefore,
      anchorsAfter,
      execution,
      status,
      refusalReason,
      warnings,
      startedAt,
      endedAt,
      toolchain,
      comparePolicy,
    } = context;

    const stdout = execution?.stdout ?? Buffer.alloc(0);
    const stderr = execution?.stderr ?? Buffer.alloc(0);
    const normalized = normalizeOutput(stdout, comparePolicy ?? {});

    const envelope = {
      envelope_version: ENVELOPE_VERSION,
      task_id: offer.task_id,
      attempt: Number(offer.attempt) || 1,
      dedupe_key: offer.dedupe_key ?? '',
      machine_id: identity.machine_id,
      machine_name: identity.machine_name,
      platform,
      caps,
      index: Number.isInteger(offer.index) ? offer.index : 0,
      index_total: Number.isInteger(offer.index_total) ? offer.index_total : 1,
      mode: offer.mode ?? 'replicate',
      cwd_rel: normalizeRelPath(cwdRel),
      base_commit: offer.base_commit ?? anchorsBefore?.head_commit ?? '',
      base_tree: offer.base_tree ?? null,
      pre_tree_fingerprint: anchorsBefore?.pre_tree_fingerprint ?? null,
      post_tree_fingerprint: anchorsAfter?.post_tree_fingerprint ?? null,
      fingerprint_algo: FINGERPRINT_ALGO,
      fingerprint_error: anchorsBefore?.fingerprint_error ?? null,
      head_commit: anchorsAfter?.head_commit ?? anchorsBefore?.head_commit ?? null,
      dirty_before: anchorsBefore?.dirty_before === true,
      command_argv: commandArgv,
      command_hash: commandHash(commandArgv, SHELL_ID, cwdRel),
      shell_id: SHELL_ID,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: execution?.duration_ms ?? 0,
      exit_code: execution ? execution.exit_code : null,
      status,
      refusal_reason: refusalReason ?? null,
      stdout_sha256: execution ? execution.stdout_sha256 : EMPTY_SHA256,
      stdout_bytes: execution ? execution.stdout_bytes : 0,
      stderr_sha256: execution ? execution.stderr_sha256 : EMPTY_SHA256,
      stderr_bytes: execution ? execution.stderr_bytes : 0,
      warnings,
      // Optional fields (§5.2): present on both machines for the same task, so
      // they stay comparable; head/tail are informational only.
      stdout_normalized_sha256: sha256Hex(normalized),
      stdout_head: execution?.stdout_head ?? '',
      stdout_tail: execution?.stdout_tail ?? '',
      stderr_head: execution?.stderr_head ?? '',
      stderr_tail: execution?.stderr_tail ?? '',
      untracked: anchorsAfter?.untracked ?? anchorsBefore?.untracked ?? [],
      diff_numstat: anchorsAfter?.diff_numstat ?? [],
      toolchain: toolchain ?? null,
    };
    if (execution?.signal) envelope.signal = execution.signal;
    if (offer.write === true) envelope.write = true;
    return buildEnvelope(envelope);
  }

  // -- Task handling -------------------------------------------------------

  /** @param {object} offer */
  function validateOffer(offer) {
    if (!offer || typeof offer !== 'object') return 'NOT_AN_OBJECT';
    if (typeof offer.task_id !== 'string' || offer.task_id === '') return 'MISSING_TASK_ID';
    if (!Array.isArray(offer.command_argv) || offer.command_argv.length === 0) return 'MISSING_COMMAND_ARGV';
    if (!offer.command_argv.every((part) => typeof part === 'string')) return 'COMMAND_ARGV_NOT_STRINGS';
    if (offer.index !== undefined && !Number.isInteger(offer.index)) return 'INDEX_NOT_INTEGER';
    return null;
  }

  /**
   * The full lifecycle of one offer.
   *
   * @param {object} offer
   */
  async function handleOffer(offer) {
    const problem = validateOffer(offer);
    if (problem) {
      log('error', `ignoring malformed offer: ${problem}`, { offer });
      state.handled += 1;
      return;
    }

    const commandArgv = [...offer.command_argv];
    const cwdOutcome = resolveProjectCwd(project, offer.cwd_rel ?? '.');
    const cwdRel = cwdOutcome.ok ? cwdOutcome.cwd_rel : normalizeRelPath(offer.cwd_rel ?? '.');
    const controller = new AbortController();
    runAbort = controller;
    state.current = {
      task_id: offer.task_id,
      attempt: Number(offer.attempt) || 1,
      controller,
      key: cacheKeyFor(offer.dedupe_key, offer.attempt),
    };

    // ---- 1. spool before anything else (§0) ------------------------------
    spool.saveTask({
      task_id: offer.task_id,
      attempt: offer.attempt,
      dedupe_key: offer.dedupe_key,
      offer,
    });
    log('info', `offer ${offer.task_id} attempt ${offer.attempt ?? 1}`, {
      argv: commandArgv,
      cwd_rel: cwdRel,
      write: offer.write === true,
    });

    // ---- 2. lease heartbeat ---------------------------------------------
    heartbeat = new Heartbeat({
      send: (body) => postJson('/v1/heartbeat', body).then((response) => response.json),
      taskId: offer.task_id,
      machineId: identity.machine_id,
      attempt: Number(offer.attempt) || 1,
      intervalMs: heartbeatIntervalMs,
      onError: (error) => log('warn', 'heartbeat failed', { error: error.message }),
      onCancel: () => {
        log('warn', `Rabbit cancelled ${offer.task_id} via heartbeat`);
        controller.abort();
      },
    }).start();

    const startedAt = new Date().toISOString();
    const startedHr = process.hrtime.bigint();
    /** @type {string[]} */
    const warnings = [];

    try {
      // ---- 3. capability gate (§6.1) -------------------------------------
      const writable = offer.write === true ? await isWritableProject(project) : true;
      const gate = evaluateGate(offer, { caps, platform, writable, toolchain: await toolchainInfo() });

      // ---- 4. anchors ------------------------------------------------------
      const anchorsBefore = await safeAnchors(warnings);

      if (!gate.ok) {
        log('warn', `refused ${offer.task_id}: ${gate.refusal_reason}`, { detail: gate.detail });
        await finish({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore,
          anchorsAfter: null,
          execution: null,
          status: 'refused',
          refusalReason: gate.refusal_reason,
          warnings,
          startedAt,
          endedAt: new Date().toISOString(),
        });
        return;
      }

      // ---- 5. allow-list (default-deny) -----------------------------------
      const allowed = matchAllowedCommand(commandArgv, allowedCommands);
      if (!allowed.allowed) {
        log('warn', `refused ${offer.task_id}: COMMAND_NOT_ALLOWED`, { argv: commandArgv });
        await finish({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore,
          anchorsAfter: null,
          execution: null,
          status: 'refused',
          refusalReason: REFUSAL.COMMAND_NOT_ALLOWED,
          warnings,
          startedAt,
          endedAt: new Date().toISOString(),
        });
        return;
      }

      if (!cwdOutcome.ok) {
        log('warn', `refused ${offer.task_id}: ${cwdOutcome.reason}`, { cwd_rel: offer.cwd_rel });
        await finish({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore,
          anchorsAfter: null,
          execution: null,
          status: 'refused',
          refusalReason: cwdOutcome.reason,
          warnings,
          startedAt,
          endedAt: new Date().toISOString(),
        });
        return;
      }

      // ---- 6. execute ------------------------------------------------------
      heartbeat.setPhase('running', 50);
      const execution = await runArgv(commandArgv, {
        cwd: cwdOutcome.cwd,
        timeoutMs: Number.isFinite(offer.timeout_ms) ? offer.timeout_ms : DEFAULT_TIMEOUT_MS,
        maxOutputBytes,
        signal: controller.signal,
      });

      heartbeat.setPhase('finalizing', 90);
      for (const warning of execution.warnings) if (!warnings.includes(warning)) warnings.push(warning);
      if (execution.timed_out) log('warn', `${offer.task_id} timed out after ${offer.timeout_ms}ms`);
      if (execution.cancelled) log('warn', `${offer.task_id} was cancelled`);

      const anchorsAfter = await safeAnchors(warnings);
      const status = classifyExit(execution);

      await finish({
        offer,
        cwdRel,
        commandArgv,
        anchorsBefore,
        anchorsAfter,
        execution,
        status,
        refusalReason: null,
        warnings,
        startedAt,
        endedAt: new Date().toISOString(),
      });
    } catch (error) {
      // Never leave a claimed task unspooled: emit a crashed envelope so the
      // relay can account for it instead of waiting for a lease to expire.
      log('error', `error while handling ${offer.task_id}`, { error: error?.message ?? String(error) });
      try {
        const envelope = makeEnvelope({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore: null,
          anchorsAfter: null,
          execution: null,
          status: 'crashed',
          refusalReason: null,
          warnings: [...warnings, 'AGENT_ERROR'],
          startedAt,
          endedAt: new Date().toISOString(),
        });
        await deliver(envelope);
      } catch (nested) {
        log('error', 'could not even build a crashed envelope', {
          error: nested?.message ?? String(nested),
        });
      }
    } finally {
      heartbeat?.stop();
      heartbeat = null;
      runAbort = null;
      state.current = null;
      state.handled += 1;
      log('success', `task ${offer.task_id} complete`, {
        duration_ms: Math.round(Number(process.hrtime.bigint() - startedHr) / 1e6),
      });
    }
  }

  /** Collect anchors, converting failures into warnings instead of throws. */
  async function safeAnchors(warnings) {
    try {
      const anchors = await collectPreAnchors({
        cwd: project,
        tmpDir,
        objectMode,
      });
      if (anchors.fingerprint_error && !warnings.includes(WARN_FINGERPRINT_UNAVAILABLE)) {
        warnings.push(WARN_FINGERPRINT_UNAVAILABLE);
      }
      if (anchors.dirty_before === true && !warnings.includes(WARN_DIRTY_WORKTREE)) {
        warnings.push(WARN_DIRTY_WORKTREE);
      }
      return anchors;
    } catch (error) {
      warnings.push(WARN_FINGERPRINT_UNAVAILABLE);
      log('warn', 'could not collect anchors', { error: error?.message ?? String(error) });
      return {
        head_commit: null,
        head_tree: null,
        pre_tree_fingerprint: null,
        fingerprint_error: 'ANCHOR_COLLECTION_FAILED',
        fingerprint_error_detail: error?.message ?? String(error),
        dirty_before: null,
        untracked: [],
      };
    }
  }

  /** Post-run state, converted the same way. */
  async function safePostState(offer, warnings) {
    try {
      return await collectPostState({
        cwd: project,
        base: offer.base_commit ?? undefined,
        tmpDir,
        objectMode,
      });
    } catch (error) {
      warnings.push(WARN_FINGERPRINT_UNAVAILABLE);
      log('warn', 'could not collect post-state', { error: error?.message ?? String(error) });
      return {
        head_commit: null,
        post_tree_fingerprint: null,
        fingerprint_error: 'ANCHOR_COLLECTION_FAILED',
        untracked: [],
        diff_numstat: [],
      };
    }
  }

  /** Build, spool, send and acknowledge one envelope. */
  async function finish(context) {
    const anchorsAfter = context.anchorsAfter ?? (await safePostState(context.offer, context.warnings));
    const toolchain = await toolchainInfo();
    const envelope = makeEnvelope({
      ...context,
      anchorsAfter,
      toolchain,
      comparePolicy: context.offer.compare_policy,
    });
    await deliver(envelope);
    return envelope;
  }

  /** Spool -> POST -> ack (delete only after Rabbit confirms). */
  async function deliver(envelope) {
    spool.saveEnvelope({
      task_id: envelope.task_id,
      attempt: envelope.attempt,
      dedupe_key: envelope.dedupe_key,
      envelope,
    });
    const response = await postJsonWithRetry('/v1/result', envelope);
    if (response?.ok) {
      spool.ack({ task_id: envelope.task_id, attempt: envelope.attempt });
      // Keep the delivered envelope around (bounded) so a transport re-delivery
      // of this same attempt is answered instead of executed again.
      rememberCompleted(cacheKeyFor(envelope.dedupe_key, envelope.attempt), envelope);
      log('info', `result delivered for ${envelope.task_id}`, { status: envelope.status });
      return true;
    }
    log('warn', `result kept in spool for ${envelope.task_id}`, {
      status: response?.status ?? null,
    });
    return false;
  }

  // -- SSE -----------------------------------------------------------------

  /** Open the event stream and dispatch until it ends or we stop. */
  async function streamOnce() {
    const headers = { accept: 'text/event-stream' };
    if (token()) headers.authorization = `Bearer ${token()}`;
    if (state.seq > 0) headers['last-event-id'] = String(state.seq);
    const streamUrl = new URL('/v1/stream', rabbitUrl);
    streamUrl.searchParams.set('machine_id', identity.machine_id);
    if (state.seq > 0) streamUrl.searchParams.set('seq', String(state.seq + 1));

    const response = await fetchImpl(streamUrl.toString(), { headers, signal: streamAbort.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`stream HTTP ${response.status} ${body.slice(0, 200)}`.trim());
      error.code = `HTTP_${response.status}`;
      throw error;
    }
    if (!response.body) throw new Error('stream response had no body');

    state.connected = false;
    const decoder = new TextDecoder('utf-8');
    const parser = new SseParser();
    const source = Readable.fromWeb(response.body);

    for await (const chunk of source) {
      if (state.stopped) break;
      for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
        handleFrame(frame);
      }
    }
    state.connected = false;
  }

  /** @param {{event: string, data: string, id: string|null}} frame */
  function handleFrame(frame) {
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      log('warn', 'ignoring unparseable SSE frame', { event: frame.event, data: frame.data.slice(0, 120) });
      return;
    }
    const type = payload?.type ?? frame.event;
    if (Number.isInteger(payload?.seq)) state.seq = Math.max(state.seq, payload.seq);
    else if (frame.id && /^\d+$/.test(frame.id)) state.seq = Math.max(state.seq, Number(frame.id));

    switch (type) {
      case 'ready':
        // §3.1: nothing counts as connected before `ready` arrives.
        state.connected = true;
        backoffAttempt = 0;
        log('info', 'stream ready', {
          seq: payload.seq,
          protocol_version: payload.protocol_version,
          machine_id: payload.machine_id,
        });
        break;
      case 'task.offer':
        enqueue(payload);
        break;
      case 'task.cancel': {
        const taskId = payload.task_id;
        const index = queue.findIndex((item) => item.task_id === taskId);
        if (index !== -1) queue.splice(index, 1);
        if (state.current && state.current.task_id === taskId) {
          log('warn', `task.cancel for running ${taskId}: ${payload.reason ?? ''}`);
          state.current.controller.abort();
        } else {
          log('info', `task.cancel for idle ${taskId}`);
        }
        break;
      }
      case 'peer.hello':
        log('info', `peer online: ${payload.machine_name ?? payload.machine_id}`);
        break;
      case 'peer.bye':
        log('info', `peer offline: ${payload.machine_id} (${payload.reason ?? ''})`);
        break;
      case 'notice':
        log(payload.level === 'error' ? 'error' : 'info', `notice ${payload.code ?? ''}: ${payload.message ?? ''}`);
        break;
      case 'task.result':
        // Added by the relay after this contract was frozen: a result reached
        // Rabbit. Nothing to do here, but reporting it beats "unknown event".
        log('info', `result accepted for ${payload.task_id}`, {
          status: payload.status,
          deduped: payload.deduped === true,
        });
        break;
      default:
        log('info', `ignoring unknown event type ${type}`);
    }
  }

  /**
   * Queue an offer, unless we already have it.
   *
   * Dedupe by `dedupe_key` (§4.4): a re-delivery of a task we already finished
   * is answered from the spool instead of being executed a second time, which
   * matters for `write: true` offers.
   *
   * @param {object} offer
   */
  function enqueue(offer) {
    const attempt = Number(offer?.attempt) || 1;
    const key = cacheKeyFor(offer?.dedupe_key, attempt);
    const running = state.current;
    if (key && running && running.key === key) {
      log('info', `ignoring re-delivery of running task ${offer.task_id}`);
      return;
    }
    if (key && queue.some((item) => cacheKeyFor(item.dedupe_key, item.attempt) === key)) {
      log('info', `ignoring duplicate queued offer ${offer.task_id}`);
      return;
    }
    if (key) {
      const cached = completed.get(key);
      if (cached) {
        log('info', `dedupe hit: resending cached result for ${offer.task_id} attempt ${attempt}`);
        void deliver(cached);
        return;
      }
      const spooled = spool
        .pendingResults()
        .find(
          (record) =>
            record.envelope &&
            record.dedupe_key === offer.dedupe_key &&
            record.attempt === attempt,
        );
      if (spooled) {
        log('info', `dedupe hit: resending spooled result for ${offer.task_id} attempt ${attempt}`);
        void deliver(spooled.envelope);
        return;
      }
    }
    queue.push(offer);
    void pump();
  }

  /** Serial worker: one task at a time, in arrival order. */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !state.stopped) {
        const offer = queue.shift();
        try {
          await handleOffer(offer);
        } catch (error) {
          // A throw here must not kill the stream loop or wedge the queue.
          log('error', `unhandled failure in ${offer?.task_id ?? 'offer'}`, {
            error: error?.message ?? String(error),
          });
        }
        if (once) {
          stop();
          break;
        }
      }
    } finally {
      pumping = false;
    }
  }

  // -- Lifecycle -----------------------------------------------------------

  /** Stop the stream, the running command and the heartbeat. */
  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    heartbeat?.stop();
    runAbort?.abort();
    streamAbort?.abort();
  }

  /**
   * Run forever (or until `--once` has handled one task).
   *
   * @returns {Promise<void>}
   */
  async function start() {
    log('info', `localside ${identity.machine_name} (${identity.machine_id})`, {
      rabbit: rabbitUrl,
      project,
      state: stateDir,
      allowed_commands: allowedCommands.map((prefix) => prefix.join(' ')),
    });
    if (allowedCommands.length === 0) {
      log('warn', 'no --allowed-commands configured: every offer will be refused (default-deny)');
    }

    if (token()) {
      await flushSpool();
      reportInterrupted();
    } else {
      log('warn', 'no device_token yet: run with --pair <CODE> to pair');
    }

    let idleTimer = null;
    if (once && onceIdleMs > 0) {
      idleTimer = setTimeout(() => {
        if (state.handled === 0) {
          log('warn', `--once: no offer within ${onceIdleMs}ms, exiting`);
          stop();
        }
      }, onceIdleMs);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    }

    try {
      while (!state.stopped) {
        streamAbort = new AbortController();
        try {
          await streamOnce();
          // A clean end of stream is still a disconnect: reconnect, but do not
          // punish the server for it with a long delay.
          if (!state.stopped) {
            backoffAttempt = 0;
            log('warn', 'event stream closed by server; reconnecting');
          }
        } catch (error) {
          if (state.stopped) break;
          state.connected = false;
          const delay = backoffDelay(backoffAttempt);
          log('warn', `stream error: ${error?.message ?? String(error)}; retrying in ${delay}ms`, {
            attempt: backoffAttempt,
          });
          backoffAttempt += 1;
          await sleep(delay, undefined);
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      stop();
      log('info', 'localside stopped', { handled: state.handled });
    }
  }

  return {
    start,
    stop,
    pair,
    flushSpool,
    reportInterrupted,
    handleOffer,
    get state() {
      return state;
    },
    spool,
    identity,
    caps,
    platform,
    allowedCommands,
  };
}

/**
 * `true` when the project directory can be written to.
 *
 * `fs.access(..., W_OK)` is the honest cheap check available to us; it is not
 * a substitute for actually writing, but a read-only mount or a missing
 * directory both fail it, which is exactly the §6.1 `READ_ONLY_MACHINE` case.
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export async function isWritableProject(dir) {
  try {
    await access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
