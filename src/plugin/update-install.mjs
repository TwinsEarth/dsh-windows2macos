/**
 * Self-update installer for the W2M DSH plugin (v0.2.3).
 *
 * This is the highest-risk module in the project: it modifies the profile that
 * the *running* DSH is loaded from. Every step below is therefore ordered
 * "verify, back up, act, and be able to undo", and nothing here may ever leave
 * the profile worse off than it found it.
 *
 * ## The invariants (asserted by test/update-install.test.mjs)
 *
 *   1. **Verify before touching anything.**  The tarball's sha256 must equal
 *      `expectedSha256` (from the release's `SHA256SUMS`). On a mismatch this
 *      function writes *zero bytes* -- no staging directory, no backup.
 *   2. **Back up first.**  `package.json` and `pnpm-lock.yaml` are copied before
 *      the package manager runs. Any failure afterwards restores them
 *      byte-for-byte (and removes a lockfile that did not exist before).
 *   3. **Stage atomically.**  The tarball is copied to a temp file in the same
 *      directory, then renamed into place, so the package manager can never
 *      read half a download.
 *   4. **Use a supported entry point.**  `dsh plugin --profile <p> add <tarball>`
 *      when the DSH CLI is available, otherwise the runtime's own pnpm. Which
 *      one ran is reported as `installedVia`.
 *   5. **dryRun has no side effects at all** -- no files, no package manager.
 *   6. **Failures are never silent.**  pnpm's reason is kept (tail, 4 KiB) in
 *      `error`/`stderrTail`. Do **not** narrow this to stderr: pnpm 11.7.0 was
 *      measured reporting `[ENOENT] ...` on **stdout** with an empty stderr, so
 *      the implementation prefers stderr and falls back to stdout, recording
 *      which one it used in `detailStream`. Trusting stderr alone degrades a
 *      real cause into "exited with code 1" -- the exact silent failure this
 *      point exists to prevent.
 *   7. **A rollback is not a time machine.**  Restoring `package.json` and
 *      `pnpm-lock.yaml` returns the *manifest* to its previous state; it does
 *      not undo what pnpm already did to `node_modules/`. So the result also
 *      carries `rollbackComplete` (does the installed tree match the restored
 *      manifest again?), the installed version before and after, and a
 *      `reconciliation` command for the case where it does not. Without those,
 *      "rolled back" would be an untrue reassurance: a profile whose manifest
 *      was restored but whose tree is missing the package no longer boots DSH.
 *
 * ## What this module deliberately never does
 *
 *   * **Never deletes the profile directory** (or anything outside its own
 *     staging/backup directories). A profile that loses `cordis.yml`,
 *     `pnpm-workspace.yaml` or `.plugin-manager/` stops booting DSH entirely;
 *     that is not a recoverable state to leave a user in.
 *   * **Never edits `node_modules/` by hand.** Dependency changes go through the
 *     package manager so `pnpm-lock.yaml` stays truthful; hand-editing produces
 *     a profile that installs differently the next time pnpm runs.
 *   * **Never rewrites `dsh.profile.bundles`.** That list decides what DSH
 *     loads. Rewriting it to "help" the update would silently change the user's
 *     profile -- verified: real pnpm leaves that block untouched.
 *   * **Never restarts DSH.** Loading the new version is the caller's (and
 *     ultimately the user's) decision; a surprise restart mid-session is worse
 *     than being one version behind.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** How much of the installer's stderr is preserved when it fails. */
export const DEFAULT_STDERR_TAIL_BYTES = 4096;

/** Directory this module owns inside the profile. Nothing else may live here. */
export const STAGING_DIR_NAME = '.w2m-update';

/** Package the update replaces. */
export const DEFAULT_PACKAGE_NAME = '@twinsearth/w2m-dsh-plugin';

/** Files restored on rollback. `pnpm-workspace.yaml` is not here on purpose:
 *  pnpm reads it but does not rewrite it (verified against pnpm 11.7.0). */
export const BACKED_UP_FILES = ['package.json', 'pnpm-lock.yaml'];

/**
 * Last `maxBytes` bytes of a stream, as text.
 *
 * Truncation is on a byte boundary, so a multi-byte character straddling the
 * cut becomes U+FFFD. That is the right trade for a diagnostic tail: the reader
 * wants the end of the message, not a guarantee about its first character.
 *
 * @param {string|Buffer} text
 * @param {number} [maxBytes]
 * @returns {{text: string, truncatedBytes: number}}
 */
