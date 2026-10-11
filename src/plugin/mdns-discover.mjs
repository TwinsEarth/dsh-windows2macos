/**
 * LAN discovery for the W2M plugin: mDNS candidates, offered *next to* the relay roster.
 *
 * # THE RULE, and why it is written here in these words
 *
 * **Discovery is a hint, never an authorisation.** A discovered device is a *candidate to ask*. It
 * never skips, weakens or short-circuits any existing gate — the device token, the per-machine
 * allow-list, the git anchors, the verdict model. If you find yourself writing code where a discovered
 * device is trusted because it was discovered, stop: that is a defect, not a shortcut.
 *
 * This module is where that rule has to be *executable* rather than aspirational, so it is spelled out
 * as code in {@link dispatchRefusal}:
 *
 *   1. mDNS carries no proof of anything. Every candidate is reported `verified: false`, and no field
 *      of a discovered record is ever copied into a token, a URL credential, or a config value.
 *   2. A **service name is not identity.** A matching name is reported as `name_match`, a hint a human
 *      can read, and can never on its own promote a candidate. Identity is a `machine_id` the *relay*
 *      assigned at pairing time, which is the only value that can be matched against the roster.
 *   3. A candidate the relay does not list is `dispatchable: false` with a refusal that names what
 *      would change it. It is visible — an operator should see the machine that is on the LAN but
 *      unpaired — and it is not selectable.
 *   4. Even a paired, relay-listed candidate is only a *dispatch target* in the sense the relay
 *      already allows: this module does not add authority, it removes ambiguity.
 *
 * What this buys, concretely: a device that shows itself on the LAN without pairing is listed as
 * *unpaired* rather than silently appearing in the fleet, and no code path here can turn "I saw it" into
 * "I may run there".
 *
 * # Fail soft, but never silently
 *
 * Multicast is unavailable on plenty of real networks — a locked-down corporate WLAN, a container with
 * no multicast route, a host where every interface refuses the membership. That is not an error
 * condition for the plugin: `createDiscoverySource` logs **one** line naming the reason (repeat
 * failures with the same reason are not logged again) and every call still returns a structure with
 * `available: false` and `error` set. A caller can therefore always tell "nothing was discovered"
 * apart from "nothing could be discovered", which is the distinction a silent success would destroy.
 */

import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_SERVICE_TYPE,
  createResponder,
  discoverServices,
} from '../agent/mdns.mjs';
import { isUsableUnicastIpv4 } from '../agent/mdns-wire.mjs';
// The liveness rule is the relay control's own (`fleet-target.mjs`), imported rather than re-derived:
// "is this machine online" must mean one thing across the plugin, and a second copy of the rule here
// would be a second chance to disagree about who is reachable.
import { isSelectableDevice } from './fleet-target.mjs';

/** The `source` value every entry produced by this module carries. */
export const DISCOVERY_SOURCE = 'mdns';

/** TXT key carrying the relay's machine id. The one field that can be matched against the roster. */
export const TXT_MACHINE_ID = 'mid';

/** TXT key carrying the machine's display name. */
export const TXT_MACHINE_NAME = 'name';

/**
 * The sentence every discovered candidate carries, so a reader of the JSON cannot miss the posture.
 *
 * It is a constant rather than a literal per site because a model reading `w2m_devices` output sees the
 * same rule whether it looked at the block, the candidate, or only the counts.
 */
export const DISCOVERY_NOTE =
  'discovery is a hint, never an authorisation: a discovered device is unverified (mDNS authenticates ' +
  'nothing) and is only offered as a dispatch target when the relay already lists it as a live machine - ' +
  'pairing, the device token, the allow-list and the anchors all still apply';

