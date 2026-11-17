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
  addMachineEnvelope,
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
