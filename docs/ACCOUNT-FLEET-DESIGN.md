# W2M 账户舰队与设备身份设计（v0.7.4 设计，v0.8.0 实现）

> **状态：设计稿，未实现。** 本文定义一个尚未落地的架构。任何一节都**不得**被当作已实现的
> 能力来引用。实现落在 v0.8.0，因为它改动 relay 协议，属于破坏性变更。
>
> 本文的每一条"已核实"，指的是我读了本仓库或 DSH 运行时的代码并给出了出处；每一条"设计"，
> 指的是尚未写的代码。两者在文中明确区分。

---

## 0. 审计结论（先回答"现在是什么状态"）

在做设计之前，先给出对当前代码的事实核查，因为设计必须针对真实缺陷。

| 问题 | 结论 | 出处 |
|---|---|---|
| 设备身份是否绑定账号？ | **否。** `machine_id` 是 `randomUUID()`，与账号、硬件均无关 | `src/agent/agent.mjs` |
| 是否存在 SN？ | **否。** 这个概念在代码里不存在 | 全仓库 |
| 是否有硬件识别码？ | **否。** `caps` 探测 os/arch/node/python，但不进身份，也不参与授权 | `src/agent/caps.mjs` |
| relay 的 `user_id` 是否用于隔离？ | **否，收下即存，从不读取。** 5 处引用全是 `user_id: d.user_id ?? null` 的存取 | `src/relay/state.mjs` L507/736/981/993, `persistence.mjs` L170 |
| 插件是否引用 `user_id`？ | **0 处** | `src/plugin/tools.mjs` |
| 派发时是否按账号过滤目标？ | **否。** 无 `target_machines` 时 `targets = all`，即 relay 上**每一台**设备 | `src/relay/state.mjs` L1259-1262 |
| 设备表结构 | **一张扁平 Map**，无分组维度 | `src/relay/state.mjs` L435 |

**实测佐证**：共享 relay `a1b59a3b04dcd180` 当前 `devices=4`，全部混在同一条池子里，
配对码**只有一个**。任何拿到该配对码的机器加入同一池，且任何持有有效 operator token 的
调用方，其任务会广播到这 4 台设备中的每一台。

**因此对你的第 2 问，答案是"是"——所有安装本插件的账号确实混同在同一舰队。**

---

## 1. 身份来源（已核实）

### 1.1 账户唯一标识码

**不需要调用账号 API。** DSH 的 Host 已提供 `ctx.deepseekAccount`：

```ts
abstract getDeviceIdentity(): Promise<{
  deviceId?: string;      // provider 的设备标识
  userId?: AccountUserId; // ← 账户唯一标识码
  osVersion: string;
}>
```

官方描述：*"Read existing login identity without creating a device or returning credentials."*
——**读取既有登录身份，不创建新设备，不返回凭据**。

访问方式（可选依赖，必须判空）：

```js
const account = ctx.get('deepseekAccount')
if (account) {
  const { userId } = await account.getDeviceIdentity()
}
```

**这是唯一可信的来源。** 插件的配置行里**不允许**出现手填的账户编码——一个可以由操作员
手填的"账户标识"是可伪造的，等于没有标识。

### 1.2 `userId` 未登录时的行为

`userId` 是可选字段。未登录时它为 `undefined`，此时：

- 插件**不生成 SN**，不加入任何舰队，`w2m_status` 明确报告 `account: 'not-signed-in'`；
- 已有 SN 的机器**保留**其本地身份但**不参与编队**，因为归属无法验证。

**不得**在未登录时回退到"随机 fleet id"——那会让两台未登录的机器互相看见，正是要消除的行为。

---

## 2. SN 格式精确定义

### 2.1 结构

```
W2M-<ACCT>-<HWID>-<TS>
```

| 段 | 长度 | 内容 | 来源 |
|---|---|---|---|
| `W2M` | 3 | 固定字面量，版本无关 | 常量 |
| `ACCT` | 8 | 账户编码 | `sha256(userId)` 的前 8 位小写十六进制 |
| `HWID` | 12 | 设备码 | `sha256(硬件指纹)` 的前 12 位小写十六进制 |
| `TS` | 14 | 时间码 `YYYYMMDDhhmmss`，**UTC** | 首次生成时刻 |

字符集：`[A-Z0-9-]`，全大写段名 + 小写十六进制。总长 **40** 字符（4 + 8 + 1 + 12 + 1 + 14，含 3 个连字符）。

示例：`W2M-3f9a1c2e-7b4d0e91a3c5-20261014203015`

### 2.2 为什么 ACCT 是哈希而不是 `userId` 原文

