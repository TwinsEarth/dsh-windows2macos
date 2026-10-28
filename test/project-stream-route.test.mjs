/**
 * A6: project stream proxy. The device token stays in the host; the browser receives frames only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerProjectStreamRoute } from '../src/plugin/project-stream-route.mjs';

function mount({ relayUrl = 'http://relay.test', token = 'dev-token' } = {}) {
  let handler = null;
  const ctx = { inject(_services, callback) { callback({ connection: { fetch: { register(spec) { handler = spec.fetch; } } } }); } };
  registerProjectStreamRoute(ctx, { relayUrl: () => relayUrl, deviceToken: () => token });
  return handler;
}

const sseResponse = () => new Response('event: ready\ndata: {"seq":1}\n\nevent: project.event\ndata: {"seq":2,"type":"board.updated"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('project stream route', () => {
  it('attaches the device token and streams the relay body through', async () => {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seen.push({ url: String(url), auth: init?.headers?.authorization }); return sseResponse(); };
    try {
      const handler = mount();
      const response = await handler({ url: 'http://local/api/w2m/project-stream?project_id=prj-1&since_seq=7', signal: undefined });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.match(await response.text(), /board\.updated/);
      assert.equal(seen.length, 1);
      assert.match(seen[0].url, /\/v1\/projects\/prj-1\/stream\?since_seq=7$/);
      assert.equal(seen[0].auth, 'Bearer dev-token');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses a missing project id, a bad cursor, missing token and relay failure', async () => {
    const handler = mount();
    assert.equal((await handler({ url: 'http://local/api/w2m/project-stream' })).status, 400);
    assert.equal((await handler({ url: 'http://local/api/w2m/project-stream?project_id=prj-1&since_seq=-1' })).status, 400);
    const noToken = mount({ token: '' });
    assert.equal((await noToken({ url: 'http://local/api/w2m/project-stream?project_id=prj-1' })).status, 503);
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('down'); };
    try {
      const response = await handler({ url: 'http://local/api/w2m/project-stream?project_id=prj-1&since_seq=0' });
      assert.equal(response.status, 502);
    } finally {
      globalThis.fetch = original;
    }
  });
});
