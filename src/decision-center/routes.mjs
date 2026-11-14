/**
 * HTTP surface of W2M's decision center: `/api/w2m/decisions*`.
 *
 * Ported from the Fang orchestrator's route block (`src/plugins/orchestrator.mjs`, the
 * `api/decisions*` handlers) with three mechanical differences:
 *
 *   * the prefix is `/api/w2m/decisions` instead of `${prefix}/api/decisions`;
 *   * the handlers answer Web `Request`/`Response` through the host's Connection fetch registry
 *     instead of Node's `req`/`res`, which is the only shape a W2M plugin can register;
 *   * the two SSE endpoints stream through a `ReadableStream` body, carrying the same event names
 *     (`ready`, `ticket`, `ping`) and payloads the Fang helper emits.
 *
 * The decision-center service is read from the plugin's own Cordis context, so the routes never
 * capture an instance: a store that is disposed and re-provided is picked up by the next request.
 */
import { SERVICE, bus } from './kernel.mjs';

/** Route prefix shared with lib/client.js. */
export const DECISION_ROUTE_PREFIX = '/api/w2m/decisions';

const NO_STORE = { 'cache-control': 'no-store' };
const EVENT_TOPICS = Object.freeze(['fang/decision-created', 'fang/decision-updated']);
const MAX_EVENT_STREAMS = 20;

