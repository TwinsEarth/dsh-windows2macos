# M3 Git 原生任务（worktree / patch / 合并队列 / MERGE_CONFLICT）设计规格

> 状态：**设计稿**。只定义工作区语义、制品契约、合并队列与冲突语义，不含实现。
> 版本：`1.3.4-beta.*`（GitHub prerelease，不入 npm）。
> 上游：`docs/MULTI-MACHINE-COLLABORATION-PLAN.md` M3；依赖 M2（合并任务需签名授权）。

---

## 1. 目标与非目标

### 目标

1. **隔离工作区**：每个任务在独立的 `git worktree` 里执行，起始点严格是任务声明的 `base_commit`；机器上其他任务、其他机器互不影响。
2. **可传输的改动**：任务产出是**内容寻址的制品**（patch/commit bundle + 元数据），不是"机器上的本地文件变了"。
3. **串行合并队列**：同一项目同一目标分支的合并严格串行；合并器只做"应用到当前 head → 校验 → 推进 ref"，绝不 force push、绝不静默覆盖。
4. **冲突一等公民**：无法应用/冲突时返回结构化 `MERGE_CONFLICT`（文件、hunk、base/ours/theirs、冲突制品），由人决定下一步，而不是失败日志里的一句话。
5. **可重放**：合并事件进 ledger；重放后分支 head 与已合并集合一致。

### 非目标（本版本不做）

- 不做"多仓库/多分支任意图"的编排（单项目 + 单目标分支；多分支留 M4/M5）。
- 不做自动解决冲突（冲突必须显式选择解决者）。
- 不做 PR 评审 UI（M4/M5）。
- 不做远程托管差异（GitHub/GitLab API 推送）——本版本只维护 relay 侧的项目 ref 与合并产物；推送镜像另立项。
- 不替代人的代码审查；合并前测试是否强制由项目策略决定（§6.4）。

---

## 2. 现状与缺口

| 现状 | 缺口 |
|---|---|
| 任务 = argv + 每台机器自己的项目副本 | 没有"任务专属工作区"，两次并发任务会互相踩 |
| `base_commit` 只用于**事后锚点一致性检查** | 没有"从 base_commit 开始、产出可合并增量"的语义 |
| 结果是 stdout/stderr/blob | 代码改动的结果没有结构（commit/tree/diff/patch 哈希） |
| 无合并概念 | 多台机器的改动无法合并，冲突无法表达 |

---

## 3. 任务种类（task kinds）

在现有 task 上新增**可选**字段（旧任务行为不变）：

```json
{
  "workspace": {
    "kind": "worktree",              // "copy"（默认，旧行为）| "worktree"
    "repo": "w2m-fleet-demo",        // 项目标识（relay project 对象，见 M4）
    "base_commit": "0e89dfb…",       // 必填，worktree 的起点
    "target_branch": "main",         // 合并目标；worktree 任务只读该值
    "cleanup": "on-success",         // on-success（默认）| keep（调试用）
    "allow_empty": true              // 无改动是否算成功（默认 true）
  },
  "produce": "patch"                 // "patch"（默认）| "commit"（保留完整提交对象）
}
```

| kind | 行为 | 结果 |
|---|---|---|
| `copy`（默认） | 旧行为：各机器原地副本，只读语义 | stdout/stderr/blob，与 v1.3.1 相同 |
| `worktree` | 在任务专属 worktree 执行，允许写 | patch/commit 制品 + 元数据；改动只在制品里 |
| `merge`（内部） | 由合并器执行，不允许用户直接指定 | 新 head 或 `MERGE_CONFLICT` |

`worktree` 任务的写约束：

- 允许写：**仅 worktree 目录内**（`cwd_rel` 必须落在 worktree 内）；
- 禁止：修改 `.git`（hooks/config 由执行器禁用）、写 worktree 之外、访问网络（除非任务显式声明，属后续 cap）；
- 同一机器同时活跃的 worktree 数量上限（默认 4），超限拒绝 `WORKTREE_LIMIT`；
- 执行前后都做 `git status --porcelain` 快照，用于审计"谁改了什么"。

