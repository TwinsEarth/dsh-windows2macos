/**
 * Wiring fleet scoping into the relay's decisions (v0.7.7).
 *
 * ## What this file is, and what it is not
 *
 * `fleet-scope.mjs` answers *"which devices may this request reach"*. This answers the two
 * questions the relay needs answered **before** it can ask that one:
 *
 * 1. **What fleet is this requester in?** A relay receives a device token, not a fleet. The token
 *    maps to a device, and the device has a `fleet_id` — or does not, because it paired before
 *    fleets existed.
 * 2. **What happens to a device that has no fleet?**
 *
 * ## The migration question, and why the answer is not "refuse"
 *
 * The shared relay holds four devices that paired under v0.6.3. None of them has a `fleet_id`.
 * Refusing fleetless requests would take the whole fleet down at the moment of deployment — for a
 * safety feature, that is the wrong trade.
 *
 * So there are two modes, and the relay's operator chose between them by configuring a fleet:
 *
 * | relay has | fleetless device | reaches |
 * |---|---|---|
 * | **no fleet configured** | legacy | every device, as before |
 * | **a fleet configured** | `fleet_id: null` | **nothing** |
 *
 * That second row is the one that matters. Once an operator says *"this relay is for fleet X"*, a
 * device with no fleet is not silently granted the run of it — it reaches nothing, and
 * `scopeFleetId` says why. The transition is therefore **opt-in and visible**, rather than a
 * background behaviour change that arrives with a version bump.
 *
 * A device with a `fleet_id` always reaches its own fleet and nothing else, in both modes. That is
 * the isolation, and it does not depend on the relay's configuration.
 */

import { selectTargets, SCOPE_REFUSAL } from './fleet-scope.mjs';

/** Why a request reached nothing, before target selection even runs. */
export const WIRING_REFUSAL = Object.freeze({
  /** The token belongs to no device this relay knows. */
  UNKNOWN_TOKEN: 'unknown_token',
  /** The relay is scoped to a fleet and this requester is not in one. */
  REQUESTER_HAS_NO_FLEET: 'requester_has_no_fleet',
});

/**
 * Which fleet the requester acts as.
 *
 * The value comes from **the device record**, which the relay wrote at pairing time from the
 * pairing code — never from anything in the request. A request that could name its own fleet
 * would be able to reach any fleet, and every signature would faithfully attest to it.
 *
 * @param {object} input
 * @param {{machine_id?: string, fleet_id?: string|null}|null} input.device The requester's record.
 * @param {string|null} [input.relayFleetId] The fleet this relay is scoped to, if the operator set one.
 * @returns {{ok: true, fleetId: string|null, legacy: boolean}
 *          | {ok: false, reason: string, text: string}}
 */
export function scopeFleetId({ device, relayFleetId = null }) {
  if (device === null || device === undefined || typeof device !== 'object') {
    return { ok: false, reason: WIRING_REFUSAL.UNKNOWN_TOKEN, text: '这个 token 不属于本 relay 已知的任何设备。' };
  }

  const deviceFleet = typeof device.fleet_id === 'string' && device.fleet_id !== '' ? device.fleet_id : null;

  // Already grouped: it reaches its own fleet, whatever the relay is configured for.
  if (deviceFleet !== null) return { ok: true, fleetId: deviceFleet, legacy: false };

  // Not grouped, and the relay has not been claimed for a fleet: the pre-v0.7.7 behaviour, which
  // is what keeps a deployment from being an outage. `legacy: true` is reported so a caller can
  // log it rather than having to infer it.
  if (relayFleetId === null || relayFleetId === '') return { ok: true, fleetId: null, legacy: true };

  // Not grouped, and the relay *is* claimed. A fleetless device is not handed the run of someone
  // else's fleet — it reaches nothing, and says so.
  return {
    ok: false,
    reason: WIRING_REFUSAL.REQUESTER_HAS_NO_FLEET,
    text: '这个 relay 已绑定到一条舰队，而这台设备不属于任何舰队，因此它不能派发到任何地方。',
  };
}

/**
 * The devices a request may reach, given a device list and a requester.
 *
 * The single entry point the relay needs. It applies `scopeFleetId`, then `selectTargets`, and
 * then — only in legacy mode — falls back to the unfiltered list, because that is exactly what
 * the pre-v0.7.7 code did and a migration must not change behaviour for devices that were never
 * asked to change.
 *
 * ## The case a first version got wrong
 *
 * `POST /v1/task` authenticates with the **operator token**, and an operator is not a device:
 * `authorizeTaskDispatch` returns `{ role: 'operator', machine_id: null }`. So `requester` is
 * routinely absent on the most common path, and an earlier version of this function refused it as
 * `unknown_token` — which turned every operator-token dispatch into an error and broke 74 relay
 * tests at once.
 *
 * An **absent** requester and an **unknown** one are therefore different things:
 *
 *   * absent, on an unscoped relay → the legacy rule, which is what an operator has always had;
 *   * absent, on a scoped relay → refused, because there is no fleet to attribute the request to
 *     and handing it the run of the fleet is the silent grant this work exists to remove;
 *   * unknown (a machine id that is not in the device table) → refused, always, because a token
 *     that maps to nothing is a broken caller rather than a legitimate operator.
 *
 * @param {object} input
 * @param {Array<object>} input.devices Every device the relay holds.
 * @param {object|null|undefined} input.requester The requester's device record, or absent for an
 *        operator-token dispatch.
 * @param {string[]} [input.targetMachines]
 * @param {string|null} [input.relayFleetId]
 * @param {boolean} [input.requireOnline]
 */