export function tailBytes(text, maxBytes = DEFAULT_STDERR_TAIL_BYTES) {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), truncatedBytes: 0 };
  return {
    text: buffer.subarray(buffer.length - maxBytes).toString('utf8'),
    truncatedBytes: buffer.length - maxBytes,
  };
}

/**
 * Streaming sha256 of a file, lowercase hex.
 *
 * Read in chunks rather than whole: a release tarball is small today, but the
 * check must not be the thing that runs the process out of memory.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
export function sha256File(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * Read `package/package.json` out of a packed tarball.
 *
 * Only what the update needs: the version, so the caller can report
 * `to`. A tarball we cannot parse is not fatal -- `to` becomes null -- because
 * the checksum already decided whether the bytes are the right bytes.
 *
 * @param {string} tarballPath
 * @param {{maxUncompressedBytes?: number}} [options]
 * @returns {{name: string|null, version: string|null}|null}
 */
export function readTarballManifest(tarballPath, options = {}) {
  const maxUncompressedBytes = options.maxUncompressedBytes ?? 64 * 1024 * 1024;
  let tar;
  try {
    tar = gunzipSync(readFileSync(tarballPath), { maxOutputLength: maxUncompressedBytes });
  } catch {
    return null;
  }

  /** @param {Buffer} header @param {number} start @param {number} length */
  const readString = (header, start, length) => {
    const slice = header.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
  };

  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const full = prefix === '' ? name : `${prefix}/${name}`;
    const size = Number.parseInt(readString(header, 124, 12) || '0', 8) || 0;
    const typeflag = String.fromCharCode(header[156] ?? 0x30);
    const dataStart = offset + 512;

    if (full === 'package/package.json' && (typeflag === '0' || typeflag === '\u0000')) {
      try {
        const manifest = JSON.parse(tar.subarray(dataStart, dataStart + size).toString('utf8'));
        return {
          name: typeof manifest.name === 'string' ? manifest.name : null,
          version: typeof manifest.version === 'string' ? manifest.version : null,
        };
      } catch {
        return null;
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** `%DSH_HOME%` (or `~/.dsh`). */
export function dshHome(env = process.env) {
  const explicit = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : null;
  return explicit ?? join(homedir(), '.dsh');
}

/**
 * Locate the DSH CLI (`dsh`), which is the supported entry point.
 *
 * `W2M_DSH_CLI` exists so a deployment can pin the exact host binary; PATH is
 * the fallback. Returning null is normal -- on this machine `dsh` is not on
 * PATH at all -- and simply selects the pnpm path.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|null}
 */
export function resolveDshPath(env = process.env) {
  const explicit = env.W2M_DSH_CLI && env.W2M_DSH_CLI.trim() !== '' ? env.W2M_DSH_CLI.trim() : null;
  if (explicit) return explicit;

  const isWin = process.platform === 'win32';
  const names = isWin ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  const dirs = String(env.PATH ?? '')
    .split(isWin ? ';' : ':')
    .filter((dir) => dir.trim() !== '');
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Locate the pnpm that ships with the DSH runtime.
 *
 * The runtime directory name is not hard-coded: `dsh-runtimes/*` is scanned, so
 * a second runtime (or a renamed primary) is found too. `W2M_PNPM` pins it.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|null}
 */
export function resolveRuntimePnpm(env = process.env) {
  const explicit = env.W2M_PNPM && env.W2M_PNPM.trim() !== '' ? env.W2M_PNPM.trim() : null;
  if (explicit) return existsSync(explicit) ? explicit : null;

  const runtimesDir = join(dshHome(env), 'dsh-runtimes');
  let runtimes;
  try {
    runtimes = readdirSync(runtimesDir);
  } catch {
    return null;
  }
  for (const runtime of runtimes) {
    const candidate = join(runtimesDir, runtime, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Decide which supported entry point to use, and with exactly which argv.
 *
 * Pure and exported so the choice can be asserted without running anything.
 *
 * @param {object} input
 * @param {string} input.profileDir
 * @param {string} input.profileName
 * @param {string} input.stagedTarball
 * @param {string|null} [input.dshPath]
 * @param {string|null} [input.pnpmPath]
 * @param {string} [input.nodePath]
 * @returns {{via: 'dsh'|'pnpm', argv: string[], cwd: string}|null}
 */
export function planInstall(input) {
  const { profileDir, profileName, stagedTarball } = input;
  const dshPath = input.dshPath ?? null;
  const pnpmPath = input.pnpmPath ?? null;
  const nodePath = input.nodePath ?? process.execPath;

  if (dshPath) {
    return {
      via: 'dsh',
      // `dsh plugin --profile <name> add <tarball>` is the supported surface;
      // everything below it (pnpm, the lockfile) is the host's business.
      argv: [dshPath, 'plugin', '--profile', profileName, 'add', stagedTarball],
      cwd: profileDir,
    };
  }
  if (pnpmPath) {
    return {
      via: 'pnpm',
      // pnpm.mjs needs internal Node APIs, hence --expose-internals.
      argv: [nodePath, '--expose-internals', pnpmPath, 'add', stagedTarball, '--dir', profileDir],
      cwd: profileDir,
    };
  }
  return null;
}

/**
 * The production runner: start a process with an argv array, capture its
 * streams, never involve a shell.
 *
 * @param {object} [options]
 * @param {typeof spawn} [options.spawnImpl]
 * @param {number} [options.timeoutMs]
 * @returns {(spec: {argv: string[], cwd: string}) => Promise<{code: number|null, stdout: string, stderr: string, spawnError: {code: string, message: string}|null, timedOut: boolean}>}
 */
export function createChildProcessRunner(options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const captureLimit = options.captureLimit ?? 256 * 1024;

  return (spec) =>
    new Promise((resolvePromise) => {
      let child;
      try {
        child = spawnImpl(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: spec.env ?? process.env,
        });
      } catch (error) {
        resolvePromise({
          code: null,
          stdout: '',
          stderr: '',
          spawnError: { code: error?.code ?? 'SPAWN_FAILED', message: String(error?.message ?? error) },
          timedOut: false,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              try {
                child.kill('SIGTERM');
              } catch {
                /* already gone */
              }
            }, timeoutMs)
          : null;

      const append = (current, chunk) =>
        current.length >= captureLimit ? current : (current + chunk.toString('utf8')).slice(-captureLimit);

      child.stdout?.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise({
          code: null,
          stdout,
          stderr,
          spawnError: { code: error?.code ?? 'SPAWN_FAILED', message: String(error?.message ?? error) },
          timedOut,
        });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise({ code, stdout, stderr, spawnError: null, timedOut });
      });
    });
}

/**
 * Install an update into a profile.
 *
 * @param {object} options
 * @param {string} options.tarballPath Downloaded release tarball.
 * @param {string} options.profileDir Profile to update (e.g. `<DSH_HOME>/profiles/naudl`).
 * @param {string} options.expectedSha256 Expected sha256 from `SHA256SUMS`.
 * @param {(spec: {argv: string[], cwd: string, via: string}) => Promise<object>} [options.runner]
 * @param {boolean} [options.dryRun] Report only: no writes, no package manager.
 * @param {string} [options.backupDir] Where the pre-update files are copied.
 * @param {string} [options.stagingDir] Where the tarball is staged.
 * @param {string} [options.profileName] Profile name for `dsh plugin --profile`.
 * @param {string|null} [options.dshPath] null forces the pnpm path.
 * @param {string|null} [options.pnpmPath]
 * @param {string} [options.nodePath]
 * @param {number} [options.stderrTailBytes]
 * @param {Date} [options.now] Injectable clock (deterministic backup directory).
 * @returns {Promise<object>} `{ok, from, to, installedVia, backupPath, rolledBack, error?}`
 */
export async function installUpdate(options = {}) {
  const {
    tarballPath,
    profileDir,
    expectedSha256,
    dryRun = false,
    stderrTailBytes = DEFAULT_STDERR_TAIL_BYTES,
    now = new Date(),
  } = options;

  /** Ordered account of what happened; the caller may show it verbatim. */
  const steps = [];
  /** @param {string} message */
  const step = (message) => {
    steps.push(message);
  };

  /**
   * @param {string} message
   * @param {object} [extra]
   */
  const failure = (message, extra = {}) => ({
    ok: false,
    dryRun,
    from: extra.from ?? null,
    to: extra.to ?? null,
    installedVia: extra.installedVia ?? null,
    backupPath: extra.backupPath ?? null,
    rolledBack: extra.rolledBack ?? false,
    error: message,
    stderrTail: extra.stderrTail ?? null,
    sha256: extra.sha256 ?? null,
    stagedPath: extra.stagedPath ?? null,
    argv: extra.argv ?? null,
    steps,
  });

  // ---- 0. inputs --------------------------------------------------------
  if (typeof tarballPath !== 'string' || tarballPath === '') {
    return failure('installUpdate: tarballPath is required');
  }
  if (typeof profileDir !== 'string' || profileDir === '') {
    return failure('installUpdate: profileDir is required');
  }
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSha256.trim())) {
    // No checksum, no install: this is the one gate that cannot be skipped.
    return failure(
      'installUpdate: expectedSha256 must be a 64-character hex sha256 (from the release SHA256SUMS)',
    );
  }
  const absoluteProfile = resolve(profileDir);
  if (!existsSync(absoluteProfile)) {
    return failure(`installUpdate: profile directory does not exist: ${absoluteProfile}`);
  }
  if (!existsSync(tarballPath)) {
    return failure(`installUpdate: tarball does not exist: ${tarballPath}`);
  }

  const profileName = options.profileName ?? basename(absoluteProfile);
  const stagingDir = options.stagingDir
    ? resolve(options.stagingDir)
    : join(absoluteProfile, STAGING_DIR_NAME);
  const stagedTarball = join(stagingDir, basename(tarballPath));
  const dshPath = options.dshPath !== undefined ? options.dshPath : resolveDshPath();
  const pnpmPath = options.pnpmPath !== undefined ? options.pnpmPath : resolveRuntimePnpm();
  const nodePath = options.nodePath ?? process.execPath;
  const runner = options.runner ?? createChildProcessRunner(options.runnerOptions);

  // ---- 1. verify --------------------------------------------------------
  let actualSha256;
  try {
    actualSha256 = await sha256File(tarballPath);
  } catch (error) {
    return failure(`installUpdate: could not read the tarball: ${error?.message ?? error}`);
  }
  const expected = expectedSha256.trim().toLowerCase();
  if (actualSha256 !== expected) {
    // The critical property: nothing has been written at this point, and
    // nothing will be.
    step(`sha256 mismatch: expected ${expected}, got ${actualSha256}`);
    return failure(
      `sha256 mismatch: expected ${expected} but the tarball hashes to ${actualSha256}; nothing was written`,
      { sha256: actualSha256 },
    );
  }
  step(`sha256 verified: ${actualSha256}`);

  const manifest = readTarballManifest(tarballPath);
  const to = manifest?.version ?? null;
  const packageName = manifest?.name ?? options.packageName ?? DEFAULT_PACKAGE_NAME;
  const from = readInstalledVersion(absoluteProfile, packageName);

  const plan = planInstall({
    profileDir: absoluteProfile,
    profileName,
    stagedTarball,
    dshPath,
    pnpmPath,
    nodePath,
  });

  // ---- 5. dryRun --------------------------------------------------------
  if (dryRun) {
    step('dry run: no files written, no package manager executed');
    return {
      ok: plan !== null,
      dryRun: true,
      from,
      to,
      installedVia: plan?.via ?? null,
      backupPath: null,
      rolledBack: false,
      error: plan
        ? null
        : 'installUpdate: no supported installer available (set W2M_DSH_CLI to the dsh CLI, or W2M_PNPM to the runtime pnpm)',
      stderrTail: null,
      sha256: actualSha256,
      stagedPath: stagedTarball,
      argv: plan?.argv ?? null,
      plan,
      steps,
    };
  }

  // Refuse *before* writing anything: without a supported installer there is
  // nothing to try, so creating a staging directory and a backup would be
  // clutter at best and a half-applied profile at worst.
  if (!plan) {
    step('no supported installer available; nothing was written');
    return failure(
      'installUpdate: no supported installer available (set W2M_DSH_CLI to the dsh CLI, or W2M_PNPM to the runtime pnpm)',
      { sha256: actualSha256, from, to },
    );
  }

  // ---- 3. stage atomically ---------------------------------------------
  let tempStage = null;
  try {
    mkdirSync(stagingDir, { recursive: true });
    if (resolve(tarballPath) !== resolve(stagedTarball)) {
      tempStage = `${stagedTarball}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      copyFileSync(tarballPath, tempStage);
      renameSync(tempStage, stagedTarball);
      tempStage = null;
      step(`staged ${basename(tarballPath)} into ${stagingDir}`);
    } else {
      step('tarball already staged in place');
    }
  } catch (error) {
    if (tempStage) safeRemove(tempStage);
    return failure(`installUpdate: could not stage the tarball: ${error?.message ?? error}`, {
      sha256: actualSha256,
    });
  }

  // ---- 2. back up -------------------------------------------------------
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupPath = options.backupDir
    ? resolve(options.backupDir)
    : join(stagingDir, 'backups', stamp);
  /** @type {Array<{name: string, existed: boolean, sha256: string|null}>} */
  const backups = [];
  try {
    mkdirSync(backupPath, { recursive: true });
    for (const name of BACKED_UP_FILES) {
      const source = join(absoluteProfile, name);
      if (existsSync(source)) {
        copyFileSync(source, join(backupPath, name));
        backups.push({ name, existed: true, sha256: await sha256File(source) });
      } else {
        backups.push({ name, existed: false, sha256: null });
      }
    }
    step(`backed up ${backups.filter((entry) => entry.existed).map((entry) => entry.name).join(', ') || 'nothing'} to ${backupPath}`);
  } catch (error) {
    return failure(`installUpdate: could not back up the profile: ${error?.message ?? error}`, {
      sha256: actualSha256,
      backupPath,
    });
  }

  // ---- 4. act -----------------------------------------------------------
  // Snapshot what the resolved tree looks like *before* the package manager can
  // touch it. Rollback restores the manifest and the lockfile; it cannot undo a
  // half-written `node_modules`, so this is what lets the result say whether the
  // profile is actually back in a usable state instead of assuming it.
  const installedBeforeRun = readInstalledVersion(absoluteProfile, packageName);
  let result;
  try {
    result = await runner({ argv: plan.argv, cwd: plan.cwd, via: plan.via });
  } catch (error) {
    result = {
      code: null,
      stdout: '',
      stderr: '',
      spawnError: { code: 'RUNNER_THREW', message: String(error?.message ?? error) },
      timedOut: false,
    };
  }

  const stderrTail = tailBytes(result?.stderr ?? '', stderrTailBytes);
  const stdoutTail = tailBytes(result?.stdout ?? '', stderrTailBytes);
  const spawnFailed = result?.spawnError ?? null;
  const succeeded = !spawnFailed && result?.code === 0;

  if (!succeeded) {
    // Which stream carries the explanation is not something to assume: measured
    // against pnpm 11.7.0 (via the runtime's pnpm.mjs, piped stdio, Windows),
    // resolution errors are printed to **stdout**, not stderr -- the opposite of
    // the usual convention. Keeping only stderr would have thrown away the one
    // sentence that says why the update failed, so the tail of whichever stream
    // actually said something is what reaches `error`.
    const detail =
      stderrTail.text.trim() !== ''
        ? { stream: 'stderr', tail: stderrTail }
        : stdoutTail.text.trim() !== ''
          ? { stream: 'stdout', tail: stdoutTail }
          : null;
    const reason = spawnFailed
      ? `could not run ${plan.via} (${spawnFailed.code}: ${spawnFailed.message})`
      : result?.timedOut
        ? `${plan.via} timed out`
        : `${plan.via} exited with code ${result?.code}`;
    const rolledBack = rollback(absoluteProfile, backupPath, backups, step);
    const installedAfterRollback = readInstalledVersion(absoluteProfile, packageName);
    const treeIntact = installedAfterRollback === installedBeforeRun;
    const reconciliation = treeIntact
      ? null
      : `node_modules no longer matches the restored manifest (installed version was ${
          installedBeforeRun ?? 'absent'
        }, is now ${installedAfterRollback ?? 'absent'}); reconcile it with \`${reconcileCommand({
          via: plan.via,
          profileDir: absoluteProfile,
          profileName,
          pnpmPath,
          nodePath,
        })}\``;
    step(
      `failed: ${reason}; rollback ${rolledBack ? 'restored the previous files' : 'FAILED'}${
        reconciliation ? `; ${reconciliation}` : '; resolved tree is unchanged'
      }`,
    );
    return {
      ok: false,
      dryRun: false,
      from,
      to,
      installedVia: plan.via,
      backupPath,
      rolledBack,
      /** Files are restored **and** the resolved tree still matches them. */
      rollbackComplete: rolledBack && treeIntact,
      installedVersionBefore: installedBeforeRun,
      installedVersionAfterRollback: installedAfterRollback,
      reconciliation,
      error: `${reason}${detail ? `\n--- ${plan.via} ${detail.stream} (tail) ---\n${detail.tail.text}` : ''}${
        reconciliation ? `\n${reconciliation}` : ''
      }`,
      stderrTail: stderrTail.text,
      stdoutTail: stdoutTail.text,
      detailStream: detail?.stream ?? null,
      stderrTruncatedBytes: stderrTail.truncatedBytes,
      stdoutTruncatedBytes: stdoutTail.truncatedBytes,
      sha256: actualSha256,
      stagedPath: stagedTarball,
      argv: plan.argv,
      exitCode: result?.code ?? null,
      steps,
    };
  }

  step(`${plan.via} completed: ${plan.argv.slice(0, 2).join(' ')} …`);
  // Verify the outcome instead of trusting the exit code: "pnpm said 0" and
  // "the profile now has the new version" are different statements, and only
  // the second one is what the caller asked for.
  const installedVersion = readInstalledVersion(absoluteProfile, packageName);
  step(`installed version is now ${installedVersion ?? '<not found in node_modules>'}`);
  return {
    ok: true,
    dryRun: false,
    from,
    to,
    installedVersion,
    installedVia: plan.via,
    backupPath,
    rolledBack: false,
    error: null,
    stderrTail: stderrTail.text || null,
    sha256: actualSha256,
    stagedPath: stagedTarball,
    argv: plan.argv,
    exitCode: 0,
    steps,
  };
}

/**
 * The command a human (or the caller) should run to make `node_modules` agree
 * with the restored manifest again.
 *
 * Only produced when the tree is known to disagree, and only ever *reported*:
 * running it automatically would be a second takeover of a profile that is
 * already in an uncertain state.
 *
 * @param {{via: string, profileDir: string, profileName: string, pnpmPath: string|null, nodePath: string}} input
 * @returns {string}
 */
export function reconcileCommand(input) {
  if (input.via === 'dsh') {
    return `dsh plugin --profile ${input.profileName} install`;
  }
  if (input.pnpmPath) {
    return `${input.nodePath} --expose-internals ${input.pnpmPath} install --frozen-lockfile --dir ${input.profileDir}`;
  }
  return `pnpm install --frozen-lockfile --dir ${input.profileDir}`;
}

/**
 * Restore the backed-up files, byte for byte.
 *
 * A file that did not exist before is removed again: "the lockfile pnpm just
 * created" must not survive a rolled-back update, or the next install would
 * trust a lock that describes a version we never applied.
 *
 * @param {string} profileDir
 * @param {string} backupPath
 * @param {Array<{name: string, existed: boolean}>} backups
 * @param {(message: string) => void} [step]
 * @returns {boolean} Whether every file is back to its pre-update state.
 */
export function rollback(profileDir, backupPath, backups, step = () => {}) {
  let ok = true;
  for (const entry of backups) {
    const target = join(profileDir, entry.name);
    try {
      if (entry.existed) {
        copyFileSync(join(backupPath, entry.name), target);
        step(`restored ${entry.name}`);
      } else if (existsSync(target)) {
        rmSync(target, { force: true });
        step(`removed ${entry.name} (did not exist before the update)`);
      }
    } catch (error) {
      ok = false;
      step(`could not restore ${entry.name}: ${error?.message ?? error}`);
    }
  }
  return ok;
}

/**
 * Version currently installed in the profile, or null.
 *
 * Read-only, and tolerant: a profile without `node_modules` yet is a normal
 * first-install situation, not an error.
 *
 * @param {string} profileDir
 * @param {string} packageName
 * @returns {string|null}
 */
export function readInstalledVersion(profileDir, packageName) {
  try {
    const manifestPath = join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/** @param {string} file */
function safeRemove(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}
