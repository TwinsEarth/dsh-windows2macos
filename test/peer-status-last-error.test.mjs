import test from 'node:test';
import assert from 'node:assert/strict';

import { WebRtcTransportPool } from '../src/agent/webrtc/pool.mjs';

test('peerStatus reports transport diagnostics last_error after a post-start failure', () => {
  const pool = new WebRtcTransportPool({
    machineId: 'receiver-under-test',
    signalUrl: 'ws://signal.invalid',
    resolvePeerKey: async () => ({ key: null, error: null }),
  });

  pool.peers.set('peer-under-test', {
    role: 'host',
    room: 'room-under-test',
    ok: false,
    inflight: null,
    transport: {
      diagnostics: () => ({
        state: 'failed',
        last_error: 'WEBRTC_ICE_FAILED: synthetic ICE failure',
        path: { verdict: 'relay', reason: null, rtt_ms: null },
        secure: { state: 'secure' },
        provider: { ready: true },
        signal_peer: 'peer-under-test',
      }),
    },
    last_error: null,
  });

  const status = pool.peerStatus('peer-under-test');
  assert.equal(status.state, 'failed');
  assert.equal(status.last_error, 'WEBRTC_ICE_FAILED: synthetic ICE failure');
});