---

## 4. Worktree 生命周期（执行器侧）

### 4.1 仓库缓存

```
<state>/repos/<repo-key>.git         bare 镜像（relay project 声明的 origin）
<state>/worktrees/<task_id>/<attempt>/   每个任务尝试一个 worktree
```

- 首次任务：`git clone --bare <origin> <repo-key>.git`（或从 relay 的制品种子引导）。
- 后续：`git fetch --prune` 后校验 `base_commit` 存在；不存在则 `BASE_COMMIT_UNKNOWN`。
- 网络不可用且本地已有 base_commit → 允许离线执行（结果仍是 patch，合并时再校验）。

### 4.2 创建/销毁

```
git -C <cache> worktree add --detach <wt> <base_commit>
# 固化隔离：
git -C <wt> config core.hooksPath /dev/null         # Linux；Windows 用空目录
git -C <wt> config user.name  "w2m-agent"
git -C <wt> config user.email "agent@w2m.invalid"
git -C <wt> config commit.gpgsign false
```

执行结束：

- 成功且有改动：提交（identity 固定）→ 生成制品 → 上传 → 按 `cleanup` 删除 worktree。
- 成功无改动：`no_change` 结果（仍上传空 patch 元数据，便于审计"确实没改"）。
- 失败/超时：删除 worktree（保留日志制品），`WORKTREE_CLEANUP` 失败只告警不覆盖主结果。
- GC：残留 worktree > 7 天由 agent 启动时清理（记录清理事件）。

### 4.3 锚点与一致性

- 结果必须带：`base_commit`、`head_commit`（若有提交）、`tree_sha`、`parent`、`files_changed[]`、`diffstat`。
- 执行器校验 `git merge-base --is-ancestor <base_commit> HEAD`（worktree 内 HEAD 就是提交链）。
- 合并器再校验一次（§6.3），防止"结果被篡改/分支被移动"。

---

## 5. 制品契约（patch artifact）

结果 JSON（新增字段，旧字段保留）：

```json
{
  "workspace": { "kind": "worktree", "repo": "w2m-fleet-demo", "worktree": "/…/wt", "cleaned": true },
  "patch": {
    "format": "git-format-patch|git-diff-binary",
    "sha256": "内容哈希",
    "bytes": 12345,
    "output_mode": "blob|inline",
    "base_commit": "…",
    "head_commit": "…",
    "tree": "…",
    "parent": "…",
    "files_changed": ["src/a.mjs", "test/a.test.mjs"],
    "diffstat": { "files": 2, "insertions": 30, "deletions": 4 },
    "empty": false
  },
  "tests": { "ran": true, "exit_code": 0, "summary": "…" }
}
```

- 大 patch 走既有 blob 通道（内容寻址，sha 即名字）；小 patch 内联。
- **patch 不是可信输入**：合并器只接受"从 base_commit 生成的 patch"，且重新计算 sha 比对；不接受任意 diff。
- `format: git-format-patch` 时禁止包含 merge commit、签署签名外的元数据；`git-diff-binary` 用于二进制文件（需显式 allow）。

---

## 6. 合并队列（Merge Queue）

### 6.1 队列模型

```
project: w2m-fleet-demo
target_branch: main
queue item: { queue_id, patch_sha, base_commit, source_task_id, submitted_by, submitted_at, state }
state: queued → claimed → applying → merged | conflict | failed
```

- 每个 `(project, target_branch)` 一个队列；**同一时刻只有一个合并器持有队列锁**（reuse lease 机制，新 lease kind `merge-slot`，TTL 10 分钟，心跳续租）。
- 合并器机器：项目配置指定（默认 relay 所在机器 / 指定 machine_id）；必须通过 M2 grant 授权合并任务的命令行。
- 队列 item 可带 `depends_on`（例如依赖某个测试任务完成）。

### 6.2 合并流程（固定顺序）

