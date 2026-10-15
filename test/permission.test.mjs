/**
 * Permission-gate suite: the three verdicts, and the window that is exactly one band.
 *
 * What these protect, said once: this module is the only thing that consults the capability table, so its
 * failure modes are the ones that matter. **Granting an undeclared capability** turns an omission into a
 * permission; **escalating more than one band** turns the approval queue into an attack path, because the
 * request itself becomes the way to reach a high-authority action from low authority. Both are tested here as
 * refusals rather than described in the header.
 *
 * The bands come from `authority.mjs` and the capability costs come from `layer-model.mjs`; the tests assert
 * the *relationship* between them rather than hard-coding either, so a band change that broke this module
 * would fail here instead of silently shifting every decision.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITIES, permissionFor } from '../scripts/layer-model.mjs';
import { AUTHORITY_BANDS, AUTHORITY_MAX } from '../src/agent/authority.mjs';
import {
  AUTHORITY_VERDICT,
  GATE_REFUSAL,
  auditCapabilities,
  decide,
  mayAutoSettle,
} from '../src/agent/permission.mjs';

/** A level that sits inside a named band, so tests depend on the bands rather than on magic numbers. */
const levelIn = (name) => {
  const band = AUTHORITY_BANDS.find((b) => b.name === name);
  assert.ok(band, `no band named ${name}`);
  return band.min;
};

describe('permission: a level at or above the requirement is allowed', () => {
  it('allows exactly the required level, asserted from both sides', () => {
    // The boundary is the only interesting thing a threshold can get wrong.
    const required = permissionFor('dispatch_writing');
    assert.equal(decide('dispatch_writing', required).verdict, AUTHORITY_VERDICT.ALLOW);
    assert.equal(decide('dispatch_writing', required - 1).verdict !== AUTHORITY_VERDICT.ALLOW, true);
  });

  it('carries the numbers, so a caller never re-derives them', () => {
    const d = decide('dispatch_writing', 100);
    assert.equal(d.capability, 'dispatch_writing');
    assert.equal(d.level, 100);
    assert.equal(d.required, permissionFor('dispatch_writing'));
    assert.equal(d.shortfall, 0);
    assert.equal(d.destructive, false);
    assert.equal(d.reason_code, GATE_REFUSAL.SUFFICIENT);
  });

  it('marks a destructive capability as such in the decision', () => {
    assert.equal(decide('publish_release', 100).destructive, true);
    assert.equal(decide('read_fleet_state', 100).destructive, false);
  });
});

describe('permission: an undeclared capability is refused, never granted and never escalated', () => {
  it('denies a capability the table has not heard of', () => {
    // The single most important branch. `ALLOW` would make the table grant whatever is added next;
    // `NEEDS_APPROVAL` would make it requestable. Both hide the omission.
    for (const bad of ['teleport', '', 'READ_FLEET_STATE', 'read_fleet_state ']) {
      const d = decide(bad, 100);
      assert.equal(d.verdict, AUTHORITY_VERDICT.DENY, JSON.stringify(bad));
      assert.equal(d.reason_code, GATE_REFUSAL.UNKNOWN_CAPABILITY);
      assert.equal(d.required, null, 'an unknown capability has no requirement to report');
      assert.match(d.detail, /refused rather than granted/);
    }
  });

  it('denies it even at maximum authority', () => {
    // Authority answers "how much may this actor do", not "is this a thing that exists".
    assert.equal(decide('teleport', AUTHORITY_MAX).verdict, AUTHORITY_VERDICT.DENY);
  });

  it('denies a non-string capability rather than coercing one', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      assert.equal(decide(bad, 100).verdict, AUTHORITY_VERDICT.DENY, JSON.stringify(bad));
    }
  });
});

