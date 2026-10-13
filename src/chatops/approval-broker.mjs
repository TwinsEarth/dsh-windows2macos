/**
 * The approval broker (v0.7.0).
 *
 * ## The defect this file exists to make impossible
 *
 * A chat bridge that wants to answer approvals from a phone joins the
 * `approval/request` **waterfall**. The contract, as this host documents it, is:
 *
 *     'approval/request'(this, req, next: () => Promise<ApprovalOutcome>)
 *       -> "Return an outcome to claim the request or call `next()` to delegate."
 *
 * `dsh-chatops` 0.1.0 registers `(req) => this.onApprovalRequest(req)` and **never
 * calls `next()`** — the identifier does not appear in its source at all. Because a
 * waterfall consults the next listener only when the current one calls `next()`, a
 * listener that returns without delegating removes every answerer registered after
 * it from the decision. In that plugin the listener is also `async`, so the *first*
 * thing it hands back is a Promise, and the harness treats any non-`undefined`
 * value as the final answer. Measured consequence: approvals for sessions that have
 * a bound IM window are held until the plugin's own timer expires, and the host's
 * GUI answerer is never asked. Whether that happens at all depends on listener
 * registration order, which the plugin does nothing to control.
 *
 * Two properties make the correct version look different from the obvious one:
 *
 *   1. **Declining must be synchronous.** If the bridge has nothing to ask (no bound
 *      window, push disabled), it must return `undefined` *without* having touched
 *      `next`, so the waterfall proceeds normally. Awaiting anything first — even a
 *      resolved promise — hands a Promise to the harness and claims the request.
 *   2. **A timeout must delegate, not decide.** A bridge that answers "no decision"
 *      after its own deadline has still answered. The host is entitled to a real
 *      outcome, so the deadline calls `next()` and lets the answerers behind it
 *      decide. This is the difference between "the phone did not answer" and
 *      "the request was denied".
 *
 * ## Why the state is keyed the way it is
 *
 * Pending approvals are keyed by **approval id**, and each window keeps a queue of
 * ids. The 0.1.0 code used a single `Map<windowKey, PendingApproval>`, so a second
 * concurrent request in one window overwrote the first: the older request became
 * unanswerable from IM and was reclaimed only by its timer, while `/approve` always
 * resolved the newer one. Keying by id and queueing per window makes that state
 * unrepresentable rather than merely unlikely.
 *
 * Ids carry full entropy. 0.1.0 minted `randomUUID().slice(0, 8)` — 32 bits — which
 * its own core then held for up to five minutes. Nothing here is guessable.
 *
 * ## What this module deliberately is not
 *
 * It is not an answerer and it does not touch Cordis. It is a pure state machine
 * with injected clock, timer and id source, so every property above is testable
 * without a host, a phone, or a five-minute wait. The wiring — one listener, four
 * lines — lives in the transport layer and can be read at a glance.
 *
 * The timer is injectable for a reason that cost a hanging test run to learn: an
 * injected *clock* with a real `setTimeout` is two clocks, and a test that advances
 * the one it controls then waits on the other hangs forever. Anything that reads
 * time here — `now`, `setTimer`, `clearTimer` — comes from the same place.
 */

/** Outcomes the host's approval service can accept. Mirrors `ApprovalOutcome`. */
export const OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/**
 * Why a pending request stopped being answerable. Reported, never thrown: an
 * approval that nobody answered is a normal event, not an error.
 */
export const RESOLUTION = Object.freeze({
  /** The operator answered from IM. */
  OPERATOR: 'operator',
  /** The deadline passed and the request was delegated to the answerers behind us. */
  DELEGATED: 'delegated',
  /** The host withdrew the request (`signal` aborted) before anyone answered. */
  CANCELLED: 'cancelled',
  /** The bridge was disposed, or the broker shut down. */
  DISPOSED: 'disposed',
});

/**
 * A decision is only ever one of these two. The host's `ApprovalOutcome` includes
 * `'cancelled'` and `'unavailable'`, but those describe *why a decision is absent*
 * — they are produced by the host, not claimed by an answerer. Accepting them from
 * an operator would let a bridge report its own failure as the operator's choice.
 */
