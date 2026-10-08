/**
 * Request signing for the W2M relay link (v0.3.0 §9).
 *
 * ## What this defends against, and what it does not
 *
 * A bearer token is a bearer token: anyone who can read it once can replay it. Over a link that
 * crosses the public internet — which is the whole point of v0.1.2 onward — three concrete things
 * become reachable that a private LAN made theoretical:
 *
 *   1. **Replay.** A captured `POST /v1/task` re-sent later dispatches the same work again. The
 *      idempotency key makes a *duplicate* harmless, but a replay with a fresh task id is a new task.
 *   2. **Tampering by a middlebox.** Anything that terminates the connection can rewrite a body. TLS
 *      prevents this where TLS exists; the Tailscale and tunnel deployments are exactly where it may
 *      not be end-to-end.
 *   3. **A leaked log.** A signature that covers the body plus a monotonic timestamp turns "we have
 *      your token" into "you have at most one window to use it".
 *
 * It is deliberately **not** end-to-end encryption and not a replacement for TLS. The body is still
 * readable by anyone who can see the bytes; this proves *who sent it* and *that it is unchanged*,
 * and it bounds replay. Saying otherwise would be the kind of security claim that gets people hurt.
 *
 * ## Why a shared secret and not asymmetric keys
 *
 * Every machine already holds a per-device bearer token issued at pairing, and the relay already
 * holds a copy. Deriving the signing key from that means **no new secret to distribute, store or
 * rotate separately** — the existing pairing ceremony is the whole key exchange. The cost is that
 * the relay can forge a device's signature, which is acceptable here because the relay is already
 * trusted to route that device's work.
 *
 * ## Wire format
 *
 * ```
 * X-W2M-Signature: v1=<hex hmac>
 * X-W2M-Timestamp: <unix seconds>
 * X-W2M-Nonce:     <opaque, 16+ chars>
 * ```
 *
 * The signed string is newline-separated and covers the method, path, timestamp, nonce and the exact
 * body bytes, so a signature cannot be moved to another endpoint, another method, another moment, or
 * another payload.
 *
 * ## Compatibility
 *
 * Signing is **optional on both sides**. An unsigned request is accepted exactly as before, so a
 * v0.2.3 machine keeps working against a v0.3.0 relay and vice versa. What changes is that a relay
 * with a secret configured can *require* signatures; that is opt-in, and the failure is loud.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Header carrying the signature. */
export const SIGNATURE_HEADER = 'x-w2m-signature';

/** Header carrying the signing timestamp, in whole seconds. */
export const TIMESTAMP_HEADER = 'x-w2m-timestamp';

/** Header carrying the replay nonce. */
export const NONCE_HEADER = 'x-w2m-nonce';

/** Signature format version, so the scheme can change without ambiguity. */
export const SIGNATURE_VERSION = 'v1';

/**
 * Accepted skew between the signer's clock and the verifier's, in seconds.
 *
 * Two minutes is chosen against the constraint that matters here: the machines may sit in different
 * time zones and one of them may be behind a tunnelled, jittery link. A window tighter than the
 * worst observed clock drift produces intermittent authentication failures, which people then
 * "fix" by turning signing off — the outcome this module exists to prevent. Nothing in the protocol
 * needs a tighter bound, because the nonce cache is what actually stops replay.
 */
export const DEFAULT_SKEW_SECONDS = 120;

