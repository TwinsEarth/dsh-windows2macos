/**
 * The declared HTTP endpoint, against the real binary (v0.55.0).
 *
 * ## What this covers that `mcp-http.test.mjs` cannot
 *
 * The sixteen transport tests drive `createRequestHandler` **in process**, with fake request and response
 * objects. That proves the framing, and it proves **nothing about the CLI path**: a wrong default port, a crash
 * during startup, an import cycle, or a `--http` flag that is never reached would all pass those tests while
 * `mcp.json` pointed at a dead URL.
 *
 * **So this spawns `bin/w2m-mcp.mjs --http` and speaks to the port the manifest declares.** The declared URL is
 * the subject, not a URL this test picks -- a healthy server on port 0 would prove nothing about `8766`.
 *
 * ## Why it is a test and not a script
 *
 * It genuinely needs a child process, so it is **honest about the cost**: in a sandbox that refuses piped stdio
 * it fails rather than silently passing. That is why it is worth having here -- `scripts/preflight.mjs` is the
 * one place in this project guaranteed to run with enough privilege, and it runs the declared suite as a child,
 * **so this is the only check that can catch a port that drifted.**
 *
 * ## What it asserts, and what it deliberately does not
 *
 * It asserts the far end is *reachable and speaking the protocol*. It does **not** assert a successful tool
 * result: the relay requires an operator token the test does not carry, so a `401` is the expected outcome --
 * **and proving the call reached the real relay is stronger evidence than a mocked `200` would be.**
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = `${ROOT}bin/w2m-mcp.mjs`;

/** The endpoint as declared, read from the manifest rather than written here twice. */
const declaredUrl = () => {
  const manifest = JSON.parse(readFileSync(`${ROOT}mcp.json`, 'utf8'));
  const server = Object.values(manifest.mcpServers).find((s) => s.type === 'streamable-http');
  assert.ok(server, 'mcp.json declares a streamable-http server');
  return server.url;
};

describe('the declared HTTP endpoint, against the real binary', () => {
  let child;
  let url;
  let stderr = '';
  let stdout = '';

  before(async () => {
    url = declaredUrl();
    child = spawn(process.execPath, [BIN, '--http'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => { stdout += c; });

    // Poll rather than sleep a fixed time: a slow start should not become a flake, and a fast failure should
    // not take ten seconds to report.
    for (let i = 0; i < 80; i += 1) {
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(`${url}?discover`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;
      } catch { /* not listening yet */ }
      await sleep(250);
    }
    assert.fail(`nothing came up at the declared url ${url} (exit=${child.exitCode}); stderr: ${stderr.trim().slice(0, 500)}`);
  });

  after(() => {
    if (child !== undefined && child.exitCode === null) child.kill();
  });

  it('listens on the port the manifest declares, and describes itself', async () => {
    const body = await (await fetch(`${url}?discover`)).json();
    assert.equal(body.transport, 'streamable-http');
    assert.equal(body.endpoint, new URL(url).pathname);
    assert.deepEqual(body.tools, ['w2m_devices', 'w2m_stats', 'w2m_history', 'w2m_report', 'w2m_status']);
    assert.deepEqual(body.protocolVersions, ['2026-07-28', '2025-11-25']);
  });

  it('answers a legacy initialize over a real socket', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.result.serverInfo.name, 'w2m-dsh-fleet');
    assert.equal(body.result.protocolVersion, '2025-11-25');
  });

  it('carries a tool call all the way to the real relay', async () => {
    // The expected outcome is an error result: this test carries no operator token, so the relay refuses. **What
    // it proves is that the request left this process, crossed the binding, and was answered by the fleet's
    // relay** -- a mocked 200 could not distinguish that from a server that never dialled out.
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'w2m_devices', arguments: {} } }),
    });
    assert.equal(r.status, 200, 'a tool failure is a result, not a transport failure');
    const body = await r.json();
    assert.equal(body.id, 2);
    assert.ok(body.result, 'a tool failure is reported inside result, with isError');
    assert.equal(body.result.isError, true, 'the relay should refuse an unauthenticated read');
    assert.match(body.result.content[0].text, /the relay answered \d+ for w2m_devices \/v1\/devices/);
  });

  it('refuses a foreign Origin over a real socket, not just in unit tests', async () => {
    // The unit tests prove the branch; this proves the header actually arrives and is read on a live connection.
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    });
    assert.equal(r.status, 403);
  });

  it('keeps stdout empty, because this binding has no protocol stream there', async () => {
    // The stdio binding owns stdout. If the HTTP path ever wrote a JSON-RPC frame there, a client launching both
    // from one process would see a corrupted stream, and the symptom would be a hang rather than an error.
    await sleep(150);
    assert.equal(stdout, '', `stdout carried ${JSON.stringify(stdout.slice(0, 200))}`);
  });

  it('reports its startup on stderr, where a launcher can read it', () => {
    assert.match(stderr, /streamable-http listening on http/, stderr.slice(0, 300));
    assert.match(stderr, /read-only tools: w2m_devices/, 'and names what it exposes');
  });
});
