/**
 * 联合开发：计划 → 控制面信封 → 分发（R1–R4 的生产接线点）。
 *
 * 只构造"任务指令 + 元数据"：任务 ID、机器、步骤、命令 hash、base commit、写范围。
 * 任何用户代码/文件/输出字节都不允许出现在这里；发送前逐条过 redline.inspectControlMessage，
 * 失败即拒绝并写审计（只记元数据）。本模块不做网络 I/O，sendFn 由调用方注入。
 */
import { createHash } from 'node:crypto';

import { computeCommandHash, normalizeCwdRel, SHELL_ID_DIRECT } from '../../relay/state.mjs';

import { appendAudit } from './audit-file.mjs';
import { createAudit, inspectControlMessage } from './redline.mjs';

export const MAX_STEPS = 16;
const DATA_KEYS = new Set(['data', 'file', 'files', 'content', 'patch', 'diff', 'blob', 'bytes', 'stdout', 'stderr', 'base64', 'text']);

const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

function scanData(value, path, hits) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((entry, index) => scanData(entry, path + '[' + index + ']', hits)); return; }
  for (const [key, child] of Object.entries(value)) {
    const keyPath = path === '' ? key : path + '.' + key;
    if (DATA_KEYS.has(key.toLowerCase())) hits.push(keyPath);
    scanData(child, keyPath, hits);
  }
}

/**
 * 校验计划：步骤唯一、依赖存在、无环、无数据字段、机器 ID 合法。
 * @returns {{ok: true, plan: object} | {ok: false, code: string, detail: object}}
 */
export function buildPlan(input) {
  if (input === null || typeof input !== 'object') return { ok: false, code: 'PLAN_INVALID', detail: {} };
  const steps = Array.isArray(input.steps) ? input.steps : null;
  if (steps === null || steps.length === 0 || steps.length > MAX_STEPS) {
    return { ok: false, code: 'PLAN_STEPS_INVALID', detail: { count: steps === null ? null : steps.length } };
  }
  const hits = [];
  scanData(input, '', hits);
  if (hits.length > 0) return { ok: false, code: 'DATA_PLANE_FORBIDDEN', detail: { paths: hits.slice(0, 8) } };

  const ids = new Set();
  for (const step of steps) {
    if (typeof step?.step_id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(step.step_id)) {
      return { ok: false, code: 'PLAN_STEP_ID_INVALID', detail: { step_id: step?.step_id ?? null } };
    }
    if (ids.has(step.step_id)) return { ok: false, code: 'PLAN_STEP_DUPLICATE', detail: { step_id: step.step_id } };
    ids.add(step.step_id);
    if (typeof step.machine_id !== 'string' || step.machine_id === '') {
      return { ok: false, code: 'PLAN_MACHINE_INVALID', detail: { step_id: step.step_id } };
    }
    if (!Array.isArray(step.command_argv) || step.command_argv.length === 0) {
      return { ok: false, code: 'PLAN_ARGV_INVALID', detail: { step_id: step.step_id } };
    }
  }
  const graph = new Map(steps.map((step) => [step.step_id, Array.isArray(step.depends_on) ? step.depends_on : []]));
  for (const [id, deps] of graph) {
    for (const dep of deps) {
      if (!ids.has(dep)) return { ok: false, code: 'PLAN_DEP_UNKNOWN', detail: { step_id: id, dep } };
    }
  }
  const visiting = new Set();
  const done = new Set();
  const visit = (id) => {
    if (done.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) if (!visit(dep)) return false;
    visiting.delete(id);
    done.add(id);
    return true;
  };
  for (const id of ids) if (!visit(id)) return { ok: false, code: 'PLAN_CYCLE', detail: { step_id: id } };

  const canonical = {
    v: 1,
    title: typeof input.title === 'string' ? input.title.slice(0, 200) : '',
    base_commit: typeof input.base_commit === 'string' ? input.base_commit : null,
    steps: steps.map((step) => ({
      step_id: step.step_id,
      machine_id: step.machine_id,
      command_argv: step.command_argv.slice(0, 32),
      cwd_rel: normalizeCwdRel(step.cwd_rel),
      command_hash: computeCommandHash(step.command_argv, SHELL_ID_DIRECT, normalizeCwdRel(step.cwd_rel)),
      write_scope: Array.isArray(step.write_scope) ? step.write_scope.slice(0, 8) : [],
      depends_on: Array.isArray(step.depends_on) ? step.depends_on.slice(0, 8) : [],
      timeout_ms: Number.isInteger(step.timeout_ms) ? step.timeout_ms : null,
    })),
  };
  return { ok: true, plan: { ...canonical, plan_sha256: sha256(JSON.stringify(canonical)) } };
}

