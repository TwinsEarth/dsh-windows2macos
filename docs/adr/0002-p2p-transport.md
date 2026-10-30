# ADR 0002: P2P 传输路线（iroh 优先 + 多方案并行）

状态：Accepted（2026-10-30）
关联：ADR 0001（CRDT）、TRANSFER-LAYER.md、TEST-PLAN-JOINT-FLEET-2.0.8.md

## 决策

1. **传输抽象先行**：定义 `P2PTransport`（start/stop/send/onMessage/paths/diagnostics），
   现有 UDP 实现为 `udp-v1`，iroh 为 `iroh-v1`，libp2p 仅作候选发现。
2. **iroh 优先，但不阻塞 UDP**：双方都声明 `p2p.transports` 时并行起跑，首个完成
   加密握手 + 首帧 ACK 的路径胜出；总预算 ≤3s；失败具名，不静默回退。
3. **iroh 以 sidecar 集成**：不把原生 addon 加载进 Electron 主进程；子进程 IPC，
   失败/超时可单独回滚；默认分发仍可只带 UDP。
4. **自建 iroh-relay（TLS 域名 + 80/443 + ACME）**：作为可选基础设施；
   不复用 8787 relay，不修改 relay 2.0.5。
5. **中继语义边界**：允许 DERP 式**密文转发**；relay 不得解密、不得落盘、
   不得记录内容；仅保留必要的连接元数据与速率限制。
6. **平台范围**：Apple Silicon macOS 为唯一 macOS 目标；不支持 Intel Mac；
   不因 Intel 预编译缺失而阻塞 iroh 路线。
7. **身份**：iroh `EndpointId`（Ed25519）与现有 `device.key`（X25519）独立派生：
   `hkdf(seed, 'iroh-ed25519')`；通过 offer 的 `p2p.iroh_ids` 交换，relay 不改协议。
8. **数据面与文件层解耦**：iroh/UDP 只替换传输；`xfer.want/chunk`、Merkle、
   ArtifactRef 语义保持不变。

## 立即优先级（在 iroh 之前）

- P0-a：chunk 帧接入 `P2PChannel`，不再裸 `dgram.send`；
- P0-b：`onAck` 触发 `pump()`，窗口随 ACK/BDP 推进（当前 0.12 MiB/s 的结构性上限）；
- P0-c：`verifyRefV2` 自洽校验 + 统一两套 v2 ref；
- P1：SHA-256 Merkle 树（逐块证明，作为多源准入条件）；
- 之后才是 iroh sidecar 时间盒。

## 验收

| 指标 | 目标 |
|---|---|
| 加密覆盖率 | 同版本、双方有 key：100% |
| 跨机直连率 | 同 LAN ≥90%，跨网 ≥70% |
| 首帧时延 p95 | 直连 <300ms |
| 中继边界 | relay 无明文、无落盘、无内容日志 |
| 回滚 | `p2p.transports=['udp']` 即回退，无需重装 |
| 平台 | macOS arm64 + Windows x64 通过；Intel Mac 明确不支持 |

## 方案定位（冻结）

| 方案 | 定位 | 优势 | 短板 | 是否进入数据面 |
|---|---|---|---|---|
| **iroh** | 首选、高打洞成功率 | QUIC 原生打洞、DERP 回落、路径选择、加密/重传内建 | 需 sidecar + 自建 TLS relay；JS 绑定/原生二进制 | ✅ 是 |
| **现有 UDP** | 默认兜底、零新增依赖 | 已有加密栈、wire 兼容、无新进程 | 可靠性仍缺 RTT 采样/拥塞控制/PMTU | ✅ 是 |
| **libp2p** | 可选“全家桶”参照 | 模块化、DHT 发现、多传输 | 打洞率约 70%、依赖重、复杂度高 | ❌ 否，仅发现层 |

规则：

1. 数据面只允许 `iroh` 与 `udp`；`libp2p` 不得接管 send/ACK/加密；
2. libp2p 只作为 `discovery` provider（DHT/mDNS）产出候选，候选仍需 relay/offer 身份校验；
3. 未声明 iroh 的对端只走 UDP，行为与 v2.0.8 一致；
4. 竞速失败返回 `ALL_TRANSPORTS_FAILED`，数据面不回落 relay；
5. 发现层依赖放 sidecar，服务端 `dependencies` 保持为空；
6. DHT 记录必须签名，失败丢弃并记 `DHT_RECORD_INVALID`。

## 风险

- iroh JS 绑定滞后（npm 1.2.0 vs 上游 1.4.1）：sidecar 锁版本；
- 自建 relay 的域名/证书/CN→JP RTT：上线前实测；
- sidecar 崩溃/升级：独立进程 + 健康检查 + 自动回退 UDP；
- 多源投毒：Merkle 未验收前禁止开多源；
- 中继流量合规：只转发密文、限速、不记内容，写入运维文档。
