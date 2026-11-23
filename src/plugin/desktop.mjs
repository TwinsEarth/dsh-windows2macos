/**
 * desktop subplugin entry.
 *
 * Structure mirrors GPW: the host half lives here (routes), the client half is
 * the root package's `lib/client.js`. Mounting both the root plugin and
 * `/desktop` must not register the routes twice; a module-level WeakSet is the
 * idempotency guard because both entries share this module instance.
 */
import { registerRemoteViewRoutes } from './remote-view-route.mjs';
import { getSharedWebRtcPool } from './webrtc-pool-registry.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-w2m-desktop';
export const inject = ['connection'];

/**
 * Availability probe (v3.5.6/B1): a constant 200 while this row is mounted.
 *
 * `lib/client.js` polls it before it registers the remote-view sidebar entry and main page. The answer
 * carries nothing about consent or credentials -- it only says "this row is mounted" -- so it is safe on
 * a loopback page and creates no state.
 */
export const DESKTOP_HEALTH_ROUTE = '/api/w2m/desktop/health';

const NO_STORE = { 'cache-control': 'no-store' };

const registered = new WeakSet();

/**
 * @param {object} ctx Cordis context
 * @param {{stateDir?:string, p2p?:object|null, getPool?:()=>object|null}} [deps]
 *   `getPool` is optional: when omitted, the route resolves the process-wide shared pool on every
 *   `/start`, so a root row mounted before the pool exists is not frozen to relay.
 */
export function registerDesktop(ctx, deps = {}) {
  if (ctx === null || typeof ctx !== 'object') return { mounted: false, reason: 'no ctx' };
  if (registered.has(ctx)) return { mounted: false, reason: 'already registered' };
  registered.add(ctx);
  const options = {
    stateDir: typeof deps.stateDir === 'string' ? deps.stateDir : '',
    p2p: deps.p2p ?? null,
  };
  // Omit `getPool` when the caller has none: `remote-view-route` then falls back to the process-wide
  // registry at request time. Passing `() => null` here would freeze the root row to relay forever if
  // it mounted before the shared pool existed.
  if (typeof deps.getPool === 'function') options.getPool = deps.getPool;
  return registerRemoteViewRoutes(ctx, options);
}

/**
 * Register the row's availability probe.
 *
 * Deliberately **not** part of {@link registerDesktop}: `src/plugin/tools.mjs` (the root row) also calls
 * that function, because the remote-view routes are host fallbacks the root row needs. A probe mounted
 * there would answer 200 on every profile -- including one where the `dsh-desktop` row is disabled --
 * and the client would then show the 远程桌面 surface for a row that is not mounted. Only this row's own
 * `apply` means "the desktop surface is enabled".
 *
 * @param {object} ctx Cordis context
 * @returns {boolean} whether an injectable context was available
 */
export function registerDesktopHealthRoute(ctx) {
  if (typeof ctx?.inject !== 'function') return false;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') return;
    registry.register({
      path: DESKTOP_HEALTH_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => Response.json({ ok: true, row: 'dsh-desktop', mounted: true }, { headers: NO_STORE }),
    });
  });
  return true;
}

/**
 * Profile row `@twinsearth/w2m-dsh-plugin/desktop` mounts this. The root bundle
 * owns the UI; this half only registers the host routes.
 */
export function apply(ctx) {
  const stateDir = process.env.W2M_STATE_DIR
    ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'xclient') : join(homedir(), '.dsh', 'xclient'));
  const status = registerDesktop(ctx, { stateDir, p2p: null, getPool: getSharedWebRtcPool });
  registerDesktopHealthRoute(ctx);
  return status;
}
