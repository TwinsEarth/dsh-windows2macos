/**
 * The machine credential: a random secret protected by the OS keystore.
 *
 * Two layers are tested separately:
 *
 *   * the DPAPI transport, with a **real** PowerShell round trip on Windows (skipped elsewhere) -- this is the
 *     only place the measurement in `docs/SPIKE-ACCOUNT-KEK.md` is re-checked on the running machine;
 *   * the file lifecycle (create, reuse, corrupt, unavailable), with an injected runner so it is deterministic and
 *     fast, and so a CI machine without PowerShell still exercises every branch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  MACHINE_KEY_FORMAT,
  MACHINE_KEY_REASONS,
  detectMachineKeySupport,
  loadMachineSecret,
  machineKeyPath,
  protectSecret,
  unprotectSecret,
} from '../src/backup/machine-key.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

const WIN32 = process.platform === 'win32';

/**
 * A deterministic stand-in for PowerShell DPAPI: "protect" echoes the base64 input, "unprotect" decodes it.
 *
 * That is exactly the round trip the real transport performs, so the envelope and keystore logic is exercised
 * end-to-end on every platform; only the security of the protection is faked (and tested separately below).
 */
function fakeRunner(command, args, input = '') {
  const text = args.join(' ');
  if (text.includes('ProtectedData]::Protect') || text.includes('ProtectedData]::Unprotect')) {
    return { ok: true, status: 0, stdout: input, stderr: '', error: '' };
  }
  return { ok: true, status: 0, stdout: 'ok', stderr: '', error: '' };
}

describe('machine-key: DPAPI transport on this machine', { skip: WIN32 ? false : 'DPAPI is Windows-only' }, () => {
  it('protects and unprotects 32 bytes through a real PowerShell round trip', () => {
    const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
    const protectedSecret = protectSecret(secret);
    assert.equal(protectedSecret.ok, true, protectedSecret.detail ?? '');
    assert.ok(protectedSecret.payload.length > 40, 'DPAPI output must be a base64 blob');
    const back = unprotectSecret(protectedSecret.payload);
    assert.equal(back.ok, true, back.detail ?? '');
    assert.deepEqual(back.secret, secret);
  });

  it('reports this machine as able to keep a machine envelope', () => {
    const support = detectMachineKeySupport();
    assert.equal(support.available, true, support.reason ?? '');
    assert.equal(support.backend, 'dpapi-user');
  });
});

describe('machine-key: file lifecycle (injected runner)', () => {
  it('creates machine.key on first use and reuses it on the next call', () => {
    const { dir, cleanup } = tempDir('w2m-machine-key-');
    try {
      assert.equal(existsSync(machineKeyPath(dir)), false);
      const first = loadMachineSecret({ dshHome: dir, platform: 'win32', runner: fakeRunner });
      assert.equal(first.ok, true, first.reason ?? '');
      assert.equal(first.created, true);
      assert.equal(first.secret.length, 32);
      assert.equal(existsSync(machineKeyPath(dir)), true);

      const document = JSON.parse(readFileSync(machineKeyPath(dir), 'utf8'));
      assert.equal(document.format, MACHINE_KEY_FORMAT);
      assert.equal(document.backend, 'dpapi-user');
      assert.equal(typeof document.protected, 'string');

      const second = loadMachineSecret({ dshHome: dir, platform: 'win32', runner: fakeRunner });
      assert.equal(second.ok, true);
      assert.equal(second.created, false);
      assert.deepEqual(second.secret, first.secret, 'the machine secret must be stable across processes');
    } finally {
      cleanup();
    }
  });

  it('reports a corrupt machine.key instead of minting a new secret (which would orphan the envelope)', () => {
    const { dir, cleanup } = tempDir('w2m-machine-key-corrupt-');
    try {
      mkdirSync(dirname(machineKeyPath(dir)), { recursive: true });
      writeFileSync(machineKeyPath(dir), 'not json');
      const result = loadMachineSecret({ dshHome: dir, platform: 'win32', runner: fakeRunner });
      assert.equal(result.ok, false);
      assert.equal(result.reason, MACHINE_KEY_REASONS.CORRUPT);
      assert.equal(readFileSync(machineKeyPath(dir), 'utf8'), 'not json', 'the file must not be replaced');
    } finally {
      cleanup();
    }
  });

  it('is unavailable on platforms without an OS keystore, without throwing', () => {
    const { dir, cleanup } = tempDir('w2m-machine-key-mac-');
    try {
      for (const platform of ['darwin', 'linux']) {
        const result = loadMachineSecret({ dshHome: dir, platform, runner: fakeRunner });
        assert.equal(result.ok, false);
        assert.equal(result.backend, 'unavailable');
        assert.ok(['keychain-not-implemented', 'platform-unsupported'].includes(result.reason), result.reason);
      }
      assert.equal(existsSync(machineKeyPath(dir)), false, 'an unavailable platform must not create a key file');
    } finally {
      cleanup();
    }
  });

  it('treats a too-short unprotect result as corruption rather than a secret', () => {
    const back = unprotectSecret(Buffer.from('short').toString('base64'), {
      platform: 'win32',
      runner: () => ({ ok: true, status: 0, stdout: Buffer.from('short').toString('base64'), stderr: '', error: '' }),
    });
    assert.equal(back.ok, false);
    assert.equal(back.reason, MACHINE_KEY_REASONS.CORRUPT);
  });

  it('refuses to protect an empty secret', () => {
    const result = protectSecret(Buffer.alloc(0), { platform: 'win32', runner: fakeRunner });
    assert.equal(result.ok, false);
    assert.equal(result.reason, MACHINE_KEY_REASONS.PROTECT_FAILED);
  });
});