/** Errors carry a code so a caller can distinguish "unsigned" from "forged". */
export class SignatureError extends Error {
  /**
   * @param {string} code - Machine-readable reason.
   * @param {string} message - Human-readable explanation.
   * @param {object} [detail] - Extra context for a log.
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SignatureError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Normalize a secret into a key buffer.
 *
 * Rejects anything that is not a non-empty string: a `undefined` secret silently disabling signing
 * is the failure mode this whole module is written to avoid, so callers get an error instead.
 *
 * @param {unknown} secret - Shared secret.
 * @returns {Buffer} Key material.
 * @throws {SignatureError} `BAD_SECRET` when the secret is unusable.
 */
export function normalizeSecret(secret) {
  if (typeof secret !== 'string') {
    throw new SignatureError('BAD_SECRET', `signing secret must be a string, got ${typeof secret}`);
  }
  if (secret.length === 0) {
    throw new SignatureError('BAD_SECRET', 'signing secret must not be empty');
  }
  return Buffer.from(secret, 'utf8');
}

/**
 * Build the canonical string that gets signed.
 *
 * Exported because a signature bug is nearly impossible to find from the outside: both sides must
 * agree byte-for-byte, and a test that can print this is worth more than a test that only asserts
 * "it failed".
 *
 * @param {object} input - Request facts.
 * @param {string} input.method - HTTP method, any case.
 * @param {string} input.path - Request path *including* the query string, if any.
 * @param {number} input.timestamp - Unix seconds.
 * @param {string} input.nonce - Replay nonce.
 * @param {string|Buffer} [input.body] - Exact body bytes; empty for no body.
 * @returns {string} The canonical string.
 */
export function canonicalString({ method, path, timestamp, nonce, body = '' }) {
  const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  // The body is hashed rather than embedded so the canonical form stays small and log-safe; the
  // hash still binds every byte, which is the property that matters.
  const bodyHash = createHmac('sha256', Buffer.alloc(0)).update(bodyBytes).digest('hex');
  return [
    SIGNATURE_VERSION,
    String(method ?? '').toUpperCase(),
    String(path ?? ''),
    String(timestamp),
    String(nonce),
    bodyHash,
  ].join('\n');
}

/**
 * Compute a signature.
 *
 * @param {object} input - Signing input plus `secret`.
 * @param {string} input.secret - Shared secret.
 * @param {string} input.method - HTTP method.
 * @param {string} input.path - Path including query.
 * @param {number} input.timestamp - Unix seconds.
 * @param {string} input.nonce - Replay nonce.
 * @param {string|Buffer} [input.body] - Exact body bytes.
 * @returns {string} `v1=<hex>`.
 */
export function signRequest({ secret, method, path, timestamp, nonce, body = '' }) {
  const key = normalizeSecret(secret);
  const canonical = canonicalString({ method, path, timestamp, nonce, body });
  const mac = createHmac('sha256', key).update(canonical).digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

/**
 * Create an independent signer bound to one secret.
 *
 * The returned `headers()` is what a client calls per request. Keeping the nonce generator injectable
 * is what makes replay tests deterministic instead of flaky.
 *
 * @param {object} input - Signer options.
 * @param {string} input.secret - Shared secret.
 * @param {() => number} [input.now] - Clock in *milliseconds*; defaults to `Date.now`.
 * @param {() => string} [input.makeNonce] - Nonce source.
 * @returns {{headers: (req: {method: string, path: string, body?: string|Buffer}) => Record<string,string>}}
 */
export function createSigner({ secret, now = Date.now, makeNonce = () => randomBytes(16).toString('hex') }) {
  normalizeSecret(secret);
  return {
    headers({ method, path, body = '' }) {
      const timestamp = Math.floor(now() / 1000);
      const nonce = makeNonce();
      return {
        [SIGNATURE_HEADER]: signRequest({ secret, method, path, timestamp, nonce, body }),
        [TIMESTAMP_HEADER]: String(timestamp),
        [NONCE_HEADER]: nonce,
      };
    },
  };
}

/**
 * Bounded nonce cache that refuses a nonce it has already accepted.
 *
 * Replay defence has to be *stateful*, or a captured request is valid for the whole skew window --
 * which would make the window the actual security boundary and the timestamp decorative. The cache
 * is bounded so a long-running relay cannot be grown into memory exhaustion by a flood of requests,
 * and it evicts oldest-first because the oldest entries are the ones about to fall outside the skew
 * window anyway.
 */
export class NonceCache {
  /**
   * @param {object} [options] - Cache options.
   * @param {number} [options.max] - Maximum retained nonces.
   * @param {number} [options.retentionMs] - How long a nonce is remembered.
   */
  constructor({ max = 20_000, retentionMs = 10 * 60_000 } = {}) {
    /** @type {Map<string, number>} nonce -> accepted-at milliseconds */
    this.seen = new Map();
    this.max = max;
    this.retentionMs = retentionMs;
  }

  /**
   * Record a nonce, reporting whether it had already been used.
   *
   * @param {string} nonce - The nonce.
   * @param {number} nowMs - Current time in milliseconds.
   * @returns {boolean} True when this nonce is new, false when it is a replay.
   */
  accept(nonce, nowMs) {
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowMs);
    // Expire by age first, then by count. Age alone is not enough: a flood inside the retention
    // window would grow the map without bound, which is a memory-exhaustion vector.
    this.prune(this.retentionMs, nowMs);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    return true;
  }

  /**
   * Drop entries older than `olderThanMs`, relying on insertion order being chronological.
   *
   * @param {number} olderThanMs - Age beyond which a nonce is forgotten.
   * @param {number} nowMs - Current time in milliseconds.
   */
  prune(olderThanMs, nowMs) {
    for (const [nonce, at] of this.seen) {
      if (nowMs - at > olderThanMs) this.seen.delete(nonce);
      else break; // insertion order is chronological
    }
  }

  /** Current size, for diagnostics. */
  get size() {
    return this.seen.size;
  }
}

/**
 * Verify a signed request.
 *
 * Returns a decision rather than throwing, because the caller needs to log *why* and because a
 * rejection here is an expected event on a public link, not a programming error. It throws only for
 * a caller mistake (an unusable key list).
 *
 * @param {object} input - Verification input.
 * @param {Headers|Record<string,string>} input.headers - Incoming headers, case-insensitively read.
 * @param {string} input.method - HTTP method.
 * @param {string} input.path - Path including query.
 * @param {string|Buffer} [input.body] - Exact received body bytes.
 * @param {string|string[]} input.secrets - Accepted secrets, newest first (rotation support).
 * @param {NonceCache} input.nonces - Replay cache.
 * @param {number} [input.nowMs] - Current time in milliseconds.
 * @param {number} [input.skewSeconds] - Accepted clock skew.
 * @param {boolean} [input.required] - When true, an unsigned request is rejected.
 * @returns {{ok: true, signed: boolean, keyIndex: number|null}|{ok: false, code: string, error: string}}
 */
export function verifyRequest({
  headers,
  method,
  path,
  body = '',
  secrets,
  nonces,
  nowMs = Date.now(),
  skewSeconds = DEFAULT_SKEW_SECONDS,
  required = false,
}) {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (s) => typeof s === 'string' && s.length > 0,
  );
  if (list.length === 0) {
    // No configured secret means this relay cannot verify anything. If it also requires signatures,
    // that is a configuration error on the relay, and it must not be reported as a client failure.
    if (required) {
      return { ok: false, code: 'SIGNING_NOT_CONFIGURED', error: 'signatures are required but no signing secret is configured' };
    }
    return { ok: true, signed: false, keyIndex: null };
  }

