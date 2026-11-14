// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.

import { DEFAULT_TRANSPORT_ORDER, METHODS } from './constants.js'
import {
  createFileTransport,
  createHttpTransport,
  createLegacyTransport,
  createLocalTransport,
  createTransportRouter,
} from './transports.js'

/**
 * 客户端门面：一次配置，按 local → http → file → legacy 自动降级。
 *
 * @param {{
 *  ctx?: object,
 *  config?: {httpBaseUrl?:string, httpToken?:string, fileDir?:string, order?:string[], timeoutMs?:number},
 *  fetchImpl?: typeof fetch,
 *  logger?: object,
 *  instanceId?: string,
 * }} options
 */
export function createContractClient(options = {}) {
  const { ctx = null, config = {}, fetchImpl = fetch, logger = null, instanceId = 'contract-client' } = options
  const transports = []
  if (ctx) transports.push(createLocalTransport({ ctx }))
  if (config.httpBaseUrl) transports.push(createHttpTransport({
    baseUrl: config.httpBaseUrl,
    token: config.httpToken,
    headers: config.httpHeaders,
    fetchImpl,
    timeoutMs: config.timeoutMs,
    pathPrefix: config.pathPrefix,
  }))
  if (config.fileDir) transports.push(createFileTransport({
    dir: config.fileDir,
    pollMs: config.filePollMs,
    timeoutMs: config.fileTimeoutMs,
  }))
  if (ctx) transports.push(createLegacyTransport({ ctx }))

  const order = Array.isArray(config.order) && config.order.length > 0 ? config.order : DEFAULT_TRANSPORT_ORDER
  const router = createTransportRouter({
    transports,
    order,
    localHello: null,
    logger,
  })
  let lastHello = null
  let helloPromise = null

  const client = {
    instanceId,
    transports: () => router.transports(),
    describe: () => ({
      instanceId,
      routes: router.describe(),
      hello: lastHello,
    }),
    attempts: () => router.attempts(),
    async hello(force = false) {
      if (!force && lastHello) return lastHello
      if (!force && helloPromise) return helloPromise
      helloPromise = (async () => {
        const result = await router.hello()
        lastHello = result
        return result
      })().finally(() => { helloPromise = null })
      return helloPromise
    },
    async invoke(method, params, invokeOptions = {}) {
      const result = await router.invoke(method, params, { timeoutMs: config.timeoutMs, ...invokeOptions })
      return result
    },
    async health() { return await client.invoke(METHODS.HEALTH, null) },
    async spawnFork(params, invokeOptions = {}) { return await client.invoke(METHODS.FORK_SPAWN, params, invokeOptions) },
    async stopFork(params, invokeOptions = {}) { return await client.invoke(METHODS.FORK_STOP, params, invokeOptions) },
    async listForks(params = {}, invokeOptions = {}) { return await client.invoke(METHODS.FORK_LIST, params, invokeOptions) },
    async createDecision(params, invokeOptions = {}) { return await client.invoke(METHODS.DECISION_CREATE, params, invokeOptions) },
    async resolveDecision(params, invokeOptions = {}) { return await client.invoke(METHODS.DECISION_RESOLVE, params, invokeOptions) },
    async listSessions(params = {}, invokeOptions = {}) { return await client.invoke(METHODS.SESSION_LIST, params, invokeOptions) },
    async orchestratorStatus(params = {}, invokeOptions = {}) { return await client.invoke(METHODS.ORCHESTRATOR_STATUS, params, invokeOptions) },
    /** contract 1.1：批量投递回流事件（按 event.id 幂等；返回回执与游标）。 */
    async publishRelay(events, invokeOptions = {}) {
      const params = Array.isArray(events) ? { events } : (events && typeof events === 'object' ? events : { events: [] })
      return await client.invoke(METHODS.RELAY_PUBLISH, params, invokeOptions)
    },
    /** contract 1.1：读取对端回流状态（对端自报 peer/cursor/累计计数）。 */
    async relayStatus(params = {}, invokeOptions = {}) { return await client.invoke(METHODS.RELAY_STATUS, params, invokeOptions) },
  }
  return client
}
