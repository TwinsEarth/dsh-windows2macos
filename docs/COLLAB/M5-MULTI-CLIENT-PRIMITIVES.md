# M5 多客户端原语（分支/文件锁、审查任务、通知）设计规格

> 状态：**设计稿**。只定义锁、审查、通知三个原语的模型与语义，不含实现。
> 版本：`1.3.6-beta.*`（GitHub prerelease，不入 npm）。
> 上游：`docs/MULTI-MACHINE-COLLABORATION-PLAN.md` M5；依赖 M3（合并队列）、M4（项目房间/事件）。

---

## 1. 目标与非目标

### 目标

1. **避免互相踩**：分支锁与文件锁让两个客户端/机器在改同一处之前先协商；冲突在**发生前**暴露，而不是合并时才发现。
2. **审查成为一等任务**：补丁/改动可以要求审查；审查结论（批准/要求修改）进入项目账本，并可作为合并前置条件。
3. **通知可达且不丢**：任务分配、审查请求、锁冲突、合并结果、分支推进等事件能定向送达；离线客户端回来能补齐；按客户端维护已读水位。
4. **全部可审计**：锁的获取/续租/强制释放、审查结论、通知投递都进项目事件流与 ledger。

### 非目标（本版本不做）

- 不做跨项目锁、不做目录级递归锁（只到分支 + 文件路径）。
- 不做自动抢占/自动释放冲突的"聪明策略"——过期才可重入，强制释放必须显式且留痕。
- 不做外部通知渠道（邮件/Webhook/IM）——本版本只有项目房间内通知（SSE + 未读水位）。
- 不做多人账号体系（身份仍为 machine + operator，与 M4 一致）。

---

## 2. 原语一：分支锁 / 文件锁

### 2.1 锁对象

```json
{
  "lock_id": "01M6…",
  "project_id": "…",
  "kind": "branch|file",
  "target": { "branch": "main" } | { "path": "src/a.mjs" },
  "mode": "exclusive",
  "holder": { "kind": "machine|operator", "id": "…" },
  "reason": "改 auth 模块（任务 01M6…）",
  "acquired_at": "…",
  "expires_at": "…",
  "lease_ms": 1800000,
  "renewed_at": "…"
}
```

- 分支锁：`(project_id, branch)` 唯一；文件锁：`(project_id, path)` 唯一。
- 同一 target 同一时刻只允许一个 exclusive holder；无共享锁（读不需要锁）。
- TTL 默认 30 分钟；持有人每 5 分钟续租（客户端心跳）；过期自动释放（事件 `lock.expired`）。
- 持有者可以主动释放；被他人持有不可抢占（除非过期）。
- **强制释放**：owner 可 `force_release`，必须带 reason，事件 `lock.force_released` 记 who/why，通知原持有人。

### 2.2 强制级别（项目设置）

| 模式 | 行为 |
|---|---|
| `advisory`（默认） | 只记录与展示；获取冲突时返回 `LOCK_HELD` 但调用方可选择继续（`force: true` 需有权限，事件记录） |
| `enforced` | 获取失败即阻止：worktree 任务/合并提交在创建时检查锁，冲突直接拒绝（`LOCK_HELD`），不会进入队列 |

强制级别只对"声明了 target_branch / 涉及文件路径"的写任务生效（`workspace.kind=worktree` 且 `produce=patch/commit`）；只读任务不需要锁。

### 2.3 与 M3 合并队列的关系

- 合并队列的 `merge-slot` 是**系统级串行化**（保证同一时刻一个合并器）。
- 分支锁是**用户级协调**（保证两个提交者不在同一分支上互相覆盖意图）。
- 合并时若目标分支被他人持有锁且模式为 `enforced`：合并项排队等待（`waiting_on: lock:<id>`），锁释放后继续；等待超过 `expires_at` 则失败 `LOCK_WAIT_TIMEOUT`。
- 文件锁在合并时用于**冲突预检**：队列里两个 item 的 `files_changed` 有交集且各自目标文件被 lock 覆盖 → 后一个 item 等待或提示冲突（`PATH_LOCK_CONFLICT`）。

### 2.4 API 与错误码

```
GET    /v1/projects/:id/locks
POST   /v1/projects/:id/locks            {kind, target, lease_ms, reason, mode?}
POST   /v1/projects/:id/locks/:lock_id/renew
DELETE /v1/projects/:id/locks/:lock_id   （holder）
DELETE /v1/projects/:id/locks/:lock_id?force=1&reason=…   （owner）
```

```
LOCK_HELD                 目标已被持有（返回 holder + expires_at）
LOCK_NOT_OWNER            非 holder 续租/释放
LOCK_EXPIRED              操作时已过期
LOCK_FORCE_DENIED         无 owner 权限或缺少 reason
LOCK_WAIT_TIMEOUT         合并等待锁超时
PATH_LOCK_CONFLICT        文件锁与队列内已有改动重叠
LOCK_LIMIT                单项目/单持有者锁数量超限（默认 20/10）
```

