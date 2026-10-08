# W2M 线协议 v0.3.0 增量（跨机 RTT 走中继）

> 基线：`PROTOCOL.md`（v1 冻结）+ `PROTOCOL-v0.1.2.md` 增量。**本文件只写增量**，未提及的部分一律不变。
> `PROTOCOL_VERSION` **保持 1**：全部是向后兼容的**追加**（新可选字段、新响应字段、新端点）。
> 主题：让**延迟**这个诊断量跨机器可见。

---

## 0. 为什么需要这版

v0.2.3 的 RTT 走**本机文件**（agent 写 `<stateDir>/agent-state.json`，插件读同一个文件）。同机可用，但：

- 跨区域部署下**插件在 A 机、agent 在 B 机**，文件通道完全无效；
- 中继才是唯一同时看得见所有机器的地方。

因此 v0.3.0 起，**RTT 由 agent 通过心跳上报给中继，由中继存储并暴露**。本机文件通道不再承担跨机职责。

---

## 1. 设计原则（本版新增条款）

| 原则 | 含义 |
|---|---|
| **`null` ≠ `0`** | `null` 是"从未测到"，`0` 是"极快"。任何把二者混同的实现都是缺陷 |
| **陌生字段不拒绝** | 心跳里出现本版不认识的字段必须被忽略并正常处理，不得 400 |
| **诊断量不得影响主流程** | `rtt_ms` 缺失或非法**绝不**导致心跳失败；租约续期永远优先 |
| **重启不撒谎** | 易失量（RTT）不持久化、不恢复；重启后一律回到"不知道" |
| **只增字段** | 不删字段、不改字段语义、不改已有端点行为 |

---

## 2. `POST /v1/heartbeat`：两种模式 + 新增可选字段 `rtt_ms`

v0.3.0 起心跳有**两种模式**，由是否携带 `task_id` 决定：

| 模式 | 触发条件 | 作用 | 是否触碰租约 |
|---|---|---|---|
| **租约心跳** | 携带 `task_id` | §4.3 原语义：续租、`phase`/`progress`、`cancel` 反馈 | **是** |
| **空闲（诊断）心跳** | 不带 `task_id`，且 `diagnostic: true` | 仅刷新该机的 `last_heartbeat_at` / `rtt_ms` | **否，完全不触碰** |
| 都不是 | 无 `task_id` 且无 `diagnostic` | `400 BAD_REQUEST` | — |

```json
// 空闲（诊断）心跳 —— 机器没有任务时也要能被看见
{ "diagnostic": true, "rtt_ms": 42.5 }

// 租约心跳 —— 与 v0.2.3 完全一致
{ "task_id": "01J…", "machine_id": "3f2a…", "attempt": 1, "phase": "running", "progress": 0.4, "rtt_ms": 42.5 }
```

> **§4.3 语义变更**：心跳**不再隐含租约续期**。只有携带 `task_id` 的心跳才续租；不携带 `task_id` 的心跳是纯诊断流量。

### 2.1 为什么需要空闲心跳
跨机状态视图若只在持租约时刷新，**一台空闲机器恰恰是最需要被观察的对象**（没活干的时候才去看它）。缺了它，机器一闲下来 RTT 就冻在最后一次任务的值上，并在窗口过后变成 `rtt_stale: true` —— **比"未知"更糟**，因为它看起来像"机器在，但很慢"。

推荐节奏：**每 60s 一次**（中继常量 `DEFAULT_IDLE_HEARTBEAT_MS`）。租约心跳仍是 10s，且只在有任务时发送。

### 2.2 ⚠️ 安全不变式：空闲心跳绝不允许触碰租约
空闲心跳的处理路径**不查询任何 task**，这是**结构性**保证而非"记得别写错"：

> 若空闲心跳能够续租，一台租约已 `expired` 的机器发一次空闲 ping 就会把 `expired` 洗回 `running`，**凭空制造出"任务仍在执行"的假象** —— 这是本中继能说出的最危险的谎言。

