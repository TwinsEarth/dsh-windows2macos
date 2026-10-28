/**
 * S5 MergeEngine: apply machine patches in order inside an integration worktree.
 *
 * Local git only. The engine never touches the target ref: `advanceTarget` is a separate,
 * compare-and-swap step the operator runs only after the user approves the merged head. A conflict
 * is a first-class refusal (`MERGE_CONFLICT`) — patches are not auto-resolved and force is never
 * passed to git.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defaultRunGit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function assertBaseCommit(repoDir, baseCommit, runGit) {
  try { runGit(['cat-file', '-e', `${baseCommit}^{commit}`], repoDir); return true; } catch { return false; }
}

/** @returns {{ok: true, worktree: string, integration_head: string, applied: object[]} | {ok: false, code: string, detail?: object}} */
export function mergePatches({ repoDir, baseCommit, patches, runGit = defaultRunGit }) {
  if (typeof repoDir !== 'string' || repoDir === '') return { ok: false, code: 'MERGE_REPO_REQUIRED' };
  if (typeof baseCommit !== 'string' || !/^[0-9a-f]{7,40}$/.test(baseCommit)) return { ok: false, code: 'MERGE_BASE_INVALID' };
  if (!Array.isArray(patches) || patches.length === 0) return { ok: false, code: 'MERGE_PATCHES_REQUIRED' };
  if (assertBaseCommit(repoDir, baseCommit, runGit) !== true) return { ok: false, code: 'MERGE_BASE_MISMATCH', detail: { base_commit: baseCommit } };

  const worktree = mkdtempSync(join(tmpdir(), 'w2m-merge-'));
  const cleanup = () => {
    try { runGit(['worktree', 'remove', '--force', worktree], repoDir); } catch { /* already gone */ }
    try { rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    runGit(['worktree', 'add', '--detach', worktree, baseCommit], repoDir);
  } catch (error) {
    cleanup();
    return { ok: false, code: 'MERGE_WORKTREE_FAILED', detail: { message: error instanceof Error ? error.message : String(error) } };
  }

  const applied = [];
  try {
    for (const patch of patches) {
      if (typeof patch?.step_id !== 'string' || typeof patch?.patch !== 'string' || patch.patch === '') {
        cleanup();
        return { ok: false, code: 'MERGE_PATCH_INVALID', detail: { step_id: patch?.step_id ?? null } };
      }
      const file = join(worktree, '.w2m-patch-' + patch.step_id.replace(/[^A-Za-z0-9_-]/g, '_') + '.diff');
      writeFileSync(file, patch.patch, 'utf8');
      try {
        runGit(['apply', '--3way', '--check', file], worktree);
      } catch {
        const files = (() => {
          try { return runGit(['apply', '--check', '--numstat', file], worktree).split('\n').map((line) => line.split('\t').pop()).filter(Boolean); } catch { return []; }
        })();
        cleanup();
        return { ok: false, code: 'MERGE_CONFLICT', detail: { step_id: patch.step_id, machine_id: patch.machine_id ?? null, files } };
      }
      try {
        runGit(['apply', '--3way', file], worktree);
      } catch {
        const applyFailed = { step_id: patch.step_id, machine_id: patch.machine_id ?? null };
        cleanup();
        return { ok: false, code: 'MERGE_CONFLICT', detail: applyFailed };
      }
      runGit(['add', '-A'], worktree);
      runGit(['commit', '-m', `w2m: ${patch.step_id} (${patch.machine_id ?? 'unknown'})`, '--no-verify'], worktree);
      applied.push({ step_id: patch.step_id, machine_id: patch.machine_id ?? null });
    }
    const integrationHead = runGit(['rev-parse', 'HEAD'], worktree);
    return { ok: true, worktree, integration_head: integrationHead, applied };
  } catch (error) {
    cleanup();
    return { ok: false, code: 'MERGE_APPLY_FAILED', detail: { message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Compare-and-swap the target ref; force is impossible here because update-ref takes the old value. */
export function advanceTarget({ repoDir, targetRef, expectedOld, newCommit, rollbackRef, runGit = defaultRunGit }) {
  if (typeof targetRef !== 'string' || !/^refs\/heads\/[\w./-]+$/.test(targetRef)) return { ok: false, code: 'MERGE_TARGET_INVALID' };
  if (typeof newCommit !== 'string' || !/^[0-9a-f]{7,40}$/.test(newCommit)) return { ok: false, code: 'MERGE_COMMIT_INVALID' };
  if (typeof expectedOld !== 'string' || !/^[0-9a-f]{7,40}$/.test(expectedOld)) return { ok: false, code: 'MERGE_OLD_REQUIRED' };
  const current = (() => { try { return runGit(['rev-parse', targetRef], repoDir); } catch { return null; } })();
  if (current !== expectedOld) return { ok: false, code: 'MERGE_BASE_MISMATCH', detail: { expected: expectedOld, current } };
  if (typeof rollbackRef === 'string' && rollbackRef !== '') {
    if (!/^refs\/w2m\/rollback\/[\w./-]+$/.test(rollbackRef)) return { ok: false, code: 'MERGE_ROLLBACK_REF_INVALID' };
    runGit(['update-ref', rollbackRef, expectedOld], repoDir);
  }
  try {
    runGit(['update-ref', targetRef, newCommit, expectedOld], repoDir);
  } catch (error) {
    return { ok: false, code: 'MERGE_CAS_FAILED', detail: { message: error instanceof Error ? error.message : String(error) } };
  }
  return { ok: true, target_ref: targetRef, head: newCommit, rollback_ref: typeof rollbackRef === 'string' && rollbackRef !== '' ? rollbackRef : null };
}

/** Remove an integration worktree (after a merge, a refusal or an abort). */
export function abortMerge({ repoDir, worktree, runGit = defaultRunGit }) {
  if (typeof worktree === 'string' && worktree !== '') {
    try { runGit(['worktree', 'remove', '--force', worktree], repoDir); } catch { /* already gone */ }
    try { rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return { ok: true };
}
