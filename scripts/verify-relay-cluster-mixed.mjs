#!/usr/bin/env node
/**
 * Relay 3.1.0 mixed-version verification (Phase 2 safety during a rolling upgrade).
 *
 * Starts two real **Relay 3.0.0** processes (the previously released archive) and one **3.1.0**
 * process (this checkout), all peers, then checks:
 *
 *   1. Phase 1 device/task sync still works across the mixed cluster;
 *   2. the 3.1.0 relay skips chat/project domains for 3.0.0 peers (they are Phase 1 only) instead of
 *      reporting an error — `domains.*.peers[].unsupported = true`, `last_ok = true`;
 *   3. the old relays are unaffected: still 3.0.0, Phase 1 cluster healthy, one feature bit;
 *   4. rolling upgrade: restart one old relay with 3.1.0 and the two new relays start syncing chat
 *      with each other while the remaining old peer is still skipped.
 *
 * Point W2M_RELAY_OLD_TGZ at a Relay 3.0.0 release archive (defaults to the private checkout path).
 * Run from the repo root: node scripts/verify-relay-cluster-mixed.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const NEW_RELAY = join(repoRoot, 'bin', 'w2m-rabbit.mjs');
const OLD_TGZ = process.env.W2M_RELAY_OLD_TGZ
  ?? join('E:\\GPT', '_work', 'w2m-ops-private-repo', 'relay', 'releases', 'w2m-relay-3.0.0.tgz');
const SECRET = randomBytes(32).toString('base64');
const NODE = { a: 'node-aaaa1111', b: 'node-bbbb2222', c: 'node-cccc3333' };
const DEVICE_TOKEN = 'token-mixed-b1';
// F4 (mixed): dispatch/result paths must work on the upgraded relay while an old relay is still 3.0.0.
const OPERATOR_TOKEN = 'verify-f4-mixed-operator';
const DEVICE_ID = 'm-b1';
const SESSION_ID = 'mixed-chat-session';

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

const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });

async function waitFor(valueFn, { timeoutMs = 25_000, intervalMs = 150, label = 'condition' } = {}) {
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

function startRelay({ bin, nodeId, port, stateDir, peers, label }) {
  const env = {
    ...process.env,
    W2M_RELAY_VERSION: label === 'old' ? '3.0.0' : '3.1.0',
    W2M_RELAY_NODE_ID: nodeId,
    W2M_RELAY_PEERS: JSON.stringify(peers),
    W2M_RELAY_CLUSTER_SECRET: SECRET,
    W2M_RELAY_SYNC_INTERVAL_MS: '600000',
    W2M_RELAY_SYNC_BOOT_MIN_MS: '800',
    W2M_RELAY_SYNC_BOOT_MAX_MS: '1500',
    W2M_RELAY_SYNC_JITTER_MS: '2000',
    W2M_RELAY_CHAT_SYNC_MS: '5000',
    W2M_RELAY_CHAT_SYNC_BOOT_MIN_MS: '800',
    W2M_RELAY_CHAT_SYNC_BOOT_MAX_MS: '1500',
    W2M_OPERATOR_TOKEN: OPERATOR_TOKEN,
  };
  const child = spawn(process.execPath, [bin, '--port', String(port), '--json', '--state', stateDir], {
    cwd: dirname(bin),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { log.stdout += chunk; });
  child.stderr.on('data', (chunk) => { log.stderr += chunk; });
  return { name: nodeId, port, child, log, url: `http://127.0.0.1:${port}`, label };
}

function seedPhase1State(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'devices.json'), JSON.stringify({
    [DEVICE_ID]: {
      machine_name: 'mixed-machine',
      platform: { os: 'linux', arch: 'x64' },
      caps: {},
      user_id: null,
      device_token: DEVICE_TOKEN,
      paired_at: '2026-01-01T00:00:00Z',
      re_paired: false,
      fleet_id: 'fleet-mixed',
      fleet_source: 'verify-script',
    },
  }, null, 2));
}

/* ---------------- main ---------------- */

const root = mkdtempSync(join(tmpdir(), 'w2m-mixed-verify-'));
const dirs = { a: join(root, 'a'), b: join(root, 'b'), c: join(root, 'c') };
const oldDir = join(root, 'oldpkg');
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
if (!existsSync(OLD_TGZ)) {
  console.error(`missing Relay 3.0.0 archive: ${OLD_TGZ} (set W2M_RELAY_OLD_TGZ)`);
  process.exit(2);
}
mkdirSync(oldDir, { recursive: true });
const untar = spawnSync('tar', ['-xzf', OLD_TGZ, '-C', oldDir], { encoding: 'utf8' });
if (untar.status !== 0) {
  console.error(`tar failed: ${untar.stderr || untar.error?.message || ''}`);
  process.exit(2);
}
const OLD_RELAY = join(oldDir, 'bin', 'w2m-rabbit.mjs');
seedPhase1State(dirs.b);

const ports = { a: await freePort(), b: await freePort(), c: await freePort() };
const peersOf = (self, others) => others
  .filter((id) => id !== self)
  .map((id) => ({ id: NODE[id], url: `http://127.0.0.1:${ports[id]}` }));

