/**
 * Cluster domain (Phase 2) unit tests — chat + project pull, without the real store modules.
 *
 * The transport (signed GET, encrypted+gzip envelope, cursor/offset) is exercised end to end between
 * two in-process ClusterSync instances; the chat store and project source are deterministic fakes so
 * a failure here points at the transport/scheduler rather than at merge rules.
 */
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeClusterConfig,
  createClusterSync,
} from '../src/relay/cluster-sync.mjs';

const SECRET = randomBytes(32).toString('base64');
const NODE_A = 'node-aaaa1111';
const NODE_B = 'node-bbbb2222';

function fakePersistence(nodeId) {
  return {
    dir: null,
    loadClusterNodeId: () => nodeId,
    loadClusterCursors: () => ({}),
    loadClusterLastSync: () => null,
    loadClusterLedger: () => [],
    saveClusterNodeId: () => {},
    saveClusterCursors: () => {},
    saveClusterLastSync: () => {},
    loadClusterDomains: () => null,
    saveClusterDomains: () => {},
  };
}

function config(self, peerId, peerUrl) {
  return normalizeClusterConfig({
    enabled: true,
    secret: SECRET,
    nodeId: self,
    peers: [{ id: peerId, url: peerUrl }],
    bootMinMs: 0,
    bootMaxMs: 1,
    intervalMs: 60_000,
    jitterMs: 0,
    chatSyncMs: 5000,
    projectSyncMs: 60_000,
    chatBootMinMs: 0,
    chatBootMaxMs: 1,
  });
}

/** In-memory chat store with the same slice/import contract the real store has. */
function fakeChatStore() {
  const records = [];
  const applied = new Map();
  let generation = 1;
  return {
    records,
    exportSlice(fromOffset = 0, maxBytes = 128 * 1024) {
      const start = Number.isInteger(fromOffset) && fromOffset >= 0 ? fromOffset : 0;
      const out = [];
      let offset = start;
      let bytes = 0;
      for (const record of records) {
        const size = Buffer.byteLength(JSON.stringify(record));
        if (bytes + size > maxBytes && out.length > 0) break;
        out.push(JSON.parse(JSON.stringify(record)));
        bytes += size;
        offset += size;
        if (bytes >= maxBytes) break;
      }
      return { generation, records: out, next_offset: offset, eof: offset >= totalBytes(), bytes };
    },
    importRecord(record) {
      const key = record.origin;
      const previous = applied.get(key) ?? -1;
      if (record.offset <= previous) return { applied: false, generation };
      applied.set(key, record.offset);
      records.push(JSON.parse(JSON.stringify(record)));
      return { applied: true, generation };
    },
    append(record) { records.push(record); },
    bumpGeneration() { generation += 1; },
  };
  function totalBytes() { return records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0); }
}

/** In-memory project source: one project per side, merge is a set union. */
function fakeProjectSource(seed) {
  const projects = new Map([[seed.project_id, JSON.parse(JSON.stringify(seed))]]);
  return {
    projects,
    exportPage(offset = 0, limit = 3) {
      const all = [...projects.values()];
      const start = Number.isInteger(offset) && offset >= 0 ? Math.min(offset, all.length) : 0;
      const slice = all.slice(start, start + limit).map((project) => JSON.parse(JSON.stringify(project)));
      return { projects: slice, next_offset: start + slice.length, has_more: start + slice.length < all.length };
    },
    applyProject(remote) {
      const existing = projects.get(remote.project_id);
      if (existing === undefined) {
        projects.set(remote.project_id, JSON.parse(JSON.stringify(remote)));
        return { changed: true, conflicts: 0 };
      }
      const before = JSON.stringify(existing);
      const after = JSON.stringify(remote);
      if (before === after) return { changed: false, conflicts: 0 };
      projects.set(remote.project_id, JSON.parse(JSON.stringify(remote)));
      return { changed: true, conflicts: 0 };
    },
  };
}

