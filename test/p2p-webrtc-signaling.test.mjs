/**
 * Real WebSocket signaling: a real HTTP upgrade server, real RFC 6455 framing and real
 * `SignalingClient` sockets. No stub server, no fake message queue.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSignalingServer } from '../src/agent/webrtc/signaling-server.mjs';
import { SignalingClient, buildSignalingUrl, redactSignalingUrl } from '../src/agent/webrtc/signaling.mjs';

async function makeServer(token = '') {
  return createSignalingServer({ port: 0, host: '127.0.0.1', token, heartbeatMs: 0 });
}

function urlWithToken(url, token) {
  return token === '' ? url : `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function makeClient(url, { room, role, peerId, token = '', joinTimeoutMs = 3000 }) {
  return new SignalingClient({
    url: urlWithToken(url, token),
    room,
    role,
    peerId,
    joinTimeoutMs,
    connectTimeoutMs: 3000,
    heartbeatMs: 0,
  });
}

describe('signaling server and client', () => {
  it('forwards offer and candidate payloads to the other role in the room', async () => {
    const server = await makeServer();
    const host = makeClient(server.url, { room: 'r1', role: 'host', peerId: 'host-1' });
    const client = makeClient(server.url, { room: 'r1', role: 'client', peerId: 'client-1' });
    const hostJoined = await host.connect();
    const clientJoined = await client.connect();
    assert.equal(hostJoined.ok, true);
    assert.equal(clientJoined.ok, true);
    assert.equal(clientJoined.peer, 'host-1');

    const offers = [];
    const candidates = [];
    host.on('signal', (message) => {
      if (message.kind === 'offer') offers.push(message);
      if (message.kind === 'candidate') candidates.push(message);
    });
    assert.equal(client.sendSignal('offer', { type: 'offer', sdp: 'v=0\r\n' }).ok, true);
    assert.equal(
      client.sendSignal('candidate', { candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host' }).ok,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(offers.length, 1);
    assert.equal(offers[0].from, 'client-1');
    assert.equal(offers[0].payload.sdp, 'v=0\r\n');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].payload.candidate, 'candidate:1 1 UDP 1 127.0.0.1 9 typ host');

    const left = new Promise((resolve) => host.once('peer-left', resolve));
    client.close('done');
    assert.equal((await left).peer, 'client-1');
    host.close('done');
    await server.close();
  });

  it('refuses a second holder of the same room role', async () => {
    const server = await makeServer();
    const host = makeClient(server.url, { room: 'r2', role: 'host', peerId: 'host-1' });
    assert.equal((await host.connect()).ok, true);
    const duplicate = makeClient(server.url, {
      room: 'r2',
      role: 'host',
      peerId: 'host-2',
      joinTimeoutMs: 1000,
    });
    const errors = [];
    duplicate.on('error', (error) => errors.push(error));
    const result = await duplicate.connect();
    assert.equal(result.ok, false);
    assert.ok(
      errors.some((error) => error.code === 'SIGNAL_ROOM_FULL'),
      JSON.stringify(errors),
    );
    host.close('done');
    await server.close();
  });

  it('refuses a wrong token before the WebSocket upgrade', async () => {
    const server = await makeServer('secret-token');
    const bad = makeClient(server.url, { room: 'r3', role: 'client', peerId: 'client-1', token: 'wrong' });
    const result = await bad.connect();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WEBRTC_SIGNAL_SEND_FAILED');
    const good = makeClient(server.url, {
      room: 'r3',
      role: 'client',
      peerId: 'client-2',
      token: 'secret-token',
    });
    assert.equal((await good.connect()).ok, true);
    good.close('done');
    await server.close();
  });

  it('serves a health endpoint without exposing the token', async () => {
    const server = await makeServer('secret-token');
    const health = new URL(server.url);
    health.protocol = 'http:';
    health.pathname = '/health';
    const response = await fetch(health);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.protocol, 'w2m-webrtc/1');
    assert.equal(JSON.stringify(body).includes('secret-token'), false);
    await server.close();
  });

  it('redacts the token in diagnostics and builds only ws/wss URLs', () => {
    const built = buildSignalingUrl('ws://127.0.0.1:8788/w2m/webrtc', {
      room: 'r',
      role: 'host',
      peerId: 'p',
      token: 'secret',
    });
    assert.equal(built.ok, true);
    assert.match(built.url, /token=secret/);
    assert.equal(redactSignalingUrl(built.url).includes('secret'), false);
    const bad = buildSignalingUrl('http://127.0.0.1:8788/w2m/webrtc', {
      room: 'r',
      role: 'host',
      peerId: 'p',
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'WEBRTC_SIGNAL_BAD_URL');
  });
});
