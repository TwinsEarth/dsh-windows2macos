# Relay Cluster Sync — Phase 2 设计（ADR）：fleet chat 与项目房间跨 relay 同步

- 状态：**accepted（2026-11-17，随 `wip/relay-phase2-20261117` 合入 `work/v3.4.6`）**
- 目标里程碑：v3.5.0 交付项 3「Relay Phase 2 合并」
- 被替代/前序文档：`docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md`（v3.0.0 三节点同步，Phase 1：devices + task ledger）
- 合并评审：`docs/REVIEW-RELAY-PHASE2-20261117.md`（4 个阻塞条件，本文与 `docs/RUNBOOK-RELAY-ROLLING-UPGRADE.md` 关闭其中的文档条件）
- 滚动升级操作手册：`docs/RUNBOOK-RELAY-ROLLING-UPGRADE.md`
- 代码落点：`src/relay/chat-store.mjs`、`src/relay/project-sync.mjs`、`src/relay/cluster-sync.mjs`、`src/relay/server.mjs`、`src/relay/persistence.mjs`、`src/relay/state.mjs`、各 project-* 模块
- 验证脚本：`scripts/verify-relay-cluster-phase2.mjs`、`scripts/verify-relay-cluster-mixed.mjs`

> 本文是 Phase 2 的独立 ADR（v3.0.0 设计 §2.3 明确要求 chat/memory 跨 relay 前先有单独 ADR）。它描述**已经写下的实现**，不是待审批的草案；凡实现与早期设想不同之处，以本文和代码为准。

---

## 1. 背景与目标

### 1.1 背景

v3.0.0 的 cluster sync 只同步 durable 状态：设备注册表（`devices.json`）与任务账本（`ledger.jsonl`）。fleet chat（`fleet-messages.mjs`）、项目房间的共享对象（artifacts / decisions / memory / locks / reviews / refs / notifications / read marks）当时都只在内存里：relay 重启即丢，standby relay 上也看不到主 relay 的对话与项目状态。

Phase 2 给这两块补上「先持久化、再跨 relay 同步」：

- **2A — fleet chat 持久化与复制**：一条只存在于内存的消息无法被有意义地同步（源 relay 和接收 relay 都会在重启时丢它）。先把已接受的 chat 行写入一个 append-only 复制日志，再让各 relay 按字节指针互相拉取这份日志。
- **2B — 项目房间共享对象同步**：项目房间的本地事件日志不能直接重放给 peer —— artifact/decision/memory 事件 payload 只带摘要，locks/reviews/notifications/refs 根本不在事件日志里。因此同步的单位不是事件，而是**整个项目的共享对象快照**，合并规则必须确定性且幂等。

### 1.2 目标

1. relay 重启后 chat 历史与项目共享对象仍在（持久化）；
2. 任一 relay 上产生的新 chat 消息 / 读水位 / 删除，能到达所有 peer（最终一致，延迟不超过同步周期）；
3. 项目房间的成员、事件、artifact、decision、memory、refs、locks、reviews、notifications、read marks 跨 relay 收敛，且同一份输入在任意 relay 上合并出同一结果；
4. 对既有设备线协议零破坏：不改 `protocol_version`、不改既有路由/字段语义，只新增 peer-only 路由与 healthz 字段（只增不改）；
5. 滚动升级安全：新 relay 跳过不支持 Phase 2 的旧 peer，旧 relay 从不调用新路由；
6. 失败可恢复：崩溃顺序已设计，部分写不破坏已有数据；回滚到旧版本安全（旧代码忽略新文件）。

### 1.3 非目标（本阶段不做）

