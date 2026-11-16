/**
 * Project room cross-relay sync tests (Phase 2B: export + deterministic merge).
 *
 * The merge rules are the contract here: every test merges the same two exports on both sides, so a
 * "both relays converge" assertion is what proves determinism, and a second merge is what proves
 * idempotency. A few tests also cover the small snapshot/restore hooks the merge writes through.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Persistence } from '../src/relay/persistence.mjs';
import { RabbitState } from '../src/relay/state.mjs';
import { createProjectRoom } from '../src/relay/project-room.mjs';
import { createProjectLocks } from '../src/relay/project-locks.mjs';
import { createProjectReviews } from '../src/relay/project-reviews.mjs';
import { createProjectRefs } from '../src/relay/project-refs.mjs';
import { createProjectNotifications } from '../src/relay/project-notifications.mjs';
import { exportProjectState, MAX_NOTIFICATIONS_PER_PROJECT, mergeProjectState } from '../src/relay/project-sync.mjs';

const BASE_TS = Date.parse('2026-11-16T00:00:00Z');
const PROJECT_ID = 'prj-sync';
const OWNER = { kind: 'operator', id: 'lead', name: 'lead' };
const WORKER_A = { kind: 'machine', id: 'm-a' };
const WORKER_B = { kind: 'machine', id: 'm-b' };
const READER_A = { kind: 'machine', id: 'm-reader-a' };
const READER_B = { kind: 'machine', id: 'm-reader-b' };
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const PATCH_A = 'd'.repeat(64);
const PATCH_B = 'e'.repeat(64);
const COMMIT_A = '1'.repeat(40);
const COMMIT_B = '2'.repeat(40);

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-project-sync-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
});

function makeClock(startMs = BASE_TS) {
  let current = startMs;
  return {
    now: () => current,
    set: (ms) => { current = ms; },
    advance: (ms) => { current += ms; return current; },
  };
}

/** Mirror of the test helper in cluster-sync.test.mjs: a real state backed by a temp directory. */
function makeState({ dir = tempDir(), clock = makeClock() } = {}) {
  const persistence = new Persistence({ dir, now: clock.now });
  const state = new RabbitState({ persistence, now: clock.now });
  state.setPersistence(persistence);
  return { state, clock, persistence };
}

function makeMemoryState(clock = makeClock()) {
  return { state: new RabbitState({ now: clock.now }), clock };
}

function setupProject(state, { name = 'sync-demo' } = {}) {
  const created = state.projects.createProject({ projectId: PROJECT_ID, name, origin: { kind: 'git', url: 'https://example.invalid/repo.git' }, createdBy: OWNER });
  assert.equal(created.project.project.project_id, PROJECT_ID);
  return PROJECT_ID;
}

function exportOne(state, projectId = PROJECT_ID) {
  const found = exportProjectState(state).find((entry) => entry.project_id === projectId);
  assert.ok(found, 'project ' + projectId + ' must be exported');
  return found;
}

function memberOf(exported, member) {
  return exported.members.find((entry) => entry.kind === member.kind && entry.id === member.id) ?? null;
}

/**
 * A stable semantic view of one exported project: what two relays must agree on. Local-only fields
 * (`seq`, per-relay `created_at` of imported rows, ...) are intentionally excluded.
 */
function semantic(exported) {
  const byKey = (key) => (left, right) => (String(left[key] ?? '') < String(right[key] ?? '') ? -1 : String(left[key] ?? '') > String(right[key] ?? '') ? 1 : 0);
  return {
    project_id: exported.project_id,
    name: exported.project.name,
    settings: exported.project.settings,
    members: exported.members.map((member) => ({ kind: member.kind, id: member.id, name: member.name, role: member.role, joined_at: member.joined_at })).sort((left, right) => (left.kind + '\u0000' + left.id < right.kind + '\u0000' + right.id ? -1 : 1)),
    event_hashes: exported.events.map((event) => event.event_hash).sort(),
    artifacts: exported.artifacts.map((artifact) => ({ sha256: artifact.sha256, bytes: artifact.bytes, kind: artifact.kind, source_task_id: artifact.source_task_id })).sort(byKey('sha256')),
    decisions: exported.decisions.map((decision) => ({ decision_id: decision.decision_id, title: decision.title, text: decision.text, kind: decision.kind })).sort(byKey('decision_id')),
    memory: exported.memory === null ? null : { version: exported.memory.version, text: exported.memory.text },
    refs: exported.refs.map((ref) => ({ branch: ref.branch, head_commit: ref.head_commit, version: ref.version })).sort(byKey('branch')),
    locks: exported.locks.map((lock) => ({ lock_id: lock.lock_id, kind: lock.kind, target: lock.target, holder: lock.holder, state: lock.state })).sort(byKey('lock_id')),
    reviews: exported.reviews.map((review) => ({ review_id: review.review_id, target: review.target, status: review.status, decisions: review.decisions.map((decision) => decision.decision) })).sort(byKey('review_id')),
    notifications: exported.notifications.map((notification) => ({ notification_id: notification.notification_id, kind: notification.kind, subject: notification.subject, created_at_ms: notification.created_at_ms })).sort(byKey('notification_id')),
    read_marks: exported.read_marks.map((mark) => ({ reader_kind: mark.reader_kind, reader_id: mark.reader_id, watermark_ms: mark.watermark_ms })).sort(byKey('reader_id')),
  };
}

