/**
 * Activate the client entries a profile's **own installed packages** contribute — through the real
 * client module system and the real Cordis loader, with no browser.
 *
 * # The gap this closes
 *
 * `test/loader-entry.test.mjs` booted the real Loader and measured the *host* half of this package:
 * the entry went active, eight tools registered, the boot-graph row was composed from the shipped
 * `lib/client.js`, the fetch route attached. Every one of those can be true while the page cannot
 * boot at all, and that is what happened: the row was composed, the row named the right bundle, and
 * the bundle's `apply` threw the moment the shell tried to activate it. The shell audits every entry
 * after activation and refuses the whole page for one failure —
 * `web boot: 1 entry did not activate` — so "the row was composed" is not "the entry activated".
 *
 * This module measures the missing half, using the page's own pieces:
 *
 *   * the **boot injections** the Host writes into the page
 *     (`bootInjections()` from `@deepseek-ai/dsh-client-modules`): the inline registration queue
 *     that installs `window.__ModuleLoader__`, and the blocking bootstrap scripts;
 *   * those scripts' **served bytes**, fetched through the Host registry's own `fetchBundle` — the
 *     same code path the page's `<script src>` reaches over HTTP, so what is evaluated here is what
 *     the browser would have executed;
 *   * `createClientModuleSystem` and `ClientEntries`, from the bootstrap module itself — the same
 *     call the shell's `window.__ModuleLoader__.create({ boot, staticModules, loadBundle })` makes,
 *     including the audit that decides whether the page boots;
 *   * **Cordis and its Loader**, so each entry is a real fiber whose `inject` is the bundle's own
 *     `inject`, and "active" means the runtime's own `FiberState.ACTIVE`.
 *
 * # What is stubbed, and why that is honest
 *
 * The *platform seeds* are stubs: a React stand-in for `require('react')` (activation never renders),
 * a slot-registry stand-in for the `slots` service the shell provides from its seed table, and no
 * `document` at all — the bundles' own `typeof document` guards then skip stylesheet installation.
 * Those are the shell's half of the contract, not this package's. None of them can make a broken
 * bundle look healthy, because the failure this exists to catch happens in Cordis, against the
 * entry's real `inject`, before a stub is consulted.
 *
 * A browser is still the only thing that proves the page mounts; `test/helpers/dsh-page-boot.mjs` is
 * that second, independent measurement, and it is what tells us whether these stubs match the shell.
 */

import path from 'node:path';
import vm from 'node:vm';

/** Fiber states, by the numbers Cordis uses; the shell's audit uses the same table. */
const STATE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: 'disposed', 5: 'unloading' };

/** How long the mounted tree may take to settle before this module calls the entry unsettled. */
const SETTLE_TIMEOUT_MS = 30_000;

/**
 * The React stand-in handed to `require('react')`.
 *
 * Activation registers a component, it never renders one, so no hook here is called; every member
 * the bundle names is present so a missing one cannot be mistaken for a bundle defect.
 */
const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('React.Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial ?? null }),
};

/**
 * Whether an absolute bundle path belongs to the profile (this package) rather than to the install.
 *
 * The installation ships dozens of client packages of its own; mounting those needs the real shell,
 * the real React and a document. The packages under test are the ones the profile installed.
 *
 * @param {string|undefined} bundlePath - absolute path of a client bundle.
 * @param {string} profileDir - the profile directory being booted.
 * @returns {boolean}
 */
