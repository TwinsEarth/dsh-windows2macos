/**
 * The test that v0.5.4 needed: **the packed artifact, loaded by the real Loader**.
 *
 * # The failure this exists for
 *
 * v0.5.4 added the composer's target control — a host half in `src/plugin/fleet-target.mjs` and a
 * browser half in `lib/client.js` — and installed cleanly, packed cleanly, passed every test in this
 * repository, and then took the plugin out of the running Harness entirely: the `include:w2m` entry
 * ended `fiberPhase: "failed"`, all eight `w2m_*` tools answered `unknown tool`, and the client half
 * never appeared in the composer. The shipped `scripts/verify-installed.mjs` reported
 * **"PASS: 8 tools registered"** on that very tarball, because it imports `lib/tools.js` directly and
 * calls `apply()` against a plain-object stand-in — which is precisely the environment where these
 * defects cannot appear.
 *
 * Three separate defects rode along with that one feature, and only the first is fatal on its own:
 *
 *   1. **The entry died.** `registerTargetRoutes` read the optional `connection` service as
 *      `ctx.connection`, and inside a real fiber a property read of a name the plugin did not declare
 *      in its `inject` list *throws* — `cannot get property "connection" without inject` — whether or
 *      not any plugin provides that service. A plain object returns `undefined`; a Cordis context
 *      throws, so every fake-`ctx` test in this repository was blind to it by construction.
 *   2. **The browser half was never composed.** The bundle patch named the `/tools` subpath, and
 *      `@deepseek-ai/dsh-client-modules` identifies a client package by the specifier its Loader row
 *      carries (`exactPackageSpecifier`), so a subpath resolves to no manifest: the `dsh.client`
 *      declaration was never read and no boot-graph row was composed. The host would have looked
 *      perfectly healthy while the control silently never arrived.
 *   3. **The route could never register.** The route path was `/w2m/target`, but the Connection
 *      service mounts its exact-fetch-route registry under the `/api` channel and refuses any path
 *      that does not start with `/api/`. The refusal happened inside the injected callback, which
 *      failed a *child* fiber — invisible in the entry's state and in the eight tools.
 *
 * # What this file does about that
 *
 * It packs the current tree with the repository's own packer, installs the tarball into a throwaway
 * profile in a throwaway `DSH_HOME` through the installation's own `dsh plugin add` path, gives that
 * profile the desktop profile's bundle list (real web app included), and boots it with `runProfile` —
 * the same function `dsh --profile <name>` runs, over the same Loader, patch stack and entry
 * resolution. `test/helpers/dsh-loader-driver.mjs` is the process that does the booting, and it runs
 * under the Harness's own runtime because the Loader lives inside `resources/app.asar`, which a plain
 * `node` cannot read.
 *
 * Each assertion then measures one of the defects, rather than inferring it:
 *
 *   1. the `include:w2m` entry ends **active**, with no error recorded on its fiber;
 *   2. all **eleven** `w2m_*` tools are registered in the live `tools` service;
 *   3. the **real** `clientModules` service the web app loads composes a boot-graph row for this
 *      package from the shipped `lib/client.js`;
 *   4. the plugin's own `w2m_status` reports `target_selection.attached: true` — the route pair really
 *      is registered on the live `connection.fetch` registry, which is the host-side half of "the
 *      control works";
 *   5. **every fiber in the process is swept for a failure** — not just the entry this file already
 *      knows about. A failure that lands on a *child* fiber leaves its entry `active`, and cordis
 *      settles `loader.await()` with `Promise.allSettled`, so nothing else in this file can see it.
 *      This is defect 3's own shape, and the sweep is the assertion that generalises the other four;
 *   6. **the client entry activates** — the half this file was missing. Points 3 and 4 can both pass
 *      while the page cannot boot at all, and that is exactly what v0.5.5 shipped: the row was
 *      composed from the right bundle, the host answered every question about it, and the bundle's
 *      `apply` threw the moment the shell tried to activate it, which fails the entry and makes the
 *      shell refuse the page (`web boot: 1 entry did not activate`). The activation is measured
 *      twice: through the real client module system and Cordis loader with no browser
 *      (`test/helpers/dsh-client-activation.mjs`), and — when a Chromium-based browser is installed —
 *      in a real headless page running the profile's own Web app
 *      (`test/helpers/dsh-page-boot.mjs`), where `arrived` means this package's stylesheet is in the
 *      document, which only a completed `apply` can put there.
 *
 * Points 3 and 4 are composition and registration; point 6 is activation, and the browser half of it
 * is still not a *click*: nothing here opens the composer menu or changes a target. What this file
 * rules out is the whole host-side half of that failure — a dead entry, a missing declaration, a
 * route that cannot attach — plus the client half that can stop the app from starting at all.
 *
 * # Running it somewhere else
 *
 * The installation is found from `W2M_DSH_RUNTIME` (the runtime executable) or `W2M_DSH_ROOT` (the
 * directory holding `resources/app.asar`), then from `DSH_DESKTOP_NODE_EXECUTABLE` or the current
 * executable when the suite is itself started by the Harness, and finally by walking up from this
 * repository looking for `resources/app.asar`. When no installation is found the tests **skip** and
 * say so: this file is about one host's loader, and pretending to test it without that host would be
 * the same mistake in a new place. The browser half skips separately, and says which browsers it
 * looked for; `W2M_DSH_BROWSER=<path>` names one, `W2M_DSH_BROWSER=none` turns that half off.
 *
 * `W2M_TEST_TARBALL=<path.tgz>` installs an existing tarball instead of packing the tree, which is how
 * the regression was proved in both directions: the same file fails on the v0.5.4 tarball and passes
 * on the fixed tree. `W2M_ROUTE_DEFECT=1` restores v0.5.4's route inside the *installed* copy, which
 * is the failing direction of the failed-fiber sweep — a child fiber dies while its entry stays
 * active. `W2M_DSH_BROWSER=<path>` names the browser the page half uses; `W2M_DSH_BROWSER=none` turns
 * that half off and makes it report a skip.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DRIVER = path.join(HERE, 'helpers', 'dsh-loader-driver.mjs');

/** The marker `dsh-loader-driver.mjs` prefixes its JSON report with. */
const REPORT_PREFIX = 'W2M-LOADER-REPORT:';

/** The entry the bundle patch inserts, and the module it must name (defect 2). */
const ENTRY_ID = 'w2m';
const ENTRY_MODULE = '@twinsearth/w2m-dsh-plugin';

/** The package whose browser half declares `dsh.client`. */
const CLIENT_PACKAGE = '@twinsearth/w2m-dsh-plugin';

/** The route the host registers and the page fetches (defect 3, `/api` channel included). */
const TARGET_ROUTE_PATH = '/api/w2m/target';

/**
 * The twelve tools the plugin registers; the exact set, because "some tools" is not the contract.
 *
 * Sorted, so a **missing** name and a **renamed** name fail differently in the diff. The list had drifted: it held
 * nine while the plugin registered eleven, and the compatibility gate (which mounts the packed artifact in a real
 * profile and runs the real Loader) failed on
 *
 *     registers all eight w2m_* tools
 *
 * -- a name that was already wrong about its own count.
 */
const EXPECTED_TOOLS = [
  'w2m_approvals',
  'w2m_cancel', 'w2m_chat',
  'w2m_intent',
  'w2m_joint_plan', 'w2m_joint_status', 'w2m_council',
  'w2m_tasks',
  'w2m_devices',
  'w2m_history',
  'w2m_memory',
  'w2m_reduce',
  'w2m_report',
  'w2m_run',
  'w2m_stats',
  'w2m_status',
  'w2m_update',
  'w2m_wait',
];

/** Fiber state 2 is cordis for "active"; 3 is "failed". */
const ACTIVE = 2;

/** A profile name of our own: the throwaway `DSH_HOME` means it can never reach a real one. */
const PROFILE = 'w2m-loader-verify';

