/**
 * Base-address handling for W2M clients (v0.1.2 §2).
 *
 * WHY THIS FILE EXISTS
 *
 * The v1 client built every endpoint with the two-argument URL constructor:
 *
 *     new URL('/v1/stream', rabbitUrl)
 *
 * That call treats the first argument as an absolute path, so it *discards*
 * whatever path `rabbitUrl` had:
 *
 *     new URL('/v1/stream', 'https://h/w2m')  ->  'https://h/v1/stream'
 *                                                          ^^^^ /w2m gone
 *
 * Every request 404s as soon as the relay sits behind a sub-path, which is the
 * normal situation for a Cloudflare Tunnel / ngrok / nginx deployment. The same
 * trap applies to `path.posix.join('https://h', '/v1')`, which collapses the
 * `//` in the scheme into a single slash.
 *
 * The whole fix is therefore: normalise the base once, then concatenate. A
 * base is an opaque prefix, not something to be re-parsed per request.
 *
 * `rabbitUrl` rules (v0.1.2 §2):
 *   * must parse as a URL and use http/https;
 *   * must NOT carry a query string or a fragment (a prefix belongs in the
 *     path: `https://host/w2m`, not `https://host?prefix=/w2m`);
 *   * trailing slashes are stripped, so `https://host/w2m/` and
 *     `https://host/w2m` are the same base;
 *   * a sub-path is preserved verbatim.
 */

/** Error code attached to every rejection from this module. */
export const RABBIT_URL_INVALID = 'RABBIT_URL_INVALID';

/**
 * Build a rejection that always names `rabbitUrl` and the reason.
 *
 * @param {string} message
 * @returns {TypeError}
 */
function invalid(message) {
  const error = new TypeError(message);
  error.code = RABBIT_URL_INVALID;
  return error;
}

/**
 * Validate and normalise a `rabbitUrl` into a base address.
 *
 * @param {string} rabbitUrl e.g. `https://w2m.example.com/w2m/`
 * @returns {string} Base without any trailing slash, e.g. `https://w2m.example.com/w2m`
 * @throws {TypeError} with `code === 'RABBIT_URL_INVALID'` when unusable.
 */
export function resolveBaseUrl(rabbitUrl) {
  if (typeof rabbitUrl !== 'string' || rabbitUrl.trim() === '') {
    throw invalid(
      'rabbitUrl is required: pass a base address such as http://127.0.0.1:8787 or https://w2m.example.com/w2m',
    );
  }
  const raw = rabbitUrl.trim();

  // Single-argument parse: this is URL *validation*, not path resolution.
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid(`rabbitUrl is not a valid URL: ${JSON.stringify(raw)}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid(
      `rabbitUrl must use http or https, got ${parsed.protocol.replace(':', '')}:// in ${JSON.stringify(raw)}`,
    );
  }

  // A literal `?`/`#` anywhere in a base address is a mistake, including the
  // degenerate bare `https://host/path?` that `parsed.search` reports as empty.
  if (parsed.search !== '' || raw.includes('?')) {
    throw invalid(
      `rabbitUrl must not contain a query string: ${JSON.stringify(raw)}; put the deployment prefix in the path instead, e.g. https://host/w2m`,
    );
  }
  if (parsed.hash !== '' || raw.includes('#')) {
    throw invalid(
      `rabbitUrl must not contain a fragment: ${JSON.stringify(raw)}; put the deployment prefix in the path instead, e.g. https://host/w2m`,
    );
  }

  // Strip every trailing slash. `new URL('http://h')` yields pathname '/', so
  // this also collapses a bare origin back to `http://h`.
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * Join a normalised base with an endpoint path by plain concatenation.
 *
 * The base is never re-parsed, so a sub-path survives; the path is never
 * re-parsed either, so `//` in the scheme survives.
 *
 * @param {string} base Result of {@link resolveBaseUrl}.
 * @param {string} path Endpoint path, with or without a leading slash.
 * @returns {string}
 */
export function joinUrl(base, path) {
  if (typeof base !== 'string' || base === '') {
    throw new TypeError('joinUrl: base must be a non-empty string (use resolveBaseUrl first)');
  }
  // Tolerate a base that still carries a trailing slash, so this helper cannot
  // produce `//v1/...` for a caller that skipped normalisation.
  const cleanBase = base.replace(/\/+$/, '');
  const suffix = path === null || path === undefined ? '' : String(path);
  if (suffix === '') return cleanBase;
  return cleanBase + (suffix.startsWith('/') ? suffix : `/${suffix}`);
}

/**
 * Convenience: normalise a base and build one endpoint URL from it.
 *
 * @param {string} rabbitUrl
 * @param {string} path
 * @returns {string}
 */
export function endpointUrl(rabbitUrl, path) {
  return joinUrl(resolveBaseUrl(rabbitUrl), path);
}
