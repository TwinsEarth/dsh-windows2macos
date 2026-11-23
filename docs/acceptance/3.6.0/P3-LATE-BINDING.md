# P3 验收：目标端与任务面晚绑定

- 日期：2026-11-23
- 分支：`work/v3.6.0-desktop-v2`
- 代码基线：P2 `ea5d296` + 验收文档 `f5d3116`
- P3 代码提交：`7a56c84 feat(webrtc): late-bind agent consumers to the shared pool`
- 版本：`@twinsearth/w2m-dsh-plugin@3.6.0`

## 目标

`dsh-p2p-webrtc` 在 root `w2m` 之后 mount 时，任务结果、远程桌面 warm-up、Teams/V2 数据面
仍需自动使用同一个共享 WebRTC pool，不能停留在“root 启动时 pool 为 null”的旧状态。

## 实现合同

### `heartbeat.mjs`

- 新增 `createViewWebRtcPrepare(deps)`：每次 viewer 请求重读 `deps.getWebRtcPool()`。
- 取不到 pool 时回退 `deps.webrtcPool`；两者都没有时返回命名 `WEBRTC_POOL_UNAVAILABLE`。
- getter 抛异常时同样返回 `WEBRTC_POOL_UNAVAILABLE`，detail 带原因，不产生未命名 rejection。
- `prepare` 成功或失败的回包都带 `pool_owner`；owner 由 `deps.getWebRtcPoolState()` 读取。
- `prepareWebRtc` 不再在 `startRelayViewTarget` 时捕获固定 pool。

### `deliver.mjs`

- `getWebRtcPool` 是构造选项；未注入时回退旧的 `options.webrtcPool`。
- `ensureWebRtcPool()` 在 `attachWebRtc`、`webrtcStatusSnapshot`、`sendResultWebRtc`、
  `planDirectDelivery`、WebRTC frame adapter 的 `send` 前重读 getter。
- pool 从 `null` 变为可用时自动 `onMessage` 订阅；pool 替换时先退订旧 pool，再订阅新 pool，
  并清空旧 pool 上建立的 channel。
- `closeP2P()` 退订并将当前 pool 引用重置为 `null`，下一次操作可重新晚绑定。
- `webrtcStatusSnapshot()` 增加 `owner`，来源为 `getWebRtcPoolState()?.owner`。

### `agent.mjs` / `tools/shared.mjs`

- `AgentOptions` 增加 `getWebRtcPool`、`getWebRtcPoolState`，并在构造时校验为 function 或 null。
- 两个 getter 进入 `deps`，供 heartbeat/deliver 使用；`agent.webrtcPool` 读取时优先走 getter，
  再回退构造时 pool。
- root `w2m` 的 `createAgent` 注入：

  ```js
  getWebRtcPool: getSharedWebRtcPool,
  getWebRtcPoolState: () => getSharedWebRtcPoolState(),
  ```

- 这是层边界要求：`agent` 层不能 import `plugin` 层，registry 的读取通过 composition root 注入，
  但 owner 仍只有 registry 一个来源。

### `dispatch.mjs`

- 任务分发在每次 `dispatch` 时解析 `getSharedWebRtcPool() ?? inProcessWebRtcPool`；
  `inProcessWebRtcPool` 只作为兼容快照，registry 是 live 来源。
- 因此 provider 晚于 root mount 时，后续分发仍可切到同一个共享 pool，不再只走 relay。

### `relay-target.mjs`

- `/v1/remote/ack` body 增加 `pool_owner`（无值时 `null`）。
- warm-up 日志增加同一字段，便于现场判断 ack 来自哪个 pool owner。

## 测试

新增 `test/webrtc-late-binding.test.mjs`：

- pool 未发布时 `prepare` 返回 `WEBRTC_POOL_UNAVAILABLE`；
- phase 构建后 pool 才出现，`prepare` 成功并带 `pool_owner`；
- getter 抛异常时返回命名 code，不抛未命名异常。

扩展 `test/p2p-webrtc-deliver.test.mjs`：

- deliver 构建时 pool 为 null，之后 pool 出现，`planDirectDelivery` 自动走 WebRTC；
- getter 始终无 pool 时，`sendResultWebRtc` 返回未投递，不抛；
- `webrtcStatusSnapshot().owner` 从 `null` 变为 `dsh-p2p-webrtc`。

扩展 `test/remote-view-route.test.mjs`：

- warm-up 成功 ack 带 `pool_owner: 'dsh-p2p-webrtc'`；
- warm-up 失败 ack 带 `pool_owner: null`。

扩展 `test/p2p-webrtc-pool-runtime.test.mjs`：

- root `shared.mjs` 必须传 `getWebRtcPool` 与 `getWebRtcPoolState`，不能只传构造时 pool；
- `dispatch.mjs` 必须使用 `getSharedWebRtcPool() ?? inProcessWebRtcPool` 的晚绑定顺序。

扩展 `test/p2p-webrtc-dispatch.test.mjs`：

- `resolveDispatchWebRtcPool` 在 registry 未发布时使用 mount 快照，发布后切到 live pool；
- 两者都没有时返回 `null`。

## 验证结果

| 套件 | 结果 |
| --- | --- |
| P3 定向：deliver + remote-view + heartbeat late binding | 23/23 |
| `npm run test:p2p-webrtc`（已纳入 `webrtc-late-binding` + dispatch 晚绑定） | 87/87 |
| `npm run test:p2p-webrtc-pool-runtime` | 19/19 |
| Teams / P2P V2 回归 | 50/50 |
| `npm run layer-check` | clean，20 条声明边全部命中 |
| 改动文件 ESLint | 0 error，29 warning（均为既有 `require-atomic-updates` / `no-promise-executor-return`） |

未执行：`git push`、`git tag`、`npm publish`、GitHub Release、市场索引。

## 不在 P3 范围

- P4：桌面 `transport:'auto'` 默认收紧、生产 profile 改为 `transport:'webrtc'` /
  `allowLegacyP2P:false`、`/start` 固定字段。
- 真实跨机四节点矩阵与 30 分钟 soak。
