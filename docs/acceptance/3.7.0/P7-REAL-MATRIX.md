# P7 关键补强验收（3.7.0）

- 分支：`work/v3.7.0-v2-baseline`
- P7 基线：`859422a`（P6 发布准备完毕）
- 验收日期：2026-11-24
- 结论：**P7 五项全部通过**：第 1–4 项通过；第 5 项的同机四节点 100 MiB、真实进程 kill 续传、4 MiB/安全拒绝、公网 TURN 三物理 1 MiB 三条链路、双机 100 MiB，以及三物理节点 100 MiB P2P V2 矩阵均已通过。公网 coturn 已在 `43.142.74.71:3479` 实际打通，Mac/IM2A/TOFUTURE 均取得 `typ relay` 候选。三物理节点 100 MiB 矩阵采用 TOFUTURE 单 seed、Mac 与 HSD 两个 leecher 同时接入；seed 对两端 attach 均成功，两个 leecher 均完成 100 MiB 且 SHA-256 匹配。第 ⑤ 项改判通过，P7 整体通过。

## 1. 五项补强对照

| 项 | 要求 | 落地位置 | 验证 | 结论 |
| --- | --- | --- | --- | --- |
| ① | 把直接绑定 pool 的 adapter 抽成 `TorrentTransport` 接口，先注册 `webrtc-v1`，V2.0 不实现其他 transport | `src/agent/webtorrent/transports/registry.mjs`、`webrtc-v1.mjs`；`share/add/attach` 接受 `transport`，默认 `webrtc-v1`，未知名字返回 `P2P_V2_TRANSPORT_UNKNOWN` | `test/p2p-v2-p5.test.mjs`；P6 `test:p2p-v2` 57/57 | 通过 |
| ② | 多 seed / 多 leecher 生产级编排：部分 attach 失败不阻断、peer 去重、上限、swarm 状态 | `service.mjs` 的 `maxPeersPerShare`、`peers()`、`swarm` 摘要、`peer_errors`、`P2P_V2_PEERS_UNREACHABLE` | P2/P5 单元与集成；P7 四节点真实矩阵：一个 leecher 同时从两个 seed 拉取 | 通过 |
| ③ | 下载目录默认 `<dshHome>/p2p-v2/downloads`；路径越界、symlink、配额、半文件、断点恢复 | `downloadRoot` 默认 `<stateDir>/downloads`；`path-safety.mjs`；`.w2m-partial-<infoHash>` staging；`shares.json` 原子持久化；`status.restore` | `test/p2p-v2.test.mjs` 的 `PATH_OUTSIDE_ROOT` / `SENSITIVE_PATH`；`test/p2p-v2-p5-resume.test.mjs`；P7 真实进程 kill 续传 | 通过 |
| ④ | 同一 pair 上任务 JSON 与 torrent 帧混合流量回归 | `test/p2p-v2-dispatch-isolation.test.mjs`：`task.offer` JSON + tagged torrent 帧 + `result.ack` JSON；`pushOfferBestPath` 仍走 `webrtc-v1`；`TOOL_NAMES` 7 个且无 `task.*` | 3/3 通过（P4/P6 回归） | 通过 |
| ⑤ | 三节点以上真实矩阵、100 MiB、断线恢复、安全拒绝、4 MiB 帧边界 | P7 新增 `scripts/p7-v2-real-matrix.mjs`、`scripts/p7-v2-resume-matrix.mjs`；边界测试沿用 P5/P4 单元；公网 TURN 测试使用 `scripts/webrtc-cross-machine.mjs`、`scripts/webrtc-matrix-preflight.mjs`、`scripts/p5-v2-worker.mjs` | 同机四节点 100 MiB 通过；真实进程 kill 续传通过；4 MiB/安全拒绝单元通过；公网 TURN 三物理 1 MiB 三条链路全部 `path=relay` 通过；双机 100 MiB 通过；TOFUTURE 单 seed + Mac/HSD 双 leecher 的三物理 100 MiB 同时矩阵通过 | **通过** |

## 2. 四节点真实矩阵（100 MiB）

环境：Linux 云主机，Node `v22.23.4`，`webtorrent@3.0.21`，`node-datachannel@0.33.6`，本地信号 `ws://127.0.0.1:8791/w2m/webrtc`。四个独立 worker 进程：`seed-1`、`seed-2`、`leech-a`、`leech-b`。

