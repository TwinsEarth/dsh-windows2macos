# 备份子插件（`dsh-backup-plugin`）：独立挂载的归档工具面

> 状态：**v3.5.5 实现**。定时仓库引擎的协议与仓库布局不变，仍以 [BACKUP-DESIGN.md](BACKUP-DESIGN.md) 为准；
> 本文只描述 `dsh-backup` 与 `dsh-backup-plugin` **两个 bundle 行**、它们各自的默认值，以及归档行对外暴露的
> 六个 `backup_*` 工具。v3.5.4 的草稿把归档行描述成"定时器 + 面板路由 + 工具"，那是把两个产品写成了一个；
> 本版按实现改正，`test/backup-subplugin.test.mjs` 是这份描述的规格来源。

## 1. 两个行，两个产品

v3.5.5 把备份能力拆成两个可以**分别点名启用**的 bundle 行：

| 行 | 子路径 / 入口 | 挂载的内容 | 工具面 | 默认 |
|---|---|---|---|---|
| `dsh-backup` | `./dsh-backup` → `lib/backup.js` | 定时器（默认 22:00 Asia/Shanghai）+ 内容寻址仓库 + 面板路由 `/api/w2m/backup/*` | 无 | `disabled: true` |
| `dsh-backup-plugin` | `./dsh-backup-plugin` → `lib/backup-plugin.js` | **只有**六个 `backup_*` 工具；每次调用读写一个自包含 ZIP | `backup_status` / `backup_list` / `backup_create` / `backup_verify` / `backup_restore` / `backup_import_session_zip` | `disabled: true` |

两者都是**显式选择**：定时器会在无人值守时写盘，归档工具面能写文件、能把备份还原到项目上，所以安装包
不能替操作者把任何一个打开。`cordis.patch.yml` 里的两个行都写 `disabled: true`，插件管理器里可以看到、
可以单独打开——这就是"可选"该有的形状。

`lib/index.js`（包根，舰队插件）**故意不 re-export** 这两行：装一个舰队插件不应该顺带得到能覆盖项目目录的工具。

## 2. 为什么两行可以同时启用

v3.5.4 的草稿说两行互斥、第二个挂载会以 `BACKUP_ALREADY_MOUNTED` 拒绝。那描述的是"两个定时器写同一个仓库"的
旧设想：归档行当时被设计成再挂一遍 `src/plugin/backup.mjs`。**3.5.5 的归档行不挂定时器、不挂面板路由、不碰
仓库**（`src/plugin/backup.mjs` 与 `src/plugin/backup-plugin.mjs` 是两个 composition root），所以：

- 同时启用 = 一个定时仓库（`dsh-backup`）+ 一个按需归档工具面（`dsh-backup-plugin`）；
- 没有第二个定时器、没有重复路由，也就没有需要拒绝的重复挂载；
- 本版代码里**没有** `BACKUP_ALREADY_MOUNTED` 这条拒绝——它要防的那个冲突在这个形状下不存在。若将来出现
  第二个"定时仓库"行，冲突规则应该在两个仓库 composition root 之间重新引入，而不是在归档行上假装有。

两行的工作目录也不同：仓库行写 `backupDir`（仓库布局，见 BACKUP-DESIGN），归档行写 `backupRoot`（一堆
`backup-<stamp>-<label>.zip`）。它们可以指向同一个父目录下的不同子目录，但**不要指向同一个目录**：归档工具
只把 `*.zip` 当自己的文件，仓库目录里的对象/快照不是 ZIP。

## 3. 归档行的默认配置

`cordis.patch.yml` 的 `dsh-backup-plugin` 行：

```yaml
- id: dsh-backup-plugin
  name: '@twinsearth/w2m-dsh-plugin/dsh-backup-plugin'
  disabled: true
  config:
    backupRoot: ''
    includeProject: true
    includeSessions: true
    includeProfile: false
    keepBackups: 0
    maxFileBytes: 67108864
```

`src/plugin/backup-plugin.mjs#normalizePluginConfig()` 决定解析后的默认值（测试直接核对行与解析器两边）：

