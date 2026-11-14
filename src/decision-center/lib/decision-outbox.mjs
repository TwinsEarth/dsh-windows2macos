// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// decision-outbox — fork 侧的「向母体提交 decision」耐久 outbox（P4 地基）。
//
// 方向：fork → mother 走 HTTP ingest，不走 adapter（adapter 是 mother → fork 控制通道）。
// 母体地址/token 从 DSH_FANG_MOTHER 指向的母体 dataDir 读取：
//   <motherDataDir>/endpoint.json  { url }
//   <motherDataDir>/fang-auth.json { token }（0600）
//
// 现状：库本身可用，但还没有接进 fork 的 Agent tool / umbrella ASK；未接 = 不算接线。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { ensureDir, readJson, writeJsonAtomic } from '../kernel.mjs'

export const OUTBOX_DIRNAME = 'decision-outbox'

export function resolveMotherTarget(motherDataDir) {
  const dir = String(motherDataDir ?? '').trim()
  if (!dir) return { ok: false, reason: 'mother-data-dir-required' }
  const endpoint = readJson(path.join(dir, 'endpoint.json'), null)
  const auth = readJson(path.join(dir, 'fang-auth.json'), null)
  const url = String(endpoint?.url ?? '').replace(/\/+$/, '')
  const token = String(auth?.token ?? '')
  if (!url || !token) return { ok: false, reason: 'mother-endpoint-unavailable', url, hasToken: Boolean(token) }
  return { ok: true, url, token }
}

/**
 * @param {{dataDir:string, fetchImpl?:Function, logger?:object, now?:()=>number}} options
 */
export function createDecisionOutbox(options = {}) {
  const dataDir = String(options.dataDir ?? '')
  if (!dataDir) throw new Error('createDecisionOutbox: dataDir required')
  const dir = path.join(dataDir, OUTBOX_DIRNAME)
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = (level, message) => { try { options.logger?.[level]?.(`[decision-outbox] ${message}`) } catch { /* ignore */ } }
  const fileOf = (id) => path.join(dir, `${id}.json`)
  const listIds = () => {
    try { return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort() } catch { return [] }
  }

  function enqueue(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('enqueue: payload object required')
    ensureDir(dir)
    const id = `out-${now()}-${randomUUID()}`
    const record = { id, payload, createdAt: now(), attempts: 0, nextAt: 0 }
    writeJsonAtomic(fileOf(id), record)
    return record
  }

  async function post(target, payload) {
    const response = await fetchImpl(`${target.url}/fang/api/decisions/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fang-auth': target.token },
      body: JSON.stringify(payload),
    })
    const text = await response.text().catch(() => '')
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    return { ok: response.ok, status: response.status, body }
  }

  /** 先直连母体；失败（含母体不可达）就落 outbox，返回 queued:true。 */
  async function submit(payload, { motherDataDir } = {}) {
    const target = resolveMotherTarget(motherDataDir)
    if (!target.ok) {
      const record = enqueue(payload)
      return { ok: true, queued: true, outboxId: record.id, ticket: null, reason: target.reason }
    }
    try {
      const result = await post(target, payload)
      if (result.ok) return { ok: true, queued: false, status: result.status, ticket: result.body?.ticket ?? null }
      const record = enqueue(payload)
      record.lastStatus = result.status
      writeJsonAtomic(fileOf(record.id), record)
      return { ok: true, queued: true, outboxId: record.id, ticket: null, reason: `http-${result.status}` }
    } catch (error) {
      const record = enqueue(payload)
      log('warn', `submit queued: ${String(error?.message ?? error)}`)
      return { ok: true, queued: true, outboxId: record.id, ticket: null, reason: 'network-error' }
    }
  }

  /** 重放 outbox；成功即删文件，失败保留并写退避 nextAt。 */
  async function flush({ motherDataDir, limit = 50 } = {}) {
    const target = resolveMotherTarget(motherDataDir)
    const ids = listIds()
    if (!target.ok) return { ok: false, reason: target.reason, sent: 0, failed: 0, remaining: ids.length }
    let sent = 0
    let failed = 0
    for (const id of ids.slice(0, Math.max(0, limit))) {
      const record = readJson(fileOf(id), null)
      if (!record?.payload) { try { fs.unlinkSync(fileOf(id)) } catch { /* ignore */ } continue }
      try {
        const result = await post(target, record.payload)
        if (result.ok) {
          try { fs.unlinkSync(fileOf(id)) } catch { /* ignore */ }
          sent += 1
        } else {
          record.attempts = (Number(record.attempts) || 0) + 1
          record.nextAt = now() + Math.min(60_000, 2 ** record.attempts * 1000)
          record.lastStatus = result.status
          writeJsonAtomic(fileOf(id), record)
          failed += 1
        }
      } catch (error) {
        record.attempts = (Number(record.attempts) || 0) + 1
        record.nextAt = now() + Math.min(60_000, 2 ** record.attempts * 1000)
        record.lastError = String(error?.message ?? error).slice(0, 300)
        writeJsonAtomic(fileOf(id), record)
        failed += 1
      }
    }
    return { ok: true, sent, failed, remaining: listIds().length }
  }

  return {
    dir,
    enqueue,
    submit,
    flush,
    pending: () => listIds().length,
    list: () => listIds().map((id) => readJson(fileOf(id), null)).filter(Boolean),
  }
}
