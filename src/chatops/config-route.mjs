/**
 * The settings endpoint, and the two ways it leaked (v0.7.0).
 *
 * ## The defects this file exists to make impossible
 *
 * `dsh-chatops` 0.1.0 mounted seven loopback routes. Two of them were a matched pair of
 * serious findings:
 *
 * **H1 — the read served every credential in cleartext.** `GET /chatops/api/config` returned
 * the raw merged config object, which includes `feishu.appSecret`, `dingtalk.clientSecret`
 * and `wecom.secret`. The only gate was a `remoteAddress` loopback test: no token, no
 * `Origin` check, no `Host` check. Any local process — or a hostile page reaching loopback
 * through DNS rebinding or a forwarded proxy — could read four platforms' credentials. The
 * settings page then re-fetched that payload **every three seconds**.
 *
 * **H2 — the write accepted arbitrary keys and wrote them to the profile.** `POST` to the
 * same path merged the body with `{ ...current, ...next }` and wrote the result to
 * `cordis.patch.yml`. Because nothing validated the keys, a caller could set `profilePatch`
 * to redirect the write, and `puppet` — a value later handed to `await import()`. That is
 * arbitrary module load reachable from a loopback request, and the profile's own patch layer
 * permits `!!js` expressions, so a YAML-write primitive there is a code-execution primitive
 * at the next reload.
 *
 * ## What is different here
 *
 * * **Secrets are never returned.** Not masked with a fixed string, which still tells an
 *   attacker the field exists and is set — returned as a `{ set: boolean }` marker, so the
 *   form can show "configured" without the value leaving the process. A write that omits a
 *   secret keeps the existing one, which is what makes "never returned" workable.
 * * **Unknown keys are refused, not dropped.** 0.1.0's spread accepted anything. Dropping
 *   silently would leave the caller believing a setting took effect; refusing names it.
 * * **Every route needs a token**, generated per install, and the token is compared in
 *   constant time. Loopback is necessary and not sufficient — it was the whole of 0.1.0's
 *   defence.
 * * **`Origin` and `Host` are checked.** This is the rebinding defence: a page on
 *   `evil.example` resolving to `127.0.0.1` sends `Origin: https://evil.example` and a
 *   matching `Host`, and both are refused.
 * * **Reads are not polled into a write path, and writes need a body limit.** The 3-second
 *   re-fetch of a secret-bearing payload is gone because the payload no longer has secrets.
 *
 * The module is plain request-in / response-out with no server attached, so every refusal
 * above is tested directly rather than through a live socket.
 */

/** What the route answers. */
export const CONFIG_ROUTE = Object.freeze({
  GET: 'get',
  POST: 'post',
});

/** Why a request was refused. Returned as a code so a test can assert on it. */
export const CONFIG_REFUSAL = Object.freeze({
  /** Not a loopback peer. Necessary, and nowhere near sufficient. */
  NOT_LOOPBACK: 'not_loopback',
  /** No `Authorization` header. */
  NO_TOKEN: 'no_token',
  /** The header was present and wrong. */
  BAD_TOKEN: 'bad_token',
  /** `Origin` or `Host` is not one this install answers to. */
  BAD_ORIGIN: 'bad_origin',
  /** A verb this route does not answer. */
  METHOD: 'method',
  /** A body that is not a JSON object. */
  BAD_BODY: 'bad_body',
  /** A key that is not part of the schema. Named, because dropping it silently lies. */
  UNKNOWN_KEY: 'unknown_key',
  /** A value the schema rejects. */
  BAD_VALUE: 'bad_value',
  /** Larger than the route accepts. */
  TOO_LARGE: 'too_large',
});

/** Keys a config write may carry, with a validator each. Everything else is refused. */
export const CONFIG_SCHEMA = Object.freeze({
  channel: (v) => (typeof v === 'string' && v !== '' ? null : 'must be a non-empty string'),
  channels: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'must be an array of strings'),
  storagePath: (v) => (typeof v === 'string' ? null : 'must be a string'),
  security: (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
    const allowed = new Set(['listenFilehelper', 'listenSelf', 'allowContacts', 'allowRooms']);
    for (const key of Object.keys(v)) {
      if (!allowed.has(key)) return `security.${key} is not a setting`;
    }
    if (v.allowContacts !== undefined && !Array.isArray(v.allowContacts)) return 'security.allowContacts must be an array';
    if (v.allowRooms !== undefined && !Array.isArray(v.allowRooms)) return 'security.allowRooms must be an array';
    return null;
  },
  push: (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
    const allowed = new Set(['onSessionComplete', 'onApproval', 'approvalTimeoutSec', 'longOutputAsFile']);
    for (const key of Object.keys(v)) {
      if (!allowed.has(key)) return `push.${key} is not a setting`;
    }
    return null;
  },
  reply: (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
    const allowed = new Set(['maxChunkBytes', 'rateLimitMs', 'maxFileMB']);
    for (const key of Object.keys(v)) {
      if (!allowed.has(key)) return `reply.${key} is not a setting`;
    }
    return null;
  },
  feishu: (v) => (v === null || typeof v === 'object' ? null : 'must be an object'),
  dingtalk: (v) => (v === null || typeof v === 'object' ? null : 'must be an object'),
  wecom: (v) => (v === null || typeof v === 'object' ? null : 'must be an object'),
});

