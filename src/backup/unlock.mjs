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
 * ## The four paths, and what they really are
 *
 * The original plan said "账户 / 密码双解锁". The account-material spike measured that the host exposes an
 * account *identifier*, not a secret (`docs/SPIKE-ACCOUNT-KEK.md`). On 2026-11-17 the user decided to use it
 * exactly that way: **read the unique account id, compare it with the id the repository was bound to, and allow
 * the account path when they match; otherwise fall back to the password path** (`docs/BACKUP-DESIGN.md` §25).
 * The product's goal is not absolute confidentiality (the same decision), so the real paths are:
 *
 *   * **none** -- the repository is unencrypted (default): the DEK is in clear in `keys.json`, no credential is
 *     needed. `describeUnlock` reports a warning because anyone who can read the directory can restore it;
 *   * **machine** -- the random secret protected by the OS keystore (same machine, no prompt);
 *   * **account** -- an **identity binding**, not a secret: a KEK derived from the account id. Anyone who knows
 *     the id and has the files could derive it, which is the trade-off accepted for "same account works
 *     without a password"; it is masked in all output (`id_hint`: last four characters only);
 *   * **password** -- scrypt; the path that survives a new machine *and* a new account. Expected use is a 4-6
 *     digit PIN: a convenience threshold, not confidentiality.
 *
 * `describeUnlock` reports the mode (`encryption`), which paths exist (`available_paths`) and, when the host
 * supplies its current account id, whether it matches the bound one -- so the UI can say "this is the original
 * account" or "this is not the original account: use the unlock password" for the right reason.
 */

import { ENVELOPE_KINDS } from './crypto.mjs';
import {
  UNENCRYPTED_WARNING,
  accountBindingState,
  availablePaths,
  boundAccountId,
  keysEncryption,
  openRepoKey,
  passwordHintState,
  readRepoKeys,
} from './keystore.mjs';
import { descriptorEncryption, readDescriptor } from './layout.mjs';
import { detectMachineKeySupport, loadMachineSecret } from './machine-key.mjs';

/** Named unlock refusal. */
export const UNLOCK_CODES = Object.freeze({
  NO_PERMISSION: 'BACKUP_NO_PERMISSION',
  NOT_INITIALIZED: 'BACKUP_REPO_NOT_INITIALIZED',
  UNREADABLE: 'BACKUP_KEY_UNWRAP_FAILED',
  /** The host's account id differs from the id this repository is bound to (fall back to the password). */
  ACCOUNT_MISMATCH: 'BACKUP_ACCOUNT_MISMATCH',
});

/** The `account` field for a repository that cannot be read at all. */
const NO_ACCOUNT = Object.freeze({ bound: false, matched: null, id_hint: null });

/** The `password_hint` field for a repository that cannot be read at all. */
const NO_PASSWORD_HINT = Object.freeze({ set: false, text: null });

/**
 * Describe, without touching a secret, how this repository can be opened.
 *
 * The account half is a **comparison, not an attempt**: `account.bound` says the repository names an account,
 * `account.matched` is `true/false` when the caller supplied the host's current id, and `id_hint` is the masked
 * original id. No full account id ever leaves this function.
 *
 * The `password_hint` half is the **public** "备注提示词" that may accompany a PIN (`{set, text}`); it is stored
 * in clear in the repository's `keys.json` by design, so it is shown verbatim to anyone asking how to unlock --
 * it never contains the PIN itself (the writer refuses a hint equal to the PIN).
 *
 * @param {{root: string, dshHome: string, platform?: string, runner?: Function, machineKey?: boolean,
 *   accountId?: string|null}} input
 * @returns {{
 *   ok: boolean, initialized: boolean, file: string,
 *   envelopes: string[], machine_available: boolean, machine_reason: string|null,
 *   password_required: boolean, password_hint: {set: boolean, text: string|null},
 *   account_supported: boolean,
 *   encryption: 'none'|'sealed'|null, available_paths: string[], warning: string|null,
 *   account: {bound: boolean, matched: boolean|null, id_hint: string|null},
 *   reason_code: string|null, detail: string|null
 * }}
 */
