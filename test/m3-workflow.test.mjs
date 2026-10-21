/**
 * M3 workflow test: worktree -> patch artifact -> merge queue (v1.3.10-beta.8 slice).
 *
 * The three modules were tested separately; this drives them together the way a real task pair would: two tasks start from
 * the same base in isolated worktrees, produce patches, and the queue merges them one after the other.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, commitTaskChanges, producePatch, removeWorktree } from '../src/agent/worktree.mjs';
import { describePatchArtifact } from '../src/agent/patch-artifact.mjs';
import { createMergeQueue } from '../src/relay/merge-queue.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-m3flow-' + name + '-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'a.txt'), 'base-a\n');
  writeFileSync(join(dir, 'b.txt'), 'base-b\n');
  git(dir, 'add', '--all');
  git(dir, 'commit', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

describe('M3 workflow: two tasks, two patches, one merge queue', () => {
  it('merges disjoint changes from isolated worktrees and keeps both', async () => {
    const { dir, base } = makeRepo('disjoint');
    const repo = join(dir, '..', 'wt-root');
    const wtA = join(repo, 'task-a');
    const wtB = join(repo, 'task-b');
    assert.equal((await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wtA })).ok, true);
    assert.equal((await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wtB })).ok, true);
    writeFileSync(join(wtA, 'a.txt'), 'task-a\n');
    writeFileSync(join(wtB, 'b.txt'), 'task-b\n');
    const commitA = await commitTaskChanges({ worktreeDir: wtA, message: 'task a' });
    const commitB = await commitTaskChanges({ worktreeDir: wtB, message: 'task b' });
    const patchA = await producePatch({ worktreeDir: wtA, baseCommit: base });
    const patchB = await producePatch({ worktreeDir: wtB, baseCommit: base });
    assert.equal(patchA.ok && patchB.ok, true);
    const artifactA = describePatchArtifact({ patch: patchA.patch, baseCommit: base, headCommit: commitA.headCommit });
    const artifactB = describePatchArtifact({ patch: patchB.patch, baseCommit: base, headCommit: commitB.headCommit });
    assert.equal(artifactA.outcome, 'changed');
    assert.equal(artifactB.outcome, 'changed');
    assert.notEqual(artifactA.sha256, artifactB.sha256);

    const queue = createMergeQueue({ policy: 'replay' });
    const first = queue.enqueue({ patch: patchA.patch, baseCommit: base, sourceTaskId: 'task-a' });
    const mergedA = await queue.apply({ item: first.item, repoDir: dir, headCommit: base });
    assert.equal(mergedA.ok, true);
    const second = queue.enqueue({ patch: patchB.patch, baseCommit: base, sourceTaskId: 'task-b' });
    const mergedB = await queue.apply({ item: second.item, repoDir: dir, headCommit: mergedA.headCommit });
    assert.equal(mergedB.ok, true, 'a disjoint patch replays onto the new head');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'task-a\n');
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'task-b\n');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), mergedB.headCommit);
    await removeWorktree({ repoDir: dir, worktreeDir: wtA });
    await removeWorktree({ repoDir: dir, worktreeDir: wtB });
  });

  it('surfaces a conflict as a first-class verdict when two tasks touch the same file', async () => {
    const { dir, base } = makeRepo('conflict');
    const repo = join(dir, '..', 'wt-root2');
    const wtA = join(repo, 'task-a');
    const wtB = join(repo, 'task-b');
    await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wtA });
    await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wtB });
    writeFileSync(join(wtA, 'a.txt'), 'A\n');
    writeFileSync(join(wtB, 'a.txt'), 'B\n');
    await commitTaskChanges({ worktreeDir: wtA });
    await commitTaskChanges({ worktreeDir: wtB });
    const patchA = await producePatch({ worktreeDir: wtA, baseCommit: base });
    const patchB = await producePatch({ worktreeDir: wtB, baseCommit: base });
    const queue = createMergeQueue({ policy: 'replay' });
    const first = queue.enqueue({ patch: patchA.patch, baseCommit: base });
    const mergedA = await queue.apply({ item: first.item, repoDir: dir, headCommit: base });
    assert.equal(mergedA.ok, true);
    const second = queue.enqueue({ patch: patchB.patch, baseCommit: base });
    const mergedB = await queue.apply({ item: second.item, repoDir: dir, headCommit: mergedA.headCommit });
    assert.equal(mergedB.ok, false);
    assert.equal(mergedB.code, 'MERGE_CONFLICT');
    assert.deepEqual(mergedB.files, ['a.txt']);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), mergedA.headCommit, 'a conflict leaves the head at the approved commit');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A\n');
    await removeWorktree({ repoDir: dir, worktreeDir: wtA });
    await removeWorktree({ repoDir: dir, worktreeDir: wtB });
  });
});
