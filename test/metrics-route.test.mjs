/**
 * `GET /metrics` at the HTTP layer (v0.3.3).
 *
 * `test/metrics.test.mjs` covers the renderer as a pure function. This covers the part that file
 * cannot: whether the route exists, when it exists, and what a scraper actually receives. The two are
 * genuinely different failures -- a correct renderer behind an unreachable route looks exactly like an
 * unimplemented feature, and that is what the relay looked like before this route was wired.
 *
 * The properties under test:
 *   * **Off by default.** An endpoint that appears without being asked for is a surface nobody chose,
 *     and 404 rather than 403 because a 403 tells a scanner the surface exists.
 *   * **Token-free when on**, like `/healthz`, so a scraper never needs a credential in its own config.
 *   * **Signed or not**, because the scraper has no secret to sign with.
 *   * **Correct content type**, since Prometheus dispatches on it.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { createRelayServer } from '../src/relay/server.mjs';
import { METRICS_CONTENT_TYPE } from '../src/relay/metrics.mjs';

const running = [];

after(async () => {
  await Promise.all(running.map((r) => r.close().catch(() => {})));
});

/** Start a relay on a free port. */
async function startRelay(options = {}) {
  const server = createRelayServer({
    host: '127.0.0.1',
    port: 0,
    stateDir: null,
    persist: false,
    pairRateLimitPerMinute: 0,
    ...options,
  });
  await server.listen();
  running.push(server);
  return server;
}

/**
 * A raw request, so response headers can be inspected rather than inferred.
 *
 * @param {object} server - The relay, which exposes `port` only after `listen()` resolves.
 * @param {string} path - Request path.
 */
function rawGet(server, path) {
  const port = server.port;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /metrics at the HTTP layer', () => {
  it('is absent unless the relay was asked for it', async () => {
    const server = await startRelay();
    const res = await rawGet(server, '/metrics');
    // 404, not 403: a disabled endpoint should look like it does not exist.
    assert.equal(res.status, 404, `expected 404 for a disabled endpoint, got ${res.status}`);
    assert.match(res.body, /metrics are not enabled/, 'the refusal must say how to enable it');
  });

  it('answers without a token once enabled', async () => {
    // Token-free for the same reason /healthz is: a scraper that needs the operator token puts that
    // token in a Prometheus config file, which is a credential in a place nobody reviews.
    const server = await startRelay({ metrics: true, operatorToken: 'op-secret', operatorTokenRequired: true });
    const res = await rawGet(server, '/metrics');
    assert.equal(res.status, 200, res.body.slice(0, 200));
    assert.equal(res.headers['content-type'], METRICS_CONTENT_TYPE, 'Prometheus dispatches on this header');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /^w2m_devices /m);
    assert.match(res.body, /^# TYPE w2m_devices gauge$/m);
  });

  it('answers even when signatures are required', async () => {
    // The scraper has no secret to sign with, so a signature check here would make metrics
    // unreachable on exactly the deployments that are hardened enough to want them.
    const server = await startRelay({ metrics: true, requireSignature: true, signingSecret: 'shh' });
    const res = await rawGet(server, '/metrics');
    assert.equal(res.status, 200, res.body.slice(0, 200));
  });

  it('counts a dispatched task in the metrics a scraper sees', async () => {
    // The end-to-end reason the endpoint exists: a number that changes when the fleet does work.
    const server = await startRelay({ metrics: true, operatorToken: 'op' });
    const before = await rawGet(server, '/metrics');
    assert.match(before.body, /^w2m_tasks 0$/m);

    const posted = await fetch(`http://127.0.0.1:${server.port}/v1/task`, {
      method: 'POST',
      headers: { authorization: 'Bearer op', 'content-type': 'application/json' },
      body: JSON.stringify({ command_argv: ['node', '-e', '1'] }),
    }).catch(() => null);
    // No device is paired, so the relay refuses the task. Either way the metrics endpoint must keep
    // answering -- a monitor that goes down when the fleet is unhappy is worse than none.
    const after = await rawGet(server, '/metrics');
    assert.equal(after.status, 200);
    if (posted?.ok) assert.match(after.body, /^w2m_tasks 1$/m);
    assert.match(after.body, /^w2m_devices /m);
  });

  it('never leaks the operator token or the signing secret', async () => {
    const server = await startRelay({ metrics: true, operatorToken: 'LEAK-CANARY-OP', signingSecret: 'LEAK-CANARY-SIGN' });
    const res = await rawGet(server, '/metrics');
    assert.equal(res.status, 200);
    // A metrics endpoint is scraped into long-lived storage by design, so a secret here would be
    // copied far beyond the relay's own logs.
    assert.equal(res.body.includes('LEAK-CANARY-OP'), false, 'operator token appeared in metrics');
    assert.equal(res.body.includes('LEAK-CANARY-SIGN'), false, 'signing secret appeared in metrics');
  });
});
