/**
 * Council suite: the three properties the ROADMAP says are falsifiable, tested as falsifications.
 *
 * The ROADMAP names its own falsifying tests for v4.10.0, and this file is those tests rather than a
 * different set chosen for convenience:
 *
 *   1. a phase cannot be skipped
 *   2. a vote's weights are reproducible from stored inputs
 *   3. a decision with recorded dissent is retrievable *with* the dissent
 *
 * So each is attacked directly — by trying to skip a phase, by tampering with a stored weight, and by
 * asking for a contested decision and checking the losing arguments come back with it. A suite that only
 * assembled a council and read its outcome would pass while all three were broken.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORITY_MAX,
  COUNCIL_REFUSAL,
  CouncilRefusal,
  PHASES,
  ROLES,
  convene,
  recount,
  sealOf,
  weightOf,
} from '../src/agent/council.mjs';

/** Run a council forward to a named phase, advancing one step at a time. */
function councilAt(phase, options = {}) {
  const c = convene({ question: 'should this be adopted?', participants: ['a', 'b', 'c'], ...options });
  while (c.phase !== phase) {
    if (c.phase === PHASES[PHASES.length - 1]) throw new Error(`cannot reach ${phase}`);
    c.advance();
  }
  return c;
}

describe('council: a phase cannot be skipped', () => {
  it('starts in convene and moves exactly one phase per advance', () => {
    const c = convene({ question: 'q' });
    assert.equal(c.phase, 'convene');
    const seen = [c.phase];
    while (c.phase !== PHASES[PHASES.length - 1]) {
      c.advance();
      seen.push(c.phase);
    }
    assert.deepEqual(seen, [...PHASES], 'the walk must visit every phase in the declared order and no other');
  });

  it('exposes no way to name a destination phase', () => {
    // The structural half of the property: skipping is impossible because there is no argument to skip with.
    const c = convene({ question: 'q' });
    assert.equal(typeof c.advance, 'function');
    assert.equal(c.advance.length, 0, 'advance takes no argument, so it cannot be told where to go');
    for (const banned of ['goTo', 'setPhase', 'jumpTo', 'skipTo']) {
      assert.equal(c[banned], undefined, `${banned} must not exist`);
    }
  });

  it('refuses a vote before the vote phase, and names why', () => {
    const c = councilAt('deliberate');
    assert.throws(
      () => c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' }),
      (e) => e instanceof CouncilRefusal && e.code === COUNCIL_REFUSAL.UNCLEARED_TO_VOTE,
    );
    assert.match(
      (() => { try { c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' }); return ''; } catch (e) { return e.detail; } })(),
      /a vote on nothing/,
    );
  });

  it('refuses arguments outside the deliberate phase, in both directions', () => {
    // Before: nothing to deliberate on. After: the arguments are what the vote claimed to consider, so
    // appending to them afterwards would change the basis of an outcome that is already fixed.
    const early = councilAt('frame');
    assert.throws(() => early.argue({ participant: 'a', stance: 'for', text: 'x' }), (e) => e.code === COUNCIL_REFUSAL.WRONG_PHASE);
    const late = councilAt('vote');
    assert.throws(() => late.argue({ participant: 'a', stance: 'for', text: 'x' }), (e) => e.code === COUNCIL_REFUSAL.WRONG_PHASE);
  });

  it('refuses to decide before votes exist, rather than declaring an empty outcome', () => {
    const c = councilAt('decide');
    assert.throws(() => c.decide(), (e) => e.code === COUNCIL_REFUSAL.TIED);
  });

  it('refuses every mutation after it is sealed', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' });
    c.advance();          // -> decide
    c.decide();
    c.advance();          // -> record
    c.record();           // seals
    c.advance();          // -> adjourn
    assert.equal(c.phase, 'adjourn');

    // Everything that would change the decision now refuses, and names sealing as the reason.
    for (const attempt of [
      () => c.argue({ participant: 'z', stance: 'against', text: 'late' }),
      () => c.vote({ participant: 'z', authority: 90, reputation: 100, choice: 'no' }),
      () => c.decide(),
    ]) {
      assert.throws(attempt, (e) => e.code === COUNCIL_REFUSAL.ALREADY_SEALED);
    }
    // `advance()` is deliberately NOT in that list: an adjourned council asked to advance is already where
    // it was going, so it answers instead of erroring. See the idempotence test below.
    assert.equal(c.advance().moved, false);
  });

  it('treats advance() after adjournment as a no-op rather than an error', () => {
    // A caller looping "advance until the last phase" would otherwise have to special-case the end, and a
    // loop that must know when to stop is a loop that will be written wrong once. Only advance() is
    // idempotent this way; every other mutation still refuses once sealed.
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' });
    c.advance(); c.decide(); c.advance(); c.record(); c.advance();
    assert.equal(c.phase, 'adjourn');
    const again = c.advance();
    assert.equal(again.moved, false);
    assert.equal(again.phase, 'adjourn');
    assert.match(again.detail, /final phase/);
  });

  it('refuses role assignment outside convene', () => {
    const c = councilAt('frame');
    assert.throws(() => c.assign('a', 'auditor'), (e) => e.code === COUNCIL_REFUSAL.WRONG_PHASE);
    assert.throws(() => councilAt('convene').assign('a', 'wizard'), (e) => e.code === COUNCIL_REFUSAL.UNKNOWN_ROLE);
  });

  it('lets one participant hold several roles, because a role is a hat and not a person', () => {
    const c = convene({ question: 'q' });
    c.assign('a', 'auditor');
    c.assign('a', 'critic');
    assert.equal(c.members.find((m) => m.participant === 'a').role, 'auditor,critic');
    assert.equal(ROLES.length, 6, 'the AURA council has six roles');
  });
});

describe('council: weights are reproducible from stored inputs', () => {
  it('computes a weight from nothing but the two stored integers', () => {
    assert.equal(weightOf({ authority: 0, reputation: 0 }), 0);
    assert.equal(weightOf({ authority: 50, reputation: 0 }), 50);
    assert.equal(weightOf({ authority: 50, reputation: 100 }), 100);
    assert.equal(weightOf({ authority: 40, reputation: 50 }), 60);
  });

  it('keeps reputation from ever overturning authority', () => {
    // The ordering that stops this becoming a second, undeclared authority model: the most reputable
    // low-authority voice is still below a bare high-authority one.
    const bestOrdinary = weightOf({ authority: 40, reputation: 100 });
    const bareAdmin = weightOf({ authority: 90, reputation: 0 });
    assert.ok(bestOrdinary < bareAdmin, `${bestOrdinary} must be less than ${bareAdmin}`);
    // And it holds at the very top of the ordinary band.
    assert.ok(weightOf({ authority: 49, reputation: 100 }) < weightOf({ authority: 99, reputation: 0 }));
  });

  it('is a pure function: same inputs, same weight, no hidden state', () => {
    const a = weightOf({ authority: 63, reputation: 27 });
    for (let i = 0; i < 50; i += 1) assert.equal(weightOf({ authority: 63, reputation: 27 }), a);
  });

  it('refuses inputs it cannot compute a weight from, rather than guessing', () => {
    for (const bad of [
      { authority: -1, reputation: 0 },
      { authority: AUTHORITY_MAX + 1, reputation: 0 },
      { authority: 1.5, reputation: 0 },
      { authority: '50', reputation: 0 },
      { authority: 50, reputation: -1 },
      { authority: 50, reputation: 101 },
      { authority: 50, reputation: Number.NaN },
    ]) {
      assert.throws(() => weightOf(bad), (e) => e.code === COUNCIL_REFUSAL.BAD_WEIGHT_INPUT, JSON.stringify(bad));
    }
    assert.throws(() => weightOf(), (e) => e.code === COUNCIL_REFUSAL.BAD_WEIGHT_INPUT);
  });

  it('reproduces a recorded outcome from the stored ballots alone', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 90, reputation: 0, choice: 'adopt' });
    c.vote({ participant: 'b', authority: 50, reputation: 0, choice: 'reject' });
    c.vote({ participant: 'c', authority: 60, reputation: 0, choice: 'reject' });
    c.advance();
    const decision = c.decide();
    assert.equal(decision.outcome, 'reject', '110 beats 90');

    const r = recount(decision);
    assert.equal(r.reproduced, true);
    assert.equal(r.outcome, 'reject');
    assert.equal(r.weight, 110);
  });

  it('detects a tampered weight instead of reproducing it', () => {
    // The falsification of the property: change a stored weight and the recount must refuse to agree.
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 40, reputation: 0, choice: 'adopt' });
    c.vote({ participant: 'b', authority: 50, reputation: 0, choice: 'reject' });
    c.advance();
    const decision = c.decide();
    const tampered = { ...decision, ballots: decision.ballots.map((b) => (b.participant === 'a' ? { ...b, weight: 500 } : b)) };
    const r = recount(tampered);
    assert.equal(r.reproduced, false);
    assert.match(r.detail, /records weight 500 but its stored inputs give 40/);
  });

  it('is order-independent, so the tally does not depend on who voted first', () => {
    const cast = (order) => {
      const c = councilAt('vote');
      const voters = {
        a: { participant: 'a', authority: 70, reputation: 10, choice: 'adopt' },
        b: { participant: 'b', authority: 55, reputation: 40, choice: 'reject' },
        c: { participant: 'c', authority: 55, reputation: 41, choice: 'reject' },
      };
      for (const k of order) c.vote(voters[k]);
      c.advance();
      return c.decide();
    };
    const one = cast(['a', 'b', 'c']);
    const two = cast(['c', 'a', 'b']);
    assert.equal(one.outcome, two.outcome);
    assert.equal(one.weight, two.weight);
    assert.deepEqual(one.tally, two.tally);
  });

  it('refuses a second ballot from the same participant', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' });
    assert.throws(
      () => c.vote({ participant: 'a', authority: 90, reputation: 100, choice: 'no' }),
      (e) => e.code === COUNCIL_REFUSAL.ALREADY_VOTED,
    );
  });

  it('refuses to break a tie, because a split council is what a person must see', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' });
    c.vote({ participant: 'b', authority: 50, reputation: 0, choice: 'no' });
    c.advance();
    assert.throws(() => c.decide(), (e) => e.code === COUNCIL_REFUSAL.TIED);
    assert.deepEqual((() => { try { c.decide(); return null; } catch (e) { return e.tally; } })(), { yes: 50, no: 50 });
  });

  it('seals over the inputs, so the seal changes when any input does', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes', reason: 'because' });
    c.advance();
    const decision = c.decide();
    const seal = sealOf({ ...decision, phase_reached: 'record' });
    const changed = sealOf({ ...decision, phase_reached: 'record', ballots: [{ ...decision.ballots[0], reputation: 1 }] });
    assert.notEqual(seal, changed, 'a different input must produce a different seal');
    assert.equal(sealOf({ ...decision, phase_reached: 'record' }), seal, 'and the same input must be stable');
  });
});

