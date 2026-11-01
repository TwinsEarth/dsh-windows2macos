/**
 * Per-account fleet homes: the local answer to "which fleet was this machine in last time it was
 * signed in to this account?"
 *
 * # Why a file, and why this file
 *
 * The account-derived key is deterministic, but it is not a complete history. A fleet can have
 * been created with an explicit key, or before account-derived keys existed, and the derived key
 * then points at a different (new) fleet. Replacing the old key on every account switch is what
 * made one machine's sign-in move the whole fleet -- v2.2.0's `fleetKeyPolicy: account`.
 *
 * The home map is deliberately **per account**: switching from A to B does not erase A's home, so
 * switching back to A returns to A's fleet instead of minting another one. It is written beside
 * `device.json` (same directory, same permissions concerns) and contains encoded fleet keys, which
 * are credentials: the file is 0600 where the platform honours it.
 *
 * # Failure policy
 *
 * `readFleetHome` never silently treats a corrupt file as "no homes". A machine in `home` policy
 * that cannot read its history must stay unbound and report the fault rather than derive a new key
 * and create a new fleet -- that automatic migration is the behaviour this module exists to stop.
 * The caller decides whether to block (home policy) or continue without the history (account
 * policy).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The file beside `device.json`; the basename is part of the operator-visible contract. */
export const FLEET_HOME_FILE = 'fleet-home.json';

/** Bump only with a reader that still understands the previous shape. */
export const FLEET_HOME_VERSION = 1;

const ACCOUNT_CODE_RE = /^[0-9a-f]{8}$/;
const MAX_KEY_LENGTH = 4096;
const MAX_ACCOUNTS = 64;

/**
 * @param {string|null} deviceFile Absolute path of `device.json`, or null when unknown.
 * @returns {string|null} The path of the home file, or null when there is no state directory.
 */
export function fleetHomePath(deviceFile) {
  return typeof deviceFile === 'string' && deviceFile !== '' ? join(dirname(deviceFile), FLEET_HOME_FILE) : null;
}

/**
 * Read the map. Missing file means "no history yet", which is a success, not an error.
 *
 * @param {string|null} file
 * @returns {{ok: true, homes: Record<string, {fleet_key: string, updated_at: string}>, lastAccount: string|null, path: string|null}
 *   | {ok: false, code: string, error: string, path: string|null}}
 */
export function readFleetHome(file) {
  if (file === null || file === undefined || file === '') return { ok: true, homes: {}, lastAccount: null, path: null };
  if (!existsSync(file)) return { ok: true, homes: {}, lastAccount: null, path: file };

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      code: 'FLEET_HOME_UNREADABLE',
      error: error instanceof Error ? error.message : String(error),
      path: file,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      code: 'FLEET_HOME_CORRUPT',
      error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      path: file,
    };
  }
  if (parsed === null || typeof parsed !== 'object'
    || parsed.version !== FLEET_HOME_VERSION
    || parsed.homes === null || typeof parsed.homes !== 'object' || Array.isArray(parsed.homes)) {
    return {
      ok: false,
      code: 'FLEET_HOME_CORRUPT',
      error: `expected {version: ${FLEET_HOME_VERSION}, homes: {…}}`,
      path: file,
    };
  }

  const homes = {};
  for (const [accountCode, entry] of Object.entries(parsed.homes)) {
    if (!ACCOUNT_CODE_RE.test(accountCode)) {
      return { ok: false, code: 'FLEET_HOME_CORRUPT', error: `bad account code ${accountCode}`, path: file };
    }
    if (entry === null || typeof entry !== 'object'
      || typeof entry.fleet_key !== 'string' || entry.fleet_key === ''
      || entry.fleet_key.length > MAX_KEY_LENGTH) {
      return { ok: false, code: 'FLEET_HOME_CORRUPT', error: `bad home for ${accountCode}`, path: file };
    }
    homes[accountCode] = {
      fleet_key: entry.fleet_key,
      updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : '',
    };
  }
  if (Object.keys(homes).length > MAX_ACCOUNTS) {
    return { ok: false, code: 'FLEET_HOME_CORRUPT', error: `more than ${MAX_ACCOUNTS} account homes`, path: file };
  }
  const lastAccount = typeof parsed.last_account === 'string' && ACCOUNT_CODE_RE.test(parsed.last_account)
    ? parsed.last_account
    : null;
  return { ok: true, homes, lastAccount, path: file };
}

/**
 * @param {Record<string, {fleet_key: string}>} homes
 * @param {string|null} accountCode
 * @returns {{fleet_key: string, updated_at: string}|null}
 */
export function getFleetHome(homes, accountCode) {
  if (typeof accountCode !== 'string' || !ACCOUNT_CODE_RE.test(accountCode)) return null;
  const entry = homes?.[accountCode];
  return entry !== undefined && typeof entry.fleet_key === 'string' && entry.fleet_key !== '' ? entry : null;
}

/**
 * Should a machine with an existing token and no recorded home stay exactly where it is?
 *
 * This is the migration guard for 2.2.0 -> 2.2.1. Such a machine may be sitting in an old fleet
 * whose key no longer exists in its profile; deriving the account key at that moment is precisely
 * how an upgrade would move it (and, if the account is shared, tempt everyone else to follow).
 * Staying put and reporting "no home key" is recoverable; silently re-pairing is not.
 *
 * A configured key is excluded: it is the operator's explicit seed and is used instead of the
 * account key. A fresh, unpaired machine is excluded too: it has no fleet to preserve.
 *
 * @param {{policy?: string, hasHome?: boolean, hasConfiguredKey?: boolean, hasToken?: boolean,
 *   accountChanged?: boolean}} input
 * @returns {boolean}
 */
