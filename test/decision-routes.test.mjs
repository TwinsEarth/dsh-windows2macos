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
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/decision-center/mount.mjs';
import { DECISION_HEALTH_ROUTE, DECISION_ROUTE_PREFIX, registerDecisionCenterRoutes } from '../src/decision-center/routes.mjs';
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
  '/health',
  '/humanize-options',
  '/ingest',
  '/item',
  '/producers',
  '/quota',
  '/resolve',
  '/session-titles',
].map((suffix) => `${DECISION_ROUTE_PREFIX}${suffix}`);

/** Mount the center on a fake Cordis context and return what the host would see. */
function mount(options = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'w2m-dc-routes-'));
  process.env.DSH_HOME = dataRoot;
  const services = options.services ?? {};
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
      if (names.includes('tools')) {
        callback({ get: () => ({ register: () => () => {} }) });
      }
    },
    get(name) {
      return provided.has(name) ? provided.get(name) : services[name];
    },
    provide(name, value) {
      provided.set(name, value);
    },
    on() {},
  };
  apply(ctx, { dataRoot, ...(options.config ?? {}) });
  const call = async (path, init) => {
    const entry = routes.get(path.split('?')[0]);
    assert.ok(entry !== undefined, `no route registered for ${path}`);
    const response = await entry.fetch(new Request(`http://127.0.0.1${path}`, init));
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { ctx, routes, service: provided.get(SERVICE.decisionCenter), call, dataRoot };
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

test('decision routes: session titles resolve read-only and unresolved ids answer null, never the id', async () => {
  // A sync `list()` is the shape the resolver probes; an async one is awaited by the route.
  const { service, call } = mount({ services: { sessions: { list: () => [{ id: 'sess-dc-1', title: '修复队列并发' }] } } });
  const created = service.create({
    level: 'yellow',
    title: 'title route',
    context: 'x',
    options: [{ value: 'ok', label: 'OK' }],
    source: { sessionId: 'sess-dc-1', agentRole: 'worker' },
  });
  assert.equal(created.ok, true);
  const titles = await call(`${DECISION_ROUTE_PREFIX}/session-titles?ids=sess-dc-1,sess-missing`);
  assert.equal(titles.status, 200);
  assert.deepEqual(titles.body.titles, { 'sess-dc-1': '修复队列并发', 'sess-missing': null });
  // The list route enriches the same title on read; the raw id is not the title.
  const list = await call(`${DECISION_ROUTE_PREFIX}?includeArchived=1`);
  assert.equal(list.body.items[0].source.sessionTitle, '修复队列并发');
  assert.notEqual(list.body.items[0].source.sessionTitle, 'sess-dc-1');
});

test('decision routes: manual option humanization is rules-complete, rate-limited and refuses unknown ids', async () => {
  const { service, call } = mount({ config: { optionHumanize: 'rules-only' } });
  const created = service.create({
    level: 'yellow',
    title: 'humanize route',
    context: 'x',
    options: [{
      value: 'fix',
      label: '1. **是否继续**修复队列里的并发问题，并且把测试补齐呢？',
    }],
  });
  const ticketId = created.ticket.id;
  const post = (body) => call(`${DECISION_ROUTE_PREFIX}/humanize-options`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const once = await post({ id: ticketId, by: 'test' });
  assert.equal(once.status, 200);
  assert.equal(once.body.ok, true);
  assert.equal(once.body.mode, 'rules');
  const option = once.body.ticket.options[0];
  assert.equal(option.value, 'fix', 'the option value is never rewritten');
  assert.notEqual(option.label, option.rawLabel);
  assert.ok(option.label.endsWith('…'), `the label is shortened: ${option.label}`);
  assert.equal(option.rawLabel, '1. **是否继续**修复队列里的并发问题，并且把测试补齐呢？');
  assert.equal(once.body.ticket.optionsHumanized.mode, 'rules');

  assert.equal((await post({})).status, 400, 'an id is required');
  assert.equal((await post({ id: 'dec_missing' })).status, 404);

  // The limiter is 6/minute per ticket: the seventh call answers 429 with Retry-After.
  // The limiter is 6/minute per ticket; once the window is full the route answers 429 + Retry-After.
  let limited = null;
  for (let attempt = 0; attempt < 8 && limited === null; attempt += 1) {
    const response = await post({ id: ticketId, by: 'test' });
    if (response.status === 429) limited = response;
  }
  assert.ok(limited !== null, 'repeated manual runs are rate-limited');
  assert.equal(limited.body.reason, 'option-humanize-rate-limited');
  assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
});

test('decision routes: the manual humanize route refuses when AI is neither configured nor permitted', async () => {
  const { service, call } = mount({ config: { optionHumanize: 'auto' } });
  const created = service.create({
    level: 'yellow',
    title: 'no ai',
    context: 'x',
    options: [{ value: 'a', label: '一个足够长、长到规则 pass 必须截断的选项文字，用来触发人化' }],
  });
  const response = await call(`${DECISION_ROUTE_PREFIX}/humanize-options`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: created.ticket.id, by: 'test' }),
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.reason, 'ai-not-configured');
  assert.equal(response.body.mode, 'rules', 'the rules result is already on the ticket');
  assert.equal(response.body.ticket.optionsHumanized.mode, 'rules');
});

test('decision routes: the exact-route registry sees one static humanize path (a /<id>/ segment cannot be registered)', () => {
  const { routes } = mount();
  const humanize = routes.get(`${DECISION_ROUTE_PREFIX}/humanize-options`);
  assert.ok(humanize !== undefined);
  assert.deepEqual([...humanize.methods], ['POST'], 'the manual route is POST-only; it is not a GET convenience');
  assert.equal(routes.has(`${DECISION_ROUTE_PREFIX}/dec_x/humanize-options`), false);
  const titles = routes.get(`${DECISION_ROUTE_PREFIX}/session-titles`);
  assert.deepEqual([...titles.methods], ['GET']);
});

test('decision routes: the health route is a constant 200 that reads nothing, and an unmounted row registers none', async () => {
  const { routes, call, dataRoot } = mount();
  const health = routes.get(DECISION_HEALTH_ROUTE);
  assert.ok(health !== undefined, 'a mounted row registers its health route');
  assert.deepEqual([...health.methods], ['GET'], 'the probe is a GET only');
  const before = readdirSync(dataRoot, { recursive: true }).map(String).sort();
  const answer = await call(DECISION_HEALTH_ROUTE);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.deepEqual(answer.body, { ok: true, row: 'dsh-decision-center', mounted: true });
  assert.deepEqual(
    readdirSync(dataRoot, { recursive: true }).map(String).sort(),
    before,
    'a probe must not create state: it reads no store and writes nothing',
  );
  // A row that is not mounted never calls apply, so its health path has no route at all: the 404 the client
  // reads as a definitive "not mounted".
  const absent = registerDecisionCenterRoutes({});
  assert.equal(absent.mounted, false);
  assert.equal(absent.reason, 'the host has no Connection service');
});
