/**
 * W2M Rabbit relay — in-memory state machine.
 *
 * Contract: E:\DS\_work\w2m\PROTOCOL.md (protocol_version = 1, frozen).
 * This module is intentionally PURE LOGIC:
 *   - no network, no filesystem, no timers
 *   - time is injectable via `now()` (required for lease-expiry unit tests)
 *   - randomness is injectable for deterministic tests
 *
 * Persistence: none. All state is in-memory and is lost on restart (v0.0.1 scope);
 * there is intentionally no snapshot/serialization hook yet.
 */

import { createHash, randomBytes , verify as verifyBytes } from 'node:crypto';

// v0.7.7: fleet scoping. Imported rather than inlined so the rule has one home with its own
// exhaustive tests — three lines inside this object would be untestable without a live relay.
import { targetsFor } from '../chatops/fleet-wiring.mjs';
import { deviceFleetFields } from '../chatops/fleet-wiring.mjs';
// v1.0.7: the one home for "which fleet does this requester act as", reused by the blob channel so it cannot
// drift from the rule the task routes already obey.
import { scopeFleetId } from '../chatops/fleet-wiring.mjs';
// v0.8.1: the account-derived fleet key, so a machine can join with no pairing code.
import { planJoin } from '../chatops/fleet-join.mjs';
import { validateTaskDependencies } from './task-deps.mjs';
import { buildMembers, isMemberRole, setMemberRole as applyMemberRole } from './fleet-members.mjs';
import { canonicalSignedPayload, publicKeyFromBase64 } from '../util/envelope-signature.mjs';
import { createProjectRoom } from './project-room.mjs';
import { createProjectLocks } from './project-locks.mjs';
import { createProjectReviews } from './project-reviews.mjs';
import { createProjectNotifications } from './project-notifications.mjs';
import { createBlobSessions } from './blob-sessions.mjs';
import { createProjectRefs } from './project-refs.mjs';
import { createMetrics } from './reliability-metrics.mjs';
import { argvHash as grantArgvHash } from '../maintenance/grant.mjs';

export const PROTOCOL_VERSION = 1;

/**
 * PROTOCOL §1 table + §7 code table, plus the two v0.1.2 additions:
 * `OPERATOR_REQUIRED` (§5.2 → 401) and `RATE_LIMITED` (§6 → 429).
 * A code missing from this map silently degrades to HTTP 500 via
 * `ProtocolError`, which keeps the right error code but lies about the status.
 */
export const ERROR_STATUS = Object.freeze({
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  // v1.3.12-beta.1: dispatch refuses a grant written for another task or argv. Caller errors (400), not authorization verdicts.
  GRANT_TASK_MISMATCH: 400,
  GRANT_ARGV_MISMATCH: 400,
  GRANT_EXPIRED: 400,
  GRANT_REVOKED: 403,
  NOT_FOUND: 404,
  PAIRING_INVALID: 400,
  PAIRING_EXPIRED: 400,
  TASK_EXISTS: 409,
  FRAME_TOO_LARGE: 413,
  NO_ONLINE_DEVICE: 503,
  INTERNAL: 500,
  OPERATOR_REQUIRED: 401, // v0.1.2 §5.2
  RATE_LIMITED: 429,      // v0.1.2 §6

  /* v0.3.0 §9 request signing. Every client-side signature failure is a 401.
   * `SIGNING_NOT_CONFIGURED` is deliberately NOT 401: the relay was started with
   * `--require-signature` but no secret, so the fault is the relay's own
   * configuration. Reporting that as 401 would send every operator to debug the
   * client -- the one side that is not broken. 500 rather than 503 because
   * retrying never fixes a missing configuration, so nothing should be invited to
   * retry. */
  SIGNATURE_REQUIRED: 401,
  SIGNATURE_INCOMPLETE: 401,
  SIGNATURE_MISMATCH: 401,
  SIGNATURE_BAD_TIMESTAMP: 401,
  SIGNATURE_BAD_NONCE: 401,
  SIGNATURE_EXPIRED: 401,
  SIGNATURE_REPLAY: 401,
  SIGNING_NOT_CONFIGURED: 500,

  /* v1.0.7: the content-addressed blob channel.
   *
   * `BLOB_HASH_MISMATCH` is **422**, not 400: the request is well-formed and the bytes are fine, but they do not
   * hash to the key they were sent under, so storing them would break content addressing for every later reader.
   * That is a semantically invalid request, not a malformed one -- 422 is the status that says so.
   *
   * `PERSISTENCE_DISABLED` is **503**: the relay was started without a state directory, so the channel cannot
   * exist. Retrying will not fix a missing directory, but a caller is still right to treat it as "this relay cannot
   * serve this right now" rather than as its own mistake. */
  BLOB_HASH_MISMATCH: 422,
  BLOB_TOO_LARGE: 413,
  BLOB_EMPTY: 400,
  BLOB_WRITE_FAILED: 500,
  PERSISTENCE_DISABLED: 503,
});

/** §5.1 required envelope fields — missing any one means `unverifiable`. */
export const REQUIRED_ENVELOPE_FIELDS = Object.freeze([
  'envelope_version', 'task_id', 'attempt', 'dedupe_key', 'machine_id', 'machine_name',
  'platform', 'caps', 'index', 'index_total', 'mode', 'cwd_rel', 'base_commit', 'base_tree',
  'pre_tree_fingerprint', 'post_tree_fingerprint', 'fingerprint_algo', 'fingerprint_error',
  'head_commit', 'dirty_before', 'command_argv', 'command_hash', 'shell_id',
  'started_at', 'ended_at', 'duration_ms', 'exit_code', 'status', 'refusal_reason',
  'stdout_sha256', 'stdout_bytes', 'stderr_sha256', 'stderr_bytes', 'warnings',
  'envelope_sha256',
]);

/** §5.3 comparable fields — the ONLY fields that take part in consistency judgement. */
export const COMPARABLE_FIELDS = Object.freeze([
  'task_id', 'index', 'index_total', 'mode', 'cwd_rel', 'base_commit', 'base_tree',
  'pre_tree_fingerprint', 'fingerprint_algo', 'fingerprint_error', 'head_commit',
  'command_hash', 'shell_id', 'exit_code', 'status', 'refusal_reason',
  'stdout_sha256', 'stdout_bytes', 'stdout_normalized_sha256',
  'stderr_sha256', 'artifacts', 'diff_numstat', 'tests', 'semantic_counts', 'warnings',
]);

/** §5.1 status enum. */
export const RESULT_STATUSES = Object.freeze([
  'ok', 'nonzero_exit', 'timeout', 'crashed', 'refused', 'unverifiable',
]);

export const FAILURE_STATUSES = Object.freeze(['nonzero_exit', 'timeout', 'crashed']);

/** §4.3 phase enum. */
export const LEASE_PHASES = Object.freeze(['preparing', 'running', 'finalizing']);

/** Lease states that can still be expired / renewed. */
export const ACTIVE_LEASE_STATES = Object.freeze(['queued', 'offered', 'running']);

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000; // §4.3: agent heartbeats every 10s
export const DEFAULT_MISSED_HEARTBEATS = 2;          // §4.3: 2 missed cycles = 20s
export const DEFAULT_LEASE_GRACE_MS = 30_000;        // §4.3: + grace 30s
/**
 * v0.4.0: the bounded hold on the relay's own offer when a dispatcher is pushing it directly.
 *
 * Sized against what it has to cover: one punch round trip (measured 15-370 ms on the reference
 * networks), the frame's delivery, and the executor's first heartbeat POST — all on a host that may
 * be busy. 1.2 s was the first guess and it was too tight: measured on a 1-vCPU shared host, two
 * agent tests saw the relay's copy overtake the direct one, which for `p2pMode: direct` means a
 * refusal of an offer that was about to arrive. 3 s covers a slow host with room to spare.
 *
 * The cost is honest and bounded: a punch that fails delays the relay's copy by up to this much,
 * once per task. Nothing else waits on it.
 */
export const DEFAULT_P2P_OFFER_GRACE_MS = 3_000;
export const DEFAULT_PAIRING_TTL_MS = 24 * 60 * 60 * 1000; // §2.2: 24h
export const DEFAULT_EVENT_BUFFER_SIZE = 1000;       // §requirement: keep last 1000 events
export const MAX_FRAME_BYTES = 64 * 1024;            // 64 KiB single frame
export const SHELL_ID_DIRECT = 'direct-exec';        // §5.1: v0.0.1 only direct exec
/** v0.3.0: RTT sanity ceiling — anything above 24h is treated as a broken value. */
export const MAX_RTT_MS = 24 * 60 * 60 * 1000;
/** v0.3.0: an RTT measurement older than this is reported as stale.
 *  Must stay comfortably ABOVE the idle-heartbeat interval (60s): at 1x the value
 *  would flip stale just before every refresh and flap, which would make
 *  `rtt_stale === false` useless as a "trust this number" predicate. 3x gives two
 *  consecutive missed idle heartbeats of margin. See PROTOCOL-v0.3.0.md §7. */
export const DEFAULT_RTT_STALE_MS = 180_000;
/** v0.3.0: recommended cadence for an agent with no lease (reference for the agent side). */
export const DEFAULT_IDLE_HEARTBEAT_MS = 60_000;

/**
 * v0.9.1: how long a device may stay `online` without any contact before the relay calls it silent.
 *
 * ## The defect this closes
 *
 * `online` was written in exactly two places, both driven by the SSE stream: set true when a
 * subscriber attached, false when it detached. **Nothing derived it from contact.** So a machine
 * whose process died without the TCP connection closing — a half-open stream, which is what a killed
 * process or a yanked network path leaves behind — stayed `online: true` in `/v1/devices`
 * indefinitely, and stayed selectable as a dispatch target. Reported from a real fleet: a Windows
 * machine powered off hours earlier was still listed online, with `last_heartbeat_at: null` to say it
 * had never heartbeated at all.
 *
 * `peer.bye` did not help either, because it is emitted *by* the stream closing (`setOnline(…, false)`
 * on detach). With no close there is no bye, so the machine was never removed from any other
 * machine's fleet view either — which is the "not broadcast" half of the same report.
 *
 * ## The threshold
 *
 * An idle agent heartbeats every {@link DEFAULT_IDLE_HEARTBEAT_MS} (60 s), and a busy one renews its
 * lease every {@link DEFAULT_HEARTBEAT_INTERVAL_MS} (10 s), so the *slowest* healthy cadence is 60 s.
 * Two skipped idle beats is therefore 120 s: a live machine cannot reach it, and a dead one is
 * noticed within two cycles plus the sweep tick.
 *
 * Deliberately longer than `heartbeatIntervalMs * missedHeartbeats` (the 20 s lease rule): that rule
 * is about holding a *task index*, where being wrong costs a duplicated execution. This one is about
 * a display and a target list, where being wrong costs a wasted dispatch. Same reasoning, different
 * price, so not the same number.
 */
export const DEFAULT_SILENCE_MS = DEFAULT_IDLE_HEARTBEAT_MS * 2;
export const ENVELOPE_VERSION = '1.0';
export const FINGERPRINT_ALGO = 'git-temp-index-tree/v1';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class ProtocolError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.detail = detail;
    this.status = ERROR_STATUS[code] ?? 500;
  }
  toBody() {
    return { error: { code: this.code, message: this.message, detail: this.detail } };
  }
}

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** RFC 8785-ish canonical JSON (JCS): sorted keys, no whitespace. */
export function jcs(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : jcs(v))).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * Upper bound on the stages a `pipeline` may contain.
 *
 * Each stage is another command run on someone else's machine, so an unbounded list is an unbounded
 * amount of work created by one request. The limit is generous for the intended use (build, test,
 * package) and exists so the failure is a clear refusal rather than a fleet-wide surprise.
 */
export const MAX_PIPELINE_STAGES = 16;

/**
 * v0.4.0: upper bound on `POST /v1/task`'s `origin_machine_id`.
 *
 * A machine id is an identifier, not a payload: 128 characters is far beyond any id this system
 * mints, and the ceiling is what stops the field from becoming an unbounded free-text channel into
 * every offer frame the relay emits.
 */
export const MAX_ORIGIN_MACHINE_ID_LENGTH = 128;

/**
 * v0.4.0: the P2P modes a task may be dispatched under (§1 of the frozen v0.4.0 contract).
 *
 * Mirrored here rather than imported from `src/agent/p2p-node.mjs`: the relay is a standalone
 * process that must not depend on agent code, and a mode list is three strings. A value outside
 * this list is a configuration error, never a silent fall back to the default.
 */
export const P2P_MODES = Object.freeze(['auto', 'direct', 'relay']);

/**
 * v0.4.0: how a result travelled — the direct P2P channel or the relay.
 *
 * A **transport is not a result**: how an envelope arrived must never take part in the consistency
 * judgement (§5 of the contract), or two machines that produced byte-identical output would be
 * reported `divergent` merely because one of them punched a hole. Hence: not required, not
 * comparable, and absent on every v0.3.9 envelope.
 */
export const TRANSPORT_VALUES = Object.freeze(['p2p', 'relay']);

/** §4.4 helper: command_hash = sha256(JCS(argv)+"|"+shell_id+"|"+cwd_rel). */
export function computeCommandHash(commandArgv, shellId = SHELL_ID_DIRECT, cwdRel = '.') {
  return sha256Hex(`${jcs(commandArgv)}|${shellId}|${cwdRel}`);
}

/**
 * `command_hash` for a whole pipeline.
 *
 * The hash must bind **every** stage, not just the first. Bound to stage 0 alone, two pipelines that
 * differ after the first stage would carry the same hash -- so an envelope produced by the wrong
 * chain would still verify, and making "the machine ran what I asked" checkable is the entire point
 * of this field. Each stage's cwd participates for the same reason.
 *
 * The `|pipeline` suffix means this can never collide with a single-command hash: the two hash over
 * different shapes, and that difference is deliberate rather than incidental.
 */
export function computePipelineCommandHash(stages, shellId = SHELL_ID_DIRECT) {
  const canonical = stages.map((s) => ({
    command_argv: s.command_argv,
    cwd_rel: s.cwd_rel ?? '.',
    continue_on_failure: s.continue_on_failure === true,
  }));
  return sha256Hex(`${jcs(canonical)}|${shellId}|pipeline`);
}

/** §4.4: dedupe_key = sha256(task_id + "|" + index + "|" + command_hash + "|" + base_tree). */
export function computeDedupeKey(taskId, index, commandHash, baseTree) {
  return sha256Hex(`${taskId}|${index}|${commandHash}|${baseTree}`);
}

/** Epoch ms -> RFC3339 UTC, second precision (matches the PROTOCOL examples). */
export function rfc3339(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isRfc3339(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value);
}

export function deepEqual(a, b) {
  return jcs(a === undefined ? null : a) === jcs(b === undefined ? null : b);
}

function normalizeNow(now) {
  if (typeof now !== 'function') return () => Date.now();
  return () => {
    const v = now();
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    return Date.parse(v);
  };
}

/* ------------------------------------------------------------------ */
/* ULID                                                                */
/* ------------------------------------------------------------------ */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBig(value, len) {
  let out = '';
  let v = value;
  for (let i = 0; i < len; i += 1) {
    out = CROCKFORD[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

export function createIdFactory() {
  let lastMs = -1;
  let lastRand = 0n;
  return function nextId(nowMs = Date.now()) {
    const bytes = randomBytes(10);
    let rand = 0n;
    for (const b of bytes) rand = (rand << 8n) | BigInt(b);
    if (nowMs === lastMs) rand = (lastRand + 1n) & ((1n << 80n) - 1n);
    lastMs = nowMs;
    lastRand = rand;
    return encodeBig(BigInt(nowMs), 10) + encodeBig(rand, 16);
  };
}

export function ulid(nowMs = Date.now()) {
  return createIdFactory()(nowMs);
}

/* ------------------------------------------------------------------ */
/* Version / capability gate (§6.1)                                    */
/* ------------------------------------------------------------------ */

function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), Number(m[4] ?? 0)];
}

