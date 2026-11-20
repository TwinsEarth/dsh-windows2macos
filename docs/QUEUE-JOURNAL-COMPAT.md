# 队列日志兼容说明（v3.6.1）

> 适用包：`@twinsearth/w2m-dsh-plugin` 的队列日志子插件（宿主 `src/queue-journal/`，客户端 `lib/client.js`）。
> 目标：DSH 升级后即使布局/插槽改名，队列日志也不会“静默消失”，而是**显式降级或显式警告**，
> 并给出可复现的升级检查步骤。

## 1. 两套表面与候选链

| 表面 | 候选链（按顺序尝试，第一个被接受者生效） | 说明 |
|---|---|---|
| chip（常驻入口） | `conversation.input.left` → `conversation.composer.dock` | `kind:list`、`scope:session`；本插件的历史对话、Node 执行开关已在该席位。slot 的 standard props 带 `useInput` / `inputActions` / `sessionId`。 |
| drawer（抽屉） | `shell.overlay` → `shell.bottom` | `kind:list`、`scope:root`，frame-wide floating layer；所有列之上、滚动容器之外。 |
| 降级入口（最后手段） | `sidebar.panellist` | 与备份面板同构的稳定表面；id `w2m-queue-journal`，与 Ops 面板的「消息与草稿」页共用同一 store，并显示「降级模式」。 |

候选链**只有一条列表、一个定义处**：`lib/client.js` 里的 `JQ_CHIP_SLOT_CANDIDATES` 与
`JQ_OVERLAY_SLOT_CANDIDATES`。`apply()` 按顺序调用 `ctx.slots.inject`，每次尝试都写进诊断的
`slotAttempts`（见 §2），第一个被接受的候选就是 `surface`；全部落空才注册 `sidebar.panellist` 降级面。
**不要**在别处硬编码插槽名。

为什么 chip 的第二候选是 `conversation.composer.dock`：它是 composer 卡片下方的 **ambient** 条目，被输入统计
（ActivityPill/UsagePill）占用，语义不如 `input.left` 精确；但 `input.left` 被改名/删除时，它比“什么都不显示”好。

主面**不再**向 `document.body.append`：drawer 由 overlay 插槽的 React 条目渲染；`findComposer()` 的
DOM 面积启发式只在 slot props 缺失时作为兼容分支使用，且一经使用就会写入诊断
（`dom-composer-fallback:*`）并打一次 `console.warn`。

## 2. 诊断对象

页面全局对象（每个已挂载的页面都有）：

```js
window.__W2M_QUEUE_JOURNAL__ = {
  status: 'slotted' | 'unverified' | 'fallback' | 'disabled',
  surface: 'conversation.input.left+shell.overlay' | 'conversation.composer.dock+shell.overlay'
         | 'conversation.input.left+shell.bottom' | 'sidebar.panellist' | null,
  reasons: string[],
  slotAttempts: [{ slot: 'conversation.input.left', ok: true, reason: 'accepted' }, …],
  dshVersion: '0.2.2-rc.5' | null,
  checkedAt: '2026-11-19T13:00:00.000Z',
}
```

状态互斥，优先级 `disabled` > `fallback` > `unverified` > `slotted`：

| status | 含义 | UI |
|---|---|---|
| `slotted` | chip 与 drawer 都接受注册，且 DSH 版本在测试范围内（版本读不到 = unknown 也归这里） | 正常 |
| `unverified` | 两个主面都接受注册，但 DSH 版本在测试范围外 | **仍渲染**：抽屉内一行通知（`data-w2m-jq-status="unverified"`，含检测到的版本与测试范围），chip 的 `data-w2m-jq-status` 与 tooltip 同样标记；只打一次 `console.warn` |
| `fallback` | 至少一个主面的候选链全部失败；同一套 UI 已在 `sidebar.panellist` 出现 | 「降级模式」通知（`data-w2m-jq-status="fallback"`），可打开抽屉；宿主读取失败时同一通知里附一行原因 |
| `disabled` | 连 `slots` 服务都没有（页面本身不完整） | 队列日志不可见，但不会让页面启动失败 |

`slotAttempts` 的元素固定为 `{slot, ok, reason}`：`ok:true` 时 `reason:'accepted'`（降级面是
`'degraded-fallback'`），`ok:false` 时 `reason:'inject-threw:<message>'`。每个候选都会出现在这里，
所以“为什么没挂上”不需要翻控制台。

常见 `reasons`：

