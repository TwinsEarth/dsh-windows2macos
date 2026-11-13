/**
 * W2M decision-center route surface: the ported handlers answer through the connection registry.
 *
 * The ported Fang suite proves the store and its Agent tool. This file proves the other half the port
 * added -- `/api/w2m/decisions*` registered on the host's fetch registry, with the request/response
 * mapping the W2M client polls -- so a route that stops being registered fails here instead of in the
 * panel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/decision-center/mount.mjs';
import { DECISION_ROUTE_PREFIX } from '../src/decision-center/routes.mjs';
import { SERVICE } from '../src/decision-center/kernel.mjs';

const EXPECTED_ROUTES = [
  '',
  '/abandon',
  '/ai',
  '/ai/advise',
  '/ai/advise/stream',
  '/ai/config',
  '/ai/test',
  '/events',
  '/forks',
  '/ingest',
  '/item',
  '/producers',
  '/quota',
  '/resolve',
].map((suffix) => `${DECISION_ROUTE_PREFIX}${suffix}`);

/** Mount the center on a fake Cordis context and return what the host would see. */
function mount() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'w2m-dc-routes-'));
  process.env.DSH_HOME = dataRoot;
  const provided = new Map();
  const routes = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    inject(names, callback) {
      if (names.includes('connection')) {
        callback({ connection: { fetch: { register: (entry) => { routes.set(entry.path, entry); return () => routes.delete(entry.path); } } } });
      }
      if (names.includes('tools')) {
        callback({ get: () => ({ register: () => () => {} }) });
      }
    },
    get(name) {
      return provided.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
    },
    on() {},
  };
  apply(ctx, { dataRoot });
  const call = async (path, init) => {
    const entry = routes.get(path.split('?')[0]);
    assert.ok(entry !== undefined, `no route registered for ${path}`);
    const response = await entry.fetch(new Request(`http://127.0.0.1${path}`, init));
    return { status: response.status, body: await response.json() };
  };
  return { ctx, routes, service: provided.get(SERVICE.decisionCenter), call };
}

test('decision routes: every handler the panel polls is registered', () => {
  const { routes } = mount();
  assert.deepEqual([...routes.keys()].sort(), [...EXPECTED_ROUTES].sort());
});

test('decision routes: create, list, item, quota and resolve round-trip through HTTP', async () => {
  const { service, call } = mount();
  assert.ok(service, 'the store service is provided on the mounted context');
  const created = service.create({
    level: 'yellow',
    title: 'route smoke',
    context: 'created through the ported service',
    options: [{ value: 'ok', label: 'OK' }],
  });
  assert.equal(created.ok, true);
  const list = await call(`${DECISION_ROUTE_PREFIX}?includeArchived=1`);
  assert.equal(list.status, 200);
  assert.equal(list.body.ok, true);
  assert.ok(Array.isArray(list.body.items) && list.body.items.length === 1);
  const item = await call(`${DECISION_ROUTE_PREFIX}/item?id=${encodeURIComponent(created.ticket.id)}`);
  assert.equal(item.status, 200);
  assert.equal(item.body.ticket.title, 'route smoke');
  const quota = await call(`${DECISION_ROUTE_PREFIX}/quota`);
  assert.equal(quota.status, 200);
  const resolved = await call(`${DECISION_ROUTE_PREFIX}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: created.ticket.id, option: 'ok', by: 'test' }),
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.ok, true);
});

test('decision routes: unknown ids answer 404, not a silent success', async () => {
  const { call } = mount();
  const item = await call(`${DECISION_ROUTE_PREFIX}/item?id=dec_missing`);
  assert.equal(item.status, 404);
  assert.equal(item.body.ok, false);
  const abandon = await call(`${DECISION_ROUTE_PREFIX}/abandon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'dec_missing', by: 'test' }),
  });
  assert.equal(abandon.status, 404);
});
