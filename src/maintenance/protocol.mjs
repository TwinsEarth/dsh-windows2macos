/**
 * The maintenance-request wire protocol (v1.3.2-beta, M1).
 *
 * A request is a signed JSON document that authorises exactly one of three fixed actions (update/restart/diag) on one
 * machine. This module owns the shape, the canonical bytes that are signed, and every refusal the verifier can produce.
 * It deliberately does not execute anything: the root runner decides, this file only says yes or no.
 *
 * Design notes that matter:
 *   - The signature covers the action and its parameters, the machine id and the time window. A relay (or any transport)
 *     can therefore reroute a request but cannot reshape it.
 *   - Timestamps are compared against an injected clock, because tests must be able to sit on both sides of a TTL edge.
 *   - Every refusal is a named code; "it failed" alone would tell an operator nothing about what to fix.
 */
import { createHash, randomBytes, sign as signBytes, verify as verifyBytes, createPrivateKey, createPublicKey } from 'node:crypto';

export const MAINTENANCE_PROTOCOL = 'w2m-maintenance/v1';

/** The complete action vocabulary. Anything else is refused before signature checking can be wasted on it. */
export const MAINTENANCE_ACTIONS = Object.freeze(['update', 'restart', 'diag']);

/** Request files are small by construction: a large request is either a bug or an attempt to exhaust the queue. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** The operator may not authorise an action that stays valid for longer than this, whatever the request says. */
export const MAX_TTL_MS = 10 * 60 * 1000;

/** Clock disagreement is tolerated, but only in the direction that cannot extend a window. */
export const CLOCK_SKEW_MS = 60 * 1000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{8,32}$/;
const REQUEST_ID = /^[0-9A-Za-z-]{8,64}$/;
const NONCE = /^[0-9A-Za-z_-]{8,64}$/;

export class MaintenanceProtocolError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'MaintenanceProtocolError';
    this.code = code;
    this.detail = detail;
  }
}

/** Deep-sort object keys so two processes sign the same bytes. Arrays keep order: argv and files are ordered data. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((entry) => canonicalize(entry)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
}

/** The exact bytes the operator signs. `signature` itself is excluded by construction. */
export function signingPayload(request) {
  const { signature: _signature, ...rest } = request;
  return canonicalize(rest);
}

export function keyIdOf(publicKeyLike) {
  const key = publicKeyLike?.type === 'public' ? publicKeyLike : createPublicKey(publicKeyLike);
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function generateRequestId(nowMs = Date.now()) {
  return 'mr-' + nowMs.toString(36) + '-' + randomBytes(6).toString('hex');
}

export function generateNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * Build the unsigned request body. Validation of parameters happens in `validateParams`, not here: a builder that
 * silently repaired bad input would make the verifier's refusal list incomplete.
 */
export function buildRequest({ action, params = {}, machineId, issuedBy = 'operator', ttlMs = 60_000, nowMs = Date.now(), requestId, nonce }) {
  if (!Number.isInteger(nowMs) || nowMs < 0) throw new MaintenanceProtocolError('MAINTENANCE_BAD_SHAPE', 'nowMs must be a non-negative integer');
  return {
    protocol: MAINTENANCE_PROTOCOL,
    request_id: requestId ?? generateRequestId(nowMs),
    action,
    params,
    machine_id: machineId,
    nonce: nonce ?? generateNonce(),
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    issued_by: issuedBy,
  };
}

/** Attach an Ed25519 signature. The operator key never leaves the control side. */
export function signRequest(request, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const signature = signBytes(null, Buffer.from(signingPayload(request), 'utf8'), privateKey);
  return {
    ...request,
    signature: { alg: 'ed25519', key_id: keyIdOf(publicKey), value_base64: signature.toString('base64') },
  };
}

export function requestBytes(request) {
  return Buffer.byteLength(JSON.stringify(request), 'utf8');
}

function validateParams(action, params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { action, reason: 'params must be a JSON object' } };
  }
  if (action === 'update') {
    const target = params.target;
    if (target !== 'plugin' && target !== 'relay') return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'target must be plugin or relay' } };
    if (typeof params.version !== 'string' || params.version.trim() === '') return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'version is required' } };
    if (typeof params.artifact_sha256 !== 'string' || !SHA256_HEX.test(params.artifact_sha256)) return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'artifact_sha256 must be 64 lowercase hex' } };
    const urls = params.artifact_urls;
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > 3) return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'artifact_urls must be 1..3 entries' } };
    for (const url of urls) {
      if (typeof url !== 'string' || !url.startsWith('https://')) return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'artifact_urls entries must be https URLs' } };
    }
    if (params.restart_after_update !== undefined && typeof params.restart_after_update !== 'boolean') return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'restart_after_update must be boolean' } };
    return { ok: true };
  }
  if (action === 'restart') {
    const targets = params.targets;
    if (targets !== 'rabbit' && targets !== 'agent' && targets !== 'all') return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'targets must be rabbit, agent or all' } };
    if (params.wait_healthy !== undefined && typeof params.wait_healthy !== 'boolean') return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'wait_healthy must be boolean' } };
    return { ok: true };
  }
  // diag: exactly the fixed, read-only package; an unknown key would be an attempt to widen it.
  const allowedKeys = new Set(['sections']);
  for (const key of Object.keys(params)) if (!allowedKeys.has(key)) return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'diag accepts no parameters' } };
  if (params.sections !== undefined && !Array.isArray(params.sections)) return { ok: false, code: 'MAINTENANCE_BAD_PARAMS', detail: { reason: 'sections must be an array when present' } };
  return { ok: true };
}