/** Why a candidate may not be dispatched to. Each message says what would change it. */
export const DISPATCH_REFUSAL = Object.freeze({
  NOT_DISCOVERED: 'MDNS_NOT_DISCOVERED',
  IDENTITY_UNKNOWN: 'MDNS_IDENTITY_UNKNOWN',
  UNPAIRED: 'MDNS_UNPAIRED',
  RELAY_STALE: 'MDNS_RELAY_STALE',
  LOCAL_INSTANCE: 'MDNS_LOCAL_INSTANCE',
  NO_ENDPOINT: 'MDNS_NO_ENDPOINT',
});

/** Lower-case a name for comparison. Names arrive from a human, so case and padding are noise. */
function fold(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** A trimmed non-empty string, or null. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Index the relay roster for the two lookups this module needs.
 *
 * `byId` is the only index that can establish identity: a machine id the relay minted at pairing time.
 * `byName` exists so a *hint* can be shown — "this looks like the machine the relay calls
 * `mac-studio`" — and is deliberately a separate structure so no future edit can accidentally use it
 * where identity is required.
 *
 * @param {object[]} relayRecords `GET /v1/devices`'s `devices`, verbatim.
 * @returns {{byId: Map<string, object>, byName: Map<string, object[]>, size: number}}
 */
export function buildRelayIndex(relayRecords) {
  const byId = new Map();
  const byName = new Map();
  let size = 0;
  for (const record of Array.isArray(relayRecords) ? relayRecords : []) {
    if (record === null || typeof record !== 'object') continue;
    size += 1;
    const machineId = text(record.machine_id);
    const name = text(record.machine_name) ?? text(record.name);
    const entry = {
      machine_id: machineId,
      name,
      online: isSelectableDevice(record),
      state: text(record.state) ?? (isSelectableDevice(record) ? 'online' : 'unknown'),
    };
    if (machineId !== null && !byId.has(machineId)) byId.set(machineId, entry);
    const key = fold(name);
    if (key !== '') {
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(entry);
    }
  }
  return { byId, byName, size };
}

/**
 * Why a discovered candidate may not be dispatched to, or `null` when it may.
 *
 * This function **is** the rule. Read it as the list of things a discovered device would have to fake to
 * become a dispatch target: an identity the relay assigned, a live listing in the relay's own roster,
 * and an endpoint. A name it chose for itself is in none of those.
 *
 * @param {object|null|undefined} candidate A candidate from {@link describeDiscoveredCandidate}.
 * @returns {string|null}
 */
export function dispatchRefusal(candidate) {
  if (candidate === null || typeof candidate !== 'object') {
    return `${DISPATCH_REFUSAL.NOT_DISCOVERED}: not a discovered candidate at all`;
  }
  if (candidate.source !== DISCOVERY_SOURCE) {
    return `${DISPATCH_REFUSAL.NOT_DISCOVERED}: this is not a LAN-discovered candidate, so this rule does not speak for it`;
  }
  if (text(candidate.machine_id) === null) {
    return (
      `${DISPATCH_REFUSAL.IDENTITY_UNKNOWN}: the advertisement carries no \`${TXT_MACHINE_ID}\` key, so ` +
      'there is no relay machine id to look up; a service name is not identity and is never used as one. ' +
      'Pair the machine (its agent then advertises the machine id the relay gave it)'
    );
  }
  if (candidate.known_to_relay !== true) {
    return (
      `${DISPATCH_REFUSAL.UNPAIRED}: the relay does not list machine \`${candidate.machine_id}\`, so nothing ` +
      'has authorised this machine; a discovered device is a candidate to ask, never an authorisation. ' +
      'Pair it, or start its agent so the relay holds a lease, and it becomes an ordinary fleet member'
    );
  }
  if (candidate.relay_online !== true) {
    return (
      `${DISPATCH_REFUSAL.RELAY_STALE}: the relay lists machine \`${candidate.machine_id}\` but its lease is not ` +
      `live (state: ${candidate.relay_state ?? 'unknown'}), so a dispatch narrowed to it would have no target; ` +
      'wait for the machine to come online'
    );
  }
  if (candidate.local === true) {
    return `${DISPATCH_REFUSAL.LOCAL_INSTANCE}: this is this machine's own advertisement, not a peer`;
  }
  if (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535) {
    return `${DISPATCH_REFUSAL.NO_ENDPOINT}: the advertisement named no usable port (SRV port ${JSON.stringify(candidate.port)})`;
  }
  if (text(candidate.address) === null) {
    return `${DISPATCH_REFUSAL.NO_ENDPOINT}: the advertisement named no usable address (A record or observed source)`;
  }
  return null;
}

/**
 * May this candidate be offered as a dispatch target?
 *
 * @param {object|null|undefined} candidate
 * @returns {boolean}
 */
export function mayDispatchTo(candidate) {
  return dispatchRefusal(candidate) === null;
}

/**
 * The candidates a dispatch surface may offer.
 *
 * A caller that builds a target list from anything else has bypassed the rule; this exists so the
 * correct list is the easy one to build.
 *
 * @param {object[]} candidates
 * @returns {object[]}
 */
export function dispatchableCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => mayDispatchTo(candidate));
}

