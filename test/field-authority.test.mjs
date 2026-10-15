/**
 * Field-level acceptance driven by the authority model — the half of v4.8.0 that was claimed and not built.
 *
 * What these protect, said once: `ROADMAP.md` marks v4.8.0 **shipped** against the sentence *"per-field
 * acceptance driven by §2's authority model"*, and until this module existed **`blocks.mjs` did not import
 * `authority.mjs` at all**. The one field rule that shipped refused `confidence` by name and accepted
 * everything else. So the tests here are written against the connection rather than against the idea of one:
 * a real `acceptBlock` is driven through a real actor's level, and the stored block is inspected.
 *
 * The load-bearing case is **an undeclared field being refused**. Accepting it would make the table grant
 * whatever is added next; escalating it would make it requestable. Both turn an omission into a permission,
 * which is the failure `authority.mjs` and `permission.mjs` each already refuse by name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAT7_FIELDS, INHERITED_FIELDS, RECEIVER_CHOOSABLE_FIELDS, acceptBlock, makeBlock } from '../src/agent/blocks.mjs';
import { AUTHORITY_MAX } from '../src/agent/authority.mjs';
import {
  FIELD_LEVELS,
  FIELD_REFUSAL,
  NEVER_ACCEPTED,
  acceptField,
  acceptWithAuthority,
  authorityChooser,
  ruleForField,
} from '../src/agent/field-authority.mjs';

/** A block with a fresh subject so nothing depends on a shared constant. */
const block = (overrides = {}) => makeBlock({
  origin: 'machine-a',
  subject: 's',
  body: 'a claim',
  evidence: 'because',
  observed_at: '2026-10-15T00:00:00Z',
  lineage: [],
  ...overrides,
});

describe('field authority: a field with no declared rule is refused, never granted', () => {
  it('refuses an undeclared field, at maximum authority', () => {
    // The most important branch. `ALLOW` would make the table grant whatever is added next; escalation would
    // make it requestable. Authority answers "may this actor", not "is this a field".
    //
    // The fields that are genuinely governed-but-undeclared are the three INHERITED ones: measured, the chooser
    // is never asked about them because `acceptBlock` copies them directly. So each is refused here with
    // `UNDECLARED` rather than `NOT_A_FIELD` -- and that is honest rather than a dead rule, because a rule for
    // a field no chooser sees would read as policy while doing nothing.
    for (const field of INHERITED_FIELDS) {
      const r = acceptField(field, { level: AUTHORITY_MAX });
      assert.equal(r.accepted, false, field);
      assert.equal(r.code, FIELD_REFUSAL.UNDECLARED, field);
      assert.equal(r.verdict, null, 'no rule was consulted, so no verdict was reached');
      assert.match(r.reason, /refused rather than granted/);
    }
  });

  it('refuses a name that is not one of the seven, before consulting any rule', () => {
    // A rule cannot make a field exist. Consulting one here would let a typo in a rule table conjure a field
    // that `verifyBlock` rejects at the other end of the wire.
    for (const bad of ['scope_claim', '', 'Body', 'confidence ']) {
      const r = acceptField(bad, { level: AUTHORITY_MAX });
      assert.equal(r.accepted, false, JSON.stringify(bad));
      assert.equal(r.code, FIELD_REFUSAL.NOT_A_FIELD, JSON.stringify(bad));
    }
  });

  it('refuses a non-string rather than coercing one', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const r = acceptField(bad, { level: AUTHORITY_MAX });
      assert.equal(r.accepted, false, JSON.stringify(bad));
      assert.equal(r.code, FIELD_REFUSAL.NOT_A_FIELD);
    }
  });
});

