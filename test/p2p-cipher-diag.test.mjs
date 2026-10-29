import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cryptoCapabilities, nativeAeadAvailable, openMac, sealMac } from '../src/agent/crypto.mjs';

describe('cipher availability and diagnostics', () => {
  it('provides a working chacha20-poly1305 (native or JS fallback)', () => {
    const capabilities = cryptoCapabilities();
    assert.equal(capabilities.ok, true, JSON.stringify(capabilities.missing ?? null));
    assert.ok(capabilities.present.includes('chacha20-poly1305'));
    const key = Buffer.alloc(32, 7);
    const message = Buffer.from('fallback-roundtrip');
    const sealed = sealMac(key, message);
    assert.equal(sealed.length, message.length + 16);
    assert.deepEqual(openMac(key, sealed), message);
  });

  it('reports cipher/suite/key length when native OpenSSL refuses a cipher', () => {
    if (!nativeAeadAvailable()) return; // the JS fallback deliberately accepts the operation
    let error = null;
    try {
      sealMac(Buffer.alloc(31), Buffer.from('x'), { suite: 'w2m-p2p-v1', peerKey: 'fingerprint:abc' });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, 'a short key must throw');
    assert.equal(error.code, 'P2P_CIPHER_UNAVAILABLE');
    assert.equal(error.detail.cipher, 'chacha20-poly1305');
    assert.equal(error.detail.suite, 'w2m-p2p-v1');
    assert.equal(error.detail.peerKey, 'fingerprint:abc');
    assert.equal(error.detail.keyLength, 31);
    assert.match(String(error.detail.openssl), /key|length/i);
    assert.equal(typeof error.detail.node, 'string');
  });
});
