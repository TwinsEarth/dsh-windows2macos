# 远程桌面默认走 P2P WebRTC：生产化开发计划

状态：计划稿，待评审后实施  
目标版本：3.7.0（或下一个未占用 minor）  
适用范围：`@twinsearth/w2m-dsh-plugin/dsh-p2p-webrtc`、`@twinsearth/w2m-dsh-plugin/desktop`、共享 `WebRtcTransportPool`

## 1. 目标

把远程桌面从“代码里写了 `webrtc` 优先、实际却依赖手工配置和 root 池”改成一条可部署、可验证、可回滚的生产默认路径：

```text
viewer POST /api/w2m/remote/start
  -> 解析共享 WebRTC pool（进程级单例）
  -> pool.ensure(target)
  -> Noise-sealed DataChannel 上完成 view.hello / hello_ack / request / frame
  -> transport=webrtc 时，失败即 502，不静默回落
  -> transport=auto 时，只在明确条件下回落 relay，并返回可读原因
```

验收口径不是“测试里能走 WebRTC”，而是：

1. 生产 profile 启动后 `pool.ready=true`，不需要先手工调用 `p2p_webrtc_start`。
2. `/start` 的默认结果为 `channel:"webrtc"`，`view.frame` 期间 relay 的 `/v1/remote/frame` 调用数为 0。
3. 目标端在 `view.hello` 之前完成 `prepare(viewer)` 并回 ack，且不启动 relay 帧流。
4. 进程内只有一个 `WebRtcTransportPool`；重复挂载、root 与子插件同时启用都不会创建第二个池。
5. `/stop` 只退订桌面 listener、发送 `view.stop`，不调用 `closePeer()`。

## 2. 现状与真实差距

| 现状 | 位置 | 对生产默认路径的影响 |
|---|---|---|
| `dsh-desktop` 行默认 `disabled: true` | `cordis.patch.yml:130` | 默认安装不会挂载远程桌面路由 |
| `dsh-p2p-webrtc` 行默认禁用、`signalUrl`/`providerCommand` 为空、`autoStart:false` | `cordis.patch.yml:261-292` | P2P 子插件不会自动提供共享 pool |
| 共享 pool 只由 root `w2m` 的 `startLocalStack` 构建并注册 | `src/plugin/tools/shared.mjs:2694-2722` | 只有 root 配置 `webrtc` 可构建时才存在；子插件启用也不会创建 |
| P2P 子插件只创建单条 `createWebRtcTransport`，不注册 `setSharedWebRtcPool` | `src/plugin/p2p-webrtc-plugin.mjs:259` | 它的“传输层”目前不是桌面所消费的 pool |
| `desktop.apply` 已传 `getSharedWebRtcPool`，路由也会晚绑定 | `src/plugin/desktop.mjs:85`、`remote-view-route.mjs:112` | 桌面侧接线正确，但上游没有稳定 pool |
| 目标端 `prepareWebRtc` 固定捕获 `deps.webrtcPool` | `src/agent/lifecycle/heartbeat.mjs:828` | pool 晚到或由子插件创建时，目标端仍返回 `WEBRTC_POOL_UNAVAILABLE` |
| `deliver`/dispatch 固定捕获 `options.webrtcPool` | `src/agent/lifecycle/deliver.mjs:133` | 共享 pool 晚到时，任务数据面不会自动切到 WebRTC |
| `transport` 缺省 `auto`，且 auto 还会尝试旧 UDP `p2p.node.dial` | `remote-view-route.mjs:48`、`:590` | “默认 WebRTC”可能被旧 UDP 路径掩盖，诊断不清晰 |
| 生产部署没有一条从 provider 安装到 profile 配置的完整路径 | `docs/P2P-WEBRTC.md` 的 provider 段落 | 代码完成不等于现场可用 |

结论：桌面路由本身已具备 WebRTC 能力；缺的是 **pool 的单一所有权、启动时序、全消费者晚绑定、生产 profile 和验收门禁**。

## 3. 架构裁决

### 3.1 一个进程，一个 pool，一个 owner

新增 `src/plugin/p2p-webrtc/pool-runtime.mjs`，把 pool 的构建、注册、状态、停止收拢为一个运行时：

```js
ensureWebRtcPoolRuntime(config, deps)
  -> { ok, pool, reused, owner, code, detail }
getWebRtcPoolRuntime()
  -> { pool, owner, ready, status() }
```

规则：