/** How long each external step may take before the test calls it a failure. */
const INSTALL_TIMEOUT_MS = 180_000;
const BOOT_TIMEOUT_MS = 180_000;

/**
 * The overlay the driver applies on top of the profile's own patch layer.
 *
 * `w2m_status` probes the relay it is configured with, and the shipped config points at the shared
 * server; a loopback port that refuses instantly keeps that call off the network, and
 * `p2pMode: relay` keeps it from binding a UDP socket. Nothing about the loader, the entry, the
 * client half, the client activation or the route registration depends on either value — which is why
 * this overlay cannot make a broken build look healthy. `config` is replaced wholesale, so every key
 * is carried.
 *
 * A profile patch layer *targets* entries; it cannot insert a new row (measured: an unknown id is
 * reported as `patch: entry "…" not found` and ignored). That is why the failing direction for the
 * failed-fiber sweep below is injected into the installed copy instead — see {@link ROUTE_DEFECT_ENV}.
 */
const OVERLAY = `# Written by test/loader-entry.test.mjs: keep the plugin's status call off the network.
- id: w2m
  config:
    rabbitUrl: 'http://127.0.0.1:1'
    operatorToken: ''
    autoStartAgent: false
    machineName: ''
    allowedCommands: []
    p2pMode: relay
    stunServers: []
`;

/**
 * The switch that restores v0.5.4's route defect in the **installed** copy, for the failing direction
 * of the failed-fiber sweep.
 *
 * v0.5.4 registered `/w2m/target`, and the Connection service mounts its exact-fetch-route registry
 * under `/api` and refuses any other prefix. The refusal happens inside the injected callback, so it
 * fails a *child* fiber: the `include:w2m` entry stays `active`, all eight tools still register, and
 * every per-entry assertion in this file passes. Only the registry-wide sweep can see it, which is
 * why the sweep exists — and this switch is how that claim is checked rather than asserted:
 *
 *   W2M_ROUTE_DEFECT=1 node --test test/loader-entry.test.mjs
 *
 * With it set, `sweeps every fiber` must fail naming the child's error, while `leaves the entry
 * active` and `registers every w2m_* tool the package declares` still pass. Nothing here depends on the switch: it
 * edits the throwaway profile's installed copy, never the tree under test.
 */
const ROUTE_DEFECT_ENV = 'W2M_ROUTE_DEFECT';

/**
 * v3.5.6/B1: the mixed-availability probe.
 *
 * The throwaway profile ships every UI row `disabled: true`, so a plain boot has no UI row to show. Setting
 * this makes the test enable **the archive row and nothing else** in the installed profile's copy of the
 * bundle patch (never in the tree under test), which is the one state that proves both halves of B1 at once:
 * an enabled row registers, a disabled row does not, and the archive tab appears only because its row
 * answered. Since v3.5.7 a 404 is authoritative, so this probe owns the archive row exclusively and cannot
 * be combined with the two row-state probes below.
 */
const SURFACES_PROBE_ENV = 'W2M_SURFACES_PROBE';

/**
 * v3.5.7: opt-in real-page probes that need a UI row enabled.
 *
 * The same rule as {@link SURFACES_PROBE_ENV}: the shipped patch leaves these rows disabled, and a disabled
 * row now answers 404 and mounts nothing, so each probe enables the rows it asserts on in the *installed*
 * copy of the patch before the boot. `DECISION_PROBE_ENV` drives the decision inbox and also reads the GPW
 * panel and the backup seats, so it enables the GPW and backup rows; `BACKUP_PROBE_ENV` drives the backup
 * panel and its unlock dialog, so it enables the backup row only (the archive row stays off, and the probe
 * asserts its tab is absent).
 */
const DECISION_PROBE_ENV = 'W2M_DECISION_PROBE';
const BACKUP_PROBE_ENV = 'W2M_BACKUP_PROBE';

/** The web app's own flags: an OS-chosen port, and no browser launch from a test. */
const APP_ARGS = ['--port', '0', '--no-open'];

/** The desktop profile's bundle list: the composition this regression happened in. */
const DESKTOP_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', CLIENT_PACKAGE];

/**
 * One child process, both streams captured, bounded by a deadline.
 *
 * @param {string} command - Executable to run.
 * @param {string[]} args - Its arguments.
 * @param {{env?: object, cwd?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? BOOT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Candidate runtime executables inside an installation root, in probe order. */
const RUNTIME_CANDIDATES = [
  'DeepSeek Harness.exe',
  // The macOS bundle: the root that holds `resources/app.asar` is `…app/Contents`, and the executable sits one
  // directory below it. Without this entry the five-machine run skipped every real-Loader test on a Mac.
  path.join('MacOS', 'DeepSeek Harness'),
  path.join('DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness'),
  'deepseek-harness',
];

/**
 * Whether a path looks like the Harness runtime rather than a plain `node`.
 *
 * @param {string} executable - Candidate executable path.
 * @returns {boolean}
 */
function looksLikeHarness(executable) {
  return /harness/i.test(path.basename(executable));
}

/**
 * Locate the Harness installation whose Loader this test must drive.
 *
 * @returns {{root: string, runtime: string}|{root: null, runtime: null, attempts: string[]}}
 */
function findInstallation() {
  const attempts = [];
  const roots = [];
  const runtimes = [];
  const installMarker = (root) => path.join(root, 'resources', 'app.asar');

  if (typeof process.env.W2M_DSH_ROOT === 'string' && process.env.W2M_DSH_ROOT !== '') {
    roots.push(path.resolve(process.env.W2M_DSH_ROOT));
  }
  for (const candidate of [process.env.W2M_DSH_RUNTIME, process.env.DSH_DESKTOP_NODE_EXECUTABLE, process.execPath]) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    if (!looksLikeHarness(candidate) && candidate !== process.env.W2M_DSH_RUNTIME) continue;
    runtimes.push(path.resolve(candidate));
    roots.push(path.dirname(path.resolve(candidate)));
  }
  // The workspace shortcut: a checkout developed inside an installation.
  let dir = REPO;
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(installMarker(dir))) {
      roots.push(dir);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const root of roots) {
    if (!fs.existsSync(installMarker(root))) {
      attempts.push(`${root}: no resources/app.asar`);
      continue;
    }
    const fromEnv = runtimes.find((runtime) => path.dirname(runtime) === root);
    const runtime =
      fromEnv ??
      RUNTIME_CANDIDATES.map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate)) ??
      // A runtime named through the environment may sit below the root that holds the archive (the macOS bundle
      // keeps it in `Contents/MacOS`); it is accepted only when that root really is one of its ancestors.
      runtimes.find((candidate) => fs.existsSync(candidate) && candidate.startsWith(root + path.sep));
    if (runtime === undefined) {
      attempts.push(`${root}: no runtime executable among ${RUNTIME_CANDIDATES.join(', ')}`);
      continue;
    }
    return { root, runtime };
  }
  return { root: null, runtime: null, attempts };
}

/** Where the installation's `dsh plugin …` entry point lives inside the archive. */
function cliPath(root) {
  return path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
}

/**
 * Pack the current tree with the repository's own packer, or take the tarball the caller named.
 *
 * @param {string} outDir - Directory for a freshly packed tarball.
 * @returns {Promise<string>} Absolute path of the tarball to install.
 */
async function resolveTarball(outDir) {
  const explicit = process.env.W2M_TEST_TARBALL;
  if (typeof explicit === 'string' && explicit !== '') {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error(`W2M_TEST_TARBALL does not exist: ${resolved}`);
    return resolved;
  }
  const version = JSON.parse(await fsp.readFile(path.join(REPO, 'package.json'), 'utf8')).version;
  const packed = await run(process.execPath, [path.join(REPO, 'scripts', 'pack.mjs'), '--out', outDir], {
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  assert.equal(packed.code, 0, `scripts/pack.mjs failed:\n${packed.stdout}\n${packed.stderr}`);
  return path.join(outDir, `twinsearth-w2m-dsh-plugin-${version}.tgz`);
}

/**
 * Pull the driver's report out of its stdout.
 *
 * @param {string} stdout - Everything the driver wrote to stdout.
 * @returns {object|null}
 */
function parseReport(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(REPORT_PREFIX)) continue;
    try {
      return JSON.parse(line.slice(REPORT_PREFIX.length));
    } catch {
      return null;
    }
  }
  return null;
}

