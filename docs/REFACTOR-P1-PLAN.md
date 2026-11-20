# P1 重构计划：巨型入口分解 + 备份引擎 worker_threads 化

> 来源：`docs/AUDIT-3.5.2.md` §6.2 风险登记的两条 P1。目标不是"改功能"，而是**在不改变任何对外行为的前提下**
> 降低单文件复杂度、把备份引擎移出宿主主线程。每个切片独立可交付、可回滚，切片之间不共享工作树改动。
> 当前基线：HEAD `35e95f8`（3.5.2 + 审计文档），pre-flight 4314/4292/0/22 全绿。

---

## 0. 一个关键发现：这些文件"大在一个函数里"

| 文件 | 行数 | 最大函数（行数） | 说明 |
|---|---:|---|---:|
| `src/plugin/tools.mjs` | 8,909 | `apply(4251)` | 16 个 `w2m_*` 工具全部内联在一个 apply 里 |
| `src/agent/agent.mjs` | 4,771 | `createAgent(3685)` | agent 生命周期四阶段全在一个工厂 |
| `src/relay/state.mjs` | 3,714 | `gateMachine(3284)`* | 租约/任务/结果/成员/事件全在 RabbitState 一个类里 |
| `lib/client.js` | 9,965 | `UpdateSettingsSection(3454)` + `renderChatText(1142)` | 客户端是**手写发布 bundle，无构建步骤**（见文件头注释） |
| `src/backup/engine.mjs` | 1,135 | `runBackup(650)` | 同步执行，长任务占宿主事件循环 |

\* `gateMachine` 的 3284 行是启发式测量（含其后的 `RabbitState` 类体）；实际是"一个模块一个巨类"。

结论：**拆文件不是目的，拆函数边界才是**。因此方案是"入口文件保留装配职责，把内联块提取为同层子模块/子函数"，
而不是推倒重来。所有对外导出（包导出子路径、Cordis 行名、16 个工具名/参数、客户端 `load()` 形状）保持字节级稳定。

---

## 1. 目标结构

### 1.1 tools.mjs（8.9k → 装配 610 行，其中 `apply()` 450 行 + 5 个新子模块）

```
src/plugin/tools.mjs                 # apply(ctx)：ctx 注入、store/route 装配、16 个注册器按原顺序调用
src/plugin/tools/shared.mjs          # 两个及以上模块共用的一切：refusal/config/request/身份/P2P/结果封装/本地栈
src/plugin/tools/fleet.mjs           # devices/stats/status/update
src/plugin/tools/dispatch.mjs        # run/wait/tasks/history/report/cancel/reduce
src/plugin/tools/memory.mjs          # memory/chat/intent
src/plugin/tools/governance.mjs      # approvals/council（joint_plan/joint_status 仍在既有 tools-joint.mjs，注册点仍在 apply 首位）
```

- `apply` 仍从 `./tools.mjs` 导出（`lib/tools.js` / `lib/index.js` 的 re-export 不变）；工具面摘要仍钉在
  `409a6652675fc66608525b4437f07e17f3a5898ab7b61297e6c0309654a82f5a`（18 个工具，名称/描述/参数/顺序不敏感形态全部不变）。
- **工具快照测试**：先用当前实现导出 16 个工具的 `{name, description, parameters}` 快照（`test/tools-surface.test.mjs`），
  重构期间每次切片跑它；任何字段变化都会失败。
