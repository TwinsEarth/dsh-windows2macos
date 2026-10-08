/**
 * Auto-update policy and orchestration tests.
 *
 * The updater runs unattended at 00:00, 03:00 and 05:00, so a wrong decision is
 * not noticed until it has already replaced the installed plugin. Every test
 * here therefore pins the *decision* and the *side effects*, not just the happy
 * path: what must never happen is a downgrade, a prerelease install, an install
 * of an unverified tarball, or a silent no-op that looks like "already current".
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_INTERVAL_DAYS,
  PKG_VERSION_ENV,
  STATE_FILE_NAME,
  createAutoUpdater,
  decideUpdate,
  loadState,
  resolveCurrentVersion,
  sha256OfFile,
} from '../src/plugin/auto-update.mjs';

/** A scratch directory per test, removed afterwards. */
const scratchRoots = [];
function scratch(name) {
  const dir = mkdtempSync(join(tmpdir(), `w2m-auto-${name}-`));
  scratchRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A release lookup result shaped like `fetchLatestRelease`'s success value. */
function release({ tag = 'v0.2.0', prerelease = false, tarballName = `plugin-${tag.replace(/^v/, '')}.tgz` } = {}) {
  return {
    ok: true,
    status: 200,
    tag,
    version: { major: 0, minor: 2, patch: 0, pre: null, raw: tag },
    prerelease,
    assets: {
      tarball: { name: tarballName, url: `https://example.test/${tarballName}`, size: 0 },
      sums: { name: 'SHA256SUMS', url: 'https://example.test/SHA256SUMS', size: 0 },
    },
    htmlUrl: 'https://example.test/release',
    publishedAt: '2026-10-07T00:00:00Z',
  };
}

/**
 * A fetch stub serving the release metadata, the checksum file and the tarball.
 *
 * @param {object} opts
 * @param {object} opts.release - Release lookup result to return.
 * @param {string} opts.tarballBody - Bytes of the tarball.
 * @param {string} [opts.sumsBody] - Checksum file contents; defaults to the matching line.
 */
function makeFetch({ release: rel, tarballBody, sumsBody }) {
  const body = Buffer.from(tarballBody, 'utf8');
  const digest = sha256(tarballBody);
  const sums = sumsBody ?? `${digest}  ${rel.assets.tarball.name}\n`;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/releases/latest')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: rel.tag,
          prerelease: rel.prerelease,
          html_url: rel.htmlUrl,
          published_at: rel.publishedAt,
          assets: [
            { name: rel.assets.tarball.name, browser_download_url: rel.assets.tarball.url, size: body.length },
            { name: 'SHA256SUMS', browser_download_url: rel.assets.sums.url, size: sums.length },
          ],
        }),
        text: async () => JSON.stringify({ tag_name: rel.tag, prerelease: rel.prerelease, assets: [] }),
      };
    }
    if (String(url).includes('SHA256SUMS')) {
      return { ok: true, status: 200, text: async () => sums };
    }
    if (String(url).includes('.tgz')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(body.length) },
        // Deliberately no arrayBuffer()/text(): a non-streaming implementation
        // would crash here rather than silently buffer.
        body: (async function* stream() {
          yield body;
        })(),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  fetchImpl.calls = calls;
  return { fetchImpl, digest };
}

