/**
 * Request-signing tests (v0.3.0 搂9).
 *
 * Signing is the kind of feature whose tests matter more than usual, because a mistake does not look
 * like a mistake: if both sides are wrong in the same way, every request verifies and the scheme
 * protects nothing. So these tests deliberately check the properties that would still hold if the
 * whole thing were a no-op 鈥?a tampered body, a moved path, a replayed nonce, a stale timestamp 鈥? * rather than only checking that a signature round-trips.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SKEW_SECONDS,
  NONCE_HEADER,
  NonceCache,
  SIGNATURE_HEADER,
  SIGNATURE_VERSION,
  SignatureError,
  TIMESTAMP_HEADER,
  canonicalString,
  createSigner,
  normalizeSecret,
  signRequest,
  verifyRequest,
} from '../src/signing.mjs';

const SECRET = 'shared-secret-for-tests';
const NOW_MS = Date.parse('2026-10-08T00:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);

/**
 * Sign at one instant and verify at another, returning the verdict.
 *
 * `signAtMs` and `verifyAtMs` are separate on purpose: testing clock skew by moving only the signer
 * is the whole point, and a helper that moved both would make the skew tests vacuous.
 */
function roundTrip({
  secret = SECRET,
  secrets = [SECRET],
  method = 'POST',
  path = '/v1/result',
  body = '{"a":1}',
  signAtMs = NOW_MS,
  verifyAtMs = signAtMs,
  tamperHeaders = null,
  tamper = null,
  nonces = new NonceCache(),
  required = false,
  skewSeconds = DEFAULT_SKEW_SECONDS,
} = {}) {
  const signer = createSigner({ secret, now: () => signAtMs, makeNonce: () => 'nonce-0123456789ab' });
  let sentBody = body;
  let sentPath = path;
  let sentMethod = method;
  if (tamper === 'body') sentBody = '{"a":2}';
  if (tamper === 'path') sentPath = '/v1/task';
  if (tamper === 'method') sentMethod = 'GET';
  const headers = { ...signer.headers({ method, path, body }), ...(tamperHeaders ?? {}) };
  return verifyRequest({
    headers,
    method: sentMethod,
    path: sentPath,
    body: sentBody,
    secrets,
    nonces,
    nowMs: verifyAtMs,
    skewSeconds,
    required,
  });
}

