# Relay Phase 2 合并评审：`wip/relay-phase2-20261117`

> 评审日期：2026-11-17 · 当前线：`work/v3.4.6` @ `757e328` · 被评审分支：`wip/relay-phase2-20261117` @ `8e90aed`
> 性质：**只读合并评审**。本评审不合并、不 rebase、不改代码/版本、不发布；唯一新增文件就是本文。
> 证据边界：只读 `git` 命令 + 分支文件静态阅读（`git show <branch>:<path>`）。未 checkout 分支，未运行分支测试、`scripts/verify-*.mjs`、`scripts/preflight.mjs` 或全量套件；凡未验证处均显式标注。

> **合并状态更新（2026-11-17，人类批准后的执行记录）**
>
> 人类已批准按"先 merge HEAD 进分支 + 独立编码修复 commit + ADR/手册补齐"执行合并。§6 的建议顺序已落地：
>
> - **分支侧**：`eee9c16` 把 `work/v3.4.6` 合入 `wip/relay-phase2-20261117`（唯一文本冲突 `package.json`，两侧 scripts/bin/exports 全保留）；`aee1a9b` 是**独立编码修复 commit**（5 文件：`server.mjs`、`project-locks`、`project-notifications`、`project-reviews`、`test/cluster-domains`；`git diff work/v3.4.6 -- <file>` 只剩 Phase 2 真实改动，`§`×49、`—`×27、`–`×2、`→`×2 与 `SIGNATURE_MISMATCH/EXPIRED/REPLAY`、device_token 提示文案全部恢复）。
> - **条件 2（文档）**：新增 `docs/RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md`（Phase 2 ADR，含数据模型/协议兼容/删除语义/安全/回滚/迁移与验证命令）与 `docs/RUNBOOK-RELAY-ROLLING-UPGRADE.md`（滚动升级手册：顺序、混合版本矩阵、逐步门禁、回滚、禁止事项）；v3.0.0 设计 §2.3 已加交叉链接。
> - **条件 3（门禁）**：`chat-store` / `project-sync` / `cluster-domains` / 新增 `relay-phase2-server` 四个套件全部进入 `package.json#scripts.test` 与 `test:all`，并各有独立脚本；`test/relay-phase2-server.test.mjs` 覆盖 §4 风险 3 点名的 server 接线（feature/路由、chat 持久化与重启、真实 HTTP 跨 relay 拉取、混合版本跳过、tombstone、签名错误文案、套件门禁接线）。
> - **条件 4（删除语义）**：按"实现闭环"处理——`chat-store.load()` 按 tombstone 过滤消息、`prune()` 删除 tombstoned 会话的死行（tombstone 永久保留）、`server._applyChatRecord()` 拒绝晚到的已删会话消息、`server.deleteChatSession()` 是唯一删除写路径、`POST /v1/fleet/messages` 对退役 `session_id` 返回 400 `SESSION_DELETED`；设备面 HTTP 删除路由**明确推迟**（ADR §5.4 写明理由与后续）。
> - **保留为发布前证据项**：风险 5（relay 版本标签口径）与风险 6（`verify-relay-cluster-mixed.mjs` 混合版本真实运行、三节点 `verify-relay-cluster-phase2.mjs` 留证）不在本次收口范围，见 ADR §12。
> - **未执行**：不 push、不改包版本、不跑全量 preflight（主线合并后跑一次）。
- **合并时点的全量 pre-flight（已补记）**：空 `DSH_HOME` + `DSH_RUNTIME_DEPS` 下 **GREEN — 4168 tests / 4144 pass / 0 fail / 24 accepted skip（296 suites）**；这是合并提交 `0b7e8e1` 的记录，保留作历史证据。
- **当前线（2026-11-18 更新）**：此后新增的备份功能使全量测试增长到 **4236 tests / 4212 pass / 0 fail / 24 accepted skip**，pre-flight 仍 GREEN——引用数字时请注明时点，避免把合并时点当成现状。这两行就是全量 pre-flight 的时点记录。

---

## 1. 结论摘要

**结论：merge-with-conditions（有条件合并）。方向正确、实现基本扎实，但不建议按当前状态直接 merge。**

可以认可的部分：Phase 2 只动 relay 子系统（HEAD 侧自 v3.4.4 起未改 `src/relay/*`），新增能力以「只增不改」方式接入（新路由 `/v1/cluster/chat`、`/v1/cluster/projects`、新 feature bit、healthz features 追加），有 feature-bit 探测以兼容滚动升级，append-only 日志 + generation + 水位线有明确的崩溃顺序设计，52 个新单测 + 12 个扩展用例，且 diff 中未发现密钥/凭据。

