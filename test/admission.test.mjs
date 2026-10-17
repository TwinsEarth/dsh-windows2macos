/**
 * Fleet admission: the operator's rules, one assertion group per rule.
 *
 * The clock is injected in every test, so "10 seconds" and "24 hours" are exact rather than slept for. The point of
 * these tests is the edges: a decision one millisecond after the automatic one, an empty fleet asked to consent, a
 * quorum whose set must not move while the vote is open.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMISSION, AUTO_APPROVE_MS, KICK_WINDOW_MS, REQUEST_TTL_MS, VOTE_WINDOW_MS,
  createAdmission, neededVotes,
} from '../src/relay/admission.mjs';

function harness() {
  let t = 1_000_000;
  const sm = createAdmission({ now: () => t });
  return { sm, advance: (ms) => { t += ms; }, at: () => t };
}

describe('the quorum the operator specified', () => {
  it('needs 1 vote from a two-member fleet, and >= 50% rounded up above that', () => {
    assert.equal(neededVotes(1), 1);
    assert.equal(neededVotes(2), 1, 'a two-member fleet must not deadlock on 2 votes');
    assert.equal(neededVotes(3), 2);
    assert.equal(neededVotes(4), 2);
    assert.equal(neededVotes(5), 3);
  });
});

describe('joining', () => {
  it('the first machine founds the fleet without any approval', () => {
    const { sm } = harness();
    const r = sm.requestAdmission({ machine_id: 'm1' });
    assert.equal(r.state, ADMISSION.APPROVED);
    assert.equal(r.founder, true);
    assert.equal(sm.isMember('m1'), true);
  });

  it('a pending request grants nothing: it is not a member until approved', () => {
    const { sm } = harness();
    sm.seedFounder('m1');
    const r = sm.requestAdmission({ machine_id: 'm2' });
    assert.equal(r.state, ADMISSION.PENDING);
    assert.equal(sm.isMember('m2'), false, 'pending must never be dispatchable');
  });

  it('re-requesting returns the same open request instead of queueing another', () => {
    const { sm } = harness();
    sm.seedFounder('m1');
    const a = sm.requestAdmission({ machine_id: 'm2' });
    const b = sm.requestAdmission({ machine_id: 'm2' });
    assert.equal(a.request_id, b.request_id);
    assert.equal(b.replayed, true);
  });

  it('an explicit rejection is final and grants nothing', () => {
    const { sm } = harness();
    sm.seedFounder('m1');
    const r = sm.requestAdmission({ machine_id: 'm2' });
    const d = sm.decide(r.request_id, { decision: 'reject', decided_by: 'm1' });
    assert.equal(d.state, ADMISSION.REJECTED);
    assert.equal(sm.isMember('m2'), false);
    assert.equal(sm.decide(r.request_id, { decision: 'approve', decided_by: 'm1' }).code, 'ALREADY_DECIDED');
  });
});

describe('the 10s automatic approval', () => {
  it('auto-approves after the operator window when a member is online', () => {
    const { sm, advance } = harness();
    sm.seedFounder('m1');
    sm.requestAdmission({ machine_id: 'm2' });
    advance(AUTO_APPROVE_MS - 1);
    assert.equal(sm.tick().length, 0, 'nothing happens one millisecond early');
    advance(1);
    const decided = sm.tick();
    assert.equal(decided.length, 1);
    assert.equal(decided[0].auto, true);
    assert.equal(sm.isMember('m2'), true);
  });

  it('a rejection inside the window wins over the automatic approval', () => {
    const { sm, advance } = harness();
    sm.seedFounder('m1');
    const r = sm.requestAdmission({ machine_id: 'm2' });
    advance(AUTO_APPROVE_MS - 100);
    sm.decide(r.request_id, { decision: 'reject', decided_by: 'm1' });
    advance(200);
    assert.equal(sm.tick().length, 0, 'a decided request is not revisited');
    assert.equal(sm.isMember('m2'), false);
  });

  it('never auto-approves with zero members online, even after the window', () => {
    const { sm, advance } = harness();
    sm.seedFounder('m1');
    sm.setOnline('m1', false);
    const r = sm.requestAdmission({ machine_id: 'm2' });
    advance(AUTO_APPROVE_MS * 10);
    assert.equal(sm.tick().length, 0, 'an empty fleet cannot consent');
    assert.equal(sm.decide(r.request_id, { decision: 'approve', auto: true }).code, 'NO_ONLINE_MEMBER');
    assert.equal(sm.isMember('m2'), false);
  });

  it('a request nobody decides expires instead of waiting forever', () => {
    const { sm, advance } = harness();
    sm.seedFounder('m1');
    sm.setOnline('m1', false);
    const r = sm.requestAdmission({ machine_id: 'm2' });
    assert.equal(r.state, ADMISSION.PENDING);
    advance(REQUEST_TTL_MS);
    const decided = sm.tick();
    assert.equal(decided[0].state, ADMISSION.EXPIRED);
    assert.equal(sm.getRequest(r.request_id).state, ADMISSION.EXPIRED);
  });
});

describe('removal inside 24 hours is immediate', () => {
  it('any online member may kick a new member immediately', () => {
    const { sm } = harness();
    sm.seedFounder('m1');
    const r = sm.requestAdmission({ machine_id: 'm2' });
    sm.decide(r.request_id, { decision: 'approve', decided_by: 'm1' });
    const out = sm.remove('m2', { requested_by: 'm1' });
    assert.equal(out.immediate, true);
    assert.equal(sm.isMember('m2'), false);
  });

  it('cannot remove yourself, and cannot remove the last member', () => {
    const { sm } = harness();
    sm.seedFounder('m1');
    assert.equal(sm.remove('m1', { requested_by: 'm1' }).code, 'CANNOT_REMOVE_SELF');
    const r = sm.requestAdmission({ machine_id: 'm2' });
    sm.decide(r.request_id, { decision: 'approve', decided_by: 'm1' });
    assert.equal(sm.remove('m1', { requested_by: 'm1' }).code, 'CANNOT_REMOVE_SELF');
  });
});

describe('removal after 24 hours requires a frozen-quorum vote', () => {
  function fleetWithVoter() {
    const h = harness();
    const { sm } = h;
    sm.seedFounder('v1'); sm.seedFounder('v2'); sm.seedFounder('v3');
    const r = sm.requestAdmission({ machine_id: 'new' });
    sm.decide(r.request_id, { decision: 'approve', decided_by: 'v1' });
    h.advance(KICK_WINDOW_MS + 1);
    return h;
  }

  it('opens a vote instead of removing, freezing the online old members as the quorum', () => {
    const { sm } = fleetWithVoter();
    const out = sm.remove('new', { requested_by: 'v1' });
    assert.equal(out.immediate, false);
    assert.deepEqual(out.snapshot.sort(), ['v1', 'v2', 'v3']);
    assert.equal(out.need, 2, 'three old members need two votes');
  });

  it('a member going offline mid-vote does not change the frozen quorum', () => {
    const { sm } = fleetWithVoter();
    const out = sm.remove('new', { requested_by: 'v1' });
    sm.setOnline('v2', false);
    const after = sm.getRemoval(out.removal_id);
    assert.deepEqual(after.snapshot, out.snapshot, 'the snapshot is frozen at open time');
    assert.equal(after.need, out.need);
  });

  it('carries with enough yes votes and removes the member', () => {
    const { sm } = fleetWithVoter();
    const out = sm.remove('new', { requested_by: 'v1' });
    const v = sm.vote(out.removal_id, { machine_id: 'v2', vote: 'yes' });
    assert.equal(v.state, 'carried');
    assert.equal(sm.isMember('new'), false);
  });

  it('refuses votes from outside the snapshot, from the target, and after the window', () => {
    const h = fleetWithVoter();
    const { sm } = h;
    const out = sm.remove('new', { requested_by: 'v1' });
    assert.equal(sm.vote(out.removal_id, { machine_id: 'new', vote: 'yes' }).code, 'TARGET_CANNOT_VOTE');
    assert.equal(sm.vote(out.removal_id, { machine_id: 'stranger', vote: 'yes' }).code, 'NOT_IN_SNAPSHOT');
    h.advance(VOTE_WINDOW_MS + 1);
    assert.equal(sm.vote(out.removal_id, { machine_id: 'v2', vote: 'yes' }).code, 'VOTE_WINDOW_OVER');
  });

  it('a removed machine may apply again and goes through admission, not an automatic pass', () => {
    const { sm } = harness();
    sm.seedFounder('m1');
    const r = sm.requestAdmission({ machine_id: 'm2' });
    sm.decide(r.request_id, { decision: 'approve', decided_by: 'm1' });
    sm.remove('m2', { requested_by: 'm1' });
    const again = sm.requestAdmission({ machine_id: 'm2' });
    assert.equal(again.state, ADMISSION.PENDING);
    assert.equal(sm.isMember('m2'), false);
  });
});
