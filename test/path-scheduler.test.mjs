import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PathScheduler, PATH_KIND, scorePath } from '../src/agent/path-scheduler.mjs';

const path = (id, kind, extra = {}) => ({ id, kind, encrypted: true, firstFrameRttMs: 40, lossRate: 0, ...extra });

describe('PathScheduler', () => {
  it('ranks encrypted paths by type first, then latency and loss', () => {
    const rtt = 40;
    assert.ok(scorePath({ kind: PATH_KIND.IROH_DIRECT, encrypted: true, firstFrameRttMs: rtt }) > scorePath({ kind: PATH_KIND.UDP_DIRECT, encrypted: true, firstFrameRttMs: rtt }));
    assert.ok(scorePath({ kind: PATH_KIND.UDP_DIRECT, encrypted: true, firstFrameRttMs: rtt }) > scorePath({ kind: PATH_KIND.LIBP2P, encrypted: true, firstFrameRttMs: rtt }));
    assert.ok(scorePath({ kind: PATH_KIND.LIBP2P, encrypted: true, firstFrameRttMs: rtt, lossRate: 0 }) > scorePath({ kind: PATH_KIND.LIBP2P, encrypted: true, firstFrameRttMs: rtt, lossRate: 0.5 }));
    assert.equal(scorePath({ kind: PATH_KIND.UDP_DIRECT, encrypted: false }), -1);
  });

  it('switches only after two consecutive better encrypted samples', () => {
    const scheduler = new PathScheduler({ overlapMs: 5000, now: () => 1000 });
    scheduler.setCurrent(path('udp-1', PATH_KIND.UDP_DIRECT, { firstFrameRttMs: 400, lossRate: 0.4 }));
    const challenger = path('iroh-1', PATH_KIND.IROH_DIRECT, { firstFrameRttMs: 20, lossRate: 0 });
    assert.equal(scheduler.observe(challenger), null, 'one sample is not enough');
    const plan = scheduler.observe(challenger);
    assert.ok(plan?.switch, 'two samples must switch');
    assert.equal(plan.to.id, 'iroh-1');
    assert.equal(plan.keepUntilMs, 6000, 'make-before-break keeps the old path for 5s');
  });

  it('never switches to an unencrypted path or a lower-priority type', () => {
    const scheduler = new PathScheduler({ now: () => 0 });
    scheduler.setCurrent(path('udp-1', PATH_KIND.UDP_DIRECT, { firstFrameRttMs: 400 }));
    assert.equal(scheduler.observe({ ...path('plain', PATH_KIND.IROH_DIRECT), encrypted: false }), null);
    const relay = path('relay', PATH_KIND.IROH_RELAY, { firstFrameRttMs: 1, lossRate: 0 });
    scheduler.observe(relay);
    assert.equal(scheduler.observe(relay), null, 'a lower-priority kind must not win');
  });

  it('closes the old path only after the overlap window', () => {
    const scheduler = new PathScheduler({ overlapMs: 5000, now: () => 1000 });
    scheduler.setCurrent(path('udp-1', PATH_KIND.UDP_DIRECT, { firstFrameRttMs: 400, lossRate: 0.4 }));
    const challenger = path('iroh-1', PATH_KIND.IROH_DIRECT, { firstFrameRttMs: 10, lossRate: 0 });
    scheduler.observe(challenger);
    const plan = scheduler.observe(challenger);
    assert.equal(scheduler.breakOld(plan, 2000).ok, false);
    assert.equal(scheduler.breakOld(plan, 6000).ok, true);
  });
});
