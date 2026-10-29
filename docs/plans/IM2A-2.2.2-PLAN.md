# IM2A v2.2.2 策划与技术方案（先策划，后开发）

状态：DRAFT — 等待产品/技术决策确认，未开始改代码、未发布。
基线：`@twinsearth/w2m-dsh-plugin` v2.0.7（含未发布的 P2P cipher 回退、xfer want-block、cipher 诊断）。
目标：升级到 **v2.2.2**，完成八项发布门禁：commit / tag / GitHub Release / npm / CI / Compat / Release workflow / healthz。

## 1. 范围与假设

- v2.2.2 面向 IM2A 网络：服务器端已具备 relay、fleet、joint-dev、project-room、data-plane refs；本版本补齐**前端统一载体、SDK/API、Agent Plugins 1.0、Skills 标准**。
- 服务端继续零运行时依赖、Node ≥20.19、ESM；新增前端与 SDK 单独成包，不污染 relay 依赖面。
- 发布目标仓库默认 `TwinsEarth/IM2A`（若 v2.2.2 实际指 `@twinsearth/w2m-dsh-plugin`，需在决策点 D1 确认）。
- 现有未发布改动（chacha fallback、cipher 诊断、xfer want-block）作为 v2.2.2 的一部分冻结并验收，不单独发 2.1.x。

## 2. 前端主语言与通用框架（决策 D2）

| 方案 | 多端 | 与 SDK/TS 生态 | 包体/维护 | 结论 |
|---|---|---|---|---|
| TypeScript + React + Vite + Tauri 2 | Web/PWA、Windows/macOS/Linux 桌面；移动端 Capacitor 后续 | 最佳（SDK 同为 TS，类型共享） | 中 | **推荐** |
| Flutter (Dart) | 六端最整齐 | 需维护 Dart SDK 双实现 | 大 | 备选（团队熟悉 Dart 时） |
| 纯 Web + PWA | 浏览器/桌面壳 | 好 | 小 | 不满足桌面能力（托盘/本地文件） |

推荐架构：

```
packages/
  sdk/            @twinsearth/im2a-sdk      TypeScript，协议/类型/客户端
  ui/             @twinsearth/im2a-ui       React 组件与设计令牌
  app-web/        Vite + React Router       浏览器/PWA
  app-desktop/    Tauri 2 壳，复用 app-web  WebView + 原生能力
  adapters/       harness 适配器（见 §4）
```

原则：一次开发、多端复用 UI 与 SDK；桌面仅做原生薄壳（托盘、文件、自动更新）；移动端二期用 Capacitor 复用同一 Web 代码。

## 3. SDK / API 交付物（决策 D3）

- `@twinsearth/im2a-sdk`：TypeScript，导出 `Im2aClient`、`FleetClient`、`ProjectRoomClient`、`SkillRuntime`、类型定义、错误码；同时产出 ESM + d.ts。
- Agent Plugins 1.0：`plugin.json` 清单（name/version/description/skills/mcpServers/commands），校验 schema；兼容 Claude Code Mods 布局（`.claude-plugin/plugin.json`）。
- MCP：复用现有 `bin/w2m-mcp.mjs`，新增 IM2A 工具命名空间；`mcp.json` 可被 Claude/Codex/Copilot/VS Code 读取。
- ACA：新增 `src/aca/` 适配层（能力声明、调用、错误映射），与 MCP 工具共用底层服务；先做协议一致性测试，不承诺未验证的厂商实现。
- Agent Skills：见 §4，技能目录随 npm 包发布，提供 `skills validate` CI 门禁。

兼容策略：SDK 1.x 对 v2.0 API 只增不改；v2.2.2 引入的字段走 capability/feature 探测，旧 relay（2.0.5）缺失时明确降级码，不伪造成功。

## 4. Skills 框架与标准（决策 D4）

```
skills/
├── fleet-control/SKILL.md          # 编队协同控制
├── memory-sync/SKILL.md            # 跨平台记忆同步（MMP）
├── session-ref/SKILL.md            # 跨会话引用协议
└── resource-schedule/SKILL.md      # 资源调度
```

