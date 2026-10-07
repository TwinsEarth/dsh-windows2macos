/**
 * W2M update source — version check + verified download (GitHub Releases only).
 *
 * Design constraints (v0.2.3):
 *   - pure functions + injectable `fetch`, so every branch is testable offline
 *   - NOTHING throws at the caller: every entry point returns `{ok:false, error}`
 *     with the HTTP status and a machine-readable `code`
 *   - a hung socket must never wedge the scheduler: every request runs inside an
 *     AbortController race that settles even if `fetch` ignores the signal
 *   - the tarball is hashed WHILE it streams to a temp file, then renamed into
 *     place; a checksum failure removes the temp file and never touches `destPath`
 *   - a token may be supplied, and must never appear in a log line or an error
 *
 * ── Version comparison rules (the interesting one) ──────────────────────────
 * SemVer 2.0.0 precedence, which means:
 *
 *   1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2
 *     < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
 *
 * Two consequences worth stating out loud:
 *
 *   a) A pre-release sorts BELOW the same version's release ("1.0.0-rc.1 < 1.0.0").
 *      So a relay running 1.0.0-rc.1 sees 1.0.0 as an update, and one running
 *      1.0.0 does NOT see 1.0.0-rc.1 as a downgrade-worthy update.
 *
 *   b) A pre-release still sorts ABOVE any lower triple: 0.2.0-rc.1 > 0.1.2.
 *      That is correct SemVer and is what `isNewer` reports. In practice this does
 *      not offer pre-releases to stable users, because GitHub's
 *      `GET /releases/latest` endpoint already excludes drafts and pre-releases --
 *      it only ever returns a published, non-pre-release tag. The rule here is the
 *      library-level truth for callers that pass a tag in explicitly.
 *
 * Build metadata (`+sha.abc`) is ignored for precedence, per SemVer §10.
 */

import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_REPO = 'TwinsEarth/dsh-windows2macos';
export const DEFAULT_API_BASE = 'https://api.github.com';
/**
 * Default per-request budget. Measured on this project's own CI machine: a COLD
 * first connection to api.github.com took ~18s (DNS/TLS warm-up), while warm
 * calls take ~0.1-1.5s. A 15s default would therefore report a spurious TIMEOUT
 * on the very first scheduled check after a reboot -- and a missed update looks
 * exactly like "you are up to date". 30s cannot wedge a 3x/day scheduler.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_USER_AGENT = 'w2m-update-check';
export const DEFAULT_TARBALL_PATTERN = /\.(?:tgz|tar\.gz)$/i;
export const DEFAULT_SUMS_PATTERN = /^SHA256SUMS(?:\.txt)?$/i;
export const GITHUB_API_VERSION = '2022-11-28';

/* ------------------------------------------------------------------ */
/* errors                                                             */
/* ------------------------------------------------------------------ */

/** Every failure path funnels through this so callers can switch on `code`. */
export class UpdateSourceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'UpdateSourceError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/** Raised by `compareVersions` when an input cannot be parsed. */
export class VersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VersionError';
  }
}

const fail = (code, message, detail = {}) => ({ ok: false, code, error: message, ...detail });

/** Failure with the HTTP status attached, as required by the contract. */
const httpFail = (code, message, status, detail = {}) => fail(code, message, { status, ...detail });

/* ------------------------------------------------------------------ */
/* secret hygiene                                                     */
/* ------------------------------------------------------------------ */

/**
 * Remove anything token-shaped from a string that is about to be logged or
 * returned. Belt and braces: the exact token if we know it, `Bearer xxx`, and
 * `?access_token=` style query parameters.
 */
