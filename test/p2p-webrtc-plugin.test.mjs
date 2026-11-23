/**
 * Wiring, packaging and the inert-mount rule for `dsh-p2p-webrtc`.
 *
 * A row that ships disabled must not spawn an engine or open a socket merely because it was
 * composed. The test mounts the real `apply()` against a fake Cordis context, reads the real
 * `cordis.patch.yml` and `package.json`, and drives the registered tool definitions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeviceKey } from '../src/agent/crypto.mjs';
import {
  apply,
  buildTools,
  describeConfig,
  normalizePluginConfig,
  P2PWebRtcService,
  P2P_WEBRTC_ROW_ID,
  TOOL_NAMES,
} from '../src/plugin/p2p-webrtc-plugin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');

function patchRow(id) {
  const lines = patch.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(`- id: ${id}`));
  assert.ok(start >= 0, `row ${id} is missing from cordis.patch.yml`);
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && /^ {4}- id:/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function fakeContext() {
  const definitions = [];
  const registered = [];
  const effects = [];
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register(definition) {
        definitions.push(definition);
        registered.push(definition.name);
      },
    },
    inject(services, callback) {
      callback({ tools: { register: (definition) => ctx.tools.register(definition) } });
    },
    effect(setup) {
      effects.push(setup);
    },
  };
  return { ctx, definitions, registered, effects };
}

function json(value) {
  return JSON.parse(value);
}

describe('dsh-p2p-webrtc wiring', () => {
  it('declares the export, the lib seam and an existing entry file', () => {
    assert.equal(pkg.exports['./dsh-p2p-webrtc'], './lib/p2p-webrtc-plugin.js');
    assert.ok(existsSync(join(ROOT, 'lib/p2p-webrtc-plugin.js')));
    assert.ok(existsSync(join(ROOT, 'src/plugin/p2p-webrtc-plugin.mjs')));
    assert.equal(pkg.bin['w2m-webrtc-signal'], 'bin/w2m-webrtc-signal.mjs');
    assert.ok(existsSync(join(ROOT, 'bin/w2m-webrtc-signal.mjs')));
  });

  it('ships the patch row disabled, with no guessed identity or provider', () => {
    const row = patchRow(P2P_WEBRTC_ROW_ID);
    assert.match(row, /name: '@twinsearth\/w2m-dsh-plugin\/dsh-p2p-webrtc'/);
    assert.match(row, /disabled: true/);
    assert.match(row, /signalUrl: ''/);
    assert.match(row, /providerCommand: ''/);
    assert.match(row, /autoStart: false/);
    assert.equal(row.includes('peerKeys: {}'), true);
  });

  it('mounts four tools and stays inert until start', async () => {
    const { ctx, definitions, registered, effects } = fakeContext();
    const dispose = await apply(
      ctx,
      {
        role: 'client',
        signalUrl: 'ws://127.0.0.1:8788/w2m/webrtc',
        signalToken: 'secret',
        peerMachineId: 'machine-b',
        peerPublicKey: Buffer.alloc(32).toString('base64'),
        providerCommand: 'node',
      },
      { defineTool: (definition) => definition },
    );
    assert.equal(typeof dispose, 'function');
    assert.deepEqual(registered, [...TOOL_NAMES]);
    assert.equal(definitions.length, 4);
    assert.equal(dispose.ok, true);
    assert.equal(dispose.config.signal_token, '<redacted>');
    assert.equal(JSON.stringify(dispose.config).includes('secret'), false);
    assert.equal(effects.length, 1);

    const statusTool = definitions.find((definition) => definition.name === 'p2p_webrtc_status');
    const status = json(await statusTool.execute({}));
    assert.equal(status.state, 'idle');
    assert.equal(status.transport, null);

    const startTool = definitions.find((definition) => definition.name === 'p2p_webrtc_start');
    const refused = json(await startTool.execute({}));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'WEBRTC_CONFIRM_REQUIRED');

    const stopTool = definitions.find((definition) => definition.name === 'p2p_webrtc_stop');
    const stopped = json(await stopTool.execute({}));
    assert.equal(stopped.ok, true);
  });

  it('normalizes peer keys and never prints a TURN credential', () => {
    const cfg = normalizePluginConfig(
      {
        signalUrl: 'wss://signal.example/w2m/webrtc',
        signalToken: 'token',
        peerKeys: { 'machine-b': 'key-b' },
        iceServers: [
          { urls: ['stun:stun.example:3478'] },
          { urls: ['turns:turn.example:5349'], username: 'u', credential: 'super-secret' },
        ],
      },
      { dshHome: 'C:/dsh' },
    );
    assert.equal(cfg.peer_keys.get('machine-b'), 'key-b');
    const described = describeConfig(cfg);
    assert.equal(described.signal_token, '<redacted>');
    assert.equal(JSON.stringify(described).includes('super-secret'), false);
    assert.equal(described.ice_servers.length, 2);
  });

  it('detects an invalid ICE scheme before any process starts', () => {
    const cfg = normalizePluginConfig({ iceServers: [{ urls: ['http://not-ice'] }] });
    assert.equal(cfg.ice_servers.length, 0);
    assert.ok(cfg.ice_refused.length >= 1);
  });

  it('service refuses a start without a provider and does not spawn a child', async () => {
    const cfg = normalizePluginConfig({
      role: 'client',
      signalUrl: 'ws://127.0.0.1:1/w2m/webrtc',
      peerMachineId: 'machine-b',
      peerPublicKey: Buffer.alloc(32).toString('base64'),
    });
    const service = new P2PWebRtcService(cfg, { deviceKey: DeviceKey.generate('machine-b') });
    const result = await service.start();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBRTC_PROVIDER_UNAVAILABLE');
    assert.equal(service.transport, null);
  });

  it('buildTools is a pure builder over an injected service', () => {
    const service = new P2PWebRtcService(normalizePluginConfig({}));
    const definitions = buildTools({ service, defineTool: (definition) => definition });
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      [...TOOL_NAMES],
    );
    assert.equal(definitions[0].parameters && typeof definitions[0].parameters, 'object');
  });
});
