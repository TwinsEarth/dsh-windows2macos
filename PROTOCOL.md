# W2M 线协议 v1（冻结）

> 项目：**DSH: Windows2MacOS** · **线协议版本 `1`**（`protocol_version = 1`，未变）· 本文件最后校对的软件版本 **`@twinsearth/w2m-dsh-plugin@0.5.9`** · 本文件是 Rabbit / Localside / DSH 插件三方共同遵循的**唯一契约**。
> 任何一方改动本文件即为**破坏性变更**，必须同时升 `protocol_version`。
> 两个版本号不是一回事：**线协议版本**只在破坏性变更时上升，**软件版本**是写这份文件时校对过的发行版；软件版本比协议版本变得频繁得多，不要把它们混为一谈。

---

## 0. 设计约束（不可协商）

| 约束 | 含义 |
|---|---|
| **零第三方运行时依赖** | 只用 `node:` 内置模块。**禁止** `require`/`import` 任何 npm 包（`ws`、`eventsource` 等一律不用） |
| **ESM** | 全部 `.mjs` 或 `import` 语法；`package.json` 声明 `"type": "module"` |
| **传输 = SSE + POST** | 下行 `text/event-stream`，上行 `application/json` 的 POST。**不用 WebSocket**（避免自己写 101 握手与掩码） |
| **默认只读** | `mode: replicate` 默认 `write: false`；Localside 不得在只读模式下写项目 |
| **argv 数组** | 命令一律以数组传递，**永不拼接 shell 字符串** |
| **能力不匹配 → refused** | 绝不静默降级 |
| **锚不匹配 → unverifiable** | 拒绝汇总，与"结果分歧"分开记账 |
| **先落盘再回传** | agent 收到任务先写本地 spool，执行完再回传，收到确认才清 |

---

## 1. 版本与端点

`protocol_version = 1`。所有请求/响应均为 UTF-8 JSON。时间一律 **RFC3339 UTC**，哈希一律**小写 hex**。

| 方法 | 路径 | 鉴权 | 用途 | 幂等 |
|---|---|---|---|---|
| `GET` | `/healthz` | 无 | 存活探针 | — |
| `POST` | `/v1/pair` | 配对码 | 用一次性配对码换取 `device_token` | 是 |
| `GET` | `/v1/stream?machine_id=&seq=` | Bearer | SSE 长连（下行事件） | 是（`Last-Event-ID` 可重放） |
| `POST` | `/v1/heartbeat` | Bearer | 租约续期 + 在线心跳 | 是 |
| `POST` | `/v1/result` | Bearer | 回传结果信封 | 是（`dedupe_key` 去重） |
| `POST` | `/v1/task` | Bearer | 提交任务（插件调用） | 否（每次新 `task_id`） |
| `GET` | `/v1/devices` | Bearer | 设备表 | 是 |
| `GET` | `/v1/tasks/{task_id}` | Bearer | 任务状态 + 九态聚合 | 是 |
| `GET` | `/v1/tasks/{task_id}/report?format=md\|json` | Bearer | 汇总报告 | 是 |
| `GET` | `/v1/tasks?limit=N` | Bearer | 任务列表 | 是 |

鉴权头：`Authorization: Bearer <device_token>`。缺失/错误 → `401`，body `{"error":{"code":"UNAUTHORIZED"}}`。

---

## 2. 设备身份与配对

### 2.1 本地身份文件
`$DSH_HOME/xclient/device.json`（权限 0600）：
```json
{
  "machine_id": "<uuid v4，首次生成后永久不变>",
  "machine_name": "win-desktop",
  "device_token": "<配对成功后写入>",
  "rabbit_url": "http://127.0.0.1:8787"
}
```
> `machine_id` **不得**用 hostname（hostname 会变、会重名）。

### 2.2 配对流程
```
1. Rabbit 首次启动生成一次性配对码，打印：  PAIR-XXXXXXXX   （8 位大写字母数字，24h 有效，成功即失效）
2. agent POST /v1/pair  {pairing_code, machine_id, machine_name, platform, caps}
3. Rabbit 校验 → 200 {device_token, rabbit_time, protocol_version}
4. agent 把 device_token 写入 device.json
```
`POST /v1/pair` 请求：
```json
{
  "pairing_code": "PAIR-7K2M9QX4",
  "machine_id": "3f2a…",
  "machine_name": "win-desktop",
  "platform": { "os": "windows", "os_version": "10.0.26100", "arch": "x64",
                "shell": "pwsh", "node": "v24.21.0" },
  "caps": { "case_sensitive_fs": false, "symlinks": false, "exec_bit": false,
            "python": null, "npm": null, "node": "v24.21.0" },
  "user_id": "<可选；本机 DeepSeek 账号 userId，用于同账号房间准入>"
}
```
响应：`{ "device_token": "…", "protocol_version": 1, "rabbit_time": "…", "next_pairing_code": "PAIR-…" }`

