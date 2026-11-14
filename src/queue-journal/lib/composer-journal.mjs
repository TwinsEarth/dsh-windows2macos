// SPDX-License-Identifier: AGPL-3.0-or-later
// Composer journal: persist the user's unsent draft and queued-message mirror so a
// restart/crash can offer recovery. It never sends anything by itself.
import fs from 'node:fs'
import path from 'node:path'

const MAX_DRAFT = 100_000
const MAX_QUEUE = 100
const MAX_ITEM = 4_000
// v3.1.21：队列「必丢」根因之一是所有会话挤在同一个 key（后者覆盖前者）。
// 新增 append-only 历史文件：任何一次含队列的保存都会追加一条快照，
// 即使主 journal 被覆盖，历史里仍能找回来。
const MAX_HISTORY = 500

function cleanText(value, limit) {
  return String(value ?? '').replace(/\0/g, '').slice(0, limit)
}

export class ComposerJournal {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'composer-journal.json')
    this.historyFile = path.join(dataDir, 'composer-journal-history.jsonl')
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch { return {} }
  }

  saveFile(all) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  get(key) {
    const entry = this.load()[String(key)]
    return entry && typeof entry === 'object' ? entry : null
  }

  /** All recoverable journal entries, newest first (bounded by the same 100-session cap). */
  list() {
    const all = this.load()
    return Object.values(all)
      .filter((entry) => entry && typeof entry === 'object')
      .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
  }

  save(key, input = {}) {
    const id = cleanText(key, 200)
    if (!id) throw new Error('journal-key-required')
    const queue = Array.isArray(input.queue)
      ? input.queue.slice(-MAX_QUEUE).map((item) => ({
        text: cleanText(item?.text, MAX_ITEM),
        at: Number(item?.at) || Date.now(),
      })).filter((item) => item.text.trim())
      : []
    const entry = {
      key: id,
      draft: cleanText(input.draft, MAX_DRAFT),
      queue,
      path: cleanText(input.path, 500),
      sessionKey: cleanText(input.sessionKey, 200),
      title: cleanText(input.title, 200),
      updatedAt: new Date().toISOString(),
    }
    const all = this.load()
    all[id] = entry
    // Keep the journal bounded: 100 sessions is plenty for recovery.
    const keys = Object.keys(all)
    if (keys.length > 100) {
      keys.sort((a, b) => String(all[a]?.updatedAt || '').localeCompare(String(all[b]?.updatedAt || '')))
      for (const stale of keys.slice(0, keys.length - 100)) delete all[stale]
    }
    this.saveFile(all)
    this.appendHistory({ ...entry, sessionKey: cleanText(input.sessionKey, 200) || entry.key })
    return entry
  }

  /** 追加一条历史快照（只在有队列内容时写，避免草稿噪音）。 */
  appendHistory(entry) {
    try {
      const queue = Array.isArray(entry?.queue) ? entry.queue : []
      if (queue.length === 0) return
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true })
      fs.appendFileSync(this.historyFile, JSON.stringify({
        key: entry.key,
        queue,
        draft: entry.draft || "",
        path: entry.path || "",
        sessionKey: entry.sessionKey || "",
        updatedAt: entry.updatedAt,
      }) + "\n", { encoding: "utf8", mode: 0o600 })
      // 裁剪：超过上限时重写最后 MAX_HISTORY 行
      const raw = fs.readFileSync(this.historyFile, "utf8").trim().split("\n").filter(Boolean)
      if (raw.length > MAX_HISTORY) {
        fs.writeFileSync(this.historyFile, raw.slice(-MAX_HISTORY).join("\n") + "\n", { encoding: "utf8", mode: 0o600 })
      }
    } catch { /* 历史写入失败不影响主 journal */ }
  }

  /** 读取历史快照（newest first），可按 sessionKey 过滤。 */
  history({ limit = 50, sessionKey = "" } = {}) {
    try {
      const raw = fs.readFileSync(this.historyFile, "utf8").trim().split("\n").filter(Boolean)
      const items = []
      for (const line of raw) {
        try {
          const entry = JSON.parse(line)
          if (sessionKey && String(entry?.sessionKey || "") !== String(sessionKey)) continue
          items.push(entry)
        } catch { /* 跳过坏行 */ }
      }
      return items.slice(-Math.max(1, Number(limit) || 50)).reverse()
    } catch { return [] }
  }

  remove(key) {
    const all = this.load()
    const id = String(key)
    if (!all[id]) return false
    delete all[id]
    this.saveFile(all)
    return true
  }
}
