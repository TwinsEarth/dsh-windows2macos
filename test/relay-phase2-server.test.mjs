/**
 * Relay Phase 2 — server wiring.
 *
 * The two Phase 2 engines have their own suites (`chat-store`, `project-sync`, `cluster-domains`). The
 * merge review found the seam they do not cover untested: `server.mjs` constructs the chat store,
 * seeds `fleetMessages` from it, advertises the domain feature bits, mounts the peer routes, applies
 * imported domain records, and persists a posted message. A regression there turns every engine test
 * green while the relay does nothing with them.
 *
 * So this file drives the real relay over real HTTP (127.0.0.1:0, the pattern
 * `test/cluster-sync-integration.test.mjs` established), with a throwaway state directory per relay:
 *
 *   1. `/healthz` advertises `relay-cluster-chat-v1` / `relay-cluster-projects-v1` only when the
 *      corresponding stores are attached, and the signed peer route reports the same feature set;
 *   2. a message posted through `POST /v1/fleet/messages` lands in `<state>/chat/replication.jsonl`
 *      and is still there after a restart (store load -> fleetMessages seed through the handler);
 *   3. a peer pulls chat records and project state over `GET /v1/cluster/chat` / `/v1/cluster/projects`
 *      (real cross-relay push/pull, not a fake fetch);
 *   4. a peer that advertises only Phase 1 is skipped as "unsupported", not reported as a domain
 *      failure — the mixed-version path a rolling upgrade depends on;
 *   5. the chat tombstone closes end to end: a deleted session is refused at post time, stays hidden
 *      after a restart, and a peer that imports the tombstone hides it too;
 *   6. a wrong signing secret returns `SIGNATURE_MISMATCH` with the restored user-facing sentence (the
 *      GBK re-encode in 8e90aed had turned its em dash into mojibake);
 *   7. every Phase 2 suite is named by `scripts.test`, `test:all` and its own script, so the suites
 *      cannot silently drop out of the release gate again.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createRelayServer } from '../src/relay/server.mjs';
import { clusterAuthToken, normalizeClusterConfig } from '../src/relay/cluster-sync.mjs';
import { createSigner } from '../src/signing.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const OP = 'operator-token-for-phase2-tests';
const CLUSTER_SECRET = Buffer.alloc(32, 11);
const NODE = { a: 'node-aaaaaaaa', b: 'node-bbbbbbbb' };
const CHAT_FEATURE = 'relay-cluster-chat-v1';
const PROJECT_FEATURE = 'relay-cluster-projects-v1';
const PHASE2_FEATURES = [CHAT_FEATURE, PROJECT_FEATURE];
const PLATFORM = { os: 'linux', arch: 'x64' };
const CAPS = { case_sensitive_fs: true, symlinks: true, exec_bit: true, node: 'v22.0.0', write: true };

/** State directories created by this file, removed after the run so a pass leaves nothing behind. */
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a closed relay may still hold a handle */ }
  }
});

function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-phase2-server-'));
  tempDirs.push(dir);
  return dir;
}

/** One relay on an OS-assigned loopback port with persistence in a throwaway state directory. */
async function startRelay(prefix, options = {}) {
  const stateDir = makeStateDir();
  const relay = createRelayServer({ stateDir, logger: null, operatorToken: OP, ...options });
  const info = await relay.listen({ host: '127.0.0.1', port: 0 });
  return { relay, stateDir, url: `http://127.0.0.1:${info.port}` };
}

/** Cluster configuration with the boot window parked far enough out that only a manual tick runs. */
function clusterConfig({ nodeId, peers }) {
  return normalizeClusterConfig({
    enabled: true,
    nodeId,
    secret: CLUSTER_SECRET.toString('base64'),
    peers,
    intervalMs: 3_600_000,
    bootMinMs: 60_000,
    bootMaxMs: 600_000,
    jitterMs: 0,
    chatSyncMs: 3_600_000,
    chatBootMinMs: 60_000,
    chatBootMaxMs: 600_000,
    projectSyncMs: 3_600_000,
  });
}

/** Make two relays peers of each other (each configured with the other's real URL). */
function attachPeers(a, b) {
  a.relay.attachCluster(clusterConfig({ nodeId: NODE.a, peers: [{ id: NODE.b, url: b.url }] }));
  b.relay.attachCluster(clusterConfig({ nodeId: NODE.b, peers: [{ id: NODE.a, url: a.url }] }));
}

