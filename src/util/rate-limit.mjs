/**
 * A per-key sliding-window rate limiter, shared by the relay and the agent.
 *
 * ## Why this moved here
 *
 * It was written inside `src/relay/server.mjs` for pairing, and it does not use anything from the relay — it
 * holds a `Map` and reads a clock. When the approval gate needed the same window, importing it from `relay`
 * made an **`agent` module depend on the `relay` layer**, which `scripts/layer-model.mjs` refused:
 *
 *   ALLOWED_EDGES: plugin→agent, plugin→util, plugin→relay, relay→chatops, agent→shared, relay→shared
 *
 * The checker was right, and the interesting part is what the right fix turned out to be. Adding
 * `['agent', 'relay']` would have legalised an inversion — `agent` is rank 2 and `relay` is rank 3, so that
 * edge points *up*. Moving the class down to `util` (rank 0, a leaf) lets both layers depend on it in the
 * only direction the model allows, and **cost nothing at runtime**: measured, the relay's own construction
 * site already passed `limit` explicitly, so the defaults here had never been used.
 *
 * ## Why the limit has no default
 *
 * It used to default to `DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE`. Keeping that would mean this leaf importing a
 * relay constant, which is the same inversion one level down. It is now required, and the two callers state
 * their own numbers — which is the honest arrangement, because pairing and raising approvals are limited for
 * **different reasons** and should not share a figure by inheritance.
 */

/** One minute, the window both current callers use. Named here because it is a unit, not a policy. */
export const DEFAULT_WINDOW_MS = 60_000;

/**
 * Per-key sliding window.
 *
 * A key is whatever the caller decides identifies a budget — an address, an account, a machine. This class
 * does not care which, deliberately: an address-keyed limit and an identity-keyed limit are different
 * policies, and a limiter that assumed one would make the other awkward.
 */
export class SlidingWindowRateLimiter {
  /**
   * @param {{limit: number, windowMs?: number, now?: () => number}} options
   *   `limit` is required. `limit <= 0` disables the limiter, which is a supported configuration and is why
   *   the check is `<= 0` rather than a truthiness test.
   */
  constructor({ limit, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    if (!Number.isFinite(limit)) {
      // Refused rather than defaulted. A limiter that silently picks its own figure is a policy nobody wrote,
      // and the two callers want opposite orders of magnitude (5 for pairing, 30 for approvals).
      throw new TypeError('SlidingWindowRateLimiter needs a numeric `limit`; the two callers want different ones and neither should be inherited');
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this._now = now;
    /** @type {Map<string, number[]>} */
    this.buckets = new Map();
  }

  get windowSeconds() {
    return Math.round(this.windowMs / 1000);
  }

  /** Records one attempt and reports whether it is allowed. */
  hit(key) {
    if (this.limit <= 0) {
      return { allowed: true, retry_after_seconds: 0, limit: 0, window_seconds: this.windowSeconds, remaining: Infinity };
    }
    const now = this._now();
    const cutoff = now - this.windowMs;
    let hits = this.buckets.get(key);
    if (!hits) {
      hits = [];
      this.buckets.set(key, hits);
    }
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();

    if (hits.length >= this.limit) {
      const retryMs = hits[0] + this.windowMs - now;
      return {
        allowed: false,
        retry_after_seconds: Math.max(1, Math.ceil(retryMs / 1000)),
        limit: this.limit,
        window_seconds: this.windowSeconds,
        remaining: 0,
      };
    }
    hits.push(now);
    return {
      allowed: true,
      retry_after_seconds: 0,
      limit: this.limit,
      window_seconds: this.windowSeconds,
      remaining: this.limit - hits.length,
    };
  }

  /** Drop idle buckets so a long-running process cannot leak memory. */
  prune() {
    const cutoff = this._now() - this.windowMs;
    for (const [key, hits] of this.buckets) {
      while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
      if (hits.length === 0) this.buckets.delete(key);
    }
  }

  reset() {
    this.buckets.clear();
  }
}
