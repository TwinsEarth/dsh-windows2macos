/**
 * Agent-side grant gate (M2, v1.3.10-beta.3 slice).
 *
 * The allow-list is a standing decision; a grant is a decision made now. This gate is what the agent asks before it falls
 * through to the allow-list refusal: is there a valid signed grant for exactly this argv, on this machine, for this task,
 * still inside its window, and not already spent?
 *
 * Verification is delegated to src/maintenance/grant.mjs; this file owns the decision's state (which grants were used) and
 * the operator pin handling (first contact pins, later keys must rotate).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyGrant } from '../maintenance/grant.mjs';
import { createPinStore } from '../maintenance/operator-key.mjs';

/**
 * @param {object} options
 * @param {object} options.offer the task offer
 * @param {string} options.machineId
 * @param {string} options.pinFile operator pin store path
 * @param {string} [options.usedFile] persisted grant uses (grant_id -> count, plus nonces)
 * @param {() => number} [options.now]
 * @returns {Promise<{ok: true, grantId: string, used: number} | {ok: false, code: string, message: string, detail?: object}>}
 */
export async function authorizeWithGrant(options) {
  const { offer, machineId, pinFile, usedFile, now = () => Date.now() } = options;
  const grant = offer?.grant;
  if (grant === null || typeof grant !== 'object') return { ok: false, code: 'GRANT_MISSING', message: 'no grant on the offer' };

  const store = createPinStore(pinFile);
  let pins;
  try { pins = store.load(); } catch (error) { return { ok: false, code: error?.code ?? 'PINS_CORRUPT', message: error?.message ?? 'pin store unreadable' }; }
  if (pins.pinned === null) {
    if (typeof offer.operator_key?.public_key_pem !== 'string') return { ok: false, code: 'GRANT_NO_PINNED_KEY', message: 'no operator key is pinned and none was supplied' };
    try {
      store.pinFromRegistration({ protocol: 'w2m-operator-key/v1', key_id: offer.operator_key.key_id, public_key_pem: offer.operator_key.public_key_pem, created_at: offer.operator_key.created_at });
      pins = store.load();
    } catch (error) {
      return { ok: false, code: error?.code ?? 'GRANT_PIN_FAILED', message: error?.message ?? 'operator key could not be pinned' };
    }
  }

  const used = readUsed(usedFile);
  const verified = verifyGrant(grant, {
    publicKeyPem: pins.pinned.public_key_pem,
    expectedKeyId: pins.pinned.key_id,
    nowMs: now(),
    machineId,
    taskId: typeof offer.task_id === 'string' ? offer.task_id : null,
    argv: Array.isArray(offer.command_argv) ? offer.command_argv : [],
    usedGrantIds: new Set(Object.keys(used.grants)),
    usedNonces: new Set(used.nonces),
    usedCount: used.grants[grant.grant_id] ?? 0,
    isRevoked: (keyId) => store.isRevoked(keyId),
    policy: { mode: offer.mode, cwd_rel: offer.cwd_rel, write: offer.write === true, write_scope: offer.write_scope },
  });
  if (verified.ok !== true) return { ok: false, code: verified.code, message: verified.detail?.message ?? 'grant refused', detail: verified.detail };

  used.grants[grant.grant_id] = (used.grants[grant.grant_id] ?? 0) + 1;
  used.nonces = [...used.nonces, grant.nonce].slice(-500);
  writeUsed(usedFile, used);
  return { ok: true, grantId: grant.grant_id, used: used.grants[grant.grant_id] };
}

function readUsed(file) {
  if (typeof file !== 'string' || file === '' || !existsSync(file)) return { grants: {}, nonces: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { grants: parsed.grants && typeof parsed.grants === 'object' ? parsed.grants : {}, nonces: Array.isArray(parsed.nonces) ? parsed.nonces : [] };
  } catch {
    // A corrupt use ledger must not silently reset counts: that would make a spent grant usable again.
    return { grants: { __corrupt__: 1 }, nonces: [] };
  }
}

function writeUsed(file, used) {
  if (typeof file !== 'string' || file === '') return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify({ protocol: 'w2m-grant-uses/v1', ...used }, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}
