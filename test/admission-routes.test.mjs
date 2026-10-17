/**
 * The admission routes over a REAL relay: the two an unpaired machine must reach, and the three a member uses.
 *
 * The point of the first case is the absence of a device token. Before v1.1.6 an unpaired machine could not join by
 * asking -- the endpoint wanted the very token that failing to pair had denied it, which made the fallback unreachable
 * in exactly the situation it exists for. So the token-free path is asserted with \`null\` credentials on purpose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../src/relay/server.mjs';
import { deriveAccountKeypair, signChallenge } from '../src/util/account-identity.mjs';

const OP = 'operator-token-for-tests';
const identity = deriveAccountKeypair('account-material-routes');

async function liveRelay() {
  const relay = createRelayServer({ host: '127.0.0.1', port: 0, persist: false, operatorToken: OP });
  const info = await relay.listen();
  const base = 'http://127.0.0.1:' + (info.port ?? info.port_actual);
  const pair = async (machine_id) => {
    const code = relay.state.createPairingCode();
    const res = await fetch(base + '/v1/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairing_code: code, machine_id, machine_name: machine_id,
        platform: { os: 'linux', arch: 'x64' }, caps: {},
        account_fingerprint: identity.fingerprint, account_public_key: identity.publicKeyPem,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, 'pair failed: ' + JSON.stringify(body));
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
  const prove = async (machine_id) => {
    const ch = await call('GET', '/v1/fleet/admission/challenge?fingerprint=' + identity.fingerprint + '&machine_id=' + machine_id, null);
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const signature = signChallenge(identity, [ch.body.challenge_id, ch.body.nonce, identity.fingerprint, machine_id].join('|'));
    return { challenge_id: ch.body.challenge_id, signature, machine_id };
  };
  return { relay, call, pair, prove, close: () => relay.close?.() };
}

describe('an unpaired machine can prove its account and ask to join', () => {
  it('founder: challenge -> sign -> request, with no device token anywhere', async () => {
    const { call, pair, prove, close } = await liveRelay();
    try {
      // a machine that HAS paired registers the account key; the founder itself then proves the account
      await pair('m1');
      const proof = await prove('m1');
      const founded = await call('POST', '/v1/fleet/admission/request', null, proof);
      assert.equal(founded.status, 200, JSON.stringify(founded.body));
      assert.equal(founded.body.founder, true);
    } finally { close(); }
  });

  it('a second machine is pending, an online member approves it, and inside 24h it can be kicked', async () => {
    const { call, pair, prove, close } = await liveRelay();
    try {
      const admin = await pair('m1');
      await call('POST', '/v1/fleet/admission/request', null, await prove('m1'));

      await pair('m2');
      const requested = await call('POST', '/v1/fleet/admission/request', null, await prove('m2'));
      assert.equal(requested.status, 200, JSON.stringify(requested.body));
      assert.equal(requested.body.state, 'pending');
      const requestId = requested.body.request_id;
      assert.ok(requested.body.poll_token, 'the asking machine gets a poll token -- it has no device token');

      const polled = await call('GET', '/v1/fleet/admission/' + requestId + '?poll_token=' + requested.body.poll_token, null);
      assert.equal(polled.status, 200, 'poll: ' + JSON.stringify(polled.body));
      assert.equal(polled.body.state, 'pending');

      const refused = await call('GET', '/v1/fleet/admission/' + requestId + '?poll_token=wrong', null);
      assert.equal(refused.status, 404, 'wrong poll token must not reveal the request, got ' + refused.status + ' ' + JSON.stringify(refused.body));

      const pending = await call('GET', '/v1/fleet/admission/pending', admin);
      assert.ok(pending.body.pending.some((r) => r.request_id === requestId));

      const decided = await call('POST', '/v1/fleet/admission/' + requestId + '/decide', admin, { decision: 'approve' });
      assert.equal(decided.body.state, 'approved');

      const removed = await call('POST', '/v1/fleet/members/m2/remove', admin, { reason: 'test' });
      assert.equal(removed.body.immediate, true);
    } finally { close(); }
  });

  it('refuses a request whose signature does not match the challenge', async () => {
    const { call, pair, prove, close } = await liveRelay();
    try {
      await pair('m1');
      const proof = await prove('m1');
      const bad = await call('POST', '/v1/fleet/admission/request', null, { ...proof, signature: 'nope' });
      assert.equal(bad.status, 401);
      assert.match(JSON.stringify(bad.body), /SIGNATURE_INVALID/);
    } finally { close(); }
  });
});
