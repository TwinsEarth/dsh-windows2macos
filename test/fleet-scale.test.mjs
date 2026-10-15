/**
 * Fleet-scale suite: the arithmetic, and the refusals.
 *
 * What these protect, said once: this module exists to answer a question the fleet **cannot** answer — the
 * agent count at which coordination collapses — with something honest instead of a guess. So the tests are
 * mostly about the *refusals*: an empty observation must not produce a zero, a five-machine sample must not
 * produce a fifty-machine estimate, and one fan-out must not be called a ceiling.
 *
 * A module like this fails by being confidently wrong, which is worse than being silent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAILURE_STATES,
  LEASE_OUTCOME,
  classifyLease,
  isFleetFailure,
  LEASE_MEANING,
  REQUEST_FAULT_STATES,
  ceilingFrom,
  extrapolate,
  overhead,
  scaleOf,
  summarise,
} from '../src/agent/fleet-scale.mjs';

/** A task report shaped like what the relay actually returns. */
function task(machines, over = {}) {
  return { task_id: 'T', mode: 'replicate', machines, ...over };
}
const lease = (state, over = {}) => ({ lease_state: state, outcome: state === 'done' ? 'ok' : state, ...over });

describe('fleet scale: a non-zero exit code is not a fleet failure', () => {
  it('tells a command that ran and reported 70 from a lease that produced nothing', () => {
    // The conflation this session made repeatedly. \`exit_code: 70\` with \`lease_state: done\` means the
    // command RAN and reported 70 -- the fleet worked. \`exit_code: null\` with \`expired\` means no result
    // existed at all. Both are true facts and they send a reader to different places.
    const ran = classifyLease({ lease_state: 'done', exit_code: 70 });
    assert.equal(ran.outcome, LEASE_OUTCOME.RAN);
    assert.equal(ran.ran, true);
    assert.equal(ran.exit_code, 70);
    assert.match(ran.detail, /the command's answer, not a fleet failure/);

    const nothing = classifyLease({ lease_state: 'expired', exit_code: null });
    assert.equal(nothing.outcome, LEASE_OUTCOME.NO_RESULT);
    assert.equal(nothing.ran, false);
    assert.equal(nothing.exit_code, null);
    assert.match(nothing.detail, /what the command did is unknown/);
  });

  it('calls only the no-result case a fleet failure', () => {
    assert.equal(isFleetFailure({ lease_state: 'done', exit_code: 70 }), false);
    assert.equal(isFleetFailure({ lease_state: 'done', exit_code: 0 }), false);
    assert.equal(isFleetFailure({ lease_state: 'expired', exit_code: null }), true);
    assert.equal(isFleetFailure({ lease_state: 'timeout' }), true);
    assert.equal(isFleetFailure({ lease_state: 'refused' }), false, 'a refusal is the request being wrong');
    assert.equal(isFleetFailure({ lease_state: 'observing' }), false, 'an observer was never asked to act');
  });

  it('separates a refusal and an observer from both kinds of failure', () => {
    assert.equal(classifyLease({ lease_state: 'refused', refusal_reason: 'COMMAND_NOT_ALLOWED' }).outcome, LEASE_OUTCOME.REFUSED);
    assert.equal(classifyLease({ lease_state: 'observing' }).outcome, LEASE_OUTCOME.OBSERVED_ONLY);
  });

  it('reports an unrecognised lease state rather than guessing at it', () => {
    // A new state added to the relay must not be silently folded into one of the existing buckets.
    const c = classifyLease({ lease_state: 'something-new', exit_code: 0 });
    assert.equal(c.outcome, LEASE_OUTCOME.UNKNOWN);
    assert.match(c.detail, /unrecognised lease state/);
    assert.equal(classifyLease(null).outcome, LEASE_OUTCOME.UNKNOWN);
  });

  it('records success as having run, because success is not the opposite of a fleet failure', () => {
    const ok = classifyLease({ lease_state: 'done', exit_code: 0 });
    assert.equal(ok.ran, true);
    assert.equal(ok.outcome, LEASE_OUTCOME.RAN);
  });
});

describe('fleet scale: the summary counts what was observed', () => {
  it('counts each lease state and computes the expiry rate against acting leases', () => {
    const s = summarise([
      task([lease('done'), lease('done'), lease('expired')]),
      task([lease('done'), lease('observing'), lease('observing')]),
    ]);
    assert.equal(s.tasks, 2);
    assert.equal(s.leases.done, 3);
    assert.equal(s.leases.expired, 1);
    assert.equal(s.leases.observing, 2);
    // 1 of 4 acting leases expired. Observers are excluded from the denominator on purpose: a machine that
    // was only told the outcome is not an agent that failed to act.
    assert.equal(s.acting_leases, 4);
    assert.equal(s.expiry_rate, 0.25);
    assert.equal(s.tasks_with_any_expiry, 1);
  });

  it('separates a refusal from a failure, because they need different fixes', () => {
    // An expired lease is the fleet losing work. A refused lease is a request the allow-list rejected -- the
    // fleet did exactly what it was told. Merging them would point the reader at the wrong machine.
    const s = summarise([task([lease('done'), lease('refused'), lease('refused')])]);
    assert.equal(s.leases.refused, 2);
    assert.equal(s.expiry_rate, 0, 'a refusal is not an expiry');
    assert.equal(s.refusal_rate, Math.round((2 / 3) * 1000) / 1000);
    assert.deepEqual([...REQUEST_FAULT_STATES], ['refused']);
    assert.ok(FAILURE_STATES.includes('expired'));
    assert.equal(FAILURE_STATES.includes('refused'), false);
  });

  it('reports a rate over an empty denominator as null, not as zero', () => {
    // "Nothing was attempted" and "everything succeeded" must not look alike.
    const s = summarise([task([lease('observing')])]);
    assert.equal(s.acting_leases, 0);
    assert.equal(s.expiry_rate, null);
    assert.equal(s.unmeasured, true);
  });

  it('reports no direct transport when every lease went by relay', () => {
    const s = summarise([task([lease('done', { transport: 'relay' }), lease('done', { transport: 'relay' })])]);
    assert.equal(s.transports.relay, 2);
    assert.equal(s.transports.direct, 0);
    assert.equal(s.direct_share, 0);
  });

  it('reports no direct share at all when no lease carried a transport field', () => {
    const s = summarise([task([lease('done'), lease('done')])]);
    assert.equal(s.direct_share, null, 'zero of zero is not "0% direct", it is unmeasured');
  });

  it('computes the P2P delivery rate from what was attempted', () => {
    const s = summarise([task([
      lease('done', { p2p: { encrypted: false, peer: null } }),
      lease('done', { p2p: { encrypted: true, peer: 'x' } }),
    ])]);
    assert.equal(s.p2p.attempted, 2);
    assert.equal(s.p2p.delivered, 1);
    assert.equal(s.p2p.delivery_rate, 0.5);
  });

  it('survives junk rather than throwing on it', () => {
    // The input comes from an API, so "well-formed" is a hope rather than a guarantee.
    for (const bad of [null, undefined, 42, 'tasks', {}]) {
      const s = summarise(bad);
      assert.equal(s.tasks, 0);
      assert.equal(s.expiry_rate, null);
    }
    // Every entry in `machines` is a lease, including an entry that is `null` -- a machine listed with no
    // result is an unknown outcome, which is a real thing a relay response can say. So all four count as
    // other, and the wrong expectation here was mine: 2.
    const ragged = summarise([task([null, undefined, {}, { lease_state: 'something-new' }])]);
    assert.equal(ragged.leases.other, 4, 'an unknown outcome is counted as other, not dropped');
  });

  it('names what each lease state means, so the vocabulary is checkable', () => {
    assert.match(LEASE_MEANING.expired, /silently did not happen/);
    assert.match(LEASE_MEANING.refused, /defect in the request/);
    assert.match(LEASE_MEANING.observing, /without being asked to act/);
  });
});

describe('fleet scale: overhead is per acting agent, not per lease', () => {
  it('divides by acting leases', () => {
    const s = summarise([task([lease('done'), lease('done'), lease('done'), lease('expired')])]);
    const o = overhead(s);
    assert.equal(o.acting_leases, 4);
    assert.equal(o.overhead_per_agent, 0.25);
  });

  it('refuses to call the overhead of zero agents zero', () => {
    // Arithmetic would give 0/0. Calling that "0" is the single most misleading number this module could
    // produce, because it reads as a perfectly coordinated empty fleet.
    const o = overhead(summarise([task([lease('observing')])]));
    assert.equal(o.overhead_per_agent, null);
    assert.match(o.detail, /not zero, it is undefined/);
  });

  it('refuses a missing summary rather than inventing one', () => {
    for (const bad of [null, undefined, 42]) {
      const o = overhead(bad);
      assert.equal(o.overhead_per_agent, null);
      assert.match(o.detail, /no summary/);
    }
  });
});

describe('fleet scale: the observation states its own limits', () => {
  it('reports how many machines were seen and refuses to claim the collapse point', () => {
    const s = scaleOf(['a', 'b', 'c', 'd', 'e', 'a']);
    assert.equal(s.observed_machines, 5, 'duplicates are one machine');
    assert.equal(s.can_answer_collapse_point, false);
    assert.match(s.detail, /covers 5 machine/);
    assert.match(s.detail, /outside what 5 can show/);
  });

  it('refuses to extrapolate from five to fifty', () => {
    // The ROADMAP's whole point: a design not measured at 50 cannot honestly specify 1,000. Five is 10% of
    // fifty and 1% of fifty-thousand, so both are refused -- and the refusal says why rather than returning a
    // number with a caveat attached.
    const r = extrapolate(5, 50);
    assert.equal(r.ok, false);
    assert.equal(r.estimate, null);
    assert.match(r.detail, /refusing to extrapolate/);
    assert.match(r.detail, /fiction with a decimal point/);
    const big = extrapolate(5, 1000);
    assert.equal(big.ok, false);
    assert.equal(big.estimate, null);
  });

  it('extrapolates when the coverage justifies it, and labels it as an extrapolation', () => {
    const r = extrapolate(40, 50);
    assert.equal(r.ok, true);
    assert.equal(r.estimate, 50);
    assert.match(r.detail, /reported as an extrapolation, never as a measurement/);
  });

  it('refuses at exactly a tenth and allows just above it', () => {
    // The boundary is exclusive on purpose, and the first version of this test contradicted its own message:
    // it said "at least a tenth" while the code required more than one. Exactly 10% is the borderline case,
    // and there a refusal costs nothing while an estimate costs credibility.
    assert.equal(extrapolate(5, 50).coverage, 0.1);
    assert.equal(extrapolate(5, 50).ok, false, 'exactly a tenth is refused');
    assert.equal(extrapolate(6, 50).ok, true, 'just above a tenth is allowed');
  });

  it('refuses nonsensical inputs instead of dividing by them', () => {
    for (const [a, b] of [[0, 50], [5, 0], [-1, 50], [Number.NaN, 50], [5, undefined]]) {
      const r = extrapolate(a, b);
      assert.equal(r.ok, false, `${a} -> ${b}`);
      assert.equal(r.estimate, null);
    }
  });
});

describe('fleet scale: one fan-out is not a ceiling', () => {
  it('states an observation and explicitly denies it is a ceiling', () => {
    // The only honest form of the answer the data supports. Naming what the claim is NOT is the reason this
    // function exists rather than a caller writing the sentence itself.
    const s = summarise([task([lease('done'), lease('done'), lease('expired'), lease('expired')])]);
    const c = ceilingFrom(s, 4);
    assert.equal(c.is_a_ceiling, false);
    assert.equal(c.fan_out, 4);
    assert.equal(c.expiry_rate, 0.5);
    assert.match(c.claim, /at a fan-out of 4, the lease expiry rate was 50\.0%/);
    assert.match(c.detail, /not a collapse point/);
    assert.match(c.detail, /measured at several fan-outs and trending/);
  });

  it('refuses to state a rate it does not have', () => {
    const c = ceilingFrom(summarise([task([lease('observing')])]), 1);
    assert.equal(c.claim, null);
    assert.match(c.detail, /no acting leases/);
  });

  it('refuses a claim without a fan-out, because a rate without its scale says nothing', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN]) {
      const c = ceilingFrom(summarise([task([lease('done')])]), bad);
      assert.equal(c.claim, null, String(bad));
    }
  });
});
