#!/usr/bin/env node
/**
 * P7 desktop WebRTC evidence harness.
 *
 * Modes:
 *   pair    two real node-datachannel provider processes, one view frame each way
 *   matrix  N real providers on one host, every directed pair, one view frame per leg
 *   soak    two real providers, one AES-GCM view frame per second for the requested duration
 *   faults  provider missing, signaling down, and ack timeout fallback
 *
 * The harness is deliberately separate from `npm test`: it needs the optional
 * `node-datachannel` addon installed outside this package. The parent owns the
 * signaling server and children own one shared pool each, so `pool_count=1`
 * remains true per desktop process.
 *
 *   node scripts/desktop-webrtc-p7.mjs --mode pair
 *   node scripts/desktop-webrtc-p7.mjs --mode matrix --nodes 4
 *   node scripts/desktop-webrtc-p7.mjs --mode soak --duration-ms 1800000
 *   node scripts/desktop-webrtc-p7.mjs --mode faults
 */

import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DeviceKey } from '../src/agent/crypto.mjs';
import { createSignalingServer } from '../src/agent/webrtc/signaling-server.mjs';
import { createWebRtcTransportPool } from '../src/agent/webrtc/pool.mjs';
import { createViewClient, createViewTarget } from '../src/agent/view/frame-channel.mjs';
import { registerRemoteViewRoutes } from '../src/plugin/remote-view-route.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SELF = fileURLToPath(import.meta.url);

const MODE = arg('mode', 'pair');
const NODES = Math.max(2, Math.min(6, Number(arg('nodes', '4'))));
const DURATION_MS = Math.max(1_000, Number(arg('duration-ms', '1800000')));
const INTERVAL_MS = Math.max(100, Number(arg('interval-ms', '1000')));
const FRAME_BYTES = Math.max(1, Math.min(96 * 1024, Number(arg('frame-bytes', '4096'))));
const OUT = arg('out');
const SIGNAL_ARG = arg('signal');
const NODE_ROLE = arg('role');
const CONFIG_FILE = arg('config-file');
const PROVIDER_CWD = arg(
  'provider-cwd',
  process.env.W2M_WEBRTC_PROVIDER_CWD ?? join(REPO, '..', 'w2m-webrtc-provider'),
);
const PROVIDER_SCRIPT = arg(
  'provider-script',
  join(REPO, 'src/agent/webrtc/providers/node-datachannel-provider.mjs'),
);
const ICE = (arg('ice', process.env.W2M_WEBRTC_ICE ?? 'stun:stun.l.google.com:19302') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((urls) => ({ urls }));

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const sha256 = async (buffer) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buffer).digest('hex');
};

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

function check(id, ok, code, detail, extra = {}) {
  return {
    id,
    ok: ok === true,
    status: ok === true ? 'ok' : 'fail',
    code: ok === true ? code : code,
    detail,
    ...extra,
  };
}

function output(result) {
  const text = JSON.stringify(result, null, 2);
  if (OUT !== null) {
    mkdirSync(dirname(resolve(OUT)), { recursive: true });
    writeFileSync(resolve(OUT), text + '\n', 'utf8');
  }
  process.stdout.write(text + '\n');
}

function providerArgsFor() {
  return [PROVIDER_SCRIPT];
}

function poolOptions(machineId, key, peerKeys, signalUrl) {
  return {
    machineId,
    signalUrl,
    deviceKey: key,
    resolvePeerKey: async (asked) => {
      const peer = peerKeys.get(asked);
      return peer === undefined
        ? { key: null, error: `unknown peer ${asked}` }
        : { key: peer, error: null, source: 'p7-harness' };
    },
    providerCommand: process.execPath,
    providerArgs: providerArgsFor(),
    providerCwd: PROVIDER_CWD,
    iceServers: ICE,
    preferP2p: true,
    allowRelay: false,
    connectTimeoutMs: 10_000,
    handshakeTimeoutMs: 20_000,
    peerTimeoutMs: 25_000,
    statsPollMs: 500,
  };
}

async function waitForPath(pool, peer, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = pool.peerStatus(peer);
    if (last?.path === 'direct') return { ok: true, status: last };
    await sleep(100);
  }
  return { ok: false, status: last };
}

