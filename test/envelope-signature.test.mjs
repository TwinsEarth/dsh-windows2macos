/**
 * Envelope signatures: a good signature verifies, a tampered field does not, and absence is its own status.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalSignedPayload, publicKeyFromBase64, verifyEnvelopeSignature } from '../src/util/envelope-signature.mjs';

const FIELDS = { task_id: '01J-T', argv_hash: 'a'.repeat(64), machine_id: 'm-1', ts: '2026-10-20T00:00:00.000Z' };
const keypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { privateKey, raw };
};
const signatureOf = ({ privateKey, raw }, fields = FIELDS) => ({
  alg: 'ed25519',
  value: sign(null, Buffer.from(canonicalSignedPayload(fields), 'utf8'), privateKey).toString('base64'),
  public_key: raw,
  ts: fields.ts,
});

describe('canonicalSignedPayload', () => {
  it('is stable for the same tuple and covers every field', () => {
    assert.equal(canonicalSignedPayload(FIELDS), canonicalSignedPayload({ ...FIELDS }));
    const payload = canonicalSignedPayload(FIELDS);
    for (const value of Object.values(FIELDS)) assert.ok(payload.includes(value), value);
  });
});

describe('verifyEnvelopeSignature', () => {
  it('verifies a signature over the four facts', () => {
    const kp = keypair();
    assert.equal(verifyEnvelopeSignature({ ...FIELDS, signature: signatureOf(kp) }), 'signed');
  });

  it('reports a tampered argv_hash as bad_signature', () => {
    const kp = keypair();
    const signature = signatureOf(kp);
    assert.equal(verifyEnvelopeSignature({ ...FIELDS, argv_hash: 'b'.repeat(64), signature }), 'bad_signature');
  });

  it('reports a tampered task id or machine id as bad_signature', () => {
    const kp = keypair();
    const signature = signatureOf(kp);
    assert.equal(verifyEnvelopeSignature({ ...FIELDS, task_id: 'other', signature }), 'bad_signature');
    assert.equal(verifyEnvelopeSignature({ ...FIELDS, machine_id: 'other', signature }), 'bad_signature');
  });

  it('calls absence unsigned, and an unusable key bad_signature', () => {
    assert.equal(verifyEnvelopeSignature({ ...FIELDS }), 'unsigned');
    assert.equal(verifyEnvelopeSignature({ ...FIELDS, signature: { alg: 'ed25519', value: 'x', public_key: 'not-a-key' } }), 'bad_signature');
    assert.equal(verifyEnvelopeSignature({ ...FIELDS, signature: { alg: 'rsa', value: 'x', public_key: 'y' } }), 'unsupported_algorithm');
  });

  it('builds a public key from the 32 raw bytes only', () => {
    const kp = keypair();
    assert.ok(publicKeyFromBase64(kp.raw) !== null);
    assert.equal(publicKeyFromBase64('too-short'), null);
    assert.equal(publicKeyFromBase64(null), null);
  });
});
