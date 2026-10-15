/**
 * Cross-session approval index suite (v4.9.0).
 *
 * The harness is a local copy rather than a shared import, matching the convention in
 * test/authority.test.mjs and test/blocks.test.mjs.
 *
 * What these tests protect, said once: a supervisor's queue is a place where **authority is the only
 * thing standing between a request and its approval**. So the cases below are mostly about who must NOT
 * be able to act — a peer, the requester itself, an actor below the required band — and about the queue
 * staying honest, which means showing work that exists rather than only work the viewer can answer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX_REFUSAL, createApprovalIndex } from '../src/agent/approval-index.mjs';

/** A controllable clock, so retention is tested without waiting. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, at: () => t };
}

function index(options = {}) {
  const c = options.clock ?? clock();
  const audited = [];
  const idx = createApprovalIndex({ now: c.now, audit: (e, d) => audited.push({ e, d }), ...options });
  return { idx, clock: c, audited };
}

/** Register a request from an ordinary actor. */
function pending(idx, over = {}) {
  const approvalId = over.approvalId ?? 'ap-1';
  const result = idx.register({
    approvalId,
    sessionKey: over.sessionKey ?? 'im:window-1',
    subject: over.subject ?? { id: 'worker-a', level: 10 },
    action: over.action ?? 'write:src/agent/exec.mjs',
    toolName: over.toolName ?? 'write',
    reason: over.reason ?? 'needs to edit the executor',
    ...(over.openedAt === undefined ? {} : { openedAt: over.openedAt }),
    ...(over.deadlineAt === undefined ? {} : { deadlineAt: over.deadlineAt }),
  });
  return { approvalId, result };
}

describe('approval index: registration refuses what it cannot place', () => {
  it('registers a normal request', () => {
    const { idx } = index();
    const { result } = pending(idx);
    assert.equal(result.ok, true);
    assert.equal(idx.size, 1);
  });

  it('refuses a subject with no usable authority level rather than defaulting one', () => {
    // The decision rests on this number. Guessing it would be inventing the one fact that matters.
    const { idx } = index();
    for (const bad of [undefined, null, '10', 10.5, -1, 101]) {
      const r = idx.register({ approvalId: 'x', subject: { id: 'a', level: bad }, action: 'w' });
      assert.equal(r.ok, false, `${JSON.stringify(bad)}`);
      assert.equal(r.reason_code, INDEX_REFUSAL.NO_SUBJECT_LEVEL);
    }
    assert.equal(idx.size, 0);
  });

  it('refuses an empty approval id or action', () => {
    const { idx } = index();
    assert.equal(idx.register({ approvalId: '', subject: { level: 10 }, action: 'w' }).ok, false);
    assert.equal(idx.register({ approvalId: 'a', subject: { level: 10 }, action: '  ' }).ok, false);
  });
});