describe('loader entry: the packed artifact, mounted by the real Loader', () => {
  /** @type {{root: string, runtime: string}|null} */
  let installation = null;
  /** @type {string|null} */
  let skipReason = null;
  /** @type {object|null} */
  let report = null;
  /** @type {string} */
  let driverStderr = '';
  /** @type {object|null} */
  let entry = null;
  /**
   * What the toggled-rows regression needs to boot the same throwaway profile a second time.
   * @type {{installation: {root: string, runtime: string}, home: string, profileDir: string, overlayPath: string, env: object, cwd: string}|null}
   */
  let bootContext = null;
  /** @type {string[]} */
  const temporary = [];

  before(async () => {
    const found = findInstallation();
    if (found.root === null) {
      skipReason =
        'no DeepSeek Harness installation found to drive the real Loader; set W2M_DSH_RUNTIME to its ' +
        `runtime executable or W2M_DSH_ROOT to the directory holding resources/app.asar (tried: ${found.attempts.join('; ') || 'nothing'})`;
      return;
    }
    installation = { root: found.root, runtime: found.runtime };

    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'w2m-loader-'));
    temporary.push(workDir);
    const home = path.join(workDir, 'home');
    const profileDir = path.join(home, 'profiles', PROFILE);
    await fsp.mkdir(path.join(home, 'profiles'), { recursive: true });

    const tarball = await resolveTarball(path.join(workDir, 'packed'));
    const env = { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' };

    const installed = await run(
      installation.runtime,
      ['--expose-internals', cliPath(installation.root), 'plugin', '--profile', PROFILE, 'add', tarball],
      { env, cwd: home, timeoutMs: INSTALL_TIMEOUT_MS },
    );
    assert.equal(
      installed.code,
      0,
      `the installation refused the tarball (${tarball}):\n${installed.stdout}\n${installed.stderr}`,
    );

    // The installer mounts the package into a base-only profile; this test wants the composition the
    // regression happened in, so it declares the desktop profile's own bundle list. The bundles
    // themselves come from the installation, not from the profile's node_modules.
    const manifestPath = path.join(profileDir, 'package.json');
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    assert.ok(
      (manifest.dsh?.profile?.bundles ?? []).includes(CLIENT_PACKAGE),
      'the installer must mount the package as a profile bundle, or nothing else in this file means anything',
    );
    manifest.dsh.profile.bundles = DESKTOP_BUNDLES;
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const overlayPath = path.join(workDir, 'overlay.yml');
    await fsp.writeFile(overlayPath, OVERLAY, 'utf8');
    bootContext = { installation, home, profileDir, overlayPath, env, cwd: workDir };

    if (process.env[ROUTE_DEFECT_ENV] === '1') {
      // Restore v0.5.4's route in the installed copy only: the child fiber that registers it then
      // fails on `/api`'s fence, while the entry itself stays active.
      const installedRoute = path.join(
        profileDir,
        'node_modules',
        '@twinsearth',
        'w2m-dsh-plugin',
        'src',
        'plugin',
        'fleet-target.mjs',
      );
      const source = await fsp.readFile(installedRoute, 'utf8');
      const patched = source.replace("'/api/w2m/target'", "'/w2m/target'");
      assert.notEqual(patched, source, `${ROUTE_DEFECT_ENV}=1 could not find the route to restore in ${installedRoute}`);
      await fsp.writeFile(installedRoute, patched, 'utf8');
    }

    // v3.5.7: each opt-in page probe asserts on a UI row that the shipped patch leaves `disabled: true`, and a
    // disabled row answers 404 and mounts nothing -- by design. So the probe enables the rows it drives in the
    // *installed copy* of the bundle patch (never in the tree under test). `W2M_SURFACES_PROBE` is the mixed
    // state (archive on, everything else off) and is therefore exclusive.
    assert.equal(
      process.env[SURFACES_PROBE_ENV] === '1'
        && (process.env[DECISION_PROBE_ENV] === '1' || process.env[BACKUP_PROBE_ENV] === '1'),
      false,
      `${SURFACES_PROBE_ENV}=1 enables the archive row and nothing else; run the decision/backup probes without it.`,
    );
    const enableRows = new Set();
    if (process.env[SURFACES_PROBE_ENV] === '1') enableRows.add('dsh-backup-plugin');
    if (process.env[DECISION_PROBE_ENV] === '1') {
      enableRows.add('dsh-gpw');
      enableRows.add('dsh-backup');
    }
    if (process.env[BACKUP_PROBE_ENV] === '1') enableRows.add('dsh-backup');
    if (enableRows.size > 0) {
      const patchPath = path.join(profileDir, 'node_modules', '@twinsearth', 'w2m-dsh-plugin', 'cordis.patch.yml');
      let patchSource = await fsp.readFile(patchPath, 'utf8');
      for (const row of enableRows) {
        const pattern = new RegExp(`(- id: ${row}\\n[ \\t]+name: '[^']+'\\n[ \\t]+disabled: )true`, 'u');
        const patched = patchSource.replace(pattern, (match, prefix) => `${prefix}false`);
        assert.notEqual(patched, patchSource, `could not enable the ${row} row in ${patchPath}`);
        patchSource = patched;
      }
      if (enableRows.has('dsh-backup')) {
        // The shipped backup row points at the operator's real repository (`D:\DeepSeekHarness\BackUP`). A probe
        // that clicks 「运行」/「归档」 must never write there, so its installed copy is pointed at a repository
        // inside this test's throwaway home. Every other key of the row is left exactly as shipped.
        const repoDir = path.join(workDir, 'backup-repo').replace(/\\/gu, '/');
        const redirected = patchSource.replace(
          /(- id: dsh-backup\n(?:[ \t]+[^\n]*\n)*?[ \t]+backupDir: )'[^']*'/u,
          (match, prefix) => `${prefix}'${repoDir}'`,
        );
        assert.notEqual(redirected, patchSource, `could not point the dsh-backup row at ${repoDir}`);
        patchSource = redirected;
      }
      await fsp.writeFile(patchPath, patchSource, 'utf8');
    }

    const booted = await run(
      installation.runtime,
      [
        '--expose-internals',
        DRIVER,
        installation.root,
        home,
        PROFILE,
        JSON.stringify(APP_ARGS),
        overlayPath,
      ],
      { env, cwd: workDir, timeoutMs: BOOT_TIMEOUT_MS },
    );
    driverStderr = booted.stderr;
    report = parseReport(booted.stdout);
    assert.ok(
      report !== null,
      `the loader driver produced no report (exit ${booted.code}, timed out: ${booted.timedOut}):\n${booted.stdout}\n${booted.stderr}`,
    );
    assert.equal(
      report.ok,
      true,
      `the profile failed to boot through the real Loader: ${report.error}\n${report.diagnostics?.join('\n') ?? ''}`,
    );
    entry = report.entries.find((row) => row.id === ENTRY_ID) ?? null;
  });

  after(async () => {
    for (const dir of temporary) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('mounts the entry the bundle patch names, by package and not by subpath', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    assert.ok(entry !== null, `no "${ENTRY_ID}" entry in the composed tree: ${JSON.stringify(report.entries)}`);
    // Defect 2: a `/tools` row resolves to no package manifest, so the client half is never composed.
    assert.equal(entry.module, ENTRY_MODULE);
    assert.equal(entry.disabled, false);
  });

  it('leaves the entry active, with no error on its fiber', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    // Defect 1 failed here: state 3, "cannot get property \"connection\" without inject".
    assert.equal(
      entry.state,
      ACTIVE,
      `the entry is ${entry.phase}: ${entry.error ?? '(no error recorded on the fiber)'}\n${driverStderr}`,
    );
    assert.equal(entry.error, null);
  });

  it('registers every w2m_* tool the package declares', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    const registered = report.tools.filter((name) => name.startsWith('w2m_'));
    // Order is not part of the claim: "every declared tool is registered" is about membership, and a deepEqual
    // against a list pinned the registration order of tools.mjs instead, so inserting a tool anywhere but the end
    // failed the capture for the wrong reason (v1.2.3: w2m_intent landed before w2m_council).
    assert.deepEqual([...registered].sort(), [...EXPECTED_TOOLS].sort(), 'the live tools service holds: ' + report.tools.join(', '));
  });

  it('has the client half composed by the web app’s own clientModules row', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    assert.equal(
      report.client.accepted,
      true,
      `client-modules refused the declaration or did not activate: ${report.client.error ?? '(no diagnostic)'}`,
    );
    assert.notEqual(
      report.client.host,
      'mounted-here',
      'this profile boots the web app, so the graph read must come from its own `modules` row',
    );
    assert.ok(
      report.client.graphEntries.some((row) => row.id === CLIENT_PACKAGE),
      `the boot graph has no row for ${CLIENT_PACKAGE}: ${JSON.stringify(report.client.graphEntries)}`,
    );
    assert.ok(
      typeof report.client.bundlePath === 'string' && report.client.bundlePath.includes(path.join('lib', 'client.js')),
      `the composed row must come from the shipped bundle, got ${String(report.client.bundlePath)}`,
    );
  });

  it('attaches the composer control’s route to the live connection service', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    assert.ok(report.targetSelection !== null, 'the driver could not read w2m_status');
    // Defect 3 failed here: the `/w2m/target` registration was refused by the `/api`-mounted
    // registry inside the injected callback, leaving `attached: false` and a healthy-looking entry.
    assert.equal(report.targetSelection.route, TARGET_ROUTE_PATH);
    assert.equal(
      report.targetSelection.attached,
      true,
      `the control has no route to read: ${String(report.targetSelection.detail)}`,
    );
    assert.equal(
      report.routeProbe?.capability,
      true,
      `the Node-execution control has no GET/POST route (routes: ${JSON.stringify(report.routeProbe?.routes ?? [])})`,
    );
  });

  it('reports no failed entry that names this package', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    const failed = report.entries.filter((row) => row.phase === 'failed' && String(row.module).includes(CLIENT_PACKAGE));
    assert.deepEqual(failed, [], `failed entries: ${JSON.stringify(failed)}`);
  });

  it('reports the stage it reached, so a failure names its cause', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    // The driver prints one line per stage as it goes and carries the list in its report; a run that
    // dies half-way leaves a truncated list, which is what turns "one opaque error" into a location.
    assert.ok(Array.isArray(report.stages) && report.stages.length > 0, 'the driver reported no stages');
    for (const expected of [
      'profile booted',
      'read the client composition (host half)',
      'activate the client entries (real module system + Cordis, no browser)',
    ]) {
      assert.ok(report.stages.includes(expected), `the driver never reached "${expected}"; stages: ${report.stages.join(' -> ')}`);
    }
  });

  it('sweeps every fiber in the process and finds no failure', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    // The four assertions above read the entry this file already knows about. A failure on a *child*
    // fiber — defect 3's shape, a route refused inside an injected callback — leaves that entry
    // `active`, and `loader.await()` cannot see it either: cordis settles its tasks with
    // `Promise.allSettled`. This sweep is the assertion that generalises them, and it is the only one
    // here that fails when something *else* in the tree dies.
    const died = report.failedFibers ?? [];
    assert.deepEqual(
      died,
      [],
      `failed fibers (state 3): ${died
        .map((row) => `${row.entry ?? '(no entry)'} / ${row.module ?? row.name ?? '(unnamed)'}: ${row.error}`)
        .join(' | ')}`,
    );
  });

  it('activates the client entry through the real module system and Cordis loader', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    const activation = report.clientActivation;
    assert.ok(activation !== undefined, 'the driver reported no client activation');
    assert.equal(activation.skipped, null, `the client activation was not driven: ${String(activation.skipped)}`);
    assert.deepEqual(
      activation.mounted,
      [CLIENT_PACKAGE],
      'the profile’s own client rows are what this assertion is about',
    );
    for (const row of activation.entries) {
      // v0.5.5 failed here: `failed`, "cannot get property \"locale\" without inject" — composed,
      // mounted, and dead, which is a page that cannot boot.
      assert.equal(
        row.phase,
        'active',
        `${String(row.module)} ended ${row.phase} (state ${String(row.state)}): ${row.error ?? '(no error recorded on the fiber)'}`,
      );
      assert.equal(row.error, null);
    }
    // Activation is not enough on its own: the entry has to have taken its seat in the composer.
    assert.ok(
      activation.seats.includes('conversation.input.left'),
      `the entry activated without registering into the composer: seats ${JSON.stringify(activation.seats)}`,
    );
  });

  it('reports the surface diagnostics and marks every registered entry', async (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    const page = report.clientPage;
    assert.ok(page !== undefined, 'the driver reported no page boot');
    if (typeof page.skipped === 'string') return t.skip(page.skipped);
    const surfaces = page.surfaces;
    assert.ok(surfaces !== null && surfaces?.diag !== null, `the page exposed no surface diagnostics: ${JSON.stringify(surfaces)}`);
    const { available = {}, fallback } = surfaces.diag;
    for (const key of ['gpw', 'backup', 'desktop', 'archive', 'journal', 'decisions']) {
      assert.equal(typeof available[key], 'boolean', `__W2M_SURFACES__.available.${key} is a boolean`);
      assert.equal(typeof surfaces.diag.reasons?.[key], 'string', `__W2M_SURFACES__.reasons.${key} names the probe outcome`);
    }
    assert.equal(typeof surfaces.diag.probedAt, 'string', 'the diagnostics say when they were probed');
    const markers = new Set(surfaces.markers ?? []);
    assert.equal(markers.has('archive'), false, 'the archive surface has no slot entry of its own: it is a tab');
    if (fallback === true) {
      // The throwaway profile disables every UI row, which is exactly the "probe cannot decide" case: the
      // entries must stay, because a probe failure must never make working buttons disappear.
      for (const key of ['gpw', 'backup', 'desktop']) assert.ok(markers.has(key), `the fallback keeps the ${key} entry`);
      assert.equal(available.archive, false, 'the fallback does not invent an archive surface');
    } else {
      for (const key of ['gpw', 'desktop']) {
        assert.equal(markers.has(key), available[key] === true, `the ${key} entry follows its probe (available=${String(available[key])})`);
      }
      // The backup panel is reachable when *either* backend row answers, because the archive tab lives
      // inside it (design A1): an enabled archive row with a disabled repository row still needs a door.
      assert.equal(
        markers.has('backup'),
        available.backup === true || available.archive === true,
        `the backup panel follows its row or the archive row (backup=${String(available.backup)}, archive=${String(available.archive)})`,
      );
    }
  });

  it('mounts the queue journal and the decision inbox only for their enabled rows', async (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    const base = report?.clientPage;
    assert.ok(base !== undefined, 'the driver reported no page boot');
    if (typeof base.skipped === 'string') return t.skip(base.skipped);
    // The shipped profile enables dsh-queue-journal and dsh-decision-center, so both surfaces are in the page
    // and both probes answered for themselves.
    const diag = base.surfaces?.diag ?? {};
    assert.equal(diag.fallback, false, `the probes answer for themselves: ${JSON.stringify(diag)}`);
    assert.equal(diag.available?.journal, true, `the queue-journal row is enabled in this profile: ${JSON.stringify(diag.reasons)}`);
    assert.equal(diag.available?.decisions, true, `the decision-center row is enabled in this profile: ${JSON.stringify(diag.reasons)}`);
    assert.equal(base.surfaces?.journalChip, true, `the queue-journal chip is in the composer; surfaces=${JSON.stringify(base.surfaces)}`);
    assert.equal(base.surfaces?.decisionInbox, true, 'the decision inbox badge is in the page');
    assert.ok(bootContext !== null, 'the throwaway profile is installed');
    const { installation: mounted, home, profileDir, overlayPath, env, cwd } = bootContext;

    // Toggle both rows off in the *installed* copy only (never in the tree under test), boot the same profile
    // again, and measure the other direction: a 404 hides the surface and the diagnostics stay authoritative.
    const patchPath = path.join(profileDir, 'node_modules', '@twinsearth', 'w2m-dsh-plugin', 'cordis.patch.yml');
    const original = await fsp.readFile(patchPath, 'utf8');
    let patched = original;
    for (const row of ['dsh-queue-journal', 'dsh-decision-center']) {
      const pattern = new RegExp(`(- id: ${row}\\n\\s+name: '[^']+'\\n)(\\s+config:)`, 'u');
      const next = patched.replace(pattern, '$1      disabled: true\n$2');
      assert.notEqual(next, patched, `could not disable the ${row} row in ${patchPath}`);
      patched = next;
    }
    await fsp.writeFile(patchPath, patched, 'utf8');
    try {
      const booted = await run(
        mounted.runtime,
        ['--expose-internals', DRIVER, mounted.root, home, PROFILE, JSON.stringify(APP_ARGS), overlayPath],
        { env, cwd, timeoutMs: BOOT_TIMEOUT_MS },
      );
      const toggled = parseReport(booted.stdout);
      assert.ok(
        toggled !== null,
        `the toggled profile produced no report (exit ${booted.code}, timed out: ${booted.timedOut}):\n${booted.stdout}\n${booted.stderr}`,
      );
      assert.equal(toggled.ok, true, `the toggled profile failed to boot: ${toggled.error}`);
      const page = toggled.clientPage;
      assert.ok(page !== undefined, 'the toggled boot reported no page');
      if (typeof page.skipped === 'string') return t.skip(page.skipped);
      const off = page.surfaces?.diag ?? {};
      assert.equal(off.available?.journal, false, `a disabled queue-journal row answers 404: ${JSON.stringify(off.reasons)}`);
      assert.equal(off.available?.decisions, false, `a disabled decision-center row answers 404: ${JSON.stringify(off.reasons)}`);
      assert.equal(off.fallback, false, 'two 404s are authoritative answers, not a probe failure');
      assert.equal(page.surfaces?.journalChip, false, 'the queue-journal chip is gone with its row');
      assert.equal(page.surfaces?.journalFallback, false, 'and so is the sidebar fallback entry');
      assert.equal(page.surfaces?.decisionInbox, false, 'the decision inbox badge is gone with its row');
    } finally {
      await fsp.writeFile(patchPath, original, 'utf8');
    }
  });

  it('shows the archive tab only for an enabled archive row', async (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    if (process.env[SURFACES_PROBE_ENV] !== '1') {
      return t.skip(`${SURFACES_PROBE_ENV}=1 enables the archive row in the throwaway profile and drives this probe`);
    }
    // The page half of this probe needs a browser like its neighbours do: without one the driver reports
    // `{ skipped }` and there is no page to read, which is a skip carrying the reason, not a failed probe.
    const page = report.clientPage;
    assert.ok(page !== undefined, 'the driver reported no page boot');
    if (typeof page.skipped === 'string') return t.skip(page.skipped);
    const probe = page.surfacesProbe ?? {};
    assert.equal(page.surfaces?.diag?.ok, true, `the probes must be authoritative with one row enabled: ${JSON.stringify(page.surfaces?.diag)}`);
    assert.equal(page.surfaces?.diag?.available?.archive, true, 'the enabled archive row answers');
    assert.equal(page.surfaces?.diag?.available?.backup, false, 'the repository row stays disabled');
    assert.equal(probe.seat?.found, true, 'the archive row makes the backup entry reachable');
    assert.equal(
      probe.seat?.archiveLabel,
      1,
      `the entry reads 「归档备份」 when only the archive row is enabled: ${JSON.stringify(probe.seat)}`,
    );
    assert.equal(probe.seat?.backupLabel, 0, 'the repository label must not claim a backend this profile does not have');
    assert.equal(probe.opened?.found, true, 'the panel is reachable because the archive row made it so, with the repository row off');
    assert.equal(probe.panel?.panel, true, 'clicking the backup entry opens the panel page');
    assert.equal(probe.panel?.tabs, true, 'the tab bar appears only with an available archive surface');
    assert.equal(probe.clicked?.clicked, true, 'the 归档 tab accepts a click');
    assert.equal(probe.archive?.status, true, 'the 归档 tab renders the archive view');
    assert.equal(probe.created?.clicked, true, 'the 归档 tab offers a create action');
    assert.ok(Number(probe.listed?.rows) >= 1, `the created archive appears in the list: ${JSON.stringify(probe.listed)}`);
    assert.ok(Number(probe.listed?.verifyButtons) >= 1, 'each archive row offers 校验');
    assert.ok(Number(probe.listed?.planButtons) >= 1, 'each archive row offers 恢复计划');
    assert.equal(probe.verified?.clicked, true, 'the verify action accepts a click');
    assert.equal(probe.verifiedCard?.present, true, `the verification result renders: ${JSON.stringify(probe.verifiedCard)}`);
    assert.deepEqual([...(probe.verifiedCard?.counts ?? [])].sort(), ['checked', 'extras', 'mismatched', 'missing'], 'the result table reports checked/missing/mismatched/extras');
    assert.equal(probe.archive?.create, true, 'the tab offers create');
    assert.equal(probe.archive?.import, true, 'the tab offers the ZIP import');
    assert.equal(probe.archive?.repoStatus, false, 'the repository cards are not rendered behind the archive tab');
    for (const key of ['gpw', 'desktop']) {
      assert.equal((probe.archive?.markers ?? []).includes(key), false, `the disabled ${key} row has no entry`);
    }
  });

  it('boots the profile’s own page in a browser, and the control arrives', async (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    const page = report.clientPage;
    assert.ok(page !== undefined, 'the driver reported no page boot');
    if (typeof page.skipped === 'string') {
      // Loudly, never silently: this half is the only one that runs the shell's real boot, so a
      // missing browser is a hole in the evidence and the reason travels with it.
      t.diagnostic(`the real-page half of this file did not run: ${page.skipped}`);
      return t.skip(page.skipped);
    }
    assert.equal(page.bootFailure, null, `the shell refused the page: ${String(page.bootFailure)}`);
    assert.equal(
      page.arrived,
      true,
      `the control never reached the page (${page.arrivedSelector} absent after ${String(page.settledAfterMs)}ms; ` +
        `boot overlay: ${String(page.bootOverlay)}; body: ${String(page.bodyText ?? '').slice(0, 300)}; ` +
        `console errors: ${JSON.stringify(page.consoleErrors ?? [])})`,
    );
    // The stylesheet alone says "our apply ran", which the shell checks *before* it accepts the
    // page. The boot surface going away says every entry activated and the UI mounted, which is the
    // whole claim: on the v0.5.5 bundle the same measurement left the failure card up
    // (`Failed to load plugins / @twinsearth/w2m-dsh-plugin / web boot: 1 entry did not activate`).
    assert.equal(
      page.bootOverlayGone,
      true,
      `the page never finished booting (boot surface still up after ${String(page.settledAfterMs)}ms; ` +
        `body: ${String(page.bodyText ?? '').slice(0, 300)})`,
    );
    if (process.env[DECISION_PROBE_ENV] === '1') {
      // v3.5.7: this probe enables the GPW and backup rows in the installed copy (the shipped patch has them
      // disabled), so the probe contract itself is asserted first: every row it drives answered, and the
      // answer was authoritative rather than the legacy "nothing answered" fallback.
      const diag = page.surfaces?.diag ?? {};
      assert.equal(diag.fallback, false, `the probes answered authoritatively: ${JSON.stringify(diag)}`);
      assert.equal(diag.available?.gpw, true, `the GPW row is enabled for this probe: ${JSON.stringify(diag.reasons)}`);
      assert.equal(diag.available?.backup, true, `the backup row is enabled for this probe: ${JSON.stringify(diag.reasons)}`);
      assert.equal(diag.available?.decisions, true, `the decision-center row is enabled: ${JSON.stringify(diag.reasons)}`);
      const probe = page.decisionProbe ?? {};
      assert.equal(probe.badge?.found, true, `the floating decision inbox badge is not in the page: ${JSON.stringify(probe)}`);
      assert.equal(probe.opened?.clicked, true, `the badge did not accept a click: ${JSON.stringify(probe.opened)}`);
      assert.equal(probe.drawer?.hidden, false, `the inbox drawer did not open: ${JSON.stringify(probe.drawer)}`);
      assert.match(String(probe.drawer?.title ?? ''), /收件箱/u, 'the drawer names itself as the inbox');
      assert.equal(probe.closed?.found, true, 'the drawer has a close button');
      assert.equal(probe.afterClose?.display, 'none', `the close button closes the drawer: ${JSON.stringify(probe.afterClose)}`);
      assert.notEqual(probe.drawer?.display, 'none', 'the open drawer is actually displayed, not merely un-hidden');
      const visibility = probe.closedVisibility ?? {};
      assert.equal(visibility.drawer, 'none', `the closed drawer is not rendered (display): ${JSON.stringify(visibility)}`);
      assert.equal(visibility.overlay, 'none', `the closed overlay is not rendered (display): ${JSON.stringify(visibility)}`);
      assert.equal(visibility.hitBlocked, false, 'a click on the page is not intercepted by a leftover overlay');
      assert.equal(probe.sidebar?.found, false, 'the left sidebar no longer carries the decision-center entry (v3.2.10)');
      assert.equal(probe.gpwButton?.launcher, true, 'the GPW launcher is in the page so its inbox button can be checked');
      assert.equal(probe.gpwButton?.inboxButton, true, 'the GPW panel carries the inbox button');
      const queue = page.queueProbe ?? {};
      assert.equal(queue.postJournal?.ok, true, `the queue journal host accepted a draft: ${JSON.stringify(queue.postJournal)}`);
      assert.equal(queue.listApi?.ok, true, `the queue journal list route answers: ${JSON.stringify(queue.listApi)}`);
      assert.equal(queue.queueBadge?.found, true, 'the slotted queue-journal chip is in the composer');
      assert.equal(queue.queueBadge?.status, 'slotted', `the chip reports a slotted surface: ${JSON.stringify(queue.queueBadge)}`);
      assert.equal(queue.queueOpened?.clicked, true, 'the queue-journal chip accepts a click');
      assert.equal(queue.queueDrawer?.found, true, `the queue-journal drawer opens: ${JSON.stringify(queue.queueDrawer)}`);
      assert.equal(queue.queueDrawer?.status, 'slotted', 'the drawer reports the surface diagnostics');
      assert.match(String(queue.queueDrawer?.title ?? ''), /队列日志/u, 'the drawer names itself as the queue journal');
      assert.match(String(queue.queueDrawer?.body ?? ''), /human draft text/u, 'a human session record is visible by default');
      assert.equal(queue.queueDrawer?.foldExists, true, 'client-generated records are folded into their own section');
      assert.equal(queue.queueDrawer?.foldOpen, false, 'the client-generated section is collapsed by default');
      assert.ok(!String(queue.queueDrawer?.body ?? '').includes('probe draft text'), 'the client-keyed record is not shown in the default list');
      assert.equal(queue.foldOpened?.opened, true, 'the folded section can be opened');
      assert.match(String(queue.foldOpened?.text ?? ''), /probe draft text/u, 'the folded section carries the client-keyed record');
      assert.equal(queue.queueGpw?.button, true, 'the GPW panel carries the queue-journal button');
      assert.equal(queue.queueDock?.chip, true, 'the composer carries the queue-journal chip');
      const parity = page.parityProbe ?? {};
      assert.equal(parity.ingest?.ok, true, `the decision ingest route accepted a probe ticket: ${JSON.stringify(parity.ingest)}`);
      assert.equal(parity.openInbox?.found, true, 'the inbox badge re-opened the drawer for the parity checks');
      assert.equal(parity.batch?.open, true, 'the drawer is open for the parity checks');
      assert.equal(parity.batch?.resolveButton, true, 'a level group with pending tickets shows the batch resolve button');
      assert.equal(parity.batch?.abandonButton, true, 'a level group with pending tickets shows the batch abandon button');
      assert.equal(parity.keyboard?.selected, true, 'ArrowDown moves the keyboard selection in the drawer');
      assert.equal(parity.batch?.sidePanels, true, 'the drawer carries the fork-aggregation/producer side panel');
      assert.match(String(parity.batch?.sideText ?? ''), /分叉|生产者/u, 'the side panel explains its state instead of staying blank');
      assert.equal(parity.clickedBatch?.clicked, true, 'the batch resolve button accepts a click');
      assert.equal(parity.afterBatch?.pendingMine, false, `batch resolve left no pending copy of the probe ticket: ${JSON.stringify(parity.afterBatch)}`);
      if (parity.relay?.found !== true) t.diagnostic('the per-session 待选 button was not on the landing page (it needs an active conversation)');
      const ui = page.ui324?.ui324 ?? {};
      assert.match(String(ui.badgeText ?? ''), /待选/u, 'the right-edge badge shows 待选');
      assert.equal(parity.batch?.badgeTone, 'blue', `the badge takes the highest pending level tone while the two blue probe tickets are pending: ${JSON.stringify(parity.batch?.badgeTone)}`);
      assert.match(String(parity.batch?.badgeText ?? ''), /待选/u, 'the badge shows the 待选 label');
      assert.doesNotMatch(String(ui.sidebarText ?? ''), /决策中心/u, 'the left sidebar no longer carries the decision-center entry (v3.2.10)');
      assert.ok(ui.drawerOpen === true, 'the decision drawer is open for the geometry checks');
      const vh = Number(ui.viewport?.h) || 0;
      assert.ok(ui.drawerHeight > vh * 0.4 && ui.drawerHeight < vh * 0.85, `the decision drawer is half height, not full height: ${JSON.stringify({ drawerHeight: ui.drawerHeight, vh })}`);
      assert.ok(ui.drawerTop > 0, 'the decision drawer is vertically centred, not pinned to the top');
      assert.ok(ui.drawerRightGap >= 0 && ui.drawerRightGap <= 40, 'the decision drawer sits on the right edge');
      assert.equal(ui.bodyOverflow, 'auto', 'the decision drawer body scrolls');
      assert.equal(ui.gpwAiSection, true, 'the GPW panel carries the AI risk-grading settings section');
      assert.equal(ui.queueTone, 'blue', `one saved journal entry puts the queue chip in the 1-30 blue band: ${JSON.stringify(ui.queueTone)}`);
      assert.equal(ui.queueChipStatus, 'slotted', `the queue chip reports the slotted surface: ${JSON.stringify(ui.queueChipStatus)}`);
      assert.ok(Number(ui.queueChipRect?.width) > 0 && Number(ui.queueChipRect?.height) > 0, `the queue chip is rendered in the composer: ${JSON.stringify(ui.queueChipRect)}`);
      assert.equal(page.ui324?.qOpened?.clicked, true, 'the queue chip opens its drawer');
      assert.equal(page.ui324?.qGeom?.open, true, 'the queue drawer is open for the geometry checks');
      const qh = Number(page.ui324?.qGeom?.height) || 0;
      const qvh = Number(page.ui324?.qGeom?.viewportH) || 0;
      assert.ok(qh > qvh * 0.35 && qh < qvh * 0.85, `the queue drawer is half height: ${JSON.stringify({ qh, qvh })}`);
      assert.ok(Number(page.ui324?.qGeom?.bottomGap) >= 0, 'the queue drawer opens inside the viewport');
      assert.equal(page.ui324?.qGeom?.overflow, 'auto', 'the queue drawer body scrolls');
      const jq = page.jq626?.jq626 ?? {};
      assert.equal(jq.clearAll, true, 'the queue journal drawer has 清空全部');
      assert.equal(jq.noSessionIdLabel, true, 'the queue journal drawer never renders a Session ID');
      assert.equal(jq.noRawSessionKey, true, 'the queue journal drawer never renders a raw session key');
      assert.equal(ui.historyButton, true, 'the composer carries the single history button');
      assert.equal(ui.targetButton, true, 'the 全部机器 target control is visible again');
      assert.equal(ui.chatButton, true, 'the 编队聊天 fleet-chat control is visible again');
      assert.match(String(ui.fleetStatusText ?? ''), /本编队在线机器/u, 'the bottom bar shows this fleet\'s machine ratio');
      assert.match(String(ui.fleetStatusText ?? ''), /在线编队/u, 'the bottom bar shows the online-fleets ratio');
      const history = page.historyProbe ?? {};
      assert.equal(history.historyOpened?.found, true, 'the history button exists in the real page');
      assert.equal(history.historyWindow?.open, true, 'clicking the history button expands its window');
      assert.equal(history.historyWindow?.title, '历史对话');
      assert.match(String(history.historyWindow?.hint ?? ''), /^仅人类输入/u, 'the window states that it lists human input only');
      assert.equal(history.historyWindow?.wrapped, true, 'the history window is anchored to the composer, not fixed at the page bottom');
      assert.equal(history.historyWindow?.position, 'absolute', 'the window is absolutely positioned above the input row');
      assert.equal(history.historyClosed?.closed, true, 'the window closes again');
      assert.equal(page.jq626?.sessionsApi?.ok, true, `the sessions route answers: ${JSON.stringify(page.jq626?.sessionsApi)}`);
      const gpwClose = page.gpwClose ?? {};
      assert.equal(gpwClose.gpwOpen?.open, true, 'the GPW floating panel opens from its launcher for the close checks');
      assert.equal(gpwClose.outsideClick?.clicked, true, 'a click on the GPW overlay background is dispatched');
      assert.equal(gpwClose.outsideClosed?.closed, true, 'clicking outside the GPW panel closes it');
      assert.equal(gpwClose.reopened?.open, true, 'the GPW panel reopens for the Escape check');
      assert.equal(gpwClose.escClosed?.closed, true, 'Escape closes the GPW panel');
      const pin = page.gpwSidebarPin ?? {};
      assert.equal(pin.pinDefault?.row, false, 'the GPW operations row is absent by default even though the GPW row is enabled');
      assert.equal(pin.pinDefault?.preference, null, 'a fresh profile has no sidebar-pin preference');
      assert.equal(pin.pinButton?.found, true, 'the GPW floating panel offers the explicit sidebar-pin control');
      assert.equal(pin.pinButton?.state, 'false', 'the pin control starts unpinned');
      assert.match(String(pin.pinButton?.text ?? ''), /固定到左侧边栏/u, 'the control tells the operator how to opt in');
      assert.equal(pin.pinClicked?.clicked, true, 'the pin control accepts a real page click');
      assert.equal(pin.pinned?.row, true, 'pinning mounts the operations row in the left sidebar');
      assert.equal(pin.pinned?.state, 'true', 'the control reflects the pinned state');
      assert.equal(pin.pinned?.preference, '1', 'pinning persists the opt-in preference');
      assert.equal(pin.unpinClicked?.clicked, true, 'the same control accepts the unpin click');
      assert.equal(pin.unpinned?.row, false, 'unpinning removes the operations row again');
      assert.equal(pin.unpinned?.state, 'false', 'the control returns to the unpinned state');
      assert.equal(pin.unpinned?.preference, '0', 'unpinning clears the persisted opt-in');
      assert.equal(pin.repinClicked?.clicked, true, 'the control accepts a second pin for the operations-page check');
      assert.equal(pin.repinned?.row, true, 'the second pin remounts exactly the row used below');
      assert.equal(pin.repinned?.state, 'true', 'the second pin is reflected by the control');
      assert.equal(pin.repinned?.preference, '1', 'the second pin restores the opt-in preference');
      const ops = page.opsProbe ?? {};
      assert.equal(ops.opsOpened?.found, true, 'the explicitly pinned sidebar operation-panel button exists');
      assert.equal(ops.opsPanel?.open, true, 'clicking the sidebar button opens the operation panel');
      assert.equal(ops.opsActionsTab?.clicked, true, 'the 操作入口 tab exists and accepts a click');
      for (const label of ['智能分级&审批', '消息与草稿', '决策中心', '操作入口']) {
        assert.ok(Array.isArray(ops.opsPanel?.tabs) && ops.opsPanel.tabs.some((tab) => String(tab).includes(label)), `the operation panel has the ${label} tab`);
      }
      assert.equal(ops.opsQueueTab?.clicked, true, 'the queue tab is clickable');
      assert.equal(ops.opsQueueSection?.section, true, 'the queue section renders');
      assert.equal(ops.opsQueueSection?.openButton, true, 'the queue section offers opening the queue window');
      assert.equal(ops.opsGone?.closed, true, 'the operation-panel overlay closes again');
      assert.equal(ops.opsFleetVersion?.present, true, 'the operation panel renders the fleet version-drift card (v3.5.0)');
      assert.ok(['ready', 'unavailable'].includes(ops.opsFleetVersion?.state), `the fleet card reports a real state (state: ${ops.opsFleetVersion?.state}, text: ${ops.opsFleetVersion?.text})`);
      assert.equal(ops.opsFleetVersion?.title, '编队版本', 'the fleet card carries its title');
      if (ops.opsFleetVersion?.state === 'ready') {
        assert.equal(ops.opsFleetVersion?.copyButton, true, 'the fleet card offers copying the upgrade guidance');
      }
      const backup = page.backupProbe ?? {};
      assert.equal(backup.backupOpened?.found, true, 'the left sidebar carries the backup entry (v3.4.9)');
      assert.equal(backup.backupSeatText?.found, true, 'the backup seat is readable');
      assert.equal(
        backup.backupSeatText?.count,
        1,
        `the backup seat shows its label exactly once (text: ${backup.backupSeatText?.text})`,
      );
      assert.equal(backup.backupPanel?.open, true, 'clicking the backup entry opens its main page');
      for (const action of ['run', 'restore', 'archive', 'verify']) {
        assert.ok(
          Array.isArray(backup.backupPanel?.actions) && backup.backupPanel.actions.includes(action),
          `the backup panel renders the ${action} one-click operation (actions: ${JSON.stringify(backup.backupPanel?.actions)})`,
        );
      }
      assert.deepEqual(
        (backup.backupClicks ?? []).map((row) => row.clicked),
        [true, true, true, true, true],
        'the four one-click operations plus backup-active are clickable in the real page',
      );
      assert.equal(backup.backupPanel?.actions?.includes('backup-selected'), true, 'the backup-selected entry exists');
      assert.equal(backup.backupPanel?.actions?.includes('backup-active'), true, 'the backup-active entry exists');
      assert.equal(backup.scopeActions?.active?.disabled, false, 'backup-active is usable even when the scan route is missing');
      assert.equal(backup.scopeActions?.selected?.disabled, true, 'backup-selected stays disabled while there is nothing to pick');
      assert.equal(backup.backupLog?.rows >= 4, true, `each click records a log row (rows: ${backup.backupLog?.rows}, text: ${backup.backupLog?.text})`);
      assert.equal(backup.backupLog?.panelStillOpen, true, 'the panel stays mounted after route refusals');
      if (parity.rightTab?.marker === '1') {
        assert.equal(parity.rightTab.marker, '1');
      } else {
        t.diagnostic('the right-pane tab marker was absent (host may not provide sidebarRightTabs in this profile)');
      }
    }

    // v3.6.0: the queue journal driven end to end through its documented slot surfaces. This is the
    // regression a DSH layout update cannot silently pass: the chip must be in the composer, a typed
    // draft must reach the host file under `$DSH_HOME/xclient/queue-journal`, the `shell.overlay`
    // drawer must list it, and restore must write the draft back through `inputActions.setDraft`.
    if (process.env.W2M_QUEUE_JOURNAL_PROBE === '1') {
      const probe = page.queueJournalProbe ?? {};
      const journal = page.journal ?? {};
      t.diagnostic('queue journal probe: ' + JSON.stringify({ probe, journal }));
      assert.equal(probe.chip?.found, true, `the slotted queue-journal chip is not in the composer: ${JSON.stringify(probe)}`);
      assert.equal(probe.chip?.status, 'slotted', 'the chip reports the slotted surface');
      assert.equal(probe.diagnostics?.status, 'slotted', `the diagnostics object reports the slotted surface: ${JSON.stringify(probe.diagnostics)}`);
      assert.equal(probe.diagnostics?.surface, 'conversation.input.left+shell.overlay', 'both documented slot names are reported');
      const attempts = Array.isArray(probe.diagnostics?.slotAttempts) ? probe.diagnostics.slotAttempts : [];
      assert.equal(
        attempts.map((attempt) => attempt.slot + ':' + attempt.ok).join(','),
        'conversation.input.left:true,shell.overlay:true',
        `the diagnostics record every slot attempt in order: ${JSON.stringify(attempts)}`,
      );
      assert.match(String(probe.diagnostics?.dshVersion ?? ''), /^0\.2\./u, 'the client read the DSH version from the page boot graph');
      assert.equal(probe.typed?.typed, true, `a draft was typed into the real composer: ${JSON.stringify(probe.typed)}`);
      assert.equal(probe.saved?.found, true, `the typed draft reached the host journal route: ${JSON.stringify(probe.saved)}`);
      assert.equal(journal.exists, true, `the host wrote the journal file at ${String(journal.path)}`);
      assert.match(String(journal.probeDraft ?? ''), /probe-journal-draft/u, 'the probe draft is in the host file under xclient/queue-journal');
      const diagnosticsRoute = probe.diagnosticsRoute ?? {};
      assert.equal(diagnosticsRoute.status, 200, `the host diagnostics route answers in the real page: ${JSON.stringify(diagnosticsRoute)}`);
      assert.equal(diagnosticsRoute.ok, true, 'the diagnostics route reports ok');
      assert.equal(diagnosticsRoute.dirEndsWith, true, 'the diagnostics route names the queue-journal data directory');
      assert.equal(diagnosticsRoute.entries, true, 'the diagnostics route reports an integer entry count');
      assert.equal(diagnosticsRoute.writable, 'boolean', 'the diagnostics route probes writability without failing');
      assert.equal(diagnosticsRoute.lastWriteAt, true, 'the diagnostics route reports lastWriteAt (string or null)');
      assert.equal(diagnosticsRoute.errors, true, 'the diagnostics route reports its errors as an array');
      assert.equal(probe.opened?.clicked, true, 'the chip opens the drawer');
      assert.equal(probe.drawer?.marker, '1', 'the drawer carries the data-w2m-jq-drawer marker');
      assert.equal(probe.drawer?.status, 'slotted', 'the drawer reports the surface diagnostics');
      assert.equal(probe.drawer?.unverifiedNotice, false, 'an in-range version renders no unverified notice');
      assert.ok(Number(probe.drawer?.rows) >= 1, `the drawer lists the saved entry: ${JSON.stringify(probe.drawer)}`);
      assert.equal(probe.drawer?.hasDraft, true, 'the drawer shows the typed draft');
      assert.equal(probe.drawer?.hasRestore, true, 'the drawer carries a restore-draft action');
      assert.equal(probe.cleared?.contains, false, `the composer was cleared before restore: ${JSON.stringify(probe.cleared)}`);
      assert.equal(probe.restored?.clicked, true, 'the restore-draft action accepts a click');
      assert.equal(probe.afterRestore?.contains, true, `restore wrote the draft back through the slot: ${JSON.stringify(probe.afterRestore)}`);
      assert.equal(probe.closed?.closed, true, 'the drawer close action is present');
      assert.equal(probe.closeState?.closed, true, 'the drawer is removed after closing');
    }

    // v3.5.x: the unlock dialog in the real page. Independent of the decision probe for the same reason that
    // probe gates the backup panel probe: the backup seat lives on the session-less left sidebar, so the dialog
    // is reachable on the landing page without a conversation.
    if (process.env[BACKUP_PROBE_ENV] === '1') {
      // v3.5.7: the probe enables the backup row in the installed copy; the archive row stays disabled, which
      // is the state its "no tab bar" assertions below describe. Assert the probe contract first.
      const diag = page.surfaces?.diag ?? {};
      assert.equal(diag.fallback, false, `the probes answered authoritatively: ${JSON.stringify(diag)}`);
      assert.equal(diag.available?.backup, true, `the backup row is enabled for this probe: ${JSON.stringify(diag.reasons)}`);
      assert.equal(diag.available?.archive, false, `the archive row stays disabled for this probe: ${JSON.stringify(diag.reasons)}`);
      const unlock = page.backupProbe ?? {};
      assert.equal(unlock.backupOpened?.found, true, 'the left sidebar carries the backup entry');
      assert.equal(unlock.backupPanel?.open, true, 'clicking it opens the backup panel page');
      assert.match(String(unlock.backupPanel?.title ?? ''), /备份&还原/u, 'the enabled repository row keeps its own label');
      assert.doesNotMatch(String(unlock.backupPanel?.title ?? ''), /归档备份/u, 'the archive-only label needs the archive row, not this one');
      // v3.5.6/A1: this profile has the archive row disabled, so its probe answers 404 and the tab must be
      // absent -- the other direction of "the tab appears only for an enabled archive row".
      assert.equal(unlock.backupPanel?.tabs, false, 'a disabled archive row renders no tab bar');
      assert.equal(unlock.backupPanel?.archiveTab, false, 'a disabled archive row renders no 归档 tab');
      assert.equal(unlock.backupPanel?.trigger, true, 'the unlock card carries the dialog trigger');
      assert.equal(unlock.unlockOpened?.found, true, 'clicking the trigger opens the unlock dialog');
      const dialog = unlock.unlockDialog ?? {};
      assert.equal(dialog.found, true, `the unlock dialog is in the page: ${JSON.stringify(dialog)}`);
      assert.equal(dialog.role, 'dialog', 'the unlock surface has role="dialog"');
      assert.equal(dialog.ariaModal, 'true', 'the unlock dialog is modal');
      assert.equal(dialog.overlay, true, 'the unlock dialog renders on its own overlay');
      assert.ok(typeof dialog.labelledBy === 'string' && dialog.labelledBy !== '',
        'the unlock dialog is labelled by its title');
      assert.equal(dialog.optionA, true, 'the local/account option is rendered');
      assert.equal(dialog.command, 'w2m-backup unlock --check --password-stdin',
        'the terminal password command is shown as copyable text');
      assert.equal(dialog.copy, true, 'the command has a copy button');
      assert.equal(dialog.refresh, true, 'the command has the refresh-state button');
      assert.equal(dialog.passwordFields, 0,
        'the unlock dialog has no text/password field: a password never enters the browser');
      assert.equal(unlock.unlockClosed?.closed, true, 'Escape closes the unlock dialog');
      assert.equal(unlock.unlockClosed?.overlayGone, true, 'Escape removes the unlock overlay too');
    }

    if (process.env.W2M_CAPABILITY_PROBE === '1') {
      const probe = page.capabilityProbe ?? {};
      assert.equal(probe.menu?.menu, true, `the Node-execution menu never opened: ${JSON.stringify(probe)}`);
      assert.equal(probe.after?.on, 'true', `selecting temporary Node execution did not take effect: ${JSON.stringify(probe)}`);
    }
  });
});
