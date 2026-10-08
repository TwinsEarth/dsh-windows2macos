/**
 * W2M Rabbit relay — node:http / node:https server.
 *
 * PROTOCOL.md §1 endpoints, §3 SSE, §7 errors
 * PROTOCOL-v0.1.2.md §3 deployment params, §4 /healthz, §5 operator token,
 *                     §6 pair rate limit, §7 persistence, §8 SSE hardening.
 *
 * Zero third-party dependencies: only `node:` builtins.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  RabbitState,
  rfc3339,
} from './state.mjs';
import { Persistence } from './persistence.mjs';
import { aggregateTask, buildReport } from './report.mjs';
import { renderMetrics, METRICS_CONTENT_TYPE } from './metrics.mjs';
// v0.3.0 §9: request signing. This import is the entire point of the module --
// until the HTTP layer calls it, HMAC support does not exist for any real request.
import { DEFAULT_SKEW_SECONDS, NonceCache, verifyRequest } from '../signing.mjs';

export const DEFAULT_SSE_KEEPALIVE_MS = 15_000; // §3.2: every 15s a `: keepalive` line
export const DEFAULT_SWEEP_INTERVAL_MS = 1_000;
export const DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE = 5; // v0.1.2 §6
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.w2m');

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** v0.1.2 §3: `/w2m/` → `/w2m`; '' / '/' → '/'. Never returns a trailing slash. */
export function normalizeBasePath(value) {
  if (value === undefined || value === null || value === '') return '/';
  let p = String(value).trim();
  if (p === '' || p === '/') return '/';
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

function normalizePath(pathname) {
  if (!pathname) return '/';
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded) return undefined;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  return res.end(payload);
}

function sendError(res, err) {
  if (err instanceof ProtocolError) {
    const body = err.toBody();
    // §6 just says the 429 "carries retry_after_seconds" without pinning the
    // location, so it is emitted both inside error.detail (the §7 shape) and as a
    // top-level convenience field. Both are additive.
    const retryAfter = err.detail?.retry_after_seconds;
    if (typeof retryAfter === 'number') body.retry_after_seconds = retryAfter;
    sendJson(res, err.status, body, err.headers ?? {});
    return;
  }
  sendJson(res, 500, {
    error: {
      code: 'INTERNAL',
      message: err?.message ? String(err.message) : 'internal error',
      detail: {},
    },
  });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0].trim();
  return first === '' ? null : first;
}

/**
 * Read a request body with a hard byte cap.
 * @returns {Promise<{tooLarge?:boolean, buffer?:Buffer, aborted?:boolean}>}
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ tooLarge: true });
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        finish({ tooLarge: true });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ buffer: Buffer.concat(chunks) }));
    req.on('error', () => finish({ aborted: true }));
    req.on('aborted', () => finish({ aborted: true }));
  });
}

/**
 * Read the raw body bytes with a hard byte cap.
 *
 * v0.3.0 §9: the body is read exactly ONCE per request and the bytes are kept,
 * because an HMAC covers the exact received octets -- re-serialising parsed JSON
 * would produce different bytes (key order, whitespace) and break every signature.
 */
async function readRawBody(req, limit) {
  const body = await readBody(req, limit);
  if (body.tooLarge) {
    throw new ProtocolError('FRAME_TOO_LARGE', `request frame exceeds ${limit} bytes`, { limit_bytes: limit });
  }
  if (body.aborted) throw new ProtocolError('BAD_REQUEST', 'request aborted before the body was complete');
  return body.buffer;
}

/** Parse an already-read body buffer as a JSON object. */
function parseJsonBody(buffer) {
  const raw = buffer === null || buffer === undefined ? '' : buffer.toString('utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ProtocolError('BAD_REQUEST', 'request body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError('BAD_REQUEST', 'request body is not valid JSON', { parse_error: String(err.message) });
  }
}

