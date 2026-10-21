/**
 * The maintenance runner (v1.3.2-beta, M1).
 *
 * This is the only component that may execute a maintenance action. It is installed to run as root/SYSTEM by a path unit
 * (Linux) or a scheduled task (Windows); it reads request files from a queue directory that the unprivileged agent can
 * write to, verifies the operator signature, and writes a result file the agent can read back.
 *
 * Safety properties this file is responsible for:
 *   - nothing is executed before the signature, machine binding and time window are verified;
 *   - a request id is executed at most once (claimed via rename, and a persisted replay set);
 *   - a result file exists for every request the runner looked at, including refusals, so the agent never waits forever;
 *   - a corrupt request file fails that request, not the runner.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MaintenanceProtocolError, MAX_REQUEST_BYTES, verifyRequest } from './protocol.mjs';
import { OperatorKeyError } from './operator-key.mjs';

const STATE_USED_LIMIT = 500;

function loadState(stateFile) {
  if (!existsSync(stateFile)) return { protocol: 'w2m-maintenance-state/v1', used_request_ids: [], used_nonces: [] };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return {
      protocol: 'w2m-maintenance-state/v1',
      used_request_ids: Array.isArray(parsed.used_request_ids) ? parsed.used_request_ids : [],
      used_nonces: Array.isArray(parsed.used_nonces) ? parsed.used_nonces : [],
    };
  } catch {
    throw new MaintenanceProtocolError('STATE_CORRUPT', 'maintenance state file is unreadable; refusing to execute anything');
  }
}

function saveState(stateFile, state) {
  mkdirSync(join(stateFile, '..'), { recursive: true });
  const tmp = stateFile + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, stateFile);
}

function writeResult(doneDir, requestId, result) {
  mkdirSync(doneDir, { recursive: true });
  const target = join(doneDir, encodeURIComponent(requestId) + '.json');
  const tmp = target + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
}

/**
 * Process every request currently in the queue once. The runner is a one-shot: the path unit starts it again when new
 * files arrive, so there is no long-lived loop to keep correct.
 *
 * @param {object} options
 * @param {string} options.queueDir directory the agent writes requests to
 * @param {string} options.doneDir directory results are written to
 * @param {string} options.stateFile replay state (request ids + nonces already executed)
 * @param {string} options.claimedDir directory claimed requests are moved to while executing
 * @param {string} options.machineId this machine's id
 * @param {() => {pinned: {key_id: string, public_key_pem: string} | null, isRevoked: (keyId: string) => boolean}} options.pinStore
 * @param {(action: string, params: object, request: object) => Promise<{status: string, code?: string, detail?: object}>} options.executeAction
 * @param {() => number} options.now
 * @param {(level: string, message: string, detail?: object) => void} [options.log]
 */
