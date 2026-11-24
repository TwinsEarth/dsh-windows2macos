# P7 关键补强验收（3.7.0）

- 分支：`work/v3.7.0-v2-baseline`
- P7 基线：`859422a`（P6 发布准备完毕）
- 验收日期：2026-11-24
- 结论：**P7 整体为“部分通过”**：第 1–4 项通过；第 5 项的同机四节点、100 MiB、多 seed、真实进程 kill 续传已通过；第 5 项的“三物理节点”子项因 NAT/TURN 未打通记为“未通过”，不计入整体通过。

## 1. 五项补强对照

| 项 | 要求 | 落地位置 | 验证 | 结论 |
| --- | --- | --- | --- | --- |
| ① | 把直接绑定 pool 的 adapter 抽成 `TorrentTransport` 接口，先注册 `webrtc-v1`，V2.0 不实现其他 transport | `src/agent/webtorrent/transports/registry.mjs`、`webrtc-v1.mjs`；`share/add/attach` 接受 `transport`，默认 `webrtc-v1`，未知名字返回 `P2P_V2_TRANSPORT_UNKNOWN` | `test/p2p-v2-p5.test.mjs`；P6 `test:p2p-v2` 57/57 | 通过 |
| ② | 多 seed / 多 leecher 生产级编排：部分 attach 失败不阻断、peer 去重、上限、swarm 状态 | `service.mjs` 的 `maxPeersPerShare`、`peers()`、`swarm` 摘要、`peer_errors`、`P2P_V2_PEERS_UNREACHABLE` | P2/P5 单元与集成；P7 四节点真实矩阵：一个 leecher 同时从两个 seed 拉取 | 通过 |
| ③ | 下载目录默认 `<dshHome>/p2p-v2/downloads`；路径越界、symlink、配额、半文件、断点恢复 | `downloadRoot` 默认 `<stateDir>/downloads`；`path-safety.mjs`；`.w2m-partial-<infoHash>` staging；`shares.json` 原子持久化；`status.restore` | `test/p2p-v2.test.mjs` 的 `PATH_OUTSIDE_ROOT` / `SENSITIVE_PATH`；`test/p2p-v2-p5-resume.test.mjs`；P7 真实进程 kill 续传 | 通过 |
| ④ | 同一 pair 上任务 JSON 与 torrent 帧混合流量回归 | `test/p2p-v2-dispatch-isolation.test.mjs`：`task.offer` JSON + tagged torrent 帧 + `result.ack` JSON；`pushOfferBestPath` 仍走 `webrtc-v1`；`TOOL_NAMES` 7 个且无 `task.*` | 3/3 通过（P4/P6 回归） | 通过 |
| ⑤ | 三节点以上真实矩阵、100 MiB、断线恢复、安全拒绝、4 MiB 帧边界 | P7 新增 `scripts/p7-v2-real-matrix.mjs`、`scripts/p7-v2-resume-matrix.mjs`；边界测试沿用 P5/P4 单元 | 四节点真实矩阵通过；真实进程 kill 续传通过；4 MiB/安全拒绝单元通过；跨物理机未通过 | **部分通过** |

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

## 5. 未通过项与限制

1. **跨物理机三节点以上 WebRTC 仍未打通。** VM seed 对 Mac leecher 的真实尝试在 30 s 内返回 `P2P_V2_PEERS_UNREACHABLE`，底层 `WEBRTC_CONNECT_TIMEOUT`；Cloudflare quick tunnel 的 `/health` 可达，但 DataChannel 未建立。加 openrelay 测试 TURN 仍未成功；仓库既有 DESKTOP 记录也表明现网 NAT 下无可用 TURN。
2. **Cloudflare tunnel 只解决 signaling 可达，不解决媒体路径。** 在 TURN 未打通前，没有可用于跨 NAT DataChannel 的媒体中继。
3. **W2M relay 不能承载 torrent 字节。** 它只承载 `task.offer` / `result.ack` / Teams / `view.*` 这类 JSON 控制帧；V2 文件字节不经过 relay，这是架构裁决边界，不是性能优化项。
4. 因此第 5 项的“三节点以上真实物理矩阵”不拿“同机四进程”冒充通过。P7 的四节点是**同机独立进程 + 真实 WebTorrent + 真实 node-datachannel + 真实信号服务器**，证明数据面与编排，不证明 NAT 穿透。
5. 4 MiB 帧边界与安全拒绝是单元/协议层证据，不是跨机真实链路证据。
6. Windows 真实 provider 并发仍受 `WEBRTC_PROVIDER_SPAWN_FAILED: spawn UNKNOWN` 限制，P7 矩阵取 Linux。

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
