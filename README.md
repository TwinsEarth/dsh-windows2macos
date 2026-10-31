# DSH: Windows2MacOS

**One DeepSeek account. One instruction. Every machine you own runs the same project.**

[![CI](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml/badge.svg)](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@twinsearth/w2m-dsh-plugin?label=npm)](https://www.npmjs.com/package/@twinsearth/w2m-dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English | [中文说明](#中文说明)

## W2M是一个开源（MIT）的 AI 智能体舰队编排工具
————用同一个 DeepSeek 、豆包、WorkBuddy账号把"你自己的多台机器"（Windows/Mac）编成一个舰队，统一派发命令、协作&协同开发。
### 组件有三块：
1.Relay（HTTP+SSE 协调服务器）

2.Agent（每台机器上跑、执行白名单命令）

3.Plugin（给 Agent 用的 18 个工具）

## 六大核心功能

### 功能 1 · 同一账号的 PC，登录自动编队入队
同一 DeepSeek 账号下的每台机器，登录即自动编队入队，无需手动配对、无需维护主机列表。从 v1.1.15 起 `autoStartAgent` 默认开启：新装的机器自行派生账号身份、加入该账号的编队，直接出现在 `w2m_devices` 中。身份以账号为键，而非手维护的 host 列表；每台机器用 Ed25519 密钥证明同一账号归属。

### 功能 2 · 编队聊天框
编队内建 `w2m_chat` 聊天通道，同一编队的机器之间可直接对话、广播消息；composer 内的聊天面板与「编队群组」标签页共享同一份消息记录。消息存储与配额已实现并测试。工具路径可使用编队密钥派生的会话加密；面板端到端加密、分片仍未构建，面板/会话镜像走 relay 时仍是明文。

### 功能 3 · 编队联合开发 & 多机跨机实时协同协作
不止“跑同一条命令”。`w2m_joint_plan` / `w2m_joint_status` 负责联合任务规划与状态跟踪，`w2m_run` 提供 replicate（并行对比）、split（分片执行）、pipeline（流水线）、broadcast（单机广播）四种协作模式，`w2m_council` 多机协商、`w2m_tasks` 任务面板把一组异构机器变成同一个开发编队。联合开发按《W2M Relay × ToFuture 外部对接 API v1.2》收敛：Ed25519 人签审批、`target_machines` 显式派发、409 读回、死租约拒绝；数据面投递（artifact sink）与合并 CLI 仍在接线中，relay 部署独立于插件发布。

### 功能 4 · 一键到顶：单击滚动三轮，连续点击三次到顶
为长会话和长日志场景设计的滚动浮标：单击一次向上滚动约三轮；1.2 秒内连续点击三次直接回到第一轮（自动展开 DSH 官方「加载更早」）。图标位于会话区右上角，与官方浮动控件同一设计规格，不依赖窗口标题栏。

### 功能 5 · 正文上下文搜索：命中文字绿字黄底高亮
在主工作区进行正文上下文搜索，命中的文字以黄色背景、绿色文字高亮显示，当前匹配项自动滚动进入视野；搜索覆盖正文内容与上下文，不局限于标题或元数据。

### 功能 6 · 全局文件夹读写黑白名单：保护系统盘 & 个人/工作文件夹
DSH 默认的权限模型是“限制 or 全开”，一旦放开就难以精细控制。本插件在官方沙箱之上追加全局文件夹读写黑白名单，为系统盘（`C:\Windows`、`Program Files`、`/etc`、`/usr` 等）和个人/工作文件夹建立明确的读/写边界，避免 AI 或跨机任务误触不该动的路径。这一设计来自实际重装系统后的教训：粗粒度的“全开”代价太高，黑白名单把“绝对不允许”与“经常要放行”的路径变成可配置的硬规则。v2.0.4 起提供两种策略：**小白模式（默认）**只保留黑名单强制拒绝（内置 Windows/Program Files 等默认保护文件夹，路径操作每 3 秒最多自动放行一次），其余全部放行；**高级模式**需手动切换，保留白名单预算、待审批队列与 10 秒无人应答自动放行。

### 功能 7 ·远程桌面（开发中）

## 安装

Every install path below registers 18 tools in your agent.

五种方式，最终都会在你的 agent 里注册 18 个工具。任选其一。

### 1. DSH 插件（推荐，零配置）

```bash
# 1. 把包装进你的 DSH profile
dsh plugin add @twinsearth/w2m-dsh-plugin

# 2. 在 profile 的 bundle 列表里写上包名 —— 没进 bundle 的包永远不会被加载
# ~/.dsh/profiles/<profile>/dsh.profile.yml
plugins:
  - '@twinsearth/w2m-dsh-plugin'

# 3. 重启 DSH。加入编队发生在 mount 时，热重载不够
```

从 1.1.15 起 agent 会自动启动（`autoStartAgent` 默认 true）：新装的机器自行派生账号身份、加入该账号的编队，无需配对步骤就会出现在 `w2m_devices` 里。若要关闭：

```yaml
# cordis.patch.yml
- id: w2m
  config:
    autoStartAgent: false
```

### 2. npm（MCP 服务器，任意客户端）

```bash
npm install -g @twinsearth/w2m-dsh-plugin
w2m-mcp --help
```

把任意 MCP 客户端指向 `w2m-mcp`。零运行时依赖；包里同时带有 relay、agent 与工具。

### 3. Claude Code

```bash
/plugin marketplace add TwinsEarth/dsh-windows2macos
/plugin install w2m@twinsearth
```

清单文件位于 `.claude-plugin/`，版本与发行版锁定。

### 4. Codex 及其他支持 MCP 的 CLI

```toml
# 复制进你自己的 codex/mcp-servers.toml
[mcp_servers.w2m]
command = "npx"
args = ["-y", "@twinsearth/w2m-dsh-plugin@2.1.7", "w2m-mcp"]
```

### 5. 验证过的 release tarball（离线）

从 v2.0.3 release 页下载 `twinsearth-w2m-dsh-plugin-2.0.3.tgz` 与 `SHA256SUMS`，然后：

```bash
curl -LO https://github.com/TwinsEarth/dsh-windows2macos/releases/download/v2.0.3/twinsearth-w2m-dsh-plugin-2.0.3.tgz
sha256sum -c SHA256SUMS   # 先验证，永远先验证
npm install -g ./twinsearth-w2m-dsh-plugin-2.0.3.tgz
```

每个 release 都附带 `SHA256SUMS`，缺失的 release 不要安装。

## Quick start

```bash
w2m_status          # 我配对了吗？在哪个编队？
w2m_devices         # 编队里有什么机器？
w2m_run mode="replicate" command_argv=["git","rev-parse","HEAD"]
w2m_wait task_id="..."
```

replicate 在每台在线机器上运行，只有所有机器返回相同结果且相同 commit 锚点时，判定才是 consistent。split 给每台机器一个分片，pipeline 串联阶段，broadcast 指定一个执行者并报告观察者，compose 合并结果。

## What it is

一个可安装插件，把一组机器变成一个编队，以你的账号为键，而不是手维护的主机列表。

| 组件 | 职责 |
|---|---|
| Relay | 小型 HTTP 服务器：任务路由、租约、SSE。不承载数据面对象；运行在机器可达的任何地方 |
| Agent | 每台机器上运行：配对一次、执行白名单命令、心跳 |
| Plugin | 你的 agent 调用的工具 |
| Admission (1.1.14+) | 新机器请求加入；在线成员批准，10 秒自动批准，24 小时内加入的机器可立即移除 |

## Tools

`w2m_status` · `w2m_devices` · `w2m_run` · `w2m_wait` · `w2m_history` · `w2m_stats` · `w2m_report` · `w2m_memory` · `w2m_approvals` · `w2m_cancel` · `w2m_council` · `w2m_chat` · `w2m_update` · `w2m_tasks` · `w2m_reduce` · `w2m_joint_plan` · `w2m_joint_status` · `w2m_intent`

`w2m_intent` 把结构化意图（run-tests、node-version、git-status、git-head、fleet-facts、shard-probe）映射到白名单命令；未知意图按名字拒绝，绝不猜测。

## Security posture

命令白名单基于 argv 前缀，拒绝 argv 重解析标志（`--import`、附加 `-e`），命中时返回 `COMMAND_REPARSE_ARGUMENT`。它是边界，不是沙箱。

派发任务需要 operator token；设备 token 不能派发。
加入批准要求至少一个成员在线。
账号签名密钥从编队密钥派生，从不从账号代码派生——账号代码会写入日志，从可读值派生密钥等于交出账号身份。
每个 release 都有校验和。

## Verified and not verified

一个隐藏这些事实的绿标比没有标更糟。

Verified：preflight 16 项发布门禁通过；CI 在 Windows、macOS、Linux 上通过；npm + GitHub release + 校验和一致；联合开发计划/审批/派发路径有单元测试与本地 relay 测试覆盖。

Known gaps：

| Gap | State |
|---|---|
| 真机 A–G 执行证据 | 仅完成 A/B/C/D 的路由冒烟；E/F/G 与真实执行未执行（目标机命令白名单默认拒绝、三机版本需对齐） |
| 联合开发数据面与合并 | ArtifactRef/dir-sink 与 merge-engine 已有库与单测，但 agent 投递与合并 CLI 尚未接线 |
| 进度视图 | relay 主树有 `progress` 视图；线上 relay 仍是 1.9.16，未部署该代码，插件侧消费端也在接线中 |
| 编队聊天 / 广播通道 | 消息存储 + 配额已实现并测试；工具路径会话加密可用；面板端到端加密、分片尚未构建 |
| 某些 macOS 主机上的 P2P | `P2P_PUNCH_FAILED`；任务回落到 relay 路径 |
| relay 部署 | relay 升级独立于插件发布；线上版本以 `/healthz` 为准 |

## 中文说明

一个 DeepSeek 账号。一句话。你自己的每一台机器跑同一个项目。

### 六大核心功能

1. **同一账号登录自动编队入队**：新机器自动派生身份、加入编队，出现在 `w2m_devices`，无需手动配对。
2. **编队聊天框**：`w2m_chat` 打通编队内沟通，消息存储与配额已就绪；composer 面板与「编队群组」标签共享记录。
3. **编队联合开发 & 多机跨机实时协同**：`w2m_joint_plan` / `w2m_joint_status` + 四种协作模式 + `w2m_council`，把异构机器变成同一个开发编队；审批与派发按 Relay API v1.2 收敛。
4. **一键到顶**：单击滚三轮；1.2 秒内连续点击三次直接回到第一轮（自动展开「加载更早」）。
5. **正文上下文搜索**：主工作区搜索，命中文字绿字黄底高亮，当前项自动滚入视野。
6. **全局文件夹读写黑白名单**：保护系统盘和个人/工作文件夹，把“限制 or 全开”变成可配置的精细边界。

### 安装（DSH 插件）

```bash
dsh plugin add @twinsearth/w2m-dsh-plugin
# 在 ~/.dsh/profiles/<profile>/dsh.profile.yml 中加入：
plugins:
  - '@twinsearth/w2m-dsh-plugin'
# 重启 DSH
```

其余四种安装方式与上方英文一致。

## Links

- [CHANGELOG](./CHANGELOG.md) — 每个版本，包括它刻意没有交付的东西
- [PLATFORMS](./PLATFORMS.md) — Claude Code、Codex 与 MCP 接线细节
- [Releases](https://github.com/TwinsEarth/dsh-windows2macos/releases) — 每个 release 的证据与校验和
- [Issues](https://github.com/TwinsEarth/dsh-windows2macos/issues)

MIT.