describe('approval index: the chain, asserted from both sides', () => {
  it('lets a captain approve an ordinary actor at exactly the required level', () => {
    // Level 50 is the floor for approving a level-10 subject, so it is asserted as allowed -- and level 49
    // as refused in the next case. A single middle value would pass whether or not the boundary was right.
    const { idx } = index();
    pending(idx, { subject: { id: 'worker-a', level: 10 } });
    const check = idx.mayAct('ap-1', { id: 'cap-a', level: 50 });
    assert.equal(check.allowed, true, check.detail ?? '');
    assert.equal(check.required, 50);
  });

  it('refuses one level below', () => {
    const { idx } = index();
    pending(idx, { subject: { id: 'worker-a', level: 10 } });
    const check = idx.mayAct('ap-1', { id: 'worker-b', level: 49 });
    assert.equal(check.allowed, false);
    assert.equal(check.reason_code, INDEX_REFUSAL.INSUFFICIENT_AUTHORITY);
    assert.equal(check.required, 50);
  });

  it('refuses a peer, which is a ring rather than a chain', () => {
    const { idx } = index();
    pending(idx, { subject: { id: 'cap-a', level: 50 } });
    const check = idx.mayAct('ap-1', { id: 'cap-b', level: 50 });
    assert.equal(check.allowed, false);
    assert.equal(check.reason_code, INDEX_REFUSAL.INSUFFICIENT_AUTHORITY);
    assert.equal(check.required, 70);
  });

  it('refuses self-approval, and says that is what it is', () => {
    // Distinguished from "insufficient" because the two need different responses: one is escalation, the
    // other is an identity mistake. A reader who cannot tell them apart will escalate the wrong thing.
    const { idx } = index();
    pending(idx, { subject: { id: 'cap-a', level: 50 } });
    const check = idx.mayAct('ap-1', { id: 'cap-a', level: 95 });
    assert.equal(check.allowed, false);
    assert.equal(check.reason_code, INDEX_REFUSAL.SELF_APPROVAL, 'a high level must not buy self-approval');
  });

  it('refuses an actor with no usable level', () => {
    const { idx } = index();
    pending(idx);
    const check = idx.mayAct('ap-1', { id: 'x', level: 'admin' });
    assert.equal(check.allowed, false);
    assert.equal(check.reason_code, INDEX_REFUSAL.BAD_ACTOR);
  });

  it('lets the top band sign for itself, because there is nobody above it', () => {
    const { idx } = index();
    pending(idx, { subject: { id: 'sys-a', level: 95 } });
    assert.equal(idx.mayAct('ap-1', { id: 'sys-b', level: 97 }).allowed, true);
  });
});

describe('approval index: the queue stays honest', () => {
  it('lists work the viewer cannot answer, with the reason, rather than hiding it', () => {
    // A filtered list would make the fleet look idle at the moment it is most blocked. The supervisor's
    // first question is "how much is waiting", not "how much is mine".
    const { idx } = index();
    pending(idx, { approvalId: 'low', subject: { id: 'w1', level: 10 } });
    pending(idx, { approvalId: 'high', subject: { id: 'cap-a', level: 50 } });
    const rows = idx.listFor({ id: 'cap-a', level: 50 });
    assert.equal(rows.length, 2, 'both rows must be visible');
    const byId = Object.fromEntries(rows.map((r) => [r.approval_id, r]));
    assert.equal(byId.low.may_act, true);
    assert.equal(byId.high.may_act, false);
    assert.equal(byId.high.why_not.reason_code, INDEX_REFUSAL.SELF_APPROVAL);
    assert.equal(byId.high.required_level, 70);
  });

  it('orders oldest first, because the oldest is closest to its deadline', () => {
    const c = clock();
    const { idx } = index({ clock: c });
    pending(idx, { approvalId: 'newer', openedAt: c.at() });
    c.advance(5000);
    pending(idx, { approvalId: 'oldest', openedAt: c.at() });
    const rows = idx.listFor({ id: 'cap', level: 90 });
    assert.deepEqual(rows.map((r) => r.approval_id), ['newer', 'oldest']);
  });

  it('reports waiting time and lateness', () => {
    const c = clock();
    const { idx } = index({ clock: c });
    pending(idx, { deadlineAt: c.at() + 1000 });
    c.advance(4000);
    const row = idx.listFor({ id: 'cap', level: 90 })[0];
    assert.equal(row.waiting_ms, 4000);
    assert.equal(row.overdue, true);
  });

  it('summarises by session, and counts only what the viewer can act on', () => {
    const { idx } = index();
    pending(idx, { approvalId: 'a', sessionKey: 'im:one', subject: { id: 'w1', level: 10 } });
    pending(idx, { approvalId: 'b', sessionKey: 'im:one', subject: { id: 'cap-x', level: 50 } });
    pending(idx, { approvalId: 'c', sessionKey: 'im:two', subject: { id: 'w2', level: 10 } });
    const s = idx.summary({ id: 'cap-a', level: 50 });
    assert.equal(s.pending, 3);
    assert.equal(s.actionable, 2, 'the captain subject is not the captain viewer\'s to answer');
    assert.deepEqual(s.by_session, { 'im:one': 2, 'im:two': 1 });
  });

  it('keeps a settled row visible briefly, so "did I deal with that" is answerable', () => {
    const c = clock();
    const { idx } = index({ clock: c, settledRetentionMs: 1000 });
    pending(idx);
    assert.equal(idx.decide('ap-1', { id: 'cap', level: 90 }, 'allowed-once').ok, true);
    assert.equal(idx.listFor({ id: 'cap', level: 90 }).length, 0, 'settled work leaves the pending view');
    assert.equal(idx.listFor({ id: 'cap', level: 90 }, { includeSettled: true }).length, 1);
    c.advance(1500);
    assert.equal(idx.listFor({ id: 'cap', level: 90 }, { includeSettled: true }).length, 0, 'and is reaped after the retention window');
  });
});

