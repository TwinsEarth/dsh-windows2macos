/**
 * Patch artifacts (M3, v1.3.10-beta.6 slice).
 *
 * A task's code change must be transportable and self-describing: the receiver needs the bytes, the hash that names them,
 * and the base commit they apply to. This module turns a patch into that contract. It never applies a patch and never decides
 * whether the patch is acceptable — the merge queue owns that.
 */
import { createHash } from 'node:crypto';

export const PATCH_FORMAT = 'git-format-patch';

/**
 * @param {{patch: string, baseCommit: string, headCommit?: string|null, filesChanged?: string[],
 *          tests?: object|null, outputMode?: 'inline'|'blob'}} input
 */
export function describePatchArtifact(input) {
  const patch = typeof input?.patch === 'string' ? input.patch : null;
  if (patch === null) return { ok: false, code: 'PATCH_REQUIRED', message: 'patch text is required' };
  if (typeof input.baseCommit !== 'string' || !/^[0-9a-f]{7,64}$/.test(input.baseCommit)) {
    return { ok: false, code: 'BASE_COMMIT_INVALID', message: 'base_commit must be a hex commit id' };
  }
  const bytes = Buffer.byteLength(patch, 'utf8');
  const empty = patch.trim() === '';
  if (empty && input.allowEmpty !== true) {
    return { ok: true, empty: true, outcome: 'no_change', format: PATCH_FORMAT, baseCommit: input.baseCommit, bytes: 0, sha256: null };
  }
  const sha256 = createHash('sha256').update(patch, 'utf8').digest('hex');
  return {
    ok: true,
    empty: false,
    outcome: 'changed',
    format: PATCH_FORMAT,
    sha256,
    bytes,
    outputMode: input.outputMode === 'blob' ? 'blob' : 'inline',
    baseCommit: input.baseCommit,
    headCommit: typeof input.headCommit === 'string' && input.headCommit !== '' ? input.headCommit : null,
    filesChanged: Array.isArray(input.filesChanged) ? [...input.filesChanged].sort() : [],
    tests: input.tests ?? null,
  };
}

/** The fields a task result carries for a worktree task (see docs/COLLAB/TASK-MODEL.md §7). */
export function workspaceEvidence({ workspace, patchArtifact }) {
  if (patchArtifact?.ok !== true) return { ok: false, code: 'PATCH_ARTIFACT_REQUIRED' };
  return {
    ok: true,
    workspace: workspace ?? null,
    artifacts: patchArtifact.empty
      ? []
      : [{ kind: 'patch', sha256: patchArtifact.sha256, bytes: patchArtifact.bytes, output_mode: patchArtifact.outputMode }],
  };
}
