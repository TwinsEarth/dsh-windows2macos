// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.

/**
 * 回流（relay）接口 —— contract 1.1 新增能力。
 *
 * 背景：房主（dsh-Master）的成本总线产生 `cost:event` / `cost:degraded` /
 * `cost:substitution` 三类事件，需要**单向**投递给瓮城（dsh-Fang）做产物回流与
 * 信息栏展示。1.0 的方法表只有请求-响应式的 fork/decision/session，缺一个批量、
 * 可去重、有回执的事件入口，因此 1.1 追加两个方法：
 *
 *   * `fang.relay.publish` —— 批量投递事件，按 `event.id` 幂等去重，返回回执与游标；
 *   * `fang.relay.status`  —— 对端自报回流状态（自身标识 peerLabel、游标、累计计数）。
 *
 * 兼容规则（README §2）：新增方法只升 MINOR；1.0 的对端在 `hello` 协商时不会
 * 宣告这两个方法，方法集被自动裁剪，调用方据此判定“回流不可用”，**不得**把
 * 裁剪当成失败重试。
 *
 * 本文件只做协议与参考实现：不读写磁盘、不联网、不持有任何凭据。
 */

import { CONTRACT_VERSION, METHODS, RELAY_LIMITS } from './constants.js'
import { createContractServer } from './server.js'

function nowMs(now) {
  const value = typeof now === 'function' ? now() : Date.now()
  const n = Number(value)
  return Number.isFinite(n) ? n : Date.now()
}

function asLimit(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') } catch { return Number.POSITIVE_INFINITY }
}

/**
 * 校验一批回流事件。逐条判定：合法的接受，非法的计 `rejected` 并给原因，
 * 不因单条坏数据丢掉整批（但整批不可用会抛 `relay-events-invalid`）。
 *
 * @param {unknown} events
 * @param {{maxBatch?:number, maxEventBytes?:number, maxPayloadBytes?:number}} [limits]
 */
export function validateRelayEvents(events, limits = {}) {
  const maxBatch = asLimit(limits.maxBatch, RELAY_LIMITS.maxBatch)
  const maxEventBytes = asLimit(limits.maxEventBytes, RELAY_LIMITS.maxEventBytes)
  const maxPayloadBytes = asLimit(limits.maxPayloadBytes, RELAY_LIMITS.maxPayloadBytes)
  const errors = []
  if (!Array.isArray(events)) {
    return { ok: false, code: 'relay-events-invalid', errors: ['events-must-be-array'], accepted: [], rejected: [] }
  }
  if (events.length === 0) {
    return { ok: false, code: 'relay-events-invalid', errors: ['events-empty'], accepted: [], rejected: [] }
  }
  if (events.length > maxBatch) {
    return { ok: false, code: 'relay-events-invalid', errors: [`events-too-many(>${maxBatch})`], accepted: [], rejected: [] }
  }
  if (byteLength(events) > maxPayloadBytes) {
    return { ok: false, code: 'relay-events-invalid', errors: [`payload-too-large(>${maxPayloadBytes})`], accepted: [], rejected: [] }
  }
  const accepted = []
  const rejected = []
  const seen = new Set()
  for (const raw of events) {
    const item = raw && typeof raw === 'object' ? raw : null
    if (!item) { rejected.push({ id: null, reason: 'event-not-object' }); continue }
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) { rejected.push({ id: null, reason: 'id-required' }); continue }
    if (typeof item.type !== 'string' || item.type.trim() === '') { rejected.push({ id, reason: 'type-required' }); continue }
    if (byteLength(item) > maxEventBytes) { rejected.push({ id, reason: `event-too-large(>${maxEventBytes})` }); continue }
    // 同一批内重复 id 也算重复投递：只接受第一次，其余计 duplicates。
    if (seen.has(id)) { rejected.push({ id, reason: 'duplicate-in-batch' }); continue }
    seen.add(id)
    accepted.push({
      id,
      type: String(item.type),
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : 0,
      payload: item.payload && typeof item.payload === 'object' ? item.payload : {},
      meta: item.meta && typeof item.meta === 'object' ? item.meta : {},
    })
  }
  return { ok: accepted.length > 0 || rejected.length === 0, errors, accepted, rejected }
}

/**
 * 回流接收端（瓮城侧）的参考存储：按 event.id 幂等去重，保留有界回执环。
 *
 * @param {{
 *   peerLabel?: string, role?: string, instanceId?: string,
 *   maxRecords?: number, now?: () => number, limits?: object,
 * }} [options]
 */
