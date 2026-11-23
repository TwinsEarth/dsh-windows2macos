# P4 验收：桌面行配置化与回落收紧

- 日期：2026-11-24
- 分支：`work/v3.6.0-desktop-v2`
- 代码基线：P3 `7a56c84` + 验收文档 `e15b67c`
- 版本：`@twinsearth/w2m-dsh-plugin@3.6.0`

## 目标

把远程桌面的传输选择从“代码里默认尝试旧 UDP”改成“行配置显式声明”。`auto` 只允许走
WebRTC -> relay；旧 P2P 必须由行显式打开，不能因为 `p2p.node` 恰好存在就被自动采用。

## 实现合同

### `desktop.mjs`

- `registerDesktop(ctx, deps)` 接受四个新字段：
  - `transport`: `auto` / `webrtc` / `relay`
  - `allowLegacyP2P`: 仅 `true` 才允许旧 UDP
  - `prepareTimeoutMs`: 正整数，覆盖路由默认 8000
  - `handshakeTimeoutMs`: 正整数，覆盖路由默认 10000
- 只有调用方真正提供某个字段时才转发，避免把 `transport: undefined` 误记为“行显式配置”，
  导致 `/config` 的 `transport_source` 从 `default` 错报成 `row`。
- `apply(ctx, config)` 从行配置读取上述字段；未提供 `transport` 时保留路由默认 `auto`。
- `getPoolState` 转发共享 registry 的 owner/ready 快照。

### `readConfig(file, defaults)`

- 文件不存在：使用行默认 `transport`，`transport_source` 为 `row` 或 `default`。
- 文件存在：文件优先，`transport_source: 'json'`。
- 文件存在但 JSON 不可解析：`ok:false`、`enabled:false`、`transport:'auto'`、
  `transport_source:'json'`、`error:'REMOTE_CONFIG_INVALID'`；不悄悄回退行默认的 transport。
- `enabled` 仍只有文件能设置，行配置不具备启用能力。

### `connectWebrtc` 返回值

新增：

- `pool_owner`：viewer 侧共享 pool 的 owner，来自 `getPoolState()?.owner`；
- `pool_machine_id`：viewer pool 的 `machineId`；
- `prepare_ms`：从进入 `connectWebrtc` 到返回的毫秒数；
- `ack_code`：目标 ack 的 `body.code`，成功且缺省时为 `WEBRTC_PREPARED`；
- `ack_pool_owner`：目标 ack 的 `body.pool_owner`，用于区分 viewer 与 target 的 pool owner。

以上字段在成功和所有失败返回路径都存在，失败路径的值为 `null`，不省略。

### `/start` 固定字段

成功、严格失败、回落成功、全部失败四个出口都带：

| 字段 | 语义 |
| --- | --- |
| `channel` | 实际通道；没有建立会话时为 `null` |
| `preferred` | 策略首选，恒为 `webrtc`；`transport:'relay'` 只是显式绕过，不改变产品首选 |
| `fallback_reason` | 发生回落时的命名原因；未回落为 `null` |
| `webrtc` | `{attempted, ok, code, detail, pool_owner, pool_machine_id, prepare_ms, ack_code, ack_pool_owner}` |
| `relay_used` | 实际使用 relay 才为 `true`；WebRTC / 旧 P2P 均为 `false` |

`transport:'relay'` 时 `webrtc.attempted` 为 `false`，不会先发 warm-up。`transport:'webrtc'`
严格失败返回 HTTP 502 + `code:'WEBRTC_UNAVAILABLE'`，`channel:null`、`relay_used:false`。

### `auto` 回落顺序

```
auto + allowLegacyP2P:false  -> WebRTC -> relay
auto + allowLegacyP2P:true   -> WebRTC -> legacy P2P -> relay
webrtc                       -> WebRTC only (502)
relay                        -> relay only
```

旧 P2P 成功时 `channel:'p2p'`、`preferred:'webrtc'`、`relay_used:false`，`fallback_reason` 为
WebRTC 失败码。

### `/config` 运行态

GET 增加：

- `pool_available`：live pool 存在且 `getPoolState()?.ready !== false`；
- `pool_owner`：`getPoolState()?.owner`；
- `transport_source`：`row` / `json` / `default`；
- `legacy_p2p`：行是否显式允许旧 UDP。

POST 未带 `transport` 时，使用当前解析结果（文件优先，其次行默认），写盘后来源变为 `json`。

### 未改变

- `view.*` 帧格式、`/frame` 的 202/200 语义；
- consent 检查与输入拒绝边界；
- `/stop` 对 WebRTC 只发 `view.stop` 并退订，不 `closePeer`。

## 测试

扩展 `test/remote-view-route.test.mjs`（16 tests）：

- `auto` + 默认 `allowLegacyP2P:false` 时不 dial 旧 UDP；
- 显式 `allowLegacyP2P:true` 时旧 P2P 仍可建立，且五个固定字段正确；
- 行 `transport:'webrtc'` 无文件时 `/config` 报 `transport_source:'row'`；
- 写入 `remote-view.json` 后 `/config` 报 `transport_source:'json'` 且文件 transport 覆盖行；
- 行不提供 transport 时报 `default` / `auto`；
- 显式 relay 模式跳过 WebRTC，`webrtc.attempted:false`、`relay_used:true`；
- WebRTC 成功时 `webrtc` 子对象含 owner / machine id / prepare_ms / ack_code / ack_pool_owner；
- WebRTC 严格失败时四个固定字段存在且 `relay_used:false`；
- relay 回落时 `relay_used:true`、`fallback_reason` 为 WebRTC 失败码；
- `/config` 在有 pool 时报 `pool_available:true` / `pool_owner:'dsh-p2p-webrtc'`。

## 验证结果

| 套件 | 结果 |
| --- | --- |
| P3/P4 定向：deliver + late binding + remote-view + backup wiring | 54/54 |
| `test/remote-view-route.test.mjs` | 16/16（13 路由 + 3 target warm-up） |
| `npm run test:p2p-webrtc` | 87/87 |
| `npm run test:p2p-webrtc-pool-runtime` | 19/19 |
| Teams / P2P V2 回归 | 50/50 |
| `npm run layer-check` | clean，20 条声明边全部命中 |
| 改动 JS 文件 ESLint | 0 error，13 warning（`remote-view-route` 3 条既有 `require-atomic-updates`；`remote-view-route.test` 10 条既有 `require-atomic-updates` / `no-promise-executor-return`） |

未执行：`git push`、`git tag`、`npm publish`、GitHub Release、市场索引。

## 不在 P4 范围

- P5：客户端通道标签、远程桌面面板状态、`/api/w2m/remote/diagnostics`。
- P6：provider 安装与服务部署。
- P7：真实多机 soak 与 33 次重试现场验证。
- 设计文档写的 `docs/acceptance/3.7.0/DESKTOP-WEBRTC-DEFAULT.json` 与当前 package `3.6.0`
  不一致；本阶段按仓库既有的 `docs/acceptance/3.6.0/*.md` 记录，不创建 3.7.0 目录。
