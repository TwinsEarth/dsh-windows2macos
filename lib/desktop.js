/**
 * Package-facing entry for the desktop subplugin:
 *   @twinsearth/w2m-dsh-plugin/desktop
 *
 * Host half only; the root package's lib/client.js owns the UI (same shape as GPW).
 */
export { apply, inject, name, registerDesktop } from '../src/plugin/desktop.mjs';