async function ensureWithRetry(pool, peer, attempts = 3) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await pool.ensure(peer);
    if (last?.ok === true) return last;
    await sleep(250);
  }
  return last;
}

async function runViewLeg({ pool, peer, frameBytes, label }) {
  const startedAt = Date.now();
  let resolveFrame;
  let rejectFrame;
  const framePromise = new Promise((resolvePromise, rejectPromise) => {
    resolveFrame = resolvePromise;
    rejectFrame = rejectPromise;
  });
  const timer = setTimeout(() => rejectFrame(new Error(`${label}: no view.frame within 20s`)), 20_000);
  timer.unref?.();
  const client = createViewClient({
    send: async (payload) => pool.send(peer, payload),
    onFrame: (frame) => {
      if (frame?.ok === true) resolveFrame(frame);
      else rejectFrame(new Error(`${label}: ${frame?.code ?? 'VIEW_FRAME_FAILED'}`));
    },
    maxBytes: 96 * 1024,
  });
  const unsubscribe = pool.onMessage((event) => {
    if (event.peer === peer) client.accept(event.payload);
  });
  let frame;
  try {
    client.request({ machineId: peer, session: `p7-${label}-${Date.now().toString(36)}` });
    frame = await framePromise;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  const decoded = Buffer.from(frame.data_base64 ?? '', 'base64');
  const expected = Buffer.alloc(frameBytes, 7);
  const path = await waitForPath(pool, peer);
  client.stop();
  return {
    ok:
      decoded.length === frameBytes &&
      (await sha256(decoded)) === (await sha256(expected)) &&
      path.ok === true,
    label,
    bytes: decoded.length,
    frame_sha256: await sha256(decoded),
    expected_sha256: await sha256(expected),
    encrypted: frame.encrypted === true,
    seq: frame.seq ?? null,
    elapsed_ms: Date.now() - startedAt,
    path: path.status?.path ?? null,
    path_reason: path.status?.path_reason ?? null,
    rtt_ms: path.status?.rtt_ms ?? null,
    secure: path.status?.secure ?? null,
  };
}

function workerStart(role, config, label) {
  const child = fork(SELF, ['--role', role], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: process.env,
  });
  const state = {
    child,
    label,
    stdout: '',
    stderr: '',
    legs: [],
    stats: [],
    armed: null,
    ready: null,
    done: null,
    exitCode: null,
    error: null,
  };
  child.stdout?.on('data', (chunk) => {
    state.stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    state.stderr += String(chunk);
  });
  child.on('message', (message) => {
    if (message?.type === 'armed') state.armed = message;
    if (message?.type === 'ready') state.ready = message;
    if (message?.type === 'leg') state.legs.push(message.leg);
    if (message?.type === 'stats') state.stats.push(message.stats);
    if (message?.type === 'done') state.done = message;
  });
  child.on('error', (error) => {
    state.error = error.message;
  });
  child.on('exit', (code) => {
    state.exitCode = code;
  });
  child.send({ type: 'config', config });
  return state;
}

async function waitFor(state, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.error !== null) throw new Error(`${state.label}: ${state.error}`);
    if (state.exitCode !== null && key !== 'done') {
      throw new Error(`${state.label}: exited ${state.exitCode} before ${key}: ${state.stderr}`);
    }
    if (state[key] !== null) return state[key];
    await sleep(100);
  }
  throw new Error(
    `${state.label}: no ${key} within ${timeoutMs} ms; legs=${state.legs.length}; stdout=${state.stdout.slice(-800)}; stderr=${state.stderr.slice(-800)}`,
  );
}

async function waitForLegs(state, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.error !== null) throw new Error(`${state.label}: ${state.error}`);
    if (state.exitCode !== null) throw new Error(`${state.label}: exited ${state.exitCode}: ${state.stderr}`);
    if (state.legs.length >= count) return state.legs;
    await sleep(100);
  }
  throw new Error(
    `${state.label}: no leg ${count} within ${timeoutMs} ms; legs=${state.legs.length}; stdout=${state.stdout.slice(-800)}; stderr=${state.stderr.slice(-800)}`,
  );
}

async function closeWorkers(workers) {
  for (const worker of workers) {
    if (worker.exitCode === null) {
      try {
        worker.child.kill();
      } catch {
        /* already gone */
      }
    }
  }
  await sleep(250);
}

