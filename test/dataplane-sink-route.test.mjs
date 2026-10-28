/**
 * A3/S4: the data-plane sink authorization route.
 *
 * Authorization is a local user action through this host route; a tool call can never reach it, and
 * the stored file contains references only (no credentials).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { registerDataplaneSinkRoute } from '../src/plugin/dataplane-sink-route.mjs';

function mount(stateDir) {
  let handler = null;
  const ctx = {
    inject(_services, callback) {
      callback({ connection: { fetch: { register(spec) { handler = spec.fetch; } } } });
    },
  };
  const status = registerDataplaneSinkRoute(ctx, { stateDir: () => stateDir });
  assert.equal(status.mounted, true, status.reason);
  return handler;
}

const call = (handler, method, body) => handler({ method, json: async () => body });

describe('dataplane sink route', () => {
  it('reports unconfigured, then stores a dir authorization at 0600', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-sink-state-'));
    const root = mkdtempSync(join(tmpdir(), 'w2m-sink-root-'));
    const handler = mount(stateDir);
    const before = await (await call(handler, 'GET')).json();
    assert.equal(before.ok, true);
    assert.equal(before.configured, false);

    const saved = await call(handler, 'POST', { kind: 'dir', root });
    const savedBody = await saved.json();
    assert.equal(savedBody.ok, true, JSON.stringify(savedBody));
    assert.equal(savedBody.configured, true);
    assert.equal(savedBody.kind, 'dir');

    const file = join(stateDir, 'dataplane', 'sink.json');
    assert.equal(existsSync(file), true);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(config.kind, 'dir');
    assert.equal(config.approved_by, 'local-user');
    assert.equal(config.root, root);
    // No credential field can be present.
    assert.equal(JSON.stringify(config).includes('password'), false);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it('refuses unknown kinds, relative roots, roots inside the state dir, and credentials', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-sink-state-'));
    const handler = mount(stateDir);
    const cases = [
      [{ kind: 'ftp', root: tmpdir() }, 'SINK_KIND_INVALID'],
      [{ kind: 'dir', root: 'relative/path' }, 'SINK_ROOT_INVALID'],
      [{ kind: 'dir', root: join(stateDir, 'inside') }, 'SINK_ROOT_NOT_FOUND'],
      [{ kind: 'dir', root: tmpdir(), password: 'x' }, 'SINK_CREDENTIALS_NOT_ACCEPTED'],
      [{ kind: 'dir', root: join(tmpdir(), 'does-not-exist-' + Date.now()) }, 'SINK_ROOT_NOT_FOUND'],
    ];
    for (const [body, code] of cases) {
      const response = await call(handler, 'POST', body);
      assert.equal(response.status, 400, code);
      assert.equal((await response.json()).code, code);
    }
  });

  it('stores ssh as references only and echoes them back on GET', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-sink-ssh-'));
    const handler = mount(stateDir);
    const saved = await call(handler, 'POST', { kind: 'ssh', host: 'build.example', user: 'w2m', dir: '/srv/artifacts', port: 2222 });
    const body = await saved.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.host, 'build.example');
    assert.equal(body.port, 2222);
    const status = await (await call(handler, 'GET')).json();
    assert.equal(status.configured, true);
    assert.equal(status.user, 'w2m');
    assert.equal(status.dir, '/srv/artifacts');
    const config = JSON.parse(readFileSync(join(stateDir, 'dataplane', 'sink.json'), 'utf8'));
    assert.equal(Object.keys(config).some((key) => /password|token|secret|key/i.test(key)), false);
  });
});
