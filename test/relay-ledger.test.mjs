import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeliverPhase } from '../src/agent/lifecycle/deliver.mjs';

test('WebRTC result exhaustion never suppresses the relay ledger', async () => {
  const resultCalls = [];
  const phase = createDeliverPhase({
    log: () => {},
    identity: { machine_id: 'machine-under-test' },
    platform: 'linux',
    caps: {},
    state: {},
    spool: {
      saveEnvelope: () => {},
      ack: () => {},
      pendingResults: () => [],
    },
    stateDir: '/tmp',
    project: null,
    baseUrl: 'http://relay.invalid',
    options: {
      webrtcPool: {
        send: async () => ({ ok: false, code: 'WEBRTC_SEND_FAILED', detail: 'synthetic send failure' }),
        diagnostics: () => ({}),
      },
      webrtcDataMaxAttempts: 33,
      webrtcAckTimeoutMs: 1,
      webrtcRetryDelayMs: 0,
      webrtcResultBudgetMs: 5_000,
    },
    p2pMode: 'relay',
    deviceKey: null,
    deviceKeyError: null,
    deviceKeyMigratedFrom: null,
    peerKeys: null,
    onP2PStatus: null,
    p2pPort: 0,
    p2pPortError: null,
    p2pAckTimeoutMs: 1,
    p2pChannelLingerMs: 1,
    redactOutput: (value) => value,
    tmpDir: '/tmp',
    objectMode: false,
    toolchainInfo: async () => ({}),
    http: {
      postJson: async () => ({ ok: true }),
      postJsonWithRetry: async (path, body) => {
        resultCalls.push({ path, body });
        return { ok: true, status: 200 };
      },
      relayErrorCode: () => null,
      getJson: async () => ({}),
    },
  });

  const webRtc = await phase.sendResultWebRtc('task-ledger', 'dispatcher');
  assert.equal(webRtc.delivered, false);
  assert.equal(webRtc.attempts, 33);

  const delivered = await phase.deliver({
    task_id: 'task-ledger',
    attempt: 1,
    dedupe_key: 'dedupe-ledger',
    status: 'success',
    transport: 'relay',
    p2p: { result_path: 'relay' },
  });

  assert.equal(delivered, true);
  assert.equal(resultCalls.length, 1);
  assert.equal(resultCalls[0].path, '/v1/result');
  assert.equal(resultCalls[0].body.task_id, 'task-ledger');
});