因此空闲心跳与任务账本完全解耦；`expired` 的归属权始终只属于 sweep/接管路径。此不变式有专门用例（`THE INVARIANT: an idle heartbeat never resurrects an expired lease`）。

### 2.3 为什么"缺 `task_id` 且无 `diagnostic`"必须报错
若把"缺 `task_id`"直接当作纯诊断心跳，那么一个**掉了 `task_id` 字段的 agent** 会静默地不再续租，却以为自己一切正常，最终导致**任务被误判 `expired`**。这与 §0「绝不静默降级」相冲突，故显式报 `400`。

### 2.4 `rtt_ms` 取值规则

| 字段 | 类型 | 语义 |
|---|---|---|
| `rtt_ms` | `number` | agent 测得的**到中继**的往返时间，单位毫秒。可选，两种模式都可用 |

**取值规则（中继侧实现，逐条有测试）**：

| 输入 | 行为 |
|---|---|
| 缺失 | 忽略；**保持上一次的值**；心跳照常成功 |
| 合法：有限数字且 `0 ≤ v ≤ 86400000` | 记录该值，并把 `rtt_at` 置为本次心跳时刻 |
| 非法：非 number / `NaN` / `±Infinity` / `< 0` / `> 86400000`(24h) | **忽略**，保持旧值；心跳**照常成功** |
| `null` | 视为非法（等同缺失）→ 保持旧值 |
| 任何未知字段（`future_field`、`rtt_ms_v2` …） | 完全忽略，不拒绝、不存入状态 |

**为什么非法值不报 `400`**：RTT 是诊断量。若非法值能拒绝心跳，一个有 bug 的 agent 就会因为"延迟上报写错"而**丢掉自己的租约**，任务被误判 `expired` —— 用一个诊断字段的 bug 制造一次虚假的任务失败，代价远大于收益。协议在"未知字段"上的宽容原则同样适用于"已知字段的坏值"。

> 注意这里的**有意不对称**：`phase`/`progress` 非法仍然报 `400`（它们是**控制**字段，会改变执行语义），而 `rtt_ms` 非法只忽略（它是**诊断**字段）。

**24h 上限的理由**：单个垃圾值（例如某 agent 把纳秒当毫秒）会污染 `/healthz` 的舰队聚合。上限取 24h 是因为任何物理上可能的 RTT 都远小于它。

**刻意不提供"清除"操作**：没有 `rtt_ms: null` → 清空的语义。值只会被**新的有效测量**覆盖；"这个数还可不可信"由 §7 的新鲜度字段表达，而不是靠清空。

### 2.5 空闲心跳的响应

```json
{ "lease_until": null, "cancel": false, "diagnostic": true, "machine_id": "3f2a…", "rtt_ms": 42.5 }
```

`lease_until: null` 与 `diagnostic: true` 是明确的"**本次没有续任何租约**"信号：客户端**不得**把它当成一次成功的续租。`cancel` 恒为 `false`（无任务可取消）。

---

## 3. 中继状态新增字段（设备维度）

`GET /v1/devices` 的**每个设备条目**追加：

| 字段 | 类型 | 语义 |
|---|---|---|
| `rtt_ms` | `number \| null` | 最近一次测得的往返时间。**`null` = 从未测到** |
| `rtt_at` | `RFC3339 \| null` | 该数值的**测量时刻**（不是最后一次心跳时刻） |
| `rtt_age_ms` | `int \| null` | `now - rtt_at`；无值时 `null` |
| `rtt_stale` | `bool` | 见 §7 |
| `last_heartbeat_at` | `RFC3339 \| null` | 本进程内最后一次收到该机心跳的时刻；重启后为 `null` |
| `reconnect_attempts` | `int` | **中继观测到**的重连次数 =（SSE 成功 attach 次数 − 1） |