1. `dsh-p2p-webrtc` 行启用且 `autoStart:true` 时，由它调用 `ensure()`，成为 owner。
2. root `w2m` 的 `startLocalStack` 改为 `acquire`：已有 pool 直接采用，没有才构建。
3. `webrtc-pool-registry.mjs` 仍是进程级注册表，但增加 `owner` 和 `subscribe()`，不再允许两个调用方各自 `createWebRtcTransportPool`。
4. `desktop`、`teams`、`p2p-v2`、`deliver`、`heartbeat` 只通过 registry 取池，不拥有池。
5. `pool.stop()` 只能由 owner 调用；桌面 `/stop` 不调用 `closePeer()`，只退订并发送 `view.stop`。

### 3.2 消费者晚绑定

把“创建时捕获 pool”改成“使用时解析 pool”：

- `deliver.mjs` 增加 `getWebRtcPool` 选项，保留 `webrtcPool` 兼容测试；所有发送和订阅在使用时取当前 pool。
- `heartbeat.mjs` 的 `prepareWebRtc` 每次调用 `getSharedWebRtcPool()`，再回退到 `deps.webrtcPool`。
- `tools/shared.mjs` 在创建 agent 时传 getter，而不是只传当时的 `inProcessWebRtcPool`。
- 这样 root 先挂载、P2P 行后启动、Desktop 最晚挂载都不会锁死在 relay。

### 3.3 桌面传输策略

保留三态，但把语义收紧：

| 配置 | 行为 | 用途 |
|---|---|---|
| `webrtc`（生产默认） | 只走共享 pool；失败返回 502，不建 relay 会话 | 生产 fleet，必须直连 |
| `auto` | 先 WebRTC；失败后仅按显式开关允许旧 UDP/relay | 兼容、排障、弱网 |
| `relay` | 强制旧加密 relay | 紧急回滚、旧 relay 兼容 |

新增桌面行配置：

```yaml
- id: dsh-desktop
  disabled: false
  config:
    transport: webrtc        # 生产 profile；包默认仍可为 auto
    allowLegacyP2P: false     # 不再让旧 UDP 掩盖 WebRTC 失败
    prepareTimeoutMs: 8000
    handshakeTimeoutMs: 10000
```

`remote-view.json` 仍可运行时覆盖，但行配置作为文件缺失时的默认值；两者来源要在 `/config` 和 `/start` 响应中写清楚。

## 4. 实施切片

### P0：基线与开关冻结（0.5 天）

- 在 `E:\DB\W2M` 创建独立工作分支，先提交或 stash 当前 3.6.0/V2 未提交改动，避免计划实施与 V2 改动混在一起。
- 记录当前基线：`test:p2p-webrtc`、`test:remote-view`、`test:teams`、`test:p2p-v2` 的真实通过数。
- 冻结命名：`WEBRTC_POOL_OWNER_CONFLICT`、`WEBRTC_POOL_NOT_READY`、`WEBRTC_POOL_NOT_OWNED`、`DESKTOP_LEGACY_P2P_DISABLED`。

### P1：共享 pool 运行时（1.5 天）

状态：已落地（2026-11-23），验收见 `docs/acceptance/3.6.0/P1-POOL-RUNTIME.md`。owner 冲突码实际采用 `WEBRTC_POOL_OWNER_CONFLICT`，非 owner teardown 采用 `WEBRTC_POOL_NOT_OWNER`。

新增/修改：

- `src/plugin/p2p-webrtc/pool-runtime.mjs`
  - 读取 `device.json` 的 `machine_id`、`rabbit_url`、`device_token`；
  - 读取 `device.key`，构造 `createRelayPeerKeyResolver`；
  - 归一化 `signalUrl`、`signalToken`、`providerCommand/Args/Cwd`、`iceServers`；
  - `ensure()` 幂等、并发共享同一个 inflight；
  - 返回命名失败，不吞异常。
- `src/plugin/webrtc-pool-registry.mjs`
  - `setSharedWebRtcPool(pool, {owner})`；
  - `getSharedWebRtcPool()`；
  - `subscribe(listener)` / `notify()`；
  - `owner` 不一致时拒绝覆盖，返回 `WEBRTC_POOL_OWNER_CONFLICT`。
- `src/plugin/tools/shared.mjs`
  - `startLocalStack` 改调用 `acquireSharedWebRtcPool`；
  - 已有 pool 时不重复 build，只记录 `reused:true`；
  - 保留 `inProcessWebRtcPool` 兼容导出。
