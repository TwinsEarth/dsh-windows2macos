/**
 * Council sessions: the part of a council that has to outlive one call, and the two kinds of state in it.
 *
 * The tests are organised around the distinction the module exists for: a **live** council is scratch space
 * and a **decided** one is the artifact. The ROADMAP's third falsifying test for v4.10.0 is that a decision
 * with dissent is *retrievable* with the dissent — and **retrievable means after the council that produced it
 * is gone**, which is a property of the session rather than of the decision.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PHASES, ROLES } from '../src/agent/council.mjs';
import { MAX_DECIDED_COUNCILS, MAX_LIVE_COUNCILS, SESSION_REFUSAL, createCouncilSessions } from '../src/agent/council-session.mjs';

/**
 * Advance a council until it reaches a named phase.
 *
 * Written as "advance until" rather than "advance N times" because the first version of this helper counted,
 * got the count wrong by one, and failed with a `WRONG_PHASE` refusal that read like a defect in the module.
 * Measured order: `convene → frame → deliberate → vote → decide → record → adjourn`, so `argue` needs **two**
 * advances from the start and not one. **A helper that names its destination cannot drift when the phase list
 * grows; one that counts steps silently does.**
 */
function advanceTo(council, phase) {
  for (let i = 0; i < PHASES.length + 1 && council.phase !== phase; i += 1) council.advance();
  assert.equal(council.phase, phase, `could not reach "${phase}"`);
  return council;
}

/** Walk a council to a decided, sealed state, since every test needs the same path. */
function deliberate(sessions, id, votes = [{ participant: 'a', authority: 90, choice: 'ship' }, { participant: 'b', authority: 10, choice: 'hold' }]) {
  sessions.open(id, { question: 'shall we ship?' });
  const council = sessions.get(id).council;
  // Roles are assigned during `convene`, before the phase machine moves at all.
  council.assign('a', 'strategist');
  for (const v of votes) council.assign(v.participant, 'analyst');
  advanceTo(council, 'deliberate');
  council.argue({ participant: 'a', stance: 'for', text: 'the tests pass' });
  council.argue({ participant: 'b', stance: 'against', text: 'nobody has run it on the real machine' });
  advanceTo(council, 'vote');
  for (const v of votes) council.vote({ participant: v.participant, authority: v.authority, reputation: 0, choice: v.choice });
  advanceTo(council, 'decide');
  council.decide();
  advanceTo(council, 'record');
  council.record();
  return council;
}

describe('council sessions: a council survives the call that opened it', () => {
  it('opens under a caller-chosen id and reports the phase and the roles', () => {
    const s = createCouncilSessions();
    const r = s.open('C1', { question: 'q' });
    assert.equal(r.ok, true);
    assert.equal(r.phase, PHASES[0]);
    assert.deepEqual(r.roles, [...ROLES]);
    assert.equal(s.get('C1').council.phase, PHASES[0]);
  });

  it('advances across separate calls, which is the whole reason it is stored', () => {
    // A council that lived inside one tool invocation could never finish: it has seven phases.
    const s = createCouncilSessions();
    s.open('C1', { question: 'q' });
    const seen = [s.get('C1').council.phase];
    for (const phase of PHASES.slice(1)) {
      advanceTo(s.get('C1').council, phase);
      seen.push(phase);
    }
    assert.deepEqual(seen, [...PHASES]);
  });

  it('requires an id from the caller rather than inventing one', () => {
    // An id invented here could not be correlated with whoever is waiting to use it.
    const s = createCouncilSessions();
    for (const bad of [null, undefined, '', '   ', 42]) {
      const r = s.open(bad, { question: 'q' });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.reason_code, SESSION_REFUSAL.NO_ID);
    }
  });

  it('refuses a duplicate id instead of silently replacing the council', () => {
    // Replacing would discard a council mid-phase, and the symptom would read as "the phases reset".
    const s = createCouncilSessions();
    s.open('C1', { question: 'q' });
    s.get('C1').council.advance();
    const again = s.open('C1', { question: 'different' });
    assert.equal(again.ok, false);
    assert.equal(again.reason_code, SESSION_REFUSAL.ALREADY_EXISTS);
    assert.equal(s.get('C1').council.phase, PHASES[1], 'the original is untouched');
  });

  it('names what is missing rather than returning nothing', () => {
    const s = createCouncilSessions();
    const r = s.get('nope');
    assert.equal(r.ok, false);
    assert.equal(r.reason_code, SESSION_REFUSAL.NOT_FOUND);
    assert.match(r.detail, /no live council/);
    assert.equal(s.get(null).reason_code, SESSION_REFUSAL.NO_ID);
  });
});

