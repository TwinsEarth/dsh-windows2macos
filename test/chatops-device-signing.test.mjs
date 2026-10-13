/**
 * Per-device Ed25519 request signing (v0.7.10).
 *
 * The property that matters most here is not "a signature verifies" — it is that the **signed bytes
 * are the relay's own bytes**. The relay already has a canonical string, and a device that signs a
 * *different* string produces a signature that verifies nowhere and says nothing about why.
 *
 * That is not hypothetical: the first version of this module hashed the body with
 * `createHash('sha256')`, while the relay uses `createHmac('sha256', Buffer.alloc(0))`. Those
 * differ by construction — `e3b0c442…` against `b613679a…` — so every signature would have failed
 * forever. The byte-comparison test below is what caught it, and it is the reason this file exists
 * in the shape it does.
 *
 * The second property is that a device key proves something a shared secret cannot: that **this**
 * device signed, rather than that the sender knows a secret every device knows.
 */

import { describe, it } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';

import {
  canonicalString,
  createDeviceSigner,
  verifyDeviceSignature,
  formatSignature,
  parseSignature,
  SIGNATURE_VERSION,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
} from '../src/chatops/device-signing.mjs';

// The relay's own implementation. Importing it rather than reimplementing the expectation is the
// whole point: the test compares against the code that will actually verify.
import { canonicalString as relayCanonical } from '../src/signing.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);

describe('the signed bytes are the relay\'s bytes', () => {
  it('is byte-identical to the relay for the shapes that occur', () => {
    // The comparison that caught the HMAC-versus-hash mistake.
    const cases = [
      { method: 'POST', path: '/v1/task', timestamp: 1791916000, nonce: 'a'.repeat(16), body: '{"mode":"replicate"}' },
      { method: 'get', path: '/v1/devices?limit=5', timestamp: 1, nonce: 'b'.repeat(16), body: '' },
      { method: 'PUT', path: '/', timestamp: 1791916000, nonce: 'c'.repeat(10), body: Buffer.from('bytes') },
      { method: 'POST', path: '/v1/result', timestamp: 1791916000, nonce: 'd'.repeat(32), body: '{}' },
      { method: 'DELETE', path: '/v1/tasks/x', timestamp: 1791916000, nonce: 'e'.repeat(8), body: '' },
    ];
    for (const c of cases) {
      assert.equal(
        canonicalString(c),
        relayCanonical(c),
        `${c.method} ${c.path} differs -- a signature over it would verify nowhere`,
      );
    }
  });

  it('hashes the body with a zero-length HMAC key, not a plain sha256', () => {
    // Stated separately because it is the specific mistake, and a future "simplification" to
    // createHash would pass every other test in this file.
    const canonical = canonicalString({ method: 'GET', path: '/', timestamp: 1, nonce: 'n'.repeat(16), body: '' });
    const hash = canonical.split('\n').at(-1);
    assert.equal(hash, 'b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad', 'HMAC key="" of the empty body');
    assert.notEqual(hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'which is sha256("")');
  });

  it('uppercases the method, so get and GET sign the same', () => {
    const lower = canonicalString({ method: 'get', path: '/x', timestamp: 1, nonce: 'n'.repeat(16) });
    const upper = canonicalString({ method: 'GET', path: '/x', timestamp: 1, nonce: 'n'.repeat(16) });
    assert.equal(lower, upper);
  });

  it('includes the query string in the path, because that is what was routed', () => {
    const withQuery = canonicalString({ method: 'GET', path: '/v1/devices?limit=5', timestamp: 1, nonce: 'n'.repeat(16) });
    const without = canonicalString({ method: 'GET', path: '/v1/devices', timestamp: 1, nonce: 'n'.repeat(16) });
    assert.notEqual(withQuery, without);
  });

  it('binds the body, so a signed route cannot carry a different payload', () => {
    const a = canonicalString({ method: 'POST', path: '/v1/task', timestamp: 1, nonce: 'n'.repeat(16), body: '{"a":1}' });
    const b = canonicalString({ method: 'POST', path: '/v1/task', timestamp: 1, nonce: 'n'.repeat(16), body: '{"a":2}' });
    assert.notEqual(a, b);
  });
});

