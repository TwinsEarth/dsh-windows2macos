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
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
import { joinUrl, resolveBaseUrl } from './url.mjs';

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

/** Rolling window of heartbeat round-trip times kept for `w2m_status` (§8.2). */
export const RTT_WINDOW = 5;

/**
 * Largest round-trip time the agent will report to the relay (v0.3.0).
 *
 * A minute to answer a `POST /v1/heartbeat` is not a latency measurement any
 * more; it is a symptom (a stalled socket, a suspended laptop, a clock jump).
 * An out-of-range sample is **omitted rather than clamped**, because clamping
 * would publish a number nobody measured -- the relay's aggregate can tolerate
 * a missing sample, but not a fabricated one.
 */
export const MAX_HEARTBEAT_RTT_MS = 60_000;

/**
 * Idle diagnostic heartbeat cadence (v0.3.0).
 *
 * A machine with nothing to do is exactly the one an operator looks at -- "is
 * that Mac still up, and how far away is it?" -- while a lease heartbeat only
 * exists while a task does. Without this the relay's view of an idle machine
 * freezes at its last task, and a `rtt_stale` flag that is permanently true
 * reads like "the machine is there, just slow", which is worse than no value
 * at all.
 *
 * The request is explicitly marked `diagnostic: true`. That flag is what tells
 * the relay "touch no lease": a heartbeat that merely *lacks* `task_id` is
 * indistinguishable from one whose field was lost, and §0 forbids trading a
 * loud error for a quiet false success.
 */
export const IDLE_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * A stream that stayed up at least this long is considered healthy, so the
 * next reconnect starts from the bottom of the backoff ladder again.
 */
export const STABLE_STREAM_MS = 1000;

/**
 * Delay before reconnecting after a *healthy* stream ended (relay restart,
 * proxy idle timeout). Small but non-zero: reconnecting in a hot loop would
 * hammer a relay that is merely restarting, which is exactly the situation
 * v0.1.2 is about.
 */
export const RECONNECT_DELAY_AFTER_STABLE_MS = 500;

/**
 * Diagnostics file the agent publishes for *other processes* (task-16).
 *
 * §8.2 puts RTT on the agent's in-memory state, which only helps a plugin that
 * started the agent inside its own process. In a cross-region deployment the
 * agent is its own process, so the same numbers are mirrored to
 * `<stateDir>/agent-state.json`, which is what the plugin's `w2m_status` reads.
 */
export const AGENT_STATE_FILE = 'agent-state.json';

/** Schema version of {@link AGENT_STATE_FILE}. */
export const AGENT_STATE_SCHEMA_VERSION = 1;

/**
 * How often the diagnostics file is refreshed while the agent sits idle.
 *
 * Without this, `updated_at` only moves when a heartbeat or a connection change
 * happens -- so an idle-but-healthy agent would look frozen, and a reader could
 * not tell "running, nothing to do" from "killed an hour ago". Cheap: one small
 * atomic write per interval.
 */
export const AGENT_STATE_PUBLISH_INTERVAL_MS = 30_000;

/**
 * How many times a relay identity change may trigger an *immediate* cursor-less
 * re-attach before the agent falls back to the normal backoff ladder. A healthy
 * relay identifies itself once per stream, so more than a couple in a row means
 * something is wrong and hammering it would not help.
 */
export const MAX_IMMEDIATE_RESTART_RECONNECTS = 3;

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

/**
 * Summarise heartbeat round-trip samples for `state.rttMs` (§8.2).
 *
 * Exported so the shape the plugin reads through `w2m_status` is testable
 * without a live relay.
 *
 * @param {number[]} samples Round-trip times in milliseconds, oldest first.
 * @param {number} [window]
 * @returns {{last: number|null, avg: number|null, samples: number[]}}
 */
export function summarizeRtt(samples, window = RTT_WINDOW) {
  const kept = (Array.isArray(samples) ? samples : [])
    .filter((value) => Number.isFinite(value))
    .slice(-window)
    .map((value) => Math.round(value));
  if (kept.length === 0) return { last: null, avg: null, samples: [] };
  const avg = Math.round(kept.reduce((sum, value) => sum + value, 0) / kept.length);
  return { last: kept[kept.length - 1], avg, samples: kept };
}

