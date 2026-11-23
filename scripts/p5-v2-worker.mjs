/**
 * One P5 P2P V2 node process.
 *
 * This is the cross-process/cross-machine harness for the 2-seed + 2-leecher row. Every role runs
 * its own WebTorrent client, its own `webrtc-v1` pool and its own `node-datachannel` provider
 * process; only the signal server and the keys file are shared. That is deliberately different
 * from `test/p2p-v2-live.mjs`, where two services share one process and a fake WebRTC network.
 *
 * Usage:
 *   node scripts/p5-v2-worker.mjs keygen --ids node-1,node-2 --out keys.json
 *   node scripts/p5-v2-worker.mjs seed --id node-1 --signal ws://... --keys keys.json \
 *     --file payload.bin --attach node-3,node-4 --out seed-1.json
 *   node scripts/p5-v2-worker.mjs leech --id node-3 --signal ws://... --keys keys.json \
 *     --magnet <magnet> --seeds node-1,node-2 --out leech-3.json
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeviceKey } from '../src/agent/crypto.mjs';
import { WebRtcTransportPool } from '../src/agent/webrtc/pool.mjs';
import { P2PV2Service } from '../src/agent/webtorrent/service.mjs';
import { loadWebTorrentModule } from '../src/agent/webtorrent/engine.mjs';
import { normalizePluginConfig } from '../src/plugin/p2p-v2-plugin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const IS_WINDOWS = process.platform === 'win32';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const MODE = process.argv[2] ?? '';
const ID = arg('id');
const IDS = (arg('ids', '') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const SIGNAL = arg('signal', 'ws://127.0.0.1:8788/w2m/webrtc');
const KEYS_FILE = arg('keys', join(tmpdir(), 'w2m-p5-keys.json'));
const OUT = arg('out');

const PROVIDER_CWD =
  arg('provider-cwd', process.env.W2M_WEBRTC_PROVIDER_CWD ?? '') ||
  (IS_WINDOWS ? 'E:\\DB\\w2m-webrtc-datachannel' : join(process.env.HOME ?? '', 'w2m-webrtc-provider'));
const PROVIDER_SCRIPT = join(REPO, 'src/agent/webrtc/providers/node-datachannel-provider.mjs');
const ICE = (arg('ice', process.env.W2M_WEBRTC_ICE ?? 'stun:stun.l.google.com:19302') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });

function writeOut(value) {
  const text = JSON.stringify(value, null, 2);
  if (OUT !== null) {
    const target = resolve(OUT);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, `${text}\n`, 'utf8');
    renameSync(tmp, target);
  }
  process.stdout.write(`${text}\n`);
}

function readKeys() {
  if (!existsSync(KEYS_FILE)) throw new Error(`keys file missing: ${KEYS_FILE}`);
  return JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
}

function loadKey(keys, machineId) {
  const entry = keys[machineId];
  if (entry === undefined) throw new Error(`keys file has no ${machineId}`);
  return DeviceKey.fromPrivate(Buffer.from(entry.private_key, 'base64'), machineId);
}

async function waitFor(predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms`);
}

async function makeService(machineId, keys, base, extraRoots = []) {
  const deviceKey = loadKey(keys, machineId);
  const pool = new WebRtcTransportPool({
    machineId,
    signalUrl: SIGNAL,
    deviceKey,
    resolvePeerKey: async (peer) => ({
      key: keys[peer]?.public_key ?? null,
      error: keys[peer] === undefined ? `no key for ${peer}` : null,
      source: 'p5-keys',
    }),
    providerCommand: process.execPath,
    providerArgs: [PROVIDER_SCRIPT],
    providerCwd: PROVIDER_CWD,
    iceServers: ICE.map((urls) => ({ urls })),
    preferP2p: true,
    allowRelay: true,
    connectTimeoutMs: 30_000,
    handshakeTimeoutMs: 30_000,
    peerTimeoutMs: 35_000,
    statsPollMs: 500,
  });
  const loaded = await loadWebTorrentModule({ modulePath: process.env.W2M_WEBTORRENT_MODULE ?? '' });
  if (loaded.ok !== true) throw new Error(JSON.stringify(loaded));
  const WebTorrent = loaded.WebTorrent;
  const cfg = normalizePluginConfig({
    stateDir: join(base, 'state'),
    downloadRoot: join(base, 'downloads'),
    allowedRoots: [base, ...extraRoots],
    max_file_bytes: 200 * 1024 * 1024,
    max_download_bytes: 200 * 1024 * 1024,
  });
  const service = new P2PV2Service(cfg, {
    getPool: () => pool,
    webTorrentFactory: () =>
      new WebTorrent({ tracker: false, dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false }),
  });
  return { service, pool };
}

async function main() {
  if (MODE === 'keygen') {
    const keys = {};
    for (const machineId of IDS) {
      const key = DeviceKey.generate(machineId);
      keys[machineId] = { private_key: key.privateKeyBase64, public_key: key.publicKeyBase64 };
    }
    mkdirSync(dirname(resolve(KEYS_FILE)), { recursive: true });
    writeFileSync(resolve(KEYS_FILE), `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    writeOut({ ok: true, keys: KEYS_FILE, ids: IDS });
    return;
  }

  if (MODE !== 'seed' && MODE !== 'leech') throw new Error(`unknown mode ${MODE}`);
  if (ID === null) throw new Error('--id is required');
  const keys = readKeys();
  const base = resolve(arg('work', join(tmpdir(), `w2m-p5-${ID}-${Date.now().toString(36)}`)));
  mkdirSync(base, { recursive: true });
  const file = MODE === 'seed' ? arg('file') : null;
  const extraRoots = file === null ? [] : [dirname(resolve(file))];
  const { service, pool } = await makeService(ID, keys, base, extraRoots);
  const result = {
    ok: false,
    mode: MODE,
    id: ID,
    platform: process.platform,
    node: process.version,
    signal: SIGNAL,
    provider_cwd: PROVIDER_CWD,
    work: base,
    started_at: new Date().toISOString(),
  };

  try {
    if (MODE === 'seed') {
      if (file === null) throw new Error('--file is required for seed');
      const shared = await service.share({ path: resolve(file), name: 'payload.bin' });
      if (shared.ok !== true) throw new Error(JSON.stringify(shared));
      const fileBytes = readFileSync(resolve(file));
      result.share = shared.share;
      result.expected_sha256 = sha256(fileBytes);
      result.expected_bytes = fileBytes.length;
      // Publish the magnet first: the leechers can only start after they have it.
      writeOut({ ...result, ok: true, phase: 'seeded' });
      const attach = (arg('attach', '') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      if (attach.length > 0) {
        const delayMs = Number(arg('attach-delay-ms', '5000'));
        if (delayMs > 0) await sleep(delayMs);
        const attached = [];
        for (const peer of attach) {
          attached.push({
            peer,
            result: await service.attach({ share_id: shared.share.share_id, machine_id: peer }),
          });
        }
        result.attached = attached;
      }
      writeOut({ ...result, ok: true, phase: 'attached' });
      const holdMs = Number(arg('hold-ms', '300000'));
      const deadline = Date.now() + holdMs;
      while (Date.now() < deadline && !existsSync(resolve(base, 'stop'))) {
        await sleep(250);
        const status = service.status();
        result.progress = status.shares[0]?.progress ?? 0;
        result.peers = status.shares[0]?.peers?.length ?? 0;
      }
      writeOut({ ...result, ok: true, phase: 'done' });
      return;
    }

    const magnet = arg('magnet');
    if (magnet === null) throw new Error('--magnet is required for leech');
    const seeds = (arg('seeds', '') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const startDelayMs = Number(arg('start-delay-ms', '0'));
    if (startDelayMs > 0) await sleep(startDelayMs);
    const dest = join(base, 'dest');
    mkdirSync(dest, { recursive: true });
    const added = await service.add({ magnet, path: dest, peers: seeds });
    if (added.ok !== true) throw new Error(JSON.stringify(added));
    result.magnet = magnet;
    result.seeds = seeds;
    result.expected_sha256 = arg('expected-sha256');
    const status = await waitFor(() => {
      const share = service.status().shares[0];
      return share?.done === true ? share : null;
    }, Number(arg('timeout-ms', '300000')));
    const destFile = join(dest, 'payload.bin');
    const bytes = readFileSync(destFile);
    result.bytes = bytes.length;
    result.sha256 = sha256(bytes);
    result.done = status.done;
    result.progress = status.progress;
    result.peers = status.peers;
    result.ok =
      result.expected_sha256 === null ||
      result.expected_sha256 === '' ||
      result.sha256 === result.expected_sha256;
    writeOut({ ...result, finished_at: new Date().toISOString() });
  } finally {
    await service.stopAll();
    await pool.stop();
  }
}

main().catch((error) => {
  writeOut({
    ok: false,
    mode: MODE,
    id: ID,
    code: 'P5_WORKER_FAILED',
    detail: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 2;
});