/**
 * Verify a request. Every check is ordered cheapest-and-most-fundamental first, and every failure stops before any
 * execution can be attempted.
 *
 * @param {object} request parsed JSON (untrusted)
 * @param {{ publicKeyPem: string, expectedKeyId?: string, nowMs?: number, expectedMachineId: string,
 *           usedRequestIds?: Set<string>, usedNonces?: Set<string>, isRevoked?: (keyId: string) => boolean }} context
 * @returns {{ok: true, request: object} | {ok: false, code: string, detail: object}}
 */
export function verifyRequest(request, context) {
  const nowMs = Number.isInteger(context?.nowMs) ? context.nowMs : Date.now();
  const fail = (code, message, detail = {}) => ({ ok: false, code, detail: { message, ...detail } });

  if (request === null || typeof request !== 'object' || Array.isArray(request)) return fail('MAINTENANCE_BAD_SHAPE', 'request must be a JSON object');
  if (requestBytes(request) > MAX_REQUEST_BYTES) return fail('MAINTENANCE_TOO_LARGE', `request exceeds ${MAX_REQUEST_BYTES} bytes`);
  if (request.protocol !== MAINTENANCE_PROTOCOL) return fail('MAINTENANCE_UNSUPPORTED_VERSION', 'unknown maintenance protocol', { got: String(request.protocol) });
  if (typeof request.request_id !== 'string' || !REQUEST_ID.test(request.request_id)) return fail('MAINTENANCE_BAD_SHAPE', 'request_id is malformed');
  if (typeof request.nonce !== 'string' || !NONCE.test(request.nonce)) return fail('MAINTENANCE_BAD_SHAPE', 'nonce is malformed');
  if (typeof request.machine_id !== 'string' || request.machine_id === '') return fail('MAINTENANCE_BAD_SHAPE', 'machine_id is required');
  if (!MAINTENANCE_ACTIONS.includes(request.action)) return fail('MAINTENANCE_BAD_ACTION', 'action is not one of update/restart/diag', { got: String(request.action) });
  const params = validateParams(request.action, request.params);
  if (params.ok !== true) return fail(params.code, 'action parameters are invalid', params.detail);

  const signature = request.signature;
  if (signature === null || typeof signature !== 'object' || signature.alg !== 'ed25519' || typeof signature.value_base64 !== 'string' || typeof signature.key_id !== 'string') {
    return fail('MAINTENANCE_MISSING_SIGNATURE', 'request carries no usable ed25519 signature');
  }
  if (!KEY_ID.test(signature.key_id)) return fail('MAINTENANCE_BAD_SHAPE', 'key_id is malformed');
  if (context?.expectedKeyId !== undefined && signature.key_id !== context.expectedKeyId) {
    return fail('MAINTENANCE_UNKNOWN_KEY', 'request was signed by a key this machine has not pinned', { key_id: signature.key_id, pinned: context.expectedKeyId });
  }
  if (typeof context?.isRevoked === 'function' && context.isRevoked(signature.key_id) === true) {
    return fail('MAINTENANCE_REVOKED', 'signing key has been revoked', { key_id: signature.key_id });
  }

  let publicKey;
  try {
    publicKey = createPublicKey(context?.publicKeyPem ?? '');
  } catch {
    return fail('MAINTENANCE_UNKNOWN_KEY', 'no usable operator public key is configured');
  }
  let signatureOk = false;
  try {
    signatureOk = verifyBytes(null, Buffer.from(signingPayload(request), 'utf8'), publicKey, Buffer.from(signature.value_base64, 'base64'));
  } catch {
    signatureOk = false;
  }
  if (signatureOk !== true) return fail('MAINTENANCE_BAD_SIGNATURE', 'signature does not cover this request');

  if (typeof request.machine_id !== 'string' || typeof context?.expectedMachineId !== 'string') return fail('MAINTENANCE_BAD_SHAPE', 'machine binding is missing');
  if (request.machine_id !== context.expectedMachineId) return fail('MAINTENANCE_WRONG_MACHINE', 'request targets another machine', { request: request.machine_id, local: context.expectedMachineId });

  const issuedAt = Date.parse(String(request.issued_at ?? ''));
  const expiresAt = Date.parse(String(request.expires_at ?? ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return fail('MAINTENANCE_BAD_SHAPE', 'issued_at/expires_at must be RFC3339 timestamps');
  if (expiresAt <= issuedAt) return fail('MAINTENANCE_BAD_SHAPE', 'expires_at must be after issued_at');
  if (expiresAt - issuedAt > MAX_TTL_MS) return fail('MAINTENANCE_TTL_TOO_LONG', 'request lives longer than the maximum TTL', { ttl_ms: expiresAt - issuedAt, max_ttl_ms: MAX_TTL_MS });
  if (issuedAt > nowMs + CLOCK_SKEW_MS) return fail('MAINTENANCE_FUTURE', 'request is not valid yet', { issued_at: request.issued_at });
  if (nowMs > expiresAt) return fail('MAINTENANCE_EXPIRED', 'request has expired', { expires_at: request.expires_at });

  if (context?.usedRequestIds instanceof Set && context.usedRequestIds.has(request.request_id)) {
    return fail('MAINTENANCE_REPLAY', 'request_id was already executed', { request_id: request.request_id });
  }
  if (context?.usedNonces instanceof Set && context.usedNonces.has(request.nonce)) {
    return fail('MAINTENANCE_REPLAY', 'nonce was already used', { nonce: request.nonce });
  }

  return { ok: true, request };
}