/**
 * Decide whether the stored event cursor may be sent when attaching.
 *
 * A cursor is only meaningful to the relay process that issued it. `seq` is
 * per-process (v0.1.2 §8.3), so after a restart the new process numbers events
 * from 1 again: replaying `Last-Event-ID: 42` tells it we are already past
 * events 1..42 -- including the `task.offer` that landed at seq 1, which is
 * exactly the event the agent then waits forever for. The cursor therefore
 * travels with the `relay_id` that issued it, and is withheld whenever that
 * differs from the relay we are attaching to.
 *
 * Two cases must NOT be over-corrected:
 *   * a pre-v0.1.2 relay sends no `relay_id`, so there is nothing to compare
 *     against and the v1 behaviour (resume) is kept;
 *   * an unchanged `relay_id` must still resume, or every reconnect becomes a
 *     full replay.
 *
 * @param {{seq?: number, cursorRelayId?: string|null, relayId?: string|null}} cursor
 * @returns {boolean}
 */
export function cursorUsableFor({ seq, cursorRelayId = null, relayId = null } = {}) {
  if (!Number.isInteger(seq) || seq <= 0) return false;
  // No relay identity to compare against: keep the v1 resume behaviour.
  if (relayId === null || relayId === undefined) return true;
  // The relay identifies itself, so only a cursor it issued can be replayed.
  return cursorRelayId === relayId;
}

/**
 * Extra fields the heartbeat carries so a *remote* reader can see this
 * machine's link quality (v0.3.0): the relay stores them and exposes them
 * through its per-machine status endpoint, which is the only way a plugin on
 * another host can see the latency.
 *
 * Rules, all of them about not inventing data:
 *
 *   * `rtt_ms` is present **only** when a round trip was actually measured.
 *     Absence means "unknown"; `null` would be an extra shape for the relay to
 *     handle, and `0` would be read as "extremely fast", turning ignorance into
 *     a good score.
 *   * The value is a non-negative integer (`last` is already rounded), and a
 *     sample above {@link MAX_HEARTBEAT_RTT_MS} is dropped rather than clamped.
 *   * `unstable_reconnects` is always sent: it is a counter the agent owns, and
 *     its absence would be indistinguishable from zero.
 *
 * `unstable_reconnects` deliberately does **not** reuse the name
 * `reconnect_attempts`: the relay publishes its own `reconnect_attempts`
 * (attaches - 1, see `src/relay/state.mjs`), and two different quantities under
 * one name would make "this link is flapping right now" and "this machine has
 * reconnected N times in total" look like the same fact. The relay's count is
 * authoritative during a crash (it keeps counting); this one is the only thing
 * that can say the link is unstable *at the moment*.
 *
 * The local file channel keeps working in parallel -- same numbers, different
 * failure modes: it is faster on the same host and still correct when the relay
 * is unreachable, while this one is the only channel that crosses machines.
 *
 * @param {{rttMs?: {last: number|null}|null, reconnectAttempts?: number|null}} snapshot
 *   `reconnectAttempts` is the in-process counter (also exposed as
 *   `state.unstableReconnects`); it is published as `unstable_reconnects`.
 * @param {{maxRttMs?: number}} [options]
 * @returns {Record<string, number>}
 */
