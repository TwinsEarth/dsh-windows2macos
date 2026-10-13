/**
 * The device keypair and the authorisation statement (v0.7.6).
 *
 * The properties under test, each of which is a way this kind of scheme is usually broken:
 *
 *   * **the fleet is inside the signature.** A device that edits `fleet_id` in its own statement
 *     must fail verification — otherwise "this device is in this fleet" is a claim, not a fact,
 *     and the isolation in v0.7.6 is decorative.
 *   * **a device cannot re-key itself.** Swapping `public_key` invalidates the statement, so a
 *     stolen statement cannot be paired with an attacker's key.
 *   * **the signature is over the exact bytes that travelled.** A verifier that re-serialised the
 *     object it received would be verifying its own encoding, and a reordered or reformatted
 *     statement would pass.
 *   * **expiry is mandatory.** A statement with no expiry is a permanent credential.
 *   * **a replayed request is refused.** Otherwise one captured request is valid until its clock
 *     window closes, for every identical request.
 *   * **the body is covered.** A signature that commits only to the method and path authorises
 *     the route while saying nothing about the payload — so a signed `GET` could carry any body.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual, generateKeyPairSync } from 'node:crypto';

import {
  createDeviceKey,
  canonicalStatement,
  canonicalRequest,
  hashBody,
  sealStatement,
  verifyStatement,
  signRequest,
  verifyRequest,
  verifyWith,
  safeEqual,
  createReplayGuard,
  deriveFleetKey,
  ALGORITHM,
  AUTH_REFUSAL,
  CLOCK_SKEW_MS,
  DEFAULT_TTL_MS,
} from '../src/chatops/auth.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const FLEET = '3f9a1c2e';
const SN = 'W2M-3f9a1c2e-7b4d0e91a3c5-20261014203015';

/** A relay-shaped signer/verifier over one fleet's key. */
function relaySigner(fleetId = FLEET) {
  const key = deriveFleetKey('master-secret-for-tests', fleetId);
  const mac = (canonical) => createHmac('sha256', key).update(canonical, 'utf8').digest();
  return {
    key,
    sign: mac,
    verify: (canonical, signature) => {
      const expected = mac(canonical);
      return expected.length === signature.length && timingSafeEqual(expected, signature);
    },
  };
}

/** A sealed statement for a device, issued by a relay. */
function issue({ device, fleetId = FLEET, now = NOW, ttlMs = DEFAULT_TTL_MS, over = {} } = {}) {
  const relay = relaySigner(fleetId);
  const statement = {
    algorithm: ALGORITHM,
    fleet_id: fleetId,
    machine_id: device.machineId,
    sn: SN,
    public_key: device.publicKeyPem,
    issued_at_ms: now,
    expires_at_ms: now + ttlMs,
    ...over,
  };
  return { relay, sealed: sealStatement({ statement, sign: relay.sign }) };
}

describe('the statement commits to the fleet, the machine and the key', () => {
  it('issues and verifies a well-formed statement', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device });
    const result = verifyStatement({ sealed, verify: relay.verify, now: NOW, expectFleet: FLEET, expectMachine: 'm-1' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.statement.fleet_id, FLEET);
  });

  it('refuses a device that edits its own fleet id', () => {
    // The property the whole isolation depends on. Without it a device joins any fleet it likes.
    const device = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device });
    sealed.statement.fleet_id = 'deadbeef';
    const result = verifyStatement({ sealed, verify: relay.verify, now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.MALFORMED, 'the canonical form no longer matches the statement');
  });

  it('refuses a device that swaps in its own public key', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const attacker = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device });
    sealed.statement.public_key = attacker.publicKeyPem;
    const result = verifyStatement({ sealed, verify: relay.verify, now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.MALFORMED);
  });

  it('refuses a statement signed by another fleet key', () => {
    // Deriving a per-fleet key means one relay's compromise does not sign for another fleet.
    const device = createDeviceKey({ machineId: 'm-1' });
    const other = relaySigner('a-different-fleet');
    const { sealed } = issue({ device });
    const result = verifyStatement({ sealed, verify: other.verify, now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.BAD_SIGNATURE);
  });

  it('refuses a statement whose canonical bytes were replaced', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device, fleetId: FLEET });
    // Attach a *valid* signature for a *different* statement.
    const other = issue({ device, fleetId: FLEET, over: { machine_id: 'm-2' } });
    sealed.canonical = other.sealed.canonical;
    sealed.signature = other.sealed.signature;
    const result = verifyStatement({ sealed, verify: relay.verify, now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.MALFORMED, 'a signature for another statement must not transfer');
  });

  it('refuses an unknown algorithm rather than accepting it on trust', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device, over: { algorithm: 'none' } });
    const result = verifyStatement({ sealed, verify: () => true, now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.WRONG_ALGORITHM);
    void relay;
  });

  it('refuses a mismatched expected fleet or machine', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device });
    assert.equal(verifyStatement({ sealed, verify: relay.verify, now: NOW, expectFleet: 'other' }).reason, AUTH_REFUSAL.FLEET_MISMATCH);
    assert.equal(verifyStatement({ sealed, verify: relay.verify, now: NOW, expectMachine: 'm-2' }).reason, AUTH_REFUSAL.MACHINE_MISMATCH);
  });

  it('refuses garbage without throwing', () => {
    const relay = relaySigner();
    for (const bad of [null, undefined, 42, {}, { statement: {} }, { statement: {}, canonical: 1, signature: 'x' }]) {
      const result = verifyStatement({ sealed: bad, verify: relay.verify, now: NOW });
      assert.equal(result.ok, false, `${JSON.stringify(bad)} should be refused`);
    }
  });
});

