# M2 任务级签名授权（grant）设计规格

> 状态：**设计稿**。只定义协议、边界、失败语义与验收，不含实现。
> 版本：`1.3.3-beta.*`（GitHub prerelease，不入 npm）。
> 上游：`docs/MULTI-MACHINE-COLLABORATION-PLAN.md` M2；与 `docs/COLLAB/M1-MAINTENANCE.md` 共用签名/规范化模块。

---

## 1. 目标与非目标

### 目标

1. **单次授权**：操作员对"某台机器上执行某条具体 argv"签一次名，agent 验签后放行一次；无需把该命令写进永久 allow-list。
2. **可审计**：每次使用 grant 的任务在 relay ledger 中留下 `grant_id / argv_hash / machine / 结果`，能回答"这条命令是谁授权的、什么时候、在哪些机器上"。
3. **可撤销**：停止签发新 grant；对被撤销的 grant_id，agent 从 relay 的撤销集拒绝执行（在 TTL 窗口内也拒绝）。
4. **与 allow-list 共存**：allow-list 仍是默认路径（只读/常规命令）；grant 是**显式例外通道**，不是替代品。
5. **不放宽红线**：仍然只接受 argv 数组（不接受 shell 字符串）、仍受 cwd 限制、超时、输出上限、写范围约束。

### 非目标（本版本不做）

- 不做"任意命令的长期通行证"（grant 必须绑定 argv_hash + TTL + 机器集合）。
- 不做交互式会话（不是 SSH 替代品）。
- 不做提权（agent 仍以自身用户执行；root 动作只走 M1 的固定 action）。
- 不做"操作员密钥硬件保护"（HSM/智能卡属后续）。

---

## 2. 授权分层（本版本落地 L2，L1 沿用）

```
L0  allow-list（机器本地静态配置，v1.3.1 已有）
L1  签名维护请求（M1：固定 action，root 单元执行；不走 allow-list）
L2  任务级 grant（本版本：任意 argv 的单次授权；agent 侧验签）
```

判定顺序（agent 收到 offer 时）：

```
1. 任务是否带 grant？
2. 有 grant → 验证（见 §5）→ 通过则**跳过 allow-list**，进入执行前检查（cwd/写范围/超时）
   拒绝则按 grant 错误码返回；不回落 allow-list（防止"签错名但恰好命令在清单里"的歧义）
3. 无 grant → 走 allow-list（行为与 v1.3.1 完全相同）
```

边界规则：

| 场景 | 结果 |
|---|---|
| allow-list 命中的普通命令 | 照旧执行，ledger 记录 `auth: "allow-list"` |
| grant 命中的命令（即使也在 allow-list 里） | 执行，ledger 记录 `auth: "grant"` + grant_id（审计优先显示显式授权） |
| 两者都不命中 | `COMMAND_NOT_ALLOWED`（与现在一致） |
| grant 无效 | 对应 `GRANT_*` 错误码，不执行 |

---

## 3. Grant 对象（签名载荷）

UTF-8 JSON，**≤ 8 KiB**，字段如下（签名覆盖除 `signature` 外全部）：

```json
{
  "protocol": "w2m-grant/v1",
  "grant_id": "01M6...26 字符 ULID",
  "task_id": "被授权任务的 id（可空；非空时必须与 offer 的 task_id 相等）",
  "machine_ids": ["1c14d7d2-…", "6c92b251-…"],
  "argv_hash": "sha256(canonical argv 数组)",
  "argv_head": ["node", "-e", "console.log('hi')"],
  "max_uses": 1,
  "issued_at": "2026-10-21T13:00:00Z",
  "expires_at": "2026-10-21T13:10:00Z",
  "nonce": "16–64 字符随机串",
  "issued_by": "operator 名（仅审计）",
  "signature": { "alg": "ed25519", "key_id": "operator 公钥指纹前 16 hex", "value_base64": "…" }
}
```

规范化：键按字典序、无空白、UTF-8；`argv_hash = sha256(JSON.stringify(argv))`，argv 为字符串数组原样（不做 shell 解析、不做路径展开）。

### 3.1 约束字段（同一 grant 内可再收紧执行面）

```json
"mode": "replicate|broadcast",        // 可选；与 task 不一致则拒绝
"cwd_rel": ".",                        // 可选；与 task 不一致则拒绝
"write": false,                        // 可选；grant 不能把 write 从 false 放宽到 true
"write_scope": ["src/"]                // 可选；只能收窄，不能扩大机器配置
```

原则：**grant 只能收紧，不能放大机器自身的执行约束**（写范围、cwd、超时、输出上限都由机器说了算；grant 只能进一步限制）。

---

