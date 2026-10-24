/**
 * v1.6.8 — the panel's 更新 button: npm check + install hand-off.
 *
 * The check is pure logic (explicit versions in, decision out), which is what lets these cases pin
 * the direction that matters: only `latest > installed` is an update. A profile holding a newer or
 * equal build must not be offered a "downgrade" button, and a network failure must read as an error,
 * not as "up to date".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkNpmUpdate, decideNpmUpdate, parseNpmLatest } from '../src/plugin/npm-update.mjs';
import { readInstalledVersion, registerPluginUpdateRoutes } from '../src/plugin/update-route.mjs';

const NPM_DOC = (version) => ({ name: '@twinsearth/w2m-dsh-plugin', version, dist: { tarball: `https://registry.example/${version}.tgz` } });

function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return fn().finally(() => { globalThis.fetch = original; });
}

describe('plugin update via npm (v1.6.8)', () => {
  it('parses the npm latest document and refuses garbage', () => {
    assert.deepEqual(parseNpmLatest(NPM_DOC('1.6.9')), { ok: true, name: '@twinsearth/w2m-dsh-plugin', version: '1.6.9', tarball: 'https://registry.example/1.6.9.tgz' });
    assert.equal(parseNpmLatest({ version: 'not-a-version' }).ok, false);
    assert.equal(parseNpmLatest(null).ok, false);
  });

  it('offers an update only when npm latest is newer', () => {
    assert.equal(decideNpmUpdate({ latest: { ok: true, version: '1.6.9' }, currentVersion: '1.6.8' }).update_available, true);
    assert.equal(decideNpmUpdate({ latest: { ok: true, version: '1.6.8' }, currentVersion: '1.6.8' }).update_available, false);
    assert.equal(decideNpmUpdate({ latest: { ok: true, version: '1.6.7' }, currentVersion: '1.6.8' }).update_available, false, 'never a downgrade');
    const failed = decideNpmUpdate({ latest: { ok: false, error: 'offline' }, currentVersion: '1.6.8' });
    assert.equal(failed.ok, false);
    assert.equal(failed.update_available, false);
  });

  it('fetches npm and never throws on a network failure', async () => {
    const ok = await checkNpmUpdate({ currentVersion: '1.6.8', fetchImpl: async () => ({ ok: true, status: 200, json: async () => NPM_DOC('1.6.9') }) });
    assert.equal(ok.update_available, true);
    assert.equal(ok.latest, '1.6.9');
    const bad = await checkNpmUpdate({ currentVersion: '1.6.8', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /ECONNREFUSED/);
    const http = await checkNpmUpdate({ currentVersion: '1.6.8', fetchImpl: async () => ({ ok: false, status: 500 }) });
    assert.equal(http.ok, false);
  });

  it('reads the installed version from the profile and reports up-to-date without installing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-update-'));
    const pluginDir = join(dir, 'node_modules', '@twinsearth', 'w2m-dsh-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ version: '1.6.8' }), 'utf8');
    assert.equal(readInstalledVersion(dir), '1.6.8');

    const handlers = [];
    const ctx = { inject: (_s, cb) => cb({ connection: { fetch: { register: (route) => handlers.push(route) } } }) };
    const mounted = registerPluginUpdateRoutes(ctx, { profileDir: () => dir });
    assert.equal(mounted.mounted, true);
    const route = handlers[0];
    assert.equal(route.path, '/api/w2m/plugin-update');
    const result = await withFetch(async () => ({ ok: true, status: 200, json: async () => NPM_DOC('1.6.8') }), () => route.fetch({ method: 'GET' }));
    const body = await result.json();
    assert.equal(body.ok, true);
    assert.equal(body.update_available, false);
    assert.equal(body.current, '1.6.8');
    // POST apply with nothing newer must not install.
    const applied = await withFetch(async () => ({ ok: true, status: 200, json: async () => NPM_DOC('1.6.8') }), () => route.fetch({ method: 'POST', json: async () => ({ action: 'apply' }) }));
    const appliedBody = await applied.json();
    assert.equal(appliedBody.outcome, 'up-to-date');
    assert.equal(appliedBody.installed, false);
    assert.equal(appliedBody.restart_required, false);
  });
});
