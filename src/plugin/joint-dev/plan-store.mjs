/**
 * joint-dev 计划持久化与人工审批门（本地文件，0600）。
 * 未审批的计划禁止 dispatch；审批绑定 plan_sha256 与候选人。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const planDir = (stateDir) => join(stateDir, 'joint-dev', 'plans');
const approvalDir = (stateDir) => join(stateDir, 'joint-dev', 'approvals');

export function savePlan({ stateDir, plan, now = Date.now() }) {
  if (typeof plan?.plan_sha256 !== 'string' || plan.plan_sha256.length !== 64) return { ok: false, code: 'PLAN_INVALID' };
  mkdirSync(planDir(stateDir), { recursive: true });
  const path = join(planDir(stateDir), plan.plan_sha256 + '.json');
  if (existsSync(path)) return { ok: true, path, reused: true };
  writeFileSync(path, JSON.stringify({ plan, saved_at: new Date(now).toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, path, reused: false };
}

export function loadPlan({ stateDir, planSha }) {
  const path = join(planDir(stateDir), planSha + '.json');
  if (!existsSync(path)) return { ok: false, code: 'PLAN_NOT_FOUND' };
  return { ok: true, ...JSON.parse(readFileSync(path, 'utf8')), path };
}

/**
 * 人工审批。authority 建议 ≥70；审批只由操作员 CLI/UI 写入，不暴露给 agent 工具。
 */
export function approvePlan({ stateDir, planSha, approver, authority, note = '', now = Date.now() }) {
  if (typeof planSha !== 'string' || planSha.length !== 64) return { ok: false, code: 'PLAN_SHA_INVALID' };
  if (typeof approver !== 'string' || approver === '') return { ok: false, code: 'APPROVER_REQUIRED' };
  if (!Number.isInteger(authority) || authority < 70) return { ok: false, code: 'APPROVAL_AUTHORITY_TOO_LOW', detail: { authority } };
  if (!existsSync(join(planDir(stateDir), planSha + '.json'))) return { ok: false, code: 'PLAN_NOT_FOUND' };
  mkdirSync(approvalDir(stateDir), { recursive: true });
  const body = {
    v: 1,
    plan_sha256: planSha,
    approver,
    authority,
    note: String(note).slice(0, 200),
    approved_at: new Date(now).toISOString(),
  };
  const record = { ...body, approval_sha256: sha256(JSON.stringify(body)) };
  const path = join(approvalDir(stateDir), planSha + '.json');
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, approval: record, path };
}

export function loadApproval({ stateDir, planSha }) {
  const path = join(approvalDir(stateDir), planSha + '.json');
  if (!existsSync(path)) return { ok: false, code: 'APPROVAL_REQUIRED' };
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.plan_sha256 !== planSha) return { ok: false, code: 'APPROVAL_STALE' };
  return { ok: true, approval: record };
}

/** dispatch 前置门：计划必须存在且已审批。 */
export function assertDispatchAllowed({ stateDir, planSha }) {
  const plan = loadPlan({ stateDir, planSha });
  if (plan.ok !== true) return { ok: false, code: 'PLAN_NOT_FOUND' };
  const approval = loadApproval({ stateDir, planSha });
  if (approval.ok !== true) return { ok: false, code: 'APPROVAL_REQUIRED' };
  return { ok: true, plan: plan.plan, approval: approval.approval };
}
