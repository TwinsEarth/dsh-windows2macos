/**
 * The WeChat (ClawBot / iLink) channel adapter (v0.7.1).
 *
 * ## What changed from v0.7.0, and why this file is trustworthy now
 *
 * v0.7.0's adapter was written by *reading* the audited plugin's TypeScript, and every field
 * name in it was wrong — nine mismatches, none of which its 237 passing tests could see,
 * because those tests asserted on the requests we built instead of the requests WeChat accepts.
 *
 * This version was written against live exchanges: a real QR scan, a real bot, real messages in
 * both directions. `ilink-protocol.mjs` holds the measured constants and
 * `test/chatops-ilink-contract.test.mjs` pins them with fixtures taken verbatim from real
 * responses, so a drift fails a test rather than a scan.
 *
 * Three defects are worth naming, because each is the kind that survives review:
 *
 * 1. **`AuthorizationType: ilink_bot_token`.** Mandatory, undocumented, and absent from v0.7.0.
 *    Without it every authenticated call answers `-14 session timeout` — *even with no
 *    `Authorization` header at all*, because the server rejects on the missing type before it
 *    reads the credential. It reads exactly like an expiry bug and is not one.
 * 2. **Business failures arrive as HTTP 200.** `{"errcode":-14,...}` is a failure on a 200
 *    response. v0.7.0 checked the status code only, so a refusal was reported as a delivery.
 * 3. **The transport did not exist.** v0.7.0 required the host to inject one and shipped none,
 *    so no request could ever be sent. `ilink-transport.mjs` is now the default.
 *
 * ## What is deliberately unchanged
 *
 * The channel decisions v0.7.0 got right: a long-poll timeout is an idle beat rather than a
 * failure, de-duplication is bounded, a non-text message is skipped rather than turned into an
 * empty prompt, `DEGRADED` is distinct from `STOPPED`, and the adapter decides nothing about who
 * may speak — it builds the window key and `policy.mjs` decides admission.
 */

import { CHANNEL_STATE, CHANNEL_FEATURE } from './channel.mjs';
// Re-exported so a caller that knew the v0.7.0 surface can still import the protocol constants
// from here; the definitions live in ilink-protocol.mjs, which is what the contract suite pins.
export * from './ilink-protocol.mjs';
import { createTransport } from './ilink-transport.mjs';
import {
  QR_BASE_URL,
  ENDPOINTS,
  BOT_TYPE,
  LOGIN_STATUS,
  MESSAGE,
  baseInfo,
  isAllowedApiUrl,
  extractText,
  messageId,
} from './ilink-protocol.mjs';

/** Long poll: the platform holds the request open this long, so the deadline must exceed it. */
const LONG_POLL_MS = 35_000;
const LONG_POLL_DEADLINE_MS = LONG_POLL_MS + 10_000;
const DEFAULT_SEEN_LIMIT = 200;

