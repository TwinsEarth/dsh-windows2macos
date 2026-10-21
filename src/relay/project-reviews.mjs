/**
 * Project reviews (M5, v1.3.10-beta.16 slice).
 *
 * A review is a control-plane task: it points at a content-addressed patch/artifact and asks maintainers for a verdict. The
 * verdict is a decision record, not a mutable flag: "approve" and "changes_requested" accumulate as history, and the review
 * status follows from those records. That is what lets a merge gate ask "does this exact patch sha have an approval?" and get
 * an answer that cannot be edited afterwards.
 *
 * Rules (docs/COLLAB/M5-MULTI-CLIENT-PRIMITIVES.md §3):
 *  - only maintainer/owner may be a reviewer, and only the listed reviewers may decide;
 *  - nobody reviews their own request (an owner may override, and the override is recorded);
 *  - a reviewer may not record the same verdict twice; a second approve on the same review is a refusal, not a no-op;
 *  - any changes_requested closes the round; the submitter opens a new review for a new revision;
 *  - approvals reach required_approvals -> approved; a due date can expire a pending review.
 */
export const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'changes_requested', 'expired']);
export const REVIEW_DECISIONS = Object.freeze(['approve', 'changes_requested', 'comment']);
const REVIEWER_ROLES = Object.freeze(['maintainer', 'owner']);

export class ReviewError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
    this.detail = detail;
  }
}

const memberKey = (member) => (member && typeof member.kind === 'string' && typeof member.id === 'string' ? member.kind + ':' + member.id : null);

