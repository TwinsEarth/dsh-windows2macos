/**
 * The WeChat (ClawBot / iLink) adapter (v0.7.0).
 *
 * ## Why this channel first
 *
 * Of the four channels `dsh-chatops` 0.1.0 shipped, iLink is the only one whose protocol is
 * not a vendor SDK: it is JSON over HTTPS against a handful of endpoints, and the audit found
 * its client to be the best-engineered file in that repository — a CDN host allow-list,
 * per-request timeouts merged with caller cancellation, and the correct call that a long-poll
 * timeout is an idle beat rather than a failure. Its shape is kept here, with three changes
 * the audit demanded:
 *
 *   * **the API host is pinned.** 0.1.0 took `baseurl` verbatim out of the login response and
 *     then sent `Authorization: Bearer <bot_token>` to it. It validated the CDN host and not
 *     the API host, so anything able to influence that response received a long-lived
 *     credential. Both are checked against an allow-list here, and the check is on the
 *     resolved host, not on a string prefix.
 *   * **the transport is injected.** The whole protocol is one `request()` function, so every
 *     request the adapter shapes and every response it maps is testable without a network,
 *     a QR code, or a WeChat account. What cannot be tested that way — whether WeChat accepts
 *     the requests — is stated in the release notes rather than implied by a passing suite.
 *   * **it decides nothing about who may speak.** The window key is built here; admission is
 *     `policy.mjs`. 0.1.0 had channel prefixes inside its authorisation path.
 *
 * ## The window key
 *
 * `user:<fromUserId>` for a private message, matching the registry entry for `ilink`. The
 * adapter does not consult the registry to build it — it uses the prefix its channel declares,
 * and `bridge.mjs` refuses to mount a channel whose prefix the registry does not know.
 */

import { CHANNEL_STATE, CHANNEL_FEATURE } from './channel.mjs';

/** Endpoints, by name, so a typo is a missing key rather than a wrong URL. */
export const ILINK_ENDPOINTS = Object.freeze({
  QRCODE: 'ilink/bot/get_bot_qrcode',
  QRCODE_STATUS: 'ilink/bot/get_qrcode_status',
  UPDATES: 'ilink/bot/getupdates',
  SEND: 'ilink/bot/sendmessage',
  NOTIFY_START: 'ilink/bot/msg/notifystart',
  NOTIFY_STOP: 'ilink/bot/msg/notifystop',
});

/** The login base. Nothing else may be reached unauthenticated. */
export const ILINK_LOGIN_HOST = 'ilinkai.weixin.qq.com';
export const ILINK_PROTOCOL_VERSION = '2.4.6';

/**
 * Hosts an authenticated request may be sent to.
 *
 * The defect this closes: 0.1.0 read `baseurl` from the login response and used it as the
 * base for calls carrying the bot token, validating only the CDN. A host allow-list is the
 * one defence that does not depend on trusting the response.
 */
export const ALLOWED_API_HOSTS = Object.freeze(['ilinkai.weixin.qq.com', 'weixin.qq.com', 'api.weixin.qq.com']);

/** Is this URL somewhere the bot token may be sent? */
export function isAllowedApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'the base url is not a url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `the base url is ${parsed.protocol}//, and a bearer token goes over https only` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_API_HOSTS.includes(host)) {
    // Named hosts rather than a suffix test: `evil-weixin.qq.com.attacker.example` ends with a
    // plausible string and is not WeChat.
    return { ok: false, reason: `${host} is not a host this channel will send a token to` };
  }
  return { ok: true };
}

