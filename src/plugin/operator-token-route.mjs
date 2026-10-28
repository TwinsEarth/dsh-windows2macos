/**
 * `/api/w2m/operator-token` (v2 S0-1): the settings-page half of the secure token setup.
 *
 * Wire:
 *   GET  /api/w2m/operator-token -> { ok, configured, source, fingerprint, path }
 *   POST /api/w2m/operator-token { token } -> { ok, configured: true, source: 'file', fingerprint, path }
 *
 * The token value is written straight into the 0600 file and never echoed back: the response carries
 * only a fingerprint, so the page can confirm "configured" without the secret ever entering a log,
 * a transcript or the DOM's value after the save.
 */
import { fingerprintOf, readOperatorToken, writeOperatorToken } from './operator-token.mjs';

export const OPERATOR_TOKEN_ROUTE_PATH = '/api/w2m/operator-token';
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * @param {object} ctx Cordis context
 * @param {{path?: () => string|null, configuredToken?: () => string|null}} [deps]
 */
export function registerOperatorTokenRoute(ctx, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    const pathOf = () => {
      const configured = typeof deps?.path === 'function' ? deps.path() : null;
      return typeof configured === 'string' && configured !== '' ? configured : undefined;
    };
    registry.register({
      path: OPERATOR_TOKEN_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          const path = pathOf();
          const read = path === undefined ? readOperatorToken() : readOperatorToken({ path });
          const configuredToken = typeof deps?.configuredToken === 'function' ? deps.configuredToken() : null;
          const fromFile = read.configured === true;
          const source = fromFile ? 'file' : (typeof configuredToken === 'string' && configuredToken !== '' ? 'config-or-env' : null);
          return Response.json({
            ok: true,
            configured: fromFile || source !== null,
            source,
            fingerprint: fromFile ? read.fingerprint : (source === null ? null : fingerprintOf(configuredToken)),
            path: read.path ?? path ?? null,
          }, { headers: NO_STORE });
        }
        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        const token = typeof body?.token === 'string' ? body.token : '';
        if (token.trim() === '') {
          return Response.json({ ok: false, code: 'OPERATOR_TOKEN_REQUIRED' }, { status: 400, headers: NO_STORE });
        }
        const path = pathOf();
        const written = path === undefined ? writeOperatorToken(token) : writeOperatorToken(token, { path });
        if (written.ok !== true) {
          return Response.json({ ok: false, code: written.code, detail: written.detail ?? null }, { status: 400, headers: NO_STORE });
        }
        return Response.json({ ok: true, configured: true, source: 'file', fingerprint: written.fingerprint, path: written.path }, { headers: NO_STORE });
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}
