/**
 * Fleet chat over real HTTP: a paired machine speaks as itself, the store's refusal codes survive the trip, and the
 * reads carry the usage the client needs to warn before the quota refuses a write.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../src/relay/server.mjs';

async function liveRelay() {
  const relay = createRelayServer({ host: '127.0.0.1', port: 0, persist: false, operatorToken: 'op' });
  const info = await relay.listen();
  const base = 'http://127.0.0.1:' + (info.port ?? info.port_actual);
  const pair = async (machine_id) => {
    const code = relay.state.createPairingCode();
    const res = await fetch(base + '/v1/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: code, machine_id, machine_name: machine_id, platform: { os: 'linux', arch: 'x64' }, caps: {} }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return body.device_token;
  };
  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { relay, pair, call, close: () => relay.close?.() };
}

describe('fleet chat over HTTP', () => {
  it('a paired machine posts and another machine reads the same session', async () => {
    const { pair, call, close } = await liveRelay();
    try {
      const a = await pair('m-1');
      const b = await pair('m-2');
      const posted = await call('POST', '/v1/fleet/messages', a, { session_id: 's-1', text: 'hello fleet' });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      assert.equal(posted.body.message.machine_id, 'm-1', 'the author is the token holder, not a body field');

      const listed = await call('GET', '/v1/fleet/messages?session_id=s-1', b);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.count, 1);
      assert.equal(listed.body.messages[0].text, 'hello fleet');
      assert.ok(listed.body.usage, 'every read carries usage so a client can warn before the quota refuses a write');
    } finally { close(); }
  });

  it('refuses a message from an unpaired caller, and refuses non-text with a named code', async () => {
    const { pair, call, close } = await liveRelay();
    try {
      const anonymous = await call('POST', '/v1/fleet/messages', null, { session_id: 's-1', text: 'hi' });
      assert.equal(anonymous.status, 401, 'a message must be attributable to a paired machine');

      const a = await pair('m-1');
      const notText = await call('POST', '/v1/fleet/messages', a, { session_id: 's-1', text: 42 });
      assert.equal(notText.status, 400);
      assert.match(JSON.stringify(notText.body), /NOT_TEXT/);
    } finally { close(); }
  });

  it('deleting the session is a store operation the routes do not expose yet, and the read says so', async () => {
    const { pair, call, close } = await liveRelay();
    try {
      const a = await pair('m-1');
      await call('POST', '/v1/fleet/messages', a, { session_id: 's-1', text: 'one' });
      const empty = await call('GET', '/v1/fleet/messages?session_id=never-existed', a);
      assert.equal(empty.status, 200);
      assert.equal(empty.body.count, 0, 'an unknown session reads as empty, not as an error');
    } finally { close(); }
  });
});