describe('a device signs and the relay verifies', () => {
  const sign = (over = {}) => {
    const device = createDeviceSigner();
    const { headers } = device.signRequest({ method: 'POST', path: '/v1/task', body: '{"a":1}', ...over });
    return { device, headers };
  };

  it('verifies a well-formed signature', () => {
    const { device, headers } = sign();
    const result = verifyDeviceSignature({ headers, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.device, true, 'the caller can tell a device signed rather than a shared secret');
  });

  it('refuses a tampered body', () => {
    const { device, headers } = sign();
    const result = verifyDeviceSignature({ headers, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":2}' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SIGNATURE_BAD');
  });

  it('refuses a tampered path or method', () => {
    const { device, headers } = sign();
    const h = { ...headers };
    assert.equal(verifyDeviceSignature({ headers: h, publicKeyPem: device.publicKeyPem, method: 'GET', path: '/v1/task', body: '{"a":1}' }).ok, false);
    assert.equal(verifyDeviceSignature({ headers: h, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/other', body: '{"a":1}' }).ok, false);
  });

  it('refuses another device\'s signature', () => {
    // The property a shared secret cannot provide: knowing the secret is not the same as being
    // this device.
    const { headers } = sign();
    const other = createDeviceSigner();
    const result = verifyDeviceSignature({ headers, publicKeyPem: other.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SIGNATURE_BAD');
  });

  it('refuses an incomplete signature, naming the missing parts', () => {
    const { device, headers } = sign();
    for (const drop of [SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER]) {
      const partial = { ...headers };
      delete partial[drop];
      const result = verifyDeviceSignature({ headers: partial, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}' });
      assert.equal(result.ok, false, `dropping ${drop} must fail`);
      assert.equal(result.code, 'SIGNATURE_INCOMPLETE');
    }
  });

  it('refuses a signature outside the clock window, before verifying it', () => {
    const { device, headers } = sign({ timestamp: nowSec() - 3600 });
    const result = verifyDeviceSignature({ headers, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}' });
    assert.equal(result.code, 'SIGNATURE_SKEW');
  });

  it('refuses a short nonce', () => {
    const { device, headers } = sign({ nonce: 'short' });
    const result = verifyDeviceSignature({ headers, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}' });
    assert.equal(result.code, 'SIGNATURE_BAD_NONCE');
  });

  it('refuses a timestamp in milliseconds rather than seconds', () => {
    // A device that sends `Date.now()` produces a timestamp the relay reads as ~58000 years in the
    // future. It looks like a clock problem and is a unit problem, so the error names skew.
    const { device, headers } = sign({ timestamp: Date.now() });
    const result = verifyDeviceSignature({ headers, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SIGNATURE_SKEW');
  });

  it('refuses a replay through the injected nonce store', () => {
    const seen = new Set();
    const remember = (nonce) => (seen.has(nonce) ? false : (seen.add(nonce), true));
    const { device, headers } = sign({ nonce: 'fixed-nonce-1234' });

    const first = verifyDeviceSignature({ headers, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}', nonces: remember });
    assert.equal(first.ok, true);
    const second = verifyDeviceSignature({ headers, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}', nonces: remember });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'SIGNATURE_REPLAY');
  });

  it('treats an unparseable key as a failed verification, not a crash', () => {
    const { headers } = sign();
    const result = verifyDeviceSignature({ headers, publicKeyPem: 'not a key', method: 'POST', path: '/v1/task', body: '{"a":1}' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SIGNATURE_BAD');
  });

  it('reads headers case-insensitively, as Node delivers them', () => {
    const { device, headers } = sign();
    const upper = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toUpperCase(), v]));
    assert.equal(
      verifyDeviceSignature({ headers: upper, publicKeyPem: device.publicKeyPem, method: 'POST', path: '/v1/task', body: '{"a":1}' }).ok,
      true,
    );
  });
});

describe('the device key', () => {
  it('generates an ed25519 key and reports it', () => {
    const device = createDeviceSigner();
    assert.equal(device.generated, true);
    assert.match(device.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.match(device.privateKeyPem, /BEGIN PRIVATE KEY/);
  });

  it('reuses a supplied private key, so a restart keeps its identity', () => {
    const first = createDeviceSigner();
    const second = createDeviceSigner({ privateKeyPem: first.privateKeyPem });
    assert.equal(second.publicKeyPem, first.publicKeyPem);
    assert.equal(second.generated, false);
  });

  it('refuses a non-ed25519 key rather than downgrading silently', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(
      () => createDeviceSigner({ privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
      /must be ed25519/,
    );
  });
});

describe('the signature format', () => {
  it('formats and parses as v1=<hex>', () => {
    assert.equal(formatSignature('deadbeef'), 'v1=deadbeef');
    assert.deepEqual(parseSignature('v1=DEADBEEF'), { version: 'v1', hex: 'deadbeef' });
    assert.equal(SIGNATURE_VERSION, 'v1');
  });

  it('refuses anything that is not that shape', () => {
    for (const bad of ['', 'deadbeef', 'v1=', 'v1=xyz', '=dead', null, undefined, 42]) {
      assert.equal(parseSignature(bad), null, `${bad} should not parse`);
    }
  });

  it('refuses a version it does not know, rather than guessing', () => {
    const device = createDeviceSigner();
    const { headers } = device.signRequest({ method: 'GET', path: '/x' });
    const result = verifyDeviceSignature({
      headers: { ...headers, [SIGNATURE_HEADER]: headers[SIGNATURE_HEADER].replace('v1=', 'v9=') },
      publicKeyPem: device.publicKeyPem,
      method: 'GET',
      path: '/x',
    });
    assert.equal(result.code, 'SIGNATURE_VERSION');
  });
});