**配对码的生命周期（v0.0.1 修订）**：一个组不止一台机器，而初稿的"一次性配对码"会让运维**无法配第二台机器**（除非重启中继）—— 这是实测发现的可运维性缺陷。现行为：
1. 某码被成功使用后**立即作废并自动生成新码**，新码在响应 `next_pairing_code`、SSE `notice/PAIRING_CODE_ROTATED`、以及中继 stdout 上同时给出；
2. 运维的典型流程是：配机器 A → 看到新码 → 用新码配机器 B；
3. 需要"一个码配完整个窗口"（自动化场景，没人在看 stdout）时，用 `pairingCodeReusable: true` 启动中继，此时该码在 TTL 内可重复使用；
4. `--pairing-code <c>` 可指定固定码，但**仍然是单次 + 轮换**语义。

注意：`POST /v1/pair` 用同一个 `machine_id` 再次配对会**吊销该机器上一个 token**（防重放），`re_paired` 标记在设备表里可查。

---

## 3. SSE 事件流

### 3.1 帧格式
标准 SSE：`event: <type>` + `data: <json>` + 空行。服务端同时发 `id: <seq>`，客户端断线重连时带 `?seq=<last+1>` 或 `Last-Event-ID` 头。

**首帧必须是 `ready`**，客户端在收到 `ready` 之前**不得**认为已连接（照抄 DSH 自身 `$events` 的语义：先 ready 再增量）。

### 3.2 事件类型
| `type` | 字段 | 说明 |
|---|---|---|
| `ready` | `seq, protocol_version, rabbit_time, machine_id` | 连接就绪；此后才开始增量 |
| `task.offer` | 见 §4.2 | 下发任务 |
| `task.cancel` | `task_id, reason` | 取消 |
| `task.result` | `task_id, dedupe_key, attempt, index, status, machine_id, deduped, validation_errors[]` | **v0.0.1 追加**：某台机器回传了结果。初稿遗漏了"结果到达"事件，导致插件只能轮询。客户端**必须忽略未知 `type`**，因此追加是向后兼容的 |
| `peer.hello` | `machine_id, machine_name, platform` | 有新设备上线 |
| `peer.bye` | `machine_id, reason` | 设备离线 |
| `notice` | `level: info\|warn\|error, code, message` | 服务端通告。`code` 见下表 |

**`notice.code` 取值**：`PAIRING_CODE_ROTATED`（配对码已轮换，新码在 `pairing_code` 字段）、`REPLAY_TRUNCATED`（请求的 `seq` 已超出环形缓冲窗口）、`LEASE_TAKEOVER_UNAVAILABLE`（有 index 需要接管但没有空闲机器）。

每条事件都带 `seq`（**单调递增整数，从 1 开始，进程生命周期内唯一**）。SSE 保活：每 **15s** 发一行注释 `: keepalive`。

---

## 4. 任务与投递

### 4.1 `POST /v1/task` 请求
```json
{
  "mode": "replicate",
  "command_argv": ["node", "--test"],
  "cwd_rel": ".",
  "index_total": 1,
  "timeout_ms": 300000,
  "write": false,
  "write_scope": ["src/"],
  "require_exclusive_write": false,
  "base_commit": "9f1c…",
  "base_tree": "4b8e…",
  "requirements": { "toolchain": { "node": ">=20" }, "platform": ["windows","macos"] },
  "compare_policy": { "strip_ansi": true, "normalize_crlf": true,
                      "strip_trailing_blank_lines": true, "redact": [] },
  "halt": "never",
  "created_by": "win-desktop"
}
```
响应：`{ "task_id": "<ULID>", "leases": [ {"machine_id":"…","index":0,"state":"queued"} ], "seq": 42 }`

**任务发给谁（初稿未定义，v0.0.1 补充）**：可选字段 `target_machines: ["<machine_id>", …]`。
- 给了 → 只发给列出的机器；
- 没给 → 发给**全部已配对设备**。

**index 如何分配**（`src/relay/state.mjs` 的 `createTask`）：`replicate` → 所有机器 `index = 0`、`index_total = 1`；`split` → 按设备顺序 `index = i % index_total`。

**四种 mode**：`replicate`（每台机器跑同一条命令）、`split`（按 index 切片）、`broadcast`（**只有一台**机器执行，由 `executor_machine_id` 指定；其余机器拿到 `state: "observing"` 的 lease，只被告知结果而**不执行**）、`pipeline`（每台机器按顺序跑完 `stages` 整条链，遇首个失败阶段即停；`stages` 仅在此 mode 下合法，最多 16 个阶段，且 `index_total` 必须为 1）。

> `observing` 是 **lease 状态**，不是 `outcome`：它持有该任务的一个位置并会被告知结果，但从未拿到命令，因此**不经过能力门**（拒绝一件没让你做的事不算拒绝），并且**被排除在每一个聚合步骤之外** —— 没跑过的机器永远不会被记成"结果一致"。

能力门失败的机器仍会拿到一条 `state: "refused"` 的 lease，但**不会收到 offer**。

