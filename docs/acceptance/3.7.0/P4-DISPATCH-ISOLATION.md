# P4 验收：任务分发隔离回归

日期：2026-11-24  
分支：`work/v3.7.0-v2-baseline`  
代码基线：`6633d24`（P3 生产边界）

## 目标

同一 WebRTC pair 同时承载任务控制帧和 P2P V2 文件帧时，两个消费者必须各取所需、互不串扰。P4 不改 `src/plugin/tools/dispatch.mjs` 的 `pushOfferBestPath`，只用真实 deliver 与真实 V2 服务在同一个 fake pool 上做帧级回归。

## 边界

- deliver 只处理 JSON 控制帧：`task.offer`、`result.ack`；遇到合法 tagged WebTorrent 帧直接忽略。
- V2 只处理 tagged 帧：`decodeTorrentFrame` 有 magic/hash 校验；任何 JSON 控制帧在解码前返回 `null`，不计入 `frames_in`，也不产生 orphan。
- 任务分发仍走 `webrtc-v1`：`pushOfferBestPath` 在 pool.send 成功时返回 `transport: 'webrtc-v1'`。
- `p2p_v2` 不注册任何 `task.*` 类型：工具面只有 7 个 `p2p_v2_*`，错误码表没有 `TASK_*`，`dispatch.mjs` 保持原样。

## 测试

新增 `test/p2p-v2-dispatch-isolation.test.mjs`，3 个用例：

1. 同一 peer、同一 pool 上依次 emit `task.offer` JSON、tagged WebTorrent 帧、`result.ack` JSON；断言 deliver 只收到两个 JSON 帧，V2 的 `frames_in` 只增加 tagged 帧一次，`orphan_frames` 为 0，两个控制帧的 channel stack 都是 `webrtc-v1`。
2. `pushOfferBestPath(null, pool, task.offer, {})` 返回 `ok:true`、`transport:'webrtc-v1'`、`fallback_from:null`，pool 收到一次 `task.offer`；`TOOL_NAMES` 恰好 7 个且不含 `task.*`/`task_*`，`P2P_V2_CODE` 不含 `TASK_*`。
3. 正常 JSON 帧不以 torrent magic 开头，tagged 帧以 magic 开头；说明两个解析器的分流条件是帧格式而不是调用顺序。

测试 fixture 使用临时 state/download 根，V2 的 metadata 超时定时器由测试侧 keep-alive 保持，避免 `--test-force-exit` 把未 ref 的定时器当作空闲退出。

## 命令与结果

| 证据 | 结果 |
|---|---|
| `node --test --test-force-exit test/p2p-v2-dispatch-isolation.test.mjs` | **3/3，0 fail，0 skip** |
| `node --test --test-force-exit --test-concurrency=1 test/p2p-v2.test.mjs test/p2p-v2-dispatch-isolation.test.mjs` | **37/37，0 fail，0 skip** |
| `p2p-webrtc-deliver.test.mjs` | 8/8，0 fail |
| `p2p-webrtc-dispatch.test.mjs` | 8/8，0 fail |
| `test/claims.test.mjs` | 47 pass / 0 fail / 1 skip |
| tools-surface + acceptance-doc | 9/9，0 fail |
| `scripts/layer-check.mjs` | clean |
| 改动文件 ESLint（`--no-cache`） | 0 error / 0 warning |

`src/plugin/tools/dispatch.mjs` 的 diff 为空；`git status` 仅显示新增测试、测试 fixture 的 keep-alive 和脚本/文档改动。

P3 的 87/87 P2P WebRTC、39/39 Teams、24/24 remote-view 证据仍属于上一提交；P4 未触碰这些生产路径。