`SKILL.md` 约定：

```yaml
---
name: fleet-control
description: 何时使用、解决什么问题（≤ 512 字符）
version: 2.2.2
license: MIT
metadata:
  requires: [mcp:w2m-fleet]
  capabilities: [fleet.run, fleet.wait, fleet.chat]
---
# 正文：可执行指令、输入输出、失败处理、安全边界
```

- Skill = Agent 应知道什么/怎么工作；MCP = 连接外部能力的端点；两者同插件共存。
- `mcp.json` 只声明端点与传输，不放密钥；token 走 host config/env。
- CI 新增 `skills-validate`：frontmatter schema、目录名=name、正文非空、mcp 引用存在、无明文密钥。

## 5. v2.2.2 工作分解（WBS）

| 编号 | 工作流 | 交付物 | 依赖 | 验收 |
|---|---|---|---|---|
| W0 | 规格冻结 | 本计划 + 3 份 ADR（前端、SDK、Skills） | D1–D4 | 评审通过 |
| W1 | 服务端兼容 | capability/feature 探测、错误码、healthz 增补 | W0 | 旧 relay 降级用例 |
| W2 | SDK | `packages/sdk` 首发、类型、单测、consumer 样例 | W1 | `npm pack` + 三客户端冒烟 |
| W3 | 适配器 | DeepSeekHarness/Codex/Claude/Gemini/OpenClaw/Muse/Copilot/VS Code/WorkBuddy/豆包/Qwen/MiMo 清单 | W2 | 每个客户端一条安装/调用契约测试 |
| W4 | 前端 | app-web + app-desktop（Tauri） | W2 | 登录/编队/会话/技能四页 E2E |
| W5 | Skills | 四技能 + 校验器 + 文档 | W2 | skills-validate 全绿 |
| W6 | 记忆层 | `src/memory-hub/`：SQLite schema、MCP read/write、设备视角过滤、审批队列 | W2 | §10.6 五类用例全绿 |
| W7 | 发布工程 | 版本号、CHANGELOG、acceptance、release notes、scripts | W1–W6 | 八门禁脚本本地演练 |
| W8 | 验收 | 单测/集成/契约/安全/回滚 | W7 | 见 §7 |

关键路径：W0 → W1 → W2 →（W3/W4/W5 并行）→ W6 → W7 → W8。

## 6. 八项发布门禁（缺一不可）

| # | 门禁 | 判定 | 证据 |
|---|---|---|---|
| 1 | commit | 目标分支含 v2.2.2 变更，作者/签名可审计 | commit SHA |
| 2 | tag | `v2.2.2` annotated tag 指向同一 SHA | tag SHA 校验 |
| 3 | GitHub Release | Release 正文含变更/升级/回滚 | Release URL |
| 4 | npm | `npm view @twinsearth/w2m-dsh-plugin@2.2.2` 与 tarball shasum 一致 | shasum |
| 5 | CI | 全平台矩阵绿 | workflow run |
| 6 | Compat | 近三个 relay/plugin 版本兼容矩阵绿 | compat run |
| 7 | Release workflow | 发布工作流成功且产物可下载 | run URL |
| 8 | healthz | 生产 relay `/healthz` 版本/features 与发布一致 | healthz JSON |

补充：当前工作树**没有本地 `.git`**；正式发版前必须恢复可提交仓库（或继续使用受审计的 GitHub API 提交脚本），并把该差异写入发布记录。此项列为 W6 阻断风险。

## 7. 验收与测试

