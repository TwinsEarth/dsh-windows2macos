/**
 * Fleet-sync suite (rule 1: broadcast, sync, merge).
 *
 * The state machine this tests is the whole point of the rule, and it is a state machine about **safety**:
 * three of its four states are safe to automate and one is not, and getting the boundary wrong in either
 * direction is costly. Too permissive and an automatic merge rewrites a commit somebody else published;
 * too cautious and every machine stops for a human over a fast-forward.
 *
 * So each state is constructed for real, in a real git repository, with a real bare remote. A suite that
 * mocked git would be testing the mock.
 *
 * What these tests need and cannot assume: `git` on PATH. The suite skips itself with a named reason when
 * it is absent rather than failing, because "git is not installed here" is an environment fact and not a
 * defect in this code.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act, inspect, report } from '../scripts/fleet-sync.mjs';

/** Absolute path to git, or null. */
function findGit() {
  const candidates = [
    'git',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    '/usr/bin/git',
    '/usr/local/bin/git',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      return c;
    } catch { /* try the next */ }
  }
  return null;
}

const GIT = findGit();
const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

/** git, with identity pinned so a commit cannot fail for an environment reason. */
function git(cwd, args) {
  return execFileSync(GIT, ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Sync Test', GIT_AUTHOR_EMAIL: 'sync@test.local',
      GIT_COMMITTER_NAME: 'Sync Test', GIT_COMMITTER_EMAIL: 'sync@test.local',
      GIT_CONFIG_GLOBAL: join(tmpdir(), 'w2m-sync-nonexistent-gitconfig'),
      GIT_CONFIG_SYSTEM: join(tmpdir(), 'w2m-sync-nonexistent-gitconfig'),
    },
  }).trim();
}

/**
 * A bare remote plus two clones, wired together and given a **repository-local** identity.
 *
 * The identity is set with `git config` rather than passed only through the environment, because the code
 * under test reads it back with `git config user.email` before attempting a rebase -- an earlier fixture
 * set only environment variables, so the code saw no identity, refused to rebase, and the tests that were
 * supposed to exercise rebasing failed for a reason that had nothing to do with rebasing.
 *
 * `work` and `other` are both clones, so a commit pushed from `other` is a genuine remote change from
 * `work`'s point of view rather than a fabricated ref.
 */
function makeFleet() {
  const root = tmp('w2m-sync-');
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const other = join(root, 'other');
  mkdirSync(remote, { recursive: true });
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  git(root, ['clone', remote, work]);
  git(work, ['config', 'user.name', 'Sync Test']);
  git(work, ['config', 'user.email', 'sync@test.local']);
  git(work, ['commit', '--allow-empty', '-m', 'initial']);
  git(work, ['push', '-u', 'origin', 'main']);
  git(root, ['clone', remote, other]);
  git(other, ['config', 'user.name', 'Sync Test']);
  git(other, ['config', 'user.email', 'sync@test.local']);
  return { root, remote, work, other };
}

const commit = (cwd, message) => {
  writeFileSync(join(cwd, `${message.replace(/\W/g, '_')}.txt`), message);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
};