describe('decideUpdate (the policy that prevents a bad install)', () => {
  it('installs a strictly newer release', () => {
    const d = decideUpdate({ release: release({ tag: 'v0.2.0' }), currentVersion: '0.1.2' });
    assert.equal(d.action, 'install');
    assert.equal(d.tag, 'v0.2.0');
    assert.match(d.reason, /0\.1\.2 -> v0\.2\.0/);
  });

  it('never installs the same version', () => {
    const d = decideUpdate({ release: release({ tag: 'v0.1.2' }), currentVersion: '0.1.2' });
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /already on 0\.1\.2/);
  });

  it('never installs an older version, and says which', () => {
    const d = decideUpdate({ release: release({ tag: 'v0.1.0' }), currentVersion: '0.1.2' });
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /already on 0\.1\.2 \(latest is v0\.1\.0\)/);
  });

  it('refuses a prerelease by default, even though SemVer ranks it higher', () => {
    // 0.2.0-rc.1 outranks 0.1.2 by SemVer, so `isNewer` alone would install it.
    // Shipping a release candidate to a stable install is a different question.
    const d = decideUpdate({
      release: release({ tag: 'v0.2.0-rc.1', prerelease: true }),
      currentVersion: '0.1.2',
    });
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /prerelease/);
  });

  it('installs a prerelease when explicitly allowed', () => {
    const d = decideUpdate({
      release: release({ tag: 'v0.2.0-rc.1', prerelease: true }),
      currentVersion: '0.1.2',
      allowPrerelease: true,
    });
    assert.equal(d.action, 'install');
  });

  it('skips when the installed version is unknown instead of guessing', () => {
    // Treating "unknown" as "old" would install on every check forever.
    for (const current of [null, undefined, '']) {
      const d = decideUpdate({ release: release({ tag: 'v0.2.0' }), currentVersion: current });
      assert.equal(d.action, 'skip', `current=${JSON.stringify(current)}`);
      assert.match(d.reason, /unknown/);
    }
  });

  it('skips when the tag is not comparable', () => {
    const d = decideUpdate({
      release: { ok: true, tag: 'nightly-2026', version: null, prerelease: false, assets: {} },
      currentVersion: '0.1.2',
    });
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /not a version we can compare/);
  });

  it('skips and reports why when the lookup failed', () => {
    const d = decideUpdate({
      release: { ok: false, code: 'RATE_LIMITED', error: 'GitHub rate limit reached' },
      currentVersion: '0.1.2',
    });
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /rate limit/i, 'the reason must carry the real cause');
  });

  it('skips a release with no tag rather than throwing', () => {
    for (const rel of [{ ok: true, version: { major: 9 } }, null, undefined, { ok: true, tag: '' }]) {
      const d = decideUpdate({ release: rel, currentVersion: '0.1.2' });
      assert.equal(d.action, 'skip');
    }
  });

  it('is total: no input combination throws', () => {
    const weird = [
      undefined, null, {}, [], 0, '', 'nope', { ok: true },
      { ok: false }, { ok: true, tag: 42, version: {} },
    ];
    for (const rel of weird) {
      for (const current of [null, '', '0.0.0', '9.9.9', 42, {}]) {
        const d = decideUpdate({ release: rel, currentVersion: current });
        assert.ok(d && (d.action === 'skip' || d.action === 'install'), 'must always decide');
        assert.equal(typeof d.reason, 'string', 'a skip must always explain itself');
      }
    }
  });
});

describe('current version resolution', () => {
  it('prefers the environment override', () => {
    assert.equal(resolveCurrentVersion('0.1.2', { [PKG_VERSION_ENV]: '0.2.3' }), '0.2.3');
  });

  it('falls back to the bundled version', () => {
    assert.equal(resolveCurrentVersion('0.1.2', {}), '0.1.2');
  });

  it('returns null when neither is usable, rather than a placeholder', () => {
    for (const bundled of [null, undefined, '', '   ']) {
      assert.equal(resolveCurrentVersion(bundled, {}), null);
    }
    assert.equal(resolveCurrentVersion('0.1.2', { [PKG_VERSION_ENV]: '  ' }), '0.1.2');
  });
});

describe('state persistence', () => {
  it('hashes a file the way the release checksum is written', () => {
    const dir = scratch('hash');
    const file = join(dir, 'x.tgz');
    writeFileSync(file, 'hello');
    assert.equal(sha256OfFile(file), sha256('hello'));
  });

  it('treats a missing state file as empty', () => {
    const s = loadState(join(scratch('missing'), STATE_FILE_NAME));
    assert.deepEqual(s.history, []);
    assert.equal(s.lastCheckMs, null);
  });

  it('survives a corrupt state file instead of refusing to run', () => {
    // A malformed log must not become a permanent outage of the updater.
    const dir = scratch('corrupt');
    const file = join(dir, STATE_FILE_NAME);
    writeFileSync(file, '{ this is not json');
    const s = loadState(file);
    assert.deepEqual(s.history, []);
    assert.match(s.lastError, /unreadable/);
  });

  it('ignores a state file whose fields have the wrong types', () => {
    const dir = scratch('types');
    const file = join(dir, STATE_FILE_NAME);
    writeFileSync(file, JSON.stringify({ history: 'not-an-array', lastCheckMs: 'soon' }));
    const s = loadState(file);
    assert.deepEqual(s.history, []);
    assert.equal(s.lastCheckMs, null);
  });
});

