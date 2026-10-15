/**
 * The approval queue's front door — the rate limiter v4.9.0 promised and did not have.
 *
 * ## What was missing
 *
 * `ROADMAP.md` describes v4.9.0 as *"a cross-session pending-approval index …, **with the already-shipped
 * rate limiter as its front door**"*. The index is real and substantial. Measured: **`approval-index.mjs`
 * imports `authority.mjs` and nothing else** — the file contains no limiter, no window, no cooldown — while
 * the shipped `SlidingWindowRateLimiter` sat in `relay/server.mjs` with no approval caller. The front door
 * was a phrase rather than a mechanism, the same defect as v4.8.0's missing authority half.
 *
 * The limiter now lives in `src/util/rate-limit.mjs`. Reaching for it where it was written would have made
 * this `agent` module depend on the `relay` layer -- an upward edge the layer model refuses, correctly -- so
 * the shared piece moved down to `util` instead of the edge being legalised.
 *
 * ## Why the limit is on raising and not on reading or answering
 *
 * The threat is not brute force; it is **queue flooding**. A misbehaving agent in a retry loop can raise
 * hundreds of requests, and the queue's whole purpose is that the work needing attention is visible. So the
 * surface to protect is `register`.
 *
 * Deliberately **not** limited:
 *
 *   * **reading the queue** — limiting the *view* limits *knowing what is waiting*, which is the one thing
 *     the queue exists to provide;
 *   * **settling a request** — a supervisor working through a backlog should be able to clear it, and a
 *     limit there would punish the person fixing the problem.
 *
 * ## Why the key is an identity and not an address
 *
 * A fleet's agents are frequently on one host, so an address-keyed limit would apply one budget to everybody
 * on it — refusing the well-behaved because a neighbour misbehaved, which is the wrong machine to blame. The
 * key is therefore the requester's identity, and an anonymous requester gets its own shared budget rather
 * than none: **an unidentifiable caller must not be the one caller with no limit.**
 *
 * ## Why the default is not the pairing limit
 *
 * `DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE` is **5**: pairing is rare and a wrong guess is an attack. Raising
 * approvals is ordinary work, done in bursts when a machine comes back from being offline. The default here
 * is higher, and the number is stated as a decision rather than inherited from a limiter built for something
 * else.
 */
// `DEFAULT_WINDOW_MS` is deliberately NOT imported: the limiter applies its own default window when the
// caller does not name one, and importing it here only to pass it straight back through would be a second
// place for the same number to live. eslint's no-unused-vars is what surfaced the redundancy.
import { SlidingWindowRateLimiter } from '../util/rate-limit.mjs';

/** Raising approvals is ordinary work; pairing is not. The two do not share a number. */
export const DEFAULT_RAISE_LIMIT_PER_MINUTE = 30;

/** The key used for a caller that did not say who it is. Named so it cannot collide with a real identity. */
export const ANONYMOUS_KEY = 'anonymous';

/** Why a raise was refused. */
export const GATE_REFUSAL = Object.freeze({
  RATE_LIMITED: 'APPROVAL_RAISE_RATE_LIMITED',
});

/**
 * The front door to an approval index.
 *
 * Composes the shipped limiter rather than reimplementing a window — the promise in the roadmap was that the
 * *already-shipped* limiter would be this, and two sliding windows in one codebase is two chances to disagree
 * about what a minute is.
 *
 * @param {{limit?: number, windowMs?: number, now?: () => number}} [options]
 */
export function createApprovalGate(options = {}) {
  const limiter = new SlidingWindowRateLimiter({
    limit: Number.isFinite(options.limit) ? options.limit : DEFAULT_RAISE_LIMIT_PER_MINUTE,
    ...(Number.isFinite(options.windowMs) ? { windowMs: options.windowMs } : {}),
    ...(typeof options.now === 'function' ? { now: options.now } : {}),
  });

  /**
   * Whether one more request may be raised by this requester.
   *
   * @param {{id?: string|null, level?: number|null}} requester
   * @returns {{allowed: boolean, reason_code: string|null, retry_after_seconds: number, detail: string}}
   */
  function mayRaise(requester) {
    const id = typeof requester?.id === 'string' && requester.id.trim() !== '' ? requester.id.trim() : ANONYMOUS_KEY;
    const verdict = limiter.hit(id);
    if (verdict.allowed) {
      return {
        allowed: true,
        reason_code: null,
        retry_after_seconds: 0,
        detail: id === ANONYMOUS_KEY
          ? `raised under the shared anonymous budget (${verdict.remaining} left in this window)`
          : `${id} may raise (${verdict.remaining} left in this window)`,
      };
    }
    return {
      allowed: false,
      reason_code: GATE_REFUSAL.RATE_LIMITED,
      retry_after_seconds: verdict.retry_after_seconds,
      detail:
        `${id} has raised ${verdict.limit} request(s) in the last ${limiter.windowSeconds}s; ` +
        `wait ${verdict.retry_after_seconds}s. The queue is not cleared -- existing requests are untouched and still answerable.`,
    };
  }

  /** How much of this requester's budget is left, without spending any of it. */
  function budgetFor(requester) {
    const id = typeof requester?.id === 'string' && requester.id.trim() !== '' ? requester.id.trim() : ANONYMOUS_KEY;
    const hits = limiter.buckets.get(id) ?? [];
    return { key: id, limit: limiter.limit, window_seconds: limiter.windowSeconds, used: hits.length, remaining: Math.max(0, limiter.limit - hits.length) };
  }

  return { mayRaise, budgetFor, limiter, raiseLimitPerMinute: limiter.limit, windowSeconds: limiter.windowSeconds };
}
