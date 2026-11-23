/**
 * `deliver.mjs` transport scheduling: WebRTC first, UDP direct second, relay ledger always.
 *
 * The WebRTC pool is a fake here because this test is about the scheduler and the frame routing,
 * not the engine. The pool's own real-signaling test lives in `test/p2p-webrtc-pool.test.mjs`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDeliverPhase } from '../src/agent/lifecycle/deliver.mjs';

// The production waiter timer is deliberately unref'd so an idle agent can exit. A test whose only
// pending work is that waiter therefore needs one ref'd handle to keep the loop alive.
const keepAlive = setInterval(() => {}, 1_000);
process.on('exit', () => clearInterval(keepAlive));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-deliver-webrtc-'));
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold the directory a little longer */
    }
  });
  return dir;
}

function makeDeliver(pool, overrides = {}) {
  const dir = scratch();
  const frames = [];
  let settleAck = () => {};
  const deps = {
    log: () => {},
    identity: { machine_id: 'machine-b', machine_name: 'B', device_token: 'test-token' },
    platform: { os: 'windows', os_version: '10.0', arch: 'x64', shell: 'pwsh', shell_version: '7' },
    caps: {},
    state: {},
    spool: { saveEnvelope: () => {}, ack: () => {} },
    stateDir: dir,
    project: dir,
    baseUrl: 'http://127.0.0.1:1',
    options: {
      webrtcPool: pool,
      webrtcDataMaxAttempts: 3,
      webrtcAckTimeoutMs: 80,
      webrtcRetryDelayMs: 5,
      webrtcResultBudgetMs: 500,
      ...overrides,
    },
    p2pMode: 'relay',
    deviceKey: null,
    deviceKeyError: null,
    deviceKeyMigratedFrom: null,
    peerKeys: new Map(),
    onP2PStatus: () => {},
    p2pPort: null,
    p2pPortError: null,
    p2pAckTimeoutMs: 80,
    p2pChannelLingerMs: 0,
    redactOutput: true,
    tmpDir: dir,
    objectMode: 'temp',
    toolchainInfo: async () => ({}),
    http: {
      postJson: async () => ({ ok: true }),
      postJsonWithRetry: async () => ({ ok: true }),
      relayErrorCode: () => null,
      getJson: async () => ({ json: {} }),
    },
    heartbeat: {
      handleP2PMessage: (event) => {
        frames.push(event);
        try {
          const frame = JSON.parse(Buffer.from(event.payload).toString('utf8'));
          // Mirror `heartbeat.mjs`'s `result.ack` branch: only a direct-path ack settles the waiter.
          if (frame?.type === 'result.ack' && event.channel?.transport === 'p2p') {
            settleAck(frame.task_id);
          }
        } catch {
          /* the offer test does not need a parse failure path */
        }
      },
    },
  };
  const deliver = createDeliverPhase(deps);
  settleAck = deliver.settleResultAck;
  return { deliver, frames };
}

