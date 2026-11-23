# P5 验收：可观测性与客户端标签

- 日期：2026-11-24
- 分支：`work/v3.6.0-desktop-v2`
- 代码基线：P4 `48d9b74` + 验收文档 `c4472fa`
- 版本：`@twinsearth/w2m-dsh-plugin@3.6.0`

## 目标

把远程桌面从“能连”推进到“连了之后能解释”：客户端不再用含糊的 `P2P` 概括所有非 WebRTC 路径，
面板直接显示当前通道与是否直连；pool 未就绪时在点击连接前提示；新增只读诊断路由，让排障不再
依赖日志或临时脚本。

## 实现合同

### 客户端标签与预检

- 通道标签统一为：
  - `webrtc` -> `WebRTC`
  - `relay` -> `加密 relay`
  - `p2p` -> `旧 P2P`（只在显式兼容开关启用时出现）
  - 未连接 -> `未连接`
- `RemoteViewSettings` 的说明改为“媒体优先 WebRTC；不可用时回落加密 relay；旧 P2P 仅兼容开关
  启用”，不再写“媒体优先 P2P”。
- `RemoteViewMainPage` 每 3 秒读取 `/api/w2m/remote/config` 与 `/api/w2m/remote/diagnostics`：
  - `pool_available !== true` 且 `transport !== 'relay'` 时，在画布上方显示“WebRTC 未就绪：共享
    pool 尚未发布，连接会回落到加密 relay。”，不隐藏连接按钮、也不提前改写 `transport`。
  - 顶部状态行显示当前通道与直连判定。
  - 状态栏显示当前通道、直连、WebRTC 就绪态；采集耗时、帧大小、最近帧时间保持原样。
- 失败原因只在失败时出现：`/start` 的非 2xx 继续进入画布的“查看失败：<code>”，成功态与正常
  等待帧不显示 `fallback_reason`。
- 直连判定来源是诊断路由的 `session.direct`：
  - relay 固定 `false`；
  - 旧 P2P 固定 `true`；
  - WebRTC 取 active peer 的 `path`，`direct` 为 `true`；`relay/degraded/fallback` 为 `false`；
    peer 尚未出现或 `path` 为空时为 `null`（客户端显示“检测中”）。`/start` 的返回形状不变。

### `GET /api/w2m/remote/diagnostics`

- 注册在既有的 `connection.fetch` registry 上，只接受 `GET`；鉴权沿用宿主连接层，本路由不另建
  鉴权通道。
- 只读：不改变 active session、不触发 capture、不启动 pool、不写 settings 文件。
- 响应顶层：

| 字段 | 语义 |
| --- | --- |
| `ok` | 恒 `true`；路由本身不返回业务失败 |
| `at` | 本次快照的 ISO 时间 |
| `uptime_ms` | 从本路由注册到现在的毫秒数 |
| `pool_available` / `pool_owner` | 与 `/config` 同源 |
| `transport_source` / `legacy_p2p` | 当前解析来源与行兼容开关 |
| `config` | `{enabled, transport, transport_source, legacy_p2p}` |
| `pool` | 见下表 |
| `session` | 当前 active 会话，或 `null` |
| `counters` | 本进程内的 ack / relay 计数 |
| `last_error` | 最近一次命名错误，或 `null` |

- `pool`：

| 字段 | 语义 |
| --- | --- |
| `available` | live pool 存在且 registry `ready !== false` |
| `owner` / `ready` / `epoch` | registry 状态 |
| `machine_id` | viewer pool 的本机 id |
| `peer_count` / `peers` | active peer 的安全投影 |
| `stats` | `sends / send_failures / start_failures / bytes_sent`，无 pool 时为 `null` |

- 每个 peer 只输出：`peer, role, state, path, path_reason, rtt_ms, secure, provider_ready,
  started_at, last_used_at, starts, sends, bytes_sent, last_error`。不输出 `room`、`signal_peer`、
  `signal_url`、`signal_token`、provider 原始对象或任何密钥。
- `session` 输出：`machine_id, channel, encrypted, direct, error, started_at, last_frame_at`。
- `counters` 语义：

| 字段 | 语义 |
| --- | --- |
| `ack_polls` | `fetchRelayAck` 被调用的次数（含 pending 轮询） |
| `ack_count` | 收到 `ok:true` ack body 的次数 |
| `last_ack_code` | ack body 的 `code`；缺省时按 `prepared` 记为 `WEBRTC_PREPARED` / `WEBRTC_PREPARE_FAILED` |
| `last_ack_at` | 最近一次成功 ack 的时间 |
| `relay_frame_calls` | 真正向 relay 发出帧轮询 HTTP 的次数 |
| `relay_frames` | 成功解密并写入 `active.latest` 的 relay 帧数 |
| `last_relay_frame_at` | 最近一帧的 `latest.at` |