describe('council sessions: a decided council is retrievable with its dissent', () => {
  it('moves from live to decided on seal, and stays readable', () => {
    // v4.10.0's third falsifying test, at the level where it is actually a property: the decision survives the
    // council ceasing to be advanceable.
    const s = createCouncilSessions();
    const council = deliberate(s, 'C1');
    assert.ok(council.decision !== null);

    const sealed = s.seal('C1');
    assert.equal(sealed.ok, true);
    assert.equal(s.get('C1').ok, false, 'it is no longer live');
    assert.equal(s.get('C1').reason_code, SESSION_REFUSAL.NOT_DECIDED);

    const read = s.decision('C1');
    assert.equal(read.ok, true);
    assert.equal(read.decision.outcome, 'ship');
    assert.equal(read.decision.dissent.length, 1, 'the losing side is still there');
    assert.equal(read.decision.dissent[0].participant, 'b');
    assert.match(read.decision.dissent[0].text, /nobody has run it on the real machine/);
  });

  it('returns the recount WITH the decision, so the seal need not be taken on trust', () => {
    const s = createCouncilSessions();
    deliberate(s, 'C1');
    s.seal('C1');
    const read = s.decision('C1');
    assert.equal(read.recount.reproduced, true);
    assert.equal(read.recount.outcome, 'ship');
  });

  it('refuses to seal a council that has not decided, and says which call is missing', () => {
    const s = createCouncilSessions();
    s.open('C1', { question: 'q' });
    const r = s.seal('C1');
    assert.equal(r.ok, false);
    assert.equal(r.reason_code, SESSION_REFUSAL.NOT_DECIDED);
    assert.match(r.detail, /decide\(\) must run first/);
    assert.equal(s.get('C1').ok, true, 'and the council is still open');
  });

  it('distinguishes "still open" from "never existed" when a decision is asked for', () => {
    // A caller waiting on a council that is simply unfinished needs a different response from one that named
    // the wrong id.
    const s = createCouncilSessions();
    s.open('C1', { question: 'q' });
    assert.match(s.decision('C1').detail, /still open, so nothing is decided/);
    assert.match(s.decision('C9').detail, /no decided council/);
    assert.equal(s.decision(null).reason_code, SESSION_REFUSAL.NO_ID);
  });
});

describe('council sessions: eviction is oldest-first, and the artifact outlives the workspace', () => {
  it('drops the oldest LIVE council when the cap is reached, not the newest', () => {
    // Predictability: a reader can say which council survives without reading the implementation.
    const s = createCouncilSessions({ maxLive: 3 });
    for (const id of ['C1', 'C2', 'C3', 'C4']) s.open(id, { question: 'q' });
    assert.deepEqual(s.ids().live, ['C2', 'C3', 'C4']);
    assert.equal(s.get('C1').ok, false);
  });

  it('keeps decided councils when live ones are evicted', () => {
    // The two maps are separate kinds of state: losing scratch space is annoying, losing the artifact is not
    // recoverable.
    const s = createCouncilSessions({ maxLive: 1 });
    deliberate(s, 'D1');
    s.seal('D1');
    for (const id of ['L1', 'L2', 'L3']) s.open(id, { question: 'q' });
    assert.equal(s.decision('D1').ok, true, 'the decision survives live eviction');
  });

  it('drops the oldest DECIDED council only when its own, larger cap is reached', () => {
    const s = createCouncilSessions({ maxDecided: 2 });
    for (const id of ['D1', 'D2', 'D3']) {
      deliberate(s, id);
      s.seal(id);
    }
    assert.deepEqual(s.ids().decided, ['D2', 'D3']);
    assert.equal(s.decision('D1').ok, false);
  });

  it('defaults the decided cap above the live one, because the artifact is worth more than the workspace', () => {
    assert.ok(MAX_DECIDED_COUNCILS > MAX_LIVE_COUNCILS, 'a decision is kept longer than the council that made it');
    assert.ok(MAX_LIVE_COUNCILS >= PHASES.length, 'the live cap should not be smaller than the number of phases');
  });
});
