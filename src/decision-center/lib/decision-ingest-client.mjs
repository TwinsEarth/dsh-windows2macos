// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang contributors — see LICENSE-CORE.
//
// decision-ingest-client — 给独立进程（PJM/Worker/HarnessMM/PluginUpdater/SuperAgent）
// 用的 fork 侧 ingest 客户端：
//   * 从母体 dataDir 发现 endpoint + token（DSH_FANG_MOTHER 或显式路径）
//   * 直连 POST /fang/api/decisions/ingest
//   * 失败时落本地 outbox，可 flush 重放（耐久，不丢 ticket）
// 注意：客户端存在 ≠ 业务已接；外部进程仍需在事件处调用 .submit()。
import process from 'node:process'

import { createDecisionOutbox, resolveMotherTarget } from './decision-outbox.mjs'

export function createForkIngestClient({
  dataDir,
  motherDataDir = process.env.DSH_FANG_MOTHER,
  fetchImpl,
  logger,
} = {}) {
  const dir = String(dataDir ?? '').trim()
  if (!dir) throw new TypeError('createForkIngestClient: dataDir required (outbox directory)')
  const outbox = createDecisionOutbox({ dataDir: dir, fetchImpl, logger })
  const target = () => resolveMotherTarget(motherDataDir)
  return {
    target,
    motherDataDir: String(motherDataDir ?? ''),
    /** 直连母体；失败自动落 outbox，返回 {ok, queued, ticket, outboxId?}。 */
    submit(payload) {
      return outbox.submit(payload, { motherDataDir })
    },
    flush() {
      return outbox.flush({ motherDataDir })
    },
    pending() {
      return outbox.pending()
    },
    list() {
      return outbox.list()
    },
  }
}