export function shouldPreserveExistingFleet({
  policy = 'home',
  hasHome = false,
  hasConfiguredKey = false,
  hasToken = false,
  accountChanged = false,
} = {}) {
  return policy === 'home'
    && hasHome !== true
    && hasConfiguredKey !== true
    && hasToken === true
    && accountChanged !== true;
}

/**
 * Write the complete state atomically. Internal: callers have already validated what they add.
 *
 * @param {string} file
 * @param {{homes: Record<string, {fleet_key: string, updated_at: string}>, lastAccount: string|null}} state
 * @returns {{ok: true, path: string}|{ok: false, code: string, error: string, path: string|null}}
 */
function writeFleetState(file, state) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({
      version: FLEET_HOME_VERSION,
      last_account: state.lastAccount,
      homes: state.homes,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try { chmodSync(tmp, 0o600); } catch { /* Windows: the file ACL carries the protection */ }
    try {
      renameSync(tmp, file);
    } catch {
      // Windows can refuse to replace a file that another handle has open. The old file is gone
      // only after the copy exists, so this fallback cannot turn a failed write into no file.
      rmSync(file, { force: true });
      renameSync(tmp, file);
    }
    return { ok: true, path: file };
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return {
      ok: false,
      code: 'FLEET_HOME_WRITE_FAILED',
      error: error instanceof Error ? error.message : String(error),
      path: file,
    };
  }
}

/**
 * Remember one account's fleet key. Other accounts are preserved verbatim, and the last account
 * that successfully bound is recorded so a restart can tell "same account, no home yet" apart from
 * "the account actually changed".
 *
 * The write is temp-file + rename in the same directory, so a crash leaves either the old complete
 * map or the new complete map. A corrupt existing map is **not** overwritten: silently replacing a
 * history we cannot parse is how the recovery data would be lost exactly when it is needed.
 *
 * @param {string|null} file
 * @param {{accountCode: string, fleetKey: string, lastAccount?: string|null, now?: number}} input
 * @returns {{ok: true, path: string}|{ok: false, code: string, error: string, path: string|null}}
 */
export function rememberFleetHome(file, input) {
  if (file === null || file === undefined || file === '') {
    return { ok: false, code: 'FLEET_HOME_NO_PATH', error: 'no state directory is known', path: null };
  }
  const accountCode = typeof input?.accountCode === 'string' ? input.accountCode : '';
  if (!ACCOUNT_CODE_RE.test(accountCode)) {
    return { ok: false, code: 'FLEET_HOME_BAD_ACCOUNT', error: 'account code is not 8 hex characters', path: file };
  }
  const fleetKey = typeof input?.fleetKey === 'string' ? input.fleetKey : '';
  if (fleetKey === '' || fleetKey.length > MAX_KEY_LENGTH) {
    return { ok: false, code: 'FLEET_HOME_BAD_KEY', error: 'fleet key is empty or too long', path: file };
  }
  const previous = readFleetHome(file);
  if (previous.ok !== true) return previous;
  const homes = {
    ...previous.homes,
    [accountCode]: {
      fleet_key: fleetKey,
      updated_at: new Date(Number.isInteger(input?.now) ? input.now : Date.now()).toISOString(),
    },
  };
  if (Object.keys(homes).length > MAX_ACCOUNTS) {
    return { ok: false, code: 'FLEET_HOME_TOO_MANY', error: `more than ${MAX_ACCOUNTS} account homes`, path: file };
  }
  const lastAccount = typeof input?.lastAccount === 'string' && ACCOUNT_CODE_RE.test(input.lastAccount)
    ? input.lastAccount
    : accountCode;
  if (previous.homes[accountCode]?.fleet_key === fleetKey && previous.lastAccount === lastAccount) {
    return { ok: true, path: file };
  }
  return writeFleetState(file, { homes, lastAccount });
}

/**
 * Record which account this machine last bound under, without changing any fleet key.
 *
 * Used by the migration guard: a paired machine that cannot derive a key still has an account
 * identity, and persisting it is what lets the *next* real account switch be recognised.
 *
 * @param {string|null} file
 * @param {string} accountCode
 * @returns {{ok: true, path: string}|{ok: false, code: string, error: string, path: string|null}}
 */
export function rememberFleetAccount(file, accountCode) {
  if (file === null || file === undefined || file === '') {
    return { ok: false, code: 'FLEET_HOME_NO_PATH', error: 'no state directory is known', path: null };
  }
  if (!ACCOUNT_CODE_RE.test(typeof accountCode === 'string' ? accountCode : '')) {
    return { ok: false, code: 'FLEET_HOME_BAD_ACCOUNT', error: 'account code is not 8 hex characters', path: file };
  }
  const previous = readFleetHome(file);
  if (previous.ok !== true) return previous;
  if (previous.lastAccount === accountCode) return { ok: true, path: file };
  return writeFleetState(file, { homes: previous.homes, lastAccount: accountCode });
}
