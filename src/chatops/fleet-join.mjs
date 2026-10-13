/**
 * Joining a fleet by account, with no human copying a code (v0.8.1).
 *
 * ## The bug this fixes
 *
 * A new machine signed into the same DeepSeek account did **not** join the same fleet. The plugin
 * computed its SN, derived `fleet` from the account code, logged it — and then never used it for
 * anything. Membership still required a one-time pairing code typed by a human, so a second machine
 * on the same account was invisible to the fleet.
 *
 * ## Why the account code could not simply be used as the credential
 *
 * `accountCode` is `sha256(userId)` truncated to **8 hex characters — 32 bits**. The module that
 * defines it documents the trade honestly ("the cost of 32 bits, stated rather than hidden"), and
 * for its purpose — grouping and display — the cost is fine.
 *
 * As a **credential** it is not fine: 2^32 is brute-forceable, so treating it as the thing that
 * authorises joining would let anyone enumerate their way into any fleet. The bug was a
 * conflation: a *grouping identifier* was doing duty as a *secret*.
 *
 * ## What actually works
 *
 * The machines of one account share something an outsider cannot obtain: the ability to **read
 * `userId`** from the signed-in account. So the fleet secret is derived from it:
 *
 * ```
 * fleetKey = HMAC-SHA256(userId, "w2m-fleet-v1")     256 bits, only same-account machines can compute
 * fleetId  = SHA-256(fleetKey)                       what the relay groups by
 * ```
 *
 * ## Why the relay needs to know nothing about accounts
 *
 * This is the property that makes the design simple: **presenting the key *is* the proof.** The
 * relay derives `fleetId` from the key it is given, so a device can only ever land in the fleet
 * whose key it holds. There is no trust-on-first-use to get wrong, no operator configuration, no
 * account lookup, and nothing to forge — a device that does not know the key simply forms a
 * different, empty fleet rather than joining somebody else's.
 *
 * It also means the wire carries a **derived** value rather than `userId`, so a relay (or anyone
 * reading its state) learns a fleet's identity without learning the account's.
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/** The derivation label. Changing it changes every fleet id, so it is versioned. */
export const FLEET_KEY_LABEL = 'w2m-fleet-v1';

/** `userId` is a UUID; anything shorter is not one, and deriving from it would weaken the key. */
export const MIN_ACCOUNT_MATERIAL = 16;

/**
 * Derive the fleet key for an account.
 *
 * @param {string} userId The raw account id from the signed-in account, **not** the account code.
 * @returns {Buffer} 32 bytes.
 */
export function deriveAccountFleetKey(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new TypeError('deriveAccountFleetKey needs the account userId; the 32-bit account code is not a secret and will not do');
  }
  const material = userId.trim();
  if (material.length < MIN_ACCOUNT_MATERIAL) {
    /**
     * Refused rather than accepted-and-weakened.
     *
     * A short value here is almost always the account *code* being passed by mistake, and deriving
     * from 32 bits would produce a key that looks strong and is not — the failure would be silent,
     * which is the worst kind for a credential.
     */
    throw new TypeError(
      `the account material is ${material.length} characters, which is too short to derive a fleet key from. `
      + 'This is usually the 8-hex account code rather than the account userId.',
    );
  }
  return createHmac('sha256', material).update(FLEET_KEY_LABEL, 'utf8').digest();
}

/** The key as it travels: base64url, so it survives a header, a JSON string and a URL. */
export function encodeFleetKey(key) {
  return Buffer.from(key).toString('base64url');
}

/** Parse a transported key back to bytes. Returns null rather than throwing, for a network path. */
export function decodeFleetKey(encoded) {
  if (typeof encoded !== 'string' || encoded === '') return null;
  try {
    const buf = Buffer.from(encoded, 'base64url');
    // A key is exactly 32 bytes; anything else is not one, and accepting a short buffer would
    // silently weaken every comparison that follows.
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * The id the relay groups by.
 *
 * Derived from the key rather than sent alongside it, so the two can never disagree — and so a
 * device cannot claim a fleet id it does not hold the key for.
 */
export function fleetIdFromKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('fleetIdFromKey needs a 32-byte key');
  return createHash('sha256').update(key).digest('hex');
}

/**
 * The relay-side check: does this key belong to the fleet it claims?
 *
 * Constant-time, because a comparison that leaks timing on a secret is a comparison that can be
 * walked one byte at a time.
 */
export function fleetKeyMatches(expectedKey, presentedKey) {
  if (!Buffer.isBuffer(expectedKey) || !Buffer.isBuffer(presentedKey)) return false;
  if (expectedKey.length !== presentedKey.length) return false;
  return timingSafeEqual(expectedKey, presentedKey);
}

/**
 * Whether a fleet key is well-formed, for a relay that is about to store one.
 *
 * Deliberately shape-only: the relay has no way to know whether a key corresponds to a real
 * account, and pretending otherwise would be a check that cannot fail honestly. What it *can* check
 * is that the key is the right size, which is what stops a truncated or empty value becoming a
 * fleet's identity.
 */
export function isWellFormedFleetKey(encoded) {
  return decodeFleetKey(encoded) !== null;
}

/**
 * The whole join decision, in one function, so the client and the relay cannot disagree.
 *
 * @param {object} input
 * @param {string} input.userId The signed-in account id, when the caller is a client.
 * @param {string} input.fleetKeyEncoded A key presented on the wire, when the caller is a relay.
 * @returns {{ok: true, fleetId: string, fleetKey: string}
 *          | {ok: false, reason: string, text: string}}
 */
export function planJoin({ userId = null, fleetKeyEncoded = null } = {}) {
  if (typeof fleetKeyEncoded === 'string' && fleetKeyEncoded !== '') {
    const key = decodeFleetKey(fleetKeyEncoded);
    if (key === null) {
      return { ok: false, reason: 'malformed_fleet_key', text: '这个舰队密钥格式不对（应为 32 字节的 base64url）。' };
    }
    return { ok: true, fleetId: fleetIdFromKey(key), fleetKey: encodeFleetKey(key) };
  }

  if (typeof userId === 'string' && userId.trim() !== '') {
    let key;
    try {
      key = deriveAccountFleetKey(userId);
    } catch (error) {
      return { ok: false, reason: 'bad_account_material', text: error.message };
    }
    return { ok: true, fleetId: fleetIdFromKey(key), fleetKey: encodeFleetKey(key) };
  }

  return {
    ok: false,
    reason: 'no_identity',
    text: '既没有已登录的账号，也没有舰队密钥，无法确定属于哪条舰队。',
  };
}
