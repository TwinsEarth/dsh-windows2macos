/**
 * Contract tests for the WeChat channel (v0.7.1).
 *
 * ## Why this file is different from `chatops-ilink.test.mjs`
 *
 * That suite drives an injected transport and asserts on the requests *we construct*. It passed
 * 237 times while the adapter could not send a single message, because a self-consistent suite
 * cannot falsify its own assumptions about the wire format.
 *
 * Every fixture below was captured from a **live exchange** — a real QR scan against
 * `ilinkai.weixin.qq.com`, a real bot, a real message in each direction. The assertions are
 * therefore checks against observed reality rather than against our own expectations, and the
 * comment on each fixture says which call produced it.
 *
 * The rule this file follows: **if a field name changes, a test here must fail.** That is the
 * only mechanism that would have caught the nine mismatches in v0.7.0.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createILinkChannel } from '../src/chatops/ilink.mjs';
import { createTransport, buildHeaders, makeUin, repairMessageIds } from '../src/chatops/ilink-transport.mjs';
import {
  ENDPOINTS,
  APP_ID,
  CLIENT_VERSION,
  AUTH_TYPE,
  ALLOWED_API_HOSTS,
  LOGIN_STATUS,
  MESSAGE,
  baseInfo,
  isOk,
  failureOf,
  extractText,
  messageId,
  isAllowedApiUrl,
} from '../src/chatops/ilink-protocol.mjs';

// ---------------------------------------------------------------------------------------------
// Fixtures: verbatim from live responses. Do not "tidy" these — their value is that they are
// what the server actually said.
// ---------------------------------------------------------------------------------------------

/** `POST ilink/bot/get_bot_qrcode?bot_type=3` → 200. Measured 2026-10-14. */
const QR_RESPONSE = {
  qrcode: '7077e0bf05500dbe33d7a96b2cbf4630',
  qrcode_img_content: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=7077e0bf05500dbe33d7a96b2cbf4630&bot_type=3',
  ret: 0,
};

/** `POST ilink/bot/get_qrcode_status?qrcode=...` after a scan → 200. Measured. */
const CONFIRMED_RESPONSE = {
  baseurl: 'https://ilinkai.weixin.qq.com',
  bot_token: 'c3066a6059'.padEnd(58, 'x'),
  ilink_bot_id: '9787225e3e71@im.bot',
  ilink_user_id: 'o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat',
  ret: 0,
  status: 'confirmed',
};

/** `POST ilink/bot/get_qrcode_status` on an unscanned QR → 200. Measured. */
const EXPIRED_RESPONSE = { ret: 0, status: 'expired' };

/** The refusal every authenticated endpoint gave until `AuthorizationType` was sent. Measured. */
const SESSION_TIMEOUT = { errcode: -14, errmsg: 'session timeout' };

/** `POST ilink/bot/msg/notifystart` → 200. Measured. */
const NOTIFY_START_RESPONSE = { ret: 0 };

/**
 * `POST ilink/bot/getupdates` with the real inbound message, trimmed to the fields we read.
 * Measured: the `msgs[]` entry arrived with `message_type: 1` (inbound) and one `type: 1` item.
 */
const UPDATES_RESPONSE = {
  msgs: [
    {
      seq: 1,
      message_id: 7515840255213248776,
      from_user_id: 'o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat',
      to_user_id: '9787225e3e71@im.bot',
      client_id: 'mmassistant_bypmsg_inbox_9dc6917db1ba1eba03315fda471adb54mmo9cq80y907qoBau41lnzsSsoCIlU@weclaw563625_1791915952',
      create_time_ms: 1791915954331,
      message_type: 1,
      message_state: 2,
      item_list: [
        {
          type: 1,
          is_completed: true,
          msg_id: 'v1:5445291249478453392',
          text_item: { text: '收到。\nHello New Wolrd！' },
        },
      ],
    },
  ],
  get_updates_buf: 'cursor-after-one-message',
  ret: 0,
};

/** `POST ilink/bot/sendmessage` for a delivered reply → 200. Measured. */
const SEND_RESPONSE = { message_id: 7515840555615131656 };

