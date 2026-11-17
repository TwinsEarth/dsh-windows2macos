/**
 * The repository key: one random DEK per repository, wrapped under the credentials this machine has.
 *
 * ## Why the key is per repository and not per snapshot
 *
 * Blocks are content-addressed and **deduplicated across snapshots**: a session that grew by 10 % reuses every
 * unchanged 4 MiB block from the previous snapshot. That only works if the previous blocks can be decrypted by
 * the new snapshot's reader -- which requires one key for the repository, not a fresh key per snapshot. (A
 * per-snapshot key would make yesterday's blocks permanently tied to yesterday's envelope, and the second backup
 * would have to rewrite the whole session: the exact cost the design is trying to avoid.)
 *
 * The v3.4.6 protocol already places a `keys.json` inside every snapshot. That stays -- each snapshot keeps a
 * **copy** of the repository's wrapped envelope, so a snapshot directory plus `objects/` is independently
 * restorable -- and the authoritative copy lives at `<root>/keys.json`.
 *
 * ## Who can open it
 *
 *   * `machine` -- the random secret protected by DPAPI (Windows); same machine, no password;
 *   * `account` -- an **identity binding**, not a secret: the KEK is HKDF over `w2m-account-binding|<accountId>`.
 *     The user decided (2026-11-17, `docs/BACKUP-DESIGN.md` §25) that the account id read from the host is
 *     compared with the bound id and, when it matches, the account path opens without a password. **The honest
 *     consequence: anyone who knows the account id and has the repository files can derive the same KEK.** That
 *     is accepted for this convenience path; it is not confidentiality against such a person, and it never
 *     replaces the password envelope;
 *   * `password` -- scrypt; the only path that survives a new machine *and* a different account.
 *
 * The bound account id is recorded next to the envelope (`keys.json` root field `account_binding`), because an
 * unlock must be able to answer "is this the original account?" before it tries a KEK; the envelope alone cannot
 * distinguish "wrong id" from "tampered file" (GCM reports one authentication failure for both). The account id
 * is masked (last four characters only) in every output, log line and UI string.
 *
 * ## Refusing to write an unopenable backup
 *
 * If neither a machine envelope nor a password envelope can be created, the run is refused before a single block
 * is written (`BACKUP_NO_PERMISSION`). Writing a repository nobody can open is worse than not writing one. The
 * account binding is added **after** a successful run, never as the only reason a repository exists.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CRYPTO_CODES,
  DEFAULT_SCRYPT,
  MIN_SCRYPT,
  randomDek,
  unwrapDek,
  validateKeysFile,
  wrapDek,
} from './crypto.mjs';
import { writeFileAtomic, writeJsonAtomic } from './atomic.mjs';
import { loadMachineSecret, machineKeyPath } from './machine-key.mjs';

/** File name of the authoritative wrapped-key document, at the repository root. */
export const REPO_KEYS_FILE = 'keys.json';

/** Named keystore refusal code. Matches `docs/BACKUP-DESIGN.md` §11 (`BACKUP_NO_PERMISSION`). */
export const NO_PERMISSION = 'BACKUP_NO_PERMISSION';

/** Other named refusals. */
export const KEYSTORE_CODES = Object.freeze({
  NO_PERMISSION,
  UNREADABLE: 'BACKUP_KEY_UNWRAP_FAILED',
  CORRUPT: 'BACKUP_ENVELOPE_MALFORMED',
  /** The host account id and the id the repository is bound to are different ids. */
  ACCOUNT_MISMATCH: 'BACKUP_ACCOUNT_MISMATCH',
  /** No usable account identifier was supplied. */
  ACCOUNT_INVALID: 'BACKUP_ACCOUNT_ID_INVALID',
  /** An `account` envelope exists but carries no `account_binding` metadata, so it cannot be compared. */
  ACCOUNT_BINDING_UNKNOWN: 'BACKUP_ACCOUNT_BINDING_UNKNOWN',
});

