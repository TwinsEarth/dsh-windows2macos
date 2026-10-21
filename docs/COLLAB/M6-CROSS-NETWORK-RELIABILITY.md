# M6 跨网络可靠性设计规格

> 状态：**设计稿**。只定义权威通道、分块/断点、离线队列与 P2P 降级语义，不含实现。
> 版本：`1.3.7-beta.*`（GitHub prerelease，不入 npm）。
> 上游：`docs/MULTI-MACHINE-COLLABORATION-PLAN.md` M6；承接 M3（大 patch 制品）与 M4（事件流）的传输需求。

---

## 1. 目标与非目标

### 目标

1. **正确性只依赖 relay**：任务、结果、事件、制品全部走 relay 通道；任何链路的短暂中断都表现为"重试/断点/补齐"，而不是"任务丢失或重复执行"。
2. **大制品可传**：blob 支持分块上传、断点续传、Range 下载；打断后从缺失块继续，最终 sha256 校验通过才算成功。
3. **离线不丢**：机器离线期间任务不被丢（队列 + 重派发）；机器产出的结果先进本地 outbox，重连后幂等投递；客户端事件按 seq 补齐。
4. **P2P 只做加速**：P2P 失败不影响任何任务的正确性；提供明确的模式开关与可观测的成功率，而不是把它当传输保障。
5. **可观测**：重试、断点、outbox 深度、SSE 重连、P2P 成功率、事件延迟全部有指标。

### 非目标（本版本不做）

- 不做多 relay 集群/主备切换（relay 仍是单点；本版本只保证**重启后恢复**）。
- 不做 P2P 数据通道传输大文件（P2P 本版本仍只用于 offer 推送加速）。
- 不做端到端 TLS 终止（relay 当前 HTTP；TLS 由部署层反代决定，本版本只保证协议向后兼容）。
- 不做跨 relay 的数据迁移。

---

## 2. 现状与缺口

| 现有 | 缺口 |
|---|---|
| relay 持久化（tasks/devices/results/messages/ledger/blob） | 重启恢复已具备；缺**进行中传输**的恢复 |
| blob 单次 PUT，帧上限 16 MiB，存储上限 8 MiB/256 个 | 无分块、无断点；>8 MiB 制品直接失败；中断即丢弃 |
| SSE 事件流 + seq | 断线重连可用；但**事件保留窗口外的补齐**依赖快照（M4 已有） |
| 任务 re-offer（设备重连时 re-offer offered/queued） | 已有；缺"结果本地 outbox + 幂等重投" |
| P2P（STUN/UDP，auto/direct/relay） | 明文拒绝、NAT 不可测；当前把 P2P 当传输路径，失败才回落 |
| 心跳/租约 | 已有；缺"离线机器的任务不丢"的明确语义（等待 vs 过期） |

---

## 3. 通道分级（权威性）

```
控制通道（权威）：POST /v1/task、任务/租约/结果、项目事件、memory、通知 —— 全部走 relay HTTP
数据通道（权威）：blob store（分块/断点后）—— 与任务解耦，内容寻址（sha256）
加速通道（机会性）：P2P offer push —— 只影响"offer 到达得快不快"，不影响正确性
```

不变量：

1. **结果只通过 relay 提交**（P2P 不承载结果）。
2. **任何任务可被重派发**：P2P 推送的 offer 与 relay SSE 的 offer 用同一 `(task_id, attempt, dedupe_key)` 去重（已有），所以 P2P 丢失/重复都不破坏 exactly-once 语义。
3. **制品以 sha256 为身份**：上传完成前不可引用；引用后内容不可变。

---

## 4. Blob 分块 / 断点

### 4.1 上传会话协议

```
POST /v1/fleet/blob-sessions
  { sha256, size, chunk_bytes? }            → 201 { session_id, chunk_bytes, chunks, received: [] }
PUT  /v1/fleet/blob-sessions/:sid/chunks/:index   (octet-stream, ≤ chunk_bytes)
  → 200 { received: [..] }  | 409 SESSION_COMMITTED  | 413 CHUNK_TOO_LARGE
GET  /v1/fleet/blob-sessions/:sid         → { received: [..], missing: [..], expires_at }
POST /v1/fleet/blob-sessions/:sid/commit  → 200 { sha256, bytes }  | 400 BLOB_SHA_MISMATCH
```