/** Methods that can carry a body the signature must cover. */
function methodHasBody(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/* ------------------------------------------------------------------ */
/* request signing (v0.3.0 §9)                                         */
/* ------------------------------------------------------------------ */

/**
 * Operator-facing hints. The `code` says what happened; the hint says what to do
 * about it, because "signature mismatch" without a direction is a support ticket.
 */
const SIGNATURE_HINTS = Object.freeze({
  SIGNATURE_REQUIRED: 'this relay runs with --require-signature; sign the request (PROTOCOL-v0.3.0.md §9)',
  SIGNATURE_INCOMPLETE: 'all three of X-W2M-Signature, X-W2M-Timestamp and X-W2M-Nonce must be present together',
  SIGNATURE_MISMATCH: 'the signature matches no configured secret — check for a stale or half-rotated secret',
  SIGNATURE_EXPIRED: 'the timestamp is outside the accepted clock-skew window — check the sending machine clock',
  SIGNATURE_REPLAY: 'this nonce was already used — generate a fresh nonce for every request',
  SIGNATURE_BAD_TIMESTAMP: 'X-W2M-Timestamp must be whole unix seconds',
  SIGNATURE_BAD_NONCE: 'X-W2M-Nonce must be at least 8 characters',
  SIGNING_NOT_CONFIGURED:
    'the relay has --require-signature enabled but no --signing-secret configured; '
    + 'this is a RELAY configuration error, not a client problem',
});

const SIGNATURE_PROTOCOL_CODES = new Set(Object.keys(SIGNATURE_HINTS));

/** Turn a `verifyRequest` rejection into the §7 error envelope.
 *  `ProtocolError` resolves the HTTP status from `ERROR_STATUS`, so the mapping
 *  table lives in exactly one place (state.mjs) instead of being duplicated here. */
function signatureError(decision) {
  const code = SIGNATURE_PROTOCOL_CODES.has(decision.code) ? decision.code : 'SIGNATURE_MISMATCH';
  return new ProtocolError(code, decision.error, {
    code,
    reason: decision.error,
    hint: SIGNATURE_HINTS[code] ?? null,
  });
}

/**
 * Read an optional secret, failing loudly on a value that is present but unusable.
 *
 * `signing.mjs` calls a silently-disabled secret the failure mode it exists to
 * prevent. Treating `signingSecret: 12345` (or `{}`) as "not configured" would do
 * exactly that at the wiring layer, so it is an error instead.
 */
function readSecretValue(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ProtocolError('BAD_REQUEST',
      `${label} must be a non-empty string when provided (got ${typeof value}); `
      + 'refusing to silently run without the signing you asked for', { option: label, received_type: typeof value });
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* pair rate limiting (v0.1.2 §6)                                      */
/* ------------------------------------------------------------------ */

/**
 * Per-IP sliding window. Successful pairs count too, otherwise a working pairing
 * code could be used to flush the failure budget.
 */
export class SlidingWindowRateLimiter {
  constructor({ limit = DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE, windowMs = RATE_LIMIT_WINDOW_MS, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this._now = now;
    /** @type {Map<string, number[]>} */
    this.buckets = new Map();
  }

  get windowSeconds() { return Math.round(this.windowMs / 1000); }

  /** Records one attempt and reports whether it is allowed. */
  hit(key) {
    if (this.limit <= 0) {
      return { allowed: true, retry_after_seconds: 0, limit: 0, window_seconds: this.windowSeconds, remaining: Infinity };
    }
    const now = this._now();
    const cutoff = now - this.windowMs;
    let hits = this.buckets.get(key);
    if (!hits) {
      hits = [];
      this.buckets.set(key, hits);
    }
    while (hits.length > 0 && hits[0] <= cutoff) hits.shift();

    if (hits.length >= this.limit) {
      const retryMs = hits[0] + this.windowMs - now;
      return {
        allowed: false,
        retry_after_seconds: Math.max(1, Math.ceil(retryMs / 1000)),
        limit: this.limit,
        window_seconds: this.windowSeconds,
        remaining: 0,
      };
    }
    hits.push(now);
    return {
      allowed: true,
      retry_after_seconds: 0,
      limit: this.limit,
      window_seconds: this.windowSeconds,
      remaining: this.limit - hits.length,
    };
  }

  /** Drop idle buckets so a long-running relay cannot leak memory. */
  prune() {
    const cutoff = this._now() - this.windowMs;
    for (const [key, hits] of this.buckets) {
      while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
      if (hits.length === 0) this.buckets.delete(key);
    }
  }

  reset() { this.buckets.clear(); }
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

export class RelayServer {
  constructor(options = {}) {
    this.options = options;
    this.basePath = normalizeBasePath(options.basePath);
    this.trustProxy = options.trustProxy === true;
    this.frameLimitBytes = options.frameLimitBytes ?? MAX_FRAME_BYTES;
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_SSE_KEEPALIVE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.pairRateLimitPerMinute = Number.isFinite(options.pairRateLimitPerMinute)
      ? options.pairRateLimitPerMinute : DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE;

    // §3: `logger: null` silences. The default writes to STDERR on purpose —
    // stdout belongs to protocol output (e.g. the CLI's `--json` line), and mixing
    // prose into it breaks `| ConvertFrom-Json` / `| jq`.
    this.logger = options.logger === undefined
      ? ((msg) => process.stderr.write(`${msg}\n`))
      : options.logger;
    this.startupMessages = [];

    /* ---- persistence (§7) ---- */
    const rawStateDir = options.stateDir ?? (typeof options.state === 'string' ? options.state : null);
    const persistEnabled = options.persist !== false && rawStateDir !== '';
    const stateDir = persistEnabled
      ? path.resolve(rawStateDir === null || rawStateDir === undefined ? DEFAULT_STATE_DIR : String(rawStateDir))
      : null;
    this.persistence = new Persistence({
      dir: stateDir,
      now: () => (this.state ? this.state.nowMs() : Date.now()),
    });

    /* ---- state ---- */
    const injected = options.state && typeof options.state === 'object' ? options.state : null;
    this.state = injected ?? new RabbitState({ ...options, persistence: this.persistence });
    this.state.setPersistence(this.persistence);

    this.relayId = this.state.relayId;
    this._startedAtMs = this.state.nowMs();

    /* ---- startup recovery (§7) ---- */
    if (this.persistence.enabled) {
      const snapshot = this.persistence.loadDevices();
      this.persistence.devicesMissing = snapshot.missing;
      const ledger = this.persistence.loadLedger();
      const revived = this.state.restore({ devices: snapshot.devices, ledger });
      this.persistence.revivedDevices = revived.revived_devices;
      this.persistence.revivedTasks = revived.revived_tasks;
    }

    /* ---- operator token (§5) ---- */
    this._initOperatorToken(options);

    /* ---- v0.3.0 §9 request signing ---- */
    this.signingSecrets = [
      readSecretValue(options.signingSecret, 'signingSecret'),
      readSecretValue(options.signingSecretPrevious, 'signingSecretPrevious'),
    ].filter((s) => s !== null); // newest first: keyIndex 0 = current, 1 = previous
    this.signingConfigured = this.signingSecrets.length > 0;
    this.requireSignature = options.requireSignature === true;
    /**
     * v0.3.3: whether `GET /metrics` exists.
     *
     * Defaults to off. A monitoring endpoint that appears without being asked for is a surface nobody
     * chose, and the operator can turn it on with `--metrics` when a scraper exists.
     */
    this.metricsEnabled = options.metrics === true;
    this.signatureSkewSeconds = Number.isFinite(options.signatureSkewSeconds)
      ? options.signatureSkewSeconds : DEFAULT_SKEW_SECONDS;
    // One cache per relay instance: replay defence is stateful, and two relays
    // sharing a cache would let a nonce blocked on one be replayed on the other.
    this.nonceCache = options.nonceCache ?? new NonceCache({
      max: options.nonceCacheMax ?? 20_000,
      retentionMs: options.nonceCacheRetentionMs ?? 10 * 60_000,
    });
    this.nonceRetentionMs = options.nonceCacheRetentionMs ?? 10 * 60_000;

    /* ---- /v1/pair rate limit (§6) ---- */
    this.pairLimiter = new SlidingWindowRateLimiter({
      limit: this.pairRateLimitPerMinute,
      windowMs: RATE_LIMIT_WINDOW_MS,
      now: () => this.state.nowMs(),
    });

    /* ---- transport ---- */
    this.tlsCertPath = options.tlsCert ?? null;
    this.tlsKeyPath = options.tlsKey ?? null;
    if ((this.tlsCertPath && !this.tlsKeyPath) || (!this.tlsCertPath && this.tlsKeyPath)) {
      throw new ProtocolError('BAD_REQUEST', 'tlsCert and tlsKey must be provided together', {
        tls_cert: this.tlsCertPath, tls_key: this.tlsKeyPath,
      });
    }
    const handler = (req, res) => {
      this.handle(req, res).catch((err) => this.reportError(req, res, err));
    };
    if (this.tlsCertPath) {
      let cert;
      let key;
      try {
        cert = fs.readFileSync(this.tlsCertPath);
        key = fs.readFileSync(this.tlsKeyPath);
      } catch (err) {
        // Never silently fall back to plain HTTP: that would be a security downgrade.
        throw new ProtocolError('BAD_REQUEST', `cannot read TLS material: ${err.message}`, {
          tls_cert: this.tlsCertPath, tls_key: this.tlsKeyPath,
        });
      }
      this.server = https.createServer({ cert, key }, handler);
      this.scheme = 'https';
    } else {
      this.server = http.createServer(handler);
      this.scheme = 'http';
    }

    // v0.1.2 BUG-1: an externally supplied code must be REGISTERED, not merely
    // assigned — otherwise the banner advertises a code /v1/pair does not know.
    this.pairingCode = typeof options.pairingCode === 'string' && options.pairingCode.trim() !== ''
      ? this.state.registerPairingCode(options.pairingCode, { ttlMs: options.pairingCodeTtlMs })
      : this.state.createPairingCode();
    this.subscribers = new Set();
    this.host = null;
    this.port = null;
    this._sweepTimer = null;

    // SSE connections are long-lived: never let Node time the request out.
    this.server.requestTimeout = options.requestTimeoutMs ?? 0;
    this.server.headersTimeout = options.headersTimeoutMs ?? 60_000;

    this._buildStartupMessages();
  }

  /**
   * Diagnostics sink. `logger: null` is the documented "silent" value, and a
   * caller-supplied logger may throw — neither may break a request. (A direct
   * `this.logger(...)` call after `res.writeHead()` once threw a TypeError that
   * surfaced as "Cannot write headers after they are sent to the client".)
   */
  _log(message) {
    if (typeof this.logger !== 'function') return;
    try {
      this.logger(message);
    } catch { /* a broken logger must never break the relay */ }
  }

  /**
   * Last-resort error path for a request whose handler rejected.
   * Once the status line is on the wire (SSE, streamed report) the response can no
   * longer be rewritten — the only honest action is to end the stream, loudly.
   */
  reportError(req, res, err) {
    if (res.headersSent) {
      this._log(`[w2m-rabbit] !! error after the response had started on ${req.method} ${req.url}: `
        + `${err?.stack ?? err}`);
      try { res.end(); } catch { /* already gone */ }
      return;
    }
    sendError(res, err);
  }

  _initOperatorToken(options) {
    const wantsRequired = options.operatorTokenRequired !== false;
    const explicit = options.operatorToken;
    const persisted = this.persistence.enabled ? this.persistence.readOperatorToken() : null;

    if (!wantsRequired || explicit === '') {
      this.operatorToken = null;
      this.operatorTokenRequired = false;
      this.operatorTokenSource = 'disabled';
      return;
    }
    this.operatorTokenRequired = true;
    if (typeof explicit === 'string' && explicit.length > 0) {
      this.operatorToken = explicit;
      this.operatorTokenSource = 'option';
      this.persistence.writeOperatorToken(explicit);
      return;
    }
    if (persisted) {
      // §5.1 + §7: keep the token stable across restarts, otherwise every restart
      // would silently invalidate the plugin's configured operatorToken.
      this.operatorToken = persisted;
      this.operatorTokenSource = 'restored';
      return;
    }
    this.operatorToken = randomBytes(32).toString('hex');
    this.operatorTokenSource = 'generated';
    this.persistence.writeOperatorToken(this.operatorToken);
  }

  _buildStartupMessages() {
    const m = this.startupMessages;
    m.push(`[w2m-rabbit] relay_id=${this.relayId}`);
    m.push(`[w2m-rabbit] base_path=${this.basePath}${this.basePath === '/' ? ' (root)' : ''}`);
    m.push(`[w2m-rabbit] trust_proxy=${this.trustProxy}${this.trustProxy ? '' : ' (X-Forwarded-* ignored)'}`);
    m.push(`[w2m-rabbit] pair_rate_limit=${this.pairRateLimitPerMinute === 0 ? 'disabled' : `${this.pairRateLimitPerMinute}/min/IP`}`);
    // §9: report the posture, never the material.
    if (this.signingConfigured) {
      m.push(`[w2m-rabbit] request signing=ON (${this.signingSecrets.length} secret(s)`
        + `${this.signingSecrets.length > 1 ? ', rotation active' : ''})`
        + `${this.requireSignature ? ' - REQUIRED: unsigned /v1/* is rejected with 401' : ' - optional: unsigned requests are still accepted'}`);
    } else if (this.requireSignature) {
      m.push('[w2m-rabbit] !! CONFIGURATION ERROR: --require-signature is set but no --signing-secret was provided. '
        + 'Every /v1/* request will fail with 500 SIGNING_NOT_CONFIGURED (this is the RELAY\'s fault, not the client\'s). '
        + 'Either set --signing-secret or drop --require-signature.');
    } else {
      m.push('[w2m-rabbit] request signing=off (no signing secret configured; behaviour is identical to v0.2.3)');
    }
    if (this.persistence.enabled) {
      m.push(`[w2m-rabbit] persistence=on dir=${this.persistence.dir} `
        + `revived_devices=${this.persistence.revivedDevices} revived_tasks=${this.persistence.revivedTasks}`);
    } else {
      m.push('[w2m-rabbit] persistence=off (in-memory only; devices and tasks are lost on restart)');
    }
    if (this.persistence.devicesCorrupt) {
      m.push('[w2m-rabbit] !! WARNING: devices.json was CORRUPT — started from an EMPTY device table; '
        + 'every machine must pair again. The damaged file was left untouched.');
    }
    for (const w of this.persistence.warnings) {
      m.push(`[w2m-rabbit] !! ${w.file}: ${w.message}`);
    }
    if (this.operatorTokenRequired) {
      m.push(`[w2m-rabbit] operator token (${this.operatorTokenSource}) - required for POST /v1/task:`);
      m.push(`[w2m-rabbit]   ${this.operatorToken}`);
      if (this.persistence.operatorTokenFile) {
        m.push(`[w2m-rabbit]   stored at ${this.persistence.operatorTokenFile} (0600)`);
      }
    } else {
      m.push('[w2m-rabbit] !! WARNING: OPERATOR TOKEN DISABLED (--operator-token "") - '
        + 'any device that can reach this relay can dispatch tasks to the whole group. '
        + 'Only acceptable on a trusted LAN / for debugging; /v1/task then requires a device token.');
    }
  }

  get url() {
    if (this.host === null || this.port === null) return null;
    const host = this.host.includes(':') ? `[${this.host}]` : this.host;
    const prefix = this.basePath === '/' ? '' : this.basePath;
    return `${this.scheme}://${host}:${this.port}${prefix}`;
  }

  listen({ host = '127.0.0.1', port = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', onError);
        const addr = this.server.address();
        this.host = addr.address;
        this.port = addr.port;
        this._sweepTimer = setInterval(() => {
          this.maintenance();
        }, this.sweepIntervalMs);
        this._sweepTimer.unref?.();
        if (this.logger) {
          this._log(`[w2m-rabbit] listening on ${this.url}  pairing code: ${this.pairingCode}`);
          for (const message of this.startupMessages) this._log(message);
        }
        resolve({
          host: this.host,
          port: this.port,
          url: this.url,
          pairingCode: this.pairingCode,
          relayId: this.relayId,
          basePath: this.basePath,
          operatorToken: this.operatorToken,
          operatorTokenRequired: this.operatorTokenRequired,
          scheme: this.scheme,
        });
      });
    });
  }

  sweep() {
    return this.state.sweepExpired();
  }

  close() {
    return new Promise((resolve) => {
      if (this._sweepTimer) clearInterval(this._sweepTimer);
      this._sweepTimer = null;
      for (const sub of [...this.subscribers]) this._closeSubscriber(sub);
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  /* ---------------- proxy awareness (v0.1.2 §3) ---------------- */

  /** `X-Forwarded-For` first hop is honoured ONLY under `trustProxy`. */
  clientIp(req) {
    if (this.trustProxy) {
      const forwarded = firstHeaderValue(req.headers['x-forwarded-for']);
      if (forwarded) return forwarded;
    }
    return req.socket?.remoteAddress ?? 'unknown';
  }

  /** `X-Forwarded-Proto` is honoured ONLY under `trustProxy`. */
  effectiveScheme(req) {
    if (this.trustProxy) {
      const proto = firstHeaderValue(req.headers['x-forwarded-proto']);
      if (proto) return proto.toLowerCase();
    }
    return this.scheme;
  }

  /* ---------------- request dispatch ---------------- */

  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      throw new ProtocolError('BAD_REQUEST', 'malformed request URL');
    }
    const rawPath = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // §3: strip the deployment prefix, then route. `/healthz` also answers at the
    // root because health checks are usually pointed straight at the container.
    // `stripped` keeps the literal request path (no trailing-slash normalisation)
    // because that is what a signature covers; `path` is the normalised route key.
    let stripped;
    if (this.basePath === '/') {
      stripped = rawPath;
    } else if (rawPath === this.basePath) {
      stripped = '/';
    } else if (rawPath.startsWith(`${this.basePath}/`)) {
      stripped = rawPath.slice(this.basePath.length);
    } else if (rawPath === '/healthz') {
      stripped = '/healthz';
    } else {
      // Outside the prefix: an explicit 404, never a gateway-style 502.
      throw new ProtocolError('NOT_FOUND', `path is outside the configured base path ${this.basePath}`, {
        path: rawPath, base_path: this.basePath,
      });
    }
    const path = normalizePath(stripped);
    const signedPath = `${stripped}${url.search}`;

    // v0.3.0 §9: read the body ONCE, before routing. An HMAC covers the exact
    // received bytes, so no route may consume the stream first and re-serialise.
    const rawBody = methodHasBody(method) ? await readRawBody(req, this.frameLimitBytes) : null;
    const takeJson = () => parseJsonBody(rawBody);

    /* ---- public endpoints ---- */
    // `/healthz` and `/v1/pair` are permanently exempt from signature checks:
    // the first is an operations probe that must not need credentials, the second
    // is the bootstrap step that happens before the two sides share a secret.
    if (method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, this.healthBody(req));
    }
    if (method === 'POST' && path === '/v1/pair') {
      this.enforcePairRateLimit(req);
      const result = this.state.pair(takeJson());
      return sendJson(res, 200, result);
    }
    /**
     * v0.3.3 `/metrics`: machine-readable fleet state for a monitoring system.
     *
     * Token-free, like `/healthz` and for the same reason: a scraper that needs the operator token
     * would put that token in a Prometheus config file, which is a credential in a place nobody
     * reviews. It is also exempt from signature checks for the same reason -- there is no secret to
     * sign with on the scraper side.
     *
     * Exposed only when the relay was asked for it (`--metrics`). A monitoring endpoint that appears
     * by default is a surface nobody chose, and the whole point of the defaults elsewhere is that the
     * relay binds nothing the operator did not ask for.
     */
    if (method === 'GET' && path === '/metrics') {
      if (!this.metricsEnabled) {
        // 404 rather than 403: a disabled endpoint should look absent, not forbidden. A 403 tells a
        // scanner the surface exists.
        throw new ProtocolError('NOT_FOUND', 'metrics are not enabled on this relay', { hint: 'start the relay with --metrics' });
      }
      const body = renderMetrics(this.state, { nowMs: this.state.nowMs() });
      res.writeHead(200, {
        'content-type': METRICS_CONTENT_TYPE,
        'content-length': Buffer.byteLength(body, 'utf8'),
        'cache-control': 'no-store',
      });
      return res.end(body);
    }
    // §5: dispatching tasks needs the operator token, not a device token.
    if (method === 'POST' && path === '/v1/task') {
      const principal = this.authorizeTaskDispatch(req);
      this.enforceSignature(req, { method, signedPath, body: rawBody });
      const body = takeJson();
      if (principal.machine_id && !body.created_by) body.created_by = principal.machine_id;
      const result = this.state.createTask(body);
      return sendJson(res, 200, result);
    }

    /* ---- everything below requires `Authorization: Bearer <device_token>` ---- */
    const token = bearerToken(req);
    const device = token ? this.state.authenticate(token) : null;
    if (!device) {
      throw new ProtocolError('UNAUTHORIZED', 'missing or invalid device_token', {});
    }
    this.state.touchDevice(device.machine_id);

    // v0.3.0 §9: writes are always checked (tolerating unsigned unless required);
    // reads are only checked when the relay was explicitly told to require
    // signatures. See `enforceSignature` for the reasoning.
    this.enforceSignature(req, { method, signedPath, body: rawBody });

    if (method === 'GET' && path === '/v1/stream') {
      return this.handleStream(req, res, url, device);
    }
    if (method === 'POST' && path === '/v1/heartbeat') {
      const body = takeJson();
      body.machine_id = body.machine_id ?? device.machine_id;
      const result = this.state.heartbeat(body);
      return sendJson(res, 200, result);
    }
    if (method === 'POST' && path === '/v1/result') {
      const body = takeJson();
      const result = this.state.submitResult(body);
      const { _instanceKey, ...clean } = result;
      return sendJson(res, 200, clean);
    }
    if (method === 'GET' && path === '/v1/devices') {
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        devices: this.state.listDevices(),
      });
    }
    if (method === 'GET' && path === '/v1/tasks') {
      const rawLimit = url.searchParams.get('limit');
      let limit = 50;
      if (rawLimit !== null) {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1) {
          throw new ProtocolError('BAD_REQUEST', 'limit must be a positive integer', { limit: rawLimit });
        }
      }
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        tasks: this.state.listTasks({ limit }),
      });
    }

    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    const reportMatch = /^\/v1\/tasks\/([^/]+)\/report$/.exec(path);
    // v0.3.0: cross-machine RTT status. The plugin may run on a different machine
    // than the agent, so this has to come from the relay, not from a local file.
    const agentStatusMatch = /^\/v1\/agents\/([^/]+)\/status$/.exec(path);

    if (method === 'GET' && agentStatusMatch) {
      const machineId = decodeURIComponent(agentStatusMatch[1]);
      const status = this.state.deviceStatus(machineId);
      if (!status) {
        throw new ProtocolError('NOT_FOUND', 'unknown machine_id', { machine_id: machineId });
      }
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        ...status,
      });
    }

    if (method === 'GET' && reportMatch) {
      const taskId = decodeURIComponent(reportMatch[1]);
      this.state.sweepExpired();
      const format = url.searchParams.get('format') ?? 'json';
      const report = buildReport(this.state, taskId, { format });
      if (res.writableEnded) return undefined;
      res.writeHead(200, {
        'content-type': report.contentType,
        'content-length': Buffer.byteLength(report.body, 'utf8'),
        'cache-control': 'no-store',
      });
      return res.end(report.body);
    }

    if (method === 'GET' && taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      this.state.sweepExpired();
      const task = this.state.requireTask(taskId);
      const aggregate = aggregateTask(this.state, taskId);
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        task: this.state.taskSummary(task),
        leases: [...task.leases.values()],
        aggregate,
      });
    }

    throw new ProtocolError('NOT_FOUND', `no route for ${method} ${path}`, { method, path });
  }

  /** §4: the operations answer — "is the relay there, did it restart, are my machines connected". */
  healthBody(req) {
    return {
      ...this.state.stats(),
      ok: true,
      protocol_version: PROTOCOL_VERSION,
      rabbit_time: this.state.nowIso(),
      uptime_ms: this.state.nowMs() - this._startedAtMs,
      relay_id: this.relayId,
      started_at: rfc3339(this._startedAtMs),
      effective_scheme: this.effectiveScheme(req),
      base_path: this.basePath,
      operator_token_required: this.operatorTokenRequired,
      pair_rate_limit: this.pairRateLimitPerMinute,
      // v0.3.0: fleet-wide latency. Every numeric field is null (never 0) when no
      // machine has reported a FRESH measurement.
      rtt: this.state.rttSummary(),
      // v0.3.0 §9: signature status only — never the secret, not even a prefix.
      signing: {
        configured: this.signingConfigured,
        required: this.requireSignature,
        previous_secret_accepted: this.signingSecrets.length > 1,
        skew_seconds: this.signatureSkewSeconds,
      },
      persistence: this.persistence.describe(),
    };
  }

  /* ---------------- request signing (v0.3.0 §9) ---------------- */

  /**
   * Should this request be signature-checked at all?
   *
   * RULING (see PROTOCOL-v0.3.0.md §9.4): every WRITE is checked; READS are
   * checked only when `--require-signature` is on.
   *
   * Reads are not checked in the default modes because unsigned reads are
   * accepted anyway, so "verify when a signature happens to be present" would be
   * theatre -- an attacker simply omits the headers -- while adding a brand new
   * way for a poll or an SSE reconnect to fail. What a read leaks is topology,
   * which the device token already gates; what a write can do is change state,
   * which is what replay and tampering actually threaten.
   */
  shouldCheckSignature(method) {
    if (this.requireSignature) return true; // explicit hard mode: nothing is exempt
    const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    return !isRead;
  }

  /** Run `verifyRequest` and throw the mapped §7 error on rejection. */
  enforceSignature(req, { method, signedPath, body }) {
    if (!this.shouldCheckSignature(method)) return { skipped: true };
    const decision = this.verifySignature(req, { method, signedPath, body });
    if (decision.ok !== true) throw signatureError(decision);
    return decision;
  }

  /**
   * Thin adapter over the frozen `signing.mjs` contract.
   *
   * `path` is the ROUTED path with the query string, NOT the raw request URL: with
   * `--base-path /w2m` the same client must produce the same signature whether a
   * proxy passes `/w2m/v1/result` through or strips it to `/v1/result`. The routed
   * path is the only value both sides agree on in all three deployment forms, so
   * clients sign `/v1/result` and never `https://host/w2m/v1/result`.
   */
  verifySignature(req, { method, signedPath, body }) {
    return verifyRequest({
      headers: req.headers, // plain Node object; signing.mjs reads it case-insensitively
      method,
      path: signedPath,
      body: body ?? '',
      secrets: this.signingSecrets,
      nonces: this.nonceCache,
      nowMs: this.state.nowMs(),
      skewSeconds: this.signatureSkewSeconds,
      required: this.requireSignature,
    });
  }

  /** Periodic maintenance, called by the sweep timer. */
  maintenance() {
    const expired = this.sweep();
    this.pairLimiter.prune();
    // Keep the nonce cache from growing without bound in a long-running process.
    this.nonceCache.prune(this.nonceRetentionMs, this.state.nowMs());
    return expired;
  }

  /* ---------------- auth helpers ---------------- */

  /** §6: every /v1/pair attempt counts, success included. */
  enforcePairRateLimit(req) {
    if (this.pairRateLimitPerMinute <= 0) return;
    const ip = this.clientIp(req);
    const verdict = this.pairLimiter.hit(ip);
    if (verdict.allowed) return;
    const err = new ProtocolError(
      'RATE_LIMITED',
      `too many /v1/pair attempts from ${ip}: limit is ${verdict.limit} per ${verdict.window_seconds}s`,
      {
        retry_after_seconds: verdict.retry_after_seconds,
        limit: verdict.limit,
        window_seconds: verdict.window_seconds,
        scope: 'pair',
      },
    );
    err.headers = { 'retry-after': String(verdict.retry_after_seconds) };
    throw err;
  }

  /**
   * §5: `POST /v1/task` needs the operator token.
   *  - required (default): operator token, else 401 OPERATOR_REQUIRED
   *  - disabled (`--operator-token ''`): falls back to v1 semantics, i.e. a paired device token
   */
  authorizeTaskDispatch(req) {
    const token = bearerToken(req);
    if (this.operatorTokenRequired) {
      if (!token) {
        throw new ProtocolError(
          'OPERATOR_REQUIRED',
          'POST /v1/task requires the operator token. A device_token is machine credentials and cannot '
          + `dispatch tasks; read the operator token from ${this.persistence.operatorTokenFile ?? '<state>/operator-token.txt'} `
          + 'or pass --operator-token / W2M_OPERATOR_TOKEN.',
          { operator_token_file: this.persistence.operatorTokenFile ?? null },
        );
      }
      if (token !== this.operatorToken) {
        const asDevice = this.state.authenticate(token);
        throw new ProtocolError(
          'OPERATOR_REQUIRED',
          asDevice
            ? 'this is a device_token (machine credentials); dispatching tasks requires the operator_token — '
              + 'they are two different credentials'
            : 'invalid operator token: it does not match the relay operator token',
          {
            device_token_detected: Boolean(asDevice),
            machine_id: asDevice?.machine_id ?? null,
            operator_token_file: this.persistence.operatorTokenFile ?? null,
          },
        );
      }
      return { role: 'operator', machine_id: null };
    }
    const device = token ? this.state.authenticate(token) : null;
    if (!device) {
      throw new ProtocolError(
        'UNAUTHORIZED',
        'the operator token requirement is disabled on this relay, but /v1/task still requires a valid device_token',
        {},
      );
    }
    return { role: 'device', machine_id: device.machine_id };
  }

  /* ---------------- SSE (§3) ---------------- */

  handleStream(req, res, url, device) {
    const machineId = device.machine_id;
    const requested = url.searchParams.get('machine_id');
    if (requested !== null && requested !== machineId) {
      throw new ProtocolError('BAD_REQUEST', 'machine_id does not match the device_token', {
        machine_id: requested, token_machine_id: machineId,
      });
    }

    let from = null;
    const seqParam = url.searchParams.get('seq');
    const lastEventId = req.headers['last-event-id'];
    if (seqParam !== null) {
      from = Number(seqParam);
      if (!Number.isInteger(from) || from < 1) {
        throw new ProtocolError('BAD_REQUEST', 'seq must be a positive integer', { seq: seqParam });
      }
    } else if (typeof lastEventId === 'string' && lastEventId.trim() !== '') {
      const last = Number(lastEventId);
      if (!Number.isInteger(last) || last < 0) {
        throw new ProtocolError('BAD_REQUEST', 'Last-Event-ID must be a non-negative integer', { last_event_id: lastEventId });
      }
      from = last + 1;
    }

    // §8.5: these two headers are the fix for "connects but no events" behind
    // nginx-style proxies and tunnels, which buffer event streams by default.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const sub = { machineId, res, write: null, timer: null, closed: false };

    const writeEvent = (event) => {
      if (res.writableEnded) return;
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    let live = false;
    const queue = [];
    const deliver = (entry) => {
      if (entry.target && entry.target !== machineId) return;
      writeEvent(entry.event);
    };
    const unsubscribe = this.state.onEvent((entry) => {
      if (!live) { queue.push(entry); return; }
      deliver(entry);
    });

    // §3.1: the first frame MUST be `ready`; §8.3 adds `relay_id`.
    const readySeq = this.state.reserveSeq();
    writeEvent({
      type: 'ready',
      seq: readySeq,
      protocol_version: PROTOCOL_VERSION,
      rabbit_time: this.state.nowIso(),
      machine_id: machineId,
      relay_id: this.relayId,
    });

    if (from !== null) {
      const oldest = this.state.oldestBufferedSeq();
      const lastBuffered = this.state.lastBufferedSeq();
      // `fromFuture` is judged against EVERY seq this process has allocated (a client
      // can legitimately hold a `ready` seq, which is not buffered), while the
      // reported window bounds describe the replay ring the client can actually use.
      const lastSeq = this.state.lastSeq();
      // Two distinct ways for a cursor to be out of sync with THIS process:
      //
      //   from < oldest     the cursor is older than the replay window (buffer rot)
      //   from > lastSeq+1  the cursor cannot exist here at all. Sequence numbers
      //                     restart at 1 in every process, so a cursor from a
      //                     previous relay process is AHEAD of a freshly started
      //                     relay. This was the silent case: `13 < 1` is false, the
      //                     client got no notice, `replayEntries(13)` matched
      //                     nothing, and the agent then reset its cursor to the
      //                     `ready` seq -- stepping over every event it had missed.
      const tooOld = from < oldest && oldest > 1;
      const fromFuture = from > lastSeq + 1;
      if (tooOld || fromFuture) {
        // §8.4: tell the client where to re-align, not just that replay failed.
        writeEvent({
          type: 'notice',
          seq: this.state.reserveSeq(),
          rabbit_time: this.state.nowIso(),
          level: 'warn',
          code: 'REPLAY_TRUNCATED',
          message: tooOld
            ? `requested seq ${from} is older than the buffer head ${oldest}`
            : `requested seq ${from} is beyond this process' last seq ${lastSeq}: the cursor came from a `
              + 'previous relay process, whose sequence numbering restarted at 1',
          machine_id: machineId,
          requested_seq: from,
          oldest_available_seq: oldest,
          last_available_seq: lastBuffered,
          relay_id: this.relayId,
          reason: tooOld ? 'buffer_truncated' : 'cursor_ahead_of_relay',
        });
      }
      // A cursor from a previous process is meaningless here, so honouring it
      // literally (replay from `from`) would deliver NOTHING and also lose every
      // event that fell into the gap -- not only offers, but `task.cancel`,
      // `notice`, `peer.*`. Re-align to the head of the window instead: the client
      // asked to be resynchronised, and the ring is exactly what we still have.
      const replayFrom = fromFuture ? oldest : from;
      for (const entry of this.state.replayEntries(replayFrom)) deliver(entry);
    }

    live = true;
    for (const entry of queue) deliver(entry);
    queue.length = 0;

    // §8.6: re-state work this machine was handed while its stream was down.
    //
    // An offer is a single event; if the stream is not connected at that instant
    // -- after a relay restart, a tunnel drop, or any interruption -- the event
    // is lost and the lease waits out its whole window before being swept. The
    // machine is meanwhile online and idle. Re-delivering on connect is what
    // makes a reconnect recover work instead of silently losing it.
    //
    // Only unclaimed leases are re-offered; `running` is excluded so a task that
    // has already begun cannot be handed out a second time and executed twice.
    const redelivered = this.state.redeliverPendingOffers(machineId);
    if (redelivered.count > 0) {
      this._log(`[w2m-rabbit] re-offered ${redelivered.count} pending task(s) to ${machineId} on reconnect`);
    }

    // §3.2: `: keepalive` comment every 15s.
    sub.timer = setInterval(() => {
      if (res.writableEnded) return;
      res.write(': keepalive\n\n');
    }, this.keepaliveMs);
    sub.timer.unref?.();

    sub.write = writeEvent;
    sub.unsubscribe = unsubscribe;
    this.subscribers.add(sub);
    device.streams = (device.streams ?? 0) + 1;
    // v0.3.0: relay-observed reconnect counter. A first attach is not a reconnect,
    // so the reported `reconnect_attempts` is (attaches - 1).
    this.state.noteStreamConnect(machineId);

    const onClose = () => this._closeSubscriber(sub);
    req.on('close', onClose);
    res.on('close', onClose);
    res.on('error', onClose);
    return undefined;
  }

  _closeSubscriber(sub) {
    if (!sub || sub.closed) return;
    sub.closed = true;
    this.subscribers.delete(sub);
    if (sub.timer) clearInterval(sub.timer);
    sub.timer = null;
    sub.unsubscribe?.();
    const device = this.state.devices.get(sub.machineId);
    if (device) {
      device.streams = Math.max(0, (device.streams ?? 1) - 1);
      if (device.streams === 0) this.state.setOnline(sub.machineId, false, 'stream_closed');
    }
    if (!sub.res.writableEnded) {
      try { sub.res.end(); } catch { /* already gone */ }
    }
  }
}

/** Convenience factory. */
export function createRelayServer(options = {}) {
  return new RelayServer(options);
}

/** Create + listen in one call. */
export async function startRelayServer(options = {}) {
  const relay = createRelayServer(options);
  await relay.listen(options);
  return relay;
}

export {
  Persistence,
  ProtocolError,
  RabbitState,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  rfc3339,
};
export default createRelayServer;
