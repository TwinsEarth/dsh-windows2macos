# 远程桌面默认走 WebRTC：设计与实施契约

状态：设计冻结，按本文件实现
适用范围：`@twinsearth/w2m-dsh-plugin/desktop` + `@twinsearth/w2m-dsh-plugin/dsh-p2p-webrtc` 的共享传输层
版本目标：3.6.0

## 1. 裁决

远程桌面的**生产默认路径**改为：

```text
viewer /start
  -> 共享 WebRtcTransportPool.ensure(target)
  -> Noise-sealed DataChannel 上跑 view.hello / view.hello_ack / view.request / view.frame
  -> 失败且 transport=auto 时，才允许走原有加密 relay 盲转发
```

`transport` 配置三态：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 先 WebRTC；失败带原因回落 relay |
| `webrtc` | 只走 WebRTC；失败返回 502，不回落 |
| `relay` | 显式选择旧 relay 路径，用于排障与兼容 |

关键约束：

1. 媒体帧（`view.frame`）在 WebRTC 模式下**绝不经过 relay**。
2. 目标端已有的 `view.*` 路由不需要重写：`deliver.mjs` 已经订阅共享 pool，并把 WebRTC 帧喂给 `heartbeat.handleP2PMessage`；`heartbeat` 已把 `view.*` 交给 `createViewTarget`。缺的是“ viewer 侧发起”和“冷启动时目标端把 pool 配对拉起来”。
3. 桌面子插件**不拥有 pool**。它只借用 `getSharedWebRtcPool()`；会话结束时只退订、发 `view.stop`，**不关闭 peer**，否则会把同 peer 上的 Teams/任务数据面一起拆掉。
4. 失败必须命名。`/start` 响应携带 `channel`、`preferred`、`fallback_reason`、`webrtc` 诊断；不允许把 WebRTC 失败伪装成成功。

## 2. 现状证据

| 事实 | 位置 |
|---|---|
| desktop 行当前把 `p2p` 传成 `null`，只剩 relay 兜底 | `src/plugin/desktop.mjs:77` |
| viewer 侧仍用旧 UDP `p2p.node.dial`，失败后直接 `postRelayRequest` | `src/plugin/remote-view-route.mjs:137-175` |
| 共享 pool 的 `send()` 内部 `ensure()`，并按 peer 复用 transport | `src/agent/webrtc/pool.mjs:343-398` |
| pool 的推送面是全局 `onMessage(handler)`，事件带 `peer` | `src/agent/webrtc/pool.mjs:409-413` |
| agent 已订阅 pool，并把帧转给 `handleP2PMessage` | `src/agent/lifecycle/deliver.mjs:1317-1361` |
| `heartbeat` 已把 `view.*` 交给 `createViewTarget` | `src/agent/lifecycle/heartbeat.mjs:478-493` |
| 目标端 relay 轮询只认 `viewer_public_key`，不知道 viewer 的 machine id / 传输选择 | `src/agent/view/relay-target.mjs:87-97` |
| relay 请求邮箱只存 `session_id/target/viewer_public_key` | `src/relay/remote-requests.mjs:28-42` |
| relay 的 `/v1/remote/request` 只有 POST/GET 两个动作 | `src/relay/server.mjs:1751-1773` |

结论：**viewer 侧没有接 pool，且冷启动时目标端没有为这个 pair 启动 transport**。这两件事必须一起解决，否则“默认 WebRTC”只是把失败提前。

## 3. 采用合同

### 3.1 发起链路

`POST /api/w2m/remote/start {machine_id}`：

1. 校验 `remote-view.json.enabled=true`。
2. 读取 `transport`（缺省 `auto`）。
3. `transport=relay`：直接走旧路径。
4. `auto|webrtc`：
   1. 读本机 `device.json.machine_id` 与 relay base/token。
   2. 申请 `view-...` 会话，生成 viewer 临时 X25519 侧。
   3. 向 relay `POST /v1/remote/request` 发**准备请求**：
      `{session_id,target,viewer_public_key,viewer_machine_id,transport:'webrtc'}`。
   4. **立即**启动 `pool.ensure(target)`（与目标端 `prepare(viewer)` 并发加入同一 signaling room），
      然后轮询 `GET /v1/remote/ack?session_id&target`，最多 `prepareTimeoutMs`（默认 8 s）。
      顺序不能反：先等 ack 再 `ensure` 会让两端互相等待对方入房而死锁。
   5. ack `ok:true` 且 `ensure` 成功：订阅 pool、发 `view.hello`，返回
      `channel:'webrtc'`、`preferred:'webrtc'`、`fallback_reason:null`。
   6. ack `ok:false` / 超时 / `ensure` 失败：
      - `transport=webrtc`：返回 502 `WEBRTC_UNAVAILABLE`，带 `webrtc`/`ack` 诊断，不建 relay 会话。
      - `transport=auto`：重新 `POST /v1/remote/request`，带 `transport:'relay'`，走旧 relay 会话；响应
        `channel:'relay'`、`fallback_reason:<命名原因>`。