`userId` 是账号标识，把它明文写进一个**会出现在日志、聊天消息、relay 设备列表**的字符串里，
等于把这个标识到处泄漏。取哈希前 8 位：

- **够用**：同一账号在所有机器上算出同一个值（分组需要）；
- **不可逆**：从 SN 反推不出 `userId`；
- **碰撞概率**：8 位十六进制 = 32 bit。同一 relay 上出现碰撞需要约 2^16 ≈ 65k 个不同账号，
  远超任何现实规模。**但碰撞会合并两条舰队**——所以碰撞检测在第 3.4 节处理。

### 2.3 硬件指纹的组合与归一化

HWID 必须满足三个互相冲突的要求：**重启不变**、**换网卡不变**、**换主板就变**。

按平台取（优先级从上到下，取第一个可读到的）：

| 平台 | 来源 | 读取方式 |
|---|---|---|
| Windows | `MachineGuid` | 注册表 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` |
| Windows | SMBIOS UUID | `wmic csproduct get uuid` / CIM `Win32_ComputerSystemProduct.UUID` |
| macOS | `IOPlatformUUID` | `ioreg -rd1 -c IOPlatformExpertDevice` |
| Linux | `/etc/machine-id` | 直接读文件 |
| Linux | `/var/lib/dbus/machine-id` | 回退 |
| 全部 | **回退**：主机名 + CPU 型号 + 根盘序列号 | 三者哈希 |

**明确排除**（因为它们会变，导致同一台机器被当成两台）：

- MAC 地址、IP、网卡列表 → 换网线/开 VPN 就变
- 磁盘挂载点、分区表 → 插一块盘就变
- 已安装软件清单 → 每次更新都变

指纹 = `sha256(平台标识 + '\n' + 归一化值)`，归一化 = 去空白、转小写。

**HWID 换主板后必然改变，这是设计意图**：换主板等于换机器，需要重新配对。

### 2.4 时间码的角色，以及与"唯一性"的真实关系

TS 取**首次生成**的 UTC 时刻，此后**不变**（不随重启刷新，否则同一台机器每次启动都是新设备）。

**我必须直说一件事：TS 并不提供密码学意义的唯一性。**

唯一性实际由 `(ACCT, HWID)` 保证——同一账号的同一台硬件只应有一个 SN。TS 的作用是：

1. **区分同账号同硬件的重新生成**：重装系统后 MachineGuid 可能重置而 HWID 恰好不变时，
   新 SN 与旧 SN 不同，relay 能把它们识别为"同一台机器的两次登记"而不是两台设备；
2. **可审计**：设备何时首次加入是可见的；
3. **人工可读排序**。

**如果我把 TS 说成"进一步提高保护和唯一性"，那是夸大。** 它是一个有意义的登记时刻戳，
不是安全机制。

### 2.5 SN 是显示与分组键，不是安全凭证

**这是全文最重要的一句。**

SN 由客户端自己计算并声明。任何人都能算出**任意账号**的 ACCT（只要知道 `userId`，或猜到）
并伪造一个 SN。因此：

> **relay 绝不因为 SN 匹配就信任一台设备。**
> SN 只用于**展示**和**按 ACCT 前缀分组**。
> 授权完全由第 3 节的签名链决定。

一个只靠字符串 SN 的方案会给人一种有保护的错觉，而实际没有——**这比不做更危险**。

---

## 3. 舰队授权模型（方案 B：设备级密钥 + 账号签名）

### 3.1 密钥与签名链

```
① 设备自生成 Ed25519 密钥对（首次运行）
     私钥 → <stateDir>/device.key      （0600，永不离开本机，永不进日志）
     公钥 → 随配对请求上传

② 配对：设备提交 { sn, pubkey, machine_id, machine_name, platform, caps }
     配对码证明"操作员允许这台机器进入本账户的舰队"
     配对码本身已绑定账户（见 3.2）→ 配对成功即完成账号归属

③ relay 签发授权声明（Ed25519，用 relay 的舰队密钥）
     auth = { fleet_id, machine_id, sn, pubkey, issued_at, expires_at }
     sig  = relay_sign(auth)
     设备持久化 auth, sig

④ 此后每个请求携带：
     Authorization: Bearer <device_token>          （保持现状，凭证不变）
     X-W2M-Auth: base64(auth)                      （授权声明）
     X-W2M-Sig:  base64(sign_device_key(canonical(request) + "\n" + auth))
