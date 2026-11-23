/**
 * Preflight gate for the cross-machine WebRTC matrix.
 *
 * The point is attribution, not optimism: a pair run may only start when every required check
 * passes, and a failure afterwards is a code/data-plane failure. A missing provider, an unreachable
 * signaling server, or a mismatched code hash is reported as an environment or code-integrity
 * block *before* any ICE traffic is attempted.
 *
 * Checks are deliberately side-effect free apart from a short-lived signaling room and one device
 * key read. Nothing is written outside `--out`; the relay token is never printed.
 *
 * Usage:
 *   node scripts/webrtc-matrix-preflight.mjs \
 *     --signal wss://host/w2m/webrtc \
 *     [--peer <machine_id>] [--peer-key <base64 static key>] \
 *     [--provider-cwd <dir with node_modules/node-datachannel>] \
 *     [--expected-code <sha256>] [--out preflight.json]
 *
 * Exit codes: 0 = ready (possibly with warnings), 2 = blocked.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const IS_WINDOWS = process.platform === 'win32';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const SIGNAL = arg('signal');
const PEER = arg('peer');
const PEER_KEY = arg('peer-key');
const PROVIDER_CWD = arg(
  'provider-cwd',
  process.env.W2M_WEBRTC_PROVIDER_CWD ??
    (IS_WINDOWS ? 'E:\\DB\\w2m-webrtc-provider' : join(homedir(), 'w2m-webrtc-provider')),
);
const EXPECTED_CODE = arg('expected-code');
const OUT = arg('out');
const STATE_DIR = arg('state', join(homedir(), '.dsh', 'xclient'));
const RELAY_OVERRIDE = arg('relay');
const ICE = (arg('ice', process.env.W2M_WEBRTC_ICE ?? 'stun:stun.l.google.com:19302') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const CODE_FILES = [
  'src/agent/webrtc/pool.mjs',
  'src/agent/webrtc/transport.mjs',
  'src/agent/webrtc/signaling.mjs',
  'src/agent/webrtc/secure.mjs',
  'src/agent/webrtc/providers/node-datachannel-provider.mjs',
  'src/plugin/teams/data-plane.mjs',
  'src/plugin/teams/transport-policy.mjs',
  'scripts/webrtc-cross-machine.mjs',
  'scripts/webrtc-matrix-preflight.mjs',
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value) => (value === null ? null : sha256(String(value)).slice(0, 16));

function check(id, status, detail, extra = {}) {
  return { id, status, detail, ...extra };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function signalServiceUrl(signal) {
  const parsed = new URL(signal);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('signal URL must be ws:// or wss://');
  }
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/health';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function codeManifest() {
  const missing = [];
  const lines = [];
  for (const relative of CODE_FILES) {
    const absolute = join(REPO, relative);
    if (!existsSync(absolute)) {
      missing.push(relative);
      continue;
    }
    lines.push(`${relative}\u0000${sha256(readFileSync(absolute))}`);
  }
  return { missing, digest: missing.length === 0 ? sha256(lines.join('\n')) : null };
}

function providerCheck() {
  const moduleDir = join(PROVIDER_CWD, 'node_modules', 'node-datachannel');
  if (!existsSync(moduleDir)) {
    return { ok: false, detail: `node_modules/node-datachannel not found under ${PROVIDER_CWD}` };
  }
  try {
    const req = createRequire(join(PROVIDER_CWD, 'package.json'));
    const mod = req('node-datachannel');
    const hasPeer = typeof mod?.PeerConnection === 'function';
    return {
      ok: hasPeer,
      detail: hasPeer
        ? `node-datachannel loaded from ${PROVIDER_CWD}`
        : 'node-datachannel loaded but PeerConnection is missing',
      version: mod?.version ?? null,
    };
  } catch (error) {
    return { ok: false, detail: `load failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function signalingProbe() {
  const probeId = `preflight-${process.pid}-${Date.now()}`;
  const base = new URL(SIGNAL);
  base.searchParams.set('room', `preflight-${probeId}`);
  base.searchParams.set('role', 'host');
  base.searchParams.set('peer', probeId);
  base.searchParams.set('protocol', 'w2m-webrtc/1');
  if (typeof globalThis.WebSocket !== 'function') {
    return { ok: false, detail: 'no global WebSocket (Node 22+ required)' };
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    let socket = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolvePromise(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: 'no join confirmation within 8s' }), 8_000);
    timer.unref?.();
    try {
      socket = new globalThis.WebSocket(base.toString());
    } catch (error) {
      finish({ ok: false, detail: `open failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    socket.addEventListener('error', () => finish({ ok: false, detail: 'WebSocket error before join' }));
    socket.addEventListener('close', () => finish({ ok: false, detail: 'WebSocket closed before join' }));
    socket.addEventListener('open', () => {
      try {
        socket.send(
          JSON.stringify({
            type: 'join',
            room: base.searchParams.get('room'),
            role: 'host',
            peer: probeId,
            protocol: 'w2m-webrtc/1',
          }),
        );
      } catch (error) {
        finish({ ok: false, detail: `join send failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
    socket.addEventListener('message', (event) => {
      let message = null;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type === 'joined') finish({ ok: true, detail: `joined room ${base.searchParams.get('room')}` });
      if (message?.type === 'error') finish({ ok: false, detail: `server error: ${message.code ?? 'UNKNOWN'}` });
    });
  });
}

async function main() {
  const checks = [];
  const startedAt = new Date().toISOString();
  const nodeVersion = process.version;
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
  checks.push(
    major >= 20
      ? check('node_version', 'ok', nodeVersion)
      : check('node_version', 'fail', `${nodeVersion}; Node 20+ is required, 22+ recommended`, { required: true }),
  );

  let identity = null;
  const deviceFile = join(STATE_DIR, 'device.json');
  if (!existsSync(deviceFile)) {
    checks.push(check('identity', 'fail', `device.json missing at ${deviceFile}`, { required: true }));
  } else {
    try {
      identity = readJson(deviceFile);
      checks.push(
        typeof identity?.machine_id === 'string' && identity.machine_id !== ''
          ? check('identity', 'ok', `machine_id=${identity.machine_id}`, {
              machine_id: identity.machine_id,
              machine_name: identity.machine_name ?? null,
            })
          : check('identity', 'fail', 'device.json has no machine_id', { required: true }),
      );
    } catch (error) {
      checks.push(check('identity', 'fail', `device.json unreadable: ${error.message}`, { required: true }));
    }
  }

  const keyFile = join(STATE_DIR, 'device.key');
  if (!existsSync(keyFile)) {
    checks.push(check('device_key', 'fail', `device.key missing at ${keyFile}`, { required: true }));
  } else {
    try {
      const { DeviceKey } = await import('../src/agent/crypto.mjs');
      const loaded = DeviceKey.load({ file: keyFile, machineId: identity?.machine_id ?? null });
      checks.push(
        check('device_key', 'ok', 'device.key loaded', {
          public_key: loaded.key.publicKeyBase64,
          public_key_fingerprint: fingerprint(loaded.key.publicKeyBase64),
        }),
      );
    } catch (error) {
      checks.push(check('device_key', 'fail', `device.key rejected: ${error.message}`, { required: true }));
    }
  }

  const manifest = codeManifest();
  if (manifest.missing.length > 0) {
    checks.push(
      check('code_integrity', 'fail', `missing files: ${manifest.missing.join(', ')}`, {
        required: true,
        blocked_by: 'code',
        missing: manifest.missing,
      }),
    );
  } else if (EXPECTED_CODE !== null && manifest.digest !== EXPECTED_CODE) {
    checks.push(
      check('code_integrity', 'fail', 'code hash differs from --expected-code', {
        required: true,
        blocked_by: 'code',
        actual: manifest.digest,
        expected: EXPECTED_CODE,
      }),
    );
  } else {
    checks.push(check('code_integrity', 'ok', `code hash ${manifest.digest}`, { code_hash: manifest.digest }));
  }

  if (identity !== null) {
    const relayUrl = (RELAY_OVERRIDE ?? identity.rabbit_url ?? '').replace(/\/+$/, '');
    const token = identity.device_token ?? '';
    if (relayUrl === '' || token === '') {
      checks.push(check('relay_health', 'fail', 'relay URL or device token missing', { required: true }));
    } else {
      try {
        const health = await getJson(`${relayUrl}/healthz`);
        checks.push(
          health?.ok === true
            ? check('relay_health', 'ok', `version ${health.version ?? '?'}, devices_online=${health.devices_online ?? '?'}`)
            : check('relay_health', 'fail', 'healthz did not report ok=true', { required: true }),
        );
      } catch (error) {
        checks.push(check('relay_health', 'fail', `healthz failed: ${error.message}`, { required: true }));
      }

      try {
        const list = await getJson(`${relayUrl}/v1/devices`, { authorization: `Bearer ${token}` });
        const rows = Array.isArray(list?.devices) ? list.devices : [];
        const self = rows.find((row) => row?.machine_id === identity.machine_id) ?? null;
        if (self === null) {
          checks.push(
            check('relay_registration', 'warn', 'machine_id is not in /v1/devices; pair key must be supplied explicitly', {
              registered: false,
            }),
          );
        } else if (self.online === true) {
          checks.push(check('relay_registration', 'ok', `registered and online, rtt_ms=${self.rtt_ms ?? '?'}`));
        } else {
          checks.push(
            check('relay_registration', 'warn', 'registered but agent is offline; standalone WebRTC can still run', {
              online: false,
              last_seen_at: self.last_seen_at ?? null,
            }),
          );
        }
      } catch (error) {
        checks.push(check('relay_registration', 'warn', `could not read /v1/devices: ${error.message}`));
      }

      if (PEER !== null) {
        if (PEER_KEY !== null) {
          checks.push(
            check('peer_key', 'ok', 'peer static key supplied on the command line', {
              peer: PEER,
              peer_key_fingerprint: fingerprint(PEER_KEY),
            }),
          );
        } else {
          try {
            const peer = await getJson(`${relayUrl}/v1/peer/${encodeURIComponent(PEER)}`, {
              authorization: `Bearer ${token}`,
            });
            const staticKey = peer?.peer?.static_key ?? null;
            if (typeof staticKey === 'string' && staticKey !== '') {
              checks.push(
                check('peer_key', 'ok', 'peer static key read from relay', {
                  peer: PEER,
                  peer_key_fingerprint: fingerprint(staticKey),
                }),
              );
            } else {
              checks.push(check('peer_key', 'fail', 'relay answered without peer.static_key', { required: true }));
            }
          } catch (error) {
            checks.push(
              check('peer_key', 'fail', `no relay peer record for ${PEER} (${error.message}); pass --peer-key`, {
                required: true,
              }),
            );
          }
        }
      }
    }
  }

  if (SIGNAL === null) {
    checks.push(check('signal_health', 'fail', '--signal is required', { required: true }));
  } else {
    try {
      const healthUrl = signalServiceUrl(SIGNAL);
      const health = await getJson(healthUrl);
      checks.push(
        health?.ok === true
          ? check('signal_health', 'ok', `protocol=${health.protocol ?? '?'}, uptime_ms=${health.uptime_ms ?? '?'}`, {
              health_url: healthUrl,
            })
          : check('signal_health', 'fail', 'signal /health did not report ok=true', { required: true }),
      );
    } catch (error) {
      checks.push(check('signal_health', 'fail', `signal /health failed: ${error.message}`, { required: true }));
    }
    const probe = await signalingProbe();
    checks.push(
      probe.ok
        ? check('signal_websocket', 'ok', probe.detail)
        : check('signal_websocket', 'fail', probe.detail, { required: true }),
    );
  }

  const provider = providerCheck();
  checks.push(
    provider.ok
      ? check('provider_module', 'ok', provider.detail, { version: provider.version ?? null })
      : check('provider_module', 'fail', provider.detail, { required: true }),
  );

  const providerScript = join(REPO, 'src/agent/webrtc/providers/node-datachannel-provider.mjs');
  checks.push(
    existsSync(providerScript)
      ? check('provider_script', 'ok', providerScript)
      : check('provider_script', 'fail', `provider script missing at ${providerScript}`, { required: true }),
  );

  checks.push(
    ICE.length > 0
      ? check('ice_configuration', 'ok', ICE.join(','))
      : check('ice_configuration', 'warn', 'no STUN/TURN configured; only host candidates will be exchanged'),
  );

  const failures = checks.filter((entry) => entry.status === 'fail');
  const warnings = checks.filter((entry) => entry.status === 'warn');
  const codeFailure = failures.some((entry) => entry.blocked_by === 'code');
  const result = {
    ok: failures.length === 0,
    blocked_by: failures.length === 0 ? null : codeFailure ? 'code' : 'environment',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: nodeVersion,
      repo: REPO,
      provider_cwd: PROVIDER_CWD,
    },
    identity: identity === null ? null : {
      machine_id: identity.machine_id ?? null,
      machine_name: identity.machine_name ?? null,
      relay_url: (RELAY_OVERRIDE ?? identity.rabbit_url ?? null),
    },
    signal: SIGNAL,
    peer: PEER,
    code_hash: manifest.digest,
    checks,
    failures: failures.length,
    warnings: warnings.length,
  };

  const text = JSON.stringify(result, null, 2);
  if (OUT !== null) {
    mkdirSync(dirname(resolve(OUT)), { recursive: true });
    writeFileSync(resolve(OUT), text + '\n', 'utf8');
  }
  process.stdout.write(text + '\n');
  process.exitCode = result.ok ? 0 : 2;
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, blocked_by: 'environment', error: error?.stack ?? String(error) }, null, 2) + '\n');
  process.exitCode = 2;
});

