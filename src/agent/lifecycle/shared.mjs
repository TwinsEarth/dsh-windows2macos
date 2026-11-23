/**
 * Shared foundation of the Localside agent's lifecycle phases.
 *
 * This module is the base of an acyclic composition:
 *
 *   shared  <- deliver <- execute <- offer <- heartbeat <- agent.mjs
 *
 * Nothing here holds per-agent state. The constants and pure helpers are the
 * module's public surface (re-exported unchanged from `../agent.mjs`, which is
 * what `bin/` and the suites import). `createAgentShared()` builds the HTTP
 * client and the pairing exchange the phases share: the original single
 * `createAgent()` closure kept the same values per agent, and so does this
 * factory -- there is no module-level mutable state in this directory.
 */

import { access, constants as fsConstants } from 'node:fs/promises';

import { deliverArtifact } from '../artifact-delivery.mjs';
import { envelopeSha256 } from '../git.mjs';
import { deriveSigningKey } from '../crypto.mjs';
import { joinUrl } from '../url.mjs';

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
 * How many times `publishState()` tries the final `renameSync` before giving up, and the base of
 * the synchronous backoff between tries (attempt N waits N * base).
 *
 * The publish renames a temp file *over* `agent-state.json` while another process may be reading
 * it -- the plugin in the DSH host, an editor, a backup agent, or an antivirus scanner. On Windows
 * that contention comes back as `EPERM`/`EACCES` from the rename even though both paths are fine,
 * and the condition clears within milliseconds; without a retry the publish is lost, and (before
 * v0.5.10) its temp file was left behind, which is how one live state directory accumulated 266
 * `agent-state.json.tmp-*` files.
 *
 * Bounded on purpose: 5 attempts, and only a retryable error is retried, so a permanent failure
 * (the destination is a directory, the volume is gone, the paths are on different devices) costs at
 * most 30ms of synchronous backoff on a diagnostics-only path.
 */