describe('one check cycle', () => {
  /** Build an updater with injected fetch, installer and clock. */
  function updater({ profileDir, currentVersion = '0.1.2', rel, tarballBody = 'TGZ-BYTES', installer, dryRun = false, sumsBody }) {
    const { fetchImpl, digest } = makeFetch({ release: rel, tarballBody, ...(sumsBody === undefined ? {} : { sumsBody }) });
    const calls = [];
    const logs = [];
    const u = createAutoUpdater({
      profileDir,
      currentVersion,
      repo: 'TwinsEarth/dsh-windows2macos',
      dryRun,
      times: ['00:00:00'],
      log: (m) => logs.push(m),
      fetchImpl,
      installer:
        installer ??
        (async (opts) => {
          calls.push(opts);
          return { ok: true, installedVia: 'injected', rolledBack: false };
        }),
      nowMs: () => Date.parse('2026-10-08T00:00:00Z'),
      // The scheduler is not exercised here; tests call `check` directly.
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
    });
    return { updater: u, calls, logs, fetchImpl, digest };
  }

  it('installs a newer release, verifying the published hash first', async () => {
    const profileDir = scratch('install');
    const rel = release({ tag: 'v0.2.0' });
    const { updater: u, calls, digest } = updater({ profileDir, rel });

    const result = await u.check('manual');
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'installed');
    assert.equal(result.tag, 'v0.2.0');
    assert.equal(result.from, '0.1.2');
    assert.equal(result.sha256, digest, 'the recorded hash is the verified tarball hash');
    assert.equal(result.restartRequired, true, 'the caller must know a restart is needed');

    assert.equal(calls.length, 1, 'exactly one install attempt');
    assert.equal(calls[0].expectedSha256, digest, 'the installer is given the published hash');
    const staged = calls[0].tarballPath;
    assert.ok(existsSync(staged), 'the verified tarball was staged');
    assert.equal(sha256OfFile(staged), digest);
  });

  it('records the run in a state file that survives a reload', async () => {
    const profileDir = scratch('record');
    const { updater: u } = updater({ profileDir, rel: release({ tag: 'v0.2.0' }) });
    await u.check('manual');

    const persisted = loadState(join(profileDir, STATE_FILE_NAME));
    assert.equal(persisted.history.length, 1);
    assert.equal(persisted.history[0].outcome, 'installed');
    assert.equal(persisted.history[0].trigger, 'manual');
    assert.ok(persisted.lastInstallMs !== null);
  });

  it('does nothing when the version is already current, and still records it', async () => {
    const profileDir = scratch('current');
    const { updater: u, calls } = updater({ profileDir, rel: release({ tag: 'v0.1.2' }) });
    const result = await u.check('schedule');
    assert.equal(result.outcome, 'skipped');
    assert.equal(calls.length, 0, 'no install path may run for a skip');
    assert.match(result.reason, /already on 0\.1\.2/);

    const persisted = loadState(join(profileDir, STATE_FILE_NAME));
    assert.equal(persisted.history.length, 1, 'a skip is recorded, not silently ignored');
    assert.equal(persisted.lastInstallMs, null);
  });

  it('dry-run verifies everything but writes nothing to the profile', async () => {
    const profileDir = scratch('dry');
    const before = existsSync(join(profileDir, 'package.json'));
    const { updater: u, calls } = updater({ profileDir, rel: release({ tag: 'v0.2.0' }), dryRun: true });
    const result = await u.check('manual');

    assert.equal(result.outcome, 'dry-run');
    assert.equal(result.sha256.length, 64, 'the download was still verified');
    assert.equal(calls.length, 0, 'the installer must not be called in a dry run');
    assert.equal(existsSync(join(profileDir, 'package.json')), before);
  });

  it('does not install when the checksum file is missing the tarball', async () => {
    const profileDir = scratch('nohash');
    const rel = release({ tag: 'v0.2.0' });
    const { updater: u, calls } = updater({
      profileDir,
      rel,
      sumsBody: `${'a'.repeat(64)}  some-other-file.tgz\n`,
    });
    const result = await u.check('manual');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'error');
    assert.equal(calls.length, 0, 'an unverifiable download must never reach the installer');
  });

  it('does not install when the published hash does not match the download', async () => {
    const profileDir = scratch('badhash');
    const rel = release({ tag: 'v0.2.0' });
    const { updater: u, calls } = updater({
      profileDir,
      rel,
      // A checksum for different bytes: the download must fail verification.
      sumsBody: `${'b'.repeat(64)}  ${rel.assets.tarball.name}\n`,
    });
    const result = await u.check('manual');
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0, 'a mismatched hash must never reach the installer');
    assert.match(result.reason, /sha256 mismatch/i, 'the reason must name what failed to verify');
  });

  it('reports a failed install with its rollback status, and does not claim success', async () => {
    const profileDir = scratch('failinstall');
    const { updater: u } = updater({
      profileDir,
      rel: release({ tag: 'v0.2.0' }),
      installer: async () => ({ ok: false, error: 'pnpm exited 1', rolledBack: true }),
    });
    const result = await u.check('manual');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.rolledBack, true);
    assert.match(result.reason, /pnpm exited 1/);

    const persisted = loadState(join(profileDir, STATE_FILE_NAME));
    assert.equal(persisted.lastInstallMs, null, 'a failed install is not a last install');
  });

  it('turns a thrown installer into a recorded failure, not a rejection', async () => {
    const profileDir = scratch('throw');
    const { updater: u } = updater({
      profileDir,
      rel: release({ tag: 'v0.2.0' }),
      installer: async () => {
        throw new Error('disk on fire');
      },
    });
    const result = await u.check('manual');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'error');
    assert.match(result.reason, /disk on fire/);
  });

  it('reports a network failure as a recorded error rather than looking up to date', async () => {
    const profileDir = scratch('neterr');
    const logs = [];
    const u = createAutoUpdater({
      profileDir,
      currentVersion: '0.1.2',
      repo: 'TwinsEarth/dsh-windows2macos',
      log: (m) => logs.push(m),
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      },
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
    });
    const result = await u.check('schedule');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'error');
    assert.match(result.reason, /ENOTFOUND/);

    // The distinction that matters: a failure must not be recorded as a check
    // that found nothing, or the status output would look healthy while broken.
    const d = u.describe();
    assert.equal(d.last_error !== null, true);
    assert.equal(d.history.at(-1).outcome, 'error');
  });

  it('bounds the retained history', async () => {
    const profileDir = scratch('history');
    const rel = release({ tag: 'v0.1.2' }); // always "skipped", so it never installs
    const { fetchImpl } = makeFetch({ release: rel, tarballBody: 'x' });
    const u = createAutoUpdater({
      profileDir,
      currentVersion: '0.1.2',
      historyLimit: 3,
      fetchImpl,
      log: () => {},
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
    });
    for (let i = 0; i < 6; i += 1) await u.check('schedule');
    const persisted = loadState(join(profileDir, STATE_FILE_NAME));
    assert.equal(persisted.history.length, 3, 'history stays bounded');
    assert.equal(u.describe().history.length, 3);
  });

  it('never puts a token into the recorded state or the diagnostics', async () => {
    const profileDir = scratch('token');
    const secret = 'ghp_SUPERSECRETTOKENVALUE1234567890';
    const rel = release({ tag: 'v0.2.0' });
    const { fetchImpl } = makeFetch({ release: rel, tarballBody: 'TGZ' });
    const u = createAutoUpdater({
      profileDir,
      currentVersion: '0.1.2',
      token: secret,
      fetchImpl,
      log: () => {},
      installer: async () => ({ ok: true, installedVia: 'x' }),
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
    });
    await u.check('manual');
    const text = readFileSync(join(profileDir, STATE_FILE_NAME), 'utf8');
    assert.equal(text.includes(secret), false, 'the state file must not carry the token');
    assert.equal(JSON.stringify(u.describe()).includes(secret), false, 'diagnostics must not carry the token');
  });

  it('declares the interval default it documents', () => {
    assert.equal(DEFAULT_INTERVAL_DAYS, 1);
  });
});