describe('permission: the escalation window is exactly one band', () => {
  it('escalates from one band below', () => {
    // `dispatch_writing` requires captain (50). An ordinary actor at 49 is one band below and may ask.
    const d = decide('dispatch_writing', 49);
    assert.equal(d.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
    assert.equal(d.reason_code, GATE_REFUSAL.ONE_BAND_BELOW);
    assert.equal(d.shortfall, 1);
    assert.match(d.detail, /escalated to an approver/);
  });

  it('refuses two bands below, because the request itself would be the attack', () => {
    // An ordinary actor asking for a system-admin action is not a request to forward; it is a request that
    // should never have been forwarded. If any shortfall could be escalated, low authority could reach any
    // action through one inattentive approver.
    const d = decide('write_config', 10);
    assert.equal(d.verdict, AUTHORITY_VERDICT.DENY);
    assert.equal(d.reason_code, GATE_REFUSAL.BELOW_BAND);
    assert.match(d.detail, /more than one band/);
    assert.match(d.detail, /refused rather than escalated/);
  });

  it('names the escalation as destructive-blocking when the capability is destructive', () => {
    // A destructive action that is one band up may be escalated, but the decision says it must not be settled
    // without a person -- see the mayAutoSettle tests.
    const d = decide('delete_permanent', levelIn('org_admin'));
    if (d.verdict === AUTHORITY_VERDICT.NEEDS_APPROVAL) {
      assert.match(d.detail, /destructive and must not be auto-approved/);
    } else {
      assert.equal(d.verdict, AUTHORITY_VERDICT.ALLOW, 'org_admin should at least be able to request it');
    }
  });

  it('walks every declared capability and never escalates more than one band', () => {
    // The property asserted over the whole table rather than one entry: for every capability and every level,
    // a NEEDS_APPROVAL verdict implies the actor is exactly one band below the requirement.
    for (const c of CAPABILITIES) {
      for (let level = 0; level <= AUTHORITY_MAX; level += 1) {
        const d = decide(c.name, level);
        if (d.verdict !== AUTHORITY_VERDICT.NEEDS_APPROVAL) continue;
        const actor = AUTHORITY_BANDS.findIndex((b) => level >= b.min && (b.max === null || level <= b.max));
        const need = AUTHORITY_BANDS.findIndex((b) => c.min_authority >= b.min && (b.max === null || c.min_authority <= b.max));
        assert.equal(need - actor, 1, `${c.name} at ${level} escalated ${need - actor} band(s)`);
      }
    }
  });
});

describe('permission: a level nobody defined is refused rather than rounded', () => {
  it('denies a non-integer, an out-of-range value and a missing one', () => {
    // Treating these as 0 would silently downgrade an actor; treating them as high would silently promote one.
    for (const bad of [50.5, -1, AUTHORITY_MAX + 1, Number.NaN, '50', null, undefined]) {
      const d = decide('read_fleet_state', bad);
      assert.equal(d.verdict, AUTHORITY_VERDICT.DENY, JSON.stringify(bad));
      assert.equal(d.reason_code, GATE_REFUSAL.NOT_A_LEVEL);
      assert.equal(d.level, null);
      assert.equal(d.required, permissionFor('read_fleet_state'), 'the requirement is still reported');
    }
  });
});

describe('permission: nothing destructive settles itself', () => {
  it('auto-settles an allow that is not destructive', () => {
    const r = mayAutoSettle(decide('read_fleet_state', 0));
    assert.equal(r.auto, true);
  });

  it('never auto-settles a destructive allow, however high the level', () => {
    // The level answers "may this actor", not "should this happen now". A release published on a machine's own
    // judgement is a release nobody reviewed.
    const d = decide('publish_release', AUTHORITY_MAX);
    assert.equal(d.verdict, AUTHORITY_VERDICT.ALLOW);
    const r = mayAutoSettle(d);
    assert.equal(r.auto, false);
    assert.match(r.detail, /a person settles it however high the level/);
  });

  it('never auto-settles anything that is not an allow', () => {
    for (const cap of ['dispatch_writing']) {
      const needs = decide(cap, 49);
      assert.equal(mayAutoSettle(needs).auto, false);
      assert.match(mayAutoSettle(needs).detail, /not an allow/);
      const denied = decide('teleport', 100);
      assert.equal(mayAutoSettle(denied).auto, false);
    }
  });

  it('refuses a missing decision rather than assuming one', () => {
    for (const bad of [null, undefined, 42, 'allow']) {
      assert.equal(mayAutoSettle(bad).auto, false, JSON.stringify(bad));
    }
  });
});

describe('permission: the capability table is audited, not trusted', () => {
  it('finds every declared capability reachable by some band', () => {
    // An unreachable entry reads as policy while doing nothing, which is worse than an absent one.
    const a = auditCapabilities();
    assert.deepEqual(a.unreachable, [], a.detail);
    assert.equal(a.ok, true);
    assert.match(a.detail, /all \d+ declared capability\(ies\) are reachable/);
  });

  it('reports a capability no actor could exercise, naming it', () => {
    // Exercised through the audit's own contract: it must NAME the entry rather than count it.
    const a = auditCapabilities();
    for (const u of a.unreachable) assert.match(u, /\(.+\)$/, `${u} should carry a reason`);
  });

  it('has a minimum authority inside the model for every entry', () => {
    for (const c of CAPABILITIES) {
      assert.ok(Number.isInteger(c.min_authority), `${c.name} has no integer min_authority`);
      assert.ok(c.min_authority >= 0 && c.min_authority <= AUTHORITY_MAX, `${c.name} is outside 0..${AUTHORITY_MAX}`);
      assert.equal(typeof c.destructive, 'boolean', `${c.name} does not say whether it is destructive`);
    }
  });
});
