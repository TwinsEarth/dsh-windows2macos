/**
 * Joint-dev relay dispatch (v2 S2).
 *
 * Turns an approved plan into relay tasks:
 *   · steps are dispatched in dependency order; a step's `depends_on` is mapped to the task ids of
 *     the steps it waits for, so the relay's own dependency gate keeps them from running together;
 *   · task ids are deterministic (`jd-<sha256(plan|step)>`), so retrying a dispatch does not create
 *     a second task — a relay `TASK_EXISTS` answer is reported as "already dispatched";
 *   · every control envelope is checked by `inspectControlMessage` (16 KiB, field whitelist, no
 *     data-plane bytes) and the attempt/outcome is written to the local audit file;
 *   · capabilities are negotiated first (an older relay is refused), and the leases the relay
 *     returns are checked: a lease on a machine that was not pinned cancels the task and fails.
 */
import { createHash } from 'node:crypto';

import { appendAudit } from './audit-file.mjs';
import { inspectControlMessage } from './redline.mjs';
import { readRelayCapabilities, negotiateFeatures } from '../relay-capabilities.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const trimBase = (value) => (typeof value === 'string' ? value.replace(/\/+$/, '') : '');
const taskIdOf = (planSha, stepId) => 'jd-' + sha256(planSha + '|' + stepId).slice(0, 26);

/** Kahn order over the plan's dependency graph; unknown dependencies are a refusal, not a guess. */
function orderSteps(steps) {
  const byId = new Map(steps.map((step) => [step.step_id, step]));
  for (const step of steps) {
    for (const dep of step.depends_on ?? []) {
      if (!byId.has(dep)) return { ok: false, code: 'PLAN_DEPENDENCY_UNKNOWN', detail: { step_id: step.step_id, depends_on: dep } };
    }
  }
  const placed = new Set();
  const ordered = [];
  let remaining = steps.slice();
  while (remaining.length > 0) {
    const ready = remaining.filter((step) => (step.depends_on ?? []).every((dep) => placed.has(dep)));
    if (ready.length === 0) return { ok: false, code: 'PLAN_DEPENDENCY_CYCLE' };
    for (const step of ready) { ordered.push(step); placed.add(step.step_id); }
    remaining = remaining.filter((step) => !placed.has(step.step_id));
  }
  return { ok: true, steps: ordered };
}

function writeAudit(file, event) {
  if (typeof file !== 'string' || file === '') return;
  try { appendAudit(file, event); } catch { /* an audit write must not change the dispatch outcome */ }
}

/**
 * @param {{rabbitUrl: string, token: string, plan: object, approval: object, fetchImpl?: Function,
 *          timeoutMs?: number, includeOffline?: boolean, auditFile?: string}} input
 */
