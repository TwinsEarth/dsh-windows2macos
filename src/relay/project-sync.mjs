/**
 * Project room cross-relay state sync (Phase 2B: export + deterministic merge).
 *
 * The project room itself is a local, ordered event log (`project-room.mjs`), but the objects a
 * client reads from a project board are not all recoverable from that log: artifact/decision/memory
 * event payloads only carry a summary, and locks/reviews/notifications/refs live in their own
 * modules. So a cross-relay sync cannot replay events; it has to ship the full object state and
 * merge it under rules that are *deterministic* (every relay computes the same winner from the same
 * two inputs) and *idempotent* (applying the same peer state twice changes nothing the second time).
 *
 * This module is deliberately pure: it reads a `RabbitState` and calls the small import/snapshot/
 * restore hooks the project modules expose. It owns no timers, no files and no network; the cluster
 * domain glue (`cluster-sync.mjs` via `server.mjs`) is what actually pulls pages and persists.
 *
 * Merge order for "latest" decisions, in this order:
 *   1. the record's own time (`updated_at` / `decided_at` / `created_at_ms` / ... when it has one);
 *   2. a type-specific tie-break (version, state rank);
 *   3. canonical JSON lexicographic comparison as the final total order.
 * Step 3 is what makes equal-timestamp conflicts deterministic instead of "whoever merged last wins".
 */
import { createHash } from 'node:crypto';

import { PROJECT_ROLES } from './project-room.mjs';
import { DEFAULT_LOCK_LEASE_MS, LOCK_KINDS } from './project-locks.mjs';
import { REVIEW_DECISIONS, REVIEW_STATUSES } from './project-reviews.mjs';
import { NOTIFICATION_KINDS } from './project-notifications.mjs';

/** Ceiling from the Phase 2 design: each project keeps the most recent notifications only. */
export const MAX_NOTIFICATIONS_PER_PROJECT = 500;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA_HEX = /^[0-9a-f]{7,64}$/;
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';
const LOCK_STATES = Object.freeze(['held', 'expired', 'released', 'force_released']);
const LOCK_STATE_RANK = Object.freeze({ held: 0, expired: 1, released: 2, force_released: 2 });
const REVIEW_STATE_RANK = Object.freeze({ pending: 0, approved: 1, expired: 2, changes_requested: 3 });
const REVIEW_TARGET_KINDS = Object.freeze(['patch', 'artifact']);
const READ_MARK_SEPARATOR = '\u0000';