/** Domain separation of the account binding: the KEK is derived from `w2m-account-binding|<accountId>`. */
export const ACCOUNT_BINDING_DOMAIN = 'w2m-account-binding';

/** Root metadata field of `keys.json` that records the bound account id and when it was bound. */
export const ACCOUNT_BINDING_FIELD = 'account_binding';

/** The longest account id this build will store (a hostile file must not make an unlock allocate unboundedly). */
export const MAX_ACCOUNT_ID_LENGTH = 1024;

/**
 * Normalise an account identifier for binding and comparison.
 *
 * Trims outer whitespace (the host's `userId` is used verbatim elsewhere, and a stray newline must not turn
 * "same account" into "different account"), and refuses empty/oversized values. Returns `null` when unusable.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeAccountId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_ACCOUNT_ID_LENGTH) return null;
  return trimmed;
}

/**
 * The credential string the `account` envelope is wrapped under.
 *
 * **This is not a secret and must never be described as one.** It is derived from the account *identifier* and
 * a fixed domain prefix, so its security property is "you know the id" -- which is exactly what the user asked
 * for (compare the id, allow when it matches) and exactly why `docs/BACKUP-DESIGN.md` §25 calls it an identity
 * binding rather than encryption. Password stays the cross-machine secret path.
 *
 * @param {string} accountId
 * @returns {string|null} `null` when the id is unusable.
 */
export function accountBindingSecret(accountId) {
  const normalized = normalizeAccountId(accountId);
  if (normalized === null) return null;
  return `${ACCOUNT_BINDING_DOMAIN}|${normalized}`;
}

/**
 * The account id a key document is bound to, or `null`.
 *
 * @param {object|null} keys a `keys.json` document (or an envelope-bearing snapshot copy)
 * @returns {string|null}
 */
export function boundAccountId(keys) {
  const binding = keys?.account_binding;
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) return null;
  return normalizeAccountId(binding.account_id);
}

/**
 * The masked form of an account id: the last four characters, with a leading ellipsis when anything was cut.
 * This is the ONLY form allowed in results, logs and UI -- never the full id.
 *
 * @param {unknown} accountId
 * @returns {string|null}
 */
export function accountIdHint(accountId) {
  const normalized = normalizeAccountId(accountId);
  if (normalized === null) return null;
  const tail = normalized.slice(-4);
  return normalized.length <= 4 ? tail : `…${tail}`;
}

/**
 * The `account` field every open/describe result carries.
 *
 * `bound` says the repository names an account; `matched` is only known when a host id was supplied (`null`
 * otherwise, and also `null` when nothing is bound -- there is nothing to compare against).
 *
 * @param {object|null} keys
 * @param {string|null} [accountId] the host id supplied by the caller
 * @returns {{bound: boolean, matched: boolean|null, id_hint: string|null}}
 */
export function accountBindingState(keys, accountId = null) {
  const bound = boundAccountId(keys);
  const provided = normalizeAccountId(accountId);
  return {
    bound: bound !== null,
    matched: bound === null || provided === null ? null : bound === provided,
    id_hint: accountIdHint(bound),
  };
}

/** Envelope kind names of a key document, in document order. */
function envelopeKinds(keys) {
  return Array.isArray(keys?.envelopes) ? keys.envelopes.map((envelope) => String(envelope?.kind)) : [];
}

/**
 * Mark the account attempt with `BACKUP_ACCOUNT_MISMATCH` instead of the indistinguishable key-unwrap failure.
 *
 * `unwrapDek` reports the account attempt as `{kind:'account', ok:false, code:null}` when no account credential
 * was supplied. When the reason is a known id mismatch, saying so is strictly more useful than a generic
 * authentication failure -- and it is not a guess: the mismatch comes from comparing recorded metadata, not from
 * interpreting a GCM failure.
 *
 * @param {Array<object>} attempts
 * @param {boolean} mismatch
 * @returns {Array<object>}
 */
