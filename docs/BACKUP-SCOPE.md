# 备份范围审计：到底备份了什么、漏了什么（v3.5.0，2026-11-18）

## 实现状态（2026-11-18）

- **P0 已实现**：五个 scope（`sessions`/`attachments`/`registry`/`config`/`state`，默认全开）——`storages/workspace.json`、
  根与 profile 配置、`xclient`/`dsh-context`/`llm-deepseek`/`fang` 状态都进入快照；manifest 记录 `scopes` 与每项 `reason`；
  还原以备份的注册表文档为基底（多 workspace / title / order / defaultWorkspaceId 原样恢复）；`verify` 输出覆盖率与
  `BACKUP_VERIFY_COVERAGE_GAP`；`.tar.zst` 与镜像同步携带这些条目。见 `docs/BACKUP-DESIGN.md` §27。
- **P1 已实现**：`backupIncludeSecrets` / `--include-secrets`（默认 **false**）显式开启才备份凭据；开启时 manifest 标
  `secrets_included:true`，CLI 打印显著警告；面板状态卡的红色警告为本轮遗留 UI 项。
- **仍未纳入**：`.w2m-restore-backups/`（避免自引用）、`dsh-runtimes/`、`profiles/*/node_modules/`、`xray-proxy/`（可重装）。
- **P2（待做）**：`docs/RESTORE-RUNBOOK.md` 全新 home 的恢复顺序。

> 下面的审计快照保留为"扩围前"的历史证据（2026-11-18 04:00 前后）；其中的"未备份清单"已由上述实现关闭。

> 结论先行：**当前备份 = 每个会话的「最高版本日志」+ 附件对象**。`$DSH_HOME` 里其它一切（注册表本体、插件/配置文件、
> 设备身份、凭据、其它插件状态）**不在备份范围内**。
>
> 在**同一台机器**上"覆盖还原"是可用的；但"换机/重装后从备份恢复成一台可用的 DSH"**目前不成立**——
> 这正是"备份不完全，等于完全不备份"的那类缺口。本文逐路径列出事实、影响与建议，供决定扩围方案。

## 0. 实测口径

| 项 | 值 |
|---|---|
| 真实 `$DSH_HOME` | `C:\Users\fangw\.dsh`：**955.9 MB / 13,462 文件** |
| 最新快照（`20261117T185850Z-74ee14e3`） | **42 文件 / 215.8 MB（明文）**：`session` 40、`attachment` 2 |
| 覆盖率 | 字节 **≈22.6%**；文件数 **≈0.3%**（其余大多是可重装的运行时/依赖，但也有几百 KB 的关键配置与身份文件） |
| manifest 里的注册表信息 | 仅计数：`{workspaces:3, registered:14, archived:5, pinned:4}`——**不含注册表文档本体** |
| 明确排除 | 3 条（`.event-cache`、`session_projcache`、legacy `.w2m-restore-backups`） |

复现：`w2m-backup scan --json`、`w2m-backup list`、`w2m-backup verify`；manifest 由 `readSnapshot()` 读取（仓库密钥）。

## 1. 已备份（有代码、有测试、有真机数据）

| 路径（相对 `$DSH_HOME`） | 内容 | 说明 |
|---|---|---|
| `sessions/<workspace-slug>/<session-id>/session.v<N>.jsonl.zstd` | **每个会话目录下版本号最高的那一个日志文件**（`scan.mjs` 按 `vN` 取最大） | 整文件按 4 MiB 内容寻址分块、AEAD 密封；连同 header `cwd/createdAt/agentPreset` 解析出的元数据、`flags{registered,archived,pinned}` 一起进 manifest |
| `attachments/v1/objects/<aa>/<sha256>` | **全部** 合法附件对象（内容寻址、与选中会话无关） | 还原时按对象写回；冲突（同 id 不同字节）拒绝 |
| 上述文件的块 | `objects/<aa>/<sha256>` 密封块，跨快照去重 | `verify` 校验块摘要/索引/清单 |
| `old/` 旧版本 | 每会话被取代版本的可还原记录（+ 可选整文件 `.json.enc`） | 仅"被轮转过的版本"，不是所有历史版本 |
| manifest / index / keys 副本 | 快照清单、索引行、DEK 信封副本 | 保证"一个快照目录 + objects/"可独立还原 |

