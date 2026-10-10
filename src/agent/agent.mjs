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
import { join } from 'node:path';
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
  pipelineCommandHash,
  resolveProjectCwd,
} from './git.mjs';
import { createSpool } from './spool.mjs';
import { matchAllowedCommand, parseAllowedCommands } from './allowed-commands.mjs';
import { DEFAULT_P2P_MODE, P2P_DEFAULTS, P2PNode, normalizeP2PMode, normalizeP2PPort } from './p2p-node.mjs';
import { punchSession, reverseDialSession } from './p2p.mjs';
import { createSigner } from '../signing.mjs';
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
  /**
   * v0.4.0: an offer arrived over the relay while this agent is configured `direct`.
   *
   * See `p2pRefusal()` for why this is the one refusal the *mode* decides rather than the offer:
   * `direct` exists to make a silent fallback impossible, so accepting the relay's copy would
   * quietly turn the mode back into `auto` on the machine whose configuration said otherwise.
   */
  P2P_UNAVAILABLE: 'P2P_UNAVAILABLE',
};

/**
 * How long the agent waits for the dispatcher's `result.ack` on a direct channel (v0.4.0).
 *
 * This bound is the whole reason the direct copy is safe to attempt at all. The relay copy is
 * posted only once this wait is over, because `result_path` has to be inside the envelope when
 * `envelope_sha256` is computed -- attaching it afterwards would leave a hash that does not cover
 * the bytes it claims to cover. So the wait is a real delay on the relay copy, and a *bounded* one
 * is the difference between "the fast path is usually faster" and "a wedged dispatcher stalls the
 * ledger". Two seconds is far above any plausible loopback or cross-network ack and far below the
 * relay's lease window, so the relay copy still lands long before anyone would call it late.
 */
export const P2P_RESULT_ACK_TIMEOUT_MS = 2_000;

/**
 * How long a task's direct channel outlives the attempt that used it.
 *
 * Long enough to answer a duplicate of a finished attempt over the same channel (the relay replaying
 * an offer, a dispatcher retrying a push), short enough that a long-lived agent does not accumulate
 * one live session per task it has ever run. Injectable as `p2pChannelLingerMs`, because a test that
 * asserts "the channel is released" should be able to make that fact observable in milliseconds
 * rather than describe a 30-second wait.
 */
export const P2P_CHANNEL_LINGER_MS = 30_000;

/**
 * Why this agent's own outbound dial did not open a channel (v0.4.x), with its own codes.
 *
 * These are reported in the result envelope's `p2p.reverse_dial_reason`, never thrown and never
 * fatal: a reverse dial that fails changes nothing about the relay path, and "the punch timed out"
 * and "there was nothing to punch at" are different facts that need different responses. A timeout
 * is the ordinary outcome for a dispatcher behind a symmetric NAT that answered nothing -- the same
 * code the dispatcher's own failed push reports (`P2P_PUNCH_TIMEOUT`), prefixed so a reader can tell
 * which end dialled.
 */
export const P2P_REVERSE_DIAL_TIMEOUT = 'P2P_REVERSE_DIAL_TIMEOUT';
export const P2P_REVERSE_DIAL_FAILED = 'P2P_REVERSE_DIAL_FAILED';

/**
 * The plan code for "there is a live channel, so there is nothing to dial".
 *
 * Not a failure: it is the ordinary answer when the dispatcher's own push landed. It is a distinct
 * code because the *result* path re-plans on it: a channel that existed when the offer arrived and is
 * gone when the result is ready (the dispatcher closes the channel it pushed the offer over) gets the
 * one reverse-dial attempt the contract allows, whereas every other skip reason stays skipped.
 */
export const P2P_CHANNEL_LIVE = 'P2P_CHANNEL_LIVE';

/**
 * The mechanism names that go into `p2p.opened_by`.
 *
 * Named rather than inferred at the reader's end: `result_path: 'p2p'` says the result travelled
 * directly, and this says *what opened the path* -- the dispatcher's punch, this machine's dial at
 * offer time (the simultaneous punch), or this machine's dial once the result was ready.
 */
export const P2P_OPENED_BY = Object.freeze({
  DISPATCHER_PUNCH: 'dispatcher-punch',
  SIMULTANEOUS_PUNCH: 'simultaneous-punch',
  RESULT_REVERSE_DIAL: 'result-reverse-dial',
});
/**
 * Upper bound on the stages a single offer may carry (v0.3.3 `pipeline`).
 *
 * Mirrors the relay's `MAX_PIPELINE_STAGES`. Kept as a separate literal rather than imported so the
 * agent's validation does not depend on the relay module: the agent must refuse an oversized chain
 * on its own authority, and a shared import would make "the relay said so" the only reason it does.
 */
const MAX_STAGES = 16;

/** Required envelope fields (§5.1). Missing any one makes a result unverifiable. */
export const REQUIRED_ENVELOPE_FIELDS = [  'envelope_version',
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
// P2P transport facts (v0.4.0)
// ---------------------------------------------------------------------------

/**
 * The two transports an offer or a result can travel over.
 *
 * Duplicated from `src/relay/state.mjs`'s `TRANSPORT_VALUES` on purpose, for the same reason
 * `P2PNode` duplicates the relay's IPv4 rule: they are wire values that two independently
 * deployed ends must agree on, and a shared import would make one side's edit silently change
 * what the other accepts.
 */
export const TRANSPORT_VALUES = Object.freeze(['p2p', 'relay']);

/**
 * A JSON *frame* arriving on a P2P channel.
 *
 * The channel carries opaque bytes (`P2PNode` deliberately does not parse them) and the W2M
 * convention is that the bytes are the relay's own JSON frames. Parsing happens here, in the
 * agent, because "what a frame means for a task" is a task-layer question; from this point on
 * the payload takes `handleFrame`'s path with `transport: 'p2p'`, which is what makes a direct
 * offer and an SSE offer the *same* code path rather than two that have to be kept in step.
 *
 * @param {unknown} payload The channel's message body.
 * @returns {object|null} The payload object, or null when it is not a JSON object with a `type`.
 */
export function parseP2PFrame(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  let parsed;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : String(text));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.type !== 'string' || parsed.type === '') return null;
  return parsed;
}

/**
 * Which path an offer arrived on, and -- when it arrived over the relay -- why the direct path
 * was not the answer.
 *
 * The transport value is taken from `offer.p2p_transport`, which the agent itself stamps on a
 * channel-delivered offer and only there. Nothing on the wire can set it: a relay frame that
 * carried the field would still be stamped `'relay'` by the SSE path, so a dispatcher cannot
 * claim a direct path it never opened.
 *
 * The reason is named only when the relay really was the answer. `P2P_NO_CANDIDATES` is not a
 * guess about the dispatcher's punch -- it is the agent's own finding for *this* task: a relay
 * offer means no direct channel exists for this `task_id`, and the reason says exactly that.
 * `P2P_DISABLED` covers the mechanical case (`mode: 'relay'`, where no direct path exists at all);
 * `P2P_UNREACHABLE` covers the rare ordering where the offer beat the node's own startup.
 *
 * @param {object|null} offer
 * @param {{mode: string, running: boolean}} p2p
 * @returns {{offer_path: 'p2p'|'relay', reason: string|null}}
 */
export function offerTransportOf(offer, p2p) {
  if (offer?.p2p_transport === 'p2p') return { offer_path: 'p2p', reason: null };
  if (p2p.mode === 'relay') {
    return {
      offer_path: 'relay',
      reason: 'P2P_DISABLED: p2pMode is "relay", so no direct path is attempted',
    };
  }
  if (p2p.running !== true) {
    return {
      offer_path: 'relay',
      reason: 'P2P_UNREACHABLE: the P2P node is not running, so no direct path was available',
    };
  }
  return {
    offer_path: 'relay',
    reason: 'P2P_NO_CANDIDATES: no direct channel was open for this task, so the relay carried the offer',
  };
}

/**
 * The result-delivery mark: how the *envelope* is being carried, as opposed to how the offer
 * arrived.
 *
 * Kept as a plain object so it can be handed through `finish()`/`makeEnvelope()` unchanged, and
 * `asked` distinguishes "nothing to acknowledge over" from "asked, and nobody answered" -- both
 * end up as `result_path: null`, but only the second one is worth a metric.
 *
 * @param {{path: 'p2p'|null, asked: boolean, rtt_ms: number|null, error: string|null}} value
 * @returns {{path: 'p2p'|null, asked: boolean, rtt_ms: number|null, error: string|null}}
 */
export function p2pDeliveryMark(value = {}) {
  return {
    path: value.path === 'p2p' ? 'p2p' : null,
    asked: value.asked === true,
    rtt_ms: typeof value.rtt_ms === 'number' && Number.isFinite(value.rtt_ms) ? value.rtt_ms : null,
    error: typeof value.error === 'string' && value.error !== '' ? value.error : null,
  };
}

// ---------------------------------------------------------------------------
// Command allow-list (default-deny)
// ---------------------------------------------------------------------------

