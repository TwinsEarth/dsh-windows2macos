// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// decision-events — 决策中心 bus 事件 → 一条 HTTP SSE 流。
//
// 只负责「把事件写进一个已鉴权的响应」：路由层负责 auth/Host/Origin，本模块不碰 token。
// 事件：ready（初始 rev/计数）、ticket（created/updated）、ping（心跳）。
// 客户端断开/出错即退订，绝不把 bus listener 泄漏到下一个请求。
export const DECISION_EVENT_TOPICS = Object.freeze([
  'fang/decision-created',
  'fang/decision-updated',
])

/**
 * @param {object} input
 * @param {any} input.req
 * @param {any} input.res 已通过路由鉴权的 Node 响应
 * @param {{on:Function,off?:Function}} input.bus kernel bus
 * @param {{list?:Function}} [input.center] 决策中心服务（只读 list 用于 ready）
 * @param {number} [input.heartbeatMs]
 * @param {Function} [input.now]
 * @returns {{close:Function, send:Function, headers:object, closed:boolean}}
 */
export function openDecisionEventStream({
  req,
  res,
  bus,
  center = null,
  heartbeatMs = 15000,
  now = () => Date.now(),
} = {}) {
  if (!req || !res || !bus || typeof bus.on !== 'function') {
    throw new Error('openDecisionEventStream: req/res/bus required')
  }
  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }
  res.writeHead(200, headers)
  try { res.flushHeaders?.() } catch { /* fake/undici responses may not support it */ }

  let closed = false
  const cleanups = []
  const send = (event, data) => {
    if (closed) return false
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      return true
    } catch {
      close()
      return false
    }
  }
  const close = () => {
    if (closed) return
    closed = true
    for (const off of cleanups.reverse()) {
      try { if (typeof off === 'function') off() } catch { /* ignore */ }
    }
    cleanups.length = 0
    try { res.end() } catch { /* ignore */ }
  }

  // ready：客户端据此判断「这确实是新流的首帧」，而不是把旧缓存当实时。
  let initial = null
  try { initial = typeof center?.list === 'function' ? center.list({ includeArchived: false }) : null } catch { initial = null }
  send('ready', {
    at: now(),
    rev: Number(initial?.rev) || 0,
    counts: initial?.counts ?? null,
  })

  for (const topic of DECISION_EVENT_TOPICS) {
    const handler = (ticket) => {
      send('ticket', {
        at: now(),
        type: topic.endsWith('-created') ? 'created' : 'updated',
        // 紧凑提示字段（客户端也可只按 rev 拉增量），ticket 一并带上避免多一跳。
        rev: Number(ticket?.rev) || 0,
        ids: ticket?.id ? [String(ticket.id)] : [],
        ticket,
      })
    }
    const off = bus.on(topic, handler)
    cleanups.push(() => { try { if (typeof off === 'function') off(); else bus.off?.(topic, handler) } catch { /* ignore */ } })
  }

  const heartbeat = setInterval(() => {
    if (!send('ping', { at: now() })) return
  }, Math.max(10, Number(heartbeatMs) || 15000))
  heartbeat.unref?.()
  cleanups.push(() => clearInterval(heartbeat))

  for (const [target, event] of [[req, 'close'], [req, 'aborted'], [res, 'close'], [res, 'error']]) {
    if (target && typeof target.on === 'function') {
      const fn = () => close()
      try { target.on(event, fn) } catch { /* ignore */ }
      cleanups.push(() => { try { target.removeListener?.(event, fn) } catch { /* ignore */ } })
    }
  }

  return { close, send, headers, get closed() { return closed } }
}

/** 紧凑的 SSE 帧解析（客户端/测试共用；不依赖 EventSource）。 */
export function parseSseFrames(buffer = '') {
  const frames = []
  let rest = String(buffer)
  for (;;) {
    const index = rest.indexOf('\n\n')
    if (index < 0) break
    const raw = rest.slice(0, index)
    rest = rest.slice(index + 2)
    let event = 'message'
    const dataLines = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    let data = null
    if (dataLines.length) {
      try { data = JSON.parse(dataLines.join('\n')) } catch { data = null }
    }
    frames.push({ event, data })
  }
  return { frames, rest }
}
