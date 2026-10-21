/**
 * Task-level grant protocol tests (M2, v1.3.10-beta.3 slice).
 *
 * Each refusal code exists because a different failure would otherwise be indistinguishable from a valid authorisation:
 * wrong machine, wrong task, wrong argv, expired, replayed, exhausted, revoked. The matrix is the point of the file.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrant, signGrant, verifyGrant, argvHash, MAX_GRANT_TTL_MS } from '../src/maintenance/grant.mjs';
import { generateOperatorKeyPair, registrationPayload } from '../src/maintenance/operator-key.mjs';

const MACHINE = '1c14d7d2-d9e2-43dd-a7e5-eda98f4864bc';
const OTHER = '6c92b251-3728-48bc-82a9-56cc40df48f2';
const NOW = Date.parse('2026-10-21T14:00:00Z');
const ARGV = ['node', '-e', 'console.log(process.version)'];
const TASK = '01M5F000000000000000000000';

describe('grant protocol', () => {
  let keys;
  let grant;

  beforeEach(() => {
    keys = generateOperatorKeyPair();
    grant = signGrant(
      buildGrant({ taskId: TASK, machineIds: [MACHINE], argv: ARGV, nowMs: NOW, ttlMs: 5 * 60 * 1000 }),
      keys.privateKeyPem,
    );
  });

  const context = (extra = {}) => ({ publicKeyPem: keys.publicKeyPem, expectedKeyId: keys.keyId, nowMs: NOW, machineId: MACHINE, taskId: TASK, argv: ARGV, ...extra });

  it('accepts a correctly signed, in-scope, in-time grant', () => {
    const verified = verifyGrant(grant, context());
    assert.equal(verified.ok, true);
    assert.equal(verified.grant.grant_id, grant.grant_id);
    assert.equal(grant.argv_hash, argvHash(ARGV));
  });

  it('refuses a grant for another machine', () => {
    assert.equal(verifyGrant(grant, context({ machineId: OTHER })).code, 'GRANT_WRONG_MACHINE');
  });

  it('refuses a grant bound to a different task', () => {
    assert.equal(verifyGrant(grant, context({ taskId: 'another-task' })).code, 'GRANT_WRONG_TASK');
  });

  it('refuses when the argv differs by one argument', () => {
    assert.equal(verifyGrant(grant, context({ argv: ['node', '-e', 'console.log(process.versions)'] })).code, 'GRANT_ARGV_MISMATCH');
    assert.equal(verifyGrant(grant, context({ argv: [...ARGV, '--extra'] })).code, 'GRANT_ARGV_MISMATCH');
  });

  it('refuses tampered grants, unknown keys and revoked keys', () => {
    const tampered = { ...grant, argv_head: ['node', '-e', 'echo pwned'] };
    assert.equal(verifyGrant(tampered, context()).code, 'GRANT_BAD_SIGNATURE');

    const other = generateOperatorKeyPair();
    assert.equal(verifyGrant(grant, context({ publicKeyPem: other.publicKeyPem, expectedKeyId: other.keyId })).code, 'GRANT_UNKNOWN_KEY');
    assert.equal(verifyGrant(grant, context({ isRevoked: () => true })).code, 'GRANT_REVOKED');
  });

  it('refuses expired, future and over-long grants', () => {
    assert.equal(verifyGrant(grant, context({ nowMs: NOW + 10 * 60 * 1000 })).code, 'GRANT_EXPIRED');
    const future = signGrant(buildGrant({ machineIds: [MACHINE], argv: ARGV, nowMs: NOW + 5 * 60 * 1000 }), keys.privateKeyPem);
    assert.equal(verifyGrant(future, context()).code, 'GRANT_FUTURE');
    const long = signGrant(buildGrant({ machineIds: [MACHINE], argv: ARGV, nowMs: NOW, ttlMs: MAX_GRANT_TTL_MS + 1 }), keys.privateKeyPem);
    assert.equal(verifyGrant(long, context()).code, 'GRANT_TTL_TOO_LONG');
  });

  it('refuses replays and exhausted uses', () => {
    assert.equal(verifyGrant(grant, context({ usedGrantIds: new Set([grant.grant_id]) })).code, 'GRANT_REPLAY');
    assert.equal(verifyGrant(grant, context({ usedNonces: new Set([grant.nonce]) })).code, 'GRANT_REPLAY');
    const single = signGrant(buildGrant({ machineIds: [MACHINE], argv: ARGV, nowMs: NOW, maxUses: 1 }), keys.privateKeyPem);
    assert.equal(verifyGrant(single, context({ usedCount: 1 })).code, 'GRANT_USES_EXHAUSTED');
    assert.equal(verifyGrant(single, context({ usedCount: 0 })).ok, true);
  });

  it('refuses grants that would widen the task constraints', () => {
    const writer = signGrant(buildGrant({ machineIds: [MACHINE], argv: ARGV, nowMs: NOW, write: true }), keys.privateKeyPem);
    assert.equal(verifyGrant(writer, context({ policy: { write: false } })).code, 'GRANT_CONSTRAINT_VIOLATION');
    const elsewhere = signGrant(buildGrant({ machineIds: [MACHINE], argv: ARGV, nowMs: NOW, cwdRel: 'src/' }), keys.privateKeyPem);
    assert.equal(verifyGrant(elsewhere, context({ policy: { cwd_rel: '.' } })).code, 'GRANT_CONSTRAINT_VIOLATION');
  });

  it('refuses malformed grants and missing signatures', () => {
    assert.equal(verifyGrant(null, context()).code, 'GRANT_BAD_SHAPE');
    const unsigned = buildGrant({ machineIds: [MACHINE], argv: ARGV, nowMs: NOW });
    assert.equal(verifyGrant(unsigned, context()).code, 'GRANT_MISSING_SIGNATURE');
    const badTtl = signGrant(buildGrant({ machineIds: [MACHINE], argv: ARGV, nowMs: NOW, maxUses: 0 }), keys.privateKeyPem);
    assert.equal(verifyGrant(badTtl, context()).code, 'GRANT_BAD_SHAPE');
  });

  it('carries the operator key id on the signature and never the private key', () => {
    assert.equal(grant.signature.key_id, keys.keyId);
    assert.equal(JSON.stringify(grant).includes(keys.privateKeyPem), false);
    assert.equal(registrationPayload(keys).key_id, keys.keyId);
  });
});