function decorateAccountAttempts(attempts, mismatch) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (mismatch !== true) return list;
  return list.map((attempt) => (attempt?.kind === 'account' && attempt.ok !== true
    ? { ...attempt, code: KEYSTORE_CODES.ACCOUNT_MISMATCH }
    : attempt));
}

/** The authoritative wrapped-key file for a repository. */
export function repoKeysPath(root) {
  return path.join(path.resolve(root), REPO_KEYS_FILE);
}

/**
 * Read and structurally validate the repository's key document.
 *
 * @param {string} root
 * @returns {{ok: true, keys: object, file: string} | {ok: false, file: string, reason: string, detail: string|null}}
 */
export function readRepoKeys(root) {
  const file = repoKeysPath(root);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, file, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable', detail: error?.code ?? null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, file, reason: KEYSTORE_CODES.CORRUPT, detail: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    validateKeysFile(parsed);
  } catch (error) {
    return { ok: false, file, reason: KEYSTORE_CODES.CORRUPT, detail: error?.detail ?? String(error?.message ?? error) };
  }
  return { ok: true, keys: parsed, file };
}

/**
 * Add a `machine` envelope to an existing key document.
 *
 * The case this exists for: a repository seeded offline with a password (or created on a machine whose keystore
 * was unavailable), then opened on a machine that *does* have an OS keystore. Without the upgrade, every
 * scheduled run on that machine would refuse with `BACKUP_NO_PERMISSION`, because a timer cannot type a password.
 *
 * Existing envelopes are preserved byte-for-byte -- a password someone wrote down keeps working -- and nothing is
 * added when a machine envelope already exists. Returns the new document; writing it is the caller's decision
 * (inside the repository lock), so a failed write cannot leave a half-upgraded file.
 *
 * @param {object} keys existing `keys.json` document
 * @param {Buffer} dek the already-unwrapped data key
 * @param {Buffer} machineSecret
 * @param {{now?: Date}} [options]
 * @returns {{added: boolean, keys: object, reason: string|null}}
 */
export function addMachineEnvelope(keys, dek, machineSecret, options = {}) {
  if (keys === null || typeof keys !== 'object' || !Array.isArray(keys.envelopes)) {
    return { added: false, keys, reason: 'not a key document' };
  }
  if (keys.envelopes.some((envelope) => envelope?.kind === 'machine')) {
    return { added: false, keys, reason: 'already has a machine envelope' };
  }
  if (!Buffer.isBuffer(dek) || dek.length === 0) return { added: false, keys, reason: 'no data key to wrap' };
  if (!Buffer.isBuffer(machineSecret) || machineSecret.length === 0) {
    return { added: false, keys, reason: 'no machine secret available' };
  }
  const wrapped = wrapDek(dek, [{ kind: 'machine', secret: machineSecret }], { now: options.now ?? new Date() });
  const upgraded = { ...keys, envelopes: [...keys.envelopes, ...wrapped.envelopes] };
  validateKeysFile(upgraded);
  return { added: true, keys: upgraded, reason: null };
}

/**
 * Add a `password` envelope to an existing key document.
 *
 * The case this exists for: a repository created on this machine with only a `machine` envelope (the default for a
 * scheduled run, because a timer cannot type a password) is unusable after a reinstall / on another machine. The
 * password envelope is the **only** path that survives that, so a machine-only repository must be able to gain one
 * later -- with the same DEK, so every stored block stays readable.
 *
 * Existing envelopes are preserved byte-for-byte; a second call is a no-op.
 *
 * @param {object} keys existing `keys.json` document
 * @param {Buffer} dek the already-unwrapped data key
 * @param {string|Buffer} password non-empty password (minimum length enforced by the caller)
 * @param {{now?: Date}} [options]
 * @returns {{added: boolean, keys: object, reason: string|null}}
 */
