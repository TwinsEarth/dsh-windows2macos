/** Decisions 1 & 2: approvals carry an Ed25519 signature from the local operator key. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ensureOperatorKey,
  keyIdOf,
  loadOperatorKey,
  signApprovalPayload,
  verifyApprovalPayload,
} from '../src/plugin/operator-key.mjs';
import { buildPlan } from '../src/plugin/joint-dev/dispatch.mjs';
import {
  approvePlan,
  assertDispatchAllowed,
  loadApproval,
  savePlan,
} from '../src/plugin/joint-dev/plan-store.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'w2m-opkey-'));
const signerFor = (key) => (body) => ({ sig: signApprovalPayload(body, key.privateKey), key_id: key.key_id, public_key_pem: key.publicKeyPem });
const newPlan = () => buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;

describe('operator ed25519 key', () => {
  it('creates a key once and keeps the same id', () => {
    const path = join(dir(), 'operator-key.pem');
    const first = ensureOperatorKey({ path });
    assert.equal(first.ok, true, first.code);
    assert.equal(first.created, true);
    const again = ensureOperatorKey({ path });
    assert.equal(again.ok, true);
    assert.equal(again.created, false);
    assert.equal(again.key_id, first.key_id);
    assert.equal(keyIdOf(again.publicKeyPem), first.key_id);
    assert.match(first.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.equal(readFileSync(path, 'utf8').includes('PRIVATE KEY'), true);
  });

  it('signs and verifies a payload, and rejects a tampered one', () => {
    const key = loadOperatorKey({ path: ensureOperatorKey({ path: join(dir(), 'k.pem') }).path });
    assert.equal(key.ok, true);
    const body = { v: 2, plan_sha256: 'a'.repeat(64), approver: 'op', authority: 80 };
    const sig = signApprovalPayload(body, key.privateKey);
    assert.equal(verifyApprovalPayload(body, sig, key.publicKeyPem), true);
    assert.equal(verifyApprovalPayload({ ...body, authority: 99 }, sig, key.publicKeyPem), false);
  });

  it('rejects a signature made by another key', () => {
    const a = loadOperatorKey({ path: ensureOperatorKey({ path: join(dir(), 'a.pem') }).path });
    const b = loadOperatorKey({ path: ensureOperatorKey({ path: join(dir(), 'b.pem') }).path });
    const body = { v: 2, plan_sha256: 'b'.repeat(64) };
    assert.equal(verifyApprovalPayload(body, signApprovalPayload(body, a.privateKey), b.publicKeyPem), false);
  });
});

describe('signed plan approval', () => {
  it('records a signature and reports signature strength', () => {
    const stateDir = dir();
    const plan = newPlan();
    savePlan({ stateDir, plan });
    const key = ensureOperatorKey({ path: join(dir(), 'k.pem') });
    const approved = approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80, now: Date.now(), ttlMs: 600_000, signer: signerFor(key) });
    assert.equal(approved.ok, true, approved.code);
    assert.equal(approved.signed, true);
    const loaded = loadApproval({ stateDir, planSha: plan.plan_sha256 });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.strength, 'signature');
    assert.equal(assertDispatchAllowed({ stateDir, planSha: plan.plan_sha256, requireSignature: true }).ok, true);
  });

  it('refuses an unsigned approval when a signature is required', () => {
    const stateDir = dir();
    const plan = newPlan();
    savePlan({ stateDir, plan });
    const approved = approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80, now: Date.now(), ttlMs: 600_000 });
    assert.equal(approved.ok, true);
    const gate = assertDispatchAllowed({ stateDir, planSha: plan.plan_sha256, requireSignature: true });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'APPROVAL_SIGNATURE_REQUIRED');
  });

  it('detects a signature flipped on disk', () => {
    const stateDir = dir();
    const plan = newPlan();
    savePlan({ stateDir, plan });
    const key = ensureOperatorKey({ path: join(dir(), 'k.pem') });
    approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80, now: Date.now(), ttlMs: 600_000, signer: signerFor(key) });
    const path = join(stateDir, 'joint-dev', 'approvals', plan.plan_sha256 + '.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    // Flip one byte of the signature AND re-hash the body, so only the Ed25519 check can catch it.
    const bytes = Buffer.from(record.sig, 'base64');
    bytes[0] ^= 0xff;
    record.sig = bytes.toString('base64');
    const { approval_sha256: _ignored, ...rest } = record;
    record.approval_sha256 = createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
    writeFileSync(path, JSON.stringify(record), 'utf8');
    const loaded = loadApproval({ stateDir, planSha: plan.plan_sha256 });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, 'APPROVAL_SIGNATURE_INVALID');
  });
});


describe('approval trust anchor and one-shot consumption', () => {
  it('refuses an approval signed by a key outside the trusted set', async () => {
    const { ensureOperatorKey, keyIdOf } = await import('../src/plugin/operator-key.mjs');
    const { approvePlan, loadApproval, savePlan } = await import('../src/plugin/joint-dev/plan-store.mjs');
    const { buildPlan } = await import('../src/plugin/joint-dev/dispatch.mjs');
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-trust-'));
    const plan = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;
    savePlan({ stateDir, plan });
    const signerKey = ensureOperatorKey({ path: join(dir(), 'signer.pem') });
    const otherKey = ensureOperatorKey({ path: join(dir(), 'other.pem') });
    const approved = approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80, signer: signerFor(signerKey) });
    assert.equal(approved.ok, true, approved.code);
    const refused = loadApproval({ stateDir, planSha: plan.plan_sha256, trustedOperatorKeyIds: [otherKey.key_id] });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'APPROVAL_KEY_UNTRUSTED');
    const accepted = loadApproval({ stateDir, planSha: plan.plan_sha256, trustedOperatorKeyIds: [keyIdOf(signerKey.publicKeyPem)] });
    assert.equal(accepted.ok, true, accepted.code);
  });

  it('refuses an approval whose expiry fields were removed', async () => {
    const { createHash } = await import('node:crypto');
    const { approvePlan, loadApproval, savePlan } = await import('../src/plugin/joint-dev/plan-store.mjs');
    const { buildPlan } = await import('../src/plugin/joint-dev/dispatch.mjs');
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-expiry-'));
    const plan = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;
    savePlan({ stateDir, plan });
    approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80 });
    const path = join(stateDir, 'joint-dev', 'approvals', plan.plan_sha256 + '.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    delete record.expires_at;
    const { approval_sha256: _ignored, ...rest } = record;
    record.approval_sha256 = createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
    writeFileSync(path, JSON.stringify(record), 'utf8');
    const loaded = loadApproval({ stateDir, planSha: plan.plan_sha256 });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, 'APPROVAL_EXPIRY_INVALID');
  });

  it('refuses a TTL longer than ten minutes and an authority above 100', async () => {
    const { approvePlan, savePlan } = await import('../src/plugin/joint-dev/plan-store.mjs');
    const { buildPlan } = await import('../src/plugin/joint-dev/dispatch.mjs');
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-ttl-'));
    const plan = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;
    savePlan({ stateDir, plan });
    const tooLong = approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80, ttlMs: 11 * 60 * 1000 });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.code, 'APPROVAL_TTL_INVALID');
    const tooHigh = approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 999 });
    assert.equal(tooHigh.ok, false);
    assert.equal(tooHigh.code, 'APPROVAL_AUTHORITY_INVALID');
  });

  it('consumes an approval exactly once', async () => {
    const { approvePlan, consumeApproval, savePlan } = await import('../src/plugin/joint-dev/plan-store.mjs');
    const { buildPlan } = await import('../src/plugin/joint-dev/dispatch.mjs');
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-consume-'));
    const plan = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;
    savePlan({ stateDir, plan });
    const approved = approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80 });
    const sha = approved.approval.approval_sha256;
    assert.equal(consumeApproval({ stateDir, planSha: plan.plan_sha256, approvalSha: sha }).ok, true);
    const second = consumeApproval({ stateDir, planSha: plan.plan_sha256, approvalSha: sha });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'APPROVAL_ALREADY_USED');
  });

  it('refuses a signer that returns no signature and writes nothing', async () => {
    const { approvePlan, savePlan } = await import('../src/plugin/joint-dev/plan-store.mjs');
    const { buildPlan } = await import('../src/plugin/joint-dev/dispatch.mjs');
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-badsig-'));
    const plan = buildPlan({ base_commit: 'a'.repeat(40), steps: [{ step_id: 's1', machine_id: 'm-1', command_argv: ['node', '-v'] }] }).plan;
    savePlan({ stateDir, plan });
    const result = approvePlan({ stateDir, planSha: plan.plan_sha256, approver: 'op', authority: 80, signer: () => ({}) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'APPROVAL_SIGN_FAILED');
    assert.equal(existsSync(join(stateDir, 'joint-dev', 'approvals', plan.plan_sha256 + '.json')), false);
  });
});
