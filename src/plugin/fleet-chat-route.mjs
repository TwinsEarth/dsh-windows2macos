/**
 * `/api/w2m/chat` — the browser-facing half of fleet chat (v1.1.17 shipped the tool only; this
 * module is the missing host route the composer's chat panel calls).
 *
 * The route proxies the relay's device-gated `/v1/fleet/messages` endpoints with this machine's
 * device token. The browser never sees the token: it calls this same-origin route, which is inside
 * the host's authentication fence, exactly like `/api/w2m/target`.
 *
 * Wire:
 *   GET  /api/w2m/chat?session_id=…&since_ms=…&limit=…   -> relay list shape passed through
 *   POST /api/w2m/chat  { session_id, text }              -> relay send shape passed through
 *
 * Failure is a value here: `{ok:false, error, reason_code, detail}` with a non-2xx status, so the
 * panel can print the host's own words. A relay that predates the fleet-messages routes answers
 * 404, which is reported as such rather than as an empty conversation.
 */
export const CHAT_ROUTE_PATH = '/api/w2m/chat';
export const MAX_SESSION_ID_LENGTH = 200;

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Attach the route to one host's fetch registry, recording the outcome on `status`.
 *
 * @param {object} ctx the plugin context (a Cordis fiber)
 * @param {{cfg: () => object, request: Function, resolveToken: () => Promise<string|null>}} deps
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerChatRoutes(ctx, deps) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || registry === null || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    try {
      registry.register({
        path: CHAT_ROUTE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const refuse = (httpStatus, reasonCode, error, detail) =>
            Response.json({ ok: false, error, reason_code: reasonCode, detail }, { status: httpStatus, headers: NO_STORE });

          if (request.method !== 'GET' && request.method !== 'POST') {
            return refuse(405, 'CHAT_METHOD_NOT_ALLOWED', `${request.method} is not answered here`, 'GET lists a session; POST sends a message');
          }

          const url = new URL(request.url);
          const sessionIdOf = (value) => (typeof value === 'string' ? value.trim() : '');
          let sessionId = '';
          let text = null;
          if (request.method === 'GET') {
            sessionId = sessionIdOf(url.searchParams.get('session_id'));
          } else {
            let body;
            try {
              body = await request.json();
            } catch {
              return refuse(400, 'CHAT_BODY_NOT_JSON', 'body is not JSON', 'send {"session_id":"…","text":"…"}');
            }
            sessionId = sessionIdOf(body?.session_id);
            text = typeof body?.text === 'string' ? body.text : null;
          }
          if (sessionId === '') return refuse(400, 'CHAT_SESSION_ID_REQUIRED', '`session_id` is required', 'chat is scoped to one conversation');
          if (sessionId.length > MAX_SESSION_ID_LENGTH) {
            return refuse(400, 'CHAT_SESSION_ID_TOO_LONG', `\`session_id\` must be at most ${MAX_SESSION_ID_LENGTH} characters`, 'send the id the host gave this session');
          }

          const cfg = deps.cfg();
          const rabbitUrl = cfg?.rabbitUrl ?? null;
          if (rabbitUrl === null) return refuse(503, 'CHAT_NO_RELAY', 'no relay is configured', 'set rabbitUrl in the profile patch');
          let token;
          try {
            token = await deps.resolveToken();
          } catch (error) {
            return refuse(503, 'CHAT_UNPAIRED', `this machine has no device token: ${error instanceof Error ? error.message : String(error)}`, 'pair the machine first (autoStartAgent or a pairing code)');
          }
          if (typeof token !== 'string' || token === '') {
            return refuse(503, 'CHAT_UNPAIRED', 'this machine has no device token', 'pair the machine first (autoStartAgent or a pairing code)');
          }

          try {
            if (request.method === 'GET') {
              const query = { session_id: sessionId };
              const sinceMs = url.searchParams.get('since_ms');
              const limit = url.searchParams.get('limit');
              if (sinceMs !== null && /^\d+$/.test(sinceMs)) query.since_ms = sinceMs;
              if (limit !== null && /^\d+$/.test(limit)) query.limit = limit;
              const listed = await deps.request({ rabbitUrl, token, method: 'GET', pathname: '/v1/fleet/messages', query, signal: request.signal });
              if (listed?.ok !== true) {
                const code = listed?.json?.error?.code ?? listed?.error?.code ?? 'CHAT_LIST_REFUSED';
                const message = listed?.json?.error?.message ?? listed?.error?.message ?? `the relay answered HTTP ${listed?.status ?? 0}`;
                return refuse(listed?.status === 404 ? 502 : 502, code, message, 'the relay must run a version with /v1/fleet/messages (>= 1.1.17) and be restarted');
              }
              return Response.json({ ...listed.json, ok: true }, { headers: NO_STORE });
            }
            const posted = await deps.request({ rabbitUrl, token, method: 'POST', pathname: '/v1/fleet/messages', body: { session_id: sessionId, text: text ?? '' }, signal: request.signal });
            if (posted?.ok !== true) {
              const code = posted?.json?.error?.code ?? posted?.error?.code ?? 'CHAT_SEND_REFUSED';
              const message = posted?.json?.error?.message ?? posted?.error?.message ?? `the relay answered HTTP ${posted?.status ?? 0}`;
              return refuse(posted?.status === 404 ? 502 : 400, code, message, 'quota, size and non-text are each refused by name; 404 means the relay predates fleet chat');
            }
            return Response.json({ ...posted.json, ok: true }, { headers: NO_STORE });
          } catch (error) {
            return refuse(502, 'CHAT_RELAY_ERROR', `the relay call failed: ${error instanceof Error ? error.message : String(error)}`, 'check the relay and this machine token');
          }
        },
      });
      status.mounted = true;
      status.reason = null;
    } catch (error) {
      status.reason = error instanceof Error ? error.message : String(error);
      ctx?.logger?.warn?.(`w2m: the fleet chat route is inactive — ${status.reason}`);
    }
  });
  return status;
}