### 4.1.1 `GET /v1/tasks/{task_id}` 响应形状（初稿未定义，v0.0.1 补充）
```json
{
  "protocol_version": 1,
  "rabbit_time": "2026-10-07T12:00:00Z",
  "task":  { "task_id": "…", "mode": "replicate", "index_total": 1, "base_commit": "…", "created_at": "…" },
  "leases": [ { "machine_id": "…", "index": 0, "attempt": 1, "state": "done" } ],
  "aggregate": {
    "status": "consistent",
    "machines": [
      { "machine_id": "…", "machine_name": "win-desktop", "index": 0, "attempt": 1,
        "lease_state": "done", "outcome": "ok", "status": "ok",
        "refusal_reason": null, "exit_code": 0, "reasons": [] }
    ],
    "steps": [ { "step": 0, "name": "capability gate", "refused": [] }, "…" ],
    "differences": [],
    "counts": { "refused": 0, "unverifiable": 0, "ok": 2, "failed": 0, "expired": 0, "pending": 0 },
    "notes": [],
    "expected": { "base_commit": "…", "base_tree": "…", "command_hash": "…" }
  }
}
```
- **终态判定读 `aggregate.status`**（不是顶层 `status`，也没有顶层 `aggregate` 字符串）。
- `machines[].outcome` 是**每台机器**的判定，`machines[].reasons[]` 是它被扣分的具体理由（例如 `"pre_tree_fingerprint != base_tree"`）。
- `aggregate` 在结果到达前是 `pending`。**`pending` 与"某台机器仍 pending"都不算终态**：初稿的六态里 `partial` 会在第一台结果落地时立刻出现，此时其余机器仍在跑 —— 消费者必须同时检查 `machines[].outcome === "pending"`。
- **九态**（`AGGREGATE_STATUSES`，`src/relay/report.mjs`）：`consistent`、`divergent`、`divergent-platform`、`degraded`、`failed`、`partial`、`timeout`、`cancelled`、`unverifiable`。其中 `timeout` / `cancelled` / `degraded` 是 v0.3.0 追加的三个**判定**，各自取代了一个说得不准确的说法：`timeout` 取代"永远 `pending`"，`cancelled` 取代与 `failed` 混同，`degraded` 取代借用的 `partial`（后者同时意味着"还有机器没回"）。
- 九态之外还有两个**仅作展示、不是判定**的值：`pending`（首条结果到达前，**唯一非终态**）、`refused`（所有 lease 都被能力门拒绝 —— 每台机器都已作答，等待不会改变结论，故按终态处理）。

### 4.2 `task.offer` 事件
```json
{
  "type": "task.offer",
  "seq": 43,
  "task_id": "01J…",
  "attempt": 1,
  "mode": "replicate",
  "index": 0,
  "index_total": 1,
  "command_argv": ["node", "--test"],
  "cwd_rel": ".",
  "write": false,
  "timeout_ms": 300000,
  "base_commit": "9f1c…",
  "base_tree": "4b8e…",
  "requirements": { },
  "compare_policy": { },
  "dedupe_key": "<sha256>",
  "deadline": "2026-10-07T12:00:00Z"
}
```

### 4.3 租约（长租约 + 进度心跳 —— **不是固定超时**）
```
agent 认领后每 10s POST /v1/heartbeat {task_id, machine_id, attempt, phase, progress}
  phase ∈ {preparing, running, finalizing}
Rabbit 收到心跳即续期；连续 2 个心跳周期（20s）+ grace 30s 未收到 → 该 lease 判 expired
  → halt=never 时仅记账并标 partial；halt=now 时立即通知其他机器可接管
租约到期判断**由 Rabbit 的时间裁定**，agent 不得自行判断（避免时钟漂移导致双主）
```
响应：`{ "lease_until": "…", "cancel": false }` —— `cancel: true` 表示该任务已被取消，agent 应立即停止。

### 4.4 去重（**v0.0.1 修订：幂等键是三元组**）
```
dedupe_key = sha256(task_id + "|" + index + "|" + command_hash + "|" + base_tree)
幂等键      = (machine_id, dedupe_key, attempt)
```
> ⚠️ **这是对本协议初稿的一处修正，实现必须照此。** 初稿写"重复投递命中已有结果即去重"，但 `dedupe_key` 里**没有 `machine_id`**，于是 `replicate` 模式下所有机器算出**同一个** key —— 严格按它去重会把除第一台外**所有机器的结果静默丢弃**，§6.3 的跨机聚合直接不可能。修正后的行为：
> - 同一机器 + 同一 `attempt` 重复 POST → `200 {"deduped": true}`，账本不新增行
> - 不同机器 → 结果全部入库
> - 同一机器 + 更大 `attempt`（中继重新投递 = 真重试）→ 视为新一次执行，入库

**两条重传语义（易错，务必区分）**：