- **不做 relay 端 E2E 加密承诺**：relay 复制它拿到的行，不解密 `text`/`enc`；chat 明文（未走 `enc` 时）落盘并复制到 peer，见 §7；
- **不做强一致/实时同步**：仍是周期拉取（chat 默认 60s，项目默认 1h），最长不一致 = 同步周期 + 传输/重试；
- **不新增设备线协议版本**：不升 `protocol_version`，不新增 `PROTOCOL.md` 路由；
- **不做跨 relay 的 chat HTTP 删除入口**：删除语义在数据层已闭环（§5.4），但设备面删除路由是**明确推迟**的独立协议变更；
- **不把 relay state 纳入 `$DSH_HOME` 备份扫描**：备份/还原的边界见 §7.3；
- **不做 blobs 同步**：数据面红线不变（v3.0.0 设计 §4.1 仍然有效）；
- **不做 operator token / signing secret 的同步**：每台 relay 的权威凭据保持独立（v3.0.0 设计 §2.2 仍然有效）。

---

## 2. 协议与向后兼容

### 2.1 只增不改的 peer-only 路由

所有 Phase 2 路由都是 **relay 之间**的 peer-only 路由，挂在既有 cluster 认证之下（cluster HMAC + 既有加密信封），设备 token / operator token 一律无效：

| 方法与路径 | 作用 | 鉴权 |
|---|---|---|
| `GET /v1/cluster/ping` | 健康与 **feature bits** 探测（不返回数据） | cluster HMAC |
| `GET /v1/cluster/chat?since=<byte>` | 一页 chat 复制日志（sealed 信封 + gzip） | cluster HMAC |
| `GET /v1/cluster/projects?since=<offset>` | 一页项目对象快照（sealed 信封 + gzip） | cluster HMAC |

`sender_node_id` / 时间窗 / nonce / 对端 node id 都在信封 AAD 内，沿用 v3.0.0 的语义（`src/relay/cluster-sync.mjs`）。新增的路由在 `CLUSTER_ROUTES` 里注册，**未启用 cluster 的 relay 对它们返回 404**（不是 500、不是空数据）。

### 2.2 feature-bit 探测与混合版本行为

`/healthz.features` 与 `/v1/cluster/ping` 的 `features` 按「已挂载的域」条件追加：

```
relay-cluster-sync-v1      Phase 1（devices + ledger），v3.0.0 起
relay-cluster-chat-v1      Phase 2A，仅当 cluster 启用且 chatStore 已挂载时
relay-cluster-projects-v1  Phase 2B，仅当 cluster 启用且 projectSource 已挂载时
```

每个同步轮次先探测 peer 的 feature（缓存 5 分钟）；对端未声明某域时，本轮**跳过该域**并记录 `unsupported: true`、`last_error: null`——"这个 peer 还不会说这个域"不是一次同步失败。旧 relay 没有 `/v1/cluster/chat` 路由时，404 同样按跳过处理。

因此：

- 旧 relay（3.0.0）完全不受影响：它从不调用新路由，也不认识新 feature（`relay-capabilities` 忽略未知 feature）；
- 新 relay 与旧 relay 组成的混合集群继续跑 Phase 1，Phase 2 域静默跳过，healthz 里可见 `domains.chat.peers[].unsupported = true`；
- 三台都升级后，已缓存的 feature 最迟 5 分钟刷新，域自动开始同步（无需重启）。

### 2.3 设备线协议未变

`PROTOCOL.md` 的 `protocol_version = 1` 未动。设备面唯一可观察到的变化是 `/healthz` 多了 feature 与 `cluster.domains` 诊断字段（只增），以及 chat 行为从「内存」变为「持久 + 复制」——对客户端接口形状无变化。

> 版本标签说明：`bin/w2m-rabbit.mjs --help` 把 Phase 2 称为 "v3.1.0"，`scripts/verify-relay-cluster-phase2.mjs` 设 `W2M_RELAY_VERSION=3.0.0`，混合验证脚本用 3.0.0/3.1.0 对比。这是**展示用 relay 版本标签**，不是兼容性契约；兼容性契约是 feature bits。发布流程有权统一这些标签（见 §12 残余风险 5）。插件包版本本次不 bump。

