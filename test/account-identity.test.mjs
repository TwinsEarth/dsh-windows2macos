/**
 * The account keypair: deterministic, standard, and actually able to sign.
 *
 * "Derived" is the whole claim, so it is asserted directly -- equal material must give an equal key, different material
 * must not -- and then the key is exercised (sign, verify, tamper) because a key that cannot sign is a hash with better
 * marketing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveAccountKeypair, signChallenge, verifyChallenge } from '../src/util/account-identity.mjs';

const payload = 'challenge-123|fingerprint-abc|machine-1';

describe('the account identity is derived, not generated', () => {
  it('the same material yields the same keypair and fingerprint', () => {
    const a = deriveAccountKeypair('account-material-1');
    const b = deriveAccountKeypair('account-material-1');
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(a.publicKeyPem, b.publicKeyPem);
    assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  });

  it('different material yields a different keypair', () => {
    const a = deriveAccountKeypair('account-material-1');
    const b = deriveAccountKeypair('account-material-2');
    assert.notEqual(a.fingerprint, b.fingerprint);
  });

  it('the fingerprint is the hash of the exported public key, not of the material', () => {
    const id = deriveAccountKeypair('account-material-1');
    const der = id.publicKey.export({ type: 'spki', format: 'der' });
    assert.equal(id.fingerprint, createHash('sha256').update(der).digest('hex'));
  });
});

describe('the key can sign, and only the right key verifies', () => {
  it('a signature verifies with the matching public key', () => {
    const id = deriveAccountKeypair('account-material-1');
    const signature = signChallenge(id, payload);
    assert.equal(verifyChallenge(id.publicKeyPem, payload, signature), true);
  });

  it('a tampered payload, a wrong key and a garbled signature all fail closed', () => {
    const id = deriveAccountKeypair('account-material-1');
    const other = deriveAccountKeypair('account-material-2');
    const signature = signChallenge(id, payload);
    assert.equal(verifyChallenge(id.publicKeyPem, payload + 'x', signature), false, 'tampered payload');
    assert.equal(verifyChallenge(other.publicKeyPem, payload, signature), false, 'wrong key');
    assert.equal(verifyChallenge(id.publicKeyPem, payload, 'not-a-signature'), false, 'garbage signature');
  });

  it('rejects empty material instead of deriving a key from nothing', () => {
    assert.throws(() => deriveAccountKeypair(''), (e) => e instanceof TypeError);
    assert.throws(() => deriveAccountKeypair(42), (e) => e instanceof TypeError);
  });
});
