/**
 * v1.6.6 — relay failover thresholds and direction.
 *
 * The asymmetric hysteresis is the whole safety property: leaving the active relay takes 3 failed
 * probes, returning to the primary takes 5 healthy ones, and neither happens without a reachable
 * destination. These cases pin each boundary, including the "no alternative" and "flapping primary"
 * shapes that a naive counter gets wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FAILOVER_DEFAULTS, createRelayFailover, relayPool } from '../src/plugin/relay-failover.mjs';

const PRIMARY = 'http://primary:8787';
const BACKUP = 'http://backup:8787';

describe('relay failover (v1.6.6)', () => {
  it('builds a deduplicated ordered pool with rabbitUrl first', () => {
    assert.deepEqual(relayPool({ rabbitUrl: 'http://a:1/', relayUrls: ['http://a:1', 'http://b:2'] }), ['http://a:1', 'http://b:2']);
    assert.deepEqual(relayPool({ relayUrls: ['http://b:2'] }), ['http://b:2']);
    assert.deepEqual(relayPool({}), []);
    assert.throws(() => createRelayFailover({ pool: [] }), /at least one/);
  });

  it('switches only after 3 consecutive failed probes, and not without a reachable alternative', () => {
    const failover = createRelayFailover({ pool: [PRIMARY, BACKUP], now: () => 1000 });
    assert.deepEqual(failover.assess({ [PRIMARY]: false, [BACKUP]: true }), { action: 'stay', active: PRIMARY });
    assert.equal(failover.snapshot().failures, 1);
    failover.assess({ [PRIMARY]: true, [BACKUP]: true });
    assert.equal(failover.snapshot().failures, 0, 'one good probe resets the streak');
    failover.assess({ [PRIMARY]: false, [BACKUP]: true });
    failover.assess({ [PRIMARY]: false, [BACKUP]: true });
    assert.equal(failover.assess({ [PRIMARY]: false, [BACKUP]: true }).action, 'switch');

    const stranded = createRelayFailover({ pool: [PRIMARY, BACKUP] });
    for (let i = 0; i < FAILOVER_DEFAULTS.failuresToSwitch; i += 1) stranded.assess({ [PRIMARY]: false, [BACKUP]: false });
    assert.equal(stranded.snapshot().active, PRIMARY, 'no reachable alternative means stay');
    assert.equal(stranded.snapshot().failures, 3);
  });

  it('returns to the primary after 5 healthy probes, but a flapping primary cannot pull it back', () => {
    const failover = createRelayFailover({ pool: [PRIMARY, BACKUP] });
    for (let i = 0; i < 3; i += 1) failover.assess({ [PRIMARY]: false, [BACKUP]: true });
    assert.equal(failover.snapshot().active, BACKUP);

    // Primary recovers for 4 rounds: not enough.
    for (let i = 0; i < 4; i += 1) failover.assess({ [PRIMARY]: true, [BACKUP]: true });
    assert.equal(failover.snapshot().active, BACKUP);
    assert.equal(failover.snapshot().primary_successes, 4);

    const decided = failover.assess({ [PRIMARY]: true, [BACKUP]: true });
    assert.equal(decided.action, 'switch');
    assert.equal(decided.target, PRIMARY);
    assert.equal(failover.snapshot().switches, 2);
    assert.equal(failover.snapshot().history.length, 2);
  });

  it('reports where it is and why it last moved, for w2m_status', () => {
    const failover = createRelayFailover({ pool: [PRIMARY, BACKUP], now: () => 42 });
    for (let i = 0; i < 3; i += 1) failover.assess({ [PRIMARY]: false, [BACKUP]: true });
    const snapshot = failover.snapshot();
    assert.equal(snapshot.active, BACKUP);
    assert.equal(snapshot.primary, PRIMARY);
    assert.equal(snapshot.last_switch_at_ms, 42);
    assert.match(snapshot.last_reason, /failed 3 consecutive probes/);
    assert.equal(snapshot.failures_to_switch, 3);
    assert.equal(snapshot.successes_to_return, 5);
  });

  it('accepts custom thresholds and a Map of health results', () => {
    const failover = createRelayFailover({ pool: [PRIMARY, BACKUP], failuresToSwitch: 1, successesToReturn: 1 });
    const health = new Map([[PRIMARY, false], [BACKUP, true]]);
    assert.equal(failover.assess(health).action, 'switch');
    assert.equal(failover.assess(new Map([[PRIMARY, true], [BACKUP, true]])).action, 'switch');
    assert.equal(failover.snapshot().active, PRIMARY);
  });
});