---

## 3. 数据模型

### 3.1 chat：单一的 append-only 复制日志（§4.1）

```
<state>/chat/
  replication.jsonl   append-only，一行一条记录；0600
  state.json          { v: 1, generation, next_local_offset }；原子写
  applied.json        { v: 1, applied: { "<origin>": <maxOffset> } }；幂等水位
```

目录 0700（Windows 上尽力而为）、文件 0600。记录格式：

```json
{"v":1,"origin":"node-xxxx","offset":7,"at_ms":1700000000000,"kind":"chat.message","data":{...}}
```

- `origin` 是产生该记录的 relay 稳定 node id（单机 relay 用 `<state>/instance-id.json` 里的 per-state 随机 id）；
- `offset` 是 **per-origin 单调递增**的本地序号；本地记录先持久化 `next_local_offset` 再 append（崩溃留下未用序号是无害的）；
- 从 peer 拉到的记录**原样重导出**（同 origin/offset 写入本地日志），这样任何活着的 relay 都能给新节点做 bootstrap；
- 去重键是 `(origin, offset)`；`load()`/`exportSlice()` 对重复行做确定性折叠，重复 append 不会产生第二条消息。

日志是**单一文件**而不是每会话一个文件：集群游标是文件的字节偏移，单文件让「append 不改写旧字节 → 字节偏移长期有效」这条性质成立。会话只是记录里的 `data.session_id`，内存视图（`fleet-messages.mjs`）再按会话聚合。

### 3.2 generation 与分页（§4.2）

- 保留期/容量压缩（`prune()`）会**重写**日志，字节偏移全部失效。因此重写前先把 `generation + 1` 落盘；peer 发现 generation 变了就把自己的游标归零重拉。重放靠 `(origin, offset)` 幂等吸收。
- 分页：`exportSlice(fromOffset, maxBytes)` 默认页大小 **128 KiB**（`W2M_RELAY_CHAT_PAGE_BYTES=131072`），只返回完整行；单行超过预算也整行返回（绝不半条记录）。游标落在行中间时推进到下一行边界。
- 只有 `prune()` **真的**删了记录才 bump generation；无变化的周期 prune 是 no-op，否则每轮都会强制 peer 全量重拉。

### 3.3 三类记录与合并规则（§4.3）

| kind | `data` | 合并规则 |
|---|---|---|
| `chat.message` | fleet-messages 的完整行（含 `message_id`/`session_id`/`machine_id`/`text`/`enc`/`at_ms`…） | 按 `message_id` 取并集；导入插入内存时按 `at_ms` 排序；**不做本地配额拒绝**（§5.1） |
| `chat.read` | `{session_id, machine_id, at_ms, message_id}` | 每 `(session_id, machine_id)` 取 LWW：`at_ms` 大者胜，平局按 `origin`、再按 `offset` |
| `chat.session.deleted` | `{session_id}` | 每会话一个 tombstone，永久保留；见 §5.4 |

导入的消息不触发本地 `onAppend` 持久化钩子（它在导入前已由 `importRecord` 持久化），因此不会出现「导入 → 再 append 一遍」的环。

### 3.4 项目房间：整项目快照 + 确定性合并

项目域没有字节游标：项目状态很小（线上实测 tens of KB），每轮从 offset 0 全量拉一遍，合并幂等，部分页失败下一轮自愈。导出的每一项（按 `project_id` 排序、可分页）：

```
project_id, project{project_id,name,origin,created_at,created_by,settings},
members[], events[](带 event_hash), artifacts[], decisions[], memory,
refs[], locks[], reviews[], notifications[], read_marks[]
```

