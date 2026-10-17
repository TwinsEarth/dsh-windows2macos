/**
 * The fallback joining path, driven by a fake transport.
 *
 * The transport is injected, so every branch is exercised: approved on the first poll, approved after waiting, a
 * rejection that must NOT be retried, an expiry, and a refused proof. A test that needed a real relay could not produce
 * a rejection on demand, which is exactly the branch most likely to be wrong.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { joinByAccount, isTerminalAdmissionState } from '../src/plugin/account-join.mjs';
import { deriveAccountKeypair } from '../src/util/account-identity.mjs';

const identity = deriveAccountKeypair('account-material-chain');
const machine = { machine_id: 'm-new', machine_name: 'new-pc' };

function transport({ states = ['approved'], challengeOk = true, submitOk = true } = {}) {
  const calls = [];
  const request = async (options) => {
    calls.push(options);
    if (options.method === 'GET' && options.pathname.endsWith('/challenge')) {
      if (!challengeOk) return { ok: false, error: { code: 'FINGERPRINT_UNREGISTERED' } };
      return { ok: true, json: { challenge_id: 'ch-1', nonce: 'n-1', expires_at_ms: 1 } };
    }
    if (options.method === 'POST' && options.pathname.endsWith('/admission/request')) {
      if (!submitOk) return { ok: false, error: { code: 'SIGNATURE_INVALID' } };
      return { ok: true, json: { request_id: 'req-1', poll_token: 'pt-1', state: 'pending' } };
    }
    // polling
    const state = states[Math.min(states.length - 1, calls.filter((c) => c.pathname && c.pathname.includes('/req-1')).length - 1)];
    return { ok: true, json: { state, device_token: state === 'approved' ? 'dev-token' : undefined } };
  };
  return { request, calls };
}

const fast = { pollIntervalMs: 0, sleep: async () => {} };

describe('the fallback join chain', () => {
  it('challenge -> sign -> submit -> approved on the first poll, returning the device token', async () => {
    const t = transport({ states: ['approved'] });
    const out = await joinByAccount({ request: t.request, identity, machine, ...fast });
    assert.deepEqual({ ok: out.ok, state: out.state, device_token: out.device_token }, { ok: true, state: 'approved', device_token: 'dev-token' });
    assert.equal(t.calls[0].pathname.endsWith('/challenge'), true);
    assert.equal(t.calls[1].method, 'POST');
    assert.equal(t.calls[2].query.poll_token, 'pt-1', 'polling must carry the token the asker was issued');
  });

  it('waits through pending and succeeds when the decision arrives', async () => {
    const t = transport({ states: ['pending', 'pending', 'approved'] });
    const out = await joinByAccount({ request: t.request, identity, machine, ...fast });
    assert.equal(out.state, 'approved');
    assert.equal(t.calls.filter((c) => c.pathname.includes('/req-1')).length, 3);
  });

  it('a rejection is terminal: no further polling', async () => {
    const t = transport({ states: ['rejected', 'approved'] });
    const out = await joinByAccount({ request: t.request, identity, machine, ...fast });
    assert.equal(out.ok, false);
    assert.equal(out.state, 'rejected');
    assert.equal(t.calls.filter((c) => c.pathname.includes('/req-1')).length, 1, 'a no must not be re-asked');
  });

  it('an expiry is terminal and reported as such', async () => {
    const t = transport({ states: ['expired'] });
    const out = await joinByAccount({ request: t.request, identity, machine, ...fast });
    assert.equal(out.state, 'expired');
    assert.equal(out.ok, false);
  });

  it('a refused challenge or proof surfaces the relay code instead of inventing a state', async () => {
    const noChallenge = await joinByAccount({ request: transport({ challengeOk: false }).request, identity, machine, ...fast });
    assert.equal(noChallenge.code, 'FINGERPRINT_UNREGISTERED');
    const noSubmit = await joinByAccount({ request: transport({ submitOk: false }).request, identity, machine, ...fast });
    assert.equal(noSubmit.code, 'SIGNATURE_INVALID');
  });

  it('never-ending pending is reported, not hung on', async () => {
    const t = transport({ states: ['pending'] });
    const out = await joinByAccount({ request: t.request, identity, machine, maxPolls: 3, ...fast });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'STILL_PENDING');
    assert.equal(isTerminalAdmissionState('pending'), false);
    assert.equal(isTerminalAdmissionState('approved'), true);
  });
});
