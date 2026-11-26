/**
 * 3.7.6 remote-desktop tier regressions.
 *
 * The product rule this pins: one JPEG per second, no codec, and the picture's size follows the
 * channel it travels on — 360P/540P on the relay (≤100 KiB sealed), 720P/2K/4K on P2P only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  VIEW_ENVELOPE_BYTES,
  VIEW_TIERS,
  maxBytesForChannel,
  tierForChannel,
  tierPreset,
} from '../src/agent/view/quality.mjs';
import { createViewClient, createViewTarget, VIEW_FRAME } from '../src/agent/view/frame-channel.mjs';
import { startRelayViewTarget } from '../src/agent/view/relay-target.mjs';
import { createViewSide } from '../src/agent/view/session-key.mjs';
import { createRemoteMediaBroker, DEFAULT_REMOTE_MEDIA_MAX_BYTES } from '../src/relay/remote-media.mjs';

describe('quality tiers', () => {
  it('gives the relay 360P..540P and never a wide width', () => {
    assert.deepEqual([...VIEW_TIERS.relay.widths], [960, 640]);
    assert.equal(Math.max(...VIEW_TIERS.relay.widths) <= 960, true, '540P is the relay ceiling');
    assert.equal(VIEW_TIERS.relay.maxBytes, 100 * 1024);
  });

  it('gives P2P 720P, 2K and 4K', () => {
    assert.deepEqual([...VIEW_TIERS.p2p.widths], [3840, 2560, 1280]);
    assert.equal(VIEW_TIERS.p2p.maxBytes > VIEW_TIERS.relay.maxBytes, true);
  });

  it('maps the channel, defaulting anything unknown to the tighter relay tier', () => {
    assert.equal(tierForChannel('webrtc'), 'p2p');
    assert.equal(tierForChannel('p2p'), 'p2p');
    assert.equal(tierForChannel('relay'), 'relay');
    assert.equal(tierForChannel(undefined), 'relay');
    assert.equal(tierForChannel('carrier-pigeon'), 'relay');
    assert.equal(maxBytesForChannel('webrtc'), 2 * 1024 * 1024);
  });

  it('states the relay cap on the sealed frame, so the capture budget is 28 B smaller', () => {
    assert.equal(VIEW_ENVELOPE_BYTES, 28);
    assert.equal(tierPreset('relay').maxBytes - VIEW_ENVELOPE_BYTES, 100 * 1024 - 28);
  });

  it('enforces 100 KiB exactly at the broker, overhead included', () => {
    const broker = createRemoteMediaBroker();
    assert.equal(DEFAULT_REMOTE_MEDIA_MAX_BYTES, 100 * 1024);
    broker.open('s', 'm');
    assert.equal(broker.put('s', 'm', Buffer.alloc(100 * 1024, 1)).ok, true);
    assert.equal(broker.put('s', 'm', Buffer.alloc(100 * 1024 + 1, 1)).code, 'REMOTE_MEDIA_TOO_LARGE');
  });
});

describe('the relay target captures to the relay budget', () => {
  it('passes maxBytes = 100 KiB - 28 and tier relay, and posts a sealed frame', async () => {
    const viewer = createViewSide();
    const captureCalls = [];
    const posts = [];
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === '/v1/remote/request') {
        return Response.json({ ok: true, session_id: 's-1', viewer_public_key: viewer.public_key, transport: 'relay' });
      }
      if (path === '/v1/remote/frame') {
        posts.push(JSON.parse(init.body ?? '{}'));
        return Response.json({ ok: true });
      }
      return new Response('{}', { status: 404 });
    };
    const target = startRelayViewTarget({
      rabbitUrl: 'http://relay.test',
      token: () => 'op-token',
      machineId: 'm-1',
      allow: () => true,
      intervalMs: 5,
      maxFrames: 1,
      fetchImpl,
      capture: (options) => {
        captureCalls.push(options);
        return { ok: true, mime: 'image/jpeg', data: Buffer.alloc(4096, 3), bytes: 4096 };
      },
    });
    try {
      const startedAt = Date.now();
      while (posts.length === 0 && Date.now() - startedAt < 2_000) await new Promise((resolve) => { setTimeout(resolve, 10); });
      assert.ok(posts.length >= 1, 'a frame was posted');
      assert.ok(captureCalls.length >= 1);
      assert.equal(captureCalls[0].tier, 'relay');
      assert.equal(captureCalls[0].maxBytes, 100 * 1024 - 28);
    } finally {
      target.stop();
    }
  });
});

describe('the frame channel follows the request tier', () => {
  it('switches a p2p request to the relay tier and clamps its budget', () => {
    const captured = [];
    const targetSent = [];
    let body = Buffer.alloc(4096, 2);
    const target = createViewTarget({
      allow: true,
      capture: (options) => { captured.push(options); return { ok: true, mime: 'image/jpeg', data: body, bytes: body.length }; },
      send: (frame) => targetSent.push(JSON.parse(frame)),
    });
    const clientSent = [];
    const client = createViewClient({ send: (frame) => clientSent.push(JSON.parse(frame)), onFrame: () => {} });
    client.request({ machineId: 'm-1', session: 's-tier' });
    target.handle(clientSent[0]);
    assert.equal(targetSent[0].type, VIEW_FRAME.HELLO_ACK);
    client.accept(targetSent[0]);
    assert.equal(clientSent[1].type, VIEW_FRAME.REQUEST);
    assert.equal(clientSent[1].tier, 'p2p');
    target.handle(clientSent[1]);
    assert.equal(captured[0].tier, 'p2p');
    assert.equal(captured[0].maxBytes, 2 * 1024 * 1024);

    // A viewer that fell back to the relay path names the relay tier and cannot widen the cap.
    body = Buffer.alloc(2048, 2);
    target.handle(JSON.stringify({ type: VIEW_FRAME.REQUEST, session_id: 's-tier', fps: 1, max_bytes: 2 * 1024 * 1024, tier: 'relay' }));
    assert.equal(captured[1].tier, 'relay');
    assert.equal(captured[1].maxBytes, 100 * 1024 - VIEW_ENVELOPE_BYTES);
    // An unknown tier must be read as relay, never as the tier of the previous request.
    body = Buffer.alloc(1024, 2);
    target.handle(JSON.stringify({ type: VIEW_FRAME.REQUEST, session_id: 's-tier', fps: 1, max_bytes: 2 * 1024 * 1024, tier: '8k' }));
    assert.equal(captured[2].tier, 'relay');
    assert.equal(captured[2].maxBytes, 100 * 1024 - VIEW_ENVELOPE_BYTES);
    assert.equal(target.stats().tier, 'relay');
    target.stop();
  });
});

describe('settings copy', () => {
  it('reads 已开放 when the switch is on, and no longer 已开启', () => {
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    assert.match(source, /已开放/u);
    assert.doesNotMatch(source, /enabled \? '已开启'/u);
  });
});