describe('field authority: confidence is refused at every level, including the highest', () => {
  it('refuses it even at AUTHORITY_MAX, and says it is an invariant', () => {
    // A level can be raised. If this were merely expensive, a system administrator would be PERMITTED to adopt
    // the sender's certainty about the sender's own assertion.
    const r = acceptField('confidence', { level: AUTHORITY_MAX });
    assert.equal(r.accepted, false);
    assert.equal(r.code, FIELD_REFUSAL.ALWAYS_REFUSED);
    assert.equal(r.required, null, 'it has no price, so it must not report one');
    assert.match(r.reason, /invariant, not a default/);
  });

  it('is absent from the cost table, which is what makes it unreachable', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(FIELD_LEVELS, 'confidence'), false);
    assert.equal(ruleForField('confidence'), null);
    assert.ok(Object.prototype.hasOwnProperty.call(NEVER_ACCEPTED, 'confidence'));
  });
});

describe('field authority: the cost table and the block layer agree on which fields exist', () => {
  it('names only real CAT7 fields, and only the ones a chooser is ever asked about', () => {
    // `acceptBlock` copies the inherited three without consulting a chooser, so a rule for them would be dead
    // code that reads as policy. Asserted so adding one is a decision rather than an accident.
    for (const field of Object.keys(FIELD_LEVELS)) {
      assert.ok(CAT7_FIELDS.includes(field), `${field} is not a CAT7 field`);
      assert.ok(RECEIVER_CHOOSABLE_FIELDS.includes(field), `${field} is inherited and never reaches a chooser`);
    }
    for (const field of RECEIVER_CHOOSABLE_FIELDS) {
      const declared = Object.prototype.hasOwnProperty.call(FIELD_LEVELS, field);
      const never = Object.prototype.hasOwnProperty.call(NEVER_ACCEPTED, field);
      assert.ok(declared || never, `${field} is choosable but is neither priced nor refused, so it would be UNDECLARED at runtime`);
    }
  });

  it('does not price an inherited field, because no authority can set one', () => {
    for (const field of INHERITED_FIELDS) {
      assert.equal(Object.prototype.hasOwnProperty.call(FIELD_LEVELS, field), false, field);
    }
  });
});

describe('field authority: the verdict follows the authority model, not a second opinion', () => {
  it('accepts a free field for an ordinary actor and a dear one only above its floor', () => {
    assert.equal(acceptField('body', { level: 0 }).accepted, true);
    const below = acceptField('evidence', { level: 49 });
    assert.equal(below.accepted, false);
    assert.equal(below.code, FIELD_REFUSAL.BELOW_AUTHORITY);
    assert.equal(below.required, FIELD_LEVELS.evidence);
    assert.equal(acceptField('evidence', { level: FIELD_LEVELS.evidence }).accepted, true, 'the floor itself passes');
  });

  it('refuses an actor with no usable level rather than assuming one', () => {
    for (const bad of [null, undefined, 50.5, -1, AUTHORITY_MAX + 1, '50']) {
      const r = acceptField('body', { level: bad });
      assert.equal(r.accepted, false, JSON.stringify(bad));
      assert.equal(r.code, FIELD_REFUSAL.BELOW_AUTHORITY);
      assert.match(r.reason, /no usable authority level/);
    }
  });

  it('refuses a malformed actor object without throwing', () => {
    for (const bad of [null, undefined, 42, 'actor']) {
      const r = acceptField('body', bad);
      assert.equal(r.accepted, false, JSON.stringify(bad));
    }
  });

  it('never grants on a non-allow verdict, whatever the model returns', () => {
    // Asserted across every field and a spread of levels: an `accepted: true` with a verdict that is not
    // `allow` would be the model disagreeing with itself.
    for (const field of Object.keys(FIELD_LEVELS)) {
      for (const level of [0, 1, 25, 49, 50, 69, 70, 89, 90, 100]) {
        const r = acceptField(field, { level });
        if (r.accepted) assert.equal(r.verdict, 'allow', `${field} at ${level} accepted on ${r.verdict}`);
      }
    }
  });
});

