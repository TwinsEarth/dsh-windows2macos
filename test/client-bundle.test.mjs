import { readFileSync } from 'node:fs';
/**
 * Tests for the **shipped browser half** (`lib/client.js`).
 *
 * # Why this file exists
 *
 * The client bundle is hand-written source, not build output, and it is loaded by the DSH web shell
 * through `window.__ModuleLoader__.load({ id, factory })`. That makes it the one artifact in this
 * package whose failure mode is invisible to every other test here: a typo in the registration id,
 * a `require` of a module the platform seed table does not hold, or a factory that throws on
 * materialization would compile, lint, pass `node --test`, and only ever show up as a composer with
 * no control in it.
 *
 * So the bundle is loaded here for real, against a stand-in module loader, and four things are
 * asserted:
 *
 *   1. **The entry shape is what the module system expects** — one `load()` call, the id equal to
 *      the package name (the boot graph addresses the row by package), and a factory that returns an
 *      object carrying `apply`.
 *   2. **The service contract holds** — every Cordis service the mounted body reads is declared in
 *      the exported `inject`, measured by mounting it behind a context that enforces Cordis's own
 *      rule (an undeclared service read throws). See "the activation contract" below: that rule is
 *      what took the whole app down in v0.5.5, and the fake `ctx` that used to live here was
 *      *more forgiving than the runtime* precisely where the runtime was fatal.
 *   3. **The registration is the seat the task requires** — announced through `slots.inject` on
 *      `conversation.input.left` and registered there with a unique id and a positive order, so it
 *      lands to the *right* of the shipped permission control rather than competing with it.
 *   4. **The stylesheet is installed once and owned** — a second `apply` in the same document must
 *      not add a second `<style>`, and the disposer handed to `ctx.effect` must remove the one tag
 *      it added. A control that leaks a stylesheet per page load is a page that slowly rots.
 *
 * React is stubbed and nothing is rendered: the pixels are the GUI observation's business. What this
 * file covers is everything that would stop the control from ever rendering — the entry shape, the
 * service contract, the seat, the injection contract, and the stylesheet's lifecycle. It is a
 * **bundle-loading test, not a renderer**: no attempt is made to emulate a React tree or a browser.
 *
 * `W2M_CLIENT_BUNDLE=<path>` points every load at another copy of the bundle — the same file with a
 * candidate fix, or a preserved release artifact. That is how the assertions below were proved in
 * both directions (they fail on the v0.5.5 tarball's bundle and pass here).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { TARGET_ROUTE_PATH } from '../src/plugin/fleet-target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * The bundle under test: the tree's own, or the copy `W2M_CLIENT_BUNDLE` names.
 *
 * The override exists so the two-direction proof is reproducible without editing the tree: point it
 * at the bundle extracted from a preserved tarball and the activation assertions below must fail.
 */
const BUNDLE_PATH = process.env.W2M_CLIENT_BUNDLE === undefined || process.env.W2M_CLIENT_BUNDLE === ''
  ? path.join(HERE, '..', 'lib', 'client.js')
  : path.resolve(process.env.W2M_CLIENT_BUNDLE);

/** The slot the control occupies, and the seat the task forbids it from touching. */
const SEAT = 'conversation.input.left';
const FORBIDDEN_SEAT = 'conversation.input.permission';

