/**
 * The challenge exchange: one-time, expiring, bound to a machine, rate limited per account.
 *
 * Each of those is a way a signature can be replayed, so each gets its own assertion rather than being folded into one
 * happy-path test. The clock is injected, so "five minutes" is exact.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJoinChallenges, CHALLENGE_TTL_MS } from '../src/relay/join-challenge.mjs';
import { deriveAccountKeypair, signChallenge } from '../src/util/account-identity.mjs';

const identity = deriveAccountKeypair('account-material-1');
const FP = identity.fingerprint;
const OTHER = deriveAccountKeypair('account-material-2');

function harness(options = {}) {
  let t = 1_000_000;
  const challenges = createJoinChallenges({
    now: () => t,
    publicKeyFor: (fp) => (fp === FP ? identity.publicKeyPem : null),
    ...options,
  });
  return { challenges, advance: (ms) => { t += ms; } };
}

const signed = (challenges, issued, machine = 'm-new') => signChallenge(
  identity,
  challenges.signingPayload({ challenge_id: issued.challenge_id, nonce: issued.nonce, fingerprint: FP, machine_id: machine }),
);

describe('the challenge exchange', () => {
  it('issues a challenge for a registered account and refuses an unknown one', () => {
    const { challenges } = harness();
    const issued = challenges.issue(FP, 'm-new');
    assert.equal(issued.ok, true);
    assert.match(issued.challenge_id, /^[0-9a-f]{32}$/);
    assert.equal(issued.expires_at_ms, 1_000_000 + CHALLENGE_TTL_MS);
    assert.equal(challenges.issue(OTHER.fingerprint, 'm-other').code, 'FINGERPRINT_UNREGISTERED');
  });

  it('accepts a correctly signed challenge', () => {
    const { challenges } = harness();
    const issued = challenges.issue(FP, 'm-new');
    const out = challenges.consume({ challenge_id: issued.challenge_id, machine_id: 'm-new', signature: signed(challenges, issued) });
    assert.deepEqual(out, { ok: true, fingerprint: FP });
  });

  it('is one-time: a second attempt with the same challenge fails', () => {
    const { challenges } = harness();
    const issued = challenges.issue(FP, 'm-new');
    const signature = signed(challenges, issued);
    assert.equal(challenges.consume({ challenge_id: issued.challenge_id, machine_id: 'm-new', signature }).ok, true);
    assert.equal(challenges.consume({ challenge_id: issued.challenge_id, machine_id: 'm-new', signature }).code, 'CHALLENGE_INVALID');
  });

  it('expires after the window, on the relay clock', () => {
    const { challenges, advance } = harness();
    const issued = challenges.issue(FP, 'm-new');
    const signature = signed(challenges, issued);
    advance(CHALLENGE_TTL_MS);
    assert.equal(challenges.consume({ challenge_id: issued.challenge_id, machine_id: 'm-new', signature }).code, 'CHALLENGE_INVALID');
  });

  it('rejects a signature made for a different machine', () => {
    const { challenges } = harness();
    const issued = challenges.issue(FP, 'm-new');
    const signature = signed(challenges, issued, 'm-other');
    assert.equal(challenges.consume({ challenge_id: issued.challenge_id, machine_id: 'm-new', signature }).code, 'SIGNATURE_INVALID');
  });

  it('rejects a signature made by the wrong key', () => {
    const { challenges } = harness();
    const issued = challenges.issue(FP, 'm-new');
    const wrong = signChallenge(OTHER, challenges.signingPayload({ challenge_id: issued.challenge_id, nonce: issued.nonce, fingerprint: FP, machine_id: 'm-new' }));
    assert.equal(challenges.consume({ challenge_id: issued.challenge_id, machine_id: 'm-new', signature: wrong }).code, 'SIGNATURE_INVALID');
  });

  it('rejects a garbage signature instead of throwing', () => {
    const { challenges } = harness();
    const issued = challenges.issue(FP, 'm-new');
    assert.equal(challenges.consume({ challenge_id: issued.challenge_id, machine_id: 'm-new', signature: 'nope' }).code, 'SIGNATURE_INVALID');
  });

  it('rate limits per fingerprint', () => {
    const { challenges } = harness();
    for (let i = 0; i < 5; i += 1) assert.equal(challenges.issue(FP, 'm-new').ok, true, 'issue ' + i);
    assert.equal(challenges.issue(FP, 'm-new').code, 'RATE_LIMITED', 'the sixth challenge in a minute is refused');
  });
});