/* ------------------------------------------------------------------ */
/* export / merge                                                      */
/* ------------------------------------------------------------------ */

describe('project state sync', () => {
  it('converges two relays and is idempotent on the second merge', () => {
    const a = makeState();
    const b = makeState();
    setupProject(a.state);
    setupProject(b.state);

    // A's contributions.
    a.state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_A, role: 'worker' });
    a.state.registerArtifact({ projectId: PROJECT_ID, sha256: SHA_A, bytes: 11, kind: 'patch', sourceTaskId: 't-a' });
    a.state.addDecision({ projectId: PROJECT_ID, title: 'use main', text: 'decided by A', actor: OWNER });
    a.state.setProjectMemory({ projectId: PROJECT_ID, text: 'memory from A', actor: OWNER });
    a.state.refs.advance({ projectId: PROJECT_ID, branch: 'main', from: null, to: COMMIT_A });
    assert.equal(a.state.locks.acquire({ projectId: PROJECT_ID, kind: 'branch', target: { branch: 'main' }, holder: WORKER_A }).ok, true);
    a.state.reviews.create({ projectId: PROJECT_ID, target: { kind: 'patch', sha256: PATCH_A }, requestedBy: WORKER_A, reviewers: [OWNER] });
    a.state.notifications.notify({ projectId: PROJECT_ID, kind: 'task.assigned', target: { kind: 'machine', id: WORKER_A.id }, subject: 'take it', refs: { task_id: 't-a' } });
    a.state.notifications.markRead({ projectId: PROJECT_ID, reader: READER_A, watermarkMs: BASE_TS + 1_000 });

    // B's contributions.
    b.state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_B, role: 'worker' });
    b.state.registerArtifact({ projectId: PROJECT_ID, sha256: SHA_B, bytes: 22, kind: 'artifact' });
    b.state.addDecision({ projectId: PROJECT_ID, title: 'ship it' });
    b.state.refs.advance({ projectId: PROJECT_ID, branch: 'dev', from: null, to: COMMIT_B });
    assert.equal(b.state.locks.acquire({ projectId: PROJECT_ID, kind: 'file', target: { path: 'src/x.mjs' }, holder: WORKER_B }).ok, true);
    b.state.reviews.create({ projectId: PROJECT_ID, target: { kind: 'artifact', sha256: SHA_C }, requestedBy: WORKER_B, reviewers: [OWNER] });
    b.state.notifications.notify({ projectId: PROJECT_ID, kind: 'mention', target: { kind: 'machine', id: WORKER_B.id }, subject: 'ping', refs: { task_id: 't-b' } });
    b.state.notifications.markRead({ projectId: PROJECT_ID, reader: READER_B, watermarkMs: BASE_TS + 2_000 });

    const exportA = exportOne(a.state);
    const exportB = exportOne(b.state);
    const expectedHashes = [...new Set([...exportA.events.map((event) => event.event_hash), ...exportB.events.map((event) => event.event_hash)])].sort();
    // Both relays independently created a decision. Ids are state-scoped (`inst-` prefix), so these are
    // two distinct objects that must both survive the merge rather than collapse into a conflict.
    assert.equal(exportA.project.name, exportB.project.name);

    const aMerged = mergeProjectState(a.state, exportB, { nowMs: BASE_TS + 60_000 });
    const bMerged = mergeProjectState(b.state, exportA, { nowMs: BASE_TS + 60_000 });
    assert.equal(aMerged.changed, true);
    assert.equal(bMerged.changed, true);
    assert.equal(aMerged.conflicts, 0, 'state-scoped ids make independent objects distinct, not conflicting');

    const eventsAfterFirstMerge = a.state.projects.allEvents().length;
    const secondA = mergeProjectState(a.state, exportOne(b.state), { nowMs: BASE_TS + 60_000 });
    const secondB = mergeProjectState(b.state, exportOne(a.state), { nowMs: BASE_TS + 60_000 });
    assert.equal(secondA.changed, false, 'a repeated merge must not change anything');
    assert.equal(secondB.changed, false);
    assert.equal(secondA.conflicts, 0, 'after convergence no conflict is left to report');
    assert.equal(secondB.conflicts, 0);
    assert.equal(a.state.projects.allEvents().length, eventsAfterFirstMerge, 'no event may be imported twice');

    const finalA = semantic(exportOne(a.state));
    const finalB = semantic(exportOne(b.state));
    assert.deepEqual(finalA, finalB);
    assert.deepEqual(finalA.event_hashes, expectedHashes);
    assert.equal(finalA.members.length, 3, 'owner + both workers converge');
    assert.equal(memberOf(exportOne(a.state), WORKER_B).role, 'worker');
    assert.equal(finalA.artifacts.length, 2);
    assert.equal(finalA.decisions.length, 2, 'both relays keep their own state-scoped decision');
    assert.equal(finalA.memory.text, 'memory from A');
    assert.equal(finalA.read_marks.length, 2);
    assert.equal(finalA.notifications.some((row) => row.subject === 'take it'), true);
  });

  it('hashes events by the fixed tuple and imports the union once', () => {
    const a = makeState();
    const b = makeState();
    setupProject(a.state);
    setupProject(b.state);
    a.state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_A, role: 'worker' });
    b.state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_B, role: 'worker' });

    const exportA = exportOne(a.state);
    const exportB = exportOne(b.state);
    const createdA = exportA.events.find((event) => event.type === 'project.created');
    const createdB = exportB.events.find((event) => event.type === 'project.created');
    const expected = createHash('sha256')
      .update(JSON.stringify([createdA.project_id, createdA.type, createdA.actor, createdA.payload, createdA.at]), 'utf8')
      .digest('hex');
    assert.equal(createdA.event_hash, expected);
    assert.equal(createdB.event_hash, expected, 'identical event content has the same hash on both relays');
    assert.equal(createdA.event_hash.length, 64);

    const union = new Set([...exportA.events.map((event) => event.event_hash), ...exportB.events.map((event) => event.event_hash)]);
    const first = mergeProjectState(a.state, exportB, { nowMs: BASE_TS + 1_000 });
    assert.equal(first.changed, true);
    const afterFirst = exportOne(a.state);
    assert.deepEqual([...new Set(afterFirst.events.map((event) => event.event_hash))].sort(), [...union].sort());
    assert.equal(afterFirst.events.length, union.size, 'the identical project.created event is not stored twice');

    const count = afterFirst.events.length;
    const second = mergeProjectState(a.state, exportOne(b.state), { nowMs: BASE_TS + 1_000 });
    assert.equal(second.changed, false);
    assert.equal(exportOne(a.state).events.length, count);
  });

  it('adopts newer project metadata and keeps a tie deterministic', () => {
    const a = makeState({ clock: makeClock(BASE_TS) });
    const b = makeState({ clock: makeClock(BASE_TS + 10_000) });
    setupProject(a.state, { name: 'alpha' });
    setupProject(b.state, { name: 'zeta' });

    const exportA = exportOne(a.state);
    const exportB = exportOne(b.state);
    mergeProjectState(a.state, exportB, { nowMs: BASE_TS + 20_000 });
    mergeProjectState(b.state, exportA, { nowMs: BASE_TS + 20_000 });
    assert.equal(exportOne(a.state).project.name, 'zeta');
    assert.equal(exportOne(b.state).project.name, 'zeta');

    const second = mergeProjectState(a.state, exportOne(b.state), { nowMs: BASE_TS + 20_000 });
    assert.equal(second.changed, false);
    assert.equal(second.conflicts, 0);
  });

  it('converges member removal and resolves concurrent roles deterministically', () => {
    const a = makeState({ clock: makeClock(BASE_TS) });
    const b = makeState({ clock: makeClock(BASE_TS + 1_000) });
    setupProject(a.state);
    setupProject(b.state);
    a.state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_A, role: 'worker' });
    b.state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_A, role: 'observer' });

    mergeProjectState(a.state, exportOne(b.state), { nowMs: BASE_TS + 2_000 });
    mergeProjectState(b.state, exportOne(a.state), { nowMs: BASE_TS + 2_000 });
    assert.equal(memberOf(exportOne(a.state), WORKER_A).role, 'observer', 'the later member event wins');
    assert.equal(memberOf(exportOne(b.state), WORKER_A).role, 'observer');

    a.clock.set(BASE_TS + 2_000);
    a.state.projects.removeMember({ projectId: PROJECT_ID, member: WORKER_A });
    const exportA2 = exportOne(a.state);
    const exportB2 = exportOne(b.state);
    mergeProjectState(b.state, exportA2, { nowMs: BASE_TS + 3_000 });
    mergeProjectState(a.state, exportB2, { nowMs: BASE_TS + 3_000 });
    assert.equal(memberOf(exportOne(a.state), WORKER_A), null, 'the removal must not be resurrected by the fallback list');
    assert.equal(memberOf(exportOne(b.state), WORKER_A), null);

    const again = mergeProjectState(a.state, exportOne(b.state), { nowMs: BASE_TS + 3_000 });
    assert.equal(again.changed, false);
    assert.equal(memberOf(exportOne(a.state), WORKER_A), null);
  });

  it('takes the higher memory version and the later update on a version tie', () => {
    const a = makeState({ clock: makeClock(BASE_TS) });
    const b = makeState({ clock: makeClock(BASE_TS + 1_000) });
    setupProject(a.state);
    setupProject(b.state);
    a.state.setProjectMemory({ projectId: PROJECT_ID, text: 'alpha v1', actor: OWNER });
    b.state.setProjectMemory({ projectId: PROJECT_ID, text: 'beta v1', actor: OWNER });

    mergeProjectState(a.state, exportOne(b.state), { nowMs: BASE_TS + 2_000 });
    mergeProjectState(b.state, exportOne(a.state), { nowMs: BASE_TS + 2_000 });
    assert.equal(a.state.getProjectMemory({ projectId: PROJECT_ID }).text, 'beta v1', 'a version tie goes to the later updated_at');
    assert.equal(b.state.getProjectMemory({ projectId: PROJECT_ID }).text, 'beta v1');

    // A writes version 2 with an *earlier* wall clock: version must outrank time.
    a.clock.set(BASE_TS - 5_000);
    a.state.setProjectMemory({ projectId: PROJECT_ID, text: 'alpha v2', actor: OWNER });
    mergeProjectState(b.state, exportOne(a.state), { nowMs: BASE_TS + 3_000 });
    mergeProjectState(a.state, exportOne(b.state), { nowMs: BASE_TS + 3_000 });
    assert.equal(a.state.getProjectMemory({ projectId: PROJECT_ID }).version, 2);
    assert.equal(b.state.getProjectMemory({ projectId: PROJECT_ID }).version, 2);
    assert.equal(a.state.getProjectMemory({ projectId: PROJECT_ID }).text, 'alpha v2');
    assert.equal(b.state.getProjectMemory({ projectId: PROJECT_ID }).text, 'alpha v2');
  });

  it('drops expired locks and merges refs, reviews, notifications and read marks', () => {
    const a = makeState({ clock: makeClock(BASE_TS) });
    const b = makeState({ clock: makeClock(BASE_TS) });
    setupProject(a.state);
    setupProject(b.state);

    a.state.refs.advance({ projectId: PROJECT_ID, branch: 'main', from: null, to: COMMIT_A });
    a.state.reviews.create({ projectId: PROJECT_ID, target: { kind: 'patch', sha256: PATCH_A }, requestedBy: WORKER_A, reviewers: [OWNER] });
    a.state.notifications.notify({ projectId: PROJECT_ID, kind: 'task.assigned', target: { kind: 'machine', id: WORKER_A.id }, subject: 'a-one', refs: { task_id: 't-a' } });

    // B: one lock that expires, one that stays live, later ref/review/notifications.
    b.state.locks.acquire({ projectId: PROJECT_ID, kind: 'branch', target: { branch: 'stale' }, holder: WORKER_B, leaseMs: 1_000 });
    b.clock.advance(5_000);
    b.state.locks.acquire({ projectId: PROJECT_ID, kind: 'file', target: { path: 'src/b.mjs' }, holder: WORKER_B, leaseMs: 3_600_000 });
    b.state.refs.advance({ projectId: PROJECT_ID, branch: 'main', from: null, to: COMMIT_B });
    const reviewBId = b.state.reviews.create({ projectId: PROJECT_ID, target: { kind: 'patch', sha256: PATCH_B }, requestedBy: WORKER_A, reviewers: [OWNER] }).review.review_id;
    b.state.reviews.decide({ reviewId: reviewBId, reviewer: OWNER, decision: 'approve' });
    b.state.notifications.notify({ projectId: PROJECT_ID, kind: 'review.decided', target: { kind: 'machine', id: WORKER_A.id }, subject: 'b-one', refs: { review_id: reviewBId } });
    b.state.notifications.notify({ projectId: PROJECT_ID, kind: 'review.decided', target: { kind: 'machine', id: WORKER_B.id }, subject: 'b-two', refs: { review_id: reviewBId } });
    a.state.notifications.markRead({ projectId: PROJECT_ID, reader: READER_A, watermarkMs: 111 });
    b.state.notifications.markRead({ projectId: PROJECT_ID, reader: READER_B, watermarkMs: 222 });

    const atMs = b.clock.now();
    mergeProjectState(a.state, exportOne(b.state), { nowMs: atMs });
    mergeProjectState(b.state, exportOne(a.state), { nowMs: atMs });

    const locksA = exportOne(a.state).locks;
    const locksB = exportOne(b.state).locks;
    assert.equal(locksA.length, 1, 'the expired lock is not imported (and local expired rows are dropped)');
    assert.equal(locksB.length, 1);
    assert.ok(locksA[0].lock_id.endsWith('-000002'), 'the live lock is the one that survives');
    assert.equal(a.state.locks.list({ projectId: PROJECT_ID }).length, 1);
    assert.equal(a.state.refs.head({ projectId: PROJECT_ID, branch: 'main' }).head_commit, COMMIT_B, 'the later ref wins');
    assert.equal(b.state.refs.head({ projectId: PROJECT_ID, branch: 'main' }).head_commit, COMMIT_B);

    const reviewsA = exportOne(a.state).reviews;
    assert.equal(reviewsA.length, 2, 'state-scoped ids keep both reviews');
    assert.equal(reviewsA.some((row) => row.target.sha256 === PATCH_A), true);
    assert.equal(reviewsA.some((row) => row.target.sha256 === PATCH_B && row.status === 'approved'), true);
    assert.deepEqual(semantic(exportOne(a.state)).reviews, semantic(exportOne(b.state)).reviews);

    // Room events such as `ref.advanced` materialise their own notifications, so the exact ids are
    // not hand-written here; what matters is that both relays end with the same union.
    const notificationsA = exportOne(a.state).notifications;
    const notificationsB = exportOne(b.state).notifications;
    assert.deepEqual(notificationsA, notificationsB);
    assert.ok(notificationsA.length >= 3, 'two manual rows on B plus one manual row on A at minimum');
    assert.equal(notificationsA.some((row) => row.subject === 'b-one'), true);
    assert.equal(notificationsA.some((row) => row.subject === 'b-two'), true);
    assert.deepEqual(semantic(exportOne(a.state)).read_marks, semantic(exportOne(b.state)).read_marks);
    assert.equal(semantic(exportOne(a.state)).read_marks.length, 2, 'each reader takes the larger watermark');

    const again = mergeProjectState(b.state, exportOne(a.state), { nowMs: atMs });
    assert.equal(again.changed, false);
    assert.equal(again.conflicts, 0);
  });

  it('keeps only the newest notifications per project', () => {
    const clock = makeClock();
    const a = makeMemoryState(clock);
    const b = makeMemoryState();
    setupProject(a.state);
    setupProject(b.state);
    for (let index = 0; index < MAX_NOTIFICATIONS_PER_PROJECT + 5; index += 1) {
      // More than a minute apart: the module rate-limits >120 rows/minute into a digest row.
      clock.advance(61_000);
      a.state.notifications.notify({ projectId: PROJECT_ID, kind: 'mention', target: { kind: 'machine', id: 'm-x' }, subject: 'n-' + index, refs: { task_id: 't-' + index } });
    }
    mergeProjectState(b.state, exportOne(a.state), { nowMs: clock.now() });
    mergeProjectState(a.state, exportOne(b.state), { nowMs: clock.now() });
    const exported = exportOne(a.state).notifications;
    assert.equal(exported.length, MAX_NOTIFICATIONS_PER_PROJECT);
    assert.equal(exported.some((row) => row.refs.task_id === 't-0'), false, 'the oldest rows are dropped');
    assert.equal(exported.some((row) => row.refs.task_id === 't-' + (MAX_NOTIFICATIONS_PER_PROJECT + 4)), true);
    assert.deepEqual(semantic(exportOne(a.state)).notifications, semantic(exportOne(b.state)).notifications);
  });

  it('tolerates malformed remote state, counts conflicts and never throws', () => {
    const { state } = makeState();
    setupProject(state);
    assert.deepEqual(mergeProjectState(state, null), { changed: false, conflicts: 1 });
    assert.deepEqual(mergeProjectState(state, []), { changed: false, conflicts: 1 });
    assert.deepEqual(mergeProjectState(state, { project_id: '' }), { changed: false, conflicts: 1 });
    // A project that does not exist locally is imported, not treated as malformed.
    assert.equal(mergeProjectState(state, { project_id: 'prj-new', project: { project_id: 'prj-new', name: 'new' } }).changed, true);
    const eventsBefore = state.projects.allEvents().length;

    const merged = mergeProjectState(state, {
      project_id: PROJECT_ID,
      project: { project_id: PROJECT_ID },
      members: [null, { kind: 'machine' }, { kind: 'machine', id: 'm-ok', role: 'worker' }],
      events: [
        { nope: true },
        { project_id: 'other-project', type: 'x', at: '2026-11-16T00:00:00Z', actor: OWNER, payload: {} },
        { project_id: PROJECT_ID, type: 'member.added', at: 'not-a-date', actor: WORKER_A, payload: { role: 'worker' } },
        { project_id: PROJECT_ID, type: 'member.added', at: '2026-11-16T00:00:01Z', actor: WORKER_B, payload: { role: 'worker' }, origin: 'node-b' },
      ],
      artifacts: [null, { sha256: 'zzz' }, { sha256: SHA_B, project_id: PROJECT_ID, bytes: 5, kind: 'artifact' }],
      decisions: [{}, { decision_id: 'prj-sync-d0002', project_id: PROJECT_ID, title: 'valid decision' }],
      memory: 'not-a-document',
      refs: [{}, { project_id: PROJECT_ID, branch: 'main', head_commit: COMMIT_A }],
      locks: [{}, { lock_id: 'lk-bad' }],
      reviews: [{}, { review_id: 'rv-x' }],
      notifications: [{}, { notification_id: 'nt-x' }],
      read_marks: [{}, { project_id: PROJECT_ID, reader_kind: 'machine', reader_id: READER_A.id, watermark_ms: 5 }],
    }, { nowMs: BASE_TS + 10_000 });

    assert.equal(merged.changed, true);
    assert.ok(merged.conflicts >= 10, 'every malformed record is counted, none is thrown');
    const exported = exportOne(state);
    assert.equal(state.projects.allEvents().length, eventsBefore + 1);
    assert.equal(exported.events.some((event) => event.actor?.id === WORKER_B.id), true);
    assert.equal(exported.artifacts.some((artifact) => artifact.sha256 === SHA_B), true);
    assert.equal(exported.decisions.some((decision) => decision.decision_id === 'prj-sync-d0002'), true);
    assert.equal(exported.refs.some((ref) => ref.branch === 'main'), true);
    assert.equal(exported.read_marks.some((mark) => mark.reader_id === READER_A.id), true);
    assert.equal(memberOf(exported, { kind: 'machine', id: 'm-ok' }).role, 'worker', 'a declared member without events is kept as the fallback');
  });

  it('imports events without replaying local project event notifications', () => {
    const { state } = makeState();
    setupProject(state);
    state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_A, role: 'worker' });
    let seen = 0;
    const unsubscribe = state.onProjectEvent(() => { seen += 1; });
    const merged = mergeProjectState(state, {
      project_id: PROJECT_ID,
      events: [{ project_id: PROJECT_ID, type: 'member.added', at: '2026-11-16T00:00:05Z', actor: WORKER_B, payload: { role: 'worker' } }],
    }, { nowMs: BASE_TS + 60_000 });
    unsubscribe();
    assert.equal(merged.changed, true);
    assert.equal(seen, 0, 'importEvent is silent; the cluster caller broadcasts deliberately');
    assert.equal(state.projects.allEvents().some((event) => event.actor?.id === WORKER_B.id), true);
    assert.equal(memberOf(exportOne(state), WORKER_B).role, 'worker');
  });
});

