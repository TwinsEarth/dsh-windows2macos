/**
 * Project locks (M5, v1.3.10-beta.15 slice).
 *
 * Two coordination primitives, one module: an exclusive branch lock and an exclusive file lock. They exist so two clients
 * disagree about *who is editing what* before they disagree about merge conflicts, and so a crashed client's claim expires
 * instead of blocking the project forever.
 *
 * Rules (docs/COLLAB/M5-MULTI-CLIENT-PRIMITIVES.md 搂2):
 *  - one exclusive holder per (project, branch) or (project, path);
 *  - a lock has a lease and is renewed by its holder; an expired lock does not block a newcomer (it is released as it is taken,
 *    and both the expiry and the new acquisition are events);
 *  - nobody steals a live lock; the owner may force-release with a reason, which is also an event;
 *  - every mutation is recorded as an event for the project room to append.
 *
 * This module holds no relay state of its own; state is injected so it can be tested and replayed.
 */
export const LOCK_KINDS = Object.freeze(['branch', 'file']);
export const DEFAULT_LOCK_LEASE_MS = 30 * 60 * 1000;
export const DEFAULT_LOCK_LIMITS = Object.freeze({ perProject: 20, perHolder: 10 });

export class LockError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    this.detail = detail;
  }
}

const holderKey = (holder) => holder.kind + ':' + holder.id;