必须满足的条件（阻塞 merge）：

1. **修复 WIP 提交的编码损坏**。`8e90aed` 里 5 个文件出现 GBK/UTF-8 双重编码乱码：`server.mjs` 中 49 个 `§`、27 个 `—`、2 个 `–`、2 个 `→` 全部丢失，变成 `搂/?` 等字符（含 `SIGNATURE_MISMATCH/EXPIRED/REPLAY`、device_token 提示等**对外错误文案**）；`project-locks.mjs`(2)、`project-notifications.mjs`(1)、`project-reviews.mjs`(2)、`test/cluster-domains.test.mjs`(1) 各 1–2 处 `§` 同类损坏。HEAD 对应位置是正确的，直接 merge 会用乱码**静默覆盖**正确文本。
2. **补齐文档承诺**：代码引用的 `RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md` 在分支/HEAD 都不存在；v3.0.0 设计 §2.3 明确要求 Phase 2「单独 ADR」；`docs/DEV-PLAN-3.4.6-3.5.0.md` §v3.5.0 第 3 条验收要求「配套三节点集成测试与**滚动升级手册**」，分支无任何 docs/runbook 变更。
3. **测试进入门禁 + 补接线测试**：3 个新测试文件只挂在新加的 npm script 上，**不在** `test` / `test:all` 门禁列表；`server.mjs`（+215/−72）的 Phase 2 接线无任何自动化测试（chat 装载/删除、cluster 页路由、重启恢复），只有手跑的 `scripts/verify-*.mjs`。
4. **chat 删除语义闭环或显式推迟**：`chat-store.load()` 不按 tombstone 过滤消息，`server.mjs` 的 `_chatDeletedSessions` 只写不读（全仓仅 3 处写入、0 处读取），且 HEAD/分支都没有触发 `deleteSession` 的 HTTP 入口。当前无实际触发路径（latent），一旦接入删除就会出现「重启/新节点复活已删会话」；须在合并前补测试+过滤，或在 ADR 里写明暂不支持并禁止对外宣称跨 relay 删除生效。

以下两项建议在 merge 前完成、但若人类决定可随 v3.5.0 发布前收口：relay 版本标签统一（`--help` 写 "v3.1.0"、phase2 验证脚本却设 `W2M_RELAY_VERSION=3.0.0`、mixed 脚本设 3.1.0）；`verify-relay-cluster-mixed.mjs` 默认旧版路径是私有 checkout（`E:\GPT\_work\...`），应改为必须显式 `W2M_RELAY_OLD_TGZ`。

**合并策略一句话**：先把 `work/v3.4.6` 合入 WIP 分支（保留分支历史）→ 独立 encoding-cleanup commit → 补 ADR/滚动手册/门禁测试并闭环删除语义 → 三节点 + 混合版本 + 全量套件留证 → 人类批准后 `work/v3.4.6` ← WIP。merge 的主要成本**不在冲突**（只有 `package.json`），而在修复、文档与验收证据。

---

## 2. 分支范围

- 分支是**单提交**：`8e90aed`（2026-11-17 05:48 +0800，提交信息 "preserve uncommitted Phase2 chat/project sync work before v3.4.5 sync"），本地与 `remotes/old-local/wip/relay-phase2-20261117` 同 hash。
- 其父提交 = merge-base = `9bde53e`（tag **v3.4.4**）。HEAD 在 merge-base 之后有 **11 个提交**（v3.4.5 发布、session-doctor、backup v3.4.6–v3.4.9、fix renumber、v3.4.9 UI 收尾），即分支**落后 HEAD 11 个提交**、版本仍是 `package.json@3.4.4`（HEAD 为 3.4.5）。
- `git diff --stat work/v3.4.6...wip/relay-phase2-20261117`：**20 文件，+5754 / −115**，按区域：

