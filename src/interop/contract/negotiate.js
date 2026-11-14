// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.

import {
  CAPABILITIES,
  CONTRACT_VERSION,
  ERROR_CODES,
  METHOD_VERSION,
  METHODS,
  MIN_COMPATIBLE_MAJOR,
  PROTOCOL,
  ROLES,
} from './constants.js'

export function parseVersion(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), text,
  }
}

export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  return pa.patch - pb.patch
}

/** 标准 hello payload（服务端暴露；客户端据此协商）。 */
export function helloPayload({
  role = 'mother',
  instanceId = '',
  version = CONTRACT_VERSION,
  methods = Object.values(METHODS),
  capabilities = CAPABILITIES,
  transports = [],
  startedAt = Date.now(),
} = {}) {
  return {
    protocol: PROTOCOL,
    contractVersion: String(version),
    role: ROLES.includes(String(role)) ? String(role) : 'fork',
    instanceId: String(instanceId ?? ''),
    startedAt: Number(startedAt) || Date.now(),
    methods: [...new Set(methods.map(String))],
    capabilities: [...new Set(capabilities.map(String))],
    transports: [...new Set(transports.map(String))],
    features: {
      idempotency: true,
      envelopes: true,
      fileOutbox: true,
      versionNegotiation: true,
    },
  }
}

/**
 * 双向版本协商。
 * @param {object} local 本端 helloPayload
 * @param {object} remote 对端 helloPayload
 * @returns {{ok:boolean, compatible:boolean, fallback:'legacy'|null, reason?:string, version?:string, methods:string[], capabilities:string[], features:object}}
 */
export function negotiate(local, remote) {
  const lv = parseVersion(local?.contractVersion)
  const rv = parseVersion(remote?.contractVersion)
  if (local?.protocol !== PROTOCOL || remote?.protocol !== PROTOCOL) {
    return { ok: false, compatible: false, fallback: 'legacy', reason: 'protocol-mismatch', methods: [], capabilities: [], features: {} }
  }
  if (!lv || !rv) {
    return { ok: false, compatible: false, fallback: 'legacy', reason: 'version-invalid', methods: [], capabilities: [], features: {} }
  }
  if (rv.major < MIN_COMPATIBLE_MAJOR) {
    return { ok: false, compatible: false, fallback: 'legacy', reason: 'remote-too-old', methods: [], capabilities: [], features: {} }
  }
  if (rv.major > lv.major) {
    return { ok: false, compatible: false, fallback: 'legacy', reason: 'remote-too-new', methods: [], capabilities: [], features: {} }
  }
  const localMethods = new Set(Array.isArray(local.methods) ? local.methods : [])
  const methods = (Array.isArray(remote.methods) ? remote.methods : []).filter((method) => localMethods.has(method))
  // 裁剪：方法所需契约 minor 不能高于双方共同支持的 minor。
  const commonMinor = Math.min(lv.minor, rv.minor)
  const supported = methods.filter((method) => {
    const methodVersion = parseVersion(METHOD_VERSION[method] ?? '1.0')
    return !methodVersion || methodVersion.minor <= commonMinor || methodVersion.major < lv.major
  })
  const localCaps = new Set(Array.isArray(local.capabilities) ? local.capabilities : [])
  const capabilities = (Array.isArray(remote.capabilities) ? remote.capabilities : []).filter((cap) => localCaps.has(cap))
  const version = `${Math.min(lv.major, rv.major)}.${commonMinor}.0`
  return {
    ok: true,
    compatible: true,
    fallback: null,
    version,
    methods: supported,
    capabilities,
    features: { ...(local.features ?? {}), ...(remote.features ?? {}) },
  }
}

export function unsupportedMethodError(method) {
  return { code: ERROR_CODES.UNSUPPORTED_METHOD, message: `unsupported method: ${String(method)}`, retryable: false }
}