```

### 3.2 `fleet_id` 的派生与配对码绑定

```
fleet_id = ACCT                    # 即 sha256(userId) 的前 8 位
```

**关键点：配对码必须绑定账户。** 现在的配对码是 relay 全局的单一码——这正是"混同"的
直接原因。改为：

- relay 签发配对码时记录 `fleet_id`；
- 设备配对时，relay 从**配对码**取得 `fleet_id`（而不是从设备声明的 SN）；
- 因此**设备无法选择自己加入哪条舰队**。它只能加入操作员给它的那个码所属的舰队。

这样"同账户自动同队"成立，且**不依赖设备自报的 SN**。

### 3.3 授权判定（relay 侧，每个请求）

```
1. device_token 有效？                    → 否则 401
2. auth 未过期？                           → 否则 401 AUTH_EXPIRED
3. relay 对 auth 的签名有效？              → 否则 401 AUTH_FORGED
4. auth.fleet_id == 该 token 所属 fleet？  → 否则 403 FLEET_MISMATCH
5. 请求的设备签名有效？                     → 否则 401 SIG_INVALID
6. 请求目标只在该 fleet 内                 → 否则 403 不泄漏他队是否存在
```

### 3.4 泄漏折衷与已知弱点

**必须写明的弱点：**

| 弱点 | 影响 | 缓解 |
|---|---|---|
| ACCT 只有 32 bit | 跨账户碰撞会**合并两条舰队** | relay 在配对时检测：同一 ACCT 但不同 `userId` 哈希来源的第二个账号 → 拒绝并要求提高位数 |
| `auth` 有有效期 | 到期需重签，需要账号在线 | 有效期取 90 天 + 到期前 30 天窗口内可静默续签 |
| relay 持有舰队密钥 | **relay 被攻破 = 可伪造任意舰队的授权** | 舰队密钥支持轮换（见 3.5）；relay 只签不存 `userId` 原文 |
| 设备私钥在本机 | 机器被物理攻破 = 可冒充该设备 | 私钥 0600；可选 OS 钥匙串（后续） |
| 无法防"账号主人自己作恶" | 不试图防 | 明确不在威胁模型内 |

### 3.5 撤销与轮换

- **撤销单台设备**：relay 把 `machine_id` 加入该舰队吊销表，其 `auth` 立即失效。
- **撤销整个账号**：删除该舰队的密钥与全部 `auth`。
- **轮换 relay 舰队密钥**：新密钥签发的 `auth` 生效，旧密钥在重叠期内仍接受
  （`previous_secret_accepted` 已有同样的模式，见 `healthz.signing`）。

---

## 4. 接力时序（PC 无回应时其他 PC 接手）

### 4.1 现状（已核实，部分存在）

| 机制 | 现状 |
|---|---|
| 租约 + 心跳 + 过期 | **已有**：`lease_until_ms`、`heartbeat_count` |
| `halt: never \| now` | **已有**：`never` = 停掉的机器只被记录；`now` = 其他机器可以接手 |
| 结果去重 | **已有**：`dedupe_key` |
| 跨机器重派 | **有机制，但未按舰队范围启用**：`targets` 取全表 |

**所以接力不是从零做，而是把已有的租约机制接上舰队范围。**

### 4.2 时序

```
T0        调度方 POST /v1/task
          → relay 在 fleet 内选目标，创建 lease（attempt=1, state=offered）
          → lease_until = now + LEASE_MS

T0+δ      被选机器 claim → state=claimed，开始心跳
          心跳每 HEARTBEAT_MS 一次，每次续 lease_until

   ── 情况 A：正常完成 ─────────────────────────────────────
T0+n      结果送达 → state=done → 聚合 → 终态
          （无接力发生）

   ── 情况 B：静默（PC 卡住但连接还在）────────────────────
T0+LEASE  心跳超时 → state=expired
          if halt == 'now':
              relay 在 fleet 内选第二台（排除已尝试过的机器）
              → 新 lease，attempt=2
              → 第二台执行、回报
              → 聚合取 attempt 最大的结果（最后一次尝试）
          if halt == 'never':
              → 记录 expired，不重派，终态可能是 partial/degraded

   ── 情况 C：主机离线 ───────────────────────────────────
T0+Δ      连接断开 → relay 标记 offline
          与情况 B 相同路径，但**立即**触发而非等满 LEASE_MS
          这是"默认 PC 没回复，其他 PC 接力"的主路径

   ── 情况 D：第一台在接力后才回复 ────────────────────────
T0+2·LEASE 原机器恢复 → 送达结果
          relay 见到 attempt=1 的结果，而当前 attempt=2
          → 记录为 late result，**不覆盖** attempt=2
          → 在报告里保留（"迟到结果"是诊断信息，不是噪声）
