/**
 * Backup cryptography: the data-encryption key, its envelopes, and the authenticated blocks.
 *
 * ## The shape, and why it is two layers rather than one
 *
 * A backup is encrypted with **one random 32-byte data encryption key (DEK)**. The DEK is never derived from
 * a password: passwords change, and a repository encrypted directly with a password-derived key becomes
 * unreadable the day the user changes it. Instead the DEK is *wrapped* -- sealed under a key derived from
 * each available credential -- and the wrapped copies travel with the snapshot (`keys.json`).
 *
 * Three envelope kinds, in the order they are tried:
 *
 *   * `account` -- a KEK derived from the account **identifier** the host reports. This is an identity
 *     binding, not a secret: anyone who knows the account id and has the repository files can derive the same
 *     KEK. The user accepted that trade-off explicitly (docs/BACKUP-DESIGN.md §25); it is a convenience path
 *     that makes "same account, new machine" unlockable without a password, and it never replaces `password`.
 *   * `machine` -- a random key protected by the OS keystore (DPAPI on Windows), so restoring on the same
 *     machine needs no password;
 *   * `password` -- scrypt(password, salt). The only kind that survives a machine change, and therefore the
 *     only one that must always be available.
 *
 * The first two are conveniences; the password envelope is the guarantee. Losing every envelope is losing the
 * backup, which is why `selftest` exercises a full wrap/unwrap round trip before a repository is created.
 *
 * ## What is authenticated, and what a failure means
 *
 * AES-256-GCM authenticates ciphertext *and* an additional-authentication-data (AAD) string that names the
 * container, version, envelope kind and KDF parameters. So an attacker cannot move a password envelope into
 * the `account` slot, lower the scrypt cost, or swap two objects between files: every one of those changes
 * the AAD or the tag and is reported as `BACKUP_KEY_UNWRAP_FAILED` / `BACKUP_DECRYPT_AUTH_FAILED`.
 *
 * **GCM cannot distinguish "wrong key" from "tampered ciphertext".** Both produce one authentication failure,
 * and this module deliberately does not pretend otherwise: there is no code that says "your password is
 * wrong" when the bytes may have been altered. The message says both possibilities, and the UI is expected to
 * do the same -- claiming a wrong password when the file is corrupt sends the user down the wrong path
 * (which is exactly the class of mistake the 2026-11-17 session-recovery drill made four times).
 *
 * ## Parameters are recorded, never assumed
 *
 * Every envelope carries its own `kdf` record (algorithm, cost, salt), so raising scrypt's cost later does not
 * orphan old repositories. A reader accepts what is recorded, bounded above so a hostile file cannot make a
 * restore allocate gigabytes (`BACKUP_KDF_UNSUPPORTED`), and refuses to *create* anything below the floor
 * (`BACKUP_KDF_WEAK`).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/** Format string of a wrapped-key file (`keys.json`). */
export const ENVELOPE_FORMAT = 'w2m-session-backup/keys';

/** Version of the wrapped-key file. */
export const ENVELOPE_VERSION = 1;

/** AEAD algorithm. AES-256-GCM is the only one v1 writes or reads. */
export const AEAD = 'aes-256-gcm';

/** DEK length in bytes. */
export const DEK_LENGTH = 32;

/** GCM nonce length in bytes. 12 is the only length GCM handles without re-hashing. */
export const NONCE_LENGTH = 12;

/** GCM tag length in bytes. */
export const TAG_LENGTH = 16;

/** Salt length in bytes for every KDF. */
export const SALT_LENGTH = 16;

/** Magic bytes at the start of an encrypted block object (`objects/<aa>/<hash>`). */
export const OBJECT_MAGIC = Buffer.from('W2MBLOB1', 'ascii');

