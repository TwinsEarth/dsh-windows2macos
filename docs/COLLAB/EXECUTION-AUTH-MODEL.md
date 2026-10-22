# 执行授权模型（Execution Authorization Model）设计规格 — v1.4.0-beta

> 状态：**已实现（v1.3.12-beta.1）**。把 M1（运维通道）与 M2（任务级 grant）归纳成一个可复用的授权模型，并冻结线协议与失败语义。
> 版本：`1.4.0-beta.*`；实现按 M1（1.3.2）/ M2（1.3.3）分步交付，模型一致性验收在 1.4.0-beta 完成。
> 相关：`docs/COLLAB/M1-MAINTENANCE.md`、`docs/COLLAB/M2-TASK-GRANT.md`。

---

## 1. 问题陈述

现状只有一个执行授权来源：**机器本地静态 allow-list**。它带来三个无法回避的后果：

1. **远程运维不可能**：升级/重启/排障命令不在清单里，只能 SSH；清单空白的机器（TwinsEarth 实测）连 `node --version` 都拒绝，编队里"在线但不可用"。
2. **放宽清单是唯一出路，且不安全**：为了升级一次就把安装命令永久写进清单，等于给任何能调度任务的人一个长期入口。
3. **没有"谁授权了什么"的记录**：allow-list 是配置文件，不是事件；无法回答"这条命令是谁、在何时、为什么被允许"。

模型目标：引入**显式的、可审计的、带时限的执行授权**，与 allow-list 并存，且不改变"只执行 argv、不执行 shell 字符串"的红线。

---

## 2. 模型总览

```
                 ┌────────────── 签发（控制面，操作员私钥）──────────────┐
                 │  grant / maintenance request（签名能力令牌）          │
                 └──────────────────────────┬──────────────────────────┘
                                            │ relay 传输（不解释内容）
                                            ▼
   目标机 ┌────────────────── 授权判定 authorize(action, context) ──────────────────┐
          │ 1. 硬红线检查（永远拒绝）                                            │
          │ 2. 能力校验：签名/主体/范围/时限/次数/重放/撤销                        │
          │ 3. 与 allow-list 组合：显式授权优先；无授权则看清单；都不中则拒绝      │
          └──────────────────────────────┬───────────────────────────────────────┘
                                         ▼
                          执行面（二选一，权限不同）
                          A. agent 用户执行（argv）
                          B. root runner 执行（固定 action：update/restart/diag）
```

核心概念：

| 概念 | 含义 |
|---|---|
| **Authority** | 操作员密钥（Ed25519），签名的唯一来源 |
| **Capability** | 签名令牌，表达"允许在哪些机器、执行什么、多久、几次" |
| **Subject** | 目标机器（machine_ids）/ 项目（后续 M3 的合并授权） |
| **Scope** | argv_hash + 执行约束（mode/cwd/write/timeout/env 白名单） |
| **Bounds** | TTL、max_uses、task 绑定、nonce、撤销 |
| **Decision** | 允许 / 拒绝（带统一错误码），拒绝默认、无副作用 |
| **Provenance** | 每次允许都记录来源：`allow-list` / `grant` / `maintenance`，进 ledger |

---

## 3. 能力类型（本版本冻结两种）

### 3.1 能力 A：执行授权（grant）——agent 用户权限

- 主体：`machine_ids[]`
- 范围：`argv_hash`（sha256 of canonical argv）+ 可收紧的 `mode/cwd_rel/write/write_scope/timeout_ms`
- 边界：TTL ≤ 10 分钟、`max_uses`（按机器计）、可绑 `task_id`
- 执行者：agent（w2m 等非特权用户）
- 典型：空 allow-list 机器上执行 `node -e ...`、`npm --version`、诊断脚本

### 3.2 能力 B：维护请求（maintenance）——root/SYSTEM 权限

- 主体：`machine_id`（单机）
- 范围：固定 action 枚举 `update | restart | diag` 及其**白名单参数**（版本、sha256、URL 列表、目标单元）
- 边界：TTL ≤ 10 分钟、单次
- 执行者：root runner（独立单元，固定实现，解释 JSON 但不执行 shell）
- 典型：远程升级插件/relay、重启服务、收集诊断

