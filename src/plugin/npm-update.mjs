/**
 * v1.6.8 — npm update check for the plugin panel's "更新" button.
 *
 * The button's first half is this module: ask the npm registry for `latest`, compare it against the
 * version installed in the profile, and report the result. Nothing here writes or installs — the
 * install half reuses the existing verified updater (`auto-update.mjs` → `update-install.mjs`),
 * which already downloads a tarball, verifies its SHA-256 against the release's SHA256SUMS, swaps the
 * package in the profile, and takes a backup. Keeping the check pure is what makes "NPM 对比" testable
 * without a network or a profile.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareVersions } from './update-source.mjs';

/** The package this plugin is. */
export const PLUGIN_PACKAGE_NAME = '@twinsearth/w2m-dsh-plugin';
/** npm mirrors are fine here: the answer is only "which version is latest", and the tarball is verified separately. */
export const DEFAULT_NPM_LATEST_URL = `https://registry.npmmirror.com/${encodeURIComponent(PLUGIN_PACKAGE_NAME)}/latest`;
export const DEFAULT_NPM_LATEST_FALLBACK_URL = `https://registry.npmjs.org/${encodeURIComponent(PLUGIN_PACKAGE_NAME)}/latest`;
export const NPM_CHECK_TIMEOUT_MS = 15_000;

/**
 * Normalise the npm `latest` document.
 *
 * @param {object} doc
 * @returns {{ok: true, name: string, version: string, tarball: string|null}|{ok: false, error: string}}
 */
export function parseNpmLatest(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'the npm latest document is not a JSON object' };
  }
  const version = typeof doc.version === 'string' ? doc.version.trim() : '';
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return { ok: false, error: `the npm latest document carries no usable version (got ${JSON.stringify(doc.version ?? null)})` };
  }
  const tarball = typeof doc.dist?.tarball === 'string' && doc.dist.tarball !== '' ? doc.dist.tarball : null;
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : PLUGIN_PACKAGE_NAME;
  return { ok: true, name, version, tarball };
}

/**
 * Compare the installed version with npm latest.
 *
 * Update availability is `latest > installed`; equal or older is not an update (a profile can hold a
 * beta/newer local build, and downgrading it from a button would be a surprise, not a service).
 *
 * @param {{latest: {ok: boolean, version?: string, error?: string, tarball?: string|null}, currentVersion: string|null}} input
 * @returns {{ok: boolean, current: string|null, latest: string|null, update_available: boolean, tarball: string|null, error?: string}}
 */
export function decideNpmUpdate({ latest, currentVersion }) {
  const current = typeof currentVersion === 'string' && currentVersion !== '' ? currentVersion : null;
  if (latest?.ok !== true) {
    return { ok: false, current, latest: null, update_available: false, tarball: null, error: latest?.error ?? 'npm latest could not be read' };
  }
  const available = current !== null && compareVersions(latest.version, current) > 0;
  return { ok: true, current, latest: latest.version, update_available: available, tarball: latest.tarball ?? null };
}

/**
 * Ask npm for `latest` and decide. Never throws: a network failure is a value with `error`.
 *
 * @param {{currentVersion: string|null, fetchImpl?: Function, url?: string, timeoutMs?: number}} input
 */
export async function checkNpmUpdate(input) {
  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  const url = input?.url ?? DEFAULT_NPM_LATEST_URL;
  const urls = input?.url !== undefined ? [url] : [url, DEFAULT_NPM_LATEST_FALLBACK_URL];
  const timeoutMs = Number.isInteger(input?.timeoutMs) ? input.timeoutMs : NPM_CHECK_TIMEOUT_MS;
  let last = { ok: false, error: 'npm latest could not be read' };
  for (const candidate of urls) {
    try {
      const response = await fetchImpl(candidate, {
        headers: { accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (response?.ok !== true) { last = { ok: false, error: `npm registry answered HTTP ${response?.status ?? '?'}` }; continue; }
      const doc = await response.json();
      const parsed = parseNpmLatest(doc);
      if (parsed.ok === true) return decideNpmUpdate({ latest: parsed, currentVersion: input?.currentVersion ?? null });
      last = parsed;
    } catch (error) {
      last = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return decideNpmUpdate({ latest: last, currentVersion: input?.currentVersion ?? null });
}



/** Registry package documents to try, in order (mirror first, then npmjs). */
export const NPM_PACKAGE_DOC_URLS = [
  `https://registry.npmmirror.com/${encodeURIComponent(PLUGIN_PACKAGE_NAME)}`,
  `https://registry.npmjs.org/${encodeURIComponent(PLUGIN_PACKAGE_NAME)}`,
];

/**
 * Download an exact npm version and verify it against the registry's own integrity field before it
 * can be installed. This is the fallback for "immediately update failed: fetch failed": GitHub
 * release downloads are blocked on some networks while the npm registry is reachable.
 */
export async function fetchNpmTarball(input) {
  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  const version = typeof input?.version === 'string' ? input.version.trim() : '';
  if (version === '') return { ok: false, error: 'version is required' };
  const destDir = input?.destDir;
  if (typeof destDir !== 'string' || destDir === '') return { ok: false, error: 'destDir is required' };
  const timeoutMs = Number.isInteger(input?.timeoutMs) ? input.timeoutMs : NPM_CHECK_TIMEOUT_MS;
  const urls = Array.isArray(input?.urls) ? input.urls : NPM_PACKAGE_DOC_URLS;
  const signalOf = () => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
  let meta = null;
  let lastError = 'npm package document could not be read';
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: signalOf() });
      if (response?.ok !== true) { lastError = `npm registry answered HTTP ${response?.status ?? '?'}`; continue; }
      const doc = await response.json();
      const candidate = doc?.versions?.[version];
      if (candidate?.dist?.tarball === undefined) { lastError = `npm has no version ${version} with a tarball`; continue; }
      meta = candidate;
      break;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
  }
  if (meta === null) return { ok: false, error: lastError };
  try {
    const response = await fetchImpl(meta.dist.tarball, { signal: signalOf() });
    if (response?.ok !== true) return { ok: false, error: `npm tarball answered HTTP ${response?.status ?? '?'}` };
    const bytes = Buffer.from(await response.arrayBuffer());
    const integrity = typeof meta.dist.integrity === 'string' ? meta.dist.integrity : null;
    if (integrity !== null && /^sha512-/.test(integrity)) {
      const actual = createHash('sha512').update(bytes).digest('base64');
      if (actual !== integrity.slice('sha512-'.length)) return { ok: false, error: 'NPM_INTEGRITY_MISMATCH' };
    } else if (typeof meta.dist.shasum === 'string') {
      const actual = createHash('sha1').update(bytes).digest('hex');
      if (actual !== meta.dist.shasum) return { ok: false, error: 'NPM_SHASUM_MISMATCH' };
    } else {
      return { ok: false, error: 'NPM_NO_INTEGRITY' };
    }
    mkdirSync(destDir, { recursive: true });
    const path = join(destDir, `w2m-dsh-plugin-${version}.tgz`);
    writeFileSync(path, bytes);
    return { ok: true, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version, tarball: meta.dist.tarball, integrityVerified: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
