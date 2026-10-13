/**
 * Which devices a request may reach, and which fleet a pairing code admits to (v0.7.6).
 *
 * ## The defect this replaces, in one line
 *
 * `src/relay/state.mjs` L1259-1262:
 *
 *     const all = [...this.devices.values()];
 *     const targets = Array.isArray(input.target_machines) && input.target_machines.length > 0
 *       ? all.filter((d) => input.target_machines.includes(d.machine_id))
 *       : all;
 *
 * `targets` is **every device on the relay**. No filter, because until now there was nothing to
 * filter by: a device had a random `machine_id` and the `user_id` the relay stored was never read.
 * So every account on a relay shares one pool, and any caller holding a valid operator token
 * broadcasts to all of them. That is the finding this release fixes.
 *
 * ## Why the decision lives here rather than inline
 *
 * The relay is a large stateful object where a mistake is expensive to find. The rule "which
 * devices may this request reach" is a **pure function of (requester's fleet, device's fleet,
 * explicitly named targets)**, so it is expressed here, at that shape, and tested exhaustively.
 * The relay calls it; it does not reimplement it.
 *
 * ## The three rules, and the reasoning that is not obvious
 *
 * **1. A request reaches only its own fleet.** Not "only its own fleet by default" — there is no
 * parameter to widen it. A cross-fleet read is never legitimate, so it is not expressible.
 *
 * **2. An empty fleet matches nothing.** `fleet_id: undefined` on both sides must **not** compare
 * equal. This is the failure that would silently undo everything: two ungrouped devices would
 * match each other, which is exactly the "everything in one pool" behaviour being removed. So an
 * absent fleet is a device that belongs to no fleet, and it is reachable by nobody.
 *
 * **3. A cross-fleet target is refused rather than ignored.** Silently dropping a named target
 * leaves the caller believing it dispatched somewhere. The refusal **does not say whether the
 * target exists** — a caller must not be able to probe another account's device ids.
 */

/** Why a request reached nobody, or was refused outright. */
export const SCOPE_REFUSAL = Object.freeze({
  /** The requester has no fleet, so it reaches no devices. */
  NO_FLEET: 'no_fleet',
  /** The fleet exists but holds no online device. */
  NO_DEVICE_IN_FLEET: 'no_device_in_fleet',
  /** A named target belongs to another fleet. Deliberately unspecific about which. */
  TARGET_OUTSIDE_FLEET: 'target_outside_fleet',
  /** The named target is not a device this relay holds at all. */
  TARGET_UNKNOWN: 'target_unknown',
});

/**
 * Does this device belong to this fleet?
 *
 * **Absent is not a wildcard.** Both sides must be a non-empty string and equal. A helper that
 * treated `undefined === undefined` as a match would put every ungrouped device in one pool — the
 * precise defect being removed — and it would pass every test that only ever sets a fleet.
 */
export function inFleet(deviceFleet, requesterFleet) {
  if (typeof deviceFleet !== 'string' || deviceFleet === '') return false;
  if (typeof requesterFleet !== 'string' || requesterFleet === '') return false;
  return deviceFleet === requesterFleet;
}

/**
 * The devices a request may reach.
 *
 * @param {object} input
 * @param {Array<{machine_id: string, fleet_id?: string, online?: boolean}>} input.devices
 * @param {string|null} input.fleetId The requester's fleet, from its verified statement.
 * @param {string[]} [input.targetMachines] Explicit targets, if any.
 * @param {boolean} [input.requireOnline] Skip devices the relay believes are offline.
 * @returns {{ok: true, targets: object[], skippedOffline: string[]}
 *          | {ok: false, reason: string, text: string}}
 */
