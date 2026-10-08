/**
 * Daily self-update: check GitHub, install a newer release, report what ran.
 *
 * This module is the policy layer. It composes `update-source.mjs` (version
 * discovery and a verified download) with `update-install.mjs` (backup, pnpm,
 * rollback) and decides *whether* to act. Keeping the policy here rather than
 * inside those modules is deliberate: `isNewer` answers "which version is
 * higher", which is a different question from "may we install it".
 *
 * ## The four things that must not go wrong
 *
 * 1. **Never install downwards, never install a prerelease.** A downgrade is
 *    worse than a missed update: it silently reverts fixes. `isNewer` is a
 *    strict-greater test, and the `prerelease` flag is honoured here because a
 *    release candidate has a higher SemVer triple than the version it precedes.
 * 2. **Never install something that failed verification.** The tarball must
 *    match the SHA256SUMS published with the release, and that hash is compared
 *    before any write.
 * 3. **Never leave a broken install.** `update-install` backs up the profile and
 *    rolls back on failure; this module treats a rolled-back attempt as a
 *    failure of the whole run and records it.
 * 4. **Never break a running Harness.** Installing changes what loads *next*
 *    start; it does not hot-swap the running process. We say so instead of
 *    implying the new code is already live.
 *
 * ## What "run the latest version" can and cannot mean
 *
 * The downloaded plugin is installed into the profile, so the next DSH start
 * uses it. Rewriting the currently-loaded module inside a live Cordis container
 * is not something a plugin may do safely, and pretending otherwise would be a
 * lie in the status output. `restartCommand` therefore only ever *records* an
 * operator-supplied command; nothing here executes a restart.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as urlModule from 'node:url';

import { createDailyScheduler, DEFAULT_DAILY_TIMES, DEFAULT_TIME_ZONE } from './schedule.mjs';
import {
  DEFAULT_REPO,
  fetchLatestRelease,
  isNewer,
  requireChecksum,
} from './update-source.mjs';
import { installUpdate } from './update-install.mjs';

/** Env var holding the installed plugin's version, set by the profile at install time. */
export const PKG_VERSION_ENV = 'W2M_PLUGIN_VERSION';

/** File inside the profile recording the last completed run, for diagnostics. */
export const STATE_FILE_NAME = 'auto-update-state.json';

/** History is bounded so a long-lived profile cannot grow without limit. */
export const DEFAULT_HISTORY_LIMIT = 50;

/** Default interval between two full checks, in days. */
export const DEFAULT_INTERVAL_DAYS = 1;

/**
 * Read the running plugin's version.
 *
 * Uses the compiled-in constant, overridable by `W2M_PLUGIN_VERSION` so tests
 * and packagers can pin it. Returns `null` when unknown -- callers must treat
 * that as "cannot decide", never as "old".
 *
 * @param {string} bundledVersion - Version from the caller's own package.json.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} The version, or null when unknown.
 */
export function resolveCurrentVersion(bundledVersion, env = process.env) {
  const fromEnv = typeof env?.[PKG_VERSION_ENV] === 'string' ? env[PKG_VERSION_ENV].trim() : '';
  if (fromEnv !== '') return fromEnv;
  return typeof bundledVersion === 'string' && bundledVersion.trim() !== '' ? bundledVersion.trim() : null;
}

/**
 * Decide whether a discovered release should be installed.
 *
 * Pure and total: every input yields a decision, and the reason is always
 * returned so a status output can explain a skip instead of looking idle.
 *
 * @param {object} input - Decision inputs.
 * @param {{ok: boolean, tag?: string, prerelease?: boolean, version?: object|null}} input.release
 * @param {string|null} input.currentVersion
 * @param {boolean} [input.allowPrerelease] - Opt-in for prerelease installs.
 * @returns {{action: 'install'|'skip', reason: string, tag?: string}} The decision.
 */