describe('fleet sync: the four states, each built for real', { skip: GIT === null ? 'git is not installed on this machine' : false }, () => {
  it('reports no-repo for a directory that is not a repository', () => {
    const state = inspect(tmp('w2m-norepo-'));
    assert.equal(state.state, 'no-repo');
    assert.equal(state.action, 'none');
    // And the reporter must survive it: the first version read `state.dirty.length` unconditionally and
    // crashed with a TypeError while trying to say "this is not a repository".
    assert.match(report(state, null), /no-repo/);
  });

  it('reports up-to-date when local and remote agree', () => {
    const { work } = makeFleet();
    const state = inspect(work);
    assert.equal(state.state, 'up-to-date');
    assert.equal(state.action, 'none');
    assert.equal(state.ahead, 0);
    assert.equal(state.behind, 0);
  });

  it('reports behind and fast-forwards, which can lose nothing', () => {
    const { work, other } = makeFleet();
    commit(other, 'remote work');
    git(other, ['push']);

    const state = inspect(work);
    assert.equal(state.state, 'behind');
    assert.equal(state.action, 'fast-forward');
    assert.equal(state.behind, 1);

    const outcome = act(state, { cwd: work, write: true });
    assert.equal(outcome.performed, true);
    assert.equal(inspect(work).state, 'up-to-date');
  });

  it('reports ahead and pushes, broadcasting the work', () => {
    const { work } = makeFleet();
    commit(work, 'local work');
    const state = inspect(work);
    assert.equal(state.state, 'ahead');
    assert.equal(state.action, 'push');

    const outcome = act(state, { cwd: work, write: true });
    assert.equal(outcome.performed, true);
    assert.equal(inspect(work).state, 'up-to-date');
  });

  it('rebases when local commits exist on no remote', () => {
    // The safe divergence: this machine's commit is nowhere else, so moving it cannot delete anybody's
    // work.
    const { work, other } = makeFleet();
    commit(other, 'their work');
    git(other, ['push']);
    commit(work, 'my unpublished work');

    const state = inspect(work);
    assert.equal(state.state, 'diverged-unpublished');
    assert.equal(state.action, 'rebase');
    assert.equal(state.local_only, 1);

    const outcome = act(state, { cwd: work, write: true });
    assert.equal(outcome.performed, true);
    assert.equal(inspect(work).state, 'ahead', 'after rebasing it is ahead and needs publishing');
  });

  it('STOPS when a local commit is reachable from any remote ref, because rewriting it could discard work', () => {
    // ## Why this test is not "both sides published on one branch"
    //
    // Three fixtures were tried for that shape and all three failed, for a reason that turned out to be
    // structural rather than a mistake: **on a single upstream, a published divergence cannot exist.** If a
    // local commit is reachable from `origin/main`, then HEAD is an ancestor of `origin/main`, so `behind`
    // is 0 and there is no divergence at all -- the state is `ahead`. Everything in `mergeBase..HEAD` is by
    // construction unreachable from the upstream. The old code could report `diverged-published` only
    // because its test for it was dead code that never evaluated true.
    //
    // So the reachable version of the hazard is a local commit that some **other** remote ref already has:
    // a branch pushed as a feature, then rewritten locally. Rewriting it again is how one machine silently
    // discards work another machine can still see, which is exactly what this state is for.
    const { work, other } = makeFleet();
    commit(other, 'remote move');
    git(other, ['push']);

    // Publish the local commit to a *side* ref, then make the upstream move on without it.
    commit(work, 'work that was pushed once');
    git(work, ['push', 'origin', 'main:feature/pushed']);
    git(work, ['fetch', 'origin']);

    // Now the upstream advances, so this branch has diverged while its commit is still reachable from
    // `origin/feature/pushed`.
    git(other, ['pull', '--ff-only']);
    commit(other, 'remote moves again');
    git(other, ['push']);
    git(work, ['fetch', 'origin']);

    const state = inspect(work);
    assert.equal(state.state, 'diverged-published');
    assert.equal(state.action, 'stop');
    assert.ok(state.published_commits >= 1, `the report must say how many commits are reachable from a remote ref (got ${state.published_commits})`);
    assert.match(state.detail, /reachable from a remote ref/);

    const outcome = act(state, { cwd: work, write: true });
    assert.equal(outcome.performed, false, 'a reachable divergence must not be resolved automatically');
    assert.equal(inspect(work).state, 'diverged-published', 'and the tree must be left untouched');
  });

  it('refuses to rebase without a committer identity, rather than wedging the repository', () => {
    // Found by running it: `git rebase` failed on a missing identity and left the tree in a detached HEAD
    // with `.git/rebase-merge` present -- needing a person. An automatic tool that can wedge a repository
    // is worse than one that does nothing, so the identity is checked before starting and a failure aborts.
    const { work, other } = makeFleet();
    commit(other, 'their work');
    git(other, ['push']);
    commit(work, 'my unpublished work');

    // Strip the identity that `makeFleet` pins, leaving neither config nor environment to fall back on.
    git(work, ['config', '--unset', 'user.email']);
    git(work, ['config', '--unset', 'user.name']);

    const state = inspect(work);
    assert.equal(state.state, 'diverged-unpublished');

    const saved = { name: process.env.GIT_COMMITTER_NAME, email: process.env.GIT_COMMITTER_EMAIL };
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    try {
      const outcome = act(state, { cwd: work, write: true });
      assert.equal(outcome.performed, false);
      assert.equal(outcome.action, 'stop');
      assert.match(outcome.detail, /committer identity/);
      assert.equal(existsSync(join(work, '.git', 'rebase-merge')), false, 'the repository must not be left mid-rebase');
      assert.equal(inspect(work).state, 'diverged-unpublished', 'and must be exactly where it was');
    } finally {
      if (saved.name !== undefined) process.env.GIT_COMMITTER_NAME = saved.name;
      if (saved.email !== undefined) process.env.GIT_COMMITTER_EMAIL = saved.email;
    }
  });
});

describe('fleet sync: what it refuses to do', { skip: GIT === null ? 'git is not installed on this machine' : false }, () => {
  it('refuses to sync under uncommitted changes', () => {
    // The uncommitted changes belong to whoever made them -- a running task, most likely -- and rebasing
    // or fast-forwarding underneath them is how a machine loses work it never claimed.
    const { work, other } = makeFleet();
    commit(other, 'their work');
    git(other, ['push']);
    writeFileSync(join(work, 'uncommitted.txt'), 'in progress');

    const state = inspect(work);
    assert.equal(state.dirty.length, 1);
    const outcome = act(state, { cwd: work, write: true });
    assert.equal(outcome.performed, false);
    assert.equal(outcome.action, 'stop');
    assert.match(outcome.detail, /refusing to sync/);
    // The remote commit must still not be applied.
    assert.equal(inspect(work).state, 'behind');
  });

  it('changes nothing without --write', () => {
    const { work, other } = makeFleet();
    commit(other, 'their work');
    git(other, ['push']);
    const state = inspect(work);
    const outcome = act(state, { cwd: work, write: false });
    assert.equal(outcome.performed, false);
    assert.match(outcome.detail, /dry run/);
    assert.equal(inspect(work).state, 'behind', 'a dry run must leave the tree where it was');
  });

  it('reports no-upstream as its own state rather than as "in sync"', () => {
    // "Nothing to sync from" and "already in sync" must not read alike: the first means the branch has
    // never been broadcast, which is a different problem from having nothing to do.
    //
    // Three fixtures failed here, each for a different reason worth keeping. `git init` + `remote add`
    // still had the branch on the remote because the helper had already cloned it there. `git branch -m`
    // did not help: renaming **keeps** `branch.<name>.merge`, so the upstream survived. And pointing at an
    // *empty* bare repo still resolved `origin/main`, because `git clone` had left a remote-tracking ref
    // behind. The unambiguous case is a repository with no remote at all -- which is what a machine that
    // has never broadcast anything actually looks like.
    const solo = tmp('w2m-noup-');
    git(solo, ['init', '--initial-branch=main']);
    git(solo, ['config', 'user.name', 'Sync Test']);
    git(solo, ['config', 'user.email', 'sync@test.local']);
    commit(solo, 'first');

    const state = inspect(solo);
    assert.equal(state.state, 'no-upstream');
    assert.equal(state.action, 'none');
    assert.ok(state.detail.includes('does not exist'), state.detail);
  });
});