| 键 | 默认 | 解析后 |
|---|---|---|
| `backupRoot` | `''` | `<DSH_HOME>/backups/w2m-dsh-backup-plugin`；`backupDir` 也接受，`backupRoot` 优先 |
| `projectRoot` | 未给 | `DSH_WORKSPACE`，再退回进程 cwd；`backup_status` 会报告 `project_root_source` |
| `workspace` | 未给 | 同 `projectRoot` |
| `dshHome` | 未给 | `DSH_HOME`，再退回 `~/.dsh` |
| `profileDir` | 未给 | `<DSH_HOME>/profiles/<DSH_PROFILE 或 desktop>` |
| `includeProject` | `true` | 项目文件 |
| `includeSessions` | `true` | 绑定到 `workspace` 的会话日志 |
| `includeProfile` | `false` | profile 的 `package.json` / `cordis.patch.yml` / `cordis.yml` |
| `keepBackups` | `0` | 0 = 全部保留；正整数 = 只留最新 N 个归档 |
| `maxFileBytes` | `67108864` | 单条目上限（64 MiB）；超过的条目记入 `skipped`，**绝不截断** |
| `exclude` | 见下 | 项目扫描跳过的目录名（大小写不敏感） |

默认排除目录：`node_modules`、`.git`、`dist`、`build`、`sessions`、`scratch`、`archive`、`runtime`、`.secrets`、
`.tmp`、`.cache`。符号链接不会被跟随，而是记入 `skipped`；归档目录如果落在项目里，它所在的顶层段会自动排除，
避免"归档把自己打包进去"。

**工具参数永远不能改仓库路径、`$DSH_HOME`、profile 目录、保留策略或大小上限。** 这些只来自行配置与环境变量；
工具参数只选择**做什么**（包含哪些来源、目标目录、是否覆盖），不选择**在哪里**写基础目录。

`apply()` 本身**不做任何磁盘工作**：不建目录、不扫描、不启动定时器；`ctx.effect` 只是为宿主提供一个显式的
dispose 归属。`backup_status` 同样只做只读解析，所以"挂载/查询不会顺手建目录"是被端到端用例测量的。

## 4. 工具面（六个）

六个工具都通过 `ctx.inject(['tools'], ...)` 注册；宿主没有 `tools` 服务时插件仍然挂载，只记一条 warning。
每个定义都有 `name`、非空 `description`、`parameters` 和文本 `output.render`，返回值是
`{ok, ...}` 的 JSON 文本；拒绝是**值**而不是异常：`{ok:false, reason_code, detail}`。

| 工具 | 参数 | 行为 |
|---|---|---|
| `backup_status` | 无 | 解析后的配置/目录、归档数量、最新归档、六个工具名；**不创建目录** |
| `backup_list` | `limit?` | `backupRoot` 下的归档（新→旧），带清单摘要；读不懂的归档仍列出并带 `error` |
| `backup_create` | `label?`, `projectRoot?`, `workspace?`, `includeProject?`, `includeSessions?`, `includeProfile?` | 写一个 `backup-<stamp>[-label].zip`；返回路径、字节数、sha256、每类计数与 `skipped` |
| `backup_verify` | `archive`（必填） | 用归档自己的 `manifest.json` 重算每个条目的 sha256；返回 `missing` / `mismatched` / `extras` |
| `backup_restore` | `archive`（必填）, `mode?`, `confirm?`, `targetProject?`, `overwrite?`, `includeSessions?`, `includeProfile?`, `keepSessionIds?`, `forceRunning?` | `plan` 只读；`apply` 必须带 `confirm: "restore"`，先写 pre-restore 副本再写目标；`keepSessionIds` 冲突默认拒绝，`forceRunning` 先备份会话目录再替换 |
| `backup_import_session_zip` | `zip`（必填）, `workspace?`, `keepIds?`, `attach?`, `forceRunning?` | 导入 DSH 官方会话导出 ZIP；默认分配新 id，`keepIds` 冲突默认拒绝，`forceRunning` 先备份会话目录再替换；附件一并落盘并挂到 workspace 注册表 |

### 4.1 `backup_restore` 的确认令牌与 pre-restore 副本

`mode: "apply"` 是一个破坏性动作，所以它要求 `confirm: "restore"`（与面板路由的确认令牌同一拼写）。缺令牌
或拼错时返回 `BACKUP_RESTORE_CONFIRM_REQUIRED`，**在任何写盘之前**拒绝——`plan` 可以随便跑，`apply` 必须被
明确要求。

在第一次写入之前，`apply` 把每个**将被覆盖**的文件复制到
`<DSH_HOME>/.w2m-restore-backups/archive-<UTC stamp>/<project|profile>/<相对路径>`，返回
`pre_restore: { dir, files }`；副本写不出来就整次拒绝（`BACKUP_WRITE_FAILED`），不会留下"写了一半、没有退路"
的目录树。目标里不存在的文件不需要副本，因此全新目标的第一轮 `apply` 的 `pre_restore.dir` 是 `null`。
`.w2m-restore-backups` 与仓库还原共用同一个 home 根目录，位于所有扫描根之外，后续备份不会把恢复副本当成会话。