> 两种能力共用同一签名载荷/规范化/密钥，但**权限不同、执行者不同、参数白名单不同**。这是模型的核心分离：让"跑一条命令"和"做一次系统维护"不共用危险通道。

### 3.3 未来能力（不在本版本）

- 项目级能力（合并队列的 merge-slot 授权）——由 M3 定义，沿用本模型（主体=project+branch，范围=merge 操作）。
- 角色委托（owner 签发子 key 给 maintainer）——v1.4.x 后续。

---

## 4. 授权判定函数（冻结语义）

```
authorize(input) -> { allow: boolean, provenance, code?, detail? }

input = {
  capability?: SignedCapability,     // grant 或 maintenance，可能缺失
  action: { kind: "exec"|"maintenance", argv?, constraints?, maintenance? },
  context: { machine_id, task_id?, attempt, now, policy: { allow_list, red_lines, limits } },
  state: { used_count, nonce_seen, revoked_set, pinned_operator_keys }
}
```

判定顺序（每一步失败都返回对应错误码，不执行、不落副作用）：

```
1. 硬红线（任何来源都不能越过）
   1.1 仅 argv 数组；禁止 shell 字符串/命令拼接
   1.2 cwd 必须落在允许根内（项目目录/工作区），无路径穿越
   1.3 禁止提权（agent 通道不能要求 root；maintenance 只走固定 action）
   1.4 写入必须落在 write_scope 内；只读任务不得写
   1.5 输出/超时/CPU/内存上限由机器策略决定，能力只能收紧
   → 违规：RED_LINE_VIOLATION

2. 有能力（capability 存在）
   2.1 形状/大小/协议版本
   2.2 验签（pinned operator key；未知 key_id → UNKNOWN_AUTHORITY）
   2.3 主体匹配（machine_ids 含本机；maintenance 的 machine_id 必须相等）
   2.4 范围匹配（argv_hash/参数逐项一致；约束不得比机器策略更宽）
   2.5 时限与次数（issued_at ≤ now ≤ expires_at，TTL 上限；used_count < max_uses；task 绑定）
   2.6 重放（nonce + capability_id 本地持久化）
   2.7 撤销（relay 撤销集缓存窗口内命中）
   → 通过：allow，provenance = "grant" | "maintenance"

3. 无能力
   3.1 allow-list 命中 → allow，provenance = "allow-list"
   3.2 否则 → deny，code = NOT_AUTHORIZED（对 grant 场景为 GRANT_MISSING）

4. 记录
   4.1 allow：ledger 记 provenance + capability_id + argv_hash + 结果
   4.2 deny：ledger 记 code + 摘要（不记全量 argv 敏感内容，按红action策略脱敏）
```

组合与优先级：

- **拒绝优先**：任一步拒绝即拒绝；能力不能覆盖硬红线。
- **能力优先于清单**（用于审计显式性），但结果相同；两者都允许时记录 `grant`（显式授权），并标记 `also_in_allow_list: true`。
- **清单是"常驻授权"**：其 provenance = `local-config`，不在 ledger 伪造操作员签名；模型上把 allow-list 视为"由机器 owner 预签发的长期能力"，便于统一解释。

---

## 5. 信任建立与密钥生命周期

### 5.1 操作员密钥

- 独立 Ed25519，与 operator token（调度凭据）**分离**：token 泄露不等于授权能力泄露，反之亦然。
- 私钥存放在控制端（DSH 配置/OS keychain）；不进入 relay、不进入 agent。
- 公钥登记：控制端用 operator token 证明持有权 → relay 记录 `{key_id, public_key, created_at}`（ledger 事件）。

### 5.2 目标机信任（agent / root runner）

```
首选（推荐，M1/M2 终态）：pairing-time pinning
  pairing 响应携带 operator 公钥 → 机器在配对时固定（操作员在场，这是可信锚点）
轮换：新公钥必须由旧 pinned key 签名（rotation chain），agent 验链后更新
撤销：操作员登记 revoke；agent 同步后拒绝旧 key

beta 过渡（1.3.2/1.3.3 实现期）：TOFU
  首次验签时向 relay 拉取公钥并固定；文档明确"首次可被攻破的 relay 注入"
  后续版本改为 pairing-time pinning 为默认，TOFU 仅作显式 fallback
```

