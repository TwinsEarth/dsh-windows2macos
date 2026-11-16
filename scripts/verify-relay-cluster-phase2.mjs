#!/usr/bin/env node
/**
 * Relay Phase 2 — real-process verification (chat + project room cross-relay sync).
 *
 * Starts three `w2m-rabbit` child processes (the deployed CLI) with separate state dirs, makes them
 * peers, seeds one relay with a device/task (Phase 1) and another with a project room + shared
 * objects (Phase 2), then checks over the real HTTP cluster routes:
 *
 *   1. every relay advertises relay-cluster-sync-v1 + relay-cluster-chat-v1 + relay-cluster-projects-v1
 *      and reports both Phase 2 domains enabled;
 *   2. a chat message posted on relay A becomes visible on B and C;
 *   3. a read watermark set on A is replicated to B;
 *   4. a project room (project, members, decision, artifact, memory) seeded on A converges to B/C;
 *   5. unsigned Phase 2 cluster routes are rejected with 401.
 *
 * Run from the repo root: node scripts/verify-relay-cluster-phase2.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY = join(repoRoot, 'bin', 'w2m-rabbit.mjs');
const SECRET = randomBytes(32).toString('base64');
const NODE = { a: 'node-aaaa1111', b: 'node-bbbb2222', c: 'node-cccc3333' };
const DEVICE_TOKEN = 'token-phase2-b1';
const DEVICE_ID = 'm-b1';
const SESSION_ID = 'verify-chat-session';
const PROJECT_ID = 'prj-verify';

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail }); console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); })
    .catch((err) => { results.push({ name, ok: false, detail: String(err?.message ?? err) }); console.log(`  FAIL  ${name} — ${String(err?.message ?? err).slice(0, 300)}`); });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function startRelay({ nodeId, port, stateDir, peers }) {
  const env = {
    ...process.env,
    W2M_RELAY_VERSION: '3.0.0',
    W2M_RELAY_NODE_ID: nodeId,
    W2M_RELAY_PEERS: JSON.stringify(peers),
    W2M_RELAY_CLUSTER_SECRET: SECRET,
    // Phase 1: fast first sync in the test.
    W2M_RELAY_SYNC_INTERVAL_MS: '600000',
    W2M_RELAY_SYNC_BOOT_MIN_MS: '800',
    W2M_RELAY_SYNC_BOOT_MAX_MS: '1500',
    W2M_RELAY_SYNC_JITTER_MS: '2000',
    // Phase 2: short chat interval; project state syncs once during the boot window.
    W2M_RELAY_CHAT_SYNC_MS: '5000',
    W2M_RELAY_CHAT_SYNC_BOOT_MIN_MS: '800',
    W2M_RELAY_CHAT_SYNC_BOOT_MAX_MS: '1500',
    W2M_RELAY_SYNC_CHUNK_BYTES: '262144',
  };
  const child = spawn(process.execPath, [RELAY, '--port', String(port), '--json', '--state', stateDir], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { log.stdout += chunk; });
  child.stderr.on('data', (chunk) => { log.stderr += chunk; });
  return { name: nodeId, port, child, log, url: `http://127.0.0.1:${port}` };
}

const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });

async function waitFor(valueFn, { timeoutMs = 20_000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await valueFn().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, body: parsed };
}

/* ---------------- fixtures ---------------- */

function seedPhase1State(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'devices.json'), JSON.stringify({
    [DEVICE_ID]: {
      machine_name: 'verify-machine',
      platform: { os: 'linux', arch: 'x64' },
      caps: {},
      user_id: null,
      device_token: DEVICE_TOKEN,
      paired_at: '2026-01-01T00:00:00Z',
      re_paired: false,
      fleet_id: 'fleet-verify',
      fleet_source: 'verify-script',
    },
  }, null, 2));
}