export function decideUpdate({ release, currentVersion, allowPrerelease = false }) {
  if (!release || release.ok !== true) {
    return { action: 'skip', reason: `release lookup failed: ${release?.error ?? 'no release'}` };
  }
  if (typeof release.tag !== 'string' || release.tag === '') {
    return { action: 'skip', reason: 'release has no tag' };
  }
  if (release.version === null || release.version === undefined) {
    return { action: 'skip', reason: `tag ${release.tag} is not a version we can compare` };
  }
  if (!currentVersion) {
    return { action: 'skip', reason: 'the installed version is unknown, so nothing can be called newer' };
  }
  if (release.prerelease === true && !allowPrerelease) {
    // Not the same question as "is it newer": 0.2.0-rc.1 outranks 0.1.2 by SemVer,
    // and shipping a candidate to a stable install is not what the user asked for.
    return { action: 'skip', reason: `tag ${release.tag} is a prerelease and prereleases are not installed by default` };
  }
  if (!isNewer(release.tag, currentVersion)) {
    return { action: 'skip', reason: `already on ${currentVersion} (latest is ${release.tag})` };
  }
  return { action: 'install', reason: `upgrade ${currentVersion} -> ${release.tag}`, tag: release.tag };
}

/**
 * Hash a file with SHA-256.
 *
 * @param {string} file - Path to read.
 * @returns {string} Lowercase hex digest.
 */
export function sha256OfFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Write JSON atomically: temp file in the same directory, then rename.
 *
 * @param {string} file - Destination path.
 * @param {unknown} value - JSON-serializable value.
 * @returns {void}
 */
function writeJsonAtomic(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the rename failure is the interesting one */
    }
    throw error;
  }
}

/**
 * Read persisted auto-update state, tolerating absence and corruption.
 *
 * A corrupt state file must not stop the updater: the file is a record, not a
 * source of truth, and refusing to run because a log is malformed would turn a
 * cosmetic problem into a permanent one.
 *
 * @param {string} file - State file path.
 * @returns {{history: object[], lastCheckMs: number|null, lastInstallMs: number|null, lastError: string|null}}
 */