/** A minimal HTTP call that keeps the parsed body even when the status is a refusal. */
async function call(url, path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(url + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* some refusals are not JSON */ }
  return { status: response.status, json, text };
}

async function pairDevice(started, machineId) {
  const response = await call(started.url, '/v1/pair', {
    method: 'POST',
    body: {
      pairing_code: started.relay.state.createPairingCode(),
      machine_id: machineId,
      machine_name: machineId,
      platform: PLATFORM,
      caps: CAPS,
    },
  });
  assert.equal(response.status, 200, `pair failed: ${response.text}`);
  return response.json.device_token;
}

async function closeAll(relays) {
  for (const relay of relays) {
    try { await relay?.close(); } catch { /* already closed */ }
  }
}

/** Post one chat message as `token`; returns the parsed response. */
function postMessage(relay, token, { session_id: sessionId, text }) {
  return call(relay.url, '/v1/fleet/messages', { method: 'POST', token, body: { session_id: sessionId, text } });
}

describe('Phase 2 server wiring: feature bits and peer routes', () => {
  it('advertises the Phase 2 feature bits only after the cluster is attached, on /healthz and the peer route', async () => {
    const a = await startRelay('w2m-phase2-health-a-');
    try {
      const before = await call(a.url, '/healthz');
      assert.equal(before.status, 200);
      for (const feature of PHASE2_FEATURES) {
        assert.equal(before.json.features.includes(feature), false, `${feature} must not appear on a single relay`);
      }
      assert.equal(before.json.cluster, null, 'a relay with no cluster has no cluster block');

      a.relay.attachCluster(clusterConfig({ nodeId: NODE.a, peers: [{ id: NODE.b, url: 'http://127.0.0.1:1' }] }));
      const after = await call(a.url, '/healthz');
      for (const feature of PHASE2_FEATURES) assert.equal(after.json.features.includes(feature), true, feature);
      assert.equal(after.json.cluster.domains.chat.enabled, true);
      assert.equal(after.json.cluster.domains.projects.enabled, true);

      // The signed peer route reports the same feature set the healthz does: that answer is what makes
      // a peer skip a domain it cannot speak (mixed versions) instead of calling it a failure.
      const ts = Date.now();
      const nonce = `phase2-ping-${process.pid}`;
      const ping = await call(a.url, '/v1/cluster/ping', {
        headers: {
          'x-w2m-cluster-peer': NODE.b,
          'x-w2m-cluster-ts': String(ts),
          'x-w2m-cluster-nonce': nonce,
          'x-w2m-cluster-auth': clusterAuthToken({ secret: CLUSTER_SECRET, method: 'GET', path: '/v1/cluster/ping', ts, nonce, since: '' }),
        },
      });
      assert.equal(ping.status, 200, ping.text);
      for (const feature of PHASE2_FEATURES) assert.equal(ping.json.features.includes(feature), true, feature);
    } finally {
      await closeAll([a.relay]);
    }
  });

  it('serves the peer routes only with cluster auth: unsigned chat/projects requests are 401', async () => {
    const a = await startRelay('w2m-phase2-routes-');
    try {
      a.relay.attachCluster(clusterConfig({ nodeId: NODE.a, peers: [{ id: NODE.b, url: 'http://127.0.0.1:1' }] }));
      for (const path of ['/v1/cluster/chat?since=0', '/v1/cluster/projects?since=0']) {
        const unsigned = await call(a.url, path);
        assert.equal(unsigned.status, 401, `${path} must not be readable without cluster auth: ${unsigned.text}`);
      }
      // A correctly signed request is answered; the domain route is registered and not a 404.
      const ts = Date.now();
      const nonce = `phase2-chat-${process.pid}`;
      const signed = await call(a.url, '/v1/cluster/chat?since=0', {
        headers: {
          'x-w2m-cluster-peer': NODE.b,
          'x-w2m-cluster-ts': String(ts),
          'x-w2m-cluster-nonce': nonce,
          'x-w2m-cluster-auth': clusterAuthToken({
            secret: CLUSTER_SECRET, method: 'GET', path: '/v1/cluster/chat', ts, nonce, since: '0',
          }),
        },
      });
      assert.equal(signed.status, 200, signed.text);
      // The domain pages are sealed envelopes (AES-GCM, gzip), addressed to the authenticated peer.
      assert.equal(signed.json.sender_node_id, NODE.a);
      assert.equal(typeof signed.json.ct, 'string');
      assert.ok(signed.json.ct.length > 0);
    } finally {
      await closeAll([a.relay]);
    }
  });
});

