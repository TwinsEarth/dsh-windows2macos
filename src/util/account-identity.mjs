/**
 * The account's own signing key.
 *
 * ## Why this exists
 *
 * A fleet key is a **symmetric** secret: it proves "this machine is allowed into the fleet derived from this account",
 * and it is the only account material the system had. That is enough for the old joining path and not enough for the
 * new one -- a machine that failed to pair must *prove the account* to a relay that has never met it, and proof of that
 * kind is a signature.
 *
 * So the account gains an asymmetric identity. It is DERIVED, not generated: the same account material yields the same
 * keypair on every machine, which is what makes "zero configuration" possible at all -- a fresh install can sign with
 * an identity nobody had to copy onto it. The matching public key is registered with the relay when the account's first
 * machine pairs (see the relay's account-key registry), and later machines are verified against it.
 *
 * ## Ed25519 from a seed, without a new dependency
 *
 * Node can import an Ed25519 private key from PKCS#8 DER, and PKCS#8 for Ed25519 is a fixed 16-byte prefix followed by
 * the 32-byte seed. That is the whole construction; no library, and the output is the standard RFC 8032 key, so any
 * other verifier accepts it.
 *
 * The derivation domain-separates with a label, so a seed reused elsewhere cannot accidentally produce this key.
 */
import { createHash, createPrivateKey, createPublicKey, sign as signWith, verify as verifyWith } from 'node:crypto';

/** PKCS#8 prefix for Ed25519: OID 1.3.101.112 inside a OneAsymmetricKey with the seed as the private key. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** Domain separation: this key exists only for fleet joining. */
const LABEL = 'w2m-account-identity-v1';

/**
 * @param {string|Buffer} accountMaterial the account's stable material (never sent anywhere by this function)
 * @returns {{privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject,
 *            publicKeyPem: string, fingerprint: string}}
 */
export function deriveAccountKeypair(accountMaterial) {
  if (typeof accountMaterial !== 'string' && !Buffer.isBuffer(accountMaterial)) {
    throw new TypeError('accountMaterial must be a string or a Buffer');
  }
  const material = Buffer.isBuffer(accountMaterial) ? accountMaterial : Buffer.from(accountMaterial, 'utf8');
  if (material.length === 0) throw new TypeError('accountMaterial must not be empty');
  // Derive a 32-byte seed; the label is part of the input so this cannot collide with another use of the same material.
  const seed = createHash('sha256').update(LABEL).update(Buffer.from([0x00])).update(material).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    // The fingerprint IS the public key, identified by hash: a relay can verify a signature against the key it holds
    // and check that the hash matches, with no registration of the account anywhere.
    fingerprint: createHash('sha256').update(publicKeyDer).digest('hex'),
  };
}

/** Sign the challenge payload. The relay verifies; nothing here decides policy. */
export function signChallenge(identity, payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  return signWith(null, data, identity.privateKey).toString('base64');
}

/** Verify a signature against a PEM public key. Returns a boolean: a thrown error here would be a 500 for a bad login. */
export function verifyChallenge(publicKeyPem, payload, signatureBase64) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  try {
    return verifyWith(null, data, createPublicKey(publicKeyPem), Buffer.from(String(signatureBase64), 'base64'));
  } catch {
    return false;
  }
}