/** A pool whose `send` can acknowledge one frame, ignore it, or fail outright. */
function fakePool({ ack = true, failCode = null } = {}) {
  const sent = [];
  let handler = null;
  return {
    sent,
    onMessage(fn) {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    async send(peer, payload) {
      const frame = JSON.parse(payload.toString());
      sent.push({ peer, frame });
      if (failCode !== null) return { ok: false, code: failCode, detail: `${failCode} test` };
      if (ack && handler !== null) {
        queueMicrotask(() => {
          handler({ peer, payload: Buffer.from(JSON.stringify({ type: 'result.ack', task_id: frame.task_id })) });
        });
      }
      return { ok: true, peer, bytes: payload.length };
    },
    diagnostics() {
      return {
        ok: true,
        signal_url: 'wss://signal.example/w2m?token=<redacted>',
        peer_count: 1,
        peers: [{ peer: 'machine-a', role: 'host', ok: true, path: 'direct' }],
        stats: { sends: sent.length },
      };
    },
    emit(event) {
      if (handler !== null) handler(event);
    },
    async stop() {
      return { ok: true };
    },
  };
}

function offer(taskId = 'task-1') {
  return {
    task_id: taskId,
    origin_machine_id: 'machine-a',
    p2p: { mode: 'auto' },
  };
}

describe('deliver.mjs WebRTC transport scheduling', () => {
  it('uses WebRTC first and reports the exact stack', async () => {
    const pool = fakePool();
    const { deliver } = makeDeliver(pool);
    deliver.attachWebRtc();
    const mark = await deliver.planDirectDelivery(offer('webrtc-1'));
    assert.equal(mark.path, 'p2p');
    assert.equal(mark.transport, 'webrtc-v1');
    assert.equal(mark.attempts, 1);
    assert.equal(pool.sent.length, 1);
    assert.deepEqual(pool.sent[0].frame, {
      type: 'task.result',
      task_id: 'webrtc-1',
      machine_id: 'machine-b',
      transport: 'webrtc-v1',
    });
    assert.equal(deliver.webrtcStatusSnapshot().stats.delivered, 1);
    await deliver.closeP2P();
  });

  it('retries a missing ack up to the attempt cap and reports a named failure', async () => {
    const pool = fakePool({ ack: false });
    const { deliver } = makeDeliver(pool);
    deliver.attachWebRtc();
    const mark = await deliver.planDirectDelivery(offer('webrtc-2'));
    assert.equal(mark.path, null);
    assert.equal(mark.transport, null);
    assert.equal(mark.attempts, 3);
    assert.match(mark.error, /WEBRTC_ACK_TIMEOUT/);
    assert.equal(pool.sent.length, 3);
    await deliver.closeP2P();
  });

  it('falls back to the UDP channel after WebRTC fails, and keeps the fallback fact', async () => {
    const pool = fakePool({ ack: false });
    const { deliver } = makeDeliver(pool, { webrtcDataMaxAttempts: 1 });
    deliver.attachWebRtc();
    const channel = {
      peer: { machine_id: 'machine-a', address: '127.0.0.1', port: 41000 },
      session: 7,
      encryption: { encrypted: true, epoch: 0 },
      on: () => channel,
      removeListener: () => channel,
      send: async (payload) => {
        const frame = JSON.parse(payload.toString());
        queueMicrotask(() => deliver.settleResultAck(frame.task_id));
        return { ok: true };
      },
    };
    deliver.rememberChannel('udp-1', channel);
    const mark = await deliver.planDirectDelivery(offer('udp-1'));
    assert.equal(mark.path, 'p2p');
    assert.equal(mark.transport, 'udp-v1');
    assert.equal(mark.fallback_from, 'webrtc-v1');
    assert.equal(mark.attempts, 1);
    assert.equal(pool.sent.length, 1);
    await deliver.closeP2P();
  });

  it('does not retry a deterministic pool refusal', async () => {
    const pool = fakePool({ failCode: 'WEBRTC_POOL_PEER_KEY_MISSING' });
    const { deliver } = makeDeliver(pool, { webrtcDataMaxAttempts: 33 });
    deliver.attachWebRtc();
    const mark = await deliver.planDirectDelivery(offer('webrtc-3'));
    assert.equal(mark.path, null);
    assert.equal(mark.attempts, 1);
    assert.match(mark.error, /PEER_KEY_MISSING/);
    assert.equal(pool.sent.length, 1);
    await deliver.closeP2P();
  });

  it('routes a task.offer from WebRTC into the existing P2P frame handler', async () => {
    const pool = fakePool();
    const { deliver, frames } = makeDeliver(pool);
    deliver.attachWebRtc();
    pool.emit({
      peer: 'machine-a',
      payload: Buffer.from(JSON.stringify({
        type: 'task.offer',
        task_id: 'webrtc-offer-1',
        origin_machine_id: 'machine-a',
        p2p: { mode: 'auto' },
      })),
    });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].peer.machine_id, 'machine-a');
    assert.equal(frames[0].channel.transport, 'p2p');
    assert.equal(frames[0].channel.stack, 'webrtc-v1');
    assert.equal(frames[0].channel.encryption.encrypted, true);
    assert.equal(deliver.channelFor('webrtc-offer-1')?.stack, 'webrtc-v1');
    await deliver.closeP2P();
  });

  it('routes a result.ack from WebRTC into the shared waiter', async () => {
    const pool = fakePool({ ack: false });
    const { deliver } = makeDeliver(pool);
    deliver.attachWebRtc();
    const pending = deliver.sendResultWebRtc('webrtc-ack-1', 'machine-a');
    // The pool has sent but not acknowledged; the frame handler is what settles it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    pool.emit({
      peer: 'machine-a',
      payload: Buffer.from(JSON.stringify({ type: 'result.ack', task_id: 'webrtc-ack-1' })),
    });
    const result = await pending;
    assert.equal(result.delivered, true, JSON.stringify(result));
    assert.ok(result.attempts >= 1);
    await deliver.closeP2P();
  });
});