- **事件身份**：`event_hash = sha256(JSON.stringify([project_id, type, actor, payload, at]))`。`seq` 被排除在外：它是本地游标，两台 relay 对同一事件会有不同 seq。合并按 event_hash 取并集，按 `at` 排序（平局再按 hash）——同一份输入在任意 relay 上得到同一顺序。
- **"最新"判定**的统一顺序：① 记录自己的时间字段（`updated_at` / `decided_at` / `created_at_ms` / …）→ ② 类型内 tie-break（version、state rank）→ ③ canonical JSON 字典序。第 ③ 步是让「同一时间的两条不同记录」也有唯一胜者的原因。
- **各对象规则**（`src/relay/project-sync.mjs`）：members 按成员去重、删除即 tombstone 且不复活；locks 按 `lock_id` 取并集并丢弃过期；reviews 每 review 取最新 decision；refs 每 `(project, branch)` 取 `updated_at` 最新；notifications 每项目只保留最新 **500** 条（`MAX_NOTIFICATIONS_PER_PROJECT`）；read marks 每 `(project, reader_kind, reader_id)` 取最大 watermark；memory 取更高 version（同 version 取更新者）。
- 合并后只广播**新导入的**项目事件（本地事件不重放通知），并写一次项目对象持久化。

### 3.5 新增的持久化文件

| 路径 | 内容 | 权限 |
|---|---|---|
| `<state>/chat/replication.jsonl` | chat 复制日志（append-only） | 0600 |
| `<state>/chat/state.json` | generation / next_local_offset | 0600 |
| `<state>/chat/applied.json` | per-origin 幂等水位 | 0600 |
| `<state>/projects/objects.json` | 项目共享对象（artifacts/decisions/memory/refs/locks/reviews/notifications/read marks） | 0600 |
| `<state>/instance-id.json` | 单机 relay 的记录 origin（随机、非秘密、永不改变） | 0600 |
| `<state>/cluster/domains.json` | Phase 2 域的 per-peer 游标/诊断（不含 payload） | 0600 |

旧版本代码不读这些文件；回滚安全（§8.2）。

---

## 4. 保留、容量与配额

### 4.1 配额边界（§5.1）

`fleet-messages.mjs` 的 24h 配额规则只管**本地产生**的消息。**导入的消息不做本地配额检查**：否则一台 relay 的配额满了会挡住另一台 relay 的写，这是设计上明确拒绝的行为。导入侧用保留期 + 硬上限自我约束。

### 4.2 保留与硬上限（§5.2）

- 保留期默认 **7 天**（`W2M_RELAY_CHAT_RETENTION_DAYS`）；
- 字节硬上限默认 **200 MiB**（`W2M_RELAY_CHAT_HARD_CAP_BYTES=209715200`，正常日志不会超过；单节点长期未 prune 时启动加载可能更大，见 §12）；
- `prune()` 的顺序：先按保留期删 message/read（read 只留每 `(session, machine)` 的 LWW 胜者），再按硬上限从最旧消息开始删到装得下；**tombstone 永不删**，tombstoned 会话的 message 行直接删（§5.4）。重写日志原子（tmp+rename），generation 先落盘再重写。
- chat 域的 prune 跟着 chat 同步轮次跑（默认 60s 一轮）；未启用 cluster 的 relay 只在启动时 prune（§12）。

### 4.3 崩溃顺序（§5.3）

实现里刻意的顺序（全部有测试覆盖）：

1. `append*`：先持久化 `next_local_offset`，再 append 行。中间崩溃 → 一个未使用的 offset（无害）；反序会造成 offset 复用、peer 丢弃第二条记录。
2. `importRecord`：先重导出（append 原样记录），再持久化 applied 水位。中间崩溃 → 同一条会被重投，靠 `(origin, offset)` 去重吸收。
3. `prune`：先 bump 并持久化 generation，再重写日志。中间崩溃 → peer 看到新 generation 会重拉**仍然完整**的旧日志，不会静默漏字节。

诚实边界：**没有 fsync**（与既有 `persistence._writeJsonAtomic` 一致）；`projects/objects.json` 与房间快照是两次独立写，非事务，失败会被 `catch` 吞掉（§12）。

