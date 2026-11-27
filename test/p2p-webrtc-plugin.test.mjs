/**
 * Wiring, packaging and the inert-mount rule for `dsh-p2p-webrtc`.
 *
 * A row that ships disabled must not spawn an engine or open a socket merely because it was
 * composed. The test mounts the real `apply()` against a fake Cordis context, reads the real
 * `cordis.patch.yml` and `package.json`, and drives the registered tool definitions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeviceKey } from '../src/agent/crypto.mjs';
import { createWebRtcPoolRegistry } from '../src/plugin/webrtc-pool-registry.mjs';
import {
  apply,
  buildTools,
  describeConfig,
  normalizePluginConfig,
  P2PWebRtcService,
  P2P_WEBRTC_MODES,
  P2P_WEBRTC_POOL_CODE,
  P2P_WEBRTC_POOL_OWNER,
  P2P_WEBRTC_REPAIR_PATH,
  P2P_WEBRTC_ROW_ID,
  registerP2pWebRtcRepairRoute,
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
  const routes = new Map();
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register(definition) {
        definitions.push(definition);
        registered.push(definition.name);
      },
    },
    inject(services, callback) {
      callback({
        tools: { register: (definition) => ctx.tools.register(definition) },
        connection: { fetch: { register: (route) => routes.set(route.path, route) } },
      });
    },
    effect(setup) {
      effects.push(setup);
    },
  };
  return { ctx, definitions, registered, effects, routes };
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

  it('mounts a POST-only repair route and leaves an already-ready pool alone', async () => {
    const routes = new Map();
    const ctx = {
      inject: (_services, callback) => callback({
        connection: { fetch: { register: (route) => routes.set(route.path, route) } },
      }),
    };
    let starts = 0;
    const service = {
      status: () => ({ ok: true, pool: { ready: true, owner: P2P_WEBRTC_POOL_OWNER } }),
      start: async () => { starts += 1; return { ok: true }; },
    };
    assert.equal(registerP2pWebRtcRepairRoute(ctx, service), true);
    const route = routes.get(P2P_WEBRTC_REPAIR_PATH);
    assert.ok(route, 'the repair route must be registered');
    assert.deepEqual(route.methods, ['POST']);
    const response = await route.fetch({ method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.already_ready, true);
    assert.equal(starts, 0, 'a ready pool must not be restarted');
  });

  it('repairs an absent pool and returns 502 when the rebuild is refused', async () => {
    const routes = new Map();
    const ctx = {
      inject: (_services, callback) => callback({
        connection: { fetch: { register: (route) => routes.set(route.path, route) } },
      }),
    };
    let ready = false;
    let starts = 0;
    let refusal = null;
    const service = {
      status: () => ({ ok: true, pool: { ready } }),
      start: async () => {
        starts += 1;
        if (refusal !== null) return refusal;
        ready = true;
        return { ok: true, state: 'pool-ready', pool: { ready: true } };
      },
    };
    assert.equal(registerP2pWebRtcRepairRoute(ctx, service), true);
    const route = routes.get(P2P_WEBRTC_REPAIR_PATH);

    const repaired = await route.fetch({ method: 'POST' });
    assert.equal(repaired.status, 200);
    const repairedBody = await repaired.json();
    assert.equal(repairedBody.ok, true);
    assert.equal(starts, 1);

    ready = false;
    refusal = {
      ok: false,
      code: 'WEBRTC_PROVIDER_UNAVAILABLE',
      detail: 'providerCommand is required',
    };
    const failed = await route.fetch({ method: 'POST' });
    assert.equal(failed.status, 502);
    const failedBody = await failed.json();
    assert.equal(failedBody.ok, false);
    assert.equal(failedBody.code, 'WEBRTC_PROVIDER_UNAVAILABLE');
    assert.equal(starts, 2);
  });

  it('passes an auto-discovered provider into the repair start and reports stages', async () => {
    const routes = new Map();
    const ctx = {
      inject: (_services, callback) => callback({
        connection: { fetch: { register: (route) => routes.set(route.path, route) } },
      }),
    };
    let overrides = null;
    let ready = false;
    const service = {
      status: () => ({ ok: true, pool: { ready } }),
      discoverProvider: () => ({
        ok: true,
        source: 'auto',
        provider_command: 'node',
        provider_args: ['C:\\provider\\node-datachannel-provider.mjs'],
        provider_cwd: 'C:\\provider',
      }),
      start: async (value) => {
        overrides = value;
        ready = true;
        return { ok: true, state: 'pool-ready', pool: { ready: true } };
      },
    };
    assert.equal(registerP2pWebRtcRepairRoute(ctx, service), true);
    const route = routes.get(P2P_WEBRTC_REPAIR_PATH);
    const response = await route.fetch({ method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.provider.source, 'auto');
    assert.deepEqual(overrides, {
      provider_command: 'node',
      provider_args: ['C:\\provider\\node-datachannel-provider.mjs'],
      provider_cwd: 'C:\\provider',
    });
    assert.deepEqual(body.stages.map((stage) => stage.name), ['provider', 'pool']);
  });

  it('refuses repair before start when no installed provider can be found', async () => {
    const routes = new Map();
    const ctx = {
      inject: (_services, callback) => callback({
        connection: { fetch: { register: (route) => routes.set(route.path, route) } },
      }),
    };
    let starts = 0;
    const service = {
      status: () => ({ ok: true, pool: { ready: false } }),
      discoverProvider: () => ({
        ok: false,
        code: 'WEBRTC_PROVIDER_UNAVAILABLE',
        detail: 'no installed provider',
        checked: ['C:\\Users\\fangw\\.w2m\\webrtc-provider'],
      }),
      start: async () => { starts += 1; return { ok: true, pool: { ready: true } }; },
    };
    assert.equal(registerP2pWebRtcRepairRoute(ctx, service), true);
    const route = routes.get(P2P_WEBRTC_REPAIR_PATH);
    const response = await route.fetch({ method: 'POST' });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.code, 'WEBRTC_PROVIDER_UNAVAILABLE');
    assert.deepEqual(body.provider.checked, ['C:\\Users\\fangw\\.w2m\\webrtc-provider']);
    assert.equal(starts, 0, 'a failed provider probe must not attempt a pool start');
  });

  it('discovers a standard provider directory when providerCommand is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'w2m-provider-test-'));
    try {
      const providerDir = join(root, 'webrtc-provider');
      mkdirSync(join(providerDir, 'node_modules', 'node-datachannel'), { recursive: true });
      writeFileSync(join(providerDir, 'node-datachannel-provider.mjs'), '// provider\n');
      const service = new P2PWebRtcService(
        { provider_command: '', provider_cwd: '', dsh_home: root, pool_factory: null },
        { providerDirs: [providerDir], env: {} },
      );
      const found = service.discoverProvider();
      assert.equal(found.ok, true);
      assert.equal(found.source, 'auto');
      assert.equal(found.provider_cwd, providerDir);
      assert.equal(found.provider_command, process.execPath, 'auto-discovery must use the host Node binary when it is a Node process');
      assert.deepEqual(found.provider_args, [join(providerDir, 'node-datachannel-provider.mjs')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names a missing provider script instead of starting a doomed pool', () => {
    const root = mkdtempSync(join(tmpdir(), 'w2m-provider-missing-'));
    try {
      const missing = join(root, 'node-datachannel-provider.mjs');
      const service = new P2PWebRtcService(
        {
          provider_command: process.execPath,
          provider_args: [missing],
          provider_cwd: root,
          dsh_home: root,
          pool_factory: null,
        },
        { env: {}, providerDirs: [] },
      );
      const found = service.discoverProvider();
      assert.equal(found.ok, false);
      assert.equal(found.code, 'WEBRTC_PROVIDER_SCRIPT_MISSING');
      assert.match(found.detail, /node-datachannel-provider\.mjs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ships the patch row disabled, with no guessed identity or provider', () => {
    const row = patchRow(P2P_WEBRTC_ROW_ID);
    assert.match(row, /name: '@twinsearth\/w2m-dsh-plugin\/dsh-p2p-webrtc'/);
    assert.match(row, /disabled: true/);
    assert.match(row, /mode: 'pool'/);
    assert.match(row, /signalUrl: ''/);
    assert.match(row, /rabbitUrl: ''/);
    assert.match(row, /providerCommand: ''/);
    assert.match(row, /autoStart: false/);
    assert.equal(row.includes('peerKeys: {}'), true);
    assert.match(patch, /Production profile example/);
    assert.match(patch, /transport: 'webrtc'/);
  });

  it('mounts four tools and stays inert until start', async () => {
    const { ctx, definitions, registered, effects, routes } = fakeContext();
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
    assert.ok(routes.has(P2P_WEBRTC_REPAIR_PATH), 'the mounted row registers the repair route');

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

  it('normalizes a dual-TURN pool and redacts its URLs', () => {
    const cfg = normalizePluginConfig(
      {
        iceServers: [{ urls: ['stun:stun.example:3478'] }],
        turnServers: [
          'turn:w2m:secret-a@turn-a.example:3479',
          { urls: ['turn:w2m:secret-b@turn-b.example:3479'], weight: 2 },
        ],
        turnPolicy: 'balanced',
      },
      { dshHome: 'C:/dsh' },
    );
    assert.equal(cfg.turn_servers.length, 2);
    assert.equal(cfg.turn_policy, 'balanced');
    const described = describeConfig(cfg);
    assert.equal(JSON.stringify(described).includes('secret-a'), false);
    assert.equal(JSON.stringify(described).includes('secret-b'), false);
    assert.equal(described.turn_servers.length, 2);
    assert.equal(described.turn_servers[1].weight, 2);
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

function fakePool() {
  const peers = new Map();
  const calls = { ensure: [], close: [], stops: 0, probes: [] };
  const pool = {
    peers,
    calls,
    async ensure(peer) {
      calls.ensure.push(peer);
      if (!peers.has(peer)) {
        const transport = {
          diagnostics: () => ({ state: 'ready', path: { verdict: 'direct' }, secure: { state: 'ready' } }),
          probe: async (timeoutMs) => {
            calls.probes.push({ peer, timeoutMs });
            return { ok: true, peer, rtt_ms: 12 };
          },
        };
        peers.set(peer, { peer, transport, role: 'client', room: 'pair' });
      }
      const record = peers.get(peer);
      return { ok: true, peer, role: record.role, room: record.room, transport: record.transport };
    },
    peerStatus(peer) {
      const record = peers.get(peer);
      return record === undefined ? null : { peer, state: 'ready', role: record.role, room: record.room };
    },
    async closePeer(peer) {
      calls.close.push(peer);
      const existed = peers.delete(peer);
      return { ok: true, peer, closed: existed };
    },
    async send(peer) {
      return { ok: true, peer, fragments: 1 };
    },
    async stop() {
      calls.stops += 1;
      peers.clear();
      return { ok: true, peers: 0 };
    },
    diagnostics() {
      return {
        peer_count: peers.size,
        peers: [...peers.keys()].map((peer) => pool.peerStatus(peer)),
      };
    },
  };
  return pool;
}

function fakeRuntime({ pool = fakePool(), owner = P2P_WEBRTC_POOL_OWNER, ensureResult = null } = {}) {
  const calls = { ensure: 0, stops: 0 };
  return {
    pool,
    owner,
    calls,
    async ensure() {
      calls.ensure += 1;
      if (ensureResult !== null) return ensureResult;
      return { ok: true, reused: false, created: true, pool, owner };
    },
    status() {
      return {
        ready: pool !== null,
        owner: pool === null ? null : owner,
        machine_id: 'machine-a',
        signal_url: 'ws://signal.example/w2m/webrtc',
        device_key_present: true,
        diagnostics: pool === null ? null : pool.diagnostics(),
      };
    },
    async stop() {
      calls.stops += 1;
      const stopped = pool === null ? { ok: true, peers: 0 } : await pool.stop();
      return { ok: true, stopped: true, pool: stopped };
    },
  };
}

function poolConfig(extra = {}) {
  return {
    mode: 'pool',
    autoStart: true,
    signalUrl: 'ws://signal.example/w2m/webrtc',
    providerCommand: 'node',
    machineId: 'machine-a',
    peerMachineId: '',
    ...extra,
  };
}

describe('dsh-p2p-webrtc pool mode (v3.6.0 P2)', () => {
  it('normalizes pool mode as the autoStart default, single stays explicit', () => {
    assert.deepEqual(P2P_WEBRTC_MODES, ['pool', 'single']);
    const auto = normalizePluginConfig({ autoStart: true });
    assert.equal(auto.mode, 'pool');
    assert.equal(auto.pool_mode, true);
    const explicit = normalizePluginConfig({ autoStart: true, mode: 'single' });
    assert.equal(explicit.mode, 'single');
    const idle = normalizePluginConfig({});
    assert.equal(idle.mode, 'single');
    assert.equal(describeConfig(auto).mode, 'pool');
  });

  it('autoStart publishes the shared pool and reports owner / peers through status', async () => {
    const { ctx, definitions } = fakeContext();
    const pool = fakePool();
    const runtime = fakeRuntime({ pool });
    const dispose = await apply(ctx, poolConfig(), {
      defineTool: (definition) => definition,
      poolRuntime: runtime,
    });
    assert.equal(dispose.ok, true);
    assert.equal(runtime.calls.ensure, 1, 'autoStart must await the pool once');

    const status = json(
      await definitions.find((definition) => definition.name === 'p2p_webrtc_status').execute({}),
    );
    assert.equal(status.mode, 'pool');
    assert.equal(status.pool.ready, true);
    assert.equal(status.pool.owner, P2P_WEBRTC_POOL_OWNER);
    assert.equal(status.pool.machine_id, 'machine-a');
    assert.deepEqual(status.pool.peers, []);
    assert.equal(status.pool.diagnostics.peer_count, 0);
    assert.equal(status.last_ensure.ok, true);
  });

  it('start prepares one peer; stop closes only that peer and never stops the pool', async () => {
    const pool = fakePool();
    const service = new P2PWebRtcService(normalizePluginConfig(poolConfig()), {
      poolRuntime: fakeRuntime({ pool }),
    });
    const started = await service.start({ peer_machine_id: 'machine-b' });
    assert.equal(started.ok, true);
    assert.equal(started.peer, 'machine-b');
    assert.equal(started.pool.peer_count, 1);

    const refused = await service.stop();
    assert.equal(refused.ok, false);
    assert.equal(refused.code, P2P_WEBRTC_POOL_CODE.STOP_REFUSED);

    const closed = await service.stop({ peer_machine_id: 'machine-b' });
    assert.equal(closed.ok, true);
    assert.equal(closed.scope, 'peer');
    assert.equal(closed.closed, true);
    assert.equal(pool.calls.stops, 0, 'a peer close must not stop the pool desktop and Teams use');
    assert.deepEqual(pool.calls.close, ['machine-b']);
    assert.equal(closed.pool.peer_count, 0);

    const stopped = await service.stop({ confirm: 'pool-stop' });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.scope, 'pool');
    assert.equal(pool.calls.stops, 1);
  });

  it('dispose closes the configured peer only; the pool stays published', async () => {
    const pool = fakePool();
    const service = new P2PWebRtcService(normalizePluginConfig(poolConfig({ peerMachineId: 'machine-b' })), {
      poolRuntime: fakeRuntime({ pool }),
    });
    await service.start();
    const disposed = await service.dispose();
    assert.equal(disposed.ok, true);
    assert.equal(disposed.scope, 'peer');
    assert.deepEqual(pool.calls.close, ['machine-b']);
    assert.equal(pool.calls.stops, 0);
  });

  it('probe uses the live pair transport and refuses an unknown peer', async () => {
    const pool = fakePool();
    const service = new P2PWebRtcService(normalizePluginConfig(poolConfig()), {
      poolRuntime: fakeRuntime({ pool }),
    });
    await service.start({ peer_machine_id: 'machine-b' });
    const probed = await service.probe(250, { peer_machine_id: 'machine-b' });
    assert.equal(probed.ok, true);
    assert.equal(probed.rtt_ms, 12);
    assert.deepEqual(pool.calls.probes, [{ peer: 'machine-b', timeoutMs: 250 }]);

    const missing = await service.probe(250, { peer_machine_id: 'machine-c' });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, P2P_WEBRTC_POOL_CODE.PEER_NOT_LIVE);
  });

  it('an owner conflict is logged but does not block the mount', async () => {
    const { ctx, definitions } = fakeContext();
    const warnings = [];
    ctx.logger.warn = (message) => warnings.push(message);
    const runtime = fakeRuntime({
      pool: null,
      ensureResult: {
        ok: false,
        code: 'WEBRTC_POOL_OWNER_CONFLICT',
        detail: 'a different pool is already published',
      },
    });
    const dispose = await apply(ctx, poolConfig(), {
      defineTool: (definition) => definition,
      poolRuntime: runtime,
    });
    assert.equal(dispose.ok, true);
    assert.equal(runtime.calls.stops, 0);
    const status = json(
      await definitions.find((definition) => definition.name === 'p2p_webrtc_status').execute({}),
    );
    assert.equal(status.pool.ready, false);
    assert.equal(status.last_ensure.ok, false);
    assert.equal(status.last_ensure.code, 'WEBRTC_POOL_OWNER_CONFLICT');
    assert.equal(warnings.some((line) => line.includes('WEBRTC_POOL_OWNER_CONFLICT')), true);
  });

  it('autoStart refuses a pool without a provider and still mounts', async () => {
    const { ctx, definitions } = fakeContext();
    const warnings = [];
    ctx.logger.warn = (message) => warnings.push(message);
    const dispose = await apply(
      ctx,
      { ...poolConfig(), providerCommand: '' },
      { defineTool: (definition) => definition },
    );
    assert.equal(dispose.ok, true);    const status = json(
      await definitions.find((definition) => definition.name === 'p2p_webrtc_status').execute({}),
    );
    assert.equal(status.pool.ready, false);
    assert.equal(status.last_ensure.code, 'WEBRTC_PROVIDER_UNAVAILABLE');
    assert.equal(warnings.some((line) => line.includes('WEBRTC_PROVIDER_UNAVAILABLE')), true);
  });

  it('builds the real runtime with this row as owner and releases only on explicit pool stop', async () => {
    const registry = createWebRtcPoolRegistry();
    const pool = fakePool();
    let builds = 0;
    const service = new P2PWebRtcService(
      normalizePluginConfig(
        { mode: 'pool', autoStart: true, signalUrl: 'ws://signal.example/w2m/webrtc', providerCommand: 'node', machineId: 'machine-a' },
        { dshHome: 'C:/dsh' },
      ),
      {
        registry,
        poolFactory: () => {
          builds += 1;
          return pool;
        },
        deviceKey: DeviceKey.generate('machine-a'),
      },
    );
    const started = await service.start();
    assert.equal(started.ok, true);
    assert.equal(started.state, 'pool-ready');
    assert.equal(builds, 1);
    assert.equal(registry.state().owner, P2P_WEBRTC_POOL_OWNER);
    assert.equal(registry.state().pool, pool);

    const status = service.status();
    assert.equal(status.pool.ready, true);
    assert.equal(status.pool.owner, P2P_WEBRTC_POOL_OWNER);

    const stopped = await service.stop({ confirm: 'pool-stop' });
    assert.equal(stopped.ok, true);
    assert.equal(pool.calls.stops, 1);
    assert.equal(registry.state().ready, false);
  });

  it('stop tool refuses the whole pool without the explicit confirmation', async () => {
    const { definitions, ctx } = fakeContext();
    const pool = fakePool();
    const runtime = fakeRuntime({ pool });
    await apply(ctx, poolConfig(), { defineTool: (definition) => definition, poolRuntime: runtime });
    const stop = definitions.find((definition) => definition.name === 'p2p_webrtc_stop');
    const refused = json(await stop.execute({}));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, P2P_WEBRTC_POOL_CODE.STOP_REFUSED);
    const stopped = json(await stop.execute({ confirm: 'pool-stop' }));
    assert.equal(stopped.ok, true);
    assert.equal(pool.calls.stops, 1);
    assert.equal(runtime.calls.stops, 1);
  });
});
