import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWebRtcPoolRegistry, WEBRTC_POOL_REGISTRY_CODE } from '../src/plugin/webrtc-pool-registry.mjs';

function makePool(name = 'pool') {
  let stopped = false;
  return {
    name,
    async send() {},
    async stop() {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
  };
}

describe('WebRTC pool registry ownership', () => {
  it('publishes one pool with its first owner and refuses a second pool', () => {
    const registry = createWebRtcPoolRegistry();
    const first = makePool('first');
    const second = makePool('second');

    const published = registry.set(first, { owner: 'dsh-p2p-webrtc' });
    assert.equal(published.ok, true);
    assert.equal(published.reused, false);
    assert.equal(published.owner, 'dsh-p2p-webrtc');
    assert.equal(registry.get(), first);
    assert.deepEqual(registry.state(), {
      pool: first,
      owner: 'dsh-p2p-webrtc',
      ready: true,
      epoch: 1,
    });

    const conflict = registry.set(second, { owner: 'w2m-root' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, WEBRTC_POOL_REGISTRY_CODE.OWNER_CONFLICT);
    assert.equal(conflict.owner, 'dsh-p2p-webrtc');
    assert.equal(registry.get(), first, 'the live pool must not be replaced');
  });

  it('treats republishing the same pool as idempotent and keeps the first owner', () => {
    const registry = createWebRtcPoolRegistry();
    const pool = makePool('shared');

    registry.set(pool, { owner: 'dsh-p2p-webrtc' });
    const again = registry.set(pool, { owner: 'w2m-root' });

    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    assert.equal(again.owner, 'dsh-p2p-webrtc');
    assert.equal(registry.state().epoch, 1);
  });

  it('only lets the owner release or clear the pool', () => {
    const registry = createWebRtcPoolRegistry();
    const pool = makePool('owned');

    registry.set(pool, { owner: 'dsh-p2p-webrtc' });
    const wrong = registry.release('w2m-root', pool);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, WEBRTC_POOL_REGISTRY_CODE.OWNER_CONFLICT);
    assert.equal(registry.get(), pool);

    const cleared = registry.release('dsh-p2p-webrtc', pool);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.released, true);
    assert.equal(registry.get(), null);
    assert.equal(registry.state().ready, false);
  });

  it('rejects a clear from a non-owner and keeps the legacy owner clear working', () => {
    const registry = createWebRtcPoolRegistry();
    const pool = makePool('compat');

    registry.set(pool, { owner: 'dsh-p2p-webrtc' });
    const refused = registry.set(null, { owner: 'w2m-root' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, WEBRTC_POOL_REGISTRY_CODE.OWNER_CONFLICT);
    assert.equal(registry.get(), pool);

    const missingOwner = registry.set(null);
    assert.equal(missingOwner.ok, false, 'an omitted owner means legacy, not "anyone"');
    assert.equal(registry.get(), pool);

    registry.release('dsh-p2p-webrtc', pool);
    const legacy = makePool('legacy');
    registry.set(legacy);
    const legacyClear = registry.set(null);
    assert.equal(legacyClear.ok, true);
    assert.equal(legacyClear.cleared, true);
    assert.equal(registry.get(), null);
  });
});

describe('WebRTC pool registry acquire', () => {
  it('reuses an existing pool without calling the factory', async () => {
    const registry = createWebRtcPoolRegistry();
    const existing = makePool('existing');
    registry.set(existing, { owner: 'dsh-p2p-webrtc' });
    let builds = 0;

    const acquired = await registry.acquire({
      owner: 'w2m-root',
      create: () => {
        builds += 1;
        return makePool('must-not-exist');
      },
    });

    assert.equal(acquired.ok, true);
    assert.equal(acquired.reused, true);
    assert.equal(acquired.pool, existing);
    assert.equal(acquired.owner, 'dsh-p2p-webrtc');
    assert.equal(builds, 0);
  });

  it('builds exactly one pool for concurrent acquirers', async () => {
    const registry = createWebRtcPoolRegistry();
    let builds = 0;
    const create = async () => {
      builds += 1;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      return { ok: true, pool: makePool('concurrent') };
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => registry.acquire({ owner: 'w2m-root', create })),
    );

    assert.equal(builds, 1);
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    const pools = new Set(results.map((result) => result.pool));
    assert.equal(pools.size, 1);
    assert.equal(registry.state().pool, results[0].pool);
    assert.equal(registry.state().owner, 'w2m-root');
  });

  it('returns a named failure when the factory throws or refuses', async () => {
    const registry = createWebRtcPoolRegistry();

    const thrown = await registry.acquire({
      owner: 'w2m-root',
      create: () => {
        throw new Error('engine missing');
      },
    });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.code, WEBRTC_POOL_REGISTRY_CODE.BUILD_FAILED);
    assert.match(thrown.detail, /engine missing/);
    assert.equal(registry.state().pool, null);

    const refused = await registry.acquire({
      owner: 'w2m-root',
      create: () => ({ ok: false, code: 'WEBRTC_POOL_BAD_CONFIG', detail: 'signalUrl missing' }),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'WEBRTC_POOL_BAD_CONFIG');
    assert.match(refused.detail, /signalUrl missing/);
  });
});

describe('WebRTC pool registry late binding', () => {
  it('notifies immediately and on publish/clear, and unsubscribes cleanly', () => {
    const registry = createWebRtcPoolRegistry();
    const seen = [];
    const unsubscribe = registry.subscribe((state) => seen.push(state));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].ready, false);
    assert.equal(seen[0].owner, null);

    const pool = makePool('late');
    registry.set(pool, { owner: 'dsh-p2p-webrtc' });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].ready, true);
    assert.equal(seen[1].pool, pool);
    assert.equal(seen[1].owner, 'dsh-p2p-webrtc');

    registry.release('dsh-p2p-webrtc', pool);
    assert.equal(seen.length, 3);
    assert.equal(seen[2].ready, false);

    unsubscribe();
    registry.set(makePool('after-unsubscribe'), { owner: 'w2m-root' });
    assert.equal(seen.length, 3);
  });

  it('does not let one throwing subscriber break the others', () => {
    const registry = createWebRtcPoolRegistry();
    const seen = [];
    registry.subscribe(() => {
      throw new Error('subscriber failed');
    });
    registry.subscribe((state) => seen.push(state.ready));

    assert.deepEqual(seen, [false]);
    registry.set(makePool('resilient'), { owner: 'w2m-root' });
    assert.deepEqual(seen, [false, true]);
  });
});