| 区域 | 内容 | 行数 |
|---|---|---|
| 新增引擎 | `src/relay/chat-store.mjs` 849、`src/relay/project-sync.mjs` 1004 | +1853 |
| relay 接线 | `server.mjs` +215/−72、`cluster-sync.mjs` +536/−5、`fleet-messages.mjs` +218/−19、`state.mjs` +138/−4、`persistence.mjs` +83/−1、`project-room.mjs` +143、`project-{locks,notifications,refs,reviews}.mjs` 各 ~+100 | +1610 / −115 |
| 测试 | 新增 `test/chat-store.test.mjs` 439(26 it)、`test/project-sync.test.mjs` 576(15 it)、`test/cluster-domains.test.mjs` 275(11 it)；扩展 `test/fleet-messages.test.mjs` +201（23→35 it） | +1491 |
| 脚本 | `scripts/verify-relay-cluster-phase2.mjs` 346、`scripts/verify-relay-cluster-mixed.mjs` 276 | +622 |
| bin/meta | `bin/w2m-rabbit.mjs` +21（帮助文本+env）、`package.json` +5（5 个 npm script） | +26 |

- 分支**不涉及** docs/、`PROTOCOL*.md`、`FLEET-RULES.md`、`CHANGELOG.md`、`plugin.json`/`.claude-plugin/*`、backup/fix 代码；也不改版本号。
- 该分支是 v3.5.0 里程碑第 3 项（`docs/DEV-PLAN-3.4.6-3.5.0.md` §7「Relay Phase 2 合并」）的输入；本次评审是其交付物（评审+风险+合并建议），**不含合并动作**。

## 3. 偏离与冲突

**是否 stale / 冲突面**

- 合并模拟（只读，未改 refs/index/worktree）：`git merge-tree --write-tree work/v3.4.6 wip/relay-phase2-20261117` → 结果树 `a0c70dc…`，输出 `Auto-merging package.json` + `CONFLICT (content): Merge conflict in package.json`。**唯一冲突文件是 `package.json`**（两侧都在 `scripts` 区加东西：HEAD 加 test:dsh-fix/backup 等，分支加 5 个 Phase 2 专用 script），机械合并两边都保留即可。
- 交叉改动核对：`merge-base..HEAD` 的变更清单与分支变更清单交集**只有 `package.json`**；`src/relay/`、`bin/w2m-rabbit.mjs`、`test/fleet-messages.test.mjs` 在 HEAD 侧自 v3.4.4 起**未被改过**。所以 Phase 2 代码与 HEAD 的 relay 代码同源，无文本冲突、无跨区域语义耦合；新模块的 import 全部落在 `src/relay/` 内部 + Node 内置（唯一外部面是 `package.json` 脚本）。
- **是否 pre-date v3.4.7–v3.4.9 的修复**：代码层面没有「Phase 2 依赖那些修复」的证据——那些提交只动 backup/fix/UI/client/session-doctor/版本文件，不改 relay；Phase 2 也不 import 它们。但分支整体基线是 v3.4.4，**合并前必须先合入 HEAD 再跑全套件**（`FLEET-RULES.md` 规则 1：merge 不是发现套件红的地方，必须在要落地的树上跑绿）。
- 分支 `docs/` 是 v3.4.4 时代内容（没有 `BACKUP-DESIGN.md` 等），merge 时以 HEAD 文档为准，禁止反向覆盖。
- 分支在 `src/relay/chat-store.mjs` 注释里引用 `RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md §4.1/§4.3/§5`，该文件在分支和 HEAD 都不存在；v3.0.0 设计文档 §1.3/§2.3 把 chat/memory 持久化+同步列为「本版本不做」并指出要「单独 ADR」。
- **合并面判定**：20 个文件里 7 个纯新增、13 个修改全部落在 HEAD 自 v3.4.4 起未触碰的路径；唯一双侧改动是 `package.json`（脚本区）。所以 merge 冲突成本极低，真正成本在编码修复、文档补齐、门禁/验收证据。

**协议/契约面**

- `PROTOCOL.md` 是插件↔Rabbit/Localside 的设备线协议（`protocol_version = 1`，文首写明「改本文件=破坏性变更，必须升版本」）。Phase 2 **没有改它**，新增的 `/v1/cluster/*` 是 relay 间 peer-only 路由（cluster HMAC + 既有 envelope 加密），属于 v3.0.0 cluster 设计的追加式扩展 → **不需要升设备线协议版本**；但分支也没有更新 `docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md`/`docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md`，新路由、feature bit、新 env、混合版本行为都没有落到文档。

## 4. 风险清单

