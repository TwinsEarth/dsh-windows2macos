/**
 * W2M Rabbit relay — in-memory state machine (RabbitState facade).
 *
 * Contract: E:\DS\_work\w2m\PROTOCOL.md (protocol_version = 1, frozen).
 * This module is intentionally PURE LOGIC:
 *   - no network, no filesystem, no timers (state.mjs itself never touches fs)
 *   - time is injectable via `now()` (required for lease-expiry unit tests)
 *   - randomness is injectable for deterministic tests
 *
 * Persistence: none. All state is in-memory and is lost on restart (v0.0.1 scope);
 * there is intentionally no snapshot/serialization hook yet.
 *
 * P1 refactor slice S5: the domain logic lives in `src/relay/state/` — leases, tasks,
 * results, members and events — behind this facade. `RabbitState` still owns every field:
 * each domain function takes the instance as its first argument and mutates it explicitly,
 * so there is exactly one copy of the state (no shared mutable module state). The public
 * export surface, the method names and every protocol-visible behaviour are unchanged.
 *
 * One exception is deliberate: `submitResult` stays here rather than moving to results.mjs,
 * because `test/relay-redline-audit.test.mjs` pins its projection-before-storage wiring as
 * source text inside this file. The relay suites are the behaviour contract for this slice and
 * must pass unchanged, so result *storage* remains visible here; the pure result-domain helpers
 * (instance keys, envelope checks, dedupe inputs) live in state/results.mjs.
 */

import { randomBytes, verify as verifyBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalSignedPayload, publicKeyFromBase64 } from '../util/envelope-signature.mjs';
import { projectResultEnvelope } from './p0-projection.mjs';
import { isMemberRole } from './fleet-members.mjs';
import { scopeFleetId } from '../chatops/fleet-wiring.mjs';
import { pruneOfferJournals, readOfferJournal } from './offer-journal.mjs';
import { createBlobSessions } from './blob-sessions.mjs';
import { createMetrics } from './reliability-metrics.mjs';
import { createProjectLocks } from './project-locks.mjs';
import { createProjectNotifications } from './project-notifications.mjs';
import { createProjectRefs } from './project-refs.mjs';
import { createProjectReviews } from './project-reviews.mjs';
import { createProjectRoom } from './project-room.mjs';

import * as events from './state/events.mjs';
import * as leases from './state/leases.mjs';
import * as members from './state/members.mjs';
import * as results from './state/results.mjs';
import * as tasks from './state/tasks.mjs';
import {
  PROTOCOL_VERSION,
  DEFAULT_EVENT_BUFFER_SIZE,
  DEFAULT_PAIRING_TTL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MISSED_HEARTBEATS,
  DEFAULT_LEASE_GRACE_MS,
  DEFAULT_SILENCE_MS,
  DEFAULT_P2P_OFFER_GRACE_MS,
  DEFAULT_RTT_STALE_MS,
  ProtocolError,
  createIdFactory,
  jcs,
  normalizeNow,
  rfc3339,
  sha256Hex,
} from './state/shared.mjs';

export {
  ACTIVE_LEASE_STATES,
  COMPARABLE_FIELDS,
  DEFAULT_EVENT_BUFFER_SIZE,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_IDLE_HEARTBEAT_MS,
  DEFAULT_LEASE_GRACE_MS,
  DEFAULT_MISSED_HEARTBEATS,
  DEFAULT_P2P_OFFER_GRACE_MS,
  DEFAULT_PAIRING_TTL_MS,
  DEFAULT_RTT_STALE_MS,
  DEFAULT_SILENCE_MS,
  ENVELOPE_VERSION,
  ERROR_STATUS,
  FAILURE_STATUSES,
  FINGERPRINT_ALGO,
  LEASE_PHASES,
  MAX_FRAME_BYTES,
  MAX_ORIGIN_MACHINE_ID_LENGTH,
  MAX_PIPELINE_STAGES,
  MAX_RTT_MS,
  P2P_MODES,
  PROTOCOL_VERSION,
  ProtocolError,
  REQUIRED_ENVELOPE_FIELDS,
  RESULT_STATUSES,
  SHELL_ID_DIRECT,
  TRANSPORT_VALUES,
  computeCommandHash,
  computeDedupeKey,
  computePipelineCommandHash,
  createIdFactory,
  deepEqual,
  isRfc3339,
  jcs,
  normalizeCwdRel,
  rfc3339,
  sha256Hex,
  ulid,
} from './state/shared.mjs';
export { gateMachine, satisfiesRange } from './state/members.mjs';

