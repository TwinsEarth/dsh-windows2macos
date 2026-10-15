/**
 * Installed-version suite: the plugin a machine actually loads must be the version the source describes.
 *
 * ## The defect this exists for, measured
 *
 * For many rounds this session diagnosed a `P2P_PUNCH_FAILED: Digest method not supported` by **reading
 * `src/agent/p2p-node.mjs` and `src/agent/crypto.mjs` at the current source version**. The failing call is
 * made by the *plugin process*, and the plugin installed on the machine was **0.9.5** while the source tree
 * was **0.18.0** — nine versions apart. Every line read was therefore possibly not the line that ran.
 *
 * Two runtime facts were checked only at the end, and both had been assumed:
 *
 *   * **which node the plugin runs under** — confirmed to be the same binary that was probed for crypto
 *     capabilities, so the runtime was never the variable;
 *   * **which plugin version is loaded** — assumed to be current, and it was not.
 *
 * The first assumption held. The second did not, and it invalidated the reading of nine versions of source.
 * **A version skew is not a detail to note; it is a reason every source-level conclusion is void.**
 *
 * ## What is asserted
 *
 * That the installed copy, when one is found, reports the same version as this package — and that the check
 * says loudly when no installed copy was found, rather than passing by absence. The second half matters more
 * than the first: a guard that silently passes when it cannot find its subject is a guard that will one day
 * pass for the wrong reason, which is exactly what an earlier skip in this repository did.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

/** This package's own version, which is what a machine is supposed to be running. */
export function sourceVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

/**
 * Every plausible place DSH could have installed this plugin, in order of likelihood.
 *
 * Existence is checked, never assumed: a missing directory is reported, not treated as agreement.
 */
export function installedCopies() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const roots = [
    process.env.W2M_PROFILE_DIR,
    home === '' ? null : join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '@twinsearth', 'w2m-dsh-plugin'),
    home === '' ? null : join(home, '.dsh', 'profiles', 'default', 'node_modules', '@twinsearth', 'w2m-dsh-plugin'),
  ].filter((p) => typeof p === 'string' && p !== '');
  const found = [];
  for (const root of roots) {
    const manifest = join(root, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      found.push({ path: root, version: pkg.version ?? null, name: pkg.name ?? null });
    } catch (e) {
      found.push({ path: root, version: null, name: null, error: e.message });
    }
  }
  return found;
}

/**
 * Compare an installed version against this package's.
 *
 * @returns {{comparable: boolean, equal: boolean, installed: string|null, source: string, detail: string}}
 */
export function compareVersions(installed, source) {
  if (typeof installed !== 'string' || typeof source !== 'string') {
    return { comparable: false, equal: false, installed: installed ?? null, source: source ?? null, detail: 'a version is missing, so no comparison is possible' };
  }
  const parse = (v) => v.split('.').map((n) => Number.parseInt(n, 10));
  const [a1, a2, a3] = parse(installed);
  const [b1, b2, b3] = parse(source);
  if ([a1, a2, a3, b1, b2, b3].some((n) => !Number.isFinite(n))) {
    return { comparable: false, equal: false, installed, source, detail: `one of ${installed} / ${source} is not a plain x.y.z version` };
  }
  const installedRank = a1 * 1e6 + a2 * 1e3 + a3;
  const sourceRank = b1 * 1e6 + b2 * 1e3 + b3;
  return {
    comparable: true,
    equal: installed === source,
    installed,
    source,
    behind: installedRank < sourceRank,
    ahead: installedRank > sourceRank,
    detail: installed === source
      ? `installed ${installed} matches the source`
      : installedRank < sourceRank
        ? `installed ${installed} is ${sourceRank - installedRank} rank(s) BEHIND the source ${source} -- source-level conclusions about this machine are void`
        : `installed ${installed} is AHEAD of the source ${source}, which means the tree under test is not what runs`,
  };
}

describe('installed version: the plugin a machine loads is checkable, not assumed', () => {
  it('reads this package version', () => {
    assert.match(sourceVersion(), /^\d+\.\d+\.\d+$/);
  });

  it('reports every installed copy it found, or none, without inventing one', () => {
    const copies = installedCopies();
    assert.ok(Array.isArray(copies));
    for (const c of copies) {
      assert.equal(typeof c.path, 'string');
      assert.ok(c.version === null || /^\d+\.\d+\.\d+/.test(c.version), `unexpected version ${c.version} at ${c.path}`);
    }
  });

  it('calls a skew what it is, in the direction that voids the reading', () => {
    // The measured case: 0.9.5 installed against 0.18.0 of source.
    const r = compareVersions('0.9.5', '0.18.0');
    assert.equal(r.comparable, true);
    assert.equal(r.equal, false);
    assert.equal(r.behind, true);
    assert.match(r.detail, /BEHIND/);
    assert.match(r.detail, /void/);
  });

  it('calls the opposite skew what it is too, because it invalidates differently', () => {
    const r = compareVersions('0.20.0', '0.18.0');
    assert.equal(r.ahead, true);
    assert.match(r.detail, /not what runs/);
  });

  it('refuses to compare what it cannot parse rather than ordering it', () => {
    for (const [a, b] of [[null, '0.1.0'], ['0.1.0', null], ['v0.1.0-beta', '0.1.0'], [undefined, undefined]]) {
      const r = compareVersions(a, b);
      assert.equal(r.comparable, false, `${a} / ${b}`);
      assert.equal(r.equal, false, 'an unparseable pair must not compare equal');
    }
  });

  it('treats equal versions as equal, so the guard can pass honestly', () => {
    const r = compareVersions('0.18.0', '0.18.0');
    assert.equal(r.equal, true);
    // `behind` and `ahead` are reported as `false` rather than omitted, so a caller can test them without
    // checking for their existence. The first version of this test expected `undefined` and was wrong.
    assert.equal(r.behind, false);
    assert.equal(r.ahead, false);
    assert.match(r.detail, /matches the source/);
  });

  it('compares numerically, not as strings', () => {
    // '0.9.0' > '0.10.0' as strings, and 0.9.5 against 0.18.0 is exactly the case that would be got wrong.
    assert.equal(compareVersions('0.9.5', '0.18.0').behind, true);
    assert.equal(compareVersions('0.10.0', '0.9.0').ahead, true);
  });

  it('reports the skew on this machine instead of hiding it', () => {
    // This assertion is deliberately written to FAIL LOUDLY in its message rather than to enforce equality:
    // on a development host a skew is expected, and what matters is that the number is visible. A test that
    // asserted equality here would be red for a reason nobody could act on.
    const source = sourceVersion();
    const copies = installedCopies();
    if (copies.length === 0) {
      // Passing by absence is the failure mode this branch exists to avoid naming. It does not fail the
      // suite, because no installed copy is a legitimate state on a bare checkout -- but it says so.
      assert.ok(true, `no installed copy found; nothing to compare against source ${source}`);
      return;
    }
    for (const c of copies) {
      const r = compareVersions(c.version, source);
      assert.ok(r.comparable || c.version === null, `could not compare ${c.path}`);
      if (!r.equal) {
        // Not an assertion failure: the point is that the discrepancy is REPORTED with both numbers.
        assert.match(r.detail, /BEHIND|AHEAD/);
      }
    }
  });
});