- 切片顺序：shared → fleet → memory → governance → dispatch（最后动 run/wait，因为测试最多）。
- **S2/S3 交付记录（已提交 `c173981`）**：`tools.mjs` 8,909 → 610 行；新增 `shared.mjs` 3,356、
  `dispatch.mjs` 2,239、`memory.mjs` 1,385、`fleet.mjs` 1,043、`governance.mjs` 413 行。每个工具改为
  `register<Name>(ctx, deps)` 工厂（`deps` = 它原先闭包引用的 apply 局部量），`apply()` 按历史顺序依次调用
  （joint ×2 位置不变，然后 devices→run→wait→report→status→update→history→stats→memory→approvals→chat→intent→
  council→cancel→reduce→tasks）。`PLUGIN_VERSION` 占位符仍留在 `tools.mjs`（`scripts/pack.mjs` 只替换该文件），
  用它的两个工具经 `deps.pluginVersion` 取值。唯一需要活引用的 apply 量是 `let approvals`，`w2m_status` 经
  `currentApprovals()` 读取（值快照会永久冻结为 null）。工具套件 233/233 与广度回归 304/304（12 跳过）全绿。

### 1.2 agent.mjs（4.8k → createAgent 组装 ~400 行 + 阶段模块）

```
src/agent/agent.mjs                  # createAgent()：装配四阶段 + 导出面保持
src/agent/lifecycle/offer.mjs        # 领取 offer / 校验 allow-list / 租约
src/agent/lifecycle/execute.mjs      # 执行 argv / 超时 / 取消 / 结果封装
src/agent/lifecycle/deliver.mjs      # 结果投递 / 重试 / P2P 直连回退
src/agent/lifecycle/heartbeat.mjs    # 心跳 / 重连 / 状态文件
```

- 对外导出（43 个常量/函数）从 `agent.mjs` 重新导出，导入方零改动。
- 验收：`test/agent*.test.mjs` 全绿 + 真机 localside 冒烟（本机起一次 localside 连接 relay，跑一次 `node-version`）。

### 1.3 state.mjs（3.7k → RabbitState 门面 + 域模块）

```
src/relay/state.mjs                  # RabbitState：字段 + 编排，导出面不变
src/relay/state/leases.mjs           # 租约/心跳/过期
src/relay/state/tasks.mjs            # 任务板/依赖/取消
src/relay/state/results.mjs          # 结果 blob/去重/聚合
src/relay/state/members.mjs          # 成员/配对/能力门
src/relay/state/events.mjs           # 事件缓冲/SSE 游标
```

- 风险最高的是"共享可变状态"：先做**纯函数提取**（无 this 依赖的校验/计算），再做带 `this` 的方法搬移，
  每步跑 `test/relay-*.test.mjs` + Phase 2 真实进程脚本。
- 验收：`scripts/verify-relay-cluster-phase2.mjs` 9/9、mixed-version 6/6（真机）。

### 1.4 client.js（9.9k，**不拆文件**）

**不拆文件**：文件头明确"这是手写发布 bundle，无构建步骤，`load()` 表形状即协议"。拆文件会引入构建器/多模块加载风险，
收益小于风险。改为**文件内函数分解**：

- `UpdateSettingsSection(3454)` → `SettingsSection` 壳 + `SettingsModels/SettingsGeneral/SettingsAccount/SettingsPlugins` 子组件（同文件内，
  module scope 常量表 + 一个 `mountSettingsSection()`），目标单函数 <600 行；
- `renderChatText(1142)` → `chat-text/` 段落在同文件内拆为 `renderChatMarkdown`、`renderCodeBlock`、`renderAttachments`；
- 每步后跑 `test/client-bundle.test.mjs`（真实 bundle 加载 + 面板断言）+ `test/loader-entry.test.mjs`。

### 1.5 备份引擎 worker_threads（行为不变，执行位置改变）

```
src/backup/engine.mjs                # 纯函数引擎（现状不变，CLI 仍可直接调用）
src/backup/engine-worker.mjs         # worker 入口：收 runBackup 参数 → 执行 → postMessage 进度/结果
src/plugin/backup-worker.mjs         # 插件侧：spawn/复用、resourceLimits、超时、失败回退 inline
```

- **协议**：`{type:'start', input}` → `{type:'progress', stage, done, total}` / `{type:'done', result}` / `{type:'error', ...}`；
  输入不含密钥明文（password 走 once-message，worker 内用完即清）。
