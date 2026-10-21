# 多机 / 多客户端 / 跨网络协同：能力体检与可行方案

> 写作目的：回答一个具体问题 —— **本插件目前没有真正实现"多机协同完成一个任务／联合开发"，能力缺口在哪，怎样补，先补什么。**
> 状态：设计提案（未实现）。所有"已实现"的判断都指向仓库里的具体模块；所有"未实现"都写了可验收的判据。

---

## 1. 能力体检：现在到底有什么

| 能力 | 现状 | 证据（代码/实测） |
|---|---|---|
| 控制面：多机派发、聚合、等待 | ✅ 可用 | `src/relay/server.mjs` 的 `/v1/task`、`src/agent/agent.mjs`、`w2m_run`/`w2m_wait`；实测 jp-shared 执行 `node --version` 成功 |
| 数据面：分片、缺分片、reduce 建议/执行 | 🟡 部分 | `src/util/dataflow.mjs`、`src/util/reduce-suggestion.mjs`、`reduce_of/reduce_inputs` + agent 取件（v1.3.1，实测 `REDUCE_INPUT_FETCH_FAILED` 生效） |
| 跨网络传输 | 🟡 中继可用，P2P 不可靠 | relay HTTP 是权威通道；P2P 有明文/`P2P_CRYPTO_PLAINTEXT_PEER` 拒绝，NAT 场景无成功记录 |
| 多机"联合改代码" | ❌ 没有 | 每台机器各跑各的副本；任务只声明 `base_commit` 做**一致性检查**，没有"产出补丁→合并→冲突"的工作流 |
| 多客户端（多人/多 DSH 实例）共事 | ❌ 没有 | 会话状态在各自 DSH；fleet chat 只解决"看消息"，不解决共享任务/工作区/权限 |
| 机器运维（安装/升级/重启/排障） | ❌ 没有（本应是最基本的能力） | allow-list 是**静态配置**；TwinsEarth 实测连 `node --version` 都 `COMMAND_NOT_ALLOWED`；jp-shared 的升级只能靠我临时用 relay 任务通道 + 杀进程绕过 |
| 机器加入后的"可用性" | ❌ 默认不可用 | join/pair 成功 ≠ 能干活；空 allow-list 的机器在编队里只是"在线但不能执行任何东西" |

**一句话**：现在的能力是"一个操作员向若干预先配置好的只读/受限执行器派发命令"，不是"多台机器 + 多个客户端协同完成一项工作"。

---

## 2. 根因（不是缺一个功能，是缺三个模型）

1. **执行授权模型缺失**：allow-list 是机器本地静态配置，只覆盖创建它的人预先想到的命令。远程升级/排障/装插件全部落在清单外，于是"编队"退化成"只读观测网"。放宽 allow-list 不是答案（把任意命令暴露给任何能调度的人）。
2. **任务模型缺"工作区"**：任务 = argv + 每台机器自己的项目副本 + 事后锚点检查。它假设"命令是幂等只读的"；真实联合开发是"产出改动 → 审查 → 合并"，需要**补丁/分支/合并队列/冲突**这些一等公民。
3. **协作模型缺"共享对象"**：没有 relay 侧的 project/room/board/artifact 对象，所以多客户端各看各的；chat 是消息流，不是共享状态；memory 是 CAS 文档，不是任务上下文。

---

## 3. 设计原则（不牺牲现有安全边界）

1. **不放宽 allow-list 来方便自己**：需要更强执行的场面，用**显式的、可审计的、带时限的授权**替代"清单加一条"。
2. **执行与数据分离**：relay 负责授权、事件、租约、路由；机器只在自己边界内做**被授权**的事。
3. **内容寻址 + 租约 + 事件日志**是现有底座，继续复用：blob sha256、`depends_on`/`assignee`、ledger 重放。
4. **跨网络以 relay 为权威传输**：P2P 只做机会性加速，不承担正确性（现在它承担了一部分，是错误的）。
5. **每个能力都要有"真实任务可触发"的验收**，不是单元测试通过就算数。

---

## 4. 模块方案（M1–M7）

### M1 运维通道（maintenance agent）— 最高优先级

**目标**：编队里任何一台机器，都能在**操作员显式授权**下完成"更新自身/重启服务/收集诊断"，不需要 SSH，也不需要曾经预先配置过命令。

**做法**：
- 包内新增固定入口 `bin/w2m-maintenance.mjs`（只接受 `--action update|restart|diag`，不做任意 shell）。
- 机器上的 systemd/Windows 服务用**独立单元**（root/SYSTEM 权限）监听一个请求队列目录（Linux:`/var/lib/w2m/maintenance/queue`，Windows 计划任务同理）；agent（非特权用户）只能**写请求文件**，不能执行。
- 请求文件 = 操作员私钥签名 + 动作 + 目标 sha256 + 过期时间；root 单元校验签名/hash/TTL 后执行固定动作，结果写回 `/var/lib/w2m/maintenance/done/` 并由 agent 上报 relay。
- 这样"远程升级 TwinsEarth 插件"变成一次签名请求，而不是求人 SSH。

