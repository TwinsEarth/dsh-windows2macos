/**
 * Agent-side maintenance ferry (v1.3.10-beta.2, M1).
 *
 * The agent is not privileged enough to run update/restart/diag, and it should not be: it carries the signed request to the
 * queue the root runner watches, waits for that runner's result file, and hands the result back to the task. Everything
 * about verification lives here so the agent file only has to call one function.
 *
 * Failure is a value, not an exception: the agent needs to report "refused because GRANT..." as a task result, and a thrown
 * error would lose the reason.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyRequest } from '../maintenance/protocol.mjs';
import { createPinStore } from '../maintenance/operator-key.mjs';

export function maintenancePaths(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return {
      queueDir: env.W2M_MAINTENANCE_QUEUE ?? 'C:\\ProgramData\\w2m\\maintenance\\queue',
      doneDir: env.W2M_MAINTENANCE_DONE ?? 'C:\\ProgramData\\w2m\\maintenance\\done',
      pinFile: env.W2M_MAINTENANCE_PINS ?? 'C:\\ProgramData\\w2m\\maintenance\\operator-pins.json',
    };
  }
  return {
    queueDir: env.W2M_MAINTENANCE_QUEUE ?? '/var/lib/w2m/maintenance/queue',
    doneDir: env.W2M_MAINTENANCE_DONE ?? '/var/lib/w2m/maintenance/done',
    pinFile: env.W2M_MAINTENANCE_PINS ?? '/var/lib/w2m/maintenance/operator-pins.json',
  };
}

/**
 * Carry one offer's maintenance request to the root runner and return its result.
 *
 * @param {object} options
 * @param {object} options.offer the task offer (must carry maintenance and may carry operator_key)
 * @param {string} options.machineId this machine's id
 * @param {string} [options.queueDir]
 * @param {string} [options.doneDir]
 * @param {string} [options.pinFile]
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<{ok: true, result: object, requestId: string} | {ok: false, code: string, message: string, requestId: string|null}>}
 */
export async function ferryMaintenance(options) {
  const {
    offer,
    machineId,
    timeoutMs = 120_000,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  } = options;
  const paths = maintenancePaths(options.env, options.platform);
  const queueDir = options.queueDir ?? paths.queueDir;
  const doneDir = options.doneDir ?? paths.doneDir;
  const pinFile = options.pinFile ?? paths.pinFile;
  const request = offer?.maintenance;
  const requestId = typeof request?.request_id === 'string' ? request.request_id : null;
  const fail = (code, message) => ({ ok: false, code, message, requestId });

  if (requestId === null) return fail('MAINTENANCE_BAD_SHAPE', 'offer carries no maintenance.request_id');
  const store = createPinStore(pinFile);
  let pins;
  try {
    pins = store.load();
  } catch (error) {
    return fail(error?.code ?? 'PINS_CORRUPT', error?.message ?? 'operator pin store is unreadable');
  }
  if (pins.pinned === null) {
    if (typeof offer.operator_key?.public_key_pem !== 'string') return fail('MAINTENANCE_NO_PINNED_KEY', 'no pinned operator key and none supplied with the request');
    try {
      store.pinFromRegistration({ protocol: 'w2m-operator-key/v1', key_id: offer.operator_key.key_id, public_key_pem: offer.operator_key.public_key_pem, created_at: offer.operator_key.created_at });
      pins = store.load();
    } catch (error) {
      return fail(error?.code ?? 'MAINTENANCE_PIN_FAILED', error?.message ?? 'operator key could not be pinned');
    }
  }
  const verified = verifyRequest(request, {
    publicKeyPem: pins.pinned.public_key_pem,
    expectedKeyId: pins.pinned.key_id,
    expectedMachineId: String(machineId ?? ''),
    nowMs: now(),
    isRevoked: (keyId) => store.isRevoked(keyId),
  });
  if (verified.ok !== true) return fail(verified.code, verified.detail?.message ?? 'maintenance request refused');

  const requestFile = join(queueDir, String(requestId) + '.json');
  const doneFile = join(doneDir, encodeURIComponent(String(requestId)) + '.json');
  try {
    mkdirSync(queueDir, { recursive: true });
    mkdirSync(doneDir, { recursive: true });
    const tmp = requestFile + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(request), 'utf8');
    renameSync(tmp, requestFile);
  } catch (error) {
    return fail('MAINTENANCE_QUEUE_UNAVAILABLE', error?.message ?? 'the maintenance queue directory is not writable');
  }

  const deadline = now() + Math.max(1_000, Number(timeoutMs) || 120_000);
  while (now() < deadline) {
    if (existsSync(doneFile)) {
      try {
        return { ok: true, result: JSON.parse(readFileSync(doneFile, 'utf8')), requestId };
      } catch (error) {
        return fail('MAINTENANCE_RESULT_UNREADABLE', error?.message ?? 'the runner wrote an unreadable result');
      }
    }
    await sleep(500);
  }
  return fail('MAINTENANCE_RUNNER_TIMEOUT', 'the root runner did not report within the timeout');
}