// ---------------------------------------------------------------------------------------------

/** A transport scripted with the fixtures above, recording every request. */
function transportFor(script) {
  const calls = [];
  const send = async (req) => {
    calls.push(req);
    const body = typeof script === 'function' ? script(req, calls.length) : script;
    if (body instanceof Error) return { ok: false, http: 0, body: {}, ms: 1, errcode: null, errmsg: body.message };
    const ok = isOk(body);
    return { ok, http: 200, body, ms: 1, ...(ok ? { errcode: null, errmsg: null } : failureOf(body)) };
  };
  // `start()` fires `notifystart` on its own, so the call a test cares about is not necessarily
  // the first one. Selecting by endpoint is what makes these assertions about the send rather
  // than about the order two unrelated calls happened in.
  send.callsTo = (endpoint) => calls.filter((c) => c.url.endsWith(`/${endpoint}`));
  return { calls, request: send };
}

/** The send calls only, which is what every outbound assertion is about. */
const sends = (t) => t.request.callsTo(ENDPOINTS.SEND);

const LOGGED_IN = { token: CONFIRMED_RESPONSE.bot_token, apiBase: CONFIRMED_RESPONSE.baseurl };

// ---------------------------------------------------------------------------------------------

describe('the headers the server requires', () => {
  it('sends AuthorizationType, without which every call answers -14', () => {
    // The defect that took the longest to find: the server rejects on the missing *type* header
    // before it reads the credential, so the error reads as a dead session and is not one.
    const headers = buildHeaders({ token: 'tok' });
    assert.equal(headers.AuthorizationType, AUTH_TYPE);
    assert.equal(headers.AuthorizationType, 'ilink_bot_token');
  });

  it('sends the app id and packed client version', () => {
    const headers = buildHeaders({ token: 'tok' });
    assert.equal(headers['iLink-App-Id'], APP_ID);
    assert.equal(headers['iLink-App-Id'], 'bot');
    assert.equal(headers['iLink-App-ClientVersion'], CLIENT_VERSION);
    assert.equal(headers['iLink-App-ClientVersion'], '132102');
  });

  it('sends a per-request X-WECHAT-UIN, not a constant', () => {
    const a = buildHeaders({ token: 'tok' });
    const b = buildHeaders({ token: 'tok' });
    assert.ok(a['X-WECHAT-UIN'] !== b['X-WECHAT-UIN'], 'a fixed UIN is a fingerprint');
    // base64 of a decimal uint32.
    assert.match(Buffer.from(a['X-WECHAT-UIN'], 'base64').toString('utf8'), /^\d+$/);
  });

  it('omits the credential on an unauthenticated call but keeps the type header', () => {
    const headers = buildHeaders({ token: null });
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers.AuthorizationType, AUTH_TYPE);
  });

  it('makes a UIN that decodes to a decimal integer', () => {
    assert.match(Buffer.from(makeUin(), 'base64').toString('utf8'), /^\d+$/);
  });
});

describe('the two response channels, and the failure that looks like success', () => {
  it('reads ret === 0 as success', () => {
    assert.equal(isOk(NOTIFY_START_RESPONSE), true);
    assert.equal(isOk(QR_RESPONSE), true);
  });

  it('reads errcode as failure even though HTTP was 200', () => {
    // The silent-failure bug v0.7.0 shipped: a status-code check reports this as delivered.
    assert.equal(isOk(SESSION_TIMEOUT), false);
    assert.deepEqual(failureOf(SESSION_TIMEOUT), { errcode: -14, errmsg: 'session timeout' });
  });

  it('does not treat an unknown shape as success', () => {
    assert.equal(isOk(null), false);
    assert.equal(isOk({}), false);
    assert.equal(isOk({ unexpected: 1 }), false);
  });

  it('accepts an explicit errcode 0', () => {
    assert.equal(isOk({ errcode: 0 }), true);
  });

  it('reports a refusal rather than resolving when the transport sees errcode', async () => {
    const t = transportFor(SESSION_TIMEOUT);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    await channel.start(() => {});
    // `send` must reject: the queue counts what resolved, so resolving here would be counted as
    // a delivered message.
    await assert.rejects(() => channel.send({ window: 'user:peer', text: 'hi' }), /errcode -14|session timeout/);
  });
});

