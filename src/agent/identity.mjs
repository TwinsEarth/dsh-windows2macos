/**
 * Local device identity (§2.1).
 *
 * `$DSH_HOME/xclient/device.json`, mode 0600:
 *
 *     { machine_id, machine_name, device_token, rabbit_url }
 *
 * `machine_id` is a UUID v4 generated once and never derived from the
 * hostname: hostnames change, collide across subnets, and are reused by
 * clones/VM templates, while the whole point of `machine_id` is to be a stable
 * key for leases, dedupe and the device table.
 *
 * A corrupt identity file is a hard error, not something to paper over by
 * generating a fresh id -- silently minting a new `machine_id` would make
 * Rabbit believe a second machine appeared and orphan the existing leases.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dshHome, normalizeArch, osName } from './caps.mjs';

/** Contract-mandated permission bits for `device.json`. */
export const DEVICE_FILE_MODE = 0o600;

/** Directory holding the identity file. */
export const DEVICE_DIR_NAME = 'xclient';

/** Identity file name. */
export const DEVICE_FILE_NAME = 'device.json';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Absolute path of `device.json`.
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.dir] Directory override (tests, throwaway profiles).
 * @returns {string}
 */
export function deviceFilePath(options = {}) {
  const env = options.env ?? process.env;
  if (options.dir) {
    const dir = isAbsolute(options.dir) ? options.dir : resolve(options.dir);
    return join(dir, DEVICE_FILE_NAME);
  }
  const explicitFile = env.DSH_DEVICE_FILE && env.DSH_DEVICE_FILE.trim() !== ''
    ? env.DSH_DEVICE_FILE
    : null;
  if (explicitFile) return isAbsolute(explicitFile) ? explicitFile : resolve(explicitFile);
  return join(dshHome(env), DEVICE_DIR_NAME, DEVICE_FILE_NAME);
}

/**
 * Fresh machine id (UUID v4).
 *
 * @returns {string}
 */
export function newMachineId() {
  return randomUUID();
}

/**
 * Default `machine_name`: `<win|mac|linux>-<sanitized hostname>`.
 *
 * The hostname is only a *name*; it never leaks into `machine_id`.
 *
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {string} [options.platform]
 * @returns {string}
 */
export function defaultMachineName(options = {}) {
  const os = osName(options.platform ?? process.platform);
  const prefix = os === 'windows' ? 'win' : os === 'macos' ? 'mac' : os;
  const host = String(options.host ?? hostname() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const name = host === '' ? `${prefix}-device` : `${prefix}-${host}`;
  return name.slice(0, 63).replace(/-+$/, '');
}

/**
 * Validate a parsed identity object.
 *
 * @param {unknown} value
 * @returns {{ok: true, identity: object}|{ok: false, reason: string}}
 */
export function validateIdentity(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'NOT_AN_OBJECT' };
  }
  const machineId = value.machine_id;
  if (typeof machineId !== 'string' || !UUID_V4.test(machineId)) {
    return { ok: false, reason: 'MACHINE_ID_NOT_UUID_V4' };
  }
  if (value.machine_name !== undefined && typeof value.machine_name !== 'string') {
    return { ok: false, reason: 'MACHINE_NAME_NOT_STRING' };
  }
  if (value.device_token !== undefined && value.device_token !== null && typeof value.device_token !== 'string') {
    return { ok: false, reason: 'DEVICE_TOKEN_NOT_STRING' };
  }
  if (value.rabbit_url !== undefined && value.rabbit_url !== null && typeof value.rabbit_url !== 'string') {
    return { ok: false, reason: 'RABBIT_URL_NOT_STRING' };
  }
  return { ok: true, identity: value };
}

/**
 * Read `device.json`.
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.dir]
 * @returns {{exists: boolean, path: string, identity: object|null, reason: string|null}}
 */
export function loadIdentity(options = {}) {
  const path = deviceFilePath(options);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, path, identity: null, reason: null };
    return { exists: false, path, identity: null, reason: `READ_FAILED:${error?.code ?? 'UNKNOWN'}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { exists: true, path, identity: null, reason: 'INVALID_JSON' };
  }
  const valid = validateIdentity(parsed);
  if (!valid.ok) return { exists: true, path, identity: null, reason: valid.reason };
  return { exists: true, path, identity: parsed, reason: null };
}

/**
 * Write `device.json` atomically, with 0600 where the platform honours it.
 *
 * Windows/NTFS ignores POSIX mode bits; the chmod is best-effort and never
 * fatal, which is reported honestly rather than pretended.
 *
 * @param {object} identity
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.dir]
 * @returns {string} The path written.
 */
export function saveIdentity(identity, options = {}) {
  const valid = validateIdentity(identity);
  if (!valid.ok) {
    const error = new Error(`refusing to write an invalid identity: ${valid.reason}`);
    error.code = 'IDENTITY_INVALID';
    throw error;
  }
  const path = deviceFilePath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    machine_id: identity.machine_id,
    machine_name: identity.machine_name ?? defaultMachineName(options),
    device_token: identity.device_token ?? null,
    rabbit_url: identity.rabbit_url ?? null,
  };
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: DEVICE_FILE_MODE });
  renameSync(tmp, path);
  try {
    chmodSync(path, DEVICE_FILE_MODE);
  } catch {
    /* NTFS does not carry POSIX bits */
  }
  return path;
}

/**
 * Load the identity, creating one on first run.
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.dir]
 * @param {string} [options.name] `--name` override.
 * @param {string} [options.rabbitUrl]
 * @returns {{identity: object, path: string, created: boolean}}
 */
export function loadOrCreateIdentity(options = {}) {
  const loaded = loadIdentity(options);
  if (loaded.exists && !loaded.identity) {
    const error = new Error(
      `identity file ${loaded.path} is unusable (${loaded.reason}); refusing to mint a new machine_id`,
    );
    error.code = 'IDENTITY_CORRUPT';
    throw error;
  }
  if (loaded.identity) {
    let changed = false;
    const identity = { ...loaded.identity };
    if (options.name && options.name !== identity.machine_name) {
      identity.machine_name = options.name;
      changed = true;
    }
    if (options.rabbitUrl && options.rabbitUrl !== identity.rabbit_url) {
      identity.rabbit_url = options.rabbitUrl;
      changed = true;
    }
    if (changed) saveIdentity(identity, options);
    return { identity, path: loaded.path, created: false };
  }
  const identity = {
    machine_id: newMachineId(),
    machine_name: options.name ?? defaultMachineName(options),
    device_token: null,
    rabbit_url: options.rabbitUrl ?? null,
  };
  const path = saveIdentity(identity, options);
  return { identity, path, created: true };
}

/**
 * Persist a freshly paired `device_token`.
 *
 * @param {string} token
 * @param {object} [options]
 * @returns {object} The updated identity.
 */
export function saveDeviceToken(token, options = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    const error = new Error('refusing to store an empty device_token');
    error.code = 'DEVICE_TOKEN_INVALID';
    throw error;
  }
  const { identity } = loadOrCreateIdentity(options);
  const updated = { ...identity, device_token: token };
  saveIdentity(updated, options);
  return updated;
}

/**
 * Convenience: identity + a `platform`-ish summary for the pair request.
 *
 * @param {object} [options]
 * @returns {{machine_id: string, machine_name: string, platform: {os: string, arch: string}}}
 */
export function describeMachine(options = {}) {
  const { identity } = loadOrCreateIdentity(options);
  return {
    machine_id: identity.machine_id,
    machine_name: identity.machine_name,
    platform: { os: osName(process.platform), arch: normalizeArch(process.arch) },
  };
}