/** The Cordis members every context has without declaring them (accessors and methods). */
const CORE_MEMBERS = {
  effect: (callback) => {
    const disposer = callback();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  inject: () => ({ then: () => {} }),
  plugin: () => ({ then: () => {} }),
  on: () => () => {},
  get: () => undefined,
  logger: { error: () => {}, info: () => {}, warn: () => {} },
};

/**
 * Load `lib/client.js` the way the module system does.
 *
 * The bundle is a **script**, not a module: it registers itself on `window.__ModuleLoader__` and
 * expects `window`, `document`, `require`, `console` and `module` to exist. `node:vm` is how a test
 * can run it with exactly those bindings and no network, instead of the `Function` constructor
 * ESLint (rightly) refuses.
 *
 * @param {{document?: object|null, requireImpl?: (specifier: string) => unknown}} [options]
 * @returns {{loads: object[], exports: object, module: object, window: object, document: object|null, consoleErrors: string[]}}
 */
function loadBundle(options = {}) {
  const source = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const loads = [];
  const window = {
    __ModuleLoader__: {
      load: (registration) => loads.push(registration),
    },
  };
  const hostDocument = options.document === undefined ? makeFakeDocument() : options.document;
  const requireImpl = options.requireImpl ?? ((specifier) => {
    if (specifier === 'react') return makeFakeReact();
    throw new Error(`the bundle required "${specifier}", which the platform seed table does not hold`);
  });
  const module = { exports: {} };
  const consoleErrors = [];
  // The bundle's own diagnostics go to the console at error level; recording them here is how the
  // "a failure says what happened" assertion below can read them.
  const hostConsole = {
    error: (...args) => consoleErrors.push(args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')),
    warn: () => {},
    log: () => {},
  };
  const context = vm.createContext({
    window,
    document: hostDocument,
    require: requireImpl,
    module,
    exports: module.exports,
    console: hostConsole,
    ...options.globals,
  });
  // The filename is only for stack traces; `timeout` bounds a bundle that loops forever.
  vm.runInContext(source, context, { filename: BUNDLE_PATH, timeout: 5_000 });
  assert.equal(loads.length, 1, 'a client bundle must register exactly one factory');
  const exports = loads[0].factory(requireImpl);
  return { loads, exports, module, window, document: hostDocument, consoleErrors };
}

/**
 * A context that enforces Cordis's service rule, instead of ignoring it.
 *
 * This is the whole lesson of the v0.5.5 outage in one function. A plain object returns `undefined`
 * for a service the plugin never declared, so **every** fake-`ctx` test in this repository was blind
 * to the defect by construction: the bundle shipped with `inject = []` while reading `ctx.locale`,
 * the real context threw `cannot get property "locale" without inject` inside `apply`, the entry
 * ended `failed`, and the web shell refuses to boot when any entry is not active. The app did not
 * start, twice.
 *
 * So this stand-in is deliberately *stricter* than the runtime in that one place: a read of an
 * undeclared service throws the runtime's own message. It hands over every declared service, and it
 * models `ctx.get(name)` as Cordis does — the inject-free lookup that returns `undefined` rather
 * than throwing, which is what makes an optional carrier (the locale service) safe to read.
 *
 * @param {{inject?: string[], services?: object, extra?: object}} [options]
 * @returns {object} the proxy context.
 */
function makeStrictContext(options = {}) {
  const declared = new Set(options.inject ?? []);
  const services = options.services ?? {};
  const target = {
    ...CORE_MEMBERS,
    // Cordis's inject-free lookup: no declaration, no throw, `undefined` when absent.
    get: (name) => services[name],
    ...options.extra,
  };
  return new Proxy(target, {
    get: (receiver, property) => {
      if (typeof property === 'symbol' || Reflect.has(receiver, property)) return Reflect.get(receiver, property);
      if (declared.has(property)) {
        if (!(property in services)) {
          throw new Error(`cannot get required service "${property}" in inactive context`);
        }
        return services[property];
      }
      throw new Error(`cannot get property "${property}" without inject`);
    },
  });
}

/** A slot registry stand-in with the two methods the bundle uses. */
function makeRegistry() {
  const announced = [];
  const registered = [];
  return {
    announced,
    registered,
    inject(key, callback) {
      announced.push(key);
      registered.push(callback());
      return () => {};
    },
    register(options, component) {
      return { options, component };
    },
  };
}

/** A locale-service stand-in: `register` hands back the unregister disposer, `bind` a translator. */
function makeLocale(dicts = new Map()) {
  return {
    registered: dicts,
    register(namespace, dictionary) {
      dicts.set(namespace, dictionary);
      return () => dicts.delete(namespace);
    },
    bind(namespace) {
      return (key) => Object.values(dicts.get(namespace) ?? {})[0]?.[key] ?? key;
    },
  };
}

/** A React stand-in carrying only what the bundle actually calls. */
function makeFakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial ?? null }),
  };
}

/** A `document` stand-in that records what the bundle appends and removes. */
function makeFakeDocument() {
  const bySelector = new Map();
  const appended = [];
  const removed = [];
  const document = {
    head: {
      appendChild: (tag) => {
        appended.push(tag);
        bySelector.set(`style[data-plugin-css="${tag.dataset.pluginCss}"]`, tag);
        return tag;
      },
    },
    querySelector: (selector) => bySelector.get(selector) ?? null,
    createElement: (tagName) => ({
      tagName: tagName.toUpperCase(),
      dataset: {},
      textContent: '',
      remove: () => {
        removed.push(tagName);
        bySelector.delete(`style[data-plugin-css="${bySelector.size === 0 ? '' : ''}"]`);
      },
    }),
    appended,
    removed,
  };
  return document;
}

// ---------------------------------------------------------------------------------------------
// The entry shape
// ---------------------------------------------------------------------------------------------

