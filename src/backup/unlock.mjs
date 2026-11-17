/**
 * Unlock: the read-only "which credential opens this repository" probe, and the secret-free unlock result.
 *
 * ## Why this is a separate module from `keystore`
 *
 * `keystore.openRepoKey` opens or creates a key while holding the repository lock, because a run is about to write.
 * The panel's unlock dialog needs the *question* without the write: which envelopes exist, is the OS keystore
 * available, does this password open it. So this module offers:
 *
 *   * `describeUnlock` -- read-only, no secret touched, safe on a status path;
 *   * `unlockRepo` -- one attempt with the credentials supplied, returning only `{ok, via}` (never the DEK).
 *
 * ## The two paths, and what they really are
 *
 * The plan said "账户 / 密码双解锁"; the account-material spike measured that the host exposes an account
 * *identifier*, not a secret, so an `account` envelope would be encryption theatre and is not written. The two
 * real paths are:
 *
 *   * **machine** -- the random secret protected by the OS keystore (same machine, no prompt);
 *   * **password** -- scrypt; the only path that survives a new machine.
 *
 * `describeUnlock` reports which of the two a repository has, so the UI can say "no permission: sign in on the
 * machine that created it, or enter the unlock password" for the right reason.
 */

import { ENVELOPE_KINDS } from './crypto.mjs';
import { detectMachineKeySupport, loadMachineSecret } from './machine-key.mjs';
import { readRepoKeys } from './keystore.mjs';
import { openRepoKey } from './keystore.mjs';

/** Named unlock refusal. */
export const UNLOCK_CODES = Object.freeze({
  NO_PERMISSION: 'BACKUP_NO_PERMISSION',
  NOT_INITIALIZED: 'BACKUP_REPO_NOT_INITIALIZED',
  UNREADABLE: 'BACKUP_KEY_UNWRAP_FAILED',
});

/**
 * Describe, without touching a secret, how this repository can be opened.
 *
 * @param {{root: string, dshHome: string, platform?: string, runner?: Function, machineKey?: boolean}} input
 * @returns {{
 *   ok: boolean, initialized: boolean, file: string,
 *   envelopes: string[], machine_available: boolean, machine_reason: string|null,
 *   password_required: boolean, account_supported: boolean,
 *   reason_code: string|null, detail: string|null
 * }}
 */
export function describeUnlock(input) {
  const keys = readRepoKeys(input.root);
  if (keys.ok !== true) {
    return {
      ok: false,
      initialized: keys.reason !== 'missing',
      file: keys.file,
      envelopes: [],
      machine_available: false,
      machine_reason: null,
      password_required: false,
      account_supported: false,
      reason_code: keys.reason === 'missing' ? UNLOCK_CODES.NOT_INITIALIZED : UNLOCK_CODES.UNREADABLE,
      detail: keys.reason === 'missing' ? 'this repository has no key document yet; the first backup creates it' : keys.detail,
    };
  }
  const envelopes = keys.keys.envelopes.map((envelope) => String(envelope.kind)).filter((kind) => ENVELOPE_KINDS.includes(kind));
  const support = typeof input.platform === 'string' || input.machineKey !== false
    ? detectMachineKeySupport({ platform: input.platform, runner: input.runner })
    : { available: false, reason: 'disabled-by-configuration' };
  return {
    ok: true,
    initialized: true,
    file: keys.file,
    envelopes,
    machine_available: support.available === true,
    machine_reason: support.reason ?? null,
    password_required: envelopes.includes('password'),
    account_supported: false,
    reason_code: null,
    detail: null,
  };
}

/**
 * Try to unlock the repository once.
 *
 * Returns `{ok, via, reason_code, detail}` and **never the DEK**: the panel only needs "it worked". Code inside the
 * package that needs the key calls `openRepoKey` directly, under the repository lock.
 *
 * @param {{root: string, dshHome: string, password?: string|Buffer|null, machineKey?: boolean,
 *   platform?: string, runner?: Function}} input
 * @returns {{ok: boolean, via: string|null, reason_code: string|null, detail: string|null,
 *   attempts: Array<object>, machine_available: boolean, machine_envelope_added: boolean}}
 */
export function unlockRepo(input) {
  // A machine secret is load/created here for the probe; the keystore does the same, and cache-free is fine.
  const opened = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    password: input.password ?? null,
    machineKey: input.machineKey,
    platform: input.platform,
    runner: input.runner,
  });
  return {
    ok: opened.ok === true,
    via: opened.unlocked_via,
    reason_code: opened.reason_code,
    detail: opened.detail,
    attempts: opened.attempts,
    machine_available: opened.machine?.ok === true,
    machine_envelope_added: opened.machine_envelope_added === true,
  };
}

/** Whether the machine secret itself can be loaded (for "unlock without a password on this machine"). */
export function machineSecretAvailable(input) {
  const result = loadMachineSecret({ dshHome: input.dshHome, platform: input.platform, runner: input.runner });
  return { available: result.ok === true, created: result.created === true, reason: result.reason ?? null };
}
