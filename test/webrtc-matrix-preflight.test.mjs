/**
 * The cross-machine preflight gate, run the way an operator runs it: the real script as a child process,
 * a real signaling server that requires a token, a throwaway identity, and a loopback relay stand-in that
 * answers the two endpoints the gate reads (`/healthz`, `/v1/devices`).
 *
 * Two secrets sit on the command line and in the identity: the signaling token and the relay's device
 * token. The gate's promise is that neither is printed or written, so every path that produces output --
 * a ready verdict, a blocked verdict, a signal URL that will not parse -- is checked for both.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DeviceKey } from '../src/agent/crypto.mjs';
import { createSignalingServer } from '../src/agent/webrtc/signaling-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCRIPT = join(REPO, 'scripts', 'webrtc-matrix-preflight.mjs');
/** Random per run and long, so a shorter string passing for one of them cannot hide a leak. */
const SIGNAL_TOKEN = `signal-${randomUUID()}`;
const RELAY_TOKEN = `relay-${randomUUID()}`;
const machineId = randomUUID();
/** Where the gate itself looks for the addon when told nothing (its own default), so both agree. */
const providerCwd =
  process.env.W2M_WEBRTC_PROVIDER_CWD ??
  (process.platform === 'win32' ? 'E:\\DB\\w2m-webrtc-provider' : join(homedir(), 'w2m-webrtc-provider'));
const providerPresent = existsSync(join(providerCwd, 'node_modules', 'node-datachannel'));

let work = '';
let relay = null;
let signaling = null;
let state = '';
let relayUrl = '';
let signalUrl = '';
let outFile = '';
let beforeRun = [];
let ready = null;

/** Every file under `dir`, as paths relative to it. */
function tree(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
}

async function runGate({ signal = signalUrl, out = outFile, extra = [] } = {}) {
  const args = [SCRIPT, '--state', state, '--signal', signal, '--provider-cwd', providerCwd];
  if (out !== null) args.push('--out', out);
  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [...args, ...extra], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
    }));
  } catch (error) {
    ({ stdout = '', stderr = '' } = error);
    status = typeof error.code === 'number' ? error.code : -1;
  }
  const written = out !== null && existsSync(out) ? readFileSync(out, 'utf8') : '';
  let result = null;
  try {
    result = JSON.parse(written || stdout);
  } catch {
    result = null;
  }
  return { stdout, stderr, status, written, result };
}

/** Async on purpose: the servers this file runs live in the parent, and a synchronous child would silence them. */
const execFileAsync = promisify(execFile);

const checkById = (result) => Object.fromEntries((result?.checks ?? []).map((entry) => [entry.id, entry]));

/** The gate's hygiene promise, applied to one run's three outputs. */
function assertNoSecrets(run, label) {
  for (const [name, text] of [
    ['stdout', run.stdout],
    ['stderr', run.stderr],
    ['--out', run.written],
  ]) {
    assert.equal(text.includes(SIGNAL_TOKEN), false, `${label}: ${name} carries the signaling token`);
    assert.equal(text.includes(RELAY_TOKEN), false, `${label}: ${name} carries the relay device token`);
  }
}

describe('cross-machine preflight gate', () => {
  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'w2m-preflight-'));
    outFile = join(work, 'preflight.json');

    // The relay stand-in answers the two reads the gate makes; it holds no state and asks for no credential.
    const machine = machineId;
    relay = createServer((request, response) => {
      response.writeHead(request.url === '/healthz' || request.url === '/v1/devices' ? 200 : 404, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify(
          request.url === '/healthz'
            ? { ok: true, version: 'stand-in' }
            : request.url === '/v1/devices'
              ? { devices: [{ machine_id: machine, online: true, rtt_ms: 1 }] }
              : { ok: false },
        ),
      );
    });
    await new Promise((resolvePromise) => {
      relay.listen(0, '127.0.0.1', resolvePromise);
    });
    relayUrl = `http://127.0.0.1:${relay.address().port}`;

    signaling = await createSignalingServer({ host: '127.0.0.1', port: 0, token: SIGNAL_TOKEN });
    signalUrl = `${signaling.url}?token=${SIGNAL_TOKEN}`;

    state = join(work, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, 'device.json'),
      `${JSON.stringify({
        machine_id: machineId,
        machine_name: 'preflight-test',
        rabbit_url: relayUrl,
        device_token: RELAY_TOKEN,
      })}\n`,
      'utf8',
    );
    DeviceKey.load({ file: join(state, 'device.key'), machineId });

    beforeRun = tree(work);
    ready = await runGate();
  });

  after(async () => {
    await signaling?.close?.();
    await new Promise((resolvePromise) => {
      relay?.close(() => resolvePromise());
    });
    rmSync(work, { recursive: true, force: true });
  });

  it('names what it found on every axis it was given', () => {
    const found = checkById(ready.result);
    assert.equal(found.identity?.status, 'ok');
    assert.equal(found.identity.machine_id, machineId);
    assert.equal(found.device_key?.status, 'ok');
    assert.equal(found.relay_health?.status, 'ok');
    assert.equal(found.relay_registration?.status, 'ok');
    assert.equal(found.signal_health?.status, 'ok');
    assert.equal(found.signal_websocket?.status, 'ok');
    assert.equal(found.provider_script?.status, 'ok');
    assert.equal(found.code_integrity?.status, 'ok');
    assert.match(found.code_integrity.code_hash, /^[0-9a-f]{64}$/u);
    assert.equal(ready.result.identity.relay_url, relayUrl);
    // The provider is the one axis this file cannot supply: the addon is a native build owned by the host.
    if (providerPresent) {
      assert.equal(found.provider_module?.status, 'ok');
      assert.equal(ready.result.ok, true);
      assert.equal(ready.result.blocked_by, null);
      assert.equal(ready.status, 0);
    } else {
      assert.equal(found.provider_module?.status, 'fail');
      assert.equal(ready.result.blocked_by, 'environment');
      assert.equal(ready.status, 2);
    }
  });

  it('writes nothing outside --out', () => {
    assert.deepEqual(tree(work), [...beforeRun, 'preflight.json'].sort());
  });

  it('reports the signaling URL with its token struck, and keeps both tokens out of stdout and --out', () => {
    assert.equal(ready.result.signal.includes(SIGNAL_TOKEN), false);
    assert.match(ready.result.signal, /token=.*redacted/u);
    assertNoSecrets(ready, 'ready verdict');
  });

  it('blocks on a code hash that differs from --expected-code, naming both hashes, and still prints no token', async () => {
    const real = checkById(ready.result).code_integrity.code_hash;
    const blocked = await runGate({ extra: ['--expected-code', `0`.repeat(64)] });
    const found = checkById(blocked.result);
    assert.equal(found.code_integrity?.status, 'fail');
    assert.equal(found.code_integrity.blocked_by, 'code');
    assert.equal(found.code_integrity.actual, real);
    assert.equal(found.code_integrity.expected, `0`.repeat(64));
    assert.equal(blocked.result.blocked_by, 'code');
    assert.equal(blocked.status, 2);
    assertNoSecrets(blocked, 'blocked verdict');
  });

  it('prints no token when the signal URL will not parse, the path that echoes its own input', async () => {
    const unparsable = await runGate({ signal: `ws://[::1:8788/w2m/webrtc?token=${SIGNAL_TOKEN}`, out: null });
    assert.equal(unparsable.result?.ok, false);
    assert.equal(unparsable.status, 2);
    assertNoSecrets(unparsable, 'unparsable signal URL');
  });
});
