/** S5: merge patches in an integration worktree; conflicts and base drift are first-class refusals. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { abortMerge, advanceTarget, mergePatches } from '../src/plugin/joint-dev/merge-engine.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-merge-repo-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'w2m@test');
  git(dir, 'config', 'user.name', 'w2m');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'line one\nline two\n', 'utf8');
  writeFileSync(join(dir, 'b.txt'), 'bee one\n', 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
};
const diffFor = (dir, file, content) => {
  writeFileSync(join(dir, file), content, 'utf8');
  const patch = execFileSync('git', ['diff'], { cwd: dir, encoding: 'utf8' });
  git(dir, 'checkout', '--', '.');
  return patch;
};

describe('merge engine', () => {
  it('applies patches for different files in order and reports the integration head', () => {
    const { dir, base } = repo();
    const patches = [
      { step_id: 's1', machine_id: 'm1', patch: diffFor(dir, 'a.txt', 'line ONE\nline two\n') },
      { step_id: 's2', machine_id: 'm2', patch: diffFor(dir, 'b.txt', 'bee TWO\n') },
    ];
    const result = mergePatches({ repoDir: dir, baseCommit: base, patches });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.applied.length, 2);
    assert.match(result.integration_head, /^[0-9a-f]{40}$/);
    assert.equal(git(result.worktree, 'show', 'HEAD:a.txt'), 'line ONE\nline two');
    assert.equal(git(result.worktree, 'show', 'HEAD:b.txt'), 'bee TWO');
    abortMerge({ repoDir: dir, worktree: result.worktree });
    assert.equal(existsSync(result.worktree), false);
    // the target branch is untouched until advanceTarget runs
    assert.equal(git(dir, 'rev-parse', 'main'), base);
  });

  it('refuses a conflicting patch and cleans the worktree', () => {
    const { dir, base } = repo();
    const patches = [
      { step_id: 's1', machine_id: 'm1', patch: diffFor(dir, 'a.txt', 'line ONE\nline two\n') },
      { step_id: 's2', machine_id: 'm2', patch: diffFor(dir, 'a.txt', 'line UNO\nline two\n') },
    ];
    const result = mergePatches({ repoDir: dir, baseCommit: base, patches });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MERGE_CONFLICT');
    assert.equal(result.detail.step_id, 's2');
    assert.equal(git(dir, 'rev-parse', 'main'), base);
  });

  it('refuses an unknown base commit', () => {
    const { dir } = repo();
    const result = mergePatches({ repoDir: dir, baseCommit: 'deadbeef', patches: [{ step_id: 's1', patch: 'x' }] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MERGE_BASE_MISMATCH');
  });

  it('advances the target by compare-and-swap and keeps a rollback ref', () => {
    const { dir, base } = repo();
    const merged = mergePatches({ repoDir: dir, baseCommit: base, patches: [{ step_id: 's1', machine_id: 'm1', patch: diffFor(dir, 'a.txt', 'line ONE\nline two\n') }] });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    const advance = advanceTarget({ repoDir: dir, targetRef: 'refs/heads/main', expectedOld: base, newCommit: merged.integration_head, rollbackRef: 'refs/w2m/rollback/t1' });
    assert.equal(advance.ok, true, JSON.stringify(advance));
    assert.equal(git(dir, 'rev-parse', 'main'), merged.integration_head);
    assert.equal(git(dir, 'rev-parse', 'refs/w2m/rollback/t1'), base);
    abortMerge({ repoDir: dir, worktree: merged.worktree });

    const stale = advanceTarget({ repoDir: dir, targetRef: 'refs/heads/main', expectedOld: base, newCommit: merged.integration_head });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'MERGE_BASE_MISMATCH');
  });

  it('rejects a non-commit or malformed rollback ref instead of passing it to git', () => {
    const { dir, base } = repo();
    const badRef = advanceTarget({ repoDir: dir, targetRef: 'refs/heads/main', expectedOld: base, newCommit: base, rollbackRef: '../../etc/passwd' });
    assert.equal(badRef.ok, false);
    assert.equal(badRef.code, 'MERGE_ROLLBACK_REF_INVALID');
    const badTarget = advanceTarget({ repoDir: dir, targetRef: 'main', expectedOld: base, newCommit: base });
    assert.equal(badTarget.ok, false);
    assert.equal(badTarget.code, 'MERGE_TARGET_INVALID');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'line one\nline two\n');
  });
});
