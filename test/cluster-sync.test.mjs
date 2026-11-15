/**
 * Relay v3.0.0 cluster sync - unit tests.
 *
 * Covers configuration validation, the signed/encrypted peer protocol, scheduling bounds, the device
 * LWW merge, ledger replay idempotency and the end-to-end pull between two in-memory relays.
 * The three-process integration test lives in `test/cluster-sync-integration.test.mjs`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'node:test';

import { Persistence } from '../src/relay/persistence.mjs';
import { RabbitState } from '../src/relay/state.mjs';
import {
  CLUSTER_FEATURE,
  ClusterSync,
  bootDelayMs,
  clusterAuthToken,
  normalizeClusterConfig,
  openClusterEnvelope,
  periodicDelayMs,
  safeEqualBase64,
  sealClusterEnvelope,
} from '../src/relay/cluster-sync.mjs';

const SECRET = Buffer.alloc(32, 7);
const A_ID = 'node-aaaaaaaa';
const B_ID = 'node-bbbbbbbb';

function tempDir(prefix = 'w2m-cluster-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stateWithPersistence(dir, now = () => 1_800_000_000_000) {
  const persistence = new Persistence({ dir, now });
  const state = new RabbitState({ persistence, now });
  state.setPersistence(persistence);
  return { persistence, state };
}

function clusterConfig(overrides = {}) {
  return normalizeClusterConfig({
    enabled: true,
    secret: SECRET.toString('base64'),
    peers: [{ id: B_ID, url: 'http://relay-b.test' }],
    nodeId: A_ID,
    bootMinMs: 60_000,
    bootMaxMs: 600_000,
    jitterMs: 300_000,
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

describe('cluster config', () => {
  it('is disabled when nothing was asked for', () => {
    const config = normalizeClusterConfig({});
    assert.equal(config.enabled, false);
    assert.deepEqual(config.peers, []);
    assert.equal(config.secret, null);
  });

  it('accepts a complete configuration and parses a JSON peer list', () => {
    const config = normalizeClusterConfig({
      enabled: true,
      nodeId: A_ID,
      secret: SECRET.toString('base64'),
      peers: JSON.stringify([{ id: B_ID, url: 'http://106.53.197.47:8787/' }]),
    });
    assert.equal(config.enabled, true);
    assert.equal(config.peers.length, 1);
    assert.equal(config.peers[0].url, 'http://106.53.197.47:8787');
    assert.equal(config.intervalMs, 3_600_000);
    assert.equal(config.bootMinMs, 60_000);
    assert.equal(config.bootMaxMs, 600_000);
  });

  it('refuses a missing/oversized secret, bad peer ids and an empty peer list', () => {
    assert.throws(() => normalizeClusterConfig({ enabled: true, peers: [{ id: B_ID, url: 'http://b.test' }] }), /secret/);
    assert.throws(() => normalizeClusterConfig({ enabled: true, secret: Buffer.alloc(16).toString('base64'), peers: [{ id: B_ID, url: 'http://b.test' }] }), /32 bytes/);
    assert.throws(() => normalizeClusterConfig({ enabled: true, secret: SECRET.toString('base64'), peers: [{ id: 'b', url: 'http://b.test' }] }), /peer id/);
    assert.throws(() => normalizeClusterConfig({ enabled: true, secret: SECRET.toString('base64'), peers: [] }), /not be empty/);
  });
});

/* ------------------------------------------------------------------ */
/* crypto / auth                                                       */
/* ------------------------------------------------------------------ */

