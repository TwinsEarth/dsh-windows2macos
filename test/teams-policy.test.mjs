/**
 * The Teams transport rule, asserted without a socket.
 *
 * The rule is asymmetric on purpose: control is relay TCP with exactly one attempt; bulk data is
 * WebRTC DataChannel with exactly 33 attempts, then an alert and no relay fallback. A test that watched only
 * "eventually delivered" would miss both halves, so every test here checks the channel and, where
 * relevant, that the other sender was never called.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTeamPayload,
  createTeamTransportRouter,
  normalizeTeamTransportPolicy,
  TEAM_CONTROL_CHANNEL,
  TEAM_DATA_CHANNEL,
  TEAM_DATA_MAX_ATTEMPTS,
  TEAM_TRANSPORT_CODE,
} from '../src/plugin/teams/transport-policy.mjs';

describe('teams transport policy', () => {
  it('classifies control kinds as relay-tcp and bulk kinds as webrtc-v1', () => {
    for (const kind of [
      'heartbeat',
      'presence',
      'user_info',
      'roster',
      'plan',
      'approval',
      'lease',
      'council',
      'room_event',
    ]) {
      const route = classifyTeamPayload({ kind });
      assert.equal(route.channel, TEAM_CONTROL_CHANNEL, kind);
      assert.equal(route.max_attempts, 1, kind);
      assert.equal(route.data_plane, false, kind);
    }
    for (const kind of ['file', 'image', 'artifact', 'blob', 'data_sync']) {
      const route = classifyTeamPayload({ kind });
      assert.equal(route.channel, TEAM_DATA_CHANNEL, kind);
      assert.equal(route.max_attempts, TEAM_DATA_MAX_ATTEMPTS, kind);
      assert.equal(route.data_plane, true, kind);
    }
  });

  it('keeps an unknown kind on the reliable path but marks it for review', () => {
    const route = classifyTeamPayload({ kind: 'brand-new-rpc' });
    assert.equal(route.channel, TEAM_CONTROL_CHANNEL);
    assert.equal(route.needs_review, true);
    assert.equal(route.reason, 'unknown-control-fallback');
    assert.equal(classifyTeamPayload({}).needs_review, true);
  });

  it('lowers attempts within 1..33 and never lets configuration raise the ceiling', () => {
    assert.equal(normalizeTeamTransportPolicy({ dataMaxAttempts: 1, dataRetryDelayMs: -5 }).data_max_attempts, 1);
    assert.equal(normalizeTeamTransportPolicy({ dataMaxAttempts: 7 }).data_max_attempts, 7);
    assert.equal(normalizeTeamTransportPolicy({ dataMaxAttempts: 40 }).data_max_attempts, TEAM_DATA_MAX_ATTEMPTS);
    assert.equal(normalizeTeamTransportPolicy({ dataMaxAttempts: 0 }).data_max_attempts, TEAM_DATA_MAX_ATTEMPTS);
    const policy = normalizeTeamTransportPolicy({ dataRetryDelayMs: -5 });
    assert.equal(policy.control_channel, 'relay-tcp');
    assert.equal(policy.data_channel, 'webrtc-v1');
    assert.equal(policy.data_retry_delay_ms, 1000);
  });

  it('honors a lowered attempt count in the bulk loop and in the exhaustion alert', async () => {
    let calls = 0;
    const alerts = [];
    const router = createTeamTransportRouter({
      policy: { dataMaxAttempts: 2, dataRetryDelayMs: 0 },
      sendBulk: async () => {
        calls += 1;
        return { ok: false, code: 'P2P_BLOCKED' };
      },
      onAlert: (notice) => alerts.push(notice),
    });
    const result = await router.bulk({ kind: 'file', bytes: 10 });
    assert.equal(calls, 2);
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.equal(result.alert.attempts, 2);
    assert.equal(alerts.length, 1);
  });

  it('sends control exactly once and never touches the bulk sender', async () => {
    const bulk = [];
    const router = createTeamTransportRouter({
      sendControl: async (payload) => ({ ok: true, id: payload.id }),
      sendBulk: async (payload) => {
        bulk.push(payload);
        return { ok: true };
      },
    });
    const result = await router.control({ kind: 'heartbeat', id: 'h1' });
    assert.deepEqual(result, { ok: true, channel: TEAM_CONTROL_CHANNEL, attempts: 1 });
    assert.equal(bulk.length, 0);
  });

  it('reports a relay failure without retrying it', async () => {
    let calls = 0;
    const router = createTeamTransportRouter({
      sendControl: async () => {
        calls += 1;
        return { ok: false, code: 'RELAY_DOWN' };
      },
    });
    const result = await router.control({ kind: 'presence' });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RELAY_DOWN');
    assert.equal(result.attempts, 1);
  });

  it('delivers bulk on the first successful P2P attempt', async () => {
    let calls = 0;
    const router = createTeamTransportRouter({
      policy: { dataRetryDelayMs: 0 },
      sendBulk: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    const result = await router.bulk({ kind: 'file', bytes: 4096 });
    assert.equal(result.ok, true);
    assert.equal(result.channel, TEAM_DATA_CHANNEL);
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1);
  });

  it('picks up the send on attempt 33 and reports the real attempt count', async () => {
    let calls = 0;
    const router = createTeamTransportRouter({
      policy: { dataRetryDelayMs: 0 },
      sendBulk: async () => {
        calls += 1;
        return calls === TEAM_DATA_MAX_ATTEMPTS ? { ok: true } : { ok: false, code: 'P2P_BLOCKED' };
      },
    });
    const result = await router.bulk({ kind: 'image', bytes: 1024 });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 33);
    assert.equal(calls, 33);
  });

  it('abandons after exactly 33 failed P2P attempts, raises one alert, and never uses the relay', async () => {
    let bulkCalls = 0;
    let controlCalls = 0;
    const alerts = [];
    const router = createTeamTransportRouter({
      policy: { dataRetryDelayMs: 0 },
      sendBulk: async () => {
        bulkCalls += 1;
        return { ok: false, code: 'P2P_BLOCKED' };
      },
      sendControl: async () => {
        controlCalls += 1;
        return { ok: true };
      },
      onAlert: (notice) => alerts.push(notice),
      now: () => 1_750_000_000_000,
    });
    const result = await router.bulk({ kind: 'file', bytes: 10_000_000 });
    assert.equal(bulkCalls, 33);
    assert.equal(controlCalls, 0);
    assert.equal(result.ok, false);
    assert.equal(result.code, TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED);
    assert.equal(result.channel, TEAM_DATA_CHANNEL);
    assert.equal(result.attempts, 33);
    assert.equal(result.alert.code, TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED);
    assert.equal(result.alert.severity, 'error');
    assert.equal(result.alert.attempts, 33);
    assert.equal(result.alert.kind, 'file');
    assert.equal(result.alert.bytes, 10_000_000);
    assert.equal(result.alert.message.includes('relay was not used'), true);
    assert.equal(alerts.length, 1);
  });

  it('does not turn a throwing bulk sender into an unbounded loop', async () => {
    let calls = 0;
    const router = createTeamTransportRouter({
      policy: { dataRetryDelayMs: 0 },
      sendBulk: async () => {
        calls += 1;
        throw new Error('socket closed');
      },
    });
    const result = await router.bulk({ kind: 'blob' });
    assert.equal(calls, 33);
    assert.equal(result.code, TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED);
    assert.equal(result.detail.last_error, 'TEAM_DATA_P2P_ATTEMPT_FAILED');
    assert.equal(result.detail.last_detail, 'socket closed');
  });

  it('refuses a control-looking payload on the bulk path instead of switching channels', async () => {
    let bulkCalls = 0;
    const router = createTeamTransportRouter({
      sendBulk: async () => {
        bulkCalls += 1;
        return { ok: true };
      },
    });
    for (const kind of ['heartbeat', 'brand-new-rpc']) {
      const result = await router.bulk({ kind });
      assert.equal(result.ok, false);
      assert.equal(result.code, TEAM_TRANSPORT_CODE.PAYLOAD_INVALID);
      assert.equal(result.attempts, 0);
    }
    assert.equal(bulkCalls, 0);
  });
});
