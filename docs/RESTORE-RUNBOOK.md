# 恢复手册：全新 `$DSH_HOME`（换机 / 重装）

适用：只有备份仓库（本地 `D:\DeepSeekHarness\BackUP` 或异地镜像），目标是一台**新的或清空的** `$DSH_HOME`。
目标：会话可见、工作区名称/顺序/归档置顶一致、插件行配置一致、身份/凭据按开关处理。

## 恢复顺序（五步）

| 步骤 | 做什么 | 在哪 |
|---|---|---|
| **1. 装 DSH** | 安装宿主与 w2m 插件（插件提供 `w2m-backup`；先装宿主，再 `dsh plugin add`，**不要启动**） | §1 |
| **2. 装依赖** | `dsh-runtimes/`、`profiles/*/node_modules/`、`xray-proxy/`（可重装，故意不在备份里） | §2 |
| **3. 恢复 scopes** | `restore --dry-run` 核对 → `restore --apply`（会话/附件/registry/config/state；restore copies 只计数、不写回） | §3 |
| **4. 登录/入队** | 启动 DSH → 原账户登录 → 编队入队；凭据是否随备份由 P1 开关决定 | §4 |
| **5. 校验** | `verify`（coverage gap=0）→ 会话/工作区 → 插件行 → 面板 → 手动跑一次备份 | §5 |

> 顺序不能颠倒：依赖不在位时 DSH 起不来；scopes 未恢复前登录会生成"新"的注册表/配置，覆盖备份语义；
> 登录之后恢复 config/state 可能被运行中的客户端写回。每步失败都停在该步，不要带着半状态继续。
## 步骤 1 · 装 DSH 与前置检查

- [ ] DSH 已安装（版本 ≥ 插件 `engines.dsh` 要求），且**未启动**（恢复写文件时必须停客户端；G2 的复查只在启动后才有意义）。
- [ ] 备份仓库可读：`w2m-backup status` 显示 `initialized: yes` 且快照非空。
- [ ] 知道仓库的解锁方式（machine / account / PIN）。`w2m-backup unlock` 会列出可用路径。
- [ ] 备份包含 P0 scopes（`registry`/`config`/`state`）：`w2m-backup list --json` 或 `verify` 的 `coverage` 可核对；
      旧快照可能没有这些条目，老快照的降级路径见步骤 3 末尾。

## 步骤 2 · 装回"可重装"依赖（不来自备份，故意不备份）

| 目录 | 大小量级 | 做法 |
|---|---|---|
| `$DSH_HOME/dsh-runtimes/` | ~256 MB | 启动一次 DSH，让宿主自动下载/校验运行时；或按宿主安装包的 runtimes 目录复制 |
| `$DSH_HOME/profiles/<profile>/node_modules/` | ~190 MB | 恢复 `profiles/<p>/package.json` 与 `pnpm-lock.yaml` 后，在 profile 目录执行 `pnpm install --frozen-lockfile`（离线环境用本地 pnpm store/镜像） |
| `$DSH_HOME/xray-proxy/` | ~63 MB | 由 dsh-2xray 插件首次启动时重装，或从原机复制该目录 |

这三项**不要**放进备份：它们可重装、体积大、且二进制与平台绑定。恢复后 DSH 启动失败时，先查这三项是否就位。

## 步骤 3 · 恢复 scopes（两次运行，顺序固定）

```powershell
# 2.1 预览计划：会话 / 附件 / registry / config / state 数量、冲突与写回目标
w2m-backup restore --root D:\DeepSeekHarness\BackUP --dsh-home <new-home> --dry-run

# 2.2 实写（会先做 pre-restore 副本，再写会话 → 附件 → 注册表 → config/state）
w2m-backup restore --root D:\DeepSeekHarness\BackUP --dsh-home <new-home> --apply
```

- 写序保证"注册表先能看见会话"与"配置随后生效"；任何一步失败会在结果里给出具名错误，**不会静默半写**。
- 冲突（目标已有不同内容）：默认先 `.bak` 再覆盖；`--keep-both` 写 `<rel>.restored-<ts>` 旁路。
- **restore copies（P3）**：快照现在也带 `.w2m-restore-backups/**`（`restore_copies` scope）。`restore` 的计划只报
  `restore_copies: {count, skipped: true, detail: 'pre-restore copies are recovery material, not live state'}`，
  **永不把它们写回** live home：它们是失败还原的回滚材料，不是活状态。恢复它们的方法见文末「回滚」。
- 路径逃逸、目标在计划后被改、快照里注册表文档损坏都会拒绝（`BACKUP_RESTORE_TARGET_ESCAPE` /
  `BACKUP_RESTORE_TARGET_CHANGED` / `BACKUP_RESTORE_REGISTRY_INVALID`）。
