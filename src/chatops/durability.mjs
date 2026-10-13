/**
 * Durability policy: how many copies exist, where, and what happens as the fleet grows (v0.7.12).
 *
 * ## The requirement, and the trap inside it
 *
 * The stated requirement is **"tolerate losing 90% of nodes and still recover"**, described as
 * "10× redundancy". Those are two different claims, and conflating them produces a system that
 * *looks* compliant and is not:
 *
 *   * **10 replicas** is a property of the *storage layout* — each object is written to 10 places.
 *     It is **impossible** below 10 nodes: there are not 10 places to write to.
 *   * **Surviving 90% loss** is a property of the *whole system*, counting every copy including the
 *     authoritative one. It is achievable below 10 nodes **only because the server holds a complete
 *     copy**.
 *
 * So with 3 machines and a nominal 10× target, the honest statement is:
 *
 * > the devices hold at most 3 copies, and **the 90% guarantee is met by the server's full copy,
 * > not by device redundancy.**
 *
 * That distinction is not pedantry — it changes the design. It means the server is **not "one more
 * replica"** that can be dropped when devices are plentiful; it is the authority, and the tier
 * policy below keeps it complete at every stage.
 *
 * ## The tiers, as specified
 *
 * | devices | primary | server's role |
 * |---|---|---|
 * | < 100 | the server | authority and sole complete copy |
 * | 100 – 1000 | the server, with devices holding copies | authority, refreshed from devices |
 * | > 1000 | the devices | **fallback**, must never be deleted |
 *
 * The thresholds are inclusive-at-the-bottom, so 100 devices is already the middle tier and 1000 is
 * already distributed-primary. Stated because an off-by-one here silently changes where the
 * authority lives.
 */

/** The requirement, as one number: lose this fraction of *all* copies and still recover. */
export const REQUIRED_LOSS_TOLERANCE = 0.9;

/** The nominal replication target. A layout goal, **not** achievable below this many nodes. */
export const NOMINAL_REPLICATION = 10;

/** Where the authority lives. */
export const TIER = Object.freeze({
  /** Fewer than `deviceThreshold` devices: the server is the only complete copy. */
  SERVER: 'server',
  /** Devices keep copies, the server stays authoritative. */
  HYBRID: 'hybrid',
  /** Devices are primary; the server is a fallback that must not be deleted from. */
  DISTRIBUTED: 'distributed',
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** At or above this many devices, devices start holding copies. */
  hybridAt: 100,
  /** At or above this many devices, devices are primary and the server is a fallback. */
  distributedAt: 1000,
});

/**
 * Which tier a fleet of `deviceCount` devices is in.
 *
 * `deviceCount` is **live, paired devices**, not a configured maximum: a fleet of 1000 that is
 * currently 3 machines online is a 3-machine fleet for the purpose of where the authority sits.
 * Using the configured size would move the authority to devices that are not there.
 */
export function tierFor(deviceCount, thresholds = DEFAULT_THRESHOLDS) {
  const n = Number.isFinite(deviceCount) && deviceCount > 0 ? Math.floor(deviceCount) : 0;
  const { hybridAt, distributedAt } = { ...DEFAULT_THRESHOLDS, ...thresholds };
  if (n >= distributedAt) return TIER.DISTRIBUTED;
  if (n >= hybridAt) return TIER.HYBRID;
  return TIER.SERVER;
}

/**
 * The replication factor actually achievable, which is **bounded by the node count**.
 *
 * This is the function the "10×" claim needs and usually does not have: asking for 10 replicas
 * across 3 nodes is not 10 copies, it is 3 copies and a log line. Returning the achievable number
 * means a caller can report the truth instead of the target.
 *
 * @param {object} input
 * @param {number} input.deviceCount Live devices.
 * @param {number} [input.withServer] Whether the server's own copy counts toward the total.
 * @param {number} [input.target] The nominal goal.
 */
export function achievableReplication({ deviceCount, withServer = true, target = NOMINAL_REPLICATION }) {
  const n = Number.isFinite(deviceCount) && deviceCount > 0 ? Math.floor(deviceCount) : 0;
  const places = n + (withServer ? 1 : 0);
  return { requested: target, achievable: Math.min(target, places), places, limitedByNodes: places < target };
}

/**
 * How much of the fleet can be lost while the data is still recoverable.
 *
 * **The recoverable condition is a surviving complete copy**, not "one replica left standing": a
 * replica set is only as good as its ability to reconstruct the whole object. So this counts the
 * server as one complete copy and devices as *partial* copies unless the device set itself holds
 * `target` replicas of every object.
 *
 * Returns a fraction, so the caller compares against `REQUIRED_LOSS_TOLERANCE` rather than
 * re-deriving the arithmetic.
 *
 * @param {object} input
 * @param {number} input.deviceCount Live devices holding copies.
 * @param {boolean} [input.serverComplete] Whether the server holds a complete copy. Defaults true,
 *        and the tier policy requires it at every tier.
 * @param {number} [input.target] Nominal replication goal.
 */