---

## 3. 原语二：审查任务（review）

### 3.1 定位

审查是**控制面任务**（不需要目标机器执行命令）：它指向一个制品/补丁，由有权限的审查者给出结论，结论进入项目事件流与 ledger，并可作为合并前置条件。

```json
{
  "review_id": "01M6…",
  "project_id": "…",
  "target": { "kind": "patch|artifact", "sha256": "…", "source_task_id": "…", "diffstat": {…} },
  "requested_by": { "kind": "machine|operator", "id": "…" },
  "reviewers": [{ "kind": "machine|operator", "id": "…" }],
  "required_approvals": 1,
  "status": "pending|approved|changes_requested|expired|cancelled",
  "decisions": [
    { "reviewer": {…}, "decision": "approve|changes_requested|comment",
      "comment": "…", "findings": [{"file":"src/a.mjs","line":10,"severity":"high|medium|low","text":"…"}],
      "decided_at": "…" }
  ],
  "due_at": "…"
}
```

规则：

- 审查者必须具有 `maintainer` 或 `owner` 角色；`worker` 不能当审查者。
- **禁止自审**：`requested_by` 与 reviewer 相同 → `REVIEW_SELF_NOT_ALLOWED`（owner 可 override，但事件标记 `self_review_override`）。
- 批准数达到 `required_approvals` → `approved`；任一人 `changes_requested` → `changes_requested`（可由提交者重新提交新 revision 触发新一轮）。
- 审查结论不可改（审计），改变结论需要新的 decision 记录（`REVIEW_ALREADY_DECIDED` 拒绝重复同向结论）。
- 过期未处理 → `expired`（可重建新审查）。
- 审查证据引用内容寻址制品（patch、测试结果、diffstat），审查者客户端按 sha 拉取。

### 3.2 与合并门禁

项目设置 `merge_requires_review: true` 时，M3 合并队列在应用前检查：同一 `patch_sha` 存在 `approved` 审查；否则 item 停在 `queued` 返回 `REVIEW_REQUIRED`。测试门禁（M3）与审查门禁相互独立，可同时开启。

### 3.3 API 与错误码

```
POST /v1/projects/:id/reviews              创建（requested_by 有权限）
GET  /v1/projects/:id/reviews?status=…
GET  /v1/projects/:id/reviews/:review_id
POST /v1/projects/:id/reviews/:review_id/decisions   {decision, comment, findings}
```
```
REVIEW_PERMISSION         无 maintainer/owner 角色
REVIEW_SELF_NOT_ALLOWED   自审且未 override
REVIEW_ALREADY_DECIDED    重复同向结论
REVIEW_EXPIRED            过期后提交
REVIEW_TARGET_UNKNOWN     目标 sha 不在制品索引
REVIEW_REQUIRED           合并门禁挡住（M3 返回）
```

---

## 4. 原语三：通知（notifications）

### 4.1 通知对象

```json
{
  "notification_id": "01M6…",
  "project_id": "…",
  "kind": "task.assigned|review.requested|review.decided|lock.conflict|merge.conflict|merge.merged|ref.updated|mention|maintenance.result",
  "target": { "kind": "machine|operator", "id": "…" } | { "kind": "broadcast" },
  "subject": "短标题",
  "refs": { "task_id": "…", "review_id": "…", "lock_id": "…", "merge_queue_id": "…", "sha256": "…" },
  "created_at": "…",
  "requires_action": true
}
```

### 4.2 投递与已读

- 投递路径：项目事件流 `notification.created`（SSE 实时）+ `GET /v1/projects/:id/notifications?since_ms=…`（离线补齐）。
- 已读水位：按客户端身份（machine_id 或 operator name）维护 `read_watermark`（ms）；`GET …/notifications/unread` 返回 `since read_watermark` 的计数与摘要。
- 去重：同一 `(kind, refs 主键, target)` 60 秒内只产生一条。
- 限流：单项目 ≤ 120 条/分钟，超出合并为 `digest`（摘要一条，含 count）。
- 保留：通知保留 7 天或 2000 条/项目（取小）；已读回执只存水位，不存逐条已读。
- 权限：只有项目成员能读该项目通知；非成员不泄露。

### 4.3 API

```
GET  /v1/projects/:id/notifications?since_ms=…&limit=…
GET  /v1/projects/:id/notifications/unread
POST /v1/projects/:id/notifications/read   {watermark_ms}
```
```
NOTIFICATION_RATE_LIMITED  被合并为 digest（不是错误，返回 digest id）
NOTIFICATION_FORBIDDEN     非成员
```

---

## 5. 权限矩阵（叠加 M4 角色）

