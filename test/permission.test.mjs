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
import { INDEX_REFUSAL, createApprovalIndex } from '../src/agent/approval-index.mjs';
import { AUTHORITY_BANDS, AUTHORITY_MAX } from '../src/agent/authority.mjs';
import {
  AUTHORITY_VERDICT,
  GATE_REFUSAL,
  approvalRequestFor,
  auditCapabilities,
  capabilityForDispatch,
  decide,
  gateDispatch,
  mayAutoSettle,
  raiseApproval,
} from '../src/agent/permission.mjs';

/** A level that sits inside a named band, so tests depend on the bands rather than on magic numbers. */
const levelIn = (name) => {
  const band = AUTHORITY_BANDS.find((b) => b.name === name);
  assert.ok(band, `no band named ${name}`);
  return band.min;
};describe('permission: the whole chain, dispatch to decision, on real objects', () => {
  it('carries a writing dispatch from refusal through approval to a queued, settleable request', () => {
    // This is the sequence the dispatch path performs, replayed on real objects rather than described.
    // Every step was measured before it was written down; the numbers are the ones the run produced.
    const queue = createApprovalIndex({ now: () => 1000 });

    // 1. an ordinary actor asking to write is one band below captain
    const gate = gateDispatch({ write: true, write_scope: ['src/'] }, 49);
    assert.equal(gate.enforced, true);
    assert.equal(gate.decision.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);

    // 2. the request is queued, not merely described
    const request = approvalRequestFor(gate.decision, { taskId: null, machineId: null, requestedBy: 'operator' });
    const raised = raiseApproval(queue, request, { approvalId: 'AP-E2E', toolName: 'w2m_run' });
    assert.equal(raised.ok, true, raised.detail);

    // 3. and it is findable, with the subject level intact
    const rows = queue.all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'dispatch_writing');
    assert.equal(rows[0].subjectLevel, 49);

    // 4. a captain may act on it; a peer may see it and may not answer it
    const supervisor = queue.listFor({ id: 'supervisor', level: 50 });
    assert.equal(supervisor[0].may_act, true);
    assert.equal(supervisor[0].required_level, 50);
    const peer = queue.listFor({ id: 'peer', level: 10 });
    assert.equal(peer.length, 1, 'a peer still SEES the work, so the queue does not look idle');
    assert.equal(peer[0].may_act, false);
    assert.equal(peer[0].why_not.reason_code, INDEX_REFUSAL.INSUFFICIENT_AUTHORITY);

    // 5. the decision settles it, and settling does not rewrite who asked
    const verdict = queue.decide('AP-E2E', { id: 'supervisor', level: 50 }, 'approved');
    assert.equal(verdict.ok, true, verdict.detail);
    assert.equal(queue.all({ includeSettled: true })[0].settled, 'approved');
    assert.equal(queue.all({ includeSettled: true })[0].subjectLevel, 49);
  });

  it('refuses the requester approving their own request, one level above the subject', () => {
    // The property that makes the queue a control rather than a formality. Measured: raising at 49 and
    // approving at 50 as the SAME id is refused, even though 50 is above the requirement.
    const queue = createApprovalIndex({ now: () => 1000 });
    const gate = gateDispatch({ write: true, write_scope: ['src/'] }, 49);
    const request = approvalRequestFor(gate.decision, { taskId: null, machineId: null, requestedBy: 'operator' });
    raiseApproval(queue, request, { approvalId: 'AP-SELF' });
    const self = queue.decide('AP-SELF', { id: 'operator', level: 50 }, 'approved');
    assert.equal(self.ok, false);
    assert.equal(self.reason_code, INDEX_REFUSAL.SELF_APPROVAL);
    assert.equal(queue.all()[0].settled, null, 'a refused decision must not settle the request');
  });

  it('refuses a decision from an approver at the subject level, naming the shortfall', () => {
    const queue = createApprovalIndex({ now: () => 1000 });
    const gate = gateDispatch({ write: true, write_scope: ['src/'] }, 49);
    const request = approvalRequestFor(gate.decision, { taskId: null, machineId: null, requestedBy: 'operator' });
    raiseApproval(queue, request, { approvalId: 'AP-LOW' });
    const low = queue.decide('AP-LOW', { id: 'another', level: 49 }, 'approved');
    assert.equal(low.ok, false);
    assert.equal(low.reason_code, INDEX_REFUSAL.INSUFFICIENT_AUTHORITY);
  });
});
describe('permission: the escalation really reaches the approval index', () => {
  const freshIndex = () => createApprovalIndex({ now: () => 1000 });
  const escalate = (level) => approvalRequestFor(decide('dispatch_writing', level), { taskId: 'T1', machineId: 'M1', requestedBy: 'actor-1' });

  it('registers a real escalation, and the index accepts it', () => {
    // The two features meeting for the first time on a real object rather than on a shape description.
    const index = freshIndex();
    const r = raiseApproval(index, escalate(49), { approvalId: 'AP-1' });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.approval_id, 'AP-1');
    assert.match(r.detail, /registered AP-1 for dispatch_writing/);
    assert.equal(index.all().length, 1, 'the request should be in the queue');
  });

  it('maps the flat request onto the nested entry, field by field', () => {
    // The mapping is where a defect would live: `subject_level` -> `subject.level`, `capability` -> `action`.
    const index = freshIndex();
    raiseApproval(index, escalate(49), { approvalId: 'AP-2', sessionKey: 'S1', toolName: 'w2m_run' });
    const [record] = index.all();
    assert.equal(record.subjectLevel, 49, 'the subject level must survive the mapping');
    assert.equal(record.subjectId, 'actor-1');
    assert.equal(record.action, 'dispatch_writing');
    assert.equal(record.sessionKey, 'S1');
    assert.equal(record.toolName, 'w2m_run');
  });

  it('passes the index refusal through rather than defaulting the level', () => {
    // A bridge that substituted a level to make registration succeed would be inventing the one fact the
    // approver's decision rests on, and would look like success while doing it.
    const index = freshIndex();
    const bad = escalate(49);
    bad.subject_level = 'captain';
    const r = raiseApproval(index, bad, { approvalId: 'AP-3' });
    assert.equal(r.ok, false);
    // `INDEX_REFUSAL.NO_SUBJECT_LEVEL` is `'APPROVAL_NO_SUBJECT_LEVEL'` -- every code in that table carries the
    // `APPROVAL_` prefix. The first version of this assertion guessed `INDEX_` and was wrong; it now reads the
    // value out of the table itself so it cannot drift again.
    assert.equal(r.reason_code, INDEX_REFUSAL.NO_SUBJECT_LEVEL);
    assert.equal(index.all().length, 0, 'nothing should have been registered');
  });

  it('refuses a call with no id, no request or no index, each by name', () => {
    const index = freshIndex();
    for (const [args, code] of [
      [[null, escalate(49), { approvalId: 'x' }], 'APPROVAL_NO_INDEX'],
      [[{ register: 1 }, escalate(49), { approvalId: 'x' }], 'APPROVAL_NO_INDEX'],
      [[index, null, { approvalId: 'x' }], 'APPROVAL_NO_REQUEST'],
      [[index, escalate(49), {}], 'APPROVAL_NO_ID'],
      [[index, escalate(49), { approvalId: '' }], 'APPROVAL_NO_ID'],
    ]) {
      const r = raiseApproval(...args);
      assert.equal(r.ok, false, JSON.stringify(args[2]));
      assert.equal(r.reason_code, code);
    }
  });

  it('does not register an allow or a denial, because neither is a request', () => {
    const index = freshIndex();
    assert.equal(approvalRequestFor(decide('read_fleet_state', 0)), null);
    assert.equal(raiseApproval(index, approvalRequestFor(decide('read_fleet_state', 0)), { approvalId: 'AP-4' }).ok, false);
    assert.equal(index.all().length, 0);
  });

  it('keeps the subject level the index recorded, not the one a later caller supplies', () => {
    // The reason the level is recorded at raise time at all: an approver who could supply it could lower it.
    const index = freshIndex();
    raiseApproval(index, escalate(49), { approvalId: 'AP-5' });
    const [record] = index.all();
    assert.equal(record.subjectLevel, 49);
    const decision = index.decide('AP-5', { id: 'approver', level: 50 }, 'approved');
    assert.equal(decision.ok, true, decision.detail);
    assert.equal(index.all({ includeSettled: true })[0].subjectLevel, 49, 'settling must not rewrite the subject level');
  });
});

