# P0 基线记录 — desktop WebRTC / P2P V2

日期：2026-11-23  
工作树：`E:\DB\W2M`  
分支：`work/v3.6.0-desktop-v2`  
基线提交：`ef881193b97891819f48c503ea20373541755e9b`  
父提交：`77ca04d7a03155a10b4133985692edab0fe54893`（`work/v3.4.6`）  
package 版本：`3.6.0`

## 隔离内容

本次 checkpoint 将此前未提交的 3.6.0 远程桌面共享 WebRTC 路径与 P2P V2 WebTorrent-over-WebRTC 原型固定在同一提交，避免后续生产化改动与旧改动混杂：

- 远程桌面 viewer/target 共享池、relay ack、三态 transport 与测试
- P2P V2 子插件、WebTorrent 适配器、标签复用层、6 工具与接线
- 设计文档、3.6.0 验收记录与 V2 可选真实 WebTorrent 测试

提交统计：31 files changed, 4296 insertions(+), 137 deletions(-)。

## 基线测试

| 套件 | 结果 |
|---|---|
| `test/p2p-v2.test.mjs` | 11/11 |
| `test/remote-view-route.test.mjs` | 12/12 |
| `test/remote-requests.test.mjs` | 5/5 |
| `test/relay-phase2-server.test.mjs` | 12/12 |
| 上述四套件合计 | 40/40，0 skipped |
| `test/p2p-v2-live.mjs`（`W2M_WEBTORRENT_MODULE` 指向 webtorrent 3.0.21） | 1/1 |

## 已知边界

- 本机 Windows 的 `npm test` 单条命令超过 8191 字符上限（当前脚本约 9773 字符），测试进程未启动；这是本地测试编排问题，不是套件失败。
- `p2p-v2-live` 使用真实 WebTorrent 与真实 V1 pool/signaling/Noise，但 WebRTC engine 为 fake；尚无两台真实机器的跨机 ICE/DataChannel 矩阵。
- 多对多仍是显式 `peers` 列表；没有 fleet roster 自动发现和目标端自动接受文件写入。
- 未执行 `git push`、`git tag`、npm publish、GitHub Release 或市场索引；分支无 upstream，工作树干净。

## P0 结论

基线已隔离并可回退到 `77ca04d`；后续 P1 transport 抽象和 P2 多 peer 编排从 `work/v3.6.0-desktop-v2` 的 `ef88119` 继续。
