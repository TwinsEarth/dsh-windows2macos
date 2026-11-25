/**
 * Relay state — protocol constants, the protocol error type and small pure helpers.
 *
 * Split out of `state.mjs` (P1 refactor slice S5) so the domain modules in `src/relay/state/`
 * can share one definition of every constant and pure function without importing the state
 * machine back (which would create a cycle). This module is intentionally PURE LOGIC:
 *   - no mutable module-level state
 *   - no network, no filesystem, no timers
 *   - time is injectable via the owning state (`now()` / `idFactory`); nothing here reads the
 *     clock on its own
 *
 * Everything here is re-exported by `state.mjs`, so the public surface is unchanged.
 */

import { createHash, randomBytes } from 'node:crypto';

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
  INVALID_ORIGIN: 400,
  INVALID_TARGET: 400,
  INVALID_LOCK_KIND: 400,
  INVALID_HOLDER: 400,
  INVALID_LEASE: 400,
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

/**
 * Canonical form of a relative working directory. Both the relay and the agent hash this string, so
 * it is normalized in exactly one place per side and the two definitions are asserted to agree:
 * backslashes become slashes, './' and repeated/trailing slashes disappear, empty means '.'.
 */
export function normalizeCwdRel(value) {
  if (value === null || value === undefined) return '.';
  let out = String(value).replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  out = out.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return out === '' ? '.' : out;
}

/** §4.4 helper: command_hash = sha256(JCS(argv)+"|"+shell_id+"|"+cwd_rel). */
export function computeCommandHash(commandArgv, shellId = SHELL_ID_DIRECT, cwdRel = '.') {
  return sha256Hex(`${jcs(commandArgv)}|${shellId}|${normalizeCwdRel(cwdRel)}`);
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
    cwd_rel: normalizeCwdRel(s.cwd_rel),
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

export function normalizeNow(now) {
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