describe('client bundle: the module-system entry', () => {
  it('registers one factory whose id is the package name', () => {
    const { loads } = loadBundle();
    const registration = loads[0];
    assert.equal(registration.id, '@twinsearth/w2m-dsh-plugin');
    assert.equal(typeof registration.factory, 'function', 'the module system calls factory(require)');
  });

  it('requires only React, which the platform seed table holds', () => {
    const required = [];
    loadBundle({
      requireImpl: (specifier) => {
        required.push(specifier);
        if (specifier === 'react') return makeFakeReact();
        throw new Error(`unexpected require: ${specifier}`);
      },
    });
    assert.deepEqual(required, ['react'], 'no third-party or host package may be required');
  });

  it('exports apply and an inject list, and no service beyond that', () => {
    const { exports } = loadBundle();
    assert.equal(typeof exports.apply, 'function');
    // Array.isArray rather than deepEqual: the bundle ran in its own vm realm, where `[]` has that
    // realm's Array prototype and a cross-realm deepEqual would be asserting the wrong thing.
    assert.ok(Array.isArray(exports.inject), 'the plugin declares an inject list');
  });

  it('does nothing at all at module scope except register the factory', () => {
    // A factory that renders, fetches or touches the DOM before it is materialized would run in
    // every page that merely *lists* the plugin.
    const fakeDocument = makeFakeDocument();
    const { loads } = loadBundle({ document: fakeDocument });
    assert.equal(loads.length, 1);
    assert.deepEqual(fakeDocument.appended, [], 'style injection belongs to apply(), not the factory');
  });
});

// ---------------------------------------------------------------------------------------------
// Composer popup containment (DSH 0.2.2-rc.1)
// ---------------------------------------------------------------------------------------------

describe('client bundle: composer popup containment', () => {
  it('portals popup menus to document.body when react-dom is available', () => {
    const document = makeFakeDocument();
    document.body = {};
    const menu = { type: 'menu' };
    const bundle = loadBundle({
      document,
      requireImpl: (specifier) => {
        if (specifier === 'react') return makeFakeReact();
        if (specifier === 'react-dom') {
          return { createPortal: (child, container) => ({ child, container }) };
        }
        throw new Error(`unexpected require(${specifier})`);
      },
    });
    const portaled = bundle.exports.portalNode(menu);
    assert.equal(portaled.child, menu);
    assert.equal(portaled.container, document.body);
  });

  it('keeps the inline menu when no document or react-dom is present', () => {
    const bundle = loadBundle();
    const menu = { type: 'menu' };
    assert.equal(bundle.exports.portalNode(menu), menu);
  });
});

// ---------------------------------------------------------------------------------------------
// The activation contract
// ---------------------------------------------------------------------------------------------
//
// This block is the one that would have caught v0.5.5 before it shipped, and the one that has to
// keep failing on the artifact it did ship. Cordis resolves `ctx.<name>` against the fiber's inject
// list: an undeclared service read *throws*, the entry ends `failed`, and the web shell treats a
// single failed entry as fatal (`web boot: 1 entry did not activate`) — the app does not start.
// Measured in a real browser against the shipped 0.5.5 bundle:
//
//   w2m-client-probe: apply threw for @twinsearth/w2m-dsh-plugin: cannot get property "locale" without inject
//   Error: web boot: 1 entry did not activate
//   @twinsearth/w2m-dsh-plugin: failed