- 文件：100 MiB（104,857,600 bytes）
- SHA-256：`29bd2f6471aa2f9a8e1c909b7485001cd1396d41acc8758c48cebb77cea9fdb7`
- `leech-a`：同时挂 `seed-1` 和 `seed-2`，两个 peer 均为 `webrtc-v1`、`state=open`、`last_error=null`
  - `seed-1`：`bytes_in=55,290,575`
  - `seed-2`：`bytes_in=49,666,677`
  - 完成时间：15.2 s（`00:08:19.599` → `00:08:34.803`）
- `leech-b`：只挂 `seed-2`，`bytes_in=104,957,088`，完成时间 18.9 s
- 两个 leecher 最终 SHA 均等于源文件
- 峰值 RSS：`seed-1=196,992 KB`、`seed-2=224,296 KB`、`leech-a=221,392 KB`、`leech-b=191,200 KB`，均低于 256 MiB 量级

这一行证明：同一 leecher 能同时从两个真实 seed 拉取同一 info hash，peer 去重、swarm 状态和部分 peer 失败不影响其他 peer。

## 3. 真实进程 kill 续传

环境同上。`leech-r` 从 `seed-r1` 下载 100 MiB；当 staging 文件达到 20,971,520 bytes 时对进程发送 `SIGKILL`，保留 staging；随后用新的 `seed-r2` 重新挂载同一 `leech-r`，复用同一 work 目录继续。

- kill 时 staging：20,971,520 bytes
- 第二次完成：104,857,600 bytes、`progress=1`、SHA 同上
- 第二次耗时：8.3 s（`00:07:27.768` → `00:07:36.071`）

证明的是**真实 WebTorrent + node-datachannel 进程被 kill 后的 staging 持久化与续传**，不是只重启 service。

## 4. 边界与安全拒绝

| 用例 | 证据 | 结果 |
| --- | --- | --- |
| 4 MiB 帧边界 | `test/p2p-v2-p5.test.mjs`：帧上限、超 1 字节拒绝、空 payload/坏 header 拒绝 | 通过 |
| 路径越界 | `test/p2p-v2.test.mjs`：`PATH_OUTSIDE_ROOT`，staging 不落盘 | 通过 |
| 敏感路径 | `test/p2p-v2.test.mjs`：`SENSITIVE_PATH` | 通过 |
| 坏 magnet / 坏 hash | `test/p2p-v2.test.mjs`：命名拒绝 | 通过 |
| 混合流量 | `test/p2p-v2-dispatch-isolation.test.mjs`：3/3 | 通过 |

## 5. 跨物理机 TURN 数据面：1 MiB、双机 100 MiB 与三物理 100 MiB 矩阵均已通过

### 5.1 公网 coturn 已实际可用

公网主机 `43.142.74.71`（腾讯云 Lighthouse `lhins-kbrk9kjq`，实例名 `W2M`，Debian 12，私网 `10.0.0.10`）上的 `coturn.service` 处于 `active (running)`。实际配置：

- `listening-port=3479`，`3478` 由 `w2m-stun.service` 占用。
- `external-ip=43.142.74.71/10.0.0.10`，`relay-ip=10.0.0.10`。
- relay 端口范围 `49160-49200`，Lighthouse 防火墙已放行 `UDP/TCP 3479` 与 `UDP 49160-49200`。
- 认证为 `lt-cred-mech`，realm `w2m.webrtc`。

用 `node-datachannel` 的 `PeerConnection` 设置 `iceTransportPolicy: 'relay'`，只向 `turn:43.142.74.71:3479` 发起 Allocate，三台物理机均得到真实 relay candidate：

| 节点 | relay candidate | `relay` 标志 |
| --- | --- | --- |
| Mac | `43.142.74.71:49182 typ relay` | 1 |
| IM2A | `43.142.74.71:49196 typ relay` | 1 |
| TOFUTURE | `43.142.74.71:49166 typ relay` | 1 |

这不是 openrelay 只有 `host` candidate 的旧结果。公网入站、TURN 认证和 relay 端口分配都已实际生效。

### 5.2 三物理节点 1 MiB artifact 矩阵

信号使用公网 `w2m-signal-test.service`（`0.0.0.0:8791`，路径 `/w2m/webrtc`）。Mac、TOFUTURE、HSD 三台预检均 `ok:true`，code hash 同为 `88818fa453a0f9f0f9813bf70f483e10f60ed2f974ef5f188022987e28e1aca4`。测试完成后已停止 8791 临时服务并删除 Lighthouse 的临时 `TCP 8791/0.0.0.0/0` 规则；生产信令 `w2m-webrtc-signal.service`（8790）保留。

