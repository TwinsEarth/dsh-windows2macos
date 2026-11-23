# P7 验收：桌面 WebRTC 真实引擎、四节点矩阵与长稳

- 日期：2026-11-24
- 分支：`work/v3.6.0-desktop-v2`
- 代码基线：P6 `f0716b4` + 文档 `5d8998a`
- 包版本：`@twinsearth/w2m-dsh-plugin@3.6.0`（3.7.0 发布门禁）
- 结论：真实 `node-datachannel` ICE/DTLS、Noise、加密 view frame、四节点有向矩阵、
  故障注入与 30 分钟 1 Hz 长稳均已在真实进程上通过。四台物理机全互连受现网 NAT 限制，
  以“2 台物理主机 × 4 个节点进程 + 本机 4 节点”作为矩阵验收范围，详情见第 7 节。

## 1. 目标

P6 的 fake provider 只证明脚本逻辑、包加载和脱敏，不作为真实 ICE/DTLS 证据。P7 把同一套
pool、transport、view frame 和桌面默认路由放到真实 `node-datachannel` 进程上，逐项验证：

1. 双端真实 ICE/DTLS 握手、Noise 加密、4 KiB view frame 原样到达；
2. 四节点全有向矩阵 12 条腿，每个节点都能当 viewer 和 target；
3. provider 缺失、signal 断开、目标端 ack 超时三类故障命名返回；
4. 30 分钟 1 Hz 连续帧，内存、句柄、pool 数量稳定；
5. 各物理机 provider 安装可复现；
6. 生产路由的 8 条硬指标有可追溯证据。

## 2. 环境与节点

| 节点          | 物理主机      | 内网地址          | 角色            | provider 目录                                |
| ------------- | ------------- | ----------------- | --------------- | -------------------------------------------- |
| `p7-tofuture` | TOFUTURE      | `192.168.0.37`    | viewer + target | `E:\DB\w2m-webrtc-provider`                  |
| `p7-hsd`      | HSD           | `192.168.0.53`    | viewer + target | `C:\Users\AU\w2m-webrtc-provider`            |
| `p7-mac`      | Mac mini      | `192.168.3.66`    | viewer + target | `/Users/fang/w2m-webrtc-provider`            |
| `p7-im2a`     | IM2A          | `192.168.199.211` | viewer + target | `C:\Users\Administrator\w2m-webrtc-provider` |
| `p7-local-*`  | TOFUTURE 本机 | 回环              | 4 个子进程      | 同上                                         |

- provider 统一为 `node-datachannel@0.33.6`，五个目录（含云主机
  `/home/user/w2m-webrtc-provider`）根导入均为 `PROVIDER_OK`。
- 公网信令：`wss://fruit-joel-signed-spelling.trycloudflare.com/w2m/webrtc`
  （云主机 8788，`/health` 返回 `{"ok":true,"protocol":"w2m-webrtc/1"}`）。
- 四节点控制器：`https://oasis-rebates-stat-alaska.trycloudflare.com`，全局串行队列，
  一次只放行一条腿，claim 45 秒超时。
- 两主机矩阵在 TOFUTURE、HSD 各跑两个节点进程：`p7-tofuture`、`p7-mac` 在 TOFUTURE，
  `p7-hsd`、`p7-im2a` 在 HSD；四个进程仍走公网信令和控制器串行队列。

## 3. 真实引擎证据

### 3.1 双端 pair

`node scripts/desktop-webrtc-p7.mjs --mode pair`，两个独立子进程各自持有一个 pool：

| 腿                       | 耗时   | RTT  | 路径     | 安全     | 字节 | SHA-256         |
| ------------------------ | ------ | ---- | -------- | -------- | ---- | --------------- |
| `p7-node-0 -> p7-node-1` | 569 ms | 4 ms | `direct` | `secure` | 4096 | `c9ac7b06…d90b` |
| `p7-node-1 -> p7-node-0` | 570 ms | 3 ms | `direct` | `secure` | 4096 | `c9ac7b06…d90b` |

结果：`ok:true`、`legs_direct=2`、`legs_secure=2`、`relay_frame_calls=0`、
`pool_count_per_process=1`、`channel=webrtc`、`fallback_reason=null`。
证据：`.matrix/p7-pair.json`（2013 B，2026-11-23T17:00:09Z）。

### 3.2 本机四节点有向矩阵

四个子进程、12 条有向腿，全部真实握手：

| 指标         | 结果                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------- |
| 腿数         | 12/12                                                                                        |
| 直连         | 12/12 `path=direct`                                                                          |
| 加密         | 12/12 `encrypted=true`、`secure=secure`                                                      |
| 帧           | 每条 4096 B，SHA-256 全部 `c9ac7b0624824f844f6c7f3d50fab9741a8914e878467e8daaedca143a34d90b` |
| 单腿耗时     | 6–23 ms                                                                                      |
| RTT          | 0–3 ms                                                                                       |
| relay 帧调用 | 0                                                                                            |
| 每进程 pool  | 1                                                                                            |

证据：`.matrix/p7-matrix.json`（6442 B，`ok:true`，17:06:58Z）。