export function createProjectReviews({ now = () => Date.now(), onEvent = null } = {}) {
  const reviews = new Map();
  let counter = 0;
  let seq = 0;

  const emit = (type, payload) => {
    seq += 1;
    const event = { seq, type, at: new Date(now()).toISOString(), payload };
    if (typeof onEvent === 'function') onEvent(event);
    return event;
  };

  /** Expire pending reviews whose due date passed; each expiry is an event. */
  const expireDue = () => {
    const expired = [];
    for (const review of reviews.values()) {
      if (review.status === 'pending' && review.due_at_ms !== null && review.due_at_ms <= now()) {
        review.status = 'expired';
        expired.push(review);
        emit('review.expired', { review_id: review.review_id, project_id: review.project_id, target: review.target });
      }
    }
    return expired;
  };

  const describe = (review) => ({
    review_id: review.review_id,
    project_id: review.project_id,
    target: { ...review.target },
    requested_by: { ...review.requested_by },
    reviewers: review.reviewers.map((entry) => ({ ...entry })),
    required_approvals: review.required_approvals,
    status: review.status,
    decisions: review.decisions.map((decision) => ({ ...decision })),
    created_at: review.created_at,
    due_at: review.due_at,
    approvals: review.decisions.filter((decision) => decision.decision === 'approve').length,
  });

  const approvalsOf = (review) => new Set(review.decisions.filter((decision) => decision.decision === 'approve').map((decision) => memberKey(decision.reviewer))).size;

  return {
    create({ projectId, target, requestedBy, reviewers, requiredApprovals = 1, dueAt = null, roleOf = null, allowSelfReview = false }) {
      if (typeof projectId !== 'string' || projectId === '') throw new ReviewError('INVALID_PROJECT', 'project_id is required');
      if (!target || typeof target !== 'object' || !/^[0-9a-f]{64}$/.test(String(target.sha256 ?? ''))) throw new ReviewError('INVALID_TARGET', 'target needs a sha256', { target });
      if (!['patch', 'artifact'].includes(target.kind)) throw new ReviewError('INVALID_TARGET', 'target.kind must be patch or artifact', { kind: target.kind });
      if (memberKey(requestedBy) === null) throw new ReviewError('INVALID_REQUESTER', 'requested_by needs kind and id');
      if (!Array.isArray(reviewers) || reviewers.length === 0) throw new ReviewError('INVALID_REVIEWERS', 'at least one reviewer is required');
      if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1) throw new ReviewError('INVALID_APPROVALS', 'required_approvals must be a positive integer');
      for (const reviewer of reviewers) {
        if (memberKey(reviewer) === null) throw new ReviewError('INVALID_REVIEWERS', 'every reviewer needs kind and id', { reviewer });
        if (memberKey(reviewer) === memberKey(requestedBy) && !allowSelfReview) {
          return { ok: false, code: 'REVIEW_SELF_NOT_ALLOWED', reviewer };
        }
        if (typeof roleOf === 'function') {
          const role = roleOf(reviewer);
          if (!REVIEWER_ROLES.includes(role)) return { ok: false, code: 'REVIEW_PERMISSION', reviewer, role, required_role: 'maintainer' };
        }
      }
      counter += 1;
      const reviewId = 'rv-' + String(counter).padStart(6, '0');
      const dueMs = dueAt === null ? null : Date.parse(dueAt);
      const review = {
        review_id: reviewId,
        project_id: projectId,
        target: { kind: target.kind, sha256: String(target.sha256), source_task_id: target.source_task_id ?? null, diffstat: target.diffstat ?? null },
        requested_by: { ...requestedBy },
        reviewers: reviewers.map((reviewer) => ({ kind: reviewer.kind, id: reviewer.id })),
        required_approvals: requiredApprovals,
        status: 'pending',
        decisions: [],
        created_at: new Date(now()).toISOString(),
        due_at: dueMs === null || Number.isNaN(dueMs) ? null : new Date(dueMs).toISOString(),
        due_at_ms: dueMs === null || Number.isNaN(dueMs) ? null : dueMs,
      };
      reviews.set(reviewId, review);
      emit('review.requested', { review_id: reviewId, project_id: projectId, target: review.target, requested_by: review.requested_by, reviewers: review.reviewers, required_approvals: requiredApprovals });
      if (allowSelfReview && reviewers.some((reviewer) => memberKey(reviewer) === memberKey(requestedBy))) {
        emit('review.self_review_override', { review_id: reviewId, project_id: projectId, requested_by: review.requested_by });
      }
      return { ok: true, review: describe(review) };
    },
    decide({ reviewId, reviewer, decision, comment = null, findings = [] }) {
      expireDue();
      const review = reviews.get(reviewId);
      if (review === undefined) return { ok: false, code: 'REVIEW_NOT_FOUND', review_id: reviewId };
      if (!REVIEW_DECISIONS.includes(decision)) throw new ReviewError('INVALID_DECISION', 'unknown decision', { decision });
      if (memberKey(reviewer) === null || !review.reviewers.some((entry) => memberKey(entry) === memberKey(reviewer))) {
        return { ok: false, code: 'REVIEW_PERMISSION', reviewer, reviewers: review.reviewers };
      }
      if (review.status === 'expired') return { ok: false, code: 'REVIEW_EXPIRED', review_id: reviewId };
      const sameDirection = review.decisions.some((existing) => memberKey(existing.reviewer) === memberKey(reviewer) && existing.decision === decision);
      if (sameDirection) return { ok: false, code: 'REVIEW_ALREADY_DECIDED', review_id: reviewId, decision };
      if (review.status === 'changes_requested' && decision !== 'comment') {
        return { ok: false, code: 'REVIEW_ALREADY_DECIDED', review_id: reviewId, status: review.status };
      }
      const record = {
        reviewer: { kind: reviewer.kind, id: reviewer.id },
        decision,
        comment: typeof comment === 'string' ? comment : null,
        findings: Array.isArray(findings) ? findings.map((finding) => ({ file: finding?.file ?? null, line: Number.isInteger(finding?.line) ? finding.line : null, severity: finding?.severity ?? null, text: finding?.text ?? null })) : [],
        decided_at: new Date(now()).toISOString(),
      };
      review.decisions.push(record);
      if (decision === 'approve' && review.status === 'pending' && approvalsOf(review) >= review.required_approvals) review.status = 'approved';
      if (decision === 'changes_requested') review.status = 'changes_requested';
      emit('review.decided', { review_id: reviewId, project_id: review.project_id, reviewer: record.reviewer, decision, comment: record.comment, findings: record.findings, status: review.status });
      if (review.status === 'approved') emit('review.approved', { review_id: reviewId, project_id: review.project_id, target: review.target, approvals: approvalsOf(review) });
      if (review.status === 'changes_requested') emit('review.changes_requested', { review_id: reviewId, project_id: review.project_id, target: review.target, reviewer: record.reviewer });
      return { ok: true, review: describe(review), decision: record };
    },
    get({ reviewId }) {
      expireDue();
      const review = reviews.get(reviewId);
      return review === undefined ? null : describe(review);
    },
    list({ projectId, status = null }) {
      expireDue();
      return [...reviews.values()]
        .filter((review) => review.project_id === projectId && (status === null || review.status === status))
        .map((review) => ({ review_id: review.review_id, target: review.target, status: review.status, approvals: approvalsOf(review), required_approvals: review.required_approvals, created_at: review.created_at, due_at: review.due_at }));
    },
    /** Merge gate (§3.2): is this exact patch sha approved by a review on this project? */
    approvedFor({ projectId, sha256 }) {
      expireDue();
      const approved = [...reviews.values()].find((review) => review.project_id === projectId && review.status === 'approved' && review.target.sha256 === sha256);
      return approved === undefined ? { ok: false, code: 'REVIEW_REQUIRED', sha256 } : { ok: true, review_id: approved.review_id };
    },
    size() { return { reviews: reviews.size, events: seq }; },
  };
}
