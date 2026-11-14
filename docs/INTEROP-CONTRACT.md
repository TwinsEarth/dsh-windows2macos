# w2m ↔ 瓮城 dsh-Fang ↔ 房主 dsh-Master：独立版本化互联契约（contract 1.x）

本文是 w2m 仓库内的契约层设计说明。三个项目相互独立：各有 package / 版本 / repo / 发布节奏，
**互不 import 内部代码**，只通过本文描述的契约 SDK 互联。w2m 的实现文件在 `src/interop/`，
SDK 是 `@twinsearth/dsh-fang-contract@1.1.1` 的逐字节副本（来源与哈希见
`src/interop/contract/PROVENANCE.md`）。

## 1. 要解决的问题

两个主插件（瓮城 dsh-Fang、房主 dsh-Master）各自独立发布。如果它们互相 import 内部代码，
任何一侧改接口都会把另一侧锁死版本；如果它们各自发明私有 IPC，又会退化成两套协议。
契约层把「怎么说话」从「说什么」里拆出来：

| 关注点                 | 归属                                                         |
| ---------------------- | ------------------------------------------------------------ |
| 方法名与语义（说什么） | 契约包的方法表（`METHODS` + 本仓库的 `W2M_METHODS`）         |
| 信封格式（怎么打包）   | 契约包的 `envelope.js`（`fang-master` 协议 v1）              |
| 版本协商（能不能听）   | `contract.hello` + `negotiate()`（MAJOR 兼容、MINOR 取交集） |
| 传输（走哪条路）       | `transports.js`：local → http → file → legacy 四级降级       |

## 2. 版本与兼容承诺

| 变更类型                     | 版本位 | 规则                                                                                    |
| ---------------------------- | ------ | --------------------------------------------------------------------------------------- |
| 新增方法/能力/字段           | MINOR  | 旧客户端忽略未知字段；新方法不在旧端方法集内就自动降级                                  |
| 修 bug、无行为变化           | PATCH  | 两侧可独立升级                                                                          |
| 删除方法、改语义、改信封结构 | MAJOR  | 保留上一 MAJOR 方法 ≥ 1 个 MINOR 周期（双写 `method@old` / `method@new`），提供迁移说明 |

`hello` 返回 `protocol / contractVersion / role / instanceId / methods / capabilities / transports`；
`negotiate()` 输出 `{compatible, version, methods, capabilities, fallback}`：

- 对端 MAJOR 更高 → `remote-too-new` → 自动降级到 legacy 传输；
- 对端 MAJOR 更低 → `remote-too-old` → 自动降级；
- 同 MAJOR → 取双方方法交集 + 公共 minor 裁剪。

三个版本号互不绑定：

| 版本          | 当前值  | 管什么                          |
| ------------- | ------- | ------------------------------- |
| 插件版本      | `3.2.0` | w2m 自身的 npm/tag/Release      |
| w2m 契约版本  | `1.0.0` | `w2m.*` 方法表的语义            |
| 契约 SDK 版本 | `1.1.1` | 信封、协商、传输、`fang.*` 方法 |

## 3. 方法表

协议级（SDK 提供）：

| 方法                                                 | 用途                | 契约版本  |
| ---------------------------------------------------- | ------------------- | --------- |
| `contract.hello`                                     | 版本/角色/能力协商  | 1.0       |
| `contract.health`                                    | 健康检查            | 1.0       |
| `fang.*`（fork/decision/session/orchestrator/relay） | 瓮城 ↔ 房主既有能力 | 1.0 / 1.1 |

w2m 自己的命名空间（本仓库 `src/interop/index.mjs`，不占用也不改 `fang.*` 语义）：

| 方法                 | 用途                                               | 契约版本 |
| -------------------- | -------------------------------------------------- | -------- |
| `w2m.status`         | w2m 自身状态（插件/契约/SDK 版本、方法集、uptime） | 1.0      |
| `w2m.methods`        | w2m 方法表自描述                                   | 1.0      |
| `w2m.fleet.snapshot` | 舰队快照（provider 注入）                          | 1.0      |
| `w2m.devices.list`   | 设备列表（provider 注入）                          | 1.0      |
| `w2m.tasks.list`     | 任务列表（provider 注入）                          | 1.0      |

