// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// 会话标题解析（session titles）
// ------------------------------------------------------------
// The decision drawer used to print `会话 <sessionId.slice(0,18)>` — a raw
// identifier where a human needs a name. The client cannot always answer: a
// ticket created by an Agent belongs to a session the page may not have loaded.
// So the host resolves it, read-only, from the two sources that actually carry
// a per-session title on this installation:
//
//   1. a host `sessions` / `agents` service, when the host exposes one (its
//      `list()`/`values()`/`entries()` shape is probed defensively — an absent
//      or differently-shaped service is not an error, it is a missing source);
//   2. the DSH session log's own `session/title` event, which is what DSH shows
//      in its session list. The reader below opens the log and decodes at most
//      the first frames; it never writes, never renames and never truncates.
//
// The workspace registry (`storages/workspace.json`) is deliberately NOT a
// title source: on the running installation it records workspace titles plus
// `sessionIds`, so using it would relabel every session with its folder name.
// It is still useful to DSH; it does not know a session's title.
//
// Layer note: `queue-journal/lib/session-log.mjs` already reads the same event,
// but a decision-center -> queue-journal import is an undeclared same-rank edge
// in `scripts/layer-model.mjs`. Moving that reader to `util/` is the right
// long-term fix and is out of this change's write scope; this module keeps the
// reader small and bounded instead of growing a second general log parser.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { homedir } from 'node:os'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZSTD_READY = typeof zlib.zstdDecompressSync === 'function'
const TITLE_BYTES = 2 * 1024 * 1024
const TITLE_CACHE_LIMIT = 256