## 4. Grant 的签发与下发

### 4.1 签发（控制端插件内）

- 操作员密钥：独立 Ed25519（与 M1 共用同一 operator key；**不复用** operator token 明文）。
- 输入：argv、目标 machine_ids、TTL（≤10 分钟）、可选 task_id/max_uses。
- 输出：grant JSON + 签名；控制端把 grant 随任务派发（POST /v1/task 的 `grant` 字段）。
- 操作员看到的是**展开的 argv 列表**（`argv_head`），签名覆盖 hash；UI/CLI 必须展示完整 argv 后才允许签名（防止"签 hash 但不知道内容"）。

### 4.2 relay 行为

1. POST /v1/task 接收 `grant`（≤8 KiB）：
   - 校验形状与协议版本（不验签，验签权威在 agent）；
   - 拒绝 `machine_ids` 之外的 lease（只给列出的机器 offer）；
   - 校验 `expires_at` 未过期（早拒）；过期拒绝 `GRANT_EXPIRED`。
2. ledger 写 `task.created` 时附 `grant: {grant_id, argv_hash, key_id, max_uses, expires_at}`（**不存完整签名**，避免膨胀；完整 grant 随 offer 下发）。
3. offer 携带 `grant`；agent 验签。
4. GET task 的机器结果里暴露 `grant_status`（verified/refused + 错误码）供审计。
5. 撤销集：relay 内存 + ledger 记录 `grant.revoked` 事件；GET /v1/fleet/grants/revoked 供 agent 拉取（缓存 30s）。

### 4.3 agent 验签与使用

```
1. 形状/大小/协议版本
2. 找 operator 公钥：本地 pinned key（优先）→ relay 下发（TOFU，见 §6）
3. 验签（canonical 重构）
4. 时间窗口：issued_at ≤ now ≤ expires_at（时钟偏差容忍 ±60s）
5. machine_ids 包含本机
6. task_id 若存在必须等于 offer.task_id
7. argv_hash 等于 sha256(canonical argv)（逐字节比较）
8. max_uses：本地持久化使用计数；单机视角计数（同一 grant 给 N 台机器时每台最多 max_uses 次）
9. nonce 未在本地见过（防重放，跨重启保留）
10. 撤销检查（relay 撤销集缓存命中则拒绝）
11. mode/cwd_rel/write/write_scope 与任务实际值一致或更严格
12. 通过 → 执行；执行结果附 grant_status:"verified"、grant_id、used 次数
```

---

## 5. 失败码（全部为任务级 refusal，不抛异常）

```
GRANT_MISSING              任务要求 grant 但没带（仅当任务显式声明 require_grant）
GRANT_UNSUPPORTED_AGENT    旧 agent 不认识 grant（relay 侧探测后提示）
GRANT_BAD_SIGNATURE        签名不符
GRANT_UNKNOWN_KEY          key_id 找不到公钥
GRANT_EXPIRED              过期 / 未到 issued_at / TTL>10min
GRANT_WRONG_MACHINE        machine_ids 不含本机
GRANT_WRONG_TASK           task_id 与 offer 不一致
GRANT_ARGV_MISMATCH        argv_hash 不符
GRANT_REPLAY               nonce/ grant_id 已使用（超 max_uses）
GRANT_REVOKED              撤销集命中
GRANT_CONSTRAINT_VIOLATION mode/cwd/write 与任务不符
```

每个失败码都要有自动化负向测试（§8）。

---

## 6. 密钥分发与信任模型（本版本的关键设计点）

**问题**：agent 要验签，就需要操作员公钥。从哪里来？

**本版本（1.3.3-beta）方案：TOFU + 轮换链**

1. relay 维护 operator 公钥登记：操作员用 operator token（已有的持有证明）调用登记接口，登记 `{key_id, public_key, issued_at, rotation_of?}`；relay 记录 ledger。
2. agent 首次需要验签时向 relay 拉取公钥（`GET /v1/fleet/operators/:key_id`），**首次接受即固定（TOFU）** 存本地 state。
3. 之后任何公钥变更必须由**当前 pinned key 签名**（轮换链：`rotation_of = 旧 key_id`，签名覆盖新公钥），agent 验旧签后更新 pinned key；链断则拒绝并告警。
4. 撤销的公钥进入撤销集，agent 同步后拒绝。

**信任声明（写进文档与告警）**：TOFU 阶段，**被攻破的 relay 可以在 agent 首次验签时注入伪造公钥**。这是 1.3.3-beta 的已知限制；缓解与硬化：