- `chunk_bytes` 默认 1 MiB（上限 8 MiB，必须整除 size 或最后一块短）；`chunks ≤ 256`（即单 blob ≤ 256 MiB，默认配额另设）。
- 会话 TTL 24h；commit 后会话删除，块拼成最终 blob 并校验 sha256；校验失败删除并返回 `BLOB_SHA_MISMATCH`。
- 块 PUT 幂等：同一 index 重传覆盖；乱序允许；`received` 返回已收列表，客户端据此续传。
- 并发：同一会话的块可并发（不同 index），commit 等待所有块到齐（否则 `BLOB_INCOMPLETE` + missing）。
- 配额：单机器并发会话 ≤2、未完成会话总字节 ≤ 512 MiB；超限 `BLOB_QUOTA`。
- 存储：块存临时目录；commit 后写入现有 blob store（复用现有 `MAX_BLOB_BYTES` 机制，但改为可配置上限，默认 64 MiB）。

### 4.2 下载断点

```
GET /v1/fleet/blobs/:sha            （全量；小文件）
GET /v1/fleet/blobs/:sha?range=0-1048575   → 206 Partial Content + Content-Range
```

- 客户端按需 Range 重试；下完校验 sha256，不符重下。
- 大制品（M3 的 patch/conflict）优先 Range 下载，避免一次占满内存。

### 4.3 agent 集成

- 上传决策：输出 > 内联阈值（64 KiB）→ 分块会话上传；≤ 阈值仍内联。
- 断点续传：agent 在 state 目录持久化 `{session_id, sha, received[]}`；重连后 GET 会话 → 缺失块补传。
- 重试策略：块级指数退避（1s/2s/4s/8s，上限 60s，最多 10 次）；会话过期则重新开新会话并全量重传（不无限重试）。
- 失败语义：上传最终失败 → 任务结果标记 `BLOB_UPLOAD_FAILED`（与 v1.3.1 一致），不引用不存在的 blob。

### 4.4 错误码

```
BLOB_INCOMPLETE        commit 时缺块（返回 missing）
BLOB_SHA_MISMATCH      拼接后 sha 不符（删除会话）
BLOB_QUOTA             会话/字节超配额
CHUNK_TOO_LARGE        块超过 chunk_bytes
SESSION_NOT_FOUND      会话过期/不存在
SESSION_COMMITTED      已 commit 后继续写块
BLOB_TOO_LARGE         声明 size 超过配置上限
```

---

## 5. 离线队列与结果 outbox

### 5.1 任务侧（relay）

- 任务创建后若无在线可执行机器：任务保持 `queued`（不丢），机器上线时 re-offer（已有）；`depends_on` 在依赖完成后释放（已有）。
- 租约过期不等于任务失败：`expired` 是租约状态；relay 管理端看到任务仍可被重派发（`max_attempts` 策略决定是否终止）。
- 明确语义：`halt` 策略（never/now）已有，保持；本版本不改语义，只补可观测与测试。

### 5.2 结果侧（agent outbox）

- agent 把结果先写本地 outbox（state 目录 JSONL，原子写）：`{result_id, task_id, attempt, dedupe_key, payload_sha, attempts, next_retry_ms}`。
- 投递成功（relay 200/已 dedupe）→ 标记 ack 并清理；失败/断网 → 指数退避重试，跨重启继续。
- 幂等：relay 按 `(task_id, attempt)` 结果去重（已有）；outbox 重复投递安全。
- 上限：outbox 200 条/16 MiB，超限只保留最近 + 告警（`OUTBOX_FULL`），避免磁盘无限增长。
- 结果中的 blob 引用：先确保 blob 已 commit，再投递结果（顺序保证）。

### 5.3 客户端侧（DSH 插件）

- SSE 断线重连（已有）+ `since_seq` 补齐（M4）；超出保留窗口 → 快照。
- 通知/项目事件按 seq 补齐；本地只存水位。
- 读请求失败不阻塞界面，显示"连接中/离线"状态（M4 连接状态已有）。

---

## 6. 重启与恢复

| 场景 | 期望行为 | 验收 |
|---|---|---|
| relay 重启（持久化开启） | 设备/任务/结果/事件恢复；租约重派发；seq 连续 | 重启前后任务不丢、事件 seq 连续 |
| agent 重启 | outbox 恢复、未完成 blob 会话续传、worktree/产物状态检查 | 重启后任务重试成功且不重复执行 |
| 客户端重启 | 水位持久化，未读通知仍正确 | 重启后 unread 计数一致 |
| 网络闪断（<30s） | SSE 重连、请求重试；无用户可见失败 | 断网 30s 任务照常完成 |
| 断网 60s（执行机） | 租约过期 → 机器回归后 re-offer；任务不丢 | 断网 60s 后任务完成或明确失败（不悬挂） |

---

## 7. P2P 降级为机会性加速

### 7.1 模式定义（保持现有三值，语义收紧）

| 模式 | 行为 | 正确性依赖 |
|---|---|---|
| `relay`（推荐默认） | 不绑 UDP、不尝试 P2P；offer 只走 relay | 无 |
| `auto`（保持现有默认） | 尝试 P2P push offer；失败/超时静默回落 relay；结果仍只走 relay | 无（P2P 只影响延迟） |
| `direct` | 要求 P2P 成功，失败则拒绝 offer（`P2P_UNAVAILABLE`） | 有（仅用于可控内网/实验） |

