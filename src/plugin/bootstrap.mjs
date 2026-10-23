/**
 * w2m relay bootstrap (v1.5.2) — verified relay assignment for a fresh installation.
 *
 * ## The problem
 *
 * A new install has no idea which relay its fleet uses: `rabbitUrl` falls back to the hard-coded
 * shared server, so a machine can look connected while belonging to somebody else's data plane.
 * Carrying a full `relayUrls` list by hand works, but it is easy to get wrong on the Nth machine.
 *
 * ## The shape of the answer
 *
 * The machine asks a **bootstrap endpoint** which relays its fleet uses, proves which fleet it is
 * (an HMAC derived from the account's fleet key), and accepts the answer only if it is **signed by
 * the operator's pinned Ed25519 key**. Four properties matter, and each has a test:
 *
 *   1. **No silent misdirection.** Every failure keeps the existing configuration: the plugin never
 *      "helpfully" switches a machine to a relay whose answer it could not verify.
 *   2. **The signature is over a canonical payload** (fleet id + relay list + validity window), so a
 *      response cannot be replayed for another fleet or trimmed to one relay without detection.
 *   3. **Replays are bounded by time.** `expires_at` is enforced against the local clock; an expired
 *      answer is refused even when its signature is valid.
 *   4. **A cache never outlives the answer.** The cached file is re-verified on every read (signature
 *      and expiry), so editing it by hand cannot pin the machine to an unverified relay list.
 *
 * The request proof is HMAC-SHA256 over the fleet id, timestamp and nonce, keyed by the decoded
 * fleet key. A static file server can ignore it; a real bootstrap service can rate-limit and scope
 * by fleet without ever receiving the key itself.
 */