> `reconnect_attempts` 是中继**自己数的**连接次数，不是 agent 上报的数字。理由是它必须在 agent 不配合时也成立；代价是**进程内计数**，重启归零（`relay_id` 变化会告诉读者这一点）。
>
> `last_heartbeat_at` 与 `rtt_at` 回答**两个不同问题**，不可合并：前者是"这台机器还活着吗"，后者是"这个延迟数字是什么时候量的"。

---

## 4. `GET /healthz` 新增 `rtt` 聚合

```json
"rtt": {
  "machines_reporting": 2,
  "min_ms": 12,
  "max_ms": 340,
  "avg_ms": 176,
  "machines_stale": 1,
  "machines_unknown": 3
}
```

| 字段 | 语义 |
|---|---|
| `machines_reporting` | **新鲜**（`rtt_stale === false`）测量的机器数 |
| `min_ms` / `max_ms` / `avg_ms` | 仅对**新鲜**测量取值；**无新鲜数据时一律 `null`，绝不是 `0`** |
| `machines_stale` | 有值但已过期的机器数（附加字段） |
| `machines_unknown` | 从未上报过的机器数（附加字段） |

`avg_ms` 保留 1 位小数。**陈旧值不计入聚合**：一台三天前就不在的机器不该继续拉偏舰队延迟。

---

## 5. 新端点 `GET /v1/agents/{machine_id}/status`

**鉴权**：`Authorization: Bearer <device_token>`（与其它设备端点一致；operator token 不适用于此端点）。

```json
{
  "protocol_version": 1,
  "rabbit_time": "2026-10-08T00:00:00Z",
  "machine_id": "3f2a…",
  "machine_name": "win-desktop",
  "relay_id": "6d3a46616f106399",
  "connected": true,
  "streams": 1,
  "online": true,
  "rtt_ms": 42.5,
  "rtt_at": "2026-10-08T00:00:00Z",
  "rtt_age_ms": 1200,
  "rtt_stale": false,
  "last_heartbeat_at": "2026-10-08T00:00:00Z",
  "last_seen_at": "2026-10-08T00:00:00Z",
  "reconnect_attempts": 2,
  "stream_connects": 3,
  "paired_at": "2026-10-07T10:00:00Z",
  "platform": { "os": "windows" },
  "caps": { "node": "v24.21.0" },
  "user_id": null,
  "now": "2026-10-08T00:00:01Z"
}
```

- `connected` = 当前是否有 SSE 流挂在这台机器上（`streams > 0`）。
- 未知 `machine_id` → `404 NOT_FOUND`；无 token → `401 UNAUTHORIZED`。
- 响应**不含任何凭据**（无 `device_token`）。

---

## 6. 重启语义（**裁定**）

**裁定：`rtt_ms` 不持久化；重启后为 `null`，不做"恢复 + stale 标记"。**

理由：

1. **`stale` 标记无法表达"跨进程"这件事**。`rtt_stale` 是按"测量时刻距今多久"算的，而重启后这个数字**同样无法验证** —— 恢复出来的 `rtt_at` 与真实值之间隔着一次进程死亡，谁也不知道那段时间里网络变成了什么样。给一个不可验证的时间戳打标记，只是把谎言包装得更精致。
2. **进程死亡与网络中断无法区分**。SIGKILL 之后中继没有机会记录"我要走了"。恢复出来的值既可能是 5 秒前的，也可能是 5 天前的，而中继**无法知道**是哪种。
3. **代价不对称**。丢失 RTT 的代价是"重启后几秒到几十秒内看不到延迟"（下一次心跳就恢复）；而谎报的代价是运维**根据错误数据做跨区域排障决策**。
4. **实现上不可能"意外说真话"**。`restore()` **显式**把 `rtt_ms`/`rtt_at`/`last_heartbeat_at` 置 `null`：即使将来有人往 `devices.json` 里写 RTT，重启也会丢弃它。

同一个理由适用于 `ledger`：账本重放**不**恢复 RTT。

---

## 7. 陈旧性：读者如何区分"真的这么慢"与"这台机器早就不在了"（**裁定**）

**`rtt_stale` 的定义**：