export function targetsFor({ devices, requester, targetMachines, relayFleetId = null, requireOnline = true }) {
  const relayScoped = typeof relayFleetId === 'string' && relayFleetId !== '';

  // An operator-token caller has no device at all, which is a legitimate identity rather than a
  // broken one. On an unscoped relay it gets exactly the pre-v0.7.7 rule.
  if (requester === null || requester === undefined) {
    if (!relayScoped) return legacyTargets({ devices, targetMachines, requireOnline, reason: 'operator' });
    return {
      ok: false,
      reason: WIRING_REFUSAL.REQUESTER_HAS_NO_FLEET,
      text: '这个 relay 已绑定到一条舰队，而这个请求没有可以归属的设备身份，因此不能派发。',
      legacy: false,
    };
  }

  const scope = scopeFleetId({ device: requester, relayFleetId });
  if (!scope.ok) return { ok: false, reason: scope.reason, text: scope.text, legacy: false };

  if (scope.legacy) return legacyTargets({ devices, targetMachines, requireOnline, reason: 'fleetless' });

  const result = selectTargets({ devices, fleetId: scope.fleetId, targetMachines, requireOnline });
  return result.ok ? { ...result, legacy: false } : { ...result, legacy: false };
}

/** The pre-v0.7.7 rule, in one place so both callers cannot drift apart. */
function legacyTargets({ devices, targetMachines, requireOnline, reason }) {
  const all = Array.isArray(devices) ? devices : [];
  const chosen = Array.isArray(targetMachines) && targetMachines.length > 0
    ? all.filter((d) => targetMachines.includes(d.machine_id))
    : all;
  const offline = chosen.filter((d) => d.online === false).map((d) => d.machine_id);
  const targets = requireOnline ? chosen.filter((d) => d.online !== false) : chosen;
  if (targets.length === 0) {
    return {
      ok: false,
      reason: SCOPE_REFUSAL.NO_DEVICE_IN_FLEET,
      text: offline.length > 0 ? '没有在线设备。' : 'relay 上没有任何设备。',
      legacy: true,
    };
  }
  return { ok: true, targets, skippedOffline: offline, legacy: true, legacyReason: reason };
}

/**
 * The `fleet_id` a pairing code admits to, in the shape `state.mjs` stores.
 *
 * Returns `null` for a code that predates fleets, which is what keeps an existing relay working:
 * a code issued before this release pairs a device into no fleet, and the relay's own mode decides
 * what that means.
 */
export function fleetForPairingCode(codeRecord) {
  if (codeRecord === null || typeof codeRecord !== 'object') return null;
  const fleet = codeRecord.fleet_id;
  return typeof fleet === 'string' && fleet !== '' ? fleet : null;
}

/**
 * The device fields that carry fleet membership, for a record the relay is about to write.
 *
 * Kept as a function so the "the fleet came from the code" rule lives in one place: a caller that
 * builds a device literal by hand is the way a device ends up choosing its own fleet.
 */
export function deviceFleetFields({ codeRecord, requestedFleet }) {
  const fromCode = fleetForPairingCode(codeRecord);
  if (fromCode !== null) return { fleet_id: fromCode, fleet_source: 'pairing_code' };
  if (typeof requestedFleet === 'string' && requestedFleet !== '') {
    // Reachable only when the relay has no fleet of its own and an operator passed one explicitly.
    // Recorded with its provenance so a fleet that arrived from a request is visible as such in
    // `devices.json` rather than looking identical to one that came from a code.
    return { fleet_id: requestedFleet, fleet_source: 'request' };
  }
  return { fleet_id: null, fleet_source: null };
}

/**
 * A one-line description of the scoping decision, for a log.
 *
 * Deliberately includes the legacy flag: an operator reading logs during a migration needs to see
 * *which* rule applied, and "4 targets" alone does not say whether isolation is on.
 */
export function describeScope({ scope, targetCount }) {
  if (!scope.ok) return `scoped: refused (${scope.reason})`;
  if (scope.legacy) return `scoped: legacy (no fleet on this relay), ${targetCount} target(s)`;
  return `scoped: fleet ${scope.fleetId}, ${targetCount} target(s)`;
}
