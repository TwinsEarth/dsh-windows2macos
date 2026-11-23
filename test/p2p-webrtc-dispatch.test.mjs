/**
 * Dispatch-side transport order: the offer goes over WebRTC first, the old UDP dial second, and the
 * relay ledger is never conditional on either.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pushOfferBestPath, pushOffers, resolveDispatchWebRtcPool } from '../src/plugin/tools/dispatch.mjs';

function frameFor(machineId = 'machine-a') {
  return {
    type: 'task.offer',
    task_id: 'task-push-1',
    machine_id: machineId,
    origin_machine_id: 'machine-origin',
    p2p: { mode: 'auto' },
  };
}

function fakePool({ failCode = null } = {}) {
  const sent = [];
  return {
    sent,
    async send(peer, payload) {
      sent.push({ peer, frame: JSON.parse(payload.toString()) });
      if (failCode !== null) return { ok: false, code: failCode, detail: `${failCode} test` };
      return { ok: true, peer, bytes: payload.length };
    },
  };
}

function fakeNode({ fail = false } = {}) {
  const dials = [];
  const sent = [];
  return {
    dials,
    sent,
    peerKeys: new Map(),
    async dial(machineId, options) {
      dials.push({ machineId, options });
      if (fail) return { ok: false, error: 'P2P_NO_CANDIDATES: no announcement' };
      return {
        ok: true,
        session: 9,
        reused: false,
        channel: {
          send: async (payload) => {
            sent.push({ machineId, frame: JSON.parse(payload.toString()) });
          },
          close: () => {},
          encryption: { encrypted: false, reason: null },
        },
      };
    },
  };
}

describe('dispatch offer transport order', () => {
  it('prefers WebRTC and never dials UDP when the data channel accepts', async () => {
    const pool = fakePool();
    const node = fakeNode();
    const result = await pushOfferBestPath(node, pool, frameFor(), {});
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'webrtc-v1');
    assert.equal(result.fallback_from, null);
    assert.equal(result.failure_code, undefined, 'the transport helper leaves failure_code to the lease report');
    assert.equal(pool.sent.length, 1);
    assert.equal(pool.sent[0].frame.type, 'task.offer');
    assert.equal(pool.sent[0].frame.task_id, 'task-push-1');
    assert.equal(node.dials.length, 0, 'a WebRTC delivery must not also dial UDP');
  });

  it('falls back to the UDP dial and records both facts when WebRTC refuses', async () => {
    const pool = fakePool({ failCode: 'WEBRTC_POOL_PEER_KEY_MISSING' });
    const node = fakeNode();
    const result = await pushOfferBestPath(node, pool, frameFor(), {});
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'udp-v1');
    assert.equal(result.fallback_from, 'webrtc-v1');
    assert.match(result.webrtc_error, /PEER_KEY_MISSING/);
    assert.equal(pool.sent.length, 1);
    assert.equal(node.dials.length, 1);
    assert.equal(node.sent.length, 1, 'the offer still reaches the executor over UDP');
  });

  it('keeps the old UDP-only behaviour when no pool was built', async () => {
    const node = fakeNode();
    const result = await pushOfferBestPath(node, null, frameFor(), {});
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'udp-v1');
    assert.equal(result.fallback_from, null, 'nothing was tried before UDP, so nothing was fallen back from');
    assert.equal(node.dials.length, 1);
  });

  it('names the refusal when neither transport exists, and names relay as the delivery path', async () => {
    const result = await pushOfferBestPath(null, null, frameFor(), {});
    assert.equal(result.ok, false);
    assert.equal(result.transport, 'relay', 'the relay SSE offer is what remains, so it is the transport');
    assert.match(result.error, /P2P_UNAVAILABLE/);
    assert.equal(result.fallback_from, null);
  });

  it('reports relay when the WebRTC pool and the UDP dial both fail', async () => {
    const pool = fakePool({ failCode: 'WEBRTC_POOL_PEER_KEY_MISSING' });
    const node = fakeNode({ fail: true });
    const result = await pushOfferBestPath(node, pool, frameFor(), {});
    assert.equal(result.ok, false);
    assert.equal(result.transport, 'relay');
    assert.equal(result.fallback_from, 'webrtc-v1');
    assert.match(result.reason_code, /P2P_NO_CANDIDATES/);
    assert.equal(node.dials.length, 1, 'the legacy path was actually attempted');
  });

  it('pushOffers uses WebRTC for every runnable lease and leaves refused leases alone', async () => {
    const pool = fakePool();
    const node = fakeNode();
    const payload = {
      mode: 'direct',
      command_argv: ['node', '--version'],
      cwd_rel: '.',
      index_total: 1,
      write: false,
      timeout_ms: 1000,
      requirements: {},
      compare_policy: {},
      p2p: { mode: 'auto' },
    };
    const pushes = await pushOffers(node, {
      taskId: 'task-push-2',
      leases: [
        { machine_id: 'machine-a', index: 0, state: 'offered', attempt: 1 },
        { machine_id: 'machine-b', index: 1, state: 'observing', attempt: 1 },
      ],
      payload,
      originMachineId: 'machine-origin',
      webrtcPool: pool,
    });
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0].ok, true);
    assert.equal(pushes[0].transport, 'webrtc-v1');
    assert.equal(pushes[0].failure_code, null);
    assert.equal(pushes[0].relay_fallback, false);
    assert.equal(pushes[1].ok, false);
    assert.equal(pushes[1].transport, 'relay', 'a lease the relay did not hand over is delivered by the relay ledger');
    assert.equal(pushes[1].reason_code, 'P2P_LEASE_NOT_RUNNABLE');
    assert.equal(pushes[1].failure_code, 'P2P_LEASE_NOT_RUNNABLE');
    assert.equal(pushes[1].relay_fallback, true);
    assert.equal(pool.sent.length, 1, 'only the runnable lease is pushed');
    assert.equal(node.dials.length, 0);
  });
});

describe('dispatch WebRTC pool late binding', () => {
  it('prefers the live registry over the mount-time snapshot once the provider publishes', () => {
    const snapshot = { name: 'mount-time' };
    const published = { name: 'dsh-p2p-webrtc' };
    let live = null;
    assert.equal(resolveDispatchWebRtcPool(() => live, snapshot), snapshot);
    live = published;
    assert.equal(resolveDispatchWebRtcPool(() => live, snapshot), published);
  });

  it('returns null when neither the registry nor the snapshot has a pool', () => {
    assert.equal(resolveDispatchWebRtcPool(() => null, null), null);
  });
});
