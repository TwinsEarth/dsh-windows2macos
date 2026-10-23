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
import { createHash, randomBytes } from 'node:crypto';

import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  RabbitState,
  rfc3339,
} from './state.mjs';

// v1.2.7: the content-addressed blob channel carries ARTIFACTS, so its frame limit cannot be the JSON frame limit.
//
// MAX_FRAME_BYTES (64 KiB) is exactly the inline threshold: any blob is larger than an inline result by construction, so with
// one shared limit the blob channel could never accept a single byte -- a pipeline blob upload from a real relay failed with
// FRAME_TOO_LARGE while the fake relay in the tests accepted it. The dataflow hard cap stays the agent-side bound; this is the
// transport bound, and it is still bounded.
export const BLOB_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB per blob frame -- the same cap the agent's dataflow plan uses.
//
// v1.2.8-beta.1: it was 1 MiB while the agent's hard cap is 16 MiB, so an artifact between the two failed its upload with
// BLOB_UPLOAD_FAILED even though the agent had accepted it. One number for "how large may one artifact be" is the honest shape;
// the JSON frame limit stays 64 KiB for every other route.
import { createFleetMessages } from './fleet-messages.mjs';
import { can as mayAct } from '../util/policy-matrix.mjs';
import { createFleetMemory } from './fleet-memory.mjs';
import { createJoinChallenges } from './join-challenge.mjs';
import { createAdmission } from './admission.mjs';
import { Persistence } from './persistence.mjs';
import { PeerRegistry } from './peers.mjs';
import { aggregateTask, buildReport } from './report.mjs';
import { renderMetrics, METRICS_CONTENT_TYPE } from './metrics.mjs';
// v0.3.0 §9: request signing. This import is the entire point of the module --
// until the HTTP layer calls it, HMAC support does not exist for any real request.
import { DEFAULT_SKEW_SECONDS, NonceCache, verifyRequest } from '../signing.mjs';
// v0.7.11: per-device Ed25519 verification, tried before the shared secret.
import {
  SIGNATURE_HEADER as DEVICE_SIGNATURE_HEADER,
  verifyDeviceSignature,
} from '../chatops/device-signing.mjs';

export const DEFAULT_SSE_KEEPALIVE_MS = 15_000; // §3.2: every 15s a `: keepalive` line
export const DEFAULT_SWEEP_INTERVAL_MS = 1_000;
export const DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE = 5; // v0.1.2 §6
// The window length is a unit and lives with the limiter. Both names are kept: `DEFAULT_WINDOW_MS` is the
// local binding this module uses, and `RATE_LIMIT_WINDOW_MS` is the name this module has always exported.
// `export ... from` would NOT have worked here -- it re-exports without creating a local binding, so the
// constructor below saw `RATE_LIMIT_WINDOW_MS is not defined` while the export itself looked fine.
import { DEFAULT_WINDOW_MS, SlidingWindowRateLimiter } from '../util/rate-limit.mjs';
export { DEFAULT_WINDOW_MS as RATE_LIMIT_WINDOW_MS };
export const DEFAULT_STATE_DIR = path.join(os.homedir(), '.w2m');

/**
 * The environment variable that opts in to printing the operator token on a start that did not
 * generate it (MEDIUM-6 of the v0.5.9 review).
 *
 * The value is printed **once, on the start that generated it**, because that is the only moment at
 * which it exists nowhere else yet; every other start has `<state>/operator-token.txt` to read it
 * from, and a relay's stdout ends up in journald, a container log or a CI transcript — where a
 * credential that authorises dispatching to the whole fleet does not belong. `W2M_PRINT_OPERATOR_TOKEN=1`
 * (or `printOperatorToken: true`, which is the same switch for an embedder) restores the old
 * behaviour for an operator who genuinely needs it in the log, and says so in the banner when it does.
 */
export const PRINT_OPERATOR_TOKEN_ENV = 'W2M_PRINT_OPERATOR_TOKEN';

/**
 * Resolve that opt-in, so the relay and the CLI agree on one answer.
 *
 * @param {object} [options] Relay options; `printOperatorToken: true` is the programmatic spelling.
 * @returns {'option'|'env'|null} Why printing was asked for, or null.
 */
export function printOperatorTokenOptIn(options = {}) {
  if (options.printOperatorToken === true) return 'option';
  const raw = process.env[PRINT_OPERATOR_TOKEN_ENV];
  if (raw === '1' || raw === 'true') return 'env';
  return null;
}

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
 * Read one header case-insensitively from a plain Node headers object.
 *
 * `signing.mjs` does this internally, but the device-key path needs it before deciding whether that
 * module applies at all, so it is needed here too. Node lower-cases incoming header names, and a
 * test that builds a request by hand may not, so both spellings are tried.
 */
