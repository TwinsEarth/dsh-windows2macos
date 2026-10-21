# 任务模型（Task Model）设计规格 — v1.4.1-beta

> 状态：**模型级设计稿**。把 M3（worktree/patch/合并队列/冲突）与既有任务/数据面能力归纳为统一任务模型，冻结任务种类、工作区、制品、分支与合并语义。
> 版本：`1.4.1-beta.*`；实现按 M3（1.3.4）与 M5 的审查/锁（1.3.6）分步交付，模型一致性验收在 1.4.1-beta 完成。
> 相关：`docs/COLLAB/M3-GIT-NATIVE-TASKS.md`、`docs/COLLAB/M5-MULTI-CLIENT-PRIMITIVES.md`、`docs/COLLAB/EXECUTION-AUTH-MODEL.md`。

---

## 1. 问题陈述

现状的任务模型只有三个要素：

```
任务 = argv + 每台机器自己的项目副本 + 事后锚点一致性检查
```

它隐含三个假设，全部与现实不符：

1. **假设只读**：任务不会改动代码；但真实开发必须改。
2. **假设幂等**：重试安全；但写文件/提交不幂等，重试会产生两份改动。
3. **假设结果只是文本**：stdout/stderr；但代码改动需要**可合并的制品**（commit/tree/patch）与**冲突语义**。

后果：多台机器只能"各自跑命令"，无法共同完成一个改动；没有分支/合并/冲突，就没有"联合开发"。

---

## 2. 任务模型总览

```
Task = 意图 + 输入 + 工作区 + 义务 + 结果 + 证据

意图      kind（exec/worktree/merge/review/maintenance）
输入      argv、argv 约束、base_commit、project/branch、依赖、授权能力
工作区    none / copy（旧行为）/ worktree（隔离）
义务      gates：测试门禁、审查门禁、锁、锚点
结果      结构化信封：status/outcome + artifacts + workspace 证据 + tests
证据      ledger 事件 + 内容寻址制品 + 签名/授权来源（provenance）
```

任务模型与另外两个模型的分工：

| 模型 | 回答的问题 |
|---|---|
| 执行授权模型（v1.4.0） | 这台机器**能否执行**这条命令/这次维护 |
| **任务模型（本文）** | **执行什么、在哪个工作区、产出什么、如何合并** |
| 协作模型（v1.4.2） | **谁在哪个项目/房间**与谁协作、权限与通知 |

---

## 3. 任务种类（kind）与副作用分类

| kind | 工作区 | 副作用 | 执行者 | 重试语义 |
|---|---|---|---|---|
| `exec` | none/copy | 只读（红线保证） | agent | 可自由重试（幂等由只读保证） |
| `worktree` | 隔离 worktree | 改动代码（制品化） | agent | 新尝试 = 新 worktree（丢弃半成品） |
| `merge` | 合并专用 worktree | 推进项目 ref | 指定合并器（M2 grant） | 幂等（patch_sha+head 去重，已合并即 no-op） |
| `review` | 无 | 无代码副作用（结论） | 人/客户端 | 幂等（重复结论拒绝） |
| `maintenance` | 无 | root 系统动作 | root runner | 幂等（request_id） |

**副作用分类是模型的根**：任务的幂等/重试/隔离策略由副作用类型决定，而不是由调用方口头声明。

---

## 4. 工作区模型

### 4.1 三种工作区

| workspace.kind | 语义 | 隔离 | 用于 |
|---|---|---|---|
| `none` | 不提供项目副本（纯命令） | 与机器其他任务共用 | 诊断类 exec |
| `copy`（兼容默认） | 机器上的现有项目副本 | 无（v1.3.x 行为） | 既有调用方 |
| `worktree` | 每任务独立 git worktree，起点=base_commit | 强隔离 | 所有会产生代码改动的任务 |

### 4.2 worktree 不变量

1. 起始点严格等于 `base_commit`（不存在则 `BASE_COMMIT_UNKNOWN`）。
2. 写权限**仅限 worktree 内**；`.git` 管理目录由执行器接管（hooks/config 禁用）。
3. 任务结束：成功 → 制品化（commit/patch）→ 清理；失败/超时 → 丢弃 worktree。
4. 并发上限（默认 4/机器）；超限 `WORKTREE_LIMIT`。
5. 执行前后取 `git status` 快照，作为证据的一部分。
6. 同一 base 上的两个任务互不可见；合并时才相遇。

### 4.3 为什么不是"各自副本"

`copy` 工作区无法回答"这台机器的改动是相对哪个版本"，也无法隔离并发任务。`worktree` 让改动**总是相对一个明确 base**，从而可传输、可合并、可审计。

---

## 5. 制品模型（Artifact）

制品是任务结果的**一等公民**，内容寻址且不可变：

