/**
 * joint-dev 计划持久化与人工审批门（本地文件，0600）。
 *
 * 安全不变量（v2 预置）：
 *   · plan_sha256 必须由本模块重算，与文件内容不符即 PLAN_TAMPERED；
 *   · planSha 必须是 64 位小写十六进制，禁止路径穿越；
 *   · 审批绑定 plan_sha256 + approver + authority + 过期时间，approval_sha256 读回时重算；
 *   · 未审批的计划禁止 dispatch（assertDispatchAllowed 是唯一入口）。
 *
 * 审批只由操作员 CLI/UI 写入，不暴露为 agent 工具。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const PLAN_SHA = /^[0-9a-f]{64}$/;
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const planDir = (stateDir) => join(stateDir, 'joint-dev', 'plans');
const approvalDir = (stateDir) => join(stateDir, 'joint-dev', 'approvals');

/** Hash of the plan body WITHOUT plan_sha256 — the same rule buildPlan uses. */
export function planHashOf(plan) {
  if (plan === null || typeof plan !== 'object') return null;
  const { plan_sha256: _ignored, ...canonical } = plan;
  return sha256(JSON.stringify(canonical));
}

function readPlanFile(stateDir, planSha) {
  if (!PLAN_SHA.test(String(planSha ?? ''))) return { ok: false, code: 'PLAN_SHA_INVALID' };
  const path = join(planDir(stateDir), planSha + '.json');
  if (!existsSync(path)) return { ok: false, code: 'PLAN_NOT_FOUND' };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ok: false, code: 'PLAN_UNREADABLE' }; }
  const plan = parsed?.plan;
  if (plan === null || typeof plan !== 'object') return { ok: false, code: 'PLAN_INVALID' };
  const recomputed = planHashOf(plan);
  if (recomputed !== plan.plan_sha256 || recomputed !== planSha) {
    return { ok: false, code: 'PLAN_TAMPERED', detail: { declared: plan.plan_sha256, recomputed, path } };
  }
  return { ok: true, plan, path, saved_at: parsed.saved_at ?? null };
}

export function savePlan({ stateDir, plan, now = Date.now() }) {
  if (plan === null || typeof plan !== 'object' || !PLAN_SHA.test(String(plan.plan_sha256 ?? ''))) {
    return { ok: false, code: 'PLAN_INVALID' };
  }
  const recomputed = planHashOf(plan);
  if (recomputed !== plan.plan_sha256) {
    return { ok: false, code: 'PLAN_HASH_MISMATCH', detail: { declared: plan.plan_sha256, recomputed } };
  }
  mkdirSync(planDir(stateDir), { recursive: true });
  const path = join(planDir(stateDir), plan.plan_sha256 + '.json');
  if (existsSync(path)) return { ok: true, path, reused: true };
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify({ plan, saved_at: new Date(now).toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  // rename is atomic on the same volume; a crash leaves only the tmp file behind.
  renameSync(tmp, path);
  return { ok: true, path, reused: false };
}

export function loadPlan({ stateDir, planSha }) {
  const loaded = readPlanFile(stateDir, planSha);
  if (loaded.ok !== true) return loaded;
  return { ok: true, plan: loaded.plan, saved_at: loaded.saved_at, path: loaded.path };
}

export function listPlans({ stateDir, limit = 50 }) {
  const dir = planDir(stateDir);
  if (!existsSync(dir)) return { ok: true, plans: [], total: 0 };
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      entries.push({ plan_sha256: name.slice(0, -5), saved_at_ms: stat.mtimeMs });
    } catch { /* a vanished plan is simply absent */ }
  }
  entries.sort((a, b) => b.saved_at_ms - a.saved_at_ms);
  return { ok: true, plans: entries.slice(0, Math.max(1, Math.min(200, limit))), total: entries.length };
}

/**
 * 人工审批。authority 最低 70；TTL 默认 24h；过期/哈希不符/计划被替换时 dispatch 拒绝。
 */
export function approvePlan({ stateDir, planSha, approver, authority, note = '', now = Date.now(), ttlMs = DEFAULT_APPROVAL_TTL_MS }) {
  if (!PLAN_SHA.test(String(planSha ?? ''))) return { ok: false, code: 'PLAN_SHA_INVALID' };
  if (typeof approver !== 'string' || approver.trim() === '') return { ok: false, code: 'APPROVER_REQUIRED' };
  if (!Number.isInteger(authority) || authority < 70) return { ok: false, code: 'APPROVAL_AUTHORITY_TOO_LOW', detail: { authority } };
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 60 * 60 * 1000) {
    return { ok: false, code: 'APPROVAL_TTL_INVALID', detail: { ttlMs } };
  }
  const loaded = readPlanFile(stateDir, planSha);
  if (loaded.ok !== true) return loaded;
  mkdirSync(approvalDir(stateDir), { recursive: true });
  const body = {
    v: 2,
    plan_sha256: planSha,
    approver,
    authority,
    note: String(note).slice(0, 200),
    approved_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  const record = { ...body, approval_sha256: sha256(JSON.stringify(body)) };
  const path = join(approvalDir(stateDir), planSha + '.json');
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ok: true, approval: record, path };
}

export function loadApproval({ stateDir, planSha, now = Date.now() }) {
  if (!PLAN_SHA.test(String(planSha ?? ''))) return { ok: false, code: 'PLAN_SHA_INVALID' };
  const path = join(approvalDir(stateDir), planSha + '.json');
  if (!existsSync(path)) return { ok: false, code: 'APPROVAL_REQUIRED' };
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ok: false, code: 'APPROVAL_UNREADABLE' }; }
  if (record?.plan_sha256 !== planSha) return { ok: false, code: 'APPROVAL_STALE' };
  const { approval_sha256: declared, ...body } = record;
  if (sha256(JSON.stringify(body)) !== declared) return { ok: false, code: 'APPROVAL_SIGNATURE_INVALID' };
  if (!Number.isInteger(record.authority) || record.authority < 70) {
    return { ok: false, code: 'APPROVAL_AUTHORITY_TOO_LOW', detail: { authority: record.authority } };
  }
  const expires = Date.parse(record.expires_at ?? '');
  if (Number.isFinite(expires) && now > expires) return { ok: false, code: 'APPROVAL_EXPIRED', detail: { expires_at: record.expires_at } };
  return { ok: true, approval: record };
}

/** dispatch 前置门：计划必须存在、未被篡改，且已审批、未过期。 */
export function assertDispatchAllowed({ stateDir, planSha, now = Date.now() }) {
  const plan = loadPlan({ stateDir, planSha });
  if (plan.ok !== true) return { ok: false, code: plan.code ?? 'PLAN_NOT_FOUND' };
  const approval = loadApproval({ stateDir, planSha, now });
  if (approval.ok !== true) return { ok: false, code: approval.code ?? 'APPROVAL_REQUIRED' };
  return { ok: true, plan: plan.plan, approval: approval.approval };
}
