// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  CONTRACT_VERSION,
  DEFAULT_TRANSPORT_ORDER,
  ERROR_CODES,
  LEGACY_SERVICE_KEYS,
  METHODS,
  PROTOCOL,
} from './constants.js'
import { ContractTransportError, createEnvelope, createResponse, normalizeError, validateEnvelope } from './envelope.js'
import { helloPayload, negotiate } from './negotiate.js'

function safeGet(ctx, name) {
  try {
    if (!ctx || typeof ctx !== 'object') return null
    if (typeof ctx.get === 'function') return ctx.get(name) ?? null
    return ctx[name] ?? null
  } catch { return null }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms))) }

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {}
}

function baseOf(url) { return String(url ?? '').trim().replace(/\/+$/, '') }

/** 统一传输接口：{name, kind, available(), hello(), invoke(method, params, opts)}。 */

export function createLocalTransport({ ctx, serviceName = 'fangContract' } = {}) {
  const service = () => safeGet(ctx, serviceName)
  return {
    name: 'local', kind: 'local', available: () => Boolean(service() && typeof service().invoke === 'function'),
    async hello() {
      const s = service()
      if (!s) throw new ContractTransportError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'local contract service is absent', { transport: 'local' })
      return await s.hello()
    },
    async invoke(method, params, opts = {}) {
      const s = service()
      if (!s || typeof s.invoke !== 'function') throw new ContractTransportError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'local contract service is absent', { transport: 'local' })
      const response = await s.invoke(createEnvelope({ method, params, source: 'local', meta: opts.meta, timeoutMs: opts.timeoutMs }))
      const check = validateEnvelope(response, { response: true })
      if (!check.ok) throw new ContractTransportError(ERROR_CODES.INVALID_ENVELOPE, check.errors.join(','), { transport: 'local' })
      return response
    },
  }
}