describe('the signed string binds everything that matters', () => {
  it('covers the body, so a tampered payload fails', () => {
    assert.equal(roundTrip().ok, true, 'the untampered request must verify');
    const bad = roundTrip({ tamper: 'body' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'SIGNATURE_MISMATCH');
  });

  it('covers the path, so a signature cannot be moved to another endpoint', () => {
    const bad = roundTrip({ tamper: 'path' });
    assert.equal(bad.ok, false, 'a signature for /v1/result must not authorise /v1/task');
    assert.equal(bad.code, 'SIGNATURE_MISMATCH');
  });

  it('covers the method', () => {
    assert.equal(roundTrip({ tamper: 'method' }).ok, false);
  });

  it('treats an empty body and an absent body as the same thing', () => {
    // Otherwise every GET would need a body to be signable, which is not true of this protocol.
    assert.equal(roundTrip({ body: '' }).ok, true);
    assert.equal(roundTrip({ body: Buffer.alloc(0) }).ok, true);
  });

  it('signs bytes, not decoded text, so a non-UTF8-safe body is still bound', () => {
    const signer = createSigner({ secret: SECRET, now: () => NOW_MS, makeNonce: () => 'nonce-0123456789ab' });
    const body = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const headers = signer.headers({ method: 'POST', path: '/v1/result', body });
    assert.equal(verifyRequest({ headers, method: 'POST', path: '/v1/result', body, secrets: [SECRET], nonces: new NonceCache(), nowMs: NOW_MS }).ok, true);
    assert.equal(
      verifyRequest({ headers, method: 'POST', path: '/v1/result', body: Buffer.from([0xff, 0xfe, 0x00, 0x02]), secrets: [SECRET], nonces: new NonceCache(), nowMs: NOW_MS }).ok,
      false,
      'one flipped byte must be detectable',
    );
  });

  it('includes the query string in the path, so `?format=json` cannot become `?format=md`', () => {
    const a = canonicalString({ method: 'GET', path: '/v1/tasks/T/report?format=json', timestamp: NOW_S, nonce: 'n' });
    const b = canonicalString({ method: 'GET', path: '/v1/tasks/T/report?format=md', timestamp: NOW_S, nonce: 'n' });
    assert.notEqual(a, b);
  });

  it('is stable for identical input, which is what makes both sides agree', () => {
    const input = { method: 'post', path: '/v1/x', timestamp: NOW_S, nonce: 'abc', body: 'x' };
    assert.equal(canonicalString(input), canonicalString({ ...input, method: 'POST' }), 'method case must not matter');
  });

  it('names its version so the scheme can change without ambiguity', () => {
    assert.match(signRequest({ secret: SECRET, method: 'GET', path: '/', timestamp: NOW_S, nonce: 'abc' }), new RegExp(`^${SIGNATURE_VERSION}=[0-9a-f]{64}$`));
  });
});

describe('replay is refused by state, not by the clock alone', () => {
  it('accepts a nonce once and refuses it the second time', () => {
    const nonces = new NonceCache();
    assert.equal(roundTrip({ nonces }).ok, true);
    const again = roundTrip({ nonces });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'SIGNATURE_REPLAY');
  });

  it('the refusal survives a fresh, perfectly valid timestamp', () => {
    // This is the property that makes the nonce cache worth having: without it, a captured request
    // stays valid for the whole skew window and the window becomes the real security boundary.
    const nonces = new NonceCache();
    const first = roundTrip({ nonces, signAtMs: NOW_MS });
    assert.equal(first.ok, true);
    const later = roundTrip({ nonces, verifyAtMs: NOW_MS + 5000 });
    assert.equal(later.ok, false);
    assert.equal(later.code, 'SIGNATURE_REPLAY');
  });

  it('does not burn a nonce for a request whose signature did not match', () => {
    // Otherwise an attacker could replay a legitimate request's nonce first and make the genuine
    // request look like the replay.
    const nonces = new NonceCache();
    const forged = roundTrip({ nonces, secret: 'wrong-secret' });
    assert.equal(forged.ok, false);
    assert.equal(forged.code, 'SIGNATURE_MISMATCH');
    assert.equal(nonces.size, 0, 'a failed signature must not consume the nonce');
    assert.equal(roundTrip({ nonces }).ok, true, 'the genuine request must still work');
  });

  it('stays bounded under a flood and evicts oldest first', () => {
    const nonces = new NonceCache({ max: 3 });
    for (const n of ['a', 'b', 'c', 'd']) nonces.accept(n, NOW_MS);
    assert.equal(nonces.size, 3);
    // 'a' was evicted, so it is accepted again; the cache traded replay protection for memory, and
    // that trade is deliberate -- an unbounded map is a memory-exhaustion vector.
    assert.equal(nonces.accept('a', NOW_MS), true);
    assert.equal(nonces.accept('d', NOW_MS), false);
  });

  it('expires a nonce by age, so a long-lived relay does not remember forever', () => {
    // Without age expiry the map only ever grows between restarts, and every nonce the relay has
    // ever accepted stays in memory.
    const nonces = new NonceCache({ retentionMs: 60_000 });
    assert.equal(nonces.accept('once', NOW_MS), true);
    assert.equal(nonces.accept('once', NOW_MS + 1000), false, 'still remembered inside the window');
    // Past retention the entry is dropped -- by then the timestamp check rejects the old request
    // anyway, so replay protection is not weakened; the skew window is what bounds it.
    nonces.accept('later', NOW_MS + 61_000);
    assert.equal(nonces.size < 2, true, 'the stale entry was pruned');
  });

  it('bounds memory even when a flood arrives inside the retention window', () => {
    // Age alone is not a bound: a burst fits entirely inside the window. The count cap is what
    // keeps a hostile client from growing the map without limit.
    const nonces = new NonceCache({ max: 100, retentionMs: 60 * 60_000 });
    for (let i = 0; i < 5000; i += 1) nonces.accept(`flood-${i}`, NOW_MS);
    assert.equal(nonces.size, 100);
  });

  it('prunes by age because insertion order is chronological', () => {
    const nonces = new NonceCache();
    nonces.accept('old', NOW_MS - 10_000);
    nonces.accept('new', NOW_MS);
    nonces.prune(5000, NOW_MS);
    assert.equal(nonces.size, 1);
    assert.equal(nonces.accept('new', NOW_MS), false, 'the recent nonce must survive the prune');
  });
});