---

## 5. 删除语义（评审阻塞条件 4）

### 5.1 决策

**chat 会话删除是永久 tombstone：被删除的 `session_id` 退役，该会话的历史不再返回，也不接受对该 id 的新消息。** 删除没有「时间点比较」语义（即不采用"只隐藏删除前消息、删除后新消息保留"），理由：

1. 实现里 tombstone 记录不带可比较的消息时间语义，采用时间比较会引入跨 relay 时钟偏差的正确性依赖；
2. 会话 id 由客户端生成、删除即封存是更简单、更可解释的规则；
3. 评审要求的是"删除不复活"，不是"会话 id 可重用"。

### 5.2 闭环点（本次 merge 实现）

| 位置 | 行为 |
|---|---|
| `chat-store.load()` | 按 tombstone 过滤 message：被删会话的消息**永不返回**（无论 `at_ms`，因此重启/新节点重拉都不会复活） |
| `chat-store.stats()` | 计数与 `load()` 一致：tombstoned 会话的消息不计入 `messages` |
| `chat-store.prune()` | 删除 tombstoned 会话的 message 行（死字节不占硬上限），tombstone 永久保留 |
| `server._applyChatRecord()` | 从 peer 导入的、晚于 tombstone 到达的旧消息，若会话已删则**拒绝插入** |
| `server.deleteChatSession(id)` | 唯一的删除写路径：写一条 `chat.session.deleted` 到复制日志 + 从内存删除；重复删除幂等；`--no-persist` 时如实返回 `tombstoned:false` |
| `POST /v1/fleet/messages` | 对被 tombstone 的 `session_id` 返回 400 `SESSION_DELETED`（session id 已退役；避免"POST 成功但重启后消息消失"） |

### 5.3 测试

- `test/chat-store.test.mjs`：load 过滤（含删除后导入的旧消息）、只隐藏被删会话、prune 删行且保留 tombstone；
- `test/relay-phase2-server.test.mjs`：删除 → 拒绝 repost → 重启后仍不可见；peer 导入 tombstone 后本机隐藏、peer 重启后仍隐藏。

### 5.4 明确推迟：设备面 HTTP 删除路由

本次 merge **没有**新增 HTTP 删除路由（`DELETE /v1/fleet/...` 之类）。原因：新增设备面路由是 `PROTOCOL.md` 层面的协议变更，需要同时定义授权模型（谁能删：operator？会话所属设备？任意成员？）、错误码表与客户端配合，不属于"编码修复 + 文档 + 门禁"这条合并收口线。`server.deleteChatSession()` 是未来路由唯一该调用的写路径，本次由测试驱动。

**后续工作（明确、可执行）**：另立协议变更评审，新增 operator 授权的删除路由（或扩展 `/v1/fleet/read` 风格的路由族），同时更新 `PROTOCOL.md` §7 错误码（`SESSION_DELETED`）、ADR §5 与滚动升级手册的「禁止事项」；在此之前**禁止对外宣称"跨 relay 删除已可用"**——数据层语义已闭环，但没有任何设备面触发入口。

---

## 6. 项目房间同步（§6）

`project-sync.mjs` 是**纯模块**：读一个 `RabbitState`，调用各 project-* 模块的 `snapshot()` / `restore()` / `import*` 钩子；它自己不含定时器、不碰文件、不发网络。真正的 IO 与调度在 `cluster-sync.mjs`（域调度、拉页、解封、调用 `projectSource.applyProject`），由 `server.mjs` 把 `exportProjectState` / `mergeProjectState` 接到 state 上。

