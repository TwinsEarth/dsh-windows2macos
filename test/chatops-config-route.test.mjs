/**
 * The settings endpoint (v0.7.0).
 *
 * Two findings, both HIGH, both in the same pair of handlers.
 *
 * **H1.** `GET /chatops/api/config` returned `feishu.appSecret`, `dingtalk.clientSecret` and
 * `wecom.secret` in cleartext, gated only on `remoteAddress` being loopback — no token, no
 * `Origin`, no `Host`. The settings page then re-fetched that every three seconds.
 *
 * **H2.** `POST` to the same path merged the body with `{ ...current, ...next }` and wrote
 * it to the profile's `cordis.patch.yml`. Nothing validated the keys, so a caller could set
 * `profilePatch` (redirecting the write target) or `puppet` (a specifier later handed to
 * `await import()`). The profile's patch layer permits `!!js` expressions, which makes a
 * YAML write there a code-execution primitive at the next reload.
 *
 * The tests are grouped by the four defences, because each one alone is the mistake:
 *
 *   * **a secret never leaves the process** — asserted on the serialised body, not on a
 *     field name, so a future field cannot slip through a name-based check;
 *   * **loopback is necessary and not sufficient** — the token is required on both verbs,
 *     and a wrong token is refused in constant time;
 *   * **`Origin` and `Host` are the rebinding defence** — the case that a bare loopback
 *     check cannot see;
 *   * **an unknown key is refused, not dropped** — publishing a setting and silently
 *     ignoring it is how an operator concludes a control does not work.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createConfigRoute,
  redactConfig,
  mergeConfig,
  validateConfigPatch,
  CONFIG_REFUSAL,
} from '../src/chatops/config-route.mjs';

const TOKEN = 'install-token-0123456789';

/** A route over an in-memory config, with every request shaped like a real one. */
function harness({ config = {}, token = TOKEN, allowedHosts } = {}) {
  let current = {
    channel: 'ilink',
    channels: ['ilink'],
    feishu: { appId: 'cli_abc', appSecret: 'super-secret-feishu' },
    dingtalk: { clientId: 'ding_abc', clientSecret: 'super-secret-ding' },
    wecom: { botId: 'bot_abc', secret: 'super-secret-wecom' },
    ...config,
  };
  const writes = [];
  const audit = [];
  const route = createConfigRoute({
    token,
    allowedHosts,
    read: () => current,
    write: (next) => {
      writes.push(next);
      current = next;
    },
    audit: (event, detail) => audit.push({ event, ...detail }),
  });

  const call = (method, { body, headers = {}, remoteAddress = '127.0.0.1' } = {}) =>
    route.handle({ method, remoteAddress, headers, body });

  const authed = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

  return { route, call, authed, writes, audit, get config() { return current; } };
}

describe('a secret never leaves the process', () => {
  it('returns no credential value in any field, at any depth', async () => {
    const h = harness();
    const res = await h.call('GET', { headers: h.authed() });
    assert.equal(res.status, 200);
    // Asserted on the whole serialised body rather than on field names: a name-based check
    // passes the moment someone adds `apiKey` beside `appSecret`.
    const text = JSON.stringify(res.body);
    for (const secret of ['super-secret-feishu', 'super-secret-ding', 'super-secret-wecom']) {
      assert.ok(!text.includes(secret), `${secret} was returned by a read`);
    }
  });

  it('says whether a secret is configured, so a form can show it without holding it', async () => {
    const h = harness();
    const res = await h.call('GET', { headers: h.authed() });
    assert.equal(res.body.config.feishu.appSecretConfigured, true);
    assert.equal(res.body.config.feishu.appSecret, undefined);
    assert.equal(res.body.config.feishu.appId, 'cli_abc', 'non-secret fields are still returned');
  });

  it('reports a credential that is absent as absent, not as configured', async () => {
    const h = harness({ config: { feishu: { appId: 'cli_abc' } } });
    const res = await h.call('GET', { headers: h.authed() });
    assert.equal(res.body.config.feishu.appSecretConfigured, false);
  });

  it('never returns the operator token', () => {
    const view = redactConfig({ operatorToken: 'op-secret', channel: 'ilink' });
    assert.equal(view.operatorToken, undefined);
    assert.ok(!JSON.stringify(view).includes('op-secret'));
  });

  it('keeps a secret the write did not send, so "never returned" is workable', async () => {
    // The form sends back what it was shown; the credential it was never shown must survive.
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: JSON.stringify({ channel: 'feishu' }) });
    assert.equal(res.status, 200);
    assert.equal(h.config.channel, 'feishu');
    assert.equal(h.config.feishu.appSecret, 'super-secret-feishu', 'an omitted secret must not be erased');
  });

  it('treats an empty secret as "leave it", not as "clear it"', async () => {
    const h = harness();
    await h.call('POST', { headers: h.authed(), body: JSON.stringify({ feishu: { appSecret: '' } }) });
    assert.equal(h.config.feishu.appSecret, 'super-secret-feishu');
  });

  it('accepts a new secret when one really is sent', async () => {
    const h = harness();
    await h.call('POST', { headers: h.authed(), body: JSON.stringify({ feishu: { appSecret: 'rotated' } }) });
    assert.equal(h.config.feishu.appSecret, 'rotated');
  });
});

