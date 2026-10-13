/**
 * The device keypair and the authorisation statement (v0.7.6).
 *
 * ## Why this exists
 *
 * v0.7.5 gave a machine an account code and a serial number. Both are **client-computed**, so
 * neither proves anything: anyone who knows an account id can produce a well-formed SN for
 * hardware they do not own. `ACCOUNT-FLEET-DESIGN.md` §2.5 says so in as many words, and this
 * file is the part that fixes it.
 *
 * The fix is a signature chain with three links:
 *
 * 1. **The device generates a keypair** on first run. The private key never leaves the machine
 *    and is never logged.
 * 2. **The relay signs a statement** naming this device, its serial number, its public key and
 *    its fleet. The fleet comes from *the pairing code*, not from anything the device said — so a
 *    device **cannot choose which fleet it joins**. That is the whole of §3.2.
 * 3. **Every request carries a signature** over the statement plus the request, so membership is
 *    proven per request rather than asserted once.
 *
 * ## What this file is careful about
 *
 * **The statement is signed over a canonical encoding.** Two JSON encodings of the same object
 * can sign differently, and a verifier that re-serialises the object it received cannot tell a
 * tampered field from a key-order difference. So the statement travels **as the exact bytes that
 * were signed**, and the verifier signs nothing it reassembled.
 *
 * **Expiry is mandatory.** A statement with no expiry is a permanent credential; a leaked one
 * cannot be aged out. `verifyStatement` refuses a statement without one rather than defaulting to
 * "never expires".
 *
 * **A device cannot widen its own statement.** The fleet id, the machine id and the public key
 * are all inside the signature, so changing any of them invalidates it — which is what makes
 * "this device is in this fleet" a fact rather than a claim.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  createHash,
  randomUUID,
  sign as edSign,
  verify as edVerify,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

/** Signature algorithms this module will use, and nothing else. */
export const ALGORITHM = 'ed25519';

/** Default statement lifetime: 90 days, per the design. */
export const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** How long before expiry a statement may be renewed. */
export const RENEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Why a statement or a signature was refused. */
export const AUTH_REFUSAL = Object.freeze({
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad_signature',
  EXPIRED: 'expired',
  NOT_YET_VALID: 'not_yet_valid',
  NO_EXPIRY: 'no_expiry',
  FLEET_MISMATCH: 'fleet_mismatch',
  MACHINE_MISMATCH: 'machine_mismatch',
  WRONG_ALGORITHM: 'wrong_algorithm',
  CLOCK_SKEW: 'clock_skew',
});

/** How far a device's clock may drift before its request timestamps are refused. */
export const CLOCK_SKEW_MS = 120_000;

/**
 * A canonical, unambiguous encoding of a statement's signed fields.
 *
 * Built by hand rather than with `JSON.stringify` so that **key order is fixed here** and cannot
 * depend on how the object was constructed. A verifier that re-serialised a received object would
 * be verifying its own encoding, which is not the same string the signer signed.
 *
 * Length-prefixing each field removes the other classic ambiguity: without it,
 * `{a:'x', b:'yz'}` and `{a:'xy', b:'z'}` concatenate identically.
 */
export function canonicalStatement(statement) {
  const fields = ['algorithm', 'fleet_id', 'machine_id', 'sn', 'public_key', 'issued_at_ms', 'expires_at_ms'];
  const parts = [];
  for (const field of fields) {
    const value = statement?.[field];
    if (value === undefined || value === null) throw new TypeError(`statement is missing ${field}`);
    const text = String(value);
    parts.push(`${field}:${Buffer.byteLength(text, 'utf8')}:${text}`);
  }
  return parts.join('\n');
}

/**
 * A canonical encoding of one signed request.
 *
 * `body_hash` is the hash of the request body rather than the body itself: a body can be large,
 * and the signature only needs to commit to it.
 */
export function canonicalRequest({ method, path, timestampMs, nonce, bodyHash }) {
  const parts = [
    `method:${Buffer.byteLength(String(method), 'utf8')}:${method}`,
    `path:${Buffer.byteLength(String(path), 'utf8')}:${path}`,
    `timestamp_ms:${String(timestampMs).length}:${timestampMs}`,
    `nonce:${Buffer.byteLength(String(nonce), 'utf8')}:${nonce}`,
    `body_hash:${String(bodyHash).length}:${bodyHash}`,
  ];
  return parts.join('\n');
}