/**
 * Turn one reassembled mDNS instance into a candidate with its provenance and its verdict.
 *
 * @param {object} instance One entry of {@link discoverServices}'s `instances`.
 * @param {object} context
 * @param {{byId: Map<string, object>, byName: Map<string, object[]>}} context.relayIndex
 * @param {string|null} [context.localMachineId] This machine's relay id, for the "this is me" mark.
 * @param {number|null} [context.observedAt]
 * @returns {object}
 */
export function describeDiscoveredCandidate(instance, context) {
  const relayIndex = context?.relayIndex ?? { byId: new Map(), byName: new Map() };
  const localMachineId = text(context?.localMachineId);
  const txt = instance?.txt?.map ?? {};
  const machineId = text(txt[TXT_MACHINE_ID]);
  const relay = machineId !== null ? (relayIndex.byId.get(machineId) ?? null) : null;
  const nameKey = fold(instance?.name);
  const nameMatches = nameKey === '' ? [] : (relayIndex.byName.get(nameKey) ?? []);

  const advertised = Array.isArray(instance?.addresses)
    ? instance.addresses.filter((value) => typeof value === 'string')
    : [];
  const usableAdvertised = advertised.find((value) => isUsableUnicastIpv4(value)) ?? null;
  const observed = text(instance?.observed_address);
  const usableObserved = observed !== null && isUsableUnicastIpv4(observed) ? observed : null;
  const address = usableAdvertised ?? usableObserved;

  const candidate = {
    source: DISCOVERY_SOURCE,
    // Never true, for any candidate, ever: mDNS cannot verify anything. The field exists so a reader
    // does not have to infer the posture from a missing key.
    verified: false,
    name: text(instance?.name) ?? text(instance?.instance) ?? null,
    instance: text(instance?.instance) ?? null,
    service_type: text(instance?.service_type) ?? null,
    host: text(instance?.host) ?? null,
    address,
    address_source: usableAdvertised !== null ? 'a' : usableObserved !== null ? 'observed' : null,
    addresses: advertised,
    observed_address: observed,
    port: Number.isInteger(instance?.port) ? instance.port : null,
    // The relay's machine id as *claimed* by the advertisement. Used to look the machine up in the
    // roster, never trusted on its own: the roster entry is what makes it mean anything.
    machine_id: machineId,
    machine_name: text(txt[TXT_MACHINE_NAME]),
    known_to_relay: relay !== null,
    relay_state: relay?.state ?? null,
    relay_online: relay === null ? null : relay.online === true,
    // A name match is a *hint for a human*, never a promotion. Reported separately so it cannot be
    // mistaken for `known_to_relay`, which is decided by machine id alone.
    name_match:
      machineId === null && nameMatches.length === 1
        ? { machine_id: nameMatches[0].machine_id, name: nameMatches[0].name, online: nameMatches[0].online }
        : null,
    local: machineId !== null && localMachineId !== null && machineId === localMachineId,
    ttl: instance?.ttl ?? null,
    superseded_srv: Number.isInteger(instance?.superseded_srv) ? instance.superseded_srv : 0,
    seen_at: Number.isFinite(context?.observedAt) ? context.observedAt : null,
    dispatchable: false,
    refusal: null,
    note: DISCOVERY_NOTE,
  };
  candidate.refusal = dispatchRefusal(candidate);
  candidate.dispatchable = candidate.refusal === null;
  return candidate;
}

