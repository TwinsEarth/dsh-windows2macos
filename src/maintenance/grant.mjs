/**
 * Task-level execution grants (v1.3.10-beta.3 / M2 design slice).
 *
 * A grant is the operator's explicit, single-use authorisation for one argv on named machines. It is checked by the agent
 * before the allow-list: an allow-list entry is a standing decision made by the machine owner, while a grant is a decision
 * made now, for this, with an expiry — and the ledger can tell them apart afterwards.
 *
 * This module is the protocol only. Signing lives on the control side; verification runs on the machine that would execute
 * the command. Nothing here executes anything.
 */
import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { canonicalize } from './protocol.mjs';
import { keyIdOf } from './operator-key.mjs';

export const GRANT_PROTOCOL = 'w2m-grant/v1';
export const MAX_GRANT_BYTES = 8 * 1024;
export const MAX_GRANT_TTL_MS = 10 * 60 * 1000;
export const CLOCK_SKEW_MS = 60 * 1000;

const OBJ = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const STR = (value) => typeof value === 'string' && value !== '';

export function argvHash(argv) {
  return createHash('sha256').update(JSON.stringify(argv), 'utf8').digest('hex');
}

/**
 * Build the unsigned grant body. The caller supplies the expanded argv (the operator must see what is being authorised).
 */
export function buildGrant({ taskId = null, machineIds, argv, mode, cwdRel, write, writeScope, maxUses = 1, ttlMs = 5 * 60 * 1000, nowMs = Date.now(), issuedBy = 'operator', grantId, nonce }) {
  const grant = {
    protocol: GRANT_PROTOCOL,
    grant_id: grantId ?? 'gr-' + nowMs.toString(36) + '-' + createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 10),
    task_id: taskId,
    machine_ids: [...machineIds],
    argv_hash: argvHash(argv),
    argv_head: argv.slice(0, 8).map((part) => String(part).slice(0, 160)),
    max_uses: maxUses,
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    nonce: nonce ?? createHash('sha256').update(String(Math.random()) + String(nowMs)).digest('hex').slice(0, 32),
    issued_by: issuedBy,
  };
  if (mode !== undefined) grant.mode = mode;
  if (cwdRel !== undefined) grant.cwd_rel = cwdRel;
  if (write !== undefined) grant.write = write;
  if (writeScope !== undefined) grant.write_scope = writeScope;
  return grant;
}

export function signingPayload(grant) {
  const { signature: _signature, ...rest } = grant;
  return canonicalize(rest);
}

/** Sign on the control side. The private key never leaves the operator's machine. */
export function signGrant(grant, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = signBytes(null, Buffer.from(signingPayload(grant), 'utf8'), privateKey);
  const publicKey = createPublicKey(privateKey);
  return { ...grant, signature: { alg: 'ed25519', key_id: keyIdOf(publicKey), value_base64: signature.toString('base64') } };
}

function checkConstraints(grant, context) {
  const policy = context?.policy ?? {};
  if (grant.mode !== undefined && typeof policy.mode === 'string' && grant.mode !== policy.mode) return { ok: false, code: 'GRANT_CONSTRAINT_VIOLATION', detail: { field: 'mode', grant: grant.mode, task: policy.mode } };
  if (grant.cwd_rel !== undefined && typeof policy.cwd_rel === 'string' && grant.cwd_rel !== policy.cwd_rel) return { ok: false, code: 'GRANT_CONSTRAINT_VIOLATION', detail: { field: 'cwd_rel', grant: grant.cwd_rel, task: policy.cwd_rel } };
  if (grant.write === true && policy.write !== true) return { ok: false, code: 'GRANT_CONSTRAINT_VIOLATION', detail: { field: 'write', reason: 'a grant cannot widen a read-only task' } };
  if (Array.isArray(grant.write_scope) && Array.isArray(policy.write_scope)) {
    for (const scope of grant.write_scope) if (!policy.write_scope.includes(scope)) return { ok: false, code: 'GRANT_CONSTRAINT_VIOLATION', detail: { field: 'write_scope', scope } };
  }
  return { ok: true };
}

/**
 * Verify a grant against the concrete action about to run.
 *
 * @param {object} grant parsed JSON (untrusted)
 * @param {{publicKeyPem: string, expectedKeyId?: string, nowMs?: number, machineId: string, taskId?: string|null,
 *          argv: string[], usedGrantIds?: Set<string>, usedNonces?: Set<string>, usedCount?: number,
 *          isRevoked?: (keyId: string) => boolean, policy?: object}} context
 * @returns {{ok: true, grant: object} | {ok: false, code: string, detail: object}}
 */