/** Hash a request body for signing. Absent body hashes as the empty string's hash, not as null. */
export function hashBody(body) {
  const text = body === undefined || body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Create a device identity: a keypair plus a stable machine id.
 *
 * @param {object} [options]
 * @param {string} [options.privateKeyPem] An existing key, so a restart keeps its identity.
 * @param {string} [options.machineId]
 * @param {() => string} [options.mintMachineId]
 */
export function createDeviceKey(options = {}) {
  const mintMachineId = options.mintMachineId ?? randomUUID;
  let privateKey;
  let generated = false;

  if (typeof options.privateKeyPem === 'string' && options.privateKeyPem !== '') {
    privateKey = createPrivateKey(options.privateKeyPem);
  } else {
    // Ed25519 needs no parameters and no randomness argument here; the platform CSPRNG supplies it.
    const pair = generateKeyPairSync(ALGORITHM);
    privateKey = pair.privateKey;
    generated = true;
  }

  if (privateKey.asymmetricKeyType !== ALGORITHM) {
    throw new TypeError(`the device key must be ${ALGORITHM}, not ${privateKey.asymmetricKeyType}`);
  }

  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const machineId = options.machineId ?? mintMachineId();

  return {
    machineId,
    publicKeyPem,
    generated,
    /** The private key, for persistence. Callers must write it 0600 and never log it. */
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    /** Sign arbitrary bytes with the device key. */
    sign(bytes) {
      return edSign(null, Buffer.from(bytes, 'utf8'), privateKey);
    },
  };
}

/**
 * Verify a detached signature against a public key.
 *
 * Returns a value rather than throwing, because a bad signature is an expected input on the
 * relay's hot path and an exception there is a denial-of-service shape.
 */
export function verifyWith(publicKeyPem, bytes, signature) {
  try {
    const key = createPublicKey(publicKeyPem);
    return edVerify(null, Buffer.from(bytes, 'utf8'), key, Buffer.from(signature));
  } catch {
    // An unparseable key or signature is a failed verification, not a crash.
    return false;
  }
}

/**
 * Sign a statement into the wire form.
 *
 * The wire form carries **the exact bytes that were signed** alongside the signature, so a
 * verifier never re-serialises. `canonical` is included rather than recomputed for that reason.
 *
 * @param {object} options
 * @param {object} options.statement The fields to commit to.
 * @param {(bytes: string) => Buffer} options.sign The relay's signer.
 */
export function sealStatement({ statement, sign }) {
  const canonical = canonicalStatement(statement);
  const signature = sign(canonical);
  return {
    statement,
    canonical,
    signature: Buffer.from(signature).toString('base64'),
  };
}

/**
 * Verify a sealed statement.
 *
 * @param {object} options
 * @param {object} options.sealed The wire form.
 * @param {(canonical: string, signature: Buffer) => boolean} options.verify The relay's verifier.
 * @param {string} [options.expectFleet] Refuse a statement for another fleet.
 * @param {string} [options.expectMachine] Refuse a statement for another machine.
 * @param {number} [options.now]
 */
export function verifyStatement({ sealed, verify, expectFleet, expectMachine, now = Date.now() }) {
  if (sealed === null || typeof sealed !== 'object') return { ok: false, reason: AUTH_REFUSAL.MALFORMED };
  const { statement, canonical, signature } = sealed;
  if (statement === null || typeof statement !== 'object' || typeof canonical !== 'string' || typeof signature !== 'string') {
    return { ok: false, reason: AUTH_REFUSAL.MALFORMED };
  }
  if (statement.algorithm !== ALGORITHM) {
    return { ok: false, reason: AUTH_REFUSAL.WRONG_ALGORITHM, detail: String(statement.algorithm) };
  }

  /**
   * Expiry is checked **before** the canonical form is recomputed.
   *
   * Order matters here, and a test is what found it. `canonicalStatement` refuses a statement
   * missing a signed field, so a statement with no expiry reported `malformed` — technically true
   * and useless, because the actionable answer is "this statement has no expiry and must not be
   * treated as permanent". Checking it first names the real problem.
   */
  const expires = Number(statement.expires_at_ms);
  if (!Number.isFinite(expires)) return { ok: false, reason: AUTH_REFUSAL.NO_EXPIRY };

  // The signed bytes must be the bytes that describe this statement. Recomputing and comparing
  // is what stops a caller swapping in a different statement beside a valid signature — and it is
  // cheap, because the canonical form is already on the wire.
  let recomputed;
  try {
    recomputed = canonicalStatement(statement);
  } catch (error) {
    return { ok: false, reason: AUTH_REFUSAL.MALFORMED, detail: error.message };
  }
  if (recomputed !== canonical) {
    return { ok: false, reason: AUTH_REFUSAL.MALFORMED, detail: 'the canonical form does not match the statement' };
  }

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
  } catch {
    return { ok: false, reason: AUTH_REFUSAL.MALFORMED, detail: 'signature is not base64' };
  }
  if (!verify(canonical, signatureBytes)) return { ok: false, reason: AUTH_REFUSAL.BAD_SIGNATURE };

  const issued = Number(statement.issued_at_ms);
  if (!Number.isFinite(issued)) return { ok: false, reason: AUTH_REFUSAL.MALFORMED, detail: 'issued_at_ms is not a number' };

  if (now > expires) return { ok: false, reason: AUTH_REFUSAL.EXPIRED, detail: new Date(expires).toISOString() };
  // A statement issued in the future means a clock problem, which is worth naming separately from
  // an expiry: the fixes are different.
  if (issued > now + CLOCK_SKEW_MS) return { ok: false, reason: AUTH_REFUSAL.NOT_YET_VALID, detail: new Date(issued).toISOString() };

  if (typeof expectFleet === 'string' && statement.fleet_id !== expectFleet) {
    return { ok: false, reason: AUTH_REFUSAL.FLEET_MISMATCH, detail: `statement is for ${statement.fleet_id}` };
  }
  if (typeof expectMachine === 'string' && statement.machine_id !== expectMachine) {
    return { ok: false, reason: AUTH_REFUSAL.MACHINE_MISMATCH };
  }
  return { ok: true, statement };
}