/** Text out of an iLink message body, or null. Mirrors the shape 0.1.0 parsed. */
export function extractText(message) {
  const items = message?.item_list ?? message?.items ?? [];
  if (!Array.isArray(items)) return null;
  const parts = [];
  for (const item of items) {
    const text = item?.text_item?.text ?? item?.text?.content ?? null;
    if (typeof text === 'string' && text !== '') parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/** The platform's own id for a message, used for de-duplication. */
export function messageId(message) {
  const id = message?.msg_id ?? message?.message_id ?? message?.id ?? null;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Create the adapter.
 *
 * @param {object} options
 * @param {(request: {url: string, method: string, headers: Record<string,string>, body?: string, timeoutMs?: number}) => Promise<{status: number, json: unknown}>} options.request
 *        The whole network surface. Injected so the protocol is testable without WeChat.
 * @param {() => string|null} [options.getToken] Current bot token, or null before login.
 * @param {() => string|null} [options.getApiBase] Base url for authenticated calls.
 * @param {string} [options.token] A token known up front, for a stored login.
 * @param {string} [options.apiBase]
 * @param {number} [options.pollTimeoutMs]
 * @param {number} [options.idleDelayMs]
 * @param {boolean} [options.drive] When true, `start()` prepares the channel but does not run
 *        the poll loop, so a caller drives `pollOnce()` itself. Exists because a detached loop
 *        and a test that wants to observe one poll are otherwise racing for the same scripted
 *        response — and the loser is the test, silently, having consumed a duplicate.
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createILinkChannel(options) {
  if (typeof options?.request !== 'function') throw new TypeError('createILinkChannel requires a request()');
  const audit = options.audit ?? (() => {});
  const pollTimeoutMs = options.pollTimeoutMs ?? 60_000;
  const idleDelayMs = options.idleDelayMs ?? 500;
  const drive = options.drive === true;

  let token = options.token ?? null;
  let apiBase = options.apiBase ?? `https://${ILINK_LOGIN_HOST}/`;
  let state = CHANNEL_STATE.IDLE;
  let handlers = null;
  let running = false;
  let controller = null;
  let loop = null;
  const seen = new Set();
  const seenOrder = [];
  const MAX_SEEN = 200;

  /** Remember a message id, bounded, oldest evicted. */
  function remember(id) {
    if (id === null || seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > MAX_SEEN) seen.delete(seenOrder.shift());
    return true;
  }

  function requireAllowedBase() {
    const verdict = isAllowedApiUrl(apiBase);
    if (!verdict.ok) {
      // Refused rather than attempted: sending the token is the thing being guarded.
      throw new Error(`refusing to send the bot token: ${verdict.reason}`);
    }
  }

  async function post(endpoint, payload, { authenticated = true } = {}) {
    if (authenticated) {
      requireAllowedBase();
      if (token === null || token === '') throw new Error('no bot token: the channel is not logged in');
    }
    const url = new URL(endpoint, authenticated ? apiBase : `https://${ILINK_LOGIN_HOST}/`).toString();
    const headers = { 'content-type': 'application/json', 'protocol-version': ILINK_PROTOCOL_VERSION };
    if (authenticated) headers.authorization = `Bearer ${token}`;
    const response = await options.request({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeoutMs: pollTimeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`iLink ${endpoint} answered HTTP ${response.status}`);
    }
    return response.json ?? {};
  }

  const channel = {
    name: 'ilink',
    prefixes: ['user', 'contact'],
    capabilities: {
      [CHANNEL_FEATURE.CHUNKING]: true,
      [CHANNEL_FEATURE.FILES]: true,
      [CHANNEL_FEATURE.CARDS]: false,
      [CHANNEL_FEATURE.EDIT]: false,
      [CHANNEL_FEATURE.ROOMS]: false,
    },

    get state() {
      return state;
    },

    async start(inbound) {
      if (typeof inbound !== 'function') throw new TypeError('start() needs an inbound handler');
      handlers = inbound;
      if (token === null || token === '') {
        // Not an error: an install that has not scanned the QR yet is a normal state, and it
        // is reported as `unconfigured` rather than as offline or broken.
        state = CHANNEL_STATE.UNCONFIGURED;
        audit('ilink/unconfigured', {});
        return;
      }
      // Order matters: the loop reads `controller` for its abort signal, so the controller has
      // to exist before `running` lets the loop start.
      controller = new AbortController();
      running = true;
      state = CHANNEL_STATE.READY;
      audit('ilink/started', { host: new URL(apiBase).hostname });
      // The poll loop is detached so a slow platform never blocks host startup. 0.1.0 got this
      // right and it is kept — except when the caller asked to drive it, in which case the
      // loop would consume the very responses the caller is observing.
      loop = drive ? null : pollLoop();
    },

    async stop() {
      running = false;
      state = CHANNEL_STATE.STOPPED;
      controller?.abort();
      // Awaited, not merely signalled: a caller that stops the channel and then tears down the
      // process should not race a loop that is still mid-request.
      try {
        await loop;
      } catch {
        /* the loop reports its own failures; stopping is not the place to raise them */
      }
      loop = null;
      controller = null;
      handlers = null;
      audit('ilink/stopped', {});
    },

    /** Send one chunk. Rejection here is normal and is reported by the queue, not swallowed. */
    async send({ window, text }) {
      const to = String(window).slice(String(window).indexOf(':') + 1);
      await post(ILINK_ENDPOINTS.SEND, {
        msg: { to_user: to, item_list: [{ text_item: { text } }] },
      });
      audit('ilink/sent', { to, bytes: Buffer.byteLength(text, 'utf8') });
    },

    /** Set or replace the token, e.g. after a QR login. */
    setLogin(nextToken, nextBase) {
      token = nextToken;
      if (typeof nextBase === 'string' && nextBase !== '') {
        const verdict = isAllowedApiUrl(nextBase);
        if (!verdict.ok) throw new Error(`refusing the login response's base url: ${verdict.reason}`);
        apiBase = nextBase;
      }
      audit('ilink/login', { host: new URL(apiBase).hostname });
    },

    setState(next) {
      state = next;
    },

    /** Exposed for the QR flow, which the host drives. */
    async requestQrcode({ botType = '3' } = {}) {
      return post(`${ILINK_ENDPOINTS.QRCODE}?bot_type=${encodeURIComponent(botType)}`, {}, { authenticated: false });
    },

    async pollQrcodeStatus(qrcode, verifyCode) {
      let endpoint = `${ILINK_ENDPOINTS.QRCODE_STATUS}?qrcode=${encodeURIComponent(qrcode)}`;
      if (typeof verifyCode === 'string' && verifyCode !== '') {
        endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
      }
      return post(endpoint, {}, { authenticated: false });
    },

    /** One poll, for tests and for a host that drives its own loop. */
    async pollOnce() {
      const body = await post(ILINK_ENDPOINTS.UPDATES, {});
      return dispatch(body);
    },

    /** Read-only views. Not part of the channel contract. */
    get seenCount() {
      return seen.size;
    },
  };

  /**
   * Turn a poll response into inbound messages.
   *
   * Returned rather than only delivered, so a test can assert the mapping without a handler.
   */
  function dispatch(body) {
    const messages = body?.msg_list ?? body?.messages ?? [];
    const delivered = [];
    if (!Array.isArray(messages)) return delivered;
    for (const message of messages) {
      const id = messageId(message);
      // Bounded de-duplication. The platform re-delivers, and running the same instruction
      // twice because a poll overlapped is a real consequence.
      if (id !== null && !remember(id)) {
        audit('ilink/duplicate', { id });
        continue;
      }
      const text = extractText(message);
      if (text === null) {
        // A non-text message is skipped, not turned into an empty prompt. 0.1.0 did the same
        // and it is the right call: an empty prompt is model work with no content.
        audit('ilink/skipped-non-text', { id });
        continue;
      }
      const fromUserId = message?.from_user_id ?? message?.from ?? message?.sender ?? null;
      if (typeof fromUserId !== 'string' || fromUserId === '') {
        audit('ilink/skipped-no-sender', { id });
        continue;
      }
      const inbound = {
        windowKey: `user:${fromUserId}`,
        talkerId: fromUserId,
        text,
        addressed: true,
      };
      delivered.push(inbound);
      if (typeof handlers === 'function') {
        // Delivered without awaiting the handler's work: one slow handler must not stall the
        // poll, or the platform's queue backs up behind it.
        void Promise.resolve(handlers(inbound)).catch((error) => audit('ilink/handler-failed', { detail: String(error) }));
      }
    }
    return delivered;
  }

  async function pollLoop() {
    let failures = 0;
    while (running) {
      try {
        await channel.pollOnce();
        failures = 0;
        if (state === CHANNEL_STATE.DEGRADED) state = CHANNEL_STATE.READY;
        // A long poll normally returns at its timeout, so a `getupdates` that answers
        // *immediately* means the platform is handing back an empty body straight away — and
        // re-issuing with no gap turns this into a hot loop that starves the event loop. The
        // yield is what stops a fast platform from becoming a busy wait; the delay is small
        // because the platform's own long poll is the real pacing.
        if (running) await interruptibleSleep(idleDelayMs);
      } catch (error) {
        failures += 1;
        // Degraded, not stopped: the audit found 0.1.0 collapsed connecting, reconnecting and
        // error into one boolean, so a machine could not tell a blip from a dead channel.
        state = CHANNEL_STATE.DEGRADED;
        audit('ilink/poll-failed', { attempt: failures, detail: error instanceof Error ? error.message : String(error) });
        if (!running) break;
        // Bounded backoff, so a platform outage does not become a hot loop against it.
        await interruptibleSleep(Math.min(idleDelayMs * 2 ** Math.min(failures, 5), 30_000));
      }
    }
  }

  /**
   * Sleep that `stop()` can cut short.
   *
   * A bare `setTimeout` here keeps the process alive after the channel is stopped: the loop's
   * own `running` check is a full sleep away, so a background job or a test runner waits out
   * the backoff before it can exit. `AbortSignal` is the mechanism `stop()` already uses, so
   * this listens to it rather than inventing a second one.
   */
  function interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const signal = controller?.signal;
      if (!running || signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  return channel;
}
