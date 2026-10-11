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
 * So the bundle is loaded here for real, against a stand-in module loader, and three things are
 * asserted:
 *
 *   1. **The entry shape is what the module system expects** — one `load()` call, the id equal to
 *      the package name (the boot graph addresses the row by package), and a factory that returns an
 *      object carrying `apply`.
 *   2. **The registration is the seat the task requires** — announced through `slots.inject` on
 *      `conversation.input.left` and registered there with a unique id and a positive order, so it
 *      lands to the *right* of the shipped permission control rather than competing with it.
 *   3. **The stylesheet is installed once and owned** — a second `apply` in the same document must
 *      not add a second `<style>`, and the disposer handed to `ctx.effect` must remove the one tag
 *      it added. A control that leaks a stylesheet per reload is a page that slowly rots.
 *
 * React is stubbed and nothing is rendered: the pixels are the GUI observation's business. What this
 * file covers is everything that would stop the control from ever rendering — the entry shape, the
 * seat, the injection contract, and the stylesheet's lifecycle. It is a **bundle-loading test, not a
 * renderer**: no attempt is made to emulate a React tree or a browser.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { TARGET_ROUTE_PATH } from '../src/plugin/fleet-target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(HERE, '..', 'lib', 'client.js');

/** The slot the control occupies, and the seat the task forbids it from touching. */
const SEAT = 'conversation.input.left';
const FORBIDDEN_SEAT = 'conversation.input.permission';

/**
 * Load `lib/client.js` the way the module system does.
 *
 * The bundle is a **script**, not a module: it registers itself on `window.__ModuleLoader__` and
 * expects `window`, `document`, `require` and `module` to exist. `node:vm` is how a test can run it
 * with exactly those four bindings and no network, instead of the `Function` constructor ESLint
 * (rightly) refuses.
 *
 * @param {{document?: object|null, requireImpl?: (specifier: string) => unknown}} [options]
 * @returns {{loads: object[], exports: object, module: object, window: object, document: object|null}}
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
  const context = vm.createContext({ window, document: hostDocument, require: requireImpl, module, exports: module.exports });
  // The filename is only for stack traces; `timeout` bounds a bundle that loops forever.
  vm.runInContext(source, context, { filename: BUNDLE_PATH, timeout: 5_000 });
  assert.equal(loads.length, 1, 'a client bundle must register exactly one factory');
  const exports = loads[0].factory(requireImpl);
  return { loads, exports, module, window, document: hostDocument };
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
    assert.equal(exports.inject.length, 0, 'the control needs no Cordis service');
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

  it('announces and registers exactly conversation.input.left', () => {
    const { announced, registered } = applyTo();
    assert.deepEqual(announced, [SEAT]);
    assert.equal(registered.length, 1);
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
    assert.equal(registered.length, 1);
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
});