```
1. 取队首 item
2. 校验：patch_sha 一致；item.base_commit 是当前 head 的祖先（否则进入 §6.3 重放策略）
3. 在合并专用 worktree（detached at 当前 head）中 git apply --3way 或 git am
   · 成功 → 进入 4
   · 冲突 → 生成 MERGE_CONFLICT（§7），item 终止，不推进 head
4. 可选验证：项目策略要求时，跑验证任务（测试/锚点），失败则 item 终止（head 不变）
5. 推进 head：fast-forward 到新提交（或按策略生成 merge commit）
6. ledger 事件：project.ref.updated {from, to, patch_sha, queue_id, task_id}
7. 发布：GET project ref 的读者看到新 head；触发 M4 项目房间事件
8. 锁释放，处理下一个 item
```

### 6.3 base 前进时的重放策略（三种，项目配置选一）

| 策略 | 行为 | 结果 |
|---|---|---|
| `strict`（默认） | base_commit 必须等于当前 head（完全线性） | 否则 `BASE_MISMATCH`，提交者需 rebase 重交 |
| `replay` | 若 patch 能干净应用到新 head 上则重放（`git apply --3way`），否则冲突 | 成功 = 新 merge；冲突 = `MERGE_CONFLICT` |
| `queue-base` | 合并队列内部维护"虚拟 head"（前一个 item 的后状态），后续 item 按队列顺序依次应用 | 保证提交顺序但不保证等价于最新 head |

> beta 建议：默认 `strict`（最容易验证正确性），`replay` 作为显式选项。

### 6.4 测试门禁（可配置）

- 项目策略 `merge_requires_tests: true|false`（默认 false）。
- true 时：合并前必须有一个同 patch_sha 的测试任务 `status=ok`（由 M2 grant 授权执行），否则 item 停在 `queued`，返回 `TESTS_REQUIRED`。
- 测试通过后仍需锚点校验；不通过则 item `failed`（head 不动）。

---

## 7. MERGE_CONFLICT：一等结果

冲突不是异常，而是**任务结果**：

```json
{
  "status": "conflict",
  "refusal_reason": "MERGE_CONFLICT",
  "merge": {
    "queue_id": "…",
    "patch_sha": "…",
    "target_head": "…",
    "files": ["src/a.mjs"],
    "hunks": [{ "file": "src/a.mjs", "start": 10, "lines": 4, "side": "ours|theirs|both" }],
    "artifact": { "sha256": "冲突现场 patch（带 conflict markers）", "output_mode": "blob" },
    "base_commit": "…", "ours_commit": "…", "theirs_commit": "…",
    "next": "由人选择解决者：重新提交到新 base / 手动解决后作为新 patch 入队"
  }
}
```

规则：

- 冲突时**绝不推进 head**，绝不覆盖任何人的改动。
- 冲突现场（含 conflict markers 的 diff）作为 blob 保存，任何有权限的客户端可下载。
- 冲突任务的 `source_task_id` 与提交者可见；M4/M5 的审查任务可以引用它。
- 队列 item 不会自动重试冲突（避免抖动）；提交者修好后作为**新 item** 入队。

---

## 8. 失败码

```
WORKTREE_LIMIT            并发 worktree 超限
BASE_COMMIT_UNKNOWN       仓库里没有该 base_commit
BASE_MISMATCH             strict 策略下 base 不等于当前 head
PATCH_SHA_MISMATCH        制品被篡改或损坏
PATCH_APPLY_FAILED        patch 无法应用（非冲突性错误）
MERGE_CONFLICT            结构化冲突（§7）
TESTS_REQUIRED            策略要求测试但不存在通过的测试任务
TEST_FAILED_AFTER_MERGE   验证失败，未推进 head
MERGE_ABORTED             合并器异常中断（锁过期后由下一个合并器恢复）
NOT_MERGE_EXECUTOR        非指定合并器持有 merge-slot
FORCE_PUSH_REFUSED        任何试图改写历史的行为一律拒绝（红线）
```