describe('Phase 2 server wiring: chat persistence through the HTTP handler', () => {
  it('a posted message is written to <state>/chat and is served again after a restart', async () => {
    const a = await startRelay('w2m-phase2-chat-');
    let restarted = null;
    try {
      const token = await pairDevice(a, 'm-a');
      const posted = await postMessage(a.relay, token, { session_id: 's-1', text: 'durable hello' });
      assert.equal(posted.status, 200, posted.text);

      const logFile = join(a.stateDir, 'chat', 'replication.jsonl');
      assert.equal(existsSync(logFile), true, 'the chat store must be attached when persistence is on');
      const records = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(records.length, 1);
      assert.equal(records[0].kind, 'chat.message');
      assert.equal(records[0].data.message_id, posted.json.message.message_id);

      await a.relay.close();
      // The same state directory as the first relay, not a fresh one: this is the restart the operator sees.
      const second = createRelayServer({ stateDir: a.stateDir, logger: null, operatorToken: OP });
      const info = await second.listen({ host: '127.0.0.1', port: 0 });
      restarted = { relay: second, stateDir: a.stateDir, url: `http://127.0.0.1:${info.port}` };
      const listed = await call(restarted.url, '/v1/fleet/messages?session_id=s-1', { token });
      assert.equal(listed.status, 200, listed.text);
      assert.deepEqual(listed.json.messages.map((message) => message.text), ['durable hello']);
      assert.notEqual(second.chatStore, null);
    } finally {
      await closeAll([restarted?.relay]);
    }
  });

  it('the delete path tombstones the session, refuses a repost, and the deletion survives a restart', async () => {
    const a = await startRelay('w2m-phase2-delete-');
    const restarted = { current: null };
    try {
      const token = await pairDevice(a, 'm-a');
      assert.equal((await postMessage(a.relay, token, { session_id: 's-1', text: 'one' })).status, 200);

      const deleted = a.relay.deleteChatSession('s-1');
      assert.deepEqual(deleted, { ok: true, deleted: true, tombstoned: true });
      assert.equal((await call(a.url, '/v1/fleet/messages?session_id=s-1', { token })).json.count, 0);
      assert.equal(a.relay.chatStore.load().messages.length, 0, 'the store view filters the tombstoned session');
      assert.deepEqual(a.relay.chatStore.load().deletedSessions, ['s-1']);

      const repost = await postMessage(a.relay, token, { session_id: 's-1', text: 'resurrect?' });
      assert.equal(repost.status, 400, 'a retired session id must not report success for an invisible message');
      assert.equal(repost.json.error.code, 'BAD_REQUEST');
      assert.equal(repost.json.error.detail.code, 'SESSION_DELETED');

      await a.relay.close();
      const second = createRelayServer({ stateDir: a.stateDir, logger: null, operatorToken: OP });
      const info = await second.listen({ host: '127.0.0.1', port: 0 });
      restarted.current = second;
      const url = `http://127.0.0.1:${info.port}`;
      const listed = await call(url, '/v1/fleet/messages?session_id=s-1', { token });
      assert.equal(listed.json.count, 0, 'a restart must not resurrect the deleted conversation');
      assert.deepEqual(second.chatStore.load().deletedSessions, ['s-1']);
    } finally {
      await closeAll([a.relay, restarted.current]);
    }
  });

  it('rejects an empty session id instead of recording a tombstone for nothing', async () => {
    const a = await startRelay('w2m-phase2-delete-bad-');
    try {
      assert.deepEqual(a.relay.deleteChatSession(''), { ok: false, code: 'BAD_SESSION' });
      assert.deepEqual(a.relay.deleteChatSession(42), { ok: false, code: 'BAD_SESSION' });
      assert.equal(a.relay.chatStore.stats().records, 0);
    } finally {
      await closeAll([a.relay]);
    }
  });
});

