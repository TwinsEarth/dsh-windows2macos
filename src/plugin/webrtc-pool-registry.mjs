/**
 * One process, one WebRTC pool.
 *
 * `tools/shared.mjs` used to build the pool that `deliver`/`dispatch` use and publish it here.
 * `dsh-teams`, `dsh-desktop`, `dsh-p2p-webrtc` and P2P V2 are separate Cordis rows and cannot see
 * that module's live binding without importing the whole tool surface, so the pool is published
 * through this tiny registry instead.
 *
 * 3.6.0 makes the ownership explicit:
 *
 * - a pool has exactly one **owner** (the row that built it);
 * - a second row **acquires** and borrows the existing pool, and never builds a second one;
 * - readers either call `getSharedWebRtcPool()` at use time or subscribe for late binding.
 *
 * The registry holds a reference, never owns the pool: the owner still stops it. `release()` is
 * the owner's hand-off, not a destructor.
 */

export const WEBRTC_POOL_REGISTRY_CODE = {
  INVALID_POOL: 'WEBRTC_POOL_INVALID',
  OWNER_CONFLICT: 'WEBRTC_POOL_OWNER_CONFLICT',
  BUILD_FAILED: 'WEBRTC_POOL_BUILD_FAILED',
  NO_FACTORY: 'WEBRTC_POOL_NO_FACTORY',
};

function isPool(value) {
  return value !== null && typeof value === 'object' && typeof value.send === 'function';
}

function ownerName(value, fallback = 'legacy') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function detailOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A registry instance. Production uses the singleton exported at the bottom; tests use this
 * factory so one test's pool cannot leak into another test.
 */