describe('approval index: settlement is recorded, never invented', () => {
  it('refuses a decision on an unknown request', () => {
    const { idx } = index();
    const r = idx.decide('nope', { id: 'cap', level: 90 }, 'allowed-once');
    assert.equal(r.ok, false);
    assert.equal(r.reason_code, INDEX_REFUSAL.UNKNOWN_REQUEST);
  });

  it('refuses a second settlement of the same request', () => {
    // Two actors answering one request is the race the broker's own single-resolver design exists to
    // prevent; the index must not reintroduce it by accepting both.
    const { idx } = index();
    pending(idx);
    assert.equal(idx.decide('ap-1', { id: 'cap', level: 90 }, 'allowed-once').ok, true);
    const second = idx.decide('ap-1', { id: 'admin', level: 95 }, 'rejected');
    assert.equal(second.ok, false);
    assert.equal(second.reason_code, INDEX_REFUSAL.ALREADY_SETTLED);
  });

  it('refuses a decision from an actor who may not act, without settling', () => {
    const { idx } = index();
    pending(idx, { subject: { id: 'cap-a', level: 50 } });
    const r = idx.decide('ap-1', { id: 'cap-b', level: 50 }, 'allowed-once');
    assert.equal(r.ok, false);
    assert.equal(r.reason_code, INDEX_REFUSAL.INSUFFICIENT_AUTHORITY);
    assert.equal(idx.size, 1, 'a refused decision must leave the request pending');
  });

  it('records a settlement that was not a decision, so the queue stops showing it', () => {
    // The broker's timer delegates, the host cancels on abort, disposal settles everything. A queue that
    // only learned about operator decisions would keep showing requests that are long gone.
    const { idx } = index();
    pending(idx);
    assert.equal(idx.settle('ap-1', 'delegated').ok, true);
    assert.equal(idx.size, 0);
    assert.equal(idx.decide('ap-1', { id: 'cap', level: 90 }, 'allowed-once').reason_code, INDEX_REFUSAL.ALREADY_SETTLED);
  });

  it('refuses to settle an unknown request', () => {
    const { idx } = index();
    assert.equal(idx.settle('nope', 'delegated').reason_code, INDEX_REFUSAL.UNKNOWN_REQUEST);
  });
});

describe('approval index: every state change is audited', () => {
  it('emits register, decide and settle events', () => {
    // The design's auditability requirement: a governance action that leaves no trace cannot be reviewed.
    const { idx, audited } = index();
    pending(idx);
    idx.decide('ap-1', { id: 'cap', level: 90 }, 'allowed-once');
    pending(idx, { approvalId: 'ap-2' });
    idx.settle('ap-2', 'cancelled');
    assert.deepEqual(audited.map((a) => a.e), [
      'approval-index/registered',
      'approval-index/decided',
      'approval-index/registered',
      'approval-index/settled',
    ]);
    assert.equal(audited[1].d.by, 'cap');
    assert.equal(audited[1].d.outcome, 'allowed-once');
  });
});
