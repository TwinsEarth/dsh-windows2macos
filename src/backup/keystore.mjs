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
 * ## Who can open it, and what "protecting" the repository now means
 *
 * The product's goal is **not absolute confidentiality** (the user's 2026-11-17 decision, translated in
 * `docs/BACKUP-DESIGN.md` §25): the three states are *no protection* (default), *account-id compare* (a
 * convenience so the same account opens without typing), and a 4-6 digit *PIN* (a convenience threshold when
 * the account does not match). So:
 *
 *   * `open` -- **no protection** (the default): the DEK is stored in clear in `keys.json`, so the repository
 *     opens with no credential at all. Anyone who can read the repository directory can restore it. This is a
 *     deliberate state, not a failure;
 *   * `machine` -- the random secret protected by DPAPI (Windows); same machine, no password;
 *   * `account` -- an **identity binding**, not a secret: the KEK is HKDF over `w2m-account-binding|<accountId>`.
 *     The user decided that the account id read from the host is compared with the bound id and, when it
 *     matches, the account path opens without a password. **Anyone who knows the account id and has the
 *     repository files can derive the same KEK.** That is accepted for this convenience path;
 *   * `password` -- scrypt, expected to be a 4-6 digit PIN: a convenience threshold that survives a machine
 *     *and* an account change, not confidentiality against someone holding the files.
 *
 * A `sealed` repository (any of account/machine/password envelopes) is what old repositories are; a
 * `none` repository carries exactly one `open` envelope and no others. Mixing is refused by
 * `crypto.validateKeysFile`.
 *
 * The bound account id is recorded next to the envelope (`keys.json` root field `account_binding`), because an
 * unlock must be able to answer "is this the original account?" before it tries a KEK; the envelope alone cannot
 * distinguish "wrong id" from "tampered file" (GCM reports one authentication failure for both). The account id
 * is masked (last four characters only) in every output, log line and UI string.
 *
 * ## Refusing to write an unopenable backup
 *
 * If a caller explicitly asks for `sealed` and neither a machine envelope nor a password envelope can be
 * created, the run is refused before a single block is written (`BACKUP_NO_PERMISSION`). Writing a repository
 * nobody can open is worse than not writing one. The default `none` mode needs no credential by design, so it
 * is never refused for that reason. The account binding is added **after** a successful run, never as the only
 * reason a repository exists.
 *
 * ## Rotating the PIN
 *
 * The PIN *can* be changed: `rotatePassword` opens the repository with a working credential, removes **every**
 * existing `password` envelope, writes exactly one new envelope around the **same** DEK, and then verifies both
 * ways -- the new PIN opens the document, and the old PIN no longer does. The document is copied to
 * `keys.json.bak-<ts>` before the write and restored if either check fails, so a broken rotation never leaves a
 * repository whose old credential still works (`BACKUP_ROTATION_VERIFY_FAILED`).
 *
 * That is not a recovery path: rotation needs an existing working credential (machine, a matching account id, or
 * the old PIN). A forgotten PIN with no machine/account path still means the repository cannot be opened.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CRYPTO_CODES,
  DEFAULT_SCRYPT,
  MAX_PASSWORD_HINT_LENGTH,
  MIN_SCRYPT,
  OPEN_KIND,
  normalizePasswordHint,
  openEnvelopeRecord,
  randomDek,
  unwrapDek,
  validateKeysFile,
  wrapDek,
  wrapOpenDek,
} from './crypto.mjs';
import { writeFileAtomic, writeJsonAtomic } from './atomic.mjs';
import { loadMachineSecret, machineKeyPath } from './machine-key.mjs';
import {
  DEFAULT_REPO_ENCRYPTION,
  LAYOUT_CODES,
  REPO_ENCRYPTION_MODES,
  descriptorEncryption,
  readDescriptor,
  syncDescriptorEncryption,
} from './layout.mjs';

/** File name of the authoritative wrapped-key document, at the repository root. */
export const REPO_KEYS_FILE = 'keys.json';

/** Named keystore refusal code. Matches `docs/BACKUP-DESIGN.md` §11 (`BACKUP_NO_PERMISSION`). */
export const NO_PERMISSION = 'BACKUP_NO_PERMISSION';

/** Minimum credential length for a repository PIN. Four digits are the expected use, not a strong secret. */
export const MIN_PASSWORD_BYTES = 4;

/** Below this length (or all digits) a password is reported `weak: true`. It is never silently strengthened. */
export const STRONG_PASSWORD_BYTES = 8;

/** Warning text the CLI and panel show for an unencrypted repository. */
export const UNENCRYPTED_WARNING = '未加密：任何能访问该目录的人都能还原备份';

/** Warning text the CLI shows when a 4-6 digit PIN is accepted: convenience, not confidentiality. */
export const WEAK_PIN_WARNING = '4 位数字 PIN 只是便捷门槛，不是保密强度';

/** Validation refusal for an unknown `encryption` value; matches the configuration-invalid style. */
export const ENCRYPTION_INVALID = 'BACKUP_CONFIG_INVALID';

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
  /** The public password hint is unusable: not a string, empty after trimming, too long, or equal to the PIN. */
  HINT_INVALID: 'BACKUP_PASSWORD_HINT_INVALID',
  /** `rotatePassword` was asked to change a PIN on a repository that has no `password` envelope to replace. */
  NO_PASSWORD_ENVELOPE: 'BACKUP_NO_PASSWORD_ENVELOPE',
  /**
   * The rotation wrote a document whose old PIN still opened it (or whose new PIN did not). The pre-write
   * `keys.json.bak-<ts>` copy is restored before this is returned, so the repository is left as it was.
   */
  ROTATION_VERIFY_FAILED: 'BACKUP_ROTATION_VERIFY_FAILED',
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

/**
 * The public password hint that travels with the `password` envelope.
 *
 * **It is public metadata by design.** The user's decision (2026-11-17) is that a 4-6 digit PIN may carry a
 * free-text "备注提示词" ("周六生日"), stored in the repository's `keys.json` at the root
 * (`password_hint: {text, updated_at}`) and shown by every unlock probe. Because it is written in clear next to
 * the repository, anyone who can read the keys file can read it -- so it may hold a reminder of the PIN, never
 * the PIN itself (the writer refuses a hint equal to the PIN, and this reader never touches the envelope).
 *
 * The returned shape is what `describeUnlock`, the CLI and the panel consume: `{set, text}`. When no hint is
 * stored it is `{set: false, text: null}`, so a caller never has to distinguish "missing" from "malformed".
 *
 * @param {object|null} keys a `keys.json` document (or an envelope-bearing snapshot copy)
 * @returns {{set: boolean, text: string|null}}
 */
