/**
 * desktop subplugin entry.
 *
 * Structure mirrors GPW: the host half lives here (routes), the client half is
 * the root package's `lib/client.js`. Mounting both the root plugin and
 * `/desktop` must not register the routes twice; a module-level WeakSet is the
 * idempotency guard because both entries share this module instance.
 */
import { registerRemoteViewRoutes } from './remote-view-route.mjs';

export const name = 'dsh-w2m-desktop';
export const inject = ['connection'];

const registered = new WeakSet();

/**
 * @param {object} ctx Cordis context
 * @param {{stateDir?:string, p2p?:object|null}} [deps]
 */
export function registerDesktop(ctx, deps = {}) {
  if (ctx === null || typeof ctx !== 'object') return { mounted: false, reason: 'no ctx' };
  if (registered.has(ctx)) return { mounted: false, reason: 'already registered' };
  registered.add(ctx);
  return registerRemoteViewRoutes(ctx, {
    stateDir: typeof deps.stateDir === 'string' ? deps.stateDir : '',
    p2p: deps.p2p ?? null,
  });
}

/**
 * Profile row `@twinsearth/w2m-dsh-plugin/desktop` mounts this. The root bundle
 * owns the UI; this half only registers the host routes.
 */
export function apply(ctx) {
  const stateDir = typeof ctx?.config?.stateDir === 'string' ? ctx.config.stateDir : '';
  return registerDesktop(ctx, { stateDir, p2p: null });
}