export function addPasswordEnvelope(keys, dek, password, options = {}) {
  if (keys === null || typeof keys !== 'object' || !Array.isArray(keys.envelopes)) {
    return { added: false, keys, reason: 'not a key document' };
  }
  if (keys.envelopes.some((envelope) => envelope?.kind === 'password')) {
    return { added: false, keys, reason: 'already has a password envelope' };
  }
  if (!Buffer.isBuffer(dek) || dek.length === 0) return { added: false, keys, reason: 'no data key to wrap' };
  const bytes = Buffer.isBuffer(password) ? password : Buffer.from(String(password ?? ''), 'utf8');
  if (bytes.length === 0) return { added: false, keys, reason: 'the password is empty' };
  const wrapped = wrapDek(dek, [{ kind: 'password', secret: bytes }], { now: options.now ?? new Date() });
  const upgraded = { ...keys, envelopes: [...keys.envelopes, ...wrapped.envelopes] };
  validateKeysFile(upgraded);
  return { added: true, keys: upgraded, reason: null };
}

/**
 * Add an `account` envelope to an existing key document (the "same account, no password" path).
 *
 * **What this is.** The DEK is wrapped under HKDF(`w2m-account-binding|<accountId>`), and the id itself is
 * recorded at the document root (`account_binding: {account_id, bound_at}`) so an unlock can compare the host's
 * current account id with the original one before it derives anything. The user's decision (2026-11-17) is
 * compare-only: read the unique account id, compare it, allow when it matches. See `docs/BACKUP-DESIGN.md` §25.
 *
 * **What this is not.** It is not confidentiality: the account id is an *identifier, not a secret*, so anyone who
 * knows it and has the repository files can derive the same KEK. The password envelope remains the cross-machine
 * secret path, and it is never replaced by this one.
 *
 * Refusal rules, all named:
 *   * a repository bound to a **different** account id is refused (`BACKUP_ACCOUNT_MISMATCH`) -- switching the
 *     bound account silently would change which identity opens the backup;
 *   * binding the **same** id twice is a no-op (`added: false`, no rewrite);
 *   * an existing `account` envelope without `account_binding` metadata cannot be compared, so it is refused
 *     (`BACKUP_ACCOUNT_BINDING_UNKNOWN`) instead of being overwritten or guessed.
 *
 * Existing envelopes are preserved byte-for-byte; writing the result is the caller's decision.
 *
 * @param {object} keys existing `keys.json` document
 * @param {Buffer} dek the already-unwrapped data key
 * @param {string} accountId the account identifier the repository should be bound to
 * @param {{now?: Date}} [options]
 * @returns {{added: boolean, keys: object, reason: string|null, reason_code: string|null}}
 */
export function addAccountEnvelope(keys, dek, accountId, options = {}) {
  if (keys === null || typeof keys !== 'object' || !Array.isArray(keys.envelopes)) {
    return { added: false, keys, reason: 'not a key document', reason_code: null };
  }
  const normalized = normalizeAccountId(accountId);
  if (normalized === null) {
    return { added: false, keys, reason: 'no usable account id', reason_code: KEYSTORE_CODES.ACCOUNT_INVALID };
  }
  const bound = boundAccountId(keys);
  if (bound !== null && bound !== normalized) {
    return {
      added: false,
      keys,
      reason: `already bound to a different account (hint ${String(accountIdHint(bound))})`,
      reason_code: KEYSTORE_CODES.ACCOUNT_MISMATCH,
    };
  }
  const hasAccountEnvelope = keys.envelopes.some((envelope) => envelope?.kind === 'account');
  if (hasAccountEnvelope) {
    if (bound === normalized) return { added: false, keys, reason: 'already bound to this account', reason_code: null };
    return {
      added: false,
      keys,
      reason: 'an account envelope exists with no account_binding metadata; it cannot be compared and will not be overwritten',
      reason_code: KEYSTORE_CODES.ACCOUNT_BINDING_UNKNOWN,
    };
  }
  if (!Buffer.isBuffer(dek) || dek.length === 0) return { added: false, keys, reason: 'no data key to wrap', reason_code: null };
  const now = options.now ?? new Date();
  const wrapped = wrapDek(dek, [{ kind: 'account', secret: accountBindingSecret(normalized), hint: accountIdHint(normalized) }], { now });
  const upgraded = {
    ...keys,
    envelopes: [...keys.envelopes, ...wrapped.envelopes],
    [ACCOUNT_BINDING_FIELD]: { account_id: normalized, bound_at: now.toISOString() },
  };
  validateKeysFile(upgraded);
  return { added: true, keys: upgraded, reason: null, reason_code: null };
}

