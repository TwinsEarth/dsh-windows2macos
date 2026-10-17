/**
 * The exchange that lets an UNPAIRED machine prove an account it cannot authenticate as a device.
 *
 * ## The shape
 *
 *   1. the machine asks for a challenge, naming the account fingerprint;
 *   2. the relay answers with a one-time nonce and an expiry;
 *   3. the machine signs \`challenge|nonce|fingerprint|machine_id\` with the account's derived private key;
 *   4. the relay verifies with the public key registered when that account's first machine paired.
 *
 * ## The three properties, and why each is a test
 *
 * - **One-time.** A challenge is consumed by the first attempt, success or failure, because a retryable nonce is a replay
 *   window. Consuming on failure means an attacker who guessed wrong must fetch a new challenge -- which is rate limited.
 * - **Expiring.** Five minutes, on the relay's clock. A nonce that lives for ever is a signature that can be reused at
 *   leisure.
 * - **Rate limited per fingerprint.** Not per address: the thing being protected is a fingerprint, and an attacker with
 *   many addresses must not get many guesses.
 *
 * The signature payload binds the machine_id as well as the fingerprint: a valid signature harvested for one machine must
 * not admit another.
 */
import { createHash, randomBytes } from 'node:crypto';
import { verifyChallenge } from '../util/account-identity.mjs';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_PER_MINUTE = 5;

/**
 * @param {{now?: () => number, ttlMs?: number, maxPerMinute?: number,
 *          publicKeyFor: (fingerprint: string) => (string|null)}} options
 */
export function createJoinChallenges(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isInteger(options.ttlMs) ? options.ttlMs : CHALLENGE_TTL_MS;
  const maxPerMinute = Number.isInteger(options.maxPerMinute) ? options.maxPerMinute : CHALLENGE_MAX_PER_MINUTE;
  const publicKeyFor = typeof options.publicKeyFor === 'function' ? options.publicKeyFor : () => null;

  /** challenge_id -> { fingerprint, nonce, expires_at_ms } */
  const open = new Map();
  /** fingerprint -> [issue times] */
  const issued = new Map();

  const prune = () => {
    const t = now();
    for (const [id, c] of open) if (c.expires_at_ms <= t) open.delete(id);
  };

  /** The exact bytes signed. Exported so the client and the tests cannot drift from the relay. */
  const signingPayload = (challenge) => [challenge.challenge_id, challenge.nonce, challenge.fingerprint, challenge.machine_id].join('|');

  function issue(fingerprint, machineId = '') {
    if (typeof fingerprint !== 'string' || fingerprint === '') return { ok: false, code: 'BAD_FINGERPRINT' };
    if (publicKeyFor(fingerprint) === null) return { ok: false, code: 'FINGERPRINT_UNREGISTERED' };
    prune();
    const recent = (issued.get(fingerprint) ?? []).filter((at) => now() - at < 60_000);
    if (recent.length >= maxPerMinute) { issued.set(fingerprint, recent); return { ok: false, code: 'RATE_LIMITED' }; }
    recent.push(now());
    issued.set(fingerprint, recent);
    const challenge_id = createHash('sha256').update(fingerprint).update(String(randomBytes(16).toString('hex'))).update(String(now())).digest('hex').slice(0, 32);
    const challenge = {
      challenge_id, nonce: randomBytes(16).toString('hex'), fingerprint,
      machine_id: typeof machineId === 'string' ? machineId : '', expires_at_ms: now() + ttlMs,
    };
    open.set(challenge_id, challenge);
    return { ok: true, challenge_id, nonce: challenge.nonce, expires_at_ms: challenge.expires_at_ms };
  }

  /**
   * Verify a signed challenge. Consumes the challenge on ANY attempt.
   *
   * @param {{challenge_id: string, machine_id: string, signature: string}} request
   * @returns {{ok: true, fingerprint: string} | {ok: false, code: string}}
   */
  function consume(request) {
    prune();
    const challenge = open.get(request?.challenge_id);
    if (challenge === undefined) return { ok: false, code: 'CHALLENGE_INVALID' };
    open.delete(challenge.challenge_id);   // one attempt, success or not
    if (challenge.expires_at_ms <= now()) return { ok: false, code: 'CHALLENGE_EXPIRED' };
    if (typeof request.machine_id !== 'string' || request.machine_id === '') return { ok: false, code: 'BAD_REQUEST' };
    // The machine that signs must be the machine that asked: issuing for one id and signing for another is a forgery.
    if (challenge.machine_id !== '' && challenge.machine_id !== request.machine_id) return { ok: false, code: 'MACHINE_MISMATCH' };
    const pem = publicKeyFor(challenge.fingerprint);
    if (pem === null) return { ok: false, code: 'FINGERPRINT_UNREGISTERED' };
    const payload = signingPayload({ ...challenge, machine_id: request.machine_id });
    if (verifyChallenge(pem, payload, request.signature) !== true) return { ok: false, code: 'SIGNATURE_INVALID' };
    return { ok: true, fingerprint: challenge.fingerprint };
  }

  return { issue, consume, signingPayload, _open: open };
}