### 7.2 修复与约束

- **明文拒绝**：启用加密时，P2P 握手失败（对端明文）→ 只记录 `P2P_CRYPTO_PLAINTEXT_PEER` 并回落 relay，不重试明文通道。
- **NAT 不可测**：`auto` 下 N-1 台机器之间无成功记录时，P2P 成功率指标会下降；不做"强制打洞"。
- **去重**：P2P offer 与 relay offer 以 `(task_id, attempt, dedupe_key)` 去重（已有），重复到达不执行两次。
- **默认值建议**：`auto` 保持默认以兼容现有配置，但文档明确"P2P 不承担正确性"；`direct` 标记为实验性。
- **指标**：`p2p_push_attempts / success / fallback`、`p2p_crypto_refusals`、offer 到达延迟（P2P vs relay）。

---

## 8. 可观测性指标（M6）

```
blob_upload_sessions_open / committed / failed
blob_chunks_retried / bytes_transferred / resume_count
blob_download_range_requests / sha_mismatch
agent_outbox_depth / retries / dropped
sse_reconnects / events_replayed
task_requeued_on_reconnect / lease_expired_total
p2p_push_attempts / p2p_push_success_ratio / p2p_fallback_total
relay_event_lag_ms（事件时间 vs 客户端应用时间）
```

全部经 `w2m_stats`/metrics 路由暴露；M7 统一验收。

---

## 9. 验收（真实任务 + 混沌）

### 正向

1. **大制品**：上传 40 MiB patch 制品（分块）→ 下载校验 sha 一致；同时验证 8 MiB 旧上限不再阻断。
2. **断点续传**：上传到 50% 断开 agent → 重连后只补缺失块，最终 commit 成功、sha 正确。
3. **离线结果**：执行机断网 60s 完成任务 → 结果进 outbox → 恢复后投递，任务只执行一次（ledger 无重复结果）。
4. **断网 30s**：SSE 客户端断网 30s → 重连补齐事件，无丢事件。
5. **relay 重启**：重启前后项目事件 seq 连续、任务不丢、租约重派发。

### 负向（自动化）

```
块缺失 commit → BLOB_INCOMPLETE(missing)
块被篡改 → BLOB_SHA_MISMATCH，blob 不存在
会话过期后写块 → SESSION_NOT_FOUND
超配额 → BLOB_QUOTA
重复块 PUT → 幂等（received 去重）
P2P 明文对端 → 回落 relay，任务成功
P2P direct 模式无通道 → P2P_UNAVAILABLE（仅此模式）
outbox 满 → 保留最近 + OUTBOX_FULL 告警，进程不崩
```

---

## 10. 交付物清单（实现阶段）

```
src/relay/blob-sessions.mjs    分块会话、commit 校验、配额、TTL 清理
src/relay/server.mjs           blob-sessions 路由、Range 下载、帧上限适配
src/relay/state.mjs            blob 元数据（size/上限可配）
src/agent/blob-upload.mjs      分块上传、断点续传、持久化会话状态、重试
src/agent/outbox.mjs           结果 outbox（原子写、退避、aek 清理、上限）
src/agent/agent.mjs            接入 blob-upload/outbox；重连后恢复
src/plugin/fleet-chat-route.mjs  面板连接状态（SSE 重连/事件延迟）
src/plugin/tools.mjs           w2m_stats 增加 M6 指标
lib/client.js                  连接状态显示（重连/补事件）
test/blob-sessions.test.mjs    会话/缺块/篡改/配额/幂等
test/outbox.test.mjs           重试/幂等/上限/跨重启
test/reliability-e2e.test.mjs  断网/重启/大文件（本地模拟）
docs/COLLAB/M6-CROSS-NETWORK-RELIABILITY.md  本文
```

## 11. 开放问题（实现前确认）

1. **blob 上限**：默认 64 MiB/单个是否够用（M3 的 patch 通常小，但二进制制品可能大）？总配额（每机器 512 MiB 未完成会话）是否合适？
2. **chunk 大小**：1 MiB 默认是否合适（帧上限 16 MiB，可调到 4 MiB）。
3. **P2P 默认模式**：保持 `auto` 还是改为 `relay`（更诚实但改变现有行为）？
4. **Range 下载**：本版本就做，还是只做全量下载 + 客户端分段拉取？
5. **outbox 上限**：200 条/16 MiB 是否够用？
6. **relay TLS**：是否把反代 TLS 作为 M6 部署验收的一部分（当前 HTTP 明文，跨网络安全性问题）？
