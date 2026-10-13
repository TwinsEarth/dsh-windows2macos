/**
 * The WeChat (ClawBot / iLink) adapter (v0.7.0).
 *
 * Two properties, and the first is the reason this adapter exists before the other three.
 *
 * **The bot token only goes to WeChat.** 0.1.0 read `baseurl` out of the login response and
 * used it as the base for every authenticated call, having validated the *CDN* host and not
 * the API host. Anything able to influence that response — a hostile local CA, a terminating
 * middlebox — received a long-lived credential. The allow-list here is checked on the resolved
 * host, not on a string prefix, because `evil-weixin.qq.com.attacker.example` ends with a
 * plausible string and is not WeChat.
 *
 * **The protocol is testable without WeChat.** The whole network surface is one injected
 * `request()`, so request shaping, response mapping, de-duplication and the state machine are
 * all asserted here. What this suite cannot tell you is whether WeChat accepts the requests —
 * and the release notes say so instead of implying otherwise.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createILinkChannel,
  extractText,
  messageId,
  isAllowedApiUrl,
  ILINK_ENDPOINTS,
  ILINK_PROTOCOL_VERSION,
  ALLOWED_API_HOSTS,
} from '../src/chatops/ilink.mjs';
import { CHANNEL_STATE, validateChannel } from '../src/chatops/channel.mjs';

/** A transport that records every request and answers from a script. */
function transport(script = () => ({ status: 200, json: {} })) {
  const calls = [];
  return {
    calls,
    request: async (req) => {
      calls.push(req);
      const answer = script(req, calls.length);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const BOT = 'bot-token-abc';

function channelFor(script, over = {}) {
  const t = transport(script);
  // `drive: true` by default: the suite wants to observe individual polls, and a detached loop
  // would race it for the same scripted response and win.
  const channel = createILinkChannel({ request: t.request, token: BOT, drive: true, ...over });
  return { channel, t };
}

/** One iLink update carrying a text message. */
const update = (from, text, id = 'm1') => ({
  msg_list: [{ msg_id: id, from_user_id: from, item_list: [{ text_item: { text } }] }],
});

describe('the bot token only goes to WeChat', () => {
  it('refuses a base url that is not an allowed host, before sending anything', async () => {
    const { channel, t } = channelFor(() => ({ status: 200, json: {} }), { apiBase: 'https://evil.example/' });
    await channel.start(() => {});
    await assert.rejects(() => channel.send({ window: 'user:me', text: 'hi' }), /not a host this channel will send a token to/);
    assert.deepEqual(t.calls, [], 'the refusal must happen before the request, not after');
  });

  it('refuses a plain-http base, because a bearer token goes over https only', async () => {
    const { channel } = channelFor(() => ({ status: 200, json: {} }), { apiBase: 'http://ilinkai.weixin.qq.com/' });
    await channel.start(() => {});
    await assert.rejects(() => channel.send({ window: 'user:me', text: 'hi' }), /https only/);
  });

  it('refuses a look-alike host rather than suffix-matching it', async () => {
    // The whole reason the check is on the parsed hostname and not on a string prefix.
    const verdict = isAllowedApiUrl('https://evil-weixin.qq.com.attacker.example/x');
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /not a host/);
  });

  it('refuses to adopt a login response base url that is not allowed', async () => {
    // 0.1.0's defect in one line: the login response decided where the token went.
    const { channel } = channelFor(() => ({ status: 200, json: {} }));
    assert.throws(() => channel.setLogin('new-token', 'https://attacker.example/'), /refusing the login response/);
  });

  it('accepts the hosts it declares, and no others', () => {
    for (const host of ALLOWED_API_HOSTS) {
      assert.equal(isAllowedApiUrl(`https://${host}/`).ok, true, `${host} should be allowed`);
    }
    assert.equal(isAllowedApiUrl('not a url').ok, false);
  });

  it('sends the token on an authenticated call and not on a login call', async () => {
    const { channel, t } = channelFor(() => ({ status: 200, json: {} }));
    await channel.start(() => {});
    await channel.send({ window: 'user:me', text: 'hi' });
    assert.equal(t.calls[0].headers.authorization, `Bearer ${BOT}`);
    assert.equal(t.calls[0].headers['protocol-version'], ILINK_PROTOCOL_VERSION);

    await channel.requestQrcode();
    const qr = t.calls.at(-1);
    assert.equal(qr.headers.authorization, undefined, 'the login call carries no credential');
    assert.match(qr.url, /^https:\/\/ilinkai\.weixin\.qq\.com\//);
  });

  it('refuses an authenticated call when there is no token yet', async () => {
    const { channel } = channelFor(() => ({ status: 200, json: {} }), { token: undefined });
    await channel.start(() => {});
    await assert.rejects(() => channel.send({ window: 'user:me', text: 'hi' }), /not logged in/);
  });
});

describe('the adapter satisfies the channel contract', () => {
  it('passes the same validator a real adapter must pass', () => {
    const { channel } = channelFor(() => ({ status: 200, json: {} }));
    const verdict = validateChannel(channel, ['user', 'contact']);
    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('claims only prefixes the registry declares', () => {
    const { channel } = channelFor(() => ({ status: 200, json: {} }));
    assert.deepEqual(channel.prefixes, ['user', 'contact']);
  });

  it('declares that it cannot do cards, rather than being probed for them', () => {
    // 0.1.0 detected card support by sniffing for a method on an `any`.
    const { channel } = channelFor(() => ({ status: 200, json: {} }));
    assert.equal(channel.capabilities.cards, false);
    assert.equal(channel.capabilities.files, true);
  });
});

describe('requests are shaped the way the protocol requires', () => {
  it('posts a text message to the send endpoint with the recipient taken from the window', async () => {
    const { channel, t } = channelFor(() => ({ status: 200, json: {} }));
    await channel.start(() => {});
    await channel.send({ window: 'user:wxid_alice', text: 'hello' });
    const call = t.calls[0];
    assert.equal(call.method, 'POST');
    assert.ok(call.url.endsWith(`/${ILINK_ENDPOINTS.SEND}`), `unexpected url: ${call.url}`);
    const body = JSON.parse(call.body);
    assert.equal(body.msg.to_user, 'wxid_alice');
    assert.equal(body.msg.item_list[0].text_item.text, 'hello');
  });

  it('surfaces a non-2xx as a rejection rather than as an empty success', async () => {
    const { channel } = channelFor(() => ({ status: 401, json: {} }));
    await channel.start(() => {});
    await assert.rejects(() => channel.send({ window: 'user:me', text: 'hi' }), /HTTP 401/);
  });

  it('propagates a transport failure', async () => {
    const { channel } = channelFor(() => new Error('ECONNRESET'));
    await channel.start(() => {});
    await assert.rejects(() => channel.send({ window: 'user:me', text: 'hi' }), /ECONNRESET/);
  });

  it('includes the verify code only when one is supplied', async () => {
    const { channel, t } = channelFor(() => ({ status: 200, json: {} }));
    await channel.pollQrcodeStatus('qr-1');
    assert.ok(!t.calls.at(-1).url.includes('verify_code'));
    await channel.pollQrcodeStatus('qr-1', '123456');
    assert.match(t.calls.at(-1).url, /verify_code=123456/);
  });
});

describe('an update becomes an inbound message, or is deliberately skipped', () => {
  it('maps a text message onto the window key the registry declares', () => {
    const { channel } = channelFor(() => ({ status: 200, json: update('wxid_alice', 'hello', 'm1') }));
    return channel.start(() => {}).then(async () => {
      const delivered = await channel.pollOnce();
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].windowKey, 'user:wxid_alice', 'the adapter builds the key; policy decides admission');
      assert.equal(delivered[0].talkerId, 'wxid_alice');
      assert.equal(delivered[0].text, 'hello');
    });
  });

  it('joins multiple text items in one message', () => {
    assert.equal(extractText({ item_list: [{ text_item: { text: 'a' } }, { text_item: { text: 'b' } }] }), 'a\nb');
  });

  it('reads the alternative body shapes rather than only one', () => {
    assert.equal(extractText({ items: [{ text: { content: 'x' } }] }), 'x');
    assert.equal(messageId({ message_id: 'm' }), 'm');
    assert.equal(messageId({ id: 'i' }), 'i');
  });

  it('skips a non-text message instead of turning it into an empty prompt', async () => {
    // An empty prompt is model work with no content, which is worse than a skip.
    const { channel } = channelFor(() => ({ status: 200, json: { msg_list: [{ msg_id: 'm1', from_user_id: 'a', item_list: [{ image_item: {} }] }] } }));
    await channel.start(() => {});
    assert.deepEqual(await channel.pollOnce(), []);
  });

  it('skips a message with no sender rather than inventing one', async () => {
    const { channel } = channelFor(() => ({ status: 200, json: { msg_list: [{ msg_id: 'm1', item_list: [{ text_item: { text: 'hi' } }] }] } }));
    await channel.start(() => {});
    assert.deepEqual(await channel.pollOnce(), []);
  });

  it('tolerates a response with no message list at all', async () => {
    const { channel } = channelFor(() => ({ status: 200, json: { ok: true } }));
    await channel.start(() => {});
    assert.deepEqual(await channel.pollOnce(), []);
  });

  it('delivers to the handler without awaiting its work, so one slow handler cannot stall the poll', async () => {
    // A stalled poll is a platform queue backing up behind one conversation.
    let released;
    const gate = new Promise((resolve) => {
      released = resolve;
    });
    const { channel } = channelFor(() => ({ status: 200, json: update('a', 'hi', 'm1') }));
    const seen = [];
    await channel.start(async (m) => {
      seen.push(m.text);
      await gate;
    });
    const started = Date.now();
    await channel.pollOnce();
    assert.ok(Date.now() - started < 500, 'pollOnce must not wait for the handler');
    released();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ['hi']);
  });

  it('reports a handler failure rather than rejecting the poll with it', async () => {
    const audits = [];
    const { channel } = channelFor(() => ({ status: 200, json: update('a', 'hi', 'm1') }), {
      audit: (e, d) => audits.push({ e, ...d }),
    });
    await channel.start(async () => {
      throw new Error('handler exploded');
    });
    await channel.pollOnce();
    await new Promise((r) => setImmediate(r));
    assert.ok(audits.some((a) => a.e === 'ilink/handler-failed'));
  });
});

describe('the platform re-delivers, so messages are de-duplicated', () => {
  it('delivers a repeated message id once', async () => {
    const body = update('a', 'hi', 'same-id');
    const { channel } = channelFor(() => ({ status: 200, json: body }));
    await channel.start(() => {});
    assert.equal((await channel.pollOnce()).length, 1);
    assert.equal((await channel.pollOnce()).length, 0, 'the same id must not run the instruction twice');
  });

  it('keeps the dedup set bounded, so a long-running agent does not grow forever', async () => {
    let n = 0;
    const { channel } = channelFor(() => ({ status: 200, json: update('a', 'hi', `m${(n += 1)}`) }));
    await channel.start(() => {});
    for (let i = 0; i < 260; i += 1) await channel.pollOnce();
    assert.ok(channel.seenCount <= 200, `dedup ring grew to ${channel.seenCount}`);
  });

  it('still delivers a message with no id, rather than dropping it as a duplicate', async () => {
    const { channel } = channelFor(() => ({ status: 200, json: { msg_list: [{ from_user_id: 'a', item_list: [{ text_item: { text: 'x' } }] }] } }));
    await channel.start(() => {});
    assert.equal((await channel.pollOnce()).length, 1);
    assert.equal((await channel.pollOnce()).length, 1, 'with no id there is nothing to compare, so it is not a duplicate');
  });
});

describe('the state says which thing is wrong', () => {
  it('is unconfigured, not offline, when no QR has been scanned yet', async () => {
    // 0.1.0 collapsed connecting, reconnecting and error into one boolean, so an operator could
    // not tell "scan the code" from "the network is down".
    const { channel } = channelFor(() => ({ status: 200, json: {} }), { token: undefined });
    await channel.start(() => {});
    assert.equal(channel.state, CHANNEL_STATE.UNCONFIGURED);
  });

  it('is ready once a token is present and it has started', async () => {
    const { channel } = channelFor(() => ({ status: 200, json: {} }));
    await channel.start(() => {});
    assert.equal(channel.state, CHANNEL_STATE.READY);
  });

  it('is stopped after stop(), and stops polling', async () => {
    // The one place the real detached loop is wanted, and the reason `drive` exists as an
    // option rather than as the only behaviour.
    let calls = 0;
    const { channel } = channelFor(
      () => {
        calls += 1;
        return { status: 200, json: {} };
      },
      { drive: false, idleDelayMs: 1 },
    );
    await channel.start(() => {});
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(calls > 0, 'the loop should have polled by now');
    await channel.stop();
    assert.equal(channel.state, CHANNEL_STATE.STOPPED);
    const before = calls;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(calls, before, 'a stopped channel must not keep polling');
  });

  it('stop() waits for the loop rather than racing it', async () => {
    // A caller that stops the channel and then tears down the process must not leave a poll
    // in flight; the sleep between polls is interruptible for the same reason.
    let inFlight = 0;
    const { channel } = channelFor(
      async () => {
        inFlight += 1;
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { status: 200, json: {} };
      },
      { drive: false, idleDelayMs: 1 },
    );
    await channel.start(() => {});
    await new Promise((r) => setTimeout(r, 12));
    await channel.stop();
    assert.equal(inFlight, 0, 'a poll must not still be running after stop() resolves');
  });

  it('refuses to be built without a transport', () => {
    assert.throws(() => createILinkChannel({}), /requires a request\(\)/);
  });
});
