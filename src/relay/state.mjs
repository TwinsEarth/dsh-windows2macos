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
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    /** When true one code stays valid for its whole TTL instead of rotating. */
    this.pairingCodeReusable = options.pairingCodeReusable === true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.missedHeartbeats = options.missedHeartbeats ?? DEFAULT_MISSED_HEARTBEATS;
    this.leaseGraceMs = options.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS;
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
      return this._persist.append(entry);
    } catch (err) {
      this._persist.warn?.('ledger.jsonl', `append failed: ${err.message}`);
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
          created_by: t.created_by ?? null,
          created_at_ms: Number.isFinite(createdAt) ? createdAt : this.nowMs(),
          command_hash: t.command_hash ?? null,
          attempt: t.attempt ?? 1,
          leases: new Map(),
          cancelled: false,
          cancel_reason: null,
          degraded: t.degraded ?? null,
          deadline_ms: t.deadline_ms ?? 0,
          result_seqs: [],
        };
        for (const lease of entry.leases ?? []) {
          if (lease && typeof lease.machine_id === 'string') task.leases.set(lease.machine_id, { ...lease });
        }
        this.tasks.set(task.task_id, task);
        return true;
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

  createPairingCode({ ttlMs = this.pairingTtlMs } = {}) {
    let code;
    do { code = `PAIR-${this._randomChars(8)}`; } while (this.pairingCodes.has(code));
    const now = this.nowMs();
    this.pairingCodes.set(code, { code, created_at_ms: now, expires_at_ms: now + ttlMs, used: false });
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
    const rec = this.validatePairingCode(request.pairing_code);
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
   * v0.3.0 single-machine status view.
   *
   * `last_heartbeat_at` and `rtt_at` answer different questions, and the gap
   * between them is the whole point: a machine can be heartbeating (alive) while
   * its RTT number is old (a v0.2.3 agent that never sends `rtt_ms`), and a
   * machine can be gone while a plausible-looking RTT is still on file.
   */
  deviceStatus(machineId, nowMs = this.nowMs()) {
    const device = this.devices.get(machineId);
    if (!device) return null;
    const rttAt = device.rtt_at_ms ?? null;
    const lastHeartbeat = device.last_heartbeat_at_ms ?? null;
    return {
      machine_id: device.machine_id,
      machine_name: device.machine_name,
      relay_id: this.relayId,
      connected: (device.streams ?? 0) > 0,
      streams: device.streams ?? 0,
      online: device.online === true,
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
    return {
      machine_id: device.machine_id,
      machine_name: device.machine_name,
      platform: device.platform,
      caps: device.caps,
      user_id: device.user_id,
      online: device.online,
      streams: device.streams,
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
   * §4.1 POST /v1/task.
   * Machine selection is not specified by the PROTOCOL; we implement:
   *   - `target_machines` (optional explicit list), else every paired device
   *   - capability gate §6.1 per machine (failures become `refused` leases)
   *   - index assignment: replicate -> 0, split -> round-robin modulo index_total
   */
  createTask(input = {}) {
    const mode = input.mode ?? 'replicate';
    if (mode !== 'replicate' && mode !== 'split' && mode !== 'broadcast' && mode !== 'pipeline' && mode !== 'compose') {
      throw new ProtocolError(
        'BAD_REQUEST',
        'mode must be replicate|split|broadcast|pipeline|compose',
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

    const halt = input.halt ?? 'never';
    if (halt !== 'never' && halt !== 'now') throw new ProtocolError('BAD_REQUEST', 'halt must be never|now', { halt });

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
    const targetIds = Array.isArray(input.target_machines) && input.target_machines.length > 0
      ? input.target_machines
      : [...this.devices.keys()];
    const executorMachineId = mode === 'broadcast'
      ? (typeof input.executor_machine_id === 'string' && input.executor_machine_id !== ''
        ? input.executor_machine_id
        : targetIds[0] ?? null)
      : null;

    const task = {
      task_id: taskId,
      mode,
      command_argv: commandArgv,
      cwd_rel: cwdRel,
      index_total: indexTotal,
      timeout_ms: timeoutMs,
      write: input.write === true,
      write_scope: input.write_scope ?? [],
      require_exclusive_write: input.require_exclusive_write === true,
      base_commit: input.base_commit ?? null,
      base_tree: baseTree,
      requirements: input.requirements ?? {},
      compare_policy: input.compare_policy ?? {},
      halt,
      created_by: input.created_by ?? null,
      created_at_ms: now,
      command_hash: commandHash,
      attempt: 1,
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
    };

    const all = [...this.devices.values()];
    const targets = Array.isArray(input.target_machines) && input.target_machines.length > 0
      ? all.filter((d) => input.target_machines.includes(d.machine_id))
      : all;

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
        known_devices: all.length,
      });
    }

    const dedupeKeyBase = computeDedupeKey(taskId, 0, commandHash, baseTree);
    if (typeof dedupeKeyBase !== 'string' || dedupeKeyBase.length !== 64) {
      throw new ProtocolError('INTERNAL', 'failed to compute dedupe_key');
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
      const event = this.emitOffer(task, lease);
      lastSeq = event.seq;
    });

    this.tasks.set(taskId, task);

    this._ledger({
      type: 'task.created',
      task: {
        task_id: task.task_id,
        mode: task.mode,
        command_argv: task.command_argv,
        cwd_rel: task.cwd_rel,
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
      },
      leases: [...task.leases.values()].map((l) => ({ ...l })),
    });

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
        ...(l.refusal_reason ? { refusal_reason: l.refusal_reason } : {}),
      })),
      seq: lastSeq,
    };
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
      cwd_rel: task.cwd_rel,
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

  listTasks({ limit = 50 } = {}) {
    const n = Number.isInteger(limit) && limit > 0 ? limit : 50;
    return [...this.tasks.values()]
      .sort((a, b) => b.created_at_ms - a.created_at_ms)
      .slice(0, n)
      .map((t) => this.taskSummary(t));
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
    };
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
        if (task.halt === 'now') {
          task.attempt += 1;
          this._takeover(task, lease, nowMs);
        }
      }
      if (changed) task.degraded = 'partial';
    }
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
    const candidates = [];
    for (const device of this.devices.values()) {
      if (device.machine_id === expiredLease.machine_id) continue;
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

  stats() {
    return {
      protocol_version: PROTOCOL_VERSION,
      seq: this.seq,
      buffered_events: this.buffer.length,
      devices: this.devices.size,
      tasks: this.tasks.size,
      results: this.results.size,
      pairing_codes: [...this.pairingCodes.values()].filter((c) => !c.used && this.nowMs() < c.expires_at_ms).length,
      uptime_ms: this.nowMs() - this.startedAtMs,
    };
  }
}

export default RabbitState;
