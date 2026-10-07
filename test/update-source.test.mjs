/**
 * update-source tests — node:test + node:assert, zero dependencies.
 * Run: node --test w2m/test/update-source.test.mjs
 *
 * Everything except the last case uses an injected fake `fetch`, so it is
 * hermetic and instant. The last case talks to the real GitHub API and is either
 * run or EXPLICITLY skipped via W2M_SKIP_NETWORK_TESTS=1 -- never silently.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_REPO,
  UpdateSourceError,
  VersionError,
  compareVersions,
  downloadVerified,
  fetchLatestRelease,
  findChecksum,
  isNewer,
  parseSha256Sums,
  parseVersion,
  redact,
  requireChecksum,
} from '../src/plugin/update-source.mjs';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-update-test-'));
}

const tmpDirs = [];
function tmpDir() {
  const dir = makeTmpDir();
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Minimal Response look-alike. Deliberately has NO arrayBuffer()/text() on
 *  download responses, so a non-streaming implementation would blow up. */
function fakeResponse({ status = 200, statusText = '', headers = {}, json, text, body, streamed = false, url = '' } = {}) {
  const res = {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    url,
    body: body ?? null,
    async json() {
      if (json === undefined) throw new SyntaxError('Unexpected token < in JSON');
      return json;
    },
  };
  if (!streamed) res.text = async () => text ?? (json !== undefined ? JSON.stringify(json) : '');
  return res;
}

/** A web ReadableStream-alike: `getReader().read()` until done. */
function webBody(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[i++] };
        },
      };
    },
  };
}

