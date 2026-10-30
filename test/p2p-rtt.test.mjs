import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RttEstimator } from '../src/agent/p2p.mjs';

describe('RTT estimator (RFC 6298)', () => {
  it('seeds SRTT/RTTVAR from the first sample', () => {
    const estimator = new RttEstimator({ initialRtoMs: 300 });
    assert.equal(estimator.rtoMs, 300);
    estimator.sample(100);
    assert.equal(estimator.srtt, 100);
    assert.equal(estimator.rttvar, 50);
    assert.equal(estimator.rtoMs, 300, '100 + 4*50');
  });

  it('smooths later samples and clamps to the configured bounds', () => {
    const estimator = new RttEstimator({ initialRtoMs: 300, minRtoMs: 100, maxRtoMs: 3000 });
    estimator.sample(100);
    estimator.sample(200);
    assert.equal(estimator.srtt, 112.5);
    assert.equal(estimator.rttvar, 62.5);
    assert.equal(estimator.rtoMs, 362.5);
    for (let i = 0; i < 100; i += 1) estimator.sample(5000);
    assert.equal(estimator.rtoMs, 3000);
    estimator.reset();
    assert.equal(estimator.rtoMs, 300);
    assert.equal(estimator.srtt, null);
  });

  it('ignores non-finite samples', () => {
    const estimator = new RttEstimator();
    const before = estimator.rtoMs;
    assert.equal(estimator.sample(Number.NaN), before);
    assert.equal(estimator.sample(-1), before);
  });
});
