/**
 * BLAKE2s-256: the portable handshake hash.
 *
 * ## What went wrong, recorded here because it is instructive
 *
 * The first version of the fallback inverted **both** `v[14]` and `v[15]` for the final block. BLAKE2 sets
 * `f0 = 0xFFFFFFFF` on the last block and leaves `f1 = 0` for sequential hashing (it is only 1 for the last node of a
 * tree). Inverting `v[15]` too yields a **stable, plausible-looking digest that matches no reference** -- so the three
 * RFC vectors failed while the compression function, checked against another implementation, was correct the whole
 * time. These tests exist so that class of mistake cannot survive again: the vectors are fixed values, and the
 * implementation is compared against an independent one over many lengths.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, getHashes } from 'node:crypto';
import { BLAKE2S_VECTORS, blake2s256 } from '../src/agent/blake2s.mjs';
import { blake2s256Support, cryptoCapabilities, handshakeHash } from '../src/agent/crypto.mjs';

describe('BLAKE2s-256 matches the published vectors', () => {
  for (const vector of BLAKE2S_VECTORS) {
    it(`hashes ${JSON.stringify(vector.input.slice(0, 24))} to the RFC value`, () => {
      assert.equal(blake2s256(vector.input).toString('hex'), vector.hex);
    });
  }

  it('hashes a Buffer, a Uint8Array and a string to the same bytes', () => {
    const text = 'the same input through three doorways';
    const fromBuffer = blake2s256(Buffer.from(text, 'utf8')).toString('hex');
    const fromBytes = blake2s256(new TextEncoder().encode(text)).toString('hex');
    assert.equal(blake2s256(text).toString('hex'), fromBuffer);
    assert.equal(fromBytes, fromBuffer);
  });

  it('produces 32 bytes, always', () => {
    for (const length of [0, 1, 63, 64, 65, 1000]) {
      assert.equal(blake2s256(Buffer.alloc(length)).length, 32);
    }
  });

  it('is not a constant function: one differing byte changes the digest', () => {
    const a = Buffer.alloc(64, 0);
    const b = Buffer.alloc(64, 0);
    b[63] = 1;
    assert.notEqual(blake2s256(a).toString('hex'), blake2s256(b).toString('hex'));
  });
});

describe('the fallback agrees with the native digest wherever both exist', () => {
  const nativeAvailable = (() => {
    try {
      return getHashes().includes('blake2s256');
    } catch {
      return false;
    }
  })();

  it('matches node:crypto across block boundaries and beyond', { skip: nativeAvailable ? false : 'no native blake2s256 on this runtime' }, () => {
    // The boundaries are the point: 63/64/65 and 127/128/129 are where the final-block padding logic can go wrong.
    for (const length of [0, 1, 2, 3, 31, 32, 33, 63, 64, 65, 127, 128, 129, 191, 192, 193, 255, 256, 257, 1000]) {
      const input = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) input[i] = (i * 37 + length) & 0xff;
      assert.equal(
        blake2s256(input).toString('hex'),
        createHash('blake2s256').update(input).digest('hex'),
        `length ${length}`,
      );
    }
  });
});

describe('the handshake hash uses it, and reports how', () => {
  it('handshakeHash is BLAKE2s-256 of the concatenated parts', () => {
    assert.equal(
      handshakeHash('abc').toString('hex'),
      '508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982',
    );
    // Parts are concatenated, not hashed separately: the digest of "ab"+"c" equals that of "abc".
    assert.equal(handshakeHash('ab', 'c').toString('hex'), handshakeHash('abc').toString('hex'));
  });

  it('the support report names a source and never claims a silent substitute', () => {
    const support = blake2s256Support();
    assert.equal(support.ok, true, 'this runtime must be able to compute the handshake hash');
    assert.ok(['native', 'js-fallback'].includes(support.source), `unexpected source ${support.source}`);
    assert.match(support.detail, /BLAKE2s-256/);
  });

  it('cryptoCapabilities counts BLAKE2s as present when the fallback works', () => {
    const caps = cryptoCapabilities();
    assert.ok(caps.present.includes('blake2s256'), `present: ${caps.present.join(',')}`);
    assert.equal(caps.ok, true, `missing: ${caps.missing.join(',')}`);
  });
});