/**
 * Keys that are refused even if a validator is added later.
 *
 * `profilePatch` and `puppet` are the two 0.1.0 accepted and should not have: the first
 * redirects where the config is written, the second names a module to import. Both are
 * named individually so the refusal says which one and why, rather than "unknown key".
 */
export const FORBIDDEN_KEYS = Object.freeze({
  profilePatch: 'the write target is this plugin\'s own row and cannot be redirected from a request',
  puppet: 'a module specifier cannot be supplied by a request; it would be imported into the host process',
});

/** Secret-bearing paths, by dotted key. Never returned; a write that omits one keeps it. */
const SECRET_PATHS = Object.freeze([
  ['feishu', 'appSecret'],
  ['dingtalk', 'clientSecret'],
  ['wecom', 'secret'],
  ['ilink', 'token'],
]);

/** Constant-time string compare, so a wrong token cannot be found one byte at a time. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isLoopback(remoteAddress) {
  if (typeof remoteAddress !== 'string') return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1' ||
    remoteAddress.startsWith('127.')
  );
}

/** `Host` without its port, lower-cased. */
function hostOnly(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']'));
  const cut = v.indexOf(':');
  return cut === -1 ? v : v.slice(0, cut);
}

/** Build the read view: every secret replaced by whether it is set. */
export function redactConfig(config) {
  const view = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (key === 'operatorToken') continue;
    view[key] = value === null || typeof value !== 'object' || Array.isArray(value) ? value : { ...value };
  }
  for (const path of SECRET_PATHS) {
    const [section, field] = path;
    if (view[section] && typeof view[section] === 'object') {
      const had = typeof view[section][field] === 'string' && view[section][field] !== '';
      delete view[section][field];
      // `configured` rather than the value, and rather than a fixed mask: a mask still tells
      // a reader the field exists and is set, and the form only needs to know that much.
      view[section][`${field}Configured`] = had;
    }
  }
  return view;
}

/**
 * Merge a validated write into the current config.
 *
 * Secrets the body omits are **kept**. That is what makes "never returned" workable: the
 * settings form sends back what it was shown, and the credential it was never shown survives.
 */
export function mergeConfig(current, patch) {
  const next = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof next[key] === 'object' && next[key] !== null) {
      const merged = { ...next[key], ...value };
      // A secret sent as an empty string means "leave it": an operator clearing a visible
      // password field should not wipe a working credential.
      for (const [section, field] of SECRET_PATHS) {
        if (section === key && value[field] === '' && typeof next[key]?.[field] === 'string') {
          merged[field] = next[key][field];
        }
      }
      next[key] = merged;
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Validate a write body against the schema. Returns the first problem, or null. */
export function validateConfigPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { code: CONFIG_REFUSAL.BAD_BODY, detail: 'body must be a JSON object' };
  }
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS[key]) return { code: CONFIG_REFUSAL.UNKNOWN_KEY, detail: `${key}: ${FORBIDDEN_KEYS[key]}` };
    const validator = CONFIG_SCHEMA[key];
    // Refused, not dropped. A dropped key leaves the caller believing the setting took
    // effect, which is the failure this whole file is written against.
    if (!validator) return { code: CONFIG_REFUSAL.UNKNOWN_KEY, detail: `${key} is not a setting` };
    const problem = validator(patch[key]);
    if (problem) return { code: CONFIG_REFUSAL.BAD_VALUE, detail: `${key}: ${problem}` };
  }
  return null;
}