- 测试：`test/p2p-webrtc-pool-runtime.test.mjs`
  - 两次 ensure 只 build 一次；
  - owner 冲突；
  - build 失败不缓存成功；
  - stop 只停 owner 的 pool；
  - root 先建、子插件后到，复用。

### P2：P2P 子插件成为 pool 提供者（1.5 天）

> 状态：已落地（2026-11-23）。`dsh-p2p-webrtc` 在 `mode: 'pool'` 下成为共享 pool 的
> owner；root `w2m` 改为只从 registry acquire，不再构建、也不再在 teardown 停止 pool。
> `p2p_webrtc_stop` 默认只 `closePeer`，整池停止必须 `confirm:"pool-stop"`。
> 验收记录：`docs/acceptance/3.6.0/P2-POOL-PROVIDER.md`。

修改 `src/plugin/p2p-webrtc-plugin.mjs`：

- `apply()` 在 `autoStart:true` 时 `await runtime.ensure()`，失败只记录命名原因，不阻塞 mount。
- `P2PWebRtcService` 保留成单 pair 兼容面，但 pool 模式下：
  - `status()` 增加 `pool: {ready, owner, machine_id, peers, diagnostics}`；
  - `p2p_webrtc_start` 先 ensure pool，再按 `peerMachineId` 调 `pool.ensure(peer)`；
  - `p2p_webrtc_stop` 只 `closePeer(peer)`，没有 peer 时拒绝停整个 pool，除非 `confirm:"pool-stop"`；
  - `p2p_webrtc_probe` 通过 `pool.peerStatus(peer)` 找到 transport 后 probe。
- `cordis.patch.yml`：
  - 包默认保持 `disabled: true`（安装即启会因 provider 缺失产生噪声）；
  - 新增生产 profile 示例：`dsh-p2p-webrtc` enabled、`autoStart:true`、`signalUrl`、`providerCommand`；
  - `dsh-desktop` 在生产 profile enabled、`transport:webrtc`。
- 测试：`test/p2p-webrtc-plugin.test.mjs` 增补 pool 模式、owner 冲突、stop 不拆桌面/Teams。
- `src/plugin/tools/shared.mjs`：root 不再 `createWebRtcPoolRuntime`；它只 `getSharedWebRtcPool()`，
  并把“尚未发布”记录为 `WEBRTC_POOL_UNAVAILABLE`，等待 P3 晚绑定。root teardown 不再 `pool.stop()`，
  因为 pool 的生命周期属于 `dsh-p2p-webrtc`。

### P3：目标端与任务面晚绑定（1 天）

> 状态：已落地（2026-11-23）。`heartbeat` 的 viewer warm-up 每次请求重读 pool getter；
> `deliver` 在每次调度/发送/状态读取时 `ensureWebRtcPool()`，pool 晚到后自动订阅；
> `tools/shared` 把 `getSharedWebRtcPool` / `getSharedWebRtcPoolState` 注入 `createAgent`。
> 由于 `agent` 层不能 import `plugin` 层，getter 由 composition root 注入，registry 仍是唯一
> owner 来源。验收记录：`docs/acceptance/3.6.0/P3-LATE-BINDING.md`。

修改：

- `src/agent/lifecycle/heartbeat.mjs`
  - `prepareWebRtc` 每次通过注入的 `getWebRtcPool` 重读共享 pool；
  - 取不到时再回退 `deps.webrtcPool`；
  - 返回 `pool_owner` 供 ack 诊断。
- `src/agent/view/relay-target.mjs`
  - `/v1/remote/ack` body 与 warm-up 日志增加 `pool_owner`，空值为 `null`。
- `src/agent/lifecycle/deliver.mjs`
  - 增加 `getWebRtcPool`；
  - `handleWebRtcFrame` 订阅与 `send` 使用当前 pool；
  - pool 从 null 变为可用时，下一次操作自动订阅，不需要重启 agent。
- `src/plugin/tools/shared.mjs`
  - `createAgent` 传 `getWebRtcPool: getSharedWebRtcPool`。
- `src/plugin/tools/dispatch.mjs`
  - 每次 dispatch 用 `getSharedWebRtcPool() ?? inProcessWebRtcPool`，不再只读 mount 时快照。
- 测试：
  - pool 在 deliver 创建后出现，offer 仍走 WebRTC；
  - pool 晚到后 `prepareWebRtc` 成功；
  - pool 不在时返回 `WEBRTC_POOL_UNAVAILABLE`，不抛未命名异常。

### P4：桌面生产默认与回落收紧（1 天）

