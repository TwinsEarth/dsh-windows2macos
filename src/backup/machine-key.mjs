/**
 * The machine credential: a random 32-byte secret protected by the OS keystore, so a restore on the same
 * machine needs no password.
 *
 * ## Why a random secret rather than "the machine's identity"
 *
 * A device id, a hostname, or a hardware fingerprint is **not a secret**: it is readable by anything running
 * as the user, reproducible from a settings page, and often guessable. Binding a backup's key envelope to it
 * would be decoration. What this module stores instead is 32 fresh random bytes, and the only thing protecting
 * them is the OS keystore (DPAPI on Windows) -- so "same machine" means "the keystore can unprotect the blob",
 * which is exactly the property the envelope needs.
 *
 * ## Platform reality, stated rather than hidden
 *
 *   * **Windows** -- DPAPI `CurrentUser` through PowerShell: measured 32 bytes in, ~262 bytes out, round-trip
 *     verified across independent processes (`docs/SPIKE-ACCOUNT-KEK.md`).
 *   * **macOS** -- unavailable here (`keychain-not-implemented`). The backup still works, but every unlock is a
 *     password.
 *   * **Linux** -- unavailable unless a secret service is wired; not claimed.
 *
 * Unavailable is a *state*, not a crash: `loadMachineSecret` returns `{ok:false, reason}` and the keystore falls
 * back to the password envelope. A backup that quietly wrote a machine envelope nobody could open would be the
 * worst outcome, so availability is decided by an actual protect/unprotect probe.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEK_LENGTH } from './crypto.mjs';

/** Format of the on-disk machine-key file. */
export const MACHINE_KEY_FORMAT = 'w2m-backup-machine-key/1';

/** Where the protected secret lives, relative to `$DSH_HOME`. */
export const MACHINE_KEY_REL = ['xclient', 'backup', 'machine.key'];

/** Named failure reasons (a caller maps these to a refusal, never to a throw). */
export const MACHINE_KEY_REASONS = Object.freeze({
  UNAVAILABLE: 'machine-keystore-unavailable',
  PROTECT_FAILED: 'machine-key-protect-failed',
  UNPROTECT_FAILED: 'machine-key-unprotect-failed',
  CORRUPT: 'machine-key-corrupt',
});

/** DPAPI protect: base64 in on stdin, base64 out on stdout. Standard API, no secret in argv. */
const PS_PROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b64=[Console]::In.ReadToEnd()',
  '$raw=[Convert]::FromBase64String($b64.Trim())',
  '$enc=[System.Security.Cryptography.ProtectedData]::Protect($raw,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($enc))',
].join('; ');

/** DPAPI unprotect, same transport. */
const PS_UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b64=[Console]::In.ReadToEnd()',
  '$enc=[Convert]::FromBase64String($b64.Trim())',
  '$raw=[System.Security.Cryptography.ProtectedData]::Unprotect($enc,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($raw))',
].join('; ');

/** Default runner: synchronous, secret on stdin, never in argv. */
export function defaultRunner(command, args, input = '') {
  const result = spawnSync(command, args, { input, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error ? String(result.error?.message ?? result.error) : '',
  };
}

/** Resolve the machine-key file under a DSH home. */
export function machineKeyPath(dshHome) {
  return path.join(dshHome, ...MACHINE_KEY_REL);
}

/**
 * Probe whether this platform can protect a secret with the OS keystore.
 *
 * The probe is a real protect/unprotect round trip, not a platform check: PowerShell can be present while the
 * assembly or the profile is unusable, and a backup that assumes otherwise would write a dead envelope.
 *
 * @param {{platform?: string, runner?: typeof defaultRunner}} [options]
 * @returns {{available: boolean, backend: string, reason: string|null}}
 */
export function detectMachineKeySupport(options = {}) {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  if (platform !== 'win32') {
    return {
      available: false,
      backend: 'unavailable',
      reason: platform === 'darwin' ? 'keychain-not-implemented' : 'platform-unsupported',
    };
  }
  const probe = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security; "ok"']);
  if (!probe.ok) return { available: false, backend: 'unavailable', reason: 'dpapi-probe-failed' };
  const sample = Buffer.alloc(DEK_LENGTH, 7);
  const protectedProbe = protectSecret(sample, { platform, runner });
  if (protectedProbe.ok !== true) return { available: false, backend: 'unavailable', reason: MACHINE_KEY_REASONS.PROTECT_FAILED };
  const back = unprotectSecret(protectedProbe.payload, { platform, runner });
  if (back.ok !== true || !back.secret.equals(sample)) {
    return { available: false, backend: 'unavailable', reason: MACHINE_KEY_REASONS.UNPROTECT_FAILED };
  }
  return { available: true, backend: 'dpapi-user', reason: null };
}

/**
 * Protect a secret with the OS keystore.
 *
 * @param {Buffer} secret
 * @param {{platform?: string, runner?: typeof defaultRunner}} [options]
 * @returns {{ok: boolean, payload: string|null, reason: string|null, detail: string|null}}
 */
export function protectSecret(secret, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { ok: false, payload: null, reason: MACHINE_KEY_REASONS.UNAVAILABLE, detail: platform };
  if (!Buffer.isBuffer(secret) || secret.length === 0) {
    return { ok: false, payload: null, reason: MACHINE_KEY_REASONS.PROTECT_FAILED, detail: 'secret must be a non-empty buffer' };
  }
  const runner = options.runner ?? defaultRunner;
  const out = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PROTECT], secret.toString('base64'));
  if (out.ok !== true || out.stdout === '') {
    return { ok: false, payload: null, reason: MACHINE_KEY_REASONS.PROTECT_FAILED, detail: out.stderr || out.error };
  }
  return { ok: true, payload: out.stdout, reason: null, detail: null };
}