| 场景 | `attempt` | 结果 |
|---|---|---|
| 传输失败重发（网络抖动，重发**同一个**结果） | **不变** | `deduped: true` |
| 中继因租约过期/接管而**重新投递** | **+1** | 必须真正重跑（缓存键含 `attempt`） |

---

## 5. 结果信封

`POST /v1/result` body = 完整信封。UTF-8 JSON，字段 snake_case。**未知字段必须被忽略**（向前兼容）。

### 5.1 必需字段（缺一即 `unverifiable`）
| 字段 | 类型 | 语义 |
|---|---|---|
| `envelope_version` | string | `"1.0"` |
| `task_id` | string | ULID |
| `attempt` | int ≥1 | 第几次投递 |
| `dedupe_key` | string | 见 §4.4 |
| `machine_id` / `machine_name` | string | 身份 |
| `platform` | object | `{os, os_version, arch, shell, shell_version}` |
| `caps` | object | 能力声明 |
| `index` / `index_total` | int | replicate 固定 0/1 |
| `mode` | `replicate`\|`split`\|`broadcast`\|`pipeline` | |
| `cwd_rel` | string | 相对项目根，正斜杠 |
| `base_commit` | string | 中继广播 |
| `base_tree` | string\|null | 期望工作区指纹 |
| `pre_tree_fingerprint` | string\|null | 执行前实测 |
| `post_tree_fingerprint` | string\|null | 执行后实测 |
| `fingerprint_algo` | string | `git-temp-index-tree/v1` |
| `fingerprint_error` | string\|null | 失败原因码 |
| `head_commit` | string\|null | 结束时 HEAD |
| `dirty_before` | bool | 执行前是否 dirty |
| `command_argv` | string[] | 实际 argv |
| `command_hash` | string | `sha256(JCS(argv)+"|"+shell_id+"|"+cwd_rel)` |
| `shell_id` | string | `direct-exec`（v0.0.1 只用直执行） |
| `started_at` / `ended_at` | string | RFC3339 UTC |
| `duration_ms` | int | 墙钟 |
| `exit_code` | int\|null | 被信号杀死为 null |
| `status` | enum | `ok\|nonzero_exit\|timeout\|crashed\|refused\|unverifiable` |
| `refusal_reason` | string\|null | `status=refused` 时必填 |
| `stdout_sha256` / `stdout_bytes` | string / int | **原始字节流** |
| `stderr_sha256` / `stderr_bytes` | string / int | 同上 |
| `warnings` | string[] | 告警码 |
| `envelope_sha256` | string | 除本字段外 JCS 规范化后哈希 |

### 5.2 可选字段（有则参与比对）
`stdout_normalized_sha256`、`stdout_head`/`stdout_tail`（各 4 KiB，**不参与比对**）、`artifacts[{path,algo,hash,size}]`、`diff_numstat[{path,added,deleted,is_binary}]`、`untracked[]`、`tests{runner,total,passed,failed,skipped}`、`semantic_counts{}`、`toolchain{}`、`lockfiles[]`、`unpinned_deps`、`submodules[]`、`lfs`、`signal`。

### 5.3 可比字段（只有这些参与一致性判定）
`task_id, index, index_total, mode, cwd_rel, base_commit, base_tree, pre_tree_fingerprint, fingerprint_algo, fingerprint_error, head_commit, command_hash, shell_id, exit_code, status, refusal_reason, stdout_sha256, stdout_bytes, stdout_normalized_sha256, stderr_sha256, artifacts, diff_numstat, tests, semantic_counts, warnings`

### 5.4 告警码
`CASE_COLLISION`、`CRLF_DRIFT`、`SUBMODULE_DIRTY`、`LFS_MISSING`、`PATH_INVALID`、`INDEX_LOCK`、`NONDETERMINISTIC_OUTPUT`、`DIRTY_WORKTREE`、`FINGERPRINT_UNAVAILABLE`

---

## 6. 能力门与聚合判定

### 6.1 能力门（下发**前**，逐机）
```
若 task.requirements.toolchain 中某项该机不满足（如 node 版本）→ 该机 status = refused, refusal_reason = MISSING_<X>
若 task.requirements.platform 非空且不含该机 os               → refused, PLATFORM_MISMATCH
若 task.write == true 且该机 caps 不支持写（只读挂载等）        → refused, READ_ONLY_MACHINE
```
`refused` **不是失败**，是"拒绝执行"，单独记账。

### 6.2 三锚（一致性判定的前提）
`base_commit` + `pre_tree_fingerprint` + `command_hash`。
> `toolchain` / `platform` **不是锚**，它们走能力门。

### 6.3 九态聚合（Rabbit 侧）

步序是契约的一部分：Step 0 → 1 → 2 → 3，**永不合并**，因为顺序会改变结论。

