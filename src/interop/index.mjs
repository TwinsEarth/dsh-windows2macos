/**
 * W2M 互联契约层（contract 1.x）：w2m ↔ 瓮城 dsh-Fang ↔ 房主 dsh-Master 的唯一通道。
 *
 * 三个项目相互独立、各自发布。这里不 import 任何对方内部代码，只使用已发布的版本化契约 SDK
 * （逐字节副本见 `src/interop/contract/`，来源与哈希见其 PROVENANCE.md）。
 *
 * 三个方向：
 *   * **w2m 作为服务端**：`createContractServer` 承载 `w2m.*` 方法，经 local 服务与
 *     `/api/w2m/contract/{hello,invoke,health}` 暴露；同宿主上 fang/master 的 local 传输默认找
 *     `fangContract` 服务，所以本插件在它缺席时**也**提供该名字（存在则不覆盖，避免和 fang 抢键）。
 *   * **w2m 作为客户端**：`createW2mContractClient` 直接复用 SDK 的 local → http → file → legacy
 *     四级降级路由，调用 fang/master 的方法（`fang.*`、`contract.*`）。
 *   * **file 兜底**：配置 `fileDir` 时挂上 SDK 的 file 契约服务端，HTTP 被挡/重启窗口仍能互通。
 *
 * 契约版本与插件版本解耦：`CONTRACT_VERSION`（SDK，1.1.1）管线协议；`W2M_CONTRACT_VERSION`
 * （1.0.0）管 w2m 方法表的语义版本；插件自身版本是 third thing，各自独立演进。
 */
import {
  CONTRACT_VERSION,
  METHODS as CONTRACT_METHODS,
  PROTOCOL,
  PROTOCOL_VERSION,
  createContractClient,
  createContractServer,
  startFileContractServer,
} from './contract/index.js';

/** w2m 方法表：只新增，不改既有方法语义；删除/改义必须升 W2M_CONTRACT_VERSION 的 MAJOR。 */
export const W2M_CONTRACT_VERSION = '1.0.0';

/** Cordis 插件面：契约层没有必需依赖，Connection 服务在 apply 里按需探测。 */
export const name = 'w2m-contract';
export const inject = [];

export const W2M_METHODS = Object.freeze({
  STATUS: 'w2m.status',
  METHODS: 'w2m.methods',
  FLEET_SNAPSHOT: 'w2m.fleet.snapshot',
  DEVICES_LIST: 'w2m.devices.list',
  TASKS_LIST: 'w2m.tasks.list',
});

/** 方法 → 契约版本（协商后按公共 minor 裁剪）。 */
export const W2M_METHOD_VERSION = Object.freeze({
  [W2M_METHODS.STATUS]: '1.0',
  [W2M_METHODS.METHODS]: '1.0',
  [W2M_METHODS.FLEET_SNAPSHOT]: '1.0',
  [W2M_METHODS.DEVICES_LIST]: '1.0',
  [W2M_METHODS.TASKS_LIST]: '1.0',
});

export const W2M_CONTRACT_CAPABILITIES = Object.freeze(['sync', 'async', 'idempotent']);

export const CONTRACT_ROUTE_PREFIX = '/api/w2m/contract';
export const CONTRACT_LOCAL_SERVICE = 'fangContract';
export const W2M_CONTRACT_SERVICE = 'w2mContract';

/** 服务缺席时的明确错误码：不伪造数据。 */
const SERVICE_ABSENT = 'w2m-service-absent';

