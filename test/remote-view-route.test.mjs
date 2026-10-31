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
});
