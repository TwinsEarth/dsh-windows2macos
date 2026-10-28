/**
 * A5 progress consumer: read the relay's per-task progress for a dispatched joint plan.
 *
 * The relay stores no argv/content on the projection either, and this module enforces the same on
 * the way out: the projection is rebuilt from a small allow-list, and any forbidden key found in the
 * relay's answer is stripped and reported (never echoed). A relay that predates the `progress` key
 * (1.9.16) yields PROGRESS_UNSUPPORTED instead of an empty success.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = /^(?:argv|command|command_argv|command_hash|text|content|stdout|stderr|stdout_head|stderr_head|head|tail|patch|diff|env|token|secret|password|base64|blob|blobs|bytes|buffer|files?)$/i;

function sanitize(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.test(key)) continue;
    if (typeof child === 'string' && /(?:[A-Za-z0-9+/]{512,}|[0-9a-fA-F]{512,})/.test(child)) continue;
    out[key] = sanitize(child, seen);
  }
  return out;
}

const hasForbidden = (value, seen = new Set()) => {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasForbidden(entry, seen));
  return Object.entries(value).some(([key, child]) => FORBIDDEN.test(key) || hasForbidden(child, seen));
};

function readDispatchRecord(stateDir, planSha) {
  if (typeof stateDir !== 'string' || stateDir === '' || typeof planSha !== 'string' || !/^[0-9a-f]{64}$/.test(planSha)) return { ok: false, code: 'NOT_DISPATCHED' };
  const path = join(stateDir, 'joint-dev', 'dispatches', planSha + '.json');
  if (!existsSync(path)) return { ok: false, code: 'NOT_DISPATCHED' };
  try {
    const record = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (record?.plan_sha256 !== planSha || !Array.isArray(record.tasks)) return { ok: false, code: 'DISPATCH_RECORD_INVALID' };
    return { ok: true, record };
  } catch {
    return { ok: false, code: 'DISPATCH_RECORD_UNREADABLE' };
  }
}

/**
 * @param {{stateDir: string, planSha: string, relayUrl: string, deviceToken: string,
 *          fetchImpl?: Function, timeoutMs?: number, taskIds?: Map<string,string>}} input
 */
export async function planProgress(input) {
  const record = readDispatchRecord(input?.stateDir, input?.planSha);
  if (record.ok !== true) return { ok: false, code: record.code };
  const fetchImpl = typeof input?.fetchImpl === 'function' ? input.fetchImpl : globalThis.fetch;
  const timeoutMs = Number.isInteger(input?.timeoutMs) ? input.timeoutMs : 15_000;
  const base = typeof input?.relayUrl === 'string' ? input.relayUrl.replace(/\/$/, '') : '';
  if (base === '') return { ok: false, code: 'RELAY_URL_REQUIRED' };
  const token = typeof input?.deviceToken === 'string' ? input.deviceToken : '';
  if (token === '') return { ok: false, code: 'DEVICE_TOKEN_REQUIRED' };
  const steps = [];
  for (const task of record.record.tasks) {
    const taskId = String(task?.task_id ?? '');
    const stepId = String(task?.step_id ?? '');
    if (taskId === '') continue;
    let response = null;
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
      response = await fetchImpl(base + '/v1/tasks/' + encodeURIComponent(taskId), { headers: { authorization: 'Bearer ' + token, accept: 'application/json' }, signal });
    } catch {
      steps.push({ step_id: stepId, task_id: taskId, state: 'unreadable', code: 'TASK_UNREADABLE' });
      continue;
    }
    if (response.ok !== true) {
      steps.push({ step_id: stepId, task_id: taskId, state: 'unavailable', code: response.status === 404 ? 'TASK_NOT_FOUND' : 'TASK_UNREADABLE', http_status: response.status });
      continue;
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (body === null || typeof body !== 'object') {
      steps.push({ step_id: stepId, task_id: taskId, state: 'unavailable', code: 'TASK_UNREADABLE' });
      continue;
    }
    const progress = body.progress ?? body.task?.progress ?? null;
    const row = {
      step_id: stepId,
      task_id: taskId,
      status: body.task?.status ?? body.status ?? null,
      progress: progress === null ? null : sanitize(progress),
      leases: Array.isArray(body.leases) ? body.leases.map((lease) => ({ machine_id: lease?.machine_id ?? null, state: lease?.state ?? null })) : [],
    };
    if (progress === null) { row.progress_state = 'unavailable'; row.code = 'PROGRESS_UNSUPPORTED'; }
    if (hasForbidden(body)) row.leak_fields_stripped = true;
    steps.push(row);
  }
  const unavailable = steps.filter((step) => step.progress_state === 'unavailable').length;
  return {
    ok: true,
    plan_sha256: record.record.plan_sha256,
    approval_sha256: record.record.approval_sha256 ?? null,
    dispatched_at: record.record.dispatched_at ?? null,
    progress_state: steps.length > 0 && unavailable === steps.length ? 'unavailable' : 'partial',
    code: steps.length > 0 && unavailable === steps.length ? 'PROGRESS_UNSUPPORTED' : null,
    steps,
  };
}