export function passwordHintState(keys) {
  const hint = keys?.password_hint;
  if (hint === null || typeof hint !== 'object' || Array.isArray(hint)) return { set: false, text: null };
  if (typeof hint.text !== 'string' || hint.text === '') return { set: false, text: null };
  return { set: true, text: hint.text };
}

/** Envelope kind names of a key document, in document order. */
function envelopeKinds(keys) {
  return Array.isArray(keys?.envelopes) ? keys.envelopes.map((envelope) => String(envelope?.kind)) : [];
}

/** True when the key document says the repository is unencrypted (exactly one `open` envelope). */
export function hasOpenEnvelope(keys) {
  return Array.isArray(keys?.envelopes) && keys.envelopes.some((envelope) => envelope?.kind === OPEN_KIND);
}

/**
 * The protection mode a key document really is, as opposed to what the descriptor claims.
 *
 * The key document is authoritative for behaviour: an `open` envelope means no credential is required. The
 * descriptor's `encryption` field is metadata kept in step by `syncDescriptorEncryption`.
 *
 * @param {object|null} keys
 * @returns {'none'|'sealed'|null} null when there is no key document
 */
export function keysEncryption(keys) {
  if (keys === null || keys === undefined) return null;
  return hasOpenEnvelope(keys) ? 'none' : 'sealed';
}

/**
 * The credential paths a key document actually offers, in protocol order.
 *
 * `['none']` for an unencrypted repository; otherwise the credential envelope kinds present. This is what the
 * status/unlock payload reports as `available_paths` -- it says which envelopes exist, not whether this
 * machine can use them (the machine DPAPI probe is a separate field).
 *
 * @param {object|null} keys
 * @returns {string[]}
 */
export function availablePaths(keys) {
  if (keys === null || keys === undefined || !Array.isArray(keys.envelopes)) return [];
  const kinds = new Set(envelopeKinds(keys));
  if (kinds.has(OPEN_KIND)) return ['none'];
  return ['account', 'machine', 'password'].filter((kind) => kinds.has(kind));
}

/** Normalise a supplied credential to bytes, or null when absent/empty. */
function passwordBytes(value) {
  if (value === null || value === undefined) return null;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return bytes.length > 0 ? bytes : null;
}

/** A password is "weak" when it is shorter than 8 bytes or all decimal digits (the expected 4-6 digit PIN). */
export function isWeakPassword(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  if (bytes.length === 0) return true;
  return bytes.length < STRONG_PASSWORD_BYTES || /^[0-9]+$/u.test(bytes.toString('utf8'));
}

/**
 * Resolve the protection mode for a **first use** (creating `keys.json`).
 *
 * Precedence, and the only places the default is overridden:
 *
 *   1. an explicit `encryption` (`run --encrypt none|sealed`, `runBackup({encryption})`) wins; an unknown
 *      value is a named `BACKUP_CONFIG_INVALID` refusal;
 *   2. otherwise a supplied password -> `sealed` (the caller asked for a PIN and that must be honoured);
 *   3. otherwise an explicit `machineKey: true` -> `sealed` (the caller asked for OS-keystore protection);
 *   4. otherwise a resolvable account id -> `sealed` (the caller asked for the account compare path);
 *   5. otherwise **`none`** -- the default. No credential is required, and none is invented.
 *
 * An explicit `none` combined with a password is refused rather than silently dropping the password: the two
 * requests contradict each other, and a silently ignored password is exactly the kind of surprise this
 * product must not produce.
 *
 * @param {{encryption?: string|null, password?: string|Buffer|null, machineKey?: boolean,
 *   accountId?: string|null}} [input]
 * @returns {{ok: true, mode: 'none'|'sealed'} | {ok: false, reason_code: string, detail: string}}
 */
export function resolveEncryptionMode(input = {}) {
  const explicit = input.encryption ?? null;
  if (explicit !== null && !REPO_ENCRYPTION_MODES.includes(explicit)) {
    return {
      ok: false,
      reason_code: ENCRYPTION_INVALID,
      detail: `encryption must be one of ${REPO_ENCRYPTION_MODES.join(', ')}, got ${JSON.stringify(String(explicit))}`,
    };
  }
  const password = passwordBytes(input.password);
  if (explicit === 'none') {
    if (password !== null) {
      return {
        ok: false,
        reason_code: ENCRYPTION_INVALID,
        detail: 'encryption "none" cannot be combined with a password: omit --password-stdin, or use --encrypt sealed',
      };
    }
    return { ok: true, mode: 'none' };
  }
  if (explicit === 'sealed') return { ok: true, mode: 'sealed' };
  if (password !== null) return { ok: true, mode: 'sealed' };
  if (input.machineKey === true) return { ok: true, mode: 'sealed' };
  if (normalizeAccountId(input.accountId ?? null) !== null) return { ok: true, mode: 'sealed' };
  return { ok: true, mode: DEFAULT_REPO_ENCRYPTION };
}

/** The `machine` field for a repository that legitimately does not touch the OS keystore. */
function machineStateSkipped(input, reason) {
  return {
    ok: false,
    secret: null,
    path: machineKeyPath(input.dshHome),
    created: false,
    backend: 'skipped',
    reason,
    detail: null,
  };
}