export function selectTargets({ devices, fleetId, targetMachines, requireOnline = true }) {
  if (typeof fleetId !== 'string' || fleetId === '') {
    // A requester with no fleet reaches nothing. Not "everything", and not an error the caller can
    // retry differently — it needs an account.
    return { ok: false, reason: SCOPE_REFUSAL.NO_FLEET, text: '这个请求没有舰队身份，所以它不能到达任何设备。' };
  }

  const mine = devices.filter((d) => inFleet(d.fleet_id, fleetId));

  if (Array.isArray(targetMachines) && targetMachines.length > 0) {
    const byId = new Map(mine.map((d) => [d.machine_id, d]));
    const chosen = [];
    for (const id of targetMachines) {
      const device = byId.get(id);
      if (device === undefined) {
        // Two different worlds, deliberately reported as one answer. Saying "that machine exists
        // but is not yours" would let a caller enumerate another account's fleet by trying ids.
        return {
          ok: false,
          reason: SCOPE_REFUSAL.TARGET_OUTSIDE_FLEET,
          text: '指定的目标不在这条舰队里。',
        };
      }
      chosen.push(device);
    }
    return finish(chosen, requireOnline);
  }

  return finish(mine, requireOnline);
}

function finish(devices, requireOnline) {
  const skippedOffline = [];
  const targets = [];
  for (const device of devices) {
    if (requireOnline && device.online === false) {
      // Counted, not dropped silently: "we tried and it was offline" and "we never considered it"
      // produce the same empty result and different fixes.
      skippedOffline.push(device.machine_id);
      continue;
    }
    targets.push(device);
  }
  if (targets.length === 0) {
    return {
      ok: false,
      reason: SCOPE_REFUSAL.NO_DEVICE_IN_FLEET,
      text:
        skippedOffline.length > 0
          ? '这条舰队里的机器当前都不在线。'
          : '这条舰队里没有机器。',
    };
  }
  return { ok: true, targets, skippedOffline };
}

/**
 * Which fleet a pairing code admits to.
 *
 * **The fleet comes from the code, never from the device.** This is the whole of the isolation
 * argument: if a device could name its own fleet it would join any account, and every signature in
 * `auth.mjs` would faithfully attest to a lie. A code with no fleet admits to no fleet, and the
 * pairing is refused rather than defaulted.
 *
 * @param {object} input
 * @param {{fleet_id?: string, used?: boolean, exp?: number}|null} input.code The pairing code record.
 * @param {number} [input.now]
 */
export function fleetFromPairingCode({ code, now = Date.now() }) {
  if (code === null || code === undefined || typeof code !== 'object') {
    return { ok: false, reason: 'unknown_code', text: '配对码无效。' };
  }
  if (code.used === true) return { ok: false, reason: 'code_used', text: '这个配对码已经被使用过了。' };
  if (typeof code.exp === 'number' && Number.isFinite(code.exp) && now >= code.exp) {
    return { ok: false, reason: 'code_expired', text: '配对码已过期。' };
  }
  if (typeof code.fleet_id !== 'string' || code.fleet_id === '') {
    // A relay that issued a fleetless code would be handing out access to a pool with no owner.
    return { ok: false, reason: 'code_has_no_fleet', text: '这个配对码没有绑定舰队，拒绝配对。' };
  }
  return { ok: true, fleetId: code.fleet_id };
}

/**
 * The statement a relay issues for a device that has just paired.
 *
 * Kept here rather than inline in the relay so the fleet that goes into the signature is visibly
 * the fleet that came from the code — one function, one place where that binding is made.
 */
export function statementForDevice({ device, fleetId, sn, now = Date.now(), ttlMs }) {
  return {
    algorithm: 'ed25519',
    // From the pairing code. Not from `device.fleet_id`, which would be the device's own claim.
    fleet_id: fleetId,
    machine_id: device.machineId,
    sn,
    public_key: device.publicKeyPem,
    issued_at_ms: now,
    expires_at_ms: now + (Number.isFinite(ttlMs) ? ttlMs : 90 * 24 * 60 * 60 * 1000),
  };
}
