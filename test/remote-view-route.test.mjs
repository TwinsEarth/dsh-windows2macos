import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { registerRemoteViewRoutes } from '../src/plugin/remote-view-route.mjs';
import { createViewSide, sealViewFrame } from '../src/agent/view/session-key.mjs';

function harness() {
  const routes = new Map();
  const sent = [];
  let dialed = null;
  let handler = null;
  const node = {
    async start() { return { ok: true }; },
    async dial(machineId) {
      dialed = machineId;
      return { ok: true, channel: { encryption: { encrypted: true }, send: async (frame) => sent.push(JSON.parse(frame)), close() {} } };
    },
    on(event, fn) { if (event === 'message') handler = fn; },
    off() { handler = null; },
  };
  const ctx = { inject: (_deps, callback) => callback({ connection: { fetch: { register: (route) => routes.set(route.path, route) } } }) };
  const stateDir = mkdtempSync(join(tmpdir(), 'w2m-view-route-'));
  registerRemoteViewRoutes(ctx, { stateDir, p2p: { node }, platform: 'linux', capture: async () => ({ ok: false, error: 'local capture must not run for a remote session' }) });
  return { routes, sent, node, stateDir, get dialed() { return dialed; }, get handler() { return handler; } };
}

const request = (body, method = 'POST') => ({ method, json: async () => body });

describe('remote-view host routes', () => {
  it('mounts the remote routes under the default state directory when none is configured', () => {
    const routes = new Map();
    const ctx = { inject: (_deps, callback) => callback({ connection: { fetch: { register: (route) => routes.set(route.path, route) } } }) };
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'w2m-view-default-'));
    try {
      const status = registerRemoteViewRoutes(ctx, { stateDir: '' });
      assert.equal(status.mounted, true);
      assert.equal(status.reason, null);
      assert.ok(routes.has('/api/w2m/remote/config'));
      assert.ok(routes.has('/api/w2m/remote/start'));
      assert.ok(routes.has('/api/w2m/remote/frame'));
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });

  it('starts a P2P session, caches one frame, and stops it', async () => {
    const h = harness();
    await h.routes.get('/api/w2m/remote/config').fetch(request({ enabled: true }));
    const started = await h.routes.get('/api/w2m/remote/start').fetch(request({ machine_id: 'm-1' }));
    assert.equal(started.status, 200);
    assert.equal(h.dialed, 'm-1');
    assert.equal(h.sent[0].type, 'view.hello');
    assert.equal(h.sent[0].session_id.startsWith('view-'), true);

    const waiting = await h.routes.get('/api/w2m/remote/frame').fetch(request({}));
    assert.equal(waiting.status, 202);

    const targetSide = createViewSide();
    const vk = targetSide.finish(h.sent[0].public_key).key;
    h.handler({ payload: JSON.stringify({ type: 'view.hello_ack', session_id: h.sent[0].session_id, public_key: targetSide.public_key }) });
    assert.equal(h.sent[1].type, 'view.request');
    h.handler({ payload: JSON.stringify({ type: 'view.frame', session_id: h.sent[0].session_id, seq: 1, mime: 'image/jpeg', ct: sealViewFrame(vk, Buffer.alloc(2048, 1)) }) });
    const frame = await h.routes.get('/api/w2m/remote/frame').fetch(request({}));
    assert.equal(frame.status, 200);
    const body = await frame.json();
    assert.equal(body.ok, true);
    assert.equal(body.bytes, 2048);
    assert.equal(body.encrypted, true);

    const stopped = await h.routes.get('/api/w2m/remote/stop').fetch(request({}));
    assert.equal(stopped.status, 200);
    assert.equal(h.sent.some((frame) => frame.type === 'view.stop'), true);
  });

  it('reports P2P_UNAVAILABLE instead of falling back to local capture', async () => {
    const h = harness();
    await h.routes.get('/api/w2m/remote/config').fetch(request({ enabled: true }));
    h.node.dial = async () => ({ ok: false, error: 'P2P_PUNCH_TIMEOUT' });
    const started = await h.routes.get('/api/w2m/remote/start').fetch(request({ machine_id: 'm-2' }));
    assert.equal(started.status, 502);
    const body = await started.json();
    assert.equal(body.code, 'P2P_UNAVAILABLE');
  });

  it('fetches a fresh relay frame on each 1 Hz viewer poll', async () => {
    const h = harness();
    h.node.dial = async () => ({ ok: false, error: 'P2P_PUNCH_TIMEOUT' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(h.stateDir, 'device.json'), JSON.stringify({ rabbit_url: 'http://relay.invalid', device_token: 't' }));
    const originalFetch = globalThis.fetch;
    const targetSide = createViewSide();
    let viewerKey = null;
    let targetKey = null;
    let frameSeq = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('/v1/remote/request')) {
        viewerKey = JSON.parse(options.body).viewer_public_key;
        return { ok: true, status: 200, json: async () => ({ ok: true, ttl_ms: 15000 }) };
      }
      if (String(url).includes('/v1/remote/frame')) {
        targetKey ??= targetSide.finish(viewerKey).key;
        frameSeq += 1;
        const plaintext = Buffer.alloc(2048, frameSeq);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ct: sealViewFrame(targetKey, plaintext), public_key: targetSide.public_key }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    };
    try {
      await h.routes.get('/api/w2m/remote/config').fetch(request({ enabled: true }));
      const started = await h.routes.get('/api/w2m/remote/start').fetch(request({ machine_id: 'm-relay' }));
      assert.equal(started.status, 200);
      const first = await h.routes.get('/api/w2m/remote/frame').fetch(request({}));
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      await new Promise((resolve) => setTimeout(resolve, 950));
      const second = await h.routes.get('/api/w2m/remote/frame').fetch(request({}));
      const secondBody = await second.json();
      assert.equal(second.status, 200);
      assert.notEqual(secondBody.data_base64, firstBody.data_base64, 'the second poll carries a new frame');
    } finally {
      globalThis.fetch = originalFetch;
      await h.routes.get('/api/w2m/remote/stop').fetch(request({}));
    }
  });
});
