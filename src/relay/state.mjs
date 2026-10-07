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

/** §4.4 helper: command_hash = sha256(JCS(argv)+"|"+shell_id+"|"+cwd_rel). */
export function computeCommandHash(commandArgv, shellId = SHELL_ID_DIRECT, cwdRel = '.') {
  return sha256Hex(`${jcs(commandArgv)}|${shellId}|${cwdRel}`);
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
    if (mode !== 'replicate' && mode !== 'split') {
      throw new ProtocolError('BAD_REQUEST', 'mode must be replicate|split', { mode });
    }
    const commandArgv = input.command_argv;
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
    const commandHash = input.command_hash ?? computeCommandHash(commandArgv, SHELL_ID_DIRECT, cwdRel);
    const timeoutMs = Number.isInteger(input.timeout_ms) ? input.timeout_ms : 300_000;

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
    };

    const all = [...this.devices.values()];
    const targets = Array.isArray(input.target_machines) && input.target_machines.length > 0
      ? all.filter((d) => input.target_machines.includes(d.machine_id))
      : all;

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
      const lease = {
        machine_id: device.machine_id,
        machine_name: device.machine_name,
        index,
        attempt: 1,
        state: 'queued',
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

  /**
   * §4.3 POST /v1/heartbeat — renews the lease using SERVER time only.
   * @returns {{lease_until:string, cancel:boolean, phase?:string, progress?:number}}
   */
  heartbeat(input = {}) {
    const task = this.requireTask(input.task_id);
    const lease = task.leases.get(input.machine_id);
    if (!lease) {
      throw new ProtocolError('NOT_FOUND', 'no lease for this machine on this task', {
        task_id: input.task_id, machine_id: input.machine_id,
      });
    }
    if (input.phase !== undefined && input.phase !== null && !LEASE_PHASES.includes(input.phase)) {
      throw new ProtocolError('BAD_REQUEST', 'phase must be preparing|running|finalizing', { phase: input.phase });
    }
    if (input.progress !== undefined && input.progress !== null
      && (typeof input.progress !== 'number' || input.progress < 0 || input.progress > 1)) {
      throw new ProtocolError('BAD_REQUEST', 'progress must be a number in [0,1]', { progress: input.progress });
    }

    const now = this.nowMs();
    this.touchDevice(input.machine_id);

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
