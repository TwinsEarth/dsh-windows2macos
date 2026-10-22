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

export function createProjectRefs({ now = () => Date.now(), onEvent = null } = {}) {
  const heads = new Map();
  const items = new Map();
  let counter = 0;
  let seq = 0;
  const emit = (type, payload) => {
    seq += 1;
    const event = { seq, type, at: new Date(now()).toISOString(), payload };
    if (typeof onEvent === 'function') onEvent(event);
    return event;
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
        queue_id: 'mq-' + String(counter).padStart(6, '0'),
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
    size() {
      return { heads: heads.size, items: items.size, events: seq };
    },
  };
}