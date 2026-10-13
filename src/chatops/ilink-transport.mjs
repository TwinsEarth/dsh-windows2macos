/**
 * The real HTTP transport for the WeChat channel (v0.7.1).
 *
 * v0.7.0 required the host to inject a transport and shipped none, so nothing could ever send
 * a request. That was a design gap rather than a typo: an adapter with no default client is an
 * adapter that cannot run. This is the default, and it is still injectable, because the
 * contract tests need to drive it without a network.
 *
 * ## What it does that a bare `fetch` does not
 *
 * * **A per-request deadline**, because `getupdates` is a deliberate long poll and `notifystart`
 *   is not; one timeout for both would either cut the poll short or hang the handshake.
 * * **`undici`'s `cause` unwrapping.** A bare `fetch` failure is `TypeError: fetch failed` with
 *   the actual reason (`ECONNRESET`, `ENOTFOUND`, `CERT_*`) on `error.cause`. Reporting only the
 *   TypeError is how a network problem looks like a protocol problem.
 * * **The `ret` / `errcode` distinction returned as data.** It does not throw on a business
 *   failure: `{"errcode":-14}` arrives with HTTP 200 and is a *value*, and a transport that
 *   turned it into an exception would make the channel's own error handling unreachable.
 */

import { randomBytes } from 'node:crypto';
import { APP_ID, CLIENT_VERSION, AUTH_TYPE, isOk, failureOf } from './ilink-protocol.mjs';

/** `X-WECHAT-UIN`: base64 of a random uint32 rendered as decimal text. Measured. */
export function makeUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

/**
 * Headers for one request.
 *
 * `AuthorizationType` is the one that is easy to leave out and impossible to debug: without it
 * every authenticated endpoint answers `-14 session timeout`, including calls with no
 * credential at all, because the server rejects before it reads the token.
 */
export function buildHeaders({ token, uin = makeUin() } = {}) {
  const headers = {
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': CLIENT_VERSION,
    'content-type': 'application/json',
    AuthorizationType: AUTH_TYPE,
    'X-WECHAT-UIN': uin,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Return a copy with rounded `message_id` numbers replaced by the exact digits the server sent.
 *
 * **Returns** rather than mutates. The first version edited in place, so a caller holding the
 * body it had passed in saw it change underneath — and in the test suite, where a fixture
 * constant is shared between cases, the first case silently rewrote it for every case after.
 * A function whose name says "repair" should not be able to surprise its caller that way, and
 * the symptom (a later test failing on data it never touched) is expensive to trace.
 *
 * Walked in document order: `JSON.parse` preserves key order, and the regex that collected the
 * ids read them in the same order, so the nth `message_id` encountered is the nth id captured.
 * Matching by value instead would be circular — the whole problem is that the value is wrong.
 */
export function repairMessageIds(node, exactIds) {
  const remaining = [...exactIds];
  function walk(current) {
    if (current === null || typeof current !== 'object') return current;
    if (Array.isArray(current)) return current.map(walk);
    const copy = {};
    for (const [key, value] of Object.entries(current)) {
      if (key === 'message_id' && typeof value === 'number' && remaining.length > 0) {
        copy[key] = remaining.shift();
      } else {
        copy[key] = walk(value);
      }
    }
    return copy;
  }
  return walk(node);
}

/**
 * Create a transport.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] Injected in tests; the platform's own otherwise.
 * @param {() => string} [options.mintUin]
 * @param {(event: string, detail?: object) => void} [options.audit]
 * @returns {(request: {url: string, body: unknown, token?: string|null, timeoutMs?: number, signal?: AbortSignal}) => Promise<{ok: boolean, http: number, body: object, ms: number, errcode?: number|null, errmsg?: string|null}>}
 */
export function createTransport(options = {}) {
  // `??` would treat an explicit `null` as "not provided" and quietly fall back to the global
  // fetch, so a test asking for no fetch would silently get the network instead. Presence is
  // checked rather than nullishness.
  const hasFetch = Object.prototype.hasOwnProperty.call(options, 'fetch');
  const doFetch = hasFetch ? options.fetch : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    // Named rather than left to fail at the first request with "doFetch is not a function".
    throw new TypeError('createTransport needs a fetch implementation; Node 20.19+ provides one, or inject options.fetch');
  }
  const mintUin = options.mintUin ?? makeUin;
  const audit = options.audit ?? (() => {});

  return async function request({ url, body, token = null, timeoutMs = 20_000, signal: outer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Both the caller's cancellation and the deadline apply, so a channel being stopped cuts a
    // long poll short instead of waiting out its 45 seconds.
    const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
    const started = Date.now();

    let response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: buildHeaders({ token, uin: mintUin() }),
        body: JSON.stringify(body ?? {}),
        signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        return { ok: false, http: 0, body: {}, ms: Date.now() - started, errcode: null, errmsg: `timed out after ${timeoutMs}ms`, timedOut: true };
      }
      // `fetch failed` hides the reason on `cause`; without this a network fault reads as a
      // protocol fault and sends you debugging field names.
      const cause = error?.cause;
      const detail = cause ? `${cause.code ?? ''}${cause.code ? ' ' : ''}${cause.message ?? cause}`.trim() : 'no-cause';
      audit('transport/network-error', { url, detail });
      return { ok: false, http: 0, body: {}, ms: Date.now() - started, errcode: null, errmsg: `${error?.message ?? error} [${detail}]` };
    }
    clearTimeout(timer);

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Some endpoints answer with an opaque string; the caller sees it in `errmsg`.
      json = null;
    }
    const ms = Date.now() - started;

    if (json === null) {
      return { ok: false, http: response.status, body: {}, ms, errcode: null, errmsg: `non-JSON response: ${text.slice(0, 200)}` };
    }

    // 64-bit ids, recovered as text.
    //
    // A live `message_id` is 7515840255213248776 — nineteen digits, and past
    // `Number.MAX_SAFE_INTEGER` (9007199254740991). `JSON.parse` therefore rounds it, and the
    // value we hold is *not* the value the server sent. Measured: the constant
    // `7515840255213248776` came back out of a parse as `7515840255213249000`.
    //
    // For de-duplication the rounding is mostly harmless — a re-delivery carries the same
    // rounded number, so it is still caught. It is not harmless if an id is ever sent back to
    // the platform or persisted as a key, so the exact digits are recovered here rather than
    // left to a comment.
    const exactIds = [...text.matchAll(/"message_id"\s*:\s*(\d{16,})/g)].map((m) => m[1]);
    if (exactIds.length > 0) json = repairMessageIds(json, exactIds);

    const ok = response.ok && isOk(json);
    if (!ok) {
      const { errcode, errmsg } = failureOf(json);
      audit('transport/refused', { url, http: response.status, errcode, errmsg });
      return { ok: false, http: response.status, body: json, ms, errcode, errmsg: errmsg ?? `HTTP ${response.status}` };
    }
    audit('transport/ok', { url, http: response.status, ms });
    return { ok: true, http: response.status, body: json, ms, errcode: null, errmsg: null };
  };
}
