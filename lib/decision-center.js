/**
 * Package-facing entry for W2M's decision center: `@twinsearth/w2m-dsh-plugin/decision-center`.
 *
 * The documented subpath a profile row names to mount the center. A seam, not a second
 * implementation -- the code lives in `src/decision-center/`, which is where it is readable.
 *
 * Like GPW, it is deliberately **not** re-exported from `lib/index.js`: the package root installs by
 * default, and a human-attention queue must not arrive because someone installed a fleet tool.
 */
export { apply, inject, name, Config, _internals } from '../src/decision-center/index.mjs';