/** 计划 → 控制面信封（每个步骤一条 joint.dispatch，只含元数据）。 */
export function buildControlEnvelopes(plan) {
  return plan.steps.map((step) => ({
    v: 1,
    type: 'joint.dispatch',
    body: {
      plan_sha256: plan.plan_sha256,
      step_id: step.step_id,
      machine_id: step.machine_id,
      base_commit: plan.base_commit,
      command_argv: step.command_argv,
      command_hash: step.command_hash,
      cwd_rel: step.cwd_rel ?? '.',
      write_scope: step.write_scope,
      depends_on: step.depends_on,
      ...(step.timeout_ms === null ? {} : { timeout_ms: step.timeout_ms }),
    },
  }));
}

/**
 * 分发：逐条过红线 → 审计 → sendFn。失败即停，返回已完成与失败原因。
 * @param {{plan: object, sendFn: Function, dryRun?: boolean, audit?: object}} input
 */
export async function dispatchPlan({ plan, sendFn, dryRun = false, audit = null, auditFile = null }) {
  if (plan === null || typeof plan !== 'object' || typeof plan.plan_sha256 !== 'string') {
    return { ok: false, code: 'PLAN_NOT_BUILT', sent: [], audits: [] };
  }
  const auditLog = audit ?? createAudit();
  const envelopes = buildControlEnvelopes(plan);
  const sent = [];
  const audits = [];
  for (const envelope of envelopes) {
    const check = inspectControlMessage(envelope);
    const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (check.ok !== true) {
      const record = { event: 'joint.dispatch.refused', plan_sha256: plan.plan_sha256, step_id: envelope.body.step_id, machine_id: envelope.body.machine_id, outcome: 'denied', reason_code: check.code, control_bytes: bytes, control_sha256: sha256(JSON.stringify(envelope)) };
      auditLog.append(record);
      audits.push(record);
      return { ok: false, code: check.code, detail: check.detail, sent, audits };
    }
    if (dryRun) { sent.push({ step_id: envelope.body.step_id, bytes, dispatched: false }); continue; }
    if (typeof auditFile === 'string') {
      let written;
      try { written = appendAudit(auditFile, { event: 'joint.dispatch.sending', plan_sha256: plan.plan_sha256, step_id: envelope.body.step_id, machine_id: envelope.body.machine_id, control_bytes: bytes, control_sha256: sha256(JSON.stringify(envelope)) }); } catch (error) { written = { ok: false, detail: String(error) }; }
      if (written.ok !== true) return { ok: false, code: 'AUDIT_UNAVAILABLE', detail: written, sent, audits };
    }
    let response;
    try {
      response = await sendFn(envelope, { stepId: envelope.body.step_id, machineId: envelope.body.machine_id, bytes });
    } catch (error) {
      const record = { event: 'joint.dispatch.failed', plan_sha256: plan.plan_sha256, step_id: envelope.body.step_id, machine_id: envelope.body.machine_id, outcome: 'error', reason_code: 'SEND_FAILED', control_bytes: bytes, control_sha256: sha256(JSON.stringify(envelope)) };
      auditLog.append(record);
      audits.push(record);
      return { ok: false, code: 'SEND_FAILED', detail: { step_id: envelope.body.step_id, error: String(error).slice(0, 120) }, sent, audits };
    }
    const record = { event: 'joint.dispatch.sent', plan_sha256: plan.plan_sha256, step_id: envelope.body.step_id, machine_id: envelope.body.machine_id, outcome: response?.ok === true ? 'ok' : 'rejected', reason_code: response?.code ?? null, control_bytes: bytes, control_sha256: sha256(JSON.stringify(envelope)) };
    auditLog.append(record);
    audits.push(record);
    sent.push({ step_id: envelope.body.step_id, bytes, dispatched: true });
    if (response?.ok !== true) return { ok: false, code: response?.code ?? 'DISPATCH_REJECTED', detail: { step_id: envelope.body.step_id }, sent, audits };
  }
  return { ok: true, sent, audits, auditHead: auditLog.head(), dryRun };
}
