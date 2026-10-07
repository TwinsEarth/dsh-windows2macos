# W2M 线协议 v1（冻结）

> 项目：**DSH: Windows2MacOS** · 版本 **0.0.1** · 本文件是 Rabbit / Localside / DSH 插件三方共同遵循的**唯一契约**。
> 任何一方改动本文件即为**破坏性变更**，必须同时升 `protocol_version`。

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
| `GET` | `/v1/tasks/{task_id}` | Bearer | 任务状态 + 六态聚合 | 是 |
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

**index 如何分配**：`replicate` → 所有机器 `index = 0`、`index_total = 1`；`split` → 按设备顺序 `index = i % index_total`。
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
- 六态之外还有两个仅作展示的值：`pending`（首条结果到达前）、`refused`（所有 lease 都被能力门拒绝）。

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
| `mode` | `replicate`\|`split` | |
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

### 6.3 六态聚合（Rabbit 侧）
```
Step 0  任一机器 refused                                    → 该机记 refused（不阻断其他机器）
Step 1  任一机器缺必需字段 或 base_commit≠期望 或
        pre_tree_fingerprint≠base_tree 或 command_hash 不一致 → unverifiable（拒绝汇总）
Step 2  其余机器中：
        全部 ok                                              → 进 Step 3
        部分 ok、部分 {nonzero_exit,timeout,crashed}          → partial
        全部 {nonzero_exit,timeout,crashed}                  → failed
Step 3  比对全部"可比字段"：
        全等                                                 → consistent
        仅 toolchain/platform 不同且差异集中在 stdout 文本    → divergent-platform（期望内，不告警）
        其他差异                                             → divergent（列出字段与逐机取值）
```

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