```
Step 0  任一机器 refused                                    → 该机记 refused（不阻断其他机器）
                                                             全部被拒 → 聚合 status = refused，Step 2/3 跳过
Step 1  任一机器缺必需字段 或 base_commit≠期望 或
        pre_tree_fingerprint≠base_tree 或 command_hash 不一致 → unverifiable（拒绝汇总）
Step 2  其余机器中：
        全部 ok                                              → 进 Step 3
        部分 ok、部分 {nonzero_exit,timeout,crashed}          → degraded   （所有机器都已作答）
        部分 ok、部分失败，且仍有机器 pending                  → partial    （"还有机器没回"）
        全部 {nonzero_exit,timeout,crashed}                  → failed
        无人作答且已过 deadline                              → timeout    （等够了，不会再来）
        操作者主动停止                                        → cancelled  （不是故障，不得报成 failed）
Step 3  比对全部"可比字段"：
        全等                                                 → consistent
        仅 toolchain/platform 不同且差异集中在 stdout 文本    → divergent-platform（期望内，不告警）
        其他差异                                             → divergent（列出字段与逐机取值）
```

**两个非判定值**：`pending`（首条结果到达前，唯一非终态）、`refused`（所有 lease 都被能力门拒绝）。

`degraded` 与 `partial` 的分工是 v0.3.0 修正的一处失真：`partial` 同时意味着"还有机器没回"，于是一个**已结束但部分失败**的任务和**仍在进行**的任务在 `status` 这一个字段上无法区分。现在两者各有其名。

---

## 7. 错误响应统一形状
```json
{ "error": { "code": "UNAUTHORIZED", "message": "…", "detail": { } } }
```
码表：`UNAUTHORIZED`、`BAD_REQUEST`、`NOT_FOUND`、`PAIRING_INVALID`、`PAIRING_EXPIRED`、`TASK_EXISTS`、`FRAME_TOO_LARGE`、`NO_ONLINE_DEVICE`、`INTERNAL`。

### 7.1 `refusal_reason` 码表（v0.0.1 补充）
| 码 | 含义 |
|---|---|
| `COMMAND_NOT_ALLOWED` | argv 不在该机的 default-deny 白名单内 |
| `COMMAND_REPARSING_ARGUMENT` | 白名单条目匹配，但**尾随实参**会让该工具加载条目从未指明的代码（`--test-reporter`、`--import`、`--require`、`-e`/`--eval`、`-p`/`--print`、`python -c`、`bash -c`、`git --exec-path` …）。要跑就必须把该实参写进条目本身 |
| `COMMAND_EXECUTABLE_PATH_MISMATCH` | `argv[0]` 是路径，但不是该条目可执行文件解析到的同一个文件（同名副本不是同一个程序） |
| `COMMAND_EXECUTABLE_RELATIVE_PATH` | `argv[0]` 是相对路径：工作目录由 offer 决定，因此它指向的文件随目录而变，白名单无法判定 |
| `MISSING_<TOOL>` | 例如 `MISSING_PYTHON`、`MISSING_NPM`：能力门要求该工具，但该机探不到 |
| `PLATFORM_MISMATCH` | 任务 `requirements.platform` 不含该机 OS |
| `READ_ONLY_MACHINE` | 任务 `write: true`，但该机项目目录不可写（`fs.access(W_OK)` 失败） |
| `CWD_OUTSIDE_PROJECT` | 任务 `cwd_rel` 解析后逃出项目根 |
| `INVALID_OFFER` | offer 结构非法（缺字段/类型错） |
| `POLICY_VIOLATION` | 其他策略拒绝（如声明 `write_intent: none` 却尝试写） |

### 7.2 `fingerprint_error` 码表（v0.0.1 补充）
`GIT_MISSING`、`NOT_A_REPO`、`NO_HEAD`、`READ_TREE_FAILED`、`ADD_FAILED`、`WRITE_TREE_FAILED`、`GIT_TIMEOUT`、`TEMP_INDEX_FAILED`、`BAD_TREE`。

出现任一 `fingerprint_error` → 该机 `pre_tree_fingerprint` 无法采信 → **`unverifiable`**（而不是"分歧"）。

### 7.3 告警码补充（v0.0.1）
除 §5.4 已列的码外，实测两端都会同样产生的两个：`OUTPUT_TRUNCATED`（stdout/stderr 超过 2 MiB 保留上限，**注意：`stdout_sha256` 覆盖的是完整原始流，不是被截断的部分**）、`AGENT_ERROR`（agent 内部错误）；另加 `DIRTY_WORKTREE`。

### 7.4 不完整信封的处理（v0.0.1 明确）
`POST /v1/result` 收到**缺必需字段**的信封时 **返回 200 并入库**，聚合时记 `unverifiable` —— **不拒收**。理由：拒绝接收等于把"这台机器跑完了但报告不完整"变成"这台机器没有结果"，那是更严重的失真。`validation_errors[]` 会随 `task.result` 事件一并发给观察者。

---

## 8. v0.0.1 明确不做（避免范围蔓延）
- 不做 WebSocket、不做 TLS 终结（由用户前置反代或内网承担）
- 不做自动负载均衡切片（只做 `explicit` / `modulo`）
- 不做写回合并（`write: true` 时仅记录分支名，不做 merge）
- 不做跨机浏览器看板（那是设计文档的 P6）
- 不做 Mac 真机验证（本机无 Mac；代码跨平台但需用户在 Mac 上复验）