/**
 * AAD container name of a sealed **whole-file copy**: `old/<ws>/<sid>/<ts>-<sha12>.json.enc`.
 *
 * A deduplicated block is bound to `w2m-session-backup/object|<sha256>|<length>`; a whole-file copy is bound to
 * `w2m-session-backup/old|<sha256>|<length>` (`rotation.mjs`'s `oldFormat: 'full'`). The two namespaces are
 * deliberately disjoint -- a copy cannot be swapped in where a block object is expected (or the reverse),
 * because the AAD differs and GCM authentication fails. Pass it as `identity.kind`; block objects omit `kind`
 * and keep the AAD they have always had, so this is purely additive.
 */
export const OLD_COPY_KIND = 'old';

/** Envelope kinds, in the order `unwrapDek` tries them. */
export const ENVELOPE_KINDS = Object.freeze(['account', 'machine', 'password']);

/**
 * Default scrypt parameters for a new password envelope.
 *
 * N=2^17 / r=8 / p=1: measured at 461 ms on the reference machine (`docs/SPIKE-ACCOUNT-KEK.md` §5.5 measured
 * 2^14=56 ms, 2^15=111 ms, 2^16=227 ms, 2^17=461 ms), which leaves ~2.2x headroom under the one-second budget a
 * user will accept for an unlock prompt. Memory is 128 MiB per derivation. The parameters travel with every
 * envelope, so raising this later does not orphan existing repositories.
 */
export const DEFAULT_SCRYPT = Object.freeze({ algo: 'scrypt', N: 1 << 17, r: 8, p: 1, keylen: DEK_LENGTH });

/** The weakest scrypt this module will *create*. Reading accepts what a file records, within bounds. */
export const MIN_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });

/** Upper bound accepted from a file, so a hostile manifest cannot demand an unbounded allocation. */
export const MAX_SCRYPT_N = 1 << 20;

/** Named crypto failure codes. */
export const CRYPTO_CODES = Object.freeze({
  KEY_INVALID: 'BACKUP_KEY_INVALID',
  KDF_UNSUPPORTED: 'BACKUP_KDF_UNSUPPORTED',
  KDF_WEAK: 'BACKUP_KDF_WEAK',
  KDF_FAILED: 'BACKUP_KDF_FAILED',
  ENVELOPE_MALFORMED: 'BACKUP_ENVELOPE_MALFORMED',
  KEY_UNWRAP_FAILED: 'BACKUP_KEY_UNWRAP_FAILED',
  DECRYPT_AUTH_FAILED: 'BACKUP_DECRYPT_AUTH_FAILED',
  PASSWORD_EMPTY: 'BACKUP_PASSWORD_EMPTY',
  DEK_INVALID: 'BACKUP_DEK_INVALID',
  SELFTEST_FAILED: 'BACKUP_SELFTEST_FAILED',
});

/** Human wording for the ambiguous authentication failure, shared by CLI and routes. */
export const AUTH_FAILED_MESSAGE =
  'authentication failed: the credential is wrong, or the file has been altered (GCM cannot tell which)';

/** A crypto failure with a stable code. */
export class BackupCryptoError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'BackupCryptoError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }

  toRefusal() {
    return { ok: false, reason_code: this.code, detail: this.detail };
  }
}

/** A fresh random DEK. */
export function randomDek() {
  return randomBytes(DEK_LENGTH);
}

/** A fresh random salt. */
export function randomSalt() {
  return randomBytes(SALT_LENGTH);
}

/** True for a Buffer of exactly the DEK length. */
export function isDek(value) {
  return Buffer.isBuffer(value) && value.length === DEK_LENGTH;
}

/** Normalise a credential given as a string or Buffer. Strings are UTF-8 and measured in bytes, not chars. */
function toBytes(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  if (typeof secret === 'string') return Buffer.from(secret, 'utf8');
  return null;
}

/** Reject an empty credential loudly: an empty password is not a password. */
function requireSecret(secret, what) {
  const bytes = toBytes(secret);
  if (bytes === null) throw new BackupCryptoError(CRYPTO_CODES.KEY_INVALID, `${what} must be a string or a Buffer`);
  if (bytes.length === 0) {
    throw new BackupCryptoError(
      what === 'password' ? CRYPTO_CODES.PASSWORD_EMPTY : CRYPTO_CODES.KEY_INVALID,
      `${what} is empty`,
    );
  }
  return bytes;
}

