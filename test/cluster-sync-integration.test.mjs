/**
 * Relay v3.0.0 cluster sync — three-relay integration test.
 *
 * Starts three real `RelayServer` instances on OS-assigned ports with separate state directories and
 * makes them peers of each other, then exercises the actual HTTP pull path (not the unit-test fake):
 *
 *   1. a device registered on B and a task created on B become visible on A/C after one tick;
 *   2. healthz advertises `relay-cluster-sync-v1` and the cluster diagnostics;
 *   3. the peer routes refuse unsigned requests and accept a correctly signed one;
 *   4. a restart replays the imported ledger before the next sync, and resumes from disk;
 *   5. a peer with the wrong cluster secret is refused and recorded, while a healthy peer still syncs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createRelayServer } from '../src/relay/server.mjs';
import { clusterAuthToken, normalizeClusterConfig } from '../src/relay/cluster-sync.mjs';

const SECRET = Buffer.alloc(32, 9);
const OTHER_SECRET = Buffer.alloc(32, 11);
const NODE = {
  a: 'node-aaaaaaaa',
  b: 'node-bbbbbbbb',
  c: 'node-cccccccc',
};

async function startRelay(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const relay = createRelayServer({ stateDir: dir, logger: null });
  const info = await relay.listen({ host: '127.0.0.1', port: 0 });
  return { relay, dir, url: `http://127.0.0.1:${info.port}` };
}

function clusterConfig({ nodeId, peers, secret = SECRET }) {
  return normalizeClusterConfig({
    enabled: true,
    nodeId,
    secret: secret.toString('base64'),
    peers,
    intervalMs: 3_600_000,
    bootMinMs: 60_000,
    bootMaxMs: 600_000,
    jitterMs: 300_000,
  });
}

function attach(relay, { nodeId, peers, secret = SECRET }) {
  relay.attachCluster(clusterConfig({ nodeId, peers, secret }));
}

async function stopAll(relays) {
  for (const relay of relays) {
    try { await relay.close(); } catch { /* already closed */ }
  }
}

function seedDevice(relay, device) {
  relay.state.mergeClusterDevices([device]);
}

function seedTask(relay, taskId, createdAtMs = 1_800_000_000_000) {
  relay.persistence.append({
    ts: '2026-01-01T00:00:00Z',
    type: 'task.created',
    task: {
      task_id: taskId,
      mode: 'replicate',
      command_argv: ['node', '-v'],
      cwd_rel: '.',
      index_total: 1,
      timeout_ms: 60_000,
      created_at_ms: createdAtMs,
      created_by: 'machine-b',
    },
  });
}