**验收**：操作员发一条 `w2m_update` 类任务 → 目标机器 2 分钟内插件到新版本并重启 → relay 事件日志可审计（谁、何时、hash、结果）。

### M2 任务级签名授权（task grants）

**目标**：让"清单外命令"在**单次任务、单台机器、短时限**内可执行，而不是永久扩 allow-list。

**做法**：
- 复用既有 Ed25519 基础设施（`src/util/envelope-signature.mjs`、配对时登记的 device public key）。
- 操作员用独立密钥签 `grant = {argv_hash/mode, machine_ids, ttl, task_id, issued_at}`；relay 把 grant 随 offer 下发；agent 验签通过则跳过 allow-list（仍受红线：不跑 shell 字符串、cwd 限制、输出/时长上限）。
- grant 进 ledger，可审计、可撤销（撤销 = 停发新的）。

**验收**：对一台空 allow-list 的机器派发"一次性授权"命令并成功执行；同一命令无 grant 时仍被拒；grant 过期/换机/改 argv 全部被拒（负向测试）。

### M3 Git 原生任务与合并队列（worktree + patch + merge）

**目标**：多机真正"联合完成一个代码任务"。

**做法**：
- 任务携带 `repo` + `base_commit` + `branch`；agent 在**每任务独立 worktree**里执行，结果 = `commit`/`patch` 制品（blob）+ 测试结果。
- relay 侧新增**合并队列**：同一分支的合并串行化（复用 lease/`depends_on`），每个 merge 任务由指定机器执行 `git merge`/`git am`，冲突作为**一等结果**（`MERGE_CONFLICT` + 冲突文件列表 + 冲突 patch），绝不静默覆盖。
- 合并后再跑锚点校验：`base_tree` 与声明一致才允许入队。

**验收**：两台机器改不同文件 → 自动合并成功；改同一文件 → 返回 `MERGE_CONFLICT` 且两人都能看到冲突内容；重放 ledger 后合并状态一致。

### M4 项目房间（project room）

**目标**：多客户端看到同一个"项目"而不是各自会话。

**做法**：
- relay 新增 `project` 对象：members/roles（已有 role 模型可复用）、任务板、制品、memory 文档、chat 线程、决策记录。
- 客户端 API：`GET /v1/projects/:id`（快照）+ SSE/WebSocket 增量；DSH 插件侧新增 项目房间工具（未实现，暂用中性名）与面板视图。
- 任务/制品/决策都挂在 project 下，session 只是"视图"。

**验收**：两个不同 DSH 客户端（不同账号/机器）打开同一 project，看到相同的任务板/制品/决策；一个客户端创建任务，另一个 3 秒内看到。

### M5 多客户端协作原语

- **占位/锁**：branch/file lease（复用租约机制），避免两个客户端同时改同一分支。
- **审查任务**：`review` 类型任务（指定 reviewer 机器/人），结果 = approve/changes-requested。
- **通知**：mentions（已有）+ 任务状态变化推送到项目房间。
- **决策**：council 决策落 memory（已实现雏形）→ 升级为 project 级决策账本。

**验收**：A 提交补丁 → B 收到审查任务 → B 批准 → 合并队列执行；A 持锁期间 B 不能改同一分支。

### M6 跨网络与可靠性

- 明确 relay 是**权威数据通道**：blob 支持分块/断点续传（现在 16 MiB 硬上限、无断点）；任务/事件支持断线重放（ledger 已具备）。
- P2P 降级为"机会性加速"：P2P 失败不影响任务正确性；修掉明文拒绝与 NAT 不可测的问题（或直接默认 `relay` 模式，让 P2P 成为显式实验开关）。
- 离线机器：任务进入队列，机器回来后被 re-offer（已有 re-offer 基础）。

**验收**：把 relay 与执行机之一断网 60 秒，任务不丢、不重复执行，恢复后按租约重新派发；10 台机器并发派发/归并不丢事件。

### M7 观测与验收

- 指标：任务成功率、合并冲突率、授权使用次数、每机器可用命令/授权状态、relay 事件延迟。
- 测试：复用现有双机/跨平台测试附件（`test/` 与 `deploy/` 有真机脚本），每个模块都要有"真实任务可触发"的集成测试 + 负向测试。

---

## 5. 落地路线（建议顺序）

### Phase 1（1–2 周）：先把"编队可用"变成真的

1. M1 运维通道（update/restart/diag，签名请求 + root 单元）
2. M2 任务级签名授权
3. 机器加入后默认"可被操作员授权"，不再是空 allow-list 死机器

