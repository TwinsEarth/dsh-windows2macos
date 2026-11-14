// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.

/**
 * 契约常量与兼容规则（contract SDK 1.x）。
 *
 * 稳定承诺：
 *   * MAJOR 相同的版本保证“旧字段可读、旧方法可调、未知字段忽略”；
 *   * 新增能力只通过 METHODS/CAPABILITIES 扩展，不改变既有方法语义；
 *   * 删除/改义必须升 MAJOR，并保留至少一个 MINOR 周期的双写（method@1 与 method@2）。
 */

export const CONTRACT_PACKAGE = '@twinsearth/dsh-fang-contract'
export const CONTRACT_VERSION = '1.1.1'
export const PROTOCOL = 'fang-master'
export const PROTOCOL_VERSION = 1
export const MIN_COMPATIBLE_MAJOR = 1

/** 稳定方法名（新方法只能追加）。 */
export const METHODS = Object.freeze({
  HELLO: 'contract.hello',
  HEALTH: 'contract.health',
  FORK_SPAWN: 'fang.fork.spawn',
  FORK_STOP: 'fang.fork.stop',
  FORK_LIST: 'fang.fork.list',
  DECISION_CREATE: 'fang.decision.create',
  DECISION_RESOLVE: 'fang.decision.resolve',
  SESSION_LIST: 'fang.session.list',
  ORCHESTRATOR_STATUS: 'fang.orchestrator.status',
  RELAY_PUBLISH: 'fang.relay.publish',
  RELAY_STATUS: 'fang.relay.status',
})

/** 方法 → 契约版本（用于协商后的方法裁剪）。 */
export const METHOD_VERSION = Object.freeze({
  [METHODS.HELLO]: '1.0',
  [METHODS.HEALTH]: '1.0',
  [METHODS.FORK_SPAWN]: '1.0',
  [METHODS.FORK_STOP]: '1.0',
  [METHODS.FORK_LIST]: '1.0',
  [METHODS.DECISION_CREATE]: '1.0',
  [METHODS.DECISION_RESOLVE]: '1.0',
  [METHODS.SESSION_LIST]: '1.0',
  [METHODS.ORCHESTRATOR_STATUS]: '1.0',
  [METHODS.RELAY_PUBLISH]: '1.1',
  [METHODS.RELAY_STATUS]: '1.1',
})

export const CAPABILITIES = Object.freeze([
  'sync', 'async', 'idempotent', 'stream-events', 'file-outbox', 'event-relay',
])

export const ROLES = Object.freeze(['mother', 'essence', 'fork'])

export const ERROR_CODES = Object.freeze({
  INVALID_ENVELOPE: 'invalid-envelope',
  UNSUPPORTED_METHOD: 'unsupported-method',
  UNSUPPORTED_VERSION: 'unsupported-version',
  INCOMPATIBLE: 'contract-incompatible',
  TRANSPORT_UNAVAILABLE: 'transport-unavailable',
  TRANSPORT_TIMEOUT: 'transport-timeout',
  TRANSPORT_HTTP_ERROR: 'transport-http-error',
  REMOTE_ERROR: 'remote-error',
  ALL_TRANSPORTS_FAILED: 'all-transports-failed',
  HANDLER_THREW: 'handler-threw',
})

/**
 * 兜底顺序（从快到慢）：
 *   local  —— 同一 Host 的 DSH 服务（零网络、首选）
 *   http   —— 母体/原身 HTTP 契约端点
 *   file   —— 同一文件系统的 outbox/inbox（HTTP 不可用/被防火墙拦）
 *   legacy —— 直接调用 3.1.x 的旧 DSH 服务键（接口包被替换/新端点不存在时）
 */
export const DEFAULT_TRANSPORT_ORDER = Object.freeze(['local', 'http', 'file', 'legacy'])

/** 3.1.x 及更早的旧服务键（只读兼容；不新增语义）。 */
export const LEGACY_SERVICE_KEYS = Object.freeze({
  forker: 'fangForker',
  decisionCenter: 'fangDecisionCenter',
  sessionCatalog: 'fangSessionCatalog',
  orchestrator: 'fang',
})

/**
 * 回流接口的硬上限（1.1）。超限是**协议错误**而不是静默截断：
 * 调用方必须自己分批，服务端不得悄悄丢事件（回流要可对账）。
 */
export const RELAY_LIMITS = Object.freeze({
  maxBatch: 128,
  maxEventBytes: 32_000,
  maxPayloadBytes: 512_000,
  maxRecords: 5_000,
})