const OPERATOR_OUTCOMES = new Set(['allowed-once', 'rejected']);

/**
 * Create a broker.
 *
 * @param {object} options
 * @param {() => number} [options.now] Injected clock, for tests and for a host that virtualises time.
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer] Injected timer. Must pair with `now`.
 * @param {(handle: unknown) => void} [options.clearTimer] Cancels a `setTimer` handle.
 * @param {() => string} [options.mintId] Injected id source. Must be unguessable.
 * @param {(event: string, detail?: object) => void} [options.audit] Called on every state change.
 * @param {number} [options.defaultTimeoutMs] Deadline for a request nobody answers.
 * @param {number} [options.maxPendingPerWindow] Refuse rather than queue without bound.
 */
export function createApprovalBroker(options = {}) {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const mintId = options.mintId ?? (() => globalThis.crypto.randomUUID());
  const audit = options.audit ?? (() => {});
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
  const maxPendingPerWindow = options.maxPendingPerWindow ?? 4;

  /** approvalId -> pending record. */
  const pending = new Map();
  /** windowKey -> approvalId[], oldest first. The queue is the fix for the overwrite bug. */
  const byWindow = new Map();
  let disposed = false;

  function queueFor(windowKey) {
    let q = byWindow.get(windowKey);
    if (!q) {
      q = [];
      byWindow.set(windowKey, q);
    }
    return q;
  }

  function unlink(windowKey, approvalId) {
    const q = byWindow.get(windowKey);
    if (!q) return;
    const i = q.indexOf(approvalId);
    if (i !== -1) q.splice(i, 1);
    if (q.length === 0) byWindow.delete(windowKey);
  }

  /** Settle one record exactly once. Every path out of `pending` goes through here. */
  function settle(record, outcome, resolution) {
    if (record.settled) return;
    record.settled = true;
    if (record.timer !== null) clearTimer(record.timer);
    if (record.onAbort && record.signal) record.signal.removeEventListener('abort', record.onAbort);
    pending.delete(record.id);
    unlink(record.windowKey, record.id);
    audit(resolution === RESOLUTION.OPERATOR ? 'approval/decided' : 'approval/delegated', {
      approval_id: record.id,
      window: record.windowKey,
      tool: record.toolName,
      outcome,
      resolution,
      waited_ms: now() - record.openedAt,
    });
    record.resolve(outcome);
  }

  /**
   * Offer a request to the bridge.
   *
   * Returns a discriminated result rather than an outcome, because "I will not
   * answer this" and "the answer is no" are different things to the caller and the
   * host. `claim: false` means the caller must return `undefined` **without having
   * called `next`**; `claim: true` means the caller owns the outcome and `promise`
   * settles exactly once.
   *
   * @param {object} input
   * @param {{agent?: {id?: string}, toolName?: string, callId?: string, reason?: string, signal?: AbortSignal}} input.request
   * @param {string|null} input.windowKey The IM window bound to this request's session, or null.
   * @param {number} [input.timeoutMs]
   * @param {() => Promise<string>} input.delegate Calls the answerers registered behind us.
   *        Called at most once, and only when the bridge declines *after* claiming.
   * @returns {{claim: false, reason: string} | {claim: true, id: string, promise: Promise<string>}}
   */
  function offer({ request, windowKey, timeoutMs, delegate }) {
    if (disposed) return { claim: false, reason: 'disposed' };
    if (typeof delegate !== 'function') {
      throw new TypeError('offer() requires a delegate() that calls the answerers behind this one');
    }
    if (request?.signal?.aborted) return { claim: false, reason: 'aborted' };
    // Nothing to ask. Declining here — synchronously, with `next` untouched — is what
    // keeps this plugin from swallowing approvals it has no business answering.
    if (windowKey === null || windowKey === undefined || windowKey === '') {
      return { claim: false, reason: 'no_window' };
    }

    const queue = queueFor(windowKey);
    if (queue.length >= maxPendingPerWindow) {
      audit('approval/refused-backlog', { window: windowKey, depth: queue.length });
      return { claim: false, reason: 'backlog' };
    }

    const id = mintId();
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
    let resolveOutcome;
    const promise = new Promise((resolve) => {
      resolveOutcome = resolve;
    });

    const record = {
      id,
      windowKey,
      toolName: request?.toolName ?? null,
      callId: request?.callId ?? null,
      reason: request?.reason ?? null,
      signal: request?.signal ?? null,
      openedAt: now(),
      deadlineAt: now() + timeout,
      settled: false,
      timer: null,
      onAbort: null,
      resolve: resolveOutcome,
    };

    // Order matters: the record must be reachable by the time the timer or the
    // abort listener can fire, or a zero-length timeout would settle nothing.
    pending.set(id, record);
    queue.push(id);
    audit('approval/asked', {
      approval_id: id,
      window: windowKey,
      tool: record.toolName,
      timeout_ms: timeout,
    });

    record.timer = setTimer(() => {
      // Delegating rather than deciding. The answerers behind us are allowed to
      // allow this; reporting our own silence as a denial would be a lie about what
      // the operator chose, and would deny work the host would have permitted.
      void delegate().then(
        (outcome) => settle(record, normaliseDelegated(outcome), RESOLUTION.DELEGATED),
        () => settle(record, 'unavailable', RESOLUTION.DELEGATED),
      );
    }, timeout);
    if (typeof record.timer?.unref === 'function') record.timer.unref();

    if (record.signal) {
      record.onAbort = () => settle(record, 'cancelled', RESOLUTION.CANCELLED);
      record.signal.addEventListener('abort', record.onAbort, { once: true });
    }

    return { claim: true, id, promise };
  }

  /** The host may return any of its four outcomes; keep it, but never invent one. */
  function normaliseDelegated(outcome) {
    return OUTCOMES.includes(outcome) ? outcome : 'unavailable';
  }

  /**
   * Answer a pending request from IM.
   *
   * @param {string} approvalId
   * @param {'allowed-once'|'rejected'} outcome
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  function decide(approvalId, outcome) {
    if (!OPERATOR_OUTCOMES.has(outcome)) return { ok: false, reason: 'bad_outcome' };
    const record = pending.get(approvalId);
    // Already decided, already delegated, or never ours. The 0.1.0 code answered
    // "✅ approved" on the strength of a promise resolving; here an unknown id is a
    // refusal with a name.
    if (!record) return { ok: false, reason: 'unknown_or_settled' };
    if (now() >= record.deadlineAt) return { ok: false, reason: 'expired' };
    settle(record, outcome, RESOLUTION.OPERATOR);
    return { ok: true };
  }

  /** The oldest request still waiting in a window, or null. `/pending` renders this. */
  function oldestFor(windowKey) {
    const q = byWindow.get(windowKey);
    if (!q || q.length === 0) return null;
    const record = pending.get(q[0]);
    return record ? publicView(record) : null;
  }

  /** Every request still waiting in a window, oldest first. */
  function listFor(windowKey) {
    const q = byWindow.get(windowKey);
    if (!q) return [];
    return q.map((id) => pending.get(id)).filter(Boolean).map(publicView);
  }

  function publicView(record) {
    return {
      approval_id: record.id,
      window: record.windowKey,
      tool: record.toolName,
      reason: record.reason,
      opened_at: record.openedAt,
      deadline_at: record.deadlineAt,
      remaining_ms: Math.max(0, record.deadlineAt - now()),
    };
  }

  /**
   * Delegate everything still pending, then refuse new work.
   *
   * Called from the plugin's disposer. Without this, a reload leaves timers alive
   * that will resolve promises belonging to a fiber that no longer exists — the
   * 0.1.0 code had exactly that leak.
   */
  function dispose() {
    if (disposed) return { delegated: 0 };
    disposed = true;
    let delegated = 0;
    for (const record of [...pending.values()]) {
      delegated += 1;
      // On shutdown there is nobody left to ask, so the host's own answerers must
      // take it. `unavailable` would be an answer; this is not an answer.
      settle(record, 'unavailable', RESOLUTION.DISPOSED);
    }
    byWindow.clear();
    return { delegated };
  }

  return {
    offer,
    decide,
    oldestFor,
    listFor,
    dispose,
    get size() {
      return pending.size;
    },
    /** Exposed for tests and diagnostics only. */
    _internals: { pending, byWindow },
  };
}
