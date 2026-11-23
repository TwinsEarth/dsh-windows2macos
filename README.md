# DSH: Windows2MacOS

**One DeepSeek account. One instruction. Every machine you own runs the same project.**

[![CI](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml/badge.svg)](https://github.com/TwinsEarth/dsh-windows2macos/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@twinsearth/w2m-dsh-plugin?label=npm)](https://www.npmjs.com/package/@twinsearth/w2m-dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English | [中文说明](#中文说明)

> ## ⚠️ 已弃用版本：3.0.0 / 3.1.0 / 3.2.0
>
> 这三个版本有重大缺陷（决策中心客户端 UI 不完整/缺失；3.2.1 预览构建还存在弹窗遮罩锁死客户端的问题），
> **请勿下载、安装或使用**，npm 上已对 `@twinsearth/w2m-dsh-plugin@>=3.0.0 <3.4.4` 设置 deprecate 警告。
> 请安装 **3.5.0 或更高版本**。

> ### 🚀 3.5.0 大版本更新：新增第 8 项功能「备份&还原」
>
> 左侧边栏多出一个 **备份&还原** 面板（与 GPW 同构的 `sidebar.panellist` + `main` 页），把它当作
> "会话级灾难恢复"产品而不是脚本：内容寻址仓库（`objects/` 去重 + `current/` 指针 + `index.jsonl`）、
> 每天 **22:00**（Asia/Shanghai，可改）自动全会话备份、`old/` 按会话保留旧版本与整文件密封副本、
> 还原前过 session-doctor + 注册表协议 + 安装 Harness 的运行时终审、`.tar.zst` 归档与 `restore --archive`、
> 四类一键操作 + 按会话计划 + 加密/账户/4-6 位 PIN 三种保护状态。详见下方「功能 8」与 [BACKUP-DESIGN](./docs/BACKUP-DESIGN.md)。


## W2M是一个开源（MIT）的 AI 智能体舰队编排工具
————用同一个 DeepSeek 、豆包、WorkBuddy账号把"你自己的多台机器"（Windows/Mac）编成一个舰队，统一派发命令、协作&协同开发。
### 组件有三块：
1.Relay（HTTP+SSE 协调服务器）

2.Agent（每台机器上跑、执行白名单命令）

3.Plugin（给 Agent 用的 25 个工具）

## 八大核心功能

### 功能 1 · 同一账号的 PC，登录自动编队入队
同一 DeepSeek 账号下的每台机器，登录即自动编队入队，无需手动配对、无需维护主机列表。从 v1.1.15 起 `autoStartAgent` 默认开启：新装的机器自行派生账号身份、加入该账号的编队，直接出现在 `w2m_devices` 中。身份以账号为键，而非手维护的 host 列表；每台机器用 Ed25519 密钥证明同一账号归属。

### 功能 2 · 编队聊天框
编队内建 `w2m_chat` 聊天通道，同一编队的机器之间可直接对话、广播消息；composer 内的聊天面板与「编队群组」标签页共享同一份消息记录。消息存储与配额已实现并测试。工具路径可使用编队密钥派生的会话加密；面板端到端加密、分片仍未构建，面板/会话镜像走 relay 时仍是明文。

### 功能 3 · 编队联合开发 & 多机跨机实时协同协作
不止“跑同一条命令”。`w2m_joint_plan` / `w2m_joint_status` 负责联合任务规划与状态跟踪，`w2m_run` 提供 replicate（并行对比）、split（分片执行）、pipeline（流水线）、broadcast（单机广播）四种协作模式，`w2m_council` 多机协商、`w2m_tasks` 任务面板把一组异构机器变成同一个开发编队。联合开发按《W2M Relay × ToFuture 外部对接 API v1.2》收敛：Ed25519 人签审批、`target_machines` 显式派发、409 读回、死租约拒绝；数据面投递（artifact sink）与合并 CLI 已接入 Teams WebRTC 数据面，relay 部署独立于插件发布。

### 功能 4 · 一键到顶：单击滚动三轮，连续点击三次到顶
为长会话和长日志场景设计的滚动浮标：单击一次向上滚动约三轮；1.2 秒内连续点击三次直接回到第一轮（自动展开 DSH 官方「加载更早」）。图标位于会话区右上角，与官方浮动控件同一设计规格，不依赖窗口标题栏。

### 功能 5 · 正文上下文搜索：命中文字绿字黄底高亮
在主工作区进行正文上下文搜索，命中的文字以黄色背景、绿色文字高亮显示，当前匹配项自动滚动进入视野；搜索覆盖正文内容与上下文，不局限于标题或元数据。

### 功能 6 · 全局文件夹读写黑白名单：保护系统盘 & 个人/工作文件夹
DSH 默认的权限模型是“限制 or 全开”，一旦放开就难以精细控制。本插件在官方沙箱之上追加全局文件夹读写黑白名单，为系统盘（`C:\Windows`、`Program Files`、`/etc`、`/usr` 等）和个人/工作文件夹建立明确的读/写边界，避免 AI 或跨机任务误触不该动的路径。这一设计来自实际重装系统后的教训：粗粒度的“全开”代价太高，黑白名单把“绝对不允许”与“经常要放行”的路径变成可配置的硬规则。v2.0.4 起提供两种策略：**小白模式（默认）**只保留黑名单强制拒绝（内置 Windows/Program Files 等默认保护文件夹，路径操作每 3 秒最多自动放行一次），其余全部放行；**高级模式**需手动切换，保留白名单预算、待审批队列与 10 秒无人应答自动放行。

### 功能 7 · 远程桌面（仅查看，1 帧/秒）
在设置里打开「远程桌面」后，可在远程桌面页选择在线目标并连接。目标机也必须打开同一开关，表示同意被编队内其他机器查看；只传输画面，不发送鼠标/键盘输入。目标以 1 帧/秒采集并加密：优先 P2P 直连，P2P 不通时走 relay 的加密帧通道（relay 只看到密文，看不到 JPEG）。查看端每秒拉取最新一帧，因此最低可用帧率是 1 帧/秒；网络和采集耗时会决定实际帧率。目标关闭开关后，下一次采集立即停止。

### 功能 8 · 备份&还原：全会话的自动备份、按会话还原、归档打包与全量校验（v3.5.0）

左侧边栏「备份&还原」面板 + 每天 22:00（Asia/Shanghai，可改时间/时区）的全会话自动备份。仓库是
**内容寻址**的：块按 sha256 去重，会话涨 10% 只写变化的那部分；`current/` 存指针，`old/` 按会话保留旧版本
（默认每会话 10 份，可按份数/天数裁剪），并可选 `oldFormat: full` 为每个被取代版本再写一份**密封整文件副本**
（单份默认 300 MB 上限，超限需「特批」；`old/` 总量不设上限，但每增长 10 GB 提醒一次，由你决定是否手动清理）。

- **一键操作**：立即备份（全部会话 / 选中会话 / 当前活动会话）、还原选中会话（先出计划，逐会话勾选，二次危险确认后才写）、
  归档打包所有已归档会话（`.tar.zst`，含 manifest 与 README，可直接 `restore --archive`）、全量校验（块/清单/索引双向核对 + `old/` 副本逐份解密）。
- **还原门禁**：session-doctor（静态预筛）→ G2 注册表协议（单文档原子写 + 回读校验 + 保存后复查；宿主内走
  `workspaceRegistry` 服务，不写 `workspace.json`）→ G5 运行时终审（用安装的 Harness 自己的解码器校验"原日志与追加一帧后仍可加载"）。
  写前留 pre-restore 副本，写后复读校验；目标在计划之后被改动会拒绝覆盖。
- **保护状态**：默认**不加密**（便捷优先）；可绑定**账户唯一标识**做比对——同账户免密解锁、不同账户自动切密码；
  也可设置 **4-6 位数字 PIN**（附公开备注提示词，可在终端用旧凭据轮换）。密码只从终端 stdin 读取，浏览器从不接触。
- **诚实边界**：默认不加密时，任何能访问仓库目录的人都能还原；账户 ID 只是标识不是秘密；PIN 是便捷门槛不是保密强度。
  需要真正保密时用 sealed + ≥8 位非纯数字长密码 + 目录 ACL/加密卷。详见 [BACKUP-DESIGN §25](./docs/BACKUP-DESIGN.md)。

备份范围（v3.5.0 P0）：默认同时覆盖 **注册表/配置/状态**（`storages/workspace.json`、根与 profile 配置、`xclient` 状态等），
`verify` 会报告"备份对 home 的覆盖率"与缺口；凭据默认**不**备份，可用 `--include-secrets` 显式开启（仓库即身份，慎用）。

离线 CLI（`w2m-backup`）：`status` / `scan` / `list` / `run` / `restore` / `archive` / `verify` / `unlock` /
`register` / `gc` / `old-backfill` / `old-restore` / `selftest`，与面板同一套协议与门禁。

## 安装

Every install path below registers 18 tools in the fleet plugin; enabling the two opt-in sub-plugins adds 7 more (25 across the package).

五种方式，最终都会在你的 fleet agent 里注册 18 个工具；两个 opt-in 子插件另加 7 个，整个包共 25 个。任选其一。

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
args = ["-y", "@twinsearth/w2m-dsh-plugin@3.5.0", "w2m-mcp"]
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

`p2p_webrtc_status` · `p2p_webrtc_start` · `p2p_webrtc_stop` · `p2p_webrtc_probe`

`w2m_team_status` · `w2m_team_room` · `w2m_team_artifact`

`w2m_intent` 把结构化意图（run-tests、node-version、git-status、git-head、fleet-facts、shard-probe）映射到白名单命令；未知意图按名字拒绝，绝不猜测。

P2P WebRTC 是显式启用的第二传输栈（`webrtc-v1`），默认关闭：DataChannel 承载经 Noise_IK_25519_ChaChaPoly_SHA256 加密的 RPC/事件流，独立 WebSocket 信令服务器交换 SDP/ICE，ICE/STUN 直连、TURN 中继降级，失败时保留 UDP/relay 路径。零 WebRTC 运行时依赖，真实引擎通过外部 provider 子进程接入。多机编队通过 `WebRtcTransportPool`（`./p2p-webrtc-pool`）按 peer pair 管理 1:1 transport：机器 ID 字典序决定 host/client，哈希生成确定性房间，relay 的 `peer.static_key` 作为 Noise 固定密钥。架构、配置与 provider 协议见 [docs/P2P-WEBRTC.md](./docs/P2P-WEBRTC.md)。生产部署、signal/provider 安装与 `scripts/desktop-webrtc-readiness.mjs` 只读验收见 [docs/DESKTOP-PRODUCTION.md](./docs/DESKTOP-PRODUCTION.md)。

Teams 也是显式启用的子插件（`dsh-teams`），默认关闭，且提供 `w2m_team_status` / `w2m_team_room` 两个只读视图与 `w2m_team_artifact` 一个 WebRTC 数据面发送工具：它把共享项目房间、成员/心跳可见性和既有五类协作工具（`w2m_joint_plan`、`w2m_joint_status`、`w2m_run`、`w2m_council`、`w2m_tasks`）组合成统一的编队视图，但不新增审批或派发入口。传输策略固定为控制面（心跳/用户信息/计划/审批/租约）走 Relay TCP，数据面（图片/文件/artifact/数据同步）走 WebRTC DataChannel（同一个 `WebRtcTransportPool`）；固定最多 33 次，全部失败即放弃并告警，**不回落 Relay**。artifact 接收端写入 artifact sink，`w2m-joint merge --peer` 的补丁清单也走同一数据面。派发仍须 `w2m-joint` 的 Ed25519 人签审批与显式 `target_machines`。见 [docs/TEAMS.md](./docs/TEAMS.md)。

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
| 联合开发数据面与合并 | ArtifactRef/dir-sink、merge-engine 与 Teams WebRTC 数据面已接线；跨机器真实矩阵尚未执行 |
| 进度视图 | relay 主树有 `progress` 视图；线上 relay 仍是 1.9.16，未部署该代码，插件侧消费端也在接线中 |
| 编队聊天 / 广播通道 | 消息存储 + 配额已实现并测试；工具路径会话加密可用；面板端到端加密、分片尚未构建 |
| 某些 macOS 主机上的 P2P | `P2P_PUNCH_FAILED`；任务回落到 relay 路径 |
| relay 部署 | relay 升级独立于插件发布；线上版本以 `/healthz` 为准 |

## 中文说明

一个 DeepSeek 账号。一句话。你自己的每一台机器跑同一个项目。

### 八大核心功能

1. **同一账号登录自动编队入队**：新机器自动派生身份、加入编队，出现在 `w2m_devices`，无需手动配对。
2. **编队聊天框**：`w2m_chat` 打通编队内沟通，消息存储与配额已就绪；composer 面板与「编队群组」标签共享记录。
3. **编队联合开发 & 多机跨机实时协同**：`w2m_joint_plan` / `w2m_joint_status` + 四种协作模式 + `w2m_council`，把异构机器变成同一个开发编队；审批与派发按 Relay API v1.2 收敛。
4. **一键到顶**：单击滚三轮；1.2 秒内连续点击三次直接回到第一轮（自动展开「加载更早」）。
5. **正文上下文搜索**：主工作区搜索，命中文字绿字黄底高亮，当前项自动滚入视野。
6. **全局文件夹读写黑白名单**：保护系统盘和个人/工作文件夹，把“限制 or 全开”变成可配置的精细边界。
7. **远程桌面（仅查看，1 帧/秒）**：设置里打开「远程桌面」后可在远程桌面页选择在线目标并连接；只传画面，不发送鼠标/键盘。
8. **备份&还原（v3.5.0）**：左侧边栏面板 + 每天 22:00 全会话自动备份；内容寻址仓库、`old/` 旧版本与密封整文件副本、按会话还原（doctor + 注册表协议 + 安装 Harness 的运行时终审）、`.tar.zst` 归档与全量校验；三种保护状态（默认不加密 / 账户 ID 比对 / 4-6 位 PIN）。

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

## 自修复子插件（dsh-fix，v3.4.5+）

会话历史里的图片附件是内容寻址存储的；对象文件一旦被删，这条会话每一轮都会在准备请求时失败，
界面上是「执行出错 · DeepSeek Messages transport failed」，重试 5 次也没用（真因不是网络）。
v3.4.5 起包内自带 `@twinsearth/w2m-dsh-plugin/dsh-fix` 子插件，默认启用：

- 挂在 `agent/request-error` waterfall，只处理 `TRANSPORT` / `ATTACHMENT_NOT_FOUND`；
- 扫描当前请求视图，只针对「对象文件确实不存在且尚未 offloaded」的图片，追加官方既有的
  `image/offload` 事件、`flush` 后让这一轮立即重试（不消耗 provider 重试预算）；
- 没有可修的图就原样交给下游，所以真正的网络错误不会被掩盖；同一轮最多修 3 次。

离线批量体检（需先退出 DSH；CLI 需要 Node ≥ 22.15 的同步 zstd API）：

```bash
node cli/bin/dsh-fix-attachments.mjs scan          # 只报告：哪些会话坏了、要补几处
node cli/bin/dsh-fix-attachments.mjs fix --apply   # 真的写：写前备份、写后全量复核
node cli/bin/dsh-fix-attachments.mjs backups --session <片段>
node cli/bin/dsh-fix-attachments.mjs restore --session <片段> --apply
```

完整说明（判定依据、边界、配置覆盖、状态文件）见 [docs/DSH-FIX.md](./docs/DSH-FIX.md)。

## 互联契约（contract 1.x）

`@twinsearth/w2m-dsh-plugin/contract` 是 w2m 与瓮城 dsh-Fang、房主 dsh-Master 之间的唯一通道：
三个项目各自独立发布、互不 import 内部代码，只经由版本化契约 SDK
`@twinsearth/dsh-fang-contract` 的方法表 + 信封 + 传输层协作。

- 子插件行：`@twinsearth/w2m-dsh-plugin/contract`（默认启用）。
- 服务端方法（`w2m.*`，契约版本 1.0.0）：`w2m.status`、`w2m.methods`、`w2m.fleet.snapshot`、
  `w2m.devices.list`、`w2m.tasks.list`。
- HTTP：`POST /api/w2m/contract/invoke`、`GET /api/w2m/contract/hello`、`GET /api/w2m/contract/health`。
- 同宿主互通走 local 服务：w2m 提供 `w2mContract`，并在 `fangContract` 缺席时补位（已存在则不覆盖）。
- 跨宿主互通走 http 或 file：客户端按 **local → http → file → legacy** 自动降级。
- 升级契约 SDK：`npm pack @twinsearth/dsh-fang-contract@<版本>` → 覆盖 `src/interop/contract/` →
  重生成 `PROVENANCE.md` → `npm run verify:contract`。