/** The `machine` field when the caller explicitly disabled the OS keystore. */
function machineStateDisabled(input) {
  return machineStateSkipped(input, 'disabled-by-configuration');
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
  // A machine envelope beside an open record would have to be ignored (open wins) or would silently seal the
  // repository. Neither is a sensible implicit conversion; `setEncryptionMode` is the explicit path.
  if (hasOpenEnvelope(keys)) {
    return { added: false, keys, reason: 'the repository is unencrypted (open envelope); adding a machine envelope would need an explicit mode change' };
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
 * Add an `open` envelope to a key document: turn an unencrypted repository into an explicitly unencrypted one.
 *
 * This is only valid for a document that carries **no credential envelopes**, because `crypto.validateKeysFile`
 * refuses the mixture (the open path would otherwise silently bypass a configured password). The caller is
 * therefore `setEncryptionMode`, which opens a sealed repository with its existing credentials, builds the
 * converted document and verifies it; this function adds the record and drops the now-meaningless
 * `account_binding` and `password_hint` root metadata (both describe credentials that no longer exist).
 *
 * **Security consequence (documented, on purpose).** After this write the DEK sits in clear in `keys.json`:
 * anyone who can read the repository directory can decrypt every object. That is what "turn protection off"
 * means; it is not an accident.
 *
 * @param {object} keys existing `keys.json` document
 * @param {Buffer} dek the already-unwrapped data key
 * @param {{now?: Date}} [options]
 * @returns {{added: boolean, keys: object, reason: string|null}}
 */
export function addOpenEnvelope(keys, dek, options = {}) {
  if (keys === null || typeof keys !== 'object' || !Array.isArray(keys.envelopes)) {
    return { added: false, keys, reason: 'not a key document' };
  }
  if (hasOpenEnvelope(keys)) return { added: false, keys, reason: 'already unencrypted' };
  if (keys.envelopes.length > 0) {
    return {
      added: false,
      keys,
      reason: 'the open envelope cannot be mixed with credential envelopes; open the repository and convert the document instead',
    };
  }
  if (!Buffer.isBuffer(dek) || dek.length === 0) return { added: false, keys, reason: 'no data key to wrap' };
  // Both root metadata fields describe a credential that is being removed: `account_binding` names the account
  // envelope, `password_hint` is public text about the password envelope. `validateKeysFile` refuses a hint
  // without its envelope, so both are dropped in the same write rather than leaving a dangling promise.
  const { account_binding: _removedBinding, password_hint: _removedHint, ...rest } = keys;
  const converted = { ...rest, envelopes: [openEnvelopeRecord(dek, { now: options.now ?? new Date() })] };
  validateKeysFile(converted);
  return { added: true, keys: converted, reason: null };
}

/**
 * Add a `password` envelope to an existing key document.
 *
 * The case this exists for: a **sealed** repository created on this machine with only a `machine` envelope (so a
 * timer could open it without typing) is unusable after a reinstall / on another machine. In `sealed` mode the
 * password/PIN envelope is the only path that survives that, so a machine-only repository must be able to gain
 * one later -- with the same DEK, so every stored block stays readable.
 *
 * An `open` envelope is removed in the same write (the repository becomes `sealed`): leaving it would keep the
 * repository unlockable without the PIN the user just set.
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
  // Never write an `open` record beside a password envelope: the open path would win at unlock time.
  const baseEnvelopes = keys.envelopes.filter((envelope) => envelope?.kind !== OPEN_KIND);
  const upgraded = { ...keys, envelopes: [...baseEnvelopes, ...wrapped.envelopes] };
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
  // An account binding is a credential: writing it next to an `open` record would keep the repository
  // credential-less at unlock time, so the open record is removed in the same write (mode becomes `sealed`).
  const baseEnvelopes = keys.envelopes.filter((envelope) => envelope?.kind !== OPEN_KIND);
  const upgraded = {
    ...keys,
    envelopes: [...baseEnvelopes, ...wrapped.envelopes],
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
      encryption: keysEncryption(opened.keys),
      mode_after: keysEncryption(opened.keys),
      reason_code: error?.code ?? 'BACKUP_WRITE_FAILED',
      detail: error?.detail ?? String(error?.message ?? error),
    };
  }
  // A binding turns an open repository into a sealed one; keep the descriptor truthful (best effort).
  syncDescriptorEncryption(path.dirname(file), 'sealed');
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
      encryption: 'sealed',
      mode_after: 'sealed',
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
    encryption: 'sealed',
    mode_after: 'sealed',
    reason_code: null,
    detail: null,
  };
}

/**
 * Add a password/PIN envelope to a live repository (the "two unlock options" repair, and the upgrade path).
 *
 * Order matters: the existing repository is opened first (machine, an existing password, or no credential at all
 * when it is unencrypted), then the new envelope is wrapped around the **same** DEK, then the document is written
 * atomically after a sibling backup, then the new credential is verified by unwrapping it in isolation.
 *
 * **The PIN decision (docs/BACKUP-DESIGN.md §25).** A 4-6 digit PIN is the expected use, so the floor is
 * `MIN_PASSWORD_BYTES` (4) rather than 8. A short/all-digit password is accepted but reported `weak: true` with
 * `WEAK_PIN_WARNING`: the caller surfaces it, and the scrypt cost is *not* silently raised to pretend the PIN is
 * stronger than it is.
 *
 * **The public hint (`hint`, optional).** A forgotten PIN may carry a "备注提示词" ("周六生日"). It is stored in
 * `keys.json` at the root as `password_hint: {text, updated_at}` and is therefore **public metadata by design**:
 * anyone who can read the repository's keys file can read it, so it may only remind of the PIN, never be the PIN
 * (a hint equal to the PIN is refused, as are non-strings, empty values and anything over 120 characters). The
 * result reports it as `hint: {set, text?}` and `docs/BACKUP-DESIGN.md` §25.5 records where it is shown.
 *
 * **No rotation here.** When the repository already has a password envelope this function is a no-op
 * (`added: false`): the existing PIN keeps working and a supplied `hint` is **not** updated. Changing an existing
 * PIN is {@link rotatePassword} (`w2m-backup unlock --rotate-password`), which also replaces or clears the hint;
 * this function never replaces a credential because "add a PIN" and "change the PIN" are different promises.
 *
 * Adding a password to an `open` (unencrypted) repository removes the `open` record in the same write and
 * reports `mode_after: 'sealed'`; the descriptor is synced too. The repository then refuses credential-less
 * opens.
 *
 * @param {{
 *   root: string, dshHome: string, password: string|Buffer, hint?: string|null,
 *   platform?: string, runner?: Function, machineKey?: boolean, now?: Date, kdf?: object,
 *   backupDir?: string|null,
 * }} input
 * @returns {{ok: boolean, added: boolean, file: string|null, backup_file: string|null,
 *   envelopes: string[], weak: boolean, encryption: 'none'|'sealed'|null, mode_after: 'none'|'sealed'|null,
 *   hint: {set: boolean, text?: string}, warning: string|null, reason_code: string|null, detail: string|null}}
 */
export function setRepositoryPassword(input) {
  const bytes = Buffer.isBuffer(input.password) ? input.password : Buffer.from(String(input.password ?? ''), 'utf8');
  if (bytes.length < MIN_PASSWORD_BYTES) {
    return {
      ok: false,
      added: false,
      file: null,
      backup_file: null,
      envelopes: [],
      weak: false,
      encryption: null,
      mode_after: null,
      warning: null,
      hint: { set: false },
      reason_code: bytes.length === 0 ? CRYPTO_CODES.PASSWORD_EMPTY : NO_PERMISSION,
      detail:
        bytes.length === 0
          ? 'the unlock PIN/password is empty'
          : `the unlock PIN/password must be at least ${MIN_PASSWORD_BYTES} characters`,
    };
  }
  const weak = isWeakPassword(bytes);
  // Validate the PUBLIC hint before touching the repository: a rejected hint must not produce a write. The hint
  // is stored in clear in keys.json (by design), so it may remind of the PIN and may never be the PIN itself.
  let hintText = null;
  if (input.hint !== undefined && input.hint !== null) {
    const hintRefusal = (detail) => ({
      ok: false,
      added: false,
      file: null,
      backup_file: null,
      envelopes: [],
      weak,
      encryption: null,
      mode_after: null,
      hint: { set: false },
      warning: weak ? WEAK_PIN_WARNING : null,
      reason_code: KEYSTORE_CODES.HINT_INVALID,
      detail,
    });
    const normalized = normalizePasswordHint(input.hint);
    if (normalized === null) {
      return hintRefusal(
        typeof input.hint !== 'string'
          ? 'the hint must be a string: it is public metadata stored in keys.json, never a secret'
          : `the hint must be 1-${MAX_PASSWORD_HINT_LENGTH} characters after trimming whitespace`,
      );
    }
    if (normalized === bytes.toString('utf8')) {
      return hintRefusal('the hint must not be the PIN/password itself: it is stored in clear in keys.json');
    }
    hintText = normalized;
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
    return {
      ok: false,
      added: false,
      file: opened.file ?? null,
      backup_file: null,
      envelopes: [],
      weak,
      encryption: keysEncryption(opened.keys),
      mode_after: null,
      hint: passwordHintState(opened.keys),
      warning: weak ? WEAK_PIN_WARNING : null,
      reason_code: opened.reason_code,
      detail: opened.detail,
    };
  }
  const upgraded = addPasswordEnvelope(opened.keys, opened.dek, bytes, { now: input.now });
  if (upgraded.added !== true) {
    return {
      ok: true,
      added: false,
      file: opened.file,
      backup_file: null,
      envelopes: envelopeKinds(upgraded.keys),
      weak,
      encryption: keysEncryption(upgraded.keys),
      mode_after: keysEncryption(upgraded.keys),
      hint: passwordHintState(upgraded.keys),
      warning: weak ? WEAK_PIN_WARNING : null,
      reason_code: null,
      // No rotation by this function: an existing PIN (and its hint) is never replaced. Say so when a hint was
      // supplied, so no caller can believe the new text was stored, and name the command that DOES rotate.
      detail: hintText === null
        ? upgraded.reason
        : `${upgraded.reason}; the hint was not updated (setRepositoryPassword never replaces an existing PIN: use rotatePassword, i.e. w2m-backup unlock --rotate-password)`,
    };
  }
  const file = opened.file;
  const now = input.now ?? new Date();
  // The hint rides at the root of the same document, in the same atomic write as the envelope: a hint can never
  // exist without the PIN it describes (validateKeysFile enforces both halves).
  const hinted = hintText === null
    ? upgraded.keys
    : { ...upgraded.keys, password_hint: { text: hintText, updated_at: now.toISOString() } };
  if (hintText !== null) validateKeysFile(hinted);
  const hintedEnvelopes = envelopeKinds(hinted);
  const resultHint = passwordHintState(hinted);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupFile = input.backupDir ?? path.join(path.dirname(file), 'keys.json.bak-' + stamp);
  try {
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(file, backupFile);
    writeFileAtomic(file, JSON.stringify(hinted));
  } catch (error) {
    return {
      ok: false,
      added: false,
      file,
      backup_file: backupFile,
      envelopes: envelopeKinds(opened.keys),
      weak,
      encryption: keysEncryption(opened.keys),
      mode_after: keysEncryption(opened.keys),
      hint: passwordHintState(opened.keys),
      warning: weak ? WEAK_PIN_WARNING : null,
      reason_code: error?.code ?? 'BACKUP_WRITE_FAILED',
      detail: error?.detail ?? String(error?.message ?? error),
    };
  }
  // The descriptor records the mode; the key document is authoritative, so this is a best-effort sync.
  syncDescriptorEncryption(path.dirname(file), 'sealed');
  // The point of the write: the new credential alone must open the same DEK.
  let verify = null;
  try {
    verify = unwrapDek(hinted, { password: bytes });
  } catch {
    verify = null;
  }
  const modeAfter = keysEncryption(hinted);
  if (verify === null || Buffer.isBuffer(verify.dek) !== true || verify.dek.equals(opened.dek) !== true) {
    return {
      ok: false,
      added: true,
      file,
      backup_file: backupFile,
      envelopes: hintedEnvelopes,
      weak,
      encryption: modeAfter,
      mode_after: modeAfter,
      hint: resultHint,
      warning: weak ? WEAK_PIN_WARNING : null,
      reason_code: NO_PERMISSION,
      detail: 'the written password envelope did not verify against the data key',
    };
  }
  return {
    ok: true,
    added: true,
    file,
    backup_file: backupFile,
    envelopes: hintedEnvelopes,
    weak,
    encryption: modeAfter,
    mode_after: modeAfter,
    hint: resultHint,
    warning: weak ? WEAK_PIN_WARNING : null,
    reason_code: null,
    detail: null,
  };
}

/**
 * Rotate the repository PIN: replace every `password` envelope with one new envelope around the same data key.
 *
 * The case this exists for: a repository seeded with a PIN whose value is known wrong (leaked, forgotten-and-
 * re-derived, or just wanted changed) had no way out except deleting the repository -- and a repository created
 * offline has no machine envelope to fall back on. Rotation keeps the **DEK unchanged**, so every stored block
 * stays readable; only the credential path is rewritten.
 *
 * Order, and why it is this order:
 *
 *   1. open the repository with a credential that already works -- `machine`, a matching `account`, or
 *      `oldPassword` if the caller supplied it (the injected order is `openRepoKey`'s: account, machine, password).
 *      Without any working credential this is refused with `BACKUP_NO_PERMISSION`: rotation must never be a way to
 *      "claim" a repository, and it must not create one. A repository with no key document is refused too.
 *   2. refuse `BACKUP_NO_PASSWORD_ENVELOPE` when there is no `password` envelope to replace: rotation changes a
 *      PIN, it never adds one (`--set-password` does that).
 *   3. copy `keys.json` to `keys.json.bak-<ts>`, then write atomically: every old `password` envelope is removed,
 *      exactly one new one (same DEK, scrypt, the existing KDF floor) is added, and `password_hint` is replaced by
 *      the new hint -- or dropped when `hint` is null/omitted. A hint never appends and never nests.
 *   4. verify **both ways** against the document re-read from disk: (a) the new PIN alone unwraps the DEK; (b) the
 *      old PIN alone does not (and no pre-rotation password envelope survived). If either check fails the backup is
 *      copied back over `keys.json` and the call returns `BACKUP_ROTATION_VERIFY_FAILED`, so a failed rotation can
 *      never leave a document in which the old PIN still works.
 *
 * Result: `{ok, rotated: true, mode_after: 'sealed', envelopes, backup_file, hint, weak, old_password_still_opens:
 * false, ...}`. Existing machine/account envelopes are preserved untouched; only the password path is rewritten.
 *
 * @param {{
 *   root: string, dshHome: string, newPassword: string|Buffer, hint?: string|null,
 *   oldPassword?: string|Buffer|null, accountId?: string|null, platform?: string, runner?: Function,
 *   machineKey?: boolean, now?: Date, kdf?: object,
 *   unwrap?: Function,
 * }} input `kdf` overrides the new envelope's scrypt parameters (tests); `unwrap` is a test seam for the
 *   post-write verification (production omits it and uses `crypto.unwrapDek`).
 * @returns {{ok: boolean, rotated: boolean, file: string|null, backup_file: string|null,
 *   envelopes: string[], weak: boolean, encryption: 'none'|'sealed'|null,
 *   mode_after: 'none'|'sealed'|null, hint: {set: boolean, text: string|null},
 *   warning: string|null, old_password_still_opens: boolean|null, restored: boolean,
 *   reason_code: string|null, detail: string|null}}
 */
export function rotatePassword(input) {
  const newBytes = Buffer.isBuffer(input?.newPassword)
    ? input.newPassword
    : Buffer.from(String(input?.newPassword ?? ''), 'utf8');
  const weak = isWeakPassword(newBytes);
  /** Every refusal shares the success shape, so a caller never has to guess which fields exist. */
  const failed = (reasonCode, detail, extra = {}) => ({
    ...extra,
    ok: false,
    rotated: false,
    file: extra.file ?? null,
    backup_file: extra.backup_file ?? null,
    envelopes: extra.envelopes ?? [],
    weak,
    encryption: extra.encryption ?? null,
    mode_after: extra.mode_after ?? null,
    hint: extra.hint ?? { set: false, text: null },
    warning: weak ? WEAK_PIN_WARNING : null,
    old_password_still_opens: extra.old_password_still_opens ?? null,
    restored: extra.restored === true,
    reason_code: reasonCode,
    detail,
  });
  if (newBytes.length < MIN_PASSWORD_BYTES) {
    return failed(
      newBytes.length === 0 ? CRYPTO_CODES.PASSWORD_EMPTY : NO_PERMISSION,
      newBytes.length === 0
        ? 'the new unlock PIN/password is empty'
        : `the new unlock PIN/password must be at least ${MIN_PASSWORD_BYTES} characters`,
    );
  }
  // Validate the PUBLIC hint before touching the repository: a rejected hint must not produce a write. An omitted
  // or null `hint` is the documented "drop the old hint" request, not an error.
  let hintText = null;
  if (input.hint !== undefined && input.hint !== null) {
    const normalized = normalizePasswordHint(input.hint);
    if (normalized === null) {
      return failed(
        KEYSTORE_CODES.HINT_INVALID,
        typeof input.hint !== 'string'
          ? 'the hint must be a string: it is public metadata stored in keys.json, never a secret'
          : `the hint must be 1-${MAX_PASSWORD_HINT_LENGTH} characters after trimming whitespace`,
      );
    }
    if (normalized === newBytes.toString('utf8')) {
      return failed(
        KEYSTORE_CODES.HINT_INVALID,
        'the hint must not be the new PIN/password itself: it is stored in clear in keys.json',
      );
    }
    hintText = normalized;
  }
  // Read the document first: `openRepoKey` creates a repository on first use, and a rotation must never create
  // one. A missing/corrupt key document is a named refusal, not a reason to mint a fresh DEK.
  const existing = readRepoKeys(input.root);
  if (existing.ok !== true) {
    const code = existing.reason === 'missing' ? LAYOUT_CODES.NOT_A_REPO : KEYSTORE_CODES.CORRUPT;
    return failed(
      code,
      existing.reason === 'missing'
        ? `${existing.file} does not exist; there is no repository to rotate`
        : String(existing.detail),
      { file: existing.file, hint: passwordHintState(existing.keys) },
    );
  }
  const oldBytes = passwordBytes(input.oldPassword);
  if (oldBytes !== null && oldBytes.equals(newBytes)) {
    // Re-wrapping under the same secret cannot satisfy the post-write check (the "old" PIN would still open it).
    // Refuse before the write instead of writing a document and then restoring it.
    return failed(
      KEYSTORE_CODES.ROTATION_VERIFY_FAILED,
      'the new PIN is identical to the old PIN: the old PIN would still open the repository; choose a different PIN',
      { file: existing.file, hint: passwordHintState(existing.keys) },
    );
  }
  const opened = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    accountId: input.accountId ?? null,
    password: oldBytes,
    platform: input.platform,
    runner: input.runner,
    machineKey: input.machineKey,
    now: input.now,
    kdf: input.kdf,
  });
  if (opened.ok !== true) {
    return failed(
      NO_PERMISSION,
      'rotate needs a working credential: run it on the machine that can open the repository, or pass the old PIN ' +
        `(${opened.reason_code}: ${opened.detail ?? 'the repository could not be opened'})`,
      {
        file: opened.file ?? existing.file,
        envelopes: envelopeKinds(opened.keys),
        encryption: keysEncryption(opened.keys),
        mode_after: keysEncryption(opened.keys),
        hint: passwordHintState(opened.keys),
      },
    );
  }
  const oldPasswordEnvelopes = opened.keys.envelopes.filter((envelope) => envelope?.kind === 'password');
  if (oldPasswordEnvelopes.length === 0) {
    return failed(
      KEYSTORE_CODES.NO_PASSWORD_ENVELOPE,
      'this repository has no password/PIN envelope to rotate: add one with w2m-backup unlock --set-password ' +
        '(rotation replaces an existing PIN; it never adds one)',
      {
        file: opened.file,
        envelopes: envelopeKinds(opened.keys),
        encryption: keysEncryption(opened.keys),
        mode_after: keysEncryption(opened.keys),
        hint: passwordHintState(opened.keys),
      },
    );
  }
  const now = input.now ?? new Date();
  const { password_hint: _previousHint, ...base } = opened.keys;
  let next;
  try {
    const wrapped = wrapDek(opened.dek, [{ kind: 'password', secret: newBytes }], {
      now,
      ...(input.kdf === undefined ? {} : { kdf: input.kdf }),
    });
    next = {
      ...base,
      envelopes: [
        ...base.envelopes.filter((envelope) => envelope?.kind !== 'password'),
        ...wrapped.envelopes,
      ],
    };
    if (hintText !== null) next.password_hint = { text: hintText, updated_at: now.toISOString() };
    validateKeysFile(next);
  } catch (error) {
    return failed(error?.code ?? KEYSTORE_CODES.CORRUPT, error?.detail ?? String(error?.message ?? error), {
      file: opened.file,
      envelopes: envelopeKinds(opened.keys),
      encryption: keysEncryption(opened.keys),
      mode_after: keysEncryption(opened.keys),
      hint: passwordHintState(opened.keys),
    });
  }
  const file = opened.file;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupFile = path.join(path.dirname(file), 'keys.json.bak-' + stamp);
  try {
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(file, backupFile);
    writeFileAtomic(file, JSON.stringify(next));
  } catch (error) {
    return failed(error?.code ?? 'BACKUP_WRITE_FAILED', error?.detail ?? String(error?.message ?? error), {
      file,
      backup_file: backupFile,
      envelopes: envelopeKinds(opened.keys),
      encryption: keysEncryption(opened.keys),
      mode_after: keysEncryption(opened.keys),
      hint: passwordHintState(opened.keys),
    });
  }
  // Verify both ways against the document re-read from disk, not the in-memory copy: a write that produced
  // something other than `next` must not pass. `input.unwrap` is the documented test seam that lets a test prove
  // the restore path; production omits it and uses the real `unwrapDek`.
  const unwrap = typeof input.unwrap === 'function' ? input.unwrap : unwrapDek;
  const written = readRepoKeys(input.root);
  const writtenKeys = written.ok === true ? written.keys : next;
  let newPinOpens = false;
  try {
    const verified = unwrap(writtenKeys, { password: newBytes });
    newPinOpens = verified !== null && typeof verified === 'object'
      && Buffer.isBuffer(verified.dek) && verified.dek.equals(opened.dek);
  } catch {
    newPinOpens = false;
  }
  let oldPinOpens = false;
  if (oldBytes !== null) {
    try {
      const verified = unwrap(writtenKeys, { password: oldBytes });
      oldPinOpens = verified !== null && typeof verified === 'object'
        && Buffer.isBuffer(verified.dek) && verified.dek.equals(opened.dek);
    } catch {
      oldPinOpens = false;
    }
  }
  // Structural half, always available: no password envelope record from before the write may survive. This is what
  // makes `old_password_still_opens: false` a statement even when the caller could not supply the old PIN -- there
  // is no envelope left that the old PIN could unwrap (the same-PIN case was refused before the write).
  const survivingOldEnvelope = (writtenKeys.envelopes ?? []).some((currentEnvelope) => currentEnvelope?.kind === 'password'
    && oldPasswordEnvelopes.some((previousEnvelope) => previousEnvelope?.kdf?.salt === currentEnvelope?.kdf?.salt
      && previousEnvelope?.sealed?.tag === currentEnvelope?.sealed?.tag));
  if (newPinOpens !== true || oldPinOpens === true || survivingOldEnvelope === true) {
    let restored = false;
    try {
      fs.copyFileSync(backupFile, file);
      restored = true;
    } catch {
      restored = false;
    }
    let detail;
    if (newPinOpens !== true) detail = 'the written password envelope did not open the data key with the new PIN';
    else if (oldPinOpens === true) detail = 'the old PIN still opened the written document';
    else detail = 'a pre-rotation password envelope survived the write';
    detail += restored
      ? `; keys.json was restored from ${backupFile}`
      : `; the restore from ${backupFile} FAILED -- inspect keys.json before trusting this repository`;
    return failed(KEYSTORE_CODES.ROTATION_VERIFY_FAILED, detail, {
      file,
      backup_file: backupFile,
      envelopes: envelopeKinds(opened.keys),
      encryption: keysEncryption(opened.keys),
      mode_after: keysEncryption(opened.keys),
      hint: passwordHintState(opened.keys),
      old_password_still_opens: oldBytes === null ? false : oldPinOpens,
      surviving_old_envelope: survivingOldEnvelope === true,
      restored,
    });
  }
  // The key document is authoritative and was already sealed, so this only repairs pre-existing descriptor drift.
  syncDescriptorEncryption(path.dirname(file), 'sealed');
  return {
    ok: true,
    rotated: true,
    file,
    backup_file: backupFile,
    envelopes: envelopeKinds(writtenKeys),
    weak,
    encryption: keysEncryption(writtenKeys),
    mode_after: keysEncryption(writtenKeys),
    hint: passwordHintState(writtenKeys),
    warning: weak ? WEAK_PIN_WARNING : null,
    old_password_still_opens: false,
    restored: false,
    reason_code: null,
    detail: null,
  };
}

