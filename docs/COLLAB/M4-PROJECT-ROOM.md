# M4 项目房间（relay project 对象 / 快照+增量）设计规格

> 状态：**设计稿**。只定义项目对象模型、API、事件与权限，不含实现。
> 版本：`1.3.5-beta.*`（GitHub prerelease，不入 npm）。
> 上游：`docs/MULTI-MACHINE-COLLABORATION-PLAN.md` M4；依赖 M3（项目 ref/制品）与既有 memory/聊天/决策能力。

---

## 1. 目标与非目标

### 目标

1. **共享对象**：relay 上有一个 `project`，承载成员、任务板、制品、memory 文档、决策、git ref；多客户端看到的**同一份事实**。
2. **快照 + 增量**：客户端先取快照（带 `last_event_seq`），再按 seq 拉增量事件；断线重连不丢事件、不重复应用。
3. **多客户端**：不同机器/不同 DSH 实例打开同一 project，看到相同任务板与制品；客户端只做视图，不做本地权威状态。
4. **权限矩阵**：读/派发/合并/写 memory/决策/管理成员按角色判定（复用既有 role 模型与 `mayAct`）。
5. **兼容旧行为**：没有显式 project 的任务自动归入隐式 default project；旧客户端/旧 relay 不受影响。

### 非目标（本版本不做）

- 不做人类账号体系（成员维度先按 machine_id 与 operator 身份；账号/多人体系后续）。
- 不做跨 project 的成员继承/组织层级（单层 project）。
- 不做完整 UI（本版本先做面板的任务板/制品/决策只读视图 + 基础操作；富交互后续）。
- 不做事件永久存储（保留窗口 + 快照兜底；永久审计走 ledger）。

---

## 2. 现状与缺口

| 现有 | 缺口 |
|---|---|
| `GET /v1/tasks` 全局任务列表 | 没有"属于哪个项目"的归属；多项目混在一起 |
| `fleet-messages` 会话消息 | 消息不是共享状态，不能作为任务板/制品/决策的事实源 |
| memory CAS 文档（fleet 级） | 没有 project 命名空间，多项目决策互相污染 |
| council 决策 trail | 决策散在 memory 行里，没有结构化的项目决策账本 |
| blob 制品 | 没有目录/索引（只能按 sha 取，不知道"是什么、属于哪个任务"） |
| 多 DSH 实例 | 各看各的 session；没有"项目"这个聚合根 |

---

## 3. 项目对象模型

### 3.1 静态结构

```json
{
  "project_id": "01M6…（ULID）",
  "name": "w2m-fleet-demo",
  "slug": "w2m-fleet-demo",
  "created_at": "2026-10-21T13:00:00Z",
  "created_by": "operator|machine_id",
  "origin": { "kind": "git|none", "url": "https://…/repo.git", "default_branch": "main" },
  "members": [
    { "kind": "machine", "machine_id": "1c14d7d2-…", "role": "owner|maintainer|worker|observer", "joined_at": "…" },
    { "kind": "operator", "name": "TwinsEarth", "role": "owner", "key_id": "…" }
  ],
  "settings": {
    "merge_requires_tests": false,
    "event_retention": 5000
  }
}
```

角色沿用既有模型（`owner / maintainer / worker / observer`），权限矩阵见 §6。

### 3.2 挂载的子对象

| 子对象 | 来源 | 说明 |
|---|---|---|
| 任务 | 现有 task（新增 `project_id` 归属） | 看板列由 task 的派生 status 决定（waiting/active/done/failed） |
| 制品 | blob 通道 + 新增索引 | `{sha256, kind: patch|conflict|diag|report|other, label, task_id, created_by, size, created_at}` |
| memory 文档 | 现有 CAS，key 变为 `project:<project_id>:<doc>` | 每个项目独立命名空间；fleet 级文档保留 |
| 决策 | council 决策记录 | 结构化 `{decision_id, council_id, question, choice, dissent, ballots, decided_by, decided_at}` |
| git ref | M3 `project.ref` | 分支 head、合并来源 |
| 事件流 | 本设计新增 | 追加式，seq 单调递增，快照后按 seq 增量 |

---

## 4. 快照 + 增量协议

### 4.1 快照

```
GET /v1/projects/:id
→ {
    protocol_version, project, members,
    board: { waiting:[taskSummary…], active:[…], done:[…], failed:[…] },
    artifacts: [{sha256, kind, label, task_id, size, created_at}…],
    memory: [{doc, revision, updated_at, last_records: [...]}…],
    decisions: [{decision_id, question, choice, decided_at}…],
    refs: [{branch, head, updated_at}…],
    last_event_seq: 1234,
    server_time
  }
```