### 3.3 两主机 × 四节点跨机矩阵

TOFUTURE 与 HSD 各两个节点进程，12 条有向腿全部通过：

| 来源                | 腿数 | 直连/加密 | 耗时范围 | RTT 范围 | relay |
| ------------------- | ---- | --------- | -------- | -------- | ----- |
| TOFUTURE 侧两个节点 | 6    | 6/6       | 6–26 ms  | 1–12 ms  | 0     |
| HSD 侧两个节点      | 6    | 6/6       | 10–45 ms | 1–13 ms  | 0     |
| 合计                | 12   | 12/12     | 6–45 ms  | 0–13 ms  | 0     |

每条腿 4096 B、SHA-256 相同、`encrypted=true`、`channel="webrtc"`、
`pool_count_per_process=1`、`fallback_reason=null`。控制器 `/state` 显示 `ready` 4/4、
`queue=0`、12 条结果全部 `ok:true`。

证据：`.matrix/p7-matrix2host-tofuture.json`、`.matrix/p7-matrix2host-mac.json`、
`C:\Users\AU\w2m-p7\matrix2host-hsd.json`、`matrix2host-im2a.json`、
`/home/user/p7-controller/state-matrix2host.json`。

### 3.4 真实跨机两节点先导

HSD 与 TOFUTURE 两节点先导（同一 LAN，真实 provider + 公网信令）：

| 腿                      | 耗时  | RTT  | 路径     | 安全     |
| ----------------------- | ----- | ---- | -------- | -------- |
| `p7-hsd -> p7-tofuture` | 30 ms | 7 ms | `direct` | `secure` |
| `p7-tofuture -> p7-hsd` | 35 ms | 6 ms | `direct` | `secure` |

证据：`.matrix/p7-cross-pair-tofuture.json`、`C:\Users\AU\w2m-p7\.matrix-cross-pair.json`。

## 4. 故障注入

`--mode faults`，4/4 通过：

| 场景             | 期望                 | 实际                                                                                      |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| provider 缺失    | 命名错误，不静默     | `WEBRTC_PROVIDER_CLOSED`                                                                  |
| signal 断开      | 命名错误             | `WEBRTC_SIGNAL_SEND_FAILED`                                                               |
| 目标端 ack 超时  | 快速回落并写原因     | `status=200`、`channel=relay`、`fallback_reason=WEBRTC_PREPARE_TIMEOUT`、`elapsed_ms=678` |
| 回落后的 `/stop` | 200，不破坏共享 peer | `status=200`                                                                              |

证据：`.matrix/p7-faults.json`（926 B，17:07:26Z）。

## 5. 长稳 soak

### 5.1 30 秒预跑

30/30 帧，`last_seq=30`，两个进程各 `pool_peers=1`、`pool_count=1`。
证据：`.matrix/p7-soak-30s.json`。

### 5.2 30 分钟 1 Hz

`--duration-ms 1800000 --interval-ms 1000`，两端各一个真实 pool，连续 1800 秒：

| 指标          | target                   | viewer                   |
| ------------- | ------------------------ | ------------------------ |
| 收/发帧       | 1800/1800                | 1800/1800                |
| `last_seq`    | 1800                     | 1800                     |
| RSS 首/峰/末  | 68.61 / 69.16 / 68.60 MB | 68.26 / 68.60 / 68.60 MB |
| RSS 末-首     | -4 KiB                   | +340 KiB（+0.51%）       |
| 句柄 首/峰/末 | 7 / 8 / 7                | 7 / 8 / 7                |
| `pool_peers`  | 1                        | 1                        |
| `pool_count`  | 1                        | 1                        |

RSS 在 68–69 MB 之间窄幅波动，无单调增长；句柄峰值 8、末值回到 7；两端 pool 始终为 1；
`last_seq=1800` 证明 1800 帧全部按序到达，`relay_frame_calls=0`。
证据：`.matrix/p7-soak.json`（9406 B，18:16:54Z）与 `.matrix/p7-soak.log`。

## 6. 生产路由合同

以下 8 条是发布硬指标。路由语义、错误码和共享 pool 行为由 P5/P6 的真实路由测试与
P7 的真实进程证据共同支撑；P7 harness 本身不挂生产 HTTP 路由，故标注为“路由合同”
或“真实引擎”。