/** scrypt's memory requirement: 128 * N * r bytes, doubled for the maxmem bound. */
function scryptMaxmem(N, r) {
  return 256 * N * r;
}

/**
 * Validate a `kdf` record.
 *
 * @param {object} kdf
 * @param {{enforceFloor?: boolean}} [options] `enforceFloor` is for creating an envelope, not reading one
 * @returns {{algo: string, N?: number, r?: number, p?: number, keylen: number}}
 * @throws {BackupCryptoError} `BACKUP_KDF_UNSUPPORTED` / `BACKUP_KDF_WEAK`
 */
export function validateKdf(kdf, options = {}) {
  if (kdf === null || typeof kdf !== 'object' || Array.isArray(kdf)) {
    throw new BackupCryptoError(CRYPTO_CODES.KDF_UNSUPPORTED, 'the kdf record is not an object');
  }
  if (kdf.algo === 'hkdf-sha256') {
    if (kdf.keylen !== DEK_LENGTH) {
      throw new BackupCryptoError(CRYPTO_CODES.KDF_UNSUPPORTED, 'hkdf key length must be 32');
    }
    return { algo: 'hkdf-sha256', keylen: DEK_LENGTH };
  }
  if (kdf.algo !== 'scrypt') {
    throw new BackupCryptoError(CRYPTO_CODES.KDF_UNSUPPORTED, `unsupported kdf algorithm: ${JSON.stringify(String(kdf.algo))}`);
  }
  const N = kdf.N;
  const r = kdf.r;
  const p = kdf.p;
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || N < 2 || r < 1 || p < 1) {
    throw new BackupCryptoError(CRYPTO_CODES.KDF_UNSUPPORTED, 'scrypt kdf parameters must be positive integers');
  }
  // Ceiling first: the power-of-two test below uses `Math.log2`, which stays exact above 2^32, whereas a
  // bitwise `N & (N-1)` would truncate and let a hostile 2^40 slip through as "power of two".
  if (N > MAX_SCRYPT_N) {
    throw new BackupCryptoError(CRYPTO_CODES.KDF_UNSUPPORTED, `scrypt N=${N} is above the ceiling this build accepts`);
  }
  if (!Number.isInteger(Math.log2(N))) {
    throw new BackupCryptoError(CRYPTO_CODES.KDF_UNSUPPORTED, 'scrypt N must be a power of two');
  }
  if (options.enforceFloor === true && N < MIN_SCRYPT.N) {
    throw new BackupCryptoError(
      CRYPTO_CODES.KDF_WEAK,
      `scrypt N=${N} is below the floor N=${MIN_SCRYPT.N} for a new envelope`,
    );
  }
  return { algo: 'scrypt', N, r, p, keylen: DEK_LENGTH };
}

/**
 * Derive a 32-byte key from a credential and a recorded KDF record.
 *
 * @param {{secret: string|Buffer, salt: string|Buffer|Uint8Array, kdf: object, enforceFloor?: boolean}} input
 * @returns {Buffer}
 */
