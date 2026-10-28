/**
 * ToFuture identity HMAC (S2): the only form in which network identifiers leave the machine.
 *
 * One canonical algorithm for client, whitelist provisioning and relay comparison:
 *   salt_id = HMAC(fleet_key, "w2m-ops-salt-v1|" + machine_id) hex[0..16]
 *   hmac    = HMAC(fleet_key, "w2m-ops-id-v1|" + kind + "|" + value + "|" + salt_id) hex
 *
 * Nothing here returns, stores or logs `value`; callers pass it in memory and keep only `hmac`.
 */
import { createHmac } from 'node:crypto';

export const ID_KINDS = Object.freeze(['mac', 'ipv4', 'ipv6', 'bssid']);

const hmacHex = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest('hex');

export function saltIdOf(fleetKey, machineId) {
  return hmacHex(String(fleetKey), 'w2m-ops-salt-v1|' + String(machineId)).slice(0, 16);
}

export function identityHmac(fleetKey, machineId, kind, value) {
  const salt = saltIdOf(fleetKey, machineId);
  return { kind, salt_id: salt, hmac: hmacHex(String(fleetKey), 'w2m-ops-id-v1|' + kind + '|' + String(value) + '|' + salt) };
}

/** Stable JSON for the request body (keys sorted) — used by tests and future attestation. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
