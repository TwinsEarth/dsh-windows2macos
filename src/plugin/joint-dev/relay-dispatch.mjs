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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  // No audit file requested (library callers): nothing to write, and that is not a failure.
  if (typeof file !== 'string' || file === '') return { ok: true, skipped: true };
  try {
    return appendAudit(file, event);
  } catch (error) {
    return { ok: false, code: 'AUDIT_WRITE_FAILED', detail: error instanceof Error ? error.message : String(error) };
  }
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

  // D2 (B5): the version gate is observable and defaults to warn. It becomes a refusal only when the
  // caller explicitly asks for enforce; a mixed-version fleet is reported, not silently assumed clean.
  const versionGate = input?.versionGate === 'off' || input?.versionGate === 'enforce' ? input.versionGate : 'warn';
  const warnings = [];
  const expectedVersion = typeof input?.expectedVersion === 'string' && input.expectedVersion !== '' ? input.expectedVersion : null;
  if (expectedVersion !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
    return { ok: false, code: 'VERSION_UNPARSED', detail: { expected: expectedVersion } };
  }
  if (versionGate !== 'off' && expectedVersion !== null) {
    const deviceToken = typeof input?.deviceToken === 'string' && input.deviceToken !== '' ? input.deviceToken : '';
    let fleet = null;
    if (deviceToken !== '') {
      try {
        const response = await fetchImpl(`${rabbitUrl}/v1/devices`, { headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' }, signal: signalOf() });
        fleet = response.ok === true ? await response.json() : null;
      } catch { fleet = null; }
    }
    if (fleet === null || !Array.isArray(fleet.devices)) {
      if (versionGate === 'enforce') return { ok: false, code: 'VERSION_UNVERIFIABLE', detail: { reason: 'the relay device list could not be read', expected: expectedVersion } };
      warnings.push({ code: 'VERSION_UNVERIFIABLE', detail: 'the relay device list could not be read' });
    } else {
      const byId = new Map(fleet.devices.map((device) => [device.machine_id, device]));
      const skew = ordered.steps
        .map((step) => ({ machine_id: step.machine_id, version: byId.get(step.machine_id)?.caps?.plugin_version ?? null }))
        .filter((row) => row.version !== expectedVersion);
      if (skew.length > 0) {
        if (versionGate === 'enforce') return { ok: false, code: 'VERSION_SKEW', detail: { expected: expectedVersion, machines: skew } };
        warnings.push({ code: 'VERSION_SKEW', detail: { expected: expectedVersion, machines: skew } });
      }
    }
  }

  const capabilities = await readRelayCapabilities({ rabbitUrl, fetchImpl, timeoutMs });
  if (capabilities.ok !== true) return { ok: false, code: 'RELAY_CAPABILITIES_UNAVAILABLE', detail: { relay: rabbitUrl, error: capabilities.error ?? null } };
  const negotiation = negotiateFeatures(capabilities);
  if (negotiation.ok !== true) {
    return { ok: false, code: negotiation.code ?? 'RELAY_CAPABILITIES_MISSING', detail: { missing: negotiation.missing ?? null, relay: rabbitUrl } };
  }
  if (capabilities.signing_required !== false) {
    return { ok: false, code: capabilities.signing_required === true ? 'RELAY_SIGNING_REQUIRED' : 'SIGNING_UNVERIFIABLE', detail: { relay: rabbitUrl, signing_required: capabilities.signing_required } };
  }
  if (capabilities.operator_token_required !== true) return { ok: false, code: capabilities.operator_token_required === false ? 'RELAY_OPERATOR_TOKEN_NOT_REQUIRED' : 'OPERATOR_TOKEN_UNVERIFIED', detail: { relay: rabbitUrl, relay_version: capabilities.relay_version ?? null } };

  const dispatched = new Map(); // step_id -> task_id
  const tasks = [];
  const dispatchDir = typeof input?.dispatchDir === 'string' && input.dispatchDir !== '' ? input.dispatchDir : null;
  for (const step of ordered.steps) {
    const taskId = taskIdOf(plan.plan_sha256, step.step_id);
    const dependsOn = (step.depends_on ?? []).map((dep) => dispatched.get(dep)).filter((id) => typeof id === 'string');
    const body = {
      task_id: taskId,
      mode: 'broadcast',
      target_machines: [step.machine_id],
      executor_machine_id: step.machine_id,
      command_argv: step.command_argv,
      command_hash: step.command_hash,
      cwd_rel: typeof step.cwd_rel === 'string' && step.cwd_rel !== '' ? step.cwd_rel : '.',
      base_commit: plan.base_commit,
      plan_sha256: plan.plan_sha256,
      approval_sha256: approval.approval_sha256,
      step_id: step.step_id,
      ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
      ...(Array.isArray(step.write_scope) && step.write_scope.length > 0 ? { write: true, write_scope: step.write_scope } : {}),
      ...(step.timeout_ms === undefined ? {} : { timeout_ms: step.timeout_ms }),
      ...(input?.includeOffline === true ? { include_offline: true } : {}),
    };
    const check = inspectControlMessage({ v: 1, type: 'joint.dispatch', body });
    if (check.ok !== true) {
      writeAudit(auditFile, { event: 'joint.dispatch.refused', plan_sha256: plan.plan_sha256, step_id: step.step_id, reason_code: check.code ?? 'CONTROL_REFUSED' });
      return { ok: false, code: check.code ?? 'CONTROL_REFUSED', detail: check.detail ?? null, partial: tasks.length > 0, tasks };
    }
    const controlText = JSON.stringify(body);
    const audited = writeAudit(auditFile, { event: 'joint.dispatch.sending', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: taskId, machine_id: step.machine_id, control_bytes: Buffer.byteLength(controlText), control_sha256: sha256(controlText) });
    if (audited.ok !== true) return { ok: false, code: 'AUDIT_UNAVAILABLE', detail: audited, partial: tasks.length > 0, tasks };
    let response;
    try {
      response = await fetchImpl(`${rabbitUrl}/v1/task`, { method: 'POST', headers, body: controlText, signal: signalOf() });
    } catch (error) {
      writeAudit(auditFile, { event: 'joint.dispatch.failed', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: taskId, reason_code: 'RELAY_UNREACHABLE' });
      return { ok: false, code: 'RELAY_UNREACHABLE', detail: error instanceof Error ? error.message : String(error), partial: tasks.length > 0, tasks };
    }
    const doc = await response.json().catch(() => null);
    if (response.status === 409 && doc?.error?.code === 'TASK_EXISTS') {
      // API v1.2 §5.2: a 409 is not success. Read the existing task back and require it to exist.
      let existing = null;
      try {
        const read = await fetchImpl(`${rabbitUrl}/v1/tasks/${encodeURIComponent(taskId)}`, { headers, signal: signalOf() });
        existing = read.ok === true ? await read.json() : null;
      } catch { existing = null; }
      if (existing === null) return { ok: false, code: 'TASK_EXISTS_UNVERIFIED', detail: { step_id: step.step_id, task_id: taskId }, partial: tasks.length > 0, tasks };
      const existingLeases = Array.isArray(existing?.leases) ? existing.leases : [];
      const mine = existingLeases.filter((lease) => lease?.machine_id === step.machine_id);
      if (existingLeases.length > 0 && mine.length === 0) return { ok: false, code: 'TASK_EXISTS_FOREIGN', detail: { step_id: step.step_id, task_id: taskId }, partial: tasks.length > 0, tasks };
      writeAudit(auditFile, { event: 'joint.dispatch.already', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: taskId });
      dispatched.set(step.step_id, taskId);
      tasks.push({ step_id: step.step_id, task_id: taskId, already: true, leases: mine.map((lease) => ({ machine_id: lease.machine_id ?? null, state: lease.state ?? null })) });
      continue;
    }
    if (response.ok !== true) {
      writeAudit(auditFile, { event: 'joint.dispatch.refused', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: taskId, reason_code: doc?.error?.code ?? 'RELAY_REFUSED' });
      return { ok: false, code: doc?.error?.code ?? 'RELAY_REFUSED', status: response.status, detail: doc?.error ?? doc, partial: tasks.length > 0, tasks };
    }
    if (typeof doc?.task_id !== 'string' || doc.task_id === '') {
      writeAudit(auditFile, { event: 'joint.dispatch.refused', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: taskId, reason_code: doc?.refusal_reason ?? 'RELAY_REFUSED' });
      return { ok: false, code: 'RELAY_REFUSED', status: response.status, detail: { refusal_reason: doc?.refusal_reason ?? null, refused_task_id: null }, partial: tasks.length > 0, tasks };
    }
    const returnedTaskId = doc.task_id;
    const leases = Array.isArray(doc?.leases) ? doc.leases : [];
    const foreign = leases.filter((lease) => lease?.state !== 'observing' && lease?.machine_id !== step.machine_id);
    const mine = leases.filter((lease) => lease?.machine_id === step.machine_id);
    const dead = mine.filter((lease) => ['refused', 'expired', 'cancelled'].includes(lease?.state));
    if (dead.length > 0) {
      writeAudit(auditFile, { event: 'joint.dispatch.dead_lease', plan_sha256: plan.plan_sha256, step_id: step.step_id, task_id: returnedTaskId });
      return { ok: false, code: 'DISPATCH_TARGET_REFUSED', detail: { step_id: step.step_id, machine_id: step.machine_id, leases: leases.map((lease) => ({ machine_id: lease?.machine_id ?? null, state: lease?.state ?? null })) }, partial: tasks.length > 0, tasks };
    }
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
  if (dispatchDir !== null) {
    try {
      mkdirSync(dispatchDir, { recursive: true, mode: 0o700 });
      const file = join(dispatchDir, plan.plan_sha256 + '.json');
      writeFileSync(file, JSON.stringify({ v: 1, plan_sha256: plan.plan_sha256, approval_sha256: approval.approval_sha256, dispatched_at: new Date().toISOString(), tasks: tasks.map((task) => ({ step_id: task.step_id, task_id: task.task_id, machine_id: task.leases?.[0]?.machine_id ?? null, already: task.already === true })) }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { /* the progress view is best effort; dispatch itself already happened */ }
  }
  return { ok: true, relay_version: capabilities.relay_version ?? null, features: capabilities.features ?? null, version_gate: versionGate, ...(warnings.length > 0 ? { warnings } : {}), tasks };
}
