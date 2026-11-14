// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.

import crypto from 'node:crypto'

import { ERROR_CODES, PROTOCOL, PROTOCOL_VERSION } from './constants.js'

export function newId(prefix = 'msg') {
  return `${prefix}_${crypto.randomUUID()}`
}

/** 创建请求信封；未知字段由接收方忽略（兼容规则）。 */
export function createEnvelope({ method, params = null, id, source = '', instanceId = '', timeoutMs = 30_000, meta = {} } = {}) {
  if (!method || typeof method !== 'string') throw new Error('method is required')
  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    id: String(id ?? newId('req')),
    method: String(method),
    params: params ?? null,
    meta: {
      at: Date.now(),
      deadline: Date.now() + Math.max(1, Number(timeoutMs) || 30_000),
      source: String(source ?? ''),
      instanceId: String(instanceId ?? ''),
      ...(meta && typeof meta === 'object' ? meta : {}),
    },
  }
}

/** 校验请求/响应信封；返回 {ok, errors, envelope}。 */
export function validateEnvelope(value, { response = false } = {}) {
  const errors = []
  const raw = value && typeof value === 'object' ? value : {}
  if (raw.protocol !== PROTOCOL) errors.push(`protocol-invalid:${String(raw.protocol)}`)
  if (raw.protocolVersion !== PROTOCOL_VERSION) errors.push(`protocol-version-invalid:${String(raw.protocolVersion)}`)
  if (!raw.id) errors.push('id-required')
  if (response) {
    if (typeof raw.ok !== 'boolean') errors.push('ok-required')
    if (raw.ok === false && !raw.error?.code) errors.push('error-code-required')
  } else if (!raw.method) {
    errors.push('method-required')
  }
  return { ok: errors.length === 0, errors, envelope: raw }
}

export function createResponse({ id, result, error, meta = {} } = {}) {
  const base = {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    id: String(id ?? newId('res')),
    ok: !error,
    meta: { at: Date.now(), ...(meta && typeof meta === 'object' ? meta : {}) },
  }
  if (error) return { ...base, error: normalizeError(error) }
  return { ...base, result: result ?? null }
}

export function normalizeError(error, fallbackCode = ERROR_CODES.REMOTE_ERROR) {
  if (!error) return { code: fallbackCode, message: String(fallbackCode), retryable: false }
  if (typeof error === 'string') return { code: fallbackCode, message: error, retryable: false }
  return {
    code: String(error.code ?? fallbackCode),
    message: String(error.message ?? error.error ?? fallbackCode),
    retryable: error.retryable === true,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  }
}

export class ContractTransportError extends Error {
  constructor(code, message, { transport = '', detail = null, retryable = false } = {}) {
    super(String(message ?? code))
    this.name = 'ContractTransportError'
    this.code = String(code)
    this.transport = String(transport)
    this.detail = detail
    this.retryable = retryable === true
  }
}

export function isCompatibleResponse(value) {
  return validateEnvelope(value, { response: true }).ok
}
