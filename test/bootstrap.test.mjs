/**
 * v1.5.2 — the verified bootstrap answer (src/plugin/bootstrap.mjs).
 *
 * These cases are the contract that makes automatic relay assignment safe: a response is accepted
 * only when it is for this fleet, inside its validity window, and signed over the canonical bytes
 * by the pinned operator key. Each refusal is a named reason, because the status surface reports
 * them verbatim.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BOOTSTRAP_PROTOCOL,
  BOOTSTRAP_REFUSAL,
  buildBootstrapProof,
  canonicalBootstrapPayload,
  fleetIdOf,
  readBootstrapCache,
  verifyBootstrapAnswer,
  writeBootstrapCache,
} from '../src/plugin/bootstrap.mjs';

const FLEET_KEY = Buffer.alloc(32, 9).toString('base64url');
const FLEET_ID = fleetIdOf(FLEET_KEY);
const RELAYS = ['http://106.53.197.47:8787', 'https://relay.example:8787'];

function signAnswer(privateKey, overrides = {}) {
  const issuedAt = overrides.issued_at ?? new Date().toISOString();
  const expiresAt = overrides.expires_at ?? new Date(Date.now() + 3600_000).toISOString();
  const relays = overrides.relays ?? RELAYS;
  const fleet_id = overrides.fleet_id ?? FLEET_ID;
  const payload = canonicalBootstrapPayload({ fleet_id, relays, issued_at: issuedAt, expires_at: expiresAt });
  const signature = { alg: 'ed25519', value: signBytes(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64') };
  return { protocol: BOOTSTRAP_PROTOCOL, fleet_id, relays, issued_at: issuedAt, expires_at: expiresAt, ...overrides, signature: overrides.signature ?? signature };
}

describe('verified relay bootstrap (v1.5.2)', () => {
  it('accepts a correctly signed answer for this fleet', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const answer = signAnswer(privateKey);
    const result = verifyBootstrapAnswer(answer, { operatorPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), fleetId: FLEET_ID });
    assert.equal(result.ok, true);
    assert.deepEqual(result.relays, RELAYS);
  });

  it('refuses a tampered relay list, a different fleet, and an expired answer by name', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const tampered = signAnswer(privateKey);
    tampered.relays = [...RELAYS, 'http://evil.example:8787'];
    assert.equal(verifyBootstrapAnswer(tampered, { operatorPublicKeyPem: pem, fleetId: FLEET_ID }).reason_code, BOOTSTRAP_REFUSAL.BAD_SIGNATURE);
    // v1.6.0: an answer signed for another fleet is topology, not misdelivery -- N accounts share one relay.
    const otherFleet = signAnswer(privateKey, { fleet_id: 'a'.repeat(64) });
    const topology = verifyBootstrapAnswer(otherFleet, { operatorPublicKeyPem: pem, fleetId: FLEET_ID });
    assert.equal(topology.ok, true);
    assert.equal(topology.fleet_mismatch, true);
    assert.equal(verifyBootstrapAnswer(otherFleet, { operatorPublicKeyPem: pem, fleetId: FLEET_ID, strictFleet: true }).reason_code, BOOTSTRAP_REFUSAL.WRONG_FLEET);
    const expired = signAnswer(privateKey, { expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(verifyBootstrapAnswer(expired, { operatorPublicKeyPem: pem, fleetId: FLEET_ID }).reason_code, BOOTSTRAP_REFUSAL.EXPIRED);
    const unsigned = signAnswer(privateKey);
    delete unsigned.signature;
    assert.equal(verifyBootstrapAnswer(unsigned, { operatorPublicKeyPem: pem, fleetId: FLEET_ID }).reason_code, BOOTSTRAP_REFUSAL.BAD_SIGNATURE);
  });

  it('builds a deterministic proof that changes with the nonce', () => {
    const fleetId = FLEET_ID;
    const a = buildBootstrapProof({ fleetKey: FLEET_KEY, fleetId, issuedAtMs: 1000, nonce: 'n1' });
    const b = buildBootstrapProof({ fleetKey: FLEET_KEY, fleetId, issuedAtMs: 1000, nonce: 'n1' });
    const c = buildBootstrapProof({ fleetKey: FLEET_KEY, fleetId, issuedAtMs: 1000, nonce: 'n2' });
    assert.equal(a.proof, b.proof);
    assert.notEqual(a.proof, c.proof);
    assert.equal(a.alg, 'hmac-sha256');
    assert.throws(() => buildBootstrapProof({ fleetKey: 'short', fleetId, nonce: 'n' }), /32-byte/);
  });

  it('re-verifies a cached answer on read, so a hand-edited cache is useless', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const dir = mkdtempSync(join(tmpdir(), 'w2m-bootstrap-'));
    try {
      const file = join(dir, 'bootstrap.json');
      const answer = signAnswer(privateKey);
      writeBootstrapCache(file, { fleet_id: FLEET_ID, relays: RELAYS, issued_at: answer.issued_at, expires_at: answer.expires_at, signature: answer.signature });
      assert.equal(readBootstrapCache(file, { operatorPublicKeyPem: pem, fleetId: FLEET_ID }).ok, true);
      const edited = JSON.parse(readFileSync(file, 'utf8'));
      edited.relays = ['http://evil.example:8787'];
      writeFileSync(file, JSON.stringify(edited), 'utf8');
      assert.equal(readBootstrapCache(file, { operatorPublicKeyPem: pem, fleetId: FLEET_ID }).reason_code, BOOTSTRAP_REFUSAL.BAD_SIGNATURE);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('adopts a signed answer without a fleet key (v1.5.3 keyless assignment)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const answer = signAnswer(privateKey);
    // A machine that cannot derive a fleet key yet still needs its relays; the signature and expiry are
    // the whole trust decision, and joining the fleet remains a separate, account-keyed step.
    const keyless = verifyBootstrapAnswer(answer, { operatorPublicKeyPem: pem, fleetId: null });
    assert.equal(keyless.ok, true);
    assert.deepEqual(keyless.relays, RELAYS);
  });

  it('canonical payload sorts the relay list, so order cannot change the signed bytes silently', () => {
    const a = canonicalBootstrapPayload({ fleet_id: 'f', relays: ['http://b:1', 'http://a:1'], issued_at: 'i', expires_at: 'e' });
    const b = canonicalBootstrapPayload({ fleet_id: 'f', relays: ['http://a:1', 'http://b:1'], issued_at: 'i', expires_at: 'e' });
    assert.equal(a, b);
  });
});