**不备份历史版本**：一个会话目录如果有 `session.v4.jsonl.zstd` 之外的旧版本文件（如 `v3`），只备份版本号最高的那个；
更早的字节只可能存在于 `old/`（若发生过轮转）或备份仓库的旧快照里。

## 2. 明确排除（有理由，可接受）

| 路径 | 理由 |
|---|---|
| `sessions/.event-cache/` | 日志的派生投影，客户端按需重建 |
| `storages/session_projcache/` | 会话列表/标题的派生缓存，重建即可 |
| `sessions/.w2m-restore-backups/` | w2m 还原前副本的历史位置（现已移到 home 根） |

## 3. 未备份清单（按影响排序）

### P0 — 影响"还原后还能不能用"

| 路径 | 实测大小 | 丢失后果 |
|---|---|---|
| `storages/workspace.json` | 2.6 KB | **注册表本体**：workspaces 的 `path/title/order`、`global.defaultWorkspaceId`、archived/pinned 的**工作区级**记录。manifest 只存计数与每会话 flags。新机上还原时按 slug 匹配不到 workspace → `BACKUP_RESTORE_WORKSPACE_UNKNOWN`（需手工 `--workspace-path`，且一次只能给一个） |
| `cordis.patch.yml`（根） | 3.1 KB | 全局插件行配置（哪些插件、启用/禁用、配置值） |
| `profiles/<profile>/package.json` | 1.0 KB | profile 的 `dsh.profile.bundles` 与依赖——**没进 bundles 的插件永远不会被加载** |
| `profiles/<profile>/cordis.patch.yml` | 2.9 KB | profile 级插件行/配置覆盖 |
| `profiles/<profile>/pnpm-lock.yaml` + `pnpm-workspace.yaml` + `cordis.yml` | 53 KB | 可重装但决定版本锁定；丢了会得到"与备份时不同版本"的插件集 |
| `xclient/device.json` + `device.key` | 379 B | 本机设备身份（入队/信任链）；丢了要重新配对/入队 |
| `xclient/gpw-folders.json` + `.key` | 369 B | 文件夹黑白名单（含加密 key）——安全边界，丢了等于策略重置 |
| `xclient/agent-state.json` / `fleet-home.json` / `bootstrap.json` | 1.2 KB | agent 状态、fleet home、引导状态 |
| `xclient/decision-center/` | 29.9 KB | 决策中心待办/历史 |
| `xclient/w2m-backup/`（state） | 267 B | G2 复查记录、运行时终审缓存、待批状态——重建成本低，但丢了会"忘记"待批提醒 |
| `xclient/spool/` | 少量 | 外发队列 |
| `storages/dsh-context/` | 62.4 KB | dsh-context 插件的持久状态 |
| `llm-deepseek/` | 925 B | LLM provider 配置（model/参数） |
| `fang/` | 11.7 KB / 25 文件 | 瓮城 dsh-fang 的互通状态（contract 会话） |
| `.credentials.yaml` | 805 B | **账户登录凭据**（sensitive） |
| `.anonymous-user-id` | 37 B | 匿名设备标识 |
| `.w2m-restore-backups/`（home 根） | **229.7 MB** | w2m 自己的还原前副本；**它本身就是一份"最后手段"**，目前不在备份内（会与备份互相引用，需明确是否纳入） |

### P1 — 可重装，不应备份（但要在恢复手册里写清步骤）