function seedPhase2State(stateDir) {
  const projectsDir = join(stateDir, 'projects');
  mkdirSync(projectsDir, { recursive: true });
  const at = '2026-01-01T00:00:00Z';
  const project = {
    project_id: PROJECT_ID,
    name: 'phase2-verify',
    origin: null,
    created_at: at,
    created_by: { kind: 'machine', id: DEVICE_ID },
    settings: { merge_requires_review: false, merge_requires_tests: false },
    members: [{ kind: 'machine', id: DEVICE_ID, name: 'verify-machine', role: 'owner', joined_at: at }],
  };
  writeFileSync(join(projectsDir, 'room-snapshot.json'), JSON.stringify({
    v: 1,
    counter: 1,
    seq: 1,
    last_event_seq: 1,
    projects: [project],
    events: [{ seq: 1, project_id: PROJECT_ID, type: 'project.created', actor: { kind: 'machine', id: DEVICE_ID }, payload: { name: project.name }, at }],
  }));
  writeFileSync(join(projectsDir, 'objects.json'), JSON.stringify({
    v: 1,
    artifacts: [{ project_id: PROJECT_ID, sha256: 'a'.repeat(64), bytes: 123, kind: 'artifact', source_task_id: null, created_at: at }],
    decisions: [{ decision_id: PROJECT_ID + '-d0001', project_id: PROJECT_ID, title: 'phase2 decision', text: 'synced', kind: 'decision', refs: {}, actor: null, created_at: at }],
    memory: [{ project_id: PROJECT_ID, text: 'phase2 memory', version: 1, updated_at: at, actor: null }],
  }));
}

/* ---------------- main ---------------- */