function cmpVersion(a, b) {
  for (let i = 0; i < 4; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Minimal semver-range check used by the §6.1 capability gate.
 * Supports bare versions and comma/space separated `>= > <= < = ==` conjunctions.
 * Unparseable ranges are treated as NOT satisfied (never silently pass).
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (v === null) return false;
  if (typeof range !== 'string') return false;
  const parts = range.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return false;
  for (const part of parts) {
    const m = part.match(/^(>=|<=|==|=|>|<)?\s*(.+)$/);
    if (!m) return false;
    const op = m[1] ?? '=';
    const target = parseVersion(m[2]);
    if (target === null) return false;
    const c = cmpVersion(v, target);
    if (op === '>=' && c < 0) return false;
    if (op === '<=' && c > 0) return false;
    if (op === '>' && c <= 0) return false;
    if (op === '<' && c >= 0) return false;
    if ((op === '=' || op === '==') && c !== 0) return false;
  }
  return true;
}

function machineWritable(caps) {
  if (!caps || typeof caps !== 'object') return false;
  if (caps.write === false || caps.writable === false || caps.write_allowed === false) return false;
  if (caps.read_only === true || caps.readonly === true || caps.ro_mount === true) return false;
  return true;
}

/**
 * §6.1 capability gate, evaluated per machine BEFORE dispatch.
 * @returns {null | {status:'refused', refusal_reason:string, detail:object}}
 */
export function gateMachine(task, machine) {
  const caps = machine?.caps ?? {};
  const req = task.requirements ?? {};

  if (req.platform && Array.isArray(req.platform) && req.platform.length > 0) {
    const os = String(machine?.platform?.os ?? '').toLowerCase();
    if (!req.platform.map((p) => String(p).toLowerCase()).includes(os)) {
      return { status: 'refused', refusal_reason: 'PLATFORM_MISMATCH', detail: { os, want: req.platform } };
    }
  }

  const toolchain = req.toolchain ?? {};
  for (const [tool, range] of Object.entries(toolchain)) {
    const declared = caps[tool];
    if (declared === null || declared === undefined || declared === '') {
      return {
        status: 'refused',
        refusal_reason: `MISSING_${String(tool).toUpperCase()}`,
        detail: { tool, want: range, have: declared ?? null },
      };
    }
    if (typeof range === 'string' && !satisfiesRange(declared, range)) {
      return {
        status: 'refused',
        refusal_reason: `MISSING_${String(tool).toUpperCase()}`,
        detail: { tool, want: range, have: declared },
      };
    }
  }

  if (task.write === true && !machineWritable(caps)) {
    return { status: 'refused', refusal_reason: 'READ_ONLY_MACHINE', detail: { caps } };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* RabbitState                                                         */
/* ------------------------------------------------------------------ */

const INSTANCE_SEP = '\u0000';

export class RabbitState {
  constructor(options = {}) {
    this._now = normalizeNow(options.now);
    this._idFactory = options.idFactory ?? createIdFactory();
    this._randomToken = options.tokenFactory ?? (() => randomBytes(24).toString('hex'));
    this._randomChars = options.randomChars
      ?? ((n) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; const b = randomBytes(n); let s = ''; for (let i = 0; i < n; i += 1) s += a[b[i] % a.length]; return s; });

    this.protocolVersion = PROTOCOL_VERSION;
    this.eventBufferSize = options.eventBufferSize ?? DEFAULT_EVENT_BUFFER_SIZE;
    /**
     * v0.7.7: the fleet this relay serves, or null for a relay that serves every device.
     *
     * **Null is the migration-safe default and is what the shared relay runs today.** With it,
     * task targeting behaves exactly as it did before this release, so deploying cannot be an
     * outage. Set it (via `--fleet <id>` or `fleetId`) and the relay becomes scoped: a device
     * with a `fleet_id` reaches only its own fleet, and a device with none reaches nothing.
     *
     * This is the relay's *own* fleet, not a device's. A device carries its own `fleet_id`, which
     * the relay wrote at pairing time from the pairing code.
     */
    this.fleetId = typeof options.fleetId === 'string' && options.fleetId !== '' ? options.fleetId : null;
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    /** When true one code stays valid for its whole TTL instead of rotating. */
    this.pairingCodeReusable = options.pairingCodeReusable === true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.missedHeartbeats = options.missedHeartbeats ?? DEFAULT_MISSED_HEARTBEATS;
    this.leaseGraceMs = options.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS;
    /**
     * v0.9.1: how long an `online` device may go without contact before it is declared silent.
     * See {@link DEFAULT_SILENCE_MS} for why this is not the lease number.
     */
    this.silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
    /**
     * v0.4.0: how long the relay holds its own offer back when the dispatcher says it will push the
     * offer over the direct path (`origin_machine_id` + `p2p.mode`).
     *
     * Without this, the direct path could never win: the relay's offer goes out over an SSE stream
     * that is already open, while a punch costs at least one round trip, so the relay copy would
     * arrive first essentially always and `transport` would read `relay` even on a network where
     * the punch succeeded. Measured on loopback, and it is exactly what the first version of this
     * release did.
     *
     * The hold is bounded and self-healing: the executor renews its lease (a heartbeat) the moment
     * it starts work on the direct copy, which moves the lease out of `queued`, and the deferred
     * offer is then dropped. If the punch fails, nothing renews the lease and the relay offers
     * normally once the grace expires -- so a failed punch costs this much latency and nothing else.
     */
    this.p2pOfferGraceMs = Number.isFinite(options.p2pOfferGraceMs) && options.p2pOfferGraceMs >= 0
      ? options.p2pOfferGraceMs
      : DEFAULT_P2P_OFFER_GRACE_MS;
    /** Deferred offers, keyed `task_id:machine_id`, so they can be cleared on close(). */
    this._pendingOffers = new Map();
    /** v0.3.0: age beyond which a reported RTT is flagged stale. */
    this.rttStaleMs = Number.isFinite(options.rttStaleMs) ? options.rttStaleMs : DEFAULT_RTT_STALE_MS;

    this.startedAtMs = this._now();
    /** v0.1.2 §8.3: random per-process id; a change tells clients the relay restarted. */
    this.relayId = options.relayId ?? randomBytes(8).toString('hex');
    /** v0.1.2 §7: optional injected Persistence instance (state.mjs never touches fs itself). */
    this._persist = options.persistence ?? null;
    /** True while replaying a ledger — suppresses event emission and re-persistence. */
    this._restoring = false;
    /** Ledger entries that could not be replayed. */
    this.replayWarnings = [];
    this.seq = 0;
    /** @type {{seq:number,event:object,target:string|null}[]} ring buffer, last N events */
    this.buffer = [];
    this.devices = new Map();      // machine_id -> device
    // v1.3.10-beta.2: operator signing keys seen with a dispatch; agents pin the first one they receive.
    this.operatorKeys = new Map();
    // v1.3.10-beta.13: shared project objects (M4). Tasks name a project; readers get snapshot + events.
    this.metrics = createMetrics();
    // v1.3.14-beta.4: project-scoped live push. A client that follows one project subscribes here instead of filtering the
    // global stream, so two clients see the same project events in the same order (the room owns the sequence).
    this.projectSubscribers = new Set();
    // v1.3.14-beta.1 (collaboration model): shared objects every client reads the same way -- a project board and an artifact
    // index. Before this a client could only list ALL tasks, so two clients "in the same project" built different boards.
    this.artifacts = new Map();
    // v1.3.14-beta.2: the remaining shared objects -- decisions and a project memory document. Both are append/versioned and
    // read by every member, so "what we agreed" is the same object for every client rather than a chat history.
    this.decisions = new Map();
    this.projectMemory = new Map();
    // v1.3.13-beta.4: branch heads and merge outcomes live with the project room so one stream answers "where is the branch".
    this.refs = createProjectRefs({
      now: () => this.nowMs(),
      onEvent: (event) => { try { this.projects.appendEvent({ projectId: event.payload.project_id, type: event.type, actor: { kind: 'operator', id: 'relay' }, payload: event.payload }); } catch { /* history */ } },
    });
    // Every project-room event is counted once, here: the room's own events and the lock/review/notification events projected
    // into it both pass through this callback, so the counter cannot double-count a projection.
    // v1.3.14-beta.3: which project events are worth a notification, and whether they need an action from a member.
    const NOTIFIED = Object.freeze({
      'decision.recorded': { kind: 'decision.recorded', subject: 'a decision was recorded', requiresAction: false },
      'artifact.registered': { kind: 'artifact.registered', subject: 'an artifact was registered', requiresAction: false },
      'memory.updated': { kind: 'memory.updated', subject: 'project memory was updated', requiresAction: false },
      'merge.conflict': { kind: 'merge.conflict', subject: 'a merge conflicted', requiresAction: true },
      'merge.merged': { kind: 'merge.merged', subject: 'a patch was merged', requiresAction: false },
      'ref.advanced': { kind: 'ref.updated', subject: 'a branch was advanced', requiresAction: false },
    });
    const metricsEvent = (event) => {
      try { this.metrics.inc('wm_project_events_total', { type: event.type }); } catch { /* metrics never break the room */ }
      for (const listener of this.projectSubscribers) { try { listener(event); } catch { /* a subscriber never breaks the room */ } }
      const notified = NOTIFIED[event.type];
      if (notified !== undefined) {
        try {
          this.notifications.notify({ projectId: event.project_id, kind: notified.kind, target: { kind: 'broadcast' }, subject: notified.subject, refs: event.payload ?? {}, requiresAction: notified.requiresAction });
        } catch { /* a notification is never worth failing the event for */ }
      }
    };
    this.projects = createProjectRoom({ now: () => this.nowMs(), onEvent: metricsEvent });
    this.defaultProjectId = 'default';
    // M5 primitives share the project room's event stream: a lock, review or notification is a project event with the
    // module's own sequence attached, so one reader can reconstruct "what happened" from a single cursor.
    const roomEvent = (event) => {
      try {
        this.projects.appendEvent({ projectId: event.payload.project_id, type: event.type, actor: { kind: 'operator', id: 'relay' }, payload: { ...event.payload, module_seq: event.seq } });
      } catch { /* an event about a project that is gone is history, not an error */ }
    };
    this.locks = createProjectLocks({ now: () => this.nowMs(), onEvent: roomEvent });
    this.reviews = createProjectReviews({ now: () => this.nowMs(), onEvent: roomEvent });
    this.notifications = createProjectNotifications({ now: () => this.nowMs(), onEvent: roomEvent });
    // v1.3.10-beta.20: a committed chunk session becomes a fleet blob with the same verified bytes. A store failure does not
    // undo the commit (the session is gone), but it is reported through the route so a caller never believes a blob exists.
    // v1.3.12-beta.2: revoked grants. The operator can stop one authorisation from being used; the dispatch preflight
    // refuses a task carrying a revoked grant, and the ledger keeps the revocation with its reason.
    this.revokedGrants = new Map();
    this.blobSessions = createBlobSessions({
      now: () => this.nowMs(),
      onCommit: (blob) => {
        const device = this.devices.get(blob.machineId);
        if (device === undefined) return;
        this.putFleetBlob(device, blob.bytes);
      },
    });
    /** v1.2.5: operator-assigned roles, kept apart from device records so a re-pair cannot change authority. */
    this.roles = new Map();        // machine_id -> 'owner'|'worker'|'observer'
    /** v1.2.5: read watermarks per session, per machine. */
    this.readMarks = new Map();    // session_id -> Map<machine_id, {at_ms, message_id}>
    /** v1.2.5: operator-assigned roles, kept apart from device records so a re-pair cannot change authority. */
    this.roles = new Map();        // machine_id -> 'owner'|'worker'|'observer'
    /** v1.2.5: read watermarks per session, per machine. */
    this.readMarks = new Map();    // session_id -> Map<machine_id, {at_ms, message_id}>
    this.tokens = new Map();       // device_token -> machine_id
    this.tasks = new Map();        // task_id -> task
    this.results = new Map();      // instanceKey -> {envelope, machine_id, received_at_ms, ...}
    this.pairingCodes = new Map(); // code -> {code, created_at_ms, expires_at_ms, used}
    this._listeners = new Set();
  }

  /* ---------------- clock / ids ---------------- */

  nowMs() { return this._now(); }
  nowIso() { return rfc3339(this.nowMs()); }
  nextId() { return this._idFactory(this.nowMs()); }
  newToken() { return this._randomToken(); }

  /** §4.3 lease window = 2 missed heartbeats (20s) + grace (30s) = 50s. */
  leaseWindowMs() { return this.heartbeatIntervalMs * this.missedHeartbeats + this.leaseGraceMs; }

  /* ---------------- persistence hooks (v0.1.2 §7) ---------------- */

  /** Inject/replace the persistence backend (also used by tests). */
  setPersistence(persistence) { this._persist = persistence ?? null; return this._persist; }

  /* ---------------- v1.0.7: the content-addressed blob channel (#1) ---------------- */

  /**
   * Which fleet a device acts as when it writes or reads a blob.
   *
   * **Reuses `scopeFleetId` rather than re-deriving it.** The rule "the requester's fleet comes from the device
   * record the relay wrote at pairing time, never from the request" is already stated, tested and enforced for task
   * dispatch; a second copy here would be a second place for it to drift, and the blob channel is exactly where a
   * drift would leak one fleet's memory into another's.
   *
   * @param {{machine_id?: string, fleet_id?: string|null}|null} device
   * @returns {{ok:true, fleetId:string|null, legacy:boolean}|{ok:false, reason:string, text:string}}
   */
  scopeBlobFleet(device) {
    return scopeFleetId({ device, relayFleetId: this.fleetId ?? null });
  }

  /**
   * Store bytes under their SHA-256, owned by the writer's fleet.
   *
   * Delegates to `Persistence` -- this class never touches the filesystem (v0.1.2 §7), and that constraint is what
   * keeps the durable path in one place.
   *
   * @param {object} device the authenticated device
   * @param {Buffer} bytes
   */
  putFleetBlob(device, bytes) {
    if (!this._persist) {
      return { ok: false, reason: 'PERSISTENCE_DISABLED', detail: 'the relay has no persistence backend' };
    }
    const scope = this.scopeBlobFleet(device);
    if (scope.ok !== true) return { ok: false, reason: scope.reason, detail: scope.text };
    /**
     * v1.0.12: `publishedBy` comes from **the authenticated device, never from the request body.**
     *
     * The relay knows which device is writing; the request does not get a say, for the same reason `machine_id` is
     * read off the token in the P2P announce route -- a caller that could name itself in the body could attribute a
     * publication to a machine that never made it.
     *
     * An end-to-end test caught this field being `null`: the pointer store accepted a `publishedBy` argument that
     * nothing supplied, so `latest` reported `published_by: null` for a publication whose author was right there.
     */
    return this._persist.putBlob(bytes, {
      fleetId: scope.fleetId,
      publishedBy: typeof device?.machine_id === 'string' ? device.machine_id : null,
    });
  }

  /**
   * The bytes for a hash, or `null`.
   *
   * `null` covers three cases on purpose -- no such blob, a blob owned by another fleet, and no persistence -- so a
   * caller cannot use the relay to enumerate which hashes exist elsewhere on it.
   *
   * @param {object} device the authenticated device
   * @param {string} hash
   */
  getFleetBlob(device, hash) {
    if (!this._persist) return null;
    const scope = this.scopeBlobFleet(device);
    if (scope.ok !== true) return null;
    return this._persist.getBlob(hash, { fleetId: scope.fleetId });
  }

  /**
   * Which blob this device's fleet published most recently, or `null`.
   *
   * **This is the discovery half of the channel** (v1.0.9): without it a hash is only useful to whoever read
   * `publish`'s output, so a "sync" would need a human relaying a 64-character string between machines.
   *
   * Scoped by the same rule as the blobs themselves -- a fleetless device on a claimed relay gets `null`, not a
   * shared pointer it could never read.
   */
  latestFleetBlob(device) {
    if (!this._persist) return null;
    const scope = this.scopeBlobFleet(device);
    if (scope.ok !== true) return null;
    return this._persist.fleetLatest(scope.fleetId);
  }

  /** Snapshot the device table; failures must never break the request path. */
  _saveDevices() {
    if (this._restoring || !this._persist) return false;
    try {
      return this._persist.saveDevices(this.devices);
    } catch (err) {
      this._persist.warn?.('devices.json', `snapshot failed: ${err.message}`);
      return false;
    }
  }

  /** Append one ledger entry; failures must never break the request path. */
  _ledger(entry) {
    if (this._restoring || !this._persist) return false;
    try {
      const appended = this._persist.append(entry);
      // v0.6.2: a successful append is what clears a degraded relay, so the outcome has to be
      // reported back rather than assumed -- otherwise the state could only ever be entered.
      if (appended) this._persist.noteAppendSuccess?.();
      return appended;
    } catch (err) {
      // Recorded as a state, not merely as a line: this is the one relay failure that keeps serving,
      // and so the one that is invisible from every other angle (v0.6.2).
      if (typeof this._persist.noteAppendFailure === 'function') this._persist.noteAppendFailure(err.message);
      else this._persist.warn?.('ledger.jsonl', `append failed: ${err.message}`);
      return false;
    }
  }

  _ledgerLease(task, lease) {
    this._ledger({ type: 'lease.changed', task_id: task.task_id, machine_id: lease.machine_id, lease: { ...lease } });
  }

  /**
   * v0.1.2 §7 startup recovery: rebuild the device table, token index, tasks,
   * leases and the result/dedupe index from a devices snapshot + ledger replay.
   * Never emits events and never writes back what it just read.
   */
  restore({ devices = {}, ledger = [] } = {}) {
    this._restoring = true;
    try {
      for (const [machineId, d] of Object.entries(devices)) {
        if (!d || typeof d !== 'object') continue;
        const pairedAt = Date.parse(d.paired_at ?? '');
        const device = {
          machine_id: machineId,
          machine_name: typeof d.machine_name === 'string' && d.machine_name ? d.machine_name : machineId,
          platform: d.platform ?? {},
          caps: d.caps ?? {},
          user_id: d.user_id ?? null,
          device_token: typeof d.device_token === 'string' ? d.device_token : null,
          paired_at_ms: Number.isFinite(pairedAt) ? pairedAt : this.nowMs(),
          re_paired: d.re_paired === true,
          // v1.4.4: restore the fleet binding with the device. Without this the snapshot brought the
          // device back but dropped the fleet it was paired into, so a restart silently un-joined
          // every machine while leaving it fully authorised (measured 2026-10-23 on the shared relay).
          fleet_id: typeof d.fleet_id === 'string' && d.fleet_id !== '' ? d.fleet_id : null,
          fleet_source: typeof d.fleet_source === 'string' && d.fleet_source !== '' ? d.fleet_source : null,
          last_seen_at_ms: this.nowMs(),
          // a snapshot proves the device exists, not that it is connected
          online: false,
          streams: 0,
          // v0.3.0: RTT is volatile and is NEVER restored. Even if a snapshot on
          // disk happens to carry `rtt_ms`, it is dropped here: after a restart the
          // relay genuinely does not know the latency any more, and reporting a
          // pre-restart number as current would be a lie that no reader can detect.
          rtt_ms: null,
          rtt_at_ms: null,
          last_heartbeat_at_ms: null,
          stream_connects: 0,
        };
        this.devices.set(machineId, device);
        if (device.device_token) this.tokens.set(device.device_token, machineId);
      }

      let revivedTasks = 0;
      for (const entry of ledger) {
        try {
          if (this._applyLedgerEntry(entry) === true) revivedTasks += 1;
        } catch (err) {
          this.replayWarnings.push({ type: entry?.type ?? '<unknown>', message: err.message });
        }
      }
      return { revived_devices: this.devices.size, revived_tasks: revivedTasks };
    } finally {
      this._restoring = false;
    }
  }

  /** @returns {boolean} true when a new task was created. */
  _applyLedgerEntry(entry) {
    if (entry?.type === 'operator.key.registered' && entry.key && typeof entry.key.key_id === 'string') {
      this.operatorKeys.set(entry.key.key_id, { ...entry.key });
      return false;
    }
    if (!entry || typeof entry.type !== 'string') return false;
    switch (entry.type) {
      case 'task.created': {
        const t = entry.task;
        if (!t || typeof t.task_id !== 'string') return false;
        const createdAt = Number.isFinite(t.created_at_ms) ? t.created_at_ms : Date.parse(entry.ts ?? '');

        const task = {
          task_id: t.task_id,
          mode: t.mode ?? 'replicate',
          command_argv: t.command_argv ?? [],
          cwd_rel: t.cwd_rel ?? '.',
          cwd_outside_project: t.cwd_outside_project === true,
          index_total: t.index_total ?? 1,
          timeout_ms: t.timeout_ms ?? 300_000,
          write: t.write === true,
          write_scope: t.write_scope ?? [],
          require_exclusive_write: t.require_exclusive_write === true,
          base_commit: t.base_commit ?? null,
          base_tree: t.base_tree ?? null,
          requirements: t.requirements ?? {},
          compare_policy: t.compare_policy ?? {},
          halt: t.halt ?? 'never',
      ...(t.mode === 'mapreduce' ? { reduce_argv: Array.isArray(t.reduce_argv) ? t.reduce_argv : null, reducer_machine_id: t.reducer_machine_id ?? null } : {}),
      max_attempts: Number.isInteger(t.max_attempts) ? t.max_attempts : 1,
      retry_on: Array.isArray(t.retry_on) ? t.retry_on : [],
          created_by: t.created_by ?? null,
          created_at_ms: Number.isFinite(createdAt) ? createdAt : this.nowMs(),
          command_hash: t.command_hash ?? null,
          attempt: t.attempt ?? 1,
          // v1.2.7: a revived task keeps its graph edges and assignment, or the scheduler silently becomes a different scheduler.
          depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
          assignee: typeof t.assignee === 'string' && t.assignee !== '' ? t.assignee : null,
          project_id: typeof t.project_id === 'string' ? t.project_id : null,
          // v1.4.1: an authorization or workspace must survive a relay restart, or a re-offered task reaches the machine
          // without the grant/key/workspace it was dispatched with and the machine's own gate refuses it for the wrong reason.
          workspace: t.workspace ?? null,
          grant: t.grant ?? null,
          grant_summary: t.grant_summary ?? null,
          maintenance: t.maintenance ?? null,
          maintenance_summary: t.maintenance_summary ?? null,
          operator_key: t.operator_key ?? null,
        reduce_of: typeof t.reduce_of === 'string' ? t.reduce_of : null,
          reduce_inputs: Array.isArray(t.reduce_inputs) ? t.reduce_inputs : [],
          leases: new Map(),
          cancelled: false,
          cancel_reason: null,
          degraded: t.degraded ?? null,
          deadline_ms: t.deadline_ms ?? 0,
          // v0.4.0 routing metadata. Read defensively: a ledger written by v0.3.9 has neither key,
          // and a replayed task with `null` for both is exactly a v0.3.9 task.
          origin_machine_id: t.origin_machine_id ?? null,
          p2p: t.p2p ?? null,
          result_seqs: [],
        };
        for (const lease of entry.leases ?? []) {
          if (lease && typeof lease.machine_id === 'string') task.leases.set(lease.machine_id, { ...lease });
        }
        this.tasks.set(task.task_id, task);
        return true;
      }
      case 'member.role': {
        /**
         * v1.2.6: a role survives a restart. The ledger entry already existed (setMemberRole writes it); replaying it here is
         * what stops "the relay restarted" from silently demoting every owner to the default worker.
         */
        if (typeof entry.machine_id !== 'string' || entry.machine_id === '') return false;
        if (isMemberRole(entry.role) !== true) return false;
        this.roles.set(entry.machine_id, entry.role);
        return false;
      }
      case 'lease.changed': {
        const task = this.tasks.get(entry.task_id);
        const lease = task?.leases.get(entry.machine_id);
        if (!lease) return false;
        Object.assign(lease, entry.lease ?? {});
        return false;
      }
      case 'result.stored': {
        const record = entry.result;
        if (!record || typeof record.instance_key !== 'string') return false;
        this.results.set(record.instance_key, { ...record });
        const task = this.tasks.get(record.envelope?.task_id);
        if (task && Number.isInteger(record.seq)) task.result_seqs.push(record.seq);
        return false;
      }
      case 'task.cancelled': {
        const task = this.tasks.get(entry.task_id);
        if (task) {
          task.cancelled = true;
          task.cancel_reason = entry.reason ?? null;
        }
        return false;
      }
      default:
        return false; // unknown entry type: forward compatible, ignored
    }
  }

  /* ---------------- events (§3) ---------------- */

  nextSeq() { this.seq += 1; return this.seq; }

  /** Reserve a seq WITHOUT buffering (used for the per-connection `ready` frame). */
  reserveSeq() { return this.nextSeq(); }

  onEvent(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Emit an event: allocates the next global seq, buffers it (ring of N) and
   * notifies subscribers. `target` is the machine_id the event is addressed to
   * (null = broadcast). The target is NOT serialized except as `machine_id`.
   */
  emit(type, fields = {}, opts = {}) {
    const target = opts.target ?? null;
    const seq = this.nextSeq();
    const event = {
      type,
      seq,
      rabbit_time: this.nowIso(),
      ...(target ? { machine_id: target } : {}),
      ...fields,
    };
    const entry = { seq, event, target };
    this.buffer.push(entry);
    if (this.buffer.length > this.eventBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.eventBufferSize);
    }
    for (const listener of this._listeners) {
      try { listener(entry); } catch { /* subscriber errors must never break state */ }
    }
    return event;
  }

  oldestBufferedSeq() { return this.buffer.length ? this.buffer[0].seq : this.seq + 1; }
  /**
   * Highest seq present in the replay ring (0 when empty).
   *
   * Deliberately different from `lastSeq()`: `ready` frames allocate seq numbers
   * without being buffered, so `lastSeq()` can run ahead of anything a client can
   * actually replay. Diagnostics that describe the REPLAY WINDOW must use this one.
   */
  lastBufferedSeq() { return this.buffer.length ? this.buffer[this.buffer.length - 1].seq : 0; }
  lastSeq() { return this.seq; }

  /** Replay entries with seq >= from (used by GET /v1/stream?seq=|Last-Event-ID). */
  replayEntries(from) {
    return this.buffer.filter((e) => e.seq >= from);
  }

  eventsSince(from) { return this.replayEntries(from).map((e) => e.event); }

  /* ---------------- pairing (§2) ---------------- */

    /**
     * Mint a pairing code.
     *
     * **v0.7.7: the code carries the relay's fleet.** This is the link that makes the scheme work,
     * and it is easy to leave out: `pair()` reads the fleet *from the code*, so a code with no
     * fleet pairs a device into no fleet -- and a device in no fleet reaches nothing on a scoped
     * relay. `--fleet X` would then have had no effect on anything, silently.
     *
     * Defaulting to `this.fleetId` rather than requiring the caller to pass it means there is no
     * path that mints a fleetless code on a scoped relay. An explicit `fleetId` overrides, which
     * is what a relay serving several fleets would need.
     */
    createPairingCode({ ttlMs = this.pairingTtlMs, fleetId = this.fleetId } = {}) {
      let code;
      do { code = `PAIR-${this._randomChars(8)}`; } while (this.pairingCodes.has(code));
      const now = this.nowMs();
      this.pairingCodes.set(code, {
        code,
        created_at_ms: now,
        expires_at_ms: now + ttlMs,
        used: false,
        // Present as an explicit key even when null, so a code dump shows whether a fleet was
        // attached rather than leaving it to be inferred from an absent field.
        fleet_id: typeof fleetId === 'string' && fleetId !== '' ? fleetId : null,
      });
      return code;
    }

  /** Revoke every outstanding code and mint a new one. */
  rotatePairingCode(opts) {
    for (const rec of this.pairingCodes.values()) rec.used = true;
    return this.createPairingCode(opts);
  }

  /**
   * Register an externally supplied code (`--pairing-code <c>`).
   *
   * v0.1.2 BUG-1: assigning the code to `relay.pairingCode` without registering it
   * advertised a code that `/v1/pair` then rejected with PAIRING_INVALID, so every
   * documented scripted-onboarding flow failed. "Which code do we use" and "is the
   * code registered" are two different questions; this answers the second.
   */
  registerPairingCode(code, { ttlMs = this.pairingTtlMs } = {}) {
    if (typeof code !== 'string' || code.trim() === '') {
      throw new ProtocolError('BAD_REQUEST', 'pairing code must be a non-empty string', { pairing_code: code });
    }
    const value = code.trim();
    const now = this.nowMs();
    this.pairingCodes.set(value, { code: value, created_at_ms: now, expires_at_ms: now + ttlMs, used: false });
    return value;
  }

  /** §2.2 step 3: validate a one-time code. */
  /**
   * The account fingerprint -> public key registry (v1.1.6).
   *
   * Keyed by the FINGERPRINT, not by machine: every machine on one account shares the derived keypair, and the point of
   * the registry is to answer "which key speaks for this account", once, for all of them.
   *
   * @returns {{registered: boolean, reason?: string}}
   */
  registerAccountKey(fingerprint, publicKeyPem) {
    if (typeof fingerprint !== 'string' || fingerprint === '') return { registered: false, reason: 'BAD_FINGERPRINT' };
    if (typeof publicKeyPem !== 'string' || publicKeyPem === '') return { registered: false, reason: 'BAD_PUBLIC_KEY' };
    this.accountKeys ??= new Map();
    const existing = this.accountKeys.get(fingerprint);
    if (existing !== undefined) {
      return { registered: false, reason: existing === publicKeyPem ? 'ALREADY_REGISTERED' : 'KEY_MISMATCH' };
    }
    this.accountKeys.set(fingerprint, publicKeyPem);
    return { registered: true };
  }

  /** @returns {string|null} the key that speaks for this account, or null if no machine ever paired for it. */
  accountKeyFor(fingerprint) {
    return this.accountKeys?.get(fingerprint) ?? null;
  }

  validatePairingCode(code) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new ProtocolError('PAIRING_INVALID', 'pairing_code is required');
    }
    const rec = this.pairingCodes.get(code);
    if (!rec) throw new ProtocolError('PAIRING_INVALID', 'unknown pairing code', { pairing_code: code });
    if (rec.used) throw new ProtocolError('PAIRING_INVALID', 'pairing code already used', { pairing_code: code });
    if (this.nowMs() >= rec.expires_at_ms) {
      throw new ProtocolError('PAIRING_EXPIRED', 'pairing code expired', { pairing_code: code, expired_at: rfc3339(rec.expires_at_ms) });
    }
    return rec;
  }

  /** §2.2: exchange a one-time code for a device_token. §1: idempotent. */
  pair(request = {}) {
    /**
     * v0.8.1: a pairing code **or** an account-derived fleet key.
     *
     * The code path is unchanged. The key path is what lets a second machine on one account join
     * with no human step and no relay configuration — the gap that left a new PC invisible beside
     * its own fleet.
     *
     * ## Why a key may stand in for a code
     *
     * They authorise different things. A **code** is the operator saying *"let this machine in"*,
     * and it is the only way to place a device in a fleet the device could not compute for itself.
     * A **key** is the account saying *"this machine is mine"*, and it can only ever place the
     * device in the fleet derived from that key — so it cannot be used to reach a fleet its holder
     * is not already entitled to.
     *
     * ## Why a malformed key refuses rather than falling back
     *
     * A request with a `fleet_key` is a request that *meant* to join by account. Quietly demanding a
     * code instead would surface at the client as an unexplained `PAIRING_INVALID`, which is the
     * silent-wrong-answer shape this codebase keeps producing; the reason is named instead.
     */
    const hasKey = typeof request.fleet_key === 'string' && request.fleet_key !== '';
    let rec = null;
    if (hasKey) {
      const join = planJoin({ fleetKeyEncoded: request.fleet_key });
      if (!join.ok) {
        throw new ProtocolError('PAIRING_INVALID', join.text, { reason: join.reason });
      }
      // A synthetic code record so the fleet binding below reads from one place. `fleet_id` is the
      // DERIVED value, never anything the request claimed.
      rec = { code: null, fleet_id: join.fleetId, from_fleet_key: true };
    } else {
      rec = this.validatePairingCode(request.pairing_code);
    }

    const machineId = request.machine_id;
    if (typeof machineId !== 'string' || machineId.length === 0) {
      throw new ProtocolError('BAD_REQUEST', 'machine_id is required');
    }
    const now = this.nowMs();
    const token = this.newToken();
    const existing = this.devices.get(machineId);
    if (existing?.device_token) this.tokens.delete(existing.device_token);

    const device = {
      machine_id: machineId,
      machine_name: typeof request.machine_name === 'string' && request.machine_name
        ? request.machine_name : machineId.slice(0, 12),
      platform: request.platform ?? {},
      caps: request.caps ?? {},
      user_id: request.user_id ?? null,
        // v0.7.7: which fleet this device belongs to, and where that fact came from.
        //
        // **The fleet comes from the pairing code, not from the request.** A device that could
        // name its own fleet would join any fleet, and every signature would faithfully attest
        // to it. `deviceFleetFields` is the single place that binding is made, and it records
        // its provenance so a fleet that arrived from a request is visible as such in
        // `devices.json` rather than looking identical to one that came from a code.
        //
        // v0.8.1 adds the third source: an account-derived `fleet_key`. That is what lets a second
        // machine on one account join with **no human step and no relay configuration** -- the gap
        // that left a new PC invisible beside its own fleet. The relay does not trust a claimed
        // fleet id; it *derives* one from the key, so a device can only land in the fleet whose key
        // it holds and anything else forms a separate, empty fleet.
        ...deviceFleetFields({
          codeRecord: rec,
          fleetKeyEncoded: typeof request.fleet_key === 'string' ? request.fleet_key : null,
          requestedFleet: null,
        }),
        /**
         * v0.7.10: the device's Ed25519 public key, if it offered one.
         *
         * A public key is not a secret, so storing it costs nothing and it is the whole basis of
         * per-device verification: the relay can then check a signature only *this* machine could
         * have made, rather than a shared secret every machine holds.
         *
         * Not validated here, deliberately. A malformed key fails at verification with a named
         * reason, while rejecting a pairing over it would lock out every existing device the
         * moment this field was added -- and devices that send no key keep working, with
         * `public_key: null` meaning "signs with the shared secret or not at all".
         */
        public_key: typeof request.public_key === 'string' && request.public_key !== '' ? request.public_key : null,
      device_token: token,
      paired_at_ms: now,
      re_paired: Boolean(existing),
      last_seen_at_ms: now,
      online: true,
      streams: existing?.streams ?? 0,
      // v0.3.0 RTT: starts unknown. `null` is "never measured"; 0 would mean "instant".
      rtt_ms: null,
      rtt_at_ms: null,
      last_heartbeat_at_ms: null,
      stream_connects: existing?.stream_connects ?? 0,
    };
    this.devices.set(machineId, device);
    this.tokens.set(token, machineId);

    /**
     * v1.1.6: register the account's signing key while we have proof of the account.
     *
     * A machine that failed the old joining path must later prove the account to the relay. It can only do that against
     * a key the relay already trusts, and the only moment the relay has real proof ("this machine holds the account
     * material") is a successful pairing. So this is the trust anchor, and it is written HERE rather than at
     * registration time to keep the two paths honest: no pairing, no key.
     *
     * Idempotent on purpose: the first machine to pair for a fingerprint fixes the key. A second machine claiming the
     * same fingerprint with a DIFFERENT key is not silently accepted -- the registration is refused and reported, and
     * changing a key needs the fleet vote the removal flow already provides.
     */
    const accountFingerprint = typeof request.account_fingerprint === 'string' ? request.account_fingerprint : '';
    const accountPublicKey = typeof request.account_public_key === 'string' ? request.account_public_key : '';
    const accountKey = accountFingerprint !== '' && accountPublicKey !== ''
      ? this.registerAccountKey(accountFingerprint, accountPublicKey)
      : null;
    // Recorded on the device, not just discarded: a second machine claiming the same account with a different key is
    // refused, and the refusal must be visible in devices.json rather than looking like a successful registration.
    device.account_key = accountKey;
    rec.used = true;

    // A group has more than one machine, and a single-use code would leave the
    // operator unable to pair the second one without restarting the relay. So
    // consuming a code immediately mints the next one and announces it: the
    // operator pairs machine A, sees a fresh code, and pairs machine B with it.
    // `pairingCodeReusable` keeps one code alive for the whole window instead,
    // for scripted onboarding where nobody is watching stdout.
    let nextCode = null;
    const reusable = this.pairingCodeReusable === true;
    if (reusable) {
      rec.used = false;
    } else {
      nextCode = this.rotatePairingCode();
    }

    this.emit('peer.hello', {
      machine_id: machineId,
      machine_name: device.machine_name,
      platform: device.platform,
    });

    if (nextCode) {
      this.emit('notice', {
        level: 'info',
        code: 'PAIRING_CODE_ROTATED',
        message: 'pairing code consumed; a new one is available',
        pairing_code: nextCode,
      });
    }

    // §7: a device change is snapshotted immediately.
    this._saveDevices();
    this._ledger({
      type: 'device.paired',
      machine_id: machineId,
      machine_name: device.machine_name,
      re_paired: device.re_paired,
    });

    return {
      device_token: token,
      protocol_version: PROTOCOL_VERSION,
      rabbit_time: rfc3339(now),
      ...(nextCode ? { next_pairing_code: nextCode } : {}),
    };
  }

  /** @returns {object|null} device for a bearer token. */
  authenticate(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const machineId = this.tokens.get(token);
    if (!machineId) return null;
    return this.devices.get(machineId) ?? null;
  }

  touchDevice(machineId, { online = true } = {}) {
    const device = this.devices.get(machineId);
    if (!device) return null;
    device.last_seen_at_ms = this.nowMs();
    if (online) device.online = true;
    return device;
  }

  setOnline(machineId, online, reason = null) {
    const device = this.devices.get(machineId);
    if (!device) return null;
    if (device.online === online) return device;
    device.online = online;
    if (online) {
      this.touchDevice(machineId);
      this.emit('peer.hello', {
        machine_id: machineId,
        machine_name: device.machine_name,
        platform: device.platform,
      });
    } else {
      this.emit('peer.bye', { machine_id: machineId, reason: reason ?? 'stream_closed' });
    }
    return device;
  }

  /* ---------------- RTT (v0.3.0 §R) ---------------- */

  /**
   * Validate an inbound `rtt_ms`.
   *
   * The contract is deliberately liberal: a MISSING or INVALID value must never
   * reject the heartbeat and must never clobber a previously known good value.
   * RTT is a diagnostic; it must not be able to break lease renewal.
   *
   * Sanity ceiling: anything above `MAX_RTT_MS` (24h) is treated as invalid. A
   * single garbage value would otherwise poison the fleet aggregate.
   */
  static normalizeRtt(value) {
    if (value === undefined) return { provided: false, valid: false };
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { provided: true, valid: false };
    }
    if (value > MAX_RTT_MS) return { provided: true, valid: false };
    return { provided: true, valid: true, value };
  }

  /**
   * RTT is a VOLATILE diagnostic: it is intentionally NOT written to
   * `devices.json` and NOT replayed from the ledger, so a restarted relay reports
   * `rtt_ms: null` until a machine heartbeats again. A persisted value would be
   * indistinguishable from a fresh one and would let the relay claim knowledge it
   * lost when the process died.
   */
  rttStaleAfterMs() { return this.rttStaleMs; }

  /**
   * v0.3.0: absorb the optional `rtt_ms` carried by a heartbeat.
   *
   * Deliberately liberal, because RTT is a diagnostic and must never be able to
   * break lease renewal:
   *   - the field is optional; a v0.2.3 agent never sends it
   *   - a MISSING or INVALID value is IGNORED, keeping the previous value, and the
   *     heartbeat still succeeds
   *   - unknown extra fields are ignored entirely (forward compatibility)
   *
   * `last_heartbeat_at` advances on EVERY accepted heartbeat, with or without a
   * usable RTT: it answers "is the machine alive", while `rtt_at` answers "when
   * was this number measured". Keeping them separate is what lets a reader tell a
   * genuinely slow machine from one that is simply gone.
   */
  recordHeartbeatMetrics(machineId, input = {}, nowMs = this.nowMs()) {
    const device = this.devices.get(machineId);
    if (!device) return null;
    device.last_heartbeat_at_ms = nowMs;
    const rtt = RabbitState.normalizeRtt(input.rtt_ms);
    if (rtt.valid) {
      device.rtt_ms = rtt.value;
      device.rtt_at_ms = nowMs;
    }
    return device;
  }

  /** True when there is no value, or the value is older than the staleness window. */
  isRttStale(device, nowMs = this.nowMs()) {
    if (!device || device.rtt_ms === null || device.rtt_ms === undefined) return true;
    if (device.rtt_at_ms === null || device.rtt_at_ms === undefined) return true;
    return nowMs - device.rtt_at_ms > this.rttStaleMs;
  }

  /** How old the RTT measurement is, in ms; null when there is none. */
  rttAgeMs(device, nowMs = this.nowMs()) {
    if (!device || device.rtt_at_ms === null || device.rtt_at_ms === undefined) return null;
    return Math.max(0, nowMs - device.rtt_at_ms);
  }

  /** Record that a machine attached a stream (a reconnect is any attach after the first). */
  noteStreamConnect(machineId) {
    const device = this.devices.get(machineId);
    if (!device) return null;
    device.stream_connects = (device.stream_connects ?? 0) + 1;
    return device.stream_connects;
  }

  /**
   * v0.3.0 aggregate for `/healthz`.
   *
   * Only FRESH measurements count. A machine that has been gone for a day must not
   * drag min/max/avg around, and with no fresh data every numeric field is null --
   * never 0, which would read as "instantaneous".
   */
  rttSummary(nowMs = this.nowMs()) {
    const fresh = [];
    let stale = 0;
    let unknown = 0;
    for (const device of this.devices.values()) {
      if (device.rtt_ms === null || device.rtt_ms === undefined) { unknown += 1; continue; }
      if (this.isRttStale(device, nowMs)) { stale += 1; continue; }
      fresh.push(device.rtt_ms);
    }
    if (fresh.length === 0) {
      return {
        machines_reporting: 0,
        min_ms: null,
        max_ms: null,
        avg_ms: null,
        machines_stale: stale,
        machines_unknown: unknown,
      };
    }
    const sum = fresh.reduce((a, b) => a + b, 0);
    return {
      machines_reporting: fresh.length,
      min_ms: Math.min(...fresh),
      max_ms: Math.max(...fresh),
      avg_ms: Math.round((sum / fresh.length) * 10) / 10,
      machines_stale: stale,
      machines_unknown: unknown,
    };
  }

  /**
   * v0.9.1: how long since this device last made any contact, or null when it never has.
   *
   * `last_seen_at_ms` is the right field rather than `last_heartbeat_at_ms`: `touchDevice` advances it
   * on every contact the relay accepts — a heartbeat, a task poll, a lease renewal — so it measures
   * "is anything there", while `last_heartbeat_at_ms` measures "has it ever heartbeated", which is
   * null for an agent old enough not to send them.
   *
   * Falls back to `paired_at_ms` so that a device which paired but has not spoken since is judged
   * from the moment it arrived rather than from `null`, which would have read as "silent forever" and
   * marked it offline the instant it appeared.
   *
   * @param {object} device
   * @param {number} nowMs
   * @returns {number|null}
   */
  silenceAgeMs(device, nowMs = this.nowMs()) {
    const seen = device.last_seen_at_ms ?? device.last_heartbeat_at_ms ?? device.paired_at_ms ?? null;
    if (seen === null || seen === undefined) return null;
    return Math.max(0, nowMs - seen);
  }

  /**
   * v0.9.1 §4.3 companion: declare a device silent once nothing has contacted the relay for
   * {@link DEFAULT_SILENCE_MS}.
   *
   * ## Why this exists next to `sweepExpired`
   *
   * `sweepExpired` writes off lease *holds*; this writes off *presence*. Both are expiry, and they
   * were conflated: a machine that stopped existing was only noticed when its SSE stream actually
   * detached, so a half-open stream — a killed process, a pulled cable, a laptop lid — left it
   * `online: true` and selectable for as long as the socket stayed open, which can be hours or
   * indefinitely.
   *
   * Going through {@link setOnline} is the point rather than an implementation detail: it flips the
   * flag **and emits `peer.bye`**, which is what tells every other machine in the fleet. Fixing only
   * the flag would correct `/v1/devices` on the relay while leaving every agent's own view — and
   * therefore every machine picker — still showing a departed machine.
   *
   * @param {number} [nowMs]
   * @returns {Array<{machine_id: string, machine_name: string, silent_ms: number}>} what was swept
   */
  sweepSilentDevices(nowMs = this.nowMs()) {
    const went = [];
    for (const device of this.devices.values()) {
      if (device.online !== true) continue;
      const age = this.silenceAgeMs(device, nowMs);
      if (age === null || age < this.silenceMs) continue;
      this.emit('notice', {
        level: 'info',
        code: 'DEVICE_SILENT',
        message: `machine ${device.machine_name} (${device.machine_id}) stopped making contact; marking it offline`,
        machine_id: device.machine_id,
        silent_ms: age,
      });
      this.setOnline(device.machine_id, false, 'silent');
      went.push({ machine_id: device.machine_id, machine_name: device.machine_name, silent_ms: age });
    }
    return went;
  }

  /**
   * v0.3.0 single-machine status view.
   *
   * `last_heartbeat_at` and `rtt_at` answer different questions, and the gap
   * between them is the whole point: a machine can be heartbeating (alive) while
   * its RTT number is old (a v0.2.3 agent that never sends `rtt_ms`), and a
   * machine can be gone while a plausible-looking RTT is still on file.
   *
   * v0.9.1: `online` is additionally cross-checked against silence, so a direct call to this method
   * (a test, or a caller that never runs the sweep) cannot report a departed machine as present.
   * The sweep is still what fixes the flag and broadcasts; this only refuses to repeat a stale `true`.
   */
  /**
   * Whether this device is usable right now: its flag is set AND it is not silent.
   *
   * \`device.online === true\` alone is not the answer -- the flag stays true until the sweep runs, so a machine whose
   * agent stopped heartbeating was still a dispatch target. The same expression appeared in \`deviceStatus\`,
   * \`publicDevice\` and (v1.1.2) the default target list; one definition keeps the list and the dispatch from
   * disagreeing about which machines exist.
   *
   * \`silentMs === null\` means no contact has ever been observed, and that is NOT silent.
   */
  isOnlineDevice(device, nowMs = this.nowMs()) {
    if (!device || device.online !== true) return false;
    const silentMs = this.silenceAgeMs(device, nowMs);
    return !(silentMs !== null && silentMs >= this.silenceMs);
  }

  deviceStatus(machineId, nowMs = this.nowMs()) {
    const device = this.devices.get(machineId);
    if (!device) return null;
    const rttAt = device.rtt_at_ms ?? null;
    const lastHeartbeat = device.last_heartbeat_at_ms ?? null;
    const silentMs = this.silenceAgeMs(device, nowMs);
    const silent = device.online === true && silentMs !== null && silentMs >= this.silenceMs;
    return {
      machine_id: device.machine_id,
      machine_name: device.machine_name,
      relay_id: this.relayId,
      connected: (device.streams ?? 0) > 0,
      streams: device.streams ?? 0,
      online: this.isOnlineDevice(device),
      /**
       * Why this machine is not usable, when it is not. `null` for a healthy one.
       *
       * Added because "offline" without a reason is exactly the shape that made this defect hard to
       * see: a machine that had been powered off for hours was listed `online`, and a machine that is
       * correctly offline still gives no clue whether it is gone or merely quiet.
       *
       * `silent` first, for the same reason as in `publicDevice`: the stored flag is `true` in the
       * half-open case, so the silence is the finding.
       */
      offline_reason: silent ? 'silent' : (device.online !== true ? 'stream_closed' : null),
      silent_ms: silentMs,
      rtt_ms: device.rtt_ms ?? null,
      rtt_at: rttAt === null ? null : rfc3339(rttAt),
      rtt_age_ms: this.rttAgeMs(device, nowMs),
      rtt_stale: this.isRttStale(device, nowMs),
      last_heartbeat_at: lastHeartbeat === null ? null : rfc3339(lastHeartbeat),
      last_seen_at: device.last_seen_at_ms === null || device.last_seen_at_ms === undefined
        ? null : rfc3339(device.last_seen_at_ms),
      reconnect_attempts: Math.max(0, (device.stream_connects ?? 0) - 1),
      stream_connects: device.stream_connects ?? 0,
      paired_at: device.paired_at_ms === null || device.paired_at_ms === undefined
        ? null : rfc3339(device.paired_at_ms),
      platform: device.platform,
      caps: device.caps,
      user_id: device.user_id ?? null,
      now: rfc3339(nowMs),
    };
  }

  /** Public device view — never leaks device_token. */
  publicDevice(device) {
    // Computed once, so the three fields below cannot disagree with each other.
    const silentMs = this.silenceAgeMs(device);
    const silent = silentMs !== null && silentMs >= this.silenceMs;
    return {
      machine_id: device.machine_id,
      machine_name: device.machine_name,
      platform: device.platform,
      caps: device.caps,
      user_id: device.user_id,
        /**
         * v0.7.7: the fleet this device belongs to, and where the fact came from.
         *
         * **Carried in the public shape on purpose, and it has to be**, because `devices.json`
         * is written from this shape -- a fleet that lived only on the in-memory record would
         * vanish on the next restart, which is precisely when an operator is looking at it. A
         * first version omitted these and the live test caught the fleet disappearing from
         * `listDevices()`.
         *
         * Safe to expose: `fleet_id` is a truncated hash of the account id, not the account id,
         * and devices on one relay can already enumerate each other. Narrowing `/v1/devices` to
         * a device's own fleet is a further step, recorded as such rather than implied.
         */
        fleet_id: device.fleet_id ?? null,
        fleet_source: device.fleet_source ?? null,
        // v0.7.10: a boolean rather than the key itself. The key is not a secret, but a device
        // list is read by every device, and there is no reason to hand every machine every other
        // machine's key when the verification happens relay-side.
        public_key_present: typeof device.public_key === 'string' && device.public_key !== '',
      /**
       * v0.9.1: `online` is derived, not just read.
       *
       * It used to be the raw stored flag, which is only ever written by the SSE stream attaching or
       * detaching. A half-open stream therefore reported `online: true` for a machine that was gone,
       * and `/v1/devices` handed that to every machine picker in the fleet. The sweep is what flips
       * the stored flag and broadcasts `peer.bye`; this expression makes the read agree with it even
       * between sweeps, so no caller can observe the stale value at all.
       */
      online: this.isOnlineDevice(device),
      streams: device.streams,
      /**
       * v0.9.1: why this machine is not usable, when it is not.
       *
       * `silent` is tested FIRST, and that order is the whole subtlety: a half-open stream leaves the
       * stored `online` flag `true`, so testing `device.online !== true` first reported
       * `stream_closed` for a machine whose stream was precisely the thing still attached. The
       * reported defect in one line -- the flag says connected, the truth says gone, and the reason
       * has to name the truth.
       */
      offline_reason: silent ? 'silent' : (device.online !== true ? 'stream_closed' : null),
      silent_ms: silentMs,
      paired_at: rfc3339(device.paired_at_ms),
      last_seen_at: rfc3339(device.last_seen_at_ms),
      // v0.3.0: `null` means "never measured", which is NOT the same as 0ms.
      rtt_ms: device.rtt_ms ?? null,
      rtt_at: device.rtt_at_ms === null || device.rtt_at_ms === undefined ? null : rfc3339(device.rtt_at_ms),
      rtt_age_ms: this.rttAgeMs(device),
      rtt_stale: this.isRttStale(device),
      last_heartbeat_at: device.last_heartbeat_at_ms === null || device.last_heartbeat_at_ms === undefined
        ? null : rfc3339(device.last_heartbeat_at_ms),
      reconnect_attempts: Math.max(0, (device.stream_connects ?? 0) - 1),
    };
  }

  listDevices() { return [...this.devices.values()].map((d) => this.publicDevice(d)); }

  /* ---------------- tasks (§4) ---------------- */

  /**
   * v0.4.0: validate the routing metadata a `POST /v1/task` body may carry.
   *
   * A machine, not a mode, is `origin_machine_id`: where the task was typed (`device.json`), so an
   * offer can carry that fact to the machine that has to run it. `p2p.mode` is the dispatcher's
   * resolved mode for this particular task — the plugin may be configured `direct` while a
   * scheduled run is `relay`.
   *
   * Validation is deliberately shallow and strictly typed, in the house style of this file: a
   * missing value is the v0.3.9 shape and stays valid, while a present-but-wrong value is refused
   * by name. Accepting a non-string here would put a number into `origin_machine_id` and only fail
   * later, on a machine that cannot tell a bad field from a bad relay.
   *
   * @returns {{origin_machine_id:string|null, p2p:{mode:string}|null}}
   */
  static validateTaskRouting(input = {}) {
    let originMachineId = null;
    if (input.origin_machine_id !== undefined && input.origin_machine_id !== null) {
      if (typeof input.origin_machine_id !== 'string'
        || input.origin_machine_id.length === 0
        || input.origin_machine_id.length > MAX_ORIGIN_MACHINE_ID_LENGTH) {
        throw new ProtocolError(
          'BAD_REQUEST',
          `origin_machine_id must be a non-empty string of at most ${MAX_ORIGIN_MACHINE_ID_LENGTH} characters`,
          { origin_machine_id: input.origin_machine_id },
        );
      }
      originMachineId = input.origin_machine_id;
    }

    let p2p = null;
    if (input.p2p !== undefined && input.p2p !== null) {
      if (typeof input.p2p !== 'object' || Array.isArray(input.p2p)) {
        throw new ProtocolError('BAD_REQUEST', 'p2p must be an object with a `mode` field', { p2p: input.p2p });
      }
      if (!P2P_MODES.includes(input.p2p.mode)) {
        throw new ProtocolError(
          'BAD_REQUEST',
          `p2p.mode must be one of ${P2P_MODES.join('|')}`,
          { 'p2p.mode': input.p2p.mode ?? null },
        );
      }
      // Copied rather than referenced: the recorded task must not be mutable through the request
      // body the caller still holds.
      p2p = { ...input.p2p };
    }

    return { origin_machine_id: originMachineId, p2p };
  }

  /**
   * v0.4.0 §5.2: validate the optional transport fields of a result envelope.
   *
   * Same reasoning as `validateTaskRouting`: `transport` is an enum and `p2p` is an opaque object,
   * so anything else is refused by name at the door. Both fields stay OUT of
   * `REQUIRED_ENVELOPE_FIELDS` (a missing one is a v0.3.9 envelope, not an incomplete one) and out
   * of `COMPARABLE_FIELDS` (a path is not a result).
   */
  static validateTransportFields(envelope = {}) {
    if (envelope.transport !== undefined && envelope.transport !== null) {
      if (!TRANSPORT_VALUES.includes(envelope.transport)) {
        throw new ProtocolError(
          'BAD_REQUEST',
          `transport must be one of ${TRANSPORT_VALUES.join('|')}`,
          { transport: envelope.transport },
        );
      }
    }
    if (envelope.p2p !== undefined && envelope.p2p !== null
      && (typeof envelope.p2p !== 'object' || Array.isArray(envelope.p2p))) {
      throw new ProtocolError('BAD_REQUEST', 'p2p must be an object', { p2p: envelope.p2p });
    }
  }

  /**
   * §4.1 POST /v1/task.
   * Machine selection is not specified by the PROTOCOL; we implement:
   *   - `target_machines` (optional explicit list), else every paired device
   *   - capability gate §6.1 per machine (failures become `refused` leases)
   *   - index assignment: replicate -> 0, split -> round-robin modulo index_total
   */
  createTask(input = {}) {
    // v0.4.0: refused BEFORE the task literal is built and before any offer is emitted, so a bad
    // value cannot leave a half-created task behind. `POST /v1/task` is all-or-nothing.
    const routing = RabbitState.validateTaskRouting(input);
    // v1.2.4: prerequisites are validated where the task is CREATED. A graph that only fails later puts the
    // refusal on a machine that did not create the problem.
    const deps = validateTaskDependencies({
      task_id: typeof input.task_id === 'string' ? input.task_id : null,
      depends_on: input.depends_on,
      tasksById: this.tasks,
    });
    if (deps.ok !== true) return { status: 'refused', refusal_reason: deps.code, detail: deps.detail ?? {} };

    const mode = input.mode ?? 'replicate';
    if (mode !== 'replicate' && mode !== 'split' && mode !== 'broadcast' && mode !== 'pipeline' && mode !== 'compose' && mode !== 'mapreduce') {
      throw new ProtocolError(
        'BAD_REQUEST',
        'mode must be replicate|split|broadcast|pipeline|compose|mapreduce',
        { mode },
      );
    }
    /**
     * v0.3.3 `pipeline`: the whole chain runs on each machine, stage after stage.
     *
     * The semantics were chosen against the alternative (fan out stage 1, converge its outputs into
     * stage 2) because that one has no well-defined input: on a fleet, stage 1 produces n different
     * outputs, and "feed them all to stage 2" does not say in what order, or whether stage 2 then
     * runs once or n times. Worse, two machines finishing in a different order would produce
     * different stage-2 inputs, so one task_id would no longer describe one reproducible execution --
     * which is the property the rest of this system is built on. See docs/PIPELINE-DESIGN.md.
     *
     * So: a pipeline is `replicate` applied to a sequence. Every machine runs the whole chain, there
     * is no cross-machine data flow, and nothing new can be silently dropped in transit.
     */
    const rawStages = Array.isArray(input.stages) ? input.stages : null;
    const isPipeline = mode === 'pipeline';
    if (isPipeline) {
      if (rawStages === null || rawStages.length === 0) {
        throw new ProtocolError('BAD_REQUEST', 'mode=pipeline requires a non-empty `stages` array', {
          stages: rawStages === null ? null : rawStages.length,
        });
      }
      if (rawStages.length > MAX_PIPELINE_STAGES) {
        throw new ProtocolError('BAD_REQUEST', `stages must have at most ${MAX_PIPELINE_STAGES} entries`, {
          stages: rawStages.length,
        });
      }
      rawStages.forEach((stage, i) => {
        const argv = stage?.command_argv;
        if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
          throw new ProtocolError('BAD_REQUEST', `stages[${i}].command_argv must be a non-empty string[]`, { index: i });
        }
      });
      // A chain is one execution on one machine; sharding it would mean each machine ran a chain of
      // its own slice, which is a different feature and not what the caller asked for.
      if (Number.isInteger(input.index_total) && input.index_total !== 1) {
        throw new ProtocolError('BAD_REQUEST', 'mode=pipeline runs the whole chain per machine, so index_total must be 1', {
          index_total: input.index_total,
        });
      }
    } else if (rawStages !== null) {
      // Refused rather than ignored: the caller believes they described a sequence, and running only
      // `command_argv` would silently drop every stage after the first.
      throw new ProtocolError('BAD_REQUEST', '`stages` is only valid with mode=pipeline', { mode, stages: rawStages.length });
    }

    /**
     * Normalized stage list. For every mode there is at least one stage, so downstream code has a
     * single shape to reason about and `pipeline` is not a special case at the execution layer.
     */
    const stages = isPipeline
      ? rawStages.map((s, i) => ({
        index: i,
        command_argv: [...s.command_argv],
        cwd_rel: typeof s.cwd_rel === 'string' && s.cwd_rel ? s.cwd_rel : (typeof input.cwd_rel === 'string' && input.cwd_rel ? input.cwd_rel : '.'),
        timeout_ms: Number.isInteger(s.timeout_ms) ? s.timeout_ms : null,
        continue_on_failure: s.continue_on_failure === true,
      }))
      : null;

    const commandArgv = isPipeline ? [...rawStages[0].command_argv] : input.command_argv;
    if (!Array.isArray(commandArgv) || commandArgv.length === 0 || commandArgv.some((a) => typeof a !== 'string')) {
      throw new ProtocolError('BAD_REQUEST', 'command_argv must be a non-empty string[]');
    }
    const indexTotal = Number.isInteger(input.index_total) ? input.index_total : 1;
    if (indexTotal < 1) throw new ProtocolError('BAD_REQUEST', 'index_total must be >= 1');
    /**
     * v1.2.4 mapreduce: the map half is ordinary dispatch; the reduce half is described here so the caller can run it as an
     * explicit second task once w2m_wait has verified every shard is present. Deliberately NOT a cascade: a relay that
     * launches the reduce itself would decide on a partial fleet, and the operator would see one task id for two executions.
     */
    let reduceArgv = null;
    let reducerMachineId = null;
    if (mode === 'mapreduce') {
      if (indexTotal !== 1) {
        throw new ProtocolError('BAD_REQUEST', 'mode=mapreduce maps the whole input on every machine, so index_total must be 1', { index_total: indexTotal });
      }
      const argv = input.reduce_argv;
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || part === '')) {
        throw new ProtocolError('BAD_REQUEST', 'mode=mapreduce requires reduce_argv as a non-empty string[]', { reduce_argv: argv ?? null });
      }
      reduceArgv = [...argv];
      if (input.reducer_machine_id !== undefined && input.reducer_machine_id !== null && typeof input.reducer_machine_id !== 'string') {
        throw new ProtocolError('BAD_REQUEST', 'reducer_machine_id must be a machine id string', { reducer_machine_id: input.reducer_machine_id });
      }
      reducerMachineId = typeof input.reducer_machine_id === 'string' && input.reducer_machine_id !== '' ? input.reducer_machine_id : null;
    } else if (input.reduce_argv !== undefined || input.reducer_machine_id !== undefined) {
      throw new ProtocolError('BAD_REQUEST', 'reduce_argv and reducer_machine_id are only valid with mode=mapreduce', { mode });
    }

    const halt = input.halt ?? 'never';
    if (halt !== 'never' && halt !== 'now') throw new ProtocolError('BAD_REQUEST', 'halt must be never|now', { halt });
    /**
     * v1.2.4 retry policy: how many attempts the task may take in total, and which terminal conditions justify
     * another. Default one attempt and no retry, so every existing caller keeps at-most-once semantics.
     */
    const maxAttempts = Number.isInteger(input.max_attempts) ? input.max_attempts : 1;
    if (maxAttempts < 1 || maxAttempts > 5) {
      throw new ProtocolError('BAD_REQUEST', 'max_attempts must be an integer 1..5', { max_attempts: input.max_attempts });
    }
    const RETRYABLE = ['expired', 'failed', 'partial', 'timeout'];
    if (input.retry_on !== undefined && !Array.isArray(input.retry_on)) {
      throw new ProtocolError('BAD_REQUEST', 'retry_on must be an array of expired|failed|partial|timeout', { retry_on: input.retry_on });
    }
    const retryOn = Array.isArray(input.retry_on) ? [...new Set(input.retry_on)] : [];
    if (retryOn.some((reason) => typeof reason !== 'string' || !RETRYABLE.includes(reason))) {
      throw new ProtocolError('BAD_REQUEST', 'retry_on must list expired|failed|partial|timeout', { retry_on: input.retry_on, retryable: RETRYABLE });
    }

    const taskId = input.task_id ?? this.nextId();
    if (this.tasks.has(taskId)) {
      throw new ProtocolError('TASK_EXISTS', 'task_id already exists', { task_id: taskId });
    }

    const now = this.nowMs();
    const cwdRel = typeof input.cwd_rel === 'string' && input.cwd_rel ? input.cwd_rel : '.';
    const baseTree = input.base_tree ?? null;
    const commandHash = input.command_hash ?? (isPipeline
      ? computePipelineCommandHash(stages, SHELL_ID_DIRECT)
      : computeCommandHash(commandArgv, SHELL_ID_DIRECT, cwdRel));
    const timeoutMs = Number.isInteger(input.timeout_ms) ? input.timeout_ms : 300_000;

    // v0.3.3 `broadcast`: one machine runs the command, every other machine is told the outcome.
    //
    // The executor choice is deterministic rather than random. A random leader makes a task
    // impossible to reproduce from its own record -- the same task id would run somewhere else on a
    // retry -- and this project's whole value rests on being able to say exactly where something ran.
    // The first target in the relay's own device order is stable for a given device table.
    //
    // Observers get a lease so they are tracked and notified, but their lease is `observing`, which
    // every aggregation step treats as "did not run". That distinction is the point: a machine that
    // never executed anything agreeing with a result would be a fabrication, and it is exactly the
    // fabrication this mode could most easily produce.
    //
    // Resolved before the task literal because the literal records it. (`targets` is computed below,
    // so the executor is re-validated against it after that.)
    /**
     * v1.1.2: a dispatch that names no machines goes to the machines that are **online**.
     *
     * WHY THIS IS THE DEFAULT: this line used to return every paired device, including one whose agent stopped
     * heartbeating days ago. The relay still built it a lease, that lease expired, and \`partial\` became the only
     * verdict the task could reach -- so a fleet whose live machines agreed reported "incomplete" forever
     * (observed 2026-10-17: \`ok: 3, expired: 4\`). Liveness is the relay's own knowledge, which is why the fix
     * belongs here and not in a client-side pre-read that would add a round trip to every dispatch.
     *
     * \`include_offline: true\` restores the old behaviour for the operator who really does want to queue work for a
     * machine that is down. A device that comes back is online again and rejoins the default set with no bookkeeping:
     * nothing is deleted, and the only state consulted is \`online\`.
     */
    const targetIds = Array.isArray(input.target_machines) && input.target_machines.length > 0
      ? input.target_machines
      : input.include_offline === true || mode === 'broadcast'
        // broadcast is NOT a fan-out: it names one executor and tells the rest the outcome. Narrowing the default set
        // here would change WHICH machine is elected (or make the election impossible when the fixture's devices are
        // not marked online), so the default set stays every paired device for this mode only.
        ? [...this.devices.keys()]
        : [...this.devices.entries()].filter(([, d]) => this.isOnlineDevice(d)).map(([id]) => id);
    const executorMachineId = mode === 'broadcast'
      ? (typeof input.executor_machine_id === 'string' && input.executor_machine_id !== ''
        ? input.executor_machine_id
        : targetIds[0] ?? null)
      : null;

    /**
     * v1.2.10: validate the reduce artifact list up front. A malformed list would otherwise become an offer the machine
     * cannot execute, and the failure would surface as a generic refusal on the executor instead of at dispatch.
     */
    /**
     * v1.3.10-beta.2: a maintenance request is opaque to the relay (the root runner is the authority) but its shape and
     * size are checked here so a malformed request is refused at dispatch instead of on a machine it was never meant for.
     */
    const rawMaintenance = input.maintenance ?? null;
    let normalizedMaintenance = null;
    if (rawMaintenance !== null) {
      if (typeof rawMaintenance !== 'object' || Array.isArray(rawMaintenance) || Buffer.byteLength(JSON.stringify(rawMaintenance), 'utf8') > 64 * 1024) {
        throw new ProtocolError('BAD_REQUEST', 'maintenance must be an object of at most 64 KiB', {});
      }
      if (typeof rawMaintenance.request_id !== 'string' || rawMaintenance.request_id === '') {
        throw new ProtocolError('BAD_REQUEST', 'maintenance.request_id is required', {});
      }
      normalizedMaintenance = rawMaintenance;
    }
    /**
     * v1.3.10-beta.3: a task-level grant travels with the dispatch. The relay checks its shape and time window so a bad
     * grant is refused at dispatch, but the agent is the verifier — the relay never decides authorisation on its own.
     */
    /**
     * v1.3.13-beta.1 (task model): a task may explain WHICH copy of the project it runs on. The relay validates the
     * descriptor and carries it, exactly as it carries argv: the machine that owns the copy decides whether it can honour
     * it (and the agent currently refuses a workspace task with WORKSPACE_UNSUPPORTED until the execution slice lands).
     */
    const rawWorkspace = input.workspace ?? null;
    let normalizedWorkspace = null;
    if (rawWorkspace !== null) {
      if (typeof rawWorkspace !== 'object' || Array.isArray(rawWorkspace) || Buffer.byteLength(JSON.stringify(rawWorkspace), 'utf8') > 4 * 1024) {
        throw new ProtocolError('BAD_REQUEST', 'workspace must be an object of at most 4 KiB', {});
      }
      if (rawWorkspace.kind !== 'worktree') throw new ProtocolError('BAD_REQUEST', "workspace.kind must be 'worktree'", { kind: rawWorkspace.kind });
      if (typeof rawWorkspace.base_commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(rawWorkspace.base_commit)) {
        throw new ProtocolError('BAD_REQUEST', 'workspace.base_commit must be a hex commit id', { base_commit: rawWorkspace.base_commit });
      }
      const produce = rawWorkspace.produce ?? 'patch';
      if (!['patch', 'commit', 'none'].includes(produce)) throw new ProtocolError('BAD_REQUEST', "workspace.produce must be patch, commit or none", { produce });
      normalizedWorkspace = { kind: 'worktree', base_commit: rawWorkspace.base_commit, produce };
    }
    const rawGrant = input.grant ?? null;
    let normalizedGrant = null;
    if (rawGrant !== null) {
      if (typeof rawGrant !== 'object' || Array.isArray(rawGrant) || Buffer.byteLength(JSON.stringify(rawGrant), 'utf8') > 8 * 1024) {
        throw new ProtocolError('BAD_REQUEST', 'grant must be an object of at most 8 KiB', {});
      }
      if (typeof rawGrant.grant_id !== 'string' || rawGrant.grant_id === '' || !/^[0-9a-f]{64}$/.test(String(rawGrant.argv_hash ?? ''))) {
        throw new ProtocolError('BAD_REQUEST', 'grant needs grant_id and a 64-hex argv_hash', {});
      }
      // v1.3.12-beta.1: dispatch-side preflight of the execution-authorization model. The agent verifies the signature and
      // the use ledger; the relay refuses a grant that is plainly for another task or another argv, by name, before any
      // machine sees the task. This is a caller-bug check, not a second authorisation decision.
      if (typeof rawGrant.task_id === 'string' && rawGrant.task_id !== '' && rawGrant.task_id !== taskId) {
        throw new ProtocolError('GRANT_TASK_MISMATCH', 'the grant names another task_id', { grant_task_id: rawGrant.task_id, task_id: taskId });
      }
      if (grantArgvHash(commandArgv) !== String(rawGrant.argv_hash)) {
        throw new ProtocolError('GRANT_ARGV_MISMATCH', 'the grant argv_hash does not match command_argv', { argv_hash: String(rawGrant.argv_hash), computed: grantArgvHash(commandArgv) });
      }
      if (rawGrant.expires_at !== undefined) {
        const expiresAt = Date.parse(String(rawGrant.expires_at));
        if (Number.isNaN(expiresAt)) throw new ProtocolError('BAD_REQUEST', 'grant.expires_at is not a timestamp', { expires_at: rawGrant.expires_at });
        if (expiresAt <= this.nowMs()) throw new ProtocolError('GRANT_EXPIRED', 'the grant has already expired', { expires_at: rawGrant.expires_at });
      }
      if (this.revokedGrants.has(String(rawGrant.grant_id))) {
        throw new ProtocolError('GRANT_REVOKED', 'the grant was revoked by the operator', { grant_id: String(rawGrant.grant_id) });
      }
      normalizedGrant = rawGrant;
    }
    const rawOperatorKey = input.operator_key ?? null;
    let normalizedOperatorKey = null;
    if (rawOperatorKey !== null) {
      if (typeof rawOperatorKey !== 'object' || Array.isArray(rawOperatorKey)) throw new ProtocolError('BAD_REQUEST', 'operator_key must be an object', {});
      if (typeof rawOperatorKey.key_id !== 'string' || typeof rawOperatorKey.public_key_pem !== 'string') {
        throw new ProtocolError('BAD_REQUEST', 'operator_key needs key_id and public_key_pem', {});
      }
      normalizedOperatorKey = { key_id: rawOperatorKey.key_id, public_key_pem: rawOperatorKey.public_key_pem, created_at: rawOperatorKey.created_at ?? new Date(this.nowMs()).toISOString() };
      if (this.operatorKeys.has(normalizedOperatorKey.key_id) === false) {
        this.operatorKeys.set(normalizedOperatorKey.key_id, normalizedOperatorKey);
        this._ledger({ type: 'operator.key.registered', key: normalizedOperatorKey });
      }
    }
    const rawReduceInputs = input.reduce_inputs === undefined || input.reduce_inputs === null ? [] : input.reduce_inputs;
    if (!Array.isArray(rawReduceInputs) || rawReduceInputs.length > 16) {
      throw new ProtocolError('BAD_REQUEST', 'reduce_inputs must be an array of at most 16 artifacts', { count: Array.isArray(rawReduceInputs) ? rawReduceInputs.length : null });
    }
    const normalizedReduceInputs = [];
    for (const artifact of rawReduceInputs) {
      const machineId = typeof artifact?.machine_id === 'string' && artifact.machine_id !== '' ? artifact.machine_id : null;
      const sha256 = typeof artifact?.sha256 === 'string' ? artifact.sha256.toLowerCase() : '';
      if (machineId === null || !/^[0-9a-f]{64}$/.test(sha256)) {
        throw new ProtocolError('BAD_REQUEST', 'each reduce input must be {machine_id, sha256}', { machine_id: machineId, sha256 });
      }
      normalizedReduceInputs.push({ machine_id: machineId, sha256 });
    }

    const task = {
      task_id: taskId,
      mode,
      command_argv: commandArgv,
      cwd_rel: cwdRel,
      // v0.43.0. The task construction is field-by-field, so a field not named here is silently dropped --
      // which is how a parameter can be accepted by the tool, validated by the tool, and never reach the
      // machine. Named explicitly so it travels.
      cwd_outside_project: input.cwd_outside_project === true,
      index_total: indexTotal,
      // v1.2.4: the reduce half travels with the task so a caller (and a revived relay) can read what was intended.
      ...(mode === 'mapreduce' ? { reduce_argv: reduceArgv, reducer_machine_id: reducerMachineId } : {}),
      timeout_ms: timeoutMs,
      write: input.write === true,
      write_scope: input.write_scope ?? [],
      require_exclusive_write: input.require_exclusive_write === true,
      base_commit: input.base_commit ?? null,
      base_tree: baseTree,
      requirements: input.requirements ?? {},
      compare_policy: input.compare_policy ?? {},
      include_offline: input.include_offline === true,
      halt,
      created_by: input.created_by ?? null,
        // v1.5.5: the fleet a task belongs to, so list endpoints can scope by it.
        // v1.5.5: the fleet this task belongs to, computed from the same requester rule fleet scoping
        // uses. scopedRequester is declared further down (target selection), so it cannot be referenced
        // from the task literal; this expression reads the same sources and stays a pure lookup.
        fleet_id: ((typeof input.created_by === 'string' ? this.devices.get(input.created_by) : null) ||
          (typeof input.requester_machine_id === 'string' ? this.devices.get(input.requester_machine_id) : null) ||
          (this.fleetId !== null ? { fleet_id: this.fleetId } : null))?.fleet_id ?? null,
      created_at_ms: now,
      command_hash: commandHash,
      attempt: 1,
      // v1.2.4: the policy travels with the task so a revived relay can still decide to retry after a restart.
      max_attempts: maxAttempts,
      retry_on: retryOn,
      // v1.2.4: prerequisites and an assignee travel with the task, because a graph the relay validated but did not
      // store would have to be re-derived later -- and a re-derivation that disagrees with the validation is exactly
      // the silent-drop failure this field-by-field literal exists to prevent.
      depends_on: deps.ok === true ? deps.depends_on : [],
      assignee: typeof input.assignee === 'string' && input.assignee !== '' ? input.assignee : null,
      /**
       * v1.2.10: a reduce task names the map task it reduces and the artifacts it consumes. The artifact LIST travels with
       * the task (never inferred by the reducer), because "which shards this reduce covers" is the completeness contract.
       */
      project_id: this.ensureProject(input.project_id ?? null),
      reduce_of: typeof input.reduce_of === 'string' && input.reduce_of !== '' ? input.reduce_of : null,
      workspace: normalizedWorkspace,
      grant: normalizedGrant,
      grant_summary: normalizedGrant === null ? null : { grant_id: normalizedGrant.grant_id, argv_hash: normalizedGrant.argv_hash, key_id: normalizedGrant.signature?.key_id ?? null },
      /** v1.3.10-beta.2: a signed maintenance request travels with the task; the relay carries it, the root runner verifies it. */
      maintenance: normalizedMaintenance,
      operator_key: normalizedOperatorKey,
      maintenance_summary: normalizedMaintenance === null ? null : { request_id: normalizedMaintenance.request_id ?? null, action: normalizedMaintenance.action ?? null },
      reduce_inputs: normalizedReduceInputs,
      leases: new Map(),
      cancelled: false,
      cancel_reason: null,
      degraded: null,
      deadline_ms: now + timeoutMs,
      result_seqs: [],
      /** v0.3.3: which machine actually executes under `broadcast`; null for the other modes. */
      executor_machine_id: executorMachineId,
      /**
       * v0.3.3: the normalized stage list for `pipeline`, or null.
       *
       * Sent to the machine in the offer so it can run the whole chain. Kept on the task as well so
       * a report can say how many stages were supposed to run even when the machine crashed before
       * reporting any of them.
       */
      stages,
      /**
       * v0.4.0: where the task came from and under which P2P mode it was dispatched, or null.
       *
       * Kept on the task (not just passed to `emitOffer`) because an offer is emitted more than
       * once: `redeliverPendingOffers` re-states unclaimed work on every reconnect and
       * `_takeover` re-offers a freed index. A machine that reconnects must see the same routing
       * facts as the machine that was connected at dispatch time, or the direct-push half of the
       * feature would work exactly once and then quietly stop.
       */
      origin_machine_id: routing.origin_machine_id,
      p2p: routing.p2p,
    };

    /**
     * Fleet scoping (v0.7.7).
     *
     * This replaces `targets = [...this.devices.values()]`, which reached **every device on the
     * relay** with no filter — the finding that accounts were not isolated. The rule now lives in
     * `fleet-wiring.mjs` so it is one function with its own exhaustive tests rather than three
     * lines inside a two-thousand-line object.
     *
     * ## The migration is deliberate, and so is its limit
     *
     * The shared relay holds four devices that paired before fleets existed, and none of them has
     * a `fleet_id`. `targetsFor` therefore has two modes: a relay with no fleet configured keeps
     * exactly the old behaviour, and a relay that *is* scoped refuses a fleetless requester rather
     * than handing it the run of the fleet. So deploying this cannot be an outage, and scoping it
     * cannot be a silent grant.
     *
     * ## What this does NOT do, stated here rather than discovered later
     *
     * `POST /v1/task` authenticates with the **operator token**, and `authorizeTaskDispatch`
     * returns `{ role: 'operator', machine_id: null }` for it — there is no device, so there is no
     * fleet to scope by. Every device that authenticates with a **device token** gets full
     * isolation from this change; an operator-token dispatch remains relay-wide, because the
     * operator token *is* the relay-wide credential by design.
     *
     * `input.created_by` is the one device identity a task carries, and it is used when present:
     * a task submitted on behalf of a machine is scoped to that machine's fleet.
     */
    const requester =
      (typeof input.created_by === 'string' && this.devices.get(input.created_by)) ||
      (typeof input.requester_machine_id === 'string' && this.devices.get(input.requester_machine_id)) ||
      null;

    /**
     * An operator-token dispatch, on a relay that has been scoped, acts **within that scope**.
     *
     * A first version passed `requester: null` and let it be refused -- which broke every
     * operator dispatch on a scoped relay, and broke it in the least useful way: the operator had
     * just configured the fleet, and configuring it made them unable to dispatch at all.
     *
     * The reasoning for the fix: the relay's own `fleetId` *is* an admin's statement about which
     * fleet this relay serves. An operator dispatch therefore has an unambiguous scope, and
     * refusing it would be refusing the case that was explicitly asked for.
     *
     * What stays genuinely ambiguous is an operator dispatch on a relay holding **several** fleets
     * with no fleet of its own -- there is no way to tell which was meant, so `targetsFor` refuses
     * that rather than guessing.
     */
    const scopedRequester =
      requester ??
      (this.fleetId === null ? null : { machine_id: null, fleet_id: this.fleetId, fleet_source: 'relay_scope' });

    const scoped = targetsFor({
      devices: [...this.devices.values()],
      requester: scopedRequester,
      targetMachines: input.target_machines,
      relayFleetId: this.fleetId ?? null,
      // The existing code did not filter offline devices at selection time -- it offered to them and
      // let the lease expire. Keeping that here avoids changing two behaviours at once, and the
      // lease expiry is what `handoff.mjs` is for.
      requireOnline: false,
    });
    if (!scoped.ok) {
      /**
       * `NO_ONLINE_DEVICE`, not a new code.
       *
       * A first version invented `NO_ELIGIBLE_DEVICE`, which broke the one relay test that pins
       * this contract — and worse, it would have broken **callers**: `chatops/fleet.mjs` reads
       * `NO_ONLINE_DEVICE` to produce *"start an agent on each machine"*, and a code it has never
       * seen falls through to a generic refusal. The protocol's code table is part of the
       * protocol, and adding a member to it is a decision for a protocol revision, not for a
       * wiring change.
       *
       * What *is* new is why nothing was eligible, and that belongs in `detail`, where a caller
       * can read it without a new code entering the table.
       */
      throw new ProtocolError('NO_ONLINE_DEVICE', scoped.text, {
        reason: scoped.reason,
        legacy: scoped.legacy,
        fleet_scoped: scoped.legacy === false,
        hint:
          scoped.reason === 'requester_has_no_fleet'
            ? 'this relay is bound to a fleet and the requesting device is in none; pair it with a code issued for that fleet'
            : scoped.reason === 'target_outside_fleet'
              ? 'the named target is not in this fleet'
              : 'check that at least one device in this fleet is paired and streaming',
      });
    }
    const targets = scoped.targets;
    if (scoped.legacy) {
      // Logged at debug so an operator reading logs during a migration can see which rule applied.
      // "N targets" alone does not say whether isolation is on, and that is the question being asked.
      this.log?.('debug', 'task targets selected without a fleet (legacy path)', {
        task_candidates: targets.length,
        relay_fleet_id: this.fleetId ?? null,
      });
    }

    // v0.3.3 `broadcast`: validated here, where `targets` is known. The executor id itself was
    // resolved before the task literal because the literal records it.
    if (mode === 'broadcast' && executorMachineId !== null && !targets.some((d) => d.machine_id === executorMachineId)) {
      throw new ProtocolError('BAD_REQUEST', 'executor_machine_id is not among the target machines', {
        executor_machine_id: executorMachineId,
        targets: targets.map((d) => d.machine_id),
      });
    }

    if (targets.length === 0) {
      throw new ProtocolError('NO_ONLINE_DEVICE', 'no paired device available for this task', {
        /**
         * v0.9.0: `all` was never defined here — this threw `ReferenceError: all is not defined`
         * instead of the refusal it was written to be, and it did so on **the one path an operator
         * actually reaches**: `targets` is empty exactly when the fleet has nothing to dispatch to,
         * which is what a freshly configured machine sees before its first peer joins.
         *
         * The count an operator needs there is "how many devices does this relay know at all",
         * because the answer distinguishes *"nothing is paired"* from *"something is paired but
         * scoped out"* — and `targets` being fleet-filtered cannot answer that. `this.devices` is
         * the unfiltered set the same call hands to `targetsFor` a few lines above (see the
         * `devices: [...this.devices.values()]` there), so its size is that number.
         *
         * ESLint's `no-undef` found this, which is the rule the project's own lint audit credits as
         * "what caught the one real defect" of that round. This is the same class of defect one
         * release later, and the audit's note about it is worth repeating: an unbound identifier in
         * an ESM module is a `ReferenceError` at evaluation time, not an `undefined` that quietly
         * takes a branch.
         */
        known_devices: this.devices.size,
      });
    }

    const dedupeKeyBase = computeDedupeKey(taskId, 0, commandHash, baseTree);
    if (typeof dedupeKeyBase !== 'string' || dedupeKeyBase.length !== 64) {
      throw new ProtocolError('INTERNAL', 'failed to compute dedupe_key');
    }
    /**
     * v1.2.7: a dependency that is not settled means this task is NOT dispatched yet. Its leases are recorded as `waiting`,
     * which the sweeper ignores and redelivery skips, and `_releaseDependents` moves them to offers when the graph allows it.
     */
    const dependencyStates = (task.depends_on ?? []).map((depId) => {
      const dep = this.tasks.get(depId);
      if (dep === undefined) return 'unknown';
      if (dep.cancelled === true) return 'cancelled';
      return this._taskSettled(dep) === true ? 'completed' : 'waiting';
    });
    const graphBlocked = dependencyStates.some((state) => state === 'cancelled' || state === 'unknown');
    const graphReady = graphBlocked !== true && dependencyStates.every((state) => state === 'completed');
    const waitingOn = graphReady === true ? [] : (task.depends_on ?? []);
    /**
     * v1.2.7: an assignee is a restriction, not a label. Only that machine gets a lease; another machine cannot accidentally
     * take work that was meant for one host. An unknown assignee is refused by name rather than producing a task nobody holds.
     */
    if (task.assignee !== null && !this.devices.has(task.assignee)) {
      throw new ProtocolError('BAD_REQUEST', 'assignee is not a known device on this relay', { assignee: task.assignee });
    }
    if (task.assignee !== null) {
      const narrowed = targets.filter((device) => device.machine_id === task.assignee);
      targets.length = 0;
      targets.push(...narrowed);
    }
    let lastSeq = this.seq;
    targets.forEach((device, i) => {
      const index = mode === 'replicate' ? 0 : i % indexTotal;
      const observing = mode === 'broadcast' && device.machine_id !== executorMachineId;
      const lease = {
        machine_id: device.machine_id,
        machine_name: device.machine_name,
        index,
        attempt: 1,
        // `observing` is a lease state, not an outcome: the machine holds a place in this task and
        // will be told what happened, but it was never handed the command. `gateMachine` below is
        // skipped for it because refusing to do work you were never asked to do is not a refusal.
        state: observing ? 'observing' : 'queued',
        refusal_reason: null,
        refusal_detail: null,
        dedupe_key: computeDedupeKey(taskId, index, commandHash, baseTree),
        last_heartbeat_ms: now,
        claimed_at_ms: now,
        lease_until_ms: now + this.leaseWindowMs(),
        phase: null,
        progress: null,
        offered_seq: null,
        expired_at_ms: null,
        finished_at_ms: null,
        heartbeat_count: 0,
      };
      if (observing) {
        // No capability gate and no offer: the machine is not being asked to run anything, so there
        // is nothing to refuse and nothing to hand out. It is recorded so the task can tell it the
        // outcome afterwards.
        task.leases.set(device.machine_id, lease);
        return;
      }
      if (graphReady !== true) {
        lease.state = 'waiting';
        lease.waiting_on = waitingOn;
        task.leases.set(device.machine_id, lease);
        return;
      }
      const gate = gateMachine(task, device);
      if (gate) {
        lease.state = 'refused';
        lease.refusal_reason = gate.refusal_reason;
        lease.refusal_detail = gate.detail;
        task.leases.set(device.machine_id, lease);
        this.emit('notice', {
          level: 'warn',
          code: 'CAPABILITY_REFUSED',
          message: `${device.machine_id} refused: ${gate.refusal_reason}`,
          task_id: taskId,
        });
        return;
      }
      task.leases.set(device.machine_id, lease);
      const grace = this._p2pOfferGraceMs(task);
      if (grace > 0) {
        // v0.4.0: the dispatcher is pushing this offer over the direct path right now. Hold the
        // relay's copy for `grace` ms so the direct one can win; see `p2pOfferGraceMs`.
        this._scheduleOffer(task, lease, grace);
      } else {
        const event = this.emitOffer(task, lease);
        lastSeq = event.seq;
      }
    });

    this.tasks.set(taskId, task);

    this._ledger({
      type: 'task.created',
      task: {
        task_id: task.task_id,
        workspace: task.workspace ?? null,
        project_id: task.project_id,
        mode: task.mode,
        command_argv: task.command_argv,
        cwd_rel: task.cwd_rel,
        cwd_outside_project: task.cwd_outside_project === true,
        index_total: task.index_total,
        timeout_ms: task.timeout_ms,
        write: task.write,
        write_scope: task.write_scope,
        require_exclusive_write: task.require_exclusive_write,
        base_commit: task.base_commit,
        base_tree: task.base_tree,
        requirements: task.requirements,
        compare_policy: task.compare_policy,
        halt: task.halt,
        created_by: task.created_by,
        created_at_ms: task.created_at_ms,
        command_hash: task.command_hash,
        attempt: task.attempt,
        deadline_ms: task.deadline_ms,
        // v0.4.0: routing metadata, so a restarted relay re-offers with the same facts.
            // v1.2.7: the dependency graph and assignment belong to the task record, not to a reader's memory of it.
            depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
            assignee: task.assignee ?? null,
            reduce_of: task.reduce_of ?? null,
            maintenance_summary: task.maintenance_summary ?? null,
            grant_summary: task.grant_summary ?? null,
            operator_key: task.operator_key ?? null,
            reduce_inputs: Array.isArray(task.reduce_inputs) ? task.reduce_inputs : [],
        origin_machine_id: task.origin_machine_id ?? null,
        p2p: task.p2p ?? null,
      },
      leases: [...task.leases.values()].map((l) => ({ ...l })),
    });

    // v1.3.10-beta.13: a task belongs to a project, and the project room records the link as an event both clients see.
    try {
      this.projects.appendEvent({ projectId: task.project_id, type: 'task.linked', actor: { kind: 'operator', id: 'relay' }, payload: { task_id: taskId, mode: task.mode } });
    } catch { /* the ledger already carries the task; the room event is additive */ }

    const refusedOnly = [...task.leases.values()].every((l) => l.state === 'refused');
    if (refusedOnly) {
      // §6.3 Step 0 territory: a task nobody may execute is still a valid, reportable task.
      this.emit('notice', {
        level: 'warn',
        code: 'NO_ONLINE_DEVICE',
        message: 'every candidate machine refused the capability gate',
        task_id: taskId,
      });
    }

    return {
      task_id: taskId,
      leases: [...task.leases.values()].map((l) => ({
        machine_id: l.machine_id,
        index: l.index,
        state: l.state,
        // v0.4.0: the dispatcher pushes an offer over the direct path, and the executor dedupes it
        // against the relay's copy by (task_id, attempt, dedupe_key). Without this field the
        // dispatcher has to reproduce the §4.4 formula locally, which works for a single-command
        // task and cannot work for a pipeline one -- the key covers the relay's normalised stage
        // list. Publishing it makes the pushed copy recognisably the same work item, which is what
        // keeps the direct path from turning exactly-once into at-least-twice.
        dedupe_key: l.dedupe_key ?? null,
        attempt: l.attempt,
        ...(l.refusal_reason ? { refusal_reason: l.refusal_reason } : {}),
      })),
      seq: lastSeq,
    };
  }

  /**
   * v0.4.0: should the relay hold its offer back for this task?
   *
   * Only when the dispatcher said two things: that it is a machine (`origin_machine_id`), and that
   * the direct path is in play (`p2p.mode` of `auto` or `direct`). A `relay` mode or a v0.3.9
   * dispatcher gets the old behaviour exactly, which is why this predicate is the only gate on the
   * change and every pre-existing test still sees an immediate offer.
   *
   * @param {object} task
   * @returns {number} milliseconds to hold, or 0 for "offer now"
   */
  _p2pOfferGraceMs(task) {
    if (this.p2pOfferGraceMs <= 0) return 0;
    const origin = task?.origin_machine_id;
    if (typeof origin !== 'string' || origin === '') return 0;
    const mode = task?.p2p?.mode;
    if (mode !== 'auto' && mode !== 'direct') return 0;
    return this.p2pOfferGraceMs;
  }

  /**
   * v0.4.0: emit `lease`'s offer after `delayMs`, unless the direct path got there first.
   *
   * "Got there first" is one fact and it is already tracked: the executor renews the lease
   * (`POST /v1/heartbeat`) as its first act on any offer it accepts, and a renewal moves the lease
   * out of `queued`. So the check is the lease's own state — no new message, no new endpoint, and
   * nothing the executor has to know about.
   *
   * The timer is `unref()`ed: a relay with nothing else to do must still be able to exit, and a
   * pending offer is not a reason to keep a process alive.
   */
  _scheduleOffer(task, lease, delayMs) {
    const key = `${task.task_id}:${lease.machine_id}`;
    const timer = setTimeout(() => {
      this._pendingOffers.delete(key);
      // A lease that was re-created (takeover) or swept is not this one any more.
      if (task.leases.get(lease.machine_id) !== lease) return;
      if (lease.state !== 'queued') return; // the direct copy won; nothing to fall back to
      if (this.isLeaseExpired(lease, this.nowMs())) return; // the sweep owns it now
      this.emitOffer(task, lease);
    }, delayMs);
    timer.unref?.();
    this._pendingOffers.set(key, timer);
  }

  /** Drop every deferred offer. Called by the relay's own teardown path. */
  clearPendingOffers() {
    for (const timer of this._pendingOffers.values()) clearTimeout(timer);
    this._pendingOffers.clear();
  }

  emitOffer(task, lease) {
    const event = this.emit('task.offer', {
      task_id: task.task_id,
      attempt: lease.attempt,
      mode: task.mode,
      index: lease.index,
      index_total: task.index_total,
      command_argv: task.command_argv,
      // v0.3.3: present only for `pipeline`, and only then does the machine run a chain. Omitted
      // entirely otherwise, so an offer for a single-command task is byte-identical to before --
      // which is what keeps a v0.2.3 agent working against this relay.
      ...(task.stages ? { stages: task.stages } : {}),
      /**
       * v0.4.0: always present, `null` when the caller supplied nothing.
       *
       * Deliberately NOT conditional (unlike `stages` above, which is omitted so a single-command
       * offer stays byte-identical for an old agent): the contract fixes the shape of these two as
       * `string|null` and `{mode}|null`, and `null` is the honest value for "the dispatcher did not
       * say" — which is exactly the v0.3.9 case. They are additive keys in an event whose consumers
       * already ignore unknown fields.
       */
      origin_machine_id: task.origin_machine_id ?? null,
      p2p: task.p2p ?? null,
      // v1.2.10: present only on a reduce task, so a normal offer stays byte-identical.
      ...(task.reduce_of !== null ? { reduce_of: task.reduce_of, reduce_inputs: task.reduce_inputs } : {}),
      // v1.3.10-beta.2: the signed request and its operator key travel together; the agent pins the key on first sight.
      ...(task.maintenance !== null && task.maintenance !== undefined ? { maintenance: task.maintenance } : {}),
      // v1.4.1: a grant on a machine that has never pinned the operator key is useless unless the offer carries the key it should
      // trust. Maintenance requests always shipped it; grants must too, or the TOFU pin path is unreachable.
      ...(task.operator_key !== null && task.operator_key !== undefined ? { operator_key: task.operator_key } : {}),
      ...(task.workspace !== null && task.workspace !== undefined ? { workspace: task.workspace } : {}),
      ...(task.grant !== null && task.grant !== undefined ? { grant: task.grant } : {}),
      cwd_rel: task.cwd_rel,
      // Omitted when false, so a single-command offer for every existing caller stays byte-identical -- the
      // same reason `stages` above is conditional.
      ...(task.cwd_outside_project === true ? { cwd_outside_project: true } : {}),
      write: task.write,
      timeout_ms: task.timeout_ms,
      base_commit: task.base_commit,
      base_tree: task.base_tree,
      requirements: task.requirements,
      compare_policy: task.compare_policy,
      dedupe_key: lease.dedupe_key,
      deadline: rfc3339(task.deadline_ms),
    }, { target: lease.machine_id });
    lease.state = 'offered';
    lease.offered_seq = event.seq;
    lease.last_heartbeat_ms = this.nowMs();
    lease.lease_until_ms = lease.last_heartbeat_ms + this.leaseWindowMs();
    return event;
  }

  /**
   * Resolve the project a task belongs to. The implicit default project is created lazily, so existing callers keep working
   * without naming one; an explicit unknown project is a refusal, not a new project.
   */
  ensureProject(projectId) {
    const wanted = typeof projectId === 'string' && projectId !== '' ? projectId : this.defaultProjectId;
    try {
      this.projects.snapshot({ projectId: wanted });
      return wanted;
    } catch (error) {
      if (error?.code !== 'PROJECT_NOT_FOUND') throw error;
      if (wanted !== this.defaultProjectId) throw new ProtocolError('BAD_REQUEST', 'unknown project_id', { project_id: wanted });
      this.projects.createProject({ projectId: this.defaultProjectId, name: 'default', createdBy: { kind: 'operator', id: 'relay', name: 'relay' } });
      return wanted;
    }
  }

  /** Snapshot helpers the project routes use; kept on state so the relay has one owner of the room. */
  projectSnapshot(projectId) { return this.projects.snapshot({ projectId: this.ensureProject(projectId) }); }
  projectEvents(projectId, options = {}) { return this.projects.events({ projectId: this.ensureProject(projectId), ...options }); }

  getTask(taskId) { return this.tasks.get(taskId) ?? null; }

  requireTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new ProtocolError('NOT_FOUND', 'unknown task_id', { task_id: taskId });
    return task;
  }

  /**
   * Re-offer the work a machine was handed but has not yet started (v0.1.2 §8.6).
   *
   * WHY THIS EXISTS
   *
   * An offer is a point-in-time event on a stream. `createTask` publishes
   * `task.offer` once, and if the target machine's stream happens to be down at
   * that instant -- the ordinary situation after a relay restart, a tunnel drop,
   * or any cross-network interruption -- the event is simply gone. The lease sits
   * in `offered` until the sweep expires it, the task never runs, and the
   * operator sees a timeout with no explanation. Measured: the machine is back
   * online with a live stream within milliseconds, and still receives nothing.
   *
   * So the relay re-states unclaimed work when a machine connects. This is safe
   * because the state it acts on is durable: the lease the offer refers to is
   * still in the ledger.
   *
   * WHY ONLY `offered` AND `queued`
   *
   * `running` is deliberately excluded, and that exclusion is the whole safety
   * argument. A running lease means a machine has already STARTED the command --
   * it acknowledged the offer and is heartbeating. Re-offering it would make that
   * machine execute the work a second time, so the fix for a lost offer would
   * introduce the one failure this project is built to avoid: two machines, or
   * one machine twice, running the same side-effecting command.
   *
   * A machine that dies mid-run therefore does not get its work back here; that
   * path stays with the sweep, which expires the lease and hands the index to
   * another machine with `attempt + 1`.
   *
   * Re-emitted offers are new events and are replayed like any other, so a client
   * that reconnects repeatedly can see the same offer more than once. That is
   * intentional: the agent already de-duplicates by `task_id` (it ignores an
   * offer whose task is queued or running), and an at-least-once offer with a
   * client-side dedupe is strictly better than an at-most-once offer that is
   * silently dropped.
   *
   * @param {string} machineId
   * @returns {{count: number, task_ids: string[]}}
   */
  redeliverPendingOffers(machineId) {
    const taskIds = [];
    const now = this.nowMs();

    for (const task of this.tasks.values()) {
      if (task.cancelled === true) continue;
      const lease = task.leases.get(machineId);
      if (!lease) continue;
      // Only work the machine has not begun. See the note above: `running` is
      // excluded on purpose, not by omission.
      if (lease.state !== 'offered' && lease.state !== 'queued') continue;
      // Do not resurrect a lease the sweep has already written off; the takeover
      // path owns that decision.
      if (this.isLeaseExpired(lease, now)) continue;

      this.emitOffer(task, lease);
      taskIds.push(task.task_id);
    }

    return { count: taskIds.length, task_ids: taskIds };
  }

  listTasks({ limit = 50, fleetId = null } = {}) {
    const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
    return [...this.tasks.values()]
      // v1.5.5: a fleet-bound caller lists only its own fleet's tasks; null fleet keeps the old view.
      .filter((task) => fleetId === null || task.fleet_id === fleetId)
      .sort((a, b) => b.created_at_ms - a.created_at_ms)
      .slice(0, n)
      .map((t) => this.taskSummary(t));
  }

  /** v1.2.7: a task is settled when no lease can still produce a result. Dependencies wait for that, not for a wording. */
  _taskSettled(task) {
    for (const lease of task.leases.values()) if (ACTIVE_LEASE_STATES.includes(lease.state)) return false;
    return true;
  }

  /**
   * v1.2.7: release tasks whose prerequisites are all settled.
   *
   * Called after a result is stored: a dependency that finished must actually move its dependents from `waiting` to an offer.
   * Without this the graph would be validated, stored, and then never scheduled -- the exact "validated but not enforced" gap.
   */
  _releaseDependents(completedTaskId = null) {
    const released = [];
    for (const candidate of this.tasks.values()) {
      if (!Array.isArray(candidate.depends_on) || candidate.depends_on.length === 0) continue;
      if (completedTaskId !== null && !candidate.depends_on.includes(completedTaskId)) continue;
      const waiting = [...candidate.leases.values()].filter((lease) => lease.state === 'waiting');
      if (waiting.length === 0) continue;
      let ready = true;
      for (const depId of candidate.depends_on) {
        const dep = this.tasks.get(depId);
        if (dep === undefined) { ready = false; break; }
        if (dep.cancelled === true) { ready = false; break; }
        if (this._taskSettled(dep) !== true) { ready = false; break; }
      }
      if (ready !== true) continue;
      for (const lease of waiting) {
        lease.state = 'queued';
        lease.claimed_at_ms = this.nowMs();
        lease.lease_until_ms = this.nowMs() + this.leaseWindowMs();
        const device = this.devices.get(lease.machine_id);
        if (device === undefined) continue;
        this.emitOffer(candidate, lease);
      }
      this.emit('notice', { level: 'info', code: 'TASK_READY', message: candidate.task_id + ' is ready: dependencies settled', task_id: candidate.task_id });
      released.push(candidate.task_id);
    }
    return released;
  }

  /** Stop one issued grant from being used. Idempotent: revoking twice is the same authorisation state. */
  revokeGrant({ grantId, reason = null, actor = { kind: "operator", id: "operator" } }) {
    if (typeof grantId !== "string" || grantId === "") throw new ProtocolError("BAD_REQUEST", "grant_id is required");
    const existing = this.revokedGrants.get(grantId);
    if (existing !== undefined) return { ok: true, already_revoked: true, revocation: { ...existing } };
    const revocation = { grant_id: grantId, reason: typeof reason === "string" && reason !== "" ? reason : null, revoked_at: this.nowIso(), revoked_by: actor };
    this.revokedGrants.set(grantId, revocation);
    this._ledger({ type: "grant.revoked", grant_id: grantId, reason: revocation.reason, revoked_by: actor });
    return { ok: true, already_revoked: false, revocation: { ...revocation } };
  }

  /** Audit view: every task that carried a grant, plus every revocation. Operator credential only. */
  grantedTasks() {
    const tasks = [];
    for (const task of this.tasks.values()) {
      if (task.grant_summary === null || task.grant_summary === undefined) continue;
      tasks.push({ task_id: task.task_id, grant_id: task.grant_summary.grant_id, argv_hash: task.grant_summary.argv_hash, key_id: task.grant_summary.key_id, mode: task.mode, created_at: rfc3339(task.created_at_ms) });
    }
    return { tasks, revoked: [...this.revokedGrants.values()].map((entry) => ({ ...entry })) };
  }

  /** Register a content-addressed artifact against a project (idempotent by sha256). */
  registerArtifact({ projectId, sha256, bytes, kind = "artifact", sourceTaskId = null, actor = null }) {
    if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new ProtocolError("BAD_REQUEST", "artifact sha256 must be 64 hex", {});
    const wanted = this.ensureProject(projectId);
    const existing = this.artifacts.get(sha256);
    if (existing !== undefined && existing.project_id === wanted) return { ok: true, artifact: { ...existing }, already: true };
    const artifact = { project_id: wanted, sha256: String(sha256), bytes: Number.isInteger(bytes) && bytes >= 0 ? bytes : null, kind: String(kind), source_task_id: sourceTaskId, created_at: this.nowIso(), actor };
    this.artifacts.set(sha256, artifact);
    try { this.projects.appendEvent({ projectId: wanted, type: "artifact.registered", actor: actor ?? { kind: "operator", id: "relay" }, payload: { sha256: artifact.sha256, bytes: artifact.bytes, kind: artifact.kind, source_task_id: sourceTaskId } }); } catch { /* history */ }
    return { ok: true, artifact: { ...artifact }, already: false };
  }

  listArtifacts({ projectId }) {
    const wanted = this.ensureProject(projectId);
    return [...this.artifacts.values()].filter((artifact) => artifact.project_id === wanted).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((artifact) => ({ ...artifact }));
  }

  /** The project board: every task attributed to this project, with the scheduler's own status. */
  projectBoard({ projectId }) {
    const wanted = this.ensureProject(projectId);
    const tasks = [...this.tasks.values()].filter((task) => task.project_id === wanted).map((task) => {
      const summary = this.taskSummary(task);
      return { task_id: summary.task_id, status: summary.status, mode: summary.mode, created_at: summary.created_at, leases: summary.leases, lease_states: summary.lease_states, result_count: [...this.results.values()].filter((record) => record?.envelope?.task_id === task.task_id).length };
    });
    const counts = {};
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    return { project_id: wanted, tasks, counts, generated_at: this.nowIso() };
  }

  /** Append a decision to a project. Decisions are records; there is no edit or delete. */
  addDecision({ projectId, title, text = null, actor = null, refs = {}, kind = "decision" }) {
    const wanted = this.ensureProject(projectId);
    if (typeof title !== "string" || title.trim() === "") throw new ProtocolError("BAD_REQUEST", "decision title is required", {});
    const list = this.decisions.get(wanted) ?? [];
    const index = list.length + 1;
    const decision = {
      decision_id: wanted + "-d" + String(index).padStart(4, "0"),
      project_id: wanted, title: title.trim().slice(0, 200), text: typeof text === "string" ? text.slice(0, 4000) : null,
      kind: String(kind), refs: refs !== null && typeof refs === "object" ? { ...refs } : {},
      actor, created_at: this.nowIso(),
    };
    list.push(decision);
    this.decisions.set(wanted, list);
    try { this.projects.appendEvent({ projectId: wanted, type: "decision.recorded", actor: actor ?? { kind: "operator", id: "relay" }, payload: { decision_id: decision.decision_id, title: decision.title, kind: decision.kind } }); } catch { /* history */ }
    return { ok: true, decision: { ...decision } };
  }

  listDecisions({ projectId }) {
    const wanted = this.ensureProject(projectId);
    return (this.decisions.get(wanted) ?? []).map((decision) => ({ ...decision, refs: { ...decision.refs } }));
  }

  /** A small versioned document per project (64 KiB cap): shared context that is not a log. */
  setProjectMemory({ projectId, text, actor = null }) {
    const wanted = this.ensureProject(projectId);
    if (typeof text !== "string") throw new ProtocolError("BAD_REQUEST", "memory text must be a string", {});
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new ProtocolError("PROJECT_MEMORY_TOO_LARGE", "project memory is limited to 64 KiB", { bytes: Buffer.byteLength(text, "utf8") });
    const previous = this.projectMemory.get(wanted);
    const doc = { project_id: wanted, text, version: (previous?.version ?? 0) + 1, updated_at: this.nowIso(), actor };
    this.projectMemory.set(wanted, doc);
    try { this.projects.appendEvent({ projectId: wanted, type: "memory.updated", actor: actor ?? { kind: "operator", id: "relay" }, payload: { version: doc.version, bytes: Buffer.byteLength(text, "utf8") } }); } catch { /* history */ }
    return { ok: true, document: { ...doc } };
  }

  getProjectMemory({ projectId }) {
    const wanted = this.ensureProject(projectId);
    const doc = this.projectMemory.get(wanted);
    return doc === undefined ? { project_id: wanted, text: "", version: 0, updated_at: null, actor: null } : { ...doc };
  }

  /** Subscribe to every project event. Returns an unsubscribe function. */
  onProjectEvent(listener) {
    this.projectSubscribers.add(listener);
    return () => { this.projectSubscribers.delete(listener); };
  }

  taskSummary(task) {
    return {
      task_id: task.task_id,
      mode: task.mode,
      created_at: rfc3339(task.created_at_ms),
      created_by: task.created_by,
      index_total: task.index_total,
      cancelled: task.cancelled,
      degraded: task.degraded,
      leases: [...task.leases.values()].map((l) => l.machine_id),
      lease_states: Object.fromEntries([...task.leases.values()].map((l) => [l.machine_id, l.state])),
      /**
       * v1.2.7: the state the scheduler is actually in, derived here rather than by each reader.
       *
       * Before this, GET /v1/tasks carried no status at all, so a board classified a waiting task as "ready" (its dependencies
       * map empty) and a released task as "waiting" forever. The board must read the scheduler's own words or it is decoration.
       */
      project_id: task.project_id ?? null,
      reduce_of: task.reduce_of ?? null,
      reduce_inputs: Array.isArray(task.reduce_inputs) ? task.reduce_inputs : [],
      maintenance_request_id: task.maintenance_summary?.request_id ?? null,
      workspace: task.workspace === null || task.workspace === undefined ? null : { ...task.workspace },
    grant_id: task.grant_summary?.grant_id ?? null,
    argv_hash: task.grant_summary?.argv_hash ?? null,
    grant_key_id: task.grant_summary?.key_id ?? null,
      status: (() => {
        if (task.cancelled === true) return 'cancelled';
        const leases = [...task.leases.values()];
        if (leases.some((lease) => lease.state === 'waiting')) return 'waiting';
        if (leases.some((lease) => ACTIVE_LEASE_STATES.includes(lease.state))) return 'active';
        const results = [...this.results.values()].filter((record) => record?.envelope?.task_id === task.task_id);
        if (results.length > 0 && results.every((record) => ['failed', 'crashed', 'refused', 'timeout'].includes(record?.envelope?.status))) return 'failed';
        return this._taskSettled(task) === true ? 'done' : 'unknown';
      })(),
      depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
      assignee: task.assignee ?? null,
      waiting_on: [...task.leases.values()].some((l) => l.state === 'waiting') ? (Array.isArray(task.depends_on) ? task.depends_on : []) : [],
    };
  }

  /** v1.2.6: the role this machine holds, for the permission matrix. Unknown means worker, never owner. */
  roleOf(machineId) {
    return typeof machineId === 'string' ? (this.roles.get(machineId) ?? null) : null;
  }

  /** v1.2.5: the fleet's members, with the role each holds and when it joined. */
  listMembers() {
    return buildMembers({ devices: this.devices, roles: this.roles });
  }

  /** v1.2.5: an operator decision about one machine. Refused by name, never silently ignored. */
  setMemberRole(machineId, role) {
    const result = applyMemberRole({ machineId, role, devices: this.devices, roles: this.roles });
    if (result.ok === true) {
      this.emit('notice', { level: 'info', code: 'MEMBER_ROLE_SET', message: `${machineId} is now ${role}`, machine_id: machineId });
      this._ledger({ type: 'member.role', machine_id: machineId, role });
    }
    return result;
  }

  /**
   * v1.2.5: record that a machine has read a session up to a marker.
   *
   * Only forward: a stale marker arriving after a newer one must not move the watermark backwards, or the unread count would
   * grow for messages the machine has already seen.
   */
  markRead(sessionId, machineId, marker = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'BAD_SESSION' };
    if (typeof machineId !== 'string' || machineId === '') return { ok: false, code: 'BAD_MACHINE' };
    const atMs = Number.isFinite(marker.at_ms) ? Math.floor(marker.at_ms) : this.nowMs();
    const messageId = typeof marker.message_id === 'string' && marker.message_id !== '' ? marker.message_id : null;
    if (!this.readMarks.has(sessionId)) this.readMarks.set(sessionId, new Map());
    const perSession = this.readMarks.get(sessionId);
    const previous = perSession.get(machineId) ?? null;
    if (previous !== null && previous.at_ms > atMs) return { ok: true, mark: { ...previous }, advanced: false };
    const mark = { at_ms: atMs, message_id: messageId };
    perSession.set(machineId, mark);
    return { ok: true, mark: { ...mark }, advanced: true };
  }

  /** v1.2.5: this machine's watermark for one session (null when it never read it). */
  readMark(sessionId, machineId) {
    const perSession = this.readMarks.get(sessionId) ?? null;
    if (perSession === null) return null;
    const mark = perSession.get(machineId) ?? null;
    return mark === null ? null : { ...mark };
  }

  cancelTask(taskId, reason = 'cancelled_by_operator') {
    const task = this.requireTask(taskId);
    if (task.cancelled) return task;
    task.cancelled = true;
    task.cancel_reason = reason;
    for (const lease of task.leases.values()) {
      if (ACTIVE_LEASE_STATES.includes(lease.state)) lease.state = 'cancelled';
    }
    this.emit('task.cancel', { task_id: taskId, reason });
    this._ledger({ type: 'task.cancelled', task_id: taskId, reason });
    return task;
  }

  /* ---------------- leases / heartbeat (§4.3) ---------------- */

  /** Shared `phase`/`progress` validation for both heartbeat modes. */
  _validatePhaseProgress(input) {
    if (input.phase !== undefined && input.phase !== null && !LEASE_PHASES.includes(input.phase)) {
      throw new ProtocolError('BAD_REQUEST', 'phase must be preparing|running|finalizing', { phase: input.phase });
    }
    if (input.progress !== undefined && input.progress !== null
      && (typeof input.progress !== 'number' || input.progress < 0 || input.progress > 1)) {
      throw new ProtocolError('BAD_REQUEST', 'progress must be a number in [0,1]', { progress: input.progress });
    }
  }

  /**
   * v0.3.0 IDLE (diagnostic) heartbeat — an agent with no lease keeps its latency
   * and liveness visible to other machines.
   *
   * This path deliberately NEVER looks at `this.tasks`. That is the whole safety
   * argument, and it is structural rather than a matter of remembering a rule: an
   * idle heartbeat cannot renew, resurrect or otherwise touch a lease because it
   * never obtains one. Without that, an idle ping from a machine whose lease had
   * expired would flip `expired` back to `running` and manufacture a live task out
   * of nothing -- a fake "the work is still being done" signal, which is the most
   * dangerous lie this relay can tell.
   */
  diagnosticHeartbeat(input = {}) {
    const machineId = typeof input.machine_id === 'string' && input.machine_id !== ''
      ? input.machine_id : null;
    if (machineId === null) {
      throw new ProtocolError('BAD_REQUEST', 'machine_id is required', {});
    }
    if (!this.devices.has(machineId)) {
      throw new ProtocolError('NOT_FOUND', 'unknown machine_id', { machine_id: machineId });
    }
    this._validatePhaseProgress(input);

    const device = this.touchDevice(machineId);
    this.recordHeartbeatMetrics(machineId, input);
    return {
      // No lease is involved, and the response says so instead of inventing one.
      lease_until: null,
      cancel: false,
      diagnostic: true,
      machine_id: machineId,
      rtt_ms: device?.rtt_ms ?? null,
    };
  }

  /**
   * §4.3 POST /v1/heartbeat — renews the lease using SERVER time only.
   *
   * Two modes since v0.3.0:
   *   - `task_id` present            -> LEASE heartbeat (unchanged §4.3 behaviour)
   *   - `diagnostic: true`, no task  -> IDLE heartbeat (diagnostics only, no lease)
   *   - neither                      -> 400. A heartbeat that silently renewed
   *     nothing would let an agent whose `task_id` went missing stop renewing while
   *     believing it was fine, ending in a falsely `expired` task. §0 forbids
   *     silent degradation, so this is loud.
   *
   * @returns {{lease_until:string|null, cancel:boolean, phase?:string, progress?:number, diagnostic?:boolean}}
   */
  heartbeat(input = {}) {
    const hasTask = typeof input.task_id === 'string' && input.task_id !== '';
    if (!hasTask) {
      if (input.diagnostic !== true) {
        throw new ProtocolError('BAD_REQUEST',
          'a heartbeat must carry task_id (lease renewal) or diagnostic:true (idle diagnostics); '
          + 'refusing to treat a missing task_id as a no-op renewal', {
            received_keys: Object.keys(input).sort(),
          });
      }
      return this.diagnosticHeartbeat(input);
    }
    if (input.diagnostic === true) {
      // task_id wins: a heartbeat that names a task IS a lease heartbeat.
      // (documented; the flag is simply redundant here)
    }
    return this.leaseHeartbeat(input);
  }

  leaseHeartbeat(input = {}) {
    const task = this.requireTask(input.task_id);
    const lease = task.leases.get(input.machine_id);
    if (!lease) {
      throw new ProtocolError('NOT_FOUND', 'no lease for this machine on this task', {
        task_id: input.task_id, machine_id: input.machine_id,
      });
    }
    this._validatePhaseProgress(input);

    const now = this.nowMs();
    this.touchDevice(input.machine_id);
    this.recordHeartbeatMetrics(input.machine_id, input, now);

    if (task.cancelled) {
      return { lease_until: rfc3339(lease.lease_until_ms), cancel: true, reason: task.cancel_reason };
    }

    // §4.3: once halt=now has handed this index to another attempt, the old owner
    // must stop — a late heartbeat from the expired machine is not a valid re-claim.
    if (lease.state === 'expired' && task.attempt > lease.attempt) {
      return { lease_until: rfc3339(lease.lease_until_ms), cancel: true, reason: 'LEASE_EXPIRED_TAKEN_OVER' };
    }

    const stateBefore = lease.state;
    lease.last_heartbeat_ms = now;
    lease.lease_until_ms = now + this.leaseWindowMs();
    lease.heartbeat_count += 1;
    if (input.phase !== undefined && input.phase !== null) lease.phase = input.phase;
    if (input.progress !== undefined && input.progress !== null) lease.progress = input.progress;
    if (Number.isInteger(input.attempt) && input.attempt >= 1) lease.attempt = input.attempt;
    if (lease.state === 'queued' || lease.state === 'offered') lease.state = 'running';
    // A live heartbeat is stronger evidence than a timer: with halt=never nobody took
    // the work away, so the late-but-alive agent re-claims its own lease.
    if (lease.state === 'expired') { lease.state = 'running'; lease.expired_at_ms = null; }

    // §7 ledger records lease STATE changes, not every 10s heartbeat.
    if (lease.state !== stateBefore) this._ledgerLease(task, lease);

    return { lease_until: rfc3339(lease.lease_until_ms), cancel: false, phase: lease.phase, progress: lease.progress };
  }

  /** §4.3: expiry is decided by Rabbit's clock only. */
  isLeaseExpired(lease, nowMs = this.nowMs()) {
    if (!ACTIVE_LEASE_STATES.includes(lease.state)) return false;
    return nowMs >= lease.lease_until_ms;
  }

  /**
   * §4.3 expiry sweep.
   *  - halt=never → book-keeping only, task is marked `partial`
   *  - halt=now   → notify remaining machines immediately that they may take over
   */
  sweepExpired(nowMs = this.nowMs()) {
    const expired = [];
    for (const task of this.tasks.values()) {
      if (task.cancelled) continue;
      let changed = false;
      for (const lease of task.leases.values()) {
        if (!this.isLeaseExpired(lease, nowMs)) continue;
        lease.state = 'expired';
        lease.expired_at_ms = nowMs;
        changed = true;
        expired.push({ task, lease });
        this._ledgerLease(task, lease);
        this.emit('notice', {
          level: 'warn',
          code: 'LEASE_EXPIRED',
          message: `lease expired: machine=${lease.machine_id} task=${task.task_id} attempt=${lease.attempt}`,
          task_id: task.task_id,
          machine_id: lease.machine_id,
        });
        // v1.2.4: a caller that named "expired" in retry_on gets the hand-off halt=now always had, as long as it
        // has attempts left. Without the policy this stays book-keeping only -- the pre-1.2.4 behaviour.
        const retryExpired = task.halt === 'now'
          || (Number.isInteger(task.max_attempts) && task.attempt < task.max_attempts
            && Array.isArray(task.retry_on) && task.retry_on.includes('expired'));
        if (retryExpired) {
          task.attempt += 1;
          this._takeover(task, lease, nowMs);
        }
      }
      if (changed) task.degraded = 'partial';
    }
    // v1.2.7: a lease that expires (or a machine that refuses) is a settlement too -- the dependent graph must move.
    this._releaseDependents();

    return expired;
  }

  /**
   * §4.3 `halt=now`: "立即通知其他机器可接管".
   *
   * v0.0.1's PROTOCOL defines no per-index lease reassignment, so takeover is
   * implemented as: re-offer the freed `index` (attempt+1) to every live machine
   * that is idle — no lease yet, or a lease still queued/offered — and broadcast a
   * notice. Machines already `running` are never re-offered, to avoid double
   * execution of the same index.
   */
  _takeover(task, expiredLease, nowMs = this.nowMs()) {
    /**
     * v0.7.8: the two safety guards this path was missing.
     *
     * `_takeover` already existed and is invoked on `halt=now`, so hand-off was not absent — but it
     * would re-offer a dead machine's index to **every idle device the relay holds**, with no fleet
     * filter and no consideration of whether the task writes. Both are reachable defects:
     *
     *   1. **A device in another account could be handed the work.** On a relay serving several
     *      fleets, `this.devices` includes all of them, so a takeover crossed accounts — which is
     *      the isolation this release series is about, broken in the one path that is easy to miss
     *      because it only runs when something has already gone wrong.
     *   2. **A writing task could be run a second time.** Hand-off makes execution at-least-once,
     *      which is harmless for `node --test` and is a duplicated write for anything else. The
     *      design forbids automatic hand-off for writing tasks until a fencing token exists.
     *
     * The re-offer shape itself is unchanged: PROTOCOL v0.0.1 defines no per-index lease
     * reassignment, so takeover is expressed as a re-offer to idle machines. Narrowing that to a
     * single successor is a protocol revision, not a wiring change, and is not made here.
     */
    if (task.write === true) {
      this.emit('notice', {
        level: 'warn',
        code: 'LEASE_TAKEOVER_REFUSED',
        message:
          `task ${task.task_id} index ${expiredLease.index} is a writing task, so no machine takes it over: `
          + 'a second run could apply the same change twice, and the caller cannot tell from the verdict',
        task_id: task.task_id,
        reason: 'write_not_idempotent',
      });
      return [];
    }

    const requesterFleet = this.fleetId ?? null;

    const candidates = [];
    for (const device of this.devices.values()) {
      if (device.machine_id === expiredLease.machine_id) continue;
      /**
       * Fleet membership, when the relay is scoped.
       *
       * A device with its own `fleet_id` must match. A device with none cannot take over on a
       * scoped relay, because there is no fleet to match it against — the same rule `targetsFor`
       * applies to dispatch, kept identical here so the two paths cannot disagree.
       */
      if (requesterFleet !== null) {
        const deviceFleet = typeof device.fleet_id === 'string' && device.fleet_id !== '' ? device.fleet_id : null;
        if (deviceFleet !== requesterFleet) {
          this.log?.('debug', 'takeover candidate skipped: not in this fleet', {
            task_id: task.task_id,
            machine_id: device.machine_id,
            device_fleet: deviceFleet,
            relay_fleet: requesterFleet,
          });
          continue;
        }
      }
      const lease = task.leases.get(device.machine_id);
      if (lease && !['queued', 'offered'].includes(lease.state)) continue;
      if (!lease && gateMachine(task, device)) continue;
      candidates.push({ device, lease: lease ?? null });
    }

    for (const { device, lease } of candidates) {
      const target = lease ?? {
        machine_id: device.machine_id,
        machine_name: device.machine_name,
        index: expiredLease.index,
        attempt: task.attempt,
        state: 'queued',
        refusal_reason: null,
        refusal_detail: null,
        dedupe_key: null,
        last_heartbeat_ms: nowMs,
        claimed_at_ms: nowMs,
        lease_until_ms: nowMs + this.leaseWindowMs(),
        phase: null,
        progress: null,
        offered_seq: null,
        expired_at_ms: null,
        finished_at_ms: null,
        heartbeat_count: 0,
      };
      target.index = expiredLease.index;
      target.attempt = task.attempt;
      target.dedupe_key = computeDedupeKey(task.task_id, target.index, task.command_hash, task.base_tree);
      task.leases.set(device.machine_id, target);
      this.emitOffer(task, target);
      this._ledgerLease(task, target);
    }

    this.emit('notice', {
      level: 'info',
      code: candidates.length > 0 ? 'LEASE_TAKEOVER' : 'LEASE_TAKEOVER_UNAVAILABLE',
      message: candidates.length > 0
        ? `task ${task.task_id} index ${expiredLease.index} re-offered at attempt ${task.attempt} to: `
          + candidates.map((c) => c.device.machine_id).join(',')
        : `task ${task.task_id} index ${expiredLease.index} has no idle machine to take over`,
      task_id: task.task_id,
    });
    return candidates.map((c) => c.device.machine_id);
  }

  /* ---------------- results (§5) ---------------- */

  static instanceKey(machineId, dedupeKey, attempt) {
    return `${machineId}${INSTANCE_SEP}${dedupeKey}${INSTANCE_SEP}${attempt}`;
  }

  /**
   * §5 result envelope validation.
   * Missing §5.1 required fields do NOT reject the frame — they make the result
   * `unverifiable` (§5.1 "缺一即 unverifiable").
   */
  static validateEnvelope(envelope) {
    const missing = [];
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return { missing: [...REQUIRED_ENVELOPE_FIELDS], malformed: true };
    }
    for (const field of REQUIRED_ENVELOPE_FIELDS) {
      if (!(field in envelope) || envelope[field] === undefined) missing.push(field);
    }
    const problems = [];
    if ('status' in envelope && !RESULT_STATUSES.includes(envelope.status)) {
      problems.push(`status must be one of ${RESULT_STATUSES.join('|')}`);
    }
    if (envelope.status === 'refused' && !envelope.refusal_reason) {
      problems.push('refusal_reason is required when status=refused');
    }
    if ('warnings' in envelope && !Array.isArray(envelope.warnings)) problems.push('warnings must be string[]');
    return { missing, problems };
  }

  /**
   * §1 idempotent POST /v1/result.
   *
   * NOTE (contract ambiguity, see report): §4.4 `dedupe_key` deliberately excludes
   * `machine_id`/`attempt`, but §6.3 aggregates results from *several* machines in
   * replicate mode — they all share one dedupe_key. Deduping purely on dedupe_key
   * would silently drop every machine's result but the first. We therefore key the
   * idempotency check on (machine_id, dedupe_key, attempt): an identical redelivery
   * is `deduped:true`, distinct machines/attempts are all recorded.
   */
  submitResult(envelope = {}) {
    const { missing, problems, malformed } = RabbitState.validateEnvelope(envelope);
    if (malformed) throw new ProtocolError('BAD_REQUEST', 'result must be a JSON object');

    /**
     * v0.4.0: `transport` / `p2p` are OPTIONAL envelope fields, and they are validated as values
     * rather than added to the §5.1 required set. A v0.3.9 agent sends neither and must keep
     * working unchanged; an agent that sends `transport: 'satellite'` is refused by name instead of
     * storing a value the report would then show as a path that does not exist.
     */
    RabbitState.validateTransportFields(envelope);

    const taskId = envelope.task_id;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new ProtocolError('BAD_REQUEST', 'task_id is required');
    }
    const task = this.tasks.get(taskId);
    if (!task) throw new ProtocolError('NOT_FOUND', 'unknown task_id', { task_id: taskId });

    const machineId = typeof envelope.machine_id === 'string' ? envelope.machine_id : null;
    const dedupeKey = typeof envelope.dedupe_key === 'string' && envelope.dedupe_key
      ? envelope.dedupe_key : null;
    const attempt = Number.isInteger(envelope.attempt) && envelope.attempt >= 1 ? envelope.attempt : 1;

    if (dedupeKey === null) {
      // Cannot dedupe without a key; still record it, as unverifiable.
      missing.push('dedupe_key');
    }
    const instanceKey = RabbitState.instanceKey(machineId ?? '<unknown>', dedupeKey ?? '<none>', attempt);

    // §4.4 sanity check against the lease this machine actually holds. Booked as a
    // problem instead of a hard rejection so a buggy client cannot lose its result.
    const leaseForMachine = machineId ? task.leases.get(machineId) : null;
    if (leaseForMachine?.dedupe_key && dedupeKey && leaseForMachine.dedupe_key !== dedupeKey) {
      problems.push('dedupe_key does not match the §4.4 formula for this lease');
    }

    if (this.results.has(instanceKey)) {
      const prior = this.results.get(instanceKey);
      return { deduped: true, task_id: taskId, dedupe_key: dedupeKey, seq: prior.seq };
    }

    /**
     * v1.2.6: verify the envelope signature against the key this machine registered WHEN IT PAIRED.
     *
     * This is the difference between "the result matches the key it carries" and "the key belongs to this machine". The relay is
     * the place that can answer the second question, because pairing is the moment the operator (or the account) let the machine
     * in, and that is the only moment its signing key has a reason to be believed. A signature whose key differs from the
     * registered one is bad_signature even when it verifies against itself.
     */
    let signatureStatus = 'unsigned';
    const signature = envelope.signature ?? null;
    if (signature !== null) {
      signatureStatus = 'bad_signature';
      if (signature.alg !== 'ed25519') {
        signatureStatus = 'unsupported_algorithm';
      } else {
        const registeredKey = machineId === null ? null : (typeof this.devices.get(machineId)?.public_key === 'string' ? this.devices.get(machineId).public_key : null);
        if (registeredKey === null) {
          signatureStatus = 'unbound';
        } else if (signature.public_key !== registeredKey) {
          signatureStatus = 'bad_signature';
        } else {
          const key = publicKeyFromBase64(registeredKey);
          const payload = canonicalSignedPayload({
            task_id: envelope.task_id,
            argv_hash: envelope.command_hash,
            machine_id: envelope.machine_id,
            ts: signature.ts,
          });
          try {
            signatureStatus = key !== null && verifyBytes(null, Buffer.from(payload, 'utf8'), key, Buffer.from(String(signature.value ?? ''), 'base64'))
              ? 'signed' : 'bad_signature';
          } catch { signatureStatus = 'bad_signature'; }
        }
      }
    }

    const now = this.nowMs();
    let envelopeShaOk = null;
    if (typeof envelope.envelope_sha256 === 'string') {
      const { envelope_sha256: _drop, ...rest } = envelope;
      envelopeShaOk = sha256Hex(jcs(rest)) === envelope.envelope_sha256;
    }

    const record = {
      envelope,
      machine_id: machineId,
      dedupe_key: dedupeKey,
      attempt,
      instance_key: instanceKey,
      received_at_ms: now,
      validation: {
        missing: [...new Set(missing)],
        problems,
        envelope_sha256_ok: envelopeShaOk,
        signature_status: signatureStatus,
      },
    };

    const effectiveStatus = record.validation.missing.length > 0 ? 'unverifiable' : envelope.status;

    const seq = this.nextSeq();
    record.seq = seq;
    record.effective_status = effectiveStatus;
    this.results.set(instanceKey, record);

    if (machineId) {
      const lease = task.leases.get(machineId);
      if (lease) {
        lease.state = effectiveStatus === 'refused' ? 'refused' : 'done';
        if (effectiveStatus === 'refused' && !lease.refusal_reason) {
          lease.refusal_reason = envelope.refusal_reason ?? 'REFUSED';
        }
        lease.finished_at_ms = now;
        lease.attempt = attempt;
      }
      this.touchDevice(machineId);
    }
    task.result_seqs.push(seq);

    this.emit('task.result', {
      task_id: taskId,
      dedupe_key: dedupeKey,
      attempt,
      index: envelope.index ?? null,
      status: effectiveStatus,
      machine_id: machineId,
      deduped: false,
      validation_errors: record.validation.missing,
    });

    // §7: results go into the ledger so the dedupe index survives a restart.
    // v1.2.7: a settled task may be the prerequisite that frees its dependents.
    this._releaseDependents(taskId);

    this._ledger({ type: 'result.stored', task_id: taskId, machine_id: machineId, result: record });
    if (machineId) {
      const changed = task.leases.get(machineId);
      if (changed) this._ledgerLease(task, changed);
    }

    return { deduped: false, task_id: taskId, dedupe_key: dedupeKey, seq, _instanceKey: instanceKey };
  }

  /** All recorded results for a task, keyed by machine_id (later attempts win). */
  taskResults(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return new Map();
    const out = new Map();
    for (const rec of this.results.values()) {
      if (rec.envelope.task_id !== taskId) continue;
      const prev = out.get(rec.machine_id);
      if (!prev || rec.received_at_ms >= prev.received_at_ms) out.set(rec.machine_id, rec);
    }
    return out;
  }

  /** Global dedupe book-keeping: dedupe_key -> instances seen. */
  dedupeReport() {
    const out = {};
    for (const rec of this.results.values()) {
      if (!rec.dedupe_key) continue;
      out[rec.dedupe_key] = out[rec.dedupe_key] ?? [];
      out[rec.dedupe_key].push({
        machine_id: rec.machine_id,
        attempt: rec.attempt,
        received_at: rfc3339(rec.received_at_ms),
      });
    }
    return out;
  }

  /* ---------------- serialization ---------------- */

  /**
   * v1.6.2: the whole-relay view: how many fleets this relay serves and how many machines are
   * online. Counts only — the per-fleet member lists stay behind the fleet-scoped endpoints, so
   * this is safe to expose on the public health probe.
   */
  fleetSummary(nowMs = this.nowMs()) {
    const byFleet = new Map();
    let online = 0;
    for (const device of this.devices.values()) {
      const key = typeof device.fleet_id === 'string' && device.fleet_id !== '' ? device.fleet_id : null;
      const entry = byFleet.get(key) ?? { fleet_id: key, devices: 0, online: 0 };
      entry.devices += 1;
      if (this.isOnlineDevice(device, nowMs)) { entry.online += 1; online += 1; }
      byFleet.set(key, entry);
    }
    const fleets = [...byFleet.values()].sort((a, b) => b.devices - a.devices);
    return {
      fleets_total: fleets.filter((f) => f.fleet_id !== null).length,
      // v1.6.3: an online fleet is a fleet with at least one online machine. Reported beside
      // fleets_total so the panel can say "X/Y fleets" the same way it says "M/T machines".
      fleets_online: fleets.filter((f) => f.fleet_id !== null && f.online > 0).length,
      unfleeted_devices: byFleet.get(null)?.devices ?? 0,
      devices_total: this.devices.size,
      devices_online: online,
      fleets,
    };
  }
  stats() {
    return {
      protocol_version: PROTOCOL_VERSION,
      seq: this.seq,
      buffered_events: this.buffer.length,
      devices: this.devices.size,
      // v1.6.2: whole-relay totals on the public health probe.
      fleets_total: this.fleetSummary().fleets_total,
      // v1.6.4: 1.6.3 forgot to surface this on /healthz (the panel reads it there).
      fleets_online: this.fleetSummary().fleets_online,
      devices_online: this.fleetSummary().devices_online,
      devices_total: this.devices.size,
      tasks: this.tasks.size,
      results: this.results.size,
      pairing_codes: [...this.pairingCodes.values()].filter((c) => !c.used && this.nowMs() < c.expires_at_ms).length,
      uptime_ms: this.nowMs() - this.startedAtMs,
    };
  }
}

export default RabbitState;
