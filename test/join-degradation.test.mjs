/**
 * The degradation decision, on its own.
 *
 * A fallback that fires on the wrong failure is worse than no fallback: it moves a machine from a path that was about to
 * work into an approval queue. So the whitelist is asserted in both directions -- the three reasons degrade, and the
 * plausible-but-wrong ones do not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEGRADABLE_REASONS, shouldDegrade } from '../src/plugin/join-degradation.mjs';

describe('the old joining path is abandoned only for the three whitelisted reasons', () => {
  it('degrades for an invalid pairing code, an unreachable relay, or a timeout', () => {
    for (const reason of DEGRADABLE_REASONS) {
      assert.equal(shouldDegrade(reason), true, reason);
      assert.equal(shouldDegrade({ reason_code: reason }), true, reason + ' as an object');
      assert.equal(shouldDegrade({ code: reason }), true, reason + ' as a code');
    }
    assert.deepEqual([...DEGRADABLE_REASONS].sort(), ['PAIRING_CODE_INVALID', 'PAIRING_TIMEOUT', 'RELAY_UNREACHABLE']);
  });

  it('does NOT degrade for a human-action failure, and defaults to false for anything unknown', () => {
    const mustNot = [
      'OPERATOR_REQUIRED', 'W2M_CONFIG', 'COMMAND_NOT_ALLOWED', 'PERMISSION_DENIED', 'BAD_REQUEST', 'INTERNAL', '',
    ];
    for (const reason of mustNot) assert.equal(shouldDegrade(reason), false, reason);
    for (const junk of [null, undefined, 42, {}, { reason_code: 7 }]) {
      assert.equal(shouldDegrade(junk), false, 'unknown input must not degrade: ' + JSON.stringify(junk));
    }
  });

  it('an HTTP status alone is never enough to degrade', () => {
    // 401/403/500 are a human's problem; a 5xx may be transient. Neither says "the old path can never work".
    for (const status of [401, 403, 500, 503]) assert.equal(shouldDegrade({ status }), false, 'status ' + status);
  });
});