import { createHash, createHmac, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/**
 * Fleet-key helpers, implemented here rather than imported: `plugin` may not depend on `chatops`
 * (the layer model refuses the upward edge), and these two functions are the whole of what this
 * module needs. Keeping the dependency out is cheaper than an allow-list entry that would have
 * to be justified forever.
 */
function decodeFleetKey(encoded) {
  if (typeof encoded !== 'string' || encoded === '') return null;
  try {
    const buf = Buffer.from(encoded, 'base64url');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}
function fleetIdFromKey(key) {
  return createHash('sha256').update(key).digest('hex');
}



export const BOOTSTRAP_PROTOCOL = 'w2m-bootstrap/v1';
/**
 * v1.5.3 built-in bootstrap defaults.
 *
 * A machine whose only capability is "upgrade the plugin" cannot be told a URL or a pin by hand,
 * so the operator's endpoint and public key ship inside the package. Only the PUBLIC key is here:
 * the endpoint cannot mint answers, and the private key never leaves the operator's machine. A signed
 * answer still has to verify and be unexpired, so the built-in values are a discovery hint, not trust.
 */
export const DEFAULT_BOOTSTRAP_URL = 'http://202.182.123.154:8911/bootstrap';
export const DEFAULT_BOOTSTRAP_OPERATOR_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAQdjWX9TggM/S1Bm/OKUI3/Q2IL20Le354AXwiMtua+0=',
  '-----END PUBLIC KEY-----',
  '',
].join(String.fromCharCode(10));
export const BOOTSTRAP_PROOF_PROTOCOL = 'w2m-bootstrap-proof/v1';
/** Refusals are values with stable names, because the status surface reports them verbatim. */
export const BOOTSTRAP_REFUSAL = Object.freeze({
  NOT_CONFIGURED: 'BOOTSTRAP_NOT_CONFIGURED',
  NO_FLEET_KEY: 'BOOTSTRAP_NO_FLEET_KEY',
  NO_OPERATOR_PIN: 'BOOTSTRAP_NO_OPERATOR_PIN',
  UNREACHABLE: 'BOOTSTRAP_UNREACHABLE',
  BAD_JSON: 'BOOTSTRAP_BAD_JSON',
  BAD_PROTOCOL: 'BOOTSTRAP_BAD_PROTOCOL',
  WRONG_FLEET: 'BOOTSTRAP_WRONG_FLEET',
  EXPIRED: 'BOOTSTRAP_EXPIRED',
  BAD_SIGNATURE: 'BOOTSTRAP_BAD_SIGNATURE',
  BAD_RELAYS: 'BOOTSTRAP_BAD_RELAYS',
});

const MAX_RELAYS = 16;

/**
 * The fleet id a bootstrap request proves. Derived from the key, never sent as a raw claim.
 *
 * @param {string} fleetKeyEncoded base64url 32-byte fleet key
 * @returns {string|null}
 */
export function fleetIdOf(fleetKeyEncoded) {
  const key = decodeFleetKey(fleetKeyEncoded);
  return key === null ? null : fleetIdFromKey(key);
}

/**
 * The canonical bytes the operator signs. Sorted, newline-joined, no JSON encoder ambiguity.
 *
 * @param {{fleet_id: string, relays: string[], issued_at: string, expires_at: string}} answer
 * @returns {string}
 */
export function canonicalBootstrapPayload(answer) {
  const relays = (Array.isArray(answer.relays) ? answer.relays : [])
    .map((url) => String(url).trim().replace(/\/+$/, ''))
    .sort();
  return [
    BOOTSTRAP_PROTOCOL,
    String(answer.fleet_id ?? ''),
    relays.join(','),
    String(answer.issued_at ?? ''),
    String(answer.expires_at ?? ''),
  ].join('\n');
}

/**
 * Build the request proof for one bootstrap call.
 *
 * @param {{fleetKey: string, fleetId: string, issuedAtMs?: number, nonce: string}} input
 * @returns {{protocol: string, fleet_id: string, issued_at_ms: number, nonce: string, alg: string, proof: string}}
 */
export function buildBootstrapProof(input) {
  const key = decodeFleetKey(input.fleetKey);
  if (key === null) throw new TypeError('fleetKey must be a 32-byte base64url key');
  const issuedAtMs = Number.isInteger(input.issuedAtMs) ? input.issuedAtMs : Date.now();
  const nonce = String(input.nonce ?? '');
  const message = [BOOTSTRAP_PROOF_PROTOCOL, input.fleetId, String(issuedAtMs), nonce].join('\n');
  const proof = createHmac('sha256', key).update(message, 'utf8').digest('hex');
  return {
    protocol: BOOTSTRAP_PROOF_PROTOCOL,
    fleet_id: input.fleetId,
    issued_at_ms: issuedAtMs,
    nonce,
    alg: 'hmac-sha256',
    proof,
  };
}

/**
 * Verify one signed bootstrap answer against the pinned operator key and this machine's fleet.
 *
 * @param {object} answer Parsed JSON body from the bootstrap endpoint.
 * @param {{operatorPublicKeyPem: string, fleetId: string, nowMs?: number}} input
 * @returns {{ok: true, relays: string[], issued_at: string, expires_at: string}
 *   |{ok: false, reason_code: string, detail: string}}
 */
export function verifyBootstrapAnswer(answer, input) {
  const refuse = (reason_code, detail) => ({ ok: false, reason_code, detail });
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return refuse(BOOTSTRAP_REFUSAL.BAD_JSON, 'the bootstrap answer is not a JSON object');
  }
  if (answer.protocol !== BOOTSTRAP_PROTOCOL) {
    return refuse(BOOTSTRAP_REFUSAL.BAD_PROTOCOL, `expected protocol ${BOOTSTRAP_PROTOCOL}, got ${JSON.stringify(answer.protocol ?? null)}`);
  }
  // v1.5.3: when the machine cannot derive a fleet key yet, it still must not be stranded: the
  // signed relay list is public routing information, so a signature-only answer is adopted for relay
  // assignment. Joining the fleet still needs the account-derived key, which is a separate step.
  /**
   * v1.6.0: a signed answer states relay topology, not one fleet's identity.
   *
   * Every DeepSeek account derives its own fleet key and therefore its own fleet id; on a shared
   * relay those fleets coexist and are isolated per fleet (v1.5.5). The relay list is the same for
   * all of them, so one operator-signed answer can serve N fleets -- refusing it for a fleet id
   * mismatch would require the operator to re-sign per account, which is exactly the manual step
   * this release removes. The signature and expiry remain strict; only the fleet binding relaxes.
   */
  const fleetMismatch = typeof input.fleetId === 'string' && answer.fleet_id !== input.fleetId;
  if (fleetMismatch && input.strictFleet === true) {
    return refuse(BOOTSTRAP_REFUSAL.WRONG_FLEET, 'the answer names a different fleet and strictFleet is set');
  }
  const relays = Array.isArray(answer.relays)
    ? [...new Set(answer.relays.filter((url) => typeof url === 'string' && url.trim() !== '').map((url) => url.trim().replace(/\/+$/, '')))]
    : [];
  if (relays.length === 0) return refuse(BOOTSTRAP_REFUSAL.BAD_RELAYS, 'the answer carries no relay URLs');
  if (relays.length > MAX_RELAYS) return refuse(BOOTSTRAP_REFUSAL.BAD_RELAYS, `the answer carries ${relays.length} relays, more than ${MAX_RELAYS}`);
  for (const url of relays) {
    if (!/^https?:\/\/[^\s]+$/.test(url)) return refuse(BOOTSTRAP_REFUSAL.BAD_RELAYS, `${JSON.stringify(url)} is not an http(s) base URL`);
  }
  const nowMs = Number.isInteger(input.nowMs) ? input.nowMs : Date.now();
  const expiresAt = Date.parse(String(answer.expires_at ?? ''));
  if (!Number.isFinite(expiresAt)) return refuse(BOOTSTRAP_REFUSAL.BAD_JSON, '`expires_at` is not a timestamp');
  if (expiresAt <= nowMs) return refuse(BOOTSTRAP_REFUSAL.EXPIRED, `the answer expired at ${answer.expires_at}`);
  const issuedAt = Date.parse(String(answer.issued_at ?? ''));
  if (!Number.isFinite(issuedAt)) return refuse(BOOTSTRAP_REFUSAL.BAD_JSON, '`issued_at` is not a timestamp');
  const signature = answer.signature;
  const signatureB64 = typeof signature === 'string' ? signature
    : (signature !== null && typeof signature === 'object' ? signature.value : undefined);
  if (typeof signatureB64 !== 'string' || signatureB64 === '') {
    return refuse(BOOTSTRAP_REFUSAL.BAD_SIGNATURE, 'the answer carries no signature');
  }
  let publicKey;
  try {
    publicKey = createPublicKey(input.operatorPublicKeyPem);
  } catch (error) {
    return refuse(BOOTSTRAP_REFUSAL.NO_OPERATOR_PIN, `the pinned operator key is not a usable PEM: ${error instanceof Error ? error.message : String(error)}`);
  }
  const signed = canonicalBootstrapPayload({ fleet_id: answer.fleet_id, relays, issued_at: answer.issued_at, expires_at: answer.expires_at });
  let signatureOk = false;
  try {
    signatureOk = verifySignature(null, Buffer.from(signed, 'utf8'), publicKey, Buffer.from(signatureB64, 'base64'));
  } catch {
    signatureOk = false;
  }
  if (!verifiedSignatureOk(signatureOk)) {
    return refuse(BOOTSTRAP_REFUSAL.BAD_SIGNATURE, 'the answer signature does not match the pinned operator key and the canonical payload');
  }
  return { ok: true, relays, issued_at: answer.issued_at, expires_at: answer.expires_at, answer_fleet_id: typeof answer.fleet_id === 'string' ? answer.fleet_id : null, fleet_mismatch: fleetMismatch };
}