export async function dispatchPlanToRelay(input) {
  const rabbitUrl = trimBase(input?.rabbitUrl);
  const token = typeof input?.token === 'string' ? input.token : '';
  const plan = input?.plan ?? null;
  const approval = input?.approval ?? null;
  if (rabbitUrl === '') return { ok: false, code: 'RELAY_URL_REQUIRED' };
  if (token === '') return { ok: false, code: 'OPERATOR_TOKEN_MISSING' };
  if (plan === null || typeof plan.plan_sha256 !== 'string') return { ok: false, code: 'PLAN_INVALID' };
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return { ok: false, code: 'PLAN_INVALID' };
  if (approval === null || typeof approval.approval_sha256 !== 'string') return { ok: false, code: 'APPROVAL_REQUIRED' };
  for (const step of plan.steps) {
    if (typeof step?.step_id !== 'string' || step.step_id === '' || typeof step?.machine_id !== 'string' || step.machine_id === '' || !Array.isArray(step?.command_argv) || step.command_argv.length === 0) {
      return { ok: false, code: 'PLAN_STEP_INVALID', detail: { step_id: step?.step_id ?? null } };
    }
  }
  const ordered = orderSteps(plan.steps);
  if (ordered.ok !== true) return { ok: false, code: ordered.code, detail: ordered.detail ?? null };

  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isInteger(input?.timeoutMs) ? input.timeoutMs : 60_000;
  const signalOf = () => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' };
  const auditFile = typeof input?.auditFile === 'string' ? input.auditFile : '';

  // R3: when a device token is supplied, every target machine must advertise the same plugin version.
  if (typeof input?.deviceToken === 'string' && input.deviceToken !== '') {
    const expected = typeof input?.expectedVersion === 'string' ? input.expectedVersion : null;
    if (expected !== null) {
      let fleet;
      try {
        const response = await fetchImpl(`${rabbitUrl}/v1/devices`, { headers: { authorization: `Bearer ${input.deviceToken}`, accept: 'application/json' }, signal: signalOf() });
        fleet = response.ok === true ? await response.json() : null;
      } catch { fleet = null; }
      if (fleet === null || !Array.isArray(fleet.devices)) return { ok: false, code: 'VERSION_UNVERIFIABLE', detail: { reason: 'the relay device list could not be read' } };
      const byId = new Map(fleet.devices.map((device) => [device.machine_id, device]));
      const skew = ordered.steps
        .map((step) => ({ machine_id: step.machine_id, version: byId.get(step.machine_id)?.caps?.plugin_version ?? null }))
        .filter((row) => row.version !== expected);
      if (skew.length > 0) return { ok: false, code: 'VERSION_SKEW', detail: { expected, machines: skew } };
    }
  }

  const capabilities = await readRelayCapabilities({ rabbitUrl, fetchImpl, timeoutMs });
  const negotiation = negotiateFeatures(capabilities);
  if (negotiation.ok !== true) {
    return { ok: false, code: negotiation.code ?? 'RELAY_CAPABILITIES_MISSING', detail: { missing: negotiation.missing ?? null, relay: rabbitUrl } };
  }

  const dispatched = new Map(); // step_id -> task_id
  const tasks = [];
  for (const step of ordered.steps) {
    const taskId = taskIdOf(plan.plan_sha256, step.step_id);
    const dependsOn = (step.depends_on ?? []).map((dep) => dispatched.get(dep)).filter((id) => typeof id === 'string');
    const body = {
      task_id: taskId,
      mode: 'broadcast',
      executor_machine_id: step.machine_id,
      command_argv: step.command_argv,
      command_hash: step.command_hash,
      base_commit: plan.base_commit,
      plan_sha256: plan.plan_sha256,
      approval_sha256: approval.approval_sha256,
      step_id: step.step_id,
      ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
      ...(Array.isArray(step.write_scope) && step.write_scope.length > 0 ? { write: true, write_scope: step.write_scope } : {}),
      ...(step.timeout_ms === undefined ? {} : { timeout_ms: step.timeout_ms }),
      ...(input?.includeOffline === false ? {} : { include_offline: true }),
    };
    const check = inspectControlMessage({ v: 1, type: 'joint.dispatch', body });
    if (check.ok !== true) {
      writeAudit(auditFile, { event: 'joint.dispatch.refused', plan_sha256: plan.plan_sha256, step_id: step.step_id, reason_code: check.code ?? 'CONTROL_REFUSED' });
      return { ok: false, code: check.code ?? 'CONTROL_REFUSED', detail: check.detail ?? null, partial: tasks.length > 0, tasks };
    }
    let response;
    try {
      response = await fetchImpl(`${rabbitUrl}/v1/task`, { method: 'POST', headers, body: JSON.stringify(body), signal: signalOf() });
    } catch (error) {
      writeAudit(auditFile, { event: 'joint.dispatch.failed', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: taskId, reason_code: 'RELAY_UNREACHABLE' });
      return { ok: false, code: 'RELAY_UNREACHABLE', detail: error instanceof Error ? error.message : String(error), partial: tasks.length > 0, tasks };
    }
    const doc = await response.json().catch(() => null);
    if (response.status === 409 && doc?.error?.code === 'TASK_EXISTS') {
      writeAudit(auditFile, { event: 'joint.dispatch.already', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: taskId });
      dispatched.set(step.step_id, taskId);
      tasks.push({ step_id: step.step_id, task_id: taskId, already: true, leases: [] });
      continue;
    }
    if (response.ok !== true) {
      writeAudit(auditFile, { event: 'joint.dispatch.refused', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: taskId, reason_code: doc?.error?.code ?? 'RELAY_REFUSED' });
      return { ok: false, code: doc?.error?.code ?? 'RELAY_REFUSED', status: response.status, detail: doc?.error ?? doc, partial: tasks.length > 0, tasks };
    }
    const returnedTaskId = doc?.task_id ?? doc?.task?.task_id ?? taskId;
    const leases = Array.isArray(doc?.leases) ? doc.leases : [];
    const foreign = leases.filter((lease) => lease?.state !== 'observing' && lease?.machine_id !== step.machine_id);
    if (foreign.length > 0) {
      try {
        await fetchImpl(`${rabbitUrl}/v1/tasks/${encodeURIComponent(returnedTaskId)}/cancel`, {
          method: 'POST', headers, body: JSON.stringify({ reason: 'SELECTION_NOT_HONOURED' }), signal: signalOf(),
        });
      } catch { /* the refusal below is still the answer */ }
      writeAudit(auditFile, { event: 'joint.dispatch.not_honoured', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: returnedTaskId });
      return {
        ok: false,
        code: 'SELECTION_NOT_HONOURED',
        detail: { step_id: step.step_id, named: step.machine_id, leased: foreign.map((lease) => lease.machine_id), task_id: returnedTaskId },
        partial: tasks.length > 0,
        tasks,
      };
    }
    writeAudit(auditFile, { event: 'joint.dispatch.sent', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: returnedTaskId, machine_id: step.machine_id });
    dispatched.set(step.step_id, returnedTaskId);
    tasks.push({
      step_id: step.step_id,
      task_id: returnedTaskId,
      leases: leases.map((lease) => ({ machine_id: lease?.machine_id ?? null, state: lease?.state ?? null })),
    });
  }
  return { ok: true, relay_version: capabilities.relay_version ?? null, features: capabilities.features ?? null, tasks };
}
