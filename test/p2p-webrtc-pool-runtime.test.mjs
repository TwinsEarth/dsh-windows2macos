import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createWebRtcPoolRegistry } from '../src/plugin/webrtc-pool-registry.mjs';
import {
  POOL_RUNTIME_CODE,
  createWebRtcPoolRuntime,
  ensureWebRtcPoolRuntime,
  getWebRtcPoolRuntime,
  normalizePoolRuntimeConfig,
  resetWebRtcPoolRuntimeForTests,
} from '../src/plugin/p2p-webrtc/pool-runtime.mjs';

function makePool(name = 'pool') {
  let stopped = false;
  return {
    name,
    async send() {},
    async stop() {
      stopped = true;
    },
    diagnostics() {
      return { peers: 0, name };
    },
    get stopped() {
      return stopped;
    },
  };
}

const identity = { machine_id: 'machine-a', machine_name: 'A' };

function config(overrides = {}) {
  return {
    owner: 'dsh-p2p-webrtc',
    identity,
    signalUrl: 'ws://signal.example/ws?token=secret',
    signalToken: 'secret',
    getJson: async () => ({ public_key: 'unused' }),
    ...overrides,
  };
}

describe('WebRTC pool runtime config', () => {
  it('accepts the root snake_case shape and the Cordis camelCase shape', () => {
    const snake = normalizePoolRuntimeConfig({
      owner: 'w2m-root',
      machine_id: 'm1',
      signal_url: 'ws://signal',
      provider_command: 'engine',
      prefer_p2p: false,
      allow_relay: false,
      max_fragment_bytes: 4096,
    });
    assert.equal(snake.machine_id, 'm1');
    assert.equal(snake.signal_url, 'ws://signal');
    assert.equal(snake.provider_command, 'engine');
    assert.equal(snake.prefer_p2p, false);
    assert.equal(snake.allow_relay, false);
    assert.equal(snake.max_fragment_bytes, 4096);

    const camel = normalizePoolRuntimeConfig({
      owner: 'dsh-p2p-webrtc',
      machineId: 'm2',
      signalUrl: 'wss://signal',
      providerCommand: 'engine',
      iceServers: [{ urls: 'stun:stun.example' }],
    });
    assert.equal(camel.machine_id, 'm2');
    assert.equal(camel.signal_url, 'wss://signal');
    assert.equal(camel.provider_command, 'engine');
    assert.deepEqual(camel.ice_servers, [{ urls: 'stun:stun.example' }]);
  });

  it('flattens a nested webrtc object rather than requiring a second normalizer', () => {
    const normalized = normalizePoolRuntimeConfig({
      owner: 'w2m-root',
      webrtc: {
        signalUrl: 'ws://nested',
        providerCommand: 'nested-engine',
      },
    });
    assert.equal(normalized.signal_url, 'ws://nested');
    assert.equal(normalized.provider_command, 'nested-engine');
    assert.equal(normalized.owner, 'w2m-root');
  });
});

