# 表面（surface）与启用状态：一份契约

> 适用范围：`lib/client.js` 的客户端 surface book + 各宿主行自己的 `/health` 路由。
> 单测：`test/client-bundle.test.mjs`（探测契约、六表面矩阵、挂载/卸载差分）；
> 宿主：`test/backup-wiring.test.mjs`、`test/queue-journal.test.mjs`、`test/decision-routes.test.mjs`；
> 真实页面：`test/loader-entry.test.mjs`（含 `W2M_SURFACES_PROBE` / `W2M_DECISION_PROBE` / `W2M_BACKUP_PROBE`）。

## 1. 为什么需要探测

客户端是单个 bundle（每个包一个 client 模块），不能按行加载；但每个 UI 行的宿主行可以独立启用/禁用。
"这一行在不在"只能由宿主回答：每行一个只读 `GET /api/w2m/<row>/health`，客户端启动时并发探测，按结果
注册/注销该行的 UI。探测只做这一件事，不存在第二条健康检查通道。

## 2. 探测契约

| 宿主回答 | `available` | `reason` | 确定答案 |
|---|---|---|---|
| 2xx（含 204） | `true` | `ok` | 是 |
| 401 / 403 | `false` | `unauthorized` | 是 |
| 其它状态码 | `false` | `http-<status>`（如 `http-404`） | 是 |
| 超时 | `false` | `timeout` | **否** |
| 网络/传输错误 | `false` | `network-error` | **否** |

- 六个探测共用一个 **800 ms** 预算（并发），`GET`、`credentials: 'same-origin'`、`accept: application/json`。
- **401/403 绝不等于"已挂载"**。真实宿主的认证网关在路由之前就回答 401（未认证时连
  `/api/w2m/nonexistent-xyz` 也是 401）。把 401 当可用会让每个已禁用行都注册 UI——这正是 3.5.6 的
  "禁用行仍然显示"缺陷。认证被挡时正确的行为是**全部隐藏**并留下 `probeBlocked:true`。
- 页面可见时每 30 s 与 `visibilitychange` 复探；只对结果做差分，已挂载的表面不会被重挂（无闪烁、无重复 id）。

## 3. 回退规则

`fallback:true` **仅当六个探测一个都没有得到回答**（全部 `timeout` / `network-error`）。此时退回 3.5.5 的
常驻行为：全部注册，面板内提示"未启用"，因为旧宿主没有 health 路由，探测失败不能把还能用的按钮弄没。
`fallback:false` 表示至少有宿主给了一个确定答案，未启用行保持隐藏；因此下列情况**都不回退**：

- 全部 401/403（认证挡住了探测）；
- 全部 404（行都未启用）；
- 401 与 404 混合（都是宿主的确定答案）。

## 4. 逐行 UI 表

六行各有自己的 health 路径，由该行自己的 `apply` 注册（行未挂载时没有这条路由，客户端读到的就是 404）：

| 行 | health 路径 | 该行拥有的 UI | 挂载方式 |
|---|---|---|---|
| `dsh-gpw` | `/api/w2m/gpw/health` | 输入框左侧 GPW 浮钮、侧边栏图标、main 页 | 槽位条目（`slots.inject`/`register` 的 disposer） |
| `dsh-backup` | `/api/w2m/backup/health` | 备份面板侧边栏图标、main 页 | 槽位条目 |
| `dsh-desktop` | `/api/w2m/desktop/health` | 远程桌面侧边栏图标、main 页 | 槽位条目 |
| `dsh-backup-plugin` | `/api/w2m/backup/archive/health` | 没有自己的入口：它是备份面板里的「归档」tab；行可用时备份面板因此可进入 | 只影响 `backup` 面与 tab 可用性 |
| `dsh-queue-journal` | `/api/w2m/composer/journal/health` | composer chip（`conversation.input.left`）、抽屉（`shell.overlay`）、侧栏降级面（`sidebar.panellist`，id `w2m-queue-journal`） | 自定义挂载：`createQueueJournalModule().apply(ctx)`；apply 返回注销全部座位的 disposer |
| `dsh-decision-center` | `/api/w2m/decisions/health` | 右侧决策收件箱浮标 + 抽屉（DOM 直挂） | 自定义挂载：`mountW2mDecisionCenterUI()`；返回自己的 disposer |

surface book（`w2mSurfaceSpec` / `syncW2mSurfaceEntries`）同时支持"槽位条目数组"和"返回 disposer 的
mount 函数"；差分是幂等的：行从可用变不可用时调用 disposer，行反复复探不会重复注册。

备份面板的标签：只有归档行可用、`dsh-backup` 未启用时，侧边栏图标与页面标题读 **「归档备份」**；
`dsh-backup` 可用时保持 **「备份&还原」**（读的是已发布的 surface 状态，不新增路由）。

## 5. 排障：`window.__W2M_SURFACES__`

```js
window.__W2M_SURFACES__
// { ok, available, reasons, definite, probeBlocked, probedAt, fallback }
```

| 观察到的值 | 含义 | 该做什么 |
|---|---|---|
| `reasons` 全 `unauthorized`，`probeBlocked:true`，`fallback:false` | 认证网关在路由之前拦下了探测（页面会话失效或请求没带凭据） | 先修认证/会话，不要以为行没启用；UI 隐藏是这条规则的正常结果 |
| `reasons` 全 `timeout`/`network-error`，`fallback:true`，`definite:false` | 旧宿主（没有 health 路由）或探测整体失败 | 回退行为已生效（全部常驻）；升级宿主后复探 |
| `reasons` 全 `http-404`，`fallback:false` | 这些行确实未启用 | UI 隐藏是正确结果；去插件管理器启用对应行 |
| 某个 key `available:true`，`reasons[key] === 'ok'` | 该行已挂载 | 对应 UI 应出现 |
| `probedAt` | 最近一次探测时间（ISO 字符串） | 结合 30 s 复探判断"刚改完还没复探" |

`definite` 表示"至少有一个探测拿到了确定答案"（`fallback` 是它的反义），逐行的确定性看 `reasons`：
`timeout`/`network-error` 才是不可判定。

## 6. 验证与预算

- 单测用注入的 fetch 覆盖六表面矩阵：单行可用只出现该行 UI、全 404 全隐藏、全 401 全隐藏且
  `probeBlocked:true`、全超时才 `fallback:true`、混合 401/404 不回退、加载后启用/禁用按差分出现/消失、
  归档行单独可用时标签为「归档备份」。
- 真实页面（`test/loader-entry.test.mjs`，都需要真实安装，缺安装时如实 skip）：三个 opt-in 开关先在**安装副本**
  的 bundle patch 里启用自己驱动的行，再从页面测量。`W2M_SURFACES_PROBE=1` 启用归档行（其余行保持禁用，因此
  与另外两个开关互斥）；`W2M_DECISION_PROBE=1` 启用 GPW + 备份行；`W2M_BACKUP_PROBE=1` 启用备份行（归档行
  保持禁用，探针据此断言没有归档 tab）。启用备份行的探针会把该行的 `backupDir` 指到 throwaway home 内的仓库，
  点「运行/归档」不会写到操作者的真实仓库；测完安装副本与 home 一起被丢弃。
- `lib/client.js` 受 `test/client-budget.test.mjs` 约束（字节 / 行数 / 单函数行数）；加表面要同步压注释，
  不要抬预算。