describe('supervisor lifecycle', () => {
  it('does not arm a timer when disabled, and says so', () => {
    const profileDir = scratch('disabled');
    const logs = [];
    const u = createAutoUpdater({
      profileDir,
      currentVersion: '0.1.2',
      enabled: false,
      log: (m) => logs.push(m),
      setTimer: () => {
        throw new Error('must not arm a timer when disabled');
      },
      clearTimer: () => {},
    });
    u.start();
    assert.deepEqual(logs, ['auto-update is disabled']);
    assert.equal(u.describe().enabled, false);
  });

  it('arms one unref\u2019d timer when enabled, and stop() releases it', () => {
    const profileDir = scratch('armed');
    const timers = [];
    const u = createAutoUpdater({
      profileDir,
      currentVersion: '0.1.2',
      times: ['00:00:00', '03:00:00', '05:00:00'],
      log: () => {},
      nowMs: () => Date.parse('2026-10-07T16:00:00Z'), // midnight Beijing
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false, unref() { this.unrefed = true; } };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        if (t) t.cleared = true;
      },
    });
    u.start();
    const live = timers.filter((t) => !t.cleared);
    assert.equal(live.length, 1);
    assert.equal(live[0].unrefed, true, 'a pending check must never hold the process open');

    const d = u.describe();
    assert.equal(d.schedule.time_zone, 'Asia/Shanghai');
    assert.deepEqual(d.schedule.times, ['00:00:00', '03:00:00', '05:00:00']);
    assert.equal(d.current_version, '0.1.2');
    assert.equal(d.enabled, true);
    assert.equal(d.restart_required, false);

    u.stop();
    assert.equal(timers.filter((t) => !t.cleared).length, 0);
    assert.doesNotThrow(() => u.stop(), 'stop must be idempotent for ctx.effect');
  });

  it('degrades to a disabled updater when there is no profile, instead of refusing to load', () => {
    // A checkout run straight from a clone has no profile to install into. Refusing to construct
    // would take the whole tool set down over a maintenance feature, so the updater reports itself
    // disabled and explains why; `update-wiring.test.mjs` proves the plugin still loads.
    for (const bad of [undefined, null, '']) {
      const u = createAutoUpdater(bad === undefined ? {} : { profileDir: bad });
      const d = u.describe();
      assert.equal(d.enabled, false, `profileDir=${JSON.stringify(bad)}`);
      assert.equal(d.profile_dir, null);
      assert.equal(d.state_file, null);
      assert.match(d.disabled_reason, /no DSH profile/i);
      // Every method must remain callable, so a caller needs no special case.
      assert.doesNotThrow(() => u.start());
      assert.doesNotThrow(() => u.stop());
    }
  });

  it('answers check() with a disabled result rather than throwing', async () => {
    const u = createAutoUpdater({});
    const result = await u.check('manual');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'disabled');
    assert.match(result.reason, /no DSH profile/i);
  });

  it('reports a scheduled install as needing a restart, without executing one', async () => {
    const profileDir = scratch('restart');
    const rel = release({ tag: 'v0.2.0' });
    const { fetchImpl } = makeFetch({ release: rel, tarballBody: 'TGZ' });
    const u = createAutoUpdater({
      profileDir,
      currentVersion: '0.1.2',
      restartCommand: 'systemctl --user restart dsh',
      fetchImpl,
      log: () => {},
      installer: async () => ({ ok: true, installedVia: 'injected' }),
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
    });
    const result = await u.check('schedule');
    assert.equal(result.outcome, 'installed');
    assert.equal(result.restartRequired, true);

    const d = u.describe();
    assert.equal(d.restart_required, true);
    // The command is surfaced for a human to run; nothing here executes it.
    assert.equal(d.restart_command, 'systemctl --user restart dsh');
  });
});