/**
 * Assemble the block `w2m_devices` (and a status surface) reports.
 *
 * @param {object} input
 * @param {object[]} [input.instances] From {@link discoverServices}.
 * @param {object[]} [input.relayRecords] `GET /v1/devices`'s `devices`, for the "does the relay list it" question.
 * @param {string|null} [input.localMachineId]
 * @param {boolean} [input.available] Whether a scan could actually be sent.
 * @param {string|null} [input.error] Why not, when it could not.
 * @param {number|null} [input.scannedAt]
 * @param {number|null} [input.elapsedMs]
 * @param {boolean} [input.aborted]
 * @param {object|null} [input.packets]
 * @param {number} [input.truncated]
 * @returns {object}
 */
export function describeDiscovered(input = {}) {
  const relayRecords = Array.isArray(input.relayRecords) ? input.relayRecords : [];
  const relayIndex = buildRelayIndex(relayRecords);
  const observedAt = Number.isFinite(input.scannedAt) ? input.scannedAt : null;
  const instances = Array.isArray(input.instances) ? input.instances : [];
  const candidates = instances.map((instance) =>
    describeDiscoveredCandidate(instance, {
      relayIndex,
      localMachineId: input.localMachineId ?? null,
      observedAt,
    }),
  );
  const counts = {
    instances: candidates.length,
    relay_listed: candidates.filter((candidate) => candidate.known_to_relay).length,
    // Every candidate we cannot even ask the relay about, plus every one it does not know: both are
    // "not a dispatch target", and both are reported so the number is never quietly zero.
    unpaired: candidates.filter((candidate) => candidate.machine_id === null || !candidate.known_to_relay)
      .length,
    dispatchable: candidates.filter((candidate) => candidate.dispatchable).length,
    local: candidates.filter((candidate) => candidate.local).length,
    verified: 0,
  };
  return {
    source: DISCOVERY_SOURCE,
    service_type: text(input.serviceType) ?? DEFAULT_SERVICE_TYPE,
    // Three states, kept apart on purpose: true (a scan ran and queries went out), false (a scan ran
    // and multicast was unavailable), null (nobody has asked yet). Collapsing the last two would turn
    // "not asked" into a claim about the network.
    available: input.available === true ? true : input.available === false ? false : null,
    error: input.error ?? null,
    scanned_at: observedAt,
    elapsed_ms: Number.isFinite(input.elapsedMs) ? input.elapsedMs : null,
    aborted: input.aborted === true,
    truncated: Number.isInteger(input.truncated) ? input.truncated : 0,
    packets: input.packets ?? null,
    counts,
    candidates,
    relay_index_size: relayIndex.size,
    note: DISCOVERY_NOTE,
    ...(input.available === true
      ? {}
      : {
          unavailable_note:
            input.available === false
              ? 'no scan was possible, so an empty candidate list here means "unknown", not "no devices on the LAN"'
              : 'no scan has been asked for yet; ask for one and an empty candidate list then means the same thing',
        }),
  };
}

/**
 * One list showing both sources, with provenance, for a UI or a status surface.
 *
 * Dispatchability is reported per source and is deliberately *not* uniform:
 *
 *   * a **relay** entry keeps the relay's own liveness verdict — nothing in this module narrows or
 *     widens what the relay path already allows;
 *   * a **discovered** entry is additionally required to be listed by the relay (see
 *     {@link dispatchRefusal}), which is the only reason it can ever be `dispatchable`.
 *
 * @param {object} input
 * @param {object[]} [input.relayRecords]
 * @param {object[]} [input.candidates] Already described by {@link describeDiscovered}.
 * @param {string|null} [input.localMachineId]
 * @returns {{roster: object[], counts: object, note: string}}
 */