**不伪造数据**：没有注入 provider 的方法返回 `handler-threw`，消息里带 `w2m-service-absent`，
而不是返回空数组冒充成功。

## 4. 传输层与兜底顺序

| 优先级 | 传输       | 场景                                            | 失败后   |
| ------ | ---------- | ----------------------------------------------- | -------- |
| 1      | **local**  | 同一个 Host 的 DSH 服务（零网络）               | → http   |
| 2      | **http**   | 对端 HTTP 契约端点（Bearer token）              | → file   |
| 3      | **file**   | 同一文件系统 outbox/inbox（HTTP 被挡/重启窗口） | → legacy |
| 4      | **legacy** | 直接调用 3.1.x 旧服务键（`fangForker` 等）      | 明确失败 |

- 传输超时 / HTTP 非 2xx / 不可用 → 自动下一层；
- **业务错误不降级**（例如 `ticket-invalid`），避免重复副作用；
- `unsupported-method` / `unsupported-version` / `retryable` → 下一层；
- 每次尝试记录在 `router.attempts()`，状态可观测。

### w2m 作为服务端

- local：提供 `w2mContract` 服务；同宿主对端（fang/master 的 local 传输）默认找 `fangContract`，
  本插件在该名字**缺席时补位**、已存在时**不覆盖**（不与瓮城抢服务键）。
- http：`POST /api/w2m/contract/invoke`、`GET /api/w2m/contract/hello`、
  `GET /api/w2m/contract/health`。w2m 不占用 fang 的 `/fang/api/contract/*`。
- file：配置 `fileDir` 时挂 SDK 的 file 契约服务端。

### w2m 作为客户端

`createW2mContractClient({ctx, config})` 直接复用 SDK 路由，可调用任意一方的方法；
`config` 支持 `httpBaseUrl` / `httpToken` / `pathPrefix` / `fileDir` / `order` / `timeoutMs`。

## 5. 演进操作手册

**新增一个 w2m 方法（MINOR，不需要双方同时升级）：**

1. 在 `W2M_METHODS` 加常量、在 `W2M_METHOD_VERSION` 标版本、在 `createW2mContractServer` 的
   `handlers` 里实现；
2. 更新本文与方法表测试；
3. 升插件 MINOR；契约版本按需 `1.0` → `1.1`（方法表新增属于契约 MINOR）。

**改一个方法的语义（MAJOR）：**

1. 升 `W2M_CONTRACT_VERSION` 的 MAJOR；
2. 同时保留 `w2m.foo`（旧语义）与 `w2m.foo@2`（新语义）至少一个 MINOR 周期；
3. 两侧逐步升级依赖后删除旧方法。

**升级契约 SDK：**

1. `npm pack @twinsearth/dsh-fang-contract@<版本>`；
2. 覆盖 `src/interop/contract/`；
3. 重新生成 `PROVENANCE.md`；
4. `npm run verify:contract`（逐字节校验，pre-flight 之外也有测试覆盖）。

## 6. 文件地图

| 文件                                 | 作用                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| `src/interop/index.mjs`              | w2m 方法表、服务端/客户端工厂、HTTP 路由、`apply`      |
| `src/interop/contract/`              | 契约 SDK 1.1.1 逐字节副本（含 LICENSE、PROVENANCE.md） |
| `src/interop/contract/PROVENANCE.md` | 来源、版本、每文件字节数与 sha256                      |
| `scripts/check-contract-vendor.mjs`  | 副本完整性校验                                         |
| `lib/contract.js`                    | 子插件入口（`@twinsearth/w2m-dsh-plugin/contract`）    |
| `test/contract-interop.test.mjs`     | 方法表/信封/路由/四级降级/副本一致性测试               |
| `cordis.patch.yml`                   | `dsh-w2m-contract` 行（默认启用）                      |
