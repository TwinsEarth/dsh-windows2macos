/**
 * One process, one WebRTC pool.
 *
 * `tools/shared.mjs` owns the pool that `deliver`/`dispatch` use. `dsh-teams` is a separate Cordis
 * row and cannot see that module's live binding without importing the whole tool surface, so the
 * pool is published through this tiny registry instead. The registry holds a reference, never owns
 * the pool: the module that created it still stops it.
 */

let sharedPool = null;

/** @param {object|null} pool */
export function setSharedWebRtcPool(pool) {
  sharedPool = pool !== null && typeof pool === 'object' && typeof pool.send === 'function' ? pool : null;
}

/** @returns {object|null} */
export function getSharedWebRtcPool() {
  return sharedPool;
}