| # | 风险 | 影响 | 缓解 | 阻塞? |
|---|---|---|---|---|
| 1 | **编码损坏**（5 文件） | merge 后 operator/agent 可见错误文案变乱码，注释协议引用丢失，review 误判 | 独立 cleanup commit，以 HEAD 为基准恢复 `§/—/–/→`；合并后 `git diff work/v3.4.6 wip -- src/relay/server.mjs` 只应剩 Phase 2 真实改动 | **是** |
| 2 | **文档/ADR/滚动升级手册缺失** | 代码引用不存在的设计文档；DEV-PLAN v3.5.0 验收项「滚动升级手册」无法交付；协议/版本无据可查 | 补 `RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md`（或 ADR）+ runbook 增补（新 env、三节点步骤、降级说明）+ 更新 v3.0.0 设计状态/链接 | **是** |
| 3 | **测试门禁缺口** | 52 个新 it 不进 `npm test`/`test:all` 等于没跑；`server.mjs` 接线 0 测试（状态层重启恢复由 project-sync 测试覆盖，但装载/删除/路由无测试） | 加入门禁列表；补 server 级接线/重启/删除测试；把 phase2 verify 纳入可选 CI 或发布清单 | **是** |
| 4 | **删除语义未闭环（latent）** | `load()` 不过滤 tombstone；`_chatDeletedSessions` 只写不读；无 HTTP 删除入口 → 一旦接入删除，重启/新节点复活已删会话 | 补过滤+断言测试，或 ADR 明确「Phase 2 不做删除传播」并删除死代码/禁止宣称 | 需决策（默认按阻塞处理） |
| 5 | 协议/版本标签不一致 | `--help` 称 Phase 2 = v3.1.0；phase2 验证脚本报 3.0.0；mixed 脚本报 3.1.0；插件目标是 3.5.0 | 人类定 relay feature 版本与文档口径；`W2M_RELAY_VERSION` 在脚本/runbook 统一；设备 `protocol_version` 不动 | 否（发布前） |
| 6 | 混合版本/滚动升级 | 设计上靠 `/v1/cluster/ping` feature 缓存 + 非 Phase2 peer 跳过域实现；**本次未运行验证** | 用 `verify-relay-cluster-mixed.mjs`（需 3.0.0 archive）在合并后真实跑 4 项断言；旧 relay 不受影响（新路由不会被调用） | 否（需证据） |
| 7 | 数据迁移与回滚 | 无破坏性迁移；新增 `<state>/chat/`、`<state>/projects/objects.json`、`<state>/instance-id.json`、`<state>/cluster/domains.json`；旧版本忽略这些文件，回滚安全但旧版看不到 Phase 2 数据 | runbook 写明回滚保留 state；`$DSH_HOME` 备份（BACKUP-DESIGN §5 只扫 sessions/attachments/storages）**不覆盖** relay state → 单节点 relay 的聊天/项目对象只有一份，需在文档声明或纳入 v3.5.0 备份增强 | 否 |
| 8 | 并发/原子性 | chat append 有崩溃顺序设计（先留 offset 再 append、先 append 再水位、先 bump generation 再重写）；但全部无 fsync；`projects/objects.json` 与 `room-snapshot.json` 两次独立写、失败被 `catch` **静默吞掉**；`Persistence.saveProjectObjects/loadProjectObjects` 写了却没人调用（与 state.mjs 内联实现重复） | 失败要可观测（日志/healthz 计数）；明确两文件非事务、可接受部分恢复；清理死代码 | 否 |
| 9 | 容量/性能 | 启动同步 `readLog()` 加载 chat 日志（正常 ≤ hard cap 200 MiB，单节点长期未 prune 时可更大），小 VPS 有内存/启动延迟风险；cluster 开启时每 60s 全量解析日志做 prune；**未开 cluster 的 relay 只在启动时 prune**，两次重启间 chat 日志可超过 200 MiB 上限继续增长；project 每次事件全量 JSON 写 | prune 与 append 解耦（阈值/定时），启动加载异步/分页；在文档标注内存/磁盘预算 | 否 |
| 10 | 机密与静态数据 | diff 新增行未命中 private key/ghp_/sk-/AKIA/password/token 模式；验证脚本用 `randomBytes` + 假 device token；`instance-id` 随机非秘密。但 chat 明文（0600）现在**落盘并被复制到 peer**，README 已声明 relay 聊天明文，属新增 at-rest 暴露面 | 安全文档/ADR 写明「relay 聊天明文 at-rest」，不在本阶段承诺 E2E；存储权限保持 0600/0700 | 否 |
| 11 | 与 v3.4.6–v3.4.9 backup/fix 的交互 | 无代码冲突；但新持久化数据不在备份范围、restore 也不会回滚 relay state | 与 #7 合并处理：v3.5.0「备份增强」可承接；本阶段文档声明边界 | 否 |