三条链路均通过 `TeamsDataPlane` + `transport=webrtc-v1`，大小 1,048,576 bytes，SHA-256 均为 `631b84027d6b9e52b539c4e8373622d23032dfadc64d60af87339c9037e4f769`：

| 链路 | sender | receiver | RTT | 结果 |
| --- | --- | --- | --- | --- |
| Mac → TOFUTURE | Mac | TOFUTURE | sender 60 ms；receiver 42/46 ms | `path=relay`、`secure=secure`、`received.ok=true` |
| HSD → Mac | HSD | Mac | sender 27 ms；receiver 23 ms | `path=relay`、`secure=secure`、`received.ok=true` |
| TOFUTURE → HSD | TOFUTURE | HSD | sender 50 ms；receiver 44 ms | `path=relay`、`secure=secure`、`received.ok=true` |

`path=relay` 的语义已在 `src/agent/webrtc/path.mjs` 核对：`PathSelector.verdict()` 在选中 candidate 的 local 或 remote `type === 'relay'` 时返回 `PATH_VERDICT.RELAY`；`FALLBACK` 只在 `allowRelay=false` 或失败次数超阈值时出现。因此这里表示 ICE 选中的是 TURN relay candidate，不是 W2M relay 回退。W2M relay 仍只承载 JSON 控制帧。

证据文件：Mac `/Users/fang/w2m-p6/.matrix/turn-pair-mac-to-tofuture/sender.json`、`/Users/fang/w2m-p6/.matrix/turn-pair-hsd-to-mac/receiver.json`；TOFUTURE `E:\DB\W2M\.matrix\turn-pair-mac-to-tofuture\receiver.json`、`E:\DB\W2M\.matrix\turn-pair-tofuture-to-hsd\sender.json`；HSD `C:\Users\AU\w2m-p7\.matrix\turn-pair-hsd-to-mac\sender.json`、`C:\Users\AU\w2m-p7\.matrix\turn-pair-tofuture-to-hsd\receiver.json`。

### 5.3 100 MiB P2P V2 双机链路

同一份确定性 100 MiB payload：

- 大小：104,857,600 bytes。
- SHA-256：`29bd2f6471aa2f9a8e1c909b7485001cd1396d41acc8758c48cebb77cea9fdb7`。
- info hash：`dd05f3b5768f2dc298bcccb2fa1533e8502f48b0`。

已完成的双机链路：

| 链路 | 结果 | 路径/时延 | 证据 |
| --- | --- | --- | --- |
| Mac seed → HSD leecher | 100 MiB，SHA 匹配；`bytes_in=104,957,100`，`chunks_in=12,810` | 约 181.5 s（`05:04:08.453Z` → `05:07:09.961Z`） | HSD `leech-hsd-turn.json` |
| Mac seed → TOFUTURE leecher（8792c） | 100 MiB，SHA 匹配；`bytes_in=104,957,104`，`chunks_in=12,811` | `path=relay`，RTT 约 55 ms；约 3 分 48 秒 | TOFUTURE `leech-tofuture-8792c.json` |
| Mac seed → TOFUTURE leecher（8792d） | 100 MiB，SHA 匹配；`bytes_in=104,957,104`，`chunks_in=12,811` | `path=relay`，RTT 约 62 ms；`06:20:09.229Z` 完成 | TOFUTURE `leech-tofuture-8792d.json` |

这些是真正的 WebTorrent P2P V2 100 MiB，不是 Teams artifact，也不是 W2M relay 承载字节。

关键编排事实：seed worker 的 pool 是惰性的；seed 未执行 `--attach <leecher>` 时不会加入信令房间，leecher 的 `pool.ensure()` 会一直等 `peer-joined`，最终报 `P2P_V2_PEER_UNREACHABLE` / `WEBRTC_CONNECT_TIMEOUT`。早期看到的 TOFUTURE 3 MiB 停滞和 0 字节，根因是 seed 未 attach，而不是 TOFUTURE 数据面故障；在 seed 主动 attach 后，TOFUTURE 能完整下载 100 MiB。

### 5.4 三物理 100 MiB P2P V2 矩阵已通过

最终矩阵使用新的临时公网信令 `8792`（`w2m-signal-test2.service`，token `w2m-matrix-20261124b`），三台物理节点同时参与：