describe('council: a decision comes back with its dissent', () => {
  it('retains the losing arguments alongside the outcome', () => {
    // The property that makes a decision auditable later: "was this contested?" must be answerable.
    const c = councilAt('deliberate');
    c.argue({ participant: 'critic', stance: 'against', text: 'this costs a round and proves nothing' });
    c.argue({ participant: 'strategist', stance: 'for', text: 'it unblocks the fleet' });
    c.advance();
    c.vote({ participant: 'strategist', authority: 80, reputation: 0, choice: 'adopt' });
    c.vote({ participant: 'critic', authority: 40, reputation: 0, choice: 'reject' });
    c.advance();
    const decision = c.decide();

    assert.equal(decision.outcome, 'adopt');
    assert.equal(decision.unanimous, false);
    assert.equal(decision.dissent.length, 1);
    assert.equal(decision.dissent[0].participant, 'critic');
    assert.equal(decision.dissent[0].choice, 'reject');
    assert.equal(decision.dissent[0].weight, 40);
    assert.equal(decision.dissent[0].text, 'this costs a round and proves nothing');
  });

  it('marks a unanimous decision as such rather than leaving dissent empty and ambiguous', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' });
    c.vote({ participant: 'b', authority: 60, reputation: 0, choice: 'yes' });
    c.advance();
    const decision = c.decide();
    assert.deepEqual(decision.dissent, []);
    assert.equal(decision.unanimous, true, 'an empty dissent list alone cannot distinguish unanimous from unrecorded');
  });

  it('keeps the dissent in the value the seal covers, so it cannot be dropped later', () => {
    const c = councilAt('deliberate');
    c.argue({ participant: 'critic', stance: 'against', text: 'no' });
    c.advance();
    c.vote({ participant: 'a', authority: 90, reputation: 0, choice: 'yes' });
    c.vote({ participant: 'critic', authority: 10, reputation: 0, choice: 'no' });
    c.advance();
    const decision = c.decide();
    const sealed = { ...decision, phase_reached: 'record' };
    const withDissent = sealOf({ ...sealed, ballots: sealed.ballots });
    // Removing a ballot -- which is how dissent would be dropped -- must change the seal.
    const withoutCritic = sealOf({ ...sealed, ballots: sealed.ballots.filter((b) => b.participant !== 'critic') });
    assert.notEqual(withDissent, withoutCritic);
  });

  it('carries a null text for a dissenter who gave no reason, rather than inventing one', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 90, reputation: 0, choice: 'yes' });
    c.vote({ participant: 'b', authority: 10, reputation: 0, choice: 'no' });
    c.advance();
    const decision = c.decide();
    assert.equal(decision.dissent[0].text, null);
  });

  it('records the phase it reached, so a reader can see how far it got', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' });
    c.advance();
    assert.equal(c.decide().phase_reached, 'decide');
    c.advance();
    assert.equal(c.record().phase_reached, 'record');
    assert.match(c.decision.seal, /^[0-9a-f]{64}$/);
  });
});