function belongsToProfile(bundlePath, profileDir) {
  if (typeof bundlePath !== 'string') return false;
  const relative = path.relative(profileDir, bundlePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Narrow the composed graph to the rows under test.
 *
 * The parser requires every entry to belong to exactly one initial-load batch, so the batches are
 * narrowed with the entries. Rows keep their own id, rev and URL: the bytes still come from the Host.
 *
 * @param {object} graph - the composed graph the Host serves as `window.__DSH_BOOT__`.
 * @param {object[]} rows - the entries to keep.
 * @returns {object} a graph carrying only those rows.
 */
function narrowGraph(graph, rows) {
  const ids = new Set(rows.map((row) => row.id));
  return {
    rev: graph.rev,
    entries: rows,
    batches: graph.batches
      .map((batch) => ({ ...batch, entries: batch.entries.filter((id) => ids.has(id)) }))
      .filter((batch) => batch.entries.length > 0),
  };
}

/**
 * Fetch one bundle's served bytes from the Host registry — the Host's own bundle server, not disk.
 *
 * @param {object} registry - the live `clientModules` service.
 * @param {string} url - the URL the page would have requested.
 * @returns {Promise<string>} the response body.
 */
async function fetchServed(registry, url) {
  const response = await registry.fetchBundle({ method: 'GET', url });
  if (response.status !== 200) throw new Error(`the client bundle host answered ${String(response.status)} for ${url}`);
  return response.text();
}

/**
 * Activate every client entry this profile's own packages contribute, and report what settled.
 *
 * @param {object} options
 * @param {string} options.packages - file: URL of the installation's `dsh/node_modules`.
 * @param {object} options.registry - the live `clientModules` service from the booted host tree.
 * @param {string} options.profileDir - the profile directory whose packages are under test.
 * @returns {Promise<{mounted: string[], entries: object[], seats: string[], skipped: string|null}>}
 */
export async function activateClientEntries({ packages, registry, profileDir }) {
  const graph = registry.graph();
  const owned = graph.entries.filter((row) => belongsToProfile(registry.clientPath(row.id), profileDir));
  if (owned.length === 0) {
    return { mounted: [], entries: [], seats: [], skipped: 'this profile contributes no client bundle of its own' };
  }

  const hostHalf = await import(`${packages}/@deepseek-ai/dsh-client-modules/lib/index.js`);
  const injections = hostHalf.bootInjections(graph);
  const queueRow = injections.find((row) => row.kind === 'script');
  const bootstrapRows = injections.filter((row) => row.kind === 'script-src');
  if (queueRow === undefined) throw new Error('the Host composed no registration-queue injection for the page');

  // One page-shaped realm: every script shares the `window` the queue installs, as in a document.
  const sandbox = { window: {}, console };
  const realm = vm.createContext(sandbox);
  vm.runInContext(queueRow.text, realm, { filename: 'dsh-client-modules:queue.js', timeout: 5_000 });

  // The blocking bootstrap scripts, in the Host's own order, from the Host's own bytes.
  for (const row of bootstrapRows) {
    const source = await fetchServed(registry, row.src);
    vm.runInContext(source, realm, { filename: row.src, timeout: 5_000 });
  }

  const facade = sandbox.window.__ModuleLoader__;
  if (typeof facade?.create !== 'function') throw new Error('the registration queue did not install window.__ModuleLoader__.create');

  // The shell's own call. `staticModules` is the platform seed table, stubbed at its boundary.
  const modules = facade.create({
    boot: narrowGraph(graph, owned),
    staticModules: {
      react: REACT_STUB,
      'react/jsx-runtime': { jsx: REACT_STUB.createElement, jsxs: REACT_STUB.createElement },
    },
    loadBundle: async (url) => {
      const source = await fetchServed(registry, url);
      vm.runInContext(source, realm, { filename: url, timeout: 5_000 });
    },
  });

  // The seat service the shell provides from its seed table. What is registered into it is the
  // positive half of the assertion: an entry that activates without taking its seat has not arrived.
  const seats = [];
  const slotRegistry = {
    inject(key, callback) {
      callback();
      seats.push(key);
      return () => {};
    },
    register: (options) => ({ options }),
  };

  const cordis = await import(`${packages}/@deepseek-ai/cordis/lib/index.js`);
  const loaderPackage = await import(`${packages}/@deepseek-ai/cordis-plugin-loader/lib/index.js`);
  const root = new cordis.Context();
  // The Loader publishes itself as a service while its fiber loads, so the mount is awaited before
  // the service is read — the same order the shell's own boot uses.
  await root.plugin(loaderPackage.default ?? loaderPackage.Loader);
  root.provide('slots', slotRegistry);
  const loader = root.get('loader');
  if (loader === undefined) throw new Error('the Cordis Loader did not publish itself as `loader`');
  loader.internal = modules;

  let unsettled = false;
  let entries = [];
  try {
    await Promise.race([
      (async () => {
        await modules.entries.start(loader, modules.manifest);
        await loader.await();
      })(),
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          unsettled = true;
          resolve();
        }, SETTLE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    // Read the tree *before* teardown: disposal resets every fiber, so a report taken afterwards
    // would say `disposed` about an entry that activated perfectly well.
    entries = [...loader.entries()].map((entry) => {
      const reason = entry.fiber?.error ?? entry.fiber?._error ?? null;
      return {
        id: entry.options.id ?? null,
        module: entry.options.name ?? null,
        state: entry.fiber?.state ?? null,
        phase: unsettled ? 'unsettled' : (STATE[entry.fiber?.state] ?? 'absent'),
        error: reason === null ? null : String(reason?.message ?? reason),
      };
    });
  } finally {
    await root.fiber.dispose().catch(() => {});
  }

  return { mounted: [...owned.map((row) => row.id)], entries, seats, skipped: null };
}