describe('permission: a dispatch is graded from its own facts, not from a caller-named capability', () => {
  it('grades a non-writing dispatch as the cheap capability', () => {
    assert.equal(capabilityForDispatch({ write: false }).capability, 'dispatch_readonly');
    assert.equal(capabilityForDispatch({}).capability, 'dispatch_readonly');
    assert.equal(capabilityForDispatch(undefined).capability, 'dispatch_readonly');
  });

  it('grades a writing dispatch with a scope as the dearer capability', () => {
    assert.equal(capabilityForDispatch({ write: true, write_scope: ['src/'] }).capability, 'dispatch_writing');
  });

  it('grades a write with no scope as the DEARER one, not the cheaper', () => {
    // The dispatch path refuses that combination separately. If that check ever moved, grading it cheap here
    // would hand out the read-only permission for a request that intends to write.
    assert.equal(capabilityForDispatch({ write: true, write_scope: [] }).capability, 'dispatch_writing');
    assert.equal(capabilityForDispatch({ write: true }).capability, 'dispatch_writing');
  });

  it('ignores scope entries that are not usable strings', () => {
    assert.equal(capabilityForDispatch({ write: true, write_scope: [null, '', '  ', 42] }).capability, 'dispatch_writing');
    assert.match(capabilityForDispatch({ write: true, write_scope: [null, ''] }).detail, /empty scope/);
  });
});