### 3.2 目标端准备链路

`relay-target` 的 1 s 轮询拿到请求后：

- `transport==='relay'` 或没有 `viewer_machine_id`：保持旧行为，直接起 relay 帧流。
- `transport==='webrtc'`：
  1. `prepareWebRtc(viewer_machine_id)`，内部调用 `deps.webrtcPool.prepare(viewerId)`；
  2. 向 relay `POST /v1/remote/ack` 回
     `{session_id,target,viewer_machine_id,ok,code}`；
  3. **不启动 relay 帧流**，等待 viewer 在 DataChannel 上发 `view.hello`。
- 没有 pool / prepare 失败：ack `ok:false`，code `WEBRTC_POOL_UNAVAILABLE` 或池返回的命名错误。

目标端 `view.hello` 的处理沿用现有 `createViewTarget`；其 `send` 走 `deliver` 创建的 WebRTC channel adapter，最终 `pool.send(viewerId, frame)`。

### 3.3 viewer 收帧

- 每个活动会话注册一个 `pool.onMessage` 订阅；只接受 `event.peer === target` 且
  `frame.session_id === active.sessionId` 的帧。
- `view.hello_ack`：派生 VK，随后 `view.request`。
- `view.frame`：AES-256-GCM 解密，超过 `maxBytes` 记 `VIEW_FRAME_TOO_LARGE`。
- `view.error`：映射为 `code`。
- 1 Hz `/frame` 轮询：每 10 s 重发一次 `view.request` 续预算；发送失败记
  `VIEW_WEBRTC_SEND_FAILED`。
- 握手超过 `handshakeTimeoutMs`（默认 10 s）仍无 `hello_ack`：`VIEW_WEBRTC_HANDSHAKE_TIMEOUT`。

### 3.4 停止

`/stop`：

1. WebRTC 模式：`pool.send(target, {type:'view.stop',session_id})`（best effort）。
2. 退订 `onMessage`。
3. **不调用 `pool.closePeer(target)`**。
4. relay 模式：保持旧 `view.stop` + relay 侧自然过期。

### 3.5 relay ack 邮箱

扩展现有 `createRemoteRequestBroker`：

- `post()` 保留可选 `viewer_machine_id`（非空字符串）与 `transport`（`webrtc|relay`，缺省 `relay`）。
- 新增 `ack(body)`：`session_id/target/viewer_machine_id/ok/code`，TTL 10 s，按 `target + session_id` 存。
- 新增 `takeAck(target, sessionId)`：只允许对应 `viewer_machine_id` 读（HTTP 层用设备身份校验）。
- 旧请求不带新字段时行为不变。

HTTP：

- `POST /v1/remote/ack`：只允许 `target === device.machine_id`。
- `GET /v1/remote/ack?session_id&target`：只允许 `viewer_machine_id === device.machine_id`。
- 未知字段被忽略；老 relay 返回 404 时 viewer 视为 `ack_unavailable` 并回落。

## 4. 失败矩阵

| 条件 | auto | webrtc |
|---|---|---|
| 本机没有共享 pool | relay，`fallback_reason=WEBRTC_POOL_UNAVAILABLE` | 502 同码 |
| 本机没有共享 pool，但 root 兼容行注入了旧 UDP p2p | 旧 p2p（仅 root 兼容面；`desktop` 行 `p2p:null` 不会走这条），`fallback_reason=WEBRTC_POOL_UNAVAILABLE` | 502 同码 |
| relay 无 ack 路由 | relay，`fallback_reason=WEBRTC_ACK_UNAVAILABLE` | 502 同码 |
| 目标端 prepare 失败 | relay，带目标端 code | 502，带 code |
| ack 超时 | relay，`WEBRTC_PREPARE_TIMEOUT` | 502 同码 |
| `pool.ensure` 失败 | relay，带 pool code | 502，带 code |
| DataChannel 中途断 | `/frame` 502 `VIEW_WEBRTC_SEND_FAILED` / `VIEW_WEBRTC_NOT_READY`；不自动切 relay | 同左 |
| 目标端拒绝 consent | `VIEW_CONSENT_REQUIRED` | 同左 |

中途不自动切 relay：切换会换会话密钥和帧流，静默切换会让用户以为仍在直连。要换路径由用户重新 `/start`，响应会明确写 `channel`。

## 5. 生命周期与并发

- 一个 desktop 行只有一个 `active` 会话；新 `/start` 先 `stopActive()`。
- `pool.onMessage` 订阅按会话创建、按停止/替换退订；重复 start 不漏订阅。
- `pool.send` 的 `ensure` 是幂等的；并发 start 共享同一个 inflight。
- 目标端 `prepare` 是幂等的；重复请求不会创建第二个 transport。
- 目标端 `createViewTarget` 仍按 `session_id` 保存；新 hello 重置旧会话。
- viewer 进程崩溃：目标端 `viewTarget` 的帧预算自然过期；pool transport 保留给其他数据面。
- 目标端重启：viewer `/frame` 得到命名错误；重新 `/start` 重建。

