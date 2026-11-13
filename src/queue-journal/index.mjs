/**
 * W2M queue journal: `@twinsearth/w2m-dsh-plugin/queue-journal`.
 *
 * Ported from `@twinsearth/dsh-fang-queue-journal` (Fang 3.1.21). Fang's package shipped only a
 * no-op host half because its HTTP surface lived in the Fang orchestrator; W2M has no orchestrator,
 * so the store and the four routes move into this subplugin and keep the wire shapes the ported
 * client already speaks:
 *
 *   GET  /api/w2m/composer/journal?key=…          -> { ok, entry }
 *   GET  /api/w2m/composer/journal?list=1         -> { ok, entries }   (recovery list, newest first)
 *   POST /api/w2m/composer/journal                { key, draft, queue, path, sessionKey }
 *   GET  /api/w2m/composer/journal/history?limit=&sessionKey= -> { ok, items }
 *   POST /api/w2m/composer/queue                  { sessionId, items:[{text}] }
 *
 * The journal only stores what the user has not sent. Nothing here sends a message: the queue
 * restore route forwards rows into a live agent only when the host exposes one, and reports
 * `session-not-live` otherwise, exactly as the Fang route did.
 *
 * Data lives under `$DSH_HOME/xclient/queue-journal`, beside the rest of this package's state.
 */
import path from 'node:path';

import { resolveStateDir } from '../util/cli.mjs';
import { ComposerJournal } from './lib/composer-journal.mjs';

export const name = 'w2m-queue-journal';
export const inject = [];

/** Route prefix shared with lib/client.js. */
export const QUEUE_JOURNAL_ROUTE_PREFIX = '/api/w2m/composer/journal';
export const QUEUE_RESTORE_ROUTE_PATH = '/api/w2m/composer/queue';
export const QUEUE_JOURNAL_SERVICE = 'w2mQueueJournal';

const NO_STORE = { 'cache-control': 'no-store' };

function json(status, body) {
  return Response.json(body, { status, headers: NO_STORE });
}

function queryOf(request) {
  try {
    return new URL(request.url, 'http://127.0.0.1').searchParams;
  } catch {
    return new URLSearchParams();
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

/**
 * Mount the four composer-journal routes on the host's Connection fetch registry.
 *
 * @param {object} ctx Cordis context.
 * @param {{journal: ComposerJournal, dataDir: string}} deps
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerQueueJournalRoutes(ctx, deps) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    const register = (routePath, methods, fetch) => {
      registry.register({ path: routePath, methods, requestBody: 'buffered', fetch });
    };

    register(QUEUE_JOURNAL_ROUTE_PREFIX, ['GET', 'POST'], async (request) => {
      if (request.method === 'GET') {
        const query = queryOf(request);
        const key = String(query.get('key') ?? '');
        if (key === '' && query.get('list') === '1') {
          return json(200, { ok: true, entries: deps.journal.list() });
        }
        if (key === '') return json(400, { ok: false, error: 'journal-key-required' });
        return json(200, { ok: true, entry: deps.journal.get(key) });
      }
      const body = await bodyOf(request);
      const key = String(body?.key ?? '');
      if (key === '') return json(400, { ok: false, error: 'journal-key-required' });
      try {
        return json(200, {
          ok: true,
          entry: deps.journal.save(key, {
            ...body,
            sessionKey: body?.sessionKey || body?.sessionId || '',
          }),
        });
      } catch (error) {
        return json(400, { ok: false, error: String(error?.message ?? error) });
      }
    });

    register(`${QUEUE_JOURNAL_ROUTE_PREFIX}/history`, ['GET'], (request) => {
      const query = queryOf(request);
      const limit = Math.max(1, Math.min(200, Number(query.get('limit') ?? 20) || 20));
      const sessionKey = String(query.get('sessionKey') ?? '');
      return json(200, { ok: true, items: deps.journal.history({ limit, sessionKey }) });
    });

    register(QUEUE_RESTORE_ROUTE_PATH, ['POST'], async (request) => {
      const body = await bodyOf(request);
      const sessionId = String(body?.sessionId ?? '').trim();
      const items = Array.isArray(body?.items) ? body.items : [];
      if (sessionId === '') return json(400, { ok: false, error: 'session-id-required' });
      if (items.length === 0) return json(200, { ok: true, queued: 0, failed: 0 });
      let agents;
      try {
        agents = ctx.get('agents');
      } catch {
        agents = undefined;
      }
      const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
      if (agent === undefined || typeof agent.send !== 'function') {
        return json(409, { ok: false, error: 'session-not-live' });
      }
      let queued = 0;
      let failed = 0;
      for (const item of items.slice(0, 100)) {
        const text = String(item?.text ?? '')
          .trim()
          .slice(0, 4000);
        if (text === '') {
          failed += 1;
          continue;
        }
        try {
          agent.send(
            {
              id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            },
            'next-turn',
            false,
          );
          queued += 1;
        } catch {
          failed += 1;
        }
      }
      return json(200, { ok: true, queued, failed });
    });

    status.mounted = true;
    status.reason = null;
  });
  return status;
}

/**
 * Apply the queue journal: one store, one service, four routes.
 *
 * @param {object} ctx Cordis context.
 * @param {{dataDir?: string}} [config]
 */
export function apply(ctx, config = {}) {
  const dataDir =
    typeof config?.dataDir === 'string' && config.dataDir.trim() !== ''
      ? path.resolve(config.dataDir)
      : path.join(resolveStateDir(null, ''), 'queue-journal');
  const journal = new ComposerJournal(dataDir);
  const service = {
    dataDir,
    get: (key) => journal.get(key),
    list: () => journal.list(),
    save: (key, input) => journal.save(key, input),
    history: (options) => journal.history(options),
    remove: (key) => journal.remove(key),
  };
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => ctx.provide(QUEUE_JOURNAL_SERVICE, service));
  } else if (typeof ctx?.provide === 'function') {
    ctx.provide(QUEUE_JOURNAL_SERVICE, service);
  }
  registerQueueJournalRoutes(ctx, { journal, dataDir });
  return service;
}