/**
 * Bind a live repository to the current host account id (the "same account, no password" repair).
 *
 * Order matters, exactly like `setRepositoryPassword`: open the repository with the credentials this machine
 * already has (machine or an existing password), wrap the **same** DEK under the account credential, keep a
 * sibling copy of `keys.json`, write atomically, then verify by unwrapping with the new account credential alone.
 * Idempotent: a repository already bound to the same id is left untouched. A repository bound to another id is a
 * named refusal (`BACKUP_ACCOUNT_MISMATCH`) -- this function never re-binds.
 *
 * Standalone use (no CLI command by design; the operator has to supply a host-derived id):
 *
 *   node --input-type=module -e "import { bindAccount } from 'file:///E:/GPT/w2m/w2m-345-fresh/src/backup/keystore.mjs'; console.log(JSON.stringify(bindAccount({ root: 'D:/DeepSeekHarness/BackUP', dshHome: process.env.USERPROFILE + '/.dsh', accountId: '<accountId>' }), null, 2))"
 *
 * @param {{root: string, dshHome: string, accountId: string, password?: string|Buffer|null,
 *   platform?: string, runner?: Function, machineKey?: boolean, now?: Date, kdf?: object,
 *   backupDir?: string|null}} input
 * @returns {{ok: boolean, added: boolean, file: string|null, backup_file: string|null,
 *   envelopes: string[], account: {bound: boolean, matched: boolean|null, id_hint: string|null},
 *   reason_code: string|null, detail: string|null}}
 */
export function bindAccount(input) {
  const normalized = normalizeAccountId(input?.accountId);
  if (normalized === null) {
    return {
      ok: false,
      added: false,
      file: null,
      backup_file: null,
      envelopes: [],
      account: { bound: false, matched: null, id_hint: null },
      reason_code: KEYSTORE_CODES.ACCOUNT_INVALID,
      detail: 'bindAccount needs a non-empty account id string',
    };
  }
  const opened = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    password: input.password ?? null,
    platform: input.platform,
    runner: input.runner,
    machineKey: input.machineKey,
    now: input.now,
    kdf: input.kdf,
  });
  if (opened.ok !== true) {
    return {
      ok: false,
      added: false,
      file: opened.file ?? null,
      backup_file: null,
      envelopes: [],
      account: { bound: false, matched: null, id_hint: null },
      reason_code: opened.reason_code,
      detail: opened.detail,
    };
  }
  const upgraded = addAccountEnvelope(opened.keys, opened.dek, normalized, { now: input.now });
  if (upgraded.reason_code !== null) {
    return {
      ok: false,
      added: false,
      file: opened.file,
      backup_file: null,
      envelopes: envelopeKinds(opened.keys),
      account: accountBindingState(opened.keys, normalized),
      reason_code: upgraded.reason_code,
      detail: upgraded.reason,
    };
  }
  if (upgraded.added !== true) {
    return {
      ok: true,
      added: false,
      file: opened.file,
      backup_file: null,
      envelopes: envelopeKinds(opened.keys),
      account: accountBindingState(opened.keys, normalized),
      reason_code: null,
      detail: upgraded.reason,
    };
  }
  const file = opened.file;
  const stamp = (input.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupFile = input.backupDir ?? path.join(path.dirname(file), 'keys.json.bak-' + stamp);
  try {
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(file, backupFile);
    writeFileAtomic(file, JSON.stringify(upgraded.keys));
  } catch (error) {
    return {
      ok: false,
      added: false,
      file,
      backup_file: backupFile,
      envelopes: envelopeKinds(opened.keys),
      account: accountBindingState(opened.keys, normalized),
      reason_code: error?.code ?? 'BACKUP_WRITE_FAILED',
      detail: error?.detail ?? String(error?.message ?? error),
    };
  }
  // The point of the write: the account credential alone must open the same DEK.
  let verify = null;
  try {
    verify = unwrapDek(upgraded.keys, { accountSecret: accountBindingSecret(normalized) });
  } catch {
    verify = null;
  }
  if (verify === null || Buffer.isBuffer(verify.dek) !== true || verify.dek.equals(opened.dek) !== true) {
    return {
      ok: false,
      added: true,
      file,
      backup_file: backupFile,
      envelopes: envelopeKinds(upgraded.keys),
      account: accountBindingState(upgraded.keys, normalized),
      reason_code: NO_PERMISSION,
      detail: 'the written account envelope did not verify against the data key',
    };
  }
  return {
    ok: true,
    added: true,
    file,
    backup_file: backupFile,
    envelopes: envelopeKinds(upgraded.keys),
    account: accountBindingState(upgraded.keys, normalized),
    reason_code: null,
    detail: null,
  };
}