/* ------------------------------------------------------------------ */
/* minimal module hooks used by the merge                              */
/* ------------------------------------------------------------------ */

describe('project module snapshot/restore hooks', () => {
  it('round-trips locks through snapshot()/restore()', () => {
    const locks = createProjectLocks({ now: () => BASE_TS });
    const acquired = locks.acquire({ projectId: 'p-1', kind: 'branch', target: { branch: 'main' }, holder: WORKER_A, leaseMs: 60_000 });
    assert.equal(acquired.ok, true);
    const snapshot = locks.snapshot();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].project_id, 'p-1');
    assert.equal(snapshot[0].expires_at, acquired.lock.expires_at);

    const restored = createProjectLocks({ now: () => BASE_TS });
    assert.equal(restored.restore(snapshot).restored, 1);
    assert.deepEqual(restored.snapshot(), snapshot);
    assert.equal(restored.list({ projectId: 'p-1' }).length, 1);
    const next = restored.acquire({ projectId: 'p-1', kind: 'branch', target: { branch: 'dev' }, holder: WORKER_B });
    assert.equal(next.lock.lock_id, 'lk-000002', 'the id counter continues after restore');
    assert.equal(restored.restore('not-a-snapshot').ok, false);
  });

  it('round-trips reviews, refs and notifications', () => {
    const reviews = createProjectReviews({ now: () => BASE_TS });
    const created = reviews.create({ projectId: 'p-1', target: { kind: 'patch', sha256: PATCH_A }, requestedBy: WORKER_A, reviewers: [OWNER] });
    const reviewSnapshot = reviews.snapshot();
    assert.equal(reviewSnapshot.length, 1);
    const restoredReviews = createProjectReviews({ now: () => BASE_TS });
    assert.equal(restoredReviews.restore(reviewSnapshot).restored, 1);
    assert.deepEqual(restoredReviews.snapshot(), reviewSnapshot);
    assert.equal(restoredReviews.get({ reviewId: created.review.review_id }).status, 'pending');
    const withUpdatedAt = { ...reviewSnapshot[0], updated_at: new Date(BASE_TS + 5_000).toISOString() };
    const updatedRestored = createProjectReviews({ now: () => BASE_TS });
    assert.equal(updatedRestored.restore([withUpdatedAt]).restored, 1);
    assert.equal(updatedRestored.snapshot()[0].updated_at, new Date(BASE_TS + 5_000).toISOString(), 'an imported updated_at survives a round-trip');

    const refs = createProjectRefs({ now: () => BASE_TS });
    refs.advance({ projectId: 'p-1', branch: 'main', from: null, to: COMMIT_A });
    refs.enqueue({ projectId: 'p-1', branch: 'main', patchSha256: PATCH_A, baseCommit: COMMIT_A });
    const refsSnapshot = refs.snapshot();
    assert.equal(refsSnapshot.refs.length, 1);
    assert.equal(refsSnapshot.queue.length, 1);
    const restoredRefs = createProjectRefs({ now: () => BASE_TS });
    assert.equal(restoredRefs.restore(refsSnapshot).refs, 1);
    assert.deepEqual(restoredRefs.snapshot(), refsSnapshot);
    assert.equal(restoredRefs.restore([{ project_id: 'p-2', branch: 'dev', head_commit: COMMIT_B, version: 1, updated_at: new Date(BASE_TS).toISOString() }]).refs, 1);
    assert.equal(restoredRefs.snapshot().queue.length, 1, 'an array restore leaves the local merge queue alone');

    const notifications = createProjectNotifications({ now: () => BASE_TS });
    notifications.notify({ projectId: 'p-1', kind: 'mention', target: { kind: 'machine', id: WORKER_A.id }, subject: 'hi', refs: { task_id: 't-1' } });
    notifications.markRead({ projectId: 'p-1', reader: WORKER_A, watermarkMs: BASE_TS });
    const notificationSnapshot = notifications.snapshot();
    const marksSnapshot = notifications.snapshotReadMarks();
    assert.equal(notificationSnapshot.length, 1);
    assert.equal(marksSnapshot.length, 1);
    const restoredNotifications = createProjectNotifications({ now: () => BASE_TS });
    assert.equal(restoredNotifications.restore(notificationSnapshot).restored, 1);
    assert.equal(restoredNotifications.restoreReadMarks(marksSnapshot).ok, true);
    assert.deepEqual(restoredNotifications.snapshot(), notificationSnapshot);
    assert.equal(restoredNotifications.readWatermark({ projectId: 'p-1', reader: WORKER_A }), BASE_TS);
    assert.equal(restoredNotifications.snapshotReadMarks().length, 1);
  });

  it('never touches another project while merging one', () => {
    const a = makeState();
    const b = makeState();
    setupProject(a.state);
    a.state.projects.createProject({ projectId: 'prj-other', name: 'other', createdBy: OWNER });
    a.state.projects.addMember({ projectId: 'prj-other', member: WORKER_B, role: 'worker' });
    a.state.registerArtifact({ projectId: 'prj-other', sha256: SHA_C, bytes: 7, kind: 'artifact' });
    a.state.addDecision({ projectId: 'prj-other', title: 'other decision' });
    a.state.setProjectMemory({ projectId: 'prj-other', text: 'other memory' });
    a.state.refs.advance({ projectId: 'prj-other', branch: 'main', from: null, to: COMMIT_B });
    setupProject(b.state);
    b.state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_A, role: 'worker' });
    b.state.registerArtifact({ projectId: PROJECT_ID, sha256: SHA_A, bytes: 1, kind: 'artifact' });

    const otherBefore = exportOne(a.state, 'prj-other');
    mergeProjectState(a.state, exportOne(b.state), { nowMs: BASE_TS + 1_000 });
    assert.deepEqual(exportOne(a.state, 'prj-other'), otherBefore, 'a merge for prj-sync must not rewrite prj-other');
  });

  it('honours a replay row updated_at/at when choosing the latest review state', () => {
    const { state } = makeState();
    setupProject(state);
    state.reviews.create({ projectId: PROJECT_ID, target: { kind: 'patch', sha256: PATCH_A }, requestedBy: WORKER_A, reviewers: [OWNER] });
    const remoteReview = { ...exportOne(state).reviews[0], updated_at: new Date(BASE_TS + 5_000).toISOString() };
    const first = mergeProjectState(state, { project_id: PROJECT_ID, reviews: [remoteReview] }, { nowMs: BASE_TS + 10_000 });
    assert.equal(first.changed, true);
    assert.equal(state.reviews.snapshot()[0].updated_at, new Date(BASE_TS + 5_000).toISOString());
    const second = mergeProjectState(state, { project_id: PROJECT_ID, reviews: [remoteReview] }, { nowMs: BASE_TS + 10_000 });
    assert.equal(second.changed, false, 'mapping at/decided_at onto updated_at must stay idempotent');
  });

  it('persists and restores the shared objects through the state persistence hooks', () => {
    const dir = tempDir();
    const clock = makeClock();
    const first = makeState({ dir, clock });
    setupProject(first.state);
    first.state.projects.addMember({ projectId: PROJECT_ID, member: WORKER_A, role: 'worker' });
    first.state.locks.acquire({ projectId: PROJECT_ID, kind: 'branch', target: { branch: 'main' }, holder: WORKER_A });
    first.state.refs.advance({ projectId: PROJECT_ID, branch: 'main', from: null, to: COMMIT_A });
    first.state.reviews.create({ projectId: PROJECT_ID, target: { kind: 'patch', sha256: PATCH_A }, requestedBy: WORKER_A, reviewers: [OWNER] });
    first.state.notifications.notify({ projectId: PROJECT_ID, kind: 'mention', target: { kind: 'machine', id: WORKER_A.id }, subject: 'persist me', refs: { task_id: 't-1' } });
    first.state.notifications.markRead({ projectId: PROJECT_ID, reader: WORKER_A, watermarkMs: BASE_TS + 100 });
    first.state.persistProjectObjects();

    const persistence = new Persistence({ dir, now: clock.now });
    const restarted = new RabbitState({ persistence, now: clock.now });
    restarted.setPersistence(persistence);
    assert.deepEqual(restarted.locks.snapshot(), first.state.locks.snapshot());
    assert.deepEqual(restarted.refs.snapshot(), first.state.refs.snapshot());
    assert.deepEqual(restarted.reviews.snapshot(), first.state.reviews.snapshot());
    assert.deepEqual(restarted.notifications.snapshot(), first.state.notifications.snapshot());
    assert.deepEqual(restarted.notifications.snapshotReadMarks(), first.state.notifications.snapshotReadMarks());
    assert.deepEqual(restarted.projects.allEvents(), first.state.projects.allEvents());
    assert.deepEqual(semantic(exportOne(restarted)), semantic(exportOne(first.state)));
  });

  it('imports project-room state through allEvents/importEvent/importProject/replaceMembers', () => {
    const room = createProjectRoom();
    const imported = room.importProject({
      project_id: 'prj-hooks',
      name: 'Hooks',
      origin: null,
      created_at: '2026-11-16T00:00:00Z',
      created_by: OWNER,
      settings: { merge_requires_review: true },
    }, [{ kind: 'operator', id: 'lead', name: 'lead', role: 'owner', joined_at: '2026-11-16T00:00:00Z' }]);
    assert.equal(imported.created, true);
    assert.equal(room.snapshot({ projectId: 'prj-hooks' }).project.name, 'Hooks');
    assert.deepEqual(room.snapshot({ projectId: 'prj-hooks' }).project.settings, { merge_requires_review: true }, 'imported settings are preserved');
    assert.equal(room.snapshot({ projectId: 'prj-hooks' }).members.length, 1);

    const filled = room.importProject({ project_id: 'prj-hooks', name: 'Other', created_at: '2026-11-16T01:00:00Z' });
    assert.equal(filled.created, false);
    assert.equal(filled.updated, false, 'an existing valid field is not overwritten');
    assert.equal(room.snapshot({ projectId: 'prj-hooks' }).project.name, 'Hooks');
    const overwritten = room.importProject({ project_id: 'prj-hooks', name: 'Renamed' }, null, { overwriteMeta: true });
    assert.equal(overwritten.updated, true);
    assert.equal(room.snapshot({ projectId: 'prj-hooks' }).project.name, 'Renamed');

    let seen = 0;
    const silentRoom = createProjectRoom({ now: () => BASE_TS, onEvent: () => { seen += 1; } });
    silentRoom.importProject({ project_id: 'prj-h', name: 'h', created_by: OWNER });
    const importedEvent = silentRoom.importEvent({ project_id: 'prj-h', type: 'member.added', actor: WORKER_A, payload: { role: 'worker' }, at: '2026-11-16T00:00:01Z', origin: 'node-x' });
    assert.equal(seen, 0, 'importEvent must not fire onEvent');
    assert.equal(importedEvent.seq, silentRoom.toSnapshot().seq);
    assert.equal(importedEvent.origin, 'node-x');
    const eventsCopy = silentRoom.allEvents();
    eventsCopy[0].type = 'tampered';
    assert.equal(silentRoom.allEvents()[0].type, 'member.added');
    assert.throws(() => silentRoom.importEvent({ project_id: 'prj-h', type: '', at: '2026-11-16T00:00:00Z' }), (error) => error.code === 'BAD_REQUEST');
    assert.throws(() => silentRoom.importEvent({ project_id: 'prj-h', type: 'x', at: 'not-a-date' }), (error) => error.code === 'BAD_REQUEST');
    assert.throws(() => silentRoom.replaceMembers('prj-missing', []), (error) => error.code === 'PROJECT_NOT_FOUND');
    assert.throws(() => silentRoom.replaceMembers('prj-h', [{ kind: 'machine', id: 'x', role: 'superuser' }]), (error) => error.code === 'BAD_ROLE');
    assert.equal(silentRoom.replaceMembers('prj-h', [{ kind: 'operator', id: 'lead', role: 'owner', joined_at: '2026-11-16T00:00:00Z' }]).ok, true);
    assert.equal(silentRoom.snapshot({ projectId: 'prj-h' }).members.length, 1);
  });
});