export function redact(text, token = null) {
  let out = String(text ?? '');
  if (token) out = out.split(String(token)).join('[REDACTED]');
  out = out.replace(/([?&](?:access_token|token|api_key|apikey|key)=)[^&\s"']+/gi, '$1[REDACTED]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [REDACTED]');
  return out;
}

/** Turn any thrown value into the `{ok:false, ...}` contract shape. */
function toFailure(err, token, fallbackCode = 'NETWORK') {
  const code = err instanceof UpdateSourceError ? err.code : fallbackCode;
  const status = err instanceof UpdateSourceError ? err.status : undefined;
  const cause = err?.cause?.message ? `: ${err.cause.message}` : '';
  const message = redact(`${err?.message ?? String(err)}${cause}`, token);
  return {
    ok: false,
    code,
    error: message || 'update source failure',
    ...(status !== undefined ? { status } : {}),
    ...(err instanceof UpdateSourceError && err.rateLimited !== undefined
      ? { rateLimited: err.rateLimited, rateLimit: err.rateLimit } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* versions                                                           */
/* ------------------------------------------------------------------ */

const VERSION_RE = /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Parse a release tag. Accepts `v0.1.2`, `0.1.2`, `1.2`, `v2`, optional
 * `-prerelease` and `+build`. Returns `null` for anything else — including
 * four-component versions, which are not SemVer.
 *
 * @returns {{major:number,minor:number,patch:number,pre:string|null,build:string|null,raw:string}|null}
 */
export function parseVersion(tag) {
  if (typeof tag !== 'string') return null;
  const raw = tag.trim();
  if (raw === '') return null;
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] ?? null,
    build: m[5] ?? null,
    raw,
  };
}

/** SemVer §11 identifier precedence; `null` (a release) outranks any pre-release. */
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const A = String(a).split('.');
  const B = String(b).split('.');
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    if (i >= A.length) return -1; // shorter identifier list sorts lower
    if (i >= B.length) return 1;
    const x = A[i];
    const y = B[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum) {
      return -1; // numeric identifiers sort below alphanumeric ones
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1; // ASCII lexical order
    }
  }
  return 0;
}

/** Accept a tag string or an already-parsed version; everything else is null. */
function coerceVersion(value) {
  if (typeof value === 'string') return parseVersion(value);
  if (value !== null && typeof value === 'object'
    && Number.isInteger(value.major) && Number.isInteger(value.minor) && Number.isInteger(value.patch)) {
    return value;
  }
  return null;
}

/**
 * Compare two versions (strings or `parseVersion` results) -> -1 | 0 | 1.
 *
 * THROWS `VersionError` when either side is unparseable. That is deliberate:
 * silently returning 0 for garbage is how "never downgrade" logic rots. Data
 * from the network must go through `isNewer`, which never throws.
 */
export function compareVersions(a, b) {
  const pa = coerceVersion(a);
  const pb = coerceVersion(b);
  if (!pa) throw new VersionError(`cannot parse version: ${JSON.stringify(a)}`);
  if (!pb) throw new VersionError(`cannot parse version: ${JSON.stringify(b)}`);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.pre ?? null, pb.pre ?? null);
}

/**
 * The update gate: true ONLY when `candidate` is strictly newer.
 * Total function — equal, older and unparseable all return false, and it never
 * throws, because it runs unattended on a schedule.
 */
