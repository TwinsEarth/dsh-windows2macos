/**
 * W2M 互联契约层：方法表、信封、服务端、HTTP 路由，以及 SDK 的四级传输降级。
 *
 * 这些测试不碰 dsh-fang / dsh-master 的代码：对端行为用最小的服务/HTTP/file 桩模拟，验证的是
 * w2m 这一侧按契约 SDK 说话——这正是三个项目“只经由契约互联”的边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONTRACT_ROUTE_PREFIX,
  W2M_CONTRACT_SERVICE,
  W2M_METHODS,
  apply,
  createW2mContractClient,
  createW2mContractServer,
  registerContractRoutes,
} from '../src/interop/index.mjs';
import { createEnvelope, startFileContractServer } from '../src/interop/contract/index.js';

const envelopeOf = (method, params = null) => createEnvelope({ method, params, source: 'test' });

function mountedCtx() {
  const routes = new Map();
  const provided = new Map();
  const ctx = {
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    inject(names, callback) {
      if (names.includes('connection')) {
        callback({
          connection: {
            fetch: {
              register: (entry) => {
                routes.set(entry.path, entry);
                return () => routes.delete(entry.path);
              },
            },
          },
        });
      }
    },
    get(name) {
      return provided.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
    },
  };
  return { ctx, routes, provided };
}

test('contract server: hello advertises the w2m methods next to the protocol methods', () => {
  const { server } = createW2mContractServer({ instanceId: 'w2m-test' });
  const hello = server.hello();
  assert.equal(hello.protocol, 'fang-master');
  assert.equal(hello.contractVersion, '1.0.0');
  assert.equal(hello.role, 'essence', 'the SDK role vocabulary has no w2m value; essence is the peer role');
  assert.equal(hello.instanceId, 'w2m-test');
  for (const method of [W2M_METHODS.STATUS, W2M_METHODS.METHODS, W2M_METHODS.DEVICES_LIST]) {
    assert.ok(hello.methods.includes(method), `${method} is advertised`);
  }
  assert.ok(hello.methods.includes('contract.hello'));
  assert.ok(hello.methods.includes('contract.health'));
});

test('contract server: envelope round-trip answers w2m.status and refuses unknowns explicitly', async () => {
  const { server } = createW2mContractServer({ instanceId: 'w2m-test' });
  const ok = await server.invoke(envelopeOf(W2M_METHODS.STATUS));
  assert.equal(ok.ok, true);
  assert.equal(ok.result.plugin, 'w2m');
  assert.equal(ok.result.contractVersion, '1.0.0');
  assert.equal(ok.result.sdkVersion, '1.1.1');

  const unknown = await server.invoke(envelopeOf('w2m.nope'));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'unsupported-method');

  const invalid = await server.invoke({
    protocol: 'other',
    protocolVersion: 9,
    id: 'x',
    method: 'w2m.status',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'invalid-envelope');
});

test('contract server: provider-injected methods answer, missing providers report service-absent', async () => {
  const { server } = createW2mContractServer({
    providers: {
      devices: async () => ({ items: [{ machineId: 'm-1' }] }),
      tasks: async () => ({ items: [] }),
    },
  });
  const devices = await server.invoke(envelopeOf(W2M_METHODS.DEVICES_LIST));
  assert.equal(devices.ok, true);
  assert.equal(devices.result.items.length, 1);
  const tasks = await server.invoke(envelopeOf(W2M_METHODS.TASKS_LIST));
  assert.equal(tasks.ok, true);
  const snapshot = await server.invoke(envelopeOf(W2M_METHODS.FLEET_SNAPSHOT));
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.error.message, /exposes no fleetSnapshot provider/);
});

test('contract routes: hello / health / invoke are registered on the connection registry', async () => {
  const { server } = createW2mContractServer({ instanceId: 'w2m-test' });
  const { ctx, routes } = mountedCtx();
  const status = registerContractRoutes(ctx, { server });
  assert.equal(status.mounted, true);
  assert.deepEqual(
    [...routes.keys()].sort(),
    [
      `${CONTRACT_ROUTE_PREFIX}/health`,
      `${CONTRACT_ROUTE_PREFIX}/hello`,
      `${CONTRACT_ROUTE_PREFIX}/invoke`,
    ].sort(),
  );
  const hello = await routes
    .get(`${CONTRACT_ROUTE_PREFIX}/hello`)
    .fetch(new Request(`http://127.0.0.1${CONTRACT_ROUTE_PREFIX}/hello`));
  assert.equal(hello.status, 200);
  assert.equal((await hello.json()).contractVersion, '1.0.0');
  const invoked = await routes.get(`${CONTRACT_ROUTE_PREFIX}/invoke`).fetch(
    new Request(`http://127.0.0.1${CONTRACT_ROUTE_PREFIX}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelopeOf(W2M_METHODS.STATUS)),
    }),
  );
  const body = await invoked.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.plugin, 'w2m');
});

test('contract apply: provides w2mContract and yields the fangContract name only when it is free', () => {
  const free = mountedCtx();
  apply(free.ctx, {});
  assert.ok(free.provided.get(W2M_CONTRACT_SERVICE), 'w2mContract is provided');
  assert.ok(free.provided.get('fangContract'), 'fangContract is provided when absent');

  const taken = mountedCtx();
  const fangServer = { hello: () => ({}), invoke: async () => ({}) };
  taken.provided.set('fangContract', fangServer);
  apply(taken.ctx, {});
  assert.equal(taken.provided.get('fangContract'), fangServer, 'an existing fangContract is not replaced');
});

test('contract client: local transport reaches the same-host contract service', async () => {
  const { server } = createW2mContractServer({ instanceId: 'w2m-peer' });
  const ctx = { get: (name) => (name === 'fangContract' ? server : undefined) };
  const client = createW2mContractClient({ ctx });
  const result = await client.status();
  assert.equal(result.ok, true);
  assert.equal(result.transport, 'local');
  assert.equal(result.response.result.instanceId, 'w2m-peer');
  assert.equal(result.response.result.plugin, 'w2m');
});

test('contract client: degrades to http when the local service is absent', async () => {
  const { server } = createW2mContractServer({ instanceId: 'w2m-http' });
  const fetchImpl = async (url, init) => {
    const request = new Request(url, init);
    assert.equal(new URL(url).pathname, `${CONTRACT_ROUTE_PREFIX}/invoke`);
    return Response.json(await server.invoke(await request.json()));
  };
  const client = createW2mContractClient({
    config: { httpBaseUrl: 'http://127.0.0.1:9', pathPrefix: CONTRACT_ROUTE_PREFIX },
    fetchImpl,
  });
  const result = await client.status();
  assert.equal(result.ok, true);
  assert.equal(result.transport, 'http');
  assert.equal(result.response.result.instanceId, 'w2m-http');
});

test('contract client: degrades to the file transport, and to legacy as the last resort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-contract-file-'));
  const { server } = createW2mContractServer({ instanceId: 'w2m-file' });
  const fileServer = startFileContractServer({ dir, server, pollMs: 20 });
  try {
    const fileClient = createW2mContractClient({
      config: { fileDir: dir, filePollMs: 20, fileTimeoutMs: 5_000 },
    });
    const viaFile = await fileClient.status();
    assert.equal(viaFile.ok, true);
    assert.equal(viaFile.transport, 'file');
    assert.equal(viaFile.response.result.instanceId, 'w2m-file');
  } finally {
    fileServer?.close?.();
  }

  const forkSpawned = [];
  const legacyCtx = {
    get: (name) =>
      name === 'fangForker'
        ? {
            spawn: async () => {
              forkSpawned.push(true);
              return { ok: true, forkId: 'f-1' };
            },
          }
        : undefined,
  };
  const legacyClient = createW2mContractClient({ ctx: legacyCtx });
  const spawned = await legacyClient.invoke('fang.fork.spawn', { essence: 'chef' });
  assert.equal(spawned.ok, true);
  assert.equal(spawned.transport, 'legacy');
  assert.equal(spawned.response.result.forkId, 'f-1');
  assert.equal(forkSpawned.length, 1);
});

test('contract vendor: the shipped SDK copy matches PROVENANCE.md byte for byte', () => {
  const vendorDir = join(import.meta.dirname, '..', 'src', 'interop', 'contract');
  const provenance = readFileSync(join(vendorDir, 'PROVENANCE.md'), 'utf8');
  const recorded = new Map();
  for (const line of provenance.split('\n')) {
    const match = /^\| ([A-Za-z0-9_.-]+) \| (\d+) \| ([0-9a-f]{64}) \|$/.exec(line);
    if (match !== null) recorded.set(match[1], { bytes: Number(match[2]), sha256: match[3] });
  }
  assert.ok(recorded.size >= 8, 'the provenance table lists the SDK files');
  for (const [name, expected] of recorded) {
    const bytes = readFileSync(join(vendorDir, name));
    assert.equal(bytes.length, expected.bytes, `${name}: recorded byte count`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      expected.sha256,
      `${name}: recorded sha256`,
    );
  }
});