```
rtt_stale = (rtt_ms === null) 或 (now - rtt_at > rttStaleMs)
```

**默认 `rttStaleMs = 180000`（180s = 3 × 空闲心跳间隔）**。边界取"**严格大于**"：恰好等于窗口仍算新鲜。

### 7.1 为什么窗口必须是空闲心跳间隔的 3 倍，而不是 1 倍
（这是一个会导致功能悄悄失效的坑）

若窗口取 60s 而空闲心跳也是 60s，那么每次心跳**恰好**在窗口到期时到达：任何一点网络抖动都会让值在刷新前**瞬间翻成 stale**，下一次心跳又翻回 fresh。结果：

- `rtt_stale` 开始**抖动**，`rtt_stale === false` 于是不再是"可信"的可靠谓词 —— 读者要么误判，要么被迫自己加重试/去抖逻辑；
- 而这正是 §7 存在的理由（把判断压缩成一次比较）。抖动的布尔值比没有布尔值更坏，因为它看起来能用。

取 3 倍意味着**连续丢两次空闲心跳**仍不翻 stale，第三次才翻 —— 这与"陈旧"这个词的直觉一致，也让 `rtt_stale === false` 保持其核心性质。

**关键性质：`rtt_stale === false` 是一个可以无条件信任的谓词** —— 它保证"有一个值，且值是新鲜的"。因此读者的正确用法是：

```
只有当 rtt_stale === false 时，才把 rtt_ms 当作可信的延迟数字。
```

**四元组判读表**（`/v1/agents/{id}/status`）：

| 场景 | `rtt_ms` | `rtt_age_ms` | `rtt_stale` | `connected` | 读者应理解为 |
|---|---|---|---|---|---|
| 正常 | `42` | `1200` | `false` | `true` | **真的 42ms** |
| 真的慢 | `800` | `3000` | `false` | `true` | **真的 800ms** |
| 空闲但活着（有空闲心跳） | `42` | `45_000` | `false` | `false` | **真的 42ms**（无流但有心跳） |
| 机器早就不在了 | `42` | `600_000` | `true` | `false` | **历史值，别用** |
| 老客户端（v0.2.3） | `null` | `null` | `true` | `true` | 机器活着，但**延迟未知** |
| 从未测过 | `null` | `null` | `true` | `false` | 未知 |

### 7.2 两个正交信号，不要互相污染
- **`connected`** = **瞬时**链路状态（此刻是否有 SSE 流）：机器"现在是不是断的"用它，秒级准确。
- **`rtt_stale`** = **测量新鲜度**（那个数字还值不值得信）：分钟级。

`connected` **不参与** `rtt_stale` 的计算，这是刻意的：流断开 1 秒但 5 秒前刚心跳过的机器，其 RTT 依然新鲜有效；把连接状态混进新鲜度，会让一次瞬时抖动把好数据标成不可信。反过来，空闲机器 `connected: false` 但 `rtt_stale: false` 正是"没有流、但刚刚报过平安"的正确表达。

**为什么这足够**：区分"慢"和"不在"需要两个正交信息 —— ①**数值本身**（`rtt_ms`）②**数值的新鲜度**（`rtt_age_ms`/`rtt_stale`）。只看 `rtt_ms` 必然混淆这两者，而 `rtt_stale` 把②压缩成一个布尔，使读者的判断退化为**一次比较**，不需要自己拿 `rtt_at` 和当前时间做减法（那正是各客户端实现容易写错、且容易因时钟漂移出错的地方）。同时保留 `rtt_at`/`last_heartbeat_at` 原始时间戳，供需要精确诊断的读者使用。

**`connected` 不参与 `rtt_stale` 的计算**，这是刻意的：流断开 1 秒但 5 秒前刚心跳过的机器，其 RTT 依然新鲜有效；把连接状态混进新鲜度会让一个瞬时的网络抖动把好数据标成不可信。

---

## 8. 向后兼容矩阵

