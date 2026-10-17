# DSH: Windows2MacOS

**One DeepSeek account. One instruction. Every machine you own runs the same project.**

[![CI](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml/badge.svg)](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@twinsearth/w2m-dsh-plugin?label=npm)](https://www.npmjs.com/package/@twinsearth/w2m-dsh-plugin)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4c6ef5)](#install)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platforms](https://img.shields.io/badge/CI-windows%20%7C%20macos%20%7C%20linux-4c6ef5)](#verified-and-not-verified)

English | [中文](#中文说明)

---

## Install

Five ways in, easiest first. **Pick one.** Every route ends with the same eleven tools in your agent.

### 1. DSH plugin (recommended — zero configuration)

```bash
# 1. install the package into your DSH profile
dsh plugin add @twinsearth/w2m-dsh-plugin

# 2. add it to the profile's bundle list (this is what makes it load)
#    ~/.dsh/profiles/<profile>/dsh.profile.yml
plugins:
  - '@twinsearth/w2m-dsh-plugin'

# 3. restart DSH — joining happens at mount time, so a hot reload is not enough
```

Since **1.1.16** the agent starts by itself (`autoStartAgent` defaults to `true`): a freshly installed
machine derives its account identity, joins the account's fleet, and appears in `w2m_devices` with no
pairing step. To turn that off, put it back explicitly:

```yaml
# cordis.patch.yml — patch the EXISTING w2m row, do not add a second one
- id: w2m
  config:
    autoStartAgent: false
```

### 2. npm (MCP server, any client)

```bash
npm install -g @twinsearth/w2m-dsh-plugin
w2m-mcp --help
```

Point any MCP client at `w2m-mcp`. The package has **zero runtime dependencies** and ships its own
relay, agent and tools.

### 3. Claude Code

```bash
/plugin marketplace add TwinsEarth/dsh-windows2macos
/plugin install w2m@twinsearth
```

The manifests live in [`.claude-plugin/`](.claude-plugin/) and are version-locked to the release.

### 4. Codex / MCP-capable CLIs

```toml
# codex/mcp-servers.toml — copy this block into your own config
[mcp_servers.w2m]
command = "npx"
args = ["-y", "@twinsearth/w2m-dsh-plugin@1.1.16", "w2m-mcp"]
```

### 5. From the release tarball (verified, offline)

From the 1.1.16 release page, download **both** files:

- 	winsearth-w2m-dsh-plugin-1.1.16.tgz
- SHA256SUMS

Or fetch the tarball directly and take the checksum file from the same release:

```bash
curl -LO https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v1.1.16/twinsearth-w2m-dsh-plugin-1.1.16.tgz
sha256sum -c SHA256SUMS          # verify before installing, always
npm install -g ./twinsearth-w2m-dsh-plugin-1.1.16.tgz
```

Every release carries **`SHA256SUMS`** for exactly this reason. If it is missing, do not install that
release — that has happened before and it was a defect.

---

## Quick start

```text
# 1. on the machine that will coordinate
w2m_status                       # is this machine paired? which fleet?

# 2. see the fleet
w2m_devices

# 3. run the same command everywhere
w2m_run mode="replicate" command_argv=["git","rev-parse","HEAD"]

# 4. wait for every machine, then read the verdict
w2m_wait task_id="..."
```

`replicate` runs on every online machine and the verdict is `consistent` only when every machine
returned the same result **and** the same commit anchor. `split` gives each machine a slice;
`pipeline` chains stages; `broadcast` names one executor and reports observers; `compose` merges.

---

## What it actually is

An installable plugin that turns a set of machines into **one fleet**, keyed by **your account**, not
by a hand-maintained host list.

| Piece | What it does |
|---|---|
| **Relay** | one small HTTP server: task routing, leases, SSE, blob storage. Run it anywhere your machines can reach. |
| **Agent** | runs on each machine, pairs once, executes allowed commands, heartbeats. |
| **Plugin** | **11 tools registered** — the `w2m_*` tools your agent calls. |
| **Admission** (1.1.14+) | a new machine asks to join; an online member approves, **10 s auto-approves**, and a machine admitted in the last 24 h can be removed immediately. |

### The 11 tools registered

`w2m_status` · `w2m_devices` · `w2m_run` · `w2m_wait` · `w2m_history` · `w2m_stats` · `w2m_report`
· `w2m_memory` · `w2m_approvals` · `w2m_council` · `w2m_update`

### Environment variables a dispatched command receives

Since 1.1.16 the command knows where it is — values come from the offer, never from argv:

| Variable | Meaning |
|---|---|
| `W2M_INDEX` / `W2M_INDEX_TOTAL` | this machine's slice and how many slices exist |
| `W2M_STAGE_INDEX` | the pipeline stage (separate from `W2M_INDEX` on purpose) |
| `W2M_TASK_ID` / `W2M_MODE` | the task and its mode |
| `W2M_MACHINE_ID` / `W2M_MACHINE_NAME` | this machine |

So `command_argv=["node","-e","process.exit(Number(process.env.W2M_INDEX)+1)"]` over four machines
exits 1/2/3/4. (Verified on one machine; the four-machine run is listed as not verified below.)

---

## Fleet model in one paragraph

Identity is **the account**, not a machine list. A machine derives an Ed25519 identity from its
account material, the relay registers the matching public key when the account's first machine pairs,
and every later machine proves the same account with a one-time signed challenge. If the old pairing
path fails for a **named** reason only (invalid code, unreachable relay, timeout), the machine falls
back to asking for admission; any other failure needs a human and does **not** change mechanisms.

The relay is authoritative for every time window and every quorum. A machine that has been offline
for more than 72 hours leaves the **list** — it is never deleted, records stay, and it returns by
reporting again.

---

## Security posture

- The command allow-list is **argv-prefix** based and rejects argv-reparsing flags (`--import`, `-e`
  appended) with `COMMAND_REPARSE_ARGUMENT`. It is a boundary, not a sandbox.
- Dispatching tasks requires an operator token. Device tokens cannot dispatch.
- Admission approval requires at least one member **online**; an empty fleet cannot consent.
- Every release is checksummed. `SHA256SUMS` is part of the release, not an afterthought.

---

## Verified and not verified

Honest status, because a green badge that hides this is worse than no badge.

**Verified:** 2453 tests in 102 files (2439 pass, 14 skip), 15 pre-flight checks, CI green on Windows,
macOS and Linux, npm + GitHub release + checksums consistent, end-to-end fleet runs on a real
Linux/Mac/Windows triple.

**Not verified / known gaps:**

| Gap | State |
|---|---|
| Approval **UI** in the client | the relay enforces the rules; the tool lists and settles pending requests, but the 10 s countdown is displayed by the relay's data, not a dedicated popup |
| Four-machine `W2M_INDEX` run | single-machine behaviour tested; the fleet-wide 1/2/3/4 run has not been executed |
| Fleet chat / broadcast channel | designed, **not implemented** |
| P2P on some macOS hosts | `P2P_PUNCH_FAILED: Unknown cipher` observed; the task falls back to the relay path |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| installed, but `w2m_devices` answers 401 | the agent never started, so no device token | check `autoStartAgent` is not `false`; restart DSH (not a hot reload) |
| machine not in the fleet | the plugin is not in `dsh.profile.bundles` | add it — a package that is not bundled never loads |
| `COMMAND_NOT_ALLOWED` | the command is not in the allow-list | extend the allow-list; argv is matched by prefix |
| verdict always `partial` | a stale lease from a machine that is down | fixed in 1.1.2 (dispatch now leases only online, non-silent machines) |
| `P2P_PUNCH_FAILED` | NAT or a host crypto gap | it downgrades to the relay path; the result is unaffected |

---

## Links

- [CHANGELOG](CHANGELOG.md) — every version, including what each one deliberately did **not** ship
- [PLATFORMS](docs/PLATFORMS.md) — Claude Code, Codex, MCP wiring details
- [Test matrix](https://github.com/TwinsEarth/dsh-windows2macos/releases) — per-release evidence
- [Issues](https://github.com/TwinsEarth/dsh-windows2macos/issues)

MIT.

---

## 中文说明

**一个 DeepSeek 账号。一句话。你自己的每一台机器跑同一个项目。**

### 安装（由易到难，任选一种）

1. **DSH 插件（推荐，零配置）**：`dsh plugin add @twinsearth/w2m-dsh-plugin`，把包名加入
   `dsh.profile.bundles`，**重启 DSH**。1.1.16 起 agent 默认自动启动，装完即自动入队。
2. **npm（任意 MCP 客户端）**：`npm i -g @twinsearth/w2m-dsh-plugin` → `w2m-mcp`。
3. **Claude Code**：`/plugin marketplace add TwinsEarth/dsh-windows2macos` → `/plugin install w2m@twinsearth`。
4. **Codex**：复制 [`codex/mcp-servers.toml`](codex/mcp-servers.toml) 的配置块。
5. **发布包（离线、可校验）**：下载 release 中的 `.tgz` 与 `SHA256SUMS`，**先校验再安装**。

### 快速开始

```text
w2m_status          # 我配对了吗？在哪个编队？
w2m_devices         # 编队里有哪些机器
w2m_run mode="replicate" command_argv=["git","rev-parse","HEAD"]
w2m_wait task_id="..."
```

### 核心概念

- **身份是账号，不是主机清单**：机器从账号材料派生 Ed25519 身份，账号第一台机器配对时登记公钥，
  后续机器用一次性签名挑战自证。
- **只按三类明确失败降级**：配对码无效 / relay 不可达 / 超时；其它错误需要人工，**不切换机制**。
- **时间窗与法定人数由 relay 权威判定**：10 秒自动同意（需至少 1 名成员在线）、24 小时内可即时踢出、
  超过 24 小时需冻结快照表决（3 人以上 ≥50%，2 人编队 1 票）。
- **离线 72 小时只是不显示，绝不删除**：记录保留，机器重新上线后自动回到列表。
- **派发命令会拿到 `W2M_INDEX` 等环境变量**（1.1.16 起），因此 split 可以按机器分支。

### 验证状态（不含糊）

已测试 2453 项（2439 通过 / 14 跳过）、15 项门禁、三平台 CI 全绿、npm 与 GitHub 发布及校验和一致。

**未验证项**：客户端审批弹窗（规则由 relay 强制，工具可列出并裁决）、四台机器 `W2M_INDEX` 全员取值、
编队聊天通道（仅设计）、部分 macOS 主机的 P2P 降级。

MIT。
