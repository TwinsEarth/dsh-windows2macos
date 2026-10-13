/**
 * Per-device Ed25519 request signing (v0.7.10).
 *
 * ## Why a second signing mechanism
 *
 * The relay already has request signing (`src/signing.mjs`), and it is **HMAC over a shared
 * secret**: everyone who can sign can also verify, so the relay holds a credential that every
 * device holds. That is fine for a fleet where one operator owns every machine and wrong for the
 * thing this workstream is about — proving that *this specific device* is a member of *this
 * account's* fleet. A shared secret proves only that the sender knows the secret, which is every
 * device.
 *
 * This module signs with a **device-held Ed25519 private key**, so the relay verifies with a public
 * key it stores and never holds anything that could impersonate the device.
 *
 * ## Compatibility with the existing mechanism, deliberately
 *
 * The signed bytes are **the relay's own canonical string**, reproduced here byte for byte:
 *
 *     v1\n<METHOD>\n<path>\n<timestamp>\n<nonce>\n<sha256(body) hex>
 *
 * Two reasons, and the second is the important one. Reusing the format means one verified string
 * rather than two that must be kept in step; and it means the relay can tell the two apart by
 * **whether the device has a public key**, without a protocol flag, a version negotiation, or a
 * second header that a client could forget to send.
 *
 * ## What this does not do yet
 *
 * The relay half — accept a public key at pairing, store it, and verify with it — is the next
 * step and is **not in this file**. A device that signs today is signing into a relay that does
 * not check it, which is precisely the "not enforced" state recorded in the release notes.
 */

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';

/** Matches `src/signing.mjs`: `v1=<hex>`, and Ed25519 signatures are hex too. */
export const SIGNATURE_VERSION = 'v1';

/** The same three header names the HMAC mechanism uses, so a relay reads one set. */
export const SIGNATURE_HEADER = 'x-w2m-signature';
export const TIMESTAMP_HEADER = 'x-w2m-timestamp';
export const NONCE_HEADER = 'x-w2m-nonce';

/**
 * The canonical string, byte-identical to the relay's.
 *
 * **Not reimplemented from the documentation — copied from the implementation**, because a
 * one-character difference produces a signature that verifies nowhere and gives no clue why. The
 * body is hashed with a zero-length HMAC key, which is `sha256` in all but name and is what the
 * relay does.
 */
export function canonicalString({ method, path, timestamp, nonce, body = '' }) {
  const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  /**
   * `createHmac` with a **zero-length key**, not `createHash`.
   *
   * This is the relay's exact call, and it is not the same thing as a plain sha256: HMAC wraps the
   * key with its own padding, so `createHash('sha256').update('').digest('hex')` is
   * `e3b0c442…` while `createHmac('sha256', Buffer.alloc(0)).update('').digest('hex')` is
   * `b613679a…`. A hash that differs by construction produces a signature that verifies nowhere
   * and gives no clue why.
   *
   * The probe that caught it signed three requests with both implementations and compared the
   * strings. That comparison is the only reason this is right, which is why it is a test.
   */
  const bodyHash = createHmac('sha256', Buffer.alloc(0)).update(bodyBytes).digest('hex');
  return [SIGNATURE_VERSION, String(method ?? '').toUpperCase(), String(path ?? ''), String(timestamp), String(nonce), bodyHash].join('\n');
}

/** The format the relay parses: `v1=<hex>`. */
export function formatSignature(hex) {
  return `${SIGNATURE_VERSION}=${hex}`;
}

/** Split `v1=<hex>` back into its parts, or null if it is not that shape. */
export function parseSignature(presented) {
  if (typeof presented !== 'string') return null;
  const match = /^([a-z0-9]+)=([0-9a-f]+)$/i.exec(presented.trim());
  if (match === null) return null;
  return { version: match[1].toLowerCase(), hex: match[2].toLowerCase() };
}

/**
 * Create a device signing key.
 *
 * @param {object} [options]
 * @param {string} [options.privateKeyPem] An existing key, so a restart keeps its identity.
 * @param {() => string} [options.makeNonce]
 */
