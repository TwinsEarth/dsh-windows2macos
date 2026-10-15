/**
 * The MCP server: protocol shape, the read-only promise, and the stdout discipline (v0.54.0).
 *
 * ## What is asserted, and why each one is not obvious
 *
 * * **Two protocol eras are answered.** The current revision is stateless -- version, identity and capabilities
 *   travel as per-request `_meta` with no handshake -- while every earlier revision opens with `initialize`. **A
 *   server implementing only the modern contract is unreachable from most deployed clients**, which is the
 *   population this exists to serve.
 * * **A notification is never answered.** JSON-RPC forbids a reply to a message with no `id`, and a client that
 *   receives one can read it as a desynchronised stream. `notifications/initialized` is the one every legacy
 *   client sends, so getting this wrong breaks every connection.
 * * **Every declared route exists in the relay.** My first draft invented two, and a fabricated route answers
 *   404, which reads as a broken relay rather than as a bug in this package.
 * * **The five tools are read-only**, asserted by name against a mutating-looking pattern -- so a later edit
 *   adding `w2m_run` has to delete an assertion rather than quietly widen what the fleet exposes.
 *
 * ## Why nothing here spawns the process
 *
 * `serve()` and `handleMessage()` are exported so a test drives the real loop with a fake transport. **A test
 * that needs a subprocess is skipped wherever piped stdio is refused** -- which is exactly where a protocol
 * regression must still be caught.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import { handleMessage, serve, callTool, readConfig, TOOLS, TOOL_NAMES, SUPPORTED_VERSIONS, SERVER_NAME, ERROR } from '../bin/w2m-mcp.mjs';
import { relayRoutes, canonicalRoute } from '../scripts/mcp-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A fetch that records the URLs it was given and answers with canned bodies. */
const fakeFetch = (responses = {}) => {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (key === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    const body = responses[key];
    return typeof body === 'string'
      ? { ok: true, status: 200, text: async () => body }
      : { ok: body.ok, status: body.status, text: async () => body.text };
  };
  impl.seen = seen;
  return impl;
};

const deps = (fetchImpl = fakeFetch()) => ({ config: { relayUrl: 'http://relay.test', operatorToken: '', device: null }, fetchImpl });

describe('MCP: the two protocol eras', () => {
  it('answers a legacy initialize handshake, echoing a version it speaks', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, deps());
    assert.equal(reply.id, 1);
    assert.equal(reply.result.protocolVersion, '2025-11-25');
    assert.equal(reply.result.serverInfo.name, SERVER_NAME);
    assert.deepEqual(reply.result.capabilities.tools, { listChanged: false });
  });

  it("falls back to the newest legacy version when the client asks for one it does not speak", async () => {
    // Not an error: the handshake is where a legacy client learns what it may use.
    const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1900-01-01' } }, deps());
    assert.equal(reply.result.protocolVersion, '2025-11-25');
  });

  it('refuses a modern request declaring an unsupported version, and lists what it supports', async () => {
    // The specification requires `supported`, so a client can retry rather than give up.
    const reply = await handleMessage({
      jsonrpc: '2.0', id: 7, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
    }, deps());
    assert.equal(reply.error.code, ERROR.UNSUPPORTED_PROTOCOL_VERSION);
    assert.deepEqual(reply.error.data.supported, [...SUPPORTED_VERSIONS]);
    assert.equal(reply.error.data.requested, '1900-01-01');
  });

  it('accepts a modern request that declares a version it speaks', async () => {
    const reply = await handleMessage({
      jsonrpc: '2.0', id: 8, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': SUPPORTED_VERSIONS[0] } },
    }, deps());
    assert.equal(reply.result.tools.length, 5);
  });

  it('never answers a notification, because JSON-RPC forbids it', async () => {
    // `notifications/initialized` is sent by every legacy client. A reply here desynchronises the stream.
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps()), null);
    // And an unknown notification is equally silent -- silence, not METHOD_NOT_FOUND.
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/whatever' }, deps()), null);
  });

  it('implements server/discover, which the current revision requires of every server', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'server/discover' }, deps());
    assert.deepEqual(reply.result.supportedVersions, [...SUPPORTED_VERSIONS]);
  });

  it('answers ping, and reports an unknown method without crashing the loop', async () => {
    assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, deps())).result, {});
    const unknown = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'no/such' }, deps());
    assert.equal(unknown.error.code, ERROR.METHOD_NOT_FOUND);
  });

  it('rejects a non-object request rather than throwing', async () => {
    for (const bad of [null, [], 'x', 5]) {
      const reply = await handleMessage(bad, deps());
      assert.equal(reply.error.code, ERROR.INVALID_REQUEST, JSON.stringify(bad));
    }
  });
});

