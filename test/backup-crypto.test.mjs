/**
 * Backup cryptography: the round trip must work, and every wrong thing must be refused *with a code*.
 *
 * The tests are deliberately written against the three failure modes a user will actually hit -- wrong password,
 * wrong account material, and a file that changed after it was written -- because the drill lesson is that a
 * failure without a name is indistinguishable from a bug. GCM cannot tell "wrong key" from "tampered file", so
 * the tests assert that the refusal *says* that instead of guessing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import {
  AEAD,
  BackupCryptoError,
  CRYPTO_CODES,
  DEFAULT_SCRYPT,
  DEK_LENGTH,
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
  MIN_SCRYPT,
  deriveKek,
  isDek,
  openObject,
  openPayload,
  randomDek,
  randomSalt,
  sealObject,
  sealPayload,
  selftest,
  unwrapDek,
  validateKdf,
  validateKeysFile,
  wrapDek,
} from '../src/backup/crypto.mjs';

/** The cheapest scrypt the module will *create*, so the suite stays fast without weakening what it tests. */
const KDF = { algo: 'scrypt', N: MIN_SCRYPT.N, r: MIN_SCRYPT.r, p: MIN_SCRYPT.p, keylen: DEK_LENGTH };

const PASSWORD = 'correct horse battery staple';

/** Assert that `fn` throws a BackupCryptoError with `code`. */
function refuses(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof BackupCryptoError, `expected a named crypto error, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.detail}`);
    return true;
  });
}

describe('backup crypto: keys and KDF records', () => {
  it('mints 32-byte DEKs', () => {
    const dek = randomDek();
    assert.equal(dek.length, DEK_LENGTH);
    assert.equal(isDek(dek), true);
    assert.equal(isDek(randomBytes(31)), false);
    assert.equal(isDek('a'.repeat(32)), false);
    assert.notDeepEqual(randomDek(), randomDek());
  });

  it('derives the same key from the same secret, salt and parameters, and a different one from a different salt', () => {
    const salt = randomSalt();
    const a = deriveKek({ secret: PASSWORD, salt, kdf: KDF });
    const b = deriveKek({ secret: PASSWORD, salt, kdf: KDF });
    assert.deepEqual(a, b);
    assert.equal(a.length, DEK_LENGTH);
    assert.equal(deriveKek({ secret: PASSWORD, salt: randomSalt(), kdf: KDF }).equals(a), false);
    assert.equal(deriveKek({ secret: `${PASSWORD}x`, salt, kdf: KDF }).equals(a), false);
  });

  it('supports the hkdf record used for high-entropy account/machine material', () => {
    const salt = randomSalt();
    const secret = randomBytes(32);
    const first = deriveKek({ secret, salt, kdf: { algo: 'hkdf-sha256', keylen: DEK_LENGTH } });
    const second = deriveKek({ secret, salt, kdf: { algo: 'hkdf-sha256', keylen: DEK_LENGTH } });
    assert.deepEqual(first, second);
    assert.equal(first.length, DEK_LENGTH);
    assert.equal(deriveKek({ secret, salt: randomSalt(), kdf: { algo: 'hkdf-sha256', keylen: DEK_LENGTH } }).equals(first), false);
  });

  it('refuses an empty password with its own code, not a generic key error', () => {
    refuses(() => deriveKek({ secret: '', salt: randomSalt(), kdf: KDF }), CRYPTO_CODES.PASSWORD_EMPTY);
    refuses(() => deriveKek({ secret: 42, salt: randomSalt(), kdf: KDF }), CRYPTO_CODES.KEY_INVALID);
  });

  it('accepts what a file records, but refuses to create anything below the floor or above the ceiling', () => {
    assert.equal(validateKdf(KDF).algo, 'scrypt');
    refuses(() => validateKdf({ ...KDF, N: 1024 }, { enforceFloor: true }), CRYPTO_CODES.KDF_WEAK);
    assert.equal(validateKdf({ ...KDF, N: 1024 }, { enforceFloor: false }).N, 1024, 'old repositories must still open');
    refuses(() => validateKdf({ ...KDF, N: 1000 }, { enforceFloor: false }), CRYPTO_CODES.KDF_UNSUPPORTED);
    refuses(() => validateKdf({ ...KDF, N: 2 ** 40 }, { enforceFloor: false }), CRYPTO_CODES.KDF_UNSUPPORTED);
    refuses(() => validateKdf({ algo: 'pbkdf2' }), CRYPTO_CODES.KDF_UNSUPPORTED);
    refuses(() => validateKdf(null), CRYPTO_CODES.KDF_UNSUPPORTED);
    assert.equal(validateKdf(DEFAULT_SCRYPT).N, DEFAULT_SCRYPT.N, 'the default is itself valid');
  });

  it('binds the KDF parameters into the envelope so a file cannot lower its own cost', () => {
    const dek = randomDek();
    const keys = wrapDek(dek, [{ kind: 'password', secret: PASSWORD }], { kdf: KDF });
    const envelope = keys.envelopes[0];
    assert.equal(envelope.kdf.algo, 'scrypt');
    assert.equal(envelope.kdf.N, KDF.N);
    assert.equal(Buffer.from(envelope.kdf.salt, 'base64').length, 16);
    assert.equal(envelope.sealed.alg, AEAD);
    assert.equal(Buffer.from(envelope.sealed.nonce, 'base64').length, 12);
    assert.equal(Buffer.from(envelope.sealed.tag, 'base64').length, 16);
  });
});