| 动作 | owner | maintainer | worker | observer |
|---|---|---|---|---|
| 获取分支/文件锁 | ✅ | ✅ | ✅ | ❌ |
| 强制释放锁 | ✅ | ❌ | ❌ | ❌ |
| 创建审查 | ✅ | ✅ | ✅（请求他人审） | ❌ |
| 作为审查者裁决 | ✅ | ✅ | ❌ | ❌ |
| 读通知 | ✅ | ✅ | ✅ | ✅ |
| 标记已读 | ✅ | ✅ | ✅ | ✅ |

---

## 6. 并发与一致性要点

1. **锁获取必须是原子 CAS**：relay 单线程处理请求，`(target)` 上已有未过期 holder 则失败；并发同请求只一个成功（集成测试覆盖 10 并发）。
2. **锁/审查/通知状态变更都写项目事件 + ledger**；重启后从状态文件 + ledger 恢复。
3. **过期清理**：relay 周期扫描（复用 lease sweep 节奏），过期锁写 `lock.expired` 并通知原持有人。
4. **客户端离线**：锁过期后回归即可再获取；被通知的事件按 since 补齐。
5. **时钟**：服务端时间权威；客户端只用水位比较，不自行判定过期。

---

## 7. 验收（真实任务）

### 正向

1. **分支锁**：客户端 A 获取 main 锁 → B 获取返回 `LOCK_HELD`（含 holder/expires）→ A 释放后 B 成功；SSE 两侧都收到 lock 事件。
2. **enforced 模式**：项目切到 enforced 后，B 在无锁情况下创建 worktree 写任务被拒（`LOCK_HELD`），A 释放后成功。
3. **锁过期**：A 持锁不续租，TTL 到期后 B 可获取；A 收到 `lock.expired` 通知。
4. **强制释放**：owner 强制释放 A 的锁，带 reason；A 收到通知；事件含 who/why。
5. **审查通过**：A 提交 patch → 创建审查指派 B → B 批准 → 合并门禁放行。
6. **审查拒绝**：B 提 `changes_requested` + 行级 findings → A 客户端看到→ 重新提交新 revision。
7. **自审禁止**：A 指派自己 → `REVIEW_SELF_NOT_ALLOWED`。
8. **通知补齐**：B 离线期间发生任务分配/审查请求 → 重新连上后 unread 计数正确、事件按 since 补齐、标记已读后归零。

### 负向（自动化）

```
10 并发抢同一分支锁 → 恰好 1 成功
非 holder 续租/释放 → LOCK_NOT_OWNER
非 owner 强制释放 → LOCK_FORCE_DENIED
worker 审查裁决 → REVIEW_PERMISSION
重复 approve → REVIEW_ALREADY_DECIDED
非成员读通知 → NOTIFICATION_FORBIDDEN
通知风暴 500 条/分钟 → digest 合并且不丢事件
过期锁被操作 → LOCK_EXPIRED
```

---

## 8. 交付物清单（实现阶段）

```
src/relay/locks.mjs           锁的原子获取/续租/释放/过期/强制释放、限流
src/relay/reviews.mjs         审查对象、权限、自审、结论状态机、合并门禁查询
src/relay/notifications.mjs   通知生成/去重/限流/digest/未读水位、SSE 事件
src/relay/server.mjs          /v1/projects/:id/{locks,reviews,notifications} 路由
src/relay/state.mjs           lock/review/notification 状态持久化 + 事件
src/plugin/tools.mjs          锁/审查/通知的工具入口（实现时定名）+ 任务声明锁
src/plugin/fleet-chat-route.mjs  宿主代理上述只读/操作接口
lib/client.js                 面板：锁列表、审查列表/裁决、通知铃铛与未读
test/locks.test.mjs           并发/过期/强制释放/权限
test/reviews.test.mjs         状态机/自审/合并门禁/权限
test/notifications.test.mjs   去重/限流/digest/未读水位/离线补齐
test/m5-e2e.test.mjs          双客户端：锁冲突→审查→合并门禁（模拟）
docs/COLLAB/M5-MULTI-CLIENT-PRIMITIVES.md  本文
```

## 9. 开放问题（实现前确认）

1. **锁强制级别默认**：`advisory`（推荐，先展示再用）还是 `enforced`？
2. **文件锁粒度**：精确路径即可，还是需要 glob/目录模式（如 `src/**`）？
3. **审查者指派**：指定具体审查者（推荐）还是"具备 maintainer 角色的人皆可审"？
4. **必要批准数**：默认 1 还是按项目可配（1/2）？
5. **通知渠道**：本版本只做项目房间内通知，是否需要同时保留 fleet chat 提醒（复用 mentions）？
6. **锁等待策略**：合并队列遇到 enforced 锁是等待（带超时）还是直接失败让用户重试？