describe('clock skew is bounded and explained', () => {
  it('accepts a timestamp inside the window and refuses one outside it', () => {
    assert.equal(
      roundTrip({ verifyAtMs: NOW_MS + DEFAULT_SKEW_SECONDS * 1000 }).ok,
      true,
      'the edge is inclusive',
    );
    const late = roundTrip({ verifyAtMs: NOW_MS + (DEFAULT_SKEW_SECONDS + 1) * 1000 });
    assert.equal(late.ok, false);
    assert.equal(late.code, 'SIGNATURE_EXPIRED');
  });

  it('says how far off the clock is, so drift is distinguishable from an attack', () => {
    const late = roundTrip({ verifyAtMs: NOW_MS + 600_000 });
    assert.match(late.error, /600s/);
    assert.match(late.error, /window/);
  });

  it('accepts a signer whose clock is behind, not only ahead', () => {
    // Two machines in two cities; either one may be the fast one.
    assert.equal(roundTrip({ verifyAtMs: NOW_MS - 60_000 }).ok, true);
  });

  it('refuses a non-numeric timestamp instead of coercing it', () => {
    const res = roundTrip({ tamperHeaders: { [TIMESTAMP_HEADER]: 'soon' } });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SIGNATURE_BAD_TIMESTAMP');
  });
});

describe('malformed signed requests are refused, never downgraded to unsigned', () => {
  it('refuses a partially signed request', () => {
    // Falling back to "unsigned" here would let an attacker strip one header to disable verification.
    const partial = roundTrip({ tamperHeaders: { [NONCE_HEADER]: '' } });
    assert.equal(partial.ok, false);
    assert.equal(partial.code, 'SIGNATURE_INCOMPLETE');
  });

  it('refuses a too-short nonce', () => {
    const short = roundTrip({ tamperHeaders: { [NONCE_HEADER]: 'abc' } });
    assert.equal(short.ok, false);
    assert.equal(short.code, 'SIGNATURE_BAD_NONCE');
  });

  it('refuses a signature from the wrong secret', () => {
    const res = roundTrip({ secrets: ['a-different-secret'] });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SIGNATURE_MISMATCH');
  });
});

describe('key rotation', () => {
  it('accepts either the new or the previous secret and reports which matched', () => {
    // Rotation needs a window where both are valid, or every machine must be restarted at once.
    const withOld = roundTrip({ secret: 'old-secret', secrets: ['new-secret', 'old-secret'] });
    assert.equal(withOld.ok, true);
    assert.equal(withOld.keyIndex, 1, 'the matched key must be identifiable');

    const withNew = roundTrip({ secret: 'new-secret', secrets: ['new-secret', 'old-secret'] });
    assert.equal(withNew.ok, true);
    assert.equal(withNew.keyIndex, 0);
  });

  it('refuses a secret that is not in the accepted list', () => {
    assert.equal(roundTrip({ secret: 'retired', secrets: ['new-secret', 'old-secret'] }).ok, false);
  });
});