describe('WebRTC pool runtime ensure', () => {
  it('builds once, reports ownership, and redacts the signaling token', async () => {
    const registry = createWebRtcPoolRegistry();
    let builds = 0;
    let seenOptions = null;
    const runtime = createWebRtcPoolRuntime(config(), {
      registry,
      poolFactory: (options) => {
        builds += 1;
        seenOptions = options;
        return makePool('built');
      },
    });

    const first = await runtime.ensure();
    const second = await runtime.ensure();

    assert.equal(builds, 1);
    assert.equal(first.ok, true);
    assert.equal(first.reused, false);
    assert.equal(first.created, true);
    assert.equal(first.owner, 'dsh-p2p-webrtc');
    assert.equal(first.pool.name, 'built');
    assert.equal(second.pool, first.pool);
    assert.equal(seenOptions.machineId, 'machine-a');
    assert.equal(seenOptions.signalUrl, 'ws://signal.example/ws?token=secret');
    assert.equal(typeof seenOptions.resolvePeerKey, 'function');

    const status = runtime.status();
    assert.equal(status.ready, true);
    assert.equal(status.owner, 'dsh-p2p-webrtc');
    assert.equal(status.machine_id, 'machine-a');
    assert.equal(status.signal_url, 'ws://signal.example/ws?token=%3Credacted%3E');
    assert.equal(status.signal_token_present, true);
    assert.deepEqual(status.diagnostics, { peers: 0, name: 'built' });
  });

  it('borrows an existing process pool without building or loading a key', async () => {
    const registry = createWebRtcPoolRegistry();
    const existing = makePool('existing');
    registry.set(existing, { owner: 'dsh-p2p-webrtc' });
    let builds = 0;
    let keyLoads = 0;

    const runtime = createWebRtcPoolRuntime(
      config({
        owner: 'w2m-root',
        deviceKeyDir: '/does/not/exist',
        allowCreateDeviceKey: false,
      }),
      {
        registry,
        poolFactory: () => {
          builds += 1;
          return makePool('unexpected');
        },
        loadDeviceKey: () => {
          keyLoads += 1;
          return { key: {} };
        },
      },
    );

    const result = await runtime.ensure();
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(result.owner, 'dsh-p2p-webrtc');
    assert.equal(result.pool, existing);
    assert.equal(builds, 0, 'borrowing must not construct a second pool');
    assert.equal(keyLoads, 0, 'borrowing must not require the local key file');
  });

  it('returns a named failure when the pool factory refuses', async () => {
    const registry = createWebRtcPoolRegistry();
    const runtime = createWebRtcPoolRuntime(config(), {
      registry,
      poolFactory: () => ({ ok: false, code: 'WEBRTC_POOL_BAD_CONFIG', detail: 'engine missing' }),
    });

    const result = await runtime.ensure();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBRTC_POOL_BAD_CONFIG');
    assert.match(result.detail, /engine missing/);
    assert.equal(registry.state().ready, false);
  });

  it('refuses to build without a signal URL or a peer-key resolver', async () => {
    const noSignal = createWebRtcPoolRuntime(config({ signalUrl: '' }), {
      registry: createWebRtcPoolRegistry(),
      poolFactory: () => makePool(),
    });
    const signalResult = await noSignal.ensure();
    assert.equal(signalResult.ok, false);
    assert.equal(signalResult.code, POOL_RUNTIME_CODE.BAD_CONFIG);

    const noResolver = createWebRtcPoolRuntime(
      config({
        getJson: undefined,
        resolvePeerKey: undefined,
      }),
      {
        registry: createWebRtcPoolRegistry(),
        poolFactory: () => makePool(),
      },
    );
    const resolverResult = await noResolver.ensure();
    assert.equal(resolverResult.ok, false);
    assert.equal(resolverResult.code, POOL_RUNTIME_CODE.PEER_KEY_RESOLVER_REQUIRED);
  });

  it('reports a missing device key when creation is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-pool-runtime-'));
    const runtime = createWebRtcPoolRuntime(
      config({
        deviceKeyDir: dir,
        deviceKeyFile: '',
        allowCreateDeviceKey: false,
      }),
      {
        registry: createWebRtcPoolRegistry(),
        poolFactory: () => makePool(),
      },
    );

    const result = await runtime.ensure();
    assert.equal(result.ok, false);
    assert.equal(result.code, POOL_RUNTIME_CODE.DEVICE_KEY_UNAVAILABLE);
    assert.match(result.detail, /creation is disabled/);
  });
});

describe('WebRTC pool runtime production singleton', () => {
  it('reuses one runtime across callers without building a second pool', async () => {
    resetWebRtcPoolRuntimeForTests();
    const registry = createWebRtcPoolRegistry();
    let builds = 0;
    const factory = () => {
      builds += 1;
      return makePool('singleton');
    };

    try {
      const first = await ensureWebRtcPoolRuntime(config(), { registry, poolFactory: factory });
      const runtime = getWebRtcPoolRuntime();
      assert.ok(runtime);
      assert.equal(first.ok, true);
      assert.equal(builds, 1);

      const second = await ensureWebRtcPoolRuntime(config({ signalUrl: 'ws://second.example/ws' }), {
        registry,
        poolFactory: factory,
      });
      assert.equal(second.ok, true);
      assert.equal(second.pool, first.pool);
      assert.equal(builds, 1, 'the singleton must not rebuild on a later caller');

      const stopped = await runtime.stop();
      assert.equal(stopped.ok, true);
      assert.equal(registry.state().ready, false);
    } finally {
      resetWebRtcPoolRuntimeForTests();
    }
  });
});

describe('root w2m wiring', () => {
  it('acquires the shared pool as a consumer and never builds or stops it', () => {
    const source = readFileSync(new URL('../src/plugin/tools/shared.mjs', import.meta.url), 'utf8');
    assert.match(source, /getSharedWebRtcPool\(\)/);
    assert.doesNotMatch(source, /createWebRtcPoolRuntime/);
    assert.doesNotMatch(source, /webrtcRuntime\.stop\(\)/);
    assert.doesNotMatch(source, /setSharedWebRtcPool/);
  });
});

describe('WebRTC pool runtime teardown', () => {
  it('stops only the pool it owns and leaves a borrowed pool alive', async () => {
    const registry = createWebRtcPoolRegistry();
    const owned = makePool('owned');
    const runtime = createWebRtcPoolRuntime(config(), {
      registry,
      poolFactory: () => owned,
    });

    const ensured = await runtime.ensure();
    assert.equal(ensured.ok, true);
    assert.equal(registry.state().pool, owned);

    const stopped = await runtime.stop();
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(owned.stopped, true);
    assert.equal(registry.state().ready, false);

    const borrowed = makePool('borrowed');
    registry.set(borrowed, { owner: 'dsh-p2p-webrtc' });
    const borrower = createWebRtcPoolRuntime(config({ owner: 'w2m-root' }), { registry });
    const borrowedResult = await borrower.ensure();
    assert.equal(borrowedResult.owner, 'dsh-p2p-webrtc');

    const refused = await borrower.stop();
    assert.equal(refused.ok, false);
    assert.equal(refused.code, POOL_RUNTIME_CODE.NOT_OWNER);
    assert.equal(borrowed.stopped, false);
    assert.equal(registry.state().pool, borrowed);
  });
});
