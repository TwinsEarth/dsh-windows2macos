/**
 * Joint-dev relay dispatch (v2 S2).
 *
 * Turns an approved plan into relay tasks: one step = one broadcast task pinned to the step's
 * machine via `executor_machine_id`. Capabilities are negotiated first (an older relay that cannot
 * honour the pin is refused, never assumed), and the leases the relay returns are checked: a lease
 * on any machine other than the pinned one cancels the task and fails the dispatch.
 *
 * Only the control plane is written here: plan digest, step id, command hash and the argv the
 * executor needs. Nothing is uploaded; artifacts are the separate sink path (S4).
 */
import { readRelayCapabilities, negotiateFeatures } from '../relay-capabilities.mjs';

const trimBase = (value) => (typeof value === 'string' ? value.replace(/\/+$/, '') : '');

/**
 * @param {{rabbitUrl: string, token: string, plan: object, approval: object, fetchImpl?: Function, timeoutMs?: number, includeOffline?: boolean}} input
 */
export async function dispatchPlanToRelay(input) {
  const rabbitUrl = trimBase(input?.rabbitUrl);
  const token = typeof input?.token === 'string' ? input.token : '';
  const plan = input?.plan ?? null;
  const approval = input?.approval ?? null;
  if (rabbitUrl === '') return { ok: false, code: 'RELAY_URL_REQUIRED' };
  if (token === '') return { ok: false, code: 'OPERATOR_TOKEN_MISSING' };
  if (plan === null || typeof plan.plan_sha256 !== 'string') return { ok: false, code: 'PLAN_INVALID' };
  if (approval === null || typeof approval.approval_sha256 !== 'string') return { ok: false, code: 'APPROVAL_REQUIRED' };

  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isInteger(input?.timeoutMs) ? input.timeoutMs : 60_000;
  const signalOf = () => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' };

  const capabilities = await readRelayCapabilities({ rabbitUrl, fetchImpl, timeoutMs });
  const negotiation = negotiateFeatures(capabilities);
  if (negotiation.ok !== true) {
    return { ok: false, code: negotiation.code ?? 'RELAY_CAPABILITIES_MISSING', detail: { missing: negotiation.missing ?? null, relay: rabbitUrl } };
  }

  const tasks = [];
  for (const step of plan.steps) {
    const body = {
      mode: 'broadcast',
      executor_machine_id: step.machine_id,
      command_argv: step.command_argv,
      command_hash: step.command_hash,
      base_commit: plan.base_commit,
      plan_sha256: plan.plan_sha256,
      approval_sha256: approval.approval_sha256,
      step_id: step.step_id,
      ...(step.timeout_ms === undefined ? {} : { timeout_ms: step.timeout_ms }),
      ...(input?.includeOffline === false ? {} : { include_offline: true }),
    };
    let response;
    try {
      response = await fetchImpl(`${rabbitUrl}/v1/task`, { method: 'POST', headers, body: JSON.stringify(body), signal: signalOf() });
    } catch (error) {
      return { ok: false, code: 'RELAY_UNREACHABLE', detail: error instanceof Error ? error.message : String(error) };
    }
    const doc = await response.json().catch(() => null);
    if (response.ok !== true) {
      return { ok: false, code: doc?.error?.code ?? 'RELAY_REFUSED', status: response.status, detail: doc?.error ?? doc };
    }
    const taskId = doc?.task_id ?? doc?.task?.task_id ?? null;
    const leases = Array.isArray(doc?.leases) ? doc.leases : [];
    const foreign = leases.filter((lease) => lease?.state !== 'observing' && lease?.machine_id !== step.machine_id);
    if (foreign.length > 0) {
      if (taskId !== null) {
        try {
          await fetchImpl(`${rabbitUrl}/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
            method: 'POST', headers, body: JSON.stringify({ reason: 'SELECTION_NOT_HONOURED' }), signal: signalOf(),
          });
        } catch { /* the refusal below is still the answer */ }
      }
      return {
        ok: false,
        code: 'SELECTION_NOT_HONOURED',
        detail: { step_id: step.step_id, named: step.machine_id, leased: foreign.map((lease) => lease.machine_id), task_id: taskId },
        tasks,
      };
    }
    tasks.push({
      step_id: step.step_id,
      task_id: taskId,
      leases: leases.map((lease) => ({ machine_id: lease?.machine_id ?? null, state: lease?.state ?? null })),
    });
  }
  return { ok: true, relay_version: capabilities.relay_version ?? null, features: capabilities.features ?? null, tasks };
}