| 值 | 含义 |
|---|---|
| `slot-inject-threw:<slot>:<message>` | `ctx.slots.inject` 对该候选抛错（通常是改名/删除）。 |
| `slot-missing:<c1>/<c2>` | 某条候选链全部失败（消息里按顺序列出所有候选）。 |
| `slot-not-declared:<slot>` | 2.5 秒内 slot 未声明，而页面上已有 composer（改名后的静默失败）。 |
| `slot-register-threw:<slot>:<message>` | `inject` 回调里的 `register` 抛错。 |
| `input-actions-missing` | 插槽存在，但 props 没有 `InputActions.setDraft`；chip 仍可见，恢复走诊断过的 DOM 分支。 |
| `slots-service-incomplete` | 上下文没有可用的 `slots.inject` / `slots.register`。 |
| `dsh-version-unavailable` | 页面启动图与 `modules` 服务都没有发布 release 版本（= unknown，不是失败）。 |
| `dsh-version-unverified:<v> (tested …)` | 版本可读但不在测试范围内；保留主面并显示通知。 |
| `dom-composer-fallback:draft-read` / `:queue-read` / `:draft-write` | 使用了兼容 DOM 分支（只应在旧宿主或 chip 尚未挂载时出现）。 |

宿主数据/读取失败在 UI 的错误行里：`jqFailureReason` 把 `路由缺失（404）`（宿主没挂载路由）与
`宿主错误（HTTP <status>）`（路由在、读取失败）分开，并在后者附带诊断路由的可用性
（条目数 / 目录可写性 / 最近错误）。诊断只在**既有刷新失败**时探测一次，没有新增轮询。

## 3. 测试范围、版本来源与升级验证

客户端常量 `JQ_TESTED_DSH_RANGE = '>=0.2.2-rc.1 <0.3.0'`（`lib/client.js`，模块上也以
`TESTED_DSH_RANGE` 导出）。版本来源按顺序：

1. `window.__DSH_BOOT__.release.version` —— DSH 客户端模块系统写进页面的 WebBootGraph
   `{ rev, release: { version, commit? }, entries, batches }`；`@deepseek-ai/dsh-client-modules`
   自己的 `parseBootManifest` 就校验这个字段，所以它是页面里唯一的权威来源。
2. 读不到时退回 `ctx.get('modules').manifest.release.version`（同一 manifest 的浏览器侧副本）。

两者都读不到 = `unknown`（`dshVersion: null` + `dsh-version-unavailable`）：**不**降级、**不**隐藏 UI；
`unverified` 只用于“版本可读且在范围外”。

**升级后如何放宽范围**（顺序不能省）：

1. 用新 DSH 启动真实页面；
2. 控制台读 `window.__W2M_QUEUE_JOURNAL__`：应为 `unverified`（旧范围），`slotAttempts` 里第一个候选
   `ok:true`；`surface` 仍是 `conversation.input.left+shell.overlay`；
3. 跑真实页面探针（见下）——`W2M_QUEUE_JOURNAL_PROBE=1` 把 `status === 'slotted'` 当硬断言，
   所以先看它为什么不是 `slotted`；
4. 确认抽屉/降级横幅/恢复动作都正常（探针已覆盖 chip 在 composer、草稿落盘、抽屉列出、恢复写回）；
5. 以上全部通过后，才把 `JQ_TESTED_DSH_RANGE` 改成新范围，并更新本文（版本号/CHANGELOG 由发布者改）。

范围放宽与“修好插槽”是两件事：如果 `status` 是 `fallback`，先修候选链；**不要**用放宽范围掩盖降级。

精确命令（不需要 Chromium 也会跑完其余部分；没有浏览器时真实页面项按既有模式 skip 并给出原因）：

```sh
node --test --test-force-exit test/queue-journal.test.mjs test/client-bundle.test.mjs test/client-budget.test.mjs test/loader-entry.test.mjs
```

真实页面探针（需要 Chromium/Edge；`W2M_DSH_BROWSER=<path>` 指定，`W2M_DSH_BROWSER=none` 关闭）：

```sh
# PowerShell
$env:W2M_QUEUE_JOURNAL_PROBE='1'; node --test --test-force-exit test/loader-entry.test.mjs
```

探针会断言：chip 在 composer 中、`window.__W2M_QUEUE_JOURNAL__.status === 'slotted'`、
`slotAttempts` 按顺序记录且两个首选候选都被接受、抽屉里没有 `unverified` 通知、输入草稿后宿主
`$DSH_HOME/xclient/queue-journal/composer-journal.json` 里出现该草稿、`shell.overlay` 抽屉列出该记录、
恢复按钮把草稿写回输入框、宿主 `GET /api/w2m/composer/journal/diagnostics` 返回固定形状。
任一项失败即升级不可直接发布。

