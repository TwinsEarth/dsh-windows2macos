/**
 * Boot one DSH profile through the **real Loader** and report what its tree settled to.
 *
 * # Why this is a separate process
 *
 * The Loader, the profile composer and the plugin bundles all live inside the Harness
 * installation (`resources/app.asar/dsh/node_modules`), and an ASAR archive is readable only by the
 * Harness runtime — Electron's patched `fs` — not by a plain `node`. So this driver must be started
 * by that runtime:
 *
 *   "DeepSeek Harness.exe" --expose-internals <this file> <harnessRoot> <dshHome> <profile>
 *
 * (or, from a shell the Harness itself launched, `node <this file> …` with
 * `DSH_DESKTOP_NODE_EXECUTABLE` pointing at the same binary). `test/loader-entry.test.mjs` finds the
 * installation and spawns this file; nothing here is a stand-in for the loader — `runProfile` is the
 * exact function `dsh --profile <name>` runs, over the exact profile directory the installer wrote.
 *
 * # What it reports
 *
 * One line of JSON on stdout, prefixed `W2M-LOADER-REPORT:`, holding
 *
 *   entries  every Loader entry with the fiber state it settled to (2 = active, 3 = failed) and the
 *            error the fiber recorded, so "the entry is active" is a measurement, not an inference
 *            from the absence of a message;
 *   tools    the names the `tools` service hands the model, read through its own projection;
 *   client   whether the real `clientModules` host half accepted this package's `dsh.client`
 *            declaration and composed a boot-graph row for it, plus the bundle path it read.
 *
 * The process disposes the tree and exits on its own: the profile's tree owns sockets and timers, so
 * a report that hung would be a report that never arrived.
 *
 * Usage: <harness runtime> driver.mjs <harnessRoot> <dshHome> <profile> [appArgsJson] [overlayPath]
 *
 * `appArgsJson` is the app flag array the profile's own app parses (the web app accepts
 * `["--port","0","--no-open"]`, which makes a web-shaped composition bindable from a test);
 * `overlayPath` is an extra patch layer applied over the profile's, which is how the test keeps the
 * plugin's own status call off the network.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORT_PREFIX = 'W2M-LOADER-REPORT:';

/**
 * Read one argument, or fail with usage rather than booting the wrong profile.
 *
 * @param {number} index - Position in `process.argv`.
 * @param {string} name - Argument name for the diagnostic.
 * @returns {string}
 */
function requiredArgument(index, name) {
  const value = process.argv[index];
  if (typeof value !== 'string' || value === '') {
    process.stderr.write(`w2m-loader-driver: missing <${name}>\n`);
    process.stderr.write('usage: driver.mjs <harnessRoot> <dshHome> <profile> [appArgsJson] [overlayPath]\n');
    process.exit(2);
  }
  return value;
}

const harnessRoot = requiredArgument(2, 'harnessRoot');
const dshHome = requiredArgument(3, 'dshHome');
const profile = requiredArgument(4, 'profile');
const appArgs = process.argv[5] === undefined || process.argv[5] === '' ? [] : JSON.parse(process.argv[5]);
const overlay = process.argv[6] === undefined || process.argv[6] === '' || process.argv[6] === '-' ? null : process.argv[6];
if (!Array.isArray(appArgs) || appArgs.some((value) => typeof value !== 'string')) {
  process.stderr.write('w2m-loader-driver: <appArgsJson> must be a JSON array of strings\n');
  process.exit(2);
}

/** URL of the modules inside the installation's ASAR archive. */
const packages = pathToFileURL(path.join(harnessRoot, 'resources', 'app.asar', 'dsh', 'node_modules')).href;

process.env.DSH_HOME = dshHome;

const { runProfile } = await import(`${packages}/@deepseek-ai/dsh/lib/profile-boot.js`);
const { loadLayeredEnv } = await import(`${packages}/@deepseek-ai/dsh-app-boot/lib/index.js`);
const clientModules = await import(`${packages}/@deepseek-ai/dsh-client-modules/lib/index.js`);

/** Every log line at warn or above, so a failed service can be quoted instead of guessed at. */
const diagnostics = [];
const record = ({ name, type, args }) => {
  diagnostics.push(`${type}: ${name}: ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`);
};

/** Fiber states, by the numbers cordis uses. */
const STATE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed' };