export function heartbeatDiagnostics(snapshot = {}, options = {}) {
  const maxRttMs = options.maxRttMs ?? MAX_HEARTBEAT_RTT_MS;
  /** @type {Record<string, number>} */
  const extra = {};

  const last = snapshot?.rttMs?.last;
  if (typeof last === 'number' && Number.isFinite(last) && last >= 0 && last <= maxRttMs) {
    extra.rtt_ms = Math.round(last);
  }

  const attempts = snapshot?.reconnectAttempts;
  if (typeof attempts === 'number' && Number.isFinite(attempts) && attempts >= 0) {
    extra.unstable_reconnects = Math.trunc(attempts);
  }

  return extra;
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
   * @param {(ms: number) => void} [options.onRtt] Called with each successful round trip.
   * @param {() => object} [options.diagnostics] Extra body fields per heartbeat (v0.3.0).
   */
  constructor(options) {
    this.send = options.send;
    this.taskId = options.taskId;
    this.machineId = options.machineId;
    this.attempt = options.attempt;
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.onError = options.onError ?? (() => {});
    this.onCancel = options.onCancel ?? (() => {});
    this.onRtt = options.onRtt ?? (() => {});
    this.diagnostics = options.diagnostics ?? null;
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

  /**
   * The body of one heartbeat, including whatever diagnostics the caller
   * supplies.
   *
   * @returns {object}
   */
  heartbeatBody() {
    const body = {
      task_id: this.taskId,
      machine_id: this.machineId,
      attempt: this.attempt,
      phase: this.phase,
      progress: this.progress,
    };
    if (this.diagnostics) {
      try {
        Object.assign(body, this.diagnostics() ?? {});
      } catch {
        // A broken diagnostics provider must never cost us the lease renewal:
        // the heartbeat's job is to keep the task alive, and the extra fields
        // are exactly that -- extra.
      }
    }
    return body;
  }

  /** Send one heartbeat; returns the decoded response. */
  async tick() {
    this.ticks += 1;
    const startedHr = process.hrtime.bigint();
    try {
      const response = await this.send(this.heartbeatBody());
      // Measured on success only: a timeout is not a round-trip time, and
      // folding it in would make "latency to the relay" look catastrophic.
      this.onRtt(Number(process.hrtime.bigint() - startedHr) / 1e6);
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
 * @property {string} rabbitUrl Base address; a sub-path is allowed
 *   (`https://host/w2m`), a query string or fragment is rejected. See ./url.mjs.
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
 * @property {number} [statePublishIntervalMs] Idle refresh cadence for the
 *   diagnostics file; 0 disables it (task-16).
 * @property {string|null} [operatorToken] Only needed when this host submits
 *   tasks itself (v0.1.2 §5); never sent by the Localside agent.
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
    operatorToken = null,
    statePublishIntervalMs = AGENT_STATE_PUBLISH_INTERVAL_MS,
    idleHeartbeatIntervalMs = IDLE_HEARTBEAT_INTERVAL_MS,
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

  // Validate + normalise once, at construction: a `rabbitUrl` carrying a query
  // string, a fragment or a non-http scheme must fail loudly here rather than
  // turn into mysterious 404s at request time. Sub-paths are preserved.
  const baseUrl = resolveBaseUrl(rabbitUrl);

  const log = options.log ?? (() => {});
  const spool = createSpool(stateDir);

  /**
   * Absolute path of the cross-process diagnostics file (task-16).
   *
   * Deliberately under `stateDir` (the `--state` directory), not next to
   * `device.json`: the spool, the state and this file belong together, and a
   * read-only project must never be written to.
   */
  const stateFilePath = join(stateDir, AGENT_STATE_FILE);
  let statePublishWarned = false;

  const state = {
    seq: 0,
    connected: false,
    handled: 0,
    stopped: false,
    /** `relay_id` of the relay we are currently talking to (v0.1.2 §8.3). */
    relayId: null,
    /**
     * `relay_id` that issued `state.seq`, or null when the cursor cannot be
     * attributed to a relay process (pre-v0.1.2 relay, or none yet).
     */
    cursorRelayId: null,
    /**
     * Set when a relay restart makes the *current* stream unusable: it was
     * opened with the previous process's cursor, so it has already skipped the
     * new process's early events and must be replaced.
     */
    streamRestartRequested: false,
    /** How many times a relay restart was detected. */
    relayIdChanges: 0,
    /** Last `REPLAY_TRUNCATED` notice we had to act on (v0.1.2 §8.4). */
    replayTruncated: null,
    /** Rolling heartbeat round-trip times, read by `w2m_status` (§8.2). */
    rttMs: summarizeRtt([]),
    /**
     * Consecutive unstable reconnects: 0 once a stream has stayed up for
     * {@link STABLE_STREAM_MS}, incremented for each reconnect before that.
     *
     * Published as `unstable_reconnects` in both channels (the heartbeat and
     * `agent-state.json`) so they agree by construction. The JavaScript property
     * keeps the shorter historical name because `scripts/probe-restart.mjs`
     * reads it; `unstableReconnects` is the same value under the published name.
     */
    get reconnectAttempts() {
      return reconnectAttempt;
    },
    /** Alias of {@link reconnectAttempts}, spelled like the published field. */
    get unstableReconnects() {
      return reconnectAttempt;
    },
    /** Path of the published diagnostics file. */
    stateFile: stateFilePath,
    /** `updated_at` of the last successful publish, or null. */
    statePublishedAt: null,
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
  /** Consecutive unstable reconnects; drives the backoff ladder (§8.1). */
  let reconnectAttempt = 0;
  /**
   * Consecutive immediate re-attaches caused by a relay identity change. Capped
   * so a relay that cannot keep a stable identity degrades to plain backoff
   * instead of a hot loop.
   */
  let restartReconnects = 0;
  /**
   * What the current stream was opened with, so `ready` can tell whether the
   * events on it are complete. `seq: null` means no cursor was sent, i.e. this
   * stream starts from the relay's own beginning and is never "tainted".
   *
   * @type {{seq: number|null, attributionRelayId: string|null}}
   */
  let attachInfo = { seq: null, attributionRelayId: null };
  /** @type {NodeJS.Timeout|null} Idle refresh of the diagnostics file. */
  let statePublishTimer = null;
  /** @type {NodeJS.Timeout|null} Idle diagnostic heartbeat (v0.3.0). */
  let idleHeartbeatTimer = null;

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

  // -- Cross-process diagnostics file (task-16) ----------------------------

  /**
   * Snapshot published to `<stateDir>/agent-state.json`.
   *
   * An allow-list, not a spread of internal state: the plugin reads this
   * cross-process, so the only safe rule is that a field must be named here to
   * exist. No token -- device or operator -- can ever appear, because neither
   * is referenced.
   *
   * @returns {object}
   */
  function agentStateSnapshot() {
    return {
      schema_version: AGENT_STATE_SCHEMA_VERSION,
      machine_id: identity.machine_id,
      machine_name: identity.machine_name ?? null,
      updated_at: new Date().toISOString(),
      connected: state.connected === true,
      relay_id: state.relayId ?? null,
      rttMs: {
        last: state.rttMs.last,
        avg: state.rttMs.avg,
        samples: [...state.rttMs.samples],
      },
      // Named to match the heartbeat field (and to stay distinct from the
      // relay's own `reconnect_attempts`, which answers a different question).
      unstable_reconnects: reconnectAttempt,
      replay_truncated: state.replayTruncated !== null,
    };
  }

  /**
   * Atomically publish the snapshot: temp file in the same directory, then
   * rename, so a reader never sees half a JSON document.
   *
   * Never throws. A full disk or a state directory that vanished must not take
   * the agent (or a running task) down -- the file is a diagnostic, not a
   * delivery guarantee -- so failure is logged once and otherwise ignored.
   *
   * @returns {object|null} The snapshot written, or null when the write failed.
   */
  function publishState() {
    const snapshot = agentStateSnapshot();
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${stateFilePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, stateFilePath);
      state.statePublishedAt = snapshot.updated_at;
      statePublishWarned = false;
      return snapshot;
    } catch (error) {
      if (!statePublishWarned) {
        statePublishWarned = true;
        log('warn', `could not publish ${AGENT_STATE_FILE} (diagnostics only; continuing)`, {
          path: stateFilePath,
          error: error?.message ?? String(error),
        });
      }
      return null;
    }
  }

  const token = () => identity.device_token;

  /**
   * Fold one heartbeat round trip into the rolling window (§8.2).
   *
   * Exposed as `state.rttMs` for `w2m_status`; deliberately *not* added to the
   * result envelope, which must stay comparable across machines.
   *
   * @param {number} ms
   */
  function recordRtt(ms) {
    state.rttMs = summarizeRtt([...state.rttMs.samples, ms]);
    // Publish on every successful heartbeat: this is the moment the numbers a
    // remote operator cares about actually changed (task-16).
    publishState();
  }

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

  /**
   * @param {string} path
   * @returns {string}
   */
  const url = (path) => joinUrl(baseUrl, path);

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
    identity.rabbit_url = baseUrl;
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
    // Fail closed: if the durable copy cannot be written, running the command
    // would produce a result we could never replay, so the offer is dropped
    // with an explicit reason instead of executing unspooled. This also keeps
    // `state.current` from being left pointing at a task that never started.
    try {
      spool.saveTask({
        task_id: offer.task_id,
        attempt: offer.attempt,
        dedupe_key: offer.dedupe_key,
        offer,
      });
    } catch (error) {
      log('error', `could not spool ${offer.task_id}; not running it (spool-first, §0)`, {
        error: error?.message ?? String(error),
      });
      runAbort = null;
      state.current = null;
      state.handled += 1;
      return;
    }
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
      onRtt: recordRtt,
      // v0.3.0: the same numbers the local file carries, sent to the relay so a
      // plugin on another machine can see them.
      diagnostics: () =>
        heartbeatDiagnostics({
          rttMs: state.rttMs,
          reconnectAttempts: state.reconnectAttempts,
        }),
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
    // Decide *before* connecting whether the cursor may be replayed: sending a
    // stale one is what makes a restarted relay believe we are already caught
    // up (task-18). Built by concatenation so a relay mounted under a sub-path
    // (https://host/w2m) keeps its prefix -- see ./url.mjs.
    const resume = cursorUsableFor({
      seq: state.seq,
      cursorRelayId: state.cursorRelayId,
      relayId: state.relayId,
    });
    const query = new URLSearchParams();
    query.set('machine_id', identity.machine_id);
    if (resume) {
      headers['last-event-id'] = String(state.seq);
      query.set('seq', String(state.seq + 1));
    }
    // Remembered so `ready` can decide whether this stream is trustworthy.
    attachInfo = { seq: resume ? state.seq : null, attributionRelayId: resume ? state.cursorRelayId : null };
    log('info', 'attaching to event stream', {
      from_seq: resume ? state.seq + 1 : null,
      cursor: resume ? state.seq : null,
      cursor_relay_id: resume ? state.cursorRelayId : null,
      relay_id: state.relayId,
      withheld_cursor: !resume && state.seq > 0,
    });
    const streamUrl = joinUrl(baseUrl, `/v1/stream?${query.toString()}`);

    const response = await fetchImpl(streamUrl, { headers, signal: streamAbort.signal });
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
    publishState();
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
      case 'ready': {
        // §3.1: nothing counts as connected before `ready` arrives.
        state.connected = true;
        const relayId =
          typeof payload.relay_id === 'string' && payload.relay_id !== '' ? payload.relay_id : null;
        const previousRelayId = state.relayId;
        // A stream is only "tainted" when it was opened *with* a cursor that
        // this relay process never issued. Such a stream has already skipped
        // everything the process emitted before `ready` -- including the
        // `task.offer` at seq 1 -- so it must be dropped and re-attached
        // cursor-less (task-18). A stream opened without a cursor has seen
        // everything from the start and is kept: reconnecting there would be
        // pure churn.
        const tainted =
          attachInfo.seq !== null && relayId !== null && attachInfo.attributionRelayId !== relayId;
        if (tainted) {
          state.relayIdChanges += previousRelayId !== null && previousRelayId !== relayId ? 1 : 0;
          state.seq = 0;
          state.cursorRelayId = null;
          state.relayId = relayId;
          state.streamRestartRequested = true;
          log('warn', `relay restarted (relay_id ${previousRelayId ?? '<unknown>'} -> ${relayId}); discarding seq cursor and re-attaching without one`, {
            previous_relay_id: previousRelayId,
            relay_id: relayId,
            discarded_cursor: attachInfo.seq,
          });
          publishState();
          streamAbort?.abort();
          break;
        }
        if (relayId) state.relayId = relayId;
        // The cursor we hold was issued by this relay, so attribute it: that is
        // what lets a later restart be told apart from a plain reconnect.
        state.cursorRelayId = relayId ?? state.cursorRelayId;
        log('info', 'stream ready', {
          seq: payload.seq,
          protocol_version: payload.protocol_version,
          machine_id: payload.machine_id,
          relay_id: relayId,
        });
        // Connection state changed: make it visible to other processes.
        publishState();
        break;
      }
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
      case 'notice': {
        log(payload.level === 'error' ? 'error' : 'info', `notice ${payload.code ?? ''}: ${payload.message ?? ''}`);
        if (payload.code === 'REPLAY_TRUNCATED') {
          // v0.1.2 §8.4: the relay tells us the oldest seq it still holds, so we
          // can re-align instead of only learning that we missed events. The
          // cursor moves to `oldest_available_seq - 1` because the next connect
          // asks for `cursor + 1`.
          const oldest = payload.oldest_available_seq;
          if (Number.isInteger(oldest) && oldest >= 1) {
            state.replayTruncated = {
              at: new Date().toISOString(),
              oldest_available_seq: oldest,
              previous_seq: state.seq,
            };
            // A plain assignment, not a `max`: after a restart the new process
            // may hold a *smaller* window than the cursor we arrived with, and
            // aligning downward (even to 0) is the whole point. The aligned
            // cursor belongs to the relay that sent this notice.
            state.seq = oldest - 1;
            state.cursorRelayId = state.relayId ?? state.cursorRelayId;
            log('warn', `replay window truncated; seq cursor aligned to ${state.seq} (next connect asks for ${oldest})`, {
              oldest_available_seq: oldest,
              previous_seq: state.replayTruncated.previous_seq,
            });
            publishState();
          } else {
            log('warn', 'REPLAY_TRUNCATED without a usable oldest_available_seq; cursor left unchanged', {
              oldest_available_seq: oldest ?? null,
            });
          }
        }
        break;
      }
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

  /**
   * The idle diagnostic heartbeat (v0.3.0): `POST /v1/heartbeat` with
   * `diagnostic: true` and **no** `task_id`.
   *
   * Three properties matter, and each of them is a way this could go wrong:
   *
   *   1. It holds no lease, so nothing in the response may change local state.
   *      The body is deliberately not inspected -- not even `cancel`, which on a
   *      lease heartbeat means "stop the task". (A relay answering `cancel:
   *      true` here must not stop an idle agent.)
   *   2. It is best effort. A pre-v0.3.0 relay answers 404 because it demands a
   *      `task_id`; that is expected, is logged at debug level, and must never
   *      be retried in a storm, affect a task, or end the process.
   *   3. It is skipped while a task holds the lease: the 10s lease heartbeat is
   *      already reporting, and two cadences reporting the same numbers would
   *      just be noise.
   *
   * A successful round trip *is* a real measurement, so it feeds the same
   * rolling window the lease heartbeat uses -- that is what keeps the relay's
   * view fresh while the machine has nothing to do.
   *
   * @returns {Promise<{status: number, ok: boolean}|null>}
   */
  async function sendIdleHeartbeat() {
    if (state.stopped || state.current) return null;
    if (!token()) return null; // nothing to authenticate with; not worth a 401
    const startedHr = process.hrtime.bigint();
    try {
      const response = await postJson('/v1/heartbeat', {
        diagnostic: true,
        machine_id: identity.machine_id,
        ...heartbeatDiagnostics({
          rttMs: state.rttMs,
          reconnectAttempts: state.reconnectAttempts,
        }),
      });
      if (response.ok) {
        // Measured on success only, exactly like the lease heartbeat.
        recordRtt(Number(process.hrtime.bigint() - startedHr) / 1e6);
      } else {
        log('debug', `idle heartbeat rejected (HTTP ${response.status}); diagnostics only, continuing`, {
          body: response.json?.error?.code ?? null,
        });
      }
      return response;
    } catch (error) {
      log('debug', `idle heartbeat failed: ${error?.message ?? String(error)}; diagnostics only, continuing`, {});
      return null;
    }
  }

  /**
   * Start the idle diagnostic cadence. Deliberately does **not** fire
   * immediately: the first beat lands one interval in, so booting an agent
   * stays quiet and a short-lived run produces no diagnostic traffic at all.
   */
  function startIdleHeartbeat() {
    if (idleHeartbeatIntervalMs <= 0 || idleHeartbeatTimer) return;
    idleHeartbeatTimer = setInterval(() => {
      void sendIdleHeartbeat();
    }, idleHeartbeatIntervalMs);
    // A diagnostic must never be the reason the process stays alive.
    if (typeof idleHeartbeatTimer.unref === 'function') idleHeartbeatTimer.unref();
  }

  /** Stop the stream, the running command and the heartbeat. */
  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (statePublishTimer) clearInterval(statePublishTimer);
    statePublishTimer = null;
    if (idleHeartbeatTimer) clearInterval(idleHeartbeatTimer);
    idleHeartbeatTimer = null;
    heartbeat?.stop();
    runAbort?.abort();
    streamAbort?.abort();
    // Final snapshot: a reader must be able to tell "stopped" from "crashed
    // mid-write", and from "still running but not connected".
    state.connected = false;
    publishState();
  }

  /**
   * Run forever (or until `--once` has handled one task).
   *
   * @returns {Promise<void>}
   */
  async function start() {
    log('info', `localside ${identity.machine_name} (${identity.machine_id})`, {
      rabbit: baseUrl,
      project,
      state: stateDir,
      allowed_commands: allowedCommands.map((prefix) => prefix.join(' ')),
    });
    if (allowedCommands.length === 0) {
      log('warn', 'no --allowed-commands configured: every offer will be refused (default-deny)');
    }

    // Publish immediately so the file appears with the agent, not only after
    // the first heartbeat: "is an agent running here?" is the first question a
    // remote operator asks (task-16).
    publishState();
    if (statePublishIntervalMs > 0) {
      statePublishTimer = setInterval(() => publishState(), statePublishIntervalMs);
      // Never keep the process alive just to refresh a diagnostics file.
      if (typeof statePublishTimer.unref === 'function') statePublishTimer.unref();
    }
    // v0.3.0: keep the relay's view of *this* machine fresh even when it has
    // nothing to do. Best effort by construction -- see sendIdleHeartbeat().
    startIdleHeartbeat();

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
        state.streamRestartRequested = false;
        const openedAt = Date.now();
        /** @type {Error|null} */
        let failure = null;
        try {
          await streamOnce();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        if (state.stopped) break;
        state.connected = false;
        publishState();

        const livedMs = Date.now() - openedAt;
        if (state.streamRestartRequested) {
          // The relay changed identity, so the cursor this stream was opened
          // with is void and the stream itself has already skipped the new
          // process's early events. Re-attach at once, without a cursor: any
          // delay here would widen exactly the window this fix closes.
          state.streamRestartRequested = false;
          restartReconnects += 1;
          if (restartReconnects <= MAX_IMMEDIATE_RESTART_RECONNECTS) {
            reconnectAttempt = 0;
            log('warn', `re-attaching after relay change without a cursor (attempt ${restartReconnects})`, {
              lived_ms: livedMs,
            });
            continue;
          }
          // A relay that keeps changing identity would otherwise spin us; fall
          // through to the normal backoff from here on.
          log('warn', 'relay identity keeps changing; falling back to backoff between attaches', {
            restarts: restartReconnects,
          });
        }

        const stable = livedMs >= STABLE_STREAM_MS;
        if (stable) {
          reconnectAttempt = 0;
          restartReconnects = 0;
        }
        // A stream that ends immediately is treated as a failure even when the
        // socket closed cleanly; otherwise a flapping tunnel becomes a hot loop.
        const delay = stable ? RECONNECT_DELAY_AFTER_STABLE_MS : backoffDelay(reconnectAttempt);
        reconnectAttempt += 1;
        const reason = failure
          ? `stream error: ${failure.message}`
          : `event stream closed by server after ${livedMs}ms`;
        // Cross-region debugging needs to answer "is it retrying, how often, and
        // how long until the next try" without attaching a debugger (§8.1).
        log('warn', `${reason}; reconnect #${reconnectAttempt} in ${delay}ms`, {
          attempt: reconnectAttempt,
          delay_ms: delay,
          lived_ms: livedMs,
          stable,
        });
        await sleep(delay, undefined);
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
    /** Write the diagnostics file now (also done automatically; task-16). */
    publishState,
    /** Send one idle diagnostic heartbeat now (v0.3.0). */
    sendIdleHeartbeat,
    /** Absolute path of the published diagnostics file. */
    stateFile: stateFilePath,
    /** Normalised base address actually used for every request (v0.1.2 §2). */
    baseUrl,
    /**
     * Operator token, when this host also submits tasks (v0.1.2 §5).
     *
     * The Localside agent never POSTs `/v1/task`, so this is carried for local
     * tooling (`w2m_status`, host-side scripts) and is never put on the wire by
     * this process. It is deliberately not persisted to disk either.
     */
    operatorToken: operatorToken ?? null,
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