- 老快照没有 `registry` 条目时：还原需要 `--workspace-path`（一次一个 workspace）；多 workspace 请按顺序跑多次，
  或先升级备份（`w2m-backup run` 用新版本 → 新快照带 registry 后再还原）。

## 步骤 4 · 登录 / 入队（身份与凭据按 P1 开关）

| 场景 | 做法 |
|---|---|
| 备份**未**包含凭据（默认） | 启动 DSH → 用原账户登录 → 编队入队。`xclient/device.key`、`gpw-folders.json.key` 会重新生成；**Black/white list 需要在新机重新设置**（旧策略不在备份里） |
| 备份**包含**凭据（`--include-secrets`） | 恢复后 `xclient/device.key`、`gpw-folders.json.key`、`.credentials.yaml` 一起回来，可直接沿用身份与策略；**但这意味着仓库目录 = 身份**，只在可信存放位置开启 |

无论哪种，恢复后第一次启动都建议重新登录一次以验证凭据库格式与当前 DSH 版本匹配。

## 步骤 5 · 恢复后校验（逐项）

1. `w2m-backup verify` → `result: every claim holds`；`coverage` 的 `gap_count` 应为 0（或只剩已分类的可重装/凭据项）。
2. 打开 DSH：会话列表数量与备份一致；工作区名称/顺序与备份时一致；归档/置顶状态一致。
3. 插件行配置一致：面板不重复、不缺失；`dsh-backup` 行随包启用；22:00 调度与新机时区一致。
4. 打开「备份&还原」面板：状态卡显示正确的仓库路径/快照数/`old/` 用量；如显示"已包含凭据"红色警告，确认这是你有意为之。
5. 手动跑一次备份：新快照提交成功、`verify` 全绿、`last_result` 里 `scopes` 与（如启用）`secrets_included` 正确。

## 回滚

恢复失败或恢复后不可用：

```powershell
# 会话与配置文件都有 pre-restore 副本（默认保留最近 10 份）
Get-ChildItem <new-home>\.w2m-restore-backups -Directory | Sort-Object Name -Descending | Select-Object -First 1
# 停 DSH 后，把该目录里的文件按相对路径覆盖回去；注册表同时恢复其 workspace.json
```

**restore copies 现在也在备份里（P3）**：默认的 `restore_copies` scope 会把 `.w2m-restore-backups/**` 一起写进快照，
所以"原机 home 丢了"时副本不会随之消失。但 `restore` **故意不写回**它们（它们不是活状态，覆盖回去会毁掉回滚材料），
所以取回方式分两种：

- **同机、home 还在**：直接按上面的命令用 `.w2m-restore-backups/<ts>/` 的相对路径覆盖（这是最快、最完整的回滚路径）。
- **换机 / home 已不可用**：副本在备份仓库的快照里，可用 `w2m-backup verify --json`（或 `list --json`）确认
  `coverage.covered.by_scope.restore_copies.files > 0`；目前 CLI 没有"把 restore copies 写回 live home"的命令
  （`restore` 刻意不提供），需要维护者按快照 manifest 里的 `restore-copy` 条目从其块对象重建文件——或者，在换机前
  就把原机 home 的 `.w2m-restore-backups/` 目录单独复制一份保留。`restore --scopes` 可以随时把 `restore_copies`
  排除在这次还原之外（默认也不写回，所以只是少一次计数）。

若连 `$DSH_HOME` 都不可用：删除它，从 §1 重新开始（备份仓库不受影响）。

## 已知边界（本版）

- `.w2m-restore-backups/` 现在**在备份内**（`restore_copies` scope，P3）：路径包含守卫保证备份不会把自己的仓库卷进来，
  restore 也不会把这些副本写回 live home；跨机取回它们目前只能手工按快照块重建（见「回滚」），没有 `restore` 命令。
- restore copies 有独立上限：单文件 64 MiB、整目录 1 GiB；超整目录上限时本次备份只记一条跳过、其余 scope 照常，
  所以"备份里没有某些 restore copy"可能只是超限，不是丢失——原机 home 仍然是它们的唯一完整位置。
- `state` 文件是某一瞬间的快照：客户端正在写某个状态文件时备份的副本可能不是该文件的最新态。
- 注册表还原会替换存活文档（G2 原子写 + 回读 + 保存后复查仍生效，但复查窗口理论仍在）。
- 覆盖率的百分比受可重装依赖影响，**以 `gaps` 是否为 0 作为完整度信号**，不要单看百分比。