/**
 * Add a password envelope to a live repository (the "two unlock options" repair).
 *
 * Order matters: the existing repository is opened first (machine or an existing password), then the new envelope
 * is wrapped around the **same** DEK, then the document is written atomically after a sibling backup, then the new
 * credential is verified by unwrapping it in isolation.
 *
 * @param {{
 *   root: string, dshHome: string, password: string|Buffer,
 *   platform?: string, runner?: Function, machineKey?: boolean, now?: Date, kdf?: object,
 *   backupDir?: string|null,
 * }} input
 * @returns {{ok: boolean, added: boolean, file: string|null, backup_file: string|null,
 *   envelopes: string[], reason_code: string|null, detail: string|null}}
 */
export function setRepositoryPassword(input) {
  const bytes = Buffer.isBuffer(input.password) ? input.password : Buffer.from(String(input.password ?? ''), 'utf8');
  if (bytes.length < 8) {
    return { ok: false, added: false, file: null, backup_file: null, envelopes: [], reason_code: NO_PERMISSION, detail: 'the unlock password must be at least 8 bytes' };
  }
  const opened = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    platform: input.platform,
    runner: input.runner,
    machineKey: input.machineKey,
    now: input.now,
    kdf: input.kdf,
  });
  if (opened.ok !== true) {
    return { ok: false, added: false, file: opened.file ?? null, backup_file: null, envelopes: [], reason_code: opened.reason_code, detail: opened.detail };
  }
  const upgraded = addPasswordEnvelope(opened.keys, opened.dek, bytes, { now: input.now });
  if (upgraded.added !== true) {
    return {
      ok: true,
      added: false,
      file: opened.file,
      backup_file: null,
      envelopes: opened.keys.envelopes.map((envelope) => String(envelope.kind)),
      reason_code: null,
      detail: upgraded.reason,
    };
  }
  const file = opened.file;
  const stamp = (input.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupFile = input.backupDir ?? path.join(path.dirname(file), 'keys.json.bak-' + stamp);
  try {
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(file, backupFile);
    writeFileAtomic(file, JSON.stringify(upgraded.keys));
  } catch (error) {
    return { ok: false, added: false, file, backup_file: backupFile, envelopes: [], reason_code: error?.code ?? 'BACKUP_WRITE_FAILED', detail: error?.detail ?? String(error?.message ?? error) };
  }
  // The point of the write: the new credential alone must open the same DEK.
  let verify = null;
  try {
    verify = unwrapDek(upgraded.keys, { password: bytes });
  } catch {
    verify = null;
  }
  if (verify === null || Buffer.isBuffer(verify.dek) !== true || verify.dek.equals(opened.dek) !== true) {
    return { ok: false, added: true, file, backup_file: backupFile, envelopes: [], reason_code: NO_PERMISSION, detail: 'the written password envelope did not verify against the data key' };
  }
  return {
    ok: true,
    added: true,
    file,
    backup_file: backupFile,
    envelopes: upgraded.keys.envelopes.map((envelope) => String(envelope.kind)),
    reason_code: null,
    detail: null,
  };
}