---

## 9. 与 M2 / M4 的关系

- **M2 grant**：合并任务（`git apply`/`git merge`/`git push` 到 relay ref）属于清单外命令，必须由操作员 grant 授权；`worktree` 任务的普通改动不需要 grant（写限制在隔离工作区）。
- **M4 项目房间**：`project.ref.updated` 是项目房间的事件；任务板展示 queued/merged/conflict；制品（patch/conflict）挂在项目下。
- **M5 多客户端**：分支锁（避免两个合并器同时写同一分支）由 merge-slot 保证；审查任务可作为 merge item 的前置条件。

---

## 10. 验收（真实任务）

### 正向

1. **两机并行修不同文件**：A/B 各自 worktree 任务 → 各自 patch 入队 → 合并器先 A 后 B → 最终 head 包含两者改动，测试通过，ledger 两条 `project.ref.updated`。
2. **无改动任务**：worktree 任务不产生 diff → `no_change` 成功，不入队。
3. **冲突**：A/B 改同一文件同一处 → 第二个 item 返回 `MERGE_CONFLICT`，文件列表正确，冲突 blob 可下载，head 不变。
4. **base 前进**：A 提交后 B 基于旧 base 提交 → `strict` 下 B 得到 `BASE_MISMATCH`；`replay` 下若 B 的改动可干净应用则自动合并。
5. **测试门禁**：策略开启 + 无测试任务 → `TESTS_REQUIRED`；补测试通过后自动继续合并。
6. **重放/幂等**：同一 patch 重复入队 → 第二次被识别为已合并（`already_merged`），不产生重复提交。

### 负向（自动化）

```
篡改 patch sha / 非 worktree 产出的 patch / patch 含 merge commit /
越过 worktree 写文件 / .git 目录改动 / 非合并器推进 ref / force push /
worktree 超限 / 合并中断后锁恢复 → 全部对应错误码且 head 不变
```

---

## 11. 交付物清单（实现阶段）

```
src/agent/worktree.mjs          worktree 创建/隔离/清理/GC、改动快照
src/agent/patch-artifact.mjs    commit/patch 生成、sha、blob 上传、结果字段
src/relay/merge-queue.mjs       队列、merge-slot lease、item 状态机、ledger 事件
src/relay/project-ref.mjs       project/branch ref 存储与 GET 接口
src/relay/merge-executor.mjs    合并执行（apply/验证/推进/冲突制品）——可在 relay 或独立机器
src/plugin/tools.mjs            派发 worktree 任务；查看队列；下载冲突制品（小改）
src/relay/server.mjs            /v1/projects/:id/queue、/v1/projects/:id/ref 路由
test/worktree.test.mjs          worktree 生命周期/隔离/GC
test/patch-artifact.test.mjs    制品契约/不可信输入校验
test/merge-queue.test.mjs       队列串行/重试/幂等/锁恢复
test/merge-conflict.test.mjs    MERGE_CONFLICT 结构与 head 不变
test/git-native-e2e.test.mjs    双机双 worktree → 合并（本地 relay + 临时仓库）
```

## 12. 开放问题（实现前确认）

1. **仓库来源**：relay project 的 origin 指向哪个仓库（GitHub 私仓？本机 bare 镜像？）；推送只到 relay ref 还是也镜像到 GitHub？
2. **合并器位置**：合并器跑在 relay 主机（jp-shared）还是指定一台独立机器？——影响 M2 grant 的机器集合与权限。
3. **base 策略默认值**：`strict`（推荐）还是 `replay`？
4. **测试门禁默认**：默认不开（false）还是强制开（true）？强制开需要先有测试任务模型。
5. **分支范围**：beta 只支持一个目标分支（main）还是允许按任务指定分支？
6. **Windows 路径**：TwinsEarth 作为 worktree 执行者时，大小写不敏感文件系统与 symlink 的约束（现有 caps 已暴露 `case_sensitive_fs:false`），是否需要显式限制某些 patch（如重命名大小写）？
