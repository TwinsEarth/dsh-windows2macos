/**
 * Package root entry.
 *
 * TWO READERS, ONE EXPORT LIST
 *
 * `cordis.patch.yml` mounts this file: the profile reads the patch, sees
 * `@twinsearth/w2m-dsh-plugin`, and loads `./index.js`. It names the *package* rather than the
 * `tools` subpath on purpose, and the reason is measured rather than stylistic: the client module
 * system (`@deepseek-ai/dsh-client-modules`) identifies a client package by the specifier its Loader
 * row carries (`exactPackageSpecifier`), so a row naming `…/tools` resolves to no package.json at all
 * — `dsh.client` is never read and the browser half is never composed into `__DSH_BOOT__`. The host
 * would keep working and the composer control would silently never arrive; that is what v0.5.4
 * shipped, and `test/loader-entry.test.mjs` now catches it through the real Loader.
 *
 * `./tools.js` remains a supported mount point for anyone who wants it, and it is still what the
 * DSH plugin listing requirements look at: the checklist asks for a package that "exports an
 * `apply(ctx)` module", and this root is that module. It used to be documentation only, so importing
 * the package root yielded **no exports at all** (`Object.keys() === []`): a plugin that works
 * perfectly when mounted by its patch and looks like an empty package to every tool that inspects it.
 * That is a bad trade for one re-export line.
 *
 * WHY NOT MOVE THE PLUGIN HERE
 *
 * Re-exporting is not relocating: `./tools.js` stays the single definition, so there is still
 * exactly one implementation of the plugin surface to keep in sync. Mounting *both* this entry and
 * the subpath would register the eight tools twice, which is why the patch mounts exactly one of
 * them.
 */
export { apply, inject, resetDefineToolCacheForTests } from './tools.js';
