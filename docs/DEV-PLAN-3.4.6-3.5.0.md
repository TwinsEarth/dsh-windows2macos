# w2m 开发计划：v3.4.6 → v3.5.0

> 状态：**计划已评审，Q1/Q3 已定；开工范围=先做只读勘察脚本（已完成，见 §14）**。
> 基线：`E:\GPT\w2m\w2m-345-fresh`，分支 `work/v3.4.5`，commit `b6e2e3e`，版本 3.4.5。
> 主题：新增「全局会话备份&还原」子插件（左侧边栏按钮 + 独立操作面板），并把版本治理、Relay Phase 2 收口到 v3.5.0 里程碑。

---

## 0. 需求原文与验收映射

| # | 用户要求 | 落地版本 | 验收证据 |
|---|---|---|---|
| 1 | D 盘新建 `D:\DeepSeekHarness\BackUP` | v3.4.6 | 仓库目录自检（缺失即创建、无权限即明确报错） |
| 2 | 每天定时（默认 22:00，可自行更改）全量会话备份 | v3.4.7 | 调度器单测（含时区/唤醒补偿）+ 真实定时触发记录 |
| 3 | 新旧对比、新覆盖旧，旧版本迁移到 `BackUP\old`，按会话分类 | v3.4.7 | 轮转单测（同会话多版本、内容未变不轮转）+ 目录结构断言 |
| 4.1 | 一键备份选中会话 / 一键备份所有当前活动会话 | v3.4.9 | 面板端到端（真实 Chromium + 真实宿主路由） |
| 4.2 | 一键还原选中会话 | v3.4.8（引擎）+ v3.4.9（按钮） | 还原后会话可在 DSH 中正常打开、事件完整 |
| 4.3 | 一键打包压缩备份所有已归档会话 | v3.4.8（打包引擎）+ v3.4.9（按钮） | `.tar.zst` 可解压、可校验、可还原 |
| 5 | 自研文件列表/协议/文件系统（联网参考主流路线） | v3.4.6 | `docs/BACKUP-DESIGN.md` 协议冻结 + 单测 |
| 5.1 | 数据全面完整备份 | v3.4.6–v3.4.8 | 会话日志 + 附件 + 工作区索引全覆盖；排除项逐条写明理由 |
| 5.2 | 能完整还原并正常使用 | v3.4.8 | 还原后 `workspace.json` 注册、归档/置顶状态恢复、DSH 能打开 |
| 5.3 | 安全：非原账户用户无法打开/导入，提示没有权限 | v3.4.6（加密）+ v3.4.8（解锁） | 错误账户/错误密码 → `BACKUP_NO_PERMISSION`；篡改检测通过 |

---

## 1. 版本总览

| 版本 | 主题 | 主要交付 | 出口标准（摘要） |
|---|---|---|---|
| **v3.4.6** | 备份地基 + 协议冻结 | `docs/BACKUP-DESIGN.md`、`src/backup/`（layout/scan/manifest/crypto/repo）、只读 CLI 与只读路由、层模型与测试接线；顺带修掉负载敏感的计时用例 | 协议文档 + 只读扫描能列出全部会话/归档状态；加密原语单测通过；preflight GREEN |
| **v3.4.7** | 备份引擎 + 定时 + 轮转 | `engine.mjs`（快照/去重/原子写/锁）、`schedule`（默认 22:00 可改）、`rotation.mjs`（old/ 按会话）、CLI `run/list/verify` | 连续两次备份第二次几乎零新增；会话变更触发 old/ 轮转；定时到点自动备份 |
| **v3.4.8** | 还原 + 解锁 + 归档打包 | `restore.mjs`（含还原前快照）、`unlock.mjs`（账户 / 密码双路径）、`verify.mjs`（全量校验）、`archive.mjs`（`.tar.zst`） | 错误身份/密码被拒；还原后会话可打开；归档包可解压还原 |
| **v3.4.9** | 面板与侧边栏按钮 | `sidebar.panellist` + `main` 面板页、四类一键操作、解锁对话框、进度与错误态、i18n/主题 | 真实 Chromium 中按钮出现、面板可用、四类操作跑通、错误态可见 |
| **v3.5.0** | 版本治理 + Phase 2 + 备份增强（里程碑） | 最低版本门禁（低于基线拒绝派发并具名报错）、版本漂移面板、Relay Phase 2（chat/project 同步）合并评审、备份异地/保留策略 | 门禁真实拒绝一台旧机器；Phase 2 合入且 cluster 集成测试通过；备份策略可配置并有审计记录 |

---

## 2. 备份数据范围（“全面完整”的边界，逐条写明）

### 2.1 必须备份（v3.4.6 起）

| 数据 | 路径 | 说明 |
|---|---|---|
| 会话日志 | `$DSH_HOME/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd` | **唯一事实来源**；一个会话一个文件（本机实测 14 个，合计 ≈172 MB，最大 113.8 MB） |
| 会话附件 | `$DSH_HOME/attachments/v1/objects/**` | 事件里引用的图片等二进制对象，按内容哈希存放；漏掉它会导致历史里图片永久丢失（v3.4.5 的 dsh-fix 正是为这类故障而生） |
| 工作区索引 | `$DSH_HOME/storages/workspace.json` | 工作区路径/标题、`sessionIds`、`archivedSessionIds`、`pinnedSessionIds`；**不备份它，还原出来的会话在 DSH 里“看不见”** |

### 2.2 明确不备份（并在文档中写清理由）

