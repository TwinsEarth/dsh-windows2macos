#!/usr/bin/env node
/**
 * P6 production readiness for the desktop WebRTC default path.
 *
 * This is a **read-only** diagnostic. It never builds a pool, spawns a provider, starts a remote
 * view, writes `remote-view.json`, or mints a device key. The one network side effect is a
 * short-lived signaling join that is closed immediately after `joined`; the one process side effect
 * is loading `node-datachannel` from `providerCwd` to prove the addon resolves.
 *
 * Pool state is process-local (P5 diagnostics), so an out-of-process script cannot inspect it by
 * importing the registry. Pass a diagnostics snapshot from the live host (`--diagnostics-json`) or
 * an authenticated diagnostics URL (`--diagnostics-url`). Without either, the pool check is a
 * named block rather than a guessed green.
 *
 * Usage:
 *   node bin/w2m-desktop-readiness.mjs \
 *     --state ~/.dsh/xclient \
 *     --signal wss://signal.example.com/w2m/webrtc \
 *     --provider-cwd ~/.w2m/webrtc-provider \
 *     --peer machine-b \
 *     --diagnostics-json ./remote-diagnostics.json \
 *     [--expect-transport webrtc] [--skip-network] [--skip-pool] [--skip-peer] [--skip-ack]
 *
 * Exit codes: 0 = ready (possibly with warnings), 2 = blocked.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DeviceKey } from '../src/agent/crypto.mjs';
import { buildSignalingUrl, redactSignalingUrl } from '../src/agent/webrtc/signaling.mjs';
import { resolveStateDir } from '../src/util/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MAIN = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;

export const READINESS_CODE = Object.freeze({
  NODE_VERSION: 'READINESS_NODE_VERSION',
  IDENTITY: 'READINESS_IDENTITY',
  DEVICE_KEY: 'READINESS_DEVICE_KEY',
  REMOTE_CONFIG: 'READINESS_REMOTE_CONFIG',
  PROVIDER: 'READINESS_PROVIDER',
  SIGNAL: 'READINESS_SIGNAL',
  POOL: 'READINESS_POOL',
  PEER: 'READINESS_PEER',
  ACK: 'READINESS_ACK',
  RELAY: 'READINESS_RELAY',
});

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const equal = process.argv.find((value) => value.startsWith(prefix));
  if (equal !== undefined) return equal.slice(prefix.length);
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

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function redactUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = '';
      parsed.password = '';
    }
    for (const key of ['token', 'device_token', 'access_token']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

/**
 * @param {string} id
 * @param {'ok'|'warn'|'fail'} status
 * @param {string|null} code
 * @param {string} detail
 * @param {object} extra
 */
function check(id, status, code, detail, extra = {}) {
  return { id, status, ok: status === 'ok', code, detail, ...extra };
}

export function signalHealthUrl(signal) {
  if (typeof signal !== 'string' || signal === '') return null;
  let parsed;
  try { parsed = new URL(signal); } catch { return null; }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/health';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function checkStaticKey(value) {
  if (typeof value !== 'string' || value === '') {
    return { ok: false, code: 'WEBRTC_STATIC_KEY_MISSING', detail: 'no static_key' };
  }
  let raw;
  try {
    raw = Buffer.from(value, 'base64');
  } catch {
    return { ok: false, code: 'WEBRTC_STATIC_KEY_INVALID', detail: 'static_key is not base64' };
  }
  if (raw.length !== 32) {
    return { ok: false, code: 'WEBRTC_STATIC_KEY_INVALID', detail: 'static_key is not 32 bytes' };
  }
  return { ok: true, code: null, detail: '32-byte X25519 static key' };
}