- 短时间内：配对响应里携带 operator 公钥（pairing 时操作员在场，agent 固定），已有机器通过一条"bootstrap"指令完成 pin；
- 后续版本（M2.1）：强制 pairing-time pinning + 轮换链校验 + relay 侧公钥透明日志（append-only，agent 可校验历史）。

---

## 7. 与 M1 的关系

- 共用：`src/maintenance/protocol.mjs` 的规范化 + Ed25519 验签（M1 放在 root runner，M2 放在 agent）。
- 差异：M1 的 request 是**固定 action**（update/restart/diag，root 权限）；M2 的 grant 是**任意 argv**（agent 权限）。两者都用 operator key 签名，都不扩 allow-list。
- 组合场景：远程升级 = M1 的 update（root runner）；远程"运行升级脚本并检查" = M2 的 grant（agent 权限）。两者不互相替代。

---

## 8. 验收

### 正向（真实任务，必须实跑）

1. **空 allow-list 机器执行清单外命令**：TwinsEarth（allow-list 为空）在 grant 授权下执行 `node -e "console.log(process.version)"` 成功，ledger 记录 `auth: "grant"` + grant_id。
2. **常规命令不受影响**：同一台机器无 grant 的 `npm --version` 仍然 `COMMAND_NOT_ALLOWED`。
3. **多机 grant**：grant 同时授权 jp-shared + TwinsEarth，两台都成功（各自 max_uses 计数独立）。
4. **写约束**：grant 带 `write:false` 时写文件的任务被拒绝（`GRANT_CONSTRAINT_VIOLATION` 或写入被拦）。
5. **撤销**：签发后立即撤销 → 同一 grant 再派发被 `GRANT_REVOKED` 拒绝。

### 负向（自动化，进单测/集成）

```
未签名/错签/未知 key_id/过期/未来时间/TTL>10min/换机/换 task_id/改 argv/重放/
超 max_uses/撤销/约束冲突/大小超限/旧 agent 不认识 grant
→ 全部对应错误码，任务不执行，ledger 留痕
```

### 审计验收

- ledger 中每个 grant 任务：`grant_id / key_id / argv_hash / machine / outcome / grant_status` 可查。
- 控制端 `w2m_history` 能看到该任务属于 grant 授权（新字段），不需要翻签名原文。

---

## 9. 兼容与发布

- `1.3.3-beta.1` 起；beta 政策：GitHub prerelease，不入 npm。
- 旧 relay：忽略 `grant` 字段 → 任务按 allow-list 走（可能被拒）；控制端检测到旧 relay 返回 `MAINTENANCE_UNSUPPORTED_RELAY`/`GRANT_UNSUPPORTED_RELAY` 提示。
- 旧 agent：收到带 grant 的 offer 不认识该字段（按现有校验丢失）→ 走 allow-list 拒绝；relay 侧可先行探测 agent 版本并给出 `GRANT_UNSUPPORTED_AGENT`。
- 不改变 task/offer 现有字段语义，只新增可选字段（`grant`、结果里的 `grant_status`）。

---

## 10. 交付物清单（实现阶段）

```
src/auth/operator-key.mjs      operator key 生成/登记/轮换链/TOFU pin（与 M1 共用）
src/auth/grant.mjs             grant 结构、canonical、签发、验证、撤销集
src/agent/agent.mjs            验签与使用计数、撤销缓存、结果字段（核心改动）
src/relay/state.mjs            grant 透传、ledger 事件、撤销集、operator 公钥登记
src/relay/server.mjs           POST /v1/task 的 grant 字段、/v1/fleet/operators、撤销集接口
src/plugin/tools.mjs           控制端签发入口（展示完整 argv → 签名 → 派发 → 等待）
test/grant.test.mjs            单元：规范化/签名/失败码矩阵
test/grant-e2e.test.mjs        双机模拟 relay：验签/使用计数/重放/撤销
docs/COLLAB/M2-TASK-GRANT.md   本文
```

## 11. 开放问题（实现前确认）

1. **operator 公钥的初始信任**：接受 TOFU（relay 可注入，文档声明）还是要求 pairing-time pinning 才能开工（更安全但已有机器需要一个 bootstrap 动作）？
2. **max_uses 语义**：按机器计一次还是全局一次？多机 grant 是否允许每台一次（推荐）？
3. **task_id 绑定**：是否允许 grant 不绑 task_id（更灵活，但同 argv 可被重复用于不同任务）？建议 beta 强制绑定。
4. **写授权**：1.3.3-beta 是否允许 `write:true` 的 grant（进入工作区写文件）？还是本版本只做只读命令，写留给 M3 工作区模型？
5. **Windows**：TwinsEarth 的 agent 在 Windows 上，验签与计数落盘路径需确认；是否与 Linux 同批验收？
