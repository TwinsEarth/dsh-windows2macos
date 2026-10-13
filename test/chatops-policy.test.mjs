/**
 * Who may command this machine (v0.7.0).
 *
 * The property this file exists to protect is that **the first person to speak does
 * not become the owner.** `dsh-chatops` 0.1.0 adopted an owner from the first
 * private message on Feishu, DingTalk or WeCom, before any authorisation ran, with
 * no pairing code and no allow-list, and persisted the claim. Because it shipped
 * with all four channels enabled, a colleague in the tenant — or a guest in an
 * allowed group — could take permanent remote control of the machine by messaging
 * the bot once.
 *
 * That failure is unattended by construction, so the tests here are about what is
 * *absent* rather than what is present:
 *
 *   * with no owner seeded, nothing is admitted and nothing is adopted;
 *   * after an owner exists, a stranger is still nobody;
 *   * pairing requires possession of a code the operator read off their own screen,
 *     is single-use, expires, and cannot be brute-forced;
 *   * membership of an allowed room is not a grant — the speaker must be trusted too;
 *   * identity is `(channel, id)`, so the same raw id on two platforms is two people;
 *   * an unknown channel is a *named* refusal, because a silent drop is
 *     indistinguishable from a bot that is simply not working.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPolicy, parseWindowKey, CHANNELS, DENIAL } from '../src/chatops/policy.mjs';

const T0 = Date.parse('2026-10-14T00:00:00Z');

function harness({ trusted = [], rooms = [], pairingCode, ttl = 15 * 60_000, maxAttempts = 5 } = {}) {
  let now = T0;
  const events = [];
  const codes = ['PAIR-AAAA1111', 'PAIR-BBBB2222', 'PAIR-CCCC3333'];
  let codeI = 0;
  const policy = createPolicy({
    trustedContacts: trusted,
    allowedRooms: rooms,
    pairingCode,
    pairingTtlMs: ttl,
    maxPairAttemptsPerIdentity: maxAttempts,
    now: () => now,
    mintCode: () => codes[codeI++ % codes.length],
    audit: (event, detail) => events.push({ event, ...detail }),
  });
  return {
    policy,
    events,
    advance: (ms) => {
      now += ms;
    },
    denials: () => events.filter((e) => e.event === 'message/denied'),
  };
}

const msg = (windowKey, over = {}) => ({ windowKey, ...over });

describe('nobody is adopted by speaking first', () => {
  it('refuses the very first private message instead of making its sender the owner', () => {
    const h = harness();
    const verdict = h.policy.admit(msg('fsu:ou_stranger'));
    assert.equal(verdict.allow, false);
    assert.equal(verdict.reason, DENIAL.NOT_ADOPTED);
    // The defect, stated as an assertion: 0.1.0 called addOwner here.
    assert.equal(h.policy.hasOwners(), false, 'a message must never create an owner');
    assert.equal(h.policy.ownerCount, 0);
  });

  it('keeps refusing after many different strangers have spoken', () => {
    const h = harness();
    for (const id of ['ou_a', 'ou_b', 'ou_c', 'dsu_d', 'wsu_e']) {
      assert.equal(h.policy.admit(msg(`${id.startsWith('ou') ? 'fsu' : id.slice(0, 3)}:${id}`)).allow, false);
    }
    assert.equal(h.policy.ownerCount, 0, 'no sequence of first contacts may accumulate trust');
  });

  it('admits a pre-seeded identity without any pairing dance', () => {
    const h = harness({ trusted: ['feishu:ou_owner'] });
    const verdict = h.policy.admit(msg('fsu:ou_owner', { talkerId: 'ou_owner' }));
    assert.equal(verdict.allow, true);
    assert.equal(verdict.channel, 'feishu');
  });

  it('still refuses everyone else once an owner exists', () => {
    const h = harness({ trusted: ['feishu:ou_owner'] });
    const verdict = h.policy.admit(msg('fsu:ou_someone_else'));
    assert.equal(verdict.allow, false);
    assert.equal(verdict.reason, DENIAL.SENDER_UNTRUSTED);
    assert.equal(h.policy.ownerCount, 1, 'a stranger must not be added by being refused');
  });

  it('can revoke, which 0.1.0 could not do without deleting its state file', () => {
    const h = harness({ trusted: ['feishu:ou_owner'] });
    assert.equal(h.policy.admit(msg('fsu:ou_owner')).allow, true);
    assert.deepEqual(h.policy.distrust('feishu', 'ou_owner'), { ok: true });
    assert.equal(h.policy.hasOwners(), false);
    assert.equal(h.policy.admit(msg('fsu:ou_owner')).allow, false);
  });
});

describe('pairing needs something the sender must possess', () => {
  it('adopts only on the correct code', () => {
    const h = harness();
    const { code } = h.policy.openPairing();
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_owner', 'PAIR-WRONG999'), { ok: false, reason: 'mismatch' });
    assert.equal(h.policy.hasOwners(), false, 'a wrong code must not adopt');
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_owner', code), { ok: true });
    assert.equal(h.policy.admit(msg('fsu:ou_owner')).allow, true);
  });

  it('is single-use, so a code seen over someone’s shoulder is not a standing grant', () => {
    const h = harness();
    const { code } = h.policy.openPairing();
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_first', code), { ok: true });
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_second', code), { ok: false, reason: 'no_open_pairing' });
    assert.equal(h.policy.admit(msg('fsu:ou_second')).allow, false);
  });

  it('expires, so an unused code does not wait around for a stranger', () => {
    const h = harness({ ttl: 1000 });
    const { code } = h.policy.openPairing();
    h.advance(1001);
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_late', code), { ok: false, reason: 'expired' });
    assert.equal(h.policy.hasOwners(), false);
  });

  it('rate-limits per identity, so a code cannot be brute-forced', () => {
    const h = harness({ maxAttempts: 3 });
    const { code } = h.policy.openPairing();
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_guesser', `PAIR-GUESS${i}`), { ok: false, reason: 'mismatch' });
    }
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_guesser', 'PAIR-ANYMORE'), { ok: false, reason: 'rate_limited' });
    // Even the right code is refused once the attempts are spent — the limiter is not
    // a speed bump that a lucky guess can step over.
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_guesser', code), { ok: false, reason: 'rate_limited' });
    assert.equal(h.policy.hasOwners(), false);
  });

  it('rotates on issue, so printing a new code does not leave two valid', () => {
    const h = harness();
    const first = h.policy.openPairing();
    const second = h.policy.openPairing();
    assert.notEqual(first.code, second.code);
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_x', first.code), { ok: false, reason: 'mismatch' });
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_x', second.code), { ok: true });
  });

  it('separates one identity’s attempts from another’s', () => {
    const h = harness({ maxAttempts: 2 });
    h.policy.openPairing();
    h.policy.redeemPairing('feishu', 'ou_a', 'nope');
    h.policy.redeemPairing('feishu', 'ou_a', 'nope');
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_a', 'nope'), { ok: false, reason: 'rate_limited' });
    // A second identity starts fresh; a shared counter would be a denial-of-service
    // against the operator by anyone who can message the bot.
    assert.deepEqual(h.policy.redeemPairing('feishu', 'ou_b', 'nope'), { ok: false, reason: 'mismatch' });
  });

  it('forgets stale attempt records, so the limiter cannot grow without bound', () => {
    const h = harness({ ttl: 1000 });
    h.policy.openPairing();
    h.policy.redeemPairing('feishu', 'ou_a', 'nope');
    assert.equal(h.policy._internals.attempts.size, 1);
    h.advance(1001);
    assert.equal(h.policy.sweep().dropped, 1);
    assert.equal(h.policy._internals.attempts.size, 0);
  });
});

describe('a room is not a person', () => {
  it('refuses an allowed room when the speaker is not individually trusted', () => {
    const h = harness({ trusted: ['feishu:ou_owner'], rooms: ['feishu:oc_team'] });
    const verdict = h.policy.admit(msg('fsc:oc_team', { talkerId: 'ou_guest', addressed: true }));
    // 0.1.0 returned true for every member of an allowed room when allowContacts was
    // empty, and for every future member. Membership is not a grant here.
    assert.equal(verdict.allow, false);
    assert.equal(verdict.reason, DENIAL.SENDER_UNTRUSTED);
  });

  it('admits an allowed room only for a trusted speaker who addressed the bot', () => {
    const h = harness({ trusted: ['feishu:ou_owner'], rooms: ['feishu:oc_team'] });
    assert.equal(h.policy.admit(msg('fsc:oc_team', { talkerId: 'ou_owner', addressed: true })).allow, true);
    assert.equal(h.policy.admit(msg('fsc:oc_team', { talkerId: 'ou_owner', addressed: false })).reason, DENIAL.NOT_ADDRESSED);
  });

  it('refuses a room that is not configured', () => {
    const h = harness({ trusted: ['feishu:ou_owner'] });
    const verdict = h.policy.admit(msg('fsc:oc_other', { talkerId: 'ou_owner', addressed: true }));
    assert.equal(verdict.reason, DENIAL.ROOM_NOT_ALLOWED);
  });

  it('refuses everything in a room before an owner exists, addressed or not', () => {
    const h = harness({ rooms: ['feishu:oc_team'] });
    const verdict = h.policy.admit(msg('fsc:oc_team', { talkerId: 'ou_anyone', addressed: true }));
    assert.equal(verdict.reason, DENIAL.NOT_ADOPTED);
  });
});

describe('identity is a pair, not an id', () => {
  it('does not cross-trust the same raw id on two platforms', () => {
    const h = harness({ trusted: ['feishu:shared_id'] });
    assert.equal(h.policy.admit(msg('fsu:shared_id')).allow, true);
    // 0.1.0 held one flat Set and stripped the channel prefix, so this id was the
    // same person on every platform.
    assert.equal(h.policy.admit(msg('dsu:shared_id')).allow, false);
    assert.equal(h.policy.admit(msg('wsu:shared_id')).allow, false);
  });

  it('names the channel it recognised and the id it decided about', () => {
    const h = harness({ trusted: ['dingtalk:staff1'] });
    const verdict = h.policy.admit(msg('dsu:staff1'));
    assert.equal(verdict.channel, 'dingtalk');
    assert.equal(verdict.id, 'staff1');
  });
});

describe('the channel registry is one table', () => {
  it('parses every prefix the registry declares, and invents none', () => {
    const seen = new Set();
    for (const [channel, spec] of Object.entries(CHANNELS)) {
      for (const prefix of spec.prefixes) {
        const parsed = parseWindowKey(`${prefix}:x`);
        assert.ok(parsed, `${channel}: prefix ${prefix} is declared but not parsable`);
        assert.equal(parsed.channel, channel);
        seen.add(prefix);
      }
      for (const prefix of spec.roomPrefixes ?? []) {
        assert.equal(parseWindowKey(`${prefix}:x`).kind, 'room');
        seen.add(prefix);
      }
    }
    assert.ok(seen.has('fsu') && seen.has('fsc') && seen.has('dsu') && seen.has('wsu'));
  });

  it('names an unknown channel rather than dropping it silently', () => {
    const h = harness({ trusted: ['feishu:ou_owner'] });
    const verdict = h.policy.admit(msg('telegram:someone'));
    // A silent drop reads as "the bot is broken"; a named refusal reads as
    // "this channel is not enabled", which is the diagnosis an operator needs.
    assert.equal(verdict.allow, false);
    assert.equal(verdict.reason, DENIAL.CHANNEL_UNKNOWN);
    assert.equal(h.denials().at(-1).reason, DENIAL.CHANNEL_UNKNOWN);
  });

  it('refuses malformed window keys instead of guessing', () => {
    const h = harness({ trusted: ['feishu:ou_owner'] });
    for (const bad of ['', ':', 'fsu:', ':ou_x', null, undefined, 42]) {
      assert.equal(h.policy.admit({ windowKey: bad }).reason, DENIAL.MALFORMED, `expected refusal for ${JSON.stringify(bad)}`);
    }
  });

  it('treats the personal-WeChat filehelper window as a channel it knows', () => {
    const parsed = parseWindowKey('filehelper');
    assert.equal(parsed.channel, 'ilink');
    assert.equal(parsed.kind, 'self');
  });
});

describe('every decision is auditable', () => {
  it('records the reason for each refusal', () => {
    const h = harness({ trusted: ['feishu:ou_owner'], rooms: ['feishu:oc_team'] });
    h.policy.admit(msg('fsu:ou_stranger'));
    h.policy.admit(msg('telegram:x'));
    h.policy.admit(msg('fsc:oc_team', { talkerId: 'ou_guest', addressed: true }));
    h.policy.admit(msg('fsu:ou_owner'));
    const reasons = h.denials().map((d) => d.reason);
    assert.deepEqual(reasons, [DENIAL.SENDER_UNTRUSTED, DENIAL.CHANNEL_UNKNOWN, DENIAL.SENDER_UNTRUSTED]);
    assert.equal(h.events.filter((e) => e.event === 'message/allowed').length, 1);
  });

  it('records how an owner was adopted, so a pairing cannot be mistaken for config', () => {
    const h = harness();
    const { code } = h.policy.openPairing();
    h.policy.redeemPairing('feishu', 'ou_owner', code);
    const adoption = h.events.find((e) => e.event === 'owner/adopted');
    assert.equal(adoption.via, 'pairing');
    assert.equal(adoption.channel, 'feishu');
  });
});