describe('field authority: driven through the real acceptBlock, on a real block', () => {
  it('omits a refused field from the stored block rather than setting it to null', () => {
    // ROADMAP v4.8.0's first falsifying test, now exercised through the authority chooser rather than only
    // through a hand-written one.
    const b = block();
    const result = acceptBlock(b, { choose: authorityChooser({ level: 0 }) });

    assert.equal(result.accepted.confidence, undefined, 'a refused field must be ABSENT');
    assert.equal(Object.prototype.hasOwnProperty.call(result.accepted, 'confidence'), false, 'absent, not present-and-null');
    assert.ok(result.refused.some((r) => r.field === 'confidence'));
  });

  it('accepts the fields the actor can afford and reports the rest', () => {
    const b = block();
    const ordinary = acceptBlock(b, { choose: authorityChooser({ level: 0 }) });
    assert.equal(ordinary.accepted.body, 'a claim', 'body is free');
    assert.equal(ordinary.accepted.subject, 's');
    assert.equal(ordinary.accepted.evidence, undefined, 'evidence costs more than an ordinary actor has');
    // Measured: `accepted_fields` carries the three inherited fields too, because `acceptBlock` copies them
    // unconditionally. Asserting the full set keeps this pinned to what the block layer actually does.
    assert.deepEqual(ordinary.accepted_fields.sort(), ['body', 'lineage', 'observed_at', 'origin', 'subject']);

    const captain = acceptBlock(b, { choose: authorityChooser({ level: 50 }) });
    assert.equal(captain.accepted.evidence, 'because');
    assert.ok(captain.accepted_fields.includes('evidence'));
  });

  it('still carries the inherited fields, which no chooser is asked about', () => {
    // The chooser cannot refuse these, and that is the design: a receiver that could set them could assert a
    // provenance it does not have. Asserted here so the connection does not accidentally acquire that power.
    const b = block();
    const result = acceptBlock(b, { choose: authorityChooser({ level: 0 }) });
    for (const field of INHERITED_FIELDS) {
      assert.equal(result.accepted[field], b[field], field);
      assert.ok(result.accepted_fields.includes(field), field);
    }
  });

  it('records every ruling, so refusals can be kept without re-deriving them', () => {
    const b = block();
    const result = acceptWithAuthority(b, { level: 0 }, { accept: acceptBlock });
    // THREE, not four: `acceptBlock` hard-codes the refusal of `confidence` and `continue`s before calling
    // the chooser, so that field never produces a ruling here. Measured rather than assumed -- the first
    // version of this asserted one per choosable field and was wrong by exactly the hard-coded one.
    assert.equal(result.decisions.length, RECEIVER_CHOOSABLE_FIELDS.length - 1, 'one ruling per field that reaches a chooser');
    assert.equal(result.decisions.some((d) => d.field === 'confidence'), false, 'confidence is refused upstream of the chooser');
    for (const d of result.decisions) {
      assert.ok(Object.prototype.hasOwnProperty.call(d, 'accepted'));
      assert.ok(typeof d.reason === 'string' && d.reason.length > 0);
    }
    assert.equal(result.accepted.confidence, undefined);
  });

  it('is supplied the block-accepting function rather than importing it, so neither layer owns the other', () => {
    const r = acceptWithAuthority(block(), { level: 0 }, {});
    assert.equal(r.accepted, null);
    assert.match(r.refused[0].why, /no acceptBlock implementation was supplied/);
  });

  it('a lower authority never accepts MORE than a higher one, across the whole table', () => {
    // The property that makes this a model rather than a lookup: monotonicity. If some field were cheaper at a
    // lower level, a caller could reach it by claiming less authority.
    const b = block();
    const fieldsAt = (level) => new Set(acceptBlock(b, { choose: authorityChooser({ level }) }).accepted_fields);
    let previous = new Set();
    for (const level of [0, 25, 49, 50, 69, 70, 89, 90, 100]) {
      const now = fieldsAt(level);
      for (const f of previous) assert.ok(now.has(f), `${f} was accepted at a lower level and not at ${level}`);
      previous = now;
    }
  });
});
