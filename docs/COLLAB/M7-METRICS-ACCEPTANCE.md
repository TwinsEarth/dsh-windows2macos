# M7 指标与验收设计规格

> 状态：**设计稿**。只定义指标口径、验收体系与门禁，不含实现。
> 版本：`1.3.8-beta.*`（GitHub prerelease，不入 npm）。
> 上游：`docs/MULTI-MACHINE-COLLABORATION-PLAN.md` M7；覆盖 M1–M6 与三个模型（v1.4.x）的验收。

---

## 1. 目标与非目标

### 目标

1. **每个能力都必须能被真实任务触发**：不允许"单测过了就算完成"；验收记录必须能追溯到具体 task_id、机器、时间、ledger 区间。
2. **负向测试是必选项**：每个模块的错误码都必须有一条自动化用例证明"该拒绝时确实拒绝，且没有副作用"。
3. **指标统一口径**：任务成功率、重试/重派、分块断点、outbox、事件延迟、锁冲突、审查时效、合并冲突、P2P 成功率等，全部由 relay 真实数据计算，不靠客户端自报。
4. **门禁可执行**：preflight 增加"验收证据存在且可校验"的检查；beta 与 stable 的验收门槛不同，写死为门禁而不是口头约定。
5. **证据可留存、可复现**：验收产物（evidence）进仓库固定目录，含命令、结果、sha、ledger 区间，后续版本可回放核对。

### 非目标

- 不做外部 APM/监控平台接入（本版本只暴露指标 + 本地快照）。
- 不做性能压测基线（M7 只做正确性与混沌验收；吞吐性能另立）。
- 不追求 100% 自动化真实机器测试（允许"人工执行 + 证据上传"，但证据格式与校验必须统一）。

---

## 2. "真实任务可触发"的定义（验收硬标准）

一条能力算通过，必须同时满足：

```
1. 存在一个真实 task_id（relay 可查、结果可复现）
2. 涉及 ≥1 台真实机器（不是进程内 mock；单机能力可 1 台）
3. 结果通过 relay 聚合可验证（outcome/status/字段断言）
4. sanitized 证据入仓库：docs/acceptance/<version>/<case>.json + 关联 artifact
5. 负向用例证明"拒绝路径正确且无副作用"（head/任务/文件未变）
6. 能在另一台机器/另一时间重跑（命令、版本、前置条件齐全）
```

证据文件格式（统一）：

```json
{
  "version": "1.3.2-beta.1",
  "case": "M1-UPDATE-EMPTY-ALLOWLIST",
  "kind": "positive|negative|chaos",
  "requirement": "空 allow-list 机器远程升级",
  "machines": ["1c14d7d2-…", "6c92b251-…"],
  "commands": [["node", "bin/w2m-maintenance.mjs", "--only-check"]],
  "task_id": "01M6…",
  "ledger_seq": [100, 104],
  "result": { "outcome": "ok", "assertions": { "version": "1.3.2-beta.1" } },
  "artifacts": [{ "sha256": "…", "bytes": 1234 }],
  "executed_at": "2026-10-21T14:00:00Z",
  "executor": "lead|human",
  "reproduce": "docs/acceptance/<version>/RUNBOOK.md#M1-UPDATE-EMPTY-ALLOWLIST"
}
```

---

## 3. 指标口径（统一由 relay 计算）

### 3.1 任务与调度

```
wm_tasks_total{status, mode}
wm_task_duration_ms{status, mode}         p50/p95/p99（直方图）
wm_task_requeued_total                   重派发次数（reconnect/lease 过期）
wm_lease_expired_total{reason}
wm_result_duplicate_total                重复结果被去重的次数（应为 0 效果、>0 收到）
wm_dependency_released_total
```

### 3.2 授权（M1/M2）

```
wm_grant_issued_total{machine_scope}
wm_grant_denied_total{code}              各 GRANT_* 拒绝码计数
wm_grant_expired_total
wm_maintenance_requests_total{action,outcome}
wm_maintenance_rollback_total
```

### 3.3 数据面（M3/M6）

```
wm_blob_upload_sessions_total{state}
wm_blob_chunks_total{retried}
wm_blob_resume_total
wm_blob_bytes_total{mode}
wm_blob_sha_mismatch_total
wm_agent_outbox_depth
wm_agent_outbox_dropped_total
wm_worktree_active / wm_worktree_cleaned_total
wm_merge_queue_depth{project,branch}
wm_merge_conflict_total
wm_merge_merged_total
```

### 3.4 协作（M4/M5）