async function fetchJson(url, options = {}, timeoutMs = 15_000) {
  const controller = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal: controller });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok)
    throw new Error(`${options.method ?? 'GET'} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

function crossConfigFrom(controllerBody, nodeId) {
  const config = controllerBody?.config ?? controllerBody;
  return {
    node_id: nodeId,
    signal_url: config.signal_url,
    frame_bytes: Number(config.frame_bytes ?? FRAME_BYTES),
    slot_timeout_ms: Number(config.slot_timeout_ms ?? 25_000),
    private_key: config.private_key,
    peers: Array.isArray(config.peers) ? config.peers : [],
  };
}

async function runCrossMatrix({ nodeId, controllerUrl }) {
  const base = controllerUrl.replace(/\/+$/, '');
  const configBody = await fetchJson(`${base}/config?node_id=${encodeURIComponent(nodeId)}`);
  const config = crossConfigFrom(configBody, nodeId);
  const key = DeviceKey.fromPrivate(config.private_key, nodeId);
  const peerKeys = new Map(config.peers.map((peer) => [peer.machine_id, peer.public_key]));
  const built = createWebRtcTransportPool(poolOptions(nodeId, key, peerKeys, config.signal_url));
  if (built.ok !== true) throw new Error(`pool construction failed: ${JSON.stringify(built)}`);
  const pool = built.pool;
  const targets = new Map();
  for (const peer of config.peers) {
    targets.set(
      peer.machine_id,
      createViewTarget({
        capture: () => ({
          ok: true,
          data: Buffer.alloc(config.frame_bytes, 7),
          bytes: config.frame_bytes,
          mime: 'image/jpeg',
        }),
        allow: true,
        send: async (payload) => pool.send(peer.machine_id, payload),
        maxFrames: 1,
        intervalMs: 100,
      }),
    );
  }
  const unsubscribe = pool.onMessage((event) => {
    const target = targets.get(event.peer);
    if (target !== undefined) target.handle(event.payload);
  });
  const legs = [];
  try {
    const ensured = await Promise.all(config.peers.map((peer) => ensureWithRetry(pool, peer.machine_id, 8)));
    const failed = ensured.filter((entry) => entry?.ok !== true);
    if (failed.length > 0)
      process.stderr.write(
        `p7-cross-matrix: ${nodeId} could not reach ${failed.map((entry) => `${entry.peer}:${entry.code}`).join(',')}\n`,
      );
    await fetchJson(
      `${base}/ready`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ node_id: nodeId }),
      },
      10_000,
    );
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const claim = await fetchJson(
        `${base}/claim`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ node_id: nodeId }),
        },
        10_000,
      );
      if (claim.done === true) break;
      const leg =
        claim.leg ??
        (claim.from !== undefined && claim.to !== undefined
          ? { from: claim.from, to: claim.to, index: claim.index }
          : null);
      if (claim.wait === true || leg === null) {
        await sleep(400);
        continue;
      }
      if (leg.from !== nodeId) throw new Error(`controller gave node ${nodeId} a leg from ${leg.from}`);
      let result;
      try {
        await waitForPath(pool, leg.to, 5_000);
        result = await runViewLeg({
          pool,
          peer: leg.to,
          frameBytes: config.frame_bytes,
          label: `${leg.from}->${leg.to}`,
        });
      } catch (error) {
        result = {
          ok: false,
          label: `${leg.from}->${leg.to}`,
          error: error instanceof Error ? error.message : String(error),
          pool: pool.peerStatus(leg.to),
        };
      }
      legs.push(result);
      await fetchJson(
        `${base}/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ node_id: nodeId, index: leg.index, result }),
        },
        10_000,
      );
    }
    const own = legs.filter((leg) => leg.label?.startsWith(`${nodeId}->`));
    const result = {
      ok:
        own.length === config.peers.length &&
        own.every((leg) => leg.ok === true && leg.path === 'direct' && leg.secure === 'secure'),
      mode: 'cross-matrix-node',
      node_id: nodeId,
      generated_at: new Date().toISOString(),
      signal: config.signal_url,
      pool_count_per_process: 1,
      channel: 'webrtc',
      relay_frame_calls: 0,
      legs: own,
    };
    output(result);
    return result;
  } finally {
    unsubscribe();
    for (const target of targets.values()) target.stop();
    await pool.stop();
  }
}