const root = mkdtempSync(join(tmpdir(), 'w2m-phase2-verify-'));
const dirs = { a: join(root, 'a'), b: join(root, 'b'), c: join(root, 'c') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
seedPhase1State(dirs.b);
seedPhase2State(dirs.a);

const ports = { a: await freePort(), b: await freePort(), c: await freePort() };
const peersOf = (self, others) => others
  .filter((id) => id !== self)
  .map((id) => ({ id: NODE[id], url: `http://127.0.0.1:${ports[id]}` }));

const relays = [];
const cleanup = async () => {
  for (const relay of relays) {
    try { relay.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await sleep(200);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
};

try {
  console.log('relay cluster Phase 2 real-process verification');
  console.log(`  temp root: ${root}`);
  relays.push(
    startRelay({ nodeId: NODE.a, port: ports.a, stateDir: dirs.a, peers: peersOf('a', ['b', 'c']) }),
    startRelay({ nodeId: NODE.b, port: ports.b, stateDir: dirs.b, peers: peersOf('b', ['a', 'c']) }),
    startRelay({ nodeId: NODE.c, port: ports.c, stateDir: dirs.c, peers: peersOf('c', ['a', 'b']) }),
  );
  await waitFor(async () => relays.every((relay) => /"event":"listening"/.test(relay.log.stdout)), { label: 'three relays listening' });
  console.log('  all three relays listening');

  await check('Phase 1 + Phase 2 feature bits advertised; both domains enabled', async () => {
    for (const relay of relays) {
      const { body } = await getJson(`${relay.url}/healthz`);
      for (const feature of ['relay-cluster-sync-v1', 'relay-cluster-chat-v1', 'relay-cluster-projects-v1']) {
        if (!body.features.includes(feature)) throw new Error(`${relay.name}: missing ${feature}`);
      }
      if (body.cluster?.domains?.chat?.enabled !== true) throw new Error(`${relay.name}: chat domain not enabled`);
      if (body.cluster?.domains?.projects?.enabled !== true) throw new Error(`${relay.name}: project domain not enabled`);
    }
    return '3 feature bits + chat/projects domains on 3/3 relays';
  });

  await check('device/task sync (Phase 1) still works', async () => {
    await waitFor(async () => {
      for (const relay of relays) {
        const { status, body } = await getJson(`${relay.url}/v1/devices`, { authorization: `Bearer ${DEVICE_TOKEN}` });
        if (status !== 200 || !body.devices?.some((device) => device.machine_id === DEVICE_ID)) return false;
      }
      return true;
    }, { timeoutMs: 30_000, label: 'device visible on all relays' });
    return `${DEVICE_ID} on 3/3 relays`;
  });

  await check('chat message posted on A is visible on B and C', async () => {
    const posted = await postJson(`${relays[0].url}/v1/fleet/messages`, { authorization: `Bearer ${DEVICE_TOKEN}` }, {
      session_id: SESSION_ID,
      text: 'phase2 hello from A',
      to: 'all',
    });
    if (posted.status !== 200 || typeof posted.body?.message?.message_id !== 'string') {
      throw new Error(`post on A failed: ${posted.status} ${JSON.stringify(posted.body)?.slice(0, 200)}`);
    }
    const messageId = posted.body.message.message_id;
    await waitFor(async () => {
      for (const relay of [relays[1], relays[2]]) {
        const { status, body } = await getJson(`${relay.url}/v1/fleet/messages?session_id=${encodeURIComponent(SESSION_ID)}&limit=50`, { authorization: `Bearer ${DEVICE_TOKEN}` });
        if (status !== 200 || !body.messages?.some((message) => message.message_id === messageId)) return false;
      }
      return true;
    }, { timeoutMs: 25_000, intervalMs: 250, label: 'chat message on B/C' });
    return `message ${messageId} on B and C`;
  });

  await check('chat read watermark set on A replicates to B', async () => {
    const put = await fetch(`${relays[0].url}/v1/fleet/read/${encodeURIComponent(SESSION_ID)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DEVICE_TOKEN}` },
      body: JSON.stringify({ at_ms: Date.now(), message_id: null }),
      signal: AbortSignal.timeout(5000),
    });
    if (put.status !== 200) throw new Error(`read PUT on A: ${put.status}`);
    await waitFor(async () => {
      const { status, body } = await getJson(`${relays[1].url}/v1/fleet/read/${encodeURIComponent(SESSION_ID)}`, { authorization: `Bearer ${DEVICE_TOKEN}` });
      if (status !== 200 || body.mark === null || body.mark === undefined) return false;
      return true;
    }, { timeoutMs: 25_000, intervalMs: 250, label: 'read watermark on B' });
    return 'read mark replicated to B';
  });

  await check('project room seeded on A converges to B and C', async () => {
    await waitFor(async () => {
      for (const relay of [relays[1], relays[2]]) {
        const { status, body } = await getJson(`${relay.url}/v1/projects/${PROJECT_ID}`, { authorization: `Bearer ${DEVICE_TOKEN}` });
        if (status !== 200 || body.project?.project_id !== PROJECT_ID) return false;
        if (body.project.name !== 'phase2-verify') return false;
      }
      return true;
    }, { timeoutMs: 30_000, intervalMs: 250, label: 'project on B/C' });
    return `${PROJECT_ID} on B and C`;
  });

  await check('project shared objects (decision/artifact/memory) sync to B', async () => {
    const { status: decisionsStatus, body: decisions } = await getJson(`${relays[1].url}/v1/projects/${PROJECT_ID}/decisions`, { authorization: `Bearer ${DEVICE_TOKEN}` });
    if (decisionsStatus !== 200 || !decisions.decisions?.some((entry) => entry.title === 'phase2 decision')) throw new Error('decision missing on B');
    const { status: artifactsStatus, body: artifacts } = await getJson(`${relays[1].url}/v1/projects/${PROJECT_ID}/artifacts`, { authorization: `Bearer ${DEVICE_TOKEN}` });
    if (artifactsStatus !== 200 || !artifacts.artifacts?.some((entry) => entry.sha256 === 'a'.repeat(64))) throw new Error('artifact missing on B');
    const { status: memoryStatus, body: memory } = await getJson(`${relays[1].url}/v1/projects/${PROJECT_ID}/memory`, { authorization: `Bearer ${DEVICE_TOKEN}` });
    if (memoryStatus !== 200 || memory.document?.text !== 'phase2 memory') throw new Error('memory missing on B');
    return 'decision + artifact + memory present on B';
  });

  await check('project room survives a relay restart (chat + project persistence)', async () => {
    // Restart A with the same state directory: chat must come back from the replication log, and the
    // project room + shared objects from their own files. This is the "durable first" half of D1.
    const restarted = relays[0];
    restarted.child.kill('SIGKILL');
    await new Promise((resolveExit) => restarted.child.once('exit', resolveExit));
    await sleep(300);
    const relay = startRelay({ nodeId: NODE.a, port: ports.a, stateDir: dirs.a, peers: peersOf('a', ['b', 'c']) });
    relays[0] = relay;
    await waitFor(async () => /"event":"listening"/.test(relay.log.stdout), { timeoutMs: 20_000, label: 'relay A restarted' });
    await waitFor(async () => {
      const { status, body } = await getJson(`${relay.url}/healthz`).catch(() => ({ status: 0, body: null }));
      return status === 200 && body?.ok === true;
    }, { timeoutMs: 20_000, label: 'relay A healthz after restart' });

    const { status: chatStatus, body: chatBody } = await getJson(`${relay.url}/v1/fleet/messages?session_id=${encodeURIComponent(SESSION_ID)}&limit=50`, { authorization: `Bearer ${DEVICE_TOKEN}` });
    if (chatStatus !== 200 || !chatBody.messages?.some((message) => message.session_id === SESSION_ID)) throw new Error('chat history missing after restart');
    const { status: projectStatus, body: projectBody } = await getJson(`${relay.url}/v1/projects/${PROJECT_ID}`, { authorization: `Bearer ${DEVICE_TOKEN}` });
    if (projectStatus !== 200 || projectBody.project?.project_id !== PROJECT_ID) throw new Error('project room missing after restart');
    const { body: memoryBody } = await getJson(`${relay.url}/v1/projects/${PROJECT_ID}/memory`, { authorization: `Bearer ${DEVICE_TOKEN}` });
    if (memoryBody.document?.text !== 'phase2 memory') throw new Error('project objects missing after restart');
    return 'chat history + project room + objects restored on A';
  });

  await check('Phase 2 domain diagnostics report a successful round', async () => {
    // A restart (previous check) leaves the restarted relay's peers probing it while it boots; wait
    // for one clean round instead of requiring the very next sample to be green.
    await waitFor(async () => {
      for (const relay of relays) {
        const { body } = await getJson(`${relay.url}/healthz`);
        const chat = body.cluster?.domains?.chat;
        const projects = body.cluster?.domains?.projects;
        if (chat?.last_ok !== true || projects?.last_ok !== true) return false;
      }
      return true;
    }, { timeoutMs: 30_000, intervalMs: 500, label: 'domain last_ok on all relays' });
    return 'chat + projects last_ok on 3/3 relays';
  });

  await check('Phase 2 cluster routes reject unsigned requests', async () => {
    for (const relay of relays) {
      for (const path of ['/v1/cluster/chat?since=0', '/v1/cluster/projects?since=0']) {
        const response = await fetch(`${relay.url}${path}`, { signal: AbortSignal.timeout(5000) });
        if (response.status !== 401) throw new Error(`${relay.name}${path}: expected 401, got ${response.status}`);
      }
    }
    return '401 on chat/projects routes for 3/3 relays';
  });

  console.log('  --- failure diagnostics (only printed on failure) ---');
  for (const relay of relays) {
    const failed = results.filter((entry) => entry.ok === false);
    if (failed.length > 0 && relay.log.stderr !== '') console.log(`  ${relay.name} stderr: ${relay.log.stderr.slice(0, 1200)}`);
  }
} catch (err) {
  console.error(`verification aborted: ${err?.message ?? err}`);
  for (const relay of relays) {
    if (relay.log.stdout || relay.log.stderr) {
      console.error(`  ${relay.name} stdout: ${relay.log.stdout.slice(0, 600)}`);
      console.error(`  ${relay.name} stderr: ${relay.log.stderr.slice(0, 900)}`);
    }
  }
} finally {
  await cleanup();
}

const failed = results.filter((entry) => entry.ok === false);
console.log('');
console.log(`checks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