**已知限制（必须写进发布说明）**：TOFU 窗口内，被攻破的 relay 可注入伪造公钥。缓解：短 TTL、审计告警、尽快升级到 pinned 模式。

### 5.3 撤销

- relay 维护撤销集（capability_id、key_id）；ledger 记录 `capability.revoked`。
- agent 缓存 30s；在 TTL 内撤销也生效（最多 30s 延迟）。
- 语义声明：撤销**不会**中断正在执行的动作，只阻止新的执行。

---

## 6. 威胁模型（模型级）

| 威胁 | 能否得逞 | 依据/处置 |
|---|---|---|
| 恶意编队成员伪造指令 | ❌ | 无操作员私钥，签名不可伪造 |
| 被攻破的 relay 伪造授权 | ⚠️ TOFU 窗口内可注入公钥（文档声明）；pinned 后不可 | 尽快 pinning；短 TTL；审计 |
| 被攻破的 relay 扣留/延迟指令 | ✅（可用性） | 授权不影响正确性；重试/审计可发现 |
| 被攻破的 agent | ❌ 提权 | agent 只能以自身用户执行；root 动作只走固定 maintenance action |
| 重放旧授权 | ❌ | nonce + capability_id 持久化 + task 绑定 + TTL |
| 改 argv 绕范围 | ❌ | argv_hash 校验 |
| 越界写文件 | ❌ | 硬红线 cwd/write_scope |
| 时钟回拨延长 TTL | ⚠️ | 服务端时间权威（relay）；本地只做窗口判断；偏差容忍 ±60s |
| 操作员误授权 | ⚠️ | 展示完整 argv、TTL ≤10min、max_uses、撤销；高风险动作需二次确认 |

---

## 7. 兼容与迁移

- **旧 relay**：忽略 grant/maintenance 字段 → 行为退回 allow-list；控制端检测后返回 `UNSUPPORTED_RELAY`。
- **旧 agent**：不认识字段 → allow-list 判定（维持 v1.3.1 行为），relay 可探测版本并提示 `UNSUPPORTED_AGENT`。
- **旧 allow-list**：模型上保留为常驻授权，行为不变；不需要迁移配置。
- **新安装**：默认仍是"空 allow-list + 无 pinned key"，但配对时可选择 pin 操作员公钥（推荐）；空清单机器不再"不可用"——只要操作员签一次能力即可。

---

## 8. 验收（模型一致性，横跨 M1/M2）

### 正向（真实任务证据）

1. **空 allow-list + grant**：TwinsEarth 执行 `node -e "console.log(...)"`；ledger provenance=`grant`，记录 capability_id/argv_hash。
2. **空 allow-list + maintenance**：同机完成 `update`/`restart`/`diag`；provenance=`maintenance`，root runner 日志与 ledger 一致。
3. **普通 allow-list 命令**：provenance=`allow-list`，行为与 1.3.1 identical（对账对照）。
4. **撤销窗口**：签发→撤销→派发（≤30s 内）被拒；超过缓存窗口同样被拒。
5. **轮换链**：旧 key 签新 key → agent 更新 pinned；未签的换 key 被拒。

### 负向（模型矩阵，自动化）

```
硬红线：shell 字符串/路径穿越/提权/越界写 → RED_LINE_VIOLATION
能力：缺签/错签/未知 key/过期/未来/换机/换 argv/重放/超次数/撤销/任务绑定不符 →
      NOT_AUTHORIZED / UNKNOWN_AUTHORITY / GRANT_* / MAINTENANCE_*
审计：拒绝不产生执行副作用；ledger 有 deny 记录
组合：能力拒绝时不回落 allow-list（防歧义）；allow-list 命中但能力被篡改 → 拒绝（显式意图无效）
时钟：±61s 边界、issued_at 在未来、expires_at 恰好过期
```

### 审计查询

- 给定 task_id → 能力来源、key_id、argv_hash、结果。
- 给定机器 → 当前 pinned key、最近能力使用、拒绝计数。
- 给定时间窗 → 所有 maintenance 动作与 grant 使用（导出 JSON）。

