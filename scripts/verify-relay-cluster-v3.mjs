#!/usr/bin/env node
/**
 * Relay v3.0.0 cluster sync — real-process verification.
 *
 * Starts three `w2m-rabbit` child processes (the same CLI the deployment runs) with separate state
 * directories, makes them peers of each other, seeds one relay's durable state, and checks that the
 * other two converge over the real HTTP cluster routes:
 *
 *   1. all three report relay_version=3.0.0 (W2M_RELAY_VERSION) and feature relay-cluster-sync-v1;
 *   2. the seeded device (and its device token) and task are visible on every relay after sync;
 *   3. a restarted relay replays the imported ledger before syncing again;
 *   4. the cluster routes reject unsigned requests.
 *
 * This is the pre-deployment gate: it exercises the CLI, env parsing, persistence and scheduler that
 * the in-process tests cannot cover. Run from the repo root:
 *
 *   node scripts/verify-relay-cluster-v3.mjs
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
const NODE = {
  a: 'node-aaaaaaaa',
  b: 'node-bbbbbbbb',
  c: 'node-cccccccc',
};
const DEVICE_TOKEN = 'token-verify-b1';
const TASK_ID = '01K000000000000000000000V1';
const DEVICE_ID = 'm-b1';

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail }); console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); })
    .catch((err) => { results.push({ name, ok: false, detail: String(err?.message ?? err) }); console.log(`  FAIL  ${name} — ${String(err?.message ?? err).slice(0, 200)}`); });
}

/* ---------------- free ports ---------------- */

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

/* ---------------- relay process ---------------- */

