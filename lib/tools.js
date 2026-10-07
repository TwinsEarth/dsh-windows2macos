/**
 * Package-facing plugin entry: `@twinsearth/w2m-dsh-plugin/tools`.
 *
 * This is the module named by `cordis.patch.yml`, so it is the seam between the
 * published package layout (`lib/`, what npm ships as the documented entry) and
 * the implementation (`src/`, where the code is actually readable).
 *
 * Nothing is re-implemented here on purpose: a second definition of the plugin
 * surface would be a second thing to keep in sync.
 */
export { apply, inject, default } from '../src/plugin/tools.mjs';
