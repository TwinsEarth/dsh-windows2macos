/**
 * Merge approval (A4/D4): the second human signature in the joint-dev SOP.
 *
 * A plan approval authorises *sending work*; a merge approval authorises *moving a branch*. It binds
 * the plan, repository, base commit, target ref, the old value the CAS will replace, and the exact
 * integration head that was reviewed. Signed with the same operator Ed25519 key, TTL-capped, and
 * consumed once (O_EXCL) so a replay cannot move a second branch.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureOperatorKey, keyIdOf, signApprovalPayload, verifyApprovalPayload } from '../operator-key.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export function bodyOf(input) {
  const approvedAtIn = typeof input.approvedAt === 'string' ? input.approvedAt : (typeof input.approved_at === 'string' ? input.approved_at : null);
  const expiresAtIn = typeof input.expiresAt === 'string' ? input.expiresAt : (typeof input.expires_at === 'string' ? input.expires_at : null);
  const now = Number.isInteger(input.now) ? input.now : (approvedAtIn !== null ? Date.parse(approvedAtIn) : Date.now());
  const approvedAt = approvedAtIn !== null ? approvedAtIn : new Date(now).toISOString();
  const expiresAt = expiresAtIn !== null ? expiresAtIn : new Date(now + (Number.isInteger(input.ttlMs) ? input.ttlMs : 600_000)).toISOString();
  return {
    v: 1,
    type: 'joint.merge',
    plan_sha256: typeof input.planSha === 'string' && input.planSha !== '' ? input.planSha : (typeof input.plan_sha256 === 'string' && input.plan_sha256 !== '' ? input.plan_sha256 : null),
    repo: String(input.repo ?? ''),
    base_commit: String(input.baseCommit ?? input.base_commit ?? ''),
    target_ref: String(input.targetRef ?? input.target_ref ?? ''),
    expected_old: String(input.expectedOld ?? input.expected_old ?? ''),
    integration_head: String(input.integrationHead ?? input.integration_head ?? ''),
    approver: String(input.approver ?? ''),
    authority: Number.isInteger(input.authority) ? input.authority : 0,
    approved_at: approvedAt,
    expires_at: expiresAt,
  };
}

/**
 * @param {{stateDir: string, planSha?: string|null, repo: string, baseCommit: string, targetRef: string,
 *          expectedOld: string, integrationHead: string, approver: string, authority: number,
 *          ttlMs?: number, now?: number, key?: {privateKey: string, publicKeyPem: string, key_id: string}}} input
 */
export function createMergeApproval(input) {
  if (!SHA.test(String(input.baseCommit ?? ''))) return { ok: false, code: 'MERGE_APPROVAL_BASE_INVALID' };
  if (!SHA.test(String(input.expectedOld ?? ''))) return { ok: false, code: 'MERGE_APPROVAL_OLD_INVALID' };
  if (!SHA.test(String(input.integrationHead ?? ''))) return { ok: false, code: 'MERGE_APPROVAL_HEAD_INVALID' };
  if (!Number.isInteger(input.authority) || input.authority < 70 || input.authority > 100) return { ok: false, code: 'MERGE_APPROVAL_AUTHORITY_INVALID' };
  const key = input.key ?? ensureOperatorKey();
  if (key === null || key === undefined || key.ok !== true || key.privateKey === undefined) return { ok: false, code: key?.code ?? 'OPERATOR_KEY_MISSING' };
  const body = bodyOf(input);
  const approvalSha = sha256(JSON.stringify(body));
  const record = {
    ...body,
    approval_sha256: approvalSha,
    operator_key: { key_id: key.key_id ?? keyIdOf(key.publicKeyPem), public_key_pem: key.publicKeyPem },
    sig: signApprovalPayload(body, key.privateKey),
  };
  const dir = join(input.stateDir, 'joint-dev', 'merge-approvals');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, approvalSha + '.json');
  const tmp = path + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* Windows ACL */ }
  return { ok: true, approval: record, approval_sha256: approvalSha, path };
}

/**
 * Verify signature, TTL and the exact binding the caller is about to apply.
 *
 * @param {{stateDir: string, approvalSha: string, trustedOperatorKeyIds?: string[], now?: number,
 *          repo: string, baseCommit: string, targetRef: string, expectedOld: string, integrationHead: string,
 *          planSha?: string|null}} input
 */
export function loadMergeApproval(input) {
  if (typeof input?.approvalSha !== 'string' || !HEX64.test(input.approvalSha)) return { ok: false, code: 'MERGE_APPROVAL_ID_INVALID' };
  const path = join(input.stateDir, 'joint-dev', 'merge-approvals', input.approvalSha + '.json');
  if (!existsSync(path)) return { ok: false, code: 'MERGE_APPROVAL_NOT_FOUND' };
  let record = null;
  try { record = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } catch { return { ok: false, code: 'MERGE_APPROVAL_UNREADABLE' }; }
  if (record?.type !== 'joint.merge') return { ok: false, code: 'MERGE_APPROVAL_TYPE_INVALID' };
  if (record.approval_sha256 !== sha256(JSON.stringify(bodyOf(record)))) return { ok: false, code: 'MERGE_APPROVAL_TAMPERED' };
  const pem = record?.operator_key?.public_key_pem;
  if (typeof pem !== 'string' || record?.operator_key?.key_id !== keyIdOf(pem)) return { ok: false, code: 'MERGE_APPROVAL_KEY_MISMATCH' };
  const trusted = Array.isArray(input.trustedOperatorKeyIds) ? input.trustedOperatorKeyIds : null;
  if (trusted !== null && !trusted.includes(record.operator_key.key_id)) return { ok: false, code: 'MERGE_APPROVAL_KEY_UNTRUSTED' };
  if (verifyApprovalPayload(record, record.sig, pem) !== true) return { ok: false, code: 'MERGE_APPROVAL_SIGNATURE_INVALID' };
  const now = Number.isInteger(input.now) ? input.now : Date.now();
  if (Date.parse(record.expires_at) <= now) return { ok: false, code: 'MERGE_APPROVAL_EXPIRED' };
  for (const [field, expected] of [['repo', input.repo], ['base_commit', input.baseCommit], ['target_ref', input.targetRef], ['expected_old', input.expectedOld], ['integration_head', input.integrationHead]]) {
    if (record[field] !== expected) return { ok: false, code: 'MERGE_APPROVAL_MISMATCH', detail: { field, expected, actual: record[field] } };
  }
  if (input.planSha !== undefined && input.planSha !== null && record.plan_sha256 !== input.planSha) {
    return { ok: false, code: 'MERGE_APPROVAL_MISMATCH', detail: { field: 'plan_sha256', expected: input.planSha, actual: record.plan_sha256 } };
  }
  return { ok: true, approval: record, strength: 'signature' };
}

/** One-shot consumption: the marker is created with O_EXCL, so a second apply cannot reuse the signature. */
export function consumeMergeApproval({ stateDir, approvalSha }) {
  if (typeof approvalSha !== 'string' || !HEX64.test(approvalSha)) return { ok: false, code: 'MERGE_APPROVAL_ID_INVALID' };
  const dir = join(stateDir, 'joint-dev', 'merge-consumed');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, approvalSha);
  try {
    writeFileSync(marker, new Date().toISOString() + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { ok: true };
  } catch (error) {
    if (error?.code === 'EEXIST') return { ok: false, code: 'MERGE_APPROVAL_ALREADY_USED' };
    return { ok: false, code: 'MERGE_APPROVAL_CONSUME_FAILED', detail: error instanceof Error ? error.message : String(error) };
  }
}