### 8.1 v0.2.3 客户端 → v0.3.0 中继：**完全可用，零改动**

| 交互 | 结果 |
|---|---|
| `POST /v1/pair` | 不变 |
| `GET /v1/stream` | 不变；`ready` 帧的 `relay_id` 是 v0.1.2 就有的追加字段 |
| `POST /v1/heartbeat`（**不带** `rtt_ms`） | `200`，租约照常续期；`last_heartbeat_at` 正常推进 |
| `POST /v1/heartbeat`（不带 `task_id`、不带 `diagnostic`） | **`400`** —— 老 agent 永远带着 `task_id`，因此不受影响；这是新增的显式拒绝分支 |
| 空闲心跳 | 老 agent **不会**发送；中继支持它纯属追加能力，对老客户端零影响 |
| `POST /v1/result` / `GET /v1/tasks*` | 不变 |
| `GET /v1/devices` | 响应**多了 6 个字段**；按"未知字段必须被忽略"约定，老客户端不受影响 |
| `GET /healthz` | 多了 `rtt` 对象；同上 |
| 该机的 RTT 视图 | `rtt_ms: null`、`rtt_stale: true` —— **正确表达了"未知"，而不是伪造一个 0** |

### 8.2 v0.3.0 客户端 → v0.2.3 中继：**agent 可用；插件必须优雅降级**

| 交互 | 结果 | 客户端要求 |
|---|---|---|
| `POST /v1/heartbeat` **带** `rtt_ms` | v0.2.3 中继只读取自己认识的字段 → `200`，`rtt_ms` 被忽略 | 无 |
| `POST /v1/heartbeat` **空闲模式**（`diagnostic: true`，无 `task_id`） | v0.2.3 中继走 `requireTask(undefined)` → **`404 NOT_FOUND`** | agent **必须容忍该 404**：空闲心跳是尽力而为的诊断流量，失败只记 debug 日志，**不得重试风暴、不得影响任务执行** |
| `GET /v1/agents/{id}/status` | **`404 NOT_FOUND`**（老中继没有该路由） | 插件**必须捕获 404** 并显示"中继版本过旧，无法提供跨机 RTT"，**不得崩溃、不得重试风暴** |
| `GET /healthz` 的 `rtt` | **字段不存在**（不是 `null`） | 插件必须把"字段缺失"与"值为 `null`"**同等**处理为"不可用"，**绝不能当成 0** |
| `GET /v1/devices` 条目的 `rtt_ms` | **字段不存在** | 同上，按 `null` 处理 |

> 结论：**新客户端连老中继的唯一要求是"把缺失字段当未知"**。这也是本节存在的意义 —— 兼容性矩阵必须写清降级方向，否则跨版本部署时插件会在一个 `undefined.toFixed()` 上崩掉。

---

## 9. 请求签名（HMAC）接入 HTTP 层（**裁定**）

> 线格式与密码学细节由 `src/signing.mjs` 定义并自带 33 条用例。本节定义**中继如何接线**：哪些端点校验、配置项、错误映射、以及迁移纪律。

### 9.1 配置项（中继）

| `createRelayServer` 选项 | 建议 CLI 参数 | 默认 | 语义 |
|---|---|---|---|
| `signingSecret` | `--signing-secret <s>` | 无 | 当前签名密钥。**未配置 = 完全不校验**，行为与 v0.2.3 逐字节一致 |
| `signingSecretPrevious` | `--signing-secret-previous <s>` | 无 | 轮换期间的旧密钥（仍被接受）。列表顺序 = `[当前, 旧]`，`keyIndex` 0/1 |
| `requireSignature` | `--require-signature` | `false` | **唯一的强制开关**。开启后未签名 = `401 SIGNATURE_REQUIRED` |
| `signatureSkewSeconds` | `--signature-skew <n>` | `120` | 允许的时钟偏移（秒），由 `signing.mjs` 的 `DEFAULT_SKEW_SECONDS` 定义 |