describe('Phase 2 server wiring: cross-relay pull over real HTTP', () => {
  it('a peer pulls messages, read marks and project state from the relay', async () => {
    const a = await startRelay('w2m-phase2-pull-a-');
    const b = await startRelay('w2m-phase2-pull-b-');
    try {
      attachPeers(a, b);
      const tokenA = await pairDevice(a, 'm-a');
      const tokenB = await pairDevice(b, 'm-b');

      assert.equal((await postMessage(a.relay, tokenA, { session_id: 's-1', text: 'hello from a' })).status, 200);
      const marked = await call(a.url, '/v1/fleet/read/s-1', { method: 'PUT', token: tokenA, body: { message_id: 'ignored-label' } });
      assert.equal(marked.status, 200, marked.text);

      const chatRound = await b.relay.cluster.tickChat();
      assert.equal(chatRound.ok, true, JSON.stringify(chatRound));
      assert.equal(chatRound.results[0].skipped, undefined, 'a Phase 2 peer is pulled, not skipped');
      assert.ok(chatRound.results[0].applied >= 2, 'the message and the read mark are imported');
      const listed = await call(b.url, '/v1/fleet/messages?session_id=s-1', { token: tokenB });
      assert.equal(listed.status, 200, listed.text);
      assert.deepEqual(listed.json.messages.map((message) => message.text), ['hello from a']);
      assert.equal(b.relay.state.readMark('s-1', 'm-a') !== null, true, 'the read watermark replicated');

      // Project room: create one as the operator on A, then pull it into B and read it back through the
      // device-facing project route (membership is part of the merge, so B's machine must be a member).
      const created = await call(a.url, '/v1/projects', {
        method: 'POST', token: OP,
        body: {
          name: 'phase2-pull',
          origin: { kind: 'git', url: 'https://example.invalid/phase2.git' },
          members: [
            { kind: 'machine', id: 'm-a', role: 'owner' },
            { kind: 'machine', id: 'm-b', role: 'worker' },
          ],
        },
      });
      assert.equal(created.status, 200, created.text);
      const projectId = created.json.project.project.project_id;

      const projectRound = await b.relay.cluster.tickProjects();
      assert.equal(projectRound.ok, true, JSON.stringify(projectRound));
      assert.equal(projectRound.results[0].skipped, undefined, 'a Phase 2 peer is pulled, not skipped');
      assert.ok(projectRound.results[0].projects >= 1, 'at least the created project was exported');
      const read = await call(b.url, `/v1/projects/${encodeURIComponent(projectId)}`, { token: tokenB });
      assert.equal(read.status, 200, read.text);
      assert.equal(read.json.project.name, 'phase2-pull');
    } finally {
      await closeAll([a.relay, b.relay]);
    }
  });

  it('skips a peer that advertises Phase 1 only, without reporting a domain failure', async () => {
    const a = await startRelay('w2m-phase2-mixed-a-');
    const b = await startRelay('w2m-phase2-mixed-b-');
    try {
      attachPeers(a, b);
      const tokenA = await pairDevice(a, 'm-a');
      assert.equal((await postMessage(a.relay, tokenA, { session_id: 's-1', text: 'phase 2 only' })).status, 200);

      // The shape of a relay upgraded later: Phase 1 sync works, the Phase 2 domains are not advertised.
      a.relay.cluster.featureBits = () => ['relay-cluster-sync-v1'];
      const chatRound = await b.relay.cluster.tickChat();
      assert.equal(chatRound.ok, true, JSON.stringify(chatRound));
      assert.equal(chatRound.results[0].unsupported, true);
      assert.equal(b.relay.cluster.domains.chat.peers[NODE.a].last_error, null);
      const store = b.relay.chatStore.load();
      assert.deepEqual(store.messages, [], 'nothing is pulled from a peer that does not advertise the domain');

      const projectRound = await b.relay.cluster.tickProjects();
      assert.equal(projectRound.ok, true, JSON.stringify(projectRound));
      assert.equal(projectRound.results[0].unsupported, true);
      assert.equal(b.relay.cluster.domains.projects.peers[NODE.a].last_error, null);
    } finally {
      await closeAll([a.relay, b.relay]);
    }
  });

  it('a peer imports the tombstone and hides the conversation, including after its own restart', async () => {
    const a = await startRelay('w2m-phase2-tomb-a-');
    const b = await startRelay('w2m-phase2-tomb-b-');
    const restarted = { current: null };
    try {
      attachPeers(a, b);
      const tokenA = await pairDevice(a, 'm-a');
      const tokenB = await pairDevice(b, 'm-b');
      assert.equal((await postMessage(a.relay, tokenA, { session_id: 's-1', text: 'to be deleted' })).status, 200);

      const firstRound = await b.relay.cluster.tickChat();
      assert.equal(firstRound.ok, true, JSON.stringify(firstRound));
      assert.equal((await call(b.url, '/v1/fleet/messages?session_id=s-1', { token: tokenB })).json.count, 1);

      assert.equal(a.relay.deleteChatSession('s-1').ok, true);
      // A's tombstone record itself is re-exported to B by the next pull and applied by `_applyChatRecord`.
      const secondRound = await b.relay.cluster.tickChat();
      assert.equal(secondRound.ok, true, JSON.stringify(secondRound));
      assert.equal((await call(b.url, '/v1/fleet/messages?session_id=s-1', { token: tokenB })).json.count, 0);
      assert.deepEqual(b.relay.chatStore.load().deletedSessions, ['s-1']);

      await b.relay.close();
      const second = createRelayServer({ stateDir: b.stateDir, logger: null, operatorToken: OP });
      const info = await second.listen({ host: '127.0.0.1', port: 0 });
      restarted.current = second;
      const url = `http://127.0.0.1:${info.port}`;
      const listed = await call(url, '/v1/fleet/messages?session_id=s-1', { token: tokenB });
      assert.equal(listed.json.count, 0, 'the imported tombstone still hides the history after a restart');
    } finally {
      await closeAll([a.relay, b.relay, restarted.current]);
    }
  });
});

