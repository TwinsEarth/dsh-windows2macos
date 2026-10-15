/**
 * The approval gate: the front door v4.9.0 claimed and did not have.
 *
 * What these protect, said once: the limiter is on **raising** and on nothing else. Two of the three tests
 * below exist to pin what is *not* limited, because that is the half a reader would assume the other way —
 * a gate that also limited reading or answering would pass a test about flooding and quietly break the queue.
 *
 * The window is driven by an injected clock, so these assert behaviour rather than wait for it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SlidingWindowRateLimiter } from '../src/util/rate-limit.mjs';
import {
  ANONYMOUS_KEY,
  DEFAULT_RAISE_LIMIT_PER_MINUTE,
  GATE_REFUSAL,
  createApprovalGate,
} from '../src/agent/approval-gate.mjs';

/** A gate whose clock the test moves. */
function gateAt(limit = 3, windowMs = 60_000) {
  let now = 1_000_000;
  const gate = createApprovalGate({ limit, windowMs, now: () => now });
  return { gate, advance: (ms) => { now += ms; } };
}

describe('approval gate: it composes the shipped limiter rather than inventing a second window', () => {
  it('is built from the exported SlidingWindowRateLimiter', () => {
    // The roadmap's word was "already-shipped". Two sliding windows in one codebase are two chances to
    // disagree about what a minute is, so the composition is asserted rather than described. It is imported
    // from `util`, which is where the class had to move for this `agent` module to be allowed to reach it.
    const { gate } = gateAt();
    assert.ok(gate.limiter instanceof SlidingWindowRateLimiter);
  });

  it('does not inherit the pairing limit, which was built for a different threat', () => {
    // Pairing is 5/min because a wrong guess is an attack. Raising approvals is ordinary work done in bursts,
    // so the two must not share a number by accident.
    const { gate } = gateAt(DEFAULT_RAISE_LIMIT_PER_MINUTE);
    assert.equal(gate.raiseLimitPerMinute, DEFAULT_RAISE_LIMIT_PER_MINUTE);
    assert.ok(DEFAULT_RAISE_LIMIT_PER_MINUTE > 5, 'the pairing default would make ordinary work impossible');
  });
});

describe('approval gate: raising is limited, per identity', () => {
  it('allows up to the limit and then refuses with a retry time', () => {
    const { gate } = gateAt(3);
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(gate.mayRaise({ id: 'agent-a', level: 0 }).allowed, true, `raise ${i}`);
    }
    const refused = gate.mayRaise({ id: 'agent-a', level: 0 });
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason_code, GATE_REFUSAL.RATE_LIMITED);
    assert.ok(refused.retry_after_seconds >= 1);
  });

  it('says the queue is untouched, so a refused caller does not think work was lost', () => {
    // A refusal that reads as "your requests are gone" would make a caller retry harder -- the exact behaviour
    // the limit exists to stop.
    const { gate } = gateAt(1);
    gate.mayRaise({ id: 'a' });
    const refused = gate.mayRaise({ id: 'a' });
    assert.match(refused.detail, /existing requests are untouched and still answerable/);
  });

  it('gives each identity its own budget, so one noisy agent cannot silence another', () => {
    // An address-keyed limit would apply one budget to every agent on a host, blaming the wrong machine.
    const { gate } = gateAt(2);
    gate.mayRaise({ id: 'noisy' });
    gate.mayRaise({ id: 'noisy' });
    assert.equal(gate.mayRaise({ id: 'noisy' }).allowed, false, 'the noisy one is out');
    assert.equal(gate.mayRaise({ id: 'quiet' }).allowed, true, 'and the quiet one is not punished for it');
  });

  it('lets the window slide, rather than counting forever', () => {
    const { gate, advance } = gateAt(1, 60_000);
    assert.equal(gate.mayRaise({ id: 'a' }).allowed, true);
    assert.equal(gate.mayRaise({ id: 'a' }).allowed, false);
    advance(60_001);
    assert.equal(gate.mayRaise({ id: 'a' }).allowed, true, 'a minute later the budget is back');
  });
});

describe('approval gate: an unidentifiable caller gets a shared budget, not no budget', () => {
  it('buckets an absent or blank id under a named key', () => {
    const { gate } = gateAt(2);
    for (const bad of [null, undefined, {}, { id: null }, { id: '' }, { id: '   ' }]) {
      const r = gate.mayRaise(bad);
      assert.equal(typeof r.allowed, 'boolean', JSON.stringify(bad));
    }
    // The two anonymous raises spent the shared budget. The "shared budget" wording is on the ALLOWED branch,
    // which is where a caller learns which budget they are spending from -- the first version of this looked
    // for it on the refusal and was wrong about which half says what.
    assert.equal(gate.mayRaise({}).allowed, false, 'anonymous callers share one budget');
    assert.match(gate.budgetFor({}).key, /anonymous/);
  });

  it('names the shared budget when it allows an anonymous raise', () => {
    const { gate } = gateAt(1);
    const first = gate.mayRaise({});
    assert.equal(first.allowed, true);
    assert.match(first.detail, /shared anonymous budget/);
    const refused = gate.mayRaise({});
    assert.equal(refused.allowed, false);
    assert.match(refused.detail, /existing requests are untouched/, 'a refusal says what was NOT lost');
  });

  it('never lets an anonymous caller be the one caller with no limit', () => {
    // The tempting implementation is "no id, no key, no limit" -- which makes forgetting to identify yourself
    // the way to escape the limit.
    const { gate } = gateAt(1);
    assert.equal(gate.mayRaise({}).allowed, true);
    assert.equal(gate.mayRaise({}).allowed, false);
    assert.equal(gate.budgetFor({}).key, ANONYMOUS_KEY);
  });
});

describe('approval gate: what is deliberately NOT limited', () => {
  it('spends no budget when a budget is only read', () => {
    // `budgetFor` exists so a caller can ask without being charged; a read that consumed budget would make
    // "how much is left" change the answer.
    const { gate } = gateAt(2);
    gate.mayRaise({ id: 'a' });
    const before = gate.budgetFor({ id: 'a' });
    assert.equal(before.used, 1);
    const again = gate.budgetFor({ id: 'a' });
    assert.equal(again.used, 1, 'reading twice must not spend twice');
    assert.equal(again.remaining, 1);
  });

  it('has no method that limits reading the queue or settling a request', () => {
    // Asserted as an absence, because the presence of such a method is the defect. A gate that limited the
    // view would limit knowing what is waiting; one that limited settling would punish the person fixing it.
    const { gate } = gateAt();
    for (const forbidden of ['mayList', 'mayRead', 'maySettle', 'mayDecide', 'mayApprove']) {
      assert.equal(typeof gate[forbidden], 'undefined', `${forbidden} would limit the wrong operation`);
    }
    assert.deepEqual(Object.keys(gate).sort(), ['budgetFor', 'limiter', 'mayRaise', 'raiseLimitPerMinute', 'windowSeconds']);
  });

  it('reports remaining as never negative, even past the limit', () => {
    const { gate } = gateAt(1);
    gate.mayRaise({ id: 'a' });
    gate.mayRaise({ id: 'a' });
    gate.mayRaise({ id: 'a' });
    assert.equal(gate.budgetFor({ id: 'a' }).remaining, 0);
  });
});
