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
 * ## The three paths, and what they really are
 *
 * The original plan said "账户 / 密码双解锁". The account-material spike measured that the host exposes an
 * account *identifier*, not a secret (`docs/SPIKE-ACCOUNT-KEK.md`). On 2026-11-17 the user decided to use it
 * exactly that way: **read the unique account id, compare it with the id the repository was bound to, and allow
 * the account path when they match; otherwise fall back to the password path** (`docs/BACKUP-DESIGN.md` §25).
 * So the real paths are:
 *
 *   * **machine** -- the random secret protected by the OS keystore (same machine, no prompt);
 *   * **account** -- an **identity binding**, not a secret: a KEK derived from the account id. Anyone who knows
 *     the id and has the files could derive it, which is the trade-off the user accepted for "same account
 *     works without a password"; it is masked in all output (`id_hint`: last four characters only);
 *   * **password** -- scrypt; the only path that survives a new machine *and* a new account.
 *
 * `describeUnlock` reports which of the three a repository has -- and, when the host supplies its current account
 * id, whether it matches the bound one -- so the UI can say "this is the original account" or "this is not the
 * original account: use the unlock password" for the right reason.
 */

import { ENVELOPE_KINDS } from './crypto.mjs';
import { accountBindingState, boundAccountId, openRepoKey, readRepoKeys } from './keystore.mjs';
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

/**
 * Describe, without touching a secret, how this repository can be opened.
 *
 * The account half is a **comparison, not an attempt**: `account.bound` says the repository names an account,
 * `account.matched` is `true/false` when the caller supplied the host's current id, and `id_hint` is the masked
 * original id. No full account id ever leaves this function.
 *
 * @param {{root: string, dshHome: string, platform?: string, runner?: Function, machineKey?: boolean,
 *   accountId?: string|null}} input
 * @returns {{
 *   ok: boolean, initialized: boolean, file: string,
 *   envelopes: string[], machine_available: boolean, machine_reason: string|null,
 *   password_required: boolean, account_supported: boolean,
 *   account: {bound: boolean, matched: boolean|null, id_hint: string|null},
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
      account: { ...NO_ACCOUNT },
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
    account_supported: boundAccountId(keys.keys) !== null,
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
 *   reason_code: string|null, detail: string|null,
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
    account: opened.account ?? { ...NO_ACCOUNT },
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
