// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// producer-contract — 业务生产者 → 决策中心的统一调用契约（v1）。
//
// 这五个系统本体不在本仓：本模块只定义「它们该怎么调用」，并提供：
//   * normalizeProducerPayload(input)  字段校验 + 默认值 + 稳定 dedupeKey
//   * createProducerSubmitter({submit}) 统一提交封装（返回统一 envelope）
//   * producerCatalog()                机器可读契约目录（UI/外部系统可发现）
import { nowMs } from '../kernel.mjs'

export const PRODUCER_CONTRACT_VERSION = 1
export const PRODUCER_LEVELS = Object.freeze(['red', 'yellow', 'blue', 'green'])
export const PRODUCER_NAMES = Object.freeze(['HarnessMM', 'PluginUpdater', 'SuperAgent', 'PJM', 'Worker'])

export const PRODUCER_CONTRACTS = Object.freeze({
  HarnessMM: Object.freeze({
    kinds: ['harnessmm-suggestion'],
    defaultLevel: 'blue',
    sourceRole: 'worker',
    required: ['title'],
    defaultActions: [
      { id: 'accept', label: '采纳', type: 'default' },
      { id: 'ignore', label: '忽略', type: 'default' },
    ],
  }),
  PluginUpdater: Object.freeze({
    kinds: ['plugin-updater-backup'],
    defaultLevel: 'green',
    sourceRole: 'worker',
    required: ['title'],
    defaultActions: [],
  }),
  SuperAgent: Object.freeze({
    kinds: ['superagent-completion'],
    defaultLevel: 'green',
    sourceRole: 'worker',
    required: ['title'],
    defaultActions: [],
  }),
  PJM: Object.freeze({
    kinds: ['pjm-timeout', 'pjm-fatal'],
    defaultLevel: 'yellow',
    sourceRole: 'pjm',
    required: ['title'],
    defaultActions: [
      { id: 'retry', label: '重试', type: 'primary' },
      { id: 'abandon', label: '放弃', type: 'default' },
    ],
  }),
  Worker: Object.freeze({
    kinds: ['worker-deviation'],
    defaultLevel: 'yellow',
    sourceRole: 'worker',
    required: ['title'],
    defaultActions: [
      { id: 'review', label: '查看', type: 'primary' },
      { id: 'ignore', label: '忽略', type: 'default' },
    ],
  }),
})

const fail = (code, extra = {}) => ({ ok: false, code, ...extra })

/** 稳定默认 dedupeKey：调用方显式传优先，否则用常见业务 id 派生。 */
function deriveDedupeKey(producer, kind, raw) {
  if (raw.dedupeKey !== undefined && raw.dedupeKey !== null && String(raw.dedupeKey).trim()) return String(raw.dedupeKey).trim().slice(0, 200)
  const ref = raw.id ?? raw.backupId ?? raw.suggestionId ?? raw.taskId ?? raw.projectId ?? raw.workerId
  if (ref === undefined || ref === null || String(ref).trim() === '') return undefined
  return `${producer}:${kind}:${String(ref).trim()}`.slice(0, 200)
}

/**
 * 校验并补全统一 payload。成功返回 { ok:true, payload }；失败返回 { ok:false, code, errors }。
 * 不写盘、不提交。
 */
export function normalizeProducerPayload(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid-payload')
  const producer = String(input.producer ?? '').trim()
  const contract = PRODUCER_CONTRACTS[producer]
  if (!contract) return fail('unknown-producer', { allowedProducers: [...PRODUCER_NAMES] })
  const kind = String(input.kind ?? contract.kinds[0]).trim()
  if (!contract.kinds.includes(kind)) {
    return fail('unknown-kind', { producer, allowedKinds: [...contract.kinds] })
  }
  const level = input.level === undefined || input.level === null ? contract.defaultLevel : String(input.level).trim().toLowerCase()
  if (!PRODUCER_LEVELS.includes(level)) return fail('bad-level', { allowedLevels: [...PRODUCER_LEVELS] })
  const title = String(input.title ?? '').trim()
  if (!title) return fail('title-required')
  const actions = Array.isArray(input.actions) ? input.actions.slice(0, 12)
    : (Array.isArray(contract.defaultActions) && contract.defaultActions.length > 0 ? contract.defaultActions.map((item) => ({ ...item })) : undefined)
  const options = Array.isArray(input.options) ? input.options.slice(0, 12) : undefined
  if (level !== 'green' && !(actions?.length) && !(options?.length)) {
    return fail('options-or-actions-required', { level })
  }
  const timeoutMinutes = Number.isFinite(Number(input.timeoutMinutes))
    ? Math.max(0, Number(input.timeoutMinutes))
    : kind === 'pjm-timeout' ? 5 : undefined
  const payload = {
    producer,
    kind,
    level,
    title: title.slice(0, 500),
    context: String(input.context ?? input.description ?? `${producer}/${kind}`).slice(0, 12000),
    ...(actions ? { actions } : {}),
    ...(options ? { options } : {}),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    ...(deriveDedupeKey(producer, kind, input) ? { dedupeKey: deriveDedupeKey(producer, kind, input) } : {}),
    sourceRole: String(input.sourceRole ?? contract.sourceRole),
    ...(input.sessionId ? { sessionId: String(input.sessionId).slice(0, 200) } : {}),
    ...(input.metadata && typeof input.metadata === 'object' ? { metadata: input.metadata } : {}),
    producerContractVersion: PRODUCER_CONTRACT_VERSION,
    at: nowMs(),
  }
  return { ok: true, payload }
}

/** 统一提交封装：返回固定 envelope，外部系统不需要理解 decision-center 内部形状。 */
export function createProducerSubmitter({ submit } = {}) {
  if (typeof submit !== 'function') throw new TypeError('createProducerSubmitter: submit required')
  return async function submitProducerEvent(input = {}) {
    const normalized = normalizeProducerPayload(input)
    if (!normalized.ok) {
      return { ok: false, code: normalized.code, errors: normalized.errors ?? null, ...normalized }
    }
    let out = null
    try {
      out = await submit(normalized.payload)
    } catch (error) {
      return { ok: false, code: 'submit-failed', error: String(error?.message ?? error).slice(0, 500) }
    }
    return {
      ok: out?.ok !== false,
      producer: normalized.payload.producer,
      kind: normalized.payload.kind,
      level: normalized.payload.level,
      ticketId: out?.ticket?.id ?? null,
      deduped: out?.deduped === true,
      queued: out?.queued === true,
      outboxId: out?.outboxId ?? null,
      reason: out?.reason ?? null,
    }
  }
}

export function producerCatalog() {
  return {
    ok: true,
    version: PRODUCER_CONTRACT_VERSION,
    producers: PRODUCER_NAMES.map((producer) => {
      const contract = PRODUCER_CONTRACTS[producer]
      return {
        producer,
        kinds: [...contract.kinds],
        defaultLevel: contract.defaultLevel,
        sourceRole: contract.sourceRole,
        required: [...contract.required],
        payload: ['producer', 'kind', 'level?', 'title', 'context', 'actions|options', 'timeoutMinutes?', 'dedupeKey?', 'sourceRole?', 'sessionId?'],
      }
    }),
  }
}