const relays = { a: null, b: null, c: null };
const cleanup = async () => {
  for (const relay of Object.values(relays)) {
    if (relay === null) continue;
    try { relay.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await sleep(200);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
};

try {
  console.log('relay mixed-version (3.0.0 + 3.1.0) verification');
  console.log(`  old archive: ${OLD_TGZ}`);
  relays.a = startRelay({ bin: OLD_RELAY, nodeId: NODE.a, port: ports.a, stateDir: dirs.a, peers: peersOf('a', ['b', 'c']), label: 'old' });
  relays.b = startRelay({ bin: OLD_RELAY, nodeId: NODE.b, port: ports.b, stateDir: dirs.b, peers: peersOf('b', ['a', 'c']), label: 'old' });
  relays.c = startRelay({ bin: NEW_RELAY, nodeId: NODE.c, port: ports.c, stateDir: dirs.c, peers: peersOf('c', ['a', 'b']), label: 'new' });
  await waitFor(async () => [relays.a, relays.b, relays.c].every((relay) => /"event":"listening"/.test(relay.log.stdout)), { label: 'three relays listening' });
  console.log('  all three relays listening (2 old, 1 new)');

  await check('mixed cluster: old relays are 3.0.0/Phase 1, new relay advertises 3.1.0 bits', async () => {
    for (const key of ['a', 'b']) {
      const { body } = await getJson(`${relays[key].url}/healthz`);
      if (body.relay_version !== '3.0.0') throw new Error(`${key}: version ${body.relay_version}`);
      if (body.features.includes('relay-cluster-chat-v1')) throw new Error(`${key}: old relay unexpectedly advertises chat`);
    }
    const { body } = await getJson(`${relays.c.url}/healthz`);
    for (const feature of ['relay-cluster-sync-v1', 'relay-cluster-chat-v1', 'relay-cluster-projects-v1']) {
      if (!body.features.includes(feature)) throw new Error(`new relay missing ${feature}`);
    }
    return '2x 3.0.0 + 1x 3.1.0';
  });

  await check('Phase 1 device sync works in the mixed cluster', async () => {
    await waitFor(async () => {
      for (const key of ['a', 'b', 'c']) {
        const { status, body } = await getJson(`${relays[key].url}/v1/devices`, { authorization: `Bearer ${DEVICE_TOKEN}` });
        if (status !== 200 || !body.devices?.some((device) => device.machine_id === DEVICE_ID)) return false;
      }
      return true;
    }, { timeoutMs: 30_000, label: 'device visible on 3 mixed relays' });
    return `${DEVICE_ID} on old+new relays`;
  });

  await check('new relay skips Phase 2 domains for Phase 1-only peers (no domain failure)', async () => {
    await waitFor(async () => {
      const { body } = await getJson(`${relays.c.url}/healthz`);
      const chat = body.cluster?.domains?.chat;
      const projects = body.cluster?.domains?.projects;
      if (chat?.last_ok !== true || projects?.last_ok !== true) return false;
      const oldPeers = (chat.peers ?? []).filter((peer) => peer.id === NODE.a || peer.id === NODE.b);
      if (oldPeers.length !== 2) return false;
      return oldPeers.every((peer) => peer.unsupported === true && peer.last_error === null);
    }, { timeoutMs: 30_000, intervalMs: 250, label: 'domains skip old peers' });
    return 'chat/projects last_ok=true, old peers unsupported=true';
  });

  await check('old relays stay healthy and Phase 1 cluster sync is not affected', async () => {
    await waitFor(async () => {
      for (const key of ['a', 'b']) {
        const { body } = await getJson(`${relays[key].url}/healthz`);
        if (body.cluster?.last_ok !== true) return false;
        if (body.cluster.peers.some((peer) => peer.last_ok_at === null)) return false;
      }
      return true;
    }, { timeoutMs: 30_000, intervalMs: 250, label: 'old relays phase 1 healthy' });
    return '3.0.0 relays report last_ok=true';
  });

  await check('rolling upgrade: one old relay restarts as 3.1.0 and chats with the new relay', async () => {
    const restarted = relays.a;
    restarted.child.kill('SIGKILL');
    await new Promise((resolveExit) => restarted.child.once('exit', resolveExit));
    await sleep(300);
    relays.a = startRelay({ bin: NEW_RELAY, nodeId: NODE.a, port: ports.a, stateDir: dirs.a, peers: peersOf('a', ['b', 'c']), label: 'new' });
    await waitFor(async () => /"event":"listening"/.test(relays.a.log.stdout), { timeoutMs: 20_000, label: 'relay A restarted as 3.1.0' });
    await waitFor(async () => {
      const { body } = await getJson(`${relays.c.url}/healthz`);
      const peerA = body.cluster?.domains?.chat?.peers?.find((peer) => peer.id === NODE.a);
      return body.cluster?.domains?.chat?.last_ok === true && peerA !== undefined && peerA.unsupported !== true;
    }, { timeoutMs: 30_000, intervalMs: 250, label: 'C sees A as Phase 2 capable' });

    const posted = await postJson(`${relays.c.url}/v1/fleet/messages`, { authorization: `Bearer ${DEVICE_TOKEN}` }, {
      session_id: SESSION_ID,
      text: 'mixed rolling hello',
      to: 'all',
    });
    if (posted.status !== 200 || typeof posted.body?.message?.message_id !== 'string') throw new Error(`post on C: ${posted.status}`);
    const messageId = posted.body.message.message_id;
    await waitFor(async () => {
      const { status, body } = await getJson(`${relays.a.url}/v1/fleet/messages?session_id=${encodeURIComponent(SESSION_ID)}&limit=50`, { authorization: `Bearer ${DEVICE_TOKEN}` });
      return status === 200 && body.messages?.some((message) => message.message_id === messageId);
    }, { timeoutMs: 30_000, intervalMs: 250, label: 'chat on upgraded A' });
    return `chat ${messageId} reached upgraded A while B is still 3.0.0`;
  });

  /** One §5.1-complete result envelope; the relay ignores envelope_sha256 (dedupe is by dedupe_key). */
  function resultEnvelope(taskId) {
    const empty = createHash('sha256').update('').digest('hex');
    return {
      envelope_version: '1.0',
      task_id: taskId,
      attempt: 1,
      dedupe_key: 'dk-mixed-f4-' + taskId,
      machine_id: DEVICE_ID,
      machine_name: 'mixed-machine',
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
      command_argv: [process.execPath, '-e', 'process.stdout.write("mixed-f4\\n")'],
      command_hash: 'a'.repeat(64),
      shell_id: 'direct-exec',
      started_at: '2026-01-01T00:00:00Z',
      ended_at: '2026-01-01T00:00:01Z',
      duration_ms: 4,
      exit_code: 0,
      status: 'ok',
      refusal_reason: null,
      stdout_sha256: createHash('sha256').update('mixed-f4\n').digest('hex'),
      stdout_bytes: 9,
      stderr_sha256: empty,
      stderr_bytes: 0,
      warnings: [],
      envelope_sha256: 'ignored-by-the-relay',
    };
  }

  await check('F4 (mixed): dispatch and duplicate-result dedupe work on the upgraded relay', async () => {
    const dispatched = await postJson(`${relays.a.url}/v1/task`, { authorization: `Bearer ${OPERATOR_TOKEN}` }, {
      mode: 'replicate',
      command_argv: [process.execPath, '-e', 'process.stdout.write("mixed-f4\\n")'],
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
    if (dispatched.status !== 200 || typeof dispatched.body?.task_id !== 'string') {
      throw new Error(`dispatch on upgraded relay: ${dispatched.status} ${JSON.stringify(dispatched.body).slice(0, 200)}`);
    }
    const env = resultEnvelope(dispatched.body.task_id);
    const first = await postJson(`${relays.a.url}/v1/result`, { authorization: `Bearer ${DEVICE_TOKEN}` }, env);
    if (first.status !== 200) throw new Error(`first result: ${first.status} ${JSON.stringify(first.body).slice(0, 220)}`);
    if (first.body.deduped !== false) throw new Error(`first result deduped=${JSON.stringify(first.body.deduped)}; expected false`);
    const repeat = await postJson(`${relays.a.url}/v1/result`, { authorization: `Bearer ${DEVICE_TOKEN}` }, env);
    if (repeat.status !== 200 || repeat.body.deduped !== true) {
      throw new Error(`duplicate result was not deduped on the upgraded relay: ${repeat.status} ${JSON.stringify(repeat.body).slice(0, 220)}`);
    }
    return `task ${dispatched.body.task_id}: dispatch + duplicate result dedupe on 3.1.0 relay while B is 3.0.0`;
  });

  await check('remaining old relay is still healthy after the rolling restart', async () => {
    const { body } = await getJson(`${relays.b.url}/healthz`);
    if (body.relay_version !== '3.0.0') throw new Error(`B version ${body.relay_version}`);
    if (body.cluster?.last_ok !== true) throw new Error('B cluster last_ok=false');
    if (body.features.includes('relay-cluster-chat-v1')) throw new Error('B unexpectedly advertises chat');
    return 'B (3.0.0) unaffected';
  });

  console.log('  --- failure diagnostics (only printed on failure) ---');
  for (const relay of Object.values(relays)) {
    if (relay === null) continue;
    const failed = results.filter((entry) => entry.ok === false);
    if (failed.length > 0 && relay.log.stderr !== '') console.log(`  ${relay.name} stderr: ${relay.log.stderr.slice(0, 1000)}`);
  }
} catch (err) {
  console.error(`verification aborted: ${err?.message ?? err}`);
  for (const [key, relay] of Object.entries(relays)) {
    if (relay === null) continue;
    if (relay.log.stdout || relay.log.stderr) console.error(`  ${key} stdout: ${relay.log.stdout.slice(0, 500)} stderr: ${relay.log.stderr.slice(0, 700)}`);
  }
} finally {
  await cleanup();
}

const failed = results.filter((entry) => entry.ok === false);
console.log('');
console.log(`checks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
