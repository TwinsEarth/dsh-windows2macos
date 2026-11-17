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
    assert.deepEqual(registry.announced, [SEAT, SEAT, 'sidebar.panellist', 'main', 'sidebar.panellist', 'main', 'settings.section', 'settings.section', 'plugins.bundle.config', SEAT, SEAT, 'conversation.composer.dock', 'conversation.session.header.actions', 'conversation.view', 'shell.bottom', SEAT, 'settings.section', 'sidebar.panellist', 'main', SEAT], 'the entry still has to take its seat');
    assert.equal(registry.registered.length, 20);
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
    assert.deepEqual(announced, [SEAT, SEAT, 'sidebar.panellist', 'main', 'sidebar.panellist', 'main', 'settings.section', 'settings.section', 'plugins.bundle.config', SEAT, SEAT, 'conversation.composer.dock', 'conversation.session.header.actions', 'conversation.view', 'shell.bottom', SEAT, 'settings.section', 'sidebar.panellist', 'main', SEAT]);
    assert.equal(registered.length, 20);
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
    assert.equal(registered.length, 20);
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

/** Every string child of the element tree, in render order (used to read the panel's copy). */
function collectText(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, found);
    return found;
  }
  if (typeof node === 'string') {
    found.push(node);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, found);
  }
  return found;
}

/**
 * A hook-capable React stand-in that mounts one component, re-renders it, **and can unmount it**.
 *
 * {@link makeHookReact} intentionally drops cleanup functions; the backup page's 10 s poll is
 * exactly the kind of side effect a test has to be able to stop, so this one keeps each effect's
 * cleanup and hands back the unmount function. Re-rendering is what lets a test click a button,
 * let the handler's fetch promises settle, and read the rendered result. Hooks are keyed by call
 * order, which matches the component's fixed hook list.
 */
function makeMountReact() {
  const hooks = [];
  let index = 0;
  let cleanups = [];
  let pending = [];
  let dirty = false;
  let mounted = false;
  let lastTree = null;
  const runPending = () => {
    const effects = pending;
    pending = [];
    for (const effect of effects) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
  };
  const renderPass = (component, props) => {
    for (let pass = 0; pass < 60; pass += 1) {
      index = 0;
      dirty = false;
      lastTree = expandComponent(component(props));
      runPending();
      if (!dirty) break;
    }
    return lastTree;
  };
  /**
   * Render child function components the way React would.
   *
   * The page renders the pure `BackupPanelView` as a child; it uses no hooks, so expanding it here
   * cannot disturb the page's own hook order. Elements produced by `createElement` in this fake are
   * plain objects with a `type`, so a function `type` is exactly the child-component case.
   */
  const expandComponent = (node) => {
    if (Array.isArray(node)) return node.map(expandComponent);
    if (node === null || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expandComponent(node.type(node.props));
    if (Array.isArray(node.children)) return { ...node, children: node.children.map(expandComponent) };
    return node;
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
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
      if (!changed) return;
      hooks[at] = deps ?? [];
      pending.push(effect);
    },
  };
  return {
    React,
    mount(component, props) {
      index = 0;
      cleanups = [];
      pending = [];
      mounted = true;
      renderPass(component, props);
      return {
        get tree() { return lastTree; },
        rerender(nextProps = props) {
          if (mounted) renderPass(component, nextProps);
        },
        unmount() {
          if (!mounted) return;
          mounted = false;
          for (const cleanup of cleanups.reverse()) {
            try { cleanup(); } catch { /* a cleanup must not decide the test outcome */ }
          }
          cleanups = [];
        },
      };
    },
  };
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

it('v3.3.2: the history window is anchored in the composer and the original controls are restored', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes("id: 'w2m-history'"), 'the history button is the composer entry');
  assert.equal(source.includes("id: 'w2m-gpw-prompt'"), false, 'the old inline prompt entry stays retired');
  assert.equal(source.includes("'.w2mTarget_trigger{display:none"), false, 'the 全部机器 target control is visible again');
  assert.equal(source.includes("'.w2mCap_trigger{display:none"), false, 'the execution capability switch is visible again');
  assert.ok(source.includes("'.w2mJqDockChip{display:none!important}'"), 'the bottom queue dock chip stays hidden');
  assert.ok(source.includes('w2mHistWrap'), 'the history window is wrapped next to the history button');
  assert.ok(source.includes("'.w2mHistWindow{position:absolute"), 'the window is anchored above the composer, not fixed to the page bottom');
  assert.equal(source.split('}, FleetChat));').length - 1, 2, 'the fleet-chat composer panel and view tab are both back');
  assert.ok(source.includes('w2mChat_shotButton'), 'the restored fleet-chat panel is the v2.2.6 module');
  assert.ok(source.includes('全部机器'), 'the 全部机器 label is back');
  assert.ok(source.includes('pendingSubmissions'), 'the history window still lists pending human submissions');
  assert.ok(source.includes('writeComposer(text)'), 'clicking an entry fills the composer');
  assert.ok(source.includes('仅人类输入'), 'the window states it shows human input only');
});

it('v3.3.1: the sidebar opens an operation panel with the four sections', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('function W2mOpsPanel('), 'the operation panel exists');
  assert.ok(source.includes("['approvals', '智能分级&审批']"), 'approvals tab');
  assert.ok(source.includes("['queue', '消息与草稿']"), 'queue tab');
  assert.ok(source.includes("['decisions', '决策中心']"), 'decision tab');
  assert.ok(source.includes("['actions', '操作入口']"), 'actions tab');
  assert.ok(source.includes('function OpsQueueSection('), 'queue section');
  assert.ok(source.includes('function OpsDecisionSection('), 'decision section');
  assert.ok(source.includes('function OpsApprovalSection('), 'approval section');
  assert.ok(source.includes('function OpsActionsSection('), 'actions section');
  assert.ok(source.includes('function GpwAiSettings('), 'the AI settings component');
  assert.ok(source.includes('w2mAiChip'), 'the AI status chip');
  assert.ok(source.includes('模型原始返回'), 'a failed test shows the model raw reply');
  assert.ok(source.includes('测试中…'), 'the test button shows progress');
  assert.ok(source.includes('function GpwAiSettings(') && source.includes('w2mAiFeedback'), 'feedback is coloured');
  assert.ok(source.includes('w2mOpsPanel .w2mTarget_trigger'), 'the embedded target control is visible inside the ops panel');
});

it('v3.3.3: the bottom status bar keeps the two fleet ratios', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('本编队在线机器'), 'fleet machine ratio label');
  assert.ok(source.includes('在线编队 '), 'online fleets ratio label');
  assert.ok(source.includes('fleets_online') && source.includes('fleets_total'), 'the server totals read the fleets counters');
  assert.ok(source.includes('devices_online') && source.includes('devices_total'), 'the server machine ratio stays in the tooltip');
});

it('v3.3.5: parses end-of-turn choice prompts (single/multi, numbers/letters)', () => {
  const { exports } = loadBundle();
  const parse = exports.parseChoiceOptions;
  assert.equal(typeof parse, 'function');
  const numbered = parse('请选择下一步：\n1. 继续\n2. 停止\n3. 回滚');
  assert.equal((numbered?.options ?? []).map((option) => option.key).join(','), '1,2,3');
  assert.match(numbered?.question ?? '', /请选择/u);
  const letters = parse('选哪个？\nA. 方案一\nB. 方案二');
  assert.equal((letters?.options ?? []).map((option) => option.key).join(','), 'A,B');
  const multi = parse('可多选：\n[ ] 甲\n[ ] 乙\n[ ] 丙');
  assert.equal(multi?.multi, true);
  assert.equal(multi?.options?.length, 3);
  const inline = parse('请选择：1、继续 2、停止 3、回滚');
  assert.equal(inline?.options?.length, 3);
  assert.equal(parse('这是一段总结。\n- 第一点\n- 第二点'), null);
  assert.equal(parse('1. 只有一项'), null);
});

it('v3.3.5: the choice watcher mirrors prompts into the decision center and feeds the reply back', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('function installChoiceWatcher('), 'the watcher exists');
  assert.ok(source.includes("'/api/w2m/decisions/ingest'") || source.includes('api/w2m/decisions/ingest'), 'it ingests into the decision center');
  assert.ok(source.includes("event.type !== 'assistant/message'"), 'it reads the last assistant message');
  assert.ok(source.includes('本轮待选'), 'ticket title marks the pending choice');
  assert.ok(source.includes('dsh-choice:'), 'dedupe key prefix');
  assert.ok(source.includes('writeComposer(String(option?.label'), 'picking an option fills the composer');
});

it('v3.3.6: history and choice detection read the host session log and clear-all archives first', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('function sessionLogRequest('), 'the host session-log request helper exists');
  assert.ok(source.includes("/session-log?sessionId="), 'the history window queries the host session log');
  assert.ok(source.includes("'/history?limit=20'"), 'the drawer loads recoverable history snapshots');
  assert.ok(source.includes('历史快照 · '), 'the drawer shows the history snapshots section');
  assert.ok(source.includes('已归档到历史快照'), 'clear-all archives before clearing');
  const choiceStart = source.indexOf('function installChoiceWatcher(');
  const choiceEnd = source.indexOf('\n    }', choiceStart);
  const choiceBody = source.slice(choiceStart, choiceEnd);
  assert.ok(choiceBody.indexOf('sessionLogRequest(sessionId, 5)') < choiceBody.indexOf("source: 'w2m-choice-watch'"), 'choice detection asks the host log before the client service');
});

it('v3.3.9: search arrows activate a match, wrap, and center it in the real scroll surface', () => {
  const env = loadBundle();
  const document = env.document;
  document.body = undefined;
  const surface = {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 400,
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 400, bottom: 400, right: 800 }),
  };
  const makeMark = (top) => {
    const mark = {
      attrs: {},
      parentElement: surface,
      textContent: "match",
      getBoundingClientRect: () => ({ top, height: 20, bottom: top + 20, left: 0, right: 100 }),
      setAttribute(name, value) { this.attrs[name] = value; },
      getAttribute(name) { return this.attrs[name] ?? null; },
      removeAttribute(name) { delete this.attrs[name]; },
      scrollIntoView() { this.scrolled = true; },
    };
    return mark;
  };
  const marks = [makeMark(1000), makeMark(1400), makeMark(200)];
  document.querySelectorAll = (selector) => (String(selector).includes("mark.w2mSearchMark") ? marks : []);
  const activate = env.exports.activateSearchMark;
  assert.equal(typeof activate, "function");
  assert.equal(activate(0), 0);
  assert.equal(marks[0].getAttribute("data-active"), "true");
  assert.equal(marks[1].getAttribute("data-active"), null);
  assert.equal(marks[0].scrolled, true, "the active match is scrolled into view");
  assert.ok(surface.scrollTop > 0, "the real scroll surface was moved, not just the mark attribute");
  const before = surface.scrollTop;
  assert.equal(activate(1), 1, "next advances");
  assert.equal(marks[1].getAttribute("data-active"), "true");
  assert.equal(marks[0].getAttribute("data-active"), null);
  assert.ok(surface.scrollTop !== before, "the next match is centered too");
  assert.equal(activate(-1), 2, "previous wraps to the last match");
  assert.equal(marks[2].getAttribute("data-active"), "true");
});

it('v3.3.9: the search fix wires active styling and the shell scroller', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('function centerSearchMark('), 'centering helper exists');
  assert.ok(source.includes('function activateSearchMark('), 'activation helper exists');
  assert.ok(source.includes('w2mSearchMark[data-active="true"]'), 'the active match has its own style');
  assert.ok(source.includes('const base = activeRef.current >= 0 ? activeRef.current'), 'step uses the live active index, not a stale state');
  assert.ok(source.includes('function scrollableAncestors('), 'the shell scroller is discovered by walking ancestors');
});

it('v3.3.9: marks inside a shadow root are found and activated (document.querySelectorAll cannot see them)', () => {
  const env = loadBundle();
  const document = env.document;
  const surface = {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 400,
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 400, bottom: 400, right: 800 }),
  };
  const shadowMark = {
    attrs: {},
    parentElement: surface,
    getBoundingClientRect: () => ({ top: 900, height: 20, bottom: 920, left: 0, right: 100 }),
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    removeAttribute(name) { delete this.attrs[name]; },
    scrollIntoView() { this.scrolled = true; },
  };
  const shadowRoot = {
    querySelectorAll: (selector) => (String(selector).includes("mark.w2mSearchMark") ? [shadowMark] : []),
  };
  const region = { nodeType: 1, children: [], shadowRoot, querySelectorAll: () => [] };
  document.body = { nodeType: 1, children: [] };
  document.documentElement = { nodeType: 1, children: [] };
  document.querySelector = (selector) => (String(selector).includes("[data-conversation-region]") ? region : null);
  document.querySelectorAll = (selector) => (String(selector).includes("mark.w2mSearchMark") ? [] : []);
  assert.equal(env.exports.activateSearchMark(0), 0);
  assert.equal(shadowMark.getAttribute("data-active"), "true");
  assert.equal(shadowMark.scrolled, true);
});