describe('expiry is mandatory', () => {
  it('refuses an expired statement', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device, ttlMs: 1000 });
    const result = verifyStatement({ sealed, verify: relay.verify, now: NOW + 2000 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.EXPIRED);
  });

  it('refuses a statement with no expiry at all', () => {
    // A permanent credential cannot be aged out. Defaulting to "never expires" is how a scheme
    // like this becomes irrevocable by accident.
    //
    // The canonical string and signature are built by hand here, because `canonicalStatement`
    // refuses a statement with a missing field — which is exactly why `verifyStatement` checks
    // expiry *before* recomputing, so this case gets the actionable reason rather than `malformed`.
    const device = createDeviceKey({ machineId: 'm-1' });
    const relay = relaySigner();
    const statement = {
      algorithm: ALGORITHM,
      fleet_id: FLEET,
      machine_id: device.machineId,
      sn: SN,
      public_key: device.publicKeyPem,
      issued_at_ms: NOW,
      // no expires_at_ms
    };
    const canonical = Object.entries(statement)
      .map(([k, v]) => `${k}:${Buffer.byteLength(String(v), 'utf8')}:${v}`)
      .join('\n');
    const sealed = { statement, canonical, signature: relay.sign(canonical).toString('base64') };
    const result = verifyStatement({ sealed, verify: relay.verify, now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.NO_EXPIRY, 'a missing expiry is a refusal, not a default');
  });

  it('names a future-issued statement differently from an expired one', () => {
    // The two have different fixes: one is a clock, the other is a renewal.
    const device = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device, now: NOW + 600_000, ttlMs: DEFAULT_TTL_MS });
    const result = verifyStatement({ sealed, verify: relay.verify, now: NOW });
    assert.equal(result.reason, AUTH_REFUSAL.NOT_YET_VALID);
  });

  it('accepts a statement inside its window', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const { relay, sealed } = issue({ device });
    assert.equal(verifyStatement({ sealed, verify: relay.verify, now: NOW + 1000 }).ok, true);
  });
});

describe('the canonical form is unambiguous', () => {
  it('length-prefixes fields, so a shifted boundary is a different string', () => {
    // Without length prefixes, {a:'x', b:'yz'} and {a:'xy', b:'z'} concatenate identically.
    const a = canonicalStatement({ algorithm: ALGORITHM, fleet_id: 'ab', machine_id: 'c', sn: 's', public_key: 'k', issued_at_ms: 1, expires_at_ms: 2 });
    const b = canonicalStatement({ algorithm: ALGORITHM, fleet_id: 'a', machine_id: 'bc', sn: 's', public_key: 'k', issued_at_ms: 1, expires_at_ms: 2 });
    assert.notEqual(a, b);
  });

  it('is stable regardless of the order keys were set', () => {
    const base = { algorithm: ALGORITHM, fleet_id: FLEET, machine_id: 'm', sn: SN, public_key: 'k', issued_at_ms: 1, expires_at_ms: 2 };
    const reordered = { expires_at_ms: 2, issued_at_ms: 1, public_key: 'k', sn: SN, machine_id: 'm', fleet_id: FLEET, algorithm: ALGORITHM };
    assert.equal(canonicalStatement(base), canonicalStatement(reordered));
  });

  it('refuses to canonicalise a statement missing a signed field', () => {
    assert.throws(() => canonicalStatement({ algorithm: ALGORITHM, fleet_id: FLEET }), /missing machine_id/);
  });

  it('makes the body hash part of the request signature', () => {
    const a = canonicalRequest({ method: 'POST', path: '/v1/task', timestampMs: 1, nonce: 'n', bodyHash: hashBody({ a: 1 }) });
    const b = canonicalRequest({ method: 'POST', path: '/v1/task', timestampMs: 1, nonce: 'n', bodyHash: hashBody({ a: 2 }) });
    assert.notEqual(a, b, 'a different body must produce a different signed string');
  });
});

