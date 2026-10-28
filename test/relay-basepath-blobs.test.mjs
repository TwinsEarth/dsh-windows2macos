/**
 * basePath HTTP regression for the retired data plane (task 3 of the relay backlog).
 *
 * The first version of the blob refusal compared the RAW `req.url`, before the deployment prefix
 * was stripped; under `basePath: /w2m` a request to `/w2m/v1/fleet/blobs/...` walked past the gate
 * and reached the (then still present) blob route. The gate now runs after normalisePath, and the
 * legacy handlers are deleted, so every variant below must answer 403 and leave no blob on disk.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createRelayServer } from '../src/relay/server.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const sha = 'a'.repeat(64);

async function startBasePathRelay() {
  const stateDir = mkdtempSync(join(tmpdir(), 'w2m-basepath-'));
  dirs.push(stateDir);
  const relay = createRelayServer({ logger: null, operatorToken: 'op-test', stateDir, persist: true, basePath: '/w2m' });
  await relay.listen({ host: '127.0.0.1', port: 0 });
  return { relay, stateDir };
}

async function call(relay, method, path, body) {
  // relay.url already carries the deployment prefix; requests are addressed from the origin.
  const response = await fetch(new URL(path, new URL(relay.url).origin).href, {
    method,
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/octet-stream' } }),
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, json };
}

describe('basePath: the data-plane refusal cannot be walked around', () => {
  it('refuses every blob variant under the deployment prefix', async () => {
    const { relay } = await startBasePathRelay();
    try {
      const cases = [
        ['PUT', `/w2m/v1/fleet/blobs/${sha}`, 'x'],
        ['GET', `/w2m/v1/fleet/blobs/${sha}`, undefined],
        ['POST', '/w2m/v1/fleet/blob-sessions', '{}'],
        ['GET', '/w2m/v1/fleet/blobs/latest', undefined],
        ['PUT', `/w2m/v1/fleet/x/../blobs/${sha}`, 'x'],
        ['PUT', `/w2m/v1/fleet/x/%2e%2e/blobs/${sha}`, 'x'],
      ];
      for (const [method, path, body] of cases) {
        const result = await call(relay, method, path, body);
        assert.equal(result.status, 403, method + ' ' + path + ' must be refused');
        assert.equal(result.json?.error?.code ?? result.json?.code, 'DATA_PLANE_REFUSED', method + ' ' + path + ' carries the named refusal');
      }
    } finally {
      await relay.close();
    }
  });

  it('a path outside the prefix is still a 404, not a served blob', async () => {
    const { relay } = await startBasePathRelay();
    try {
      const result = await call(relay, 'PUT', `/v1/fleet/blobs/${sha}`, 'x');
      assert.equal(result.status, 404, 'outside the base path there is no route to reach');
    } finally {
      await relay.close();
    }
  });

  it('creates no blob files on disk for any refused upload', async () => {
    const { relay, stateDir } = await startBasePathRelay();
    try {
      await call(relay, 'PUT', `/w2m/v1/fleet/blobs/${sha}`, 'x');
      await call(relay, 'POST', '/w2m/v1/fleet/blob-sessions', '{}');
      const blobs = join(stateDir, 'blobs');
      const files = existsSync(blobs) ? readdirSync(blobs, { recursive: true }).length : 0;
      assert.equal(files, 0, 'the refused writes left nothing behind');
    } finally {
      await relay.close();
    }
  });
});