- 快照默认限制条数（board 每列 ≤50，artifacts ≤200，memory 文档索引不分页但只给元数据），超出用 `?full=1` 或分页参数显式拉取。
- 快照必须与 `last_event_seq` **同一个一致性点**（relay 单线程/加锁构造，不允许"快照取自 t1、seq 取自 t2"）。

### 4.2 增量事件

```
GET /v1/projects/:id/events?since_seq=1234[&limit=200]
→ { events: [{ seq, type, at, actor, payload }…], next_seq, truncated }
SSE: GET /v1/projects/:id/stream?since_seq=1234  （断线重连带 since_seq）
```

事件类型（首版）：

```
project.created
member.added / member.removed / member.role_changed
task.linked            {task_id, project_id}
task.status_changed    {task_id, status, outcome}
artifact.added         {sha256, kind, label, task_id}
memory.updated         {doc, revision}
decision.recorded      {decision_id, choice}
ref.updated            {branch, from, to, queue_id}
settings.changed       {key, value}
```

规则：

- `seq` 全局单调（relay 级），客户端按 project 过滤；`next_seq` 用于续拉。
- 客户端应用规则：只应用 `seq > 本地已应用最大 seq`；发现 `since_seq` 过旧（事件已过保留窗口）→ `truncated=true` → **重新拉快照**，绝不静默跳过。
- 事件不可变；同一 seq 重放幂等（客户端按 seq 去重）。
- 保留窗口默认 5000 事件/项目；ledger 仍是长期审计（事件可从 ledger 重建）。

---

## 5. API 面（relay 路由）

```
GET    /v1/projects                       列出项目（按成员权限过滤）
POST   /v1/projects                       创建项目（owner 或 operator）
GET    /v1/projects/:id                   快照
PATCH  /v1/projects/:id                   设置/改名（owner/maintainer）
GET    /v1/projects/:id/events            增量（since_seq）
GET    /v1/projects/:id/stream            SSE 增量
POST   /v1/projects/:id/members           加成员/改角色（owner）
DELETE /v1/projects/:id/members/:member   移除（owner）
POST   /v1/projects/:id/artifacts         登记制品（元数据 + 已存在 blob sha）
GET    /v1/projects/:id/artifacts/:sha    取制品元数据（内容走 blob 通道）
POST   /v1/projects/:id/memory/:doc       追加记录（CAS，现有语义 + 项目命名空间）
GET    /v1/projects/:id/memory/:doc       读文档
POST   /v1/projects/:id/decisions         记录决策（council 决策落账本）
GET    /v1/projects/:id/refs              分支 head
```

任务归属：现有 `POST /v1/task` 新增可选 `project_id`；未提供时归入隐式 `default` 项目（惰性创建，行为与今天一致）。

---

## 6. 权限矩阵（复用 role 模型）

| 动作 | owner | maintainer | worker | observer |
|---|---|---|---|---|
| 读快照/事件/制品 | ✅ | ✅ | ✅ | ✅ |
| 派发任务 | ✅ | ✅ | ✅ | ❌ |
| 登记制品 | ✅ | ✅ | ✅ | ❌ |
| 写 memory / 记录决策 | ✅ | ✅ | ❌ | ❌ |
| 合并（M3 merge-slot） | ✅ | ✅ | ❌ | ❌ |
| 管理成员/设置 | ✅ | 部分（设置） | ❌ | ❌ |
| 创建项目 | ✅ | ❌ | ❌ | ❌ |

拒绝时返回结构化错误（`reason_code` + `required_role` + `current_role`），与既有 chat 权限错误同风格。

---

## 7. 客户端（DSH 插件侧）

### 7.1 数据获取

- 宿主路由代理（沿用 fleet-chat 的 fetch 路由机制）：`/api/w2m/project/:id`（快照）、`/api/w2m/project/:id/events`（增量/SSE）。
- 插件工具：项目房间工具（创建/列出/读取/选择当前项目、登记制品、写决策）——**实现时确定名称**。
- 客户端只缓存"已应用最大 seq"与视图数据；不把项目状态写入本地权威存储。

### 7.2 面板视图（本版本）