> `signingSecret` 若**存在但不是非空字符串**（例如数字、对象）→ 中继**构造时即报错**。绝不静默降级成"没配签名" —— 那正是 `signing.mjs` 开头点名要避免的失败模式。

### 9.2 端点覆盖（本版裁定）

| 端点 | 未配置密钥 | 配置了密钥（默认） | 配置了 + `--require-signature` |
|---|---|---|---|
| `GET /healthz` | 公开 | 公开 | **仍然公开**（永久豁免） |
| `POST /v1/pair` | 公开 | 公开 | **仍然公开**（永久豁免） |
| 写端点：`POST /v1/task`、`/v1/heartbeat`、`/v1/result` | 不校验 | **有签名则校验；未签名仍接受** | **必须签名** |
| 读端点：`GET /v1/devices`、`/v1/tasks`、`/v1/tasks/{id}`、`/v1/tasks/{id}/report`、`/v1/agents/{id}/status`、`/v1/stream` | 不校验 | **不校验**（签名头被忽略） | **必须签名** |

**两个永久豁免的理由**：
- `/healthz` 是运维探针（systemd / Docker healthcheck / 负载均衡 / uptime 监控）。要求它带凭据会把这些系统的密钥暴露面乘以它们的数量，而且是本版唯一能让**监控整体失联**的改动。
- `/v1/pair` 是**引导步骤**：此刻双方还没有共享密钥。要求签名等于要求在配对前分发签名密钥，会让 `signing.mjs` 那句"不需要额外分发密钥"的立论失效。

### 9.3 读端点裁定：默认不校验（与 lead 的倾向一致，理由如下）

**写端点默认校验；读端点默认不校验，只有 `--require-signature` 才校验。**

1. **未签名的读本来就被接受，所以"有签名才校验"是安全剧场。** 攻击者只需**不发送**那三个头就能降级——除非同时也拒绝未签名，否则校验不产生任何实际防护。
2. **读泄露的是拓扑，不是可执行能力。** `/v1/devices`、`/v1/tasks` 已经要求 `device_token`。签名要防的是**重放**与**中间盒篡改**；重放一次 GET 是无害的（幂等、返回同样的数据），篡改一个 GET 请求只能改 `limit` 这类由调用方自己控制的参数。
3. **代价不对称。** 写端点被伪造/重放会产生**状态变更**；读端点加校验只增加 CPU 与一种新的失败模式——而 `/v1/stream` 恰好是我们刚花两个任务修好的重连路径，不该再给它加新的失败方式。
4. **硬模式必须名副其实。** 名字叫 `--require-signature` 却在读端点上不要求，是对操作者的误导。开启它就要求**除两个引导端点外的全部 `/v1/*`**，规则单一、无需按方法记忆。

### 9.4 签名覆盖的"路径"是**路由后的路径**（⚠️ 客户端必读）

签名的 `path` 是**剥掉部署前缀之后的路由路径 + 查询串**，**不是**原始 URL。

```
客户端对 https://host/w2m/v1/result 发起请求时，签名的 path 是： /v1/result
```

理由：v0.1.2 §3 的三种部署形态下，同一个客户端必须产生**同一个**签名 —— 反代可能把 `/w2m/v1/result` 原样透传，也可能剥成 `/v1/result`。**路由后的路径是双方在三种形态下唯一都能达成一致的值**。若签原始 URL 路径，则"加一层反代"就会让全部签名失效，而人们遇到这种情况的做法通常是关掉签名。

**因此：客户端永远签 `/v1/result`，而不是 `https://host/w2m/v1/result`。** 中继**只接受**路由路径一种形式（不接受两种），因为"两者都收"会让同一个签名在两个不同端点上有效，削弱绑定；而且一旦接受两种形式，就**没有任何用例能证明客户端签对了**——错的也会通过。

### 9.4.1 确定性测试向量（**双方必须逐字节一致**）