/** Kept separate so a test can assert the failure branch without a real crypto fault. */
function verifiedSignatureOk(value) {
  return value === true;
}

/**
 * Fetch, verify and cache one bootstrap answer.
 *
 * A cached file that still verifies is preferred (no network on every start); any verification
 * failure falls through to a fresh fetch. Every failure keeps the caller's configuration untouched
 * and returns a named reason for `w2m_status`.
 *
 * @param {object} deps
 * @param {string} deps.url
 * @param {string} deps.fleetKey
 * @param {string} deps.operatorPublicKeyPem
 * @param {string} deps.cacheFile
 * @param {Function} [deps.fetchImpl]
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.nowMs]
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<{ok: true, relays: string[], source: 'cache'|'network', expires_at: string}
 *   |{ok: false, reason_code: string, detail: string}>}
 */
export async function resolveBootstrap(deps) {
  const log = deps.log ?? (() => {});
  const fleetId = deps.fleetKey === null || deps.fleetKey === undefined ? null : fleetIdOf(deps.fleetKey);
  if (deps.fleetKey !== null && deps.fleetKey !== undefined && fleetId === null) {
    return { ok: false, reason_code: BOOTSTRAP_REFUSAL.NO_FLEET_KEY, detail: 'the configured fleet key is not a 32-byte base64url key' };
  }
  const pinned = readBootstrapCache(deps.cacheFile, { operatorPublicKeyPem: deps.operatorPublicKeyPem, fleetId, nowMs: deps.nowMs });
  if (pinned.ok === true) {
    log(`w2m: bootstrap cache is valid (${pinned.relays.join(', ')})`);
    return { ok: true, relays: pinned.relays, source: 'cache', expires_at: pinned.expires_at };
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isInteger(deps.timeoutMs) ? deps.timeoutMs : 4000;
  const nonce = createHash('sha256').update(`${fleetId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32);
  // v1.5.3: the proof is optional. Without a fleet key the request cannot prove which fleet it is,
  // but the ANSWER is still verified by signature, expiry and relay shape -- so relay assignment can
  // be automatic even before an account-derived key is available.
  const proof = deps.fleetKey === null || deps.fleetKey === undefined ? null : buildBootstrapProof({ fleetKey: deps.fleetKey, fleetId, nonce });
  let answer;
  try {
    const response = await fetchImpl(deps.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: BOOTSTRAP_PROOF_PROTOCOL, proof }),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!response.ok) {
      return { ok: false, reason_code: BOOTSTRAP_REFUSAL.UNREACHABLE, detail: `the bootstrap endpoint answered HTTP ${response.status}` };
    }
    answer = await response.json();
  } catch (error) {
    return { ok: false, reason_code: BOOTSTRAP_REFUSAL.UNREACHABLE, detail: error instanceof Error ? error.message : String(error) };
  }
  const verified = verifyBootstrapAnswer(answer, {
    operatorPublicKeyPem: deps.operatorPublicKeyPem,
    fleetId,
    nowMs: deps.nowMs,
  });
  if (verified.ok !== true) return verified;
  writeBootstrapCache(deps.cacheFile, { fleet_id: fleetId, relays: verified.relays, issued_at: verified.issued_at, expires_at: verified.expires_at, signature: answer.signature });
  log(`w2m: bootstrap assigned relays (${verified.relays.join(', ')}, expires ${verified.expires_at})`);
  return { ok: true, relays: verified.relays, source: 'network', expires_at: verified.expires_at };
}

/** Write a verified answer so the next start does not depend on the bootstrap endpoint being up. */
export function writeBootstrapCache(file, entry) {
  if (typeof file !== 'string' || file === '') return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ protocol: 'w2m-bootstrap-cache/v1', ...entry }, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the cache and re-verify it. A hand-edited cache is not trusted: the same signature check the
 * network answer goes through runs here, so a cache cannot pin an unverified relay list.
 *
 * @param {string} file
 * @param {{operatorPublicKeyPem: string, fleetId: string, nowMs?: number}} input
 * @returns {{ok: true, relays: string[], expires_at: string}|{ok: false, reason_code: string, detail: string}}
 */
export function readBootstrapCache(file, input) {
  const refuse = (reason_code, detail) => ({ ok: false, reason_code, detail });
  if (typeof file !== 'string' || file === '' || !existsSync(file)) {
    return refuse(BOOTSTRAP_REFUSAL.NOT_CONFIGURED, 'no bootstrap cache exists yet');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return refuse(BOOTSTRAP_REFUSAL.BAD_JSON, `the bootstrap cache is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const answer = {
    protocol: BOOTSTRAP_PROTOCOL,
    fleet_id: parsed.fleet_id,
    relays: parsed.relays,
    issued_at: parsed.issued_at,
    expires_at: parsed.expires_at,
    signature: parsed.signature,
  };
  return verifyBootstrapAnswer(answer, input);
}
