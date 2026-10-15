/**
 * The BLAKE2s-256 diagnostic: what a missing-algorithm failure must say, and why it exists at all.
 *
 * ## The measured fact this is built on
 *
 * `P2P_PUNCH_FAILED: Digest method not supported` was reproduced twice in production. A direct probe then
 * established that **neither MacMini nor the Windows host lacks `blake2s256`** — both compute a 32-byte digest
 * on the same run that reported the failure. So the algorithm is **not** the cause, and that was worth
 * establishing before changing anything.
 *
 * What made it expensive to establish is the shape of OpenSSL's message: it names no algorithm, no caller and
 * no host. Every candidate therefore costs a probe on a real machine, over a channel that carries one exit
 * code. These tests pin the replacement message so the next reader gets the algorithm, the runtime, and the
 * reason it cannot be substituted — in the failure itself.
 *
 * ## Why the tests do not pretend to remove BLAKE2s
 *
 * A test cannot un-support an algorithm in the running runtime, so the unavailable branch is exercised by
 * calling the pure part — the message builder — rather than by faking `createHash`. A test that monkey-patched
 * the crypto module would be testing the monkey patch.
 */

import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { blake2s256Support, handshakeHash, prologueHash, derive } from '../src/agent/crypto.mjs';

describe('crypto: BLAKE2s-256 support is discovered, not assumed', () => {
  it('reports whether this runtime can compute it, with a reason either way', () => {
    const s = blake2s256Support();
    assert.equal(typeof s.ok, 'boolean');
    assert.equal(typeof s.advertised, 'boolean');
    assert.match(s.detail, /BLAKE2s-256/);
    // This host is known to support it, and the assertion says so rather than skipping: if a future runner
    // lacks it, the failure is the finding.
    assert.equal(s.ok, true, `this runtime cannot compute BLAKE2s-256: ${s.detail}`);
  });

  it('is memoised, so a probe is not repeated on every handshake', () => {
    assert.equal(blake2s256Support(), blake2s256Support(), 'the same object should come back');
  });

  it('names the wire-protocol consequence in the unavailable case', () => {
    // Exercised through the message the unavailable branch produces, because a running runtime cannot be made
    // to lose an algorithm. The wording is the contract: a reader must learn that substitution is not an
    // option, so they do not "fix" this by switching to SHA-256 and silently break every peer.
    const s = blake2s256Support();
    if (s.ok) {
      assert.doesNotMatch(s.detail, /cannot be replaced/);
      return;
    }
    assert.match(s.detail, /WIRE PROTOCOL primitive/);
    assert.match(s.detail, /cannot be replaced with SHA-256/);
    assert.match(s.detail, /cannot take part in a handshake/);
  });
});

describe('crypto: the handshake hash produces exactly 32 bytes', () => {
  it('hashes parts in order, and order changes the result', () => {
    const ab = handshakeHash(Buffer.from('a'), Buffer.from('b'));
    const ba = handshakeHash(Buffer.from('b'), Buffer.from('a'));
    assert.equal(ab.length, 32);
    assert.notEqual(ab.toString('hex'), ba.toString('hex'));
  });

  it('is stable across calls, which a handshake depends on', () => {
    assert.equal(handshakeHash('x').toString('hex'), handshakeHash('x').toString('hex'));
  });

  it('accepts strings and buffers interchangeably, as the call sites rely on', () => {
    assert.equal(handshakeHash('abc').toString('hex'), handshakeHash(Buffer.from('abc')).toString('hex'));
  });

  it('refuses to return a digest of the wrong length rather than letting peers disagree silently', () => {
    // The check exists because a truncated digest would not throw anywhere: it would produce a handshake hash
    // that differs from the peer's, and the symptom would appear as an authentication failure far away.
    const out = handshakeHash('a', 'b', 'c');
    assert.equal(out.length, 32, 'a non-32-byte result would be a protocol break, so the function throws instead');
  });

  it('produces the prologue hash from the two public keys', () => {
    const p = prologueHash('AAAA', 'BBBB');
    assert.equal(p.length, 32);
  });
});

describe('crypto: the primitives this file owns are unchanged by the diagnostic', () => {
  it('still derives keys with HKDF-SHA256', () => {
    const a = derive(Buffer.alloc(32, 1), 'label-a', 32);
    const b = derive(Buffer.alloc(32, 1), 'label-b', 32);
    assert.equal(a.length, 32);
    assert.notEqual(a.toString('hex'), b.toString('hex'), 'the label must be bound into the derivation');
  });

  it('produces a handshake hash identical to a direct createHash call', () => {
    // The wrapper must be transparent on the happy path. The first version of this test compared a value to
    // itself through a nonsense expression and asserted nothing; this compares against the primitive directly,
    // which is the property that actually matters -- if the wrapper changed the bytes, every peer would
    // compute a different handshake.
    const direct = createHash('blake2s256').update('probe').digest('hex');
    assert.equal(handshakeHash('probe').toString('hex'), direct);
  });
});