describe('client bundle: the activation contract', () => {
  it('declares the seat service it reads, and only the services it may require', () => {
    const { exports } = loadBundle();
    const declared = [...exports.inject];
    assert.ok(declared.includes('slots'), 'the control registers into the slot registry, so it must declare it');
    // `locale` is an *optional* carrier: every declared name is a required dependency, and an entry
    // waiting on a service the composition does not provide never activates either — the audit
    // reports it as `pending`, which is just as fatal as `failed`. It is read with `ctx.get`.
    assert.equal(declared.includes('locale'), false, 'an optional carrier must not become a required dependency');
  });

  it('mounts behind a context that enforces the inject rule, with the services it declares', () => {
    const { exports } = loadBundle();
    const registry = makeRegistry();
    const locale = makeLocale();
    const ctx = makeStrictContext({
      inject: [...exports.inject],
      services: { slots: registry, locale },
    });
    assert.doesNotThrow(
      () => exports.apply(ctx),
      'an undeclared service read throws in Cordis and takes the whole app down; the bundle must read only what it declares',
    );
    assert.deepEqual(registry.announced, [SEAT, SEAT, 'sidebar.panellist', 'main', 'settings.section', 'settings.section', 'plugins.bundle.config', SEAT, SEAT, 'conversation.composer.dock', 'conversation.session.header.actions', 'conversation.view', 'shell.bottom', SEAT, 'settings.section', 'sidebar.panellist', 'main', SEAT], 'the entry still has to take its seat');
    assert.equal(registry.registered.length, 18);
    assert.equal(locale.registered.has('w2m.target'), true, 'the dictionaries go to the locale service when there is one');
  });

  it('mounts without a locale service at all, and says which strings it falls back to', () => {
    const { exports } = loadBundle();
    const registry = makeRegistry();
    const ctx = makeStrictContext({ inject: [...exports.inject], services: { slots: registry } });
    assert.doesNotThrow(() => exports.apply(ctx), 'a composition without a locale service must still get the control');
    const injected = registry.registered[0].options.inject('sess-1');
    assert.equal(injected.t('all'), '全部机器', 'the built-in dictionary is the fallback');
    // With no locale service, the registration waits on a child fiber rather than blocking the entry.
    assert.equal(typeof ctx.inject, 'function');
  });

  it('reads the optional locale service without the inject requirement', () => {
    const { exports } = loadBundle();
    const registry = makeRegistry();
    const lookups = [];
    const locale = makeLocale();
    const ctx = makeStrictContext({
      inject: [...exports.inject],
      services: { slots: registry, locale },
      extra: {
        get: (name) => {
          lookups.push(name);
          return name === 'locale' ? locale : undefined;
        },
      },
    });
    exports.apply(ctx);
    assert.ok(lookups.includes('locale'), 'the optional carrier is read with ctx.get(name), never as ctx.locale');
  });

  it('is a no-op, not a throw, when the context has no slot registry', () => {
    // The seat is the one thing this control cannot work without. A context that offers no registry
    // must cost the operator the control, never the page: an uncaught throw here fails the entry,
    // and one failed entry is fatal to the whole web boot.
    const { exports, consoleErrors } = loadBundle();
    const effects = [];
    const ctx = { effect: (callback) => effects.push(callback), get: () => undefined };
    assert.doesNotThrow(() => exports.apply(ctx));
    assert.equal(effects.length, 0, 'nothing to own when nothing was mounted');
    assert.equal(consoleErrors.length, 1, 'the skipped control is stated, not swallowed');
    assert.match(consoleErrors[0], /@twinsearth\/w2m-dsh-plugin/);
    assert.match(consoleErrors[0], /no slot registry/);
  });

  it('reports a failed activation with its cause, and still fails', () => {
    // The shell's audit prints the entry's name and the word "failed" and nothing else, so the cause
    // has to travel on the renderer console — the error-level channel the desktop crash log already
    // captures. Swallowing the error instead would boot a healthy-looking page with no control.
    const { exports, consoleErrors } = loadBundle();
    const broken = makeStrictContext({
      inject: [...exports.inject],
      services: {
        slots: {
          inject: () => {
            throw new Error('the seat refused the entry');
          },
          register: () => ({}),
        },
      },
    });
    assert.throws(() => exports.apply(broken), /the seat refused the entry/);
    assert.equal(consoleErrors.length, 1);
    assert.match(consoleErrors[0], /@twinsearth\/w2m-dsh-plugin/);
    assert.match(consoleErrors[0], /the seat refused the entry/);
  });
});

// ---------------------------------------------------------------------------------------------
// The seat
// ---------------------------------------------------------------------------------------------

describe('client bundle: the seat it registers into', () => {
  /** Apply the bundle against a recording slot registry. */
  function applyTo() {
    const announced = [];
    const registered = [];
    const effects = [];
    const ctx = {
      slots: {
        inject(key, callback) {
          announced.push(key);
          registered.push(callback());
          return () => {};
        },
        register(options, component) {
          return { options, component };
        },
      },
      effect: (callback) => {
        effects.push(callback);
        return () => {};
      },
    };
    const { exports } = loadBundle();
    exports.apply(ctx);
    return { announced, registered, effects };
  }

  it('announces and registers all five composer controls plus the sidebar and update sections into conversation.input.left', () => {
    const { announced, registered } = applyTo();
    assert.deepEqual(announced, [SEAT, SEAT, 'sidebar.panellist', 'main', 'settings.section', 'settings.section', 'plugins.bundle.config', SEAT, SEAT, 'conversation.composer.dock', 'conversation.session.header.actions', 'conversation.view', 'shell.bottom', SEAT, 'settings.section', 'sidebar.panellist', 'main', SEAT]);
    assert.equal(registered.length, 18);
    assert.equal(registered[0].options.name, SEAT);
  });

  it('never registers into the shipped permission seat', () => {
    const { announced, registered } = applyTo();
    assert.equal(announced.includes(FORBIDDEN_SEAT), false, 'that seat is single and shadows shipped UI');
    for (const entry of registered) assert.notEqual(entry.options.name, FORBIDDEN_SEAT);
  });

  it('registers with a unique id, a positive order and a label', () => {
    const { registered } = applyTo();
    const { options, component } = registered[0];
    assert.equal(options.id, 'w2m-target', 'a list slot keys its cells by id');
    assert.ok(Number.isFinite(options.order) && options.order > 0, 'order decides where in the row it lands');
    assert.equal(typeof options.label, 'string');
    assert.equal(typeof component, 'function', 'the occupant is a component');
  });

  it('passes the session id and a translator through inject', () => {
    const { registered } = applyTo();
    const injected = registered[0].options.inject('sess-42');
    assert.equal(injected.sessionId, 'sess-42', 'the session id is what makes the selection per-session');
    assert.equal(typeof injected.t, 'function', 'visible copy goes through the locale seam');
    assert.equal(injected.t('all'), '全部机器', 'and it works without a locale service');
    assert.equal(injected.t('costOne', { name: 'macmini' }), '本次会话的派发会送到 macmini');
    assert.deepEqual(Object.keys(injected), ['sessionId', 't']);
  });

  it('hands the stylesheet and the dictionaries to ctx.effect so unloading removes them', () => {
    const { effects } = applyTo();
    assert.ok(effects.length >= 1, 'the stylesheet at minimum is an owned side effect');
    for (const effect of effects) {
      const disposer = effect();
      assert.ok(typeof disposer === 'function' || disposer === undefined, 'an effect returns its cleanup or nothing');
    }
  });

  it('survives a host without ctx.effect instead of refusing to load', () => {
    const registered = [];
    const ctx = {
      slots: {
        inject: (_key, callback) => registered.push(callback()),
        register: (options, component) => ({ options, component }),
      },
    };
    const { exports } = loadBundle();
    assert.doesNotThrow(() => exports.apply(ctx));
    assert.equal(registered.length, 18);
  });
});