> 状态：已落地（2026-11-24）。`dsh-desktop` 行可配置 `transport` / `allowLegacyP2P` /
> `prepareTimeoutMs` / `handshakeTimeoutMs`，`remote-view.json` 存在时覆盖行默认；`auto` 仅在
> `allowLegacyP2P:true` 时尝试旧 UDP，否则固定 WebRTC -> relay；`/start` 五个固定字段与
> `/config` 四个运行态字段均已落地。验收记录：`docs/acceptance/3.6.0/P4-DESKTOP-ROW-CONFIG.md`。

修改 `src/plugin/desktop.mjs` / `src/plugin/remote-view-route.mjs`：

- `registerDesktop(ctx, deps)` 接受 `transport`、`allowLegacyP2P`、`prepareTimeoutMs`、`handshakeTimeoutMs`。
- `readConfig(file, defaults)`：文件不存在时用行配置；文件存在时文件优先。
- `connectWebrtc` 返回值增加：
  - `pool_owner`
  - `pool_machine_id`
  - `prepare_ms`
  - `ack_code`
- `/start` 响应固定字段：
  - `channel`
  - `preferred`
  - `fallback_reason`
  - `webrtc`
  - `relay_used`（WebRTC 模式必须为 false）
- 删除 `auto` 对旧 UDP 的隐式优先权：
  - 只有 `allowLegacyP2P:true` 才尝试 `connectP2P`；
  - 否则 `auto` 的回落顺序固定为 WebRTC -> relay。
- `/config` 增加运行态：
  - `pool_available`
  - `pool_owner`
  - `transport_source`（row/json/default）
  - `legacy_p2p`
- 不改变 `view.*` 帧格式、consent 检查和输入拒绝边界。

### P5：可观测性与客户端标签（0.5 天）

- `lib/client.js` 的通道标签固定为 `WebRTC` / `加密 relay`，不再出现含糊的 `P2P`。
- 远程桌面面板显示：
  - 当前通道
  - 是否直连
  - 失败原因（只在失败时）
  - `pool_available` 为 false 时显示“WebRTC 未就绪”，而不是让用户点击后才报错。
- 新增只读诊断路由 `GET /api/w2m/remote/diagnostics`（需要现有连接鉴权）：
  - 不输出 token、私钥、完整 signaling URL；
  - 输出 pool owner、peer state、last_error、ack 次数、relay 帧计数。

### P6：部署与 provider 安装（1 天）

- `docs/DESKTOP-PRODUCTION.md`：
  - relay 侧部署 `w2m-webrtc-signal`；
  - 每台机器安装 `node-datachannel` 到 `~/.w2m/webrtc-provider`；
  - 配置 `providerCommand:'node'`、`providerArgs`、`providerCwd`；
  - 配置 `signalUrl`、`signalToken`、`deviceKeyDir`；
  - 验证 `/v1/peer/<machine_id>` 返回 `static_key`；
  - 验证 `remote-view.json` 的 `transport`。
- 新增 `scripts/desktop-webrtc-readiness.mjs`：
  - 只读检查 pool、signal、provider、device key、peer static key、relay ack 路由；
  - 输出每一项 `ok/code/detail`，不打印密钥。
- 安装/升级脚本不自动安装 `node-datachannel`，保持零运行时依赖；只提示命令。

### P7：测试矩阵（1.5 天）

| 层 | 用例 | 必须证明 |
|---|---|---|
| 单元 | pool runtime 幂等/owner 冲突 | 不能出现第二个 pool |
| 单元 | desktop 三态与默认值 | `webrtc` 不回落，`auto` 原因可读 |
| 单元 | 旧 UDP 开关 | `allowLegacyP2P:false` 时绝不 dial |
| 集成 | fake pool happy path | `/start=webrtc`，frame 不进 relay |
| 集成 | 目标端 ack=false | 快速回落，不挂 8s |
| 集成 | pool 晚到 | 不需要重启 desktop/deliver/heartbeat |
| 集成 | stop 不 closePeer | Teams/任务数据面仍可用 |
| 真实引擎 | node-datachannel 双端 | 真实 ICE/DTLS/Noise + view frame |
| 跨机 | 4 节点有向矩阵 | 每台机器都能当 viewer/target |
| 故障 | provider 缺失、signal 断、ack 超时 | 命名错误，不静默 |
| 安全 | ack 越权读取、冒充 machine id | 401/403/拒绝 |
| 长稳 | 30 分钟 1 Hz 帧 | 内存、句柄、pool 不泄漏 |
| 回归 | `test:p2p-webrtc`、`test:teams`、`test:p2p-v2` | 既有数据面不被拆 |

