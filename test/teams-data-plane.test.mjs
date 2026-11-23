/**
 * Teams data plane: one artifact, the shared WebRTC pool, exactly 33 attempts, no relay.
 *
 * These tests use a fake pool on purpose. The point is not that a DataChannel can carry bytes
 * (the WebRTC suite proves that); it is that the Teams layer spends the policy's full attempt
 * budget and reports exhaustion with an alert instead of quietly promoting the bytes to relay.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  TeamsDataPlane,
  TEAMS_DATA_CODE,
  TEAM_ARTIFACT_CHUNK_BYTES,
  createTeamsDataPlaneFromEnv,
} from '../src/plugin/teams/data-plane.mjs';
import {
  TEAM_DATA_CHANNEL,
  TEAM_TRANSPORT_CODE,
} from '../src/plugin/teams/transport-policy.mjs';
import { TeamsService } from '../src/plugin/teams/service.mjs';
import { buildTools } from '../src/plugin/teams-plugin.mjs';
import { deliverArtifact } from '../src/agent/artifact-delivery.mjs';
import { createDirSink } from '../src/agent/sinks/dir-sink.mjs';

function fakePool(handler, options = {}) {
  const sent = [];
  const listeners = new Set();
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const autoAck = options.autoAck !== false;
  return {
    sent,
    send: async (peer, payload) => {
      sent.push({ peer, payload });
      const result = handler(peer, payload, sent.length);
      if (autoAck && result?.ok === true && payload?.type === 'team.artifact.chunk') {
        queueMicrotask(() => {
          emit({
            peer,
            payload: {
              type: 'team.artifact.ack',
              transfer_id: payload.transfer_id,
              sha256: payload.sha256,
              bytes: payload.bytes,
              ok: true,
            },
            transport: 'webrtc-v1',
          });
        });
      }
      return result;
    },
    onMessage: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit,
    diagnostics: () => ({ peers: 1, sends: sent.length }),
  };
}

describe('teams data plane', () => {
  it('uses the same pool and stops at exactly 33 WebRTC attempts with an alert', async () => {
    const pool = fakePool((_peer, _payload, index) => {
      return index <= 33 ? { ok: false, code: 'WEBRTC_SEND_FAILED' } : { ok: true };
    });
    const alerts = [];
    const plane = new TeamsDataPlane({
      pool,
      dataRetryDelayMs: 0,
      onAlert: (notice) => alerts.push(notice),
      now: () => 1_750_000_000_000,
    });

    const result = await plane.sendArtifact({
      peer: 'machine-b',
      bytes: Buffer.from('one artifact'),
      taskId: 'task-1',
      kind: 'artifact',
      name: 'note.txt',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED);
    assert.equal(result.transport, 'webrtc-v1');
    assert.equal(result.channel, TEAM_DATA_CHANNEL);
    assert.equal(result.attempts, 33);
    assert.equal(result.alert.code, TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED);
    assert.equal(result.alert.attempts, 33);
    assert.equal(result.alert.channel, TEAM_DATA_CHANNEL);
    assert.equal(alerts.length, 1);
    assert.equal(pool.sent.length, 33);
    assert.equal(pool.sent.every((entry) => entry.peer === 'machine-b'), true);
  });

  it('reports the real attempt count when attempt 33 succeeds', async () => {
    const pool = fakePool((_peer, _payload, index) => {
      return index <= 32 ? { ok: false, code: 'WEBRTC_NOT_READY' } : { ok: true };
    });
    const plane = new TeamsDataPlane({ pool, dataRetryDelayMs: 0 });
    const result = await plane.sendArtifact({ peer: 'machine-b', bytes: Buffer.from('x') });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 33);
    assert.equal(result.transport, 'webrtc-v1');
    assert.equal(result.channel, TEAM_DATA_CHANNEL);
  });

  it('fails with an explicit ACK timeout instead of claiming the bytes landed', async () => {
    const pool = fakePool(() => ({ ok: true }), { autoAck: false });
    const plane = new TeamsDataPlane({ pool, dataRetryDelayMs: 0, ackTimeoutMs: 50 });
    const result = await plane.sendArtifact({ peer: 'machine-b', bytes: Buffer.from('unconfirmed') });
    assert.equal(result.ok, false);
    assert.equal(result.code, TEAMS_DATA_CODE.ACK_TIMEOUT);
    assert.equal(result.alert.code, TEAMS_DATA_CODE.ACK_TIMEOUT);
    assert.equal(result.alert.relay_used, false);
    assert.equal(result.attempts, 1);
    assert.equal(pool.sent.length, 1);
  });

  it('chunks a large artifact and verifies it at the receiver sink', async () => {
    const pool = fakePool(() => ({ ok: true }));
    const root = mkdtempSync(join(tmpdir(), 'w2m-team-sink-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-team-state-'));
    const sink = createDirSink({ root });
    const plane = new TeamsDataPlane({ pool, stateDir, sink, dataRetryDelayMs: 0 });
    const events = [];
    plane.onEvent((event) => events.push(event));
    const payload = Buffer.alloc(TEAM_ARTIFACT_CHUNK_BYTES + 512, 0x41);
    const sent = await plane.sendArtifact({
      peer: 'machine-b',
      bytes: payload,
      taskId: 'task-large',
      kind: 'file',
      name: 'large.bin',
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.chunks, 2);
    assert.equal(sent.attempts, 2);

    for (const entry of pool.sent) {
      pool.emit({ peer: entry.peer, payload: entry.payload, transport: 'webrtc-v1' });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const received = events.find((event) => event.type === 'artifact-received');
    assert.ok(received, JSON.stringify(events));
    assert.equal(received.delivered.ok, true);
    assert.equal(received.sha256, sent.sha256);
  });

  it('loads the configured dir sink from stateDir when no sink is injected', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-team-config-sink-'));
    const root = mkdtempSync(join(tmpdir(), 'w2m-team-config-root-'));
    mkdirSync(join(stateDir, 'dataplane'), { recursive: true });
    writeFileSync(
      join(stateDir, 'dataplane', 'sink.json'),
      JSON.stringify({ kind: 'dir', root }) + '\n',
      'utf8',
    );
    const pool = fakePool(() => ({ ok: true }));
    const plane = new TeamsDataPlane({ pool, stateDir, dataRetryDelayMs: 0 });
    assert.equal(plane.sink?.kind, 'dir');

    const explicitNone = new TeamsDataPlane({ pool, stateDir, sink: null });
    assert.equal(explicitNone.sink, null);
  });

  it('refuses without a pool instead of producing a relay send', async () => {
    const plane = new TeamsDataPlane({ pool: null });
    const result = await plane.sendArtifact({ peer: 'machine-b', bytes: Buffer.from('x') });
    assert.equal(result.ok, false);
    assert.equal(result.code, TEAMS_DATA_CODE.POOL_REQUIRED);
  });

  it('wires deliverArtifact to the remote sink path and returns webrtc-v1 on success', async () => {
    const pool = fakePool(() => ({ ok: true }));
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-team-artifact-ok-'));
    const plane = new TeamsDataPlane({ pool, stateDir, dataRetryDelayMs: 0 });
    const sent = await deliverArtifact({
      stateDir,
      dataPlane: plane,
      peer: 'machine-b',
      taskId: 'task-remote-ok',
      kind: 'artifact',
      name: 'remote.txt',
      bytes: Buffer.from('remote bytes'),
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.transport, 'webrtc-v1');
    assert.equal(sent.channel, 'webrtc-v1');
    assert.equal(pool.sent.length, 1);
  });

  it('wires deliverArtifact to the remote sink path and surfaces the same failure code', async () => {
    const pool = fakePool(() => ({ ok: false, code: 'WEBRTC_SEND_FAILED' }));
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-team-artifact-state-'));
    const plane = new TeamsDataPlane({ pool, stateDir, dataRetryDelayMs: 0 });
    const sent = await deliverArtifact({
      stateDir,
      dataPlane: plane,
      peer: 'machine-b',
      taskId: 'task-remote',
      kind: 'artifact',
      name: 'remote.txt',
      bytes: Buffer.from('remote bytes'),
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.code, TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED);
    assert.equal(sent.transport, 'webrtc-v1');
    assert.equal(sent.alert.code, TEAM_TRANSPORT_CODE.DATA_P2P_EXHAUSTED);
    assert.equal(pool.sent.length, 33);
  });

  it('TeamsService delegates bulk sends to the attached data plane', async () => {
    const pool = fakePool(() => ({ ok: true }));
    const plane = new TeamsDataPlane({ pool, dataRetryDelayMs: 0 });
    const service = new TeamsService(
      { state_dir: '', stale_after_ms: 90_000, data_retry_delay_ms: 0 },
      { dataPlane: plane, requestImpl: async () => ({ ok: false, code: 'TEAM_RELAY_REQUIRED' }) },
    );
    const sent = await service.sendArtifact({ peer: 'machine-b', bytes: Buffer.from('delegated') });
    assert.equal(sent.ok, true);
    assert.equal(sent.channel, 'webrtc-v1');
  });

  it('the CLI factory refuses to guess a signal URL or provider command', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-team-env-'));
    const built = createTeamsDataPlaneFromEnv({ env: {}, stateDir });
    assert.equal(built.ok, false);
    assert.equal(built.code, 'TEAM_DATA_PLANE_NOT_CONFIGURED');
  });

  it('w2m_team_artifact reads the file and delegates to the service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-team-tool-'));
    const file = join(dir, 'artifact.bin');
    writeFileSync(file, Buffer.from('tool bytes'));
    let seen = null;
    const definitions = buildTools({
      service: {
        sendArtifact: async (input) => {
          seen = input;
          return { ok: true, transport: 'webrtc-v1', bytes: input.bytes.length };
        },
      },
      defineTool: (definition) => definition,
      output: { type: 'json' },
    });
    const tool = definitions.find((definition) => definition.name === 'w2m_team_artifact');
    assert.ok(tool);
    const result = JSON.parse(await tool.execute({ peer: 'machine-b', path: file, kind: 'file' }));
    assert.equal(result.ok, true);
    assert.equal(result.transport, 'webrtc-v1');
    assert.equal(seen.peer, 'machine-b');
    assert.equal(seen.kind, 'file');
    assert.equal(seen.bytes.toString('utf8'), 'tool bytes');
  });
});
