# P7 关键补强验收（3.7.0）

- 分支：`work/v3.7.0-v2-baseline`
- P7 基线：`859422a`（P6 发布准备完毕）
- 验收日期：2026-11-24
- 结论：**P7 整体仍为“部分通过”**：第 1–4 项通过；第 5 项的同机四节点、100 MiB、多 seed、真实进程 kill 续传已通过。公网 coturn 已在 `43.142.74.71:3479` 实际打通，Mac/IM2A/TOFUTURE 均取得 `typ relay` 候选；Mac、TOFUTURE、HSD 三条 1 MiB artifact 链路全部 `path=relay` 通过；Mac→HSD 的 100 MiB P2P V2 也已完成。但“三物理节点 100 MiB P2P V2”矩阵仍未完成（TOFUTURE 侧数据面停滞），因此第 5 项的“三物理节点”子项继续保持“未通过”，整体不改为通过。

## 1. 五项补强对照

| 项 | 要求 | 落地位置 | 验证 | 结论 |
| --- | --- | --- | --- | --- |
| ① | 把直接绑定 pool 的 adapter 抽成 `TorrentTransport` 接口，先注册 `webrtc-v1`，V2.0 不实现其他 transport | `src/agent/webtorrent/transports/registry.mjs`、`webrtc-v1.mjs`；`share/add/attach` 接受 `transport`，默认 `webrtc-v1`，未知名字返回 `P2P_V2_TRANSPORT_UNKNOWN` | `test/p2p-v2-p5.test.mjs`；P6 `test:p2p-v2` 57/57 | 通过 |
| ② | 多 seed / 多 leecher 生产级编排：部分 attach 失败不阻断、peer 去重、上限、swarm 状态 | `service.mjs` 的 `maxPeersPerShare`、`peers()`、`swarm` 摘要、`peer_errors`、`P2P_V2_PEERS_UNREACHABLE` | P2/P5 单元与集成；P7 四节点真实矩阵：一个 leecher 同时从两个 seed 拉取 | 通过 |
| ③ | 下载目录默认 `<dshHome>/p2p-v2/downloads`；路径越界、symlink、配额、半文件、断点恢复 | `downloadRoot` 默认 `<stateDir>/downloads`；`path-safety.mjs`；`.w2m-partial-<infoHash>` staging；`shares.json` 原子持久化；`status.restore` | `test/p2p-v2.test.mjs` 的 `PATH_OUTSIDE_ROOT` / `SENSITIVE_PATH`；`test/p2p-v2-p5-resume.test.mjs`；P7 真实进程 kill 续传 | 通过 |
| ④ | 同一 pair 上任务 JSON 与 torrent 帧混合流量回归 | `test/p2p-v2-dispatch-isolation.test.mjs`：`task.offer` JSON + tagged torrent 帧 + `result.ack` JSON；`pushOfferBestPath` 仍走 `webrtc-v1`；`TOOL_NAMES` 7 个且无 `task.*` | 3/3 通过（P4/P6 回归） | 通过 |
| ⑤ | 三节点以上真实矩阵、100 MiB、断线恢复、安全拒绝、4 MiB 帧边界 | P7 新增 `scripts/p7-v2-real-matrix.mjs`、`scripts/p7-v2-resume-matrix.mjs`；边界测试沿用 P5/P4 单元；公网 TURN 测试使用 `scripts/webrtc-cross-machine.mjs`、`scripts/webrtc-matrix-preflight.mjs`、`scripts/p5-v2-worker.mjs` | 同机四节点 100 MiB 通过；真实进程 kill 续传通过；4 MiB/安全拒绝单元通过；公网 TURN 三物理 1 MiB 三条链路全部 `path=relay` 通过；Mac→HSD 100 MiB P2P V2 通过；三物理 100 MiB P2P V2 矩阵未完成 | **部分通过** |

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

## 5. 跨物理机 TURN 数据面：1 MiB 与双机 100 MiB 已通过，三物理 100 MiB 仍未通过

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

### 5.3 100 MiB P2P V2 双机已完成

Mac 作 seed、HSD 作 leecher，使用同一份确定性 100 MiB payload：

- 大小：104,857,600 bytes。
- SHA-256：`29bd2f6471aa2f9a8e1c909b7485001cd1396d41acc8758c48cebb77cea9fdb7`。
- info hash：`dd05f3b5768f2dc298bcccb2fa1533e8502f48b0`。
- 传输窗口：`2026-11-24T05:04:08.453Z` → `2026-11-24T05:07:09.961Z`，约 181.5 s。
- HSD leecher `ok:true`，`sha256_match:true`，peer `state=open`，`bytes_in=104,957,100`，`chunks_in=12,810`。

证据：HSD `C:\Users\AU\w2m-p7\.matrix\p7-physical\leech-hsd-turn.json`。

这是真正的 WebTorrent P2P V2 100 MiB，不是 Teams artifact，也不是 W2M relay 承载字节。

### 5.4 三物理 100 MiB P2P V2 矩阵未完成

尝试过的三条组合：

1. **Mac seed → HSD leecher**：完成，100 MiB，SHA 匹配。见 5.3。
2. **Mac seed → TOFUTURE leecher**：传输启动后到 3 MiB 左右停滞，`leech-tofuture.out` 无错误，结果 JSON 未生成。
3. **HSD seed → TOFUTURE leecher**：`payload.bin` 一直为 0 字节，结果 JSON 未生成。

证据：TOFUTURE `E:\DB\W2M\.matrix\p7-physical\leech-tofuture-hsd\dest\payload.bin` 为 0 bytes；`leech-tofuture-hsd.json` 未生成。Mac seed → TOFUTURE 的旧尝试停在约 3 MiB，`leech-tofuture` 结果 JSON 同样未生成。

TOFUTURE 的 attach/信令能建链：Mac seed 对 TOFUTURE 的 attach 曾成功，TOFUTURE 也确实开始下载到 3 MiB；但随后数据面不再推进。把 seed 换成 HSD 后仍是 0 字节，说明停点更可能在 TOFUTURE 侧的 WebTorrent 数据面/写盘，而不是单一 seed 的出口。当前证据不足以把它归因到 TURN；TURN 的 1 MiB 三条链路已经独立通过。

因此：

- P7 第 ⑤ 项的“三物理节点 100 MiB P2P V2 矩阵”**仍未通过**。
- 本次新增的是“公网 TURN 可用 + 三物理 1 MiB WebRTC 链路全 relay + 双机 100 MiB P2P V2”的证据，不能替代三物理 100 MiB 矩阵。
- 同机四进程、Cloudflare tunnel `/health`、W2M relay、Teams V2 本地 MVP 都不作为该子项的通过证据。

### 5.5 其余限制

1. 4 MiB 帧边界与安全拒绝仍是单元/协议层证据，不是跨机真实链路证据。
2. Windows 真实 provider 并发仍受 `WEBRTC_PROVIDER_SPAWN_FAILED: spawn UNKNOWN` 限制；本次同机矩阵取 Linux，跨物理机取 Windows/macOS 混合。
3. TOFUTURE 的 P2P V2 数据面停点需要继续查 provider 子进程、WebTorrent 写盘和 pool 状态；在查清前不改判第 ⑤ 项。
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
