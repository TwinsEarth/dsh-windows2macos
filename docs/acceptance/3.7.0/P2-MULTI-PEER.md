# P2 验收：多 peer / 多 seed 编排

日期：2026-11-24  
分支：`work/v3.7.0-v2-baseline`  
代码基线：`07fd250`（P1 传输抽象）

## 目标

在 P1 的命名传输之上，把 `p2p_v2_share` / `add` / `attach` / `status` 从单 peer 升级为显式多 peer 编排：一个 seed 可挂多个 leecher，一个 leecher 可同时连多个 seed；单个 peer 失败不阻断其余 peer；只读视图能看到已经连上的 pair 和每个 share 的 attach 状态。

## 实现

- `service.mjs`
  - `#attachPeers(record, peers, transport, role)` 对 peer id 按集合去重，逐项 attach；返回 `{attached, errors, requested}`。
  - peer 记录增加 `role`：seed 侧 attach 的 peer 记为 `leecher`，download 侧 attach 的 peer 记为 `seeder`；显式 `attach` 按 share 的 `mode` 推导。
  - `share` / `add` 的 `peers` 都走同一编排；`share` 单个失败进 `peer_errors` 后继续，`add` 部分失败仍继续等 `ready`。
  - `add` 的所有请求 peer 都失败时返回 `P2P_V2_PEERS_UNREACHABLE`，并调用 `stop` 销毁刚建的 torrent、清除 share 记录，不留空 share。
  - `#torrentSummary` 增加 `peer_count`、`seeders`、`leechers`、每 peer 的 `role`/`chunks`/`bytes`，以及 `swarm` 对象（`info_hash`/`files`/`progress`/`peer_count`/`seeders`/`leechers`）。
  - `status()` 增加根级 `transport`、`peer_count`；share 摘要继续携带 `transport` 与 swarm 计数。
  - 新增只读 `peers(input)`：只读当前 pool 的 `diagnostics()` 和 share 的 peer 摘要；不 dial、不启动 transport，输出中不含 signal URL/token；可按 `share_id`/`info_hash` 过滤。
- `p2p-v2-plugin.mjs`
  - 新增 `p2p_v2_peers` 工具（可选 `shareId`/`infoHash`）；工具面从 6 个变为 7 个。
- `docs/design/P2P-V2-WEBTORRENT.md` 更新工具表、生命周期、失败矩阵和测试矩阵。
- `package.json` 描述更新为 32 个工具（18 fleet + 4 P2P WebRTC + 3 Teams + 7 P2P V2）。

## 测试

| 证据 | 结果 |
|---|---|
| `node --test --test-force-exit test/p2p-v2.test.mjs` | **23/23，0 fail，0 skip** |
| `test/p2p-v2-live.mjs`（真实 WebTorrent 3.0.21 + fake WebRTC engine，2 节点） | **1/1，0 fail，0 skip** |
| `test:p2p-webrtc` | 87/87，0 fail |
| `test:teams` | 39/39，0 fail |
| remote-view 三套件 | 35/35，0 fail |
| `test/claims.test.mjs` | 47 pass / 0 fail / 1 skip |
| `test:tools-surface` | 3/3，0 fail |
| `test/acceptance-doc.test.mjs` | 6/6，0 fail |
| `npm run layer-check` | clean，所有跨层边已声明 |
| 改动文件 ESLint（`--no-cache`） | 0 error / 0 warning |

P2 新增用例覆盖：

1. 1 seed + 2 leecher：`share(peers)` 去重、本机 id 拒绝、`peer_count=3`/`seeders=1`/`leechers=2`。
2. 2 seed + 2 leecher：两个 seed 服务、两个 leecher 服务，各自 `add(peers)` 后 `seeders=2`/`leechers=1`。
3. 单 peer 失败其余成功：`share` 返回 2 个成功 + 1 个 `PEER_UNREACHABLE`；`add` 部分失败仍 `metadata_ready:true`。
4. 全部失败：`add` 返回 `P2P_V2_PEERS_UNREACHABLE`，share 被清理，torrent 被销毁。
5. peer 上限与重复 attach：重复 attach 返回 `reused:true`，超过 `maxPeersPerShare` 返回 `P2P_V2_PEER_LIMIT`。
6. 只读 peers：`p2p_v2_peers` 不调用 `ensure`，输出不含 `signal_url`/`signal_token`。
7. 同一 V1 pair 并发：任务 JSON 与 torrent 帧同时进出，`isTorrentFrame` 分流，任务 JSON 不进入 torrent adapter。

日志：`.matrix/baseline-370/p2-*.log`。

## 已知边界

- 3/4 节点编排由 deterministic fake engine 覆盖；真实 WebTorrent 的 live 证据仍是 2 节点。尝试在同一进程内跑 3 个真实 WebTorrent 客户端时，本机 Node 22.23.2 出现 native OOM/访问冲突，未把该用例纳入稳定套件；跨进程/跨机 3 节点 live 矩阵留待独立环境。
- `p2p_v2_peers` 只读当前 pool 已连的 pair，不做 fleet roster 自动发现，不主动 dial。
- `seeders`/`leechers` 是按 share 本地角色 + 已 attach peer 角色推导的拓扑计数，不是 tracker 的全局 swarm 统计。
- `add` 全部 peer 失败时只清理本次新建的 torrent；已连上的共享 pool 不关闭。

## 结论

P2 完成：`share`/`add` 的 `peers` 数组、逐 peer 错误隔离、全部失败聚合、peer 上限/幂等、swarm 计数与只读 peers 视图均已落地；帧格式和 V1 pair 所有权没有改变。P3 之前，V2 已具备显式的多 seed / 多 leecher 编排能力。
