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
 *   2. all **eight** `w2m_*` tools are registered in the live `tools` service;
 *   3. the **real** `clientModules` service the web app loads composes a boot-graph row for this
 *      package from the shipped `lib/client.js`;
 *   4. the plugin's own `w2m_status` reports `target_selection.attached: true` — the route pair really
 *      is registered on the live `connection.fetch` registry, which is the host-side half of "the
 *      control works".
 *
 * Point 3 is composition, not rendering, and point 4 is registration, not a click: nothing here opens
 * a browser, so "the control appears in the composer and changes the target" remains a GUI
 * observation. What this file rules out is the whole host-side half of that failure — a dead entry, a
 * missing declaration, a route that cannot attach.
 *
 * # Running it somewhere else
 *
 * The installation is found from `W2M_DSH_RUNTIME` (the runtime executable) or `W2M_DSH_ROOT` (the
 * directory holding `resources/app.asar`), then from `DSH_DESKTOP_NODE_EXECUTABLE` or the current
 * executable when the suite is itself started by the Harness, and finally by walking up from this
 * repository looking for `resources/app.asar`. When no installation is found the tests **skip** and
 * say so: this file is about one host's loader, and pretending to test it without that host would be
 * the same mistake in a new place.
 *
 * `W2M_TEST_TARBALL=<path.tgz>` installs an existing tarball instead of packing the tree, which is how
 * the regression was proved in both directions: the same file fails on the v0.5.4 tarball and passes
 * on the fixed tree.
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

/** The eight tools the plugin registers; the exact set, because "some tools" is not the contract. */
const EXPECTED_TOOLS = [
  'w2m_devices',
  'w2m_history',
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
 * client half or the route registration depends on either value — which is why this overlay cannot
 * make a broken build look healthy. `config` is replaced wholesale, so every key is carried.
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
    const runtime = fromEnv ?? RUNTIME_CANDIDATES.map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate));
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

  it('registers all eight w2m_* tools', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    const registered = report.tools.filter((name) => name.startsWith('w2m_'));
    assert.deepEqual(registered, EXPECTED_TOOLS, `the live tools service holds: ${report.tools.join(', ')}`);
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
  });

  it('reports no failed entry that names this package', (t) => {
    if (skipReason !== null) return t.skip(skipReason);
    const failed = report.entries.filter((row) => row.phase === 'failed' && String(row.module).includes(CLIENT_PACKAGE));
    assert.deepEqual(failed, [], `failed entries: ${JSON.stringify(failed)}`);
  });
});