export const STATE_RENAME_ATTEMPTS = 5;
export const STATE_RENAME_BACKOFF_MS = 3;

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
  // v3.5.8: the result travelled over the WebRTC DataChannel pool. It is distinct from a UDP
  // punch because "WebRTC worked" and "UDP hole punching worked" are different operational facts,
  // and an operator debugging a cross-network pair needs to know which one carried the bytes.
  WEBRTC_DATA_CHANNEL: 'webrtc-data-channel',
});

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
    // v3.5.8: which direct stack actually carried the result. `null` when no direct attempt ran or
    // when the attempt failed; `'webrtc-v1'` / `'udp-v1'` when one delivered. Kept separate from
    // `path` because a reader that only knows `p2p` must keep working, while a fleet debugging a
    // cross-network pair needs the exact stack.
    transport: typeof value.transport === 'string' && value.transport !== '' ? value.transport : null,
    attempts: Number.isInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
    // The attempts made before a fallback delivered, when the preferred stack failed first. Kept
    // as a fact rather than a boolean so "WebRTC failed once then UDP worked" is readable.
    fallback_from: typeof value.fallback_from === 'string' && value.fallback_from !== '' ? value.fallback_from : null,
  };
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
export function identityKeyFor(offer) {
  const taskId = typeof offer?.task_id === 'string' && offer.task_id !== '' ? offer.task_id : null;
  if (taskId === null) return null;
  const attempt = Number(offer?.attempt) || 1;
  const dedupeKey = typeof offer?.dedupe_key === 'string' && offer.dedupe_key !== '' ? offer.dedupe_key : null;
  return dedupeKey === null ? `${taskId}#${attempt}` : `${dedupeKey}#${attempt}`;
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
/**
 * Build the request/identity helpers every phase shares.
 *
 * @param {object} deps The composition bag assembled by `createAgent()`.
 */
export function createAgentShared(deps) {
  const {
    baseUrl,
    identity,
    signer,
    fetchImpl,
    state,
    log,
    stateDir,
    platform,
    caps,
    deviceKey,
    resultRetries,
  } = deps;

  const token = () => identity.device_token;

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
   * (`/v1/stream?machine_id= - seq=5`), never the URL as sent.
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

  /**
   * PUT one stage's stdout to the relay's content-addressed blob store (v1.2.4).
   *
   * The relay's blob route is device-gated and content-addressed: the name IS the hash, so a body that does not hash to it
   * would be stored under the wrong name. The caller hashes first and passes that name, which also means the assistant's
   * envelope can refer to the blob before the upload finishes without inventing an identifier.
   *
   * Returns the refusal instead of throwing: a pipeline stage fails as a stage, with BLOB_UPLOAD_FAILED, because that is
   * the fact a reader needs. `{ status }` is the HTTP status when there was a response, 0 when the call itself failed.
   *
   * @param {string} sha256
   * @param {string} body
   * @returns {Promise<{ok: boolean, status: number, sha256?: string, code?: string}>}
   */
  async function putBlobBytes(sha256, body, kind = 'stdout', taskId = null) {
    // A3/S4: artifacts leave through the user's sink (dir/git/ssh), never through the relay.
    // Without a sink the bytes are kept locally and the caller reports ARTIFACT_NOT_DELIVERED;
    // the relay is not contacted at all.
    const delivered = await deliverArtifact({
      stateDir,
      kind,
      bytes: body,
      taskId: typeof taskId === 'string' && taskId !== '' ? taskId : 'unknown-task',
      machineId: identity.machine_id,
    });
    if (delivered.ok === true) return { ok: true, status: 200, sha256: delivered.sha256, ref: delivered.ref };
    return { ok: false, status: 0, code: delivered.code ?? 'ARTIFACT_NOT_DELIVERED', reason: delivered.reason ?? null, local: delivered.local ?? null };
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
  /**
   * Pair this machine, by **either** an operator's code **or** the account's fleet key (v0.8.1).
   *
   * The two authorise different things, which is why both are accepted rather than one replacing the
   * other:
   *
   *   * a **pairing code** is the operator saying *"let this machine in"*, and it is the only way to
   *     place a device in a fleet the device could not compute for itself;
   *   * a **fleet key** is the account saying *"this machine is mine"*, and the relay derives the
   *     fleet from it  - so it can only ever reach a fleet its holder is already entitled to.
   *
   * Passing neither remains allowed: the relay answers `PAIRING_INVALID` and the caller reports it,
   * which is the pre-v0.8.1 behaviour for an unpaired machine.
   */
  async function pair(pairingCode, userId, fleetKey = null) {
    const body = {
      machine_id: identity.machine_id,
      machine_name: identity.machine_name,
      platform,
      caps,
    };
    /**
     * v1.2.6: the public half of this machine's envelope-signing key. It is not a secret, and pairing is the one moment the
     * relay has a reason to believe it belongs to this machine -- so a later result can be checked against the key that was
     * registered here rather than against whichever key the result happens to carry.
     */
    {
      const signing = deriveSigningKey(deviceKey);
      if (signing !== null) body.public_key = signing.publicKeyBase64;
    }
    /**
     * Send only the discriminator that was actually given.
     *
     * `pairing_code: null` would be *present*, and a presence check reads a null as "provided"  -      * the same trap that made `createILinkChannel` pass `{ fetch: undefined }` and throw on mount in
     * v0.7.0. An absent code must be an absent key, not a null one.
     */
    if (typeof pairingCode === 'string' && pairingCode !== '') body.pairing_code = pairingCode;
    if (typeof fleetKey === 'string' && fleetKey !== '') body.fleet_key = fleetKey;
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

  return {
    url,
    signingHeaders,
    relayErrorCode,
    postJson,
    putBlobBytes,
    postJsonWithRetry,
    getJson,
    pair,
  };
}