- **导出**：`exportProjectState(state)` 返回按 `project_id` 排序的整项目快照数组；每个事件附 `event_hash`，不改事件本体；不含 blob 字节、不含密钥/凭据。
- **合并**：`mergeProjectState(state, remote, {nowMs, nodeId})` 返回 `{changed, conflicts}`；幂等——同一份 peer 快照应用第二次 `changed:false`；冲突计数进 healthz 诊断。
- **持久化**：合并有变化时广播新事件并 `persistProjectState()`；项目对象随 `objects.json` 落盘。
- **通知上限**：每个项目最多 500 条通知（设计上限，防止一个繁忙项目把快照撑大）。

---

## 7. 安全边界

### 7.1 通道

cluster 通道沿用 v3.0.0：前置共享 secret（32 字节 base64，只存在于各 relay 的 systemd drop-in / 环境变量，不进仓库）、请求 HMAC（路径 + 时间 + nonce + cursor，±120s、nonce 10 分钟防重放）、响应 AES-256-GCM 密封信封（AAD 绑定 sender/receiver node id 与时间/nonce）+ gzip。日志只记计数与错误码，不记 payload、secret、token。

### 7.2 chat 明文 at-rest

relay 的 chat 复制日志**存的是它拿到的行**：若客户端没走 E2E（`enc` 字段为空），`text` 就是明文，落盘 0600 并**复制到每个 peer**。这是 Phase 2 新增的静态暴露面，必须如实声明：

- relay 侧不承诺 E2E，也不尝试解密；
- 磁盘权限 0600 / 目录 0700（Windows 上 chmod 是尽力而为）；
- 能读 relay state 目录的 operator 能读 chat 明文。

### 7.3 relay state 不在备份扫描里

`docs/BACKUP-DESIGN.md` §5 的备份扫描只覆盖 `sessions/`、`attachments/`、`storages/` 等 `$DSH_HOME` 内容；**relay 的 `--state` 目录不在备份范围**。因此：

- 单节点 relay 的 chat 历史与项目对象只有**一份**（该 state 目录）；relay 磁盘损坏时备份/还原不会把它们带回来；
- restore 也不会"回滚" relay state；
- 这是 v3.5.0「备份增强」可以承接的边界（异地副本当前只支持本地/网络盘，Relay 传输留 Phase 3）。

---

## 8. 失败、回滚与兼容

### 8.1 失败模式

| 故障 | 行为 |
|---|---|
| peer 不可达 / 超时 | 只影响该 peer 的游标，其它 peer 继续；记录 `last_error`，不阻塞 |
| secret 错误 / 非 cluster 认证 | 401，不应用任何数据，`last_error=UNAUTHORIZED` |
| 混合版本（peer 无该域） | 跳过该域，`unsupported:true`、`last_error:null`（§2.2） |
| 日志 generation 变化 | peer 游标归零重拉，幂等吸收 |
| 复制日志个别行损坏/撕裂 | 坏行跳过、撕裂行留给下次；一条坏行不拖垮整个 chat |
| chat 持久化加载失败 | relay 启动继续（chat 从空开始），`startupMessages` 里具名警告 |
| `objects.json` 损坏 | 项目对象从空开始，`warn` 记录；房间快照仍可能独立恢复 |
| 导入消息/项目合并异常 | 记日志、计入冲突/拒绝计数，不失败整轮同步 |

### 8.2 回滚

- **代码回滚**：恢复旧 relay 目录（tar）+ 旧 systemd/env，启动即可。旧代码**忽略** `<state>/chat/`、`<state>/projects/`、`<state>/instance-id.json`、`<state>/cluster/domains.json`；Phase 1 的游标/账本不受影响。
- **数据不回滚**：回滚期间新版本写下的 chat/项目数据不会被旧代码读取（也看不见），再次升级后继续可见；tombstone 记录保留，不会因回滚复活。
- **禁止**为了"清干净"删除 state 目录或 chat 日志：那会永久丢失历史并让 peer 的游标悬空（generation/字节偏移对不上时 peer 会自动重拉，但删掉的数据无法恢复）。
- relay 版本降级不提供数据迁移（没有 downgrade migration，也不需要：旧代码不读新文件）。