/**
 * Open the repository key, creating it on first use.
 *
 * The credential order is the protocol's (`crypto.unwrapDek`): `account`, `machine`, `password`. The account
 * credential is supplied only when the caller passed an account id **and** the repository's recorded binding
 * matches it; a mismatch is not a wrong-key attempt, it is recorded as `BACKUP_ACCOUNT_MISMATCH` and the unlock
 * continues to the machine/password paths (the user's rule: mismatch -> switch to password mode).
 *
 * @param {{
 *   root: string,
 *   dshHome: string,
 *   accountId?: string|null,
 *   password?: string|Buffer|null,
 *   platform?: string,
 *   runner?: Function,
 *   now?: Date,
 *   kdf?: object,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   dek: Buffer|null,
 *   keys: object|null,
 *   file: string,
 *   created: boolean,
 *   unlocked_via: string|null,
 *   machine: object,
 *   account: {bound: boolean, matched: boolean|null, id_hint: string|null},
 *   attempts: Array<object>,
 *   reason_code: string|null,
 *   detail: string|null
 * }}
 */
export function openRepoKey(input) {
  const file = repoKeysPath(input.root);
  const platform = input.platform ?? process.platform;
  // `machineKey: false` is an explicit opt-out (CLI `--no-machine-key`, config `backupMachineKey: false`, tests):
  // it skips touching the OS keystore entirely rather than probing it and ignoring the result.
  const machine = input.machineKey === false
    ? { ok: false, secret: null, path: machineKeyPath(input.dshHome), created: false, backend: 'disabled', reason: 'disabled-by-configuration', detail: null }
    : loadMachineSecret({ dshHome: input.dshHome, platform, runner: input.runner, now: input.now });
  const password = input.password ?? null;
  const accountId = normalizeAccountId(input.accountId ?? null);
  const existing = readRepoKeys(input.root);

  if (existing.ok === true) {
    const bound = boundAccountId(existing.keys);
    const hasAccountEnvelope = existing.keys.envelopes.some((envelope) => envelope?.kind === 'account');
    // Compare-only: the recorded id is the authority. `bound === null` with an account envelope is a file this
    // build cannot compare (no metadata); it is still attempted so such a repository remains openable, but the
    // result reports `matched: null` rather than pretending the comparison happened.
    const mismatch = bound !== null && accountId !== null && bound !== accountId;
    const accountSecret = accountId !== null && mismatch !== true && (bound !== null || hasAccountEnvelope)
      ? accountBindingSecret(accountId)
      : null;
    const account = accountBindingState(existing.keys, accountId);
    const credentials = {
      ...(accountSecret === null ? {} : { accountSecret }),
      ...(machine.ok === true ? { machineSecret: machine.secret } : {}),
      ...(password === null ? {} : { password }),
    };
    try {
      const opened = unwrapDek(existing.keys, credentials);
      // Upgrade opportunity: a repository created with only a password becomes passwordless on this machine the
      // first time it is opened here with a working OS keystore. Without this, a scheduled run on a machine whose
      // repository was seeded offline could never succeed -- it has no password to type.
      let keys = existing.keys;
      let machineEnvelopeAdded = false;
      if (machine.ok === true) {
        try {
          const upgrade = addMachineEnvelope(keys, opened.dek, machine.secret, { now: input.now });
          if (upgrade.added === true) {
            writeJsonAtomic(file, upgrade.keys);
            keys = upgrade.keys;
            machineEnvelopeAdded = true;
          }
        } catch {
          // Best effort by design: the run has a working credential, and failing it because an optional
          // convenience envelope could not be added would be the tail wagging the dog.
        }
      }
      return {
        ok: true,
        dek: opened.dek,
        keys,
        file,
        created: false,
        unlocked_via: opened.kind,
        machine,
        account: accountBindingState(keys, accountId),
        machine_envelope_added: machineEnvelopeAdded,
        attempts: decorateAccountAttempts(opened.attempts, mismatch),
        reason_code: null,
        detail: null,
      };
    } catch (error) {
      return {
        ok: false,
        dek: null,
        keys: existing.keys,
        file,
        created: false,
        unlocked_via: null,
        machine,
        account,
        attempts: decorateAccountAttempts(error?.attempts ?? [], mismatch),
        machine_envelope_added: false,
        reason_code: KEYSTORE_CODES.NO_PERMISSION,
        detail:
          'this repository cannot be opened with the credentials available on this machine: ' +
          'sign in on the machine that created it, or supply the unlock password',
      };
    }
  }
  if (existing.reason !== 'missing') {
    return {
      ok: false,
      dek: null,
      keys: null,
      file,
      created: false,
      unlocked_via: null,
      machine,
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: KEYSTORE_CODES.CORRUPT,
      detail: `${existing.file}: ${existing.reason}${existing.detail === null ? '' : ` (${existing.detail})`}`,
    };
  }

  // First use: mint the DEK and wrap it under everything this machine can offer.
  const envelopes = [];
  if (machine.ok === true) envelopes.push({ kind: 'machine', secret: machine.secret });
  if (password !== null) {
    const bytes = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
    if (bytes.length > 0) envelopes.push({ kind: 'password', secret: bytes });
  }
  if (envelopes.length === 0) {
    return {
      ok: false,
      dek: null,
      keys: null,
      file,
      created: false,
      unlocked_via: null,
      machine,
      // A first use never creates an account-only repository: the binding is added after a run that already has
      // a real credential, so an account id alone can never be the reason a repository exists.
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: KEYSTORE_CODES.NO_PERMISSION,
      detail:
        'no credential can protect a new backup on this machine: the OS keystore is unavailable ' +
        `(${machine.reason ?? 'unknown'}) and no unlock password was supplied`,
    };
  }
  const kdf = input.kdf ?? DEFAULT_SCRYPT;
  if (kdf.algo === 'scrypt' && kdf.N < MIN_SCRYPT.N) {
    return {
      ok: false,
      dek: null,
      keys: null,
      file,
      created: false,
      unlocked_via: null,
      machine,
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: CRYPTO_CODES.KDF_WEAK,
      detail: `scrypt N=${kdf.N} is below the floor N=${MIN_SCRYPT.N}`,
    };
  }
  const dek = randomDek();
  const keys = wrapDek(dek, envelopes, { now: input.now ?? new Date(), kdf });
  try {
    writeJsonAtomic(file, keys);
  } catch (error) {
    return {
      ok: false,
      dek: null,
      keys: null,
      file,
      created: false,
      unlocked_via: null,
      machine,
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: error?.code ?? KEYSTORE_CODES.CORRUPT,
      detail: error?.detail ?? String(error?.message ?? error),
    };
  }
  return {
    ok: true,
    dek,
    keys,
    file,
    created: true,
    unlocked_via: machine.ok === true ? 'machine' : 'password',
    machine,
    account: accountBindingState(keys, accountId),
    attempts: [],
    machine_envelope_added: false,
    reason_code: null,
    detail: null,
  };
}