| 路径 | 大小 | 说明 |
|---|---|---|
| `dsh-runtimes/` | 255.8 MB | Node/Python 运行时与依赖；按安装脚本重装 |
| `profiles/<profile>/node_modules/` | ≈190 MB | 插件依赖；`pnpm install` 重装 |
| `xray-proxy/` | 62.7 MB | 代理二进制/配置；重装 |

## 4. 还原能力矩阵（事实）

| 场景 | 现状 | 结论 |
|---|---|---|
| 同一台机器、workspace 仍在注册表 | ✅ 日志/附件写回、注册表登记、pre-restore 副本、G2 复查、G5 终审 | 可用 |
| 同一台机器、workspace 已从注册表删除 | ⚠️ 需 `--workspace-path`（一次一个 workspace） | 可人工修，但多 workspace 要跑多次 |
| **全新 `$DSH_HOME`（换机/重装）** | ❌ 注册表/workspace 映射、插件配置、设备身份、凭据全都没有 | **不算完整还原** |
| 只用 `.tar.zst` 归档 | 包含快照里的会话 + **全部**附件对象 + 归档清单 | 同"全新 home"的限制 |
| 只用 `old/` 的 full 副本 | 按版本/按文件恢复（`old-restore`），不含注册表 | 单文件级救援 |
| 从 `full_copy` 恢复会话 | ✅ 已有 `old-restore`（plan/apply、doctors、`.bak`） | 可用 |

## 5. 安全决策（必须显式选择）

`.credentials.yaml`、`xclient/device.key`、`gpw-folders.json.key` 是凭据/密钥：

- **纳入备份**：换机后可直接恢复登录/身份/策略；代价是**仓库被拿到即身份被拿到**（与"默认不加密"叠加时尤其严重）。
- **不纳入（当前）**：更安全，但换机后必须重新登录、重新入队、重设黑白名单——需在恢复手册里写成手工步骤。

建议：默认**不纳入**；提供显式开关 `backupIncludeSecrets: false|true`（默认 false），开启时在面板/CLI 明确警告，
并在 manifest 标注 `secrets_included: true`。

## 6. 扩围建议（按优先级，待批准后实施）

1. **P0（必做）：状态与配置**——新增 `scopes`（在现有 `sessions`/`attachments` 之外）：
   - `registry`: `storages/workspace.json`（原样备份；还原时先写注册表，再把会话登记进去，**不再依赖 slug 猜测**）
   - `config`: 根 `cordis.patch.yml`、`profiles/*/{package.json,cordis.patch.yml,cordis.yml,pnpm-lock.yaml,pnpm-workspace.yaml}`
   - `state`: `xclient/*.json`、`xclient/decision-center/`、`xclient/w2m-backup/`、`xclient/spool/`、`storages/dsh-context/`、
     `llm-deepseek/`、`fang/`
   - 清单里每个新增路径都要有 `reason`（为什么备份/为什么排除），`verify` 增加"home 覆盖率报告"
2. **P1（可选）：凭据**——`backupIncludeSecrets` 显式开关，默认关；开启时单独标注并在面板警告。
3. **P2：重装步骤**——`docs/RESTORE-RUNBOOK.md`：全新 home 的恢复顺序（装 DSH → 装插件/运行依赖 → 恢复 `scopes` →
   登录/入队（或恢复凭据）→ 校验会话可见）。
4. **P3：`old/` 与 `.w2m-restore-backups` 的关系**——明确"还原前副本"是否纳入备份（建议纳入，作为最后手段，但要避免镜像/备份自引用环）。

**验收标准**：在**空的 `$DSH_HOME`** 上只用备份仓库（+ 安装脚本）恢复后：
- `w2m-backup verify` 全绿；
- 打开 DSH 能看到全部会话与附件、workspace 名称/顺序一致；
- `storages/workspace.json` 的 archived/pinned 与备份时一致；
- 插件行配置一致（面板/工具不重复、不缺失）；
- 设备身份与黑白名单：若未恢复凭据，必须有**明确提示与手工步骤**，且不出现"静默半可用"状态。