- **资源**：`new Worker(..., { resourceLimits: { maxOldGenerationSizeMb: 1024 } })`；worker OOM → 具名失败
  `BACKUP_WORKER_OOM`，宿主不受影响，且**不自动重试**（重试由用户/下一次调度决定）。
- **回退**：worker 启动失败/旧 Node 无 worker → 保持现状 inline 执行（日志标注 `engine: inline`）。
- **调度/面板**：scheduled run 与 `POST /api/w2m/backup/run` 都走 worker；CLI（独立进程）继续 inline；
  进度写入 `<DSH_HOME>/xclient/w2m-backup/worker.json`，describe 暴露 `engine_mode` 与 `progress`。
- **验收**：`test/backup-worker.test.mjs`（子进程/真 worker：成功、OOM 被捕获为具名失败、宿主存活、回退 inline、
  进度事件顺序、密码不出现在消息日志中）；真机跑一次真实备份，记录宿主 RSS 曲线（应基本无变化）。

---

## 2. 切片与顺序（每片独立提交、独立 pre-flight）

| # | 切片 | 产出 | 验收 |
|---|---|---|---|
| S1 ✅ | 工具面快照 + `tools/shared.mjs` | **已实现**：`test/tools-surface.test.mjs`（18 工具、注册顺序无关的规范 JSON 摘要 `409a6652…a82f5a`） | 快照套件绿；后续 tools 切片的机械性证明 |
| S2 | `tools/fleet.mjs` + `tools/memory.mjs` | apply 减 ~800 行 | 快照 + `test/tools*.test.mjs` — ✅ **已完成（已提交 `c173981`）**：`tools/{shared,fleet,memory}.mjs` 落地，apply 4,243 → 2,313 行；快照摘要不变，`tools*` 233/233 全绿 |
| S3 | `tools/governance.mjs` + `tools/dispatch.mjs` | apply 降到 ~350 行 | 同上 + `test/agent*.test.mjs`（dispatch 走 agent） — ✅ **已完成（已提交 `c173981`）**：apply 4,243 → 450 行，`tools.mjs` 610 行；16 个工具全部搬入 4 个域模块、注册顺序逐字节保持；快照摘要不变，工具套件 233/233 + 广度回归 304/304 全绿 |
| S4 ✅ | `agent/lifecycle/*` 四阶段 | **已实现**：agent.mjs 4,770 → 638 行（createAgent 365）；lifecycle/{shared,deliver,execute,offer,heartbeat} = 1,170/1,470/554/567/926；导出面 45 项一致、4,470/4,690 行逐字节一致 | 基线 568/566/0/2 不变；agent*+p2p-* 441/438/0/3；广回归 164/164；lint/layer/mojibake clean |
| S5 ✅ | `relay/state/*` 纯函数 → 方法搬移 | **已实现**：state.mjs 3,713 → 1,174 行；state/{shared,members,tasks,leases,results,events}=348/763/1,019/487/97/61；42 导出与 100 个 prototype 名一致；`.gitignore` 修正 `state/` 规则误忽略源码 | relay 517/516/0/1 不变；真实进程 phase2 **9/9** + mixed **6/6**；lint/layer/mojibake clean |
| S6 ✅ | client.js 文件内分解（settings） | **结论修正**：所谓 3,454 行的 `UpdateSettingsSection` 实际只有 **63 行**，是 C1 预算计量器（只认列 0 `function`、把后续并列组件全算进上一个函数）的误报。已重写计量器（花括号匹配/注释字符串屏蔽/嵌套跳过/非空守卫）、预算单函数上限 3,600→**1,200**（真实最大 `BackupPanelView` 832），`renderChatText` 提取到模块作用域 | client-bundle 112/112、真实页面 143/143、eslint 0 |
| S7 ✅ | client.js 文件内分解（chat-text） | `renderChatText`(10 行) + `CHAT_COMMANDS/STICKER_GLYPHS/STICKER_RE/EMOJIS` 提到模块作用域（逐字节等价），`FleetChat` 351→335；文件 593,045→593,540 B（仍在预算内） | 同上 |
| S8 | `engine-worker.mjs` + 插件接线 + 回退 | 引擎默认 worker | ✅ **已实现（已提交 `c173981`）**：`test/backup-worker.test.mjs` 12/12 通过——真 Worker 成功且结果与 inline 等价（`files`/`counts` 一致、对齐随机 `snapshot_id` 后 manifest digest 相同）、真 Worker verify、进度阶段顺序、`resourceLimits.maxOldGenerationSizeMb=1024`、进度文件 schema/结束删除/无凭据、`scopes.mjs` 把 `xclient/w2m-backup/worker.json` 按 self-copy 跳过（扫描不捕获自身进度文件；`state.json` 仍在 scope 内）、`BACKUP_WORKER_OOM`（错误事件与退出码 134）、`BACKUP_WORKER_TIMEOUT`、其他崩溃 `BACKUP_WORKER_FAILED`、spawn 抛错与 `W2M_BACKUP_INLINE=1` 回退 inline、`deps.backupRunner` 插件接线（run/定时/verify 路线 + `engine_mode` + 具名失败不抛）、`backupWorkerTimeoutMs` 默认 30 分钟。回归 `backup-run`/`backup-engine`/`backup-verify`/`backup-memory`/`backup-wiring` 全绿（全部 backup-* 套件 569/569）。设计见 `docs/BACKUP-DESIGN.md` §27.8。真机 RSS 曲线延后（本切片不触真实 profile） |
| S9 ✅ | 文档收尾 + 审计更新 | **已完成（本次提交）**：AUDIT §0 结论 5/10、§6.2 风险表、§6.3 建议、附录 D（3.5.3 进展）全部按实测更新；本计划 S1–S8 状态全部改为"已提交"并附提交号 | pre-flight 绿；仅剩**真机 RSS 曲线**待用户授权（真实 profile 安装 3.5.3 后跑一次备份并采样） |

