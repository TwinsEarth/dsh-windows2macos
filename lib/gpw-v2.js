/**
 * Package-facing entry for GPW-V2: `@twinsearth/w2m-dsh-plugin/gpw-v2`.
 *
 * A seam, not a second implementation. The five-level ladder lives in `src/plugin/gpw-v2-risk.mjs`;
 * the gate, folder lists and operator routes are shared with `src/plugin/gpw.mjs` via `applyV2`.
 *
 * **It is deliberately not re-exported from `lib/index.js`.** The package root installs by default, and
 * a permission gate must not arrive because someone installed a fleet tool. The bundle patch ships this
 * row `disabled: true`; the operator enables it in the plugin manager.
 *
 * Do not enable this row and `dsh-gpw` together: both answer `/api/w2m/gpw/*`. The original GPW row is
 * the fallback, not a second live gate.
 */
export const name = 'dsh-gpw-v2';
export const inject = ['permissionPresets'];
export { applyV2 as apply } from '../src/plugin/gpw.mjs';