export function loadState(file) {
  const empty = { history: [], lastCheckMs: null, lastInstallMs: null, lastError: null };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      history: Array.isArray(parsed?.history) ? parsed.history : [],
      lastCheckMs: Number.isFinite(parsed?.lastCheckMs) ? parsed.lastCheckMs : null,
      lastInstallMs: Number.isFinite(parsed?.lastInstallMs) ? parsed.lastInstallMs : null,
      lastError: typeof parsed?.lastError === 'string' ? parsed.lastError : null,
    };
  } catch (error) {
    return { ...empty, lastError: `state file unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Find the DSH profile directory that contains this plugin.
 *
 * The updater installs into the profile, so it must name it. Two facts make that reliable: the
 * plugin is loaded from `<profile>/node_modules/@twinsearth/w2m-dsh-plugin`, and the profile root is
 * the directory holding that `node_modules` plus a `package.json`. We walk up and *verify* rather
 * than slicing a fixed number of path segments, because a pnpm layout can insert a `.pnpm` segment.
 *
 * Lives here rather than inside `apply()` on purpose. As a closure it was unreachable from any test,
 * and a missing `existsSync` import in it survived a fully green suite until ESLint's `no-undef`
 * caught it. Exporting it is what makes that class of mistake visible next time.
 *
 * @param {object} input - Resolution input.
 * @param {unknown} [input.explicit] - A configured `profileDir`; used verbatim when non-empty.
 * @param {string} input.moduleUrl - `import.meta.url` of the calling module.
 * @param {(p: string) => boolean} [input.exists] - Existence probe, injectable for tests.
 * @param {number} [input.maxDepth] - Ancestor levels to search.
 * @returns {string|null} Absolute profile directory, or null when there is none.
 */
export function findProfileDir({ explicit, moduleUrl, exists = existsSync, maxDepth = 8 } = {}) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return resolve(explicit.trim());
  }
  if (typeof moduleUrl !== 'string' || moduleUrl === '') return null;

  const { fileURLToPath } = urlModule;
  let dir;
  try {
    dir = dirname(fileURLToPath(moduleUrl));
  } catch {
    return null;
  }

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (basename(dir) !== 'node_modules') continue;
    const root = dirname(dir);
    // A `node_modules` directory is not enough on its own; the profile root must look like a package.
    if (exists(join(root, 'package.json'))) return root;
    continue;
  }
  return null;
}

/**
 * Create the auto-update supervisor.
 *
 * @param {object} options - Supervisor options.
 * @param {string} options.profileDir - The DSH profile directory to install into.
 * @param {string|null} options.currentVersion - The running version.
 * @param {string} [options.repo] - `owner/name` to check.
 * @param {string[]} [options.times] - Daily slots, `HH:mm:ss`.
 * @param {string} [options.timeZone] - IANA zone for the slots.
 * @param {number} [options.catchUpMs] - How late a missed slot may still run.
 * @param {boolean} [options.enabled] - Whether the schedule runs at all.
 * @param {boolean} [options.allowPrerelease] - Opt-in for prerelease installs.
 * @param {boolean} [options.dryRun] - Verify and report, but never install.
 * @param {string|null} [options.restartCommand] - Recorded only; never executed.
 * @param {number} [options.timeoutMs] - Per-request network timeout.
 * @param {string|null} [options.token] - GitHub token; never logged.
 * @param {number} [options.historyLimit] - Maximum retained history entries.
 * @param {string|null} [options.stateDir] - Where to persist state; defaults to the profile.
 * @param {number} [options.intervalDays] - Minimum days between two installs.
 * @param {(...args: any[]) => void} [options.log] - Diagnostic sink.
 * @param {(err: Error) => void} [options.onError] - Error sink for scheduler failures.
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {Function} [options.installer] - Injected installer, for tests.
 * @param {() => number} [options.nowMs] - Clock, for tests.
 * @param {Function} [options.setTimer] / @param {Function} [options.clearTimer] - Timers, for tests.
 * @returns {object} `{start, stop, check, describe, stateFile}`.
 */
export function createAutoUpdater(options) {
  const {
    profileDir,
    currentVersion,
    repo = DEFAULT_REPO,
    times = DEFAULT_DAILY_TIMES,
    timeZone = DEFAULT_TIME_ZONE,
    catchUpMs,
    enabled = true,
    allowPrerelease = false,
    dryRun = false,
    restartCommand = null,
    timeoutMs = 30_000,
    token = null,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    stateDir = null,
    intervalDays = DEFAULT_INTERVAL_DAYS,
    log = () => {},
    onError = () => {},
    fetchImpl,
    installer = installUpdate,
    nowMs = Date.now,
    setTimer,
    clearTimer,
  } = options ?? {};

  if (typeof profileDir !== 'string' || profileDir === '') {
    // A missing profile is not an error: a plugin run straight from a clone has no profile to
    // install into, and refusing to load would take the whole tool set down over a maintenance
    // feature. The updater reports itself disabled and says why.
    const reason = 'no DSH profile directory was found, so there is nothing to install into';
    return {
      stateFile: null,
      start() {},
      stop() {},
      async check() {
        return { ok: false, outcome: 'disabled', reason };
      },
      describe() {
        return {
          enabled: false,
          disabled_reason: reason,
          dry_run: dryRun,
          allow_prerelease: allowPrerelease,
          repo,
          current_version: currentVersion ?? null,
          profile_dir: null,
          state_file: null,
          restart_required: false,
          restart_command: restartCommand,
          schedule: { time_zone: timeZone, times: [], started: false, stopped: true, next_at: null, runs: 0, failures: 0 },
          last_check: null,
          last_install: null,
          last_check_ms: null,
          last_install_ms: null,
          last_error: null,
          reconciliation_needed: null,
          history: [],
        };
      },
    };
  }

  const stateFile = join(stateDir ?? profileDir, STATE_FILE_NAME);
  let state = loadState(stateFile);
  /** Serializes runs: two checks must never install at once. */
  let inFlight = null;
  /** Set when a failed install left the tree out of step with the restored manifest. */
  let reconciliationNeeded = null;

  /** Append one run to the bounded history and persist. */
  function record(entry) {
    state = {
      ...state,
      history: [...state.history, entry].slice(-historyLimit),
      lastCheckMs: nowMs(),
      lastInstallMs: entry.installed ? nowMs() : state.lastInstallMs,
      lastError: entry.error ?? null,
    };
    try {
      writeJsonAtomic(stateFile, state);
    } catch (error) {
      // Losing the record must not fail the update that just succeeded.
      log(`warn: could not persist auto-update state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One full check-and-install cycle.
   *
   * Never throws: every failure becomes a recorded entry with a reason, because
   * a daily timer that dies on the first bad network day is worse than useless.
   *
   * @param {string} [trigger] - `schedule` or `manual`, for the record.
   * @returns {Promise<object>} A result describing what happened.
   */
  async function check(trigger = 'schedule') {
    const startedAt = nowMs();
    const base = { trigger, startedAt, startedAtIso: new Date(startedAt).toISOString() };

    try {
      const release = await fetchLatestRelease({ repo, fetchImpl, timeoutMs, token });
      const decision = decideUpdate({ release, currentVersion, allowPrerelease });

      if (decision.action === 'skip') {
        // A lookup failure is not a check that found nothing. Reporting it as
        // "skipped" would leave the status output looking healthy while the
        // updater was unreachable -- the silent failure this whole feature has
        // to avoid. Only a genuine "nothing newer" is a successful check.
        const lookupFailed = release?.ok !== true;
        const entry = {
          ...base,
          outcome: lookupFailed ? 'error' : 'skipped',
          reason: decision.reason,
          tag: release?.tag ?? null,
          ...(lookupFailed ? { error: decision.reason, code: release?.code ?? null } : {}),
        };
        record(entry);
        log(lookupFailed ? `update check failed: ${decision.reason}` : `no update: ${decision.reason}`);
        return { ...entry, ok: !lookupFailed };
      }

      // A minimum gap between installs.
      //
      // Without this the only thing preventing a repeat install is the version comparison, which
      // covers the normal case but not two real ones: a relay serving a stale `latest` while a newer
      // version is already installed, and a retry loop that installs successfully and then fails to
      // observe the new version (a test environment, or a profile whose manifest is rewritten by
      // something else). Both would reinstall at every slot. Measured against the last *successful*
      // install, so a failed attempt never delays the next try -- and it short-circuits before the
      // network work, which is the point of having an interval at all.
      if (state.lastInstallMs !== null && intervalDays > 0) {
        const elapsedDays = (nowMs() - state.lastInstallMs) / 86_400_000;
        if (elapsedDays < intervalDays) {
          const entry = {
            ...base,
            outcome: 'skipped',
            reason:
              `installed ${elapsedDays.toFixed(3)} day(s) ago and the minimum interval is ` +
              `${intervalDays} day(s), so nothing was checked`,
            tag: null,
          };
          record(entry);
          log(`no update: ${entry.reason}`);
          return { ...entry, ok: true };
        }
      }

      const tag = decision.tag;
      const previous = release.tag;

      // Read the checksum from the release's own SHA256SUMS rather than trusting
      // the tarball. Without this the download is unverified and "verify before
      // install" would be a comment rather than a property.
      const sumsRes = await (fetchImpl ?? globalThis.fetch)(release.assets.sums.url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!sumsRes?.ok) {
        throw new Error(`could not read SHA256SUMS for ${tag}: HTTP ${sumsRes?.status ?? '?'}`);
      }
      const sumsText = await sumsRes.text();
      const expectedSha256 = requireChecksum(sumsText, release.assets.tarball.name);

      // Download beside the profile so the rename into place is on one filesystem.
      const stagingDir = join(profileDir, '.w2m-update');
      mkdirSync(stagingDir, { recursive: true });
      const tarballPath = join(stagingDir, release.assets.tarball.name);
      const dl = await (await import('./update-source.mjs')).downloadVerified({
        url: release.assets.tarball.url,
        sha256: expectedSha256,
        destPath: tarballPath,
        fetchImpl,
        timeoutMs,
        token,
        expectedBytes: release.assets.tarball.size,
      });
      if (dl.ok !== true) {
        throw new Error(`download failed: ${dl.error ?? 'unknown'}`);
      }

      // Re-hash what is on disk. The download verified the stream; this verifies
      // the file, which is what the installer reads.
      const actualSha256 = sha256OfFile(tarballPath);
      if (actualSha256 !== expectedSha256) {
        throw new Error(`staged tarball hashes to ${actualSha256}, expected ${expectedSha256}`);
      }

      if (dryRun) {
        // Stop before any write. This is what makes the updater safe to leave on
        // while validating a setup.
        const entry = {
          ...base,
          outcome: 'dry-run',
          reason: `would install ${tag}`,
          tag,
          sha256: actualSha256,
        };
        record(entry);
        log(`dry run: would install ${tag}`);
        return { ...entry, ok: true };
      }

      const installed = await installer({
        tarballPath,
        profileDir,
        expectedSha256,
      });

      if (installed?.ok !== true) {
        // `rolledBack` says the manifest and lockfile were restored. `rollbackComplete` says the
        // installed tree matches that restored manifest again -- a strictly stronger claim, and the
        // only one that predicts whether DSH can still start. Both are surfaced because conflating
        // them is how "we rolled back" becomes an untrue reassurance.
        const entry = {
          ...base,
          outcome: 'failed',
          reason: `install failed: ${installed?.error ?? 'unknown'}`,
          tag,
          rolledBack: installed?.rolledBack === true,
          rollbackComplete: installed?.rollbackComplete ?? null,
          installedVersionBefore: installed?.installedVersionBefore ?? null,
          installedVersionAfterRollback: installed?.installedVersionAfterRollback ?? null,
          reconciliation: installed?.reconciliation ?? null,
          error: installed?.error ?? 'install failed',
        };
        if (entry.rollbackComplete === false) reconciliationNeeded = entry.reconciliation ?? 'the installed tree does not match the restored manifest';
        record(entry);
        log(
          `update to ${tag} failed: ${installed?.error ?? 'unknown'}` +
            (entry.rollbackComplete === false
              ? ' -- the installed tree no longer matches the restored manifest; run the reconciliation command'
              : ''),
        );
        return { ...entry, ok: false };
      }

      const entry = {
        ...base,
        outcome: 'installed',
        installed: true,
        reason: `installed ${tag}`,
        tag,
        from: currentVersion,
        to: tag,
        sha256: actualSha256,
        installedVia: installed.installedVia ?? null,
        // Recorded, never executed: replacing a running Harness is the
        // operator's decision.
        restartCommand,
        restartRequired: true,
      };
      record(entry);
      log(`installed ${tag}; restart DSH to load it`);
      void previous;
      return { ...entry, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const entry = { ...base, outcome: 'error', reason: message, error: message };
      record(entry);
      log(`update check failed: ${message}`);
      return { ...entry, ok: false };
    }
  }

  const scheduler = createDailyScheduler({
    run: async () => {
      // Serialize: a slow install must not overlap the next slot.
      if (inFlight) {
        log('a check is already running; skipping this slot');
        return;
      }
      inFlight = check('schedule').finally(() => {
        inFlight = null;
      });
      await inFlight;
    },
    times,
    timeZone,
    catchUpMs,
    onError,
    nowMs,
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
  });

  return {
    stateFile,
    /** Arm the schedule. A no-op when disabled, so callers need no branch. */
    start() {
      if (!enabled) {
        log('auto-update is disabled');
        return;
      }
      scheduler.start();
    },
    /** Release the timer; idempotent, for `ctx.effect`. */
    stop() {
      scheduler.stop();
    },
    /** Run a check now, bypassing the schedule. Never throws. */
    check,
    /** Diagnostic snapshot; contains no credential. */
    describe() {
      const s = scheduler.describe();
      return {
        enabled,
        dry_run: dryRun,
        allow_prerelease: allowPrerelease,
        repo,
        current_version: currentVersion,
        profile_dir: profileDir,
        state_file: stateFile,
        restart_required: state.history.some((h) => h.outcome === 'installed'),
        restart_command: restartCommand,
        schedule: s,
        last_check_ms: state.lastCheckMs,
        last_check: state.lastCheckMs === null ? null : new Date(state.lastCheckMs).toISOString(),
        last_install_ms: state.lastInstallMs,
        last_install: state.lastInstallMs === null ? null : new Date(state.lastInstallMs).toISOString(),
        last_error: state.lastError,
        // A failed install can leave the tree out of step with the restored manifest, and DSH may
        // then fail to start. That must be the loudest thing in this report, not a buried history
        // entry, because it is the only state here that needs a human.
        reconciliation_needed: reconciliationNeeded,
        history: state.history.slice(-5),
      };
    },
  };
}
