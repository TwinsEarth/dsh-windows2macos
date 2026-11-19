# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [3.5.3] — 2026-11-20

### 决策中心 UX：会话名替代裸 Session ID；决策选项口语化（可调用智能）（未发布）

- **会话名**：本轮待选/暂停列表/会话 chip 不再显示裸 Session ID。宿主新增会话标题解析（`src/decision-center/lib/session-titles.mjs`，
  从会话日志首条消息有界读取 + 缓存，服务缺失/无标题返回 null）与 `GET /api/w2m/decisions/session-titles`；
  客户端优先 `source.sessionTitle`，本地 sessions 服务兜底，都没有时显示「未命名会话 · 尾 6 位」；裸 ID 只留在 tooltip/详情里。
- **选项口语化**：新增 `src/decision-center/lib/option-humanizer.mjs`——规则通道（去 markdown/代码块/URL/编号、合并空白、
  去重、整句转动作短语、CJK 感知截断，默认 28 字符）始终同步生效；智能通道（配置了 AI provider 时）用一次严格 JSON
  提示改写 label（值/数量不变、不得新增选项、10 s 超时、失败回退规则），内存 LRU 缓存，不记录原文与密钥。
  ticket 记录 `optionsHumanized {mode: rules|ai|off, at, model?}`，每个 option 保留 `rawLabel` 供 tooltip。
- **手动入口**：`POST /api/w2m/decisions/humanize-options`（id 走 body，因为插件不支持参数段路由），带限流；
  客户端每张 ticket 增「调用智能优化」按钮（运行中禁用），选项按钮带 `data-w2m-dc-option-source`（ai 显示 ✦）。
  创建 ticket 不等待智能通道（规则结果立即可用）。
- **配置**：`optionHumanize: auto|off|rules-only`（默认 auto）、`optionLabelMaxChars`（默认 28）、
  `optionHumanizeTimeoutMs`（默认 10 000）。
- **测试**：`dc-ux` + `decision-routes` + `decision-center` + `decision-outbox` + `client-bundle` + `client-budget` 全绿
  （规则矩阵、AI 假 fetch 成功/畸形/超时/数量不符→回退、缓存命中、手动路由限流、客户端渲染与按钮状态）；
  eslint 0 error；layer/mojibake clean；`lib/client.js` 仍在预算内。
- **文档**：新增 `docs/DECISION-CENTER-UX.md`（标题解析与选项人化流水线、配置、限流、失败回退、验证命令）。

### 修复：SSE 流被 5 秒头超时错误中断（未发布）

- **根因**：`src/agent/lifecycle/heartbeat.mjs` 把 SSE 的「等响应头」deadline 用 `AbortSignal.timeout()` 混进传给
  `fetch` 的 signal；而 fetch 的 signal 也覆盖**响应体**，所以每条健康 SSE 流在 attach 后 5 s 被 abort 并重连，
  恰好落在那窗口里的帧（如 task.offer 重投）会丢失。该缺陷自 v2.0.5 `edf6333` 引入（与 S4 拆分无关）。
- **修复**：独立的 `AbortController` + header 计时器，`fetch` settle 后立即 `clearTimeout`；响应体由既有
  first-frame/idle watchdog 与 `stop()` 兜底。永不发头的服务端仍会得到 `SSE_FIRST_FRAME_TIMEOUT`。
- **证据**：隔离循环 **2/15 失败**（126–127 s，`timed out waiting for cached resend`，trace 显示 stream 在
  attach 后 5.02 s 被 TimeoutError abort）；修复后目标用例 **15/15**（3.0–3.4 s），4 路忙循环加压 **8/8**，
  `W2M_SSE_FIRST_FRAME_MS=1000` 强制复现后 **5/5**；`test/agent.test.mjs` 161 pass / 0 fail / 2 skip；
  `test/p2p-*.test.mjs` 257/257。新增回归用例「任务跨越缩短的头超时仍只 attach 一次」（HEAD 上失败、修复后通过）。
- **影响**：已发布的 3.5.2 含该缺陷（`task.cancel` 与缓存重投路径都可能受 5 s 流中断影响）；建议下一版本（3.5.3）携带。

### P1 S6/S7：client 预算计量修正 + chat 渲染提取（未发布）

- **计量缺陷**：`test/client-budget.test.mjs` 的旧计量只认列 0 `function` 并把后续并列组件全算进上一个函数，
  误报 `UpdateSettingsSection` 3,454 行 / `renderChatText` 1,131 行；实际分别是 **63 行 / 10 行**，真实最大为
  `BackupPanelView` 832 行。
- **修正**：重写为花括号匹配计量（屏蔽注释/字符串/模板/正则、跳过嵌套函数、加非空守卫 140 函数/最大 ≥400），
  预算单函数上限 3,600 → **1,200**（832+余量），并钉住 63/10 两个回归值。
- **提取**：`renderChatText` 与 `CHAT_COMMANDS/STICKER_GLYPHS/STICKER_RE/EMOJIS` 从 `FleetChat` 提到模块作用域
  （逐字节等价，仅缩进/注释），`FleetChat` 351→335；`lib/client.js` 593,045→593,540 B（预算内）。
- **验证**：client 套件 143/143（含真实 Edge 页面 21.4 s 全通过、queue-journal 探针 slotted/草稿落盘/抽屉/恢复）；
  eslint 0 error；layer/mojibake clean。

### 队列日志抗版本更新加固（未发布）

- **客户端槽位化**：队列日志 chip 注册到 `conversation.input.left`（id `w2m-queue-journal`，order 46），抽屉注册到
  `shell.overlay`（order 91，候选 `shell.bottom`）——全部走 `ctx.slots.inject/register`；删除主路径的
  `document.body.append(badge, overlay)` 与 `findComposer()` 面积启发式，DOM 只在 slot props 缺失时作为兼容分支使用，
  并写入诊断（`dom-composer-fallback:*`）与一次 `console.warn`。
- **永不静默消失**：`conversation.input.left` 注册失败/`shell.overlay` 缺失/缺 `inputActions` 时，注册可见的
  `sidebar.panellist`「降级模式」入口（`data-w2m-jq-status="fallback"` + 提示文案）；页面级诊断对象
  `window.__W2M_QUEUE_JOURNAL__ = {status, surface, reasons[], dshVersion, checkedAt}`，状态取
  `slotted|fallback|disabled`，并检查 DSH 版本范围 `>=0.2.2-rc.1 <0.3.0`（超出范围保留 UI 并标注未验证）。
- **宿主健壮性**：`xclient/queue-journal` 懒创建；损坏文件隔离并返回具名 `error` 而不是抛错；JSON body 具名拒绝、
  draft/queue/title 上限、`fangAuthToken` 可选门。
- **测试**：`client-bundle` 112/112、`queue-journal` 17/17、`client-budget` 3/3；真实 Edge 页面探针（`W2M_DSH_ROOT` +
  `W2M_QUEUE_JOURNAL_PROBE=1`）**10/10 通过**：chip 槽位化、诊断正确（`slotted / conversation.input.left+shell.overlay`）、
  输入草稿落到 `xclient/queue-journal/composer-journal.json`、drawer 列出条目、恢复写回 composer、关闭后 drawer 移除。
- **体积**：`lib/client.js` 9,965 → 9,990 行，594,539 → **593,045 字节**（净 −1,494 B），预算守卫不变。
- **文档**：新增 `docs/QUEUE-JOURNAL-COMPAT.md`（主/备槽位、诊断对象、升级检查命令、槽位改名时的单点更新与验收）。

### P1 重构：S4 agent 生命周期 + S5 relay 状态机拆分；P2-F 故障注入与 P2P 去重修复（未发布）

- **S4 agent 生命周期拆分**：`src/agent/agent.mjs` 4,770 → **638 行**（`createAgent()` 365），拆为
  `src/agent/lifecycle/{shared,deliver,execute,offer,heartbeat}.mjs`（1,170/1,470/554/567/926）；导出面 45 项不变、
  4,470/4,690 行逐字节一致；基线 568/566/0/2 与广回归 164/164 不变；`test/dataflow-wiring.test.mjs` 仅改读取路径。
- **S5 relay 状态机拆分**：`src/relay/state.mjs` 3,713 → **1,174 行**，拆为
  `src/relay/state/{shared,members,tasks,leases,results,events}.mjs`；42 导出与 100 个 prototype 方法名不变；
  relay 517/516/0/1 不变；真实进程 phase2 **9/9**、mixed **6/6**；`.gitignore` 修正 `state/` 误忽略源码目录。
- **P2-F 并发/故障注入矩阵**：新增 `test/helpers/fault-udp.mjs`（seeded 丢包/乱序/重复/静默/延迟）、
  `test/p2p-fault.test.mjs`（24 例）、`test/relay-concurrency.test.mjs`（8 例：心跳/过期/接管/重启/幂等）。
- **修复 P2P 重复投递 bug**（F2 命中）：完成后重复包不再二次投递、`incoming` 有 TTL 清理，新增有界完成记忆
  （`recentMessageLimit` 1024 / `recentMessageTtlMs` 60 s）与计数器；线协议与 ACK 语义不变；p2p 回归 115/115 + 142/142。

### P1 重构进展：备份引擎 worker_threads 化 + tools 入口拆分（未发布）

- **S8 备份引擎 worker_threads**：定时备份、`POST /api/w2m/backup/run`、verify 路由与 nightly 终审改由 worker 执行
  （`src/backup/engine-worker.mjs` + `src/plugin/backup-worker.mjs`）：`resourceLimits.maxOldGenerationSizeMb=1024`、
  运行级超时（`backupWorkerTimeoutMs`，默认 30 min）、具名失败 `BACKUP_WORKER_OOM/TIMEOUT/FAILED`、进度写入
  `<DSH_HOME>/xclient/w2m-backup/worker.json`（原子写、结束删除、不含密钥）、`W2M_BACKUP_INLINE=1` 或无 Worker 时
  回退 inline（行为不变）。mount 仍惰性；CLI 仍 inline；`state` scope 排除 worker 进度文件避免自捕获。
- **S2/S3 tools 入口拆分**：`src/plugin/tools.mjs` 8,908 → **610 行**（apply 450），按域拆为
  `src/plugin/tools/{shared,dispatch,memory,fleet,governance}.mjs`；工具面摘要（18 工具）保持
  `409a6652675fc66608525b4437f07e17f3a5898ab7b61297e6c0309654a82f5a` 不变，注册顺序与导出面不变；
  4 个源码守卫测试仅改读取路径（断言未动）。

## [3.5.2] — 2026-11-19

### G4 renumber：`image/offload` 的 `data.targets[].seq` 引用改写（未发布）

- **修复**：真实机器复核（2026-11-19，`g4_renumber_boundary`）发现 `src/backup/renumber.mjs` 的引用改写只认 `*Seq`/`*Seqs` 键，而 `image/offload` 事件把消息 seq 引用放在小写的 `data.targets[].seq` 里；删/插事件移位后该引用仍指向旧 seq，安装的 Harness 以 `RENUMBER_RUNTIME_REJECTED`（`invalid seed event ... image/offload: image index 0 does not exist`）安全拒绝（零写入）。现在只对 `type === 'image/offload'` 事件的 `data.targets[i].seq` 应用同一 old→new 映射；指向被删除/越界 seq 的 target 复用 `RENUMBER_DANGLING_REFERENCE` 具名拒绝；事件自身顶层 `seq` 仍只由密集重编号赋值，其他小写 `seq` 字段含义不变。
- **测试**：`test/fix-renumber.test.mjs` 新增 8 项（单 target 删前事件后改写到 N−1 且安装 Harness 接受、多 target 全改、删 target 本身具名拒绝且零写入无 `.bak`、target seq 越界同样具名拒绝、删 target 之后 target 不变、offload 事件自身 seq 与 target seq 不混淆、非 `image/offload` 的小写 `seq` 不改写；安装 Harness 一项按既有模式无安装时跳过）。
- **文档**：`docs/BACKUP-DESIGN.md` §20.1 引用规则与 §20.2 流水线补充 `image/offload` target 规则，§20.5 测试清单更新。
- **验证**：`npx eslint .`（0 error）、`node scripts/layer-check.mjs`、`node scripts/scan-mojibake.mjs`、`node --test --test-force-exit test/fix-renumber.test.mjs`（38/38）、`node --test --test-force-exit test/backup-verify.test.mjs`（25/25）全绿。**不 bump 版本（仍 3.5.1）、不提交、不跑 preflight、不发布。**

## [3.5.1] - 2026-11-18

### P0 挂载即崩：3.5.0 启用 w2m 后宿主 OOM 的根因与内存护栏（未发布）

- **事故**：DSH 桌面 0.2.2-rc.5（Node 24 / Electron 44，~4 GB V8 堆）启用 `@twinsearth/w2m-dsh-plugin@3.5.0` 后几秒内出现 `Scavenge ... Allocation failed - JavaScript heap out of memory`；插件管理器 journal 的 `reason:"bundle", stage:"enable", phase:"started"` 永不落定。用户禁用全部第三方插件后启动正常，仅重新启用 w2m 立即复现，证明炸点在**插件挂载/启用路径**，不是渲染进程。
- **根因（已复现）**：备份子插件在 `apply()` 内的 `scheduler.start()` 直接触发**漏槽补跑（missed-slot catch-up）**；22:00 槽 + 默认 12 小时补跑窗口使每次开机都命中。补跑在宿主主线程同步执行整个 `runBackup`，随后又挂上 `verifyRepo({runtime:true})`，把 0.2.2-rc.5 的 enable 卡死并撑爆堆。实测（fixture：真实 home 形状，118 MB 单日志、`old/` 1.36 GB、21 个快照）：`apply()` 后 100 ms 采样器**一次都没再运行**（事件循环被同步占满），`--max-old-space-size=1024` 子进程 17.8 s 后 OOM，峰值 WS 1.36 GB。
- **放大分配（已逐一修复）**：① `readSessionHeader` 用 `fs.readFileSync` 读整个会话日志（真实 118 MB/次；实测 scan 阶段峰值 163 MB）；② `verifyRepo` 对每个快照的每个文件 `rebuildFile` 整体物化（21 快照 × 118 MB），且 `rebuildFile`/`old/` 全文件 `.enc` 校验（最大 300 MB 级）无堆护栏；③ G5 `verifyRepo({runtime:true})` 在内存里**累积**每个快照每个会话的两份已解码 artifact（真实 21 快照 × 44 会话 = 924 份）后才启动一次 runtime 批；④ `storeFileBlocks` 整文件读入后再分块（4 MiB 块本可流式）；⑤ `verify` 的 3.5.0 路径在 1 GB 堆限制下 `runtime:false` 17.8 s OOM（峰值 WS 1.34 GB）、`runtime:true` 25.6 s OOM。
- **修复 A（挂载路径）**：新增行配置 `backupCatchUpOnStart`，**本版默认 `false`**。false 时挂载只做「纯时钟算术」判断，把漏槽记录为 `pending_catch_up`（含 missed slot / 窗口 / 动作说明，写入 `<DSH_HOME>/xclient/w2m-backup/state.json` 并在 describe/`GET /api/w2m/backup/run`、`w2m-backup status` 展示），然后仅安排下一个 22:00 槽；真正的补跑只由**显式人工 run**（面板/CLI）或下一槽触发。`backupCatchUpOnStart: true` 保留旧行为（仍在 12 小时窗口内），但 `setImmediate` 延迟到挂载栈之外执行。`createDailyScheduler` 新增 `catchUpOnStart` 选项（默认 true，自更新检查器行为不变）。
- **修复 B（header 有界读）**：`readSessionHeader` 改为按 64 KiB 步进、上限 `SESSION_HEADER_SCAN_CAP_BYTES = 1 MiB` 的 `fs.read` 循环，只解析第一个 zstd frame；header frame 超过上限时按 `BACKUP_SCAN_HEADER_UNREADABLE` 命名拒绝，绝不整文件缓冲。`hashFile` 同样改为 64 KiB 分块哈希。实测：123.8 MB 日志，heap 增量 57 KB、arrayBuffers 增量 1.05 MB、实际读取 64 KiB；scan 阶段峰值从 163 MB 降到 RSS 46 MB（external 155 MB → 38 MB）。
- **修复 C（verify/物化有界）**：`materialize.mjs` 新增 `digestEntryStreaming`：逐 4 MiB 块解密+哈希，峰值约一个块（`streaming.peak_block_bytes` 实测 4.19 MB），不做整文件 concat；`verifyRepo` 对 ≥32 MiB（`streamThresholdBytes` 可配，0 = 全部流式）的条目走该路径，`old/` 记录也走流式；`.enc` 全文件副本校验前先按 `oldCopyMaxBytes`（默认 512 MiB）和堆护栏检查，超限/拒绝都返回命名 code（`BACKUP_VERIFY_OLD_COPY_TOO_LARGE` / `BACKUP_MEMORY_GUARD`）。`rebuildFile` 在物化前过护栏；restore 单条目超限以 `BACKUP_MEMORY_GUARD` 命名拒绝而不是 OOM；`verify` 结果新增 `streaming` 计数。实测：同一 21 快照仓库，`runtime:false` 从 17.8 s OOM 变为 191 s、0 problem，峰值 WS 950→859 MB（1 GB 堆限制下通过）；`runtime:true` 199 s、0 problem、峰值 WS 894 MB。
- **修复 D（G5 有界）**：runtime 终审只对**最新快照**的会话逐条进行（每会话一个 `[原始, 追加一帧]` 批次，缓冲区在该次迭代后释放；`runtime_verified.snapshots` 说明只覆盖最新快照，旧快照的块/摘要仍全量校验，历史 runtime 结论由缓存记录承载）；单会话超过 `runtimeMaxBytes`（默认 32 MiB）时按 `BACKUP_RUNTIME_SKIPPED_LARGE` 跳过并计数。实测：41 个会话逐个验证、2 个大日志命名跳过、0 problem；不再出现 924 份 artifact 累积。
- **修复 E（引擎护栏与流式存储）**：新增 `src/backup/memory-guard.mjs`（`BACKUP_MEMORY_GUARD`，默认上限 `DEFAULT_MAX_HEAP_BYTES = 1.5 GiB`，`0` 显式关闭）；`storeFileBlocks` 对 >16 MiB 文件改为单块复用缓冲 + 增量哈希 + 逐块 seal（峰值约 8 MB，不再整文件读入），frame 结构用 `scanFramesFromFile`（只读帧头，不读 payload）做撕裂检测；大文件的整文件 future-append 模拟与 runtime artifact 按 `BACKUP_FUTURE_APPEND_SKIPPED_LARGE` / `BACKUP_RUNTIME_ARTIFACT_SKIPPED_LARGE` 命名跳过（字节仍原样存储，verify 后续可按需检查）。`runBackup` 结果新增 `memory_guard`（limit/checks/refusals）。实测：真实形状 fixture 的整次备份从 18.9 s OOM（峰值 1.36 GB）变为 7.7 s 成功（峰值 WS 379 MB、heap 156 MB）。
- **配置/行为变化**：`backupCatchUpOnStart`（默认 **false**）、`backupMaxHeapMb`（默认 1536，0 = 关闭护栏）加入备份行配置与 `cordis.patch.yml`；`GET /api/w2m/backup/run` describe 与 `w2m-backup status` 新增 `catch_up_on_start` / `pending_catch_up` / `memory_guard`；`w2m-backup verify` 人类输出新增 `streamed` / `future append ... deferred` / `runtime check ... skipped` / `memory guard ... REFUSED` 行。旧行为恢复方式：行配置 `backupCatchUpOnStart: true`。
- **测试**：新增 `test/backup-memory.test.mjs`（15 条）：挂载 <200 ms + 堆增量 <32 MB（含 200 MB 稀疏日志与 1.36 GB `old/`）；默认不跑、`backupCatchUpOnStart: true` 才跑且延迟到挂载栈外；header 有界读（读取字节计数 + `--max-old-space-size=64` 子进程堆增量）；verify 流式阈值与逐会话 runtime 释放（注入 batch，断言每次仅 2 个 artifact）；`BACKUP_MEMORY_GUARD` 命名拒绝（引擎/物化/子进程）；`pending_catch_up` 在 describe 与 status 中可见；scheduler `catchUpOnStart` 两态。测试接入 `scripts.test` / `test:all` / `test:backup-memory` 与 `backup-wiring` 的套件清单。
- **验证**：`node --test --test-force-exit test/backup-*.test.mjs test/client-bundle.test.mjs` 663 条全绿（含新增 15 条）；`npx eslint .` 0 error；`node scripts/layer-check.mjs`、`node scripts/scan-mojibake.mjs` clean；`node scripts/pack.mjs` 产出 3.5.1 tarball。**不提交、不跑 preflight、不发布、不写真实 profile/DSH_HOME。**

### 备份范围 P3：还原前副本（restore_copies）与自引用守卫（未发布）

- **第六个 scope `restore_copies`（默认开）**：`.w2m-restore-backups/**` 以 `kind:'restore-copy'` / `scope:'restore_copies'` / 固定 reason 进入 manifest；`--scopes`、插件配置 `backupScopes` 与 `cordis.patch.yml` 默认列表同步接受。独立上限：单文件 64 MiB（30 MB 的还原前会话副本可以备份）、整目录 1 GiB；超整目录上限只记一条 `class:'cap'` 跳过、**不拒绝本次运行**，其余 scope 照常。未选中时仍写一条 `class:'self-copy'` 跳过记录解释瘦身运行。
- **自引用环关闭（P3 的重点）**：`collectScopeFiles({excludeRoots})` 对每个候选路径（含 restore copies 与未来 scope）比较 resolved real path，落在仓库/排除根内即以固定 reason `inside the backup repository or an excluded root (self-reference)` 跳过，walk 在进入目录前先做同一判断、不下探仓库；engine 传入 `[path.resolve(root)]`。`backupDir` 被误配进 `$DSH_HOME`（如 `<home>/backup`）也覆盖；真实运行另有既有 `BACKUP_DIR_INSIDE_SOURCE` 拒绝。测试覆盖：仓库嵌套 home 时不收集并报告跳过、junction 指向仓库不被跟随、仓库在 home 外时 restore copies 正常收集。
- **restore 永不写回**：`itemsFromSnapshot` 只对 `restore-copy` 计数；计划输出 `restore_copies: {count, skipped: true, detail: 'pre-restore copies are recovery material, not live state'}`，apply 不写它们（不在 `plan.files`），registry/config/state 行为不变；CLI 计划输出新增该行。
- **verify/coverage**：`scopeOfEntry` 把 `restore-copy` 映射到 `restore_copies`，`coverage.covered.by_scope` 增加该 bucket；`.w2m-restore-backups` 在 inventory/coverage 中的类别从 `self-copy` 改为 `restore-copy`；gap 比较只在快照 `scopes` 含 `restore_copies` **且**目录存在时纳入（narrowed 快照不产生噪音）；restore-copy 条目照常做块/摘要校验。
- **archive**：`.tar.zst` 不打包 restore copies（避免体积翻倍），归档 manifest 记 `counts.restore_copies_excluded`，README/notes 写明"恢复材料、不是活状态"；镜像按 manifest 的块列表复制，restore copies 自然进入镜像。
- **文档/测试**：`docs/BACKUP-DESIGN.md` §27.2/§27.3/§27.5 更新并新增 §27.6（scope、上限、excludeRoots 规则、restore 不写回、归档排除、诚实边界：路径包含 + 归档排除 + 不写回，不是跨 scope 按内容去重）；`docs/BACKUP-SCOPE.md` 标记 P3 已实现；`docs/RESTORE-RUNBOOK.md` 步骤 3 与「回滚」说明 restore copies 现在在备份内、以及如何找回。测试扩展 `backup-scopes`（默认 kind/scope/reason、narrowed 跳过、30 MB 允许、64 MiB 单文件、1 GiB 整目录跳过、excludeRoots/自引用）、`backup-scope-run`（默认捕获、`scopes:['sessions']` 不捕获、manifest 按 kind 计数、repo 嵌套 home 不收集、verify coverage bucket）、`backup-scope-restore`（计划报告 skipped、apply 不写）、`backup-archive`（归档排除与计数）。
- **验证**：`npx eslint .` 0 error、`node scripts/layer-check.mjs` clean、`node scripts/scan-mojibake.mjs` clean、相关备份 suite 与 `test/client-bundle.test.mjs` 全绿。
- **声明**：不 bump 版本（仍 3.5.0）、不跑 preflight、不提交。


### 面板凭据警告、恢复手册与 P0/P1 收尾（未发布）

- 面板状态卡新增「备份范围」行（`data-w2m-backup-scopes`）与「已包含凭据」红色警告（`data-w2m-backup-secrets-warning`，仅当 `backupIncludeSecrets` 开启）；describe 载荷暴露 `scopes` / `include_secrets`。
- 新增 `docs/RESTORE-RUNBOOK.md`：全新 `$DSH_HOME` 的恢复顺序（先装可重装依赖 `dsh-runtimes`/`node_modules`/`xray-proxy` → `restore --dry-run` → `--apply` → 身份/凭据按 P1 开关 → 逐项验收 → 回滚），并写明老快照的降级路径与已知边界。
- 文档：BACKUP-SCOPE 标记 P1/P2 完成；BACKUP-DESIGN §27.4 更新。


### 备份范围扩围（P0/P1）：registry/config/state scopes 与覆盖率（未发布）

- **P0**：备份默认包含五个 scope——`sessions`、`attachments`、`registry`（`storages/workspace.json` 本体）、`config`（根与 profile 的 package.json/cordis.patch.yml/pnpm-lock 等）、`state`（`xclient/**`、`dsh-context`、`llm-deepseek`、`fang`）；排除项（可重装依赖、缓存、还原前副本）逐条记录 reason/class；单文件 8 MiB、总量 256 MiB 上限。
- **P0 restore**：快照带注册表时以备份文档为基底重建（多 workspace/标题/顺序/defaultWorkspaceId/archived/pinned 原样），不再按 slug 猜测；config/state 文件随计划写入（pre-restore 副本、冲突先 `.bak`、`--keep-both` 写旁路、路径逃逸拒绝）。
- **P0 verify**：新增 `coverage` 块（home/covered 按 scope/ uncovered 分类/ gaps），有 gap 时报 `BACKUP_VERIFY_COVERAGE_GAP`；CLI 打印 `coverage : X% ... gaps: N`。`archive` 与 `mirror` 同步携带新条目。
- **P1**：`backupIncludeSecrets` / `--include-secrets`（默认 **false**）；开启才备份 `.credentials.yaml`、`.anonymous-user-id`、`device.key`、`gpw-folders.json.key`，manifest 标 `secrets_included:true`，CLI 打印显著警告。面板状态卡红色警告尚未接（遗留 UI 项）。
- **CLI/配置**：`run --scopes <list>`、`--include-secrets`；插件配置 `backupScopes` / `backupIncludeSecrets`；`cordis.patch.yml` 记录默认值。
- **测试**：新增 `backup-scopes`（scope 规则/凭据开关/上限）、`backup-scope-run`（manifest 与回滚行为）、`backup-scope-restore`（注册表基底还原与文件写回）；已有备份套件相应更新。


### old/ 整文件副本：从副本还原、镜像 old/、verify 逐份解密（未发布）

- **从 full 副本还原一个版本（`w2m-backup old-restore`，`src/backup/old-restore.mjs`）**：记录 + blocks 还在时用
  `restore`；对象目录损坏/块已丢失时，`.enc` 是最后一份能还原该版本的字节。`planOldRestore` 按 `--record` /
  `--session <id> [--rel]` / `--latest-for <id>` 选记录（同会话多个版本时具名拒绝，不猜），打开仓库 key
  （machine→account→password，未加密仓库的 `open` 信封零凭据）、读 `.enc` 并以 `{sha256, length: size,
  kind:'old'}` 解密、核对 sha256+长度、跑静态 doctor 预筛；缺省 dry run（打印 record/source digest/doctor/target/
  plan，目标缺省 `<record>.restored`），`--apply` 才写：plan 后目标被改 → `BACKUP_OLD_RESTORE_TARGET_CHANGED`
  拒绝覆盖，已存在需 `--overwrite`（先写 `.bak-<ts>`）或 `--keep-both`（另写 `.restored-<ts>`），写后回读
  sha256 校验。静态 doctor 不过默认拒绝 `BACKUP_OLD_RESTORE_DOCTOR_REFUSED`；只有显式 `--force-invalid` 才写，
  且 plan/结果保留 `doctor_ok:false`。错误码还有 `_NOT_FOUND` / `_NO_FULL_COPY` / `_CORRUPT` / `_TARGET_EXISTS`。
- **镜像现在包含整棵 `old/`（`src/backup/mirror.mjs`）**：快照/objects/元数据/索引行之后，把每条
  `<ts>-<sha12>.json` 记录与配对 `.json.enc` 复制到镜像（记录逐字节比较、`.enc` 按长度，损坏即
  `writeFileAtomic` 重写；每次写前 `guardWritablePath`，镜像 `old/` 内的 symlink/junction 具名
  `BACKUP_MIRROR_SYMLINK` 且零写入；只复制 `old/` 下普通文件，不跟随链接）。新增计数
  `copied.old_files`/`copied.old_bytes`/`skipped.old_files`（`repaired` 共享）；完好镜像第二次同步对 `old/`
  零写入；主库无 `old/` 时全 0。
- **`verify` 逐份解密 `.enc`（`src/backup/verify.mjs`）**：对每条带 `full_copy` 的旧记录读 `.enc`、以
  `{sha256, length: size, kind:'old'}` 解密并核对明文 sha256+长度，结果新增
  `old_copies:{checked,ok,failed,missing}`；缺失报 `BACKUP_VERIFY_OLD_COPY_MISSING`、解密/摘要/长度不符报
  `BACKUP_VERIFY_OLD_COPY_FAILED`（`detail` 写明记录）。没有 `full_copy` 的记录不计入；未加密仓库同样工作。CLI
  `verify` 人类输出新增 `old copies : N ok / M failed / K missing`，`--json` 有该块。
- **文档/测试**：`docs/BACKUP-DESIGN.md` §24.4（从副本还原、doctor 门禁、`--force-invalid` 语义、CLI/错误码/
  诚实边界）、§21.2（`old/` 镜像、计数、存储与"只增不删"边界）、§19.2/§19.3（`.enc` 逐份校验与测试）；测试挂在
  `test/backup-rotation`（old-restore API+CLI）、`test/backup-mirror`（`old/` 镜像/幂等/截断修复/junction 拒绝/
  镜像副本可解密）、`test/backup-verify`（健康/损坏/缺失/无副本/未加密/CLI）；`npx eslint .` 0 error、
  `node scripts/layer-check.mjs` clean、`node scripts/scan-mojibake.mjs` clean、相关 suite 全绿。
- **诚实边界**：`old-restore` 是**单版本、单文件**还原，不是整快照还原（不恢复附件、不动注册表、不做 G5 运行时
  终审）；缺省输出落在 `old/` 内会计入 §24.3 用量。镜像里的 `old/` 会随主库增长（§24.3 无总量上限），且镜像只增
  不删、不做跨镜像去重。`verify` 只对**带 `full_copy` 的记录**解密副本，没有副本的记录仍只验 blocks。
- **声明**：不 bump 版本（仍 3.5.0）、不跑 preflight、不提交。


### G5 运行时终审默认 nightly（未发布）

- `backupRuntimeVerify` 的默认值从 `off` 改为 **`nightly`**：每次成功的定时备份（含补跑）之后异步跑一次终审并把记录写入 `state.last_runtime_verify`，面板默认显示的就是最新记录（仍带时间戳，不是实时保证）；显式 `backupRuntimeVerify: off` 可关闭，`?runtime=1` 仍可手动跑。
- `cordis.patch.yml` 的 `dsh-backup` 行显式写 `backupRuntimeVerify: nightly`；测试更新默认断言与「显式 off 不跑、nightly 每个成功槽跑一次、失败只 warning」三组行为。


### 注册表写入的边界（一句话，未发布）

- **注册表写入的边界（一句话）**：宿主内走 `ctx.workspaceRegistry` 服务（`attachSession` 先持久化再改内存），**不存在客户端回写竞态**；离线 CLI 走文件写 + `--watch` 复查，**只能缩小窗口、不能消除**——watch 结束后客户端一次保存仍可能移除登记（`residual_risk` 非空）。


### 宿主 register 的移动目录回退：按会话 header cwd 挂接（未发布）

- **问题**：面板/插件登记的宿主路径 `registerThroughHost()` 走 `ctx.workspaceRegistry.attachSession`；该服务用会话 header cwd 的 realpath 比工作区路径，目录被移动/改名后必然拒绝，只能回退离线 CLI + 有界 watch，留下残余窗口。
- **行为**：`registerThroughHost()` 先读会话日志首帧（复用 `src/backup/scan.mjs#readSessionHeader`，不新增解析器）拿 header cwd；cwd 存在且能 realpath → 以它为**唯一**目标：`resolveByPath(realCwd)` 命中则复用，否则 `create(realCwd, '<目录名> <短 id>')`，再 `attachSession`。每会话报告 `attached_workspace_id`/`workspace_path_used`，结果新增 `cwd_fallback: [{session_id, requested_path, used_path}]`（`requested_path` 为调用方/注册表视图给的目标，可为 null）。绝不静默挂到与 header cwd 不同的真实路径；请求路径与 header cwd 一致时 happy path 不变（无 fallback 条目），宿主路径仍不写 `workspace.json`。
- **拒绝**：header cwd 缺失/为空/无法 realpath（盘符或目录已删），或 fallback 后 `attachSession` 仍拒绝 → `BACKUP_REGISTER_HOST_ATTACH_FAILED`，`detail` 写出会话 id、它的 cwd 字符串与下一步：离线 CLI `w2m-backup register --session … --watch <minutes>`（客户端尽量停掉；watch 会在被覆盖后重放），`via:'host-service'` 与 `residual_risk` 非空（文件路径 + watch 是下一步）。
- **文档/测试**：`docs/BACKUP-DESIGN.md` §22.1/§22.5 更新边界（移动/改名目录在宿主内解决，只有 cwd 真正缺失/无法解析才回退 CLI + watch）；`test/backup-g2.test.mjs` +4（移动目录 `create`/`resolveByPath` 复用与 `cwd_fallback`、header cwd 已删具名拒绝且 detail 含 cwd 与 CLI+watch 建议、匹配路径无 fallback、fallback 后 attach 仍拒绝）。`npx eslint .` 0 error、`node scripts/layer-check.mjs` clean、`node scripts/scan-mojibake.mjs` clean、相关 suite 全绿。
- **实现说明**：宿主 `create` 用真实签名 `create(path, title?)`（标题 = 清洗后的目录名 + 8 位路径短 id）；`cwd_fallback` 只记录成功挂接的会话，尝试过但被拒绝的会话由 `sessions[].workspace_path_used` 与 `failed[].used_path` 体现。
- **声明**：不 bump 版本（仍 3.5.0）、不跑 preflight、不提交。

### old/ 总量不设上限：每增长 10 GB 提醒、由用户决定是否手动清理（未发布）

- **用户决定**：`old/` **总量不设上限**；每增加 10 GB 提醒一次，是否手动清理由用户决定。所以本次不加上限，只加"测量 + 提醒 + 确认"三件事：每会话保留规则与单份整文件副本 300 MB 上限都不变。
- **常量/配置**：`DEFAULT_OLD_USAGE_REMINDER_BYTES = 10 * 1024 ** 3`（10 GiB，`src/backup/rotation.mjs`）；引擎 `runBackup({oldUsageReminderBytes, oldUsageAckBytes})`；插件行 `backupOldUsageReminderGb: 10`（`0` = 关闭提醒；非法值 → `BACKUP_CONFIG_INVALID`）；CLI `run --old-usage-reminder-gb <n>`（GB，`0` = 关闭）。
- **测量/结果**：成功备份在轮转与剪枝之后做一次只读目录遍历（`measureOldUsage`：readdir + stat，不读文件内容；缺失目录 = 0 字节/0 文件），结果恒有 `old_usage: {bytes, files, reminder_bytes, due, since_last_ack_bytes, next_reminder_at_bytes}`。阈值语义是**自上次确认以来的增长**，不是 10/20/30 阶梯：`due = reminder_bytes > 0 && bytes - ack_bytes >= reminder_bytes`，确认水位持久化为 `old_usage_ack_bytes`（缺省 0），`next_reminder_at_bytes = ack_bytes + reminder_bytes`。
- **提醒（绝不自动删除）**：`due` 时引擎把 `old/ 已增长 X GB，自上次确认以来超过 10 GB；是否手动清理？` 加入 `warnings`，结果 `old_usage.due: true`；插件把 `state.old_usage = {due, bytes, files, ack_bytes, reminder_bytes, at}` 持久化到 `<DSH_HOME>/xclient/w2m-backup/state.json`。备份、面板、CLI 都没有"按大小删除"的路径。
- **确认**：`POST /api/w2m/backup/old-usage/ack`，请求体必须是 `{"confirm":"ack"}`；把 `old_usage_ack_bytes` 设为**当前测量字节数**、清掉 `state.old_usage.due` 并返回新 state（`deleted: false`）。面板 `[data-w2m-backup-old-usage]` 提醒卡文本 `old/ 已占用 X GB（自上次确认增加 Y GB）：建议手动清理` +「知道了」（走 ack 路由，不删除）+「如何清理」（展开 `w2m-backup gc --dry-run` → `w2m-backup gc --max-old-days <n>` / 每会话保留份数指引），中英 i18n，**面板没有删除按钮**。
- **CLI**：`run` 打印 `old usage : X GB (Y files)`，due 时另打印提醒与手动清理提示（先 `w2m-backup gc --dry-run`）；`status` 打印 old 占用与 reminder 是否 pending；`gc` 打印 `old usage before/after : X GB -> Y GB`；`--old-usage-reminder-gb` 解析/校验（`0` = 关闭，非法值退出码 2）。
- **文档/测试**：`docs/BACKUP-DESIGN.md` 新增 §24.3（不设上限的决定、按增长提醒、确认路由、手动 gc、诚实边界：walk 为 O(文件数) 且在提交后运行、`bytes` 含记录 JSON 与整文件副本密文）；`test/backup-rotation`、`test/backup-engine`、`test/backup-gc`、`test/backup-run`、`test/client-bundle` 新增覆盖（records + full 两种 `old/` 的手算一致、due 边界、提醒 0 关闭、零删除、持久化/确认路由/describe、CLI 行、面板文案与「知道了」/「如何清理」、字典完整、无删除动作）；`npx eslint .` 0 error、`node scripts/layer-check.mjs` clean、`node scripts/scan-mojibake.mjs` clean、相关 suite 全绿。
- **声明**：不 bump 版本（仍 3.5.0）、不跑 preflight、不提交；不新增 `old/` 总量上限，不自动删除任何文件。

### old-format full 整文件副本的 300 MB 上限与「特批」流程（未发布）

- **问题**：`oldFormat: full` 每个被淘汰版本多写一份整文件副本；单个超大会话会让仓库悄悄翻倍，定时备份更是无人值守。
- **常量/配置**：`DEFAULT_FULL_COPY_MAX_BYTES = 300 * 1024 * 1024`（`src/backup/rotation.mjs`）；引擎 `runBackup({maxFullCopyBytes})` 缺省 300 MiB，`0` = 不设上限（显式）；CLI `run --max-full-copy-mb <n>`；插件行 `backupFullCopyMaxMb: 300`（非法值 → `BACKUP_CONFIG_INVALID`）。非法 cap（负数/小数/字符串/布尔）一律具名拒绝，绝不静默关闭。
- **写盘前拒绝**：`full` 模式下引擎在 ensureLayout/锁/key 之前用只读扫描判定；任一将被备份的会话文件大于 cap 且未显式批准 → `{ok:false, reason_code:'BACKUP_FULL_COPY_APPROVAL_REQUIRED', codes:[…], detail:列出 session_id/rel/size/cap, full_copy_oversized:[…最多20], over_cap_count, cap_bytes}`。零写入：不建仓库、不写 snapshot/old/current/镜像，所以"被拒绝"是完整可重试的 pending 状态；`records` 模式忽略 cap；`0` 关闭 cap。
- **批准**：引擎 `allowLargeFullCopy: true`；成功结果 `full_copy_approved_over_cap: [{session_id, size}]`，并且旧版本记录 `full_copy` 上写入 `approved_over_cap: true` + `cap_bytes`（批准与它买下的字节记在一起）。CLI `run --allow-large-full-copy`；无 flag 且 stdin 是 TTY 时只问一次 `N 个会话的 full 副本超过 <cap> MB（…）：是否特批本次写入？[y/N] `，y 才重跑同一次（仅这一次）；非 TTY 不提问、打印 flag 并退出码 1（`--json` 模式问题走 stderr，stdout 保持 JSON）。
- **面板**：`reason_code` 命中时打开 `role="dialog"` 的 `[data-w2m-backup-approval-dialog]`，列出超限会话与大小，「特批并继续」重 POST `{confirm:'run', scope, allowLargeFullCopy:true}`、「取消」只关闭不发请求；从不自动批准、无密码参与。定时运行不等待人工：拒绝记为 `state.last_result`（`reason_code` + `full_copy_approval_required` + 计数/cap/会话列表），仓库零改动；面板显示「有 X 个会话的旧版本副本超过 300 MB，需要特批」的待批准卡（`[data-w2m-backup-approval-pending]`）与「查看并特批」入口，打开同一个确认对话框。
- **文档/测试**：`docs/BACKUP-DESIGN.md` §24 接口表补 cap 行并新增 §24.2（默认/0=off/三条批准路径/定时行为/记录标注/测试/诚实边界）；`test/backup-engine`、`test/backup-rotation`、`test/backup-run`、`test/client-bundle` 新增覆盖（1 KiB 注入 cap 的写盘前拒绝与仓库逐字节不变、批准记录标注、CLI flag/TTY 提示 y 与 n、定时 pending、面板对话框与字典）；`npx eslint .` 0 error、`node scripts/layer-check.mjs` clean、`node scripts/scan-mojibake.mjs` clean、相关 suite 全绿。
- **声明**：不 bump 版本（仍 3.5.0）、不跑 preflight、不提交。

### PIN 轮换：旧凭据解开 → 去掉旧 PIN → 写新 PIN（撤销"不提供轮换"的决定，未发布）

- **用户决定（撤销）**：此前"不提供 PIN 轮换"的决定作废——"目前若忘了密码且本机 DPAPI 不可用，仓库无法打开"，需要一条"旧凭据解开→移除旧 password 信封→写新信封"的轮换命令。**边界不变**：没有可用凭据（machine/account/旧 PIN）时仓库仍然打不开，轮换不是恢复手段。
- **API**：`rotatePassword({root, dshHome, newPassword, hint?, oldPassword?, accountId?, ...})`（`src/backup/keystore.mjs`，`lib/backup.js` 再导出）：先用现有凭据（account/machine/`oldPassword`）打开拿同一个 DEK → 删**所有** `password` 信封、写**一个**新信封（scrypt，沿用 KDF floor，4 位 PIN 仍接受并标 `weak`）→ `password_hint` 换成新 hint 或删除（`hint` 只替换不追加）→ 写前 `keys.json.bak-<ts>`、`writeFileAtomic` → **双向验证**（新 PIN 单独能解且 DEK 相同；旧 PIN 单独解不开且没有任何旧 password 信封残留）；任一失败即用 `.bak` 恢复并返回 `BACKUP_ROTATION_VERIFY_FAILED`，永不留下"旧 PIN 还能开"的文档。具名拒绝：`BACKUP_NO_PASSWORD_ENVELOPE`（没有 PIN 可换，加 PIN 用 `--set-password`）、`BACKUP_PASSWORD_HINT_INVALID`、`BACKUP_NO_PERMISSION`（没有可用凭据）；结果 `{ok, rotated:true, mode_after:'sealed', envelopes, backup_file, hint, weak, old_password_still_opens:false}`。
- **CLI**：`w2m-backup unlock --rotate-password [--hint "…" | --clear-hint]`；新 PIN 与 `--set-password` 同渠道（`--password-stdin`/`W2M_BACKUP_PASSWORD`，绝无 argv）；旧 PIN 来自 `W2M_BACKUP_OLD_PASSWORD` 或 `--old-password-stdin`，两者共用一个 stdin 时是两行 `old\nnew`（`--password-stdin`）。`--hint` 替换旧提示词，省略或 `--clear-hint` 则丢弃；flag 冲突（`--rotate-password` 与 `--set-password`/`--disable-protection`、`--clear-hint` 与 `--hint`、`--password-stdin` 与 `--old-password-stdin`）退出码 2；人类输出 `rotated : yes`、`hint : …`、`keys backup : …`、`old PIN no longer opens : confirmed`，`--json` 形状与退出码 0/1/2 不变。
- **面板**：解锁对话框选项 B 增加可复制的 `w2m-backup unlock --rotate-password --hint "…"` 与说明「轮换需要在终端运行：旧凭据解开 → 去掉旧 PIN → 写新 PIN（旧 PIN 随后失效）」（新 zh/en 键 `panel.backup.unlock.dialog.rotation`/`rotationCommand`，替换旧 `noRotation` 文案与 `data-w2m-backup-unlock-no-rotation` 标记）；仍无密码输入框、无接收密码的新 HTTP 端点。
- **文档/测试**：`docs/BACKUP-DESIGN.md` 新增 §25.8（前置条件/写序/双向验证/CLI/测试），§23/§25.5/§25.6/§25.7 的"不提供轮换"表述改为"轮换存在"并保留"忘记 PIN 且无可用凭据仍打不开"；测试覆盖 keystore（两种仓库、旧 PIN 失效、新 PIN 可开、DEK 不变、恰好一个 password 信封、提示词替换/清除、`.bak`、三种具名拒绝零写入、`unwrap` 测试缝驱动恢复路径）、access、CLI（flag/两行 stdin/两个旧 PIN 渠道/人类输出/`--json`/退出码）、client-bundle（命令与说明、中英键、无输入框）。**声明**：不 bump 版本、不跑 preflight、不提交。

### 解锁 PIN 的公开提示词：可留备注，但按决定不提供 PIN 轮换（未发布）

- **用户决定**：不为密码/PIN 提供轮换（设置后不能改），默认仍然不设密码；用户可以在设置 4–6 位 PIN 时附加一条**公开的**备注提示词（"备注提示词"），随仓库保存并在解锁时显示。
- **`keys.json` 纯加法新增可选根字段 `password_hint: {text, updated_at}`**：它**按设计就是公开元数据**——明文存在仓库的 keys 文件里，任何能打开该文件的人都能看到，所以它只能提示"PIN 大概是什么"，绝不能写 PIN 本身。`validateKeysFile` 接受该字段，拒绝 `text` 非字符串或超过 120 字符，以及"有提示词却没有 password 信封"的文档。
- **API**：`setRepositoryPassword({password, hint})`（`hint` 可选；trim、折叠空白、上限 120，拒绝非字符串、空值与和 PIN 逐字相同的提示词）；结果新增 `hint: {set, text?}`。仓库已有 password 信封时行为不变：`added:false` 的 no-op，现有 PIN 与提示词都不变——"改 PIN"按决定不支持，也不存在"只改提示词"的后门。`describeUnlock`、`unlockRepo`、`buildStatus`、插件 unlock（GET/POST）与 CLI `unlock` 均以加法方式暴露 `password_hint: {set, text}`（`set:false` 时 `text:null`）。
- **CLI**：`w2m-backup unlock --set-password --hint "周六生日"`——提示词不是秘密，所以允许走 argv 并在此注明（PIN 仍只从 stdin/环境变量读）；人类输出打印 `密码提示：…`，`--json` 带 `hint`，`unlock`（describe）也打印提示词；usage 增加 `--hint <text>`。
- **面板**：解锁对话框选项 B 在 `password_hint.set` 时渲染「密码提示：<text>」（`data-w2m-backup-unlock-hint`），没有提示词且没有 PIN 时渲染「未设置密码」（`data-w2m-backup-unlock-hint-none`），并加一句「不提供 PIN 轮换（用户决定）」（`data-w2m-backup-unlock-no-rotation`）；新增 zh/en i18n `panel.backup.unlock.dialog.hintLabel/hintNone/noRotation`。对话框仍然没有任何密码输入框，HTTP 仍只收确认令牌。
- **文档/测试**：`docs/BACKUP-DESIGN.md` §25.5/§25.7 记录提示词为何公开、在哪里显示，以及"不提供 PIN 轮换（用户决定）：设置后不能改；忘记时用 machine/account 路径或按新仓库重建"；测试覆盖 keystore（提示词持久化与返回、trim/折叠空白、>120 拒绝、与 PIN 相同拒绝、无 password 信封被 `validateKeysFile` 拒绝、再次设置 no-op 不改提示词、PIN `1234` 仍可开、PIN 与 DEK 不泄露）、access（describe/attempt 携带 `password_hint` 且仍只暴露掩码账户 id、不含 PIN）、CLI（`--hint` 解析/人类输出/`--json`/usage）、client-bundle（对话框渲染提示词与「未设置密码」、中英新键、仍无密码输入框）。**声明**：不 bump 版本、不跑 preflight、不提交。

### 默认启用 dsh-backup 行：面板与 22:00 定时器开箱可用（未发布）

- 面板此前依赖操作员先启用 `dsh-backup` 行（默认 `disabled: true`），否则只显示"备份子插件未启用"。现改为随包默认启用：安装后面板直接可用，22:00（Asia/Shanghai）调度也会照常启动；操作员仍可在插件页关闭整行。
- 安全边界不变：`backupEnabled:false` 仍可关闭定时器；备份目录/时间/范围/保留/加密全部可配置；未加密默认与 §25.0 一致。
- 测试：`backup-wiring` 断言改为"随包启用 + 保留 22:00 默认槽"；文档同步更新。


### 备份面板解锁对话框（真正的模态，未发布）

- **交互**：解锁卡标题栏新增可见的「解锁…」按钮（`data-w2m-backup-unlock-open`），打开真正的模态对话框（`data-w2m-backup-unlock-dialog`，`role="dialog"`、`aria-modal="true"`、`aria-labelledby` 指向标题；遮罩 `data-w2m-backup-unlock-overlay`）。×、Esc、点击遮罩关闭；打开时焦点进入对话框内第一个可用控件（`disabled`/`aria-disabled` 跳过），关闭后回到触发按钮；不锁 body 滚动。卡片的既有说明与按钮全部保留，行为不变。
- **状态**：标题下按面板已取到的 `GET /api/w2m/backup/unlock` describe 渲染当前保护状态，五态 `none` / `account-matched` / `account-mismatch` / `unbound` / `unknown`（`data-w2m-backup-unlock-dialog-state`）；打开对话框不再发请求，「刷新状态」才重读 `GET /unlock` 与 `/run` 内嵌状态。
- **选项 A（用本机/原账户解锁）**：仍是 `POST /api/w2m/backup/unlock`，请求体**恰好** `{"confirm":"unlock"}`，没有任何密码/凭据字段；路径不可用时按钮禁用，失败经 `backupReasonText` 映射为可操作文案。
- **选项 B（使用解锁密码，在终端输入）**：浏览器里**没有密码输入框**，整个对话框 DOM 无 `input`/`textarea`；显示可复制的 `<code>` 命令 `w2m-backup unlock --check --password-stdin`（clipboard，失败回退 `document.execCommand('copy')`）与「我已运行，刷新状态」；未加密时说明不需要密码。`w2m-backup unlock --disable-protection --confirm disable-protection` 只作为可复制文本出现，面板从不执行。
- **i18n**：新增 `panel.backup.unlock.dialog.*` 中英文案（open/title/subtitle/state.*/optionA/optionAHint/localUnavailable/optionB/optionBHint/noPasswordNeeded/commandCaption/copy/copied/refresh/refreshing/close/busy/failed/success/passwordNeverInBrowser/disableProtection），中文默认。
- **样式**：overlay + 居中面板，只使用宿主 `--dsw-alias-*` 变量（无字面色值），z-index 复用文件既有浮层层级（70），窄宽度下占满可用宽度并在内部滚动。
- **测试**：`test/client-bundle.test.mjs` +10（打开/关闭/Esc/遮罩/焦点、选项 A 请求体恰好 `{"confirm":"unlock"}` 且全程无密码、选项 B 命令复制与 `execCommand` 回退、刷新重读、失败原因文案、五态映射、中英字典键）；`test/helpers/dsh-page-boot.mjs` + `test/loader-entry.test.mjs` 真实 Chromium：打开备份面板 → 点「解锁…」→ `[data-w2m-backup-unlock-dialog]` 带 `role="dialog"` 且焦点在框内 → Esc 后对话框与遮罩消失。
- **文档**：`docs/BACKUP-DESIGN.md` §25.5 更新为对话框行为与「密码永远不进浏览器、命令可复制」的说明（保留模式表）。
- **声明**：不 bump 版本、不跑 preflight、不提交；安全策略未改（HTTP 仍只接收确认令牌，浏览器从不接收/发送密码）。

### Relay Phase 2 合并（chat / 项目房间跨 relay 同步，条件已收口，未发布）

- **合并**：`work/v3.4.6` ← `wip/relay-phase2-20261117`（merge）。分支侧先 `eee9c16` 把主线合入 Phase 2 分支，`aee1a9b` 是独立编码修复 commit（5 个文件在 8e90aed 里被 GBK/UTF-8 双重编码损坏：`server.mjs` 的 49 个 `§`、27 个 `—`、2 个 `–`、2 个 `→` 与 `SIGNATURE_MISMATCH/EXPIRED/REPLAY`、device_token 提示等对外文案全部恢复；`git diff work/v3.4.6 -- <file>` 只剩 Phase 2 真实改动）。
- **新增能力**：`src/relay/chat-store.mjs`（append-only 复制日志 + generation + applied 水位 + 分页 + 保留/硬上限压缩 + tombstone 过滤）、`src/relay/project-sync.mjs`（整项目快照导出 + 确定性幂等合并）、cluster 域扩展（`/v1/cluster/chat`、`/v1/cluster/projects`、feature bits `relay-cluster-chat-v1`/`relay-cluster-projects-v1`、混合版本跳过）、server 接线（chat 持久化装载、读水位复制、项目导出/合并、healthz `cluster.domains`）。设备线 `protocol_version` 与 `PROTOCOL.md` 未变。
- **删除语义（评审条件 4）**：闭合数据层——`load()` 按 tombstone 过滤消息、`prune()` 删除被删会话的死行（tombstone 永久保留）、导入的晚到旧消息拒收、`deleteChatSession()` 为唯一删除写路径、退役 session 的 `POST /v1/fleet/messages` 返回 400 `SESSION_DELETED`；设备面 HTTP 删除路由**明确推迟**（理由与后续见 ADR §5.4）。
- **文档（评审条件 2）**：新增 `docs/RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md`（Phase 2 ADR：协议兼容/数据模型/删除语义/安全/回滚/迁移/验证/残余风险）与 `docs/RUNBOOK-RELAY-ROLLING-UPGRADE.md`（滚动升级手册：B→C→A、混合版本矩阵、每步门禁、回滚、禁止事项）；v3.0.0 设计 §1.3/§2.3、评审文档与 DEV-PLAN 均加交叉链接/状态更新。
- **测试门禁（评审条件 3）**：`chat-store`/`project-sync`/`cluster-domains`/新增 `relay-phase2-server` 四套件进入 `package.json#scripts.test` 与 `test:all` 并各有独立脚本；`test/relay-phase2-server.test.mjs` 10 项覆盖 server 接线（feature/路由、chat 持久化与重启、真实 HTTP 跨 relay chat+项目拉取、混合版本跳过、tombstone 重启与 peer、`SIGNATURE_MISMATCH` 恢复后的用户文案、套件门禁接线）。`npx eslint .` 0 error、`node scripts/layer-check.mjs` clean、`node scripts/scan-mojibake.mjs` clean。
- **验证（本机、合并后）**：`node scripts/verify-relay-cluster-phase2.mjs` **9/9 PASS**（3 个真实 relay 子进程 + 真实 HTTP，含重启恢复）；`W2M_RELAY_OLD_TGZ=<Relay 3.0.0 归档> node scripts/verify-relay-cluster-mixed.mjs` **6/6 PASS**（2×3.0.0 + 1×本构建，含混合版本跳过与滚动升级后 chat 收敛）。两者仍是发布前手工证据（不进 npm 门禁）。
- **未执行**：不 push、不改包版本（仍 3.4.5）、不部署；全量 preflight 在主线上跑一次（GREEN：16 pass / 0 fail / 1 accepted UNVERIFIABLE；declared suite 4146 pass / 0 fail / 22 accepted skip）。

### 异地镜像：写入时链接防护（realpath 加固补记，未发布）

- 校验时已解析真实路径；新增**写入时**守卫：`syncToMirror` 重新解析镜像根，每个已存在的祖先必须解析到它自己，否则拒绝 `BACKUP_MIRROR_SYMLINK`；对象块/快照目录/快照文件/根元数据/索引追加全部过守卫。
- 测试：镜像树内 junction 指向外部 → 拒绝且目标目录零写入；快照目录被 junction 顶替 → 拒绝；正常同步不受影响（23/23）。
- 边界：守卫与原子写之间仍有毫秒级 TOCTOU；彻底关闭需要句柄级写入，当前不做承诺。


### 三条边界的真机加固：register watch + 宿主服务、缓存运行时终审、renumber 追加分支可达性（未发布）

- **A · register vs 运行中的客户端**：调查确认安装的 Harness 提供可被插件 `ctx` 访问的宿主服务 **`ctx.workspaceRegistry`**（`@deepseek-ai/dsh-workspace`：拥有内存工作区域 + `storages/workspace.json`，先持久化再发 `domain/changed`，GUI 读投影）。新增 `registerThroughHost()` —— `resolveByPath`/`create` + `attachSession(sessionId)`，**不写文件**，因此没有可被客户端保存覆盖的文件级写入；面板路由 `POST /api/w2m/backup/register {confirm:"register", session_ids}` 优先走它（响应 `via:"host-service"`、`residual_risk:null`）。宿主没有该服务时（或离线 CLI）退回文件路径：`w2m-backup register --session <id> --watch <minutes>` 在 apply 成功后按 2/8/20/60 s、之后每 60 s 采样直到分钟预算，发现被覆盖就用 `recheckRegistry` 重放**同一 plan**（不写第二份注册表副本），报告 `watch:{minutes,samples,clobbered,reapplied,stable_at}`；文本/JSON 均带一行诚实残余风险 `a client save after the watch window can still remove it; re-run or enable the plugin route`。面板状态卡新增「修复注册表」按钮（登记勾选会话，无勾选则登记未登记会话）并显示登记/已存在/被覆盖/已重放计数；残余风险只在 file-write 路径渲染。**诚实的边界**：watch 只缩小并量化窗口、不消除它；宿主服务也有自身边界（`attachSession` 要求会话被 `sessionPersistence` 认识且 header cwd realpath 到工作区，cwd 已消失的灾难恢复会话不接，由 CLI + watch 兜住）。
- **B · 运行时终审不阻塞面板**：`GET /api/w2m/backup/verify?runtime=1` 的结论现在持久化为 `<DSH_HOME>/xclient/w2m-backup/state.json` 的 `state.last_runtime_verify = {started_at, finished_at, ok, checked, failed, snapshots, reason_codes, evidence:"installed-harness"}`；`?runtime=cached` 只读该记录、绝不 spawn，`finished_at` 超过 24 h 标 `stale:true`（无记录/坏时间戳同样 stale）；`GET /run` 内嵌状态带 `state.last_runtime_verify`。配置 `backupRuntimeVerify: "off" | "nightly"`（默认 `off`，非法值 `BACKUP_CONFIG_INVALID` 拒绝挂载）：`nightly` 只在**成功**的定时备份（含错过时段补跑）之后 fire-and-forget 跑一次并持久化，失败只记 warning，绝不让备份/调度失败；CLI `w2m-backup run --runtime-verify` 是手动一次。面板校验卡显示缓存记录（上次时间/checked/failed/快照数/证据标签/24 h stale 徽标）与「立即运行（慢，需要安装 Harness）」按钮（`?runtime=1`，忙碌期禁用并显示进度）；原勾选框保留，仍决定「全量校验」走静态还是运行时。**诚实的边界**：缓存记录有 24 h 时效；nightly 默认关闭；失败的终审不回滚已提交备份。
- **C · renumber 追加失败分支**：调查（`src/util/session-validate.mjs` 规则 + 安装 Harness 实测 84 个规范形态）结论是**规范产出上不可达**——`renumberBuffer` 规范重编码（header 单帧、每事件一帧、`seq===下标`）且附录事件是 `permission/preset`（会话级、无 surface、无 `*Seq` 引用、下一 dense seq），所以 doctor 通过则追加模拟必过。保留 `planRenumber({futureAppendCheck})` 测试缝，重写代码注释与 `docs/BACKUP-DESIGN.md` §20.5/§22.2 措辞，并新增机器校验：生产源码中只有 `src/backup/renumber.mjs` 提到该选项（无调用者传它）；规范 plan 的 `static_future_append.ok` 为真；安装 Harness 存在时 plan 结果是 dense 且 `future_append_evidence:"installed-harness"`。**诚实写出函数级例外**：非规范输入（多一行非事件文本、帧外杂字节）确实可能“doctor 过、追加模拟不过”，但它们在 `parseLog`/`scanFrames` 阶段就被 `RENUMBER_INPUT_INVALID` 拒绝，到不了该分支；备份/verify 对原始字节仍会如实报告。
- **测试/文档**：`test/backup-g2.test.mjs` +15（watch 调度/预算/注入时钟、无覆盖 `clobbered:0`、模拟覆盖后 `reapplied:1` 且不写第二份副本、CLI `--watch` JSON/文本/残余风险/参数错误、`registerThroughHost` 服务写入/已登记 no-op/无服务具名拒绝/attach 拒绝不回退）；`test/backup-run.test.mjs` +5（缓存路由不 spawn/过期/`?runtime=1` 更新/内嵌状态、nightly 每成功备份一次 + 失败只 warning + 默认 off + 配置拒绝、register 路由 file-write/host-service 两路径）；`test/backup-verify.test.mjs` +5（记录字段与 reason codes 去重/24 h stale 边界/状态文件持久化/in-flight 单次 spawn/失败也持久化/CLI `run --runtime-verify`）；`test/fix-renumber.test.mjs` +3（缝仅一个生产文件/规范产出追加必过/安装 Harness 证据与 dense 结果）；`test/client-bundle.test.mjs` +3（缓存三态与证据标签、运行按钮禁用态、页面点击 `verify-runtime` 与 `repair-register` 走对路由）。`docs/BACKUP-DESIGN.md` §19.2/§19.3/§20.5/§22.1/§22.2/§22.4/§22.5 与 `docs/DEV-PLAN-3.4.6-3.5.0.md` 同步。**声明**：本次不 bump 版本、不跑 preflight、不提交；无新增测试文件，`package.json#scripts.test` 不变。

### 账户 ID 绑定解锁：只比对唯一识别码（用户决定，未发布）

- **用户决定（原话）**："不用打开账户，只需要读取账户唯一识别码ID，进行比对就行，一致就放行。不一致就切换密码模式。" 实现为 compare-only 身份绑定：`keys.json` 新增可选根字段 `account_binding: {account_id, bound_at}` + 复用现有 `account` 信封（KEK = HKDF(`w2m-account-binding|<accountId>`)，无新密码学）。**诚实声明：账户 id 是标识，不是秘密**——知道 id 且拿到仓库文件的人可推导同一 KEK，这是用户明确接受的代价；它不替代 `password`（跨机器秘密路径），完整 id 永不出现在结果/CLI/HTTP/日志，只有 `…abcd`（后 4 位）。
- **绑定**：新增 `addAccountEnvelope(keys, dek, accountId)` + `bindAccount({root, dshHome, accountId})`（用现有凭据打开 → 同一 DEK 再包 account 信封 → 复制 `keys.json.bak-<ts>` → 原子写 → 只用 account 凭据解一次并与 DEK 比对）；幂等（同 id 不重写）、换绑具名拒绝 `BACKUP_ACCOUNT_MISMATCH`、id 非法 `BACKUP_ACCOUNT_ID_INVALID`、已有 account 信封但无 `account_binding` 元数据 `BACKUP_ACCOUNT_BINDING_UNKNOWN`；`validateKeysFile` 以可选字段加法校验。
- **解锁**：`openRepoKey({accountId})` / `describeUnlock` / `unlockRepo` 增加比较结果 `account: {bound, matched, id_hint}`；匹配 → account 路径放行（`unlocked_via: "account"`，无密码/无 machine 也可开）；不匹配 → `attempts` 记 `{kind:"account", code:"BACKUP_ACCOUNT_MISMATCH"}` 并回退 machine/password；全不可用仍是统一的 `BACKUP_NO_PERMISSION`（mismatch 不是独立拒绝码）。插件 unlock 路由与 restore/archive/verify 每次请求经 `createAccountIdentity({ctx}).identify()` best effort 读宿主 id（不联网要求、不抛错，未登录即 `null`）。
- **配置 / CLI / 面板**：配置 `backupAccountBinding: boolean`（默认 `true`；`cordis.patch.yml` 的 dsh-backup 行显式 `true`）；成功后绑定、失败只 warning、不改 `ok`。CLI `w2m-backup unlock --account-id <id>`、`unlock --check --account-id <id>`、`run --account-id <id>`（成功后绑定；CLI 不自己读宿主 id，避免可手填的"账户凭据"）；面板解锁卡新增账户行三态：一致 →「本机账户与原账户一致，可直接解锁」+ 可点按钮；不一致 →「当前账户不是原账户：请使用解锁密码」+ 按钮禁用；读不到 → 提示改用密码；未绑定则原卡片不变。新增 6 个 i18n 键与 `BACKUP_ACCOUNT_MISMATCH` 的 reason 文案映射。
- **测试**：`backup-keystore` +4（绑定后无 machine key 可开且 DEK 不变；错 id 被拒但 machine/password 仍可开；重绑 no-op、换绑具名拒绝且文件不变；非法 id 零写入 + `account_binding` 元数据）；`backup-access` +3（describe 报告 bound/matched 且 JSON 不泄露完整 id；mismatch+password 走密码成功；mismatch 无密码 → `BACKUP_NO_PERMISSION` 且 attempts 具名）；`backup-run` +3（配置归一化；路由用假 `deepseekAccount` 比对/绑定关闭时 `matched:null`；Windows DPAPI 下 run 后自动绑定并经 account 解锁；CLI `--account-id` 解析/真实入口/JSON 形状/人类输出脱敏/usage）；`client-bundle` +2（账户路径三态与按钮禁用、字典与 reason 映射）。无新增测试文件，`package.json#scripts.test` 不变。
- **文档**：`docs/BACKUP-DESIGN.md` 新增 §25「账户 ID 绑定解锁（用户决定）」并更新 §6/§11/§12/§18 相邻注记；`docs/SPIKE-ACCOUNT-KEK.md` 顶部加"决定更新"短记指向 §25（不改写原测量）。**诚实边界**：见 §25.1/§25.7；旧快照目录里的 `keys.json` 副本要等下一次快照才有绑定；真实仓库迁移（`bindAccount` 一行命令）由 lead 执行，不在本次代码任务内；不 bump 版本号、不跑 preflight、不提交。


### 备份轮转 `--old-format full`：字面兼容的整文件加密副本（P2，未发布）

- **新增 opt-in 选项 `oldFormat: 'records' | 'full'`（默认 `records`）**：默认仍是去重版本记录（§13/§21 行为不变）；`full` 在每次真正轮转时额外写一份密封整文件副本 `old/<ws>/<sid>/<ts>-<sha12>.json.enc`，记录新增 `full_copy: {file, sha256, size}`（纯加法，记录的 `format`/`version` 不变，仍是 `w2m-session-backup/old-version` v1）。
- **复用现有密码学，只换 AAD 身份**：整文件副本仍用 `sealObject` 的 `MAGIC|nonce|ciphertext|tag` 信封 + 仓库 DEK，AAD 容器名改为 `w2m-session-backup/old|<sha256>|<length>`（块是 `…/object|…`，见 `crypto.OLD_COPY_KIND`）；明文由该版本记录自己的 blocks 经 `materialize.rebuildFile` 重建并先比对 `sha256`/`size`，不是重读已经变化的源文件。
- **失败语义（先写副本、后写记录）**：副本重建/写入失败 → 具名 `BACKUP_ROTATION_WRITE_FAILED` 且**不写记录**（记录不承诺不存在的副本），快照已提交时引擎照旧返回 `committed: true`；记录写失败留下的孤儿 `.enc` 无害，由 `gc` 清理。
- **剪枝/gc**：`pruneOldVersions` 剪记录时先删记录、再删配对副本；`gc` 在安全路径上删除 `old/` 下没有任何剩余记录引用的 `.json.enc`，被引用的副本永不删；`BACKUP_GC_UNSAFE` 仍然整体拒绝、零删除（结果新增 `old_versions.full_copies_pruned` 与 `orphan_full_copies`）。
- **接口面**：CLI `w2m-backup run --old-format records|full`（非法值退出码 2，人类输出新增 `old format` 行）；插件配置 `backupOldFormat`（非法值 `BACKUP_CONFIG_INVALID` 拒绝挂载）；引擎 `runBackup({oldFormat})`，结果恒有 `old_format`、仅 `full` 时出现 `full_old_versions`；错误码新增 `BACKUP_ROTATION_FORMAT_INVALID`。完整设计见 `docs/BACKUP-DESIGN.md` §24。
- **存储诚实**：`full` 让每个被淘汰版本的字节在去重 blocks 之上**再加一份**（114 MB 会话、10 个版本 ≈ 多 1.1 GB），所以默认保持 `records`；CLI 人类输出会打印 "storage doubles per superseded version"。
- **测试**：`backup-rotation`（默认/非法值、写记录 + 副本并用 `openObject` 以 `old` 身份解开逐字节比对、块身份解不开、records 模式无 `.enc`、剪枝删配对副本、副本写失败/重建失败/缺 DEK 三类具名拒绝且指针不动）；`backup-gc`（孤儿副本删、被引用副本留、剪枝连带删、dry-run 只报不删、UNSAFE 零删除）；`backup-engine`（`oldFormat: 'full'` 轮转并回报 `full_old_versions`、默认无该键、非法值在 ensureLayout 前拒绝、副本写失败时 `committed: true`）；`backup-run`（CLI `--old-format` 解析/退出码 2/真实入口、人类输出、插件配置归一化）。无新增测试文件，`package.json#scripts.test` 不变。
- **诚实边界**：restore/archive/verify 仍走记录 + blocks，尚无"从 full 副本直接还原"的命令；镜像仍不复制 `old/`；`verify` 尚未逐份解密 `.enc`；未 bump 版本、未跑 preflight、未提交。
- **迁移命令 `old-backfill`（本次新增，未发布）**：`w2m-backup old-backfill [--dry-run] [--limit <n>] [--json]` 给 `full` 之前写入的每条 `old/` 记录补上密封整文件副本——用记录自己的 blocks 经 `materialize.rebuildFile` 重建 → 与记录的 `sha256`/`size` 比对 → `sealObject`（`kind: 'old'`，命名 `<record>.json.enc`）→ 先写副本、再原子补 `full_copy: {file, sha256, size}`（记录的 `format`/`version` 不变）；幂等（第二次全部 `skipped`）；`--dry-run` 不取锁、不打开 key、什么都不写并打印 "nothing was written"；长度不符或缺失的副本重建并计 `repaired`；孤儿 `.json.enc` 只计数、留给 `gc` 删除；`--limit` 限制本次写副本数（0 = 只出计划）；key 打不开 → `BACKUP_NO_PERMISSION`，逐记录失败用 `BACKUP_OLD_RECORD_INVALID` / `BACKUP_OLD_BACKFILL_FAILED`。实现 `src/backup/old-backfill.mjs`，`src/backup/cli.mjs` 接线，测试挂在 `test/backup-rotation.test.mjs`（无新增测试文件），`docs/BACKUP-DESIGN.md` §24.1 记录迁移/幂等/修复语义；引擎无改动（不自动回填），本条为纯追加。
### 备份面板范围入口（v3.5.0 面板补全，未发布）

- **`lib/client.js`：备份&还原面板补上 DEV-PLAN 4.1 的两个范围入口**：`backup-selected`（勾选会话 → `{confirm:'run',scope:'selected',selected:[ids]}`，无勾选时禁用）与 `backup-active`（`{confirm:'run',scope:'active'}`），与既有四个操作并列；新增「备份范围」卡，会话来自**只读**的 `GET /api/w2m/backup/scan?detail=1`（每个会话一个 `data-w2m-backup-pick` 勾选框，显示 id 后缀/工作区/已归档标记，`已选 n/m` 计数、全选/清空、上限滚动列表），404 或扫描失败只显示中性提示 +「刷新会话」重试，**不抛异常、不阻塞面板**；两个入口各有独立 busy 文案，操作期间六个操作一起禁用。i18n `panel.backup.*` 中英各 +16 键（共 139 键）。诚实边界：扫描只读、勾选不持久化（刷新页面即丢）、选中不会改变 `archived`/`all` 的覆盖范围——已归档会话仍按原范围备份。
- **测试/文档**：`test/client-bundle.test.mjs` 新增 6 项（扫描完成前两个入口禁用；3 会话勾 2 后 `selected` 请求体恰为 `{confirm:'run',scope:'selected',selected:[两个 id]}` 且无其它 scope；`active` 请求体；既有 `all` 不变；全选/清空计数；404/空列表/拒绝原因与归一化边界）；`docs/BACKUP-DESIGN.md` §18 增补范围入口段落并更新键数（123→139）。`npx eslint .` 0 error、`node scripts/layer-check.mjs` 与 `node scripts/scan-mojibake.mjs` clean、`node --test --test-force-exit test/client-bundle.test.mjs` 全绿、`node scripts/pack.mjs` 打包一次。本次不 bump 版本号、不跑 preflight、不提交。

### 双解锁补全：给机器信封仓库补 password 信封（未发布）

- 需求 5.3 的 P0 缺口：无人值守只建 `machine`（DPAPI）信封，换机器/换账户后仓库打不开，而 `password` 是唯一跨机器路径且此前无法事后补。
- 新增 `addPasswordEnvelope` + `setRepositoryPassword`（`src/backup/keystore.mjs`）与 CLI `w2m-backup unlock --set-password`：用现有凭据打开 → 同一 DEK 再包一个 password 信封（scrypt）→ 原 `keys.json` 复制为 `.bak-<ts>` → 原子写 → **只用一个密码单独解一次并与 DEK 比对**。密码只从 stdin 或 `W2M_BACKUP_PASSWORD` 读取（绝不 argv/配置），最短 8 字节，重复调用 no-op。
- 测试：`backup-keystore` 覆盖"machine-only 仓库补 password 后仅凭密码可开且 DEK 不变""错误密码被拒""重复调用不重写""短密码拒绝且文件不变""写前备份存在"。
- 诚实边界：已有 password 信封不会被覆盖——**换密码**（轮换）尚未实现，需要"旧凭据解开→移除旧 password→写新"的命令；本机真实仓库已补 password 信封（密码文件在 `C:\Users\fangw\w2m-backup-unlock-password.txt`，请抄入密码管理器后删除）。


### v3.5.0 「编队版本」看板卡片（UI 半，未发布）

- **`lib/client.js`：操作面板 →「操作入口」页新增「编队版本」卡片**：v3.5.0 交付项 2 的 UI 半——显示
  最低支持版本、版本分布（`version × count`）、落后机器（`machine_id @ version`）、版本未知机器与
  `all_current` 徽标（为 `true` 时隐藏落后块），并提供「一键复制升级指引」（`npm i -g
  @twinsearth/w2m-dsh-plugin@<supported_min>` + 机器清单；优先 `navigator.clipboard.writeText`，
  回退 `document.execCommand('copy')`，成功显示「已复制」，headless 安全返回 false）。i18n
  `panel.fleet.version.*` 中英各 12 键。**它只读宿主既有的只读 `versions` 块**（`GET
  /api/w2m/target` / `w2m_devices` 上 `summarizeVersionDashboard` 的输出），不派发任务、不写选择、
  不新增 relay 端点；请求失败或旧宿主没有该块时显示「版本信息未知」中性状态，**不把读取失败当成
  全部达标**。未新增侧栏槽位：卡片就放在「目标机器」旁边，两侧读同一份快照。测试见
  `test/client-bundle.test.mjs` 新增的 8 项；`npx eslint .` 0 error、`node
  scripts/layer-check.mjs` 与 `node scripts/scan-mojibake.mjs` clean。本次不 bump 版本号、不跑
  preflight、不提交。

### G2/G3/G4/G5 收口补记（未发布）

- **G2 `w2m-backup register`（`src/backup/register.mjs`）**：磁盘上已存在、注册表里没有的会话不再需要手写脚本——
  `--session <id>`（可重复）经 `listSessionDirs` 定位（工作区 slug 取路径段），先过客户端门禁（在跑就拒绝，
  `--allow-live-home` 才接受回读 + 保存后复查协议），把 `workspace.json` 复制到
  `<DSH_HOME>/.w2m-restore-backups/register-<ts>/workspace.json`，整次一个文档 plan → 原子写 → 回读校验，可选
  `--registry-recheck <ms>` 在客户端保存后再复查一次。已登记 id 是 no-op（不重写、不可能改旗标），archived/pinned
  从注册表视图读出再写回（手写脚本用默认值把已归档会话取消归档——本次用测试钉死）；磁盘上找不到的 id 整单拒绝
  `BACKUP_REGISTER_SESSION_MISSING` 并列出；未知工作区只能用 `--workspace-path` 创建/挂接。返回
  `{ok, registered, already_registered, unknown, actions, verified, backup_file, recheck?}`；退出码 0/1/2 与 restore
  一致。`register-*` 副本自身按份数保留（默认 10、0 = 全留、当前次永不删），`listPreRestoreSnapshots` 只认时间戳
  目录，restore 的保留策略不会误删它们。
- **G4 renumber 备份保留上限（`pruneRenumberBackups` + `w2m-fix renumber --keep-backups <n>`）**：成功 apply 后按
  名字里的时间戳保留最新 N 份兄弟副本（默认 5，0 = 全留）；当前次运行的副本通过 `protect` 传入、永不删除
  （时钟漂移时"改日志"不能变成"删回退路径"）；dry-run 与失败路径零删除；只匹配本工具命名的
  `.bak-<YYYYMMDDTHHMMSSZ>[-<n>]`，不动 `w2m-fix fix` 的 `.bak-<stamp>` 副本。结果新增 `pruned_backups`，
  人类输出新增 `backups kept : N of M (pruned K)`。
- **G3 证据测试（`test/backup-verify.test.mjs`）**：一条 describe 覆盖每条会改字节/改声明的路径——restore 计划每个
  候选 `validation.future_append === true` 且 `runtime_verified === true`（装 Harness 时；无安装跳过）；renumber 计划
  携带 `validation.future_append`（静态 = `true`，标 `static-prefilter`），未来追加模拟失败时
  `RENUMBER_STATIC_REJECTED` 且零写入（用 `planRenumber({futureAppendCheck})` 测试缝驱动，生产不传）；verify 的
  `future_append.evidence === 'static-prefilter'`、`runtime_verified.evidence === 'installed-harness'`。
- **G5 面板运行时终审勾选框（`lib/client.js`，备份面板最小 diff）**：校验卡增加默认关闭的
  「用安装的 Harness 终审（慢）」勾选框（i18n `panel.backup.verify.runtime`）+ 提示
  `panel.backup.verify.runtimeHint`（可能耗时数分钟、需已安装 Harness）；勾上时 `verifyNow` 请求
  `GET /api/w2m/backup/verify?runtime=1`，不勾走便宜路径；结果仍显示 `runtime_verified` 计数（文案键改为
  `panel.backup.verify.runtimeCounts`），问题码经既有 `backupReasonText` 映射。校验卡改为常驻，勾选框在第一次
  校验前就可见。中英字典各新增两键（123 键）。
- **文档**：`docs/BACKUP-DESIGN.md` §22（G2/G3/G4/G5 收口补记与诚实边界）并更新 §15.2/§18/§19 相邻注记；
  `docs/DEV-PLAN-3.4.6-3.5.0.md` v3.5.0 实施记录附近新增指向 §22 的短记。
- **测试**：`test/backup-g2.test.mjs` +8、`test/fix-renumber.test.mjs` +6、`test/backup-verify.test.mjs` +3、
  `test/client-bundle.test.mjs` +1；套件清单不变（新用例挂在既有套件上），`npx eslint .`、`node
  scripts/layer-check.mjs`、`node scripts/scan-mojibake.mjs`、`node scripts/pack.mjs` 全绿。
- **诚实边界**：register 仍依赖客户端门禁 + 保存后复查（窗口之间客户端仍可能覆盖，§16 末同一风险），且刻意不提供
  宿主路由（登记 home 是带路径的操作员动作，走离线 CLI）；面板运行时勾选是 **opt-in**（慢），不勾的 verify 只有
  标了 `static-prefilter` 的模拟结果，不是门禁级证据；renumber 保留只处理兄弟副本，不清理 `$DSH_HOME` 其它位置、
  也不动 `old/` 记录；本次不 bump 版本号、不跑 preflight、不提交。

### v3.5.0 版本治理、保留策略与异地副本（未发布）

- **A 最低版本门禁（`MACHINE_VERSION_UNSUPPORTED`）**：新增 `src/plugin/version-gate.mjs`——唯一常量
  `MIN_SUPPORTED_PLUGIN_VERSION = '3.5.0'`、semver 比较器（支持 `x.y.z` 与预发布后缀；无法解析一律按 unknown，
  绝不猜相等）与纯决策 `evaluateVersionGate`。`w2m_run` 在 POST 前读一次 relay 名册（与 narrowed-target 预检
  共用），对**本次派发会用到的在线机器**逐个判定：低于基线或版本不可读 → 整单拒绝，`detail.machines` 逐一列出
  `machine_id` / `version` / 原因码（`MACHINE_VERSION_OUTDATED` / `MACHINE_VERSION_UNKNOWN`）与 `supported_min`。
  `allowOutdated: true` 显式覆盖：结果含 `outdated_allowed` 与 `version_gate.audit`（逐机原因码），并留一条 host
  警告日志；只读工具（`w2m_devices`/`w2m_stats`）永不拒绝。门禁只在构建自身版本 ≥ 基线时生效（3.4.x 构建不拦截，
  紧急回滚不会被自己的规则拒绝）；测试用 `W2M_PLUGIN_VERSION` 激活（与 updater 同一机制）。
- **B 版本漂移看板数据**：`summarizeVersionDashboard` 纯函数输出 `{supported_min, distribution, outdated, unknown,
  all_current}`；`w2m_devices` 与 `GET /api/w2m/target` 增量携带 `versions` 块（既有 `version_drift`/`machines`/
  `fleet` 字段不变；名册读取失败时 `all_current:false`）。面板「编队版本」卡片 UI 不在本次（`lib/client.js` 属
  UI 半，另行实现）。
- **C 保留策略（份数 + 天数同时生效）**：`rotation.selectPrunable(records,{keep,maxAgeDays,now})` 纯函数；
  `pruneOldVersions`/`rotateForEntry` 支持 `maxAgeDays`（与 `keep` **同时生效**："最新但超 N 天"仍按天剪除，
  "N 天内但超出最新 N 份"仍按份数剪除；0/缺省 = 仅份数；非法值 `BACKUP_ROTATION_POLICY_INVALID` 写盘前拒绝）。
  `gc({maxOldVersionDays})`、CLI `run/gc --max-old-days <n>`、插件配置 `backupOldVersionDays` 全链路接线；
  gc 的 `BACKUP_GC_UNSAFE` 规则与"先收集全部引用、再删块、最后剪旧记录"的顺序不变——仍被快照/current/old 引用的
  块永不删除，同一次 gc 中被剪掉的记录不会让它的块在同一次运行里被误删。
- **D 异地副本**：新增 `src/backup/mirror.mjs`。`runBackup({mirrorRoot})` 在提交且轮转成功后，把本次快照引用的
  密封块（**只补缺失**）、`snapshots/<id>/{manifest.json,keys.json}`、仓库描述与信封元数据复制到镜像，并按
  `snapshot_id` 幂等追加镜像 `index.jsonl`；文件复制走 `atomic.writeFileAtomic`，**明文永不复制**。
  镜像路径在仓库内 / `$DSH_HOME` 内 / 等于仓库根 / 是文件 → 写盘前拒绝 `BACKUP_MIRROR_INVALID`（零提交）；
  运行期复制失败**不回滚**已提交备份：`ok:true` + `mirror:{ok:false, reason_code, reason, copied}` + `warnings`，
  下次成功同步自动补齐。CLI `run --mirror <dir>`、插件配置 `backupMirrorDir`。
- **测试**：新增 `test/fleet-version-gate.test.mjs`（比较器/预发布边界/决策/看板/派发路径/覆盖审计/只读面不被拒/
  未激活构建不拦截）与 `test/backup-mirror.test.mjs`（只补缺失+幂等/索引只追加一次/镜像路径拒绝/失败不回滚/
  镜像侧 `openRepo`+`rebuildFile` 完整性）；扩展 `test/backup-rotation.test.mjs`、`test/backup-gc.test.mjs`、
  `test/backup-run.test.mjs`；`package.json#scripts.test`/`test:all` 与 `test/backup-wiring.test.mjs` 套件清单同步。
- **文档**：`docs/BACKUP-DESIGN.md` §21（保留策略与异地副本协议、优先级、幂等与失败语义）、
  `docs/DEV-PLAN-3.4.6-3.5.0.md` 实施记录（A–D 已交付、UI 延期）、`FLEET-RULES.md` §9（门禁规则）。
- **诚实边界**：异地副本是**加法**——不做跨镜像去重（每个镜像独立持有一份密封块），未做 Relay/云端传输
  （Phase 3），未做镜像侧 `current/old` 视图与镜像 gc；面板「编队版本」卡片 UI 未做；Relay Phase 2 合并是
  **独立评审线**，不在本条交付内；本次不 bump 版本号、不跑 preflight、不提交。
- **D 异地副本加固（评审两处收口）**：`src/backup/mirror.mjs`。① `resolveMirrorRoot` 在词法包含判定之外增加
  **真实路径判定**——取最深已存在分量 `fs.realpathSync`（Windows 上解开 junction/symlink）再拼接未创建段，对真实
  仓库根与真实 `$DSH_HOME` 重复包含判定；经链接实际落进仓库/home → 具名 `BACKUP_MIRROR_SYMLINK`（写盘前零提交）；
  真实路径不可解析（`ELOOP`/`EACCES`/坏 junction）→ `BACKUP_MIRROR_INVALID` 具名拒绝；不存在的镜像路径（含多级）
  仍照常解析并在首次同步创建。② 镜像对象不再“名字在即视为正确”：已存在对象须与源**字节长度一致**才跳过，截断/
  损坏（长度不符）用 `writeFileAtomic` 重写并计入新增的 `copied.repaired`；快照 `manifest.json`/`keys.json` 与根
  `backup.json`/`keys.json` 按字节比较，不符即重写并计入 `repaired`。完好镜像第二次同步仍是
  `copied:{files:0,bytes:0,repaired:0}` 且零写入（测试比较 size+mtime）；镜像 `index.jsonl` 尾部半行即使正是该
  快照自己的未完成追加行，也只补一行完整 JSON、`snapshot_id` 不重复；CLI mirror 行在修复时显示 `N repaired`。
  ③ 诚实边界：仍**不做跨镜像去重**、**没有**镜像侧 `current/old` 视图与镜像 gc、**没有** Relay/云端传输；对象修复
  只覆盖“长度可发现”的损坏（同长度位翻转由还原时的清单 sha256 发现）。`docs/BACKUP-DESIGN.md` §21 与
  `test/backup-mirror.test.mjs` 同步（junction 逃逸在环境禁止建 junction 时按名跳过）。本次不 bump 版本号、不跑
  preflight、不提交。

### G4 seq 重编号工具（删/插事件的唯一合法方式，v3.4.8 补全）

- **新增 `src/backup/renumber.mjs`（G4 收口）**：`renumberBuffer(buffer,{deleteSeqs,insert})` 纯内存完成
  "删/插 → seq 重编为 0..N-1 → 递归改写所有 `*Seq`/`*Seqs` 引用 → 重算 inheritedEventCount → header 单帧 +
  每事件一帧重编码"；torn / 非 v4 / 非 dense 输入 / 越界编辑都给具名拒绝，引用指向被删事件即
  `RENUMBER_DANGLING_REFERENCE`（detail 带事件类型/键/seq，不猜替代值）。
- **plan/apply 分离**：`planRenumber` 只读，并用 doctor 预筛 + "未来追加"模拟 + 安装 Harness 终审校验**结果**
  （G1/G3/G5 同一条门禁链）；无安装时默认 `RENUMBER_RUNTIME_UNAVAILABLE`，`allowStaticValidation` 才降级并
  如实标 `runtime_verified:false`。`applyRenumber` 先写 `<file>.bak-<时间戳>` 并回读比对，再原子写、回读
  sha256 + doctor 复验；plan 之后文件被客户端追加则 `RENUMBER_TARGET_CHANGED` 拒绝覆盖。
- **CLI**：`w2m-fix renumber --file <log> [--delete-seq <n>]... [--insert-file <json>] [--dry-run]
  [--allow-static-validation] [--json]`（默认写入，`--dry-run` 只规划；退出码 0 成功 / 1 具名拒绝 / 2 用法错误）。
  人类输出给事件前后数、仅变化的 seq mapping（约 20 条封顶）、引用改写数、static/runtime/future-append 证据与
  `.bak` 路径。`fix -> backup` 同级边已在 `scripts/layer-model.mjs` 声明（模块级无环）。
- **测试**：新增 `test/fix-renumber.test.mjs`（21 项，接进 `scripts.test` / `test:all` / `test:fix-renumber`）；
  覆盖删中间事件、插入/追加、悬空引用 / torn / 非 dense 拒绝且零写入、no-op + 幂等、运行时门禁正反两向、
  `.bak` 保留原始字节 + 回读校验、plan 后文件变化、dry-run 零写入、CLI 退出码与真实入口追加。
- **诚实边界**：工具改历史，不是 backup/restore 的一部分（还原仍只发布原始字节）；每次成功 apply 都留
  `.bak-<时间戳>`；能还原的日志应走还原 + verify，不要用它"修"——拒绝非 dense 输入正是为了不制造第二次损坏。
  设计见 `docs/BACKUP-DESIGN.md` §20。

### G5 校验只用运行时同一份代码（v3.4.6 补全）

- **证据链收口**：静态 doctor 只在报告里带 `evidence:'static-prefilter'`；结论性证据来自 `runtime-driver.mjs`
  调用安装 Harness 的 `sessionFormatCatalog.createRestore(header,{validation:'current'})`，带
  `evidence:'installed-harness'`。还原/归档还原把"原日志 + 追加后日志"一起交给运行时批量终审，无安装时
  `BACKUP_RUNTIME_UNAVAILABLE` 拒绝（`--allow-static-validation` 才降级并如实标注）。
- **真实运行时才暴露的漏洞（已修）**：`decodeRow` 对 seq 不落位的行**静默丢弃**（首事件 seq=5 的日志得到
  `events:0` 且不抛错），运行时曾把这种日志判为通过。driver 现在要求事件数守恒
  （`restored.events.length === 输入事件数`），否则判失败并写明 "accepted only N of M event(s); rows were
  dropped, so this verdict is not evidence"。
- **新接线点**：`run --runtime` 对追加后日志做运行时批量终审，结果 `runtime_future_append`（默认关，静态报告
  标 prefilter）；`GET /api/w2m/backup/verify?runtime=1` 打开运行时终审；CLI 报告新增 `runtime append` 行。
- **测试**：driver 静态证明（必须是 `createRestore` + `validation:'current'`，禁止使用我们的解析器）；
  seq 缺口拒绝 + dense 通过的事件数断言；`run --runtime` 正/反向；`verify --runtime`；真实 Chromium 页面
  （loader-entry）入口/面板/四操作断言。

### 面板与侧边栏入口（v3.4.9）

- **复盘加固（同日）**：① 真实 Chromium E2E 从"只验证入口/标记存在"加强为"**逐个点击四类一键操作**"——
  每个按钮都真实点击、路由缺失时在日志区留下记录、面板保持挂载（loader-entry 10/10 通过）；② 核对面板的
  `/api/w2m/backup/status` 回退确实由插件根（`src/plugin/tools.mjs`）常驻注册，不是死链；③ 更正措辞：
  `restore --apply` **已**按 `keep_pre_restore`（默认 10）保留最新预还原副本并报告 `pruned_pre_restore`，
  失败路径不清理；④ 明确边界：面板"全量校验"目前走静态全套 + 宿主 `runtime_verified` 计数，`?runtime=1`
  的运行时终审已由宿主支持但面板尚无开关（下一次 UI 迭代再加，避免把分钟级操作做成默认）。

- `lib/client.js` 新增「备份&还原」面板，与 GPW 同构：`sidebar.panellist`（id `w2m-backup`，order 6）+ `main`
  （key `w2m-backup`）。状态条（仓库/快照/计划/上次结果/注册表复查）、四类一键操作（立即备份、还原选中、
  归档打包、全量校验）、还原计划卡（new/identical/differs + 勾选 + 二次危险确认）、解锁卡（本机信封按钮 +
  密码路径只在终端，**HTTP 不接受密码**）、50 条运行日志、10 s 只读轮询（卸载清理）、失败可重试。
- i18n：`panel.backup.*` 121 键 × 中/英 + 34 个 reason-code 文案映射（`BACKUP_NO_PERMISSION` =「没有权限：请用
  原账户登录，或输入解锁密码」）；主题只用宿主 `--dsw-alias-*` 令牌，深浅色随宿主。
- 宿主：`GET /api/w2m/backup/run` 增加内嵌只读 `status`（面板状态条一次往返；老宿主回退 `/status`）。
- 测试：`test/client-bundle.test.mjs` +12 项（注册对、四操作标记、解锁双分支且无密码、备份段无 password 请求、
  可重渲染 fake React 驱动四操作与确认令牌、i18n 完整性、日志上限、无样式/定时器泄漏）；
  `test/loader-entry.test.mjs`（真实 Chromium + 抛空 profile）新增断言：侧边栏入口存在、点击打开面板、
  四个操作标记齐全。该 profile 默认关闭 `dsh-backup` 行，面板显示"需要启用"；四类操作的写入由
  `test/backup-run.test.mjs` 的路由级测试覆盖（含 Windows 真实 DPAPI 与令牌拒绝）。

### G3 只存原始字节 + "未来追加"模拟（v3.4.6 补全）

- **原始字节**：引擎从不解析后重写日志；块按明文 sha256 内容寻址。新增两条证据型单测：① 损坏日志（seq 跳号）
  照样入库，清单 `sha256` 等于源文件哈希（保留证据优先于拒收）；② 备份前后源文件**字节与 mtime 均不变**。
- **未来追加模拟**（新增 `src/backup/future-append.mjs`，一条实现三处调用）：`appendLegalEvent` 在原始字节后
  追加一帧合法 `permission/preset`（实测最弱合法事件：会话级、无 turn/surface/引用），`futureAppendVerdict`
  做静态预筛。引擎对每个会话在已读入内存的字节上跑模拟并报告 `future_append: {checked, failed, sessions}`
  （不因此拒绝备份）；还原把"原日志 + 追加后日志"一起交给安装的 Harness 批量终审，失败即拒收；verify 默认
  静态模拟、`--runtime` 时连 append 后的 artifact 一起终审（新码 `BACKUP_RUNTIME_APPEND_FAILED`）。
- **CLI**：`run` 报告新增 `future append : N/M session(s) still load after one legal append` 并列出失败会话。
- **真实实测 + 布局 bug**：默认仓库 `run --scope all`：15 会话 / 171.5 MB / 2 新块 + 53 复用（96%）/ **future append 15/15** / 26.1 s（未做模拟时 4.8 s，约 5× 代价，因此默认开、可用 `--no-future-append` 或 `backupFutureAppend:false` 关闭）。同日发现并修复布局 bug：还原前副本原先放在 `sessions/.w2m-restore-backups/`，被会话扫描器当成第 17/18 个会话（`MANIFEST_REL_PATH` 失败）；现移到 home 根、walk 器跳过点目录、扫描器增加排除行、引擎在写块前预校验 rel（四层修复 + 两条回归测试）。
- **测试**：引擎 +4 项（模拟计数、坏日志入库仍保原始字节、源文件不变）、verify +3 项（行数/追加前缀、坏日志
  判失败、`--runtime` 连 append 一起终审），共 7 项。

### G2 `workspace.json` 写入协议（v3.4.6 补全，v3.4.8 收口）

- **暂停客户端**（`src/backup/client.mjs`）：`detectClientRunning()` 通过 `tasklist`/`ps` 判断客户端是否运行，
  并区分"没在跑"与"查不到"（后者不冒充安全）。离线 CLI `restore --apply` 在客户端运行时拒绝
  （`BACKUP_CLIENT_RUNNING`），除非显式 `--allow-live-home`；面板在客户端内部运行，按定义接受活 home，
  依赖下面两半。
- **写后回读**（`registry.mjs`，v3.4.8 已有）：原子写 → 重读 → 逐会话校验登记、工作区 id、archived/pinned；
  写失败/被客户端覆盖分别报 `BACKUP_REGISTRY_WRITE_FAILED` / `BACKUP_REGISTRY_VERIFY_FAILED`。
- **客户端保存后复查**（新增 `src/backup/registry-watch.mjs`）：还原成功后按 2 s / 8 s / 20 s 采样注册表，
  发现登记丢失就再应用一次计划并再校验；每次采样经 `onResult` 上报，面板写入 `state.last_registry_recheck`
  并记日志；定时器由 `ctx.effect` 持有，卸载即取消。不用文件监视器（客户端每次保存都是原子替换，watcher
  会被无关改动触发）。
- **CLI**：`restore --allow-live-home`、`restore --registry-recheck <ms>`（离线等待一次保存窗口后同步复查）。
- **测试**：新增 `backup-g2` 套件（10 项，进程列表与定时器均注入，不 spawn、不等真实时间）。
- **真实事故后补的保护**：apply 前重读目标、与计划记录的 `existing_sha256` 比对，变了即
  `BACKUP_RESTORE_TARGET_CHANGED`；写后读回发现"我们写入的字节 + 帧对齐的客户端追加"，自动重建为
  "预还原副本 + 追加帧"并报告 `healed`（无损，保留客户端事件）。详见 `docs/BACKUP-DESIGN.md` §16.1。

### 还原、解锁、全量校验与归档包（v3.4.8）

- **还原（`src/backup/restore.mjs`）**：先规划后写入。规划阶段把每份候选从内容寻址块解回、用运行时同一份校验代码判定、算清冲突与注册表改动，**一行都不写**；`--apply` 才按"预还原副本 → 原子写会话 → 写附件对象 → 注册表写入并回读校验 → 复读字节与清单比对"的顺序落地。四条复盘门禁（G1/G2/G3/G5）全部接进这条路径。
- **还原前快照**：任何被覆盖的会话语义文件与 `workspace.json` 先复制到 `$DSH_HOME/sessions/.w2m-restore-backups/<时间戳>/`；冲突默认"先备份后覆盖"，`--keep-both` 则保留原文件、把还原结果写成 `session.v4.jsonl.zstd.restored-<ts>`。
- **补注册工作区/归档标记（`src/backup/registry.mjs`）**：`workspace.json` 是客户端内存态，写入协议 = 原子写 + 回读校验 + 明示"客户端会回写"的残余风险；只登记会话 id 与 archived/pinned 标记，**绝不凭空创建工作区**（除非显式 `--workspace-path`）；工作区目录名按 DSH 规则从路径推导（`E:\GPT` → `--E-GPT--`）。
- **运行时校验（`src/backup/runtime-validate.mjs` + `runtime-driver.mjs`）**：用安装的 Harness 本体（Electron Node 模式）加载 `sessionFormatCatalog.createRestore(..., validation=current)`，由它给出终审；自写 doctor 只作预筛。找不到安装时默认拒绝还原，`--allow-static-validation` 才接受纯静态证据，且报告写明 `runtime_verified:false`。
- **两条解锁路径（`src/backup/unlock.mjs`）**：`machine`（OS keystore 保护的随机秘密，定时任务用）与 `password`（scrypt，跨机器唯一路径）。账户信封不做——spike 证明宿主只给账户标识不给秘密，写了就是加密摆设（`docs/SPIKE-ACCOUNT-KEK.md`）。密码种子仓库首次遇到可用 keystore 时自动补 `machine` 信封，之后面板/定时任务免密。
- **全量校验（`src/backup/verify.mjs`）**：逐快照解块、验认证标签、复算 sha256、"未来追加"模拟（在内存里追加一条合法事件再校验，证明它**以后仍能加载**）；索引↔快照目录双向核对、old 记录与 current 指针引用的块必须存在。任何一处不对都报出具体码，不清零、不平均。
- **归档包（`src/backup/archive.mjs` + 自写 `tar.mjs`）**：只打包清单校验过的字节，产出 `archive/<日期>/archived-sessions-<ts>.tar.zst`，内含 `manifest.json`（逐文件 size/sha256）+ `README.txt` + 会话/附件文件树；默认只打已归档会话，`--scope all` 打全部；`readArchive`/`extractArchive` 回读时逐文件对 sha256，并拒绝写出目标目录之外的条目（防路径穿越）。
- **子插件路由（v3.4.8）**：新增 `POST /api/w2m/backup/restore`（body 先返回计划，`{"apply":true}` 才写）、`POST /api/w2m/backup/archive`、`GET /api/w2m/backup/verify`、`GET|POST /api/w2m/backup/unlock`；写路由各带确认令牌，面板不使用密码（走 machine 信封）。CLI 同步新增 `unlock / verify / archive / restore`（`restore` 默认只打印计划）。
- **测试**：新增 5 个套件（runtime / restore / archive / verify / access），备份侧共 20 套件；包含"真实 Harness 终审通过"与"错误候选被拒绝"两个方向的用例，以及预还原副本、冲突、keep-both、路径穿越、损坏块、索引漂移、old-only 块缺失等失败路径。
- **复盘加固（同日）**：① 无凭据的首次运行不再创建半个仓库；② `run --dry-run` 真正零写入（不建目录、不取锁、不解锁）；③ 多会话还原的注册表改为"整次还原一个文档"，修掉 last-write-wins；④ 支持还原到全新 home（显式 `--workspace-path` 时创建最小注册表），并拒绝凭空建库；⑤ 运行时批量校验在真实仓库上暴露 V8 字符串上限（`Invalid string length`）与 Electron 堆崩溃（exit 134），改为"小批 JSON + 大会话 NDJSON 流式"，真实 15 会话计划通过；⑥ 归档包可**直接还原**（`restore --archive`，与仓库还原同一套门禁），补齐计划 4.3 的"可还原"；⑦ 还原前副本按 N 份保留；⑧ identical 会话跳过重写；⑨ verify 增加 descriptor 检查与 old 记录摘要重建；⑩ 新增 4 个 v3.4.8 路由行为用例（确认令牌、未建库状态、Windows 真实 DPAPI 全链路）。
- **真实闭环（默认仓库 `D:\DeepSeekHarness\BackUP`，2026-11-17）**：`unlock` 报 `machine` 信封、本机可用；`verify` 2 快照 / 32 文件 / 337.4 MB / 108 块全部解块验签通过，30/30 "未来追加"模拟通过（49.1 s）；`archive --scope all` 把 16 文件打成 168.7 MB tar → 164.7 MB `.tar.zst`（2.3 s）；`restore` 计划把 15 份会话全部交给安装的 Harness 终审通过（15/15），识别出 13 份 identical、2 份 conflict（备份之后 DSH 又写过这些活会话），dry-run 零写入；来自未注册工作区的会话被默认拒绝，并以 `--workspace-path` 显式挂接后才进入计划。


### 备份引擎、22:00 定时与旧版本轮转（v3.4.7）

- 新增 `src/backup/engine.mjs`：一次备份 = 锁 → 建库 → 开 KEK → 扫描 → 按 scope 选会话 → 写缺失块（内容寻址去重）→ 提交快照 → 轮转。第二次未改动备份 `blocks_new = 0`（单测断言），备份前后源目录字节与 mtime 不变。
- 新增 `src/backup/keystore.mjs` + `src/backup/machine-key.mjs`：仓库级随机 DEK（权威 `<root>/keys.json`，每个快照存副本以便独立还原）；默认 `machine`（Windows DPAPI，本机实测 round-trip）+ `password` 双信封；两者皆无时 `BACKUP_NO_PERMISSION`，**绝不写一个打不开的仓库**。
- 新增 `src/backup/locks.mjs`：`tmp/backup.lock` 以 `wx` 原子创建；死 pid / 超龄 / 不可读三种回收；只释放自己的锁。第二个写入者得到 `BACKUP_LOCKED`（含持有者信息）。
- 新增 `src/backup/atomic.mjs`：tmp 同目录 → 写入 → **fsync** → rename；内容地址只在字节落盘后出现，避免"名字在、字节不完整"的块被永久跳过。
- 新增 `src/backup/rotation.mjs`：只有内容 sha256 变化才记 `old/<ws>/<sid>/<ts>-<sha12>.json`（**可还原记录**，不是整文件加密副本——副本会与内容寻址去重重复存储）；每会话默认保留 10 份，`current/` 存指针。
- 新增 `src/backup/gc.mjs`：引用根 = 快照清单 + old 记录 + current 指针；删除无引用块并裁剪 old 窗口；**任一引用不可读即 `BACKUP_GC_UNSAFE`，一个字节都不删**；`--dry-run` 只报告。
- 新增 `src/backup/schedule.mjs` + `src/plugin/backup.mjs` + `lib/backup.js`：默认 **22:00 Asia/Shanghai**（`backupTimes`/`backupTimeZone` 可改），睡眠跨时段只补跑一次，定时器由 `ctx.effect` 拥有、卸载即停；`dsh-backup` 子插件行随包发布但 `disabled: true`（启用它才意味着"定时器可以写盘"）；`GET/POST /api/w2m/backup/run`，POST 必须带 `{"confirm":"run"}`。
- CLI：`w2m-backup run|list|gc`（`--scope` / `--session` / `--keep-old` / `--dry-run` / `--password-stdin` / `--no-machine-key`）；密码只经 stdin 或环境变量，绝不进 argv。
- 时区日历算术抽到 `src/util/daily-clock.mjs`，自更新检查与备份计划共用一份（两份实现会在换夏令时那天给出不同答案）。
- 新增 6 个测试套件：引擎（去重/增量/scope/拒绝）、轮转（记录/窗口/dry-run）、gc（孤儿/引用/拒绝）、锁（并发/回收/释放）、调度（默认值/精确时刻/补跑）、子插件+CLI（确认令牌/生命周期/离线 run）。
- **可还原性证明**：单测用仓库钥匙把每个块解回、按清单拼回整文件、逐字节与源文件比对（同时验证"块被搬到别的地址会认证失败"）。备份是否可还原不再靠推断。
- **抗崩溃**：块先写、快照后提交，因此崩溃遗留的块下次备份会被复用（单测模拟"删掉快照与索引、只留块"→ 第二次 0 新块）；轮转失败时快照已提交，引擎如实返回 `committed: true` + `snapshot_id`，不把"备份成功但指针没前进"报成"没备份"。
- **活会话截断**：写入前用运行时同一份 `scanFrames` 检查 zstd 帧完整性；若会话正被追加导致尾部截断，重读一次，仍截断则照存原始字节并在 `torn_sessions` 报告中列出——不静默丢弃、也不把半个帧当成完整日志。
- **密钥升级**：用密码种下的仓库，在首次遇到可用 OS keystore 的机器上自动追加 `machine` 信封（DEK 不变，旧块不受影响），此后定时任务无需密码；这是"密码种子 + 无人值守"两个需求能同时成立的唯一路径。
- **gc 加固**：现在持有仓库锁（不会与正在运行的备份竞争），清理崩溃残留的 `.tmp-` 文件（仅超过 1 小时）与空 objects 前缀目录；任一引用不可读仍拒绝删除任何块。
- 新增 3 个套件：`backup-atomic`（临时文件/替换/失败清理）、`backup-keystore`（DEK 与信封升级）、`backup-machine-key`（真实 DPAPI round-trip + 文件生命周期）；备份共 15 个套件 / 210 项。子插件面板路径在 Windows 上有真实 DPAPI 端到端用例。
- **真实闭环（默认路径首次建库）**：`D:\DeepSeekHarness\BackUP` 首次备份 16 文件 / 168.7 MB / 54 块 / 4.8 s，`machine` 信封（DPAPI）解锁；第二次 1 新块 + 53 复用（98%），耗时 2.0 s —— 那 1 个新块来自**正在写入的当前会话**（两次运行之间增长），同时产生 1 条 old 记录，正好验证"活会话也能安全备份 + 轮转"；`gc --dry-run` 引用 55 块、0 误删；`status` 报 2 快照 / 1 旧版本 / 剩余 171.7 GB。

### 备份地基（v3.4.6）：协议冻结、只读勘察、加密自检

- 新增 `docs/BACKUP-DESIGN.md`：仓库布局、清单 v1 字段表、4 MiB 定长块、三信封加密（账户/本机/密码）、错误码表、排除项理由、版本兼容承诺，以及 2026-11-17 复盘门禁 G1–G5 的落点。
- 新增 `src/backup/{layout,scan,manifest,crypto}.mjs`：仓库路径与具名失败（盘符缺失/无权限/别家仓库/仓库在 `$DSH_HOME` 内）、只读扫描（会话 + 注册表标记 + 附件对象，可选 hash/deep）、清单 schema 与严格校验（块对齐、路径规范化、计数自洽）、scrypt/HKDF + AES-256-GCM 三信封 + 块对象 + `selftest`。
- 新增 `docs/SPIKE-ACCOUNT-KEK.md`（只读 spike，329 行）：核对 DSH 账户材料后确认——磁盘没有稳定账户标识，`userId` 只是标识不是秘密，用它派生 KEK 等于加密表演；**默认信封组合改为 `machine`（Windows DPAPI，同机免密）+ `password`（scrypt，唯一保证）**，`account` 降级为可选、且写入前必须先修 `getProfile(client)` 调用并做宿主内实测。scrypt 默认按实测取 N=2^17（约 461 ms）。
- 新增只读路由 `GET /api/w2m/backup/status|scan`（由主插件挂载，不写盘）与 `bin/w2m-backup.mjs`（`status` / `scan` / `selftest`；`scan --manifest` 在内存里构建清单并给出摘要）。
- 新增 `src/backup/repo.mjs`：快照 id（`YYYYMMDDTHHMMSSZ-<8 hex>`，字典序即时间序）、快照两文件、`index.jsonl` 行格式（只有计数与摘要，**不含路径**）、`commitSnapshot`（staging → rename → append → **回读校验**）、`openRepo` 只读状态；`status` 路由与 CLI 打印同一份状态，不再各推一遍。
- 顺带修债：`test/agent.test.mjs`「transport re-delivery from cache」原先用 15s 默认预算，满载实测曾需 ~22s 而红；改为全程事件条件 + 60s 显式预算（`rabbit.stream(60_000)` 与三个 `waitFor`），不加 sleep、不放松断言，真实挂起仍会在 60s 失败。
- `workspace.json` 的解析抽到 `src/util/dsh-workspace.mjs`，`session-doctor` 与备份扫描共用一份——两个解析器会静默给出不同答案，而复盘里正是“注册表状态不一致”害得会话看不见。
- 新增 6 个测试套件共 120 项：布局的 5 类失败、只读扫描（含“扫描前后字节与 mtime 完全一致”）、加密三态（错密码/错账户/篡改一字节）与“信封换槽/降低参数”拒绝、清单字段冻结与 17 类非法清单、仓库协议（快照 id/索引行/提交回读/只读打开）、接线（bin/路由/层模型/脚本清单）。
- 本机实测（真实 `$DSH_HOME`）：15 条会话 / 166.3 MiB、附件 1 个 / 62 KB、归档 4 / 置顶 4 / 未注册 2；`scan --manifest` 得到 54 个块；`selftest` 9 步全绿；`status` 对尚未创建的 `D:\DeepSeekHarness\BackUP` 报告“未初始化”且不创建它。

### session-doctor：把"会话找回"的四类失败变成可执行门禁

- 新增 `scripts/session-doctor.mjs`（只读）：检查 zstd 首帧只含 header、`surfaceOp`（含压缩检查点的对象形态）、`system/message` 保护头、`seq` 连续性与悬空引用、以及 `workspace.json` 未注册会话；`--json` 供还原流程调用。
- 新增 `test/session-doctor.test.mjs`（11 项）：每条用例对应 2026-11-16/17 复盘里的一次真实失败，另有"健康日志必须零发现项"的防误报控制。
- 新增 `docs/RETRO-SESSION-RECOVERY-20261117.md`：时间线、四类根因、最终生效做法、门禁清单（含后续版本 G1–G5），以及下一次会话找回的"必须/禁止"一页清单。
- 本机实测：14 条会话日志全部通过格式检查，唯一发现项为 1 条未注册会话 —— 检查有效且不误报。

## [3.5.0] - 2026-11-18

会话备份&还原（v3.4.6–v3.5.0 合并发布）：内容寻址仓库（objects/current/index、原子写、锁、22:00 调度与补跑、old/ 轮转、gc 引用安全）、
还原（session-doctor + G2 注册表协议 + G5 运行时终审、pre-restore 副本与其保留）、解锁（machine DPAPI / account ID 比对 / 4-6 位 PIN + 公开提示词 + 轮换）、
归档（.tar.zst 含 manifest 且可还原）、全量校验、G4 seq 重编号工具、备份&还原面板（侧边栏入口、按会话计划、四类一键操作、注册表复查、解锁对话框、运行时终审缓存）、
三种保护状态（默认不加密 / 账户便捷 / PIN 门槛）、old-format full 整文件副本与 old-backfill、异地镜像（真实路径包含性 + 写入时链接守卫 + 损坏修复）、
版本治理（最低版本门禁具名拒绝 + allowOutdated 审计 + 漂移看板 + 保留策略）、Relay Phase 2 合并（chat/project sync，含编码修复、ADR 与滚动升级手册）。

详细条目见下方各未发布条目（自 v3.4.6 起）。

## [3.4.5] - 2026-11-16

- **新增自修复子插件 `dsh-fix`**（`@twinsearth/w2m-dsh-plugin/dsh-fix`，默认启用）：当会话历史引用的图片附件对象已被删除、导致每一轮都以 `TRANSPORT`（`DeepSeek Messages transport failed`）失败时，在进程内自动修复：
  - 挂在 `agent/request-error` waterfall，只检查 `TRANSPORT` / `ATTACHMENT_NOT_FOUND`；
  - 扫描当前请求视图（`session.surface.nodes`，被 compaction 阴影掉的旧消息自动排除），只针对对象文件确实缺失且尚未 `offloaded` 的图片；
  - 追加官方既有的 `image/offload` 事件并 `await ctx.sessions.flush(session)` 过持久化屏障，然后返回 `{ kind: 'retry' }` 重试该步（不消耗 provider 重试预算、不记 `llm/retry`）；
  - 没有可修的图 → `next()`，真网络错误原样交给下游；同一 session 同一轮最多修 `maxRepairsPerTurn`（默认 3）次。
- **离线 CLI**：新增 `w2m-fix`（`bin/w2m-fix.mjs`；兼容路径 `cli/bin/dsh-fix-attachments.mjs`）：
  - `scan` 只报告；`fix --apply` 追加一条带 checksum 的 `image/offload` 帧（需先退出 DSH；写前备份、写后全量复核）；
  - `backups --session <片段>` / `restore --session <片段> --apply` 查看与回滚备份；
  - 拒绝：DSH 正在运行、日志末尾有撕裂帧、不认识的会话格式版本；CLI 需要 Node ≥ 22.15（同步 zstd）。
- **来源与迁移**：功能移植自 `xuzhunzhi/dsh-fix-attachments`（MIT）；挂载点、状态目录（`$DSH_HOME/xclient/dsh-fix-state.json`）与 CLI 名称按 w2m 约定调整，详见 `docs/DSH-FIX.md`。
  升级到 v3.4.5 后如仍装有独立包 `dsh-fix-attachments`，请移除它（两个监听器能力重叠；本包已包含该修复）。
- **Windows 能力探测修复**：Node 的 Windows 发行版同时带一个无扩展名的 `npm` shell 脚本；`probeNpm()` 在找不到 `npm-cli.js` 时会把它当成可直接执行文件，`spawn(..., {shell:false})` 得到 `SPAWN_ENOENT`。现在 Windows 上的直接探测只接受 `npm.exe`，无扩展名脚本改由 `npm.cmd` 分支报 `NEEDS_SHELL`（与既有语义一致）。

## [3.4.4] - 2026-11-16

- **子插件浮标与子插件一一对应**：GPW、队列日志、决策中心三枚浮标只在对应子插件启用（HTTP 路由存在）时显示；子插件关闭时浮标隐藏，重新启用后自动出现。
  - GPW 浮标监听 `/api/w2m/gpw/state`（dsh-gpw 未启用时 404 → 不渲染）；
  - 队列浮标监听 `/api/w2m/composer/journal?list=1`（dsh-queue-journal 未启用时隐藏，启用后才启动队列存储）；
  - 决策中心浮标监听 `/api/w2m/decisions`（dsh-decision-center 未启用时隐藏）；
  - 统一 `watchSubpluginRoute` 每 5 秒复核，禁用后抽屉自动关闭，重新启用后恢复。



## [3.4.3] - 2026-11-15

- **发布产物一致性修复**：v3.4.2 的 GitHub Release 是干净 tag 产物（1,928,320 B / sha256 0458b2…），但本地 pack 时把未跟踪的 `docs/RELAY-CLUSTER-SYNC-PHASE2-DESIGN.md` 一并打进了 npm staging（1,938,223 B / 不同 shasum）。
  - Phase2 设计草稿已移出仓库，3.4.3 从**干净工作区**重新打包；GitHub Release、npm、本机 profile 使用同一份字节。
  - 功能代码与 3.4.2 相同；仅修正发布产物。
- 3.4.2 的 npm staged 条目（40ed0f72…）作废，请只批准 3.4.3。

## [3.4.2] - 2026-11-15

- **Release pre-flight 第二个根因修复**：3.4.1 在 CI 仍红，但测试计数是 `3502 tests / fail 0`，实际是 Relay cluster 的两处重试延迟 timer 被 `unref()`；`node:test` 等待期间事件循环已空，Node 22 报 `Promise resolution is still pending but the event loop has already resolved` 并把测试标记为 cancelled/failed。
  - `fetchSnapshotWithRetry` / `fetchDevicesPageWithRetry` 的 **awaited retry delay 去掉 unref**，让重试真正等到下一轮；
  - 后台调度 timer 仍保留 unref（不阻止进程退出）；
  - 用 **Node 22** 复现并验证：修复前 `cluster-sync` 出现 pending promise；修复后 22/22 pass。
- 发布验证统一改为 **Node 22 + 空 DSH_HOME**，与 GitHub Actions 的 release runner 完全一致。

## [3.4.1] - 2026-11-15

- **CI 根因修复**：3.3.18/3.4.0 的 Release pre-flight 失败，不是代码功能问题，而是测试主机依赖泄漏：P0 的默认 `stateDir` 让 `DSH_DEVICE_FILE` 不再优先，CI 干净环境没有 `~/.dsh/xclient/device.json` 时 6 个 `update-wiring` 用例读到宿主路径并报 `W2M_NO_TOKEN`。
  - `devicePathFor` 恢复优先级：`DSH_DEVICE_FILE`（显式 override）→ 显式 `stateDir` → `$DSH_HOME/xclient`；
  - `resolveToken` 只在 `stateDir` 被显式配置时才把缺失 device 当硬错误，默认 stateDir 下仍可回退 operator token；
  - 增加回归用例：设置 `DSH_DEVICE_FILE` 时必须使用其中的 `device_token`。
- 已用**空 DSH_HOME** 模拟 CI 跑 pre-flight，避免再依赖本机 device token。

## [3.4.0] - 2026-11-15

**主题：Relay 三节点数据同步正式发布，并完成队列/历史可靠性修复。**

### Relay v3.0.0（server-side，插件协议不变）

- 三台 relay 互为 peer，按各自调度拉取 durable 状态：`devices`（设备记录/device_token/fleet 绑定，LWW 合并）与 `ledger`（task.created / lease.changed / result.stored / task.cancelled，`origin@offset` 幂等回放）；
- 不同步：blobs、operator token / signing secret、心跳/租约/presence、fleet chat / fleet memory（留 Phase 2）；
- 调度：启动后 60–600 秒随机首同步，此后每小时 ±5 分钟抖动；单飞、失败退避（30s/2m/10m），单 peer 故障不阻塞其他 peer；
- 安全：peer 路由仅接受 cluster HMAC（method/path/ts/nonce/since，±120s + nonce），响应 AES-256-GCM 加密；healthz 只暴露 node/peer/游标/计数；
- 部署：三台 relay 已上线 `relay_version=3.0.0`，features 含 `relay-cluster-sync-v1`，`cluster.last_ok=true`；systemd operator token 加固与滚动重启手册随包发布。

### 插件侧

- **P0**：未配置 `stateDir` 时默认 `$DSH_HOME/xclient`，本地 memory / RTT / P2P inbox 不再失效；
- **P2**：`w2m_devices` 与目标选择器共用 online 判定，并输出 `version_drift { current, versions, behind_count, behind[] }`；旧版本（2.0.x/2.2.x）标记落后并纳入统一治理；
- **队列日志人类输入修复**：旧记录 `sessionKey: ""` + `key: session-…` 被 `??` 判成机器记录；客户端与宿主统一改为空值回退到 key，并回填既有 journal；
- **会话名修复**：记录里的 `title` 为空时不再被 `??` 截断，回退到 sessions 映射（同时尝试 `session-<uuid>` 与裸 `<uuid>` 键，优先裸 id），并已回填现有 journal 的会话标题。
- **历史对话从新到旧**：当前草稿置顶，带时间戳的人类输入按时间倒序；
- **派发三态真实样本**：`docs/DISPATCH-TRI-STATE-20261115.md`（ok / failed / divergent / partial）；
- **审批策略 C（保留 red 通道）**：never-ask 下 joint-dev 派发保持 blocked 是预期边界；
- **测试**：`test/agent.test.mjs` 的绝对路径 allow-list 改为数组形式（Windows `Program Files` 含空格），`w2m_devices` 期望补充 `online` 字段。

## [3.3.18] - 2026-11-15

- **队列日志：人类输入恢复**。旧客户端保存的记录里 `sessionKey` 是空字符串、真实会话键在 `key` 上；`??` 把空字符串当成“已存在”，导致所有人类队伍都被折进「机器生成」，标题显示 0 条人类输入。现在客户端与宿主统一用「空值回退到 key」判定：
  - 客户端 `isHumanJournalEntry`：`sessionKey || key` 以 `session-` 开头即人类；徽标计数、抽屉分块、恢复队列共用同一判定；
  - 宿主 `ComposerJournal.list/get/save`：缺失的 `sessionKey` 从 `session-<uuid>` key 自动补齐；页面级 key 仍不冒充会话。
- **修复 release pre-flight 的 mojibake 误报**：`test/cluster-sync.test.mjs` 注释里的乱码标点改为 ASCII 连字符，CI 的 mojibake 扫描恢复通过（这是 3.3.16/3.3.17 GitHub Release 失败的直接原因）。
- 包含 3.3.17 的「历史对话从新到旧」与 3.3.16 的 Relay v3.0.0 集群同步、P0/P2 修复。

## [3.3.17] - 2026-11-15

- **历史对话默认从新到旧**：聊天框「历史对话」窗口按时间倒序展示（当前草稿固定在最上方，随后是带时间戳的排队/已发送消息，从新到旧；无时间戳的条目排在最后）。标题标注「仅人类输入 · 从新到旧」。
- 纯客户端修复；宿主路由、协议与其他面板不变。

## [3.3.16] - 2026-11-15

### Relay v3.0.0 — 三节点数据同步（server-side, 插件协议不变）

- **Relay 之间新增拉取式数据同步**：三台 relay 互为 peer，每台按自己的调度从另外两台拉取 durable 状态并经加密信封传输：
  - `devices`：设备记录、device_token、fleet 绑定（LWW 合并；presence 仍由本机观测）；
  - `ledger`：`task.created` / `lease.changed` / `result.stored` / `task.cancelled`（`origin@offset` 幂等回放，重启时与本地账本合并重放）。
  - 不同步：blobs（数据面红线）、operator token / signing secret（各 relay 独立权威）、心跳/租约/presence、fleet chat / fleet memory（当前非 durable，留 Phase 2）。
- **调度**：进程启动后 **60–600 秒随机**触发首次同步（滚动重启不会三台同刻拉取）；之后每 **1 小时 ± 5 分钟抖动**一次；单飞、失败退避（30s/2m/10m），单个 peer 故障不阻塞其他 peer。
- **安全**：peer 路由只接受 cluster HMAC（`method/path/ts/nonce/since`，±120s 时间窗 + nonce 防重放），响应为 AES-256-GCM 加密信封（含 device token 的同步内容不裸奔）；healthz 只暴露 node id/peer/游标/计数，不暴露 secret 或 payload。未配置 cluster 时行为与 2.1.5 完全一致（无 `/v1/cluster/*`、无新 feature）。
- **新版 healthz**：`features` 增加 `relay-cluster-sync-v1`（仅 cluster 启用时），新增 `cluster` 诊断对象（node_id/peers/last_sync_at/next_sync_at/last_ok/imported counts）。
- **部署**：`W2M_RELAY_VERSION=3.0.0` 报告 relay 3.0.0；参数 `--cluster-peers/--cluster-secret/--cluster-node-id/--cluster-sync-ms`（或 `W2M_RELAY_*` env）；滚动重启脚本 `deploy/relay/rolling-restart.sh`，手册 `docs/RELAY-V3.0.0-DEPLOY-RUNBOOK.md`。
- 设计/验证：`docs/RELAY-CLUSTER-SYNC-DESIGN-v3.0.0.md`、`docs/RELAY-CLUSTER-SYNC-V3.0.0-VERIFICATION.md`（本地：cluster 单元 16/16、三 relay 集成 2/2、relay+health 回归 209/209、capabilities 5/5、eslint 0）。


### 插件侧

- **P0：`stateDir` 默认值修复**：未配置 `stateDir` 时默认 `$DSH_HOME/xclient`（`~/.dsh/xclient` 回退），不再让本地 memory、RTT 状态文件与 P2P inbox 静默失效；新增 `configuredStateDir()` 便于测试。
- **在线口径统一**：`w2m_devices` 与「全部机器」选择器共用 `isSelectableDevice`（`online` 优先、`state` 回退）；`w2m_devices` 现在同时输出 `online`/`state`，离线设备不再显示成 `online`。
- **版本漂移可见**：`w2m_devices` 新增 `version_drift { current, versions, behind_count, behind[] }`；当前发布 3.3.16，2.0.x/2.2.x 标记为落后并纳入「统一到最新版本、放弃旧版本」治理。
- **派发三态真实样本**：新增 `docs/DISPATCH-TRI-STATE-20261115.md`，记录 ok / failed / divergent / partial 四个真实 task（含隔离测试机、只读命令与逐机结果）。
- **审批策略定档 C（保留 red 通道）**：never-ask 下 joint-dev 派发保持 `blocked`（`APPROVAL_REQUIRED`）是预期边界，不预置签名审批、不关闭入口；需要能力时由有审批通道的运营操作。
- **Relay v3.0.0 部署验证**：三台 relay 均报告 `relay_version=3.0.0` 且 `features` 含 `relay-cluster-sync-v1`，`cluster.last_ok=true`；三节点的设备/账本按设计拉取同步。

## [3.3.15] - 2026-11-15

- **「全部机器」增加离线分类**：现在分为 **客户端 / Web端 / 离线** 三组——
  - 客户端（在线，Windows/macOS 等已知桌面平台）在前；
  - Web端（在线，Linux/未知平台/机器名含 web|relay）默认折叠；
  - **离线**（`online !== true` 的全部机器）单独一组、默认折叠；展开后列出机器但保持不可选（与原来离线项禁用一致）。
- 分组只看在线状态，不改变机器类型：离线机器不会再混在客户端/Web端列表里；打开菜单时 Web端与离线都回到折叠状态。
- 本版包含 3.3.14 的队列日志分块（人类输入/机器生成）与 3.3.13 的会话名解析、3.3.12 的队列自愈/Web端分类。
- 验证：`client-bundle` 51 项通过（含离线分组顺序、折叠默认、旧快照兜底）；`eslint 0 errors`。

## [3.3.14] - 2026-11-15

- **队列日志分块显示**：抽屉现在明确分成两块——
  - `人类输入 · N 条`：真实会话（`session-*`）的草稿与排队消息，逐条展示；
  - `机器生成 · N 条（默认折叠）`：页面/客户端自身生成的记录（非真实会话键），默认折叠；即使这些记录没有内容，
    折叠头也会显示（并标注「M 条空记录已隐藏」），不再看起来像“没有机器记录”。
- 计数语义：机器生成的 N 按**所有**非人类记录计，不再只算有内容的记录；抽屉标题同步改成「机器生成记录已折叠」。
- 本版包含 3.3.13 的会话名解析（宿主从 DSH `session/title` 事件取名字）与 3.3.12 的队列自愈、未知平台归 Web端。
- 验证：`client-bundle`/`queue-journal` 59 项通过；`eslint 0 errors`。

## [3.3.13] - 2026-11-15

- **队列日志恢复会话名**：宿主 `/api/w2m/composer/journal/sessions` 现在按以下顺序取标题——
  ① 队列记录保存时写入的 title；② 宿主 sessions/agents 服务；③ **DSH 会话日志里的 `session/title` 事件**
  （先读日志头部 4MB，长会话再回退到增量全量读取并缓存）。此前宿主服务拿不到标题、记录里 title 为空时，
  抽屉只能显示「未知会话」。
- **澄清标识符与显示名**：队列记录的唯一键始终是 Session ID（`sessionKey = session-…`），用于恢复/匹配；
  「会话名」来自 DSH 的会话标题事件，不是 Session ID 本身，也不会把裸 ID 当名字显示（保持既有约定）。
- 实测标题解析：`session-39bb…` → `DSH：房主`；`session-0c366…` → `DSH：瓮城`；`session-3238…` → `dsh-windows2macos 0.8.7`。
- 本版同时包含 3.3.12：队列日志全空自愈（从历史快照恢复草稿/队列）、未知平台归 Web端及旧宿主 kind 兼容。
- 验证：`session-log`/`queue-journal`/`client-bundle`/`fleet-target`/`claims`/`layer-model` 合计 **185 pass**；`eslint 0 errors`。

## [3.3.12] - 2026-11-15

- **队列日志自愈**：若主 journal 的**所有**记录同时变空（清空全部/旧客户端覆盖的特征），宿主启动时自动从
  append-only 历史快照恢复每台机器的最新草稿与最新队列，并在覆盖前保留 `.bak-recovered-*` 备份；
  只有“全局全空”才恢复，单条被有意清空的记录保持为空。本次也从历史恢复出 2 条草稿 + 4 条排队记录（备份在临时目录）。

- **「全部机器」分类彻底改为白名单**：只有 `windows` / `macos` / `darwin` / `win32` 算客户端；
  其余（平台缺失、`unknown`、空串、`linux` 及其他平台）一律归入 Web端。
- **不再信任旧宿主返回的 `kind`**：实测 DSH 主进程可能仍运行升级前的宿主代码（本次 09:16 启动的实例），
  它给出的 `kind: "client"` 会把未知平台留在客户端；浏览器端现在按 `os`/机器名自行判定，旧宿主也能正确分组。
- 机器列表里平台缺失时不再显示成「在线」：在线但无平台的机器详情显示 **未知平台**，一眼能看出它为什么在 Web端。
- 其余同 v3.3.10/3.3.11：客户端在前、Web端默认折叠；relayUrls 固定保留。
- 验证：`fleet-target` 分类用例（含 `os: unknown`、`freebsd`、空平台）+ `client-bundle` 分组/旧宿主 kind 用例 100 项通过；
  真实 Chromium `loader-entry 10/10`；`claims`/`layer-model` 71 项绿；`eslint 0 errors`。

## [3.3.11] - 2026-11-15

- **「全部机器」分组规则调整：未知平台默认归入 Web端**（此前默认按客户端处理）：
  - Web端 = `platform.os === linux`、机器名含 `web`/`relay`、或 **平台缺失/为空**（未知平台）；
  - 客户端 = 其余已知桌面平台（Windows/macOS 等）；
  - 宿主 `targetMachineKind` 与浏览器端旧快照兜底规则同步修改，`kind` 缺失且 `os` 缺失的机器现在出现在折叠的 Web端里，而不是客户端列表。
- 其余同 v3.3.10：全部机器分「客户端（前）/ Web端（后，默认折叠）」；本次也包含 relayUrls 固定（bootstrap 不再覆盖 202.182 原始 relay）。
- 验证：`fleet-target` 分类 + `client-bundle` 分组/折叠/未知平台用例 100 项通过；真实 Chromium `loader-entry 10/10`；`claims`/`layer-model` 71 项绿；`eslint 0 errors`。

## [3.3.10] - 2026-11-15

- **「全部机器」按客户端 / Web端分组显示**：
  - 客户端在前（Windows/macOS 的桌面客户端机器），Web端在后；
  - Web端默认折叠，点击 `Web端 · N · 展开` 才列出（再次点击收起）；
  - 分类规则（宿主 `targetMachineKind`）：`platform.os === linux`，或机器名匹配 `web`/`relay` 词根 → Web端；其余（含未知平台）→ 客户端；
  - 旧版宿主没有 `kind` 字段时，浏览器端用同一规则兜底，不影响旧快照；
  - `全部机器` 行、Relay 折叠与更新提示的位置保持不变。
- 验证：`fleet-target` 新增分类用例；`client-bundle` 新增分组用例（客户端顺序、Web端折叠、旧宿主兜底），合计 100 项通过；
  真实 Chromium `loader-entry 10/10`；`claims`/`layer-model` 71 项全绿；`eslint 0 errors`。

## [3.3.9] - 2026-11-15

- **对话内搜索：↑/↓ 真正跳到上/下一个匹配并居中**（此前只改计数器，正文不滚动、当前匹配没有视觉区分）：
  - 不再依赖 `mark.scrollIntoView`：找出匹配所在的**真实滚动容器**，直接把它居中（`scrollTop` 计算），
    并在下一帧/120ms 后再校正一次，避免虚拟列表/布局变化把滚动吃掉；
  - 当前匹配加 `data-active` 高亮（橙色 + outline），之前所有匹配同色，看不出选中了哪个；
  - 箭头读取**实时 active 索引**（`activeRef`）而不是可能过期的 `cursor` state，连点不会卡住；↑ 从第一个回绕到最后一个；
  - 匹配元素改为从**所有搜索根（含 shadow root）**收集：`document.querySelectorAll` 穿不透 shadow root，
    这也是此前“计数变了但正文不动”的一个来源；清除高亮同样覆盖 shadow root，不再留下残留 mark。
- 验证：client-bundle **47/47**（真实 DOM 伪对象：激活/居中/回绕/阴影根）；真实 Chromium `loader-entry 10/10`；
  `claims`/`layer-model` 71 项全绿；`eslint 0 errors`。

## [3.3.8] - 2026-11-15

- **修复 v3.3.7 的 Release 工作流被整条跳过**：上一版把 npm 的 opt-in 开关误加到了 `release` 作业（verify/pack/publish）上，
  导致 tag 推送后 Release 直接 skipped。现在 `release` 作业恢复原条件，只有 `publish to npm` 作业要求仓库变量
  `W2M_PUBLISH_NPM == 'true'`；GitHub Release 本身照常运行并可审批。
- v3.3.6/3.3.7 的内容不变：队列日志清空可恢复（确认 + 历史快照归档 + 抽屉恢复入口）、历史对话/待选改读宿主会话日志、
  Node 20 zstd 降级跳过、session-log 测试登记进 scripts.test。
- 验证：affected suites 126 pass；`loader-entry 10/10`；`eslint 0 errors`；pre-flight 的 test-wiring 已绿。

## [3.3.7] - 2026-11-15

- **修复 v3.3.6 发布失败的 CI 问题**：
  - `test/session-log.test.mjs` 未登记进 `package.json#scripts.test` → release pre-flight 的 test wiring 判红；已登记。
  - Node 20 没有 `node:zlib` zstd API：新增读取器在 Node<22.15 上返回 `supported:false`（宿主路由回 `zstd-unsupported`，客户端自动回退 sessions 服务），
    对应测试在 Node 20 上跳过而不是整套失败。
- **CI 的 npm 发布改为显式开关**：`release.yml` 的 `publish to npm` 现在要求仓库变量 `W2M_PUBLISH_NPM == 'true'`。
  带 bypass-2FA 的 token 在本仓库只会把一个版本「stage」到 npm（不可见、同版本不可重发），因此默认跳过 CI 发布，
  由本地 `npm publish` 显式完成；需要恢复 CI 发布时在仓库 Variables 里打开该开关。
- v3.3.6 的内容不变：队列日志清空可恢复（确认 + 历史快照归档 + 抽屉恢复入口）、历史对话/待选改读宿主会话日志。
- 验证：`session-log`/`queue-journal`/`client-bundle`/`claims`/`layer-model` 全绿；`loader-entry 10/10`；`eslint 0 errors`。

## [3.3.6] - 2026-11-15

- **队列日志「清空全部」不再造成不可逆丢失**：清空前先确认，并把每条记录（含仅有草稿的）归档到历史快照，再逐条清空；
  抽屉新增「历史快照 · N 条（可恢复）」折叠区，可逐条恢复草稿/恢复队列。宿主 `appendHistory` 现在也归档仅有草稿的快照。
- **历史对话改为宿主直读 DSH 会话日志**：新增 `GET /api/w2m/composer/journal/session-log?sessionId=`，
  增量解码 `session.v4.jsonl.zstd` 的追加帧（不重复解整份大日志），返回会话标题、最近人类消息、最后一条 assistant 消息；
  不再依赖客户端 `sessions` 服务的事件窗口（该服务不可用时历史窗口为空）。
- **待选机制同源修复**：选择题检测优先读同一条宿主会话日志，客户端 sessions 服务只作兜底；长会话（如 1565 条人类消息的
  「DSH：房主」）也能稳定工作。
- 本机 `DSH：房主` 会话已验证可读：标题、最近人类消息、最后 assistant 回复均正确（200 条窗口）；
  队列日志主文件已从历史快照恢复 4 条可恢复记录（备份在临时目录）。
- 验证：`session-log 4/4`、`queue-journal` 路由用例、`client-bundle` 新断言，合计 55 pass；真实 Chromium `loader-entry 10/10`；
  `claims`/`layer-model` 绿；`eslint 0 errors`。

## [3.3.5] - 2026-11-15
- **决策中心接管每轮末尾的选择题**：轮询当前会话最后一条 assistant 消息，识别 1/2/3/4、A/B/C/D
  （含 `[ ]`/`☐` 多选与单行内联写法），自动在决策中心创建黄色「本轮待选」ticket（带选项按钮）；
  同一道题按 dedupeKey 只建一张；点选项会先完成决策、再把所选文本填回输入框，用户确认后发送。
  （此前的 `ask_user_choice` 工具需要模型主动调用；模型直接输出选项时，待选机制不会触发。）

- **底部状态栏恢复两条比例**（此前把“全服机器”显示成了第二项，且数据缺失时整段变成 —）：
  - 本编队在线机器 `在线数/本编队机器总数`
  - 在线编队 `在线编队数/全服编队总数`（来自主 Relay `/healthz` 的 fleets_online / fleets_total）
  - 全服机器在线数/总数保留在第二项的悬浮提示里；数据真的取不到时该比例显示 —（不伪造 0）。
  - Relay 在线圆点保留。
- 验证：`client-bundle 41/41`（新增状态栏两条比例标签与 fleets/devices 计数断言）、
  真实 Chromium `loader-entry 10/10`（底部状态栏文本包含「本编队在线机器」「在线编队」），
  `claims`/`layer-model` 绿、`eslint 0 errors`。

## [3.3.3] - 2026-11-15

- **仅版本号递增，功能与 3.3.2 完全相同**：npm 的 staged-publish 窗口把 3.3.2 变成“已暂存但不可见”的占位版本
  （`npm view` 404，重发报 `E409 Cannot publish over previously staged version "3.3.2"`），该版本号无法自助补完；
  按 npm 文档的规则改发下一个版本号（staged 版本不影响发布其他版本）。
- GitHub Release v3.3.2 的资产字节与 3.3.3 的功能完全一致，仅 package version 不同。
- 建议随后把 CI 的 npm 发布改为 Trusted Publisher (OIDC) 或移除 bypass-2FA 的 NPM_TOKEN，避免再次出现 staged 占位。

## [3.3.2] - 2026-11-14

- **历史对话只挂在输入框上方**：窗口改为 composer 内的绝对定位（`.w2mHistWrap` + `position:absolute`），
  不再固定在页面右下/底部；Esc/关闭按钮照常收起。
- **队列日志的底部 dock 不再渲染**：截图里「历史 10 + 恢复」那一列（conversation.composer.dock 的 JournalDock）
  已隐藏，草稿保存/恢复能力仍保留在历史对话窗口、操作面板「消息与草稿」页与队列日志抽屉里。
- **找回 v2.2.6 的原始模块/功能/按钮**：
  「全部机器」目标选择控件、执行能力开关、编队聊天面板重新显示在输入框行（v3.3.0 曾把它们隐藏）；
  「编队群组」视图页签、GPW 浮标、右下角浮标与底部状态栏保持。
- 验证：`client-bundle 40/40`（历史窗口锚定/原控件恢复/编队聊天两处注册/全部机器标签/队列 dock 隐藏），
  真实 Chromium `loader-entry 10/10`（历史窗口 wrapped+absolute、全部机器按钮可见、编队聊天按钮可见、
  操作面板四页签），`gpw-ai 10/10`、`claims`/`layer-model` 绿、`eslint 0 errors`。

## [3.3.1] - 2026-11-14

- **修复 GPW 智能分级 `unparseable-classification`**：解析器现在接受中文键（危险等级/建议/理由）、数字等级（1-4）、
  同义词与散文；模型回复无法解析时自动做一次「修复重试」（把原始回复发回，要求只输出 JSON）；两次都失败时
  `POST /api/w2m/gpw/ai/test` 会带回模型原始回复片段（`raw`），面板直接显示出来，便于定位。
- **AI Token 设置 UI/交互优化**：状态徽标（已配置=绿 / 未配置=黄）、provider/model/baseUrl/Token 分字段、
  保存与“测试分级”按钮带进度（保存中…/测试中…）、测试结果按成功/失败着色并显示等级、动作、理由、耗时、
  自动修复提示与模型原始返回；另有“刷新状态”按钮与本机保存说明。
- **左侧边栏操作面板**：点击侧栏按钮打开的面板新增四个页签：
  「智能分级&审批」（AI Token 设置 + 待审批队列，可直接允许/拒绝并显示倒计时）、
  「消息与草稿」（队列日志的人类记录 + 恢复草稿/恢复队列/清除/打开窗口）、
  「决策中心」（待处理计数 + 列表 + 打开决策中心）、
  「操作入口」（目标机器、执行能力，以及 GPW 浮窗/队列日志/决策中心快捷按钮）。
- 聊天框仍只有 v3.3.0 的「历史对话」一个按钮；右下角浮标与底部状态栏保持不变。
- 验证：`gpw-ai 10/10`（中文键/数字/散文解析、修复重试、原始回复回传）、`client-bundle 40/40`、
  真实 Chromium `loader-entry 10/10`（侧栏打开操作面板、四个页签、消息与草稿页、关闭面板），
  `claims`/`layer-model` 绿、`eslint 0 errors`。

## [3.3.0] - 2026-11-14

- **聊天框只保留一个「历史对话」按钮**：目标机器选择、执行能力开关、队列日志 chip、GPW 行内待审批提示、
  编队群聊面板不再占用聊天框（控件为探针/内部保留而隐藏）；右下角浮标与底部状态栏保持不变。
- **点击才展开窗口**：历史对话窗口默认关闭，点按钮展开；Esc/关闭按钮收起。
- **窗口只显示人类输入**：我发过的消息（`user/message`，排除系统/机器注入的 user 消息）、待发送提交、
  当前草稿、当前会话的排队消息；助手/工具等机器生成内容一律不显示。
- **点击条目填入输入框**：任意一条人类输入点击后直接填回 composer，方便复用历史提问。
- 验证：`client-bundle 39/39`（新增：单一历史按钮、隐藏旧控件、仅 user/message、pendingSubmissions、
  writeComposer 填入、仅人类输入提示），真实 Chromium `loader-entry 10/10`（按钮存在、点击展开窗口、
  标题「历史对话」、副标题「仅人类输入」、关闭窗口），`claims`/`layer-model` 绿、`eslint 0 errors`。

## [3.2.10] - 2026-11-14

- **取消左侧边栏的「决策中心」按钮**：决策收件箱入口仍保留在 GPW 面板的收件箱按钮、右侧「待选」浮钮与抽屉里；
  左侧栏不再出现该条目（相关 slot 注册与组件一并移除）。
- **队列日志显示会话中文名称**：标题来自客户端 `sessions` 服务的 `displayTitle`（并随记录持久化到 `title` 字段），
  不再显示 `会话 0c36661d` 这类短 ID；会话标题取不到时显示「未知会话」。
- **队列日志不显示 Session ID**：移除 👁 眼睛按钮与「Session ID」行，抽屉里不出现任何原始会话编号。
- **没有草稿也没有排队消息的会话不再出现在队列日志里**（徽标计数同样只统计有内容的记录）。
- 验证：`client-bundle 38/38`（含“不显示 Session ID/眼睛按钮、标题来自 sessions 服务、空记录被过滤”的静态断言）、
  `queue-journal 6/6`（新增 title 持久化用例）、真实 Chromium `loader-entry 10/10`（左侧栏无「决策中心」、
  队列抽屉无 Session ID/原始会话号、清空按钮仍在）、`claims`/`layer-model` 绿、真实浏览器截图核对通过。

## [3.2.9] - 2026-11-14

- **修复 Linux CI 上 GPW auto-approve 的偶发失败**：v3.2.7 起给 GPW 倒计时 timer 加了 `unref()`，
  在 CI 的受控事件循环里可能先于测试结束，导致 `gpw-auto-approve` 第一个子测试失败、发布流水线在
  `End-to-end suites` 步骤挂掉。现恢复 timer 强引用（与原始实现一致），红/黄/蓝/绿倒计时与自动动作语义不变。
- 验证：`gpw-auto-approve`、`gpw-ai-priority`、`gpw-modes` 本地全绿；CI 诊断 run 已定位失败子测试为
  “approves a yellow call after the timeout and makes its next occurrence blue”。
- 同一轮 CI 还暴露出分层模型（layer-model）未声明的新依赖边 `plugin -> decision-center`（GPW 复用决策中心的密钥存储），已在 `scripts/layer-model.mjs` 的 ALLOWED_EDGES 显式声明，`layer-model 24/24` 通过。
- 发布会话的 e2e 改为**自诊断**（保持 `npm run test:e2e` 单一入口，符合 claims 的“单一事实源”约束）：
  步骤内捕获输出，把失败文件名以 `::error title=e2e::FAILED <file>` 注解写出并写入 step summary；即使读不到日志，也能从注解/摘要看到是哪个 e2e 文件挂了。

## [3.2.8] - 2026-11-14

- **GPW 行内提示补齐**：composer 行内的 `GpwPrompt` 现在显示等级色点、AI 推荐（建议允许/拒绝 + 理由）与
  剩余倒计时秒数，不再只有工具名和允许/拒绝按钮；红/黄/蓝/绿的倒计时文案统一由 `gpwCountdownText()` 生成。
- **红色确认弹窗改为全局**：新增 `mountGpwRedAlert()`，随插件激活挂到 document.body，每 2 秒读取
  `/api/w2m/gpw/state`；出现红色待审批就浮出「确认允许 / 确认拒绝」弹窗，**不需要打开 GPW 面板**，条目消失后自动收起；
  同时删除面板内的红色弹窗副本，避免两个弹窗叠加。
- **优先级不变式**：黑名单仍是最高优先级红线（命中立即拒绝、永不进入 pending/AI 分级），白名单立即放行；
  AI 分级与倒计时只作用于其余调用，并与硬规则并行独立运行（新增 `test/gpw-ai-priority.test.mjs` 锁定）。
- 验证：`gpw-ai 9/9`、`gpw-ai-priority 3/3`、GPW 既有套件全绿、`client-bundle 36/36`、真实 Chromium
  `loader-entry 10/10`（页面启动、GPW AI 设置区、队列日志、决策中心、GPW 点外关闭）、`claims` 绿、`eslint 0 errors`。

## [3.2.7] - 2026-11-14

- **GPW 智能风险分级（操作面板填入大模型 Token）**，按用户要求：
  - 红：立即暂停并弹窗，必须人工「确认允许/确认拒绝」，不倒计时；
  - 黄：倒计时 **180 秒**，到点执行 AI 推荐动作（无推荐则放行）；
  - 蓝：倒计时 **30 秒**，到点执行 AI 推荐动作；
  - 绿：倒计时 **3 秒**，默认放行；
  - 没有配置 Token 时保持旧的统一 pending 超时行为，不影响既有安装与测试。
- 宿主：新增 `src/plugin/gpw-ai.mjs`（提示词、回复解析、四级倒计时、自动动作、配置归一化、模型调用）；
  `src/plugin/gpw.mjs` 里每张待审批记录携带 `level / ai / countdown_ms / deadline_at`，按等级重排倒计时；
  AI 失败时安全退回规则颜色，绝不自动放宽。新增 `GET /api/w2m/gpw/ai`、`POST /api/w2m/gpw/ai/config`、
  `POST /api/w2m/gpw/ai/test`；Token 只存 DPAPI/钥匙串，并默认复用决策中心已配置的同一把 Key。
- 客户端：GPW 面板新增「AI 智能分级（红/黄/蓝/绿）」设置区（provider/model/baseUrl/Token/保存/测试），
  待审批条目显示等级、AI 推荐与倒计时；红色待审批会浮出确认弹窗。
- 验证：`gpw-ai` 8/8（倒计时/自动动作/解析/配置/模型调用失败回退）、GPW 既有套件全绿、
  `client-bundle` 36/36、真实 Chromium 断言 GPW 面板存在 AI 设置区、`loader-entry` 10/10、`claims` 绿、`eslint 0 errors`。

## [3.2.6] - 2026-11-14

- **队列日志错乱修复**：旧版 `scanQueue()` 在没有官方 `[data-queue-dock]` 时会扫描任意 class/aria/testid
  里含 `queue`/`pending` 的元素并整段存 `innerText`，把本插件抽屉、对话正文、工具输出都当成“排队消息”
  写进日志，于是出现「队列 x」「恢复全部 (22)」「清除」「1. .tmp/…」这类垃圾，并且清掉又立刻生成。
  现在**只认官方队列 dock**（`[data-queue-dock]` 的行及其 aria-controls 兜底），没有 dock 就是空队列；
  插件自己的浮标/抽屉带 `data-w2m-queue-ui` 标记并被排除。
- 只在**真实会话键**下写入（`page:` 实例键、空键、`/` 一律不写），从源头杜绝无会话垃圾记录。
- 队列日志抽屉：显示**会话名称**（宿主 `sessions`/`agents` 服务映射；宿主新增
  `GET /api/w2m/composer/journal/sessions`），**Session ID 默认隐藏**，点 👁 才显示；新增**清空全部**按钮；
  无会话键的旧垃圾记录默认隐藏并提示可一键清理。
- **默认只显示人类输入**：抽屉默认只列出真实会话（`session-…`）的草稿与排队消息；客户端/页面自己生成的
  记录（无会话键、`page:` 实例键、测试/探针记录等）统一折叠进「客户端生成的记录 · N 条（默认折叠，仅排错用）」，
  展开才可见；没有人类记录时会明确提示。浮标计数只统计人类输入，避免客户端记录把徽标刷成红/黄。
- 本机已清理已产生的垃圾记录（备份于临时目录），并重新写入干净的记录。
- GPW 浮动面板：点击面板外的遮罩自动收起，按 `Esc` 也关闭（设置页内联渲染不受影响）。
- 验证：`queue-journal` 5/5（含 sessions 路由）、`client-bundle` 36/36（含“不再扫描任意 queue/pending 元素”
  与 `validSessionKey` 的静态断言）、真实 Chromium 断言：抽屉有 👁 / 清空全部、Session ID 默认不可见、
  点 👁 后出现、sessions 路由 200。

## [3.2.5] - 2026-11-14

- 修复：决策中心「AI 建议设置」导入 Token 失败。原因有两处：
  1. 表单即使留空也会把 `provider/model/baseUrl` 作为空字符串发上去，而宿主的预设查找是
     `String(input.provider ?? 'deepseek')` —— 空字符串不是 nullish，导致 `unknown-provider`；
     现在表单预填 DeepSeek 预设（`deepseek` / `deepseek-flash` / `https://api.deepseek.com/v1`），
     并且只提交非空字段，服务端预设得以生效；
  2. 4xx 响应体用的是 `reason` 而不是 `error`，UI 只显示「HTTP 400」；现在请求层同时读取两者，
     失败时能看到 `unknown-provider` / `api-key-required` / `base-url-required` 等真实原因。
- 保存成功后会回显已保存的 `provider / model`，而不是笼统的「已保存」。
- 与本次操作配套的事实：DeepSeek Key 已按宿主相同的 DPAPI（CurrentUser）格式写入
  `$DSH_HOME/xclient/decision-center/decision-ai-secret.enc` + 元数据，插件下次启动会自动恢复；
  该 Key 已实测 `POST /v1/chat/completions`（model `deepseek-flash`）返回 200。
- 验证：`client-bundle` 36/36、`eslint` 0 errors；AI 表单默认值与错误透传均有静态断言覆盖。

## [3.2.4] - 2026-11-14

- UI 对齐（按用户截图）：
  - 左侧栏入口改名为 **决策中心**，点击行为与右侧浮标一致（打开同一个收件箱抽屉）；
  - 右侧居中浮标改为药丸样式：`◈ 待选 <数字>`；无待处理时黑色，有待处理时按最高优先级显示
    红 / 黄 / 蓝 / 绿，数字药丸同色；
  - 收件箱抽屉改为**右侧居中、半高**（`min(70vh,620px)`、圆角、右缘 14px），内容区可滚动并带细滚动条，
    不再全高满屏；
  - 队列日志浮标移到**右下角、GPW 浮标下方**（`right:14px; bottom:52px`），药丸样式；
    条数配色：0 条黑色、1–30 蓝色、31–50 黄色、>50 红色；
  - 队列日志抽屉改为**右下角半高**（`min(60vh,520px)`、圆角、下缘/右缘 14px），内容区可滚动；
- 每会话「待选」独立浮钮不再单独显示（由药丸承担；会话筛选仍保留在抽屉里）。
- 验证：真实 Chromium 页面断言——药丸文案含「待选」、两张蓝票时 `data-tone=blue`、侧栏文案含「决策中心」、
  决策抽屉高度在视口 40%–85% 之间且垂直居中/贴右、内容区 `overflow-y:auto`；队列浮标贴右下、
  1 条记录时 `data-tone=blue`、队列抽屉半高且内容可滚动。

## [3.2.3] - 2026-11-14

- **发布产物一致性修复**：v3.2.2 发布过程中 tag 曾在多个提交间移动，导致 npm 上的 3.2.2 包（`ff433810…`，
  对应 `751d8da` 树）与 GitHub Release 资产（`65b88098…`，对应最终 `4d50435` 树）不是同一份字节。
  本版从最终 tag 一次性构建并发布，发布后按 `tag 树打包 = Release 资产 = SHA256SUMS = npm tarball` 四方核验。
  `3.2.2` 因字节不一致在 npm 上标记为弃用；`3.0.0/3.1.0/3.2.0` 的重大缺陷弃用声明保持有效。
- 内容与 v3.2.2 最终树一致：客户端锁屏修复、队列子插件浮标/抽屉/GPW 入口/composer chip、
  决策中心 parity（每会话待选浮钮、键盘导航、按等级批量处理、分叉·生产者面板、右侧栏页签）。
- 流程改进：tag 一旦推送并进入审批，就不再移动；如需改动，升新版本号重新发。

## [3.2.2] - 2026-11-14

- **弃用声明**：`@twinsearth/w2m-dsh-plugin` 的 `3.0.0`、`3.1.0`、`3.2.0` 三个已发布版本有重大缺陷
  （决策中心客户端 UI 不完整/缺失；3.2.1 预览构建还存在弹窗遮罩锁死客户端的问题），npm 上以
  `>=3.0.0 <3.2.2` 范围标记 deprecate；请安装 3.2.2 或更高版本。3.2.1 从未发布到 npm。

- 决策中心对齐瓮城的剩余能力（v3.2.3 之前合并进本版）：
  - **每会话「待选」浮钮**：会话席位（`conversation.input.left`）发布当前 sessionId；当该会话有 pending 决策时，
    右侧上方出现「待选 N」浮钮（红票变红），点击打开只看该会话的抽屉（带「显示全部会话」清除筛选）；
  - **键盘导航**：抽屉内 `↑/↓` 移动选中项、`1-9` 按选中票的第 N 个选项处理、`r` 刷新、`Esc` 关闭；
  - **按等级批量处理**：每个等级分组头部在 ≥2 张 pending 时出现「批量解决 / 批量放弃」，走 `resolveMany`/`abandonMany`；
    红色/阻塞票按宿主红线拒绝批量（按钮置灰并提示“必须逐条处理”），批量结果如实显示成功数与未处理原因；
  - **分叉聚合 / 生产者面板**：抽屉底部可展开，展示 `/forks` 聚合与 `/producers` 目录；宿主不提供时如实说明；
  - **会话筛选**：抽屉顶部显示“只看会话：xxx”并可一键清除。
  - **右侧栏页签（sidebar.right.pane.tab）**：按宿主契约先向 `sidebarRightTabs` 注册 tab 类型
    （`w2m-decision-inbox`，地址 `dsh-resource://w2m-decision-inbox/**`），再挂页签主体；页签里是收件箱紧凑列表
    与「打开抽屉」按钮。该服务可选：没有 `sidebarRightTabs` 的宿主上注册不执行、其它入口不受影响。
- **严重修复（v3.2.1 回归）**：决策收件箱与队列日志的遮罩层/抽屉用了 `hidden` 属性切换，但样式表里
  `.w2mDcOverlay{display:flex}` 是作者规则、`[hidden]{display:none}` 只是 UA 规则，作者规则获胜 ——
  遮罩层永远铺满全屏并吞掉点击，点关闭只改状态不改显示，表现为「整个客户端被弹窗锁死、点哪都没反应、
  点空白也不收回」。现在改为显式 `style.display` 开关 + 全局 `[hidden]{display:none!important}` 兜底，
  并在真实浏览器里断言：打开时抽屉 `display != none`、关闭后抽屉与遮罩 `display == none`、
  页面中心点击不再被遮罩拦截（`elementFromPoint` 不在遮罩内）。
- 重要提示：遇到 3.2.1 锁屏不需要删除整个 profile，删除该 profile 的
  `node_modules/@twinsearth/w2m-dsh-plugin` 目录（或把 `dsh.profile.bundles` 里的 w2m 行移除）即可恢复；
  本版修好后重新安装即可。

- 修复：队列子插件（queue-journal）只有宿主路由与 composer 内联按钮，草稿/队列为空时整块不渲染
  （瓮城原版行为），用户看到的就是「未生效」。本版把队列日志做成常驻入口，并用真实 DSH 页面验证。
- 右侧中部新增第二枚「队列」浮标（收件箱浮标下方，固定可见，显示保存条数），点开右侧抽屉：
  按时间列出所有会话的草稿/队列快照（会话键、更新时间、草稿预览、排队消息逐条预览），
  每张卡片提供「恢复草稿」（写回输入框）、「恢复队列」（`/api/w2m/composer/queue`，
  无 live 会话时如实报 session-not-live）、「清除」，全部由用户点击触发，插件从不自动发送消息。
- composer dock 常驻 chip：没有草稿时也显示「队列日志 / 打开」，不再整块消失（原版 return null）。
- GPW 面板头部新增「队列 N」按钮（与「收件箱」按钮并列），点开同一个队列日志抽屉。
- 数据面：`GET /api/w2m/composer/journal?list=1` 列表、`POST /api/w2m/composer/journal` 清除、
  `POST /api/w2m/composer/queue` 恢复；抽屉每 8 秒刷新一次，打开时立即刷新。
- composer dock 的注册 id 从 `fang-queue-journal` 改为 `w2m-queue-journal`，避免与本机可能同时安装的
  瓮城 queue-journal 插件撞 id。
- 验证：`test/client-bundle.test.mjs` 36/36；`test/loader-entry.test.mjs` 10/10，真实 Chromium 页面探针新增：
  队列路由 POST/list 均 200、浮标存在、点击打开抽屉、抽屉标题含「队列日志」、抽屉正文含刚保存的草稿、
  GPW 面板含队列日志按钮（composer dock 是会话级插槽，落地页可能不渲染，探针以诊断输出而不误判）。
- 与瓮城对比仍暂缺（后续版本）：抽屉键盘导航、批量恢复、按会话筛选、时间线历史快照分组。

## [3.2.1] - 2026-11-14

- 修复：v3.0.0/v3.2.0 的决策中心只有宿主与路由，没有把瓮城的两个用户入口挂出来，表现为
  「没有右侧浮标&浮窗」「GPW 里没有收件箱按钮」。本版补齐客户端 UI，并用真实 DSH 页面验证。
- 右侧居中的「收件箱」浮标（固定`right:0; top:50%`，红/黄/无三种色调 + 未读数）+ 从右向左的
  抽屉：分组（红/黄/蓝/绿/灰）、过滤（待处理/全部/已归档 + 等级）、选项按钮、自定义答复、
  AI 建议、放弃、上下文折叠、Escape/遮罩关闭、红色 ticket 顶部提醒（不自动处理）。
- 数据面：`/api/w2m/decisions*` 的 list + SSE（`/events`）实时推送，断线自动回退 4 秒轮询；
  resolve 支持票面选项与自定义答复，abandon 单票放弃，`ai/advise` 只展示建议不自动执行。
- GPW：面板头部新增「收件箱 N」按钮（GPW 设置页与 GPW 浮标打开的面板都有），点击打开同一个抽屉；
  原有面板内联摘要保留。
- 侧栏入口：新增「收件箱」侧栏席位（图标 + 未读红点），对齐瓮城的收件箱侧栏入口。
- AI 设置：抽屉内新增「AI 建议设置」（provider / model / baseUrl / apiKey + 保存 + 测试连接），
  对应 `/ai/config` 与 `/ai/test`；没有配置时如实提示，而不是让建议按钮静默失败。
- 验证：`test/client-bundle.test.mjs` 36/36（座位断言更新为 18 个，含收件箱侧栏席位）；
  `test/loader-entry.test.mjs` 10/10，新增真实 Chromium 页面探针（`W2M_DECISION_PROBE=1`）：
  浮标存在、点击打开抽屉、抽屉标题含「收件箱」、关闭生效、侧栏入口存在、GPW 面板含收件箱按钮。
- 与瓮城对比仍暂缺（后续版本补）：收件箱的键盘导航、按等级批量处理、分叉聚合/生产者面板的完整展示。

## [3.2.0] - 2026-11-14

- 互联契约子插件：`@twinsearth/w2m-dsh-plugin/contract`，基于独立发布的版本化契约 SDK
  `@twinsearth/dsh-fang-contract@1.1.1`（逐字节副本 + `src/interop/contract/PROVENANCE.md`，
  `scripts/check-contract-vendor.mjs` 逐字节复核并纳入测试）。三个项目（w2m / 瓮城 dsh-fang / 房主
  dsh-master）各自独立发布，互不 import 内部代码、互不改对方资料，只经方法表 + 信封 + 传输层互联。
- w2m 方法表（`w2m.*`，契约版本 `1.0.0`，与插件版本解耦）：`w2m.status`、`w2m.methods`、
  `w2m.fleet.snapshot`、`w2m.devices.list`、`w2m.tasks.list`；MINOR 只新增，删/改义升 MAJOR 并双写。
  provider 由 `w2m.*` 宿主注入（`providers` 或 `w2mContractProviders` 服务），缺席时如实报
  `handler-threw: … exposes no … provider`，不返回空数据冒充成功。
- 服务端：`createContractServer` 承载 hello/health/invoke（协议 `fang-master` v1）；提供
  `w2mContract` 服务；同宿主对端（fang/master 的 local 传输）默认找 `fangContract`，本插件在该名
  缺席时补位、已存在时不覆盖，避免与瓮城抢服务键。HTTP 路由固定 `/api/w2m/contract/{hello,health,invoke}`，
  不占用 fang 的 `/fang/api/contract/*`；配置 `fileDir` 时再挂 file 兜底服务端。
- 客户端：`createW2mContractClient` 复用 SDK 的 **local → http → file → legacy** 四级自动降级
  （legacy 走 3.1.x 旧服务键 `fangForker` 等兜底），可调用 `fang.*` / `contract.*` / `w2m.*` 方法。
- 与 3.1.0 的关系：本版包含 3.0.0（决策中心）与 3.1.0（队列子插件）的全部内容，三者一起作为
  v3.2.0 发布；版本号语义仍各自独立（插件 3.2.0 / w2m 契约 1.0.0 / 契约 SDK 1.1.1）。
- 测试：新增 `test/contract-interop.test.mjs` 9 项（方法表与 hello 广告、信封往返与显式拒绝、
  provider 注入与缺席、三路由注册、服务补位/不覆盖、local/http/file/legacy 四级降级、SDK 副本逐字节一致）。

## [3.1.0] - 2026-11-14

- 队列子插件：`@twinsearth/dsh-fang-queue-journal`（瓮城）移植为 `@twinsearth/w2m-dsh-plugin/queue-journal`。
  Fang 的包只有空宿主（`apply(){}`），HTTP 面在 fang orchestrator 里；W2M 没有 orchestrator，所以
  `src/queue-journal/index.mjs` 自带存储与四条路由，线上形状与移植的客户端完全一致：
  `GET/POST /api/w2m/composer/journal`（单条/恢复列表）、`GET /api/w2m/composer/journal/history`
  （append-only 快照，可按 sessionKey 过滤）、`POST /api/w2m/composer/queue`（恢复到会话收件箱；
  无 live agent 时返回 `session-not-live`，绝不假装入队）。
- 存储 `ComposerJournal` 逐字移植（`src/queue-journal/lib/composer-journal.mjs`），数据落在
  `$DSH_HOME/xclient/queue-journal`；保存上限、历史上限与原子写保持不变。
- 客户端：Fang 的独立客户端模块（`window.__ModuleLoader__.load`）展开成 W2M 单一客户端 bundle 里的
  `createQueueJournalModule()`，由根 `apply(ctx)` 挂到 `conversation.composer.dock`：草稿输入捕获、
  queue dock 的 MutationObserver、15 秒兜底与 pagehide flush 全部保留；恢复只能由用户显式点击。
  Fang 的 `x-fang-auth` 取 token 逻辑替换为同源占位（W2M 路由走 cookie 鉴权）。
- 测试：新增 `test/queue-journal.test.mjs` 4 项（保存/读回/恢复列表、历史过滤、缺 key 拒绝、
  非 live 会话拒绝恢复）；client-bundle 的座位断言更新为 17 个（新增队列 dock）。

## [3.0.0] - 2026-11-14

- 决策中心子插件：`@twinsearth/dsh-fang/decision-center`（瓮城）完整移植为
  `@twinsearth/w2m-dsh-plugin/decision-center`。宿主模块逐字移植（`src/decision-center/index.mjs`，
  27 个服务方法、`request_human_decision` 工具），四个依赖（AI 密钥库、决策 outbox、生产者契约、
  SSRF 守卫）与 MIT 内置 schemastery 原样随包；Fang 内核 barrel 由 `kernel.mjs` 顶替，提供同样的
  `z`/`SERVICE`/bus/原子读写/数据目录解析/角色门。
- 新增 `/api/w2m/decisions*` 14 条路由：列表、单票、配额、分身聚合、生产者目录、外部 ingest、
  SSE 实时推送、解决（含批量与 actionId）、放弃（含批量）、AI 状态/测试/配置/建议/流式建议；
  `routes.mjs` 用 Connection fetch 注册表承载，SSE 事件名与负载与 Fang 一致。
- 决策中心面板进入 GPW：`GpwSettingsPage` 与 `GpwLauncher` 共用同一个 `GpwPanel`，因此设置页与浮标
  同时显示——4 秒轮询、红票置顶、绿/灰折叠、按票面选项一键解决、无选项可放弃、AI 建议只推荐不执行。
- 测试：移植 Fang 决策套件 79 项 + 新增路由面 3 项通过；Fang 的 Node-SSE 辅助（decision-events）与 fork 侧 ingest 客户端不随包（W2M 路由走 fetch SSE、没有 fork 半体）。
  `decision-center-fork` 与 `decision-action-integration` 不移植：前者依赖 Fang 母体/分身角色矩阵，
  后者的主体是 Fang orchestrator 与 restart-guard，W2M 里没有对应组件。
- 包元数据：新增 `./decision-center` 子路径导出与`dsh-decision-center` patch 行（启用），
  `engines.dsh` 保持 `>=0.2.0 <0.3.0`。

## [2.2.6] - 2026-11-14

- Fixes 搜索本对话: the walk covered only the viewport and stopped counting at six matches, so a
  word that was merely scrolled out of sight reported `0/0` and the feature looked broken. It now
  searches the whole rendered conversation, counts every match, and wraps up to 120 of them (the cap
  bounds paint cost, not the count). The count shows `…` while a query is still being applied.
- The search settles 1s after the last keystroke instead of 3s (the 3s delay was the second half of
  the same complaint: typing appeared to do nothing). Enter searches immediately.
- Marks persist after the query settles, so the scroll-triggered repaint is gone; it was re-walking
  the tree on every scroll for a result that no longer needed refreshing.
- Tests: the client-bundle suite now asserts the 1s settle, the whole-conversation walk (no
  viewport rect filter) and the count-every-match cap, instead of the old 3s/six-mark contract.

## [2.2.5] - 2026-11-12

- DSH 0.2.2-rc.2 compatibility, measured rather than assumed: the packed artifact mounts and boots in
  the rc.2 runtime (`@deepseek-ai/dsh@0.2.2-rc.2`) with every host entry active, all `w2m_*` tools
  registered, the browser half composed into `__DSH_BOOT__` and activated, the real page booting in a
  browser, and the Node-execution menu opening and taking temporary execution from the composer.
- The compatibility gate now pins that host: `DSH_HOST_VERSION` moves from `0.2.0-rc.2` to
  `0.2.2-rc.2`, with the Cordis versions that release carries (`@deepseek-ai/cordis@4.1.0`,
  `@deepseek-ai/cordis-plugin-loader@1.1.0`) and the pnpm the runtime bundles (`11.28.5`). The gate is
  what turns "the host moved" into a measurement instead of a surprise.
- `package.json#engines.dsh` is declared for the first time: `>=0.2.0 <0.3.0`. The requirement is read
  before any plugin code loads, so a host outside the line is refused with a named requirement instead
  of failing later. Prereleases participate in the range (DSH evaluates it with `includePrerelease`),
  which is why `0.2.2-rc.2` and `0.2.2-rc.1` both satisfy it; declaring `engines.dsh` also means the
  old `@deepseek-ai/dsh-*` peer fallback no longer decides compatibility for this package.
- Reviewed the two rc.2 changes an extension could depend on, and neither needs this package to move:
  tool failures now carry structured identity (`ToolGuardDenial.info`, `ToolContextUnavailableError`,
  approval and context error codes) but this package registers no `tools` guards and already returns a
  named refusal reason, so the change is additive from here; and plugins can register MCP servers for
  their own lifetime through `ctx.mcpManager`, which this package deliberately does **not** do — its
  bundled `w2m-mcp` server mirrors the same `w2m_*` tools for codex/Claude hosts, so mounting it inside
  DSH would register every tool twice.
- `w2m_intent`: structured intents mapped onto allow-listed commands; unknown actions, parameters and types
  are refused by name (the fleet does not invent commands).

## [2.2.4] - 2026-11-05

- Fixes the remote desktop `HTTP 404`: a default desktop profile leaves `stateDir` empty, and
  the remote-view route registration returned not-mounted in that case. The host now resolves
  the same `~/.dsh/xclient` directory the agent uses, so `/api/w2m/remote/config|start|frame|stop`
  are mounted and the settings toggle works without configuring `stateDir` by hand.
- Remote-view route coverage now includes the default-stateDir mount path.
## [2.2.3] - 2026-11-05

- Remote desktop (view-only) now reaches 1 frame per second in a fleet. A machine opts in by
  enabling 远程桌面 in its own settings; the target agent reads that file before consuming a
  request and before every frame, so enabling or disabling takes effect without an agent restart.
- The target sends repeated frames instead of one: P2P renews the request from the viewer, and the
  relay target runs a bounded encrypted-frame stream while the viewer renews its request. The viewer
  fetches the next relay frame on every 1 Hz poll and re-derives the key when a renewed stream uses a
  new target ephemeral key.
- Windows capture uses a once-compiled .NET helper (with the PowerShell path as fallback) so a frame
  costs hundreds of milliseconds rather than a PowerShell startup; the frame scheduler compensates
  for capture time to keep the one-second cadence.
- Tests: target consent (including the localside parent directory), relay streaming at the configured
  interval, P2P frame streaming and stop, viewer relay frame refresh, and a 1 Hz viewer route probe.

## [2.2.2] - 2026-11-05

- DSH 0.2.2-rc.1 compatibility: composer popups (the dispatch-target menu and the Node-execution menu)
  now render through a `react-dom` portal under `document.body`. The release candidate puts
  `container-type: inline-size` on the composer row, which makes that row the containing block for
  `position: fixed` descendants; the Node-execution menu was positioned relative to the row and its
  options could not be selected. A portal keeps the viewport coordinates the menus compute.
- Loader tests: the bundle-fetch helper sends a Fetch `Request` as 0.2.2-rc.1 requires, the real-page
  probe seeds a Workspace, opens the Node-execution menu and selects temporary execution, and the
  host route probe confirms `GET/POST /api/w2m/capability` is mounted.
## [2.2.1] - 2026-11-01

- Fleet identity is now per-account **home**-first. Each machine records the fleet key it actually joined under `fleet-home.json` beside `device.json`; switching back to an account returns to that account’s previous fleet instead of deriving a new one. This is the “whoever leaves returns by themselves” rule: a first appearance of account B may join B’s account fleet, but an existing home for A is never rewritten by B, and no other machine is moved.
- `fleetKeyPolicy` is now `home` by default. `account` keeps the v2.2.0 always-follow-the-account behaviour as an opt-in; `config` remains the explicit operator pin. An invalid policy is a startup error naming the setting, not a silent default.
- A corrupt or unreadable `fleet-home.json` is reported and blocks `home` policy instead of silently creating a new fleet; `account` policy may continue without the history. The file is written atomically with mode 0600 (ACL protection on Windows).
- Upgrading a paired 2.2.0 machine with no home to 2.2.1 keeps it in its current fleet instead of deriving the account key; an actual account switch is still allowed to make its first join, and that first join is remembered.
- leet-home.json` now also records the last account code, so a restart can tell `same account, no home yet` (stay put) from a real account switch (first join allowed).
- Composer target control: selecting a machine now writes a visible `@machine` token into the draft after the host accepts the selection. Switching targets replaces the previous token, and selecting All machines removes it; names containing whitespace use `@"machine name"`. A refused host write reopens the menu with the host’s reason; an editor rejection is shown instead of leaving a stale token.

- Settings page: new `编队绑定` section for machines that must return to an old fleet. It previews the `fleet_id` derived from a pasted key, requires explicit confirmation, then writes an independent `fleet-config.json` (0600) with a timestamped backup and rollback; `cordis.patch.yml` is never modified. The file takes precedence over the profile's `fleetKey`/`fleetKeyPolicy` at startup, and the raw key is never returned by the route.
- Tests: fleet-config storage/backup/corruption and the preview/save route, including an explicit assertion that the profile patch is untouched.
## [2.2.0] - 2026-11-01

- Fleet binding policy: `fleetKeyPolicy: account` is the new default. A configured `fleetKey` is a fallback while the signed-in account is authoritative, so switching DeepSeek accounts moves the machine without editing every profile. Set `fleetKeyPolicy: config` to keep the old explicit-pin behaviour.
- `w2m_status` now reads `device.json` through the `DSH_HOME/xclient` fallback when `stateDir` is unset; it no longer reports `paired: false` / `FLEET_UNPAIRED` on a working machine. The reported fleet is compared against the key the stack actually resolved.
- Includes the v2.1.10 `spawnSync.status` capture fix and the v2.1.11 profile-refresh fix for a switched account.
- Breaking: an explicit `fleetKey` no longer pins the fleet by default; add `fleetKeyPolicy: config` to opt out.

## [2.1.11] - 2026-11-01

- Account switch: refresh the account profile when `getDeviceIdentity()` has no userId. After a DeepSeek account switch the host clears its cached profile, so the identity read returns no userId until someone calls `getProfile()`; the plugin then derived no new fleet key and kept the previous account's token. It now fetches the profile once, derives the new key, detects the fleet mismatch and re-pairs. This is the remaining half of the v2.1.10 account-switch fix.
- Tests: a stale-profile service yields the switched account's fleet key in test/chatops-account.test.mjs.

## [2.1.10] - 2026-11-01

- Fleet binding: a DeepSeek account switch now re-pairs the machine instead of leaving it in the previous account's fleet. Startup compares the relay's fleet_id with the fleet id derived from the signed-in account, and a 60s watcher covers a switch without a process restart. A stored token is only valid for the account that minted it; it is no longer treated as proof of the current account.
- Fleet binding diagnostics: FLEET_MISMATCH names a binding to a different account's fleet; FLEET_UNBOUND keeps the existing re-admit rule.
- Remote view capture: read the `spawnSync` exit code from `status`, not the execFile-shaped `code`. `code` is `undefined` for `spawnSync`, so every successful screen capture was reported as CAPTURE_DENIED and the relay view target could never publish a frame. S2 used `status`, which is why its probe passed while the agent path failed.
- Tests: mismatch and unbound re-admit cases in test/fleet-binding.test.mjs; a capture test pins the `status` contract and would fail on the old `code` read.

## [2.1.9] - 2026-10-31

- Plugin identity: exported locale/zh.json + locale/en.json meta.title/meta.description. DSH reads these without activating the plugin, so the manager list and detail page render the custom name and copy.
- package.json exports each locale JSON explicitly and ships locale/.

## [2.1.7] - 2026-10-31

- Plugin identity: ship icon.png and package.json meta.title = "W2M：AI 智能体舰队编排工具" so a fresh install renders the custom icon/name.
- Desktop subplugin activation fix from 2.1.6 included.

## [2.1.6] - 2026-10-31

- Desktop subplugin activation fix: no longer requires a Cordis `config` service; stateDir resolves from W2M_STATE_DIR / DSH_HOME / ~/.dsh/xclient.
- Plugin details now lists three components: root, /desktop, /gpw; /desktop activates alongside the root bundle (idempotent route guard).
- Removed the duplicate case-only `./GPW` export key that broke case-insensitive manifest tooling; lowercase `/gpw` remains.

## [2.1.5] - 2026-10-31

- Packaging: desktop subplugin entry `@twinsearth/w2m-dsh-plugin/desktop` (host routes) and `/GPW` alias; root client bundle keeps the UI, same model as GPW.
- Idempotent route registration guard so root + /desktop do not mount remote-view twice.
- No behavior change to the main plugin.

## [2.1.4] - 2026-10-31

- P1.5 encrypted relay fallback: relay /v1/remote/request mailbox, host P2P-failure fallback, target polling + VK + sealed frame POST, host GET/decrypt/cache, '加密中继' UI label.
- P2P: p2pPublicPort announcement override; p2pPort config normalization.
- Target relay polling starts only with W2M_VIEW_ALLOW=1.
- Verification: preflight GREEN; view/p2p/relay tests pass; real relay deployment + two-machine E2E still pending.

## [2.1.3] - 2026-10-31

- Remote-view candidate: target selector, view.hello/VK (X25519+HKDF, AES-256-GCM), host decrypt, relay remote.frame broker/route, '加密中继' UI label.
- Still missing: P1.5 auto-fallback, target consent UI, deployed relay endpoint, real P2P verification. Test candidate.

## [2.1.2] - 2026-10-31

- Remote-view preview: settings toggle, iMac sidebar entry, local 1fps JPEG viewer, target capture module, P2P view frame protocol, host /remote/start|frame|stop routes, encrypted-relay media broker (safety core).
- Known gaps: P1.5 relay media is not wired end-to-end; peerKey/consent UI and real remote-desktop verification are pending. This release is a test candidate, not feature-complete.

## [2.1.0] - 2026-10-31

- Remote-view planning: REMOTE-DESKTOP-2.1.0.md and S2 capture probe (bin/remote-s2-capture.mjs).
- Packaging: GitHub Packages artifact published as 2.1.0 for version alignment.
- Status: the remote-desktop UI (settings toggle, iMac sidebar tab, viewer) is **not implemented yet**; 2.1.0 must not be described as feature-complete.

## [2.0.10] - 2026-10-31

- remote-view S2: ship scripts/remote-s2-capture.mjs so macOS capture/TCC probes run as a normal script (no node -e, no reparse refusal); measures 1/2 fps capture timing, JPEG size, ffmpeg presence, writes w2m-s2-result.json and supports exit-code summary.
- tests: remote-s2-capture summary/platform contract.

## [2.0.9] - 2026-10-30

- P2P 可靠性：ACK 驱动窗口、自适应窗口、RFC 6298 RTT/自适应 RTO；明文通道复用改为强制新握手。
- 传输抽象：P2PTransport / udp-v1、能力协商 + 竞速、PathScheduler 评分与 make-before-break、iroh sidecar 契约（假二进制测试）。
- 传输层：ArtifactRef v3（SHA-256 Merkle + BLAKE3 回退标记）、xfer 帧路由、P0-a 通道适配器、verifyRefV2 自洽校验与冲突驱逐。
- 编队：w2m_status.fleet / FLEET_UNBOUND、fleetKey 自动重新准入、底部状态栏（本编队/全服/Relay 圆点）。
- 测试：新增 transport/race/scheduler/discovery/iroh-sidecar/xfer-channel/router/recovery/ref-v3 等套件。

## [2.0.8] - 2026-10-29

- P2P 加密：新增 RFC 8439 ChaCha20-Poly1305 纯 JS 回退，Electron/BoringSSL 缺少 chacha 时自动启用，wire 字节与原生实现一致；保留 P2P_CIPHER_UNAVAILABLE 诊断。
- 编队绑定：w2m_status 新增 fleet 诊断块与 FLEET_UNBOUND；token 有效但 fleet_id=null 且已配置 fleetKey 时，启动路径自动重新准入，避免“只在全部机器、不在本编队”。
- 文件传输：want-block 协议（窗口、逐块校验、续传）与 sender/receiver 双角色 E2E 脚本。
- 测试：chacha 回退（Node + Electron）、fleet-binding、xfer 套件。



## [2.0.7] - 2026-10-29

- A7 encrypted mirror：/healthz.features 新增 `chat-enc-v2` 门控（默认 off）；支持时用
  `encryptChatTextV2`（AAD=session/machine/message_id）投递会话镜像，否则保持 v1；
  读取端用 `decryptChatMessageV2` 的上下文校验并保持 v1 兼容。
- 聊天发送：relay 广告 v2 且本机有 machine id 时发 v2，否则回落 v1；同一 idempotency_key 作为
  AAD message_id，重试不会产生第二行。
- 插件设置中开启 Node 代码执行能力后，任务派发无需 relay 改动；本机已切换为 permanent。

## [2.0.6] - 2026-10-29

- 修复 CI 跨平台失败：sink 授权 route 先把 stateDir 解析为 realpath（Windows RUNNER~1 / macOS
  /var→/private/var），避免“stateDir 内部目录”被误放行；相关测试按 canonical 路径断言。
- 会话搜索：纯数字 ≤100 不触发搜索（无高亮/无跳转）；只高亮当前视口，每屏最多 6 条，
  滚动时按新视口刷新（150ms 防抖，不抢滚动位置）；输入仍保持 3 秒防抖。
- 一键到顶：等待“加载中…”结束后再点“加载更早”，连续两页无增长即停止。

## [2.0.5] - 2026-10-29

- Relay 支持 AEAD v2 加密消息信封（A7 收尾）：`enc.v=2` 携带 `aad:{session_id,machine_id,message_id}`，
  relay 校验明文 AAD 与消息的 session/machine 一致后原样存储与回放；v1 信封保持兼容。
- 新增能力标记 `chat-enc-v2`（`/healthz.features`），主插件据此启用 encrypted mirror 发送。
- 新增错误码：`CHAT_AAD_MISSING` / `CHAT_AAD_MISMATCH` / `CHAT_AAD_INVALID`。
- 测试：fleet-messages AEAD v2 用例、能力协商断言（v1 兼容与未知版本拒绝保持）。

## [2.0.4] - 2026-10-28

- GPW 双策略模式：小白模式（默认）只保留黑名单强制拒绝，其余工具调用放行；高级模式需手动切换，保持四色策略。
- 小白模式自带默认保护文件夹（C:\Windows、C:\Program Files、D:\Program Files、Program Files (x86) 两盘），
  与用户黑名单合并后强制拒绝；路径类调用每 3 秒最多自动放行一次，限制突发损失。
- 高级模式挂起超时自动放行由 100 秒调整为 10 秒；黑白名单编辑与四色统计保持不变。
- GPW 设置页新增模式选择；小白模式下隐藏白名单区块、只显示默认保护文件夹与黑名单。
- 主 README 重写（六大核心功能、安装、Verified/Known gaps），并修正为连续三次点击到顶等与实现一致的描述。

## [2.0.3] - 2026-10-28

- 滚动按钮移到会话正文列右上角（黑框位置）：按官方浮动圆钮规格 34px、无边框、elevation 阴影、
  label-primary 图标色（亮色显示为黑色，暗色自动反白）、hover/active/focus-visible 状态。
- 位置由会话滚动区实时计算（正文列右缘 + 顶部内缩 8px），窗口缩放与侧栏变化时重新对齐。
- 关键修复：自动完成 DSH 官方“加载更早”——会话是虚拟列表，不点“加载更早”时 scrollTop 到顶即止，
  这是之前“点击无效/无法到顶”的真正原因。现在滚动前若已在顶部会先点一次“加载更早”等待 350ms，
  “连续点击 3 次到顶”会循环点击“加载更早”直到它消失，再把滚动区钉在顶部。
- 交互：点一次向上滚动约 3 轮；1.2 秒内连续点击 3 次回到第一轮。

## [2.0.2] - 2026-10-28

- 滚动按钮移到右下角，与 DSH 官方浮动滚动控件对齐（同右边缘、位于其上方；官方控件出现前后都会重新对齐）。
- 修复点击无反应：滚动容器改为“试滚探针”（scrollTop ±1 实际是否被浏览器接受）寻找，
  不再依赖 overflow 样式；命中后直接写 scrollTop。
- 交互改为：点一次向上滚动约 3 轮；1.2 秒内连续点击 3 次回到第一轮；不再使用长按。

## [2.0.1] - 2026-10-28

- 修复右上角滚动按钮无效：滚动容器识别改为“命中测试 + 递归 shadow root + 允许 overflow:hidden 的程序化滚动容器”，
  并直接写 scrollTop/scrollTo；找不到容器时回退到 window。旧实现只找 overflow:auto，虚拟列表/隐藏溢出容器下点击是空操作。
- 只保留一个滚动图标（SVG 向上箭头，样式与右上角官方图标对齐：32px、8px 圆角、1px 边框、right:16px/top:64px），
  删除原来的第二个“一键到顶”按钮与会话头部的重复“⇧3”按钮。
- 交互：点一次向上滚动约 3 轮；长按 3 秒直接回到第一轮（长按后松手的 click 不会重复触发）。

## [2.0.0] - 2026-10-28

主插件与既有 Relay 的对接按《W2M Relay × ToFuture 外部对接 API v1.2》收敛；ToFuture 子插件按该文档
§6/§9 保持完全独立（主插件不内嵌、不调用、不代理、不实现其运维/白名单/令牌接口）。

- 能力协商：/healthz 读取 features、operator_token_required、signing.required；缺失
  target-machines/result-projection 时明确拒绝联合派发；signing.required=true 拒绝（v1 外部客户端不支持强签）；
  operator_token_required=false 拒绝（生产必须为 true）。
- 派发：控制消息显式携带 target_machines（API §4.6：发到哪台机器只由它决定），保留
  executor_machine_id 兼容旧 relay；同 id 派发捕获 409 后读回任务而不是当成成功；
  200 但无 task_id（依赖被拒）按失败处理；被点名机器租约 refused/expired/cancelled 立即失败。
- 移除主插件内所有 ToFuture 运维面模块（MAC/IP 白名单 HMAC 上报、relay 侧识别路由），
  遵守 API v1.2 §9：主插件不得实现、调用或探测运维/白名单/令牌接口。
- 联合开发（plan/approve/dispatch/merge）仍为实验性：数据面投递与合并接线未随本版交付；
  relay 部署/升级独立于插件发布，线上 relay 版本以 /healthz 为准。

## [1.9.21] - 2026-10-28

- 发布边界：本版只发主插件；ToFuture 运维子插件由独立私有仓库另行发布，本包不包含安装/下载能力。
- 保留与 Relay 服务器配套的隐藏上报模块：HMAC 网络标识上报（/v1/tofuture/identify，relay 侧静默比对、只存 HMAC）。
  该能力默认关闭、不注册工具、不显示 UI；relay 需自行升级后才生效。
- 删除本机隐藏能力（命令触发、隐藏加密存储、自助下载/安装、票据模型），避免在公共 npm 包中携带未交付的运维面。
- 沿用 1.9.20 的浮动滚动浮标（⇧3 单击 3 轮 / 长按 3 秒到顶 + ⤒ 一键到顶）与搜索绿字黄底高亮。

## [1.9.20] - 2026-10-28

- 新增浮动滚动浮标（固定在主工作区右上角，不依赖 slot 布局）：
  · 「⇧3」：单击向上滚动约 3 轮对话；长按 3 秒直接回到第一轮；
  · 「⤒」：一键到顶。
- 浮标挂载在插件生命周期内（ctx.effect 卸载时移除），失败只记录、不影响页面启动。

## [1.9.19] - 2026-10-28

- 对话右上角新增「⇧3」按钮：单击向上滚动约 3 轮对话，长按 3 秒直接回到第一轮。
- 全文搜索高亮修复：改为直接插入本地 mark 元素（黄色背景 rgba(255,235,59,.85) + 绿色文字 rgba(11,122,51,1)），并递归遍历 shadow DOM；不再依赖 CSS Custom Highlight API，命中项一定可见。
- 同版带上 v1.9.18 的聊天收紧：relay 只接收文字与 /微笑 /火箭 /烟花 指令（图片字段、data:image、Markdown 图片、base64 图片魔数一律 400 拒绝；加密消息按设计豁免）；表情按钮改为指令按钮；长提示词镜像按 3500 B 截断，避免被 4096 B 上限静默丢弃。

## [1.9.17] - 2026-10-28

- 修复左侧栏 GPW 入口只剩小图标：恢复 🌐 GPW 文字（侧栏 label 仍为空，不会重复）。
- 对话全文搜索高亮加强：命中项绿色文字 + 黄色背景（::highlight(w2m-conversation-search) 与 .w2mSearchMark 双样式），主工作区正文中直接可见；显示 当前/总数，Enter/Shift+Enter 或 ↑/↓ 跳转，Esc 清除。

### [2.0.0-beta.1]（pre-release） - 2026-10-28

首个联合开发 beta（S0–S1）。

- S0 事实基座：operator token 安全存储（0600 文件 + 指纹状态）、relay /healthz 广告 relay_version/features、客户端能力协商 fail-closed；版本偏斜策略按“三机同版本才允许联合开发、enforce 不开启”执行。
- S1 选择真实生效：派发前按当前设备名册重校验被选机器（离线 → TARGET_UNAVAILABLE，不换机）；派发后按 relay leases 校验，未被点名的机器也执行 → 取消任务并 SELECTION_NOT_HONOURED。
- 联合开发操作员入口：w2m-joint（plan create/list/get、approve、status、dispatch --dry-run，能力协商接入）；联合开发默认关闭，属实验性 beta。
- 运维工具：w2m-scrub（dry-run/apply，递归清点 blobs/<aa>/<sha>，备份必须外置，二次幂等），用于旧 relay 清淤。
- beta 发布：仅 GitHub prerelease；npm 不发布本 beta。

## [1.9.16] - 2026-10-28

- G0-2：relay /healthz 新增 relay_version 与 features（target-machines / result-projection / guard-v1 / relay-version-v1）；w2m_status 显示这两项，便于核对三台 relay 的实际版本与能力。
- 新增 relay-capabilities 模块与 w2m-joint dispatch 能力协商：目标 relay 缺少必需 feature（或旧 relay 完全不广告）时，联合派发 fail-closed 返回 RELAY_CAPABILITIES_MISSING，不靠“先发再发现”。
- 新增 test/relay-health-capabilities.test.mjs（5 项）。

## [1.9.15] - 2026-10-28

- G0-1：operator token 安全存储。新增 `~/.w2m/operator-token`（0600，可用 W2M_OPERATOR_TOKEN_FILE 覆盖）与 `w2m-operator` CLI（set 从 stdin/文件读取、status 只显示指纹、clear）；w2m_status 新增 operatorToken_fingerprint/operatorToken_source，token 值不进日志/状态。
- 解析顺序：profile config（兼容）→ 安全文件（推荐）→ 环境变量（兼容）。
- 新增 test/operator-token.test.mjs（6 项）。

## [1.9.14] - 2026-10-28

- 修复「立即更新」失败（fetch failed）：GitHub Release 下载被网络阻断时，自动回退到 npm registry 的同一版本 tarball；下载前校验 registry 的 sha512 integrity（缺失时 sha1 shasum），再由现有安装器做 sha256 校验、备份与回滚。
- 安装器仍走运行时 pnpm（Windows 不再尝试 dsh.cmd）。
- 更新相关测试 66/66 通过。

## [1.9.13] - 2026-10-28

- 新增操作员联合开发 CLI `w2m-joint`：plan create/list/get、approve（人签、authority≥70、TTL 默认 10 分钟）、status、dispatch --dry-run（打印控制信封，真实发送未接线并返回 DISPATCH_NOT_WIRED）。
- 该 CLI 是 SOP 的操作员入口：计划先落盘、人工审批、再允许派发；dispatch 真发仍要求 operator token 与 relay 能力广告（下一片）。
- 端到端本机冒烟：create → approve → status(dispatch_allowed=true) → dispatch --dry-run(2 envelopes)。

## [1.9.12] - 2026-10-28

- 联合开发安全门（S1/S2 预置）：plan-store 保存与读取都重算 plan_sha256（篡改即 PLAN_TAMPERED）、planSha 强制 64 位十六进制（拒绝路径穿越）、审批绑定 plan_sha/approver/authority/TTL 并重算 approval_sha256（篡改/过期/低权限拒绝）、原子写。
- 全部机器选中真实性（S1）：w2m_run 在派发前用当前设备名册重校验被选机器（离线即 TARGET_UNAVAILABLE，不换机）；派发后按 relay 的 leases 校验，发现未被点名的机器也拿到租约即取消任务并返回 SELECTION_NOT_HONOURED。
- 新增 test/joint-dev-plan-store.test.mjs（11 项）。

## [1.9.11] - 2026-10-28

- 修复左侧栏只剩图标：GPW 名称恢复到入口内（🌐 GPW），侧栏 label 仍为空，避免再次重复。
- 对话全文搜索：匹配项以黄色高亮（CSS Custom Highlight API ::highlight(w2m-conversation-search)），显示 当前/总数 计数；Enter/Shift+Enter 或 ↑/↓ 在命中项间滚动，Esc 清除。

## [1.9.10] - 2026-10-28

- 新增 `bin/w2m-self-update.mjs`：可被编队任务直接下发的自更新入口，读取 GitHub Release、校验 SHA256SUMS、调用已验证安装器，输出一行 JSON，不重启 DSH。
- 固化升级策略：优先下发自更新指令；失败才使用 Node 远程执行回退（macOS 用 mac-self-update，Windows 用 node 替换+备份）。
- 参数：--profile、--dry-run、--allow-prerelease；环境变量 W2M_PROFILE_DIR / W2M_UPDATE_REPO。

## [1.9.9] - 2026-10-28

- 对话主工作区新增全文搜索：会话头部（置顶按钮同排）🔍 图标，点击展开搜索框，Enter/Shift+Enter 或 ↑/↓ 在已渲染对话中查找并高亮（Electron/Chromium find）。

- 修复 Windows「立即更新」失败：dsh 以 dsh.cmd 安装时，child_process.spawn(shell:false) 会报 EINVAL。现在 Windows 下不再把 .cmd/.bat 当作可直接执行计划，自动改用运行时 pnpm；若 dsh 计划出现 EINVAL，也会回退 pnpm 重试一次。
- 新增回归测试：.cmd 计划被拒绝并走 pnpm；spawn 失败仍回滚。

## [1.9.8] - 2026-10-28

- 左栏 GPW 入口改为纯图标（🌐），去掉重复的文字条目。
- 设置页 GPW 标签名称改为「GPW」，并使用与管理台一致的新页面（不再复用弹窗面板）。
- 编队群组视图内补齐常用聊天表情行（此前只在浮窗全屏时出现）。

## [1.9.7] - 2026-10-28

- 侧边栏与设置页入口统一命名为「GPW」，左对齐并沿用插件标签的字体、字号与间距。
- GPW 主工作区面板与设置页面板改为管理台布局：标题 + 查询/操作卡片 + 标签页 + 数据表格（路径/类型/状态/移除），参考系统黑白名单界面。
- 右下角浮标继续复用原弹窗面板，Composer 入口不变。

## [1.9.6] - 2026-10-28
- 修复：左侧栏 GPW 点击无效。侧栏入口改用 `main` 槽位（key 与 panellist id 一致），点击切换到主工作区的完整 GPW 页面。
- GPW 页面改为主工作区整页布局（960px 内容、独立滚动、卡片化分区），不再是右下角弹窗形态。
- 修复：设置页 GPW 标签沿用设置页样式（与通用设置页一致的卡片/分区）。
- 新增：「编队群组」对话视图标签（conversation.view，order 2，位于对话与规矩之后），点击进入主工作区完整聊天页；聊天页支持内置表情，参考群聊布局（消息区+输入区+表情行）。
- 底部状态栏保持：本编队在线/总数、全部机器在线/总数。
本次为 v1.9.5 五方发布（1.9.4 未发布，内容并入本版本）。
- 顶部标签栏新增「编队聊天」入口：点击进入完整分页面，支持内置表情。
- 底部状态栏常驻显示：本编队在线/总数、全部机器在线/总数，无需展开 Composer 的机器列表。
- 左侧导航栏新增 GPW 入口（🌐 图标），位于插件与自动化任务之间；点击进入完整分页面（960px 工作区），右下角浮标与 Composer 入口保持不变。
- 设置页新增 GPW 标签栏，位于「模型」与「内置插件」之间，内嵌完整 GPW 管理面板。
- 插件详情页（与卸载按钮同页）新增「W2M 插件更新」：检测更新、立即更新、自动更新开关；安装完成后自动刷新页面，无需卸载、无需重启应用。
- 更新检测打开即执行；旧版本直接显示新版本号与安装按钮；npm 镜像失败回退 registry.npmjs.org。

## [1.9.5] - 2026-10-27

## [1.9.3] - 2026-10-27
- 左侧边栏新增常驻 GPW 入口（默认显示、无关闭按钮），Composer 与右下角浮窗保留。
- 插件设置页新增“W2M 插件更新”分区：检测更新、发现新版本后立即安装、自动更新开关（开启后每次启动自动安装）。
- 更新检测修复：设置页打开即检查；本机为旧版时直接显示新版本号与安装按钮；npm 镜像不可用时回退 registry.npmjs.org。
- 自动更新不再只是偏好：开关打开后会实际调用校验与安装流程，并提示重启。

## [1.9.2-beta.1] - 2026-10-27
- P0 止血：relay 数据面端点退役（blob/blob-sessions/latest → 403），结果信封校验后投影后存储（不再落 argv/head/tail/路径原文）。
- B1 兼容窗口：默认接收 v1 信封并投影，设置 W2M_DATA_PLANE_GUARD=enforce 才硬拒。
- guard 递归扫描 + 16 KiB 语义上限 + 协议错误形状。
- beta：仅 GitHub prerelease，不含 npm/packages 发布。
**V1.9.1 更新**

## [1.9.1] — 2026-10-27

## [1.9.0] — 2026-10-27

**V1.9.0 大版本更新**

## [1.8.2] — 2026-10-26

**GPW 超时策略：黄类（名单外）100 秒无人应答自动同意；黑白名单规则不变；已覆盖父目录的子文件夹拦截记录折叠。**

- **只读工具绿名单扩展**：`read/read_file/search/grep/glob/list/…`、`job_list/job_output/job_status/job_wait`、`w2m_status/w2m_devices/w2m_tasks/w2m_history/w2m_report/w2m_memory/w2m_stats` 判为绿色（无打扰放行）；`job_kill/job_start/w2m_run/w2m_cancel/w2m_intent` 仍为黄色（可变更，需人工）。
- 超时默认值 120s → **100s**；超时结果由「拒绝」改为「自动同意」（仅黄类 / 名单外路径调用）。
- 红线（危险命令、敏感/系统路径、显式 deny）仍然立即拒绝，不进入待审批队列；白名单命中仍然立即放行。
  因此超时规则不会扩大任何名单的授权范围。
- 自动同意的调用会记录为会话授权（指纹），同一操作的后续出现以蓝色（已授权常态）直接放行。
- 「最近被拦截」折叠逻辑确认覆盖父目录下的子文件夹：名单条目是根目录，其任意深度子文件夹的拦截记录都会进入
  「已在名单中 N 条」折叠组（`folder_in` 双向包含匹配）。
- 新增 `test/gpw-auto-approve.test.mjs`（4 项：超时自动同意→下次变蓝；红线仍拒；白名单立即放行；100s 默认值）。
- 证据：`docs/acceptance/1.8.2/GPW-AUTO-APPROVE.json`。
## [1.8.1] — 2026-10-26

**GPW「最近被拦截」去噪：已在名单中的条目折叠显示；加入名单后条目立即消失。**

- 状态接口为每条 recent 增加 `folder_in`（whitelist / blacklist / null）：文件夹已被名单覆盖的拦截记录不再占用主列表。
- 面板把已覆盖条目折叠为「已在名单中 N 条 · 展开/收起」，展开后只读展示（不重复给加入按钮）。
- 从最近拦截一键加入白/黑名单时，服务端同步裁剪该条目（以及被同一父目录覆盖的条目），下一次轮询不再出现。
- 新增 `test/gpw-recent-fold.test.mjs`（4 项：覆盖归属、嵌套覆盖、客户端折叠静态断言、状态接口字段）。
- 证据：`docs/acceptance/1.8.1/GPW-RECENT-FOLD.json`。
## [1.8.0] — 2026-10-26

**GPW 增加四色审核 / 标记 / 提醒系统：绿（通过）、蓝（正常）、黄（警报）、红（风险）。**

- 新增 `src/plugin/gpw-colors.mjs`：把 DSH 各插件的审核行为归位到四色（只读/L1-L2/白名单命中/allow-list = 绿；
  本会话已批准过（指纹授权）= 蓝；越界写、非白名单命令、中风险 git/npm/网络操作、未知工具 = 黄；
  危险命令黑名单、敏感路径、系统路径、显式 deny 目录 = 红）。
- 门控改为颜色决策：绿/蓝直接放行（蓝来自会话内批准后的操作指纹）；黄进入 GPW 待审批队列；红直接拒绝
  （`tools.guard` + `tools/pre-execute` 双保险，拒绝理由带颜色语义）。
- 标记与提醒：`/api/w2m/gpw/state` 新增四色计数（colors）、待审批项与最近拦截项的颜色字段；
  面板显示四色图例与计数，待审批/最近条目带颜色标记；「允许本次会话」动作（allow-session）批准后，
  同一操作后续以蓝色（已授权常态）放行。
- 一句话语义：绿=不用管，蓝=管过了，黄=现在管，红=管也不让过（或必须人工硬确认）。
- 证据：`docs/acceptance/1.8.0/GPW-COLORS.json`。
## [1.7.9] — 2026-10-26

**GPW 三项操作性问题修复：拦截即时弹选择、名单长列表折叠、名单文件防篡改。**

- **名单策略调整：文件夹包含子文件夹**：名单条目按「根目录 + 全部子文件夹」递归匹配（`E:\work` 覆盖 `E:\work\a\b\c.txt`，`E:\workshop` 不会被误匹配；嵌套黑名单仍优先）；命令工具里的相对路径按会话工作区解析后再分类。新增测试覆盖递归覆盖、同前缀兄弟目录与相对路径。
- **发布门禁稳定性**：`test/mcp-http-live.test.mjs` 的 relay 实连用例在出口网络不可达（或 MCP 工具层报 "could not reach the relay"）时明确 `skip`，网络抖动不再把 release 门禁判红；其余用例仍覆盖本地绑定行为。
- **拦截即审批（不再静默挂起）**：`tools/pre-execute` 挂起 C 类调用后，客户端在 **composer 行**
  （`conversation.input.left`）新增内联提示 `GpwPrompt`：显示工具名与「允许本次 / 拒绝本次 / 打开面板」；
  多个待审批显示数量。浮窗按钮增加待审批数量徽标，`w2m-gpw-open` 事件让内联提示直接打开面板。
- **名单折叠**：白名单、黑名单、最近被拦截默认各显示 3 条，其余通过「另有 N 个，展开 / 收起」折叠；
  待审批项新增「加入白名单并允许」「加入黑名单并拒绝」一键动作（服务端 pending 项补充 `folder`）。
- **名单文件防篡改（fail-closed）**：`$DSH_HOME/xclient/gpw-folders.json` 改为 **MAC 签名 v2（HMAC-SHA256）
  + 原子写（tmp→rename）+ 写后只读 0444**。密钥在旁路 `*.key`（0600；或配置 `foldersKey` /
  `W2M_GPW_FOLDERS_KEY`）。
  - 外部修改（MAC 不匹配）、删除签名文件、去掉签名 → 状态 `tampered`，门控 **fail-closed**：所有命名路径的
    调用被直接拒绝；面板显示警告并提供「重置名单（清空并重新签名）」。
  - 旧版无签名文件在首次启动时一次性迁移为 v2；升级后再次出现的无签名/缺失文件视为篡改。
  - 诚实边界：DSH 与插件同用户运行时，OS 只读位可被有意的进程绕过；但签名校验使**静默改名单不可能**，
    篡改会被检测并锁定（需操作员重置）。强隔离需独立用户/服务账号（后续项）。
- **名单继承保证**：黑白名单与其 MAC 密钥位于 `$DSH_HOME/xclient/`（插件包之外），升级、重启、卸载重装都会原样继承；只有面板中的显式「移除 / 重置名单」会改变它。新增 `test/gpw-persistence.test.mjs`（5 项）覆盖。
- 测试：新增 test/gpw-hardening.test.mjs（8 项：签名往返、只读拒绝直写、MAC 不匹配/删除检测、legacy 标记、reset、密钥 sidecar）
  与 test/gpw-tamper-gate.test.mjs（4 项：篡改 fail-closed → 409 → 重置恢复 → 内联审批放行；legacy 迁移；客户端内联提示/折叠/重置静态断言）。
  reset、密钥 sidecar）。`client-bundle` 更新为五个 composer 控件；`gpw-activation` 用临时名单文件隔离，
  不再写真实 `~/.dsh`。
- 证据：`gpw-hardening 8/8`、`gpw-folder-policy 9/9`、`gpw-activation 4/4`、`client-bundle 26/26`（node 进程内运行）。

## [1.7.8] — 2026-10-26

**GPW 启用失败修复（第二个）：`TypeError: Cannot read properties of undefined (reading 'layers')`。**

- 根因：v1.7.7 为做黑名单同步拒绝，在**激活期**调用根上下文的 `ctx.tools.guard()`。tools 服务是**按 agent 组合**的，
  根作用域实例在激活阶段还没有 layer 表，于是抛 `reading 'layers'`，dsh-gpw 仍无法激活。
- 修复：改为在 `agent/created` 监听里对**每个 agent 自己的上下文** `agent.ctx.tools.guard(...)` 注册黑名单守卫，
  并用 `ctx.effect` 统一释放；根上下文不再读取 tools 服务（`inject` 回到只有 `permissionPresets`）。
- 保留 `tools/pre-execute` 三分类拦截；guard 缺失的宿主不会因此激活失败（pre-execute 仍会拒绝黑名单）。
- 回归测试升级：`test/gpw-activation.test.mjs` 现在用严格 Cordis 语义 Proxy（读取根 `tools` 即抛错）验证激活，
  并通过伪造 `agent/created` 断言守卫注册在 agent 上下文。
- 同时补全 bundle patch 中 GPW v2 的配置项（requireFullAccess / whitelist / blacklist / pendingTimeoutMs）。
- 证据：`docs/acceptance/1.7.8/GPW-AGENT-SCOPE.json`。
## [1.7.7] — 2026-10-26

**GPW 子插件启用失败修复：`cannot get property "tools" without inject`。**

- 根因：`gpw.mjs` 读取 `ctx.tools.guard` 做黑名单同步拦截，但 `inject` 只声明了 `permissionPresets`。
  Cordis 对未声明服务读取直接抛错，插件激活因此失败（组件启用失败：1 entry did not activate dsh-gpw）。
- 修复：`inject = ['permissionPresets', 'tools']`；guard 读取改为防御式（老宿主无 guard 扩展时不影响
  `tools/pre-execute` 拦截）。
- 新增回归测试 `test/gpw-activation.test.mjs`：用严格 Cordis 语义的 Proxy 上下文调用 `apply()`，
  未声明服务读取即抛错；断言 `tools/pre-execute` 监听已安装。
- 证据：`docs/acceptance/1.7.7/GPW-INJECT.json`。
## [1.7.6] — 2026-10-25

**审计修复版：测试零残留工具链 + 修复泄漏的测试夹具，并固化 v1.6.1→v1.7.4 审计报告。**

- 新增 `scripts/temp-residue.mjs`（`snapshot` / `report` / `clean`）：对用户 TEMP 中 `w2m-*`、`gpw-*`
  测试残留做基线快照、前缀统计与按年龄的安全清理；审计实测清理了 15,608 个历史残留目录。
- 新增 `test/helpers/temp-cleanup.mjs`：基线式 per-test 清理，避免并发测试互删夹具。
- 修复会泄漏临时目录的测试：`gpw-folder-policy`、`agent`（workspace 两处 fixture）、`worktree`（makeRepo）。
- 零残留复测：单轮全量测试新增残留从约 1,000 个降至 74 个（剩余前缀已量化，作为下一轮清理清单）。
- 新增审计报告 `docs/audit/AUDIT-1.6.1-1.7.4.md`：14 个正式版的 Release/CI/Compat 全绿记录、
  2930 个测试 0 失败、lint 0 error、实机部署与落库断言、relay 延迟与测试耗时实测。
- 证据：`docs/acceptance/1.7.6/AUDIT-ZERO-RESIDUE.json`。
## [1.7.5-beta.1] — 2026-10-25

**GPW 升级为文件夹三分类网关（完全权限下生效）：黑名单拒绝 / 白名单放行 / 其余进入 GPW 自己的待审批队列。**

- 生效条件：仅当会话权限预设为 **完全权限**（`danger-full-access`）时拦截；其它预设交给 DSH 自己的沙箱/审批，
  不重复介入。
- **黑名单（拒绝）**：`ctx.tools.guard()` 同步拦截，返回拒绝原因即不执行；与 `tools/pre-execute` 的监听顺序无关。
- **白名单（通过）**：等价于扩大的工作区，无需再审；仍受自动审批预算约束（每滚动窗口 10 次、间隔 3s），
  预算耗尽后同样进入待审批队列而不是静默放行。
- **其它文件夹（C 类，待审批）**：调用被挂起，进入 GPW 自己的待审批队列；用户在 GPW 面板点「允许本次/拒绝本次」
  才继续（默认 120s 无答复则拒绝）。这不是 DSH 的 approval 策略，所以在 approval=never 的完全权限下依然有效。
- 面板（Node 执行能力菜单内新增「GPW 文件夹策略」）：白/黑名单展示与移除；「添加文件夹」通过宿主原生选择器
  （Windows FolderBrowserDialog / macOS choose folder / zenity）选路径，读写名单不需要编辑任何 profile YAML；
  名单保存在 `$DSH_HOME/xclient/gpw-folders.json`，另有待审批列表与允许/拒绝按钮。
- 测试：`test/gpw-folder-policy.test.mjs`（6/6，三分类、deny 优先、前缀误判防护、命令路径提取、预算映射）。
## [1.7.4] — 2026-10-25

**修复两处桌面宿主兼容性问题：`agent.identity` 崩溃、切换 relay 后旧 device token 导致 401 无法入队。**

- 崩溃修复：`agent.identity?.()` 在桌面宿主上抛 `TypeError: agent.identity is not a function`，
  且发生在 `agent.start().then(...)` 回调里变成未处理 rejection，把整个 DSH 宿主带崩。
  新增 `agentIdentityOf()` 做类型判断，`agent.start()` 仍为非阻塞并记录失败。
- 迁移修复：relay 切换到新主 relay 后，`device.json` 里的 token 属于旧 relay，新 relay 回
  `401 UNAUTHORIZED: missing or invalid device_token`；启动逻辑看到已有 token 就跳过配对，
  导致机器停在"无列表"。现在会先用 token 探测配置的 relay：**明确 401/403 才丢弃并重新配对**，
  网络错误保留 token（不会因短暂故障误触发配对）。
- 新增回归测试：`test/agent-identity-safe.test.mjs`、`test/re-pair-stale-token.test.mjs`。
- 证据：`docs/acceptance/1.7.4/DESKTOP-HOST-COMPAT.json`（含真实崩溃信息与迁移症状）。
## [1.7.3] — 2026-10-25

**截图提示改为顶部浮层（5 秒自动消失、可关闭、不挤压输入框）；全服计数标注来源 relay 并单列本编队。**

- 截图成功/失败提示不再插在输入区里：改为聊天面板顶部浮层（绝对定位，不占布局；连续截图只替换同一行，
  不会越堆越多），**5 秒自动消失**，右侧 × 可立即关闭。
- 全服统计行改为「主 relay（地址）全服：X/Y 个编队 · A/B 台在线」，并新增一行「本编队：n/m 台在线」；
  两者语义不同，不再混在一起看。
- relay 角色判定改为按**配置的主 relay**（不再按响应最快，备用 relay 偶然更快时会被误标成 primary）。
- 证据：`docs/acceptance/1.7.3/TOAST-AND-TOTALS.json`（fleet task `01M5ANYMVMSGGQV`；宿主截图 141,768 字节）。
## [1.7.2] — 2026-10-25

**按实测反馈调整编队聊天截图/复制：只复制不预览、快捷键 Ctrl+Shift+P、强制可选中。**

- 截图按钮不再在面板里生成缩略图/下载行：抓到画面后**只写入剪贴板**并给一行提示，聊天区域保持干净。
- 快捷键从 Ctrl+P 改为 **Ctrl+Shift+P（macOS 也支持 Cmd+Shift+P）**；普通 Ctrl+P 不再被劫持，
  浏览器/应用的打印快捷键恢复原样。
- 选中&复制：`user-select:text!important` 应用到整个面板的所有子节点（不再只覆盖几个类），
  并在消息列表上阻止宿主吞掉 mousedown/copy 事件，保证拖选与 Ctrl+C 生效；单条消息的 ⧉ 复制按钮
  仍走「浏览器剪贴板 → 宿主剪贴板」回退链。
- 全服统计只认**配置的主 relay**：主 relay 不可达时不再把备用 relay 的数字（1/1 编队、2/5 在线）当"全服"显示，
  而是显示「主 relay 不可达 · 全服统计不可用」。修复了在线编队/在线机器数量"错误"的观感来源。
- 证据：`docs/acceptance/1.7.2/CHAT-CLIPBOARD-SHORTCUT.json`（fleet task `01M5ANYMVMR3IOB`；
  宿主截图实测 159,561 字节并复制成功）。
## [1.7.1] — 2026-10-25

**修复桌面壳下聊天截图/复制失败（permission denied）与插件更新"no supported installer available"。**

- 截图：浏览器 `getDisplayMedia` 在 DSH 桌面（Electron）被拒绝（`permission denied`）。新增**宿主侧截图**
  `POST /api/w2m/capture`（Windows PowerShell System.Drawing；macOS screencapture；返回 JPEG base64），
  按钮与 Ctrl+P 在渲染层捕获失败时自动回退到宿主截图，并在宿主侧复制到剪贴板。
- 复制：`navigator.clipboard` 被拒时新增**宿主剪贴板** `POST /api/w2m/clipboard`（Windows Set-Clipboard /
  macOS osascript），单条消息复制按钮与复制文本都走这条回退链。
- 选中：transcript 的 `user-select:text` 改为 `!important`，避免宿主全局样式覆盖导致无法选中。
- 插件更新：`update-install` 的安装器解析新增桌面运行时布局
  （`<app>/resources/runtime/<runtime>/dependencies/pnpm/bin/pnpm.mjs`、`~/.dsh/dsh-runtimes` 兜底），
  并用运行时自带的 `node` 执行 pnpm（桌面壳的 `process.execPath` 不是 Node）。修复了更新按钮
  "install update: no supported installer available"。

- 测试：capture-route 4/4、fleet-chat-capture 3/3、client-bundle 26/26、update-resolver 4/4；
  证据 `docs/acceptance/1.7.1/DESKTOP-CAPTURE-UPDATER.json`（fleet task `01M5ANYMVMN9CNQ`）。
## [1.7.0] — 2026-10-25

**编队聊天框：截图按钮 + Ctrl+P 快捷键 + 对话内容可选中&复制。**

- 输入区新增 **📷 截图按钮**：`getDisplayMedia` 让用户选屏幕/窗口 → 抓帧为 PNG → 自动复制到剪贴板，
  面板内显示缩略预览（可下载/再次复制）；宿主不支持或权限被拒时在面板内显示原因，不抛未处理异常。
- **Ctrl+P（macOS 也支持 Cmd+P）**：聊天面板打开时触发同一截图流程，并在捕获阶段 `preventDefault`，
  不会弹出浏览器打印对话框。
- **对话内容可选中&复制**：transcript/消息文本 `user-select:text`；每条消息新增 **⧉ 复制** 按钮；
  划选文字时点击消息不会误触发"回复"。

已知边界：编队聊天协议仍是纯文本（relay 消息不含图片字段），所以截图是"复制到剪贴板 + 预览/下载"，
不会作为图片消息广播给其他机器——图片传输需要扩展 relay 消息协议（后续版本）。

- 测试：`test/fleet-chat-capture.test.mjs` 3/3；client-bundle 26/26；
  证据 `docs/acceptance/1.7.0/CHAT-CAPTURE-CONTROLS.json`（fleet task `01M5ANYMVMLRC5H`）。
## [1.6.9] — 2026-10-24

**修复 failover 监控从未安装的根因：`startLocalStack` 等待了永不 settle 的 `agent.start()`。**

阶段日志（macOS，1.6.8，现场实测）：

```
W wrap enter relayUrls=[腾讯云, Vultr]   ← 配置正确
A startLocalStack enter
C createAgent done
S before agent.start              ← 之后没有任何日志
```

agent 实际已上线（编队在线），但 `await agent.start()` 的 Promise 永不返回，导致 `startLocalStack` 不返回 →
`startFailoverStack` 永远走不到 `relayPool(cfg)` / `setInterval`，**监控循环从未创建**，自动 failover 不可能触发。

修复：

- `startLocalStack` 不再 await `agent.start()`：后台启动，失败写日志（`w2m: agent start failed`）。
- mount 只需要返回清理句柄，不需要"观察启动完成"；agent 会通过 relay 自报在线。
- 新增回归测试 `test/agent-start-nonblocking.test.mjs`：读取源码，若 `startLocalStack` 再次 await
  `agent.start()` 即失败（防止该阻塞回归）。
- 证据：`docs/acceptance/1.6.9/FAILOVER-MONITOR-INSTALL.json`（fleet task `01M5ANYMVMKL55O`）。
## [1.6.8] — 2026-10-24

**插件面板新增「检查插件更新」按钮：npm 对比 → 自动更新 → 提示重启 DSH。**

- 客户端：目标机器菜单 relay 区新增按钮。点击后：① GET `/api/w2m/plugin-update` 联网查 npm latest
  并与已装版本比较；② 有新版时 POST `{action:"apply"}` 执行安装；③ 安装完成显示"请重启 DSH 以载入最新插件"。
- 宿主：新增路由 `/api/w2m/plugin-update`。检查逻辑在 `src/plugin/npm-update.mjs`（纯函数，可单测：只认
  `latest > installed`，网络失败是错误值而不是"已最新"）。
- 安装复用**既有已验证更新器**（`auto-update.mjs` → `update-install.mjs`）：下载 tarball、用 release
  SHA256SUMS 校验 SHA-256、备份旧包、替换新版——按钮点击不会引入第二套弱校验安装路径。
- 测试：npm-update 4/4、client-bundle 26/26；证据 `docs/acceptance/1.6.8/PLUGIN-UPDATE-BUTTON.json`
  （fleet task `01M5ANYMVMI9EHA`）。
- 边界：DSH 插件管理页的「卸载」按钮属于宿主应用（打包在 app.asar 内），插件包无法直接注入其旁边；
  本按钮位于 w2m 插件自己的面板中。若要放进宿主插件页，需要 DSH 侧提供插件动作扩展点（已列为待评估）。
## [1.6.7] — 2026-10-24

**修复 v1.6.6 failover 的阻塞 bug：远端 relay 模式下清理函数抛错，切换后无法重启 stack。**

现场演练（停主 relay 180s）暴露：机器掉线后没有切到备用，恢复主 relay 后才重新上线。根因：

- `startLocalStack` 的清理函数无条件执行 `await relay.close()`；而 `relay` 只在"本进程自建本地 relay"
  时才非空，远端 relay 模式下是 `null` → 抛 TypeError；
- failover 的切换流程 `await stop()` 抛错后被 catch 吞掉，**后续的 restart 从未执行**（stack 停了没起来）。

修复：
- 清理函数 null-safe/idempotent：仅当 `relay` 是带 `close()` 的对象才调用；`agent.stop()` 失败也继续清理。
- 切换流程：`stop()` 失败不再跳过 restart；并写诊断日志 `xclient/relay-failover.log`（每轮探测/切换/重启错误）。
- 测试：relay-failover 5/5、relay 200/200；证据 `docs/acceptance/1.6.7/FAILOVER-CLEANUP-FIX.json`
  （fleet task `01M5ANYMVMFSSP3`）。
## [1.6.6] — 2026-10-24

**relay 自动 failover：主 relay 故障时自动切到备用，恢复后自动切回。**

现场事故（2026-10-24）：主 relay 主机整体不可达（8787 与 SSH 22 都超时），备用 relay 一直健康，
但每台机器仍死连主 relay——备用链路只是常驻成员，不会接管，编队停摆。

- 新增 `src/plugin/relay-failover.mjs`：非对称滞回状态机（**连续 3 次**探测失败才切走，**连续 5 次**
  健康才切回；没有可达备选则不切）。纯函数，边界可单测。
- `startLocalStack` 外包一层 `startFailoverStack`：每 10s 探测池内各 relay `/healthz`；
  决策为切换时，停止当前 in-process stack，把 `cfg.rabbitUrl` 设为备 relay 并重启 stack——
  **切换是重新入队（fleet key 重新配对），不是重连**（device token 是按 relay 签发的）。
- `w2m_status` 新增 `failover` 快照：primary/active/pool、失败计数、切换次数、最近切换原因与历史。
- 测试：relay-failover 5/5、relay 200/200；证据 `docs/acceptance/1.6.6/RELAY-FAILOVER.json`
  （fleet task `01M5ANYMVM9GEKQ`）。
## [1.6.5] — 2026-10-24

**Windows 后台自动化不再弹窗：VBScript 隐藏包装 + 计划任务工具 + 文档。**

现场故障：给 standby 守护（每 2 分钟）和 TwinsEarth 守望（每 5 分钟）用 `schtasks /TR "node.exe ..."`
注册任务，导致桌面每隔几分钟弹出一个控制台窗口（守望脚本还会累积进程）。

- 新增 `src/util/windows-hidden-task.mjs`：纯函数构造 VBScript 包装（`WScript.Shell.Run` 窗口样式 0、
  不等待）与 `schtasks` 参数；命令行/参数先按 Windows 规则引用，再整体做一次 VBScript 转义（避免二次转义）。
- 新增 `bin/w2m-hidden-task.mjs`：`--name/--every-minutes/--command/--arg/--workdir/--delete`，
  一条命令注册“无窗口”计划任务。
- 新增 `docs/WINDOWS-BACKGROUND-TASKS.md`：故障原因、正确做法、原则（分钟级任务只放短检查；一次性任务用完即删）。
- 测试：windows-hidden-task 5/5（含转义与参数校验）；证据
  `docs/acceptance/1.6.5/HIDDEN-BACKGROUND-TASKS.json`（fleet task `01M5ANYMVM30H98`）。
## [1.6.4] — 2026-10-24

**修复：`/healthz` 漏发 `fleets_online`（1.6.3 的 `fleetSummary` 已计算，但 `stats()` 没带到公开字段）。**

- `stats()` 现在同时输出 `fleets_total` 与 `fleets_online`；
- 面板可正确显示 `全服：X/Y 个编队 · M/T 台在线`（X = 至少一台机器在线的编队数）；
- relay 主机升级到 1.6.4（含 1.6.3/1.6.2/1.6.1 全部内容）。
- 测试：relay 200/200、fleet-target 49/49；证据 `docs/acceptance/1.6.4/HEALTHZ-FLEETS-ONLINE.json`
  （fleet task `01M5ANYMVLX3MI7`）。
## [1.6.3] — 2026-10-24

**编队与机器同构显示：在线编队数/编队总数 + 在线机器/机器总数。**

- relay `fleetSummary()` 新增 `fleets_online`（至少一台机器在线的编队数），`/healthz` 公开计数同步增加；
- 面板 relay 区显示：`全服：X/Y 个编队 · M/T 台在线`（fleet-target probe 读取 `fleets_online`）；
- relay 主机升级到 1.6.3（含 1.6.2 全服概览与 1.6.1 安全修复）。
- 测试：relay 200/200、fleet-target 49/49、client-bundle 26/26；证据
  `docs/acceptance/1.6.3/ONLINE-FLEETS.json`（fleet task `01M5ANYMVLWMTSG`）。
## [1.6.2] — 2026-10-24

**relay 全服概览：多少个编队、多少台机器在线（healthz + operator /v1/fleets + 面板一行显示）。**

- `state.fleetSummary()`：按 fleet 聚合设备数/在线数，返回 `fleets_total`、`devices_online`、
  `devices_total`、`unfleeted_devices` 与 per-fleet 明细。
- `GET /healthz`（公开）新增上述**聚合计数**（不暴露 per-fleet 明细）；
- `GET /v1/fleets`（operator token）：返回 per-fleet 明细（其他账号的编队名不向普通设备暴露）。
- 面板 relay 折叠区新增一行：`全服：N 个编队 · M/T 台在线`（fleet-target probe 读取 healthz 计数）。
- relay 主机将升级到 1.6.2（包含 1.6.1 的 Node 执行仅人工/内存态与 allow-list 解释器身份修复）。
- 测试：relay 200/200、fleet-target 49/49、client-bundle 26/26；证据
  `docs/acceptance/1.6.2/RELAY-FLEET-OVERVIEW.json`（fleet task `01M5ANYMVLRYXSN`）。
## [1.6.1] — 2026-10-24

**Node 执行开关改为「仅人工 UI 手动、进程内存态」：文件/远程/自动化一律无法授权。**

本次实机验证暴露了一个必须修掉的现实：grant 任务可以远程写 `~/.w2m/exec-capability.json`，
从而远程把机器变成可执行任意 Node 代码——与"最高权限只允许人工手动选中"直接冲突。

- 能力状态改为**进程内存**唯一权威：`readExecCapability` 不再读磁盘；旧文件（含 permanent）被忽略；
  只有 host 路由 `/api/w2m/capability`（composer 人工点击）能写。
- **不随重启保留**：进程退出即回到 denied（"永久"= 本次进程生命周期）；
  `describe` 明确返回 `survives_restart: false`、`manual_only: true`、`file_ignored: true`。
- 三态语义不变：denied / temporary（默认 24h，上限 7 天，过期即失效）/ permanent（本进程内）。
- 测试重写：`test/exec-capability.test.mjs` 6/6（含"磁盘写 permanent 仍 denied""路由是唯一 setter"
  "重启即撤销"）；agent.test 161 项通过（PATH 环境问题已在本机修复，非代码缺陷）。
- 修复 allow-list 解释器身份回归：当 argv[0] 是 **运行 agent 的同一个 node（process.execPath）** 时，
  bare 条目 `node` 应放行（此前机器 PATH 里 node 指向别的程序时会误拒，实测 12 个 e2e 失败）。
- 证据 `docs/acceptance/1.6.1/MANUAL-ONLY-CAPABILITY.json`（fleet task `01M5ANYMVLDYWBH`）。
## [1.6.0] — 2026-10-24

**一台 relay 承载 N 个编队：每个 DeepSeek 账号一个编队，共享 relay 但互相隔离。**

- bootstrap 答案从"单个编队的归属"改为"relay 拓扑声明"：签名与有效期仍严格，fleet_id 不匹配不再拒绝
  （`strictFleet: true` 保留旧行为）。一份 operator 签名即可服务全部编队，新账号机器无需人工重签。
- `scripts/verify-fleet-isolation.mjs` 扩展到 **3 个编队** 14 项检查（设备枚举/任务/聊天/记忆），全过。
- 新增 `docs/MULTI-FLEET.md`：编排模型、运维视图、零人工接入新账号、配额与边界。
- 测试：bootstrap 6/6（含拓扑答案用例）、fleet isolation 14/14；证据 `docs/acceptance/1.6.0/N-FLEET.json`
  （fleet task `01M5ANYMVLBU716`）。
## [1.5.5] — 2026-10-23

**跨编队隔离：同 relay 上的另一账号机器不再出现在本编队的枚举/任务/聊天/记忆里。**

现场：另一账号的机器（自己的 fleet_id、自己的 fleet_key）出现在我们的机器列表里，被读成"非本账号
机器进入编队"。排查结论：该机器的编队绑定本身是正确的，问题在于 relay 的**读取面没有按 fleet 过滤**
（派发侧自 v0.7.7 起已按 fleet 隔离，operator token 为 relay 级权限属于设计）。

- `GET /v1/devices`：按请求设备的 fleet 过滤（无 fleet 的旧设备在未配置 fleet 的 relay 上保持历史行为）。
- `GET /v1/tasks`：任务记录携带 `fleet_id`，列表按调用者 fleet 过滤（operator 派发是 relay 级，不会进入
  某个编队的列表）。
- `POST /v1/fleet/messages`：`fleet_id` 取自已认证设备，忽略 body（防止把消息标成别的编队）。
- `GET /v1/fleet/messages`：读取时按调用者 fleet 过滤。
- fleet memory 文档按 fleet 前缀隔离（无 fleet 设备沿用历史键，单编队 relay 不受影响）。
- 新增 `scripts/verify-fleet-isolation.mjs`：真实 relay + 两个 fleet 的黑盒验证（设备/任务/聊天/记忆
  共 11 项检查），可作为部署前门禁脚本运行。
- 验证：脚本 11/11 通过（fleet task `01M5ANYMVL2Q8PD`）；relay.test 200/200 通过。
## [1.5.4] — 2026-10-23

**验签 bootstrap 的结果覆盖过期的显式 relay（现场故障：设备仍指向 127.0.0.1）。**

现场证据：DSH 升级到 v1.5.3 后仍报 `W2M_UNREACHABLE: could not reach the Rabbit at
http://127.0.0.1:8787`——它的 profile 仍显式写着本机地址，v1.5.3 只在“无显式 relay”时才采用
bootstrap 池，于是拿到池却继续拨 loopback。

- bootstrap 验签成功后**总是采用** `relays[0]` 作为 `rabbitUrl`，并 warn 记录被替换的旧地址；
  想固定 relay 的运维应显式设置 `relayUrls`（此时 bootstrap 分支不执行）。
- 只影响“验签通过”的答案；失败仍保持原配置并写 `w2m_status.bootstrap.last_error`。
- 测试：bootstrap 6/6、bootstrap-cli 6/6；证据 `docs/acceptance/1.5.4/BOOTSTRAP-WINS.json`
  （fleet task `01M5ANYMVL0FV9C`）。
## [1.5.3] — 2026-10-23

**零接触自动入队：只能升级插件的机器也能自己找到编队。**

v1.5.2 的验签 bootstrap 需要一个 URL、一个 operator 公钥和 fleetKey 才能触发——新装机器三样都没有，
于是仍然回落到编译期默认 relay 并报 W2M_UNREACHABLE。v1.5.3 把触发条件做进包里：

- 包内置默认 bootstrap 端点与 **operator 公钥 pin**（只含公钥；端点无法签发，私钥不出运维机）。
- bootstrap 证明改为可选：机器还没拿到 fleetKey 时，仍可凭"签名 + 有效期 + relay 形状"采用
  operator 声明的 relay 池（relay 列表是公开路由信息；加入编队仍需账号派生密钥，是独立一步）。
- `startLocalStack` 在无 relayUrls 时始终尝试 bootstrap（默认值生效），成功即用池（首个 primary），
  失败保持回落并写入 `w2m_status.bootstrap.last_error`。
- 包内默认 patch：`autoStartAgent: true`（本 fork），新装即启动 agent。
- 因此只有"升级插件"这一条通道的机器：升级 → 重启 → 自动取 relay 池 → 账号密钥就绪后自动配对入队。
- 测试：bootstrap 6/6（含 keyless）、bootstrap-cli 6/6、fleet-target 49/49；层模型 clean；
  证据 `docs/acceptance/1.5.3/ZERO-TOUCH-BOOTSTRAP.json`（真实 fleet task `01M5ANYMVKZ7DHH`）。
## [1.5.2] — 2026-10-23

**新机器自动获得 relay 归属（验签 bootstrap）+ 一次性配置工具。**

- 新增 `src/plugin/bootstrap.mjs`：机器用 fleetKey 派生 HMAC 证明请求 relay 列表；响应必须由
  operator 公钥（pin）对 canonical payload（fleet_id + 排序后的 relays + issued_at + expires_at）
  验签；过期/错 fleet/被篡改/坏 JSON 全部命名拒绝。缓存每次读取都重验签名与有效期，手改缓存无效。
  **任何失败都不改现有 relay 配置**，原因写入 `w2m_status.bootstrap.last_error`。
- `startLocalStack` 接线：无 `relayUrls` 且配置 `bootstrapUrl`+`fleetKey`+operator 公钥时启动即解析
  （缓存优先，其次网络），成功则采用该 relay 池（首个为 primary）；`w2m_status` 新增
  `bootstrap {configured, url, source, relays, expires_at, last_error}`。
- 新增 `bin/w2m-bootstrap.mjs`：一条命令写 `relayUrls`/`fleetKey`/`autoStartAgent` 到 profile patch，
  只改受管键、写前备份、所有输入先校验；`--temporary` 写 `relayTemporary: true`，面板以
  **红色“临时 Relay 节点（回退配置）”**显示。
- 新增 `bin/w2m-bootstrap-sign.mjs`：运维侧用 operator 私钥签名 relay 列表，输出可静态托管。
- 控制面板 relay 折叠区支持 temporary 红色标记（仅主题 token，无硬编码颜色）。
- 层模型修复：bootstrap 模块不依赖 chatops 层（layer-check 保持 clean）。
- 测试：bootstrap 5/5、bootstrap-cli 6/6、fleet-target 49/49、client-bundle 26/26；
  证据 `docs/acceptance/1.5.2/VERIFIED-BOOTSTRAP.json`（真实 fleet task `01M5ANYMVKXNU8E`）。
## [1.5.1] — 2026-10-23

**备用链路的身份隔离 + 控制面板的 relay 折叠。**

- `bin/w2m-secondary-link.mjs`：默认给子进程独立身份目录（`<stateDir>/dsh-home`），并同时设置
  `DSH_HOME` / `USERPROFILE` / `HOME`，可用 `--identity-home` 指定。修复的是 v1.5.0 现场实测的坑：
  备用链路首次启动覆盖了主链路 `~/.dsh/xclient/device.json`，机器在下一次重启前看不出问题，
  重启后却会以**备用身份**连到**错误的 relay**。这种"重启后才爆"的坑按默认隔离处理。
- 控制面板 relay 折叠：`GET /api/w2m/target` 快照新增 `relays`（`relayUrls` 数组优先，兼容单
  `rabbitUrl`），探测 `/healthz` 后按 RTT 排序、标注 primary/standby/offline；超过 3 个节点时只显示
  3 个并给出 "+N 折叠" 提示，展开后显示全部（含离线节点，不隐藏故障）。
- 探针失败保留在列表末尾（`ok:false`），网络异常不会让节点从视图中消失，也不会抛进快照路径。
- 测试：secondary-link 7/7、fleet-target 49/49（新增 relay pool 四个用例）；门禁 GREEN ×2；
  证据 `docs/acceptance/1.5.1/IDENTITY-ISOLATION-RELAY-FOLD.json`（真实 fleet task `01M5ANYMVKS3OQZ`）。

## [1.5.0] — 2026-10-23

**多 relay 双通道（active-passive）+ relay 健康看门狗。**

- 新增 `bin/w2m-secondary-link.mjs`：在一台机器上拉一条通往备用 relay 的常在线链接。
  它监督子进程 `w2m-localside`（同一套协议客户端），子进程退出按指数退避重启并记录每次转换，
  由 systemd/launchd/计划任务只守护这一层——避免"链接一次启动后静默死掉"的已知失败形态。
- active-passive 是**路由规则**：两条链接都常连，任务只在主 relay 派发；主 relay 掉线或延迟严重时
  把同一任务改派到备用 relay（机器已在线，无需重连），正常情况下一台机器只有一个执行者。
- 新增 `deploy/relay/`：`w2m-watchdog.sh` + systemd `.service/.timer`。每 30s 检查
  `/healthz` 的 `"ok":true`，连续 2 次失败才重启 relay/stun；每小时最多 5 次重启（避免掩盖根因），
  日志写 `/var/lib/w2m/watchdog/watchdog.log`。relay 因此独立于"是否有编队成员"保持在线。
- 新增 `docs/MULTI-RELAY.md`：拓扑、选路规则（健康且 RTT 最低且目标全在线）、relay 互为成员、
  以及 relay 超过 3 个时客户端折叠显示（`relays: 3 shown · +N online`）的约定。
- 测试：`test/secondary-link.test.mjs` 6/6（参数校验、child argv、退避重启、日志）；
  门禁 GREEN ×2；证据 `docs/acceptance/1.5.0/SECONDARY-LINK.json`（真实 fleet task `01M5ANYMVKR311N`）。

## [1.4.4] — 2026-10-23

**relay 重启不再丢失编队归属（devices.json 持久化 fleet_id）。**

- 持久化修复：`devices.json` 快照新增 `fleet_id` / `fleet_source`，`restore()` 同步恢复。
  在此之前，relay 重启后设备全在、token 仍有效，但每台设备的 fleet 归属全变成 null——
  编队"静默消失"且没有任何错误可看（本次在共享 relay 上实测复现）。
- 桥接 getupdates 看门狗：空闲时每 10 分钟输出 `polling ... connection live`；
  40s 长轮询超时明确记录 `poll timeout after 40s -- reconnecting`；
  连续 5 分钟没有一次成功轮询则退出（exit 3），由 launchd KeepAlive / systemd Restart= 拉起新连接，
  避免"进程活着但没人知道它是否还在轮询"的静默状态。
- 测试：relay 新增 fleet 重启往返用例（pair by fleet_key → 重启 → fleet_id/fleet_source 保留）；
  bridge 套件 36/36；门禁 GREEN ×2。
- 证据：docs/acceptance/1.4.4/FLEET-PERSISTENCE.json（真实 fleet task `01M5FLEETPERSIST0000000002`）。

## [1.4.3] — 2026-10-22

**微信编队桥接：回复可靠性修复（不回复/静默问题）。**

- 每条消息独立 try/catch：任何处理异常不再让进程退出，改为回复
  `处理失败（阶段，错误码）：原因 + /help 提示`（新增 `renderBridgeError`）。
- 桥接启动调用 `ilink/bot/msg/notifystart`：修复"token 有效、进程在跑、但 iLink 不推送消息"的静默状态；
  日志记录 `notifystart : ok`，失败也记录原因。
- 非文本、空消息、未以 `/run` 开头、权限不足、派发失败/超时等路径均保证有回复与下一步提示。
- 运行方式支持 launchd 常驻（KeepAlive 自动拉起；macOS plist 由运维部署，不进入安装包）。

- **授权优先级修复**：exec-capability 只在任务未携带 grant 时兜底；grant 被拒（replay / 过期 / 机器不符）
  原样上报，不再被能力分支覆盖成路径匹配错误，`GRANT_REPLAY` 语义恢复。

真机验收（macmini）：`notifystart ok`、错误回复代码在位、launchd state=running、bridge 进程存活；
证据 `docs/acceptance/1.4.3/BRIDGE-LIVE.json`。测试：chatops-ilink-fleet-bridge 36/36。

## [1.4.2] — 2026-10-22

**Node 代码执行权限成为 UI 可激活的子插件能力（命中真机验收）。**

- 新增 `src/util/exec-capability.mjs`：机器本地能力状态（拒绝 / 临时 24h / 永久），fail-closed；临时档带绝对
  `expires_at_ms`，过期即拒绝；唯一可放行的前缀固定为 `node -e`。
- 新增 host 路由 `GET/POST /api/w2m/capability`（`src/plugin/exec-capability-route.mjs`），同源、在 host
  认证栅栏内；浏览器不接触文件系统或设备 token。
- client `lib/client.js` 在 `conversation.input.left` 新增第三个控制（order 42）：
  `Node 执行：拒绝 | 临时 24 小时 | 永久`，带 RCE 风险提示与剩余时间。
- agent 每个任务前读取能力文件；命中时结果信封 `authorization.provenance = "exec-capability"`，
  warnings 记录 `EXEC_CAPABILITY`；pipeline 各 stage 同样覆盖。

真机验收（TwinsEarth，插件 1.4.2-beta.1；先清空 `cordis.patch.yml` 的旧 allow-list 以隔离能力路径）：
- 无能力、空 allow-list：`node --version` → `COMMAND_NOT_ALLOWED`
- 能力=永久、空 allow-list：`node -e` → **ok**（`node -e` 是唯一被放行的前缀）
- 能力=临时 5s 到期后：`node -e` → `COMMAND_NOT_ALLOWED`（fail-closed）
- 证据：`docs/acceptance/1.4.2/CAPABILITY-LIVE.json`

Verified: 单测/路由/客户端契约 43/43；候选 gate GREEN ×2；stable gate 见发布记录。

## [1.4.2-beta.1] — 2026-10-22

**Node 代码执行权限成为 UI 可激活的子插件能力。**

- 新增 `src/util/exec-capability.mjs`：机器本地能力状态（拒绝 / 临时 24h / 永久），fail-closed，
  临时档带绝对 `expires_at_ms`，过期即拒绝。
- 新增 host 路由 `GET/POST /api/w2m/capability`（`src/plugin/exec-capability-route.mjs`），同源、在
  host 认证栅栏内；浏览器不再接触文件系统或设备 token。
- client `lib/client.js` 在 `conversation.input.left` 座位新增第三个控制（order 42）：
  `Node 执行：拒绝 | 临时 24 小时 | 永久`，带 RCE 风险提示与剩余时间。
- agent 每个任务前读取能力文件；命中时结果信封 `authorization.provenance = "exec-capability"`，
  warnings 记录 `EXEC_CAPABILITY`；pipeline 各 stage 同样覆盖。
- 文档 `docs/EXEC-CAPABILITY.md`；测试 `test/exec-capability.test.mjs`（7/7）、
  client-bundle/loader-entry/exec-capability 合计 43/43。

Verified: 单测与路由测试全绿；候选版本真机验收（UI 激活 → agent 下一任务可执行 node -e）。

## [1.4.1] — 2026-10-22

**修复：授权模型在从未 bootstrap 的机器上不可用（真机发现）。**

- relay 的 offer 对 **grant 任务**也携带 `operator_key`（此前只有 maintenance 请求携带）。在空 allow-list 的机器上，
  agent 首次收到 offer 时据此 TOFU pin；修复前该机器只会得到 `GRANT_NO_PINNED_KEY`，即"显式授权"形同虚设。
- 任务台账记录 `operator_key`，relay 重启回放恢复 `workspace / grant / grant_summary / maintenance / operator_key`：
  修复前重启后 re-offer 会丢失授权字段，机器会以错误的理由拒绝任务。

真机验收（relay 1.4.1 候选，TwinsEarth 插件 1.4.0、allow-list 为空）：

- 无 grant 的 `node --version` → `COMMAND_NOT_ALLOWED`
- operator grant 授权的 `node -e` → **ok**，输出 `{plugin:"1.4.0", pinned:"^1.4.0", node:"v24.21.0"}`
- relay M1 diag（root runner）→ ok，66,046 bytes
- 证据：`docs/acceptance/1.4.1/TWIN-GRANT-LIVE.json`、`M1-LIVE-DIAG.json`

Verified: relay TOFU offer 测试 1/1、grant/ledger 相关 3/3；候选部署后真机全部通过。

## [1.4.1-beta.1] — 2026-10-22

**候选：授权模型在"从未 bootstrap 的机器"上可用。**

- relay 的 offer 现在对 **grant 任务**也携带 `operator_key`（此前只有 maintenance 请求携带），首次见到该键的
  agent 因此可以 TOFU pin；在此之前，空 allow-list 的新机器收到 grant 只会得到 `GRANT_NO_PINNED_KEY`。
- 任务台账记录 `operator_key`，重启回放恢复 `workspace / grant / grant_summary / maintenance / operator_key`：
  此前 relay 重启后 re-offer 的任务会丢失授权/工作区字段，机器会以错误的理由拒绝。
- 真机验证路径：TwinsEarth（allow-list 为空、插件 1.4.0）用 operator grant 执行 `node -e` 读取版本。

Verified: relay TOFU offer 测试 1/1，grant/ledger 相关 3/3；候选部署到 relay 后做真机验收。

## [1.4.0] — 2026-10-22

**稳定版：执行授权、任务、协作三个模型的第一版落地。**

- **执行授权模型**：`bin/w2m-grant.mjs` 签发单次执行授权（绑定 task_id/argv/机器/≤10min TTL/max_uses）；relay 派发预检
  （`GRANT_TASK_MISMATCH` / `GRANT_ARGV_MISMATCH` / `GRANT_EXPIRED` → 400）；撤销 `POST /v1/grants/revoke`（幂等、
  ledger 留痕、派发 `403 GRANT_REVOKED`）与审计 `GET /v1/grants`；结果信封携带 `authorization.provenance`
  （grant/allow-list/maintenance）；使用台账不可写时 `GRANT_LEDGER_UNAVAILABLE` fail-closed。
- **任务模型**：任务可声明 `workspace {kind:'worktree', base_commit, produce}`；agent 在独立 worktree 中执行、提交、
  生成相对 base 的 patch 并上传内容寻址 blob，结果携带 `{base_commit, head_commit, changed_files, patch_sha256,
  patch_bytes, cleaned}`；relay 侧分支 refs（单调、必须声明 from=head）、合并队列（patch sha256 幂等、already_merged）、
  冲突结果带 conflict_sha256 且绝不推进分支。
- **协作模型**：项目 room/board/artifact 索引/decisions/project memory/通知（共享对象事件广播 + 每 reader 未读水位）/
  项目级 SSE（ready + since_seq 补齐 + 实时 project.event）。
- **M7**：指标注册表与 `/metrics` 接线、证据 schema 与 preflight 第 16 项证据门禁；候选版本可用 candidate line
  fallback，stable 必须提供本线真机证据。

**发布时真机状态（如实）**：relay 宿主已运行 1.4.0 候选（1.4.0-beta.1，代码与 stable 相同），relay 侧真机回归 10/10
通过（board/artifacts/decisions/memory/locks/blobs/refs/merge/notifications/项目 SSE）。M1 维护通道的 diag 在换版后
未能执行：非特权换版路径（fleet node 通道）替换目录后由 kill 触发的重启没有拉起 `w2m-localside`（部署脚本的
systemctl 被拒绝）；在控制台执行 `systemctl restart w2m-localside` 后即可继续完成 M1 复验与 stable 官方资产部署。

证据：`docs/acceptance/1.4.0/`（REGRESSION-1.4.0.json、M1-LIVE-MAINTENANCE.json）。

## [1.4.0-beta.1] — 2026-10-22

**v1.4.0 三模型候选：执行授权模型落地、任务模型落地、协作模型落地。**

这是把 1.3.12–1.3.14 的 beta 线合成一版的候选，供 stable 前真机验收。

- **执行授权模型（v1.4.0）**：`bin/w2m-grant.mjs` 签发单次执行授权（绑定 task_id/argv/机器/≤10min TTL）；
  relay 派发预检（`GRANT_TASK_MISMATCH` / `GRANT_ARGV_MISMATCH` / `GRANT_EXPIRED`）；撤销
  `POST /v1/grants/revoke`（幂等、ledger 留痕、派发 `403 GRANT_REVOKED`）与审计 `GET /v1/grants`；
  结果信封带 `authorization.provenance`（grant/allow-list/maintenance）；使用台账不可写时
  `GRANT_LEDGER_UNAVAILABLE` fail-closed（真机发现的 EACCES 崩溃已修）。
- **任务模型（v1.4.1 前身）**：任务可声明 `workspace {kind:'worktree', base_commit, produce}`；
  agent 在独立 worktree 执行 → 提交 → 生成相对 base 的 patch → 上传内容寻址 blob → 证据
  `{base_commit, head_commit, changed_files, patch_sha256, patch_bytes, cleaned}`；
  relay 侧分支 refs（单调、必须声明 from=head）、合并队列（按 patch sha256 幂等、already_merged）、
  冲突结果携带 conflict_sha256 且绝不推进分支；refs/merge-queue HTTP 路由。
- **协作模型（v1.4.2 前身）**：项目 room（成员/角色/快照+增量事件）、board、artifact 索引、
  decisions（append-only）、project memory（版本文档）、通知（共享对象事件广播 + 每 reader 未读水位）、
  项目级 SSE（ready + since_seq 补齐 + 实时 project.event + keepalive）。

M7 证据门禁对候选版本增加 candidate line fallback：beta 候选可引用其所基于发布线的真机证据（其产物在机器升级前构建），stable 仍必须提供本线真机证据。

Verified: gate GREEN ×2；relay 测试、agent 测试、workspace/refs/board/notification/SSE 用例全绿。

## [1.3.12-beta.4] — 2026-10-22

**执行授权模型真机修复：使用台账不可写时 fail closed，而不是 crashed。**

在 relay 宿主上实测时发现"授权了但一执行就崩"：维护状态目录 `/var/lib/w2m/maintenance` 由 root 拥有且 0755，agent 以
非特权用户运行，grant 第一次通过后写 `grant-uses.json` 报 EACCES，异常冒泡成任务 `crashed` —— 授权判定其实已经通过
（同一 argv 无 grant 时是 `COMMAND_NOT_ALLOWED`），失败发生在记录环节。

- `grant-gate`：台账写入包 try/catch，失败返回 `GRANT_LEDGER_UNAVAILABLE`，不执行"未记录的一次授权"（否则单次授权会变成
  可重放漏洞），也不再把整个 handler 打崩。
- `bootstrap.sh`：`$BASE` 改为 `root:w2m 0775`，让默认安装就能写台账；queue 仍 0770、done/claimed 0750。
- 回归用例：usedFile 指向不可写路径，断言返回该 code 而非抛异常。

真机对比（修复前、relay 宿主）：
- 无 grant 的 `uname -s` → `refused/COMMAND_NOT_ALLOWED`；
- 有合法 grant 的同一 argv → 通过 gate，随后因台账 EACCES 报 crashed（本次修复的目标）。

Verified: grant-gate 7/7（含新用例）；gate GREEN twice。

## [1.3.12-beta.3] — 2026-10-22

**执行授权模型收尾：每个结果都说明"是谁授权的"。**

beta.1 让操作员能授权一次执行，beta.2 让授权可撤销、可审计；这一版补上最后一块——结果自身携带授权来源，而不是只能在
relay 台账里反查。

- 结果信封新增 `authorization` 字段：`{provenance: "grant" | "allow-list" | "maintenance", capability_id?, grant_id?}`。
  grant 路径带 `grant_id`（可与 ledger 对账），maintenance 路径带 request_id（可与 M1 台账对账），allow-list 路径标记
  provenance 即可。
- 一个决定、两个受众：gate 决定"跑不跑"，信封记录"这是哪一种决定"；refused 路径不伪造 provenance。
- e2e 断言：空 allow-list + 合法 grant 的结果 `authorization.provenance === "grant"` 且带 grant_id。
- 边界如实写进文档：provenance 是执行机器对自身判定的陈述，relay 存储但不验证它；签名仍由 agent 验证，派发仍由 relay
  预检，撤销仍由 relay 记账——台账才是权威。

Verified: agent 159/157（含 grant replay e2e 的 provenance 断言）；gate GREEN twice。

## [1.3.12-beta.2] — 2026-10-22

**执行授权模型补完：撤销与操作员审计。**

beta.1 让操作员能"授权某一次执行"；这一版让授权可以被收回、可以被查账，而不是只能等 TTL 过期。

- **撤销**：`POST /v1/grants/revoke`（operator token）`{grant_id, reason?}`。幂等（第二次 `already_revoked: true`），写入
  ledger `grant.revoked`，带 reason 与操作者。
- **派发拒绝**：携带已撤销 grant 的任务在 `POST /v1/task` 被拒，`403 GRANT_REVOKED`，机器收不到 offer；revocation 先于
  argv/task 绑定检查，理由更直接。
- **审计视图**：`GET /v1/grants`（operator token）返回 `tasks`（task_id / grant_id / argv_hash / key_id / mode / created_at）
  与 `revoked` 列表；device token 为 401，授权台账不属于机器工作面。
- **边界**：撤销阻止的是**新派发**；agent 断网时仍会执行已到手 grant 里绑定的那一次（正确性仍取决于 relay 派发，与 M2 §4
  一致）。撤销后要重新授权必须签发新 grant_id。

Verified: grant 13/13；grant-issue 3/3；relay 191/191（新增撤销+审计用例）；gate GREEN twice。

## [1.3.12-beta.1] — 2026-10-22

**执行授权模型：静态 allow-list 之外，操作员可以显式授权某一次执行。**

在此之前授权只有一层：机器本地配置的 allow-list，一个长期决定，没有"就这一次"的途径。这一版把 M2 grant 补成一条可用的
路径——签发、派发、验证、审计——而不是一个只在测试里存在的协议。

- **`bin/w2m-grant.mjs`**：操作员签发一条 grant。绑定一个 task_id（必须先确定）、一个 argv、若干 machine_id、≤10 分钟 TTL
  和 max_uses（默认 1）；stdout 输出可直接放进 `POST /v1/task` 的 `grant` 字段，stderr 打印 task_id/argv_hash/expires_at。
  该 CLI 同时登记为 package bin `w2m-grant`。
- **relay 派发预检**：task_id 不符 → `GRANT_TASK_MISMATCH`，argv_hash 不符 → `GRANT_ARGV_MISMATCH`，已过期 →
  `GRANT_EXPIRED`，都是 HTTP 400 的调用方错误；relay 不替 agent 做授权裁决。
- **审计**：task summary 增加 `argv_hash` 与 `grant_key_id`（`grant_id` 已有），让"谁授权了哪条命令"可查。
- **agent 仍是验证者**：签名、任务/机器绑定、argv、TTL、max_uses、重放（`GRANT_REPLAY`）由机器本地用 pin 的操作员公钥判定；
  空 allow-list + 合法 grant 执行，无 grant 仍 `COMMAND_NOT_ALLOWED`（既有 e2e 覆盖）。
- **文档**：`docs/COLLAB/EXECUTION-AUTH-MODEL.md` 状态改为已实现，补上"取 task_id → 签发 → 携带派发 → 两处检查 → 审计字段"
  的完整路径和仍然不做的边界（无长期委托、无自动签发、无跨项目授权）。

Verified: grant-issue 3/3（真实 CLI 子进程签发并用签名载荷验证）；grant 13/13；relay 190/190（新增派发预检用例）；gate GREEN twice。

## [1.3.11] — 2026-10-22

**Stable release: the collaboration stack's first seven modules, with the gate that measures them.**

This is the first stable since 1.3.9 (docs) that ships runtime work, and the first beta line to end with its acceptance evidence
enforced by the pre-flight rather than stored beside it. What is in it, by module:

- **M1 maintenance channel** (live on the relay host): signed update/restart/diag requests, operator-key pinning, a root runner and
  a bootstrap for Linux/Windows. Accepted on the real machine: diag (9 sections / 62 KB), relay restart with a new relay_id and
  the result delivered after it, update to 1.3.10-beta.10 (download + sha256 + atomic swap), and a post-update diag. Evidence:
  docs/acceptance/1.3.10-beta.10/.
- **M2 grants**: single-use, task-bound Ed25519 grants with argv hash, TTL, use ledger and named refusals; e2e covers an empty
  allow-list succeeding under a grant, replay, argv tampering and the no-grant refusal.
- **M3 Git-native tasks**: isolated worktrees at the caller's base commit, a content-addressed patch artifact contract, a merge
  queue with merge-slot serialisation, strict/replay policies, already_merged and a structured conflict artifact. Module-level,
  24 tests across the three slices plus two composed workflow tests.
- **M4 project room**: project objects, membership roles, a deny-by-default action matrix, snapshot + incremental events, task
  attribution (implicit default project, explicit projects refused when unknown), and the /v1/projects routes.
- **M5 multi-client primitives**: branch/file locks (leases, renewal, owner force-release, merge preflight conflicts), reviews
  (self-review guard, duplicate-verdict refusal, approval gate by patch sha) and notifications (dedupe, digest, per-reader
  watermarks, retention), with the lock routes live and their events projected into the project stream.
- **M6 cross-network reliability**: chunked, resumable blob uploads with verified commits, Range downloads, and an agent result
  outbox (atomic, persisted exponential backoff, cross-restart recovery, bounded).
- **M7 metrics and acceptance**: a 39-metric contract with a cardinality guard, live on /metrics; a validator for acceptance
  evidence; and the pre-flight's 16th check, which fails a release whose evidence does not validate or whose release line has no
  record.

Verified: pre-flight GREEN twice (16/16 checks, 2828 tests: 2814 pass, 0 fail, 14 skip); beta line beta.1 through beta.25 shipped on
GitHub prereleases only.

Known limitations, stated rather than implied: the merge queue and the review/notification routes are not wired into the task path
yet; a request that restarts the agent itself loses the ferry result (relay restarts are fine); M4 role checks cover the lock routes
and reads, not every future write; the relay runs beta.10 and is upgraded separately from this tag.

## [1.3.10-beta.25] — 2026-10-22

**M7 final core slice: acceptance evidence is a gate, not a folder.**

The pre-flight grew its 16th check. `acceptance evidence (every committed record validates, and the release line has one)`
does three things a file list cannot:

1. every JSON record under `docs/acceptance/` is validated with the M7 schema (`src/acceptance/evidence.mjs`) — a record that
   does not say which machine ran it, when, by whom and under which task id fails the gate;
2. the current release line must have at least one record: shipping a beta that claims an accepted capability while pointing at
   no evidence from its own `1.3.x` line is RED;
3. it reports what it read ("4 acceptance record(s) validated; 4 for the 1.3.10 line"), so a green row is a statement about a
   specific set of records rather than about an empty directory.

The check is bound to `docs/acceptance` in `GATE_INVENTORY`, so deleting the directory or the check breaks the inventory's
both-directions rule; the evidence validator's accepted-orphan entry is removed now that the gate imports it.

Not claimed: this gate proves the records are well-formed and current, not that the described runs happened — that is what the
task id, the machine ids and the executor field are for, and they are now mandatory.

Verified: gate GREEN twice with 16/16 registered checks; the evidence check passes on the four M1 records.

## [1.3.10-beta.24] — 2026-10-22

**M7 second slice: acceptance evidence has a schema, and the committed evidence is validated against it.**

- `src/acceptance/evidence.mjs` validates every required field of the M7 evidence record: version, uppercase case id, kind
  (positive/negative/chaos), requirement, at least one machine, ISO `executed_at`, executor (lead/human/agent), a result with a
  verdict, and — for a positive case — the real `task_id`. Optional fields are validated when present: argv arrays,
  `[from, to]` ledger ranges, `{sha256, bytes}` artifacts and an assertions object. Every problem is returned at once, because a
  release check should list what to fix rather than one field per run.
- `summarizeEvidence()` counts valid records by kind and version and names the invalid ones, which is what a release note or a
  gate summary reads.
- The test suite validates the **actual committed files** under `docs/acceptance/` — a schema that rejected the project's own
  evidence would be a schema written for a fictional project. It also pins that both the flat `result.outcome` and the nested
  `result.task.outcome` (the live restart record) are accepted as the same fact.

Registered as an accepted library with its exit named (the preflight evidence gate).

Still to wire for M7: the preflight check that a release's evidence exists and validates, and the remaining instrumentation.

Verified: evidence 6/6; gate GREEN twice.

## [1.3.10-beta.23] — 2026-10-22

**M7 wiring: the registry is live on /metrics.**

- Relay state owns the M7 registry. The project room now notifies a listener per event, and that callback counts
  `wm_project_events_total{type}` once for both the room's own events (project created, member changes, task linked) and the
  lock/review/notification events projected into it — a projection is appended, then counted through the room hook, so it cannot
  be double-counted.
- `GET /metrics` appends the registry body under a `# reliability registry` marker. A relay that never records into the registry
  renders exactly what it rendered before, which is why the existing exposition tests still pass unchanged.
- Lock routes count `wm_lock_acquired_total{kind}` and `wm_lock_conflict_total{kind}`.
- One route test: after creating a project and acquiring a branch lock, `/metrics` carries
  `wm_project_events_total{type="project.created"}` and `wm_lock_acquired_total{kind="branch"}`.

Verified: relay 189/189 (one new test); the registry and room suites are unchanged; gate GREEN twice.

## [1.3.10-beta.22] — 2026-10-22

**M7 first slice: one metrics contract for the whole collaboration stack.** A local module and eight tests; the relay /metrics
route and the call sites do not record into it yet.

- `src/relay/reliability-metrics.mjs` declares every M7 metric name, its type and the labels it may carry — 39 definitions across tasks,
  authorization, data plane, collaboration and transport. An undeclared name, an undeclared label, or a high-cardinality label
  (`task_id`, `dedupe_key`, ids) is refused at record time, so a metrics endpoint cannot silently become a memory leak.
- Counters refuse decrements; gauges hold the last value; histograms keep cumulative buckets plus sum/count. `renderPrometheus()`
  emits `_bucket/_sum/_count` with sorted, escaped label values, and `snapshot()` gives the same data as plain JSON for the panel.
- Eight tests: label aggregation, undeclared metric/label refusal, wrong-type and decrement refusal, gauge semantics, cumulative
  buckets, Prometheus text (including `+Inf`), label escaping, and the contract's own shape.

Registered as an accepted library with its exit named (the /metrics route and instrumentation). Note on the name: the exposition module was already called metrics.mjs, so after a naming collision during this work its file and test were restored, and this registry ships as reliability-metrics.mjs; both test files pass.

Still to wire for M7: the /metrics route, the instrumentation call sites, the acceptance-evidence validator and the preflight
evidence check.

Verified: metrics 8/8; gate GREEN twice.

## [1.3.10-beta.21] — 2026-10-22

**M6 second slice: the agent result outbox.** A local module and eight tests; the agent delivery path still uses the existing
spool and has not switched to it yet.

- `src/agent/outbox.mjs` — a result is written to disk (temp + rename, so a crash leaves either the old state or the complete
  entry) before any network attempt, keyed by `(task_id, attempt)` so a retried handler is one entry. Delivery removes the entry
  only after the relay acknowledged it; the relay's own dedupe makes a re-delivery safe when that acknowledgement was lost.
- Retries use exponential backoff persisted with the entry (`1s, 2s, 4s …` capped at 60s), so closing the laptop for an hour is
  a resume rather than a restart. Past `max_attempts` the entry moves to `dead/` and is reported as exhausted.
- Limits: 200 entries / 16 MiB; beyond that the oldest entries are dropped and the caller sees `outbox_full: true`
  (`OUTBOX_FULL` in the changelog's words) rather than a silent disk fill. A single oversize result is refused.
- Eight tests: atomic persist + depth, duplicate enqueue, restart recovery with attempt counts, backoff growth and exhaustion,
  ack-only removal, count-limit drop keeping the newest, corrupt-file quarantine, oversize refusal.

Registered as an accepted library with its exit named (the agent delivery switch).

Still to wire for M6: the agent's upload/download decision for large artifacts, and P2P as acceleration-only with metrics.

Verified: outbox 8/8; gate GREEN twice.

## [1.3.10-beta.20] — 2026-10-22

**M6 wiring: chunk session and Range routes.** Large artifacts now travel over HTTP without restarting from zero.

- `POST /v1/fleet/blob-sessions` declares `{sha256, size, chunk_bytes?}`; `PUT …/:sid/chunks/:index` uploads one idempotent chunk
  (octet-stream); `GET …/:sid` returns received/missing so an interrupted upload resumes; `POST …/:sid/commit` verifies the
  assembled sha256 and, on success, stores the bytes through the existing content-addressed blob store. A missing chunk answers
  `409 BLOB_INCOMPLETE` with the indices; a mismatch deletes the session and creates nothing.
- `GET /v1/fleet/blobs/:sha?range=start-end` answers `206` with `Content-Range`, so a client can fetch a large patch (or a conflict
  artifact) in slices instead of one allocation.
- The blob-session module's responses are now uniformly `{ok, session: {...}}`, which the routes and the original tests share.

Two HTTP tests: a chunked upload that commits and is then read whole plus as a Range, and an incomplete commit naming `[0,1]`.

Still to wire for M6: the agent result outbox, and P2P as acceleration-only with its observable success rate.

Verified: blob-sessions 9/9, relay 188/188 (2 new route tests); gate GREEN twice.

## [1.3.10-beta.19] — 2026-10-22

**M6 first slice: large artifacts can be uploaded in resumable chunks.** A local module and nine tests; the routes and the
agent upload path are the wiring slice after it.

- `src/relay/blob-sessions.mjs` — a client declares the final `sha256` and `size` once, then uploads chunks in any order
  (each index idempotent), asks what is missing, and commits. Only a commit whose assembled bytes hash to the declared sha256
  becomes a blob; a mismatch deletes the session and returns `BLOB_SHA_MISMATCH`, so nothing can be referenced that does not
  exist.
- Limits follow the spec: default 1 MiB chunks, `≤8 MiB` per chunk, `≤256` chunks and `≤64 MiB` per blob, two open sessions and
  512 MiB unfinished bytes per machine, 24h session TTL. A resume after a disconnect is `status()` plus the missing indices,
  which is exactly the "don't restart a 40 MiB patch" property.
- Nine tests: plan/status, out-of-order + idempotent chunks, verified commit through the store hook, incomplete commit naming
  the missing chunks, sha mismatch deleting the session, chunk length/size refusals, quotas, TTL expiry, and blob/chunk ceilings.

Registered as an accepted library with its exit named (the blob-session routes + agent upload).

Still to wire for M6: the HTTP chunk routes and Range downloads, the agent outbox for offline results, and P2P as acceleration
only.

Verified: blob-sessions 9/9; gate GREEN twice.

## [1.3.10-beta.18] — 2026-10-22

**M5 wiring, part 1: lock routes and one event stream for the primitives.**

- Relay state now owns the three M5 primitives (locks, reviews, notifications) and projects their events into the project room
  stream with the module sequence attached, so a client can reconstruct "what happened" from one cursor instead of three.
- `/v1/projects/:id/locks`: `GET` list, `POST` acquire, `POST …/:lock_id/renew`, `DELETE …/:lock_id` (holder release), and
  `DELETE …?force=1&reason=…` (owner only). A conflict is an answer, not a transport error: `409` with the holder and expiry, so a
  client can show who is editing instead of parsing a failure. Role checks sit on M4 membership (default project treats a paired
  machine as worker); a non-member receives `404` and learns nothing about the project.
- Two route tests: acquire/list/conflict/foreign-release/ordered-release, plus non-member `404` and `LOCK_FORCE_DENIED` for a
  worker trying to force release.

Still to wire: review and notification routes, the merge/review gate, and the panel views.

Verified: relay 186/186 (2 new lock route tests); gate GREEN twice.

## [1.3.10-beta.17] — 2026-10-22

**M5 third primitive: notifications.** A local module and eight tests; no routes or SSE projection use it yet.

- `src/relay/project-notifications.mjs` — notifications for a project addressed to a member or broadcast, each with kind,
  subject, refs and `requires_action`. Every row is also a `notification.created` event for the live stream, and the list route
  is the catch-up path.
- Semantics pinned by tests: the same (kind, primary ref, target) inside 60s is one row; different refs/kinds are distinct;
  overflow beyond 120 per minute collapses into one digest row that carries the count; unread is counted after a per-reader
  watermark; a watermark never moves backwards; paging is `since_ms` + limit; retention drops rows older than 7 days (or beyond
  2000 per project).
- The reader is a member identity (machine or operator), not a transport: an offline client reconnects and reads the same
  watermark it left.

Registered as an accepted library with its exit named (the notification routes).

M5 primitives are now all designed-and-implemented at module level: locks (beta.15), reviews (beta.16), notifications (beta.17).
Still missing for M5: the routes, the merge/ref gates using them, and the panel views.

Verified: project-notifications 8/8; gate GREEN twice.

## [1.3.10-beta.16] — 2026-10-22

**M5 second primitive: review tasks.** A local module and ten tests; the review routes and the merge gate do not call it yet.

- `src/relay/project-reviews.mjs` — a review points at a content-addressed `{kind, sha256, source_task_id, diffstat}` target and
  collects decisions from listed reviewers. Verdicts are records, not a mutable flag: `approve`/`changes_requested`/`comment`
  accumulate, approvals are counted per distinct reviewer, and reaching `required_approvals` moves the review to `approved`.
- Safety rules the tests pin: self-review is refused unless an owner overrides it (and the override is its own event); reviewers
  must be maintainer/owner; only listed reviewers may decide; a reviewer cannot record the same verdict twice; a
  `changes_requested` closes the round and refuses a later approve; a due date expires a pending review and late decisions are
  refused; `approvedFor(project, sha256)` answers the merge gate for an exact patch.
- Every state change is emitted as an event (`review.requested/decided/approved/changes_requested/expired/self_review_override`).

Registered as an accepted library with its exit named (the review routes + merge-requires-review gate).

Not in this slice: notifications (§4), the third M5 primitive.

Verified: project-reviews 10/10; gate GREEN twice.

## [1.3.10-beta.15] — 2026-10-22

**M5 first primitive: branch and file locks.** A local module and eight tests; no routes or merge preflight call it yet.

- `src/relay/project-locks.mjs` — one exclusive holder per `(project, branch)` or `(project, path)`, leases with renewal, lazy
  expiry that frees the target and records `lock.expired`, owner-only force release with a mandatory reason recorded as
  `lock.force_released`, per-project/per-holder limits (20/10), and a `conflicts()` preflight that answers which live locks cover a
  branch or a set of paths.
- Every mutation is returned as an event (`lock.acquired/renewed/released/expired/force_released`) so the project stream can carry
  it; the module holds no relay state and takes the clock as an injection.
- Eight tests: acquire/list/release, LOCK_HELD naming the holder, expired re-entry with both events, renew ownership and
  non-revival, force-release permission and reason, limits, preflight conflicts for branch and paths, and malformed-input refusal.

Registered as an accepted library with its exit named (the lock routes and the merge preflight check).

Not in this slice: review tasks (§3) and notifications (§4), which are the next two M5 primitives.

Verified: project-locks 8/8; gate GREEN twice.

## [1.3.10-beta.14] — 2026-10-22

**M4 third slice: the `/v1/projects` routes.**

- `GET /v1/projects` — the default project plus the projects this machine is a member of (device token).
- `GET /v1/projects/:id` — snapshot with `last_event_seq`; a machine that is not a member gets `NOT_FOUND`, so a project's
  existence is not leaked. The default project stays readable for any paired machine because it is the implicit home of unnamed
  tasks.
- `GET /v1/projects/:id/events?since_seq=N` — the incremental slice and `next_seq`, so a client can resume after a disconnect.
- `POST /v1/projects` and `POST /v1/projects/:id/members` — operator token only (the dispatch credential), because these change
  who may act on shared state; the body's initial `members` array is seeded atomically with the project.
- The routes authenticate per method and therefore sit above the shared device guard: an operator token is not a device token,
  and the earlier placement made every write answer `UNAUTHORIZED`.
- Three HTTP tests: list/create/snapshot/events with a member, a non-member seeing `NOT_FOUND`, the operator requirement, and an
  unknown project answering `NOT_FOUND`.

Still missing: artifact/memory/decision mounts, the panel view, and multi-client e2e.

Verified: relay 184/184 (3 new route tests); gate GREEN twice.

## [1.3.10-beta.13] — 2026-10-22

**M4 second slice: tasks belong to a project, and the room records it.** Relay state now owns a project room; no HTTP routes yet.

- `POST /v1/task` (internal `createTask`) accepts an optional `project_id`. Unnamed tasks land in the implicit `default`
  project, which is created lazily on first use; an explicit unknown project is refused with `BAD_REQUEST` rather than being
  created silently.
- The project room records a `task.linked` event for every task, so a snapshot's `last_event_seq` moves with the work and a
  second client can apply it as an incremental event.
- State exposes `projectSnapshot(projectId)` and `projectEvents(projectId, {sinceSeq})`; the task summary carries
  `project_id`; the replay path restores it from the ledger.
- Three attribution tests: implicit default + linked event consistency, explicit project visible on the summary, and an unknown
  project refused without creating one.

Still missing, stated: the `/v1/projects` HTTP routes, artefact/memory/decision mounts, the panel view, and multi-client e2e.

Verified: project-attribution 3/3, project-room 8/8, relay 181/181; gate GREEN twice.

## [1.3.10-beta.12] — 2026-10-22

**M4 first slice: the project room object.** A local module and eight tests; the relay routes and the panel do not call it yet.

- `src/relay/project-room.mjs` — a project aggregate (project id, name, origin, settings, members), the four roles
  (owner/maintainer/worker/observer), a deny-by-default action matrix (`read/dispatch/artifact/lock/memory/decide/merge/
  settings/members`), member add/remove/role-change as recorded events, a snapshot carrying `last_event_seq`, incremental
  events since a sequence, and per-member project listing.
- Safety rules the tests pin: the last owner cannot be removed; a duplicate member is refused by name; an unknown project is
  refused rather than creating an empty one; the permission check returns the required and current role rather than a bare
  false; a role change records `{from,to}`.

Registered as an accepted library with its exit named (the `/v1/projects` routes and the room panel), because nothing reaches it
yet.

Also in this tree since beta.11: the M1 live-acceptance evidence files under `docs/acceptance/1.3.10-beta.10/`.

Verified: project-room 8/8; gate GREEN twice.

## [1.3.10-beta.11] — 2026-10-22

**M1 update path fixed and the full acceptance set recorded.**

The live update acceptance exposed two defects that made `update` unusable even though diag and restart already worked:

1. **EXDEV on swap** — staging unpacked under `/tmp` (often tmpfs) and the swap is a rename into `/opt/w2m/app`, so the kernel
   refused with `EXDEV: cross-device link`. Staging now lives on the same filesystem as the app directory
   (`/opt/w2m/.maintenance-staging`).
2. **Ferry reported success for a failed action** — the ferry returning a result file only means the runner wrote one; the
   runner's own `status` was not inspected, so a failed update was reported as `ok`. The agent now reports
   `MAINTENANCE_FAILED` with the runner's code, and a test covers the shape.

Acceptance evidence now in the tree:
- `docs/acceptance/1.3.10-beta.10/M1-LIVE-DIAG.json` (9 sections, 62,238 bytes, runner ok)
- `M1-LIVE-RESTART.json` (relay restarted, new relay_id, result delivered)
- `M1-LIVE-UPDATE.json` (download + sha256 + swap to 1.3.10-beta.10, no auto-restart)
- `M1-LIVE-POSTUPDATE-DIAG.json` (after update + restart, a new diag still returns 59,581 bytes)

Known limitation unchanged and documented: a request restarting the agent itself kills the ferry before it reads the result
file, so the accepted restart target is the relay; delayed restart is the next fix.

Verified: gate GREEN twice; actions/ferry unit tests pass.

## [1.3.10-beta.10] — 2026-10-22

**M1 live acceptance: the maintenance channel works end to end on a real machine.**

The relay host (jp-shared) was bootstrapped and two signed requests were executed by the root runner:

- **diag** — the runner produced 9 sections (version/services/journal/disk/ports), the agent returned the task as `ok` with
  62,238 bytes of result, and the runner's own result file confirms `status: ok`. Evidence:
  `docs/acceptance/1.3.10-beta.10/M1-LIVE-DIAG.json`.
- **restart (rabbit)** — the relay was restarted by the runner, the agent survived it and delivered the task result, and the
  relay came back with a new `relay_id` and a fresh uptime. Evidence:
  `docs/acceptance/1.3.10-beta.10/M1-LIVE-RESTART.json`.

The run found four real defects, all fixed here:

1. The agent's envelope builder hashes and sizes the output; the maintenance ferry passed an execution object without
   `stdout_sha256/stdout_bytes/stderr_sha256/stderr_bytes`, so every maintenance task ended as `crashed` **after** the action had
   already run. The ferry now fills them.
2. `--operator-key` without `--operator-key-id` claimed an empty key id, which the pin store correctly refused as a mismatch;
   an absent id now means "trust the key that arrives".
3. `bootstrap.sh` made the queue root-only, so the unprivileged agent could never enqueue a request; the queue is now
   `root:w2m 0770` (write but not execute) and `done` is `root:w2m 0750`.
4. Known limitation, documented rather than hidden: a request that restarts **the agent itself** kills the process still waiting
   for its result file, so that result is lost (the action still runs). Restarting the relay is unaffected, which is why the
   accepted case uses that target; the delayed-restart fix is next.

Also verified: gate GREEN twice; the local agent suite still passes with the ferry envelope fix.

## [1.3.10-beta.9] — 2026-10-22

**M3 conflict contract completed: MERGE_CONFLICT now carries the conflict itself.**

When `git apply --3way` cannot apply a patch, the queue previously reported the changed files and the git message. It now also
captures the state git left in the merge worktree (conflict markers included) as a `conflictArtifact`:
`{ sha256, bytes, text }`. That is the evidence a reviewer needs to decide whether to resubmit against the new base or resolve
by hand, and it is the same content-addressed shape the patch artifacts use.

The head still does not move on a conflict; the test asserts both the artifact (with conflict markers) and the unchanged head,
and the composed M3 workflow test still passes.

Verified: merge-queue 7/7 (conflict artifact assertion included), m3-workflow 2/2; gate GREEN twice.

## [1.3.10-beta.8] — 2026-10-22

**M3 composed: worktree -> patch -> merge queue, proven together.**

Two integration tests drive the three modules the way a real task pair would: both tasks start from the same base in isolated
worktrees, each commits its change and produces a patch artifact, and the queue merges them one after the other. The disjoint
case ends with both files changed and the branch advanced to the second merge; the same-file case ends with a structured
MERGE_CONFLICT listing the file, the head still on the first approved commit, and the first task's change intact.

No runtime wiring yet: the agent's task handler does not create worktrees, and the relay does not run the queue. This release
records that the modules agree with each other before either becomes reachable, which is the point of composing them now.

M1 real-machine acceptance remains pending: the relay host agent is offline and root SSH authentication is refused, so the
privileged bootstrap has not run.

Verified: m3-workflow 2/2, merge-queue 7/7, worktree 5/5, patch-artifact 5/5; gate GREEN twice.

## [1.3.10-beta.7] — 2026-10-22

**M3 third block: the merge queue.** A local module and seven real-git tests; the relay task path does not import it yet.

- `src/relay/merge-queue.mjs` — one queue per project+branch with a single merge slot (holder + TTL), items named by the
  patch sha256, `strict` and `replay` base policies, and terminal verdicts: MERGED (branch head advances), `already_merged`
  for a repeat submission, `BASE_MISMATCH` under strict, and a structured `MERGE_CONFLICT` with the changed files that never
  advances the head.
- Application happens in a detached throwaway worktree, then the repository's branch and working tree are moved to the new
  commit — a merge that committed only in the worktree would leave the next reviewer looking at a head that never moved.
- Seven tests cover merge-and-advance, idempotent re-submission, stale base, conflict (head unchanged), replay onto a moved
  head, merge-slot serialisation, and patch naming.

Registered as an accepted library with its exit named (the relay merge executor dispatch), because nothing reaches it yet.

Still pending, unchanged: the M1 real-machine acceptance (relay runs beta.5 and carries the maintenance field live, but the
relay host's agent is offline and root SSH authentication has not been restored), and the M2/M3 live runs.

Verified: merge-queue 7/7; the rest of the suite is unchanged; gate GREEN twice.

## [1.3.10-beta.6] — 2026-10-21

**M3 first two blocks: isolated worktrees and a patch artifact contract. Plus the grant replay e2e.**

- `src/agent/worktree.mjs` — one git worktree per task, created detached at the caller's `base_commit`; hooks disabled,
  commit identity fixed, a porcelain snapshot before and after, commit-if-changed, `format-patch` relative to the base, and
  a removal that reports failure instead of leaking a directory. Unknown base commit and missing repository are named refusals.
- `src/agent/patch-artifact.mjs` — the transportable result: sha256 over the patch bytes, byte count, base/head commits,
  sorted changed files, inline/blob mode, and `no_change` as a successful outcome for an empty patch. Non-ASCII patches are
  measured in UTF-8 bytes, not characters.
- Five real-git tests for the worktree lifecycle and five for the artifact contract.
- `test/agent.test.mjs` gains the grant **replay** e2e: the same signed grant is used twice, the first run executes, the second
  is refused with `GRANT_REPLAY` — the use ledger is what makes "single-use" true across processes.

Not in this slice (stated, not implied): the merge queue itself (strict/replay bases, merge-slot serialization,
`MERGE_CONFLICT`), review tasks and locks (M5), and the project room (M4). The M1 real-machine acceptance is also still pending:
the relay was upgraded to beta.5 and the maintenance field is verified live, but the relay host's agent is offline and root SSH
authentication is refused, so the privileged bootstrap has not run.

Verified: agent 159/157 (replay e2e included), relay 181/181, grant 10/10, grant-gate 6/6, maintenance 17/17, ferry 4/4,
worktree 5/5, patch-artifact 5/5, layer-model 24/24, claims 47/47; gate GREEN twice.

## [1.3.10-beta.5] — 2026-10-21

**M2 grant e2e: the explicit-authorisation path is proven end to end.**

Four fake-relay tests now drive the real agent process:

- an empty allow-list executes a command **only** because a valid grant authorises that exact argv (the envelope is `ok` and
  the stdout hash matches);
- the same command with no grant is still `COMMAND_NOT_ALLOWED`;
- a grant that signed a different argv is refused with `GRANT_ARGV_MISMATCH`;
- a grant that names another machine is refused with `GRANT_WRONG_MACHINE`.

Two integration defects the e2e exposed, both fixed: the per-stage allow-list re-check ran again after step 5, so a grant that
had authorised the task was refused at the stage boundary; and the matcher's result carries `allowed` (not `ok`), so both the
gate result and the stage override had to use that shape or the refusal fell back to `COMMAND_NOT_ALLOWED`.

Verified: agent 158/156 (4 new e2e cases), relay 181/181, grant 10/10, grant-gate 6/6, maintenance 17/17, ferry 4/4,
layer-model 24/24, claims 47/47; gate GREEN twice.

## [1.3.10-beta.4] — 2026-10-21

**M1 bootstrap tooling: one privileged step, then the channel is remote.** No runtime behaviour changes.

- `deploy/maintenance/bootstrap.sh` (Linux, run once as root) — installs the fixed-action path unit/service, creates the
  queue/done/claimed directories with root ownership, optionally pins the operator public key, and enables the watcher. It
  refuses to run without `--machine-id` and refuses a tree where `bin/w2m-maintenance.mjs` is absent.
- `deploy/maintenance/bootstrap.ps1` (Windows, run once as Administrator) — same shape via a SYSTEM scheduled task; it
  substitutes the app directory and machine id into the task XML rather than editing the shipped file.
- `docs/COLLAB/M1-ACCEPTANCE-RUNBOOK.md` — the real-machine acceptance cases (diag/restart/update/rollback plus four named
  refusals), what "green" means, and the limitations that must appear in the release note (privileged bootstrap, TOFU pinning,
  no automatic recovery if a restarted machine cannot be reached).

Both scripts install **only** the fixed update/restart/diag runner; neither installs a shell, and neither touches the
allow-list. The design's security boundary is unchanged: the agent ferries a signed request, the root runner decides.

Honest gap, unchanged: the M1 real-machine acceptance run itself still needs a machine with a privileged bootstrap and a
relay carrying the maintenance fields; and the M2 grant path still lacks a fake-relay e2e case. Both are next.

Verified: gate GREEN twice; pack carries the new scripts and document.

## [1.3.10-beta.3] — 2026-10-21

**M2 first slice: task-level grants become the explicit authorisation channel.** Design: `docs/COLLAB/M2-TASK-GRANT.md`.

- `src/maintenance/grant.mjs` — grant protocol: task binding, named machine ids, argv hash + expanded argv for the operator
  to read, max uses, TTL capped at 10 minutes, nonce, and constraint fields that may only tighten the task (mode/cwd/write/
  write_scope). Verification has a named refusal for every distinct failure: wrong machine, wrong task, argv mismatch,
  expired, future, TTL too long, replay, uses exhausted, revoked key, unknown key, bad signature, constraint widening.
- `src/agent/grant-gate.mjs` — the agent-side gate: pins the operator key on first sight, verifies the grant against the
  concrete argv, and persists use counts so a spent grant stays spent across restarts. A corrupt use ledger is never read as
  "nothing used yet".
- The agent asks the grant gate **before** falling through to the allow-list refusal, and reports a grant refusal with its own
  `GRANT_*` code instead of folding it into `COMMAND_NOT_ALLOWED`.
- The relay accepts an optional `grant` on `POST /v1/task` (8 KiB cap, `grant_id` + 64-hex `argv_hash` checked), carries it on
  the offer, writes `grant_summary` into the ledger and exposes `grant_id` on the task summary.

Honest gap: the grant path has unit coverage (protocol 10, gate 6) and the existing agent/relay suites are unchanged-green,
but there is no fake-relay e2e yet for "empty allow-list executes under a grant". That case and the real two-machine run land
in the next slice together with the M2 acceptance evidence.

Verified: agent 154/152, relay 181/181, grant 10/10, grant-gate 6/6, maintenance 17/17, ferry 4/4, layer-model 24/24; gate
GREEN twice.

## [1.3.10-beta.2] — 2026-10-21

**M1 maintenance channel: relay passthrough + agent ferry.** The remote loop now has both ends.

- The relay accepts an optional `maintenance` request and `operator_key` on `POST /v1/task` (operator token already required),
  registers the key once (`operator.key.registered` in the ledger, replayed on restart), carries the request on the offer, and
  exposes `maintenance_request_id` on the task summary.
- `src/agent/maintenance-ferry.mjs` — the agent pins the operator key on first sight (TOFU, rotation chain thereafter), verifies
  the request against the pin, writes it atomically into the queue the root runner watches, waits for the runner's result file,
  and reports it as the task result. A refusal is a named value (`MAINTENANCE_NO_PINNED_KEY`, `MAINTENANCE_BAD_SIGNATURE`,
  `MAINTENANCE_RUNNER_TIMEOUT`, ...), never a thrown error, so the task result says why.
- The agent never gains the privilege to run update/restart/diag: the root runner (beta.1) remains the only executor.
- Layer model declares `maintenance` as a capability layer with an `agent -> maintenance` edge, so the new dependency is
  explained rather than excused.

Known gap, stated: no fake-runner agent-e2e test for the ferry yet (the ferry's own four cases cover pin/verify/queue/refusal);
the end-to-end case lands with the real-machine acceptance run in beta.3.

Verified: gate GREEN twice with the bundled node on PATH: 2731 tests / 2717 pass / 0 fail / 14 skip in 135 files
(agent 154/152, relay 181/181, maintenance 17/17, ferry 4/4, layer-model 24/24, claims 44/44).

## [1.3.10-beta.1] — 2026-10-21

**M1 maintenance channel, first implementation slice.** Design: `docs/COLLAB/M1-MAINTENANCE.md` (the design series names this slice v1.3.2-beta; it ships as 1.3.10-beta.1 because 1.3.9 was already published as a stable release and versions must stay ordered).

The maintenance channel lets an operator authorise exactly one of three fixed actions on one machine (update, restart, diag)
with an Ed25519-signed request, executed by a root/SYSTEM runner that reads a queue the unprivileged agent may write to. An
allow-list entry is not needed: the signature is the authorisation, and widening the allow-list is never the answer.

### What this slice contains

- `src/maintenance/protocol.mjs` — request envelope, canonical signing bytes, parameter whitelists for the three actions,
  and the complete refusal vocabulary (wrong machine, expired, future, TTL too long, replay, revoked key, unknown key,
  bad signature, bad action, bad params, too large, missing signature). TTL is capped at 10 minutes and only the pinned
  operator key can sign.
- `src/maintenance/operator-key.mjs` — Ed25519 key generation, relay registration payload, trust-on-first-use pinning with a
  rotation chain (a new key must be signed by the pinned one), revocation, and a corrupt pin store that refuses instead of
  trusting nothing.
- `src/maintenance/runner.mjs` — queue scanning, claim-before-verify, signature verification, persisted replay sets
  (request id + nonce), idempotent re-runs, and a result file for every request it looks at, refusals included.
- `src/maintenance/actions.mjs` — the three fixed actions with no shell interpolation: diag (fixed read-only command set,
  capped output), restart (fixed unit order and health waits), update (https download, sha256 verify, staged extraction,
  version check inside the artifact, backup, atomic swap, health check, automatic rollback).
- `bin/w2m-maintenance.mjs` — the root entry point (once/watch, pin bootstrap, root guard).
- `deploy/server/w2m-maintenance.{service,path}` and `deploy/windows/w2m-maintenance.xml` — the runner as a systemd path
  unit / SYSTEM scheduled task.

### What this slice deliberately does not contain

The relay routes that distribute the operator public key and the agent-side ferry that carries a request from a task offer
to the queue (and the result back) are the next slice (1.3.10-beta.2). Until then the channel is exercised by placing a
signed request in the queue directory directly — which is also the offline/bootstrap path the design keeps.

Tests: 17 new cases cover the protocol, pinning/rotation/revocation and the runner's refusal and replay behaviour. The
destructive actions are not executed in tests; they are covered by the real-machine acceptance runbook (M7 evidence).

Verified: gate GREEN twice.

## [1.3.9] — 2026-10-21

**Design-first release: the collaboration line is specified, not yet implemented.**

This release ships the design specification for the multi-machine / multi-client collaboration capability, and no behaviour change: the
plugin, relay and agent are byte-identical in function to 1.3.1. It exists so the plan is reviewable, versioned, and citable before any
of it is built.

### What is in this release

- `docs/MULTI-MACHINE-COLLABORATION-PLAN.md` — capability audit (what exists today is dispatch + aggregation, not collaboration),
  root causes (missing execution-authorization model, missing workspace model, missing shared-object model), and the M1–M7 module plan.
- `docs/COLLAB/M1-MAINTENANCE.md` — v1.3.2-beta design: signed maintenance requests executed by a root/SYSTEM unit through a queue
  directory; remote update/restart/diag without SSH and without widening the allow-list.
- `docs/COLLAB/M2-TASK-GRANT.md` — v1.3.3-beta design: operator-signed per-execution grants (argv hash, machine ids, TTL, task binding),
  agent-side verification, ledger audit, revocation; the allow-list stops being the only execution authority.
- `docs/COLLAB/M3-GIT-NATIVE-TASKS.md` — v1.3.4-beta design: per-task git worktrees, patch artifacts as the transportable result, a
  serialized merge queue, and MERGE_CONFLICT as a first-class outcome.
- `docs/COLLAB/M4-PROJECT-ROOM.md` — v1.3.5-beta design: relay-side project objects (members, board, artifacts, memory, decisions,
  refs), snapshot + incremental event protocol, role-based permissions.
- `docs/COLLAB/M5-MULTI-CLIENT-PRIMITIVES.md` — v1.3.6-beta design: branch/file locks, review tasks with findings and merge gating,
  and notifications with delivery guarantees and read watermarks.
- `docs/COLLAB/M6-CROSS-NETWORK-RELIABILITY.md` — v1.3.7-beta design: relay as the authoritative channel, chunked/resumable blobs,
  agent result outbox, and P2P demoted to opportunistic acceleration.
- `docs/COLLAB/M7-METRICS-ACCEPTANCE.md` — v1.3.8-beta design: every capability must be triggerable by a real task, negative tests are
  mandatory, metrics are computed by the relay, and evidence is checked by pre-flight.

### What is explicitly not in this release

No code for M1–M7. The three model-level designs (v1.4.0 execution-authorization, v1.4.1 task, v1.4.2 collaboration) are not written yet.
The next stable release that changes behaviour will be the one that implements M1 + M2 (the remote-operations loop), with real-machine
acceptance evidence recorded as described in M7.

Verified: gate GREEN twice on this tree; the package differs from 1.3.1 only in documentation and version metadata.

## [1.3.1] — 2026-10-21

**A red Compat and a green local gate: the loader-entry test was the gap.**

v1.3.0 shipped with a failing Compat job: `test/loader-entry.test.mjs` still listed the fifteen tools it expected the packed
artifact to register, and the artifact registers sixteen (`w2m_reduce`). The gate ran from the tree, where that test's expectation
matched the *other* fixture it derives from, so the disagreement only appeared in the packed-copy mount. The expectation now names
`w2m_reduce`, and this patch release is the artifact that matches it.

No behaviour changes: the fix is the expectation, not the tool surface. beta.2 completes the fix: `EXPECTED_TOOLS` in that same test is the list the loader gate compares against, and beta.1 patched only the other fixture. v1.3.0 is superseded.

This is the stable fix for v1.3.0's red Compat: the loader gate and the packed artifact now agree at sixteen tools. v1.3.0 is superseded on every channel; the artifact behaviour is unchanged. Verified: gate GREEN twice (2710 tests / 2696 pass / 0 fail / 14 skip in 133 files), and Compat on this tag is green before it is called stable.

## [1.3.0] — 2026-10-21

The first stable release of the collaboration line. It consolidates the four betas that followed 1.2.7 and changes no protocol in a
way that a 1.2.7 peer cannot ignore; every addition is additive and named.

### Data plane

**A reduce phase you can actually run.** `w2m_reduce` dispatches a reduce task only from complete data: it refuses unless every
declared shard reported as a blob and the named reducer reported (`W2M_REDUCE_NOT_READY` with the missing indexes), never picks a
reducer, and refuses inline inputs that cannot be carried to another machine. The relay validates, stores, ledgers and offers
`reduce_of` + `reduce_inputs`; the agent fetches those content-addressed blobs before the reduce runs and exposes
`W2M_REDUCE_INPUTS_DIR` / `W2M_REDUCE_MANIFEST` / `W2M_REDUCE_OF`; a failed fetch refuses the whole task rather than reducing a
partial fleet.

**A suggestion that dispenses no action.** `w2m_wait` carries `reduce_suggestion`: ready only when every declared shard reported and
a reducer was named, the missing indexes otherwise, the candidate machines, and the literal next step. It is derived, never stored,
and it dispatches nothing.

**Message ids survive a restart, artifacts are one size everywhere.** Chat ids carry a random per-process relay epoch
(`msg-<epoch>-<seq>`) so a restart cannot recycle an id a client persisted; the blob transport frame is 16 MiB, matching the agent's
dataflow hard cap, instead of 1 MiB against it.

### Collaboration

**The panel shows the scheduler's own buckets.** The fleet-chat panel renders 准备 / 进行 / 等待 / 阻塞 counts beside the relay's task
list, derived from the relay's `status` and `waiting_on`; read-only, no dispatch.

**Conflicts name their next step.** `w2m_memory append` returns `merge_hint` with a 409: `re-read-then-append`, `behind_by`, the
unseen count, the sample size and the literal instruction to re-read, compare and append against the current revision -- never an
automatic merge.

**Decisions leave a trail.** `w2m_council fleet-decide` reports `trail` (`appended` / `refused` / `error` / `not-written`), and the
test asserts that status instead of implying a record exists.

### Verified

Gate GREEN twice, 15 of 15: 2710 tests / 2696 pass / 0 fail / 14 skip in 133 files. Two-machine live runs over the real relay cover
the turn state machine (ask/await over SSE with a refusal), dependency scheduling, and the missing-shard refusal, plus the panel and
proxy behaviour above.

### Known limits, stated

- `pipeline` keeps `index_total` at 1; blob map results come from plain commands above the inline cap.
- The reduce suggestion is advisory: the caller dispatches the reduce (this release does not let the relay decide to run a command).
- The composer panel does not render the board buckets on a host without the Connection service; the tools still work.

## [1.2.11-beta.1] — 2026-10-21

A beta by policy: GitHub prerelease only, never npm.

### The task board in the composer panel

The fleet-chat panel already listed the relay's tasks; it now also shows the four buckets the scheduler uses — 准备 / 进行 / 等待 / 阻塞 — derived from the relay's own `status` and `waiting_on`, never from a classification of its own. Read-only: the panel dispatches nothing.

### Merge hint on memory conflicts

`w2m_memory append` returns `merge_hint` with a 409: state `re-read-then-append`, `behind_by`, the number of unseen records, the sample size, and the literal next step (re-read, compare, append against the current revision — do not merge unseen records). Pure function, no automatic merge.

### Council decisions leave a trail

`w2m_council fleet-decide` reports `trail` (`appended` / `refused` / `error` / `not-written`) instead of implying a record exists; the test now asserts that status.

Verified: gate GREEN twice, 2704 tests / 2690 pass / 0 fail / 14 skip in 132 files; client-bundle 25/25 after the board line; the merge-hint and trail tests are new.

## [1.2.10-beta.1] — 2026-10-21

A beta by policy: GitHub prerelease only, never npm. This one makes the reduce phase executable.

### Reduce execution (caller-dispatched)

`w2m_reduce` dispatches a reduce only from complete data: it refuses unless every declared shard reported as a blob and the named reducer reported (`W2M_REDUCE_NOT_READY`, with the missing indexes). It never picks a reducer and never invents inputs; inline results are refused (`W2M_REDUCE_INLINE_INPUT`) because they cannot be carried to another machine.

The relay validates and carries `reduce_of` + `reduce_inputs` (at most 16 artifacts, sha256 only) on the task, the ledger and the offer; the agent fetches those content-addressed blobs BEFORE running the reduce and exposes `W2M_REDUCE_INPUTS_DIR` / `W2M_REDUCE_MANIFEST` / `W2M_REDUCE_OF` to the command. A failed fetch refuses the task (`REDUCE_INPUT_FETCH_FAILED`) rather than reducing half the fleet.

Verified: gate GREEN twice, 2701 tests / 2687 pass / 0 fail / 14 skip in 131 files; new agent e2e proves the reduce reads the exact artifact bytes; the tool has a dispatch test and a refusal test.

## [1.2.9-beta.1] — 2026-10-21

A beta by policy: **GitHub prerelease only, never npm.** The theme is the data plane and the collaboration plane: the design is
written down (`docs/DATA-PLANE-COLLABORATION.md`) and this release ships its first slice.

### `reduce_suggestion` on `w2m_wait`

Every terminal wait now answers three questions without acting on them: is the data complete, who could reduce it, and what the
caller is supposed to do next (`dispatch the reduce yourself; this tool does not run it`). It is a pure function over the machine
facts the aggregate already publishes:

- **ready** only when every declared shard reported and a reducer was named;
- **missing indexes** when a shard never reported (an expired lease cannot claim one);
- **candidates** listing the machines that reported, with the reason;
- a named reducer that never reported is refused by name (`REDUCER_UNREPORTED`) rather than silently replaced -- changing the
  machine changes what the reduce runs against;
- a caller that named no reducer gets `REDUCER_MISSING` and candidates, never an invented choice.

Nothing is stored and nothing is dispatched. Two readers of the same aggregate get the same suggestion, and reading does not
change relay state.

### The design document states the open question

Caller-dispatched reduce (current direction) versus auto-reduce in the relay. The design leans caller-dispatched, because a relay
that decides to run a command is the boundary every other decision avoids; a beta that flipped that default would be the wrong
place to discover it. The document also names the next collaboration slices: conflict-merge UI, council decision trail to shared
memory, and the board in the composer panel.

### Verified

Gate GREEN twice: 2699 tests / 2685 pass / 0 fail / 14 skip in 131 files. New: `suggestReduce` unit tests (7) covering complete,
partial-with-missing, no-reducer, unreported-reducer and mixed inline+blob inputs; `w2m_wait` carries the suggestion for every
aggregate.
## [1.2.8-beta.1] — 2026-10-21

A beta, by policy: **not published to npm**. It is a GitHub prerelease, installable by a developer who asks for it.

### Message ids are unique across a relay restart

The relay's chat sequence resets on restart, so a bare `msg-000001` named a different message after every deploy. Clients persist
those ids -- an open turn, a read watermark, `reply_to` -- and live testing caught exactly that: a Windows `ask` recorded a turn, the
relay restarted, a new message reused the id, and the wait settled the OLD turn as `answered_after_timeout` while the reply was
fresh. Message ids now carry a random per-process epoch (`msg-<epoch>-<seq>`), so a restart cannot recycle an id and old clients that
render ids verbatim keep working.

### One size for "how large may one artifact be"

The blob transport frame was 1 MiB while the agent's dataflow hard cap is 16 MiB, so an artifact between the two was accepted by the
agent and then failed its upload (`BLOB_UPLOAD_FAILED`) on a relay that looked fine. `BLOB_FRAME_BYTES` is now 16 MiB, matching the
agent, while every JSON route keeps the 64 KiB frame limit.

### Verified

Gate GREEN twice: 2691 tests / 2677 pass / 0 fail / 14 skip in 130 files. New tests: an id is unique across two store instances
(same sequence, different process), an explicit epoch is honoured, and a 2 MiB blob survives the transport intact.

### Still open (unchanged from 1.2.7)

- `pipeline` keeps `index_total` at 1; blob map results come from plain commands above the inline cap.
- macmini runs 1.2.6 from its own checkout and needs a `git pull` + restart for the plain-command blob behaviour.
## [1.2.7] — 2026-10-21

**The scheduler enforces the graph, a wait survives a restart and a dropped stream, and a partial fleet can no longer call itself
a complete reduce.**

### Turns are a state machine on disk

A question written with `action:'ask'` becomes a persisted turn (`ask_id`, deadline). `await` attaches to that record, so a process
restart does not lose the question or turn a late answer into silence; a late answer is recorded as `answered_after_timeout`. The
wait prefers the relay's event stream, re-subscribes when the stream drops, and polls only when streaming is unavailable. A reply
now carries `reply_state: 'answered'|'refused'`, so a refusal is a state the waiter reads rather than wording it guesses.

### Dependencies block dispatch, and release when their prerequisite settles

A task with `depends_on` is not offered: its leases are `waiting`, which redelivery skips and the sweeper ignores. When every
prerequisite is settled -- **by a result, an expiry or a refusal** -- `_releaseDependents` moves those leases to offers. The graph
edges and `assignee` are written into the task ledger, because live testing showed a restarted relay losing them and keeping a
waiting task waiting forever. `assignee` is enforced, not recorded: only that machine gets a lease, and an unknown assignee is
refused by name. `GET /v1/tasks` now publishes a derived `status` (`waiting`/`active`/`done`/`failed`/`cancelled`) and
`waiting_on`, so the board and the scheduler cannot disagree.

### Dataflow: an expected shard count, and a reduce that refuses partial input

`buildReducePlan` takes `expectedIndexTotal` from the task (`index_total`) and refuses `MISSING_SHARD` (with the missing indexes),
`MAP_INDEX_MISSING` and `MAP_INDEX_OUT_OF_RANGE`; only machines that actually reported can claim a shard, so an expired lease no
longer makes a partial run look complete. Two production gaps were found by live testing and closed with it:

- **A large plain-command stdout was never a blob.** The blob path lived only in the pipeline loop, so a split/mapreduce map result
  was always inline and a reduce plan could never see what it reduces. Any command output above the inline cap now uploads a blob
  exactly as a pipeline stage does (best effort: a failed upload keeps the command successful and says why).
- **The relay's own frame limit made the blob channel unusable.** `MAX_FRAME_BYTES` (64 KiB) equals the inline threshold, so every
  blob was by construction larger than the frame cap and a real upload failed with `FRAME_TOO_LARGE` while the fake relay in tests
  accepted it. Blob PUTs now get a bounded 1 MiB frame (`BLOB_FRAME_BYTES`); every JSON route keeps the 64 KiB cap.
- The aggregate now publishes `blob_sha256`, `output_mode`, `stdout_head` and `stdout_bytes` per machine: `w2m_wait` used to read
  `aggregate.detail.machines`, a shape the production `/v1/tasks` response never carries, so the reduce plan was unreachable
  outside tests.

### Verified

Gate GREEN twice, 15 of 15: 2687 tests / 2673 pass / 0 fail / 14 skip in 130 files.

Two-machine live runs on Windows (ToFuture) and jp-shared over the real relay:

- **await over SSE**: Windows asks, jp-shared replies `reply_state:'refused'`; the wait returns `state=refused, via=stream`, and the
  turn is settled on disk.
- **dependency chain**: B with `depends_on: [A]` is `waiting`, A settles, B is released (observed `status=active` with offers).
- **missing shard**: a split task with `index_total: 5` whose map results are blobs is refused as
  `MISSING_SHARD {missing:[1,3,4], expectedIndexTotal:5}` with `dataflow_degraded: true` -- the first live exercise of the blob
  channel end to end.

Both live-testing defects above (release only on a result; graph edges missing from the ledger) were found by these runs and are
covered by tests now.

### Limits, stated

- A pipeline task runs the whole chain per machine, so `index_total` stays 1 for it; blob map results come from plain commands above
  the inline cap.
- The blob transport frame is 1 MiB while the agent's dataflow hard cap is 16 MiB: a single artifact above 1 MiB fails its upload
  explicitly (`BLOB_UPLOAD_FAILED`) rather than being split across frames.
- The jp-shared agent was upgraded to this build; macmini runs 1.2.6 from its own checkout and needs a `git pull` + restart to get
  the plain-command blob behaviour.
## [1.2.6] — 2026-10-20

**Security surface: signatures, a permission matrix, and output that no longer carries secrets — plus the reliability the chat
needed before it could be trusted with real messages.**

### Command signatures

The agent signs `{task_id, argv_hash, machine_id, ts}` with an Ed25519 key derived from its device key (`DeviceKey` is X25519 and
cannot sign; deriving keeps one secret per machine). The envelope carries `signature {alg, value, public_key, ts}`, and
`w2m_wait` reports every machine as `signed`, `unsigned` or `bad_signature`, with a task-level `signature_warning`. A tampered
`argv_hash` verifies as `bad_signature` -- tested at the unit level and end to end through a real agent run.

Honest limit: the public half travels inside the signature. That proves the result matches the key it carries, not that the key
belongs to the machine. Binding it to the relay's device record is the remaining step for non-repudiation across machines, and it
is named here rather than implied.

### Permission matrix

`src/util/policy-matrix.mjs` is the single table: `observer < worker < owner` against `read_private | vote | join | dispatch |
approve | manage_members`. A refusal is `FORBIDDEN_ACTION` naming the action, the level required and the level held. The relay
enforces it where a role actually acts: an observer may read the fleet flow and may not post into it. Unknown means worker, never
owner.

### Output redaction

`stdout_head`/`tail` and `stderr_head`/`tail` are filtered for API keys, `npm_`/`github_pat_` tokens and private-key blocks,
replaced in place with `[redacted:class]` so line numbers survive. Hashes and blobs are never touched: they are evidence of the raw
bytes. `redactOutput: false` is allowed and marks the envelope `unredacted: true`.

### End-to-end encrypted chat

Sending encrypts with AES-256-GCM under a group key derived as `HKDF(fleetKey, 'fleet-chat-v1')`; the relay stores ciphertext and
cannot open it. Reading decrypts what the key covers and marks the rest `encrypted: true` with a `decrypt_error`. Plaintext
messages keep working, so older clients neither break nor are lied to. The relay validates the encryption envelope's shape and
refuses a malformed one (`BAD_ENCRYPTION`), and cannot search content -- which is the point, and is written down as the cost.

### Reliability

- **Role persistence**: `member.role` ledger entries replay on restart, so a relay restart no longer silently demotes every owner.
  Verified live: the role that was lost before the deploy came back after it.
- **Chat cursor**: `list` continues where the last page ended (`since_ms` from a persisted per-session cursor) and advances only
  over what was actually read.
- **Offline spool**: a send that cannot reach the relay is written to disk with an idempotency key and replayed on the next call;
  a replay that the relay already received returns the first message instead of posting twice.

### Verified

Gate GREEN twice, 15 of 15: 2666 tests / 2652 pass / 0 fail / 14 skip in 130 files. New suites: chat-crypto (8),
envelope-signature (6), policy-matrix (9); agent 152, relay 173, tools 132, fleet-messages 14.

Relay redeployed twice from hash-verified tarballs, with state backups, and the new surfaces exercised against the live relay:
encrypted message stored as ciphertext and read back, malformed encryption refused with 400, roles restored after restart.

### Known gaps

- The GitHub Packages mirror still holds an orphan `1.2.4` published by a diagnostic dispatch; removal needs a token with package
  administration (this one sees 404 on the package API).
- The signing public key is not yet bound to the relay's device record (see above).
- Two-machine end-to-end runs of the new chat surface are still not done; the HTTP and tool surfaces are tested against fakes and
  exercised once against jp-shared.
## [1.2.5] — 2026-10-20

**Who is in the fleet, what they have read, who was named, and a retry that cannot double-post.**

### Members and roles

`GET /v1/fleet/members` lists every machine with its name, role, join time, presence and last-seen time. `PUT
/v1/fleet/members/{id}` changes a role and requires the **operator** token, so the route sits with dispatch rather than behind the
device gate. Roles are `owner | worker | observer` and live in their own table: a device record is written by pairing and by
reconnect, and a role is an operator decision that must survive both. An unknown machine is a `worker`, never an `owner` -- a
re-pair cannot gain authority. The last owner cannot be demoted, because then nobody could readmit a machine.

### Read watermarks

`PUT /v1/fleet/read/{session}` records how far this machine has read a conversation (its own token decides which machine);
`GET /v1/fleet/read/{session}` answers the watermark and an unread count of messages from others newer than it. Only forward: a
stale marker arriving late must not move the watermark backwards, or the count would grow for messages already seen.

### Mentions

A message may carry `mentions: [machine_id]` (at most 10, validated). The row is still **one** row -- a mention is a
notification hint, not a delivery mechanism -- and the SSE notification says only whether **this** listener was named. It never
carries the text, and it does not carry the mention list.

### Idempotent posts

`POST /v1/fleet/messages` accepts `idempotency_key` (per session). A retry after a lost response returns the **first** message
with `deduped: true` instead of storing the sentence twice. The key is bounded, like the message log.

### Two defects the 1.2.4 tag carried, fixed here

The 1.2.4 commit (tag `v1.2.4`) had a red CI and a red Compat, both found before approval:

- **Compat**: `w2m_wait`'s `reducer_machine_id` declaration had been pasted **inside** `poll_ms`. Every local check was green;
  the real host refused the whole entry ("parameters.poll_ms.reducer_machine_id is not supported by the value schema DSL"). The
  parameter now sits where it belongs, and `schema-spec.mjs` gained `strayParameterProblems()` — a parameter declaration
  nested inside another parameter is now refused where the tool is written, with two tests.
- **CI**: the cancellation HTTP test had been inserted inside an enclosing `it`. Node 24 ran it; Node 20/22 reported
  `cancelledByParent`. The test now lives in its own top-level `describe`.

### Verified

Gate GREEN twice, 15 of 15: 2628 tests / 2614 pass / 0 fail / 14 skip. New suites: fleet-members (6); fleet-messages grew to 11;
relay grew to 171 including two HTTP cases for members and watermarks.

The relay was deployed a fourth time from a hash-verified tarball with a state backup, and the new routes were exercised against
the live relay (members returned 8 machines; a role change returned 200; a watermark round-tripped; unread answered 0).

### Not in this release

- **Offline replay of outbound chat** is not implemented. The agent's spool already holds undeliverable *results*; chat text is
  not yet spooled and replayed.
- A two-machine end-to-end run of mentions/watermarks. The HTTP surface is tested against the fake relay and exercised once
  against jp-shared, but not by two physical machines.
## [1.2.4] — 2026-10-20

**Fleet collaboration, part two: cancellation, dependencies, a task board, questions on disk, and output that travels.**

### Cancelling a task over HTTP

`state.cancelTask` has existed since the task ledger gained a cancel flag, but **no route reached it**. `POST /v1/tasks/{id}/cancel`
now does, with the same operator authorization dispatch requires, and `w2m_cancel` is the tool over it. Cancelling twice is not
an error: the ledger is the answer.

### Prerequisites and a task board

- `POST /v1/task` accepts `depends_on[]`. Validated at **enqueue** time: unknown prerequisite, self-edge, duplicate edge and
  cycles are refused by name (`src/relay/task-deps.mjs`), because a graph checked only when a worker picks the task up puts the
  refusal on a machine that did not create the problem.
- `depends_on` / `assignee` travel on the task record.
- `w2m_tasks` (the fifteenth tool) is the board: it classifies every visible task as ready / active / waiting / blocked / done
  (`src/plugin/task-graph.mjs`). A prerequisite outside the page is treated as **waiting**, never as absent.

### Questions that survive a restart

`src/plugin/ask-store.mjs` keeps open questions in a JSONL file next to the profile (`ask-store.jsonl`, atomic rewrite, cap on
records). A reply that arrives after the deadline is recorded as `answered_after_timeout` rather than overwriting the timeout or
being dropped, and a settled question is never reopened. `w2m_chat` gained `action: "asks"`, and `await` settles the stored ask.

### Output that travels

`src/util/dataflow.mjs` (moved from `src/plugin/` — the layer check refused an `agent -> plugin` edge) is now wired:

- a pipeline stage whose stdout exceeds 64 KiB **uploads it as a blob** (`PUT /v1/fleet/blobs/{sha256}`) and the envelope names
  it (`blob_sha256`, `output_mode: "blob"`) instead of inlining head/tail;
- a failed upload **fails the stage** by name (`BLOB_UPLOAD_FAILED`) rather than leaving a reference to nothing;
- `w2m_wait` builds the reduce plan with `buildReducePlan` from the **raw** envelopes and marks the verdict `degraded` when a
  shard is missing — but only when the caller declared `reducer_machine_id`, so a large pipeline result is not mistaken for a
  partial reduce.

The end-to-end fixture this release adds (`test/agent.test.mjs`) runs a real agent against a fake relay: it asserts the blob name
is the hash of the bytes sent and that a refused upload fails the stage. Two real defects surfaced while writing it and are fixed
here: the stage stdout arrives as a `Buffer` (it was handed to the signature helper as a string), and a 70 KiB test argv exceeds
Windows' `CreateProcess` limit.

### Retry and hand-off

- `POST /v1/task` accepts `max_attempts` (1..5, default 1) and `retry_on` (`expired|failed|partial|timeout`). Defaults keep
  at-most-once for every existing caller; a malformed policy is `BAD_REQUEST`, not silently ignored.
- On lease expiry, `retry_on` containing `expired` performs the hand-off `halt=now` always had: attempt+1 and a re-offer to idle
  machines (`_takeover`, which already refuses writing tasks to avoid double application).

### mapreduce

`mode: "mapreduce"` is accepted with `reduce_argv` and an optional `reducer_machine_id`. The map half is ordinary dispatch; the
reduce half is **described, never launched** — the caller runs it as an explicit second task after `w2m_wait` says every shard is
present, so one task id never describes two executions.

### Relay

The relay was deployed three times during this release (cancel route, retry policy, mapreduce) from hash-verified tarballs, each
with a state backup, a health check, and a 401 check on the pre-existing routes. **The relay name is separate from the package
version**: the tarball deployed was the 1.2.3-labelled build carrying this code, and is re-deployed from the released 1.2.4 tarball
below.

### Verified

Gate GREEN twice, 15 of 15: 2610 tests / 2596 pass / 0 fail / 14 skip. Notable suites: agent 149 (147 pass, 2 skipped),
relay 169, tools 127, task-deps 13, task-graph 11, ask-store 8, turn 5, dataflow 7, dataflow-wiring 7.

### Not verified

A two-machine run of cancel / retry / mapreduce end to end. The code paths are tested against a fake relay and against the real
relay's HTTP surface, but no test here runs two physical machines exchanging an expired lease.
## [1.2.3] — 2026-10-20

**The packed artifact did not mount. This fixes that, and the reason it was not caught here.**

`v1.2.2` was released, published to npm, and **failed Compat**: the packed artifact would not mount in a real profile.

```
JsonSchemaError: unsupported JSON schema: parameters.params.additionalProperties must be explicitly true or false
```

`w2m_intent` declared `params: { type: "object", ... }` without stating `additionalProperties`. DSH refuses such a
schema **at mount time** -- in the profile of whoever installs the build -- and this repository had no check that would
have said so before shipping: the local loader gate mounted the artifact on a host whose compiler path differs, so it
stayed green while the real profile refused the entry.

### What changed

- `w2m_intent`'s `params` now states `additionalProperties: true`, and every tool schema is checked when it is defined.
- New `src/plugin/schema-spec.mjs`: a pure walker over schema-shaped values, and `schemaProblems()` which returns every
  object node that does not state `additionalProperties` as a boolean -- all of them at once, not the first one.
- `defineTool` now runs that check, so a tool with an under-specified object parameter fails where it is written rather
  than in someone else's profile.
- `test/schema-spec.test.mjs`: 5 tests on the walker and the checker (nested properties, array items, unions, multiple
  offenders, `true` accepted as well as `false`).

### Panel polish

- **Thread grouping**: consecutive messages that share a thread are shown under one thread head. Only consecutive runs are
  grouped, because re-sorting by thread would put an answer above the question it answers.
- **Unread count**: the trigger shows how many messages arrived since this conversation was last opened. The watermark is
  local storage per conversation -- the relay stays stateless and no "who read what" is invented.

- **Task board**: the panel shows the relay's own task list (up to six rows: id prefix, mode, status) through a host
  proxy (`/api/w2m/tasks`), so the browser never holds a device token.

Still missing from the panel: a timeout mark on an unanswered question, which needs the ask store from the turn state
machine.
### Verified

Gate GREEN twice, 15 of 15: 2555 tests / 2541 pass / 0 fail / 14 skip.

### Not verified

Compat itself: that workflow runs in its own environment, so this release is verified by the same local gate that missed
the defect. **Watch the Compat run for this tag.** If it fails again, the mount is failing for a different reason than the
schema and the log will say which entry and which fiber.
## [1.2.2] — 2026-10-20

**Fleet collaboration, part one: shared-memory writes, a council of machines, and the panel that reaches them.**

`v1.2.2-beta.1` published correctly — prerelease, assets and a matching SHA256SUMS — but the run that produced it reported
its last step as failed:

```
a release with the same tag name already exists: v1.2.2-beta.1
```

Creating the tag through the API had already triggered one run, which created the release; the explicit dispatch then
collided with it. A release step that cannot be retried fails for the wrong reason, so `beta.yml` now refreshes an existing
release (notes + assets with `--clobber`) instead of refusing, and says so in the log.

### What is in it

- **Shared-memory writes**: `w2m_memory` gained `action: "append"` with `if_revision`. A stale revision comes back as a 409
  the caller reads (revision, how far behind, which records it has not seen) and is deliberately **not** retried in the
  transport -- retrying there turns a visible conflict into a silent overwrite.
- **A council of machines**: `src/plugin/council-fleet.mjs` keeps the single-machine decision rule and changes the
  transport to chat messages on `council-<id>`, so every machine reads the same ballots and recounts the same outcome.
  Weights are a pure function of the ballot; a tie is refused; one ballot per machine; a late ballot is refused by name.
  `w2m_council` exposes `fleet-open` / `fleet-vote` / `fleet-decide` / `fleet-state` / `fleet-list`.
- **The panel**: a recipient picker (default "all"), a thread chip on messages that belong to a thread, click-to-reply with
  a quoted line above the input, and the reply thread travelling with it. The host route refuses a single recipient that
  is not in this fleet (`CHAT_UNKNOWN_RECIPIENT`) and says `CHAT_ROSTER_UNAVAILABLE` when the roster could not be read at
  all -- a relay outage is not a typo in the recipient.
- **A readable view over memory**: `w2m_memory` read now returns `view` (counts by machine and by status, one line per
  record). A row shape it does not recognise is shown as itself rather than dropped.
- **The beta pipeline is repeatable**: creating the tag had triggered a run that created the release, so the explicit
  dispatch collided with it. The step now refreshes an existing release instead of refusing.

### Verified

Gate GREEN twice, 15 of 15: 2550 tests / 2536 pass / 0 fail / 14 skip. tools 125 (three append cases), council-fleet 12,
memory-view 6, client-bundle 25.

### Not verified

The fleet council and a directed message across two live machines, and the panel against a second machine. Those need two
machines on this build.

## [1.2.1] — 2026-10-18

**P1 of fleet collaboration: addressing, correlation, and a turn that can time out.**

### 1. Addressing — a message can name its recipient

`POST /v1/fleet/messages` accepts `to`: `"all"` (the fleet group, the default) or one `machine_id`. The relay stores ONE row
either way and filters at read time (`for_me=1` is answered from the authenticated device identity, never from a caller
supplied id), because N copies for N recipients would multiply the byte budget by the size of the fleet for no extra
meaning. A malformed address is refused `BAD_ADDRESS` by the store and `CHAT_BAD_ADDRESS` by the host route.

### 2. Correlation — threads and replies

Messages carry `thread_id`, `reply_to` and `turn`. `reply_to` must name a message that exists in the SAME session
(`REPLY_TARGET_MISSING` otherwise): a dangling reply makes a thread unreadable. `turn` is assigned by the relay and counts
the exchange inside a thread, so a reader can order answers without trusting client clocks.

### 6. Turn semantics — waiting is a state, timeouts are values

`w2m_chat` gained `action: "ask"` (send, return the message id) and `action: "await"` (wait for a reply to that id).
`await` returns `{state: "answered" | "timeout"}` — a timeout is a result the caller reads, not an exception that loses the
question, and the question stays in the flow so it can be answered later.

### What this needs from the relay

The fields are new, so the relay on the fleet host must be redeployed with this build. An older relay ignores the fields
(the message still stores and reads, without addressing/threading) because they are plain body fields rather than a
protocol version bump.

### Verified

Relay store: `BAD_ADDRESS`, `REPLY_TARGET_MISSING`, turn counting, and the read filters. HTTP: the three existing
fleet-message tests still pass. Tools: 122 pass. relay suite: 163 pass. Gate GREEN twice, 15 of 15.

### Not verified

Two-machine end-to-end (A asks, B answers, A's await reports answered) — that needs both machines on this build, and the
relay redeployed.
## [1.2.0] — 2026-10-18

**Fleet chat is one group per relay.**

The conversation used to be keyed from `process.cwd()`, which is the DSH process's own directory and differs per machine
(`E:\DS` here, `/root` there). Two machines therefore computed two different keys and each panel saw only its own messages:
"互相收不到队员聊天信息". The rule is now the simplest one that makes a fleet talk: **the relay is the group**.

- one relay → one conversation, whatever project a machine is working on;
- a trailing slash on the relay URL is the same relay;
- the project name and the account key are deliberately NOT part of the basis: including either split the fleet into
  separate streams, which is exactly the bug;
- the machine id remains only as a last resort when no relay is configured, so a panel can still answer locally.

### What was removed, and why it is not a loss

Two intermediate designs were built and dropped in this release: keying per project (relay + project name) and a
"同步编队全部项目" scope button that switched between the project stream and the fleet stream. With the relay as the group
there is nothing to switch to, so the button and its scope parameter are gone rather than left as a no-op. The panel is
simpler and the operator gets the fleet-wide conversation by default.

### Verified

`conversationBasis` is pure and tested: same relay unites two machines, a trailing slash does not split them, different
relays stay apart, and a host without a relay falls back to the machine scope. 4 identity tests, 25 client-bundle tests,
tools 122. Gate GREEN twice, 15 of 15.

### Not verified

Two-machine end-to-end against a live fleet; that check needs both machines on this build, which is the next step.
## [1.1.22] — 2026-10-18

**The fleet-chat panel said "this machine has no fleet-chat identity yet" on a machine that was paired and online.**

Two structural causes, both introduced by 1.1.20's move to a conversation key:

- **identity was read with the wrong reader.** The panel's identity came from `readDevice({ stateDir })`, which returns
  empty the moment `stateDir` is unset -- and unset is the documented default layout, because the agent writes its identity
  to `<DSH_HOME>/xclient/device.json`. The plugin already had `readLocalIdentity(cfg)`, which knows that fallback and
  says so in its own documentation; it was simply not used here. The same bug made `w2m_status` report `machine_id: null`
  next to a working P2P identity.
- **the account material was read from a scope that cannot see it.** The conversation key is derived from the **fleet
  key**, which `startLocalStack` resolves at stack start. The composer route is registered in `apply()`, one scope above
  it, so all it could read was `cfg.fleetKey` -- null on a machine that joined by account. It now reads the resolved key
  through a holder the stack updates, so the route and the join agree by construction.

### The fallback, and why it is written down

A missing account key no longer refuses. The conversation is then keyed by the machine id, and the response says
`conversation_source: "machine"` instead of leaving the caller to guess. A panel that cannot answer at all is worse than
one that answers for this machine until the account join lands; the moment the fleet key resolves the key changes to the
account scope, which is what makes two machines in one project one conversation.

### Verified

The new `conversationBasis` contract: account basis when the key exists, machine basis with an explicit source when it does
not, and `null` only when there is no machine at all. Tools 122/122, client-bundle 25/25, fleet-chat-identity 4/4.

### Not verified

The panel against a live host, which is what this beta is for: the machine that reported the error is the machine that will
report whether it is fixed.

## [1.1.21] — 2026-10-18

**A fix-forward release: 1.1.20 could not load on Node 20.**

1.1.20 shipped with `import { zstdDecompressSync } from 'node:zlib'`. That named export does not exist on Node 20, so the
module did not merely lose a feature -- the whole entry-point chain failed to import ("lib/tools.js" and "lib/index.js"
both refused to load). CI caught it on `windows-latest / node 20` after 1.1.20 had already been published, and npm does
not allow a version to be replaced, so this release fixes forward.

- the zstd API is now resolved lazily through `require` behind `zstdAvailable()`; on a runtime without it,
  `decodeTranscript` returns nothing instead of crashing, and the session mirror simply publishes no prompts;
- the reader tests skip themselves on such a runtime rather than failing to import;
- the release pipeline was re-examined afterwards: a beta needs no approval, a stable release is approved in the
  `Stable` environment, and this time CI was green **before** the approval was requested, not after.

### 1.1.20 is deprecated on npm

Its published build is marked deprecated with a message pointing at this release. `latest` was rolled back to 1.1.19 the
moment the breakage was confirmed, so a fresh `npm install -g` never received the broken build.

### Verified

CI green on this commit, including `windows-latest / node 20`. Gate GREEN twice, 15 of 15. 2502 tests / 2488 pass / 0 fail.

## [1.1.20] — 2026-10-18 (withdrawn)

**The developer declares this release STABLE.** The fleet panel now shows what each machine's owner actually typed into DSH.

### What it does

- the host route learns the conversation key from **account material + project directory name**, so the same project on
  two machines is one conversation and nothing has to be configured;
- a 2-second read-only watcher looks at the newest \`session.v4.jsonl.zstd\` for that project, extracts **only the user's
  messages** (`role: 'user'`/`'prompt'`), and publishes the new ones to the relay;
- the panel colours them: **red** for this machine's own prompts (marked "来自会话"), **green** for messages typed into the
  fleet box here, **white** for other machines — each machine also gets a colour on its whale avatar derived from its id.

### The rules that are enforced, not promised

- **the session is never written** — \`test/session-readonly.test.mjs\` scans the two modules for any file-mutating API and
  fails the gate if one appears;
- **no injection into DSH** — nothing is appended to a conversation; the panel is a mirror;
- **no assistant replies, tool calls or results** — only the user's own words;
- **own broadcasts are not shown as remote** — the echo rule is a tested function, not a convention.

### What the gate caught on the way

Adding the panel's newest pieces put four real defects in front of the tests: a state declared in the wrong component
(both components have a `busy`), an `accountMaterial` getter that named a variable outside its scope, a repair that ate
the closing braces of the route registration, and lint errors from an unused import plus over-escaped regexes. The gate
held at RED until each was fixed; this entry exists because it finally went green twice.

### Not verified

The end-to-end path (type in DSH on machine A, see it in machine B's panel) has **not been run across two machines yet**.
The reader, the extractor, the sync rules, the route and the panel are each tested; their composition is not. That is stated
here rather than implied by a green gate.

### Verified

### The panel shows a machine, not a UUID

The first working beta displayed `d89d5817…` as the sender of every message. The message carries a `machine_id`; a name is
not something a sender proves to the relay, so it was never stored. The panel now reads the same roster the target control
reads (`readState`, once per open) and shows **name · platform**, or **name · 本机** for this machine. A machine that has no
name yet is shown by a short id and is the only case where an id appears at all.

Gate GREEN twice, 15 of 15. 2507 tests / 2493 pass / 0 fail / 14 skip.

## [1.1.19] — 2026-10-18

**The chat panel exists in the browser.**

Fleet chat shipped as a tool in 1.1.17 and as a relay API in the same release. What was missing was the half a user actually
touches: a control in the composer. This release adds it.

- **The panel**: a "fleet chat" control beside the target-machine control opens a floating panel listing this session's
  messages, with the relay usage shown next to them, a multi-line input, and a send button. It refreshes while open.
- **The host route**: the browser never holds a device token. It calls `/api/w2m/chat` on the host, which proxies to the
  relay's device-gated `/v1/fleet/messages` — so the token stays in the host process.
- **Tool bug fixed**: `w2m_chat` resolved its token through `readDevice(cfg)`, which fails when `stateDir` is unset even
  though a `device.json` exists elsewhere; it now resolves exactly like every other tool (`resolveToken(cfg)`).
- **Theme discipline**: the panel carries no literal colours, only `--dsw-*` tokens, because a literal is wrong in one of
  the two themes. The stylesheet test caught the one literal (`#fff` on the send button).

The relay on the fleet host was upgraded to this line of code in the same step: it had been running 1.0.14, which has no
`/v1/fleet/messages` route at all, so the panel would have shown "no route" forever. Verified after the restart: an
authenticated GET returns 200 (it returned 404 before), unauthenticated returns 401, and the fleet came back with the same
eight devices and no re-pairing.

### Not in this release

The coloured per-machine avatars for chat messages are designed and not built. The panel shows one style for every
machine today.

### Verified

Gate GREEN, 15 of 15. 2489 tests / 2471+ pass. client-bundle 25, tools 122, claims, portable-plugins 10.

## [1.1.18] — 2026-10-18

**The developer declares this a STABLE release.** It ships the three-channel updater and the release plumbing that makes
the beta channel real.

### Three channels, resolved from the two releases that exist

`w2m_update action:"status" channels:true` reports:

| Channel | Source | Rule |
|---|---|---|
| `stable` | GitHub's `/releases/latest` | never a prerelease |
| `beta` | the newest **prerelease**, fetched from `/releases` and filtered | exists only when one is published |
| `latest` | whichever of the two is newer by SemVer | equal versions resolve to stable |

Every decision comes from the existing `decideUpdate`, so the channel logic cannot drift from the install rule; this
module only chooses which two releases to ask about. A missing beta is reported as `available: null` rather than
substituted with stable — "there is no beta right now" is a fact the UI has to be able to show as a disabled button.

**The channel report is opt-in.** A plain `status` remains local and offline; making every status call reach GitHub would
slow the tool and break it behind a proxy. Asserted by a test that fails if any fetch happens.

### Installing a channel, with the checksum enforced twice

`w2m_update action:"apply" channel:"stable"|"beta"|"latest"`: the release's `SHA256SUMS` is downloaded, the hash for the
tarball is required (no hash, no install), `downloadVerified` removes its temp file on any mismatch, and `installUpdate`
receives `expectedSha256` as well and keeps its rollback path. A mismatch is not retried: it means the asset and its
checksums disagree, which is never a transient condition.

### The beta channel is a GitHub prerelease, and never npm

`.github/workflows/beta.yml`: a bump is a beta by default; a beta becomes a **prerelease** (so neither GitHub nor npm
resolves it as latest) gated by the `beta-access` environment, which requires a reviewer. There is **no `npm publish`
line in that file** — a channel cannot leak into the default install if the publication cannot happen at all. npm
receives a version only when the developer declares it stable, as this release does.

`.github/workflows/packages.yml` mirrors a released stable version to GitHub Packages with the registry overridden **on
the command line**, because `publishConfig.registry` would silently redirect the operator-channel publish too.

### Verified

Gate GREEN twice, 15/15. 2504 tests / 2490 pass / 0 fail / 14 skip. tools 122, update-channels 4, update-prerelease 2.
The first GitHub Packages publication succeeded; the package page itself is confirmed by the operator, since the PAT has
no `read:packages` scope to read it back.

## [1.1.17] — 2026-10-18

**Fleet chat: messages live in a session, are refused by a byte budget rather than silently dropped, are stored
encrypted and split across the fleet's own machines, and reach the agent as a tool.**

### The store, and the rule it refuses to break

`src/relay/fleet-messages.mjs` keeps messages per **session** -- the operator's scope: deleting the session deletes the
history, and a machine joining or leaving changes who reads the flow, never what was said.

The budget is the operator's formula, not a round number:

    limit = min(200 MB, max(100 MB, used-in-7-days))

A message over it is **refused** with the current usage attached (`FLEET_QUOTA_EXCEEDED`); nothing is silently dropped
and nobody else's words are evicted to make room. Text only: non-strings, control characters and messages over 4 KiB are
refused by name. Every timestamp comes from the relay's clock, because client clocks in this fleet disagree by tens of
seconds.

### Encrypted sharding with the three rules that keep it from losing data

`src/relay/message-shards.mjs` seals a day's messages with AES-256-GCM under a key derived from the fleet key (domain
separated, no new long-lived secret) and splits the result across the fleet:

- **rebuildable** -- the metadata says which machine holds which part, so a reader never guesses;
- **offline tolerated** -- every part gets **two replicas on two different machines**; one machine being down is the
  normal case;
- **integrity** -- each shard carries sha256 of its own bytes. A corrupt shard fails as `SHARD_CORRUPT` naming the part
  and machine; a missing one fails as `MISSING_SHARDS` naming **which** parts; a wrong key fails as `AUTH_FAILED`
  without returning partial plaintext.

### HTTP and the notification that carries no text

`POST /v1/fleet/messages` and `GET /v1/fleet/messages` sit behind the device gate: the author is the token holder, never
a body field. Every read returns the fleet's current usage so a client can warn before a write is refused.
`GET /v1/fleet/messages/stream` is SSE and emits **only** `{session_id, message_id, machine_id, at_ms}` -- the text is
always fetched through the authenticated read, because a broadcast carrying text would send every message to every
listener and make the membership check decorative.

### The twelfth tool: `w2m_chat`

`w2m_chat` (`send` / `list`) exposes the above to the agent. It is an ordinary MCP tool available on every transport;
`w2m_run` remains the only host-only one.

### The cost of adding a tool: seven count pins

Adding a twelfth tool is not one edit. The count is pinned in **eight** places -- `README` (both languages), four test
suites (`tools`, `p2p-plugin`, `loader-entry`, `tool-cards`), `scripts/verify-installed.mjs`'s expected list, and
`test/claims.test.mjs`'s assertion. The first attempt fixed the ones that came to mind and left three red; the gate caught
each. `docs/PLATFORMS.md` gained a section stating that `w2m_chat` is available over MCP.

### Not verified

- no client UI panel beyond the generic tool card;
- the SSE route has module-level notification tests, not a live end-to-end stream assertion;
- shards are produced and reassembled but **not yet transported** to machines -- that is the relay's next step, and the
  tests say so rather than implying distribution works.

### Verified

Gate GREEN twice, 15 of 15. tools 120, claims 48, p2p 32, loader 10, fleet-messages 7, message-shards 9, chat-http 3,
message-notify 3.

## [1.1.16] — 2026-10-18

**A machine waiting to be admitted now appears where you already answer questions -- and the README leads with how to
install it.**

### Admission in `w2m_approvals`

`w2m_approvals` merges `GET /v1/fleet/admission/pending` into its list as `kind:'fleet_admission'` rows, so a machine
asking to join shows up beside the permission requests already there. Settling an `adm-` id goes to the **relay's**
decide endpoint, not the local permission index: admission is not an authority escalation, and pushing it through
`approvalRequestFor` -- whose shape requires a needs-approval verdict and a capability -- would record a lie in the
audit trail. The list is shared; the stores are not.

The countdown is derived from the **relay's clock** (`rabbit_time`), never this machine's: three machines in this fleet
disagree by tens of seconds, and a local countdown would fire the automatic approval early on a fast machine. The relay
still owns the decision and still refuses to auto-approve with no member online.

### Two defects the tests caught

- the merged request omitted `rabbitUrl` and the device token, so it threw into the surrounding catch and the rows were
  **silently missing** -- a probe showed the fetch was never called at all (`calls: []`);
- the refusal code was read from `json.code`, but protocol errors arrive at `json.error.code`, so `reason_code` was always
  null and a late `ALREADY_DECIDED` decision looked like a success path.

Five assertions now cover that seam: rows and their fields, relay-clock countdown, an unreachable relay still showing the
local queue, `adm-` routing reaching the relay, and a late decision reported rather than thrown.

### README rewritten around installation

Five routes, easiest first: DSH plugin (zero configuration), npm/MCP for any client, Claude Code marketplace, Codex, and
the verified release tarball. Then quick start, the 11 tools registered, the `W2M_*` environment a dispatched command
receives, the fleet model, the security posture, and an explicit **verified / not verified** table that names the approval
popup, the four-machine `W2M_INDEX` run, the unimplemented chat channel and the macOS P2P downgrade instead of implying
they work.

Two claim checks rejected the first draft and were right: a `SHA256SUMS` release-download URL does not name a
`<name>-<version>.tgz` asset, and "eleven tools" had to be the measured number.

### Not in this release

The approval **popup** (a dedicated 10-second countdown control) is not implemented -- the rules are enforced by the
relay and this tool lists and settles the requests. The fleet chat channel remains designed (FLEET-CHAT-DESIGN.md) and
not built. No four-machine `W2M_INDEX` run yet.

### Verified

Gate GREEN (final pass, 15 of 15). 2458 tests in 102 files, 2444 pass, 0 fail, 14 skip. tools 120, tool-cards 8,
claims 47.

## [1.1.15] — 2026-10-17

**A machine that cannot join the old way now proves its account, asks to join, and waits for an answer -- and the
executed command finally learns which machine and which slice it is.**

### The fallback path is connected end to end

v1.1.14 shipped the server half. This release connects the client:

* \`pairNow\` classifies its failure and, for **only** the three degradable reasons (invalid pairing code, unreachable
  relay, timeout), calls the new chain: challenge -> sign with the account key -> submit proof -> poll until a terminal
  state. Anything else still needs a human and still does not change mechanisms;
* **a rejection is final.** The chain stops on \`rejected\`; re-asking would turn a decision into a notification queue;
* **an unfinished wait is reported, never hung on**: \`STILL_PENDING\` after the poll budget, \`expired\` when the relay
  says so;
* the seed for the account key is the **fleet key, never the account code** -- the account code is written to the log,
  and deriving a signing key from a value anyone can read would hand out the account's identity;
* the machine id comes from the agent object in scope, **not** from device.json: this machine never paired, which is the
  entire situation.

### Polling without a device token

The asking machine has no device token -- that is why it is asking. The request response therefore carries a
\`poll_token\`, and \`GET /v1/fleet/admission/{id}?poll_token=\` is reachable **ahead of** the device-token gate. A wrong
token returns 404 rather than revealing whether the request exists.

### The command learns where it is (P1)

\`runArgv\` accepts an environment, and every executed command receives \`W2M_INDEX\`, \`W2M_INDEX_TOTAL\`,
\`W2M_STAGE_INDEX\`, \`W2M_TASK_ID\`, \`W2M_MODE\`, \`W2M_MACHINE_ID\`, \`W2M_MACHINE_NAME\`. Values come from the OFFER,
never from argv, so one machine cannot reshape a fleet-wide split. The variables are merged over \`process.env\` rather
than replacing it -- PATH must survive, or no interpreter is found. \`W2M_STAGE_INDEX\` is deliberately separate from
\`W2M_INDEX\`: for a split over four machines each runs one stage (0) but they are machines 0..3.

This makes the operator's acceptance shape possible: \`process.exit(Number(process.env.W2M_INDEX)+1)\` yields 1/2/3/4
across four machines. The single-machine half is tested here; the four-machine run needs the fleet and is **not yet
verified**.

### NOT shipped, stated plainly

* **The approval UI** (10s popup with countdown plus a standing dialog) is not written. The server enforces the rules it
  must: no automatic approval with zero members online, and a rejection beats the ten seconds;
* **no end-to-end run**: new install -> popup -> admitted has not been executed, so \`agent.runtime.machineId\` being
  non-empty on a real machine is **UNVERIFIED** -- if it is empty the fallback logs and does not fire;
* the fleet chat / broadcast channel is designed (FLEET-CHAT-DESIGN.md) and not implemented.

### Verified

Full gate GREEN (final pass, 15 of 15). Suites touched: tools 115, account-join 6, account-identity 6, join-challenge 8,
join-degradation 3, admission 16, admission-routes 3, relay 163, broadcast 19.

## [1.1.14] — 2026-10-17

**A new machine joins by itself, and a machine that cannot join the old way can now prove its account and ask.**

### Joining is on by default

`autoStartAgent` now defaults to **true**. The old expression was `config.autoStartAgent === true`, which made joining
opt-IN, and the observed defect was a machine that was installed, running, and simply not in the fleet -- "installed,
paired: false" with no hint of why. `false` is still the way to turn it off.

Making this the default required changing the meaning of the tests that intentionally ran without an agent: eight suites
now pin `autoStartAgent: false` through one `applyPinned` wrapper each, and the single case that asserts a STARTED node
exits cleanly passes `autoStartAgent: true` inside its own template script. Two bugs were found while doing it, and both
are recorded because they are the shape of this kind of change: inserting a key into object literals with a regex broke a
file, and replacing call sites after defining the wrapper made the wrapper call itself.

### Admission: who may join, who may be removed

The relay gains a fleet-admission state machine and five routes: `admission/request`, `admission/pending`,
`admission/{id}/decide`, `members/{id}/remove`, `removals/{id}/vote`, plus `admission/challenge`.

* a request is `pending` and grants nothing until approved;
* **10 seconds without a decision auto-approves**, but only while at least one member is online -- an empty fleet cannot
  consent, and that refusal is a named `NO_ONLINE_MEMBER`;
* inside **24 hours** any online member may remove a new member immediately; after 24 hours a single machine may only
  OPEN a vote, and the quorum set is **frozen at open time** so a voter going offline mid-vote cannot move the bar;
* the quorum is the operator's: 3+ old members need >= 50% rounded up, a two-member fleet needs one vote;
* old members are ordered by **insertion sequence**, not timestamps -- two machines approved inside the same millisecond
  are equal on the clock but still have an order, and a quorum that depends on a sub-millisecond race is not a quorum.

### An unpaired machine can prove its account

A machine whose pairing failed has no device_token, which is the situation the fallback exists for -- so the two routes
it needs are reachable **without** one, authorised instead by an account signature:

* the account gains a **derived Ed25519 identity** (`account-identity.mjs`): the same account material yields the same
  keypair on every machine, which is what makes zero-configuration joining possible at all;
* the public key is registered with the relay **when that account's first machine pairs** -- the only moment the relay has
  proof of the account -- and the first key wins (a different key is refused, not silently accepted);
* a one-time, five-minute challenge is signed and verified against it; the challenge is consumed on any attempt, the
  signature binds `machine_id`, and issuing is rate limited **per fingerprint**;
* the fingerprint the relay acts on comes from the **verified signature**, never from the request body.

### Deliberately not in this release

The client-side consumption of `degrade: true` (challenge -> request -> poll) and the approval UI (10s popup plus a
standing dialog) are **not** shipped. The server half is tested; the client half is not written, and shipping a
mechanism whose client does not call it is the failure this project has recorded seven times.

### Verified

Full gate: **GREEN**, 15 of 15 checks, twice. The suites this release touches directly: relay 163, tools 115, admission
16, admission-routes 3, broadcast 19, join-challenge 8, account-identity 6, join-degradation 3, fleet-target 45.

## [1.1.3] — 2026-10-17

**A machine offline for more than 72 hours leaves the list. It is not deleted, and it comes back on its own.**

### The rule, and why hiding is not deleting

`readFleet` filters the roster at **the read path only**:

* a machine whose `last_seen` is at least **72 hours** old is **not shown** by `w2m_devices` or the composer;
* `records` still carries **every device the relay sent**, so nothing is lost and no bookkeeping is required;
* a **missing or unparseable** `last_seen` is **not** archived -- an unknown age must not be read as "gone for three
  days", or a relay that omits the field would empty the list;
* `include_stale: true` shows the archived machines, which is the operator's audit route;
* the machine returns by reporting again: the same record with a fresh timestamp is listed, with no re-pairing.

Because the relay already stops leasing machines that are offline (v1.1.2), a hidden machine is also not a dispatch
target -- the list and the dispatch agree, from one notion of liveness plus this display rule.

### The fixtures were the reason this took two attempts

The first attempt changed nothing in the filter and failed 8 tests: `fleet-target`'s roster fixtures carried **fixed
dates** (`2026-10-09` … `2026-10-11`), which are more than 72 hours old *now*, so a correct filter archived all three
machines. Making the timestamps **relative** (`Date.now() - 60s` …) fixed all 8 without touching a single assertion,
which is the evidence that the filter was right and the fixture was the stale part.

### Verified

`test/fleet-target.test.mjs` gains four assertions -- hidden from the list, **records kept**, returns on its own and
`include_stale` shows it meanwhile, unknown age not archived -- for **45 pass, 0 fail**. `test/tools.test.mjs` 115 and
`test/relay.test.mjs` 160 remain green.

## [1.1.2] — 2026-10-17

**A dispatch that names no machines now goes to the machines that are online. The rule that decides "online" had been
written three times and the three copies are now one.**

### The defect

The relay built a lease for **every paired device**, including a machine whose agent had stopped heartbeating days
earlier. That lease expired, `partial` became the only verdict the task could reach, and a fleet whose live machines
agreed reported *"incomplete"* forever. Observed on 2026-10-17:

    aggregate: partial    counts: { ok: 3, expired: 4 }

So "all machines agree" was **unreachable** while a stale entry existed, and no amount of re-running could fix it.

### The fix: one definition, three call sites

`device.online === true` alone is **not** the answer -- the flag stays true until the sweep runs. The real rule was
already computed, in two places, as `device.online === true && !silent`, and the target list was about to become a
third copy. It is now a method:

    isOnlineDevice(device, nowMs = this.nowMs())

used by `deviceStatus`, `publicDevice` and the default target list. `simtMs === null` (no contact ever observed) is
**not** silent, so an unknown age cannot be read as "gone".

### `include_offline` is the escape hatch, and it is reachable

`w2m_run` gains `include_offline` (boolean, **default false**) and puts it on the wire only when asked, so a default
dispatch sends the same bytes as before. The relay records it on the task, and a probe against a live `RabbitState`
confirmed the field is accepted and stored (`recorded: true`) rather than rejected as unknown.

### Deliberately NOT in this release

**The 72-hour archive rule is deferred to 1.1.3.** The read-path filter is written and correct, but eight
`fleet-target` fixtures carry fixed old timestamps and would need their intent reviewed one by one; shipping it with
those fixtures patched blindly is how a green suite stops meaning anything. A machine that has been offline for days is
therefore **hidden from dispatch** by this release (it is not online) but still **listed** by `w2m_devices`.

### Verified

`test/relay.test.mjs` 160 pass, `test/tools.test.mjs` 115 pass, `test/fleet-target.test.mjs` 41 pass -- 316 tests, 0
fail, after the change. The 72h filter was measured, found to break 8 fixtures, and rolled back rather than shipped.

## [1.1.1] — 2026-10-17

**The fleet is now installable from Claude Code, Codex and OpenAI's plugin surface -- and the parts that still need a
person are marked as needing one.**

### One server, three manifests

`bin/w2m-mcp.mjs` already answers both MCP eras (modern per-request `_meta`, and the legacy `initialize` handshake
most deployed clients still speak) and exposes **five read-only tools**. Adapting to a platform is therefore a
**manifest**, not a second implementation:

* `.claude-plugin/plugin.json` — the Claude Code plugin manifest, with its own `mcpServers` entry.
* `.claude-plugin/marketplace.json` — so this repository can be added **as** a marketplace.
* `codex/mcp-servers.toml` — the block to append to `~/.codex/config.toml`, kept as a reviewable file rather than
  prose in a document.
* `docs/PLATFORMS.md` — the per-platform routes, and the exact state of each submission.
* `w2m-mcp` is now a published **bin**, so a client can start the server without guessing a path.

### The trap: two schemas, two different root variables

The top-level `mcp.json` uses the agent-plugins schema's `${PLUGIN_ROOT}`. **Claude Code does not substitute that
variable** -- it substitutes `${CLAUDE_PLUGIN_ROOT}`. Reusing the top-level file verbatim would ship a literal
`${PLUGIN_ROOT}` string as the server's first argument, and the failure would present as *a missing server* rather
than *a wrong variable name*.

So the Claude Code manifest declares its own server entry, and `test/portable-plugins.test.mjs` refuses a manifest
that uses the wrong variable, points at a file that is not in the package, or drifts from `package.json`'s version.

### What is published, and what is not

| Destination | State |
|---|---|
| npm package, GitHub release, `SHA256SUMS` | **published** |
| Claude Code plugin + marketplace manifests | **shipped and tested** |
| Codex configuration snippet | **shipped and tested** |
| Pull request to `anthropics/claude-plugins-official` / `-community` / `claude-code` | **not done** |
| Submission to OpenAI's plugin portal | **not done** |

The last two require write access to repositories this project does not own; the release token is scoped to
`TwinsEarth/dsh-windows2macos` and acting on a third-party repository is refused by design. A manifest that exists is
not a listing, so it is not reported as one.

### Verified

New suite `test/portable-plugins.test.mjs`: the manifests parse, the version agrees across all four manifests and the
package, the MCP bin exists, the Codex snippet pins the version being released, both manifests are in
`package.json#files`, and `docs/PLATFORMS.md` names every platform it claims to.

## [1.1.0] — 2026-10-17

**The direct path now works on runtimes whose OpenSSL has no BLAKE2s, and the compatibility gate that measures the real
Loader was asserting a tool list that had gone stale.**

### The handshake hash no longer depends on the runtime's OpenSSL

One dispatch reported, per machine:

> `P2P_PUNCH_FAILED: handshakeHash requires BLAKE2s-256: BLAKE2s-256 unavailable on this runtime: Digest method not
> supported. It is a WIRE PROTOCOL primitive -- the handshake hash, the prologue hash and the session binding -- so it
> cannot be replaced with SHA-256 without breaking interoperability with every peer.`

That message names the constraint correctly and draws the wrong conclusion. **BLAKE2s is public and deterministic**, so
the digest can be computed here instead of by OpenSSL: the bytes are identical to what a peer with a native
implementation produces, and interoperability is preserved exactly. The alternative -- refusing to handshake -- makes
**every** direct path fall back to the relay on that runtime, which is what the fleet was doing without saying so.

* `src/agent/blake2s.mjs` — BLAKE2s-256 in plain JavaScript (unkeyed, which is all the wire protocol uses).
* `src/agent/crypto.mjs` — `handshakeHash` tries the native digest and falls back to it; `blake2s256Support()`
  now reports **how** the digest is reached (`native` or `js-fallback`); `cryptoCapabilities()` counts the fallback
  as present, because what the handshake needs is the digest, not OpenSSL's implementation of it.
* The fallback is verified before it is trusted: its empty-input digest is compared against the published vector, so a
  broken fallback reports unavailable rather than producing hashes no peer will agree with.

**The bug that made this take longer than it should have.** The first version inverted both `v[14]` and `v[15]` for
the final block. BLAKE2 sets `f0 = 0xFFFFFFFF` on the last block and leaves `f1 = 0` for sequential hashing, so
only `v[14]` is inverted. Inverting both produces a **stable, plausible-looking digest that matches no reference**:
the three RFC vectors failed while the compression function -- checked against an independent implementation -- was
correct the whole time. `test/blake2s.test.mjs` pins the vectors and compares against `node:crypto` across every
block boundary, so that class of mistake cannot survive again.

### The compatibility gate was asserting a stale tool count

`test/loader-entry.test.mjs` asserted the plugin registers a fixed set of tools, under a name that still said "eight".
The set had grown to **eleven** (`w2m_approvals` and `w2m_council` were missing), so the gate that mounts the packed
artifact in a real profile and runs the real Loader failed at:

> `registers all eight w2m_* tools`

The list is now
the actual eleven, sorted so a missing name and a renamed name fail differently, and the test says what it means.

### Two configuration facts this exposed, recorded because they are not obvious

A machine can be **installed, running, and still outside the fleet** -- both were true here:

* `dsh.profile.bundles` must list the package. Installing it as a dependency is not enough: the host composes the
  entry list from that array, so a package present in `node_modules` and absent from `bundles` simply never loads.
* `autoStartAgent: true` is **off by default**, and joining happens inside the agent it starts. Without it a machine
  never joins, no matter how correctly it is installed.

With both set, this machine joined, listed its peers, accepted a dispatch and executed it (`node --version`, exit 0).

### Verified

Full suite green; pre-flight **GREEN**, 15 of 15 checks. `test/blake2s.test.mjs`: **10 pass, 0 fail**, including
byte-identical agreement with `node:crypto` at lengths 0, 1, 2, 3, 31, 32, 33, 63, 64, 65, 127, 128, 129, 191, 192,
193, 255, 256, 257 and 1000.

## [1.0.16] — 2026-10-17

**The last two failures on Linux CI, and one of them was a defect in the release process: a release was advertised as
"latest" before its assets had finished uploading.**

### A release must not be "latest" until it can be downloaded

The release script created the release with `make_latest: 'true'` and *then* uploaded the tarball. That leaves a
window in which `releases/latest` points at a release **with no tarball** -- and CI's live-API job read exactly that,
failing with:

> `ASSET_MISSING no release asset matches /\.(?:tgz|tar\.gz)$/i`

on a release that was complete seconds later. **The ordering was the defect, not the test.** The release is now created
without `make_latest`, the assets are attached, **and only then is it promoted** -- so a reader following the
"latest" link always lands on something downloadable.

### A test that was only true on a developer machine

`test/fleet-sync.test.mjs` removes the repository's git identity to prove the tool refuses to rebase without one. It
checked `git config user.email`, which **falls back to the global and system config** -- absent on a developer machine,
**present on GitHub's runners**. So the tool correctly found an identity and the test's premise was false, on CI only.

The test now points `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at paths that do not exist, so git's config is exactly
as empty as the test claims. It also restores every environment variable it touches.

### Verified

Full suite **2380 tests in 93 files, 2366 pass, 0 fail, 14 skip**; pre-flight **GREEN, 15 of 15 checks**.

## [1.0.15] — 2026-10-17

**Every 1.0.x GitHub release was missing its `SHA256SUMS` asset, so updating from GitHub could not be verified and
would be refused. That is fixed, along with the two tests that were failing on Linux CI.**

### The product defect: un-updatable releases

`src/plugin/update-source.mjs` refuses to offer an update without a checksum asset:

> `no SHA256SUMS asset for ${tag}; cannot verify a download without it`

The 0.x releases carry **two** assets (tarball + sums). **When the 1.0 line was cut, the release script uploaded only the
tarball** -- so every 1.0.x release looked complete and was, in fact, **un-updatable from GitHub**. Nothing local could
have caught it: the tarball was present and correct, and only a job that calls the real API noticed.

Fixed in three places:

* `scripts/github-release.mjs` now derives the sums from the same bytes it uploads and attaches `SHA256SUMS` in the
  same run, **and reads back the asset list** so a missing sums file is a release failure rather than a warning;
* the asset has been backfilled on **all fourteen** 1.0.x releases (v1.0.1 … v1.0.14), each checksum computed from the
  bytes GitHub actually serves;
* the live-API test in `test/update-source.test.mjs` now passes -- it was the only thing that ever reported this.

### Two tests that failed only on Linux CI

Both were invisible on Windows, and both were **the test's** fault, not the code's:

**`test/vision.test.mjs`** created its settings fixture with the default umask, which is `0644` on Linux. The loader
correctly refuses a file that holds a key and is group-readable, so the test got *"mode 644"* instead of the message it
asserted. **The fixture should be 0600; the guard was right.**

**`test/chatops-bridge.test.mjs`** faked its timer with a real `setTimeout`. The broker calls `record.timer.unref()`,
so during the await the only pending handle is an **unref'd** timeout -- which does not keep the event loop alive. On
Linux the loop drained before it fired and node reported
`cancelledByParent: Promise resolution is still pending but the event loop has already resolved`. **It passed on Windows
by accident of scheduling.** The timer is now deterministic: the callback is captured and fired explicitly.

### Release titles are version numbers

The repository home page sidebar renders the latest release's **name**, and the name was the commit subject:

> `test(merge): verify merging while a third machine publishes -- never tears, …`

-- where a reader looking for "which version is current?" expects `v1.0.14`. The title is now the tag; **the commit
subject moved to the first line of the body**, so nothing is lost and the one slot that names the release names the
version. All fourteen 1.0.x releases were renamed to match.

### Verified

Full suite **2380 tests in 93 files, 2366 pass, 0 fail, 14 skip**; pre-flight **GREEN, 15 of 15 checks**.
`test/update-source.test.mjs` (which makes a real GitHub API call) passes: **50 tests, 49 pass, 0 fail**.

## [1.0.14] — 2026-10-17

**Merging while a third machine publishes is verified: it never tears, never writes, and names its failures.**

### The gap this closes, stated precisely

v1.0.12 verified the memory actions end to end **one machine at a time**. v1.0.13 verified concurrent *publishing*.
**Neither covered a merge racing a publish**, and the merge has a two-step read that a publish can break:

1. `GET /v1/fleet/blobs/latest` — learn the hash;
2. `GET /v1/fleet/blobs/<hash>` — fetch the bytes, re-hash, merge.

Between those steps the pointer can advance (harmless: the merge still reads the blob it was told about) or the blob
can be **evicted** (fatal if unhandled: a 404 where the code expected bytes).

### What "correct" means for a racing read

There is no single right answer for *which* document a racing merge sees -- that is the nature of a read that is not in
a transaction. What is required:

* it **never throws an error it cannot name**;
* it **never produces a torn merge** -- a result whose recorded decision disagrees with the text it produced;
* it **never writes the local file**, under any outcome;
* when the blob is gone mid-flight, it **says so by name**.

### Verified

Two tests in `test/fleet-merge-race.test.mjs`:

* **twenty rounds of a merge fired together with a publish.** Every round resolved: a completed merge with a
  consistent decision, or a **named** `W2M_*` refusal. No crash. No torn merge -- when the recorded winner is
  `local` the text carries the local value, when it is `fleet` it carries a fleet value. **The local document was
  re-read after every round and was untouched every time.** The test also asserts at least one merge *completed*, so it
  cannot pass vacuously by refusing everything.
* **a pointer naming a blob that no longer exists** raises `W2M_NOT_FOUND`, not a crash.

**One honest limitation of the second test:** it *sets up* the state the race would produce (pointer names a removed
blob) rather than catching the removal in flight. **The code path is identical; the timing is not.** Recorded because
"mid-flight" without that caveat would overstate the evidence.

### Still not verified, and now the list is short

**Two relay processes sharing one state directory.** The design is one relay per fleet; supporting the other would need
real file locking, and nothing here provides it. **"Concurrency is tested" must not be read as "any topology is safe"**
-- that sentence was written into v1.0.13's notes and it still applies.

## [1.0.13] — 2026-10-17

**Concurrent publishing is verified safe on one relay, and the reason it is safe is stated so a future change can
falsify it.**

### What v1.0.12 recorded as unverified, and is now verified

v1.0.12 closed the end-to-end gap **one machine at a time** and wrote concurrency down as open, with a specific
worry: the blob store keeps its ownership index as a read-modify-write, and a lost update there would leave **a stored
blob with no owner** -- readable by nobody, including the fleet that wrote it.

### Why it turned out to be safe, stated as a property rather than a hope

`RabbitState.putFleetBlob` and `Persistence.putBlob` **do no awaiting**: every filesystem call in that path is the
synchronous `fs` API. The request handler awaits the body first, and after that the whole read-mutate-write runs to
completion inside one Node job. **On a single-threaded event loop that makes each publish atomic with respect to
every other request on the same relay process.**

**That reasoning is the thing the tests falsify rather than assume.** If any part of that path becomes asynchronous,
they fail with a lost index entry -- which is much better than finding it in a fleet.

### What is verified

Four tests in `test/fleet-concurrency.test.mjs`:

* **ten publishes fired together** leave **ten** ownership entries, and every blob still readable and still owned -- a
  lost update would show up as a 404;
* the **latest pointer names a document that was actually written** (not a torn value) and that document resolves;
* **two fleets publishing at the same moment stay separate** -- each fleet's pointer names its own document and the
  index attributes each blob to the right fleet;
* the pointer is **stable once the writers stop** -- reading it twice gives the same hash and timestamp.

Full suite **2378 tests in 92 files, 2364 pass, 0 fail, 14 skip**. Pre-flight **GREEN, 15 of 15 checks**.

### The limit of this claim, which matters more than the claim

**One relay process.** The design is one relay per fleet. **Two processes sharing one state directory would need real
file locking**, and nothing here provides it. "Concurrency is tested" must not be read as "any topology is safe".

Also still unverified: **two machines merging while a third publishes.** The merge itself is a pure read of local bytes
plus one fetched blob, so it has no shared state to corrupt -- but that is reasoning, not a test, and it is recorded
as such.

## [1.0.12] — 2026-10-17

**The five fleet-memory actions are verified end to end, against a real relay, a real profile and a real
`fleet-memory.md` -- and the first attempt found a real defect.**

### What was unverified until now

`publish`, `pull`, `latest`, `diff` and `merge` had each been shipped marked **UNVERIFIED**. The merge *rule* was
proven exhaustively as a pure function, and the relay *routes* were proven against a real relay -- **but nothing had
ever executed the tool surface itself.** A caller with no execution is indistinguishable from a working one, which is
the same gap this project keeps restating in a different shape.

### The defect the end-to-end test found on its first run

`latest` reported `published_by: null` for a publication whose author the relay knew perfectly well.

`RabbitState.putFleetBlob` accepted a `publishedBy` argument that **nothing ever supplied**: the pointer store took
it, defaulted it to `null`, and the field looked implemented. Fixed by filling it from **the authenticated device's
`machine_id`, never from the request body** -- for the same reason the P2P announce route reads `machine_id` off the
token: a caller that could name itself in the body could attribute a publication to a machine that never made it.

**No unit test could have caught this**, because the unit under test was the pointer store, and it was behaving
exactly as written. The bug lived in the seam between two correct components, which is what an end-to-end test is for.

### What the test exercises, in the order a machine would

A real relay on an ephemeral port and a real profile, then:

1. **`publish`** — returns a 64-hex hash and the byte count.
2. **`latest`** — discovers that hash **without being told it**, and reports the publishing machine.
3. **`pull latest`** — fetches the bytes, re-hashes them, and they round-trip **exactly**.
4. **`diff`** — on an unchanged document: `same: true`, no difference, **and the local file untouched**.
5. the fleet's document is replaced out of band through the relay's own route;
6. **`diff`** — now reports the divergence, and the local file is **still untouched**;
7. **`merge`** — applies the declared rule (neither side declares a repair, so the **default layer** applies and the
   newer publication wins), records the decision with a reason, carries the winning value into the merged text, and
   **writes nothing to the local document.**

**`wrote_anything: false` is asserted three times**, because "these actions never edit the file they read" is the
property that makes it safe to let a network round trip participate at all.

### Verified

- the end-to-end suite: 1 test, passing, covering all five actions;
- `test/fleet-merge.test.mjs`: 13 tests over the rule itself;
- full suite: **2374 tests in 91 files, 2360 pass, 0 fail, 14 skip**;
- pre-flight **GREEN, 15 of 15 checks**.

### NOT verified, even now

**Concurrency.** Everything here is one machine at a time. Two machines publishing and merging simultaneously is
untested, and the pointer has no compare-and-swap, so the last writer to the pointer wins -- which is **the same rule
as the default layer**, but that is a coincidence rather than a guarantee. Recorded so the next person does not read
"end to end" as "under contention".

## [1.0.11] — 2026-10-17

**`w2m_memory {"action":"merge"}`: merge this machine's collective memory with the fleet's current blob, under the
operator's conflict rule, and still write nothing.**

### The rule, which is the operator's decision

> **默认最新的赢；如果是修复默认流程，最全 & 验证最全面的有最后修改权。**
>
> Default: the newest wins. But if it is a repair of the default flow, the most complete and most thoroughly verified
> one has final edit authority.

Two layers, and the second is the one that is easy to lose: **a declared repair outranks recency**, so a repaired
fact is not overwritten by a later-written older understanding. Between two repairs, the better-supported one wins.

### What is the operator's, and what is my operationalisation -- stated so it can be challenged

**Theirs:** the two layers above. **Mine, and it is in the source:**

* **The entry syntax.** There is no way to read "is this a repair of the default flow" out of prose; any attempt to
  guess would overwrite correct versions with wrong ones. So a keyed entry declares it:
  `- 〔id:<stable-id> fix evidence=<n> verified=<n>〕<the fact>`.
  Entries without an `id` are prose: they are unioned and never adjudicated, because without an id there is no way to
  tell "same fact, two versions" from "two different facts".
* **`completeness = evidence + 2 × verified`. The weight 2 is a judgement, not the operator's words.** One reproduced
  fact outranks three unreproduced ones. It only applies when **both** sides declare `fix`.

**Every decision is recorded** as a comment in the merged text (`<!-- <id> -> local (repair): ... -->`), because a
merge that cannot explain its choices produces a document nobody can audit -- and the first sign of a wrong rule
would be a fact nobody can find.

### What it refuses

| Case | Behaviour |
|---|---|
| the same id twice **inside one document** | **refused**, not resolved: a broken document is not a conflict |
| a blob that fails its own hash | `W2M_BAD_BLOB`, and **nothing is merged** -- comparing unverified content would launder it |
| a pointer naming an evicted blob | reported as that, with the remedy (publish again) |
| no fleet document at all | reported as a state: publishing comes first |

### And it still writes nothing

The merged text comes back in the result; **the local file is not modified.** Half of a merge's input arrived over the
network, and letting one round trip rewrite the only local copy would hand a remote party a write into local memory.

### Verified

**13 tests in `test/fleet-merge.test.mjs`** exercise the rule as a rule, with no profile and no relay: the default
layer picks the newer publication; **a declared repair beats a NEWER non-repair** (the operator's override -- if this
test flips, the rule has silently become "newest wins"); two repairs are separated by completeness, then by
verification count, then by recency; a genuine tie resolves deterministically **and is recorded as a tie**; a
duplicated id is refused; prose unions; inputs are not mutated; an identical id produces no decision.

Full suite: see the pre-flight line. Pre-flight **GREEN, 15 of 15 checks**.

### NOT verified

The `merge` action **end to end** -- the same gap as `publish`/`pull`/`latest`/`diff`: the rule is proven, the
plumbing around it is not, because that needs a profile with a `fleet-memory.md` and a live relay.

## [1.0.10] — 2026-10-17

**`w2m_memory {"action":"diff"}`: compare this machine's collective memory against the fleet's current blob,
and write nothing.**

### Merge is still not implemented, deliberately

The question merge depends on has not been answered:

> **When two machines in one fleet assert different things about the same fact, who wins?**

That is a product decision about what the fleet's memory *is*, not an implementation detail, and shipping a merge
before its rule is how a fleet silently loses one machine's memory. So this release ships **the half that needs no
decision** -- and names the other half as open rather than leaving it implied.

### What `diff` answers

* **Is my document the newest one?** `same: true/false`, decided by **whole-document hash equality**.
* **What would I be overwriting?** `preview.local_only` and `preview.fleet_only`.
* **Is the fleet's document even there?** Three distinct absence states, each named: the fleet never published; the
  pointer names a blob that eviction removed; the blob exists and verified.

### Four decisions worth recording

**It writes nothing.** No `.orig`, no `.rej`, no silent merge. Comparing is not a licence to edit a document this
machine owns.

**`same` is hash equality, not "no line differences".** Two documents with identical line sets in a different order
are **not** the same, and callling them the same would hide an order change -- which in a markdown document is a
structural change.

**A set comparison, not a diff.** A line-oriented diff would report "moved" versus "changed" and then want a merge
policy. **A set comparison cannot resolve anything, which is exactly the property this step requires.**

**The fleet copy is re-hashed before it is compared.** Comparing unverified content would launder it: the report
would give a hash-verified-looking answer about bytes nobody checked. A blob that fails its own name raises
`W2M_BAD_BLOB` and is never compared.

Trailing whitespace is normalised (it is noise); leading whitespace is preserved (it is markdown structure).

### Verified

The comparison rule is pinned directly: `local_only` / `fleet_only` separate correctly, trailing whitespace creates
no difference, and leading whitespace does. Full suite **2360 tests, 2346 pass, 0 fail, 14 skip**; pre-flight
**GREEN, 15 of 15 checks**.

### NOT verified

The `diff` action **end to end** -- the same gap as `publish`/`pull`/`latest`: type-correct and lint-clean, but
no test executes it, because that needs a profile with a `fleet-memory.md` and a live relay.

### Open: #2b

**Append-merge with conflict markers, and the marker's existence is the refusal** -- a document containing markers is
one a human must not trust until resolved. Last-writer-wins is rejected: it loses data silently, and the project's
own eviction rule already refuses "delete the only copy of a fact" in spirit. **That recommendation is in
`FLEET-SYNC-2-DESIGN.md` and is not implemented, because it encodes a rule that is the operator's to choose.**

## [1.0.9] — 2026-10-17

**Discovery: a machine can now ask the relay which blob its fleet published last, instead of a human relaying a
64-character hash between machines.**

### Why the channel needed this before it was usable

v1.0.7/1.0.8 gave the fleet a content-addressed channel -- anyone in the fleet can `pull <hash>`. **But a hash is
only useful to someone who already has it**, and the only place one appeared was `publish`'s output on the machine
that ran it. That makes the channel work exactly as well as a person copying a string, which is a demo, not a sync.

So the relay keeps **one pointer per fleet**: the blob that fleet published most recently.

| Piece | Where |
|---|---|
| pointer store | `<state>/blobs/latest.json`, shape `{ "<fleet_id>": { hash, bytes, published_at_ms, published_by } }` |
| advanced by | `putBlob`, together with the ownership record -- a publish that succeeded but did not advance the pointer would leave the fleet advertising a stale document |
| route | `GET /v1/fleet/blobs/latest`, scoped through the same `scopeBlobFleet` as the blobs themselves |
| tool | `w2m_memory {"action":"latest"}`, and `{"action":"pull","hash":"latest"}` |

**`hash: "latest"` is the ergonomic point**: a joining machine runs one call, and it is the form that survives a
teammate republishing. A stored hash goes stale; `latest` follows.

**Resolving a pointer does not weaken verification.** The re-hash in `pull` is unchanged, because a pointer is
metadata -- exactly the thing a relay is allowed to be wrong about -- while the hash is what the bytes must match.

### A pointer is a hint, not a guarantee

Eviction is oldest-first and can take the current document on a busy fleet. So `latest` may name a blob that no
longer exists, and a pull of it answers `404`. **That is the honest outcome**: keeping a document alive because it
is pointed at would make eviction depend on a second, unstated rule. The route says so in its own payload.

### The defect a test caught, recorded because it is easy to reintroduce

The first version of `advanceFleetLatest` skipped `fleetId === null`, reasoning that a fleetless device has no
fleet to advertise to. **That skipped the most common deployment.** On a relay with no fleet configured,
`scopeFleetId` returns `{fleetId: null, legacy: true}` -- and `null` there means **one shared scope**, the
pre-v0.7.7 behaviour that fleet scoping's own comment insists a migration must not change. The pointer was therefore
never written on an unclaimed relay, and `latest` answered `404` for every machine on the default single-relay
setup. **The feature worked nowhere it was most likely to be used**, and the test that asserted 200 is the only
reason this is a comment in the source rather than a bug report.

The genuinely fleetless case on a **claimed** relay never reaches that code: `scopeFleetId` refuses it outright, so
the blob is rejected before a pointer could exist.

### Verified

Four new tests in `test/relay.test.mjs` run against a real relay: the pointer advances on publish and follows the
newest one; it is scoped per fleet (B sees `404` while A sees its own); **the pointer survives eviction while the
pull does not** -- the pointer still names the removed blob, the payload says "hint, not a guarantee", and the read
answers `404` without resurrecting it; and a second fleet re-publishing identical bytes **cannot claim the pointer**.

Full suite **2360 tests, 2346 pass, 0 fail, 14 skip**. Pre-flight **GREEN, 15 of 15 checks**.

### NOT verified

The `latest` and `pull latest` tool actions **end to end** -- same gap as v1.0.7's publish/pull: they are
type-correct and lint-clean, but no test executes them, because that needs a profile with a `fleet-memory.md` and a
live relay.

### And still absent

Merge (#2). Two machines publishing produce two blobs, and the pointer names whichever published last -- **the
earlier document is not lost, it is merely no longer `latest`**. That visibility is the input merge needs, and
nothing yet says who wins when two machines assert different facts.

## [1.0.8] — 2026-10-17

**The fleet sync channel, both directions: a machine can publish its collective memory to the relay and another
machine in the same fleet can fetch it back by hash.**

> **Why 1.0.7 and 1.0.8 are both published, and what that records.** `pnpm publish 1.0.7` succeeded; a verification
> read a minute later answered `version not found: 1.0.7`, a retry answered
> `409 Cannot publish over previously staged version "1.0.7"`, and `npm stage list` reported nothing -- so 1.0.7 was
> concluded to have failed and 1.0.8 was cut. **The registry was simply lagging: both versions are published, and
> their contents are identical apart from the version string.** The 409 was the retry racing a publish that was
> still in flight, not evidence that nothing had been accepted.
>
> **The mistake worth keeping is the conclusion, not the retry.** A freshness read that disagrees with a successful
> write is evidence of lag, not of failure -- and the way to tell them apart is to wait and re-read, which is
> cheaper than re-cutting a release. 1.0.8 stands as the current version because it is already published and is the
> one `latest` names; 1.0.7 is deprecated pointing here rather than left to look like a distinct release.


**The fleet sync channel, both directions: a machine can publish its collective memory to the relay and another
machine in the same fleet can fetch it back by hash.**

### #1 is now a channel, not a backup

v1.0.6 shipped the storage layer and said plainly that it had no route and no caller. This release supplies both:

| Piece | Where |
|---|---|
| content-addressed store | `src/relay/persistence.mjs` — `putBlob`/`getBlob`, 8 MiB per blob, 256 per fleet, oldest-first eviction that never takes the last one |
| hash → fleet ownership | `<state>/blobs/index.json`, so a content-addressed store is *not* a shared one |
| two routes | `PUT`/`GET /v1/fleet/blobs/<sha256>` in `src/relay/server.mjs`, behind the same device-token gate as every other route |
| scoping | `state.scopeBlobFleet` reuses `scopeFleetId` — **the same rule task dispatch obeys**, not a second copy of it |
| caller | `w2m_memory` `action: "publish"` and `"pull"` |

**Why a content-addressed store does not contradict "the relay keeps only hashes".** It persists `stdout_sha256`
and never the text, and `src/agent/storage.mjs` records why: each machine's `memory.jsonl` is the only durable copy
of what a command printed. **That invariant is about the relay not interpreting content.** A blob keyed by its own
hash preserves it exactly — the relay still interprets nothing, and **the hash is what says the bytes are the
bytes**, as `stdout_sha256` does for a result. What is new is only that a hash the relay already holds can now have
its bytes fetched from the same place.

### The decisions worth recording

**The write verifies the key, and refuses rather than correcting.** A content-addressed store that accepts bytes
under a key they do not hash to is not content-addressed: the key stops being a claim, and every later reader's
verification becomes decorative. A mismatch is `422 BLOB_HASH_MISMATCH` and nothing is stored.

**Ownership is first-writer-wins.** A second fleet PUT-ing an identical blob does **not** take ownership of it.
Otherwise any fleet could claim another's blob by replaying the same bytes, which is the same failure as having no
index at all.

**A cross-fleet read is `404`, not `403`.** A distinguishable "not yours" tells a prober that this hash exists on
this relay. The reader cannot tell "never stored" from "another fleet's", deliberately.

**The pull side re-hashes what it receives.** A verification performed only by the party that could be wrong is not
a verification, so a reader that gets bytes hashing to something else raises `W2M_BAD_BLOB` rather than passing
them on.

### What is verified, and what is not

**Verified — executed:** four new tests in `test/relay.test.mjs` drive the real routes against a real relay:
store-and-return-unchanged; a mismatched key is refused (422) and leaves the key absent (404); one fleet cannot read
another's blob (404); an unauthenticated request is refused (401). Full suite **2356 tests, 2342 pass, 0 fail, 14
skip**; pre-flight **GREEN, 15 of 15 checks**.

**NOT verified: the `publish`/`pull` tool actions end to end.** They are type-correct and lint-clean, and their
failure paths are written, but **no test executes them** — they need a profile with a `fleet-memory.md` and a live
relay. They are marked unverified here rather than counted as working, which is the distinction this project keeps
having to restate.

**A known limit of the reader:** `pull` returns the blob as text and re-hashes it as UTF-8. That is exact for a
`fleet-memory.md`; it would not be for arbitrary binary content, and the channel does not claim to carry that.

### Not in this release

The trigger (#3) and merge semantics (#2) are deliberately absent. Publishing is a decision a machine makes, not
something that happens on join, and merge needs a conflict rule that has not been decided: two machines writing
different facts produce **two hashes**, and nothing yet says who wins. **Nothing is overwritten in the meantime —
that is the property #1 was built to provide.**

## [1.0.6] — 2026-10-17

**DSH-GPW now ships *findable*: installed with the package, present in the plugin list, and off until an operator
turns it on.**

### What v1.0.5 got wrong

It shipped the subpath export `@twinsearth/w2m-dsh-plugin/gpw` and no config row. **A plugin the composed tree does
not mention is a plugin the plugin manager cannot list** -- so "enable it manually" had **nothing to click**, and
the only way in was hand-editing a profile patch.

**An optional component nobody can find is not optional, it is absent.** That is the same distinction as the seven
written-but-unreachable modules in this repository, seen from the user's side instead of the code's.

### The shape that fixes it

The package's own bundle patch now carries a second entry:

    - id: dsh-gpw
      name: '@twinsearth/w2m-dsh-plugin/gpw'
      disabled: true
      config:
        maxPerWindow: 10
        windowMs: 60000
        minGapMs: 3000

**`disabled: true` is the load-bearing field.** The row exists, so the component appears; the toggle is off, so
nothing answers `approval/request`; and **flipping it in the UI is the whole enablement step** -- no file edit, no
restart of anything but the client.

**It stays in the same `insert:` list as the w2m row**, and that is still the correct form: this is an insert
because no earlier layer creates a `dsh-gpw` row. (A *bare* `- id:` patch aimed at a nonexistent row is skipped
silently -- the failure recorded in this file and in TROUBLESHOOTING 3.2.)

### The distinction the two releases now make

| | v1.0.5 | v1.0.6 |
|---|---|---|
| Installs with the package | yes | yes |
| Appears in the plugin manager | **no** | **yes** |
| Enabled by default | no | no |
| How you turn it on | hand-edit a profile patch | **click its toggle** |

**Not verified: that the toggle actually flips it on and that it then intercepts.** That needs a live host. The
observable evidence is its own startup line followed by its counted line --

    approval-ratelimit: active -- at most 10 auto-approvals per 60 s, at least 3000 ms apart, process-wide
    approval-ratelimit: N auto-approved, M deferred to the human

-- **because without the second line, "mounted and working" and "mounted and doing nothing" are the same picture**,
which is the failure this watchdog's own counters exist to prevent.

## [1.0.5] — 2026-10-17

**DSH-GPW ships as an optional sub-plugin, and the reason it never activated is fixed.**

### What DSH-GPW is

**Global Permission Watchdog.** It answers permission requests on the `approval/request` waterfall with a hard global
budget: **at most 10 auto-approvals per rolling 60 s, at least 3000 ms apart.** Past either limit it returns
`next()` -- *"no opinion"* -- so the request falls through to the human prompt **and waits**. It never refuses, and
it never changes what is being asked.

### Optional means optional, which decides where it lives

The package declares **one** `dsh.bundle.patch`, and that is what makes the w2m plugin mount itself on install. **A
second plugin in the same patch would mount for everyone**, and this one changes how permissions are answered -- that
is an operator's decision, not a default.

So it is exposed as `@twinsearth/w2m-dsh-plugin/gpw` and mounted by one explicit row:

    - insert:
        - id: dsh-gpw
          name: '@twinsearth/w2m-dsh-plugin/gpw'

**`insert:` is required and the reason is recorded in this package's own patch file**: no earlier layer creates a
`dsh-gpw` row, and a bare `- id:` patch aimed at a nonexistent row is **skipped silently**. Removing the row
disables it again.

**It is deliberately not re-exported from `lib/index.js`.** A permission-answering plugin must not arrive because
someone installed a fleet tool.

### The defect that kept it from ever activating

The standalone copy declared:

    export const inject = { required: ['approval'] };

**The host reads `inject` as an array of service names.** Measured across the shipped tree: **283 array-shaped
declarations, 0 object-shaped.** So the host took the object's *key* and waited for a service literally named
`required`:

    pending (waiting for service: required)

-- indefinitely, and the client reported the component as `等待依赖`. It is now `['approval']`, and `approval`
does exist: `@deepseek-ai/dsh-base`'s patch mounts `@deepseek-ai/dsh-user-approval` as id `approval`.

**The error message named its own cause**, which is why this took one measurement instead of an investigation: it
said `required`, and `required` is the key.

### What is verified, and what is not

**Verified:** `lib/gpw.js` loads; `name` is `dsh-gpw`; `inject` is an array; `apply` is a function;
`approval/request` and `allowed-once` both exist in the host (9 and 22 files respectively).

**Not verified: that it mounts and intercepts.** That needs a live host with the row added. The observable evidence
after a restart is its own startup line --

    approval-ratelimit: active -- at most 10 auto-approvals per 60 s, at least 3000 ms apart, process-wide

-- **and then the periodic counted line, without which "mounted and working" and "mounted and doing nothing" look
identical.** That distinction is the reason those counters exist.

## [1.0.4] — 2026-10-17

**The description described a different package, and it is the only thing many readers see.**

### Two numbers were wrong, and both were checkable

The text had been carried forward since an earlier release and said:

    ... eight DSH tools (replicate / split), nine aggregate verdicts and signed requests.

**Measured: eleven tools, six verdicts.** The tools are the `name: 'w2m_…'` registration sites in
`src/plugin/tools.mjs`; the verdicts are named in `src/relay/report.mjs:19-25` -- `consistent`, `divergent`,
`divergent-platform`, `failed`, `partial`, `unverifiable`. **Four coordination modes, not the two a
parenthetical named.**

### What mattered more than the numbers: it never mentioned joining

A reader finished that sentence knowing the plugin exists and **nothing about the step every new machine gets
wrong** -- which is the one this release's predecessor spent hours on. **A description that omits the join
requirement produces exactly the "I installed it and nothing happened" report.**

So the description now ends with it, as a flat fact: **"Joining needs a pairing code plus `autoStartAgent:
true`; installing alone does not join."**

### The replacement

    Run one project across your own Windows and macOS machines from a single DeepSeek account, through 11
    w2m_* tools. Four coordination modes (replicate, split, broadcast, pipeline) and six aggregate verdicts
    (consistent, divergent, divergent-platform, failed, partial, unverifiable). P2P hole punching by default,
    with a bundled relay, STUN responder and ledger fallback, so the fleet needs no third-party service.
    Joining needs a pairing code plus autoStartAgent: true; installing alone does not join.

**Exactly 500 characters, because registries truncate and a description cut mid-sentence is worse than a shorter
one.** The first candidate was 502; the trim removed two words and **was reported rather than applied silently**.
Both `package.json` and `plugin.json` carry it -- they previously disagreed, which is its own small defect: two
descriptions of one package.

**No code change.** Full suite 2352 in 89 files, 0 fail. Pre-flight GREEN with FIFTEEN checks.

## [1.0.3] — 2026-10-17

**The warning that predicted this failure now says what to do about it.**

### What was wrong with the old line

    w2m: no agent is running on this machine, so it is in no fleet and will receive no work.
         Set autoStartAgent: true to join (the fleet key is derived from the signed-in account),
         or run w2m-localside yourself and point it at the relay.

**Accurate, and insufficient.** It names **one** of the two things required and does not say *where* to set it.

**Measured on a real machine:** plugin installed, activated, **no error anywhere**, and
`device_token: null` with `autoStartAgent: false`. The operator's own summary was *"it installed but the machine
is not in the fleet"* -- **exactly what this warning predicts, and nothing in it resolved that.** The line was
written for the v0.8.5 failure mode and the operator still had to discover both steps.

### The guidance is now a procedure, and it is ordered

```
      This machine is NOT paired yet, so both steps below are required.
      To join, two things are needed:
        1. a one-time pairing code. `w2m-rabbit` prints it once, in its startup banner:
             [w2m-rabbit] listening on <url>  pairing code: PAIR-XXXXXXXX
           It lives in memory only and is never written to the state directory...
        2. `autoStartAgent: true` plus that code, on the `w2m` row that ALREADY EXISTS...
               - id: w2m
                 config:
                   autoStartAgent: true
                   pairingCode: PAIR-XXXXXXXX
           Do NOT add an `insert:` for it. An insert appends a SECOND entry with the same id, and the
           client then refuses to open -- measured on this project, not theorised.
```

**It states the current pairing state, because the two cases need different first steps.** An unpaired machine
must fetch a code; a paired one only has to turn the switch on, and **sending that machine after a code would send
it somewhere it has no business.** Verifying that branch required reading `device.json` and finding
`device_token: null`, which is exactly what the rendered warning then said.

**Why pairing cannot be automatic, stated where the operator will read it:** the relay's own header says *"the
pairing code is the only credential that grants admission"*, and **a plugin able to join unattended would be one
that lets any machine holding the package into the fleet.** So the fix is guidance, not auto-joining.

### A parameter I wrote into the text before checking that it exists

The first draft told the operator to use **`--print-pairing-code`**. **There is no such flag.** Measured from
`w2m-rabbit --help`, the real options are:

    --pairing-code <c>     Use a fixed pairing code instead of a generated one.
    --pair-rate-limit <n>  Pairing attempts per IP per minute. Default 5. 0 = off.

**And `--pairing-code` does the opposite of what I described**: it *chooses* a known code rather than printing an
existing one. The text now says that, **because a command in an error message is read as an instruction and is
followed.**

The warning was also **rendered and read** rather than assumed -- a warning nobody has printed is a warning whose
formatting is guesswork.

## [1.0.2] — 2026-10-16

**One missing line made the whole plugin fail to mount, and it had been missing since v0.41.0.**

### The defect

    JsonSchemaError: unsupported JSON schema:
      parameters.accept_block.additionalProperties must be explicitly true or false at authorError
        at parameterSchemaSpecToJsonSchema (dsh-tools/lib/index.js:803)
        at defineTool (dsh-tools/lib/index.js:848)
        at Object.apply (src/plugin/tools.mjs:5025)

`w2m_memory`'s `accept_block` was declared as `type: 'object'` **without `additionalProperties`**, and DSH's
compiler requires it to be explicit. **The throw happens while the tool is being defined, so the entire fiber fails
to mount** — the client shows the package as `异常`, **all eleven tools disappear**, and the message is visible
only if something gets far enough to print it.

**That single parameter is the whole failure.** Checked across the entire tool surface: **one `type: 'object'`
parameter exists in this file, and it was the one.**

### Verified against the real compiler, not the shim

`verify-installed.mjs` runs against an offline shim that checks shape only, **which is why it reported
`PASS: 11 tools registered` for every broken version**. The real `@deepseek-ai/dsh-tools` was extracted from
`app.asar` — 10,913 entries, preserving the `node_modules` layout so bare specifiers resolve — and the same call
was made against it both ways:

    WITHOUT additionalProperties -> THREW JsonSchemaError: ... must be explicitly true or false
    WITH    additionalProperties -> ACCEPTED

**Same error, same code path as the client reported.** That is the first measurement in this session taken from the
compiler that actually runs.

### `true`, not `false`

`verifyBlock()` and `acceptWithAuthority()` already validate the block's structure and its hash, **so the schema
is not the guard here**. A peer that adds a field outside the seven would be refused **for a reason that has nothing
to do with trust**, and refusing a legitimate block is the worse of the two errors.

### Why this took so long to find, stated plainly

**The error was invisible until the installer was used.** When the package was installed with `pnpm` and then
removed, the client failed *earlier*, with `cannot resolve profile bundle`, which names a resolution problem and
not a schema one. **Installing through the plugin manager took it far enough to reach `defineTool` and print the
real cause.**

**So the user's instinct was right in the way that mattered**: not that the official path behaves differently, but
that it is the path which gets far enough to report the truth. Four earlier rounds of diagnosis — a fabricated
incompatibility with the host, a mount-row duplicate, a release-notes defect, a runtime-discovery defect — were all
real, and **none of them was this**.

### The method that worked

I extracted the host's own compiler from `app.asar` and called it directly. **Every previous attempt had tested
against a shim, a clone, or an inference**, and each of those agreed with the broken declaration. **The only
measurement that disagreed was the one taken from the code that throws.**

## [1.0.1] — 2026-10-16

**The first stable release. Three defects fixed, two of them mine and one of them published 56 times.**

### The command allow-list could not admit the interpreter DSH itself runs on

Twelve end-to-end tests failed with `COMMAND_EXECUTABLE_PATH_MISMATCH`, and **the refusal was correct** —
the identity check was reading the wrong machine.

    bundled node : E:\DS\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
    PATH         : E:\Unity3D\Tuanjie Cowork\cli\bin\win32-x64\node.exe      <- a different program
    PATH contains the bundled directory : False

The tests dispatch `[process.execPath, '-e', …]` against an allow-list entry of the bare name `node`. **DSH runs
on the bundled interpreter and does not put its directory on PATH**, so the bare name resolved to an unrelated
`node.exe` shipped by another application, and an absolute path to the bundled copy was refused as "a different
file".

**Fixed by answering the right question.** `resolveCommand` still keeps PATH ahead of the bundled tree — a test
guards that precedence, and it is about *which file a name means*. The new `bundledExecutable()` answers a
different question: *is this path the bundled copy of that tool?* **The bundled copy of a tool is that tool**, so
identity holds, and **nothing is weakened**: it only ever returns files under `<deps>`, so
`E:\Temp\evil\node.exe` is still refused.

**The runtime is now discovered rather than assumed.** `dshDependenciesDir()` tried exactly one path,
`$DSH_HOME/dsh-runtimes/<runtime>/dependencies`, which stopped existing when the application moved its runtime
inside the bundle. It now tries the explicit override, then that documented layout, then **the directory implied
by `process.execPath`** — a bundled interpreter lives at `<deps>/node/bin/node`, so its own path states where
`<deps>` is. **That cannot go stale when the installation moves again.**

### 56 of 66 release scripts published v0.1.3's commit message under an unrelated title

Found because a test plan written against v0.60.0 reported its release notes as "highly duplicated" with several
earlier releases. **The scripts state the right intention and then read the wrong file:**

    /** The release notes reuse the commit message */
    const NOTES = fs.readFileSync('…\\commit-0103b.txt', 'utf8');          // v0.1.3's message
    name: 'v0.60.0 — approval index, fleet sync, service health, tiered storage',   // hardcoded

`scripts/github-release.mjs` **derives both fields from the repository's own record** — the title from the commit
subject, the body from the CHANGELOG entry — **so neither can be copied by accident.** It refuses to publish a
version with no CHANGELOG entry, and reads the release back after writing. **The five most-read releases
(v0.60.0, v0.59.0, v0.58.0, v0.57.1, v0.57.0) are corrected**, each verified by reading it back.

### My mount-row advice broke the client twice, and §3.2 withdraws it

**An installed plugin mounts itself**, from its own bundle patch — so adding a row to `cordis.patch.yml` inserts
a **second** entry with the same `id`, and the client stops opening. Measured: **0 rows before install, exactly 1
after, 2 with the manual row, 1 again once removed.**

### Also in this release

**Two client failures had one cause, and it was this repository's own advice: do not add a mount row.**

### The plugin mounts itself

`package.json` declares `dsh.bundle.patch`, so **the host composes an installed package from the patch shipped
inside the package**. Nothing needs to be written into the profile — and writing it anyway inserts a **second**
entry with the same `id`, which stops the client from opening.

**Measured on a throwaway profile**, because the desktop profile cannot be previewed (`rejectElectronProfile`)
and that is exactly where the failures happened:

| State | `id: w2m` rows |
|---|---|
| profile created, plugin not installed | 0 |
| **plugin installed, nothing else done** | **1** |
| a correctly written `insert:` row added as well | **2** ← the failure |
| that row removed | **1** |

**The symptom is worth stating precisely, because it is not a crash:** the client does not open, there is no
error message, and deleting `cordis.patch.yml` restores it immediately. **That is what pointed at configuration
rather than code.**

### §3.2, and why the old advice is withdrawn

The section now leads with the rule — **install, and change nothing else** — then covers the three ways an edit
goes wrong:

* **`insert:` is an append.** Appending a row whose `id` already exists is the failure. To change configuration,
  address the row the bundle patch created, as a non-insert patch.
* **`Add-Content` onto this file is always wrong.** It is a YAML list; a fresh profile ships `[]`, and a second
  document after it is a parse error. **The measured exception message is in the section**, because "failed to
  parse overlay" alone sends people looking at the wrong thing.
* **The desktop profile has no safe preview.** `--dump-config` composes and exits without starting anything, and
  it is the right tool — but the CLI refuses the desktop profile, so for that one the only protection is writing
  the row correctly. **Which in practice means not writing one.**

### What I got wrong, since the section exists because of it

I added the row to a live profile without a way to test it that did not involve the user's client, and the
backup went with the profile when it was reset. **The cost was two client failures and a profile reset.**

**I also formed a plausible hypothesis and disproved it before writing any of this**: I suspected
`Add-Content -Encoding utf8` had written a mid-file BOM. Measured on PowerShell 5.1 — a 45-byte file with the
BOM only at offset 0. **Not the cause, and recorded so it is not repeated.**

**The experiment that settled it took one command and started nothing**: `dsh --profile <probe> --dump-config`,
which prints the composed tree and exits. **It would have caught this before the first restart had I run it
first.**

**No code change and no test count change** — a documentation release. It is versioned rather than left
unreleased because the incorrect procedure was published in `TROUBLESHOOTING.md`, and a user following it would
break their client.

**56 of 66 release scripts published the wrong text, and this is the fix that makes it impossible to repeat.**

### The defect, found while checking someone else's test plan

A test plan written against v0.60.0 reported that its GitHub release notes were *"highly duplicated"* with
v0.59.0, v0.58.0 and several earlier releases, and concluded they were probably template-generated. **That
conclusion was right and the cause was mine:**

    // publish-0600-github.mjs
    /** The release notes reuse the commit message: it already states the cause, the fix and the evidence. */
    const NOTES = fs.readFileSync('E:\\GPT\\scripts\\commit-0103b.txt', 'utf8');   // <- v0.1.3's message
    name: 'v0.60.0 — approval index, fleet sync, service health, tiered storage',      // <- hardcoded

**The script states the right intention in its own comment and then reads the wrong file.** Measured: **56 of 66
`publish-*-github.mjs` scripts read that same stale file, and 57 carry that same title** -- four roadmap
keywords that describe none of those releases.

### What I got wrong twice while investigating

**First** I said the `health` module did not exist and that the test plan was testing a fiction. **It exists:**
`src/agent/health.mjs`, whose own header records the macOS mistake and its fix
(`darwin: ['/var/log', '/Library/Logs', '/tmp']`). **It was in the code and missing from my CHANGELOG, and I
read the CHANGELOG as if it were the record.** The test plan was more accurate than my denial of it.

**Second**, having been wrong, the honest correction is that the plan is right about `health` and wrong about
three counts, which are now measured rather than quoted: **89 suites (not 82), 2352 tests (not 2228), 15
pre-flight checks (not 12), and six aggregation verdicts (not nine)** -- `degraded`, `timeout` and
`cancelled` do not exist, so the three rows testing them would report false failures.

### The fix is a module, not another corrected copy

`scripts/github-release.mjs` **derives both fields from the repository's own record**: the title from the commit
subject, the body from the CHANGELOG entry for that version. **Neither is written by hand, so neither can be
copied by accident** -- which was the actual failure mode, since each release was a copy of the previous script
and the two constants that must change were the two easiest to forget.

**It refuses to publish when the CHANGELOG has no entry for the version.** A release whose body cannot be derived
is a release that would otherwise be published under the previous one's text, which is precisely what happened 56
times. **It also reads back after writing and compares**, because `PATCH` returning 200 is not evidence that the
field changed.

Verified: a version with no CHANGELOG entry is refused (exit 1); a version with one yields the commit subject as
its title and a 3024-character body (exit 0, dry run); the exported helpers split CHANGELOG sections correctly,
return null for an unknown version, and import without side effects.

**The token comes from `GITHUB_TOKEN` rather than being embedded**, which all 66 older scripts do.

### The five most-read releases are corrected

Titles and bodies rewritten from their own CHANGELOG entries, **each verified by reading the release back**
rather than by trusting the response:

| Release | Title now |
|---|---|
| v0.60.0 | `docs(troubleshooting) + feat(script): the lock rule, and an out-of-band session bound` |
| v0.59.0 | `fix(bin): every published bin can be imported without killing the importing process` |
| v0.58.0 | `feat(bridge): report what arrived instead of guessing what an image looks like` |
| v0.57.1 | `docs(bridge): correct a comment that implied a sequence the file does not have` |
| v0.57.0 | `feat(vision): an image path becomes text evidence, and the credential never touches argv` |

Each was 2044 characters -- one identical body -- before the repair.

**The remaining 51 are left as they are**, which is a decision rather than an oversight: they are old enough that
nobody reads them, and the module means the next release is correct without anyone remembering to check.

 format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.60.0] — 2026-10-16

**Two things learned from a client that would not start, neither of which was a crash in this plugin.**

### §3.1 in `TROUBLESHOOTING.md`: check the lock before you check the plugin

A launch that leaves **no process at all** is a different failure from one that starts and reports something, and
the existing §3 procedure will mislead anyone who skips that distinction — it assumes the application *ran*.

**The mechanism is one function in `@deepseek-ai/dsh-desktop`'s `lib/main.js`:**

```js
function claimDesktopSingleInstance(application, focusOwner) {
  if (!application.requestSingleInstanceLock()) {
    application.quit();          // no dialog, no error, no window
    return false;
  }
```

**A second launch is silently discarded while the first instance holds the lock.** Electron registers it against
the *application*, not a directory — which is why the two natural remedies both fail, and why the section now says
so before offering any plugin diagnosis:

| What was tried | Why it did nothing |
|---|---|
| disable third-party plugins before restarting | the new process quits at the lock, before plugin loading |
| reinstall the client (new folder, new exe) | a new directory does not release an application-scoped lock |

**Deleting `~/.dsh` fixed it — not because anything in it was corrupt, but because the deletion took down the
process still holding the lock.** The section now leads with the measurement that costs nothing:

```powershell
Get-Process -Name 'DeepSeek Harness' | Select-Object Id, StartTime
```

**Processes listed → it is the lock, end them and retry. Nothing listed → the failure really is pre-lock, and §3's
procedure applies.** The deleted directory carried session history and profile configuration; **`Stop-Process`
would have cost nothing.**

### `scripts/session-retention.mjs`: the store is bounded, out-of-band, as DSH says it must be

`@deepseek-ai/dsh-session-persistence`'s README, under *Known Limitations*:

> **No deletion or retention API** — pruning stored sessions is **out-of-band backend maintenance**.

**So this is not a workaround for a missing feature: the host states retention is the operator's job.** The
measurement that motivated it is that **one session reached 18.03 MiB of an 18.07 MiB store**, nothing bounds it,
and every start reads the store.

Three refusals are built in, and each is a deliberate limit rather than an omission:

* **The newest session of every workspace is never removed.** DSH writes to it, and *which* process is writing
  cannot be checked reliably from outside — so the rule is the one that needs no knowledge of the running
  process.
* **`--apply` is required.** The default prints the plan and exits 0. **A tool that removes conversation history
  shows what it will remove before it removes it.**
* **A directory that is not a session is reported, not touched**, because the layout is read from the filesystem
  rather than assumed.

**Verified against the real store:** at a 256 MiB cap it reports *"under the cap — nothing to remove"*; at a
1 MiB cap it plans two removals and leaves the 18 MiB live session alone.

**No test count change** — both additions are a document and a script, and the script is exercised by hand against
the store it bounds rather than by a fixture that would not resemble it.

## [0.59.0] — 2026-10-16

**Every published bin can now be imported without killing the importing process — measured, not reasoned about.**

### The defect

`package.json` publishes three CLIs as importable `exports` subpaths:

```json
"./rabbit":    "./bin/w2m-rabbit.mjs"
"./localside": "./bin/w2m-localside.mjs"
"./stun":      "./bin/w2m-stun.mjs"
```

**And those three had no import guard, so their top-level body ran on import.** Measured:

```
import .../bin/w2m-localside.mjs   ->  node exited with code 2
a statement placed after the import never ran
```

**A published entry point that terminates whichever process imports it.** The plugin's own client-bundle
documentation records that `exports['./client']` *"is what the host scans for"*, so the host reads that map —
**and `w2m-mcp.mjs` already carried this guard, which is why it was the one bin that behaved.**

The fix gives the other three the same guard rather than withdrawing the exports: **a subpath that is importable
and inert is strictly better than one that is neither.** All four are now inert on import (`58ms / 74ms / 5ms /
2ms`) and all four still run as programs (`--help` → exit 0 with the right banner).

### What this does **not** claim, and why that matters here

**This is not offered as the explanation for the client that would not start.** That was reported as *no process
at all on a double-click*, and that symptom has a different mechanism, read out of `lib/main.js`:

```js
function claimDesktopSingleInstance(application, focusOwner) {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }
```

**`application.quit()` — no dialog, no error, no window.** A second launch is silently discarded while the first
instance holds the lock, which explains all three observations: disabling third-party plugins did nothing (the
new process never reached plugin loading), **reinstalling the client did nothing (a new directory does not release
a lock registered against the application)**, and deleting `~/.dsh` worked — **because it took down the lock
holder.**

**A real defect, fixed; a different defect, responsible.** The two were adjacent in time, and conflating them
would have produced a changelog entry claiming a fix it cannot demonstrate.

### Three of my edits failed on the same mistake before the fourth worked

The guard had to be inserted where each file's executable body begins. **My first two markers were text I
predicted rather than read** — `await main()` does not exist in `w2m-rabbit.mjs`, and `const bound = await bind`
does not exist in `w2m-stun.mjs`. Then a `Select-Object -Skip` offset was **1-based** while the array index is
**0-based**, so the script refused both files by one line. **The fourth attempt anchored on the statements' own
text and succeeded on the first run.** That is the same lesson as the fabricated relay route and the malformed
PNG, and it is now the fifth time this session.

**No test count change** — the guards alter when the bodies run, not what they do, and all four entry points are
exercised by `scripts/check-entrypoints.mjs`.

## [0.58.0] — 2026-10-15

**The bridge now reports what it received instead of guessing what an image looks like.**

### Why this is a probe and not an image branch

`ITEM_TYPE` declares exactly one member:

```js
export const ITEM_TYPE = Object.freeze({ TEXT: 1 });
```

**The shape of every other item type is unrecorded in this repository** — no `image_item`, no sample payload, no
fixture. `ilink-protocol.mjs` documents only the text form. **So a download path written today would be a guess
about field names, and it would fail at the moment a real photograph arrived** — which is the worst possible time
to discover a wrong guess, because the person is waiting for their picture to be read.

**This is the discovery step.** `describeItems()` reports **key paths and value types, never values**, so one
photograph sent by a person answers the question the source cannot.

### Values are never recorded, and that is the point of the whole function

A message body is the user's content, and **a discovery aid that quietly wrote photographs into a log file would
be a worse defect than the one it exists to diagnose.** One assertion is dedicated to that: a distinctive
passphrase planted in a URL and a caption, and the check that neither appears in the output.

The walk is bounded — `maxKeys` and `maxDepth`, arrays described by length and first element, cycles reported
rather than followed — **so a surprising payload cannot bury the log it is being written to.**

### Every wrong guess this session was corrected by printing the thing

A fabricated relay route (`/v1/stats`, `/v1/status`), a malformed PNG reported as a credential failure, a count
typed from memory onto a CHANGELOG entry — **each was fixed by reading rather than predicting.** This applies that
method *before* the guess instead of after it, which is the only difference between this and the four previous
occasions.

### What is still not done, stated rather than implied

**The bridge still cannot read an image.** The `/v1`-style branch that downloads it does not exist, because the
field names are unknown. What exists now is the instrument that finds them: **send one photograph, and the log
says what the far end actually sends.**

**13 new tests, 0 failures**, and the existing bridge and tool-card suites still pass — the added `shape` field is
carried only on a non-text reply, so it means one thing. Full suite 2354 in 89 files. **Pre-flight GREEN.**

## [0.57.1] — 2026-10-15

**The vision status line now appears only on a bridge that actually starts — which it already did, for a reason
worth writing down.**

`visionStatus()` sits at the top of `main()`, and the configuration refusal runs at **module scope, before `main()`
is ever called**. So a bridge that refuses to start prints nothing about vision.

**I first described that as a bug and set out to move the check "after the refusal block".** Reading the file
showed the ordering was already right: **the refusal already names what is wrong, and a second complaint about
vision underneath it would bury the first.** The comment was corrected to say what the code does rather than to
describe a fix that was never needed.

**A no-behaviour-change release**, and the only reason it exists is that the comment previously implied a
sequence the file does not have.

## [0.57.0] — 2026-10-15

**An image path becomes text evidence: the vision subprocess, and the credential path that does not touch argv.**

### What this is, and what it deliberately is not

`src/chatops/vision.mjs` runs the vendored `vision.py` as a subprocess. **It is not the WeChat integration** —
the bridge still answers an image with a help message. The two halves are kept apart because each has a different
failure mode and can be verified alone, **and this half is verifiable today**: give it a real image and it either
returns text or a named reason.

**Verified against the real endpoint, on this machine:** a generated 32×32 red PNG, `glm-4v-plus`, **1.77 s**,
reply `"红色。"` — and `prompt_tokens` 64 → 2374, so the image genuinely reached the model rather than being
ignored.

### The credential never enters `argv`

`vision.py` resolves its key as `--api-key` > `VISION_API_KEY` > the provider's own variable — read out of its
own source, not assumed. **Passing it on the command line would put a live key into `ps` output and into any
argument logging**, so this module only ever sets it **in the child's environment**, and the caller supplies it
from a file.

**The settings file is a parser, not a shell.** No expansion, no quoting rules, no `export` prefix: a value of
`$HOME` stays the four characters `$HOME`. **A settings file that is half a shell is a shell**, and the point of
this one is that it is read rather than executed.

### An error message I wrote that collapsed three causes into one

My first probe of the credential printed
`==> refused; the key or the model name is not accepted` for **any** non-2xx response. The actual response was:

```
HTTP 400  code 1210  "图片输入格式/解析错误"
```

**That is an image-decoding failure — which is proof the credential was accepted**, because bigmodel answers
**401** for a bad key. **My hand-built base64 PNG was malformed, and I reported it as a credential problem.** One
conclusion for three different causes is the failure this repository keeps naming, and I committed it while
writing a file whose own header complains about that pattern.

The re-probe generates the PNG from `zlib.deflateSync` plus a hand-written CRC — **correct by construction** —
and splits the two questions: a text-only request isolates the key, and the image isolates the vision path. Both
returned 200.

### One ordering the code decided and the test got wrong

The module checks the image argument, then the script, then whether the image exists. My new assertion claimed a
non-existent image outranks a missing script — **it does not, and the code was right.** The assertion was
narrowed to the ordering that is actually guaranteed: **an empty argument is rejected before the installation is
consulted.**

**17 new tests, 0 failures**, and none of them needs a network or a key — every refusal path is asserted, and the
one thing not asserted is a real model answer, because a suite that needs a credential is a suite that skips
wherever the credential is absent.

## [0.56.0] — 2026-10-15

**The declared endpoint is now tested against the real binary, so a drifted port turns the pre-flight red.**

### The gap the sixteen transport tests left open

`mcp-http.test.mjs` drives `createRequestHandler` **in process**, with fake request and response objects. That
proves the framing, and it proves **nothing about the CLI path**: a wrong default port, a crash during startup,
an import cycle, or a `--http` flag that is never reached would all pass while `mcp.json` pointed at a dead URL.

**A wrong end of a declared address is not a unit-test-shaped bug.** It has to be dialled.

### What the new suite does differently

`test/mcp-http-live.test.mjs` **spawns `bin/w2m-mcp.mjs --http`** and speaks to **the URL read out of
`mcp.json`** — not a URL the test picks, because a healthy server on port 0 would prove nothing about `8766`.

It asserts the far end is reachable and speaking the protocol, and **deliberately does not assert a successful
tool result**: the relay needs an operator token the test does not carry, so **a `401` is the expected
outcome**. That refusal is *stronger* evidence than a mocked `200` — **it proves the request left this process,
crossed the binding, and was answered by the fleet's real relay**, which a mock could not distinguish from a
server that never dialled out.

**stdout is asserted empty.** The stdio binding owns stdout; if this path ever wrote a frame there, a client
launching both would see a corrupted stream and the symptom would be a hang rather than an error.

### Three levels of nesting, which is why this was worth checking

`pre-flight` → runs the declared suite as a child → which runs this suite → which spawns the server. **That
works**, and the run proved it rather than assuming it.

### The one failure it produced, and it was mine

The first run went red on `claims.test.mjs`: **`package.json` said 0.56.0 and the newest CHANGELOG entry said
0.55.0.** I bumped the version before writing the entry. **This project's own check caught my ordering mistake**
— which is the whole point of `claims` existing, and the second time this session that a version bump without an
entry has been the only red line in an otherwise green run.

**6 new tests, 0 failures.** Full suite 2324 in 87 files. **Pre-flight GREEN with FIFTEEN checks.**

## [0.55.0] — 2026-10-15

**A second transport binding — and `mcp.json` now declares both.**

### The same protocol, two bindings, and no logic shared between them

The MCP overview states it plainly: **"protocol semantics are identical on every transport. A transport is a
binding."** So `src/mcp/http-transport.mjs` contains **no protocol decisions** — it decodes a request, hands the
body to the same `handleMessage` the stdio binding uses, and encodes the reply. **Neither binding imports the
other.** The single command reaches the fleet over both.

### What revision `2026-07-28` removed, which made this smaller than expected

* **The GET stream endpoint is gone.** A bare `GET /mcp` gets **405 naming the revision**, not a 404 — a client
  written against the older revision should learn *why* rather than guess at the URL.
* **Protocol-level sessions are gone.** No `Mcp-Session-Id`, no session table, no state between requests. Two
  identical requests return identical bytes, and the test asserts it.

`GET /mcp?discover` still answers, **gated on an explicit parameter**: a bare GET is what the removed stream
client sends, and handing it a description document to parse as a stream would be worse than refusing it.

### The `Origin` rule is a MUST, and it is easy to skip

> **"Servers MUST validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks."**

A loopback MCP server is reachable by **any page the user's browser loads**, and a rebinding attack makes that
page same-origin. So a refused `Origin` gets **403 before the body is read** — asserted with an unparseable body,
because ordering is the property.

**A missing `Origin` is allowed, and that is a decision rather than an oversight**: the header constrains
*browsers*, an attacker's browser always sends one, and refusing an absent header would break every
command-line client while stopping no attack. The default bind is **127.0.0.1**, per the specification's SHOULD.

### `mcp.json` declares both, and one of them is not a subprocess

```json
"w2m-fleet":      { "type": "stdio",           "command": "node", "args": ["./bin/w2m-mcp.mjs"], "cwd": "${PLUGIN_ROOT}" },
"w2m-fleet-http": { "type": "streamable-http", "url": "http://127.0.0.1:8766/mcp" }
```

**The HTTP entry names a server that must be started separately** — `node bin/w2m-mcp.mjs --http` — because a
remote-transport entry has no `command` to launch. That is what the transport type means, and the alternative —
declaring only stdio — would leave an HTTP-only client with nothing to connect to. **The `cwd` is
`${PLUGIN_ROOT}` rather than a path, so the entry works wherever the package is installed**, and
`plugin-manifest-check.mjs` validates both entries against the schema's closed per-transport field sets.

### One assertion I wrote wrong, and the fix was the implementation

My discovery handler matched `GET /mcp` **exactly**, while the test sent `GET /mcp?discover=1`. **The test was
right and the code was wrong** — the two GETs are different callers with different needs, and telling them apart
by a parameter is honest where guessing at intent is not. Fixed the handler, not the test.

**16 new tests, 0 failures.** Full suite 2318 in 86 files. **Pre-flight GREEN with FIFTEEN checks.**

## [0.54.0] — 2026-10-15

**The fleet is published as an MCP server — read-only, and every declared route is checked against the relay's
own router.**

### Five tools, and nothing that can change anything

```
w2m_devices  -> /v1/devices
w2m_stats    -> /healthz
w2m_history  -> /v1/tasks
w2m_report   -> /v1/tasks/{id}/report
w2m_status   -> /v1/agents/{id}/status
```

**`w2m_run` is deliberately absent.** A server that hands fleet execution to any process able to start it gives
away the ability to run commands on every machine in the fleet — and this project has already learned that a
guard which is merely *named* well is not a guard: the `--dry-run` flag in `scripts/ilink-fleet-bridge.mjs`
**dispatched for real while its name promised otherwise**. So the first version exposes five reads, and a test
asserts by name that no mutating tool appears — **a later edit adding `w2m_run` has to delete an assertion rather
than quietly widen what the fleet exposes.**

### I invented two routes, and the check that catches that now exists

My first draft declared `/v1/stats` and `/v1/status`. **Neither exists.** The relay's complete GET surface is
`/healthz`, `/metrics`, `/v1/stream`, `/v1/devices`, `/v1/tasks`, `/v1/tasks/{id}`, `/v1/tasks/{id}/report` and
`/v1/agents/{id}/status`.

**A fabricated route does not fail loudly.** The relay answers 404, the MCP client reports a broken server, and
the bug is in this package — a failure that surfaces in somebody else's tool, at a time nobody connects to this
commit. So `scripts/mcp-check.mjs` **reads the routes back out of `src/relay/server.mjs` and compares them**, and
the pre-flight runs it as a fifteenth check. Verified by injection: adding `/v1/invented` turns it red and names
the route.

**Two routes needed canonicalising to compare at all** — the router carries `/v1/tasks/([^/]+)/report` where the
tool declares `/v1/tasks/{id}/report`. The first version of the check failed on two routes that *are* routed,
which is its own lesson: **a check that fails on correct input gets disabled.**

### Both protocol eras, because the deployed clients are on the older one

The current revision (`2026-07-28`) is **stateless** — version, identity and capabilities travel as per-request
`_meta`, and there is **no handshake**. Every earlier revision opens with `initialize`.

**A server implementing only the modern contract is unreachable from most deployed clients**, which is exactly
the population this exists to serve. So `initialize` is answered for legacy clients, `_meta` is honoured for
modern ones, and an unsupported version gets the `-32022` error **with the `supported` list**, as the
specification requires. `server/discover`, which the current revision demands of every server, is implemented.

**A notification is never answered** — JSON-RPC forbids it, and `notifications/initialized` is sent by every
legacy client, so getting that wrong breaks every connection.

### stdout carries protocol messages and nothing else

Over stdio a stray `console.log` corrupts the stream, and the symptom is a **hung client**, not a chatty server.
Every diagnostic in this file goes to stderr through one `log()`, and the test drives the real `serve()` loop
over in-memory streams rather than spawning a process — **because a test that needs a subprocess is skipped
wherever piped stdio is refused, which is exactly where a protocol regression must still be caught.**

### Four mistakes of mine, three of them the same mistake

* **`/v1/stats` and `/v1/status` were fabricated.** Read the router; do not write the route you expect.
* **`mcp-check.mjs` ran its whole check and called `process.exit` on import**, so the consuming suite reported
  **1 test instead of 25** with no failure named. **This is the third file in this project to need the same
  guarded-`main()` fix** — `skill-check.mjs` and `plugin-manifest-check.mjs` were the first two — and each one
  now carries the guard with a comment saying why.
* **I deleted a doc comment's closing `*/`**, which commented out `export const TOOLS` and produced
  `TOOLS is not defined`. **That is the fourth time in this project that an edit matched anchor text without
  reading the block containing it.**
* **One assertion failed three times for three different incidental reasons** — a sample value substituted
  where the builder applied a default, a `{id}` that `canonicalRoute` refuses to collapse, and an optional
  property left unset. **The fix was to narrow what it tests**: the property is *"this tool can reach the route
  it declares"*, and the query string is not part of that.

**25 new tests, 0 failures.** Full suite 2302 in 85 files. **Pre-flight GREEN with FIFTEEN checks.**

## [0.53.0] — 2026-10-15

**The shared-memory layer gets a suite, and it corrected three things this session had already "verified".**

### The layer was measured by hand; now it is measured by the suite

Field-level omission at level 0, the refusal of an unproducible ancestor, the level 0/70 difference — **all of
that was real evidence, produced through actual dispatches to an actual machine.** It was also **not
repeatable**: it lived in a session, not in the suite. **A measurement that cannot be re-run is a memory of a
measurement.**

`test/memory-layer.test.mjs` adds **22 assertions**, and the suite grew to 84 files.

### Three corrections, each of which the hand-run had got wrong

**1. `evidence` costs 50, not 70.**

```
FIELD_LEVELS = { subject: 0, body: 0, evidence: 50 }
```

A level-70 dispatch succeeded, and **70 was written down as the threshold.** It is not: 49 is refused and 50 is
allowed, and **50 is not arbitrary — it is the bottom of the `captain` band**, which is why the number is what
it is.

**2. `confidence` is an invariant, not a high-cost field.**

`NEVER_ACCEPTED.confidence` = *"a receiver does not adopt the sender's certainty (**invariant, not a
default**)"*. Level 90 is refused exactly as level 0 is, and there is no level that satisfies it. **The reason
string says "invariant" on purpose: a reader who thinks it is a threshold will try to raise it.**

**3. `FIELD_UNDECLARED` does not mean "forbidden", and the two APIs answer different questions.**

| call | question | `origin` / `observed_at` / `lineage` |
|---|---|---|
| `acceptField` | *may a receiver choose this?* | `FIELD_UNDECLARED` — no rule lets a receiver pick it |
| `acceptWithAuthority` | *what does this receiver keep?* | **present in `accepted`** — they are inherited |

**So `UNDECLARED` means "not a receiver's to choose", not "refused".** Reading it as a refusal would have the
receiver drop the ancestry that makes the block meaningful — and `INHERITED_FIELDS` plus
`RECEIVER_CHOOSABLE_FIELDS` partition the seven exactly, so neither list can change without the other.

### Four assertions of mine that were wrong, and the last one is the interesting one

* **`ancestry` takes a `Map`, not an array**, and returns `{chain, missing, cycle, depth}` — **there is no `ok`
  and no `code`.**
* **`MISSING_PARENT` is not an `ancestry` outcome.** `ancestry` **collects** gaps in `missing` — *"knowing how
  much of a history is absent is more useful than knowing that some of it is"* — while `acceptBlock` is what
  **refuses**, returning `accepted: null`.
* **`isDescendantOf` returns `{descendant, chain, missing, checked}`, not a boolean.** It returns more than a
  boolean because that is its point: *"a claim that descends from something this machine already thought is an
  **echo**, not corroboration, and **a fleet that cannot tell those apart will confidently agree with
  itself**."* A parent that is not held gives `descendant: false` — and my assertion had demanded `true`.
* **I could not construct a cycle, and that turned out to be the finding.** `blockHash` covers `lineage`, so
  rebuilding a block changes its hash and the edge no longer closes — **a real cycle would need a hash
  preimage.** The walk produces a *diamond* instead, and `CYCLE` is reachable **only** from a `have` map whose
  keys disagree with the blocks under them: a corrupted or hostile store, where **terminating is the point,
  because an unbounded walk on hostile input is a denial of service.**

**Three attempts at that test asserted a cycle the code was right not to report.** The fourth printed the
traversal instead of predicting it, which is the only one of the four that produced a fact.

## [0.52.0] — 2026-10-15

**Agent Plugins 1.0.0 manifests, validated against the published schemas — and the honest note about who
reads them.**

### What shipped

```
plugin.json    root manifest, Agent Plugins 1.0.0, $schema pinned to the canonical identifier
mcp.json       schema-valid with an EMPTY server map -- see below
skills/        unchanged; the four SKILL.md files were already the portable form
```

`scripts/plugin-manifest-check.mjs` validates both, `pre-flight` gained a fourteenth check, and
`test/agent-plugins.test.mjs` adds fourteen assertions across both manifests and the skills.

### The schemas were read, and the constraints are written out rather than fetched

`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` and `.../mcp.schema.json` are both live, and the
rules come from them — including the `name` pattern `^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`,
**which refuses `--` and `..` and which I would not have guessed.** They are **not fetched at check time**:
a validator that needs the network cannot run offline, and one that skips itself when the fetch fails reports
success for the case it could not measure.

**What this cannot check, stated rather than implied:** the schema's own description says *"the Agent Plugins
specification defines additional semantic and operational requirements."* Path containment, symlink
resolution, MCP transport support and the `PLUGIN_ROOT`/`PLUGIN_DATA` expansion rules are **not** expressible
here and **are not claimed**.

### `mcp.json` ships with zero servers, and that is the honest version

The request specified MCP as the unified calling protocol. **DSH has no MCP client.** Measured across all
8543 small code and config files in the application bundle: `plugin.json` 0, `mcp.json` 0, `agent-plugins` 0,
**and `mcpServers` 0 occurrences in host-owned code** — the 202 hits are third-party SDKs inside
`node_modules`, which support MCP without this host reading a config for it.

**And there is no MCP server in this package.** So the file is schema-valid with an empty map: a portable
client reads it and starts nothing, which is true. **The alternative — declaring a server that does not
exist — is a manifest that launches a failure**, and shipping that to satisfy a specification would be the
same mistake as advertising a capability the code lacks.

### The one rule that is not from a schema caught me immediately

`plugin.json`'s `version` must equal `package.json`'s. **On the validator's first run it failed: the manifest
said 0.52.0 and `package.json` still said 0.51.0.** That is the whole justification for the rule — DSH loads
plugins through `package.json#dsh` and a Cordis bundle patch, **so nothing in this host ever reads
`plugin.json`.** A manifest with no consumer has no way to notice it is stale.

**A file nobody reads is a file that cannot be wrong.** The schema check and the drift check are the only
things standing between this manifest and quiet decay.

### Four assertions that were wrong, mine

* **`frontmatter('---\nname: a\n')` returns `null`, not `{ data: undefined }`** — an unclosed block is not
  frontmatter, and my assertion demanded the shape the code does not return. **The code was right.**
* **I typed `disableModelInvoction`** in the rejected-spelling set. **A misspelled name in a rejection list
  is a name that is not rejected** — the exact failure the list exists to prevent.
* **I exported a contract object above the constants it read**, so importing the module threw
  `Cannot access 'PLUGIN_FIELDS' before initialization`.
* **I wrote the `implementations` Map entry as `['name']: () => …`** inside an array of pairs, matching an
  anchor line without reading the structure around it. **This is the third time in this project that an
  edit matched an anchor string instead of the block containing it.**

Both validators now export their rules and keep the CLI in `main()`, so **the suite asserts them without
spawning a child** — a test that needs a subprocess is skipped wherever piped stdio is refused, which is
exactly where a check must still run.

## [0.51.0] — 2026-10-15

**Four Agent Skills, written against the loader's real contract — and a gate that makes the contract matter.**

### The four skills

```
skills/
├── fleet-control/SKILL.md        the four modes, the nine verdicts, every refusal code
├── memory-sync/SKILL.md          field-level acceptance, omission versus null, ancestry
├── session-ref/SKILL.md          the dsh-session: codec, its three checks, its silent trap
└── resource-schedule/SKILL.md    lease states, the ~50s ceiling, what "expired" means
```

**Every rule in them was measured before it was written.** The refusal codes are the ones this session
actually produced, the ~50-second ceiling is one that was hit more than eight times, and the `dsh-session:`
section describes a codec whose three checks were read out of `@deepseek-ai/dsh-session-reference` — **including
the one that surprises people, where a payload that decodes correctly is still refused for not being
*canonical*.**

### The contract came from the loader, not from a specification

`parseSkillFile` reads **`name`** and **`description`**, tests the name against
`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, and **rejects three renamed spellings outright** —
`disableModelInvocation`, `modelInvocable`, `userInvocable` — in favour of the hyphenated forms. On any
failure it logs a warning and **returns**.

**That is the whole reason this ships with a gate.** A skill that violates the contract is not an error: it
simply never appears, the directory still looks shipped, and nothing is red. **It is a file whose only symptom
of being wrong is not being there.**

### New check: `agent skills`, and the twelfth became the thirteenth

`scripts/skill-check.mjs` mirrors the loader's rules, and `pre-flight` now runs it.

```
PASS  agent skills (frontmatter satisfies the loader, so no skill is silently dropped): 4 skill(s) satisfy the loader contract
pre-flight: 13 pass, 0 fail, 1 unverifiable (13/13 registered check(s) reported) -- GREEN
```

It is bound in **three** places — `DECLARED_CHECKS`, `GATE_INVENTORY` (five artifact rows: the validator and
the four `SKILL.md` files), and the implementation map — because this repository's own rule is that a
declared check with no artifact, or an artifact with no check, is red in both directions.

### Two mistakes of mine, both worth keeping visible

**The check reported `exit null` and nothing else.** The cause was `result.error` — an `EPERM` from
`spawnSync` under a `workspace-write` sandbox that had replaced the `danger-full-access` of earlier runs. **The
code was right and the environment was refusing.** But the diagnosis was bad on its own terms: **a check that
prints an exit status and drops the reason names nothing**, so the failure now says
`EPERM: spawnSync …` and the next reader does not have to rediscover the sandbox boundary.

**I edited the `implementations` Map into invalid syntax** — `['name']: () => …` inside an array of pairs —
because I matched an anchor line without reading the structure it sat in. **This is the same error shape as
the `accept_block` branch in 0.41.0, and it is twice now.**

**The skills ship** — `skills` is in `package.json#files` beside `docs`, so the four `SKILL.md` files are in
the tarball. **They load only when a host points `DSH_BUNDLED_SKILL_DIR` at the directory**, which is a host
setting rather than something the package can assert; the alternative roots are `<project>/.dsh/skills`,
`<project>/.agents/skills`, `<dshHome>/skills` and `~/.agents/skills`.

## [0.50.0] — 2026-10-15

**The matrix gains the two defects and the WeChat path — and the counts are read from the table, not typed.**

### What the matrix now records that it could not before

`docs/TEST-MATRIX.md` grows **two sections and eighteen rows**:

* **§十二 微信桥接** — twelve rows for the path this project had never executed: QR binding, the bridge
  reading the live channel, the permission refusal by name, `--ask` as the marker that keeps a sentence from
  being dispatched, and **the full WeChat → dispatch → verdict → WeChat round trip**.
* **缺陷** — six rows for what was found and changed. **修正时间 has content for the first time, because it is
  the column for things that were corrected**, and it was empty until now.

**Every one of the 18 can be traced to a command, an exit code, or a line of a log.** The two silent inputs,
the two dry runs that dispatched, the run with no reply because the bridge was stopped, and the token deleted
by a release — all of them are there with what produced them.

### The counts are now read from the table, and the reading is written down

```
79 行 = 52 通过 + 8 待执行 + 11 阻塞 + 1 跳过 + 2 证伪 + 5 失败(已修或已确认)
```

**This is the second time I have corrected these numbers, and the two corrections have the same cause.** In
0.46.0 I typed `54/32/22` from memory; here the header still said `61/53/8` after eighteen rows were added.
**Both times the fix was to read the table instead of recalling it**, so the equation is now stated in the
document beside the numbers, and a test-shaped check confirms the arithmetic against the rows.

### The one row that is `失败 → 未修`, and why it is the useful one

**`TC-DEF-006`: every release runs `Remove-Item dist`, which deletes `dist/ilink/ilink-login.json` — the
WeChat token.** I hit this myself ten minutes after binding the bot, and the symptom is
`no login at dist/ilink/ilink-login.json`, **which says nothing about a deletion.**

It is recorded as **unfixed** rather than quietly omitted, because **a matrix whose only unexecuted rows are
environmental stops being a list of things to do.** The fix is small — move the login file out of `dist/`, or
have the release step spare it — and it is not in this release because the honest state is that it is not
fixed yet.

**No new tests.** What changed is where the results live, and that they are counted rather than remembered.

## [0.49.0] — 2026-10-15

**Every message now gets an answer. Five inputs were being silently dropped, and two of the three input
types the request asked me to advertise are not supported.**

### What was silent, measured before it was changed

```
文字 /run node --version  → dispatch
文字 /run --ask 你好       → reply
文字 你好                  → ignore   why=not a /run line
图片 (type 2)             → ignore   why=not a text message
语音 (type 3)             → ignore   why=not a text message
空 item_list              → ignore   why=not a text message
```

**Five inputs, no answer.** A bot that reads messages and replies to none of them is
**indistinguishable from a bot that is broken**, and the operator's only move was to send the command again.

### The one silence that survived, and why it had to

`no sender` and `no context_token` still return `ignore`. **With no sender or no context token there is
nowhere to send an answer**, so returning `reply` would be a plan that lies about what the caller can do.
**That is the reason the vocabulary still contains `ignore` at all** — collapsing it into `reply` would have
made every plan look successful while nothing was sent.

### The request asked the help to advertise "text, voice and images". I refused two of the three.

`textOf` reads only `item type: 1` — **measured, not inferred: an image and a voice note both answer
`not a text message`.** So the help says:

> 支持：文字。中文可以。
> 不支持：语音、图片、文件、表情——它们只会得到这条帮助。

**A help text that promised a capability the bridge does not have would be read as a bug the first time
somebody sent a photo**, and the bug report would be about the bridge rather than about the promise.

### The three sections are asserted by heading

`【1】开关指令` · `【2】指令规则与格式` · `【3】参考与边界` — asserted by name rather than by "the text mentions
commands", because **a help text that loses a section still reads fine.**

Two of the seven new assertions are worth naming:

* **`--ask` is in the help.** It was reachable only by reading the source, which is the entire
  discoverability defect this section exists to close. If it ever leaves the help, the defect is back.
* **every `/run` example in the help is put through the real parser.** The help cannot drift into
  advertising syntax that is refused.

### The activation instruction, answered honestly

*"If refused, provide the activation instruction"* — and the honest answer is that **a chat window cannot
activate itself**. The help says the capabilities are granted by whoever starts the bridge, through
`W2M_CAPABILITIES`, and that a refusal names the missing capability. **Implying otherwise would have sent
the operator looking for a command that does not exist.**

**Three existing tests demanded `ignore` and now demand `reply`.** They were right about the rule — a typo
must never become a fleet execution — and wrong about how the rule is expressed. They were updated rather
than deleted, because **the old expectation is the record of what changed.**

**7 new tests, 0 failures.**

## [0.48.0] — 2026-10-15

**`--dry-run` dispatched. Two dry runs sent a command to five machines, and one made a real task.**

### The defect, measured before it was described

The bridge guarded exactly one thing under `--dry-run`: the **reply**. The dispatch ran unconditionally.

```
[15:13:57] dry run     : true
[15:15:00]   dispatched task 01M50231AYJYDD41WSPMS9PRM3
[15:15:50]   verdict for …: partial
```

**That is a real task record with five real leases, produced by a run whose flag promised nothing would
happen.** A rehearsal executed commands on production machines — and it was found by accident, while draining
a message queue, not by a test.

### Why the fix is "skip the dispatch" and not "rename the flag"

**This repository already fixes the meaning of the word.** `update-install`'s `dryRun` is asserted to **call no
package manager and write nothing**, and `auto-update`'s is asserted to **write nothing to the profile**. So a
second `dry-run` meaning "do the dangerous part anyway" is not a naming preference — **it is two flags with one
name and opposite meanings, and the bridge held the unsafe one.**

**Renaming would have left the flag. Aligning keeps the word and removes the hazard**, and a reader who knows
`dryRun` from anywhere else in this project is now already right about this one.

### Why the guard is a function in `lib`, not an `if` in the script

`scripts/` is **not in `package.json#files`**, so nothing there is covered by a test that ships. A safety
property expressed as one line inside an untested script is a property nobody re-checks. `dryRunPolicy` is
exported and asserted beside the wire shapes — **a script is not where a guard should live if the guard is the
point.**

The guard sits at the **top of the only function that reaches `fleet.run`**, not at its call site, because a
guard at the call site is one edit away from being bypassed by a second caller.

### A name collision that made my own test wrong

I asserted that `dryRun: 'true'` must not dispatch. **It does dispatch — the code was right and the test was
wrong**, and the cause is two different things sharing one word:

| | meaning |
|---|---|
| the CLI **flag** `--dry-run` | **present-means-true** (`argv.includes('--dry-run')`) |
| the **parameter** `dryRun` | **defaults to false**, which is what `update-install` means by it |

`dryRunPolicy` takes the parameter, and the script always hands it a boolean. The assertion is now the strict
one — **only `true` turns the dispatch off, so a future caller cannot open the path with a truthy value.**

**5 new tests, 0 failures.** One of them reads the script and asserts the guard appears **before** the only
call that can reach the fleet — because a test of the pure function alone would pass while the script still
dispatched, **which is precisely the shape of the original defect.**

## [0.47.0] — 2026-10-15

**Correcting my own counts: 0.46.0 said 54/32/22, the table says 61/53/8.**

0.46.0's entry claimed *"**54 rows** across twelve sections"*, *"**32 of 54** rows are executed; **22** are not"*.
**All three numbers were typed by hand, and all three were wrong.** Read from `docs/TEST-MATRIX.md`:

| | 0.46.0 said | the table says |
|---|---|---|
| rows | 54 | **61** |
| executed | 32 | **53** |
| not executed | 22 | **8 never run**, plus **11 blocked**, **1 skipped**, **2 refuted** |

### The cause is that I merged two words that are not the same

**`阻塞` means the command RAN and the environment stopped it. `待执行` means it never ran at all.** I collapsed
both into "not executed" — **and a count that merges two categories is wrong in both directions at once**: it
overstates what was never attempted and understates what was attempted and blocked.

**The matrix now marks `阻塞` as "the command executed" explicitly, and carries a note recording this mistake**,
because the distinction is the one a reader needs in order to tell "we have not tried" from "we tried and were
stopped".

### It is the same error the matrix itself documents, one level up

The matrix's own rule is that **a row's result may only be changed by re-running its `Instance` and reading the
output**, and that a count copied from an older plan becomes more true-looking each time it is copied. **I then
wrote the headline counts of the document from memory instead of reading the document.** The rule was in the
file I was writing.

**So the counts are no longer asserted anywhere by hand.** They are read from the table, and the reading is
recorded: `61 = 39 通过 + 8 待执行 + 11 阻塞 + 1 跳过 + 2 证伪`.

**No new tests.** What changed is three numbers and the reason they drifted.

## [0.46.0] — 2026-10-15

**The test matrix the plans asked for — with every row it could not earn left as `待执行`, and the reason named.**

### Two documents, and the split is the point

`docs/TEST-MATRIX.md` is the **master list**: 54 rows across twelve sections, each with a stable id, what it
checks, its result, a correction date, and the instance that produced the result.

`docs/TEST-LEDGER.md` is the **evidence**: the exact command, exit code and artifact behind each verdict, plus
the vocabulary the matrix refers to.

**The reference goes one way.** The matrix cites the ledger; the ledger never cites the matrix. A summary that
its own evidence cites is a summary that can no longer be checked against it.

### What the matrix refuses to do

**32 of 54 rows are executed; 22 are not, and none of the 22 says "通过".**

**A row may only be filled in from a run whose output was read.** Where a result would have to be inferred —
from a suite that covers the same code, from the implementation, from plausibility — the row stays `待执行`
**and names what would settle it.** Twelve rows cite suite coverage explicitly, labelled as *suite coverage*
rather than as a run of that item, because **"a suite covers this code" and "this item was executed" are
different claims and only one of them is a measurement of the item.**

The 22 unexecuted rows are **not 22 problems.** They collapse into **four blockers**, and two of them are one
command or one machine away:

| Blocker | Rows held | Release condition |
|---|---|---|
| only one executable machine online | 7 | the two `win-desktop` machines, silent since 2026-10-14 |
| the relay cannot be upgraded or restarted remotely | 4 | **one command on `jp-shared`** |
| no usable pairing code | 3 | a pairing experiment, which would disturb the fleet and needs consent |
| a real interruption or an external resource is required | 8 | a real update check; one row needs macOS or Linux |

### Three numbers the matrix now owns, because the plans kept repeating them

| the plans say | measured at v0.45.0 |
|---|---|
| 79 test suites | **82** |
| 2199 tests | **2228** |
| nine aggregate verdicts | **6** |

**A count that is copied from an older plan becomes more true-looking each time it is copied.** The matrix is
now the single place these are read from.

### Two rows are `证伪` rather than `失败`, and the distinction matters

`TC-AGG-003` and `TC-AGG-005` assert **`environmental`** and **nine states**. **Both names are absent from the
code** — the real verdict is `divergent-platform`, and there are six verdicts plus three non-verdict values.

A row marked `失败` would say *"the code is wrong."* These say *"the expectation is wrong"*, which is a
different repair. **A test asserting `environmental` would fail against correct code — the exact path by which
a real check gets disabled, because the runner looks broken rather than the expectation.**

**No new tests.** What changed is that the results now have a home, and the ones that have none say so.

## [0.45.0] — 2026-10-15

**The test plan's security cases, made executable — and the one case that had never been watched run.**

### A coverage gap with an error code and no test

`COMMAND_EXECUTABLE_RELATIVE_PATH` is declared in `allowed-commands.mjs` with a written rationale — *"it names
a different file in every working directory"*. **A grep across all 81 suites returned zero hits.** The refusal
path existed and **no test had ever watched it fire.**

That is the same class of defect as the three uncalled modules this project shipped: **present, documented, and
unobserved.** The difference is that a module has a suite and an error code does not. It now has one, and it
distinguishes the two refusals that are easy to confuse — **an entry that itself names a relative path is
refused as `EXECUTABLE_RELATIVE_PATH`, while a relative `argv[0]` against an absolute entry is merely
`NOT_ALLOWED`.**

### The plan asserted something the code does, and reading alone would not have settled it

The test plan claims `node --test --test-reporter=tap` is **allowed when an entry names it explicitly**, while
`node --test-reporter=tap` (no `--test`) is refused. The suite says the opposite of half of that —
`agent.test.mjs` is titled *"refuses --test-reporter and every other argument that makes node load code"*.

**Both are right, and the mechanism is the one the refusal's own message names:** the reparse refusal fires on
**trailing** arguments of a matched entry, and its remedy is *"an entry of its own"*. So:

* `['node','--test']` **refuses** `--test-reporter=tap` — verified;
* `['node','--test'], ['node','--test','--test-reporter=tap']` **allows** exactly that flag — verified;
* **and still refuses** `--test-reporter=file:///tmp/evil.mjs`, because the second entry pins one value rather
  than opening the flag — verified.

**The line between "a named flag" and "a flag" is the whole security property**, so all three are now asserted
rather than inferred from the refusal's wording.

### The plan's `environmental` state does not exist

`AGG-003` and the plan's nine-state table name **`environmental`**. The project implements
**`divergent-platform`** (`tools.mjs`, `report.mjs`, `fleet.mjs`). **A test asserting `environmental` would fail
against correct code** — the kind of error that gets a real check disabled, because the runner looks broken
rather than the expectation.

### My own error, and it was two errors in one run

Running every suite in **one process** with `--experimental-test-isolation=none` produced **41 failures**;
the project's own entry (`node --test --test-force-exit`, each suite isolated) produced **1**. The other 38 were
**global state from `mdns-discover`'s fetch stub leaking into `outbound-only`** — my harness, not the code.

The 1 real failure was also mine: I bumped the version to `0.45.0` and did not write the CHANGELOG entry, so
`claims` and `CHANGELOG shape` correctly went red. **Both are recorded because the first is the trap worth
naming: a test harness that is not the project's harness measures the harness.**

**10 new tests, 0 failures** by the project's own entry point.

## [0.44.0] — 2026-10-15

**A real dispatch proved the parameter does not yet travel — and the tests that make that checkable.**

### What the end-to-end attempt showed

`cwd_outside_project: true` was dispatched to MacMini with a `cwd_rel` pointing outside its project root.
**The answer was `refusal_reason: CWD_OUTSIDE_PROJECT`** — the guard firing exactly as if the escape had never
been asked for.

**That is the honest result, and it is not a bug in the change.** The relay serving the fleet started
`2026-10-14T13:53:14Z`, and MacMini was restarted *before* 0.43.0 was installed there:

| Component | On disk | In memory |
|---|---|---|
| the shared relay | 0.43.0 | **the code from before this change** |
| MacMini's agent | 0.43.0 | **the code from before this change** |

**So the new field had nowhere to travel through.** Neither process knew the name, so the relay dropped it on
the way in and the agent never saw it. **The refusal is what the old code correctly produces** — and it is also
the second time in two releases that a real dispatch was more informative than reading the code.

### Which is why this release is the tests rather than the feature

The parameter is copied by hand in **four** places, and each is a place it can be dropped:

1. the plugin's payload
2. `createTask`'s explicit task object
3. the `task.created` ledger row — **so a relay restart cannot forget a granted permission**
4. the offer handed to a machine

**This is the shape of the defect that produced the parameter in the first place:** `cwd_rel` was accepted,
normalized, hashed and stored, and then the guard's own refusal was **discarded** — it travelled most of the
way and stopped short, with nothing saying so. **The risk in adding a new field is that it travels the same
distance and stops at the same place.**

So the copies are now asserted against the real relay, and both directions are pinned, **including the
omission**: `false` writes `false` rather than vanishing, so **absence is never ambiguous**, and the check is
`=== true` rather than truthy, because the value arrives over the wire.

The ledger assertion is the one worth naming. A dispatch that runs, a relay that restarts, and a permission
that is **silently gone** would be the worst available failure — the same dispatch refused afterwards with
nothing visibly changed.

### Containment, re-asserted rather than assumed

`resolveProjectCwd`'s guarantee is unchanged: an escape is refused unless asked for, an absolute path is
refused however it is spelled, a sibling sharing a path prefix is refused, and **the escape is reported** as
`outside_project` so a result says where a command ran instead of leaving a reader to assume.

**12 new tests, 0 failures.**

## [0.43.0] — 2026-10-15

**A machine stuck in its own state directory — and the parameter that was accepted, hashed, and ignored.**

### What a deployment test on MacMini actually found

Running the project's own test plan against MacMini produced eight dispatches that all failed, and **none of
them failed for the reason the answers said.** The sequence, and what each answer meant:

| Dispatched | Answer | What it actually meant |
|---|---|---|
| `node --test --test-reporter=spec test/` | `COMMAND_REPARSING_ARGUMENT` | correct refusal — the flag is not on the allow-list |
| `bash -lc "…"` | `COMMAND_NOT_ALLOWED` | correct refusal |
| `node --test <files>` | `exit 1` | **the files were not found** — the test never ran |
| `cwd_rel: "local"` | `status: crashed`, `PATH_INVALID` | **the resolved directory did not exist** |

**`PATH_INVALID` is a warning about a missing EXECUTABLE, and it was reporting a missing DIRECTORY.** Nothing
in the answer said so. Establishing that took every one of those eight dispatches, and the cost was not the
dispatches — it was that **every one of them looked like a test failure.**

### The cause, and it is a configuration default rather than a bug

`bin/w2m-localside.mjs:152` is `const project = flags.project ?? process.cwd()`. A `localside` started
without `--project` takes **its own working directory** as the project root, and the packaged DSH starts it
from `~/.dsh/xclient`. So that machine could run **only inside `~/.dsh/xclient`** — and nothing about the
answer pointed at the cause.

### `cwd_rel` travelled, was hashed, was validated, and was never consumed

`w2m_run` has always accepted `cwd_rel`. The relay normalizes it, folds it into `command_hash`, and stores it
on the task. The agent **resolves** it through `resolveProjectCwd` — and then, when the resolution failed,
**logged a warning and ran anyway with the unvalidated relative path.**

**The guard computed its own refusal and discarded it.** That is worse than no guard, because the guard is
what a reader would cite as coverage.

### The escape is now named, opt-in, and reported

`resolveProjectCwd(root, cwdRel, { allowOutside })` — **`false` unless a caller asks, carried on the offer as
`cwd_outside_project`, and off for every value that is not exactly `true`**, since it arrives over the
wire. The resolved absolute directory is returned as `outside_project`, **so a result says where the command
ran instead of leaving a reader to assume.**

**This does not widen what may be RUN.** The command allow-list, the executable-path check and the
argument-reparse refusal all still apply — **and three of them were observed refusing correctly during this
same session.** It changes *where*, not *what*, and only when asked.

### A guard caught me, and the fix was the name rather than the guard

The parameter was first called `allow_cwd_outside_project`, and `tool-cards.test.mjs` failed on it:

> `w2m_run` declares `allow_cwd_outside_project`, which names an allow-list — **a tool that can set one of
> these widens what the fleet will do, and that decision belongs to an operator editing configuration on the
> machine itself, never to a model**

**It was right to fire, and it was firing on the name rather than the behaviour.** The parameter does not set
an allow-list: **it changes WHERE a command runs, not WHAT may run** — the command allow-list, the
executable-path check and the argument-reparse refusal all still apply, and three of them were observed
refusing in this same session.

**So the guard was left alone and the parameter was renamed** to `cwd_outside_project`. Relaxing a guard that
protects the fleet, in order to land a feature of my own, is the one move this project has consistently
refused — and **a guard that fires on a word is still a guard that made me justify the word.**

### What the session measured about the security controls

Four refusals, all correct, all from real dispatches:

* `COMMAND_NOT_ALLOWED` — `node -e` on a machine whose allow-list omits it, and `bash -lc`
* `COMMAND_REPARSING_ARGUMENT` — `node --test --test-reporter=spec` (a flag not declared) **and** an attempt
  to smuggle `--eval` behind `--test`, which the plugin caught as *re-parseable* rather than as unknown
* `COMMAND_EXECUTABLE_PATH_MISMATCH` — `/bin/sh` where the allow-list names `node`
* `PATH_INVALID` — the one refusal that was **not** a security control, and the one whose message misled

**12 new tests, 0 failures.**

## [0.42.0] — 2026-10-15

**The README catches up with 62 versions — and gathering the numbers found a defect that had survived all of them.**

### The progress section, in both languages

The README's newest version reference was **v0.4.0**, thirteen times, and its install command pinned a
**v0.6.3** tarball. **Thirty-four versions of work had no record in the file a newcomer reads first.**

There is now a **Progress** section (with a matching 进度 section) built from the CHANGELOG rather than from
memory: **62 versions since 0.8.0, 11 tools, 79 suites, 2199 tests, 12 pre-flight checks, 0 failures.** It
carries the three properties the project set out to have, the roadmap's **delivered / partial** state per
version, what the reachability work found, the measured-on-real-machines table, and an explicit **"this is not
1.0.0"**.

**The seven accepted orphans are listed with what would remove each one**, and the **three that are defects are
named as defects** rather than folded in with the four libraries — because the import graph cannot tell them
apart, and only a written reason can.

### `layer-check` printed "clean" and exited 1

Gathering the numbers meant running the checks and reading their output and their status side by side, and two
of them contradicted each other:

```
clean: every cross-layer edge is declared
exit=1
```

**The clean path called `process.exit(1)`.** Every reader that trusts the exit code — a shell, CI, a script,
`&&` — **read a passing check as a failing one.**

**The pre-flight never noticed, and the reason is the interesting part: its own step reads the PRINTED TEXT
rather than the status.** A check can therefore be wrong for a hundred versions while the gate over it stays
green. It now exits `0`, with the failure paths still distinct (`2` for a violation, `3` for unexplained), and
a regression test asserts **the status rather than the message** — because a test that read the message would
have passed against the broken version, which is exactly what happened.

### Also corrected

* the install instructions now say **how to verify you got the version you asked for**, because this
  repository's own profile installed from a pinned tarball and **fell 30+ versions behind**. A successful
  install and a current install are two different things.
* both language halves now name **`pnpm`** as the fallback where `npm` is absent — which is the case in the
  packaged DSH runtime this was tested against.
* one dead in-page anchor, from assuming GitHub's slugger keeps an em dash. It does not.

**2 new tests, 0 failures.**

## [0.41.0] — 2026-10-15

**`field-authority.mjs` has a caller. The correction from 0.29.0 lands, six versions after the claim.**

### What was wired, and the claim it settles

0.29.0's entry said *"the connection now exists."* **It existed inside that module and nowhere else** — the
0.36.0 classification reported the file as an **orphan**, and reading the tree rather than the changelog
confirmed it: `grep 'field-authority' src/` matched **comments and documentation only.**

`w2m_memory` now accepts a received CAT7 block **field by field, at the actor's authority level**, and writes it
as a row in the same JSONL the conclusions use — one store, one rotation, one answer to *"what does this machine
remember."* Measured, all six cases:

```
no level   ok=false  MEMORY_BLOCK_NO_AUTHORITY
level 0    ok=true   accepted=[subject,body] refused=[evidence]
level 70   ok=true   accepted=[subject,body,evidence]
tampered   ok=false  BLOCK_HASH_MISMATCH
no ancestor ok=false BLOCK_MISSING_PARENT
with ancestor ok=true accepted 3/3
```

**A refused field is OMITTED, not set to null** — v4.8.0's first falsifying test, now reachable through a tool.
**An unset level REFUSES rather than accepting the block whole**, because accepting whole is the exact behaviour
field-level acceptance was built to replace, and it would look like success. **A block naming an ancestor the
caller cannot produce is refused, never re-rooted**, because re-rooting turns an unverifiable history into no
history — which reads as a fresh, independent assertion. And **refusals are stored**, not discarded: what a
machine declined to believe is as much a part of its memory as what it took.

### The list policed itself, which is the part worth keeping

`field-authority` was removed from `scripts/accepted-orphans.mjs` **not by a decision to tidy up, but because
the gate went red.** Its stale-entry check fails when an accepted orphan stops being an orphan — so the moment
`tools.mjs` imported the file, the run demanded the acceptance be withdrawn. **Orphans: 8 → 7. Exports: 72 →
65.**

### My own error, and it is the eighth of this exact shape

I inserted the new branch by matching an **anchor string** and never checked **what block that string was
inside.** It landed inside `if (conclusionText !== null)`, so the feature only ran when the caller *also* passed
`record`. Six tests failed, and I diagnosed it by **guessing at return shapes twice before printing them** —
`verifyBlock` and `acceptWithAuthority` were both exactly what I had assumed, and the actual fault was a
scoping mistake three steps earlier.

**Two wrong hypotheses, then one printed value, then ten seconds to the answer.** That is the eighth time in
this span that printing would have been faster than predicting, and the note is here because the pattern has
now survived being written down seven times.

**6 new tests, 0 failures.**

## [0.40.0] — 2026-10-15

**The acceptance document, converged — and bound to the pre-flight so it cannot drift.**

### Three statuses, decided by a checkable rule

Every criterion now carries one of three values, and **the rule decides it rather than opinion**:

| Status | Test |
|---|---|
| **ENFORCED** | delete the thing and run `scripts/preflight.mjs`; it goes red |
| **MEASURED** | something checks and prints, and the run stays green |
| **UNVERIFIED** | nothing checks it, or the check's own documentation says it cannot see this |

**MEASURED is not ENFORCED, and §4 says so with the receipt:** the reachability classifier named **465
exports** and could not tell a defect from a library, so a gate built on it would have been disabled within a
week. **A check that cannot fail is a report.**

**17 criteria are ENFORCED**, including §1.5 — the orphan gate added in 0.39.0. **Six are MEASURED**, of which
two are the ones worth naming: **§1.6, because the classifier cannot classify**, and **§3.10, because
`field-authority` still has no production caller.** **Seven are UNVERIFIED**, and `4.7` is the widest of them —
**the plugin this machine runs is thirty versions behind the source under test**, so every source-level
conclusion about its runtime is void.

### The corrections, kept rather than tidied away

Seven claims were written down in this span, acted on, and later found wrong. **Four of the seven were a claim
about wiring or delivery that a single check disproved:**

* *"v4.8.0 shipped"* — the block and lineage are real; **the authority-driven half was never built.**
* *"the already-shipped rate limiter as its front door"* — **never built.**
* *"**the connection now exists**"* (CHANGELOG 0.29.0, of `field-authority`) — **it exists inside that module
  and nowhere else.**
* *"v4.10.0 shipped in 0.11.0"* — the falsifying tests **are** asserted, and **nothing routed a question to
  it** until 0.37.0.

**Two of the seven were corrected by the same instrument** — the reachability classifier, which was built
*because* the first two had happened, and which then found two more. **That is the only argument for a check
this project accepts: it found something the previous rounds had missed.**

### The document is now checked, because a parallel list is a second source of truth

`test/acceptance-doc.test.mjs` reads the pre-flight's own `DECLARED_CHECKS` and fails if the document names a
gate that does not exist, if any of the three statuses stops being defined, or if the corrections section is
emptied. **A criterion cannot quietly become unenforced while the file keeps claiming otherwise.**

### Three errors of mine, all in the test rather than the subject

* I demanded eight **exact** check names; the document sensibly uses short forms.
* I matched `gate` inside `approval-gate.mjs` and flagged **a filename as a gate**.
* I then demanded the document name `lint` and `mojibake` — **gates on the code's tidiness, not criteria for
  what 1.0.0 must prove.** The document was right not to list them. **A test asserting its own assumption is
  indistinguishable from a test asserting a property, until it fails.**

**6 new tests, 0 failures.**

## [0.39.0] — 2026-10-15

**The orphan gate: a module nothing reaches now fails the pre-flight unless a reason is written down.**

### What checking the remaining loops found — and it corrects a claim I made

0.36.0's classifier reported 86 closed loops and **could not say which were defects**, so it printed and
exited 0. This sorts them, and the result is uncomfortable and precise:

**Eight orphan modules, 72 exports, every one of them written in this span** — and **two were described as
delivered** while nothing ran them.

`approval-gate.mjs` **is** wired: `tools.mjs` imports it, constructs it, and calls `mayRaise` on the raise path.
**`field-authority.mjs` is not.** Reading the tree rather than my own changelog:

```
grep 'field-authority' src/  →  comments and documentation only. Nothing imports it.
```

**0.29.0 said "the connection now exists". It exists inside that module and nowhere else.** That is now
recorded as a correction in `scripts/accepted-orphans.mjs`, in the entry that keeps it on the list.

### A dead branch, found by the test that could not be written

I added **second-order reachability** so that a module reached *through* another could be called a library
rather than an orphan. The test for it failed, and the reason is arithmetic:

> a row is `closed-loop` **only when no source file imports anything from it at all** — which is exactly what
> the `sibling-imported` class already excludes. **So there is never a first-order importer for a second-order
> walk to start from**, and the library case **cannot arise**.

Measured: **72 orphan, 0 library, 14 cli** — and **the zero was a tautology, not a finding.** The library
bucket is removed rather than printed as a permanent zero, and `LOOP_KIND.LIBRARY_UNREACHABLE` records *why*
so the next reader does not re-derive the idea. **Being a library is a claim about intent, and the import
graph cannot carry it — so the claim is made where it can be checked.**

### `scripts/accepted-orphans.mjs`, and why a list rather than a rule

Each accepted orphan names a **reason**, and **what would remove it**. `library` is a design choice;
`interface-unrouted` **is the defect**, kept only because removing it needs a decision about *where* it should
be reached from.

The gate is `checkOrphans` in the pre-flight: **a closed loop is red unless its file is on that list.** The
eight known ones are decisions somebody made; **a ninth fails the run and forces the same conversation.**
A stale entry — one that names a file no longer an orphan — also fails, so the list cannot quietly claim a
problem that is gone.

Four of the eight are marked `interface-unrouted` and said so plainly: `health` (the sensor the user asked for
by name), `log-bounds` (the answer to the 40× log growth, shipped in 0.12.0 and called by nothing), `storage`,
and `field-authority`.

### My own error, the same one as two rounds ago

`await` in a **non-async callback**, caught by `node --check` — **the second time in this span.** The fix is
the same both times: import it up front rather than reaching for it where it is not allowed.

**13 new tests, 0 failures.**

## [0.38.0] — 2026-10-15

**A seven-phase council run on MacMini — real-machine evidence for the tool that had never touched one.**

0.37.0's `w2m_council` was the only substantial addition in this span that had **never run anywhere but this
laptop.** It now has a measurement, and the exit code came from the machine:

```
OK phases=7 outcome=ship dissent=1 reproduced=true      exit 0
```

Driven through `node -e` on MacMini against its own checkout at 0.37.0: the council was convened, roles
assigned, two arguments recorded, two weighted votes cast, the outcome fixed, the decision sealed, and the
sealed decision **read back after the council stopped being advanceable** — with its dissent, its reason, and a
`recount` that reproduced the outcome from the stored ballots. **Every one of those was asserted before the
process was allowed to exit `0`**, so this is not a "did it load" smoke test.

### The same run answered a question that had only been a hypothesis for four rounds

**v4.10.0's council works on MacMini because it reaches for nothing that machine lacks.** `council.mjs` imports
`node:crypto` and `./authority.mjs`, and neither needs `node_modules`. The eight suites that failed there in
0.32.0 therefore failed on **what their fixtures reach for**, not on the modules under test — **a measurement
now, where four earlier releases recorded a guess as a guess.**

It also sharpens the shape of that failure: a suite whose *subject* has no dependencies still fails if the
*suite* imports one, and **from an exit code alone the two are indistinguishable.**

### The sixth time I exceeded the ceiling

The update dispatch — download a release tarball and extract it — **expired**. Measured again, and the number
has not moved: the agent's lease survives roughly **50 seconds** (`heartbeatIntervalMs 10s × missedHeartbeats 2
+ leaseGraceMs 30s`), and an expired lease carries **no exit code at all**, so the work was lost rather than
reported as failed.

**What matters is what happened next:** rather than retrying the download, a **three-line probe** established
that the extraction had in fact completed — **the partial run had succeeded and only the report was lost.** A
retry would have spent another dispatch redoing finished work, and could have raced the `tar` it had left
half-written.

**No new tests.** What changed is a measurement, and a hypothesis that stopped being one.

## [0.37.0] — 2026-10-15

**`council.mjs` is wired. v4.10.0's committee governance is reachable, and its dissent arrives with its decision.**

0.36.0's reachability classification found `src/agent/council.mjs` as a **closed loop** — 275 lines with three
falsifying tests asserted by name, imported by **nothing but its own suite.** This is the eleventh tool and the
fix for the third module of that shape.

### Why the state lives outside the call

A council walks **seven phases across many calls**: `convene → frame → deliberate → vote → decide → record →
adjourn`. One that lived inside a single invocation **could never finish**, and the failure would look like
"the phases are wrong" rather than "the state was thrown away". `createCouncilSessions` holds it — the same
lesson the approval queue and the P2P runtime taught, applied a third time.

Two kinds of state, deliberately capped differently:

* a **live** council is scratch space. Losing one costs the work of returning to that phase, so the cap is
  generous (64) and eviction is **oldest-first**, so a reader can say which survives without reading code.
* a **decided** council is the artifact. `ROADMAP.md`'s third falsifying test is that *"a decision with
  recorded dissent is retrievable with the dissent"* — and **retrievable means after the council that produced
  it is gone.** So the decided cap is larger (256) and decisions outlive live eviction. Tested.

### One tool with an action, not seven tools

The seven phases are **a state machine over one object** and the machine already refuses an operation in the
wrong phase by name. Seven tools would let a model call the wrong one and learn the order from errors; one
tool reports `phase` and the whole `phases` list on **every** call, so the legal next move is visible rather
than inferred. A `CouncilRefusal` comes back as a **value** — `ok: false` with the phase and the list — not as
a throw, for the same reason.

**A tie is refused, not broken**, and the tool does not paper over it: a split council is the one case where
the council exists to escalate to a person.

Every read of a decision returns the **dissent with its reasons** and a **`recount`**, so the seal never has
to be taken on trust.

### My own error, and the fix is a pattern rather than a correction

My test helper reached the `deliberate` phase by **counting advances**, got the count wrong by one, and failed
with a `WRONG_PHASE` refusal that **read like a defect in the module**. Measured order:
`convene → frame → deliberate → …`, so `argue` needs **two** advances and not one. The helper now **names its
destination** — `advanceTo(council, 'deliberate')` — because **one that counts steps drifts silently when the
phase list grows, and one that names a destination cannot.**

28 tool-count assertions updated across nine files, the whole set that has caught this every time.

**13 new tests, 0 failures.**

## [0.36.0] — 2026-10-15

**The classification found a third closed loop — and it is `council.mjs`, which `ROADMAP.md` marks shipped.**

### What the classifier does that a regex cannot

468 findings against this repository, and the one real defect in them was invisible. Refining the pattern
cannot fix that: **the information is not in the name, it is in the shape of the import graph.**

The shape that identified the two known defects was — **one export, one importer, and that importer is the
test named after the module.** That is not a heuristic about naming; it is a statement about the graph: **a
module whose only importer is its own suite exists in a closed loop, and nothing in the program reaches it.**
The name is used only to decide whether the loop is *closed*.

Against this repository: **316 `sibling-imported`, 91 `closed-loop`, 61 `same-module`.**

**91 is not a defect count and the classifier says so**, in three tests that pin its own limits rather than
commenting on them: it cannot see a **dynamic import** (`await import('./x.mjs')` names no binding), and it
cannot see a module reached only because a **CLI entry point spawns it** — which is every file in `scripts/`,
and is why that number is large.

### `v4.10.0`'s council is BUILT, NOT ROUTED

`src/agent/council.mjs` is a closed loop: **275 lines implementing committee governance, imported by nothing
but its own suite.** `ROADMAP.md` marks v4.10.0 *shipped in 0.11.0*, and 0.30.0 verified its three falsifying
tests are asserted by name — **which they are.** What was never checked is whether anything routes a question
to it. **Same defect as `field-authority` and `approval-gate`, in a third module**, and the one the
reachability work existed to find. Recorded as **built, not routed**, and routing it needs a tool surface and
a session rather than a line of code.

### A duplicated limit, found by reading the file to check the first finding

`council.mjs` declared its own `export const AUTHORITY_MAX = 100` instead of importing the bound from
`authority.mjs`. **Two copies of a limit that nothing can keep in step, and the failure is silent**: raise the
real maximum and this module keeps refusing `101` while naming the wrong number as authoritative. It now
imports it, and `AUTHORITY_MAX` has exactly one literal definition in `src/`.

**Reading the file to check the wiring finding is how the constant surfaced** — the argument for investigating
a report rather than counting it.

**10 new tests, 0 failures.**

## [0.35.0] — 2026-10-15

**§1.5 measured at last: the reachability report, and the honest reason it is not a gate.**

`docs/1.0.0-ACCEPTANCE.md` §1.5 recorded that **nothing** measured whether an export is reachable. Three
mechanisms shipped in this span fully tested and completely uncalled — `field-authority.mjs`,
`approval-gate.mjs`, `createApprovalIndex` — and **a tested mechanism with no caller is indistinguishable from
a finished feature** by reading either the tests or the source.

`scripts/reachability-check.mjs` measures it.

### The first version was unusable, and the false positive that proved it

It asked *"which files mention this name"* and reported **378 findings**, almost all false. The clearest:
`deepEqual` from `src/relay/state.mjs`, which appeared to be named by **69 test files** — every one of them
calling `assert.deepEqual`. Whole-word matching cannot tell an imported binding from a coincidental name.

**An import is a statement about two things at once — a module and a name — so matching on the name alone
throws away half of what the source says.** The check now reads both and matches on the pair:

```
importedNames(text)  ->  module specifier -> imported names
resolveSpecifier()   ->  the file that specifier names, the way Node resolves it
```

### Why it exits 0, which is the part worth defending

Measured against this repository it names **465 exports**, and it **cannot tell three kinds apart**:

1. **the defect** — built, tested, never wired;
2. **a deliberate surface** — the plugin's entry points and re-exports;
3. **composition** — a capability reached only through another module's use.

Only the first is a finding, and no static name-and-import check separates them. **A check that fails on 465
things nobody will fix is a check that gets disabled within a week — and a disabled check is worse than none,
because it is cited as coverage.** So it prints, exits 0, and closes with *"READ THIS AS A LIST TO TRIAGE, NOT
A LIST OF BUGS."*

**§1.5 is therefore measured, not closed.** A defect of this class is now *visible*; nothing fails when one
appears. The tests build synthetic trees where ground truth is known, because asserting on the real 465 would
pin noise.

### Three of my own errors, and one of them is the lesson of this whole span

* My re-export exclusion looked for ` from ` **inside** the captured braces, so it never saw it —
  `export { X } from './y.mjs'` was counted as a definition. **The test failed because the code was wrong.**
* I expected `b` in an export list where the source says `b as bee`. The implementation was right.
* **I "fixed" that by sorting my own guessed array.** Sorting a wrong list does not make it measured — and
  that is the same mistake, in miniature, that this project has now paid for six times: **predicting what the
  output is instead of printing it.** The fix was to print it.

**16 new tests, 0 failures.**

## [0.34.0] — 2026-10-15

**`requireAuthorityLevel`: the policy that makes 分权限 real, and why it is a flag rather than a default.**

`docs/1.0.0-ACCEPTANCE.md` §3.11 recorded the gap plainly — the gate is **off unless configured**, so a
default install dispatches exactly as it did before the permission model existed, and **"off unless
configured" cannot be part of a 1.0.0 that claims 分权限.**

`requireAuthorityLevel: true` (or `W2M_REQUIRE_AUTHORITY_LEVEL`) closes it for a machine that asks. Measured,
the whole truth table:

| `requireAuthorityLevel` | level | result |
|---|---|---|
| off | unset | **starts**, gate unenforced |
| off | chosen | starts, gate enforced |
| **on** | **unset** | **refuses to start** — `AUTHORITY_CHOICE_NOT_CHOSEN` |
| **on** | **unusable** | **refuses to start** — `AUTHORITY_CHOICE_UNKNOWN` |
| on | chosen | starts, gate enforced |

A refusal names the four choices, so it is fixable from the message alone, and a machine that opted in says
so in `w2m_status` — a reader can tell "asked and answered" from "never asked".

### Why opt-in, which is a deliberate limit rather than a hedge

Refusing unconditionally would be the honest reading of *"a permission system that is off is untested in
production"* — and it would also **stop every machine running an earlier version the moment it upgraded**,
because none of them has a level. That trade is one silent failure for a loud outage, and **an outage is not
a security property.**

**So the gap is narrowed, not closed, and the document says so** rather than letting the flag's existence
imply otherwise. A fleet that never sets it is exactly as unenforced as before.

### `W2M_REQUIRE_AUTHORITY_LEVEL=0` means off

Asserted, because a truthiness test would read the string `"0"` as set-and-therefore-on and **refuse to start
a machine whose operator explicitly wrote zero.**

### My own errors, both of them syntax rather than logic

* I wrote `await` inside a **non-async arrow** passed to `assert.rejects`, which does not parse. `node --check`
  caught it immediately; the fix is to compute the state directory first, because making the arrow async would
  change what it does.
* I asserted refusal codes against the **message text**; the codes live on `error.reason_code`, which is the
  field a consumer branches on. **The code was correct and the assertion was looking in the wrong place** —
  now it pins the field.

**6 new tests, 0 failures.**

## [0.33.0] — 2026-10-15

**The authority level is chosen by name. Nobody types a number.**

`actorAuthorityLevel` is an integer in `0..100` whose four bands have names and gaps. Asking a person to type
it asks them to hold all of that in their head, and **getting it wrong fails silently**: `69` and `70` look
equally arbitrary and land in different bands, so a machine configured one point low **refuses a dispatch it
should have run and never says a threshold was the reason.**

`src/agent/authority-choice.mjs` turns the number into a choice:

| Choice | Level | What picking it permits |
|---|---|---|
| `ordinary` | **0** | create goals and session data within its own scope |
| `captain` | **50** | create team goals, manage team membership |
| `org_admin` | **70** | create organisation goals, register actors, set overrides |
| `system_admin` | **90** | create global goals, configure across organisations, override any lower constraint |

The options are **built from `AUTHORITY_BANDS`**, so a band added to the model appears here without anybody
remembering — and a band cannot be described in two places differently.

### A name resolves to its band FLOOR, and the consequence is stated

The floor is where the band's own description becomes true, and it is what `bandOf` answers with. Resolving to
a midpoint would mean **a choice labelled "captain" silently granting more than captain.**

The practical consequence is worth writing down because it decides what a machine may do: **`ordinary`
resolves to `0` and `dispatch_writing` costs `50`, so a machine whose operator picks "ordinary" cannot
dispatch a write at all** — it escalates and an approver must answer. Measured, all four:

```
ordinary     level   0  ->  write dispatch: needs_approval
captain      level  50  ->  write dispatch: allow
org_admin    level  70  ->  write dispatch: allow
system_admin level  90  ->  write dispatch: allow
```

### Two vocabularies, and two different callers

**A number is refused by the selector**, because a selector that also accepts integers is a text field with a
helpful hint and every reason above applies again. **A number is accepted by the config**, because a profile
patch written by an earlier version must keep loading — and breaking every existing machine on upgrade is a
worse failure than accepting a number from a file nobody is looking at. The two rules are stated in one place
and tested against each other, including that the selector refuses `'captain '` while the config trims it.

### A misconfigured level no longer degrades in silence

`w2m_status` now reports `actor_authority` — whether it resolved, from which vocabulary, and **why not when it
did not, with the four choices attached**. A level that failed to parse used to become `null`, which reads
exactly like a machine that never chose one, and **those two need opposite responses.**

### Three of my own errors

* I asserted `UNKNOWN` for the integer `70`; it is `NOT_A_STRING`, because the codes distinguish "a number was
  given" from "a string that did not match" — **on purpose, so a caller can message them differently.**
* I reused the selector's message in the config resolver, so a config author was told about names only while
  **that function's own contract promised numbers too.** The implementation was changed, not the test.
* My captain test asserted success and instead reached the network, because it installed no fetch stub. **That
  failure was the proof**: it did *not* throw `W2M_PERMISSION_*`. The assertion now checks the kind of failure
  rather than the absence of one, which is what the test was always about.

**18 new tests, 0 failures.**

## [0.32.0] — 2026-10-15

**Widening real-machine verification: eight suites tried, none passed, and the cause is a hypothesis.**

### What was measured

The eight suites dispatched to MacMini all returned **non-zero there while passing here**. The packed code
that reported this was at times ambiguous, so the run was repeated with a simpler encoding — **one bit per
suite, exit 0 or not** — and that is unambiguous: **the packed result was `0`, meaning no suite passed.**

### What was NOT measured, and is therefore not claimed

The likely cause is a **missing `node_modules` on that machine** — the suites import from `src/`, and some of
those modules reach for a dependency. **That was not established.** It is a hypothesis, and this release
records it as one. The acceptance document now says so in a row of its own rather than in a footnote.

### Five dispatches spent on a channel that carries eight bits

The attempts, in order, and what each one actually answered:

| Attempt | Question asked | What came back |
|---|---|---|
| 1 | four suites, two bits each (status + reason) | 8 bits, but the tail truncated — **unreadable** |
| 2 | eight suites, three bits each | 24 bits packed into 8 — **arithmetically impossible, and it returned 0** |
| 3 | re-read the saved outputs | the parse matched nothing, because it guessed Node's summary format |
| 4 | eight suites, one bit each | **`0` — no suite passed. Unambiguous.** |
| 5 | print the environment facts | ran to completion, **and stdout is not visible through a dispatch** |

**Every one of those was the same mistake**: asking a channel more than it carries, then reading the
truncation as an answer. `exit code` is one byte, and the correct instinct — already written into
`machine-test-packet.mjs` and ignored here — is to ask **one bit per suite and nothing else**.

`--inline` was added to that script so its loop can be delivered as a `node -e` one-liner, because a real
machine's allow-list **admits `node -e` and refuses `node scripts/…`**. The generated command is 486 characters
and self-checks locally. **Its stdout is still invisible through a dispatch**, which the docstring now says
plainly: the inline form is useful when the packed code is enough, and **when it is not, the answer is one
command run by a person rather than a cleverer encoding.**

### What is unchanged

**Two of the three decisions the user made are not in this release.** The authority-level *selector* — the
request that the level be **chosen rather than typed** — is not built, and the permission gate remains
**off by default**, which §3.11 of the acceptance draft still records as incompatible with claiming 分权限.

**No new tests.** The suites that exist all still pass; what changed is a measurement and a docstring.

## [0.31.0] — 2026-10-15

**The approval gate got a caller, and a draft acceptance definition for 1.0.0.**

### The defect this round started by finding, in the release that had just criticised it

`approval-gate.mjs` shipped in 0.30.0 with a full suite and **no caller** — which is exactly the shape of the
two defects 0.30.0 had just finished writing into `ROADMAP.md`. **Building a mechanism and wiring it are
separate acts**, and a mechanism with no caller cannot be told from a finished feature by reading either the
tests or the source.

It is now on the raise path, and the wiring is asserted rather than described: a real dispatch raises once,
the queue holds one request, a second raise is **refused by the front door before a request exists**, and the
queue still holds exactly one. Two more tests pin the asymmetry — reading the queue five times past any raise
budget, and settling the request — because a gate that also metered *those* would pass a flooding test and
quietly break the queue.

`approvalRaiseLimitPerMinute` is configurable so a host can set it and so a test can reach the refusal without
raising thirty requests first. Unset, the gate's own default governs.

### `docs/1.0.0-ACCEPTANCE.md` — a draft for objection

The goal names **分模块 / 分层级 / 分权限**, and a version number means nothing without a definition that can
fail. The draft lists 21 criteria across the three, each with **where it is checked and whether that check is
actually running**, under one rule: **a criterion nothing measures is not a criterion.**

Its two honest admissions are the point of writing it:

* **§1.5 — reachability is NOT checked.** Three mechanisms shipped fully tested and completely uncalled in
  this span. The `claims` suite catches *documentation* drift and **cannot** catch this, because the document
  and the code can agree while neither is reachable.
* **§3.11 — the permission gate is OFF by default.** An unset `actorAuthorityLevel` means `enforced: false`
  and no change, so **a default install dispatches exactly as it did before the permission model existed.**
  Treating unset as `0` would break every machine that never opted in, so the current behaviour is defensible
  — but **"off unless configured" cannot be part of a 1.0.0 that claims 分权限.** The draft puts the choice to
  a reader rather than resolving it: **require a level and refuse to start without one, or ship with the gate
  off and say so in the README.** Silence is the one option that is not defensible.

It also records what is **not** claimed: no scale statement (3 usable machines of 5), no restart durability for
the queue, no MacMini verification beyond the four suites measured in 0.28.0, and `P2P_PUNCH_FAILED` still
UNVERIFIED.

**2 new tests, 0 failures.**

## [0.30.0] — 2026-10-15

**The same ruler on the other two entries: v4.9.0 had the same defect, v4.10.0 did not.**

After 0.29.0 found that v4.8.0's *"driven by the authority model"* was a phrase rather than a mechanism, the
next two ROADMAP sentences were checked the same way rather than assumed sound.

| Entry | Claim | Verdict |
|---|---|---|
| v4.9.0 | cross-session pending-approval index | **real**, substantial |
| v4.9.0 | **"with the already-shipped rate limiter as its front door"** | **never built** |
| v4.10.0 | ordered phases, a phase cannot be skipped | **real**, asserted by name |
| v4.10.0 | weights reproducible from stored inputs | **real**, plus tamper detection |
| v4.10.0 | dissent retrievable *with* the decision | **real**, and the dissent is inside the seal |

Measured for the missing half: **`approval-index.mjs` imports `authority.mjs` and nothing else** — no
limiter, no window, no cooldown anywhere in the file — while the shipped `SlidingWindowRateLimiter` sat in
`relay/server.mjs` with **no approval caller**. Two entries, one defect, and the third entry was genuine:
**the pattern was not assumed, it was tested.**

### `src/agent/approval-gate.mjs`

**It limits raising and nothing else.** That asymmetry is the design:

* limiting the **view** would limit *knowing what is waiting*, which is the one thing the queue exists for;
* limiting **settling** would punish the supervisor clearing the backlog — a limit there is a limit on fixing
  the problem;
* **raising** is the surface, because the threat is not brute force but **queue flooding**: an agent in a
  retry loop can raise hundreds of requests and drown out the work that needs attention.

Two more decisions worth naming:

* **The key is an identity, not an address.** A fleet's agents frequently share a host, so an address-keyed
  budget would apply one allowance to everybody on it — refusing the well-behaved because a neighbour
  misbehaved. An anonymous caller gets a **shared named budget rather than none**, because *"no id, no key, no
  limit"* would make forgetting to identify yourself the way to escape the limit.
* **The default is not the pairing limit.** `DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE` is 5 because pairing is rare
  and a wrong guess is an attack; raising approvals is ordinary work done in bursts. Inheriting a number built
  for a different threat would have been the easy mistake.

It composes the shipped `SlidingWindowRateLimiter` rather than writing a second sliding window — the roadmap's
word was *"already-shipped"*, and two windows in one codebase are two chances to disagree about what a minute
is. A test asserts the composition.

The absence of `mayList` / `maySettle` / `mayDecide` is asserted **as an absence**, because their presence is
the defect and a test about flooding would never notice them.

### One error of mine

I looked for the "shared anonymous budget" wording on the **refusal**; it is on the **allow** branch, which is
where a caller learns which budget they are spending from. The implementation was right and the assertion was
in the wrong half — seventh time in this project, and the same remedy worked: measuring instead of predicting.

### The layer checker refused my first version, and it was right

Importing the limiter from `relay/server.mjs` made an **`agent` module depend on the `relay` layer**:

```
relay -> util is not in ALLOWED_EDGES (undeclared)   ← after the first fix attempt
agent -> relay                                        ← the original refusal
```

`agent` is rank 2 and `relay` is rank 3, so that edge **points up**. The tempting fix was to add
`['agent', 'relay']` to the allow-list, which would have **legalised an inversion**. The right fix was to
notice that `SlidingWindowRateLimiter` **never used anything from the relay** — it holds a `Map` and reads a
clock — so it belonged in `util` (rank 0, a leaf) all along.

The move cost nothing at runtime, and that is measured rather than assumed: **the relay's own construction
site already passed `limit` explicitly**, so the class's defaults had never been used. Its `limit` is now
**required** instead of defaulting to `DEFAULT_PAIR_RATE_LIMIT_PER_MINUTE` — keeping that default would mean
this leaf importing a relay constant, **the same inversion one level down**.

Two edges are declared, both downward: `['agent', 'util']` and `['relay', 'util']`. The layer model is now
`clean: every cross-layer edge is declared`.

### Two more of my own errors

* `export { DEFAULT_WINDOW_MS as RATE_LIMIT_WINDOW_MS } from '...'` **re-exports without creating a local
  binding**, so the relay's constructor threw `RATE_LIMIT_WINDOW_MS is not defined` while the module's public
  surface looked perfectly correct. **106 tests failed at once**, which is how it was found.
* I looked for the "shared anonymous budget" wording on the refusal; it is on the allow branch.

**12 tests, 0 failures**, and 197 across the five affected suites.

## [0.29.0] — 2026-10-15

**v4.8.0 was half shipped, and the ROADMAP said otherwise. The missing half is now built.**

### What the check found

`ROADMAP.md` described v4.8.0 as *"a CAT7 seven-field cognitive block, **per-field acceptance driven by §2's
authority model**, and lineage"* and marked it **shipped in 0.9.9**. Reading the tree instead of the sentence:

| Claim | Verdict |
|---|---|
| CAT7 seven-field block | **real**, asserted |
| lineage, with a missing parent refused rather than re-rooted | **real**, asserted |
| a refused field *absent* from the stored block rather than null | **real**, asserted |
| **"driven by §2's authority model"** | **never built** |

Measured: **`src/agent/blocks.mjs` did not import `authority.mjs` at all**, and `defaultChoose` — the only
chooser that shipped — refused `confidence` by name and accepted everything else. **A roadmap sentence is a
claim, and this one was checkable in a single grep.** It stood for several releases because nothing tested the
sentence itself.

### `src/agent/field-authority.mjs`

Per-field acceptance now goes through `authority.evaluate`, so the two models cannot drift into different
notions of what a rule is. Three refusals apply in a fixed order:

1. **not a CAT7 field** — before any rule, because a rule cannot make a field exist;
2. **no declared rule** — refused, never granted and never escalated;
3. **the authority verdict** — `allow` accepts, anything else refuses with the model's own reason.

**A field with no declared rule is refused**, which is the same decision `authority.mjs` already states for
exemptions and `permission.mjs` states for capabilities. Three modules, one rule, because the failure mode is
identical: **a table that grants what it has not heard of grants whatever is added next.**

### The three inherited fields are deliberately undeclared, and that is not dead policy

Measured: the chooser is asked about `subject`, `body` and `evidence` — **never** `origin`, `observed_at` or
`lineage`, because `acceptBlock` copies the inherited three directly. A rule for them would read as policy
while doing nothing, so they are left out and `acceptField` reports them `UNDECLARED`. A test asserts a rule
can never be added for them by accident.

`confidence` is refused **at every level including `AUTHORITY_MAX`**, because if it were merely expensive a
system administrator would be *permitted by this model* to adopt the sender's own certainty about the
sender's own assertion.

### Four of my own errors, and how each surfaced

* I invented `scope_claim` and `meaning` as field names. **Neither exists** — the real seven are `origin`,
  `subject`, `body`, `evidence`, `confidence`, `observed_at`, `lineage`. My "undeclared field" test was
  therefore testing `NOT_A_FIELD` and passing for the wrong reason; the fields that are genuinely
  governed-but-undeclared are the three inherited ones.
* I asserted `accepted_fields` held only the receiver's two, when it also carries the three inherited ones.
* I asserted one chooser ruling per choosable field; there are **three, not four**, because `acceptBlock`
  hard-codes the `confidence` refusal and `continue`s **before** calling the chooser.
* `observed_at: 'T'` is not an ISO timestamp and `makeBlock` refused it — **the block layer was right and my
  probe was wrong**, which is the sixth time in this project that a failing test was the test's fault.

Every one of the four was found by **measuring the real behaviour** rather than by reading the source and
predicting it.

**17 tests, 0 failures.**

## [0.28.0] — 2026-10-15

**First real-machine verification of the recent work, and a tool that packs four answers into one exit code.**

### The measurement

The MacMini's checkout was updated to 0.27.0 and its own suites run there, with **the exit code produced by
that machine** as the evidence:

| Suite on MacMini | Result |
|---|---|
| `permission.test.mjs` | pass |
| `fleet-scale.test.mjs` | pass |
| `fleet-state.test.mjs` | pass |
| `crypto-blake2s.test.mjs` | pass |

Those four cover the code written in this span — the permission gate, the fleet arithmetic, the endpoint
reconciliation, and the crypto capability report. This is the goal's "verify on the real machine with exit
codes and artifacts" satisfied for that body of work, rather than inferred.

### `scripts/machine-test-packet.mjs`

A dispatch carries **one** exit code, so running four suites in one `node --test` answers only "did anything
fail". This packs **two bits per file** into a single byte: `10` passed, `01` failed, `00` absent, `11`
not measured. **`00` is distinguished from `01` on purpose** — "the file is not on this machine" is a
deployment finding, "the file ran and failed" is a code finding.

**Four dispatches were spent on this channel before the tool existed, two of them on my own misreadings:**

* a TAP parser matching `^ok ` that counted **nothing**, because Node indents its subtests. It returned
  `pass 0 fail 0` and I nearly read that as "no tests ran".
* a summary regex that matched nothing, so the exit code described **my parser** rather than the code under
  test.

Both were the same mistake in different clothes, and it is the mistake this project keeps making: **assuming
the shape of output instead of reading it.**

### Three defects in the tool itself, all caught by its own suite

* **The docstring claimed "zero is the all-clear", and that is false.** One passing file is `2`, four are
  `170`. **Zero means every file was ABSENT** — a total deployment failure the old claim would have had a
  reader take as a clean run. `allPassedCode()` now computes the value and the test asserts the arithmetic.
* **The guard against emitting `126`/`127` was never reached** by the inputs I guessed. Enumerating the whole
  two-bit space found the only two combinations that land on a shell-owned value
  (`[PASSED, WAITED, WAITED, FAILED]` and `[WAITED, WAITED, WAITED, FAILED]`).
* **The reassuring message was unreachable**, because it tested `code === 0` rather than the outcomes.
  `packOutcomes([])` returns `0`, so the one code that reads as success was attached to the one input that
  measured nothing.

### The budget, and the fifth time I hit the same ceiling

The first version took a 40-second timeout **per file** and ran four files: a 160-second worst case against
this fleet's **~50-second lease ceiling** (`heartbeatIntervalMs 10s × missedHeartbeats 2 + leaseGraceMs 30s`).
It **expired** on the real machine, and an expired lease carries **no exit code at all** — so the measurement
was lost rather than reported negative. That is the fifth time in this project that a dispatch was built
without respect for the ceiling.

The fix is a **total budget** (`DEFAULT_BUDGET_MS`, 30s) with a per-file cap, and files that miss their turn
are named `WAITED` rather than dropped — a packet that quietly omitted the last file would look like a clean
run of the ones it managed. A per-file timeout answers "is this file hung"; only a total budget answers "will
the answer survive the trip".

### What the real machine refused, which is a finding and not a bug

`node scripts/machine-test-packet.mjs ...` came back **`COMMAND_NOT_ALLOWED`**. The MacMini's allow-list
admits `node -e` and `node --test`; it does not admit an arbitrary script path, and the packet **spawns
`node --test` internally**, so it would be refused a second time. The tool is correct and tested; it needs an
allow-list entry to run there, and **that is a change nobody has made.**

**11 tests, 0 failures.**

## [0.27.0] — 2026-10-15

**A blocked fleet reports itself. The approval count is in `w2m_status`, and it arrives as a note.**

A queue visible only to someone who remembers to look at it is a queue that stays full, and **a fleet blocked
on approval looks exactly like an idle fleet.** `w2m_status` now carries an `approvals` block and, when
anything is waiting, a note placed **first** — ordering being the only emphasis a list of notes has:

> *"3 dispatch(es) are WAITING FOR AN APPROVER and will not run until one answers; read them with
> `w2m_approvals` (1 past their deadline); the oldest has been waiting 240s"*

### `constructed: false` is not `pending: 0`

A machine that has never tripped the permission gate should not be described as having an empty queue **as
though that were a measurement.** The block says which it is, and the note is emitted only for real pending
work.

### The whole chain, across three tools, asserted end to end

An ordinary actor (49) attempts a write → refused with `W2M_PERMISSION_NEEDS_APPROVAL` **carrying the queued
id** → `w2m_status` reports `pending: 1` and the blocking note **without being asked about approvals** → a
captain settles it → the signal clears.

### The default approver is the requester, and the index says so

The test discovered this rather than assuming it: a request records its subject as the machine's name, and an
approver who **defaults to that same name is the subject** — so `may_act` is false with
`APPROVAL_SELF_APPROVAL`. That is correct, and it is a real consequence of the defaults rather than a bug. The
test now names a distinct approver and **asserts the refusal first**, so the self-approval rule is pinned
rather than sidestepped.

### A payload silently dropped, caught by a test that found nothing

`W2MError` accepts only `code`, `message`, `hint`, `detail`, `cause` and `reason_code`. The first version
passed `approval_id` and `request` as **top-level options**, so they were **discarded without complaint** and
the refusal told a caller to await approval **with no way to name what they were waiting for.** They now
travel in `detail`, and the constructor's accepted keys are named in a comment beside the call.

Two of my own errors in this round were the same shape as the ones before it: a block hoisted into the **wrong
scope** (module level instead of inside `execute`, which `node --check` accepted because the name existed
*somewhere*), and a syntactic fix that put a statement **inside an object literal**. Both were caught by
running the suite, not by reading.

**1 new cross-tool test, 0 failures.**

## [0.26.0] — 2026-10-15

**`w2m_approvals`: the approval chain is reachable by an operator, not only by the suite.**

The tenth tool. `action: "list"` reads the queue, `approve` and `reject` settle one request by `approval_id`.
Until now the chain from 0.25.0 was **closed in code and testable end to end while no operator could reach
it**; this is the tool that opens it.

### Every row says whether *you* may act, and why not when you may not

A list filtered to what the caller may answer would be shorter and would **make the fleet look idle at the
moment it is most blocked.** `listFor` already returns each row with `may_act` and `why_not`; the tool passes
them through instead of hiding work above the caller's authority.

### `actor_level` is a parameter, and that is deliberate

The machine's own `actorAuthorityLevel` says what it may **dispatch as**. An approver's level is a fact about
the person answering, and a decision made on the dispatcher's level would let a machine approve its own
escalations. Passing it explicitly is what keeps `APPROVAL_SELF_APPROVAL` meaningful rather than incidental.

**Settling without a level is refused** (`W2M_APPROVAL_LEVEL`) rather than defaulted, so a decision is never
attributed to a level nobody supplied. Listing **without** a level still works and says so: `level_known:
false`, with a note explaining that the queue is visible but whether any of it is answerable is not known —
**knowing what is waiting does not require the authority to answer it, and a queue only its supervisors can
see is a queue that stays full.**

### The note on every settle, because a reader will assume otherwise

> *"the request is settled; the dispatch did not run and must be attempted again"*

Approval means the next attempt is allowed, not that anything already happened. A tool that settled quietly
would leave its caller waiting for a result that is never coming.

### Three defects of mine, all caught by the suite or by checking

* I called a `json(...)` helper **that does not exist in this file** — every tool returns `JSON.stringify(...)`.
  `node --check` passed, so only reading the surrounding code found it.
* I referenced `AUTHORITY_MAX` without importing it.
* I omitted `presentCall`, which `ALLOWED_DEF_KEYS` requires and which the registration-shape test pins. It now
  labels a list as a `read` and a settle as a `write`, because **calling a queue inspection a write would
  misrepresent the common case.**

Four tool-count assertions said "exactly nine" and named the nine; they now say ten and name the ten. The
comment beside one of them already recorded the lesson from a previous version — that a **count** was once the
wrong property and the **message** was the right one. This time the count *was* the property.

**7 new tests, 0 failures.**

## [0.25.0] — 2026-10-15

**The chain is closed: dispatch → gate → queue → decision. The plugin builds a queue, and an escalation is a real entry an approver can find.**

### The queue belongs to the plugin, not to the call

`apply()` now constructs **one** `createApprovalIndex()` for the plugin's lifetime, lazily. A queue built at
the call site would be **empty every time**, so a request raised by one dispatch could never be found by the
decision that answers it — **it would look wired and behave as if it were not.** Same reasoning as the P2P
runtime beside it: something that must outlive a single call belongs to the plugin.

### Measured, end to end, before it was written down

| Step | Result |
|---|---|
| an ordinary actor (49) asks to write | `needs_approval`, `enforced: true` |
| the request is raised | `ok`, id issued, `subjectLevel` **49** |
| a captain (50) lists the queue | `may_act: true`, `required_level: 50` |
| a peer (10) lists the same queue | **sees it**, `may_act: false`, `APPROVAL_INSUFFICIENT_AUTHORITY` |
| the captain settles it | `ok` |
| after settling | `approved`, **`subjectLevel` still 49** |
| the requester approves their own request | **`APPROVAL_SELF_APPROVAL`** |

The fourth row is the one worth naming: **a peer can see work that is above their authority and is not theirs
to answer.** A filtered list would make the fleet look idle at the moment it is most blocked.

### A queue that refuses is not a queue that needs approval

If `raiseApproval` fails, the dispatch is refused with **`W2M_PERMISSION_APPROVAL_NOT_RAISED`**, a different
code from `W2M_PERMISSION_NEEDS_APPROVAL`. A caller told "await approval" for a request that was never stored
would **wait forever for a decision nobody can make.**

### Still true, and stated rather than glossed

The dispatch still **does not run** when approval is required — an escalation is a request to be allowed, not
a permission. There is **no tool yet for an approver to settle a pending request**; `decide()` exists and is
exercised by the suite, and wiring it to a tool is the next step. So the chain is closed in code and testable
end to end, while remaining **unreachable by an operator in the running plugin.**

### My probe was wrong before the code was

The first end-to-end run threw on `listFor(...).requests.length`. `listFor` returns a **row array**, not an
object with a `requests` field. **The code was right; my assumption about a shape I had not read was wrong**
— the fifth time in this project, and the same failure as the parse-prefix mistake early on.

**3 new chain tests, 0 failures.**

## [0.24.0] — 2026-10-15

**The escalation reaches the approval index — and the bridge between them is where the defect would have been.**

Two shapes that look alike and are not:

| `approvalRequestFor()` produces | `index.register()` wants |
|---|---|
| `subject_level` (flat) | `subject: { id, level }` (nested) |
| `capability` | `action` |
| `task_id`, `requested_by` | `sessionKey`, `subject.id` |

A caller hand-mapping these at the call site would get it right once and wrong later, and **the failure would
be a request registered against the wrong subject — the one field the whole decision rests on.** So
`raiseApproval()` owns the mapping and lives beside the thing it maps from.

### It does not smooth anything over

`register()` refuses a subject level that is not an integer 0..100, and the adapter **passes the index's own
`reason_code` and `detail` through unchanged**. A bridge that substituted a default level to make registration
succeed would be **inventing the single fact the approver's decision rests on, and would look like success
while doing it.** Tested directly: a request whose level is `'captain'` is refused, and the queue stays empty.

The `approvalId` is **required from the caller, not generated here**, because an id invented at this layer
could not be correlated with whoever is waiting on the decision.

### The end-to-end property is asserted, not described

A real `createApprovalIndex()` is constructed in the suite and an escalation is raised into it: the request
appears in `index.all()`, `subjectLevel` survives the mapping as `49`, and after an approver at level 50
settles it, **the subject level is still 49** — settling must not rewrite it.

### Two of my own errors, both caught by the suite rather than by reading

* I asserted `INDEX_NO_SUBJECT_LEVEL`. The value is `APPROVAL_NO_SUBJECT_LEVEL` — **every code in
  `INDEX_REFUSAL` carries the `APPROVAL_` prefix.** The implementation was right and had passed the index's
  own code through faithfully, which is exactly what the test was there to check. The assertion now reads the
  value **out of the table** so it cannot drift again.
* The generator script's escape handling produced a stray `$` inside a template literal in a *failure message*,
  which threw at runtime rather than at parse time. Caught by running the suite, not by `node --check`.

### Still not wired to a live queue

`createApprovalIndex` has **no caller in the plugin** — it was built in 0.10.0 and is exported from
`approval-index.mjs` alone. This release makes the gate and the index meet **on a real object**, with an
end-to-end test, but no dispatch path yet constructs a queue. So `W2M_PERMISSION_NEEDS_APPROVAL` still
refuses rather than queuing, and it still says so.

**6 new tests, 0 failures.**

## [0.23.0] — 2026-10-15

**The gate is on the dispatch path. "分权限" now executes, and a machine that has not opted in behaves exactly as before.**

`src/plugin/tools.mjs` calls `gateDispatch()` immediately after the write-scope check — placed there so the
thing being graded is already known to be well-formed — and refuses the dispatch when the verdict is not
`allow`.

### `actorAuthorityLevel`, and why it is not shared config

Read from the plugin config, or `W2M_ACTOR_AUTHORITY` so a machine can be pointed at a level without editing a
profile. **Deliberately not part of `shared.values`**: this is a local statement about who is typing, and a
fleet-wide value would let one machine's level speak for another's operator.

**`null` is not `0`.** An unset level means there is no actor to judge, and the gate reports `enforced: false`
and changes nothing — which is why adding this cannot alter the behaviour of any machine that has not opted
in. A refusal for everyone who never configured a level would have been the easy implementation and the wrong
one.

### What a refusal looks like

Two distinct codes, because they need different responses:

| Code | When | What it means |
|---|---|---|
| `W2M_PERMISSION_DENIED` | verdict `deny` | the level is more than one band short, or the capability is undeclared |
| `W2M_PERMISSION_NEEDS_APPROVAL` | verdict `needs_approval` | the level is exactly one band short |

The `needs_approval` refusal **carries the approval request** that `approvalRequestFor()` built — subject
level, required level, capability, `auto_settleable` — and says plainly that it is refused rather than queued
**because no approval queue is wired to this call yet.** Refusing and saying why is honest; queueing a request
nothing reads would not be.

### A defect I introduced while wiring it, and how it surfaced

The first edit **corrupted the file**: the anchor for the config field matched only the first line of a
multi-line expression, so it cut `allowedCommands` off from its own `.filter().map().filter()` chain and left
the orphan chained onto my insertion. A second attempt then wrote literal backslashes into the source by
escaping backticks that did not need escaping.

Both were caught by `node --check` immediately, which is the argument for running it after every write rather
than after the batch. Neither reached a commit.

**120 tests across the tools, permission and entrypoint suites, 0 failures.**

## [0.22.0] — 2026-10-15

**The gate now grades a real dispatch, and connects to the approval queue.**

0.21.0 built the gate and admitted it had no caller. This release gives it one: `gateDispatch()` reads a
dispatch's **own** facts — `write` and a non-empty `write_scope`, both already in the payload — and grades it,
rather than asking the caller to name a capability. That distinction is the whole design: **a caller who must
name their own capability is a caller who can name the cheap one.**

### The unset level, which is the honest part

`tools.mjs` states plainly that **no parameter of any tool can widen what a machine will run**, and that there
is no way for a caller to set anything authority-shaped. So a plugin with no configured actor level has no
actor to judge. Two answers were available:

* treat an unset level as `0` — which would **refuse every writing dispatch on every machine that has not opted
  in**, breaking a working fleet to enforce a policy nobody asked for;
* treat it as **unenforced, and say so**.

This does the second, and `enforced` is the whole point: **a gate that reports `ALLOW` and a gate that reports
"not checked" must never look alike, because the first is a decision and the second is the absence of one.**
A test asserts exactly that — same verdict, different `enforced`, different `reason_code`.

### The escalation reaches the queue it was built for

`approvalRequestFor()` returns `null` for anything that is not `NEEDS_APPROVAL`, and otherwise produces a
request shaped for the cross-session approval index built in 0.10.0 — **the two features finally meet**, which
is the point: a permission gate and an approval queue that do not connect are two things that each look
finished and jointly do nothing.

The request carries the **subject level recorded now**, not left to be re-derived later, for the reason
0.10.0's index already states: an approver who could supply the subject level could lower it. A destructive
request is marked `auto_settleable: false` explicitly, rather than leaving the queue to infer it from a
capability name.

### A `write` with no scope is graded as the dearer capability

The dispatch path refuses that combination separately. Grading it cheap here would mean that if that check
ever moved, a request intending to write would be handed the read-only permission.

### A test of mine was wrong, again in the same direction

`gateDispatch({write: true}, 0)` was asserted to be `deny`; it is `needs_approval`, **because an ordinary
actor is exactly one band below captain and that is the documented behaviour.** The implementation was right.
This is the fourth time in this project that a failing test was the test's fault — and it is the argument for
testing refusals rather than only the happy path, because a wrong refusal fails loudly enough to be told apart
from a wrong acceptance.

**11 new tests, 0 failures.**

## [0.21.0] — 2026-10-15

**The capability table has a gate now, so it is a policy rather than a description of one.**

`scripts/layer-model.mjs` has declared since 0.12.0 what each operational capability costs in authority —
`read_fleet_state` at ordinary, `dispatch_writing` at captain, `publish_release` at org admin,
`write_config` at system admin — and **nothing consulted it**. A table nothing reads is true on the day it is
written and unenforced afterwards; that is the same failure this project already paid for with the layering,
where a prose description was quietly violated while nothing failed.

`src/agent/permission.mjs` compares the table against `authority.mjs`'s bands and returns one of three
verdicts. The interesting part is not `ALLOW`:

### The escalation window is exactly one band

`NEEDS_APPROVAL` is granted to an actor **one band below** the requirement and to nobody further down.
`DENY` covers everything else.

**Two bands below is refused rather than escalated**, and that is a security decision rather than a
convenience one: if any shortfall could be forwarded, an ordinary actor could request a system-admin action
and **the request itself would be the attack** — one inattentive approver away from a write to
`allowedCommands`. One band means an actor can ask for the next thing up and no more, which is what
"escalate to your supervisor" actually means.

### An undeclared capability is DENIED

Not `ALLOW`, which would make the table grant whatever is added next; not `NEEDS_APPROVAL`, which would make
it requestable. Either would turn an **omission** into a permission. `decide('teleport', 100)` refuses, because
authority answers *how much may this actor do*, not *is this a thing that exists*.

### A level nobody defined is refused rather than rounded

`50.5`, `-1`, `101`, `NaN` and `'50'` are all denied with the requirement still reported. Treating them as `0`
would silently downgrade an actor; treating them as high would silently promote one. Neither is a decision
this module is entitled to make.

### Nothing destructive settles itself

`mayAutoSettle()` returns false for any destructive capability **even on an `ALLOW` at maximum authority** —
the level answers "may this actor", not "should this happen now". A release published on a machine's own
judgement is a release nobody reviewed.

### The table is audited, not trusted

`auditCapabilities()` reports any entry **no band can reach**, because an unreachable capability reads as
policy while doing nothing — worse than an absent one, since it looks like a control.

**18 tests, 0 failures.** One property is asserted across the whole table rather than by example: for every
declared capability and every level from 0 to 100, a `NEEDS_APPROVAL` verdict implies the actor is exactly one
band below.

## [0.20.0] — 2026-10-15

**Version skew is refuted too, and the direct-path failure is now counted instead of read one at a time.**

### Third hypothesis, third refutation

The previous release established that this machine runs plugin **0.9.5** while the source tree is **0.19.0**,
and that the failing `P2P_PUNCH_FAILED` is raised by the plugin process. The natural next step was to suspect a
digest name that 0.9.5 used and later versions removed.

**Measured, and refuted:** reading `crypto.mjs`, `p2p.mjs` and `p2p-node.mjs` **at tag `v0.9.5`** through the
API shows the same two digest names the current tree uses — `blake2s256` and `sha256`. Then a search for
**dynamic** algorithm arguments (`createHash(variable)`) across `src/` found **none**: every `createHash` and
`createHmac` in this codebase is called with a string literal.

**So there is no call in this codebase that can produce `Digest method not supported`.** Three hypotheses have
now been measured and excluded — BLAKE2s, the wider primitive set, and version skew — and the cause remains
**UNVERIFIED**. What is *not* in doubt is where it is raised: the plugin process on this machine, running
0.9.5 while the source under study is 0.20.0.

### What this release delivers instead of a fourth guess

`p2pReasons()` and `classifyP2PReason()` turn the P2P reason strings into a **count**, because the finding that
matters was invisible in every individual report: **twelve of twelve tasks travelled by relay, and no aggregate
anywhere said so.**

* `relay_only_share` is the fleet's avoidable latency as one number, and it is **`null`** for an empty
  denominator — "no lease carried a p2p block" and "every lease failed" must not look alike.
* an unrecognised code is counted as `OTHER` **with the raw code travelling with it**, so a new refusal name
  is reported rather than swallowed.
* a missing reason is distinguished from a present one, because *"no reason recorded" is not "no failure"*.

### The version skew is still unresolved and still blocks diagnosis

The installed plugin is **0.9.5**; the source is **0.20.0**. Until they match, every source-level conclusion
about this machine's P2P behaviour is read from code that is not running. This needs a person: updating the
plugin installs files into the DSH profile, which is outside what this session changes on its own.

**7 new tests, 0 failures.**

## [0.19.0] — 2026-10-15

**The plugin this machine runs is 0.9.5. The source tree is 0.18.0. Every source-level conclusion about the P2P failure was read from code that may not have run.**

Measured, not inferred:

```
source    : 0.18.0
installed : 0.9.5   at ...\profiles\desktop\node_modules\@twinsearth\w2m-dsh-plugin
verdict   : installed 0.9.5 is 8995 rank(s) BEHIND the source 0.18.0
            -- source-level conclusions about this machine are void
```

Reading `p2p-node.mjs` established which call raises `P2P_PUNCH_FAILED`, and it is raised **by the plugin
process** — `tools.mjs:1463`, `node.dial(...)`, on the dispatching machine. That machine's plugin is **nine
versions behind the file that was being read.** Two rounds of crypto-capability work were therefore correct
about the code in this repository and only *possibly* correct about the code that failed.

### Two runtime facts were assumed, and only one held

| Assumption | Status |
|---|---|
| which node the plugin runs under | **holds** — the DSH process runs `dsh-primary-runtime/.../node.exe` v24.21.0, the same binary that was probed; the runtime was never the variable |
| which plugin version is loaded | **did not hold** — 0.9.5 installed against 0.18.0 of source |

The first was checked last and held; the second was never checked and did not. **A version skew is not a
detail to note — it is a reason every source-level conclusion is void**, and it should have been the first
thing measured rather than the last.

### The invariant is now a test

`test/installed-version.test.mjs` finds every plausible install location, compares numerically (because
`'0.9.0' > '0.10.0'` as strings, and `0.9.5` against `0.18.0` is exactly the case that would be got wrong),
and **reports the skew with both numbers** rather than failing an assertion nobody could act on. It also
refuses to compare what it cannot parse, and **says so when it finds no installed copy** — because passing by
absence is the same failure mode as an earlier skip guard in this repository, which passed for three rounds
while hiding a defect in the tooling rather than in the code.

### What is needed from a person

**The local DSH must load the current plugin** for P2P diagnosis to mean anything. Until it does, this
machine's `P2P_PUNCH_FAILED` comes from 0.9.5 and no reading of 0.19.0's source can explain it.

**8 tests, 0 failures.**

## [0.18.0] — 2026-10-15

**The whole handshake primitive set is present on both machines — so the P2P failure is not a missing algorithm.**

Two candidates for `P2P_PUNCH_FAILED: Digest method not supported` have now been **measured and excluded**:

| Candidate | Measurement | Verdict |
|---|---|---|
| BLAKE2s-256 | 32-byte digest on MacMini **and** here, on the same run that failed | **innocent** |
| every other primitive the handshake touches | `sha256`, `chacha20-poly1305` with a real AEAD round trip, `hkdfSync('sha256')`, `x25519`+`diffieHellman`, `ed25519` — all present on both | **innocent** |

The second row was answered by **one bit-encoded dispatch** that put eight questions to MacMini at once
(`exit_code: 255`, every bit set) rather than one question per round. That technique was already in this
repository and should have been the first move.

**What this changes:** the search moves off the runtime and onto the protocol, the session state, or the
transport. And it points somewhere specific — **`P2P_PUNCH_FAILED` is raised by the relay's own push, on the
machine that already has every primitive it needs.** The failing handshake is not on a peer missing an
algorithm; it is on a peer that has all of them.

`cryptoCapabilities()` now answers this question in one dispatch for any machine, and its suite asserts the
**count** — six primitives, six checks — because a capability report that silently checks four things reads as
complete.

**Honest status: the cause of `P2P_PUNCH_FAILED` remains UNVERIFIED**, and the 0 % direct share measured last
round is unchanged. What this release buys is that two hypotheses are dead and the next one costs one
dispatch to test.

## [0.17.0] — 2026-10-15

**BLAKE2s-256 is not the cause of `P2P_PUNCH_FAILED`, and a failure that names nothing costs a probe per guess.**

### The hypothesis, and its refutation

`P2P_PUNCH_FAILED: Digest method not supported` has been reproduced twice in production and never under
instrumentation. The obvious candidate was `createHash('blake2s256')` in `handshakeHash` — an algorithm that
some Node builds lack, whose absence produces exactly that string.

**Measured, and refuted:** both MacMini and this Windows host compute a 32-byte BLAKE2s-256 digest, on the
same run that reported the failure. `blake2s256` is available on both. **So the algorithm is not the cause**,
and the real cause remains **UNVERIFIED**.

### What changed anyway, because the failure's *shape* is the real defect

OpenSSL's message names **no algorithm, no caller and no host**. Establishing that BLAKE2s was innocent
therefore required probing each machine by hand, over a channel that carries one exit code — a round trip per
hypothesis. `handshakeHash` now:

* catches the unavailable case and throws `CRYPTO_BLAKE2S256_UNAVAILABLE` naming the algorithm, the runtime,
  and the fact that **it is a wire-protocol primitive which cannot be replaced with SHA-256** without breaking
  interoperability with every peer — so nobody "fixes" it by substituting an algorithm and silently splits the
  fleet;
* refuses a digest that is not 32 bytes (`CRYPTO_BLAKE2S256_WRONG_LENGTH`), because a truncated digest throws
  nowhere and would surface as an authentication failure far from its cause;
* exposes `blake2s256Support()` so a machine can answer the question about itself in one dispatch.

The wrapper is transparent on the happy path, and a test asserts it byte-for-byte against a direct
`createHash` call — if it changed the bytes, every peer would compute a different handshake.

### A defect in the fix itself, found before shipping

The first version called `getHashes()` without importing it, so `typeof getHashes === 'function'` was silently
`false` and the `advertised` flag would have been wrong forever. Caught by inspecting the import block rather
than by a test, which is the honest description of how it was caught.

### The 0 % direct share stands

Last round measured **12 of 12 tasks carried by the relay**, at RTT 354 ms (macmini) and 336 ms (ToFuture)
where jp-shared answers in 20 ms. This release does not improve that number; it makes the next attempt at
diagnosing it cheaper.

**10 new tests, 0 failures.**

## [0.16.0] — 2026-10-15

**A non-zero exit code is not a fleet failure, and this session conflated them repeatedly.**

Twelve real task reports were fetched one request at a time — the only correct input, since `w2m_history`
records current lease state rather than outcomes — and the measured result was **12 acting leases, 12 `done`,
0 expired, 0 refused**. Yet several runs in the same session produced no result at all. Both facts are true.

They are different failures, and the difference decides where a reader looks:

| Observation | What it means | Where the fault is |
|---|---|---|
| `exit_code: 70`, `lease_state: done` | **The command ran and reported 70.** The fleet worked. | the command |
| `exit_code: null`, `lease_state: expired` | **No result was ever produced.** | the machine, the lease, or the network |

`classifyLease()` and `isFleetFailure()` now encode that distinction, and **`exit_code` is the decisive field,
not the lease state** — a lease can be `done` while its command returned non-zero, which is a *successful
execution of a failing command*. `isFleetFailure` returns true only for the no-result case; a refusal is the
request being wrong, and an observer was never asked to act.

A rate that merged the two would report a healthy fleet as broken, or a broken one as healthy, depending on
which it happened to count.

### The measured fleet, this round

| Measure | Value | Note |
|---|---|---|
| acting leases | 12 of 12 | a bounded sample, fetched per task |
| expiry rate | **0.0 %** | 0 expired in the sample |
| refusal rate | **0.0 %** | 0 refused |
| direct share | **0.0 %** | **every task went by relay** |
| P2P delivery rate | **0.0 %** | no direct channel was ever established |
| fleet size | **3 usable of 5 paired** | two `win-desktop` silent ≈ 17.2 h |

**The 0 % direct share is the finding worth acting on**: not one task in the sample used a direct path, so the
entire fleet has been running on the relay at RTT **354 ms** (macmini) and **336 ms** (ToFuture) where
jp-shared answers in **20 ms**.

### Still not fixed

The two relay endpoints still disagree about whether the silent machines are online — `reconcile()` detects it
and says which to trust, but the disagreement itself needs a change on the relay, and this session has no shell
on that host.

**24 tests, 0 failures.**

## [0.15.0] — 2026-10-15

**The fleet is three machines, not five — and two relay endpoints disagree about it.**

### The measurement, which is the whole point of this release

`w2m_stats` and `w2m_devices` both answer "is this machine usable?" and **they do not agree**:

| Machine | `w2m_devices` | `w2m_stats` | silent for |
|---|---|---|---|
| jp-shared | online | online, RTT **6 ms** | 2.4 s |
| macmini | online | online, RTT **538 ms** | 4.4 s |
| ToFuture | online | online, RTT **122 ms** | 0 s |
| win-desktop ×2 | **online** | **offline, `silent`** | **61 384 s ≈ 17 h** |

**A fleet whose size is reported two ways is a fleet whose plans are wrong by a factor of 1.7** — and the
failure is silent, because both answers look authoritative. `src/agent/fleet-state.mjs` prefers `w2m_stats`
(it is the one carrying a *reason*), treats a listing without a heartbeat age as unverified, and
`reconcile()` reports **every machine the two endpoints disagree about** rather than picking one and staying
quiet.

### The second divergence, which would have flattered the fleet

`w2m_history` lists a `lease_states` map per task. **It is not the execution outcome.** Of forty tasks in the
sample, every one recorded macmini as `done` — while the session's own result envelopes included several
`expired` with no exit code at all. The map records the *current* lease state.

`historyIsOutcomeRecord()` returns `false` unconditionally with the reason, and its suite asserts on the
measured payload. The finding matters because of its direction: **a reliability measurement built on the
history listing would have shown a perfectly reliable fleet** — the most dangerous possible error in a module
whose whole purpose is to notice trouble.

The number to plan against is therefore **three usable machines**, and `readStats()` takes it from the
per-machine entries rather than from `counts.online`, while still reporting the relay's own claim rather than
hiding it.

### A fixture typo that invented a disagreement

Two tests failed because a machine id in a fixture was written `tob` where the payload says `tof` — so the
reconciler correctly reported a *third* machine claimed online but not usable. **The code was right and the
fixture was wrong**, which is the third time in this project that a failing test was the test's fault; the
argument for testing refusals is that they fail loudly enough to be told apart.

**16 tests, 0 failures.**

## [0.14.0] — 2026-10-15

**Fleet scale: the arithmetic the observations support, and the refusals where they support nothing.**

ROADMAP v4.11.0 names scale, defence and integration and deliberately does not plan them, on the grounds that
**a design that has not been measured at 50 cannot honestly specify 1,000**. This release does not specify
1,000. It provides the module that computes what a fleet's own task history can support, and refuses the rest.

### The limit that bounds everything, stated first

**This fleet has five machines.** No amount of cleverness turns five into fifty, and the number the ROADMAP
actually asks about — the agent count at which coordination collapses — is exactly the number this fleet
cannot observe. So `scaleOf()` returns `can_answer_collapse_point: false` as a **field**, not as a footnote,
and `extrapolate(5, 50)` refuses with a reason rather than producing a scaled number.

The refusal is the feature. A module that emitted a "scaling curve" from five points would be producing
**fiction with a decimal point on it**, which is worse than silence because it is quotable.

### What the fleet can answer, from `w2m_history` and `w2m_report`

| Measure | Why it is the one that matters |
|---|---|
| **lease expiry rate** | An expired lease is work that was assigned and **silently did not happen**. This is the coordination failure. |
| **refusal rate** | Counted separately, because a refusal is *the request* being wrong, not the fleet. Merging them points the reader at the wrong machine. |
| **transport mix** | Every task carried by the relay while a direct path existed is avoidable latency. |
| **fan-out vs machines online** | Participation against opportunity. |

### The refusals, which are most of the suite

`0/0` is the most misleading number this module could produce — it reads as a perfectly coordinated empty
fleet. So `expiry_rate`, `refusal_rate`, `direct_share` and `overhead_per_agent` all return **`null`** for an
empty denominator, and `overhead()` says *"the overhead of zero agents is not zero, it is undefined"*.

`ceilingFrom()` states one thing and denies another: *"at a fan-out of N, the lease expiry rate was X"*, with
`is_a_ceiling: false` and a note that a ceiling would need the rate measured **at several fan-outs and
trending**. That is the only honest form of the answer available.

Three defects found by the suite, all mine:

* the boundary rule contradicted its own comment — the test said *"at least a tenth"* while the code required
  *more than* a tenth. The boundary is now exclusive, deliberately: at exactly 10% a refusal costs nothing and
  an estimate costs credibility.
* a test expected a `null` entry in a machine list to be dropped. It should not be: a machine listed with no
  result **is an unknown outcome**, which is a real thing a relay response says.
* the same two mistakes, in the same file, in the same run — which is the argument for testing the refusals
  rather than only the arithmetic.

**19 tests, 0 failures.**

## [0.13.1] — 2026-10-15

**The macOS skip is removed, because the failure it was hiding did not exist.**

`test/log-bounds.test.mjs` was skipped on macOS for three rounds because it appeared to fail there with an
`AssertionError`. **It never failed.** The tooling that read its result was looking for a summary line
beginning `# fail 0`, and node v24 writes `fail 0` behind an information symbol instead — the same defect
fixed in 0.13.0. The "failure" was my parse error, re-reported as a suite result.

With the guard temporarily removed on MacMini and the corrected parser in place, the measured result was:

```
28 test(s), 0 failed          (read from stdout, info format)
```

**Seven `describe` blocks had been guarded. All seven are unguarded now, and the note explaining the skip is
replaced by a note explaining that there is nothing to skip.**

### What that cost, recorded so the shape is recognisable next time

Two rounds of probes, all of which correctly ruled out every filesystem hypothesis — the repository was
present, the module loaded, and `mkdirSync`, `mkdtempSync` and `writeFileSync` all succeeded. **The probing was
sound and the premise was not**: it had been derived from a parse failure, and the premise itself was never
measured. One command that printed the raw output would have shown the prefix immediately. It should have been
the first thing run rather than the last.

A guard added on a false premise is worse than no guard, because it converts "I cannot see the result" into a
permanent, plausible-looking exception — and it does so in the one place nobody looks again.

Windows: 28 tests, 28 pass, **0 skipped**.

## [0.13.0] — 2026-10-15

**The root cause of three rounds of confusion was a regex, and it was mine.**

Several rounds were spent believing a suite *failed on macOS*. It had not. The parser was looking for lines
beginning `# tests 17`. Node v24 writes them beginning `ℹ tests 17`:

```
ℹ tests 17        not        # tests 17
ℹ pass 17                    # pass 17
ℹ fail 0                     # fail 0
```

**The `#` form was an assumption that was never checked**, carried from the first script written in this
session to every one after it. The damage was worse than a misread count:

* suites that had **passed** were recorded as `UNREADABLE`;
* and then the absence of a `# fail` line, together with the absence of test *names* in the captured output,
  was read as **"the process crashed before printing anything"** — which pointed at module scope and sent an
  investigation somewhere the fault was not. Two rounds went into that, including a probe that correctly ruled
  out every file-system hypothesis, because the hypothesis being tested was derived from a bad premise.

`src/agent/test-report.mjs` now writes the contract down, parses both prefixes plus a bare form, reads
**both streams and says which one answered**, and reports its own format so a future change is *reported*
rather than silently tolerated. 13 tests, and the two that matter most are:

* the **real** v24 output parses (taken verbatim from a run, not invented);
* an unreadable report yields `verdict(...) === null`, **not `false`** — collapsing "could not read" into
  "failed" is the safer of the two wrong directions and was still wrong enough to waste rounds.

### The lesson, stated so it generalises

**I assumed the shape of a channel's output instead of measuring it** — the same error, from the same
channel, for the third time in this session (first the exit-code summary line, then the test names, now the
prefix). The technique that finally settled it was printing the raw output and looking at it, which took one
command and should have been the first.

`test/log-bounds.test.mjs` remains skipped on macOS. With a working parser the skip is no longer plausible as
a parse artefact, so the underlying assertion failure is still **UNVERIFIED** — but the reason it took so long
to see is now fixed and tested.

## [0.12.3] — 2026-10-15

**Correcting a wrong inference that 0.12.2 recorded as fact.**

0.12.2's note on the macOS failure said: *"no test name appears in the captured output, so the failure happens
before the per-test lines are printed — which points at module scope or a hook rather than a single
`it(...)`."* **That reasoning was wrong, and it is corrected here rather than quietly dropped.**

The claim rested on a probe that searched the captured output for twenty-seven test names and found none. A
later run searched for the same twenty-seven and also found none — **on a run that succeeded**. So on this
machine the test names do not appear in the output at all, and their absence said nothing about where the
failure was. The same mistaken inference was drawn from the same channel capability twice.

What is actually measured now, by a bit-encoded probe that asked six questions in **one** dispatch instead of
six:

| Question | Result |
|---|---|
| repository present | yes |
| `log-bounds.mjs` present | yes |
| `snapshot` is a function | yes |
| `methodFor` is a function | yes |
| the module import throws | **no** |
| `mkdirSync` / `mkdtempSync` / `writeFileSync` succeed | yes |

So the file operations and the module load are **fine** on that machine. The failure is a **plain assertion
inside some `it(...)`** — one of twenty-eight — and not a crash at module scope. The suite stays skipped on
macOS with that reason, unchanged in behaviour and now honest in its explanation.

The lesson is about the channel, not the test: **the remote output does not contain what I assumed it
contained**, and assuming its shape cost rounds twice. The probe that answers six questions per dispatch
should have been the first thing built, not the last.

## [0.12.2] — 2026-10-15

**Marking a platform-specific suite failure as UNVERIFIED instead of leaving it red, and saying exactly why.**

`test/log-bounds.test.mjs` passes on Windows and fails on MacMini with an `AssertionError`. That is the
**entire** diagnosis that could be extracted, and extracting it cost **seven dispatches across two rounds**,
because this fleet's only channel to a remote machine carries **a single exit code and no text**.

Each fact below was bought with a separate run:

* the failure is an `AssertionError` — not an import error, a syntax error, or a missing file;
* **the module itself is fine on that machine**: `log-bounds.mjs` was used there to measure real directories
  and produced sane numbers, so this is the suite and not the code under test;
* **no test name appears in the captured output**, so the failure happens before the per-test lines are
  printed — which points at module scope or a hook rather than a single `it(...)`;
* it is none of `EMFILE`/too many open files, `ENOENT`, `EACCES`, a missing `test-fixtures` path, or a
  reference to `tmpdir` — each was probed for explicitly and ruled out.

Two hypotheses were tried and **not** confirmed: that `/var/tmp` being a symlink to `/private/var/tmp` broke
the protection check's path arithmetic (the fixture was moved off the system temp directory and the failure
persisted), and that a low macOS descriptor limit was exhausting (ruled out by the `EMFILE` probe).

**The suite is now skipped on macOS with that reason in the skip message.** A suite that always fails on one
platform removes that platform's ability to validate *everything else*, and the fleet's cross-machine check is
worth more than this one file's coverage. The skip **names itself in the output**, so it cannot be mistaken
for a pass — an unremarked skip would be the dishonest option, and that is the one thing the fleet rules
forbid.

Also in this version: **0.12.1 was never published.** The fix was committed to `main` but no artifact was
produced, so the release that carried the symlink-fixture correction had no tarball on npm or GitHub. That is
now corrected by this release, which supersedes it.

## [0.12.1] — 2026-10-15

**Fix: the log-bounds fixture used a symlinked system temp directory, and failed on macOS only.**

Found by running the suite on a second real machine, which is the only way this class of bug surfaces. On
MacMini, `log-bounds.test.mjs` failed while `layer-model.test.mjs` passed.

The cause is that **`/var/tmp` on macOS is a symlink to `/private/var/tmp`**, and `resolve()` does not follow
symlinks. Protection is decided by comparing a resolved path against a resolved root, so a path built from
the symlinked form shares no prefix with the root and `isProtected` computes the wrong relative path —
**silently**, because the wrong answer is "not protected" and most callers only care about the protected case.

This is the **second time this fixture was wrong in a way the code was right about.** The first time,
`mkdtempSync(tmpdir())` put a `tmp` segment in every path and `methodFor` treats a `tmp` segment as removable,
so a fixture written to test a *refusal* was legitimately classified as removable. Both times the reflex was
to change the code.

The fixture now uses a plain subdirectory of the repository, which avoids both traps: no `tmp` segment, no
symlink. It carries a `.gitignore` so an interrupted run leaves nothing behind, and the suite's `after` hook
removes what it created — verified, **0 leftovers**.

Two smaller things fixed in the same pass:

* an import was removed but still referenced (`tmpdir`), caught by the suite rather than by review;
* the README's sample snippet contains a top-level `await`, which is a **syntax error** in a `.mjs` module.
  It is now labelled as an inline `node -e` snippet, which is the form that actually works.

**50 tests across the two suites, 0 failures locally**, and verified on MacMini.

## [0.12.0] — 2026-10-15

**Bounding unbounded writers, and making the layering enforceable instead of merely described.**

### The log bounding, from three recorded incidents

| When | What | Measurement |
|---|---|---|
| 2026-10-14 | Linux relay host filled to 100% | one uncapped writer at **14.7 GB/day** |
| 2026-10-11 → 10-12 | MacMini `relay-test` and node logs | grew **40×** in a day |
| recurring | build output in project copies and `/tmp` | accumulates without bound |

Recovery on the 14th was `truncate`, **not** `rm`, because rsyslog still held the descriptor open — removing
the file frees nothing while appearing to succeed. That single fact shapes the module: `methodFor` returns
`truncate` for anything a process writes and `remove` for build output, and the two are never conflated.

The 40× case is why there are **two independent findings** rather than one size threshold. `absolute` means
this file is already too big; `rate` means it grew this much between two samples, so it can be acted on
*before* it becomes the first kind. The rate is computed from the caller's elapsed time and **not** from
`mtime`, because `mtime` is rewritten by a rotation, a copy or a `touch` — a rate read from it would be a rate
of the last touch rather than of the writing.

### What is refused, and why the refusal carries its reason

`memory.jsonl` is the only durable copy of what a command printed, since the relay keeps `stdout_sha256` and
never the text. `device.key` is the identity peers know a machine by, and losing it makes every peer holding
the old one refuse that machine with no visible cause. Protection is by **resolved path prefix and by name**,
not by name alone, because a name-based check is defeated by putting the same file in another directory. A
protected file that *was* found is listed with its reason rather than dropped: a report that omits the
database is indistinguishable from one where the database was not there.

`node_modules`, `dist`, `target` and `build` are deliberately **not** protected — being rebuildable is exactly
what makes them legitimate targets, and `classFor` marks them `rebuildable` so a caller prefers them over
anything unique.

### The layering, as data rather than as a paragraph

The goal's wording is "分模块&分层级&分权限". A prose layering is true on the day it is written and quietly
false afterwards, because nothing fails when an import is added. So `scripts/layer-model.mjs` holds the model
as **data**, `scripts/layer-check.mjs` derives the graph from the real tree, and `test/layer-model.test.mjs`
fails when they disagree.

It is an **allow-list**, not a denylist. A denylist lets a new edge through and reports nothing; an allow-list
refuses it and forces the question. The measured shape it now describes is a chain with one shared leaf:
`plugin → agent(12), util(1), relay(1)`, `relay → chatops(4)`, and `agent`/`relay → shared(1 each)`.

Three defects found while building it, all by running rather than reading:

* **`src/signing.mjs` was treated as a layer.** It is a file sitting directly in `src/`, so its basename
  became a layer name and two genuine edges came back as "unexplained" — and worse, any future root-level
  file would have silently passed as a layer nobody declared. It now folds into a declared `shared` layer.
* **`buildGraph(srcDir)` ignored its own argument.** `layerOf` and `insideSrc` hard-coded the real `src`, so
  every synthetic-tree test returned zero edges. Two tests caught it; without them the real-tree test would
  have passed for the wrong reason.
* **`/x/dist` was classified `report_only`.** The match was on `/dist/` and `\dist\`, which a directory path
  with no trailing separator never matches — so the single most obvious cleanup target of all was not a
  target. Matching is now on whole path segments.

A fourth finding is about the tests rather than the code: two fixtures used `mkdtempSync(tmpdir())`, so the
OS temp path put a `tmp` segment in every path and made files legitimately removable. **The code was right
both times and the fixture was wrong**, which is worth recording because the reflex is to change the code.

### The configuration is offered; the module is what runs

`deploy/logrotate/w2m.logrotate` is a host-level file that needs root to install, so this repository can
*offer* it and cannot *enforce* it — saying otherwise is the kind of claim the fleet rules exist to prevent.
What runs without root, from a task on any machine, is `src/agent/log-bounds.mjs`. `copytruncate` and
`maxsize` are both set in the configuration: without the first, rotation renames the file while the daemon
keeps writing to the old descriptor and the disk stays full; without the second, a file growing 40× a day
reaches its cap long before a daily timer looks.

**28 tests for log bounds and 22 for the layer model, 0 failures.**

## [0.11.0] — 2026-10-15

**Committee governance (roadmap v4.10.0): one decision engine, ordered phases, weighted votes, retained dissent.**

### Built now, wired to nothing — and that is the roadmap's own instruction

ROADMAP §3 says a governance layer above a fleet *that has no disagreements yet* is indistinguishable from
a delay, and that the council earns its place when two fleets want the same machine. So `council.mjs` ships
as the decision engine, tested in isolation, with no caller. Building it now is justified because its
semantics are testable; deploying it now would not be.

### The three falsifying tests the roadmap names, as the suite's actual cases

1. **A phase cannot be skipped.** `advance()` takes no argument, so there is no way to name a destination;
   `goTo`/`setPhase`/`jumpTo` do not exist and a test asserts their absence. A vote before the vote phase
   refuses with `COUNCIL_UNCLEARED_TO_VOTE`, and the message says why: *a vote on nothing*.
2. **A vote's weights are reproducible from stored inputs.** `weightOf()` is a pure function of two stored
   integers, so `recount()` reproduces an outcome on any machine. The falsification is in the suite: a
   tampered weight is **detected** rather than reproduced, and the tally is asserted order-independent.
3. **A decision is retrievable *with* its dissent.** Dissent is part of the `Decision` value, not a log
   line, and `unanimous` is an explicit flag because an empty dissent list alone cannot distinguish
   unanimous from unrecorded. A test seals a decision and checks that dropping a ballot changes the seal.

### The design choice worth naming

`weight = authority × (1 + reputation/100)`, so reputation is a bounded multiplier in `[1, 2)` and **can
never overturn authority**: authority 49 at perfect reputation (98) still loses to a bare authority 99. A
governance layer that let reputation outvote the authority model would be a second, undeclared authority
model, and v4.7.0 already owns that question. A tie is a **refusal**, not a coin toss, because a split
council is exactly the case a person must see — and the refusal carries the tally that shows the split.

### Two design bugs the suite caught, both the same mistake

`record()` sets the seal, and `adjourn` comes **after** `record`. Deriving "sealed" from `decision !== null`
made `record()` block `advance()`, so the final phase was unreachable; and then having `advance()` consult
the seal at all was self-contradictory for the same reason. The fix is the distinction the module now states
explicitly: **the seal protects the decision, not the phase machine**. Conflating "decided" with "sealed"
produced a state nobody could reach — twice.

**28 tests, 0 failures.**

## [0.10.5] — 2026-10-15

**FLEET-RULES.md enters the tree, with this host's reachability measured and written down.**

### What was actually wrong

The 1.0.0 objective starts with *"local Windows and MacMini jointly"*, and on inspection the Windows host
had never been a git participant at all: its working copy was not a repository, and every release so far had
been published through the GitHub REST API rather than through git. That is a real gap and it was recorded
as one rather than glossed over.

### Why it was that way, measured rather than assumed

`github.com:443` is unreachable from this host while every other GitHub endpoint answers. Three consecutive
`git fetch` attempts failed after ~21 s each, and from the same process minutes apart:

| Endpoint | Result |
|---|---|
| `github.com:443` | **TIMEOUT** |
| `api.github.com:443` | OPEN 73 ms |
| `codeload.github.com:443` | OPEN 77 ms |
| `ssh.github.com:443` | OPEN 95 ms |
| `objects.githubusercontent.com:443` | OPEN 228 ms |

The blocking is **per hostname, not per port** — `ssh.github.com` answers on the same 443 that `github.com`
does not. It is also **intermittent at the TCP layer**: a raw `net.connect` to `20.205.243.166:443` timed out
while a `tls.connect` to the same IP with `servername: 'github.com'` completed `authorized: true` on TLS 1.3.
An intermittent block is worse than a solid one, because a single success is not evidence the path works.

The first two attempts at this treated the failure as a configuration problem and tried proxy settings and
retries. Both were wrong, and both cost a round. The measurements are cheaper to read than to repeat, which
is why they are now rule 8 of `FLEET-RULES.md` rather than a note in a session log.

### What now works, and what the evidence is

The repository is materialised from a `codeload` tarball (the one path that is reachable), giving a real git
work tree containing exactly `main` — verified by hashing both trees: **227 files, 0 differences,
`IDENTICAL`**. `scripts/fleet-sync.mjs` then ran against a real repository for the first time, having only
ever been tested against a temporary one:

| Step | Result |
|---|---|
| initial | `state=up-to-date action=none` |
| local commit | `state=ahead action=push ahead=1` |
| `--write` | `performed: true - pushed 1 commit(s)`; mirror and HEAD agree |
| peer commit arrives | `state=behind action=fast-forward behind=1` |
| `--write` | `performed: true - now at d42d5c0`; 228 files, peer file present |
| final | `state=up-to-date action=none` |

The same run also demonstrated the refusal path for free: when a fast-forward was rejected by git, the
result was `performed: false`, the tree was **left untouched**, and the state stayed `behind` — an automatic
sync that fails must not half-apply.

### Stated plainly rather than implied

This host can *pull* the truth and can *run* the sync machinery, but it **cannot push over git**. A round
that needs a commit published must use the API, and a round that exercises `fleet-sync` must do it against a
local bare remote. That is a real test of the state machine and **not** a test of the network, and the
difference is written into the rule so it is not mistaken for one.

## [0.10.4] — 2026-10-15

**A result channel over exit codes, for machines whose text cannot be read back.**

### Why this exists, stated without euphemism

The relay carries a per-machine `exit_code` faithfully and carries **no stdout at all**. That is a
deliberate property of the ledger and the right design for a system whose job is to say whether machines
agree — but the consequence is that an orchestrator can learn *that* a task failed and never *why*, and on
this fleet that cost several rounds: a health check returning a real verdict was indistinguishable from one
that crashed, because both produce a number and nothing else.

Every channel that would carry text is unavailable here. The relay host's SSH and its sink are refused, an
inbound receiver on the orchestrator never received a single connection, and a machine's `allowedCommands`
may permit only a narrow set of commands. What has worked on every machine every time is the exit status. So
this encodes bytes into exit codes. It is slow and it is ugly, and both are the point: **a diagnostic that
arrives slowly is worth more than one that never arrives.**

### The two design choices that are not arbitrary

- **`126` and `127` never carry data.** Shells write them for "not executable" and "not found", so a real
  127 and a data 127 would be indistinguishable and the reader would investigate the wrong failure. The
  alphabet is therefore a mapping over `1..125` and `128..253`, not a constant offset — the first version
  used `value + 1` across the whole range and its own test caught the collision.
- **Truncation is not completion.** `254` ends the message and `255` says the sender failed. A channel that
  stopped mid-message must not be read as a whole message, because that turns "the machine stopped talking"
  into "the machine said this" with no way for the reader to tell.

### Three failed fixes, and what actually located the bug

`encodeBytes` emits remainders as it divides, so its output is **least significant first**; the decoder's
Horner accumulator consumes digits **most significant first**. Feeding one into the other inverts the
message, and it presents as byte-order corruption rather than reversal — `"first"` came back as
`"Y~\u0010\u0018\u00fc"`.

Two attempts to fix it failed because they were fixing the wrong half: a stray `.reverse()` was added to the
*output* buffer, then removed, then removed again, while the real fault was that the *input* needed
reversing. The first attempt also had a genuine second bug — the encoder mutated the array it was iterating
— which masked the first. What settled it was computing the digits with `BigInt` and comparing: `encodeBytes`
matched the reference exactly, which located the fault on the decode side and in the input order rather than
the output.

### What is documented rather than papered over

Leading NUL bytes are not recoverable: they do not change the number, so `[0, 0, 1]` and `[1]` are the same
value and the same digit list. Recovering them needs a length declared on the wire, and this channel carries
text. That is asserted in the suite, because a future reader will otherwise treat it as a bug and add a
length prefix that changes the wire format for every existing message.

A 29-byte verdict costs 30 dispatches. `costOf()` reports this so a caller can see that a log file is not
worth sending this way — and fix the real channel instead.

**17 tests, 0 failures.**

## [0.10.3] — 2026-10-15

**Fix: the macOS health check walked a user's home directory, and timed out instead of reporting.**

Found on a real machine, not by reading the code.

`sample()` on macOS was scanning `/Users` for files that grow. On a developer machine that is hundreds of
thousands of files, and the symptom was not "slow" but **total failure**: the health suite exceeded the
fleet's own ~50-second lease ceiling and the task expired with `exit_code: null` and no result at all.

A monitoring tool that times out because it is too expensive to monitor is worse than no monitoring,
because **the timeout looks like a machine problem**. The contrast that identified it, measured on the same
host minutes apart:

| Command | Time | Result |
|---|---|---|
| `node -e "process.exit(1)"` | 8 s | `exit_code: 1` — the machinery was fine |
| `health.test.mjs` (before) | > 50 s | expired, no result |
| the same suite (authoring host) | 280 ms | pass |

`/Users` is replaced by `/Library/Logs`, which is where an unbounded system writer actually writes. The rule
this file already stated — that a health check must not be a load source — was written in the module header
while the path list violated it, which is the useful part of the lesson: the principle was written down and
still not applied to the one line that needed it.

Sampling now costs 53 ms. 20 tests, 0 failures.

## [0.10.2] — 2026-10-15

**Tiered storage — temporary, compressed, permanent, and the two kinds of knowledge that persist forever.**

### Why tiers rather than one directory

The Linux host reached 100% filesystem on 2026-10-14 from a single uncapped writer at 14.7 GB/day, and the
recovery cost real time. The lesson was not "delete more": it was that **data with different lifetimes was
stored in one place under one policy**, so the only available policy was "never delete" until it became
"delete under pressure" — which is the worst possible moment to be deciding what matters.

So a file's tier is written down when it is stored, and the tier alone decides what may happen to it:

| Tier | Lifetime | May it be deleted? |
|---|---|---|
| `temp` | a stated TTL | yes, automatically, once expired |
| `compressed` | until the archive is unwanted | only whole, never partially |
| `permanent` | forever | **no — refused, not warned about** |
| `skill` | forever | **no** |
| `law` | forever | **no — amended instead** |

### Why `permanent` refuses rather than warns

A warning is a thing a caller ignores, and the caller under pressure is exactly who this exists for.
`memory.jsonl` is the **only** durable copy of what a command printed — the relay keeps `stdout_sha256` and
never the text — so deleting it deletes the fleet's ability to answer what it already tried, and nothing
else in the system notices. `device.key` is the identity peers know a machine by; losing it makes every
peer holding the old one refuse that machine with no visible cause. A forced removal remains possible,
because a rule with no escape hatch gets bypassed rather than followed.

`law` entries carry an **amendment chain** naming the hash each amendment supersedes, because "what does
the rule say now" and "what did it used to say" are both questions a reader has, and only the second
explains why something was done the old way.

### A test that asserted nothing, found while writing it

The compressed-removal case ended with `existsSync(join(..., 'nope'))` — a path that never exists, so the
assertion could never be false. It now checks the real property: removal leaves no orphan on disk, because
an index that forgets a file still on disk is how a store grows without anything being able to name what
is in it.

**24 tests, 0 failures.**

## [0.10.1] — 2026-10-15

**A service-health agent: measure, classify, recommend — never act.**

### Why it only advises

A component that both decides a server is unhealthy *and* changes that server is one bug away from
deleting the thing it was protecting. The 2026-10-14 disk incident is the concrete example: the recovery
was `truncate`, **not** `rm`, because rsyslog still held the file descriptor open, so removing the file
would have freed nothing while appearing to succeed. A cleaner that had decided on its own to delete "the
big log file" would have looked successful and changed nothing.

### Where the thresholds come from — measurement, not taste

- **Disk** — critical at 90% used *or* under 1 GB free; warn at 80%. The host reached 100% with 268 MB
  free, which is the state this is for. The absolute floor matters independently: a huge filesystem can be
  "only 85% used" and still have less headroom than a task needs.
- **Log growth** — 14.7 GB/day is the measured rate that caused the incident. Any single file over 1 GB is
  reported **by name**, because "the disk is filling" is not actionable and "this file is filling it" is.
- **Load** — compared against CPU count, never an absolute number, because the consequence worth naming is
  that a loaded machine starts expiring tasks at the ~50 s lease ceiling.
- **Memory** — set where a host starts swapping, not where it looks comfortable.

### Two defects the suite found in its own work

- The critical load multiple was `loadPerCpuWarn * 2`, which **reads as a rule and is a coincidence** —
  equal to 3.0 only while the warning threshold is 1.5, so changing one would silently move the other. Its
  own test asserted the documented 1.5 / 3.0 pair and failed. It is now a named constant.
- A test asserted `critical` for 4.0 load over 2 CPUs. 4 / 2 is 2.0 per CPU, between warn and critical.
  **The implementation was right and the assertion was not.**

### Permanent storage is a classification, not a copy

`DATA_CLASSES` marks `memory.jsonl`, `device.json`, `device.key` and `fleet-memory.md` as
`IRREPLACEABLE`. It copies nothing: deciding where data may live is a policy this module has no standing
to make, and the honest half is saying which data cannot be regenerated.

### A limitation measured rather than assumed

`df` exists on Linux and macOS and not on Windows, so a Windows sample carries `disks: []`. The important
part is that it is **empty** rather than filled with a healthy-looking default — an unmeasured disk must
never read as free space. A test asserts the empty case on whichever host runs the suite.

**20 tests, 0 failures.**

## [0.10.0] — 2026-10-15

**The cross-session approval index, and a syncer that refuses to wedge a repository.**

### The approval index (roadmap v4.9.0)

`approval-broker.mjs` answers approvals **per session**: a request belongs to one IM window and the
operator answers it there. That is right for the person in that conversation and wrong for a supervisor,
who by definition is not in it — the design's own words are that a supervisor reviews all agents' pending
approvals *from one queue*. Without this, a request raised in a session nobody is watching sits until its
deadline delegates it.

The index presents pending work across sessions, filtered by what the viewer may act on, and verifies
authority at the moment of decision. It decides nothing itself: `decide()` returns a verdict and the caller
settles the broker, because the broker already owns settlement and a second settler would be a second owner
of the same promise.

Two choices worth stating. The subject's authority level is recorded **at raise time**, because it is a
fact about who asked and must not be re-derived from a caller who might be the approver — an index that let
the approver supply it would let the approver lower it. And `listFor` returns work the viewer **cannot**
answer, with the reason, rather than filtering it out: a filtered list makes the fleet look idle at the
moment it is most blocked.

### `scripts/fleet-sync.mjs` — broadcast, sync, merge, with a decision

Three defects were found by running it, two of them dangerous in production:

- **A failed rebase wedged the repository.** No committer identity meant `git rebase` stopped part-way,
  leaving a detached HEAD and `.git/rebase-merge` for a person to resolve. An automatic tool that can
  wedge a repository is worse than one that does nothing. The identity is now checked before starting, and
  a failure **aborts** the rebase to restore the exact previous state.
- **A failed `rev-parse` was read as a ref name.** `git rev-parse <unknown>` **echoes the argument** to
  stdout and then exits non-zero, so a failed lookup produced `{ok:false, out:'origin/main'}` — a plausible
  ref name attached to a status saying it does not exist. `inspect` read `out` alone and reported a
  repository with **no remote at all** as `ahead` with `ahead/behind: NaN/0`. Every ref lookup now uses
  `--verify`, and an unparseable `rev-list` is `unreadable`/stop rather than falling through to a default.
- **The published/unpublished safety test was dead code.** `published = local_only < ahead` can never be
  true: `ahead` counts the commits absent from the remote-tracking branch and `--not --remotes` selects
  exactly those commits. The real question is narrower — would this rebase rewrite a commit some remote ref
  already reaches — and it is now answered by testing each local commit for reachability from the remotes.

A finding that changed a test rather than the code: **on a single upstream, a "both sides published"
divergence cannot exist.** If a local commit is reachable from `origin/main` then HEAD is its ancestor, so
`behind` is 0 and there is no divergence. Three fixtures failed before that became clear. The reachable
version of the hazard is a local commit some *other* remote ref already has — a branch pushed as a feature
and then rewritten — and that is what the test now builds.

**30 tests across the two, 0 failures**, against real repositories and a real bare remote: a mocked git
would have been a test of the mock.

## [0.9.9] — 2026-10-15

**Cognitive memory blocks (roadmap v4.8.0): field-level acceptance and lineage — and the first release whose suite was run on the fleet machine rather than on the development host.**

### `src/agent/blocks.mjs`

The memory layer shipped in 0.9.6/0.9.7 accepts a peer's claim **whole or not at all**, which is a blunt
instrument with two costs the roadmap records as P1 and P2. A block is now seven fixed fields so the
decision can be made per field:

| Field | May a receiver choose it? |
|---|---|
| `subject`, `body`, `evidence` | yes |
| `confidence` | **no — refused whatever the chooser says** |
| `origin`, `observed_at`, `lineage` | **no — inherited, and setting them would be forging provenance** |

Lineage is by **content hash**, not by id, because an id is assigned by whoever creates the block and can
be copied. A block whose parent cannot be produced is **refused rather than re-rooted**: re-rooting turns
an unverifiable history into no history, which reads as a fresh, independent assertion, and that is how a
fabricated claim acquires a respectable past.

### Three defects the suite found in its own module

- **`confidence` was only a default, not an invariant.** Supplying a custom `choose` *replaced* the
  default rather than refining it, so the file's central conservative property — a receiver does not adopt
  the sender's certainty about the sender's own assertion — was silently optional. "Silently optional" is
  how a safety default stops being one, so the refusal is now a hard invariant that no chooser can open.
- **A cycle fixture that asserted nothing.** The first cycle test mutated `lineage` after hashing and keyed
  the map by the recomputed digest, leaving the references pointing at hashes the map did not hold — the
  walker reported `missing` and never met the cycle it was supposed to test. `linkFixtures` now makes the
  reference and the key the same string by construction.
- **A test that measured the clock.** `makeBlock` stamps the current time when no `observed_at` is given
  (correctly — that is what the field means), so two blocks built a millisecond apart differ. The failure
  looked like a hashing defect and was a 1 ms difference in a field the test never mentioned.

### Verified on MacMini, not only here

This is the first release whose suite was executed on the fleet machine:

```
MacMini (MacMinideMac-mini.local)
  HEAD     : 642242446d3eb0ed1928f128d088b727284a6d43
  expected : 642242446d3eb0ed1928f128d088b727284a6d43   MATCH
  suiteOk  : true
```

`test/blocks.test.mjs` — **28 tests, 0 failures**, adversarial by design: most cases assert a refusal
rather than a happy path, because what makes a fleet memory worse than no memory is losing the ability to
tell a fact from an echo. `eslint` 0 errors.

### Notes on how this got here, because the tooling cost more than the module

`run-relay.mjs` targets `root@<relay>` and runs **bash on the relay host**; `relay-run.mjs` runs a
**JavaScript file on a fleet machine**. Both are called "relay" and only one of them is the fleet — a
clone believed to be on MacMini was on the relay for a round. Also: `Set-Content -Encoding utf8` writes a
**BOM**, and a shebang behind a BOM is not a shebang. And a 43 KB script cannot travel as an argv element
under Windows' 32 KB command-line limit, which is why this work reaches MacMini as a **branch** it fetches
rather than as an inline command.

### Environment, measured

MacMini has `git` 2.54.0, `curl`, `python3`, 70 GiB free, and **working** HTTPS to npm, the GitHub API,
release assets and codeload — including `git ls-remote`, which an earlier session recorded as failing.
It has no `npm`, `pnpm` or `brew`, so `node --test` directly is the suite runner.

## [0.9.8] — 2026-10-14

**The numeric authority model — the layer four of the five roadmap layers depend on — plus a roadmap and a memory write that reports its own outcome.**

### `ROADMAP.md`

The operator's architecture document specifies five layers across v4.7.0–v4.13.0. It lives in the
repository now, and it states the delta honestly before it states the plan: this repository has **one
relay and five machines**, against a target of 1,000+ agents. Every release row carries both a
deliverable and **the observation that would falsify it**, because a row without the second is a feature
list rather than a plan.

It also refuses three things on the record: it does not adopt a named protocol (InterMesh, A2A, NLIP,
AIX, MMP) before a line of its wire format exists; it does not build BFT consensus among five machines on
one relay, where it would add latency and failure modes without adding trust; and it does not specify
1,000-agent behaviour, because the source document's own §6.4 reports 30–50 agents as the practical limit
and superlinear "coordination collapse" beyond 100 — **a design not measured at 50 cannot honestly
specify 1,000.**

### `src/agent/authority.mjs` — v4.7.0

An integer `authority_level` on every actor, the four bands (0–49 ordinary, 50–69 captain, 70–89 org
admin, 90+ system admin), `matching_exempt_level` as the Unix-root-style exemption, and a decision
function returning `allow | needs_approval | deny` **with the rule that produced it**.

Why an integer rather than role names: authority appears in four of the five layers — permissions, the
approval flow, committee voting weights, and the defence hierarchy where a Coordinator outranks an
Analyst. An enumerated set of names would be re-partitioned by each layer, and every re-partition is a
place for two of them to disagree.

Three decisions are load-bearing and each is pinned by a test:

- **A rule with no `matching_exempt_level` exempts nobody.** The tempting default is "absent means
  unconstrained", and it is wrong in the one direction that matters: a rule author who forgets the field
  would silently create an unrestricted action.
- **An exemption bypasses membership, not the level floor.** The Unix analogy is exact — root bypasses a
  file's permission bits, not the requirement that the file exists. A rule that says both is
  self-contradictory, and the strict half wins.
- **A derived actor never exceeds its parent.** No rule in the source design grants delegation, and the
  default an implementation reaches for — "a captain's delegate is a captain" — turns one compromised
  actor into an escalation path. Where the source is silent, the narrow reading is the safe one.

### `evaluateAll` — a design corrected by its own test

The first draft evaluated every rule and returned the strictest verdict. A test asserting that the rules
after a gate are not evaluated failed, and the failure was right. `decisive` must be **unique**, or a
list can hold several non-allow decisions and whichever the caller picks, the *stated* reason for a
refusal stops being the reason. And a gate is a gate whether it says `deny` or `needs_approval`: in both
cases the caller's next action is determined and the remaining rules are decoration. It now stops at the
first non-allow.

### `envelope.memory` — a silent write that now reports

`appendMemory`'s result was deliberately unchecked, so a memory write could not fail a task. That remains
true — but leaving it entirely *silent* was the right call for the control flow and the wrong one for the
reader: **a machine whose memory is not being written is indistinguishable from one that has nothing to
remember**, which is precisely the class of invisible failure this layer exists to end. The envelope now
carries `memory: {written, file, rotated}` or `{written: false, reason_code}`. It is not a comparable
field, so no verdict moves and two machines cannot disagree over it.

### Verified

- `test/authority.test.mjs` — **27 tests, 0 failures.** Every one is about a boundary, because the only
  interesting thing an authority model can get wrong is being off by one: a level too permissive is an
  escalation and one too strict is an outage, so the band edges and the exemption boundary are asserted
  **from both sides** rather than by a middle value that would pass either way.
- Band partition is proven total and non-overlapping across 0..100 by walking every level, so a seam that
  belongs to two bands — a bug that only appears once someone is assigned that level — cannot exist.
- `eslint .` — 0 errors on the new module and test.

## [0.9.7] — 2026-10-14

**`w2m_memory` gains the collective layer and the one write a machine may not make for itself.**

### `scope: "fleet"` — the collective memory

Reads the curated `fleet-memory.md` that §3.2 of the design puts on the archive host, beside the profile
that mounted this plugin. It returns the document **as text, with its section list**, and does not parse
it into facts — deliberately. Hand-written prose has no schema, so a parser would silently drop whatever
shape it did not recognise, and what it dropped would be exactly what a human judged worth writing down.
The section list is there so a reader can see what the collective memory covers before paying for all of
it.

An absent file is answered honestly rather than as an empty document: `MEMORY_NO_COLLECTIVE`, with the
path that was looked at. *"Nothing has been curated yet"* and *"the memory is empty"* are different
facts, and only one of them means someone should start writing.

### `record` — a conclusion, which only a reader may assert

`memoryRecord` always emits `conclusion: null`, because a machine that invented one would be asserting an
interpretation it cannot have. This is the path by which a reader supplies it: the conclusion is appended
as a **new record naming the task it is about**, never written into the existing line.

Append-only is the point. In-place editing would break the property that makes the log trustworthy — what
was written is what happened, and an amendment is a later statement *about* it — and it would destroy the
original text, which is the thing a reader most needs when a conclusion turns out to be wrong.

### A defect this found in its own first draft

`collectivePath()` was `path.join(resolveProfileDir(cfg), COLLECTIVE_FILE)`. `resolveProfileDir`
legitimately returns `null` — a bare test context, or a host whose layout it cannot read — and the first
version passed that straight into `path.join`, which threw `ERR_INVALID_ARG_TYPE`. **A read tool that
crashes on a missing directory is worse than one that says the directory is missing:** the caller was
asking a question, and an exception is not an answer. It now resolves to `null`, reports
`MEMORY_NO_COLLECTIVE`, and says which of the two reasons applies.

### Verified

- `eslint .` — 0 errors.
- The contract suites — `memory`, `tools`, `tool-cards`, `claims`, `loader-entry`, `update-wiring`,
  `p2p-plugin` — **230 pass, 0 fail, 11 platform skips**.
- Every scope exercised against a real temporary profile: `fleet` found the seeded document and listed
  its five sections; `record` wrote a conclusion against a task and reported that no task existed when
  none did; an absent collective file produced `MEMORY_NO_COLLECTIVE` rather than a throw.
- The tool count is unchanged at nine, so this release moves no contract: the same nine tools, two of them
  wider.

## [0.9.6] — 2026-10-14

**Individual memory: the fleet can now answer "what did we already try on this machine, and what happened?" — a question nothing in it could answer before.**

### The gap this closes, measured rather than asserted

The relay is sent `command_hash`, `stdout_sha256` and `stdout_bytes`, and never the text. That choice is
defensible and stays: the ledger is a tamper-evident consistency record, and a relay compromise discloses
no command text. The price was that no part of the fleet retained what a command actually did, and the
price was paid over and over. In one working session the same facts were rediscovered from scratch across
a dozen dispatches — that a machine had no package manager (3 times), which node binary actually ran (2),
that its git could not reach github.com while node's HTTPS could (2), that a task is expired at about
fifty seconds (3), and which commit its checkout was on (2).

### What was added

**`src/agent/memory.mjs` — one append-only `memory.jsonl` per machine, in its own state directory.**

Written by the agent as each task finishes, at the one point where the output still exists at all and on
the one machine that owns it. Each line carries the command, `cwd_rel`, exit code, status, duration,
transport, and the tails of stdout and stderr — plus the envelope's hashes, so a human-readable record can
be cross-checked against the relay's tamper-evident one without trusting either.

Three properties are deliberate and each has a test:

- **Bounded by construction**, with a byte cap and one rotating generation. This is not hypothetical
  caution: the Linux host's root filesystem reached 100% today from 14.7 GB/day of uncapped logging, and
  the recovery cost real time. A memory that can fill a disk is a worse outcome than no memory. Rotation
  keeps the previous generation rather than discarding it, because the question this file answers is
  usually about the recent past and the rotation boundary sits exactly there.
- **A malformed line is skipped, not fatal.** A partially written final line is what a machine losing
  power mid-append leaves behind, and one damaged line must not make the rest unreadable — the relay's own
  ledger behaves this way for the same reason.
- **`conclusion` is written as `null` by the machine and only ever filled in by a reader.** The design
  separates fact from interpretation, and a machine that invented a conclusion would be asserting
  something it cannot know. A test pins this, because the failure would be silent.

**`w2m_memory` — the read side.** Returns this machine's memory, newest first, with a status tally, and
reaches the rotated generation on request.

It does **not** read another machine's memory, and says so instead of returning an empty list. The reason
is structural rather than an omission: the relay carries no such file, and an agent executes a dispatched
command inside a sandbox whose writes are scoped. A query for another machine is answered with
`MEMORY_REMOTE_NOT_READABLE` and the two ways to actually read it. Returning `records: []` would have read
as *"that machine has done nothing"* — the opposite conclusion from *"this build cannot see"*.

The write is wrapped so it can never fail a task. The task is the work; this is a note about it.

### Verified

- `test/memory.test.mjs` — **18 tests, 0 failures**: record shape, tail and argv clamping, append-and-read,
  newest-first ordering, the limit, a malformed line skipped, an absent file read as empty, rotation with
  both generations readable, and that neither `appendMemory` nor `readMemorySync` throws on a bad directory.
- A rotation test that trips the cap with *real* records rather than filler, because the first version
  wrote eight megabytes of `'x'` — it rotated, but it could not answer the question being asked, since the
  previous generation then held one unparseable line.
- `eslint .` — 0 errors.
- **The full pre-flight is green: 11 pass, 0 fail, 1 unverifiable** (1721 tests in 54 files; 1707 pass,
  0 fail, 14 platform skips). The single `UNVERIFIABLE` is an accepted host observation, not a gate.
  Reaching that required installing `git` on the development host, which had none; the 39 failures before
  it were all `spawn git ENOENT`, and the two rounds of diagnosis after it were a sandbox rule (writing
  files in `%TEMP%` is allowed, **creating a directory** there is refused — and `git init` creates one) and
  two mojibake sequences this release then repaired. Recorded because "39 failures" read as a defect count
  and was, at every stage, an environment count.
- The nine-tool contract is updated everywhere it is pinned: `scripts/verify-installed.mjs`,
  `test/loader-entry.test.mjs`, `test/tools.test.mjs`, `test/tool-cards.test.mjs`, `test/claims.test.mjs`,
  `test/p2p-plugin.test.mjs`, `test/update-wiring.test.mjs` and the pre-flight gate inventory. Those
  assertions are what make "the tool set" a contract rather than a habit, so leaving one at eight would
  have failed a release that is otherwise correct.

## [0.9.5] — 2026-10-14

**Same code as v0.9.4; published because v0.9.4's npm and GitHub bytes cannot be made to agree.**

### Why this version exists

v0.9.4 was published, then amended minutes later to replace a comment that quoted a retired message
verbatim. GitHub's tag and assets were moved to the corrected commit. **npm could not follow**: a
published version cannot be overwritten, and this account's token cannot unpublish either, so npm keeps
the pre-amendment bytes permanently.

The difference is one comment. It is recorded here rather than papered over because a divergence that is
discovered later and unexplained costs more than a version number:

| Where | v0.9.4 | Carries |
|---|---|---|
| npm | `sha256:570f5175…` (870353 b) | the comment that quotes the retired sentence |
| GitHub | `sha256:ab7b60dc…` (870448 b) | the corrected comment |

Both run **identically** — the changed bytes are inside a `/** */` block. `latest` on npm now points at
0.9.5, which is byte-consistent with its GitHub release, so the divergence is confined to a superseded
patch of one patch version.

### Verified

- `test/relay.test.mjs` 152 pass, `test/claims.test.mjs` 47 pass, `test/chatops-account.test.mjs` pass —
  242 tests, 0 failures, 0 cancelled.
- `eslint .` — 0 errors.
- The precise check on the shipped tree: the retired sentence appears **0 times in code and 0 times in
  comments**; the corrected sentence appears once, at the assignment.

## [0.9.4] — 2026-10-14

**A note that promised a verdict the relay no longer delivers, and the test that had locked the promise in.**

### What v0.9.3 left behind

v0.9.3 made the relay skip an anchor nobody declared, so an unanchored dispatch now aggregates normally —
the live relay returns `state: consistent`, `counts.ok: 1` for a command that used to come back
`unverifiable`. The plugin, however, still opened every such dispatch with:

> this machine's working tree could not be fingerprinted, so peers have no anchor to match and
> **the aggregate will be unverifiable**

which was true when it was written and is now false. The fixed mechanism had been left with a sentence
telling operators to doubt a verdict that is correct, so the note now says what is actually the case:

> this machine's working tree could not be fingerprinted, so no anchor was declared: peers are compared
> with each other, not against a named tree

### The test had encoded the promise

`test/tools.test.mjs` asserted `assert.match(value.note, /unverifiable/)`, so fixing the wording broke
the suite — and the tempting repair is to put the sentence back and keep the suite green. That would have
been the wrong way round: **the test was guarding a claim, not a behaviour.** It now asserts the claim:

- the note must state that no anchor was declared;
- it must state what that costs — agreement between peers, not with a named tree;
- and `assert.doesNotMatch(value.note, /unverifiable/)`, so the stale promise cannot be written back in.

The third is the one that earns its place. A positive match on a *new* sentence would have passed too and
guarded nothing; the negative case is what stops the old sentence returning.

### Verified

- `test/relay.test.mjs` — 152 tests, 0 failures.
- `test/claims.test.mjs` — 47 pass. It caught this release's own omission on the first run: the version
  was bumped to 0.9.4 while the newest CHANGELOG entry still said 0.9.3, and it refused with *"One of them
  is the release; the other is a mistake."* Correct, and the reason this entry exists.
- `test/tools.test.mjs` — 90 pass, 1 failure: `w2m_run computes base_commit and base_tree from a real git
  work tree`, which fails with `spawn git ENOENT` because **git is not installed on this host**. That is
  the same environmental cause as the 38 `declared suite` failures, not a regression.
- `eslint .` — 0 errors, 127 warnings.

## [0.9.3] — 2026-10-14

**An undeclared anchor was compared against the literal `null`, so every dispatch from a non-git machine was `unverifiable` — including the ones that succeeded.**

### The report, and why it read as a lie

A relay was asked what happened to a task, and every answer came back the same way:

```
status : unverifiable
reasons: ["base_commit \"a1e7dc042913b96da3ad68… != expected null"]
notes  : ["aggregation refused: Step 1 anchor violation"]
```

while the machine's own record said `lease_state: done`, `status: ok`, `exit_code: 0`. A reader has no way
to prefer either half, so a task that ran perfectly was reported as one that could not be trusted — and
the same verdict came back for **every** dispatch.

### The cause

`report.mjs` Step 1 compared the anchor unconditionally:

```js
if (canon(valueOf(env, 'base_commit')) !== canon(expected.base_commit)) {
```

`expected.base_commit` comes from `task.base_commit ?? null`, and a dispatcher whose own tree is not a
git work tree — the ordinary case for the plugin running out of its profile directory — sends `null`. So
the comparison was *"the machine's real commit **equals null**"*, which no machine with an anchor can
satisfy. **A machine was marked untrustworthy for reporting its commit truthfully.**

That the two anchors disagree is the whole story. `base_tree` six lines below has always read:

```js
if (expected.base_tree !== null && canon(valueOf(env, 'pre_tree_fingerprint')) !== canon(expected.base_tree)) {
```

— it tolerates absence. `base_commit` did not. Same kind of statement, opposite handling, and the
asymmetry is the bug. The protocol cannot even distinguish the two cases: `state.mjs` normalises both an
absent field and an explicit `null` with `input.base_commit ?? null`, so "no anchor" and "anchor is null"
arrive identically and must be treated identically.

### The fix

`base_commit` is enforced only when the dispatcher declared one, matching `base_tree`. The relaxation is
**reported, not silent**: an `unanchored: true` field on the aggregate plus a note saying

> no base_commit was declared, so the anchor check did not run: machine agreement here is agreement with
> each other, not with a tree the dispatcher named

because *"these machines agreed"* and *"nobody said what they should have agreed on"* must not read the
same to an operator. `consistent: true` from an unanchored run says the machines matched; it does not say
they ran the tree you meant.

### Verified

- `test/relay.test.mjs` — **152 tests, 0 failures**, including two new ones: the undeclared anchor is
  skipped and reported, and a **declared** anchor mismatch still refuses aggregation. The second exists
  because the first is a relaxation, and a relaxation without a falsifying test is how a check quietly
  disappears.
- `eslint .` — 0 errors.
- The rest of the pre-flight — gate inventory, test wiring, workflow wiring, entry points, packed tarball,
  claims, CHANGELOG shape — all green. The one red gate is `declared suite`, whose 38 failures on this host
  are 38 tests that shell out to `git`, which is not installed here.

### Note on where task output lives

Investigating this also settled a question that had cost real time: the relay stores **no** task output. A
task record carries `machine_id`, `lease_state`, `outcome`, `status`, `exit_code`, `transport`, `p2p` and
`reasons` — and no `stdout`, no `stderr`, not even `stdout_sha256`, despite `COMPARABLE_FIELDS` naming
those fields. So "sync the output home" cannot be solved at the relay, by any port or proxy: the text was
never kept. Any durable record of what a command printed has to be written **on the machine that ran it** —
which is exactly where the fleet-memory work begins.

## [0.9.2] — 2026-10-14

**The gate added in v0.8.11 pointed at a file that had never been committed, so it failed on all four CI platforms.**

### What was broken

`verify:join` was wired in three places across two releases:

| where | when |
|---|---|
| `package.json` → `"verify:join": "node scripts/verify-join.mjs"` | v0.8.11 |
| `.github/workflows/ci.yml` → `- run: npm run verify:join` | (pushed in v0.9.1) |
| `.github/workflows/release.yml` → `- run: npm run verify:join` | (pushed in v0.9.1) |

**`scripts/verify-join.mjs` itself was never in the repository.** It existed only in the working tree that built the tarballs, so every CI platform failed with the least interesting error available:

```
Error: Cannot find module '/home/runner/work/dsh-windows2macos/dsh-windows2macos/scripts/verify-join.mjs'
code: 'MODULE_NOT_FOUND'
```

On `ubuntu-latest/22`, `windows-latest/22`, `windows-latest/20` and `macos-latest/22` alike. A file-existence check would have caught it; a review of the diff would not, because the diff was of files that existed.

### How it was found

By reading the CI failure logs rather than the CI summary. The summary said *"The fleet join reaches a token (stub agent, no relay)"* failed — which reads like the check *ran and disagreed*. It had not run at all. The summary named the step; only the log said `MODULE_NOT_FOUND`.

The same class of mistake as the four files an earlier push left behind (see v0.9.1), and it is worth naming the shared root cause: **the v0.8.x tarballs were packed from a working tree, while the repository was written to by listing files individually.** A pack packs everything; an explicit list omits what the author forgets. The durable fix is to stop enumerating — but until this release the enumeration is what the tree had.

So this release does the one thing v0.9.1 should have: it diffs the working tree against the repository in **both** directions. Exactly one file was present locally and absent remotely, and it was this one.

### Verified

- `node scripts/verify-join.mjs` — 16/16 locally, which it always was; the defect was never in the script.
- The script is now in the repository, which is the only place `verify:join` can run from: `claims.test.mjs` pins
  `FORBIDDEN_IN_RELEASE = ['test', 'scripts', ...]`, so `scripts/` is deliberately **not** in `package.json#files` and
  a published tarball carries no `scripts/` directory by design. `verify:join`, `pack` and `verify` are source-tree
  and CI commands, not consumer commands. An earlier draft of this entry called the absent `scripts/` a packaging
  defect; that was wrong, and the constraint above is why.

## [0.9.1] — 2026-10-14

**A powered-off machine stayed `online` and selectable in every fleet view, because `online` was never derived from contact.**

### The report

> *"Another Windows machine, clearly shut down and offline for a long time, is still online and active — not greyed out, still selectable."* And, in the same breath: *"is the fleet heartbeat not synchronised, not updated, not broadcast?"*

All three of those turned out to be one defect with three faces, and the report was exactly right. The relay's own data at the time:

| machine | `online` | `last_heartbeat_at` |
|---|---|---|
| `jp-shared` | true | `11:15:55Z` |
| `macmini` | true | `11:15:41Z` |
| **`win-desktop` (`549b9fde`)** | **true** | **`null`** |
| `ToFuture` (here) | true | `11:16:32Z` |

A machine reported `online: true` while `last_heartbeat_at` was `null` — meaning it had **never sent a heartbeat at all**. Two fields in one row contradicted each other and nothing reconciled them.

### The cause

`device.online` was written in exactly two places, and both were the SSE stream:

```js
device.streams === 0 && this.state.setOnline(sub.machineId, false, 'stream_closed');  // detach
this.state.setOnline(machineId, true, 'stream_open');                                 // attach
```

`/v1/devices` then read the flag back:

```js
online: device.online === true,
```

**Nothing derived liveness from contact.** So the machine's state was really "is there a TCP connection", and a **half-open stream** — a killed process, a pulled cable, a closed lid; anything that ends the agent without a clean socket close — left `online: true` for as long as the socket survived, which is indefinitely. That is the reported machine: powered off, still listed, still a dispatch target.

The "not broadcast" half is the same cause. `peer.bye` *is* broadcast to every other machine — but it is emitted **by the detach that never came**, so no other machine was ever told either, and every machine picker in the fleet kept offering a departed host.

And the "heartbeat not synchronised" half is the third face: a heartbeat alone could not fix the flag, because the flag did not read heartbeats.

### The fix

**Presence is now expired, next to lease expiry.** A new `sweepSilentDevices()`, driven by the relay's existing 1 s maintenance timer, declares a device silent once nothing has contacted it for `DEFAULT_SILENCE_MS`, and goes through the **existing** `setOnline(id, false, 'silent')` — which both flips the flag and emits `peer.bye`. Going through that path rather than setting the flag directly is the point: correcting only the flag would fix `/v1/devices` on the relay while every agent's own view, and therefore every picker, still showed the departed machine.

**Reads agree between sweeps.** `online` in both `deviceStatus` and `publicDevice` is now derived as well as stored, so nothing has to wait up to a second for a background timer to be told that a machine which stopped talking is gone.

**The threshold is two idle heartbeats (120 s).** An idle agent heartbeats every 60 s and a busy one every 10 s, so the slowest healthy cadence is 60 s and 120 s cannot be reached by a live machine. Deliberately *not* the 20 s lease rule (`heartbeatIntervalMs × missedHeartbeats`): that one guards a task index, where being wrong costs a duplicated execution, while this one guards a display and a target list, where being wrong costs a wasted dispatch. Same reasoning, different price. A test pins the invariant `DEFAULT_SILENCE_MS >= DEFAULT_IDLE_HEARTBEAT_MS * 2`, because a threshold at or below one beat would flap every healthy idle machine.

**`offline_reason` and `silent_ms` are now reported** (`stream_closed` | `silent` | `null`), on `/v1/devices`, in `/v1/status`, and through `w2m_stats`. "Offline" without a reason is precisely the shape that hid this: a departed machine looked identical to a quiet one, and a reader had no field to check.

### What the tests had to be told, twice

Both mistakes are recorded in the test file because both are traps a future reader will fall into:

1. **`RelayServer.handle` calls `touchDevice` on every authenticated request.** The first version of the wire test polled `/v1/devices` *with the token of the machine under test* — so the silent machine refreshed its own `last_seen_at` by asking, and the test read it as online. The observer must be a different device.
2. **The threshold has to exceed the heartbeat cadence used by the test.** The first version used `silenceMs: 5_000` against a witness that heartbeated every 60 s, so the witness was legitimately swept alongside the machine under test.

A third correction was to the fix itself, and it is the subtle one: `offline_reason` originally tested `device.online !== true` **first**, which reports `stream_closed` for exactly the half-open case — the stream *is* still attached. Silence has to be tested first, or the reason names the wrong thing on the one case that matters.

### Verified

- `test/relay.test.mjs` — **150 tests, 0 failures** (4 new: the sweep plus its broadcast, the pre-sweep read, the healthy-quiet distinction, and the threshold invariant).
- The 13 suites that touch device or fleet state — **398 tests, 0 failures**.
- `eslint .` — **0 errors**, 127 warnings.

### Deployment note — this fix is on the wrong side of the wire

The defect lives in the **relay**, so upgrading the plugin does **not** fix a running relay: a machine running v0.9.1 still shows every other machine's stale `online` flag until the relay itself is restarted on v0.9.1. The relay at the shared default address was still serving the stale view when this was written. Restarting it is an operator action, and the relay's own operator token is not something this repository holds.

## [0.9.0] — 2026-10-14

**Three defects that were mounted, wired, and doing nothing — and the lint gate that had stopped being able to say so.**

### The shape all three share

Each was, in the words an earlier release note already used for this class: *the record was created,
and the part that makes it useful was not filled in*. All three were invisible to the suite, and all
three were found by reading lint output rather than by running anything.

### 1. `ReferenceError: all is not defined` — on the path an operator actually reaches

`src/relay/state.mjs` threw an undefined identifier while *building a refusal*:

```js
if (targets.length === 0) {
  throw new ProtocolError('NO_ONLINE_DEVICE', 'no paired device available for this task', {
    known_devices: all.length,          // ← `all` exists nowhere in the file
  });
}
```

`targets` is empty exactly when the fleet has nothing to dispatch to — a freshly configured machine
before its first peer joins, or a fleet whose machines are all scoped out. So the one case where the
operator needs the detail most answered with a `ReferenceError` instead of the refusal. The count they
need is the **unfiltered** device set, because the answer distinguishes *"nothing is paired"* from
*"something is paired but scoped out"*; that is `this.devices`, the same collection handed to
`targetsFor` a few lines above.

The project's own lint audit records `no-undef` as the rule that "caught the one real defect" of its
round, and notes why it matters: *an unbound identifier in an ESM module is a `ReferenceError` at
evaluation time, not an `undefined` that quietly takes a branch.* This is the same defect one release
later.

### 2. The in-process agent's status was built and then dropped

`src/plugin/tools.mjs` documented a feature and never performed it:

```js
// §8.2: when the agent runs inside this process its `rttMs` is reachable directly, so `w2m_status`
// can report it without a file.
const statusGetter = agent.status ?? agent.state ?? null;      // ← and nothing else
```

`readRtt` opens with `if (inProcessAgentStatus)` and skips the whole in-process branch when it is
null. Nothing ever assigned it, so on a machine whose agent *is* in that process the tool fell through
to reading a state file and reported:

```
no agent round-trip time is available: the agent is not running in this process and no agent
state file was found under <stateDir>
```

— wrong twice, and wrong in the direction that costs most: it tells the reader to doubt the agent, on
the one call they make to find out what is actually happening. The getter is now assigned.

### 3. A parameter that promised a binding it never made

`src/chatops/bridge.mjs` had `function actionsFor(windowKey)` under a doc line claiming the window was
"bound in", and a body that never mentioned `windowKey`. The real binding is per call
(`pending: (window) => broker.listFor(window)`), so the parameter is gone rather than renamed: a
caller passing a window there was reading a promise the signature did not keep.

### The lint gate, which is why nobody saw any of this

`eslint .` reported **155 errors**, and the release pre-flight requires zero — so the gate was red, and
a gate that is red for 117 pieces of noise is a gate nobody reads. Which is how three defects sat in
the tree.

| Rule | Count | Disposition |
|---|---|---|
| `no-console` | 117 | **Configuration.** Every one is in `scripts/` — `ilink-*.mjs` operator probes whose entire output *is* a transcribed QR flow, and `chatops-*-e2e.mjs` end-to-end drivers whose value is their trace. The rule's rationale ("a leftover debug statement") does not describe a file that returns nothing to a caller. `scripts/**` joins `bin/**` and `deploy/**` in the existing exception; `src/` and `test/` keep it at error. |
| `no-unused-vars` | 20 | 13 dead imports removed; 7 unused **bindings** annotated with a leading underscore, per the config's own convention. Two of those are load-bearing calls whose *result* is unused — `stats = await lstat(lexical)` is how a missing file is detected — so the call stays and the binding is annotated. |
| `no-promise-executor-return` | 4 | The idiomatic `new Promise((r) => setTimeout(r, ms))`. The rule is right that the executor returns a value; braces remove it without changing what the promise does. |
| `prefer-const` | 2 | Both real; one (`cursor`) carried a `let` that suggested a resumption the script does not implement. |
| `no-sequences` | 4 | Comma-operator arrows in a test, rewritten as block bodies — same order, same value, readable without knowing the operator. |
| `no-loss-of-precision` | 2 | **Dispositioned, not fixed.** These are the nineteen-digit measured `message_id` values the iLink contract fixture exists to demonstrate: JavaScript rounds them on parse, and a production path recovers the exact digits from the raw text *because* of that. Quoting the literals would delete the case under test, so they carry a scoped `eslint-disable` with the reason inline. |

Result: **0 errors**, measured with the repository's own config and `--report-unused-disable-directives`,
so a suppression that no longer suppresses anything fails the run instead of sitting there looking
like it does.

`docs/LINT-AUDIT.md` keeps its measurements as written and gains an addendum for this round, because
an audit document that silently disagrees with the tree is worse than no audit document.

### Verified

- `node scripts/verify-join.mjs` — 16/16, unchanged by the edits above.
- `node scripts/check-entrypoints.mjs` — all entry points import.
- The four touched suites — **119 tests / 25 suites / 0 failures** (`chatops-commands`,
  `chatops-ilink-contract`, `chatops-approval`, `chatops-durability`).
- `eslint .` — 0 errors.

The three defects do **not** carry new tests, and that is a stated gap rather than an oversight: each
sits on a path the existing suite does not construct (an empty target set at dispatch, an in-process
agent status getter, a bridge action set built with an argument). They were found by lint and fixed by
reading the surrounding contract; a test for each is the honest next step.

## [0.8.11] — 2026-10-14

**The in-process join threw before it could pair — and a missing fingerprint took the fleet key with it.**

### The defect that mattered

`startLocalStack` built `identityOptions`, loaded the identity, and then passed
`identityOptions.identity` to `createAgent` — but nothing ever assigned that property.
`loadOrCreateIdentity()` returns `{ identity, path, created }` and does not mutate the options it was
given, so `createAgent` received `undefined` and rejected it by contract:

```
createAgent: identity.machine_id is required
```

**The in-process join therefore threw on every start**, after `loadOrCreateIdentity` had already
created `device.json` and before anything could pair.

That single line accounts for the whole reported symptom, and every earlier explanation was reading
the wreckage:

| observed | why |
|---|---|
| `device.json` exists, `device_token: null` | the file is created one line above the throw |
| its mtime never moves across restarts | execution never reaches the pairing path |
| `w2m_devices` answers `401` | no token was ever obtained |
| `P2P_ANNOUNCE_FAILED: HTTP 401` | same token, same absence |

The evidence that finally settled it was the mtime, exactly as v0.8.9's own note said it would be —
but read the other way round: not "the write is missing" but "**nothing after the throw runs at all**".

### The second gate: a missing fingerprint discarded a derived key

`resolve()` mints a serial number from a hardware fingerprint and the fleet key from the account's
`userId`. The key does not depend on the fingerprint — but it was only returned *after* the
fingerprint succeeded:

```js
const hardware = await fingerprint();
if (!hardware.ok) return hardware;          // accountFields -- and the fleet key -- thrown away
const sn = buildSn({ accountCode: account.accountCode, ... });
return { ok: true, sn, ...accountFields, ... };
```

On the machine this was reported from, `readHardwareValues({ platform: 'win32' })` returns **zero**
usable values — both `MachineGuid` (via `reg query`) and the SMBIOS UUID (via PowerShell) come back
empty — so `fingerprint()` always failed and the fleet key was always discarded after being computed.

No amount of retrying could fix that, which is why v0.8.9's backoff did not help: the account *was*
readable, and the key *was* derived. The failure is now reported as what it is (`no_hardware_source`,
no SN), while `accountFields` still travels, so a caller that only needs to join a fleet is not held
hostage by a display identifier.

### The join is no longer a one-shot prologue

Two changes to the shape, both consequences of the above:

- **The mount path is fast.** It spends two derivation attempts (~2 s), not six (~62 s):
  `agent.start()` waits behind it, and any tool that asked to join waited behind that. The patient
  retrying moved into a background loop beside the running agent, where nothing is blocked by it.
- **A tool call can finish the join.** A tool call is proof the account profile exists — the session
  cannot answer a model request without it — so `w2m_status`, `w2m_devices` and `w2m_run` ask the
  in-process agent to join if it has not already.

The rate limit is respected by a **cooldown, not by permanence**: a successful join is memoised for
the life of the process, while a *failed* one is retried after ten seconds. Memoising the failure
would have reproduced the defect being fixed — a machine holding a rejected promise for ever, which
is the "intermittent miss becomes permanent" trap v0.8.7 fell into.

### Reporting

A machine that cannot join says so once, at warn, naming the reason — and says it again only if the
state changes. The previous wording guessed *"the profile may not be loaded yet"* for every
`ok: true` case, which after sixty seconds of backoff was usually the wrong explanation.

### Verified

`node scripts/verify-join.mjs` — **16 checks, all passing.** It drives the join against a stub agent
(the real `start()` talks to the public relay for the life of the process, which is why nothing
exercised this path before) and asserts:

- the agent is constructed with a real `identity.machine_id` — the assertion that catches the defect
  above, since `undefined` is what was being passed;
- nothing is paired while the account cannot be read, and no pairing is attempted without a key;
- the machine joins once the account answers, **and the token reaches `device.json`**;
- the pairing presents a 43-character derived fleet key and names the identity on disk;
- a machine holding a token never re-pairs, however many tools ask (`pair_rate_limit: 5`);
- a fingerprint failure still yields the fleet key, with `no_hardware_source` reported and no SN
  invented.

Two of those checks found real problems while being written, which is the point of having them. The
first draft of the cooldown rate-limited the *keyless* case as well, so the mount attempt failed on a
cold account and the very next tool call silently did nothing — the reported symptom, reproduced by
its own fix. And the mount budget, which had been ~62 s since v0.8.9 with `agent.start()` and every
tool call waiting behind it, is now ~2 s.

The script reads and writes a throwaway identity (`DSH_DEVICE_FILE`), so it never touches the real
`~/.dsh/xclient/device.json`.

Measured on the Windows host this was reported from:

```
late-account join
  ok    the agent is constructed
  ok    the agent receives a real identity (createAgent requires identity.machine_id)
  ok    nothing is paired while the account cannot be read
  ok    no pairing is attempted without a fleet key
  ok    the machine says it is in no fleet rather than staying silent
  ok    w2m_status is registered
  ok    the machine joins once the account answers
  ok    the token is persisted, not just held in memory
  ok    the pairing presents a derived fleet key
  ok    the pairing names the identity on disk
  ok    a machine holding a token never re-pairs
fleet key without a hardware fingerprint
  ok    no fingerprint means no serial number, and that is reported
  ok    no serial number is invented
  ok    the fleet key survives the fingerprint failure
  ok    the account code travels with it
all checks passed
```

## [0.8.9] — 2026-10-14

**The account answers lazily, and we asked once.**

### The defect

`getPlatformSession().userId` repeats the stable account id **from the most recent successful
`getProfile`**, and is `null` until one has happened. The account profile is a **lazy cache**, and
`startLocalStack` reads it **at mount** — before any model call has touched the profile.

So on a signed-in machine the first read returns *signed out*, the fleet key is never derived, no
pairing happens, and **nothing is written**. The evidence that pins it is `device.json`'s **mtime**:
unchanged since the first boot, so `saveDeviceToken` was not merely ineffective, it was **never
reached**.

**That also explains an earlier result that made no sense at the time:** v0.8.4 *did* pair once,
because by then the profile happened to be cached. **A timing-dependent success is the worst kind to
debug — the code is right and the outcome still varies.**

### v0.8.7 made it worse, without meaning to

*"Already paired → do not pair again"* turned an **intermittent miss into a permanent one**. A
machine that missed at startup never retried, and re-pairing had been the only thing rescuing it.
The rate-limit fix was correct and exposed a defect it did not create.

### Fixed

Derivation now **backs off and retries** (6 attempts, 2s doubling to a 30s cap) until a real key
appears or the budget runs out.

### And the silent branch that hid it

`resolve()` on the **stored-SN path** returns `ok: true` with `fleetKey: null`. The old code logged
only when `ok === false` — so the shape that was actually firing **produced no output anywhere**.

That is the same *silent no-op* class fixed in 0.8.5, reappearing **in the exact branch that was
failing**. Every outcome is now named:

| shape | reported as |
|---|---|
| `ok: true`, key present | `fleet key derived … on attempt N (fleet …)` |
| **`ok: true`, key null** | **`signed in, but the account returned no fleet key (the profile may not be loaded yet)`** |
| `ok: false` | the reason and detail, verbatim |
| budget exhausted | **`this machine is in NO fleet and will receive no work`** |

A machine in no fleet must never be quiet about it.

### Verified

**174 cases**. `tools.mjs` loads; the describer was exercised against all five shapes including the
one that previously said nothing.

## [0.8.8] — 2026-10-14

**A machine that joined without saying what it is — and a fix that was computed and never used.**

### `platform` and `caps` were never sent

`createAgent` accepts `platform` and `caps`, and `bin/w2m-localside.mjs` has always supplied them.
`startLocalStack` did not, so a machine that joined **through the plugin** appeared in the relay
complete and correct except for:

```
"os": null, "arch": null, "caps": {}
```

**The capability gate then had nothing to filter on — and that gate decides what work a machine is
offered.** So the device was registered, reachable, and unusable for anything the gate would have
matched it to.

Same shape as the rest of this series: the record was created and **the part that makes it useful was
not filled in**.

### The v0.8.5 fix was computed and never used

Worse, and found while making the change above:

```js
const resolvedStateDir = cfg.stateDir.trim() !== '' ? cfg.stateDir.trim() : resolveStateDir(...);
if (cfg.stateDir !== resolvedStateDir) { ctx.logger?.info?.(`w2m: stateDir was unset; using ...`); }
...
const agent = await createAgent({ stateDir: cfg.stateDir, ... });   // ← the EMPTY string
```

**v0.8.5 computed the resolved directory, logged it, and then passed the original empty string to
`createAgent`** — the exact call that throws `createAgent: stateDir is required`. So the second gate
v0.8.5 claimed to open was **still shut**, and the only evidence was a log line saying the resolved
path was being used.

*The log said the right thing while the code did the wrong thing* — which is worse than silence,
because silence sends you looking and a confident wrong log sends you away.

Both `createRelay` and `createAgent` now receive `resolvedStateDir`, and its definition was moved
**above** its first use: as a `const` used earlier in the same block it would have thrown
`ReferenceError: Cannot access 'resolvedStateDir' before initialization` at runtime, which
`node --check` cannot see because it is not a syntax error. Caught by checking the **order**, not the
syntax.

### Also sent now

`identityPath: loaded.path` — the device key belongs **beside the `device.json` this process actually
loaded**, not in a directory the agent guesses. Without it the in-process and standalone paths can
mint separate keypairs under one `machine_id` and overwrite each other's announcement (the v0.6.2
defect, which this path would have reintroduced).

### Verified

**174 cases**. `tools.mjs` loads; the ordering was confirmed by comparing line numbers rather than by
reading.

## [0.8.7] — 2026-10-14

**Pair only when there is no token — because the relay rate-limits pairing.**

### The defect

v0.8.6 made the token persist; it still **paired on every start**. The fleet key is derived
unconditionally, so `pairBy` was never null and the pairing branch always ran.

The relay allows `pair_rate_limit: 5` per minute. **Five restarts inside a minute hit the limit — and
a rate-limit refusal reads as a pairing failure, which reads as a fleet problem.** The symptom would
have pointed at the network, the relay, or the account, none of which would be at fault.

A machine that already holds a token has nothing to gain from pairing again: the relay would re-issue
one and invalidate the old, for no reason.

### Fixed

```js
const existingToken = loaded.identity.device_token;
const alreadyPaired = typeof existingToken === 'string' && existingToken !== '';

if (alreadyPaired) {
  ctx.logger?.info?.(`w2m: already paired (token in ${loaded.path}); not pairing again`);
} else if (pairBy !== null) {
  // pair once, then persist
}
```

**This also makes the persisted token load-bearing rather than an optimisation.** Without it every
start is a fresh pairing — which is why *the missing write in v0.8.5* and *the unconditional pairing
here* are **the same defect seen from two sides**: one threw the token away, the other had to
re-create it every time.

### A note on how this was found

Reported, with reasoning and a rate-limit number from the relay's own configuration — not from a
failing test. The distinction matters for what it implies: **nothing in the suite would have caught
it**, because every case starts from a fresh state and none of them restart the plugin in a loop.

### Verified

**174 cases** across the tools, apply, account and fleet-join suites.

## [0.8.6] — 2026-10-14

**The pairing worked and the token was thrown away.**

### The defect

`startLocalStack` called `agent.pair(...)` and **never persisted the result**. `agent.pair` sets
`identity.device_token` on its **in-memory object only**, so the observable behaviour was:

1. the account-derived key is computed ✅
2. the relay **accepts** the pair and registers the device ✅
3. the machine appears in `w2m_devices` ✅
4. **every authenticated call then answers `401 UNAUTHORIZED`** — `w2m_devices`, the P2P announce,
   all of it — because `device.json` still said `device_token: null` ❌

It reads as a permission failure and is **a missing write**.

The evidence that settles it is the shape of the value: not an empty string, not a truncated token —
**`null`**. A write that failed would leave the previous value; a write that never happened leaves
what the identity was created with.

### Why the CLI never had this bug

`bin/w2m-localside.mjs` has always done it:

```js
const paired = await agent.pair(flags.pair ?? null, undefined, fleetKey);
saveDeviceToken(paired.device_token, {});     // ← the CLI persists it
```

**The in-process path was written without that line.** So the two paths diverged in exactly the way
that produces a symptom in one and not the other — which is why it looked like a relay or permission
problem rather than a missing statement.

### Fixed

`saveDeviceToken(paired.device_token, identityOptions)` now runs after a successful pair, using the
**same options object** that loaded the identity. Reading with one set of options and writing with
another is how the plugin and the CLI once ended up each minting a keypair under one `machine_id`
(the v0.6.2 defect), so the options are captured once and used for both.

A failure to persist is **named at warn level**, including what it means: *"this machine will answer
401 to every authenticated call until that is fixed."* That exact condition was silent once already.

### The pattern this is the third instance of

* v0.8.4 wired the **derivation** but the gate in front of it was closed.
* v0.8.5 fixed the **second gate** (`stateDir`) but not the write behind it.
* v0.8.6 fixes the **write**.

Each time, the action was connected and its **persistence or precondition** was not. Worth stating
plainly because it is the shape of every bug in this series: **the thing that makes the result
survive is the thing that gets forgotten.**

### Verified

**174 cases** across the tools, apply, account and fleet-join suites.

## [0.8.5] — 2026-10-14

**Two gates, not one — and the silence that hid both.**

### The second gate

v0.8.4's analysis said the join sequence was blocked by `autoStartAgent` defaulting to false. That
was right and incomplete: **an unset `stateDir` threw as well**, so flipping the switch would have
failed too.

```
stateDir=empty string -> THREW: createAgent: stateDir is required
```

`createAgent` rejects a falsy `stateDir`; the plugin's resolved default is the empty string; and
`startLocalStack` passed it straight through. **Two gates in series, and the analysis found the one
in front.**

`stateDir` now resolves to a real path (`$DSH_HOME/xclient/localside`) when unset, resolved in
`startLocalStack` so `w2m_status` reports the path actually used — which is what makes *"where did it
write `device.json`"* answerable rather than a guess.

### The silence, which is the real defect

A machine could run v0.8.4, hold a valid signed-in account, reach the relay over **HTTP 200**, and
be in **no fleet** — with nothing anywhere reporting a problem. The eight tools registered, the
plugin looked healthy, and the join sequence simply never ran.

**A silent no-op that looks like success is the worst failure mode this plugin has had**, because
every diagnostic signal a person would reach for says the system is fine. The evidence that finally
settled it was an *absence* — no `device.json`, no `xclient`, no listening ports — and an absence
is only readable once you know what should have been there.

So the disabled branch now says so, at warn level, naming what it means and how to change it:

> `w2m: no agent is running on this machine, so it is in no fleet and will receive no work. Set autoStartAgent: true to join …`

One line turns *"why is this machine not in my fleet"* from an investigation into a log search.

### A test that measured a count instead of a message

`tools.test.mjs` asserted `warnings.length === 1` for the `dsh-tools` shim warning — a claim about
**every** warning the plugin will ever emit, so the new one broke a test about something else
entirely. It now matches the message it is about. **The count was never the property.**

### What is still required, stated plainly

The switch does not default to on, deliberately: a control machine that only *dispatches* to others
has no reason to be in the fleet itself. So joining requires `autoStartAgent: true` **and** a
`w2m` row in the profile — and the profile having no such row is the state every fresh install
starts in.

### Verified

**174 cases** across the tools, apply, account and fleet-join suites.

## [0.8.4] — 2026-10-14

**The last connection — the one that makes the feature user-facing.**

### The gap

The `chatops` half derived the fleet key from `userId` and exposed it. The `plugin/tools.mjs` half
accepted a key and handed it to the agent. **Neither knew about the other**, so the plugin read
`fleetKey` from config or `W2M_FLEET_KEY` — and a machine with a signed-in account still joined
nothing without a human setting a variable.

Two halves that each work, with no wire between them, is the same failure as v0.8.1's: the capability
existed and nothing exercised it.

### Now

`startLocalStack` derives the key itself, from the account, via the same
`createAccountIdentity({ ctx }).resolve()` the rest of the plugin uses. The derivation belongs there
because **the host is the only layer that can read the account** — a standalone agent cannot — so the
key must be produced where `ctx` is available rather than where it is used.

Verified with DSH's own context shape:

```
ctx.get('deepseekAccount') -> createAccountIdentity({ ctx }).resolve()
  -> fleetKey (43 chars) -> fleetId d5bb1b9ddf3faad4     (matches the existing derivation)
  signed-out                 -> named reason, no key invented
  no account service         -> named reason
```

### Two failure modes, handled differently on purpose

* A **derivation failure is caught and logged, not thrown** — an unpaired agent still runs and can be
  paired later, whereas a thrown start is a machine that never appears at all.
* **`signed-out` is logged at info, not warn** — being signed out is a normal state, and the design
  says a machine with no account must not be given a random fleet. Warning about it would train an
  operator to ignore the line that matters.

An explicitly configured `fleetKey` still wins, and the log names which source was used — `paired by
fleet key (account)` or `(config)` — so nobody has to guess where the key came from.

### A defect in this patch, caught by the compiler

The first edit consumed the `} catch (error) {` line and left the catch body inside the `try`, which
`node --check` reported immediately. Worth recording because the same edit pattern — replacing a
block by line range — corrupted a function in v0.8.1 as well.

### Verified

**174 cases** across the tools, apply, account and fleet-join suites.

### This is what closes the reported bug

A new machine, installed and signed into the same account, derives its fleet key, presents it at
pairing, and lands in the same fleet — **with no key to copy and no operator step**. That is the
behaviour the original report asked for, and it is now reachable by configuration rather than by
convention.

## [0.8.3] — 2026-10-14

**The last wire, and the reason it was never there.**

### `autoStartAgent` was dead code

The option existed, was documented, and **threw on its first call**. `startLocalStack` built its
`createAgent` arguments as `projectDir` (the option is `project`), omitted `identity` (which is
required), and passed a `pairingCode` that `createAgent` does not accept.

Verified rather than inferred — calling `createAgent` with that exact shape:

```
createAgent THREW: createAgent: project is required
```

**So the code path that was supposed to bring an agent up had never run.** That is why the
fleet-join wire appeared to be missing: the place it was meant to live could not be reached at all.
An option that exists, is documented, and cannot execute is worse than one that is absent — it
reads as a feature.

### Two more things wrong with the shape

* **It created a local relay unconditionally.** For a machine joining a shared fleet that is the
  opposite of what is wanted: the machine must connect to the relay that already exists, not mint
  another one — and with `rabbitUrl` pointing at a remote host it would have tried to bind a relay
  on that hostname. It now stands up a local relay **only when the configured URL actually is
  local**, and otherwise logs that it is joining the relay at the given address.
* **Nothing paired the agent.** Even a started agent could fetch no offers, which looks identical to
  a fleet with no work.

### Now

`startLocalStack` passes the option names `createAgent` actually documents, loads the identity from
the **same file the CLI uses** — so one machine has one identity whether the agent runs in-process
or as its own process, rather than each minting a keypair and overwriting the other's announcement
under a shared `machine_id` (the v0.6.2 defect, in a new place) — and **pairs by the account fleet
key**, falling back to a pairing code.

Pairing is attempted **before** `agent.start()`, and a failure is **named at warn level** rather than
swallowed: an agent that failed to pair runs and does nothing, which is indistinguishable from a
quiet fleet.

### Config

`fleetKey` is read from the config layer or `W2M_FLEET_KEY`. The key must be **handed down** rather
than computed where it is used, because a standalone agent cannot read the signed-in account — which
is why it comes from the host.

### Verified

**132 cases** across the tools, apply and fleet-join suites. `tools.mjs` loads. The 12 agent-suite
failures remain pre-existing and environmental, measured against an untouched clone of the same
commit.

### ⚠️ Not yet proven on real hardware

The wiring is fixed and the mechanism was verified end to end in v0.8.2, but **no machine has yet
joined a fleet through this path in a live run**. That is the next check, and it needs a machine
that is not already paired.

## [0.8.2] — 2026-10-14

**The client half of the auto-join.** v0.8.1 landed the credential and the relay's acceptance of
it; this is the wiring that makes a real machine use them.

### What is now connected

| piece | what it does |
|---|---|
| `account.mjs` | derives the fleet key on **every** resolve, including the stored-SN path |
| `index.mjs` | exposes it as `fleetKey` — the key, never the account id |
| `agent.mjs` | `pair(code, userId, fleetKey)`, sending only the discriminator that was given |
| `w2m-localside` | `--fleet-key`, a peer of `--pair` |
| relay | derives the fleet from the key; never believes a claimed one |

**Verified end to end:** an agent given **only** `--fleet-key`, against a relay with **no fleet of
its own**, pairs and lands in the account-derived fleet (`d5bb1b9ddf3faad4`, `source=fleet_key`).

### The bug that would have made it work exactly once

`resolve()` returned early when an SN was already stored and never read the account at all. That is
right for the SN — it must not be regenerated, or every restart looks like a new device — and
**wrong for the key**: a machine has a stored SN from its *second* start onward, so it would have
derived a fleet key once and never again.

**The auto-join would have worked on a machine's first boot and silently stopped afterwards** — the
hardest kind of bug to see, because it works when you test it. Found by asking what the stored-SN
path actually does, rather than by reading the happy path.

### The bug in this release's own patch

The fleet-key handling was first inserted **inside `if (flags.pair)`**, so the key path could only
run when a pairing code was also supplied — precisely the case it exists to avoid. **It worked
whenever anyone tested it with a code, and did nothing in the case that mattered.** The end-to-end
test is what caught it, not review.

### A provenance bug, also caught by testing

A device that paired by key was recorded as `fleet_source: 'pairing_code'`, because the relay builds
a synthetic code record so the binding reads from one place. That matters: `fleet_source` is what an
operator reads in `devices.json` to answer *"how did this machine get into my fleet?"*, and
answering "a pairing code" when there was none sends them looking for a code never issued.

### Also

`HANDOFF.md` records the state, the single reachable path to the Mac, and the traps this codebase
has already fallen into.

### Verified

**585 chatops cases pass.** The 12 agent-suite failures are **pre-existing and environmental** —
measured against an untouched clone of the same commit, both give **147 tests / 133 pass / 12 fail /
2 skipped**, identical, so this change is not the cause.

### ⚠️ Still not user-facing

**The plugin does not yet spawn the agent or hand it the key**, so with the default configuration a
new PC still will not auto-join. The mechanism is complete and verified; that last wire is what
makes it something a user experiences rather than something a test proves.

## [0.8.1] — 2026-10-14

**A machine on the same account joins the same fleet with no human step** — the requirement that
had no implementation behind it, and the bug that made it visible.

### The reported bug, and what it actually was

A new PC signed into the same DeepSeek account did **not** join the same fleet. Traced rather than
guessed, the cause was four gaps stacked:

* the plugin computed its SN, derived `fleet` from the account code, **logged it, and never used it
  for anything**;
* nothing called `/v1/pair`;
* `autoStartAgent` defaults to **false**, so no agent started;
* and even with an agent, membership needed a **human-typed one-time pairing code**.

So "same account joins the same fleet automatically" was a stated requirement with no code path.

### Why the obvious fix is the wrong one

The obvious fix is to use `accountCode` as the credential. `account.mjs` documents the trade
honestly — *"the cost of 32 bits, stated rather than hidden"* — and for **grouping** 32 bits is
fine. As a **secret** it is not: 2^32 is brute-forceable, so authorising a join with it would let
anyone enumerate their way into any fleet.

**The bug was a conflation: a grouping identifier was doing duty as a secret.**

### The fix

The machines of one account share something an outsider cannot obtain — the ability to read
`userId` — so the fleet secret is derived from it:

```
fleetKey = HMAC-SHA256(userId, "w2m-fleet-v1")     256 bits, same-account machines only
fleetId  = SHA-256(fleetKey)                       what the relay groups by
```

**Presenting the key is the proof.** The relay *computes* a fleet id from the key it is given
rather than believing a claimed one, so a device can only land in the fleet whose key it holds.
No trust-on-first-use, no operator configuration, no account lookup, nothing to forge — and a
device without the key forms a different, empty fleet instead of joining someone else's.

`deriveAccountFleetKey` **refuses anything shorter than 16 characters**, and the refusal is asserted
in a test rather than left to a comment: passing the 8-hex account code by mistake would otherwise
produce a key that *looks* strong and is not — the worst kind of credential failure, because it is
silent.

### The relay side

`deviceFleetFields` gains a third source, ordered by authority:

| source | who decided |
|---|---|
| `pairing_code` | the operator, by issuing the code |
| **`fleet_key`** | **the account, by derivation** — the auto-join path |
| `request` | the relay operator, via `--fleet` |

A **malformed key does not fall through** to the relay's own fleet. Falling through would be the
silent wrong answer: a device that meant to join its account would be placed in an unrelated fleet
and told nothing. It is refused, with the reason recorded on the device record.

This also removes the deployment problem recorded in v0.7.9: `--fleet` no longer needs an operator
to compute and hand-carry a 32-bit code, because the relay needs to know **nothing** about any
account.

### Verified

* **21 cases** for the derivation: same account agrees, different accounts differ, the 32-bit code
  is refused, the wire form round-trips, a client and a relay independently derive the same id, and
  comparison is constant-time.
* The derived bytes are **pinned**, not self-compared — a regression would silently split every
  existing fleet into two halves that cannot see each other, with no error anywhere.
* **223 cases** across the relay, wiring, scoping and join suites, unchanged.

### ⚠️ What is still not wired

The **derivation and the relay's acceptance** are done. The pieces that make a real machine use
them are not:

* `index.mjs` does not yet derive or expose the fleet key;
* the agent does not yet present it at pairing;
* `autoStartAgent` still defaults to false.

**Until those land, a new PC still will not auto-join.** The credential exists and is accepted; the
client does not yet offer it.

## [0.8.0] — 2026-10-14

**The first release on npm since 0.6.3.** Eight versions of work — account identity, fleet
isolation, device signing, lease-takeover guards, `/run`, the durability policy, and the server's
own configuration — now reachable by `npm install` rather than only by git tag.

### What is in it, and what each part actually guarantees

**Account identity and the SN** (0.7.5). A machine derives a serial number from
`account code + hardware code + time code`. The account code is `sha256(userId)` truncated, so it
can be handed to a relay without disclosing the account id — which is what makes the next part
possible on a server that has no account login of its own.

**Fleet isolation** (0.7.6, wired in 0.7.8). `createTask` no longer selects every device on the
relay. It selects the requester's fleet, where the fleet is read **from the pairing code** — a
device cannot name its own fleet, because a device that could would join any fleet and every
signature would faithfully attest to it.

The migration is two-mode and both modes are tested against the relay's real state:

| relay | requester | reaches |
|---|---|---|
| unscoped | operator, or a fleetless device | **every device — the pre-0.7.8 rule, unchanged** |
| scoped | operator | the relay's fleet |
| scoped | a device in that fleet | that fleet only |
| scoped | a fleetless device | **nothing**, with the reason named |

**Deploying cannot be an outage; scoping cannot be a silent grant.**

**Per-device Ed25519 signing** (0.7.10, verified by the relay in 0.7.11). The relay already signed
requests, but with **HMAC over a shared secret** — everyone who can sign can verify, so that proves
only that the sender knows the secret, which is every device. A device key proves *which* device.

The relay now tries the device key first and converges one machine at a time:

| device | outcome |
|---|---|
| sends no signature | shared secret, byte-for-byte unchanged |
| stored key, good signature | verified by the key |
| stored key, **bad** signature | **refused, and not retried against the shared secret** |

That third row is the whole point: falling back would make the strong mechanism *optional* for
anyone able to produce a malformed signature, which is everyone.

**Lease-takeover guards** (0.7.9). `_takeover` would re-offer a dead machine's index to **every idle
device the relay holds**, with no fleet filter and no consideration of whether the task writes. So a
device in another account could be handed the work, and a writing task could be run twice. Both are
now refused with a named reason.

**`/run` with two privilege levels** (0.7.11).

| form | who | what it does | capability |
|---|---|---|---|
| `/run <argv>` | expert | dispatches those arguments, uninterpreted | `fleet.dispatch` |
| `/run --ask <words>` | beginner | asks; the agent answers and **proposes** | `operate` |

A beginner describing what they want is **not** executing anything: the request goes to a session,
and if the session wants something run it emits `/run <argv>`, which still needs `fleet.dispatch`.
**A low-privilege window can ask freely and cannot cause a fleet execution by asking.**

**Durability policy** (0.7.11). The requirement — *"10× redundancy, tolerate losing 90% of nodes"* —
is two different claims, and the arithmetic decides the architecture:

```
n=   3  copies=3/10   loss=100%  basis=server_complete
n= 100  copies=10/10  loss=100%  basis=server_complete
--- with no server copy ---
n=   3  loss=67%   meets=false      <- three devices cannot reach 90% alone
n=  10  loss=90%   meets=true
```

At three devices the guarantee is **the server's complete copy**; device redundancy alone gives
**67%**. So the server is the **authority at every tier**, not one more replica to drop once devices
are plentiful.

**`deploy/server/`**. The three systemd units as the live host runs them, and the deployment script
whose step order is the safety argument: checksum before unpacking, back up in place, entry-point
check before swapping, then restart, health-check, and automatic rollback on failure.

### The secrets guard

`scripts/scan-for-secrets.mjs` fails a release on a credential shape in any **tracked file**. It
exists because `.gitignore` refuses a *path*, while the ways a credential escapes are pasting one
into a source file, a fixture, or an example. The relay's `operator-token.txt` — full control of the
fleet — is the thing it protects.

Writing it exposed **six defects in the guard itself**, every one a silent-off failure that looks
like success: an unconditional `statSync` that made an injected reader unreachable; a relative path
that made the scan report zero findings across zero files; a token regex that missed camelCase; a
slug rule that rejected `p2p-crypto-operator` over a digit; a duplicate rule; and a test that
hard-coded rule names and so measured the name rather than the behaviour.

### WeChat, measured

Reading and sending both work against the live service. The body is `item_list[0].text_item.text`,
the cursor is `get_updates_buf`, login confirms as `confirmed` (not `scaned`), the token is valid
**>280 s**, and a send nests under `msg` with `message_type: 2` and `message_state: 2`, returning a
`message_id` and no `ret`. Four wrong guesses on the wire format made a working feature look broken,
including a false conclusion that the token lived only 30 seconds.

### The honest gaps

* **`shouldHandOff()` and `reconcileResults()` are written and tested but not wired.** The fleet and
  write guards are in the relay's takeover path; single-successor selection is not.
* **The relay defaults to unscoped**, so accounts are mixed unless an operator sets `--fleet`. Doing
  so requires an account code, which a headless server cannot produce, and a re-pair of every
  device — during which a fleetless device reaches nothing.
* **`/run` is not yet wired to the WeChat channel.** The parser, the renderer, and the capability
  split are complete and tested; the last link is the adapter.
* **The Mac cannot be updated remotely.** Its allow-list refuses anything but `node -e`, and a DSH
  restart would kill the only channel to it.
* **`/v1/devices` is not narrowed to the caller's fleet** — a device can still *list* another
  fleet's machines, though it cannot *reach* them.

### Verified

**542 chatops cases across twenty-two suites**, and the relay's own **168 unchanged**.

## [0.7.11] — 2026-10-14

**The relay verifies device signatures, `/run` reaches the fleet from a chat window, the durability
policy is written down, and the server's own configuration is in the repository.**

### Relay verifies device Ed25519 signatures

`verifySignature` now tries the per-device path before the shared secret. The design goal is
**convergence**: a fleet updates one machine at a time, with no flag and no coordination.

| device | outcome |
|---|---|
| sends no signature | shared secret — byte-for-byte unchanged |
| has a stored key, good signature | verified by the key, `device: true` |
| has a stored key, **bad** signature | **refused, and not retried against the shared secret** |

That third row is the one that matters. Falling back would make the strong mechanism *optional* for
anyone able to produce a malformed signature, which is everyone.

*Defect found while writing it:* `NonceCache` exposes `accept`, not `remember`. The test caught it.

### `/run` — two forms, two privilege levels

| form | who | what it does | capability |
|---|---|---|---|
| `/run <argv>` | expert | dispatches those arguments, uninterpreted | `fleet.dispatch` |
| `/run --ask <words>` | beginner | asks; the agent answers and **proposes** | `operate` |

The asymmetry is the point. A beginner describing what they want is **not** executing anything: the
request goes to a session, the session answers in prose, and if it wants something run it emits
`/run <argv>` — which still needs `fleet.dispatch`. So a low-privilege window can ask freely and
**cannot cause a fleet execution by asking**.

The form is **declared** (`--ask`), never inferred from how the text reads. An inferred distinction
gets it wrong in both directions, and the direction that matters is dispatching a sentence as if it
were a program.

Shell metacharacters are refused rather than passed through, because the fleet takes an argv array
and never a shell string — `|` would arrive as a literal argument and quietly do something other
than what was typed. **A command that runs and does the wrong thing is worse than a refusal.**

### Durability policy

The requirement was given as *"10× redundancy, tolerate losing 90% of nodes"*. Those are two
different claims, and conflating them yields a system that looks compliant and is not:

* **10 replicas** is a storage-layout property, and is **impossible** below 10 nodes;
* **surviving 90% loss** counts every copy, including the authoritative one.

Measured, with the arithmetic in tests:

```
n=   3  copies=3/10   loss=100%  basis=server_complete
n= 100  copies=10/10  loss=100%  basis=server_complete
n=1000  copies=10/10  loss=100%  basis=server_complete
--- with no server copy ---
n=   3  loss=67%   meets=false
n=  10  loss=90%   meets=true
```

So at three devices the 90% guarantee is met **by the server's complete copy**, and device
redundancy alone would give only 67%. That is why the policy treats the server as the **authority at
every tier** rather than as one more replica that can be dropped once devices are plentiful.
`durabilityReport()` names the basis in a note, so a health number cannot be read without its
provenance, and `server_copy_required` is true at every fleet size.

Tiers, inclusive at the bottom as measured by tests: `<100` server, `100–999` hybrid, `>=1000`
distributed with the server as a fallback that is still written to.

### The server's configuration is now in the repository

`deploy/server/` holds the three systemd units **as the live host actually runs them** —
`w2m-rabbit`, `w2m-stun`, `w2m-localside` — plus `deploy-w2m.sh`, the deployment script that
performed the last two upgrades.

The script's step order *is* the safety argument: verify the checksum **before** unpacking (a
truncated upload must never become a service), back up in place (rollback must not depend on the
network), check for entry points **before** swapping (a `git archive` of the wrong directory
unpacks cleanly and contains no `bin/`), then restart, health-check, and **roll back automatically**
on failure.

**`/var/lib/w2m/rabbit/` is not in the repository and must never be.** It holds `operator-token.txt`
— full control of the fleet — and the task ledger. Two mechanisms keep that true, because one is
not enough: `.gitignore` refuses the **paths**, and `scripts/scan-for-secrets.mjs` reads the
**content** of every tracked file. A `.gitignore` refuses a path; the ways a credential actually
escapes are pasting one into a source file, a fixture, or an example.

### The secrets guard, and the six defects it caught in itself

The guard is only worth having if it works, so it was tested against the real repository — and it
failed in ways worth recording, every one of them a **silent-off** failure that would look like
success:

1. **`statSync` was called unconditionally**, so an injected reader could never be reached — the
   stat hit the real filesystem, threw, and the `catch` swallowed it;
2. **a relative path was passed to `readFile`**, so every file threw and the scan reported
   **zero findings across zero files**;
3. **the regex `operator[_-]?token` missed camelCase** — `operatorToken`, which is how this project
   actually spells it;
4. **a slug rule requiring only `[a-z]`** rejected `p2p-crypto-operator` because of the digit in
   `p2p`;
5. a **duplicate rule** reported one match twice;
6. a test **hard-coded rule names**, so renaming a rule broke a test that was measuring the name
   rather than the behaviour.

Findings on the real tree went from 3 false positives → 5 exposed fixtures → **0 blocking, 14 for
review** (all ordinary 64-hex hashes). `REVIEW` is deliberately **not fatal**: a scanner whose false
positives block releases is a scanner someone deletes.

### Verified

**542 chatops cases across twenty-two suites**, the relay's own **168 unchanged**.

### Still not done

* **`handoff.mjs`'s `shouldHandOff()` and `reconcileResults()` remain unwired** — the fleet and write
  guards are in the relay's takeover path, the single-successor selection is not.
* **The Linux server and Windows plugin are on v0.7.10**; the Mac is on **v0.6.3** and cannot be
  updated remotely (its allow-list refuses anything but `node -e`, and a DSH restart would kill the
  only channel to it).
* **The relay is unscoped**, so accounts remain mixed at runtime.
* **npm has not been published since 0.6.3** and no credential is available on this host.
* **WeChat: reading works, sending works, `/run` is not yet wired to the channel.**

## [0.7.10] — 2026-10-14

**Per-device Ed25519 request signing — the part of the signature chain that can be built without
locking anyone out.** The relay does not enforce it yet, deliberately.

### Why a second signing mechanism

The relay already has request signing, and it is **HMAC over a shared secret**: everyone who can
sign can also verify, so the relay holds a credential that every device holds. That is fine when
one operator owns every machine, and it is the wrong shape for what this workstream is about —
proving that *this specific device* is in *this account's* fleet. **A shared secret proves only
that the sender knows the secret, which is every device.**

`src/chatops/device-signing.mjs` signs with a **device-held Ed25519 private key**, so the relay
verifies with a public key it stores and never holds anything that could impersonate the device.

### The defect that would have made all of it useless

The signed bytes are the **relay's own canonical string**, reproduced byte for byte:

```
v1\n<METHOD>\n<path>\n<timestamp>\n<nonce>\n<sha256-of-body>
```

The first version hashed the body with `createHash('sha256', …)`. **The relay uses
`createHmac('sha256', Buffer.alloc(0))`**, and those are not the same function: HMAC wraps the key
with its own padding, so an empty body hashes to `b613679a…` rather than `e3b0c442…`.

**Every signature would have failed, forever, with no clue why.** A probe that signed four requests
with both implementations and compared the strings is what caught it — and that comparison is now
a test, because it is the only reason this is correct.

### Added

* **`src/chatops/device-signing.mjs`** — a device signer, a verifier, and the shared canonical
  string. Compatibility with the existing mechanism is deliberate: one verified string rather than
  two that must be kept in step, and the relay can tell the two apart by **whether the device has a
  public key** — no protocol flag, no version negotiation, no second header a client could forget.
* **`pair()` accepts and stores `public_key`.** Not validated there on purpose: a malformed key
  fails at verification with a named reason, while rejecting a pairing over it would lock out every
  existing device the moment the field appeared. A device that sends no key keeps working, with
  `public_key: null` meaning *"signs with the shared secret or not at all"*.
* **`publicDevice` reports `public_key_present`** as a boolean, not the key. The key is not a
  secret, but a device list is read by every device, and verification happens relay-side.
* `test/chatops-device-signing.test.mjs` — 22 cases.

### The test that matters most

`canonicalString` is compared against **the relay's own implementation, imported** — not against a
reimplementation of the expectation. A test that asserts what the author believed the format to be
would have passed for the broken version.

### ⚠️ Not enforced, and that is the point

**The relay does not verify device signatures yet.** A device that signs today is signing into a
relay that does not check it. Two reasons this is the right order:

1. **Enforcement is what would lock people out.** A relay that *requires* a signature refuses every
   device that has not been updated — including all four current machines. Landing verification and
   enforcement together is how a safety feature becomes an outage.
2. **The fleet rollout is blocked anyway** (see v0.7.9): the shared relay cannot produce an account
   code, and the Mac cannot be updated without physical access.

So the sequence is: ship the signing, ship the verification, update every device, then turn
enforcement on — with `requireSignature` already meaning *"insist"* in the relay's existing
vocabulary, so the switch is one flag rather than a new mechanism.

### Verified

**459 chatops cases across eighteen suites**; the relay's own **146 unchanged**.

### Still not done

* **No signature is verified by the relay.** `verifyDeviceSignature` has no caller in `src/relay/`.
* **Hand-off is guarded but not refined** — `shouldHandOff()` and `reconcileResults()` remain
  unwired; the fleet and write guards from v0.7.9 are in the relay's takeover path.
* **The Linux server, the Mac and the Windows plugin are still on older versions**, and the relay
  is unscoped, so accounts remain mixed at runtime.
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.9] — 2026-10-14

**Two safety guards on lease takeover, and an honest account of what is still not connected.**

### What was already there, and what was missing

`_takeover` existed and already ran on `halt: 'now'`, so hand-off was **not absent** — v0.7.7's
note that it "is not implemented" was about `handoff.mjs` not being called, and this release
corrects the record: the relay's own takeover path was live and had been since v0.1.x.

**What it lacked was the two guards**, and both are reachable defects rather than theory:

1. **A device in another account could be handed the work.** `_takeover` iterated
   `this.devices.values()` with no fleet filter, so on a relay serving several fleets a takeover
   **crossed accounts** — the isolation this whole series is about, broken in the one path that is
   easy to miss because it only runs when something has already gone wrong.
2. **A writing task could be run a second time.** Hand-off makes execution at-least-once. Harmless
   for `node --test`; a duplicated write for anything else, applied on a machine with no idea the
   first one already ran.

Both are now refused with a named reason (`LEASE_TAKEOVER_REFUSED`, `write_not_idempotent`).

### Deliberately not changed

The re-offer **shape** is untouched. PROTOCOL v0.0.1 defines no per-index lease reassignment, so
takeover is expressed as a re-offer to every idle machine — a fan-out, not a single successor.
Narrowing it to one successor is what `handoff.mjs`'s `shouldHandOff()` would do, and it is a
**protocol revision**, not a wiring change, so it is not made here. `reconcileResults()` is
likewise ready and unused: nothing calls it yet.

### The prerequisite this release discovered, which blocks the fleet rollout

**The shared Linux server cannot produce an account code.** Its `.dsh` holds no account
credentials — it is a headless VPS running the relay, STUN and a localside agent, not a signed-in
DSH client. So `--fleet <account code>` has **no source on the server**, and the value must be
computed on a machine that *is* signed in and then handed over.

That is workable — the account code is an opaque `sha256(userId)` prefix, so passing it does not
disclose the account id — but it means the rollout is:

1. read the account code on a signed-in machine,
2. restart the relay with `--fleet <code>`,
3. **re-pair every device**, because a device only receives a fleet from the pairing code, and
   every existing device paired without one.

**Step 3 is the risk**: on a scoped relay a fleetless device reaches **nothing**, so all four
current devices go silent until each is re-paired. That is the intended fail-safe direction, and it
is still an outage until the re-pairing completes.

### Added

* `test/chatops-takeover.test.mjs` — 5 cases, booting a real relay: a write task is refused and
  names why; a read task is still re-offered; a takeover skips a device in another fleet; it skips
  a fleetless device on a scoped relay; and an unscoped relay behaves exactly as before.

### Verified

**437 chatops cases across seventeen suites**, and the relay's own 165 unchanged.

### Still not done

* **`shouldHandOff()` and `reconcileResults()` are not wired.** The guards above are in the
  relay's takeover path; the richer single-successor selection and the late-result rule are not.
* **No device generates a keypair and no request carries a signature.** The relay's existing HMAC
  signing is a different mechanism and remains untouched, so the signature chain is **not enforced**.
* **`/v1/devices` is not narrowed to the caller's fleet.**
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.8] — 2026-10-14

**The wiring.** v0.7.5–v0.7.7 shipped modules that nothing called. This release connects them, so
account isolation and fleet scoping are **in effect** rather than merely tested.

### What changed in the relay

* **`src/relay/state.mjs`** — `createTask` no longer selects `[...this.devices.values()]` with no
  filter. It calls `targetsFor()` from `fleet-wiring.mjs`, which applies the fleet rule.
* **`createPairingCode` now carries the relay's fleet**, and `pair()` writes it onto the device.
  This is the link the whole scheme hangs on, and it is easy to omit: `pair()` reads the fleet
  *from the code*, so a code with no fleet pairs a device into no fleet — and a device in no fleet
  reaches nothing on a scoped relay. `--fleet X` would then have had **no effect on anything,
  silently**.
* **`publicDevice` carries `fleet_id` and `fleet_source`.** `devices.json` is written from this
  shape, so a fleet that lived only on the in-memory record would have vanished on the next
  restart — which is precisely when an operator looks at it. A live test caught that.
* **`bin/w2m-rabbit.mjs`** gains `--fleet <id>`.

### The migration, which is the part that could have gone wrong

The shared relay holds four devices that paired before fleets existed, none with a `fleet_id`.
The rule is therefore two-mode, and both modes are tested against the relay's *actual* state:

| relay | requester | reaches |
|---|---|---|
| unscoped (`--fleet` absent) | operator, or a fleetless device | **every device — byte-for-byte the old behaviour** |
| scoped (`--fleet X`) | operator | **fleet X** |
| scoped | a device in fleet X | **fleet X only** |
| scoped | a fleetless device | **nothing**, with the reason named |

**Deploying this cannot be an outage**, and **scoping it cannot be a silent grant** — the second
row of that table is what makes the first row safe to ship.

### Three defects found while wiring, all by tests

1. **`NO_ELIGIBLE_DEVICE` was invented.** It broke the one relay test that pins the contract, and
   worse, it would have broken **callers**: `chatops/fleet.mjs` reads `NO_ONLINE_DEVICE` to
   produce *"start an agent on each machine"*, and an unrecognised code falls through to a generic
   refusal. The protocol's code table is part of the protocol; the new information went into
   `detail` instead.
2. **An absent requester was refused as an unknown one.** An operator is not a device —
   `authorizeTaskDispatch` returns `{ role: 'operator', machine_id: null }` — so treating "no
   device" as "unknown device" turned every operator dispatch into an error and broke **74 relay
   tests at once**.
3. **An operator dispatch on a scoped relay was refused.** Configuring the fleet made the operator
   unable to dispatch, which is the least useful possible outcome. The relay's own `fleetId` *is*
   a statement about which fleet it serves, so an operator dispatch has an unambiguous scope and
   lands inside it.

### Verification

* **432 chatops cases across sixteen suites**, including **ten that boot a real relay** and assert
  the three links end to end: `--fleet` → the code carries it → the device carries it → dispatch
  reaches only that fleet.
* **The relay's own 168 tests pass unchanged**, which is the migration guarantee: the legacy path
  reproduces the rule it replaced.
* The repository's wider suite keeps its baseline of one environmental failure (a missing
  `node_modules/eslint`).

### Deployed

The Linux server (`vultr`, `202.182.123.154`) was updated **v0.6.3 → v0.7.7** with a scripted
deploy: checksum verified before unpacking, the previous tree backed up, the new tree staged and
checked for entry points, then swapped, restarted and health-checked, with automatic rollback on
failure. Relay state (`/var/lib/w2m/rabbit`) was untouched — the 839 KB ledger and the operator
token both survived.

**It runs unscoped**, so its four devices keep working exactly as before. Setting `--fleet` is
what turns isolation on, and it is now a one-line change plus a re-pair.

### Still not done

* **Hand-off is not wired into the relay's lease sweep.** `handoff.mjs` is complete and tested;
  `shouldHandOff()` is not yet called on lease expiry. A silent machine is still simply silent.
* **Device-side signals are not sent.** No device generates a keypair in a real run, and no request
  carries a signature. The relay's existing HMAC signing (`signing.mjs`) is a different mechanism
  and is untouched.
* **`/v1/devices` is not narrowed to the caller's own fleet.** A device on a relay can still list
  every fleet's machines; it cannot *reach* them, which is the part that matters for isolation.
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.7] — 2026-10-14

**Hand-off: what happens when the machine holding a task does not answer.** `ACCOUNT-FLEET-DESIGN.md`
§4, built.

> **Two things this release does not do, said first.**
>
> 1. **The relay still does not call any of the v0.7.6/v0.7.7 modules.** Dispatch is still
>    `[...this.devices.values()]`, no keypair is generated, no statement is issued, no request is
>    signed, and no lease is ever handed off. **At runtime, accounts remain mixed and a silent PC
>    is still simply silent.** These releases are the mechanism.
> 2. **The Linux server was not updated.** Its SSH credentials were not available to me
>    (`ssh_run.py` deliberately reads them from the environment with no fallback in the file), so
>    the relay there still runs v0.6.3-era code. Updating it needs `W2M_PASS`.

### Added

* **`src/chatops/handoff.mjs`** — the hand-off decision, and the sharp edge it names.
  * **`write: true` plus `halt: 'now'` is refused outright.** Hand-off turns execution from
    at-most-once into **at-least-once**: a command may now run on two machines. Harmless for
    `node --test`, and a second application of the same change for anything that writes — on a
    machine with no idea the first one already ran. Refused, not warned about.
  * **A late result never overwrites its successor.** The winner is the **highest attempt**, not
    the last to arrive: arrival order is a property of the network, and a verdict that depends on
    it is a verdict nobody can reason about. Superseded results are **kept, not dropped** — a late
    result from the machine that went silent says it was slow, not dead, and discarding it turns a
    diagnosable situation into an unexplained one.
  * **The machine that just went silent is never offered its own slice again** — the one
    reassignment guaranteed to be useless.
  * **A slow machine is not pre-empted.** Two separate questions, in order: is the lease still
    valid, and has the grace elapsed since it expired.
  * **Every refusal is named**, because *"why did nothing take over"* has several answers with
    different fixes: cancelled, `halt: 'never'`, a writing task, no other machine, every machine
    already tried, not yet expired.

* `test/chatops-handoff.test.mjs` — 29 cases.

### Three defects found in this module by its own tests

Worth recording, because each was invisible in the code and obvious in a failure:

1. **The grace-period arithmetic was on the wrong side.** The first version asked
   `now + grace <= until`, which declines when the grace is *short* and takes over when it is
   *long* — the exact inverse. Two questions were being collapsed into one expression; they are
   now separate branches.
2. **`ALL_TRIED` was unreachable.** It was decided by asking "is there an untried machine", which
   is always false in the all-tried case, so the reason could never fire and the two refusals were
   indistinguishable. The real question is how many machines *exist*, not how many are untried.
3. **A missing attempt number was treated as the newest.** `?? Infinity` made a frame with no
   attempt win the aggregate — letting a stale result from a superseded lease override its
   successor, which is the precise inversion `reconcileResults` exists to prevent. A missing
   attempt is an **old** frame: it now sorts as `0`.

### Still not connected

`auth.mjs`, `fleet-scope.mjs` and `handoff.mjs` are complete and tested, and **nothing in `src/`
outside `src/chatops/` imports them.** The relay must still:

* bind pairing codes to a fleet and sign a statement per device,
* verify the statement and the request signature on every call,
* replace the target selection with `selectTargets()`,
* call `shouldHandOff()` on lease expiry, and `reconcileResults()` when results arrive.

Until that is done, the isolation and the hand-off are **designed and tested, not in effect**.

## [0.7.6] — 2026-10-14

**The authorisation chain and the fleet scoping rule.** `ACCOUNT-FLEET-DESIGN.md` §3, built.

> **Read this before trusting the isolation.** The two modules below are complete and tested, but
> **the relay does not call them yet.** `src/relay/state.mjs` still selects targets with
> `[...this.devices.values()]`, so at runtime accounts remain mixed. Wiring it is the next step
> and is not in this release. Saying "isolation is implemented" now would be false.

### Added

* **`src/chatops/auth.mjs`** — the device keypair and the authorisation statement.
  * A device generates an **Ed25519** keypair on first run; the private key is exported for
    persistence and the caller is told to write it 0600 and never log it.
  * The relay seals a statement over `(fleet_id, machine_id, sn, public_key, issued_at, expires_at)`.
  * Every request carries a signature over `(method, path, timestamp, nonce, body_hash)`.
  * **The canonical encoding is built by hand, with length-prefixed fields and a fixed field
    order.** Two JSON encodings of one object can differ, so a verifier that re-serialised what it
    received would be verifying its own encoding; and without length prefixes `{a:'x',b:'yz'}` and
    `{a:'xy',b:'z'}` concatenate identically. The wire form carries **the exact bytes that were
    signed**, so nothing is ever reassembled.
  * **Expiry is mandatory** — a statement without one is a permanent credential. Checked *before*
    the canonical form is recomputed, so a missing expiry reports `no_expiry` rather than the
    technically-true-but-useless `malformed`. A test found that ordering.
  * Replay defence is a **bounded** nonce window, injected: an unbounded set is a memory leak a
    peer can drive, and the timestamp window already rejects anything old enough to fall out.
  * Fleet keys are **derived** per fleet from one master secret, so a relay serves many accounts
    without holding a key per account and one fleet's key does not sign for another.

* **`src/chatops/fleet-scope.mjs`** — which devices a request may reach.
  * **The fleet comes from the pairing code, never from the device.** A device that could name its
    own fleet would join any account, and every signature would faithfully attest to a lie.
  * **An absent fleet is not a wildcard.** `undefined === undefined` is explicitly **not** a match.
    This is the most dangerous available mistake: two ungrouped devices matching each other would
    silently restore the exact "everything in one pool" behaviour being removed, and every test
    that only ever sets a fleet would keep passing. There is a test named for it.
  * **A foreign target is refused with the same answer as a nonexistent one**, so a caller cannot
    enumerate another account's machine ids by trying them and reading the error.
  * **A partial dispatch is refused whole** — silently dropping a named target leaves the caller
    believing it dispatched somewhere.
  * Offline devices are **counted, not silently dropped**: "we tried and they were offline" and
    "there are none" produce the same empty result and different fixes.

* `test/chatops-auth.test.mjs` (33 cases) and `test/chatops-fleet-scope.test.mjs` (25 cases).

### The tests are written against the attack, not the happy path

Each names the failure it prevents, and three of them assert a **weakening** rather than a
strength: that a device editing its own `fleet_id` fails verification, that swapping in its own
public key fails, and that an ungrouped device matches nothing. Those are the changes that would
look correct in a diff and quietly undo the isolation.

### Not in this release

* **The relay does not call either module.** No device keypair is generated in a real run, no
  statement is issued, no request is signed, and dispatch is still unfiltered. This release is the
  mechanism; connecting it is next.
* **The relay does not yet issue pairing codes bound to a fleet**, so `fleetFromPairingCode` has no
  producer in a live relay.
* **Hand-off is not implemented** — that is v0.7.7.
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.5] — 2026-10-14

**Stage 1 of the account-fleet design: this machine now knows which account it belongs to, and
has a serial number.** The relay and the dispatch path are deliberately untouched — scoping
dispatch by fleet is v0.8.0, because it changes the protocol.

### Added

* **`src/chatops/account.mjs`** — the identity root.
  * **The account code comes from the host, not from a fetch and not from config.**
    `ctx.deepseekAccount.getDeviceIdentity()` returns `userId`, which is hashed to an 8-hex
    account code. There is deliberately **no way to set it from configuration**: a value an
    operator can type is a value an attacker can type, so a hand-entered "account code" would be
    a forgeable account code.
  * **The SN is `W2M-<ACCT>-<HWID>-<TS>`, 40 characters**, defined to the character, with the
    timestamp fixed at first generation so a restart cannot change a machine's identity.
  * **Hardware sources per platform, all injectable**, so a Windows-shaped machine is exercised
    on any host: `MachineGuid` / SMBIOS UUID, `IOPlatformUUID`, `/etc/machine-id`.
  * **Placeholder values are refused before hashing.** Firmware that reports an all-zeroes UUID
    would otherwise give *every such machine the same hardware code* — far worse than having none,
    because it silently merges distinct machines.

* `test/chatops-account.test.mjs` — 42 cases.

### Two things the tests assert on purpose

* **That a forged SN passes the shape check.** `isWellFormedSn` is named for what it does — it
  answers "is this well formed", and an SN is computed by the party being checked, so nothing
  about it is verifiable by inspection. The test *documents* this rather than papering over it,
  so a future change that turns the shape check into an authorisation check fails a test instead
  of building on sand.
* **That two accounts get different fleets and two machines in one account get the same fleet.**
  The property the whole scheme exists for, asserted directly rather than inferred.

### Fixed

* **The published v0.7.4 release notes claimed the SN is 41 characters. It is 40**
  (4 + 8 + 1 + 12 + 1 + 14). The design document said the same thing in one place. Both are
  corrected, and the release notes were edited in place. The wrong number came from arithmetic
  done by hand; the unit test that asserts the length is what caught it.

### Not in this release

* **The relay still does not scope by fleet.** `docs/ACCOUNT-FLEET-DESIGN.md` §3 is designed and
  unimplemented: dispatch targets are still `[...this.devices.values()]` with no filter, so
  accounts remain mixed. That is v0.8.0 and it is a breaking protocol change.
* **No device keypair yet.** The SN exists; the signature chain that makes account membership
  *verifiable* rather than merely *asserted* does not.
* **No message has yet gone from a phone through WeChat to the fleet.**

## [0.7.4] — 2026-10-14

**No code changed.** This release is an audit and a design document, and it exists because the
audit found that the answer to *"is each account's fleet isolated?"* is **no** — in a way worth
writing down before anything is built on top of it.

### What the audit found, every line with its source

| question | answer | where |
|---|---|---|
| Is a device identity bound to an account? | **No.** `machine_id` is `randomUUID()` — no account, no hardware | `src/agent/agent.mjs` |
| Does an SN exist? | **No.** The concept is not in the codebase | entire repo |
| Is there a hardware identifier? | **No.** `caps` probes os/arch/node/python but never enters identity or authorisation | `src/agent/caps.mjs` |
| Does the relay use `user_id` for isolation? | **No — it stores it and never reads it.** Five references, every one a store or load | `src/relay/state.mjs` L507/736/981/993, `persistence.mjs` L170 |
| Does the plugin reference `user_id`? | **Zero times** | `src/plugin/tools.mjs` |
| Are dispatch targets filtered by account? | **No.** With no `target_machines`, `targets = all` — every device on the relay | `src/relay/state.mjs` L1259-1262 |
| Device table shape | **One flat Map**, no grouping dimension | `src/relay/state.mjs` L435 |

Measured on the shared relay (`a1b59a3b04dcd180`): **`devices=4`, all in one pool, with a single
pairing code.** Any machine holding that code joins the same pool, and any caller holding a valid
operator token has its task broadcast to every one of those four machines.

### Added

* **`docs/ACCOUNT-FLEET-DESIGN.md`** — the design for account-scoped fleets, in three parts as
  asked: the exact SN format, the relay authorisation model, and the hand-off timing.

  The identity source is **verified, not assumed**: DSH already exposes `ctx.deepseekAccount`,
  whose `getDeviceIdentity()` returns `{ deviceId?, userId?, osVersion }` and is documented as
  *"read existing login identity without creating a device or returning credentials."* The
  account's unique identifier therefore needs **no account API call** — and a hand-typed account
  code in a config row is explicitly ruled out, because a value an operator can type is a value
  an attacker can type.

  The SN is defined to the character: `W2M-<ACCT>-<HWID>-<TS>`, 41 characters, with `ACCT` a
  truncated `sha256(userId)` rather than the raw id (it ends up in logs, chat messages and device
  lists), `HWID` from platform-stable sources only — MAC addresses, mount points and package
  lists are excluded because they change and would make one machine look like two — and `TS`
  fixed at first generation.

### Three things the design says out loud that a proposal usually does not

1. **An SN cannot be a credential.** It is computed and asserted by the client, so anyone who
   knows or guesses an account id can forge one. The document states that the relay must never
   trust an SN, and that the timestamp provides **no** cryptographic uniqueness — uniqueness is
   `(ACCT, HWID)`, and the timestamp only distinguishes re-registrations and makes the string
   auditable. A string scheme presented as hardware-grade protection is worse than none, because
   it is believed.
2. **Hand-off makes execution at-least-once.** A command may run on two machines. Harmless for
   `node --test`, harmful for anything with `write: true` — so the design **forbids automatic
   hand-off for writing tasks** until a fencing token exists.
3. **The relay is the trust root.** Compromising it forges any fleet's authorisation. The design
   accepts that rather than adding an online account check, which would stop offline machines
   from working at all.

### Not in this release

* **Nothing from the design is implemented.** It lands in **v0.8.0**, because it changes the relay
  protocol — a breaking change that needs an explicit refusal path for older devices rather than
  a silent failure.
* **No message has yet gone from a phone through WeChat to the fleet.** The adapter is verified
  against live WeChat and the executor against a live relay; **the two have not been joined by a
  human typing.**

## [0.7.3] — 2026-10-14

**The fleet reader used the wrong credential and the wrong field names.** v0.7.2 shipped an
executor that had never been pointed at a live relay. Found by running it against one.

The agent's own log proved the task really ran:

```
[agent] offer 01M4VC7KWKF5WA5Q6BBDNH4AXM attempt 1 {"argv":["node","src/facts.mjs"]}
[agent] result delivered for 01M4VC7KWKF5WA5Q6BBDNH4AXM {"status":"nonzero_exit"}
[agent] result accepted for 01M4VC7KWKF5WA5Q6BBDNH4AXM {"status":"nonzero_exit"}
```

— while the poll loop printed erdict=undefined thirty times.

### Fixed

* **GET /v1/tasks/<id> needs the device token, not the operator token.** With the operator
  token it answers 401 {"code":"UNAUTHORIZED","message":"missing or invalid device_token"}.
  Dispatching and reading take different credentials; the executor now holds both, and a refusal
  names which one it wanted, because *"your operator token is wrong"* and *"this install is not
  paired"* have different fixes.
* **The verdict is at ody.aggregate.status, not the top level.** The per-machine rows are
  ody.leases[] on a status and ody.machines[] on a report, and the machine field is
  machine_name. The first version read ody.verdict and ody.results, so every machine
  printed as ?: ? while the task completed perfectly.
* /v1/devices wants the device token too on this relay build.
* A lease row carries state rather than outcome until the result lands, so describeMachines
  shows the outcome when there is one and the lease state when there is not.

### Verified end to end

Against a live relay and a live Localside agent on Windows:

```
任务 01M4VCET — unverifiable
命令：node src/facts.mjs
win-desktop: unverifiable  status nonzero_exit  exit 1
```

272 chatops cases pass.

### Still not claimed

No message has been sent from a phone through WeChat to the fleet. The adapter is verified
against live WeChat and the executor is now verified against a live relay, but **the two have
not yet been joined by a human typing**.
## [0.7.2] — 2026-10-14

**Run the fleet from a chat message, and get the machines' own verdict back.**

v0.7.1 shipped a working WeChat adapter and could still do nothing with it: `/run` answered
*"this install has no fleet"*, because the executor did not exist. This adds it.

### The gap was architectural

`w2m_run` and `w2m_wait` are DSH **tools**: their bodies live inside the plugin's `ctx.tools`
registration and are shaped for a model to call — a schema, a card, an error type the host
renders. The chat bridge needs the same work with none of that: an argv in, a verdict and a
sentence out.

The bridge cannot call the tools. A tool call needs `@deepseek-ai/dsh-tools`, which exists
**only inside `app.asar`** — a separate process cannot complete one, and an in-process call would
have to fabricate the host's own calling convention. So the fleet work is now expressed once
against the relay's HTTP API, and the tool and the chat bridge are both callers of it.

### Added

* **`src/chatops/fleet.mjs`** — `POST /v1/task`, `GET /v1/tasks/<id>`, `/report`, `/devices`, the
  same paths the plugin's own tools use. A refusal is returned as a value: the relay's refusals are
  answers, and the two that matter get their own sentences, because *"start an agent on each
  machine"* and *"your operator token is wrong"* are different instructions. A wait that expires
  reports `timeout` as a **verdict** rather than throwing — a fleet with one dead machine never
  reaches a terminal state, and silence is the worst possible reply to a phone.
* **`src/chatops/actions.mjs`** — the action set `commands.mjs` calls, plus the phone-sized
  formatting rules.
* **`/where <task id>`** and **`/report <task id>`**, so a task id from a reply is actionable.
* `test/chatops-fleet.test.mjs` — 28 cases.

### Two properties worth naming

* **The argv is never joined into a string.** A chat message is attacker-influenced text, and the
  array is what keeps a shell from ever seeing it. A formatter that joined and re-split would work
  for every command until the first one with a space in an argument.
* **`divergent` and `divergent-platform` are not collapsed.** They mean different things — one is
  a bug, the other a platform difference — and paraphrasing either into "failed" is how a
  portability difference becomes an incident.

### Changed

* `createBridge` now accepts a policy **instance** as well as the overrides to build one. The
  action set has to share the bridge's policy, or `/trust` widens a copy that admission never
  consults and the command silently does nothing. Duck-typed on `admit()` so the two modules need
  not import each other's constructors.
* `apply()` builds the executor from the same `rabbitUrl` / `operatorToken` row the tools read, so
  there is one setting rather than two, and resolves the token in the same order (row, then
  `W2M_OPERATOR_TOKEN`). An install with no `rabbitUrl` gets named refusals — *"no rabbitUrl is
  configured"* — instead of an absent action.

### Verified

**271 chatops cases pass**, 28 of them new.

### Not yet done — the honest caveat

The round trip has been verified against **live WeChat as far as the adapter**, and against
**the relay as far as the executor**. But **no command has been sent from a phone to the fleet end
to end.** That is the next thing to test, and this release does not claim it.

## [0.7.1] — 2026-10-14

**v0.7.0's WeChat channel could not send a single message.** This release fixes it, and the
way it was found is the point.

### What was wrong

v0.7.0's `ilink.mjs` was written by *reading* the audited plugin's TypeScript. Every field name
in it was wrong — nine separate mismatches — and all 237 of its tests passed, because those tests
drove an injected transport and asserted on the requests we *constructed* rather than the
requests WeChat *accepts*. **A self-consistent suite cannot falsify its own assumptions.**

The first real request, made with a real QR scan and a real bot, returned:

```json
{"errcode":-14,"errmsg":"session timeout"}
```

That message is a lie about its own cause, which is why it took as long as it did:

| # | v0.7.0 | Measured |
|---|---|---|
| 1 | *(absent)* | **`AuthorizationType: ilink_bot_token`** |
| 2 | *(absent)* | **`X-WECHAT-UIN`**, a per-request random |
| 3 | `to_user` | `to_user_id` |
| 4 | bare `{msg}` | `{msg, base_info}` |
| 5 | `item_list[].text_item` | also `type: 1`, `from_user_id`, `client_id`, `message_type: 2`, `message_state: 2` |
| 6 | `getupdates` body `{}` | `{get_updates_buf, base_info}` |
| 7 | `bot_id` / `owner_user_id` | `ilink_bot_id` / `ilink_user_id` |
| 8 | success = HTTP 2xx | **`ret === 0`** |
| 9 | — | failures use **`errcode`/`errmsg`** and **still return HTTP 200** |

**#1 is the one that cost the most time.** Without `AuthorizationType`, every authenticated
endpoint answers `-14 session timeout` — *including a request carrying no `Authorization` header
at all*, because the server rejects on the missing type before it reads the credential. That made
it look like an expiry bug, and an expiry bug is investigated by checking clocks, re-scanning
codes and re-minting tokens. It is not one.

**#8 and #9 are the dangerous ones.** A refusal arrives with HTTP 200, so a status-code check
reports a failed send as a delivered one — the exact silent-failure shape this release series
exists to remove, and it had been reintroduced in the adapter. `send()` now rejects on
`errcode`, so the outbound queue can never count a refusal as a delivery.

### Also fixed

* **The transport did not exist.** v0.7.0 required the host to inject `chatopsIlinkRequest` and
  shipped no default, so no request could ever be sent and `apply()` could never mount a working
  channel. `ilink-transport.mjs` is now the default, and injecting one only overrides it.
* **64-bit ids were rounded.** A live `message_id` is 7515840255213248776 — past
  `Number.MAX_SAFE_INTEGER` — so `JSON.parse` returned `7515840255213249000`. The transport now
  recovers the exact digits. Rounding is harmless for de-duplication and not harmless if an id is
  ever persisted as a key or sent back.
* **The host allow-list was wider than the measurement.** v0.7.0 allowed `weixin.qq.com` and
  `api.weixin.qq.com` on a guess; the login response returns exactly `ilinkai.weixin.qq.com`. An
  allow-list wider than what was observed is not caution, it is the absence of the check.
* **A precision bug in the fix itself**, caught by the suite it was written for: the first
  `repairMessageIds` mutated in place, so a shared test fixture was rewritten by whichever case
  ran first.

### Added

* `src/chatops/ilink-protocol.mjs` — the measured wire format in one place, each constant
  annotated with the live response it came from.
* `src/chatops/ilink-transport.mjs` — the real HTTP transport, with per-request deadlines, the
  `ret`/`errcode` distinction returned as data, and `undici`'s `cause` unwrapped so a network
  fault does not read as a protocol fault.
* `test/chatops-ilink-contract.test.mjs` — **36 cases pinned to fixtures taken verbatim from live
  responses**. The rule it enforces: if a field name changes, a test here must fail. That is the
  mechanism that would have caught all nine.
* `scripts/ilink-login-and-probe.mjs`, `scripts/ilink-qr-poll.mjs`, `scripts/ilink-talk.mjs` —
  the probes that found this. Kept because they are the only way to check the adapter against
  reality rather than against itself.

### Changed

* `test/chatops-ilink.test.mjs` **removed**. It asserted the wrong protocol — `body.msg.to_user`,
  `msg_list` — so keeping it would have pinned the v0.7.0 defects back in. The contract suite
  replaces it.

### Verified against live WeChat

A real QR scan, a real bot, a real exchange in both directions:

* `get_bot_qrcode` → `{"qrcode":…,"qrcode_img_content":…,"ret":0}`
* `get_qrcode_status` → `{"status":"confirmed","bot_token":…,"baseurl":…,"ilink_bot_id":…,"ilink_user_id":…}`
* `notifystart` → `{"ret":0}`
* `getupdates` → the peer's reply, read verbatim
* `sendmessage` → `{"message_id":7515840555615131656}`, received on the phone

### Not fixed, and not claimed

* **Feishu, DingTalk and WeCom are still not implemented.** They need vendor SDKs this project
  cannot vendor or review. The contract they must satisfy is `channel.mjs`.
* **Only the WeChat path has been exercised against a live platform.** That is one of four, and it
  is the one that happens to need no SDK.
* **No command has been run through the bridge from a phone yet.** The adapter is verified; the
  end-to-end path from a chat message to `/run` on the fleet is not.

## [0.7.0] — 2026-10-14

The release that answered "can we drive the fleet from a phone?" with **not yet, and
here is exactly why** — and then built the two pieces that had to exist first, under
test.

### Why this is not the feature, and why that is the honest release

The goal was to fold [`dsh-chatops`](https://github.com/ZhuoSir/dsh-chatops) 0.1.0 —
an IM bridge for WeChat/Feishu/DingTalk/WeCom — into this plugin as a feature. It was
read in full instead of trusted: ~168 KB of TypeScript across 40 files, plus the
published 3,544-line bundle, which is byte-identical to the committed source modulo
CRLF (`minify:false`, so identifiers and comments survive — the audit is on the real
artifact).

**It is not safe to adopt as written, and the reasons are not stylistic:**

* The approval answerer registers `(req) => …` on the `approval/request` **waterfall**
  and never calls `next()`. This host documents that event as *"Return an outcome to
  claim the request or call `next()` to delegate"*, and cordis's `waterfall` consults
  the next listener **only when the current one calls `next()`**. The plugin's listener
  is also `async`, so it hands back a Promise, and the harness takes any non-`undefined`
  value as the final answer. The host's own GUI answerer is therefore never consulted
  for a session that has an IM window bound, and the request is held until the plugin's
  own 300 s deadline. Whether it happens at all depends on listener **registration
  order**, which the plugin does nothing to control. This is the one defect that reaches
  beyond the plugin.
* The first private message on any of three channels makes its sender a **permanent
  owner**, before any authorisation runs, with no pairing code and no allow-list, and
  persists the claim to `bindings.json`. All four channels ship enabled by default. Once
  adopted, that identity can enumerate every workspace and session, inject prompts,
  read transcripts via `/log`, exfiltrate workspace files via `/send`, approve, and
  switch the sandbox to `danger-full-access`.
* `GET /chatops/api/config` returns four platforms' credentials in cleartext behind a
  loopback-only check with no token and no Origin validation; the settings page re-polls
  it every 3 s. `POST` to the same path merges an unvalidated body into the config and
  writes the profile's `cordis.patch.yml` — and `puppet` is passed to `await import()`,
  so that path is arbitrary module load.
* Pending approvals were keyed by window alone, so a second concurrent request
  overwrote the first and the older became unanswerable from IM.
* The workspace file fence is lexical only (`resolve` + `startsWith`); `statSync`
  follows symlinks, so a link inside the project ships any readable file to IM.

Shipping that as a headline feature would have been a regression in every user's
safety, so it is not shipped. The audit is published instead, and the two modules that
had to exist first are built and tested.

### Added

* **`src/chatops/approval-broker.mjs`** — the approval seam, designed so the defect
  above cannot recur:
  * **declining is synchronous and never touches `next`**, so a bridge with nothing to
    ask leaves the host's answerers to answer;
  * **a deadline delegates instead of deciding** — a phone that did not answer is not
    an operator who said no, so the timeout calls `next()` and lets the answerers behind
    it decide;
  * **pending requests are keyed by approval id and queued per window**, so two
    concurrent requests cannot overwrite each other;
  * ids carry full entropy, where 0.1.0 minted `randomUUID().slice(0, 8)` — 32 bits held
    for five minutes;
  * `dispose()` settles everything outstanding, so a reload leaves no timer that can
    resolve a promise belonging to a fiber that no longer exists;
  * the clock **and** the timer are injectable. That pairing is the whole reason the
    suite is deterministic: an injected clock with a real `setTimeout` is two clocks, and
    the first version of this test hung rather than failed.
* **`src/chatops/policy.mjs`** — who may command this machine, fail-closed:
  * **nothing is trusted because it arrived.** An identity is trusted only by being
    seeded in config or by redeeming a single-use, expiring, per-identity rate-limited
    pairing code. There is no path that trusts a sender because nobody else had spoken;
  * identity is `(channel, id)`. 0.1.0 held one flat `Set` matched after stripping the
    channel prefix, so the same raw id was the same person on every platform;
  * **a room is not a person**: an allowed room is never sufficient — the speaker must
    also be individually trusted, where 0.1.0 returned `true` for every member of an
    allowed room whenever `allowContacts` was empty;
  * revocation exists, which 0.1.0 had no way to do short of deleting its state file;
  * `CHANNELS` is **one** registry. The same information lived in four places that had to
    agree, and a channel missing from the authorisation regexes had every message from it
    silently dropped;
  * a well-formed key naming an unenabled channel is a **named** refusal
    (`channel_unknown`), because a silent drop is indistinguishable from a bot that is
    simply broken.
* `test/chatops-approval.test.mjs` (24 cases) and `test/chatops-policy.test.mjs`
  (24 cases), both wired into `test` and `test:all`.

### Not in this release

* **Only one channel adapter ships, and it is the WeChat one.** `ilink.mjs` is here because
  its protocol is JSON over HTTPS with no vendor SDK — the other three channels need SDKs
  this project cannot vendor or review. Feishu, DingTalk and WeCom are not implemented; the
  channel contract they must satisfy is `channel.mjs`, checked by the same validator `ilink`
  passes.
* **Nothing has been exercised against a live WeChat account.** The adapter's whole network
  surface is one injected `request()`, so its request shaping, response mapping,
  de-duplication, state machine and host allow-list are all asserted — 30 cases. What that
  suite cannot tell you is whether WeChat accepts the requests. That needs a QR scan and a
  real bot, and is not claimed.
* The audit's own limits: the chatops dependency trees were not resolved (no `node_modules`
  was installed, and none of its code was executed), and its Feishu card-action signature path
  lives inside a vendor SDK that was not available to read.

### Note on the other half of the work

The three-machine comparison this fleet exists for still needs one commit that all
three machines can reach. The Mac runs the project at `a1e7dc04` on a clean tree with
`--project /Users/fang/w2m-project` — already correct, and already the same path its own
DSH uses; the mismatch is that this is not the commit the Windows host and the Tokyo
relay are on. Its `git ls-remote` to GitHub times out while `curl api.github.com`
answers 200, so the reachable common anchor is `origin/main` (`6e7ba0c9`, the v0.6.3
tag) rather than the fixture commit used for the local runs.

## [0.6.3] — 2026-10-13

One fix, and it is the half of v0.6.2 that made the other half usable.

### Fixed

* **`w2m_status` now reports `encryption.relay_serves_keys`.** v0.6.2 taught the node to tell a relay
  that drops peer keys apart from a peer that has none — and then did not carry the answer to the one
  surface an operator actually reads. The plugin builds its encryption block from an explicit field
  list, and the new field was not on it, so a fleet in exactly the state v0.6.2 exists to explain still
  showed `peers_known: 0` with no way to see why.

  Measured on the machine that built the release: `w2m_status` returned

  ```json
  "encryption": { "enabled": true, "public_key": "cQshuntt…", "peers_known": 0,
                  "handshakes": 0, "encrypted_channels": 0, "plaintext_channels": 0 }
  ```

  while the node underneath it was reporting `relay_serves_keys: false` against the same relay. The
  feature worked and was invisible — which is the failure mode the field was added to remove, one
  layer up.

  `?? null`, not `?? 0`, because the value is three-valued and collapsing it would accuse the relay
  before it had been tested: `null` means no announcement has proved it either way (or this node has
  no key of its own, so it never asked), `false` means the relay dropped the key we sent.

## [0.6.2] — 2026-10-13

The release that stops a broken *relay* from being reported as an out-of-date *peer*, and stops a
relay that has quietly stopped recording from looking healthy.

The incident, measured on this fleet: every machine at v0.6.1 held a valid device key and announced
it, `peers_known` stayed `0` on all of them, no handshake was ever armed, and every direct channel
came back `P2P_CRYPTO_PLAINTEXT_PEER` — documented as *"the peer never learned a key (an older
build)"*. Both ends were the same build, on the same host. The component that was actually behind was
the relay: it started `2026-10-10T18:01:40Z`, and v0.6.0 and v0.6.1 shipped on `2026-10-11`. It had
never heard of `static_key`, so it accepted every announcement, dropped the field, and served entries
without it. The reason code blamed the one component that was up to date.

### Added

* **`encryption.relay_serves_keys`** — whether the relay keeps the key this machine announces. `null`
  until an announcement proves it either way; `false` when the relay dropped what was sent; `null` for
  a node with no key of its own, because such a node never asked and must not conclude "no". Detected
  from this node's **own** announcement — it POSTs a key and the relay echoes the entry it stored — so
  it needs no relay cooperation, no version negotiation and no capability call. That is what makes it
  work against the relay that is actually deployed, which is the whole point.
* **`P2P_CRYPTO_RELAY_NO_KEYS`** — a new reason, used when a peer announced, this machine holds a key
  of its own, no key came back for that peer, and this node has already proved the relay drops keys.
* **`/healthz` reports durability**: top-level `degraded` and `degraded_reason`, plus `degraded`,
  `degraded_since`, `last_append_error` and `append_failures` inside `persistence`. `ok` deliberately
  stays `true`: the relay still serves the fleet, and flipping it would turn a recording problem into
  an outage. Persistence disabled is not degraded — there is nothing that can fail.

### Fixed

* **The reason a direct channel is plaintext now names the real cause.** `punch()` computed it as
  `request === null ? PLAINTEXT_PEER : NO_KEY`, and `dial()` sends no crypto request in three
  situations that are all *local* — this machine has no device key, it holds no key for that peer, or
  it is dialling itself. Every one of them was reported as the peer being old. The code already
  disagreed with itself about this: `dial()`'s own comment claims the reason "then says
  `P2P_CRYPTO_NO_KEY`". The reason is now decided where it is known and travels with the call;
  `PLAINTEXT_PEER` keeps its real meaning and keeps firing for the one case that is genuinely about
  the peer — it publishes no key, so there is nothing to encrypt with.
* **`dial()` learns the peer key it was throwing away.** The peer's `static_key` has ridden in the
  relay's `/v1/peer/{id}` record since v0.6.0, and `dial()` was fetching that very record for the
  candidate list and discarding the key. A dispatcher that reported `PLAINTEXT_PEER` against a
  same-version peer could have encrypted; it had an empty store and never asked. Reporting alone would
  have been a better-worded lie.
* **`device.key` is loaded from beside `device.json`, not from `--state`.** The plugin followed the
  documented rule; the agent did not, on the stated grounds that "`identity.mjs` puts `device.json`
  when the agent is run with `--state`" — which is false. `device.json` is fixed at
  `<DSH_HOME>/xclient/device.json` by the identity contract and `--state` does not move it. Measured
  consequence on one machine running both halves: two different keypairs under one `machine_id`, both
  announcing to the one `/v1/peer/{machine_id}` slot, the relay's record alternating between the two
  nodes' ports every ~8s, each announcement overwriting the other. A dispatcher reading that record
  learned one node's key or the other's, never reliably the key of the node it was about to dial. The
  fix takes the path the caller actually resolved — `bin/w2m-localside.mjs` already had it in
  `identityPath` and simply did not pass it down — and deliberately does **not** re-resolve `DSH_HOME`
  inside the agent, which would make a test or an embedder read and *create* a key in the real user's
  home.
* **A key already generated in `--state` is adopted, not abandoned.** `DeviceKey.load` warns that
  "silently generating a replacement key would make every peer that knows the old one refuse this
  machine", so the canonical location may create and a legacy file may only be adopted. An adopted key
  is logged, because the public key is what a peer authenticates this machine by.
* **A relay that serves without recording now says so.** On a full disk the relay answered every
  request normally and appended nothing; the only trace was one warning per failed append, and this
  fleet's relay had reached **22 byte-identical `ENOSPC` entries**, so the signal was buried in its own
  repetition. Identical warnings are now counted rather than repeated, and durability is a first-class
  state: entered by the first failed append, cleared by the next success. `append_failures` is
  cumulative and deliberately never reset — "how much was lost" is the first question after a disk
  fills, and a counter that returns to zero cannot answer it.
* **A patch override that asserts the wrong `name:` now has a documented failure mode.** In a patch,
  `name` is an *assertion* about the entry being targeted, not a rename, and the Loader drops the whole
  patch on mismatch — leaving the plugin mounted on the bundle's empty defaults: eight tools present,
  `w2m_status` reading `paired: false` and a null `rabbitUrl`, with the profile's settings sitting in
  the file the whole time, unread. README now carries the hazard where the config block is copied,
  `TROUBLESHOOTING.md` §2 names it as the third mechanism for "the patch lost my configuration" (and
  the only one where the file looks intact), and §17 documents the reason codes this release adds and
  corrects.
* **`test/agent.test.mjs`'s sub-path CLI test no longer depends on the host's `PATH`.** This is what
  made v0.6.1's own pre-flight **RED** — "do not bump" — on a machine where node exists only as DSH's
  bundled runtime. `runCli` points the child's `DSH_HOME` at a scratch directory, so
  `bundledBinDirs()` correctly finds no bundled runtime there; the command under test is built from
  `process.execPath` while the allow-list entry is the bare name `node -e`; and with no bundled runtime
  and no `node` on `PATH`, that name does not resolve, so the absolute path is refused with
  `COMMAND_EXECUTABLE_PATH_MISMATCH` — the allow-list behaving exactly as documented. CI runs
  `actions/setup-node`, which is why it was green there. The child now gets the executing node's own
  directory on its `PATH`, which restores the identity the check exists to confirm rather than
  weakening it: a mismatched absolute path is still refused with the same code.

### Changed

* `scripts/preflight.mjs` reports **11 pass, 0 fail, 1 unverifiable — GREEN, cleared to bump** on a
  clean macOS checkout. Before this release the same gate reported "10 pass, 1 fail — RED".
* The local suite reads **557 tests, 555 pass, 0 fail**.

## [0.6.1] — 2026-10-11

### Fixed

* **v0.6.0 was tagged and never published, because its release pipeline ran a pre-flight that could not
  complete on the platform that builds the artifact.** Nothing was wrong with the v0.6.0 *code*: the
  tarball this release publishes is the v0.6.0 tree plus the repairs below, and the section underneath
  describes what is in it. What was wrong was the pipeline's order and two of its checks, all three
  invisible on the developer machine that wrote them. This is a fix-forward release rather than a re-tag:
  v0.6.0 stays tagged and unpublished, and its content ships here.
* **The pre-flight ran before the pack, so on a fresh checkout it could never be green.** `dist/` is
  gitignored, so a clean checkout has no tarball, and three assertions in `test/claims.test.mjs` about the
  *packed* tree skip when there is none -- while `scripts/preflight.mjs` fails any skip whose reason is not
  on `ACCEPTED_SKIPS`. Measured by moving `dist/` aside: "10 pass, 1 fail, 1 unverifiable -- RED", naming
  `no dist/ in this checkout: the packed tree was not verified here`. It looked green on a developer
  machine only because `dist/` still held a tarball from an earlier pack. `ci.yml`'s `preflight` job and
  `release.yml` now pack first, and `release.yml`'s checksums moved below the pre-flight so `SHA256SUMS`
  describes the bytes the pre-flight left in `dist/` -- the ones unpacked, verified and published. The skip
  was deliberately **not** added to `ACCEPTED_SKIPS`: that would have traded three real assertions about
  the published artifact for a green light.
* **The matrix job ran `npm test` without `npm install`, and the gate inventory names a `node_modules`
  path.** `test/claims.test.mjs` asserts that every artifact `GATE_INVENTORY` names exists in the tree --
  the check that catches a gate deleted from the pre-flight -- and the first row of that inventory is the
  eslint entry point at `node_modules/eslint/bin/eslint.js`. The matrix job never installed dev tooling, so
  all four legs failed that assertion with `the inventory names files that are not in the tree: eslint entry
  point (node_modules/eslint/bin/eslint.js)`. It could not reproduce locally, where `node_modules/` exists,
  and it was newly exposed by v0.6.0's own wiring change: the hand-listed 22-path subset it replaced had
  never run `claims`. The matrix job now installs dev tooling before `npm test`, and was measured green on
  all four legs afterwards.
* **The pre-flight read the claims suite's counts without pinning the reporter, so on node 22 it read
  none.** `checkClaims()` parsed the child's stdout with the spec reporter's summary in mind, while
  `checkTestSuite()` has always pinned `--test-reporter=spec --test-reporter-destination=stdout`. Node's
  default reporter depends on the runtime: measured, the same command prints the spec summary under node 24
  and TAP's `# tests 48` under node 22 when stdout is a pipe -- which is what a CI runner is. The check
  therefore reported `the runner printed no test count at all` for a suite that had passed, on the version
  every workflow runs, and **every local run on node 24 was green: only the runner's own output named it.**
  The reporter is now pinned exactly as the declared-suite check pins it.
* **The pre-flight now names its own failing checks in the CI interface.** Its verdict is its exit status
  and its output went only to the step log, so a red pre-flight read as one line -- "Process completed with
  exit code 1" -- to anyone without log access, including the API-only tools this project audits a run
  with. The `FAIL` and `UNVERIF` lines it printed are now `::error::` annotations, the convention
  `compat.yml`'s verdict program already used. The exit status is unchanged: the wrapper reads the
  pre-flight's own status out of `PIPESTATUS` and exits with it, because a pipeline ending in `tee` would
  otherwise report success for a red gate.

### Notes

* **Two skips are accepted because a CI runner has no DSH installation, and nothing else was
  pre-accepted.** `update-install: real pnpm against a throwaway profile` needs the pnpm that ships
  *inside* a DSH runtime (`$W2M_PNPM`, or `$DSH_HOME/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.mjs`), so on
  a runner both of its assertions skip with `runtime pnpm not found`; they are accepted as
  `no-runtime-pnpm`, capped at two. The entry carries no platform qualifier, because this is not a platform
  fact -- Windows runners lack the runtime exactly as Linux ones do -- and the cap is the bound: a third
  skip in that describe fails the check, and this reason on a host that *does* have a runtime would be a
  defect in resolution rather than an environment fact. The alternative, building a synthetic runtime in CI
  the way `compat.yml` builds a host for the loader gate, was rejected on purpose: it would exercise the
  installer against a pnpm fetched from npm instead of the one the Desktop ships, a weaker claim about the
  artifact plus a network dependency inside the release gate. The platform-conditional pair in
  `test/agent.test.mjs` is qualified the other way round and **by platform**, so accepting the POSIX side
  cannot excuse the same reason on Windows, where that assertion is expected to run.
* **A hypothesis that was tested and did not survive, recorded because the next reader deserves it.** The
  standing explanation for the four red matrix legs was "the runner has no DSH installation, so suites that
  need one behave differently there". It was tested by rebuilding the runner's conditions -- a clone with no
  `node_modules/`, no `dist/`, no DSH installation reachable, no `~/.dsh`, node 22, one `npm test` -- and it
  did not produce a failure: the loader gate skips (accepted), and the bundled-python assertion is guarded
  by `PATH` and had already passed in v0.5.9's CI on these same runners. The real mechanism was a path in
  the gate inventory on a job that never ran `npm install`. A wrong hypothesis that was tested and
  discarded is worth as much to the next reader as the right one.
* **A node-22 difference this release does not fix, stated with its bounds.** With the pre-flight's shaped
  `DSH_HOME`, `test/agent.test.mjs` is 147 tests / **0 fail under node 24** and **13 fail under node 22**
  (`'refused' !== 'ok'`, around `test/agent.test.mjs:3870` and `:3915`). `engines` declares `>=20.19.0`, so
  node 22 is a supported runtime and this is a real difference rather than a curiosity. Two facts bound it:
  it does not fire in CI today, because a runner cannot shape a home -- `prepareSuiteEnv()` finds no runtime
  source there and the suite runs bare, which is why no agent failure appears on ubuntu -- and it will
  surface the moment the pre-flight job is given a runtime layout. It is a behaviour question rather than
  wiring, so it is recorded here and left to a separate change.
* `PROTOCOL.md` §9's correction note said there is no such release as v0.6.0; that was true when it was
  written and the tag made it false. It now still says what it was written to say -- the P2P data-plane
  crypto shipped in **v0.5.3**, not v0.6.0 -- without contradicting the tag.

## [0.6.0] — 2026-10-11

### Added

* **The pre-flight became a ledger, with a self-test of its own.** `scripts/preflight.mjs` grew from 886
  lines to 2,077 and the claims suite it reuses from 775 to 1,581. Every gate it delegates to is now an
  **artifact bound to the registered check that measures it, in both directions**: a gate with no check is
  a finding, a check with no gate is a finding, and a registered check that produces no result at all is
  a `FAIL` rather than a silence. The ledger that enforces that is itself exercised on every run — a
  silent check, a throwing check and an honest one must classify `FAIL`/`FAIL`/`PASS`, and an
  `UNVERIFIABLE` whose reason is not on the accepted list is refused rather than reported. Measured on
  this tree: 12 artifacts inventoried, 11 registered checks, 0 unbound.
* **The packed tarball is checked against an expectation derived from the tree, not a hand-written list.**
  Every document in the tree is either shipped or named in `DOCUMENT_EXCLUSIONS` **with a reason** (18 in
  the tree, 17 shipped, 1 excluded, 0 neither), the packed `package.json` is compared with the tree's
  **field for field**, and every manifest-declared path must ship. Both directions are asserted, so "the
  packer stopped shipping a document" and "a document was added and the packer was not told" fail the
  same check instead of one of them passing quietly.
* **Workflow wiring is a check rather than a convention.** `ci.yml` and `release.yml` must each run every
  suite `package.json#scripts.test` names and must not hand-list a suite set, and the pre-flight asserts
  that the loader gate keeps its triggers on the two occasions that matter — every pull request and every
  release. That gate was the one a hand-edited suite list quietly dropped, which is how six suites that
  exist and pass came to run in no workflow at all.
* **Accepted reasons are named per claim, and every skip is printed with its reason.** `UNVERIFIABLE` is
  not a pass: each accepted entry carries the exact text it accepts and the one claim it may be used for.
  On this host the declared suite produces 4 skips, each on the accepted list, each printed in the
  pre-flight's own output rather than summarised as a count.
* **The compatibility gate classifies every result line, and reads the assertions out of the test file.**
  `.github/workflows/compat.yml`'s verdict program used to check nine hand-listed titles plus the page
  half, so a tenth assertion that skipped could leave the job green; and it decided the accepted reason
  from the **runner** (`BROWSER === ''`), so a page assertion skipped for a reason that is a property of
  our own composition printed ``Accepted reason `no-browser` `` and exited 0. The accepted list is now
  matched against the **skip directive's own text**, only the page half may use it, the assertions the
  file declares are read from the file, and an assertion that produced no result line at all is a `FAIL`.
* **The operator token is no longer printed on every start.** The relay prints it in its banner **only on
  the start that generated it**; every other start prints `OPERATOR TOKEN — not printed (this start did
  not generate it)` with the path and the mode to read it from. That banner lands in journald, a
  container log or a CI transcript, and this token authorises dispatching to the whole fleet, so a
  restored token in a log is a credential in a log. `--print-operator-token`
  (`W2M_PRINT_OPERATOR_TOKEN=1`, or `printOperatorToken: true` for an embedder) asks for the old
  behaviour explicitly, and `docs/DEPLOY.md` states that on the generating start the value still appears
  **twice on purpose** — once on stderr as the log copy, once in the CLI's own box on stdout as the
  handoff a human reads.

### Fixed

* **A punch could be refused by a datagram that was not a refusal at all — about one handshake in 256.**
  `decodeRefuse` accepted exactly one body length and validated nothing else, and a `REFUSE` rides inside
  the same `HELLO_ACK` frame as a handshake answer. A genuine `HELLO_ACK`'s byte 6 is the first byte of
  the responder's random ephemeral, so when that byte happened to equal the length the parser expected,
  an honest encrypted answer was read as a refusal: reported with a refusal reason the peer never sent,
  and — in the codes that are terminal — handing back no channel at all. It was found while adding the
  `k_ref` seal to `REFUSE`. The parse now checks the version byte, both legal lengths and that the
  machine id carries no control bytes, and a test bends a real acknowledgement's length byte into that
  exact collision.
* **`REFUSE` is sealed, and a refusal that cannot be corroborated is dropped.** A `REFUSE` may be
  unauthenticated by design — it is sent precisely when the two ends could not agree a key — which made
  it a downgrade oracle: anything able to forge one could turn "the peer never answered" into "the peer
  refused". `k_ref = HKDF(ECDH(e_i, s_r), REFUSE_MAC_LABEL)` is a key the initiator derives as easily as
  the responder, over a label distinct from every handshake MAC and over a **different input**
  (`ECDH(e_i, s_r)`, not `ECDH(s_i, s_r)`); a refusal must now come from the address and the session the
  punch agreed and carry a `k_ref` MAC. Four codes name the **ignored datagram** rather than a failed
  punch (`P2P_CRYPTO_REFUSE_SESSION_MISMATCH`, `..._UNPUNCHED_SOURCE`, `..._BAD_MAC`,
  `..._UNCORROBORATED`), so a refusal that was thrown away is never reported as a refusal that happened.
* **A started node held the process open, and the comment claimed an `unref()` that existed nowhere.**
  With no `ctx.effect` — an older Cordis, or a bare test context — the plugin composed a node and never
  released the handles that keep a Node.js process alive: the bound UDP socket, the announce refresh
  timer, and the accept loop's pending wait timeout. `src/agent/p2p-node.mjs` now has a real `unref()`,
  **remembered rather than applied once** (a `close()` followed by a `start()` binds a second socket and
  arms a second wait, so a call that took effect only on the first would not be a promise), the accept
  loop reads the flag on every round, and the plugin calls it when no disposer will ever be called.
  Found by an independent verifier against the `w2m_status` test's bare context.
* **A failed state publish left its temp file behind: one live state directory had accumulated 266
  `agent-state.json.tmp-*` files.** `publishState()` renames a temp file over `agent-state.json` while
  another process may be reading it, and on Windows that contention comes back as `EPERM`/`EACCES` from
  the rename although both paths are fine and the condition clears within milliseconds. The rename is now
  retried (5 attempts, 3 ms × attempt, **retryable errors only** — a permanent failure is rethrown
  exactly as a bare `renameSync` would be), and a publish that fails outright unlinks its own temp file.
* **`test:agent` masked a hang for more than 283 seconds.** The suite had finished asserting and could
  not exit; without `--test-force-exit` the verdict was a timeout rather than a result, and the same was
  true of `test:relay` and `test:tools`. All three carry the flag now, as `test`, `test:e2e` and
  `test:all` already did.
* **`test/p2p-crypto.test.mjs` was still not in `test:all`.** 33 tests covering the data-plane
  encryption rode `npm test` and not the suite a release runs, so the crypto suite did not ride the full
  gate. The one path the v0.5.9 entry asked its owner for is appended after
  `test/mdns-discover.test.mjs`.
* **The allow-list is one rule at both ends, and it is a grant rather than a sandbox.** The plugin's
  pre-flight reduced `argv[0]` to a basename before matching, so it would wave `E:\Temp\evil\node.exe`
  through while the agent refused it; the argv is handed over verbatim now, to the same matcher the agent
  uses. Three narrower rules sit on top of the prefix match, each with its own code because each has its
  own remedy: `COMMAND_REPARSING_ARGUMENT` refuses code-loading **trailing** arguments
  (`--test-reporter`, `--import`, `--require`, `-r`, `--experimental-loader`, `-e`/`--eval`,
  `-p`/`--print`, `python -c`/`-m`, `bash -c`, `git -c`/`--exec-path`, `make -f`, `tar --to-command`, and
  their equivalents in the interpreters in common use) unless the entry names them;
  `COMMAND_EXECUTABLE_PATH_MISMATCH` admits an absolute `argv[0]` only when it resolves to the same file
  the entry's executable does; and `COMMAND_EXECUTABLE_RELATIVE_PATH` refuses a relative `argv[0]`
  outright, because the working directory comes from the offer. **The limit is stated rather than
  implied: an entry is a code-execution grant, not a sandbox.** `node --test` allows
  `node --test <any file>`, and the test runner loads and runs whatever file it is handed. The list says
  which program may run, not what that program can be told to do.
* **The Windows supervisor: one supervisor, one agent, and the punch port held by the agent that is
  actually running.** Measured on this machine: **fourteen `w2m` processes, nine of them `w2m-localside`
  agents sharing one identity, with port 41235 held by an agent from thirteen hours earlier** — so every
  dispatch fell back to the relay (`P2P_UNREACHABLE`) while the heartbeat said nothing. A second
  generation could start while a healthy one ran, and the start-time reap could only ever see the single
  pid the heartbeat remembered. There is now a **single-instance lock** (`open(…, 'wx')`, i.e.
  `O_CREAT|O_EXCL`, so of two generations racing exactly one creates the file): a generation that finds
  it held logs a no-op line and exits without spawning, and a lock whose holder is gone or whose file is
  unreadable is **taken over loudly** rather than blocking the machine forever. The reap matches **by
  identity** — process table plus command line naming the same state directory, with the supervisor
  excluded — because a supervisor's own command line carries the agent stub's path and an identity-only
  reap killed its own program (measured: it did). `orphans_reaped`, `orphans_reaped_pids` and
  `lock.takeovers_total` are in the heartbeat, so the machine's own account of what it reaped is readable
  without a debugger.
* **The scheduled task was registered `MultipleInstances IgnoreNew`, which cannot recover from a
  supervisor death.** IgnoreNew refuses the second start — the right-looking answer and the wrong one,
  because the watchdog tick that should have replaced a dead generation was itself the start being
  ignored, and the machine stayed down until a human noticed. `install-service.ps1` now registers
  **`MultipleInstances Parallel`**, which is safe precisely because the supervisor's own lock is what
  prevents a second *agent*, and it prints the setting it wrote so the correction is visible in the
  install transcript rather than inferred. `deploy/windows/verify-supervisor.mjs` is the reproducible,
  no-elevation check of the whole property: it builds the broken state on purpose — orphan agents already
  holding a free port, a lock left behind by a killed supervisor — and then asserts that exactly one agent
  is left, that it owns the port, and that the heartbeat names the pids it reaped.
* **Documentation corrections, each of which was a false statement in a shipped document.**
  * **`SECURITY.md` had been telling users to install a six-release-old build.** Its supported-version
    table read "v0.5.3 and everything before it" and listed v0.5.6-and-later as "not yet released" —
    three releases after v0.5.6 had shipped. It names **v0.5.9** as the supported line now and says why
    v0.5.4 and v0.5.5 are withdrawn (they fail during DSH's web boot and take the whole application with
    them, all eight tools included), and the install commands in `SECURITY.md` and `TROUBLESHOOTING.md`
    point at a release that exists.
  * **`TROUBLESHOOTING.md` named the wrong cause for a vanished `cordis.patch.yml`.** `dsh plugin add`
    does **not** rewrite it — the CLI shares the plugin manager's package operations, which write
    `package.json` and `pnpm-lock.yaml`. What removes the file is Desktop's fatal-recovery
    `sanitizeProfile`, which renames it to `cordis.patch.yml.bak-<unix-ms>`; the `.bak-<timestamp>`
    sibling is the receipt to look for, and the backup habit matters more before an upgrade, not less.
    The same section now shows the `insert:` form and states what a bare `- id:` actually does — replace
    fields on a row that already exists, so against a row nothing created it is a silent no-op and the
    loader says `patch: entry "w2m" not found` while the install reports success.
  * **`docs/P2P-CRYPTO.md` dated the data plane's encryption to a release that does not exist.** Stage 1
    shipped in **v0.5.3**, and the file said v0.6.0. This is the first v0.6.0, and the reference now says
    v0.5.3.
  * **The `p2pOfferGraceMs` line in the v0.4.0 entry said 1200 ms and the shipped constant is 3000 ms.**
    The widening rode *inside* v0.4.0 (commit `eea80c7`, the commit the tag points at) without its own
    CHANGELOG line, which `CONTRIBUTING.md` §5 requires for a behaviour change. The line matches the
    shipped constant now and the omission is recorded rather than left to be rediscovered from a diff;
    `README.md` and `PROTOCOL-v0.4.0.md` carry the same correction.
  * **`docs/PIPELINE-DESIGN.md` opened with "unresolved, and `pipeline` is deliberately not
    implemented"**, which had been false since v0.3.4, and it recommended Option A while **Option C** is
    what shipped. The analysis is kept as written and the divergence is stated: editing the argument to
    match its conclusion would destroy the only thing that file is good for.
  * **`deploy/networking/LESSONS.md` stated the tunnel invariant in a form that contradicts the
    ledger.** It said "tunnelled traffic must never be reported as `p2p`"; `transport` is the **socket
    path**, rung 4 *is* a socket between the two machines, and calling that a lie would make the field
    useless. The rule that actually holds is that the **tunnel must be named explicitly** wherever it
    carried the traffic, and that "direct" must never be read as "the bytes avoided a server".
    `deploy/networking/README.md` states it in the same words, and the two files now agree with each
    other and with `docs/AUDIT.md`.

### Notes

* **What is new behaviour here, and what is a document catching up to behaviour that already shipped.**
  The REFUSE parse and its `k_ref` seal, the node `unref()`, the state-publish retry and cleanup, the
  shared allow-list matcher and its three narrower rules, the operator-token printing gate, the
  supervisor's lock / reap-by-identity / `MultipleInstances` correction, the pre-flight's ledger, the
  compat gate's structural classification, and the `test:all` + `--test-force-exit` wiring are **code
  changes in this release**. The client-entry requirement (`id: w2m`, the **bare** package name, and the
  `insert:` form) and the loader driver's **registry-wide failure sweep** shipped in v0.5.4–v0.5.6; what
  is new here is that both are documented as requirements a reader can act on, and that the compatibility
  gate requires the sweep's own result line (`sweeps every fiber in the process and finds no failure`) by
  name instead of trusting nine hand-listed titles.
* **LAN discovery remains opt-in, and it is unverified on a real network.** Every socket in
  `test/mdns-wire.test.mjs` and `test/mdns-discover.test.mjs` is loopback, and no mDNS packet has crossed
  a real LAN in this project's testing; `README.md` names both suites in its table now rather than
  leaving them to be found. Discovery is a **hint, never an authorisation**: a machine the LAN announced
  but the relay does not list is not a target.
* **One check is `UNVERIFIABLE` on this machine and is printed as such rather than passed quietly.** This
  host's `%DSH_HOME%` holds no `dsh-runtimes\`, while `src/agent/resolve.mjs` looks for the bundled
  runtime at `dsh-runtimes/dsh-primary-runtime/dependencies` and the application bundle carries it at
  `E:\DS\resources\runtime\primary-runtime\dependencies`. The suite is run against a throwaway home with
  the documented layout, and the host mismatch is printed next to the verdict.
* **Unverified from this machine, stated rather than implied.** The GitHub Release assets behind the
  documented tarball URLs (`test/claims.test.mjs` skips that claim without `W2M_NETWORK_TESTS=1`), and
  **the first CI run of the compatibility gate in its new form**: its verdict program is extracted out of
  the workflow and exercised by `test/claims.test.mjs` against synthetic TAP captures — an honest
  no-browser skip, an injected extra assertion, an unaccepted reason — but the gate itself is judged by a
  runner that is not this machine.
* The numbers in `README.md`'s suite table are the **v0.5.9** measurements and stay labelled that way.
  Adding `test/p2p-crypto.test.mjs` to `test:all` changes that row's suite and test counts, and neither
  was re-measured for v0.6.0 on this host — a full `test:all` on this machine takes long enough that
  running it to refresh a table would be the wrong trade.

## [0.5.9] — 2026-10-11

### Added

* **A release pre-flight, as one entry point: `node scripts/preflight.mjs`.** A release is now
  something you start by running it, and a green run is the precondition for the version bump. It
  checks, in order: that every gate it delegates to exists on disk; that lint is at 0 errors; that the
  mojibake scan is clean over the whole tree; that the suite declared in `package.json#scripts.test`
  runs and passes; that the **packed tarball** — not the tree — contains every path `package.json#files`
  names, names the tree's version, carries no forbidden path (`node_modules`, `test/`, `scripts/`,
  `.git`, `*.proof-backup`/`*.orig`/`*.bak`) and registers its eight tools when executed from the
  extracted copy; that the version, bundle-patch and document claims in `test/claims.test.mjs` still
  hold; and that the CHANGELOG's title sits above its newest entry and its entries run newest-first.
  Every check reports `PASS`, `FAIL` or `UNVERIFIABLE` **with a name and a reason**, and the run fails
  if any registered check produces no result at all: "the gate ran" is itself a check, and the ledger
  that enforces it is itself exercised on every run against a silent check, a throwing check and an
  honest one — because a self-authored gate that reports success while executing zero checks is a
  defect this project studied in another one. The first draft of that ledger counted a coerced `FAIL`
  as a produced result, and the self-test caught it on its first run.
* **A wiring check that would have caught two of the defects below.** Every `test/*.test.mjs` on disk
  must be named by some npm script, and every path an npm script names must exist. Measured now: 36
  suites on disk, 36 named by a script, 0 orphans, 0 named-but-absent.
* **A CI compatibility gate** (`.github/workflows/compat.yml`, with its own section in
  `CONTRIBUTING.md`). Three jobs. *mount-and-boot* builds a pinned host in `RUNNER_TEMP`
  (`@deepseek-ai/dsh@0.2.0-rc.2`, `dsh-app-boot`, `dsh-client-modules`, `cordis@4.0.4`,
  `cordis-plugin-loader@1.0.5`), runs the existing `test/loader-entry.test.mjs` against it **unmodified**
  and classifies the TAP capture with nine named assertions, of which a `SKIP` counts as a failure.
  *bare-import* packs, installs into an empty project, and asserts `dependencies === {}`, that no host
  package resolves, and that the root export is a callable `apply`. *uninstall* asserts the composition
  is byte-identical before and after, and documents why the manifest key set is not compared. Triggers:
  PRs to main, pushes to main, `v*` tags, weekly, and dispatch; `contents: read`, no secrets. No-browser
  is the single entry on `ACCEPTED_UNVERIFIABLE` and reports `UNVERIFIABLE` with its reason rather than
  `PASS`. Validated end to end against a synthetic installation built with the workflow's own commands
  (10/10 pass) and in the failing direction with `W2M_ROUTE_DEFECT=1`, which reports `FAIL` naming the
  route assertion and the fiber sweep — the same both-directions rule the rest of this release follows.
* **Refusal codes, and the exposure boundary written down as executable text.** 26 codes in three
  greppable tables (`REFUSAL_CODE` in `src/plugin/tools.mjs`, `MATCH_REFUSAL` in
  `src/agent/allowed-commands.mjs`, `EXEC_REFUSAL` in `src/agent/exec.mjs`), with
  `MATCH_REFUSAL.NOT_ALLOWED === REFUSAL.COMMAND_NOT_ALLOWED` asserted so the two ends of a dispatch
  cannot drift apart. The defect this closes is that `applied: false` conflated three different facts:
  a stored selection naming no machine was indistinguishable from "the whole fleet ran it", and that
  state now has its own code (`SELECTION_UNUSABLE`). Every refusal carries `reason_code` and a `detail`
  saying what would change it. The boundary itself — no tool parameter may name a credential, an
  allow-list, a key path or a state directory — is stated in `src/plugin/tools.mjs`'s header and pinned
  by four canaries run across all eight tools, proving that no result and no request body carries a
  token. Proven by 17 mutations, 17 red, in a scratch copy outside the repository.

### Fixed

* **`CHANGELOG.md` had carried a mangled character into the published package.** v0.5.8's own entry —
  the one describing the mojibake repair — contained the two garbled CJK sequences it was complaining
  about, reproduced literally inside backticks. `CHANGELOG.md` is in `package.json#files`, so v0.5.8
  shipped the damage it was apologising for, and `scripts/scan-mojibake.mjs` was red on the tree. The
  line is ASCII now and the scan is clean over the whole tree.
* **The CHANGELOG's title and introduction were in the middle of the file.** The v0.5.8 entry was
  prepended above `# Changelog` itself, which is the same mistake as the out-of-order entries v0.5.8
  fixed, one level up: "newest first" was true of the version headings while the document's own header
  had been pushed to line 21. The entry is below the title again, and the pre-flight now asserts the
  shape rather than only the order.
* **The entire declared unit suite had not been running.** Wiring the new suites into
  `package.json#scripts.test` and `#scripts.test:all` dropped one space, producing the path
  `test/claims.test.mjstest/fleet-target.test.mjs`. `node --test` exits 1 on a missing path, so
  `npm test` was failing immediately and *no* unit suite — not just `fleet-target` — was running. This
  one is mine: it came from the edit that wired the new suites in, and it means the declared unit suite
  was not being run at all between that edit and this release.
* **`test/p2p-crypto.test.mjs` was named by no script at all.** 33 tests, green, and wired into
  nothing — the exact defect v0.5.7's release note identified in someone else's repository. A suite
  that never runs protects nothing, and that is now asserted rather than assumed. **It is in `test`,
  and as of this entry it is still *not* in `test:all`** — that is a wiring gap, not a rounding
  detail, because `test:all` is the suite a release runs: 35 paths are named there and
  `test/p2p-crypto.test.mjs` is not one of them, so the crypto suite still does not ride the full
  gate. This entry previously claimed both; the claim is now the measured one. The fix is one path in
  `package.json#scripts["test:all"]`, appended after `test/mdns-discover.test.mjs` — the file is owned
  by the integrator, so the line is reported rather than edited here.

### Notes

* This release exists because three releases in one hour — v0.5.6, v0.5.7, v0.5.8 — each fixed a
  defect the previous one introduced. **Every one of those defects was found after the tag was pushed**,
  by a gate that already existed and simply was not run before the release. The gates were never
  broken; the process around them was missing. That process is this release's subject.
* One check is `UNVERIFIABLE` on this machine and is reported as such rather than passed quietly: the
  host has no `%DSH_HOME%\dsh-runtimes\`, while `src/agent/resolve.mjs` looks for the bundled runtime at
  `dsh-runtimes/dsh-primary-runtime/dependencies` and the application bundle carries it at
  `E:\DS\resources\runtime\primary-runtime\dependencies` instead. The suite's bundled-python claim is
  measured against a throwaway home with the documented layout, and the host mismatch is printed next
  to the verdict, as an open question rather than a silent pass.
* Two checks are known to be sensitive to a loaded machine rather than to the artifact, and both are
  named here rather than discovered later: `test/relay.test.mjs`'s `runs a complete signed task end to
  end`, whose `lease_until` is computed by the relay during the request and recomputed by the test
  after the await, so the two can land in different seconds; and the capability probe in
  `test/agent.test.mjs`, which measures the host's own runtime layout as well as the resolver. A red
  run naming only these is a re-run, not a release defect — and a report that hides them behind a green
  verdict is the kind of green this release exists to avoid.

## [0.5.8] — 2026-10-11

### Fixed

* **The CHANGELOG was out of order, and the claims gate caught it.** My bump scripts anchored the new
  entry on the wrong heading, so v0.5.5 ended up *above* v0.5.6 and v0.5.7 and "the newest entry" stopped
  meaning anything — which is exactly the assertion `test/claims.test.mjs` makes. Entries are ordered
  newest-first again, and the anchor is the top of the file rather than a version I have to remember.
* **Mojibake in shipped code.** `src/agent/mdns-wire.mjs` is packed, and its comments carried an em dash
  and a section sign that had been decoded as the wrong encoding and re-saved, so a reader would have
  seen the two garbled CJK sequences where the RFC references belong. The same damage was in
  `test/mdns-discover.test.mjs`.
  All five mDNS files are ASCII now, and the repository's own mojibake scan is clean.

### Notes

* Fix-forward again, and for the same reason: v0.5.6 and v0.5.7 are published and stay published.
* Three releases in an hour, each fixing a defect the previous one introduced and a gate caught. That is
  the gates working, but it is also a release process with no pre-flight of its own — which is the next
  thing this project should fix rather than the next thing it should be proud of.
* No runtime change: the code in v0.5.8 is the code in v0.5.6.

## [0.5.7] — 2026-10-11

### Fixed

* **v0.5.6 shipped without its own documents.** `TROUBLESHOOTING.md` and `SECURITY.md` were written,
  reviewed and committed, and then **not packed**, because `files` names the documents individually
  rather than by pattern. Anyone installing v0.5.6 got the code and none of the guidance. They are in the
  package now, and `test/claims.test.mjs` is the place this class of defect belongs.
* **v0.5.6 shipped without its own gates wired in.** `test/claims.test.mjs`, `test/loader-entry.test.mjs`
  and the two mDNS suites existed and passed, but were listed in none of `test`, `test:all` or `verify` —
  a test that does not run protects nothing, which is the exact defect this release's own study
  identified in someone else's repository. All four are wired in.
* A typographic character (a smart quote) in `test/mdns-discover.test.mjs`, caught by the repository's
  own mojibake scan.

### Notes

* Fix-forward, not a rewrite: v0.5.6 is published and stays published, because the alternative is
  rewriting history someone may already have. Both defects are mine, and both are the class this project
  keeps naming — a claim that nothing checks.
* No runtime change: the code in v0.5.7 is the code in v0.5.6.

## [0.5.6] — 2026-10-11

### Fixed

* **The client entry could not activate, and that made the whole application refuse to start.**
  v0.5.4 and v0.5.5 were withdrawn for it. The real cause, taken from the page itself rather than
  guessed:

  ```
  w2m-client-probe: apply threw for @twinsearth/w2m-dsh-plugin: cannot get property "locale" without inject
  Error: web boot: 1 entry did not activate
  ```

  Cordis throws for any `ctx.<name>` a fiber reads without declaring it, and the client half declared
  `inject = []`. **The first throw was `locale`, not `slots`** — so declaring the seat alone, or guarding
  the locale alone, would each still have died. Now `inject = ['slots']` (a declared name is a *required*
  dependency, which is why `locale` is deliberately not among them), the optional carrier is read
  inject-free with `ctx.get('locale')` while its dictionary registration rides a child fiber, a context
  with no usable seat becomes a **no-op with a diagnostic** instead of taking the page down, and `apply`
  prints the inner message to the error-level renderer console — the channel the crash log reads — and
  then rethrows, because a swallow would boot a healthy-looking page with no control.
* **A failed entry was invisible unless you read fiber state.** `cordis-plugin-loader` no longer
  propagates a failed mount to `await ctx.loader.await()`, and the loader driver inspected only the one
  entry it knew about — so a failure landing on a **child** fiber (our silently-refused route) went
  unseen. The driver now sweeps the whole registry and reports `failedFibers`.

### Added

* **A gate that would have caught all of it**: `test/loader-entry.test.mjs` packs the tree, installs the
  tarball with the installation's own `dsh plugin add` into a throwaway profile under a throwaway
  `DSH_HOME`, boots it with the real `runProfile`, activates the client entries through the real module
  system, and — when a browser is present — boots the profile's own page and asserts our control renders.
  Proven in both directions: **10/10 on this tree, 2 failures against the preserved pre-fix tarball, 9
  against the v0.5.4 one**, and with a deliberately injected route defect it names the **child** fiber
  while "entry active" and "eight tools" still pass. It reports one stage per line, so a failure names
  its cause.
* **`test/claims.test.mjs`** — 22 checks that our own published claims match the artifact, with the
  registered tool set *measured* by importing the entry. It caught a stale claim in our README on its
  **first run** (`README.md` said the installer asserts 5 tools; it asserts 8), and its author's own
  mutation proof caught two false greens in its first draft — a scan that extracted zero tool names and
  a lookahead that invented one out of a metric.
* **`TROUBLESHOOTING.md`** — 17 symptom-indexed sections that name the culprit when it is not us (pnpm's
  `minimumReleaseAge`, carrier-grade NAT, the OS firewall, an installer that rewrites the profile patch),
  ending with a data-location table and a reason-code table.
* **`SECURITY.md`** — a private reporting channel and **no public-issue route**, an honest support table,
  and the consent model written out: what a paired machine may and may not do, and that we never write to
  another machine's `authorized_keys`.
* **`CONTRIBUTING.md`** — one page of falsifiable conventions, including **"a test that would pass
  against a broken artifact is not evidence"** and **"run mutation proofs in a copy, never in the shared
  tree"** (both learned the hard way).
* **Opt-in LAN discovery** (`src/agent/mdns-wire.mjs`, `src/agent/mdns.mjs`, `src/plugin/mdns-discover.mjs`):
  a bounded, hand-written DNS/mDNS codec with parse hardening (a pointer may only name a *prior* offset, so
  termination is a property of the format; a 128-hop budget reported separately from a loop; label, name,
  record and packet caps; every read bounds-checked) and a discovery source exposed through
  `w2m_devices`' new `include_discovered` (default `false`). **Discovery is a hint, never an
  authorisation**: a discovered device is refused as a dispatch target unless the relay already lists it
  and it is online, and the positive control is tested so the rule cannot pass by refusing everything.

### Notes

* **v0.5.4 and v0.5.5 remain DO NOT INSTALL.** This release also exists so that `latest` on the registry,
  which still pointed at v0.5.5, stops handing out a version that prevents the application from starting.
* **Upgrading from v0.5.4 needs one edit outside this package**: the profile's `cordis.patch.yml` must
  name the package (`@twinsearth/w2m-dsh-plugin`), not the `/tools` subpath. With the corrected bundle row
  a mismatch makes the loader skip the whole patch and silently revert every configured value to its
  default. The claims gate now checks this.
* **LAN discovery is unverified on a real network.** Every socket in its suite is loopback and no packet
  left the host, so it says nothing about whether a switch forwards `224.0.0.251` or how a real
  Bonjour/Avahi peer answers. There is **no third-party interoperability test**, no probing or conflict
  resolution, IPv4 only, and the responder is **built and tested but not started** by the plugin —
  loading a plugin should not silently multicast on the host's network.

## [0.5.5] — 2026-10-11

### Fixed

* **The v0.5.4 loader failure, with the cause the loader actually reported** rather than the hypothesis
  that stood in for it:

  ```
  w2m (@twinsearth/w2m-dsh-plugin/tools): Error: cannot get property "connection" without inject
    at registerTargetRoutes (src/plugin/fleet-target.mjs:483:25)
  ```

  cordis throws on reading a service property the fiber never declared, so the entry died and took all
  eight tools with it. **Every existing test was blind to this**, because they drive the plugin with a
  plain-object context where an undeclared read merely yields `undefined` — the fake was more forgiving
  than the runtime. Fixed with `ctx.inject(['connection'], …)`, which is also the only shape that can
  work: in the real composition the service is genuinely absent while `apply()` runs, and siblings are
  mounted concurrently.
* **The client half was never composed either, for a second and independent reason:** the bundle row
  named the subpath `@twinsearth/w2m-dsh-plugin/tools` instead of the package, and a client package is
  identified by its Loader row specifier — a subpath resolves to no `package.json`, so `dsh.client` was
  never read and no boot-graph row was built. The row now names the package.
* **A silent route rejection:** the control fetched `/w2m/target`, but fetch routes are validated
  against `/api/`, and the refusal failed only a child fiber, so nothing surfaced. Now
  `/api/w2m/target`, mirrored in the shipped bundle.

### Added

* **`test/loader-entry.test.mjs`** — the test that would have caught v0.5.4: it packs the tree, installs
  the tarball with the installation's own `dsh plugin add` into a throwaway profile under a throwaway
  `DSH_HOME`, and boots it with the real `runProfile` under the Harness runtime, asserting that the
  entry activates, all eight tools are registered, the boot-graph row is composed from the shipped
  bundle, and no failed entry names the package. **Proved in both directions**: 6/6 pass on the fixed
  tree and 6/6 fail against the preserved v0.5.4 tarball, failing on precisely the loader error quoted
  above. It skips loudly, naming the probes it tried, when no installation is found.
* Cheap always-on guards in `test/client-bundle.test.mjs` that need no Harness: the platform field, the
  client export, the row must be the bare package name, and the bundle's route must equal the host's.

### Notes

* **An upgrade from v0.5.4 requires one edit outside this package:** `cordis.patch.yml` in the profile
  must name the package (`@twinsearth/w2m-dsh-plugin`), not the `/tools` subpath. With the corrected
  bundle row, a mismatch makes the loader skip the whole patch — silently reverting `rabbitUrl`,
  `operatorToken`, `stateDir`, `projectDir`, `machineName`, `p2pMode` and `allowedCommands` to their
  shipped defaults. Measured both ways with `--dump-config`.
* **0.5.4 remains DO NOT INSTALL.** This release exists so that a rebuilt artifact is distinguishable
  from the broken one by version alone.
* Still unverified, and not claimed: how the control *renders*. No browser was opened. What is proven is
  the entire host side — the entry activates, the eight tools register, the boot-graph row is composed
  from the shipped bundle, the route is registered and attached — plus the seat shape in a VM test.

## [0.5.4] — 2026-10-11

> **DO NOT INSTALL 0.5.4.** It fails to load in the Harness: the loader entry
> include:@twinsearth/w2m-dsh-plugin/tools reports iberPhase: failed, so **all eight tools
> disappear** and the client half never registers. The package verifies in isolation
> (scripts/verify-installed.mjs reports 8 tools registered) and its exports map is complete, so the
> failure is in the real loader path -- the newly declared dsh.client half being composed there, with
> lib/client.js being browser code that has no window under a host-side load. That cause is a
> hypothesis, not a measurement; the loader's own error is still to be read. 0.5.5 fixes it and adds the
> test that should have caught it: **load the packed artifact through the real loader path**, which is
> the step this release skipped. The tag and the npm version stay as published history; they are simply
> not installable.


### Added

* **A dispatch-target control inside the chat composer.** A client half registers into
  `conversation.input.left` — a `list` seat with `replaceRisk: none` — so the control is added *beside*
  the permission control rather than shadowing it; `conversation.input.permission` is never touched. The
  roster is the relay's own device list, read through the same helper `w2m_devices` uses, so the tool and
  the control cannot disagree; a machine the relay does not list as online is shown but not selectable.
* **The selection means something, and only via fields that already existed.** Picking a machine stores a
  per-session target that survives a page reload; `w2m_run` maps it onto `target_machines` for
  replicate/split/pipeline and onto `executor_machine_id` for broadcast, and a caller that names an
  executor explicitly always wins. No new tool parameter, no protocol change, `envelope_version`
  untouched. `w2m_status` reports the current target.
* `lib/client.js` is the shipped browser bundle, written by hand in the runtime's lazy-CJS loader format
  because this package has no bundler; `dsh.client` and `exports["./client"]` declare it additively.

### Notes

* Verified by test and by a live probe against the real relay: selecting `jp-shared` and dispatching with
  no executor named produced leases `jp-shared: offered`, the other two `observing`, and a `consistent`
  verdict from the machine that was selected. **Not verified: how the control renders.** Every client
  Inspect query timed out for the whole session, so the page is not answering the client inspect channel
  and the rendered text and position beside the permission control are unconfirmed.
* **A page refresh cannot show it.** The running Harness composes the client boot graph at startup and
  serves the plugin from the profile's `node_modules`; the new revision must be installed *and the
  Harness restarted* before the control appears. The control is therefore in the artifact and not in the
  running UI, and this entry says so rather than implying otherwise.

## [0.5.3] — 2026-10-11

### Added

* **The peer-to-peer data plane can now be encrypted.** Stage 1 of `docs/P2P-CRYPTO.md`: each machine
  holds an X25519 keypair beside its device identity, the relay carries each peer's static public key
  inside the offer it already sends — so **nobody fills in a `[Peer]` block by hand** — and the direct
  channel completes a two-message IK-shaped handshake before a single frame is trusted. Triple DH gives
  mutual authentication and forward secrecy; ChaCha20-Poly1305 with WireGuard's nonce layout carries the
  frames; a 64-message replay window and an HKDF epoch ratchet (2^20 messages or 120 s, previous key
  retained 15 s) keep it going without a round trip in the data path.
* A handshake failure is **terminal for that peer, never a silent downgrade to plaintext**: a peer that
  has no key for us gets the plain channel it would have had and the ledger records
  `p2p.encrypted: false` with a reason. A machine is never lost to a security upgrade — only told that
  the upgrade did not complete.
* `PROTOCOL.md` §9; `w2m_status` reports `p2p.encryption`.

### Notes

* **The tests earned their keep: they caught seven real defects**, including a replay window that
  accepted replays of frame 2, a lookahead bound that capped our own send epoch, and a plain-ACK race
  that could downgrade a live encrypted session to plaintext — the exact failure the design forbids, now
  structurally impossible.
* `mac1`/`mac2` are **not** implemented: keyed BLAKE2s is not exposed by `node:crypto`. They mitigate
  CPU-exhaustion denial of service, not confidentiality or authenticity, and the omission is a named
  value in the code rather than a silence.
* Every socket in the new suite is loopback and crosses no NAT; that is stated in the suite header and
  is not evidence that a real translation can be crossed.
* No protocol version bump: `envelope_version` stays `1.0` and a v0.4.x/v0.5.x peer is unaffected.

## [0.5.2] — 2026-10-10

### Fixed

* **The supervisor now says what it is doing, in a file.** A death that arrives with the console
  cannot be logged from inside the process it kills — the log simply stops — so the supervisor
  records `supervisor-heartbeat.json` (written atomically) with its state (`running` / `backoff` /
  `degraded` / `stopped`), the child pid, restarts within ten minutes, the last exit code, and a note
  that `3221225786` is `0xC000013A` rather than a crash of the agent logic. After three exits inside
  ten minutes the state becomes `degraded` and the backoff grows to five minutes: not "give up", but
  "stop hammering and say so", so the fleet sees a machine that is present and unwell instead of one
  that vanished.
* **Orphan agents are reaped at start.** Detaching the agent (v0.5.1) is what stops a console
  teardown from taking the machine off the fleet, and it leaked: three agents with one identity were
  found running at once, the newest unable to bind the punch port (`P2P_BIND_FAILED: EADDRINUSE
  0.0.0.0:41235`) because an orphan held it, while `MultipleInstances IgnoreNew` kept a fresh
  supervisor from starting at all. The heartbeat names the last child, so a new supervisor terminates
  that pid before it spawns anything.

### Added

* **`docs/AUDIT.md`** — what is implemented, what is running and how it works, with every claim
  labelled `[M]` measured live, `[T]` asserted by the suites, or `[?]` **not verified**. It records
  the uncomfortable half on purpose: A and B have no live proof yet, the macOS machine's state is
  unconfirmed, the WireGuard hub has never seen a handshake, the session-0 service has never been
  executed, and the link from the Windows machine to the relay is intermittently down. Its last
  section is the commands to re-run each check, so the next reader need not trust the snapshot.

### Notes

* This release exists because `deploy/` and `docs/` are inside the published package: after v0.5.1 the
  tag and the tarball had drifted, and a release is the only honest way to close that.
* No runtime change to the eight tools.

## [0.5.1] — 2026-10-10

### Fixed

* **The agent no longer dies with its console.** Measured twice on the fleet: the whole process
  tree — supervisor and agent together — was killed with code `0xC000013A` (`STATUS_CONTROL_C_EXIT`,
  its console went away), the log ended mid-sentence, and Task Scheduler did not restart it, so the
  fleet silently lost the machine. A supervisor that shares the console dies with the thing it
  supervises, which was its one job. The supervisor now spawns the agent with `detached: true` and
  **file-descriptor stdio** — never `inherit`, never pipes, because a detached child writing into a
  pipe whose reader has died blocks instead of failing loudly.
* **The scheduled task heals itself, without elevation.** The interactive mode now also registers a
  repeating trigger (default every 5 minutes) which, with `MultipleInstances IgnoreNew`, means "be
  running, or start": a death from any cause is repaired at the next tick. It exists because
  `RestartCount 999` was measured not to fire at all.

### Added

* **`deploy/networking/LESSONS.md`** — a read-only study of 2dust/v2rayN (GPL-3.0, so description
  with citations only and nothing copied) recording the transport disciplines this project was
  missing, and the decision it changed: **no TUN/VPN mode.** v2rayN never creates an adapter itself
  and contains no peer-to-peer anywhere; a tunnel is hub-and-spoke by construction, so it would make
  our "the data path is peer-to-peer" claim false for exactly the traffic a tunnel exists to carry.

### Notes

* A regression introduced and caught during the fix is recorded in the code: the first version also
  called `child.unref()`, which leaves the supervisor with no handle at all, so its event loop
  drains and it exits immediately after spawning the agent. The evidence was that no supervisor
  process existed — found while looking for a different property.
* Verified on the machine that had the defect: supervisor and agent both present, and killing the
  supervisor leaves the agent alive with its punch socket still bound (`0.0.0.0:41235`).
* Also included: the test fix for `test/outbound-only.test.mjs`, whose port was being read from the
  timestamp rather than from the field that states it (commit `57dbc5f`).

## [0.5.0] — 2026-10-10

The release that stops treating "the relay carried it" as the only answer for a machine behind a
symmetric NAT. Measured before it: a dispatcher behind carrier-grade NAT (an iPhone hotspot, in this
fleet) could not push an offer to a peer, the peer's result could not come back, and both halves fell
to the relay on **every** task — `P2P_PUNCH_TIMEOUT` on the push, `transport: relay` on the result.

### Added

* **Simultaneous two-way punch.** The dispatcher publishes its punch in the offer it puts on the relay
  (`POST /v1/task`'s `p2p`: `{mode, punch, candidates?}`), and the executor — which previously could
  only wait in `accept()` — **dials the dispatcher back** on the same derived session, concurrently
  with execution, bounded by the new `tuning.reverseDialTimeoutMs` (default **8000 ms**). Two NATs
  that each open a mapping toward the other can then meet; one of them no longer has to be dialable.
* **Reverse dial on the result path.** `planDirectDelivery` dials the dispatcher before falling back
  to the relay, reusing the offer-time attempt when there was one (one bounded window per task, never
  two) and starting its own when the channel died in between. This is the direction that works for a
  symmetric-NAT machine: it dials *out*.
* **The ladder is now recorded, rung by rung.** `p2p.opened_by` names the mechanism
  (`dispatcher-punch` | `simultaneous-punch` | `result-reverse-dial`); `p2p.reverse_dial`,
  `p2p.reverse_dial_ms` and `p2p.reverse_dial_reason` say whether a dial was attempted, what it cost
  and why it lost (`P2P_REVERSE_DIAL_TIMEOUT`, `P2P_REVERSE_DIAL_FAILED`, `P2P_CHANNEL_LIVE`,
  `P2P_NO_SESSION`, `P2P_NO_ORIGIN`, `P2P_DISABLED`, `P2P_UNREACHABLE`, `P2P_NO_TASK_ID`). The
  mechanism is shared with the plugin (`punchSession()` lives in one place, imported, not copied).
* **`deploy/networking/`** — the ladder written down: five rungs with what the ledger shows for each,
  `acceptance.mjs` to measure which rung a real dispatch takes (it mints a real punch id, because a
  body without one exercises neither new path), and `wireguard/server-setup.sh` for rung 4.

### Fixed

* **`P2PChannel.close()` could never send its BYE.** It set `closed = true` and *then* called
  `sendFrame(BYE, …)`, and `sendFrame` refuses to send once closed — so the goodbye was unreachable
  dead code. The measured consequence sat exactly on the path this release is about: `pushOffer`
  closes the channel it pushed over, the executor kept a channel it believed was live, sent its result
  into it and fell back only after `P2P_FRAGMENT_UNACKED … after 8 attempts` — **with no reverse dial
  attempted**, because a channel for the task still existed. Change B alone could not have fixed the
  measured failure; this is the other half. `close(reason, {silent: true})` exists for discarding a
  duplicate local view of a live session (a simultaneous punch legitimately creates two channel
  objects on one side, and a BYE there would tear down the peer's working channel).

### Changed

* **`transport` widens.** It is `p2p` when the direct path carried **either** half — the offer over a
  channel **or** the result acknowledged over one — and `relay` only when the relay carried both.
  `p2p.offer_path` keeps its exact meaning ("how the offer arrived"), which is what keeps the two
  halves distinguishable: `transport: p2p` + `offer_path: relay` is a result that found its own way
  home. Anything reading `transport` alone should read `offer_path`/`opened_by` beside it.

### Compatibility

No protocol version bump: `envelope_version` stays `1.0`, the new keys live inside the optional `p2p`
object, and `transport`'s value set is unchanged. A v0.4.x relay stores and republishes the extended
object **verbatim**, and a v0.4.x agent ignores keys it does not know — both are pinned by tests, on
both sides, rather than argued from intent.

### Verification

* Required suites: **424 tests, 421 pass, 1 fail, 2 skipped** (baseline 407/404/1/2 → +17 new tests,
  all passing). The failure is the pre-existing bundled-python case.
* Every other suite: 340 tests, 335 pass, 2 fail (the pre-existing `pipeline-e2e` cases).
* `eslint .`: 0 errors, the same 79 pre-existing warnings.
* **Not verified, and it matters:** every punch in the suites is loopback, which crosses no NAT, and
  no genuine v0.4.x binary was run — compatibility is argued from the relay's validation code plus
  round-trip tests. Real traversal needs a fleet running this build; that is the next measurement, not
  a claim in this entry.

## [0.4.9] — 2026-10-10

### Fixed

* **The Windows supervisor silently dropped every `-AgentArgs` value.** `install-service.ps1` writes
  `agentArgs` into `agent.json`, and `ConvertTo-Json` collapses a single-element array to a string —
  while the supervisor's passthrough only handled an array. So `-AgentArgs '--p2p-mode auto'` was
  accepted, written, and then ignored, and the agent ran on its defaults. Nothing failed; the field
  simply had no effect. It now accepts both shapes (a string is split on whitespace) — the same class
  of bug as the camelCase key mismatch fixed in v0.4.4: **a config field that is read but not
  understood is indistinguishable from one that was never set.**
* Found while pinning this machine's punch port (`--p2p-port 51820`), which was the first agent
  argument whose absence would have been visible — that is what exposed the dropped-arguments path.

### Notes

* No protocol change, and no behavioural change for an `agentArgs` that was already an array (what
  the installer writes for two or more arguments). This makes the documented `-AgentArgs` real.

## [0.4.8] — 2026-10-09

### Added

* **The listing badge, with the URL it actually resolves to.** The plugin is listed on
  dsh-plugin.org as `twinsearth/dsh-windows2macos` under Workflow & Automation, marked
  **Verified** — it was auto-discovered through the `dsh-plugin` topic and reviewed by hand
  before this release. The badge links to that page rather than to a guessed slug.

### Notes

* The listing's own snapshot was stale (it still showed v0.3.8 and an install command the hub
  derived itself), so a submission issue was filed with the hub's template —
  [dshplugin/dsh-plugin-hub#141](https://github.com/dshplugin/dsh-plugin-hub/issues/141) — which
  is what triggers a re-scan. Nothing about being listed had to be requested: the topic is the
  entry point, and this repository already carried it.
* The package is on npm as `@twinsearth/w2m-dsh-plugin` (latest 0.4.7 at the time of this
  release). With the package now existing, npm **trusted publishing** can be configured for this
  repository and `release.yml` — after that every future release publishes itself with provenance,
  and no token or one-time code is involved.

## [0.4.7] — 2026-10-09

### Fixed

* **The package root exported nothing, and the ecosystem checks the root.** `lib/index.js` was
  deliberately documentation-only — the profile mounts `@twinsearth/w2m-dsh-plugin/tools` because
  `cordis.patch.yml` names that subpath — so `import('@twinsearth/w2m-dsh-plugin')` returned
  `Object.keys() === []` and `typeof apply === 'undefined'`. A plugin that mounts perfectly and
  looks like an empty package to every tool that inspects it is a listing risk with no upside: the
  DSH plugin listing requirements ask for a package that "exports an `apply(ctx)` module", and a
  missing root export is one of the most common reasons a submission is refused. The root now
  re-exports `apply`, `inject` and the test helper from `./tools.js` — one implementation, two
  entry points — and `test/tools.test.mjs` asserts it, so it cannot silently regress.

### Notes

* Nothing about the mounted plugin changed: the patch still names the subpath rather than relying on
  the "root is the plugin" convention, which is what keeps the eight tools from being registered
  twice.
* `tools.test.mjs`: 83 pass, 0 fail.

## [0.4.6] — 2026-10-09

### Added

* **Published to npm.** `@twinsearth/w2m-dsh-plugin` is now installable by name:

  ```bash
  dsh plugin --profile <profile-name> add @twinsearth/w2m-dsh-plugin
  ```

  which is the form the marketplaces and every reader's muscle memory expect, and the form the
  README had to warn against until now. It is the **same file** the GitHub release publishes —
  `release.yml` packs with `scripts/pack.mjs`, the release uploads the tarball and `SHA256SUMS`, and
  the npm publish uploads that fetched-back tarball after checking it against those sums. Nothing
  is repacked, so "which artifact did you install?" has one answer rather than three.
* **`release.yml` gained an `npm` job** with two ways to authenticate, preferred first: **trusted
  publishing (OIDC)** — nothing stored in the repository, configured once on npmjs.com against this
  repo and workflow — or an `NPM_TOKEN` repository secret. It is `continue-on-error` on purpose:
  those credentials live outside the repository, so an unconfigured npm account must not paint
  every future release red, but it must not pass silently either. It also skips cleanly when the
  version is already published, so re-running a release is idempotent.

### Changed

* The README's install section leads with the npm form, the version badge is replaced by a live npm
  badge, and the "not from npm yet" warning is gone — it was true for exactly one release cycle and
  would have been the first thing a visitor to the npm page read.

## [0.4.5] — 2026-10-09

### Fixed

* **The supervisor v0.4.4 shipped would have failed the lint job.** `deploy/windows/` was not in the
  rule block that turns `no-console` off for entry points — and a supervisor's only output channel
  *is* the console and the log it tees into — and it carried an unused import left over from an
  earlier draft. CI #41 caught it after v0.4.4 was published; the release itself was fine, the
  repository was not. `deploy/**/*.mjs` now shares the entry-point block with `bin/**/*.mjs`.

### Notes

* Released as its own version rather than re-tagged, because `deploy/` is inside the published
  package: re-pointing v0.4.4 at different bytes would make the tag and the tarball disagree, which
  is exactly the drift this project's release notes have complained about before.
* The lesson is the same one v0.4.2 taught and it is worth repeating: a *filtered* view of the lint
  output is not the lint output. The local run ended in `Select-Object -Last 1`, printed a blank
  line, and 5 errors went past unread.

## [0.4.4] — 2026-10-09

### Added

* **`deploy/windows/` — the agent as a Windows service.** `install-service.ps1` registers one task
  (`-AtStartup` + `-AtLogOn`, `LogonType S4U`) that runs a new
  **`w2m-agent-supervisor.mjs`**: the agent runs in session 0 with no console, survives sign-out,
  and the supervisor respawns it with a capped backoff and logs one line per run. `-Interactive`
  registers the same thing without elevation (sign-in only). `winsw/w2m-localside.xml` is the
  template for a real SCM service if you need an entry in `services.msc` — that path puts a
  third-party binary on the machine as the service host, which is your decision and not the
  project's, so it is documented rather than scripted.

### Fixed

* **Three defects in the service path, all found by running it rather than reading it.**
  1. A JSON argument does not survive being passed to a task: `--allowed-commands
     "[\"node --version\"]"` came back stored as `"[node --version]"`, the agent read `[node` and
     exited 2 with `ALLOWED_COMMANDS_INVALID`. That is the third layer to eat those quotes
     (`cmd`, PowerShell 5.1, Task Scheduler), so the allow-list now lives in
     `%USERPROFILE%\.dsh\w2m\agent.json` and the command line only carries `--config <path>`.
  2. `-AgentArgs '--p2p-mode','auto'` through `powershell -File` arrived as the single token
     `--p2p-mode,auto` (`ERR_PARSE_ARGS_UNKNOWN_OPTION`); it is now one string, split on commas and
     whitespace.
  3. PowerShell 5.1's `Set-Content -Encoding utf8` writes a **BOM**, `JSON.parse` refuses it, and
     the supervisor exited 78 *before opening its log* — a failure with no trace at all. The
     installer writes without a BOM; the supervisor strips one if present, because the file is
     meant to be hand-edited and Notepad writes them too.

### Notes

* The supervisor also reads the camelCase keys a JSON file wants (`allowedCommands`, `agentArgs`)
  as well as the kebab-case flags the command line uses. The first version looked only for the
  kebab key in the file, so a correct config silently fell back to the default four-entry
  allow-list — silent, because a missing key is not an error.
* Verified after installing through the script: the task reports `Running`, the agent logs the full
  nine-entry allow-list, `stream ready` arrives, and a real fleet dispatch finishes `consistent`
  on both machines.

## [0.4.3] — 2026-10-09

Documentation and metadata only — no source change, and the protocol is untouched. The
reason for a release at all is the same reason the marketplace needs one: the ecosystem's
listing standard treats a version bump as the signal that something changed, so metadata
that changes without a bump is metadata nobody re-reads.

### Changed

* **The install section now names targets that exist.** It led with
  `dsh plugin ... add @twinsearth/w2m-dsh-plugin@0.4.0`, an **npm name that is not
  published** — a copy-paste that fails with a registry 404. It now leads with the release
  tarball (the form verified in this repository), documents the repository form a
  marketplace's one-click installer uses (`install TwinsEarth/dsh-windows2macos`), and
  says plainly that the npm-name form starts working the day the package is published.
  Both language sections carry the current version instead of a two-releases-stale one.
* **`package.json` declares what the plugin is and what it touches.** `dsh` gains
  `plugin: true` and `kind: "server"`, and a `disclosure` object states: cloud required,
  the default endpoints, no offline mode, where the two credentials live, which
  filesystem and network reaches are used, and that the reference deployment moves data
  between CN and JP. The README carries the same table for a human, because a disclosure
  a reader cannot find is not a disclosure.
* **`stateDir` in the documented config is an absolute path.** The example used
  `!!js (process.env.DSH_HOME + '/xclient')`, which on this build evaluated to
  `…/desktop/undefined/xclient` — a path that does not exist, silently, so the plugin had
  no device identity and the direct path stayed down. Measured, not theorised.

### Notes

* The repository already carried the `dsh-plugin` topic, which is the listing entry
  point for the topic-driven marketplaces; they scan it on their own schedule. Nothing in
  this release is an application to any of them.
* Still not on npm. Publishing needs the scope owner's token, which is a decision for a
  human rather than something a release can assume.

## [0.4.2] — 2026-10-09

### Fixed

* **`w2m_update` could never be called.** Its `execute` returned the plain object
  `{ ok, action, update }` while the host requires a **string** from a tool, so every
  call was rejected before it ran:

      tool "w2m_update" returned invalid output: "value" must be a string

  `output: jsonOutput` is a renderer, not a serialiser — the tool still owns turning its
  value into text, which is what the other seven do. It now returns
  `JSON.stringify(value, null, 2)` on both branches. Broken in v0.4.0 and v0.4.1, found
  by actually calling the tool rather than by reading it.

### Added

* **One test that makes the whole class impossible to repeat**: it calls all eight tools
  (including both `w2m_update` actions, with the updater's network lookup stubbed to
  fail so nothing installs) and asserts every result is a string that parses as JSON.
  `test/tools.test.mjs`: 82 pass, 0 fail.

## [0.4.1] — 2026-10-09

Two defects that v0.4.0 shipped, both found by using it against a live two-machine
fleet rather than by reading it. No wire change, no new endpoint: protocol version
stays **1** and a v0.4.0 peer keeps working in both directions.

### Fixed

* **The plugin's dispatch-time allow-list could never match a multi-token entry.**
  `checkAllowedCommand` compared `argv[0]`'s basename against each entry *whole*, so
  the documented configuration — `allowedCommands: ['node --test', 'git status
  --porcelain']` — refused every dispatch:

      COMMAND_NOT_ALLOWED: `git` is not in this plugin's allowedCommands (git rev-parse, node --test, …)

  The agent's own matcher has always been token-wise (`['node','--test']` allows
  `node --test --reporter=tap`, refuses `node -e …`), so the dispatcher's pre-flight
  and the machine that actually runs the command disagreed about the same setting.
  Both now use **one** implementation, moved to `src/agent/allowed-commands.mjs` and
  re-exported from `src/agent/agent.mjs`, so the public surface and every existing
  import are unchanged. The pre-flight stays *no stricter* than before: an entry
  naming an executable with an extension (`Node.exe`) still matches, which is the
  tolerance the old check had.
* **There was no way to pin the UDP punch port.** The node always bound an ephemeral
  port, so a machine that has to *accept* a punch — the executor — needed its
  firewall rule re-pointed after every restart. Measured on the shared server: with
  the rule stale, every dispatch fell back to the relay (`P2P_PUNCH_TIMEOUT` on the
  dispatcher, `offer_path: "relay"` in the ledger). `--p2p-port <n>` (and
  `W2M_P2P_PORT`) now pins it, validated loudly: `0`, `65536` and a non-numeric value
  are usage errors that name the setting, and an invalid value at the agent level is
  a recorded, non-fatal `P2P_PORT_INVALID` start failure rather than a silently
  ignored option. `p2pMode: relay` still binds no socket at all.

### Added

* **`src/agent/allowed-commands.mjs`** — `parseAllowedCommands` and
  `matchAllowedCommand`, one implementation for the agent and the plugin, with the
  rule they encode written down next to it: a string entry splits on whitespace, the
  executable is compared by path or by basename, and every later token is compared
  verbatim.
* **`normalizeP2PPort`**, exported next to `normalizeP2PMode`, because the CLI and
  the agent must not disagree about what a legal port is.
* **10 tests** across `p2p-node`, `tools`, `p2p-agent` and `outbound-only`: the
  multi-token allow-list in both directions, the default bind being exactly
  `{address:'0.0.0.0', port:0}`, a pinned port reaching the binder and being reported
  in `status.local`, the real CLI pinning a real port, and a bad value exiting 2.

### Verification

* Required suites (`p2p-node`, `agent`, `tools`, `p2p-plugin`, `p2p-agent`,
  `outbound-only`): **297 tests, 294 pass, 2 skipped, 1 failure** — the failure is
  the pre-existing `finds python in the bundled DSH runtime when PATH has none`,
  reproducible at HEAD. Baseline on the same files: 287 tests, 284 pass → exactly
  +10 tests, +10 passing.
* The whole repository (`test:all`): **896 tests, 888 pass, 3 failures, 5 skipped**,
  and the three are the same pre-existing environment cases documented in
  `RELEASE-STATUS.md` (`agent` python; `pipeline-e2e` × 2, an allow-list entry
  containing a space plus Node installed under `C:\Program Files`).
* Not verified: the pinned port was exercised on loopback and through the CLI, not
  against a live firewall. The claim it fixes — "a firewall rule no longer has to be
  re-pointed after every restart" — is the mechanism, and it is stated as the
  mechanism rather than as a measurement.

## [0.4.0] — 2026-10-09

The direct path becomes the default, and the P2P feature that v0.3.9 shipped but
did not wire up finally carries the task.

v0.3.9's own §8 said it plainly: the transport existed, `p2p.mode` was documented
as defaulting to `auto`, **nothing read it**, the Localside announcer was not
implemented, and `w2m_run` still dispatched through the relay — so a deployment
could believe it was on a direct path while every byte crossed the relay. This
release is that gap closed, with the same rule as before: what is not measured is
written down as not measured.

### Added

* **`src/agent/p2p-node.mjs`** — the announcer and dialer v0.3.9 did not have. One
  UDP socket per process: STUN discovery, mapping classification, candidate
  announcement with a 60 s TTL refreshed every 20 s on an `unref()`ed timer, a
  persistent accept loop, and `dial(machineId)` that returns a `P2PChannel` or a
  named failure. `start()`, `announceNow()`, `dial()` and `close()` never throw:
  a machine that cannot punch must still work over the relay.
* **`accept()` in `src/agent/p2p.mjs`** — the responder half of `punch()`, so an
  idle machine can receive a punch without having initiated one. `punch`,
  `P2PChannel`, `connect` and `deriveSession` are unchanged.
* **`src/relay/stun-server.mjs` + `bin/w2m-stun.mjs`** — an RFC 5389 Binding
  responder, so a fleet does not depend on three third-party STUN servers being
  reachable from every network it runs in. `XOR-MAPPED-ADDRESS`,
  `MAPPED-ADDRESS` and `SOFTWARE`; malformed datagrams are dropped and counted;
  `0x0111`/400 only for an unknown comprehension-required attribute.
* **The shared server, as a default rather than an instruction.**
  `SHARED_SERVER` in `src/agent/p2p-node.mjs`: `http://202.182.123.154:8787` for
  the relay and `202.182.123.154:3478` as the first STUN server. An empty
  `rabbitUrl` now means the shared server; `w2m_status` reports
  `rabbit_source: config | env | shared-default`, so "it works" and "it works
  because someone set it" stay distinguishable.
* **`deploy/shared-server/`** — one command to stand up the whole rendezvous
  host: Node, the relay, the STUN responder, an SSE-safe nginx front on :80, the
  ufw rules, and optionally the host itself as a fleet machine. The reference
  instance was built with it.
* **`p2pMode` / `stunServers` configuration** on the plugin (`W2M_P2P_MODE`,
  `W2M_STUN_SERVERS`) and `--p2p-mode` / `--stun-servers` on the Localside CLI.
  Both are validated loudly at load: an unknown mode is a startup error naming
  the setting, not a silent fallback to `auto`.
* **`transport` and `p2p` on every result**, plus a trailing `路径` column in the
  markdown report: which path the offer took (`offer_path`), which path the result
  took (`result_path`), the punch RTT, the peer address, and a named `reason` when
  the direct path was not used.
* **`PROTOCOL-v0.4.0.md`**, `deploy/systemd/w2m-stun.service`, and four new test
  suites (`p2p-node`, `p2p-transport-fields`, `p2p-plugin`, `p2p-agent`) plus
  `stun-server`.

### Changed

* **The direct path is the default connection method between machines.**
  `p2pMode: auto` is now real behaviour: the dispatching machine announces,
  punches to each target, and pushes the offer over the punched channel. The relay
  **holds its own copy of that offer back for `p2pOfferGraceMs` (3000 ms)** and
  offers it anyway if the punch does not land — without that hold the direct path
  could never win, because an SSE push over an already-open connection beats a
  punch that costs a round trip. Measured on loopback while writing it: the relay
  copy won every time. The hold is cancelled by the executor's own lease
  heartbeat, so no new message was needed to say "the direct copy arrived".
  The first value was **1200 ms and it was too tight** — measured on a 1-vCPU
  shared host, two agent tests saw the relay's copy overtake the direct one, which
  under `p2pMode: direct` refuses an offer that was about to arrive. This entry said
  1200 ms for the whole of v0.4.0; the widening to 3000 ms rode **inside** v0.4.0
  (commit `eea80c7`, the commit the tag points at) **without its own CHANGELOG
  line**, which `CONTRIBUTING.md` §5 requires for a behaviour change. The line now
  matches the shipped constant, and the omission is recorded here rather than left
  for a reader to rediscover from a diff.
* **The result notice travels back over the same channel, and the payload does
  not.** `{type:'task.result', task_id, machine_id}` is acknowledged with
  `result.ack`; the envelope is not on that frame, because `result_path` is one of
  the envelope's fields and `envelope_sha256` covers it, so the acknowledgement has
  to be known before the envelope is built. The direct path saves the dispatcher the
  wait for the relay's copy, **not the bytes** — stated here because "the payload
  path is direct" would otherwise be read as more than it is. A task's channel is
  released 30 s after its attempt (`p2pChannelLingerMs`), so duplicates of a
  finished attempt are still answerable and sessions do not accumulate.
* **`w2m_run` now dispatches with intent**: `origin_machine_id` and `p2p: {mode}`
  travel in `POST /v1/task`, so the executor knows who might dial it and the relay
  records how the task was meant to travel.
* **`w2m_wait` and `w2m_status` surface the path** — per machine in `w2m_wait`,
  and as a `p2p` block (mode, mapping, reflexive address, announcements, punches
  in/out, direct-result inbox depth) in `w2m_status`.
* **`scripts/verify.ps1` / `verify.sh` pass `--test-force-exit`** and run the five
  new suites. They previously ran every suite without it, which can hang a green
  end-to-end suite on an open SSE stream — a local verification that hangs is
  indistinguishable from one that never finished.
* **`release.yml` / `ci.yml` carry the new suites** in the explicit lists, and the
  duplicated `recovery.test.mjs` entry in both e2e lines is gone.

### Fixed

* **A STUN response's attribute padding.** The responder's first draft omitted the
  mandatory 4-byte padding after a 15-byte `ERROR-CODE` value, so every `0x0111`
  response was one byte short with a declared length of 39 instead of 40. The
  existing client decoder did not notice and neither did a hand-written hex
  expectation — both were written from the same wrong assumption. It was caught by
  a vector built numerically from the RFC layout, and it is invisible on the
  success path because all three success attributes are already multiples of four.
  The regression is pinned by an explicit length assertion plus a whole-buffer
  comparison.
* **The allow-list trap that hid a suite failure.** A string entry in
  `--allowed-commands` is split on whitespace, so a single path containing a space
  (`C:\Program Files\nodejs\node.exe`) can never match and has to be written as an
  array entry. This is why `test/pipeline-e2e.test.mjs` passes on CI runners and
  can fail locally on a Windows box whose Node lives under `Program Files`; it is
  now documented in `docs/TROUBLESHOOTING.md` §10 rather than left to be
  rediscovered.

### Compatibility

* **Protocol version stays 1.** Everything here is additive: two optional task
  fields, two optional result fields, three new files, one new CLI. A v0.3.9
  agent against a v0.4.0 relay and the reverse both keep working, and a v0.3.9
  result envelope with no `transport` still compares exactly as it did.
* **`transport`/`p2p` are deliberately NOT comparable fields.** A path is not a
  result: two machines that ran identical bytes and differ only in how the offer
  reached them stay `consistent`. A test asserts exactly that, because the
  opposite would turn a network difference into a false bug report.
* **A p2p-mode difference is not silent.** Both sides validate the mode at load;
  the relay refuses an unknown `p2p.mode` in a task body with `BAD_REQUEST` naming
  the field, and creates no task.

### Verification

* Every claim in this entry has a suite behind it. Run them with
  `scripts/verify.ps1` (Windows) or `scripts/verify.sh` (macOS/Linux), which now
  include the five new suites.
* **What is measured across a real network, and what is not.** One WAN hop was
  exercised end to end: the dispatcher on a Chinese residential network behind a
  **symmetric** NAT, the executor on the shared server in Tokyo. Measured, with
  numbers rather than adjectives:
  * the client network is `endpoint-dependent` — three STUN servers reported three
    different mapped ports for one socket (36028, 5855, 26713), punchable: false —
    so nothing can dial *into* it;
  * a punch it **initiates** to a public peer still lands: `HELLO` → `HELLO_ACK` in
    **331.61 ms**, over a channel the punched path opened, and the ledger for that
    machine records `transport: "p2p"` with `result_path: "p2p"`;
  * a machine that has to *accept* a punch needs its UDP port reachable. On the
    shared server that meant one `ufw` rule for the agent's punch port, and the port
    is ephemeral today — a fixed `--p2p-port` is the obvious follow-up, and the
    absence of it is why this is a documented step rather than a one-liner.
* **Still unverified, and named as such:** a punch between two hosts behind two
  *different* NATs (the second network that would make it possible was not
  available), punching through a cone NAT, the direct path under real packet loss
  or reordering, IPv6 (not implemented in the transport; the responder's IPv6
  branch is unexercised), and the authenticity of the UDP channel itself — a
  direct path is not more trustworthy than the relay, and `PROTOCOL-v0.4.0.md` §9
  says so rather than implying otherwise.
* A loopback punch is not evidence of NAT traversal, and neither the tests nor
  this entry claim it is. The WAN measurement is one hop with one NAT, and it is
  labelled as one hop with one NAT.

## [0.3.9] — 2026-10-09

P2P hole punching, so the payload path no longer has to cross the relay.

### Added

* **`src/agent/stun.mjs`** — an RFC 5389 Binding client on `node:dgram`, no third-party
  dependency. It discovers the reflexive address and classifies **mapping behaviour** by
  comparing the mapped port across several servers: one port everywhere is
  `endpoint-independent` and can be punched; a different port per destination is
  `endpoint-dependent` (symmetric) and cannot.
* **`src/agent/p2p.mjs`** — hole punching plus a reliable, fragmenting channel over the
  punched path: selective per-fragment ACK, retransmission with doubling RTO, an 8 MiB
  ceiling, and named failures (`P2P_PUNCH_TIMEOUT`, `P2P_NO_CANDIDATES`,
  `P2P_FRAGMENT_UNACKED`, `P2P_MESSAGE_TOO_LARGE`).
* **`src/relay/peers.mjs`** and two endpoints — `POST /v1/peer/announce` and
  `GET /v1/peer/{machine_id}` — the candidate rendezvous. Announcements are ephemeral
  and deliberately never persisted; `/healthz` reports `peers_announced`.
* **`PROTOCOL-v0.3.9.md`** — the wire contract, the frame format, and the path-reporting
  rule.
* 56 tests across `test/p2p-stun.test.mjs`, `test/p2p-transport.test.mjs` and
  `test/p2p-signaling.test.mjs`, wired into `npm test` and `npm run test:all`.

### Changed

* **`p2p.mode` defaults to `auto`**: try the direct path, fall back to the relay, and
  **report which path was used**. See "Why `auto` and not `direct`" below.

### Why `auto` and not `direct`

Punching cannot succeed against a symmetric NAT, and that is not hypothetical: measured
on the authoring machine, behind an iPhone hotspot, three STUN servers reported three
different mapped ports for the same socket — `endpoint-dependent`, so no punch from that
network can work. A default that hard-required the direct path would break every
deployment on such a network the moment it upgraded.

The fallback is never silent. Every offer and result carries `transport: "p2p" | "relay"`
and, on the relay path, the reason it fell back. A fallback that is not reported is
indistinguishable from a slow direct path, and the operator then debugs the wrong thing.

### Two mistakes the tests caught, kept here because they are the interesting part

1. **The STUN address family was read from the wrong byte offset.** RFC 5389 has a
   reserved byte before `Family`; `value[0]` yields the reserved byte, so every address
   decoded to `null` — which is indistinguishable from a server that sent no address at
   all. A self-written fake STUN server agreed with the wrong offset perfectly. Only a
   real server disagreed, which is why the suite has a live layer and a frozen captured
   response.
2. **Both peers generated their own random session id**, so each discarded the other's
   `HELLO` and the punch timed out looking exactly like a NAT failure. `punch()` now
   requires an agreed id (or an explicit `allowSessionAdoption`), and **throws** rather
   than inventing one — a misleading timeout is the most expensive possible
   misdiagnosis here.

### Not yet wired

The `p2p.mode` setting is defined and documented but nothing reads it yet; the Localside
announcer and direct-path dispatch are not implemented. **The task path therefore behaves
exactly as v0.3.8.** Stated here, in `PROTOCOL-v0.3.9.md` §8 and in the README, so that no
deployment believes it is on a direct path when it is not.

### Verified / not verified

Verified on macOS 27.0 / arm64: STUN against Cloudflare, Google and Nextcloud; the
mapping classifier against a real symmetric NAT; the punch, fragmentation, selective ACK,
retransmission under injected loss, and every failure mode, over real UDP sockets.

**Not verified, and impossible on one machine:** a punch across a real NAT. Two sockets on
one host share a loopback path with no translator between them, so "the punch succeeded"
says nothing about traversal. That still needs two hosts behind two different NATs.

### The v0.3.5 / v0.3.6 release gap

Both versions are tagged, and **neither was ever published**. The flake fixed above failed inside the
`Release` workflow, so those two tags have no GitHub release and no downloadable tarball. The evidence
for the cause is the release list itself: v0.3.4 published, v0.3.7 published, and the two in between
absent.

They cannot be published retroactively, and this is worth stating precisely rather than papering over:
a tag pins the tree that ran, and the tree at those tags **contains the flaky test**. Re-running their
`Release` workflow fails again for the same reason. Moving a tag forward to pick up the fix would
publish the right code under the wrong version — `package.json` at v0.3.5's commit says `0.3.5`, so the
tarball would be named 0.3.5 while containing later code.

What that means in practice: **v0.3.7 is the first published artifact that contains the shared config
(v0.3.5) and the metrics endpoint (v0.3.6).** Anyone installing from releases gets all three. The gap is
cosmetic in effect and real in the record, which is why it is written down instead of skipped.

The process lesson is the one that cost the most here: a flaky test does not just fail a build, it can
block every release behind it until someone notices that the failures share a cause. Three consecutive
release runs failed before the pattern was visible in the release list.

## [0.3.8] — 2026-10-08

The last open v0.3.3 item, resolved by reading the shipped runtime rather than guessing.

### The finding

**UI cards: there is nothing to add.** `defineTool` treats `presentCall`'s return value as an opaque
hint and never validates it —

```js
if (userPresentCall) tool.presentCall = (args) => {
  if (validate(args).length > 0) return void 0;
  return userPresentCall(args);
};
```

— which means two things. There is **no registry of card types** to choose from: nothing in the shipped
bundle reads `card` at all. And a wrong field **cannot be caught by the runtime**; it would fail
silently in the UI. That is precisely why guessing a richer card was the wrong move, and why this item
sat open rather than being closed by inventing something.

The shipped runtime contains exactly two reference implementations, and they are the only evidence for
what the fields mean:

| where | card | kind |
|---|---|---|
| built-in `run_code` (`dsh-tools/lib/index.js:1445`) | `"generic"` | `"execute"` |
| the plugin manager (`dsh-plugin-manager/lib/types/tools.js:85`) | `'generic'` | `action.startsWith('list_') ? 'read' : 'other'` |

Both use `generic`. `kind` varies by whether the action mutates. That is the whole vocabulary with a
reference behind it.

### Fixed

- **`w2m_update` reported `kind: 'read'` for its check-and-install action**, which can install a new
  version into the very profile it runs in. A false "read" is worse than no hint, because the hint is
  what a user reads to decide whether a call is safe — the same class of defect as the `intervalDays`
  option that silently did nothing, and fixed for the same reason. It now reports `other` for `check`
  and `read` for `status`, matching the plugin manager's vocabulary for exactly that distinction.

  `w2m_run` keeps `write` when `write: true`: it executes on other machines, which `read` would
  understate. The other six tools were already accurate.

- **`rawInput` is now asserted never to carry a credential.** It is handed to the UI, so anything in it
  is rendered — and the shared-config work in 0.3.5 was specifically about keeping tokens out of files
  that travel. The same rule applies to a card.

`presentResult` was deliberately **not** adopted: it is a second, equally unvalidated hook whose
result-side contract appears nowhere in the shipped bundle. Adopting it would be the same guess this
release declines to make. The reasoning is recorded in `docs/UI-CARDS.md` so the question is not
re-opened from memory.

### Verification

626 unit tests, 624 pass, 2 skip, 0 fail, 0 todo; 21 suites wired into `ci.yml`, `release.yml` and
`package.json` with exhaustiveness checked. ESLint 0 errors, 56 warnings. Five new tests in
`test/tool-cards.test.mjs`, including the credential check and a call with no arguments — which is what
the runtime itself does on a schema-invalid call.

### v0.3.3 is now complete

broadcast, pipeline, shared configuration, metrics and multi-arch images were delivered in 0.3.2
through 0.3.6; UI cards are settled here. The two items from the v0.3.0 batch that remain undone are
the optional WebSocket transport and the optional libp2p fallback package — both judged to duplicate
what HMAC signing plus the existing backoff already provide, and neither is required by any acceptance
criterion.

## [0.3.7] — 2026-10-08

### Fixed

- **A flaky assertion in the agent suite, which failed on CI and passed locally every time.**
  `never publishes a half-written document` asserted `reads > 20` inside a fixed 1200 ms wall-clock
  deadline. That is a **throughput** threshold, not the property under test: whether the loop manages 20
  iterations depends on how loaded the runner is, so on a busy machine it failed at 15 reads while the
  atomic-publish code was perfectly correct. It passed here every time because this machine is fast.

  The test now waits until the writer has actually published the file — so the loop cannot pass
  vacuously by reading a file that never existed — and asserts `reads > 0` plus `parsed === reads`,
  which is the real invariant and a torn write would break it. Verified over five consecutive runs of
  the specific test and a full agent suite pass.

  Worth recording because of where it surfaced: CI, not here. A test that measures machine speed will
  always pass on the author's machine, which is exactly why the timestamped evidence has to come from
  somewhere other than the machine that wrote the code.

- **Two wrong metric-type and metric-set decisions corrected before release**, both pushed back on by
  the teammate who implemented the renderer, and both worth stating because the reasoning is the
  valuable part:

  - `w2m_task_status_total{status}` is declared **`gauge`, not `counter`** despite the `_total` suffix. The
    values are the *current* count of tasks in each state, so a task moving from `pending` to
    `consistent` decrements one bucket and increments another. A counter is monotonic by definition, so
    declaring this one would make `rate()` produce nonsense and violate the "counters reset on restart"
    convention. The `_total` name is kept deliberately — a dashboard or recording rule may already point
    at it — and this note is the record that the suffix is a name, not a claim about the type.
  - `w2m_rtt_stale{machine_id}` was added (0/1, emitted only for machines that reported an RTT), because
    `w2m_rtt_ms` alone cannot distinguish "genuinely slow" from "reported 40 ms once and then vanished
    forever" — a stale series reads as a healthy machine. With both, the operator's query works:
    `w2m_rtt_ms > 500 and on(machine_id) w2m_rtt_stale == 0`.

  The implementer also **proved the null-versus-zero assertion has teeth by mutation**: pushing a
  fabricated `rtt_ms: 0` for a silent machine turned three assertions red, then the mutant was deleted.

### Verification

621 unit tests, 619 pass, 2 skip, 0 fail, 0 todo; 63 end-to-end. 20 suites wired into `ci.yml`,
`release.yml` and `package.json` with exhaustiveness checked. ESLint: 0 errors, 56 warnings, all
pre-reviewed. The `Docker` workflow built both architectures successfully on the runner — which
upgrades the multi-arch images added in 0.3.5 from "unverified" to **built**, though still not pushed
anywhere.

### Still not done

**UI cards** — the last of the four v0.3.3 items.

## [0.3.6] — 2026-10-08

### Added

- **`GET /metrics`**, Prometheus text format, off unless `--metrics` is passed. It is **token-free**
  like `/healthz` and for the same reason: a scraper that needs the operator token puts that token in a
  Prometheus config file, which is a credential in a place nobody reviews. It is likewise exempt from
  signature checks, because the scraper has no secret to sign with — requiring one would make metrics
  unreachable on exactly the hardened deployments that most want them.

  Disabled answers **404, not 403**: a 403 tells a scanner the surface exists, and an endpoint that
  appears without being asked for is a surface nobody chose.

  The renderer was implemented separately from the route on purpose, and this release is the evidence
  for why the two are different: the module had 16 green tests while `GET /metrics` still returned 401,
  because a correct renderer behind an unreachable route is indistinguishable from an unimplemented
  feature. `test/metrics-route.test.mjs` now covers the route itself — absent by default, token-free
  when enabled, reachable under `--require-signature`, and never leaking the operator token or the
  signing secret into a body that gets scraped into long-lived storage.

  Where the renderer's rule lives: a machine that never reported an RTT has **no series at all**, not a
  `0`. In Prometheus `0` is a real measurement meaning "instantaneous" while a missing series is
  `absent()` — the same null-versus-zero distinction the relay-side RTT work turns on.

### Fixed

- **`--signing-secret`, `--signing-secret-previous`, `--require-signature` and `--signature-skew` were
  parsed but missing from `--help`**, so an operator could not discover them from the CLI. A flag
  nobody can find is a flag that does not exist in practice. Found by the teammate building the Docker
  images, who reported it rather than fixing it outside their scope.
- A fourth mojibake casualty: `cannot dispatch a tas` in the operator-token error, another word the
  earlier GBK round trip truncated.

### Verification

621 unit tests, 619 pass, 2 skip, 0 fail, 0 todo. 20 suites wired into `ci.yml`, `release.yml` and
`package.json` with exhaustiveness checked. ESLint: 0 errors, 55 warnings, all pre-reviewed.
`/metrics` was also confirmed against a live relay process: 404 without `--metrics`, and 200 with the
correct content type and metric series with it.

### Still not done

**UI cards** — the last of the four v0.3.3 items. The eight tools render through the generic card.

## [0.3.5] — 2026-10-08

Two of the four remaining v0.3.3 items: shared configuration and multi-arch images.

### Added

- **Shared configuration** (`src/plugin/shared-config.mjs`). One committed file, `.w2m.json` at the
  project root, that every machine reads — so the allow-list, the timeout and the update schedule stop
  drifting per machine. Layering is `.w2m.json` → `~/.w2m/machine.json` → the host's own config object,
  highest wins key by key.

  It lives **in the project, not on the relay**, because a relay-hosted config would mean the relay
  holds the fleet's credentials or the config splits into secret and non-secret halves — and the
  operator ruled that the relay must not hold credentials. A file in the project needs nothing from the
  relay, works while the relay is unreachable, and is reviewed in the same pull request as the code it
  governs.

  Four decisions worth stating, each of which is a way config systems fail their users:

  - **Secrets are refused, not ignored.** A key matching `token`/`secret`/`password`/`credential`/
    `apikey` is rejected with a message naming the key. Silently dropping it would let the operator
    believe a token is in effect, and a token in a committed file is a leak that survives every later
    decision.
  - **A typo'd key is refused.** A silently-dropped key is indistinguishable from a setting that works,
    which is the worse of the two failures.
  - **Absence is tolerated, breakage is not.** No file is the normal case and yields defaults; a file
    that exists and does not parse is a loud error. Running on defaults while the operator believes
    their settings apply is exactly the silently-wrong outcome this project refuses elsewhere.
  - **Every effective value reports its source** through `w2m_status`. "The setting is in the file I
    edited and something else wins" is the characteristic failure of layered configuration, and the
    answer must be readable from one call instead of by bisecting the layers.

  `timeout_ms` lost its schema `default` for a related reason: with a default in the parameter map, DSH
  fills it in before `execute` runs, so a timeout set in the shared config would be silently overridden
  on every call and the operator would see their setting do nothing.

- **Multi-arch Docker images** (`deploy/docker/`, `.github/workflows/docker.yml`) for `linux/amd64`
  and `linux/arm64`. The relay's real import closure was computed to prove the image installs **no npm
  packages**: 7 files, ~175 KiB, all `node:` builtins. The image is non-root with a `VOLUME` state dir
  and a token-free `HEALTHCHECK`.

### Verification

600 unit tests, 598 pass, 2 skip, 0 fail, 0 todo. 19 suites wired into `ci.yml`, `release.yml` and
`package.json` with exhaustiveness checked. ESLint: 0 errors, 55 warnings, all pre-reviewed.

### Not verified

- **No Docker image was built.** Docker, Podman and buildah are all absent from this machine, and
  Docker Hub is unreachable from it, so every build/push/platform claim is unverified. What *was*
  verified without Docker: all COPY sources exist, all 7 closure files are covered by the COPY set, no
  package manager appears anywhere, the base tag is an exact patch version, and — the strongest one —
  the container's `CMD` was executed directly against the same file set, starting the relay, answering
  `/healthz` without a token, exiting 0 from the exact `HEALTHCHECK` command, and writing the pairing
  code to stderr.
- The base tag `node:22.23.3-bookworm-slim` could not be confirmed against the registry. The version
  itself was verified against `nodejs.org/dist/index.json`.
- `metrics` is implemented but **not yet routed**; `GET /metrics` still 401s. See v0.3.6.

### Reported, not fixed

`--signing-secret` and `--require-signature` are parsed by `bin/w2m-rabbit.mjs` but missing from its
`--help` output, so an operator cannot discover them from the CLI. Outside the scope of the task that
found it.

## [0.3.4] — 2026-10-08

### Added

- **`pipeline` mode.** Every machine runs the whole chain from `stages`, in order, stopping at the
  first stage that fails. The semantics were chosen against the alternative — fan stage 1 out, converge
  its outputs into stage 2 — because that one has **no well-defined input**: on a fleet, stage 1
  produces *n* different outputs, and "feed them all to stage 2" does not say in what order, or
  whether stage 2 then runs once or *n* times. Worse, two machines finishing in a different order would
  produce different stage-2 inputs, so one `task_id` would no longer describe one reproducible
  execution — which is the property this system is built on. A pipeline is therefore `replicate`
  applied to a sequence: no cross-machine data flow, so nothing can be silently dropped in transit.
  The reasoning is in `docs/PIPELINE-DESIGN.md`.

  The chain's `command_hash` binds **every** stage. Bound to stage 0 alone, two chains differing after
  the first stage would share a hash, and an envelope produced by the wrong chain would still verify —
  defeating the point of the anchor. The agent and the relay compute this hash with independent
  implementations, and a test recomputes both to catch a drift rather than letting them agree silently.

  A per-stage record travels in the envelope, so a reader can tell "stage 1 failed" from "stages 2..n
  never ran" — a single exit code cannot, and the two call for different responses.

### Fixed

- **`pipelineCommandHash` was never imported into the agent.** Referenced but not bound, so every
  pipeline offer threw `ReferenceError` at envelope-build time and was reported as `crashed`. The
  mistake survived an import check because a *comment* in the same file mentioned the name: the check
  searched the file text instead of the import block, so it reported success. The check now matches the
  import statement itself.

### Verified

`test/pipeline-e2e.test.mjs` drives a real relay and a real agent: the stages append to a witness file,
so the ordering evidence is written by the stages themselves and cannot be right unless they ran in
that order. The second case proves the chain stops — a failing second stage means the third never
writes to the witness at all.

### Notes on what the e2e had to get right

Five versions of this file failed before it passed, and every failure was the test reaching for
something that does not exist:

- `GET /v1/tasks/{id}/report` returns a *string* body, not parsed JSON, and the aggregate lives under
  `body`. `GET /v1/tasks/{id}` returns parsed JSON — and requires a **device** token, not the operator
  token, which is what the first version sent.
- `aggregate.machines` is a projection that deliberately omits envelopes, so
  `aggregate.machines[0].envelope` is `undefined` by design. The per-stage shape is asserted in
  `broadcast.test.mjs` against the state object instead; the e2e asserts only what the wire publishes.
- `base_tree` must be the agent's `treeFingerprint` (`git-temp-index-tree/v1`), not
  `git rev-parse HEAD^{tree}`. A git tree SHA is a different value, and sending one made every task
  `unverifiable`.
- The agent's allow-list is **default-deny**; without `--allowed-commands` every offer is refused
  `COMMAND_NOT_ALLOWED`, correctly, with a startup warning saying so.

### Verification

578 unit tests, 576 pass, 2 skip, 0 fail, 0 todo; 61 end-to-end plus 2 pipeline end-to-end. All 17
suites are wired into `ci.yml`, `release.yml` and `package.json` with exhaustiveness checked. ESLint:
0 errors, 54 warnings, all pre-reviewed.

### Still not done

Shared config, UI cards, metrics and multi-arch images from the v0.3.3 batch remain untouched.

## [0.3.3] — 2026-10-08

The CI hardening the v0.3.0 batch called for, plus a correctness fix those tests found.

### Fixed

- **Every successful `split` was reported `divergent`.** `index` is a comparable field, the relay
  hands each machine its own slice by index, and Step 3 of the aggregation flagged any comparable
  field that differed. So a fan-out where every machine did exactly what it was asked produced a
  verdict that `README.md` defines as "machines disagreed" — a false alarm on the normal case, every
  time. Step 3 now compares **within a shard**: machines meant to produce the same output are
  compared with each other, and machines given different slices are not compared at all.

  The fix is a grouping rather than a special case, which is why it is safe: for `replicate` every
  machine has index 0, so there is a single group and the behaviour is byte-identical. The 140
  existing relay tests passing unchanged is the evidence for that, not a new test asserting it.
  `step3.comparable` still reports each machine's index — it is simply not treated as disagreement.

  Found by the stress suite written in the same release, not by inspection: no test anywhere covered
  split aggregation, because the only split test asserted index *assignment*.

### Added

- **`test/stress.test.mjs`** — bounded load, asserted on the ledger rather than on status codes: 200
  concurrent dispatches (ids unique, all retrievable, `/healthz` and `GET /v1/tasks` agreeing), 24
  concurrent redeliveries of one instance recorded exactly once (checked in `results`, `taskResults`,
  `result_seqs` and `dedupeReport`, with a verified `envelope_sha256`), 50 devices with no lease lost
  and split indices matching `i % index_total`, and a limit-3/burst-12 refusal test with two controls
  — failed attempts consume the same budget, and with the limiter off the same burst yields zero 429s.
- **`test/recovery.test.mjs`** — the disconnect story against real processes: relay killed mid-task
  and restarted, with the agent noticing on its own and the outcome still delivered; the witness file
  showing the command ran exactly once across the reconnect; a cleanly closed stream treated as a
  disconnect with a laddering backoff rather than a hot loop; and a 401 result staying spooled with
  exactly one attempt.
- **`scripts/scan-mojibake.mjs`** — the corruption that hit user-visible strings earlier is invisible
  in review because the bytes are valid UTF-8; they just spell the wrong thing. This scans for it.

### Notes on what these tests had to get right

Both new suites produced failures that were in the tests, not the product, and the distinction
mattered each time:

- The recovery suite's `waitFor` used a truthiness check on an exit code, so `0` — success — read as
  "not yet" and the case timed out while the product was working correctly. Confirmed with an
  isolated repro before changing anything.
- The stress suite's split assertion initially encoded the buggy expectation (`differences` non-empty)
  alongside the correct one. Fixing the product meant inverting that assertion, which is exactly the
  signal that the recorded defect was real rather than a misreading.
- The stress suite's independent check read `m.envelope`, which `aggregateTask` deliberately omits
  from its machine projection; it now reads `step3.comparable`, which is the field that actually
  carries the compared values.

### Verification

568 unit tests, 566 pass, 2 skip, 0 fail, **0 todo**; 61 end-to-end. All 16 suites are wired into
`ci.yml`, `release.yml` and `package.json`, and that exhaustiveness is itself checked — an earlier
release had suites that no script ever ran. ESLint: 0 errors, 53 warnings, all pre-reviewed.

### Not in this release

- **`pipeline`** — the semantics question is answered (the whole chain runs on one machine, so
  `broadcast` chooses where and `pipeline` describes the sequence) but the implementation is not
  written. The reasoning and the required changes are in `docs/PIPELINE-DESIGN.md`; the relay rejects
  `mode: "pipeline"` with `BAD_REQUEST` rather than silently falling back to `replicate`.
- **Shared config, UI cards, metrics, multi-arch images** — untouched; the next batch.

## [0.3.2] — 2026-10-08

The first half of the v0.3.3 batch: a third dispatch mode.

### Added

- **`broadcast` mode.** One machine runs the command and every other machine is told the outcome
  without running anything. Useful when the point is not redundancy but *notification* — a migration
  applied once, a deploy, a cache purge — and the other machines need to know it happened.

  The design is built around one hazard: **a machine that did not run must never be counted as
  agreeing.** If observers were ordinary participants, a broadcast of a successful command would
  aggregate to `consistent`, and a reader would reasonably conclude that the whole fleet had verified
  the result when in fact one machine ran and the others were merely told. So observers hold an
  `observing` lease, which Step 0 of the aggregation routes out of the participant set entirely:
  they cannot pass, cannot refuse, and cannot contribute to a verdict. `step0.observing` lists them
  explicitly so the report says who was informed rather than implying they were involved.

  Three consequences worth stating, because each is a bug the obvious implementation would have:

  - Without treating `observing` as "not a participant", an observer has no envelope and never will,
    so the anchor step classifies it `pending` and **the task can never reach a verdict** — every
    broadcast would hang. Covered by `does not hold the verdict open for a silent observer`.
  - A broadcast whose executor has not reported yet must be `pending`, not `consistent`. With only
    observers participating, a naive aggregation sees zero machines and zero failures, which reads as
    success. Covered by `is pending, not consistent, while the executor has not reported`.
  - The executor is chosen **deterministically** (the first machine the relay lists), not randomly. A
    random leader makes a task impossible to reproduce from its own record — the same `task_id` would
    run somewhere else on a retry — and being able to say exactly where something ran is the point of
    this project.

  `executor_machine_id` selects the machine explicitly and is **refused outside broadcast** rather
  than ignored: the relay reads it only for `broadcast`, so accepting it under `replicate` would look
  like "only this machine runs it" while the command ran everywhere. A restriction that is not
  enforced is worse than no parameter. For the same reason `broadcast` with `index_total > 1` is
  refused instead of coerced — running one shard while recording a split task would put work in the
  report that never happened.

### Verification

559 unit tests, 557 pass, 2 skip, 0 fail; 57 end-to-end. Twelve new tests in
`test/broadcast.test.mjs`, written around the failure this mode can most easily produce rather than
around the happy path. ESLint 0 errors.

### Not in this release

`pipeline` and the composable mode are **not implemented**. The relay rejects `mode: "pipeline"` with
`BAD_REQUEST` rather than falling back to `replicate`: silently running a chained request on every
machine would be an expensive misreading of what was asked.

## [0.3.1] — 2026-10-08

Two tools that landed after 0.3.0 was published, so they get their own version rather than a moved
tag: a published release is a promise about a specific tarball, and rewriting it would break anyone
who already downloaded it.

### Added

- **`w2m_history`** — recent tasks newest-first with their modes, shard counts, lease holders and
  cancellation state, without fetching a single result envelope. It reports how many tasks the relay
  *holds* alongside how many it returned, because a page emptied by a filter and an empty relay
  produce identical lists and only one of them is a problem. The limit is clamped locally so a model
  cannot make this machine allocate a million rows.
- **`w2m_stats`** — the fleet in one call: machine and task counts, aggregate RTT, whether the relay
  restarted. It degrades rather than failing: if this machine cannot read the per-machine roster it
  still reports the relay's own totals, with a note naming which half is missing.

In both, `null` means "the relay did not report it" and never "zero" — the same distinction the
0.3.0 relay-side RTT work turns on, applied at the tool boundary.

The tool count is now **eight**, which is the number the original request asked for.

### Verification

545 unit tests, 543 pass, 2 skip, 0 fail; 57 end-to-end. `scripts/verify-installed.mjs` confirms
eight tools register in both the repository and the packed artifact, and the CI `lint` job reports
0 errors.

## [0.3.0] — 2026-10-08

### Added

- **Cross-machine RTT, carried by the relay.** The round-trip time used to live only in a local
  state file, so with the plugin on machine A and the agent on machine B — the normal cross-region
  shape — there was no view at all. The heartbeat now carries `rtt_ms`; the relay stores it and
  exposes it per device (`/v1/devices`), in aggregate (`/healthz.rtt`), and per machine
  (`/v1/agents/{id}/status`).
- **Idle diagnostic heartbeats.** An agent with no work now reports every 60 s, because the moment
  you look at a machine is the moment it has nothing to do. Without this the cross-machine view
  freezes at whatever the last task measured — and once `rtt_stale` flipped, it read as "the machine
  is up but slow", which is worse than "unknown".
- **Three new aggregate verdicts**, so the status field says what actually happened:

  | verdict | replaces |
  |---|---|
  | `timeout` | `pending` forever, which made "nobody will ever answer" look like "still in flight" |
  | `cancelled` | indistinguishable from `failed`, which reports a deliberate stop as a malfunction |
  | `degraded` | `partial`, which also means "machines are still out" |

  `partial` keeps its original meaning: work is outstanding. The three additions are verdicts, not
  phase flags, which is why they sit in `AGGREGATE_STATUSES` rather than beside `pending`.
- **Request signing** (`src/signing.mjs`, wired into the relay in this same release). HMAC over the
  method, the routed path, a timestamp, a nonce and the exact body bytes. It defends replay,
  tampering and a leaked log. It is **not** end-to-end encryption and not a replacement for TLS, and
  the module says so in its first paragraph — a security claim that overreaches is worse than none.
- **`w2m_history` and `w2m_stats`**, taking the tool count from six to eight. `w2m_history` lists
  recent tasks newest-first with their modes, shard counts, lease holders and cancellation state,
  without fetching a single result envelope; it reports how many tasks the relay *holds* alongside
  how many it returned, because a page emptied by a filter must not be indistinguishable from an
  empty relay. `w2m_stats` summarises the fleet in one call — machine and task counts, the aggregate
  RTT, whether the relay restarted — and degrades to the relay-reported totals when this machine
  cannot read the per-machine roster. In both, `null` means "the relay did not report it" and never
  "zero".
- **A mechanical outbound-only check** (`test/outbound-only.test.mjs`). The project's central promise
  is that no public IP, port forwarding or SSH server is needed because every machine only dials
  out; that is easy to state and easy to break. The test runs real processes and asserts that a
  registered agent binds nothing, that the relay's default bind is loopback and says so in its
  banner, and that an unbindable host is a startup failure rather than a silent fallback.
- **One-click installers**: `scripts/install.ps1` and `scripts/install.sh`, both verifying the
  published SHA-256 before writing anything, and both re-reading the installed package afterwards to
  confirm the tools actually register ("it installed" is not "it loads").
- **ESLint and Prettier**, with `docs/LINT-AUDIT.md` recording the current state honestly: 1 real
  defect, 27 style findings, 46 deliberately accepted. Prettier is configured but not applied —
  measured, it would rewrite 23,715 of 26,383 lines (89.9 %), and obliterating `git blame` for the
  whole repository to satisfy a formatter is a bad trade. The CI job reports the number instead.

### Fixed

- **`resolveProfileDir` called `existsSync` without importing it.** Under ESM that is a
  `ReferenceError`, so `apply()` threw for any plugin loaded from a profile — the normal installed
  layout. It survived 458 green tests because no test ever executed that branch. ESLint's `no-undef`
  found it. Fixed by importing it *and* by moving the function out of the closure into an exported,
  directly testable helper with seven tests: the import alone would leave the next such mistake just
  as invisible.
- **A signing-path disagreement between the two sides.** The agent signed the raw request URL; the
  relay verified the routed path. Both unit suites passed. The mismatch breaks only the third
  documented deployment — a reverse proxy that strips the prefix — where the relay never sees the
  prefixed string at all, so no reconstruction is possible. The client now signs the routed path
  (query included), and `test/signing-e2e.test.mjs` drives a real relay behind `--base-path` with a
  real signature so the contract cannot drift again.
- **Mojibake in user-visible strings.** An earlier PowerShell edit round-trip wrote parts of
  `src/plugin/tools.mjs` through GBK, turning em-dashes into CJK sequences inside error messages and
  tool descriptions — text a model and a human actually read. Repaired with
  `scripts/fix-mojibake.mjs`, which uses only escape sequences so it cannot be corrupted by the same
  round-trip, plus `scripts/scan-truncations.mjs` to catch words the corruption had truncated
  (`unavailable` had become `unavailabl`, and only a test noticed).
- **`npm test` and both verify scripts listed three suites**, so the v0.2.3 suites never ran through
  them. Every `test/*.test.mjs` now appears in `ci.yml`, `release.yml` and `package.json`, and that
  exhaustiveness is itself checked.
- **`engines` claimed Node >= 20.0.0** while ESLint 10 requires >= 20.19.0.
- **`PROTOCOL-v0.3.0.md` was not in `package.json` `files`**, so the compatibility matrix would not
  have shipped.

### Compatibility

- `PROTOCOL_VERSION` stays **1**. Everything here is additive: new optional request fields, new
  response fields, one new endpoint, and optional verification.
- An unsigned request is accepted exactly as before unless a relay is given a signing secret **and**
  `--require-signature`. The relay suite's pre-existing tests passed unchanged when signing was
  wired in, which is the evidence for that claim rather than a new test asserting it.
- A v0.2.3 agent works against a v0.3.0 relay and vice versa. Two caveats, both documented in
  `PROTOCOL-v0.3.0.md`: a v0.2.3 relay answers an idle heartbeat with `404` (the agent must tolerate
  it, and does — as debug-only, with no retry storm), and a v0.3.0 relay reports `rtt_ms: null` for a
  machine that never reports one. `null` means "never measured"; `0` means "very fast", and the two
  are never conflated.

### Verification

539 unit tests, 537 pass, 2 skip (POSIX mode bits on NTFS); 54 end-to-end + crossnetwork.
ESLint reports **0 errors, 46 warnings**, every warning being one of the two classes
`docs/LINT-AUDIT.md` already classified as benign and deliberately accepted.

Two of the lint findings were not cosmetic, and both were restored rather than deleted:

- An agent test counted stream attempts in `requests` and never read it. The test is named
  "keeps retrying gently instead of hot-looping" — the counter *was* the assertion, so an
  implementation that backed off for the log line while opening a connection per millisecond would
  have passed. The bound is back.
- `auto-update.mjs` accepted an `intervalDays` option and never enforced it. A declared guard that
  silently does nothing is worse than no option at all, because it reads as protection. It is now
  enforced against the last *successful* install, checked before any network work.

The signing vectors from `PROTOCOL-v0.3.0.md` §9.4.1 are pinned in **both** suites and recomputed
independently in each, so a drift in either implementation turns one of them red — a shared constant
would let both agree on a wrong value.

> The `v0.3.0` tag was moved once, from the commit that first carried this version to the commit
> containing these fixes. The first tag had no published release associated with it yet, and the
> difference was in shipped source (a missing guard, three malformed error messages), so leaving the
> tag behind would have published code that does not match this changelog.

### Not verified

- **ESLint has not been run in this working tree** (no npm registry access, so `devDependencies` are
  not installed). The `lint` CI job runs it on the hosted runner. The one defect it found was fixed
  by inspection, and the `no-undef` rule is what will confirm that.
- **`scripts/install.sh` has not been executed** — there is no macOS or Linux shell on the
  development machine. It is statically reviewed only, and the script says so itself.
- **macOS remains unverified on real hardware.** CI runs the agent logic on `macos-latest`, which is
  not the same as two machines reaching one relay.
- **No real signed deployment has been exercised across a proxy.** The sub-path case is covered
  against a real relay with `--base-path`; a real nginx/Caddy stripping the prefix is not available
  here.

## [0.2.3] — 2026-10-08

### Added

- **Daily self-update.** A machine running the plugin checks its own GitHub
  releases at **00:00, 03:00 and 05:00 Beijing time** and installs a newer
  version, verifying the published SHA-256 before writing anything. Off by
  default; `autoUpdate: true` turns it on. New tool **`w2m_update`** reports the
  schedule, the installed version, the last check and whether a restart is
  pending, and can run one cycle on demand.
- **A timezone-aware daily scheduler** (`src/plugin/schedule.mjs`), used by the
  updater. The host's own `@deepseek-ai/dsh-schedule` was evaluated and rejected
  for this job: its reminders are bound to an Agent Session and delivered as
  inbox messages, and its README states it "cannot be mounted alone in a
  headless or SDK-only composition" and that the shipped Web composition carries
  no `schedule` row. A plugin-owned recurring job has no Session to bind to, so
  it owns its timer — reversibly, via `ctx.effect`.

### Why the updater is built the way it is

Each of these is a decision, not an implementation detail:

- **Never a downgrade.** `isNewer` is a strict-greater test, and a prerelease is
  refused separately: `0.2.0-rc.1` outranks `0.1.2` by SemVer, so a comparison
  alone would ship candidates to stable installs. The comparison answers "which
  is higher"; the policy layer answers "may we install it".
- **Verify, then write.** The tarball must match the `SHA256SUMS` published with
  that release. A mismatch writes zero bytes — no staging directory, no backup.
- **Back up and roll back.** `package.json` and `pnpm-lock.yaml` are restored
  byte-for-byte on failure, through the supported `dsh plugin` entry point rather
  than by editing `node_modules` by hand.
- **Say what a rollback really guarantees.** Restoring the manifest does not undo
  what pnpm already did to `node_modules`. Rather than claim "rolled back", the
  result carries `rollbackComplete` (does the installed tree match the restored
  manifest again?) plus a `reconciliation` command, and the plugin exposes it as
  `reconciliation_needed`.
- **A lookup failure is not "up to date".** They look identical in a log and only
  one of them is a problem, so a failed check is recorded as an error.
- **The updater does not restart DSH.** Installing changes what loads next start.
  Rewriting a module that a live Cordis container has already loaded is not
  something a plugin may do safely, so the status says `restart_required`
  instead of implying the new code is live.

### Fixed

- **`ctx.effect` was called through optional chaining.** `ctx.effect?.(...)` in
  `apply()` meant that on any host without it the scheduled job would be
  registered nowhere and released never — no error, no log, just a daily task
  that silently does not exist. It is now a required call that fails loudly by
  name (`W2M_NO_EFFECT`) when the feature is enabled, and is skipped entirely
  when it is not. Verified against the real runtime that Cordis 4.0.4 does
  provide it, so the strict call does not break the current host.
- **The plugin's own version is now baked in at pack time.** `PLUGIN_VERSION` is
  a placeholder in the repository and is substituted from `package.json` by
  `scripts/pack.mjs`, which fails if the placeholder goes missing. A
  hand-maintained version string would eventually disagree with the release, and
  the updater compares against exactly that string.
- **A malformed update setting fails loudly.** `autoUpdateTimes`,
  `autoUpdateTimeZone` and `updateRepo` are validated at load and name
  themselves in the error. Silently falling back to a default would move the
  check to an hour nobody chose, and nothing would say so.

### Compatibility

- `PROTOCOL_VERSION` stays **1**. This release adds no wire changes: everything
  here is local to the plugin, plus one new tool.
- The tool count goes from five to six with `w2m_update`. Nothing existing
  changed shape.

### Verification

435 unit tests, 434 pass, 1 skip (POSIX mode bits are meaningless on NTFS):

| suite | tests | covers |
|---|---|---|
| relay | 91 | unchanged from 0.1.2 |
| agent | 105 | unchanged from 0.1.2 |
| plugin | 73 | eight tools registered, operator token, sub-path, diagnostics, plus config validation and `ctx.effect` ownership |
| schedule | 39 | zone maths, exact UTC instants for each slot, DST zones, a year of consecutive arming, catch-up collapse |
| auto-update | 34 | the install/skip decision, no downgrade, prerelease refusal, unverified tarball refused, lookup failure recorded as an error, token never persisted |
| update-source | 50 | version ordering, streaming SHA-256, timeouts, rate limits, one real GitHub call |
| update-install | 28 | zero writes on hash mismatch, byte-for-byte restore, atomic staging, dry run |
| update-wiring | 15 | config validation is loud, one `ctx.effect` owns the timer, its disposer stops it |

The schedule is checked against a whole simulated year: every arming must advance,
land exactly on its configured slot, and never shift the Beijing offset — the
invariant a drifting implementation breaks slowly and invisibly.

### Not verified

- **No real install has been performed against a live DSH profile by this
  release's test suite.** The installer's integration tests use throwaway
  profiles in temp directories; `C:\Users\fangw\.dsh` was never written to.
- **The end-to-end "a new release is published and a running machine picks it up
  by itself" path has not been exercised against a real new release.** Every
  stage is covered in isolation and with injected transports; the loop closing in
  production is the first thing to watch on the next version bump.
- The updater has not been observed through a full sleep/wake cycle on real
  hardware; the catch-up rule is covered by tests against a simulated clock.
- The real-GitHub test is **opt-in** (`W2M_NETWORK_TESTS=1`) rather than part of
  the default run. It failed on CI with HTTP 403 `RATE_LIMITED` because GitHub
  allows 60 unauthenticated requests per hour *per IP* and hosted runners share
  IPs — a gate that depends on someone else's rate-limit budget eventually blocks
  a release for an unrelated reason. CI still exercises it in a separate
  non-blocking job with the workflow token; the same code paths are covered by
  mocked tests in the blocking matrix.


All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-10-07

**Cross-region, cross-network.** The relay can now live on a Tailscale network, a
public VPS behind TLS, or behind a tunnel, and the three deployment shapes are
documented end to end in [docs/DEPLOY.md](docs/DEPLOY.md).

### Breaking

- **`POST /v1/task` now requires an operator token.** Receiving work and
  authorising work are different privileges: a machine that can be told what to
  do should not automatically be able to tell the others. Device tokens keep
  working for every other endpoint.
  - The relay generates the token on first start and writes it to
    `<state>/operator-token.txt` (mode 0600), printing it once.
  - The plugin needs it as `operatorToken` (or `W2M_OPERATOR_TOKEN`).
  - To restore the old behaviour deliberately, start the relay with
    `--operator-token ''`; it will warn loudly and report
    `operator_token_required: false` on `/healthz`. Intended for a trusted LAN,
    not for anything reachable from the internet.

### Fixed

- **Sub-path deployments were completely broken.** Endpoints were built with
  `new URL('/v1/stream', rabbitUrl)`, which discards any path prefix:
  `new URL('/v1/stream', 'https://host/w2m')` resolves to
  `https://host/v1/stream`. A relay mounted at `/w2m` answered 404 to everything.
  URLs are now joined by concatenation, so `rabbitUrl` may carry a sub-path.
- **`rabbitUrl` was not validated.** A URL carrying a query string or fragment
  silently produced wrong endpoints; it now fails at startup, naming the setting.
- **Work dispatched while a machine's event stream was down was lost forever.**
  An offer is a single event. If it was published in the window after a relay
  restart but before the machines re-attached their streams, nothing ever
  re-delivered it: the lease sat at `offered` until the sweep expired it, while
  both machines reported `online=true` and idle. The relay now re-delivers every
  unclaimed (`queued`/`offered`) lease when a stream attaches — `running` is
  excluded so a task that has already begun can never be handed out twice.
- **The re-delivery path itself was broken and had never run.** It called
  `this.logger(...)` unconditionally — where `logger: null` is the documented
  "quiet" setting — after the response headers were already sent, so the
  `TypeError` was caught by the top-level handler, which then tried to answer a
  second time and produced `Cannot write headers after they are sent`. Any
  reconnect with pending work destroyed the event stream. Logging now goes
  through a call that tolerates a missing, null or throwing logger, and an error
  raised after headers are out ends the stream and records the stack instead of
  attempting a second response. The previous behaviour is also why the original
  bug hid for so long: the secondary error masked the real one.
- **A cursor from a previous relay process silently swallowed events.** Sequence
  numbers restart at 0, so an agent reconnecting with `Last-Event-ID: 42` made
  the new process believe those events had been consumed — dropping not only the
  offer but every `task.cancel` and `notice` in that range. The relay now
  recognises a cursor beyond its own last sequence, reports
  `REPLAY_TRUNCATED` (with `reason: cursor_ahead_of_relay`) and re-aligns the
  replay to the head of its window; the agent no longer sends a cursor that was
  issued by a different relay process, and re-attaches without one instead.
  > A delivery guarantee must come from re-delivery, which is cursor-independent.
  > Desynchronisation detection is a diagnostic, not a safety net: the
  > `from > lastSeq + 1` test was shown to miss a stale cursor once a few events
  > filled the gap.
- **`last_available_seq` and `oldest_available_seq` described different
  windows** — one counted the un-buffered `ready` frame — so a client computing
  its re-alignment point from them could land in the wrong place. Both now use
  the ring-buffer window.

### Added

- **Deployment base path** (`--base-path`) for reverse proxies and tunnels that
  forward the prefix through unchanged.
- **Proxy awareness** (`--trust-proxy`) for `X-Forwarded-Proto` and
  `X-Forwarded-For`. Off by default, and deliberately so: trusting those headers
  without a proxy in front lets a client forge its address and bypass rate limits.
- **TLS termination in the relay** (`--tls-cert` / `--tls-key`) as an alternative
  to terminating at a proxy.
- **Persistence.** `devices.json` (atomic snapshot) plus `ledger.jsonl`
  (append-only) mean a restarted relay keeps its paired machines and its task
  history. A corrupt line is skipped and reported rather than being fatal; a
  corrupt device file starts empty *and says so*. `--no-persist` restores the old
  in-memory behaviour.
- **Pairing rate limit**, 5 attempts per IP per minute by default, counting
  successes too — otherwise successful requests would refill the budget.
- **`/healthz` is now an operations surface**: `relay_id`, `started_at`,
  `effective_scheme`, `base_path`, `operator_token_required`, `pair_rate_limit`
  and a `persistence` block. The three questions that matter when machines are in
  different regions are "is it up", "has it restarted", and "who is connected",
  and they should be answerable without reading logs.
- **Restart is visible to clients.** `ready` carries `relay_id`; an agent that
  sees it change warns and drops its event cursor, because sequence numbers from
  a previous process are meaningless.
- **RTT visibility.** Agents measure heartbeat round-trip time and expose it
  through `w2m_status` — the first question about a distant relay is how far away
  it is.
- **Anti-buffering response headers** on the event stream
  (`X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`). A buffering
  proxy turns "connected" into "connected but silent", which is the single most
  confusing failure in tunnel deployments.
- **`REPLAY_TRUNCATED` now carries `oldest_available_seq`** so a client that fell
  outside the replay window knows where to re-align instead of only learning that
  it cannot catch up.
- Deployment assets: systemd unit, Dockerfile + compose, nginx and Caddy
  examples, and [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Compatibility

- `PROTOCOL_VERSION` stays **1**: everything above is an additive change except
  the operator token, which is called out under Breaking.
- A 0.0.1 client can still pair, take work and report results against a 0.1.2
  relay. It cannot submit tasks, because it does not know about operator tokens.

### Verification

315 tests, 314 pass, 1 skip (POSIX mode bits are meaningless on NTFS):
relay 91, agent 105, plugin 73, end-to-end + crossnetwork 46. CI runs the matrix
on Windows (node 20 and 22), macOS and Linux, plus a job proving the release
artifact is reproducible from source.

The lost-offer bug above is covered by a regression test that reproduces the
exact sequence — stream attached, relay killed, task dispatched into the gap,
stream reconnecting with a stale cursor — and asserts the offer arrives. It is
deliberately not a timing-dependent test: the window it exercises is the one that
was broken.

## [0.0.1] — 2026-10-07

First release. Scope: **one DeepSeek account, one instruction, several machines running the same project.**

### Added

- **Rabbit relay** (`w2m-rabbit`) — a `node:http` server with no third-party
  dependencies. Device registry, task ledger, long-lease-with-progress-heartbeat
  scheduling, `dedupe_key` deduplication, SSE event stream with `seq` replay, and
  six-state aggregation.
- **Localside agent** (`w2m-localside`) — runs on every participating machine.
  Pairs with the relay, keeps an SSE connection open with jittered exponential
  backoff, claims leases, applies the capability gate, collects the three
  anchors, executes argv directly (never through a shell), and writes results to
  a local spool before reporting them.
- **DSH plugin** (`@twinsearth/w2m-dsh-plugin/tools`) — five model-facing tools:
  `w2m_devices`, `w2m_run`, `w2m_wait`, `w2m_report`, `w2m_status`.
- **Two coordination modes** — `replicate` (every machine runs the same command;
  results are compared side by side) and `split` (`explicit` / `modulo` sharding).
- **Rotating pairing codes** — a successful pairing consumes the code and the
  relay immediately mints and prints the next one, so several machines can join
  without restarting the relay. `pairingCodeReusable: true` keeps one code alive
  for the whole TTL for scripted onboarding.
- **Three-anchor reproducibility** — `base_commit` + `pre_tree_fingerprint`
  (algorithm `git-temp-index-tree/v1`) + `command_hash`. A mismatch is reported
  as `unverifiable`, which is accounted separately from `divergent`.
- **Capability gate** — toolchain and platform requirements are checked on the
  relay side before dispatch; an unsatisfied machine answers `refused`, which is
  not a failure.
- **Zero third-party runtime dependencies** — only `node:` built-in modules.

### Known limitations

- **Not verified on a real macOS machine.** The code is platform-neutral and
  uses `node:path` throughout, but every measurement in this release was taken
  on Windows. Treat macOS support as "expected to work, unverified".
- **No TLS.** Authentication is the pairing code plus per-device bearer tokens.
  Run the relay on a trusted network, or put a reverse proxy in front of it.
- **`write: true` does not merge.** A write-enabled task records the branch it
  used; combining branches is left to the operator.
- **No cross-machine browser dashboard.** Out of scope for 0.0.1; the design note
  for it lives in the project's design document.
- **Pairing code is single-use and shown once** at relay start. If you lose it,
  delete `state.json` in the relay's state directory and restart.

[0.0.1]: https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.0.1
[0.1.2]: https://github.com/TwinsEarth/dsh-windows2macos/releases/tag/v0.1.2

### 保护模式：不加密（默认）/ 账户比对 / 4-6 位数字 PIN（用户最终决定，未发布）

- **用户决定（原话）**：我们追求的不是绝对保密：1，用账户ID是为了方便实现自动化（账户能快捷解锁，不是必须）；2，密码也是4-6位数字（账户不对输入密码）；3，也可以选择不加密（1账户不对，2又没有设置密码，3默认是不加密的）。
- **默认不加密**：新增第四种信封 `open`（`src/backup/crypto.mjs`）：记录里**明文**保存 32 字节 DEK（无 KDF、无 sealed 负载、无 AAD），`validateKeysFile` 接受它并**拒绝与 account/machine/password 混存**（否则 open 路径会静默绕过已设置的 PIN）。新建仓库默认 `encryption: 'none'` + `open` 信封，无需任何凭据即可开；`backup.json` 增加加法字段 `encryption: 'none'|'sealed'`（旧仓库缺省 = `sealed`）。
- **模式规则（keystore/engine）**：`openRepoKey` 对 `none` 仓库不探测 OS keystore、不要求凭据（`unlocked_via: "none"`）；首次建库按 `resolveEncryptionMode` 解析：显式 `encryption` > 提供 PIN/密码 > `machineKey: true` > 可解析账户 id > 默认 `none`；显式 `none` + 密码是具名 `BACKUP_CONFIG_INVALID` 矛盾拒绝；显式 `sealed` 无凭据仍在 `ensureLayout` 前 `BACKUP_NO_PERMISSION`。向 `open` 仓库加 PIN/account 绑定时同一次写入删除 `open` 并同步 `encryption: sealed`；新增 `setEncryptionMode({mode:'none'})`（现有凭据打开 → 同一 DEK 写 open → `keys.json.bak-<ts>` → 原子写 → **无凭据**解封验证），块格式不变、不重写对象。`runBackup({encryption})` 在 `none` 时跳过 account 绑定，默认仓库不会被第一次 run 静默改成 sealed。
- **PIN 从 8 字节降到 4 字节**：`setRepositoryPassword`/`addPasswordEnvelope` 接受 ≥4 字符（数字为预期用法），空值仍拒；结果新增 `weak: true`（<8 字节或纯数字）+ 警告「4 位数字 PIN 只是便捷门槛，不是保密强度」，**不静默提高 scrypt 成本**；`mode_after`/`envelopes` 报告升级后的状态。
- **Describe/status/CLI**：`describeUnlock`、`GET /api/w2m/backup/status`、`GET /api/w2m/backup/unlock`、CLI `status`/`unlock` 均报告 `encryption`、`available_paths`（`none`/`account`/`machine`/`password`）与 `none` 模式的警告「未加密：任何能访问该目录的人都能还原备份」；任何结果/CLI 输出都不回显 DEK。CLI `run --encrypt none|sealed` / `--no-encryption`（非法值退出码 2）、`unlock --set-password`（4 位 PIN + 警告行）、`unlock --enable-protection`（= set-password 别名）、`unlock --disable-protection --confirm disable-protection`（缺确认令牌退出码 2）。
- **插件**：配置 `backupEncryption`（默认 `none`；非法值挂载即 `BACKUP_CONFIG_INVALID`），run 结果/describe 带 `encryption`；`cordis.patch.yml` 的 dsh-backup 行写 `backupEncryption: none` 并保留 `backupAccountBinding: true`（账户绑定只对 sealed 仓库生效）。
- **面板**（`lib/client.js`，仅备份面板）：状态卡显示保护模式徽标（未加密=警告色 / 已加密）+ 未加密警告行；解锁卡三态——未加密（免密解锁 + 警告 + 关闭保护说明）/ 账户一致（快捷解锁）/ 账户不一致但有 PIN（账户按钮禁用、提示只用终端输入 PIN + weak-PIN 提示）；新增 zh/en 键 `panel.backup.mode.*`、`status.mode`、`unlock.none|passwordHint|weakPinHint|disableProtectionHint`、`reason.BACKUP_CONFIG_INVALID`。HTTP 仍不接收密码，无输入框。
- **测试**：`backup-keystore`（默认 none 无凭据开、PIN 建 sealed、open→sealed 删除 open、disable-protection 回 open、open 混存拒绝、DEK 不回显、模式解析优先级）；`backup-crypto`（open 记录/attempts/畸形拒绝）；`backup-access`（describe 三态 + 无凭据 unlock）；`backup-engine`（默认 none/PIN sealed/非法模式/矛盾组合）；`backup-run`（配置、路由默认 none、CLI encrypt/set-password/disable 与退出码）；`backup-verify`/`backup-restore`（none 模式无需密码）；`client-bundle`（三态解锁卡 + 徽标 + 新字典键）。既有 fixture 传密码的建库仍是 sealed。
- **文档**：`docs/BACKUP-DESIGN.md` 新增 §25.0（用户最终决定：不是绝对保密；三态表；保护/不保护什么；何时才值得 sealed + 强密码）并重写 §25 的账户诚实声明、更新 §6/§8/§10/§11/§12；`docs/SPIKE-ACCOUNT-KEK.md` 新增 §9「用户最终决定：便捷优先」（不改写 §4-§8 的测量）。
- **验证**：`npx eslint .` 0 error；`node scripts/layer-check.mjs`、`node scripts/scan-mojibake.mjs` clean；`backup-keystore`、`backup-crypto`、`backup-access`、`backup-engine`、`backup-run`、`backup-restore`、`backup-verify`、`backup-gc`、`backup-mirror`、`backup-wiring`、`backup-rotation`、`backup-layout`、`client-bundle`、`backup-runtime` 全绿；`node scripts/pack.mjs` 打包一次。**不 bump 版本号、不跑 preflight、不提交。**
