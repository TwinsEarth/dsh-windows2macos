/**
 * Merge queue tests (M3, v1.3.10-beta.7 slice). Real git, throwaway repositories.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMergeQueue, patchSha } from '../src/relay/merge-queue.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', input: undefined }).trim();

function makeRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-mq-' + name + '-'));
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

function patchChanging(dir, base, file, content, message = 'change') {
  const wt = mkdtempSync(join(tmpdir(), 'w2m-mq-wt-'));
  git(dir, 'worktree', 'add', '--detach', wt, base);
  writeFileSync(join(wt, file), content);
  git(wt, 'add', '--all');
  git(wt, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', message);
  const patch = execFileSync('git', ['format-patch', '--stdout', base], { cwd: wt, encoding: 'utf8' });
  git(dir, 'worktree', 'remove', '--force', wt);
  return patch;
}

describe('merge queue', () => {
  it('merges a patch onto its base and advances the head', async () => {
    const { dir, base } = makeRepo('merge');
    const queue = createMergeQueue();
    const patch = patchChanging(dir, base, 'a.txt', 'changed-a\n');
    const enqueued = queue.enqueue({ patch, baseCommit: base });
    assert.equal(enqueued.ok, true);
    const applied = await queue.apply({ item: enqueued.item, repoDir: dir, headCommit: base });
    assert.equal(applied.ok, true);
    assert.equal(applied.code, 'MERGED');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), applied.headCommit);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'changed-a\n');
  });

  it('reports already_merged instead of applying the same patch twice', async () => {
    const { dir, base } = makeRepo('idem');
    const queue = createMergeQueue();
    const patch = patchChanging(dir, base, 'a.txt', 'once\n');
    const first = queue.enqueue({ patch, baseCommit: base });
    const applied = await queue.apply({ item: first.item, repoDir: dir, headCommit: base });
    assert.equal(applied.ok, true);
    const second = queue.enqueue({ patch, baseCommit: applied.headCommit });
    assert.equal(second.alreadyMerged, true);
    assert.equal(second.headCommit, applied.headCommit);
  });

  it('refuses a stale base under strict policy by name', async () => {
    const { dir, base } = makeRepo('strict');
    const queue = createMergeQueue({ policy: 'strict' });
    const patch = patchChanging(dir, base, 'a.txt', 'stale\n');
    const enqueued = queue.enqueue({ patch, baseCommit: base });
    const applied = await queue.apply({ item: enqueued.item, repoDir: dir, headCommit: 'f'.repeat(40) });
    assert.equal(applied.ok, false);
    assert.equal(applied.code, 'BASE_MISMATCH');
  });

  it('reports MERGE_CONFLICT with the changed files and leaves the head alone', async () => {
    const { dir, base } = makeRepo('conflict');
    const queue = createMergeQueue({ policy: 'replay' });
    const patchA = patchChanging(dir, base, 'a.txt', 'A\n');
    const first = queue.enqueue({ patch: patchA, baseCommit: base });
    const mergedA = await queue.apply({ item: first.item, repoDir: dir, headCommit: base });
    assert.equal(mergedA.ok, true);
    const patchB = patchChanging(dir, base, 'a.txt', 'B\n');
    const second = queue.enqueue({ patch: patchB, baseCommit: base });
    const conflict = await queue.apply({ item: second.item, repoDir: dir, headCommit: mergedA.headCommit });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'MERGE_CONFLICT');
    assert.deepEqual(conflict.files, ['a.txt']);
    assert.ok(conflict.conflictArtifact, 'the conflict itself is captured as an artifact');
    assert.match(conflict.conflictArtifact.text, /<<<<<<<|=======|>>>>>>>/);
    assert.match(conflict.conflictArtifact.sha256, /^[0-9a-f]{64}$/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), mergedA.headCommit, 'a conflict never advances the head');
  });

  it('replays a clean patch onto a moved head under replay policy', async () => {
    const { dir, base } = makeRepo('replay');
    const queue = createMergeQueue({ policy: 'replay' });
    const patchA = patchChanging(dir, base, 'a.txt', 'A\n');
    const first = queue.enqueue({ patch: patchA, baseCommit: base });
    const mergedA = await queue.apply({ item: first.item, repoDir: dir, headCommit: base });
    assert.equal(mergedA.ok, true);
    const patchB = patchChanging(dir, base, 'b.txt', 'B\n');
    const second = queue.enqueue({ patch: patchB, baseCommit: base });
    const mergedB = await queue.apply({ item: second.item, repoDir: dir, headCommit: mergedA.headCommit });
    assert.equal(mergedB.ok, true, 'a disjoint patch applies onto the new head');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A\n');
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'B\n');
  });

  it('serialises the merge slot: one holder, renewal by nobody else, release frees it', () => {
    const queue = createMergeQueue({ slotTtlMs: 60_000 });
    assert.equal(queue.claim('machine-a').ok, true);
    assert.equal(queue.claim('machine-b').code, 'MERGE_SLOT_BUSY');
    assert.equal(queue.release('machine-b').code, 'MERGE_SLOT_NOT_OWNER');
    assert.equal(queue.release('machine-a').ok, true);
    assert.equal(queue.claim('machine-b').ok, true);
  });

  it('names the patch by sha256 so the queue can deduplicate', () => {
    const { dir, base } = makeRepo('sha');
    const patch = patchChanging(dir, base, 'a.txt', 'sha\n');
    assert.equal(patchSha(patch).length, 64);
    const queue = createMergeQueue();
    const enqueued = queue.enqueue({ patch, baseCommit: base });
    assert.equal(enqueued.item.patchSha, patchSha(patch));
  });
});