function nodeBody(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** fetch that records calls and returns the queued responses. */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected fetch call: ${url}`);
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, opts);
    return next;
  };
  impl.calls = calls;
  return impl;
}

/** fetch that never settles until its signal aborts (a well-behaved hang). */
function hangingFetch() {
  const state = { aborted: false, signal: null };
  const impl = (url, opts = {}) => new Promise((_, reject) => {
    state.signal = opts.signal;
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        state.aborted = true;
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    }
  });
  impl.state = state;
  return impl;
}

/** fetch that ignores the signal completely: the scheduler-wedge scenario. */
function ignoringFetch() {
  const impl = () => new Promise(() => { /* never settles, ignores abort */ });
  return impl;
}

const RELEASE_JSON = {
  tag_name: 'v0.1.2',
  name: 'W2M 0.1.2',
  html_url: 'https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.1.2',
  published_at: '2026-10-07T12:00:00Z',
  prerelease: false,
  draft: false,
  assets: [
    {
      name: 'twinsearth-w2m-dsh-plugin-0.1.2.tgz',
      browser_download_url: 'https://example.test/dl/plugin.tgz',
      size: 159842,
    },
    { name: 'SHA256SUMS', browser_download_url: 'https://example.test/dl/SHA256SUMS', size: 102 },
    { name: 'notes.txt', browser_download_url: 'https://example.test/dl/notes.txt', size: 10 },
  ],
};

const okRelease = (over = {}) => fakeResponse({ json: { ...RELEASE_JSON, ...over } });

/* ================================================================== */
/* parseVersion                                                       */
/* ================================================================== */

describe('parseVersion', () => {
  it('accepts the tag shapes GitHub actually produces', () => {
    assert.deepEqual(parseVersion('v0.1.2'), { major: 0, minor: 1, patch: 2, pre: null, build: null, raw: 'v0.1.2' });
    assert.deepEqual(parseVersion('0.1.2'), { major: 0, minor: 1, patch: 2, pre: null, build: null, raw: '0.1.2' });
    assert.deepEqual(parseVersion('  v1.20.300  '), { major: 1, minor: 20, patch: 300, pre: null, build: null, raw: 'v1.20.300' });
  });

  it('fills missing components with zero and keeps pre-release/build', () => {
    assert.equal(parseVersion('v2').patch, 0);
    assert.equal(parseVersion('v1.4').minor, 4);
    assert.equal(parseVersion('1.4').patch, 0);
    const rc = parseVersion('v0.2.0-rc.1');
    assert.equal(rc.pre, 'rc.1');
    assert.equal(rc.patch, 0);
    const built = parseVersion('0.2.0-rc.1+build.7');
    assert.equal(built.pre, 'rc.1');
    assert.equal(built.build, 'build.7');
  });

  it('returns null (never throws) for anything unparseable', () => {
    for (const bad of ['', '   ', 'latest', 'v', 'x1.2.3', '1.2.3.4', 'v1.2.3-', 'v1.2.3+', 'nightly-2026', null, undefined, 42, {}, []]) {
      assert.equal(parseVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

/* ================================================================== */
/* compareVersions / isNewer                                          */
/* ================================================================== */

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
    assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.2.0', '1.10.0'), -1, 'numeric, not lexical');
    assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, 'the leading v is not significant');
  });

  it('implements the SemVer §11 pre-release chain', () => {
    const chain = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
      '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
    ];
    for (let i = 0; i < chain.length - 1; i += 1) {
      assert.equal(compareVersions(chain[i], chain[i + 1]), -1, `${chain[i]} < ${chain[i + 1]}`);
      assert.equal(compareVersions(chain[i + 1], chain[i]), 1, `${chain[i + 1]} > ${chain[i]}`);
    }
    assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1, 'numeric identifiers compare numerically');
    assert.equal(compareVersions('1.0.0-2', '1.0.0-11'), -1);
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1, 'numeric sorts below alphanumeric');
  });

  it('RULING: a pre-release sorts below the same version release', () => {
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
    assert.equal(compareVersions('0.1.2-rc.1', '0.1.2'), -1);
    // and above any lower triple, which is the documented consequence
    assert.equal(compareVersions('0.2.0-rc.1', '0.1.2'), 1);
  });

  it('ignores build metadata (SemVer §10)', () => {
    assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
    assert.equal(compareVersions('1.0.0-rc.1+x', '1.0.0-rc.1+y'), 0);
  });

  it('throws VersionError on unparseable input, and accepts parsed objects', () => {
    assert.throws(() => compareVersions('nonsense', '1.0.0'), VersionError);
    assert.throws(() => compareVersions('1.0.0', null), VersionError);
    assert.equal(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3')), 0);
  });
});

describe('isNewer (the update gate)', () => {
  it('is true ONLY for a strictly greater version', () => {
    assert.equal(isNewer('0.1.3', '0.1.2'), true);
    assert.equal(isNewer('v0.2.0', 'v0.1.9'), true);
    assert.equal(isNewer('1.0.0', '0.9.9'), true);
  });

  it('never downgrades: equal and older are false', () => {
    assert.equal(isNewer('0.1.2', '0.1.2'), false);
    assert.equal(isNewer('v0.1.2', '0.1.2'), false);
    assert.equal(isNewer('0.1.1', '0.1.2'), false);
    assert.equal(isNewer('0.0.9', '1.0.0'), false);
    assert.equal(isNewer('1.0.0-rc.1', '1.0.0'), false, 'a pre-release is not an upgrade over its release');
  });

  it('treats unparseable input as "no update" and never throws', () => {
    for (const bad of ['', 'latest', 'nightly', '1.2.3.4', null, undefined, 42, {}]) {
      assert.equal(isNewer(bad, '0.1.2'), false, `candidate ${JSON.stringify(bad)}`);
      assert.equal(isNewer('0.2.0', bad), false, `current ${JSON.stringify(bad)}`);
      assert.equal(isNewer(bad, bad), false);
    }
  });
});

/* ================================================================== */
/* SHA256SUMS                                                         */
/* ================================================================== */

describe('SHA256SUMS parsing', () => {
  const H1 = 'a'.repeat(64);
  const H2 = 'b'.repeat(64);

  it('parses the "<hash>  <filename>" format and picks the target', () => {
    const text = `${H1}  twinsearth-w2m-dsh-plugin-0.1.2.tgz\n${H2}  other-file.zip\n`;
    const entries = parseSha256Sums(text);
    assert.equal(entries.size, 2);
    assert.equal(entries.get('twinsearth-w2m-dsh-plugin-0.1.2.tgz'), H1);
    assert.equal(findChecksum(text, 'twinsearth-w2m-dsh-plugin-0.1.2.tgz'), H1);
    assert.equal(findChecksum(text, 'other-file.zip'), H2);
  });

  it('tolerates blank lines, comments, CRLF, "*" binary markers and "./" prefixes', () => {
    const text = [
      '# generated by the release job',
      '',
      `${H1} *./dist/twinsearth-w2m-dsh-plugin-0.1.2.tgz`,
      '   ',
      `${H2}  second.txt`,
      '',
    ].join('\r\n');
    const entries = parseSha256Sums(text);
    assert.equal(entries.size, 2, 'comments and blanks are not entries');
    assert.equal(findChecksum(text, 'twinsearth-w2m-dsh-plugin-0.1.2.tgz'), H1, 'matches on basename');
    assert.equal(findChecksum(text, './dist/twinsearth-w2m-dsh-plugin-0.1.2.tgz'), H1);
  });

  it('lowercases hashes and accepts uppercase input', () => {
    const upper = 'AB'.repeat(32);
    assert.equal(findChecksum(`${upper}  pkg.tgz\n`, 'pkg.tgz'), upper.toLowerCase());
  });

  it('rejects a malformed line with the line number', () => {
    const text = `${H1}  good.tgz\nnot-a-checksum-line\n`;
    assert.throws(() => parseSha256Sums(text), (err) => {
      assert.ok(err instanceof UpdateSourceError);
      assert.equal(err.code, 'BAD_SUMS_FORMAT');
      assert.equal(err.line, 2);
      assert.match(err.message, /line 2/);
      return true;
    });
  });

  it('rejects a short hash, a missing filename and an empty file', () => {
    assert.throws(() => parseSha256Sums(`${'a'.repeat(63)}  x.tgz\n`), (e) => e.code === 'BAD_SUMS_FORMAT');
    assert.throws(() => parseSha256Sums(`${H1}\n`), (e) => e.code === 'BAD_SUMS_FORMAT');
    assert.throws(() => parseSha256Sums(''), (e) => e.code === 'BAD_SUMS');
    assert.throws(() => parseSha256Sums('# only a comment\n'), (e) => e.code === 'BAD_SUMS');
    assert.throws(() => parseSha256Sums(null), (e) => e.code === 'BAD_SUMS');
  });

  it('rejects conflicting duplicate entries but allows identical ones', () => {
    assert.throws(() => parseSha256Sums(`${H1}  pkg.tgz\n${H2}  pkg.tgz\n`), (e) => e.code === 'BAD_SUMS_CONFLICT');
    const same = parseSha256Sums(`${H1}  pkg.tgz\n${H1}  pkg.tgz\n`);
    assert.equal(same.size, 1);
  });

  it('findChecksum returns null when absent; requireChecksum throws', () => {
    const text = `${H1}  pkg.tgz\n`;
    assert.equal(findChecksum(text, 'missing.tgz'), null);
    assert.throws(() => requireChecksum(text, 'missing.tgz'), (e) => e.code === 'CHECKSUM_NOT_FOUND');
    assert.equal(requireChecksum(text, 'pkg.tgz'), H1);
  });
});

/* ================================================================== */
/* fetchLatestRelease                                                 */
/* ================================================================== */

describe('fetchLatestRelease', () => {
  it('returns tag, version and both assets on the happy path', async () => {
    const fetchImpl = scriptedFetch([okRelease()]);
    const res = await fetchLatestRelease({ repo: DEFAULT_REPO, fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.tag, 'v0.1.2');
    assert.equal(res.version.major, 0);
    assert.equal(res.version.patch, 2);
    assert.equal(res.assets.tarball.name, 'twinsearth-w2m-dsh-plugin-0.1.2.tgz');
    assert.equal(res.assets.tarball.size, 159842);
    assert.equal(res.assets.tarball.url, 'https://example.test/dl/plugin.tgz');
    assert.equal(res.assets.sums.name, 'SHA256SUMS');
    assert.equal(res.assets.sums.url, 'https://example.test/dl/SHA256SUMS');
    assert.equal(res.htmlUrl, RELEASE_JSON.html_url);
    assert.equal(res.publishedAt, RELEASE_JSON.published_at);
    assert.equal(res.prerelease, false);

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`);
    assert.equal(fetchImpl.calls[0].opts.headers.accept, 'application/vnd.github+json');
    assert.ok(fetchImpl.calls[0].opts.signal, 'the request is abortable');
    assert.equal(fetchImpl.calls[0].opts.headers.authorization, undefined, 'no token -> no Authorization header');
  });

  it('feeds the tag straight into the update gate', async () => {
    const fetchImpl = scriptedFetch([okRelease()]);
    const res = await fetchLatestRelease({ fetchImpl });
    assert.equal(isNewer(res.tag, '0.1.1'), true);
    assert.equal(isNewer(res.tag, '0.1.2'), false);
    assert.equal(isNewer(res.tag, '0.2.0'), false);
  });

  it('returns ok:false with the status for a 404', async () => {
    const fetchImpl = scriptedFetch([fakeResponse({ status: 404, statusText: 'Not Found', json: { message: 'Not Found' } })]);
    const res = await fetchLatestRelease({ fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(res.code, 'HTTP_ERROR');
    assert.match(res.error, /404/);
    assert.match(res.error, /Not Found/);
  });

  it('recognises rate limiting on 403 by default', async () => {
    const fetchImpl = scriptedFetch([fakeResponse({
      status: 403,
      statusText: 'Forbidden',
      headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' },
      json: { message: 'API rate limit exceeded' },
    })]);
    const res = await fetchLatestRelease({ fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.code, 'RATE_LIMITED');
    assert.equal(res.rateLimited, true);
    assert.equal(res.rateLimit.remaining, 0);
    assert.equal(res.rateLimit.limit, 60);
    assert.match(res.rateLimit.resetAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(res.error, /rate limit/i);
    assert.match(res.error, /60\/hour/, 'the limit is spelled out so the user can act');
    assert.match(res.error, /token/, 'and it says how to raise it');
  });

  it('recognises rate limiting on 429 with retry-after', async () => {
    const fetchImpl = scriptedFetch([fakeResponse({
      status: 429,
      headers: { 'retry-after': '42' },
      json: { message: 'You have exceeded a secondary rate limit' },
    })]);
    const res = await fetchLatestRelease({ fetchImpl });
    assert.equal(res.code, 'RATE_LIMITED');
    assert.equal(res.rateLimited, true);
    assert.equal(res.rateLimit.retryAfterSeconds, 42);
    assert.match(res.error, /retry after 42s/);
    assert.match(res.error, /429/);
  });

  it('reports a 500 as a plain HTTP error, not a rate limit', async () => {
    const fetchImpl = scriptedFetch([fakeResponse({ status: 500, statusText: 'Internal Server Error', text: 'boom' })]);
    const res = await fetchLatestRelease({ fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'HTTP_ERROR');
    assert.equal(res.status, 500);
    assert.equal(res.rateLimited, false);
    assert.match(res.error, /500/);
    assert.match(res.error, /boom/, 'a body snippet helps a human reading the log');
  });

  it('reports a non-JSON 200 body as BAD_JSON', async () => {
    const fetchImpl = scriptedFetch([fakeResponse({ status: 200, text: '<html>proxy</html>' })]);
    const res = await fetchLatestRelease({ fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_JSON');
    assert.equal(res.status, 200);
  });

  it('fails clearly when the tarball asset is missing', async () => {
    const fetchImpl = scriptedFetch([okRelease({ assets: [RELEASE_JSON.assets[1]] })]);
    const res = await fetchLatestRelease({ fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ASSET_MISSING');
    assert.match(res.error, /SHA256SUMS/, 'lists what WAS available');
  });

  it('fails when the checksum asset is missing: an unverifiable update must not be offered', async () => {
    const fetchImpl = scriptedFetch([okRelease({ assets: [RELEASE_JSON.assets[0]] })]);
    const res = await fetchLatestRelease({ fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ASSET_MISSING');
    assert.match(res.error, /SHA256SUMS/);
  });

  it('fails when the tag is absent, and returns version:null for a non-SemVer tag', async () => {
    const noTag = await fetchLatestRelease({ fetchImpl: scriptedFetch([okRelease({ tag_name: '' })]) });
    assert.equal(noTag.ok, false);
    assert.equal(noTag.code, 'NO_TAG');

    const weird = await fetchLatestRelease({ fetchImpl: scriptedFetch([okRelease({ tag_name: 'nightly-2026-10-08' })]) });
    assert.equal(weird.ok, true, 'a weird tag is not an HTTP failure');
    assert.equal(weird.version, null);
    assert.equal(isNewer(weird.tag, '0.1.2'), false, 'and it can never trigger an update');
  });

  it('returns {ok:false} instead of throwing on a network error', async () => {
    const boom = new TypeError('fetch failed');
    boom.cause = new Error('getaddrinfo ENOTFOUND api.github.com');
    const res = await fetchLatestRelease({ fetchImpl: scriptedFetch([boom]) });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NETWORK');
    assert.match(res.error, /ENOTFOUND/, 'the underlying cause is surfaced for a human');
    assert.equal(res.status, undefined);
  });

  it('returns {ok:false} for bad arguments instead of throwing', async () => {
    assert.equal((await fetchLatestRelease({ fetchImpl: null })).code, 'NO_FETCH');
    assert.equal((await fetchLatestRelease({ fetchImpl: async () => okRelease(), repo: 'not-a-repo' })).code, 'BAD_REPO');
    assert.equal((await fetchLatestRelease({ fetchImpl: async () => okRelease(), timeoutMs: 0 })).code, 'BAD_TIMEOUT');
    assert.equal((await fetchLatestRelease({ fetchImpl: async () => okRelease(), timeoutMs: 'soon' })).code, 'BAD_TIMEOUT');
  });

  /* ---- requirement 2: the timeout must really abort ---- */

  it('times out and aborts a hung request', async () => {
    const fetchImpl = hangingFetch();
    const started = Date.now();
    const res = await fetchLatestRelease({ fetchImpl, timeoutMs: 120 });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TIMEOUT');
    assert.match(res.error, /timed out after 120ms/);
    assert.ok(elapsed < 3000, `must settle promptly, took ${elapsed}ms`);
    assert.equal(fetchImpl.state.aborted, true, 'the AbortController actually fired');
  });

  it('NEVER wedges the scheduler, even if fetch ignores the abort signal', async () => {
    // This is the failure mode that matters: the scheduler runs 3x/day, so a
    // promise that never settles is a silent, permanent outage.
    const started = Date.now();
    const res = await fetchLatestRelease({ fetchImpl: ignoringFetch(), timeoutMs: 120 });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TIMEOUT');
    assert.ok(elapsed < 3000, `settled in ${elapsed}ms without any cooperation from fetch`);
  });

  it('aborts when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = hangingFetch();
    const promise = fetchLatestRelease({ fetchImpl, timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const res = await promise;
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ABORTED');
  });

  /* ---- requirement 6: the token must never escape ---- */

  it('sends the token as a bearer header and never leaks it', async () => {
    const TOKEN = 'ghp_SUPERSECRETtokenvalue0123456789';
    const fetchImpl = scriptedFetch([okRelease()]);
    const ok = await fetchLatestRelease({ fetchImpl, token: TOKEN });
    assert.equal(ok.ok, true);
    assert.equal(fetchImpl.calls[0].opts.headers.authorization, `Bearer ${TOKEN}`);

    // every failure shape must be scrubbed
    const failures = [
      await fetchLatestRelease({ fetchImpl: scriptedFetch([fakeResponse({ status: 500, text: `boom ${TOKEN}` })]), token: TOKEN }),
      await fetchLatestRelease({ fetchImpl: scriptedFetch([fakeResponse({ status: 403, json: { message: `rate ${TOKEN}` } })]), token: TOKEN }),
      await fetchLatestRelease({ fetchImpl: scriptedFetch([new Error(`connect failed for ${TOKEN}`)]), token: TOKEN }),
      await fetchLatestRelease({ fetchImpl: hangingFetch(), timeoutMs: 60, token: TOKEN }),
      await fetchLatestRelease({ fetchImpl: scriptedFetch([okRelease({ tag_name: '' })]), token: TOKEN }),
    ];
    for (const failure of failures) {
      const serialized = JSON.stringify(failure);
      assert.equal(serialized.includes(TOKEN), false, `token leaked in: ${serialized}`);
      assert.equal(failure.error.includes(TOKEN), false, 'token leaked in the message');
    }
    assert.match(failures[0].error, /\[REDACTED\]/, 'the token was actively redacted, not merely absent');
  });

  it('redact() scrubs bearer tokens and access_token query parameters', () => {
    assert.equal(redact('token is abc123', 'abc123'), 'token is [REDACTED]');
    assert.equal(redact('Authorization: Bearer ghp_abcdefghijklmnop'), 'Authorization: Bearer [REDACTED]');
    assert.equal(
      redact('https://example.test/x?access_token=ghp_secretvalue&y=1'),
      'https://example.test/x?access_token=[REDACTED]&y=1',
    );
  });
});

/* ================================================================== */
/* downloadVerified                                                   */
/* ================================================================== */

describe('downloadVerified', () => {
  const PAYLOAD = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(64));
  const DIGEST = sha256(PAYLOAD);

  const bodyResponse = (chunks, over = {}) => fakeResponse({
    status: 200, streamed: true, body: webBody(chunks), ...over,
  });

  it('streams to a temp file, verifies, and renames into place', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'pkg.tgz');
    const chunks = [PAYLOAD.subarray(0, 100), PAYLOAD.subarray(100, 500), PAYLOAD.subarray(500)];
    const fetchImpl = scriptedFetch([bodyResponse(chunks)]);

    const res = await downloadVerified({ url: 'https://example.test/dl/plugin.tgz', sha256: DIGEST, destPath: dest, fetchImpl });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.bytes, PAYLOAD.length);
    assert.equal(res.sha256, DIGEST);
    assert.equal(res.path, dest);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD, 'the file on disk is byte-exact');
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.includes('.part-')), [],
      'no temp file is left behind',
    );
  });

  it('bounded memory: response objects with no arrayBuffer()/text() still work', async () => {
    // `fakeResponse({streamed:true})` deliberately omits text()/arrayBuffer(), so a
    // non-streaming implementation would throw here rather than pass.
    const dir = tmpDir();
    const dest = path.join(dir, 'big.bin');
    const chunk = Buffer.alloc(256 * 1024, 7);
    const chunks = Array.from({ length: 64 }, () => chunk); // 16 MiB total
    const digest = sha256(Buffer.concat(chunks));
    const fetchImpl = scriptedFetch([bodyResponse(chunks)]);

    const before = process.memoryUsage().arrayBuffers;
    const res = await downloadVerified({ url: 'https://example.test/big', sha256: digest, destPath: dest, fetchImpl });
    const growth = process.memoryUsage().arrayBuffers - before;

    assert.equal(res.ok, true, res.error);
    assert.equal(res.bytes, 16 * 1024 * 1024);
    assert.equal(fs.statSync(dest).size, 16 * 1024 * 1024);
    // Buffers live in `arrayBuffers`, not `heapUsed`. Streaming reuses the chunk
    // (growth ~0); reading the whole body first would allocate the full 16 MiB.
    assert.ok(growth < 8 * 1024 * 1024,
      `16 MiB streamed should not allocate ${(growth / 1048576).toFixed(1)} MiB of buffers`);
  });

  it('also accepts a Node async-iterable body', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'iter.tgz');
    const fetchImpl = scriptedFetch([fakeResponse({ status: 200, streamed: true, body: nodeBody([PAYLOAD.subarray(0, 30), PAYLOAD.subarray(30)]) })]);
    const res = await downloadVerified({ url: 'https://example.test/iter', sha256: DIGEST, destPath: dest, fetchImpl });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(fs.readFileSync(dest), PAYLOAD);
  });

  it('deletes the temp file and keeps the OLD file on a checksum mismatch', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'pkg.tgz');
    fs.writeFileSync(dest, 'previous good version');
    const fetchImpl = scriptedFetch([bodyResponse([Buffer.from('tampered bytes')])]);

    const res = await downloadVerified({ url: 'https://example.test/x', sha256: DIGEST, destPath: dest, fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CHECKSUM_MISMATCH');
    assert.match(res.error, /expected .* got /);
    assert.equal(res.expected, DIGEST);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'previous good version', 'the installed file is untouched');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.part-')), [], 'temp file removed');
  });

  it('cleans up when the stream fails midway', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'pkg.tgz');
    const brokenBody = {
      getReader() {
        let n = 0;
        return {
          async read() {
            n += 1;
            if (n === 1) return { done: false, value: PAYLOAD.subarray(0, 10) };
            throw new Error('socket hang up');
          },
        };
      },
    };
    const fetchImpl = scriptedFetch([fakeResponse({ status: 200, streamed: true, body: brokenBody })]);
    const res = await downloadVerified({ url: 'https://example.test/x', sha256: DIGEST, destPath: dest, fetchImpl });
    assert.equal(res.ok, false);
    assert.match(res.error, /socket hang up/);
    assert.equal(fs.existsSync(dest), false, 'nothing was installed');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.part-')), [], 'temp file removed');
  });

  it('reports an HTTP failure and installs nothing', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'pkg.tgz');
    const fetchImpl = scriptedFetch([fakeResponse({ status: 404, statusText: 'Not Found', text: 'nope' })]);
    const res = await downloadVerified({ url: 'https://example.test/gone', sha256: DIGEST, destPath: dest, fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(res.code, 'HTTP_ERROR');
    assert.equal(fs.existsSync(dest), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('recognises rate limiting on the download too', async () => {
    const dir = tmpDir();
    const fetchImpl = scriptedFetch([fakeResponse({ status: 429, headers: { 'retry-after': '7' }, text: 'slow down' })]);
    const res = await downloadVerified({
      url: 'https://example.test/x', sha256: DIGEST, destPath: path.join(dir, 'a.tgz'), fetchImpl,
    });
    assert.equal(res.code, 'RATE_LIMITED');
    assert.equal(res.rateLimited, true);
    assert.equal(res.rateLimit.retryAfterSeconds, 7);
  });

  it('times out a stalled body without leaving a temp file', async () => {
    const dir = tmpDir();
    const stallBody = {
      getReader() {
        return { async read() { return new Promise(() => { /* stall forever */ }); } };
      },
    };
    const fetchImpl = scriptedFetch([fakeResponse({ status: 200, streamed: true, body: stallBody })]);
    const started = Date.now();
    const res = await downloadVerified({
      url: 'https://example.test/stall', sha256: DIGEST, destPath: path.join(dir, 'a.tgz'), fetchImpl, timeoutMs: 120,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TIMEOUT');
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(fs.readdirSync(dir), [], 'the partial download was removed');
  });

  it('refuses to download without a checksum, without touching the network', async () => {
    const dir = tmpDir();
    const fetchImpl = scriptedFetch([]);
    for (const bad of [undefined, null, '', '   ', 'nothex', 'a'.repeat(63), 'z'.repeat(64), 42]) {
      const res = await downloadVerified({
        url: 'https://example.test/x', sha256: bad, destPath: path.join(dir, 'a.tgz'), fetchImpl,
      });
      assert.equal(res.ok, false, `sha256=${JSON.stringify(bad)}`);
      assert.ok(['MISSING_CHECKSUM', 'BAD_CHECKSUM'].includes(res.code), `got ${res.code}`);
    }
    assert.equal(fetchImpl.calls.length, 0, 'an unverifiable download never starts');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('accepts an uppercase or whitespace-padded expected hash, and validates the byte count', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'x.tgz');
    const fetchImpl = scriptedFetch([bodyResponse([PAYLOAD])]);
    const res = await downloadVerified({
      url: 'https://example.test/x', sha256: `  ${DIGEST.toUpperCase()}  `, destPath: dest, fetchImpl,
      expectedBytes: PAYLOAD.length,
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.sha256, DIGEST, 'the returned hash is lowercase hex');

    const dir2 = tmpDir();
    const wrong = await downloadVerified({
      url: 'https://example.test/x', sha256: DIGEST, destPath: path.join(dir2, 'x.tgz'),
      fetchImpl: scriptedFetch([bodyResponse([PAYLOAD])]), expectedBytes: PAYLOAD.length + 1,
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'SIZE_MISMATCH');
    assert.deepEqual(fs.readdirSync(dir2), []);
  });

  it('creates the destination directory and reports failures without throwing', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'nested', 'deeper', 'pkg.tgz');
    const fetchImpl = scriptedFetch([bodyResponse([PAYLOAD])]);
    const res = await downloadVerified({ url: 'https://example.test/x', sha256: DIGEST, destPath: dest, fetchImpl });
    assert.equal(res.ok, true, res.error);
    assert.equal(fs.readFileSync(dest).length, PAYLOAD.length);

    assert.equal((await downloadVerified({ url: '', sha256: DIGEST, destPath: dest, fetchImpl })).code, 'BAD_URL');
    assert.equal((await downloadVerified({ url: 'https://x', sha256: DIGEST, destPath: '', fetchImpl })).code, 'BAD_DEST');
    assert.equal((await downloadVerified({ url: 'https://x', sha256: DIGEST, destPath: dest, fetchImpl: null })).code, 'NO_FETCH');
    assert.equal((await downloadVerified({ url: 'https://x', sha256: DIGEST, destPath: dest, fetchImpl, timeoutMs: -1 })).code, 'BAD_TIMEOUT');
  });

  it('supports a caller-supplied abort signal', async () => {
    const dir = tmpDir();
    const controller = new AbortController();
    const fetchImpl = hangingFetch();
    const promise = downloadVerified({
      url: 'https://example.test/x', sha256: DIGEST, destPath: path.join(dir, 'a.tgz'),
      fetchImpl, timeoutMs: 5000, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    const res = await promise;
    assert.equal(res.code, 'ABORTED');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('never leaks the token through a download failure', async () => {
    const TOKEN = 'ghp_DOWNLOADsecret0000000000000000';
    const dir = tmpDir();
    const res = await downloadVerified({
      url: 'https://example.test/x', sha256: DIGEST, destPath: path.join(dir, 'a.tgz'),
      fetchImpl: scriptedFetch([fakeResponse({ status: 500, text: `server said ${TOKEN}` })]), token: TOKEN,
    });
    assert.equal(res.ok, false);
    assert.equal(JSON.stringify(res).includes(TOKEN), false, 'token leaked');
  });

  it('sends the token on the download request when provided', async () => {
    const dir = tmpDir();
    const fetchImpl = scriptedFetch([bodyResponse([PAYLOAD])]);
    await downloadVerified({
      url: 'https://example.test/x', sha256: DIGEST, destPath: path.join(dir, 'a.tgz'),
      fetchImpl, token: 'ghp_abc',
    });
    assert.equal(fetchImpl.calls[0].opts.headers.authorization, 'Bearer ghp_abc');
  });
});

/* ================================================================== */
/* real network (explicit, never silently skipped)                     */
/* ================================================================== */

const SKIP_NETWORK = process.env.W2M_SKIP_NETWORK_TESTS === '1';

describe('real GitHub API (network)', () => {
  it('fetches, parses and verifies the published release end to end', async (t) => {
    if (SKIP_NETWORK) {
      // Explicit, visible in the TAP output: never a silent skip.
      t.skip('explicitly skipped: W2M_SKIP_NETWORK_TESTS=1');
      return;
    }

    // Fetch the release with bounded retries.
    //
    // The first call to api.github.com from a cold process was measured at ~18s here, and when the
    // whole suite runs in parallel the connection is occasionally reset (ECONNRESET) before any
    // HTTP status exists. That is a property of the network, not of the code under test, so it is
    // retried and then *skipped with a visible reason* -- never silently passed, and never allowed
    // to turn a real assertion failure below into a skip.
    let release = null;
    let lastNetworkError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      release = await fetchLatestRelease({ repo: DEFAULT_REPO, timeoutMs: 45_000 });
      if (release.ok === true) break;
      lastNetworkError = `${release.code ?? '?'} ${release.error ?? ''}`;
      // A rate limit or a definitive HTTP answer is a fact about the API, not a flaky socket: only
      // a transport-level failure is worth retrying.
      const transport = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|TIMEOUT|ABORTED/i
        .test(lastNetworkError);
      if (!transport) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }

    if (release.ok !== true) {
      const transport = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|TIMEOUT|ABORTED/i
        .test(lastNetworkError ?? '');
      if (transport) {
        t.skip(`GitHub was unreachable after 3 attempts (${lastNetworkError}); run with network to cover this`);
        return;
      }
      assert.fail(`real GitHub call failed: ${lastNetworkError}${release.rateLimited ? ' (rate limited — see the message)' : ''}`);
    }

    // From here the network has answered, so every remaining check is a real assertion.
    assert.match(release.tag, /^v?\d+\.\d+\.\d+/, `tag_name should be a SemVer tag, got ${release.tag}`);
    assert.ok(release.version, `tag ${release.tag} must parse`);
    assert.equal(release.version.major, Number(release.tag.replace(/^v/, '').split('.')[0]));
    assert.ok(release.assets.tarball.name.endsWith('.tgz'), `tarball asset name: ${release.assets.tarball.name}`);
    assert.ok(release.assets.tarball.url.startsWith('https://'), 'asset URLs are absolute https');
    assert.ok(release.assets.tarball.size > 0, 'the tarball has a size');
    assert.equal(release.assets.sums.name, 'SHA256SUMS');
    assert.ok(release.assets.sums.url.startsWith('https://'));

    // and the checksum asset really parses and really covers the tarball
    const res = await globalThis.fetch(release.assets.sums.url, {
      headers: { 'user-agent': 'w2m-update-check', accept: 'text/plain' },
      signal: AbortSignal.timeout(45_000),
    });
    assert.equal(res.status, 200);
    const sumsText = await res.text();
    const expected = findChecksum(sumsText, release.assets.tarball.name);
    assert.ok(expected, `SHA256SUMS must list ${release.assets.tarball.name}; got:\n${sumsText}`);
    assert.match(expected, /^[0-9a-f]{64}$/);
    // the declared asset size is a second, independent cross-check of the metadata
    assert.equal(Number(res.headers.get('content-length')) > 0, true);

    // and the gate agrees with reality
    assert.equal(isNewer(release.tag, '0.0.0'), true);
    assert.equal(isNewer(release.tag, release.tag), false);
  });
});
