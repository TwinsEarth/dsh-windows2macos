# 协作模型（Collaboration Model）设计规格 — v1.4.2-beta

> 状态：**模型级设计稿**。把 M4（项目房间）与 M5（多客户端原语）归纳为统一协作模型：共享对象、成员与角色、事件一致性、多客户端视图。
> 版本：`1.4.2-beta.*`；实现按 M4（1.3.5）与 M5（1.3.6）分步交付，模型一致性验收在 1.4.2-beta 完成。
> 相关：`docs/COLLAB/M4-PROJECT-ROOM.md`、`docs/COLLAB/M5-MULTI-CLIENT-PRIMITIVES.md`、`docs/COLLAB/TASK-MODEL.md`。

---

## 1. 问题陈述

现状的"协作"只有三件互不关联的东西：

```
· relay 的派发/聚合（任务属于调用者，不属于任何共享对象）
· 各 DSH 实例自己的会话（多客户端各看各的）
· fleet chat 消息流（是消息，不是共享状态）
```

缺的是**共享对象**：project / room / board / artifact / decision。没有它们：

- 多客户端无法看到同一份任务板与制品；
- 权限、成员、角色无处附着；
- 通知没有"项目"这个投递范围；
- 内存/决策是全局的，多项目互相污染。

---

## 2. 模型总览

```
协作 = 主体 × 项目 × 对象 × 关系 × 交互 × 事件

主体     machine（设备身份） / operator（操作员密钥身份）
项目     project（聚合根）：成员、角色、设置、origin
对象     任务板(board)、制品(artifact)、分支 refs、memory 文档、决策(decision)、
         审查(review)、锁(lock)、通知(notification)
关系     成员资格 + 角色（owner/maintainer/worker/observer）
交互     派发任务、提交/裁决审查、获取/释放锁、读写通知、读板/制品
事件     追加式事件流（seq 单调），快照由事件投影而来；客户端只是视图
```

**单一事实源**：项目事件流（+ ledger 长期审计）。客户端不做本地权威状态，只保存视图与水位（已应用 seq、已读通知水位）。

---

## 3. 核心概念与不变量

### 3.1 项目（聚合根）

- 一个 project 有唯一 `project_id`、`origin`（git 或无）、`settings`、`members`。
- 任务、制品、refs、memory、decision、review、lock、notification 都必须挂在 project 下（旧任务惰性归入 default 项目）。
- 项目隔离：非成员不能读项目快照/事件/制品（错误信息不泄露存在性）。

### 3.2 成员与角色

| 角色 | 可以做什么 |
|---|---|
| observer | 只读（板/制品/决策/refs/通知） |
| worker | + 派发任务、登记制品、申请/持有锁 |
| maintainer | + 写 memory/决策、审查裁决、项目设置 |
| owner | + 管理成员、创建项目、强制释放锁 |

权限判定统一为 `mayAct(role, action)`（拒绝默认，返回 `required_role/current_role`）。角色变更本身是事件（`member.role_changed`），可审计。

### 3.3 共享对象

| 对象 | 事实源 | 视图 |
|---|---|---|
| 任务板 | 任务状态事件（M3 任务模型） | 四列（waiting/active/done/failed）+ 计数 |
| 制品 | blob（内容寻址）+ 索引 | 列表/sha 下载 |
| refs | 合并队列推进（M3） | 分支 head |
| memory | CAS 文档（项目命名空间） | 索引 + 最近记录 |
| 决策 | 审查/council 决策事件 | 决策列表（含异议） |
| 审查 | review 对象（M5） | 待审/已审 |
| 锁 | lock 对象（M5） | 持有人/TTL |
| 通知 | 事件流派生 | 未读 + 列表 |

### 3.4 事件与一致性

```
· 每个项目一条追加式事件流，seq 单调（relay 权威排序）
· 快照 = 事件流在某个 seq 的投影，快照携带 last_event_seq（一致性点）
· 客户端增量：只应用 seq > 本地最大；发现缺口 → 重拉快照（绝不静默跳过）
· 客户端写后读：自己的写请求返回事件 seq；后续读至少看到该 seq（read-your-writes）
· 其他客户端：最终一致（通常 < 3s，实测目标）
· 消息/聊天不进事实源；聊天是旁路通道，不产生共享状态
```

### 3.5 存在性（presence）与水位

- presence = 设备在线状态 + 最后心跳（复用 M0 的设备表），用于显示"谁在线"。
- 每个客户端维护两类水位：`applied_seq`（视图一致性）与 `read_watermark_ms`（通知已读）。
- 水位持久化在客户端；服务端不追踪"某人读到哪"（隐私与规模考虑），只用未读计数接口。

---

## 4. 交互协议（模型级）

| 交互 | 入口 | 语义 |
|---|---|---|
| 选择/创建项目 | 项目 API + 面板 | 显式创建或选择 default |
| 派发任务 | task API + `project_id` | 任务归属项目，进板 |
| 提交审查 | review API | 指向 patch 制品，指定审查者 |
| 审查裁决 | review decision API | approve / changes_requested + findings |
| 获取/释放锁 | lock API | 分支/文件，TTL，强制释放（owner） |
| 读板/制品/决策/refs | 快照 + 增量 | 只读视图 |
| 通知 | 事件流 + unread + read | 实时 SSE + 离线补齐 |
| 订阅 | SSE `since_seq` | 断线重连续传 |

所有写操作都要求成员资格 + 角色权限；所有写操作产生事件；所有事件可重放。

---

## 5. 多客户端的典型场景

### 场景 A：两人联合修一个 bug

```
A（机器 1）打开 project → 派发 worktree 任务 → 产出 patch 制品
A 提交审查（指定 B）→ B（机器 2）收到通知 → 拉 patch → 批准
合并队列执行 → ref.updated → 双方板/refs/通知同步更新
```