## 6. 兼容与回滚

- `transport` 缺省 `auto`；旧 `remote-view.json` 只有 `enabled` 时按 `auto`。
- 旧 relay 没有 ack 路由：`auto` 回落 relay，功能不退化。
- 旧目标端不识别 `transport`：仍按 relay 起流；viewer 的 WebRTC ack 超时后回落。
- 回滚：把 `remote-view.json.transport` 设为 `relay`，或回退 `remote-view-route.mjs`；relay 路径始终保留。
- 不改变 `view.*` 的加密格式、consent 检查和输入拒绝边界。

## 7. 实施切片

1. `src/relay/remote-requests.mjs`：请求字段扩展 + ack 邮箱。
2. `src/relay/server.mjs`：`/v1/remote/ack` POST/GET。
3. `src/agent/view/relay-target.mjs`：webrtc 准备请求、ack 回写、跳过 relay 流。
4. `src/agent/lifecycle/heartbeat.mjs`：把 `deps.webrtcPool` 包成 `prepareWebRtc` 传入。
5. `src/plugin/remote-view-route.mjs`：pool 优先、ack 等待、webrtc 会话收发、三态配置。
6. `src/plugin/desktop.mjs`：传 `getPool: getSharedWebRtcPool`。
7. `lib/client.js`：通道标签显示 `WebRTC` / `P2P` / `加密中继`。
8. 测试：`remote-view-route`、`relay-target`、`remote-requests`；必要时补 relay 路由测试。
9. 版本与 CHANGELOG：3.6.0。

## 8. 测试要推翻的错误机制

| 测试 | 推翻的错误 |
|---|---|
| WebRTC happy path | 默认路径仍偷偷走 relay；或 pool 只用于发送、收不到 ack |
| 停止不关 peer | 桌面停流把同 peer 的 Teams transport 拆掉 |
| ack=false → relay | 目标端 prepare 失败却仍报告 WebRTC 成功 |
| strict → 502 | `transport=webrtc` 仍静默回落 relay |
| ack 超时 | 老 relay / 老目标端导致无限挂起 |
| 旧请求无新字段 | 兼容路径被新字段强制成 webrtc |
| 跨 peer / 跨 session 帧 | 订阅未过滤，别的 peer 的帧污染当前会话 |
| 目标端 webrtc 请求不起 relay 流 | 目标端同时跑 relay 和 WebRTC，双流/双计费 |

## 9. 落地状态（3.6.0）

已按第 7 节 1-9 全部实现：

- relay 邮箱：`post()` 原样保留 `viewer_machine_id` / `transport`；`ack()` / `takeAck()` 为一次性、10s TTL；`takeAck()` 在删除前校验 viewer machine id，非本人读取返回 `REMOTE_ACK_FORBIDDEN`。
- relay 路由：`POST /v1/remote/ack` 只接受 `target === device.machine_id`；`GET` 只允许 ack 对应的 viewer 读取；`POST /v1/remote/request` 拒绝 viewer 冒充其他 machine id。
- 目标端：`relay-target` 对 `transport:'webrtc'` 调用 `prepareWebRtc` 并回写 ack，不启动 relay 帧流；无 pool / prepare 抛错分别回 `WEBRTC_POOL_UNAVAILABLE` / `WEBRTC_PREPARE_FAILED`。
- viewer：`remote-view-route` 实现三态、共享 pool 优先、8s ack 等待、10s 握手超时、`view.*` 收发、1Hz 续期、停止只退订 + `view.stop`；relay 子请求各自带 3-5s abort 超时，ack 超时不会被一次挂起的 fetch 拖死。
- 建链顺序：viewer 发布请求后**立即**启动自己的 `pool.ensure(target)`，与目标端 `prepare(viewer)` 并发加入同一 signaling room，再等待 ack；若先等 ack 再 ensure，两端会互相等待对方入房而死锁。
- 接线：`desktop.mjs` 只在调用方显式给 `getPool` 时覆盖；root 行先挂载、pool 后到也没关系，`registerDesktop` 不传 `() => null`，`remote-view-route` 在每次 `/start` 时从进程级 registry 晚绑定共享 pool。客户端通道标签区分 `WebRTC` / `P2P` / `加密 relay`。
- 测试：`remote-view-route` 12 项（9 host + 3 target，含“先挂载、后拿到 pool”的晚绑定项）、`remote-requests` 5 项、relay 路由 2 项；9 个相关套件 193/193 通过；3.6.0 清单与 CHANGELOG 已更新；验收记录 `docs/acceptance/3.6.0/REMOTE-DESKTOP-WEBRTC.json`。