export function mergeRosterView(input = {}) {
  const localMachineId = text(input.localMachineId);
  const relayed = (Array.isArray(input.relayRecords) ? input.relayRecords : [])
    .filter((record) => record !== null && typeof record === 'object')
    .map((record) => {
      const machineId = text(record.machine_id);
      return {
        source: 'relay',
        verified: true,
        machine_id: machineId,
        name: text(record.machine_name) ?? text(record.name),
        address: null,
        port: null,
        online: isSelectableDevice(record),
        state: text(record.state) ?? null,
        local: machineId !== null && localMachineId !== null && machineId === localMachineId,
        relay_listed: true,
        dispatchable: isSelectableDevice(record),
        refusal: isSelectableDevice(record)
          ? null
          : `RELAY_STALE: the relay lists machine \`${machineId ?? 'unknown'}\` but its lease is not live`,
      };
    });
  const discovered = (Array.isArray(input.candidates) ? input.candidates : []).map((candidate) => ({
    source: DISCOVERY_SOURCE,
    verified: false,
    machine_id: candidate.machine_id ?? null,
    name: candidate.name ?? null,
    address: candidate.address ?? null,
    port: candidate.port ?? null,
    online: candidate.relay_online === true,
    state: candidate.relay_state ?? null,
    local: candidate.local === true,
    relay_listed: candidate.known_to_relay === true,
    dispatchable: candidate.dispatchable === true,
    refusal: candidate.refusal ?? null,
  }));
  return {
    roster: [...relayed, ...discovered],
    counts: {
      relay: relayed.length,
      discovered: discovered.length,
      dispatchable_relay: relayed.filter((entry) => entry.dispatchable).length,
      dispatchable_discovered: discovered.filter((entry) => entry.dispatchable).length,
      unpaired_discovered: discovered.filter((entry) => entry.relay_listed !== true).length,
    },
    note: DISCOVERY_NOTE,
  };
}

/**
 * The plugin's discovery source: one object owning the scan, the status, and the opt-in responder.
 *
 * @param {object} [options]
 * @param {(options: object) => Promise<object>} [options.scan] Injected scanner (tests use this).
 * @param {string} [options.serviceType]
 * @param {number} [options.timeoutMs]
 * @param {{warn?: Function, info?: Function}|null} [options.logger]
 * @param {() => number} [options.now]
 * @param {object|null} [options.advertise] Opt-in responder settings; `null` (the default) means this
 *   machine never binds 5353 and never announces. See {@link createDiscoverySource}'s `start()`.
 * @returns {object}
 */