describe('permission: an unset actor level is not a low one', () => {
  it('does not enforce, and says so, rather than refusing everything', () => {
    // Treating an unset level as 0 would refuse every writing dispatch on every machine that has not opted
    // in -- breaking a working fleet to enforce a policy nobody asked for.
    const g = gateDispatch({ write: true, write_scope: ['src/'] }, null);
    assert.equal(g.enforced, false);
    assert.equal(g.decision.verdict, AUTHORITY_VERDICT.ALLOW);
    assert.equal(g.decision.reason_code, 'GATE_NOT_ENFORCED');
    assert.match(g.detail, /not enforced/);
    assert.equal(g.decision.level, null);
  });

  it('never lets an unchecked dispatch look like a checked one', () => {
    // The whole reason `enforced` exists: a decision and the absence of one must not be indistinguishable.
    const unchecked = gateDispatch({ write: true, write_scope: ['src/'] }, undefined);
    const checked = gateDispatch({ write: true, write_scope: ['src/'] }, 100);
    assert.equal(unchecked.decision.verdict, checked.decision.verdict, 'both are ALLOW on this input');
    assert.notEqual(unchecked.enforced, checked.enforced, 'but only one of them was checked');
    assert.notEqual(unchecked.decision.reason_code, checked.decision.reason_code);
  });

  it('enforces as soon as a level is configured', () => {
    // An ordinary actor asking to write is ONE BAND below captain, so it escalates rather than being refused --
    // which is the documented behaviour, and the first version of this test asserted `deny` and was wrong.
    const escalated = gateDispatch({ write: true, write_scope: ['src/'] }, 0);
    assert.equal(escalated.enforced, true);
    assert.equal(escalated.decision.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
    // A read is inside the ordinary band, so the same actor is simply allowed.
    const allowed = gateDispatch({ write: false }, 0);
    assert.equal(allowed.enforced, true);
    assert.equal(allowed.decision.verdict, AUTHORITY_VERDICT.ALLOW);
    // And a capability two bands up is refused outright rather than escalated.
    assert.equal(decide('write_config', 0).verdict, AUTHORITY_VERDICT.DENY);
  });
});

describe('permission: the request an escalation produces fits the approval queue', () => {
  it('produces a request only for NEEDS_APPROVAL', () => {
    assert.equal(approvalRequestFor(decide('read_fleet_state', 0)), null, 'an allow is not a request');
    assert.equal(approvalRequestFor(decide('teleport', 100)), null, 'a denial is not a request');
    assert.equal(approvalRequestFor(null), null);
    const needs = decide('dispatch_writing', 49);
    assert.equal(needs.verdict, AUTHORITY_VERDICT.NEEDS_APPROVAL);
    assert.ok(approvalRequestFor(needs) !== null);
  });

  it('carries the subject level with the request rather than leaving it to be re-derived', () => {
    // An approver who could supply the subject level could lower it. It is recorded now, as a fact about who
    // asked.
    const r = approvalRequestFor(decide('dispatch_writing', 49), { taskId: 'T1', machineId: 'M1', requestedBy: 'someone' });
    assert.equal(r.subject_level, 49);
    assert.equal(r.required_level, permissionFor('dispatch_writing'));
    assert.equal(r.capability, 'dispatch_writing');
    assert.equal(r.task_id, 'T1');
    assert.equal(r.machine_id, 'M1');
    assert.equal(r.requested_by, 'someone');
  });

  it('marks a destructive request as not auto-settleable, rather than leaving the queue to infer it', () => {
    const needs = decide('delete_permanent', levelIn('org_admin'));
    const r = approvalRequestFor(needs);
    if (needs.verdict === AUTHORITY_VERDICT.NEEDS_APPROVAL) {
      assert.equal(r.destructive, true);
      assert.equal(r.auto_settleable, false);
    }
  });

  it('defaults the context fields to null rather than to undefined', () => {
    // A queue that receives `undefined` writes a field that disappears through JSON; null survives.
    const r = approvalRequestFor(decide('dispatch_writing', 49));
    assert.equal(r.task_id, null);
    assert.equal(r.machine_id, null);
    assert.equal(r.requested_by, null);
  });
});

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