  const read = (name) => {
    if (typeof headers?.get === 'function') return headers.get(name);
    const found = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
    return found === undefined ? null : headers[found];
  };

  const presented = read(SIGNATURE_HEADER);
  const timestampRaw = read(TIMESTAMP_HEADER);
  const nonce = read(NONCE_HEADER);

  if (!presented && !timestampRaw && !nonce) {
    // Unsigned but structurally fine: this is the v0.2.3 client, and it keeps working unless the
    // relay was explicitly told to insist.
    if (required) {
      return { ok: false, code: 'SIGNATURE_REQUIRED', error: 'this relay requires a signed request' };
    }
    return { ok: true, signed: false, keyIndex: null };
  }
  if (!presented || !timestampRaw || !nonce) {
    // A partially-signed request is never a legitimate client: it is either a broken proxy or an
    // attacker probing which header is checked. Refuse rather than fall back to "unsigned".
    return {
      ok: false,
      code: 'SIGNATURE_INCOMPLETE',
      error: `a signed request must carry all of ${SIGNATURE_HEADER}, ${TIMESTAMP_HEADER} and ${NONCE_HEADER}`,
    };
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, code: 'SIGNATURE_BAD_TIMESTAMP', error: `timestamp is not a number: ${JSON.stringify(timestampRaw)}` };
  }
  const skew = Math.abs(Math.floor(nowMs / 1000) - timestamp);
  if (skew > skewSeconds) {
    // Clock skew and replay look the same here; the message says which bound was exceeded so an
    // operator can tell a drifting clock from an attack.
    return {
      ok: false,
      code: 'SIGNATURE_EXPIRED',
      error: `timestamp is ${skew}s from local time, outside the ±${skewSeconds}s window`,
    };
  }
  if (nonce.length < 8) {
    return { ok: false, code: 'SIGNATURE_BAD_NONCE', error: 'nonce is too short to be unique' };
  }

  // Check the nonce *after* the cheap structural checks but before the HMAC compare, and only claim
  // it once a signature has actually matched -- otherwise an attacker could burn nonces to make a
  // legitimate request look like a replay.
  const expected = list.map((secret) =>
    signRequest({ secret, method, path, timestamp, nonce, body }),
  );
  let matchedIndex = -1;
  for (let i = 0; i < expected.length; i += 1) {
    const a = Buffer.from(expected[i], 'utf8');
    const b = Buffer.from(String(presented), 'utf8');
    // timingSafeEqual throws on a length mismatch, which would leak length as an oracle; guard first.
    if (a.length === b.length && timingSafeEqual(a, b)) {
      matchedIndex = i;
      break;
    }
  }
  if (matchedIndex === -1) {
    return { ok: false, code: 'SIGNATURE_MISMATCH', error: 'signature does not match any configured secret' };
  }

  if (!nonces.accept(nonce, nowMs)) {
    return { ok: false, code: 'SIGNATURE_REPLAY', error: 'this nonce has already been used' };
  }
  return { ok: true, signed: true, keyIndex: matchedIndex };
}