## 4. 宿主诊断路由

```
GET /api/w2m/composer/journal/diagnostics
  -> 200 { ok: true, dir, entries, lastWriteAt, writable, errors }
```

* `dir`：数据目录（默认 `$DSH_HOME/xclient/queue-journal`）。
* `entries`：`ComposerJournal.list()` 的记录数（损坏文件时是 0，错误见 `errors`）。
* `lastWriteAt`：目录内**最新文件的 mtime**（ISO 字符串；空目录/无文件为 `null`）。
* `writable`：尽力而为的写权限探测，**不创建任何文件或目录**——对数据目录（尚未创建时对最近的已存在祖先）
  做 `W_OK`，路径上若是普通文件则 `false`。
* `errors`：最近一次 store 读取错误（`journal-unreadable` / `journal-history-unreadable`），无错误为 `[]`。
* 鉴权与其余队列日志路由一致：`fangAuthToken` 配置了就必须带 `x-fang-auth`，否则 401。
* 损坏文件/缺失目录都**不**改变状态码：路由始终 200（`ok:true`），错误在 `errors` 里按名报告；
  这样“读失败”本身可诊断，而不会让诊断路由先倒下。

## 5. DSH 改了 slot 名字怎么办

1. 在 `lib/client.js` 里**只改一处**：`JQ_CHIP_SLOT_CANDIDATES` 或 `JQ_OVERLAY_SLOT_CANDIDATES`
   （`JQ_FALLBACK_SLOT = 'sidebar.panellist'` 是稳定降级面，通常不动）。把新名字放进候选链的正确位置，
   旧名字可保留在后面作为后续候选。slot 事实从已安装的 DSH 读取：
   `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 内的 slot 表，或 Inspect 的 `Slots.listSubTree`。
2. 跑 §3 的精确命令；`client-bundle` 的候选链测试会因 `slotAttempts`/`surface` 变化失败，
   `loader-entry` 的 `W2M_QUEUE_JOURNAL_PROBE` 会因真实页面 `status`/`surface` 不符而失败——
   这就是“升级不能静默通过”的守卫。
3. **不要**为了绕过失败去恢复 `document.body.append` 或 `findComposer()` 主路径；降级面已经保证功能
   可见，主面修好后诊断会回到 `slotted`。
4. 按 §3 的顺序放宽范围；更新本文件的候选链表格（发布者负责版本号/变更日志）。

### 升级检查清单（照做即可）

1. 打开真实页面（新 DSH），控制台读 `window.__W2M_QUEUE_JOURNAL__`，记录 `status` / `surface` /
   `slotAttempts` / `dshVersion`。
2. `status === 'unverified'` → 版本超出 `JQ_TESTED_DSH_RANGE`，继续第 3 步；`fallback`/`disabled` → 先查
   `reasons` 与 `slotAttempts`，修候选链。
3. 跑 §3 的四个测试文件的精确命令；真实页面项若因没有浏览器而 skip，改用
   `$env:W2M_QUEUE_JOURNAL_PROBE='1'` 单独跑一次。
4. 在真实页面检查：chip 在 composer 工具行、抽屉能开、降级横幅只在 `fallback` 出现、
   `unverified` 通知带正确版本号（`status === 'slotted'` 时不应有通知）。
5. 只有 1–4 全绿，才改 `JQ_TESTED_DSH_RANGE` 并更新本文；否则保留旧范围，让升级持续显式告警。

## 6. 宿主侧契约（不变）

* 路由：`GET/POST /api/w2m/composer/journal`、`GET …/history`、`GET …/sessions`、`GET …/session-log`、
  `GET …/diagnostics`、`POST /api/w2m/composer/queue`。
* 草稿上限 100,000 字符；单条排队消息 4,000 字符；队列最多 100 条；主记录最多 100 个会话。
* 数据目录 `$DSH_HOME/xclient/queue-journal` **首次写入时**创建；文件缺失/损坏时路由返回 200 +
  空列表 + `error: 'journal-unreadable'`（历史文件为 `journal-history-unreadable`），损坏文件在下次写入前
  被复制为 `composer-journal.json.corrupt-<时间戳>`。
* `fangAuthToken`（可选，profile 行配置）非空时，所有队列日志路由要求 `x-fang-auth` 匹配，否则
  `401 { ok:false, error:'unauthorized', detail:'x-fang-auth' }`；未配置时保持同源 cookie 围栏的现有行为。
