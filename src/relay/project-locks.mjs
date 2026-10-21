/**
 * Project locks (M5, v1.3.10-beta.15 slice).
 *
 * Two coordination primitives, one module: an exclusive branch lock and an exclusive file lock. They exist so two clients
 * disagree about *who is editing what* before they disagree about merge conflicts, and so a crashed client's claim expires
 * instead of blocking the project forever.
 *
 * Rules (docs/COLLAB/M5-MULTI-CLIENT-PRIMITIVES.md §2):
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

export function createProjectLocks({ now = () => Date.now(), defaultLeaseMs = DEFAULT_LOCK_LEASE_MS, limits = DEFAULT_LOCK_LIMITS, onEvent = null } = {}) {
  const locks = new Map(); // lock_id -> lock
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
        lock_id: 'lk-' + String(counter).padStart(6, '0'),
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
    /** Would a write to this branch / these paths collide with someone else's claim? Used by the merge preflight (§2.3). */
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
    size() { return { held: [...locks.values()].filter((lock) => lock.state === 'held').length, recorded: locks.size, events: seq }; },
  };
}