describe('cluster envelope and request auth', () => {
  it('round-trips a payload addressed to one peer', () => {
    const envelope = sealClusterEnvelope({ secret: SECRET, senderNodeId: A_ID, receiverNodeId: B_ID, payload: { hello: 'world' }, ts: 1_800_000_000_000, nonce: 'n1' });
    const opened = openClusterEnvelope({ secret: SECRET, envelope, expectedSender: A_ID, receiverNodeId: B_ID, nowMs: 1_800_000_000_000 });
    assert.deepEqual(opened.payload, { hello: 'world' });
  });

  it('rejects a wrong receiver, wrong sender, tampered ciphertext and a stale timestamp', () => {
    const envelope = sealClusterEnvelope({ secret: SECRET, senderNodeId: A_ID, receiverNodeId: B_ID, payload: { x: 1 }, ts: 1_800_000_000_000, nonce: 'n2' });
    assert.throws(() => openClusterEnvelope({ secret: SECRET, envelope, expectedSender: A_ID, receiverNodeId: 'node-cccccccc', nowMs: 1_800_000_000_000 }), /another relay/);
    assert.throws(() => openClusterEnvelope({ secret: SECRET, envelope, expectedSender: B_ID, receiverNodeId: B_ID, nowMs: 1_800_000_000_000 }), /sender/);
    const tampered = { ...envelope, ct: Buffer.from('tampered').toString('base64') };
    assert.throws(() => openClusterEnvelope({ secret: SECRET, envelope: tampered, expectedSender: A_ID, receiverNodeId: B_ID, nowMs: 1_800_000_000_000 }), /authentication failed/);
    assert.throws(() => openClusterEnvelope({ secret: SECRET, envelope, expectedSender: A_ID, receiverNodeId: B_ID, nowMs: 1_800_000_500_000 }), /timestamp/);
  });

  it('binds the HMAC to method, path and cursor', () => {
    const base = { secret: SECRET, method: 'GET', path: '/v1/cluster/snapshot', ts: 1, nonce: 'n', since: '0' };
    const token = clusterAuthToken(base);
    assert.equal(clusterAuthToken({ ...base }), token);
    assert.notEqual(clusterAuthToken({ ...base, path: '/v1/cluster/ping' }), token);
    assert.notEqual(clusterAuthToken({ ...base, since: '10' }), token);
    assert.equal(safeEqualBase64(token, token), true);
    assert.equal(safeEqualBase64(token, token.slice(0, -2) + 'AA'), false);
  });

  it('keeps the first-sync delay inside 60-600 s and the periodic delay inside interval+jitter', () => {
    const config = clusterConfig();
    for (const value of [0, 0.5, 0.999999]) {
      const first = bootDelayMs(config, () => value);
      assert.ok(first >= config.bootMinMs && first <= config.bootMaxMs, `boot delay ${first}`);
      const periodic = periodicDelayMs(config, () => value);
      assert.ok(periodic >= config.intervalMs && periodic <= config.intervalMs + config.jitterMs, `periodic delay ${periodic}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* device merge                                                        */
/* ------------------------------------------------------------------ */

describe('mergeClusterDevices', () => {
  it('takes the newer paired record but keeps this relay\'s presence', () => {
    const { state } = stateWithPersistence(tempDir());
    state.mergeClusterDevices([{ machine_id: 'm1', machine_name: 'old', paired_at_ms: 100, device_token: 'tok-old' }]);
    const local = state.devices.get('m1');
    local.online = true;
    local.streams = 2;
    const stats = state.mergeClusterDevices([{ machine_id: 'm1', machine_name: 'new', paired_at_ms: 200, device_token: 'tok-new', fleet_id: 'fleet-1' }]);
    assert.equal(stats.updated, 1);
    const merged = state.devices.get('m1');
    assert.equal(merged.machine_name, 'new');
    assert.equal(merged.online, true, 'presence stays local');
    assert.equal(merged.streams, 2);
    assert.equal(merged.fleet_id, 'fleet-1');
    assert.equal(state.tokens.get('tok-new'), 'm1');
    assert.equal(state.tokens.has('tok-old'), false);
  });

  it('does not overwrite a newer local record and fills a missing token', () => {
    const { state } = stateWithPersistence(tempDir());
    state.mergeClusterDevices([{ machine_id: 'm2', machine_name: 'local-newer', paired_at_ms: 500 }]);
    const stats = state.mergeClusterDevices([{ machine_id: 'm2', machine_name: 'remote-older', paired_at_ms: 100, device_token: 'tok-fill' }]);
    assert.equal(stats.updated, 1);
    const merged = state.devices.get('m2');
    assert.equal(merged.machine_name, 'local-newer');
    assert.equal(merged.device_token, 'tok-fill');
    assert.equal(state.tokens.get('tok-fill'), 'm2');
  });

  it('ignores malformed records instead of throwing', () => {
    const { state } = stateWithPersistence(tempDir());
    const stats = state.mergeClusterDevices([null, {}, { machine_id: '' }, 42]);
    assert.equal(stats.rejected, 4);
    assert.equal(state.devices.size, 0);
  });
});

/* ------------------------------------------------------------------ */
/* ledger merge / slice                                                */
/* ------------------------------------------------------------------ */

describe('ledger import', () => {
  const taskId = '01K00000000000000000000001';
  const taskCreated = {
    type: 'task.created',
    task: {
      task_id: taskId,
      mode: 'replicate',
      command_argv: ['node', '-v'],
      cwd_rel: '.',
      index_total: 1,
      timeout_ms: 60_000,
      created_at_ms: 1_800_000_000_000,
      created_by: 'machine-x',
    },
  };

  it('reads the local ledger from a byte offset without consuming a partial line', () => {
    const { persistence } = stateWithPersistence(tempDir());
    persistence.append({ ts: '2026-01-01T00:00:00Z', type: 'a' });
    persistence.append({ ts: '2026-01-01T00:00:01Z', type: 'b' });
    const first = persistence.readLedgerSlice({ offset: 0, maxBytes: 10 * 1024 * 1024 });
    assert.equal(first.entries.length, 2);
    assert.equal(first.eof, true);
    const second = persistence.readLedgerSlice({ offset: first.nextOffset });
    assert.equal(second.entries.length, 0);
    assert.equal(second.eof, true);
    const fromSecond = persistence.readLedgerSlice({ offset: first.entries[1].offset });
    assert.equal(fromSecond.entries.length, 1);
    assert.equal(fromSecond.entries[0].entry.type, 'b');
  });

  it('applies an imported task once and reports the duplicate on replay', () => {
    const dir = tempDir();
    const { persistence, state } = stateWithPersistence(dir);
    const record = { origin: B_ID, offset: 0, entry: taskCreated };
    const first = state.applyClusterLedger([record]);
    assert.equal(first.applied, 1);
    assert.equal(state.tasks.has(taskId), true);
    persistence.appendClusterLedger({ ...record, ts: taskCreated.ts ?? null });
    const second = state.applyClusterLedger([record]);
    assert.equal(second.duplicates, 1);
    assert.equal(state.tasks.size, 1);
  });

  it('skips operator keys but imports results', () => {
    const { state } = stateWithPersistence(tempDir());
    state.applyClusterLedger([
      { origin: B_ID, offset: 1, entry: { type: 'operator.key.registered', key: { key_id: 'k1', public_key_pem: 'x' } } },
      { origin: B_ID, offset: 2, entry: { type: 'result.stored', result: { instance_key: `${taskId}#0`, machine_id: 'm1', seq: 1, envelope: { task_id: taskId } } } },
    ]);
    assert.equal(state.operatorKeys.has('k1'), false);
    assert.equal(state.results.has(`${taskId}#0`), true);
  });

  it('keeps the fleet binding on an imported task, so a fleet-scoped listing still sees it', () => {
    const { state } = stateWithPersistence(tempDir());
    const entry = { ...taskCreated, task: { ...taskCreated.task, fleet_id: 'fleet-imported' } };
    state.applyClusterLedger([{ origin: B_ID, offset: 5, entry }]);
    assert.equal(state.tasks.get(taskId)?.fleet_id, 'fleet-imported');
    assert.equal(state.listTasks({ fleetId: 'fleet-imported' }).length, 1);
    assert.equal(state.listTasks({ fleetId: 'other-fleet' }).length, 0);
  });

  it('derives the fleet binding for a legacy ledger entry from the creator device', () => {
    const { state } = stateWithPersistence(tempDir());
    state.mergeClusterDevices([{ machine_id: 'machine-x', machine_name: 'x', paired_at_ms: 1, fleet_id: 'fleet-legacy' }]);
    // taskCreated is a pre-v3.0.0 entry: it carries created_by but no fleet_id.
    state.applyClusterLedger([{ origin: B_ID, offset: 6, entry: taskCreated }]);
    assert.equal(state.tasks.get(taskId)?.fleet_id, 'fleet-legacy');
    assert.equal(state.listTasks({ fleetId: 'fleet-legacy' }).length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* end-to-end pull between two in-memory relays                        */
/* ------------------------------------------------------------------ */

function makeRelay(dir, { nodeId, peerId, peerUrl }) {
  const { persistence, state } = stateWithPersistence(dir);
  const config = normalizeClusterConfig({
    enabled: true,
    secret: SECRET.toString('base64'),
    nodeId,
    peers: [{ id: peerId, url: peerUrl }],
    bootMinMs: 60_000,
    bootMaxMs: 600_000,
    jitterMs: 300_000,
    chunkBytes: 64 * 1024,
  });
  const relay = new ClusterSync({ state, persistence, config, relayVersion: '3.0.0', retryAttempts: 2, retryDelayMs: 20 });
  return { persistence, state, relay };
}

/** Fake `fetch` that routes a signed snapshot request into the other relay's `route()`. */
function routeFetch(serverRelay) {
  return async (url, init) => {
    const parsed = new URL(url);
    const result = serverRelay.route({
      method: 'GET',
      path: parsed.pathname,
      headers: init.headers,
      query: parsed.searchParams,
      ip: '127.0.0.1',
    });
    // Real `fetch` decompresses gzip transparently; this in-process fake has to do it explicitly so
    // the test exercises the same plaintext envelope the network layer would hand to the client.
    const body = result.raw !== undefined
      ? gunzipSync(result.raw).toString('utf8')
      : JSON.stringify(result.body);
    return new Response(body, { status: result.status, headers: { 'content-type': 'application/json' } });
  };
}

describe('cluster sync pull (two relays)', () => {
  it('pulls devices and ledger from the peer, then reports no duplicates on a second tick', async () => {
    const dirA = tempDir('w2m-cs-a-');
    const dirB = tempDir('w2m-cs-b-');
    const a = makeRelay(dirA, { nodeId: A_ID, peerId: B_ID, peerUrl: 'http://relay-b.test' });
    const b = makeRelay(dirB, { nodeId: B_ID, peerId: A_ID, peerUrl: 'http://relay-a.test' });
    a.relay.fetchImpl = routeFetch(b.relay);

    // B owns a device and a task fact
    b.state.mergeClusterDevices([{ machine_id: 'm1', machine_name: 'macmini', paired_at_ms: 1_700_000_000_000, device_token: 'tok-1', fleet_id: 'fleet-1' }]);
    const taskId = '01K00000000000000000000002';
    b.persistence.append({ ts: '2026-01-01T00:00:00Z', type: 'task.created', task: { task_id: taskId, mode: 'replicate', command_argv: ['node', '-v'], created_at_ms: 1_800_000_000_000 } });
    b.persistence.append({ ts: '2026-01-01T00:00:01Z', type: 'task.cancelled', task_id: taskId, reason: 'test' });

    const first = await a.relay.tick();
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(a.state.devices.get('m1')?.machine_name, 'macmini');
    assert.equal(a.state.tokens.get('tok-1'), 'm1');
    assert.equal(a.state.tasks.has(taskId), true);
    assert.equal(a.state.tasks.get(taskId).cancelled, true);
    assert.ok(readFileSync(join(dirA, 'cluster', 'ledger.jsonl'), 'utf8').includes(taskId));

    const second = await a.relay.tick();
    assert.equal(second.ok, true);
    assert.equal(a.state.tasks.size, 1, 'replay must not duplicate the task');
    assert.equal(a.relay.imported.ledger, 2, 'second tick imports nothing new');
  });

  it('refuses a replayed request nonce and a tampered envelope', async () => {
    const dirB = tempDir('w2m-cs-d-');
    const b = makeRelay(dirB, { nodeId: B_ID, peerId: A_ID, peerUrl: 'http://relay-a.test' });

    const ts = Date.now();
    const nonce = 'fixed-nonce-123';
    const headers = {
      'x-w2m-cluster-peer': A_ID,
      'x-w2m-cluster-ts': String(ts),
      'x-w2m-cluster-nonce': nonce,
      'x-w2m-cluster-auth': clusterAuthToken({ secret: SECRET, method: 'GET', path: '/v1/cluster/snapshot', ts, nonce, since: '0' }),
    };
    const first = b.relay.route({ method: 'GET', path: '/v1/cluster/snapshot', headers, query: new URLSearchParams({ since: '0' }), ip: '127.0.0.1' });
    assert.equal(first.status, 200);
    assert.throws(
      () => b.relay.route({ method: 'GET', path: '/v1/cluster/snapshot', headers, query: new URLSearchParams({ since: '0' }), ip: '127.0.0.1' }),
      (err) => err.code === 'UNAUTHORIZED' && err.detail?.reason === 'CLUSTER_REPLAY',
    );

    const firstEnvelope = JSON.parse(gunzipSync(first.raw).toString('utf8'));
    const tampered = { ...firstEnvelope, ct: Buffer.from('nope').toString('base64') };
    assert.throws(
      () => openClusterEnvelope({ secret: SECRET, envelope: tampered, expectedSender: B_ID, receiverNodeId: A_ID, nowMs: ts }),
      /authentication failed/,
    );
  });

  it('serves snapshot responses gzipped and the peer can still decrypt the envelope', () => {
    const dirB = tempDir('w2m-cs-gz-');
    const b = makeRelay(dirB, { nodeId: B_ID, peerId: A_ID, peerUrl: 'http://relay-a.test' });
    const ts = Date.now();
    const nonce = 'gzip-nonce-1';
    const headers = {
      'x-w2m-cluster-peer': A_ID,
      'x-w2m-cluster-ts': String(ts),
      'x-w2m-cluster-nonce': nonce,
      'x-w2m-cluster-auth': clusterAuthToken({ secret: SECRET, method: 'GET', path: '/v1/cluster/snapshot', ts, nonce, since: '0' }),
    };
    const result = b.relay.route({ method: 'GET', path: '/v1/cluster/snapshot', headers, query: new URLSearchParams({ since: '0' }), ip: '127.0.0.1' });
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], 'gzip');
    assert.equal(Buffer.isBuffer(result.raw), true);
    const envelope = JSON.parse(gunzipSync(result.raw).toString('utf8'));
    const opened = openClusterEnvelope({ secret: SECRET, envelope, expectedSender: B_ID, receiverNodeId: A_ID, nowMs: Date.now() });
    assert.equal(opened.payload.node_id, B_ID);
    assert.equal(opened.payload.has_more, false);
  });

  it('sends devices only on the first page (devices=0 skips them)', () => {
    const dirB = tempDir('w2m-cs-page-');
    const b = makeRelay(dirB, { nodeId: B_ID, peerId: A_ID, peerUrl: 'http://relay-a.test' });
    b.state.mergeClusterDevices([{ machine_id: 'm-page', machine_name: 'p', paired_at_ms: 1, device_token: 'tok-p' }]);
    b.persistence.append({ ts: '2026-01-01T00:00:00Z', type: 'task.created', task: { task_id: '01K0000000000000000000000C', mode: 'replicate', command_argv: ['node', '-v'], created_at_ms: 1 } });
    const ts = Date.now();
    const nonce = 'page-nonce-1';
    const headers = {
      'x-w2m-cluster-peer': A_ID,
      'x-w2m-cluster-ts': String(ts),
      'x-w2m-cluster-nonce': nonce,
      'x-w2m-cluster-auth': clusterAuthToken({ secret: SECRET, method: 'GET', path: '/v1/cluster/snapshot', ts, nonce, since: '0' }),
    };
    const result = b.relay.route({ method: 'GET', path: '/v1/cluster/snapshot', headers, query: new URLSearchParams({ since: '0', devices: '0' }), ip: '127.0.0.1' });
    const opened = openClusterEnvelope({ secret: SECRET, envelope: JSON.parse(gunzipSync(result.raw).toString('utf8')), expectedSender: B_ID, receiverNodeId: A_ID, nowMs: Date.now() });
    assert.equal(opened.payload.devices.length, 0);
    assert.equal(opened.payload.ledger.length, 1);
  });

  it('retries a failed page instead of losing the whole peer round', async () => {
    const a = makeRelay(tempDir('w2m-cs-retry-a-'), { nodeId: A_ID, peerId: B_ID, peerUrl: 'http://relay-b.test' });
    const b = makeRelay(tempDir('w2m-cs-retry-b-'), { nodeId: B_ID, peerId: A_ID, peerUrl: 'http://relay-a.test' });
    b.state.mergeClusterDevices([{ machine_id: 'm-retry', machine_name: 'r', paired_at_ms: 1, device_token: 'tok-retry' }]);
    const inner = routeFetch(b.relay);
    let calls = 0;
    a.relay.fetchImpl = async (url, init) => {
      calls += 1;
      if (calls === 1) throw new Error('transient link failure');
      return inner(url, init);
    };
    const result = await a.relay.tick();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(calls >= 2, `expected a retry, got ${calls} call(s)`);
    assert.equal(a.state.devices.has('m-retry'), true);
  });

  it('syncs devices through small pages and merges every page', async () => {
    const a = makeRelay(tempDir('w2m-cs-pages-a-'), { nodeId: A_ID, peerId: B_ID, peerUrl: 'http://relay-b.test' });
    const b = makeRelay(tempDir('w2m-cs-pages-b-'), { nodeId: B_ID, peerId: A_ID, peerUrl: 'http://relay-a.test' });
    const many = Array.from({ length: 30 }, (_, index) => ({
      machine_id: 'm-page-' + String(index).padStart(2, '0'),
      machine_name: 'page-' + index,
      paired_at_ms: 100 + index,
      device_token: 'tok-page-' + index,
    }));
    b.state.mergeClusterDevices(many);
    a.relay.fetchImpl = routeFetch(b.relay);
    const result = await a.relay.tick();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(a.state.devices.size, 30, 'all pages merged');
    const peerResult = result.results.find((entry) => entry.peer === B_ID);
    assert.equal(peerResult.device_pages, 2, '30 devices at 25 per page = 2 pages');
    assert.equal(a.state.tokens.get('tok-page-29'), 'm-page-29');
  });

  it('exposes the feature name and never the secret in status()', () => {
    const dir = tempDir('w2m-cs-e-');
    const relay = makeRelay(dir, { nodeId: A_ID, peerId: B_ID, peerUrl: 'http://relay-b.test' }).relay;
    const status = relay.status();
    assert.equal(status.feature, CLUSTER_FEATURE);
    assert.equal(status.enabled, true);
    assert.equal(JSON.stringify(status).includes(SECRET.toString('base64')), false);
  });
});