- **TOFUTURE**：唯一 seed，machine `14ba0e60-14f5-4ab8-a2fe-d7cd4f51d833`，持有 100 MiB payload。
- **Mac**：leecher，machine `b1b19d49-20f1-4cdc-986e-f5630a5cd6f2`。
- **HSD**：leecher，machine `f4961153-3280-4c4e-b117-881b232e2066`。
- TOFUTURE seed 对 Mac、HSD 两端 attach 均返回 `ok:true`：
  - Mac `attached_at=2026-11-24T06:21:25.609Z`
  - HSD `attached_at=2026-11-24T06:21:27.179Z`
- Mac leecher：`06:21:23.952Z` 启动，`06:26:23.092Z` 完成；`bytes=104,857,600`，SHA-256 匹配；`pool.path=relay`，RTT 58 ms；`share.peer_count=2`（同一 seed swarm 内同时存在两个 leecher）。
- HSD leecher：`06:21:10.309Z` 启动，`06:27:37.442Z` 完成；`bytes=104,857,600`，SHA-256 匹配；peer `state=open`，`bytes_in=104,957,112`，`chunks_in=12,813`。HSD 侧使用旧版 worker，结果 JSON 未输出 `path` 字段；同向的 1 MiB HSD receiver 已验证为 `path=relay`。

证据文件：

- TOFUTURE：`E:\DB\W2M\.matrix\p7-physical\seed-tofuture-8792e.json`（两端 attach 均 `ok:true`）、`leech-tofuture-8792c.json`、`leech-tofuture-8792d.json`。
- Mac：`/Users/fang/w2m-p6/.matrix/p7-physical/leech-mac-8792e.json`、`leech-mac-8792e.status.jsonl`。
- HSD：`C:\Users\AU\w2m-p7\.matrix\p7-physical\leech-hsd-8792e.json`。

因此，第 ⑤ 项的“三物理节点 100 MiB P2P V2”子项**通过**：TOFUTURE seed 同时服务 Mac 与 HSD 两个物理 leecher，两个 leecher 都完成 100 MiB 且 SHA-256 匹配。这不是“两节点成功 + 第三节点进程在旁边运行”；第三节点 HSD 有实际 100 MiB 数据接收记录。

测试完成后，`8792` 临时信令服务已停止，Mac 侧探测 `http://43.142.74.71:8792/health` 连接失败；生产 `8790` 信令不受影响。Lighthouse 的临时 `TCP 8792` 放行规则未在本次命令中删除。

同机四进程、Cloudflare tunnel `/health`、W2M relay、Teams V2 本地 MVP 仍不作为该子项的通过证据。

### 5.5 其余限制

1. 4 MiB 帧边界与安全拒绝仍是单元/协议层证据，不是跨机真实链路证据。
2. 本次三物理矩阵只验证了 TOFUTURE 作 seed、Mac/HSD 作 leecher 的拓扑；没有把“Mac/HSD 作 seed 同时服务另外两台”全部排列组合跑完。
3. HSD 旧版 worker 不输出 `path` 字段；本矩阵 HSD 100 MiB 的路径只能用同向 1 MiB `path=relay` 结果旁证，未对 HSD 100 MiB 单独下 `path=relay` 结论。
4. Teams V2 的 50/50 测试与本地 MVP 属于本地交付，不进入 P7 跨机验收口径。

## 6. 复现

```bash
# 依赖：webtorrent 3.0.21 + node-datachannel 0.33.6
W2M_WEBTORRENT_MODULE=/path/to/webtorrent/index.js \
W2M_WEBRTC_PROVIDER_CWD=/path/to/provider \
node scripts/p7-v2-real-matrix.mjs \
  --signal ws://127.0.0.1:8791/w2m/webrtc \
  --work .matrix/p7-v2-real \
  --bytes 104857600

W2M_WEBTORRENT_MODULE=/path/to/webtorrent/index.js \
W2M_WEBRTC_PROVIDER_CWD=/path/to/provider \
node scripts/p7-v2-resume-matrix.mjs \
  --signal ws://127.0.0.1:8791/w2m/webrtc \
  --work .matrix/p7-v2-resume \
  --payload .matrix/p7-v2-real/payload.bin
```

## 7. 产物

- `scripts/p7-v2-real-matrix.mjs`：四节点、2 seed、多 seed leecher、100 MiB、RSS 采样。
- `scripts/p7-v2-resume-matrix.mjs`：真实进程 kill、staging 保留、换 seed 续传、SHA 校验。
- `package.json`：新增 `matrix:p2p-v2-p7`、`matrix:p2p-v2-p7-resume`。
- 原始结果：`.matrix/p7-evidence/`（本地未提交，`.matrix/` 已在 `.gitignore`）。