```json
{
  "sha256": "…",
  "kind": "patch|conflict|diagnostic|report|log|binary",
  "bytes": 12345,
  "output_mode": "inline|blob",
  "label": "patch for 01M6…",
  "produced_by": { "task_id": "…", "machine_id": "…", "attempt": 1 },
  "basis": { "base_commit": "…", "head_commit": "…", "tree": "…" },
  "created_at": "…"
}
```

规则：

- **上传完成前不可引用**；引用后内容不可变（sha 就是身份）。
- `patch` 制品必须携带 `base_commit` 与头部提交信息；合并器只接受"从声明的 base 生成"的 patch，并重新计算 sha 校验。
- `conflict` 制品是冲突现场（含 conflict markers 的 diff），任何项目成员可下载。
- 制品可超过内联阈值 → M6 分块/blob 通道；大 patch 不阻塞任务上报。
- 制品生命周期与项目绑定（M4）；默认保留 30 天，可选永久（发布附件）。

---

## 6. 分支与合并模型

### 6.1 分支

- 项目（M4）拥有一个或多个分支 ref；任务声明 `target_branch`。
- `base_commit` 必须属于目标分支历史（合并器校验）。
- 分支 head **只由合并任务推进**；agent 绝不直接写项目 ref。
- 红线：禁止 force push/改写历史（`FORCE_PUSH_REFUSED`）；head 单调前进。

### 6.2 合并队列

```
(queue per project+branch)
  item = {queue_id, patch_sha, base_commit, source_task_id, submitted_by, state}
  state: queued → claimed → applying → merged | conflict | failed
```

- 同一队列同一时刻一个合并器（merge-slot lease，M5 的锁是用户级协调，二者互补）。
- 合并步骤固定：取队首 → 校验 patch_sha/base → `git apply --3way`/`git am` → 门禁 → 推进 head → 事件 → 释放。
- 合并策略（项目配置）：
  - `strict`（默认）：base 必须等于当前 head，否则 `BASE_MISMATCH`
  - `replay`：能干净应用到新 head 则重放，否则冲突
  - `queue-base`：按队列顺序依次应用（顺序保证，不等价最新 head）
- 门禁（可组合）：测试门禁（同 patch_sha 测试任务通过）、审查门禁（同 patch_sha 有 approved 审查）、锁门禁（enforced 分支/文件锁）。
- 幂等：同一 `(patch_sha, target_head)` 已合并 → `already_merged`（no-op）；重放/重试安全。

### 6.3 冲突是一等结果

```json
{
  "status": "conflict",
  "reason_code": "MERGE_CONFLICT",
  "merge": {
    "patch_sha": "…", "target_head": "…", "base_commit": "…",
    "files": ["src/a.mjs"],
    "hunks": [{"file": "src/a.mjs", "start": 10, "lines": 4, "side": "both"}],
    "artifact_sha256": "冲突现场（blob）",
    "next": "由人选择解决者：重新提交到新 base / 手动解决后作为新 patch 入队"
  }
}
```

- 冲突时**绝不推进 head、绝不覆盖任何人的改动**。
- 不自动重试（防抖动）；解决方式是新 patch 入队。
- 冲突现场可被审查任务、项目房间、通知引用（M4/M5）。

---

## 7. 结果信封与证据

任务结果统一为结构化信封（向后兼容既有字段）：

```json
{
  "task_id": "…", "attempt": 1, "kind": "worktree",
  "status": "ok|failed|refused|conflict|timeout|expired",
  "outcome": "ok|no_change|merged|already_merged|…",
  "reason_code": null,
  "authorization": { "provenance": "grant|allow-list|maintenance", "capability_id": "…" },
  "workspace": { "kind": "worktree", "base_commit": "…", "head_commit": "…", "tree": "…", "cleaned": true },
  "artifacts": [{ "sha256": "…", "kind": "patch", "bytes": 1234, "output_mode": "blob" }],
  "tests": { "ran": true, "exit_code": 0, "summary": "…" },
  "evidence": { "status_before": "…", "status_after": "…", "diffstat": {…} },
  "timings": { "started_at": "…", "ended_at": "…", "duration_ms": 1234 }
}
```

规则：

- 结果必须可**仅凭信封**回答：执行了什么（授权来源）、在什么基础上、产出了什么（制品 sha）、有没有门禁。
- 不引用不存在的制品；上传失败 → `BLOB_UPLOAD_FAILED`（任务失败而不是静默降级）。
- 结果进 ledger，可重放；`provenance` 用于审计"哪次显式授权"。

---

## 8. 状态机与重试