describe('the QR login, against the real response', () => {
  it('reads qrcode and qrcode_img_content', async () => {
    const t = transportFor(QR_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, drive: true });
    const qr = await channel.requestQrcode();
    assert.equal(qr.qrcode, QR_RESPONSE.qrcode);
    assert.equal(qr.qrcodeUrl, QR_RESPONSE.qrcode_img_content);
  });

  it('hits get_bot_qrcode with bot_type, unauthenticated', async () => {
    const t = transportFor(QR_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, drive: true });
    await channel.requestQrcode();
    assert.match(t.calls[0].url, /ilink\/bot\/get_bot_qrcode\?bot_type=3$/);
    assert.equal(t.calls[0].token, null, 'the login call must carry no credential');
    assert.equal(t.calls[0].body.base_info.channel_version, '2.4.6');
  });

  it('reads the identity fields by their measured names', async () => {
    // ilink_bot_id / ilink_user_id, not the bot_id / owner_user_id v0.7.0 invented — which
    // produced a "successful" login with empty identity.
    const t = transportFor(CONFIRMED_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, drive: true });
    const login = await channel.pollLogin({ qrcode: 'q' });
    assert.equal(login.status, LOGIN_STATUS.CONFIRMED);
    assert.equal(login.botId, '9787225e3e71@im.bot');
    assert.equal(login.ownerUserId, 'o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat');
    assert.equal(login.baseUrl, 'https://ilinkai.weixin.qq.com');
    assert.equal(login.botToken, CONFIRMED_RESPONSE.bot_token);
  });

  it('reports an expired QR as a status rather than as a login', async () => {
    const t = transportFor(EXPIRED_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, drive: true });
    const login = await channel.pollLogin({ qrcode: 'q' });
    assert.equal(login.status, LOGIN_STATUS.EXPIRED);
    assert.equal(login.botToken, null);
  });

  it('adopts a measured base url and refuses one that is not WeChat', () => {
    const t = transportFor(QR_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, drive: true });
    assert.doesNotThrow(() => channel.adoptLogin({ botToken: 'tok', baseUrl: CONFIRMED_RESPONSE.baseurl }));
    assert.throws(() => channel.adoptLogin({ botToken: 'tok', baseUrl: 'https://attacker.example/' }), /refusing the login response/);
  });
});

