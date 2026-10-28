/**
 * `/api/w2m/project-stream` (A6): authenticated SSE proxy for the read-only project panel.
 *
 * The browser cannot set an Authorization header on EventSource, and the device token must not be
 * exposed to client code. This route takes the project id and cursor from the local user, attaches
 * the device token server-side and streams the relay's frames through unchanged (including the
 * PROJECT_REPLAY_TRUNCATED notice).
 */
export const PROJECT_STREAM_ROUTE_PATH = '/api/w2m/project-stream';
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * @param {object} ctx Cordis context
 * @param {{relayUrl?: () => string|null, deviceToken?: () => Promise<string|null>|string|null}} [deps]
 */
export function registerProjectStreamRoute(ctx, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    registry.register({
      path: PROJECT_STREAM_ROUTE_PATH,
      methods: ['GET'],
      fetch: async (request) => {
        const url = new URL(request.url ?? 'http://local.invalid/api/w2m/project-stream');
        const projectId = url.searchParams.get('project_id') ?? '';
        if (!/^[A-Za-z0-9._-]{1,80}$/.test(projectId)) {
          return Response.json({ ok: false, code: 'PROJECT_ID_INVALID' }, { status: 400, headers: NO_STORE });
        }
        const sinceRaw = url.searchParams.get('since_seq') ?? '0';
        if (!/^[0-9]+$/.test(sinceRaw)) return Response.json({ ok: false, code: 'PROJECT_CURSOR_INVALID' }, { status: 400, headers: NO_STORE });
        const relayUrl = typeof deps?.relayUrl === 'function' ? deps.relayUrl() : null;
        if (typeof relayUrl !== 'string' || relayUrl === '') return Response.json({ ok: false, code: 'RELAY_URL_REQUIRED' }, { status: 503, headers: NO_STORE });
        const token = typeof deps?.deviceToken === 'function' ? await deps.deviceToken() : null;
        if (typeof token !== 'string' || token === '') return Response.json({ ok: false, code: 'DEVICE_TOKEN_REQUIRED' }, { status: 503, headers: NO_STORE });
        const target = relayUrl.replace(/\/$/, '') + '/v1/projects/' + encodeURIComponent(projectId) + '/stream?since_seq=' + sinceRaw;
        let upstream = null;
        try {
          upstream = await fetch(target, { headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' }, signal: request.signal });
        } catch {
          return Response.json({ ok: false, code: 'PROJECT_STREAM_UNAVAILABLE' }, { status: 502, headers: NO_STORE });
        }
        if (upstream.ok !== true || upstream.body === null) return Response.json({ ok: false, code: 'PROJECT_STREAM_REFUSED', http_status: upstream.status }, { status: 502, headers: NO_STORE });
        return new Response(upstream.body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
        });
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}