describe('backup crypto: authenticated payloads', () => {
  const dek = randomDek();

  it('round-trips a payload, including an empty one', () => {
    const message = Buffer.from('a block of session bytes');
    const sealed = sealPayload(message, dek, 'aad');
    assert.deepEqual(openPayload(sealed, dek, 'aad'), message);
    const empty = sealPayload(Buffer.alloc(0), dek);
    assert.deepEqual(openPayload(empty, dek), Buffer.alloc(0));
  });

  it('refuses a payload whose AAD differs', () => {
    const sealed = sealPayload(Buffer.from('x'), dek, 'aad-one');
    refuses(() => openPayload(sealed, dek, 'aad-two'), CRYPTO_CODES.DECRYPT_AUTH_FAILED);
    refuses(() => openPayload(sealed, dek), CRYPTO_CODES.DECRYPT_AUTH_FAILED);
  });

  it('refuses a single flipped byte in the ciphertext, tag or nonce', () => {
    const sealed = sealPayload(Buffer.from('x'.repeat(64)), dek, 'aad');
    const flip = (field, index = 0) => {
      const copy = JSON.parse(JSON.stringify(sealed));
      const bytes = Buffer.from(copy[field], 'base64');
      bytes[index] ^= 0xff;
      copy[field] = bytes.toString('base64');
      return copy;
    };
    refuses(() => openPayload(flip('ciphertext'), dek, 'aad'), CRYPTO_CODES.DECRYPT_AUTH_FAILED);
    refuses(() => openPayload(flip('tag'), dek, 'aad'), CRYPTO_CODES.DECRYPT_AUTH_FAILED);
    refuses(() => openPayload(flip('nonce'), dek, 'aad'), CRYPTO_CODES.DECRYPT_AUTH_FAILED);
    refuses(() => openPayload(flip('tag', 15), dek, 'aad'), CRYPTO_CODES.DECRYPT_AUTH_FAILED);
  });

  it('refuses the wrong key, and names the ambiguity in the detail', () => {
    const sealed = sealPayload(Buffer.from('x'), dek, 'aad');
    try {
      openPayload(sealed, randomDek(), 'aad');
      assert.fail('the wrong key must not open the payload');
    } catch (error) {
      assert.equal(error.code, CRYPTO_CODES.DECRYPT_AUTH_FAILED);
      assert.match(error.detail, /wrong, or the file has been altered/u);
    }
  });

  it('refuses a malformed container rather than guessing', () => {
    refuses(() => openPayload(null, dek), CRYPTO_CODES.ENVELOPE_MALFORMED);
    refuses(() => openPayload({ nonce: 'AA==', ciphertext: 'AA==', tag: 'AA==' }, dek), CRYPTO_CODES.ENVELOPE_MALFORMED);
    refuses(() => openPayload({ alg: 'chacha20', nonce: 'A'.repeat(16), ciphertext: '', tag: 'A'.repeat(24) }, dek), CRYPTO_CODES.KDF_UNSUPPORTED);
    refuses(() => sealPayload(Buffer.from('x'), Buffer.alloc(16)), CRYPTO_CODES.KEY_INVALID);
  });
});