---

## 9. P2P 数据面加密（v0.5.3 新增，**附加式扩展，不升版本**）

> **版本号更正。** 本节此前标为 "v0.6.0 新增"。**没有 v0.6.0 这个发行版**：P2P 数据面加密的
> stage 1 随 **v0.5.3**（2026-10-11）发布，`CHANGELOG.md` 的 `[0.5.3]` 条目就是它，本节所称的
> "v0.6.0" 在代码里指的是*这一批加固*，而不是这个包的一个版本。下文凡写 "v0.6.0" 处均按
> "v0.5.3 起的加固"理解。

> **不破坏冻结。** `protocol_version` 仍为 `1`，`envelope_version` 仍为 `1.0`。本节全部内容是
> **可选对象 `p2p` 内部的新键**，以及对**已存在的可选字段** `p2p.encrypted` 的赋值规则；不知道
> 这些键的一端（v0.4.x / v0.5.x）会原样忽略它们，行为与本文件冻结时一致。
> 设计契约见 `docs/P2P-CRYPTO.md`（§4 是规范，§7 是验收清单）。

### 9.1 设备静态密钥

| 项 | 值 |
|---|---|
| 算法 | X25519（`generateKeyPairSync('x25519')`） |
| 私钥存放 | 与 `device.json` 同目录的 `device.key`，权限 0600（**Windows/NTFS 无 POSIX 位，见下**） |
| 生成时机 | 首次配对时生成，此后永不更换；文件损坏 → 硬错误，**绝不静默换新**（换新会使所有认识旧公钥的peer拒绝本机） |
| 公钥编码 | 32 字节 X25519 公钥的标准 base64（44 字符，含 `=` 填充） |

`device.key` 内容（JSON，原子写入）：
```json
{ "format": "w2m-device-key/1", "algo": "x25519", "machine_id": "<uuid>", "private_key": "<base64 32B>" }
```
只存私钥标量，公钥由私钥推导——手改文件无法发布与私钥不匹配的公钥。

**0600 的诚实表述**：在 POSIX 平台上按 0600 写入。**Windows 无 POSIX 权限位**，`chmod` 是
尽力而为且不报错，该文件的实际保护来自用户 profile 目录继承的 ACL，而非本实现。能读到该 profile
目录的本地用户即可读到该私钥。

### 9.2 公钥分发（无人手工填 `[Peer]`）

公钥随**已有的**两条信令一起走，没有新端点：

| 位置 | 字段 | 说明 |
|---|---|---|
| `POST /v1/peer/announce` 请求体 | `static_key` | 可选。非 32 字节 base64 X25519 公钥 → `BAD_REQUEST`（`BAD_STATIC_KEY`）。**缺省即缺省**，不写 `null`——"没有密钥"与"密钥未知"不能同值 |
| `GET /v1/peer/{machine_id}` 响应 `peer` | `static_key` | 与 `candidates` 同级；该机未公告密钥时**该键不存在** |
| `POST /v1/task` 请求体 `p2p` | `static_keys` | `{ "<machine_id>": "<base64 公钥>" }`。中继按既有规则**原样转发**（`validateTaskRouting` 只校验 `p2p.mode` 并整体复制），不解释该键 |
| `task.offer` 帧 `p2p` | `static_keys` | 同上；下发帧在此基础上追加**该帧目标机**的公钥 |

一台机器由此从"要求它谈话的那份 offer"里学到**恰好那些 peer** 的公钥，无需任何本地配置。

### 9.3 握手（两帧，Noise IK 形状）

握手消息**寄生在既有帧类型内**：`HELLO`/`HELLO_ACK` 的 **body 首字节为魔数 `0xA5`** 即为握手消息；
**body 为空**即为 v0.5.x 的普通打洞。v0.5.x 端从不读 body，因此对握手 `HELLO` 会回普通 `HELLO_ACK`；
本端在无对端密钥时也回普通 `HELLO_ACK`。两端都无需预先知道对方是哪个版本。

| 帧 | body 布局（大端） | 长度 |
|---|---|---|
| `HELLO` | `A5 \| ver u8 \| session u32 \| e_i[32] \| idLen u8 \| machineId \| mac[48]` | 87 + idLen |
| `HELLO_ACK` | 同上，`e_r` 替代 `e_i` | 87 + idLen |
| `REFUSE` | `A5 \| ver u8 \| session u32 \| code u8 \| idLen u8 \| machineId[ \| mac 48]` | 8 + idLen，或 56 + idLen |