export function verifyGrant(grant, context) {
  const nowMs = Number.isInteger(context?.nowMs) ? context.nowMs : Date.now();
  const fail = (code, message, detail = {}) => ({ ok: false, code, detail: { message, ...detail } });

  if (!OBJ(grant)) return fail('GRANT_BAD_SHAPE', 'grant must be a JSON object');
  if (Buffer.byteLength(JSON.stringify(grant), 'utf8') > MAX_GRANT_BYTES) return fail('GRANT_TOO_LARGE', `grant exceeds ${MAX_GRANT_BYTES} bytes`);
  if (grant.protocol !== GRANT_PROTOCOL) return fail('GRANT_UNSUPPORTED_VERSION', 'unknown grant protocol', { got: String(grant.protocol) });
  if (!STR(grant.grant_id) || !STR(grant.nonce)) return fail('GRANT_BAD_SHAPE', 'grant_id and nonce are required');
  if (!Array.isArray(grant.machine_ids) || grant.machine_ids.length === 0) return fail('GRANT_BAD_SHAPE', 'machine_ids must be a non-empty array');
  if (!Number.isInteger(grant.max_uses) || grant.max_uses < 1 || grant.max_uses > 100) return fail('GRANT_BAD_SHAPE', 'max_uses must be an integer in 1..100');
  if (!/^[0-9a-f]{64}$/.test(String(grant.argv_hash ?? ''))) return fail('GRANT_BAD_SHAPE', 'argv_hash must be 64 lowercase hex');

  const signature = grant.signature;
  if (!OBJ(signature) || signature.alg !== 'ed25519' || !STR(signature.value_base64) || !STR(signature.key_id)) {
    return fail('GRANT_MISSING_SIGNATURE', 'grant carries no usable ed25519 signature');
  }
  if (context?.expectedKeyId !== undefined && signature.key_id !== context.expectedKeyId) {
    return fail('GRANT_UNKNOWN_KEY', 'grant was signed by a key this machine has not pinned', { key_id: signature.key_id, pinned: context.expectedKeyId });
  }
  if (typeof context?.isRevoked === 'function' && context.isRevoked(signature.key_id) === true) {
    return fail('GRANT_REVOKED', 'signing key has been revoked', { key_id: signature.key_id });
  }

  let publicKey;
  try { publicKey = createPublicKey(context?.publicKeyPem ?? ''); } catch { return fail('GRANT_UNKNOWN_KEY', 'no usable operator public key is configured'); }
  let ok = false;
  try { ok = verifyBytes(null, Buffer.from(signingPayload(grant), 'utf8'), publicKey, Buffer.from(signature.value_base64, 'base64')); } catch { ok = false; }
  if (ok !== true) return fail('GRANT_BAD_SIGNATURE', 'signature does not cover this grant');

  if (!STR(context?.machineId)) return fail('GRANT_BAD_SHAPE', 'machine binding is missing');
  if (!grant.machine_ids.includes(context.machineId)) return fail('GRANT_WRONG_MACHINE', 'grant does not name this machine', { machine_ids: grant.machine_ids, local: context.machineId });

  const issuedAt = Date.parse(String(grant.issued_at ?? ''));
  const expiresAt = Date.parse(String(grant.expires_at ?? ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return fail('GRANT_BAD_SHAPE', 'issued_at/expires_at are not a usable window');
  if (expiresAt - issuedAt > MAX_GRANT_TTL_MS) return fail('GRANT_TTL_TOO_LONG', 'grant lives longer than the maximum TTL', { ttl_ms: expiresAt - issuedAt, max_ttl_ms: MAX_GRANT_TTL_MS });
  if (issuedAt > nowMs + CLOCK_SKEW_MS) return fail('GRANT_FUTURE', 'grant is not valid yet', { issued_at: grant.issued_at });
  if (nowMs > expiresAt) return fail('GRANT_EXPIRED', 'grant has expired', { expires_at: grant.expires_at });

  if (grant.task_id !== null && grant.task_id !== undefined) {
    if (typeof context?.taskId !== 'string' || context.taskId !== grant.task_id) return fail('GRANT_WRONG_TASK', 'grant is bound to a different task', { grant_task: grant.task_id, task: context?.taskId ?? null });
  }
  if (context?.usedGrantIds instanceof Set && context.usedGrantIds.has(grant.grant_id)) return fail('GRANT_REPLAY', 'grant_id was already used', { grant_id: grant.grant_id });
  if (context?.usedNonces instanceof Set && context.usedNonces.has(grant.nonce)) return fail('GRANT_REPLAY', 'nonce was already used', { nonce: grant.nonce });
  const used = Number.isInteger(context?.usedCount) ? context.usedCount : 0;
  if (used >= grant.max_uses) return fail('GRANT_USES_EXHAUSTED', 'grant has no uses left', { max_uses: grant.max_uses, used });

  if (!Array.isArray(context?.argv)) return fail('GRANT_BAD_SHAPE', 'the concrete argv is required for the hash comparison');
  const actualHash = argvHash(context.argv);
  if (actualHash !== grant.argv_hash) return fail('GRANT_ARGV_MISMATCH', 'argv_hash does not match the command about to run', { expected: grant.argv_hash, actual: actualHash });

  const constraints = checkConstraints(grant, context);
  if (constraints.ok !== true) return { ok: false, code: constraints.code, detail: constraints.detail };

  return { ok: true, grant };
}