// ---------------------------------------------------------------------------------------------
// The declaration the host scans
// ---------------------------------------------------------------------------------------------

/**
 * What a host needs before it will ever fetch this bundle.
 *
 * Cheap, always-on counterpart to `test/loader-entry.test.mjs`: that file boots a real Harness and is
 * therefore skipped where none is installed, while these three declarations are what it depends on —
 * and the third one is the one v0.5.4 got wrong. The client module system identifies a package by the
 * specifier its Loader row carries (`exactPackageSpecifier` in `@deepseek-ai/dsh-client-modules`), so a
 * `/tools` row resolves to no manifest, no `dsh.client` declaration is read, and the browser half is
 * never composed — silently, with the host plugin still working. Measured on the v0.5.4 tarball: the
 * composed boot graph held rows for two other packages and none for this one.
 */
describe('client bundle: the declaration a host scans', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const patch = fs
    .readFileSync(path.join(HERE, '..', 'cordis.patch.yml'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));

  it('declares dsh.client for the web platform', () => {
    assert.equal(manifest.dsh?.client?.platform, 'web', 'without this the host never looks for a bundle');
  });

  it('exports the bundle at ./client, which is the path the host reads', () => {
    assert.equal(manifest.exports?.['./client'], './lib/client.js');
    assert.ok(fs.existsSync(BUNDLE_PATH), `the declared bundle is missing: ${BUNDLE_PATH}`);
  });

  it('is mounted by its package name, not a subpath, or the host cannot find the manifest', () => {
    const mounted = patch.map((line) => /^\s*name:\s*'([^']+)'\s*$/.exec(line)).find(Boolean);
    assert.ok(mounted !== undefined, 'cordis.patch.yml must still name the module it mounts');
    assert.equal(
      mounted[1],
      manifest.name,
      'the Loader row must carry the bare package specifier: a subpath (`…/tools`) resolves to no ' +
        'package.json, so `@deepseek-ai/dsh-client-modules` never composes this package’s client half',
    );
  });

  it('fetches the exact path the host registers, `/api` channel included', () => {
    // The host's Connection service mounts its fetch-route registry under `/api` and refuses any
    // other prefix, so a browser half that fetches `/w2m/target` while the host registers
    // `/api/w2m/target` is a control that 404s forever. Two constants, one path: they are compared
    // rather than trusted.
    const route = /const ROUTE = '([^']+)'/.exec(fs.readFileSync(BUNDLE_PATH, 'utf8'));
    assert.ok(route !== null, 'the bundle must name the route it fetches');
    assert.equal(route[1], TARGET_ROUTE_PATH);
    assert.ok(TARGET_ROUTE_PATH.startsWith('/api/'), 'the registry accepts only /api/… exact routes');
  });
});

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------