```
created → queued(waiting: deps/locks/gates) → offered → running → reporting → terminal
terminal = done | failed | refused | conflict | timeout | expired | cancelled

merge 任务：queued → claimed → applying → merged | conflict | failed
retry 规则（按副作用）：
  exec：可直接重试（只读），attempt += 1
  worktree：重试 = 新 worktree（从同一 base），旧产物丢弃并记录
  merge：重试 = 重新入队（幂等）；已合并则 no-op
  maintenance：重试 = 同 request_id（幂等），已执行返回既有结果
  任何重试都必须保留 attempt 与去重键，防止双执行
```

关键不变量：

1. **at-most-once 副作用**：同一 `(task_id, attempt, dedupe_key)` 最多执行一次。
2. **结果幂等**：relay 对重复结果去重；agent outbox（M6）保证最终投递。
3. **不悬挂**：租约过期后任务可重派发；策略（halt）决定是否由其他机器接手。

---

## 9. 失败分类（模型级）

```
输入类：BASE_COMMIT_UNKNOWN、BASE_MISMATCH、PATCH_APPLY_FAILED、ARTIFACT_UNKNOWN
资源类：WORKTREE_LIMIT、BLOB_QUOTA、OUTBOX_FULL
门禁类：TESTS_REQUIRED、REVIEW_REQUIRED、LOCK_WAIT_TIMEOUT、PATH_LOCK_CONFLICT
合并类：MERGE_CONFLICT、FORCE_PUSH_REFUSED、NOT_MERGE_EXECUTOR、MERGE_ABORTED
授权类：RED_LINE_VIOLATION、NOT_AUTHORIZED、GRANT_*、MAINTENANCE_*
传输类：BLOB_INCOMPLETE、BLOB_SHA_MISMATCH、SESSION_NOT_FOUND
```

每类都必须有负向测试（M7 的 negative matrix）。

---

## 10. 兼容与迁移

- 新字段全部可选；`kind` 缺省 = `exec`，`workspace.kind` 缺省 = `copy` → 既有调用方行为不变。
- 旧 relay 忽略新字段；旧 agent 按旧逻辑执行（可能拒绝或只读）。
- 旧任务（无 project_id）惰性归入 default 项目（M4）；不重写 ledger。
- 迁移路径：`exec/copy` → 逐步把写任务切到 `worktree`；合并队列按项目启用（默认不启用，显式开启）。

---

## 11. 验收（模型一致性）

### 正向（真实任务证据）

1. **联合改动**：两机各自 worktree 任务（不同文件）→ 两个 patch 入队 → 合并器依次合并 → 项目 head 含两者改动，测试通过，两条 ref.updated 事件。
2. **冲突**：两机改同一处 → 第二个 item 返回结构化 `MERGE_CONFLICT`（文件/hunk/现场 blob），head 不变。
3. **base 前进**：strict 下返回 `BASE_MISMATCH`；replay 下干净应用则自动合并。
4. **门禁**：测试/审查/锁门禁分别挡住合并，满足后续行。
5. **幂等**：同 patch 重复入队 → `already_merged`；worktree 任务重试不产生两份改动。
6. **结果证据**：每个任务信封能独立回答"授权来源/base/制品/门禁"。

### 负向（自动化矩阵）

```
非 worktree 产出的 patch / 篡改 sha / 写 .git / 直接改项目 ref / force push /
merge 中断后锁恢复 / worktree 超限 / 冲突被误判为成功 / 缺门禁仍合并 /
重试双执行 / 结果引用不存在的 blob → 全部对应错误码且 ref 不变
```

---

## 12. 与版本/模块的映射

```
1.3.4-beta  M3 实现：worktree/patch/合并队列/冲突（本章 §4–§7 的落地）
1.3.6-beta  M5 实现：锁与审查任务（本章门禁部分）
1.4.1-beta  模型一致性验收：统一 kind/结果信封/幂等语义/失败分类
共享模块：
  src/relay/task-model.mjs      任务种类与状态机、副作用分类
  src/relay/merge-queue.mjs     队列/merge-slot/门禁/幂等
  src/relay/project-ref.mjs     分支 head 与单调推进
  src/agent/worktree.mjs        工作区生命周期（M3）
  src/agent/patch-artifact.mjs  制品生成/上传/证据
```

## 13. 开放问题（实现前确认）

1. **写任务的默认 kind**：显式 `worktree` 才允许写（推荐），还是 copy 也允许写（兼容但危险）？
2. **仓库来源**：项目 origin 指向 GitHub 私仓还是 relay 本机 bare？合并在哪一侧执行？
3. **合并策略默认**：strict（推荐）还是 replay？
4. **门禁默认**：测试/审查默认关闭、按项目开启（推荐）？
5. **非 git 项目**：是否支持"无 git 的 worktree"（文件级快照/补丁）还是只支持 git？
6. **Windows**：大小写不敏感与 symlink 限制如何表达（限制 patch 内容/仅告警）？
7. **制品保留**：30 天默认够不够？发布附件是否永久保留？