/** `$DSH_HOME` (or `~/.dsh`) / sessions */
export function sessionsRoot(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim() || path.join(homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/** Find the `session.v4.jsonl.zstd` of a session id (`uuid` and `session-<uuid>` both accepted). */
export function findSessionLog(root, sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (raw === '') return null
  const id = raw.startsWith('session-') ? raw : `session-${raw}`
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch { return null }
  for (const workspace of dirs) {
    const file = path.join(root, workspace, id, 'session.v4.jsonl.zstd')
    try { if (fs.statSync(file).isFile()) return { file, sessionId: id } } catch { /* next */ }
  }
  return null
}

/** file+size -> title; an append-only log is re-read only when it grew. */
const titleCache = new Map()

/**
 * Read a session's title from the head of its log, without decoding the whole file.
 *
 * `session/title` is written near the start, so a bounded head read is enough;
 * a 100 MB log must not be decoded on every drawer refresh. Returns null when
 * there is no log, no title event, or no zstd support in this Node.
 *
 * @param {string} sessionId
 * @param {{root?: string, maxBytes?: number}} [options]
 * @returns {string|null}
 */
export function readTitleFromSessionLog(sessionId, { root = sessionsRoot(), maxBytes = TITLE_BYTES } = {}) {
  if (!ZSTD_READY) return null
  const found = findSessionLog(root, sessionId)
  if (found === null) return null
  let stat = null
  try { stat = fs.statSync(found.file) } catch { return null }
  const cacheKey = `${found.file}:${stat.size}`
  if (titleCache.has(cacheKey)) return titleCache.get(cacheKey)
  let title = null
  try {
    const length = Math.min(stat.size, Math.max(1024, Number(maxBytes) || TITLE_BYTES))
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(found.file, 'r')
    try { fs.readSync(fd, buffer, 0, length, 0) } finally { fs.closeSync(fd) }
    let start = buffer.indexOf(ZSTD_MAGIC)
    while (start !== -1) {
      const next = buffer.indexOf(ZSTD_MAGIC, start + ZSTD_MAGIC.length)
      const end = next === -1 ? buffer.length : next
      let text = null
      try { text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8') } catch { text = null }
      if (text !== null) {
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue
          try {
            const event = JSON.parse(line)
            if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim() !== '') {
              title = event.data.title.trim().slice(0, 200)
            }
          } catch { /* a line split across frames is skipped */ }
        }
      }
      if (next === -1) break
      start = next
    }
  } catch { title = null }
  titleCache.set(cacheKey, title)
  while (titleCache.size > TITLE_CACHE_LIMIT) titleCache.delete(titleCache.keys().next().value)
  return title
}

const bareId = (id) => String(id ?? '').trim().replace(/^session-/, '')

/**
 * Build the cached, bounded title resolver used by the ticket store.
 *
 * `resolve()` is synchronous and safe to call from `list()`: it spends at most
 * `maxLogReadsPerCall` log reads per batch and never blocks. `lookupMany()` is
 * the async route helper and additionally awaits a slow host `sessions` service.
 *
 * @param {{ctx?: object, env?: object, cacheLimit?: number, ttlMs?: number, missTtlMs?: number, maxLogReadsPerCall?: number, readLogTitle?: Function, now?: Function}} [options]
 * @returns {{beginBatch: Function, resolve: Function, lookupMany: Function, refresh: Function, stats: Function}}
 */
export function createSessionTitleResolver({
  ctx = null,
  env = process.env,
  cacheLimit = 512,
  ttlMs = 10 * 60_000,
  missTtlMs = 60_000,
  maxLogReadsPerCall = 20,
  readLogTitle = readTitleFromSessionLog,
  now = Date.now,
} = {}) {
  const ceiling = Math.max(1, Math.floor(Number(cacheLimit) || 512))
  const cache = new Map()
  const serviceTitles = new Map()
  let servicesTried = false
  let pendingService = null
  let logReads = 0
  let reads = 0
  let hits = 0
  let misses = 0

  const remember = (id, title) => {
    cache.delete(id)
    cache.set(id, { title, at: now() })
    while (cache.size > ceiling) cache.delete(cache.keys().next().value)
  }

  const collect = (items) => {
    if (!Array.isArray(items)) return
    for (const item of items.slice(0, 2000)) {
      if (item === null || typeof item !== 'object') continue
      const id = String(item.id ?? item.sessionId ?? item.session?.id ?? '').trim()
      if (id === '') continue
      const title = String(item.title ?? item.displayTitle ?? item.name ?? item.session?.title ?? '').trim()
      if (title === '') continue
      const clean = title.slice(0, 200)
      serviceTitles.set(id, clean)
      serviceTitles.set(bareId(id), clean)
    }
  }

  /** Probe the host's session services once. A promise-shaped list is awaited by lookupMany(). */
  const ensureServices = () => {
    if (servicesTried) return
    servicesTried = true
    for (const serviceName of ['sessions', 'agents']) {
      let service = null
      try { service = ctx?.get?.(serviceName) } catch { service = null }
      if (service === null || service === undefined) continue
      let items = null
      try {
        if (typeof service.list === 'function') items = service.list()
        else if (typeof service.values === 'function') items = Array.from(service.values())
        else if (typeof service.entries === 'function') items = Array.from(service.entries()).map(([id, value]) => ({ id, ...(value !== null && typeof value === 'object' ? value : {}) }))
      } catch { items = null }
      if (items !== null && typeof items?.then === 'function') {
        pendingService = Promise.resolve(items)
          .then((rows) => { collect(rows); return null })
          .catch(() => null)
          .finally(() => { pendingService = null })
        continue
      }
      collect(items)
    }
  }

  const beginBatch = () => {
    logReads = 0
    ensureServices()
  }

  /**
   * Synchronous, cached resolution. Returns null when no source knows the title
   * (the client's friendly fallback is the intended result, never a raw id).
   */
  const resolve = (sessionId) => {
    const id = String(sessionId ?? '').trim().slice(0, 200)
    if (id === '') return null
    const narrow = bareId(id)
    if (narrow === '' || narrow === 'unknown' || narrow === 'external') return null
    const entry = cache.get(id)
    if (entry !== undefined) {
      const age = now() - entry.at
      // A positive title is authoritative until it expires; a negative entry only
      // suppresses log re-reads, never a title a host service may have learned since.
      if (entry.title !== null && age < ttlMs) {
        hits += 1
        return entry.title
      }
    }
    ensureServices()
    const serviceTitle = serviceTitles.get(id) ?? serviceTitles.get(narrow) ?? serviceTitles.get(`session-${narrow}`)
    if (typeof serviceTitle === 'string' && serviceTitle !== '') {
      remember(id, serviceTitle)
      return serviceTitle
    }
    if (entry !== undefined && entry.title === null && now() - entry.at < missTtlMs) {
      hits += 1
      return null
    }
    if (logReads >= maxLogReadsPerCall) return null
    logReads += 1
    reads += 1
    let title = null
    try { title = readLogTitle(id, { root: sessionsRoot(env) }) } catch { title = null }
    const clean = typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 200) : null
    if (clean === null) misses += 1
    remember(id, clean)
    return clean
  }

  /** Async resolution for `GET /session-titles`: awaits a promise-shaped sessions service. */
  const lookupMany = async (ids) => {
    beginBatch()
    if (pendingService !== null) { try { await pendingService } catch { /* a broken service is a missing source */ } }
    const out = new Map()
    for (const id of Array.isArray(ids) ? ids.slice(0, 50) : []) out.set(String(id), resolve(id))
    if (pendingService !== null) { try { await pendingService } catch { /* ignore */ } }
    return out
  }

  /** Re-probe the host services on demand (a session service may arrive after mount). */
  const refresh = async () => {
    servicesTried = false
    ensureServices()
    if (pendingService !== null) { try { await pendingService } catch { /* ignore */ } }
    return { services: serviceTitles.size }
  }

  const stats = () => ({
    cache: cache.size,
    limit: ceiling,
    services: serviceTitles.size,
    reads,
    hits,
    misses,
    budget: maxLogReadsPerCall,
  })

  return { beginBatch, resolve, lookupMany, refresh, stats }
}
