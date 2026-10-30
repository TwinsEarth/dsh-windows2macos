/**
 * PathScheduler: score candidate paths, and switch only on sustained evidence.
 *
 * This is deliberately pure policy: no sockets, no timers beyond the overlap
 * deadline it reports. The caller opens the challenger, keeps the old path for
 * `keepUntilMs` (make-before-break), then closes it.
 */

export const PATH_KIND = Object.freeze({
  IROH_DIRECT: 'iroh-direct',
  UDP_DIRECT: 'udp-direct',
  LIBP2P: 'libp2p',
  IROH_RELAY: 'iroh-relay',
  CONTROL_PLANE: 'control-plane',
});

/** Higher is better. The type weight dominates; latency and loss refine it. */
export const PATH_WEIGHT = Object.freeze({
  [PATH_KIND.IROH_DIRECT]: 5,
  [PATH_KIND.UDP_DIRECT]: 4,
  [PATH_KIND.LIBP2P]: 3,
  [PATH_KIND.IROH_RELAY]: 2,
  [PATH_KIND.CONTROL_PLANE]: 1,
});

export const SCHEDULER_CODE = Object.freeze({
  OK: 'PATH_OK',
  NOT_ENCRYPTED: 'PATH_NOT_ENCRYPTED',
  NO_CANDIDATES: 'PATH_NO_CANDIDATES',
  SWITCH_PENDING: 'PATH_SWITCH_PENDING',
  ALL_FAILED: 'ALL_TRANSPORTS_FAILED',
});

/**
 * @param {{kind: string, encrypted: boolean, firstFrameRttMs: number, lossRate: number}} path
 * @returns {number} score; encrypted paths outrank plaintext by a wide margin
 */
export function scorePath({ kind, encrypted, firstFrameRttMs = 0, lossRate = 0 }) {
  const weight = PATH_WEIGHT[kind] ?? 0;
  if (encrypted !== true) return -1;
  if (!Number.isFinite(weight) || weight <= 0) return -1;
  const rtt = Number.isFinite(firstFrameRttMs) ? Math.max(0, firstFrameRttMs) : 1000;
  const loss = Number.isFinite(lossRate) ? Math.min(1, Math.max(0, lossRate)) : 1;
  return weight * 1000 - rtt - loss * 2000;
}

/**
 * A path switch is allowed only when:
 *   - the challenger is encrypted;
 *   - two consecutive samples beat the current path by > 20%;
 *   - the challenger's kind is at least as preferred as the current one
 *     (no switching down to a relay while a direct path is healthy).
 */
export class PathScheduler {
  constructor({ overlapMs = 5000, improvement = 1.2, requiredSamples = 2, now = Date.now } = {}) {
    this.overlapMs = overlapMs;
    this.improvement = improvement;
    this.requiredSamples = requiredSamples;
    this.now = now;
    this.current = null;
    this.challenger = null;
    this.leading = 0;
    this.lastPlan = null;
  }

  setCurrent(path) {
    this.current = path;
    this.challenger = null;
    this.leading = 0;
    return this.current;
  }

  /** Record one challenger sample; returns a switch plan or null. */
  observe(path) {
    if (path?.encrypted !== true) return null;
    const challengerScore = scorePath(path);
    const currentScore = this.current === null ? Number.NEGATIVE_INFINITY : scorePath(this.current);
    if (currentScore === Number.NEGATIVE_INFINITY) {
      this.current = path;
      return { switch: false, reason: 'first-path', path };
    }
    const sameChallenger = this.challenger !== null && this.challenger.id === path.id;
    if (challengerScore > currentScore * this.improvement) {
      this.challenger = path;
      this.leading = sameChallenger ? this.leading + 1 : 1;
      if (this.leading < this.requiredSamples) return null;
      if ((PATH_WEIGHT[path.kind] ?? 0) < (PATH_WEIGHT[this.current.kind] ?? 0)) return null;
      const plan = { switch: true, from: this.current, to: path, keepUntilMs: this.now() + this.overlapMs, reason: 'better-path' };
      this.lastPlan = plan;
      this.current = path;
      this.challenger = null;
      this.leading = 0;
      return plan;
    }
    this.challenger = path;
    this.leading = 0;
    return null;
  }

  /** Close the loser only after the overlap window has elapsed. */
  breakOld(plan, atMs = this.now()) {
    if (plan?.switch !== true) return { ok: false, code: SCHEDULER_CODE.NOT_ENCRYPTED };
    if (atMs < plan.keepUntilMs) return { ok: false, code: SCHEDULER_CODE.SWITCH_PENDING, closeAtMs: plan.keepUntilMs };
    return { ok: true, close: plan.from };
  }
}