export function createRelayStore(options = {}) {
  const peerLabel = String(options.peerLabel ?? 'contract-server')
  const role = String(options.role ?? 'mother')
  const instanceId = String(options.instanceId ?? '')
  const maxRecords = asLimit(options.maxRecords, RELAY_LIMITS.maxRecords)
  const limits = { ...RELAY_LIMITS, ...(options.limits && typeof options.limits === 'object' ? options.limits : {}) }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const seen = new Map()
  const receipts = []
  const counters = { accepted: 0, duplicates: 0, rejected: 0, batches: 0 }
  let cursor = 0
  let lastAt = 0
  const lastErrors = []

  function remember(receipt) {
    receipts.push(receipt)
    if (receipts.length > maxRecords) receipts.shift()
  }

  /** @param {{events?: unknown, batchId?: string, taskId?: string}} [params] */
  function publish(params = {}) {
    const validated = validateRelayEvents(params?.events, limits)
    if (validated.ok === false) {
      const error = new Error(validated.errors.join(', ') || 'relay-events-invalid')
      error.code = 'relay-events-invalid'
      error.retryable = false
      throw error
    }
    counters.batches += 1
    const acceptedIds = []
    let alreadySeen = 0
    let inBatchDuplicates = 0
    let rejectedCount = 0
    for (const event of validated.accepted) {
      if (seen.has(event.id)) { alreadySeen += 1; continue }
      seen.set(event.id, { at: nowMs(now), cursor: cursor + 1 })
      cursor += 1
      counters.accepted += 1
      acceptedIds.push(event.id)
      remember({ id: event.id, type: event.type, at: event.at, cursor })
      lastAt = nowMs(now)
    }
    for (const item of validated.rejected) {
      // 批内重复计入 duplicates；其余非法条目计入 rejected 并留原因（有界）。
      if (item.reason === 'duplicate-in-batch') { inBatchDuplicates += 1; continue }
      rejectedCount += 1
      if (lastErrors.length < 50) lastErrors.push({ id: item.id, reason: item.reason })
    }
    // 两个计数分开累计：duplicates = 已存在 + 批内重复；rejected 只数真正非法的条目。
    // （1.1.0 曾用 `validated.rejected.length - duplicates` 计算 rejected，重投时会得到负数。）
    const duplicates = alreadySeen + inBatchDuplicates
    counters.duplicates += duplicates
    counters.rejected += rejectedCount
    const batchId = String(params?.batchId ?? `batch-${counters.batches}`)
    const receipt = Object.freeze({
      ok: true,
      batchId,
      taskId: params?.taskId === undefined ? null : String(params.taskId),
      accepted: acceptedIds.length,
      duplicates,
      rejected: rejectedCount,
      cursor,
      acceptedIds,
      peer: peerLabel,
      at: nowMs(now),
    })
    if (seen.size > maxRecords * 4) {
      // 幂等窗口有界：按插入顺序淘汰最老的一半，避免长跑进程无界增长。
      const overflow = seen.size - maxRecords * 2
      let removed = 0
      for (const key of seen.keys()) {
        if (removed >= overflow) break
        seen.delete(key)
        removed += 1
      }
    }
    return receipt
  }

  function status() {
    return Object.freeze({
      ok: true,
      available: true,
      peer: peerLabel,
      role,
      instanceId,
      contractVersion: CONTRACT_VERSION,
      cursor,
      accepted: counters.accepted,
      duplicates: counters.duplicates,
      rejected: counters.rejected,
      batches: counters.batches,
      lastAt,
      limits: { ...limits },
      lastErrors: [...lastErrors],
    })
  }

  function describe() {
    return Object.freeze({ peerLabel, records: receipts.length, seen: seen.size, ...counters, cursor })
  }

  return Object.freeze({ publish, status, describe, receipts: () => [...receipts] })
}

/**
 * 把回流 store 包成契约 handler 表（挂到 `createContractServer({handlers})`）。
 * @param {{publish:Function, status:Function}} store
 */
export function relayHandlers(store) {
  if (!store || typeof store.publish !== 'function' || typeof store.status !== 'function') {
    throw new Error('relayHandlers requires a relay store with publish/status')
  }
  return {
    [METHODS.RELAY_PUBLISH]: (params) => store.publish(params ?? {}),
    [METHODS.RELAY_STATUS]: () => store.status(),
  }
}

/**
 * 便捷构造：带回流能力的契约服务端（瓮城侧挂载用）。
 * `peerLabel` 是**自报**标识，房主侧据此记录“对端是谁”，不参与鉴权。
 */
export function createRelayContractServer(options = {}) {
  const { peerLabel = 'contract-server', role = 'mother', instanceId = '', now, limits, maxRecords, extraHandlers = {}, ...rest } = options
  const store = createRelayStore({ peerLabel, role, instanceId, now, limits, maxRecords })
  const server = createContractServer({
    role,
    instanceId,
    handlers: { ...relayHandlers(store), ...(extraHandlers && typeof extraHandlers === 'object' ? extraHandlers : {}) },
    ...rest,
  })
  return { server, store }
}