describe('client bundle: the stylesheet', () => {
  it('installs one style tag and removes exactly that tag', () => {
    const { exports } = loadBundle();
    const document = makeFakeDocument();
    const dispose = exports.injectStyle(document);
    assert.equal(document.appended.length, 1);
    assert.equal(document.appended[0].dataset.plugin, '@twinsearth/w2m-dsh-plugin');
    assert.match(document.appended[0].textContent, /w2mTarget_trigger/);
    assert.equal(typeof dispose, 'function');
    dispose();
    assert.deepEqual(document.removed, ['style']);
  });

  it('is idempotent per document, so two instances cannot stack stylesheets', () => {
    const { exports } = loadBundle();
    const document = makeFakeDocument();
    exports.injectStyle(document);
    const second = exports.injectStyle(document);
    assert.equal(document.appended.length, 1);
    assert.equal(second, null, 'the second call owns nothing, so it must not return a disposer');
  });

  it('styles with the shell theme tokens rather than its own colours', () => {
    const { exports } = loadBundle();
    const document = makeFakeDocument();
    exports.injectStyle(document);
    const css = document.appended[0].textContent;
    for (const token of [
      '--dsw-radius-sm',
      '--dsw-alias-label-secondary',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-state-business-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-alias-state-idle-primary',
    ]) {
      assert.ok(css.includes(`var(${token}`), `the control must style with ${token}`);
    }
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'no literal colours: they would be wrong in one theme');
  });

  it('matches the shipped control geometry in the same row', () => {
    const { exports } = loadBundle();
    const document = makeFakeDocument();
    exports.injectStyle(document);
    const css = document.appended[0].textContent;
    // The permission trigger next to it is 28px tall, radius-sm, 13px/500, gap 4px, pad 0 4px 0 8px.
    assert.match(css, /height:28px/);
    assert.match(css, /font-size:13px/);
    assert.match(css, /font-weight:500/);
    assert.match(css, /gap:4px/);
  });

  it('does not touch a document it was not given', () => {
    const { exports } = loadBundle();
    assert.equal(exports.injectStyle(null), null);
    assert.equal(exports.injectStyle(undefined), null);
  });

  it('board shows the four bucket counts and reads the host proxy (v1.2.11)', () => {
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    assert.ok(source.includes("className: 'w2mChat_boardCounts'"), 'the counts line exists');
    assert.ok(source.includes("/api/w2m/tasks?limit=20"), 'the board reads the relay through the host proxy');
    assert.ok(source.includes('准备'), 'the counts are labelled for the operator');
  });
});

it('searches the whole conversation after 1s (v2.2.6)', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(
    source.includes('paintRef.current(true); }, 1000);'),
    'search waits 1s after the last keystroke (v2.0.5 waited 3s, which read as "search does nothing")',
  );
  assert.ok(!source.includes('function viewportRect'), 'no viewport-only filter: a scrolled-out match is still a match');
  assert.ok(
    !source.includes("addEventListener('scroll', onScroll, true)"),
    'marks persist after a query settles, so scrolling no longer repaints them',
  );
  assert.ok(source.includes('const SEARCH_MAX_MARKS = 120;'), 'the wrap cap bounds paint cost, not the count');
  assert.ok(source.includes('return ranges.length;'), 'the count is every match, not only the wrapped ones');
  assert.ok(source.includes('function searchQueryAllowed'), 'pure numbers <= 100 are refused');
  assert.ok(source.includes('function isLoadingEarlier()'), 'the scroll control can see the loading row');
  assert.ok(source.includes('await waitForLoadSettled();'), 'the top button waits for in-flight history instead of re-pressing');
  assert.ok(source.includes('if (stagnant >= 2) break;'), 'two pages that add nothing end the loop instead of spinning');
});

// ---------------------------------------------------------------------------------------------
// The @machine handle a target click writes into the composer
// ---------------------------------------------------------------------------------------------

