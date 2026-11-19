# 队列日志兼容说明（v3.6.0）

> 适用包：`@twinsearth/w2m-dsh-plugin` 的队列日志子插件（宿主 `src/queue-journal/`，客户端 `lib/client.js`）。
> 目标：DSH 升级后即使布局/插槽改名，队列日志也不会“静默消失”，而是**显式降级**并给出可复现的升级检查步骤。

## 1. 两套表面

| 表面 | 插槽 | 说明 |
|---|---|---|
| chip（常驻入口） | `conversation.input.left` | `kind:list`、`scope:session`；composer 工具行左侧。本插件的历史对话、Node 执行开关、编队聊天已在该席位。slot 的 standard props 带 `useInput` / `inputActions` / `sessionId`。 |
| drawer（抽屉） | `shell.overlay` | `kind:list`、`scope:root`，frame-wide floating layer；所有列之上、滚动容器之外。第二候选为 `shell.bottom`。 |
| 降级入口 | `sidebar.panellist` | 与备份面板同构的稳定表面；id `w2m-queue-journal`，与 Ops 面板的「消息与草稿」页共用同一 store。 |

为什么不是 `conversation.composer.dock`：它是 composer 卡片下方的 **ambient** 条目，被输入统计
（ActivityPill/UsagePill）占用；chip 是“composer 工具行左侧的紧凑控件”，`input.left` 的语义和 props 更贴合。

主面**不再**向 `document.body.append`：drawer 由 `shell.overlay` 的 React 条目渲染；`findComposer()` 的
DOM 面积启发式只在 slot props 缺失时作为兼容分支使用，且一经使用就会写入诊断
（`dom-composer-fallback:*`）并打一次 `console.warn`。

## 2. 诊断对象

页面全局对象（每个已挂载的页面都有）：

```js
window.__W2M_QUEUE_JOURNAL__ = {
  status: 'slotted' | 'fallback' | 'disabled',
  surface: 'conversation.input.left+shell.overlay' | 'conversation.input.left+shell.bottom' | 'sidebar.panellist' | null,
  reasons: string[],
  dshVersion: '0.2.2-rc.5' | null,
  checkedAt: '2026-11-19T13:00:00.000Z',
}
```

* `slotted`：chip 与 drawer 的主插槽都已接受注册。`reasons` 里可能仍有
  `dsh-version-unverified:<版本> (tested >=0.2.2-rc.1 <0.3.0)` 这类**警告**，不影响可用性。
* `fallback`：至少一个主面注册失败；同一个 UI 已在 `sidebar.panellist` 出现，并显示
  `降级模式：DSH 版本可能不兼容（…）`。降级通知节点带 `data-w2m-jq-status="fallback"`。
* `disabled`：连 `slots` 服务都没有（页面本身不完整）；队列日志不可见，但不会让页面启动失败。

常见 `reasons`：

| 值 | 含义 |
|---|---|
| `slot-inject-threw:<slot>:<message>` | `ctx.slots.inject` 对主插槽抛错（通常是改名/删除）。 |
| `slot-missing:<slot>` | 两个候选 drawer 插槽或 chip 插槽都没有被接受。 |
| `slot-not-declared:<slot>` | 2.5 秒内 slot 未声明，而页面上已有 composer（改名后的静默失败）。 |
| `slot-register-threw:<slot>:<message>` | `inject` 回调里的 `register` 抛错。 |
| `input-actions-missing` | 插槽存在，但 props 没有 `InputActions.setDraft`；chip 仍可见，恢复走诊断过的 DOM 分支。 |
| `slots-service-incomplete` | 上下文没有可用的 `slots.inject` / `slots.register`。 |
| `dsh-version-unavailable` | 页面启动图与 `modules` 服务都没有发布 release 版本。 |
| `dsh-version-unverified:<v> (tested …)` | 版本可读但不在测试范围内；保留主面并显示原因。 |
| `dom-composer-fallback:draft-read` / `:queue-read` / `:draft-write` | 使用了兼容 DOM 分支（只应在旧宿主或 chip 尚未挂载时出现）。 |

## 3. 兼容范围与升级验证

客户端常量 `TESTED_DSH_RANGE = '>=0.2.2-rc.1 <0.3.0'`（`lib/client.js` 内的
`JQ_TESTED_DSH_RANGE`）。版本来自 `window.__DSH_BOOT__.release.version`，读不到时退回
`ctx.get('modules').manifest.release.version`。

DSH 升级后，先跑**精确命令**（不需要 Chromium 也会跑完其余部分；没有浏览器时真实页面项按既有模式 skip 并给出原因）：

```sh
node --test --test-force-exit test/queue-journal.test.mjs test/client-bundle.test.mjs test/client-budget.test.mjs test/loader-entry.test.mjs
```

真实页面探针（需要 Chromium/Edge；`W2M_DSH_BROWSER=<path>` 指定，`W2M_DSH_BROWSER=none` 关闭）：

```sh
# PowerShell
$env:W2M_QUEUE_JOURNAL_PROBE='1'; node --test --test-force-exit test/loader-entry.test.mjs
```

探针会断言：chip 在 composer 中、`window.__W2M_QUEUE_JOURNAL__.status === 'slotted'`、输入草稿后宿主
`$DSH_HOME/xclient/queue-journal/composer-journal.json` 里出现该草稿、`shell.overlay` 抽屉列出该记录、
恢复按钮把草稿写回输入框。任一项失败即升级不可直接发布。

## 4. DSH 改了 slot 名字怎么办

1. 在 `lib/client.js` 里**只改一处**：`JQ_CHIP_SLOT` / `JQ_OVERLAY_SLOT` / `JQ_OVERLAY_FALLBACK_SLOT`
   （`JQ_FALLBACK_SLOT` 是稳定降级面，通常不动）。slot 事实从已安装的 DSH 读取：
   `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 内的 slot 表，或 Inspect 的 `Slots.listSubTree`。
2. 跑第 3 节的精确命令；`client-bundle` 的 slot 测试会因注册目标变化失败，`loader-entry` 的
   `W2M_QUEUE_JOURNAL_PROBE` 会因真实页面缺失而失败——这就是“升级不能静默通过”的守卫。
3. **不要**为了绕过失败去恢复 `document.body.append` 或 `findComposer()` 主路径；降级面已经保证功能
   可见，主面修好后诊断会回到 `slotted`。
4. 更新本文件的兼容范围与 `CHANGELOG`（发布者负责版本号/变更日志）。

## 5. 宿主侧契约（不变）

* 路由：`GET/POST /api/w2m/composer/journal`、`GET …/history`、`GET …/sessions`、`GET …/session-log`、
  `POST /api/w2m/composer/queue`。
* 草稿上限 100,000 字符；单条排队消息 4,000 字符；队列最多 100 条；主记录最多 100 个会话。
* 数据目录 `$DSH_HOME/xclient/queue-journal` **首次写入时**创建；文件缺失/损坏时路由返回 200 +
  空列表 + `error: 'journal-unreadable'`（历史文件为 `journal-history-unreadable`），损坏文件在下次写入前
  被复制为 `composer-journal.json.corrupt-<时间戳>`。
* `fangAuthToken`（可选，profile 行配置）非空时，所有队列日志路由要求 `x-fang-auth` 匹配，否则
  `401 { ok:false, error:'unauthorized', detail:'x-fang-auth' }`；未配置时保持同源 cookie 围栏的现有行为。