describe('MCP: the read-only promise', () => {
  it('exposes exactly the five agreed tools', () => {
    assert.deepEqual([...TOOL_NAMES], ['w2m_devices', 'w2m_stats', 'w2m_history', 'w2m_report', 'w2m_status']);
  });

  it('exposes nothing that could dispatch, cancel, write or approve', () => {
    // The design constraint, as an assertion: a later edit that adds `w2m_run` must delete this line.
    const mutating = TOOL_NAMES.filter((n) => /run|dispatch|cancel|write|update|memory|approve|council/.test(n));
    assert.deepEqual(mutating, [], `mutating tools exposed: ${mutating.join(', ')}`);
  });

  it('gives every tool a closed schema and a description long enough to choose from', () => {
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.ok(tool.description.length >= 40, `${tool.name}: ${tool.description.length} chars`);
      assert.ok(Array.isArray(tool.routes) && tool.routes.length > 0, tool.name);
    }
  });

  it('declares only routes the relay actually serves', () => {
    const routed = new Set([...relayRoutes(readFileSync(`${ROOT}/src/relay/server.mjs`, 'utf8'))].map(canonicalRoute));
    for (const tool of TOOLS) {
      for (const route of tool.routes) {
        assert.ok(routed.has(canonicalRoute(route)), `${tool.name} declares ${route}`);
      }
    }
  });

  it('requires an argument wherever requests() cannot answer without one', () => {
    for (const tool of TOOLS) {
      const required = tool.inputSchema.required ?? [];
      if (required.length === 0) continue;
      assert.throws(() => tool.requests({}), 'tool.requests() should refuse empty arguments');

      // Only the PATH is compared, not the query string. The first three versions of this assertion compared
      // whole URLs and each failed for a different incidental reason -- a sample value substituted where the
      // builder applies a default, a `{id}` that `canonicalRoute` refuses to collapse, an optional property left
      // unset. **The property under test is "this tool can reach the route it declares", and the query is not
      // part of that.**
      const sample = Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key, schema]) => [key, schema.enum ? schema.enum[0] : 'abc-123']));
      const made = tool.requests(sample);
      assert.equal(made.length, tool.routes.length, `${tool.name}: one request per declared route`);
      for (const [i, path] of made.entries()) {
        const declared = tool.routes[i].split('/')[2] ?? '';
        assert.ok(path.startsWith(`/v1/${declared}`), `${tool.name}: ${path} does not start at the declared /v1/${declared}`);
        // A parameterised declaration must actually be parameterised by the built path, not left as `{id}`.
        assert.equal(/\{[^}]+\}/.test(path), false, `${tool.name}: ${path} still carries a placeholder`);
      }
    }
  });
});

describe('MCP: calling a tool', () => {
  it('reaches the relay and returns its body', async () => {
    const fetchImpl = fakeFetch({ '/v1/devices': '{"devices":[]}' });
    const result = await callTool('w2m_devices', {}, deps(fetchImpl));
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content[0].text), { devices: [] });
    assert.equal(fetchImpl.seen[0], 'http://relay.test/v1/devices');
  });

  it('reports an unknown tool as an error result naming the real ones', async () => {
    // `isError: true` rather than a JSON-RPC error, because a model can act on the former and a transport error
    // reads as a broken server.
    const result = await callTool('w2m_run', {}, deps());
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no such tool: w2m_run/);
    assert.match(result.content[0].text, /w2m_devices/);
  });

  it('refuses an implausible id rather than escaping it into the path', async () => {
    for (const bad of ['../../etc/passwd', 'a/b', 'a b', '', 'x'.repeat(65)]) {
      const result = await callTool('w2m_report', { task_id: bad }, deps());
      assert.equal(result.isError, true, JSON.stringify(bad));
      assert.match(result.content[0].text, /not a plausible task id/);
    }
  });

  it('surfaces a relay refusal with its status instead of throwing', async () => {
    const result = await callTool('w2m_devices', {}, deps(fakeFetch({ '/v1/devices': { ok: false, status: 401, text: 'unauthorized' } })));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /answered 401/);
  });

  it('reports an unreachable relay as a result, not as a crash', async () => {
    const throwing = async () => { throw new Error('ECONNREFUSED'); };
    const result = await callTool('w2m_devices', {}, deps(throwing));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /could not reach the relay/);
  });

  it('validates a limit rather than passing a bad one to the relay', async () => {
    assert.equal((await callTool('w2m_history', { limit: 0 }, deps())).isError, true);
    assert.equal((await callTool('w2m_history', { limit: 1.5 }, deps())).isError, true);
    const ok = await callTool('w2m_history', { limit: 5 }, deps(fakeFetch({ '/v1/tasks': '{"tasks":[]}' })));
    assert.equal(ok.isError, false);
  });
});

describe('MCP: the stdio framing', () => {
  /** Drive the real serve() loop over in-memory streams. */
  const roundTrip = async (lines) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => { text += c; });
    const done = serve({ input, output, deps: deps(fakeFetch({ '/v1/devices': '{"devices":[]}' })) });
    for (const line of lines) input.write(`${line}\n`);
    input.end();
    await done;
    await new Promise((r) => setImmediate(r));
    return text.trim().split('\n').filter((l) => l !== '');
  };

  it('answers one line per request, newline-delimited', async () => {
    const out = await roundTrip([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((l) => JSON.parse(l).id), [1, 2]);
  });

  it('reports malformed JSON as a parse error and keeps reading', async () => {
    // A server that dies on one bad line takes the whole session with it.
    const out = await roundTrip(['{not json', JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })]);
    assert.equal(JSON.parse(out[0]).error.code, ERROR.PARSE);
    assert.equal(JSON.parse(out[1]).id, 9, 'the loop survived the bad line');
  });

  it('writes nothing for a notification, so the stream stays in step', async () => {
    const out = await roundTrip([
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).id, 5);
  });

  it('ignores a blank line rather than answering it', async () => {
    const out = await roundTrip(['', JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' })]);
    assert.equal(out.length, 1);
  });
});

describe('MCP: configuration', () => {
  it('defaults to the shared relay and this machine identity, like the plugin does', () => {
    const config = readConfig({});
    assert.equal(config.relayUrl, 'http://202.182.123.154:8787');
    assert.ok(config.deviceFile.endsWith('device.json'));
  });

  it('lets the environment override both, so a second fleet is reachable', () => {
    const config = readConfig({ W2M_RABBIT_URL: 'https://other.test/', W2M_OPERATOR_TOKEN: 'tok', DSH_HOME: 'C:/x' });
    assert.equal(config.relayUrl, 'https://other.test/');
    assert.equal(config.operatorToken, 'tok');
  });
});
