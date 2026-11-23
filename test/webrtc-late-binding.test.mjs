/**
 * P3 late binding at the agent boundary.
 *
 * `dsh-p2p-webrtc` mounts after the root row in the production profile. The agent must therefore
 * resolve the shared pool when an operation runs, not when the heartbeat phase is constructed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createViewWebRtcPrepare } from '../src/agent/lifecycle/heartbeat.mjs';

describe('heartbeat viewer WebRTC warm-up late binding', () => {
  it('returns a named code when no pool is published yet', async () => {
    const prepare = createViewWebRtcPrepare({ getWebRtcPool: () => null });
    const result = await prepare('viewer-1');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBRTC_POOL_UNAVAILABLE');
    assert.equal(result.pool_owner, null);
  });

  it('uses the pool that appears after the phase was built', async () => {
    let pool = null;
    const prepared = [];
    const prepare = createViewWebRtcPrepare({
      getWebRtcPool: () => pool,
      getWebRtcPoolState: () => ({ owner: pool === null ? null : 'dsh-p2p-webrtc', ready: pool !== null }),
    });
    assert.equal((await prepare('viewer-1')).code, 'WEBRTC_POOL_UNAVAILABLE');

    pool = {
      async prepare(viewerMachineId) {
        prepared.push(viewerMachineId);
        return { ok: true, peer: 'machine-a', viewer: viewerMachineId };
      },
    };
    const result = await prepare('viewer-2');
    assert.equal(result.ok, true);
    assert.equal(result.pool_owner, 'dsh-p2p-webrtc');
    assert.deepEqual(prepared, ['viewer-2']);
  });

  it('turns a throwing getter into WEBRTC_POOL_UNAVAILABLE instead of an unhandled rejection', async () => {
    const prepare = createViewWebRtcPrepare({
      getWebRtcPool: () => {
        throw new Error('registry exploded');
      },
    });
    const result = await prepare('viewer-3');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBRTC_POOL_UNAVAILABLE');
    assert.match(result.detail, /registry exploded/);
  });
});