/**
 * Unprotect a secret stored by {@link protectSecret}.
 *
 * @param {string} payload base64 from the keystore
 * @param {{platform?: string, runner?: typeof defaultRunner}} [options]
 * @returns {{ok: boolean, secret: Buffer|null, reason: string|null, detail: string|null}}
 */
export function unprotectSecret(payload, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { ok: false, secret: null, reason: MACHINE_KEY_REASONS.UNAVAILABLE, detail: platform };
  if (typeof payload !== 'string' || payload.trim() === '') {
    return { ok: false, secret: null, reason: MACHINE_KEY_REASONS.CORRUPT, detail: 'empty payload' };
  }
  const runner = options.runner ?? defaultRunner;
  const out = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UNPROTECT], payload);
  if (out.ok !== true || out.stdout === '') {
    return { ok: false, secret: null, reason: MACHINE_KEY_REASONS.UNPROTECT_FAILED, detail: out.stderr || out.error };
  }
  let secret;
  try {
    secret = Buffer.from(out.stdout, 'base64');
  } catch {
    return { ok: false, secret: null, reason: MACHINE_KEY_REASONS.CORRUPT, detail: 'stdout is not base64' };
  }
  if (secret.length !== DEK_LENGTH) {
    return { ok: false, secret: null, reason: MACHINE_KEY_REASONS.CORRUPT, detail: `expected ${DEK_LENGTH} bytes, got ${secret.length}` };
  }
  return { ok: true, secret, reason: null, detail: null };
}

/**
 * Load the machine secret, creating and protecting one on first use.
 *
 * Never throws. A refused write (read-only home, missing `xclient`) is reported as `ok:false`, and the keystore
 * then simply has one envelope (the password).
 *
 * @param {{dshHome: string, platform?: string, runner?: typeof defaultRunner, now?: Date}} options
 * @returns {{ok: boolean, secret: Buffer|null, path: string, created: boolean, backend: string, reason: string|null, detail: string|null}}
 */
export function loadMachineSecret(options) {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  const file = machineKeyPath(options.dshHome);
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, secret: null, path: file, created: false, backend: 'unavailable', reason: MACHINE_KEY_REASONS.UNAVAILABLE, detail: error?.code ?? 'unreadable' };
    }
  }
  if (text !== null) {
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      return { ok: false, secret: null, path: file, created: false, backend: 'unavailable', reason: MACHINE_KEY_REASONS.CORRUPT, detail: 'machine.key is not JSON' };
    }
    if (document?.format !== MACHINE_KEY_FORMAT || typeof document?.protected !== 'string') {
      return { ok: false, secret: null, path: file, created: false, backend: 'unavailable', reason: MACHINE_KEY_REASONS.CORRUPT, detail: 'machine.key has the wrong shape' };
    }
    const opened = unprotectSecret(document.protected, { platform, runner });
    return {
      ok: opened.ok,
      secret: opened.secret,
      path: file,
      created: false,
      backend: opened.ok ? String(document.backend ?? 'dpapi-user') : 'unavailable',
      reason: opened.reason,
      detail: opened.detail,
    };
  }

  const support = detectMachineKeySupport({ platform, runner });
  if (support.available !== true) {
    return { ok: false, secret: null, path: file, created: false, backend: support.backend, reason: support.reason, detail: null };
  }
  // A CSPRNG, not Math.random: this is the secret that unlocks the machine envelope.
  const secret = randomBytes(DEK_LENGTH);
  const protectedSecret = protectSecret(secret, { platform, runner });
  if (protectedSecret.ok !== true) {
    return { ok: false, secret: null, path: file, created: false, backend: support.backend, reason: protectedSecret.reason, detail: protectedSecret.detail };
  }
  const document = {
    format: MACHINE_KEY_FORMAT,
    backend: support.backend,
    created_at: (options.now ?? new Date()).toISOString(),
    protected: protectedSecret.payload,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    return {
      ok: false,
      secret: null,
      path: file,
      created: false,
      backend: support.backend,
      reason: MACHINE_KEY_REASONS.UNAVAILABLE,
      detail: `could not write machine.key: ${error?.code ?? 'unknown'}`,
    };
  }
  return { ok: true, secret, path: file, created: true, backend: support.backend, reason: null, detail: null };
}
