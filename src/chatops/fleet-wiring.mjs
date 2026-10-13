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
// v0.8.1: the account-derived fleet key, so a machine can join its own fleet with no human step.
import { planJoin } from './fleet-join.mjs';

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
/**
 * The `fleet_id` a device joins, and **where that fact came from**.
 *
 * Three sources, in order of authority, and the order is the whole security argument:
 *
 * | source | who decided | why |
 * |---|---|---|
 * | `pairing_code` | the operator, by issuing the code | explicit intent, and the only source that can place a device in a fleet it could not compute |
 * | `fleet_key` | the account, by derivation | the auto-join path: the device proves membership by holding the key |
 * | `request` | the relay operator, via `--fleet` | a relay that serves one fleet and is told which |
 *
 * ## Why the key is *derived from* rather than *compared against*
 *
 * A device presenting a `fleet_key` is **assigned** the fleet id computed from that key —
 * `SHA-256(key)`. The relay does not decide whether to believe a claimed fleet id; it computes one.
 * So a device can only ever land in the fleet whose key it holds, there is no trust-on-first-use to
 * get wrong, and nothing to forge: a device without the key forms a different, empty fleet rather
 * than joining somebody else's.
 *
 * This is what lets a second machine on one account join with **no human step and no relay
 * configuration** — the gap that let a new PC sit invisible next to its own fleet.
 *
 * @param {object} input
 * @param {object|null} input.codeRecord The pairing code's record, if one was used.
 * @param {string|null} [input.fleetKeyEncoded] The account-derived key, if the device offered one.
 * @param {string|null} [input.requestedFleet] An explicit fleet from the relay's own configuration.
 * @returns {{fleet_id: string|null, fleet_source: string|null, fleet_reason?: string}}
 */
export function deviceFleetFields({ codeRecord, fleetKeyEncoded = null, requestedFleet = null }) {
  const fromCode = fleetForPairingCode(codeRecord);
  if (fromCode !== null) {
    /**
     * The provenance has to say *how* the fleet was established, and a first version did not: it
     * reported `pairing_code` for a device that never presented one, because the relay builds a
     * synthetic code record for the key path so the binding reads from a single place.
     *
     * That mattered. `fleet_source` is what an operator reads in `devices.json` to answer *"how did
     * this machine get into my fleet?"* — and answering "a pairing code" when there was none sends
     * them looking for a code that was never issued. Found by a live pairing test, not by reading.
     */
    if (codeRecord?.from_fleet_key === true) return { fleet_id: fromCode, fleet_source: 'fleet_key' };
    return { fleet_id: fromCode, fleet_source: 'pairing_code' };
  }

  /**
   * The auto-join path. Tried before the operator's `--fleet` so that a device which knows its own
   * account lands in its own fleet rather than being absorbed into whatever fleet the relay serves —
   * a relay configured for one account must not silently become the wrong fleet for a device whose
   * account says otherwise.
   */
  if (typeof fleetKeyEncoded === 'string' && fleetKeyEncoded !== '') {
    const join = planJoin({ fleetKeyEncoded });
    if (join.ok) return { fleet_id: join.fleetId, fleet_source: 'fleet_key' };
    /**
     * A malformed key does **not** pair the device into the relay's own fleet. Falling through would
     * be the silent wrong answer: a device that meant to join its account would instead be placed in
     * an unrelated fleet and told nothing.
     */
    return { fleet_id: null, fleet_source: null, fleet_reason: join.reason };
  }

  if (typeof requestedFleet === 'string' && requestedFleet !== '') {
    // Recorded with its provenance so a fleet that arrived from a request is visible as such in
    // `devices.json` rather than looking identical to one that came from a code or a key.
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
