/**
 * Project refs and merge bookkeeping (v1.3.13-beta.3 slice).
 *
 * A workspace task produces a patch against a base; the task model needs one place that says where each branch actually is and
 * what happened to each patch. This module records monotonic branch heads, a merge queue keyed by patch sha256, and first-class
 * outcomes (merged / already_merged / base mismatch / conflict). git application belongs to the machine (merge-queue.mjs owns
 * the repository work); the relay records the decision and refuses a claim it has already answered.
 */
const SHA = /^[0-9a-f]{7,64}$/;
const PATCH = /^[0-9a-f]{64}$/;

export class RefError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'RefError';
    this.code = code;
    this.detail = detail;
  }
}

const keyOf = (projectId, branch) => projectId + '|' + branch;
const QUEUE_STATES = Object.freeze(['queued', 'merged', 'conflict', 'failed']);
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

export function createProjectRefs({ now = () => Date.now(), onEvent = null, idPrefix = '' } = {}) {
  const heads = new Map();
  const items = new Map();
  const idScope = typeof idPrefix === 'string' && idPrefix !== '' ? idPrefix + '-' : '';
  let counter = 0;
  let seq = 0;
  const emit = (type, payload) => {
    seq += 1;
    const event = { seq, type, at: new Date(now()).toISOString(), payload };
    if (typeof onEvent === 'function') onEvent(event);
    return event;
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const asIso = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);
  const idCounter = (id) => {
    const match = /(\d+)$/.exec(id);
    return match === null ? 0 : Number(match[1]);
  };
  /** Rebuild one branch head from a serialised row; null when the row cannot be a head. */
  const normalizeHeadRow = (row) => {
    if (row === null || typeof row !== 'object') return null;
    if (typeof row.project_id !== 'string' || row.project_id === '') return null;
    if (typeof row.branch !== 'string' || row.branch === '') return null;
    if (!SHA.test(String(row.head_commit ?? ''))) return null;
    return {
      ...copy(row),
      project_id: row.project_id,
      branch: row.branch,
      head_commit: String(row.head_commit),
      version: Number.isInteger(row.version) && row.version >= 0 ? row.version : 1,
      updated_at: asIso(row.updated_at) ?? EPOCH_ISO,
    };
  };
  /** Rebuild one merge-queue item from a serialised row; null when the row cannot be an item. */
  const normalizeQueueRow = (row) => {
    if (row === null || typeof row !== 'object') return null;
    if (typeof row.queue_id !== 'string' || row.queue_id === '') return null;
    if (typeof row.project_id !== 'string' || row.project_id === '') return null;
    if (typeof row.branch !== 'string' || row.branch === '') return null;
    if (!PATCH.test(String(row.patch_sha256 ?? ''))) return null;
    if (!SHA.test(String(row.base_commit ?? ''))) return null;
    if (!QUEUE_STATES.includes(row.state)) return null;
    const normalized = {
      ...copy(row),
      queue_id: row.queue_id,
      project_id: row.project_id,
      branch: row.branch,
      patch_sha256: String(row.patch_sha256),
      base_commit: String(row.base_commit),
      source_task_id: typeof row.source_task_id === 'string' ? row.source_task_id : null,
      state: row.state,
      created_at: asIso(row.created_at) ?? EPOCH_ISO,
    };
    if (row.head_commit !== undefined && row.head_commit !== null) normalized.head_commit = SHA.test(String(row.head_commit)) ? String(row.head_commit) : null;
    if (row.conflict_sha256 !== undefined && row.conflict_sha256 !== null) normalized.conflict_sha256 = PATCH.test(String(row.conflict_sha256)) ? String(row.conflict_sha256) : null;
    if (row.settled_at !== undefined && row.settled_at !== null) normalized.settled_at = asIso(row.settled_at);
    return normalized;
  };
  return {
    head({ projectId, branch }) {
      return heads.get(keyOf(projectId, branch)) ?? null;
    },
    /**
     * Advance a branch. The caller names the head it built on; if that is not the current head the advance is refused
     * (REF_BASE_MISMATCH), because silently moving someone else's base is how intent gets lost.
     */
    advance({ projectId, branch, from = null, to, actor = null, reason = null }) {
      if (typeof projectId !== 'string' || projectId === '') throw new RefError('INVALID_PROJECT', 'project_id is required');
      if (typeof branch !== 'string' || branch === '') throw new RefError('INVALID_BRANCH', 'branch is required');
      if (!SHA.test(String(to))) throw new RefError('INVALID_HEAD', 'to must be a hex commit id', { to });
      const current = heads.get(keyOf(projectId, branch));
      const currentHead = current?.head_commit ?? null;
      if (from !== currentHead) {
        return { ok: false, code: currentHead === null ? 'REF_UNINITIALIZED' : 'REF_BASE_MISMATCH', expected: currentHead, from };
      }
      if (from !== null && String(to) === from) return { ok: false, code: 'REF_NO_CHANGE', head: from };
      const head = { project_id: projectId, branch, head_commit: String(to), version: (current?.version ?? 0) + 1, updated_at: new Date(now()).toISOString() };
      heads.set(keyOf(projectId, branch), head);
      emit('ref.advanced', { ...head, from, actor, reason });
      return { ok: true, head: { ...head }, from };
    },
    listRefs({ projectId }) {
      return [...heads.values()].filter((head) => head.project_id === projectId).map((head) => ({ ...head }));
    },
    /** Queue a patch. A patch already merged on that branch is answered, not queued twice. */
    enqueue({ projectId, branch, patchSha256, baseCommit, sourceTaskId = null }) {
      if (!PATCH.test(String(patchSha256))) return { ok: false, code: 'INVALID_PATCH_SHA' };
      if (!SHA.test(String(baseCommit))) return { ok: false, code: 'INVALID_BASE_COMMIT' };
      for (const item of items.values()) {
        if (item.project_id === projectId && item.branch === branch && item.patch_sha256 === patchSha256 && item.state === 'merged') {
          return { ok: true, already_merged: true, item: { ...item } };
        }
      }
      counter += 1;
      const item = {
        queue_id: 'mq-' + idScope + String(counter).padStart(6, '0'),
        project_id: projectId,
        branch,
        patch_sha256: String(patchSha256),
        base_commit: String(baseCommit),
        source_task_id: sourceTaskId,
        state: 'queued',
        created_at: new Date(now()).toISOString(),
      };
      items.set(item.queue_id, item);
      emit('merge.queued', { ...item });
      return { ok: true, already_merged: false, item: { ...item } };
    },
    /** Record a terminal outcome. Only 'merged' advances the branch, and only from the recorded base. */
    complete({ queueId, outcome, headCommit = null, conflictSha256 = null }) {
      const item = items.get(queueId);
      if (item === undefined) return { ok: false, code: 'MERGE_ITEM_NOT_FOUND' };
      if (item.state !== 'queued') return { ok: false, code: 'MERGE_ITEM_ALREADY_SETTLED', state: item.state };
      if (!['merged', 'conflict', 'failed'].includes(outcome)) return { ok: false, code: 'INVALID_OUTCOME', outcome };
      if (outcome === 'merged') {
        const moved = this.advance({ projectId: item.project_id, branch: item.branch, from: item.base_commit, to: headCommit });
        if (moved.ok !== true) return { ok: false, code: 'REF_ADVANCE_REFUSED', ref: moved };
      }
      item.state = outcome;
      item.head_commit = outcome === 'merged' ? String(headCommit) : null;
      item.conflict_sha256 = outcome === 'conflict' && PATCH.test(String(conflictSha256)) ? String(conflictSha256) : null;
      item.settled_at = new Date(now()).toISOString();
      emit('merge.' + outcome, { ...item });
      return { ok: true, item: { ...item } };
    },
    listQueue({ projectId, branch = null }) {
      return [...items.values()]
        .filter((item) => item.project_id === projectId && (branch === null || item.branch === branch))
        .map((item) => ({ ...item }));
    },
    /** Serialisable copy of every branch head and merge-queue item (cross-relay merge / persistence). */
    snapshot() {
      return {
        refs: [...heads.values()]
          .map((head) => copy(head))
          .sort((left, right) => {
            const leftKey = keyOf(left.project_id, left.branch);
            const rightKey = keyOf(right.project_id, right.branch);
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          }),
        queue: [...items.values()]
          .map((item) => copy(item))
          .sort((left, right) => (left.queue_id < right.queue_id ? -1 : left.queue_id > right.queue_id ? 1 : 0)),
      };
    },
    /**
     * Replace refs (and, when the object form carries a queue, the merge queue).
     *
     * Accepts either `snapshot()`'s `{refs, queue}` or a bare refs array: a merge that only decides
     * branch heads must not silently clear the local merge queue, so the array form leaves it alone.
     */
    restore(snapshotOrRows) {
      const refsRows = Array.isArray(snapshotOrRows)
        ? snapshotOrRows
        : (snapshotOrRows !== null && typeof snapshotOrRows === 'object' && Array.isArray(snapshotOrRows.refs) ? snapshotOrRows.refs : null);
      if (refsRows === null) return { ok: false, code: 'BAD_SNAPSHOT' };
      const includeQueue = Array.isArray(snapshotOrRows) === false;
      const queueRows = includeQueue && Array.isArray(snapshotOrRows.queue) ? snapshotOrRows.queue : null;
      const rebuiltHeads = new Map();
      let skipped = 0;
      for (const row of refsRows) {
        const head = normalizeHeadRow(row);
        if (head === null) { skipped += 1; continue; }
        rebuiltHeads.set(keyOf(head.project_id, head.branch), head);
      }
      heads.clear();
      for (const [key, head] of rebuiltHeads) heads.set(key, head);
      let rebuiltItems = items;
      if (queueRows !== null) {
        rebuiltItems = new Map();
        for (const row of queueRows) {
          const item = normalizeQueueRow(row);
          if (item === null) { skipped += 1; continue; }
          rebuiltItems.set(item.queue_id, item);
          counter = Math.max(counter, idCounter(item.queue_id));
        }
        items.clear();
        for (const [queueId, item] of rebuiltItems) items.set(queueId, item);
      }
      seq = Math.max(seq, rebuiltHeads.size + rebuiltItems.size);
      return { ok: true, refs: rebuiltHeads.size, queue: rebuiltItems.size, skipped };
    },
    size() {
      return { heads: heads.size, items: items.size, events: seq };
    },
  };
}