describe('cluster sync (three relays over real HTTP)', () => {
  it('converges devices and task facts, serves diagnostics and restarts from disk', async () => {
    const a = await startRelay('w2m-int-a-');
    const b = await startRelay('w2m-int-b-');
    const c = await startRelay('w2m-int-c-');
    const relays = [a.relay, b.relay, c.relay];
    try {
      attach(a.relay, { nodeId: NODE.a, peers: [{ id: NODE.b, url: b.url }, { id: NODE.c, url: c.url }] });
      attach(b.relay, { nodeId: NODE.b, peers: [{ id: NODE.a, url: a.url }, { id: NODE.c, url: c.url }] });
      attach(c.relay, { nodeId: NODE.c, peers: [{ id: NODE.a, url: a.url }, { id: NODE.b, url: b.url }] });

      seedDevice(b.relay, { machine_id: 'm-b1', machine_name: 'tencent-mac', paired_at_ms: 1_700_000_000_000, device_token: 'token-b1', fleet_id: 'fleet-1' });
      seedTask(b.relay, '01K0000000000000000000000B');
      seedDevice(c.relay, { machine_id: 'm-c1', machine_name: 'vultr-mac', paired_at_ms: 1_700_000_000_100, device_token: 'token-c1', fleet_id: 'fleet-1' });

      // A pulls B and C over the real /v1/cluster/snapshot route.
      const tickA = await a.relay.cluster.tick();
      assert.equal(tickA.ok, true, JSON.stringify(tickA));
      assert.equal(a.relay.state.devices.get('m-b1')?.machine_name, 'tencent-mac');
      assert.equal(a.relay.state.devices.get('m-c1')?.machine_name, 'vultr-mac');
      assert.equal(a.relay.state.tokens.get('token-b1'), 'm-b1');
      assert.equal(a.relay.state.tasks.has('01K0000000000000000000000B'), true);

      // B pulls A (which now carries C's device) and C directly: converges.
      const tickB = await b.relay.cluster.tick();
      assert.equal(tickB.ok, true, JSON.stringify(tickB));
      assert.equal(b.relay.state.devices.has('m-c1'), true);

      // healthz advertises the feature and the diagnostics, and never the secret.
      const health = await (await fetch(`${a.url}/healthz`)).json();
      assert.equal(health.features.includes('relay-cluster-sync-v1'), true);
      assert.equal(health.cluster.enabled, true);
      assert.equal(health.cluster.node_id, NODE.a);
      assert.equal(health.cluster.peers.length, 2);
      assert.equal(JSON.stringify(health).includes(SECRET.toString('base64')), false);

      // Peer route: unsigned is refused, a correctly signed ping is accepted.
      const unsigned = await fetch(`${a.url}/v1/cluster/ping`);
      assert.equal(unsigned.status, 401);
      const ts = Date.now();
      const nonce = `test-nonce-${process.pid}-1`;
      const signed = await fetch(`${a.url}/v1/cluster/ping`, {
        headers: {
          'x-w2m-cluster-peer': NODE.b,
          'x-w2m-cluster-ts': String(ts),
          'x-w2m-cluster-nonce': nonce,
          'x-w2m-cluster-auth': clusterAuthToken({ secret: SECRET, method: 'GET', path: '/v1/cluster/ping', ts, nonce, since: '' }),
        },
      });
      assert.equal(signed.status, 200);
      const ping = await signed.json();
      assert.equal(ping.ok, true);
      assert.equal(ping.node_id, NODE.a);

      // B's device is updated; A's next tick takes the newer record (LWW).
      seedDevice(b.relay, { machine_id: 'm-b1', machine_name: 'tencent-mac-renamed', paired_at_ms: 1_700_000_000_500, device_token: 'token-b1', fleet_id: 'fleet-1' });
      await a.relay.cluster.tick();
      assert.equal(a.relay.state.devices.get('m-b1')?.machine_name, 'tencent-mac-renamed');

      // Restart A with the same state dir: the imported ledger is replayed at boot (before any sync),
      // and the restarted relay can sync again.
      await a.relay.close();
      const restarted = createRelayServer({ stateDir: a.dir, logger: null });
      const restartedInfo = await restarted.listen({ host: '127.0.0.1', port: 0 });
      try {
        assert.equal(restarted.state.tasks.has('01K0000000000000000000000B'), true, 'imported task survives restart');
        assert.equal(restarted.state.devices.get('m-b1')?.machine_name, 'tencent-mac-renamed');
        attach(restarted, { nodeId: NODE.a, peers: [{ id: NODE.b, url: b.url }, { id: NODE.c, url: c.url }] });
        const tickRestart = await restarted.cluster.tick();
        assert.equal(tickRestart.ok, true, JSON.stringify(tickRestart));
        assert.equal(restarted.cluster.status().node_id, NODE.a);
        assert.ok(restartedInfo.port > 0);
      } finally {
        await restarted.close();
      }
    } finally {
      await stopAll(relays);
    }
  });

  it('refuses a peer using the wrong secret and keeps syncing the healthy peer', async () => {
    const a = await startRelay('w2m-int2-a-');
    const b = await startRelay('w2m-int2-b-');
    const bad = await startRelay('w2m-int2-bad-');
    try {
      attach(a.relay, { nodeId: NODE.a, peers: [{ id: NODE.b, url: b.url }] });
      attach(b.relay, { nodeId: NODE.b, peers: [{ id: NODE.a, url: a.url }] });
      attach(bad.relay, { nodeId: NODE.c, peers: [{ id: NODE.a, url: a.url }], secret: OTHER_SECRET });

      seedDevice(a.relay, { machine_id: 'm-a1', machine_name: 'primary', paired_at_ms: 1_700_000_000_000, device_token: 'token-a1' });

      // The wrong secret is refused: no device is imported and the cursor records the error.
      const badTick = await bad.relay.cluster.tick();
      assert.equal(badTick.ok, false);
      assert.equal(bad.relay.state.devices.has('m-a1'), false);
      assert.equal(bad.relay.cluster.status().peers[0].last_error, 'UNAUTHORIZED');

      // A healthy peer still syncs even when listed next to an unreachable one.
      a.relay.cluster.config.peers = [
        { id: NODE.b, url: b.url },
        { id: NODE.c, url: 'http://127.0.0.1:1' },
      ];
      const tick = await a.relay.cluster.tick();
      assert.equal(tick.ok, false, 'the unreachable peer makes the round not fully ok');
      const byPeer = Object.fromEntries(tick.results.map((entry) => [entry.peer, entry]));
      assert.equal(byPeer[NODE.b].ok, true);
      assert.equal(byPeer[NODE.c].ok, false);
    } finally {
      await stopAll([a.relay, b.relay, bad.relay]);
    }
  });
});