- 单元/集成：现有 preflight 全绿（当前基线 3233 tests / 225 files；新增 SDK/前端另计）。
- 契约测试：12 个 Harness 客户端各一条“安装→发现→调用→错误”用例；未实际执行的客户端只能标 PLANNED。
- Skills：schema/目录/mcp 引用/密钥扫描四类用例。
- 端到端：两机 joint dev + 文件 E2E（依赖 P2P handshake 修复部署）。
- 安全：插件清单/技能正文无 token；MCP 端点的鉴权与超时；npm 包内容审计。
- 回滚：npm dist-tag 回退 + GitHub Release 标记 + relay 不改 schema 的兼容回退。

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| v2.2.2 目标仓库/版本归属未确认 | 发错仓库 | 决策点 D1 先确认 |
| 本地无 `.git` | 无法真实 commit/tag | 恢复 clone 或继续 API 提交并审计 |
| 三机混合版本（26 台在线，多台 plugin_version=null） | P2P/兼容验收假绿 | 验收样本锁定三机同版本，其余只观测 |
| macmini allowlist 空、SSH 未开 | 无法部署与测试 | 本机恢复 allowlist 或开 SSH |
| Electron 宿主缺 chacha（已修） | P2P 握手失败 | v2.2.2 必须包含 chacha fallback 并重启宿主 |
| 前端技术栈引入构建链 | 违反零依赖/供应链审计 | 前端独立包、锁版本、SBOM、许可证扫描 |

## 9. 时间表（建议，按 1 人 + 专家评审）

- D0–D1：决策点确认、ADR 评审、规格冻结。
- D2–D4：W1 + W2（服务端兼容 + SDK）。
- D5–D7：W3/W4/W5 并行（适配器、前端、Skills）。
- D8–D9：W6 发布工程 + 本地八门禁演练。
- D10：W7 验收、发布窗口、八项证据归档。

## 10. 记忆层：W2M Memory Hub（新增，v2.2.2 纳入 MVP）

### 10.1 目标与边界

- 在 Rabbit relay 之外增加**编队共享记忆层**，不把记忆塞进 relay 状态；
- 通过 MCP 暴露 `w2m_memory_read` / `w2m_memory_write`（可选 `w2m_memory_query` / `w2m_memory_approve`），任何 MCP 客户端可读写；
- 设备视角隔离：每条记忆携带 `origin_machine` / `origin_platform` / `scope`；读取按请求方平台与 scope 过滤，平台特定执行细节不污染跨平台记忆；
- MMP（Mesh Memory Protocol）兼容：保留导入/导出适配器，不把 MMP 作为唯一内部格式。

### 10.2 组件与存储

```
Memory Hub（独立进程/模块，不依赖 relay 在线）
  · MCP 工具面：read / write / query / approve
  · 设备视角过滤器 + scope 校验
  · 审批队列（跨 Agent 共享默认需人工批准）
  · 审计日志（谁在何时读了哪条记忆）
  · 后端：SQLite（默认，WAL，单机/小舰队） / Postgres（可选，多副本）
```

最小 schema：

```
memories(
  id, fleet_id, scope, key, value_json,
  origin_machine, origin_platform, session_ref,
  tags, sensitivity, approval_state,
  version, created_at, updated_at, expires_at
)
```

并发：写入用 version/CAS，冲突返回 `MEMORY_VERSION_CONFLICT`；删除用 tombstone，保留审计。

### 10.3 与现有记忆工具的关系

- 现有 `w2m_memory`（agent 本地 jsonl）保留为**本地热缓存**；
- Hub 是**共享事实源**；跨机共享必须显式 `w2m_memory_write`，禁止隐式双写；
- `w2m_memory_read` 先查 Hub，miss 时可选回落本地缓存，并标记 `source=local-cache`；
- 任何 token/密钥/聊天明文不得写入 Hub；写入前做敏感字段扫描并拒绝。

### 10.4 外部基础设施策略

- Priostack ACN、ContextGO、imcodes、dsh-ai-memory、dsh-mnemos 作为**可选连接器**，放在 `connectors/`，通过同一 MCP 表面接入；
- v2.2.2 不把它们设为硬依赖；未安装时 Hub 自身可用（SQLite）；
- 连接器必须通过同一权限/审批/脱敏管线，不能绕过设备视角过滤。

### 10.5 分层适配架构落位

