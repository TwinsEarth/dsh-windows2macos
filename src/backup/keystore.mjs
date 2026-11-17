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
 *   * `password` -- scrypt; the only path that survives a new machine.
 *
 * `account` stays an unwritten kind on purpose: `docs/SPIKE-ACCOUNT-KEK.md` measured that the host gives an
 * account *identifier*, not a secret, and deriving a key from an identifier is not confidentiality.
 *
 * ## Refusing to write an unopenable backup
 *
 * If neither credential is available, the run is refused before a single block is written
 * (`BACKUP_NO_PERMISSION`). Writing a repository nobody can open is worse than not writing one.
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
import { writeJsonAtomic } from './atomic.mjs';
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
});

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
 * Open the repository key, creating it on first use.
 *
 * @param {{
 *   root: string,
 *   dshHome: string,
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
  const existing = readRepoKeys(input.root);

  if (existing.ok === true) {
    const credentials = {
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
        machine_envelope_added: machineEnvelopeAdded,
        attempts: opened.attempts,
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
        attempts: error?.attempts ?? [],
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
    attempts: [],
    machine_envelope_added: false,
    reason_code: null,
    detail: null,
  };
}