---

## 9. 与三个模型的关系

| 模型 | 版本 | 依赖 | 说明 |
|---|---|---|---|
| 执行授权模型（本文） | v1.4.0-beta | 独立 | 定义"能否执行"；M1/M2 是其两种实现 |
| 任务模型 | v1.4.1-beta | 本模型（合并/审查任务需授权） | 定义"执行什么、产出什么（worktree/patch/merge）" |
| 协作模型 | v1.4.2-beta | 本模型 + 任务模型 | 定义"谁和谁、在哪个项目/房间协作" |

---

## 10. 交付物与版本映射

```
模型文档：docs/COLLAB/EXECUTION-AUTH-MODEL.md（本文）
实现拆分：
  1.3.2-beta  M1 运维通道（能力 B：固定 action + root runner）
  1.3.3-beta  M2 任务级 grant（能力 A：argv 授权 + agent 验签）
  1.4.0-beta  模型一致性验收：统一错误码/审计查询/轮换链/撤销窗口/真实任务证据
              （不新增功能；把 M1/M2 的行为对齐到本模型）
共享模块：
  src/auth/operator-key.mjs     密钥生成/登记/轮换链/pin/撤销
  src/auth/capability.mjs       两种能力的统一载荷、规范化、签发、验证
  src/auth/authorize.mjs        判定函数（纯函数，输入输出可单测）
  src/auth/audit.mjs            审计查询（ledger 上的投影）
```

## 11. 开放问题（实现前确认）

1. **pinned vs TOFU 的默认**：1.3.2/1.3.3 实现期是否直接做 pairing-time pinning（更安全，改动稍大）？
2. **操作员密钥创建 UX**：`dsh` 命令生成并写入 OS keychain，还是插件面板生成？
3. **能力签发 UX**：一次一条命令（简单）还是"策略模板"（如"升级到某版本"一键签一组）？
4. **谁可以签**：仅 owner 操作员，还是允许 maintainer 使用预设策略？
5. **max TTL**：10 分钟是否合适（运维场景可能更长）？
6. **审计可见性**：ledger 里的 argv 是否永久保存明文（敏感参数）还是只存 hash + 前缀？

---

## 签发（v1.3.12-beta.1）

执行授权模型之前只有静态 allow-list：机器所有者写下一个长期决定，任何不在表里的命令都没有"就这一次"的途径。现在补上
了操作员显式授权某一次执行的完整路径。

### 1. 生成操作员密钥

操作员持有 Ed25519 私钥；机器的 allow-list 保持不动（默认拒绝）。

### 2. 先取 task_id，再签发 grant

grant 绑定 **一个 task、一个 argv、若干 machine_id、一个短 TTL（≤10 分钟）和 max_uses（默认 1）**。所以签发之前 task_id
必须已经确定（调度方生成后传给 `POST /v1/task` 的 `task_id` 字段）。

```bash
node bin/w2m-grant.mjs \
  --key ~/.w2m/operator.pem \
  --task-id 01M5GRANTCLI0000000000000001 \
  --machines 6c92b251-3728-48bc-82a9-56cc40df48f2 \
  --argv '["node","--version"]' \
  --ttl-ms 120000 > /tmp/grant.json
```

stdout 是 grant JSON；stderr 打印 `task_id / argv_hash / machines / expires_at` 供核对，便于管道使用。

### 3. 派发时携带 grant

```json
POST /v1/task
{
  "task_id": "01M5GRANTCLI0000000000000001",
  "mode": "replicate",
  "command_argv": ["node", "--version"],
  "cwd_rel": ".",
  "index_total": 1,
  "timeout_ms": 60000,
  "write": false,
  "grant": { ... /tmp/grant.json 内容 ... }
}
```

### 4. 两处检查，各管一件事

- **relay（派发预检）**：grant 的 `task_id` 必须与本次派发的 task 一致（`GRANT_TASK_MISMATCH`），`argv_hash` 必须与
  `command_argv` 一致（`GRANT_ARGV_MISMATCH`），`expires_at` 未过期（`GRANT_EXPIRED`）。这些是调用方错误（HTTP 400），
  不是授权裁决。
