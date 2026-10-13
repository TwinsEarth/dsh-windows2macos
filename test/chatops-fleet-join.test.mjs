/**
 * Joining a fleet by account, without a human copying a code (v0.8.1).
 *
 * ## The bug under test
 *
 * A new machine signed into the same DeepSeek account did not join the same fleet. The plugin
 * derived a `fleet` value from the account code, logged it, and never used it for anything —
 * membership still required a one-time pairing code, so a second machine on one account was
 * invisible.
 *
 * ## The property, and the trap in the obvious fix
 *
 * The property is: **two machines on one account compute the same fleet id, and a machine on
 * another account cannot compute it at all** — with no human step, no relay-side account lookup,
 * and nothing to forge.
 *
 * The obvious fix is to use `accountCode` as the credential. It is the wrong fix, and the tests
 * below pin why: `accountCode` is `sha256(userId)` truncated to **32 bits**, which is documented as
 * acceptable for *grouping* and is brute-forceable as a *secret*. So `deriveAccountFleetKey` refuses
 * it by length, and the refusal is asserted rather than left to a comment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAccountFleetKey,
  encodeFleetKey,
  decodeFleetKey,
  fleetIdFromKey,
  fleetKeyMatches,
  isWellFormedFleetKey,
  planJoin,
  FLEET_KEY_LABEL,
  MIN_ACCOUNT_MATERIAL,
} from '../src/chatops/fleet-join.mjs';
import { accountCode } from '../src/chatops/account.mjs';

const ACCOUNT_A = '9f8c1d2e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const ACCOUNT_B = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

describe('two machines on one account land in one fleet', () => {
  it('derives the same id for the same account, every time', () => {
    // The whole point: machine 1 and machine 2 have different hardware and different clocks, and
    // must still agree on which fleet they are in.
    const first = fleetIdFromKey(deriveAccountFleetKey(ACCOUNT_A));
    const second = fleetIdFromKey(deriveAccountFleetKey(ACCOUNT_A));
    assert.equal(first, second);
  });

  it('derives a different id for a different account', () => {
    const a = fleetIdFromKey(deriveAccountFleetKey(ACCOUNT_A));
    const b = fleetIdFromKey(deriveAccountFleetKey(ACCOUNT_B));
    assert.notEqual(a, b, 'two accounts must never share a fleet');
  });

  it('produces a 256-bit key, not a truncated one', () => {
    assert.equal(deriveAccountFleetKey(ACCOUNT_A).length, 32);
    assert.equal(deriveAccountFleetKey(ACCOUNT_A).toString('hex').length, 64);
  });

  it('does not depend on the hardware, so a new machine still joins', () => {
    // Nothing machine-specific enters the derivation. If it did, the second machine would compute a
    // different fleet and the bug would come back in a subtler form.
    const key = deriveAccountFleetKey(ACCOUNT_A);
    assert.equal(key.length, 32);
    assert.equal(fleetIdFromKey(key), fleetIdFromKey(deriveAccountFleetKey(ACCOUNT_A)));
  });
});

describe('the 32-bit account code is refused as a credential', () => {
  it('refuses the account code, by length, with a message that names the mistake', () => {
    /**
     * The trap in the obvious fix. `accountCode` is 8 hex characters and is documented as safe for
     * *grouping*; it is brute-forceable as a *secret*. Passing it here would produce a key that
     * looks strong and is not, which is the worst kind of credential failure.
     */
    const code = accountCode(ACCOUNT_A);
    assert.equal(code.length, 8, 'the account code really is 8 hex characters');
    assert.throws(
      () => deriveAccountFleetKey(code),
      (err) => err instanceof TypeError && /too short|account code/.test(err.message),
    );
  });

  it('refuses anything shorter than the minimum, not just the code', () => {
    assert.throws(() => deriveAccountFleetKey('x'.repeat(MIN_ACCOUNT_MATERIAL - 1)), TypeError);
    assert.equal(deriveAccountFleetKey('x'.repeat(MIN_ACCOUNT_MATERIAL)).length, 32, 'the boundary is inclusive');
  });

  it('refuses empty and non-string material rather than deriving from nothing', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      assert.throws(() => deriveAccountFleetKey(bad), TypeError, String(bad));
    }
  });

  it('trims before measuring, so padding cannot smuggle a short value through', () => {
    assert.throws(() => deriveAccountFleetKey(`   ${'a'.repeat(8)}   `), TypeError);
  });
});

