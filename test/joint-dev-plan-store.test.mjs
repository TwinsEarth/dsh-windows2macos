/** joint-dev plan store: hash binding, traversal refusal, approval signature/TTL, dispatch gate. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import {
  approvePlan,
  assertDispatchAllowed,
  listPlans,
  loadApproval,
  loadPlan,
  planHashOf,
  savePlan,
} from '../src/plugin/joint-dev/plan-store.mjs';

const stateDir = () => mkdtempSync(join(tmpdir(), 'w2m-plan-'));
const build = () => buildPlan({
  base_commit: 'a'.repeat(40),
  steps: [
    { step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] },
    { step_id: 's2', machine_id: 'm-2', command_argv: ['node', '--test'] },
  ],
}).plan;
const planPath = (dir, sha) => join(dir, 'joint-dev', 'plans', sha + '.json');
const approvalPath = (dir, sha) => join(dir, 'joint-dev', 'approvals', sha + '.json');

describe('plan store: hash binding', () => {
  it('saves and reloads a plan whose hash still matches', () => {
    const dir = stateDir();
    const plan = build();
    const saved = savePlan({ stateDir: dir, plan });
    assert.equal(saved.ok, true, saved.code);
    const loaded = loadPlan({ stateDir: dir, planSha: plan.plan_sha256 });
    assert.equal(loaded.ok, true, loaded.code);
    assert.deepEqual(loaded.plan, plan);
  });

  it('refuses to save a plan whose declared hash does not match its body', () => {
    const plan = { ...build(), title: 'changed after hashing' };
    const result = savePlan({ stateDir: stateDir(), plan });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PLAN_HASH_MISMATCH');
  });

  it('detects a plan edited on disk while keeping its name', () => {
    const dir = stateDir();
    const plan = build();
    savePlan({ stateDir: dir, plan });
    const path = planPath(dir, plan.plan_sha256);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.plan.steps[0].command_hash = 'b'.repeat(64);
    writeFileSync(path, JSON.stringify(stored), 'utf8');
    const loaded = loadPlan({ stateDir: dir, planSha: plan.plan_sha256 });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, 'PLAN_TAMPERED');
  });

  it('refuses a path-traversal plan id', () => {
    const loaded = loadPlan({ stateDir: stateDir(), planSha: '../../etc/passwd' });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, 'PLAN_SHA_INVALID');
  });

  it('lists saved plans newest first', () => {
    const dir = stateDir();
    const plan = build();
    savePlan({ stateDir: dir, plan });
    const listed = listPlans({ stateDir: dir });
    assert.equal(listed.ok, true);
    assert.equal(listed.total, 1);
    assert.equal(listed.plans[0].plan_sha256, plan.plan_sha256);
  });

  it('planHashOf ignores only the hash field', () => {
    const plan = build();
    assert.equal(planHashOf(plan), plan.plan_sha256);
    assert.notEqual(planHashOf({ ...plan, title: 'x' }), plan.plan_sha256);
  });
});

describe('plan store: approval gate', () => {
  it('requires an approval before dispatch', () => {
    const dir = stateDir();
    const plan = build();
    savePlan({ stateDir: dir, plan });
    const gate = assertDispatchAllowed({ stateDir: dir, planSha: plan.plan_sha256 });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'APPROVAL_REQUIRED');
  });

  it('rejects a low authority approver', () => {
    const dir = stateDir();
    const plan = build();
    savePlan({ stateDir: dir, plan });
    const approved = approvePlan({ stateDir: dir, planSha: plan.plan_sha256, approver: 'op', authority: 50 });
    assert.equal(approved.ok, false);
    assert.equal(approved.code, 'APPROVAL_AUTHORITY_TOO_LOW');
  });

  it('allows dispatch after a valid approval and rejects expiry', () => {
    const dir = stateDir();
    const plan = build();
    savePlan({ stateDir: dir, plan });
    const now = Date.now();
    const approved = approvePlan({ stateDir: dir, planSha: plan.plan_sha256, approver: 'op', authority: 80, now, ttlMs: 60_000 });
    assert.equal(approved.ok, true, approved.code);
    assert.equal(assertDispatchAllowed({ stateDir: dir, planSha: plan.plan_sha256, now: now + 1_000 }).ok, true);
    const expired = assertDispatchAllowed({ stateDir: dir, planSha: plan.plan_sha256, now: now + 61_000 });
    assert.equal(expired.ok, false);
    assert.equal(expired.code, 'APPROVAL_EXPIRED');
  });

  it('detects an approval whose body was edited', () => {
    const dir = stateDir();
    const plan = build();
    savePlan({ stateDir: dir, plan });
    approvePlan({ stateDir: dir, planSha: plan.plan_sha256, approver: 'op', authority: 80 });
    const path = approvalPath(dir, plan.plan_sha256);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.authority = 99;
    writeFileSync(path, JSON.stringify(record), 'utf8');
    const loaded = loadApproval({ stateDir: dir, planSha: plan.plan_sha256 });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, 'APPROVAL_SIGNATURE_INVALID');
  });

  it('refuses dispatch when the plan is replaced but its old approval stays', () => {
    const dir = stateDir();
    const plan = build();
    savePlan({ stateDir: dir, plan });
    approvePlan({ stateDir: dir, planSha: plan.plan_sha256, approver: 'op', authority: 80 });
    const path = planPath(dir, plan.plan_sha256);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.plan.steps[0].machine_id = 'm-3';
    writeFileSync(path, JSON.stringify(stored), 'utf8');
    const gate = assertDispatchAllowed({ stateDir: dir, planSha: plan.plan_sha256 });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'PLAN_TAMPERED');
  });
});