## 5. 测试证据（实际执行/阅读）

**跑过的（当前树）**

```
node --test --test-force-exit test/cluster-sync.test.mjs test/cluster-sync-integration.test.mjs
  test/fleet-messages.test.mjs test/fleet-messages-http.test.mjs test/project-locks.test.mjs
  test/project-notifications.test.mjs test/project-refs.test.mjs test/project-reviews.test.mjs
  test/project-room.test.mjs test/project-room-persistence.test.mjs test/relay-version.test.mjs
```
输出：`tests 95 / suites 22 / pass 95 / fail 0 / duration_ms 12862.5`（Node v26.13.0）→ 当前树 relay 相邻基线绿。

说明：本评审未改任何代码；测试在评审开始时工作树干净的状态下运行。评审过程中工作树出现了**并行的、与本评审无关的**未提交改动（`src/plugin/*`：`tools.mjs`、`fleet-target.mjs` 等修改与 `version-gate.mjs` 新增，评审期间还在变化），属 v3.5.0 版本治理方向；本评审未触碰、也未依赖它们（上述 relay 相邻测试不 import `src/plugin/*`）。

**合并模拟证据**：`git merge-tree --write-tree work/v3.4.6 wip/relay-phase2-20261117` 输出唯一 `CONFLICT (content): Merge conflict in package.json`（另两阶段均提供 package.json 三个 blob）；`git status` 复查工作树仍干净。未做 checkout/rebase。

**读到的分支测试**（未运行，因为分支未合并、测试 import 的是分支专属模块）：chat-store 26 it（round-trip/LWW/tombstone 返回/retention+cap/generation 页/import 去重/坏行容忍）、project-sync 15 it（导出/确定性合并/幂等/重启恢复全对象）、cluster-domains 11 it（两进程内 ClusterSync 走真实 HTTP 的签名+加密页面/offset/feature 跳过）、fleet-messages 扩展 12 it（持久化钩子/导入/retention）。

**未运行（明确未验证）**：`scripts/verify-relay-cluster-phase2.mjs`（三节点真实进程 5 项检查）、`scripts/verify-relay-cluster-mixed.mjs`（需旧 Relay 3.0.0 tgz，默认私有路径；含滚动升级 4 项断言）、分支测试本身、全量 `npm test`、`scripts/preflight.mjs`。因此 **DEV-PLAN 验收要求的「Phase 2 三节点集成 2/2」目前没有本次评审可采信的证据**。

## 6. 建议合并顺序（需人类批准后才执行）

1. **人类先批准本结论**与下面决策点；未批准不动手（`FLEET-RULES.md` 规则 1：两侧都已发布时停止并上报，不自动合并）。
2. 在 `wip/relay-phase2-20261117` 上做 **encoding cleanup（独立 commit）**：以 `work/v3.4.6` 为基准恢复 5 个文件的 `§/—/–/→` 与错误文案，复核 diff 只剩 Phase 2 真实改动。
3. 把 HEAD 合入分支（推荐 `git merge work/v3.4.6` 到分支，保留分支历史；不建议 rebase 已推送分支）：解 `package.json` 冲突（两侧 script 都保留），**不要**采用任一侧整文件；并确认版本号仍由 v3.5.0 发布流程统一处理（本阶段不改）。
4. 补文档：Phase 2 ADR/设计文档（含新 state 布局、merge 规则、混合版本/回滚、删除语义边界）+ 滚动升级手册（基于 v3.0.0 runbook 增补新 env/步骤/降级）+ 更新 v3.0.0 设计文档状态/链接；发布时补 `CHANGELOG.md`。
5. 补测试与门禁：3 个新测试 + fleet-messages 扩展加入 `test`/`test:all`；补 server.mjs 接线、chat 重启/删除、cluster 页路由测试；如做删除语义则同样补 restart 断言。
6. 合并前在要落地的树上跑：全量 `npm test`（或 `test:all`）全绿 → `node scripts/verify-relay-cluster-phase2.mjs` 三节点 2/2 → `node scripts/verify-relay-cluster-mixed.mjs`（提供 `W2M_RELAY_OLD_TGZ`）→ 发布前 `scripts/preflight.mjs` GREEN（本评审不跑这些）。
7. 人类批准后：`work/v3.4.6` ← merge `wip/relay-phase2-20261117`；合并后立即在 HEAD 树上复跑全量 + Phase 2 验证；合并前记录 HEAD hash 作为回滚点（回滚用 revert merge commit；新 state 文件可保留，旧代码忽略）。
8. 需要人类决定的事项：① 是否批准 merge 及方向（建议 HEAD←WIP）；② 缺失 ADR/滚动手册是否作为 merge 阻塞（建议是）；③ relay 版本口径（v3.1.0 relay feature / 不改设备 protocol_version / 由谁更新文档）；④ 删除语义：现在补 vs ADR 明确推迟；⑤ 提交策略：merge HEAD 进分支 + 独立编码修复 commit（推荐）vs 其他；⑥ 谁在哪些主机提供 3.0.0 archive 并跑三节点/混合验证。

