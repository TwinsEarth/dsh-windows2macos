import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { selectFleetKey } from '../src/plugin/fleet-binding.mjs';
import {
  FLEET_HOME_FILE,
  fleetHomePath,
  getFleetHome,
  readFleetHome,
  rememberFleetAccount,
  rememberFleetHome,
  shouldPreserveExistingFleet,
} from '../src/plugin/fleet-home.mjs';

const ACCOUNT_A = 'aaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb';
const KEY_A = 'alpha-home-fleet-key';
const KEY_B = 'beta-home-fleet-key';
const KEY_A_DERIVED_LATER = 'alpha-account-key-after-switch';

let work;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'w2m-fleet-home-'));
});
after(() => {
  rmSync(work, { recursive: true, force: true });
});

function homeFile() {
  return fleetHomePath(join(work, 'device.json'));
}

/** The production decision, without the network: home wins; a first account joins its account fleet. */
function bind(file, accountCode, derivedKey) {
  const read = readFleetHome(file);
  assert.equal(read.ok, true, 'the home map must be readable');
  const home = getFleetHome(read.homes, accountCode);
  const picked = selectFleetKey({
    account: derivedKey,
    home: home?.fleet_key ?? null,
    policy: 'home',
  });
  if (picked.source === 'account') {
    const written = rememberFleetHome(file, { accountCode, fleetKey: picked.fleetKey });
    assert.equal(written.ok, true, 'a first join must be remembered');
  } else {
    const written = rememberFleetAccount(file, accountCode);
    assert.equal(written.ok, true, 'a return updates the last account without touching keys');
  }
  return picked;
}

describe('fleet home: the leaver returns, nobody else moves', () => {
  it('is the file beside device.json, missing means empty history, not an error', () => {
    assert.equal(fleetHomePath(join('/state', 'device.json')), join('/state', FLEET_HOME_FILE));
    assert.equal(fleetHomePath(null), null);
    const read = readFleetHome(homeFile());
    assert.deepEqual(read, { ok: true, homes: {}, lastAccount: null, path: homeFile() });
  });

  it('A joins first with its account key; B first joins with B; back to A returns A’s home, not a new A fleet', () => {
    const file = homeFile();

    // A's first appearance: no home, so the account key is the fleet it joins.
    assert.deepEqual(bind(file, ACCOUNT_A, KEY_A), { fleetKey: KEY_A, source: 'account' });
    assert.equal(readFleetHome(file).lastAccount, ACCOUNT_A);

    // B's first appearance: the account policy may create/join B's fleet; A's home is untouched.
    assert.deepEqual(bind(file, ACCOUNT_B, KEY_B), { fleetKey: KEY_B, source: 'account' });
    assert.equal(readFleetHome(file).lastAccount, ACCOUNT_B);

    // A comes back. The account now derives a *different* key (the 2.2.0 failure); home wins and no
    // new fleet is created. B's entry must still be there -- switching A never edits B.
    assert.deepEqual(bind(file, ACCOUNT_A, KEY_A_DERIVED_LATER), { fleetKey: KEY_A, source: 'home' });
    assert.equal(readFleetHome(file).lastAccount, ACCOUNT_A);
    const after = readFleetHome(file);
    assert.equal(after.ok, true);
    assert.equal(getFleetHome(after.homes, ACCOUNT_A)?.fleet_key, KEY_A);
    assert.equal(getFleetHome(after.homes, ACCOUNT_B)?.fleet_key, KEY_B);

    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.last_account, ACCOUNT_A);
    assert.equal(persisted.homes[ACCOUNT_A].fleet_key, KEY_A);
    assert.equal(persisted.homes[ACCOUNT_B].fleet_key, KEY_B);
  });

  it('policy account follows the derived key and does not overwrite a remembered home', () => {
    const file = homeFile();
    const read = readFleetHome(file);
    assert.equal(read.ok, true);
    assert.deepEqual(selectFleetKey({
      account: KEY_A_DERIVED_LATER,
      home: KEY_A,
      policy: 'account',
    }), { fleetKey: KEY_A_DERIVED_LATER, source: 'account' });
    // The decision above does not write; the persisted A home is still the old fleet.
    assert.equal(getFleetHome(read.homes, ACCOUNT_A)?.fleet_key, KEY_A);
  });

  it('policy config wins over home and account when a key is pinned', () => {
    assert.deepEqual(selectFleetKey({
      configured: 'pinned-key',
      account: KEY_A_DERIVED_LATER,
      home: KEY_A,
      policy: 'config',
    }), { fleetKey: 'pinned-key', source: 'config' });
  });

  it('a corrupt home is refused, and is not overwritten by a later remember', () => {
    const file = join(work, 'corrupt', FLEET_HOME_FILE);
    // remember creates the parent; then corrupt the file on purpose.
    assert.equal(rememberFleetHome(file, { accountCode: ACCOUNT_A, fleetKey: KEY_A }).ok, true);
    writeFileSync(file, '{not json', 'utf8');
    const read = readFleetHome(file);
    assert.equal(read.ok, false);
    assert.equal(read.code, 'FLEET_HOME_CORRUPT');
    const written = rememberFleetHome(file, { accountCode: ACCOUNT_B, fleetKey: KEY_B });
    assert.equal(written.ok, false);
    assert.equal(written.code, 'FLEET_HOME_CORRUPT');
    assert.equal(readFileSync(file, 'utf8'), '{not json', 'the unreadable history is preserved for repair');
  });

  it('upgrading a paired machine with no home stays put instead of deriving an account fleet', () => {
    // This is the 2.2.0 -> 2.2.1 migration case: macmini is still in the old fleet, has a token,
    // but has no home yet. Deriving the account key here would move it without anyone asking.
    assert.equal(shouldPreserveExistingFleet({ hasToken: true }), true);
    assert.equal(shouldPreserveExistingFleet({ hasToken: true, accountChanged: true }), false);
    assert.equal(shouldPreserveExistingFleet({ hasToken: true, hasConfiguredKey: true }), false);
    assert.equal(shouldPreserveExistingFleet({ hasToken: true, hasHome: true }), false);
    assert.equal(shouldPreserveExistingFleet({ hasToken: false }), false);
    assert.equal(shouldPreserveExistingFleet({ hasToken: true, policy: 'account' }), false);
    assert.equal(shouldPreserveExistingFleet({ hasToken: true, policy: 'config' }), false);
  });
});