export function deriveKek(input) {
  const kdf = validateKdf(input.kdf, { enforceFloor: input.enforceFloor === true });
  const salt = Buffer.isBuffer(input.salt) ? input.salt : Buffer.from(input.salt ?? []);
  if (salt.length < 8) throw new BackupCryptoError(CRYPTO_CODES.KDF_UNSUPPORTED, 'the salt is too short');
  const secret = requireSecret(input.secret, kdf.algo === 'scrypt' ? 'password' : 'credential');
  try {
    if (kdf.algo === 'scrypt') {
      return scryptSync(secret, salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: scryptMaxmem(kdf.N, kdf.r) });
    }
    return Buffer.from(hkdfSync('sha256', secret, salt, 'w2m-session-backup/kek/v1', kdf.keylen));
  } catch (error) {
    if (error instanceof BackupCryptoError) throw error;
    throw new BackupCryptoError(CRYPTO_CODES.KDF_FAILED, `key derivation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The AAD string that binds a sealed payload to its container. */
export function buildAad(parts) {
  return ['w2m-session-backup', String(parts.version ?? ENVELOPE_VERSION), parts.kind ?? '', parts.alg ?? AEAD]
    .concat(parts.salt === undefined ? [] : [String(parts.salt)])
    .join('|');
}

/**
 * Seal a plaintext with AES-256-GCM.
 *
 * @param {Buffer} plaintext
 * @param {Buffer} key 32 bytes
 * @param {string|Buffer} [aad]
 * @returns {{alg: string, nonce: string, ciphertext: string, tag: string}} base64 fields
 */
export function sealPayload(plaintext, key, aad = '') {
  if (!Buffer.isBuffer(plaintext)) throw new BackupCryptoError(CRYPTO_CODES.KEY_INVALID, 'plaintext must be a Buffer');
  if (!isDek(key)) throw new BackupCryptoError(CRYPTO_CODES.KEY_INVALID, `a key must be ${DEK_LENGTH} bytes`);
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(AEAD, key, nonce, { authTagLength: TAG_LENGTH });
  if (aad !== '' && aad !== undefined) cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    alg: AEAD,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Open a sealed payload. Any authentication failure is one code, because GCM cannot tell the causes apart.
 *
 * @param {{alg?: string, nonce: string, ciphertext: string, tag: string}} sealed
 * @param {Buffer} key
 * @param {string|Buffer} [aad]
 * @returns {Buffer}
 * @throws {BackupCryptoError} `BACKUP_ENVELOPE_MALFORMED` / `BACKUP_DECRYPT_AUTH_FAILED`
 */
export function openPayload(sealed, key, aad = '') {
  if (sealed === null || typeof sealed !== 'object') {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'the sealed payload is not an object');
  }
  if (sealed.alg !== undefined && sealed.alg !== AEAD) {
    throw new BackupCryptoError(CRYPTO_CODES.KDF_UNSUPPORTED, `unsupported AEAD: ${JSON.stringify(String(sealed.alg))}`);
  }
  if (!isDek(key)) throw new BackupCryptoError(CRYPTO_CODES.KEY_INVALID, `a key must be ${DEK_LENGTH} bytes`);
  let nonce;
  let ciphertext;
  let tag;
  try {
    nonce = Buffer.from(sealed.nonce, 'base64');
    ciphertext = Buffer.from(sealed.ciphertext, 'base64');
    tag = Buffer.from(sealed.tag, 'base64');
  } catch {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'the sealed payload has a non-base64 field');
  }
  if (nonce.length !== NONCE_LENGTH || tag.length !== TAG_LENGTH) {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'the nonce or tag has the wrong length');
  }
  const decipher = createDecipheriv(AEAD, key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  if (aad !== '' && aad !== undefined) decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(String(aad), 'utf8'));
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupCryptoError(CRYPTO_CODES.DECRYPT_AUTH_FAILED, AUTH_FAILED_MESSAGE);
  }
}

/**
 * Wrap the DEK under each supplied credential.
 *
 * @param {Buffer} dek
 * @param {Array<{kind: string, secret: string|Buffer, kdf?: object, hint?: string|null}>} envelopes
 *   `kdf` may be omitted for `password` (default scrypt) and must be `{algo:'hkdf-sha256'}` for high-entropy
 *   account/machine material.
 * @param {{now?: Date, kdf?: object}} [options] `kdf` overrides the default scrypt parameters for this call
 * @returns {object} the `keys.json` document
 */
export function wrapDek(dek, envelopes, options = {}) {
  if (!isDek(dek)) throw new BackupCryptoError(CRYPTO_CODES.DEK_INVALID, `a DEK must be ${DEK_LENGTH} bytes`);
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'at least one envelope is required');
  }
  const seen = new Set();
  const records = [];
  for (const envelope of envelopes) {
    const kind = envelope?.kind;
    if (!ENVELOPE_KINDS.includes(kind)) {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, `unknown envelope kind: ${JSON.stringify(String(kind))}`);
    }
    if (seen.has(kind)) throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, `duplicate envelope kind: ${kind}`);
    seen.add(kind);
    const secret = requireSecret(envelope.secret, kind === 'password' ? 'password' : 'credential');
    const kdfInput = envelope.kdf ?? (kind === 'password' ? options.kdf ?? DEFAULT_SCRYPT : { algo: 'hkdf-sha256', keylen: DEK_LENGTH });
    const kdf = validateKdf(kdfInput, { enforceFloor: kind === 'password' });
    const salt = randomSalt();
    const kek = deriveKek({ secret, salt, kdf, enforceFloor: kind === 'password' });
    const aad = buildAad({ kind, alg: AEAD, version: ENVELOPE_VERSION, salt: salt.toString('base64') });
    records.push({
      kind,
      kdf: { ...kdf, salt: salt.toString('base64') },
      sealed: sealPayload(dek, kek, aad),
      hint: typeof envelope.hint === 'string' && envelope.hint !== '' ? envelope.hint : null,
    });
  }
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    created_at: (options.now ?? new Date()).toISOString(),
    envelopes: records,
  };
}

/**
 * Unwrap the DEK with whichever credential the caller has.
 *
 * Tries `account`, then `machine`, then `password` (the order is fixed by the protocol, not by the argument
 * order). Every attempt is reported, including the failures, so a UI can say "the account material on this
 * machine no longer opens this backup -- try the password" instead of a bare refusal.
 *
 * @param {object} keysFile
 * @param {{accountSecret?: string|Buffer|null, machineSecret?: string|Buffer|null, password?: string|Buffer|null}} credentials
 * @returns {{dek: Buffer, kind: string, attempts: Array<{kind: string, ok: boolean, code: string|null}>}}
 * @throws {BackupCryptoError} `BACKUP_KEY_UNWRAP_FAILED`
 */
export function unwrapDek(keysFile, credentials = {}) {
  const validated = validateKeysFile(keysFile);
  const attempts = [];
  for (const kind of ENVELOPE_KINDS) {
    const secret = kind === 'account' ? credentials.accountSecret : kind === 'machine' ? credentials.machineSecret : credentials.password;
    if (secret === undefined || secret === null) {
      attempts.push({ kind, ok: false, code: null });
      continue;
    }
    const record = validated.envelopes.find((envelope) => envelope.kind === kind);
    if (record === undefined) {
      attempts.push({ kind, ok: false, code: null });
      continue;
    }
    try {
      const salt = Buffer.from(record.kdf.salt, 'base64');
      const kek = deriveKek({
        secret,
        salt,
        kdf: { ...record.kdf, salt: undefined },
        enforceFloor: false,
      });
      const aad = buildAad({ kind, alg: AEAD, version: validated.version, salt: record.kdf.salt });
      const dek = openPayload(record.sealed, kek, aad);
      if (!isDek(dek)) throw new BackupCryptoError(CRYPTO_CODES.DEK_INVALID, 'the unwrapped key has the wrong length');
      attempts.push({ kind, ok: true, code: null });
      return { dek, kind, attempts };
    } catch (error) {
      attempts.push({ kind, ok: false, code: error?.code ?? CRYPTO_CODES.KEY_UNWRAP_FAILED });
    }
  }
  throw new BackupCryptoError(
    CRYPTO_CODES.KEY_UNWRAP_FAILED,
    'no supplied credential opens this backup (tried the envelopes it has)',
    { attempts },
  );
}

/**
 * Validate a `keys.json` document structurally.
 *
 * @param {object} keysFile
 * @returns {object}
 * @throws {BackupCryptoError} `BACKUP_ENVELOPE_MALFORMED`
 */
export function validateKeysFile(keysFile) {
  if (keysFile === null || typeof keysFile !== 'object' || Array.isArray(keysFile)) {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'the key file is not an object');
  }
  if (keysFile.format !== ENVELOPE_FORMAT) {
    throw new BackupCryptoError(
      CRYPTO_CODES.ENVELOPE_MALFORMED,
      `the key file names format ${JSON.stringify(String(keysFile.format ?? 'unknown'))}, not ${ENVELOPE_FORMAT}`,
    );
  }
  if (!Number.isSafeInteger(keysFile.version) || keysFile.version < 1 || keysFile.version > ENVELOPE_VERSION) {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, `unsupported key-file version: ${JSON.stringify(keysFile.version)}`);
  }
  // Additive optional (v3.5.x): the account identifier this repository is bound to. It is written next to the
  // `account` envelope so the two cannot be desynchronised by an edit in one place, and validating it here means
  // every reader (snapshot copies included) rejects a malformed binding instead of silently comparing a
  // half-parsed one. An `account` envelope without this metadata stays valid: it is an envelope this build
  // cannot compare against a host account, which is a normal older file, not corruption.
  if (keysFile.account_binding !== undefined && keysFile.account_binding !== null) {
    const binding = keysFile.account_binding;
    if (typeof binding !== 'object' || Array.isArray(binding)) {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'the account_binding record is not an object');
    }
    if (typeof binding.account_id !== 'string' || binding.account_id.trim() === '' || binding.account_id.length > 1024) {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'account_binding.account_id must be a non-empty string of at most 1024 characters');
    }
    if (binding.bound_at !== undefined && (typeof binding.bound_at !== 'string' || Number.isNaN(Date.parse(binding.bound_at)))) {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'account_binding.bound_at must be an ISO timestamp when it is present');
    }
  }
  if (!Array.isArray(keysFile.envelopes) || keysFile.envelopes.length === 0) {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'the key file has no envelopes');
  }
  const kinds = new Set();
  for (const envelope of keysFile.envelopes) {
    if (envelope === null || typeof envelope !== 'object') {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'an envelope is not an object');
    }
    if (!ENVELOPE_KINDS.includes(envelope.kind)) {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, `unknown envelope kind: ${JSON.stringify(String(envelope.kind))}`);
    }
    if (kinds.has(envelope.kind)) {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, `duplicate envelope kind: ${envelope.kind}`);
    }
    kinds.add(envelope.kind);
    validateKdf(envelope.kdf, { enforceFloor: false });
    if (typeof envelope.kdf.salt !== 'string' || Buffer.from(envelope.kdf.salt, 'base64').length < 8) {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'an envelope has no usable salt');
    }
    const sealed = envelope.sealed;
    if (sealed === null || typeof sealed !== 'object') {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'an envelope has no sealed payload');
    }
    if (Buffer.from(sealed.nonce, 'base64').length !== NONCE_LENGTH || Buffer.from(sealed.tag, 'base64').length !== TAG_LENGTH) {
      throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'an envelope has a malformed nonce or tag');
    }
  }
  return keysFile;
}

/**
 * Seal one object for disk: `MAGIC | nonce | ciphertext | tag`, bound to the plaintext's digest.
 *
 * The same container is used for a deduplicated block (`objects/<aa>/<sha256>`) and for the optional
 * whole-file copy of a superseded version (`old/<ws>/<sid>/<ts>-<sha12>.json.enc`); `identity.kind` names which
 * one it is. The AAD is the digest plus the plaintext length, so an object moved to another digest's slot fails
 * authentication even though the ciphertext is intact, and a copy cannot open as a block.
 *
 * @param {Buffer} plaintext
 * @param {Buffer} dek
 * @param {{sha256: string, kind?: string}} identity `kind: OLD_COPY_KIND` names a whole-file copy; omit for a block
 * @returns {Buffer}
 */
export function sealObject(plaintext, dek, identity) {
  const aad = objectAad(identity, plaintext.length);
  const sealed = sealPayload(plaintext, dek, aad);
  const nonce = Buffer.from(sealed.nonce, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  return Buffer.concat([OBJECT_MAGIC, nonce, Buffer.from(sealed.ciphertext, 'base64'), tag]);
}

/**
 * Open one sealed object and verify both the container and the digest.
 *
 * @param {Buffer} object
 * @param {Buffer} dek
 * @param {{sha256: string, length?: number, kind?: string}} identity `kind: OLD_COPY_KIND` for a whole-file copy
 * @returns {Buffer} the plaintext (a block, or the whole superseded file for `kind: OLD_COPY_KIND`)
 */
export function openObject(object, dek, identity) {
  if (!Buffer.isBuffer(object) || object.length < OBJECT_MAGIC.length + NONCE_LENGTH + TAG_LENGTH) {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'the block object is too short to be a sealed block');
  }
  if (!object.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC)) {
    throw new BackupCryptoError(CRYPTO_CODES.ENVELOPE_MALFORMED, 'the block object has the wrong magic');
  }
  let offset = OBJECT_MAGIC.length;
  const nonce = object.subarray(offset, offset + NONCE_LENGTH);
  offset += NONCE_LENGTH;
  const tag = object.subarray(object.length - TAG_LENGTH);
  const ciphertext = object.subarray(offset, object.length - TAG_LENGTH);
  const sealed = {
    alg: AEAD,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
  const length = typeof identity?.length === 'number' ? identity.length : undefined;
  const aad = objectAad(identity, length === undefined ? null : length);
  const plaintext = openPayload(sealed, dek, aad);
  const digest = createHash('sha256').update(plaintext).digest('hex');
  if (digest !== identity.sha256) {
    throw new BackupCryptoError(
      CRYPTO_CODES.DECRYPT_AUTH_FAILED,
      `the block decrypts but hashes to ${digest}, not ${identity.sha256}`,
    );
  }
  return plaintext;
}

/** The AAD of a sealed object: `w2m-session-backup/<kind>|<sha256>|<length>`, `kind` defaulting to `object`. */
function objectAad(identity, length) {
  const declared = length === null || length === undefined ? '' : String(length);
  // `kind` is opt-in and only `OLD_COPY_KIND` is recognised: anything else stays a block object, so a typo
  // cannot silently invent a third namespace that nothing else knows how to open.
  const kind = identity?.kind === OLD_COPY_KIND ? OLD_COPY_KIND : 'object';
  return `w2m-session-backup/${kind}|${String(identity?.sha256 ?? '')}|${declared}`;
}

/**
 * End-to-end cryptographic self-test.
 *
 * This is what `w2m-backup selftest` runs, and it is deliberately not a unit test: it is the check a user can
 * run on *their* machine, with *their* Node build, before trusting a repository. Every step is a real
 * operation, including the two that must fail.
 *
 * @param {{kdf?: object, now?: Date}} [options]
 * @returns {{ok: boolean, steps: Array<{name: string, ok: boolean, code: string|null, detail: string}>, code: string|null}}
 */
export function selftest(options = {}) {
  const steps = [];
  const record = (name, fn) => {
    try {
      fn();
      steps.push({ name, ok: true, code: null, detail: 'ok' });
    } catch (error) {
      steps.push({ name, ok: false, code: error?.code ?? null, detail: error?.detail ?? String(error?.message ?? error) });
    }
  };
  const expectCode = (fn, code) => {
    try {
      fn();
    } catch (error) {
      if (error?.code === code) return;
      throw new BackupCryptoError(CRYPTO_CODES.SELFTEST_FAILED, `expected ${code}, got ${error?.code ?? String(error?.message ?? error)}`);
    }
    throw new BackupCryptoError(CRYPTO_CODES.SELFTEST_FAILED, `expected ${code}, but the operation succeeded`);
  };

  const kdf = options.kdf ?? DEFAULT_SCRYPT;
  const dek = randomDek();
  let keysFile;

  record('wrap the DEK with account, machine and password envelopes', () => {
    keysFile = wrapDek(
      dek,
      [
        { kind: 'account', secret: randomBytes(32), hint: 'account' },
        { kind: 'machine', secret: randomBytes(32), hint: 'machine' },
        { kind: 'password', secret: 'correct horse battery staple', hint: 'password' },
      ],
      { now: options.now ?? new Date(), kdf },
    );
    if (!isDek(dek)) throw new BackupCryptoError(CRYPTO_CODES.SELFTEST_FAILED, 'the DEK is not 32 bytes');
  });

  record('the password envelope unwraps to the same DEK', () => {
    const opened = unwrapDek(keysFile, { password: 'correct horse battery staple' });
    if (!opened.dek.equals(dek)) throw new BackupCryptoError(CRYPTO_CODES.SELFTEST_FAILED, 'the unwrapped key differs');
    if (opened.kind !== 'password') throw new BackupCryptoError(CRYPTO_CODES.SELFTEST_FAILED, `unwrapped via ${opened.kind}`);
  });

  record('a wrong password is refused, and the refusal names the ambiguity', () => {
    expectCode(() => unwrapDek(keysFile, { password: 'wrong password' }), CRYPTO_CODES.KEY_UNWRAP_FAILED);
  });

  record('a wrong account secret is refused', () => {
    expectCode(() => unwrapDek(keysFile, { accountSecret: randomBytes(32) }), CRYPTO_CODES.KEY_UNWRAP_FAILED);
  });

  record('one flipped byte in an envelope tag is refused', () => {
    const tampered = JSON.parse(JSON.stringify(keysFile));
    const tag = Buffer.from(tampered.envelopes[2].sealed.tag, 'base64');
    tag[0] ^= 0xff;
    tampered.envelopes[2].sealed.tag = tag.toString('base64');
    expectCode(() => unwrapDek(tampered, { password: 'correct horse battery staple' }), CRYPTO_CODES.KEY_UNWRAP_FAILED);
  });

  record('an envelope moved to another kind slot is refused', () => {
    const tampered = JSON.parse(JSON.stringify(keysFile));
    const account = tampered.envelopes.find((envelope) => envelope.kind === 'account');
    const password = tampered.envelopes.find((envelope) => envelope.kind === 'password');
    password.sealed = account.sealed;
    password.kdf = account.kdf;
    expectCode(() => unwrapDek(tampered, { password: 'correct horse battery staple' }), CRYPTO_CODES.KEY_UNWRAP_FAILED);
  });

  const block = randomBytes(1024);
  const digest = createHash('sha256').update(block).digest('hex');
  record('a block object round-trips', () => {
    const sealed = sealObject(block, dek, { sha256: digest });
    const opened = openObject(sealed, dek, { sha256: digest, length: block.length });
    if (!opened.equals(block)) throw new BackupCryptoError(CRYPTO_CODES.SELFTEST_FAILED, 'the block round trip differs');
  });

  record('a block object with one flipped byte is refused', () => {
    const sealed = sealObject(block, dek, { sha256: digest });
    sealed[sealed.length - 1] ^= 0xff;
    expectCode(() => openObject(sealed, dek, { sha256: digest, length: block.length }), CRYPTO_CODES.DECRYPT_AUTH_FAILED);
  });

  record('a block object placed under another digest is refused', () => {
    const sealed = sealObject(block, dek, { sha256: digest });
    expectCode(
      () => openObject(sealed, dek, { sha256: 'f'.repeat(64), length: block.length }),
      CRYPTO_CODES.DECRYPT_AUTH_FAILED,
    );
  });

  const failed = steps.filter((step) => step.ok !== true);
  return { ok: failed.length === 0, steps, code: failed.length === 0 ? null : CRYPTO_CODES.SELFTEST_FAILED };
}