**发布纪律**：每片只提交（本地），不 push/tag/publish；版本号在切片期间保持 3.5.2，等用户授权发布时统一 bump。

---

## 3. 风险控制（强制）

1. **行为冻结**：S1 的工具快照 + 现有 300 套件即契约；任何"顺手优化"都拒绝。
2. **共享状态**：state.mjs 只搬方法不复制状态；搬移后跑真实多进程 Phase 2 脚本（进程内测试测不出 relay 时序）。
3. **客户端**：不引入构建步骤、不拆文件、不改 `load()` 表形状；每步用真实 bundle 测试。
4. **worker**：密钥经 once-message 传递后立即覆盖；worker 崩溃 = 具名失败，不重试；回退路径保留。
5. **可回滚**：每片一个 commit，`git revert` 单片即可；切片不互相依赖工作树未提交状态。

---

## 4. 工作量估计（按切片，可在多个会话完成）

| 切片组 | 估计 |
|---|---|
| S1–S3（tools） | 2–3 个会话 |
| S4（agent） | 2–3 个会话 |
| S5（relay state） | 2 个会话（含真机 Phase 2） |
| S6–S7（client） | 3–4 个会话（纯人工，测试驱动） |
| S8（worker） | 2–3 个会话（含 OOM/回退测试） |
| S9（收尾） | 0.5 个会话 |

**建议先做 S8（worker）还是 S1–S3（tools）？**
- 选 **S8**：用户可感知（运行备份时 GUI 不再停顿），且完全独立于其它重构，风险可控；
- 选 **S1–S3**：为后续所有 P1 建立"快照 + 切片"的模板，间接降低全程风险。

推荐顺序：**S1 → S8 → S2/S3 → S4 → S5 → S6/S7 → S9**（先用 S1 立契约，再拿 S8 拿收益，然后按域推进）。
