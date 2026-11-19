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
import { readSessionById, readSessionTitle, sessionsRoot } from './lib/session-log.mjs';

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
    const text = await request.text();
    if (text.trim() === '') return { body: null, error: 'journal-body-empty' };
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { body: null, error: 'journal-body-invalid' };
    }
    return { body: value, error: null };
  } catch {
    return { body: null, error: 'journal-body-invalid-json' };
  }
}

/**
 * Best-effort session-id -> title map for the journal drawer. The host may expose a `sessions` service,
 * an `agents` service, or neither; every shape is optional here and an absent service is not an error.
 * The drawer falls back to a short id when a title is missing.
 *
 * @param {object} ctx Cordis context.
 * @returns {Promise<Array<{id: string, title: string}>>}
 */
export async function listSessionTitles(ctx) {
  const titles = new Map();
  const take = (id, title) => {
    const key = String(id ?? '').trim();
    if (key === '') return;
    const name = String(title ?? '').trim();
    if (!titles.has(key) || (titles.get(key) === '' && name !== '')) titles.set(key, name);
  };
  for (const serviceName of ['sessions', 'agents']) {
    let service;
    try { service = ctx?.get?.(serviceName); } catch { continue; }
    if (service === undefined || service === null) continue;
    let items = null;
    try {
      if (typeof service.list === 'function') items = await Promise.resolve(service.list());
      else if (typeof service.values === 'function') items = Array.from(service.values());
      else if (typeof service.entries === 'function') items = Array.from(service.entries()).map(([id, value]) => ({ id, ...(value !== null && typeof value === 'object' ? value : {}) }));
    } catch { items = null; }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue;
      take(
        item.id ?? item.sessionId ?? item.session?.id,
        item.title ?? item.name ?? item.displayName ?? item.session?.title,
      );
    }
  }
  return [...titles.entries()].map(([id, title]) => ({ id, title }));
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
  // The host's authenticated connection fence is the real credential. An explicit `fangAuthToken`
  // additionally covers the Fang interop path (`x-fang-auth`), which predates the same-origin
  // cookie and may be spoken by an external orchestrator; unset means "cookie fence only", the
  // shipped default, so existing callers are unaffected.
  const fangAuthToken = typeof deps?.fangAuthToken === 'string' ? deps.fangAuthToken : '';
  const guard = (handler) => async (request) => {
    if (fangAuthToken !== '' && request.headers.get('x-fang-auth') !== fangAuthToken) {
      return json(401, { ok: false, error: 'unauthorized', detail: 'x-fang-auth' });
    }
    return handler(request);
  };
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    const register = (routePath, methods, fetch) => {
      registry.register({ path: routePath, methods, requestBody: 'buffered', fetch: guard(fetch) });
    };

    register(QUEUE_JOURNAL_ROUTE_PREFIX, ['GET', 'POST'], async (request) => {
      if (request.method === 'GET') {
        const query = queryOf(request);
        const key = String(query.get('key') ?? '');
        if (key === '' && query.get('list') === '1') {
          const entries = deps.journal.list();
          const error = deps.journal.loadError?.() ?? null;
          return json(200, { ok: true, entries, ...(error === null ? {} : { error }) });
        }
        if (key === '') return json(400, { ok: false, error: 'journal-key-required' });
        const entry = deps.journal.get(key);
        const error = deps.journal.loadError?.() ?? null;
        return json(200, { ok: true, entry, ...(error === null ? {} : { error }) });
      }
      const parsed = await bodyOf(request);
      const body = parsed.body;
      const key = String(body?.key ?? '');
      if (key === '') return json(400, { ok: false, error: parsed.error ?? 'journal-key-required' });
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
      const items = deps.journal.history({ limit, sessionKey });
      const error = deps.journal.historyLoadError?.() ?? null;
      return json(200, { ok: true, items, ...(error === null ? {} : { error }) });
    });

    // v3.3.6：直接从 DSH 会话日志读取人类输入历史与最后一条 assistant 消息。
    // 客户端 sessions 服务不可用时，历史对话窗口与选择题检测仍能工作；增量解码只读新增的 zstd 帧。
    register(`${QUEUE_JOURNAL_ROUTE_PREFIX}/session-log`, ['GET'], (request) => {
      const query = queryOf(request);
      const sessionId = String(query.get('sessionId') ?? '').trim();
      if (sessionId === '') return json(400, { ok: false, error: 'sessionId-required' });
      const limit = Math.max(1, Math.min(200, Number(query.get('limit') ?? 60) || 60));
      try {
        const log = readSessionById(sessionId, { root: deps.sessionLogRoot ?? sessionsRoot() });
        if (log === null) return json(200, { ok: true, found: false, human: [], assistant: '', title: '' });
        if (log.supported === false) return json(200, { ok: false, error: 'zstd-unsupported', found: false, human: [], assistant: '', title: '' });
        return json(200, {
          ok: true,
          found: true,
          sessionId: log.sessionId,
          title: log.title,
          human: log.human.slice(-limit),
          assistant: log.assistant,
          assistant_time: log.assistantTime,
          size: log.size,
        });
      } catch (error) {
        return json(200, { ok: false, error: String(error?.message ?? error), found: false, human: [], assistant: '', title: '' });
      }
    });

    // v3.2.6：会话标题映射，供队列日志抽屉显示会话名（Session ID 默认隐藏）。
    // v3.3.13: the host session service may be absent or late; the authoritative fallback is the
    // session log itself — its `session/title` event is what DSH displays, and the journal stores
    // only the session id. Never render the raw id when a title can be read.
    register(`${QUEUE_JOURNAL_ROUTE_PREFIX}/sessions`, ['GET'], async () => {
      try {
        const titles = new Map();
        for (const item of await listSessionTitles(ctx)) {
          const id = String(item?.id ?? '').trim();
          const title = String(item?.title ?? '').trim();
          if (id !== '') titles.set(id, title);
        }
        const root = deps.sessionLogRoot ?? sessionsRoot();
        for (const entry of deps.journal.list()) {
          const key = String(entry?.sessionKey || entry?.key || '').trim();
          if (key === '') continue;
          if (String(titles.get(key) ?? '').trim() !== '') continue;
          const storedTitle = String(entry?.title ?? '').trim();
          if (storedTitle !== '') { titles.set(key, storedTitle); continue; }
          let fromLog = readSessionTitle(key, { root });
          if (typeof fromLog !== 'string' || fromLog.trim() === '') {
            // The title event can sit past the cheap head window on a long session; the full
            // incremental reader is the fallback (it caches frames, so only the first read is costly).
            try { fromLog = readSessionById(key, { root })?.title ?? null; } catch { fromLog = null; }
          }
          if (typeof fromLog === 'string' && fromLog.trim() !== '') titles.set(key, fromLog.trim());
        }
        return json(200, { ok: true, items: [...titles.entries()].map(([id, title]) => ({ id, title })) });
      } catch (error) {
        return json(200, { ok: true, items: [], reason: String(error?.message ?? error) });
      }
    });

    register(QUEUE_RESTORE_ROUTE_PATH, ['POST'], async (request) => {
      const parsed = await bodyOf(request);
      const body = parsed.body;
      const sessionId = String(body?.sessionId ?? '').trim();
      const items = Array.isArray(body?.items) ? body.items : [];
      if (sessionId === '') return json(400, { ok: false, error: parsed.error ?? 'session-id-required' });
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
  // v3.3.12: an all-empty journal is the signature of an accidental clear; heal it from history.
  try {
    const recovered = journal.recoverEmpty();
    if (recovered > 0) ctx.logger?.info?.(`[queue-journal] recovered ${recovered} empty record(s) from the history snapshots`);
  } catch (error) {
    ctx.logger?.warn?.(`[queue-journal] history recovery skipped: ${String(error?.message ?? error)}`);
  }
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
  registerQueueJournalRoutes(ctx, {
    journal,
    dataDir,
    sessionLogRoot: config?.sessionLogRoot,
    fangAuthToken: config?.fangAuthToken,
  });
  return service;
}
