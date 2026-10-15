/**
 * The Streamable HTTP binding (v0.55.0).
 *
 * ## What these assertions are for
 *
 * The MCP overview states that **"protocol semantics are identical on every transport. A transport is a
 * binding"** -- so the thing worth testing is not the protocol (the stdio suite covers that) but the four
 * properties the specification attaches to *this* binding:
 *
 * 1. **A single endpoint accepting POST.** The GET *stream* endpoint was removed in revision `2026-07-28`, and
 *    the older HTTP+SSE transport is gone with it.
 * 2. **A notification gets 202 with no body**, because JSON-RPC forbids a response to a message with no `id`.
 * 3. **`Origin` validation is a MUST**, because a loopback server is reachable by any page the user's browser
 *    loads and a DNS-rebinding attack makes that page same-origin.
 * 4. **The default bind is loopback**, not every interface.
 *
 * ## Why the handler is driven directly
 *
 * `createRequestHandler` is exported so these run against fake request and response objects with no socket --
 * **the same reason `handleMessage` is exported.** A test that needs a listening port is a test that gets
 * skipped somewhere, and the security assertions are exactly the ones that must not be.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createRequestHandler, originAllowed, MCP_PATH, ALLOWED_ORIGINS } from '../src/mcp/http-transport.mjs';

const deps = {
  config: { relayUrl: 'http://relay.test', operatorToken: '', device: null },
  fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify({ url }) }),
};

/** A fake request: an EventEmitter with the fields the handler reads. */
const fakeRequest = ({ method = 'POST', url = MCP_PATH, headers = {}, body = '' }) => {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:8766', ...headers };
  req.destroy = () => {};
  // Emitted on the next tick so the handler has attached its listeners first.
  setImmediate(() => {
    if (body !== '') req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
};

/** A fake response that records what was written. */
const fakeResponse = () => {
  const res = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { res.status = status; res.headers = headers ?? {}; return res; },
    write(chunk) { res.body += chunk; return true; },
    end(chunk) { if (chunk !== undefined) res.body += chunk; res.ended = true; return res; },
  };
  return res;
};

/** Drive one request through the handler and return the recorded response. */
const exchange = async (options) => {
  const res = fakeResponse();
  await createRequestHandler({ deps })(fakeRequest(options), res);
  return res;
};

const rpc = (message, headers) => exchange({ body: JSON.stringify(message), headers });

describe('Streamable HTTP: the single POST endpoint', () => {
  it('answers a legacy initialize over HTTP', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(JSON.parse(res.body).result.serverInfo.name, 'w2m-dsh-fleet');
  });

  it('serves tools/list and tools/call through the same endpoint', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(JSON.parse(list.body).result.tools.length, 5);
    const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'w2m_devices', arguments: {} } });
    assert.match(JSON.parse(call.body).result.content[0].text, /relay\.test\/v1\/devices/);
  });

  it('answers a notification with 202 and an empty body', async () => {
    // JSON-RPC forbids a response here, and the HTTP binding expresses that as 202 rather than 200-with-null.
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(res.body, '');
  });

  it('answers malformed JSON as a JSON-RPC parse error, not an HTTP 400', async () => {
    // The transport delivered the bytes; the protocol layer is what rejects them. An HTTP-level error would
    // tell the client nothing about which message failed.
    const res = await exchange({ body: '{not json' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).error.code, -32700);
  });

  it('refuses a non-POST method on the endpoint, naming the ones it takes', async () => {
    const res = await exchange({ method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'POST, GET');
  });

  it('refuses a wrong path and says where the endpoint is', async () => {
    const res = await exchange({ url: '/nope', body: '{}' });
    assert.equal(res.status, 404);
    assert.match(JSON.parse(res.body).error.message, /\/mcp/);
  });

  it('rejects a body over the limit instead of buffering it', async () => {
    // A hostile client should not be able to exhaust memory through one request.
    const res = await exchange({ body: 'x'.repeat(4 * 1024 * 1024 + 10) });
    assert.equal(res.status, 413);
  });
});

describe('Streamable HTTP: what revision 2026-07-28 removed', () => {
  it('refuses the GET stream endpoint by name, so an older client learns why', async () => {
    // Removed in 2026-07-28 along with protocol-level sessions. A bare 404 would leave a client guessing
    // whether it had the URL wrong.
    const res = await exchange({ method: 'GET' });
    assert.equal(res.status, 405);
    assert.match(JSON.parse(res.body).error.message, /removed in protocol revision 2026-07-28/);
  });

  it('offers a discovery GET instead, which is not the removed stream', async () => {
    // A GET that returns a description is not the stream endpoint: it carries no JSON-RPC and no events.
    const res = await exchange({ method: 'GET', url: `${MCP_PATH}?discover=1` });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.transport, 'streamable-http');
    assert.equal(body.method, 'POST');
    assert.deepEqual(body.tools, ['w2m_devices', 'w2m_stats', 'w2m_history', 'w2m_report', 'w2m_status']);
  });

  it('honours ?stream=1 with a request-scoped SSE frame', async () => {
    // Allowed by the specification, and a client written against the stream form is entitled to it. This server
    // emits no notifications during a call, so the stream carries exactly one frame.
    const res = await exchange({ url: `${MCP_PATH}?stream=1`, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.body, /^event: message\ndata: \{"jsonrpc":"2\.0","id":7,"result":\{\}\}\n\n$/);
  });

  it('carries no session identifier, because sessions were removed', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(res.headers['mcp-session-id'], undefined);
    // And every request is self-contained: the same call twice returns the same result with no prior state.
    const again = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(res.body, again.body);
  });
});

describe('Streamable HTTP: the Origin rule, which is a MUST', () => {
  it('accepts loopback origins, with or without a port', () => {
    for (const origin of ['http://127.0.0.1', 'http://127.0.0.1:3000', 'http://localhost:8766', 'https://localhost']) {
      assert.equal(originAllowed(origin), true, origin);
    }
  });

  it('accepts a MISSING Origin, because a non-browser client sends none', () => {
    // The header exists to constrain browsers. Refusing an absent one would break every command-line client
    // while stopping no attack, because an attacker's browser always sends one.
    assert.equal(originAllowed(undefined), true);
    assert.equal(originAllowed(''), true);
  });

  it('refuses a remote origin, a lookalike hostname, and null', () => {
    for (const origin of ['http://evil.example', 'https://evil.example', 'http://127.0.0.1.evil.example', 'null', 'not a url', 'ftp://localhost']) {
      assert.equal(originAllowed(origin), false, origin);
    }
  });

  it('answers 403 for a refused Origin, before reading the body', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    // The refusal names what would have been allowed, so an operator can fix a legitimate client.
    assert.deepEqual(JSON.parse(res.body).error.data.allowed, [...ALLOWED_ORIGINS]);
  });

  it('refuses with 403 even when the body is unparseable, because the check comes first', async () => {
    const res = await exchange({ body: 'not json at all', headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});
