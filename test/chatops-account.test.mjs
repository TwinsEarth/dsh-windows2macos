/**
 * Account identity, the serial number, and the hardware fingerprint (v0.7.5).
 *
 * The properties this file protects, and why each one is easy to get wrong:
 *
 * **The SN must not be a credential.** It is computed from local inputs, so anyone who knows or
 * guesses an account id can produce a well-formed one. The tests assert the *shape* check accepts
 * a forged SN — deliberately, because a future reader who "hardens" `isWellFormedSn` into an
 * authorisation check would be building on sand, and the assertion is here to make that visible.
 *
 * **The account code must not be the account id.** It ends up in device lists, log lines and chat
 * messages. The test asserts the raw id appears nowhere in the output.
 *
 * **A fingerprint must not change in normal use.** MAC addresses, IPs, mount points and package
 * lists are excluded on purpose: a fingerprint that changes makes one machine look like two, which
 * fragments a fleet and fills it with ghosts. The tests drive each platform's sources through an
 * injected reader, so a Windows-shaped machine is exercised on any host.
 *
 * **A stored SN must never be regenerated.** Regenerating on each start would make every restart
 * look like a new device.
 *
 * **A signed-out machine must not be given a placeholder fleet.** Fabricating one would put two
 * unrelated machines in the same pool — the exact defect this work exists to remove.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  accountCode,
  hardwareCode,
  timeCode,
  buildSn,
  isWellFormedSn,
  parseSn,
  fleetOf,
  isUsefulHardwareValue,
  readHardwareValues,
  createAccountIdentity,
  HW_SOURCES,
  SN_PATTERN,
} from '../src/chatops/account.mjs';

const USER = 'acct_2f9c1e7b4d0a8c63';

describe('the account code is derived, not the account id', () => {
  it('is stable for the same account', () => {
    assert.equal(accountCode(USER), accountCode(USER));
    assert.equal(accountCode(USER).length, 8);
    assert.match(accountCode(USER), /^[0-9a-f]{8}$/);
  });

  it('ignores surrounding whitespace, so a padded id is the same account', () => {
    assert.equal(accountCode(`  ${USER}  `), accountCode(USER));
  });

  it('differs between accounts', () => {
    assert.notEqual(accountCode(USER), accountCode('acct_other'));
  });

  it('never leaks the account id itself', () => {
    // The whole reason it is hashed: this string is shown to operators and sent over chat.
    const code = accountCode(USER);
    assert.ok(!code.includes(USER));
    assert.ok(!USER.includes(code));
  });

  it('refuses an empty or non-string id rather than hashing nothing', () => {
    assert.equal(accountCode(''), null);
    assert.equal(accountCode('   '), null);
    assert.equal(accountCode(null), null);
    assert.equal(accountCode(42), null);
  });
});

describe('the hardware code is normalised', () => {
  it('collapses whitespace and case, so one machine is one fingerprint', () => {
    // The same machine reports the same value with different spacing depending on the tool that
    // read it. A fingerprint that changes with its reader is a fingerprint that changes.
    assert.equal(hardwareCode('ABC-123'), hardwareCode('  abc-123  '));
    assert.equal(hardwareCode('a  b'), hardwareCode('a b'));
  });

  it('combines several sources into one code', () => {
    const two = hardwareCode('one', 'two');
    assert.notEqual(two, hardwareCode('one'));
    assert.notEqual(two, hardwareCode('two', 'one'));
  });

  it('skips empty parts instead of mixing in nothing', () => {
    assert.equal(hardwareCode('only', '', null, undefined), hardwareCode('only'));
  });

  it('returns null when there is nothing to hash', () => {
    assert.equal(hardwareCode('', '  ', null), null);
  });
});

describe('the time code is UTC and fixed-width', () => {
  it('formats as YYYYMMDDhhmmss', () => {
    assert.equal(timeCode(new Date('2026-10-14T20:30:15Z')), '20261014203015');
  });

  it('pads single digits', () => {
    assert.equal(timeCode(new Date('2026-01-02T03:04:05Z')), '20260102030405');
  });

  it('uses UTC, not local time', () => {
    // A machine in UTC+8 must not stamp a different second than one in UTC for the same instant.
    const when = new Date('2026-10-14T23:59:59Z');
    assert.equal(timeCode(when), '20261014235959');
  });

  it('refuses an invalid date rather than emitting NaN in an SN', () => {
    assert.throws(() => timeCode(new Date('nonsense')), /valid date/);
  });
});

describe('the serial number', () => {
  const acct = '3f9a1c2e';
  const hwid = '7b4d0e91a3c5';

  it('has the documented shape and length', () => {
    const sn = buildSn({ accountCode: acct, hardwareCode: hwid, at: new Date('2026-10-14T20:30:15Z') });
    assert.equal(sn, 'W2M-3f9a1c2e-7b4d0e91a3c5-20261014203015');
    assert.equal(sn.length, 40, '4 + 8 + 1 + 12 + 1 + 14');
    assert.match(sn, SN_PATTERN);
  });

  it('parses back into its parts', () => {
    const sn = buildSn({ accountCode: acct, hardwareCode: hwid, at: new Date('2026-10-14T20:30:15Z') });
    assert.deepEqual(parseSn(sn), { accountCode: acct, hardwareCode: hwid, timeCode: '20261014203015' });
  });

  it('exposes the fleet as the account prefix, which is what grouping uses', () => {
    const sn = buildSn({ accountCode: acct, hardwareCode: hwid });
    assert.equal(fleetOf(sn), acct);
    assert.equal(fleetOf('not-an-sn'), null);
  });

  it('refuses to build without an account code', () => {
    // An SN with no account would be a machine claiming no fleet, and emitting that quietly is
    // how a machine ends up in the wrong pool.
    assert.throws(() => buildSn({ hardwareCode: hwid }), /8-hex account code/);
    assert.throws(() => buildSn({ accountCode: 'short', hardwareCode: hwid }), /8-hex account code/);
  });

  it('refuses to build without a hardware code', () => {
    assert.throws(() => buildSn({ accountCode: acct }), /12-hex hardware code/);
  });

  it('rejects malformed strings in parse and shape checks', () => {
    for (const bad of ['', 'W2M-', 'W2M-3f9a1c2e-7b4d0e91a3c5', 'W2M-3F9A1C2E-7b4d0e91a3c5-20261014203015', 'X2M-3f9a1c2e-7b4d0e91a3c5-20261014203015', null, 42]) {
      assert.equal(isWellFormedSn(bad), false, `${bad} should not be well formed`);
      assert.equal(parseSn(bad), null);
    }
  });

  it('DOCUMENTS that a well-formed SN proves nothing', () => {
    // This test asserts the weakness rather than the strength. An attacker who knows an account id
    // can compute a shape-valid SN for hardware they do not own, and `isWellFormedSn` accepts it.
    // If a future change makes this test fail, the change has made the shape check into an
    // authorisation check — which it cannot be, because the value is client-computed.
    const forged = buildSn({ accountCode: accountCode(USER), hardwareCode: '000000000000' });
    assert.equal(isWellFormedSn(forged), true, 'the shape check accepts a forged SN, by construction');
    // Nothing in this module claims otherwise; authorisation is the relay signature chain.
  });
});

describe('hardware sources are platform-shaped and injectable', () => {
  it('declares sources for the three platforms it supports', () => {
    for (const p of ['win32', 'darwin', 'linux']) {
      assert.ok(Array.isArray(HW_SOURCES[p]), `${p} has no sources`);
      assert.ok(HW_SOURCES[p].length > 0, `${p} has an empty source list`);
      for (const s of HW_SOURCES[p]) assert.ok(typeof s.key === 'string' && s.key !== '', `${p} source without a key`);
    }
  });

  it('reads a linux machine-id through an injected reader', async () => {
    const result = await readHardwareValues({
      platform: 'linux',
      read: async (spec) => (spec.key === 'machine-id' ? 'abc123def456\n' : null),
    });
    assert.deepEqual(result.values, [{ source: 'machine-id', value: 'abc123def456' }]);
  });

  it('reads a Windows MachineGuid through an injected reader', async () => {
    const result = await readHardwareValues({
      platform: 'win32',
      read: async (spec) => (spec.key === 'MachineGuid' ? '9f2c7e14-1a3b-4c5d-8e9f-0a1b2c3d4e5f' : null),
    });
    assert.equal(result.values[0].source, 'MachineGuid');
    assert.equal(result.values[0].value, '9f2c7e14-1a3b-4c5d-8e9f-0a1b2c3d4e5f');
  });

  it('parses a macOS IOPlatformUUID out of ioreg output', async () => {
    // The real extract path, exercised through the exec seam rather than a pre-extracted value.
    const ioreg = '  "IOPlatformUUID" = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"\n';
    const result = await readHardwareValues({
      platform: 'darwin',
      exec: async () => ioreg,
    });
    assert.deepEqual(result.values, [{ source: 'IOPlatformUUID', value: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890' }]);
  });

  it('falls through to the next source when one is unreadable', async () => {
    const result = await readHardwareValues({
      platform: 'linux',
      read: async (spec) => {
        if (spec.key === 'machine-id') throw new Error('EACCES');
        return 'dbus-value';
      },
    });
    assert.deepEqual(result.values, [{ source: 'dbus-machine-id', value: 'dbus-value' }]);
  });

  it('reports which source was used, so a changed fingerprint is debuggable', async () => {
    const audits = [];
    await readHardwareValues({
      platform: 'win32',
      read: async (spec) => {
        if (spec.key === 'MachineGuid') throw new Error('no key');
        return 'uuid-value';
      },
      audit: (e, d) => audits.push({ e, ...d }),
    });
    assert.ok(audits.some((a) => a.e === 'hw/source-failed' && a.source === 'MachineGuid'));
  });

  it('returns nothing usable for a platform it does not know', async () => {
    const result = await readHardwareValues({ platform: 'plan9', read: async () => 'x' });
    assert.deepEqual(result.values, []);
  });
});

describe('placeholder hardware values are refused, because they would merge machines', () => {
  it('rejects the all-zeroes UUID that firmware reports when unset', () => {
    // Hashing this would give every such machine the SAME hardware code — far worse than having
    // none, because it silently merges distinct machines into one identity.
    for (const v of [
      '00000000-0000-0000-0000-000000000000',
      'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
      'To be filled by O.E.M.',
      'Default string',
      'None',
      '',
      '   ',
    ]) {
      assert.equal(isUsefulHardwareValue(v), false, `${v} should be refused`);
    }
  });

  it('accepts a real-looking value', () => {
    assert.equal(isUsefulHardwareValue('9f2c7e14-1a3b-4c5d-8e9f-0a1b2c3d4e5f'), true);
    assert.equal(isUsefulHardwareValue('abc123def456'), true);
  });

  it('drops them before hashing, rather than including them', async () => {
    const result = await readHardwareValues({
      platform: 'win32',
      read: async (spec) => (spec.key === 'MachineGuid' ? 'Default string' : '03000200-0400-0500-0006-000700080009'),
    });
    assert.deepEqual(result.values, [], 'both placeholder values must be dropped');
  });
});

describe('the identity service', () => {
  const account = { getDeviceIdentity: async () => ({ userId: USER, deviceId: 'dev-1', osVersion: '10.0' }) };
  const hardware = { platform: 'linux', read: async () => 'machine-id-value' };

  it('builds an SN from the account and the hardware', async () => {
    const identity = createAccountIdentity({ account, hardware });
    const result = await identity.resolve();
    assert.equal(result.ok, true);
    assert.match(result.sn, SN_PATTERN);
    assert.equal(result.accountCode, accountCode(USER));
    assert.equal(result.reused, false);
  });

  it('reads the account from ctx.get, which is how a real host exposes it', async () => {
    const ctx = { get: (key) => (key === 'deepseekAccount' ? account : undefined) };
    const result = await createAccountIdentity({ ctx, hardware }).resolve();
    assert.equal(result.ok, true);
  });

  it('says signed-out rather than inventing a fleet', async () => {
    // A placeholder here would put two unrelated machines in one pool — the defect being removed.
    const identity = createAccountIdentity({ account: { getDeviceIdentity: async () => ({ osVersion: '10.0' }) }, hardware });
    const result = await identity.resolve();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'signed-out');
    assert.equal(result.sn, undefined, 'no SN may be produced for a signed-out machine');
  });

  it('names a missing account service rather than crashing', async () => {
    const result = await createAccountIdentity({ hardware }).resolve();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_account_service');
  });

  it('names a failing identity read rather than propagating it', async () => {
    const identity = createAccountIdentity({
      account: {
        getDeviceIdentity: async () => {
          throw new Error('keychain locked');
        },
      },
      hardware,
    });
    const result = await identity.resolve();
    assert.equal(result.reason, 'identity_read_failed');
    assert.match(result.detail, /keychain locked/);
  });

  it('refuses to build an SN when no hardware source works', async () => {
    const identity = createAccountIdentity({ account, hardware: { platform: 'linux', read: async () => null } });
    const result = await identity.resolve();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_hardware_source');
  });

  it('reuses a stored SN and never regenerates it', async () => {
    // Regenerating on each start would make every restart look like a new device, and the fleet
    // would fill with ghosts of one machine.
    const stored = buildSn({ accountCode: accountCode(USER), hardwareCode: 'abcdef123456', at: new Date('2020-01-01T00:00:00Z') });
    const identity = createAccountIdentity({ account, hardware, stored });
    const result = await identity.resolve();
    assert.equal(result.sn, stored, 'the stored SN must come back byte for byte');
    assert.equal(result.reused, true);
    assert.equal(result.timeCode, '20200101000000', 'the original timestamp survives');
  });

  it('refuses a malformed stored SN instead of silently minting a new one', async () => {
    // Silently replacing it would hide a corrupted state file behind a machine that looks new.
    const identity = createAccountIdentity({ account, hardware, stored: 'W2M-garbage' });
    const result = await identity.resolve();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stored_sn_malformed');
  });

  it('reports the hardware sources so an operator can see what was used', async () => {
    const identity = createAccountIdentity({
      account,
      hardware: { platform: 'win32', read: async (spec) => (spec.key === 'MachineGuid' ? 'guid-value' : null) },
    });
    const result = await identity.resolve();
    assert.deepEqual(result.hardwareSources, ['MachineGuid']);
  });

  it('separates identify from fingerprint, so each can be checked alone', async () => {
    const identity = createAccountIdentity({ account, hardware });
    const who = await identity.identify();
    const what = await identity.fingerprint();
    assert.equal(who.accountCode, accountCode(USER));
    assert.ok(what.hardwareCode.length === 12);
  });

  it('gives two accounts different fleets and two machines in one account the same fleet', async () => {
    // The property the whole scheme exists for, asserted directly.
    const a1 = await createAccountIdentity({ account, hardware }).resolve();
    const a2 = await createAccountIdentity({ account, hardware }).resolve();
    assert.equal(fleetOf(a1.sn), fleetOf(a2.sn), 'same account, same fleet');

    const other = { getDeviceIdentity: async () => ({ userId: 'a-totally-different-account' }) };
    const b = await createAccountIdentity({ account: other, hardware }).resolve();
    assert.notEqual(fleetOf(b.sn), fleetOf(a1.sn), 'different account, different fleet');
  });

  it('gives one account two machines different SNs', async () => {
    const m1 = await createAccountIdentity({ account, hardware }).resolve();
    const m2 = await createAccountIdentity({
      account,
      hardware: { platform: 'linux', read: async () => 'a-different-machine-id' },
    }).resolve();
    assert.notEqual(m1.sn, m2.sn);
    assert.equal(fleetOf(m1.sn), fleetOf(m2.sn), 'but they are in the same fleet');
  });
});