describe('the wire form survives a header, a JSON string and a URL', () => {
  it('round-trips a key', () => {
    const key = deriveAccountFleetKey(ACCOUNT_A);
    const encoded = encodeFleetKey(key);
    assert.equal(typeof encoded, 'string');
    assert.equal(/^[A-Za-z0-9_-]+$/.test(encoded), true, 'base64url: no +, / or = to break a header');
    assert.deepEqual(decodeFleetKey(encoded), key);
  });

  it('refuses a value that is not exactly 32 bytes', () => {
    // A short buffer would silently weaken every comparison that follows it.
    for (const bad of ['', 'AAAA', Buffer.alloc(16).toString('base64url'), Buffer.alloc(64).toString('base64url')]) {
      assert.equal(decodeFleetKey(bad), null, JSON.stringify(bad).slice(0, 30));
    }
  });

  it('never throws on garbage, because this parses off a network', () => {
    for (const bad of [null, undefined, 42, {}, '!!!not-base64!!!']) {
      assert.doesNotThrow(() => decodeFleetKey(bad));
      assert.equal(decodeFleetKey(bad), null);
    }
  });

  it('reports well-formedness as a shape check, which is all a relay can honestly do', () => {
    assert.equal(isWellFormedFleetKey(encodeFleetKey(deriveAccountFleetKey(ACCOUNT_A))), true);
    assert.equal(isWellFormedFleetKey('nope'), false);
    assert.equal(isWellFormedFleetKey(''), false);
  });
});

describe('the relay derives the same fleet from the key, and needs no account lookup', () => {
  it('puts a client and a relay in agreement', () => {
    // The property that removes trust-on-first-use: the relay does not decide whether to believe a
    // claimed fleet id, it *computes* the id from the key it was given.
    const key = deriveAccountFleetKey(ACCOUNT_A);
    const client = planJoin({ userId: ACCOUNT_A });
    const relay = planJoin({ fleetKeyEncoded: client.fleetKey });
    assert.equal(relay.ok, true);
    assert.equal(relay.fleetId, client.fleetId);
    assert.equal(relay.fleetId, fleetIdFromKey(key));
  });

  it('refuses a malformed key instead of grouping it under something arbitrary', () => {
    const plan = planJoin({ fleetKeyEncoded: 'short' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'malformed_fleet_key');
  });

  it('refuses when there is neither an account nor a key', () => {
    const plan = planJoin({});
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'no_identity');
  });

  it('reports the account-material mistake through planJoin too, rather than throwing', () => {
    const plan = planJoin({ userId: accountCode(ACCOUNT_A) });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'bad_account_material');
  });

  it('keeps account identity off the wire: the key is derived, not the userId', () => {
    // A relay learns a fleet's id without learning the account's.
    const plan = planJoin({ userId: ACCOUNT_A });
    assert.equal(JSON.stringify(plan).includes(ACCOUNT_A), false, 'the raw account id must not travel');
  });
});

describe('comparing keys does not leak them', () => {
  it('matches equal keys and rejects different ones', () => {
    const a = deriveAccountFleetKey(ACCOUNT_A);
    const b = deriveAccountFleetKey(ACCOUNT_B);
    assert.equal(fleetKeyMatches(a, a), true);
    assert.equal(fleetKeyMatches(a, b), false);
  });

  it('rejects a length mismatch rather than reading past the buffer', () => {
    // timingSafeEqual throws on unequal lengths, and a throw on a network path is a crash.
    assert.equal(fleetKeyMatches(Buffer.alloc(32), Buffer.alloc(16)), false);
    assert.equal(fleetKeyMatches(Buffer.alloc(32), 'a string'), false);
    assert.equal(fleetKeyMatches(null, null), false);
  });
});

describe('the derivation is versioned, so changing it is a decision', () => {
  it('names the label, because changing it moves every machine to a new fleet', () => {
    assert.equal(FLEET_KEY_LABEL, 'w2m-fleet-v1');
  });

  it('produces the SAME values as it did before, pinned rather than self-compared', () => {
    /**
     * A regression here silently splits every existing fleet: machines on the new derivation would
     * compute a different id and stop seeing each other, with no error anywhere.
     *
     * A first version of this test compared a value against itself, which passes for any
     * implementation including a broken one. These are the real bytes.
     */
    assert.equal(
      deriveAccountFleetKey(ACCOUNT_A).toString('hex'),
      'a20c8b92a6f4b5f2def7d414ca8a8797194230fda706aedef59db7255abc2e4d',
    );
    assert.equal(
      fleetIdFromKey(deriveAccountFleetKey(ACCOUNT_A)),
      'd5bb1b9ddf3faad467cd3c0abaa532304f744b3da937c486917d311c5b2245ef',
    );
  });
});