/**
 * Snapshot every entry the Loader keeps, deepest last.
 *
 * A failed fiber keeps its reason in `_error` (cordis also writes it to the logger, which is why the
 * audit warning on stderr carries it); both are reported so the failure text travels with the
 * measurement instead of having to be matched up from a log by hand.
 *
 * @param {object} ctx - The booted root context.
 * @returns {object[]}
 */
function entryReport(ctx) {
  return [...ctx.loader.entries()].map((entry) => {
    const reason = entry.fiber?.error ?? entry.fiber?._error ?? null;
    return {
      id: entry.options.id ?? null,
      module: entry.options.name ?? null,
      disabled: entry.disabled === true,
      state: entry.fiber?.state ?? null,
      phase: STATE[entry.fiber?.state] ?? 'absent',
      error: reason === null ? null : String(reason?.message ?? reason),
    };
  });
}

/**
 * Ask the `tools` service which tools a model would see.
 *
 * @param {object} ctx - The booted root context.
 * @returns {string[]}
 */
function toolReport(ctx) {
  const tools = ctx.get('tools');
  if (tools === undefined) return [];
  return tools
    .schemas()
    .map((schema) => schema?.name)
    .filter((name) => typeof name === 'string')
    .sort();
}

/**
 * Read the boot graph a web composition already composed, or compose one against the settled tree.
 *
 * This is the same service the web profile loads (`@deepseek-ai/dsh-client-modules`, the `modules`
 * row of the web app's bundle patch). A web-shaped profile already has it, and then the graph read is
 * the one the browser would have been served; a base-only profile has no browser to serve, so the
 * service is mounted here instead — still the real scanner, which resolves the package's `dsh.client`
 * declaration, its `./client` export and the bundle bytes through the live Loader, and throws
 * `ClientPackageCompositionError` when any of that is missing.
 *
 * @param {object} ctx - The booted root context.
 * @returns {Promise<object>}
 */
async function clientReport(ctx) {
  const before = diagnostics.length;
  const existing = ctx.get('clientModules');
  if (existing === undefined) {
    const fiber = ctx.plugin(clientModules.ClientModuleRegistry ?? clientModules.default);
    await fiber;
  }
  const registry = ctx.get('clientModules');
  if (registry === undefined) {
    return {
      host: 'mounted-here',
      accepted: false,
      error: diagnostics.slice(before).join('\n') || 'the client-modules service did not activate',
      graphEntries: [],
    };
  }
  const graph = registry.graph();
  return {
    host: existing === undefined ? 'mounted-here' : 'the profile’s own modules row',
    accepted: true,
    error: null,
    bundlePath: registry.clientPath('@twinsearth/w2m-dsh-plugin') ?? null,
    graphEntries: graph.entries.map((row) => ({ id: row.id, url: row.url, immediately: row.immediately === true })),
  };
}

/**
 * Ask the plugin's own `w2m_status` whether the composer control has a route on this host.
 *
 * This is the only host-side answer to "is the browser control attached", and it is the tool that
 * exists to give it: `target_selection.attached` is true exactly when the route pair is registered on
 * the live `connection.fetch` registry. The call is made against the profile's own config, so the
 * caller is responsible for pointing `rabbitUrl` somewhere harmless.
 *
 * @param {object} ctx - The booted root context.
 * @returns {Promise<object|null>}
 */
async function targetSelectionReport(ctx) {
  const tools = ctx.get('tools');
  const definition = tools?.get?.('w2m_status');
  if (definition === undefined) return null;
  try {
    return JSON.parse(await definition.execute({}, {})).target_selection ?? null;
  } catch (error) {
    return { attached: null, detail: `w2m_status threw: ${error?.message ?? String(error)}`, sessions_with_a_target: null };
  }
}

let report;
try {
  const { ctx } = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile,
    patchFiles: overlay === null ? [] : [overlay],
    args: appArgs,
  });
  ctx.logger.exporter({ levels: { default: 2 }, export: record });

  report = {
    ok: true,
    profile,
    dshHome,
    entries: entryReport(ctx),
    tools: toolReport(ctx),
    client: await clientReport(ctx),
    targetSelection: await targetSelectionReport(ctx),
    diagnostics,
  };

  await ctx.fiber.dispose();
} catch (error) {
  report = {
    ok: false,
    profile,
    dshHome,
    error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
    diagnostics,
  };
}

process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
process.exit(report.ok ? 0 : 1);
