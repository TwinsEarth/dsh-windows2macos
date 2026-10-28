/**
 * joint-dev 计划持久化与人工审批门（本地文件，0600）。
 *
 * 安全不变量（v2）：
 *   · plan_sha256 必须由本模块重算，与文件内容不符即 PLAN_TAMPERED；
 *   · planSha 必须是 64 位小写十六进制，禁止路径穿越；
 *   · 审批绑定 plan_sha256 + approver + authority(70..100) + 有效期（60s..10min）；
 *   · 审批由 operator Ed25519 私钥签名；签名覆盖除 sig/approval_sha256/operator_key 外的记录体，
 *     key_id 必须等于公钥指纹（防换公钥），可选 trustedOperatorKeyIds 做信任锚；
 *   · 审批写入原子（tmp→rename），dispatch 前置门可强制要求签名；
 *   · consumeApproval 用 O_EXCL 保证"一次审批只能派发一次"。
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { keyIdOf, verifyApprovalPayload } from '../operator-key.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const PLAN_SHA = /^[0-9a-f]{64}$/;
const APPROVAL_TTL_MIN_MS = 60_000;
const APPROVAL_TTL_MAX_MS = 10 * 60 * 1000;

const planDir = (stateDir) => join(stateDir, 'joint-dev', 'plans');
const approvalDir = (stateDir) => join(stateDir, 'joint-dev', 'approvals');
const consumedDir = (stateDir) => join(stateDir, 'joint-dev', 'consumed');

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

function writeFileAtomic(path, text) {
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
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
  writeFileAtomic(path, JSON.stringify({ plan, saved_at: new Date(now).toISOString() }, null, 2));
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
    const sha = name.slice(0, -5);
    if (!PLAN_SHA.test(sha)) continue;
    try {
      entries.push({ plan_sha256: sha, saved_at_ms: statSync(join(dir, name)).mtimeMs });
    } catch { /* absent */ }
  }
  entries.sort((a, b) => b.saved_at_ms - a.saved_at_ms);
  return { ok: true, plans: entries.slice(0, Math.max(1, Math.min(200, limit))), total: entries.length };
}

/**
 * 人工审批。authority 70..100；TTL 60s..10min（决策 2）；传入 signer 时审批带 Ed25519 签名。
 * signer 只被调用一次：签名覆盖最终要落盘的 body（不含 operator_key / sig / approval_sha256）。
 *
 * @param {{stateDir: string, planSha: string, approver: string, authority: number, note?: string, now?: number, ttlMs?: number,
 *          signer?: (body: object) => {sig: string, key_id: string, public_key_pem: string}}} input
 */
