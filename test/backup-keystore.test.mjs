/**
 * The repository key: one DEK, wrapped under every credential this machine can offer, and upgradeable.
 *
 * The upgrade case is the reason this file exists: a repository seeded with a password must become passwordless on
 * the first machine that can hold a machine envelope -- otherwise a scheduled run could never open it (a timer
 * cannot type a password). The test drives exactly that sequence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  KEYSTORE_CODES,
  setRepositoryPassword,
  NO_PERMISSION,
  addAccountEnvelope,
  addMachineEnvelope,
  bindAccount,
  openRepoKey,
  readRepoKeys,
  repoKeysPath,
} from '../src/backup/keystore.mjs';
import { ensureLayout } from '../src/backup/layout.mjs';
import { ENVELOPE_FORMAT, MIN_SCRYPT } from '../src/backup/crypto.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

/** Identity-faking DPAPI transport: protect echoes base64, unprotect decodes it. */
function fakeRunner(command, args, input = '') {
  const text = args.join(' ');
  if (text.includes('ProtectedData]::Protect') || text.includes('ProtectedData]::Unprotect')) {
    return { ok: true, status: 0, stdout: input, stderr: '', error: '' };
  }
  return { ok: true, status: 0, stdout: 'ok', stderr: '', error: '' };
}

const KDF = { algo: 'scrypt', N: MIN_SCRYPT.N, r: MIN_SCRYPT.r, p: MIN_SCRYPT.p, keylen: 32 };
const PASSWORD = 'correct horse battery staple';

/** A repository root plus a home directory (for machine.key). */
function fixture() {
  const { dir, cleanup } = tempDir('w2m-keystore-');
  const root = `${dir}/repo`;
  ensureLayout(root);
  return { dir, root, home: `${dir}/home`, cleanup };
}

describe('keystore: first use', () => {
  it('mints one DEK and wraps it under the machine secret and the password', () => {
    const { root, home, cleanup } = fixture();
    try {
      const opened = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(opened.ok, true, opened.detail ?? '');
      assert.equal(opened.created, true);
      assert.equal(opened.dek.length, 32);
      assert.equal(opened.machine_envelope_added, false, 'a freshly created repository is not an upgrade');
      const document = readRepoKeys(root);
      assert.equal(document.ok, true);
      assert.equal(document.keys.format, ENVELOPE_FORMAT);
      assert.deepEqual(document.keys.envelopes.map((envelope) => envelope.kind).sort(), ['machine', 'password']);
      assert.equal(existsSync(repoKeysPath(root)), true);
    } finally {
      cleanup();
    }
  });

  it('refuses to create a repository no credential can open', () => {
    const { root, home, cleanup } = fixture();
    try {
      const opened = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(opened.ok, false);
      assert.equal(opened.reason_code, NO_PERMISSION);
      assert.match(opened.detail, /no credential/u);
      assert.equal(existsSync(repoKeysPath(root)), false, 'a refused creation must not leave a key file');
    } finally {
      cleanup();
    }
  });
});

describe('keystore: opening an existing repository', () => {
  it('opens with the password and upgrades the document with a machine envelope', () => {
    const { root, home, cleanup } = fixture();
    try {
      const created = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(created.ok, true, created.detail ?? '');
      assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind), ['password']);

      const upgraded = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(upgraded.ok, true, upgraded.detail ?? '');
      assert.equal(upgraded.unlocked_via, 'password');
      assert.equal(upgraded.machine_envelope_added, true, 'the password-seeded repository must gain a machine envelope');
      assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind).sort(), ['machine', 'password']);
      assert.deepEqual(upgraded.dek, created.dek, 'the DEK must not change: existing blocks are encrypted under it');

      // The point of the upgrade: the next run needs no password at all.
      const passwordless = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(passwordless.ok, true, passwordless.detail ?? '');
      assert.equal(passwordless.unlocked_via, 'machine');
      assert.deepEqual(passwordless.dek, created.dek);
      assert.equal(passwordless.machine_envelope_added, false, 'a second open is not another upgrade');
    } finally {
      cleanup();
    }
  });

  it('refuses a wrong password without touching the key file', () => {
    const { root, home, cleanup } = fixture();
    try {
      openRepoKey({ root, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, kdf: KDF });
      const before = readFileSync(repoKeysPath(root), 'utf8');
      const refused = openRepoKey({ root, dshHome: home, password: 'wrong', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, NO_PERMISSION);
      assert.match(refused.detail, /cannot be opened/u);
      assert.ok(Array.isArray(refused.attempts));
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before);
    } finally {
      cleanup();
    }
  });

  it('reports a corrupt key document instead of pretending it opened', () => {
    const { root, home, cleanup } = fixture();
    try {
      openRepoKey({ root, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, kdf: KDF });
      writeFileSync(repoKeysPath(root), '{"format":"w2m-session-backup/keys","version":1,"envelopes":[]}');
      const result = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, KEYSTORE_CODES.CORRUPT);
    } finally {
      cleanup();
    }
  });
});