describe('backup crypto: envelopes', () => {
  const dek = randomDek();
  const accountSecret = randomBytes(32);
  const machineSecret = randomBytes(32);
  const build = () => wrapDek(
    dek,
    [
      { kind: 'account', secret: accountSecret, hint: 'a@example.invalid' },
      { kind: 'machine', secret: machineSecret },
      { kind: 'password', secret: PASSWORD },
    ],
    { kdf: KDF, now: new Date('2026-11-17T00:00:00.000Z') },
  );

  it('wraps one DEK under three credentials and unwraps with any of them', () => {
    const keys = build();
    assert.equal(keys.format, ENVELOPE_FORMAT);
    assert.equal(keys.version, ENVELOPE_VERSION);
    assert.equal(keys.created_at, '2026-11-17T00:00:00.000Z');
    assert.deepEqual(keys.envelopes.map((envelope) => envelope.kind), ['account', 'machine', 'password']);
    assert.deepEqual(unwrapDek(keys, { accountSecret }).dek, dek);
    assert.deepEqual(unwrapDek(keys, { machineSecret }).dek, dek);
    assert.deepEqual(unwrapDek(keys, { password: PASSWORD }).dek, dek);
    assert.equal(unwrapDek(keys, { password: PASSWORD }).kind, 'password');
  });

  it('tries account, then machine, then password, and reports every attempt', () => {
    const keys = build();
    const result = unwrapDek(keys, { accountSecret: randomBytes(32), machineSecret: randomBytes(32), password: PASSWORD });
    assert.equal(result.kind, 'password');
    assert.deepEqual(result.attempts.map((attempt) => [attempt.kind, attempt.ok]), [['account', false], ['machine', false], ['password', true]]);
  });

  it('refuses to unwrap when no credential matches, and says which envelopes it tried', () => {
    const keys = build();
    try {
      unwrapDek(keys, { password: 'wrong password' });
      assert.fail('a wrong password must not unwrap the DEK');
    } catch (error) {
      assert.equal(error.code, CRYPTO_CODES.KEY_UNWRAP_FAILED);
      assert.deepEqual(error.attempts, [
        { kind: 'account', ok: false, code: null },
        { kind: 'machine', ok: false, code: null },
        // The per-attempt code is the underlying GCM refusal, not the aggregate: a caller that wants to tell
        // "this envelope is corrupt" from "this credential is wrong" gets the honest ambiguity instead.
        { kind: 'password', ok: false, code: CRYPTO_CODES.DECRYPT_AUTH_FAILED },
      ]);
    }
    try {
      unwrapDek(keys, {});
      assert.fail('no credential must not unwrap the DEK');
    } catch (error) {
      assert.equal(error.code, CRYPTO_CODES.KEY_UNWRAP_FAILED);
    }
  });

  it('never stores the DEK in clear', () => {
    const keys = build();
    const text = JSON.stringify(keys);
    assert.equal(text.includes(dek.toString('base64')), false);
    assert.equal(text.includes(dek.toString('hex')), false);
  });

  it('refuses a tampered envelope, a relocated envelope, and a lowered KDF cost', () => {
    const keys = build();

    const flipped = JSON.parse(JSON.stringify(keys));
    const ciphertext = Buffer.from(flipped.envelopes[0].sealed.ciphertext, 'base64');
    ciphertext[0] ^= 0xff;
    flipped.envelopes[0].sealed.ciphertext = ciphertext.toString('base64');
    refuses(() => unwrapDek(flipped, { accountSecret }), CRYPTO_CODES.KEY_UNWRAP_FAILED);

    const relocated = JSON.parse(JSON.stringify(keys));
    relocated.envelopes[0].sealed = relocated.envelopes[1].sealed;
    refuses(() => unwrapDek(relocated, { accountSecret }), CRYPTO_CODES.KEY_UNWRAP_FAILED);

    const weakened = JSON.parse(JSON.stringify(keys));
    weakened.envelopes[2].kdf.N = 4096;
    refuses(() => unwrapDek(weakened, { password: PASSWORD }), CRYPTO_CODES.KEY_UNWRAP_FAILED);
  });

  it('refuses malformed inputs with named codes', () => {
    refuses(() => wrapDek(dek, []), CRYPTO_CODES.ENVELOPE_MALFORMED);
    refuses(() => wrapDek(dek, [{ kind: 'account', secret: accountSecret }, { kind: 'account', secret: accountSecret }]), CRYPTO_CODES.ENVELOPE_MALFORMED);
    refuses(() => wrapDek(dek, [{ kind: 'telepathy', secret: 'x' }]), CRYPTO_CODES.ENVELOPE_MALFORMED);
    refuses(() => wrapDek(dek, [{ kind: 'password', secret: '' }]), CRYPTO_CODES.PASSWORD_EMPTY);
    refuses(() => wrapDek(Buffer.alloc(16), [{ kind: 'password', secret: PASSWORD }], { kdf: KDF }), CRYPTO_CODES.DEK_INVALID);
    refuses(() => validateKeysFile(null), CRYPTO_CODES.ENVELOPE_MALFORMED);
    refuses(() => validateKeysFile({ format: ENVELOPE_FORMAT, version: 1, envelopes: [] }), CRYPTO_CODES.ENVELOPE_MALFORMED);
    refuses(() => validateKeysFile({ format: 'other', version: 1, envelopes: [{}] }), CRYPTO_CODES.ENVELOPE_MALFORMED);
  });
});