---

## 9. 迁移与滚动升级

### 9.1 迁移

- **无破坏性迁移**：Phase 2 只新增文件；旧数据（devices/ledger）不动。
- 首次启动新版本时若已有旧 state：生成 `instance-id.json`（若没有），chat/项目从空开始；Phase 1 数据照常恢复。
- 从"曾有 Phase 1-only 时期"的单机 relay 升级：项目事件原本无 origin，导出时用 `instance-id`/node id 作为记录 origin（不改变事件本体）。

### 9.2 滚动升级顺序（结论）

因为协议只增不改 + feature 探测跳过，**任意升级顺序都安全**（包括 Phase 2 relay 与 3.0.0 relay 长期混跑）。推荐的操作顺序与门禁见 `docs/RUNBOOK-RELAY-ROLLING-UPGRADE.md`；一句话：**先备节点后主节点、一次一台、每台过健康门禁、三台都升级后再验收 Phase 2 收敛**。

### 9.3 混合版本矩阵

| 本机 | peer | Phase 1（devices/ledger） | Phase 2 chat/projects |
|---|---|---|---|
| 3.0.0 | 3.0.0 | 同步 | 不存在（两侧都不说） |
| 3.0.0（旧） | Phase 2（新） | 同步（旧代码照常拉 snapshot） | 旧 relay 不调用新路由，无影响 |
| Phase 2（新） | 3.0.0（旧） | 同步 | 域被跳过：`unsupported:true`、`last_error:null` |
| Phase 2（新） | Phase 2（新） | 同步 | 双向同步 |

---

## 10. 验证命令

```bash
# 单元/接线（本树即可跑，不联网）
node --test --test-force-exit test/chat-store.test.mjs test/project-sync.test.mjs \
  test/cluster-domains.test.mjs test/relay-phase2-server.test.mjs
node --test --test-force-exit test/cluster-sync.test.mjs test/cluster-sync-integration.test.mjs \
  test/fleet-messages.test.mjs test/fleet-messages-http.test.mjs

# 真实进程三节点验证：3 个 w2m-rabbit 子进程、真实 HTTP cluster 路由，5 项断言
node scripts/verify-relay-cluster-phase2.mjs

# 混合版本 + 滚动升级验证：需要 Relay 3.0.0 归档
#   W2M_RELAY_OLD_TGZ=/path/to/w2m-relay-3.0.0.tgz node scripts/verify-relay-cluster-mixed.mjs
node scripts/verify-relay-cluster-mixed.mjs

# 全量发布门禁（慢；在主线上跑一次）
DSH_RUNTIME_DEPS=<安装的 DSH 依赖目录> DSH_HOME=<空目录> node scripts/preflight.mjs

# 静态门禁
npx eslint . && node scripts/layer-check.mjs && node scripts/scan-mojibake.mjs
```

healthz 人工核对（任一 relay）：

```bash
curl -fsS http://127.0.0.1:8787/healthz | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log({features:j.features, domains:j.cluster?.domains})})"
# 期望 features 含 relay-cluster-chat-v1 / relay-cluster-projects-v1（三台都升级且启用 cluster 后）
# 期望 cluster.domains.chat / projects 的 enabled=true，peers[].last_error=null、unsupported 随版本正确
```

---

## 11. 实现落点