> 长度是 **87 + idLen**，不是 88：前缀 39 字节（magic 1 + ver 1 + session 4 + `e[32]` 32 + idLen 1），
> 加 `mac[48]` 共 87，再加 `idLen` 字节的 `machineId`。代码里就是
> `HANDSHAKE_PREFIX_BYTES = 1 + 1 + 4 + KEY_BYTES + 1`（39）加 `MAC_BYTES`（48），
> `test/p2p-crypto.test.mjs` 也按 `1+1+4+32+1+byteLength(machineId)+48` 断言。

`mac` = `AEAD(k0, nonce=0, BLAKE2s-256(prologue ‖ ver u8 ‖ session u32 ‖ s_i.pub ‖ s_r.pub))`，48 字节
（32 密文 + 16 tag）。`mac'` = 同 `k0`，消息为 `BLAKE2s-256(HELLO ‖ e_r)`。
`k0 = HKDF-SHA256(ECDH(s_i, s_r))`；会话密钥 `k = HKDF-SHA256(ECDH(e_i,e_r) ‖ ECDH(s_i,e_r) ‖ ECDH(e_i,s_r))`
展开为四个互不相同的 32 字节子密钥（两个握手 MAC、两个方向的数据密钥）。

> **相对 `docs/P2P-CRYPTO.md` §4 的两处偏离，均属更强而非更弱**：MAC 额外绑定了 `session` 与握手
> 版本（否则同一对机器在任何一次打洞中捕获的 `HELLO` 都可在下一次重放）；`mac1`/`mac2` **未实现**
> ——keyed BLAKE2s 未被 `node:crypto` 暴露，它们缓解的是握手路径的 **CPU 耗尽 DoS**，与机密性、
> 真实性无关。该省略以常量 `HANDSHAKE_MAC_FIELDS_OMITTED` 落在代码里，不是沉默。

`REFUSE.code`：`1`=UNKNOWN_PEER、`2`=BAD_MAC、`3`=REPLAY、`4`=NO_KEY、`5`=VERSION、`6`=NO_PEER_KEY。

`REFUSE` 的**可选尾部 48 字节 MAC**（v0.5.3 起的加固，MEDIUM-4 修复）用
`k_ref = HKDF-SHA256(ECDH(e_i, s_r))` 封装，消息为 `BLAKE2s-256(label ‖ 不含 MAC 的 REFUSE)`，其中
`label = "w2m-p2p-crypto v1 refuse"`。两端都能推导 `k_ref`：发起方持有 `e_i` 私钥与 `s_r` 公钥，
响应方持有自己的 `s_r` 与 `HELLO` 里公开的 `e_i`——因此**即使响应方完全没有本机公钥**（`NO_PEER_KEY`
的情形）也仍能给出证明；而 `k0` 在那种情形下根本不存在，这正是这个 MAC 必须用 `k_ref` 的原因。
`NO_PEER_KEY`/`UNKNOWN_PEER`/`BAD_MAC` 在可封装时一律封装；`VERSION` 保持裸体（需要对端的 body 布局
本端无法担保）。因此「`REFUSE` 不认证」这句话只在**旧版本对端**意义上成立：可以没有 MAC，但规则是——
**要求明文的降级类拒绝**（`NO_KEY`/`NO_PEER_KEY`）必须**要么带通过验证的 `k_ref` 证明，要么不带 MAC
且来自「已确认本次打洞的那个地址」**；**终结类拒绝**（`BAD_MAC`/`REPLAY`/版本不符）只要来自打过的地址
就被采纳（无论是否封装），结果里用 `refusal_authenticated` 记下 `true`（证明通过）/`null`（无 MAC）/
`false`（有 MAC 但没通过），账本因此不会把「有人说」当成「对端证明」。丢弃的拒绝数据报只被记录、
绝不使打洞失败——否则伪造一个数据报就成了比压制真实应答更便宜的拒绝服务。

### 9.4 数据面帧加密

启用后**所有帧类型**（`DATA`/`ACK`/`DONE`/`PING`/`PONG`/`BYE`）一律加密，不只 `DATA`：

```
frame = kind u8 | session u32 | A5 | epoch u8 | counter u64le | ciphertext | tag[16]
```
- 前 5 字节**明文但参与认证**（AAD）：改 kind 或 session 即验证失败。
- nonce = `00000000 ‖ counter u64le`（12 字节），ChaCha20-Poly1305，tag 16 字节。整帧开销 **26 字节**。
- `counter` 每方向独立、从 0 起、**跨 epoch 单调不减**（不复位）。
- 64 条滑动重放窗口；窗口外或已见过的计数器 → 丢弃（`P2P_CRYPTO_REPLAYED_FRAME`）。
- **重协商（rekey）**：发送满 2^20 帧或满 120 秒即 `epoch+1`，双方各自沿 HKDF 链推导，无需往返；
  旧 epoch 密钥保留 15 秒以接住在途帧。未认证帧**绝不**用其它 epoch 密钥重试。

### 9.5 拒绝与回退（**拒绝永远具名，回退永不静默**）