**Phase 1 验收任务（真实场景）**：
- 在一台**空 allow-list** 的机器（TwinsEarth）上，仅凭一次操作员授权完成：插件升级到 1.3.1 → 重启 DSH → 回报版本。
- relay 升级同一套流程（替代本次"杀进程"操作）。
- 全程 ledger 可审计；无 grant 时同一命令被拒。

### Phase 2（2–4 周）：联合改代码

4. M3 worktree/patch/merge 队列 + 冲突一等结果
5. M4 项目房间（先做任务板 + 制品 + 决策，后做面板）
6. 基于 M2 的 review 任务（M5 的审查部分）

**Phase 2 验收任务**：两台机器并行修一个 bug（不同文件）→ 自动合并成功并跑测试；同一文件冲突 → 冲突可见、可选人解决；两个客户端看到同一任务板。

### Phase 3（4–6 周）：多客户端与跨网络规模化

7. M5 锁/审查/通知 + M4 面板完整视图
8. M6 分块上传/断点重传/离线队列/P2P 降级
9. M7 指标与混沌测试（断网、重启、机器掉线）

**Phase 3 验收任务**：3 个客户端 + 5 台机器共同完成"改代码→审查→合并→发布"一条链，期间重启 relay/断网各一次不丢任务。

---

## 6. 最小可行闭环（如果只做一件）

**"一次签名，远程升级任意编队机器"**（M1+M2 的最小交集）：

1. 操作员本地签 `grant`（argv=`node bin/w2m-maintenance.mjs --action update --version 1.3.1`，TTL 10 分钟，目标 machine_id）。
2. 用 `w2m_run`/relay 派发；目标机器 maintenance 单元验签 → 下载 tarball（sha256 校验）→ 更新 → 重启 → 回报。
3. 客户端 `w2m_wait` 看到 `status=done` + `version=1.3.1`；ledger 记录了 grant 与结果。

所需新增：一个 `bin/w2m-maintenance.mjs`（~200 行）、一个 systemd/计划任务单元模板、`grant` 签名/验证（复用 envelope-signature，~150 行）、relay 对 grant 的透传/审计（~80 行）、插件工具 远程更新工具（未实现，暂用中性名）（~120 行）、双机负向测试。**这就是"最基本功能"的正确起点。**

---

## 7. 与现有代码的映射

| 新模块 | 复用 | 新增 |
|---|---|---|
| M1 maintenance | `bin/` 打包、systemd 单元生成经验（`deploy/server/`） | `bin/w2m-maintenance.mjs`、单元模板、队列协议 |
| M2 grants | `src/util/envelope-signature.mjs`、device public key 登记、ledger | grant 结构/签发/验证、relay 透传、agent 校验、撤销 |
| M3 worktree/merge | `src/util/dataflow.mjs`（制品哈希）、blob 通道、`depends_on`/lease | worktree 生命周期、merge 队列、`MERGE_CONFLICT` 结果、patch blob |
| M4 project room | `fleet-messages`、memory CAS、roles、council 决策账本 | project 对象、快照/增量 API、项目房间工具（未实现，暂用中性名） |
| M5 协作原语 | lease、mentions、review/approval 机制 | 分支/文件锁、review 任务类型、通知路由 |
| M6 可靠性 | ledger 重放、re-offer、blob 通道 | 分块/断点、离线队列、P2P 降级开关 |

---

## 8. 风险与取舍

| 风险 | 处置 |
|---|---|
| 签名 grant 变成新的后门 | 单次/单机/短 TTL/argv hash 绑定 + ledger 审计 + 可撤销；默认关闭 |
| maintenance 单元权限过大 | 只允许固定 action；不接受任意 shell；更新包必须 sha256 匹配 release 资产 |
| 合并队列成为瓶颈 | 按分支/路径分片串行；冲突直接回给提交者，不自动猜 |
| relay 仍是单点 | 短期接受；M6 做事件重放与多 relay 只读镜像（后续） |
| 多客户端一致性 | 以 relay 事件日志为唯一事实源；客户端只做视图，不做本地权威状态 |
| 现有 beta 已声明"多机"，与实际不符 | 文档修正：把"多机派发/聚合"与"多机协同开发"分成两个能力级别，不再混写 |

---

## 9. 建议的下一步（需要用户决策）

1. **批准 Phase 1 MVP**（M1+M2，远程运维），我用真实机器（TwinsEarth/jp-shared）作为验收对象，两周内出可演示闭环。
2. 批准后同步修正 README/CHANGELOG 里"多机协同"的口径，避免把"派发/聚合"写成"联合开发"。
3. Phase 2 的 worktree/merge 模型涉及产品取舍（中心化合并 vs 去中心 git），建议先做一个 3 页的对比决策再动手。
