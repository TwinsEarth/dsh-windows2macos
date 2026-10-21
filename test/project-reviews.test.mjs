/**
 * Project reviews tests (M5, v1.3.10-beta.16 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectReviews } from '../src/relay/project-reviews.mjs';

const SHA = 'a'.repeat(64);
const submitter = { kind: 'machine', id: 'm-submitter' };
const alice = { kind: 'machine', id: 'm-alice' };
const bob = { kind: 'machine', id: 'm-bob' };
const worker = { kind: 'machine', id: 'm-worker' };
const P = 'prj-r';
const roles = { 'machine:m-alice': 'maintainer', 'machine:m-bob': 'owner', 'machine:m-worker': 'worker', 'machine:m-submitter': 'owner' };
const roleOf = (member) => roles[member.kind + ':' + member.id] ?? null;

function setup() {
  let t = Date.parse('2026-10-22T00:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; return t; } };
  const events = [];
  const reviews = createProjectReviews({ now: clock.now, onEvent: (event) => events.push(event) });
  return { reviews, clock, events };
}

const open = (reviews, overrides = {}) => reviews.create({ projectId: P, target: { kind: 'patch', sha256: SHA, source_task_id: 't-1' }, requestedBy: submitter, reviewers: [alice], roleOf, ...overrides });

describe('project reviews', () => {
  it('creates a review and lists it as pending', () => {
    const { reviews, events } = setup();
    const created = open(reviews);
    assert.equal(created.ok, true);
    assert.equal(created.review.status, 'pending');
    assert.equal(reviews.list({ projectId: P })[0].status, 'pending');
    assert.equal(events.at(-1).type, 'review.requested');
  });

  it('refuses self-review unless an owner overrides it, recording the override', () => {
    const { reviews, events } = setup();
    const denied = open(reviews, { reviewers: [submitter] });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'REVIEW_SELF_NOT_ALLOWED');
    const overridden = open(reviews, { reviewers: [submitter], allowSelfReview: true });
    assert.equal(overridden.ok, true);
    assert.ok(events.some((event) => event.type === 'review.self_review_override'));
  });

  it('refuses a reviewer below maintainer', () => {
    const { reviews } = setup();
    const denied = open(reviews, { reviewers: [worker] });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'REVIEW_PERMISSION');
  });

  it('approves once the required number of distinct approvals is reached', () => {
    const { reviews, events } = setup();
    const created = open(reviews, { reviewers: [alice, bob], requiredApprovals: 2 });
    const reviewId = created.review.review_id;
    const first = reviews.decide({ reviewId, reviewer: alice, decision: 'approve', comment: 'lgtm' });
    assert.equal(first.review.status, 'pending');
    assert.equal(first.review.approvals, 1);
    const second = reviews.decide({ reviewId, reviewer: bob, decision: 'approve' });
    assert.equal(second.review.status, 'approved');
    assert.equal(second.review.approvals, 2);
    assert.ok(events.some((event) => event.type === 'review.approved'));
  });

  it('refuses a duplicate same-direction verdict from one reviewer', () => {
    const { reviews } = setup();
    const reviewId = open(reviews).review.review_id;
    assert.equal(reviews.decide({ reviewId, reviewer: alice, decision: 'approve' }).ok, true);
    const again = reviews.decide({ reviewId, reviewer: alice, decision: 'approve' });
    assert.equal(again.code, 'REVIEW_ALREADY_DECIDED');
  });

  it('closes the round on changes_requested and refuses a later approve', () => {
    const { reviews, events } = setup();
    const reviewId = open(reviews, { reviewers: [alice, bob] }).review.review_id;
    const requested = reviews.decide({ reviewId, reviewer: alice, decision: 'changes_requested', comment: 'fix tests', findings: [{ file: 'src/a.mjs', line: 10, severity: 'high', text: 'missing case' }] });
    assert.equal(requested.review.status, 'changes_requested');
    assert.equal(requested.decision.findings[0].severity, 'high');
    assert.equal(reviews.decide({ reviewId, reviewer: bob, decision: 'approve' }).code, 'REVIEW_ALREADY_DECIDED');
    assert.ok(events.some((event) => event.type === 'review.changes_requested'));
  });

  it('lets a listed reviewer comment without changing the status', () => {
    const { reviews } = setup();
    const reviewId = open(reviews).review.review_id;
    const commented = reviews.decide({ reviewId, reviewer: alice, decision: 'comment', comment: 'question' });
    assert.equal(commented.review.status, 'pending');
  });

  it('refuses a decision from someone who is not a reviewer', () => {
    const { reviews } = setup();
    const reviewId = open(reviews).review.review_id;
    assert.equal(reviews.decide({ reviewId, reviewer: bob, decision: 'approve' }).code, 'REVIEW_PERMISSION');
  });

  it('expires a pending review past its due date and refuses a late decision', () => {
    const { reviews, clock } = setup();
    const reviewId = open(reviews, { dueAt: new Date(clock.now() + 60_000).toISOString() }).review.review_id;
    clock.advance(61_000);
    assert.equal(reviews.get({ reviewId }).status, 'expired');
    assert.equal(reviews.decide({ reviewId, reviewer: alice, decision: 'approve' }).code, 'REVIEW_EXPIRED');
  });

  it('answers the merge gate for an exact sha', () => {
    const { reviews } = setup();
    assert.equal(reviews.approvedFor({ projectId: P, sha256: SHA }).code, 'REVIEW_REQUIRED');
    const reviewId = open(reviews).review.review_id;
    reviews.decide({ reviewId, reviewer: alice, decision: 'approve' });
    const gate = reviews.approvedFor({ projectId: P, sha256: SHA });
    assert.equal(gate.ok, true);
    assert.equal(gate.review_id, reviewId);
    assert.equal(reviews.approvedFor({ projectId: P, sha256: 'b'.repeat(64) }).code, 'REVIEW_REQUIRED');
  });
});