export class RabbitState {
  constructor(options = {}) {
    this._now = normalizeNow(options.now);
    this._idFactory = options.idFactory ?? createIdFactory();
    this._randomToken = options.tokenFactory ?? (() => randomBytes(24).toString('hex'));
    this._randomChars = options.randomChars
      ?? ((n) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; const b = randomBytes(n); let s = ''; for (let i = 0; i < n; i += 1) s += a[b[i] % a.length]; return s; });

    // R8: the offer journal lives next to the ledger, so the relay hands its Persistence down.
    this.persistence = options.persistence ?? null;

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
    /**
     * v3.0.0 cluster sync: identities (`origin@offset`) of imported ledger entries already applied to
     * the live tables. `null` means "not loaded yet"; the first import seeds it from the imported
     * ledger file so a crash between apply and cursor-save cannot double-apply an entry.
     */
    this._clusterApplied = null;
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
    // Shared-object ids are scoped per state directory (instance id) so two relays that each start a
    // counter at 1 cannot produce the same lock/review/notification/queue id and be conflated on merge.
    let projectObjectIdPrefix = '';
    try { projectObjectIdPrefix = this.persistence?.loadInstanceId?.() ?? ''; } catch { /* tests without persistence keep legacy ids */ }
    this._projectObjectIdPrefix = projectObjectIdPrefix;
    // v1.3.13-beta.4: branch heads and merge outcomes live with the project room so one stream answers "where is the branch".
    this.refs = createProjectRefs({
      now: () => this.nowMs(),
      idPrefix: projectObjectIdPrefix,
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
      if (typeof this._persistProjects === 'function') this._persistProjects();
      // Shared objects (artifacts/decisions/memory/locks/reviews/refs/notifications) are derived from
      // these events; persist them alongside the room so a restart keeps what clients could read.
      if (typeof this.persistProjectObjects === 'function') this.persistProjectObjects();
      const notified = NOTIFIED[event.type];
      if (notified !== undefined) {
        try {
          this.notifications.notify({ projectId: event.project_id, kind: notified.kind, target: { kind: 'broadcast' }, subject: notified.subject, refs: event.payload ?? {}, requiresAction: notified.requiresAction });
        } catch { /* a notification is never worth failing the event for */ }
      }
    };
    this.projects = createProjectRoom({ now: () => this.nowMs(), onEvent: metricsEvent });
    // A6: the room snapshot is the durable form of projects/members/events. Written after every room
    // event (0600, tmp+rename) and restored before the relay answers anything, so a restart keeps the
    // project object and its cursor instead of silently starting from an empty room.
    this._projectsFile = typeof this.persistence?.dir === 'string' && this.persistence.dir !== ''
      ? join(this.persistence.dir, 'projects', 'room-snapshot.json')
      : null;
    /**
     * Phase 2: durable shared project objects.
     *
     * The room snapshot only carries projects/members/events; artifacts, decisions, project memory,
     * refs, locks, reviews and notifications used to live in memory only (lost on restart). They are
     * written next to the room snapshot so a restart — and a cross-relay merge — starts from the same
     * objects the clients can read.
     */
    this._projectObjectsFile = typeof this.persistence?.dir === 'string' && this.persistence.dir !== ''
      ? join(this.persistence.dir, 'projects', 'objects.json')
      : null;
    if (this._projectsFile !== null) {
      try {
        const snapshot = JSON.parse(readFileSync(this._projectsFile, 'utf8').replace(/^\uFEFF/, ''));
        this.projects.restore(snapshot);
      } catch { /* absent or corrupt: start empty rather than failing to boot */ }
    }
    this.defaultProjectId = 'default';
    // M5 primitives share the project room's event stream: a lock, review or notification is a project event with the
    // module's own sequence attached, so one reader can reconstruct "what happened" from a single cursor.
    const roomEvent = (event) => {
      try {
        this.projects.appendEvent({ projectId: event.payload.project_id, type: event.type, actor: { kind: 'operator', id: 'relay' }, payload: { ...event.payload, module_seq: event.seq } });
      } catch { /* an event about a project that is gone is history, not an error */ }
    };
    // Shared-object ids use the per-state-directory prefix declared above.
    this.locks = createProjectLocks({ now: () => this.nowMs(), onEvent: roomEvent, idPrefix: projectObjectIdPrefix });
    this.reviews = createProjectReviews({ now: () => this.nowMs(), onEvent: roomEvent, idPrefix: projectObjectIdPrefix });
    this.notifications = createProjectNotifications({ now: () => this.nowMs(), onEvent: roomEvent, idPrefix: projectObjectIdPrefix });
    // Phase 2: bring the memory-only shared objects back from disk (and later merge peers' copies).
    this._restoreProjectObjects();
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

  /* ---------------- persistence hooks (v0.1.2 §7) ---------------- */

  /** Inject/replace the persistence backend (also used by tests). */
  setPersistence(persistence) { this._persist = persistence ?? null; return this._persist; }

  /** A6: atomic write of the project room snapshot (0600). */
  _persistProjects() {
    if (typeof this._projectsFile !== 'string' || this._projectsFile === '') return;
    try {
      mkdirSync(dirname(this._projectsFile), { recursive: true, mode: 0o700 });
      const tmp = this._projectsFile + '.tmp-' + process.pid + '-' + Date.now().toString(36);
      writeFileSync(tmp, JSON.stringify(this.projects.toSnapshot()), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this._projectsFile);
    } catch { /* a failed snapshot write must not break the live room */ }
  }

  /**
   * Phase 2: persist the shared project objects next to the project room snapshot.
   *
   * These are the objects a client reads through the project routes (artifacts, decisions, memory,
   * refs, locks, reviews, notifications). Without this file a restart kept the event log but lost the
   * objects, which is one of the gaps the Phase 2 design named.
   */
  persistProjectObjects() {
    if (typeof this._projectObjectsFile !== 'string' || this._projectObjectsFile === '') return;
    try {
      const value = {
        v: 1,
        artifacts: [...(this.artifacts?.values?.() ?? [])],
        decisions: [...(this.decisions?.values?.() ?? [])].flat(),
        memory: [...(this.projectMemory?.values?.() ?? [])],
        refs: typeof this.refs?.snapshot === 'function' ? this.refs.snapshot() : null,
        locks: typeof this.locks?.snapshot === 'function' ? this.locks.snapshot() : [],
        reviews: typeof this.reviews?.snapshot === 'function' ? this.reviews.snapshot() : [],
        notifications: typeof this.notifications?.snapshot === 'function' ? this.notifications.snapshot() : [],
        notification_read_marks: typeof this.notifications?.snapshotReadMarks === 'function' ? this.notifications.snapshotReadMarks() : [],
      };
      mkdirSync(dirname(this._projectObjectsFile), { recursive: true, mode: 0o700 });
      const tmp = this._projectObjectsFile + '.tmp-' + process.pid + '-' + Date.now().toString(36);
      writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this._projectObjectsFile);
    } catch { /* a failed object write must not break the live room */ }
  }

