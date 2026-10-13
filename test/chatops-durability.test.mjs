/**
 * Durability policy: replication, loss tolerance, and the tier thresholds (v0.7.12).
 *
 * The property under test is that **the reported guarantee is the real one**. The requirement was
 * stated as "10× redundancy, tolerate losing 90% of nodes", and those are two different claims:
 * replication is a property of the storage layout and is **impossible** to honour below 10 nodes,
 * while loss tolerance counts every copy *including the authoritative one*.
 *
 * So the tests below pin three things that a naive implementation gets wrong:
 *
 *   1. **Replication is bounded by the node count.** Asking for 10 copies across 3 nodes must report
 *      3, not 10. A system that reports the target rather than the truth is how "10× redundant"
 *      ends up meaning "3 copies" without anyone noticing.
 *   2. **The 90% guarantee at small fleet sizes comes from the server's complete copy**, and the
 *      report must say so. A bare "health: 100%" is what lets someone delete that copy.
 *   3. **Recovery needs a *complete* copy, not a surviving replica.** Counting "one node left, so we
 *      are fine" is the classic way an erasure-coded or replicated store loses data it promised to
 *      keep.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER,
  DEFAULT_THRESHOLDS,
  REQUIRED_LOSS_TOLERANCE,
  NOMINAL_REPLICATION,
  tierFor,
  achievableReplication,
  lossTolerance,
  durabilityReport,
  refreshPlan,
} from '../src/chatops/durability.mjs';

describe('replication is bounded by the number of nodes', () => {
  it('reports 3 copies for 10 requested across 3 devices, not 10', () => {
    // The whole point: a target is not an achievement.
    const r = achievableReplication({ deviceCount: 3, withServer: false, target: 10 });
    assert.equal(r.requested, 10);
    assert.equal(r.achievable, 3);
    assert.equal(r.limitedByNodes, true, 'and it says it was limited, so a caller can report the truth');
  });

  it('reaches the nominal target once there are enough places', () => {
    const r = achievableReplication({ deviceCount: 10, withServer: false, target: 10 });
    assert.equal(r.achievable, 10);
    assert.equal(r.limitedByNodes, false);
  });

  it('counts the server as a place only when asked', () => {
    assert.equal(achievableReplication({ deviceCount: 9, withServer: true }).achievable, 10);
    assert.equal(achievableReplication({ deviceCount: 9, withServer: false }).achievable, 9);
  });

  it('never reports more than the target, however many nodes exist', () => {
    // 5000 devices do not mean 5000 copies; the layout goal still governs.
    assert.equal(achievableReplication({ deviceCount: 5000, withServer: false }).achievable, NOMINAL_REPLICATION);
  });

  it('handles zero and nonsense device counts without inventing places', () => {
    for (const n of [0, -5, NaN, undefined, 'x']) {
      const r = achievableReplication({ deviceCount: n, withServer: false });
      assert.equal(r.achievable, 0, `deviceCount ${String(n)} must not yield copies`);
      assert.equal(r.limitedByNodes, true);
    }
  });
});

describe('the 90% tolerance is met by the server copy, and the report says so', () => {
  it('tolerates 100% device loss while the server holds a complete copy', () => {
    const loss = lossTolerance({ deviceCount: 3, serverComplete: true });
    assert.equal(loss.tolerate, 1);
    assert.equal(loss.independentOfDevices, true);
    assert.ok(loss.tolerate >= REQUIRED_LOSS_TOLERANCE);
  });

  it('names the server copy as the basis, not device redundancy', () => {
    // The distinction the whole design rests on. With 3 devices there is no device redundancy that
    // could survive 90% loss, so a report claiming device-based durability would be false.
    const loss = lossTolerance({ deviceCount: 3, serverComplete: true });
    assert.equal(loss.reason, 'server_complete');
    assert.equal(loss.deviceReplicas, 3, 'and it states how few device copies actually exist');
  });

  it('fails the requirement once there is no complete server copy and too few devices', () => {
    // Three devices, no authoritative copy: losing even one leaves 2 replicas and no way to know
    // the object is whole. This is the configuration the tier policy exists to prevent.
    const loss = lossTolerance({ deviceCount: 3, serverComplete: false });
    assert.equal(loss.reason, 'device_replicas_only');
    assert.equal(loss.meetsRequirement, false, '3 replicas cannot tolerate 90% loss');
    assert.ok(loss.tolerate < REQUIRED_LOSS_TOLERANCE);
  });

  it('meets the requirement from devices alone once there are enough of them', () => {
    const loss = lossTolerance({ deviceCount: 10, serverComplete: false });
    assert.equal(loss.meetsRequirement, true);
    assert.equal(loss.tolerate, 0.9, '10 copies: lose 9, one remains');
  });

  it('treats a single copy as zero tolerance rather than "some"', () => {
    const loss = lossTolerance({ deviceCount: 1, serverComplete: false });
    assert.equal(loss.tolerate, 0);
    assert.equal(loss.reason, 'single_copy');
  });

  it('does not claim recovery from a surviving replica when the object cannot be reconstructed', () => {
    // 2 devices, no server: losing one leaves one copy. "One is left" is not recovery of a store
    // that promised 10 replicas — the remaining copy is not known to be complete.
    const loss = lossTolerance({ deviceCount: 2, serverComplete: false });
    assert.equal(loss.meetsRequirement, false);
  });
});

describe('the tiers move the authority, and the thresholds are inclusive at the bottom', () => {
  it('puts the server first below 100 devices', () => {
    for (const n of [1, 3, 50, 99]) assert.equal(tierFor(n), TIER.SERVER, `${n} devices`);
  });

  it('starts the hybrid tier AT 100, not at 101', () => {
    // An off-by-one here silently relocates the authority.
    assert.equal(tierFor(100), TIER.HYBRID);
    assert.equal(tierFor(999), TIER.HYBRID);
  });

  it('starts the distributed tier AT 1000', () => {
    assert.equal(tierFor(1000), TIER.DISTRIBUTED);
    assert.equal(tierFor(5000), TIER.DISTRIBUTED);
  });

  it('treats a missing or nonsense count as a small fleet, not a large one', () => {
    // Failing toward "the server is authoritative" is the safe direction: the alternative would
    // hand authority to devices that may not exist.
    for (const n of [0, -1, NaN, undefined, null, 'many']) assert.equal(tierFor(n), TIER.SERVER, String(n));
  });

  it('accepts different thresholds without changing the shape of the answer', () => {
    assert.equal(tierFor(10, { hybridAt: 10, distributedAt: 100 }), TIER.HYBRID);
    assert.equal(tierFor(100, { hybridAt: 10, distributedAt: 100 }), TIER.DISTRIBUTED);
  });
});

describe('the refresh plan always keeps writing to the server', () => {
  it('orders server-first in the small and hybrid tiers', () => {
    assert.deepEqual(refreshPlan({ tier: TIER.SERVER }).order, ['server']);
    assert.deepEqual(refreshPlan({ tier: TIER.HYBRID }).order, ['server', 'devices']);
  });

  it('orders devices-first in the distributed tier but still writes the server', () => {
    const plan = refreshPlan({ tier: TIER.DISTRIBUTED });
    assert.deepEqual(plan.order, ['devices', 'server']);
    assert.ok(plan.order.includes('server'), 'the server stays a fallback that is written to, never dropped');
  });

  it('degrades rather than skipping the server when the server is unwell', () => {
    const plan = refreshPlan({ tier: TIER.SERVER, serverHealthy: false });
    assert.equal(plan.degraded, true);
    assert.ok(plan.order.includes('server'), 'an unhealthy server is caught up later, not abandoned');
  });
});

describe('the full report cannot be read without its provenance', () => {
  it('reports the target and the achievable copies side by side', () => {
    const r = durabilityReport({ deviceCount: 3 });
    assert.equal(r.replication_target, 10);
    assert.equal(r.replication_device_copies, 3);
    assert.equal(r.replication_limited_by_nodes, true);
    assert.equal(r.tier, TIER.SERVER);
  });

  it('states that the guarantee is the server copy when it is', () => {
    const r = durabilityReport({ deviceCount: 3 });
    assert.equal(r.guarantee_basis, 'server_complete');
    assert.equal(r.meets_required_tolerance, true);
    assert.match(r.note, /server's complete copy/);
    assert.match(r.note, /not device redundancy/);
    assert.match(r.note, /3 device copies/, 'naming the real number');
  });

  it('marks the server copy as required at every fleet size, including the largest', () => {
    // The tier where it is most tempting to drop: devices are primary and plentiful.
    for (const n of [1, 3, 100, 1000, 100000]) {
      assert.equal(durabilityReport({ deviceCount: n }).server_copy_required, true, `${n} devices`);
    }
  });

  it('reports the small-fleet case as compliant and explains why', () => {
    // The requirement IS met at 3 devices — by the server. Reporting "not met" would be as wrong as
    // reporting "met by 10 replicas".
    const r = durabilityReport({ deviceCount: 3 });
    assert.equal(r.meets_required_tolerance, true);
    assert.equal(r.loss_tolerated, 1);
  });

  it('reports the unscoped case honestly when there is no server copy', () => {
    const r = durabilityReport({ deviceCount: 3, serverComplete: false });
    assert.equal(r.meets_required_tolerance, false);
    assert.equal(r.guarantee_basis, 'device_replicas_only');
    assert.match(r.note, /no complete server copy/);
  });
});