export function createDiscoverySource(options = {}) {
  const scanner = typeof options.scan === 'function' ? options.scan : discoverServices;
  const serviceType = options.serviceType ?? DEFAULT_SERVICE_TYPE;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
  const logger = options.logger ?? null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const advertise = options.advertise ?? null;

  const state = {
    scans: 0,
    last_scan_at: null,
    last_error: null,
    available: null,
    instances: [],
    logged: null,
    advertising: false,
  };
  /** @type {{start: Function, close: Function, status: Function}|null} */
  let responder = null;

  /** One line per distinct failure: a locked-down network must not fill a log with the same sentence. */
  function logOnce(line) {
    if (state.logged === line) return;
    state.logged = line;
    try {
      if (typeof logger?.warn === 'function') logger.warn(line);
      else if (typeof logger?.info === 'function') logger.info(line);
    } catch {
      // A logger that throws is not allowed to break discovery.
    }
  }

  /** The current view, without scanning: recomputed against the roster it is given. */
  function describe(context = {}) {
    return describeDiscovered({
      instances: state.instances,
      relayRecords: context.relayRecords ?? [],
      localMachineId: context.localMachineId ?? null,
      available: state.available === true ? true : state.available === false ? false : null,
      error: state.last_error,
      scannedAt: state.last_scan_at,
      elapsedMs: context.elapsedMs ?? null,
      aborted: context.aborted === true,
      packets: context.packets ?? null,
      truncated: context.truncated ?? 0,
      serviceType,
    });
  }

  /**
   * Run one bounded scan and describe the result against the relay roster.
   *
   * Never throws and never rejects: a scanner that fails is a scan that is `available: false`, which the
   * caller reports alongside the relay roster it already has.
   *
   * @param {{signal?: AbortSignal, relayRecords?: object[], localMachineId?: string|null}} [context]
   * @returns {Promise<object>}
   */
  async function scan(context = {}) {
    state.scans += 1;
    let result = null;
    try {
      result = await scanner({ serviceType, timeoutMs, signal: context.signal });
    } catch (error) {
      result = {
        ok: false,
        available: false,
        error: `MDNS_SCAN_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        instances: [],
      };
    }
    const available = result?.available === true;
    state.last_scan_at = now();
    state.available = available;
    state.last_error = available
      ? null
      : (result?.error ?? 'MDNS_UNAVAILABLE: the scan reported neither success nor a reason');
    state.instances = Array.isArray(result?.instances) ? result.instances : [];
    if (!available) {
      logOnce(
        `w2m: LAN discovery is unavailable (${state.last_error}); continuing without discovered candidates`,
      );
    }
    return describe({
      relayRecords: context.relayRecords ?? [],
      localMachineId: context.localMachineId ?? null,
      elapsedMs: result?.elapsed_ms ?? null,
      aborted: result?.aborted === true,
      packets: result?.packets ?? null,
      truncated: result?.truncated ?? 0,
    });
  }

  /**
   * Start the opt-in responder.
   *
   * Opt-in, not automatic: binding a multicast port and announcing on the LAN is a side effect on the
   * host's network that nobody asked for by loading a plugin, and `w2m_devices` works without it. When
   * it is asked for, a failure is soft — one log line, `advertising: false` in {@link status}, and
   * everything else keeps working.
   *
   * @returns {Promise<object>} {@link status}.
   */
  async function start() {
    if (advertise === null || responder !== null) return status();
    try {
      responder = createResponder({
        ...advertise,
        serviceType,
        logger: (line) => logOnce(line),
      });
      const started = await responder.start();
      state.advertising = started?.running === true;
      if (!state.advertising) {
        logOnce(`w2m: mDNS advertising is off (${started?.last_error ?? 'the responder did not start'})`);
      }
    } catch (error) {
      responder = null;
      state.advertising = false;
      logOnce(
        `w2m: mDNS advertising failed (${error instanceof Error ? error.message : String(error)}); continuing`,
      );
    }
    return status();
  }

  /** Stop the responder, sending the TTL=0 goodbye. Never throws. */
  async function stop() {
    if (responder === null) return status();
    const closing = responder;
    responder = null;
    state.advertising = false;
    try {
      await closing.close();
    } catch (error) {
      logOnce(`w2m: mDNS shutdown failed (${error instanceof Error ? error.message : String(error)})`);
    }
    return status();
  }

  /**
   * The status surface: what has been scanned, whether it worked, and whether we are advertising.
   *
   * @returns {object}
   */
  function status() {
    return {
      source: DISCOVERY_SOURCE,
      service_type: serviceType,
      timeout_ms: timeoutMs,
      scans: state.scans,
      available: state.available,
      last_error: state.last_error,
      last_scan_at: state.last_scan_at,
      candidates: state.instances.length,
      advertising: state.advertising,
      advertising_requested: advertise !== null,
      note: DISCOVERY_NOTE,
    };
  }

  return { scan, describe, status, start, stop };
}