| 层 | 本仓库落位 | v2.2.2 交付 |
|---|---|---|
| 分发层 Agent Plugins 1.0 | `plugin.json`、`skills/`、`mcp.json`、`extensions/` | 清单 + schema 校验 |
| 描述层 Agent Skills | `skills/*/SKILL.md` | 四技能 + skills-validate |
| 协议层 MCP | `bin/w2m-mcp.mjs`、`src/mcp/` | IM2A 工具命名空间 + Memory Hub 工具 |
| 记忆层 | `src/memory-hub/` | SQLite MVP + MCP read/write + 隔离/审批 |
| 平台适配层 | `extensions/{vscode,cursor,codex,claude,...}` | 12 客户端安装/调用清单 |

### 10.6 记忆层验收

- 读写隔离：Mac 写入的平台细节，Windows 读取不可见（除显式 `scope=shared`）；
- 重启持久化：Hub 重启后记忆与审批状态不丢；
- 并发：两设备同时写同一 key，后者收到版本冲突而非静默覆盖；
- 安全：写入含 token/密钥样式的值被拒绝；审计可查；
- MCP 一致性：Claude/Codex/VS Code 三类客户端各一条 read/write 契约测试（未实跑标 PLANNED）。

## 11. 平台适配层策略（12+ 客户端）

原则：**一个 MCP 端点，多种安装形态**。所有客户端最终连到同一个 `bin/w2m-mcp.mjs`（stdio 或 HTTP），差异只在“如何把配置放进去”。

| 客户端 | 接入方式 | 交付物 | 验证级别 |
|---|---|---|---|
| Claude Code | `mcp.json` / `.mcp.json`，项目或用户级 | `extensions/claude/mcp.json` + 安装说明 | 契约测试（已具备 .claude-plugin 基础） |
| Codex | `~/.codex/config.toml` 的 MCP 段 | `extensions/codex/mcp-servers.toml` | 契约测试 |
| Cursor | `.cursor/mcp.json` | `extensions/cursor/mcp.json` | 契约测试 |
| VS Code | `.vscode/mcp.json`（或用户设置） | `extensions/vscode/mcp.json` + 扩展清单 | 契约测试 |
| OpenClaw | Bundle 安装 Agent Plugins 包，自动映射 skills + MCP | `extensions/openclaw/` bundle 清单 | 安装冒烟 |
| Qwen Code | 原生加载 Agent Plugins v1 包，stdio MCP 自动展开 | `plugin.json` + `skills/` + `mcp.json` | 安装冒烟 |
| MiMo Code | 同 Qwen Code（Agent Plugins v1 + stdio MCP） | 同上 | 安装冒烟 |
| Grok | `grok mcp add` 或复用 `.cursor/mcp.json` | 命令片段 + 配置 | 文档 + 契约（工具存在性需实测） |
| WorkBuddy | 插件面板或 `mcp.json` | 面板步骤 + 配置文件 | 文档 + 冒烟 |
| Kimi | 插件面板或 `mcp.json` | 面板步骤 + 配置文件 | 文档 + 冒烟 |
| Muse | `muse mcp` 命令或自建 MCP 客户端 | 命令片段 + 最小客户端样例 | 文档 + 冒烟 |
| 豆包 | 火山引擎方舟 API 的 MCP 支持 | API 配置模板（endpoint/token 走环境变量） | 文档 + 待实测 |
| GLM | 智谱一键安装助手管理 MCP | 安装助手配置模板 | 文档 + 待实测 |

### 11.1 统一交付结构

```
extensions/
  claude/      mcp.json + README
  codex/       mcp-servers.toml + README
  cursor/      mcp.json + README
  vscode/      mcp.json + README
  openclaw/    bundle.json + README
  qwen/        README（复用根 plugin.json）
  mimo/        README（复用根 plugin.json）
  grok/        README + 命令片段
  workbuddy/   README + mcp.json
  kimi/        README + mcp.json
  muse/        README + 最小客户端
  doubao/      README + ark-mcp 模板
  glm/         README + 安装助手模板
```

