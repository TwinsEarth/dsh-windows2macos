// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Read DSH session logs for the queue journal / history window and for choice-prompt detection.
//
// A session log is `session.v4.jsonl.zstd`: a sequence of independent zstd frames, each carrying JSONL
// events. The file is append-only, so the reader keeps a per-file cursor (compressed byte offset) and
// carries the bytes of an incomplete frame to the next read — a poll after a new turn only decodes the
// new frames instead of the whole (often >100 MB) log.
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MAX_HUMAN = 200
const MAX_TEXT = 12_000

/** @type {Map<string, {size:number, offset:number, carryFrame:Buffer, lineCarry:string, title:string, human:Array, assistant:string, assistantTime:number}>} */
const caches = new Map()

/** `$DSH_HOME` (or ~/.dsh) / sessions */
export function sessionsRoot(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim() || path.join(homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/** Find the session.v4.jsonl.zstd for a session id (accepts both `uuid` and `session-<uuid>`). */
export function findSessionLog(root, sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (raw === '') return null
  const id = raw.startsWith('session-') ? raw : `session-${raw}`
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) } catch { return null }
  for (const workspace of dirs) {
    const file = path.join(root, workspace, id, 'session.v4.jsonl.zstd')
    try { if (fs.statSync(file).isFile()) return { file, sessionId: id } } catch { /* next */ }
  }
  return null
}

function textOfContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n').trim().slice(0, MAX_TEXT)
}

function applyEvent(cache, event) {
  if (event === null || typeof event !== 'object') return
  if (event.type === 'session/title' && typeof event.data?.title === 'string') {
    cache.title = event.data.title.trim().slice(0, 500)
    return
  }
  if (event.type === 'user/message') {
    const data = event.data ?? {}
    if (String(data?.source?.kind ?? '') !== 'user') return
    const text = textOfContent(data?.content)
    if (text === '') return
    cache.human.push({ text, time: Number(event.time) || null })
    if (cache.human.length > MAX_HUMAN) cache.human = cache.human.slice(-MAX_HUMAN)
    return
  }
  if (event.type === 'assistant/message') {
    const data = event.data ?? {}
    const message = data?.message ?? data
    if (String(message?.role ?? 'assistant') !== 'assistant') return
    const text = textOfContent(message?.content)
    if (text === '') return
    cache.assistant = text
    cache.assistantTime = Number(event.time) || null
  }
}

function freshCache() {
  return { size: 0, offset: 0, carryFrame: Buffer.alloc(0), lineCarry: '', title: '', human: [], assistant: '', assistantTime: 0 }
}

/**
 * Read (incrementally) the human messages, the last assistant message and the title of a session log.
 *
 * @param {string} file
 * @returns {{title:string, human:Array<{text:string,time:number|null}>, assistant:string, assistantTime:number|null, size:number}}
 */
export function readSessionLog(file) {
  const stat = fs.statSync(file)
  let cache = caches.get(file)
  if (cache === undefined || stat.size < cache.size) {
    cache = freshCache()
    caches.set(file, cache)
  }
  if (stat.size > cache.size) {
    const readFrom = cache.offset
    const length = stat.size - readFrom
    const chunk = Buffer.alloc(length)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, chunk, 0, length, readFrom) } finally { fs.closeSync(fd) }
    let combined = Buffer.concat([cache.carryFrame, chunk])
    cache.carryFrame = Buffer.alloc(0)
    // Split at every frame magic; the last candidate may be an incomplete frame being written.
    const starts = []
    let at = combined.indexOf(ZSTD_MAGIC)
    while (at !== -1) { starts.push(at); at = combined.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length) }
    if (starts.length === 0) {
      cache.carryFrame = combined
    } else if (starts[0] > 0) {
      combined = combined.slice(starts[0])
      for (let index = 0; index < starts.length; index += 1) starts[index] -= starts[0]
    }
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index]
      const end = index + 1 < starts.length ? starts[index + 1] : combined.length
      const frame = combined.slice(start, end)
      let text = null
      try { text = zlib.zstdDecompressSync(frame).toString('utf8') } catch { text = null }
      if (text === null) { cache.carryFrame = frame; break }
      const merged = cache.lineCarry + text
      const lines = merged.split('\n')
      cache.lineCarry = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        try { applyEvent(cache, JSON.parse(line)) } catch { /* skip bad line */ }
      }
    }
    cache.offset = stat.size - cache.carryFrame.length
    cache.size = stat.size
  }
  return { title: cache.title, human: cache.human.slice(), assistant: cache.assistant, assistantTime: cache.assistantTime || null, size: cache.size }
}

/** Resolve and read one session in a single call; null when the log does not exist. */
export function readSessionById(sessionId, { root = sessionsRoot() } = {}) {
  const found = findSessionLog(root, sessionId)
  if (found === null) return null
  return { ...readSessionLog(found.file), file: found.file, sessionId: found.sessionId }
}