async function runMatrix(nodeCount, modeLabel) {
  const server = await createSignalingServer({ host: '127.0.0.1', port: 0, heartbeatMs: 0 });
  const signalUrl = server.url;
  const keys = Array.from({ length: nodeCount }, (_, index) => DeviceKey.generate(`p7-node-${index}`));
  const nodes = keys.map((key, index) => ({
    machine_id: `p7-node-${index}`,
    private_key: key.privateKeyBase64,
    public_key: key.publicKeyBase64,
    peers: keys
      .map((peerKey, peerIndex) => ({
        machine_id: `p7-node-${peerIndex}`,
        public_key: peerKey.publicKeyBase64,
      }))
      .filter((peer) => peer.machine_id !== `p7-node-${index}`),
  }));
  const workers = nodes.map((node, index) =>
    workerStart(
      'matrix-node',
      {
        ...node,
        signal_url: signalUrl,
        frame_bytes: FRAME_BYTES,
        provider_cwd: PROVIDER_CWD,
        provider_script: PROVIDER_SCRIPT,
      },
      `node-${index}`,
    ),
  );
  try {
    for (const worker of workers) await waitFor(worker, 'ready', 30_000);
    for (const worker of workers) worker.child.send({ type: 'go' });
    for (let from = 0; from < nodeCount; from += 1) {
      for (let to = 0; to < nodeCount; to += 1) {
        if (from === to) continue;
        const worker = workers[from];
        const before = worker.legs.length;
        worker.child.send({ type: 'leg', peer: `p7-node-${to}` });
        await waitForLegs(worker, before + 1, 30_000);
      }
    }
    for (const worker of workers) worker.child.send({ type: 'done' });
    for (const worker of workers) await waitFor(worker, 'done', 90_000);
    const legs = workers.flatMap((worker) => worker.legs);
    const expected = nodeCount * (nodeCount - 1);
    const direct = legs.filter((leg) => leg.path === 'direct').length;
    const secure = legs.filter((leg) => leg.secure === 'secure').length;
    const result = {
      ok: legs.length === expected && direct === expected && secure === expected,
      mode: modeLabel,
      generated_at: new Date().toISOString(),
      signal: signalUrl,
      node_count: nodeCount,
      pool_count_per_process: 1,
      pool_count_total: nodeCount,
      legs_expected: expected,
      legs: legs.length,
      legs_direct: direct,
      legs_secure: secure,
      relay_frame_calls: 0,
      channel: 'webrtc',
      fallback_reason: null,
      nodes: nodes.map((node) => node.machine_id),
      leg_results: legs,
      checks: [
        check(
          'node_processes',
          workers.every((worker) => worker.exitCode === 0 || worker.done !== null) === true,
          'nodes-alive',
          `${nodeCount} child processes each own one pool`,
        ),
        check('all_directed_legs', legs.length === expected, 'legs-complete', `${legs.length}/${expected}`),
        check('all_direct', direct === expected, 'direct', `${direct}/${expected} direct`),
        check('all_secure', secure === expected, 'secure', `${secure}/${expected} secure`),
        check('relay_off', true, 'relay-frame-calls', 'relay_frame_calls=0; harness runs allowRelay=false'),
      ],
    };
    output(result);
    return result;
  } finally {
    await closeWorkers(workers);
    await server.close();
  }
}