> 用途：发送方与验证方各自算一遍再比对，比任何单边自证都强。这两条向量**已被 `test/relay.test.mjs` 的 `signing test vectors (§9.4.1)` 用例钉死**：canonical string、签名值、以及"真实中继接受该签名"三步。任何一侧改算法都会立刻变红。
> 密钥：`test-secret-abc`（**仅供测试向量使用，切勿用于任何真实部署**）

**向量 1 —— `POST /v1/heartbeat`**

| 输入 | 值 |
|---|---|
| `method` | `POST` |
| `path` | `/v1/heartbeat` |
| `timestamp` | `1780000000` |
| `nonce` | `abcdef0123456789` |
| `body` | `{"task_id":"T1","machine_id":"m1"}` |

```
canonical string（6 段，以 \n 连接）:
v1
POST
/v1/heartbeat
1780000000
abcdef0123456789
c132705f2342284320b7e59ef2f32f9d580f6ecf1b83116ae22b71ad6fa09d28

X-W2M-Timestamp: 1780000000
X-W2M-Nonce:     abcdef0123456789
X-W2M-Signature: v1=a8de86289154861c7289b87e3bb4f39121c5ca0f59d50f819285efe3265778db
```

**向量 2 —— `GET /v1/stream`（含 query）**

| 输入 | 值 |
|---|---|
| `method` | `GET` |
| `path` | `/v1/stream?machine_id=m1&seq=4` |
| `timestamp` | `1780000001` |
| `nonce` | `0123456789abcdef` |
| `body` | *(空)* |

```
canonical string:
v1
GET
/v1/stream?machine_id=m1&seq=4
1780000001
0123456789abcdef
b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad

X-W2M-Signature: v1=a9c899e05b70be0c4fce37ef7cbedacd8bdf36984faeafc8499f13a135776ce6
```

> 第 6 段是 **body 的 HMAC-SHA256（以空密钥）十六进制**，不是 body 本身。空 body 时它是 `b613679a…c5ad`（即 `HMAC-SHA256(key="", msg="")`）。

**前缀敏感性对照**（相同输入与密钥，仅 `path` 不同）——必须不同，这就是"签错 path 必然验不过"的可验证证据：

| path | signature |
|---|---|
| `/v1/heartbeat` | `v1=a8de86289154861c7289b87e3bb4f39121c5ca0f59d50f819285efe3265778db` |
| `/w2m/v1/heartbeat` | `v1=20c0f143fd27a61c86d876fdd802d143645d5238a301b7d91269205e37a6300d` |

**复算方式**（两侧都应能独立复现）：

```js
import { canonicalString, signRequest } from './src/signing.mjs';
const input = { method: 'POST', path: '/v1/heartbeat', timestamp: 1780000000,
                nonce: 'abcdef0123456789', body: '{"task_id":"T1","machine_id":"m1"}' };
canonicalString(input);                      // 应与上面的 6 行逐字节相同
signRequest({ secret: 'test-secret-abc', ...input }); // v1=a8de86…
```

### 9.5 错误码 → HTTP 状态映射

| `verifyRequest` code | HTTP | `error.detail` | 说明 |
|---|---|---|---|
| `SIGNATURE_REQUIRED` | **401** | `code`/`reason`/`hint` | 开了强制但请求未签名 |
| `SIGNATURE_INCOMPLETE` | **401** | 同上 | 三个头只带了一部分（半个签名永远是坏代理或探测，**不**降级为"未签名"） |
| `SIGNATURE_MISMATCH` | **401** | 同上 | 与所有已配置密钥都不匹配（含密钥轮换没跟上） |
| `SIGNATURE_BAD_TIMESTAMP` | **401** | 同上 | `X-W2M-Timestamp` 不是数字 |
| `SIGNATURE_BAD_NONCE` | **401** | 同上 | nonce 短于 8 字符 |
| `SIGNATURE_EXPIRED` | **401** | 同上 | 时间戳超出 ±120s 窗口 → hint 指向**发送方时钟** |
| `SIGNATURE_REPLAY` | **401** | 同上 | nonce 已用过 → hint 指向**每次请求换 nonce** |
| `SIGNING_NOT_CONFIGURED` | **500** | 同上 | ⚠️ **中继自己配错了**：开了 `--require-signature` 却没有密钥 |