### 4.2 会话还原

归档里的会话以磁盘存储形态（zstd 帧序列，首帧恰好一行 header）保存，还原时直接解码、重编码写入：

- 默认分配新 id（根 `session-<uuid>`，子代理 `<uuid>`），并把事件行与 `parentSession` 里的旧 id 一起重写；
- `keepSessionIds: true` 沿用原 id，但目标 home 已存在同 id 时**拒绝**（`BACKUP_SESSION_ID_CONFLICT`），不覆盖；
- `forceRunning: true` 是这条拒绝的**显式出路**，不是"接受并回报"：先把已存在的会话目录整个复制到
  `<DSH_HOME>/.w2m-restore-backups/sessions-<UTC>/<projectKey>/<id>/`（保留客户端留在目录里的每个文件），
  删除原目录，再写入还原日志；每个被替换的会话在结果里以
  `replaced: [{session_id, backup, file}]` 出现（`backup` 是旧目录的副本，`file` 是新写入的日志）。
  `plan` 只报告 `plan.sessions.existing_ids` 与 `plan.sessions.replace_existing`，不复制、不删除；
  扫描之后才出现的同 id 日志仍然拒绝，除非显式给了 `forceRunning`；
- 根会话通过 `src/backup/registry.mjs` 的"计划 → 原子写 → 读回比对"协议挂到目标 workspace；子代理只通过父会话
  出现，不单独注册；
- 每次成功注册都带上客户端可能覆盖注册表的残留风险说明（`CLIENT_OVERWRITE_WARNING`）。这条风险与
  `forceRunning` 无关：`forceRunning` 解决的是**磁盘上的会话 id 冲突**，不是"客户端正在运行"。

### 4.3 `backup_import_session_zip`

备份仓库只能还原它自己备份过的东西；手上只剩一份 DSH 官方导出 ZIP 的人需要另一条路径。实现是
`src/backup/session-zip.mjs`（不是仓库还原的 `restore.mjs`）：

- ZIP 结构：`session.v4.jsonl`（根）、`subagents/<id>/session.v4.jsonl`（子代理）、
  `media/<sha256:hex>.<ext>`、`files/<ab>/<digest>/<name>`；
- ZIP 里是**明文 JSONL**，不是磁盘上的 zstd 字节；导入按存储规则重编码（首帧恰好一行 header）；
- 必须恰好一个根会话（0 个 → `BACKUP_SESSION_NO_ROOT`，多个 → `BACKUP_SESSION_ROOT_AMBIGUOUS`）：官方导出就是
  一棵树，猜根会把子代理导入成 workspace；
- 磁盘目录名由 `cwd` 推导（`projectKey`），所以默认分配新 id，`keepIds` 冲突即拒绝；`forceRunning` 是显式出路：
  先按 §4.2 的规则把旧会话目录备份到 `.w2m-restore-backups/sessions-<UTC>/` 再替换，结果带 `replaced`；
- 媒体对象写到 `<DSH_HOME>/attachments/v1/objects/<ab>/<sha256>`，`files/` 条目写到
  `<DSH_HOME>/attachments/v1/files/<ab>/<digest>/<name>`；越界文件名拒绝并记入 `skipped`；
- 注册表写入复用 `src/backup/registry.mjs`，不另写一套。

`forceRunning` 在 `backup_restore` / `backup_import_session_zip` 上都只有这一个含义：**解决 `keepSessionIds` /
`keepIds` 的会话 id 冲突**。默认冲突即拒绝；显式 `forceRunning: true` 时先把已存在的会话目录备份到
`.w2m-restore-backups/sessions-<UTC>/` 再替换，并在结果里回报 `force_running` 与 `replaced`。两个工具都走
`src/backup/session-zip.mjs#writeSessionSet()` 的同一条实现，所以归档还原与官方 ZIP 导入的替换语义不可能分叉。
它**不**表示"停止 DSH 客户端"或"绕过注册表竞态"：注册表仍然走"计划 → 原子写 → 读回 → 报告残留风险"，
因为本实现没有任何办法阻止客户端用内存里的副本覆盖 `storages/workspace.json`。

## 5. 启用

只启用归档行（`dsh-backup` 保持关闭）：