/**
 * Sign one request.
 *
 * @param {object} options
 * @param {object} options.device From `createDeviceKey`.
 * @param {string} options.method
 * @param {string} options.path
 * @param {unknown} [options.body]
 * @param {number} [options.now]
 * @param {() => string} [options.mintNonce]
 */
export function signRequest({ device, method, path, body, now = Date.now(), mintNonce = randomUUID }) {
  const timestampMs = now;
  const nonce = mintNonce();
  const bodyHash = hashBody(body);
  const canonical = canonicalRequest({ method, path, timestampMs, nonce, bodyHash });
  return {
    timestampMs,
    nonce,
    bodyHash,
    signature: device.sign(canonical).toString('base64'),
  };
}

/**
 * Verify one request's signature.
 *
 * @param {object} options
 * @param {object} options.headers The request headers, lower-cased.
 * @param {string} options.publicKeyPem
 * @param {string} options.method
 * @param {string} options.path
 * @param {unknown} [options.body]
 * @param {number} [options.now]
 * @param {(nonce: string, timestampMs: number) => boolean} [options.rememberNonce]
 *        Replay defence, injected: without it a captured request is valid forever.
 */
export function verifyRequest({ headers, publicKeyPem, method, path, body, now = Date.now(), rememberNonce }) {
  const ts = Number(headers['x-w2m-timestamp']);
  const nonce = headers['x-w2m-nonce'];
  const signature = headers['x-w2m-signature'];
  const claimedHash = headers['x-w2m-body-hash'];
  if (!Number.isFinite(ts) || typeof nonce !== 'string' || nonce === '' || typeof signature !== 'string' || signature === '') {
    return { ok: false, reason: AUTH_REFUSAL.MALFORMED, detail: 'missing signature headers' };
  }
  if (Math.abs(now - ts) > CLOCK_SKEW_MS) {
    // Outside the window the request is either replayed or from a machine whose clock is wrong;
    // both are refused, and the window is named so the second case is diagnosable.
    return { ok: false, reason: AUTH_REFUSAL.CLOCK_SKEW, detail: `timestamp is ${Math.round((now - ts) / 1000)}s from now` };
  }

  const bodyHash = hashBody(body);
  // The body must hash to what was signed. Without this check the signature would authorise the
  // *route* while saying nothing about the payload.
  if (typeof claimedHash === 'string' && claimedHash !== '' && claimedHash !== bodyHash) {
    return { ok: false, reason: AUTH_REFUSAL.BAD_SIGNATURE, detail: 'the body does not match the signed hash' };
  }

  const canonical = canonicalRequest({ method, path, timestampMs: ts, nonce, bodyHash });
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
  } catch {
    return { ok: false, reason: AUTH_REFUSAL.MALFORMED };
  }
  if (!verifyWith(publicKeyPem, canonical, signatureBytes)) {
    return { ok: false, reason: AUTH_REFUSAL.BAD_SIGNATURE };
  }
  // Recorded only after the signature checks out, so an attacker cannot fill the replay table by
  // sending garbage nonces.
  if (typeof rememberNonce === 'function' && rememberNonce(nonce, ts) === false) {
    return { ok: false, reason: AUTH_REFUSAL.BAD_SIGNATURE, detail: 'this nonce was already used' };
  }
  return { ok: true, nonce, timestampMs: ts };
}

/** Constant-time string comparison, for tokens. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * A bounded replay window.
 *
 * Bounded on purpose: an unbounded set of seen nonces is a memory leak that a peer can drive, and
 * the timestamp window already rejects anything old enough to have fallen out.
 */
export function createReplayGuard({ windowMs = CLOCK_SKEW_MS, now = Date.now } = {}) {
  const seen = new Map();
  return function remember(nonce, timestampMs) {
    const current = now();
    for (const [key, at] of seen) {
      if (current - at > windowMs) seen.delete(key);
    }
    if (seen.has(nonce)) return false;
    seen.set(nonce, Number.isFinite(timestampMs) ? timestampMs : current);
    return true;
  };
}

/** Derive a relay's fleet signing key from a master secret, so one secret serves many fleets. */
export function deriveFleetKey(masterSecret, fleetId) {
  if (typeof masterSecret !== 'string' || masterSecret === '') throw new TypeError('deriveFleetKey needs a master secret');
  if (typeof fleetId !== 'string' || fleetId === '') throw new TypeError('deriveFleetKey needs a fleet id');
  return createHmac('sha256', masterSecret).update(`w2m-fleet-v1:${fleetId}`, 'utf8').digest();
}
