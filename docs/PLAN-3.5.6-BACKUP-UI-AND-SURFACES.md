# 3.5.6 方案（待审批）：归档备份子插件 UI + 子插件启用状态与侧边栏同步

> 状态：**已实现（3.5.6），发布由发布步骤完成**。按约定流程：先方案 → 审批 → 开发 → 再等明确指令打包/发布。
> 目标版本：3.5.6（若与其它改动合并再议）。

## 0. 背景（两个待办）

1. `@twinsearth/w2m-dsh-plugin/dsh-backup-plugin`（六个 `backup_*` 工具的归档子插件）**目前没有操作界面**：
   它只挂工具面（status/list/create/verify/restore/import_session_zip），没有面板路由、没有侧边栏入口。
   现在只能由 Agent 在会话里调用这六个工具（或直接调模块），普通用户无从点选。
2. `@twinsearth/w2m-dsh-plugin/desktop`、`/gpw`、`/dsh-backup` 三行**未启用时，左侧栏按钮仍然显示**；
   要求"未启用→隐藏，启用→出现"。

## 1. 现状核查（设计依据）

| 事实 | 位置 |
|---|---|
| 备份面板的侧边栏条目与 main 页**无条件注册**；面板自己探测备份路由 404 后在页内显示"备份子插件未启用" | [lib/client.js:9677](../lib/client.js#L9677)（注释明确写了这个取舍） |
| GPW 同样无条件注册（输入框左侧浮钮 + 侧边栏图标 + main 页） | [lib/client.js:9640](../lib/client.js#L9640) |
| `dsh-backup` 行挂载 `/api/w2m/backup/*` 路由；`dsh-backup-plugin` 行**只挂工具**、无路由 | [src/plugin/backup.mjs](../src/plugin/backup.mjs)、[src/plugin/backup-plugin.mjs](../src/plugin/backup-plugin.mjs) |
| 当前真实 profile：`dsh-backup` disabled、`dsh-backup-plugin` enabled、`dsh-gpw` active、`dsh-desktop` disabled | `profiles/desktop/cordis.patch.yml` + plugin manager |
| 客户端是**单 bundle**（每包一个 client 模块），不能按行加载/卸载 | `package.json#dsh.client`、`lib/client.js` |

结论：问题 2 不是"注册错了"，而是**注册时机太早、可用性发现太晚**；问题 1 是**只做了工具面，没做界面**。

## 2. 工作流 A：归档备份子插件 UI（六个工具 → 可点的面板）

### 2.1 可选方案

| 方案 | 内容 | 优点 | 代价 |
|---|---|---|---|
| **A1（推荐）** | 把「归档」并入现有「备份&还原」面板：当归档行可用时，面板多一个「归档」tab（列表/创建/校验/恢复/导入 ZIP），未启用时该 tab 不出现 | 不新增侧边栏按钮；复用现有面板骨架、确认令牌、pre-restore 展示；与问题 2 的"按需出现"一致 | 需要归档行新增 `/api/w2m/backup/archive/*` 路由（或在 root 行统一代理） |
| A2 | 独立侧边栏入口「归档备份」+ 独立 main 页 | 与 GPW/备份同构，改动局部 | 多一个常驻按钮（与问题 2 的诉求相反），面板代码重复 |
| A3 | 不做 UI，只补文档 + 一个 CLI 子命令（如 `w2m-backup archive …`） | 最省 | 普通用户仍无法使用；不满足"该怎么使用" |

**推荐 A1**，并把 A3 作为附带交付（CLI 便于自动化/排障）。

### 2.2 A1 设计要点

- **路由**（由 `dsh-backup-plugin` 行自己挂，行未启用则自然 404）：
  - `GET /api/w2m/backup/archive/status` → 配置 + 归档根 + 数量 + 最新归档（只读）
  - `POST /api/w2m/backup/archive/create`（含 `dry_run`）
  - `POST /api/w2m/backup/archive/verify`（`archive`）
  - `POST /api/w2m/backup/archive/restore`（`mode=plan|apply`、`confirm="restore"`、`targetProject`、`includeSessions/includeProfile`、`overwrite`）
  - `POST /api/w2m/backup/archive/import-zip`（上传或服务器路径）
  - 鉴权沿用现有面板路由的 guard（与 `/api/w2m/backup/*` 同一套）。
- **面板**：`BackupPanelView` 增加 `mode`/tab 参数；新增 `ArchiveBackupView`（列表 + 创建表单 + 校验结果表 + 恢复计划/确认 + 导入 ZIP 选择器）。
  未启用：tab 隐藏（依赖工作流 B 的可用性探测），而不是显示"未启用"占位。
- **安全语义复用**：`confirm:"restore"` 才能 apply；覆盖前 pre-restore 副本；`forceRunning` 只在 `keepIds` 冲突时替换并保留旧会话目录。
- **验收**：路由单测 + 面板组件单测 + 真实页面回归（loader-entry 真实 GUI 驱动：无该行→无 tab；启用→tab 出现；create→verify→restore plan/apply→import 全链路）；`client-budget` 预算内；pre-flight 绿。

## 3. 工作流 B：子插件启用状态 ↔ 侧边栏按钮同步

### 3.1 可选方案

| 方案 | 内容 | 评价 |
|---|---|---|
| **B1（推荐）** | 每个 UI 行提供轻量 `GET /api/w2m/<row>/health`（200 = 行已挂载）；客户端启动时并行探测，仅对 200 的项注册侧边栏条目；`visibilitychange` + 30 s（仅页面可见时）复探，做注册/注销差分 | 无新跨行服务依赖；探测失败有明确降级 |
| B2 | root 行新增 `/api/w2m/surfaces`，通过 Cordis 可选注入汇总各行服务 | 一次请求拿全量，但要给每行加服务并验证 DSH 的可选注入能力，改动更大 |
| B3 | 保留常驻按钮，但禁用/置灰 | 不满足"隐藏"要求 |

**推荐 B1**：改动小、失败可见（每个行自己答"我在"），且不需要 root 行知道其它行。

### 3.2 B1 设计要点

- 探测：`GET /api/w2m/gpw/health`、`/api/w2m/desktop/health`、`/api/w2m/backup/health`（404/超时/401 均视为不可用；401 视为**可用但需授权**，按各面板原有策略）。
- 注册策略：`available` 的集合驱动 `slots.register`；集合变化时**注销旧条目**（slots dispose）再注册新高，页内 main 条目同 key 同步；避免重复 id。
- 首次渲染：先不注册（避免"闪一下又消失"），探测完成后再出现；探测总超时 800 ms。
- 降级：探测全部失败（例如旧宿主无 health 路由）→ 回退到**当前行为**（常驻 + 面板内"未启用"提示），并在 `window.__W2M_SURFACES__` 暴露诊断（`{ok, available, probedAt, reasons}`）。
- 兼容：`desktop` 若没有侧边栏条目，则只控制其面板/入口（实施前先审计 desktop 的 client 入口）。
- 验收：真实页面测试（行禁用→无侧边栏条目；启用→复探后出现；再禁用→消失；health 全挂→回退常驻 + 诊断对象）；单元测试用注入的 fetch 覆盖差分注册/注销。

## 4. 实施顺序与工作量（审批后）

| 阶段 | 内容 | 预估 |
|---|---|---|
| 0 | 审批本方案、确认 A1/B1、确认版本号（3.5.6） | — |
| 1 | 工作流 B（小）：health 路由 × 3 + 客户端差分注册 + 诊断 + 真实页面测试 | 0.5 天 |
| 2 | 工作流 A 后端：归档行 5 条路由 + 鉴权 + 单测 | 1 天 |
| 3 | 工作流 A 前端：ArchiveBackupView + tab 接入 + 预算守卫 | 1 天 |
| 4 | A3 CLI 子命令（附带） | 0.5 天 |
| 5 | 全量验收：preflight、真实页面、验收记录 | 0.5 天 |
| 6 | **等待明确指令**：打包 / 发布 / 升级真实 profile | — |

## 5. 风险与边界

- 单 bundle 无法按行加载：可用性只能"探测 + 条件注册"，bundle 体积不变（仍受 `client-budget` 守卫）。
- 探测失败必须降级到现状，不能让"探测挂了"变成"所有按钮消失"。
- 归档行的恢复会写 `$DSH_HOME`：沿用 confirm/pre-restore 语义；profile 覆盖仍需显式 `includeProfile`。
- 本方案不触碰 registry 写入路径：归档恢复的注册表写入必须走 `src/backup/registry.mjs` 的读回协议
  （见 `docs/WORKSPACE-REGISTRY.md`），本次事故的教训写进实施检查单。

## 6. 需要你审批的决策点

1. 工作流 A 选 **A1（并入备份面板的「归档」tab，推荐）** 还是 A2（独立侧边栏）/ A3（只做 CLI）？
2. 工作流 B 选 **B1（每行 health 探测 + 条件注册，推荐）** 还是 B2（root 汇总 `/api/w2m/surfaces`）？
3. 版本号：单独 **3.5.6**，还是并入下一个功能版本？
4. 是否附带 A3 CLI 子命令（`w2m-backup archive …`）？
5. 是否同意"实施完成后**不自动打包/发布**，等你的明确指令"？（默认按此执行。）

## 7. 3.5.6 修订（surface 语义修正）

发布后核查发现实现与 §3.2 的表述不一致，按修正后的语义实现；上文的原始设计保留原样，不改写历史：

- **401 不再视为"可用但需授权"**。真实宿主的认证网关在路由之前就回答了 401/403，所以它们与 404、其它状态码
  一样是"确定不可用"；只有超时/网络错误才是不可判定。六个探测全部不可判定时才回退旧行为（§3.2 的降级规则
  本身不变，变的是"什么算一次有效回答"）。
- **surface 从四个扩展到六个**：gpw / backup / desktop / archive / 队列日志 / 决策中心。队列日志的
  chip + 抽屉 + 侧栏降级面、以及决策收件箱浮标，也由同一本 surface book 按行挂载/卸载（此前它们无条件挂载，
  所以行被 `disabled: true` 时 UI 仍然出现）。
- `window.__W2M_SURFACES__` 现为 `{ok, available, reasons, definite, probeBlocked, probedAt, fallback}`；
  只有"完全没有回答"才回退，`fallback:true` 因此只对应旧宿主或网络故障。

修正后的完整契约、逐行 UI 表与排障读法见 [SURFACES.md](SURFACES.md)。