export function createWebRtcPoolRegistry() {
  let sharedPool = null;
  let sharedOwner = null;
  let epoch = 0;
  let pendingAcquire = null;
  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();

  function state() {
    return {
      pool: sharedPool,
      owner: sharedOwner,
      ready: sharedPool !== null,
      epoch,
    };
  }

  function notify() {
    const snapshot = state();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A subscriber must not be able to break publication for every other subscriber.
      }
    }
  }

  /**
   * Publish a pool, or clear the registry with `null`.
   *
   * The first publisher owns the pool. A different pool from a second owner is a named refusal
   * rather than a silent replacement: replacing a live pool would strand every peer already using
   * it. Re-publishing the same pool is idempotent and keeps the first owner.
   *
   * `options.owner` is optional for compatibility with the pre-3.6.0 call sites, which all meant
   * "legacy"; new call sites must pass it.
   */
  function set(pool, options = {}) {
    const owner = ownerName(options.owner);
    if (pool === null || pool === undefined) {
      if (sharedPool === null) {
        return { ok: true, cleared: false, owner: sharedOwner };
      }
      const clearingOwner = options.owner === undefined ? 'legacy' : owner;
      if (sharedOwner !== clearingOwner) {
        return {
          ok: false,
          code: WEBRTC_POOL_REGISTRY_CODE.OWNER_CONFLICT,
          detail: `pool is owned by ${JSON.stringify(sharedOwner)}, not ${JSON.stringify(clearingOwner)}`,
          owner: sharedOwner,
          requested_owner: clearingOwner,
        };
      }
      sharedPool = null;
      sharedOwner = null;
      epoch += 1;
      notify();
      return { ok: true, cleared: true, owner: null };
    }

    if (!isPool(pool)) {
      return {
        ok: false,
        code: WEBRTC_POOL_REGISTRY_CODE.INVALID_POOL,
        detail: 'a shared WebRTC pool must be an object with a send() method',
      };
    }

    if (sharedPool === pool) {
      return { ok: true, reused: true, owner: sharedOwner, pool: sharedPool, epoch };
    }

    if (sharedPool !== null) {
      return {
        ok: false,
        code: WEBRTC_POOL_REGISTRY_CODE.OWNER_CONFLICT,
        detail: `pool is already owned by ${JSON.stringify(sharedOwner)}; refusing ${JSON.stringify(owner)}`,
        owner: sharedOwner,
        requested_owner: owner,
      };
    }

    sharedPool = pool;
    sharedOwner = owner;
    epoch += 1;
    notify();
    return { ok: true, reused: false, owner: sharedOwner, pool: sharedPool, epoch };
  }

  function get() {
    return sharedPool;
  }

  /**
   * Acquire the process pool.
   *
   * - If one exists, return it without calling `create` at all. This is the "root w2m reuses the
   *   plugin's pool" path, and it must not construct a second pool on the same machine id.
   * - If none exists, the first caller's `create` runs; concurrent callers share that one promise.
   *
   * `create` may return a pool directly, a `{ ok, pool }` result, or a promise of either.
   * Failures are returned, never thrown, so a Cordis row can report a named reason and stay down.
   */
  function acquire(options = {}) {
    const owner = ownerName(options.owner);
    const create = options.create;
    if (typeof create !== 'function') {
      return Promise.resolve({
        ok: false,
        code: WEBRTC_POOL_REGISTRY_CODE.NO_FACTORY,
        detail: 'acquireSharedWebRtcPool requires a create function',
      });
    }

    if (sharedPool !== null) {
      return Promise.resolve({
        ok: true,
        reused: true,
        pool: sharedPool,
        owner: sharedOwner,
        epoch,
      });
    }

    if (pendingAcquire !== null) return pendingAcquire;

    const promise = (async () => {
      let built;
      try {
        built = await create();
      } catch (error) {
        return {
          ok: false,
          code: WEBRTC_POOL_REGISTRY_CODE.BUILD_FAILED,
          detail: detailOf(error),
          owner,
        };
      }

      if (built !== null && typeof built === 'object' && built.ok === false) {
        return {
          ok: false,
          code: built.code ?? WEBRTC_POOL_REGISTRY_CODE.BUILD_FAILED,
          detail: built.detail ?? 'pool factory returned ok:false',
          owner,
        };
      }

      const candidate = built !== null && typeof built === 'object' && built.ok === true ? built.pool : built;
      const published = set(candidate, { owner });
      if (!published.ok) return published;
      return {
        ok: true,
        reused: published.reused,
        pool: published.pool,
        owner: published.owner,
        epoch: published.epoch,
      };
    })();

    const wrapped = promise.finally(() => {
      if (pendingAcquire === wrapped) pendingAcquire = null;
    });
    pendingAcquire = wrapped;
    return wrapped;
  }

  /**
   * Clear the registry if `owner` still owns `pool`. The caller stops the pool afterwards; the
   * registry never calls `stop()` itself.
   */
  function release(owner, pool) {
    const requested = ownerName(owner);
    if (sharedPool === null) return { ok: true, released: false, owner: null };
    if (sharedOwner !== requested || (pool !== undefined && sharedPool !== pool)) {
      return {
        ok: false,
        code: WEBRTC_POOL_REGISTRY_CODE.OWNER_CONFLICT,
        detail: `pool is owned by ${JSON.stringify(sharedOwner)}, not ${JSON.stringify(requested)}`,
        owner: sharedOwner,
        requested_owner: requested,
      };
    }
    sharedPool = null;
    sharedOwner = null;
    epoch += 1;
    notify();
    return { ok: true, released: true, owner: null };
  }

  /**
   * Late binding. The listener is called immediately with the current snapshot, then on every
   * publish/clear. Returns an unsubscribe function.
   */
  function subscribe(listener, options = {}) {
    if (typeof listener !== 'function') throw new TypeError('subscribeSharedWebRtcPool requires a function');
    listeners.add(listener);
    if (options.immediate !== false) {
      try {
        listener(state());
      } catch {
        // See notify(): a subscriber's failure is its own.
      }
    }
    return () => {
      listeners.delete(listener);
    };
  }

  return { set, get, acquire, release, subscribe, state };
}

const registry = createWebRtcPoolRegistry();

/** @param {object|null} pool */
export function setSharedWebRtcPool(pool, options = {}) {
  return registry.set(pool, options);
}

/** @returns {object|null} */
export function getSharedWebRtcPool() {
  return registry.get();
}

/** @returns {{pool: object|null, owner: string|null, ready: boolean, epoch: number}} */
export function getSharedWebRtcPoolState() {
  return registry.state();
}

/** @returns {Promise<object>} */
export function acquireSharedWebRtcPool(options = {}) {
  return registry.acquire(options);
}

/** @returns {{ok: boolean, released?: boolean, code?: string, detail?: string}} */
export function releaseSharedWebRtcPool(owner, pool) {
  return registry.release(owner, pool);
}

/** @returns {() => void} */
export function subscribeSharedWebRtcPool(listener, options = {}) {
  return registry.subscribe(listener, options);
}