it('v3.3.10: groups target machines into clients first and web hosts second', () => {
  const { exports } = loadBundle();
  const group = exports.groupTargetMachines;
  assert.equal(typeof group, "function");
  const machines = [
    { machine_id: "a", name: "win-desktop", os: "windows", kind: "client", online: true },
    { machine_id: "b", name: "tencent-relay", os: "linux", kind: "web", online: true },
    { machine_id: "c", name: "macmini", os: "macos", online: true },
    { machine_id: "d", name: "vultr-relay", kind: "web", online: true },
    { machine_id: "e", name: "mystery-box", online: true },
    { machine_id: "f", name: "old-win", os: "windows", online: false },
    { machine_id: "g", name: "old-relay", os: "linux", online: false },
  ];
  const grouped = group(machines);
  assert.equal(grouped.client.map((m) => m.machine_id).join(","), "a,c");
  assert.equal(grouped.web.map((m) => m.machine_id).join(","), "b,d,e");
  assert.equal(grouped.offline.map((m) => m.machine_id).join(","), "f,g");
  assert.equal(exports.targetMachineKindOf({ os: "linux" }), "web");
  assert.equal(exports.targetMachineKindOf({ name: "web-host", os: "windows" }), "web");
  assert.equal(exports.targetMachineKindOf({}), "web");
  assert.equal(exports.targetMachineKindOf({ os: "unknown" }), "web");
  assert.equal(exports.targetMachineKindOf({ os: "freebsd" }), "web");
  assert.equal(exports.targetMachineKindOf({ os: "windows" }), "client");
  assert.equal(exports.targetMachineKindOf({ os: "", kind: "client" }), "web");
});

it('v3.3.10: the target menu folds the web group by default', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('const [webOpen, setWebOpen] = React.useState(false)'), 'web group starts folded');
  assert.ok(source.includes("clientGroup: '客户端'"), 'client group label');
  assert.ok(source.includes("webGroup: 'Web端'"), 'web group label');
  assert.ok(source.includes('machineGroups.client.map(renderMachineOption)'), 'clients render first');
  assert.ok(source.includes('webOpen ? machineGroups.web.map(renderMachineOption) : []'), 'web machines only render after expanding');
  assert.ok(source.includes("cls('groupToggle')"), 'the web toggle exists');
  assert.ok(source.includes('unknownPlatform'), 'a missing platform is shown instead of hidden as online');
});

it('v3.3.14: the queue drawer splits 人类输入 from a folded 机器生成 block', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('w2mJqSectionHead'), 'the drawer renders a section header');
  assert.ok(source.includes('人类输入 · ') && source.includes('humanEntries.length'), 'human input has its own block count');
  assert.ok(source.includes("'机器生成 · ' + clientAll.length"), 'machine records have a folded block count');
  assert.ok(source.includes('const clientAll = store.state.entries.filter((entry) => !isHumanEntry(entry))'), 'machine records are counted before content filtering');
  assert.ok(source.includes("dcEl('details', { className: 'w2mJqClientFold' })"), 'the machine block is a details element (folded by default)');
});

it('v3.3.15: the target menu adds a folded offline group after clients and web hosts', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes("offlineGroup: '离线'"), 'offline group label');
  assert.ok(source.includes('const [offlineOpen, setOfflineOpen] = React.useState(false)'), 'offline starts folded');
  assert.ok(source.includes('machineGroups.offline.map(renderMachineOption)'), 'offline machines render in their own group');
  assert.ok(source.includes("key: '__offlineToggle__'"), 'the offline toggle exists');
  assert.ok(source.includes('setOfflineOpen(false)'), 'offline resets to folded on every open');
});

it('v3.3.17: the history panel defaults to newest first, with the draft pinned above it', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('function sortHistoryItems(items)'), 'one sort helper owns the history order');
  assert.ok(source.includes('setItems(sortHistoryItems(next))'), 'the loaded list goes through the sorter');
  assert.ok(source.includes('Number(right.at) - Number(left.at)'), 'timed entries are compared newest to oldest');
  assert.ok(source.includes("item?.key === 'draft'"), 'the current draft is kept outside the timestamp sort');
  assert.ok(source.includes('仅人类输入 · 从新到旧'), 'the panel says which order it uses');
});

it('v3.3.18: an empty sessionKey still counts as a human entry', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes("entry?.sessionKey || entry?.key"), 'empty sessionKey falls back to key');
  assert.ok(!source.includes("entry?.sessionKey ?? entry?.key"), 'nullish fallback would hide empty-string sessionKeys');
  assert.ok(source.includes("startsWith('session-')"), 'the human/machine split still keys off session-');
});

it('v3.4.0: a stored empty title falls back to the sessions map', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('function sessionTitleForEntry(entry, sessions)'), 'the title lookup is one helper');
  assert.ok(source.includes("const stored = String(entry?.title ?? '').trim();"), 'an empty stored title is detected before falling back');
  assert.ok(source.includes("for (const key of [bare, raw, 'session-' + bare])"), 'both raw uuid and session-<uuid> map keys are tried, bare uuid first');
  assert.ok(source.includes('sessionTitleForEntry(entry, store.state.sessions)'), 'entryCard uses the helper');
});

it('v3.4.4: each floating badge follows its own subplugin route', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('function subpluginRouteAvailable(route)'), 'one route probe');
  assert.ok(source.includes('function watchSubpluginRoute(route, onChange'), 'one availability watcher');
  assert.ok(source.includes("watchSubpluginRoute('/api/w2m/decisions'"), 'decision badge follows decision-center');
  assert.ok(source.includes("watchSubpluginRoute('/api/w2m/composer/journal?list=1'"), 'queue badge follows queue-journal');
  assert.ok(source.includes("if (alive) setAvailable(response.status !== 404);"), 'GPW launcher follows dsh-gpw');
  assert.ok(source.includes('if (available !== true) return null;'), 'GPW launcher renders nothing while disabled');
  assert.ok(source.includes('badge.hidden = !enabled;'), 'both DOM badges follow their route');
  assert.ok(source.includes('.w2mDcBadge[hidden],.w2mJqBadge[hidden]'), 'hidden beats the class display rule');
});

// ---------------------------------------------------------------------------------------------
// The 备份&还原 panel (v3.4.9)
// ---------------------------------------------------------------------------------------------
//
// The panel is the UI half of a feature whose host routes (src/plugin/backup.mjs) already exist.
// What is asserted here is everything a static read of the bundle can get wrong without a browser
// noticing: the sidebar/main registration pair, the four one-click operations, the two unlock
// branches (and the absence of any password field), the reason-code → copy mapping, the bounded
// in-memory log, and the two lifecycle leaks that would rot the page — a second stylesheet and a
// surviving poll timer after the slot unmounts.

