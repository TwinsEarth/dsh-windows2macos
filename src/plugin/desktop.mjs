/**
 * desktop subplugin entry.
 *
 * Structure mirrors GPW: the host half lives here (routes), the client half is
 * the root package's `lib/client.js`. Mounting both the root plugin and
 * `/desktop` must not register the routes twice; a module-level WeakSet is the
 * idempotency guard because both entries share this module instance.
 */
import { registerRemoteViewRoutes } from './remote-view-route.mjs';
import { getSharedWebRtcPool, getSharedWebRtcPoolState } from './webrtc-pool-registry.mjs';
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
 * @param {{stateDir?:string, p2p?:object|null, getPool?:()=>object|null, getPoolState?:()=>object|null,
 *   transport?:'auto'|'webrtc'|'relay', allowLegacyP2P?:boolean,
 *   prepareTimeoutMs?:number, handshakeTimeoutMs?:number, ackPollMs?:number,
 *   punchAttempts?:number, punchBackoffMs?:number}} [deps]
 *   `getPool` is optional: when omitted, the route resolves the process-wide shared pool on every
 *   `/start`, so a root row mounted before the pool exists is not frozen to relay. Row options are
 *   defaults only: a `transport` written in `remote-view.json` always wins; when the file exists
 *   without `transport`, the row default applies. The built-in default is `webrtc`.
 */
export function registerDesktop(ctx, deps = {}) {
  if (ctx === null || typeof ctx !== 'object') return { mounted: false, reason: 'no ctx' };
  if (registered.has(ctx)) return { mounted: false, reason: 'already registered' };
  registered.add(ctx);
  const options = {
    stateDir: typeof deps.stateDir === 'string' ? deps.stateDir : '',
    p2p: deps.p2p ?? null,
  };
  // Only forward options the row actually supplied. Passing `transport: undefined` would make the
  // route believe an explicit row choice existed and would hide `transport_source:'default'`.
  if (Object.hasOwn(deps, 'transport')) options.transport = deps.transport;
  if (Object.hasOwn(deps, 'allowLegacyP2P')) options.allowLegacyP2P = deps.allowLegacyP2P === true;
  if (Number.isInteger(deps.prepareTimeoutMs) && deps.prepareTimeoutMs > 0) {
    options.prepareTimeoutMs = deps.prepareTimeoutMs;
  }
  if (Number.isInteger(deps.handshakeTimeoutMs) && deps.handshakeTimeoutMs > 0) {
    options.handshakeTimeoutMs = deps.handshakeTimeoutMs;
  }
  if (Number.isInteger(deps.ackPollMs) && deps.ackPollMs > 0) {
    options.ackPollMs = deps.ackPollMs;
  }
  if (Number.isInteger(deps.punchAttempts) && deps.punchAttempts > 0) {
    options.punchAttempts = deps.punchAttempts;
  }
  if (Number.isInteger(deps.punchBackoffMs) && deps.punchBackoffMs > 0) {
    options.punchBackoffMs = deps.punchBackoffMs;
  }
  // Omit `getPool` when the caller has none: `remote-view-route` then falls back to the process-wide
  // registry at request time. Passing `() => null` here would freeze the root row to relay forever if
  // it mounted before the shared pool existed.
  if (typeof deps.getPool === 'function') options.getPool = deps.getPool;
  if (typeof deps.getPoolState === 'function') options.getPoolState = deps.getPoolState;
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
 *
 * @param {object} ctx
 * @param {{transport?:'auto'|'webrtc'|'relay', allowLegacyP2P?:boolean,
 *   prepareTimeoutMs?:number, handshakeTimeoutMs?:number, ackPollMs?:number,
 *   punchAttempts?:number, punchBackoffMs?:number}} [config] Row config, used only when
 *   `remote-view.json` does not exist yet.
 */
export function apply(ctx, config = {}) {
  const row = config ?? {};
  const stateDir = process.env.W2M_STATE_DIR
    ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'xclient') : join(homedir(), '.dsh', 'xclient'));
  const options = {
    stateDir,
    p2p: null,
    getPool: getSharedWebRtcPool,
    getPoolState: getSharedWebRtcPoolState,
    allowLegacyP2P: row.allowLegacyP2P === true,
  };
  if (Object.hasOwn(row, 'transport')) options.transport = row.transport;
  if (Number.isInteger(row.prepareTimeoutMs) && row.prepareTimeoutMs > 0) {
    options.prepareTimeoutMs = row.prepareTimeoutMs;
  }
  if (Number.isInteger(row.handshakeTimeoutMs) && row.handshakeTimeoutMs > 0) {
    options.handshakeTimeoutMs = row.handshakeTimeoutMs;
  }
  if (Number.isInteger(row.ackPollMs) && row.ackPollMs > 0) {
    options.ackPollMs = row.ackPollMs;
  }
  if (Number.isInteger(row.punchAttempts) && row.punchAttempts > 0) {
    options.punchAttempts = row.punchAttempts;
  }
  if (Number.isInteger(row.punchBackoffMs) && row.punchBackoffMs > 0) {
    options.punchBackoffMs = row.punchBackoffMs;
  }
  const status = registerDesktop(ctx, options);
  registerDesktopHealthRoute(ctx);
  return status;
}