/* ------------------------------------------------------------------ */
/* generic helpers                                                     */
/* ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeCall(fn) {
  try { return fn(); } catch { return null; }
}

/** JSON-safe deep copy; `undefined`/unserialisable values become `null` rather than throwing. */
function copyJson(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

/** RFC 8785-ish canonical JSON: sorted keys, no whitespace. Used only for deterministic comparison. */
function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((entry) => canonicalJson(entry)).join(',') + ']';
  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function asIso(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function timeOrZero(value) {
  return timeMs(value) ?? 0;
}

/**
 * Stable content identity of one project event.
 *
 * The tuple and its field order are fixed by the Phase 2 contract:
 * `sha256(JSON.stringify([project_id, type, actor, payload, at]))`. `seq` is deliberately excluded:
 * it is a local cursor and two relays that saw the same event have different seqs for it.
 */
function projectEventHash(event) {
  return createHash('sha256')
    .update(JSON.stringify([event.project_id, event.type, event.actor, event.payload, event.at]), 'utf8')
    .digest('hex');
}

function compareEventOrder(leftEvent, leftHash, rightEvent, rightHash) {
  const leftTime = timeOrZero(leftEvent.at);
  const rightTime = timeOrZero(rightEvent.at);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return compareStrings(leftHash, rightHash);
}

function normalizeActor(value) {
  if (!isObject(value) || typeof value.kind !== 'string' || value.kind === '' || typeof value.id !== 'string' || value.id === '') return null;
  return {
    kind: value.kind,
    id: value.id,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
  };
}

function memberKeyOf(member) {
  return member.kind + READ_MARK_SEPARATOR + member.id;
}

function compareMembers(left, right) {
  return compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id);
}

function normalizeMemberRow(value) {
  if (!isObject(value) || typeof value.kind !== 'string' || value.kind === '' || typeof value.id !== 'string' || value.id === '') return null;
  if (!PROJECT_ROLES.includes(value.role)) return null;
  return {
    kind: value.kind,
    id: value.id,
    name: typeof value.name === 'string' ? value.name : null,
    role: value.role,
    joined_at: asIso(value.joined_at),
  };
}

function projectEventsOf(state, projectId) {
  const module = state?.projects;
  if (!isObject(module)) return [];
  const all = typeof module.allEvents === 'function'
    ? safeCall(() => module.allEvents())
    : safeCall(() => module.toSnapshot()?.events);
  return asArray(all).filter((event) => isObject(event) && event.project_id === projectId);
}

function localRoomSnapshot(state, projectId) {
  const module = state?.projects;
  if (!isObject(module) || typeof module.snapshot !== 'function') return null;
  return safeCall(() => module.snapshot({ projectId }));
}

function moduleSnapshot(module) {
  if (!isObject(module) || typeof module.snapshot !== 'function') return null;
  return safeCall(() => module.snapshot());
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

/**
 * Export every project's complete syncable state.
 *
 * The array is ordered by `project_id` so the cluster pager can slice it deterministically. Each
 * item carries only shared object metadata: no blob bytes, no secrets and no relay credentials.
 * `event_hash` is added to each event copy; the event's own fields are not changed.
 *
 * @param {object} state a `RabbitState` (or a test double exposing the same project modules)
 * @returns {object[]}
 */
export function exportProjectState(state) {
  if (!isObject(state) || !isObject(state.projects) || typeof state.projects.toSnapshot !== 'function') return [];
  const roomSnapshot = safeCall(() => state.projects.toSnapshot());
  if (!isObject(roomSnapshot)) return [];
  const rawProjects = asArray(roomSnapshot.projects);
  const allEvents = typeof state.projects.allEvents === 'function'
    ? asArray(safeCall(() => state.projects.allEvents()))
    : asArray(roomSnapshot.events);
  const refsSnapshot = moduleSnapshot(state.refs);
  const refsRows = asArray(refsSnapshot?.refs);
  const lockRows = asArray(moduleSnapshot(state.locks));
  const reviewRows = asArray(moduleSnapshot(state.reviews));
  const notificationRows = asArray(moduleSnapshot(state.notifications));
  const readMarkRows = isObject(state.notifications) && typeof state.notifications.snapshotReadMarks === 'function'
    ? asArray(safeCall(() => state.notifications.snapshotReadMarks()))
    : [];

  const exported = [];
  const seen = new Set();
  for (const project of rawProjects) {
    const projectId = isObject(project) && typeof project.project_id === 'string' ? project.project_id : '';
    if (projectId === '' || seen.has(projectId)) continue;
    seen.add(projectId);
    const events = allEvents
      .filter((event) => isObject(event) && event.project_id === projectId)
      .map((event) => ({ ...copyJson(event), event_hash: projectEventHash(event) }));
    const members = asArray(project.members)
      .map((member) => copyJson(member))
      .filter((member) => isObject(member))
      .sort(compareMembers);
    const artifacts = state.artifacts instanceof Map
      ? [...state.artifacts.values()].filter((artifact) => isObject(artifact) && artifact.project_id === projectId).map((artifact) => copyJson(artifact))
      : [];
    artifacts.sort((left, right) => compareStrings(String(left.sha256 ?? ''), String(right.sha256 ?? '')));
    const decisions = state.decisions instanceof Map
      ? asArray(state.decisions.get(projectId)).map((decision) => copyJson(decision)).filter((decision) => isObject(decision))
      : [];
    decisions.sort((left, right) => compareStrings(String(left.decision_id ?? ''), String(right.decision_id ?? '')));
    const memoryDoc = state.projectMemory instanceof Map ? state.projectMemory.get(projectId) : undefined;
    const refs = refsRows
      .filter((row) => isObject(row) && row.project_id === projectId)
      .map((row) => copyJson(row))
      .sort((left, right) => compareStrings(String(left.branch ?? ''), String(right.branch ?? '')));
    const locks = lockRows
      .filter((row) => isObject(row) && (row.project_id === projectId || row.projectId === projectId))
      .map((row) => copyJson(row))
      .sort((left, right) => compareStrings(String(left.lock_id ?? ''), String(right.lock_id ?? '')));
    const reviews = reviewRows
      .filter((row) => isObject(row) && row.project_id === projectId)
      .map((row) => copyJson(row))
      .sort((left, right) => compareStrings(String(left.review_id ?? ''), String(right.review_id ?? '')));
    const notifications = notificationRows
      .filter((row) => isObject(row) && row.project_id === projectId)
      .map((row) => copyJson(row))
      .sort((left, right) => (Number(left.created_at_ms ?? 0) - Number(right.created_at_ms ?? 0)) || compareStrings(String(left.notification_id ?? ''), String(right.notification_id ?? '')));
    const readMarks = readMarkRows
      .filter((row) => isObject(row) && row.project_id === projectId)
      .map((row) => ({
        project_id: projectId,
        reader_kind: row.reader_kind,
        reader_id: row.reader_id,
        watermark_ms: row.watermark_ms,
      }))
      .filter((row) => typeof row.reader_kind === 'string' && typeof row.reader_id === 'string' && Number.isFinite(row.watermark_ms))
      .sort((left, right) => compareStrings(left.reader_kind, right.reader_kind) || compareStrings(left.reader_id, right.reader_id));
    exported.push({
      project_id: projectId,
      project: {
        project_id: projectId,
        name: typeof project.name === 'string' ? project.name : '',
        origin: copyJson(project.origin ?? null),
        created_at: typeof project.created_at === 'string' ? project.created_at : null,
        created_by: copyJson(project.created_by ?? null),
        settings: copyJson(project.settings ?? {}),
      },
      members,
      events,
      artifacts,
      decisions,
      memory: memoryDoc === undefined || memoryDoc === null ? null : copyJson(memoryDoc),
      refs,
      locks,
      reviews,
      notifications,
      read_marks: readMarks,
    });
  }
  exported.sort((left, right) => compareStrings(left.project_id, right.project_id));
  return exported;
}

/* ------------------------------------------------------------------ */
/* row normalisation (closed wire shapes shared by export and merge)   */
/* ------------------------------------------------------------------ */

function normalizeArtifactRow(row, projectId) {
  if (!isObject(row)) return null;
  if (typeof row.sha256 !== 'string' || !SHA256_HEX.test(row.sha256)) return null;
  const rowProject = typeof row.project_id === 'string' && row.project_id !== '' ? row.project_id : projectId;
  if (rowProject !== projectId) return null;
  return {
    project_id: projectId,
    sha256: row.sha256,
    bytes: Number.isInteger(row.bytes) && row.bytes >= 0 ? row.bytes : null,
    kind: typeof row.kind === 'string' && row.kind !== '' ? row.kind : 'artifact',
    source_task_id: typeof row.source_task_id === 'string' ? row.source_task_id : null,
    created_at: asIso(row.created_at),
    actor: isObject(row.actor) ? copyJson(row.actor) : null,
  };
}

function artifactSignature(row) {
  return canonicalJson([row.project_id, row.sha256, row.bytes, row.kind, row.source_task_id]);
}

function normalizeDecisionRow(row, projectId) {
  if (!isObject(row)) return null;
  if (typeof row.decision_id !== 'string' || row.decision_id === '') return null;
  const rowProject = typeof row.project_id === 'string' && row.project_id !== '' ? row.project_id : projectId;
  if (rowProject !== projectId) return null;
  if (typeof row.title !== 'string' || row.title.trim() === '') return null;
  return {
    decision_id: row.decision_id,
    project_id: projectId,
    title: row.title.trim(),
    text: typeof row.text === 'string' ? row.text : null,
    kind: typeof row.kind === 'string' && row.kind !== '' ? row.kind : 'decision',
    refs: isObject(row.refs) ? copyJson(row.refs) : {},
    actor: isObject(row.actor) ? copyJson(row.actor) : null,
    created_at: asIso(row.created_at),
  };
}

function normalizeMemoryRow(row, projectId) {
  if (!isObject(row) || typeof row.text !== 'string') return null;
  const rowProject = typeof row.project_id === 'string' && row.project_id !== '' ? row.project_id : projectId;
  if (rowProject !== projectId) return null;
  return {
    project_id: projectId,
    text: row.text,
    version: Number.isFinite(row.version) && row.version >= 0 ? Math.trunc(row.version) : 0,
    updated_at: asIso(row.updated_at),
    actor: isObject(row.actor) ? copyJson(row.actor) : null,
  };
}

function normalizeRefRow(row, projectId) {
  if (!isObject(row)) return null;
  const rowProject = typeof row.project_id === 'string' && row.project_id !== '' ? row.project_id : projectId;
  if (rowProject !== projectId) return null;
  if (typeof row.branch !== 'string' || row.branch === '') return null;
  if (typeof row.head_commit !== 'string' || !SHA_HEX.test(row.head_commit)) return null;
  return {
    project_id: projectId,
    branch: row.branch,
    head_commit: row.head_commit,
    version: Number.isInteger(row.version) && row.version >= 0 ? row.version : 1,
    updated_at: asIso(row.updated_at) ?? asIso(row.at) ?? EPOCH_ISO,
  };
}

function refActivityMs(row) {
  return timeOrZero(row.updated_at) || timeOrZero(row.at);
}

function pickRefWinner(local, remote) {
  const localTime = refActivityMs(local);
  const remoteTime = refActivityMs(remote);
  if (localTime !== remoteTime) return remoteTime > localTime ? remote : local;
  if (local.version !== remote.version) return remote.version > local.version ? remote : local;
  return compareStrings(canonicalJson(remote), canonicalJson(local)) > 0 ? remote : local;
}

function normalizeLockRow(row, projectId) {
  if (!isObject(row)) return null;
  if (typeof row.lock_id !== 'string' || row.lock_id === '') return null;
  const rowProject = typeof row.project_id === 'string' && row.project_id !== ''
    ? row.project_id
    : (typeof row.projectId === 'string' ? row.projectId : projectId);
  if (rowProject !== projectId) return null;
  if (!LOCK_KINDS.includes(row.kind)) return null;
  if (!isObject(row.target)) return null;
  const target = row.kind === 'branch'
    ? (typeof row.target.branch === 'string' && row.target.branch !== '' ? { branch: row.target.branch } : null)
    : (typeof row.target.path === 'string' && row.target.path !== '' ? { path: row.target.path } : null);
  if (target === null) return null;
  if (!isObject(row.holder) || typeof row.holder.kind !== 'string' || typeof row.holder.id !== 'string') return null;
  if (!LOCK_STATES.includes(row.state)) return null;
  const leaseMs = Number.isFinite(row.lease_ms) && row.lease_ms > 0 ? row.lease_ms : DEFAULT_LOCK_LEASE_MS;
  const expiresAtMs = Number.isFinite(row.expires_at_ms) ? row.expires_at_ms : timeMs(row.expires_at);
  if (expiresAtMs === null) return null;
  return {
    lock_id: row.lock_id,
    project_id: projectId,
    kind: row.kind,
    target,
    mode: 'exclusive',
    holder: { kind: row.holder.kind, id: row.holder.id },
    reason: typeof row.reason === 'string' ? row.reason : null,
    lease_ms: leaseMs,
    acquired_at: asIso(row.acquired_at) ?? new Date(expiresAtMs - leaseMs).toISOString(),
    expires_at: asIso(row.expires_at) ?? new Date(expiresAtMs).toISOString(),
    expires_at_ms: expiresAtMs,
    renewed_at: asIso(row.renewed_at),
    state: row.state,
  };
}

function lockActivityMs(row) {
  return timeOrZero(row.renewed_at) || timeOrZero(row.acquired_at) || timeOrZero(row.expires_at);
}

function pickLockWinner(local, remote) {
  const localTime = lockActivityMs(local);
  const remoteTime = lockActivityMs(remote);
  if (localTime !== remoteTime) return remoteTime > localTime ? remote : local;
  const localRank = LOCK_STATE_RANK[local.state] ?? 0;
  const remoteRank = LOCK_STATE_RANK[remote.state] ?? 0;
  if (localRank !== remoteRank) return remoteRank > localRank ? remote : local;
  return compareStrings(canonicalJson(remote), canonicalJson(local)) > 0 ? remote : local;
}

function normalizeReviewRow(row, projectId) {
  if (!isObject(row)) return null;
  if (typeof row.review_id !== 'string' || row.review_id === '') return null;
  const rowProject = typeof row.project_id === 'string' && row.project_id !== '' ? row.project_id : projectId;
  if (rowProject !== projectId) return null;
  if (!isObject(row.target) || !REVIEW_TARGET_KINDS.includes(row.target.kind)) return null;
  if (typeof row.target.sha256 !== 'string' || !SHA256_HEX.test(row.target.sha256)) return null;
  if (typeof row.requested_by !== 'object' || row.requested_by === null || typeof row.requested_by.kind !== 'string' || typeof row.requested_by.id !== 'string') return null;
  if (!REVIEW_STATUSES.includes(row.status)) return null;
  const reviewers = asArray(row.reviewers)
    .filter((reviewer) => isObject(reviewer) && typeof reviewer.kind === 'string' && typeof reviewer.id === 'string')
    .map((reviewer) => ({ kind: reviewer.kind, id: reviewer.id }));
  if (reviewers.length === 0) return null;
  const decisions = [];
  for (const decision of asArray(row.decisions)) {
    if (!isObject(decision) || !REVIEW_DECISIONS.includes(decision.decision)) continue;
    if (!isObject(decision.reviewer) || typeof decision.reviewer.kind !== 'string' || typeof decision.reviewer.id !== 'string') continue;
    const decidedAt = asIso(decision.decided_at);
    if (decidedAt === null) continue;
    decisions.push({
      reviewer: { kind: decision.reviewer.kind, id: decision.reviewer.id },
      decision: decision.decision,
      comment: typeof decision.comment === 'string' ? decision.comment : null,
      findings: asArray(decision.findings).map((finding) => ({
        file: typeof finding?.file === 'string' ? finding.file : null,
        line: Number.isInteger(finding?.line) ? finding.line : null,
        severity: typeof finding?.severity === 'string' ? finding.severity : null,
        text: typeof finding?.text === 'string' ? finding.text : null,
      })),
      decided_at: decidedAt,
    });
  }
  const dueAtMs = Number.isFinite(row.due_at_ms) ? row.due_at_ms : timeMs(row.due_at);
  // A replay row may name its last change as `updated_at`, `decided_at` or `at`; map it onto the one
  // field the review module can persist, so a second merge compares against the same value.
  const updatedAt = asIso(row.updated_at) ?? asIso(row.decided_at) ?? asIso(row.at);
  return {
    review_id: row.review_id,
    project_id: projectId,
    target: {
      kind: row.target.kind,
      sha256: row.target.sha256,
      source_task_id: typeof row.target.source_task_id === 'string' ? row.target.source_task_id : null,
      diffstat: row.target.diffstat === undefined ? null : copyJson(row.target.diffstat),
    },
    requested_by: {
      kind: row.requested_by.kind,
      id: row.requested_by.id,
      ...(typeof row.requested_by.name === 'string' ? { name: row.requested_by.name } : {}),
    },
    reviewers,
    required_approvals: Number.isInteger(row.required_approvals) && row.required_approvals >= 1 ? row.required_approvals : 1,
    status: row.status,
    decisions,
    created_at: asIso(row.created_at) ?? EPOCH_ISO,
    due_at: dueAtMs === null ? null : asIso(row.due_at) ?? new Date(dueAtMs).toISOString(),
    due_at_ms: dueAtMs,
    ...(updatedAt === null ? {} : { updated_at: updatedAt }),
  };
}

function reviewActivityMs(row) {
  let latest = Math.max(timeOrZero(row.updated_at), timeOrZero(row.created_at));
  for (const decision of asArray(row.decisions)) latest = Math.max(latest, timeOrZero(decision.decided_at));
  return latest;
}

function pickReviewWinner(local, remote) {
  const localTime = reviewActivityMs(local);
  const remoteTime = reviewActivityMs(remote);
  if (localTime !== remoteTime) return remoteTime > localTime ? remote : local;
  const localRank = REVIEW_STATE_RANK[local.status] ?? 0;
  const remoteRank = REVIEW_STATE_RANK[remote.status] ?? 0;
  if (localRank !== remoteRank) return remoteRank > localRank ? remote : local;
  return compareStrings(canonicalJson(remote), canonicalJson(local)) > 0 ? remote : local;
}

function normalizeNotificationRow(row, projectId) {
  if (!isObject(row)) return null;
  if (typeof row.notification_id !== 'string' || row.notification_id === '') return null;
  const rowProject = typeof row.project_id === 'string' && row.project_id !== '' ? row.project_id : projectId;
  if (rowProject !== projectId) return null;
  if (!NOTIFICATION_KINDS.includes(row.kind)) return null;
  const createdAt = asIso(row.created_at);
  const createdAtMs = Number.isFinite(row.created_at_ms) ? row.created_at_ms : timeMs(row.created_at);
  if (createdAtMs === null) return null;
  const normalized = {
    notification_id: row.notification_id,
    project_id: projectId,
    kind: row.kind,
    target: isObject(row.target) ? copyJson(row.target) : { kind: 'broadcast' },
    subject: typeof row.subject === 'string' ? row.subject : null,
    refs: isObject(row.refs) ? copyJson(row.refs) : {},
    requires_action: row.requires_action === true,
    created_at: createdAt ?? new Date(createdAtMs).toISOString(),
    created_at_ms: createdAtMs,
  };
  if (row.kind === 'digest') normalized.count = Number.isInteger(row.count) && row.count >= 1 ? row.count : 1;
  return normalized;
}

function pickNotificationWinner(local, remote) {
  if (local.created_at_ms !== remote.created_at_ms) return remote.created_at_ms > local.created_at_ms ? remote : local;
  return compareStrings(canonicalJson(remote), canonicalJson(local)) > 0 ? remote : local;
}

function normalizeReadMarkRow(row, projectId) {
  if (!isObject(row)) return null;
  const rowProject = typeof row.project_id === 'string' && row.project_id !== '' ? row.project_id : projectId;
  if (rowProject !== projectId) return null;
  if (typeof row.reader_kind !== 'string' || row.reader_kind === '') return null;
  if (typeof row.reader_id !== 'string' || row.reader_id === '') return null;
  const watermark = Number.isFinite(row.watermark_ms) ? row.watermark_ms : timeMs(row.watermark_ms);
  if (watermark === null) return null;
  return { project_id: projectId, reader_kind: row.reader_kind, reader_id: row.reader_id, watermark_ms: watermark };
}

function readMarkKey(row) {
  return row.reader_kind + READ_MARK_SEPARATOR + row.reader_id;
}

/* ------------------------------------------------------------------ */
/* project metadata                                                    */
/* ------------------------------------------------------------------ */

function projectMetaTime(projectRow, events) {
  let latest = timeOrZero(projectRow?.created_at);
  for (const event of events) {
    if (!isObject(event)) continue;
    if (event.type !== 'project.created' && event.type !== 'project.meta') continue;
    latest = Math.max(latest, timeOrZero(event.at));
  }
  return latest;
}

function projectMetaContent(projectRow) {
  return canonicalJson({
    name: typeof projectRow?.name === 'string' ? projectRow.name : null,
    settings: isObject(projectRow?.settings) ? projectRow.settings : {},
  });
}

function hasRemoteMetadata(projectRow) {
  return (typeof projectRow?.name === 'string' && projectRow.name.trim() !== '') || isObject(projectRow?.settings);
}

/* ------------------------------------------------------------------ */
/* member derivation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Derive members from the merged event history.
 *
 * Events are applied strictly in `(at, event_hash)` order, so `member.added` / `member.removed` /
 * `member.role_changed` converge to the same state on every relay no matter which page arrived
 * first. A member that never appears in any membership event falls back to the declared member
 * lists (union by `(kind, id)`, role = deterministic maximum); a member that *does* have events is
 * never resurrected from a stale declared list, which is what makes removals converge.
 */
function deriveMembers({ projectRow, events, fallbackMembers }) {
  const relevant = [];
  for (const event of events) {
    if (!isObject(event)) continue;
    if (event.type !== 'project.created' && event.type !== 'member.added' && event.type !== 'member.removed' && event.type !== 'member.role_changed') continue;
    relevant.push({ event, hash: projectEventHash(event) });
  }
  relevant.sort((left, right) => compareEventOrder(left.event, left.hash, right.event, right.hash));
  const createdAt = asIso(projectRow?.created_at) ?? EPOCH_ISO;
  const state = new Map();
  const touched = new Set();
  for (const { event } of relevant) {
    const actor = normalizeActor(event.actor);
    if (actor === null) continue;
    const key = memberKeyOf(actor);
    if (event.type === 'project.created') {
      touched.add(key);
      if (!state.has(key)) state.set(key, { kind: actor.kind, id: actor.id, name: actor.name ?? null, role: 'owner', joined_at: asIso(event.at) ?? createdAt });
      continue;
    }
    if (event.type === 'member.added') {
      const role = isObject(event.payload) && PROJECT_ROLES.includes(event.payload.role) ? event.payload.role : null;
      if (role === null) continue;
      touched.add(key);
      const existing = state.get(key);
      state.set(key, {
        kind: actor.kind,
        id: actor.id,
        name: actor.name ?? existing?.name ?? null,
        role,
        joined_at: existing?.joined_at ?? asIso(event.at) ?? createdAt,
      });
      continue;
    }
    if (event.type === 'member.removed') {
      touched.add(key);
      state.delete(key);
      continue;
    }
    const nextRole = isObject(event.payload) && PROJECT_ROLES.includes(event.payload.to) ? event.payload.to : null;
    if (nextRole === null) continue;
    touched.add(key);
    const existing = state.get(key);
    if (existing !== undefined) state.set(key, { ...existing, role: nextRole });
    else state.set(key, { kind: actor.kind, id: actor.id, name: actor.name ?? null, role: nextRole, joined_at: asIso(event.at) ?? createdAt });
  }
  for (const [key, member] of fallbackMembers) {
    if (touched.has(key) || state.has(key)) continue;
    state.set(key, { ...member, joined_at: asIso(member.joined_at) ?? createdAt });
  }
  return [...state.values()]
    .map((member) => ({ kind: member.kind, id: member.id, name: typeof member.name === 'string' ? member.name : null, role: member.role, joined_at: asIso(member.joined_at) ?? createdAt }))
    .sort(compareMembers);
}

function fallbackMemberMap(candidateLists) {
  const union = new Map();
  for (const members of candidateLists) {
    for (const candidate of asArray(members)) {
      const member = normalizeMemberRow(candidate);
      if (member === null) continue;
      const key = memberKeyOf(member);
      const existing = union.get(key);
      if (existing === undefined) { union.set(key, member); continue; }
      if (PROJECT_ROLES.indexOf(member.role) > PROJECT_ROLES.indexOf(existing.role)) { union.set(key, member); continue; }
      if (member.role === existing.role && compareStrings(canonicalJson(member), canonicalJson(existing)) > 0) union.set(key, member);
    }
  }
  return union;
}

/* ------------------------------------------------------------------ */
/* merge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Merge one peer's exported project state into `state`.
 *
 * Deterministic, idempotent and tolerant of malformed input: a bad record is skipped and counted in
 * `conflicts` instead of throwing, so one corrupt peer page cannot stop a sync round.
 *
 * Write-back goes through the modules' own minimal hooks (`importProject`, `importEvent`,
 * `replaceMembers`, `restore`) and only touches rows belonging to this project. `changed` is true
 * only when something was actually mutated.
 *
 * @param {object} state a `RabbitState` (or a test double exposing the same project modules)
 * @param {object} remoteProject one item from {@link exportProjectState}
 * @param {{nowMs?: number, nodeId?: string|null}} [options]
 *   `nowMs` is the clock used to drop expired locks. `nodeId` is accepted for the cluster caller but
 *   is deliberately not part of any ordering rule: every relay must compute the same result.
 * @returns {{changed: boolean, conflicts: number}}
 */
export function mergeProjectState(state, remoteProject, { nowMs = Date.now(), nodeId: _nodeId = null } = {}) {
  const result = { changed: false, conflicts: 0 };
  if (!isObject(state) || !isObject(state.projects) || typeof state.projects.importProject !== 'function' || typeof state.projects.importEvent !== 'function') return result;
  if (!isObject(remoteProject)) return { changed: false, conflicts: 1 };
  const source = isObject(remoteProject.project) ? remoteProject.project : remoteProject;
  const projectId = typeof source.project_id === 'string' && source.project_id !== ''
    ? source.project_id
    : (typeof remoteProject.project_id === 'string' ? remoteProject.project_id : '');
  if (projectId === '') return { changed: false, conflicts: 1 };
  const atMs = Number.isFinite(nowMs) ? nowMs : Date.now();

  const malformedContainer = (value) => value !== undefined && value !== null && !Array.isArray(value);

  /* ---- 1. project: import on first sight, then conservative metadata merge ---- */
  let localSnapshot = localRoomSnapshot(state, projectId);
  let localEvents = projectEventsOf(state, projectId);
  const remoteEvents = asArray(remoteProject.events);
  if (malformedContainer(remoteProject.events)) result.conflicts += 1;
  const remoteMemberCandidates = [...asArray(remoteProject.members), ...asArray(source.members)];
  for (const candidate of remoteMemberCandidates) {
    if (normalizeMemberRow(candidate) === null) result.conflicts += 1;
  }
  if (localSnapshot === null) {
    try {
      const imported = state.projects.importProject(source, remoteMemberCandidates.length > 0 ? remoteMemberCandidates : null);
      if (imported?.ok === true) result.changed = true;
    } catch { result.conflicts += 1; }
    localSnapshot = localRoomSnapshot(state, projectId);
    if (localSnapshot === null) return result;
  } else {
    const localProjectRow = localSnapshot.project ?? {};
    const localMetaAt = projectMetaTime(localProjectRow, localEvents);
    const remoteMetaAt = projectMetaTime(source, remoteEvents);
    let overwriteMeta = false;
    if (hasRemoteMetadata(source)) {
      if (remoteMetaAt > localMetaAt) overwriteMeta = true;
      else if (remoteMetaAt === localMetaAt && hasRemoteMetadata(localProjectRow)) {
        const localContent = projectMetaContent(localProjectRow);
        const remoteContent = projectMetaContent(source);
        if (localContent !== remoteContent) {
          result.conflicts += 1;
          overwriteMeta = remoteContent > localContent;
        }
      }
    }
    try {
      const imported = state.projects.importProject(source, null, { overwriteMeta });
      if (imported?.updated === true) result.changed = true;
    } catch { result.conflicts += 1; }
  }

  /* ---- 2. events: union by content hash, silent append ---- */
  const toImport = [];
  for (const event of remoteEvents) {
    if (!isObject(event)) { result.conflicts += 1; continue; }
    if (event.project_id !== projectId) { result.conflicts += 1; continue; }
    if (typeof event.type !== 'string' || event.type.trim() === '') { result.conflicts += 1; continue; }
    if (asIso(event.at) === null) { result.conflicts += 1; continue; }
    toImport.push({ event, hash: projectEventHash(event) });
  }
  toImport.sort((left, right) => compareEventOrder(left.event, left.hash, right.event, right.hash));
  const knownHashes = new Set(localEvents.map((event) => projectEventHash(event)));
  for (const { event, hash } of toImport) {
    if (knownHashes.has(hash)) continue;
    try {
      state.projects.importEvent(event);
      knownHashes.add(hash);
      result.changed = true;
    } catch { result.conflicts += 1; }
  }
  localEvents = projectEventsOf(state, projectId);
  localSnapshot = localRoomSnapshot(state, projectId);
  if (localSnapshot === null) return result;

  /* ---- 3. members: deterministic replay of the merged history ---- */
  const derivedMembers = deriveMembers({
    projectRow: localSnapshot.project ?? {},
    events: localEvents,
    fallbackMembers: fallbackMemberMap([asArray(localSnapshot.members), remoteMemberCandidates]),
  });
  const currentMembers = asArray(localSnapshot.members)
    .map((member) => normalizeMemberRow(member))
    .filter((member) => member !== null)
    .sort(compareMembers);
  if (!sameCanonical(currentMembers, derivedMembers)) {
    try {
      state.projects.replaceMembers(projectId, derivedMembers);
      result.changed = true;
    } catch { result.conflicts += 1; }
  }

  /* ---- 4. artifacts: union by sha256, deterministic winner on metadata conflict ---- */
  if (malformedContainer(remoteProject.artifacts)) result.conflicts += 1;
  if (state.artifacts instanceof Map) {
    const candidates = [];
    for (const raw of asArray(remoteProject.artifacts)) {
      const artifact = normalizeArtifactRow(raw, projectId);
      if (artifact === null) { result.conflicts += 1; continue; }
      candidates.push(artifact);
    }
    candidates.sort((left, right) => compareStrings(left.sha256, right.sha256));
    for (const artifact of candidates) {
      const existing = state.artifacts.get(artifact.sha256);
      if (existing === undefined) {
        state.artifacts.set(artifact.sha256, artifact);
        result.changed = true;
        continue;
      }
      if (!isObject(existing) || existing.project_id !== projectId) { result.conflicts += 1; continue; }
      const localSignature = artifactSignature(existing);
      const remoteSignature = artifactSignature(artifact);
      if (localSignature === remoteSignature) continue;
      result.conflicts += 1;
      if (remoteSignature > localSignature) {
        state.artifacts.set(artifact.sha256, artifact);
        result.changed = true;
      }
    }
  } else if (remoteProject.artifacts !== undefined && remoteProject.artifacts !== null) {
    result.conflicts += 1;
  }

  /* ---- 5. decisions: union by decision_id, deterministic winner on same-id conflict ---- */
  if (malformedContainer(remoteProject.decisions)) result.conflicts += 1;
  if (state.decisions instanceof Map) {
    const localList = asArray(state.decisions.get(projectId));
    const mergedById = new Map();
    for (const raw of localList) {
      const decision = normalizeDecisionRow(raw, projectId);
      if (decision !== null) mergedById.set(decision.decision_id, decision);
    }
    let decisionsChanged = false;
    const candidates = [];
    for (const raw of asArray(remoteProject.decisions)) {
      const decision = normalizeDecisionRow(raw, projectId);
      if (decision === null) { result.conflicts += 1; continue; }
      candidates.push(decision);
    }
    candidates.sort((left, right) => compareStrings(left.decision_id, right.decision_id));
    for (const decision of candidates) {
      const current = mergedById.get(decision.decision_id);
      if (current === undefined) { mergedById.set(decision.decision_id, decision); decisionsChanged = true; continue; }
      const currentContent = canonicalJson(current);
      const remoteContent = canonicalJson(decision);
      if (currentContent === remoteContent) continue;
      result.conflicts += 1;
      if (remoteContent > currentContent) { mergedById.set(decision.decision_id, decision); decisionsChanged = true; }
    }
    const mergedList = [...mergedById.values()].sort((left, right) => compareStrings(left.decision_id, right.decision_id));
    const localNormalized = localList.map((raw) => normalizeDecisionRow(raw, projectId)).filter((row) => row !== null).sort((left, right) => compareStrings(left.decision_id, right.decision_id));
    if (decisionsChanged || !sameCanonical(localNormalized, mergedList)) {
      state.decisions.set(projectId, mergedList);
      result.changed = true;
    }
  } else if (remoteProject.decisions !== undefined && remoteProject.decisions !== null) {
    result.conflicts += 1;
  }

  /* ---- 6. memory: version first, then updated_at, then deterministic content ---- */
  if (remoteProject.memory !== undefined && remoteProject.memory !== null && !isObject(remoteProject.memory)) {
    result.conflicts += 1;
  } else if (isObject(remoteProject.memory) && state.projectMemory instanceof Map) {
    const remoteMemory = normalizeMemoryRow(remoteProject.memory, projectId);
    if (remoteMemory === null) {
      result.conflicts += 1;
    } else {
      const localRaw = state.projectMemory.get(projectId);
      const localMemory = localRaw === undefined ? null : normalizeMemoryRow(localRaw, projectId);
      if (localMemory === null) {
        state.projectMemory.set(projectId, remoteMemory);
        result.changed = true;
      } else if (!sameCanonical(localMemory, remoteMemory)) {
        let winner = null;
        if (remoteMemory.version !== localMemory.version) winner = remoteMemory.version > localMemory.version ? remoteMemory : null;
        else {
          const localUpdated = timeOrZero(localMemory.updated_at);
          const remoteUpdated = timeOrZero(remoteMemory.updated_at);
          if (remoteUpdated !== localUpdated) winner = remoteUpdated > localUpdated ? remoteMemory : null;
          else {
            result.conflicts += 1;
            winner = canonicalJson(remoteMemory) > canonicalJson(localMemory) ? remoteMemory : null;
          }
        }
        if (winner !== null) {
          state.projectMemory.set(projectId, winner);
          result.changed = true;
        }
      }
    }
  }

  /* ---- 7. refs: one head per (project_id, branch), latest updated_at wins ---- */
  if (malformedContainer(remoteProject.refs)) result.conflicts += 1;
  if (isObject(state.refs) && typeof state.refs.snapshot === 'function' && typeof state.refs.restore === 'function') {
    const refsSnapshot = moduleSnapshot(state.refs);
    if (isObject(refsSnapshot) && Array.isArray(refsSnapshot.refs)) {
      const localRefs = [];
      for (const raw of refsSnapshot.refs) {
        if (!isObject(raw) || raw.project_id !== projectId) continue;
        const ref = normalizeRefRow(raw, projectId);
        if (ref !== null) localRefs.push(ref);
      }
      const merged = new Map(localRefs.map((ref) => [ref.project_id + READ_MARK_SEPARATOR + ref.branch, ref]));
      for (const raw of asArray(remoteProject.refs)) {
        const ref = normalizeRefRow(raw, projectId);
        if (ref === null) { result.conflicts += 1; continue; }
        const key = ref.project_id + READ_MARK_SEPARATOR + ref.branch;
        const existing = merged.get(key);
        merged.set(key, existing === undefined ? ref : pickRefWinner(existing, ref));
      }
      const mergedRefs = [...merged.values()].sort((left, right) => compareStrings(left.branch, right.branch));
      if (!sameCanonical(localRefs.slice().sort((left, right) => compareStrings(left.branch, right.branch)), mergedRefs)) {
        const otherRefs = refsSnapshot.refs.filter((row) => !isObject(row) || row.project_id !== projectId);
        state.refs.restore({ refs: [...otherRefs, ...mergedRefs], queue: refsSnapshot.queue });
        result.changed = true;
      }
    }
  }

  /* ---- 8. locks: reduce by lock_id to the latest state, drop expired leases ---- */
  if (malformedContainer(remoteProject.locks)) result.conflicts += 1;
  if (isObject(state.locks) && typeof state.locks.snapshot === 'function' && typeof state.locks.restore === 'function') {
    const localRows = asArray(moduleSnapshot(state.locks));
    const otherRows = localRows.filter((row) => !(isObject(row) && (row.project_id === projectId || row.projectId === projectId)));
    // lock ids are minted per relay, not per project, so the same id can already belong to another
    // project here. Importing over it would silently drop that project's row, so it is a conflict.
    const foreignIds = new Set(otherRows.map((row) => (isObject(row) ? row.lock_id : null)).filter((id) => typeof id === 'string'));
    const merged = new Map();
    for (const raw of localRows) {
      if (!isObject(raw) || (raw.project_id !== projectId && raw.projectId !== projectId)) continue;
      const lock = normalizeLockRow(raw, projectId);
      if (lock !== null) merged.set(lock.lock_id, lock);
    }
    for (const raw of asArray(remoteProject.locks)) {
      const lock = normalizeLockRow(raw, projectId);
      if (lock === null) { result.conflicts += 1; continue; }
      if (foreignIds.has(lock.lock_id)) { result.conflicts += 1; continue; }
      const existing = merged.get(lock.lock_id);
      merged.set(lock.lock_id, existing === undefined ? lock : pickLockWinner(existing, lock));
    }
    const keptLocks = [...merged.values()]
      .filter((lock) => lock.expires_at_ms > atMs)
      .sort((left, right) => compareStrings(left.lock_id, right.lock_id));
    // Compare against the *unfiltered* local rows on purpose: expired rows must actually leave the
    // module's table on the merge that first sees them, not just disappear from this comparison and
    // be re-exported forever.
    const localProjectRows = localRows
      .filter((row) => isObject(row) && (row.project_id === projectId || row.projectId === projectId))
      .map((row) => normalizeLockRow(row, projectId))
      .filter((row) => row !== null)
      .sort((left, right) => compareStrings(left.lock_id, right.lock_id));
    if (!sameCanonical(localProjectRows, keptLocks)) {
      state.locks.restore([...otherRows, ...keptLocks]);
      result.changed = true;
    }
  }

  /* ---- 9. reviews: latest state per review_id ---- */
  if (malformedContainer(remoteProject.reviews)) result.conflicts += 1;
  if (isObject(state.reviews) && typeof state.reviews.snapshot === 'function' && typeof state.reviews.restore === 'function') {
    const localRows = asArray(moduleSnapshot(state.reviews));
    const otherRows = localRows.filter((row) => !(isObject(row) && row.project_id === projectId));
    const foreignIds = new Set(otherRows.map((row) => (isObject(row) ? row.review_id : null)).filter((id) => typeof id === 'string'));
    const merged = new Map();
    for (const raw of localRows) {
      if (!isObject(raw) || raw.project_id !== projectId) continue;
      const review = normalizeReviewRow(raw, projectId);
      if (review !== null) merged.set(review.review_id, review);
    }
    for (const raw of asArray(remoteProject.reviews)) {
      const review = normalizeReviewRow(raw, projectId);
      if (review === null) { result.conflicts += 1; continue; }
      if (foreignIds.has(review.review_id)) { result.conflicts += 1; continue; }
      const existing = merged.get(review.review_id);
      merged.set(review.review_id, existing === undefined ? review : pickReviewWinner(existing, review));
    }
    const mergedReviews = [...merged.values()].sort((left, right) => compareStrings(left.review_id, right.review_id));
    const localNormalized = localRows
      .filter((row) => isObject(row) && row.project_id === projectId)
      .map((row) => normalizeReviewRow(row, projectId))
      .filter((row) => row !== null)
      .sort((left, right) => compareStrings(left.review_id, right.review_id));
    if (!sameCanonical(localNormalized, mergedReviews)) {
      state.reviews.restore([...otherRows, ...mergedReviews]);
      result.changed = true;
    }
  }

  /* ---- 10. notifications: union by id, then keep the newest 500 per project ---- */
  if (malformedContainer(remoteProject.notifications)) result.conflicts += 1;
  if (isObject(state.notifications) && typeof state.notifications.snapshot === 'function' && typeof state.notifications.restore === 'function') {
    const localRows = asArray(moduleSnapshot(state.notifications));
    const otherRows = localRows.filter((row) => !(isObject(row) && row.project_id === projectId));
    // notification ids are per relay (not per project), so the same id may already belong to another
    // project here; treating it as a conflict keeps that project's row from being replaced.
    const foreignIds = new Set(otherRows.map((row) => (isObject(row) ? row.notification_id : null)).filter((id) => typeof id === 'string'));
    const merged = new Map();
    for (const raw of localRows) {
      if (!isObject(raw) || raw.project_id !== projectId) continue;
      const notification = normalizeNotificationRow(raw, projectId);
      if (notification !== null) merged.set(notification.notification_id, notification);
    }
    for (const raw of asArray(remoteProject.notifications)) {
      const notification = normalizeNotificationRow(raw, projectId);
      if (notification === null) { result.conflicts += 1; continue; }
      if (foreignIds.has(notification.notification_id)) { result.conflicts += 1; continue; }
      const existing = merged.get(notification.notification_id);
      merged.set(notification.notification_id, existing === undefined ? notification : pickNotificationWinner(existing, notification));
    }
    const sorted = [...merged.values()].sort((left, right) => (left.created_at_ms - right.created_at_ms) || compareStrings(left.notification_id, right.notification_id));
    const kept = sorted.length > MAX_NOTIFICATIONS_PER_PROJECT ? sorted.slice(sorted.length - MAX_NOTIFICATIONS_PER_PROJECT) : sorted;
    const localNormalized = localRows
      .filter((row) => isObject(row) && row.project_id === projectId)
      .map((row) => normalizeNotificationRow(row, projectId))
      .filter((row) => row !== null)
      .sort((left, right) => (left.created_at_ms - right.created_at_ms) || compareStrings(left.notification_id, right.notification_id));
    if (!sameCanonical(localNormalized, kept)) {
      state.notifications.restore([...otherRows, ...kept]);
      result.changed = true;
    }
  }

  /* ---- 11. read marks: max watermark per (project_id, reader_kind, reader_id) ---- */
  if (malformedContainer(remoteProject.read_marks)) result.conflicts += 1;
  if (isObject(state.notifications) && typeof state.notifications.readWatermark === 'function' && typeof state.notifications.markRead === 'function') {
    const mergedMarks = new Map();
    for (const raw of asArray(remoteProject.read_marks)) {
      const mark = normalizeReadMarkRow(raw, projectId);
      if (mark === null) { result.conflicts += 1; continue; }
      const key = readMarkKey(mark);
      const existing = mergedMarks.get(key);
      if (existing === undefined || mark.watermark_ms > existing.watermark_ms) mergedMarks.set(key, mark);
    }
    for (const mark of mergedMarks.values()) {
      let current = 0;
      try { current = state.notifications.readWatermark({ projectId, reader: { kind: mark.reader_kind, id: mark.reader_id } }); } catch { current = 0; }
      if (!Number.isFinite(current)) current = 0;
      if (mark.watermark_ms <= current) continue;
      try {
        const marked = state.notifications.markRead({ projectId, reader: { kind: mark.reader_kind, id: mark.reader_id }, watermarkMs: mark.watermark_ms });
        if (marked?.advanced === true) result.changed = true;
      } catch { result.conflicts += 1; }
    }
  }

  return result;
}