| 码 | 含义 |
|---|---|
| `P2P_CRYPTO_NO_KEY` | 本机无密钥，或对端无本机密钥 → 明文通道，已记录 |
| `P2P_CRYPTO_UNKNOWN_PEER` | 握手来自本机未持有公钥的 `machine_id` |
| `P2P_CRYPTO_BAD_MAC` | 对端已知但证明不成立（密钥过期或有人在冒充）→ **不建通道** |
| `P2P_CRYPTO_REPLAY` | 同一 `e_i` 二次出现；重传会收到**逐字节相同**的应答 |
| `P2P_CRYPTO_AUTH_FAILED` | 数据帧 tag 校验失败 → 丢弃，不处理 |
| `P2P_CRYPTO_REPLAYED_FRAME` | 计数器已在窗口内 |
| `P2P_CRYPTO_STALE_EPOCH` / `EPOCH_TOO_FAR` | 密钥已过期 / epoch 超出推导上限 |
| `P2P_CRYPTO_HANDSHAKE_TIMEOUT` | 路径已通但握手未完成 → 不建通道 |
| `P2P_CRYPTO_VERSION_MISMATCH` / `MALFORMED` | 版本或报文形状不可用 |
| `P2P_CRYPTO_PLAINTEXT_PEER` | 对端未学得密钥（v0.5.x 情形）→ 明文通道 |
| `P2P_CRYPTO_REFUSE_SESSION_MISMATCH` | 收到的 `REFUSE` 未指名本次打洞的 session → **丢弃并记录**，不改变结果 |
| `P2P_CRYPTO_REFUSE_UNPUNCHED_SOURCE` | `REFUSE` 来自本次打洞从未打过的地址 → 丢弃并记录 |
| `P2P_CRYPTO_REFUSE_BAD_MAC` | 降级类 `REFUSE` 带 MAC 但验证失败 → 丢弃并记录（终结类拒绝不因 MAC 失败被丢） |
| `P2P_CRYPTO_REFUSE_UNCORROBORATED` | 未封装的降级类 `REFUSE` 并非来自「已确认本次打洞的地址」→ 丢弃并记录 |

**回退规则**：握手失败 → 任务**照旧走中继**，信封记录 `p2p.encrypted: false` 与原因；机器**绝不**
因为安全升级而丢失。唯一不允许的降级是"已持有对端密钥、握手失败后仍建明文通道"——那是一次攻击者
可触发的降级。**这句在 v0.5.3 被收紧为更准确的表述**：握手*失败*本身绝不回落明文；唯一会给出明文
通道的是对端明确声明"无法参与"（`NO_KEY`/`NO_PEER_KEY`），而这样的拒绝必须**要么带 `k_ref` 证明、
要么来自已确认本次打洞的那个地址**。结果里同时记录 `refusal_authenticated`，让账本能区分
「对端证明了自己」与「有人这么说」。仍然存在的残余风险（攻击者能从被打洞对端自己的地址与端口发出
**未封装**的拒绝）写在 `docs/P2P-CRYPTO.md` §2 与 §9 的最后，不再用绝对句掩盖。
四个 `P2P_CRYPTO_REFUSE_*` 码都只记录、**绝不使打洞失败**：否则伪造一个数据报就比压制真实应答更便宜。

### 9.6 信封字段

`p2p` 对象新增（均为可选；`encrypted` 恒存在）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `encrypted` | bool | **仅当**该任务的直连通道确实完成握手并被密封时为 `true` |
| `encryption_reason` | string | `encrypted: false` 时的具名原因（`P2P_CRYPTO_*` 或直接路径未建立的原因） |
| `encryption_session` | number | 可选。承载该任务的会话 id |

`encrypted` 进入 `p2p` 块，因此**在 `envelope_sha256` 覆盖范围之内**——中继无法在不破坏哈希的前提下
改写它。它也**不进入** `COMPARABLE_FIELDS`：传输路径不是执行结果。

### 9.7 兼容性矩阵

| 对端 | 结果 |
|---|---|
| v0.4.x / v0.5.x（无 `static_keys`） | 本端发**普通** `HELLO`，明文通道，任务照常完成，`p2p.encrypted: false` + 具名原因 |
| v0.5.3 及以后，`static_keys` 齐备 | 握手完成，通道密封，`p2p.encrypted: true` |
| v0.5.3 及以后，但本端无对端公钥 | 对端回 `REFUSE(6)`＋普通 `HELLO_ACK` → 明文通道，原因为 `P2P_CRYPTO_NO_KEY` |
| 公钥错误 / 有人在冒充 | `REFUSE(2)` → **不建通道**，任务走中继，账本记 `encrypted: false` + `P2P_CRYPTO_BAD_MAC` |
| 第三方伪造 `REFUSE`（v0.5.9 MEDIUM-4） | 会话不符、地址未打过、MAC 不通过，或降级类拒绝未被同一地址确认 → 丢弃并记 `P2P_CRYPTO_REFUSE_*`，打洞结果不变 |
| 自打洞（relay 把任务租给下发机自己） | 明文通道（自连接无路径可保护，且不得失败）
