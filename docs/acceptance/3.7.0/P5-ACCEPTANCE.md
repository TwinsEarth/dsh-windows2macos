# P5 验收与跨机矩阵（3.7.0）

- 分支：`work/v3.7.0-v2-baseline`
- P5 起点：`24a1a5e`（P4 任务分发隔离）
- 验收日期：2026-11-24
- 结论：**部分通过**。本地真实引擎、真实 provider、四进程 2 seed + 2 leecher、100 MiB 已有可复现证据；跨机三节点 V2 文件面与真实断线续传尚未完成，不计为通过。

## 1. 验收表

| 层级 | 用例 | 证据 | 结果 |
| --- | --- | --- | --- |
| 单元 | multiplex / adapter / registry 11+ | `test/p2p-v2-p5.test.mjs`：18/18 | 通过 |
| 单元（回归） | P2 + P4 + P5 套件 | 5 个文件合并：57/57 | 通过 |
| 集成 | 3 节点、2 seed + 2 leecher，每个 leecher 完整文件 SHA 一致 | `test/p2p-v2-p5-integration.test.mjs`：4 个 service、4 个 transport binding、1 MiB、两个 leecher SHA-256 均等于源 | 通过（确定性引擎/字节面） |
| 集成（真实） | 2 seed + 2 leecher + 真实 WebTorrent 3.0.21 + 真实 node-datachannel | `scripts/p5-v2-local-matrix.mjs`，Windows 四进程，错峰两对，1 MiB；`summary.json` `ok:true`，两个 leecher SHA 均为 `4331f6fd...fcf94e2` | 通过（每对一 seed 一 leecher，未验证单 leecher 同时从两个 seed 拉取） |
| 真实引擎 | 256 KiB / 1 MiB 逐字节一致 | Windows `test/p2p-v2-p5-live.mjs`：2 pass / 1 skipped | 通过 |
| 真实引擎 | 100 MiB + 进度 + RSS 有界 | Linux 云主机 `test/p2p-v2-p5-live.mjs`：3/3，含 100 MiB 行，约 3.93 s；Windows 因宿主 commit 限额不足未跑完 | 通过（Linux） |
| 混合流量 | task JSON + torrent 同时跑，无 JSON 误判、无 V2 orphan | `test/p2p-v2-dispatch-isolation.test.mjs`：3/3；`p2p-v2.test.mjs` 覆盖 orphan/帧计数 | 通过 |
| 断线 | 中途停止 leecher 后重启，从已下载 piece 继续，不重复全量 | `test/p2p-v2-p5-resume.test.mjs`：第一段写 512 KiB 后停止、目标目录无半文件、staging 保留；新 service 只追加缺失 512 KiB，`written == 1 MiB`、`starts == 2`、最终 SHA 一致 | 通过（service 层进程重启续传；真实 socket kill 未覆盖） |
| 大文件 | 100 MiB，内存不随文件线性增长，进度可查 | Linux live：100 MiB 流式源文件 + 流式 SHA，RSS 断言 < 256 MiB；进度样本 ≥ 2 且单调 | 通过（Linux） |
| 安全 | 路径越界、敏感路径、坏 hash，命名拒绝、不写盘 | `p2p-v2.test.mjs`：`PATH_OUTSIDE_ROOT`、`SENSITIVE_PATH`、bad magnet/hash、staging 不落盘 | 通过 |
| 兼容 | 旧 V1 pair / 无 WebTorrent engine | `p2p-v2.test.mjs`：`P2P_V2_WEBTORRENT_UNAVAILABLE` 命名缺失；P4 `test:p2p-webrtc-deliver` / `dispatch` 仍 8/8 | 通过（P4 证据） |
| 跨机 | Windows + Mac + Linux，三节点两两 view/dispatch/file | P5 V2 文件面未执行。早前四节点 Teams artifact 数据面矩阵（CloudHost、MacMini、IM2A、HSD，12 条有向链路）只能证明 W2M Teams 数据面，不能替代 V2 文件面 | **未通过 / 未执行** |

## 2. 关键命令与结果

### 2.1 单元

```powershell
node --test --test-force-exit test/p2p-v2-p5.test.mjs
# tests 18, pass 18, fail 0
```

### 2.2 P2 + P4 + P5 合并

```powershell
node --test --test-force-exit --test-concurrency=1 `
  test/p2p-v2.test.mjs `
  test/p2p-v2-dispatch-isolation.test.mjs `
  test/p2p-v2-p5.test.mjs `
  test/p2p-v2-p5-integration.test.mjs `
  test/p2p-v2-p5-resume.test.mjs