export function isNewer(candidate, current) {
  try {
    return compareVersions(candidate, current) === 1;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* SHA256SUMS                                                         */
/* ------------------------------------------------------------------ */

// GNU coreutils format: "<64 hex><space><space><name>", optionally "*name" for
// binary mode, and some tools prefix "./".
const SUMS_LINE_RE = /^([0-9a-fA-F]{64})[ \t]+[*]?(.+?)[ \t]*$/;

/**
 * Parse a `SHA256SUMS` file into `Map<normalized filename, lowercase hash>`.
 * Blank lines and `#` comments are ignored. A structurally wrong line, or two
 * entries for the same name with different hashes, is an explicit error.
 */
export function parseSha256Sums(text) {
  if (typeof text !== 'string') {
    throw new UpdateSourceError('BAD_SUMS', 'SHA256SUMS content must be a string');
  }
  const entries = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = SUMS_LINE_RE.exec(line);
    if (!m) {
      throw new UpdateSourceError(
        'BAD_SUMS_FORMAT',
        `SHA256SUMS line ${i + 1} is not "<64-hex>  <filename>": ${JSON.stringify(line.slice(0, 160))}`,
        { line: i + 1 },
      );
    }
    const name = m[2].trim().replace(/^\.\//, '');
    if (name === '') {
      throw new UpdateSourceError('BAD_SUMS_FORMAT', `SHA256SUMS line ${i + 1} has an empty filename`, { line: i + 1 });
    }
    const hash = m[1].toLowerCase();
    const existing = entries.get(name);
    if (existing !== undefined && existing !== hash) {
      throw new UpdateSourceError(
        'BAD_SUMS_CONFLICT',
        `SHA256SUMS lists ${name} twice with different hashes`,
        { line: i + 1, filename: name },
      );
    }
    if (existing === undefined) entries.set(name, hash);
  }
  if (entries.size === 0) {
    throw new UpdateSourceError('BAD_SUMS', 'SHA256SUMS contains no entries');
  }
  return entries;
}

/** Hash for `filename`, or `null` when the file is not listed. Exact name first, then basename. */
export function findChecksum(text, filename) {
  const entries = parseSha256Sums(text);
  const target = String(filename ?? '');
  if (entries.has(target)) return entries.get(target);
  const base = path.basename(target);
  for (const [name, hash] of entries) {
    if (path.basename(name) === base) return hash;
  }
  return null;
}

/** Like `findChecksum`, but an absent entry is an explicit error rather than `null`. */
export function requireChecksum(text, filename) {
  const hash = findChecksum(text, filename);
  if (hash === null) {
    throw new UpdateSourceError('CHECKSUM_NOT_FOUND', `SHA256SUMS has no entry for ${filename}`, { filename });
  }
  return hash;
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                      */
/* ------------------------------------------------------------------ */

/**
 * A request guard that ALWAYS settles.
 *
 * `controller.abort()` stops a well-behaved `fetch`, but the race against
 * `promise` is what guarantees the scheduler is never wedged by an
 * implementation that ignores the signal. The timer is intentionally NOT
 * unref'd: an unref'd timer would let a bare CLI process exit silently while the
 * request is still pending.
 */
function createTimeoutGuard(timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  let timer = null;
  let rejectGuard;
  const promise = new Promise((_, reject) => { rejectGuard = reject; });
  promise.catch(() => { /* the race may settle first; never unhandled */ });

  const failGuard = (err) => {
    try { controller.abort(err); } catch { /* ignore */ }
    rejectGuard(err);
  };
  timer = setTimeout(
    () => failGuard(new UpdateSourceError('TIMEOUT', `request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  const onExternalAbort = () => failGuard(new UpdateSourceError('ABORTED', 'request aborted by the caller'));
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    promise,
    get aborted() { return controller.signal.aborted; },
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

/**
 * Run one request + body consumption under a single timeout budget, so a server
 * that sends headers and then stalls mid-body is bounded too.
 */
async function withGuard({ timeoutMs, signal, fetchImpl, url, headers, consume }) {
  const guard = createTimeoutGuard(timeoutMs, signal);
  const run = (async () => {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: guard.signal, redirect: 'follow' });
    return consume(res);
  })();
  run.catch(() => { /* raced out; swallow so it is never an unhandled rejection */ });
  try {
    return await Promise.race([run, guard.promise]);
  } finally {
    guard.cleanup();
  }
}

function buildHeaders({ token = null, userAgent = DEFAULT_USER_AGENT, accept = 'application/vnd.github+json' } = {}) {
  const headers = {
    accept,
    'user-agent': userAgent,
    'x-github-api-version': GITHUB_API_VERSION,
  };
  // Optional, and never echoed anywhere.
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? null;
}

/** Recognise GitHub's rate limiting: 429 always, 403 with limit headers. */
function rateLimitInfo(status, headers) {
  const detail = {};
  const limit = headerGet(headers, 'x-ratelimit-limit');
  const remaining = headerGet(headers, 'x-ratelimit-remaining');
  const reset = headerGet(headers, 'x-ratelimit-reset');
  const retryAfter = headerGet(headers, 'retry-after');
  if (limit != null && limit !== '') detail.limit = Number(limit);
  if (remaining != null && remaining !== '') detail.remaining = Number(remaining);
  if (reset != null && /^\d+$/.test(String(reset))) detail.resetAt = new Date(Number(reset) * 1000).toISOString();
  if (retryAfter != null && retryAfter !== '') {
    const n = Number(retryAfter);
    detail.retryAfterSeconds = Number.isFinite(n) ? n : String(retryAfter);
  }
  return { rateLimited: status === 403 || status === 429, detail };
}

function rateLimitMessage(status, detail) {
  const bits = [];
  if (detail.limit !== undefined) bits.push(`limit ${detail.limit}/hour`);
  if (detail.remaining !== undefined) bits.push(`remaining ${detail.remaining}`);
  if (detail.resetAt) bits.push(`resets at ${detail.resetAt}`);
  if (detail.retryAfterSeconds !== undefined) bits.push(`retry after ${detail.retryAfterSeconds}s`);
  let msg = `GitHub rate limit reached (HTTP ${status})${bits.length > 0 ? `: ${bits.join(', ')}` : ''}. `
    + 'Unauthenticated requests are limited to 60/hour per IP; pass a token to raise the limit.';
  if (status === 403) msg += ' A 403 can also mean the token cannot see this repository.';
  return msg;
}

async function safeText(res) {
  try {
    if (typeof res?.text !== 'function') return '';
    const text = await res.text();
    return typeof text === 'string' ? text.slice(0, 400) : '';
  } catch {
    return '';
  }
}

/** Shared HTTP-failure mapping for both the API call and the download. */
function describeHttpFailure({ label, url, status, statusText, headers, bodyText, token }) {
  const info = rateLimitInfo(status, headers);
  const suffix = statusText ? ` ${statusText}` : '';
  if (info.rateLimited) {
    return httpFail('RATE_LIMITED', redact(`${label} returned HTTP ${status}${suffix} for ${url}. ${rateLimitMessage(status, info.detail)}`, token),
      status, { rateLimited: true, rateLimit: info.detail });
  }
  const body = bodyText ? ` Body: ${bodyText.trim().slice(0, 200)}` : '';
  return httpFail('HTTP_ERROR', redact(`${label} returned HTTP ${status}${suffix} for ${url}.${body}`, token),
    status, { rateLimited: false });
}

function toRegExp(pattern, fallback) {
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace(/g/g, ''));
  if (typeof pattern === 'string' && pattern !== '') return new RegExp(pattern, 'i');
  return fallback;
}

function assetView(asset) {
  return {
    name: String(asset.name),
    url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : null,
    size: Number.isFinite(asset.size) ? asset.size : null,
  };
}

/* ------------------------------------------------------------------ */
/* fetchLatestRelease                                                 */
/* ------------------------------------------------------------------ */

/**
 * `GET {apiBase}/repos/{repo}/releases/latest`.
 *
 * GitHub's `latest` endpoint excludes drafts and pre-releases, so `tag` here is
 * always a published release tag.
 *
 * @returns {Promise<{ok:true, tag:string, version:object|null, assets:{tarball:object,sums:object}, htmlUrl:string|null, publishedAt:string|null, prerelease:boolean, name:string|null, status:number}
 *   | {ok:false, code:string, error:string, status?:number, rateLimited?:boolean}>}
 */
export async function fetchLatestRelease({
  repo = DEFAULT_REPO,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  token = null,
  apiBase = DEFAULT_API_BASE,
  userAgent = DEFAULT_USER_AGENT,
  tarballPattern = DEFAULT_TARBALL_PATTERN,
  sumsPattern = DEFAULT_SUMS_PATTERN,
  signal = null,
} = {}) {
  try {
    if (typeof fetchImpl !== 'function') {
      throw new UpdateSourceError('NO_FETCH', 'no fetch implementation available (Node.js 18+ required)');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new UpdateSourceError('BAD_TIMEOUT', `timeoutMs must be a positive number, got ${JSON.stringify(timeoutMs)}`);
    }
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new UpdateSourceError('BAD_REPO', `repo must look like "owner/name", got ${JSON.stringify(repo)}`);
    }
    const base = String(apiBase).replace(/\/+$/, '');
    const url = `${base}/repos/${repo}/releases/latest`;
    const tarballRe = toRegExp(tarballPattern, DEFAULT_TARBALL_PATTERN);
    const sumsRe = toRegExp(sumsPattern, DEFAULT_SUMS_PATTERN);

    const result = await withGuard({
      timeoutMs, signal, fetchImpl, url,
      headers: buildHeaders({ token, userAgent }),
      consume: async (res) => {
        const status = Number(res.status);
        const common = { status, ok: res.ok === true, statusText: res.statusText, headers: res.headers };
        if (!common.ok) return { ...common, bodyText: await safeText(res) };
        try {
          return { ...common, json: await res.json() };
        } catch (err) {
          return { ...common, jsonError: err };
        }
      },
    });

    if (!result.ok) {
      return describeHttpFailure({
        label: 'GitHub API', url, status: result.status, statusText: result.statusText,
        headers: result.headers, bodyText: result.bodyText ?? '', token,
      });
    }
    if (result.jsonError) {
      return httpFail('BAD_JSON', redact(`GitHub API returned a non-JSON body (HTTP ${result.status}) for ${url}`, token), result.status);
    }
    const json = result.json;
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return httpFail('BAD_JSON', `GitHub API returned an unexpected payload (HTTP ${result.status})`, result.status);
    }
    const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : '';
    if (tag === '') {
      return httpFail('NO_TAG', `release payload has no tag_name (HTTP ${result.status})`, result.status);
    }

    const assets = Array.isArray(json.assets) ? json.assets.filter((a) => a && typeof a.name === 'string') : [];
    const names = assets.map((a) => a.name);
    const tarballAsset = assets.find((a) => tarballRe.test(a.name));
    if (!tarballAsset) {
      return httpFail('ASSET_MISSING',
        `no release asset matches ${tarballRe} for ${tag}; available: [${names.join(', ')}]`, result.status);
    }
    const sumsAsset = assets.find((a) => sumsRe.test(a.name));
    if (!sumsAsset) {
      return httpFail('ASSET_MISSING',
        `no SHA256SUMS asset for ${tag}; cannot verify a download without it. available: [${names.join(', ')}]`, result.status);
    }
    const tarball = assetView(tarballAsset);
    const sums = assetView(sumsAsset);
    if (!tarball.url) return httpFail('ASSET_MISSING', `tarball asset ${tarball.name} has no download URL`, result.status);
    if (!sums.url) return httpFail('ASSET_MISSING', `checksum asset ${sums.name} has no download URL`, result.status);

    return {
      ok: true,
      status: result.status,
      tag,
      version: parseVersion(tag), // null when the tag is not SemVer -> isNewer() is false
      assets: { tarball, sums },
      htmlUrl: typeof json.html_url === 'string' ? json.html_url : null,
      publishedAt: typeof json.published_at === 'string' ? json.published_at : null,
      prerelease: json.prerelease === true,
      name: typeof json.name === 'string' ? json.name : null,
    };
  } catch (err) {
    return toFailure(err, token);
  }
}

/* ------------------------------------------------------------------ */
/* streaming download + verification                                  */
/* ------------------------------------------------------------------ */

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

/**
 * Feed a response body to `onChunk` one chunk at a time.
 * Supports both a web `ReadableStream` (what `fetch` returns) and a Node
 * async-iterable, so the caller can inject either.
 */
async function consumeBody(body, onChunk) {
  if (body === null || body === undefined) return 0;
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value === null) continue;
      const buf = toBuffer(value);
      total += buf.length;
      await onChunk(buf);
    }
    return total;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    let total = 0;
    for await (const chunk of body) {
      const buf = toBuffer(chunk);
      total += buf.length;
      await onChunk(buf);
    }
    return total;
  }
  throw new UpdateSourceError('BAD_BODY', 'response body is neither a web ReadableStream nor async-iterable');
}

/**
 * Stream `url` to `destPath`, hashing as it goes.
 *
 * The bytes land in `<destPath>.part-<pid>-<rand>` in the SAME directory (so the
 * final `rename` is atomic on one filesystem). Nothing is put in place until the
 * sha256 matches; on any failure the temp file is removed and an existing
 * `destPath` is left exactly as it was.
 *
 * @returns {Promise<{ok:true, bytes:number, sha256:string, path:string}
 *   | {ok:false, code:string, error:string, status?:number}>}
 */
export async function downloadVerified({
  url,
  sha256,
  destPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  token = null,
  userAgent = DEFAULT_USER_AGENT,
  expectedBytes = null,
  signal = null,
} = {}) {
  let tempPath = null;
  try {
    if (typeof fetchImpl !== 'function') {
      throw new UpdateSourceError('NO_FETCH', 'no fetch implementation available (Node.js 18+ required)');
    }
    if (typeof url !== 'string' || url === '') {
      throw new UpdateSourceError('BAD_URL', 'url is required');
    }
    if (typeof destPath !== 'string' || destPath === '') {
      throw new UpdateSourceError('BAD_DEST', 'destPath is required');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new UpdateSourceError('BAD_TIMEOUT', `timeoutMs must be a positive number, got ${JSON.stringify(timeoutMs)}`);
    }
    const expected = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
    if (expected === '') {
      throw new UpdateSourceError('MISSING_CHECKSUM',
        'refusing to download without an expected sha256: an unverified artifact must never be installed');
    }
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new UpdateSourceError('BAD_CHECKSUM', `expected sha256 must be 64 lowercase hex characters, got ${JSON.stringify(sha256)}`);
    }

    const target = path.resolve(destPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    tempPath = `${target}.part-${process.pid}-${randomBytes(6).toString('hex')}`;

    const hash = createHash('sha256');
    const handle = await fsp.open(tempPath, 'wx', 0o600);
    let bytes = 0;
    let httpFailure = null;
    try {
      const result = await withGuard({
        timeoutMs, signal, fetchImpl, url,
        headers: buildHeaders({ token, userAgent, accept: 'application/octet-stream' }),
        consume: async (res) => {
          if (res.ok !== true) {
            return { ok: false, status: Number(res.status), statusText: res.statusText, headers: res.headers, bodyText: await safeText(res) };
          }
          const written = await consumeBody(res.body, async (chunk) => {
            hash.update(chunk);            // hash while streaming: the file is never held in memory
            await handle.write(chunk);
          });
          return { ok: true, status: Number(res.status), written };
        },
      });

      if (!result.ok) {
        httpFailure = describeHttpFailure({
          label: 'download', url, status: result.status, statusText: result.statusText,
          headers: result.headers, bodyText: result.bodyText ?? '', token,
        });
      } else {
        bytes = result.written;
      }
    } finally {
      await handle.close().catch(() => {});
    }

    if (httpFailure) return httpFailure;

    const digest = hash.digest('hex');
    if (digest !== expected) {
      return fail('CHECKSUM_MISMATCH',
        `sha256 mismatch for ${url}: expected ${expected}, got ${digest}`, { expected, actual: digest, bytes });
    }
    if (expectedBytes !== null && Number.isFinite(expectedBytes) && bytes !== expectedBytes) {
      return fail('SIZE_MISMATCH',
        `size mismatch for ${url}: expected ${expectedBytes} bytes, got ${bytes}`, { expected: expectedBytes, actual: bytes });
    }

    await fsp.rename(tempPath, target);
    tempPath = null; // renamed into place: the finally-cleanup must not remove it
    return { ok: true, bytes, sha256: digest, path: target };
  } catch (err) {
    return toFailure(err, token);
  } finally {
    if (tempPath !== null) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

export default { fetchLatestRelease, downloadVerified, parseVersion, compareVersions, isNewer, parseSha256Sums, findChecksum };