describe('Phase 2 server wiring: the restored user-facing signature error', () => {
  it('a wrong signing secret returns SIGNATURE_MISMATCH and the readable sentence from server.mjs', async () => {
    const a = await startRelay('w2m-phase2-signature-', { signingSecret: 'the-real-shared-secret' });
    try {
      const token = await pairDevice(a, 'm-a');
      const rawBody = JSON.stringify({ session_id: 's-1', text: 'signed by a stranger' });
      const headers = createSigner({ secret: 'not-the-real-shared-secret' })
        .headers({ method: 'POST', path: '/v1/fleet/messages', body: rawBody });
      const response = await call(a.url, '/v1/fleet/messages', { method: 'POST', token, body: JSON.parse(rawBody), headers });
      assert.equal(response.status, 401, response.text);
      assert.equal(response.json.error.code, 'SIGNATURE_MISMATCH');
      // The text the GBK/UTF-8 re-encode had destroyed: an em dash inside a sentence a user reads.
      assert.equal(
        response.json.error.detail.hint,
        'the signature matches no configured secret \u2014 check for a stale or half-rotated secret',
      );
      assert.doesNotMatch(response.text, /[\u9225\u6402]/, 'no mojibake may reach the user-facing refusal');
    } finally {
      await closeAll([a.relay]);
    }
  });
});

describe('Phase 2 suites are wired into the release gates', () => {
  const suites = ['chat-store', 'project-sync', 'cluster-domains', 'relay-phase2-server'];

  it('names every Phase 2 suite in scripts.test, test:all and its own script', () => {
    for (const suite of suites) {
      const file = `test/${suite}.test.mjs`;
      assert.equal(PACKAGE.scripts[`test:${suite}`], `node --test --test-force-exit ${file}`, `test:${suite} missing`);
      assert.ok(PACKAGE.scripts.test.includes(file), `${file} missing from scripts.test (the release gate)`);
      assert.ok(PACKAGE.scripts['test:all'].includes(file), `${file} missing from test:all`);
      assert.equal(existsSync(join(ROOT, file)), true, `${file} missing`);
    }
    assert.ok(
      PACKAGE.scripts['test:cluster-phase2'].includes('test/relay-phase2-server.test.mjs'),
      'the combined Phase 2 script must run the server wiring too',
    );
  });
});