describe('loopback is necessary and not sufficient', () => {
  it('refuses a non-loopback peer', async () => {
    const h = harness();
    const res = await h.call('GET', { headers: h.authed(), remoteAddress: '10.0.0.5' });
    assert.equal(res.status, 403);
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.NOT_LOOPBACK);
  });

  it('refuses a loopback peer with no token', async () => {
    // The whole of 0.1.0's defence was the address check. It is the first gate here and not
    // the only one.
    const h = harness();
    const res = await h.call('GET', { headers: {} });
    assert.equal(res.status, 401);
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.NO_TOKEN);
  });

  it('refuses a wrong token without saying how wrong', async () => {
    const h = harness();
    const res = await h.call('GET', { headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` } });
    assert.equal(res.status, 401);
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.BAD_TOKEN);
    assert.ok(!JSON.stringify(res.body).includes('install-token'), 'a refusal must not echo the token');
  });

  it('requires the token on the write as well as the read', async () => {
    // 0.1.0's write was behind the same address-only gate, which made it reachable by
    // anything on the machine.
    const h = harness();
    const res = await h.call('POST', { headers: {}, body: JSON.stringify({ channel: 'feishu' }) });
    assert.equal(res.status, 401);
    assert.deepEqual(h.writes, [], 'nothing may be written without the token');
  });

  it('accepts 127.0.0.1, ::1 and 127.x.x.x', async () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2']) {
      const h = harness();
      const res = await h.call('GET', { headers: h.authed(), remoteAddress: addr });
      assert.equal(res.status, 200, `${addr} should be treated as loopback`);
    }
  });

  it('refuses to be built without a token at all', () => {
    assert.throws(() => createConfigRoute({ read: () => ({}), write: () => {} }), /no unauthenticated mode/);
  });
});

describe('Origin and Host are the rebinding defence', () => {
  it('refuses a request carrying a foreign Origin', async () => {
    // A page on evil.example resolving to 127.0.0.1 sends its own Origin; a bare address
    // check cannot see the difference, and this is the attack it cannot see.
    const h = harness();
    const res = await h.call('GET', { headers: h.authed({ origin: 'https://evil.example' }) });
    assert.equal(res.status, 403);
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.BAD_ORIGIN);
  });

  it('refuses a request whose Host is not this install', async () => {
    const h = harness();
    const res = await h.call('GET', { headers: h.authed({ host: 'evil.example' }) });
    assert.equal(res.status, 403);
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.BAD_ORIGIN);
  });

  it('accepts its own Origin and Host', async () => {
    const h = harness();
    const res = await h.call('GET', { headers: h.authed({ origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' }) });
    assert.equal(res.status, 200);
  });

  it('accepts a request with neither header, which is what a CLI client sends', async () => {
    const h = harness();
    assert.equal((await h.call('GET', { headers: h.authed() })).status, 200);
  });

  it('refuses an Origin it cannot parse rather than ignoring it', async () => {
    const h = harness();
    const res = await h.call('GET', { headers: h.authed({ origin: 'not a url' }) });
    assert.equal(res.status, 403);
  });

  it('honours an install that answers on another host', async () => {
    const h = harness({ allowedHosts: ['127.0.0.1', 'w2m.local'] });
    assert.equal((await h.call('GET', { headers: h.authed({ host: 'w2m.local' }) })).status, 200);
    assert.equal((await h.call('GET', { headers: h.authed({ host: 'other.local' }) })).status, 403);
  });
});

describe('an unknown key is refused, not dropped', () => {
  it('refuses profilePatch, naming why', async () => {
    // The 0.1.0 write target, redirectable from a request.
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: JSON.stringify({ profilePatch: '/etc/evil.yml' }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.UNKNOWN_KEY);
    assert.match(res.body.detail, /write target/);
    assert.deepEqual(h.writes, []);
  });

  it('refuses puppet, naming why', async () => {
    // The module specifier that reached `await import()`.
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: JSON.stringify({ puppet: 'wechaty-puppet-evil' }) });
    assert.equal(res.status, 400);
    assert.match(res.body.detail, /imported into the host process/);
    assert.deepEqual(h.writes, []);
  });

  it('refuses any other key it does not know', async () => {
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: JSON.stringify({ sneaky: 1 }) });
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.UNKNOWN_KEY);
  });

  it('refuses an unknown nested key inside a known section', async () => {
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: JSON.stringify({ security: { allowEvil: true } }) });
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.BAD_VALUE);
    assert.match(res.body.detail, /security.allowEvil/);
  });

  it('accepts every key the schema declares', () => {
    assert.equal(
      validateConfigPatch({
        channel: 'ilink',
        channels: ['ilink', 'feishu'],
        security: { allowContacts: ['feishu:ou_x'], allowRooms: ['feishu:oc_y'], listenSelf: true },
        push: { onApproval: false, approvalTimeoutSec: 60 },
        reply: { maxChunkBytes: 4000, rateLimitMs: 0, maxFileMB: 10 },
      }),
      null,
    );
  });

  it('refuses a value of the wrong shape, naming the key', async () => {
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: JSON.stringify({ channels: 'ilink' }) });
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.BAD_VALUE);
    assert.match(res.body.detail, /channels/);
  });
});

describe('the body is bounded before it is parsed', () => {
  it('refuses an oversized body', async () => {
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: 'x'.repeat(70 * 1024) });
    assert.equal(res.status, 413);
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.TOO_LARGE);
  });

  it('refuses a body that is not JSON', async () => {
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: 'not json' });
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.BAD_BODY);
  });

  it('treats an empty body as an empty patch rather than as an error', async () => {
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: '' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.ok, true);
  });

  it('refuses a JSON array', async () => {
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: '[1,2]' });
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.BAD_BODY);
  });
});

describe('the write answers with the redacted view', () => {
  it('does not need a second read, and returns no secret', async () => {
    // 0.1.0's settings page re-fetched the secret-bearing payload every three seconds. The
    // write now answers with the same redacted shape, so no such poll is needed.
    const h = harness();
    const res = await h.call('POST', { headers: h.authed(), body: JSON.stringify({ reply: { rateLimitMs: 500 } }) });
    assert.equal(res.status, 200);
    assert.equal(res.body.config.reply.rateLimitMs, 500);
    assert.ok(!JSON.stringify(res.body).includes('super-secret'));
  });

  it('audits every refusal and every write', async () => {
    const h = harness();
    await h.call('GET', { headers: {} });
    await h.call('POST', { headers: h.authed(), body: JSON.stringify({ channel: 'feishu' }) });
    const reasons = h.audit.map((a) => a.reason ?? a.event);
    assert.ok(reasons.includes(CONFIG_REFUSAL.NO_TOKEN));
    assert.ok(reasons.includes('config/written'));
  });

  it('refuses a verb it does not answer', async () => {
    const h = harness();
    const res = await h.call('DELETE', { headers: h.authed() });
    assert.equal(res.status, 405);
    assert.equal(res.body.reason_code, CONFIG_REFUSAL.METHOD);
  });
});

describe('mergeConfig keeps what matters', () => {
  it('merges nested objects rather than replacing them', () => {
    const next = mergeConfig({ feishu: { appId: 'a', appSecret: 's' } }, { feishu: { appId: 'b' } });
    assert.deepEqual(next.feishu, { appId: 'b', appSecret: 's' });
  });

  it('replaces an array rather than merging it', () => {
    // Arrays are lists of decisions; merging them would resurrect an entry the operator
    // removed.
    const next = mergeConfig({ channels: ['ilink', 'feishu'] }, { channels: ['ilink'] });
    assert.deepEqual(next.channels, ['ilink']);
  });

  it('leaves untouched keys alone', () => {
    const next = mergeConfig({ channel: 'ilink', reply: { rateLimitMs: 1 } }, { channel: 'feishu' });
    assert.equal(next.reply.rateLimitMs, 1);
  });
});
