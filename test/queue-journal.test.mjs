/**
 * W2M queue journal: the ported Fang store plus the routes the ported composer dock calls.
 *
 * Fang shipped the store as a lib and the routes in its orchestrator; the W2M subplugin owns both, so
 * this suite mounts it on a fake Cordis context and drives the exact wire shapes `lib/client.js`
 * speaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

const ZSTD_READY = typeof zlib.zstdCompressSync === 'function';

import { ComposerJournal } from '../src/queue-journal/lib/composer-journal.mjs';
import {
  apply,
  QUEUE_JOURNAL_HEALTH_ROUTE,
  QUEUE_JOURNAL_ROUTE_PREFIX,
  QUEUE_JOURNAL_SERVICE,
  QUEUE_RESTORE_ROUTE_PATH,
  registerQueueJournalRoutes,
} from '../src/queue-journal/index.mjs';

function mount(config = {}, services = {}) {
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
      return provided.get(name);
    },
    provide(name, value) {
      provided.set(name, value);
    },
  };
  for (const [name, value] of Object.entries(services)) provided.set(name, value);
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

test('v3.5.7: the health route is a constant 200 that writes nothing, and an unmounted row has no route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-health-'));
  try {
    const dataDir = join(root, 'journal');
    const { routes } = mount({ dataDir });
    const health = routes.get(QUEUE_JOURNAL_HEALTH_ROUTE);
    assert.ok(health !== undefined, 'a mounted row registers its health route');
    assert.deepEqual([...health.methods], ['GET'], 'the probe is a GET only');
    const before = readdirSync(root).sort();
    const response = await health.fetch(new Request(`http://127.0.0.1${QUEUE_JOURNAL_HEALTH_ROUTE}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: true, row: 'dsh-queue-journal', mounted: true });
    assert.deepEqual(readdirSync(root).sort(), before, 'a probe creates no file and no directory');
    assert.equal(existsSync(dataDir), false, 'the probe does not create the journal directory');
    // A row that is not mounted never calls apply, so its health path has no route at all: the 404 the
    // client reads as a definitive "not mounted".
    const absent = registerQueueJournalRoutes({}, { journal: null, dataDir });
    assert.equal(absent.mounted, false);
    assert.equal(absent.reason, 'the host has no Connection service');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('queue journal: save, read back and list newest first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-'));
  const { routes, service, call } = mount({ dataDir: root });
  assert.deepEqual(
    [...routes.keys()].sort(),
    [QUEUE_JOURNAL_ROUTE_PREFIX, `${QUEUE_JOURNAL_ROUTE_PREFIX}/health`, `${QUEUE_JOURNAL_ROUTE_PREFIX}/history`, `${QUEUE_JOURNAL_ROUTE_PREFIX}/sessions`, `${QUEUE_JOURNAL_ROUTE_PREFIX}/session-log`, `${QUEUE_JOURNAL_ROUTE_PREFIX}/diagnostics`, QUEUE_RESTORE_ROUTE_PATH].sort(),
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

test('queue journal: session titles come from the host session service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-'));
  const { call } = mount({ dataDir: root }, {
    sessions: { list: () => [{ id: 'session-a', title: '部署排查' }, { id: 'session-b', title: '' }] },
  });
  const out = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/sessions`);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.deepEqual(out.body.items, [{ id: 'session-a', title: '部署排查' }, { id: 'session-b', title: '' }]);
});

test('queue journal: the display title is persisted with the record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-'));
  const { call } = mount({ dataDir: root });
  await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-titled', sessionKey: 'session-titled', draft: 'hello', queue: [], title: '部署排查' }));
  const list = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?list=1`);
  const entry = list.body.entries.find((item) => item.key === 'session-titled');
  assert.equal(entry.title, '部署排查');
});

test('queue journal: the session-log route reads human history and the last assistant reply', { skip: ZSTD_READY ? false : 'this Node has no zstd API (needs >= 22.15)' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-log-'));
  const sessionDir = join(root, 'sessions', 'workspace-a', 'session-demo');
  mkdirSync(sessionDir, { recursive: true });
  const event = (value) => `${JSON.stringify(value)}\n`;
  const payload = [
    { type: 'session/title', time: 1000, data: { title: 'DSH：房主' } },
    { type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: '人类问了一句' }], source: { kind: 'user' }, role: 'user' } },
    { type: 'assistant/message', time: 3000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '助手回复' }] } } },
  ];
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(payload.map(event).join(''), 'utf8')));
  const { call } = mount({ dataDir: join(root, 'journal'), sessionLogRoot: join(root, 'sessions') });
  const out = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/session-log?sessionId=demo`);
  assert.equal(out.status, 200);
  assert.equal(out.body.found, true);
  assert.equal(out.body.title, 'DSH：房主');
  assert.deepEqual(out.body.human.map((item) => item.text), ['人类问了一句']);
  assert.equal(out.body.assistant, '助手回复');
});

test('queue journal: heals an accidentally cleared journal from its history snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-heal-'));
  const journal = new ComposerJournal(root);
  journal.save('session-a', { draft: 'old draft', queue: [{ text: 'queued one' }], title: 'A' });
  journal.save('session-a', { draft: '', queue: [] });
  assert.equal(journal.get('session-a').draft, '');
  assert.equal(journal.recoverEmpty(), 1);
  const healed = journal.get('session-a');
  assert.equal(healed.draft, 'old draft');
  assert.equal(healed.queue.length, 1);
  // A single deliberately-cleared entry among content is NOT healed globally.
  journal.save('session-b', { draft: 'keep me', queue: [] });
  journal.save('session-a', { draft: '', queue: [] });
  assert.equal(journal.recoverEmpty(), 0);
  assert.equal(journal.get('session-a').draft, '');
});

test('queue journal: the sessions route resolves a journal session title from its log', { skip: ZSTD_READY ? false : 'this Node has no zstd API (needs >= 22.15)' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-title-'));
  const sessionDir = join(root, 'sessions', 'workspace-a', 'session-titled');
  mkdirSync(sessionDir, { recursive: true });
  const event = (value) => `${JSON.stringify(value)}\n`;
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(event({ type: 'session/title', time: 1, data: { title: 'DSH：房主' } }), 'utf8')));
  const { call } = mount({ dataDir: join(root, 'journal'), sessionLogRoot: join(root, 'sessions') });
  await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-titled', draft: 'd', queue: [], sessionKey: 'session-titled' }));
  const out = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/sessions`);
  assert.equal(out.status, 200);
  const item = (out.body.items ?? []).find((row) => row.id === 'session-titled');
  assert.equal(item?.title, 'DSH：房主');
});

test('v3.3.18: an empty sessionKey is derived from the key for legacy rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-journal-key-'));
  try {
    const file = join(dir, 'composer-journal.json');
    writeFileSync(file, JSON.stringify({ 'session-legacy-1': { key: 'session-legacy-1', draft: 'x', queue: [], sessionKey: '', title: '', updatedAt: '2026-11-15T00:00:00.000Z' }, 'page:abc': { key: 'page:abc', draft: 'y', queue: [], sessionKey: '', title: '', updatedAt: '2026-11-15T00:00:01.000Z' } }), 'utf8');
    const journal = new ComposerJournal(dir);
    const listed = journal.list();
    assert.equal(listed.find((e) => e.key === 'session-legacy-1')?.sessionKey, 'session-legacy-1');
    assert.equal(listed.find((e) => e.key === 'page:abc')?.sessionKey, '');
    const saved = journal.save('session-new-1', { draft: 'new' });
    assert.equal(saved.sessionKey, 'session-new-1', 'a new human row stores the key as sessionKey');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v3.6.0: the state directory is created on first write, not on mount', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-lazy-'));
  const dataDir = join(root, 'nested', 'queue-journal');
  try {
    const { call } = mount({ dataDir });
    assert.equal(existsSync(dataDir), false, 'mounting the subplugin must not create state');
    const list = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?list=1`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.entries, [], 'a missing file is an empty journal, not an error');
    assert.equal(Object.hasOwn(list.body, 'error'), false, 'ENOENT is not reported as an error');
    assert.equal(existsSync(dataDir), false, 'a read must not create the directory either');
    const saved = await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-lazy', draft: 'd', queue: [] }));
    assert.equal(saved.status, 200);
    assert.equal(existsSync(join(dataDir, 'composer-journal.json')), true, 'the first write creates the journal file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.0: a corrupt journal answers an empty list plus a named error and is quarantined on write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-corrupt-'));
  const dataDir = join(root, 'journal');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'composer-journal.json'), '{"session-a": ', 'utf8');
    const { call } = mount({ dataDir });
    const list = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?list=1`);
    assert.equal(list.status, 200, 'a corrupt file must never crash the route');
    assert.deepEqual(list.body.entries, []);
    assert.equal(list.body.error, 'journal-unreadable');
    const entry = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?key=session-a`);
    assert.equal(entry.status, 200);
    assert.equal(entry.body.entry, null);
    assert.equal(entry.body.error, 'journal-unreadable');
    const saved = await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-recovered', draft: 'after corruption', queue: [] }));
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'composer-journal.json'), 'utf8'))['session-recovered'].draft, 'after corruption');
    assert.ok(readdirSync(dataDir).some((name) => name.includes('.corrupt-')), 'the unreadable file is kept as a timestamped quarantine copy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.0: malformed, empty and non-object JSON bodies are refused by name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-body-'));
  try {
    const { call } = mount({ dataDir: root });
    const malformed = await call(QUEUE_JOURNAL_ROUTE_PREFIX, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'journal-body-invalid-json');
    const empty = await call(QUEUE_JOURNAL_ROUTE_PREFIX, { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'journal-body-empty');
    const array = await call(QUEUE_JOURNAL_ROUTE_PREFIX, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]' });
    assert.equal(array.status, 400);
    assert.equal(array.body.error, 'journal-body-invalid');
    const restore = await call(QUEUE_RESTORE_ROUTE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(restore.status, 400);
    assert.equal(restore.body.error, 'journal-body-invalid-json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.0: the journal bounds queue length and text sizes instead of growing without limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-caps-'));
  try {
    const { call } = mount({ dataDir: root });
    const queue = Array.from({ length: 150 }, (_, index) => ({ text: 'item-' + index, at: index }));
    const saved = await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-caps', draft: 'x'.repeat(120_000), queue, title: 't'.repeat(300) }));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.entry.queue.length, 100, 'only the newest 100 queued messages are kept');
    assert.equal(saved.body.entry.queue[0].text, 'item-50', 'the cap drops the oldest rows');
    assert.equal(saved.body.entry.draft.length, 100_000, 'the draft cap is 100k characters');
    assert.equal(saved.body.entry.title.length, 200, 'the title cap is 200 characters');
    const longItem = await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-caps', draft: '', queue: [{ text: 'y'.repeat(5_000) }] }));
    assert.equal(longItem.body.entry.queue[0].text.length, 4_000, 'one queued message is capped at 4000 characters');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.0: clearing keeps the record and archives the content in history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-clear-'));
  try {
    const { call } = mount({ dataDir: root });
    await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-clear', draft: 'unsent', queue: [{ text: 'queued' }] }));
    const cleared = await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-clear', draft: '', queue: [] }));
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.entry.draft, '');
    assert.equal(cleared.body.entry.queue.length, 0);
    const history = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/history?limit=10&sessionKey=session-clear`);
    assert.equal(history.status, 200);
    assert.ok(history.body.items.some((item) => item.draft === 'unsent' && item.queue.length === 1), 'clear-all archives before clearing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.0: the optional fang interop token gates the routes and its absence is a named 401', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-auth-'));
  const token = 'fang-token-0123456789abcdef0123456789abcdef';
  try {
    const { call } = mount({ dataDir: root, fangAuthToken: token });
    const denied = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?list=1`);
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error, 'unauthorized');
    assert.equal(denied.body.detail, 'x-fang-auth');
    const wrong = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?list=1`, { headers: { 'x-fang-auth': 'wrong-token' } });
    assert.equal(wrong.status, 401);
    const allowed = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?list=1`, { headers: { 'x-fang-auth': token } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.ok, true);
    const deniedDiagnostics = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/diagnostics`);
    assert.equal(deniedDiagnostics.status, 401, 'the diagnostics route follows the same guard');
    const allowedDiagnostics = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/diagnostics`, { headers: { 'x-fang-auth': token } });
    assert.equal(allowedDiagnostics.status, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.0: restore forwards to a live agent only, capping text and counting refusals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-restore-'));
  const sent = [];
  try {
    const { call } = mount({ dataDir: root }, {
      agents: { get: (sessionId) => (sessionId === 'session-live' ? { send: (...args) => sent.push(args) } : undefined) },
    });
    const restored = await call(QUEUE_RESTORE_ROUTE_PATH, post({
      sessionId: 'session-live',
      items: [{ text: 'z'.repeat(5_000) }, { text: '   ' }, { text: 'ok' }],
    }));
    assert.equal(restored.status, 200);
    assert.equal(restored.body.queued, 2);
    assert.equal(restored.body.failed, 1, 'an empty queued row is counted as failed, never sent');
    assert.equal(sent.length, 2);
    assert.equal(sent[0][0].content[0].text.length, 4_000, 'restore caps a message at 4000 characters');
    assert.equal(sent[1][0].content[0].text, 'ok');
    assert.equal(sent[0][2], false, 'the restored message is not treated as a steering message');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.1: the diagnostics route reports the journal directory without creating files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-diag-'));
  try {
    const { call } = mount({ dataDir: root });
    assert.equal(existsSync(root), true, 'the caller owns the temporary directory');
    const empty = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/diagnostics`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.ok, true);
    assert.equal(empty.body.dir, root);
    assert.equal(empty.body.entries, 0);
    assert.equal(empty.body.lastWriteAt, null, 'an empty directory has no last write');
    assert.equal(empty.body.writable, true);
    assert.deepEqual(empty.body.errors, []);

    const before = readdirSync(root).sort();
    await call(QUEUE_JOURNAL_ROUTE_PREFIX, post({ key: 'session-diag', draft: 'a draft', queue: [{ text: 'queued one' }] }));
    const afterWrite = readdirSync(root).sort();
    const out = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/diagnostics`);
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.dir, root);
    assert.equal(out.body.entries, 1);
    assert.equal(out.body.writable, true);
    assert.match(String(out.body.lastWriteAt), /^\d{4}-\d{2}-\d{2}T/u, 'lastWriteAt is the newest file mtime');
    assert.deepEqual(out.body.errors, []);
    assert.deepEqual(readdirSync(root).sort(), afterWrite, 'a diagnostics read leaves no probe/temp file behind');
    assert.ok(afterWrite.length > before.length, 'the save created the journal files (the read did not)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.1: a missing journal directory answers zero entries and creates nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-diag-missing-'));
  const dataDir = join(root, 'nested', 'queue-journal');
  try {
    const { call } = mount({ dataDir });
    const out = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/diagnostics`);
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.dir, dataDir);
    assert.equal(out.body.entries, 0);
    assert.equal(out.body.lastWriteAt, null);
    assert.equal(out.body.writable, true, 'the nearest existing ancestor is writable, so the first write can create the directory');
    assert.deepEqual(out.body.errors, []);
    assert.equal(existsSync(dataDir), false, 'the diagnostics read neither creates the directory nor a file');
    assert.deepEqual(readdirSync(root), [], 'nothing is created beside it either');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.1: a corrupt journal is still a 200 with its named error in the diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-diag-corrupt-'));
  const dataDir = join(root, 'journal');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'composer-journal.json'), '{"session-a": ', 'utf8');
    const { call } = mount({ dataDir });
    const out = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/diagnostics`);
    assert.equal(out.status, 200, 'a corrupt file cannot take the diagnostics route down');
    assert.equal(out.body.ok, true);
    assert.equal(out.body.entries, 0);
    assert.deepEqual(out.body.errors, ['journal-unreadable'], 'the store error is named, not swallowed');
    const list = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}?list=1`);
    assert.equal(list.status, 200, 'the list route still answers beside it');
    assert.equal(list.body.error, 'journal-unreadable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3.6.1: a regular file where the journal directory belongs is not writable and creates nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2m-qj-diag-file-'));
  try {
    const dataDir = join(root, 'not-a-dir');
    writeFileSync(dataDir, 'x', 'utf8');
    const before = readdirSync(root).sort();
    const { call } = mount({ dataDir });
    const out = await call(`${QUEUE_JOURNAL_ROUTE_PREFIX}/diagnostics`);
    assert.equal(out.status, 200);
    assert.equal(out.body.dir, dataDir);
    assert.equal(out.body.writable, false, 'a regular file cannot hold the journal');
    assert.equal(out.body.entries, 0);
    assert.deepEqual(readdirSync(root).sort(), before, 'the read-only probe creates no file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
