/**
 * `/api/w2m/capability` — the host half of the UI-activated Node-code-execution switch.
 *
 * The composer's capability control (lib/client.js) reads and writes this same-origin route; the route owns
 * the machine-local file (`~/.w2m/exec-capability.json`) so the browser never touches the filesystem and the
 * device token never enters the page. The agent reads the same file before every task, which is what makes an
 * activation effective without restarting the agent.
 *
 * Wire:
 *   GET  /api/w2m/capability            -> { ok, capability: describeExecCapability(...) }
 *   POST /api/w2m/capability            { state: 'denied'|'temporary'|'permanent', ttl_ms? }
 *                                       -> { ok, capability }
 *
 * The states are the three choices an operator gets: refuse, temporary (24 h default) or permanent. There is no
 * fourth, and the prefix it can add is fixed in the util module (`node -e`).
 */
import {
  EXEC_CAPABILITY_ROUTE_PATH,
  describeExecCapability,
  writeExecCapability,
} from '../util/exec-capability.mjs';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Mount the route on the host's Connection fetch registry.
 *
 * @param {object} ctx Cordis context
 * @param {{capabilityFile: () => string}} deps
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerExecCapabilityRoutes(ctx, deps) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    registry.register({
      path: EXEC_CAPABILITY_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'GET' && request.method !== 'POST') {
          return Response.json({ ok: false, error: request.method + ' is not a method this route answers', reason_code: 'METHOD_NOT_ALLOWED' }, { status: 405, headers: NO_STORE });
        }
        const file = deps.capabilityFile();
        if (request.method === 'GET') {
          return Response.json({ ok: true, capability: describeExecCapability(file) }, { headers: NO_STORE });
        }
        let body = null;
        try {
          body = await request.json();
        } catch { /* a malformed body is refused below */ }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return Response.json({ ok: false, error: 'a JSON body with a state is required', reason_code: 'CAPABILITY_BODY_INVALID' }, { status: 400, headers: NO_STORE });
        }
        const written = writeExecCapability(file, {
          state: body.state,
          ttl_ms: body.ttl_ms,
          actor: { kind: 'operator', id: 'plugin-ui', at: new Date().toISOString() },
        });
        if (written.ok !== true) {
          return Response.json({ ok: false, error: written.detail, reason_code: written.code }, { status: 400, headers: NO_STORE });
        }
        return Response.json({ ok: true, capability: describeExecCapability(file) }, { headers: NO_STORE });
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}
