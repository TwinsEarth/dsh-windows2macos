/** S0-1: the settings route writes the operator token to a 0600 file and only ever reports a fingerprint. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { registerOperatorTokenRoute } from '../src/plugin/operator-token-route.mjs';

const TOKEN = 'op-token-0123456789abcdef';

function mount(path) {
  let entry = null;
  const ctx = {
    inject: (names, callback) => callback({ connection: { fetch: { register: (candidate) => { entry = candidate; } } } }),
  };
  const status = registerOperatorTokenRoute(ctx, { path: () => path });
  return { status, entry };
}

describe('operator token route', () => {
  it('reports not-configured before anything is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-token-route-'));
    const { status, entry } = mount(join(dir, 'operator-token'));
    assert.equal(status.mounted, true);
    const response = await entry.fetch(new Request('http://host/api/w2m/operator-token'));
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.configured, false);
    assert.equal(body.fingerprint, null);
  });

  it('writes the token and answers with a fingerprint, never the value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-token-route-'));
    const path = join(dir, 'operator-token');
    const { entry } = mount(path);
    const post = await entry.fetch(new Request('http://host/api/w2m/operator-token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
    }));
    const body = await post.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.configured, true);
    assert.equal(body.source, 'file');
    assert.match(body.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(JSON.stringify(body).includes(TOKEN), false, 'the token must never be echoed');
    assert.equal(readFileSync(path, 'utf8').trim(), TOKEN);
    const get = await entry.fetch(new Request('http://host/api/w2m/operator-token'));
    const status = await get.json();
    assert.equal(status.configured, true);
    assert.equal(status.fingerprint, body.fingerprint);
  });

  it('refuses an empty token without touching the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-token-route-'));
    const path = join(dir, 'operator-token');
    const { entry } = mount(path);
    const post = await entry.fetch(new Request('http://host/api/w2m/operator-token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '   ' }),
    }));
    assert.equal(post.status, 400);
    const body = await post.json();
    assert.equal(body.ok, false);
    assert.equal(existsSync(path), false);
  });

  it('refuses a token shorter than the minimum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-token-route-'));
    const { entry } = mount(join(dir, 'operator-token'));
    const post = await entry.fetch(new Request('http://host/api/w2m/operator-token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'short' }),
    }));
    assert.equal(post.status, 400);
    assert.equal((await post.json()).code, 'OPERATOR_TOKEN_TOO_SHORT');
  });
});