export function createDeviceSigner(options = {}) {
  let privateKey;
  let generated = false;
  if (typeof options.privateKeyPem === 'string' && options.privateKeyPem !== '') {
    privateKey = createPrivateKey(options.privateKeyPem);
  } else {
    privateKey = generateKeyPairSync('ed25519').privateKey;
    generated = true;
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`the device signing key must be ed25519, not ${privateKey.asymmetricKeyType}`);
  }
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();

  return {
    generated,
    publicKeyPem,
    /** The private key, for persistence. Callers must write it 0600 and never log it. */
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),

    /**
     * Sign one request. Returns the three headers to send.
     *
     * `timestamp` is **Unix seconds**, matching the relay's `x-w2m-timestamp` contract — not
     * milliseconds. Sending milliseconds produces a timestamp the relay reads as far in the future
     * and refuses for skew, which looks like a clock problem and is not one.
     */
    signRequest({ method, path, body = '', timestamp = Math.floor(Date.now() / 1000), nonce = options.makeNonce?.() ?? defaultNonce() }) {
      const canonical = canonicalString({ method, path, timestamp, nonce, body });
      const hex = edSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
      return {
        headers: {
          [SIGNATURE_HEADER]: formatSignature(hex),
          [TIMESTAMP_HEADER]: String(timestamp),
          [NONCE_HEADER]: nonce,
        },
        canonical,
      };
    },
  };
}

/** 16 random bytes as hex, the same size `signing.mjs` uses. */
function defaultNonce() {
  return randomBytes(16).toString('hex');
}

/**
 * Verify one signed request against a device's public key.
 *
 * @param {object} input
 * @param {Record<string,string>} input.headers
 * @param {string} input.publicKeyPem
 * @param {string} input.method
 * @param {string} input.path
 * @param {string|Buffer} [input.body]
 * @param {number} [input.nowMs]
 * @param {number} [input.skewSeconds]
 * @param {(nonce: string, at: number) => boolean} [input.nonces]
 */
export function verifyDeviceSignature({
  headers,
  publicKeyPem,
  method,
  path,
  body = '',
  nowMs = Date.now(),
  skewSeconds = 120,
  nonces = null,
}) {
  const read = (name) => {
    if (typeof headers?.get === 'function') return headers.get(name);
    const found = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
    return found === undefined ? null : headers[found];
  };

  const presented = read(SIGNATURE_HEADER);
  const timestampRaw = read(TIMESTAMP_HEADER);
  const nonce = read(NONCE_HEADER);

  if (!presented || !timestampRaw || !nonce) {
    return { ok: false, code: 'SIGNATURE_INCOMPLETE', error: 'all three of signature, timestamp and nonce are required' };
  }
  const parsed = parseSignature(presented);
  if (parsed === null) return { ok: false, code: 'SIGNATURE_MALFORMED', error: 'the signature is not v1=<hex>' };
  if (parsed.version !== SIGNATURE_VERSION) {
    return { ok: false, code: 'SIGNATURE_VERSION', error: `signature version ${parsed.version} is not ${SIGNATURE_VERSION}` };
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isInteger(timestamp)) {
    return { ok: false, code: 'SIGNATURE_BAD_TIMESTAMP', error: 'x-w2m-timestamp must be whole unix seconds' };
  }
  if (typeof nonce !== 'string' || nonce.length < 8) {
    return { ok: false, code: 'SIGNATURE_BAD_NONCE', error: 'x-w2m-nonce must be at least 8 characters' };
  }
  // Skew is checked **before** the signature, so a captured request replayed much later is refused
  // for the cheap reason rather than spending a verification on it.
  const skew = Math.abs(nowMs / 1000 - timestamp);
  if (skew > skewSeconds) {
    return { ok: false, code: 'SIGNATURE_SKEW', error: `timestamp is ${Math.round(skew)}s from now, beyond ${skewSeconds}s` };
  }

  const canonical = canonicalString({ method, path, timestamp, nonce, body });
  let verified = false;
  try {
    verified = edVerify(null, Buffer.from(canonical, 'utf8'), createPublicKey(publicKeyPem), Buffer.from(parsed.hex, 'hex'));
  } catch {
    // An unparseable key or a malformed hex signature is a failed verification, not a crash: this
    // runs on the relay's hot path and an exception there is a denial-of-service shape.
    return { ok: false, code: 'SIGNATURE_BAD', error: 'the signature did not verify with this device key' };
  }
  if (!verified) return { ok: false, code: 'SIGNATURE_BAD', error: 'the signature did not verify with this device key' };

  // Recorded only after the signature checks out, so an attacker cannot fill the replay table with
  // garbage nonces.
  if (typeof nonces === 'function' && nonces(nonce, nowMs) === false) {
    return { ok: false, code: 'SIGNATURE_REPLAY', error: 'this nonce was already used' };
  }
  return { ok: true, signed: true, keyIndex: null, device: true };
}