/**
 * Turn repository protection off (or refuse to pretend it can be turned on without a credential).
 *
 * The user asked for this option explicitly (2026-11-17): a 4-6 digit PIN is convenience, and some repositories
 * do not need even that. The conversion is safe and small because the block format is unchanged: open the
 * repository with the credentials it already has, write an `open` envelope carrying the **same** DEK, copy the
 * old `keys.json` to `keys.json.bak-<ts>`, write atomically, then verify by unwrapping with **no credential at
 * all**. Existing blocks stay readable (the DEK did not change).
 *
 * `mode: 'sealed'` is refused with a pointer to `setRepositoryPassword`: sealing without a credential would
 * produce a repository nobody can open, and this function deliberately cannot invent a password.
 *
 * @param {{root: string, dshHome: string, mode: 'none'|'sealed', password?: string|Buffer|null,
 *   accountId?: string|null, platform?: string, runner?: Function, machineKey?: boolean,
 *   now?: Date, kdf?: object, backupDir?: string|null}} input
 * @returns {{ok: boolean, changed: boolean, file: string|null, backup_file: string|null,
 *   encryption: 'none'|'sealed'|null, mode_before: 'none'|'sealed'|null, mode_after: 'none'|'sealed'|null,
 *   envelopes: string[], warning: string|null, reason_code: string|null, detail: string|null}}
 */