```yaml
- id: dsh-backup-plugin
  name: '@twinsearth/w2m-dsh-plugin/dsh-backup-plugin'
  disabled: false
  config:
    backupRoot: 'D:\DeepSeekHarness\BackUP-Archives'
    includeProject: true
    includeSessions: true
    includeProfile: false
```

或者两行都启用（一个定时仓库 + 一个按需归档工具面，见 §2）。不需要任何 `backup_*` 工具时，两行都保持
`disabled: true`——这是安装后的默认状态。

## 6. 最小验证

```powershell
# 形状/接线：导出解析、两行默认值、工具定义、文档、tarball
node --test --test-force-exit test/backup-subplugin.test.mjs

# 端到端：status -> list -> create -> verify -> restore(plan/apply/confirm/overwrite) -> import 官方 ZIP
node --test --test-force-exit test/backup-subplugin-e2e.test.mjs

# 既有仓库行的接线不能被这次拆分弄坏
node --test --test-force-exit test/backup-wiring.test.mjs
```

端到端用例全部跑在临时目录里（临时 `DSH_HOME` + 临时项目 + 临时归档根），不碰真实的 home、真实的仓库和
真实注册表；官方 ZIP 由 `test/helpers/official-session-zip.mjs` 的独立 stored-ZIP 写入器生成，不复用生产写入器。

## 7. 边界

- **不复制**仓库布局、清单格式、加密信封：那些仍是 BACKUP-DESIGN 的协议，本文不改一个字。
- **不新增**第二条写盘实现：归档写 `backupRoot`，还原写目标项目/`$DSH_HOME`，导入写 `$DSH_HOME`，都走
  `src/backup/zip.mjs`、`session-zip.mjs`、`atomic.mjs` 这些被其它测试覆盖的底层。
- 归档是**明文** ZIP（按契约）；需要信封/账户绑定的场景是 `dsh-backup` 的 sealed 仓库，不是这个工具面。
- 导入/还原**默认不会修改已有会话**：只创建新 id 的目录；`keepIds`/`keepSessionIds` 冲突时拒绝而不是覆盖。
  唯一的替换路径是显式 `forceRunning: true`：先整目录备份到 `.w2m-restore-backups/sessions-<UTC>/`，再替换，
  并在结果里列出 `replaced`（见 §4.2）。
- 归档工具面没有定时器、没有状态文件、没有 catch-up：启用它不会在挂载路径启动任何扫描或写盘。

## 8. 演练/导入前后的注册表体检（强制）

备份演练、恢复、批量 import 会写 `$DSH_HOME`（会话、附件、workspace 注册表）。**不要手写
`storages/workspace.json`**：任何注册表变更都走 `src/backup/registry.mjs` 的读回协议；演练前后各跑一次体检：

```powershell
powershell -NoProfile -File tools\dsh-workspace-guard.ps1        # 只检查
powershell -NoProfile -File tools\dsh-workspace-guard.ps1 -Fix    # 先备份、停 DSH、自愈
```

自洽时输出 `consistent` 并返回 0；发现悬空 `workspaceIds` / 未列行 / 无效默认时返回 1，`-Fix` 备份后自愈，
重启客户端生效。完整规则与上游 issue 草稿见 [WORKSPACE-REGISTRY.md](WORKSPACE-REGISTRY.md)。

## 9. 归档面板与 surface 探测（3.5.6）

归档行不再只有工具：它挂六条面板路由 `GET /api/w2m/backup/archive/status`、`POST …/create`、`POST …/verify`、
`POST …/restore`、`POST …/import-zip`、`GET …/health`，路由与六个 `backup_*` 工具**共用同一组 runner**
（`runListArchives` / `runCreateArchive` / `runVerifyArchive` / `runRestoreArchive` / `runImportSessionZip`），
所以"面板做的"与"Agent 调工具做的"是同一份实现。UI 上它是「备份&还原」面板里的**「归档」tab**，不新增第四个侧边栏按钮；
恢复仍要求 `confirm:"restore"`，覆盖前仍有 pre-restore 副本。

同一版本里，三个 UI 行（backup / gpw / desktop）各有一个只读 `GET /api/w2m/<row>/health`。客户端启动时并发探测，
只有答 200（或 401 = 需要授权但已挂载）的 surface 才注册侧边栏/main 条目；页面可见时每 30 s 与 `visibilitychange`
复探，按差分注册/注销。**四个探测全失败时回退到旧行为**（全部注册，面板内提示未启用），并把
`window.__W2M_SURFACES__` 留在页面上供排障。