/**
 * Create the handler.
 *
 * @param {object} options
 * @param {string} options.token Per-install token. Required; there is no unauthenticated mode.
 * @param {() => object} options.read Current config.
 * @param {(next: object) => Promise<void>|void} options.write Persist a validated config.
 * @param {number} [options.maxBodyBytes]
 * @param {string[]} [options.allowedHosts] Hostnames this install answers to.
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createConfigRoute(options) {
  if (typeof options?.token !== 'string' || options.token === '') {
    throw new TypeError('createConfigRoute requires a token; there is no unauthenticated mode');
  }
  if (typeof options.read !== 'function' || typeof options.write !== 'function') {
    throw new TypeError('createConfigRoute requires read() and write()');
  }
  const token = options.token;
  const audit = options.audit ?? (() => {});
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  // The default set is the loopback names a browser will send. Anything else — including a
  // public name that happens to resolve here — is refused.
  const allowedHosts = new Set(options.allowedHosts ?? ['127.0.0.1', 'localhost', '::1']);

  /**
   * @param {object} request
   * @param {string} request.method
   * @param {string} [request.remoteAddress]
   * @param {Record<string,string>} [request.headers]
   * @param {string} [request.body]
   * @returns {Promise<{status: number, body: object}>}
   */
  async function handle(request) {
    const headers = request?.headers ?? {};
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

    // 1. Loopback. First, because it is cheap and because a non-loopback peer should not
    //    learn whether the token was right.
    if (!isLoopback(request?.remoteAddress)) {
      audit('config/refused', { reason: CONFIG_REFUSAL.NOT_LOOPBACK, from: request?.remoteAddress ?? null });
      return { status: 403, body: { reason_code: CONFIG_REFUSAL.NOT_LOOPBACK, detail: 'this route answers loopback peers only' } };
    }

    // 2. Origin and Host. The rebinding defence: a page on another origin reaching 127.0.0.1
    //    sends its own Origin and a matching Host, and both are refused here.
    const origin = lower.origin;
    if (origin !== undefined) {
      let originHost;
      try {
        originHost = hostOnly(new URL(origin).host);
      } catch {
        originHost = null;
      }
      if (originHost === null || !allowedHosts.has(originHost)) {
        audit('config/refused', { reason: CONFIG_REFUSAL.BAD_ORIGIN, origin });
        return { status: 403, body: { reason_code: CONFIG_REFUSAL.BAD_ORIGIN, detail: `origin ${origin} is not this install` } };
      }
    }
    const host = hostOnly(lower.host);
    if (host !== null && !allowedHosts.has(host)) {
      audit('config/refused', { reason: CONFIG_REFUSAL.BAD_ORIGIN, host: lower.host });
      return { status: 403, body: { reason_code: CONFIG_REFUSAL.BAD_ORIGIN, detail: `host ${lower.host} is not this install` } };
    }

    // 3. The token. Loopback is necessary and was the whole of 0.1.0's defence.
    const presented = typeof lower.authorization === 'string' && lower.authorization.startsWith('Bearer ')
      ? lower.authorization.slice('Bearer '.length)
      : '';
    if (presented === '') {
      audit('config/refused', { reason: CONFIG_REFUSAL.NO_TOKEN });
      return { status: 401, body: { reason_code: CONFIG_REFUSAL.NO_TOKEN, detail: 'this route needs the install token' } };
    }
    if (!timingSafeEqual(presented, token)) {
      audit('config/refused', { reason: CONFIG_REFUSAL.BAD_TOKEN });
      return { status: 401, body: { reason_code: CONFIG_REFUSAL.BAD_TOKEN, detail: 'the token was not accepted' } };
    }

    const method = String(request?.method ?? '').toUpperCase();
    if (method === 'GET') {
      return { status: 200, body: { config: redactConfig(options.read()) } };
    }
    if (method !== 'POST') {
      return { status: 405, body: { reason_code: CONFIG_REFUSAL.METHOD, detail: `${method} is not a method this route answers` } };
    }

    const body = typeof request.body === 'string' ? request.body : '';
    if (body.length > maxBodyBytes) {
      // Refused before parsing. Accepting it and then rejecting would still have buffered it.
      return { status: 413, body: { reason_code: CONFIG_REFUSAL.TOO_LARGE, detail: `body exceeds ${maxBodyBytes} bytes` } };
    }
    let patch;
    try {
      patch = JSON.parse(body === '' ? '{}' : body);
    } catch {
      return { status: 400, body: { reason_code: CONFIG_REFUSAL.BAD_BODY, detail: 'body is not valid JSON' } };
    }
    const problem = validateConfigPatch(patch);
    if (problem) {
      audit('config/refused', { reason: problem.code, detail: problem.detail });
      return { status: 400, body: { reason_code: problem.code, detail: problem.detail } };
    }

    const next = mergeConfig(options.read(), patch);
    await options.write(next);
    audit('config/written', { keys: Object.keys(patch) });
    // The write answers with the redacted view, so a form can refresh from the response and
    // never needs a second read of anything secret-bearing.
    return { status: 200, body: { ok: true, config: redactConfig(next) } };
  }

  return { handle };
}
