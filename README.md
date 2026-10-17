# DSH: Windows2MacOS

**One DeepSeek account. One instruction. Every machine you own runs the same project.**

[![CI](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml/badge.svg)](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@twinsearth/w2m-dsh-plugin?label=npm)](https://www.npmjs.com/package/@twinsearth/w2m-dsh-plugin)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4c6ef5)](#1-dsh-plugin-recommended--zero-configuration)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platforms](https://img.shields.io/badge/CI-windows%20%7C%20macos%20%7C%20linux-4c6ef5)](#verified-and-not-verified)

English | [中文](#中文说明)

---

## Install

Five routes in. They all end with **11 tools registered** in your agent. Pick one.

### 1. DSH plugin (recommended — zero configuration)

```bash
# 1. install the package into your DSH profile
dsh plugin add @twinsearth/w2m-dsh-plugin

# 2. name it in the profile's bundle list — a package that is not bundled never loads
#    ~/.dsh/profiles/<profile>/dsh.profile.yml
plugins:
  - '@twinsearth/w2m-dsh-plugin'

# 3. restart DSH; joining happens at mount time, so a hot reload is not enough
```

Since **1.1.15** the agent starts by itself (`autoStartAgent` defaults to `true`): a freshly installed machine
derives its account identity, joins the account's fleet, and shows up in `w2m_devices` with no pairing step.
To turn that off, patch the **existing** `w2m` row — do not add a second one:

```yaml
# cordis.patch.yml
- id: w2m
  config:
    autoStartAgent: false
```

### 2. npm (MCP server, any client)

```bash
npm install -g @twinsearth/w2m-dsh-plugin
w2m-mcp --help
```

Point any MCP client at `w2m-mcp`. **Zero runtime dependencies**; the package ships the relay, the agent and the
tools.

### 3. Claude Code

```bash
/plugin marketplace add TwinsEarth/dsh-windows2macos
/plugin install w2m@twinsearth
```

The manifests live in [`.claude-plugin/`](.claude-plugin/) and are version-locked to the release.

### 4. Codex and other MCP-capable CLIs

```toml
# copy this block into your own codex/mcp-servers.toml
[mcp_servers.w2m]
command = "npx"
args = ["-y", "@twinsearth/w2m-dsh-plugin@1.1.16", "w2m-mcp"]
```

### 5. Verified release tarball (offline)

From the `v1.1.16` release page download **both** files — `twinsearth-w2m-dsh-plugin-1.1.16.tgz` and `SHA256SUMS` —
then:

```bash
curl -LO https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v1.1.16/twinsearth-w2m-dsh-plugin-1.1.16.tgz
sha256sum -c SHA256SUMS          # verify before installing, always
npm install -g ./twinsearth-w2m-dsh-plugin-1.1.16.tgz
```

Every release carries `SHA256SUMS` for exactly this reason. If a release is missing it, do not install that release.

---

## Quick start

```text
w2m_status                       # am I paired? which fleet?
w2m_devices                      # what is in the fleet?
w2m_run mode="replicate" command_argv=["git","rev-parse","HEAD"]
w2m_wait task_id="..."
```

`replicate` runs on every online machine; the verdict is `consistent` only when every machine returned the same
result **and** the same commit anchor. `split` gives each machine a slice, `pipeline` chains stages, `broadcast`
names one executor and reports observers, `compose` merges results.

---

## What it is

An installable plugin that turns a set of machines into **one fleet**, keyed by **your account**, not by a
hand-maintained host list.

| Piece | Responsibility |
|---|---|
| **Relay** | a small HTTP server: task routing, leases, SSE, blob storage. Run it anywhere your machines can reach. |
| **Agent** | runs on each machine: pairs once, executes allow-listed commands, heartbeats. |
| **Plugin** | the tools your agent calls. |
| **Admission** (1.1.14+) | a new machine asks to join; an online member approves, **10 s auto-approves**, and a machine admitted in the last 24 h can be removed immediately. |

### Tools

`w2m_status` · `w2m_devices` · `w2m_run` · `w2m_wait` · `w2m_history` · `w2m_stats` · `w2m_report` ·
`w2m_memory` · `w2m_approvals` · `w2m_council` · `w2m_update`

### Environment a dispatched command receives (1.1.15+)

Values come from the offer, never from argv, so one machine cannot reshape a fleet-wide split.

| Variable | Meaning |
|---|---|
| `W2M_INDEX` / `W2M_INDEX_TOTAL` | this machine's slice number and how many slices exist |
| `W2M_STAGE_INDEX` | the pipeline stage; deliberately separate from `W2M_INDEX` |
| `W2M_TASK_ID` / `W2M_MODE` | the task and its mode |
| `W2M_MACHINE_ID` / `W2M_MACHINE_NAME` | this machine |

So `command_argv=["node","-e","process.exit(Number(process.env.W2M_INDEX)+1)"]` over four machines exits 1/2/3/4.
Single-machine behaviour is tested; the four-machine run is listed as **not verified** below.

---

## Fleet model

Identity is **the account**, not a list of hosts. A machine derives an Ed25519 identity from its account
material; the relay registers the matching public key when the account's first machine pairs; every later machine
proves the same account with a one-time signed challenge.

If the old pairing path fails for a **named** reason only — invalid pairing code, unreachable relay, timeout — the
machine falls back to asking for admission. Any other failure needs a human and does **not** change mechanisms. A
rejection is final; the machine does not re-ask.

The relay is authoritative for every time window and every quorum, because client clocks disagree (measured:
tens of seconds between machines in one fleet):

- **10 s** without a decision auto-approves, but only while at least one member is **online** — an empty fleet
  cannot consent, and that refusal is named (`NO_ONLINE_MEMBER`);
- within **24 h** of admission, any online member may remove the machine immediately;
- after 24 h a single machine may only **open a vote**, whose quorum set is **frozen at open time** so a voter
  going offline mid-vote cannot move the bar;
- the quorum is 3+ old members need **≥ 50 %** (rounded up); a two-member fleet needs **one** vote;
- a machine offline for more than **72 hours** leaves the **list** — it is never deleted, its records stay, and it
  returns by reporting again.

---

## Security posture

- The command allow-list is **argv-prefix** based and rejects argv-reparsing flags (`--import`, appended `-e`) with
  `COMMAND_REPARSE_ARGUMENT`. It is a boundary, not a sandbox.
- Dispatching tasks requires an operator token. A device token cannot dispatch.
- Admission approval requires at least one member online.
- The account signing key is derived from the fleet key, **never** from the account code — the account code is
  written to logs, and deriving a key from a readable value would hand out the account identity.
- Every release is checksummed.

---

## Verified and not verified

A green badge that hides this is worse than no badge.

**Verified:** 2458 tests in 102 files (2444 pass, 14 skip), 15 pre-flight checks, CI green on Windows, macOS and
Linux, npm + GitHub release + checksums consistent, end-to-end fleet runs on a real Linux/Mac/Windows triple.

**Not verified / known gaps:**

| Gap | State |
|---|---|
| Approval **popup** control | the relay enforces the rules and `w2m_approvals` lists and settles requests, but the 10 s countdown is relay data shown in a list, not a dedicated popup |
| Four-machine `W2M_INDEX` run | single-machine behaviour tested; the fleet-wide 1/2/3/4 run has not been executed |
| Fleet chat / broadcast channel | message store + quota implemented and tested; encryption, sharding, endpoints and the panel are **not built** |
| P2P on some macOS hosts | `P2P_PUNCH_FAILED: Unknown cipher` observed; the task falls back to the relay path |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| installed, but `w2m_devices` answers 401 | the agent never started, so no device token | check `autoStartAgent` is not `false`; restart DSH (not a hot reload) |
| machine missing from the fleet | the plugin is not in `dsh.profile.bundles` | add it — a package that is not bundled never loads |
| `COMMAND_NOT_ALLOWED` | command not in the allow-list | extend the allow-list; argv is matched by prefix |
| verdict always `partial` | a stale lease from a machine that is down | fixed in 1.1.2: a dispatch leases only online, non-silent machines |
| `P2P_PUNCH_FAILED` | NAT, or a host crypto gap | it downgrades to the relay path; results are unaffected |

---

## Links

- [CHANGELOG](CHANGELOG.md) — every version, including what it deliberately did **not** ship
- [PLATFORMS](docs/PLATFORMS.md) — Claude Code, Codex and MCP wiring details
- [Releases](https://github.com/TwinsEarth/dsh-windows2macos/releases) — per-release evidence and checksums
- [Issues](https://github.com/TwinsEarth/dsh-windows2macos/issues)

MIT.

---

## 中文说明

**一个 DeepSeek 账号。一句话。你自己的每一台机器跑同一个项目。**

以下内容与上方英文**逐节对应**，不是摘要。

### 安装

五种方式，最终都会在你的 agent 里注册 **11 tools registered**。任选其一。

#### 1. DSH 插件（推荐，零配置）

```bash
# 1. 把包装进你的 DSH profile
dsh plugin add @twinsearth/w2m-dsh-plugin

# 2. 在 profile 的 bundle 列表里写上包名 —— 没进 bundle 的包永远不会被加载
#    ~/.dsh/profiles/<profile>/dsh.profile.yml
plugins:
  - '@twinsearth/w2m-dsh-plugin'

# 3. 重启 DSH。加入编队发生在 mount 时，热重载不够
```

从 **1.1.15** 起 agent 会自动启动（`autoStartAgent` 默认 `true`）：新装的机器自行派生账号身份、加入该账号的
编队，无需配对步骤就会出现在 `w2m_devices` 里。若要关闭，请 patch **已存在的** `w2m` 行，**不要新增第二行**：

```yaml
# cordis.patch.yml
- id: w2m
  config:
    autoStartAgent: false
```

#### 2. npm（MCP 服务器，任意客户端）

```bash
npm install -g @twinsearth/w2m-dsh-plugin
w2m-mcp --help
```

把任意 MCP 客户端指向 `w2m-mcp`。**零运行时依赖**；包里同时带有 relay、agent 与工具。

#### 3. Claude Code

```bash
/plugin marketplace add TwinsEarth/dsh-windows2macos
/plugin install w2m@twinsearth
```

清单文件位于 [`.claude-plugin/`](.claude-plugin/)，版本与发行版锁定。

#### 4. Codex 及其它支持 MCP 的 CLI

```toml
# 把这段复制进你自己的 codex/mcp-servers.toml
[mcp_servers.w2m]
command = "npx"
args = ["-y", "@twinsearth/w2m-dsh-plugin@1.1.16", "w2m-mcp"]
```

#### 5. 校验过的发布包（离线）

从 `v1.1.16` 的 release 页面下载**两个**文件 —— `twinsearth-w2m-dsh-plugin-1.1.16.tgz` 与 `SHA256SUMS` —— 然后：

```bash
curl -LO https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v1.1.16/twinsearth-w2m-dsh-plugin-1.1.16.tgz
sha256sum -c SHA256SUMS          # 安装前务必校验
npm install -g ./twinsearth-w2m-dsh-plugin-1.1.16.tgz
```

每个 release 都带 `SHA256SUMS` 正是为了这一步。若某个 release 缺少它，**不要安装该版本**。

### 快速开始

```text
w2m_status                       # 我配对了吗？在哪个编队？
w2m_devices                      # 编队里有什么？
w2m_run mode="replicate" command_argv=["git","rev-parse","HEAD"]
w2m_wait task_id="..."
```

`replicate` 在每一台在线机器上执行；只有当所有机器返回**相同结果**且**相同 commit 锚点**时，裁决才是
`consistent`。`split` 给每台机器一个分片，`pipeline` 串联多个阶段，`broadcast` 指定一个执行者并汇报观察者，
`compose` 合并结果。

### 它是什么

一个可安装插件，把一组机器变成**一个编队**，以**你的账号**为键，而不是靠手工维护的主机清单。

| 组件 | 职责 |
|---|---|
| **Relay** | 一个小型 HTTP 服务：任务路由、租约、SSE、blob 存储。放在任何机器可达的位置。 |
| **Agent** | 每台机器上运行：配对一次、执行白名单命令、心跳。 |
| **Plugin** | 你的 agent 调用的那些工具。 |
| **Admission**（1.1.14+） | 新机器申请加入；在线成员批准，**10 秒自动同意**；入队 24 小时内的机器可被立即移除。 |

### 工具

`w2m_status` · `w2m_devices` · `w2m_run` · `w2m_wait` · `w2m_history` · `w2m_stats` · `w2m_report` ·
`w2m_memory` · `w2m_approvals` · `w2m_council` · `w2m_update`

### 被派发命令会收到的环境变量（1.1.15+）

取值来自 offer，**不来自 argv**，因此单台机器无法改变整个编队的分片：`W2M_INDEX` / `W2M_INDEX_TOTAL` /
`W2M_STAGE_INDEX` / `W2M_TASK_ID` / `W2M_MODE` / `W2M_MACHINE_ID` / `W2M_MACHINE_NAME`。

因此 `command_argv=["node","-e","process.exit(Number(process.env.W2M_INDEX)+1)"]` 在四台机器上应分别退出
1/2/3/4。**单机行为已测；四台机器的联跑尚未验证**（见下方"未验证"）。

### 编队模型

身份是**账号**，不是主机清单。机器从账号材料派生 Ed25519 身份；账号的第一台机器配对时，relay 登记对应公钥；
此后每台机器用一次性签名挑战自证同一个账号。

只有当旧配对路径因**明确原因**失败时 —— 配对码无效、relay 不可达、超时 —— 机器才降级去申请入队。其它失败需要
人工介入，**不会**切换机制。**拒绝即终态**，机器不会再次申请。

所有时间窗与法定人数由 relay 权威判定，因为客户端时钟互不一致（实测：同一编队内相差数十秒）：

- 无决策 **10 秒**后自动同意，但**仅当至少一名成员在线** —— 空编队无法同意，该拒绝有明确错误码
  （`NO_ONLINE_MEMBER`）；
- 入队后 **24 小时内**，任一在线成员可立即移除该机器；
- 超过 24 小时，单台机器只能**发起表决**，且法定人数集合在**发起时冻结**，投票者中途离线无法改变门槛；
- 法定人数：旧成员 ≥3 人需 **≥50%（向上取整）**；2 人编队的移除只要 **1 票**；
- 离线超过 **72 小时**的机器会离开**列表** —— 记录**永不删除**，它重新上报后会自动回来。

### 安全姿态

- 命令白名单按 **argv 前缀**匹配，并拒绝 argv 重解析标志（`--import`、追加 `-e`），错误码
  `COMMAND_REPARSE_ARGUMENT`。这是边界，不是沙箱。
- 派发任务需要 operator token；device token 不能派发。
- 审批入队要求至少一名成员在线。
- 账户签名密钥从 **fleet key** 派生，**绝不**用 account code —— account code 会写进日志，用可读值派生密钥等于
  交出账号身份。
- 每个发行版都有校验和。

### 已验证与未验证

**一句真话胜过一块掩盖问题的绿牌。**

**已验证：** 102 个文件中的 2458 项测试（2444 通过、14 跳过）、15 项门禁检查、Windows / macOS / Linux 三平台
CI 全绿、npm 与 GitHub 发布及校验和一致、在真实的 Linux/Mac/Windows 三机编队上跑过端到端。

**未验证 / 已知缺口：**

| 缺口 | 状态 |
|---|---|
| 审批**弹窗**控件 | relay 强制规则、`w2m_approvals` 可列出并裁决，但 10 秒倒计时是列表里的 relay 数据，不是独立弹窗 |
| 四台机器的 `W2M_INDEX` 联跑 | 单机行为已测；编队级 1/2/3/4 尚未执行 |
| 编队聊天 / 广播通道 | 消息存储与配额已实现并测试；加密、分片、端点与面板**尚未构建** |
| 部分 macOS 主机的 P2P | 观察到 `P2P_PUNCH_FAILED: Unknown cipher`；任务会降级走 relay 路径 |

### 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 装好了，但 `w2m_devices` 返回 401 | agent 从未启动，因此没有 device token | 确认 `autoStartAgent` 不是 `false`；**重启 DSH**（热重载无效） |
| 编队里看不到这台机器 | 插件没写进 `dsh.profile.bundles` | 加进去 —— 不在 bundle 里的包永远不会加载 |
| `COMMAND_NOT_ALLOWED` | 命令不在白名单 | 扩充白名单；argv 按前缀匹配 |
| 裁决总是 `partial` | 来自已下线机器的陈旧租约 | 1.1.2 已修：派发只对在线且未沉默的机器建租约 |
| `P2P_PUNCH_FAILED` | NAT，或宿主密码学能力缺口 | 会自动降级到 relay 路径，结果不受影响 |

### 链接

- [CHANGELOG](CHANGELOG.md) —— 每个版本，包括它**故意没有**交付的内容
- [PLATFORMS](docs/PLATFORMS.md) —— Claude Code、Codex 与 MCP 的接线细节
- [Releases](https://github.com/TwinsEarth/dsh-windows2macos/releases) —— 每个版本的证据与校验和
- [Issues](https://github.com/TwinsEarth/dsh-windows2macos/issues)

MIT。