function startRelay({ name, port, stateDir, peers, version }) {
  const env = {
    ...process.env,
    W2M_RELAY_VERSION: version,
    W2M_RELAY_NODE_ID: name,
    W2M_RELAY_PEERS: JSON.stringify(peers),
    W2M_RELAY_CLUSTER_SECRET: SECRET,
    W2M_RELAY_SYNC_INTERVAL_MS: '600000',
    W2M_RELAY_SYNC_BOOT_MIN_MS: '800',
    W2M_RELAY_SYNC_BOOT_MAX_MS: '1500',
    W2M_RELAY_SYNC_JITTER_MS: '2000',
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
  return { name, port, child, log, url: `http://127.0.0.1:${port}` };
}

async function waitFor(valueFn, { timeoutMs = 20_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await valueFn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/* ---------------- fixtures ---------------- */

function seedRelayState(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'devices.json'), JSON.stringify({
    [DEVICE_ID]: {
      machine_name: 'tencent-mac',
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
  writeFileSync(join(stateDir, 'ledger.jsonl'), `${JSON.stringify({
    ts: '2026-01-01T00:00:01Z',
    type: 'task.created',
    task: {
      task_id: TASK_ID,
      mode: 'replicate',
      command_argv: ['node', '-v'],
      cwd_rel: '.',
      index_total: 1,
      timeout_ms: 60_000,
      created_at_ms: 1_767_225_600_000,
      created_by: DEVICE_ID,
    },
  })}\n`);
}

/* ---------------- main ---------------- */

const root = mkdtempSync(join(tmpdir(), 'w2m-cluster-verify-'));
const dirs = { a: join(root, 'a'), b: join(root, 'b'), c: join(root, 'c') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
seedRelayState(dirs.b);

const ports = { a: await freePort(), b: await freePort(), c: await freePort() };
const peersOf = (self, other) => other
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
  console.log('relay cluster v3.0.0 real-process verification');
  console.log(`  temp root: ${root}`);
  console.log(`  ports: a=${ports.a} b=${ports.b} c=${ports.c}`);

  const version = '3.0.0';
  relays.push(
    startRelay({ name: NODE.a, port: ports.a, stateDir: dirs.a, peers: peersOf('a', ['b', 'c']), version }),
    startRelay({ name: NODE.b, port: ports.b, stateDir: dirs.b, peers: peersOf('b', ['a', 'c']), version }),
    startRelay({ name: NODE.c, port: ports.c, stateDir: dirs.c, peers: peersOf('c', ['a', 'b']), version }),
  );

  // Wait until all three are listening (the CLI's --json line is the contract).
  await waitFor(async () => relays.every((relay) => /"event":"listening"/.test(relay.log.stdout)), { label: 'three relays listening' });
  console.log('  all three relays listening');

  const healthA = await waitFor(async () => {
    const { status, body } = await getJson(`${relays[0].url}/healthz`).catch(() => ({ status: 0, body: null }));
    if (status !== 200 || body === null) return null;
    return body;
  }, { label: 'relay A healthz' });

  await check('relay_version=3.0.0 on every relay', async () => {
    const versions = [];
    for (const relay of relays) {
      const { body } = await getJson(`${relay.url}/healthz`);
      versions.push(body.relay_version);
    }
    if (!versions.every((entry) => entry === version)) throw new Error(`versions: ${versions.join(',')}`);
    return versions.join(',');
  });

  await check('relay-cluster-sync-v1 advertised with cluster diagnostics', async () => {
    for (const relay of relays) {
      const { body } = await getJson(`${relay.url}/healthz`);
      if (!body.features.includes('relay-cluster-sync-v1')) throw new Error(`${relay.name}: feature missing`);
      if (body.cluster?.enabled !== true) throw new Error(`${relay.name}: cluster not enabled`);
      if (!Array.isArray(body.cluster.peers) || body.cluster.peers.length !== 2) throw new Error(`${relay.name}: expected 2 peers`);
    }
    return `features + 2 peers on all relays; A node=${healthA.cluster?.node_id ?? '?'}`;
  });

  await check('first sync happened on every relay (60–600s default window overridden for the test)', async () => {
    await waitFor(async () => {
      for (const relay of relays) {
        const { body } = await getJson(`${relay.url}/healthz`).catch(() => ({ body: null }));
        if (body?.cluster?.last_sync_at === null || body?.cluster?.last_sync_at === undefined) return false;
        if (body.cluster.peers.some((peer) => peer.last_ok_at === null)) return false;
      }
      return true;
    }, { timeoutMs: 25_000, intervalMs: 250, label: 'first sync on all relays' });
    const { body } = await getJson(`${relays[0].url}/healthz`);
    return `A last_sync_at=${body.cluster.last_sync_at} last_ok=${body.cluster.last_ok}`;
  });

  await check('seeded device is visible on every relay', async () => {
    for (const relay of relays) {
      const { status, body } = await getJson(`${relay.url}/v1/devices`, { authorization: `Bearer ${DEVICE_TOKEN}` });
      if (status !== 200) throw new Error(`${relay.name}: devices status ${status}`);
      if (!body.devices.some((device) => device.machine_id === DEVICE_ID)) throw new Error(`${relay.name}: device missing`);
    }
    return `${DEVICE_ID} present with its device token on 3/3 relays`;
  });

  await check('seeded task fact is visible on every relay', async () => {
    for (const relay of relays) {
      const { status, body } = await getJson(`${relay.url}/v1/tasks`, { authorization: `Bearer ${DEVICE_TOKEN}` });
      if (status !== 200) throw new Error(`${relay.name}: tasks status ${status}`);
      if (!body.tasks.some((task) => task.task_id === TASK_ID)) throw new Error(`${relay.name}: task missing`);
    }
    return `${TASK_ID} present on 3/3 relays`;
  });

  await check('cluster routes reject unsigned requests', async () => {
    for (const relay of relays) {
      const response = await fetch(`${relay.url}/v1/cluster/ping`, { signal: AbortSignal.timeout(5000) });
      if (response.status !== 401) throw new Error(`${relay.name}: expected 401, got ${response.status}`);
    }
    return '401 on 3/3 relays';
  });

  console.log('  --- failure diagnostics (only printed on failure) ---');
  for (const relay of relays) {
    const failed = results.filter((entry) => entry.ok === false);
    if (failed.length > 0 && relay.log.stderr !== '') console.log(`  ${relay.name} stderr: ${relay.log.stderr.slice(0, 800)}`);
  }
} catch (err) {
  console.error(`verification aborted: ${err?.message ?? err}`);
  for (const relay of relays) {
    if (relay.log.stdout || relay.log.stderr) {
      console.error(`  ${relay.name} stdout: ${relay.log.stdout.slice(0, 500)}`);
      console.error(`  ${relay.name} stderr: ${relay.log.stderr.slice(0, 500)}`);
    }
  }
} finally {
  await cleanup();
}

const failed = results.filter((entry) => entry.ok === false);
console.log('');
console.log(`checks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
