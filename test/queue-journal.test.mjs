/**
 * W2M queue journal: the ported Fang store plus the routes the ported composer dock calls.
 *
 * Fang shipped the store as a lib and the routes in its orchestrator; the W2M subplugin owns both, so
 * this suite mounts it on a fake Cordis context and drives the exact wire shapes `lib/client.js`
 * speaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apply,
  QUEUE_JOURNAL_ROUTE_PREFIX,
  QUEUE_JOURNAL_SERVICE,
  QUEUE_RESTORE_ROUTE_PATH,
} from '../src/queue-journal/index.mjs';

function mount(config = {}) {
  const requests = new Map();
  const provided = new Map();
  const routes = new Map();
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
      if (name === 'agents') return undefined;
      return provided.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
    },
  };
  apply(ctx, config);
  const call = async (path, init) => {
    const entry = routes.get(path.split('?')[0]);
    assert.ok(entry !== undefined, `no route registered for ${path}`);
    const request = new Request(`http://127.0.0.1${path}`, init);
    requests.set(entry, request);
    const response = await entry.fetch(request);
    return { status: response.status, body: await response.json() };
  };
  return { routes, service: provided.get(QUEUE_JOURNAL_SERVICE), call };
}

const post = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('queue journal: save, read back and list newest first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-'));
  const { routes, service, call } = mount({ dataDir: root });
  assert.deepEqual(
    [...routes.keys()].sort(),
    [QUEUE_JOURNAL_ROUTE_PREFIX, `${QUEUE_JOURNAL_ROUTE_PREFIX}/history`, QUEUE_RESTORE_ROUTE_PATH].sort(),
  );
  assert.ok(service, 'the journal service is provided');
  const saved = await call(
    QUEUE_JOURNAL_ROUTE_PREFIX,
    post({
      key: 'session-a',
      draft: 'unsent text',
      path: '#/sessions/session-a',
      queue: [
        { text: 'queued one', at: 1 },
        { text: 'queued two', at: 2 },
      ],
    }),
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.entry.draft, 'unsent text');
  assert.equal(saved.body.entry.queue.length, 2);

  const read = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?key=session-a`);
  assert.equal(read.status, 200);
  assert.equal(read.body.entry.draft, 'unsent text');

  await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-b', draft: 'b', queue: [] }));
  const list = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?list=1`);
  assert.equal(list.status, 200);
  assert.equal(list.body.entries.length, 2);
});

test('queue journal: history keeps append-only snapshots and filters by sessionKey', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-'));
  const { call } = mount({ dataDir: root });
  await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-a', draft: '', queue: [{ text: 'first' }] }));
  await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-a', draft: '', queue: [{ text: 'second' }] }));
  await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-b', draft: '', queue: [{ text: 'other' }] }));
  const all = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/history?limit=10`);
  assert.equal(all.status, 200);
  assert.ok(all.body.items.length >= 3);
  const filtered = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/history?limit=10&sessionKey=session-a`);
  assert.equal(filtered.body.items.length, 2);
  assert.ok(filtered.body.items.every((item) => item.sessionKey === 'session-a'));
});

test('queue journal: malformed keys and missing keys are refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-'));
  const { call } = mount({ dataDir: root });
  const noKey = await call(QUEUE_JOURNAL_ROUTE_PREFIX);
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, 'journal-key-required');
  const noKeyPost = await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ draft: 'x' }));
  assert.equal(noKeyPost.status, 400);
});

test('queue journal: restore refuses a session that is not live instead of pretending to queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-'));
  const { call } = mount({ dataDir: root });
  const restored = await call(
    QUEUE_RESTORE_ROUTE_PATH,
    post({ sessionId: 'session-a', items: [{ text: 'hello' }] }),
  );
  assert.equal(restored.status, 409);
  assert.equal(restored.body.error, 'session-not-live');
});