/**
 * Create the adapter.
 *
 * @param {object} [options]
 * @param {(request: object) => Promise<object>} [options.transport] Defaults to a real HTTP transport.
 * @param {typeof fetch} [options.fetch] Only used when `transport` is absent.
 * @param {string} [options.token]
 * @param {string} [options.apiBase]
 * @param {boolean} [options.drive] Start without running the poll loop, so a caller drives
 *        `pollOnce()` itself. Without it a detached loop races a test for the same response.
 * @param {number} [options.idleDelayMs]
 * @param {number} [options.seenLimit]
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createILinkChannel(options = {}) {
  const audit = options.audit ?? (() => {});
  const idleDelayMs = options.idleDelayMs ?? 400;
  const seenLimit = options.seenLimit ?? DEFAULT_SEEN_LIMIT;
  const drive = options.drive === true;
  const agent = options.agent ?? 'DeepSeekHarness/w2m';

  const request =
    options.transport ??
    // `fetch` is passed only when it is really there. Passing `{ fetch: undefined }` makes the
    // property exist with an undefined value, which a presence check reads as "provided" — and
    // the transport then refuses to build instead of falling back to the platform's own fetch.
    // Found by a live smoke test: `apply()` threw on mount while every unit test passed, because
    // the tests all inject a transport and so never exercise this default.
    (typeof options.fetch === 'function'
      ? createTransport({ fetch: options.fetch, audit })
      : createTransport({ audit }));

  let token = options.token ?? null;
  let apiBase = options.apiBase ?? QR_BASE_URL;
  let state = CHANNEL_STATE.IDLE;
  let handlers = null;
  let running = false;
  let controller = null;
  let loop = null;
  /** Cursor for `getupdates`. Opaque to us; echoed back exactly. */
  let cursor = '';
  const seen = new Set();
  const seenOrder = [];

  function remember(id) {
    if (id === null || seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    while (seenOrder.length > seenLimit) seen.delete(seenOrder.shift());
    return true;
  }

  /**
   * The base url an authenticated call may use.
   *
   * Checked on every call rather than once at login: the base comes from a *response*, and a
   * response is the thing an allow-list exists to distrust.
   */
  function checkedBase() {
    const verdict = isAllowedApiUrl(apiBase);
    if (!verdict.ok) throw new Error(`refusing to send the bot token: ${verdict.reason}`);
    return apiBase;
  }

  const url = (endpoint) => new URL(endpoint, QR_BASE_URL).toString();

  /** One request, with the outcome returned as data. Never throws on a business refusal. */
  async function call(endpoint, body, { base = null, authenticated = true, timeoutMs = 20_000, signal } = {}) {
    const target = base ?? (authenticated ? checkedBase() : QR_BASE_URL);
    if (authenticated && (token === null || token === '')) {
      return { ok: false, http: 0, body: {}, ms: 0, errcode: null, errmsg: 'no bot token: the channel is not logged in' };
    }
    return request({
      url: new URL(endpoint, target).toString(),
      body: { ...body, base_info: baseInfo(agent) },
      token: authenticated ? token : null,
      timeoutMs,
      signal,
    });
  }

  /** Turn a failed call into a thrown Error, for the paths where silence would be a lie. */
  function must(result, what) {
    if (!result.ok) {
      const reason = result.errmsg ?? 'unknown';
      const code = result.errcode === null || result.errcode === undefined ? '' : ` (errcode ${result.errcode})`;
      throw new Error(`${what} failed: ${reason}${code}`);
    }
    return result.body;
  }

  /** Deliver one inbound message, and map it onto the window key the registry declares. */
  function deliver(inbound) {
    if (typeof handlers !== 'function') return;
    // Not awaited: a slow handler must not stall the poll, or the platform's queue backs up
    // behind one conversation.
    void Promise.resolve(handlers(inbound)).catch((error) => audit('ilink/handler-failed', { detail: String(error) }));
  }

  /** Map a `getupdates` body onto inbound messages, de-duplicated. Returned, so a test can assert it. */
  function dispatch(body) {
    const messages = Array.isArray(body?.msgs) ? body.msgs : [];
    const delivered = [];
    // The cursor advances even when nothing is delivered, and is stored verbatim.
    if (typeof body?.get_updates_buf === 'string') cursor = body.get_updates_buf;

    for (const message of messages) {
      const id = messageId(message);
      if (id !== null && !remember(id)) {
        audit('ilink/duplicate', { id });
        continue;
      }
      const text = extractText(message);
      if (text === null) {
        // A non-text message is skipped rather than turned into an empty prompt, which would be
        // model work with no content.
        audit('ilink/skipped-non-text', { id });
        continue;
      }
      const from = message?.from_user_id;
      if (typeof from !== 'string' || from === '') {
        audit('ilink/skipped-no-sender', { id });
        continue;
      }
      const inbound = { windowKey: `user:${from}`, talkerId: from, text, addressed: true, messageId: id };
      delivered.push(inbound);
      deliver(inbound);
    }
    return delivered;
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

    /** The cursor, for a caller that persists it across restarts. */
    get cursor() {
      return cursor;
    },

    get seenCount() {
      return seen.size;
    },

    async start(inbound) {
      if (typeof inbound !== 'function') throw new TypeError('start() needs an inbound handler');
      handlers = inbound;
      if (token === null || token === '') {
        // A normal state, not an error: an install that has not scanned the QR yet is
        // `unconfigured`, which is a different answer from "offline" or "broken".
        state = CHANNEL_STATE.UNCONFIGURED;
        audit('ilink/unconfigured', {});
        return;
      }
      // The controller must exist before `running` lets the loop read its signal.
      controller = new AbortController();
      running = true;
      state = CHANNEL_STATE.READY;
      audit('ilink/started', { host: new URL(apiBase).hostname });
      // Best effort, and a failure does not stop the poll — measured: a live bot answers
      // `{"ret":0}` to it, and an unbound one may not.
      void channel.notifyStart().catch((error) => audit('ilink/notifystart-failed', { detail: String(error) }));
      loop = drive ? null : pollLoop();
    },

    async stop() {
      running = false;
      state = CHANNEL_STATE.STOPPED;
      controller?.abort();
      try {
        // Best effort: the bot goes offline politely if it can.
        if (token) await channel.notifyStop();
      } catch (error) {
        audit('ilink/notifystop-failed', { detail: String(error) });
      }
      // Awaited, not merely signalled: a caller that stops and then tears down the process must
      // not race a loop that is still mid-request.
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

    setState(next) {
      state = next;
    },

    /** Build the outbound envelope, exactly as measured. */
    buildMessage({ toUserId, text, contextToken }) {
      return {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: `w2m-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          message_type: MESSAGE.TYPE_OUTBOUND,
          message_state: MESSAGE.STATE,
          item_list: [{ type: MESSAGE.ITEM_TEXT, text_item: { text } }],
          ...(typeof contextToken === 'string' && contextToken !== '' ? { context_token: contextToken } : {}),
        },
      };
    },

    /**
     * Send one chunk.
     *
     * Rejects on a business failure, because the queue above counts what resolved — a
     * `{"errcode":...}` on HTTP 200 that returned normally would be counted as delivered, which
     * is the exact bug v0.7.0 shipped.
     */
    async send({ window, text, contextToken = null }) {
      const cut = String(window).indexOf(':');
      const toUserId = cut === -1 ? String(window) : String(window).slice(cut + 1);
      const result = await call(ENDPOINTS.SEND, channel.buildMessage({ toUserId, text, contextToken }));
      if (!result.ok) {
        throw new Error(`sendmessage refused: ${result.errmsg ?? 'unknown'}${result.errcode != null ? ` (errcode ${result.errcode})` : ''}`);
      }
      audit('ilink/sent', { to: toUserId, bytes: Buffer.byteLength(text, 'utf8'), messageId: result.body?.message_id ?? null });
      return result.body;
    },

    /** One poll. Returned so a test can assert the mapping without a handler. */
    async pollOnce({ signal } = {}) {
      const result = await call(
        ENDPOINTS.UPDATES,
        { get_updates_buf: cursor },
        { timeoutMs: LONG_POLL_DEADLINE_MS, signal },
      );
      if (result.timedOut) {
        // The platform holding the request open is how it tells us nothing happened. Treating it
        // as a fault would raise an alarm every idle cycle.
        audit('ilink/poll-idle', {});
        return [];
      }
      if (!result.ok) throw new Error(`getupdates refused: ${result.errmsg ?? 'unknown'}`);
      return dispatch(result.body);
    },

    async notifyStart({ signal } = {}) {
      return must(await call(ENDPOINTS.NOTIFY_START, {}, { timeoutMs: 20_000, signal }), 'notifystart');
    },

    async notifyStop({ signal } = {}) {
      return must(await call(ENDPOINTS.NOTIFY_STOP, {}, { timeoutMs: 5_000, signal }), 'notifystop');
    },

    /** Step 1 of login. Unauthenticated by design. */
    async requestQrcode({ botType = BOT_TYPE } = {}) {
      const body = must(
        await call(`${ENDPOINTS.QRCODE}?bot_type=${encodeURIComponent(botType)}`, {}, { authenticated: false, timeoutMs: 20_000 }),
        'get_bot_qrcode',
      );
      const qrcode = typeof body.qrcode === 'string' && body.qrcode !== '' ? body.qrcode : null;
      if (qrcode === null) throw new Error('get_bot_qrcode returned no qrcode token');
      return {
        qrcode,
        // A JS-rendered landing page, not an image, despite the field's name. Handing this to an
        // <img> is why v0.7.0's probe saved 1,362 bytes of HTML as `wechat-login-qr.unknown`.
        qrcodeUrl: typeof body.qrcode_img_content === 'string' ? body.qrcode_img_content : null,
      };
    },

    /** Step 2 of login. Unauthenticated; returns a status, not a token, until confirmed. */
    async pollLogin({ qrcode, verifyCode = null } = {}) {
      let endpoint = `${ENDPOINTS.QRCODE_STATUS}?qrcode=${encodeURIComponent(qrcode)}`;
      if (typeof verifyCode === 'string' && verifyCode !== '') {
        endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
      }
      const result = await call(endpoint, {}, { authenticated: false, timeoutMs: 35_000 });
      if (!result.ok) throw new Error(`get_qrcode_status refused: ${result.errmsg ?? 'unknown'}`);
      const body = result.body;
      const status = typeof body.status === 'string' ? body.status : null;
      const login = {
        status,
        botToken: typeof body.bot_token === 'string' && body.bot_token !== '' ? body.bot_token : null,
        // Measured names. v0.7.0 read `bot_id` and `owner_user_id`, both of which are undefined
        // in a real response, so the login "succeeded" with empty identity fields.
        botId: typeof body.ilink_bot_id === 'string' ? body.ilink_bot_id : null,
        ownerUserId: typeof body.ilink_user_id === 'string' ? body.ilink_user_id : null,
        baseUrl: typeof body.baseurl === 'string' && body.baseurl !== '' ? body.baseurl : null,
      };
      return login;
    },

    /**
     * Adopt a confirmed login.
     *
     * The base url comes from the response and is therefore checked: a redirect status carries a
     * new one, and accepting it unchecked is how a bot token ends up at a host of someone else's
     * choosing.
     */
    adoptLogin({ botToken, baseUrl }) {
      if (typeof botToken !== 'string' || botToken === '') throw new Error('adoptLogin needs a bot token');
      if (typeof baseUrl === 'string' && baseUrl !== '') {
        const verdict = isAllowedApiUrl(baseUrl);
        if (!verdict.ok) throw new Error(`refusing the login response's base url: ${verdict.reason}`);
        apiBase = baseUrl;
      }
      token = botToken;
      state = CHANNEL_STATE.READY;
      audit('ilink/login-adopted', { host: new URL(apiBase).hostname });
      return { apiBase };
    },

    /** Seed the cursor from persisted state, so a restart does not replay. */
    setCursor(next) {
      cursor = typeof next === 'string' ? next : '';
    },
  };

  async function pollLoop() {
    let failures = 0;
    while (running) {
      try {
        await channel.pollOnce({ signal: controller?.signal });
        failures = 0;
        if (state === CHANNEL_STATE.DEGRADED) state = CHANNEL_STATE.READY;
        // A yield on the success path: a platform that answers immediately would otherwise be
        // polled in a tight loop that starves the event loop. Measured — without this the suite
        // took 131 seconds instead of 0.3.
        if (running) await interruptibleSleep(idleDelayMs);
      } catch (error) {
        failures += 1;
        state = CHANNEL_STATE.DEGRADED;
        audit('ilink/poll-failed', { attempt: failures, detail: error instanceof Error ? error.message : String(error) });
        if (!running) break;
        await interruptibleSleep(Math.min(idleDelayMs * 2 ** Math.min(failures, 5), 30_000));
      }
    }
  }

  /** Sleep that `stop()` can cut short, so a stopped channel cannot hold the process open. */
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