  /** Load project objects written by `persistProjectObjects()` (best effort). */
  _restoreProjectObjects() {
    if (typeof this._projectObjectsFile !== 'string' || this._projectObjectsFile === '') return;
    let loaded = null;
    try {
      loaded = JSON.parse(readFileSync(this._projectObjectsFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch { return; }
    if (loaded === null || typeof loaded !== 'object') return;
    try {
      if (Array.isArray(loaded.artifacts)) {
        for (const artifact of loaded.artifacts) {
          if (artifact !== null && typeof artifact === 'object' && typeof artifact.sha256 === 'string') this.artifacts.set(artifact.sha256, artifact);
        }
      }
    } catch { /* one bad object never blocks boot */ }
    try {
      if (Array.isArray(loaded.decisions)) {
        for (const decision of loaded.decisions) {
          if (decision === null || typeof decision !== 'object' || typeof decision.project_id !== 'string') continue;
          const list = this.decisions.get(decision.project_id) ?? [];
          list.push(decision);
          this.decisions.set(decision.project_id, list);
        }
      }
    } catch { /* ignore */ }
    try {
      if (Array.isArray(loaded.memory)) {
        for (const doc of loaded.memory) {
          if (doc !== null && typeof doc === 'object' && typeof doc.project_id === 'string') this.projectMemory.set(doc.project_id, doc);
        }
      }
    } catch { /* ignore */ }
    const restoreModule = (module, value) => {
      try { if (value !== null && value !== undefined && typeof module?.restore === 'function') module.restore(value); } catch { /* ignore */ }
    };
    restoreModule(this.refs, loaded.refs);
    restoreModule(this.locks, loaded.locks);
    restoreModule(this.reviews, loaded.reviews);
    restoreModule(this.notifications, loaded.notifications);
    try {
      if (Array.isArray(loaded.notification_read_marks) && typeof this.notifications?.restoreReadMarks === 'function') {
        this.notifications.restoreReadMarks(loaded.notification_read_marks);
      }
    } catch { /* ignore */ }
  }

  /** Persist room + objects after an imported merge (called by the cluster domain sync). */
  persistProjectState() {
    this._persistProjects();
    this.persistProjectObjects();
  }

  /** Push an imported project event to the existing SSE subscribers. */
  broadcastProjectEvent(event) {
    for (const listener of this.projectSubscribers) {
      try { listener(event); } catch { /* a subscriber never breaks the room */ }
    }
  }

  /** Chat read watermarks as a flat list, for the durable chat store. */
  snapshotReadMarks() {
    const rows = [];
    for (const [sessionId, perSession] of this.readMarks) {
      for (const [machineId, mark] of perSession) {
        if (mark === null || typeof mark !== 'object' || !Number.isFinite(mark.at_ms)) continue;
        rows.push({ session_id: sessionId, machine_id: machineId, at_ms: mark.at_ms, message_id: typeof mark.message_id === 'string' ? mark.message_id : null });
      }
    }
    return rows;
  }

  /** Restore chat read watermarks (LWW: `markRead` only advances a watermark). */
  restoreReadMarks(rows) {
    if (!Array.isArray(rows)) return 0;
    let restored = 0;
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      if (typeof row.session_id !== 'string' || typeof row.machine_id !== 'string' || !Number.isFinite(row.at_ms)) continue;
      try { this.markRead(row.session_id, row.machine_id, { at_ms: row.at_ms, message_id: typeof row.message_id === 'string' ? row.message_id : null }); restored += 1; } catch { /* ignore */ }
    }
    return restored;
  }

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
      if (typeof this.persistence?.dir === 'string') pruneOfferJournals(this.persistence.dir, new Set(this.tasks.keys()));
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

        const journal = typeof this.persistence?.dir === 'string' ? readOfferJournal(this.persistence.dir, t.task_id) : null;
        const recoveredArgv = Array.isArray(journal?.argv) && journal.argv.length > 0 ? journal.argv : (Array.isArray(t.command_argv) ? t.command_argv : []);
        const recoveredStages = Array.isArray(journal?.stages) && journal.stages.length > 0 ? journal.stages : (Array.isArray(t.stages) ? t.stages : null);
        const task = {
          task_id: t.task_id,
          mode: t.mode ?? 'replicate',
          command_argv: recoveredArgv,
          stages: recoveredStages,
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
      ...(t.mode === 'mapreduce' ? { reduce_argv: Array.isArray(journal?.reduce_argv) ? journal.reduce_argv : (Array.isArray(t.reduce_argv) ? t.reduce_argv : null), reducer_machine_id: t.reducer_machine_id ?? null } : {}),
      max_attempts: Number.isInteger(t.max_attempts) ? t.max_attempts : 1,
      retry_on: Array.isArray(t.retry_on) ? t.retry_on : [],
          created_by: t.created_by ?? null,
          /**
           * v3.0.0: the fleet the task belongs to must survive a restart *and* a cluster import.
           *
           * `listTasks` scopes a fleet-bound device to `task.fleet_id`, so a task restored without it
           * disappears from every fleet-scoped listing. Older ledgers do not carry the field: fall back
           * to the creator's device record (devices are restored before the ledger is replayed), which
           * is the same rule `createTask` used to compute it.
           */
          fleet_id: typeof t.fleet_id === 'string' && t.fleet_id !== ''
            ? t.fleet_id
            : (typeof t.created_by === 'string' ? (this.devices.get(t.created_by)?.fleet_id ?? null) : null),
          created_at_ms: Number.isFinite(createdAt) ? createdAt : this.nowMs(),
          command_hash: t.command_hash ?? null,
          plan_sha256: t.plan_sha256 ?? null,
          approval_sha256: t.approval_sha256 ?? null,
          step_id: t.step_id ?? null,
          ...(Array.isArray(journal?.argv) && journal.argv.length > 0 ? {} : { offer_unavailable: true }),
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

  /* ---------------- v3.0.0: relay cluster sync merge ---------------- */

  /**
   * Merge device records pulled from a peer relay.
   *
   * LWW per `machine_id`: `re_paired` first, then `paired_at_ms`. Presence is never imported — a device
   * that is online on the peer is not online here, and reporting otherwise would make the local SSE
   * stream promise a connection this relay does not have. Missing `device_token`/`fleet_id` are filled
   * in without downgrading a newer local record: a standby relay cannot authenticate a device it has
   * no token for, which is the whole reason devices are synced at all.
   *
   * @param {object[]} records
   * @returns {{added:number, updated:number, unchanged:number, rejected:number}}
   */
  mergeClusterDevices(records) {
    const stats = { added: 0, updated: 0, unchanged: 0, rejected: 0 };
    if (!Array.isArray(records)) return stats;
    for (const raw of records) {
      if (raw === null || typeof raw !== 'object' || typeof raw.machine_id !== 'string' || raw.machine_id === '') {
        stats.rejected += 1;
        continue;
      }
      const machineId = raw.machine_id;
      const remotePairedAt = Number.isFinite(raw.paired_at_ms) ? raw.paired_at_ms : 0;
      const remoteRePaired = raw.re_paired === true;
      const local = this.devices.get(machineId) ?? null;
      const localPairedAt = local !== null && Number.isFinite(local.paired_at_ms) ? local.paired_at_ms : 0;
      const localRePaired = local !== null && local.re_paired === true;
      const remoteIsNewer = local === null
        || (remoteRePaired && !localRePaired)
        || (remoteRePaired === localRePaired && remotePairedAt > localPairedAt);
      if (!remoteIsNewer) {
        if (local !== null) {
          let touched = false;
          if (!local.device_token && typeof raw.device_token === 'string' && raw.device_token !== '') {
            local.device_token = raw.device_token;
            this.tokens.set(raw.device_token, machineId);
            touched = true;
          }
          if (!local.fleet_id && typeof raw.fleet_id === 'string' && raw.fleet_id !== '') {
            local.fleet_id = raw.fleet_id;
            local.fleet_source = typeof raw.fleet_source === 'string' && raw.fleet_source !== '' ? raw.fleet_source : 'cluster-sync';
            touched = true;
          }
          if (touched) stats.updated += 1;
          else stats.unchanged += 1;
        } else {
          stats.unchanged += 1;
        }
        continue;
      }
      const device = {
        machine_id: machineId,
        machine_name: typeof raw.machine_name === 'string' && raw.machine_name !== '' ? raw.machine_name : machineId,
        platform: raw.platform ?? {},
        caps: raw.caps ?? {},
        user_id: raw.user_id ?? null,
        device_token: typeof raw.device_token === 'string' ? raw.device_token : null,
        paired_at_ms: remotePairedAt,
        re_paired: remoteRePaired,
        fleet_id: typeof raw.fleet_id === 'string' && raw.fleet_id !== '' ? raw.fleet_id : null,
        fleet_source: typeof raw.fleet_source === 'string' && raw.fleet_source !== '' ? raw.fleet_source : 'cluster-sync',
        last_seen_at_ms: this.nowMs(),
        online: false,
        streams: 0,
        rtt_ms: null,
        rtt_at_ms: null,
        last_heartbeat_at_ms: null,
        stream_connects: 0,
      };
      if (local !== null) {
        // keep volatile presence/measurements from this relay
        device.online = local.online === true;
        device.streams = typeof local.streams === 'number' ? local.streams : 0;
        device.last_seen_at_ms = local.last_seen_at_ms ?? device.last_seen_at_ms;
        device.last_heartbeat_at_ms = local.last_heartbeat_at_ms ?? null;
        device.rtt_ms = local.rtt_ms ?? null;
        device.rtt_at_ms = local.rtt_at_ms ?? null;
        device.stream_connects = local.stream_connects ?? 0;
        stats.updated += 1;
      } else {
        stats.added += 1;
      }
      if (local?.device_token && local.device_token !== device.device_token) this.tokens.delete(local.device_token);
      this.devices.set(machineId, device);
      if (device.device_token) this.tokens.set(device.device_token, machineId);
    }
    if (stats.added > 0 || stats.updated > 0) this._saveDevices();
    return stats;
  }

  /**
   * Apply ledger entries imported from a peer relay.
   *
   * The entries are already durable on the peer; this relay only replays them into the live task/result
   * tables so a task created on relay A is answerable on relay B before B restarts. Replay is
   * idempotent: `(origin, offset)` is the identity of an imported entry, and the set of applied
   * identities is seeded from the imported-ledger file on first use.
   *
   * `operator.key.registered` is intentionally not imported: operator keys are per-relay authority,
   * and copying one would let a key registered on one relay authorise work on another.
   *
   * @param {{origin:string, offset:number, entry:object}[]} records
   * @returns {{applied:number, duplicates:number, skipped:number}}
   */
  applyClusterLedger(records) {
    const stats = { applied: 0, duplicates: 0, skipped: 0 };
    if (!Array.isArray(records)) return stats;
    if (this._clusterApplied === null) {
      this._clusterApplied = new Set();
      try {
        for (const record of this.persistence?.loadClusterLedger?.() ?? []) {
          this._clusterApplied.add(`${record.origin}@${record.offset}`);
        }
      } catch { /* an unreadable imported ledger means no identities are known; duplicates are still keyed by (origin,offset) */ }
    }
    const previousRestoring = this._restoring;
    this._restoring = true; // replaying must never append to our own ledger
    try {
      for (const record of records) {
        if (record === null || typeof record !== 'object' || typeof record.origin !== 'string' || !Number.isInteger(record.offset)
          || record.entry === null || typeof record.entry !== 'object' || typeof record.entry.type !== 'string') {
          stats.skipped += 1;
          continue;
        }
        const key = `${record.origin}@${record.offset}`;
        if (this._clusterApplied.has(key)) {
          stats.duplicates += 1;
          continue;
        }
        this._clusterApplied.add(key);
        if (record.entry.type === 'operator.key.registered') {
          stats.skipped += 1;
          continue;
        }
        try {
          this._applyLedgerEntry(record.entry);
          stats.applied += 1;
        } catch {
          stats.skipped += 1;
        }
      }
    } finally {
      this._restoring = previousRestoring;
    }
    return stats;
  }

  /* ---------------- events (§3) — delegated to state/events.mjs ---------------- */
  nextSeq(...args) { return events.nextSeq(this, ...args); }
  reserveSeq(...args) { return events.reserveSeq(this, ...args); }
  onEvent(...args) { return events.onEvent(this, ...args); }
  emit(...args) { return events.emit(this, ...args); }
  oldestBufferedSeq(...args) { return events.oldestBufferedSeq(this, ...args); }
  lastBufferedSeq(...args) { return events.lastBufferedSeq(this, ...args); }
  lastSeq(...args) { return events.lastSeq(this, ...args); }
  replayEntries(...args) { return events.replayEntries(this, ...args); }
  eventsSince(...args) { return events.eventsSince(this, ...args); }

  /* ---------------- pairing, members, presence/RTT (§2, v0.3.0 §R) — delegated to state/members.mjs ---------------- */
  createPairingCode(...args) { return members.createPairingCode(this, ...args); }
  rotatePairingCode(...args) { return members.rotatePairingCode(this, ...args); }
  registerPairingCode(...args) { return members.registerPairingCode(this, ...args); }
  registerAccountKey(...args) { return members.registerAccountKey(this, ...args); }
  accountKeyFor(...args) { return members.accountKeyFor(this, ...args); }
  validatePairingCode(...args) { return members.validatePairingCode(this, ...args); }
  pair(...args) { return members.pair(this, ...args); }
  authenticate(...args) { return members.authenticate(this, ...args); }
  touchDevice(...args) { return members.touchDevice(this, ...args); }
  setOnline(...args) { return members.setOnline(this, ...args); }
  static normalizeRtt(...args) { return members.normalizeRtt(...args); }
  rttStaleAfterMs(...args) { return members.rttStaleAfterMs(this, ...args); }
  recordHeartbeatMetrics(...args) { return members.recordHeartbeatMetrics(this, ...args); }
  isRttStale(...args) { return members.isRttStale(this, ...args); }
  rttAgeMs(...args) { return members.rttAgeMs(this, ...args); }
  noteStreamConnect(...args) { return members.noteStreamConnect(this, ...args); }
  rttSummary(...args) { return members.rttSummary(this, ...args); }
  silenceAgeMs(...args) { return members.silenceAgeMs(this, ...args); }
  sweepSilentDevices(...args) { return members.sweepSilentDevices(this, ...args); }
  isOnlineDevice(...args) { return members.isOnlineDevice(this, ...args); }
  deviceStatus(...args) { return members.deviceStatus(this, ...args); }
  publicDevice(...args) { return members.publicDevice(this, ...args); }
  listDevices(...args) { return members.listDevices(this, ...args); }
  roleOf(...args) { return members.roleOf(this, ...args); }
  listMembers(...args) { return members.listMembers(this, ...args); }
  setMemberRole(...args) { return members.setMemberRole(this, ...args); }
  markRead(...args) { return members.markRead(this, ...args); }
  readMark(...args) { return members.readMark(this, ...args); }

  /* ---------------- tasks (§4), project objects — delegated to state/tasks.mjs ---------------- */
  static validateTaskRouting(...args) { return tasks.validateTaskRouting(...args); }
  createTask(...args) { return tasks.createTask(this, ...args); }
  ensureProject(...args) { return tasks.ensureProject(this, ...args); }
  projectSnapshot(...args) { return tasks.projectSnapshot(this, ...args); }
  projectEvents(...args) { return tasks.projectEvents(this, ...args); }
  getTask(...args) { return tasks.getTask(this, ...args); }
  requireTask(...args) { return tasks.requireTask(this, ...args); }
  listTasks(...args) { return tasks.listTasks(this, ...args); }
  _taskSettled(...args) { return tasks._taskSettled(this, ...args); }
  _releaseDependents(...args) { return tasks._releaseDependents(this, ...args); }
  revokeGrant(...args) { return tasks.revokeGrant(this, ...args); }
  grantedTasks(...args) { return tasks.grantedTasks(this, ...args); }
  registerArtifact(...args) { return tasks.registerArtifact(this, ...args); }
  listArtifacts(...args) { return tasks.listArtifacts(this, ...args); }
  projectBoard(...args) { return tasks.projectBoard(this, ...args); }
  addDecision(...args) { return tasks.addDecision(this, ...args); }
  listDecisions(...args) { return tasks.listDecisions(this, ...args); }
  setProjectMemory(...args) { return tasks.setProjectMemory(this, ...args); }
  getProjectMemory(...args) { return tasks.getProjectMemory(this, ...args); }
  onProjectEvent(...args) { return tasks.onProjectEvent(this, ...args); }
  taskSummary(...args) { return tasks.taskSummary(this, ...args); }
  cancelTask(...args) { return tasks.cancelTask(this, ...args); }

  /* ---------------- leases / heartbeat (§4.3) — delegated to state/leases.mjs ---------------- */
  leaseWindowMs(...args) { return leases.leaseWindowMs(this, ...args); }
  _p2pOfferGraceMs(...args) { return leases._p2pOfferGraceMs(this, ...args); }
  _scheduleOffer(...args) { return leases._scheduleOffer(this, ...args); }
  clearPendingOffers(...args) { return leases.clearPendingOffers(this, ...args); }
  emitOffer(...args) { return leases.emitOffer(this, ...args); }
  redeliverPendingOffers(...args) { return leases.redeliverPendingOffers(this, ...args); }
  _validatePhaseProgress(...args) { return leases._validatePhaseProgress(this, ...args); }
  _mergeAdvertisedCaps(...args) { return leases._mergeAdvertisedCaps(this, ...args); }
  diagnosticHeartbeat(...args) { return leases.diagnosticHeartbeat(this, ...args); }
  heartbeat(...args) { return leases.heartbeat(this, ...args); }
  leaseHeartbeat(...args) { return leases.leaseHeartbeat(this, ...args); }
  isLeaseExpired(...args) { return leases.isLeaseExpired(this, ...args); }
  sweepExpired(...args) { return leases.sweepExpired(this, ...args); }
  _takeover(...args) { return leases._takeover(this, ...args); }

  /* ---------------- results (§5) — delegated to state/results.mjs ---------------- */
  static validateTransportFields(...args) { return results.validateTransportFields(...args); }
  static instanceKey(...args) { return results.instanceKey(...args); }
  static validateEnvelope(...args) { return results.validateEnvelope(...args); }
  taskResults(...args) { return results.taskResults(this, ...args); }
  dedupeReport(...args) { return results.dedupeReport(this, ...args); }

  /* ---------------- result storage (submitResult) — stays here: the red-line audit pins its source wiring ---------------- */
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

    // B2/V5/V6/V7：先校验（上面已完成），再投影后存储；原信封哈希单独保留用于审计。
    const { projected, dropped } = projectResultEnvelope(envelope);
    const record = {
      envelope: projected,
      envelope_sha256_received: typeof envelope.envelope_sha256 === 'string' ? envelope.envelope_sha256 : null,
      ...(dropped.length > 0 ? { projection: { dropped } } : {}),
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