```

### 4.3 语义代价：至少一次执行

**必须写明：接力使执行从"至多一次"变为"至少一次"。**

一条命令可能在两台机器上都跑过。对于 `node --test`、`git status` 这类幂等命令无害；
对于**写操作**（`write: true`）有害——同一条命令可能写两次。

**因此（设计约束）：**

- `halt: 'now'` **仅允许**在 `write: false` 时使用。带写的任务在 relay 侧拒绝 `halt=now`；
- 或在 v0.8.0 引入 **fencing token**（`attempt` 作为栅栏，写操作前校验），但这需要一个
  能被所有机器看到的共享状态，代价高；
- **v0.8.0 采取前者**（写任务禁止自动接力），fencing 列为后续。

### 4.4 选谁接力

优先级：

1. 同 fleet、在线、**未尝试过该 task** 的机器；
2. `caps` 与已失败机器最接近的（平台差异会让结论不可比，`divergent-platform` 已有此语义）；
3. 排除已 `expired` 或 `refused` 的机器（避免同一台机器反复失败）；
4. 全部试过 → 终态 `partial`，报告列出每台的尝试与原因。

**不接力的情况**（明确列出，避免"为什么没接手"的疑问）：

- 任务已 `cancelled`；
- `halt == 'never'`；
- `write == true`；
- 该 fleet 内没有第二台在线机器 → 终态 `degraded`，理由 `no_alternate_machine`。

---

## 5. 微信 ↔ 全部 PC

### 5.1 现状（已核实）

| 组件 | 状态 |
|---|---|
| 微信适配器（iLink） | **已实现并对着真微信验证**（v0.7.1/0.7.3） |
| 聊天 → 编队派发 | **已实现并对着真 relay 验证**（v0.7.3） |
| 舰队 executor | **已实现**，凭据与字段名均按实测修正 |
| **账户范围** | **不存在**——这就是本文要加的 |

### 5.2 设计

微信侧**不需要改动**。变化全在 relay 的 `targets` 选择：

```js
// 现在（src/relay/state.mjs L1259-1262）
const all = [...this.devices.values()];

// 之后
const all = [...this.devices.values()].filter((d) => d.fleet_id === requestFleetId);
```

于是 `/run node --test` 自动变成"**我这个账号下所有 PC**"，而其他账号的机器不可见、
不可达、也不出现在 `/machines` 里。

"默认 PC 没回复，其他 PC 接力"由第 4 节处理，**在同一条 fleet 内**进行。

### 5.3 尚未被验证的一环

**还没有从手机发一条消息、经微信、到编队跑完。** 适配器对着真微信验证过，执行器对着真
relay 验证过，但两者**还没有被一个真人打字连起来**。这一环需要手机，不是测试。

---

## 6. 实施顺序（v0.8.0）

| 阶段 | 内容 | 可独立验证 |
|---|---|---|
| 1 | `account.mjs`：读 `userId`、生成 SN、算 HWID | 单测：三平台夹具 + 未登录路径 |
| 2 | 设备密钥对 + `auth` 声明 + 请求签名 | 单测：签名/验签/篡改/过期 |
| 3 | relay：配对码绑定 fleet、`targets` 按 fleet 过滤 | 单测：两队隔离，A 队看不见 B 队 |
| 4 | 接力：`halt=now` 门槛（禁写）、选机规则、迟到结果 | 单测：四情况时序 |
| 5 | 端到端：两台设备两条 fleet | 集成：跨队不可见 |

**破坏性变更**：relay 协议新增 `fleet_id` 与签名头。老设备连新 relay 必须给出明确的
拒绝信息（而不是静默失败），并在 CHANGELOG 与 PROTOCOL 文档中记录。

---

## 7. 本文没有解决的问题（诚实清单）

1. **SN 本身不防伪。** 防伪来自第 3 节的签名链。任何把 SN 当凭证的实现都是错的。
2. **ACCT 32 bit 存在理论碰撞**，会合并舰队。缓解是检测 + 拒绝，不是消除。
3. **relay 是信任根。** relay 被攻破可伪造任意舰队。没有引入账号侧在线验证，因为那会让
   离线机器无法工作。
4. **接力 = 至少一次执行。** 写任务被禁止自动接力，除非将来引入 fencing。
5. **硬件指纹在虚拟机/容器里不稳定**，克隆的 VM 会共享 HWID。此时靠 `machine_id`（随机）
   区分，SN 相同但设备不同——这是可接受的，因为 `machine_id` 才是主键。
6. **未登录账号不参与舰队。** 这是刻意的：无法验证归属时不编队。