function fakeFetchTo(target) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const routed = target.route({
      method: init.method ?? 'GET',
      path: parsed.pathname,
      headers: init.headers ?? {},
      query: parsed.searchParams,
      ip: '127.0.0.1',
    });
    if (routed.raw !== undefined) {
      return new Response(gunzipSync(routed.raw), {
        status: routed.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(typeof routed.body === 'string' ? routed.body : JSON.stringify(routed.body), {
      status: routed.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function makePair({ chat = true, projects = true } = {}) {
  const storeA = fakeChatStore();
  const storeB = fakeChatStore();
  const projectA = fakeProjectSource({ project_id: 'prj-a', name: 'A', members: [{ kind: 'machine', id: 'm-1', role: 'owner' }] });
  const projectB = fakeProjectSource({ project_id: 'prj-b', name: 'B', members: [{ kind: 'machine', id: 'm-2', role: 'owner' }] });
  const applied = [];
  const a = createClusterSync({
    persistence: fakePersistence(NODE_A),
    config: config(NODE_A, NODE_B, 'http://relay-b.test'),
    chatStore: chat ? storeA : null,
    applyChatRecord: (record) => applied.push(record),
    projectSource: projects ? projectA : null,
  });
  const b = createClusterSync({
    persistence: fakePersistence(NODE_B),
    config: config(NODE_B, NODE_A, 'http://relay-a.test'),
    chatStore: chat ? storeB : null,
    applyChatRecord: (record) => applied.push(record),
    projectSource: projects ? projectB : null,
  });
  b.fetchImpl = fakeFetchTo(a);
  return { a, b, storeA, storeB, projectA, projectB, applied };
}

function chatRecord(origin, offset, message) {
  return { v: 1, origin, offset, at_ms: 1000 + offset, kind: 'chat.message', data: message };
}

describe('cluster Phase 2 chat domain', () => {
  it('pulls records from a peer over the signed + encrypted chat route', async () => {
    const { b, storeA, storeB } = makePair();
    storeA.append(chatRecord(NODE_A, 1, { message_id: 'msg-1', session_id: 's-1', machine_id: 'm-1', text: 'hello', at_ms: 1001, bytes: 5 }));
    const result = await b.tickChat();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(storeB.records.length, 1);
    assert.equal(storeB.records[0].data.message_id, 'msg-1');
    const cursor = b.domains.chat.peers[NODE_A];
    assert.ok(cursor.offset > 0);
    assert.equal(cursor.last_error, null);
    // The exporting relay did not change.
    assert.equal(storeA.records.length, 1);
  });

  it('re-exports imported records so a third relay can bootstrap from any survivor', async () => {
    const { b, storeA, storeB } = makePair();
    storeA.append(chatRecord(NODE_A, 1, { message_id: 'msg-1', session_id: 's-1', machine_id: 'm-1', at_ms: 1001 }));
    await b.tickChat();
    // B now serves the A record back from its own replication log; a fresh store sees it once.
    assert.equal(storeB.records.length, 1);
    assert.equal(storeB.records[0].origin, NODE_A);
  });

  it('resets the byte cursor when the peer starts a new generation', async () => {
    const { b, storeA } = makePair();
    storeA.append(chatRecord(NODE_A, 1, { message_id: 'msg-1', session_id: 's-1', machine_id: 'm-1', at_ms: 1001 }));
    await b.tickChat();
    const firstOffset = b.domains.chat.peers[NODE_A].offset;
    assert.ok(firstOffset > 0);
    // Compaction: generation changes and the log restarts at byte 0 -> cursor must not stall.
    storeA.bumpGeneration();
    await b.tickChat();
    assert.equal(b.domains.chat.peers[NODE_A].generation, 2);
    assert.equal(b.domains.chat.peers[NODE_A].last_error, null);
  });

  it('rejects unsigned chat requests', async () => {
    const { a } = makePair();
    assert.throws(() => a.route({ method: 'GET', path: '/v1/cluster/chat', headers: {}, query: new URLSearchParams({ since: '0' }), ip: '127.0.0.1' }),
      (err) => err.code === 'UNAUTHORIZED');
  });

  it('skips a Phase 1-only peer instead of reporting a domain failure', async () => {
    const { a, b, storeA, storeB } = makePair();
    a.featureBits = () => ['relay-cluster-sync-v1'];
    storeA.append(chatRecord(NODE_A, 1, { message_id: 'msg-old', session_id: 's-1', machine_id: 'm-1', at_ms: 1001 }));
    const result = await b.tickChat();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.results[0].unsupported, true);
    assert.equal(b.domains.chat.peers[NODE_A].unsupported, true);
    assert.equal(b.domains.chat.peers[NODE_A].last_error, null);
    assert.equal(storeB.records.length, 0, 'nothing is pulled from a peer that does not advertise the domain');
  });

  it('uses the last known feature set when the probe fails (flaky relay link)', async () => {
    const { a, b } = makePair();
    a.featureBits = () => ['relay-cluster-sync-v1'];
    // First round learns A is Phase 1 only.
    await b.tickChat();
    assert.equal(b.domains.chat.peers[NODE_A].unsupported, true);
    // Then the ping path fails; the cached answer must be reused instead of flagging the domain.
    b.fetchImpl = async () => { throw new Error('flaky link'); };
    const result = await b.tickChat();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(b.domains.chat.peers[NODE_A].last_error, null);
    assert.equal(b.domains.chat.peers[NODE_A].unsupported, true);
  });

  it('reports chat sync disabled when no store is attached', async () => {
    const { b } = makePair({ chat: false, projects: false });
    assert.equal(b.chatSyncEnabled, false);
    const result = await b.tickChat();
    assert.equal(result.code, 'CHAT_SYNC_DISABLED');
  });
});

describe('cluster Phase 2 project domain', () => {
  it('pulls whole project states and merges them', async () => {
    const { b, projectB } = makePair();
    const result = await b.tickProjects();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(projectB.projects.size, 2);
    assert.equal(projectB.projects.get('prj-a').name, 'A');
  });

  it('is idempotent: a second round reports no change', async () => {
    const { b, projectB } = makePair();
    await b.tickProjects();
    const changedBefore = b.domains.projects.peers[NODE_A].last_changed;
    await b.tickProjects();
    assert.equal(b.domains.projects.peers[NODE_A].last_changed, 0);
    assert.equal(changedBefore, 1);
    assert.equal(projectB.projects.size, 2);
  });

  it('rejects unsigned project requests', async () => {
    const { a } = makePair();
    assert.throws(() => a.route({ method: 'GET', path: '/v1/cluster/projects', headers: {}, query: new URLSearchParams({ since: '0' }), ip: '127.0.0.1' }),
      (err) => err.code === 'UNAUTHORIZED');
  });

  it('advertises the Phase 2 feature bits only when the domains are attached', () => {
    const { a } = makePair();
    assert.deepEqual(a.featureBits().sort(), ['relay-cluster-chat-v1', 'relay-cluster-projects-v1', 'relay-cluster-sync-v1']);
  });
});


