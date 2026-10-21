/**
 * The task-board proxy behind the composer panel.
 *
 * The panel must never hold a device token, so `/api/w2m/tasks` exists only to answer `GET /v1/tasks` from the host. These tests
 * drive the registered route directly with a stub registry: they check the contract the panel depends on (methods, limit handling,
 * token use, refusal shapes) rather than the relay itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerChatRoutes, TASKS_ROUTE_PATH } from '../src/plugin/fleet-chat-route.mjs';

const relayUrl = 'http://relay.test';

/** Mount the routes on a stub connection registry and hand back the request handler for the task board. */
function mount(overrides = {}) {
  const routes = [];
  const calls = [];
  const ctx = {
    inject(_names, callback) {
      callback({ connection: { fetch: { register(route) { routes.push(route); } } } });
    },
    logger: { warn: () => {}, info: () => {} },
  };
  const deps = {
    cfg: () => ({ rabbitUrl: relayUrl, projectDir: '/tmp/project' }),
    request: async (options) => {
      calls.push(options);
      return { ok: true, status: 200, json: { protocol_version: 1, tasks: [{ task_id: 't1', status: 'waiting' }] } };
    },
    resolveToken: async () => 'tok-device',
    localIdentity: async () => ({ machine_id: 'm1', machine_name: 'win' }),
    ...overrides,
  };
  const status = registerChatRoutes(ctx, deps);
  const route = routes.find((candidate) => candidate.path === TASKS_ROUTE_PATH);
  return { status, route, routes, calls, deps };
}

const get = (path = TASKS_ROUTE_PATH) => new Request('http://host.test' + path, { method: 'GET' });

describe('the task board proxy', () => {
  it('is mounted with GET only and forwards the limit through the device token', async () => {
    const { status, route, calls } = mount();
    assert.equal(status.mounted, true);
    assert.ok(route, 'the task route was registered');
    assert.deepEqual(route.methods, ['GET']);

    const response = await route.fetch(get('/api/w2m/tasks?limit=7'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body.tasks, [{ task_id: 't1', status: 'waiting' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/v1/tasks');
    assert.deepEqual(calls[0].query, { limit: '7' });
    assert.equal(calls[0].token, 'tok-device');
    assert.equal(calls[0].rabbitUrl, relayUrl);
  });

  it('defaults the limit to 20 and caps it at 50', async () => {
    const { route, calls } = mount();
    await route.fetch(get('/api/w2m/tasks'));
    await route.fetch(get('/api/w2m/tasks?limit=9999'));
    await route.fetch(get('/api/w2m/tasks?limit=not-a-number'));
    assert.deepEqual(calls.map((call) => call.query.limit), ['20', '50', '20']);
  });

  it('answers 405 for a method it does not serve', async () => {
    const { route } = mount();
    const response = await route.fetch(new Request('http://host.test/api/w2m/tasks', { method: 'POST', body: '{}' }));
    assert.equal(response.status, 405);
    const body = await response.json();
    assert.equal(body.reason_code, 'TASKS_METHOD_NOT_ALLOWED');
  });

  it('refuses by name when the host has no relay or no paired token', async () => {
    const noRelay = mount({ cfg: () => ({ projectDir: '/tmp/project' }) });
    const relayResponse = await noRelay.route.fetch(get());
    assert.equal(relayResponse.status, 503);
    assert.equal((await relayResponse.json()).reason_code, 'TASKS_NO_RELAY');

    const unpaired = mount({ resolveToken: async () => null });
    const unpairedResponse = await unpaired.route.fetch(get());
    assert.equal(unpairedResponse.status, 503);
    assert.equal((await unpairedResponse.json()).reason_code, 'TASKS_UNPAIRED');
  });

  it('passes a relay refusal through as 502 with the relay code', async () => {
    const { route } = mount({
      request: async () => ({ ok: false, status: 401, json: { error: { code: 'UNAUTHORIZED' } } }),
    });
    const response = await route.fetch(get());
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.reason_code, 'UNAUTHORIZED');
    assert.match(body.error, /401/);
  });
});
