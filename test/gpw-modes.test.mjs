/**
 * GPW dual strategy: novice is the default (blacklist-only), advanced keeps the four-colour queue.
 * The mode lives in the signed folder file and is switched through the same operator route as the lists.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { apply, DEFAULT_PROTECTED_FOLDERS } from '../src/plugin/gpw.mjs';

const fixtures = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpw-modes-'));
  fixtures.push(dir);
  return dir;
};
after(() => {
  for (const dir of fixtures) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  }
});

let seq = 0;
function mount(options = {}) {
  const routes = new Map();
  const listeners = new Map();
  const ctx = {
    effect: () => {},
    logger: { info: () => {}, warn: () => {} },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    inject: (_services, callback) => callback({ connection: { fetch: { register: (route) => routes.set(route.path, route) } } }),
    permissionPresets: { current: () => 'danger-full-access' },
    workingDirectory: null,
  };
  const config = { foldersFile: join(fixture(), 'gpw-folders.json'), foldersKey: 'test-key', ...options };
  apply(ctx, config);
  return { routes, listeners };
}
async function call(route, method = 'GET', body = undefined) {
  seq += 1;
  const request = new Request('http://local' + route.path + '?' + seq, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}
const execFor = (path) => ({ agent: { session: {} }, name: 'write', parameters: { path } });

describe('GPW novice mode (default)', () => {
  it('reports mode novice with the built-in protected folders', async () => {
    const { routes } = mount();
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(state.status, 200);
    assert.equal(state.body.mode, 'novice');
    assert.deepEqual(state.body.modes, ['novice', 'advanced']);
    assert.ok(state.body.protected_folders.includes(DEFAULT_PROTECTED_FOLDERS[0]));
    assert.ok(state.body.protected_folders.includes(DEFAULT_PROTECTED_FOLDERS[4]));
    assert.equal(state.body.pending_timeout_ms, 10_000);
  });

  it('lets a normal path through without a pending queue', async () => {
    const { routes, listeners } = mount();
    const preExecute = listeners.get('tools/pre-execute');
    const target = join(fixture(), 'notes', 'a.txt');
    const outcome = await preExecute(execFor(target), () => undefined);
    assert.equal(outcome.kind, 'allow');
    assert.match(String(outcome.reason ?? ''), /小白模式/);
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(state.body.pending.length, 0);
  });

  it('still refuses a blacklisted folder outright', async () => {
    const { routes, listeners } = mount();
    const blocked = fixture();
    const added = await call(routes.get('/api/w2m/gpw/folders'), 'POST', { action: 'add', list: 'blacklist', path: blocked });
    assert.equal(added.status, 200);
    const outcome = await listeners.get('tools/pre-execute')(execFor(join(blocked, 'x.txt')), () => undefined);
    assert.equal(outcome.kind, 'deny');
  });
});

describe('GPW advanced mode (manual)', () => {
  it('switches mode through the folders route and keeps the pending queue', async () => {
    const { routes, listeners } = mount({ gpwMode: 'advanced' });
    const switched = await call(routes.get('/api/w2m/gpw/folders'), 'POST', { action: 'set-mode', mode: 'novice' });
    assert.equal(switched.status, 200);
    const back = await call(routes.get('/api/w2m/gpw/folders'), 'POST', { action: 'set-mode', mode: 'advanced' });
    assert.equal(back.status, 200);
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(state.body.mode, 'advanced');

    const target = join(fixture(), 'outside', 'b.txt');
    const outcomePromise = listeners.get('tools/pre-execute')(execFor(target), () => undefined);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const after = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(after.body.pending.length, 1);
    const decided = await call(routes.get('/api/w2m/gpw/decide'), 'POST', { id: after.body.pending[0].id, decision: 'deny' });
    assert.equal(decided.status, 200);
    const outcome = await outcomePromise;
    assert.equal(outcome.kind, 'deny');
  });

  it('writes the selected mode into the signed folder file', async () => {
    const file = join(fixture(), 'gpw-folders.json');
    const { routes } = mount({ gpwMode: 'advanced', foldersFile: file });
    await call(routes.get('/api/w2m/gpw/folders'), 'POST', { action: 'set-mode', mode: 'advanced' });
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(stored.mode, 'advanced');
    assert.equal(stored.version, 2);
  });
});
