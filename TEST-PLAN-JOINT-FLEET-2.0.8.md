# 联合开发 & 编队协作测试计划 v2.0.8

状态：执行中（v2.0.8 已发布，三机版本尚未统一）
基线：commit `0ecedb4c658914bbf3dd901419f11c4920b526d7` / npm `2.0.8`
配套用例：[TEST-CASES-JOINT-FLEET-2.0.8.md](TEST-CASES-JOINT-FLEET-2.0.8.md)

## 1. 目标与范围

验证两条主能力：

1. **联合开发（Joint Dev）**：计划 → Ed25519 人工审批 → relay 派发 → 执行 → 进度投影 → 审计 → 合并/回滚；
2. **编队协作（Fleet）**：设备发现/编队绑定 → 聊天 → 目标机选择 → 跨机派发 → 结果回收 → 文件 E2E。

新增 v2.0.8 专项：

- 编队绑定诊断 `w2m_status.fleet` 与 `FLEET_UNBOUND` 自动纠正；
- P2P 加密握手（ChaCha20-Poly1305 纯 JS 回退）；
- 文件传输 want-block / sender-receiver 双角色 / 候选地址探测；
- 八项发布门禁。

不在范围：relay 升级（保持 2.0.5）、CRDT（ADR only）、未发布客户端适配。

## 2. 环境与实例

| 实例 | 机器 | 角色 | 已知状态 |
|---|---|---|---|
| E1 | ToFuture `b53a37f4…` | 发射台 / 本机 | agent 2.0.8 在线，编队 004945，allowlist `["node"]` |
| E2 | DSH `1bef9935…` | 跨机执行 | 编队 004945；2026-10-30 曾离线，需先恢复 |
| E3 | macmini `b1b19d49…` | 跨机执行 | 2.0.7，allowlist 空，SSH 未开 |
| R1 | relay 43.142.74.71 | 主 relay | 2.0.5 冻结，features：target-machines/result-projection/chat-enc-v2 |
| R2 | relay 202.182.123.154 | 备用 relay | 仅备用链路，不参与主验收 |

名册口径（必须按此判定）：

- 真正在线：`online===true && offline_reason===null`；
- 版本未知：`caps.plugin_version` 缺失，**不等于旧版**；
- 全服设备数来自 `/healthz`，逐台版本只来自 `/v1/devices`（按编队过滤）。

## 3. 测试分层

| 层 | 内容 | 入口 |
|---|---|---|
| L0 静态 | lint、schema、claims、Skills、Agent Plugins | `node scripts/preflight.mjs` |
| L1 单元 | fleet-binding、chacha、xfer、joint、chat、version gate | `node --test test/<name>.test.mjs` |
| L2 契约 | MCP 工具、relay 路由、acceptance records | preflight 内建 |
| L3 单机 E2E | plan→approve→dispatch→progress→audit（同机） | `bin/w2m-joint.mjs` |
| L4 双机 E2E | 跨机派发、聊天、文件 sender/receiver | relay + 两机 |
| L5 发布门禁 | commit/tag/Release/npm/CI/Compat/Release workflow/healthz | GitHub + npm |

## 4. 进入/退出准则

进入：

- 代码冻结点明确（v2.0.8 commit）；
- preflight GREEN（允许 host 观测项 UNVERIFIABLE，但不允许 FAIL）；
- 主 relay 在线，E1 的 `fleet_id=004945`；
- E2/E3 至少一台可执行（allowlist 非空且在线）。

退出（视为通过）：

1. P0 用例 100%，P1 ≥95%，无 S1/S2 缺陷；
2. 联合开发：计划/审批/派发/审计/进度五段均有真实 relay 证据；
3. 编队：跨机任务 verdict=consistent 且签名有效；
4. P2P：跨机 `handshakes≥1`、`encrypted_channels≥1`、`refused=0`；
5. 文件：两机 rootCid 与落盘 SHA-256 一致，relay 无文件字节；
6. 八项发布门禁全绿，npm shasum 与 Release 资产一致；
7. 所有失败具名（错误码/机器/版本/relay）。

阻断判定：E2 离线或 E3 allowlist 为空时，L4 只能标 BLOCKED，不得用单机结果替代。

## 5. 执行顺序

1. 环境基线：三机版本、编队绑定、allowlist、relay 版本；
2. L0/L1：preflight + 新专项套件；
3. L3：联合开发单机闭环；
4. L4-A：编队聊天 + 目标选择 + 跨机派发；
5. L4-B：P2P 握手验证（只对非本机派发）；
6. L4-C：文件 E2E（sender/receiver + 候选地址）；
7. L5：发布门禁证据归档；
8. 失败项回归与报告。

## 6. 证据规则

- 每条用例记录：时间、机器、relay、版本、任务/ref ID、结果；
- 不把“代码已实现”当“现场通过”；
- 不接受自派发（ToFuture→ToFuture）作为 P2P 加密证据（设计为明文）；
- 版本证据必须同一时间窗采集：package.json / 进程启动时间 / relay caps 三者相差 ≤5 分钟；
- 敏感信息（token/key/聊天明文）不得进入证据。

## 7. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| DSH 离线 | 跨机全阻断 | 到场恢复；或先修 macmini allowlist |
| macmini 2.0.7 + allowlist 空 | 版本不齐/拒绝执行 | 本机升级 2.0.8、写入 allowlist 后重启 |
| stateDir:null | FLEET_UNPAIRED、结果回退 relay | 配置 stateDir 并重启宿主 |
| 名册 26 台 / 20 台版本未知 | 统计口径混乱 | 用 §2 口径；只统计 004945 |
| 自派发明文 | 误判握手失败 | 禁止作为 PH 证据 |
| 手工 tarball 与 npm 字节差异 | 版本证据弱 | 比对 npm shasum 与本地包 |