function json(status, body, headers = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function centerOf(ctx) {
  try {
    return ctx.get(SERVICE.decisionCenter);
  } catch {
    return undefined;
  }
}

async function bodyOf(request) {
  try {
    const value = await request.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function unavailable() {
  return json(503, { ok: false, error: 'decision-center-unavailable' });
}

function queryOf(request) {
  try {
    return new URL(request.url, 'http://127.0.0.1').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Serve one SSE stream over the fetch API.
 *
 * @param {object} options
 * @param {object} options.center decision-center service (read-only here)
 * @param {(send: (event: string, data: unknown) => void) => (() => void)} options.pump
 *   registers the stream's work and returns its disposer.
 * @returns {Response}
 */
function sseResponse({ center, pump }) {
  const encoder = new TextEncoder();
  let closed = false;
  let dispose = () => {};
  let heartbeat = null;
  const body = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      let initial = null;
      try {
        initial = typeof center?.list === 'function' ? center.list({ includeArchived: false }) : null;
      } catch {
        initial = null;
      }
      send('ready', {
        at: Date.now(),
        rev: Number(initial?.rev) || 0,
        counts: initial?.counts ?? null,
      });
      const extra = pump(send);
      const cleanups = typeof extra === 'function' ? [extra] : [];
      const listeners = EVENT_TOPICS.map((topic) => {
        const handler = (ticket) => {
          send('ticket', {
            at: Date.now(),
            type: topic.endsWith('-created') ? 'created' : 'updated',
            rev: Number(ticket?.rev) || 0,
            ids: ticket?.id ? [String(ticket.id)] : [],
            ticket,
          });
        };
        return bus.on(topic, handler);
      });
      heartbeat = setInterval(() => {
        if (!send('ping', { at: Date.now() })) return;
      }, 15000);
      heartbeat.unref?.();
      dispose = () => {
        if (closed) return;
        closed = true;
        for (const off of listeners) {
          try {
            if (typeof off === 'function') off();
          } catch {
            /* ignore */
          }
        }
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
            /* ignore */
          }
        }
        if (heartbeat !== null) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
    cancel() {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * Mount every decision route on the host's Connection fetch registry.
 *
 * @param {object} ctx Cordis context the decision-center plugin was applied to.
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerDecisionCenterRoutes(ctx) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    let streams = 0;
    const register = (path, methods, fetch) => {
      registry.register({ path, methods, requestBody: 'buffered', fetch });
    };

    // GET /api/w2m/decisions — pending tickets plus counts.
    register(`${DECISION_ROUTE_PREFIX}`, ['GET'], (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.list !== 'function') return unavailable();
      const query = queryOf(request);
      const out = center.list({
        includeArchived: query.get('includeArchived') === '1' || query.get('includeArchived') === 'true',
        since: Number(query.get('since')) || 0,
      });
      return json(200, { ok: true, ...out });
    });

    register(`${DECISION_ROUTE_PREFIX}/quota`, ['GET'], () => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.quotaStatus !== 'function') return unavailable();
      return json(200, center.quotaStatus());
    });

    register(`${DECISION_ROUTE_PREFIX}/item`, ['GET'], (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.get !== 'function') return unavailable();
      const ticket = center.get(String(queryOf(request).get('id') ?? ''));
      return ticket ? json(200, { ok: true, ticket }) : json(404, { ok: false, error: 'not-found' });
    });

    register(`${DECISION_ROUTE_PREFIX}/forks`, ['GET'], () => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.forkAggregation !== 'function') return unavailable();
      return json(200, center.forkAggregation());
    });

    register(`${DECISION_ROUTE_PREFIX}/producers`, ['GET'], () => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.producerCatalog !== 'function') return unavailable();
      return json(200, center.producerCatalog());
    });

    // External-producer bridge: ingest only, ticket source marked external:<producer>.
    register(`${DECISION_ROUTE_PREFIX}/ingest`, ['POST'], async (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.ingest !== 'function') return unavailable();
      const body = await bodyOf(request);
      const out = center.ingest(body ?? {});
      const statusCode = out.ok
        ? 200
        : out.reason === 'title-required' ||
            out.reason === 'options-required' ||
            out.reason === 'gray-is-terminal'
          ? 400
          : 409;
      return json(statusCode, out);
    });

    // Live push: one authenticated SSE stream per client, polled fallback stays available.
    register(`${DECISION_ROUTE_PREFIX}/events`, ['GET'], () => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.list !== 'function') return unavailable();
      if (streams >= MAX_EVENT_STREAMS) return json(429, { ok: false, error: 'too-many-event-streams' });
      streams += 1;
      const response = sseResponse({
        center,
        pump: () => () => {
          streams = Math.max(0, streams - 1);
        },
      });
      return response;
    });

    register(`${DECISION_ROUTE_PREFIX}/resolve`, ['POST'], async (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.resolve !== 'function') return unavailable();
      const body = await bodyOf(request);
      if (Array.isArray(body?.ids)) {
        if (typeof center.resolveMany !== 'function')
          return json(503, { ok: false, error: 'decision-center-batch-unavailable' });
        return json(
          200,
          center.resolveMany(body.ids, { option: body?.option, by: body?.by ?? 'w2m-api', note: body?.note }),
        );
      }
      const resolveOptions = { by: body?.by ?? 'w2m-api', note: body?.note };
      if (body?.custom !== undefined) resolveOptions.custom = body.custom;
      const out =
        body?.actionId !== undefined && typeof center.resolveAction === 'function'
          ? center.resolveAction(body?.id, body.actionId, body?.payload, resolveOptions)
          : center.resolve(body?.id, body?.option, resolveOptions);
      const statusCode = out.ok
        ? 200
        : out.reason === 'not-found'
          ? 404
          : out.reason === 'option-required' || out.reason === 'unknown-option'
            ? 400
            : 409;
      return json(statusCode, out);
    });

    register(`${DECISION_ROUTE_PREFIX}/abandon`, ['POST'], async (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.abandon !== 'function') return unavailable();
      const body = await bodyOf(request);
      if (Array.isArray(body?.ids)) {
        if (typeof center.abandonMany !== 'function')
          return json(503, { ok: false, error: 'decision-center-batch-unavailable' });
        return json(200, center.abandonMany(body.ids, { by: body?.by ?? 'w2m-api', note: body?.note }));
      }
      const out = center.abandon(body?.id, { by: body?.by ?? 'w2m-api', note: body?.note });
      return json(out.ok ? 200 : out.reason === 'not-found' ? 404 : 409, out);
    });

    register(`${DECISION_ROUTE_PREFIX}/ai`, ['GET'], () => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.aiStatus !== 'function') return unavailable();
      return json(200, { ok: true, ...center.aiStatus() });
    });

    register(`${DECISION_ROUTE_PREFIX}/ai/test`, ['POST'], async (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.testAi !== 'function') return unavailable();
      const out = await center.testAi((await bodyOf(request)) ?? {});
      return json(out.ok ? 200 : out.status === 429 ? 429 : 400, out);
    });

    register(`${DECISION_ROUTE_PREFIX}/ai/config`, ['POST'], async (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.configureAi !== 'function') return unavailable();
      const out = center.configureAi((await bodyOf(request)) ?? {});
      return json(out.ok ? 200 : 400, out);
    });

    register(`${DECISION_ROUTE_PREFIX}/ai/advise/stream`, ['POST'], async (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.advise !== 'function') return unavailable();
      const body = await bodyOf(request);
      const id = String(body?.id ?? '');
      return sseResponse({
        center,
        pump: (send) => {
          let cancelled = false;
          send('start', { id });
          void (async () => {
            try {
              const out =
                typeof center.adviseStream === 'function'
                  ? await center.adviseStream(id, (delta, text) => {
                      if (!cancelled) send('delta', { delta, text });
                    })
                  : await center.advise(id);
              if (!cancelled)
                send(out.ok ? 'done' : 'error', out.ok ? { advice: out.advice, ticket: out.ticket } : out);
            } catch (error) {
              if (!cancelled) send('error', { ok: false, error: String(error?.message ?? error) });
            }
          })();
          return () => {
            cancelled = true;
          };
        },
      });
    });

    register(`${DECISION_ROUTE_PREFIX}/ai/advise`, ['POST'], async (request) => {
      const center = centerOf(ctx);
      if (center === undefined || typeof center.advise !== 'function') return unavailable();
      const body = await bodyOf(request);
      const out = await center.advise(body?.id);
      const limited =
        out?.reason === 'ai-rate-limited' ||
        out?.reason === 'ai-circuit-open' ||
        out?.reason === 'ai-daily-quota-exceeded';
      const headers =
        limited && Number.isFinite(out?.retryAfterMs) && out.retryAfterMs > 0
          ? { 'retry-after': String(Math.ceil(out.retryAfterMs / 1000)) }
          : {};
      return json(out.ok ? 200 : out.reason === 'not-found' ? 404 : limited ? 429 : 409, out, headers);
    });

    status.mounted = true;
    status.reason = null;
  });
  return status;
}