export function setEncryptionMode(input) {
  const mode = input?.mode ?? null;
  const failed = (reason_code, detail, extra = {}) => ({
    ok: false,
    changed: false,
    file: null,
    backup_file: null,
    encryption: null,
    mode_before: null,
    mode_after: null,
    envelopes: [],
    warning: null,
    reason_code,
    detail,
    ...extra,
  });
  if (!REPO_ENCRYPTION_MODES.includes(mode)) {
    return failed(ENCRYPTION_INVALID, `mode must be one of ${REPO_ENCRYPTION_MODES.join(', ')}, got ${JSON.stringify(String(mode))}`);
  }
  if (mode === 'sealed') {
    return failed(NO_PERMISSION, 'turning protection on needs a password/PIN: use setRepositoryPassword (w2m-backup unlock --enable-protection --password-stdin)');
  }
  const existing = readRepoKeys(input.root);
  if (existing.ok !== true) {
    const code = existing.reason === 'missing' ? LAYOUT_CODES.NOT_A_REPO : KEYSTORE_CODES.CORRUPT;
    return failed(code, existing.reason === 'missing' ? `${existing.file} does not exist; there is no repository to change` : String(existing.detail), { file: existing.file });
  }
  const modeBefore = keysEncryption(existing.keys);
  if (modeBefore === 'none') {
    return {
      ok: true,
      changed: false,
      file: existing.file,
      backup_file: null,
      encryption: 'none',
      mode_before: 'none',
      mode_after: 'none',
      envelopes: envelopeKinds(existing.keys),
      warning: UNENCRYPTED_WARNING,
      reason_code: null,
      detail: 'protection is already off',
    };
  }
  // The repository already has a credential (machine/account/password); the caller supplies what this machine
  // can. `openRepoKey` refuses when nothing works, which is the right outcome: never silently lose the key.
  const opened = openRepoKey({
    root: input.root,
    dshHome: input.dshHome,
    accountId: input.accountId ?? null,
    password: input.password ?? null,
    platform: input.platform,
    runner: input.runner,
    machineKey: input.machineKey,
    now: input.now,
    kdf: input.kdf,
  });
  if (opened.ok !== true) {
    return failed(opened.reason_code, opened.detail, { file: existing.file, mode_before: modeBefore });
  }
  const file = opened.file;
  const converted = addOpenEnvelope({ ...opened.keys, envelopes: [] }, opened.dek, { now: input.now ?? new Date() });
  if (converted.added !== true) {
    return failed(KEYSTORE_CODES.CORRUPT, converted.reason, { file, mode_before: modeBefore });
  }
  const stamp = (input.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupFile = input.backupDir ?? path.join(path.dirname(file), 'keys.json.bak-' + stamp);
  try {
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(file, backupFile);
    writeFileAtomic(file, JSON.stringify(converted.keys));
  } catch (error) {
    return failed(error?.code ?? 'BACKUP_WRITE_FAILED', error?.detail ?? String(error?.message ?? error), { file, backup_file: backupFile, mode_before: modeBefore });
  }
  const synced = syncDescriptorEncryption(path.dirname(file), 'none');
  // The point of the write: the repository must now open with no credential at all.
  let verify = null;
  try {
    verify = unwrapDek(converted.keys, {});
  } catch {
    verify = null;
  }
  if (verify === null || Buffer.isBuffer(verify.dek) !== true || verify.dek.equals(opened.dek) !== true) {
    return failed(NO_PERMISSION, 'the written open envelope did not verify without a credential', {
      file,
      backup_file: backupFile,
      encryption: keysEncryption(converted.keys),
      mode_before: modeBefore,
      mode_after: keysEncryption(converted.keys),
      envelopes: envelopeKinds(converted.keys),
      descriptor_synced: synced.ok === true && synced.changed === true,
    });
  }
  return {
    ok: true,
    changed: true,
    file,
    backup_file: backupFile,
    encryption: 'none',
    mode_before: modeBefore,
    mode_after: 'none',
    envelopes: envelopeKinds(converted.keys),
    warning: UNENCRYPTED_WARNING,
    reason_code: null,
    detail: null,
    descriptor_synced: synced.ok === true && synced.changed === true,
  };
}

/**
 * Open the repository key, creating it on first use.
 *
 * The credential order for a **sealed** repository is the protocol's (`crypto.unwrapDek`): `account`,
 * `machine`, `password`. The account credential is supplied only when the caller passed an account id **and**
 * the repository's recorded binding matches it; a mismatch is not a wrong-key attempt, it is recorded as
 * `BACKUP_ACCOUNT_MISMATCH` and the unlock continues to the machine/password paths (the user's rule: mismatch
 * -> switch to password mode).
 *
 * The protection mode is decided as follows:
 *
 *   * an existing key document decides by its envelopes: `open` means `none`, and **no credential and no OS
 *     keystore probe happen**; anything else means `sealed`;
 *   * a first use resolves the mode through {@link resolveEncryptionMode}: explicit `encryption` first, then
 *     password / `machineKey: true` / account id -> `sealed`, otherwise `none`. A descriptor that already says
 *     `sealed` is never silently downgraded to `none` (a half-initialised sealed repository must not become
 *     unencrypted because the next run happened to carry no credential).
 *
 * Result objects never carry the DEK in a string field; `dek` is the internal Buffer callers use to seal
 * objects. `unlocked_via` is `'none'` for an unencrypted repository.
 *
 * @param {{
 *   root: string,
 *   dshHome: string,
 *   accountId?: string|null,
 *   password?: string|Buffer|null,
 *   encryption?: 'none'|'sealed',
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
 *   encryption: 'none'|'sealed'|null,
 *   available_paths: string[],
 *   machine: object,
 *   account: {bound: boolean, matched: boolean|null, id_hint: string|null},
 *   attempts: Array<object>,
 *   machine_envelope_added: boolean,
 *   reason_code: string|null,
 *   detail: string|null
 * }}
 */
export function openRepoKey(input) {
  const file = repoKeysPath(input.root);
  const platform = input.platform ?? process.platform;
  const password = passwordBytes(input.password);
  const accountId = normalizeAccountId(input.accountId ?? null);
  const existing = readRepoKeys(input.root);

  if (existing.ok === true) {
    const encryption = keysEncryption(existing.keys);
    if (encryption === 'none') {
      // The repository is explicitly unencrypted: no credential is consulted, and the OS keystore is not even
      // loaded (loading it would create a machine.key file nobody asked for).
      syncDescriptorEncryption(path.dirname(file), 'none');
      const opened = unwrapDek(existing.keys, {});
      return {
        ok: true,
        dek: opened.dek,
        keys: existing.keys,
        file,
        created: false,
        unlocked_via: 'none',
        encryption: 'none',
        available_paths: ['none'],
        machine: machineStateSkipped(input, 'repository-is-unencrypted'),
        account: accountBindingState(existing.keys, accountId),
        attempts: opened.attempts,
        machine_envelope_added: false,
        reason_code: null,
        detail: null,
      };
    }
    const machine = input.machineKey === false ? machineStateDisabled(input) : loadMachineSecret({ dshHome: input.dshHome, platform, runner: input.runner, now: input.now });
    const bound = boundAccountId(existing.keys);
    const hasAccountEnvelope = existing.keys.envelopes.some((envelope) => envelope?.kind === 'account');
    // Compare-only: the recorded id is the authority. `bound === null` with an account envelope is a file this
    // build cannot compare (no metadata); it is still attempted so such a repository remains openable, but the
    // result reports `matched: null` rather than pretending the comparison happened.
    const mismatch = bound !== null && accountId !== null && bound !== accountId;
    const accountSecret = accountId !== null && mismatch !== true && (bound !== null || hasAccountEnvelope)
      ? accountBindingSecret(accountId)
      : null;
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
      syncDescriptorEncryption(path.dirname(file), 'sealed');
      return {
        ok: true,
        dek: opened.dek,
        keys,
        file,
        created: false,
        unlocked_via: opened.kind,
        encryption: 'sealed',
        available_paths: availablePaths(keys),
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
        encryption: 'sealed',
        available_paths: availablePaths(existing.keys),
        machine,
        account: accountBindingState(existing.keys, accountId),
        attempts: decorateAccountAttempts(error?.attempts ?? [], mismatch),
        machine_envelope_added: false,
        reason_code: KEYSTORE_CODES.NO_PERMISSION,
        detail:
          'this repository cannot be opened with the credentials available on this machine: ' +
          'sign in on the machine that created it, or supply the unlock PIN/password',
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
      encryption: null,
      available_paths: [],
      machine: machineStateSkipped(input, 'key-document-unreadable'),
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: KEYSTORE_CODES.CORRUPT,
      detail: `${existing.file}: ${existing.reason}${existing.detail === null ? '' : ` (${existing.detail})`}`,
    };
  }

  // First use: resolve the mode, then mint the DEK and write exactly what that mode needs.
  const resolved = resolveEncryptionMode(input);
  if (resolved.ok !== true) {
    return {
      ok: false,
      dek: null,
      keys: null,
      file,
      created: false,
      unlocked_via: null,
      encryption: null,
      available_paths: [],
      machine: machineStateSkipped(input, 'mode-refused'),
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: resolved.reason_code,
      detail: resolved.detail,
    };
  }
  let descriptor = null;
  try {
    descriptor = readDescriptor(input.root);
  } catch {
    descriptor = null;
  }
  const explicitMode = input.encryption === undefined ? null : input.encryption;
  const mode = explicitMode ?? (descriptorEncryption(descriptor) === 'sealed' ? 'sealed' : resolved.mode);
  const machine = mode === 'none'
    ? machineStateSkipped(input, 'repository-is-unencrypted')
    : (input.machineKey === false ? machineStateDisabled(input) : loadMachineSecret({ dshHome: input.dshHome, platform, runner: input.runner, now: input.now }));
  const now = input.now ?? new Date();

  if (mode === 'none') {
    const dek = randomDek();
    const keys = wrapOpenDek(dek, { now });
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
        encryption: null,
        available_paths: [],
        machine,
        account: accountBindingState(null, accountId),
        attempts: [],
        machine_envelope_added: false,
        reason_code: error?.code ?? KEYSTORE_CODES.CORRUPT,
        detail: error?.detail ?? String(error?.message ?? error),
      };
    }
    syncDescriptorEncryption(path.dirname(file), 'none');
    return {
      ok: true,
      dek,
      keys,
      file,
      created: true,
      unlocked_via: 'none',
      encryption: 'none',
      available_paths: ['none'],
      machine,
      account: accountBindingState(keys, accountId),
      attempts: [{ kind: OPEN_KIND, ok: true, code: null }],
      machine_envelope_added: false,
      reason_code: null,
      detail: null,
    };
  }

  const envelopes = [];
  if (machine.ok === true) envelopes.push({ kind: 'machine', secret: machine.secret });
  if (password !== null) envelopes.push({ kind: 'password', secret: password });
  if (envelopes.length === 0) {
    return {
      ok: false,
      dek: null,
      keys: null,
      file,
      created: false,
      unlocked_via: null,
      encryption: null,
      available_paths: [],
      machine,
      // A first use never creates an account-only repository: the binding is added after a run that already has
      // a real credential, so an account id alone can never be the reason a repository exists.
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: KEYSTORE_CODES.NO_PERMISSION,
      detail:
        'encryption "sealed" was requested, but no credential can protect a new backup on this machine: ' +
        `the OS keystore is unavailable (${machine.reason ?? 'unknown'}) and no unlock PIN/password was supplied`,
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
      encryption: null,
      available_paths: [],
      machine,
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: CRYPTO_CODES.KDF_WEAK,
      detail: `scrypt N=${kdf.N} is below the floor N=${MIN_SCRYPT.N}`,
    };
  }
  const dek = randomDek();
  const keys = wrapDek(dek, envelopes, { now, kdf });
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
      encryption: null,
      available_paths: [],
      machine,
      account: accountBindingState(null, accountId),
      attempts: [],
      machine_envelope_added: false,
      reason_code: error?.code ?? KEYSTORE_CODES.CORRUPT,
      detail: error?.detail ?? String(error?.message ?? error),
    };
  }
  syncDescriptorEncryption(path.dirname(file), 'sealed');
  return {
    ok: true,
    dek,
    keys,
    file,
    created: true,
    unlocked_via: machine.ok === true ? 'machine' : 'password',
    encryption: 'sealed',
    available_paths: availablePaths(keys),
    machine,
    account: accountBindingState(keys, accountId),
    attempts: [],
    machine_envelope_added: false,
    reason_code: null,
    detail: null,
  };
}