```
项目房间面板：
  · 任务板四列（waiting/active/done/failed）+ 计数（复用 M4 之前的看板计数）
  · 制品列表（sha 短码、kind、label、所属任务、大小、下载）
  · 决策列表（问题、选择、异议、时间）
  · memory 文档索引 + 最近记录（点击进文档）
  · refs（分支 head，来自 M3）
  · 连接状态（快照 seq / 增量 seq / 断线重连）
```

不做写操作的富交互（创建任务、合并按钮放后续版本）；本版本提供"选择当前项目 + 只读看板/制品/决策"。

---

## 8. 持久化与重放

- relay 状态目录新增 `projects.json`（项目 + 成员 + 设置，原子写）与 `project-events.jsonl`（事件流，截断保留窗口）。
- 启动时：加载 projects.json；事件流按 seq 校验连续性；损坏行跳过并记录告警（与现有 ledger 行为一致）。
- ledger 中新增 `project.*` 事件；**事件流可从 ledger 重建**（一致性检查：重建 seq 与事件流一致）。
- 制品内容仍在 blob 存储（8 MiB 上限/256 个）；制品索引不复制内容。

---

## 9. 兼容与迁移

- 旧客户端：`GET /v1/tasks` 行为不变；新字段被忽略。
- 旧 relay：新客户端请求 `/v1/projects` 得到 404 → 提示 `PROJECT_ROOM_UNSUPPORTED_RELAY`，不回退到错误状态。
- 既有任务：启动时惰性归入 `default` 项目（不重写 ledger；项目快照包含 default 项目下的历史任务摘要）。
- 既有 fleet memory：保留为 fleet 级文档；项目决策新写 `project:<id>:decisions`。

---

## 10. 验收（真实任务）

### 正向

1. **两客户端同一任务板**：客户端 A 创建项目并派发任务 → 客户端 B（另一台机器）打开同一项目，3 秒内看到该任务；任务状态变化同步。
2. **制品可见**：A 的 worktree 任务产出 patch（M3）→ 制品登记 → B 可看到并下载（sha 校验一致）。
3. **决策共享**：A 记录一条 council 决策 → B 的决策列表出现（含 dissent）。
4. **增量不丢**：B 断线 2 分钟后重连（带 since_seq）→ 期间事件全部补齐；若超出保留窗口 → 明确提示并重拉快照。
5. **重启恢复**：relay 重启后，项目快照、成员、事件 seq 连续（与 ledger 一致）。

### 负向（自动化）

```
未授权成员读/写 → 403 + reason_code
observer 派发任务/登记制品 → 拒绝
非成员访问项目 → 404 或 403（不泄露存在性）
事件 seq 缺口 → truncated → 强制快照
同一 seq 重复应用 → 幂等
项目不存在创建任务 → default 项目
事件流损坏行 → 跳过告警，不阻塞启动
```

---

## 11. 交付物清单（实现阶段）

```
src/relay/project-room.mjs       项目对象/成员/设置/权限、快照一致性点
src/relay/project-events.mjs     事件流（seq、保留窗口、SSE、重建校验）
src/relay/project-artifacts.mjs  制品索引（挂 blob）
src/relay/server.mjs             /v1/projects* 路由、任务 project_id 归属
src/relay/state.mjs              project.* ledger 事件、重启加载
src/plugin/tools.mjs             项目房间工具（实现时定名）+ 任务带 project_id
src/plugin/fleet-chat-route.mjs  宿主代理 /api/w2m/project/*
lib/client.js                     项目房间面板（只读看板/制品/决策/refs/连接状态）
test/project-room.test.mjs       模型/权限/快照一致性
test/project-events.test.mjs     seq/增量/截断/幂等/SSE 重连
test/project-room-e2e.test.mjs   双客户端共享（模拟两设备）
docs/COLLAB/M4-PROJECT-ROOM.md   本文
```

## 12. 开放问题（实现前确认）

1. **项目身份**：由操作员显式创建（推荐），还是从 git origin URL 自动派生？
2. **成员维度**：本版本只支持 machine + operator 身份，还是需要先引入"人"的账号模型？
3. **面板范围**：本版本只读看板/制品/决策，还是同时提供"创建任务/登记制品"的交互？
4. **事件保留**：5000 条/项目够不够？超出后只靠快照是否可接受？
5. **跨项目**：一个任务能否属于多个项目（如共享库）？建议 beta 单项目。
6. **默认项目**：隐式 `default` 项目命名与可见性（所有成员可见 vs 仅 owner）？