| 数据 | 理由 |
|---|---|
| `$DSH_HOME/.credentials.yaml` | 账号凭据。备份它等于把令牌复制到 D 盘；恢复时也不应回写 |
| `$DSH_HOME/storages/session_projcache/**` | 派生缓存，可从会话日志重建；备份它是浪费空间与新的一致性风险 |
| `$DSH_HOME/sessions/.event-cache/**` | 同上，派生索引 |
| 工作区里的用户项目文件（如 `E:\GPT`） | 不属于会话数据，体积不可控；默认不纳入。若将来要支持，作为独立开关（不在本计划五版范围内） |
| `$DSH_HOME/xclient/**`（w2m 自身状态） | 属于插件运行状态（设备令牌等），不进入会话备份；备份配置单独存放 |

> 结论：**“全会话”= 会话日志 + 附件 + 工作区索引**。这三样齐了，DSH 才能“打开、继续、回放”一个会话。

---

## 3. 文件协议与文件系统设计（自研，参考主流路线）

### 3.1 参考路线（联网核对，取其设计原则而非抄实现）

| 方案 | 采用其什么 | 不采用什么 |
|---|---|---|
| [restic](https://restic.readthedocs.io/en/v0.5.0/Design/) | 内容寻址 pack 文件、每对象 `IV‖密文‖MAC` 的 AEAD 结构、快照=JSON 清单、多密码可解同一仓库 | 自定义 pack 头部格式、Rabin 分块多项式（会话日志用固定 4 MiB 边界已够） |
| [borgbackup](https://deepwiki.com/borgbackup/borg/2-core-architecture) | 仓库/归档/清单三层概念、去重块索引 | 其段文件与事务日志的复杂度 |
| [kopia](https://kopia.io/docs/features/) | 快照=时间点记录、按内容哈希去重、滚动哈希只对超大文件有意义 | 多命名空间与云后端 |
| [age](https://github.com/sthagen/FiloSottile-age/blob/main/scrypt.go) | scrypt 口令派生 KEK 的形态与“口令模式只能作为唯一收件人”的约束 | age 文件容器本身（我们自描述 JSON 头更利于还原诊断） |

### 3.2 仓库目录（`D:\DeepSeekHarness\BackUP`）

```
D:\DeepSeekHarness\BackUP\
  repo.json                          # 仓库身份、格式版本、KDF 参数（salt/N/r/p）、密钥信封列表
  keys\
    account.json                     # 主密钥的“账户信封”（账户 KEK 包裹）
    password.json                    # 主密钥的“口令信封”（scrypt KEK 包裹）
  objects\<aa>\<sha256>              # 内容寻址块（4 MiB 边界切分），AEAD 加密
  snapshots\<snapshotId>\manifest.json # 该次快照的会话清单（加密；含每会话文件哈希、块列表、大小）
  index.jsonl                        # 追加式索引：snapshot → session → file → chunks（加密行）
  current\                           # “当前视图”：每会话一行指针，便于人工排查
    <workspace-slug>\<session-id>.json
  old\                               # 需求 3：旧版本，按会话分类
    <workspace-slug>\<session-id>\<yyyyMMddTHHmmssZ>-<sha256前12>.zst.enc
  archive\                           # 需求 4.3：已归档会话打包
    <yyyyMMdd>\archived-sessions-<yyyyMMddTHHmmssZ>.tar.zst
  locks\run.lock                     # 单实例备份锁（含 pid/主机/开始时间）
  logs\backup-<yyyyMM>.jsonl         # 结构化运行日志（不含明文内容）
```

**分层含义**：

1. **内容层 `objects/`**：唯一权威数据，内容寻址 + 去重 + AEAD；同一块跨快照只存一次（114 MB 日志每天全量重写不可接受）。
2. **快照层 `snapshots/`**：一次备份 = 一份清单，记录“这次有哪些会话、每个文件的块列表”。
3. **视图层 `current/` + `old/`**：满足“新覆盖旧、旧版本按会话分类”的人工可见语义；`old/` 存的是上一个版本会话文件的加密副本，因此既是历史备份，也是人工可点开的目录。
4. **打包层 `archive/`**：只对“已归档会话”做归档压缩包，供离线搬运。

### 3.3 关键文件字段（协议 v1，冻结于 v3.4.6）

`repo.json`：

```json
{
  "format": "w2m-session-backup/v1",
  "repo_id": "<uuid>",
  "created_at_ms": 1794900000000,
  "home": "C:\\Users\\fangw\\.dsh",
  "kdf": { "kind": "scrypt", "salt_b64": "...", "N": 131072, "r": 8, "p": 1 },
  "wraps": [
    { "kind": "account", "file": "keys/account.json", "key_id": "<sha256 前 16>" },
    { "kind": "password", "file": "keys/password.json", "created_at_ms": 1794900000000 }
  ],
  "limits": { "chunk_bytes": 4194304, "keep_old_per_session": 10 }
}
```

`snapshots/<id>/manifest.json`（加密后落盘）：

```json
{
  "format": "w2m-session-backup/v1",
  "snapshot_id": "20261117T140000Z-<rand8>",
  "created_at_ms": 1794900000000,
  "trigger": "schedule|manual-selected|manual-active|archive",
  "sessions": [
    { "session_id": "session-...", "workspace": "E:\\GPT", "title": "…",
      "log": { "size": 1234, "sha256": "…", "chunks": ["<hash>", "…"] },
      "attachments": ["<sha256>", "…"],
      "workspace_flags": { "archived": true, "pinned": false } }
  ],
  "workspace_index": { "sha256": "…", "chunks": ["…"] }
}
```

加密对象落盘格式（`objects/…`）：`"W2MB1" ‖ iv(12B) ‖ 密文 ‖ tag(16B)`，AAD = `format‖sha256‖长度`，任一字节改动都会在解密时失败。

---

## 4. 加密与权限设计（需求 5.3）

- **主密钥（MK）**：建库时随机 32 字节，永不落盘明文。
- **两种信封（二选一即可解锁）**：
  1. `account`：`KEK = HKDF-SHA256(账户材料, repo salt)`；账户材料来自 DSH 当前登录账号（实现方式待 v3.4.6 落地核验，见 §11 决策 Q1）。
  2. `password`：`KEK = scrypt(用户密码, salt, N=2^17, r=8, p=1)`；与 age 的口令模式同一取值区间（≈256 MiB 内存、约 1 秒 CPU）；密码只存在于用户脑中和 DSH 进程内存，不落盘。
- **信封**：`AES-256-GCM(KEK, MK)`，写入 `keys/account.json` / `keys/password.json`。
- **解锁判定**：
  - 当前账户与仓库登记账户一致 → 自动解封（“原账户登录”路径，无提示）；
  - 否则弹出解锁对话框，要求输入解锁密码；
  - 两者都失败 → 明确拒绝：`BACKUP_NO_PERMISSION`，中文提示「没有权限：请用原账户登录，或输入建库时设置的解锁密码」，**不写入任何明文、不回退到“忽略加密”**。
- **完整性**：还原前对每个块重算 SHA-256 并与清单比对；不匹配即 `BACKUP_TAMPERED` 并拒绝还原。
- **不备份凭据**：`.credentials.yaml` 永不出现在仓库中（有单测断言）。

---

## 5. 调度、并发与故障处理

- **默认**：每天 22:00（`Asia/Shanghai`），配置 `backupTimes: ["22:00:00"]`、`backupTimeZone: "Asia/Shanghai"`，可多时段（复用 `src/plugin/schedule.mjs` 的 `createDailyScheduler`，与自动更新同一套“错过时段只在唤醒后补跑一次”的语义）。
- **触发方式**：定时 / 面板手动（选中、全部活动、归档打包）共用同一引擎；引擎串行，`locks/run.lock` 防止两个进程同时写。
- **原子性**：块先落临时文件再 rename；清单最后写；崩溃后残留 tmp 目录在下次启动被清理（含单测）。
- **磁盘满 / 目录无权限**：明确错误码（`BACKUP_DISK_FULL` / `BACKUP_DIR_DENIED`），面板显示中文可操作提示，不吞异常。
- **会话正在写入**：备份读取时按“已提交帧”边界读取（复用 `src/fix/zstd.mjs` 的 `scanFrames`），不等待、不阻塞、不修改源文件。

---

## 6. UI 设计（需求 4，v3.4.9）

- **入口**：左侧边栏按钮（`sidebar.panellist`，`id: w2m-backup`，`order` 排在 GPW 之后），图标 + 文案「备份&还原」。
- **面板**：`main` 槽位页（`key: w2m-backup`，必须与侧边栏 id 一致——这是 w2m 已在 GPW 上验证过的写法）。
- **面板结构**：
  1. 顶部状态条：仓库路径、上次备份时间/结果、加密状态、下次计划时间、「立即全量备份」主按钮；
  2. 计划卡片：时间编辑（默认 22:00）、启用开关、时区显示；
  3. 会话列表（分「活动会话」「已归档会话」两个 tab）：标题、工作区、大小、最后备份、勾选框；
  4. 操作区（需求 4.1–4.3）：
     - `备份选中会话`
     - `备份所有当前活动会话`
     - `还原选中会话`（还原前自动生成一份“还原前快照”，失败可回滚）
     - `打包压缩所有已归档会话`（产出 `archive/*.tar.zst`，完成后给出路径与大小）
  5. 解锁对话框：两个选项——`原账户登录`（自动尝试）/ `输入解锁密码`；失败显示「没有权限」；
  6. 运行日志：最近 20 条（时间、动作、结果、字节数），错误可展开详情；
  7. 危险操作二次确认（还原、清空 old/ 历史）。
- **规范**：文案全部走客户端 locale 字典（中英），颜色只用 `--dsw-alias-*` 主题令牌，不读写其它插件 DOM，不在 `document.body` 追加应用根。

---

## 7. 各版本详细计划

### v3.4.6 — 备份地基与协议冻结

**目标**：先把「文件清单 + 协议 + 加密原语 + 只读勘察」钉死，避免后面边写边改格式。

**交付**
1. `docs/BACKUP-DESIGN.md`：本计划 §2–§5 的完整体（含字段表、错误码表、排除项理由、版本兼容承诺）。
2. `src/backup/layout.mjs`：仓库路径解析与创建（默认 `D:\DeepSeekHarness\BackUP`，可配置 `backupDir`）；无权限/盘符不存在 → 具名错误。
3. `src/backup/scan.mjs`：枚举 `sessions/**` 与 `attachments/**`，读 `workspace.json` 得到 活动/归档/置顶 标记；**只读**。
4. `src/backup/manifest.mjs`：清单 schema、哈希与块切分（4 MiB）、路径规范化（大小写/分隔符）。
5. `src/backup/crypto.mjs`：scrypt/HKDF KDF、AES-256-GCM 封包、三信封（account/machine/password，包裹同一个随机 DEK）、AAD 绑定、篡改检测与 `selftest`。**spike 后默认组合 = machine + password**（`docs/SPIKE-ACCOUNT-KEK.md`）。
6. `src/backup/repo.mjs`：快照 id（`YYYYMMDDTHHMMSSZ-<8 hex>`，字典序即时间序）、快照两文件（`manifest.json`/`keys.json`）、`index.jsonl` 行格式（只有计数与摘要，不含路径）、`commitSnapshot` 原语（staging → rename → append → 回读校验）、`openRepo` 只读状态；status 路由与 CLI 共用同一份状态。**协议冻结的一半在 manifest，另一半在 index。**
7. `src/queue-journal` 之外新增只读路由 `/api/w2m/backup/status`、`/api/w2m/backup/scan`（不写盘）。
8. CLI 骨架 `bin/w2m-backup.mjs`：`status`、`scan`、`selftest`（加密自检）。
9. **顺带修债（已完成 2026-11-17）**：把 `test/agent.test.mjs`「transport re-delivery from cache」的 15s 默认预算改为按事件条件 + 60s 预算（`rabbit.stream(60_000)` 与三个 `waitFor` 显式 60s；不停表、不加 sleep）。实测：满载全量套件曾需要 ~22s 而红，隔离运行 ~3.0s。
10. 接线：`scripts/layer-model.mjs` 增加 `backup` 层（rank 1，capability）与三条向下边（`plugin -> backup`、`backup -> fix`、`backup -> util`）；`package.json#scripts.test` 与 `test:all` 加 6 个 `test/backup-*.test.mjs` 并各配一条 `test:backup-*` 命名脚本；`package.json#bin` 加 `w2m-backup`。**偏差（2026-11-17 实施记录）**：原计划在 `cordis.patch.yml` 增加默认 `disabled: true` 的 `dsh-backup` 行，实际推迟到 v3.4.7 —— v3.4.6 只有只读路由与只读 CLI，没有需要关掉的副作用；一个默认关闭的子插件行会让状态卡片在默认配置下直接报未启用，把可用功能藏起来。等引擎/定时器开始可能写盘时再引入（见 `docs/BACKUP-DESIGN.md` §10）。

**测试**：`test/backup-layout.test.mjs`、`test/backup-scan.test.mjs`、`test/backup-crypto.test.mjs`（含“错误密码/错误账户/篡改一字节”三态）、`test/backup-protocol.test.mjs`（清单字段与版本号冻结）、`test/backup-repo.test.mjs`（快照 id/索引行/提交与回读/只读打开）、`test/backup-wiring.test.mjs`（导出/行/CLI 存在）。

**验收**：本机真实 `$DSH_HOME` 扫描出 **15 个会话 / 166.3 MiB**、归档 4 / 置顶 4 / 未注册 2（2026-11-17 实测）；`w2m-backup status` 对尚未创建的 `D:\DeepSeekHarness\BackUP` 报告未初始化且**不创建它**；`w2m-backup selftest` 9 步全绿；`scan --manifest` 在内存里得到 54 个块并给出摘要（不写盘）；preflight 在 **空 `DSH_HOME`** 下 GREEN。

### v3.4.7 — 备份引擎、定时与旧版本轮转

**交付**
1. `src/backup/engine.mjs`：`backup({ scope })`，scope = `all | active | selected | archived`；读日志 → 切块 → 去重（已存在块不再写）→ 加密落盘 → 写清单 → 更新 `current/` → 更新 `index.jsonl`。
2. `src/backup/rotation.mjs`：内容哈希与 `current/` 不一致时，把上一版会话文件复制到 `old/<ws>/<sid>/<ts>-<sha12>.zst.enc`，保留 `keep_old_per_session`（默认 10）份；内容未变则不轮转（避免每天制造 114 MB 冗余）。
3. `src/backup/schedule.mjs`：默认 22:00 的每日备份，配置项 `backupTimes`/`backupTimeZone`/`backupEnabled`；启动后按 `ctx.effect` 拥有定时器，卸载即清理。
4. `src/backup/gc.mjs`：旧版/孤儿块清理策略（按保留份数与引用计数，默认只清无引用块）。
5. CLI：`run --scope all|active`、`list`、`gc`。
6. 路由：`POST /api/w2m/backup/run`（受面板调用；带 scope 与确认令牌）。

**测试**：增量（第二次备份新增块≈0）、轮转（3 次改动 → old/ 3 个文件、未改动不轮转）、并发锁（两进程→第二个被拒）、磁盘满/只读目录错误码、定时器（注入 fake clock 到 22:00 触发一次、睡眠跨时段只补跑一次）。

**验收**：真实 D 盘仓库跑一次全量（含 113.8 MB 会话），记录耗时/新增块数/仓库体积；再跑一次，新增块≈0；改一个会话后再跑，`old/` 出现 1 个旧版本文件。

> **2026-11-17 实测（默认路径 `D:\DeepSeekHarness\BackUP`）**：首备 16 文件 / 168.7 MB / 54 块 / 4.8 s（`machine`/DPAPI 解锁）；再备 1 新块 + 53 复用（98%）/ 2.0 s，新增的那 1 块来自两次运行之间仍在写入的当前会话，并因此产生 1 条 old 记录；`gc --dry-run` 引用 55 块、0 误删；`status` 报 2 快照 / 1 旧版本 / 剩余 171.7 GB。

**实施记录（2026-11-17，v3.4.7 落地）**

- 交付面：`engine` / `keystore` / `machine-key` / `locks` / `atomic` / `rotation` / `gc` / `schedule`，加 `src/plugin/backup.mjs` + `lib/backup.js` 子插件、`dsh-backup` 行（`disabled: true`）、`POST /api/w2m/backup/run`、CLI `run` / `list` / `gc`；时区算术抽到 `src/util/daily-clock.mjs` 复用。
- **两处与计划的偏差（均已写进设计文档并记录理由）**：① `old/` 存**可还原记录** `<ts>-<sha12>.json` 而不是整文件 `.zst.enc` 副本——副本会与内容寻址去重重复存储，114 MB 会话的十份窗口会膨胀到 GB 级；② DEK 是**仓库级**的（权威 `<root>/keys.json`，快照存副本），不是每快照一把——否则跨快照的块无法复用，第二次备份会重写整份会话。
- 无人值守凭据边界：定时任务只走 `machine`（DPAPI）信封；无 OS keystore 的平台具名拒绝 `BACKUP_NO_PERMISSION`，人工路径是 `w2m-backup run --password-stdin`。密码不入配置、不入 argv。
- 实测（本机真实 `$DSH_HOME`，临时 D 盘仓库）：首备写入块数 > 0；第二次未改动 `blocks_new = 0`、`dedupe_ratio = 1`；追加事件后再备只新增 1 块并记 1 条 old 记录；`gc` 引用齐全、零误删。
- **复盘后加固（同日）**：可还原性单测（块解回 + 逐字节比对）、崩溃遗留块复用、轮转失败如实报 `committed`、活会话截断检测与重读、gc 持锁与崩溃残留清理、密码种子仓库自动追加 machine 信封；新增 atomic/keystore/machine-key 三个套件（含真实 DPAPI round-trip）。备份侧共 15 套件 / 210 项。

### v3.4.8 — 还原、解锁与归档打包

**交付**
1. `src/backup/restore.mjs`：按快照/按会话还原；还原前对目标会话目录做 `.bak-<ts>` 快照；写回 `session.v4.jsonl.zstd`（原子 rename）→ 更新 `workspace.json`（注册 sessionId、恢复 archived/pinned）→ 附件对象补回；冲突（目标已存在不同内容）默认“先备份后覆盖”，或 `--keep-both`。
2. `src/backup/unlock.mjs`：解锁路径 **machine（Windows DPAPI，同机免密）/ password（唯一保证）**，`account` 为可选第三路径；失败 `BACKUP_NO_PERMISSION`；换机或清空本机材料时只能走密码，并在 UI 明示。macOS 在 keychain 补齐前只有密码路径。
3. `src/backup/verify.mjs`：全量校验（块哈希 + 清单链 + 附件引用完整性）；输出可读报告。
4. `src/backup/archive.mjs`：对“已归档会话”生成 `archive/<date>/archived-sessions-<ts>.tar.zst`；包内自带 `manifest.json`（可单独还原），解包即得会话文件树。
5. CLI：`restore --session/--snapshot`、`verify`、`archive`、`unlock --password-stdin`（密码只经 stdin/env，不进 argv）。
6. 路由：`POST /api/w2m/backup/restore`、`POST /api/w2m/backup/archive`、`POST /api/w2m/backup/unlock`。

**测试**：还原后可被 DSH 正常读取（用 `src/fix/session.mjs` 的 `readSession` 验证事件数与标题）；错误密码/错误账户/篡改 → 三个具名拒绝；`--keep-both` 冲突态；归档包解压后目录与清单一致；还原幂等（连续两次还原同一快照结果相同）。

**验收**：在一台干净 `DSH_HOME`（空目录）里还原 1 个会话 + 1 个归档包，DSH 重启后能在侧边栏看到并打开该会话。

### v3.4.9 — 面板、侧边栏按钮与端到端

**交付**
1. `lib/client.js` 新增「备份&还原」面板（`sidebar.panellist` + `main`，与 GPW 同构）：状态条、计划卡片、会话列表与勾选、四个一键操作、解锁对话框、日志区、危险确认。
2. locale 字典（中/英）与错误码到文案的映射（含 `BACKUP_NO_PERMISSION` =「没有权限：请用原账户登录，或输入解锁密码」）。
3. 客户端 store：轮询/事件刷新状态；操作期间按钮禁用与进度；失败可重试。
4. `test/client-bundle.test.mjs` 静态断言（panel id、四类操作、解锁双选项、i18n 键）；`test/loader-entry.test.mjs` 真实 Chromium 端到端（按钮可见、点击打开面板、四类操作各跑一次只读/可回滚样本）。

**验收**：真实页面截图级验证（按钮在左侧边栏、面板可操作），四类操作全部成功；错误态（错误密码、磁盘满模拟）有明确中文提示；`npm test` 全绿；preflight GREEN。

### v3.5.0 — 版本治理、Phase 2 与备份增强（里程碑）

**交付**
1. **最低版本门禁**：`MIN_SUPPORTED_PLUGIN_VERSION`（3.5.0 起生效）；`w2m_run` 对低于基线的机器返回 `MACHINE_VERSION_UNSUPPORTED`（默认拒绝，可用 `allowOutdated: true` 显式覆盖并记录审计）；面板/`w2m_devices` 展示漂移清单。
2. **版本漂移看板**：面板新增「编队版本」卡片（stock 版本分布、落后机器、一键复制升级指引）。
3. **Relay Phase 2 合并**：从 `wip/relay-phase2-20261117` 评审并合入 chat/project 同步（`chat-store.mjs`、`project-sync.mjs`、cluster 域扩展），配套三节点集成测试与滚动升级手册。
4. **备份增强**：保留策略可配置（保留份数/天数）、仓库自检（启动时 verify 抽样）、可选“异地副本”（先支持网络盘/SMB，Relay 传输留作 Phase 3）。
5. **协议承诺**：`w2m-session-backup/v1` 冻结；v2 变更规则（只增字段、旧版可读新库则拒绝）。

**验收**：门禁真实拒绝一台 3.4.5 机器（`MACHINE_VERSION_UNSUPPORTED`），覆盖开关生效；Phase 2 三节点集成 2/2；备份保留策略生效并有审计日志；全量套件 + preflight GREEN；三方发布（GitHub Release / npm / 本机）字节一致。

---

## 8. 每个版本的 Definition of Done（统一清单）

1. 版本号 6 处同步（`package.json`、`plugin.json`、`.claude-plugin/*`、`codex/mcp-servers.toml`、`README.md`）；
2. `CHANGELOG.md` 顶部条目 + 变更理由；
3. 新增模块进 `scripts/layer-model.mjs`，`scripts/layer-check.mjs` 通过；
4. 新增测试文件进 `package.json#scripts.test`，`ci.yml`/`release.yml` 自动覆盖（不手写清单）；
5. `docs/acceptance/<version>/RELEASE-<xxxx>.json` 证据记录（真实命令 + 断言 + 制品 sha256）；
6. 文档同步（`docs/BACKUP-DESIGN.md`、`docs/DEV-PLAN-3.4.6-3.5.0.md`、README/deep-dive 入口）；
7. `node scripts/preflight.mjs` 在 **空 `DSH_HOME` + Node 22** 下 GREEN（避免历史上“本机绿、CI 红”的环境泄漏）；
8. 打包字节一致性：`node scripts/pack.mjs` 两次打包 sha256 相同，且与 GitHub Release 资产、npm tarball 一致；
9. 无明文凭据、无 mojibake、`git status` 干净；
10. 发布审批：GitHub Release（Stable environment）+ npm `stage publish` + 2FA 批准。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 单文件 `lib/client.js`（≈385 KB）继续膨胀 | 面板加入后易到 500 KB+，加载与回归成本上升 | 3.4.9 只加必要组件；把“备份面板”与既有 GPW/队列面板共用 DOM/样式工具函数；预留 v3.6 拆分 client bundle 的评估 |
| 账户身份来源不明确（Q1） | 5.3 的“原账户登录”路径可能落空 | v3.4.6 先做账户材料核验 spike；不可得则**默认密码模式**并在 UI 隐藏账户选项，文档写明边界 |
| 114 MB 会话 + 每日全量 | 磁盘与耗时不可控 | 内容寻址去重（块级）+ 只备份变化文件 + `keep_old_per_session` 上限 + `gc` |
| 会话正在写入时备份 | 读到半个帧 | 只读已提交帧（`scanFrames` 容错），不修改源文件；备份前后哈希对比 |
| 还原误覆盖用户当前会话 | 数据损失 | 还原前自动 `.bak-<ts>` + 面板二次确认 + `--keep-both` |
| 加密实现错误导致“自己也打不开” | 灾难性 | v3.4.6 起每个加密改动都跑“封包→解包→明文一致”往返单测；建库后立即写一份自检快照并 restore 验证 |
| 与 dsh-fix 备份机制重复 | 两套会话写盘路径 | 复用 `src/fix/zstd.mjs`/`session.mjs` 的帧读写；dsh-fix 负责“事件级修复”，backup 负责“整文件备份”，文档划清边界 |

---

## 10. 依赖与顺序

```
v3.4.6 协议+加密+扫描 ──▶ v3.4.7 引擎/定时/轮转 ──▶ v3.4.8 还原/解锁/打包 ──▶ v3.4.9 面板/端到端
                                                                                      │
                                              v3.5.0 版本治理 + Phase2 + 备份增强 ◀──┘
```

- v3.4.6 的协议冻结是硬前置：后续版本不得改字段语义，只能加字段；
- v3.4.9 依赖 v3.4.7/3.4.8 的路由与引擎（只调 API，不内嵌逻辑）；
- v3.5.0 可与 v3.4.8/3.4.9 并行准备（Phase 2 评审不阻塞备份线）。

---

## 11. 待用户决策（开工前需要确认）

> 2026-11-17 已确认：**Q1 = A**（账户派生 KEK 优先，不可得退回密码模式）；**Q3 = B**（加密 + 可选明文镜像，默认关、开启需二次确认）；**开工范围 = 先做只读勘察脚本**（已完成，见 §14）。

| # | 决策点 | 选项 | 结论 |
|---|---|---|---|
| Q1 | “原账户登录”的判定来源 | A DSH 登录账户派生；B w2m 编队账户；C 仅密码 | ✅ **A 优先，C 兜底**（v3.4.6 spike 核验可得性） |
| Q2 | 是否备份工作区项目文件 | A 不备份；B 可配置额外目录 | 默认 **A**（§2.2） |
| Q3 | 加密是否强制 | A 强制加密；B 加密 + 可选明文镜像 | ✅ **B**：默认加密；明文镜像默认关，开启需二次确认 |
| Q4 | `old/` 保留策略 | A 每会话 10 份；B 30 天；C 无限 | 默认 **A + 可配置** |
| Q5 | “已归档会话”的判定 | A `workspace.json#archivedSessionIds`；B 30 天无活动；C A∪B | 默认 **A** |
| Q6 | 备份是否走 Relay 异地 | A v3.5.0 仅本地/网络盘；B 增加 Relay 传输 | **A**（Phase 3 再议） |
| Q7 | 定时默认时间 | A 22:00；B 22:00+03:00 | **A**（可自行更改） |

> **2026-11-17 spike 对 Q1 的更正**：DSH 只提供账户**标识** `userId`（仅内存、需联网、需一次成功的 `getProfile`），磁盘没有稳定账户秘密；只用标识派生 KEK 不构成机密性。因此 v3.4.7 起默认信封组合为 **machine（Windows DPAPI，同机免密）+ password（scrypt，唯一保证）**，`account` 降级为可选，且启用前必须先修 `getProfile(client)` 调用并做宿主内实测。详见 `docs/SPIKE-ACCOUNT-KEK.md` 与 `docs/BACKUP-DESIGN.md` §6。

---

## 12. 附录：本次勘察得到的事实（可作为实现依据）

- 会话存储：`$DSH_HOME/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`；首事件是 `session` 信封（`id/cwd/createdAt/agentPreset`），其后事件为 `{type, seq, time, data}`；本机 14 个会话、合计 ≈172 MB、最大 113.8 MB。
- 工作区索引：`$DSH_HOME/storages/workspace.json`（含 `workspaceIds`/`archivedSessionIds`/`pinnedSessionIds` 与每工作区 `sessionIds`）。
- 附件：`$DSH_HOME/attachments/v1/objects/**`（内容寻址）。
- 派生缓存（不备份）：`$DSH_HOME/storages/session_projcache/**`、`$DSH_HOME/sessions/.event-cache/**`。
- UI 槽位（DSH 源码 `packages/client/*` 核对）：左侧边栏按钮 = `sidebar.panellist`（list, root）；独立面板页 = `main`（key 必须等于 panellist 的 id）。w2m 已在 GPW 上用过这一对（`lib/client.js` 的 `w2m-gpw`），备份面板照此实现。
- 定时能力：`src/plugin/schedule.mjs` 的 `createDailyScheduler`（时区、唤醒补偿、`ctx.effect` 拥有定时器），备份计划直接复用。
- 帧读写能力：`src/fix/zstd.mjs`（`scanFrames`/`compressFrame`/`hasZstd`）、`src/fix/session.mjs`（`pickSessionFile`/`listSessionDirs`/`readSession`/`objectPath`），备份/还原复用同一实现，避免两套解析。
- 发布纪律：`scripts/preflight.mjs` 16 项检查（含 mojibake、packed tarball、claims、workflow wiring、layer model）；验收证据目录 `docs/acceptance/<version>/`；`test/claims.test.mjs` 校验版本号与 CHANGELOG 一致。

## 13. 参考资料（外部）

- restic 设计文档（对象/快照/打包与 AEAD 结构）：https://restic.readthedocs.io/en/v0.5.0/Design/
- borg 架构（仓库/归档/分块）：https://deepwiki.com/borgbackup/borg/2-core-architecture
- kopia 快照与内容寻址：https://kopia.io/docs/features/
- age 口令模式（scrypt 参数与“唯一收件人”约束）：https://github.com/sthagen/FiloSottile-age/blob/main/scrypt.go
- age 规范：https://age-encryption.org/v1

---

## 14. 只读勘察结果（2026-11-17，本机真实数据）

工具：`E:\GPT\w2m\survey\survey-backup.mjs`（只读：不写备份仓库、不改仓库代码；凭据只读结构不读值）。
报告：`E:\GPT\w2m\survey\out\report.md`、`E:\GPT\w2m\survey\out\inventory.json`。

### 14.1 事实

| 项 | 实测值 |
|---|---|
| 会话数 | **14**（已注册 13，**未注册 1**） |
| 会话日志总量 | **172.0 MB**（最大单会话 114.1 MB） |
| 跨会话去重 | **0%**（52 个 4 MiB 块，全部唯一——不同会话内容本就不重复） |
| 跨版本可复用（同会话 append-only） | **153.8 MB / 172.0 MB**（除尾部块外都可复用） |
| 每日新增（模型估算） | 追加 10% ≈ **35.5 MB**；追加 50% ≈ 104.3 MB；内容重写仅尾部 ≈ 18.2 MB |
| 附件 | **1** 个对象 / **0.1 MB** |
| 归档 / 置顶 | 归档 **5** / 置顶 **4** |
| 备份盘 | `D:` 可用 **185,510 MB** / 总 751,629 MB；`D:\DeepSeekHarness\BackUP` **不存在**（v3.4.6 首次运行创建） |
| 容器估算 | 首份全量 ≈ **172.1 MB**；保留 10 份旧版本 ≈ **527 MB**；一年 ≈ **13.1 GB**（D 盘足够） |
| 账户材料候选 | `.credentials.yaml`（805 B，keys=`version,records,refs`）、`.anonymous-user-id`（37 B）、`xclient/device.json`+`device.key`、`fang/desktop/fang-auth.json`（keys=`token,createdAt`） |

### 14.2 对设计的直接影响

1. **去重发生在“同一会话的历史版本之间”，不是会话之间**：设计必须按会话文件哈希判定“未变则跳过”，并按块级内容寻址复用历史块；否则每天会重写 114 MB。
2. **存在未注册会话**（`session-e4350615…`，在默认工作区目录下、`archived=true` 却不在 `workspace.json`）：还原逻辑必须支持“补注册工作区 + 恢复归档标记”，否则还原后在 DSH 里看不见。这条已写进 §7 v3.4.8 验收。
3. **附件体量极小（0.1 MB）但不可省略**：删除附件对象正是 dsh-fix 存在的理由，备份必须包含 `attachments/v1/objects/**`。
4. **账户 KEK 需要宿主侧核验**：磁盘上只有凭据文件与 w2m 设备密钥，无法直接判定“DSH 登录账户”的稳定身份；Q1=A 的前提是 v3.4.6 用 `cordis_inspect` 查账号/凭据服务，确认可读账户材料后才实现账户信封，否则退回密码模式。
5. **`D:\DeepSeekHarness\BackUP` 尚未创建**：v3.4.6 的 `layout.mjs` 首个职责就是“安全创建 + 无权限/盘符缺失具名报错”。

---

## 15. 复盘门禁映射（2026-11-17）

来源：`docs/RETRO-SESSION-RECOVERY-20261117.md`（会话 `session-5faf0ea6…` 找回实战的复盘）。
已落地：`scripts/session-doctor.mjs` + `test/session-doctor.test.mjs`（13 项，含防误报控制），入口 `npm run doctor`（无参数默认扫 `$DSH_HOME`）。

| 门禁 | 版本 | 状态 |
|---|---|---|
| G1 还原候选必须先过 `session-doctor`，失败即拒绝 | v3.4.6 | 已实现检查器，还原代码接线待做 |
| G2 `workspace.json` 写入协议（暂停客户端/写后回读/客户端保存后复查） | v3.4.6 | 待做（`layout/engine` 内） |
| G3 禁止手工事件：只存原始字节；重构路径必须过 G1 + 未来追加模拟 | v3.4.6 | 待做（备份设计约束，已写入 BACKUP-DESIGN 要求） |
| G4 seq 重编号工具（删/插事件的唯一合法方式） | v3.4.8 | 待做 |
| G5 校验只用运行时同一份代码（`mode=current`），自写解析器不作证据 | v3.4.6 | 文档已定，代码待接 |

v3.4.6 的验收新增一条：`node scripts/session-doctor.mjs --root "$DSH_HOME"` 在真实数据上只报已知的未注册会话（≤1 项），且新增单测覆盖"健康日志零发现项"。
v3.4.8 的验收新增一条：还原后必须再跑一次 doctor 且零发现项，并模拟"未来追加"仍通过。

## 实施记录：v3.4.8（2026-11-17）

**已交付**

- `src/backup/restore.mjs`：plan/apply 两段式；规划阶段解块 + 运行时校验 + 冲突分类 + 注册表计划，零写入；
  apply 顺序为"预还原副本 → 原子写会话 → 写附件 → 注册表写+回读 → 复读字节比对"。冲突默认先备份后覆盖，
  `--keep-both` 写 `session.v4.jsonl.zstd.restored-<ts>`。
- `src/backup/registry.mjs`（G2）：原子写 + 回读校验 + 客户端回写警告；只登记会话 id 与 archived/pinned；
  工作区由路径 slug 匹配（`E:\GPT` → `--E-GPT--`），未知工作区拒绝，`--workspace-path` 才能新建。
- `src/backup/runtime-validate.mjs` + `runtime-driver.mjs`（G5）：node 侧解 zstd 帧 → artifact JSON →
  以 `ELECTRON_RUN_AS_NODE=1` 启动安装的 Harness 跑 `sessionFormatCatalog.createRestore(header,{validation:'current'})`
  → 逐行 decodeRow → finish。没有判定行按失败处理；无安装默认拒绝（`--allow-static-validation` 显式降级）。
- `src/backup/unlock.mjs`：machine（DPAPI）/ password（scrypt）两条路径；账户信封不做（spike 结论）。
- `src/backup/verify.mjs`：全量解块校验 + 索引↔快照双向核对 + old/current 引用块存在性 + 未来追加模拟。
- `src/backup/archive.mjs` + `tar.mjs`：`.tar.zst` 归档（manifest + README + 文件树），回读逐文件验 sha256，
  解包拒绝路径逃逸。
- `src/util/session-validate.mjs`：doctor 规则下沉到 util（脚本变薄并 re-export），供还原门禁复用同一份规则。
- 子插件 4 个路由（restore/archive/verify/unlock）+ CLI 4 个命令（restore 默认只打印计划）。
- 测试新增 5 套件：runtime / restore / archive / verify / access；备份侧共 20 套件。

**门禁状态**：G1/G2/G3/G5 已接线；G4（seq 重编号）本版不做 —— 还原只写原始字节，不需要重编号，
理由与将来的设计边界写在 `docs/BACKUP-DESIGN.md` §15.6。
**复盘加固（同日）**：首次运行先验凭据再建库；dry-run 完全只读；多会话注册表一次成文；支持还原到全新 home；
运行时校验改为"小批 JSON + 大会话 NDJSON 流式"（真实仓库暴露 V8 字符串上限与 Electron 堆崩溃）；
归档包可直接还原；还原前副本按 N 份保留；identical 跳过；verify 增加 descriptor 与 old 记录摘要检查。
详见 `docs/BACKUP-DESIGN.md` §15.8。
**G2 注册表写入协议已收口（2026-11-17）**：`client.mjs` 暂停门（离线 CLI 拒绝活 home）、`registry.mjs` 写后回读、
新增 `registry-watch.mjs` 客户端保存后 2/8/20 s 复查并自动重放；CLI 增加 `--allow-live-home` 与
`--registry-recheck <ms>`；新增 `backup-g2` 套件。真实事故（误用真实 home）暴露的并发写入风险由
"apply 前目标再校验 + 写后无损自愈"兜住，详见 `docs/BACKUP-DESIGN.md` §16 与 §16.1。
**G3 收口（2026-11-17）**：新增 `future-append.mjs` 统一"未来追加"模拟（引擎报告、还原终审、verify 复核三处公用）；
引擎新增 `future_append` 报告且仍只存原始字节；verify `--runtime` 连 append 后的 artifact 一起终审；新增 7 项测试
（坏日志入库存原始字节、源文件字节/mtime 不变、追加前缀、运行时 append 失败码）。详见
`docs/BACKUP-DESIGN.md` §17。

> 实测（默认仓库）：15 会话 / 171.5 MB / 2 新块 + 53 复用 / future append 15/15 / 26.1 s（未做模拟 4.8 s；
> 默认开启，可用 `--no-future-append` 关闭）。同日修复布局 bug：还原前副本所在目录被扫描器当成会话
> （`MANIFEST_REL_PATH`），副本移到 home 根 + walk 跳过点目录 + 扫描排除 + 引擎写块前预校验，见 §17.4。



**验收**：真实仓库上 `verify` 全绿；`archive --scope all` 产出的包 `readArchive` 逐文件校验通过；
还原到空 home 后日志字节与备份一致、`workspace.json` 已登记；错误密码/错误身份被 `BACKUP_NO_PERMISSION` 拒绝。

> **2026-11-17 实测（默认仓库）**：`unlock` → `machine` 信封、本机可用；`verify` 2 快照 / 32 文件 / 337.4 MB / 108 块全通过，30/30 未来追加模拟通过，49.1 s；`archive --scope all` 16 文件 → 168.7 MB tar → 164.7 MB zstd，2.3 s；`restore` 计划 15/15 会话由安装的 Harness 终审通过（13 identical / 2 conflict，冲突来自备份后仍在写入的活会话），dry-run 零写入；未注册工作区的会话默认拒绝，`--workspace-path` 显式挂接后进入计划。计划阶段对 15 份会话做运行时终审约 1.4 min —— 面板应按需逐份规划，而不是一次性全量。