export function lossTolerance({ deviceCount, serverComplete = true, target = NOMINAL_REPLICATION }) {
  const n = Number.isFinite(deviceCount) && deviceCount > 0 ? Math.floor(deviceCount) : 0;
  const { achievable, limitedByNodes } = achievableReplication({ deviceCount: n, withServer: false, target });

  /**
   * The server alone survives the loss of **every** device: it is a complete copy, so 100%.
   *
   * This is what makes the 90% requirement satisfiable at any fleet size — and it is also why the
   * server must never be deleted from. If the server's copy were dropped to save space once devices
   * held copies, the guarantee would vanish exactly when the fleet looked big enough to trust.
   */
  if (serverComplete) {
    return {
      tolerate: 1,
      reason: 'server_complete',
      deviceReplicas: achievable,
      limitedByNodes,
      /** The guarantee holds regardless of device loss, because the server copy is complete. */
      independentOfDevices: true,
    };
  }

  // No complete server copy: the devices must reconstruct from their own replicas, so the fraction
  // that can be lost is bounded by how many copies actually exist.
  if (achievable <= 1) {
    return { tolerate: 0, reason: 'single_copy', deviceReplicas: achievable, limitedByNodes, independentOfDevices: false };
  }
  const tolerate = 1 - 1 / achievable;
  return {
    tolerate,
    reason: 'device_replicas_only',
    deviceReplicas: achievable,
    limitedByNodes,
    independentOfDevices: false,
    /** True when this arrangement actually meets the stated requirement on its own. */
    meetsRequirement: tolerate >= REQUIRED_LOSS_TOLERANCE,
  };
}

/**
 * The whole answer for one fleet, in the shape an operator or a health endpoint wants.
 *
 * Deliberately reports **where the guarantee comes from**. "health: 100%" with no provenance is the
 * reading that lets someone delete the server copy and discover the problem later.
 */
export function durabilityReport({ deviceCount, thresholds = DEFAULT_THRESHOLDS, serverComplete = true, target = NOMINAL_REPLICATION }) {
  const tier = tierFor(deviceCount, thresholds);
  const loss = lossTolerance({ deviceCount, serverComplete, target });
  const replication = achievableReplication({ deviceCount, withServer: false, target });
  return {
    device_count: Number.isFinite(deviceCount) ? Math.floor(deviceCount) : 0,
    tier,
    /** The nominal goal and what the fleet can actually do, side by side. */
    replication_target: target,
    replication_device_copies: replication.achievable,
    replication_limited_by_nodes: replication.limitedByNodes,
    loss_tolerated: loss.tolerate,
    required_loss_tolerance: REQUIRED_LOSS_TOLERANCE,
    meets_required_tolerance: loss.tolerate >= REQUIRED_LOSS_TOLERANCE,
    guarantee_basis: loss.reason,
    server_copy_required: true,
    /** Named so the health number can never be read without its provenance. */
    note:
      loss.reason === 'server_complete'
        ? `the guarantee is the server's complete copy, not device redundancy: with ${Number.isFinite(deviceCount) ? Math.floor(deviceCount) : 0} device(s) `
          + `only ${replication.achievable} device copies exist${replication.limitedByNodes ? `, short of the nominal ${target}` : ''}. `
          + 'Deleting the server copy would remove the guarantee.'
        : 'there is no complete server copy, so recovery depends on the device replicas alone',
  };
}

/**
 * How refreshing should be routed for a tier.
 *
 * The tier decides **who is asked first**, not who is trusted: the server is authoritative in every
 * tier, so a disagreement is resolved by the server rather than by a quorum of devices.
 */
export function refreshPlan({ tier, serverHealthy = true }) {
  if (!serverHealthy) {
    // The server is a fallback that must never be deleted from, so an unhealthy server still gets
    // written to and read from once it returns — the plan says "degraded", not "skip".
    return { order: ['devices', 'server'], degraded: true, reason: 'server_unhealthy' };
  }
  if (tier === TIER.DISTRIBUTED) {
    // Devices are primary for *serving*, the server still receives every write.
    return { order: ['devices', 'server'], degraded: false, reason: 'distributed_primary' };
  }
  if (tier === TIER.HYBRID) {
    return { order: ['server', 'devices'], degraded: false, reason: 'server_primary_with_device_copies' };
  }
  return { order: ['server'], degraded: false, reason: 'server_only' };
}