export async function runOnce(options) {
  const {
    queueDir,
    doneDir,
    stateFile,
    claimedDir,
    machineId,
    pinStore,
    executeAction,
    now = () => Date.now(),
    log = () => {},
  } = options;
  mkdirSync(claimedDir, { recursive: true });
  const state = loadState(stateFile);
  const usedRequestIds = new Set(state.used_request_ids);
  const usedNonces = new Set(state.used_nonces);
  const processed = [];

  let entries;
  try {
    entries = readdirSync(queueDir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return { ok: true, processed };
  }

  for (const name of entries) {
    const source = join(queueDir, name);
    let request;
    let raw;
    try {
      raw = readFileSync(source);
    } catch {
      continue;
    }
    const claimPath = join(claimedDir, name);
    const finish = (result) => {
      writeResult(doneDir, result.request_id ?? name.replace(/\.json$/, ''), result);
      try { rmSync(claimPath, { force: true }); } catch { /* claimed file is best effort */ }
      try { rmSync(source, { force: true }); } catch { /* the request is already claimed */ }
      processed.push(result);
    };
    if (raw.byteLength > MAX_REQUEST_BYTES) {
      finish({ protocol: 'w2m-maintenance-result/v1', request_id: name, status: 'failed', code: 'MAINTENANCE_TOO_LARGE', machine_id: machineId, ended_at: new Date(now()).toISOString() });
      continue;
    }
    try {
      request = JSON.parse(raw.toString('utf8'));
    } catch {
      finish({ protocol: 'w2m-maintenance-result/v1', request_id: name, status: 'failed', code: 'MAINTENANCE_BAD_SHAPE', detail: { message: 'request is not valid JSON' }, machine_id: machineId, ended_at: new Date(now()).toISOString() });
      continue;
    }

    // Claim before any verification side effects: two runners must not both execute the same file.
    try {
      renameSync(source, claimPath);
    } catch {
      continue;
    }

    const alreadyDone = typeof request?.request_id === 'string' && existsSync(join(doneDir, encodeURIComponent(request.request_id) + '.json'));
    if (alreadyDone) {
      try { rmSync(claimPath, { force: true }); } catch { /* ignore */ }
      log('info', 'maintenance request already executed; returning the existing result', { request_id: request.request_id });
      continue;
    }

    let pins;
    try {
      pins = pinStore.load();
    } catch (error) {
      finish({ protocol: 'w2m-maintenance-result/v1', request_id: String(request?.request_id ?? name), status: 'failed', code: error instanceof OperatorKeyError ? error.code : 'PINS_CORRUPT', detail: { message: error?.message ?? 'pin store unreadable' }, machine_id: machineId, ended_at: new Date(now()).toISOString() });
      continue;
    }
    if (pins.pinned === null) {
      finish({ protocol: 'w2m-maintenance-result/v1', request_id: String(request?.request_id ?? name), status: 'failed', code: 'MAINTENANCE_NO_PINNED_KEY', detail: { message: 'no operator key is pinned yet; refusing every maintenance request' }, machine_id: machineId, ended_at: new Date(now()).toISOString() });
      continue;
    }

    const verified = verifyRequest(request, {
      publicKeyPem: pins.pinned.public_key_pem,
      expectedKeyId: pins.pinned.key_id,
      expectedMachineId: machineId,
      nowMs: now(),
      usedRequestIds,
      usedNonces,
      isRevoked: pins.isRevoked,
    });
    if (verified.ok !== true) {
      finish({ protocol: 'w2m-maintenance-result/v1', request_id: String(request?.request_id ?? name), action: request?.action ?? null, status: 'failed', code: verified.code, detail: verified.detail, machine_id: machineId, ended_at: new Date(now()).toISOString() });
      continue;
    }

    const startedAt = new Date(now()).toISOString();
    let outcome;
    try {
      outcome = await executeAction(request.action, request.params, request);
    } catch (error) {
      outcome = { status: 'failed', code: 'MAINTENANCE_ACTION_FAILED', detail: { message: error?.message ?? String(error) } };
    }
    const result = {
      protocol: 'w2m-maintenance-result/v1',
      request_id: request.request_id,
      action: request.action,
      status: outcome?.status === 'ok' ? 'ok' : 'failed',
      code: outcome?.status === 'ok' ? null : (outcome?.code ?? 'MAINTENANCE_ACTION_FAILED'),
      detail: outcome?.detail ?? null,
      machine_id: machineId,
      started_at: startedAt,
      ended_at: new Date(now()).toISOString(),
    };
    finish(result);
    state.used_request_ids.push(request.request_id);
    state.used_nonces.push(request.nonce);
    while (state.used_request_ids.length > STATE_USED_LIMIT) state.used_request_ids.shift();
    while (state.used_nonces.length > STATE_USED_LIMIT) state.used_nonces.shift();
    usedRequestIds.add(request.request_id);
    usedNonces.add(request.nonce);
    try { saveState(stateFile, state); } catch (error) {
      log('warn', 'maintenance state could not be persisted; a replay would not be detected', { error: error?.message });
    }
    log('info', 'maintenance request executed', { request_id: request.request_id, action: request.action, status: result.status });
  }

  return { ok: true, processed };
}
