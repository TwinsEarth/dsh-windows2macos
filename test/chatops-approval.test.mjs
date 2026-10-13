/**
 * The approval broker (v0.7.0).
 *
 * The property this file exists to protect is **the bridge never takes a decision
 * away from the host.** That is the failure `dsh-chatops` 0.1.0 shipped, and it is
 * invisible from the outside: every call still returns, the plugin logs nothing
 * unusual, and the only symptom is that approvals stop being answered by the GUI
 * that used to answer them. Load order decides whether it happens, so it can pass
 * every test on one machine and break on the next.
 *
 * So the tests are grouped around the four ways a bridge can wrongly take a
 * decision, rather than around "the operator pressed approve":
 *
 *   * **declining is silent and synchronous** -- no bound window, disabled push, a
 *     backlog, an aborted request and a disposed broker must all leave the host's
 *     answerers to answer, without a promise ever having been created;
 *   * **a deadline delegates** -- the bridge's own timeout must not become a denial,
 *     because a phone that did not answer is not an operator who said no;
 *   * **decisions are bound to the request they answer** -- concurrent requests in
 *     one window each keep their own identity, an id answers once, and an unknown id
 *     is a refusal rather than a cheerful success;
 *   * **nothing outlives the broker** -- a disposed bridge leaves no timer that can
 *     resolve a promise belonging to a fiber that no longer exists.
 *
 * The clock and the id source are injected, so none of this waits on real time and
 * every id collision test is exact rather than probabilistic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalBroker, OUTCOMES, RESOLUTION } from '../src/chatops/approval-broker.mjs';

const T0 = Date.parse('2026-10-14T00:00:00Z');

/**
 * A broker whose clock *and* timers we control, a counting id source, and a
 * delegate that records whether it was called. `delegateCalls` is the single most
 * important observable in this file: if it is non-zero when it should be zero, the
 * bridge took a decision it had no right to take.
 *
 * The timer is faked alongside the clock deliberately. Injecting a clock while
 * leaving `setTimeout` real gives two clocks, and a test that advances the one it
 * owns then awaits a promise driven by the other hangs rather than failing — which
 * is exactly what happened the first time this suite was run.
 */