```
wm_project_events_total{type}
wm_event_lag_ms{client}                  客户端应用时间 - 事件时间（p95）
wm_sse_reconnects_total
wm_lock_acquired_total{kind} / wm_lock_conflict_total / wm_lock_force_released_total
wm_review_pending / wm_review_decision_total{decision}
wm_review_latency_ms                     创建→首个结论（p95）
wm_notification_sent_total{kind} / wm_notification_digest_total / wm_notification_unread
```

### 3.5 传输（M6）

```
wm_p2p_push_attempts_total / wm_p2p_push_success_total / wm_p2p_fallback_total
wm_p2p_crypto_refusals_total
wm_relay_restarts_total（relay 启动时从持久化文件推断或写入）
```

### 3.6 暴露方式

- `GET /metrics`（Prometheus 文本格式，已有路由形态可复用）或 `w2m_stats` 聚合视图。
- 指标只存计数器/直方图聚合（内存 + 定期快照到 state），不存原始事件。
- 标签基数限制：machine_id 可入标签，task_id 不入（避免爆炸）。

---

## 4. 验收体系分层

| 层 | 名称 | 运行环境 | 强制程度 |
|---|---|---|---|
| L0 | 单元/纯函数 | 任意 | beta 必过（已有 node --test） |
| L1 | 组件集成 | 本地 fake relay + 真 agent 进程 | beta 必过 |
| L2 | 真实任务 | 编队真机（jp-shared / TwinsEarth / macmini / ToFuture） | beta 子集、stable 全量 |
| L3 | 混沌 | 本地/真机断网、杀进程、重启、配额 | beta 抽测、stable 必过 |
| N | 负向矩阵 | 随每模块交付 | 全部版本必过 |

---

## 5. 验收矩阵（按版本）

| 版本 | 模块 | L2 正向（真实任务） | N 负向（必须自动化） | L3 混沌 |
|---|---|---|---|---|
| 1.3.2-beta | M1 | 空 allow-list 机器远程 update/restart/diag；relay 升级 | 未签/错签/过期/换机/重放/越界 action/sha 不符/包内版本不符/篡改 | 升级中断回滚；relay 重启后恢复 |
| 1.3.3-beta | M2 | 空 allow-list 执行 node -e；多机 grant；撤销生效 | GRANT_* 全矩阵；重放；超 max_uses；旧 agent | 撤销后立即拒绝；重启后计数保留 |
| 1.3.4-beta | M3 | 两机并行改不同文件 → 合并；同文件 → MERGE_CONFLICT | 篡改 patch/写 .git/非合并器/force push/中断恢复 | 合并中断后锁恢复；重放幂等 |
| 1.3.5-beta | M4 | 双客户端同任务板/制品/决策；断线补齐 | 非成员/observer 越权/seq 缺口/重复事件 | relay 重启 seq 连续 |
| 1.3.6-beta | M5 | 锁冲突/过期/强制释放；审查通过/拒绝；离线通知补齐 | 并发抢锁/非 holder/自审/重复结论/通知风暴 | 锁过期重入；通知限流不丢 |
| 1.3.7-beta | M6 | 40MiB 分块上传下载；断点续传；outbox 恢复 | BLOB_* 全矩阵；outbox 满；P2P 明文回落 | relay/agent 重启；断网 30/60s |
| 1.3.8-beta | M7 | 验收证据可执行、指标可读；跑一遍前六项 | 证据缺失/伪造/过期 → preflight 拒绝 | 指标在混沌下保持单调/无倒挂 |

---

## 6. 测试与混沌基础设施

### 6.1 本地

- **fake relay**（已有 `startFakeRabbit`）：L1 用；扩展支持 blob-sessions/项目房间路由。
- **双机 harness**（已有 `test/agent.test.mjs` 与部署脚本）：L1 两 agent + 一个 relay。
- **chaos 工具**（新增，纯 JS 优先，避免外部依赖）：
  - `pause(agent)` / `kill(agent)` / `kill relay`（进程级）
  - 网络中断：本地代理（node net server 转发，可主动断开）模拟断网/丢包/慢速
  - 时钟偏移：注入 `now()`（部分模块已支持）
  - 配额耗尽：直接填满 blob/outbox/锁上限
- 所有 chaos 用例必须有确定性断言（轮询超时而非 sleep 固定值）。

### 6.2 真机（L2）

- 机器池：`jp-shared`（Linux）、`TwinsEarth`（Windows）、`macmini`（macOS）、`ToFuture`（Windows）。
- 前置：M1/M2 完成后通过 grant 授权执行；不能在验收中放宽 allow-list（验收本身要证明"不放宽也能做"）。
- 数据安全：M3 验收使用**临时测试仓库**（本地 bare 或专用 demo repo），不碰本插件发布仓库的 main。
- 清理：验收后停服务/删临时 worktree/撤销 grant，脚本化。

---

## 7. 门禁集成（preflight 扩展）

