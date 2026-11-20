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
import { createHash, randomBytes } from 'node:crypto';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY = join(repoRoot, 'bin', 'w2m-rabbit.mjs');
const SECRET = randomBytes(32).toString('base64');
const NODE = { a: 'node-aaaa1111', b: 'node-bbbb2222', c: 'node-cccc3333' };
const DEVICE_TOKEN = 'token-phase2-b1';
const DEVICE_ID = 'm-b1';
const SESSION_ID = 'verify-chat-session';
const PROJECT_ID = 'prj-verify';
// F4: dispatch needs the operator credential; the fault scenarios below are the real-process half of
// `test/p2p-fault.test.mjs` / `test/relay-concurrency.test.mjs` (which cover sockets and clock races in-process).
const OPERATOR_TOKEN = 'verify-f4-operator';

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
    // F4: allow POST /v1/task in this harness (dispatch is the operator's act, not a device's).
    W2M_OPERATOR_TOKEN: OPERATOR_TOKEN,
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

  /**
   * Build one §5.1-complete result envelope for a dispatched task.
   *
   * The relay ignores `envelope_sha256` (the client signs it; the relay re-derives its own judgement from the
   * fields), so this object only has to be *complete* and self-consistent. Dispatch is per-call by design
   * (the relay mints a new ULID each POST); idempotency lives at the result layer via `dedupe_key`, which is
   * exactly what these checks exercise.
   */
  function resultEnvelope(taskId, over = {}) {
    const empty = createHash('sha256').update('').digest('hex');
    const stdout = createHash('sha256').update('f4-stdout\n').digest('hex');
    return {
      envelope_version: '1.0',
      task_id: taskId,
      attempt: 1,
      dedupe_key: 'dk-f4-' + taskId,
      machine_id: DEVICE_ID,
      machine_name: 'verify-machine',
      platform: { os: 'linux', arch: 'x64' },
      caps: {},
      index: 0,
      index_total: 1,
      mode: 'replicate',
      cwd_rel: '.',
      base_commit: 'c0ffee1',
      base_tree: 'tree-abc',
      pre_tree_fingerprint: 'tree-abc',
      post_tree_fingerprint: 'tree-abc',
      fingerprint_algo: 'git-temp-index-tree/v1',
      fingerprint_error: null,
      head_commit: 'c0ffee1',
      dirty_before: false,
      command_argv: [process.execPath, '-e', 'process.stdout.write("f4-duplicate\\n")'],
      command_hash: 'a'.repeat(64),
      shell_id: 'direct-exec',
      started_at: '2026-01-01T00:00:00Z',
      ended_at: '2026-01-01T00:00:01Z',
      duration_ms: 5,
      exit_code: 0,
      status: 'ok',
      refusal_reason: null,
      stdout_sha256: stdout,
      stdout_bytes: 11,
      stderr_sha256: empty,
      stderr_bytes: 0,
      warnings: [],
      envelope_sha256: 'ignored-by-the-relay',
      ...over,
    };
  }

  // F4-a: dispatch is per-call (documented), and every dispatch is readable with exactly one lease.
  await check('F4: two dispatches are two independently readable tasks (dispatch is per-call, not idempotent)', async () => {
    const body = {
      mode: 'replicate',
      command_argv: [process.execPath, '-e', 'process.stdout.write("f4-duplicate\\n")'],
      cwd_rel: '.',
      index_total: 1,
      timeout_ms: 30_000,
      write: false,
      base_commit: 'c0ffee1',
      base_tree: 'tree-abc',
      compare_policy: { strip_ansi: true, normalize_crlf: true },
      halt: 'never',
      created_by: 'verify-f4',
    };
    const first = await postJson(`${relays[0].url}/v1/task`, { authorization: `Bearer ${OPERATOR_TOKEN}` }, body);
    if (first.status !== 200 || typeof first.body?.task_id !== 'string') throw new Error(`first dispatch: ${first.status} ${JSON.stringify(first.body).slice(0, 200)}`);
    const taskId = first.body.task_id;
    const second = await postJson(`${relays[0].url}/v1/task`, { authorization: `Bearer ${OPERATOR_TOKEN}` }, body);
    if (second.status !== 200) throw new Error(`second dispatch status ${second.status}`);
    if (second.body.task_id === taskId) throw new Error(`dispatch returned the same task_id twice; the contract is per-call (${taskId})`);
    for (const id of [taskId, second.body.task_id]) {
      const read = await getJson(`${relays[0].url}/v1/tasks/${encodeURIComponent(id)}`, { authorization: `Bearer ${DEVICE_TOKEN}` });
      if (read.status !== 200) throw new Error(`task ${id} read status ${read.status}`);
      const leases = read.body.task?.leases ?? [];
      if (leases.length !== 1) throw new Error(`task ${id}: expected exactly one lease, got ${JSON.stringify(leases).slice(0, 160)}`);
    }
    return `two dispatches -> ${taskId} + ${second.body.task_id}, one lease each`;
  });

  // F4-b: result redelivery is idempotent, and that dedupe survives a relay restart.
  await check('F4: duplicate result deduped, and the dedupe index survives a relay restart', async () => {
    const created = await postJson(`${relays[0].url}/v1/task`, { authorization: `Bearer ${OPERATOR_TOKEN}` }, {
      mode: 'replicate',
      command_argv: [process.execPath, '-e', 'process.stdout.write("f4-duplicate\\n")'],
      cwd_rel: '.',
      index_total: 1,
      timeout_ms: 30_000,
      write: false,
      base_commit: 'c0ffee1',
      base_tree: 'tree-abc',
      compare_policy: { strip_ansi: true, normalize_crlf: true },
      halt: 'never',
      created_by: 'verify-f4',
    });
    if (created.status !== 200 || typeof created.body?.task_id !== 'string') throw new Error(`dispatch before result: ${created.status}`);
    const taskId = created.body.task_id;
    const env = resultEnvelope(taskId);
    const first = await postJson(`${relays[0].url}/v1/result`, { authorization: `Bearer ${DEVICE_TOKEN}` }, env);
    if (first.status !== 200) throw new Error(`first result: ${first.status} ${JSON.stringify(first.body).slice(0, 220)}`);
    if (first.body.deduped !== false) throw new Error(`first result deduped=${JSON.stringify(first.body.deduped)}; expected false`);
    const repeat = await postJson(`${relays[0].url}/v1/result`, { authorization: `Bearer ${DEVICE_TOKEN}` }, env);
    if (repeat.status !== 200) throw new Error(`repeat result: ${repeat.status}`);
    if (repeat.body.deduped !== true) throw new Error(`repeat result deduped=${JSON.stringify(repeat.body.deduped)}; expected true`);

    const restartedOld = relays[0];
    restartedOld.child.kill('SIGKILL');
    await new Promise((resolveExit) => restartedOld.child.once('exit', resolveExit));
    await sleep(300);
    const relay = startRelay({ nodeId: NODE.a, port: ports.a, stateDir: dirs.a, peers: peersOf('a', ['b', 'c']) });
    relays[0] = relay;
    await waitFor(async () => /"event":"listening"/.test(relay.log.stdout), { timeoutMs: 20_000, label: 'relay A restarted for F4' });
    await waitFor(async () => {
      const { status } = await getJson(`${relay.url}/healthz`).catch(() => ({ status: 0 }));
      return status === 200;
    }, { timeoutMs: 20_000, label: 'relay A healthz after F4 restart' });

    const afterRestart = await postJson(`${relay.url}/v1/result`, { authorization: `Bearer ${DEVICE_TOKEN}` }, env);
    if (afterRestart.status !== 200) throw new Error(`post-restart result: ${afterRestart.status}`);
    if (afterRestart.body.deduped !== true) throw new Error(`post-restart result deduped=${JSON.stringify(afterRestart.body.deduped)}; the dedupe index did not survive the restart`);
    const task = await getJson(`${relay.url}/v1/tasks/${encodeURIComponent(taskId)}`, { authorization: `Bearer ${DEVICE_TOKEN}` });
    if (task.status !== 200) throw new Error(`post-restart task read: ${task.status}`);
    return `task ${taskId}: duplicate result deduped before and after restart`;
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