describe('the outbound envelope, exactly as measured', () => {
  it('uses to_user_id, and every other field the server reads', async () => {
    const t = transportFor(SEND_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    await channel.start(() => {});
    await channel.send({ window: 'user:o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat', text: 'hello' });

    const body = sends(t)[0].body;
    // v0.7.0 sent `to_user`; the field is `to_user_id`, and the wrong name is accepted silently
    // by a server that then delivers to nobody.
    assert.equal(body.msg.to_user_id, 'o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat');
    assert.equal(body.msg.to_user, undefined, 'the v0.7.0 name must not reappear');
    assert.equal(body.msg.from_user_id, '');
    assert.equal(body.msg.message_type, MESSAGE.TYPE_OUTBOUND);
    assert.equal(body.msg.message_type, 2);
    assert.equal(body.msg.message_state, MESSAGE.STATE);
    assert.equal(body.msg.item_list[0].type, MESSAGE.ITEM_TEXT);
    assert.equal(body.msg.item_list[0].type, 1);
    assert.equal(body.msg.item_list[0].text_item.text, 'hello');
    assert.match(body.msg.client_id, /^w2m-\d+-\d+$/);
  });

  it('wraps the message with base_info, which every accepted call carries', async () => {
    const t = transportFor(SEND_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    await channel.start(() => {});
    await channel.send({ window: 'user:peer', text: 'hi' });
    // v0.7.0 posted a bare {msg}, which the server rejects.
    assert.deepEqual(sends(t)[0].body.base_info, baseInfo());
    assert.equal(sends(t)[0].body.msg.to_user_id, 'peer');
  });

  it('includes context_token only when there is one', async () => {
    const t = transportFor(SEND_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    await channel.start(() => {});
    await channel.send({ window: 'user:peer', text: 'a' });
    assert.equal(sends(t)[0].body.msg.context_token, undefined);
    await channel.send({ window: 'user:peer', text: 'b', contextToken: 'ctx' });
    assert.equal(sends(t)[1].body.msg.context_token, 'ctx');
  });

  it('posts to the send endpoint and returns the message id', async () => {
    const t = transportFor(SEND_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    await channel.start(() => {});
    const body = await channel.send({ window: 'user:peer', text: 'hi' });
    assert.match(sends(t)[0].url, new RegExp(`/${ENDPOINTS.SEND.replace("/", "\\/")}$`));
    assert.equal(body.message_id, SEND_RESPONSE.message_id);
  });

  it('takes the recipient from the window key, tolerating a bare id', async () => {
    const t = transportFor(SEND_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    await channel.start(() => {});
    await channel.send({ window: 'bareid', text: 'hi' });
    assert.equal(sends(t)[0].body.msg.to_user_id, 'bareid');
  });
});

describe('the inbound message, against the real response', () => {
  it('reads msgs, not msg_list', async () => {
    const t = transportFor(UPDATES_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    const delivered = await channel.pollOnce();
    assert.equal(delivered.length, 1, 'v0.7.0 read msg_list and would have seen nothing');
    assert.equal(delivered[0].windowKey, 'user:o9cq80y8gA2CW4Y9RPgJxjpYAolE@im.wechat');
    assert.equal(delivered[0].text, '收到。\nHello New Wolrd！');
    assert.equal(delivered[0].messageId, String(UPDATES_RESPONSE.msgs[0].message_id));
  });

  it('sends get_updates_buf, and stores the cursor the server returns', async () => {
    const t = transportFor(UPDATES_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    await channel.pollOnce();
    // `callsTo` is a snapshot, not a live view: re-read it after a second poll rather than
    // holding the first result and expecting it to grow.
    const first = t.request.callsTo(ENDPOINTS.UPDATES);
    // v0.7.0 posted an empty body; the field is required.
    assert.equal(first[0].body.get_updates_buf, '');
    assert.equal(first[0].body.base_info.channel_version, '2.4.6');
    assert.equal(channel.cursor, UPDATES_RESPONSE.get_updates_buf);

    await channel.pollOnce();
    const both = t.request.callsTo(ENDPOINTS.UPDATES);
    assert.equal(both.length, 2);
    assert.equal(both[1].body.get_updates_buf, UPDATES_RESPONSE.get_updates_buf);
  });

  it('reads text out of item_list[].text_item.text', () => {
    assert.equal(extractText(UPDATES_RESPONSE.msgs[0]), '收到。\nHello New Wolrd！');
    assert.equal(extractText({ item_list: [] }), null);
    assert.equal(extractText({}), null);
  });

  it('keeps the exact digits of a 64-bit message id', () => {
    // A live `message_id` is 7515840255213248776 — nineteen digits, past
    // `Number.MAX_SAFE_INTEGER` (9007199254740991). `JSON.parse` rounds it, so the transport
    // recovers the exact text; without that the id we hold is not the id the server sent.
    const raw = '{"message_id":7515840255213248776,"ret":0}';
    const parsed = JSON.parse(raw);
    assert.notEqual(String(parsed.message_id), '7515840255213248776', 'the fixture must demonstrate the rounding');

    const ids = [...raw.matchAll(/"message_id"\s*:\s*(\d{16,})/g)].map((m) => m[1]);
    const repaired = repairMessageIds(parsed, ids);
    assert.equal(messageId(repaired), '7515840255213248776');
    // Returned, not mutated: a shared fixture must survive being read.
    assert.equal(typeof parsed.message_id, 'number', 'the input must not be rewritten in place');
  });

  it('reads a message id that arrives as a string too', () => {
    // `item_list[].msg_id` is a string in a live response ("v1:5445…"), so both shapes occur.
    assert.equal(messageId({ message_id: 'v1:5445291249478453392' }), 'v1:5445291249478453392');
    assert.equal(messageId({}), null);
  });

  it('de-duplicates a re-delivered id', async () => {
    const t = transportFor(UPDATES_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    assert.equal((await channel.pollOnce()).length, 1);
    assert.equal((await channel.pollOnce()).length, 0, 'a re-delivery must not run the instruction twice');
  });

  it('skips a non-text message rather than making an empty prompt', async () => {
    const t = transportFor({ msgs: [{ message_id: 1, from_user_id: 'peer', item_list: [{ type: 3 }] }], ret: 0 });
    const channel = createILinkChannel({ transport: t.request, ...LOGGED_IN, drive: true });
    assert.deepEqual(await channel.pollOnce(), []);
  });

  it('treats a long-poll timeout as an idle beat, not a failure', async () => {
    const t = transportFor(() => new Error('aborted'));
    const channel = createILinkChannel({
      transport: async () => ({ ok: false, http: 0, body: {}, ms: 1, errcode: null, errmsg: 'timed out', timedOut: true }),
      ...LOGGED_IN,
      drive: true,
    });
    void t;
    assert.deepEqual(await channel.pollOnce(), [], 'nothing happened is not an error');
  });
});

describe('the token only goes to WeChat', () => {
  it('allows exactly the host the login response returned', () => {
    assert.deepEqual([...ALLOWED_API_HOSTS], ['ilinkai.weixin.qq.com']);
    assert.equal(isAllowedApiUrl('https://ilinkai.weixin.qq.com').ok, true);
  });

  it('refuses the look-alike and the plain-http base', () => {
    assert.equal(isAllowedApiUrl('https://ilinkai.weixin.qq.com.attacker.example/').ok, false);
    assert.equal(isAllowedApiUrl('http://ilinkai.weixin.qq.com/').ok, false);
    assert.equal(isAllowedApiUrl('not a url').ok, false);
  });

  it('refuses to send before checking the base', async () => {
    const t = transportFor(SEND_RESPONSE);
    const channel = createILinkChannel({ transport: t.request, token: 'tok', apiBase: 'https://attacker.example/', drive: true });
    await channel.start(() => {});
    await assert.rejects(() => channel.send({ window: 'user:peer', text: 'x' }), /refusing to send the bot token/);
    assert.deepEqual(t.calls, [], 'the refusal must precede the request, not follow it');
  });
});

describe('the real transport', () => {
  it('does not throw on a business refusal; it returns it as data', async () => {
    const transport = createTransport({
      fetch: async () => new Response(JSON.stringify(SESSION_TIMEOUT), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const result = await transport({ url: 'https://ilinkai.weixin.qq.com/x', body: {} });
    assert.equal(result.ok, false);
    assert.equal(result.http, 200, 'the HTTP status was fine, which is the whole problem');
    assert.equal(result.errcode, -14);
  });

  it('reports a success as ok', async () => {
    const transport = createTransport({
      fetch: async () => new Response(JSON.stringify(NOTIFY_START_RESPONSE), { status: 200 }),
    });
    const result = await transport({ url: 'https://ilinkai.weixin.qq.com/x', body: {} });
    assert.equal(result.ok, true);
  });

  it('unwraps the cause of a fetch failure, so a network fault is not read as a protocol fault', async () => {
    const transport = createTransport({
      fetch: async () => {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET', message: 'socket hang up' };
        throw error;
      },
    });
    const result = await transport({ url: 'https://ilinkai.weixin.qq.com/x', body: {} });
    assert.equal(result.ok, false);
    assert.match(result.errmsg, /ECONNRESET/);
  });

  it('reports a non-JSON response rather than pretending it parsed', async () => {
    const transport = createTransport({ fetch: async () => new Response('<html>nope</html>', { status: 200 }) });
    const result = await transport({ url: 'https://ilinkai.weixin.qq.com/x', body: {} });
    assert.equal(result.ok, false);
    assert.match(result.errmsg, /non-JSON/);
  });

  it('refuses to be built without a fetch', () => {
    assert.throws(() => createTransport({ fetch: null }), /needs a fetch implementation/);
  });
});