验收记录新增 `docs/acceptance/3.7.0/DESKTOP-WEBRTC-DEFAULT.json`，必须包含：
`relay_frame_calls=0`、`pool_count=1`、`channel=webrtc`、`fallback_reason=null`。

## 5. 发布与回滚

### 发布顺序

1. 先发布 relay 侧 `/v1/remote/ack`（向后兼容，旧客户端不调用）。
2. 再发布插件版本；p2p 行与 desktop 行仍可独立开关。
3. 最后切换生产 profile：`desktop.transport=webrtc`、`p2p autoStart=true`。
4. 观察 24 小时：`webrtc_start_success`、`prepare_timeout`、`relay_frame_calls`。

### 回滚

- 单机：`remote-view.json.transport=relay`，不重启进程即可生效。
- 整车：生产 profile 恢复 `transport:auto` 或 `relay`，保留 p2p pool 不影响任务/Teams。
- 代码回滚：desktop 行回退到 3.6.0 实现；共享 pool runtime 保留但可 `autoStart:false`。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| root 与 P2P 行各建一个 pool，signal role 冲突 | registry owner + `acquire`，冲突命名拒绝 |
| agent 创建早于 pool，heartbeat 固定 null | 全部消费者改 getter；新增晚绑定测试 |
| 生产 strict WebRTC 在 NAT 严格环境不可用 | `transport=webrtc` 只用于生产 profile；`auto` 保留显式 relay 回滚 |
| 旧 relay 没有 ack 路由 | 404 识别为 `WEBRTC_ACK_UNAVAILABLE`，auto 快速回落 |
| 桌面 `/stop` 拆掉 Teams | 禁止 `closePeer`，只退订 + `view.stop` |
| provider 未安装导致“默认路径”假成功 | readiness 脚本 + `pool.ready=false` 面板提示 |
| 行配置与 `remote-view.json` 优先级混乱 | `/config` 返回 `transport_source`，文档固定“文件优先” |
| 现有 3.6.0/V2 未提交改动混入 | P0 先隔离分支，按切片提交 |

## 7. 交付物清单

- `src/plugin/p2p-webrtc/pool-runtime.mjs`（新）
- `src/plugin/webrtc-pool-registry.mjs`（扩展）
- `src/plugin/p2p-webrtc-plugin.mjs`（pool 模式）
- `src/plugin/tools/shared.mjs`（acquire + getter）
- `src/agent/lifecycle/heartbeat.mjs`（晚绑定）
- `src/agent/lifecycle/deliver.mjs`（晚绑定）
- `src/plugin/desktop.mjs` / `src/plugin/remote-view-route.mjs`（生产默认）
- `cordis.patch.yml`（生产 profile 示例，默认仍 disabled）
- `lib/client.js`（通道标签）
- `scripts/desktop-webrtc-readiness.mjs`（新）
- `docs/DESKTOP-PRODUCTION.md`（新）
- `docs/acceptance/3.7.0/DESKTOP-WEBRTC-DEFAULT.json`（新）
- 测试：`test/p2p-webrtc-pool-runtime.test.mjs`、`test/remote-view-route.test.mjs` 增补、`test/p2p-webrtc-plugin.test.mjs` 增补、跨机/真实引擎验收脚本

## 8. 建议排期

- P0 基线：0.5 天
- P1 pool runtime：1.5 天
- P2 P2P 行：1.5 天
- P3 晚绑定：1 天
- P4 桌面默认：1 天
- P5 可观测性：0.5 天
- P6 部署文档：1 天
- P7 测试/验收：1.5 天

合计约 8.5 人日；不含跨机真实网络矩阵排队时间和 provider 现场安装。

## 9. Definition of Done

- 生产 profile 下 `/start` 默认 `channel=webrtc`，`/frame` 期间 `relay_frame_calls=0`。
- `transport=webrtc` 失败返回 502，不建 relay 会话，不静默回落。
- `transport=auto` 只在 `allowLegacyP2P` 或显式 relay 回滚时走旧路径，原因写入响应。
- 进程内 `pool_count=1`，`p2p_webrtc_start` 与 root 同时启用不冲突。
- 目标端 `prepare` 成功回 ack，失败回命名 code；旧 relay 404 快速回落。
- `/stop` 后同 peer 的 Teams/任务数据面仍可用。
- 30 分钟 soak 无句柄/内存增长；跨机四节点有向矩阵全绿。
- 文档、验收 JSON、回滚开关齐备，未执行发布动作前只报告“发布准备完毕”。
