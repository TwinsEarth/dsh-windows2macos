import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { registerRemoteViewRoutes } from '../src/plugin/remote-view-route.mjs';
import { registerDesktop } from '../src/plugin/desktop.mjs';
import { setSharedWebRtcPool } from '../src/plugin/webrtc-pool-registry.mjs';
import { startRelayViewTarget } from '../src/agent/view/relay-target.mjs';
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

  it('uses the shared WebRTC pool by default and keeps frames off the relay', async () => {
    const { writeFileSync } = await import('node:fs');
    const h = harnessWithPool();
    writeFileSync(join(h.stateDir, 'device.json'), JSON.stringify({
      machine_id: 'viewer-1',
      rabbit_url: 'http://relay.invalid',
      device_token: 't',
    }));
    const originalFetch = globalThis.fetch;
    const relayCalls = [];
    let targetSide = null;
    globalThis.fetch = async (url, options = {}) => {
      const text = String(url);
      relayCalls.push({ url: text, method: options.method ?? 'GET', body: options.body });
      if (text.includes('/v1/remote/request')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, ttl_ms: 15000 }) };
      }
      if (text.includes('/v1/remote/ack')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, prepared: true }) };
      }
      throw new Error('unexpected relay call: ' + text);
    };
    try {
      await h.routes.get('/api/w2m/remote/config').fetch(request({ enabled: true, transport: 'webrtc' }));
      const started = await h.routes.get('/api/w2m/remote/start').fetch(request({ machine_id: 'target-1' }));
      assert.equal(started.status, 200);
      const startedBody = await started.json();
      assert.equal(startedBody.channel, 'webrtc');
      assert.equal(startedBody.encrypted, true);
      assert.equal(h.dialed, null, 'strict webrtc must not touch the legacy UDP dial');
      assert.equal(relayCalls.filter((call) => call.url.includes('/v1/remote/frame')).length, 0);

      const hello = h.sent[0];
      assert.equal(hello.type, 'view.hello');
      assert.equal(relayCalls[0].body.includes('"transport":"webrtc"'), true);
      assert.equal(relayCalls[0].body.includes('"viewer_machine_id":"viewer-1"'), true);

      const waiting = await h.routes.get('/api/w2m/remote/frame').fetch(request({}));
      assert.equal(waiting.status, 202);
      assert.equal((await waiting.json()).channel, 'webrtc');

      targetSide = createViewSide();
      const vk = targetSide.finish(hello.public_key).key;
      h.emit({
        peer: 'target-1',
        payload: JSON.stringify({ type: 'view.hello_ack', session_id: hello.session_id, public_key: targetSide.public_key }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(h.sent[1].type, 'view.request');

      h.emit({
        peer: 'target-1',
        payload: JSON.stringify({
          type: 'view.frame',
          session_id: hello.session_id,
          seq: 1,
          mime: 'image/jpeg',
          ct: sealViewFrame(vk, Buffer.alloc(4096, 9)),
        }),
      });
      const frame = await h.routes.get('/api/w2m/remote/frame').fetch(request({}));
      assert.equal(frame.status, 200);
      const frameBody = await frame.json();
      assert.equal(frameBody.channel, 'webrtc');
      assert.equal(frameBody.bytes, 4096);
      assert.equal(relayCalls.filter((call) => call.url.includes('/v1/remote/frame')).length, 0);

      const stopped = await h.routes.get('/api/w2m/remote/stop').fetch(request({}));
      assert.equal(stopped.status, 200);
      assert.equal(h.sent.some((item) => item.type === 'view.stop'), true);
      assert.equal(h.pool.closed, false, 'stop must not closePeer on a shared transport');
      assert.equal(h.listeners.size, 0, 'stop must unsubscribe the desktop listener');
    } finally {
      globalThis.fetch = originalFetch;
      await h.routes.get('/api/w2m/remote/stop').fetch(request({}));
    }
  });

  it('desktop row mounted before the pool exists still borrows the shared registry at request time', async () => {
    const { writeFileSync } = await import('node:fs');
    const routes = new Map();
    const sent = [];
    const listeners = new Set();
    const pool = {
      machineId: 'viewer-1',
      ensureStarted: false,
      closed: false,
      async ensure() { this.ensureStarted = true; return { ok: true, role: 'client' }; },
      async send(_peer, payload) { sent.push(JSON.parse(payload)); return { ok: true }; },
      onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      closePeer() { this.closed = true; },
    };
    const ctx = { inject: (_deps, callback) => callback({ connection: { fetch: { register: (route) => routes.set(route.path, route) } } }) };
    const stateDir = mkdtempSync(join(tmpdir(), 'w2m-view-registry-'));
    writeFileSync(join(stateDir, 'device.json'), JSON.stringify({
      machine_id: 'viewer-1',
      rabbit_url: 'http://relay.invalid',
      device_token: 't',
    }));
    const mounted = registerDesktop(ctx, { stateDir, p2p: null });
    assert.equal(mounted.mounted, true);
    // The root row mounts first in production; the pool arrives later from the agent's shared surface.
    setSharedWebRtcPool(pool);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.includes('/v1/remote/request')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, ttl_ms: 15000 }) };
      }
      if (text.includes('/v1/remote/ack')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, prepared: true }) };
      }
      throw new Error('unexpected relay call: ' + text);
    };
    try {
      await routes.get('/api/w2m/remote/config').fetch(request({ enabled: true, transport: 'webrtc' }));
      const started = await routes.get('/api/w2m/remote/start').fetch(request({ machine_id: 'target-1' }));
      assert.equal(started.status, 200);
      const body = await started.json();
      assert.equal(body.channel, 'webrtc');
      assert.equal(pool.ensureStarted, true);
      assert.equal(sent[0].type, 'view.hello');
      await routes.get('/api/w2m/remote/stop').fetch(request({}));
      assert.equal(pool.closed, false);
    } finally {
      globalThis.fetch = originalFetch;
      setSharedWebRtcPool(null);
      await routes.get('/api/w2m/remote/stop').fetch(request({}));
    }
  });

  it('starts the viewer half before waiting for the target ack, so two sides cannot deadlock', async () => {
    const { writeFileSync } = await import('node:fs');
    const h = harnessWithPool();
    writeFileSync(join(h.stateDir, 'device.json'), JSON.stringify({
      machine_id: 'viewer-1',
      rabbit_url: 'http://relay.invalid',
      device_token: 't',
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/remote/request')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, ttl_ms: 15000 }) };
      }
      if (String(url).includes('/v1/remote/ack')) {
        // The target cannot answer until a peer is in the room; this test fails if the viewer waits
        // for the ack before it starts its half of the pair.
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 150;
          const check = () => {
            if (h.pool.ensureStarted === true) resolve();
            else if (Date.now() > deadline) reject(new Error('viewer ensure never started'));
            else setTimeout(check, 5);
          };
          check();
        });
        return { ok: true, status: 200, json: async () => ({ ok: true, prepared: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    };
    try {
      await h.routes.get('/api/w2m/remote/config').fetch(request({ enabled: true, transport: 'webrtc' }));
      const started = await h.routes.get('/api/w2m/remote/start').fetch(request({ machine_id: 'target-1' }));
      assert.equal(started.status, 200, await started.text());
      assert.equal(h.pool.ensureStarted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to encrypted relay when the target refuses warm-up, and says why', async () => {
    const { writeFileSync } = await import('node:fs');
    const h = harnessWithPool({ ack: { ok: true, prepared: false, reason: 'WEBRTC_POOL_UNAVAILABLE' } });
    h.node.dial = async () => ({ ok: false, error: 'P2P_PUNCH_TIMEOUT' });
    writeFileSync(join(h.stateDir, 'device.json'), JSON.stringify({
      machine_id: 'viewer-1',
      rabbit_url: 'http://relay.invalid',
      device_token: 't',
    }));
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.includes('/v1/remote/request')) {
        requests += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true, ttl_ms: 15000 }) };
      }
      if (text.includes('/v1/remote/ack')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, prepared: false, reason: 'WEBRTC_POOL_UNAVAILABLE' }) };
      }
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    };
    try {
      await h.routes.get('/api/w2m/remote/config').fetch(request({ enabled: true }));
      const started = await h.routes.get('/api/w2m/remote/start').fetch(request({ machine_id: 'target-1' }));
      assert.equal(started.status, 200);
      const body = await started.json();
      assert.equal(body.channel, 'relay');
      assert.equal(body.fallback_reason, 'WEBRTC_POOL_UNAVAILABLE');
      assert.equal(body.webrtc_error, 'WEBRTC_POOL_UNAVAILABLE');
      assert.equal(requests >= 2, true, 'a relay request follows the refused warm-up');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports a named WEBRTC_UNAVAILABLE instead of silently using relay in strict mode', async () => {
    const h = harnessWithPool({ ack: { ok: true, prepared: false, reason: 'WEBRTC_PREPARE_FAILED' }, poolAvailable: false });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(h.stateDir, 'device.json'), JSON.stringify({
      machine_id: 'viewer-1',
      rabbit_url: 'http://relay.invalid',
      device_token: 't',
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/remote/request')) return { ok: true, status: 200, json: async () => ({ ok: true, ttl_ms: 15000 }) };
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    };
    try {
      await h.routes.get('/api/w2m/remote/config').fetch(request({ enabled: true, transport: 'webrtc' }));
      const started = await h.routes.get('/api/w2m/remote/start').fetch(request({ machine_id: 'target-1' }));
      assert.equal(started.status, 502);
      const body = await started.json();
      assert.equal(body.code, 'WEBRTC_UNAVAILABLE');
      assert.equal(body.detail.code, 'WEBRTC_POOL_UNAVAILABLE');
      assert.equal(h.dialed, null, 'strict mode must not fall back to UDP p2p either');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('remote-view target warm-up', () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function targetHarness({ requestBody, prepare, capture }) {
    const calls = [];
    let stopped = false;
    let requests = 0;
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body });
      if (String(url).includes('/v1/remote/request')) {
        requests += 1;
        if (requests > 1) return { ok: false, status: 404, json: async () => ({ ok: false }) };
        return { ok: true, status: 200, json: async () => requestBody };
      }
      if (String(url).includes('/v1/remote/ack')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (String(url).includes('/v1/remote/frame')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    };
    const target = startRelayViewTarget({
      rabbitUrl: 'http://relay.invalid',
      token: () => 't',
      machineId: 'target-1',
      allow: () => true,
      intervalMs: 20,
      capture: capture ?? (() => ({ ok: true, data: Buffer.alloc(1024, 3) })),
      prepareWebRtc: prepare,
      fetchImpl,
    });
    return { calls, target, stop() { if (!stopped) { stopped = true; target.stop(); } } };
  }

  it('prepares the target pool for a WebRTC intent and never starts a relay frame stream', async () => {
    const prepared = [];
    const h = targetHarness({
      requestBody: {
        ok: true,
        session_id: 's-web',
        target: 'target-1',
        viewer_public_key: createViewSide().public_key,
        viewer_machine_id: 'viewer-1',
        transport: 'webrtc',
      },
      prepare: async (viewerMachineId) => {
        prepared.push(viewerMachineId);
        return { ok: true, code: 'WEBRTC_PREPARED', pool_owner: 'dsh-p2p-webrtc' };
      },
    });
    try {
      await sleep(80);
      assert.deepEqual(prepared, ['viewer-1']);
      assert.equal(h.calls.some((call) => call.method === 'POST' && call.url.includes('/v1/remote/frame')), false);
      const ack = h.calls.find((call) => call.method === 'POST' && call.url.includes('/v1/remote/ack'));
      assert.ok(ack);
      const body = JSON.parse(ack.body);
      assert.equal(body.ok, true);
      assert.equal(body.viewer_machine_id, 'viewer-1');
      assert.equal(body.session_id, 's-web');
      assert.equal(body.pool_owner, 'dsh-p2p-webrtc');
    } finally {
      h.stop();
    }
  });

  it('sends ok:false when warm-up fails so the viewer can fall back immediately', async () => {
    const h = targetHarness({
      requestBody: {
        ok: true,
        session_id: 's-fail',
        target: 'target-1',
        viewer_public_key: createViewSide().public_key,
        viewer_machine_id: 'viewer-1',
        transport: 'webrtc',
      },
      prepare: async () => ({ ok: false, code: 'WEBRTC_POOL_UNAVAILABLE' }),
    });
    try {
      await sleep(80);
      const ack = h.calls.find((call) => call.method === 'POST' && call.url.includes('/v1/remote/ack'));
      const body = JSON.parse(ack.body);
      assert.equal(body.ok, false);
      assert.equal(body.code, 'WEBRTC_POOL_UNAVAILABLE');
      assert.equal(body.pool_owner, null);
      assert.equal(h.calls.some((call) => call.url.includes('/v1/remote/frame')), false);
    } finally {
      h.stop();
    }
  });

  it('keeps the relay frame stream for an old viewer that sends no transport', async () => {
    const h = targetHarness({
      requestBody: {
        ok: true,
        session_id: 's-old',
        target: 'target-1',
        viewer_public_key: createViewSide().public_key,
      },
    });
    try {
      await sleep(80);
      assert.equal(h.calls.some((call) => call.method === 'POST' && call.url.includes('/v1/remote/frame')), true);
    } finally {
      h.stop();
    }
  });
});

function harnessWithPool(options = {}) {
  const routes = new Map();
  const sent = [];
  const listeners = new Set();
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
  const pool = {
    machineId: 'viewer-1',
    closed: false,
    ensureStarted: false,
    async ensure() { this.ensureStarted = true; return options.poolAvailable === false ? { ok: false, code: 'WEBRTC_POOL_UNAVAILABLE' } : { ok: true, role: 'client' }; },
    async send(_peer, payload) { sent.push(JSON.parse(payload)); return { ok: true }; },
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    closePeer() { this.closed = true; },
  };
  const ctx = { inject: (_deps, callback) => callback({ connection: { fetch: { register: (route) => routes.set(route.path, route) } } }) };
  const stateDir = mkdtempSync(join(tmpdir(), 'w2m-view-webrtc-'));
  registerRemoteViewRoutes(ctx, {
    stateDir,
    p2p: { node },
    getPool: () => (options.poolAvailable === false ? null : pool),
    platform: 'linux',
    prepareTimeoutMs: 200,
    ackPollMs: 10,
    capture: async () => ({ ok: false, error: 'local capture must not run for a remote session' }),
  });
  return {
    routes,
    sent,
    listeners,
    pool,
    node,
    stateDir,
    get dialed() { return dialed; },
    get handler() { return handler; },
    emit(event) { for (const listener of listeners) listener(event); },
    ack: options.ack ?? { ok: true, prepared: true },
  };
}