describe('client bundle: target @mention planning', () => {
  const { exports } = loadBundle();
  // Objects built inside the vm have that realm's prototypes; compare their plain data shape.
  const plain = (value) => JSON.parse(JSON.stringify(value));

  it('renders a plain name as @name and a spaced name as a quoted token', () => {
    assert.equal(exports.targetTokenForName('macmini'), '@macmini');
    assert.equal(exports.targetTokenForName('Mac mini'), '@"Mac mini"');
    assert.equal(exports.targetTokenForName('办公室/东区'), '@"办公室/东区"');
    assert.equal(exports.targetTokenForName('a"b'), null, 'an unescapable name gets no token');
    assert.equal(exports.targetTokenForName('   '), null, 'an empty name gets no token');
  });

  it('inserts at the caret with the spaces DSH needs to see a token boundary', () => {
    const empty = exports.planTargetMention({ draft: '', caret: { start: 0, end: 0, draftRev: 7 }, nextName: 'macmini' });
    assert.deepEqual(plain(empty), { kind: 'insert', text: '@macmini ', start: 0, end: 0, draftRev: 7 });

    const afterWord = exports.planTargetMention({ draft: 'run', caret: { start: 3, end: 3, draftRev: 8 }, nextName: 'macmini' });
    assert.deepEqual(plain(afterWord), { kind: 'insert', text: ' @macmini ', start: 3, end: 3, draftRev: 8 });

    const beforeSpace = exports.planTargetMention({ draft: 'run ', caret: { start: 4, end: 4, draftRev: 9 }, nextName: 'macmini' });
    assert.equal(beforeSpace.text, '@macmini ');
  });

  it('replaces the previous machine token instead of leaving two targets in the draft', () => {
    const plan = exports.planTargetMention({
      draft: '@alpha run this',
      caret: { start: 6, end: 6, draftRev: 3 },
      previousName: 'alpha',
      nextName: 'beta',
    });
    assert.deepEqual(plain(plan), { kind: 'replace', text: '@beta', start: 0, end: 6, draftRev: 3 });
  });

  it('clears the token when the target is cleared, and never duplicates an existing token', () => {
    assert.deepEqual(plain(exports.planTargetMention({
      draft: '@alpha run this',
      caret: { start: 6, end: 6, draftRev: 4 },
      previousName: 'alpha',
      nextName: null,
    })), { kind: 'remove', start: 0, end: 7, draftRev: 4 });

    assert.deepEqual(plain(exports.planTargetMention({
      draft: 'look @beta',
      caret: { start: 9, end: 9, draftRev: 5 },
      nextName: 'beta',
    })), { kind: 'present' });

    assert.deepEqual(plain(exports.planTargetMention({
      draft: '@alpha and @beta',
      caret: { start: 15, end: 15, draftRev: 6 },
      previousName: 'alpha',
      nextName: 'beta',
    })), { kind: 'remove', start: 0, end: 7, draftRev: 6 });
  });

  it('keeps a non-collapsed selection instead of consuming the operator’s words', () => {
    const plan = exports.planTargetMention({
      draft: 'rewrite me',
      caret: { start: 0, end: 10, draftRev: 8 },
      nextName: 'beta',
    });
    assert.deepEqual(plain(plan), { kind: 'insert', text: ' @beta ', start: 10, end: 10, draftRev: 8 });
  });

  it('maps a token span through a reference chip (clipboard offsets vs editor offsets)', () => {
    // Clipboard "chipped @alpha": the chip's clipboard text is 7 chars but one editor glyph.
    const plan = exports.planTargetMention({
      draft: 'chipped @alpha',
      occurrences: [{ offset: 0, length: 7 }],
      caret: { start: 9, end: 9, draftRev: 2 },
      previousName: 'alpha',
      nextName: null,
    });
    assert.deepEqual(plain(plan), { kind: 'remove', start: 2, end: 8, draftRev: 2 });
  });
});

/**
 * A minimal hook-capable React stand-in for one component.
 *
 * `client-bundle.test.mjs` otherwise checks the bundle as a module. This one test executes the real
 * `TargetSelect` function, clicks the real trigger and the real machine row, and inspects the editor
 * action the control calls — the half that a pure `planTargetMention` unit test cannot prove.
 */
function makeHookReact() {
  const hooks = [];
  let index = 0;
  let pending = [];
  let dirty = false;
  const fakeNode = {
    getBoundingClientRect: () => ({ left: 10, top: 700, width: 120, right: 130, bottom: 720 }),
    contains: () => false,
    focus: () => {},
  };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const resolved = props ?? {};
      if (resolved.ref !== null && resolved.ref !== undefined && resolved.ref.current == null) {
        resolved.ref.current = fakeNode;
      }
      return { type, props: resolved, children };
    },
    useState(initial) {
      const at = index++;
      if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial;
      return [hooks[at], (next) => {
        hooks[at] = typeof next === 'function' ? next(hooks[at]) : next;
        dirty = true;
      }];
    },
    useRef(initial) {
      const at = index++;
      if (!(at in hooks)) hooks[at] = { current: initial ?? null };
      return hooks[at];
    },
    useEffect(effect, deps) {
      const at = index++;
      const previous = hooks[at];
      const changed = previous === undefined
        || deps === undefined
        || deps.length !== previous.length
        || deps.some((value, i) => !Object.is(value, previous[i]));
      if (changed) {
        hooks[at] = deps ?? [];
        pending.push(effect);
      }
    },
  };
  const render = (component, props) => {
    let tree = null;
    for (let pass = 0; pass < 30; pass += 1) {
      index = 0;
      pending = [];
      dirty = false;
      tree = component(props);
      for (const effect of pending) effect();
      if (!dirty) break;
    }
    return tree;
  };
  return { React, render };
}

/** Walk the element tree the stand-in renderer returns (arrays and `children` only). */
function findBy(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findBy(child, predicate, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) findBy(child, predicate, found);
  }
  return found;
}

