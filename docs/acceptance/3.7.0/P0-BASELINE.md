# P0 基线冻结 — V2 生产化（目标 3.7.0）

日期：2026-11-24  
工作树：`E:\DB\W2M`  
分支：`work/v3.7.0-v2-baseline`  
代码基线提交：`3fb1ed0020679cc4f9a2c18b327deaf8aadf840c`（`fix(ci): run the declared suite through an argv spawner on Windows`）  
本记录提交：`d3bdbfd`（只增加本文档，不改变代码）  
基线 tag：`v3.6.0` 指向代码基线提交  
package 版本：`3.6.0`

## 冻结范围

当前 V2 与 3.6.0 的全部改动已经在提交 `3fb1ed0` 中，工作树干净，没有未提交改动，也没有需要 stash 的内容。本分支从该提交拉出，作为 3.7.0 生产化的可回退基线：

- P2P V2：WebTorrent-over-WebRTC 原型、`p2p-v2` 子插件、标签复用层、6 个工具与接线。
- 远程桌面：共享 `WebRtcTransportPool`、relay `/v1/remote/ack`、`transport=auto|webrtc|relay` 三态与失败语义。
- 3.6.0 发布门禁修复：`WORKSPACE.md` 过期排除、备份镜像 realpath、compat 归档探针、Windows CI 命令行 spawner。

## 基线测试

| 套件 | 结果 | 日志 |
|---|---|---|
| `node --test --test-force-exit test/p2p-v2.test.mjs` | **11/11，0 fail，0 skip** | `.matrix/baseline-370/p2p-v2.log` |
| `test/p2p-v2-live.mjs`（`W2M_WEBTORRENT_MODULE` 指向 webtorrent 3.0.21） | **1/1，0 fail，0 skip** | `.matrix/baseline-370/p2p-v2-live.log` |
| `npm run test:p2p-webrtc` | **87/87，0 fail，0 skip** | `.matrix/baseline-370/p2p-webrtc.log` |
| `npm run test:teams` | **39/39，0 fail，0 skip** | `.matrix/baseline-370/teams.log` |
| remote-view 组（`remote-view-route` + `remote-requests` + `relay-phase2-server`） | **35/35，0 fail，0 skip** | `.matrix/baseline-370/remote-view.log` |
| 合计 | **173/173，0 fail，0 skip** |  |

真实 WebTorrent 的安装位置：`E:\DB\w2m-webtorrent-3.0.21\node_modules\webtorrent\index.js`（`webtorrent@3.0.21`，仅用于 live 套件，不是运行时依赖）。

仓库没有名为 `test:remote-view` 的 npm script；本记录用的是 remote-view 的三个直接套件，命令已在上表写明。

## 版本策略

- 当前 5 个版本清单（`package.json`、`plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`codex/mcp-servers.toml`）仍是 **3.6.0**。这是已打 `v3.6.0` tag 的产物版本，P0 冻结的是同一份代码，基线提交不改号。
- **V2 生产版目标版本：3.7.0**。3.7.0 的版本 bump 在 P1 开始时统一改上述 5 个清单并新增 `CHANGELOG.md` 条目；P0 不提前占用 3.7.0，避免基线与正在等待 Stable 审批的 3.6.0 资产不一致。

## 已知边界

- `p2p-v2-live` 使用真实 WebTorrent、真实 V1 pool/signaling/Noise，但 WebRTC engine 仍是确定性 fake；尚无两台真实机器的跨机 ICE/DataChannel 矩阵。
- 多对多仍是显式 `peers` 列表；没有 fleet roster 自动发现和目标端自动接受文件写入。
- 本机 Windows 的 `npm test` 单条命令仍超过 `cmd.exe` 8191 字符上限；CI 的 Windows leg 已改为 `scripts/run-declared-tests.mjs` 的 argv 方式，本地请直接跑套件或该脚本。
- `windows-latest / node 20` 的备份套件因 `zlib.zstdCompressSync`（Node ≥22.15）失败；这是版本下限与实际能力的既有不一致，V2 生产化需要单独决策，不在 P0 基线里掩盖。

## P0 结论

基线已冻结在 `3fb1ed0`，173/173 全部通过；后续 V2 生产化从 `work/v3.7.0-v2-baseline` 继续，可随时回退到该提交。