describe('requests are signed per call', () => {
  it('verifies a signed request', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const body = { command_argv: ['node', '--test'] };
    const signed = signRequest({ device, method: 'POST', path: '/v1/task', body, now: NOW });
    const result = verifyRequest({
      headers: {
        'x-w2m-timestamp': String(signed.timestampMs),
        'x-w2m-nonce': signed.nonce,
        'x-w2m-signature': signed.signature,
        'x-w2m-body-hash': signed.bodyHash,
      },
      publicKeyPem: device.publicKeyPem,
      method: 'POST',
      path: '/v1/task',
      body,
      now: NOW,
    });
    assert.equal(result.ok, true, result.reason);
  });

  it('refuses a tampered body', () => {
    // A signature over the route alone would authorise any payload on it.
    const device = createDeviceKey({ machineId: 'm-1' });
    const signed = signRequest({ device, method: 'POST', path: '/v1/task', body: { command_argv: ['node', '--test'] }, now: NOW });
    const result = verifyRequest({
      headers: { 'x-w2m-timestamp': String(signed.timestampMs), 'x-w2m-nonce': signed.nonce, 'x-w2m-signature': signed.signature, 'x-w2m-body-hash': signed.bodyHash },
      publicKeyPem: device.publicKeyPem,
      method: 'POST',
      path: '/v1/task',
      body: { command_argv: ['rm', '-rf', '/'] },
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.BAD_SIGNATURE);
  });

  it('refuses a tampered path or method', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const signed = signRequest({ device, method: 'GET', path: '/v1/devices', now: NOW });
    const headers = { 'x-w2m-timestamp': String(signed.timestampMs), 'x-w2m-nonce': signed.nonce, 'x-w2m-signature': signed.signature, 'x-w2m-body-hash': signed.bodyHash };
    assert.equal(verifyRequest({ headers, publicKeyPem: device.publicKeyPem, method: 'GET', path: '/v1/tasks', now: NOW }).ok, false);
    assert.equal(verifyRequest({ headers, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/devices', now: NOW }).ok, false);
  });

  it('refuses a request signed by a different device', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const other = createDeviceKey({ machineId: 'm-2' });
    const signed = signRequest({ device, method: 'GET', path: '/v1/devices', now: NOW });
    const result = verifyRequest({
      headers: { 'x-w2m-timestamp': String(signed.timestampMs), 'x-w2m-nonce': signed.nonce, 'x-w2m-signature': signed.signature, 'x-w2m-body-hash': signed.bodyHash },
      publicKeyPem: other.publicKeyPem,
      method: 'GET',
      path: '/v1/devices',
      now: NOW,
    });
    assert.equal(result.reason, AUTH_REFUSAL.BAD_SIGNATURE);
  });

  it('refuses a request outside the clock window', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const signed = signRequest({ device, method: 'GET', path: '/v1/devices', now: NOW });
    const result = verifyRequest({
      headers: { 'x-w2m-timestamp': String(signed.timestampMs), 'x-w2m-nonce': signed.nonce, 'x-w2m-signature': signed.signature, 'x-w2m-body-hash': signed.bodyHash },
      publicKeyPem: device.publicKeyPem,
      method: 'GET',
      path: '/v1/devices',
      now: NOW + CLOCK_SKEW_MS + 1,
    });
    assert.equal(result.reason, AUTH_REFUSAL.CLOCK_SKEW);
  });

  it('refuses a replay through the injected guard', () => {
    // Without this, one captured request is valid for the whole clock window, repeatedly.
    const device = createDeviceKey({ machineId: 'm-1' });
    const remember = createReplayGuard({ now: () => NOW });
    const signed = signRequest({ device, method: 'GET', path: '/v1/devices', now: NOW, mintNonce: () => 'fixed-nonce' });
    const headers = { 'x-w2m-timestamp': String(signed.timestampMs), 'x-w2m-nonce': signed.nonce, 'x-w2m-signature': signed.signature, 'x-w2m-body-hash': signed.bodyHash };
    assert.equal(verifyRequest({ headers, publicKeyPem: device.publicKeyPem, method: 'GET', path: '/v1/devices', now: NOW, rememberNonce: remember }).ok, true);
    const second = verifyRequest({ headers, publicKeyPem: device.publicKeyPem, method: 'GET', path: '/v1/devices', now: NOW, rememberNonce: remember });
    assert.equal(second.ok, false);
    assert.match(second.detail, /already used/);
  });

  it('refuses a missing signature rather than treating it as unsigned-but-fine', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const result = verifyRequest({ headers: {}, publicKeyPem: device.publicKeyPem, method: 'GET', path: '/v1/devices', now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.reason, AUTH_REFUSAL.MALFORMED);
  });
});

