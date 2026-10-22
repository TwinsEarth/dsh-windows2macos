/**
 * Isolated git worktrees for tasks (M3, v1.3.10-beta.6 slice).
 *
 * The old task model ran every command in the machine's own checkout. That cannot support two tasks that change code: they
 * would see each other's partial edits, and "which base was this change made against" would have no answer. A worktree per
 * task fixes both: the starting point is a commit the caller named, and everything the task changes is confined to a
 * directory the task owns.
 *
 * All git calls use argv arrays; nothing here goes through a shell, so a branch name or path cannot become a command.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function defaultGit() {
  return (args, cwd) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).trim()), { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Create a detached worktree at an exact commit and make it safe to run an agent in.
 *
 * @returns {Promise<{ok: true, worktreeDir: string, baseCommit: string} | {ok: false, code: string, message: string}>}
 */
export async function createWorktree({ repoDir, baseCommit, worktreeDir, git = defaultGit() }) {
  if (!existsSync(repoDir)) return { ok: false, code: 'REPO_NOT_FOUND', message: 'repository directory does not exist' };
  if (typeof baseCommit !== 'string' || !/^[0-9a-f]{7,64}$/.test(baseCommit)) return { ok: false, code: 'BASE_COMMIT_INVALID', message: 'base_commit must be a hex commit id' };
  if (typeof worktreeDir !== 'string' || worktreeDir === '') return { ok: false, code: 'WORKTREE_PATH_REQUIRED', message: 'worktreeDir is required' };
  try {
    await git(['rev-parse', '--verify', baseCommit + '^{commit}'], repoDir);
  } catch {
    return { ok: false, code: 'BASE_COMMIT_UNKNOWN', message: 'base_commit does not resolve in this repository' };
  }
  try {
    mkdirSync(join(worktreeDir, '..'), { recursive: true });
    await git(['worktree', 'add', '--detach', worktreeDir, baseCommit], repoDir);
  } catch (error) {
    return { ok: false, code: 'WORKTREE_CREATE_FAILED', message: error?.message ?? 'git worktree add failed' };
  }
  // The worktree's configuration is task-local: hooks cannot run a task's code behind its back, and commits must be
  // reproducible rather than attributed to whoever happens to be logged in.
  const isolates = [
    ['config', 'core.hooksPath', join(worktreeDir, '.no-hooks')],
    ['config', 'user.name', 'w2m-agent'],
    ['config', 'user.email', 'agent@w2m.invalid'],
    ['config', 'commit.gpgsign', 'false'],
  ];
  for (const argv of isolates) {
    try { await git(argv, worktreeDir); } catch { /* configuration is defense in depth; git add already succeeded */ }
  }
  return { ok: true, worktreeDir, baseCommit };
}

/** A porcelain snapshot, used before and after a task as evidence of what changed. */
export async function snapshotStatus({ worktreeDir, git = defaultGit() }) {
  try {
    const { stdout } = await git(['status', '--porcelain'], worktreeDir);
    return { ok: true, dirty: stdout.trim() !== '', status: stdout };
  } catch (error) {
    return { ok: false, code: 'STATUS_FAILED', message: error?.message ?? 'git status failed' };
  }
}

/**
 * Commit whatever the task changed, if anything.
 *
 * @returns {Promise<{ok: true, changed: boolean, headCommit: string|null, message: string|null} | {ok: false, code: string, message: string}>}
 */
export async function commitTaskChanges({ worktreeDir, message = 'task output', git = defaultGit() }) {
  const before = await snapshotStatus({ worktreeDir, git });
  if (before.ok !== true) return { ok: false, code: 'STATUS_FAILED', message: before.message };
  if (before.dirty === false) {
    const head = await git(['rev-parse', 'HEAD'], worktreeDir).then((r) => r.stdout.trim()).catch(() => null);
    return { ok: true, changed: false, headCommit: head, message: null };
  }
  try {
    await git(['add', '--all'], worktreeDir);
    await git(['commit', '-m', message], worktreeDir);
    const head = (await git(['rev-parse', 'HEAD'], worktreeDir)).stdout.trim();
    return { ok: true, changed: true, headCommit: head, message };
  } catch (error) {
    return { ok: false, code: 'COMMIT_FAILED', message: error?.message ?? 'git commit failed' };
  }
}

/** Produce the transportable form of the change: a patch relative to the task's base commit. */
export async function producePatch({ worktreeDir, baseCommit, git = defaultGit() }) {
  try {
    const { stdout } = await git(['format-patch', '--stdout', '--binary', baseCommit], worktreeDir);
    return { ok: true, patch: stdout, bytes: Buffer.byteLength(stdout, 'utf8'), empty: stdout.trim() === '' };
  } catch (error) {
    return { ok: false, code: 'PATCH_FAILED', message: error?.message ?? 'git format-patch failed' };
  }
}

/** Remove a worktree. Failure is reported, never hidden: a leaked worktree blocks the next task on that path. */
export async function listChangedFiles({ worktreeDir, baseCommit, git = defaultGit() }) {
  try {
    const result = await git(['diff', '--name-only', baseCommit + '..HEAD'], worktreeDir);
    return { ok: true, files: String(result.stdout).split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line !== '').sort() };
  } catch (error) {
    return { ok: false, code: 'DIFF_FAILED', message: error?.message ?? 'git diff failed' };
  }
}

export async function removeWorktree({ repoDir, worktreeDir, force = true, git = defaultGit() }) {
  try {
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreeDir];
    await git(args, repoDir);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'WORKTREE_REMOVE_FAILED', message: error?.message ?? 'git worktree remove failed' };
  }
}
