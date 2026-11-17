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
  UNENCRYPTED_WARNING,
  WEAK_PIN_WARNING,
  setEncryptionMode,
  setRepositoryPassword,
  NO_PERMISSION,
  addAccountEnvelope,
  addMachineEnvelope,
  addOpenEnvelope,
  bindAccount,
  keysEncryption,
  openRepoKey,
  readRepoKeys,
  repoKeysPath,
  resolveEncryptionMode,
} from '../src/backup/keystore.mjs';
import { ensureLayout, descriptorEncryption, readDescriptor } from '../src/backup/layout.mjs';
import {
  CRYPTO_CODES,
  ENVELOPE_FORMAT,
  MIN_SCRYPT,
  randomDek,
  validateKeysFile,
  wrapDek,
  wrapOpenDek,
} from '../src/backup/crypto.mjs';
import { describeUnlock } from '../src/backup/unlock.mjs';
import { buildStatus } from '../src/backup/routes.mjs';
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
      const opened = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
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

  it('defaults a new repository to unencrypted, and it opens with no credential at all', () => {
    const { root, home, cleanup } = fixture();
    try {
      // No password, no explicit machineKey, no account id: the default is `none` (user decision 2026-11-17).
      const opened = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(opened.ok, true, opened.detail ?? '');
      assert.equal(opened.created, true);
      assert.equal(opened.encryption, 'none');
      assert.equal(opened.unlocked_via, 'none');
      assert.deepEqual(opened.available_paths, ['none']);
      assert.equal(opened.machine.ok, false, 'an unencrypted repository must not even probe the OS keystore');
      assert.equal(opened.dek.length, 32);

      const document = readRepoKeys(root);
      assert.equal(document.ok, true);
      assert.deepEqual(document.keys.envelopes.map((envelope) => envelope.kind), ['open']);
      assert.equal(document.keys.envelopes[0].alg, 'none');
      assert.equal(document.keys.envelopes[0].dek, opened.dek.toString('base64'), 'the documented consequence: the DEK is in clear');
      assert.equal(descriptorEncryption(readDescriptor(root)), 'none', 'the descriptor records the mode');

      // Second open: still no credential needed, and no key is written again.
      const again = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(again.ok, true, again.detail ?? '');
      assert.equal(again.created, false);
      assert.equal(again.unlocked_via, 'none');
      assert.deepEqual(again.dek, opened.dek);
      assert.equal(again.attempts[0].kind, 'open');
      assert.equal(again.attempts[0].ok, true);
      assert.equal(again.attempts[0].code, null);
    } finally {
      cleanup();
    }
  });

  it('still refuses to create a repository when sealed protection is explicitly requested without a credential', () => {
    const { root, home, cleanup } = fixture();
    try {
      const opened = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, encryption: 'sealed', kdf: KDF });
      assert.equal(opened.ok, false);
      assert.equal(opened.reason_code, NO_PERMISSION);
      assert.match(opened.detail, /sealed/u);
      assert.equal(existsSync(repoKeysPath(root)), false, 'a refused creation must not leave a key file');
    } finally {
      cleanup();
    }
  });

  it('refuses an unknown encryption mode with the configuration-invalid code', () => {
    const { root, home, cleanup } = fixture();
    try {
      const opened = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, encryption: 'maybe', kdf: KDF });
      assert.equal(opened.ok, false);
      assert.equal(opened.reason_code, 'BACKUP_CONFIG_INVALID');
      assert.match(opened.detail, /must be one of none, sealed/u);
      assert.equal(existsSync(repoKeysPath(root)), false);
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

      const upgraded = openRepoKey({ root, dshHome: home, password: PASSWORD, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(upgraded.ok, true, upgraded.detail ?? '');
      assert.equal(upgraded.unlocked_via, 'password');
      assert.equal(upgraded.machine_envelope_added, true, 'the password-seeded repository must gain a machine envelope');
      assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind).sort(), ['machine', 'password']);
      assert.deepEqual(upgraded.dek, created.dek, 'the DEK must not change: existing blocks are encrypted under it');

      // The point of the upgrade: the next run needs no password at all.
      const passwordless = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
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
      const opened = openRepoKey({ root: `${dir}/repo`, dshHome: `${dir}/home`, password: PASSWORD, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
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
      const created = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(created.ok, true, created.detail ?? '');
      assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind), ['machine']);

      const upgraded = setRepositoryPassword({ root, dshHome: home, password: 'recovery-password', platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
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

  it('is idempotent and refuses an empty/too-short PIN without touching the file', () => {
    const { dir, cleanup } = tempDir('w2m-keystore-setpw2-');
    try {
      const root = `${dir}/repo`;
      ensureLayout(root);
      const home = `${dir}/home`;
      openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      const first = setRepositoryPassword({ root, dshHome: home, password: '1234', platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(first.ok, true, first.detail ?? '');
      assert.equal(first.weak, true, 'a 4-digit PIN is accepted but reported weak');
      assert.equal(first.warning, WEAK_PIN_WARNING, 'the caller surfaces the honest warning');
      assert.equal(first.mode_after, 'sealed');
      const before = readFileSync(repoKeysPath(root), 'utf8');
      const again = setRepositoryPassword({ root, dshHome: home, password: '1234', platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(again.ok, true);
      assert.equal(again.added, false);
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before, 'a second call must not rewrite the document');

      for (const tooShort of ['abc', '']) {
        const short = setRepositoryPassword({ root, dshHome: home, password: tooShort, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
        assert.equal(short.ok, false, `a ${tooShort.length}-byte PIN must be refused`);
        assert.match(short.detail, tooShort === '' ? /empty/u : /at least 4/u);
        assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before);
      }
    } finally {
      cleanup();
    }
  });
});

describe('keystore: the public password hint (no PIN rotation by decision)', () => {
  const PIN = '1234';
  const HINT = '周六生日';

  /** A machine-only repository: the shape that can still gain a PIN (an existing PIN is never rotated). */
  function machineOnlyRepo() {
    const { dir, cleanup } = tempDir('w2m-keystore-hint-');
    const root = `${dir}/repo`;
    ensureLayout(root);
    const home = `${dir}/home`;
    const created = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
    assert.equal(created.ok, true, created.detail ?? '');
    return { dir, root, home, created, cleanup };
  }

  it('stores the hint with the password envelope, returns it, and the 4-digit PIN alone still opens', () => {
    const { root, home, created, cleanup } = machineOnlyRepo();
    try {
      const upgraded = setRepositoryPassword({
        root, dshHome: home, password: PIN, hint: '  周六   生日  ',
        platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF,
      });
      assert.equal(upgraded.ok, true, upgraded.detail ?? '');
      assert.equal(upgraded.added, true);
      // Trimmed AND whitespace-collapsed: the stored text is the public hint in its canonical one-line form.
      const collapsed = '周六 生日';
      assert.deepEqual(upgraded.hint, { set: true, text: collapsed }, 'the hint is trimmed, whitespace-collapsed and returned');
      assert.equal(upgraded.weak, true, 'a 4-digit PIN is accepted and reported weak');
      assert.equal(upgraded.warning, WEAK_PIN_WARNING);

      const document = readRepoKeys(root);
      assert.equal(document.ok, true);
      assert.equal(document.keys.password_hint.text, collapsed, 'the hint is persisted at the keys.json root');
      assert.match(document.keys.password_hint.updated_at, /^\d{4}-\d{2}-\d{2}T/u);
      assert.deepEqual(document.keys.envelopes.map((envelope) => envelope.kind).sort(), ['machine', 'password']);
      assert.equal(JSON.stringify(document.keys.envelopes).includes(collapsed), false, 'the hint is root metadata, not envelope material');

      // Neither the PIN nor the data key may leak through the hint, the result or the written document.
      const keysText = readFileSync(repoKeysPath(root), 'utf8');
      assert.equal(keysText.includes(PIN), false, 'the PIN itself is never stored in clear');
      const resultText = JSON.stringify(upgraded);
      assert.equal(resultText.includes(PIN), false, 'the result never echoes the PIN');
      assert.equal(resultText.includes(collapsed), true, 'the hint is public, so the result reports it');
      assert.equal(resultText.includes(created.dek.toString('base64')), false, 'the DEK never appears in the result');
      assert.equal(resultText.includes(created.dek.toString('hex')), false);

      const opened = openRepoKey({ root, dshHome: home, password: PIN, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(opened.ok, true, opened.detail ?? '');
      assert.equal(opened.unlocked_via, 'password', 'the stored hint changes nothing about the PIN path');
      assert.deepEqual(opened.dek, created.dek, 'the DEK must not change: existing blocks stay readable');
    } finally {
      cleanup();
    }
  });

  it('refuses an unusable hint without writing anything, and accepts exactly 120 characters', () => {
    const refused = machineOnlyRepo();
    try {
      const before = readFileSync(repoKeysPath(refused.root), 'utf8');
      const cases = [
        { hint: 'x'.repeat(121), pattern: /1-120 characters/u },
        { hint: PIN, pattern: /PIN\/password itself/u },
        { hint: 42, pattern: /must be a string/u },
        { hint: '   ', pattern: /1-120 characters/u },
      ];
      for (const entry of cases) {
        const result = setRepositoryPassword({
          root: refused.root, dshHome: refused.home, password: PIN, hint: entry.hint,
          platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF,
        });
        assert.equal(result.ok, false, `hint=${JSON.stringify(entry.hint)} must be refused`);
        assert.equal(result.reason_code, KEYSTORE_CODES.HINT_INVALID);
        assert.match(result.detail, entry.pattern);
        assert.deepEqual(result.hint, { set: false });
        assert.equal(readFileSync(repoKeysPath(refused.root), 'utf8'), before, 'a refused hint must not write the repository');
      }
    } finally {
      refused.cleanup();
    }

    const boundary = machineOnlyRepo();
    try {
      const accepted = setRepositoryPassword({
        root: boundary.root, dshHome: boundary.home, password: PIN, hint: 'x'.repeat(120),
        platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF,
      });
      assert.equal(accepted.ok, true, accepted.detail ?? '');
      assert.equal(accepted.hint.text.length, 120, '120 characters is the accepted boundary');
    } finally {
      boundary.cleanup();
    }
  });

  it('refuses a hint without a password envelope (validateKeysFile), and malformed hint records', () => {
    const dek = randomDek();
    const openDocument = wrapOpenDek(dek);
    assert.throws(
      () => validateKeysFile({ ...openDocument, password_hint: { text: HINT } }),
      (error) => error.code === CRYPTO_CODES.ENVELOPE_MALFORMED && /only valid next to a password envelope/u.test(error.detail),
      'an unencrypted repository must not promise a PIN hint',
    );
    const machineOnlyDocument = wrapDek(
      dek,
      [{ kind: 'machine', secret: Buffer.alloc(32, 5), kdf: { algo: 'hkdf-sha256', keylen: 32 } }],
    );
    assert.throws(
      () => validateKeysFile({ ...machineOnlyDocument, password_hint: { text: HINT } }),
      /password envelope/u,
      'a machine-only repository has no PIN to hint at',
    );
    const passwordDocument = wrapDek(dek, [{ kind: 'password', secret: PIN }], { kdf: KDF });
    assert.doesNotThrow(
      () => validateKeysFile({ ...passwordDocument, password_hint: { text: HINT, updated_at: new Date().toISOString() } }),
      'the additive root field is accepted when the envelope it describes exists',
    );
    for (const bad of [{ text: 42 }, { text: 'x'.repeat(121) }, { text: '' }]) {
      assert.throws(
        () => validateKeysFile({ ...passwordDocument, password_hint: bad }),
        (error) => error.code === CRYPTO_CODES.ENVELOPE_MALFORMED,
        `password_hint.text=${JSON.stringify(bad.text)} must be refused`,
      );
    }
    assert.throws(
      () => validateKeysFile({ ...passwordDocument, password_hint: { text: HINT, updated_at: 'not-a-date' } }),
      /ISO timestamp/u,
    );
  });

  it('is a no-op on a repository that already has a PIN and never updates the hint', () => {
    const { root, home, cleanup } = machineOnlyRepo();
    try {
      const first = setRepositoryPassword({
        root, dshHome: home, password: PIN, hint: HINT,
        platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF,
      });
      assert.equal(first.added, true);
      const before = readFileSync(repoKeysPath(root), 'utf8');
      const again = setRepositoryPassword({
        root, dshHome: home, password: PIN, hint: '另一个提示',
        platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF,
      });
      assert.equal(again.ok, true, again.detail ?? '');
      assert.equal(again.added, false, 'no rotation: a second call is a no-op');
      assert.deepEqual(again.hint, { set: true, text: HINT }, 'the stored hint is returned unchanged');
      assert.match(again.detail, /not updated/u);
      assert.match(again.detail, /not offered by design/u);
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before, 'a no-op must not rewrite the document');
      assert.equal(readRepoKeys(root).keys.password_hint.text, HINT);

      const plainNoop = setRepositoryPassword({
        root, dshHome: home, password: PIN,
        platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF,
      });
      assert.equal(plainNoop.added, false);
      assert.deepEqual(plainNoop.hint, { set: true, text: HINT }, 'no hint supplied still reports what the repository carries');
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before);
    } finally {
      cleanup();
    }
  });

  it('drops the public hint together with the password envelope when protection is turned off', () => {
    const { root, home, cleanup } = machineOnlyRepo();
    try {
      const set = setRepositoryPassword({
        root, dshHome: home, password: PIN, hint: HINT,
        platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF,
      });
      assert.equal(set.added, true);
      assert.equal(readRepoKeys(root).keys.password_hint.text, HINT);
      const disabled = setEncryptionMode({ root, dshHome: home, mode: 'none', platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(disabled.ok, true, disabled.detail ?? '');
      assert.equal(disabled.changed, true);
      const document = readRepoKeys(root);
      assert.equal(document.ok, true, 'the converted document still validates without a dangling hint');
      assert.equal(document.keys.password_hint, undefined, 'a hint without its envelope would be a promise the repository cannot keep');
      assert.deepEqual(document.keys.envelopes.map((envelope) => envelope.kind), ['open']);
      const naked = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(naked.ok, true, naked.detail ?? '');
      assert.equal(naked.unlocked_via, 'none');
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
    const created = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
    assert.equal(created.ok, true, created.detail ?? '');
    assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind), ['machine']);
    return { dir, root, home, created, cleanup };
  }

  it('binds a machine-only repository, records the id, and the account credential alone opens the same DEK', () => {
    const { root, home, created, cleanup } = machineOnlyRepo();
    try {
      const bound = bindAccount({ root, dshHome: home, accountId: ACCOUNT, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
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
      const bound = bindAccount({ root, dshHome: home, accountId: ACCOUNT, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(bound.ok, true, bound.detail ?? '');
      setRepositoryPassword({ root, dshHome: home, password: 'recovery-password', platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });

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
      const first = bindAccount({ root, dshHome: home, accountId: ACCOUNT, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(first.ok, true, first.detail ?? '');
      const before = readFileSync(repoKeysPath(root), 'utf8');
      const again = bindAccount({ root, dshHome: home, accountId: ACCOUNT, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(again.ok, true);
      assert.equal(again.added, false);
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before, 'a second bind must not rewrite the document');

      const other = bindAccount({ root, dshHome: home, accountId: OTHER, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
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
      const opened = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
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

describe('keystore: the three protection states (docs/BACKUP-DESIGN.md §25)', () => {
  it('resolves the creation mode from the caller, with none as the default', () => {
    assert.deepEqual(resolveEncryptionMode({}), { ok: true, mode: 'none' }, 'no credential, no ask: unencrypted');
    assert.deepEqual(resolveEncryptionMode({ password: '1234' }), { ok: true, mode: 'sealed' }, 'a supplied PIN is honoured');
    assert.deepEqual(resolveEncryptionMode({ machineKey: true }), { ok: true, mode: 'sealed' });
    assert.deepEqual(resolveEncryptionMode({ accountId: 'user-1234abcd' }), { ok: true, mode: 'sealed' });
    assert.deepEqual(resolveEncryptionMode({ encryption: 'none', machineKey: true }), { ok: true, mode: 'none' }, 'an explicit mode wins');
    assert.deepEqual(resolveEncryptionMode({ encryption: 'sealed' }), { ok: true, mode: 'sealed' });
    const contradiction = resolveEncryptionMode({ encryption: 'none', password: '1234' });
    assert.equal(contradiction.ok, false);
    assert.equal(contradiction.reason_code, 'BACKUP_CONFIG_INVALID');
    assert.match(contradiction.detail, /cannot be combined with a password/u);
    const bogus = resolveEncryptionMode({ encryption: 'maybe' });
    assert.equal(bogus.ok, false);
    assert.equal(bogus.reason_code, 'BACKUP_CONFIG_INVALID');
  });

  it('creates a sealed repository with a 4-digit PIN and refuses credential-less opens', () => {
    const { root, home, cleanup } = fixture();
    try {
      const opened = openRepoKey({ root, dshHome: home, password: '1234', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(opened.ok, true, opened.detail ?? '');
      assert.equal(opened.encryption, 'sealed');
      assert.deepEqual(opened.available_paths, ['password']);
      assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind), ['password']);
      assert.equal(descriptorEncryption(readDescriptor(root)), 'sealed');

      const refused = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(refused.ok, false, 'a sealed repository must not open without a credential');
      assert.equal(refused.encryption, 'sealed');
      assert.equal(refused.reason_code, NO_PERMISSION);

      const reopened = openRepoKey({ root, dshHome: home, password: '1234', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(reopened.ok, true, reopened.detail ?? '');
      assert.equal(reopened.unlocked_via, 'password');
      assert.deepEqual(reopened.dek, opened.dek);
    } finally {
      cleanup();
    }
  });

  it('adding a PIN to an unencrypted repository removes the open envelope, seals it, and blocks credential-less opens', () => {
    const { dir, cleanup } = tempDir('w2m-keystore-pin-upgrade-');
    try {
      const root = `${dir}/repo`;
      ensureLayout(root);
      const home = `${dir}/home`;
      const created = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(created.ok, true, created.detail ?? '');
      assert.equal(created.encryption, 'none');
      assert.equal(keysEncryption(readRepoKeys(root).keys), 'none');

      const upgraded = setRepositoryPassword({ root, dshHome: home, password: '1234', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(upgraded.ok, true, upgraded.detail ?? '');
      assert.equal(upgraded.added, true);
      assert.equal(upgraded.weak, true);
      assert.equal(upgraded.warning, WEAK_PIN_WARNING);
      assert.equal(upgraded.mode_after, 'sealed');
      assert.deepEqual(upgraded.envelopes, ['password']);
      assert.equal(existsSync(upgraded.backup_file), true, 'the old key document is kept before the write');
      const document = readRepoKeys(root);
      assert.equal(document.ok, true);
      assert.equal(document.keys.envelopes.some((envelope) => envelope.kind === 'open'), false, 'the open envelope must be gone');
      assert.deepEqual(document.keys.envelopes.map((envelope) => envelope.kind), ['password']);
      assert.equal(descriptorEncryption(readDescriptor(root)), 'sealed');

      const refused = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(refused.ok, false, 'once protected, no-credential opens are refused');
      assert.equal(refused.reason_code, NO_PERMISSION);
      const withPin = openRepoKey({ root, dshHome: home, password: '1234', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(withPin.ok, true, withPin.detail ?? '');
      assert.equal(withPin.unlocked_via, 'password');
      assert.deepEqual(withPin.dek, created.dek, 'the DEK must not change: existing blocks stay readable');
    } finally {
      cleanup();
    }
  });

  it('turns protection off again: sealed -> open, same DEK, unlocks with no credential', () => {
    const { dir, cleanup } = tempDir('w2m-keystore-disable-');
    try {
      const root = `${dir}/repo`;
      ensureLayout(root);
      const home = `${dir}/home`;
      // A sealed machine-only repository (the old scheduled-run default), plus a PIN for good measure.
      const created = openRepoKey({ root, dshHome: home, platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(created.ok, true, created.detail ?? '');
      assert.equal(created.encryption, 'sealed');
      setRepositoryPassword({ root, dshHome: home, password: '1234', platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.deepEqual(readRepoKeys(root).keys.envelopes.map((envelope) => envelope.kind).sort(), ['machine', 'password']);

      const disabled = setEncryptionMode({ root, dshHome: home, mode: 'none', platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(disabled.ok, true, disabled.detail ?? '');
      assert.equal(disabled.changed, true);
      assert.equal(disabled.mode_before, 'sealed');
      assert.equal(disabled.mode_after, 'none');
      assert.equal(disabled.warning, UNENCRYPTED_WARNING, 'turning protection off is reported, not silent');
      assert.deepEqual(disabled.envelopes, ['open']);
      assert.equal(existsSync(disabled.backup_file), true, 'the previous key document is kept before the write');
      assert.equal(descriptorEncryption(readDescriptor(root)), 'none');
      const document = readRepoKeys(root);
      assert.equal(document.ok, true);
      assert.deepEqual(document.keys.envelopes.map((envelope) => envelope.kind), ['open']);

      const naked = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(naked.ok, true, naked.detail ?? '');
      assert.equal(naked.unlocked_via, 'none');
      assert.deepEqual(naked.dek, created.dek, 'the data key is the same: no block was rewritten');
      assert.equal(naked.attempts[0].kind, 'open');

      // Idempotent: a second disable writes nothing.
      const before = readFileSync(repoKeysPath(root), 'utf8');
      const again = setEncryptionMode({ root, dshHome: home, mode: 'none', platform: 'win32', runner: fakeRunner, machineKey: true, kdf: KDF });
      assert.equal(again.ok, true);
      assert.equal(again.changed, false);
      assert.equal(readFileSync(repoKeysPath(root), 'utf8'), before);
    } finally {
      cleanup();
    }
  });

  it('refuses to turn protection back on without a credential', () => {
    const { dir, cleanup } = tempDir('w2m-keystore-enable-');
    try {
      const root = `${dir}/repo`;
      ensureLayout(root);
      const home = `${dir}/home`;
      openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      const enabled = setEncryptionMode({ root, dshHome: home, mode: 'sealed', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(enabled.ok, false);
      assert.equal(enabled.reason_code, NO_PERMISSION);
      assert.match(enabled.detail, /setRepositoryPassword/u, 'the refusal names the command that can ask for a PIN');
    } finally {
      cleanup();
    }
  });

  it('refuses an open envelope mixed with any credential envelope (it would bypass the credential)', () => {
    const dek = randomDek();
    const open = wrapOpenDek(dek);
    validateKeysFile(open);
    const credentialEnvelopes = wrapDek(
      dek,
      [
        { kind: 'account', secret: 'account-id-material', kdf: { algo: 'hkdf-sha256', keylen: 32 } },
        { kind: 'machine', secret: Buffer.alloc(32, 7), kdf: { algo: 'hkdf-sha256', keylen: 32 } },
        { kind: 'password', secret: '1234' },
      ],
      { kdf: KDF },
    ).envelopes;
    for (const envelope of credentialEnvelopes) {
      const mixed = { ...open, envelopes: [...open.envelopes, envelope] };
      assert.throws(
        () => validateKeysFile(mixed),
        (error) => error.code === CRYPTO_CODES.ENVELOPE_MALFORMED && /cannot be combined/u.test(error.detail),
        `open + ${envelope.kind} must be refused`,
      );
    }
    // A malformed open record is refused by name, and wrapDek never wraps the "open" kind.
    assert.throws(() => validateKeysFile({ ...open, envelopes: [{ ...open.envelopes[0], dek: Buffer.alloc(3).toString('base64') }] }), /wrong length/u);
    assert.throws(() => wrapDek(dek, [{ kind: 'open', secret: 'x' }]), /open envelope/u);
    const machineOnly = { format: ENVELOPE_FORMAT, version: 1, envelopes: [{ kind: 'machine' }] };
    const mixedAdd = addOpenEnvelope(machineOnly, dek);
    assert.equal(mixedAdd.added, false, 'adding open beside a credential envelope is refused, not silently preferred');
    assert.match(mixedAdd.reason, /cannot be mixed/u);
  });

  it('never lets the DEK leak through a describe, status or conversion result', () => {
    const { dir, cleanup } = tempDir('w2m-keystore-leak-');
    try {
      const root = `${dir}/repo`;
      ensureLayout(root);
      const home = `${dir}/home`;
      const opened = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(opened.ok, true, opened.detail ?? '');
      const dekBase64 = readRepoKeys(root).keys.envelopes[0].dek;
      assert.equal(dekBase64.length > 0, true);

      const described = describeUnlock({ root, dshHome: home, platform: 'linux', machineKey: false });
      assert.equal(JSON.stringify(described).includes(dekBase64), false, 'describeUnlock must never return the data key');
      assert.equal(JSON.stringify(described).includes(opened.dek.toString('hex')), false);

      const status = buildStatus({ backupDir: root, dshHome: home, env: {} });
      assert.equal(JSON.stringify(status).includes(dekBase64), false, 'the status route must never return the data key');
      assert.equal(status.encryption, 'none');
      assert.deepEqual(status.available_paths, ['none']);
      assert.equal(status.warning, UNENCRYPTED_WARNING);

      const sealed = setRepositoryPassword({ root, dshHome: home, password: '1234', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(JSON.stringify(sealed).includes(dekBase64), false);
      const reOpened = setEncryptionMode({ root, dshHome: home, mode: 'none', password: '1234', platform: 'linux', machineKey: false, kdf: KDF });
      assert.equal(reOpened.ok, true, reOpened.detail ?? '');
      assert.equal(JSON.stringify(reOpened).includes(dekBase64), false, 'the conversion result must not echo the key either');
    } finally {
      cleanup();
    }
  });
});
