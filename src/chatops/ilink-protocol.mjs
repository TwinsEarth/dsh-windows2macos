/**
 * The WeChat (ClawBot / iLink) wire protocol, as measured (v0.7.1).
 *
 * ## Why this file exists
 *
 * v0.7.0 shipped an `ilink.mjs` built from *reading* the audited plugin's source, and every
 * field name in it was wrong. Nine separate mismatches, all of which passed 237 tests, because
 * those tests drove an injected transport and asserted on the requests we *constructed*
 * rather than the requests WeChat *accepts*. A self-consistent suite cannot falsify its own
 * assumptions.
 *
 * Everything below came from a live exchange — a real QR scan, a real bot, a real message in
 * both directions. The comments name the response each constant was read from, so a future
 * change can be checked against something rather than against a memory.
 *
 * ## The two things that cost the most time
 *
 * **`AuthorizationType: ilink_bot_token` is mandatory and undocumented.** Without it every
 * authenticated endpoint answers `{"errcode":-14,"errmsg":"session timeout"}` — *including a
 * request with no `Authorization` header at all*, because the server rejects on the missing
 * type header before it ever looks at the credential. That is why the error reads as a dead
 * session and sends you looking for an expiry bug that does not exist.
 *
 * **Business failures arrive as HTTP 200.** A success answers `{"ret":0,…}`; a failure answers
 * `{"errcode":-14,"errmsg":"session timeout"}` with the same 200. Checking the status code is
 * therefore not enough, and a client that does has a silent-failure bug in the one place it
 * matters most.
 */

/** Where login happens. The only host reachable without a token. */
export const QR_BASE_URL = 'https://ilinkai.weixin.qq.com/';

/**
 * Hosts an authenticated request may be sent to.
 *
 * Measured: the login response returns exactly `https://ilinkai.weixin.qq.com`. v0.7.0 also
 * allowed `weixin.qq.com` and `api.weixin.qq.com` on a guess, which weakened the one guarantee
 * that matters here — that the bot token only ever reaches WeChat's bot endpoint. An
 * allow-list wider than the measurement is not caution, it is the absence of the check.
 */
export const ALLOWED_API_HOSTS = Object.freeze(['ilinkai.weixin.qq.com']);

/** Sent on every request, authenticated or not. `iLink-App-Id: bot` is not the bot's id. */
export const APP_ID = 'bot';
/** `(2 << 16) | (4 << 8) | 6` — the reference client reports 2.4.6 as a packed integer. */
export const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6); // '132102'
/** `channel_version` inside `base_info`. */
export const PROTOCOL_VERSION = '2.4.6';
/** `bot_type` for the QR request. */
export const BOT_TYPE = '3';
/** `AuthorizationType`. Omitting this is the defect described at the top of this file. */
export const AUTH_TYPE = 'ilink_bot_token';

export const ENDPOINTS = Object.freeze({
  QRCODE: 'ilink/bot/get_bot_qrcode',
  QRCODE_STATUS: 'ilink/bot/get_qrcode_status',
  UPDATES: 'ilink/bot/getupdates',
  SEND: 'ilink/bot/sendmessage',
  NOTIFY_START: 'ilink/bot/msg/notifystart',
  NOTIFY_STOP: 'ilink/bot/msg/notifystop',
});

/** `base_info`, required in every request body. Measured in every accepted call. */
export function baseInfo(agent = 'DeepSeekHarness/w2m') {
  return { channel_version: PROTOCOL_VERSION, bot_agent: agent };
}

/** Login states, as strings. `scaned` is WeChat's spelling, not a typo here. */
export const LOGIN_STATUS = Object.freeze({
  WAIT: 'wait',
  SCANED: 'scaned',
  CONFIRMED: 'confirmed',
  EXPIRED: 'expired',
  SCANED_BUT_REDIRECT: 'scaned_but_redirect',
  NEED_VERIFYCODE: 'need_verifycode',
  VERIFY_CODE_BLOCKED: 'verify_code_blocked',
  BINDED_REDIRECT: 'binded_redirect',
});

/** Message types and states, as measured. Inbound is 1; our outbound replies are 2. */
export const MESSAGE = Object.freeze({
  TYPE_INBOUND: 1,
  TYPE_OUTBOUND: 2,
  STATE: 2,
  ITEM_TEXT: 1,
});

/**
 * Is this response a success?
 *
 * Three shapes are accepted, because the server uses three and only one of them is documented
 * by its own field names:
 *
 *   * `{"ret":0, ...}` — the QR, status, notifystart and getupdates calls.
 *   * `{"message_id":...}` — `sendmessage`. **Measured**: a delivered reply came back with a
 *     `message_id` and *no* `ret` at all, so a strict `ret === 0` check reports a successful
 *     send as a failure. That was caught by this suite, which is the point of it.
 *   * `{"errcode":0}` — an explicit zero, which some WeChat endpoints use.
 *
 * A body with none of these is **not** a success: an unknown shape is an unknown outcome, and
 * guessing in the permissive direction is how a refusal gets counted as a delivery.
 */
export function isOk(body) {
  if (body === null || typeof body !== 'object') return false;
  if (body.errcode !== undefined && body.errcode !== 0) return false;
  if (body.ret !== undefined) return body.ret === 0;
  if (body.errcode === 0) return true;
  // `sendmessage`'s success shape, measured.
  return body.message_id !== undefined && body.message_id !== null;
}

/** The reason a response carries, for a log or an error. Never invented. */
export function failureOf(body) {
  if (body === null || typeof body !== 'object') return { errcode: null, errmsg: 'the response was not an object' };
  return {
    errcode: body.errcode ?? null,
    errmsg: body.errmsg ?? body.err_msg ?? body.message ?? null,
  };
}

/**
 * Is this a URL the bot token may be sent to?
 *
 * Checked on the parsed hostname, not a string prefix: `ilinkai.weixin.qq.com.attacker.example`
 * ends with a plausible string and is not WeChat.
 */
export function isAllowedApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'not a url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `the base url is ${parsed.protocol}//, and a bearer token goes over https only` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_API_HOSTS.includes(host)) {
    return { ok: false, reason: `${host} is not a host this channel will send a token to` };
  }
  return { ok: true };
}

/**
 * Text out of an inbound message, using the shape a live response actually has:
 *
 *     item_list: [{ type: 1, text_item: { text: "..." }, ... }]
 */
export function extractText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const parts = [];
  for (const item of items) {
    const text = item?.text_item?.text;
    if (typeof text === 'string' && text !== '') parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/** The platform's id for a message. Measured as a number in a live response, so it is stringified. */
export function messageId(message) {
  const id = message?.message_id ?? message?.msg_id ?? null;
  if (id === null || id === undefined) return null;
  const text = String(id);
  return text === '' ? null : text;
}