function readHeader(headers, name) {
  if (headers === null || headers === undefined) return null;
  const found = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return found === undefined ? null : firstHeaderValue(headers[found]);
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
/*
 * The limiter MOVED to `src/util/rate-limit.mjs` in v0.30.0.
 *
 * It never used anything from this file, and when the approval gate needed the same window, importing it
 * from here made an `agent` module depend on the `relay` layer -- which `scripts/layer-model.mjs` refused,
 * correctly. `agent` is rank 2 and `relay` is rank 3, so the edge points up; moving the class to `util`
 * (rank 0, a leaf) lets both depend on it in the only direction the model allows.
 *
 * Re-exported rather than merely imported, because `SlidingWindowRateLimiter` and `RATE_LIMIT_WINDOW_MS` are
 * part of this module's published surface and `test/relay.test.mjs` imports the class from here.
 */
export { SlidingWindowRateLimiter };

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

    // v0.3.9: P2P signalling. Ephemeral by design -- see src/relay/peers.mjs.
    this.peers = options.peers ?? new PeerRegistry({ nowMs: () => this.state.nowMs() });

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
      windowMs: DEFAULT_WINDOW_MS,
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
    /**
     * Why the token may be printed, when it may be: `'generated'` is the one start whose token exists
     * nowhere else until this process writes it, and `'option'`/`'env'` are the documented opt-ins.
     * @type {'generated'|'option'|'env'|null}
     */
    this.operatorTokenPrintReason = printOperatorTokenOptIn(options);

    if (!wantsRequired || explicit === '') {
      this.operatorToken = null;
      this.operatorTokenRequired = false;
      this.operatorTokenSource = 'disabled';
      this.operatorTokenPrintable = false;
      this.operatorTokenPrintReason = null;
      return;
    }
    this.operatorTokenRequired = true;
    if (typeof explicit === 'string' && explicit.length > 0) {
      this.operatorToken = explicit;
      this.operatorTokenSource = 'option';
      this.persistence.writeOperatorToken(explicit);
    } else if (persisted) {
      // §5.1 + §7: keep the token stable across restarts, otherwise every restart
      // would silently invalidate the plugin's configured operatorToken.
      this.operatorToken = persisted;
      this.operatorTokenSource = 'restored';
    } else {
      this.operatorToken = randomBytes(32).toString('hex');
      this.operatorTokenSource = 'generated';
      this.persistence.writeOperatorToken(this.operatorToken);
    }
    // MEDIUM-6: the material is printed only by the start that generated it, or when the operator has
    // explicitly asked for it. "The posture, never the material" still holds everywhere else.
    if (this.operatorTokenSource === 'generated') {
      this.operatorTokenPrintReason = this.operatorTokenPrintReason ?? 'generated';
    }
    this.operatorTokenPrintable = this.operatorTokenPrintReason !== null;
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
      // MEDIUM-6: the token is material, not posture, so it is printed as rarely as it can be — on the
      // start that generated it (`operatorTokenSource === 'generated'`) or when `printOperatorToken` /
      // `W2M_PRINT_OPERATOR_TOKEN=1` asked for it — and once, never twice. Where it is stored is said in
      // every case, including the case where there is nowhere to store it.
      //
      // DELIBERATE, do not "fix": on that one start the CLI prints the value a second time, in its own
      // stdout banner. Two sinks for one start is not a leak — the defect was printing it on *every*
      // start, restored ones included — and the box is the documented first-start handoff a human reads
      // (docs/DEPLOY.md §2.4, test/crossnetwork.test.mjs). Collapsing the pair would trade a documented
      // behaviour for one saved line on one start.
      const tokenFile = this.persistence.operatorTokenFile ?? null;
      const stored = tokenFile === null
        ? 'persistence is off, so this token exists only in this process and cannot be read back later'
        : `stored at ${tokenFile} (0600)`;
      if (this.operatorTokenPrintable) {
        m.push(`[w2m-rabbit] operator token (${this.operatorTokenSource}) - required for POST /v1/task:`);
        m.push(`[w2m-rabbit]   ${this.operatorToken}`);
        m.push(`[w2m-rabbit]   printed once because ${this.operatorTokenPrintReason === 'generated'
          ? 'this start generated it' : `${this.operatorTokenPrintReason} asked for it (${PRINT_OPERATOR_TOKEN_ENV})`}`
          + ` - and ${stored}`);
      } else {
        m.push(`[w2m-rabbit] operator token (${this.operatorTokenSource}) - required for POST /v1/task, NOT printed`);
        m.push(`[w2m-rabbit]   read it from ${tokenFile ?? '<state>/operator-token.txt'} - ${stored}`);
        m.push(`[w2m-rabbit]   set ${PRINT_OPERATOR_TOKEN_ENV}=1 to print it on this start as well`);
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
          // The CLI prints its own banner, so it has to reach the same conclusion this class did rather
          // than re-deriving one from the token's presence (MEDIUM-6).
          operatorTokenSource: this.operatorTokenSource,
          operatorTokenPrintable: this.operatorTokenPrintable === true,
          operatorTokenPrintReason: this.operatorTokenPrintReason ?? null,
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
      // v0.4.0: a deferred P2P offer is a pending timer, and a closed relay must not fire one.
      this.state.clearPendingOffers?.();
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
    /** v1.2.7: only the blob channel gets the larger frame cap; every JSON route keeps the 64 KiB frame limit. */
    const blobFrameLimit = method === 'PUT' && path.startsWith('/v1/fleet/blobs/') ? BLOB_FRAME_BYTES : this.frameLimitBytes;
    const rawBody = methodHasBody(method) ? await readRawBody(req, blobFrameLimit) : null;
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
     * v1.2.4: cancellation over HTTP. state.cancelTask has existed since the task ledger gained a cancel flag, but no route
     * reached it -- the capability was real on paper and unreachable on the wire. Same authorization as dispatch: cancelling
     * a fleet task is an operator act, not something a device token confers.
     */
    const cancelMatch = path.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch !== null) {
      this.authorizeTaskDispatch(req);
      this.enforceSignature(req, { method, signedPath, body: rawBody });
      const body = takeJson();
      const cancelled = this.state.cancelTask(decodeURIComponent(cancelMatch[1]), typeof body.reason === 'string' && body.reason !== '' ? body.reason : undefined);
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        ok: true,
        task: { task_id: cancelled.task_id, cancelled: cancelled.cancelled === true, cancel_reason: cancelled.cancel_reason ?? null },
      });
    }
    /**
     * v1.2.5: a role is an operator decision, so this route sits with dispatch — before the device gate, where an operator
     * token is accepted.
     */
    const memberMatch = path.match(/^\/v1\/fleet\/members\/([^/]+)$/);
    if (method === 'PUT' && memberMatch !== null) {
      this.authorizeTaskDispatch(req);
      this.enforceSignature(req, { method, signedPath, body: rawBody });
      const body = takeJson();
      const changed = this.state.setMemberRole(decodeURIComponent(memberMatch[1]), body.role);
      if (changed.ok !== true) {
        return sendJson(res, 400, { protocol_version: PROTOCOL_VERSION, ok: false, error: { code: changed.code }, detail: changed.detail ?? null });
      }
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, member: changed.member });
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
      const publishedBody = renderMetrics(this.state, { nowMs: this.state.nowMs() });
      // v1.3.10-beta.23: the M7 reliability registry is appended. It renders nothing until a call site records something, so
      // the existing exposition is unchanged on relays that never instrument.
      const registryBody = typeof this.state.metrics?.renderPrometheus === 'function' ? this.state.metrics.renderPrometheus() : '';
      const body = registryBody === '' ? publishedBody : publishedBody + '# reliability registry\n' + registryBody;
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

    /* ---- v1.1.6: reachable WITHOUT a device token ---- */
    this.joinChallenges ??= createJoinChallenges({
      now: () => this.state.nowMs(),
      publicKeyFor: (fingerprint) => this.state.accountKeyFor(fingerprint),
    });
    const admissionPollMatch = /^\/v1\/fleet\/admission\/([^/]+)$/.exec(path);
    if (method === 'GET' && admissionPollMatch && url.searchParams.get('poll_token') !== null) {
      this.admission ??= createAdmission({ now: () => this.state.nowMs() });
      const polled = this.admission.poll(decodeURIComponent(admissionPollMatch[1]), url.searchParams.get('poll_token'));
      if (polled.ok !== true) throw new ProtocolError('NOT_FOUND', 'unknown admission request');
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...polled });
    }
    if (method === 'GET' && path === '/v1/fleet/admission/challenge') {
      const issued = this.joinChallenges.issue(url.searchParams.get('fingerprint') ?? '', url.searchParams.get('machine_id') ?? '');
      if (issued.ok !== true) throw new ProtocolError('BAD_REQUEST', 'challenge refused: ' + issued.code, { code: issued.code });
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...issued });
    }
    if (method === 'POST' && path === '/v1/fleet/admission/request') {
      const body = takeJson();
      this.admission ??= createAdmission({ now: () => this.state.nowMs() });
      const proof = this.joinChallenges.consume({ challenge_id: body.challenge_id, machine_id: body.machine_id, signature: body.signature });
      if (proof.ok !== true) throw new ProtocolError('UNAUTHORIZED', 'join proof refused: ' + proof.code, { code: proof.code });
      const result = this.admission.requestAdmission({ machine_id: body.machine_id, machine_name: body.machine_name ?? null, account_fingerprint: proof.fingerprint });
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...result });
    }

    /**
     * v1.3.10-beta.14: project-room writes (M4).
     *
     * Above the shared device guard on purpose: an operator token is not a device token, and these change who may act on
     * shared state, so they take the same credential that dispatches tasks.
     */
    if (method === 'POST' && (path === '/v1/projects' || /^\/v1\/projects\/[^/]+\/members$/.test(path))) {
      const auth = this.authorizeTaskDispatch(req);
      if (auth.role !== 'operator') throw new ProtocolError('FORBIDDEN_ACTION', 'only the operator may change project membership', { required_role: 'owner' });
      const body = takeJson();
      const membersMatch = /^\/v1\/projects\/([^/]+)\/members$/.exec(path);
      if (membersMatch !== null) {
        const target = decodeURIComponent(membersMatch[1]);
        const added = this.state.projects.addMember({ projectId: target, member: { kind: body?.member?.kind, id: body?.member?.id, name: body?.member?.name ?? null }, role: body?.role ?? 'worker' });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, member: added.member, snapshot: this.state.projects.snapshot({ projectId: target }) });
      }
      const created = this.state.projects.createProject({
        name: body?.name,
        origin: body?.origin ?? null,
        createdBy: { kind: 'operator', id: typeof body?.created_by?.id === 'string' ? body.created_by.id : 'operator', name: typeof body?.created_by?.name === 'string' ? body.created_by.name : null },
      });
      const createdId = created.project.project.project_id;
      if (Array.isArray(body?.members)) {
        for (const entry of body.members) {
          this.state.projects.addMember({ projectId: createdId, member: { kind: entry?.kind, id: entry?.id, name: entry?.name ?? null }, role: entry?.role ?? 'worker' });
        }
      }
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, project: this.state.projects.snapshot({ projectId: createdId }) });
    }


    /**
     * v1.3.12-beta.2: grant administration (execution-authorization model).
     *
     * Revoking is an operator act: it stops one authorisation from being dispatched. The task list is the audit view --
     * every task that carried a grant, with the argv hash and key id it was authorised under -- and deliberately returns
     * only operator-readable data, never result bodies.
     */
    if (path === '/v1/grants/revoke' || path === '/v1/grants') {
      const auth = this.authorizeTaskDispatch(req);
      if (auth.role !== 'operator') throw new ProtocolError('OPERATOR_REQUIRED', 'only the operator may administer grants');
      if (method === 'POST' && path === '/v1/grants/revoke') {
        const body = takeJson();
        const revoked = this.state.revokeGrant({ grantId: body?.grant_id, reason: body?.reason ?? null });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...revoked });
      }
      if (method === 'GET' && path === '/v1/grants') {
        const audit = this.state.grantedTasks();
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, ...audit });
      }
      throw new ProtocolError('BAD_REQUEST', 'grants accept GET (audit) or POST /revoke', { method, path });
    }

    /**
     * v1.3.13-beta.4: project refs and the merge queue (task model: branch, merge, conflict).
     *
     * Reads take the device token of a paired machine; advancing a ref and settling a queue item are operator acts, because
     * they state where the branch is and what a patch did. A merge that would move the head from a base that is no longer
     * current is refused and the item stays queued -- the model never silently rewrites history.
     */
    const refsMatch = /^\/v1\/projects\/([^/]+)\/refs(?:\/advance)?$/.exec(path);
    if (refsMatch !== null) {
      const projectId = decodeURIComponent(refsMatch[1]);
      const wantsAdvance = path.endsWith('/advance');
      if (!wantsAdvance && method === 'GET') {
        const token = bearerToken(req);
        if (token === null || this.state.authenticate(token) === null) throw new ProtocolError('UNAUTHORIZED', 'reading refs needs a paired device token');
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, refs: this.state.refs.listRefs({ projectId }) });
      }
      if (wantsAdvance && method === 'POST') {
        const auth = this.authorizeTaskDispatch(req);
        if (auth.role !== 'operator') throw new ProtocolError('OPERATOR_REQUIRED', 'advancing a ref is an operator act');
        const body = takeJson();
        const moved = this.state.refs.advance({ projectId, branch: body?.branch, from: body?.from ?? null, to: body?.to, reason: body?.reason ?? null });
        return sendJson(res, moved.ok === true ? 200 : 409, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...moved });
      }
      throw new ProtocolError('BAD_REQUEST', 'refs accept GET or POST /advance', { method, path });
    }
    const mergeMatch = /^\/v1\/projects\/([^/]+)\/merge-queue(?:\/([^/]+))?(?:\/(complete))?$/.exec(path);
    if (mergeMatch !== null) {
      const projectId = decodeURIComponent(mergeMatch[1]);
      const queueId = mergeMatch[2] === undefined ? null : decodeURIComponent(mergeMatch[2]);
      const action = mergeMatch[3] ?? null;
      if (method === 'GET' && queueId === null) {
        const token = bearerToken(req);
        if (token === null || this.state.authenticate(token) === null) throw new ProtocolError('UNAUTHORIZED', 'reading the merge queue needs a paired device token');
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, items: this.state.refs.listQueue({ projectId }) });
      }
      const auth = this.authorizeTaskDispatch(req);
      if (auth.role !== 'operator') throw new ProtocolError('OPERATOR_REQUIRED', 'merge queue mutations are operator acts');
      if (method === 'POST' && queueId === null) {
        const body = takeJson();
        const queued = this.state.refs.enqueue({ projectId, branch: body?.branch, patchSha256: body?.patch_sha256, baseCommit: body?.base_commit, sourceTaskId: body?.source_task_id ?? null });
        return sendJson(res, queued.ok === true ? 200 : 400, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...queued });
      }
      if (method === 'POST' && queueId !== null && action === 'complete') {
        const body = takeJson();
        const settled = this.state.refs.complete({ queueId, outcome: body?.outcome, headCommit: body?.head_commit ?? null, conflictSha256: body?.conflict_sha256 ?? null });
        return sendJson(res, settled.ok === true ? 200 : 409, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...settled });
      }
      throw new ProtocolError('BAD_REQUEST', 'merge queue accepts GET, POST enqueue or POST /:id/complete', { method, path });
    }

    /**
     * v1.3.14-beta.1 (collaboration model): shared objects. Two clients in the same project read the SAME board and the SAME
     * artifact index; before this they each filtered the global task list and disagreed as soon as one of them looked late.
     */
    const sharedMatch = /^\/v1\/projects\/([^/]+)\/(board|artifacts)$/.exec(path);
    if (sharedMatch !== null) {
      const projectId = decodeURIComponent(sharedMatch[1]);
      const resource = sharedMatch[2];
      const readDevice = () => {
        const token = bearerToken(req);
        const caller = token === null ? null : this.state.authenticate(token);
        if (caller === null) throw new ProtocolError('UNAUTHORIZED', 'reading a project object needs a paired device token');
        return caller;
      };
      if (method === 'GET') {
        const caller = readDevice();
        const snapshot = this.state.projectSnapshot(projectId);
        const isDefault = snapshot.project.project_id === this.state.defaultProjectId;
        if (!isDefault) {
          const member = this.state.projects.memberOf({ projectId, member: { kind: 'machine', id: caller.machine_id } });
          if (member === null) throw new ProtocolError('NOT_FOUND', 'unknown project', { project_id: projectId });
        }
        if (resource === 'board') return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, ...this.state.projectBoard({ projectId }) });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, artifacts: this.state.listArtifacts({ projectId }) });
      }
      if (method === 'POST' && resource === 'artifacts') {
        const auth = this.authorizeTaskDispatch(req);
        if (auth.role !== 'operator') throw new ProtocolError('OPERATOR_REQUIRED', 'registering a project artifact is an operator act');
        const body = takeJson();
        const registered = this.state.registerArtifact({ projectId, sha256: body?.sha256, bytes: body?.bytes, kind: body?.kind ?? 'artifact', sourceTaskId: body?.source_task_id ?? null });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...registered });
      }
      throw new ProtocolError('BAD_REQUEST', 'project objects accept GET, or POST artifacts', { method, path });
    }

    /**
     * v1.3.14-beta.2 (collaboration model): decisions and project memory as shared objects. The board answers "what is
     * happening", these answer "what did we agree" -- and both are one object per project, not a per-client copy.
     */
    const knowledgeMatch = /^\/v1\/projects\/([^/]+)\/(decisions|memory)$/.exec(path);
    if (knowledgeMatch !== null) {
      const projectId = decodeURIComponent(knowledgeMatch[1]);
      const resource = knowledgeMatch[2];
      const readDevice = () => {
        const token = bearerToken(req);
        const caller = token === null ? null : this.state.authenticate(token);
        if (caller === null) throw new ProtocolError('UNAUTHORIZED', 'reading a project object needs a paired device token');
        return caller;
      };
      const requireReadable = (caller) => {
        const snapshot = this.state.projectSnapshot(projectId);
        if (snapshot.project.project_id === this.state.defaultProjectId) return;
        const member = this.state.projects.memberOf({ projectId, member: { kind: 'machine', id: caller.machine_id } });
        if (member === null) throw new ProtocolError('NOT_FOUND', 'unknown project', { project_id: projectId });
      };
      if (method === 'GET') {
        const caller = readDevice();
        requireReadable(caller);
        if (resource === 'decisions') return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, decisions: this.state.listDecisions({ projectId }) });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, document: this.state.getProjectMemory({ projectId }) });
      }
      const auth = this.authorizeTaskDispatch(req);
      if (auth.role !== 'operator') throw new ProtocolError('OPERATOR_REQUIRED', 'writing shared project objects is an operator act');
      const body = takeJson();
      if (method === 'POST' && resource === 'decisions') {
        const added = this.state.addDecision({ projectId, title: body?.title, text: body?.text ?? null, actor: { kind: 'operator', id: 'operator' }, refs: body?.refs ?? {}, kind: body?.kind ?? 'decision' });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...added });
      }
      if (method === 'PUT' && resource === 'memory') {
        const updated = this.state.setProjectMemory({ projectId, text: body?.text, actor: { kind: 'operator', id: 'operator' } });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...updated });
      }
      throw new ProtocolError('BAD_REQUEST', 'decisions accept GET/POST, memory accepts GET/PUT', { method, path });
    }

    /**
     * v1.3.14-beta.3 (collaboration model): notifications for shared-object events. The rows are broadcast to project
     * members, read with a per-reader watermark, and deduplicated inside the notifications module; a client that reconnects
     * asks for everything after its watermark instead of re-reading the whole event stream.
     */
    const notifyMatch = /^\/v1\/projects\/([^/]+)\/notifications(?:\/(unread|read))?$/.exec(path);
    if (notifyMatch !== null) {
      const projectId = decodeURIComponent(notifyMatch[1]);
      const action = notifyMatch[2] ?? null;
      const token = bearerToken(req);
      const caller = token === null ? null : this.state.authenticate(token);
      if (caller === null) throw new ProtocolError('UNAUTHORIZED', 'notifications need a paired device token');
      const snapshot = this.state.projectSnapshot(projectId);
      if (snapshot.project.project_id !== this.state.defaultProjectId) {
        const member = this.state.projects.memberOf({ projectId, member: { kind: 'machine', id: caller.machine_id } });
        if (member === null) throw new ProtocolError('NOT_FOUND', 'unknown project', { project_id: projectId });
      }
      const reader = { kind: 'machine', id: caller.machine_id };
      if (method === 'GET' && action === null) {
        const url = new URL(req.url, 'http://relay.invalid');
        const sinceMs = Number(url.searchParams.get('since_ms') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const listed = this.state.notifications.list({ projectId, sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0, limit: Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 200 });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, ...listed });
      }
      if (method === 'GET' && action === 'unread') return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, ...this.state.notifications.unread({ projectId, reader }) });
      if (method === 'POST' && action === 'read') {
        const body = takeJson();
        const marked = this.state.notifications.markRead({ projectId, reader, watermarkMs: body?.watermark_ms });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...marked });
      }
      throw new ProtocolError('BAD_REQUEST', 'notifications accept GET, GET /unread or POST /read', { method, path });
    }

    /**
     * v1.3.14-beta.4 (collaboration model): a project-scoped SSE stream.
     *
     * `ready` names the project and its last event seq, `since_seq` replays the room events a client missed, then every new
     * room event is pushed as `project.event`. Clients in the same project therefore apply the same ordered events instead
     * of each polling a different view.
     */
    const projectStreamMatch = /^\/v1\/projects\/([^/]+)\/stream$/.exec(path);
    if (projectStreamMatch !== null && method === 'GET') {
      const projectId = decodeURIComponent(projectStreamMatch[1]);
      const token = bearerToken(req);
      const caller = token === null ? null : this.state.authenticate(token);
      if (caller === null) throw new ProtocolError('UNAUTHORIZED', 'project events need a paired device token');
      const snapshot = this.state.projectSnapshot(projectId);
      if (snapshot.project.project_id !== this.state.defaultProjectId) {
        const member = this.state.projects.memberOf({ projectId, member: { kind: 'machine', id: caller.machine_id } });
        if (member === null) throw new ProtocolError('NOT_FOUND', 'unknown project', { project_id: projectId });
      }
      const sinceRaw = url.searchParams.get('since_seq');
      const sinceSeq = sinceRaw !== null && /^[0-9]+$/.test(sinceRaw) ? Number(sinceRaw) : 0;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const frame = (entry) => {
        try { res.write('id: ' + entry.seq + '\nevent: project.event\ndata: ' + JSON.stringify({ project_id: entry.project_id, seq: entry.seq, type: entry.type, payload: entry.payload }) + '\n\n'); } catch { /* closed */ }
      };
      const replayed = this.state.projects.events({ projectId, sinceSeq });
      res.write('event: ready\ndata: ' + JSON.stringify({ protocol_version: PROTOCOL_VERSION, project_id: projectId, last_event_seq: replayed.next_seq }) + '\n\n');
      for (const entry of replayed.events) frame(entry);
      const unsubscribe = this.state.onProjectEvent((entry) => { if (entry.project_id === projectId) frame(entry); });
      const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, this.keepaliveMs);
      let closed = false;
      const done = () => { if (closed) return; closed = true; clearInterval(keepalive); unsubscribe(); try { res.end(); } catch { /* already closed */ } };
      req.on('close', done);
      res.on('close', done);
      return true;
    }

    /* ---- everything below requires `Authorization: Bearer <device_token>` ---- */
    const token = bearerToken(req);
    const device = token ? this.state.authenticate(token) : null;
    if (!device) {
      throw new ProtocolError('UNAUTHORIZED', 'missing or invalid device_token', {});
    }
    this.state.touchDevice(device.machine_id);

    const projectLockMatch = /^\/v1\/projects\/([^/]+)\/locks(?:\/([^/]+)(?:\/(renew))?)?$/.exec(path);
    if (projectLockMatch !== null && method !== undefined) {
      const projectId = decodeURIComponent(projectLockMatch[1]);
      const lockId = projectLockMatch[2] === undefined ? null : decodeURIComponent(projectLockMatch[2]);
      const action = projectLockMatch[3] ?? null;
      const roomMember = { kind: 'machine', id: device.machine_id };
      const snapshot = this.state.projectSnapshot(projectId);
      const isDefault = snapshot.project.project_id === this.state.defaultProjectId;
      const membership = isDefault ? { role: 'worker' } : this.state.projects.memberOf({ projectId, member: roomMember });
      if (membership === null) return sendJson(res, 404, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: false, error: { code: 'NOT_FOUND', message: 'unknown project' } });
      const roleRank = { observer: 0, worker: 1, maintainer: 2, owner: 3 };
      const canWrite = roleRank[membership.role] >= roleRank.worker;
      if (method === 'GET' && lockId === null) {
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, locks: this.state.locks.list({ projectId }) });
      }
      if (method === 'POST' && lockId === null) {
        if (!canWrite) return sendJson(res, 403, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: false, error: { code: 'FORBIDDEN_ACTION', message: 'acquiring a lock needs worker or above', required_role: 'worker', current_role: membership.role } });
        const body = takeJson();
        const acquired = this.state.locks.acquire({ projectId, kind: body?.kind, target: body?.target, holder: { kind: "machine", id: device.machine_id }, reason: body?.reason ?? null, leaseMs: Number.isFinite(body?.lease_ms) ? body.lease_ms : undefined });
        if (acquired.ok === true) this.state.metrics?.inc('wm_lock_acquired_total', { kind: String(body?.kind ?? '') });
        else if (acquired.code === 'LOCK_HELD') this.state.metrics?.inc('wm_lock_conflict_total', { kind: String(body?.kind ?? '') });
        return sendJson(res, acquired.ok ? 200 : 409, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...acquired });
      }
      if (method === 'POST' && lockId !== null && action === 'renew') {
        const renewed = this.state.locks.renew({ projectId, lockId, holder: { kind: "machine", id: device.machine_id } });
        return sendJson(res, renewed.ok ? 200 : 409, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...renewed });
      }
      if (method === 'DELETE' && lockId !== null) {
        const force = url.searchParams.get('force') === '1';
        const reason = url.searchParams.get('reason');
        const released = force
          ? this.state.locks.forceRelease({ projectId, lockId, actor: { kind: "machine", id: device.machine_id }, actorRole: membership.role, reason })
          : this.state.locks.release({ projectId, lockId, holder: { kind: "machine", id: device.machine_id } });
        return sendJson(res, released.ok ? 200 : 409, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...released });
      }
      return sendJson(res, 405, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'unsupported lock operation' } });
    }

    /**
     * v1.3.10-beta.14: project-room reads (M4). Below the device guard, so the device is already authenticated.
     *
     * A machine sees the default project and the projects it is a member of; a project it is not a member of answers
     * NOT_FOUND, so a project existence is not leaked. The snapshot carries last_event_seq, and the events route returns
     * the slice after since_seq, which is what lets a client resume after a disconnect.
     */
    if (method === 'GET' && (path === '/v1/projects' || path.startsWith('/v1/projects/'))) {
      const match = /^\/v1\/projects(?:\/([^/]+))?(?:\/(events|members))?$/.exec(path);
      if (match === null) throw new ProtocolError('NOT_FOUND', 'unknown route', { path });
      const projectId = match[1] === undefined ? null : decodeURIComponent(match[1]);
      const sub = match[2] ?? null;
      const readSnapshot = (id) => {
        let snapshot;
        try {
          snapshot = this.state.projectSnapshot(id);
        } catch (error) {
          if (error?.code === 'BAD_REQUEST' || error?.code === 'PROJECT_NOT_FOUND') throw new ProtocolError('NOT_FOUND', 'unknown project', { project_id: id });
          throw error;
        }
        if (snapshot.project.project_id === this.state.defaultProjectId) return snapshot;
        const member = this.state.projects.memberOf({ projectId: id, member: { kind: 'machine', id: device.machine_id } });
        if (member === null) throw new ProtocolError('NOT_FOUND', 'unknown project', { project_id: id });
        return snapshot;
      };
      if (projectId === null) {
        const mine = this.state.projects.listProjects({ member: { kind: 'machine', id: device.machine_id } }).projects;
        if (!mine.some((project) => project.project_id === this.state.defaultProjectId)) mine.unshift({ project_id: this.state.defaultProjectId, name: 'default', origin: null });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, projects: mine });
      }
      if (sub === null) return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, ...readSnapshot(projectId) });
      if (sub === 'events') {
        readSnapshot(projectId);
        const raw = url.searchParams.get('since_seq');
        const sinceSeq = raw !== null && /^[0-9]+$/.test(raw) ? Number(raw) : 0;
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, ...this.state.projectEvents(projectId, { sinceSeq }) });
      }
      throw new ProtocolError('BAD_REQUEST', 'unsupported project route', { method, path });
    }


    // v0.3.0 §9: writes are always checked (tolerating unsigned unless required);
    // reads are only checked when the relay was explicitly told to require
    // signatures. See `enforceSignature` for the reasoning.
    this.enforceSignature(req, { method, signedPath, body: rawBody });

    /* ---- v1.2.5: members and read watermarks ---- */

    if (method === 'GET' && path === '/v1/fleet/members') {
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        ok: true,
        members: this.state.listMembers(),
      });
    }
    const readMatch = path.match(/^\/v1\/fleet\/read\/([^/]+)$/);
    if (readMatch !== null) {
      const sessionId = decodeURIComponent(readMatch[1]);
      if (method === 'PUT') {
        const body = takeJson();
        const marked = this.state.markRead(sessionId, device.machine_id, {
          at_ms: Number.isFinite(body.at_ms) ? body.at_ms : this.state.nowMs(),
          message_id: typeof body.message_id === 'string' ? body.message_id : null,
        });
        if (marked.ok !== true) return sendJson(res, 400, { protocol_version: PROTOCOL_VERSION, ok: false, error: { code: marked.code } });
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, ...marked });
      }
      if (method === 'GET') {
        this.fleetMessages ??= createFleetMessages({ now: () => this.state.nowMs() });
        const mark = this.state.readMark(sessionId, device.machine_id);
        const listed = this.fleetMessages.list({ session_id: sessionId, limit: 200, for_machine_id: device.machine_id });
        const messages = listed.ok === true ? listed.messages : [];
        const floor = mark === null ? 0 : mark.at_ms;
        const unread = messages.filter((message) => Number.isFinite(message?.at_ms) && message.at_ms > floor && message.machine_id !== device.machine_id).length;
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ok: true, session_id: sessionId, mark, unread });
      }
      return sendJson(res, 405, { protocol_version: PROTOCOL_VERSION, ok: false, error: { code: 'METHOD_NOT_ALLOWED' } });
    }
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
    /**
     * v1.3.10-beta.20: chunked blob sessions (M6). A >64 KiB artifact is uploaded in idempotent chunks and only becomes a
     * blob when the assembled bytes hash to the declared sha256; the session answers "which chunks are missing" so an
     * interrupted upload resumes instead of restarting.
     */
    const blobSessionCreate = method === 'POST' && path === '/v1/fleet/blob-sessions';
    const blobSessionChunk = /^\/v1\/fleet\/blob-sessions\/([^/]+)\/chunks\/([0-9]+)$/.exec(path);
    const blobSessionCommit = /^\/v1\/fleet\/blob-sessions\/([^/]+)\/commit$/.exec(path);
    const blobSessionStatus = /^\/v1\/fleet\/blob-sessions\/([^/]+)$/.exec(path);
    if (blobSessionCreate || blobSessionChunk !== null || blobSessionCommit !== null || blobSessionStatus !== null) {
      const wrap = (fn) => { try { return fn(); } catch (error) { if (typeof error?.code === "string") throw new ProtocolError(error.code, error.message, error.detail ?? null); throw error; } };
      if (blobSessionCreate) {
        const body = takeJson();
        const created = wrap(() => this.state.blobSessions.create({ machineId: device.machine_id, sha256: body?.sha256, size: body?.size, chunkBytes: body?.chunk_bytes }));
        return sendJson(res, 201, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...created });
      }
      if (method === 'PUT' && blobSessionChunk !== null) {
        const data = rawBody ?? Buffer.alloc(0);
        const stored = wrap(() => this.state.blobSessions.putChunk({ sessionId: decodeURIComponent(blobSessionChunk[1]), index: Number(blobSessionChunk[2]), data }));
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...stored });
      }
      if (method === 'POST' && blobSessionCommit !== null) {
        const committed = wrap(() => this.state.blobSessions.commit({ sessionId: decodeURIComponent(blobSessionCommit[1]) }));
        return sendJson(res, committed.ok === true ? 201 : 409, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...committed });
      }
      if (method === 'GET' && blobSessionStatus !== null) {
        const status = wrap(() => this.state.blobSessions.status({ sessionId: decodeURIComponent(blobSessionStatus[1]) }));
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...status });
      }
      throw new ProtocolError('BAD_REQUEST', 'a blob session is created with POST, chunks with PUT, committed with POST', {});
    }

    /**
     * v1.0.7: the content-addressed blob channel (#1).
     *
     * ## Why the relay may carry bytes at all
     *
     * It persists `stdout_sha256` and never the text, and `src/agent/storage.mjs` records why: each machine's
     * `memory.jsonl` is the only durable copy of what a command printed. **That invariant is about the relay not
     * interpreting content** -- it never decides what bytes mean and never asserts they are authentic.
     *
     * A blob keyed by its own hash preserves exactly that. The relay still interprets nothing; **the hash is what
     * says the bytes are the bytes**, exactly as `stdout_sha256` does for a result. What is new is only that a hash
     * the relay already holds can have its bytes fetched from the same place.
     *
     * ## Why the hash is verified before storing
     *
     * A content-addressed store that accepts bytes under a key they do not hash to is not content-addressed -- the
     * key stops being a claim about the content, and every later reader's verification becomes decorative. So a
     * mismatch is **refused (422)**, never stored and never corrected: correcting it would silently re-key a blob
     * the caller believes it stored under a different name.
     *
     * ## Fleet scoping
     *
     * `putFleetBlob`/`getFleetBlob` reuse `scopeFleetId`, the same rule task dispatch obeys. A blob written by one
     * fleet is **not readable by another**, and the read refusal is a 404 rather than a 403: a distinguishable
     * "not yours" tells a prober that the hash exists here.
     */
    /**
     * v1.0.9: **which blob this fleet published last** -- the discovery half of the channel.
     *
     * Checked **before** the `<sha256>` matcher deliberately. The matcher only accepts 64 hex characters, so
     * `latest` cannot collide with it today; **the ordering is asserted anyway**, because "these two patterns cannot
     * conflict" is exactly the reasoning that produces a shadowed route the day one of them is relaxed.
     *
     * A fleet that has never published gets a 404 rather than an empty object: "there is no current document" and
     * "the current document is nothing" are different statements, and only one of them is true here.
     */
    if (method === 'GET' && path === '/v1/fleet/blobs/latest') {
      const latest = this.state.latestFleetBlob(device);
      if (latest === null) {
        throw new ProtocolError('NOT_FOUND', 'this fleet has published no blob', {});
      }
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        hash: latest.hash,
        bytes: latest.bytes,
        published_at: new Date(latest.published_at_ms).toISOString(),
        published_by: latest.published_by ?? null,
        // Stated in the payload, not only in the docs: a pointer can outlive its blob under oldest-first eviction.
        hint: 'a hint, not a guarantee -- a pull may answer 404 if the blob has since been evicted',
      });
    }

    const blobMatch = /^\/v1\/fleet\/blobs\/([0-9a-f]{64})$/.exec(path);
    if (blobMatch !== null) {
      const hash = blobMatch[1];
      if (method === 'PUT') {
        const received = rawBody ?? Buffer.alloc(0);
        const actual = createHash('sha256').update(received).digest('hex');
        if (actual !== hash) {
          throw new ProtocolError('BLOB_HASH_MISMATCH', 'the body does not hash to the key it was sent under', {
            expected: hash,
            actual,
            bytes: received.length,
          });
        }
        const stored = this.state.putFleetBlob(device, received);
        if (stored.ok !== true) {
          throw new ProtocolError(stored.reason ?? 'BLOB_WRITE_FAILED', stored.detail ?? 'the blob was refused', {
            hash,
          });
        }
        return sendJson(res, 201, {
          protocol_version: PROTOCOL_VERSION,
          ok: true,
          hash: stored.hash,
          bytes: stored.bytes,
          evicted: stored.evicted,
        });
      }
      if (method === 'GET') {
        const bytes = this.state.getFleetBlob(device, hash);
        if (bytes === null) {
          // Same code and shape for "no such blob" and "not your fleet's" -- deliberately indistinguishable.
          throw new ProtocolError('NOT_FOUND', 'no such blob is readable by this device', { hash });
        }
        const rangeParam = url.searchParams.get('range');
        if (rangeParam !== null) {
          const match = /^([0-9]+)-([0-9]+)$/.exec(rangeParam);
          if (match === null) throw new ProtocolError('BAD_REQUEST', 'range must be start-end', { range: rangeParam });
          const start = Number(match[1]);
          const end = Math.min(Number(match[2]), bytes.length - 1);
          if (!(start >= 0 && start <= end && start < bytes.length)) throw new ProtocolError('BAD_REQUEST', 'range is outside the blob', { range: rangeParam, bytes: bytes.length });
          const slice = bytes.subarray(start, end + 1);
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-length': slice.length,
            'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length,
            'cache-control': 'no-store',
          });
          res.end(slice);
          return true;
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': bytes.length,
          // Same reason as `/metrics`: a memory document must not be cached by an intermediary.
          'cache-control': 'no-store',
        });
        res.end(bytes);
        return true;
      }
      throw new ProtocolError('BAD_REQUEST', 'a blob is addressed with PUT or GET', { method });
    }

    if (method === 'GET' && path === '/v1/devices') {
        /**
         * v1.5.5: device enumeration is fleet-scoped.
         *
         * This endpoint used to return every device on the relay; state.mjs even recorded the narrowing
         * as a pending step. The observation that forced it: another account's machine (its own fleet id,
         * its own fleet key) appeared in this fleet's machine list -- correct fleet binding, wrong list.
         *
         * Migration rule, the same one task dispatch already obeys: a relay with no fleet configured
         * keeps the historical behaviour for fleetless devices, a scoped relay serves its own fleet, and
         * a fleet-bound device always sees exactly its own fleet and nothing else.
         */
        const callerFleet = typeof device?.fleet_id === 'string' && device.fleet_id !== '' ? device.fleet_id : null;
        const relayFleet = this.state.fleetId ?? null;
        const allDevices = this.state.listDevices();
        const devices = callerFleet === null
          ? (relayFleet === null ? allDevices : allDevices.filter((entry) => entry.fleet_id === relayFleet))
          : allDevices.filter((entry) => entry.fleet_id === callerFleet);
        return sendJson(res, 200, {
          protocol_version: PROTOCOL_VERSION,
          rabbit_time: this.state.nowIso(),
          devices,
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
        tasks: this.state.listTasks({ limit, fleetId: device.fleet_id ?? null }),
      });
    }

    const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    const reportMatch = /^\/v1\/tasks\/([^/]+)\/report$/.exec(path);
    // v0.3.0: cross-machine RTT status. The plugin may run on a different machine
    // than the agent, so this has to come from the relay, not from a local file.
    const agentStatusMatch = /^\/v1\/agents\/([^/]+)\/status$/.exec(path);
    // v0.3.9: P2P candidate rendezvous. `/announce` is checked before the read route
    // so that a machine literally named "announce" cannot shadow it.
    const peerReadMatch = /^\/v1\/peer\/([^/]+)$/.exec(path);
    /* ---- v1.1.6 admission ---- */
    const admissionDecideMatch = /^\/v1\/fleet\/admission\/([^/]+)\/decide$/.exec(path);
    const memberRemoveMatch = /^\/v1\/fleet\/members\/([^/]+)\/remove$/.exec(path);
    const removalVoteMatch = /^\/v1\/fleet\/removals\/([^/]+)\/vote$/.exec(path);

    /* ---- v0.3.9 P2P signalling ---- */
    if (method === 'POST' && path === '/v1/peer/announce') {
      const body = takeJson();
      try {
        // `device.machine_id`, never `body.machine_id`: a paired machine may only
        // announce addresses for itself, or it could aim a peer's punch at a third party.
        const result = this.peers.announce(device.machine_id, body);
        return sendJson(res, 200, {
          protocol_version: PROTOCOL_VERSION,
          rabbit_time: this.state.nowIso(),
          ...result,
        });
      } catch (error) {
        throw new ProtocolError('BAD_REQUEST', error.message, { code: error.code ?? 'BAD_ANNOUNCEMENT' });
      }
    }

    if (method === 'GET' && peerReadMatch) {
      const machineId = decodeURIComponent(peerReadMatch[1]);
      const entry = this.peers.get(machineId);
      if (!entry) {
        // A named 404 rather than an empty list: "this machine has not announced" and
        // "this machine announced nothing reachable" call for different responses, and
        // an empty candidate list would send the caller into a punch that cannot work.
        throw new ProtocolError('NOT_FOUND', `no live P2P announcement for ${machineId}`, {
          machine_id: machineId,
          hint: 'the peer must POST /v1/peer/announce first, and announcements expire',
        });
      }
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        peer: entry,
      });
    }

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


    /* ---- v1.1.6 admission: the caller is always `device.machine_id`, never a body field ---- */
    this.admission ??= createAdmission({ now: () => this.state.nowMs() });

    if (method === 'GET' && path === '/v1/fleet/admission/pending') {
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(),
        pending: this.admission.pendingFor(),
      });
    }

    if (method === 'POST' && admissionDecideMatch) {
      const body = takeJson();
      const result = this.admission.decide(decodeURIComponent(admissionDecideMatch[1]), {
        decision: body.decision, decided_by: device.machine_id, auto: body.auto === true,
      });
      if (result.ok !== true) throw new ProtocolError('BAD_REQUEST', 'admission decision refused: ' + result.code, result);
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...result });
    }

    if (method === 'POST' && memberRemoveMatch) {
      const body = takeJson();
      const result = this.admission.remove(decodeURIComponent(memberRemoveMatch[1]), {
        requested_by: device.machine_id, reason: typeof body.reason === 'string' ? body.reason : null,
      });
      if (result.ok !== true) throw new ProtocolError('BAD_REQUEST', 'removal refused: ' + result.code, result);
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...result });
    }

    if (method === 'POST' && removalVoteMatch) {
      const body = takeJson();
      const result = this.admission.vote(decodeURIComponent(removalVoteMatch[1]), {
        machine_id: device.machine_id, vote: body.vote,
      });
      if (result.ok !== true) throw new ProtocolError('BAD_REQUEST', 'vote refused: ' + result.code, result);
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...result });
    }

    /* ---- v1.1.17: fleet chat ---- */
    //
    // Both endpoints sit AFTER the device gate on purpose: a message must be attributable to a paired machine, and
    // "who said this" is exactly the machine_id the token resolves to -- never a body field, which would let one machine
    // speak as another. The refusal codes from the store are passed through unchanged (FLEET_QUOTA_EXCEEDED included)
    // because a caller that cannot tell "too big" from "over quota" from "not text" cannot tell the operator what to do.
    this.fleetMessages ??= createFleetMessages({ now: () => this.state.nowMs() });
    this.fleetMemory ??= createFleetMemory({ now: () => this.state.nowMs() });

    if (method === 'POST' && path === '/v1/fleet/messages') {
      /**
       * v1.2.6: posting to the group is a dispatch-class action. An observer may read the flow and may not speak into it, and
       * the refusal names the action and both roles so it is actionable.
       */
      const permitted = mayAct({ role: this.state.roleOf(device.machine_id), action: 'dispatch' });
      if (permitted.ok !== true) {
        return sendJson(res, 403, {
          protocol_version: PROTOCOL_VERSION,
          ok: false,
          error: { code: permitted.code, message: 'role may not post to the fleet group' },
          detail: {
            action: permitted.action,
            required_level: permitted.required_level,
            current_level: permitted.current_level,
            required_role: permitted.required_role,
            current_role: permitted.current_role,
          },
        });
      }
      const body = takeJson();
      const posted = this.fleetMessages.post({
        session_id: body.session_id,
        fleet_id: device.fleet_id ?? null,
        machine_id: device.machine_id,
        to: body.to,
        thread_id: body.thread_id,
        reply_to: body.reply_to,
        text: body.text,
        mentions: body.mentions,
        enc: body.enc,
        reply_state: body.reply_state,
        idempotency_key: body.idempotency_key,
      });
      if (posted.ok !== true) {
        throw new ProtocolError('BAD_REQUEST', 'message refused: ' + posted.code, { code: posted.code, ...(posted.detail ?? {}) });
      }
      return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), message: posted.message, ...(posted.deduped === true ? { deduped: true } : {}) });
    }

    if (method === 'GET' && path === '/v1/fleet/messages/stream') {
      /**
       * v1.1.17: a notification channel, not a message channel.
       *
       * The event carries the id and the session -- never the text -- so a client that connects learns "something was
       * said" and then fetches it through GET /v1/fleet/messages, which is where membership is actually checked. A
       * broadcast carrying text would hand every message to every connected listener and make the check decorative.
       *
       * The stream sits behind the device gate: an unpaired client cannot listen.
       */
      const sessionId = url.searchParams.get('session_id');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 15_000);
      if (typeof keepalive.unref === 'function') keepalive.unref();
      const unsubscribe = this.fleetMessages.subscribe(sessionId, (event) => {
        try {
          // v1.2.5: a listener learns whether IT was named, and nothing else about the text.
          const mentioned = Array.isArray(event.mentions) && event.mentions.includes(device.machine_id);
          const payload = {
            session_id: event.session_id,
            message_id: event.message_id,
            machine_id: event.machine_id,
            at_ms: event.at_ms,
            to: event.to ?? 'all',
            ...(mentioned ? { mention: true } : {}),
          };
          res.write('event: new_message\ndata: ' + JSON.stringify(payload) + '\n\n');
        } catch { /* the reader went away; close() below cleans up */ }
      });
      const done = () => { clearInterval(keepalive); unsubscribe(); try { res.end(); } catch { /* already closed */ } };
      req.on('close', done);
      return undefined;
    }

    if (method === 'GET' && path === '/v1/fleet/messages') {
      const sinceRaw = url.searchParams.get('since_ms');
      const limitRaw = url.searchParams.get('limit');
      const listed = this.fleetMessages.list({
        session_id: url.searchParams.get('session_id') ?? '',
        since_ms: sinceRaw === null ? null : Number(sinceRaw),
        limit: limitRaw === null ? 50 : Number(limitRaw),
        // Addressing/correlation filters. `for_me=1` is answered from the authenticated device identity, never from a
        // caller-supplied machine id: a reader must not be able to ask for another machine's private messages.
        // v1.5.5: a reader sees the chat of the fleet it belongs to; a device without a fleet keeps the
          // historical unqualified view.
          fleet_id: device.fleet_id ?? null,
          for_machine_id: url.searchParams.get('for_me') === '1' ? device.machine_id : null,
        thread_id: url.searchParams.get('thread_id'),
        to: url.searchParams.get('to'),
      });
      return sendJson(res, 200, {
        protocol_version: PROTOCOL_VERSION,
        rabbit_time: this.state.nowIso(),
        ...listed,
          // v1.5.5: only the caller's fleet messages leave the process.
          messages: (listed.messages ?? []).filter((m) => (m.fleet_id ?? null) === (device.fleet_id ?? null)),
        usage: this.fleetMessages.usage(),   // shown with every read so a client can warn before the quota refuses a post
      });
    }

    // v1.2.2: shared memory writes. Compare-and-swap on a revision, because two machines appending to one document is
    // otherwise last-writer-wins over the whole thing -- a record one machine added would vanish because the other had an
    // older copy. A stale writer gets 409 and the records it has not read; it is NOT retried here, because retrying in
    // the transport turns a visible conflict into a silent overwrite.
    if (path.startsWith('/v1/fleet/memory/')) {
      const doc = decodeURIComponent(path.slice('/v1/fleet/memory/'.length));
      if (doc === '') throw new ProtocolError('BAD_REQUEST', 'memory doc is required', { method, path });
        // v1.5.5: a fleet's memory must not be addressable by another fleet on the same relay.
        const docKey = typeof device.fleet_id === 'string' && device.fleet_id !== '' ? device.fleet_id + '::' + doc : doc;
      this.fleetMemory ??= createFleetMemory({ now: () => this.state.nowMs() });
      if (method === 'GET') {
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...this.fleetMemory.get(docKey) });
      }
      if (method === 'PUT') {
        const body = takeJson();
        const appended = this.fleetMemory.append({
          doc: docKey,
          if_revision: Number.isInteger(body.if_revision) ? body.if_revision : null,
          author_machine_id: device.machine_id,
          records: Array.isArray(body.records) ? body.records : (typeof body.text === 'string' ? [body.text] : []),
        });
        if (appended.ok !== true) {
          const status = appended.code === 'REVISION_CONFLICT' ? 409 : 400;
          return sendJson(res, status, {
            protocol_version: PROTOCOL_VERSION, ok: false,
            error: { code: appended.code }, detail: appended.detail ?? null,
          });
        }
        return sendJson(res, 200, { protocol_version: PROTOCOL_VERSION, rabbit_time: this.state.nowIso(), ...appended });
      }
      throw new ProtocolError('BAD_REQUEST', 'memory accepts GET or PUT', { method, path });
    }

    throw new ProtocolError('NOT_FOUND', `no route for ${method} ${path}`, { method, path });
  }

  /** §4: the operations answer — "is the relay there, did it restart, are my machines connected". */
  healthBody(req) {
    return {
      ...this.state.stats(),
      // v0.3.9: how many machines currently have a live P2P announcement. Ephemeral,
      // so this drops to 0 by itself when nobody is refreshing.
      ...this.peers.stats(),
      ok: true,
      /**
       * v0.6.2: hoisted out of `persistence` so it cannot be missed by a reader that only looks at
       * the top level. `degraded: true` means this relay is answering requests while failing to record
       * them -- the one relay failure that presents as health. `ok` deliberately stays true: the relay
       * still serves the fleet, and flipping it would turn a recording problem into an outage.
       */
      degraded: this.persistence.enabled && this.persistence.degraded,
      degraded_reason: this.persistence.degraded
        ? `ledger appends are failing (${this.persistence.lastAppendError ?? 'unknown error'}); results are served but not durably recorded`
        : null,
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
  /**
   * Verify a request's signature (v0.7.11).
   *
   * Two mechanisms, and the order between them is the whole design:
   *
   * **1. Per-device Ed25519, when the sender is a device with a stored public key.** This is the
   * one that proves *which* device signed. It is tried **first** because a device key is strictly
   * stronger evidence than a shared secret, and because a device that registered a key must not
   * fall back to the weaker mechanism by accident.
   *
   * **2. HMAC over a shared secret, otherwise.** Every device that paired before v0.7.10 arrives
   * here — which is every device today — and nothing about its behaviour changes.
   *
   * ## Why this converges with no second deployment
   *
   * A device that has not been updated sends no signature header, so mechanism 1 finds no key and
   * mechanism 2 answers exactly as before. A device that *has* been updated sends a signature, its
   * public key is on file from pairing, and it is verified with it. So a fleet updates one machine
   * at a time and each machine gets the strongest mechanism available **to it** the moment it
   * starts sending one — no flag, no rollout step, no coordination.
   *
   * ## What this deliberately does not do
   *
   * It does not **require** a device key. `requireSignature` still means "a signature must be
   * present", and either mechanism satisfies it. Making a *device key* mandatory is a separate,
   * later switch, because turning it on today would refuse all four machines at once.
   */
  verifySignature(req, { method, signedPath, body }) {
    const viaDevice = this.verifyWithDeviceKey(req, { method, signedPath, body });
    if (viaDevice !== null) return viaDevice;

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

  /**
   * Try the per-device Ed25519 path.
   *
   * Returns `null` when the mechanism does not apply — no signature presented, or the signing
   * machine is not a device whose public key we hold — so the caller falls through. Returns a
   * decision when it *does* apply, **including when it fails**: a device that registered a key and
   * then presented a bad signature must not get a second chance through the shared secret, since
   * that would make the stronger mechanism optional for anyone able to produce a malformed one.
   */
  verifyWithDeviceKey(req, { method, signedPath, body }) {
    const header = readHeader(req.headers, DEVICE_SIGNATURE_HEADER);
    if (typeof header !== 'string' || header === '') return null;

    const machineId = this.machineIdForRequest(req);
    if (machineId === null) return null;
    const publicKey = this.state.devices.get(machineId)?.public_key;
    if (typeof publicKey !== 'string' || publicKey === '') return null;

    const decision = verifyDeviceSignature({
      headers: req.headers,
      publicKeyPem: publicKey,
      method,
      path: signedPath,
      body: body ?? '',
      nowMs: this.state.nowMs(),
      skewSeconds: this.signatureSkewSeconds,
      // `accept`, not `remember` -- the name this class actually exposes. It reports whether the
      // nonce was new, which is exactly the contract `verifyDeviceSignature` expects.
      nonces: (nonce, at) => this.nonceCache.accept(nonce, at),
    });
    if (decision.ok) return { ...decision, machine_id: machineId, keyIndex: null };
    return decision;
  }

  /**
   * Which machine a request claims to be, from either credential.
   *
   * An **operator token is not a machine**, so it resolves to `null` and the device path does not
   * apply — consistent with `authorizeTaskDispatch`, which reports `machine_id: null` for an
   * operator. That is why an operator-token request keeps using the shared secret.
   */
  machineIdForRequest(req) {
    const token = bearerToken(req);
    if (!token) return null;
    if (this.operatorToken !== null && token === this.operatorToken) return null;
    return this.state.authenticate(token)?.machine_id ?? null;
  }

  /** Periodic maintenance, called by the sweep timer. */
  maintenance() {
    const expired = this.sweep();
    /**
     * v0.9.1: presence expiry, alongside lease expiry.
     *
     * `this.sweep()` writes off lease *holds*; this writes off *presence*. They were conflated, so a
     * machine that stopped existing was only ever noticed when its SSE stream detached — and a
     * half-open stream never detaches.
     */
    const silent = this.state.sweepSilentDevices();
    if (silent.length > 0) {
      this._log(`[w2m-rabbit] marked ${silent.length} silent device(s) offline: `
        + silent.map((s) => `${s.machine_name} (${Math.round(s.silent_ms / 1000)}s)`).join(', '));
    }
    this.pairLimiter.prune();
    this.peers.sweep();
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
