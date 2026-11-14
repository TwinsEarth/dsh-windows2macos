/**
 * Mount wrapper for W2M's decision center.
 *
 * The ported plugin module (`./index.mjs`) is kept verbatim in shape: it provides the store service
 * and registers the Agent tool. Fang's routes lived in its orchestrator, a component W2M does not
 * have, so this wrapper attaches them to the same Cordis context the plugin was applied to -- one
 * mount point for a profile row, and the subpath export stays a seam rather than a second
 * implementation.
 */
import { apply as applyCenter, Config, _internals, inject, name } from './index.mjs';
import { registerDecisionCenterRoutes } from './routes.mjs';

export { Config, _internals, inject, name };

/**
 * Apply the decision center and mount its HTTP surface.
 *
 * @param {object} ctx Cordis context.
 * @param {object} config plugin configuration (see `Config`).
 * @returns {unknown} whatever the ported apply returns.
 */
export function apply(ctx, config) {
  const result = applyCenter(ctx, config);
  registerDecisionCenterRoutes(ctx);
  return result;
}
