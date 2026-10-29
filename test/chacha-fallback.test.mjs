import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { jsOpen, jsSeal } from '../src/agent/chacha.mjs';
import { nativeAeadAvailable } from '../src/agent/crypto.mjs';

describe('ChaCha20-Poly1305 JS fallback', () => {
  it('round-trips and rejects a tampered tag', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const plaintext = randomBytes(257);
    const aad = Buffer.from('frame-header');
    const sealed = jsSeal(key, nonce, plaintext, aad);
    assert.equal(sealed.length, plaintext.length + 16);
    assert.deepEqual(jsOpen(key, nonce, sealed, aad), plaintext);
    const tampered = Buffer.from(sealed);
    tampered[0] ^= 0xff;
    assert.equal(jsOpen(key, nonce, tampered, aad), null);
    assert.equal(jsOpen(key, nonce, sealed, Buffer.from('other')), null);
  });

  it('matches the native AEAD byte-for-byte when OpenSSL has it', () => {
    if (!nativeAeadAvailable()) return;
    for (const size of [0, 1, 15, 16, 63, 64, 65, 1024]) {
      const key = randomBytes(32);
      const nonce = randomBytes(12);
      const plaintext = randomBytes(size);
      const aad = Buffer.from('aad-' + size);
      const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad);
      const nativeSealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      const fallback = jsSeal(key, nonce, plaintext, aad);
      assert.deepEqual(fallback, nativeSealed, 'size ' + size);
    }
  });
});