# tests 57, pass 57, fail 0
```

### 2.3 确定性 2 seed + 2 leecher

```powershell
node --test --test-force-exit test/p2p-v2-p5-integration.test.mjs
# 1 MiB, 4 service, 4 binding, two SHA-256 equal to source
```

说明：该行使用确定性内容引擎与确定性字节面，隔离四项设备、四个绑定、staging/finalize 与 SHA 断言；真实 WebTorrent 与真实 node-datachannel 单独由 2.4 / 2.5 覆盖。

### 2.4 重启续传

```powershell
node --test --test-force-exit test/p2p-v2-p5-resume.test.mjs
# 1 test, 1 pass
# first add writes 512 KiB, service restart, second add appends 512 KiB only
```

### 2.5 真实引擎 256 KiB / 1 MiB

```powershell
$env:W2M_WEBTORRENT_MODULE='E:\DB\w2m-webtorrent-3.0.21\node_modules\webtorrent\index.js'
node --test --test-force-exit test/p2p-v2-p5-live.mjs
# 256 KiB pass, 1 MiB pass, 100 MiB skipped
```

### 2.6 真实引擎 100 MiB（Linux）

```bash
W2M_WEBTORRENT_MODULE=/tmp/w2m-p5/node_modules/webtorrent/index.js \
W2M_P5_LARGE=1 \
/opt/nodejs/22/bin/node test/p2p-v2-p5-live.mjs
# 3 tests, 3 pass; 100 MiB row 3.93 s; progress >= 2 samples; RSS growth < 256 MiB
```

Windows 宿主当前 `Committed Bytes ≈ 33.6 GiB / Commit Limit ≈ 34.0 GiB`，剩余 commit 不足以启动 100 MiB 的 WebTorrent + 假网络排队；同一测试在 Linux 上通过，因此该行证据取 Linux。

### 2.7 真实 provider 四进程 2 seed + 2 leecher（Windows）

```powershell
$env:W2M_WEBTORRENT_MODULE='E:\DB\w2m-webtorrent-3.0.21\node_modules\webtorrent\index.js'
node scripts/p5-v2-local-matrix.mjs `
  --signal ws://127.0.0.1:8788/w2m/webrtc `
  --work E:\DB\W2M\.matrix\p5-local-2seed2leech-stagger2 `
  --bytes 1048576 --timeout-ms 180000
# ok:true
# info hash fdebc6a7cb3e8a22c55ba18456767a8768d1cd09
# sha256 4331f6fd59299bea143d32f6cd62fad04cda8571f354179a88e380835fcf94e2
# node-3 / node-4 bytes 1048576, peer state open
```

为避免 Windows 同时创建多个 node-datachannel provider 时的 `spawn UNKNOWN`，矩阵按 60 s 错峰启动两对；每一对是一 seed + 一 leecher。两个 seed 均提供同一 info hash，但“单个 leecher 同时连接两个 seed 拉取”在真实 provider 下仍未验证。

### 2.8 混合流量回归

```powershell
node --test --test-force-exit test/p2p-v2-dispatch-isolation.test.mjs
# tests 3, pass 3
```

## 3. 已知限制与未完成项

1. **跨机 V2 文件面未执行**。需要公共可达 signaling（现有 `ws://43.142.74.71:8790` 握手 401）以及 Windows / Mac / Linux 三端同一分支运行时。早前 Teams 四节点矩阵不是 P2P V2 文件面，不能替代。
2. **真实 socket 断线未覆盖**。`p2p-v2-p5-resume.test.mjs` 证明 service 层：半文件保留、稳定 staging、重启后只追加缺字节、最终 SHA 一致；但没有在传输中途 kill node-datachannel/WebTorrent 进程并重连，真实 ICE/DataChannel 断线重连仍属未验证。
3. **真实 provider 并发上限**。Windows 同时生成两个 provider 进程会得到 `WEBRTC_PROVIDER_SPAWN_FAILED: spawn UNKNOWN`；错峰后两对均成功。根因未定位到 Node/Windows 进程创建限制还是 node-datachannel 0.29 原生资源竞争。
4. **单 leecher 多 seed swarm 未验证**。真实矩阵为每 leecher 指定一个 seed；P2 的多 seed 编排只在 deterministic fake engine 覆盖。
5. **Windows 100 MiB 受宿主 commit 限额**。Linux 已通过，不把 Windows 的宿主限制记为产品失败。

## 4. 产物

- `test/p2p-v2-p5.test.mjs`：18 个 multiplex / adapter / registry 单元。
- `test/p2p-v2-p5-integration.test.mjs`：4 service、2 seed + 2 leecher、SHA 一致。
- `test/p2p-v2-p5-resume.test.mjs`：半文件 → 重启 → 只追加缺字节 → SHA 一致。
- `test/p2p-v2-p5-live.mjs`：真实 WebTorrent 256 KiB / 1 MiB / 100 MiB；`W2M_P5_LARGE=1` 开启大文件，`W2M_P5_ONLY_LARGE=1` 单独跑大文件。
- `scripts/p5-v2-worker.mjs`：单节点真实 WebTorrent + 真实 node-datachannel worker。
- `scripts/p5-v2-local-matrix.mjs`：四进程 2 seed + 2 leecher 编排；错峰 60 s。
- `package.json`：`test:p2p-v2` 纳入 P5 单元与集成；新增 `test:p2p-v2-p5`、`test:p2p-v2-p5-live`。
- 证据目录：`E:\DB\W2M\.matrix\p5-local-2seed2leech-stagger2\summary.json`（本机）；Linux `/tmp/w2m-p5` 为临时运行副本，不作为仓库产物。
