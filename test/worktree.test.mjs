/**
 * Worktree workspace tests (M3, v1.3.10-beta.6 slice).
 *
 * These drive real git: a fake git would pass while the actual workflow failed, and this module's whole job is the real
 * repository state. Each case builds a throwaway repository in the OS temp directory.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, snapshotStatus, commitTaskChanges, producePatch, removeWorktree } from '../src/agent/worktree.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-wt-' + name + '-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(dir, 'a.txt'), 'base');
  git(dir, 'add', '--all');
  git(dir, 'commit', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

describe('worktree workspace', () => {
  it('creates an isolated tree at the exact base commit', async () => {
    const { dir, base } = makeRepo('create');
    const wt = join(dir + '-worktrees', 'task1');
    const made = await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wt });
    assert.equal(made.ok, true);
    assert.equal(git(wt, 'rev-parse', 'HEAD'), base);
    assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'base');
    assert.equal(existsSync(join(wt, '.git')), true, 'a worktree carries a .git file');
  });

  it('keeps two worktrees independent and commits only the task changes', async () => {
    const { dir, base } = makeRepo('two');
    const wt1 = join(dir + '-worktrees', 'one');
    const wt2 = join(dir + '-worktrees', 'two');
    assert.equal((await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wt1 })).ok, true);
    assert.equal((await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wt2 })).ok, true);
    writeFileSync(join(wt1, 'a.txt'), 'one\n');
    writeFileSync(join(wt2, 'b.txt'), 'two\n');
    const committed = await commitTaskChanges({ worktreeDir: wt1, message: 'task one' });
    assert.equal(committed.changed, true);
    assert.notEqual(committed.headCommit, base);
    assert.equal(readFileSync(join(wt2, 'a.txt'), 'utf8'), 'base', 'the second task never sees the first task edit');
    const patch = await producePatch({ worktreeDir: wt1, baseCommit: base });
    assert.equal(patch.ok, true);
    assert.equal(patch.empty, false);
    assert.match(patch.patch, /one/);
    const second = await commitTaskChanges({ worktreeDir: wt2, message: 'task two' });
    assert.equal(second.changed, true);
  });

  it('reports an unchanged task as no_change instead of an error', async () => {
    const { dir, base } = makeRepo('nochange');
    const wt = join(dir + '-worktrees', 'same');
    await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wt });
    const before = await snapshotStatus({ worktreeDir: wt });
    assert.equal(before.dirty, false);
    const committed = await commitTaskChanges({ worktreeDir: wt });
    assert.equal(committed.changed, false);
    const patch = await producePatch({ worktreeDir: wt, baseCommit: base });
    assert.equal(patch.empty, true);
  });

  it('refuses an unknown base commit and an unknown repository by name', async () => {
    const { dir } = makeRepo('unknown');
    const unknownBase = await createWorktree({ repoDir: dir, baseCommit: 'f'.repeat(40), worktreeDir: join(dir + '-wt', 'x') });
    assert.equal(unknownBase.code, 'BASE_COMMIT_UNKNOWN');
    const unknownRepo = await createWorktree({ repoDir: join(dir, 'missing'), baseCommit: 'a'.repeat(40), worktreeDir: join(dir + '-wt', 'y') });
    assert.equal(unknownRepo.code, 'REPO_NOT_FOUND');
  });

  it('removes a worktree so the next task can reuse the path', async () => {
    const { dir, base } = makeRepo('remove');
    const wt = join(dir + '-worktrees', 'gone');
    await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wt });
    const removed = await removeWorktree({ repoDir: dir, worktreeDir: wt });
    assert.equal(removed.ok, true);
    assert.equal(existsSync(wt), false);
    const again = await createWorktree({ repoDir: dir, baseCommit: base, worktreeDir: wt });
    assert.equal(again.ok, true);
  });
});