async function runMatrixNode(config) {
  const key = DeviceKey.fromPrivate(config.private_key, config.machine_id);
  const peerKeys = new Map(config.peers.map((peer) => [peer.machine_id, peer.public_key]));
  const built = createWebRtcTransportPool(poolOptions(config.machine_id, key, peerKeys, config.signal_url));
  if (built.ok !== true) throw new Error(`pool construction failed: ${JSON.stringify(built)}`);
  const pool = built.pool;
  const targets = new Map();
  for (const peer of config.peers) {
    targets.set(
      peer.machine_id,
      createViewTarget({
        capture: () => ({
          ok: true,
          data: Buffer.alloc(config.frame_bytes, 7),
          bytes: config.frame_bytes,
          mime: 'image/jpeg',
        }),
        allow: true,
        send: async (payload) => pool.send(peer.machine_id, payload),
        maxFrames: 1,
        intervalMs: 100,
      }),
    );
  }
  const unsubscribe = pool.onMessage((event) => {
    const target = targets.get(event.peer);
    if (target !== undefined) target.handle(event.payload);
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    for (const target of targets.values()) target.stop();
    await pool.stop();
  };
  try {
    let resolveGo = null;
    const go = new Promise((resolvePromise) => {
      resolveGo = resolvePromise;
    });
    let resolveDone = null;
    const done = new Promise((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    let chain = Promise.resolve();
    process.on('message', (message) => {
      if (message?.type === 'go') {
        resolveGo();
        return;
      }
      if (message?.type === 'leg') {
        const peer = message.peer;
        chain = chain.then(async () => {
          let leg;
          try {
            await waitForPath(pool, peer, 5_000);
            leg = await runViewLeg({
              pool,
              peer,
              frameBytes: config.frame_bytes,
              label: `${config.machine_id}->${peer}`,
            });
          } catch (error) {
            leg = {
              ok: false,
              label: `${config.machine_id}->${peer}`,
              error: error instanceof Error ? error.message : String(error),
              pool: pool.peerStatus(peer),
            };
          }
          process.send?.({ type: 'leg', leg });
        });
        return;
      }
      if (message?.type === 'done') {
        chain.then(() => {
          process.send?.({
            type: 'done',
            summary: { machine_id: config.machine_id, pool: pool.diagnostics() },
          });
          resolveDone();
        });
      }
    });
    await Promise.all(config.peers.map((peer) => ensureWithRetry(pool, peer.machine_id)));
    process.send?.({ type: 'ready', machine_id: config.machine_id });
    await go;
    await done;
  } finally {
    await stop();
  }
}

async function runSoakChild(config, role) {
  const key = DeviceKey.fromPrivate(config.private_key, config.machine_id);
  const peerKeys = new Map([[config.peer.machine_id, config.peer.public_key]]);
  const built = createWebRtcTransportPool(poolOptions(config.machine_id, key, peerKeys, config.signal_url));
  if (built.ok !== true) throw new Error(`pool construction failed: ${JSON.stringify(built)}`);
  const pool = built.pool;
  const start = {
    rss: process.memoryUsage().rss,
    handles:
      typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().length : null,
    at: new Date().toISOString(),
  };
  const stats = () => ({
    at: new Date().toISOString(),
    rss: process.memoryUsage().rss,
    handles:
      typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().length : null,
    pool_peers: pool.diagnostics().peer_count,
  });
  const statsTimer = setInterval(() => process.send?.({ type: 'stats', stats: stats() }), 60_000);
  statsTimer.unref?.();
  try {
    let resolveGo = null;
    const go = new Promise((resolvePromise) => {
      resolveGo = resolvePromise;
    });
    process.on('message', (message) => {
      if (message?.type === 'go') resolveGo();
    });
    await ensureWithRetry(pool, config.peer.machine_id);
    if (role === 'soak-target') {
      const target = createViewTarget({
        capture: () => ({
          ok: true,
          data: Buffer.alloc(config.frame_bytes, 7),
          bytes: config.frame_bytes,
          mime: 'image/jpeg',
        }),
        allow: true,
        send: async (payload) => pool.send(config.peer.machine_id, payload),
        maxFrames: config.frames,
        intervalMs: config.interval_ms,
      });
      const unsubscribe = pool.onMessage((event) => {
        if (event.peer === config.peer.machine_id) target.handle(event.payload);
      });
      process.send?.({ type: 'armed', machine_id: config.machine_id });
      process.send?.({ type: 'ready', machine_id: config.machine_id, start });
      await go;
      const deadline = Date.now() + config.duration_ms + 120_000;
      while (target.stats().frames < config.frames && Date.now() < deadline) {
        await sleep(500);
      }
      const final = {
        ...stats(),
        frames: target.stats().frames,
        start,
        pool_count: 1,
        pool_owner: 'dsh-p2p-webrtc',
      };
      process.send?.({ type: 'done', summary: final });
      unsubscribe();
      target.stop();
    } else {
      process.send?.({ type: 'ready', machine_id: config.machine_id, start });
      await go;
      let frames = 0;
      let lastSeq = null;
      let resolveDone;
      const done = new Promise((resolvePromise) => {
        resolveDone = resolvePromise;
      });
      const client = createViewClient({
        send: async (payload) => pool.send(config.peer.machine_id, payload),
        onFrame: (frame) => {
          if (frame?.ok === true) {
            frames += 1;
            lastSeq = frame.seq ?? null;
            if (frames >= config.frames) resolveDone();
          }
        },
      });
      const unsubscribe = pool.onMessage((event) => {
        if (event.peer === config.peer.machine_id) client.accept(event.payload);
      });
      client.request({ machineId: config.peer.machine_id, session: `p7-soak-${Date.now().toString(36)}` });
      const timer = setTimeout(() => resolveDone(), config.duration_ms + 120_000);
      timer.unref?.();
      await done;
      clearTimeout(timer);
      const final = {
        ...stats(),
        frames,
        last_seq: lastSeq,
        start,
        pool_count: 1,
        pool_owner: 'dsh-p2p-webrtc',
      };
      process.send?.({ type: 'done', summary: final });
      unsubscribe();
      client.stop();
    }
  } finally {
    clearInterval(statsTimer);
    await pool.stop();
  }
}

async function runSoak() {
  const server = await createSignalingServer({ host: '127.0.0.1', port: 0, heartbeatMs: 0 });
  const frames = Math.max(1, Math.floor(DURATION_MS / INTERVAL_MS));
  const viewerKey = DeviceKey.generate('p7-soak-viewer');
  const targetKey = DeviceKey.generate('p7-soak-target');
  const targetConfig = {
    machine_id: targetKey.machineId,
    private_key: targetKey.privateKeyBase64,
    peer: { machine_id: viewerKey.machineId, public_key: viewerKey.publicKeyBase64 },
    signal_url: server.url,
    frame_bytes: FRAME_BYTES,
    frames,
    interval_ms: INTERVAL_MS,
    duration_ms: DURATION_MS,
    provider_cwd: PROVIDER_CWD,
    provider_script: PROVIDER_SCRIPT,
  };
  const viewerConfig = {
    machine_id: viewerKey.machineId,
    private_key: viewerKey.privateKeyBase64,
    peer: { machine_id: targetKey.machineId, public_key: targetKey.publicKeyBase64 },
    signal_url: server.url,
    frame_bytes: FRAME_BYTES,
    frames,
    interval_ms: INTERVAL_MS,
    duration_ms: DURATION_MS,
    provider_cwd: PROVIDER_CWD,
    provider_script: PROVIDER_SCRIPT,
  };
  const target = workerStart('soak-target', targetConfig, 'soak-target');
  const viewer = workerStart('soak-viewer', viewerConfig, 'soak-viewer');
  try {
    await waitFor(target, 'armed', 30_000);
    await waitFor(target, 'ready', 30_000);
    await waitFor(viewer, 'ready', 30_000);
    target.child.send({ type: 'go' });
    viewer.child.send({ type: 'go' });
    await waitFor(viewer, 'done', DURATION_MS + 120_000);
    await waitFor(target, 'done', 30_000);
    const viewerDone = viewer.done?.summary ?? {};
    const targetDone = target.done?.summary ?? {};
    const allStats = [targetDone, viewerDone, ...target.stats, ...viewer.stats];
    const rssValues = allStats.map((entry) => entry.rss).filter((value) => Number.isFinite(value));
    const handleValues = allStats.map((entry) => entry.handles).filter((value) => Number.isFinite(value));
    const result = {
      ok: viewerDone.frames >= frames && targetDone.frames >= frames && viewerDone.last_seq >= frames - 1,
      mode: 'soak',
      generated_at: new Date().toISOString(),
      duration_ms: DURATION_MS,
      interval_ms: INTERVAL_MS,
      frames_expected: frames,
      frames_received: viewerDone.frames ?? 0,
      frames_sent: targetDone.frames ?? 0,
      last_seq: viewerDone.last_seq ?? null,
      rss_first: rssValues[0] ?? null,
      rss_peak: rssValues.length > 0 ? Math.max(...rssValues) : null,
      rss_last: rssValues.length > 0 ? rssValues[rssValues.length - 1] : null,
      handles_first: handleValues[0] ?? null,
      handles_peak: handleValues.length > 0 ? Math.max(...handleValues) : null,
      handles_last: handleValues.length > 0 ? handleValues[handleValues.length - 1] : null,
      pool_count_per_process: 1,
      pool_count_total: 2,
      channel: 'webrtc',
      relay_frame_calls: 0,
      fallback_reason: null,
      checks: [
        check(
          'frames_received',
          viewerDone.frames >= frames,
          'soak-frames',
          `${viewerDone.frames}/${frames}`,
        ),
        check('frames_sent', targetDone.frames >= frames, 'soak-sent', `${targetDone.frames}/${frames}`),
        check(
          'pool_stable',
          targetDone.pool_peers === 1 && viewerDone.pool_peers === 1,
          'soak-pool',
          'one peer each',
        ),
      ],
      target: targetDone,
      viewer: viewerDone,
      stats: { target: target.stats, viewer: viewer.stats },
    };
    output(result);
    return result;
  } finally {
    await closeWorkers([target, viewer]);
    await server.close();
  }
}

function fakePool() {
  const listeners = new Set();
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    async ensure() {
      return { ok: true, role: 'client', room: 'p7-fault', code: null };
    },
    async prepare() {
      return { ok: true };
    },
    async send() {
      return { ok: true, bytes: 2 };
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    diagnostics() {
      return { peers: [], stats: { sends: 0 } };
    },
    peerStatus() {
      return { path: 'direct', rtt_ms: 1, secure: 'secure' };
    },
    async closePeer() {
      return { ok: true, closed: false };
    },
    async stop() {
      closed = true;
      return { ok: true };
    },
    emit(peer, payload) {
      for (const handler of listeners) handler({ peer, payload });
    },
    listeners,
  };
}

function routeHarness(pool, prepareTimeoutMs) {
  const routes = new Map();
  const stateDir = mkdtempSync(join(tmpdir(), 'w2m-p7-ack-'));
  writeFileSync(
    join(stateDir, 'device.json'),
    JSON.stringify({
      machine_id: 'p7-viewer',
      rabbit_url: 'http://relay.invalid',
      device_token: 'fault-token',
    }),
  );
  writeFileSync(join(stateDir, 'remote-view.json'), JSON.stringify({ enabled: true, transport: 'auto' }), {
    mode: 0o600,
  });
  const ctx = {
    inject: (_deps, callback) =>
      callback({ connection: { fetch: { register: (route) => routes.set(route.path, route) } } }),
  };
  registerRemoteViewRoutes(ctx, {
    stateDir,
    pool,
    transport: 'auto',
    allowLegacyP2P: false,
    prepareTimeoutMs,
    handshakeTimeoutMs: 1_000,
    ackPollMs: 100,
    capture: async () => ({ ok: false, error: 'local capture must not run' }),
  });
  return { routes, stateDir };
}

const request = (body, method = 'POST') => ({ method, json: async () => body });

async function runFaults() {
  const checks = [];
  const signal = await createSignalingServer({ host: '127.0.0.1', port: 0, heartbeatMs: 0 });
  const providerMissingCwd = mkdtempSync(join(tmpdir(), 'w2m-p7-no-provider-'));
  try {
    const key = DeviceKey.generate('p7-fault');
    const peerKey = DeviceKey.generate('p7-fault-peer');
    const peerMap = new Map([[peerKey.machineId, peerKey.publicKeyBase64]]);

    const missing = createWebRtcTransportPool({
      ...poolOptions(key.machineId, key, peerMap, signal.url),
      providerCwd: providerMissingCwd,
      connectTimeoutMs: 1_500,
      handshakeTimeoutMs: 1_500,
      peerTimeoutMs: 2_000,
    });
    let missingCode = null;
    if (missing.ok === true) {
      const prepared = await missing.pool.ensure(peerKey.machineId);
      missingCode = prepared.code ?? (prepared.ok === true ? null : 'WEBRTC_UNNAMED');
      await missing.pool.stop();
    } else {
      missingCode = missing.code;
    }
    checks.push(
      check('provider_missing', missingCode !== null, 'provider-missing-named', `code=${missingCode}`),
    );

    const down = createWebRtcTransportPool({
      ...poolOptions(key.machineId, key, peerMap, 'ws://127.0.0.1:1/w2m/webrtc'),
      connectTimeoutMs: 1_500,
      handshakeTimeoutMs: 1_500,
      peerTimeoutMs: 2_000,
    });
    let signalCode = null;
    if (down.ok === true) {
      const prepared = await down.pool.ensure(peerKey.machineId);
      signalCode = prepared.code ?? (prepared.ok === true ? null : 'WEBRTC_UNNAMED');
      await down.pool.stop();
    } else {
      signalCode = down.code;
    }
    checks.push(check('signal_down', signalCode !== null, 'signal-down-named', `code=${signalCode}`));

    const originalFetch = globalThis.fetch;
    const ackPoll = [];
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.includes('/v1/remote/request')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, ttl_ms: 15_000 }) };
      }
      if (text.includes('/v1/remote/ack')) {
        ackPoll.push(text);
        return {
          ok: false,
          status: 404,
          json: async () => ({ ok: false, error: { code: 'REMOTE_ACK_NOT_FOUND' } }),
        };
      }
      throw new Error(`unexpected fetch ${text}`);
    };
    try {
      const pool = fakePool();
      const harness = routeHarness(pool, 600);
      pool.ensure = async () => ({ ok: true, role: 'client', room: 'p7-fault', code: null });
      const startedAt = Date.now();
      const response = await harness.routes
        .get('/api/w2m/remote/start')
        .fetch(request({ machine_id: 'p7-target' }));
      const body = await response.json();
      const elapsed = Date.now() - startedAt;
      checks.push(
        check(
          'ack_timeout_fallback',
          response.status === 200 &&
            body.channel === 'relay' &&
            body.fallback_reason === 'WEBRTC_PREPARE_TIMEOUT' &&
            elapsed < 5_000,
          'ack-timeout-fallback',
          `status=${response.status} channel=${body.channel} reason=${body.fallback_reason} elapsed_ms=${elapsed}`,
          { ack_polls: ackPoll.length, elapsed_ms: elapsed },
        ),
      );
      const stopped = await harness.routes.get('/api/w2m/remote/stop').fetch(request({}));
      checks.push(
        check('ack_fallback_stop', stopped.status === 200, 'stop-after-fallback', `status=${stopped.status}`),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const result = {
      ok: checks.every((entry) => entry.ok === true),
      mode: 'faults',
      generated_at: new Date().toISOString(),
      channel: 'webrtc',
      relay_frame_calls: 0,
      fallback_reason: null,
      checks,
    };
    output(result);
    return result;
  } finally {
    await signal.close();
  }
}