**为什么 `SIGNING_NOT_CONFIGURED` 必须是 5xx 而不是 401**：那是**中继的配置错误**。报成 401 会让每一个操作者去排查客户端 —— **唯一没有坏的那一侧**。选 **500 而非 503**：503 意味着"稍后重试"，而重试永远修不好一个缺失的配置，不应诱导任何重试循环。启动横幅与 `/healthz.signing` 都会同时暴露这个矛盾。

### 9.6 `/healthz` 新增 `signing`

```json
"signing": { "configured": true, "required": true, "previous_secret_accepted": true, "skew_seconds": 120 }
```

**绝不暴露密钥本身，连前缀都不行**（有用例对原始响应文本做 `includes(secret)` 与 `includes(secret.slice(0,8))` 断言）。

### 9.7 迁移纪律（三步，每步都有用例）

| 步骤 | 配置 | 效果 |
|---|---|---|
| 0. 现状 | 无 | 不校验，v0.2.3 客户端零影响（**硬门禁**） |
| 1. 灰度 | `--signing-secret S` | 校验**存在**的签名，未签名仍放行 → 可以安全地逐台升级 agent；不匹配的签名**已经会 401**，所以能提前发现密钥分发错误 |
| 2. 收紧 | 再 `--require-signature` | 未签名 = 401。此时舰队应已全部会签名 |

轮换：`--signing-secret NEW --signing-secret-previous OLD` → 两者都接受；`keyIndex`（0=新，1=旧）可用来判断哪台机器还没拿到新密钥；确认全部切换后再去掉 `--signing-secret-previous`。

### 9.8 兼容矩阵（签名部分）

| 场景 | 结果 |
|---|---|
| v0.2.3 agent（不签名）→ v0.3.0 中继（未配置密钥） | 完全一致 |
| v0.2.3 agent（不签名）→ v0.3.0 中继（配置了密钥、未强制） | **照常工作**（步骤 1 的存在意义） |
| v0.2.3 agent（不签名）→ v0.3.0 中继（强制） | `401 SIGNATURE_REQUIRED` —— **这是操作者显式选择的结果**，不是意外 |
| v0.3.0 agent（签名）→ v0.2.3 中继 | 三个签名头是**未知请求头**，老中继忽略 → 照常工作 |
| 中继开了强制但忘配密钥 | `500 SIGNING_NOT_CONFIGURED`（不是 401） |

---

## 10. 不当错误码

本版的 `rtt_ms` 非法**不产生任何错误**（§2）。签名相关的新错误码见 §9.5，全部复用 §7 的错误体形状。

---

## 11. 本版不做

- ❌ **不做 RTT 历史/时序**（只保留最近一次测量；跨区域排障要看趋势时再单开一版）
- ❌ **不做 RTT 的持久化或账本重放**（§6）
- ❌ **不做按 RTT 的调度/选机**：本版只做"可见"，不做"据此决策"
- ❌ **不做空闲心跳的频率协商**：60s 是协议推荐值，中继不校验、不限流；一台机器发得太频只会浪费它自己的带宽
- ❌ **不做请求体加密 / 端到端加密**：签名证明"谁发的、有没有被改"，**不隐藏内容**。隐藏由 TLS 或 WireGuard 负责（v0.1.2 §1）
- ❌ **不做非对称签名**：见 `signing.mjs` 开头"为什么用共享密钥"——复用配对时已下发的 `device_token` 派生，零额外密钥分发
- ❌ **不做签名的时间戳缓存/时钟同步**：窗口固定 ±120s，超出即 401 并提示查时钟

> ✅ **已做**（原计划不做，后因用户缺陷范围而纳入）：**空闲心跳**。理由见 §2.1 —— 跨机视图若在机器空闲时冻结，就等于在最需要它的时刻失效。