describe('council: recounts refuse what they cannot check', () => {
  it('says so when handed nothing', () => {
    for (const bad of [null, undefined, 42, 'decision']) {
      const r = recount(bad);
      assert.equal(r.reproduced, false);
      assert.match(r.detail, /no decision supplied/);
    }
  });

  it('does not report a seal match when there is no seal', () => {
    const c = councilAt('vote');
    c.vote({ participant: 'a', authority: 50, reputation: 0, choice: 'yes' });
    c.advance();
    const decision = c.decide();
    assert.equal('seal' in decision, false, 'a decision is not sealed until record()');
    assert.equal(recount(decision).seal_matches, false, 'no seal must not read as a matching seal');
  });

  it('names the ballot it could not compute a weight for', () => {
    const r = recount({ outcome: 'x', weight: 1, ballots: [{ participant: 'ghost', authority: 'high', reputation: 0, choice: 'x', weight: 1 }] });
    assert.equal(r.reproduced, false);
    assert.match(r.detail, /ghost/);
  });

  it('reports no ballots as a refusal rather than as a zero-weight outcome', () => {
    const r = recount({ outcome: 'x', weight: 0, ballots: [] });
    assert.equal(r.reproduced, false);
    assert.match(r.detail, /no ballots to recount/);
  });
});