describe('keystore: envelope arithmetic', () => {
  it('never adds a second machine envelope', () => {
    const { dir, cleanup } = tempDir('w2m-keystore-add-');
    try {
      ensureLayout(`${dir}/repo`);
      const opened = openRepoKey({ root: `${dir}/repo`, dshHome: `${dir}/home`, password: PASSWORD, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(opened.ok, true);
      const result = addMachineEnvelope(opened.keys, opened.dek, Buffer.alloc(32, 1));
      assert.equal(result.added, false);
      assert.equal(result.reason, 'already has a machine envelope');
    } finally {
      cleanup();
    }
  });

  it('refuses to wrap nothing', () => {
    const result = addMachineEnvelope({ envelopes: [] }, Buffer.alloc(0), Buffer.alloc(32, 1));
    assert.equal(result.added, false);
    assert.equal(result.reason, 'no data key to wrap');
    assert.equal(addMachineEnvelope(null, Buffer.alloc(32, 1), Buffer.alloc(32, 1)).added, false);
  });
});

describe('keystore: adding a password envelope to a machine-only repository', () => {
  it('opens the machine-only repo, adds a password envelope with the same DEK, and the password alone opens it', () => {
    const { dir, cleanup } = tempDir('w2m-keystore-setpw-');
    try {
      const root = `${dir}/repo`;
      ensureLayout(root);
      const home = `${dir}/home`;
      const created = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(created.ok, true, created.detail ?? '');
      assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind), ['machine']);

      const upgraded = setRepositoryPassword({ root, dshHome: home, password: 'recovery-password', platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(upgraded.ok, true, upgraded.detail ?? '');
      assert.equal(upgraded.added, true);
      assert.deepEqual(upgraded.envelopes.sort(), ['machine', 'password']);
      assert.equal(existsSync(upgraded.backup_file), true, 'the old key document is kept before the write');

      const passwordOnly = openRepoKey({ root, dshHome: home, password: 'recovery-password', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(passwordOnly.ok, true, passwordOnly.detail ?? '');
      assert.deepEqual(passwordOnly.dek, created.dek, 'the DEK must not change');
      assert.equal(passwordOnly.unlocked_via, 'password');

      const wrong = openRepoKey({ root, dshHome: home, password: 'not-the-password', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(wrong.ok, false);
      assert.equal(wrong.reason_code, NO_PERMISSION);
    } finally {
      cleanup();
    }
  });

  it('is idempotent and refuses a short password without touching the file', () => {
    const { dir, cleanup } = tempDir('w2m-keystore-setpw2-');
    try {
      const root = `${dir}/repo`;
      ensureLayout(root);
      const home = `${dir}/home`;
      openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, kdf: KDF });
      const first = setRepositoryPassword({ root, dshHome: home, password: 'recovery-password', platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(first.ok, true);
      const before = readFileSync(repoKeysPath(root), 'utf8');
      const again = setRepositoryPassword({ root, dshHome: home, password: 'recovery-password', platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(again.ok, true);
      assert.equal(again.added, false);
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before, 'a second call must not rewrite the document');

      const short = setRepositoryPassword({ root, dshHome: home, password: 'short', platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(short.ok, false);
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before);
    } finally {
      cleanup();
    }
  });
});

describe('keystore: account id binding (compare-only, docs/BACKUP-DESIGN.md §25)', () => {
  const ACCOUNT = 'user-1234abcd';
  const OTHER = 'user-9999ffff';

  /** A repository with only a machine envelope (the scheduled-run default). */
  function machineOnlyRepo() {
    const { dir, cleanup } = tempDir('w2m-keystore-account-');
    const root = `${dir}/repo`;
    ensureLayout(root);
    const home = `${dir}/home`;
    const created = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, kdf: KDF });
    assert.equal(created.ok, true, created.detail ?? '');
    assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind), ['machine']);
    return { dir, root, home, created, cleanup };
  }

  it('binds a machine-only repository, records the id, and the account credential alone opens the same DEK', () => {
    const { root, home, created, cleanup } = machineOnlyRepo();
    try {
      const bound = bindAccount({ root, dshHome: home, accountId: ACCOUNT, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(bound.ok, true, bound.detail ?? '');
      assert.equal(bound.added, true);
      assert.deepEqual(bound.envelopes.slice().sort(), ['account', 'machine']);
      assert.equal(bound.account.bound, true);
      assert.equal(bound.account.matched, true);
      assert.equal(bound.account.id_hint, '…abcd', 'only the last four characters are reported');
      assert.equal(String(bound.account.id_hint).includes(ACCOUNT), false);
      assert.equal(existsSync(bound.backup_file), true, 'the previous key document is kept before the write');

      const document = readRepoKeys(root);
      assert.equal(document.ok, true);
      assert.equal(document.keys.account_binding.account_id, ACCOUNT);
      assert.match(document.keys.account_binding.bound_at, /^\d{4}-\d{2}-\d{2}T/u);
      assert.ok(document.keys.envelopes.some((envelope) => envelope.kind === 'account'), 'the envelope list includes account');

      // The point of the binding: no machine key, no password -- the matching account id alone opens it.
      const viaAccount = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, accountId: ACCOUNT, kdf: KDF });
      assert.equal(viaAccount.ok, true, viaAccount.detail ?? '');
      assert.equal(viaAccount.unlocked_via, 'account');
      assert.deepEqual(viaAccount.dek, created.dek, 'the DEK must not change: existing blocks stay readable');
      assert.deepEqual(viaAccount.account, { bound: true, matched: true, id_hint: '…abcd' });
    } finally {
      cleanup();
    }
  });

  it('refuses a different account id but leaves the machine and password paths working', () => {
    const { root, home, created, cleanup } = machineOnlyRepo();
    try {
      const bound = bindAccount({ root, dshHome: home, accountId: ACCOUNT, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(bound.ok, true, bound.detail ?? '');
      setRepositoryPassword({ root, dshHome: home, password: 'recovery-password', platform: 'win32', runner: fakeRunner, kdf: KDF });

      // Wrong id, no other credential: the account path is refused (the user's rule: mismatch -> password mode).
      const refused = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, accountId: OTHER, kdf: KDF });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, NO_PERMISSION);
      assert.deepEqual(refused.account, { bound: true, matched: false, id_hint: '…abcd' });
      assert.ok(refused.attempts.some((attempt) => attempt.kind === 'account' && attempt.code === KEYSTORE_CODES.ACCOUNT_MISMATCH),
        'the mismatch is named, not reported as a generic authentication failure');

      // Wrong id + password: the password path still opens the same DEK.
      const viaPassword = openRepoKey({ root, dshHome: home, password: 'recovery-password', platform: 'linux', machineKey: false, accountId: OTHER, kdf: KDF });
      assert.equal(viaPassword.ok, true, viaPassword.detail ?? '');
      assert.equal(viaPassword.unlocked_via, 'password');
      assert.deepEqual(viaPassword.dek, created.dek);

      // Wrong id + machine key: the machine path still opens it on its own machine.
      const viaMachine = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, accountId: OTHER, kdf: KDF });
      assert.equal(viaMachine.ok, true, viaMachine.detail ?? '');
      assert.equal(viaMachine.unlocked_via, 'machine');
    } finally {
      cleanup();
    }
  });

  it('re-binding the same id is a no-op and binding a different id is refused', () => {
    const { root, home, cleanup } = machineOnlyRepo();
    try {
      const first = bindAccount({ root, dshHome: home, accountId: ACCOUNT, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(first.ok, true, first.detail ?? '');
      const before = readFileSync(repoKeysPath(root), 'utf8');
      const again = bindAccount({ root, dshHome: home, accountId: ACCOUNT, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(again.ok, true);
      assert.equal(again.added, false);
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before, 'a second bind must not rewrite the document');

      const other = bindAccount({ root, dshHome: home, accountId: OTHER, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(other.ok, false);
      assert.equal(other.reason_code, KEYSTORE_CODES.ACCOUNT_MISMATCH);
      assert.match(other.detail, /different account/u);
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before, 'a refused re-bind must not touch the document');
      assert.equal(readRepoKeys(root).keys.account_binding.account_id, ACCOUNT);
    } finally {
      cleanup();
    }
  });

  it('addAccountEnvelope refuses unusable ids and never invents a binding for an empty id', () => {
    const { root, home, cleanup } = machineOnlyRepo();
    try {
      const opened = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, kdf: KDF });
      assert.equal(opened.ok, true);
      for (const bad of ['', '   ', null, 42]) {
        const refused = addAccountEnvelope(opened.keys, opened.dek, bad);
        assert.equal(refused.added, false, `accountId=${JSON.stringify(bad)} must be refused`);
        assert.equal(refused.reason_code, KEYSTORE_CODES.ACCOUNT_INVALID);
      }
      assert.equal(readRepoKeys(root).keys.account_binding, undefined, 'nothing is written for a refused binding');
    } finally {
      cleanup();
    }
  });
});