新增检查项（注册进 preflight 的 15 项清单，替换/扩展现有"declared suite"）：

```
1. acceptance-evidence：docs/acceptance/<current_version>/ 存在；每个 case JSON 通过 schema 校验；
   task_id 能在当前 ledger/relay 中查到（或标记 archived 并带哈希）；artifact sha 可下载且匹配。
2. negative-matrix：每个已声明错误码在证据中有至少一条 negative case；缺一个即 RED。
3. metrics-smoke：/metrics（或 stats）包含全部声明指标名；无重复/无非法标签。
4. chaos-lite（stable 门禁）：本地 chaos 用例全过；beta 只需抽测并记录。
5. docs-claims：与现有 claims 检查合并，新增文档必须被索引（§9）。
```

beta / stable 门槛：

```
beta  ：L0+L1 全过 + 本版本 L2 正向至少 1 条 + 对应 N 负向全过 + 证据入库
stable：beta 全部 + L2 全量 + L3 本版本相关用例全过 + 上版本回归
```

---

## 8. 验收证据的保存与索引

```
docs/acceptance/README.md                 索引（版本 → case 列表 → 状态）
docs/acceptance/<version>/RUNBOOK.md      可复现步骤（命令/前置/期望）
docs/acceptance/<version>/<case>.json     机器可读证据
docs/acceptance/<version>/artifacts/      可选小产物（大产物只存 sha，走 blob/ release）
```

规则：

- 证据必须由 `scripts/acceptance.mjs`（新增）生成骨架，人工填结果后校验，避免手写非法 JSON。
- 每次发布（beta/stable）时，CHANGELOG 对应条目必须引用该版本的 acceptance 目录。
- 证据随版本冻结；后续修改以新 case 追加，不改历史。

---

## 9. 文档与声明的一致性

- 新文档（含本系列设计稿）必须登记进 `docs/acceptance/README.md` 或 `docs/INDEX`（实现时按现有 claims 机制选择），否则门禁拒绝。
- **能力级别口径修正**（M7 一并落地）：
  - "多机派发/聚合"（已实现）
  - "多机协同开发"（M1–M6 完成后才算）
  - "多客户端共享项目"（M4–M5 完成后才算）
- README/CHANGELOG 不再用"多机协同"泛称覆盖未完成能力。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 真机验收不可重复（机器掉线/环境漂移） | 证据带机器快照（版本/OS/caps）；允许同 case 重跑覆盖（保留历史）；关键 case 至少两台机器 |
| 测试变慢导致门禁不可用 | 分层：beta 只跑子集；stable 全量；chaos 用确定性轮询而非 sleep |
| 指标本身不可信 | 指标由 relay 计算；对关键指标加自检（如 task 计数 = ledger 事件计数校验） |
| 证据造假/过期 | task_id + ledger 区间 + artifact sha 三重校验；过期（>90 天）标记 stale 并在门禁提示 |
| 测试污染生产数据 | 验收专用项目/临时仓库；grant 限时；验收后清理脚本 |
| 时长失控（六模块验收） | 每个模块 ≥1 条正向 + 全负向矩阵；完整矩阵按版本 incremental 累加 |

---

## 11. 交付物清单（实现阶段）

```
scripts/acceptance.mjs            证据骨架生成/校验/汇总
scripts/chaos.mjs                 进程/网络/配额混沌工具（本地）
scripts/metrics-check.mjs         指标名与自检
src/relay/metrics.mjs             新增 M1–M6 计数器/直方图
src/relay/server.mjs              /metrics 暴露（或复用现有路由）
scripts/preflight.mjs             新增三项检查（evidence/negative/metrics）
docs/acceptance/README.md         索引
docs/acceptance/<version>/…       每个 beta 的证据
test/acceptance-schema.test.mjs   证据 schema 校验（无证据即失败）
test/metrics.test.mjs             指标名/单调/自检
docs/COLLAB/M7-METRICS-ACCEPTANCE.md  本文
```

## 12. 开放问题（实现前确认）

1. **真机验收执行方式**：人工执行 + 证据上传，还是配置 self-hosted runner 自动跑？前者快、后者可复现。
2. **SLO 阈值**：任务成功率/事件延迟/上传断点成功率的硬阈值定多少（本稿暂不写数值）？
3. **证据保留**：90 天过期提示是否合适？历史版本证据是否永久保留？
4. **混沌工具**：本版本只做本地代理模拟断网，还是也要真机断网（更真实但操作成本高）？
5. **stable 门槛**：L3 混沌是否强制全过才能 stable（推荐），还是允许豁免清单？
6. **文档索引机制**：新增 `docs/acceptance/README.md` 作为唯一索引，还是并入现有 claims 的 shipped-documents 列表？