export function createHttpTransport({ baseUrl = '', token = '', headers: extraHeaders = {}, fetchImpl = fetch, timeoutMs = 15_000, pathPrefix = '/fang/api/contract' } = {}) {
  const base = baseOf(baseUrl)
  const prefix = `/${String(pathPrefix).replace(/^\/+|\/+$/g, '')}`
  const available = () => Boolean(base)
  const call = async (endpoint, role, fn, callTimeoutMs = timeoutMs) => {
    if (!available()) throw new ContractTransportError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'http contract baseUrl is missing', { transport: 'http' })
    const effectiveTimeout = Math.max(1, Number(callTimeoutMs) || timeoutMs)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), effectiveTimeout)
    timer.unref?.()
    try {
      const response = await fetchImpl(`${base}${prefix}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(token), ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}) },
        body: JSON.stringify(role),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new ContractTransportError(ERROR_CODES.TRANSPORT_HTTP_ERROR, `HTTP ${response.status}`, { transport: 'http', detail: text.slice(0, 500) })
      }
      let parsed = null
      try { parsed = JSON.parse(text) } catch { throw new ContractTransportError(ERROR_CODES.INVALID_ENVELOPE, 'HTTP response is not JSON', { transport: 'http' }) }
      return fn(parsed)
    } catch (error) {
      if (error instanceof ContractTransportError) throw error
      if (error?.name === 'AbortError') throw new ContractTransportError(ERROR_CODES.TRANSPORT_TIMEOUT, `HTTP contract timeout (>${timeoutMs}ms)`, { transport: 'http', retryable: true })
      throw new ContractTransportError(ERROR_CODES.TRANSPORT_HTTP_ERROR, String(error?.message ?? error), { transport: 'http', retryable: true })
    } finally { clearTimeout(timer) }
  }
  return {
    name: 'http', kind: 'http', available,
    async hello() {
      return await call('/hello', { method: METHODS.HELLO }, (parsed) => {
        // 允许 /hello 直接返回 payload，或返回标准 response envelope。
        if (parsed && parsed.protocol) return parsed
        if (parsed && parsed.ok && parsed.result) return parsed.result
        throw new ContractTransportError(ERROR_CODES.INVALID_ENVELOPE, 'invalid hello payload', { transport: 'http' })
      })
    },
    async invoke(method, params, opts = {}) {
      const envelope = createEnvelope({ method, params, source: 'http', meta: opts.meta, timeoutMs: opts.timeoutMs })
      return await call('/invoke', envelope, (parsed) => {
        const check = validateEnvelope(parsed, { response: true })
        if (!check.ok) throw new ContractTransportError(ERROR_CODES.INVALID_ENVELOPE, check.errors.join(','), { transport: 'http' })
        return parsed
      }, opts.timeoutMs)
    },
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  return fs.writeFile(tmp, text, 'utf8').then(() => fs.rename(tmp, file))
}

/** Windows 对端仍持有句柄时 unlink 可能短暂 EPERM；成功响应后做有界重试清理。 */
async function removeFileWithRetry(file, attempts = 8) {
  for (let index = 0; index < attempts; index += 1) {
    try { await fs.unlink(file); return true } catch (error) {
      if (error?.code === 'ENOENT') return true
      if (index + 1 < attempts) await sleep(25 * (index + 1))
    }
  }
  return false
}

/**
 * 文件 outbox 兜底传输：同一文件系统、无网络/无 HTTP 时使用。
 * 请求写 requests/<id>.json，对端（startFileContractServer）写 responses/<id>.json。
 */
export function createFileTransport({ dir = '', fetchImpl = null, pollMs = 100, timeoutMs = 15_000 } = {}) {
  const root = String(dir ?? '').trim()
  const directories = {
    request: path.join(root, 'requests'),
    response: path.join(root, 'responses'),
  }
  const ensure = async () => {
    await fs.mkdir(directories.request, { recursive: true })
    await fs.mkdir(directories.response, { recursive: true })
  }
  return {
    name: 'file', kind: 'file',
    available: () => Boolean(root),
    async hello() {
      if (!root) throw new ContractTransportError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'file transport dir is missing', { transport: 'file' })
      return await this.invoke(METHODS.HELLO, null).then((response) => (response.ok ? response.result : Promise.reject(new ContractTransportError(ERROR_CODES.REMOTE_ERROR, response.error?.message ?? 'hello failed', { transport: 'file' }))))
    },
    async invoke(method, params, opts = {}) {
      if (!root) throw new ContractTransportError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'file transport dir is missing', { transport: 'file' })
      await ensure()
      const envelope = createEnvelope({ method, params, source: 'file', meta: opts.meta, timeoutMs: opts.timeoutMs })
      const requestFile = path.join(directories.request, `${envelope.id}.json`)
      const responseFile = path.join(directories.response, `${envelope.id}.json`)
      await atomicWrite(requestFile, JSON.stringify(envelope))
      const effectiveTimeout = Math.max(1, Number(opts.timeoutMs) || timeoutMs)
      const deadline = Date.now() + effectiveTimeout
      while (Date.now() < deadline) {
        try {
          const text = await fs.readFile(responseFile, 'utf8')
          await removeFileWithRetry(responseFile)
          const parsed = JSON.parse(text)
          const check = validateEnvelope(parsed, { response: true })
          if (!check.ok) throw new ContractTransportError(ERROR_CODES.INVALID_ENVELOPE, check.errors.join(','), { transport: 'file' })
          // 请求文件由调用方负责回收：服务端实现可能只写响应而不删请求，
          // 成功匹配响应后必须幂等清理，避免 contract-outbox 长期积累。
          await removeFileWithRetry(requestFile)
          return parsed
        } catch (error) {
          if (error instanceof ContractTransportError) throw error
        }
        await sleep(pollMs)
      }
      await removeFileWithRetry(requestFile)
      await removeFileWithRetry(responseFile)
      throw new ContractTransportError(ERROR_CODES.TRANSPORT_TIMEOUT, `file contract timeout (>${effectiveTimeout}ms)`, { transport: 'file', retryable: true })
    },
  }
}

/**
 * 文件 fallback 的服务端轮询器：读取 requests/，调用 contractServer.invoke，写 responses/。
 * @returns {{stop:()=>void, describe:()=>(object)}}
 */
export function startFileContractServer({ dir, server, pollMs = 100, maxAgeMs = 60_000, logger = null } = {}) {
  const root = String(dir ?? '').trim()
  if (!root) throw new Error('startFileContractServer requires dir')
  const requestDir = path.join(root, 'requests')
  const responseDir = path.join(root, 'responses')
  let stopped = false
  let timer = null
  const tick = async () => {
    if (stopped) return
    try {
      await fs.mkdir(requestDir, { recursive: true })
      await fs.mkdir(responseDir, { recursive: true })
      const entries = await fs.readdir(requestDir).catch(() => [])
      for (const name of entries) {
        if (!name.endsWith('.json')) continue
        const file = path.join(requestDir, name)
        try {
          const stat = await fs.stat(file)
          if (Date.now() - stat.mtimeMs > maxAgeMs) { await fs.unlink(file).catch(() => {}); continue }
          const envelope = JSON.parse(await fs.readFile(file, 'utf8'))
          const response = await server.invoke(envelope)
          await atomicWrite(path.join(responseDir, `${envelope.id}.json`), JSON.stringify(response))
          await fs.unlink(file).catch(() => {})
        } catch (error) {
          try { logger?.warn?.(`[contract:file] ${name}: ${String(error?.message ?? error)}`) } catch { /* ignore */ }
          await fs.unlink(file).catch(() => {})
        }
      }
    } catch { /* poll must not die */ }
    if (!stopped) timer = setTimeout(tick, pollMs)
  }
  timer = setTimeout(tick, pollMs)
  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null },
    describe() { return { transport: 'file', dir: root, pollMs, stopped } },
  }
}

/** 旧版 3.1.x 服务键回退：接口包被替换/新端点不存在时仍能工作。 */
export function createLegacyTransport({ ctx } = {}) {
  const forker = () => safeGet(ctx, LEGACY_SERVICE_KEYS.forker)
  const decision = () => safeGet(ctx, LEGACY_SERVICE_KEYS.decisionCenter)
  const sessions = () => safeGet(ctx, LEGACY_SERVICE_KEYS.sessionCatalog)
  const orchestrator = () => safeGet(ctx, LEGACY_SERVICE_KEYS.orchestrator)
  const available = () => Boolean(forker() || decision() || sessions() || orchestrator())
  return {
    name: 'legacy', kind: 'legacy', available,
    async hello() {
      return {
        protocol: PROTOCOL, contractVersion: '0.9.0', role: 'mother', instanceId: 'legacy',
        methods: [METHODS.HEALTH, METHODS.FORK_SPAWN, METHODS.DECISION_CREATE, METHODS.SESSION_LIST],
        capabilities: ['sync'], transports: ['legacy'],
      }
    },
    async invoke(method, params) {
      if (method === METHODS.HEALTH) return createResponse({ result: { ok: true, legacy: true } })
      if (method === METHODS.FORK_SPAWN) {
        const service = forker()
        if (!service || typeof service.spawn !== 'function') throw new ContractTransportError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'legacy fangForker is absent', { transport: 'legacy' })
        return createResponse({ result: await service.spawn(params ?? {}) })
      }
      if (method === METHODS.DECISION_CREATE) {
        const service = decision()
        if (!service || typeof service.create !== 'function') throw new ContractTransportError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'legacy fangDecisionCenter is absent', { transport: 'legacy' })
        return createResponse({ result: await service.create(params ?? {}) })
      }
      if (method === METHODS.SESSION_LIST) {
        const service = sessions()
        if (!service || typeof service.list !== 'function') throw new ContractTransportError(ERROR_CODES.TRANSPORT_UNAVAILABLE, 'legacy fangSessionCatalog is absent', { transport: 'legacy' })
        return createResponse({ result: await service.list(params ?? {}) })
      }
      throw new ContractTransportError(ERROR_CODES.UNSUPPORTED_METHOD, `legacy transport cannot serve ${method}`, { transport: 'legacy' })
    },
  }
}

/**
 * 传输路由器：按 local → http → file → legacy 顺序尝试；
 * 传输不可用/超时/协议不兼容/未知方法时自动降级；业务错误不降级（避免重复副作用）。
 */
export function createTransportRouter({ transports = [], order = DEFAULT_TRANSPORT_ORDER, localHello = null, logger = null } = {}) {
  const byName = new Map(transports.map((transport) => [transport.name, transport]))
  const ordered = order.map((name) => byName.get(name)).filter((transport) => transport && (!transport.available || transport.available()))
  const attempts = []
  const record = (entry) => { attempts.push({ at: Date.now(), ...entry }); if (attempts.length > 100) attempts.shift() }
  return {
    transports: () => ordered.map((transport) => ({ name: transport.name, kind: transport.kind })),
    attempts: () => [...attempts],
    describe() {
      return {
        order,
        available: ordered.map((transport) => transport.name),
        configured: transports.map((transport) => ({ name: transport.name, kind: transport.kind, available: transport.available ? transport.available() : true })),
      }
    },
    async hello() {
      const local = localHello ?? helloPayload({ role: 'client', instanceId: 'contract-client' })
      for (const transport of ordered) {
        try {
          const remote = await transport.hello()
          const negotiation = negotiate(local, remote)
          record({ transport: transport.name, action: 'hello', ok: true, compatible: negotiation.compatible, reason: negotiation.reason ?? null })
          if (negotiation.compatible) return { ok: true, transport: transport.name, hello: remote, negotiation, fallback: null }
          // remote-too-old/新：若还有后续传输（如 legacy），继续降级。
          if (transport.name !== 'legacy') continue
          return { ok: true, transport: transport.name, hello: remote, negotiation, fallback: 'legacy' }
        } catch (error) {
          record({ transport: transport.name, action: 'hello', ok: false, code: error?.code ?? null })
          try { logger?.warn?.(`[contract] hello via ${transport.name} failed: ${error?.code ?? error?.message ?? error}`) } catch { /* ignore */ }
        }
      }
      return { ok: false, code: ERROR_CODES.ALL_TRANSPORTS_FAILED, error: 'no transport could complete hello', attempts: this.attempts() }
    },
    async invoke(method, params, { idempotencyKey = '', timeoutMs = 30_000 } = {}) {
      const envelopeMeta = idempotencyKey ? { idempotencyKey } : {}
      const failures = []
      for (const transport of ordered) {
        try {
          const response = await transport.invoke(method, params, { timeoutMs, meta: envelopeMeta })
          // 有的传输（local）返回 response envelope；统一读取。
          const ok = response?.ok === true
          record({ transport: transport.name, action: method, ok, code: response?.error?.code ?? null })
          if (ok) return { ok: true, transport: transport.name, response }
          const code = String(response?.error?.code ?? '')
          const fallbackable = code === ERROR_CODES.UNSUPPORTED_METHOD || code === ERROR_CODES.UNSUPPORTED_VERSION || response?.error?.retryable === true
          failures.push({ transport: transport.name, code, message: response?.error?.message ?? '' })
          if (!fallbackable) return { ok: false, transport: transport.name, response, error: response?.error ?? normalizeError(code), attempts: this.attempts() }
        } catch (error) {
          const code = error?.code ?? ERROR_CODES.TRANSPORT_UNAVAILABLE
          failures.push({ transport: transport.name, code, message: String(error?.message ?? error) })
          record({ transport: transport.name, action: method, ok: false, code })
          try { logger?.warn?.(`[contract] ${method} via ${transport.name} failed: ${code} ${error?.message ?? ''}`) } catch { /* ignore */ }
        }
      }
      return { ok: false, code: ERROR_CODES.ALL_TRANSPORTS_FAILED, error: 'all contract transports failed', failures, attempts: this.attempts() }
    },
  }
}

export { CONTRACT_VERSION, LEGACY_SERVICE_KEYS, METHODS }