| 文件 | 变更 |
|---|---|
| `src/relay/chat-store.mjs` | **新增**：复制日志、generation、applied 水位、分页、导入、保留/硬上限压缩、tombstone 过滤（§5.2） |
| `src/relay/project-sync.mjs` | **新增**：项目快照导出 + 确定性合并 |
| `src/relay/cluster-sync.mjs` | chat/projects 两个域：feature 探测、调度、拉页、解封、游标、`/v1/cluster/chat`、`/v1/cluster/projects`、healthz `domains` 诊断 |
| `src/relay/fleet-messages.mjs` | `insertImported`（无配额、幂等、按 at_ms 插入）、`pruneBefore`、`deleteSession`/`onDelete` 钩子 |
| `src/relay/server.mjs` | chatStore 构造与启动装载、fleetMessages 种子、域 glue（`_applyChatRecord`/`_exportProjectPage`/`_applyRemoteProject`/`_maintainChat`）、`deleteChatSession`、读水位持久化、healthz featureBits |
| `src/relay/persistence.mjs` | `instance-id.json`、`projects/objects.json`、`cluster/domains.json` 的原子读写 |
| `src/relay/state.mjs` | 读水位持久化/恢复、项目对象内联持久化、项目事件广播钩子 |
| `src/relay/project-{locks,notifications,refs,reviews,room}.mjs` | `snapshot()`/`restore()`/`import*` 钩子，供快照合并 |
| `bin/w2m-rabbit.mjs` | Phase 2 环境变量（间隔/窗口/保留/容量/页大小/关域）与 `--help` 文案 |
| `test/chat-store.test.mjs` / `test/project-sync.test.mjs` / `test/cluster-domains.test.mjs` | Phase 2 单元/传输测试（52 项） |
| `test/relay-phase2-server.test.mjs` | server 接线：feature/路由/持久化/重启/跨 relay 拉取/混合版本/tombstone/签名文案/门禁接线（10 项） |
| `scripts/verify-relay-cluster-phase2.mjs` / `...-mixed.mjs` | 真实进程验证脚本 |

---

## 12. 残余风险与后续工作

按评审风险表编号（`docs/REVIEW-RELAY-PHASE2-20261117.md` §4）逐项交代现状：

1. **删除语义（风险 4）**：数据层已闭环（§5.2），设备面 HTTP 删除路由明确推迟（§5.4）；在路由落地前不得对外宣称跨 relay 删除可用。
2. **版本标签（风险 5）**：展示标签未统一（§2.3）；feature bits 才是兼容契约。发布流程可统一 `W2M_RELAY_VERSION` 口径。
3. **混合版本/滚动升级（风险 6）**：已用真实进程跑通并留证（2026-11-17，合并后的树）：`verify-relay-cluster-phase2.mjs` **9/9 PASS**（3 个 relay 子进程、真实 HTTP cluster 路由、含重启恢复）；`verify-relay-cluster-mixed.mjs` **6/6 PASS**（2×Relay 3.0.0 归档 + 1×本构建，含 unsupported 跳过与滚动升级后 chat 收敛）。两个脚本仍是**发布前手工证据**而非 npm 门禁（需要多进程与旧版归档）；真实三台线上环境的验收按 `docs/RUNBOOK-RELAY-ROLLING-UPGRADE.md` §5 执行。
4. **数据迁移与回滚（风险 7）**：见 §8；relay state 不在备份扫描（§7.3）——v3.5.0 备份增强可承接。
5. **并发/原子性（风险 8）**：无 fsync；`projects/objects.json` 与房间快照两次写非事务；`persistence.saveProjectObjects/loadProjectObjects` 目前没有调用者（state 内联实现重复）——清理死代码列为后续。
6. **容量/性能（风险 9）**：启动时同步 `readLog()` 加载 chat 日志；未开 cluster 的 relay 只在启动 prune；project 事件全量 JSON 写。当前状态可接受，优化（阈值/异步/分页加载）列为后续。
7. **机密与静态数据（风险 10）**：见 §7.2；不承诺 relay 侧 E2E。
8. **测试门禁（风险 3）**：Phase 2 全部套件已进 `scripts.test`/`test:all`（含 server 接线测试），preflight 的「每个磁盘上的套件都有脚本命名」「ci/release 跑 scripts.test」两项结构门禁覆盖它们；三节点/混合版本真实进程验证仍是**发布前手工证据**（脚本未进 npm 门禁，因为需要多进程与旧版归档）。
