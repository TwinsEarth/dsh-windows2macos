# 复盘：会话找回实战（2026-11-16/17）

> 对象：`session-5faf0ea6-21cf-4338-aa9c-60f2304f66d1`「找回十天内历史对话」（2.3 MB / 2796 事件 / 13 轮 / 662 次工具调用）
> 结论：**一次以"手工重建会话日志"为主线的实战，四次失败、四类根因；最终靠"保留真实字节 + 满足格式不变量 + 用运行时校验"翻盘。**
> 本文件同时是门禁说明：新增的 `scripts/session-doctor.mjs` 把这些根因变成可执行检查。

---

## 1. 事件时间线（真实数据）

| 时间（Asia/Shanghai） | 用户诉求 | 发生了什么 |
|---|---|---|
| 11-16 23:27 | 找回工作区内 10 天内的所有历史对话 | 建 `E:\GPT\session-recovery\recover10d\`，全量快照 344 个会话目录 / **575.3 MB**（正确动作） |
| 23:56 | 急需找回「DSH：瓮城Plus」 | 开始**手工重建**日志（从投影缓存/摘要拼事件） |
| 11-17 00:06 | 指定 `.dsh.bak` 投影缓存文件 | 继续以缓存为素材重建 |
| 05:33 | 一次找回 5 个会话（IM2A、2Xray、ToFuture运维、火山方舟、瓮城Plus） | 批量重建 + 手写注册表 |
| 05:46 / 05:58 | 找回「DSH：房主」「DSH-瓮城」最新 | 同上 |
| 06:08–06:21 | 房主（大纲重建）重启后不出现 → 仍然不出现 | **失败 1、2**（注册表被客户端回写；首帧混装事件被判损坏静默跳过） |
| 06:32 | `assistant/message surfaceOp requires an object` | **失败 3**（重建事件缺 `surfaceOp`/`stream`/`usage`） |
| 08:45 | `system/message requires a protected first surface head` | **失败 4**（surface 以 `user/message` 开头，没有保护头；且客户端期间**真实追加了工作事件**，重建与真实内容冲突） |
| 之后 | — | 最终方案：保留全部真实内容；删掉位置非法的 `system/message`；在 surface 首部插入合法保护头；**全局重编号 seq 并改写引用**；用运行时同一份校验代码验证；再做"模拟未来追加"验证；重新置顶/注册 |

期间还有两个环境性失误：内联 `node -e`/PowerShell heredoc 引号把脚本写坏两次（`SyntaxError: Unexpected identifier '$'`）。

---

## 2. 根因（按"为什么编辑器里看着对、应用里就是错"排序）

| # | 症状 | 真正根因 | 证据 |
|---|---|---|---|
| R1 | 重启后会话不出现 | `storages/workspace.json` 被写入时客户端持有内存态，**下一次客户端保存把新增条目冲掉** | 客户端重写注册表、清掉置顶；日志在磁盘上但不在注册表 |
| R2 | 补了注册表仍不出现 | **zstd 首帧必须只含 header 一行**（`assertZstdHeaderFrame`）；header 与首批事件压进同一帧 → 判损坏**静默跳过**，界面无报错 | 抽 `app.asar` 校验代码后才看到该断言 |
| R3 | 出现了但点不开 | `assistant/message` 缺 `surfaceOp: "append"`（真实事件还带 `stream`/`usage`）→ `surfaceOp requires an object` | 由 `foldSurface` 抛错点定位 |
| R4 | 点开后再次损坏 | `system/message` **只能作为 surface 第一条事件**并建立 `protectedHead`；重建 surface 以 `user/message` 开头，客户端后续 turn 追加 `system/message` 即判损坏 | 克隆同一份运行时代码 100% 复现 |
| R5 | 删/插事件后全盘拒绝 | `seq` 必须连续且被引用（`sourceEventSeqs` / `messageSeqs` / `headerSeq`）；删一条、插一条都要**全局重编号并改写引用** | 删除 `system/message` 后出现 seq gap / 悬空引用 |

**贯穿性根因（R0）**：把"会话日志"当成"可随意拼写的 JSON 文本"，而不是**有容器格式（zstd 帧）+ 折叠语义（surface/seq）+ 外部索引（workspace.json）三套不变量**的状态机。四次失败全部是同一个认知错误的不同投影。

---

## 3. 最终生效的做法（可复制）

1. **先全量快照**（344 目录 / 575 MB），任何改动前归档原文件（`recover10d\used-logs\`）。
2. **绝不重建**：保留全部真实事件，只做最小外科手术（删位置非法事件、插入合法保护头）。
3. 插入/删除后**全局重编号 seq**，并同步改写 `sourceEventSeqs` / `messageSeqs` / `headerSeq`。
4. **用运行的同一份校验代码验证**（`restoreCurrent → Session.fromRestore`，`mode=current`），而不是自写解析器：
   ```
   OK 39bb0148  frames=24 events=4572 mode=current
   OK a6b0ed16  frames=50 events=9730 mode=current
   OK 0c36661d  frames=46 events=8925 mode=current
   ```
5. **模拟未来追加**再验一次（证明修复持久，不会因继续使用而再次损坏）。
6. 索引处理：客户端会回写注册表并清置顶 → 恢复后**重新置顶/注册**，并复查注册表内容。
7. 脚本一律落文件再执行，不用内联 `node -e`（两次引号事故）。

---

## 4. 门禁（已落地，可执行）

### 4.1 `scripts/session-doctor.mjs`（只读）

```powershell
npm run doctor                                                # = 无参数 → 默认 --root $DSH_HOME
node scripts/session-doctor.mjs                               # 同上（进程内读环境变量，兼容 cmd.exe）
node scripts/session-doctor.mjs --root "$env:DSH_HOME"        # 人类可读报告
node scripts/session-doctor.mjs --root "$env:DSH_HOME" --json # 机器可读（供还原流程调用）
node scripts/session-doctor.mjs --file <session.v4.jsonl.zstd> --session-id <id>
```

退出码：`0` 干净、`1` 有发现项/损坏、`2` 用法错误。`--root` 缺省取 `process.env.DSH_HOME`；
`--file` 是单日志模式，不推断注册表根目录。**默认根目录写进进程内**而不是写进 npm 脚本，
是因为 Windows 的 `npm run` 走 `cmd.exe`，`"$DSH_HOME"` 会原样当字面量传进去（已实测踩过一次）。

检查项（对应上面的根因）：

| code | 对应根因 | 判定 |
|---|---|---|
| `ZSTD_HEADER_FRAME_INVALID` | R2 | 首帧必须恰好一行，且是 `session` header |
| `SESSION_HEADER_MISSING` | R2 | 首帧里没有 header 事件 |
| `SURFACE_OP_MISSING` | R3 | `user/message`/`assistant/message` 的 `surfaceOp` 既不是 `append`，也不是合法的 `{op:'replace',startSeq,endSeq}` |
| `PROTECTED_HEAD_MISSING` | R4 | `system/message` 出现在 surface 非首位置（或 surface 无保护头） |
| `SEQ_GAP` / `SEQ_DUPLICATE` | R5 | seq 非 0..N-1 连续唯一 |
| `SEQ_REF_DANGLING` | R5 | `*Seq`/`*Seqs` 引用指向不存在的 seq |
| `SESSION_NOT_REGISTERED` | R1 | 日志在磁盘上但不在 `storages/workspace.json` |
| `REGISTRY_UNREADABLE` / `SESSION_ID_MISMATCH` / `LOG_UNREADABLE` / `LOG_EMPTY` | 兜底 | 结构性错误 |

**真实验证（本机）**：14 条日志全部通过格式检查，唯一发现项是 1 条未注册会话（`session-e4350615…`）——这正是 R1 的现场，说明检查有效且不误报。

### 4.2 门禁自身的"防误报"控制

第一次跑真实数据时，doctor 把两条**健康**会话判成 `SURFACE_OP_MISSING`：因为真实日志里压缩检查点（compaction checkpoint）的 `surfaceOp` 是对象 `{op:'replace',startSeq,endSeq}`（该 113 MB 会话里出现 37 次），不是字符串 `"append"`。已修正并补了两条控制用例（对象形态必须通过；缺边界字段必须失败）。**教训：门禁必须先用真实健康样本跑一遍，否则它会把正常数据判红。**

### 4.3 测试（`test/session-doctor.test.mjs`，13 项）

覆盖：健康日志 OK、首帧混装事件、缺 surfaceOp、对象形态通过、对象缺字段失败、保护头缺失、seq gap + 悬空引用、未注册会话、注册后无发现项、只列出带 v4 日志的目录、CLI 退出码（0/1）、缺省根目录解析（`$DSH_HOME` / 显式 `--root` 优先 / `--file` 不推断）、无参数 CLI 在干净 `$DSH_HOME` 上退出 0。
每一条都对应上面一次真实失败，不是抽象规则。

### 4.4 后续版本要接上的门禁（写进计划，不在本文件实现）

| 门禁 | 落在哪个版本 | 内容 |
|---|---|---|
| G1 还原候选必须先过 doctor | v3.4.8 已接线 | `planRestore` 对每份解回字节跑 `validateCandidate`，任一失败整单拒绝；`applyRestore` 写后复验（`src/backup/restore.mjs`） |
| G2 注册表写入协议 | v3.4.8 已完整实现 | 三半齐备：① `client.mjs` 暂停门（CLI 拒绝活 home，面板接受并依赖后续）；② `registry.mjs` 原子写 + 回读校验；③ `registry-watch.mjs` 客户端保存后按 2/8/20 s 复查并自动重放；测试见 `backup-g2` |
| G3 禁止手工事件 | v3.4.8 已完整实现 | ① 引擎只存原始字节（坏日志也入库，清单 sha 等于源哈希；源文件字节/mtime 不变有单测）；② `future-append.mjs` 一条模拟实现，引擎报告 `future_append`、还原用运行时终审"原日志+追加后日志"、verify 静态与 `--runtime` 双重复核 |
| G4 seq 重编号工具 | 本版不做 | 还原路径不含删/插事件，不需要重编号；工具本身是"改历史"的入口，留待真实修复场景单独设计（DESIGN §15.6） |
| G5 校验用运行时 | v3.4.8 接线 + v3.4.9 收口 | 证据来自安装的 Harness（`createRestore(..., validation:'current')`），doctor 只预筛并标 `static-prefilter`；还原/归档还原对"原日志+追加后日志"批量终审；driver 新增事件数守恒（seq 缺口日志会被静默丢行，必须判为不是证据）；`run --runtime` / `verify --runtime` 可要求运行时证据 |

---

## 5. 一页清单（下次会话找回时照做）

**必须**
1. 先快照：`sessions/` 全量复制到独立目录，记录目录数/字节数。
2. 只恢复原始字节；不做"拼摘要、重建大纲"。
3. 发布前跑 `node scripts/session-doctor.mjs --file <候选>`，必须 `ok`。
4. 注册表单独处理：写入后回读；客户端运行中不要指望一次写入就生效。
5. 验证用运行时校验路径（`mode=current`），并做"未来追加"模拟。
6. 每步写日志：文件路径、前后大小、事件数、turns、校验输出。

**禁止**
1. 禁止把 header 与事件压进同一 zstd 帧。
2. 禁止构造缺 `surfaceOp`/`stream`/`usage` 的 `user|assistant/message`。
3. 禁止让 surface 以非 `system/message` 开头后再让客户端追加系统消息。
4. 禁止删/插事件后不重编号 seq、不改写引用。
5. 禁止用"重启看看"当唯一验证。
6. 禁止在会话可能被继续使用时假定它是冻结的。

---

## 6. 与备份&还原子插件的关系（v3.4.6+）

这次实战正好证明备份功能的必要性，也证明"能备份"不等于"能还原"：

- **备份侧**：只存原始日志 + 附件 + `workspace.json`，不解释内容 → 天然规避 R2–R5。
- **还原侧**：`workspace.json` 合并（R1）、seq/格式校验（R2–R5）、先校验后发布（G1）、必要时 G4 重编号工具。
- **失败时**：拒绝并给出 `session-doctor` 报告，而不是"写进去让客户端发现"。

计划文档已同步：`docs/DEV-PLAN-3.4.6-3.5.0.md` 的 v3.4.6 / v3.4.8 验收项会引用本文件的 G1–G5。

---

## 7. 附：本次复盘所用数据

- 会话日志：`C:\Users\fangw\.dsh\sessions\--E-GPT--\session-5faf0ea6-…\session.v4.jsonl.zstd`（2.3 MB，2796 事件）
- 事件类型分布：`tool/call` 386 / `tool/result` 386 / `assistant/message` 355 / `job/registered` 249 / `step/start` 356 / `user/message` 45 / `session/title` 2 / `approval/*` 2 …
- 最终三条会话修复结果（会话内实测输出）：`39bb0148` 4572 事件 / 662 turns / 105 次工具调用；`a6b0ed16` 9730 事件 / 1501 turns；`0c36661d` 8925 事件。
- 复现与检查入口：`scripts/session-doctor.mjs`、`test/session-doctor.test.mjs`。