describe('client bundle: the backup & restore panel (v3.4.9)', () => {
  /** Apply the bundle into a recording registry and hand back the two backup registrations. */
  function mountBackup(options = {}) {
    const registry = makeRegistry();
    const bundle = loadBundle(options);
    bundle.exports.apply({ slots: registry, effect: (callback) => callback(), get: () => undefined });
    const sidebar = registry.registered.find((entry) => entry.options.id === 'w2m-backup');
    const main = registry.registered.find((entry) => entry.options.key === 'w2m-backup');
    return { bundle, registry, sidebar, main };
  }

  /** The props the pure view needs; every case starts from a rendered, all-null page. */
  function viewProps(overrides = {}) {
    return {
      t: (key) => key,
      repo: null,
      status: null,
      unlock: null,
      plan: null,
      selected: [],
      busy: '',
      log: [],
      verify: null,
      lastAction: null,
      error: null,
      archiveScope: 'archived',
      restoreArmed: false,
      runMissing: false,
      // v3.5.0: the backup-scope card starts before the read-only scan has resolved (scan === null).
      scan: null,
      picked: [],
      ...overrides,
    };
  }

  /** One rendered button by its stable `data-w2m-backup-action` marker (the v3.5.0 scope entries too). */
  function actionButton(tree, action) {
    return findBy(tree, (node) => node.props?.['data-w2m-backup-action'] === action)[0];
  }

  /**
   * Mount the real backup page behind the fake hook-capable React with a recording fetch.
   *
   * `respond` receives `{url, method, body}` and returns the JSON payload to answer with, or
   * `{status: 404}` for a missing route. Returning `undefined` marks the request as unexpected: it is
   * recorded in `unexpected` (and answered with a 404) instead of throwing, because `callBackup`
   * never throws and a silent catch would turn a wrong route into a green test.
   */
  function mountBackupPage(respond) {
    const requests = [];
    const unexpected = [];
    const hostFetch = async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body === undefined ? null : JSON.parse(init.body);
      const answer = respond({ url, method, body });
      requests.push({ url, method, body });
      if (answer === undefined) {
        unexpected.push(method + ' ' + url);
        return { ok: false, status: 404, json: async () => ({ ok: false, reason_code: 'BACKUP_ROUTE_MISSING', detail: 'unexpected in this test' }) };
      }
      if (answer.status === 404) {
        return { ok: false, status: 404, json: async () => ({ ok: false, reason_code: 'BACKUP_ROUTE_MISSING', detail: 'the host has no such route' }) };
      }
      return { ok: true, status: 200, json: async () => answer };
    };
    const mountReact = makeMountReact();
    const registry = makeRegistry();
    const bundle = loadBundle({
      document: makeFakeDocument(),
      requireImpl: (specifier) => {
        if (specifier === 'react') return mountReact.React;
        throw new Error(`unexpected require(${specifier})`);
      },
      globals: { fetch: hostFetch },
    });
    bundle.exports.apply({ slots: registry, effect: (callback) => callback(), get: () => undefined });
    const page = registry.registered.find((entry) => entry.options.key === 'w2m-backup');
    assert.ok(page !== undefined, 'the backup page is registered');
    const handle = mountReact.mount(page.component, { t: bundle.exports.makeTranslator(() => undefined) });
    return {
      bundle,
      handle,
      requests,
      unexpected,
      settle: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        handle.rerender();
      },
      text: () => collectText(handle.tree).join('\n'),
    };
  }

  /**
   * The ordinary host: read-only scan (by default an empty list), run GET with the embedded status,
   * the standalone status route, and the unlock describe route. The two scope entries hit the same
   * `/api/w2m/backup/run` route the four existing operations use.
   */
  function standardBackupHost(options = {}) {
    const statusBody = { ok: true, repository: { root: 'D:\\BackUP', initialized: true, counts: { snapshots: 1 }, free_bytes: 1_048_576 } };
    const scanBody = options.scanBody ?? { ok: true, sessions: [], totals: { sessions: 0 }, registry: { ok: true } };
    const runPost = options.runPost ?? (() => ({ ok: true, snapshot_id: 'snap-scope', sessions: 1, files: 2, blocks_new: 1, blocks_reused: 0, duration_ms: 10 }));
    return ({ url, method }) => {
      if (url === '/api/w2m/backup/scan?detail=1') return scanBody;
      if (url === '/api/w2m/backup/run') {
        if (method === 'POST') return runPost();
        return { ok: true, enabled: true, backup_dir: 'D:\\BackUP', schedule: { times: ['22:00:00'], time_zone: 'UTC' }, status: statusBody, state: { running: false } };
      }
      if (url === '/api/w2m/backup/status') return statusBody;
      if (url === '/api/w2m/backup/unlock') return { ok: true, initialized: true, envelopes: ['machine'], machine_available: true, machine_reason: null, password_required: false };
      return undefined;
    };
  }

  /** Three sessions whose mix covers archived / unregistered, as the read-only scan reports them. */
  function scanSessionsBody() {
    return {
      ok: true,
      read_only: true,
      scanned_at: '2026-11-17T10:00:00.000Z',
      sessions: [
        { session_id: 'sess-alpha-0001', workspace: 'proj-a', size: 2048, flags: { registered: true, archived: false } },
        { session_id: 'sess-beta-0002', workspace: 'proj-b', size: 4096, flags: { registered: true, archived: true } },
        { session_id: 'sess-gamma-0003', workspace: 'proj-c', size: 8192, flags: { registered: false, archived: false } },
      ],
      totals: { sessions: 3 },
      registry: { ok: true, workspaces: 3, registered: 2, archived: 1, pinned: 0 },
    };
  }

  it('takes a sidebar seat after GPW and a main page keyed by the same id', () => {
    const { registry, sidebar, main } = mountBackup();
    assert.ok(sidebar !== undefined, 'the backup sidebar entry is registered');
    assert.equal(sidebar.options.name, 'sidebar.panellist');
    assert.equal(sidebar.options.id, 'w2m-backup');
    assert.ok(main !== undefined, 'the backup main page is registered');
    assert.equal(main.options.name, 'main');
    assert.equal(main.options.key, 'w2m-backup');
    assert.equal(main.options.key, sidebar.options.id, 'the main key must equal the panellist id');
    const gpw = registry.registered.find((entry) => entry.options.name === 'sidebar.panellist'
      && entry.options.id === 'w2m-gpw');
    assert.ok(gpw !== undefined, 'the GPW sidebar entry is still registered');
    assert.ok(sidebar.options.order > gpw.options.order, 'the entry is listed after GPW');
    assert.equal(typeof sidebar.component, 'function', 'the sidebar entry is a component');
    assert.equal(typeof main.component, 'function', 'the main page is a component');
    const injected = sidebar.options.inject();
    assert.equal(typeof injected.t, 'function', 'visible copy goes through the locale seam');
    assert.equal(injected.t('panel.backup.title'), '备份&还原', 'the label is translated, not hardcoded in the host UI');
  });

  it('draws the sidebar icon as an inline currentColor SVG that wakes the panel', () => {
    const { bundle } = mountBackup({
      globals: { CustomEvent: class { constructor(type) { this.type = type; } } },
    });
    const tree = bundle.exports.BackupSidebarIcon({ t: (key) => key });
    const svgs = findBy(tree, (node) => node.type === 'svg');
    assert.equal(svgs.length, 1, 'the icon is an inline SVG, not an external asset');
    assert.equal(svgs[0].props.stroke, 'currentColor', 'the icon follows the host theme text colour');
    assert.equal(svgs[0].props.fill, 'none');
    const events = [];
    bundle.window.dispatchEvent = (event) => { events.push(event); };
    const button = findBy(tree, (node) => node.props?.['data-w2m-backup-sidebar'] === 'true')[0];
    assert.ok(button !== undefined, 'the entry is a button');
    button.props.onClick();
    assert.equal(events[0]?.type, 'w2m-backup-open', 'clicking the entry asks the panel to refresh');
  });

  it('renders the four one-click operations with stable action markers', () => {
    const { bundle } = mountBackup();
    const tree = bundle.exports.BackupPanelView(viewProps());
    const actions = findBy(tree, (node) => node.props?.['data-w2m-backup-action'] !== undefined)
      .map((node) => node.props['data-w2m-backup-action']);
    for (const action of ['run', 'restore', 'archive', 'verify']) {
      assert.ok(actions.includes(action), `the ${action} operation is rendered`);
    }
    // While an operation is in flight every operation button is disabled: no double submit.
    const busyTree = bundle.exports.BackupPanelView(viewProps({ busy: 'run' }));
    const operationButtons = findBy(busyTree, (node) => node.type === 'button'
      && ['run', 'restore', 'archive', 'verify'].includes(node.props?.['data-w2m-backup-action']));
    assert.equal(operationButtons.length, 4);
    for (const button of operationButtons) {
      assert.equal(button.props.disabled, true, 'an in-flight operation disables its siblings');
    }
  });

  it('offers the machine unlock and always explains the CLI password path, never posting a password', () => {
    const { bundle } = mountBackup();
    // The real translator: the CLI command is part of the Chinese/English copy, not a key.
    const t = bundle.exports.makeTranslator(() => undefined);
    const available = bundle.exports.BackupPanelView(viewProps({
      t,
      unlock: { ok: true, initialized: true, envelopes: ['machine', 'password'], machine_available: true, machine_reason: null, password_required: true },
    }));
    assert.equal(findBy(available, (node) => node.props?.['data-w2m-backup-action'] === 'unlock').length, 1,
      'the machine envelope gets a one-click unlock button');
    const text = collectText(available).join('\n');
    assert.ok(text.includes('w2m-backup unlock --check --password-stdin'), 'the password path names the local CLI command');
    assert.ok(text.includes('密码不经过 HTTP'), 'the copy says a password never travels over HTTP');
    assert.equal(findBy(available, (node) => node.type === 'input' && node.props?.type === 'password').length, 0,
      'HTTP never takes a password, so there is no password field');
    assert.equal(findBy(available, (node) => node.props?.['data-w2m-backup-unlock-account'] !== undefined).length, 0,
      'a repository with no account binding shows no account row: the unbound card is unchanged');

    const unavailable = bundle.exports.BackupPanelView(viewProps({
      t,
      unlock: { ok: true, initialized: true, envelopes: ['password'], machine_available: false, machine_reason: 'dpapi-probe-failed', password_required: true },
    }));
    assert.equal(findBy(unavailable, (node) => node.props?.['data-w2m-backup-action'] === 'unlock').length, 0,
      'no machine button when the envelope cannot be loaded');
    assert.ok(collectText(unavailable).join('\n').includes('w2m-backup unlock --check --password-stdin'),
      'the password path is still shown instead');
  });

  it('shows the compare-only account path: a match unlocks, a mismatch sends the operator to the password', () => {
    const { bundle } = mountBackup();
    const t = bundle.exports.makeTranslator(() => undefined);

    const matched = bundle.exports.BackupPanelView(viewProps({
      t,
      unlock: {
        ok: true,
        initialized: true,
        envelopes: ['machine', 'account', 'password'],
        machine_available: true,
        machine_reason: null,
        password_required: true,
        account: { bound: true, matched: true, id_hint: '…abcd' },
      },
    }));
    const matchedRow = findBy(matched, (node) => node.props?.['data-w2m-backup-unlock-account'] !== undefined)[0];
    assert.ok(matchedRow !== undefined, 'the account row is rendered when the repository is bound');
    assert.equal(matchedRow.props['data-w2m-backup-unlock-account'], 'matched');
    const matchedButton = actionButton(matched, 'unlock-account');
    assert.ok(matchedButton !== undefined, 'the account path gets its own one-click button');
    assert.equal(matchedButton.props.disabled, false, 'a matching account id may unlock without a password');
    const matchedText = collectText(matched).join('\n');
    assert.ok(matchedText.includes('本机账户与原账户一致，可直接解锁'), 'the match copy is the "original account" sentence');
    assert.ok(matchedText.includes('…abcd'), 'the masked hint is shown');
    assert.equal(matchedText.includes('user-1234abcd'), false, 'the full account id never reaches the panel copy');

    const mismatch = bundle.exports.BackupPanelView(viewProps({
      t,
      unlock: {
        ok: true,
        initialized: true,
        envelopes: ['account', 'password'],
        machine_available: false,
        machine_reason: 'dpapi-probe-failed',
        password_required: true,
        account: { bound: true, matched: false, id_hint: '…abcd' },
      },
    }));
    const mismatchRow = findBy(mismatch, (node) => node.props?.['data-w2m-backup-unlock-account'] !== undefined)[0];
    assert.equal(mismatchRow.props['data-w2m-backup-unlock-account'], 'mismatch');
    const mismatchButton = actionButton(mismatch, 'unlock-account');
    assert.equal(mismatchButton.props.disabled, true, 'a different account must not be presented as an unlock button');
    const mismatchText = collectText(mismatch).join('\n');
    assert.ok(mismatchText.includes('当前账户不是原账户：请使用解锁密码'), 'the mismatch copy tells the operator to use the password');
    assert.ok(mismatchText.includes('w2m-backup unlock --check --password-stdin'), 'the password path is still explained');

    // Bound, but the host could not read an id to compare (signed out, or account binding switched off in config).
    const unread = bundle.exports.BackupPanelView(viewProps({
      t,
      unlock: {
        ok: true,
        initialized: true,
        envelopes: ['account'],
        machine_available: false,
        machine_reason: 'dpapi-probe-failed',
        password_required: false,
        account: { bound: true, matched: null, id_hint: '…abcd' },
      },
    }));
    const unreadRow = findBy(unread, (node) => node.props?.['data-w2m-backup-unlock-account'] !== undefined)[0];
    assert.equal(unreadRow.props['data-w2m-backup-unlock-account'], 'unknown');
    assert.equal(actionButton(unread, 'unlock-account').props.disabled, true, 'no comparison means no account unlock');
    assert.ok(collectText(unread).join('\n').includes('读取不到本机账户 ID'));
  });

  it('renders the three protection states, with the mode badge and the honest unencrypted warning', () => {
    const { bundle } = mountBackup();
    const t = bundle.exports.makeTranslator(() => undefined);

    // State 1: unencrypted (the default). No credential, a warning, and the "turn protection off" explanation.
    const none = bundle.exports.BackupPanelView(viewProps({
      t,
      repo: {
        ok: true,
        encryption: 'none',
        repository: { root: 'D:\\BackUP', initialized: true, encryption: 'none', counts: { snapshots: 1 }, free_bytes: 1048576 },
      },
      unlock: {
        ok: true,
        initialized: true,
        envelopes: ['open'],
        encryption: 'none',
        available_paths: ['none'],
        warning: '未加密：任何能访问该目录的人都能还原备份',
        machine_available: false,
        machine_reason: 'repository-is-unencrypted',
        password_required: false,
        account: { bound: false, matched: null, id_hint: null },
      },
    }));
    const noneState = findBy(none, (node) => node.props?.['data-w2m-backup-unlock-state'] !== undefined)[0];
    assert.equal(noneState.props['data-w2m-backup-unlock-state'], 'none', 'the unlock card has an explicit unencrypted state');
    const noneUnlockCard = findBy(none, (node) => node.props?.['data-w2m-backup-panel'] === 'unlock')[0];
    assert.equal(noneUnlockCard.props['data-w2m-backup-unlock-mode'], 'none');
    const noneText = collectText(none).join('\n');
    assert.ok(noneText.includes('未加密：任何能访问该目录的人都能还原备份'), 'the status/unlock cards show the real consequence');
    assert.ok(noneText.includes('不需要账户或 PIN'), 'the unencrypted copy says no credential is needed');
    assert.equal(actionButton(none, 'unlock').props.disabled, false, 'an unencrypted repository can unlock with one click');
    assert.ok(findBy(none, (node) => node.props?.['data-w2m-backup-disable-protection-hint'] !== undefined).length >= 1,
      'the "turn protection off" explanation is present');
    assert.equal(findBy(none, (node) => node.type === 'input' && node.props?.type === 'password').length, 0,
      'even the unencrypted card has no password field');
    // Mode badges: one on the status card, one on the unlock card.
    const noneBadges = findBy(none, (node) => node.props?.['data-w2m-backup-mode'] === 'none');
    assert.equal(noneBadges.length, 2, 'the status card and the unlock card both carry the mode badge');
    assert.ok(collectText(none).join('\n').includes('未加密（默认）'), 'the badge label is translated');

    // State 2: sealed + account match -> quick unlock.
    const matched = bundle.exports.BackupPanelView(viewProps({
      t,
      repo: { ok: true, encryption: 'sealed', repository: { root: 'D:\\BackUP', initialized: true, encryption: 'sealed', counts: { snapshots: 1 } } },
      unlock: {
        ok: true,
        initialized: true,
        envelopes: ['machine', 'account', 'password'],
        encryption: 'sealed',
        available_paths: ['account', 'machine', 'password'],
        warning: null,
        machine_available: true,
        machine_reason: null,
        password_required: true,
        account: { bound: true, matched: true, id_hint: '…abcd' },
      },
    }));
    const matchedState = findBy(matched, (node) => node.props?.['data-w2m-backup-unlock-state'] !== undefined)[0];
    assert.equal(matchedState.props['data-w2m-backup-unlock-state'], 'account-matched');
    assert.equal(actionButton(matched, 'unlock-account').props.disabled, false);
    assert.equal(findBy(matched, (node) => node.props?.['data-w2m-backup-mode'] === 'sealed').length, 2, 'sealed badges are shown');
    assert.equal(collectText(matched).join('\n').includes('未加密'), false, 'a sealed repository shows no unencrypted warning');

    // State 3: sealed + account mismatch with a PIN -> account button disabled, PIN only in the terminal.
    const mismatch = bundle.exports.BackupPanelView(viewProps({
      t,
      repo: { ok: true, encryption: 'sealed', repository: { root: 'D:\\BackUP', initialized: true, encryption: 'sealed', counts: { snapshots: 1 } } },
      unlock: {
        ok: true,
        initialized: true,
        envelopes: ['machine', 'account', 'password'],
        encryption: 'sealed',
        available_paths: ['account', 'machine', 'password'],
        warning: null,
        machine_available: false,
        machine_reason: 'dpapi-probe-failed',
        password_required: true,
        account: { bound: true, matched: false, id_hint: '…abcd' },
      },
    }));
    const mismatchState = findBy(mismatch, (node) => node.props?.['data-w2m-backup-unlock-state'] !== undefined)[0];
    assert.equal(mismatchState.props['data-w2m-backup-unlock-state'], 'account-mismatch');
    assert.equal(actionButton(mismatch, 'unlock-account').props.disabled, true);
    const mismatchText = collectText(mismatch).join('\n');
    assert.ok(mismatchText.includes('请在本机终端用 4–6 位数字 PIN 解锁'), 'the mismatch copy points at the terminal PIN');
    assert.ok(mismatchText.includes('4 位数字 PIN 只是便捷门槛，不是保密强度'), 'the weak-PIN caveat is shown');
    assert.ok(mismatchText.includes('w2m-backup unlock --check --password-stdin'), 'the CLI command is still named');
    assert.equal(findBy(mismatch, (node) => node.props?.['data-w2m-backup-unlock-password-hint'] !== undefined).length, 1);
    assert.equal(findBy(mismatch, (node) => node.props?.['data-w2m-backup-unlock-weak-pin'] !== undefined).length, 1);
  });

  it('never carries a password into a request body (the section posts confirmation tokens only)', () => {
    const source = readFileSync(BUNDLE_PATH, 'utf8');
    const start = source.indexOf('备份&还原面板（v3.4.9）');
    assert.ok(start > 0, 'the panel section is in the bundle');
    const end = source.indexOf('function FleetChat(', start);
    assert.ok(end > start, 'the section ends before the fleet-chat module');
    const section = source.slice(start, end);
    assert.equal(/type:\s*'password'/.test(section), false, 'no password input in the backup panel');
    assert.equal(/JSON\.stringify\(\{[^}]*password/isu.test(section), false, 'no request body carries a password');
    for (const route of [
      '/api/w2m/backup/run',
      '/api/w2m/backup/restore',
      '/api/w2m/backup/archive',
      '/api/w2m/backup/verify',
      '/api/w2m/backup/unlock',
    ]) {
      assert.ok(section.includes(route), `the panel calls ${route}`);
    }
  });

  it('renders the status bar, the plan card with checkboxes and the run log', () => {
    const { bundle } = mountBackup();
    const tree = bundle.exports.BackupPanelView(viewProps({
      repo: { ok: true, repository: { root: 'D:\\BackUP', initialized: true, counts: { snapshots: 3 }, free_bytes: 1048576 } },
      status: {
        ok: true,
        backup_dir: 'D:\\BackUP',
        schedule: { times: ['22:00:00'], time_zone: 'Asia/Shanghai' },
        state: {
          running: false,
          last_run: '2026-11-17T10:00:00.000Z',
          last_result: { snapshot_id: '20261117T100000Z-abcdef12', sessions: 2, files: 4, duration_ms: 4800 },
          last_error: null,
          last_registry_recheck: { at: '2026-11-17T10:00:05.000Z', ok: true, rewritten: true },
        },
      },
      plan: {
        ok: true,
        snapshot_id: '20261117T100000Z-abcdef12',
        summary: { sessions: 2, new: 1, identical: 1, conflicts: 0, attachments: 0 },
        candidates: [
          { session_id: 'sess-a', workspace: 'proj-a', size: 2048, conflict: 'new' },
          { session_id: 'sess-b', workspace: 'proj-b', size: 4096, conflict: 'identical' },
        ],
      },
      selected: ['sess-a'],
      log: [{ at: '2026-11-17T10:00:01.000Z', action: 'run', ok: true, code: 'OK', detail: null }],
    }));
    const text = collectText(tree).join('\n');
    assert.ok(text.includes('D:\\BackUP'), 'the repository path is shown');
    assert.ok(text.includes('panel.backup.status.yes'), 'the initialised state is shown');
    assert.ok(text.includes('panel.backup.status.recheckRewrote'), 'a registry re-check result is shown when it exists');
    assert.ok(text.includes('20261117T100000Z-abcdef12'), 'the last snapshot summary is shown');
    assert.ok(text.includes('panel.backup.plan.summary'), 'the plan card renders its summary');
    assert.ok(text.includes('panel.backup.status.runResult'), 'the last run summary is shown');
    const checkboxes = findBy(tree, (node) => node.type === 'input' && node.props?.type === 'checkbox'
      && node.props?.['data-w2m-backup-session'] !== undefined);
    assert.equal(checkboxes.length, 2, 'one checkbox per candidate session');
    assert.deepEqual(checkboxes.map((node) => node.props.checked), [true, false], 'the selected session is checked');
    assert.deepEqual(checkboxes.map((node) => node.props['data-w2m-backup-session']), ['sess-a', 'sess-b']);
    assert.equal(findBy(tree, (node) => node.props?.['data-w2m-backup-runtime'] === 'true').length, 1,
      'the slow-path toggle is a checkbox too, and is not a session checkbox');
    assert.equal(findBy(tree, (node) => node.props?.['data-w2m-backup-log-row'] === 'run').length, 1, 'the log lists the operation');
  });

  it('shows the danger confirmation only after the restore is armed', () => {
    const { bundle } = mountBackup();
    const plan = {
      ok: true,
      snapshot_id: 'snap-1',
      summary: { sessions: 1, new: 0, identical: 0, conflicts: 1, attachments: 0 },
      candidates: [{ session_id: 'sess-a', workspace: 'proj-a', size: 12, conflict: 'differs' }],
    };
    const quiet = bundle.exports.BackupPanelView(viewProps({ plan }));
    assert.equal(findBy(quiet, (node) => node.props?.['data-w2m-backup-confirm'] === 'restore').length, 0,
      'nothing dangerous is shown before the first click');
    const armed = bundle.exports.BackupPanelView(viewProps({ plan, restoreArmed: true }));
    assert.equal(findBy(armed, (node) => node.props?.['data-w2m-backup-confirm'] === 'restore').length, 1,
      'the second click is gated by a visible warning');
    const restore = findBy(armed, (node) => node.props?.['data-w2m-backup-action'] === 'restore')[0];
    assert.equal(restore.props['data-armed'], 'true');
    assert.ok(String(restore.children[0]).includes('panel.backup.action.confirmRestore'),
      'the button asks for confirmation in words, not in colour only');
  });

  it('drives the four operations through the host route contracts and gates restore behind two clicks', async () => {
    const document = makeFakeDocument();
    const requests = [];
    const statusBody = {
      ok: true,
      repository: { root: 'D:\\BackUP', initialized: true, counts: { snapshots: 2 }, free_bytes: 1_048_576 },
    };
    const planBody = {
      ok: true,
      snapshot_id: 'snap-1',
      summary: { sessions: 1, new: 1, identical: 0, conflicts: 0, attachments: 0 },
      candidates: [{ session_id: 'sess-a', workspace: 'proj-a', size: 10, conflict: 'new' }],
    };
    const hostFetch = async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body === undefined ? null : JSON.parse(init.body);
      requests.push({ url, method, body });
      const send = (payload) => ({ ok: true, status: 200, json: async () => payload });
      if (url === '/api/w2m/backup/run') {
        if (method === 'POST') {
          return send({ ok: true, snapshot_id: 'snap-1', sessions: 1, files: 2, blocks_new: 1, blocks_reused: 0, duration_ms: 10 });
        }
        // v3.4.9 host: the read-only status rides on the run GET (`status` field).
        return send({
          ok: true,
          enabled: true,
          backup_dir: 'D:\\BackUP',
          dsh_home: 'C:\\dsh',
          schedule: { times: ['22:00:00'], time_zone: 'UTC', next_at: '2026-11-17T14:00:00.000Z' },
          scheduler: {},
          status: statusBody,
          state: { running: false, last_run: null, last_result: null, last_error: null },
        });
      }
      if (url === '/api/w2m/backup/status') return send(statusBody);
      if (url === '/api/w2m/backup/restore') {
        if (body?.apply === true) {
          return send({ ok: true, restored: [{ session_id: 'sess-a' }], skipped: 0, bytes_written: 10, pre_restore_dir: 'pre' });
        }
        return send(planBody);
      }
      if (url === '/api/w2m/backup/archive') {
        return send({ ok: true, file: 'archive/x.tar.zst', sessions: 1, bytes: 100, compressed_bytes: 50 });
      }
      if (url === '/api/w2m/backup/verify') {
        return send({
          ok: true,
          counts: { snapshots: 1, files: 2, blocks: 3, old: 0, current: 1 },
          problems: [],
          snapshots: [],
          future_append: { checked: 1, failed: 0 },
          runtime_verified: { checked: 1, failed: 0 },
        });
      }
      if (url === '/api/w2m/backup/unlock') {
        if (method === 'POST') return send({ ok: true, via: 'machine', reason_code: null, detail: null });
        return send({
          ok: true,
          initialized: true,
          envelopes: ['machine', 'password'],
          machine_available: true,
          machine_reason: null,
          password_required: true,
        });
      }
      throw new Error(`unexpected fetch(${url}, ${method})`);
    };
    const mountReact = makeMountReact();
    const registry = makeRegistry();
    const bundle = loadBundle({
      document,
      requireImpl: (specifier) => {
        if (specifier === 'react') return mountReact.React;
        throw new Error(`unexpected require(${specifier})`);
      },
      globals: { fetch: hostFetch },
    });
    bundle.exports.apply({ slots: registry, effect: (callback) => callback(), get: () => undefined });
    const page = registry.registered.find((entry) => entry.options.key === 'w2m-backup');
    assert.ok(page !== undefined);
    const handle = mountReact.mount(page.component, { t: (key) => key });
    const settle = async () => {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      handle.rerender();
    };
    await settle();

    const clickAction = (action) => {
      const node = findBy(handle.tree, (element) => element.props?.['data-w2m-backup-action'] === action)[0];
      assert.ok(node !== undefined, `the ${action} operation is rendered`);
      node.props.onClick();
    };
    const bodies = (url) => requests
      .filter((request) => request.url === url && request.body !== null)
      .map((request) => request.body);

    // ① 立即备份: scope=all, and the attempt is logged.
    clickAction('run');
    await settle();
    assert.deepEqual(bodies('/api/w2m/backup/run'), [{ confirm: 'run', scope: 'all' }]);
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-log-row'] === 'run').length, 1, 'the run is logged');

    // ② 全量校验: read-only GET, and the counts are rendered.
    clickAction('verify');
    await settle();
    assert.ok(requests.some((request) => request.url === '/api/w2m/backup/verify' && request.method === 'GET'));
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-panel'] === 'verify').length, 1, 'the verify result is shown');

    // ③ 归档打包: archived by default; switch to all and pack again.
    clickAction('archive');
    await settle();
    assert.deepEqual(bodies('/api/w2m/backup/archive'), [{ confirm: 'archive', scope: 'archived' }]);
    const scope = findBy(handle.tree, (node) => node.props?.['data-w2m-backup-archive-scope'] === 'true')[0];
    scope.props.onChange({ target: { value: 'all' } });
    handle.rerender();
    clickAction('archive');
    await settle();
    assert.deepEqual(bodies('/api/w2m/backup/archive')[1], { confirm: 'archive', scope: 'all' });

    // ④ 还原: the first click only plans (no apply) and raises the danger confirmation; only the second click writes.
    clickAction('restore');
    await settle();
    const planned = bodies('/api/w2m/backup/restore');
    assert.equal(planned.length, 1, 'the first click posts a plan request');
    assert.equal(planned[0].apply, undefined, 'the first click must not write');
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-confirm'] === 'restore').length, 1,
      'the danger confirmation is visible between the two clicks');
    clickAction('restore');
    await settle();
    const applied = bodies('/api/w2m/backup/restore')[1];
    assert.equal(applied.apply, true, 'only the second click applies');
    assert.deepEqual(applied.sessions, ['sess-a'], 'the applied plan carries the selected session');

    // 解锁: only the confirmation token, no credential of any kind.
    clickAction('unlock');
    await settle();
    assert.deepEqual(bodies('/api/w2m/backup/unlock'), [{ confirm: 'unlock' }]);
    handle.unmount();
  });

  it('gates the slow runtime verdict behind an explicit checkbox (?runtime=1 only when checked)', async () => {
    const document = makeFakeDocument();
    const requests = [];
    const statusBody = { ok: true, repository: { root: 'D:\\BackUP', initialized: true, counts: { snapshots: 1 }, free_bytes: 1_024 } };
    const verifyBody = {
      ok: true,
      counts: { snapshots: 1, files: 1, blocks: 1, old: 0, current: 0 },
      problems: [{ code: 'BACKUP_RUNTIME_UNAVAILABLE', file: 'sessions/x', detail: 'no installation' }],
      snapshots: [],
      future_append: { checked: 1, failed: 0, evidence: 'static-prefilter' },
      runtime_verified: { checked: 1, failed: 0, evidence: 'installed-harness' },
    };
    const hostFetch = async (url, init = {}) => {
      requests.push({ url, method: init.method ?? 'GET' });
      const send = (payload) => ({ ok: true, status: 200, json: async () => payload });
      if (url === '/api/w2m/backup/run') {
        return send({ ok: true, enabled: true, backup_dir: 'D:\\BackUP', schedule: { times: ['22:00:00'], time_zone: 'UTC' }, status: statusBody, state: {} });
      }
      if (url === '/api/w2m/backup/status') return send(statusBody);
      if (url === '/api/w2m/backup/unlock') {
        return send({ ok: true, initialized: true, envelopes: ['machine'], machine_available: true, machine_reason: null, password_required: false });
      }
      if (url === '/api/w2m/backup/verify' || url === '/api/w2m/backup/verify?runtime=1') return send(verifyBody);
      throw new Error(`unexpected fetch(${url})`);
    };
    const mountReact = makeMountReact();
    const registry = makeRegistry();
    const bundle = loadBundle({
      document,
      requireImpl: (specifier) => {
        if (specifier === 'react') return mountReact.React;
        throw new Error(`unexpected require(${specifier})`);
      },
      globals: { fetch: hostFetch },
    });
    bundle.exports.apply({ slots: registry, effect: (callback) => callback(), get: () => undefined });
    const page = registry.registered.find((entry) => entry.options.key === 'w2m-backup');
    assert.ok(page !== undefined, 'the backup page is registered');
    const handle = mountReact.mount(page.component, { t: (key) => key });
    const settle = async () => {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      handle.rerender();
    };
    await settle();

    const verifyUrls = () => requests.filter((request) => request.url.startsWith('/api/w2m/backup/verify')).map((request) => request.url);
    const clickAction = (action) => {
      const node = findBy(handle.tree, (element) => element.props?.['data-w2m-backup-action'] === action)[0];
      assert.ok(node !== undefined, `the ${action} operation is rendered`);
      node.props.onClick();
    };
    const runtimeToggle = () => findBy(handle.tree, (node) => node.type === 'input' && node.props?.['data-w2m-backup-runtime'] === 'true')[0];

    // The checkbox exists before any result, and the default is the cheap read-only path.
    assert.ok(runtimeToggle() !== undefined, 'the toggle is rendered even before a verify result exists');
    assert.equal(runtimeToggle().props.checked, false, 'the slow path is opt-in');
    clickAction('verify');
    await settle();
    assert.deepEqual(verifyUrls(), ['/api/w2m/backup/verify'], 'unchecked: no runtime=1');
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-panel'] === 'verify').length, 1, 'the verify result is shown');

    const text = collectText(handle.tree).join('\n');
    assert.ok(text.includes('panel.backup.verify.runtime'), 'the toggle label goes through the dictionary');
    assert.ok(text.includes('panel.backup.verify.runtimeHint'), 'the hint (slow, needs an installation) is rendered');
    assert.ok(text.includes('panel.backup.verify.runtimeCounts'), 'the runtime_verified counts are still rendered');

    // The real translator proves the copy and the reason-code map: a runtime problem shows the operator sentence,
    // not the raw code (BACKUP_RUNTIME_UNAVAILABLE / BACKUP_RUNTIME_REJECTED are already mapped).
    const t = bundle.exports.makeTranslator(() => undefined);
    const realTree = bundle.exports.BackupPanelView({
      t,
      repo: null,
      status: null,
      unlock: null,
      plan: null,
      selected: [],
      busy: '',
      log: [],
      verify: verifyBody,
      lastAction: null,
      error: null,
      archiveScope: 'archived',
      restoreArmed: false,
      runMissing: false,
      verifyRuntime: true,
    });
    const realText = collectText(realTree).join('\n');
    assert.ok(realText.includes('用安装的 Harness 终审（慢）'), 'the toggle label is the Chinese slow-path copy');
    assert.ok(realText.includes('可能耗时数分钟'), 'the hint says it can take minutes');
    assert.ok(realText.includes('本机没有可用的运行时校验环境'), 'a runtime problem code is rendered through the reason-code map');

    // Check the box: the next verify asks the host for the installed-Harness verdict.
    runtimeToggle().props.onChange({ target: { checked: true } });
    handle.rerender();
    assert.equal(runtimeToggle().props.checked, true);
    clickAction('verify');
    await settle();
    assert.deepEqual(verifyUrls(), ['/api/w2m/backup/verify', '/api/w2m/backup/verify?runtime=1'],
      'only the checked box turns the runtime evidence on');
    handle.unmount();
  });

  it('renders the two backup-scope entries and disables them until the read-only scan resolves', () => {
    const { bundle } = mountBackup();
    const t = bundle.exports.makeTranslator(() => undefined);
    // Before the scan resolves the card is present (loading), the two action markers exist, both are
    // disabled, and there is nothing to tick: a slow/failed scan can never take the panel down.
    const before = bundle.exports.BackupPanelView(viewProps());
    for (const action of ['backup-selected', 'backup-active']) {
      assert.ok(actionButton(before, action) !== undefined, `the ${action} scope entry is rendered`);
      assert.equal(actionButton(before, action).props.disabled, true, `${action} waits for the scan`);
    }
    assert.equal(findBy(before, (node) => node.props?.['data-w2m-backup-panel'] === 'scope').length, 1,
      'the scope card itself renders, in a neutral state');
    assert.equal(findBy(before, (node) => node.props?.['data-w2m-backup-pick'] !== undefined).length, 0);
    assert.ok(collectText(before).join('\n').includes('panel.backup.pick.loading'));

    const scan = {
      available: true,
      total: 3,
      sessions: [
        { session_id: 'sess-a', workspace: 'proj-a', size: 10, archived: false, registered: true },
        { session_id: 'sess-b', workspace: 'proj-b', size: 20, archived: true, registered: true },
        { session_id: 'sess-c', workspace: 'proj-c', size: 30, archived: false, registered: false },
      ],
    };
    // After a successful scan: 'selected' still needs a tick, 'active' needs none.
    const after = bundle.exports.BackupPanelView(viewProps({ scan, picked: [] }));
    const markers = findBy(after, (node) => node.props?.['data-w2m-backup-action'] !== undefined)
      .map((node) => node.props['data-w2m-backup-action']);
    assert.ok(['run', 'restore', 'archive', 'verify'].every((action) => markers.includes(action)),
      'the existing four operations stay beside the two scope entries');
    assert.equal(actionButton(after, 'backup-selected').props.disabled, true, 'selected needs at least one tick');
    assert.equal(actionButton(after, 'backup-active').props.disabled, false, 'active needs no selection');
    assert.deepEqual(
      findBy(after, (node) => node.props?.['data-w2m-backup-pick'] !== undefined).map((node) => node.props['data-w2m-backup-pick']),
      ['sess-a', 'sess-b', 'sess-c'],
      'one pick checkbox per scanned session, in host order',
    );
    assert.equal(actionButton(bundle.exports.BackupPanelView(viewProps({ scan, picked: ['sess-a'] })), 'backup-selected').props.disabled, false,
      'one tick is enough for the selected entry');

    // The count line goes through the dictionary with both numbers, and the archived tag is shown.
    const real = bundle.exports.BackupPanelView(viewProps({ t, scan, picked: ['sess-a', 'sess-b'] }));
    assert.ok(collectText(real).join('\n').includes('已选 2/3'), 'the count line reads 已选 {n}/{m}');
    assert.ok(collectText(real).join('\n').includes('已归档'), 'an archived session carries the archived tag');
    const archivedBox = findBy(real, (node) => node.type === 'input' && node.props?.['data-w2m-backup-pick'] === 'sess-b')[0];
    assert.equal(archivedBox.props.checked, true, 'the checked archived session is listed like any other');

    // Long ids are shortened for display; the full id stays available as the title tooltip.
    const longId = 'session-20261117-abcdef123456';
    const longScan = { available: true, total: 1, sessions: [{ session_id: longId, workspace: 'proj', size: 1, archived: false, registered: true }] };
    const longTree = bundle.exports.BackupPanelView(viewProps({ scan: longScan }));
    const suffix = findBy(longTree, (node) => node.props?.title === longId)[0];
    assert.ok(String(suffix?.children?.[0] ?? '').startsWith('…'), 'the list shows the id suffix, not the whole id');

    // Busy state: all six operations disabled, and the label names the operation that is running.
    const busyTree = bundle.exports.BackupPanelView(viewProps({ scan, picked: ['sess-a'], busy: 'backup-selected' }));
    const operations = findBy(busyTree, (node) => node.type === 'button'
      && ['run', 'restore', 'archive', 'verify', 'backup-selected', 'backup-active'].includes(node.props?.['data-w2m-backup-action']));
    assert.equal(operations.length, 6);
    for (const node of operations) assert.equal(node.props.disabled, true, 'an in-flight operation disables its five siblings');
    assert.equal(String(actionButton(busyTree, 'backup-selected').children[0]), 'panel.backup.busy.backupSelected',
      'the running entry says what it is doing, not what it would do');
    assert.equal(String(actionButton(busyTree, 'backup-active').children[0]), 'panel.backup.action.backupActive',
      'the idle entry keeps its action label');
  });

  it('normalizes the read-only scan defensively: any failure is an unavailable state, never a throw', () => {
    const { exports } = loadBundle();
    for (const result of [
      undefined,
      null,
      { ok: false, http: false, routeMissing: true },
      { ok: true, body: null },
      { ok: true, body: { ok: true } },
      { ok: true, body: { ok: true, sessions: 'not-a-list' } },
    ]) {
      const scan = exports.normalizeBackupScan(result);
      assert.equal(scan.available, false, 'a missing/failed scan is reported as unavailable');
      // Host-realm Array.from: the bundle's arrays come from the vm realm, and deepStrictEqual would
      // reject them on the prototype alone even though the values match.
      assert.deepEqual(Array.from(scan.sessions), []);
      assert.equal(scan.total, 0);
    }
    assert.equal(exports.normalizeBackupScan({ ok: false, routeMissing: true }).routeMissing, true,
      'a 404 stays distinguishable from a payload the host did not send');
    const scan = exports.normalizeBackupScan({
      ok: true,
      body: {
        ok: true,
        sessions: [
          { session_id: 'sess-a', workspace: 'proj-a', size: 10, flags: { registered: true, archived: false } },
          null,
          { session_id: 42 },
          { session_id: '', workspace: 'x' },
          { session_id: 'sess-b', size: 'not-a-number', flags: null },
        ],
        totals: { sessions: 9 },
      },
    });
    assert.equal(scan.available, true);
    assert.deepEqual(Array.from(scan.sessions, (row) => row.session_id), ['sess-a', 'sess-b'], 'malformed rows are dropped');
    assert.equal(scan.sessions[0].archived, false);
    assert.equal(scan.sessions[1].size, null);
    assert.equal(scan.sessions[1].workspace, '');
    assert.equal(scan.total, 9, 'the host total is kept when it is a finite number');
    assert.equal(exports.BACKUP_SCAN_ROUTE, '/api/w2m/backup/scan', 'the panel reads the mounted read-only route');
  });

  it('drives the read-only scan and the two backup-scope entries through the run contract', async () => {
    const { handle, requests, unexpected, settle } = mountBackupPage(standardBackupHost({ scanBody: scanSessionsBody() }));
    await settle();
    assert.deepEqual(unexpected, [],
      'the first render reads only the status/run/unlock/scan routes the panel knows');
    const pickBoxes = () => findBy(handle.tree, (node) => node.type === 'input' && node.props?.['data-w2m-backup-pick'] !== undefined);
    const pickCount = () => findBy(handle.tree, (node) => node.props?.['data-w2m-backup-pick-count'] === 'true')[0];
    const click = (node) => { node.props.onClick(); };
    assert.deepEqual(pickBoxes().map((node) => node.props['data-w2m-backup-pick']),
      ['sess-alpha-0001', 'sess-beta-0002', 'sess-gamma-0003'], 'the scan list reaches the card');
    assert.equal(pickCount().children[0], '已选 0/3');

    // Select-all / clear move the count line (both operate on the scanned list only).
    click(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-pick-all'] === 'true')[0]);
    handle.rerender();
    assert.equal(pickCount().children[0], '已选 3/3', 'select-all ticks the whole scanned list');
    assert.deepEqual(pickBoxes().map((node) => node.props.checked), [true, true, true]);
    click(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-pick-clear'] === 'true')[0]);
    handle.rerender();
    assert.equal(pickCount().children[0], '已选 0/3', 'clear empties the selection');
    assert.deepEqual(pickBoxes().map((node) => node.props.checked), [false, false, false]);

    // Tick two specific sessions, then run scope=selected: exactly those ids, no other scope.
    for (const id of ['sess-beta-0002', 'sess-gamma-0003']) {
      pickBoxes().find((node) => node.props['data-w2m-backup-pick'] === id).props.onChange();
    }
    handle.rerender();
    assert.equal(pickCount().children[0], '已选 2/3');
    const posts = () => requests.filter((request) => request.url === '/api/w2m/backup/run' && request.method === 'POST').map((request) => request.body);
    const scanReads = () => requests.filter((request) => request.url.startsWith('/api/w2m/backup/scan')).length;
    const scansBefore = scanReads();
    click(actionButton(handle.tree, 'backup-selected'));
    await settle();
    let bodies = posts();
    assert.equal(bodies.length, 1, 'the selected entry posts exactly one run body');
    // Order-insensitive: the run body carries the two ticked ids in some order (the panel keeps the
    // operator's tick order), and nothing else in the body may differ from the host contract.
    assert.deepEqual({ ...bodies[0], selected: Array.from(bodies[0].selected).sort() }, {
      confirm: 'run',
      scope: 'selected',
      selected: ['sess-beta-0002', 'sess-gamma-0003'].sort(),
    }, 'the run body carries the confirm token, scope selected, and exactly the ticked ids');
    assert.equal(new Set(bodies.map((body) => body.scope)).size, 1, 'no other scope is sent by the selected entry');
    assert.ok(scanReads() > scansBefore, 'the selected run refreshes the read-only session list afterwards');
    assert.ok(requests.filter((request) => request.url === '/api/w2m/backup/run' && request.method === 'GET').length >= 2,
      'the selected run refreshes the status afterwards');

    // The active-scope entry needs no selection and sends scope=active only.
    click(actionButton(handle.tree, 'backup-active'));
    await settle();
    bodies = posts();
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], { confirm: 'run', scope: 'active' });

    // The pre-existing run is untouched: still scope=all with exactly the old body.
    click(actionButton(handle.tree, 'run'));
    await settle();
    bodies = posts();
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[2], { confirm: 'run', scope: 'all' });
    assert.deepEqual(unexpected, [], 'no operation invented a route');
    handle.unmount();
  });

  it('renders the neutral unavailable state for a host without the scan route, without blocking the panel', async () => {
    const host = standardBackupHost();
    const { handle, settle, text } = mountBackupPage(({ url, method }) => (
      url === '/api/w2m/backup/scan?detail=1' ? { status: 404 } : host({ url, method })
    ));
    await settle();
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-scan-state'] === 'unavailable').length, 1,
      'a missing scan route is a stated neutral state');
    assert.ok(text().includes('该宿主未启用备份路由或扫描失败'), 'the hint names the cause and stays actionable');
    assert.ok(text().includes('刷新会话'), 'the retry entry is visible in the same card');
    // A missing read route must not take the write entries away: run/active stay usable, selected cannot.
    assert.equal(actionButton(handle.tree, 'run').props.disabled, false);
    assert.equal(actionButton(handle.tree, 'backup-active').props.disabled, false);
    assert.equal(actionButton(handle.tree, 'backup-selected').props.disabled, true);
    handle.unmount();
  });

  it('renders the empty hint when the scan reports no sessions', async () => {
    const { handle, settle, text } = mountBackupPage(standardBackupHost());
    await settle();
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-scan-state'] === 'empty').length, 1);
    assert.ok(text().includes('没有可备份的会话'));
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-pick'] !== undefined).length, 0);
    assert.equal(actionButton(handle.tree, 'backup-selected').props.disabled, true);
    assert.equal(actionButton(handle.tree, 'backup-active').props.disabled, false);
    handle.unmount();
  });

  it('shows the host reason text when a scope run is refused, instead of throwing', async () => {
    const { handle, settle, text } = mountBackupPage(standardBackupHost({
      scanBody: scanSessionsBody(),
      runPost: () => ({ ok: false, reason_code: 'BACKUP_SCOPED_NOTHING', detail: 'no active sessions' }),
    }));
    await settle();
    const box = findBy(handle.tree, (node) => node.type === 'input' && node.props?.['data-w2m-backup-pick'] === 'sess-alpha-0001')[0];
    assert.ok(box !== undefined, 'the scanned session is tickable');
    box.props.onChange();
    handle.rerender();
    actionButton(handle.tree, 'backup-selected').props.onClick();
    await settle();
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-backup-panel'] === 'error').length, 1,
      'a refusal is rendered as the named reason, not as an exception');
    assert.ok(text().includes('选定范围内没有可备份的会话'), 'the stable reason code is translated for the operator');
    assert.ok(text().includes('no active sessions'), 'the host detail stays visible');
    handle.unmount();
  });

  it('registers panel.backup.* strings in both the Chinese and English dictionaries', () => {
    const { exports } = loadBundle();
    const registry = makeRegistry();
    const locale = makeLocale();
    const ctx = makeStrictContext({ inject: [...exports.inject], services: { slots: registry, locale } });
    exports.apply(ctx);
    const dictionary = locale.registered.get('w2m.target');
    assert.ok(dictionary !== undefined, 'the dictionaries reach the locale service');
    const keys = [
      'panel.backup.title',
      'panel.backup.action.run',
      'panel.backup.action.restore',
      'panel.backup.action.archive',
      'panel.backup.action.verify',
      'panel.backup.unlock.passwordPath',
      'panel.backup.reason.BACKUP_NO_PERMISSION',
      // v3.5.x compare-only account-id binding: the account row, its three states and the new reason code.
      'panel.backup.unlock.accountBound',
      'panel.backup.unlock.accountMatched',
      'panel.backup.unlock.accountMismatch',
      'panel.backup.unlock.accountUnavailable',
      'panel.backup.action.unlockAccount',
      'panel.backup.reason.BACKUP_ACCOUNT_MISMATCH',
      // G5: the slow runtime verdict is an explicit toggle with its own hint.
      'panel.backup.verify.runtime',
      'panel.backup.verify.runtimeCounts',
      'panel.backup.verify.runtimeHint',
      // v3.5.x: the cached runtime verdict block, its stale badge and the explicit run-now button.
      'panel.backup.verify.cachedTitle',
      'panel.backup.verify.cachedLine',
      'panel.backup.verify.cachedNone',
      'panel.backup.verify.stale',
      'panel.backup.verify.fresh',
      'panel.backup.action.verifyRuntime',
      'panel.backup.action.repairRegister',
      'panel.backup.busy.verifyRuntime',
      'panel.backup.busy.repairRegister',
      'panel.backup.log.verifyRuntime',
      'panel.backup.log.repairRegister',
      'panel.backup.status.registerFix',
      'panel.backup.register.none',
      'panel.backup.register.done',
      'panel.backup.register.residual',
      'panel.backup.reason.BACKUP_REGISTER_NO_SESSION',
      'panel.backup.reason.BACKUP_REGISTER_SESSION_MISSING',
      'panel.backup.reason.BACKUP_REGISTER_BACKUP_FAILED',
      // v3.5.0: the two backup-scope entries and the read-only scan card around them.
      'panel.backup.action.backupSelected',
      'panel.backup.action.backupActive',
      'panel.backup.scope.hint',
      'panel.backup.pick.title',
      'panel.backup.pick.count',
      'panel.backup.pick.selected',
      'panel.backup.pick.clear',
      'panel.backup.pick.refresh',
      'panel.backup.pick.loading',
      'panel.backup.pick.unavailable',
      'panel.backup.pick.empty',
      'panel.backup.pick.archivedTag',
      'panel.backup.busy.backupSelected',
      'panel.backup.busy.backupActive',
      'panel.backup.log.backupSelected',
      'panel.backup.log.backupActive',
      // v3.5.x protection modes (user decision: convenience, not absolute confidentiality; none is the default).
      'panel.backup.status.mode',
      'panel.backup.mode.none',
      'panel.backup.mode.sealed',
      'panel.backup.mode.noneWarning',
      'panel.backup.unlock.none',
      'panel.backup.unlock.passwordHint',
      'panel.backup.unlock.weakPinHint',
      'panel.backup.unlock.disableProtectionHint',
      'panel.backup.reason.BACKUP_CONFIG_INVALID',
    ];
    for (const key of keys) {
      assert.equal(typeof dictionary.zh[key], 'string', `the zh dictionary has ${key}`);
      assert.equal(typeof dictionary.en[key], 'string', `the en dictionary has ${key}`);
    }
    assert.equal(dictionary.zh['panel.backup.verify.runtime'], '用安装的 Harness 终审（慢）',
      'the toggle label is the slow path, labelled as slow');
    assert.notEqual(dictionary.zh['panel.backup.verify.runtimeHint'], dictionary.en['panel.backup.verify.runtimeHint'],
      'the hint is translated, not copied');
    assert.equal(dictionary.zh['panel.backup.reason.BACKUP_NO_PERMISSION'], '没有权限：请用原账户登录，或输入解锁密码');
    assert.ok(dictionary.zh['panel.backup.unlock.accountMismatch'].includes('不是原账户'),
      'the mismatch copy says the current account is not the original one');
    assert.ok(dictionary.en['panel.backup.unlock.accountMatched'].includes('matches the original account'),
      'the English match copy says the account matches');
    assert.ok(dictionary.zh['panel.backup.reason.BACKUP_ACCOUNT_MISMATCH'].includes('密码'),
      'the mismatch reason code points the operator at the password path');
    assert.notEqual(dictionary.zh['panel.backup.title'], dictionary.en['panel.backup.title'], 'both languages are real translations');
    assert.equal(dictionary.zh['panel.backup.pick.count'], '已选 {n}/{m}', 'the count copy keeps both placeholders');
    assert.equal(dictionary.zh['panel.backup.action.backupSelected'], '备份选中会话');
    assert.equal(dictionary.zh['panel.backup.action.backupActive'], '备份所有当前活动会话');
    assert.notEqual(dictionary.zh['panel.backup.action.backupSelected'], dictionary.en['panel.backup.action.backupSelected'],
      'the scope entry labels are translated, not copied');
    assert.notEqual(dictionary.zh['panel.backup.scope.hint'], dictionary.en['panel.backup.scope.hint'],
      'the scope hint explains selected vs active vs all in both languages');
    assert.ok(dictionary.en['panel.backup.scope.hint'].includes('active'), 'the English hint names the active scope');
    assert.ok(dictionary.zh['panel.backup.scope.hint'].includes('已归档'), 'the Chinese hint names the archived difference of scope all');
    assert.equal(dictionary.zh['panel.backup.pick.archivedTag'], '已归档');
    // The honest security copy: an unencrypted repository says so in words, and a 4-digit PIN is labelled
    // as a convenience gate rather than confidentiality.
    assert.equal(dictionary.zh['panel.backup.mode.noneWarning'], '未加密：任何能访问该目录的人都能还原备份');
    assert.equal(dictionary.en['panel.backup.mode.noneWarning'], 'Not encrypted: anyone who can reach this directory can restore the backup');
    assert.ok(dictionary.zh['panel.backup.mode.none'].includes('未加密'));
    assert.ok(dictionary.en['panel.backup.mode.sealed'].includes('Encrypted'));
    assert.ok(dictionary.zh['panel.backup.unlock.weakPinHint'].includes('不是保密强度'),
      'the weak-PIN hint says a PIN is not confidentiality');
    assert.ok(dictionary.zh['panel.backup.unlock.passwordHint'].includes('终端'),
      'the password hint keeps the PIN in the terminal');
    assert.ok(dictionary.zh['panel.backup.unlock.disableProtectionHint'].includes('--disable-protection'),
      'the disable-protection copy names the CLI command');
    assert.ok(dictionary.zh['panel.backup.unlock.none'].includes('不需要账户'),
      'the unencrypted unlock copy says it needs no account or PIN');
    const mapped = Object.keys(exports.BACKUP_REASON_KEYS);
    assert.ok(mapped.length >= 20, 'the reason-code map covers the host codes');
    for (const code of mapped) {
      const key = exports.BACKUP_REASON_KEYS[code];
      assert.equal(typeof dictionary.zh[key], 'string', `the zh dictionary maps ${code}`);
      assert.equal(typeof dictionary.en[key], 'string', `the en dictionary maps ${code}`);
    }
  });

  it('turns a reason code into the operator sentence and keeps unknown codes visible', () => {
    const { exports } = loadBundle();
    const t = exports.makeTranslator(() => undefined);
    assert.equal(exports.backupReasonText('BACKUP_NO_PERMISSION', t), '没有权限：请用原账户登录，或输入解锁密码');
    assert.equal(exports.backupReasonText('BACKUP_ACCOUNT_MISMATCH', t), '当前账户不是原账户：已改走解锁密码路径，请用密码解锁');
    assert.equal(exports.backupReasonText('BACKUP_BUSY', t), '上一次备份还在运行，请稍候。');
    assert.equal(exports.backupReasonText('BACKUP_SOMETHING_NEW', t), 'BACKUP_SOMETHING_NEW', 'an unknown code is never guessed');
    assert.equal(exports.backupReasonText('', t), '');
  });

  it('renders the cached runtime verdict (fresh/none/stale) and the run-now button’s disabled state', () => {
    const { bundle } = mountBackup();
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const record = { started_at: oldIso, finished_at: nowIso, ok: true, checked: 3, failed: 0, snapshots: 2, reason_codes: [], evidence: 'installed-harness' };
    const marker = (tree) => findBy(tree, (node) => node.props?.['data-w2m-backup-runtime-cached'] !== undefined)[0];

    const none = bundle.exports.BackupPanelView(viewProps());
    assert.equal(marker(none).props['data-w2m-backup-runtime-cached'], 'none');
    assert.ok(collectText(none).join('\n').includes('panel.backup.verify.cachedNone'));
    assert.equal(actionButton(none, 'verify-runtime').props.disabled, false, 'the run-now button is available before any cache exists');

    const fresh = bundle.exports.BackupPanelView(viewProps({ status: { ok: true, state: { last_runtime_verify: record } } }));
    assert.equal(marker(fresh).props['data-w2m-backup-runtime-cached'], 'fresh');
    const realT = bundle.exports.makeTranslator(() => undefined);
    const freshText = collectText(bundle.exports.BackupPanelView(viewProps({ t: realT, status: { ok: true, state: { last_runtime_verify: record } } }))).join('\n');
    assert.ok(freshText.includes('缓存的运行时终审'), 'the cached block names what it is');
    assert.ok(freshText.includes('installed-harness'), 'the evidence label is shown verbatim');
    assert.ok(freshText.includes('24 小时内'));
    assert.equal(findBy(fresh, (node) => node.props?.['data-w2m-backup-runtime-stale'] !== undefined).length, 0);

    const busy = bundle.exports.BackupPanelView(viewProps({ status: { ok: true, state: { last_runtime_verify: record } }, busy: 'verify-runtime' }));
    assert.equal(actionButton(busy, 'verify-runtime').props.disabled, true, 'the button is disabled while the verdict runs');
    assert.ok(collectText(busy).join('\n').includes('panel.backup.busy.verifyRuntime'));

    const stale = bundle.exports.BackupPanelView(viewProps({ status: { ok: true, state: { last_runtime_verify: { ...record, finished_at: oldIso } } } }));
    assert.equal(marker(stale).props['data-w2m-backup-runtime-cached'], 'stale');
    assert.equal(findBy(stale, (node) => node.props?.['data-w2m-backup-runtime-stale'] !== undefined).length, 1, 'a stale badge is rendered');
    assert.ok(collectText(stale).join('\n').includes('panel.backup.verify.stale'));
  });

  it('renders the register-repair button/state and states the residual risk only for the file-write path', () => {
    const { bundle } = mountBackup();
    const scan = {
      available: true,
      total: 1,
      routeMissing: false,
      sessions: [{ session_id: 'sess-gamma-0003', workspace: 'proj-c', size: 1, archived: false, registered: false }],
    };
    const waiting = bundle.exports.BackupPanelView(viewProps());
    assert.equal(actionButton(waiting, 'repair-register').props.disabled, true, 'disabled until the read-only scan resolves');
    const ready = bundle.exports.BackupPanelView(viewProps({ scan }));
    assert.equal(actionButton(ready, 'repair-register').props.disabled, false, 'an unregistered session gives the button a target');
    assert.ok(collectText(ready).join('\n').includes('panel.backup.action.repairRegister'));

    const fileFix = bundle.exports.BackupPanelView(viewProps({
      scan,
      registerFix: {
        ok: true,
        via: 'file-write',
        registered: ['sess-gamma-0003'],
        already_registered: [],
        watch: { clobbered: 1, reapplied: 1 },
        residual_risk: 'a client save after the watch window can still remove it; re-run or enable the plugin route',
      },
    }));
    const fileText = collectText(fileFix).join('\n');
    assert.ok(fileText.includes('panel.backup.status.registerFix'));
    assert.ok(fileText.includes('panel.backup.register.done'));
    assert.ok(fileText.includes('panel.backup.register.residual'), 'the file-write path states its residual risk');
    assert.equal(findBy(fileFix, (node) => node.props?.['data-w2m-backup-register-residual'] !== undefined).length, 1);

    const hostFix = bundle.exports.BackupPanelView(viewProps({
      scan,
      registerFix: { ok: true, via: 'host-service', host_service: true, registered: ['sess-gamma-0003'], already_registered: [], residual_risk: null },
    }));
    assert.equal(
      findBy(hostFix, (node) => node.props?.['data-w2m-backup-register-residual'] !== undefined).length,
      0,
      'the host-service path has no file-level race to announce',
    );
  });

  it('drives the run-now runtime verdict and the register repair through their host routes', async () => {
    const statusBody = { ok: true, repository: { root: 'D:\\BackUP', initialized: true, counts: { snapshots: 1 }, free_bytes: 1_024 } };
    const cachedRecord = {
      started_at: '2026-11-17T07:00:00.000Z',
      finished_at: new Date().toISOString(),
      ok: true,
      checked: 2,
      failed: 0,
      snapshots: 1,
      reason_codes: [],
      evidence: 'installed-harness',
    };
    let verifyCalls = 0;
    let registerBody = null;
    const host = mountBackupPage(({ url, method, body }) => {
      if (url === '/api/w2m/backup/run') {
        if (method === 'POST') return { ok: true, snapshot_id: 'snap', sessions: 1, files: 1, blocks_new: 0, blocks_reused: 0, duration_ms: 1 };
        return {
          ok: true,
          enabled: true,
          backup_dir: 'D:\\BackUP',
          schedule: { times: ['22:00:00'], time_zone: 'UTC' },
          status: statusBody,
          state: { running: false, last_runtime_verify: cachedRecord },
        };
      }
      if (url === '/api/w2m/backup/status') return statusBody;
      if (url === '/api/w2m/backup/unlock') {
        return { ok: true, initialized: true, envelopes: ['machine'], machine_available: true, machine_reason: null, password_required: false };
      }
      if (url === '/api/w2m/backup/scan?detail=1') {
        return {
          ok: true,
          sessions: [{ session_id: 'sess-gamma-0003', workspace: 'proj-c', size: 1, flags: { registered: false, archived: false } }],
          totals: { sessions: 1 },
          registry: { ok: true },
        };
      }
      if (url === '/api/w2m/backup/verify?runtime=1') {
        verifyCalls += 1;
        return {
          ok: true,
          counts: { snapshots: 1, files: 1, blocks: 1, old: 0, current: 0 },
          problems: [],
          future_append: { checked: 1, failed: 0, evidence: 'static-prefilter' },
          runtime_verified: { checked: 2, failed: 0, evidence: 'installed-harness' },
          runtime_verify: { ...cachedRecord, checked: 2 },
        };
      }
      if (url === '/api/w2m/backup/register') {
        registerBody = body;
        return { ok: true, via: 'host-service', host_service: true, registered: ['sess-gamma-0003'], already_registered: [], changed: true, residual_risk: null };
      }
      return undefined;
    });
    try {
      await host.settle();
      const click = (action) => {
        const node = findBy(host.handle.tree, (element) => element.props?.['data-w2m-backup-action'] === action)[0];
        assert.ok(node !== undefined, `the ${action} action is rendered`);
        node.props.onClick();
      };
      click('verify-runtime');
      await host.settle();
      assert.equal(verifyCalls, 1, 'the run-now button posts the synchronous ?runtime=1');
      assert.ok(host.text().includes('缓存的运行时终审'), 'the cached block renders after the refresh');

      click('repair-register');
      await host.settle();
      assert.deepEqual(registerBody, { confirm: 'register', session_ids: ['sess-gamma-0003'] });
      assert.ok(host.text().includes('注册表修复'), 'the repair outcome is rendered');
      assert.deepEqual(host.unexpected, [], 'every request went to a route the panel is expected to use');
    } finally {
      host.handle.unmount();
    }
  });

  it('keeps the in-memory run log bounded to the last 50 entries', () => {
    const { exports } = loadBundle();
    const t = exports.makeTranslator(() => undefined);
    let entries = [];
    for (let index = 0; index < 60; index += 1) {
      entries = exports.appendBackupLog(entries, exports.backupLogEntry('run', { ok: true }));
    }
    assert.equal(exports.BACKUP_MAX_LOG, 50);
    assert.equal(entries.length, 50, 'the log never grows past its bound');
    assert.equal(entries[entries.length - 1].code, 'OK');
    const failure = exports.backupLogEntry('restore', { ok: false, reason_code: 'BACKUP_NO_PERMISSION', detail: 'x' });
    assert.equal(failure.code, 'BACKUP_NO_PERMISSION');
    assert.equal(failure.detail, 'x');
    assert.equal(exports.backupReasonText(failure.code, t), '没有权限：请用原账户登录，或输入解锁密码');
  });

  it('mounts the page twice on one document without leaking a stylesheet or a poll timer', () => {
    const document = makeFakeDocument();
    const intervals = new Set();
    const globals = {
      setInterval: (callback) => {
        const timer = { callback };
        intervals.add(timer);
        return timer;
      },
      clearInterval: (timer) => { intervals.delete(timer); },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    };
    const mountOnce = () => {
      const mountReact = makeMountReact();
      const registry = makeRegistry();
      const bundle = loadBundle({
        document,
        requireImpl: (specifier) => {
          if (specifier === 'react') return mountReact.React;
          throw new Error(`unexpected require(${specifier})`);
        },
        globals,
      });
      bundle.exports.apply({ slots: registry, effect: (callback) => callback(), get: () => undefined });
      // Other subplugins own timers of their own (they are disposed through ctx.effect); this test is
      // about the backup page's poll, so count the delta the page itself adds.
      const baseline = intervals.size;
      const page = registry.registered.find((entry) => entry.options.key === 'w2m-backup');
      assert.ok(page !== undefined, 'the backup page is registered');
      const handle = mountReact.mount(page.component, { t: (key) => key });
      assert.equal(intervals.size, baseline + 1, 'the mounted page owns exactly one poll timer');
      return {
        unmount() {
          handle.unmount();
          assert.equal(intervals.size, baseline, 'unmounting clears the page poll timer');
        },
      };
    };
    const first = mountOnce();
    assert.equal(document.appended.length, 1, 'the first mount installs exactly one stylesheet');
    first.unmount();
    assert.equal(document.removed.length, 0, 'unmounting does not remove the shared stylesheet');
    const second = mountOnce();
    assert.equal(document.appended.length, 1, 'a second mount in the same document reuses the one stylesheet');
    second.unmount();
  });
});