function errorOf(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 从 Cordis 上下文读一个可选服务（读不到就是 undefined，不猜）。 */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? (ctx.get(name) ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 组装 w2m 契约服务端。
 *
 * @param {{ctx?: object, instanceId?: string, providers?: object, now?: () => number}} options
 *   providers 可注入 `status` / `fleetSnapshot` / `devices` / `tasks`，缺省时对应方法如实报
 *   `w2m-service-absent`，而不是返回空数据冒充成功。
 * @returns {{server: object, handlers: object}} server 即 SDK 契约服务端（hello/invoke/describe）。
 */
export function createW2mContractServer(options = {}) {
  const { ctx = null, instanceId = `w2m-${process.pid}` } = options;
  // providers 可由调用方注入，也可由宿主在 `w2mContractProviders` 服务里给出；两者都没有就如实报缺席。
  const configured = options.providers ?? serviceOf(ctx, 'w2mContractProviders') ?? {};
  const providers = configured !== null && typeof configured === 'object' ? configured : {};
  const startedAt = Date.now();
  const handler = (method, providerNames) => async (params) => {
    for (const name of providerNames) {
      const provider = providers[name];
      if (typeof provider === 'function') return provider(params ?? null);
    }
    throw errorOf(SERVICE_ABSENT, `${method}: this w2m host exposes no ${providerNames.join('/')} provider`);
  };
  const handlers = {
    [W2M_METHODS.STATUS]: async () => ({
      ok: true,
      plugin: 'w2m',
      contractVersion: W2M_CONTRACT_VERSION,
      sdkVersion: CONTRACT_VERSION,
      protocol: PROTOCOL,
      protocolVersion: PROTOCOL_VERSION,
      instanceId,
      methods: [...Object.keys(W2M_METHODS).map((key) => W2M_METHODS[key])],
      uptimeMs: Date.now() - startedAt,
    }),
    [W2M_METHODS.METHODS]: async () => ({
      ok: true,
      contractVersion: W2M_CONTRACT_VERSION,
      methods: Object.keys(W2M_METHODS).map((key) => ({
        method: W2M_METHODS[key],
        since: W2M_METHOD_VERSION[W2M_METHODS[key]],
      })),
    }),
    [W2M_METHODS.FLEET_SNAPSHOT]: handler(W2M_METHODS.FLEET_SNAPSHOT, ['fleetSnapshot']),
    [W2M_METHODS.DEVICES_LIST]: handler(W2M_METHODS.DEVICES_LIST, ['devices', 'fleetSnapshot']),
    [W2M_METHODS.TASKS_LIST]: handler(W2M_METHODS.TASKS_LIST, ['tasks']),
  };
  const server = createContractServer({
    // 契约 SDK 的角色词表只有 mother/essence/fork（Fang 概念），未知角色会被规整成 fork。
    // w2m 是“不是母体的对等端”，用 essence 表达；w2m 自己的身份在 instanceId 与 w2m.* 方法里。
    role: 'essence',
    instanceId,
    version: W2M_CONTRACT_VERSION,
    capabilities: W2M_CONTRACT_CAPABILITIES,
    transports: ['local', 'http', 'file'],
    handlers,
  });
  return { server, handlers };
}

/**
 * 组装 w2m 契约客户端：复用 SDK 的四级传输降级。
 *
 * @param {{ctx?: object, config?: object, fetchImpl?: typeof fetch, logger?: object, instanceId?: string}} options
 * @returns {object} SDK 客户端 + w2m 便捷方法
 */
export function createW2mContractClient(options = {}) {
  const client = createContractClient({
    ctx: options.ctx ?? null,
    config: options.config ?? {},
    fetchImpl: options.fetchImpl ?? fetch,
    logger: options.logger ?? null,
    instanceId: options.instanceId ?? `w2m-client-${process.pid}`,
  });
  return {
    ...client,
    async status(params = {}, invokeOptions = {}) {
      return client.invoke(W2M_METHODS.STATUS, params, invokeOptions);
    },
    async w2mMethods(params = {}, invokeOptions = {}) {
      return client.invoke(W2M_METHODS.METHODS, params, invokeOptions);
    },
    async fleetSnapshot(params = {}, invokeOptions = {}) {
      return client.invoke(W2M_METHODS.FLEET_SNAPSHOT, params, invokeOptions);
    },
    async devices(params = {}, invokeOptions = {}) {
      return client.invoke(W2M_METHODS.DEVICES_LIST, params, invokeOptions);
    },
    async tasks(params = {}, invokeOptions = {}) {
      return client.invoke(W2M_METHODS.TASKS_LIST, params, invokeOptions);
    },
  };
}

function json(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** 从请求体读 JSON（契约信封）；读不出就是空对象，交给 SDK 报 invalid-envelope。 */
async function envelopeOf(request) {
  if (request.method === 'GET') {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const method = url.searchParams.get('method');
      if (method === null) return null;
      const paramsRaw = url.searchParams.get('params');
      return { method, params: paramsRaw === null ? null : JSON.parse(paramsRaw) };
    } catch {
      return null;
    }
  }
  try {
    const value = await request.json();
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把契约端挂到宿主 Connection fetch 注册表上。
 *
 * 路径固定为 `/api/w2m/contract/*`：w2m 不占用 fang 的 `/fang/api/contract/*`，同宿主联通用
 * local 服务（默认 `fangContract`），跨宿主时对端把 pathPrefix 配成这里。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {{server: object}} deps
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerContractRoutes(ctx, deps) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    const register = (path, methods, fetchHandler) => {
      registry.register({ path, methods, requestBody: 'buffered', fetch: fetchHandler });
    };
    register(`${CONTRACT_ROUTE_PREFIX}/hello`, ['GET', 'POST'], async () => json(200, deps.server.hello()));
    register(`${CONTRACT_ROUTE_PREFIX}/health`, ['GET'], async () =>
      json(
        200,
        await deps.server.invoke({
          protocol: PROTOCOL,
          protocolVersion: PROTOCOL_VERSION,
          id: 'health',
          method: CONTRACT_METHODS.HEALTH,
          params: null,
          meta: {},
        }),
      ),
    );
    register(`${CONTRACT_ROUTE_PREFIX}/invoke`, ['POST', 'GET'], async (request) => {
      const envelope = await envelopeOf(request);
      return json(200, await deps.server.invoke(envelope));
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}

/**
 * 挂载 w2m 契约层：服务端 + 服务 + HTTP 路由（+ 可选 file 兜底）。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {{instanceId?: string, providers?: object, fileDir?: string, localService?: string}} [config]
 */
export function apply(ctx, config = {}) {
  const { server } = createW2mContractServer({
    ctx,
    instanceId:
      typeof config?.instanceId === 'string' && config.instanceId !== '' ? config.instanceId : undefined,
    providers: config?.providers ?? {},
  });
  const service = { ...server };
  const provide = (name) => {
    if (typeof ctx?.effect === 'function') ctx.effect(() => ctx.provide(name, service));
    else if (typeof ctx?.provide === 'function') ctx.provide(name, service);
  };
  provide(W2M_CONTRACT_SERVICE);
  const localServiceName =
    typeof config?.localService === 'string' && config.localService !== ''
      ? config.localService
      : CONTRACT_LOCAL_SERVICE;
  // 同宿主对端（fang/master 的 local 传输）默认找 `fangContract`：缺席时才补位，存在就让给 fang。
  if (serviceOf(ctx, localServiceName) === undefined) provide(localServiceName);
  registerContractRoutes(ctx, { server });
  if (typeof config?.fileDir === 'string' && config.fileDir !== '') {
    const fileServer = startFileContractServer({ dir: config.fileDir, server, logger: null });
    if (typeof ctx?.effect === 'function') ctx.effect(() => () => fileServer?.close?.());
  }
  return service;
}