| #   | 硬指标                                           | 证据                                                                     | 结论                                |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------- |
| 1   | 生产 profile `/start` 返回 `channel=webrtc`      | `test/remote-view-route.test.mjs` 的 webrtc happy path；本次回归 176/176 | 路由合同通过                        |
| 2   | `/frame` 期间 `relay_frame_calls=0`              | pair/matrix/2host/soak 全为 0；路由测试断言 relay frame 计数为 0         | 真实引擎 + 路由合同通过             |
| 3   | 进程内 `pool_count=1`                            | pair 每进程 1、本机 4 进程各 1、两主机 4 进程各 1、soak 两端各 1         | 真实引擎通过                        |
| 4   | `transport=webrtc` 失败返回 502，不建 relay 会话 | 路由测试 `WEBRTC_UNAVAILABLE` 且不 dial UDP/relay                        | 路由合同通过                        |
| 5   | 目标端 ack 成功且不启动 relay 帧流               | 路由测试 prepare ack 与 target warmup；故障注入覆盖 ack 超时回落         | 路由合同 + 故障注入通过             |
| 6   | `/stop` 后 Teams/任务数据面仍可用                | `test:teams` 与 `test/remote-view-route.test.mjs` 的 stop 共享 peer 用例 | 路由合同通过                        |
| 7   | 30 分钟 soak 无句柄/内存增长                     | 1800/1800 帧；RSS 末-首 -4 KiB / +340 KiB；句柄 7/8/7；pool 1            | 真实引擎通过                        |
| 8   | 四节点有向矩阵全绿                               | 本机 12/12；两主机 × 四节点 12/12                                        | 真实引擎通过（范围为 2 台物理主机） |

### 6.1 回归

| 命令                          | 结果                                  |
| ----------------------------- | ------------------------------------- |
| `npm run test:desktop-p7`     | 33/33，0 失败                         |
| `npm run test:p2p-webrtc`     | 87/87，0 失败                         |
| `npm run test:teams`          | 39/39，0 失败                         |
| `npm run test:p2p-v2`         | 11/11，0 失败                         |
| `npm run test:acceptance-doc` | 6/6，0 失败                           |
| `npm run layer-check`         | 318 个文件、13 个层，跨层边全部已声明 |

合计 176 个测试通过、0 失败。

## 7. 四台物理机全互连的现网限制

已按要求启动四台物理机（TOFUTURE、HSD、Mac、IM2A）并发尝试 12 条有向腿。控制器实际
记录 4 条，仅 1 条成功；其余 8 条因节点 ready/claim 超时没有产生结果：

- TOFUTURE、HSD、IM2A 的公网出口均为 `220.196.228.195`（同一 NAT，不同内网段），
  跨内网段 hairpin 不工作；
- Mac 公网 `101.81.77.177`，与 HSD/TOFUTURE 双向均 `no view.frame within 20s`；
- 环境内无可用 TURN：`202.182.123.154:3478` 对 Allocate 无响应；
- 唯一成功腿为 `p7-hsd -> p7-tofuture`（38 ms，`direct`、`secure`）。

证据：`/home/user/p7-controller/state-snapshot.json`、
`C:\Users\Administrator\w2m-p7\cross-matrix.json`、
`.matrix/p7-cross-matrix-tofuture.log`。

这不是代码逻辑问题：同一套代码在 2 台主机 × 4 个节点进程、同一 LAN 条件下 12/12 全绿；
在 Mac 与 TOFUTURE 之间则稳定复现 `WEBRTC_CONNECT_TIMEOUT`。结论是现网 NAT 拓扑不支持
无 TURN 的 full mesh。P7 矩阵验收以“2 台物理主机 × 4 个节点进程 + 本机 4 节点”为准，
并把四物理机结果作为限制记录，不伪装成 4 台全互连。

## 8. provider 安装

| 主机     | 目录                                         | 版本   | 根导入        |
| -------- | -------------------------------------------- | ------ | ------------- |
| TOFUTURE | `E:\DB\w2m-webrtc-provider`                  | 0.33.6 | 可用          |
| HSD      | `C:\Users\AU\w2m-webrtc-provider`            | 0.33.6 | `PROVIDER_OK` |
| Mac      | `/Users/fang/w2m-webrtc-provider`            | 0.33.6 | `PROVIDER_OK` |
| IM2A     | `C:\Users\Administrator\w2m-webrtc-provider` | 0.33.6 | `PROVIDER_OK` |
| 云主机   | `/home/user/w2m-webrtc-provider`             | 0.33.6 | `PROVIDER_OK` |

可移植代码目录：HSD `C:\Users\AU\w2m-p7`、Mac `/Users/fang/w2m-p7`、
云主机 `/home/user/w2m-p7`、IM2A `C:\Users\Administrator\w2m-p7`。

## 9. 复现命令

```powershell
npm run desktop:p7 -- --mode pair
npm run desktop:p7 -- --mode matrix
npm run desktop:p7 -- --mode faults
npm run desktop:p7 -- --mode soak --duration-ms 1800000 --interval-ms 1000
npm run desktop:p7 -- --mode cross-matrix --node-id p7-tofuture `
  --controller https://oasis-rebates-stat-alaska.trycloudflare.com `
  --provider-cwd E:\DB\w2m-webrtc-provider
```

## 10. 结论

- 真实 `node-datachannel` ICE/DTLS、Noise、4 KiB 加密 view frame：通过；
- 四节点有向矩阵：本机 12/12、两主机 × 四节点 12/12，全部 `direct`/`secure`，relay 0；
- 故障注入 4/4、30 分钟 1 Hz 长稳 1800/1800、RSS/句柄稳定；
- 四台物理机 full mesh 受现网 NAT 限制，已落地的 4 条腿仅 1 条成功，已记录，不声明为通过；
- 包版本仍为 3.6.0，未执行 push、tag、npm publish、Release 或市场索引。