// ---------------------------------------------------------------------------------------------
// The 「编队版本」 card (v3.5.0)
// ---------------------------------------------------------------------------------------------
//
// The dashboard half of the version gate: `GET /api/w2m/target` already carries the `versions`
// block (`summarizeVersionDashboard` in `src/plugin/version-gate.mjs`), and `w2m_devices` returns
// the same shape. What is asserted here is that the card renders that block in the operation
// panel's actions section, that a missing/failed block is a stated "unknown" rather than an
// exception or an empty-looking fleet, and that the copy affordance works in a page and degrades
// to a no-op with no clipboard at all.

describe('client bundle: the 编队版本 card (v3.5.0)', () => {
  /** A `/api/w2m/target` snapshot with (or without) the versions block under test. */
  function versionSnapshot(versions) {
    return {
      session_id: 'sess-drift',
      selected: { machine_id: null, name: null, selected_at: null, online: null, stale: false },
      machines: [],
      fleet: { ok: true, error: null, online: 2, total: 3, excluded: 1, rabbit_time: null },
      ...(versions === undefined ? {} : { versions }),
      host: { local_machine_name: null, detail_unavailable: false },
      relays: null,
    };
  }

  /** The block a 3.5.0 host sends when one machine is behind and one cannot report its version. */
  function driftVersions() {
    return {
      supported_min: '3.5.0',
      distribution: { '3.5.0': 2, '3.4.5': 1 },
      outdated: [{ machine_id: 'win-old', version: '3.4.5' }],
      unknown: [{ machine_id: 'mac-unknown' }],
      all_current: false,
    };
  }

  /**
   * Mount one exported component with the hook-capable React stand-in and a fake fetch.
   *
   * Every request is recorded so a test can assert *which* route the card read; `settle()` runs the
   * effects (the read) and re-renders once the promise has landed.
   */
  function mountWith(options = {}) {
    const mountReact = makeMountReact();
    const requests = [];
    const respond = options.fetch ?? (async () => ({ ok: true, status: 200, json: async () => versionSnapshot(driftVersions()) }));
    const bundle = loadBundle({
      document: options.document,
      requireImpl: (specifier) => {
        if (specifier === 'react') return mountReact.React;
        throw new Error(`unexpected require(${specifier})`);
      },
      globals: {
        fetch: async (url, init) => {
          requests.push(String(url));
          return respond(String(url), init);
        },
        AbortController,
        ...(options.globals ?? {}),
      },
    });
    const t = bundle.exports.makeTranslator(() => undefined);
    const handle = mountReact.mount(bundle.exports[options.component ?? 'FleetVersionsCard'], {
      t,
      sessionId: options.sessionId ?? 'sess-drift',
    });
    const settle = async (rounds = 1) => {
      for (let round = 0; round < rounds; round += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        handle.rerender();
      }
    };
    return { bundle, handle, requests, t, settle };
  }

  it('renders inside the operation panel actions section, next to the fleet target control', async () => {
    const capabilityResponse = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, capability: null }) });
    const targetResponse = async () => ({ ok: true, status: 200, json: async () => versionSnapshot(driftVersions()) });
    const { handle, requests, settle } = mountWith({
      component: 'OpsActionsSection',
      fetch: async (url) => (url.startsWith('/api/w2m/capability') ? capabilityResponse() : targetResponse()),
    });
    await settle(3);

    const cards = findBy(handle.tree, (node) => node.props?.['data-w2m-fleet-version-card'] === 'true');
    assert.equal(cards.length, 1, 'the card is rendered in the actions section, not as a new panel');
    assert.ok(requests.some((url) => url.startsWith('/api/w2m/target')), 'it reads the same target snapshot as the target control');

    const text = collectText(handle.tree).join('\n');
    assert.ok(text.includes('编队版本'), 'the card title is the Chinese default');
    assert.ok(text.includes('最低支持版本: 3.5.0'), 'the supported minimum is rendered');
    const rows = findBy(handle.tree, (node) => node.props?.['data-w2m-version-row'] !== undefined);
    assert.deepEqual(rows.map((node) => node.props['data-w2m-version-row']), ['3.5.0', '3.4.5'],
      'the stock distribution keeps the host order, newest first');
    assert.ok(text.includes('3.5.0 × 2') && text.includes('3.4.5 × 1'), 'each distribution row is version × count');
    const outdated = findBy(handle.tree, (node) => node.props?.['data-w2m-version-outdated'] === 'true');
    assert.equal(outdated.length, 1, 'the outdated machine is listed');
    assert.ok(collectText(outdated[0]).join('').includes('win-old @ 3.4.5'), 'the outdated row is machine_id @ version');
    const unknown = findBy(handle.tree, (node) => node.props?.['data-w2m-version-unknown'] === 'true');
    assert.equal(unknown.length, 1, 'the unknown-version machine is listed');
    assert.ok(collectText(unknown[0]).join('').includes('mac-unknown'));
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-version-all-current'] === 'true').length, 0,
      'a drifting fleet does not show the all-current badge');

    // The refresh button re-reads the snapshot; the card is mounted, not polled, so this is the only
    // way the operator can ask again without leaving the tab.
    const readsBefore = requests.filter((url) => url.startsWith('/api/w2m/target')).length;
    findBy(handle.tree, (node) => node.props?.['data-w2m-version-refresh'] === 'true')[0].props.onClick();
    await settle();
    assert.equal(requests.filter((url) => url.startsWith('/api/w2m/target')).length, readsBefore + 1,
      'the refresh button re-fetches the target snapshot');
  });

  it('is mounted in the operation panel actions tab, with no new sidebar slot', () => {
    const source = readFileSync(BUNDLE_PATH, 'utf8');
    assert.ok(source.includes('function FleetVersionsCard('), 'the card exists');
    assert.ok(source.includes('function OpsActionsSection('), 'the section that owns it');
    const start = source.indexOf('function OpsActionsSection(');
    const end = source.indexOf('function FleetVersionsCard(', start);
    assert.ok(end > start, 'the card is declared after the section body');
    const section = source.slice(start, end);
    assert.ok(section.includes('h(FleetVersionsCard,'), 'the actions section renders the card');
    assert.ok(section.includes('h(TargetSelect,'), 'next to the fleet target control reading the same snapshot');
    assert.ok(source.includes("['actions', '操作入口']"), 'the operation-panel tab that shows the section');
    assert.ok(source.includes('h(OpsActionsSection, { t, sessionId })'), 'the panel body switches to that section');
    assert.equal(source.includes("id: 'w2m-fleet-versions'"), false, 'no extra sidebar entry was added for it');
  });

  it('an all-current fleet hides the outdated block and shows the badge', async () => {
    const { handle, settle } = mountWith({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => versionSnapshot({
          supported_min: '3.5.0',
          distribution: { '3.5.0': 3 },
          outdated: [],
          unknown: [],
          all_current: true,
        }),
      }),
    });
    await settle();
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-version-all-current'] === 'true').length, 1,
      'the all-current badge is shown');
    assert.equal(findBy(handle.tree, (node) => node.props?.['data-w2m-version-outdated'] === 'true').length, 0);
    const text = collectText(handle.tree).join('\n');
    assert.ok(!text.includes('落后机器'), 'the whole outdated block is hidden, not just its rows');
    assert.ok(text.includes('3.5.0 × 3'), 'the distribution is still rendered');
  });

  it('renders the neutral unavailable state for an older host or a failed read, without throwing', async () => {
    // ① a 2xx snapshot from a host that predates the versions block
    const older = mountWith({
      fetch: async () => ({ ok: true, status: 200, json: async () => versionSnapshot(undefined) }),
    });
    await older.settle();
    const olderCard = findBy(older.handle.tree, (node) => node.props?.['data-w2m-fleet-version-card'] === 'true');
    assert.equal(olderCard.length, 1, 'the card still renders');
    assert.equal(olderCard[0].props['data-w2m-version-state'], 'unavailable');
    assert.ok(collectText(older.handle.tree).join('\n').includes('版本信息未知'));
    assert.equal(findBy(older.handle.tree, (node) => node.props?.['data-w2m-version-copy'] === 'true').length, 0,
      'nothing honest to copy is offered without a block');

    // ② the route is absent on the host (404), which is how an older host answers
    const missing = mountWith({
      fetch: async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) }),
    });
    await missing.settle();
    assert.equal(findBy(missing.handle.tree, (node) => node.props?.['data-w2m-fleet-version-card'] === 'true')[0]
      .props['data-w2m-version-state'], 'unavailable');

    // ③ the fetch itself fails (host/relay down): a value, not an exception
    const failed = mountWith({
      fetch: async () => { throw new Error('host down'); },
    });
    await failed.settle();
    assert.equal(findBy(failed.handle.tree, (node) => node.props?.['data-w2m-fleet-version-card'] === 'true')[0]
      .props['data-w2m-version-state'], 'unavailable');

    // ④ the host answered, but its own roster read failed: the empty block it still sends must not
    //    be presented as a drift-free fleet.
    const unreadable = mountWith({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ...versionSnapshot({ supported_min: '3.5.0', distribution: {}, outdated: [], unknown: [], all_current: false }),
          fleet: { ok: false, error: 'the fleet could not be read', online: 0, total: 0, excluded: 0, rabbit_time: null },
        }),
      }),
    });
    await unreadable.settle();
    assert.equal(findBy(unreadable.handle.tree, (node) => node.props?.['data-w2m-fleet-version-card'] === 'true')[0]
      .props['data-w2m-version-state'], 'unavailable', 'an unreadable roster is "unknown", never "no outdated machines"');
  });

  it('copies the upgrade guidance through the clipboard and shows the copied state', async () => {
    const writes = [];
    const { handle, settle } = mountWith({
      globals: {
        navigator: { clipboard: { writeText: async (text) => { writes.push(text); } } },
      },
    });
    await settle();
    const copyButton = findBy(handle.tree, (node) => node.props?.['data-w2m-version-copy'] === 'true')[0];
    assert.ok(copyButton !== undefined, 'the copy button is rendered');
    assert.equal(collectText(copyButton).join(''), '一键复制升级指引');
    copyButton.props.onClick();
    await settle();
    assert.equal(writes.length, 1, 'the clipboard received the guidance exactly once');
    const guidance = writes[0];
    assert.ok(guidance.includes('升级到 @twinsearth/w2m-dsh-plugin@3.5.0'), 'the guidance names the target version');
    assert.ok(guidance.includes('npm i -g @twinsearth/w2m-dsh-plugin@3.5.0'), 'the npm command is in the guidance');
    assert.ok(guidance.includes('- win-old @ 3.4.5'), 'the outdated machine is named with its version');
    assert.ok(guidance.includes('- mac-unknown'), 'the unknown machine is named');
    const copiedButton = findBy(handle.tree, (node) => node.props?.['data-w2m-version-copy'] === 'true')[0];
    assert.equal(copiedButton.props['data-copied'], 'true', 'the copied state is visible');
    assert.equal(collectText(copiedButton).join(''), '已复制');
  });

  it('falls back to document.execCommand and is a safe no-op with no clipboard at all', async () => {
    // ① legacy path: navigator.clipboard is absent but the document can still copy
    let copyCalls = 0;
    let appended = 0;
    const legacyDocument = {
      body: { appendChild: () => { appended += 1; }, removeChild: () => {} },
      createElement: () => ({ style: {}, select: () => {}, value: '' }),
      execCommand: (command) => { copyCalls += 1; return command === 'copy'; },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const legacy = mountWith({ document: legacyDocument });
    await legacy.settle();
    findBy(legacy.handle.tree, (node) => node.props?.['data-w2m-version-copy'] === 'true')[0].props.onClick();
    await legacy.settle();
    assert.equal(copyCalls, 1, 'the legacy path ran exactly once');
    assert.equal(appended, 1, 'the textarea was attached for execCommand');
    assert.equal(findBy(legacy.handle.tree, (node) => node.props?.['data-w2m-version-copy'] === 'true')[0]
      .props['data-copied'], 'true');

    // ② headless: no navigator, no document body, no execCommand — no throw and no false claim
    const headlessDocument = {
      createElement: () => ({ style: {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const headless = mountWith({ document: headlessDocument });
    await headless.settle();
    const headlessCopy = findBy(headless.handle.tree, (node) => node.props?.['data-w2m-version-copy'] === 'true')[0];
    assert.doesNotThrow(() => headlessCopy.props.onClick());
    await headless.settle();
    const after = findBy(headless.handle.tree, (node) => node.props?.['data-w2m-version-copy'] === 'true')[0];
    assert.equal(after.props['data-copied'], 'false', 'a headless page never claims a copy it did not make');
    assert.equal(collectText(after).join(''), '一键复制升级指引');
  });

  it('registers the panel.fleet.version.* strings in both dictionaries', () => {
    const { exports } = loadBundle();
    const registry = makeRegistry();
    const locale = makeLocale();
    const ctx = makeStrictContext({ inject: [...exports.inject], services: { slots: registry, locale } });
    exports.apply(ctx);
    const dictionary = locale.registered.get('w2m.target');
    assert.ok(dictionary !== undefined, 'the dictionaries reach the locale service');
    const suffixes = [
      'title', 'supportedMin', 'distribution', 'outdated', 'unknown', 'allCurrent',
      'refresh', 'copyGuidance', 'copied', 'unavailable', 'noOutdated', 'guidanceTitle',
    ];
    for (const suffix of suffixes) {
      const key = `panel.fleet.version.${suffix}`;
      assert.equal(typeof dictionary.zh[key], 'string', `the zh dictionary has ${key}`);
      assert.equal(typeof dictionary.en[key], 'string', `the en dictionary has ${key}`);
      assert.notEqual(dictionary.zh[key].trim(), '', `the zh value for ${key} is not empty`);
      assert.notEqual(dictionary.en[key].trim(), '', `the en value for ${key} is not empty`);
    }
    assert.equal(dictionary.zh['panel.fleet.version.title'], '编队版本', 'Chinese is the default');
    assert.equal(dictionary.en['panel.fleet.version.title'], 'Fleet versions');
    assert.notEqual(dictionary.zh['panel.fleet.version.unavailable'], dictionary.en['panel.fleet.version.unavailable'],
      'the unavailable copy is translated, not copied');
  });

  it('normalizes a partial block defensively and refuses to build guidance from an unusable one', () => {
    const { exports } = loadBundle();
    const block = exports.fleetVersionBlock({
      versions: {
        supported_min: '3.5.0',
        distribution: { '3.5.0': 2, '': 1, '3.4.5': 'x' },
        outdated: [{ machine_id: 'win-old', version: '3.4.5' }, { machine_id: '', version: '3.4.0' }],
        unknown: [{ machine_id: 'mac-unknown' }, null],
        all_current: false,
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(block)), {
      supported_min: '3.5.0',
      distribution: [{ version: '3.5.0', count: 2 }],
      outdated: [{ machine_id: 'win-old', version: '3.4.5' }],
      unknown: [{ machine_id: 'mac-unknown' }],
      all_current: false,
    }, 'unnamed machines and non-numeric counts are dropped, not guessed at');
    assert.equal(exports.fleetVersionBlock(null), null);
    assert.equal(exports.fleetVersionBlock(undefined), null);
    assert.equal(exports.fleetVersionBlock({}), null, 'a host without the block is unavailable');
    assert.equal(exports.fleetVersionBlock({ versions: null }), null);
    assert.equal(exports.fleetVersionBlock({ versions: { distribution: {} } }), null,
      'no supported_min means no comparison, so the block is unusable');
    assert.equal(exports.buildVersionGuidance(null, exports.makeTranslator(() => undefined)), '');
    assert.equal(exports.buildVersionGuidance({ supported_min: '' }, exports.makeTranslator(() => undefined)), '');
  });
});

