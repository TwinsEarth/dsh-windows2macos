/**
 * Package-facing plugin entry: `@twinsearth/w2m-dsh-plugin/tools`.
 *
 * The documented subpath entry point, and the seam between the published package
 * layout (`lib/`, what npm ships as the documented entry) and the implementation
 * (`src/`, where the code is actually readable).
 *
 * `cordis.patch.yml` mounts the package *root* (`lib/index.js`), which re-exports
 * this file, because the client module system only recognises a package whose
 * Loader row carries the bare package specifier. Both paths land on the same
 * `apply` and `inject` -- `test/tools.test.mjs` asserts that -- so this remains a
 * supported mount point for a profile that prefers it.
 *
 * Nothing is re-implemented here on purpose: a second definition of the plugin
 * surface would be a second thing to keep in sync.
 */
export { apply, inject, resetDefineToolCacheForTests } from '../src/plugin/tools.mjs';