- 根 `mcp.json` 是唯一事实源；各客户端文件只做路径/格式转换，不复制工具定义；
- 密钥只放 host config/环境变量，模板中一律 `${ENV}` 占位；
- 每个客户端 README 必须包含：安装、启动、一条只读工具调用、一个具名错误码、卸载/回滚。

### 11.2 验证边界

- **已具备基础**：Claude Code、Codex（仓库已有 `.claude-plugin/`、`codex/`、`mcp.json`）。
- **配置模板可交付**：Cursor、VS Code、OpenClaw、Qwen、MiMo、Grok、WorkBuddy、Kimi、Muse。
- **需实测后才可以宣称适配**：豆包（方舟 MCP）、GLM（智谱安装助手）、Grok（`grok mcp` 子命令是否存在）、Muse（`muse mcp` 子命令）。
- 未实跑的客户端在发布说明中标记 **PLANNED**，不得写成“已支持”。

## 12. 架构不变量（结语固化）

以下三条作为 v2.2.2 的硬约束，任何实现不得绕过：

### 12.1 一个源，多平台输出

- 唯一源包：根 `plugin.json` + `skills/` + `mcp.json`；
- 新增生成器 `scripts/build-platforms.mjs`：从单一源生成 `extensions/{claude,codex,cursor,vscode,openclaw,...}/`；
- CI 门禁 `--check`：生成结果与仓库内文件逐字节一致，否则失败；禁止手改生成文件；
- 发布产物只从源包构建一次，各平台安装包/配置由生成器产出。

### 12.2 MCP 作为统一调用协议

- 能力调用统一走 MCP 工具面（`w2m_run/w2m_wait/w2m_memory_*` 等），不为任何平台写定制集成代码；
- 平台适配层只负责**配置落点/传输方式**（stdio/http、config 文件位置），不复制工具逻辑；
- ACA 作为可选协议适配器，位于 MCP 之下，不形成第二套工具语义；
- 任何“平台专用分支”必须被拒绝，除非以数据/配置形式存在。

### 12.3 记忆层与调用层分离

- 两个独立 MCP 服务器：
  - `w2m-fleet`：任务/编队/项目/文件能力；
  - `w2m-memory-hub`：共享记忆读写/审批/审计；
- 进程、配置、存储、权限各自独立；记忆层不可调用 fleet 执行工具；
- 记忆共享通过独立 MCP 端点，与能力调用解耦；任一侧故障不拖垮另一侧；
- 统一鉴权约定（token 从 host config/env 读取），但权限模型各自实现。

### 12.4 对发布门禁的影响

八项门禁之外新增两个**前置检查**（不改变门禁数量）：

1. `build-platforms --check` 无漂移；
2. 两个 MCP 服务器各自通过 `doctor`/schema 校验，且互不 import 对方执行模块。

## 13. 决策点（需要你确认后才能开发）

- **D1**：v2.2.2 发布目标是 `TwinsEarth/IM2A` 还是 `@twinsearth/w2m-dsh-plugin`？是否允许把当前未发布改动并入？
- **D2**：前端采用 **TypeScript + React + Vite + Tauri**（推荐）还是 Flutter？
- **D3**：SDK 首发是否只做 TypeScript/Node，Python SDK 延后？
- **D4**：Skills 四个目录是否就按 `fleet-control / memory-sync / session-ref / resource-schedule` 冻结？
- **D5**：发布审批人/窗口，以及是否允许我在正式发版前先跑一次“预演发布”（不 tag、不 npm publish）。

- **D6**：记忆层默认后端用 SQLite（推荐）还是直接 Postgres？Priostack ACN / ContextGO 等外部记忆设施是否作为 v2.2.2 的可选连接器（推荐）而不是硬依赖？

- **D7**：平台适配的验收边界：13 个客户端是否全部要求“实机契约通过”，还是 Claude/Codex/Cursor/VS Code 实机通过、其余以配置模板 + PLANNED 标记交付？

在 D1–D7 确认前，本方案不改代码、不发版。
