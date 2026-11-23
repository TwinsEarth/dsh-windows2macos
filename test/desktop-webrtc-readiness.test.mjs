import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { DeviceKey } from '../src/agent/crypto.mjs';
import {
  checkAckResponse,
  checkPoolSnapshot,
  checkProvider,
  checkRemoteConfig,
  checkStaticKey,
  signalHealthUrl,
} from '../bin/w2m-desktop-readiness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SCRIPT = join(REPO, 'bin', 'w2m-desktop-readiness.mjs');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeProvider(root) {
  const cwd = join(root, 'provider');
  const moduleDir = join(cwd, 'node_modules', 'node-datachannel');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'readiness-provider-fixture', version: '1.0.0' }));
  writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ name: 'node-datachannel', version: 'test-1' }));
  writeFileSync(join(moduleDir, 'index.js'), 'exports.PeerConnection = function PeerConnection() {};\nexports.version = "test-1";\n');
  const script = join(cwd, 'node-datachannel-provider.mjs');
  writeFileSync(script, '// readiness fixture provider\n');
  return { cwd, script };
}

test('signalHealthUrl maps ws/wss to health and drops secrets', () => {
  assert.equal(signalHealthUrl('wss://signal.example/w2m/webrtc?token=secret'), 'https://signal.example/health');
  assert.equal(signalHealthUrl('ws://127.0.0.1:8788/w2m/webrtc'), 'http://127.0.0.1:8788/health');
  assert.equal(signalHealthUrl('https://not-a-ws.example/'), null);
  assert.equal(signalHealthUrl('not a url'), null);
});

test('remote-view config must be transport=webrtc and enabled', () => {
  const root = tempDir('w2m-readiness-config-');
  try {
    const file = join(root, 'remote-view.json');
    const missing = checkRemoteConfig(file, 'webrtc');
    assert.equal(missing.status, 'warn');
    assert.equal(missing.code, 'REMOTE_CONFIG_ABSENT');

    writeFileSync(file, JSON.stringify({ enabled: true, transport: 'webrtc' }));
    const ok = checkRemoteConfig(file, 'webrtc');
    assert.equal(ok.status, 'ok');
    assert.equal(ok.code, 'REMOTE_CONFIG_WEBRTC');

    writeFileSync(file, JSON.stringify({ enabled: true, transport: 'relay' }));
    const mismatch = checkRemoteConfig(file, 'webrtc');
    assert.equal(mismatch.status, 'fail');
    assert.equal(mismatch.code, 'REMOTE_CONFIG_TRANSPORT_MISMATCH');
    assert.equal(mismatch.transport, 'relay');

    writeFileSync(file, '{bad json');
    const invalid = checkRemoteConfig(file, 'webrtc');
    assert.equal(invalid.status, 'fail');
    assert.equal(invalid.code, 'REMOTE_CONFIG_INVALID');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('static keys are strict 32-byte base64', () => {
  const good = Buffer.alloc(32, 7).toString('base64');
  assert.equal(checkStaticKey(good).ok, true);
  assert.equal(checkStaticKey(Buffer.alloc(16, 7).toString('base64')).code, 'WEBRTC_STATIC_KEY_INVALID');
  assert.equal(checkStaticKey('').code, 'WEBRTC_STATIC_KEY_MISSING');
});

test('pool snapshot requires owner dsh-p2p-webrtc and ready=true', () => {
  const body = {
    ok: true,
    pool_available: true,
    pool_owner: 'dsh-p2p-webrtc',
    pool: { ready: true, machine_id: 'viewer-1', peer_count: 2 },
    secret_that_must_not_escape: 'signal-token-value',
  };
  const ok = checkPoolSnapshot(body);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.code, 'POOL_READY');
  assert.equal(JSON.stringify(ok).includes('signal-token-value'), false);

  assert.equal(checkPoolSnapshot({ ...body, pool_owner: 'w2m-root' }).code, 'POOL_OWNER_MISMATCH');
  assert.equal(checkPoolSnapshot({ ...body, pool_available: false }).code, 'POOL_NOT_READY');
  assert.equal(checkPoolSnapshot({ ...body, ok: false }).code, 'POOL_DIAGNOSTICS_BAD');
});

test('ack probe distinguishes present, missing, forbidden, and unexpected', () => {
  assert.equal(checkAckResponse(404, { error: { code: 'REMOTE_ACK_NOT_FOUND' } }).status, 'ok');
  const missing = checkAckResponse(404, { error: { code: 'NOT_FOUND' } });
  assert.equal(missing.status, 'fail');
  assert.equal(missing.code, 'REMOTE_ACK_ROUTE_MISSING');
  assert.equal(checkAckResponse(401, {}).code, 'REMOTE_ACK_FORBIDDEN');
  assert.equal(checkAckResponse(200, { ok: true }).status, 'warn');
});

test('provider check resolves node-datachannel from providerCwd only', () => {
  const root = tempDir('w2m-readiness-provider-');
  try {
    const fixture = fakeProvider(root);
    const checks = checkProvider(fixture.cwd, fixture.script);
    const moduleCheck = checks.find((entry) => entry.id === 'provider_module');
    assert.equal(moduleCheck.status, 'ok');
    assert.equal(moduleCheck.code, 'PROVIDER_MODULE_READY');
    assert.match(moduleCheck.detail, /test-1/);

    const missing = checkProvider(join(root, 'missing'), fixture.script);
    assert.equal(missing.find((entry) => entry.id === 'provider_cwd').code, 'PROVIDER_CWD_MISSING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI emits a ready JSON report without printing device or signal secrets', () => {
  const root = tempDir('w2m-readiness-cli-');
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'device.json'), JSON.stringify({
      machine_id: 'readiness-machine',
      rabbit_url: 'https://relay.example',
      device_token: 'super-secret-device-token',
    }));
    DeviceKey.load({ file: join(state, 'device.key'), machineId: 'readiness-machine' });
    const fixture = fakeProvider(root);
    const output = execFileSync(process.execPath, [
      SCRIPT,
      '--state', state,
      '--signal', 'wss://signal.example/w2m/webrtc',
      '--provider-cwd', fixture.cwd,
      '--provider-script', fixture.script,
      '--skip-network',
      '--skip-pool',
      '--skip-peer',
      '--skip-ack',
    ], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, W2M_WEBRTC_SIGNAL_TOKEN: 'super-secret-signal-token' },
    });
    const body = JSON.parse(output);
    assert.equal(body.ok, true);
    assert.equal(body.failures, 0);
    assert.equal(body.machine_id, 'readiness-machine');
    assert.equal(body.signal, 'wss://signal.example/w2m/webrtc');
    assert.equal(output.includes('super-secret-device-token'), false);
    assert.equal(output.includes('super-secret-signal-token'), false);
    assert.equal(output.includes('signal_token'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