- **agent（真正的验证者）**：用机器上 pin 的操作员公钥验证签名、检查任务绑定/机器绑定/argv/有效期/max_uses，并把用过的
  grant 记入本地 ledger（重放拒绝为 `GRANT_REPLAY`）。空 allow-list + 合法 grant 会执行；同 argv 无 grant 仍
  `COMMAND_NOT_ALLOWED`。

### 5. 审计字段

task summary 与 ledger 现在携带 `grant_id`、`argv_hash`、`grant_key_id`；项目事件里投影 `task.linked`，回答"这条命令是谁
授权、什么时候、在哪些机器上"。

### 6. 边界（仍不做的）

- 不做长期委托/子授权：一次 grant 只覆盖一次执行。
- 不做自动签发：操作员必须显式运行签发命令或调用等价 API。
- 不做跨项目授权：grant 绑定机器与 argv，与项目无关。

## 撤销与审计（v1.3.12-beta.2）

撤销解决"签发之后才发现不该授权"的问题，不需要动已经发出的 grant 内容（它可能已在操作员本机或任务体里）。

- **撤销一条**：`POST /v1/grants/revoke`，operator token，body `{grant_id, reason?}`。幂等：第二次撤销返回
  `already_revoked: true`，不报错。撤销写入 relay ledger（`grant.revoked`，含 reason 与操作者）。
- **派发预检**：携带已撤销 grant 的任务在 `POST /v1/task` 阶段被拒：`403 GRANT_REVOKED`。机器不会收到 offer。
- **审计视图**：`GET /v1/grants`，operator token。返回 `tasks`（所有携带过 grant 的任务：task_id / grant_id / argv_hash /
  key_id / mode / created_at）与 `revoked`（撤销记录）。只有 operator token 能读；device token 得到 401，因为这是授权台账，
  不是机器的工作面。
- **agent 侧边界**：agent 无法联系 relay 时仍按本地 ledger 执行已到手的 grant（正确性依赖 relay 派发，见 §4）；撤销的作用
  是阻止**新派发**，与"停止签发"同义。

撤销之后的新授权需要重新签发（新的 grant_id，绑定同一 task 或新 task）。

## 授权来源（v1.3.12-beta.3）

前两版解决了"能不能授权"和"能不能收回"；这一版让结果自己回答"是谁授权的"。每个任务结果信封多一个字段：

```json
{
  "authorization": {
    "provenance": "grant | allow-list | maintenance",
    "capability_id": "gr-…（grant 时）| maintenance request_id（maintenance 时）",
    "grant_id": "gr-…（grant 时）"
  }
}
```

- **allow-list**：机器所有者的长期决定，机器执行时命中静态表。
- **grant**：操作员针对这一次执行的显式授权；附带 grant_id，可与 relay ledger 的 `grant.revoked` / 任务记录对账。
- **maintenance**：签名维护请求；capability_id 是 request_id，对应 M1 的请求台账。

边界要写清楚：**provenance 是执行机器对自身判定的事实陈述，relay 只存储不验证**（signature 由 agent 验、派发由 relay 预检、撤销由
relay 记账）。回答"这到底是谁允许的"仍以 relay ledger 为准；provenance 让每个结果可被机器与人快速定位到那条授权，而不是替代台账。

## 使用台账不可写（v1.3.12-beta.4）

真机发现：维护状态目录 `/var/lib/w2m/maintenance` 由 root 拥有且 0755，agent 以非特权用户运行；grant 第一次通过后写使用台账
失败（EACCES），异常冒泡成任务 crashed —— 表现是"授权了但一执行就崩"。这不是授权判定错误，是记录失败。

处理（fail closed）：

- `grant-gate` 把台账写入包在 try/catch 里，失败返回 `GRANT_LEDGER_UNAVAILABLE`，不执行未记录的一次授权（否则单次授权会
  变成可重放的漏洞），也不再把整个 handler 打崩。
- `bootstrap.sh` 把 `$BASE` 设为 `root:w2m 0775`（agent 需要在这里写 grant-uses.json）；queue 仍为 0770、done/claimed 0750。
- 回归用例：把 usedFile 指到不可写路径，断言返回该 code 而非抛异常。