export function createProjectLocks({ now = () => Date.now(), defaultLeaseMs = DEFAULT_LOCK_LEASE_MS, limits = DEFAULT_LOCK_LIMITS, onEvent = null, idPrefix = '' } = {}) {
  const locks = new Map(); // lock_id -> lock
  const idScope = typeof idPrefix === 'string' && idPrefix !== '' ? idPrefix + '-' : '';
  let counter = 0;
  let seq = 0;

  const emit = (type, payload) => {
    seq += 1;
    const event = { seq, type, at: new Date(now()).toISOString(), payload };
    if (typeof onEvent === 'function') onEvent(event);
    return event;
  };

  const targetKey = (projectId, kind, target) => projectId + '|' + kind + '|' + (kind === 'branch' ? target.branch : target.path);

  /** Expire every lock whose lease ran out, recording one event each. Called lazily by every operation. */
  const expireDue = () => {
    const expired = [];
    for (const lock of locks.values()) {
      if (lock.state === 'held' && lock.expires_at_ms <= now()) {
        lock.state = 'expired';
        expired.push(lock);
        emit('lock.expired', { lock_id: lock.lock_id, project_id: lock.project_id, kind: lock.kind, target: lock.target, holder: lock.holder });
      }
    }
    return expired;
  };

  const LOCK_STATES = Object.freeze(['held', 'expired', 'released', 'force_released']);
  const asIso = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);

  /**
   * Rebuild one internal lock from a serialised row. Accepts the wire spelling (`project_id`) and the
   * internal one (`projectId`), normalises timestamps and drops anything that cannot be a lock.
   */
  const normalizeLockRow = (row) => {
    if (row === null || typeof row !== 'object') return null;
    if (typeof row.lock_id !== 'string' || row.lock_id === '') return null;
    const projectId = typeof row.project_id === 'string' && row.project_id !== ''
      ? row.project_id
      : (typeof row.projectId === 'string' && row.projectId !== '' ? row.projectId : '');
    if (projectId === '') return null;
    if (!LOCK_KINDS.includes(row.kind)) return null;
    if (row.target === null || typeof row.target !== 'object') return null;
    const target = row.kind === 'branch'
      ? (typeof row.target.branch === 'string' && row.target.branch !== '' ? { branch: row.target.branch } : null)
      : (typeof row.target.path === 'string' && row.target.path !== '' ? { path: row.target.path } : null);
    if (target === null) return null;
    if (row.holder === null || typeof row.holder !== 'object' || typeof row.holder.kind !== 'string' || typeof row.holder.id !== 'string') return null;
    if (!LOCK_STATES.includes(row.state)) return null;
    const leaseMs = Number.isFinite(row.lease_ms) && row.lease_ms > 0 ? row.lease_ms : defaultLeaseMs;
    const expiresMs = Number.isFinite(row.expires_at_ms)
      ? row.expires_at_ms
      : (Number.isFinite(Date.parse(row.expires_at)) ? Date.parse(row.expires_at) : null);
    if (expiresMs === null) return null;
    const acquiredAt = asIso(row.acquired_at) ?? new Date(expiresMs - leaseMs).toISOString();
    return {
      lock_id: row.lock_id,
      projectId,
      kind: row.kind,
      target,
      holder: { kind: row.holder.kind, id: row.holder.id },
      reason: typeof row.reason === 'string' ? row.reason : null,
      lease_ms: leaseMs,
      acquired_at: acquiredAt,
      expires_at: asIso(row.expires_at) ?? new Date(expiresMs).toISOString(),
      expires_at_ms: expiresMs,
      renewed_at: asIso(row.renewed_at),
      state: row.state,
    };
  };

  const idCounter = (id) => {
    const match = /(\d+)$/.exec(id);
    return match === null ? 0 : Number(match[1]);
  };

  const describe = (lock) => ({
    lock_id: lock.lock_id,
    project_id: lock.project_id,
    kind: lock.kind,
    target: lock.target,
    mode: 'exclusive',
    holder: lock.holder,
    reason: lock.reason,
    acquired_at: lock.acquired_at,
    expires_at: lock.expires_at,
    lease_ms: lock.lease_ms,
    renewed_at: lock.renewed_at,
    state: lock.state,
  });

  return {
    /** Acquire an exclusive lock. An expired lock on the same target does not block the newcomer. */
    acquire({ projectId, kind, target, holder, reason = null, leaseMs = defaultLeaseMs }) {
      if (typeof projectId !== 'string' || projectId === '') throw new LockError('INVALID_PROJECT', 'project_id is required');
      if (!LOCK_KINDS.includes(kind)) throw new LockError('INVALID_LOCK_KIND', 'kind must be branch or file', { kind });
      if (!target || typeof target !== 'object') throw new LockError('INVALID_TARGET', 'target is required', { kind });
      if (kind === 'branch' && (typeof target.branch !== 'string' || target.branch === '')) throw new LockError('INVALID_TARGET', 'a branch lock needs target.branch', { target });
      if (kind === 'file' && (typeof target.path !== 'string' || target.path === '')) throw new LockError('INVALID_TARGET', 'a file lock needs target.path', { target });
      if (!holder || typeof holder.kind !== 'string' || typeof holder.id !== 'string' || holder.id === '') throw new LockError('INVALID_HOLDER', 'holder needs kind and id');
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new LockError('INVALID_LEASE', 'lease_ms must be positive', { lease_ms: leaseMs });
      expireDue();
      const key = targetKey(projectId, kind, target);
      const existing = [...locks.values()].find((lock) => lock.state === 'held' && targetKey(lock.projectId, lock.kind, lock.target) === key);
      if (existing !== undefined) {
        return { ok: false, code: 'LOCK_HELD', holder: existing.holder, lock_id: existing.lock_id, expires_at: existing.expires_at };
      }
      const current = [...locks.values()].filter((lock) => lock.state === 'held' && lock.projectId === projectId);
      if (current.length >= limits.perProject) return { ok: false, code: 'LOCK_LIMIT', limit: limits.perProject, scope: 'project' };
      const mine = current.filter((lock) => holderKey(lock.holder) === holderKey(holder));
      if (mine.length >= limits.perHolder) return { ok: false, code: 'LOCK_LIMIT', limit: limits.perHolder, scope: 'holder' };
      counter += 1;
      const acquired = now();
      const lock = {
        lock_id: 'lk-' + idScope + String(counter).padStart(6, '0'),
        projectId,
        kind,
        target: kind === 'branch' ? { branch: target.branch } : { path: target.path },
        holder: { kind: holder.kind, id: holder.id },
        reason,
        lease_ms: leaseMs,
        acquired_at: new Date(acquired).toISOString(),
        expires_at: new Date(acquired + leaseMs).toISOString(),
        expires_at_ms: acquired + leaseMs,
        renewed_at: null,
        state: 'held',
      };
      locks.set(lock.lock_id, lock);
      emit('lock.acquired', { lock_id: lock.lock_id, project_id: projectId, kind, target: lock.target, holder: lock.holder, reason, lease_ms: leaseMs });
      return { ok: true, lock: describe(lock) };
    },
    /** Renew a lock you hold. Never extends a lock someone else holds, and an expired lock cannot be revived. */
    renew({ projectId, lockId, holder, leaseMs = defaultLeaseMs }) {
      expireDue();
      const lock = locks.get(lockId);
      if (lock === undefined) return { ok: false, code: 'LOCK_NOT_FOUND', lock_id: lockId };
      if (lock.project_id !== undefined) { /* set below */ }
      if (lock.projectId !== projectId) return { ok: false, code: 'LOCK_NOT_FOUND', lock_id: lockId };
      if (lock.state === 'expired') return { ok: false, code: 'LOCK_EXPIRED', lock_id: lockId };
      if (holderKey(lock.holder) !== holderKey(holder)) return { ok: false, code: 'LOCK_NOT_OWNER', holder: lock.holder };
      const renewedAt = now();
      lock.lease_ms = leaseMs;
      lock.expires_at_ms = renewedAt + leaseMs;
      lock.expires_at = new Date(lock.expires_at_ms).toISOString();
      lock.renewed_at = new Date(renewedAt).toISOString();
      emit('lock.renewed', { lock_id: lock.lock_id, project_id: projectId, holder: lock.holder, expires_at: lock.expires_at });
      return { ok: true, lock: describe(lock) };
    },
    /** Release your own lock. */
    release({ projectId, lockId, holder }) {
      expireDue();
      const lock = locks.get(lockId);
      if (lock === undefined || lock.projectId !== projectId) return { ok: false, code: 'LOCK_NOT_FOUND', lock_id: lockId };
      if (lock.state === 'expired') return { ok: false, code: 'LOCK_EXPIRED', lock_id: lockId };
      if (holderKey(lock.holder) !== holderKey(holder)) return { ok: false, code: 'LOCK_NOT_OWNER', holder: lock.holder };
      lock.state = 'released';
      emit('lock.released', { lock_id: lock.lock_id, project_id: projectId, holder: lock.holder });
      return { ok: true };
    },
    /** Owner-only force release; a reason is mandatory and is recorded with the decision. */
    forceRelease({ projectId, lockId, actor, actorRole, reason }) {
      expireDue();
      const lock = locks.get(lockId);
      if (lock === undefined || lock.projectId !== projectId) return { ok: false, code: 'LOCK_NOT_FOUND', lock_id: lockId };
      if (actorRole !== 'owner') return { ok: false, code: 'LOCK_FORCE_DENIED', required_role: 'owner', actor_role: actorRole };
      if (typeof reason !== 'string' || reason.trim() === '') return { ok: false, code: 'LOCK_FORCE_DENIED', required: 'reason' };
      const wasHolder = { ...lock.holder };
      lock.state = 'force_released';
      emit('lock.force_released', { lock_id: lock.lock_id, project_id: projectId, holder: wasHolder, actor, reason: reason.trim() });
      return { ok: true, previous_holder: wasHolder };
    },
    /** Locks a reader should show for a project (live ones only; expired ones are history). */
    list({ projectId }) {
      expireDue();
      return [...locks.values()]
        .filter((lock) => lock.projectId === projectId && lock.state === 'held')
        .map((lock) => describe(lock));
    },
    /** Would a write to this branch / these paths collide with someone else's claim? Used by the merge preflight (搂2.3). */
    conflicts({ projectId, branch = null, paths = [] }) {
      expireDue();
      const result = [];
      for (const lock of locks.values()) {
        if (lock.projectId !== projectId || lock.state !== 'held') continue;
        const branchHit = branch !== null && lock.kind === 'branch' && lock.target.branch === branch;
        const pathHit = lock.kind === 'file' && paths.includes(lock.target.path);
        if (branchHit || pathHit) result.push({ lock_id: lock.lock_id, kind: lock.kind, target: lock.target, holder: lock.holder, expires_at: lock.expires_at });
      }
      return result;
    },
    expiresAt({ lockId }) {
      const lock = locks.get(lockId);
      return lock === undefined ? null : lock.expires_at;
    },
    /**
     * Serialisable copy of every lock the module still records (held, expired and released alike).
     *
     * Used for cross-relay merge and restart persistence: the internal record uses `projectId` and
     * `expires_at_ms`, while the wire shape names `project_id` like every other project object.
     */
    snapshot() {
      return [...locks.values()]
        .map((lock) => ({
          lock_id: lock.lock_id,
          project_id: lock.projectId,
          kind: lock.kind,
          target: { ...lock.target },
          mode: 'exclusive',
          holder: { ...lock.holder },
          reason: lock.reason ?? null,
          lease_ms: lock.lease_ms,
          acquired_at: lock.acquired_at,
          expires_at: lock.expires_at,
          expires_at_ms: lock.expires_at_ms,
          renewed_at: lock.renewed_at ?? null,
          state: lock.state,
        }))
        .sort((left, right) => (left.lock_id < right.lock_id ? -1 : left.lock_id > right.lock_id ? 1 : 0));
    },
    /**
     * Replace the whole lock table with rows produced by `snapshot()` (or a deterministic merge of
     * several snapshots). Malformed rows are skipped rather than throwing: a peer's bad record must
     * not take the local lock table down.
     */
    restore(rows) {
      if (!Array.isArray(rows)) return { ok: false, code: 'BAD_SNAPSHOT' };
      const rebuilt = new Map();
      let skipped = 0;
      let maxCounter = counter;
      for (const row of rows) {
        const lock = normalizeLockRow(row);
        if (lock === null) { skipped += 1; continue; }
        rebuilt.set(lock.lock_id, lock);
        maxCounter = Math.max(maxCounter, idCounter(lock.lock_id));
      }
      locks.clear();
      for (const [lockId, lock] of rebuilt) locks.set(lockId, lock);
      counter = maxCounter;
      seq = Math.max(seq, rebuilt.size);
      return { ok: true, restored: rebuilt.size, skipped };
    },
    size() { return { held: [...locks.values()].filter((lock) => lock.state === 'held').length, recorded: locks.size, events: seq }; },
  };
}