export function describeUnlock(input) {
  const keys = readRepoKeys(input.root);
  if (keys.ok !== true) {
    // A descriptor without keys means a half-initialised repository: report the mode it was created with (when
    // it says so) instead of guessing, and never read a credential.
    let encryption = null;
    try {
      const descriptor = readDescriptor(input.root);
      encryption = descriptor === null ? null : descriptorEncryption(descriptor);
    } catch {
      encryption = null;
    }
    return {
      ok: false,
      initialized: keys.reason !== 'missing',
      file: keys.file,
      envelopes: [],
      machine_available: false,
      machine_reason: null,
      password_required: false,
      password_hint: { ...NO_PASSWORD_HINT },
      account_supported: false,
      encryption,
      available_paths: [],
      warning: encryption === 'none' ? UNENCRYPTED_WARNING : null,
      account: { ...NO_ACCOUNT },
      reason_code: keys.reason === 'missing' ? UNLOCK_CODES.NOT_INITIALIZED : UNLOCK_CODES.UNREADABLE,
      detail: keys.reason === 'missing' ? 'this repository has no key document yet; the first backup creates it' : keys.detail,
    };
  }
  const encryption = keysEncryption(keys.keys);
  const envelopes = keys.keys.envelopes
    .map((envelope) => String(envelope.kind))
    .filter((kind) => ENVELOPE_KINDS.includes(kind));
  // An unencrypted repository needs no OS-keystore probe: there is no credential path to report.
  const support = encryption === 'none'
    ? { available: false, reason: 'repository-is-unencrypted' }
    : (typeof input.platform === 'string' || input.machineKey !== false
        ? detectMachineKeySupport({ platform: input.platform, runner: input.runner })
        : { available: false, reason: 'disabled-by-configuration' });
  return {
    ok: true,
    initialized: true,
    file: keys.file,
    envelopes,
    machine_available: support.available === true,
    machine_reason: support.reason ?? null,
    password_required: envelopes.includes('password'),
    password_hint: passwordHintState(keys.keys),
    account_supported: boundAccountId(keys.keys) !== null,
    encryption,
    available_paths: availablePaths(keys.keys),
    warning: encryption === 'none' ? UNENCRYPTED_WARNING : null,
    account: accountBindingState(keys.keys, input.accountId ?? null),
    reason_code: null,
    detail: null,
  };
}

/**
 * Try to unlock the repository once.
 *
 * Returns `{ok, via, account, reason_code, detail}` and **never the DEK**: the panel only needs "it worked". Code
 * inside the package that needs the key calls `openRepoKey` directly, under the repository lock. A supplied
 * account id that differs from the bound one is recorded in `attempts` as `BACKUP_ACCOUNT_MISMATCH` and the
 * attempt continues on the password path -- never as a hard refusal on its own.
 *
 * @param {{root: string, dshHome: string, password?: string|Buffer|null, machineKey?: boolean,
 *   platform?: string, runner?: Function, accountId?: string|null}} input
 * @returns {{ok: boolean, via: string|null, account: {bound: boolean, matched: boolean|null, id_hint: string|null},
 *   password_hint: {set: boolean, text: string|null},
 *   encryption: 'none'|'sealed'|null, reason_code: string|null, detail: string|null,
 *   attempts: Array<object>, machine_available: boolean, machine_envelope_added: boolean}}
 */
export function unlockRepo(input) {
  // A machine secret is load/created here for the probe; the keystore does the same, and cache-free is fine.
  const opened = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    accountId: input.accountId ?? null,
    password: input.password ?? null,
    machineKey: input.machineKey,
    platform: input.platform,
    runner: input.runner,
  });
  return {
    ok: opened.ok === true,
    via: opened.unlocked_via,
    encryption: opened.encryption ?? null,
    account: opened.account ?? { ...NO_ACCOUNT },
    // The public hint is shown even when the attempt failed: it is the thing the operator needs to type the PIN.
    password_hint: passwordHintState(opened.keys),
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