describe('the replay guard is bounded', () => {
  it('forgets nonces older than the window', () => {
    let clock = NOW;
    const remember = createReplayGuard({ windowMs: 1000, now: () => clock });
    assert.equal(remember('a', clock), true);
    assert.equal(remember('a', clock), false);
    clock += 2000;
    // The nonce aged out, so it is accepted again — which is correct, because the timestamp check
    // would have refused a request that old long before this point.
    assert.equal(remember('a', clock), true);
  });
});

describe('the device key', () => {
  it('generates an ed25519 keypair', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    assert.equal(device.generated, true);
    assert.match(device.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.match(device.privateKeyPem, /BEGIN PRIVATE KEY/);
  });

  it('reuses a supplied private key, so a restart keeps its identity', () => {
    const first = createDeviceKey({ machineId: 'm-1' });
    const second = createDeviceKey({ machineId: 'm-1', privateKeyPem: first.privateKeyPem });
    assert.equal(second.publicKeyPem, first.publicKeyPem);
    assert.equal(second.generated, false);
  });

  it('refuses a key of the wrong type rather than downgrading silently', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    assert.throws(() => createDeviceKey({ privateKeyPem: pem }), /must be ed25519/);
  });

  it('verifies its own signature and rejects a foreign one', () => {
    const device = createDeviceKey({ machineId: 'm-1' });
    const other = createDeviceKey({ machineId: 'm-2' });
    const signature = device.sign('payload');
    assert.equal(verifyWith(device.publicKeyPem, 'payload', signature), true);
    assert.equal(verifyWith(other.publicKeyPem, 'payload', signature), false);
    assert.equal(verifyWith(device.publicKeyPem, 'other', signature), false);
  });

  it('treats an unparseable key or signature as a failed verification, not a crash', () => {
    assert.equal(verifyWith('not a key', 'x', Buffer.from('y')), false);
    assert.equal(verifyWith(createDeviceKey().publicKeyPem, 'x', Buffer.from('nonsense')), false);
  });
});

describe('the fleet key is derived per fleet', () => {
  it('gives different fleets different keys from one master secret', () => {
    // One relay serves many accounts without holding a key per account, and a compromise of one
    // fleet's key does not sign for another.
    const a = deriveFleetKey('master', 'fleet-a');
    const b = deriveFleetKey('master', 'fleet-b');
    assert.notEqual(a.toString('hex'), b.toString('hex'));
    assert.equal(a.toString('hex'), deriveFleetKey('master', 'fleet-a').toString('hex'));
  });

  it('refuses an empty secret or fleet', () => {
    assert.throws(() => deriveFleetKey('', 'f'), /master secret/);
    assert.throws(() => deriveFleetKey('s', ''), /fleet id/);
  });
});

describe('constant-time comparison', () => {
  it('compares equal and unequal strings', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
  });

  it('refuses non-strings', () => {
    assert.equal(safeEqual(null, 'a'), false);
    assert.equal(safeEqual('a', undefined), false);
  });
});
