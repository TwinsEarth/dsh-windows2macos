/**
 * Fleet binding diagnostics (read-only).
 *
 * A device token can be valid while `fleet_id` is null: the relay lists the machine globally
 * ("all machines") but filters it out of every fleet view ("this fleet"). v0.8.7's
 * "already paired -> do not pair again" rule made that state sticky, so it needs to be
 * *observed* rather than inferred from "paired: true".
 *
 * Nothing here writes: the status tool reports, and the auto-start path decides whether to
 * re-admit using the fleet key it already holds.
 */

export const FLEET_BINDING_CODE = Object.freeze({
  BOUND: 'FLEET_BOUND',
  UNBOUND: 'FLEET_UNBOUND',
  MISMATCH: 'FLEET_MISMATCH',
  UNPAIRED: 'FLEET_UNPAIRED',
  TOKEN_REJECTED: 'FLEET_TOKEN_REJECTED',
  UNKNOWN: 'FLEET_UNKNOWN',
});

/**
 * Should a start-up re-admit even though a token exists?
 *
 * Two states need it: the machine has no fleet (a token issued before fleet binding, or a
 * run where the pairing code carried none), or the fleet it is in is **not the fleet the
 * current account derives**. The second is the account-switch defect: a stored token stays
 * valid for the account that minted it, so after a different DeepSeek account signs in the
 * machine keeps heartbeating into the old account's fleet unless its binding is compared
 * with the key the new account derives.
 *
 * An absent expected fleet id means the caller could not derive one; equality cannot be
 * tested then, so only the unbound state re-admits.
 */
export function shouldRejoin({ token, fleetId, fleetKey, expectedFleetId = null }) {
  if (typeof token !== 'string' || token === '') return false;
  if (typeof fleetKey !== 'string' || fleetKey.trim() === '') return false;
  if (fleetId === null || fleetId === undefined || fleetId === '') return true;
  return typeof expectedFleetId === 'string' && expectedFleetId !== '' && fleetId !== expectedFleetId;
}

/**
 * Read this machine's relay record and classify its fleet binding.
 *
 * @param {{relayUrl: string, token: string|null, machineId: string|null,
 *          fleetKey: string|null, fetchImpl?: Function, timeoutMs?: number}} input
 * @returns {Promise<object>} a bounded, token-free status block
 */
export async function diagnoseFleetBinding({ relayUrl, token, machineId, fleetKey = null, expectedFleetId = null, fetchImpl = fetch, timeoutMs = 2500 }) {
  const checkedAt = new Date().toISOString();
  const fleetKeyConfigured = typeof fleetKey === 'string' && fleetKey.trim() !== '';
  const expected = typeof expectedFleetId === 'string' && expectedFleetId !== '' ? expectedFleetId : null;
  const base = {
    ok: true,
    state: 'unknown',
    code: FLEET_BINDING_CODE.UNKNOWN,
    fleet_id: null,
    expected_fleet_id: expected,
    token_present: typeof token === 'string' && token !== '',
    fleet_key_configured: fleetKeyConfigured,
    machine_id: machineId,
    checked_at: checkedAt,
    detail: null,
    remedy: null,
  };
  if (base.token_present !== true) {
    return { ...base, state: 'unpaired', code: FLEET_BINDING_CODE.UNPAIRED, detail: 'this machine has no device token' };
  }
  if (typeof relayUrl !== 'string' || relayUrl === '') {
    return { ...base, detail: 'no relay URL is configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(relayUrl.replace(/\/+$/, '') + '/v1/devices', {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ...base,
        state: 'token_rejected',
        code: FLEET_BINDING_CODE.TOKEN_REJECTED,
        detail: 'the relay rejected this device token (HTTP ' + response.status + ')',
        remedy: 're-pair this machine (the stored token is stale for this relay)',
      };
    }
    if (response.ok !== true) {
      return { ...base, detail: 'the relay answered HTTP ' + response.status };
    }
    const body = await response.json().catch(() => null);
    const devices = Array.isArray(body?.devices) ? body.devices : [];
    const self = devices.find((entry) => entry?.machine_id === machineId) ?? null;
    if (self === null) {
      return { ...base, detail: 'the relay answered 200 but does not list this machine' };
    }
    const fleetId = typeof self.fleet_id === 'string' && self.fleet_id !== '' ? self.fleet_id : null;
    if (fleetId === null) {
      return {
        ...base,
        state: 'unbound',
        code: FLEET_BINDING_CODE.UNBOUND,
        detail: 'the token is valid, but the relay records this machine with fleet_id=null',
        remedy: fleetKeyConfigured
          ? 'a fleet key is configured; the next start re-admits this machine into its fleet'
          : 'set fleetKey / W2M_FLEET_KEY, then restart the agent so the machine can join its fleet',
      };
    }
    if (expected !== null && fleetId !== expected) {
      return {
        ...base,
        state: 'mismatch',
        code: FLEET_BINDING_CODE.MISMATCH,
        fleet_id: fleetId,
        detail: 'the relay records this machine in a different fleet than the signed-in account derives',
        remedy: 're-admit this machine with the account-derived fleet key; the old token must not keep it in the previous fleet',
      };
    }
    return { ...base, state: 'bound', code: FLEET_BINDING_CODE.BOUND, fleet_id: fleetId };
  } catch (error) {
    return {
      ...base,
      detail: 'the fleet binding could not be read: ' + (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}
