/**
 * The operator-facing fleet pin, stored beside `device.json`.
 *
 * `cordis.patch.yml` is a profile layer, and asking an operator to hand-edit it is how a working
 * DSH gets broken. This file is the supported alternative: the settings page writes it atomically,
 * the plugin reads it at startup, and the profile YAML is never touched.
 *
 * The file contains an encoded fleet key, which is a credential: mode 0600 where the platform
 * honours it, and the route only ever returns a fingerprint. Every write makes a timestamped
 * backup first; a failed validation or rename restores that backup instead of leaving a half-written
 * pin that changes the next boot.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { deviceFilePath } from '../agent/identity.mjs';

export const FLEET_CONFIG_FILE = 'fleet-config.json';
export const FLEET_CONFIG_VERSION = 1;
export const FLEET_CONFIG_POLICIES = Object.freeze(['config', 'home', 'account']);

const MAX_KEY_LENGTH = 4096;
const FLEET_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Resolve the pin file the same way the plugin resolves `device.json`.
 *
 * @param {string|null|undefined} stateDir An explicit state directory, or null/undefined.
 * @returns {string|null}
 */
export function fleetConfigPathFor(stateDir) {
  if (typeof stateDir === 'string' && stateDir.trim() !== '') {
    return join(stateDir.trim(), FLEET_CONFIG_FILE);
  }
  try {
    return join(dirname(deviceFilePath({})), FLEET_CONFIG_FILE);
  } catch {
    return null;
  }
}

/** @param {string|null} deviceFile */
export function fleetConfigPathBeside(deviceFile) {
  return typeof deviceFile === 'string' && deviceFile !== '' ? join(dirname(deviceFile), FLEET_CONFIG_FILE) : null;
}

/**
 * Read the pin. A missing file is "not configured", not an error.
 *
 * @param {string|null} file
 * @returns {{ok: true, config: null, path: string|null}
 *   | {ok: true, config: {fleetKey: string, policy: string, fleetId: string, updatedAt: string}, path: string}
 *   | {ok: false, code: string, error: string, path: string|null}}
 */
export function readFleetConfig(file) {
  if (file === null || file === undefined || file === '') return { ok: true, config: null, path: null };
  if (!existsSync(file)) return { ok: true, config: null, path: file };

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, code: 'FLEET_CONFIG_UNREADABLE', error: error instanceof Error ? error.message : String(error), path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, code: 'FLEET_CONFIG_CORRUPT', error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`, path: file };
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== FLEET_CONFIG_VERSION) {
    return { ok: false, code: 'FLEET_CONFIG_CORRUPT', error: `expected version ${FLEET_CONFIG_VERSION}`, path: file };
  }
  const fleetKey = typeof parsed.fleet_key === 'string' ? parsed.fleet_key.trim() : '';
  const policy = typeof parsed.fleet_key_policy === 'string' ? parsed.fleet_key_policy.trim() : '';
  const fleetId = typeof parsed.fleet_id === 'string' ? parsed.fleet_id.trim().toLowerCase() : '';
  if (fleetKey === '' || fleetKey.length > MAX_KEY_LENGTH) {
    return { ok: false, code: 'FLEET_CONFIG_CORRUPT', error: 'fleet_key is missing or too long', path: file };
  }
  if (!FLEET_CONFIG_POLICIES.includes(policy)) {
    return { ok: false, code: 'FLEET_CONFIG_CORRUPT', error: `fleet_key_policy must be one of ${FLEET_CONFIG_POLICIES.join(', ')}`, path: file };
  }
  if (!FLEET_ID_RE.test(fleetId)) {
    return { ok: false, code: 'FLEET_CONFIG_CORRUPT', error: 'fleet_id is not a 64-hex SHA-256', path: file };
  }
  return {
    ok: true,
    config: {
      fleetKey,
      policy,
      fleetId,
      updatedAt: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
    },
    path: file,
  };
}

/**
 * Write a validated pin with a backup and rollback.
 *
 * Validation is repeated on the temporary file before it replaces the live one, so a write that
 * somehow serialised wrong cannot become the next boot's configuration.
 *
 * @param {string|null} file
 * @param {{fleetKey: string, fleetId: string, policy?: string, now?: number}} input
 * @returns {{ok: true, path: string, backup: string|null}
 *   | {ok: false, code: string, error: string, path: string|null}}
 */
export function writeFleetConfig(file, input) {
  if (file === null || file === undefined || file === '') {
    return { ok: false, code: 'FLEET_CONFIG_NO_PATH', error: 'no state directory is known', path: null };
  }
  const fleetKey = typeof input?.fleetKey === 'string' ? input.fleetKey.trim() : '';
  const fleetId = typeof input?.fleetId === 'string' ? input.fleetId.trim().toLowerCase() : '';
  const policy = typeof input?.policy === 'string' ? input.policy : 'config';
  if (fleetKey === '' || fleetKey.length > MAX_KEY_LENGTH) {
    return { ok: false, code: 'FLEET_CONFIG_BAD_KEY', error: 'fleet key is empty or too long', path: file };
  }
  if (!FLEET_ID_RE.test(fleetId)) {
    return { ok: false, code: 'FLEET_CONFIG_BAD_FLEET_ID', error: 'fleet id is not a 64-hex SHA-256', path: file };
  }
  if (!FLEET_CONFIG_POLICIES.includes(policy)) {
    return { ok: false, code: 'FLEET_CONFIG_BAD_POLICY', error: 'policy must be config, home or account', path: file };
  }

  const previous = readFleetConfig(file);
  if (previous.ok !== true) return previous;

  const now = Number.isInteger(input?.now) ? input.now : Date.now();
  const backup = previous.config === null
    ? null
    : `${file}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (backup !== null) {
      copyFileSync(file, backup);
      try { chmodSync(backup, 0o600); } catch { /* Windows ACL carries it */ }
    }
    const tmp = `${file}.tmp-${process.pid}-${now}`;
    writeFileSync(tmp, `${JSON.stringify({
      version: FLEET_CONFIG_VERSION,
      fleet_key: fleetKey,
      fleet_key_policy: policy,
      fleet_id: fleetId,
      updated_at: new Date(now).toISOString(),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* Windows ACL carries it */ }
    const check = readFleetConfig(tmp);
    if (check.ok !== true || check.config === null || check.config.fleetKey !== fleetKey || check.config.fleetId !== fleetId) {
      rmSync(tmp, { force: true });
      throw new Error(check.ok === true ? 'the written pin did not validate' : check.error);
    }
    try {
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    return { ok: true, path: file, backup };
  } catch (error) {
    // Roll back to the previous file. Without a backup, remove a partial new file rather than leave
    // a half-written pin for the next boot.
    try {
      if (backup !== null && existsSync(backup)) copyFileSync(backup, file);
      else rmSync(file, { force: true });
    } catch { /* best effort: the original error is more useful */ }
    return {
      ok: false,
      code: 'FLEET_CONFIG_WRITE_FAILED',
      error: error instanceof Error ? error.message : String(error),
      path: file,
    };
  }
}