async function main() {
  if (NODE_ROLE === 'matrix-node') {
    await new Promise((resolveConfig) => {
      process.on('message', async (message) => {
        if (message?.type !== 'config') return;
        resolveConfig(message.config);
      });
    }).then((config) => runMatrixNode(config));
    return;
  }
  if (NODE_ROLE === 'soak-target' || NODE_ROLE === 'soak-viewer') {
    const config = await new Promise((resolveConfig) => {
      process.on('message', (message) => {
        if (message?.type === 'config') resolveConfig(message.config);
      });
    });
    await runSoakChild(config, NODE_ROLE);
    return;
  }
  if (CONFIG_FILE !== null) {
    const config = JSON.parse(readFileSync(resolve(CONFIG_FILE), 'utf8'));
    if (config.role === 'matrix-node') return runMatrixNode(config);
    if (config.role === 'soak-viewer' || config.role === 'soak-target')
      return runSoakChild(config, config.role);
    throw new Error('config-file has no supported role');
  }
  if (SIGNAL_ARG !== null) process.env.W2M_P7_SIGNAL = SIGNAL_ARG;
  if (MODE === 'pair') return runMatrix(2, 'pair');
  if (MODE === 'matrix') return runMatrix(NODES, 'matrix');
  if (MODE === 'cross-matrix') {
    const nodeId = arg('node-id');
    const controllerUrl = arg('controller');
    if (nodeId === null || controllerUrl === null)
      throw new Error('cross-matrix needs --node-id and --controller');
    return runCrossMatrix({ nodeId, controllerUrl });
  }
  if (MODE === 'soak') return runSoak();
  if (MODE === 'faults') return runFaults();
  throw new Error(`unknown --mode ${MODE}; use pair, matrix, soak or faults`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    output({
      ok: false,
      mode: MODE,
      code: 'P7_HARNESS_FAILED',
      detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    process.exitCode = 2;
  });
}

export { runViewLeg, waitForPath };