describe('unsigned requests keep working, until the relay insists', () => {
  it('accepts an unsigned request by default, reporting that it was unsigned', () => {
    // This is what makes v0.2.3 machines work against a v0.3.0 relay.
    const res = verifyRequest({ headers: {}, method: 'POST', path: '/v1/result', body: 'x', secrets: [SECRET], nonces: new NonceCache(), nowMs: NOW_MS });
    assert.equal(res.ok, true);
    assert.equal(res.signed, false);
    assert.equal(res.keyIndex, null);
  });

  it('refuses an unsigned request when signatures are required', () => {
    const res = verifyRequest({ headers: {}, method: 'POST', path: '/v1/result', body: 'x', secrets: [SECRET], nonces: new NonceCache(), nowMs: NOW_MS, required: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SIGNATURE_REQUIRED');
  });

  it('distinguishes "the relay forgot to configure a secret" from "the client failed"', () => {
    // A misconfigured relay must not look like a client problem, or the wrong side gets debugged.
    const res = verifyRequest({ headers: {}, method: 'POST', path: '/v1/result', body: 'x', secrets: [], nonces: new NonceCache(), nowMs: NOW_MS, required: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SIGNING_NOT_CONFIGURED');
  });

  it('accepts anything when no secret is configured and none is required', () => {
    const res = verifyRequest({ headers: {}, method: 'GET', path: '/healthz', secrets: [], nonces: new NonceCache(), nowMs: NOW_MS });
    assert.equal(res.ok, true);
    assert.equal(res.signed, false);
  });
});

describe('secrets and headers are handled defensively', () => {
  it('rejects an unusable secret instead of silently disabling signing', () => {
    for (const bad of [undefined, null, 42, {}, '']) {
      assert.throws(() => normalizeSecret(bad), (err) => err instanceof SignatureError && err.code === 'BAD_SECRET', `secret=${JSON.stringify(bad)}`);
    }
  });

  it('reads headers through a real Headers instance, which is what the relay has', () => {
    const signer = createSigner({ secret: SECRET, now: () => NOW_MS, makeNonce: () => 'nonce-0123456789ab' });
    const headers = new Headers(signer.headers({ method: 'POST', path: '/v1/result', body: 'x' }));
    const res = verifyRequest({ headers, method: 'POST', path: '/v1/result', body: 'x', secrets: [SECRET], nonces: new NonceCache(), nowMs: NOW_MS });
    assert.equal(res.ok, true);
  });

  it('reads headers case-insensitively from a plain object', () => {
    const signer = createSigner({ secret: SECRET, now: () => NOW_MS, makeNonce: () => 'nonce-0123456789ab' });
    const raw = signer.headers({ method: 'POST', path: '/v1/result', body: 'x' });
    const upper = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toUpperCase(), v]));
    const res = verifyRequest({ headers: upper, method: 'POST', path: '/v1/result', body: 'x', secrets: [SECRET], nonces: new NonceCache(), nowMs: NOW_MS });
    assert.equal(res.ok, true, 'header lookup must not depend on the transport normalising case');
  });

  it('produces distinct nonces, or every request after the first is a replay', () => {
    const signer = createSigner({ secret: SECRET, now: () => NOW_MS });
    const nonces = new Set();
    for (let i = 0; i < 200; i += 1) nonces.add(signer.headers({ method: 'GET', path: '/healthz' })[NONCE_HEADER]);
    assert.equal(nonces.size, 200);
  });

  it('exposes the signature header name so both sides cannot disagree about it', () => {
    const headers = createSigner({ secret: SECRET, now: () => NOW_MS }).headers({ method: 'GET', path: '/' });
    assert.ok(SIGNATURE_HEADER in headers);
    assert.ok(TIMESTAMP_HEADER in headers);
    assert.ok(NONCE_HEADER in headers);
  });
});