- 脱敏：
  - `last_error.detail` 与 peer `last_error.detail` 截断到 300 字符；
  - `(ws|wss|http|https)://...` 替换为 `<signaling-url>`；
  - `Bearer ...` 替换为 `Bearer <redacted>`；
  - `token=...` 的查询参数值替换为 `<redacted>`；
  - 顶层不返回 `signal_url` / `signal_token` 字段。
- `/start` 的 WebRTC / 旧 P2P / relay 失败出口统一调用 `noteError`；`/frame` 的
  `VIEW_WEBRTC_HANDSHAKE_TIMEOUT`、`VIEW_WEBRTC_SEND_FAILED`、`VIEW_VK_REQUIRED`、`VIEW_VK_BAD`、
  `VIEW_RELAY_UNAVAILABLE` 统一走 `setActiveError`，同时写 `active.error` 与 `last_error`。

### 未改变

- `view.*` 帧格式、`/frame` 的 202/200 语义、consent 检查、输入拒绝边界。
- `/start` 固定的 `channel / preferred / fallback_reason / webrtc / relay_used` 字段。
- `/stop` 对 WebRTC 只发 `view.stop` 并退订，不 `closePeer`。
- 诊断路由不参与 `/config` 的写路径，不改变 `remote-view.json`。

### 客户端体积预算

`test/client-budget.test.mjs` 的字节/行预算从 `610,000 / 10,050` 调整为 `616,000 / 10,150`。
原因不是“先超再放宽”：P5 改动前 `lib/client.js` 已是 `609,887` bytes / `10,048` lines，
只剩 113 bytes / 2 行的空间；P5 的标签、预检与诊断轮询需要约 2.4 KB / 48 行。预算注释已同步为
P5 后的 `612,329` bytes / `10,096` lines，per-function 1,200 行上限未动。

## 测试

`test/remote-view-route.test.mjs` 由 16 tests 增至 18 tests：

- WebRTC 成功路径的 diagnostics：
  - `session.channel:'webrtc'`、`session.encrypted:true`；
  - `ack_polls >= 1`、`ack_count === 1`、`last_ack_code:'WEBRTC_PREPARED'`；
  - `relay_frames === 0`。
- relay 路径的 diagnostics：
  - `session.channel:'relay'`、`session.direct:false`；
  - 两次 `/frame` 后 `relay_frame_calls === 2`、`relay_frames === 2`；
  - 纯 relay 启动不轮询 WebRTC ack，`ack_polls === 0`。
- 只读快照：
  - `pool_available / pool_owner / pool.machine_id / peer_count / peers[0].path / stats.sends`
    均来自真实注入的 pool；
  - 响应全文不含 `signal-secret`、`wss://`、`signal_token`、`signal_url`；
  - peer `path_reason` 与 `last_error.detail` 中的 signaling URL、Bearer、token 均被脱敏。
- 失败可读性：
  - 远程未开启时 `/start` 仍先返回 403；
  - 开启后失败启动写入 `last_error`，包含 `code` 与 `at`，且不泄露请求中的任何凭据。

`test/client-bundle.test.mjs` 增加 2 个 P5 契约断言：

- 三个标签映射存在，`加密中继` 已从客户端消失；
- 客户端读取 `/api/w2m/remote/diagnostics`，以 `pool_available === true` 做预检，并显示
  “WebRTC 未就绪”。

## 验证结果

| 套件 | 结果 |
| --- | --- |
| `test/remote-view-route.test.mjs` | 18/18（13 路由 + 3 target warm-up + 2 diagnostics） |
| P3/P5 定向：deliver + late binding + remote-view + backup wiring | 56/56 |
| `npm run test:p2p-webrtc` | 87/87 |
| `npm run test:p2p-webrtc-pool-runtime` | 19/19 |
| `npm run test:teams` | 39/39 |
| `npm run test:p2p-v2` | 11/11 |
| 远程查看相关套件（`remote-s2-capture`、`view-capture`、`view-frame-channel`、`view-consent`、`remote-media`、`view-session-key`、`remote-requests`、`relay-target`） | 26/26 |
| `test/client-budget.test.mjs` | 4/4 |
| `test/client-bundle.test.mjs` | 140/140（含 P5 2 条） |
| `npm run layer-check` | clean，20 条声明边全部命中 |
| P5 改动 JS ESLint | 0 error |

未执行：`git push`、`git tag`、`npm publish`、GitHub Release、市场索引。

## 不在 P5 范围

- P6：`docs/DESKTOP-PRODUCTION.md`、provider 安装与 readiness 脚本。
- P7：真实多机 soak、33 次重试现场验证、最终 JSON 验收包。
- 诊断计数是进程内计数，不落盘、不做跨重启累计，也不做 Prometheus 指标导出。
- 设计文档最终路径 `docs/acceptance/3.7.0/DESKTOP-WEBRTC-DEFAULT.json` 与当前 `3.6.0` 不一致，
  P5 继续按 `docs/acceptance/3.6.0/*.md` 记录。
