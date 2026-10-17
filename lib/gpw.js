/**
 * Package-facing entry for DSH-GPW: `@twinsearth/w2m-dsh-plugin/gpw`.
 *
 * The documented subpath a profile row names to enable the watchdog. A seam, not a second implementation -- the code
 * lives in `src/plugin/gpw.mjs`, which is where it is readable.
 *
 * **It is deliberately not re-exported from `lib/index.js`.** The package root is what installs by default, and a
 * permission-answering plugin must not arrive because someone installed a fleet tool.
 */
export { apply, inject, name } from '../src/plugin/gpw.mjs';