function harness({ timeoutMs = 300_000, delegateOutcome = 'allowed-once', ids } = {}) {
  let now = T0;
  let n = 0;
  const events = [];
  const delegateCalls = [];
  let nextId = ids ? [...ids] : null;
  const timers = new Map();
  let timerSeq = 0;

  const broker = createApprovalBroker({
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = ++timerSeq;
      timers.set(handle, { due: now + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    mintId: () => (nextId ? nextId.shift() : `appr-${String(++n).padStart(4, '0')}`),
    audit: (event, detail) => events.push({ event, ...detail }),
    defaultTimeoutMs: timeoutMs,
  });

  const delegate = () => {
    delegateCalls.push(now);
    return Promise.resolve(delegateOutcome);
  };

  return {
    broker,
    events,
    delegate,
    delegateCalls,
    /**
     * Move the clock only, leaving queued timers queued.
     *
     * This is the window a real event loop has and a naive fake clock does not: a
     * record's deadline can pass while its timer callback is still waiting its turn.
     * Tests that need `expired` rather than `delegated` have to be able to stand in
     * that window, or the guard is untestable.
     */
    lapse(ms) {
      now += ms;
    },
    /** Fire every timer that has come due. */
    async fire() {
      const due = [...timers.entries()].filter(([, t]) => t.due <= now);
      for (const [handle, timer] of due) {
        if (!timers.has(handle)) continue;
        timers.delete(handle);
        timer.fn();
      }
      await flush();
    },
    /**
     * Move the clock, then fire the timers that came due.
     *
     * The firing happens *after* the await, not inside `advance`, because that is
     * what a real event loop does.
     */
    async advance(ms) {
      now += ms;
      await flush();
      await this.fire();
    },
    /** How many timers are still armed. The leak assertions read this. */
    get armed() {
      return timers.size;
    },
    get now() {
      return now;
    },
  };
}

/** A minimal request as the host emits it. */
function request(over = {}) {
  return { agent: { id: 'sess-1' }, toolName: 'bash', callId: 'call-1', reason: 'rm -rf ./tmp', ...over };
}

/** Let queued microtasks run, so a settled record is observable. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('declining leaves the decision to the host', () => {
  it('claims nothing when no window is bound to the session', () => {
    const h = harness();
    const result = h.broker.offer({ request: request(), windowKey: null, delegate: h.delegate });
    assert.equal(result.claim, false);
    assert.equal(result.reason, 'no_window');
    // The two assertions that matter: no shadow decision exists, and the host's
    // answerers were not touched. A bridge that "declines" by returning a promise
    // that later resolves has still answered.
    assert.equal(h.broker.size, 0);
    assert.deepEqual(h.delegateCalls, []);
  });

  it('claims nothing for an empty-string window, which is how a missing binding often arrives', () => {
    const h = harness();
    const result = h.broker.offer({ request: request(), windowKey: '', delegate: h.delegate });
    assert.equal(result.claim, false);
    assert.equal(result.reason, 'no_window');
    assert.equal(h.broker.size, 0);
  });

  it('claims nothing for a request whose signal is already aborted', () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = h.broker.offer({
      request: request({ signal: controller.signal }),
      windowKey: 'user:me',
      delegate: h.delegate,
    });
    assert.equal(result.claim, false);
    assert.equal(result.reason, 'aborted');
    assert.equal(h.broker.size, 0);
  });

  it('refuses rather than queueing without bound, so one flooding session cannot park approvals forever', () => {
    const h = harness();
    for (let i = 0; i < 4; i += 1) {
      const r = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
      assert.equal(r.claim, true);
    }
    const overflow = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    assert.equal(overflow.claim, false);
    assert.equal(overflow.reason, 'backlog');
    assert.equal(h.broker.size, 4);
    assert.equal(
      h.events.filter((e) => e.event === 'approval/refused-backlog').length,
      1,
      'a refusal has to be audited, or a silently unanswered approval looks like a hang',
    );
  });

  it('claims nothing once disposed, so a reloaded fiber cannot answer for the old one', () => {
    const h = harness();
    h.broker.dispose();
    const result = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    assert.equal(result.claim, false);
    assert.equal(result.reason, 'disposed');
  });

  it('refuses to be constructed wrong rather than silently dropping the host answerers', () => {
    const h = harness();
    assert.throws(
      () => h.broker.offer({ request: request(), windowKey: 'user:me' }),
      /requires a delegate/,
      'without a delegate there is no way to reach the answerers behind us; failing loudly beats claiming',
    );
  });
});

describe('a deadline delegates instead of denying', () => {
  it('returns what the host decided, not a denial of its own', async () => {
    const h = harness({ timeoutMs: 1000, delegateOutcome: 'allowed-once' });
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    await h.advance(1001);
    await flush();
    // The whole point: the phone was silent, and the operation is still allowed,
    // because the answerers behind the bridge said so.
    assert.equal(await promise, 'allowed-once');
    assert.equal(h.delegateCalls.length, 1);
    assert.equal(h.broker.size, 0);
  });

  it('carries a host denial through unchanged', async () => {
    const h = harness({ timeoutMs: 1000, delegateOutcome: 'rejected' });
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    await h.advance(1001);
    await flush();
    assert.equal(await promise, 'rejected');
  });

  it('reports a delegate that throws as unavailable, never as a grant', async () => {
    const h = harness();
    const failing = () => Promise.reject(new Error('no answerers left'));
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: failing });
    await h.advance(300_001);
    await flush();
    assert.equal(
      await promise,
      'unavailable',
      'a broken chain must fail closed; defaulting to a grant would turn an outage into a permission',
    );
  });

  it('normalises an outcome outside the host vocabulary rather than passing it on', async () => {
    const h = harness({ delegateOutcome: 'sure-why-not' });
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    await h.advance(300_001);
    await flush();
    assert.equal(await promise, 'unavailable');
    assert.ok(OUTCOMES.includes(await promise));
  });

  it('records the delegation as a delegation, so a report can tell silence from refusal', async () => {
    const h = harness();
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    await h.advance(300_001);
    await flush();
    await promise;
    const settled = h.events.find((e) => e.event === 'approval/delegated');
    assert.ok(settled, 'delegation must be audited');
    assert.equal(settled.resolution, RESOLUTION.DELEGATED);
    assert.equal(settled.waited_ms, 300_001);
  });
});

describe('a decision is bound to the request it answers', () => {
  it('keeps concurrent requests in one window apart, so neither is orphaned', async () => {
    const h = harness({ ids: ['appr-aaa', 'appr-bbb'] });
    const first = h.broker.offer({ request: request({ callId: 'call-A' }), windowKey: 'user:me', delegate: h.delegate });
    const second = h.broker.offer({ request: request({ callId: 'call-B' }), windowKey: 'user:me', delegate: h.delegate });
    assert.equal(first.claim, true);
    assert.equal(second.claim, true);
    assert.equal(h.broker.size, 2, 'the 0.1.0 map keyed by window held one and lost the other');

    assert.deepEqual(h.broker.decide('appr-aaa', 'allowed-once'), { ok: true });
    assert.equal(await first.promise, 'allowed-once');

    // The second is still answerable — that is the whole difference from a
    // window-keyed map, where deciding one silently resolved the other.
    assert.equal(h.broker.size, 1);
    assert.deepEqual(h.broker.decide('appr-bbb', 'rejected'), { ok: true });
    assert.equal(await second.promise, 'rejected');
    assert.deepEqual(h.delegateCalls, [], 'neither request needed the host');
  });

  it('exposes the pending queue oldest-first, so /approve has an unambiguous target', async () => {
    const h = harness({ ids: ['appr-1', 'appr-2'] });
    h.broker.offer({ request: request({ toolName: 'bash' }), windowKey: 'user:me', delegate: h.delegate });
    await h.advance(50);
    h.broker.offer({ request: request({ toolName: 'write' }), windowKey: 'user:me', delegate: h.delegate });

    assert.equal(h.broker.oldestFor('user:me').tool, 'bash');
    assert.deepEqual(
      h.broker.listFor('user:me').map((p) => p.tool),
      ['bash', 'write'],
    );
    assert.equal(h.broker.oldestFor('user:other'), null);
  });

  it('answers an id once; a second decision is refused by name', async () => {
    const h = harness({ ids: ['appr-once'] });
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    assert.deepEqual(h.broker.decide('appr-once', 'allowed-once'), { ok: true });
    assert.deepEqual(h.broker.decide('appr-once', 'rejected'), { ok: false, reason: 'unknown_or_settled' });
    assert.equal(await promise, 'allowed-once', 'the first decision stands; a replay must not flip it');
  });

  it('refuses an unknown id instead of reporting success', () => {
    const h = harness();
    assert.deepEqual(h.broker.decide('appr-never-existed', 'allowed-once'), { ok: false, reason: 'unknown_or_settled' });
  });

  it('refuses outcomes the host reserves for itself', () => {
    const h = harness({ ids: ['appr-x'] });
    h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    // `cancelled` and `unavailable` describe an absent decision. Letting an operator
    // "choose" them would let the bridge report its own failure as their intent.
    assert.deepEqual(h.broker.decide('appr-x', 'cancelled'), { ok: false, reason: 'bad_outcome' });
    assert.deepEqual(h.broker.decide('appr-x', 'unavailable'), { ok: false, reason: 'bad_outcome' });
    assert.equal(h.broker.size, 1, 'a refused decision must leave the request answerable');
  });

  it('refuses a decision made after the deadline, so a late answer cannot authorise work', async () => {
    const h = harness({ timeoutMs: 1000, ids: ['appr-late'], delegateOutcome: 'rejected' });
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });

    // Stand in the window a real event loop has: the deadline has passed but the
    // timer callback has not run yet. An answer arriving here is stale, and stale
    // must not authorise work.
    h.lapse(1001);
    assert.deepEqual(h.broker.decide('appr-late', 'allowed-once'), { ok: false, reason: 'expired' });
    assert.equal(h.broker.size, 1, 'a refused stale decision must leave the record for the host to decide');

    // Now let the deadline run. The host decides, and its answer stands.
    await h.fire();
    assert.equal(await promise, 'rejected', 'the host had already decided; IM must not overturn it');
    assert.deepEqual(h.delegateCalls, [h.now], 'a stale window consults the host exactly once');
  });

  it('answers a request that is still inside its deadline', async () => {
    const h = harness({ timeoutMs: 1000, ids: ['appr-intime'] });
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    h.lapse(999);
    assert.deepEqual(h.broker.decide('appr-intime', 'allowed-once'), { ok: true });
    assert.equal(await promise, 'allowed-once');
    assert.deepEqual(h.delegateCalls, [], 'an answered request never reaches the host');
  });

  it('mints ids with the entropy the host holds them for', () => {
    // 0.1.0 used `randomUUID().slice(0, 8)` -- 32 bits, held for up to five minutes.
    const broker = createApprovalBroker();
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const { id } = broker.offer({ request: request(), windowKey: 'user:me', delegate: () => Promise.resolve('rejected') });
      assert.ok(id.length >= 32, `id ${id} is shorter than the host's own decision window warrants`);
      assert.ok(!seen.has(id), 'ids must not repeat');
      seen.add(id);
      broker.decide(id, 'rejected');
    }
  });
});

describe('nothing outlives the broker', () => {
  it('cancels on abort, so a withdrawn request is not left waiting on a phone', async () => {
    const h = harness({ ids: ['appr-abort'] });
    const controller = new AbortController();
    const { promise } = h.broker.offer({
      request: request({ signal: controller.signal }),
      windowKey: 'user:me',
      delegate: h.delegate,
    });
    controller.abort();
    assert.equal(await promise, 'cancelled');
    assert.equal(h.broker.size, 0);
    assert.equal(h.events.at(-1).resolution, RESOLUTION.CANCELLED);
  });

  it('settles every pending request when disposed, and stops accepting new ones', async () => {
    const h = harness({ ids: ['appr-p1', 'appr-p2'] });
    const a = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    const b = h.broker.offer({ request: request(), windowKey: 'user:other', delegate: h.delegate });
    const result = h.broker.dispose();
    assert.equal(result.delegated, 2);
    assert.equal(await a.promise, 'unavailable');
    assert.equal(await b.promise, 'unavailable');
    assert.equal(h.broker.size, 0);
    assert.equal(h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate }).claim, false);
  });

  it('is idempotent, so a disposer that runs twice cannot double-settle', () => {
    const h = harness({ ids: ['appr-one'] });
    h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    assert.equal(h.broker.dispose().delegated, 1);
    assert.equal(h.broker.dispose().delegated, 0);
  });

  it('never fires a deadline after the request was already decided', async () => {
    const h = harness({ timeoutMs: 1000, ids: ['appr-quiet'] });
    const { promise } = h.broker.offer({ request: request(), windowKey: 'user:me', delegate: h.delegate });
    h.broker.decide('appr-quiet', 'allowed-once');
    await h.advance(5000);
    await flush();
    assert.equal(await promise, 'allowed-once');
    assert.deepEqual(h.delegateCalls, [], 'a decided request must not also consult the host');
    assert.equal(
      h.events.filter((e) => e.event === 'approval/decided').length,
      1,
      'exactly one terminal audit line per request',
    );
  });

  it('settles each request exactly once even when abort, deadline and decision race', async () => {
    const h = harness({ timeoutMs: 500, ids: ['appr-race'], delegateOutcome: 'rejected' });
    const controller = new AbortController();
    const { promise } = h.broker.offer({
      request: request({ signal: controller.signal }),
      windowKey: 'user:me',
      delegate: h.delegate,
    });
    h.broker.decide('appr-race', 'allowed-once');
    controller.abort();
    await h.advance(600);
    await flush();
    assert.equal(await promise, 'allowed-once');
    const terminal = h.events.filter((e) => e.event === 'approval/decided' || e.event === 'approval/delegated');
    assert.equal(terminal.length, 1, `one terminal event per request, got ${JSON.stringify(terminal)}`);
  });
});
