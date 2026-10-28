/**
 * v1.7.9 — GPW approval/security routing, end to end at the plugin boundary:
 *
 *   - a tampered list file makes `tools/pre-execute` deny path-naming calls (fail closed),
 *   - the state route reports `tampered` and offers the reset path (folders writes answer 409),
 *   - after the operator reset the gate is back to class-C: the call is held and the operator's
 *     `allow` answers it (the same route the inline composer prompt calls),
 *   - a legacy unsigned file is migrated once at activation,
 *   - the client bundle carries the inline prompt and the fold controls (static, like other
 *     client-bundle assertions).
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

import { apply } from '../src/plugin/gpw.mjs';

const KEY = 'test-key-0123456789';
const fixtures = [];
function fixtureFile() {
  const dir = mkdtempSync(join(tmpdir(), 'gpw-tamper-'));
  fixtures.push(dir);
  return join(dir, 'gpw-folders.json');
}
after(() => {
  for (const dir of fixtures) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* locked on Windows */
    }
  }
});

/** Mount GPW behind the smallest Cordis-like context that captures its routes and listeners. */
function mount(file, options = {}) {
  const routes = new Map();
  const listeners = new Map();
  const warnings = [];
  const ctx = {
    effect: () => {},
    logger: { info: () => {}, warn: (line) => warnings.push(String(line)) },
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    inject: (_services, callback) => {
      callback({
        connection: {
          fetch: {
            register: (route) => routes.set(route.path, route),
          },
        },
      });
    },
    permissionPresets: { current: () => 'danger-full-access' },
    workingDirectory: null,
  };
  const config = { foldersFile: file, gpwMode: 'advanced' };
  if (options.key !== null) config.foldersKey = options.key ?? KEY;
  apply(ctx, config);
  return { routes, listeners, warnings };
}

let requestSeq = 0;
async function call(route, method = 'GET', body = undefined) {
  requestSeq += 1;
  const request = new Request(`http://local${route.path}?${requestSeq}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}

const execFor = (path) => ({
  agent: { session: {} },
  name: 'write',
  parameters: { path },
});

describe('GPW tampered lists fail closed (v1.7.9)', () => {
  it('denies path calls, reports tampered, refuses list writes, and recovers through reset', async () => {
    const file = fixtureFile();
    // Start from a signed file, then edit it the way an external tool would.
    writeFileSync(file, JSON.stringify({ version: 2, whitelist: [], blacklist: [], mac: 'deadbeef' }, null, 2));
    const { routes, listeners } = mount(file);
    const preExecute = listeners.get('tools/pre-execute');
    assert.equal(typeof preExecute, 'function');

    const denied = await preExecute(execFor('/data/secret/key.txt'), () => undefined);
    assert.equal(denied.kind, 'deny');
    assert.match(denied.reason, /integrity check/i);

    const stateRoute = routes.get('/api/w2m/gpw/state');
    const state = await call(stateRoute);
    assert.equal(state.status, 200);
    assert.equal(state.body.tampered, true);
    assert.match(String(state.body.tampered_reason), /modified outside GPW|integrity/i);

    const add = await call(routes.get('/api/w2m/gpw/folders'), 'POST', { action: 'add', list: 'whitelist', path: '/data' });
    assert.equal(add.status, 409, 'a locked list must not accept writes');

    const reset = await call(routes.get('/api/w2m/gpw/reset'), 'POST', { confirm: 'reset' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.tampered, false);
    // The gate is only active when at least one list has an entry (its documented "unconfigured" state).
    const allowedFolder = mkdtempSync(join(tmpdir(), 'gpw-allowed-'));
    fixtures.push(allowedFolder);
    const seeded = await call(routes.get('/api/w2m/gpw/folders'), 'POST', { action: 'add', list: 'whitelist', path: allowedFolder });
    assert.equal(seeded.status, 200);

    // After reset every path is class-C again: held, then answered by the operator route (the
    // inline composer prompt calls exactly this route).
    let nextCalls = 0;
    const pendingResult = preExecute(execFor('/data/outside/a.txt'), () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 0, 'a class-C call must not continue without an answer');
    // The listener is async: let its continuation reach the pending map before snapshotting the route.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const after = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(after.body.pending.length, 1);
    const pendingId = after.body.pending[0].id;
    const decided = await call(routes.get('/api/w2m/gpw/decide'), 'POST', { id: pendingId, decision: 'allow' });
    assert.equal(decided.status, 200);
    const outcome = await pendingResult;
    assert.equal(outcome.kind, 'allow');
  });

  it('migrates a legacy unsigned file once and signs it', async () => {
    const file = fixtureFile();
    writeFileSync(file, JSON.stringify({ whitelist: ['/legacy/data'], blacklist: [] }, null, 2), 'utf8');
    const { routes } = mount(file, { key: null });
    const state = await call(routes.get('/api/w2m/gpw/state'));
    assert.equal(state.body.tampered, false);
    assert.deepEqual(state.body.folders.whitelist, ['/legacy/data']);
    const signed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(signed.version, 2);
    assert.equal(typeof signed.mac, 'string');
  });

  it('carries the inline prompt and the fold controls in the client bundle', () => {
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    assert.ok(source.includes("id: 'w2m-gpw-prompt'"), 'the pending prompt is mounted in the composer row');
    assert.ok(source.includes('w2m-gpw-open'), 'the prompt can open the panel');
    assert.ok(source.includes('gpwMore') && source.includes('gpwFold'), 'list rows fold beyond three');
    assert.ok(source.includes('gpwAddWhiteAllow') && source.includes('gpwAddBlackDeny'), 'pending offers one-click list actions');
    assert.ok(source.includes('gpwTampered') && source.includes('gpwReset'), 'the tamper warning and reset exist');
  });
});

describe('GPW signed-list write path (v1.7.9)', () => {
  it('keeps the file read-only after an operator add', async () => {
    const file = fixtureFile();
    const { routes } = mount(file);
    // mkdtemp creates the parent; a real folder must exist for validateFolderInput.
    const folder = mkdtempSync(join(tmpdir(), 'gpw-folder-'));
    fixtures.push(folder);
    const added = await call(routes.get('/api/w2m/gpw/folders'), 'POST', { action: 'add', list: 'whitelist', path: folder });
    assert.equal(added.status, 200);
    assert.throws(() => writeFileSync(file, '{"whitelist":[],"blacklist":[]}', 'utf8'), 'a direct write must fail');
    chmodSync(file, 0o644);
  });
});