export function approvePlan(input) {
  const { stateDir, planSha, approver, authority, note = '', now = Date.now(), ttlMs = APPROVAL_TTL_MAX_MS, signer } = input;
  if (!PLAN_SHA.test(String(planSha ?? ''))) return { ok: false, code: 'PLAN_SHA_INVALID' };
  if (typeof approver !== 'string' || approver.trim() === '') return { ok: false, code: 'APPROVER_REQUIRED' };
  if (!Number.isInteger(authority) || authority < 70 || authority > 100) {
    return { ok: false, code: 'APPROVAL_AUTHORITY_INVALID', detail: { authority } };
  }
  if (!Number.isInteger(ttlMs) || ttlMs < APPROVAL_TTL_MIN_MS || ttlMs > APPROVAL_TTL_MAX_MS) {
    return { ok: false, code: 'APPROVAL_TTL_INVALID', detail: { ttlMs } };
  }
  const loaded = readPlanFile(stateDir, planSha);
  if (loaded.ok !== true) return loaded;
  mkdirSync(approvalDir(stateDir), { recursive: true });

  const base = {
    v: 2,
    plan_sha256: planSha,
    approver,
    authority,
    note: String(note).slice(0, 200),
    approved_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  let record = base;
  if (typeof signer === 'function') {
    const material = signer({ ...base });
    if (typeof material?.sig !== 'string' || material.sig === '' || typeof material?.public_key_pem !== 'string') {
      return { ok: false, code: 'APPROVAL_SIGN_FAILED' };
    }
    const keyId = String(material.key_id ?? '');
    if (keyId === '' || keyId !== keyIdOf(material.public_key_pem)) {
      return { ok: false, code: 'APPROVAL_KEY_MISMATCH' };
    }
    record = { ...base, operator_key: { key_id: keyId, public_key_pem: material.public_key_pem }, sig: material.sig };
  }
  const stored = { ...record, approval_sha256: sha256(JSON.stringify(record)) };
  const path = join(approvalDir(stateDir), planSha + '.json');
  writeFileAtomic(path, JSON.stringify(stored, null, 2));
  return { ok: true, approval: stored, path, signed: typeof record.sig === 'string' };
}

/**
 * @param {{stateDir: string, planSha: string, now?: number, trustedOperatorKeyIds?: string[]}} input
 */
export function loadApproval(input) {
  const { stateDir, planSha, now = Date.now(), trustedOperatorKeyIds } = input;
  if (!PLAN_SHA.test(String(planSha ?? ''))) return { ok: false, code: 'PLAN_SHA_INVALID' };
  const path = join(approvalDir(stateDir), planSha + '.json');
  if (!existsSync(path)) return { ok: false, code: 'APPROVAL_REQUIRED' };
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ok: false, code: 'APPROVAL_UNREADABLE' }; }
  if (record?.plan_sha256 !== planSha) return { ok: false, code: 'APPROVAL_STALE' };
  const { approval_sha256: declared, ...body } = record;
  if (sha256(JSON.stringify(body)) !== declared) return { ok: false, code: 'APPROVAL_SIGNATURE_INVALID' };
  if (!Number.isInteger(record.authority) || record.authority < 70 || record.authority > 100) {
    return { ok: false, code: 'APPROVAL_AUTHORITY_INVALID', detail: { authority: record.authority } };
  }
  const approved = Date.parse(record.approved_at ?? '');
  const expires = Date.parse(record.expires_at ?? '');
  if (!Number.isFinite(approved) || !Number.isFinite(expires)) return { ok: false, code: 'APPROVAL_EXPIRY_INVALID' };
  if (expires - approved < APPROVAL_TTL_MIN_MS || expires - approved > APPROVAL_TTL_MAX_MS) {
    return { ok: false, code: 'APPROVAL_TTL_INVALID' };
  }
  if (now > expires) return { ok: false, code: 'APPROVAL_EXPIRED', detail: { expires_at: record.expires_at } };
  let strength = 'digest';
  if (typeof record.sig === 'string') {
    const pem = record?.operator_key?.public_key_pem;
    const keyId = record?.operator_key?.key_id;
    if (typeof pem !== 'string' || pem === '' || typeof keyId !== 'string' || keyId === '') {
      return { ok: false, code: 'APPROVAL_SIGNATURE_INVALID' };
    }
    if (keyId !== keyIdOf(pem)) return { ok: false, code: 'APPROVAL_KEY_MISMATCH' };
    if (Array.isArray(trustedOperatorKeyIds) && !trustedOperatorKeyIds.includes(keyId)) {
      return { ok: false, code: 'APPROVAL_KEY_UNTRUSTED', detail: { key_id: keyId } };
    }
    if (verifyApprovalPayload(record, record.sig, pem) !== true) {
      return { ok: false, code: 'APPROVAL_SIGNATURE_INVALID' };
    }
    strength = 'signature';
  }
  return { ok: true, approval: record, strength };
}

/**
 * 一次性消费：O_EXCL 写 consumed/<approval_sha>.json；第二次调用返回 APPROVAL_ALREADY_USED。
 */
export function consumeApproval({ stateDir, planSha, approvalSha, now = Date.now() }) {
  if (!PLAN_SHA.test(String(planSha ?? '')) || !PLAN_SHA.test(String(approvalSha ?? ''))) {
    return { ok: false, code: 'APPROVAL_SHA_INVALID' };
  }
  mkdirSync(consumedDir(stateDir), { recursive: true });
  const path = join(consumedDir(stateDir), approvalSha + '.json');
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify({ plan_sha256: planSha, approval_sha256: approvalSha, consumed_at: new Date(now).toISOString() }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return { ok: true, path };
  } catch (error) {
    if (error?.code === 'EEXIST') return { ok: false, code: 'APPROVAL_ALREADY_USED', detail: { path } };
    return { ok: false, code: 'APPROVAL_CONSUME_FAILED', detail: error instanceof Error ? error.message : String(error) };
  }
}

/** dispatch 前置门：计划存在未篡改、审批有效且未过期；requireSignature 时必须是签名审批。 */
export function assertDispatchAllowed(input) {
  const { stateDir, planSha, now = Date.now(), requireSignature = false, trustedOperatorKeyIds } = input;
  const plan = loadPlan({ stateDir, planSha });
  if (plan.ok !== true) return { ok: false, code: plan.code ?? 'PLAN_NOT_FOUND' };
  const approval = loadApproval({ stateDir, planSha, now, trustedOperatorKeyIds });
  if (approval.ok !== true) return { ok: false, code: approval.code ?? 'APPROVAL_REQUIRED' };
  if (requireSignature === true && approval.strength !== 'signature') {
    return { ok: false, code: 'APPROVAL_SIGNATURE_REQUIRED' };
  }
  return { ok: true, plan: plan.plan, approval: approval.approval, strength: approval.strength };
}
