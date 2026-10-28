/**
 * A4/D4: merge CLI building blocks — signed merge approval bound to the four CAS inputs.
 *
 * The plan approval authorises sending work; this one authorises moving a branch. It binds the plan,
 * repo, base, target ref, the old value the CAS replaces and the exact integration head reviewed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const keyFile = join(mkdtempSync(join(tmpdir(), 'w2m-merge-key-')), 'operator-key.pem');
process.env.W2M_OPERATOR_KEY_FILE = keyFile;

import { advanceTarget, mergePatches } from '../src/plugin/joint-dev/merge-engine.mjs';
import { consumeMergeApproval, createMergeApproval, loadMergeApproval } from '../src/plugin/joint-dev/merge-approval.mjs';

const dirs = [];
after(() => { for (const dir of dirs) { try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* ignore */ } } });

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repoWithBase() {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-merge-repo-'));
  dirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'w2m@test.invalid']);
  git(dir, ['config', 'user.name', 'w2m test']);
  writeFileSync(join(dir, 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']);
  return { dir, base, targetRef: 'refs/heads/' + branch };
}

function makePatch(dir, base, file, content) {
  writeFileSync(join(dir, file), content, 'utf8');
  git(dir, ['add', '--intent-to-add', file]);
  const diff = git(dir, ['diff', '--', file]);
  git(dir, ['checkout', '--', '.']);
  return diff + '\n';
}

describe('merge approval', () => {
  it('signs, verifies the exact binding, expires, and consumes once', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-merge-state-'));
    const repo = mkdtempSync(join(tmpdir(), 'w2m-merge-repo-cmp-'));
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const binding = { stateDir, planSha: 'c'.repeat(64), repo, baseCommit: base, targetRef: 'refs/heads/main', expectedOld: base, integrationHead: head, approver: 'operator', authority: 80 };
    const created = createMergeApproval(binding);
    assert.equal(created.ok, true, created.code);
    const loaded = loadMergeApproval({ ...binding, approvalSha: created.approval_sha256 });
    assert.equal(loaded.ok, true, loaded.code);
    assert.equal(loaded.strength, 'signature');
    const wrongRepo = loadMergeApproval({ ...binding, repo: '/other/repo', approvalSha: created.approval_sha256 });
    assert.equal(wrongRepo.ok, false);
    assert.equal(wrongRepo.code, 'MERGE_APPROVAL_MISMATCH');
    assert.equal(consumeMergeApproval({ stateDir, approvalSha: created.approval_sha256 }).ok, true);
    assert.equal(consumeMergeApproval({ stateDir, approvalSha: created.approval_sha256 }).code, 'MERGE_APPROVAL_ALREADY_USED');
    const expired = createMergeApproval({ ...binding, ttlMs: 1000 });
    assert.equal(expired.ok, true);
    const late = loadMergeApproval({ ...binding, approvalSha: expired.approval_sha256, now: Date.now() + 60_000 });
    assert.equal(late.ok, false);
    assert.equal(late.code, 'MERGE_APPROVAL_EXPIRED');
  });

  it('merges two disjoint patches and refuses a conflicting pair', () => {
    const { dir, base, targetRef } = repoWithBase();
    const p1 = { step_id: 's1', machine_id: 'm-1', patch: makePatch(dir, base, 'a.txt', 'one\n') };
    const p2 = { step_id: 's2', machine_id: 'm-2', patch: makePatch(dir, base, 'b.txt', 'two\n') };
    const clean = mergePatches({ repoDir: dir, baseCommit: base, patches: [p1, p2] });
    assert.equal(clean.ok, true, JSON.stringify(clean));
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-merge-state-'));
    const approval = createMergeApproval({ stateDir, planSha: null, repo: dir, baseCommit: base, targetRef, expectedOld: base, integrationHead: clean.integration_head, approver: 'operator', authority: 80 });
    assert.equal(approval.ok, true, approval.code);
    const applied = advanceTarget({ repoDir: dir, targetRef, expectedOld: base, newCommit: clean.integration_head, rollbackRef: 'refs/w2m/rollback/test-' + Date.now() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const stale = advanceTarget({ repoDir: dir, targetRef, expectedOld: base, newCommit: clean.integration_head, rollbackRef: 'refs/w2m/rollback/stale-' + Date.now() });
    assert.equal(stale.ok, false);

    const conflicting = mergePatches({ repoDir: dir, baseCommit: base, patches: [
      { step_id: 's1', machine_id: 'm-1', patch: makePatch(dir, base, 'same.txt', 'left\n') },
      { step_id: 's2', machine_id: 'm-2', patch: makePatch(dir, base, 'same.txt', 'right\n') },
    ] });
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.code, 'MERGE_CONFLICT');
  });
});