// The matcher itself lives in `./allowed-commands.mjs`, because the plugin's dispatch-time
// pre-flight must apply the *same* rule (see that file's header). It is imported above for this
// module's own use and re-exported here so the exports of this module are unchanged: the CLI and
// `test/agent.test.mjs` have always imported these two names from the agent.
export { parseAllowedCommands, matchAllowedCommand } from './allowed-commands.mjs';

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
 * @property {string} [p2pMode] `auto` (default), `direct` or `relay` (v0.4.0). Anything
 *   else is a `TypeError` naming {@link normalizeP2PMode}'s reason: a mode is a wire value,
 *   so a typo must fail at the call site rather than degrade into a silent default.
 * @property {string[]|string} [stunServers] Complete STUN list, in query order, for the
 *   agent's own node. See {@link stunServersWithShared}.
 * @property {number|null} [p2pPort] Local UDP port the punch socket binds, 1..65535; `null`
 *   or omitted means an ephemeral port, which is the default. A machine that must **accept**
 *   a punch needs a stable port: an ephemeral one changes on every restart, so a firewall
 *   rule has to be re-pointed after each start and every dispatch falls back to the relay in
 *   the meantime (`P2P_PUNCH_TIMEOUT` on the dispatcher, `offer_path: relay` in the ledger).
 *   Anything that is not a valid port is reported as a `P2P_PORT_INVALID` start failure, never
 *   thrown -- see {@link normalizeP2PPort} and `startP2P()`, which treats it like every other
 *   P2P error: recorded, and never fatal to the relay path.
 * @property {P2PNode|((options: object) => P2PNode)} [p2pNode] The node to use. An
 *   instance is adopted; a function is called with the derived options. Injectable
 *   because a test needs a real socket and a deterministic discovery answer, and
 *   because `test/outbound-only.test.mjs` counts binds through it.
 * @property {object} [p2pNodeOptions] Extra `P2PNode` constructor options, merged last.
 * @property {number} [p2pAckTimeoutMs] Bounded wait for `result.ack` on the direct
 *   channel; see {@link P2P_RESULT_ACK_TIMEOUT_MS}.
 * @property {(status: object) => void} [onP2PStatus] Called with a snapshot of the agent's
 *   P2P facts whenever they change (the node starting, an announcement, an error). Push,
 *   not poll: the plugin's `w2m_status` must not have to ask repeatedly.
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
    onP2PStatus = () => {},
    p2pAckTimeoutMs = P2P_RESULT_ACK_TIMEOUT_MS,
    p2pChannelLingerMs = P2P_CHANNEL_LINGER_MS,
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

  // v0.4.0: the mode is validated at construction, with the same loud helper the node and the
  // CLI use. `normalizeP2PMode` rejects `'AUTO'`, `' auto '` and friends by name; doing that here
  // means an unusable mode can never reach `start()` as a half-started agent.
  const p2pModeInput = options.p2pMode === undefined ? DEFAULT_P2P_MODE : options.p2pMode;
  const normalizedMode = normalizeP2PMode(p2pModeInput);
  if (!normalizedMode.ok) throw new TypeError(`createAgent: ${normalizedMode.reason}`);
  const p2pMode = normalizedMode.mode;

  // The punch port is validated at construction with the same named helper the CLI uses, but an
  // unusable value is *not* thrown: a machine whose P2P settings are wrong must still work over the
  // relay, so it becomes a start failure (`P2P_PORT_INVALID`) reported by `startP2P()` exactly like
  // `P2P_NODE_INVALID` or `P2P_BIND_FAILED`. The error is recorded here and logged where the node
  // would have been built.
  const p2pPortResult = normalizeP2PPort(options.p2pPort);
  const p2pPort = p2pPortResult.ok ? p2pPortResult.port : null;
  const p2pPortError = p2pPortResult.ok ? null : `P2P_PORT_INVALID: ${p2pPortResult.reason}`;

  if (typeof onP2PStatus !== 'function') throw new TypeError('createAgent: onP2PStatus must be a function');
  if (typeof p2pAckTimeoutMs !== 'number' || !Number.isFinite(p2pAckTimeoutMs) || p2pAckTimeoutMs < 0) {
    throw new TypeError('createAgent: p2pAckTimeoutMs must be a non-negative number of milliseconds');
  }

  // Validate + normalise once, at construction: a `rabbitUrl` carrying a query
  // string, a fragment or a non-http scheme must fail loudly here rather than
  // turn into mysterious 404s at request time. Sub-paths are preserved.
  const baseUrl = resolveBaseUrl(rabbitUrl);

  // ---- v0.3.0 request signing ------------------------------------------
  // Absent/`null`/`''` means "signing is not configured", and in that case **not
  // one signing header is added anywhere** -- the wire stays byte-identical to
  // v0.2.3, which is the backward-compatibility gate the tests pin down. The
  // empty string is the explicit "off" spelling (same convention as the relay's
  // `--require-signature` settings), so it disables rather than throws.
  //
  // Any *other* unusable value is an error instead of a silent downgrade: a
  // caller who passes a number, an object or `true` meant to configure signing,
  // and quietly giving them an unsigned link is exactly the silent degradation
  // §0 forbids. `signing.mjs`'s `BAD_SECRET` exists for this distinction.
  const signingSecret = options.signingSecret ?? null;
  if (signingSecret !== null && typeof signingSecret !== 'string') {
    throw new TypeError(
      `createAgent: signingSecret must be a string (got ${typeof signingSecret}); ` +
        "pass '' or omit it to disable signing",
    );
  }
  const signer = signingSecret === null || signingSecret === ''
    ? null
    : createSigner({ secret: signingSecret, ...(options.signerOptions ?? {}) });

  const log = options.log ?? (() => {});
  const spool = createSpool(stateDir);

  // -- P2P transport (v0.4.0) ----------------------------------------------
  //
  // Everything the direct path owns lives in these few bindings, and the shape is deliberate:
  // the agent does not *have* a P2P stack, it *borrows* one node and treats every failure as a
  // reportable fact. `p2pMode: 'relay'` leaves the whole block inert -- `configureP2P()` never
  // constructs a node, so no UDP socket exists and no STUN server is ever queried, which is what
  // makes the setting a mechanical statement ("this machine is exactly v0.3.9") rather than a
  // promise about behaviour.

  /** @type {P2PNode|null} The node, once one exists. Null in `relay` mode, forever. */
  let p2pNode = null;
  /** @type {Promise<object>|null} In-flight start, so `stop()` can await it. */
  let p2pStarting = null;
  /** @type {object|null} Start outcome, so the status can report *why* the node is not running. */
  let p2pStartResult = null;
  /** @type {object|null} Last snapshot handed to `onP2PStatus`, so a no-op change is not pushed. */
  let lastP2PStatusJson = null;

  /**
   * Result envelopes awaiting a `result.ack` over a direct channel.
   *
   * Keyed by `task_id` (one result per task and attempt is the whole point of the dedupe work), so
   * a late ack for a re-delivered attempt resolves the live waiter rather than a stale one.
   *
   * @type {Map<string, {settle: (acked: boolean, error: string|null) => void}>}
   */
  const p2pResultWaiters = new Map();

  /**
   * Live channels per `task_id`, for the direct result copy *and* for knowing which tasks the
   * dispatcher can already reach us about. Populated only from a `task.offer` that arrived on a
   * channel: a channel that was opened but never used for an offer has no task to be the result of.
   *
   * `onClose` is the listener attached to the channel, kept here so a channel replaced for the
   * same task can have its old listener removed instead of leaking one per re-punch.
   *
   * @type {Map<string, {channel: object, onClose: () => void}>}
   */
  const p2pChannels = new Map();

  /**
   * The dispatcher address a task's channel actually travels to, remembered past the channel.
   *
   * This is the *observed* address for a channel that arrived inbound (`accept()` answers to the
   * `rinfo` of the HELLO it received, never to the address that peer announced) and the punched
   * address for one this agent opened. It outlives the channel on purpose: when the dispatcher
   * closes the channel it pushed the offer over -- which it does, right after the offer -- the
   * result still has somewhere to go, and the observed address is the one address a symmetric NAT
   * on the dispatcher's side is still holding a mapping for. Retyping the announced candidate
   * instead is the punch that already failed.
   *
   * @type {Map<string, {address: string, port: number}>}
   */
  const p2pPeers = new Map();

  /**
   * One reverse-dial attempt per `task_id` — the executor's own half of a two-way punch.
   *
   * A record exists for every offer this agent takes on, including the ones it decides *not* to
   * dial for, and that is deliberate: "we did not try, because a channel was already live" and "we
   * tried and it timed out" must be distinguishable at result time, and a missing record must not
   * silently mean a second attempt. `promise` settles when the dial is over; it is awaited by the
   * result path (bounded by the same tuning window), never by the offer path.
   *
   * @type {Map<string, {task_id: string, attempted: boolean, ok: boolean, code: string|null,
   *   reason: string|null, stage: 'offer'|'result', session: number|null, candidates: number,
   *   channel: object|null, promise: Promise<object>|null, ms: number|null}>}
   */
  const p2pReverseDials = new Map();

  /**
   * How long this agent may spend dialling a dispatcher, from the node's own tuning.
   *
   * Read from the node rather than fixed here so the number lives beside `punchTimeoutMs` and
   * `acceptTimeoutMs`: an operator tuning a slow path tunes one object, and a test that cannot wait
   * eight seconds injects one.
   */
  function reverseDialTimeoutMs() {
    const configured = p2pNode?.tuning?.reverseDialTimeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : P2P_DEFAULTS.reverseDialTimeoutMs;
  }

  /** The agent's P2P facts, always a fresh plain object. */
  function p2pStatusSnapshot() {
    const nodeStatus = p2pNode?.status ?? null;
    const startError = p2pStartResult?.ok === false ? p2pStartResult.error ?? null : null;
    return {
      mode: p2pMode,
      enabled: p2pMode !== 'relay',
      running: nodeStatus?.running === true,
      machine_id: identity.machine_id,
      rabbit_url: baseUrl,
      local: nodeStatus?.local ?? null,
      reflexive: nodeStatus?.reflexive ?? null,
      mapping: nodeStatus?.mapping ?? null,
      candidates: nodeStatus?.candidates ?? [],
      announced_at: nodeStatus?.announced_at ?? null,
      announce_ok: nodeStatus?.announce_ok === true,
      announce_failures: nodeStatus?.announce_failures ?? 0,
      last_announce_error: nodeStatus?.last_announce_error ?? null,
      punches_out: nodeStatus?.punches_out ?? 0,
      punches_in: nodeStatus?.punches_in ?? 0,
      dial_failures: nodeStatus?.dial_failures ?? 0,
      channels: p2pChannels.size,
      start_error: startError,
      last_error: startError ?? nodeStatus?.last_error ?? null,
    };
  }

  /**
   * Push the current facts to `onP2PStatus`, but only when they actually changed.
   *
   * Deduplicated on the serialised snapshot: `publishState()` runs on every heartbeat and an
   * unconditional push would turn a 10s cadence into a stream of identical callbacks. The
   * comparison is on JSON, not on object identity, because every read builds a new object by
   * design (no caller may hold a reference into the agent's state).
   */
  function refreshP2PStatus() {
    const snapshot = p2pStatusSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === lastP2PStatusJson) return snapshot;
    lastP2PStatusJson = json;
    try {
      onP2PStatus(snapshot);
    } catch (error) {
      // A diagnostic consumer that throws must not cost the agent anything: the callback belongs
      // to a *reader* (the plugin), and "the reporter is broken" is not a transport failure.
      log('warn', 'onP2PStatus threw; P2P status is still in state.p2p', {
        error: error?.message ?? String(error),
      });
    }
    return snapshot;
  }

  /**
   * Build (but do not start) the node, unless the mode says there is no direct path.
   *
   * A node the caller injected is adopted as-is -- including its mode, which is why an injected
   * node and `p2pMode` disagreeing is logged rather than silently resolved: the injected node is
   * the one that would actually bind a socket, so it is the one that decides, and a caller
   * comparing the two configuration surfaces deserves to know they are not the same thing.
   */
  function configureP2P() {
    if (p2pMode === 'relay') return;
    if (p2pNode !== null) return;
    if (p2pPortError !== null) {
      // Loud, and before anything is built. `relay` mode above is deliberately checked first: an
      // operator who asked for no direct path at all should not be told about a port that would
      // never be bound.
      p2pStartResult = { ok: false, enabled: true, error: p2pPortError };
      log('error', 'refusing to build the P2P node with an unusable p2pPort; the relay path is unaffected', {
        error: p2pPortError,
      });
      return;
    }

    const injected = options.p2pNode ?? null;
    const extra = options.p2pNodeOptions ?? {};
    const derived = {
      mode: p2pMode,
      rabbitUrl: baseUrl,
      machineId: identity.machine_id,
      postJson: (path, body) => postJson(path, body),
      getJson: (path) => getJson(path),
      ...(options.stunServers === undefined ? {} : { stunServers: options.stunServers }),
      log: (line) => log('info', line, {}),
      ...extra,
      // After `extra`, so the *validated* named option is the one that decides: `p2pNodeOptions` is
      // an escape hatch for the node's other constructor options, and letting an unvalidated
      // `bindPort` there silently win would route around the check above.
      ...(p2pPort === null ? {} : { bindPort: p2pPort }),
    };

    try {
      if (typeof injected === 'function') {
        p2pNode = injected(derived);
      } else if (injected !== null && typeof injected === 'object') {
        p2pNode = injected;
        if (p2pNode.mode !== p2pMode) {
          log('warn', 'injected p2pNode mode differs from p2pMode; the node decides', {
            p2pMode,
            node_mode: p2pNode.mode,
          });
        }
      } else {
        p2pNode = new P2PNode(derived);
      }
    } catch (error) {
      // Never fatal, for the same reason as a failed start: a machine whose P2P configuration is
      // wrong must still work over the relay.
      p2pStartResult = {
        ok: false,
        enabled: p2pMode !== 'relay',
        error: `P2P_NODE_INVALID: ${error?.message ?? String(error)}`,
      };
      log('error', 'could not build the P2P node; the relay path is unaffected', {
        error: p2pStartResult.error,
      });
      return;
    }

    p2pNode.on('message', (event) => handleP2PMessage(event));
    // `'announce'` is the only event that changes the facts a reader cares about between
    // heartbeats, so it is what refreshes the published status.
    p2pNode.on('announce', () => refreshP2PStatus());
    // Deliberately after `configureP2P`: a node so broken it binds twice is the *only* thing this
    // catches, and it is a bug in the node rather than anything the agent can recover from.
    p2pNode.on('error', (error) => {
      log('warn', `p2p: ${error?.message ?? String(error)}`, {});
    });
  }

  /**
   * Bring the direct path up. Failures are recorded, never thrown.
   *
   * The guard is the whole point: a machine that cannot punch (no UDP egress, a symmetric NAT, an
   * unreachable relay route from `POST /v1/peer/announce`) is still a working W2M machine, because
   * the relay is always still there. An agent that refused to start because a *fast path* was
   * unavailable would have turned an optimisation into a new failure mode.
   *
   * @returns {Promise<{ok: boolean, enabled: boolean, error: string|null}>}
   */
  async function startP2P() {
    if (p2pMode === 'relay') return { ok: true, enabled: false, error: null };
    configureP2P();
    if (p2pNode === null) return p2pStartResult ?? { ok: false, enabled: true, error: 'P2P_NODE_INVALID' };
    if (p2pStarting !== null) return p2pStarting;

    const started = (async () => {
      let result;
      try {
        result = await p2pNode.start();
      } catch (error) {
        result = { ok: false, enabled: true, error: `P2P_START_THREW: ${error?.message ?? String(error)}` };
      }
      p2pStartResult = result;
      log(result.ok ? 'info' : 'warn', `p2p ${p2pMode}: ${result.ok ? 'node started' : 'node did not start'}`, {
        error: result.error ?? null,
      });
      refreshP2PStatus();
      return result;
    })();
    p2pStarting = started;

    try {
      return await started;
    } finally {
      // Only the caller that owns the in-flight start clears it. Clearing unconditionally would be
      // safe today (the promise is shared and idempotent) but would break the moment a second start
      // could begin while the first was still running.
      if (p2pStarting === started) p2pStarting = null;
    }
  }

  /** Stop the node and let go of every channel. Idempotent and awaitable. */
  async function closeP2P() {
    // Await a start that is still in flight first: closing a node that is halfway through binding
    // would race the bind and could leave a socket nobody references.
    if (p2pStarting !== null) await p2pStarting.catch(() => null);
    const node = p2pNode;
    if (node === null) return;
    try {
      await node.close();
    } catch (error) {
      log('warn', 'p2p: closing the node failed', { error: error?.message ?? String(error) });
    }
    p2pChannels.clear();
    refreshP2PStatus();
  }

  /** Remember which channel a task's result should travel back over, and release it on close. */
  function rememberChannel(taskId, channel) {
    const peer = channel?.peer;
    if (
      peer !== null &&
      typeof peer?.address === 'string' &&
      peer.address !== '' &&
      Number.isInteger(peer?.port) &&
      peer.port > 0
    ) {
      // Kept even though this channel may be replaced or closed below: see `p2pPeers`.
      p2pPeers.set(taskId, { address: peer.address, port: peer.port });
    }
    const previous = p2pChannels.get(taskId);
    if (previous?.channel === channel) return;
    if (previous) previous.channel.removeListener('close', previous.onClose);
    const onClose = () => {
      if (p2pChannels.get(taskId)?.channel === channel) p2pChannels.delete(taskId);
    };
    p2pChannels.set(taskId, { channel, onClose });
    channel.on('close', onClose);
  }

  /** The channel a task's result can be acknowledged over, or null when there is none. */
  const channelFor = (taskId) => p2pChannels.get(taskId)?.channel ?? null;

  /**
   * What a reverse dial would need, or the named reason there is nothing to dial.
   *
   * WHY THE EXECUTOR DIALS AT ALL
   *
   * The dispatcher pushes first, and if it is behind a symmetric NAT (CGNAT, in practice) its HELLOs
   * are addressed from a mapped port that nobody was told about, so they reach nothing. Its own
   * outbound packet still opened a mapping *towards this machine*, though -- and that is half a path.
   * The other half is a packet from here, addressed at the dispatcher: the moment this machine sends
   * one, its own NAT lets the dispatcher's HELLO through and the second packet lands on a path that is
   * already open. Neither end can do it alone, which is why a peer that only ever accepted cannot
   * rescue a CGNAT initiator.
   *
   * WHERE THE ADDRESSES COME FROM
   *
   * The offer's own `p2p.candidates` when the dispatcher published them (it knows its own announced
   * addresses better than a relay lookup that may already have expired), with the address this task's
   * channel actually reached first when there was one, and the relay's `/v1/peer/{id}` answer as the
   * node's own fallback when neither is available.
   *
   * @param {object} offer
   * @returns {{ok:true, machineId:string, session:number, candidates:Array<object>, from:string}
   *   |{ok:false, code:string, reason:string}}
   */
  function reverseDialPlan(offer) {
    const taskId = typeof offer?.task_id === 'string' && offer.task_id !== '' ? offer.task_id : null;
    if (taskId === null) {
      return { ok: false, code: 'P2P_NO_TASK_ID', reason: 'P2P_NO_TASK_ID: the offer names no task to dial for' };
    }
    if (p2pMode === 'relay') {
      return {
        ok: false,
        code: 'P2P_DISABLED',
        reason: 'P2P_DISABLED: p2pMode is "relay", so this machine never dials (the relay path is the only path)',
      };
    }
    if (p2pNode === null || p2pNode.status.running !== true) {
      return {
        ok: false,
        code: 'P2P_UNREACHABLE',
        reason: 'P2P_UNREACHABLE: the P2P node is not running, so no direct path can be dialled',
      };
    }
    if (channelFor(taskId) !== null) {
      return {
        ok: false,
        code: P2P_CHANNEL_LIVE,
        reason: `P2P_CHANNEL_LIVE: a direct channel for ${taskId} is already open, so there is nothing to dial`,
      };
    }

    const block = offer?.p2p;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      return {
        ok: false,
        code: 'P2P_NO_SESSION',
        reason: 'P2P_NO_SESSION: the offer published no `p2p` block, so there is no session to join',
      };
    }
    const dispatcher =
      typeof offer?.origin_machine_id === 'string' && offer.origin_machine_id !== ''
        ? offer.origin_machine_id
        : null;
    if (dispatcher === null) {
      return {
        ok: false,
        code: 'P2P_NO_ORIGIN',
        reason: 'P2P_NO_ORIGIN: the offer does not name the machine that dispatched it, so there is nothing to dial',
      };
    }

    const machineId = identity.machine_id;
    const published = Array.isArray(block.candidates) ? block.candidates : [];
    let session = Number.isInteger(block.session) && block.session > 0 ? block.session : null;
    let from = 'offer session';
    if (session === null) {
      session = punchSession({ punch: block.punch, taskId, machineId });
      from = 'offer punch';
    }
    if (session === null && published.length > 0) {
      // A dispatcher that published where to dial but not which session: this end picks one and the
      // far end adopts it. The 404-free lookup is the point -- `p2p.candidates` came with the offer.
      session = reverseDialSession({ originMachineId: dispatcher, taskId, machineId });
      from = 'derived session';
    }
    if (session === null) {
      return {
        ok: false,
        code: 'P2P_NO_SESSION',
        reason:
          'P2P_NO_SESSION: the offer published neither a session nor candidates, so this is a v0.4.x ' +
          'dispatcher and the relay carries the result exactly as it did before',
      };
    }

    const observed = p2pPeers.get(taskId) ?? null;
    return {
      ok: true,
      machineId: dispatcher,
      session,
      candidates: observed === null ? [...published] : [observed, ...published],
      from: observed === null ? from : `${from} + observed peer`,
    };
  }

  /**
   * Start (or reuse) this task's one reverse-dial attempt. Never awaited by the offer path.
   *
   * @param {object} offer
   * @param {{stage?: 'offer'|'result', afterLiveChannel?: boolean}} [options]
   * @returns {object|null} The record; `promise` settles when the dial is over.
   */
  function startReverseDial(offer, options = {}) {
    const taskId = typeof offer?.task_id === 'string' && offer.task_id !== '' ? offer.task_id : null;
    if (taskId === null) return null;
    const stage = options.stage === 'result' ? 'result' : 'offer';

    const existing = p2pReverseDials.get(taskId) ?? null;
    if (existing !== null) {
      // One attempt per task, with exactly one exception: a decision that said "a channel is already
      // live" is re-planned at result time, because that channel may be gone by then and the result
      // is what the dial exists for. Everything else -- attempted, disabled, unreachable, no session
      // -- is final, so a result never pays for a second eight-second wait.
      const rePlannable = existing.attempted !== true && existing.code === P2P_CHANNEL_LIVE;
      if (!(options.afterLiveChannel === true && rePlannable)) return existing;
    }

    const plan = reverseDialPlan(offer);
    /** @type {object} */
    const record = {
      task_id: taskId,
      attempted: plan.ok === true,
      ok: false,
      code: plan.ok === true ? null : plan.code,
      reason: plan.ok === true ? null : plan.reason,
      stage,
      session: plan.ok === true ? plan.session : null,
      candidates: plan.ok === true ? plan.candidates.length : 0,
      from: plan.ok === true ? plan.from : null,
      channel: null,
      promise: null,
      ms: null,
    };
    p2pReverseDials.set(taskId, record);

    if (!plan.ok) {
      record.promise = Promise.resolve(record);
      if (plan.code !== P2P_CHANNEL_LIVE) {
        log('info', `not dialling back for ${taskId}: ${plan.reason}`);
      }
      return record;
    }

    const timeoutMs = reverseDialTimeoutMs();
    const startedAt = process.hrtime.bigint();
    record.promise = (async () => {
      let dialled;
      try {
        dialled = await p2pNode.dial(plan.machineId, {
          session: plan.session,
          candidates: plan.candidates,
          timeoutMs,
        });
      } catch (error) {
        // `dial()` documents that it never throws; caught anyway, because this runs detached from
        // every caller and an unhandled rejection is the one failure that could take the process down.
        dialled = { ok: false, error: `P2P_REVERSE_DIAL_FAILED: ${error?.message ?? String(error)}` };
      }
      record.ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
      if (dialled?.ok === true) {
        record.ok = true;
        record.channel = dialled.channel;
        record.reused = dialled.reused === true;
        rememberChannel(taskId, dialled.channel);
        log('info', `reverse dial to ${plan.machineId} opened a channel for ${taskId}`, {
          session: dialled.session,
          ms: record.ms,
          reused: record.reused,
          candidates: plan.candidates.length,
        });
        return record;
      }
      const text = typeof dialled?.error === 'string' && dialled.error !== '' ? dialled.error : 'the dial reported no reason';
      record.reason = text.startsWith('P2P_PUNCH_TIMEOUT')
        ? `${P2P_REVERSE_DIAL_TIMEOUT}: ${text}`
        : `${P2P_REVERSE_DIAL_FAILED}: ${text}`;
      // A distinct code from the reason: the full message names the candidates and the window, and
      // this is what a reader or a metric can match on without parsing prose.
      record.code = record.reason.slice(0, record.reason.indexOf(':'));
      log('warn', `reverse dial for ${taskId} did not open a channel; the relay path is unaffected`, {
        reason: record.reason,
        ms: record.ms,
      });
      return record;
    })();

    return record;
  }

  /**
   * The reverse-dial facts one result envelope reports, or null when there was no record.
   *
   * @param {string} taskId
   * @returns {object|null}
   */
  function reverseDialSummary(taskId) {
    const record = p2pReverseDials.get(taskId) ?? null;
    if (record === null) return null;
    return {
      attempted: record.attempted === true,
      ok: record.ok === true,
      code: record.code,
      reason: record.reason,
      stage: record.stage,
      session: record.session,
      candidates: record.candidates,
      ms: record.ms,
      channel: record.channel ?? null,
    };
  }

  /** Release the channel a task used, once the attempt is over.
   *
   * A channel exists for one attempt: the offer arrives on it and the result notice is acknowledged
   * on it, and nothing else is expected. Without this, an agent accumulated one live session per task
   * it ever handled -- and a session whose peer has gone away is invisible in every status surface
   * except the channel count, which is exactly how a leak becomes a mystery months later. Closing is
   * cheap: the mapping is re-punchable, and a duplicate offer that arrives afterwards simply has no
   * channel to answer on (the relay copy is the durable one).
   */
  function releaseChannel(taskId) {
    p2pReverseDials.delete(taskId);
    p2pPeers.delete(taskId);
    const entry = p2pChannels.get(taskId);
    if (!entry) return;
    p2pChannels.delete(taskId);
    entry.channel.removeListener('close', entry.onClose);
    clearTimeout(entry.lingerTimer);
    try {
      entry.channel.close('attempt-complete');
    } catch {
      /* the path is already gone; that is the state this function produces */
    }
  }

  /**
   * Release a task's channel after a bounded linger.
   *
   * The linger is the difference between "no leak" and "a duplicate cannot be answered": a
   * re-delivery of a finished attempt (the relay replaying an offer, or a dispatcher retrying a push)
   * is answered over the channel, and that is only possible while the channel exists. 30 seconds is
   * long enough to cover a retry and short enough that a long-lived agent does not accumulate one
   * session per task it has ever run.
   *
   * Scheduled even when there is no channel: the timer is also what releases this task's remembered
   * peer address, and a task whose dial timed out has exactly that and no channel.
   */
  function scheduleChannelRelease(taskId) {
    const entry = p2pChannels.get(taskId);
    if (entry) clearTimeout(entry.lingerTimer);
    const timer = setTimeout(() => releaseChannel(taskId), p2pChannelLingerMs);
    timer.unref?.();
    if (entry) entry.lingerTimer = timer;
  }

  /**
   * Let go of one task's dial record, once its envelope has been built.
   *
   * That envelope is the record's last reader: the record exists to decide `result_path` and to name
   * the mechanism that opened the channel, and both are inside the envelope by the time this runs. A
   * re-attempt of the same task (`attempt + 1`) is a new decision and starts a fresh dial, which is
   * why this is not left to the linger timer -- that one waits 30 s, and a retry can arrive sooner.
   *
   * @param {string} taskId
   */
  function releaseDialRecord(taskId) {
    p2pReverseDials.delete(taskId);
  }

  /** The STUN list the node is actually querying, for a status surface that can be quoted. */
  const p2pStunServers = () => p2pNode?.stunServers ?? null;

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
    /**
     * Last non-2xx response from the relay, with its own error code preserved
     * (v0.3.0). On a signed link this is what distinguishes "your clock drifted
     * outside the window" from "your secret is wrong".
     */
    lastRelayError: null,
    /**
     * The agent's P2P facts (v0.4.0): mode, whether the node is running, what it announced, how
     * many punches went each way, and the start error when there is one.
     *
     * A getter rather than a field because every read must be a *fresh* plain object: this is
     * published to another process (the plugin's `w2m_status`), and a shared object would let a
     * reader mutate the agent's own view of its transport. The full node status -- including the
     * reflexive address and candidate list -- is available from `agent.p2pNode`.
     */
    get p2p() {
      return p2pStatusSnapshot();
    },
    /** @type {object|null} */
    current: null,
  };

  /** @type {object[]} */
  const queue = [];
  /**
   * Offers whose attempt is already queued or running, keyed by {@link identityKeyFor}.
   *
   * This is v0.4.0's exactly-once guard, and it is deliberately *synchronous*: `enqueue` checks it
   * and writes to it without an `await` anywhere between, so two copies of one offer -- one over
   * the relay, one over a channel, in either order -- cannot both reach the queue. `completed` and
   * the spool cannot do this job on their own: neither knows anything until an envelope exists,
   * which is exactly the window a duplicate arrives in.
   *
   * Released in `pump`'s `finally`, once the attempt has delivered (or failed to). It is not
   * released in `handleOffer` so an offer that throws is still retryable.
   *
   * @type {Set<string>}
   */
  const claimed = new Set();
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
   * Remember a delivered envelope, bounded.
   *
   * The key is {@link identityKeyFor}'s, not a second spelling of the same idea: a cache keyed
   * differently from the dedupe check would be a cache that never hits.
   *
   * @param {string|null} key
   * @param {object} envelope
   */
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
      // v0.4.0: the direct path's facts, so a plugin on another host can answer "which path is this
      // machine actually using?" without asking the agent process. A summarised shape on purpose --
      // the candidate list and the reflexive address are available in-process from `agent.p2p`.
      p2p: p2pSummary(),
    };
  }

  /**
   * The published (cross-process) subset of the P2P facts.
   *
   * Deliberately not the whole {@link p2pStatusSnapshot}: this is written to disk and read by a
   * plugin in another process, so it names a fixed set of fields rather than mirroring whatever
   * the node happens to expose.
   *
   * @returns {object}
   */
  function p2pSummary() {
    const snapshot = p2pStatusSnapshot();
    return {
      mode: snapshot.mode,
      enabled: snapshot.enabled,
      running: snapshot.running,
      mapping: snapshot.mapping,
      reflexive: snapshot.reflexive,
      candidates: snapshot.candidates.length,
      announced_at: snapshot.announced_at,
      punches_out: snapshot.punches_out,
      punches_in: snapshot.punches_in,
      dial_failures: snapshot.dial_failures,
      channels: snapshot.channels,
      last_error: snapshot.last_error,
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
    // Guarded above by `if (toolchainCache) return`, and two concurrent callers would derive the same
    // value from immutable project facts -- the worst case is doing the work twice, not caching
    // something wrong.
    // eslint-disable-next-line require-atomic-updates -- guarded memo; value derived from immutables
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
   * Signing headers for one request, or nothing at all.
   *
   * The signed `path` is the **API-relative** path plus its query
   * (`/v1/stream?machine_id=…&seq=5`), never the URL as sent.
   *
   * That looks backwards -- surely the signature should cover the bytes on the
   * wire? -- so here is the case that settles it. With `rabbitUrl =
   * https://host/w2m` there are two proxy shapes, and the client cannot tell
   * them apart:
   *
   *   * the proxy forwards `/w2m/v1/heartbeat` and the relay strips its
   *     `--base-path` itself;
   *   * the proxy strips `/w2m` and the relay never sees the prefix at all.
   *
   * In the second shape the relay *cannot* reconstruct `/w2m/v1/heartbeat` --
   * those bytes never reached it -- so a signature over the wire path can never
   * verify there, and every request 401s. The one value both sides always agree
   * on is the path *after* routing: `/v1/heartbeat`. That is what is signed.
   * (The verifier's side of the same argument is PROTOCOL-v0.3.0 §9.4.)
   *
   * The gate is deliberately absolute: with no secret configured this returns an
   * empty object, so the wire is byte-identical to v0.2.3 (a hard
   * backward-compatibility requirement, asserted in the tests). A relay that
   * *requires* signatures then answers 401 with its own code, which the caller
   * surfaces rather than masking.
   *
   * @param {'GET'|'POST'} method
   * @param {string} apiPath API-relative path, query included when there is one.
   * @param {string|Buffer} [bodyText] Exact body bytes that will be sent.
   * @returns {Record<string, string>}
   */
  function signingHeaders(method, apiPath, bodyText = '') {
    if (!signer) return {};
    return signer.headers({ method, path: apiPath, body: bodyText });
  }

  /**
   * The relay's machine-readable error code from a response body.
   *
   * Kept separate so a 401 says `SIGNATURE_REQUIRED` (or whatever the relay
   * decided) instead of a generic "unauthorized": on a signed link the code is
   * the difference between "your clock is off" and "your secret is wrong".
   *
   * @param {{json?: any}} response
   * @returns {string|null}
   */
  function relayErrorCode(response) {
    const code = response?.json?.error?.code;
    return typeof code === 'string' && code !== '' ? code : null;
  }

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
    const target = url(path);
    // Stringify once: the signature must cover the exact bytes that go on the
    // wire, so it can never be computed from a second, differently-ordered copy.
    const bodyText = JSON.stringify(body);
    Object.assign(headers, signingHeaders('POST', path, bodyText));
    const response = await fetchImpl(target, {
      method: 'POST',
      headers,
      body: bodyText,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    const result = { status: response.status, ok: response.ok, json, text };
    if (!response.ok) {
      // Remember the last refusal so diagnostics can name it (and so a 401 is
      // distinguishable from a 500 at a glance). One request at a time per agent, so there is no
      // concurrent writer here and no disable is needed.
      state.lastRelayError = {
        at: new Date().toISOString(),
        http_status: response.status,
        code: relayErrorCode(result) ?? `HTTP_${response.status}`,
        path,
      };
    }
    return result;
  }

  /** @param {string} path @param {object} body @param {number} [retries] */
  async function postJsonWithRetry(path, body, retries = resultRetries) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (state.stopped) break;
      try {
        const response = await postJson(path, body);
        if (response.ok) return response;
        // A 4xx is permanent: retrying a rejected signature or a bad request
        // only burns the lease window.
        if (response.status >= 400 && response.status < 500) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < retries) await sleep(backoffDelay(attempt));
    }
    if (lastError) log('warn', `${path} failed`, { error: lastError.message });
    return null;
  }

  /**
   * GET JSON and decode the response body (v0.4.0).
   *
   * The mirror of {@link postJson} for the one read the direct path needs: a peer's announced
   * candidates (`GET /v1/peer/{machineId}`). Signed exactly like every other request, so the
   * P2P signalling routes cannot be the one place a signed link silently stops being signed.
   *
   * It deliberately does **not** record `state.lastRelayError` the way `postJson` does. A 404 here
   * is the ordinary answer for "this machine has not announced", which is a normal state in
   * `auto` mode -- recording it as the last relay error would make a healthy link look broken
   * every time a relay-only peer was dialled.
   *
   * @param {string} path
   * @returns {Promise<{status: number, ok: boolean, json: any, text: string, error: string|null}>}
   */
  async function getJson(path) {
    const headers = { accept: 'application/json' };
    if (token()) headers.authorization = `Bearer ${token()}`;
    Object.assign(headers, signingHeaders('GET', path));
    let response;
    try {
      response = await fetchImpl(url(path), { method: 'GET', headers });
    } catch (error) {
      // Returned rather than thrown: `P2PNode.dial()` names a lookup failure with its own code, and
      // an exception crossing that boundary would be reported as a punch failure instead.
      return { status: 0, ok: false, json: null, text: '', error: error?.message ?? String(error) };
    }
    const text = await response.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, json, text, error: null };
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
    // Pairing runs once, from the CLI, before any loop starts, so there is no interleaving here.
    // eslint-disable-next-line require-atomic-updates -- single call site, no concurrency
    identity.device_token = response.json.device_token;
    // eslint-disable-next-line require-atomic-updates -- single call site, no concurrency
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
          // The relay's own code, not a paraphrase: SIGNATURE_EXPIRED and
          // SIGNATURE_REQUIRED need different fixes.
          code: relayErrorCode(response),
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
   * The `p2p` block of a result envelope (v0.4.0 §6).
   *
   * It is built **before** `envelope_sha256` is computed, because the hash covers the whole
   * envelope: attaching these fields afterwards would leave a hash that does not cover the bytes
   * it claims to cover, and `verifyEnvelope` would fail on an envelope nobody tampered with. That
   * is also why the direct copy uses the very same object -- one envelope, two deliveries.
   *
   * Every field answers a question a reader of a *stored* result actually asks:
   *
   *   * `mode`      -- this agent's configured mode, or the dispatcher's when it stated one. The
   *                   dispatcher's value is used when present because a task dispatched by an
   *                   `auto` machine may be executed by a `direct` one, and "why did this path
   *                   win" is a question about the dispatcher's intent.
   *   * `offer_path`-- how the offer got here, as this agent observed it (never as claimed on the
   *                   wire: only the channel path can set it).
   *   * `result_path`-- `'p2p'` **only** when the envelope was acknowledged over the direct
   *                   channel. Absent means "no direct result", which is not the same fact as
   *                   `'relay'` and must not be spelled as one.
   *   * `reason`    -- why the direct path was not the answer, or null when it was.
   *   * `rtt_ms`    -- the punch's measured round trip, or null. Null rather than 0: a round trip
   *                   that was never measured is not an instantaneous one.
   *   * `peer`      -- the peer's address as seen by this agent, or null for an inbound channel
   *                   (a HELLO carries a session, not an identity).
   *   * `session`   -- the punch's session id, which is what correlates two agents' logs.
   *   * `mapping`   -- the NAT mapping this agent's announcement measured.
   *
   * v0.4.x adds three more, because "the result came back over the relay" and "the result came back
   * over the relay *after this machine spent eight seconds dialling*" are different operational
   * facts and the v0.4.0 block could not tell them apart:
   *
   *   * `opened_by` -- which mechanism opened the channel, named rather than inferred:
   *                   `dispatcher-punch` (the dispatcher's outbound HELLO landed), `simultaneous-punch`
   *                   (this machine dialled as the offer arrived, and that is what opened both
   *                   filters), `result-reverse-dial` (this machine dialled once the result was
   *                   ready). Absent when no channel carried anything.
   *   * `reverse_dial` -- `'p2p'` when this machine's own dial opened a channel, `'relay'` when it was
   *                   attempted and did not. Absent when it was never attempted, which is not a
   *                   failure and must not be spelled as one.
   *   * `reverse_dial_reason` -- the named code when the dial did not open a channel
   *                   (`P2P_REVERSE_DIAL_TIMEOUT`, `P2P_REVERSE_DIAL_FAILED`), or null.
   *   * `result_error` -- why the direct copy of *this result* did not land, when one was attempted
   *                   and not acknowledged (`P2P_ACK_TIMEOUT: …`). Null otherwise; this is the
   *                   `delivery.error` that `p2pDeliveryMark` has always carried and the envelope
   *                   never reported.
   *
   * @param {object} context
   * @returns {object}
   */
  function envelopeP2P(context) {
    const offer = context.offer ?? {};
    const transport = context.p2pTransport ?? offerTransportOf(offer, p2pStatusSnapshot());
    const delivery = context.p2pDelivery ?? p2pDeliveryMark();
    const record = context.p2pRecord ?? null;
    const reverse = context.p2pReverse ?? null;
    const dispatcherMode = offer?.p2p?.mode;

    /**
     * Which mechanism opened the channel that carried the offer or the result.
     *
     * Identity, not timing: the record keeps the channel object its dial opened, so "the reverse dial
     * is what carried this result" is a comparison of two references rather than a guess from the
     * order things happened in. A channel that arrived on its own can only be the dispatcher's punch.
     */
    const usedChannel = channelFor(offer?.task_id);
    let openedBy = null;
    if (delivery.path === 'p2p') {
      if (reverse?.ok === true && reverse.channel !== null && reverse.channel === usedChannel) {
        openedBy = reverse.stage === 'result'
          ? P2P_OPENED_BY.RESULT_REVERSE_DIAL
          : P2P_OPENED_BY.SIMULTANEOUS_PUNCH;
      } else {
        openedBy = P2P_OPENED_BY.DISPATCHER_PUNCH;
      }
    } else if (transport.offer_path === 'p2p') {
      openedBy = P2P_OPENED_BY.DISPATCHER_PUNCH;
    }

    return {
      mode: typeof dispatcherMode === 'string' && dispatcherMode !== '' ? dispatcherMode : p2pMode,
      offer_path: transport.offer_path,
      ...(delivery.path === null ? {} : { result_path: delivery.path }),
      ...(openedBy === null ? {} : { opened_by: openedBy }),
      ...(reverse === null || reverse.attempted !== true
        ? {}
        : { reverse_dial: reverse.ok === true ? 'p2p' : 'relay' }),
      ...(reverse !== null && typeof reverse.reason === 'string' && reverse.reason !== ''
        ? { reverse_dial_reason: reverse.reason }
        : {}),
      // The key is OMITTED when there is nothing to explain, and that is not the same as setting it
      // to `undefined`: `JSON.stringify` would drop that, but the envelope hash is computed with JCS,
      // whose implementation (rightly) refuses a non-JSON value. Measured -- `reason: undefined`
      // here made every direct-path result fail to build its envelope with
      // `jcs: property reason is undefined`, so the task executed and then vanished from the ledger.
      ...(typeof transport.reason === 'string' && transport.reason !== '' ? { reason: transport.reason } : {}),
      rtt_ms: delivery.rtt_ms ?? record?.rtt_ms ?? null,
      // The peer address and session of whichever channel this machine holds for the task: the one
      // that carried the offer, or the one its own dial opened. For an inbound channel `peer` stays
      // null (a HELLO carries a session, not an identity) -- but a channel *this* machine dialled has
      // a peer address it chose, and reporting "no peer" there would hide the one address the punch
      // actually used.
      peer: record?.peer ?? (reverse?.ok === true && reverse.channel !== null ? { ...reverse.channel.peer } : null),
      session: record?.session ?? reverse?.session ?? null,
      mapping: p2pNode?.status.mapping ?? null,
      ...(delivery.asked === true && delivery.path === null && typeof delivery.error === 'string' && delivery.error !== ''
        ? { result_error: delivery.error }
        : {}),
    };
  }

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
      pipeline,
      protocolViolations,
    } = context;

    const stdout = execution?.stdout ?? Buffer.alloc(0);
    const normalized = normalizeOutput(stdout, comparePolicy ?? {});

    /**
     * The stage descriptors the pipeline hash is taken over, or null for a single command.
     *
     * Normalized exactly as the relay normalizes them (`cwd_rel` defaults to the task cwd,
     * `continue_on_failure` to false), because the two sides must hash the same shape or every
     * pipeline anchors as `unverifiable`.
     */
    const pipelineHashMaterial = pipeline && Array.isArray(pipeline.stages) && pipeline.total_stages > 1
      ? pipeline.stages.map((s) => ({
        command_argv: s.command_argv,
        cwd_rel: s.cwd_rel ?? cwdRel,
        continue_on_failure: s.continue_on_failure === true,
      }))
      : null;

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
      // A pipeline's hash covers the whole chain, matching the relay's `computePipelineCommandHash`.
      // Hashing only stage 0 would make every pipeline `unverifiable` at the anchor -- the machine ran
      // exactly what it was asked and the relay still could not confirm it.
      command_hash: pipelineHashMaterial === null
        ? commandHash(commandArgv, SHELL_ID, cwdRel)
        : pipelineCommandHash(pipelineHashMaterial, SHELL_ID),
      // The material the pipeline hash was taken over. Kept in the envelope so a mismatch can be
      // diagnosed from the result itself rather than by re-running with instrumentation -- which is
      // what was needed to find the relay/agent disagreement this field now prevents. Present only for
      // a chain, so a single-command envelope is byte-unchanged.
      ...(pipelineHashMaterial === null ? {} : { pipeline_hash_material: pipelineHashMaterial }),
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

    // v0.3.3 `pipeline` (§5.2 optional). Present only for a chain, so a single-command envelope is
    // byte-identical to before -- which is what keeps a v0.2.3 relay able to verify this one.
    //
    // The per-stage record is the point: a final exit code cannot distinguish "stage 3 failed" from
    // "stages 3..5 never ran", and those need different responses from a reader.
    if (pipeline && typeof pipeline === 'object') {
      envelope.pipeline = pipeline;
    }
    if (Array.isArray(protocolViolations) && protocolViolations.length > 0) {
      envelope.protocol_violations = protocolViolations;
    }

    // v0.4.0 §6. Always present, like the relay's own offer fields and for the same reason: a
    // v0.3.9 machine and an `auto` one are then distinguishable from the stored envelope alone,
    // instead of `transport` being absent both when the direct path was never tried and when it
    // was tried and lost. `transport` is how the *offer* arrived; `p2p.result_path` is how the
    // *result* left. They are different facts and are allowed to differ -- a relay offer can be
    // answered over a channel the agent opened for that task.
    const transport = context.p2pTransport ?? offerTransportOf(offer, p2pStatusSnapshot());
    envelope.transport = transport.offer_path;
    envelope.p2p = envelopeP2P({ ...context, p2pTransport: transport });
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
    // v0.3.3: a pipeline carries its chain in `stages`. Validated here rather than trusted, because
    // a malformed chain would otherwise run partially and report a result for work it never did.
    if (offer.stages !== undefined) {
      if (offer.mode !== 'pipeline') return 'STAGES_WITHOUT_PIPELINE_MODE';
      if (!Array.isArray(offer.stages) || offer.stages.length === 0) return 'STAGES_NOT_NON_EMPTY_ARRAY';
      if (offer.stages.length > MAX_STAGES) return 'TOO_MANY_STAGES';
      for (const stage of offer.stages) {
        if (!Array.isArray(stage?.command_argv) || stage.command_argv.length === 0) return 'STAGE_COMMAND_ARGV_MISSING';
        if (!stage.command_argv.every((part) => typeof part === 'string')) return 'STAGE_COMMAND_ARGV_NOT_STRINGS';
      }
    }
    return null;
  }

  /**
   * Does this agent's mode allow the offer to run at all (v0.4.0 §1)?
   *
   * `direct` is the one mode where the *transport* is a gate rather than a preference, and it is
   * deliberately total: any offer that did not arrive over a channel is refused, including one
   * that arrived over the relay while a punch for the same task was still being attempted. The
   * alternative -- accepting the relay's copy when a channel happens to exist -- would make the
   * mode's meaning depend on a race, which is exactly the ambiguity `direct` exists to remove
   * ("a failed punch is not hidden").
   *
   * @param {object} offer
   * @returns {{reason: string, detail: string}|null}
   */
  function p2pRefusal(offer) {
    if (p2pMode !== 'direct') return null;
    if (offer.p2p_transport === 'p2p') return null;
    return {
      reason: REFUSAL.P2P_UNAVAILABLE,
      detail: 'p2pMode is "direct" and this offer arrived over the relay',
    };
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
      key: identityKeyFor(offer),
    };

    // ---- 0. mode gate (v0.4.0 §1) ----------------------------------------
    // Checked before the spool: a refusal is not a run. Spooling it would leave a `claimed` entry
    // whose envelope is written by `deliver`, which would in turn claim a task that never executed
    // -- so the refusal is answered and the attempt is done.
    const refusal = p2pRefusal(offer);
    if (refusal) {
      log('warn', `refused ${offer.task_id}: ${refusal.reason}`, { detail: refusal.detail });
      runAbort = null;
      state.current = null;
      state.handled += 1;
      await finish({
        offer,
        cwdRel,
        commandArgv,
        anchorsBefore: null,
        anchorsAfter: null,
        execution: null,
        status: 'refused',
        refusalReason: refusal.reason,
        warnings: [`P2P_UNAVAILABLE: ${refusal.detail}`],
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });
      return;
    }

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

    // ---- 1b. the two-way punch (v0.4.x) ----------------------------------
    // Started here, and *started* rather than awaited: the dispatcher may be behind a symmetric NAT
    // that swallowed its push, and a packet from this machine is the only thing that can open the
    // other half of that path. Everything the relay does today happens exactly as it did -- the
    // lease heartbeat, the gates, the command, the relay copy of the result -- while this runs
    // beside it for a bounded window. Nothing below waits for it; the result path is the one place
    // that reads its outcome, and even there only to decide `result_path`.
    startReverseDial(offer);

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
      //
      // Every offer has at least one stage: a single-command task is the one-stage case (the relay
      // normalizes it that way), so there is no separate branch for the chain. `pipeline` adds
      // ordering and stop-on-failure, not a second execution path.
      const isPipeline = Array.isArray(offer.stages) && offer.stages.length > 0;
      const plannedStages = isPipeline
        ? offer.stages.map((s, i) => ({
          index: i,
          command_argv: [...s.command_argv],
          cwd_rel: typeof s.cwd_rel === 'string' && s.cwd_rel ? s.cwd_rel : (offer.cwd_rel ?? '.'),
          continue_on_failure: s.continue_on_failure === true,
        }))
        : [{ index: 0, command_argv: [...offer.command_argv], cwd_rel: offer.cwd_rel ?? '.', continue_on_failure: false }];

      // The task's timeout is a budget for the whole chain, not per stage. Giving each stage the full
      // timeout would let a 16-stage pipeline run 16x longer than the caller asked for, and the relay
      // would have given up long before.
      const totalBudgetMs = Number.isFinite(offer.timeout_ms) ? offer.timeout_ms : DEFAULT_TIMEOUT_MS;
      const chainStartedAt = Date.now();

      const stageReports = [];
      /** The last stage's execution, used for the envelope's top-level exit code and output hashes. */
      let execution = null;
      let stoppedAt = null;
      const protocolViolations = [];

      for (const stage of plannedStages) {
        heartbeat.setPhase('running', 50);

        const stageCwdOutcome = resolveProjectCwd(project, stage.cwd_rel);
        if (!stageCwdOutcome.ok) {
          // A stage whose cwd is outside the project is a refusal of the whole chain: continuing
          // would run later stages against a working directory the caller never asked for.
          protocolViolations.push(`stage ${stage.index}: ${stageCwdOutcome.reason}`);
          stageReports.push({
            index: stage.index,
            command_argv: stage.command_argv,
            cwd_rel: stage.cwd_rel,
            status: 'refused',
            refusal_reason: stageCwdOutcome.reason,
            exit_code: null,
            duration_ms: 0,
          });
          stoppedAt = stage.index;
          break;
        }

        const elapsedMs = Date.now() - chainStartedAt;
        const remainingMs = totalBudgetMs - elapsedMs;
        if (remainingMs <= 0) {
          warnings.push('PIPELINE_BUDGET_EXHAUSTED');
          stageReports.push({
            index: stage.index,
            command_argv: stage.command_argv,
            cwd_rel: stage.cwd_rel,
            status: 'timeout',
            exit_code: null,
            duration_ms: 0,
          });
          stoppedAt = stage.index;
          break;
        }

        const ran = await runArgv(stage.command_argv, {
          cwd: stageCwdOutcome.cwd,
          timeoutMs: remainingMs,
          maxOutputBytes,
          signal: controller.signal,
        });
        execution = ran;
        for (const warning of ran.warnings) if (!warnings.includes(warning)) warnings.push(warning);

        const stageStatus = classifyExit(ran);
        stageReports.push({
          index: stage.index,
          command_argv: stage.command_argv,
          cwd_rel: stageCwdOutcome.cwd_rel ?? stage.cwd_rel,
          // Carried so the agent's pipeline hash covers the same shape the relay hashes. Omitting it
          // would make the two disagree the moment a caller sets `continue_on_failure: true`.
          continue_on_failure: stage.continue_on_failure,
          status: stageStatus,
          exit_code: ran.exit_code,
          duration_ms: ran.duration_ms,
          stdout_sha256: ran.stdout_sha256,
          stderr_sha256: ran.stderr_sha256,
        });

        if (ran.timed_out) log('warn', `${offer.task_id} stage ${stage.index} timed out`);
        if (ran.cancelled) log('warn', `${offer.task_id} stage ${stage.index} was cancelled`);

        if (stageStatus !== 'ok' && !stage.continue_on_failure) {
          stoppedAt = stage.index;
          break;
        }
      }

      heartbeat.setPhase('finalizing', 90);
      if (execution === null) {
        // Nothing ran at all (a refused first stage, or a budget already spent). `execution` stays
        // null, which `finish` renders as an empty-output envelope -- the honest shape for "no
        // command produced output".
        log('warn', `${offer.task_id} ran no pipeline stage`);
      }
      if (execution?.timed_out) log('warn', `${offer.task_id} timed out after ${offer.timeout_ms}ms`);
      if (execution?.cancelled) log('warn', `${offer.task_id} was cancelled`);

      const anchorsAfter = await safeAnchors(warnings);
      const status = execution ? classifyExit(execution) : (protocolViolations.length > 0 ? 'refused' : 'unverifiable');

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
        // v0.3.3: the per-stage record travels with the envelope so a reader can see which stage
        // failed and which never ran, instead of only a final exit code.
        pipeline: isPipeline
          ? {
            total_stages: plannedStages.length,
            completed_stages: stageReports.length,
            stopped_at: stoppedAt,
            stages: stageReports,
          }
          : null,
        protocolViolations,
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
          // The error text travels with the envelope. Without it, a crashed pipeline is visible only as
          // `status: crashed` on the wire and the cause has to be reproduced to be seen -- which is
          // exactly the situation this field was added to end.
          warnings: [...warnings, 'AGENT_ERROR', `AGENT_ERROR_DETAIL: ${error?.message ?? String(error)}`],
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

  /**
   * Try the direct path for one attempt, before the envelope exists.
   *
   * WHY THIS RUNS FIRST, AND WHY THE FRAME IS NOT THE ENVELOPE
   *
   * `result_path` is `'p2p'` only when the envelope was *actually acknowledged* over the channel,
   * and `envelope_sha256` covers the whole envelope -- so the fact has to be known before the
   * envelope is built, or the hash would not cover the bytes it claims to cover. The obvious way
   * out would be to send the finished envelope and stamp `result_path` afterwards, which is
   * precisely the mutation that would break `verifyEnvelope`. So the order is inverted instead:
   * announce the result on the channel (`{type:'task.result', task_id}`), wait for the dispatcher's
   * `{type:'result.ack', task_id}`, and only then build the one envelope that describes what
   * happened.
   *
   * The direct frame therefore carries the frame *type* and the task identity rather than the whole
   * envelope. That is a deliberate narrowing, and it is worth stating plainly: the fast path
   * currently saves the dispatcher the wait for the relay's copy, not the bytes. Carrying the full
   * envelope on the channel would need the envelope before the acknowledgement that decides one of
   * its fields -- see the note in the v0.4.0 report and `PROTOCOL-v0.4.0.md`'s open question.
   *
   * A channel is no longer a precondition (v0.4.x): when there is none, this dials the dispatcher
   * first (see `reverseDialPlan`) and uses the channel that opens. What has *not* changed is the
   * bound and the order -- the relay copy still goes out after this returns, whatever it decided, and
   * the whole function still costs at most one dial window plus one ack window.
   *
   * @param {object} offer
   * @param {string|null} [status] The outcome this envelope is about to report. A `refused` attempt
   *   has no direct result worth dialling for: nothing ran, the envelope that says so travels over
   *   the relay exactly as it does today, and paying the dial window for it would delay a refusal
   *   for no gain. The value matters only when no decision was recorded at offer time (the refusal
   *   path returns before the offer-time dial is started).
   * @returns {Promise<ReturnType<typeof p2pDeliveryMark>>}
   */
  async function planDirectDelivery(offer, status = null) {
    const taskId = typeof offer?.task_id === 'string' && offer.task_id !== '' ? offer.task_id : null;

    if (taskId !== null && channelFor(taskId) === null) {
      // ---- the result-path reverse dial (v0.4.x) ---------------------------
      // No channel: the offer came over the relay, or it came over a channel the dispatcher has since
      // closed (it closes the one it pushed the offer over, immediately after the push). Before the
      // relay carries the result -- which it still does, unchanged, in every failure case -- this
      // machine tries once, bounded, to dial the dispatcher itself. The attempt is *reused* when the
      // offer-time dial is still running or already finished, so a task pays for one window at most,
      // never two.
      if (!(status === 'refused' && p2pReverseDials.get(taskId) === undefined)) {
        const record = startReverseDial(offer, { stage: 'result', afterLiveChannel: true });
        if (record !== null && record.attempted === true && record.promise !== null) {
          // Bounded by construction: `dial()` resolves at the tuning window or on the first answer.
          await record.promise;
        }
      }
    }

    if (channelFor(offer?.task_id) === null) return p2pDeliveryMark();
    const direct = await sendResultDirect(offer.task_id);
    if (direct.delivered) {
      log('info', `result acknowledged over the direct channel for ${offer.task_id}`, {
        rtt_ms: direct.rtt_ms,
      });
      return p2pDeliveryMark({ path: 'p2p', asked: true, rtt_ms: direct.rtt_ms });
    }
    // A timeout is a reported failure; "no channel at all" is not, and `asked` keeps the two
    // apart for anything reading the agent's own diagnostics.
    log('warn', `direct result delivery failed for ${offer.task_id}; the relay copy is unaffected`, {
      error: direct.error,
    });
    return p2pDeliveryMark({ asked: true, error: direct.error });
  }

  /**
   * Announce one result on its direct channel and wait for the acknowledgement, bounded.
   *
   * This is the fast path, and it is deliberately *only* a fast path: the relay copy is posted by
   * the caller whatever happens here, so nothing in this function can lose a result. The wait is
   * bounded by {@link P2P_ACK_TIMEOUT_MS} for the same reason -- a dispatcher that stops answering
   * must cost the ledger a bounded delay, never a hang.
   *
   * It is deliberately **not** retried. `P2PChannel.send` already retransmits every fragment until
   * the peer acknowledges it; a retry on top would be a second retransmission protocol layered on
   * the first, and "the dispatcher is gone" is not a condition that improves by asking again.
   *
   * @param {string} taskId
   * @returns {Promise<{delivered: boolean, rtt_ms: number|null, error: string|null}>}
   */
  async function sendResultDirect(taskId) {
    const channel = channelFor(taskId);
    if (channel === null) return { delivered: false, rtt_ms: null, error: null };

    /** Why the wait ended without an ack, when the channel itself said so. */
    let lastAckError = null;
    let registration = null;
    const acked = new Promise((resolve) => {
      const timer = setTimeout(() => {
        p2pResultWaiters.delete(taskId);
        resolve(false);
      }, p2pAckTimeoutMs);
      // Never keep the process alive for an acknowledgement.
      timer.unref?.();
      registration = {
        settle: (value, reason) => {
          clearTimeout(timer);
          if (p2pResultWaiters.get(taskId) === registration) p2pResultWaiters.delete(taskId);
          if (value === false && typeof reason === 'string' && reason !== '') lastAckError = reason;
          resolve(value);
        },
      };
      p2pResultWaiters.set(taskId, registration);
    });

    const startedAt = process.hrtime.bigint();
    // `machine_id` travels with the notice because the dispatcher has to be able to say *which*
    // machine finished without waiting for the relay's copy — the plugin names its direct-result
    // inbox file after it. The frame still carries no envelope: `result_path` is decided by the
    // acknowledgement this frame is waiting for, and `envelope_sha256` covers `result_path`, so
    // sending the envelope first and stamping it afterwards would break the hash it is signed with.
    const frame = JSON.stringify({ type: 'task.result', task_id: taskId, machine_id: identity.machine_id });
    try {
      await channel.send(frame);
    } catch (error) {
      registration.settle(false, `P2P_SEND_FAILED: ${error?.message ?? String(error)}`);
    }

    const delivered = await acked;
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (delivered) return { delivered: true, rtt_ms: Math.round(elapsed * 100) / 100, error: null };
    return {
      delivered: false,
      rtt_ms: null,
      error: lastAckError ?? `P2P_ACK_TIMEOUT: no result.ack within ${p2pAckTimeoutMs}ms`,
    };
  }

  /** Build, spool, send and acknowledge one envelope. */
  async function finish(context) {
    const anchorsAfter = context.anchorsAfter ?? (await safePostState(context.offer, context.warnings));
    const toolchain = await toolchainInfo();
    // The bounded wait happens *before* the envelope is built, because `result_path` has to be
    // inside the envelope when `envelope_sha256` is taken; see `sendResultDirect`.
    const p2pDelivery = context.p2pDelivery ?? (await planDirectDelivery(context.offer, context.status));
    // Read once, here, and handed to `makeEnvelope`: the envelope has to describe the dial that
    // decided its `result_path`, and the record is released with the channel a moment later.
    const p2pReverse = context.p2pReverse ?? reverseDialSummary(context.offer?.task_id);
    const envelope = makeEnvelope({
      ...context,
      anchorsAfter,
      toolchain,
      comparePolicy: context.offer.compare_policy,
      p2pDelivery,
      p2pReverse,
    });
    await deliver(envelope);
    // The attempt is over. The channel lingers (bounded) so a duplicate of this attempt can still be
    // answered on it, and is released afterwards; the dial's own bookkeeping is consumed by the
    // envelope above and released with it, so a long-lived agent keeps one record per *live* task.
    releaseDialRecord(envelope.task_id);
    scheduleChannelRelease(envelope.task_id);
    return envelope;
  }

  /**
   * Spool -> POST to the relay -> ack.
   *
   * The spool is written first, so a crash anywhere later leaves a replayable envelope; the relay
   * copy is posted **unconditionally**, because the relay is the ledger and the only writer allowed
   * to store a machine's result. The direct copy has already been attempted and boundedly awaited
   * by the time this runs (`planDirectDelivery`), and a failure there changes nothing here -- which
   * is the property `test/p2p-agent.test.mjs` pins down with a dispatcher that stops answering.
   */
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
      rememberCompleted(identityKeyFor(envelope), envelope);
      log('info', `result delivered for ${envelope.task_id}`, {
        status: envelope.status,
        transport: envelope.transport,
        result_path: envelope.p2p?.result_path ?? 'relay',
      });
      return true;
    }
    log('warn', `result kept in spool for ${envelope.task_id}`, {
      status: response?.status ?? null,
      code: relayErrorCode(response),
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
    // Signed once, at attach time, over the *API* path including its query: a
    // long-lived GET has no body, so the query (machine_id, and the resume seq
    // when we have a cursor) is the part of the request that must be bound.
    // Signing only the pathname is the classic mistake -- the tests prove such a
    // signature does not verify -- and signing the base-prefixed wire path would
    // break the "proxy strips the prefix" deployment (see signingHeaders).
    Object.assign(headers, signingHeaders('GET', `/v1/stream?${query.toString()}`));

    const response = await fetchImpl(streamUrl, { headers, signal: streamAbort.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let code = null;
      try {
        code = JSON.parse(body)?.error?.code ?? null;
      } catch {
        code = null;
      }
      const error = new Error(`stream HTTP ${response.status} ${body.slice(0, 200)}`.trim());
      // Preserve the relay's own code (SIGNATURE_REQUIRED, SIGNATURE_EXPIRED, …)
      // so a signed link can be diagnosed without guessing.
      error.code = code ?? `HTTP_${response.status}`;
      state.lastRelayError = {
        at: new Date().toISOString(),
        http_status: response.status,
        code: error.code,
        path: '/v1/stream',
      };
      throw error;    }
    if (!response.body) throw new Error('stream response had no body');

    // Both assignments mark the same stream attempt as no longer live: one before the read loop, one
    // after it ends. Only one stream runs at a time, so there is nothing to interleave with.
    // eslint-disable-next-line require-atomic-updates -- one stream attempt at a time
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

  /**
   * Decode one SSE frame and dispatch it.
   *
   * A thin wrapper on purpose (v0.4.0): the dispatch itself is `dispatchFrame`, so an SSE frame and
   * a JSON frame off a P2P channel reach *the same* handler. The alternative -- a second switch for
   * the direct path -- is how "the offer runs over either transport" quietly becomes "the offer
   * runs over the relay, and something almost like it runs over the channel".
   *
   * @param {{event: string, data: string, id: string|null}} frame
   */
  function handleFrame(frame) {
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      log('warn', 'ignoring unparseable SSE frame', { event: frame.event, data: frame.data.slice(0, 120) });
      return;
    }
    dispatchFrame(payload, { event: frame.event, id: frame.id ?? null, transport: 'relay' });
  }

  /**
   * One message arrived on a P2P channel.
   *
   * The body is a frame, not an offer: the W2M convention is the relay's own frame shape
   * (`{type:'task.offer', ...}`), so it is parsed with {@link parseP2PFrame} and then dispatched
   * exactly like an SSE frame would be.
   *
   * @param {{from: string|null, channel: object, peer: object, session: number, payload: unknown}} event
   */
  function handleP2PMessage(event) {
    const payload = parseP2PFrame(event.payload);
    if (payload === null) {
      log('warn', 'ignoring non-JSON frame on a P2P channel', {
        peer: event.peer ?? null,
        session: event.session ?? null,
        bytes: Buffer.isBuffer(event.payload) ? event.payload.length : null,
      });
      return;
    }
    dispatchFrame(payload, { event: payload.type, id: null, transport: 'p2p', channel: event.channel });
  }

  /**
   * The one dispatcher both transports feed.
   *
   * `transport` is the only difference between an offer from the relay and an offer from a channel,
   * and it is stamped onto the offer itself (`p2p_transport`) rather than carried alongside: the
   * dedupe path hands offers to `handleOffer` by reference and drops duplicates before they get
   * there, so the fact has to travel *with* the offer or it would be lost exactly when two copies
   * race -- which is the case it exists for.
   *
   * `state.seq` is advanced for relay frames only. A channel frame carries no `seq` (it never went
   * through the relay's event ring), and letting one move the cursor would make the agent tell the
   * relay it had already seen events it had not.
   *
   * @param {object} payload
   * @param {{event: string, id: string|null, transport: 'p2p'|'relay', channel?: object}} source
   */
  function dispatchFrame(payload, source) {
    const type = payload?.type ?? source.event;
    if (source.transport === 'relay') {
      if (Number.isInteger(payload?.seq)) state.seq = Math.max(state.seq, payload.seq);
      else if (source.id && /^\d+$/.test(source.id)) state.seq = Math.max(state.seq, Number(source.id));
    }

    switch (type) {
      case 'ready': {
        // A channel frame with this type is not the relay's `ready`: it is a dispatcher pushing a
        // frame it had no business pushing, and treating it as "connected" would mark an agent with
        // no stream as connected.
        if (source.transport !== 'relay') {
          log('info', 'ignoring a `ready` frame that did not come from the relay');
          break;
        }
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
      case 'task.offer': {
        // The transport travels *on* the offer (see this function's note). Any `p2p_transport` a
        // peer tried to put on the wire is overwritten, so a relay frame can never claim the
        // direct path -- the only thing that sets `'p2p'` here is the channel having delivered it.
        const offer = { ...payload, p2p_transport: source.transport };
        if (source.transport === 'p2p') {
          if (typeof offer.task_id !== 'string' || offer.task_id === '') {
            log('warn', 'ignoring a direct offer with no task_id');
            break;
          }
          // Remembered before the offer is queued: the result path must exist by the time the
          // result is produced, and a channel lost between the two would leave `result_path` null
          // with no way to tell why.
          rememberChannel(offer.task_id, source.channel);
        }
        enqueue(offer);
        break;
      }
      case 'task.cancel': {
        cancelTask(payload.task_id, payload.reason);
        break;
      }
      case 'result.ack': {
        // Only meaningful on a channel: an ack the relay relays is not evidence about the direct
        // path, and `result_path` must never be set from it.
        if (source.transport !== 'p2p') {
          log('info', `ignoring result.ack for ${payload.task_id} on the relay path`);
          break;
        }
        settleResultAck(payload.task_id);
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
        // Two different frames wear this type. From the relay it is the notice that a result
        // reached Rabbit. From a channel it is a *dispatcher* pushing a result at this agent
        // (machine A's result travelling to machine B directly) -- which this agent does not
        // consume in v0.4.0, and says so rather than pretending it was the relay's notice.
        if (source.transport === 'p2p') {
          log('info', `result for ${payload.task_id} arrived over a direct channel (not consumed by the executor)`, {
            status: payload.status,
          });
          break;
        }
        log('info', `result accepted for ${payload.task_id}`, {
          status: payload.status,
          deduped: payload.deduped === true,
        });
        break;
      default:
        log('info', `ignoring unknown event type ${type}`);
    }
  }

  /** Resolve the waiter for one result acknowledgement, if there is one. */
  function settleResultAck(taskId) {
    if (typeof taskId !== 'string' || taskId === '') return;
    const waiter = p2pResultWaiters.get(taskId);
    if (!waiter) {
      // An ack for an already-settled wait is ordinary: the direct copy is sent once, and a
      // dispatcher that re-acks a frame it processed twice must not resurrect anything.
      log('info', `result.ack for ${taskId} with no wait in flight`);
      return;
    }
    waiter.settle(true, null);
  }

  /** Drop a queued task and abort a running one (§3.4). Shared by both transports. */
  function cancelTask(taskId, reason) {
    const index = queue.findIndex((item) => item.task_id === taskId);
    if (index !== -1) queue.splice(index, 1);
    if (state.current && state.current.task_id === taskId) {
      log('warn', `task.cancel for running ${taskId}: ${reason ?? ''}`);
      state.current.controller.abort();
    } else {
      log('info', `task.cancel for idle ${taskId}`);
    }
  }

  /**
   * The dedupe identity of one offer (v0.4.0).
   *
   * Two facts drive this, and the second one is new:
   *
   *   * Rabbit's idempotency triple is `(machine_id, dedupe_key, attempt)` (§4.4), so `attempt` is
   *     part of the identity: a new attempt is a genuine retry and must run again.
   *   * The same offer now arrives over **two transports** -- pushed over a channel by the
   *     dispatcher and published over the relay's SSE stream -- and either may arrive first. They
   *     carry the same `task_id` and the same `dedupe_key`, so the identity must be computed from
   *     the lease's facts and never from the path the copy took. A P2P copy that deduped differently
   *     from the relay copy would execute a `write: true` command twice, which is the failure this
   *     whole mechanism exists to prevent.
   *
   * `task_id#attempt` is the fallback for an offer with no `dedupe_key`. It is intentionally
   * *weaker* than the documented triple and only reached by a dispatcher that omitted the field, so
   * it widens dedupe rather than narrowing it -- for the two-transport case the alternative is not
   * "no dedupe", it is "no dedupe at all", which is strictly worse.
   *
   * @param {{task_id?: string, dedupe_key?: string|null, attempt?: number}|null} offer
   * @returns {string|null}
   */
  function identityKeyFor(offer) {
    const taskId = typeof offer?.task_id === 'string' && offer.task_id !== '' ? offer.task_id : null;
    if (taskId === null) return null;
    const attempt = Number(offer?.attempt) || 1;
    const dedupeKey = typeof offer?.dedupe_key === 'string' && offer.dedupe_key !== '' ? offer.dedupe_key : null;
    return dedupeKey === null ? `${taskId}#${attempt}` : `${dedupeKey}#${attempt}`;
  }

  /**
   * Queue an offer, unless we already have it -- over either transport.
   *
   * Dedupe by the lease's identity (§4.4 plus v0.4.0's two-transport rule): a re-delivery of a task
   * we already finished is answered from the cache or the spool instead of being executed a second
   * time, which matters for `write: true` offers.
   *
   * The three checks are in the order that keeps the promise above true:
   *
   *   1. **already claimed** -- queued, running, or already executed. Answered without touching the
   *      queue. This is the branch the direct-path duplicate hits while the first copy is still
   *      running: the second copy is recorded (its channel, if it came over one) and dropped.
   *   2. **cached envelope** -- the attempt finished and the relay accepted it. The envelope is
   *      re-delivered, which is v0.3.9's behaviour and is safe because the relay dedupes it.
   *   3. **spooled envelope** -- the attempt finished but the relay has not confirmed it yet.
   *
   * A copy that arrives *while* the first is running therefore never re-executes and never produces
   * a second result. `pump` is single-entry and `claimed` is written synchronously, so there is no
   * interleaving between the check and the write.
   *
   * @param {object} offer
   */
  function enqueue(offer) {
    const attempt = Number(offer?.attempt) || 1;
    const key = identityKeyFor(offer);

    if (key !== null && claimed.has(key)) {
      // The claim covers exactly the window in which a second copy must not start a second run:
      // from here until `handleOffer` has delivered its envelope. The channel (if this copy came
      // over one) was already remembered by `dispatchFrame`, so the result will reach it.
      log('info', `ignoring duplicate offer ${offer.task_id} attempt ${attempt} (already claimed, arrived over ${offer.p2p_transport ?? 'relay'})`);
      return;
    }

    if (key !== null) {
      const cached = completed.get(key);
      if (cached) {
        log('info', `dedupe hit: resending cached result for ${offer.task_id} attempt ${attempt}`);
        void deliver(cached);
        // If this copy arrived over a channel, the dispatcher is waiting for an answer on it. The
        // relay copy above is the durable one; this notice is what stops the dispatcher's bounded
        // wait from expiring on a task that is already finished. Fire-and-forget: the answer is a
        // courtesy, and failing to give it must never affect the spooled envelope.
        if (offer.p2p_transport === 'p2p' && channelFor(offer.task_id) !== null) {
          void sendResultDirect(offer.task_id).catch(() => {});
        }
        return;
      }
      const spooled = spool.pendingResults().find((record) => {
        if (!record.envelope) return false;
        return identityKeyFor({
          task_id: record.task_id,
          dedupe_key: record.dedupe_key ?? record.envelope.dedupe_key,
          attempt: record.attempt,
        }) === key;
      });
      if (spooled) {
        log('info', `dedupe hit: resending spooled result for ${offer.task_id} attempt ${attempt}`);
        void deliver(spooled.envelope);
        return;
      }
      claimed.add(key);
    }
    queue.push({ offer, key });
    void pump();
  }

  /** Serial worker: one task at a time, in arrival order. */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !state.stopped) {
        const item = queue.shift();
        const offer = item.offer;
        try {
          await handleOffer(offer);
        } catch (error) {
          // A throw here must not kill the stream loop or wedge the queue.
          log('error', `unhandled failure in ${offer?.task_id ?? 'offer'}`, {
            error: error?.message ?? String(error),
          });
        } finally {
          // Released here, not in `handleOffer`: an offer that threw before delivering must still
          // become runnable again, or a bug would turn into a task that can never be retried.
          if (item.key !== null) claimed.delete(item.key);
        }
        if (once) {
          stop();
          break;
        }
      }
    } finally {
    // The pump is single-entry: `pumping` is set before the first await and cleared here, so a second
    // pump cannot be running to observe a stale value.
    // eslint-disable-next-line require-atomic-updates -- single-entry pump
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

  /**
   * Stop the stream, the running command, the heartbeat and the direct path.
   *
   * Returns a promise so a caller can wait for the node's socket to be gone -- `close()` on the node
   * is asynchronous (it waits for the accept loop to end). Callers that do not care still get the
   * old fire-and-forget behaviour by ignoring the value; `w2m-localside` does not, because "the
   * process exited" and "the port was released" are different facts on Windows.
   *
   * @returns {Promise<void>}
   */
  function stop() {
    if (state.stopped) return Promise.resolve();
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
    // The node is closed last: it is the only part of `stop()` that is asynchronous, and everything
    // above must already be winding down before a channel can deliver a payload into a stopped agent.
    return closeP2P();
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
      p2p_mode: p2pMode,
    });
    if (allowedCommands.length === 0) {
      log('warn', 'no --allowed-commands configured: every offer will be refused (default-deny)');
    }

    // v0.4.0: bring the direct path up first, so a channel exists before the first offer can arrive
    // on one. Failures are recorded, never fatal -- see `startP2P`.
    await startP2P();

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
    /**
     * The direct path, for a caller that needs more than the summary (v0.4.0).
     *
     * Null in `relay` mode forever, and null until `start()` has built one. Exposed rather than
     * hidden because "which port did this machine announce?" is a question an operator asks with
     * `netstat` open, and the answer belongs to the object that owns the socket.
     */
    get p2pNode() {
      return p2pNode;
    },
    /** The mode this agent was built with, validated at construction. */
    p2pMode,
    /** The STUN list the node queries, in order; null when there is no node. */
    p2pStunServers,
    /** Bring the direct path up on its own (also done by `start()`); never fatal. */
    startP2P,
    /** Close the direct path on its own (also done by `stop()`). */
    closeP2P,
    /**
     * Feed one already-decoded frame into the dispatcher both transports use (v0.4.0).
     *
     * Exists because "an offer from a channel" and "an offer from the relay" differ in exactly one
     * value, and a caller that needs a specific arrival order -- a test, or a future tool that
     * injects a frame -- should not have to open a socket to express it. `transport` is the only
     * thing it controls; the dedupe, the queue and the result path are the same code either way,
     * which is what makes an injected frame a fair test of the real path.
     *
     * @param {object} payload A frame (`{type:'task.offer', ...}`).
     * @param {{transport?: 'p2p'|'relay', channel?: object}} [origin]
     */
    ingest(payload, origin = {}) {
      dispatchFrame(payload, {
        event: typeof payload?.type === 'string' ? payload.type : 'message',
        id: null,
        transport: origin.transport === 'p2p' ? 'p2p' : 'relay',
        channel: origin.channel,
      });
    },
    /** Whether request signing is configured (v0.3.0). */
    signingEnabled: signer !== null,
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
