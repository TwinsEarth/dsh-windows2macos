/**
 * Authority model suite (v4.7.0).
 *
 * The harness is a local copy rather than a shared import, matching the convention in
 * test/memory.test.mjs and test/relay.test.mjs: suites here must not be able to break each other by
 * editing a common helper.
 *
 * What these tests are actually protecting, said once so a later reader need not infer it: **every test
 * here is about a boundary**, because the only interesting thing an authority model can get wrong is
 * being off by one. A level one too permissive is an escalation; one too strict is an outage. Both are
 * asserted from both sides rather than by checking a middle value that would pass either way.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORITY_BANDS,
  AUTHORITY_MAX,
  AUTHORITY_VERDICT,
  bandOf,
  deriveAuthority,
  evaluate,
  evaluateAll,
  isAuthorityLevel,
  mayApprove,
  requiredApproverLevel,
  ruleProblem,
} from '../src/agent/authority.mjs';

describe('authority: the bands themselves', () => {
  it('partitions 0..100 with no gap and no overlap', () => {
    // A gap would make some level bandless; an overlap would make `bandOf` order-dependent, which is the
    // kind of bug that only shows up once someone is assigned the level that sits on the seam.
    const seen = new Map();
    for (let level = 0; level <= AUTHORITY_MAX; level += 1) {
      const band = bandOf(level);
      assert.ok(band !== null, `level ${level} falls in no band`);
      const previous = seen.get(band.name);
      if (previous !== undefined) {
        assert.equal(previous + 1, level, `band ${band.name} is not contiguous at ${level}`);
      }
      seen.set(band.name, level);
    }
    assert.equal(seen.size, AUTHORITY_BANDS.length, 'every declared band must be reachable');
  });

  it('places the band edges exactly where the design puts them', () => {
    assert.equal(bandOf(0).name, 'ordinary');
    assert.equal(bandOf(49).name, 'ordinary');
    assert.equal(bandOf(50).name, 'captain');
    assert.equal(bandOf(69).name, 'captain');
    assert.equal(bandOf(70).name, 'org_admin');
    assert.equal(bandOf(89).name, 'org_admin');
    assert.equal(bandOf(90).name, 'system_admin');
    assert.equal(bandOf(100).name, 'system_admin');
  });

  it('refuses a level that is not an integer, and one outside the range', () => {
    // 50.5 is not "between captain and org admin"; it is a value nobody defined, and accepting it would
    // make the band boundaries behave differently for two actors meant to be equal.
    for (const bad of [50.5, -1, 101, '50', null, undefined, NaN, {}, true]) {
      assert.equal(isAuthorityLevel(bad), false, `${JSON.stringify(bad)} must not be a level`);
      assert.equal(bandOf(bad), null);
    }
  });
});

describe('authority: a rule with no exemption exempts nobody', () => {
  it('does not treat an absent matchingExemptLevel as unconstrained', () => {
    // The tempting default, and the wrong one: a rule author who forgets the field would silently create
    // an unrestricted action. A low-level actor must still be refused.
    const rule = { action: 'write', minLevel: 70 };
    const low = evaluate(rule, { level: 10 });
    assert.equal(low.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
    assert.equal(low.exempt, false);

    const high = evaluate(rule, { level: 95 });
    assert.equal(high.verdict, AUTHORITY_VERDICT.ALLOW, 'a high-level actor is allowed by the floor, not by an exemption');
    assert.equal(high.exempt, false, 'and it is not recorded as exempt, because no exemption exists');
  });

  it('treats an explicit null the same as absent', () => {
    const withNull = evaluate({ action: 'write', minLevel: 70, matchingExemptLevel: null }, { level: 10 });
    assert.equal(withNull.exempt, false);
    assert.equal(withNull.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
  });
});

describe('authority: the exemption boundary, from both sides', () => {
  const rule = { action: 'cross-org', minLevel: 50, matchingExemptLevel: 90, scope: 'org:acme' };

  it('exempts at exactly the exempt level', () => {
    const at = evaluate(rule, { level: 90, inScope: false });
    assert.equal(at.exempt, true);
    assert.equal(at.verdict, AUTHORITY_VERDICT.ALLOW, 'the exemption must carry it past the membership check');
  });

  it('does not exempt one level below', () => {
    // This is the off-by-one that would be an escalation, so it is asserted rather than assumed.
    const below = evaluate(rule, { level: 89, inScope: false });
    assert.equal(below.exempt, false);
    assert.equal(below.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
  });

  it('exemption bypasses membership, not the level floor', () => {
    // The Unix analogy is exact: root bypasses a file's permission bits, not the requirement that the
    // file exists. An exempt level below the floor is a contradictory rule, and the strict half wins.
    const contradictory = { action: 'impossible', minLevel: 95, matchingExemptLevel: 60 };
    const decision = evaluate(contradictory, { level: 60, inScope: false });
    assert.equal(decision.exempt, true);
    assert.equal(decision.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL, 'exemption must not lower a level floor');
  });
});

describe('authority: membership is a request for a supervisor, not a refusal', () => {
  it('asks for approval when the actor is outside the scope', () => {
    const decision = evaluate({ action: 'write', minLevel: 10, scope: 'team:alpha' }, { level: 10, inScope: false });
    assert.equal(decision.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
    assert.match(decision.reason, /outside the scope/);
  });

  it('does not ask when membership was not asserted either way', () => {
    // `inScope: undefined` means "not stated", which is not "false". Collapsing those two would make every
    // caller that does not track membership see its actions parked for approval.
    const decision = evaluate({ action: 'write', minLevel: 10, scope: 'team:alpha' }, { level: 10 });
    assert.equal(decision.verdict, AUTHORITY_VERDICT.ALLOW);
  });
});

describe('authority: malformed input is denied, and distinguishable from refusal', () => {
  it('reports a malformed rule as malformed rather than as a permission decision', () => {
    // "denied" and "misconfigured" look identical from outside and only one means someone should fix
    // something, so the reason says which.
    const decision = evaluate({ action: '', minLevel: 10 }, { level: 99 });
    assert.equal(decision.verdict, AUTHORITY_VERDICT.DENY);
    assert.match(decision.reason, /malformed rule/);
  });

  it('denies an actor with no usable level', () => {
    const decision = evaluate({ action: 'write', minLevel: 0 }, { level: 'admin' });
    assert.equal(decision.verdict, AUTHORITY_VERDICT.DENY);
    assert.match(decision.reason, /no usable authority level/);
  });

  it('validates rules through ruleProblem without evaluating them', () => {
    assert.equal(ruleProblem({ action: 'w', minLevel: 0 }), null);
    assert.match(ruleProblem(null), /object/);
    assert.match(ruleProblem({ action: 'w' }), /minLevel/);
    assert.match(ruleProblem({ action: 'w', minLevel: 0, matchingExemptLevel: 1.5 }), /matchingExemptLevel/);
  });
});

describe('authority: several rules are as strict as the strictest', () => {
  it('stops at the first refusal', () => {
    // Written as a plain assertion first, because the previous draft compared the verdict with itself and
    // would have passed on any input at all.
    const result = evaluateAll([
      { action: 'a', minLevel: 0 },
      { action: 'b', minLevel: 95 },
      { action: 'c', minLevel: 0 },
    ], { level: 10 });
    assert.equal(result.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
    assert.equal(result.decisive.action, 'b');
    assert.equal(result.decisions.length, 2, 'rule "c" must not be evaluated after "b" gated the action');
  });

  it('lets an earlier gate decide, so rule order is not the policy', () => {
    // Otherwise the strict rule is decorative: the action would be permitted by whichever rule was
    // consulted last, and rule order would silently become the policy.
    const result = evaluateAll([
      { action: 'a', minLevel: 95 },
      { action: 'b', minLevel: 0 },
    ], { level: 10 });
    assert.equal(result.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
    assert.equal(result.decisive.action, 'a', 'and it names the rule that gated it');
  });

  it('allows when every rule allows, with no decisive rule', () => {
    const result = evaluateAll([{ action: 'a', minLevel: 0 }, { action: 'b', minLevel: 10 }], { level: 10 });
    assert.equal(result.verdict, AUTHORITY_VERDICT.ALLOW);
    assert.equal(result.decisive, null);
  });

  it('allows an empty rule list, and says so by having nothing to report', () => {
    const result = evaluateAll([], { level: 0 });
    assert.equal(result.verdict, AUTHORITY_VERDICT.ALLOW);
    assert.deepEqual(result.decisions, []);
  });
});

describe('authority: approval goes up a band, never sideways', () => {
  it('requires one band up at each boundary', () => {
    assert.equal(requiredApproverLevel(0), 50, 'an ordinary actor needs a captain');
    assert.equal(requiredApproverLevel(49), 50);
    assert.equal(requiredApproverLevel(50), 70, 'a captain needs an org admin');
    assert.equal(requiredApproverLevel(69), 70);
    assert.equal(requiredApproverLevel(70), 90);
    assert.equal(requiredApproverLevel(89), 90);
  });

  it('lets the top band sign for itself, because there is nobody above it', () => {
    // The alternative -- refusing -- makes a system-admin action unapprovable, which is a deadlock rather
    // than a precaution.
    assert.equal(requiredApproverLevel(90), 90);
    assert.equal(requiredApproverLevel(100), 90);
    assert.equal(mayApprove({ level: 90, id: 'other' }, { level: 95, id: 'top' }).ok, true);
  });

  it('refuses a peer approval, which is a ring rather than a chain', () => {
    const peer = mayApprove({ level: 50, id: 'cap-b' }, { level: 50, id: 'cap-a' });
    assert.equal(peer.ok, false);
    assert.match(peer.reason, /below the required 70/);
  });

  it('refuses self-approval even at a level that would otherwise suffice', () => {
    // Stated separately from the level comparison because it is the case an implementation lets through
    // by checking levels and nothing else.
    const self = mayApprove({ level: 95, id: 'same' }, { level: 90, id: 'same' });
    assert.equal(self.ok, false);
    assert.match(self.reason, /may not approve its own request/);
  });

  it('refuses an unusable approver level rather than treating it as low', () => {
    const bad = mayApprove({ level: null, id: 'x' }, { level: 10, id: 'y' });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /approver has no usable authority level/);
  });
});

describe('authority: a derived actor never exceeds its parent', () => {
  it('caps at the parent when the child asks for more', () => {
    const derived = deriveAuthority({ level: 50 }, { level: 95 });
    assert.equal(derived.level, 50);
    assert.equal(derived.capped, true);
    assert.match(derived.reason, /never exceeds its parent/);
  });

  it('honours a cap below the parent', () => {
    const derived = deriveAuthority({ level: 90 }, { level: 80, cap: 60 });
    assert.equal(derived.level, 60);
    assert.equal(derived.capped, true);
  });

  it('grants the parent level when the child asks for nothing', () => {
    const derived = deriveAuthority({ level: 50 }, {});
    assert.equal(derived.level, 50);
    assert.equal(derived.capped, false);
  });

  it('grants a lower level without calling it a cap', () => {
    const derived = deriveAuthority({ level: 90 }, { level: 10 });
    assert.equal(derived.level, 10);
    assert.equal(derived.capped, false, 'asking for less than allowed is not a reduction');
  });

  it('refuses when the parent has no usable level', () => {
    const derived = deriveAuthority({ level: undefined }, { level: 10 });
    assert.equal(derived.level, null);
    assert.match(derived.reason, /parent has no usable authority level/);
  });
});