export function checkRemoteConfig(file, expectedTransport = 'webrtc') {
  if (!existsSync(file)) {
    return check('remote_config', 'warn', 'REMOTE_CONFIG_ABSENT',
      'remote-view.json is absent; the dsh-desktop row default applies. Verify /api/w2m/remote/config.transport_source.',
      { path: file });
  }
  let parsed;
  try {
    parsed = readJson(file);
  } catch (error) {
    return check('remote_config', 'fail', 'REMOTE_CONFIG_INVALID',
      `remote-view.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { path: file, required: true });
  }
  if (parsed?.transport !== expectedTransport) {
    return check('remote_config', 'fail', 'REMOTE_CONFIG_TRANSPORT_MISMATCH',
      `transport=${JSON.stringify(parsed?.transport ?? null)}, expected ${JSON.stringify(expectedTransport)}`,
      { path: file, transport: parsed?.transport ?? null, expected: expectedTransport, required: true });
  }
  if (parsed?.enabled !== true) {
    return check('remote_config', 'warn', 'REMOTE_VIEW_DISABLED',
      `transport=${expectedTransport}, but enabled=false; the panel will refuse /start`,
      { path: file, transport: parsed.transport, enabled: false });
  }
  return check('remote_config', 'ok', 'REMOTE_CONFIG_WEBRTC',
    `transport=${expectedTransport}, enabled=true`, { path: file, transport: expectedTransport });
}

export function checkPoolSnapshot(body, expectedOwner = 'dsh-p2p-webrtc') {
  if (body === null || typeof body !== 'object' || body.ok !== true) {
    return check('pool', 'fail', 'POOL_DIAGNOSTICS_BAD',
      'diagnostics did not return ok=true', { required: true });
  }
  if (body.pool_available !== true) {
    return check('pool', 'fail', 'POOL_NOT_READY',
      'pool_available=false; the shared pool has not been published or is not ready',
      { required: true });
  }
  if (body.pool_owner !== expectedOwner) {
    return check('pool', 'fail', 'POOL_OWNER_MISMATCH',
      `pool_owner=${JSON.stringify(body.pool_owner ?? null)}, expected ${JSON.stringify(expectedOwner)}`,
      { required: true, owner: body.pool_owner ?? null, expected: expectedOwner });
  }
  if (body.pool?.ready === false) {
    return check('pool', 'fail', 'POOL_NOT_READY', 'pool.ready=false', { required: true });
  }
  return check('pool', 'ok', 'POOL_READY',
    `owner=${expectedOwner}, peer_count=${body.pool?.peer_count ?? 0}`,
    {
      owner: expectedOwner,
      machine_id: body.pool?.machine_id ?? null,
      peer_count: body.pool?.peer_count ?? 0,
    });
}

export function checkAckResponse(status, body) {
  const code = body?.error?.code ?? body?.code ?? null;
  if (status === 401 || status === 403) {
    return check('relay_ack', 'fail', 'REMOTE_ACK_FORBIDDEN',
      `HTTP ${status}: relay token rejected or ack read forbidden`, { required: true });
  }
  if (status === 404 && code === 'REMOTE_ACK_NOT_FOUND') {
    return check('relay_ack', 'ok', 'REMOTE_ACK_ROUTE_PRESENT',
      'GET /v1/remote/ack answered REMOTE_ACK_NOT_FOUND (route present, no live ack)');
  }
  if (status === 404) {
    return check('relay_ack', 'fail', 'REMOTE_ACK_ROUTE_MISSING',
      `HTTP 404 with code=${JSON.stringify(code)}; relay build has no /v1/remote/ack route`,
      { required: true });
  }
  if (status === 200) {
    return check('relay_ack', 'warn', 'REMOTE_ACK_UNEXPECTED',
      'a random session id returned an ack; inspect broker before trusting readiness');
  }
  return check('relay_ack', 'fail', 'REMOTE_ACK_BAD',
    `HTTP ${status}, code=${JSON.stringify(code)}`, { required: true });
}

export function checkProvider(providerCwd, providerScript) {
  const out = [];
  if (!existsSync(providerCwd)) {
    return [check('provider_cwd', 'fail', 'PROVIDER_CWD_MISSING', `providerCwd not found: ${providerCwd}`, { required: true })];
  }
  if (!statSync(providerCwd).isDirectory()) {
    return [check('provider_cwd', 'fail', 'PROVIDER_CWD_NOT_DIR', `providerCwd is not a directory: ${providerCwd}`, { required: true })];
  }
  out.push(check('provider_cwd', 'ok', 'PROVIDER_CWD_READY', providerCwd));
  if (!existsSync(providerScript)) {
    out.push(check('provider_script', 'fail', 'PROVIDER_SCRIPT_MISSING', `provider script not found: ${providerScript}`, { required: true }));
  } else {
    out.push(check('provider_script', 'ok', 'PROVIDER_SCRIPT_READY', providerScript));
  }
  const packageFile = join(providerCwd, 'package.json');
  if (!existsSync(packageFile)) {
    out.push(check('provider_package', 'fail', 'PROVIDER_PACKAGE_MISSING', `package.json not found in ${providerCwd}`, { required: true }));
  }
  const moduleDir = join(providerCwd, 'node_modules', 'node-datachannel');
  if (!existsSync(moduleDir)) {
    out.push(check('provider_module', 'fail', 'PROVIDER_MODULE_MISSING',
      'node_modules/node-datachannel not found; run npm install in providerCwd (the package never does it)',
      { required: true }));
  } else {
    try {
      const req = createRequire(existsSync(packageFile) ? packageFile : join(providerCwd, 'package.json'));
      const mod = req('node-datachannel');
      const hasPeer = typeof mod?.PeerConnection === 'function';
      const version = mod?.version ?? null;
      out.push(hasPeer
        ? check('provider_module', 'ok', 'PROVIDER_MODULE_READY', `node-datachannel loaded${version ? ` (${version})` : ''}`)
        : check('provider_module', 'fail', 'PROVIDER_MODULE_INVALID',
          'node-datachannel loaded but has no PeerConnection', { required: true }));
    } catch (error) {
      out.push(check('provider_module', 'fail', 'PROVIDER_MODULE_INVALID',
        `node-datachannel load failed: ${error instanceof Error ? error.message : String(error)}`,
        { required: true }));
    }
  }
  return out;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(8_000),
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

async function probeSignaling(signal, token) {
  if (typeof globalThis.WebSocket !== 'function') {
    return { ok: false, code: 'SIGNAL_WEBSOCKET_UNAVAILABLE', detail: 'no global WebSocket (Node 22+ recommended)' };
  }
  const probe = buildSignalingUrl(signal, {
    room: `readiness-${process.pid}-${Date.now()}`,
    role: 'host',
    peerId: `readiness-${process.pid}`,
    token,
  });
  if (probe.ok !== true) return { ok: false, code: probe.code, detail: probe.detail };
  return new Promise((resolvePromise) => {
    let settled = false;
    let socket = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* already closed */ }
      resolvePromise(outcome);
    };
    const timer = setTimeout(() => finish({
      ok: false,
      code: 'SIGNAL_WEBSOCKET_TIMEOUT',
      detail: 'no joined confirmation within 8s',
    }), 8_000);
    timer.unref?.();
    try {
      socket = new globalThis.WebSocket(probe.url);
    } catch (error) {
      finish({ ok: false, code: 'SIGNAL_WEBSOCKET_FAILED', detail: `open failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    socket.addEventListener('error', () => finish({ ok: false, code: 'SIGNAL_WEBSOCKET_FAILED', detail: 'WebSocket error before joined' }));
    socket.addEventListener('close', () => finish({ ok: false, code: 'SIGNAL_WEBSOCKET_CLOSED', detail: 'WebSocket closed before joined' }));
    socket.addEventListener('open', () => {
      try {
        const parsed = new URL(probe.url);
        socket.send(JSON.stringify({
          type: 'join',
          room: parsed.searchParams.get('room'),
          role: 'host',
          peer: `readiness-${process.pid}`,
          protocol: 'w2m-webrtc/1',
        }));
      } catch (error) {
        finish({ ok: false, code: 'SIGNAL_WEBSOCKET_JOIN_FAILED', detail: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message?.type === 'joined') {
        finish({ ok: true, code: 'SIGNAL_JOINED', detail: 'joined a short-lived readiness room' });
      }
      if (message?.type === 'error') {
        finish({ ok: false, code: 'SIGNAL_SERVER_ERROR', detail: `server error: ${message.code ?? 'UNKNOWN'}` });
      }
    });
  });
}

async function diagnosticsSnapshot(url, cookie) {
  const headers = cookie === '' ? {} : { cookie };
  const result = await fetchJson(url, headers);
  if (result.status !== 200) {
    throw Object.assign(new Error(`HTTP ${result.status}`), { body: result.body });
  }
  return result.body;
}

async function main() {
  const stateDir = resolve(arg('state') ?? resolveStateDir(null, ''));
  const signal = arg('signal');
  const signalTokenEnv = arg('signal-token-env', 'W2M_WEBRTC_SIGNAL_TOKEN');
  const signalToken = arg('signal-token') ?? process.env[signalTokenEnv] ?? '';
  const providerCwd = arg('provider-cwd', process.env.W2M_WEBRTC_PROVIDER_CWD ?? join(homedir(), '.w2m', 'webrtc-provider'));
  const providerScript = arg('provider-script', join(REPO, 'src/agent/webrtc/providers/node-datachannel-provider.mjs'));
  const peer = arg('peer');
  const peerKey = arg('peer-key');
  const relayOverride = arg('relay');
  const diagnosticsJson = arg('diagnostics-json');
  const diagnosticsUrl = arg('diagnostics-url');
  const diagnosticsCookieEnv = arg('diagnostics-cookie-env', 'W2M_DIAGNOSTICS_COOKIE');
  const diagnosticsCookie = process.env[diagnosticsCookieEnv] ?? '';
  const expectTransport = arg('expect-transport', 'webrtc');
  const healthOverride = arg('health-url');
  const out = arg('out');
  const skipNetwork = flag('skip-network');
  const skipPool = flag('skip-pool');
  const skipPeer = flag('skip-peer');
  const skipAck = flag('skip-ack');

  const checks = [];
  const startedAt = new Date().toISOString();
  const nodeVersion = process.version;
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
  checks.push(major >= 20
    ? check('node_version', 'ok', 'NODE_VERSION_OK', `${nodeVersion} (Node 20.19+ required)`)
    : check('node_version', 'fail', READINESS_CODE.NODE_VERSION, `${nodeVersion}; Node 20.19+ required`, { required: true }));

  let device = null;
  const deviceFile = join(stateDir, 'device.json');
  if (!existsSync(deviceFile)) {
    checks.push(check('identity', 'fail', READINESS_CODE.IDENTITY, `device.json missing at ${deviceFile}`, { required: true }));
  } else {
    try {
      device = readJson(deviceFile);
      if (typeof device?.machine_id !== 'string' || device.machine_id === '') {
        checks.push(check('identity', 'fail', READINESS_CODE.IDENTITY, 'device.json has no machine_id', { required: true }));
      } else if (typeof (device.device_token ?? '') !== 'string' || (device.device_token ?? '') === '') {
        checks.push(check('identity', 'fail', READINESS_CODE.IDENTITY, 'device.json has no device_token', { required: true }));
      } else {
        checks.push(check('identity', 'ok', 'IDENTITY_READY', `machine_id=${device.machine_id}`, {
          machine_id: device.machine_id,
          relay_url: redactUrl(device.rabbit_url ?? ''),
        }));
      }
    } catch (error) {
      checks.push(check('identity', 'fail', READINESS_CODE.IDENTITY,
        `device.json unreadable: ${error instanceof Error ? error.message : String(error)}`, { required: true }));
    }
  }

  const keyFile = join(stateDir, 'device.key');
  if (!existsSync(keyFile)) {
    checks.push(check('device_key', 'fail', READINESS_CODE.DEVICE_KEY, `device.key missing at ${keyFile}`, { required: true }));
  } else {
    try {
      const loaded = DeviceKey.load({ file: keyFile, machineId: device?.machine_id ?? null });
      checks.push(check('device_key', 'ok', 'DEVICE_KEY_READY', 'device.key loaded', {
        public_key_fingerprint: fingerprint(loaded.key.publicKeyBase64),
      }));
    } catch (error) {
      checks.push(check('device_key', 'fail', READINESS_CODE.DEVICE_KEY,
        `device.key rejected: ${error instanceof Error ? error.message : String(error)}`, { required: true }));
    }
  }

  checks.push(checkRemoteConfig(join(stateDir, 'remote-view.json'), expectTransport));
  checks.push(...checkProvider(providerCwd, providerScript));

  const tokenPresent = signalToken !== '' || (() => {
    try { return new URL(signal).searchParams.has('token'); } catch { return false; }
  })();
  if (signal === null || signal === '') {
    checks.push(check('signal', 'fail', READINESS_CODE.SIGNAL, '--signal is required', { required: true }));
  } else {
    const healthUrl = healthOverride ?? signalHealthUrl(signal);
    if (healthUrl === null) {
      checks.push(check('signal', 'fail', READINESS_CODE.SIGNAL, 'signal URL must be ws:// or wss://', { required: true }));
    } else if (!tokenPresent) {
      checks.push(check('signal', 'fail', 'SIGNAL_TOKEN_MISSING',
        `no token in --signal or $${signalTokenEnv}`, { required: true, signal: redactSignalingUrl(signal) }));
    } else if (skipNetwork) {
      checks.push(check('signal_health', 'warn', 'SIGNAL_NETWORK_SKIPPED',
        `network checks skipped; health=${redactUrl(healthUrl)}`, { signal: redactSignalingUrl(signal) }));
    } else {
      try {
        const health = await fetchJson(healthUrl);
        checks.push(health.status === 200 && health.body?.ok === true
          ? check('signal_health', 'ok', 'SIGNAL_HEALTHY',
            `protocol=${health.body.protocol ?? '?'}, uptime_ms=${health.body.uptime_ms ?? '?'}`,
            { health_url: redactUrl(healthUrl) })
          : check('signal_health', 'fail', 'SIGNAL_HEALTH_FAILED',
            `HTTP ${health.status}; /health did not report ok=true`, { required: true, health_url: redactUrl(healthUrl) }));
      } catch (error) {
        checks.push(check('signal_health', 'fail', 'SIGNAL_HEALTH_FAILED',
          `/health failed: ${error instanceof Error ? error.message : String(error)}`,
          { required: true, health_url: redactUrl(healthUrl) }));
      }
      const probe = await probeSignaling(signal, signalToken);
      checks.push(probe.ok
        ? check('signal_websocket', 'ok', probe.code, probe.detail, { signal: redactSignalingUrl(signal) })
        : check('signal_websocket', 'fail', probe.code, probe.detail, { required: true, signal: redactSignalingUrl(signal) }));
    }
  }

  if (skipPool) {
    checks.push(check('pool', 'warn', 'POOL_NOT_OBSERVED',
      'pool check skipped; run without --skip-pool and pass --diagnostics-json/--diagnostics-url'));
  } else if (diagnosticsJson === null && diagnosticsUrl === null) {
    checks.push(check('pool', 'fail', 'POOL_OBSERVER_MISSING',
      'no --diagnostics-json or --diagnostics-url; an out-of-process script cannot see the in-process pool',
      { required: true }));
  } else {
    try {
      const snapshot = diagnosticsJson !== null ? readJson(diagnosticsJson) : await diagnosticsSnapshot(diagnosticsUrl, diagnosticsCookie);
      checks.push(checkPoolSnapshot(snapshot, 'dsh-p2p-webrtc'));
    } catch (error) {
      checks.push(check('pool', 'fail', READINESS_CODE.POOL,
        `pool diagnostics failed: ${error instanceof Error ? error.message : String(error)}`,
        { required: true }));
    }
  }

  const relayUrl = (relayOverride ?? device?.rabbit_url ?? '').replace(/\/+$/, '');
  const relayToken = device?.device_token ?? '';
  const machineId = device?.machine_id ?? '';
  if (skipPeer) {
    checks.push(check('peer_static_key', 'warn', 'PEER_CHECK_SKIPPED', 'peer static key check skipped'));
  } else if (peer === null) {
    checks.push(check('peer_static_key', 'fail', READINESS_CODE.PEER,
      'no --peer; pass the peer machine id or --skip-peer', { required: true }));
  } else if (peerKey !== null) {
    const valid = checkStaticKey(peerKey);
    checks.push(valid.ok
      ? check('peer_static_key', 'ok', 'PEER_STATIC_KEY_OK',
        'peer static key supplied on the command line',
        { peer, fingerprint: fingerprint(peerKey) })
      : check('peer_static_key', 'fail', valid.code, valid.detail, { required: true, peer }));
  } else if (relayUrl === '' || relayToken === '') {
    checks.push(check('peer_static_key', 'fail', READINESS_CODE.RELAY,
      'relay URL or device token missing; cannot read /v1/peer/<machine_id>',
      { required: true, peer }));
  } else {
    try {
      const result = await fetchJson(`${relayUrl}/v1/peer/${encodeURIComponent(peer)}`, {
        authorization: `Bearer ${relayToken}`,
      });
      const staticKey = result.body?.peer?.static_key ?? null;
      const valid = checkStaticKey(staticKey);
      checks.push(valid.ok
        ? check('peer_static_key', 'ok', 'PEER_STATIC_KEY_OK',
          'peer static key read from relay',
          { peer, fingerprint: fingerprint(staticKey) })
        : check('peer_static_key', 'fail', valid.code,
          `GET /v1/peer/${peer}: HTTP ${result.status}, ${valid.detail}`,
          { required: true, peer }));
    } catch (error) {
      checks.push(check('peer_static_key', 'fail', 'PEER_STATIC_KEY_UNAVAILABLE',
        `/v1/peer/${peer} failed: ${error instanceof Error ? error.message : String(error)}`,
        { required: true, peer }));
    }
  }

  if (skipAck) {
    checks.push(check('relay_ack', 'warn', 'ACK_CHECK_SKIPPED', 'relay ack route check skipped'));
  } else if (relayUrl === '' || relayToken === '' || machineId === '') {
    checks.push(check('relay_ack', 'fail', READINESS_CODE.RELAY,
      'relay URL, device token, or machine_id missing; cannot probe /v1/remote/ack',
      { required: true }));
  } else {
    const sessionId = `readiness-${process.pid}-${Date.now().toString(36)}`;
    try {
      const result = await fetchJson(
        `${relayUrl}/v1/remote/ack?session_id=${encodeURIComponent(sessionId)}&target=${encodeURIComponent(machineId)}`,
        { authorization: `Bearer ${relayToken}` },
      );
      checks.push(checkAckResponse(result.status, result.body));
    } catch (error) {
      checks.push(check('relay_ack', 'fail', READINESS_CODE.RELAY,
        `/v1/remote/ack probe failed: ${error instanceof Error ? error.message : String(error)}`,
        { required: true }));
    }
  }

  const failures = checks.filter((entry) => entry.status === 'fail');
  const warnings = checks.filter((entry) => entry.status === 'warn');
  const result = {
    ok: failures.length === 0,
    blocked_by: failures.length === 0 ? null : 'environment',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: nodeVersion,
      repo: REPO,
    },
    state_dir: stateDir,
    machine_id: machineId === '' ? null : machineId,
    signal: signal === null ? null : redactSignalingUrl(signal),
    peer,
    provider_cwd: providerCwd,
    provider_script: providerScript,
    checks,
    failures: failures.length,
    warnings: warnings.length,
  };

  const text = JSON.stringify(result, null, 2);
  if (out !== null) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), text + '\n', 'utf8');
  }
  process.stdout.write(text + '\n');
  process.exitCode = result.ok ? 0 : 2;
}

if (import.meta.url === MAIN) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({
      ok: false,
      blocked_by: 'environment',
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }, null, 2) + '\n');
    process.exitCode = 2;
  });
}
