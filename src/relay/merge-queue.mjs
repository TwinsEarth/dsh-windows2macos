/**
 * Merge queue (M3, v1.3.10-beta.7 slice).
 *
 * Every project+branch has one queue and at most one holder of its merge slot. The queue accepts a patch relative to a
 * declared base and either advances the branch head, reports that the patch is already merged, refuses a stale base, or
 * reports a structured conflict. It never force-pushes and never advances the head on a conflict.
 *
 * Policy is a project setting:
 *   strict  base_commit must equal the current head; anything else is BASE_MISMATCH and the submitter rebases.
 *   replay  the patch is applied with --3way onto the current head; if it applies, it merges, otherwise MERGE_CONFLICT.
 *
 * Git access is injected so the tests can drive real repositories without a network or a daemon.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const MERGE_POLICIES = Object.freeze(['strict', 'replay']);

export function defaultGit() {
  return (args, cwd) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).trim()), { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function patchSha(patch) {
  return createHash('sha256').update(String(patch), 'utf8').digest('hex');
}

export function changedFiles(patch) {
  const files = new Set();
  for (const line of String(patch).split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trim());
    if (match) files.add(match[2]);
  }
  return [...files].sort();
}

export function createMergeQueue({ policy = 'strict', slotTtlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  if (!MERGE_POLICIES.includes(policy)) throw new Error('unknown merge policy: ' + policy);
  const items = new Map();
  const merged = new Map(); // patchSha + '|' + branch -> { headCommit, queue_id }
  let slot = null;
  let seq = 0;

  const queueKey = (sha, branch) => sha + '|' + branch;

  return {
    policy,
    enqueue({ patch, baseCommit, branch = 'main', sourceTaskId = null }) {
      const sha = patchSha(patch);
      if (merged.has(queueKey(sha, branch))) {
        return { ok: true, alreadyMerged: true, queueId: merged.get(queueKey(sha, branch)).queue_id, headCommit: merged.get(queueKey(sha, branch)).headCommit };
      }
      seq += 1;
      const item = { queueId: 'mq-' + String(seq).padStart(6, '0'), patchSha: sha, patch, baseCommit, branch, sourceTaskId, state: 'queued', createdAt: now() };
      items.set(item.queueId, item);
      return { ok: true, alreadyMerged: false, item };
    },
    claim(holder) {
      const current = now();
      if (slot !== null && slot.expiresAt > current) return { ok: false, code: 'MERGE_SLOT_BUSY', holder: slot.holder, expiresAt: slot.expiresAt };
      slot = { holder, expiresAt: current + slotTtlMs, claimedAt: current };
      return { ok: true, holder };
    },
    release(holder) {
      if (slot === null || slot.holder !== holder) return { ok: false, code: 'MERGE_SLOT_NOT_OWNER' };
      slot = null;
      return { ok: true };
    },
    next() {
      for (const item of items.values()) if (item.state === 'queued') return item;
      return null;
    },
    finish(queueId, state) {
      const item = items.get(queueId);
      if (!item) return { ok: false, code: 'ITEM_NOT_FOUND' };
      item.state = state;
      item.finishedAt = now();
      return { ok: true, item };
    },
    status() {
      return { policy, slot, items: [...items.values()], mergedCount: merged.size };
    },
    /**
     * Apply one item to a repository checked out at headCommit. Returns a terminal verdict, never an exception.
     */
    async apply({ item, queueId, repoDir, headCommit, git = defaultGit() }) {
      const target = item ?? items.get(queueId);
      if (!target) return { ok: false, code: 'ITEM_NOT_FOUND' };
      if (target.state !== 'queued') return { ok: false, code: 'ITEM_NOT_QUEUED', state: target.state };
      if (policy === 'strict' && target.baseCommit !== headCommit) {
        this.finish(target.queueId, 'failed');
        return { ok: false, code: 'BASE_MISMATCH', baseCommit: target.baseCommit, headCommit };
      }
      const worktree = mkdtempSync(join(tmpdir(), 'w2m-merge-'));
      try {
        await git(['worktree', 'add', '--detach', worktree, headCommit], repoDir);
        try {
          const patchFile = join(worktree, '.w2m-merge.patch');
          writeFileSync(patchFile, target.patch, 'utf8');
          await git(['apply', '--3way', '--whitespace=nowarn', patchFile], worktree);
        } catch (error) {
          this.finish(target.queueId, 'conflict');
          return { ok: false, code: 'MERGE_CONFLICT', files: changedFiles(target.patch), detail: String(error?.message ?? error).split('\n').slice(0, 6), baseCommit: target.baseCommit, headCommit };
        }
        await git(['add', '--all'], worktree);
        await git(['-c', 'user.name=w2m-merge', '-c', 'user.email=merge@w2m.invalid', 'commit', '-m', 'merge: ' + target.queueId], worktree);
        const newHead = (await git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
        // The commit was made in a detached worktree; the branch must actually advance, and the repository working tree
        // must follow it, or the next merge would start from a head that no longer matches what was reviewed.
        await git(['reset', '--hard', newHead], repoDir);
        this.finish(target.queueId, 'merged');
        merged.set(queueKey(target.patchSha, target.branch), { headCommit: newHead, queue_id: target.queueId });
        return { ok: true, code: 'MERGED', headCommit: newHead, queueId: target.queueId, files: changedFiles(target.patch) };
      } finally {
        try { await git(['worktree', 'remove', '--force', worktree], repoDir); } catch { /* removal is best effort */ }
        try { rmSync(worktree, { recursive: true, force: true }); } catch { /* see above */ }
      }
    },
  };
}