describe('backup crypto: sealed block objects', () => {
  const dek = randomDek();
  const plaintext = randomBytes(4096);
  const digest = createHash('sha256').update(plaintext).digest('hex');

  it('round-trips a block with its digest, and verifies the digest after opening', () => {
    const sealed = sealObject(plaintext, dek, { sha256: digest });
    assert.deepEqual(openObject(sealed, dek, { sha256: digest, length: plaintext.length }), plaintext);
  });

  it('refuses tampering, a relocated block, and a truncated container', () => {
    const sealed = sealObject(plaintext, dek, { sha256: digest });
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] ^= 0xff;
    refuses(() => openObject(flipped, dek, { sha256: digest, length: plaintext.length }), CRYPTO_CODES.DECRYPT_AUTH_FAILED);

    refuses(() => openObject(sealed, dek, { sha256: 'f'.repeat(64), length: plaintext.length }), CRYPTO_CODES.DECRYPT_AUTH_FAILED);
    refuses(() => openObject(sealed.subarray(0, 8), dek, { sha256: digest }), CRYPTO_CODES.ENVELOPE_MALFORMED);
    refuses(() => openObject(Buffer.from('NOTMAGIC'.repeat(4)), dek, { sha256: digest }), CRYPTO_CODES.ENVELOPE_MALFORMED);
  });
});

describe('backup crypto: the self-test a user runs on their own machine', () => {
  it('passes every step, including the ones that must fail', () => {
    const result = selftest({ kdf: KDF });
    assert.equal(result.ok, true, JSON.stringify(result.steps.filter((step) => !step.ok)));
    assert.ok(result.steps.length >= 9);
    assert.ok(result.steps.every((step) => step.ok === true));
    assert.ok(result.steps.some((step) => step.name.includes('wrong password')));
    assert.ok(result.steps.some((step) => step.name.includes('flipped byte')));
  });
});