### 场景 B：离线后补齐

```
B 离线 2 分钟 → 重连：applied_seq 落后 → 拉增量事件补齐（或超窗口则重拉快照）
unread 通知计数 → 标记已读 → 归零；期间任务状态变化全部可见
```

### 场景 C：并发冲突

```
A/B 同时改同一文件：enforced 模式下 A 持文件锁，B 获取失败（LOCK_HELD）
B 等待/改方案；A 释放后 B 继续；最终合并或结构化 MERGE_CONFLICT 由人解决
```

### 场景 D：relay 重启

```
持久化恢复：项目/成员/事件 seq 连续；客户端断线重连后按 seq 补齐；
任务租约重派发；不丢事件、不重复应用
```

---

## 6. 故障与保证

| 故障 | 保证 |
|---|---|
| 客户端断线 | 重连补齐；缺口→快照；不丢事件 |
| 客户端离线写 | 写请求失败即明确报错（不做本地离线写队列，避免冲突） |
| relay 重启 | 状态持久化 + seq 连续；快照可重建 |
| 成员被移除 | 立即失去读写（事件 `member.removed`）；在途任务按任务语义完成或取消 |
| 权限不足 | 结构化拒绝（code + required/current role），不泄露对象是否存在 |
| 通知风暴 | 去重 + 限流 + digest（M5） |
| 事件流损坏 | 跳过并告警；ledger 可重建；快照兜底 |
| 制品被删 | 引用处明确报错 `ARTIFACT_MISSING`，不返回空内容 |

投递语义：

- 事件：at-least-once 应用（客户端按 seq 幂等）；
- 通知：at-least-once + 去重 + 水位；
- 审查结论：不可变，重复同向结论拒绝；
- 锁：TTL 过期自动释放，强占需 owner 且留痕。

---

## 7. 安全与隐私

1. **身份分离**：machine（设备令牌）与 operator（签名密钥）是两类主体，成员资格显式绑定。
2. **项目隔离**：跨项目不可见；错误不泄露存在性；制品按成员资格授权。
3. **最小权限**：角色矩阵（§3.2）；拒绝默认。
4. **审计**：成员变更、角色变更、锁强制释放、审查结论、决策全部进事件 + ledger。
5. **隐私**：客户端水位本地保存；服务端不追踪个人阅读明细（只给未读计数）。
6. **不把聊天当状态**：消息可被编辑策略删除/分享，因此不进入项目事实源。

---

## 8. 兼容与迁移

- 新 API 全部新增；旧客户端/旧 relay 不受影响（旧 relay → `PROJECT_ROOM_UNSUPPORTED_RELAY`）。
- 旧任务：启动时惰性归入 default 项目（不重写 ledger）。
- 旧 fleet memory：保留为 fleet 级；项目决策写 `project:<id>:decisions`。
- fleet chat：保留为旁路通道（人不执行聊天内容；聊天不产生任务）。
- 三个模型的关系：执行授权（能否执行）→ 任务（执行什么）→ 协作（谁/在哪/共享什么）。

---

## 9. 验收（模型一致性，真实任务）

### 正向

1. **同一任务板**：A 派发任务 → B（另一台机器）3 秒内看到；状态变化同步。
2. **制品共享**：A 的 patch 制品登记 → B 可下载且 sha 一致。
3. **决策共享**：A 记录决策（含异议）→ B 决策列表可见。
4. **审查门禁联动**：A 提交审查 → B 批准 → 合并门禁放行。
5. **锁协作**：enforced 模式下 A 持锁 B 被拒；释放后 B 成功；双方收到锁事件。
6. **离线补齐**：B 断线 2 分钟 → 重连后事件补齐、未读通知计数正确、已读归零。
7. **重启恢复**：relay 重启后项目/成员/seq 连续，客户端补齐无重复。

### 负向（自动化矩阵）

```
非成员读写 → 403/404（不泄露）
observer 派发/登记 → 拒绝
worker 审查裁决 → REVIEW_PERMISSION
移除成员后访问 → 立即失败
seq 缺口 → 强制快照（不静默）
重复事件应用 → 幂等
通知风暴 → digest 且不丢
锁被盗用/过期操作 → LOCK_*
制品被删后的引用 → ARTIFACT_MISSING
```

---

## 10. 与版本/模块的映射

```
1.3.5-beta  M4 实现：project 对象、快照+增量、权限、面板只读视图
1.3.6-beta  M5 实现：锁/审查/通知
1.4.2-beta  模型一致性验收：统一对象/事件/权限/水位语义，双客户端真实任务证据
模块：
  src/relay/project-room.mjs     项目/成员/角色/设置
  src/relay/project-events.mjs   事件流/快照/增量/SSE
  src/relay/project-artifacts.mjs 制品索引
  src/relay/locks.mjs / reviews.mjs / notifications.mjs（M5）
  src/plugin/tools.mjs + fleet-chat-route.mjs + lib/client.js（客户端视图）
```

## 11. 开放问题（实现前确认）

1. **身份维度**：本版本用 machine+operator，还是先引入"人"的账号模型（影响成员/通知/审查）？
2. **项目创建权**：仅 owner，还是 maintainer 也可创建？
3. **default 项目可见性**：所有成员可见，还是仅 owner（旧任务迁移策略）？
4. **通知渠道**：只做项目房间内（推荐），还是同时接 fleet chat mentions？
5. **presence 范围**：只显示在线/离线，还是显示"正在编辑哪个任务/持有哪些锁"？
6. **任务多项目归属**：beta 单项目（推荐）还是允许一任务挂多个项目？
7. **事件保留**：5000 条/项目是否够用？超出只靠快照是否可接受？
