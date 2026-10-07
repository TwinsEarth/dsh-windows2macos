/**
 * Intentionally empty plugin entry point.
 *
 * The profile mounts this package's `tools` subpath -- named explicitly by
 * `cordis.patch.yml`'s insert entry -- so that reading the profile tells you
 * which module of the package becomes the plugin, instead of relying on a
 * "root export is the plugin" convention.
 *
 * This file exists only so the manifest never points at a path that does not
 * resolve. All real behaviour lives in `../src/plugin/tools.mjs`, re-exported
 * through `./tools.js`.
 */
export {};
