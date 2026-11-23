/**
 * One leg of the cross-machine WebRTC matrix.
 *
 * Two terminals, same flags except `--receive` / `--send`:
 *
 *   receiver: node scripts/webrtc-cross-machine.mjs --peer <id> --peer-key <base64> \
 *             --signal wss://.../w2m/webrtc --receive --work-dir <dir>
 *   sender:   node scripts/webrtc-cross-machine.mjs --peer <id> --peer-key <base64> \
 *             --signal wss://.../w2m/webrtc --send --work-dir <dir>
 *
 * The receiver starts first and retries `pool.prepare(peer)` until the sender joins. The sender
 * sends one Teams artifact through `TeamsDataPlane`; the receiver reassembles it, verifies SHA-256
 * and writes it through the configured dir sink. Both print one JSON result so a matrix runner can
 * attribute path, handshake time, RTT and attempts without parsing prose.
 *
 * `--expect-exhausted` is a deliberate negative leg: no receiver, short connect timeout, and the
 * sender must return TEAM_DATA_P2P_EXHAUSTED after exactly 33 attempts with an alert and no relay.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeviceKey } from '../src/agent/crypto.mjs';
import { WebRtcTransportPool } from '../src/agent/webrtc/pool.mjs';
import { TeamsDataPlane } from '../src/plugin/teams/data-plane.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const IS_WINDOWS = process.platform === 'win32';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

const PEER = arg('peer');
const PEER_KEY = arg('peer-key');
const SIGNAL = arg('signal');
const STATE = arg('state', join(homedir(), '.dsh', 'xclient'));
const WORK = resolve(arg('work-dir', join(REPO, '.matrix', `run-${Date.now().toString(36)}`)));
const OUT = arg('out');
const BYTES = Number(arg('bytes', '1048576'));
const RECEIVE = flag('receive');
const SEND = flag('send');
const EXPECT_EXHAUSTED = flag('expect-exhausted');
const DIAGNOSE = flag('diagnose');
const WAIT_MS = Number(arg('wait-ms', '180000'));
const PROVIDER_CWD = arg(
  'provider-cwd',
  process.env.W2M_WEBRTC_PROVIDER_CWD ??
    (IS_WINDOWS ? 'E:\\DB\\w2m-webrtc-provider' : join(homedir(), 'w2m-webrtc-provider')),
);
const PROVIDER_SCRIPT = arg('provider-script', join(REPO, 'src/agent/webrtc/providers/node-datachannel-provider.mjs'));
const ICE = (arg('ice', process.env.W2M_WEBRTC_ICE ?? 'stun:stun.l.google.com:19302') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function main() {
  if (PEER === null) throw new Error('--peer is required');
  if (SIGNAL === null) throw new Error('--signal is required');
  if (!RECEIVE && !SEND && !EXPECT_EXHAUSTED && !DIAGNOSE) {
    throw new Error('choose exactly one of --receive, --send, --expect-exhausted, --diagnose');
  }

  const startedAt = Date.now();
  const deviceFile = join(STATE, 'device.json');
  const keyFile = join(STATE, 'device.key');
  const identity = readJson(deviceFile);
  const key = DeviceKey.load({ file: keyFile, machineId: identity.machine_id }).key;
  let peerKey = PEER_KEY;

  if (peerKey === null) {
    const relayUrl = String(identity.rabbit_url ?? '').replace(/\/+$/, '');
    const token = identity.device_token ?? '';
    if (relayUrl === '' || token === '') throw new Error('--peer-key is required when device.json has no relay');
    const response = await fetch(`${relayUrl}/v1/peer/${encodeURIComponent(PEER)}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`relay peer lookup answered HTTP ${response.status}; pass --peer-key`);
    const body = await response.json();
    peerKey = body?.peer?.static_key ?? null;
    if (typeof peerKey !== 'string' || peerKey === '') throw new Error('relay peer record has no static_key; pass --peer-key');
  }

  mkdirSync(WORK, { recursive: true });
  const sinkRoot = join(WORK, 'sink');
  const sinkConfigDir = join(WORK, 'dataplane');
  mkdirSync(sinkConfigDir, { recursive: true });
  if (RECEIVE) {
    mkdirSync(sinkRoot, { recursive: true });
    writeFileSync(
      join(sinkConfigDir, 'sink.json'),
      JSON.stringify({ kind: 'dir', root: sinkRoot }) + '\n',
      'utf8',
    );
  }

  const timeouts = EXPECT_EXHAUSTED
    ? { connectTimeoutMs: 1_200, handshakeTimeoutMs: 1_200, peerTimeoutMs: 1_200, dataRetryDelayMs: 50 }
    : { connectTimeoutMs: 30_000, handshakeTimeoutMs: 30_000, peerTimeoutMs: 35_000, dataRetryDelayMs: 250 };

  const pool = new WebRtcTransportPool({
    machineId: identity.machine_id,
    signalUrl: SIGNAL,
    deviceKey: key,
    resolvePeerKey: async () => ({ key: peerKey, error: null, source: 'matrix-argument' }),
    providerCommand: process.execPath,
    providerArgs: [PROVIDER_SCRIPT],
    providerCwd: PROVIDER_CWD,
    iceServers: ICE.map((urls) => ({ urls })),
    preferP2p: true,
    allowRelay: true,
    connectTimeoutMs: timeouts.connectTimeoutMs,
    handshakeTimeoutMs: timeouts.handshakeTimeoutMs,
    peerTimeoutMs: timeouts.peerTimeoutMs,
    statsPollMs: 500,
  });

  const dataPlane = new TeamsDataPlane({
    pool,
    stateDir: WORK,
    dataRetryDelayMs: timeouts.dataRetryDelayMs,
  });

  const result = {
    ok: false,
    mode: EXPECT_EXHAUSTED ? 'expect-exhausted' : RECEIVE ? 'receiver' : DIAGNOSE ? 'diagnose' : 'sender',
    local: {
      machine_id: identity.machine_id,
      machine_name: identity.machine_name ?? null,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      signal: SIGNAL,
      provider_cwd: PROVIDER_CWD,
      work_dir: WORK,
      sink_root: RECEIVE ? sinkRoot : null,
    },
    peer: { machine_id: PEER, key_fingerprint: sha256(peerKey).slice(0, 16) },
    ice: ICE,
    timing: { started_at: new Date(startedAt).toISOString() },
  };

  let received = null;
  if (RECEIVE) {
    dataPlane.onEvent((event) => {
      if (event?.type === 'artifact-received' && received === null) {
        received = { ...event, pool_at_receive: pool.peerStatus(PEER) };
      }
      if (event?.type === 'artifact-not-delivered' && received === null) {
        received = { ...event, error: true, pool_at_receive: pool.peerStatus(PEER) };
      }
    });
  }

  if (DIAGNOSE) {
    const payload = Buffer.from('w2m matrix one-shot probe\n'.repeat(4), 'utf8');
    const sent = await pool.send(PEER, payload);
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      samples.push(pool.peerStatus(PEER));
      if (index < 2) await sleep(500);
    }
    result.elapsed_ms = Date.now() - startedAt;
    result.send = sent;
    result.pool_samples = samples;
    result.pool = samples.find((sample) => sample?.path === 'direct') ?? samples[samples.length - 1];
    result.path = result.pool?.path ?? null;
    result.rtt_ms = result.pool?.rtt_ms ?? null;
    result.secure = result.pool?.secure ?? null;
    result.ok = sent.ok === true;
  } else if (EXPECT_EXHAUSTED) {
    const payload = Buffer.from('w2m matrix exhaust probe\n'.repeat(32), 'utf8');
    const sent = await dataPlane.sendArtifact({
      peer: PEER,
      bytes: payload,
      taskId: 'matrix-exhaust',
      kind: 'artifact',
      name: 'exhaust.bin',
    });
    result.elapsed_ms = Date.now() - startedAt;
    result.send = sent;
    result.pool = pool.peerStatus(PEER);
    result.exhausted =
      sent.ok === false &&
      sent.code === 'TEAM_DATA_P2P_EXHAUSTED' &&
      sent.attempts === 33 &&
      sent.alert !== null &&
      sent.alert !== undefined &&
      sent.alert?.relay_used === undefined;
    result.ok = result.exhausted === true;
    result.code = sent.code ?? null;
    result.attempts = sent.attempts ?? null;
    result.alert = sent.alert ?? null;
  } else if (SEND) {
    const payload = Buffer.alloc(BYTES);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    const digest = sha256(payload);
    const sent = await dataPlane.sendArtifact({
      peer: PEER,
      bytes: payload,
      taskId: 'matrix-send',
      kind: 'artifact',
      name: 'matrix.bin',
    });
    result.elapsed_ms = Date.now() - startedAt;
    result.send = sent;
    result.expected_sha256 = digest;
    const samples = [];
    for (let index = 0; index < 4; index += 1) {
      samples.push(pool.peerStatus(PEER));
      if (index < 3) await sleep(500);
    }
    result.pool_samples = samples;
    result.pool = samples.find((sample) => sample?.path === 'direct') ?? samples[samples.length - 1];
    result.path = result.pool?.path ?? null;
    result.rtt_ms = result.pool?.rtt_ms ?? null;
    result.secure = result.pool?.secure ?? null;
    result.attempts = sent.attempts ?? null;
    result.ok = sent.ok === true && sent.sha256 === digest && sent.transport === 'webrtc-v1';
  } else {
    let lastPrepare = null;
    const deadline = Date.now() + WAIT_MS;
    while (received === null && Date.now() < deadline) {
      lastPrepare = await pool.prepare(PEER);
      if (lastPrepare.ok === true) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      } else {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
    }
    result.elapsed_ms = Date.now() - startedAt;
    result.prepare = lastPrepare;
    const samples = received?.pool_at_receive === undefined ? [] : [received.pool_at_receive];
    for (let index = 0; index < 3; index += 1) {
      samples.push(pool.peerStatus(PEER));
      if (index < 2) await sleep(500);
    }
    result.pool_samples = samples;
    result.pool = samples.find((sample) => sample?.path === 'direct') ?? samples[samples.length - 1] ?? null;
    result.path = result.pool?.path ?? null;
    result.rtt_ms = result.pool?.rtt_ms ?? null;
    result.secure = result.pool?.secure ?? null;
    if (received === null) {
      result.ok = false;
      result.code = 'MATRIX_ARTIFACT_TIMEOUT';
    } else if (received.error === true) {
      result.ok = false;
      result.code = 'MATRIX_ARTIFACT_NOT_DELIVERED';
      result.received = received;
    } else {
      const path = received.delivered?.ref?.sink?.rel_path ?? received.delivered?.ref?.rel_path ?? null;
      const file = path === null ? null : join(sinkRoot, path);
      let fileSha = null;
      let fileBytes = null;
      if (file !== null) {
        const buffer = readFileSync(file);
        fileSha = sha256(buffer);
        fileBytes = buffer.length;
      }
      result.received = received;
      result.sink = { root: sinkRoot, relative_path: path, bytes: fileBytes, sha256: fileSha };
      result.ok = fileSha !== null && fileSha === received.sha256;
    }
  }

  if (RECEIVE && received !== null) await sleep(2_000);

  result.finished_at = new Date().toISOString();
  result.peak_rss_bytes = process.memoryUsage().rss;

  try {
    dataPlane.close();
  } catch {
    /* already closed */
  }
  await pool.stop();

  const text = JSON.stringify(result, null, 2);
  if (OUT !== null) {
    mkdirSync(dirname(resolve(OUT)), { recursive: true });
    writeFileSync(resolve(OUT), text + '\n', 'utf8');
  }
  process.stdout.write(text + '\n');
  process.exitCode = result.ok ? 0 : 2;
}

main().catch(async (error) => {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        code: 'MATRIX_UNCAUGHT',
        detail: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = 2;
});