## 7. 明确不做的事

- 不合并、不 rebase、不 push、不建/删分支、不打 tag。
- 不改任何代码、版本号、`package.json`、`CHANGELOG.md`、`PROTOCOL*.md`、备份/fix 代码。
- 不运行 `scripts/preflight.mjs`、`scripts/verify-*.mjs`、分支测试或全量套件（只跑了上面列出的当前树 relay 相邻 95 个用例）。
- 不发布、不部署、不碰其他项目；唯一新增文件是 `docs/REVIEW-RELAY-PHASE2-20261117.md`。

---

## 附录 A：关键证据与复现命令（只读，2026-11-17）

| 结论 | 命令 / 证据 |
|---|---|
| HEAD=`757e328`、分支=`8e90aed`、merge-base=`9bde53e`(tag v3.4.4) | `git rev-parse HEAD wip/relay-phase2-20261117; git merge-base work/v3.4.6 wip/relay-phase2-20261117` |
| 分支仅 1 提交、落后 HEAD 11 提交 | `git log --oneline work/v3.4.6..wip/relay-phase2-20261117` → 仅 `8e90aed`；`git log --oneline 9bde53e..work/v3.4.6` → 11 条 |
| 规模 20 文件 +5754/−115 | `git diff --stat work/v3.4.6...wip/relay-phase2-20261117` |
| 唯一文本冲突是 `package.json` | `git merge-tree --write-tree work/v3.4.6 wip/relay-phase2-20261117` → 结果树 `a0c70dc…` + `CONFLICT (content): Merge conflict in package.json` |
| HEAD 侧未改 relay/分支相关文件 | `git diff --name-only 9bde53e work/v3.4.6` 与分支变更清单交集 = 仅 `package.json`；`git ls-tree work/v3.4.6 src/relay/` 无 `chat-store.mjs`/`project-sync.mjs` |
| 编码损坏（5 文件，含对外错误文案） | 用 .NET `StandardOutputEncoding=UTF-8` 显式解码 `git show` 后统计：base `server.mjs` 有 `§`×49、`—`×27、`–`×2、`→`×2；分支同文件这些字符**全为 0**，变为 `U+6402`×49 等 GBK 乱码；其余 `project-locks`(2)、`project-notifications`(1)、`project-reviews`(2)、`test/cluster-domains`(1) 为同类 `§` 损坏 |
| 设计文档缺失 | `git cat-file -e work/v3.4.6:docs/RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md`（分支同）→ `does not exist` |
| 删除语义未闭环 | `git grep -n "deletedSessions\|_chatDeletedSessions" wip -- src/`：`load()` 返回 tombstone 但不按它过滤消息；`server.mjs` 3 处写入、0 处读取；`deleteSession` 全仓仅模块定义/导出，无 HTTP 调用点 |
| 死代码/重复实现 | `git grep -n "saveProjectObjects\|loadProjectObjects" wip -- src/` → 仅 `persistence.mjs` 定义，无调用者（`state.mjs` 用内联 `writeFileSync` 重复实现） |
| 新测试不在门禁 | `git show wip:package.json`：`test`/`test:all` 不含 chat-store/project-sync/cluster-domains，仅新增 5 个专用 script |
| 当前树基线绿 | 第 5 节 `node --test ...` → `tests 95 / pass 95 / fail 0` |
| 工作树状态 | `git status --short`：本评审的唯一改动是新增本文；`src/plugin/*` 的未提交改动（`tools.mjs`、`fleet-target.mjs`、新增 `version-gate.mjs` 等，评审期间还在变化）来自并行开发，与本评审无关、未触碰 |

> 编码注意事项：本机 PowerShell 的 `Get-Content` 默认按 ANSI/GBK 解码 UTF-8 文件，直接读会把正常的 UTF-8 中文显示成乱码，**不能**用作乱码判定；本文所有编码统计都用显式 UTF-8 解码 + base/branch 对照，避免误报。
