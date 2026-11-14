// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.

import { CAPABILITIES, CONTRACT_VERSION, ERROR_CODES, METHOD_VERSION, METHODS } from './constants.js'
import { createResponse, normalizeError, validateEnvelope } from './envelope.js'
import { helloPayload, parseVersion, unsupportedMethodError } from './negotiate.js'

/**
 * 契约服务端（Fang 侧/任意一侧）：
 *   * hello() 返回协商信息；
 *   * invoke(envelope) 校验信封、检查方法版本、调用 handler、返回标准响应。
 *
 * 兼容原则：新增方法只需加 handler；删除/改义必须同时保留 method@old 一个 MINOR 周期。
 */
export function createContractServer({
  role = 'mother',
  instanceId = '',
  version = CONTRACT_VERSION,
  capabilities = CAPABILITIES,
  transports = [],
  handlers = {},
  logger = null,
  startedAt = Date.now(),
} = {}) {
  const registry = new Map(Object.entries(handlers))
  const hello = () => helloPayload({
    role,
    instanceId,
    version,
    methods: [...new Set([METHODS.HELLO, METHODS.HEALTH, ...registry.keys()])],
    capabilities,
    transports,
    startedAt,
  })
  const logs = { invoked: 0, failed: 0, lastError: null }

  const invoke = async (envelope) => {
    const validated = validateEnvelope(envelope)
    if (!validated.ok) {
      return createResponse({ id: envelope?.id, error: { code: ERROR_CODES.INVALID_ENVELOPE, message: validated.errors.join(', ') } })
    }
    const method = String(envelope.method)
    try {
      if (method === METHODS.HELLO) return createResponse({ id: envelope.id, result: hello() })
      if (method === METHODS.HEALTH) {
        return createResponse({ id: envelope.id, result: { ok: true, role, instanceId, version, uptimeMs: Date.now() - startedAt, methods: [...registry.keys()] } })
      }
      const handler = registry.get(method)
      if (!handler) return createResponse({ id: envelope.id, error: unsupportedMethodError(method) })
      const methodVersion = parseVersion(METHOD_VERSION[method] ?? '1.0')
      const localVersion = parseVersion(version)
      if (methodVersion && localVersion && methodVersion.major !== localVersion.major) {
        return createResponse({ id: envelope.id, error: { code: ERROR_CODES.UNSUPPORTED_VERSION, message: `method ${method} requires contract major ${methodVersion.major}` } })
      }
      logs.invoked += 1
      const result = await handler(envelope.params ?? null, envelope)
      return createResponse({ id: envelope.id, result: result ?? null, meta: { role, instanceId } })
    } catch (error) {
      logs.failed += 1
      logs.lastError = normalizeError(error, ERROR_CODES.HANDLER_THREW)
      if (!error?.code) logs.lastError.code = ERROR_CODES.HANDLER_THREW
      try { logger?.warn?.(`[contract] ${method} failed: ${logs.lastError.code} ${logs.lastError.message}`) } catch { /* ignore */ }
      return createResponse({ id: envelope?.id, error: logs.lastError })
    }
  }

  return {
    hello,
    invoke,
    describe() {
      return {
        protocol: 'fang-master', contractVersion: version, role, instanceId,
        methods: [...registry.keys()], capabilities, transports, stats: { ...logs },
      }
    },
  }
}