describe('client bundle: selecting a machine writes the @mention', () => {
  it('clicks a machine row and asks the editor for one insertion at the caret', async () => {
    const machines = [
      { machine_id: 'a', name: 'alpha', online: true, local: true, os: 'win32', state: 'online' },
      { machine_id: 'b', name: 'beta', online: true, local: false, os: 'darwin', state: 'online' },
    ];
    let state = {
      selected: { machine_id: null, name: null, online: null, stale: false },
      machines,
      fleet: { ok: true, online: 2, total: 2 },
      relays: null,
    };
    let posted = null;
    const hostFetch = async (url, init = {}) => {
      if (init.method === 'POST') {
        posted = JSON.parse(init.body);
        const picked = machines.find((machine) => machine.machine_id === posted.machine_id) ?? null;
        state = {
          ...state,
          selected: picked === null
            ? { machine_id: null, name: null, online: null, stale: false }
            : { machine_id: picked.machine_id, name: picked.name, online: true, stale: false },
        };
      }
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const document = {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const { React, render } = makeHookReact();
    const bundle = loadBundle({
      requireImpl: (specifier) => {
        if (specifier === 'react') return React;
        throw new Error(`unexpected require(${specifier})`);
      },
      document,
      globals: { fetch: hostFetch, AbortController, Response },
    });
    bundle.window.innerWidth = 1_200;
    bundle.window.innerHeight = 800;
    bundle.window.addEventListener = () => {};
    bundle.window.removeEventListener = () => {};

    const edits = [];
    const inputState = { draft: '', occurrences: [], phase: 'idle' };
    const inputActions = {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
      insertText: (text, span) => { edits.push({ text, span }); return true; },
    };
    const props = {
      sessionId: 'sess-ui',
      locked: false,
      t: (key) => key,
      inputActions,
      useInput: () => inputState,
    };

    const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

    let tree = render(bundle.exports.TargetSelect, props);
    await tick();
    tree = render(bundle.exports.TargetSelect, props);

    const triggers = findBy(tree, (node) => node.type === 'button'
      && String(node.props.className).includes('w2mTarget_trigger'));
    assert.equal(triggers.length, 1, 'the target control is mounted');
    triggers[0].props.onClick();

    // Opening runs two effects (reload seq and placement), and each schedules one more render.
    for (let pass = 0; pass < 3; pass += 1) {
      await tick();
      tree = render(bundle.exports.TargetSelect, props);
    }

    const rows = findBy(tree, (node) => node.type === 'button'
      && node.props.role === 'option'
      && String(node.props.title ?? '').startsWith('beta'));
    assert.equal(rows.length, 1, 'the online beta row is in the open menu');
    rows[0].props.onClick();
    await tick();
    render(bundle.exports.TargetSelect, props);

    assert.deepEqual(posted, { session_id: 'sess-ui', machine_id: 'b', machine_name: 'beta' });
    assert.deepEqual(JSON.parse(JSON.stringify(edits)), [{ text: '@beta ', span: { start: 0, end: 0, draftRev: 1 } }]);
  });
});
it('queue journal only records the official dock and real sessions (v3.2.6)', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('[class*="queue" i]'), 'no generic queue class scan: it captured drawer and page text');
  assert.ok(!source.includes('[data-testid*="pending" i]'), 'no generic pending scan either');
  assert.ok(source.includes('validSessionKey('), 'writes are gated on a real session key');
  assert.ok(source.includes("startsWith('page:')"), 'page-instance keys are refused');
  assert.ok(source.includes('data-w2m-queue-ui'), 'our own UI is marked and skipped by the capture');
});

it('the queue journal shows session titles and never session ids (v3.2.10)', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(source.includes('Session ID'), false, 'the drawer must not render a Session ID label');
  assert.equal(source.includes('w2mJqEye'), false, 'the eye toggle is gone; ids are never shown');
  assert.equal(source.includes('showIds'), false, 'no id-visibility state remains');
  assert.ok(source.includes('clientSessionTitles'), 'titles come from the client sessions service');
  assert.ok(source.includes('未知会话'), 'an unknown session shows 未知会话 instead of an id');
  assert.ok(source.includes('jqHasContent'), 'records without a draft and without queued messages are filtered out');
});

it('v3.3.0: the composer has one history button and the window shows only human inputs', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes("id: 'w2m-history'"), 'the single composer entry is the history button');
  assert.equal(source.includes("id: 'w2m-gpw-prompt'"), false, 'the inline GPW prompt entry is gone');
  assert.ok(source.includes("'.w2mTarget_trigger{display:none!important}'"), 'the legacy target control stays mounted for probes but is hidden');
  assert.ok(source.includes("'.w2mCap_trigger{display:none!important}'"), 'the capability switch is hidden');
  assert.ok(source.includes("'.w2mJqDockChip{display:none!important}'"), 'the queue dock chip is hidden');
  assert.ok(source.includes('function HistoryPanel('), 'the history window component exists');
  assert.ok(source.includes("event.type !== 'user/message'"), 'only human user messages are collected');
  assert.ok(source.includes('pendingSubmissions'), 'pending human submissions are included');
  assert.ok(source.includes('writeComposer(text)'), 'clicking an entry fills the composer');
  assert.ok(source.includes('仅人类输入'), 'the window states it shows human input only');
});
