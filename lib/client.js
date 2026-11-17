/**
 * DSH Web client half of `@twinsearth/w2m-dsh-plugin`: the composer's target-machine control.
 *
 * # What this file is
 *
 * This is the *shipped* client bundle, not compiled output: the package has no build step and no
 * dependencies, so the half the browser loads is written here in the exact module format the DSH
 * web shell's loader consumes (`window.__ModuleLoader__.load({ id, factory })`, a lazy CJS table
 * whose factory runs at materialization). `package.json` declares it with
 * `dsh.client: { platform: 'web' }` and `exports['./client'] = './lib/client.js'`, which is what the
 * host scans for. There is no second copy to keep in sync: this file **is** the source, and
 * `test/client-bundle.test.mjs` is where its entry shape is read.
 *
 * # A failed client entry is fatal, and silence is not a neutral failure
 *
 * Measured twice in production: when this entry's `apply` throws, the page does not degrade — the
 * shell audits every entry after activation and refuses to boot with
 * `web boot: 1 entry did not activate / @twinsearth/w2m-dsh-plugin: failed`, which in the desktop
 * app is forwarded to the main process and written as a `web-boot` crash: **the app does not start**.
 * The audit prints the entry's *name* and its fiber state and nothing else, so the cause has to be
 * carried by the failing code itself; {@link apply} therefore reports its own error to
 * `console.error`, which is the error-level renderer console the crash log already captures.
 *
 * The failure that cost those two outages was a single property read. Cordis resolves `ctx.<name>`
 * through the fiber's `inject` list: a service the fiber never declared **throws**
 * (`cannot get property "locale" without inject`) whether or not some plugin provides it, and every
 * name that *is* declared becomes a required dependency the entry waits for. Both halves of that rule
 * are load-bearing here — see {@link inject} for what this bundle declares, and how the optional
 * locale carrier is read instead.
 *
 * Two consequences, both deliberate:
 *
 *   * **No JSX and no bundler.** `React.createElement` keeps the file plain JavaScript a reviewer
 *     can read, and the module system's platform seed table already holds React (`react`,
 *     `react/jsx-runtime`, `react-dom`, Cordis and the shell's static UI libraries are frozen seeds
 *     for every dynamic bundle), so `require('react')` resolves without this package shipping or
 *     declaring anything.
 *   * **Only React is required.** `@deepseek-ai/dsh-client-ui-primitives` is *available* to a
 *     dynamic bundle — the shipped permission control next to this one uses its `Menu` — but a
 *     package that must stay dependency-free should not take a rendering dependency for one
 *     dropdown. The control is styled with the shell's own theme tokens instead, which is what
 *     makes it correct in both themes rather than "similar in one".
 *
 * # Where it sits
 *
 * `conversation.input.left` — `kind: list`, `scope: session`, `replaceRisk: none`. The shipped
 * permission control owns `conversation.input.permission` (`single`, `replaceRisk:
 * shadows-shipped-ui`) and is **not** touched: this entry is appended to the composer's left group,
 * so it renders to the right of the permission control and never competes with it for a seat.
 *
 * # What it shows
 *
 * The machine this session's work will be dispatched to, and — on click — the fleet the relay
 * currently holds. Liveness comes from the host plugin, never from this file: a machine is
 * selectable because the relay lists it as online, and one that is not listed that way is rendered
 * with its state and cannot be chosen. A selection is written to the host process, so it survives a
 * reload and is visible to `w2m_run`, which is where it actually means something.
 */

window.__ModuleLoader__.load({
  id: '@twinsearth/w2m-dsh-plugin',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /**
     * Render a popup under `document.body`.
     *
     * DSH 0.2.2-rc.1 puts `container-type: inline-size` on the composer row. Layout containment makes
     * that row the containing block for `position: fixed` descendants, so a menu rendered inside the
     * composer slot is positioned relative to the row (and can be clipped) instead of the viewport.
     * A portal keeps the viewport coordinates the menus already compute. `react-dom` is a platform
     * seed in the Web shell; the lazy require keeps this bundle loadable where only React is present,
     * and the inline fallback preserves the old behavior if the portal cannot be created.
     *
     * @param {object|null} node - menu element.
     * @returns {object|null} portal element, or the original node.
     */
    let portalRuntime;
    let portalUnavailable = false;
    function portalNode(node) {
      if (node === null || portalUnavailable) return node;
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return node;
      try {
        if (portalRuntime === undefined) portalRuntime = require('react-dom');
        if (typeof portalRuntime?.createPortal !== 'function') {
          portalUnavailable = true;
          return node;
        }
        return portalRuntime.createPortal(node, document.body);
      } catch {
        portalUnavailable = true;
        return node;
      }
    }

    // -------------------------------------------------------------------------------------------
    // Wire
    // -------------------------------------------------------------------------------------------
    //
    // Mirrors TARGET_ROUTE_PATH in src/plugin/fleet-target.mjs, `/api` prefix included: the host's
    // Connection service mounts its exact-fetch-route registry under that channel and refuses any
    // path that does not start with `/api/`. Plain same-origin `fetch` rather than a Remote method:
    // the route is mounted inside the host's authentication fence, so the page's own cookie is the
    // credential and there is no descriptor to keep in sync.
    const ROUTE = '/api/w2m/target';
    // v1.4.2: the UI-activated Node-code-execution switch (host: src/plugin/exec-capability-route.mjs).
    const CAPABILITY_ROUTE = '/api/w2m/capability';
// v1.6.8: npm update check + verified install (host: src/plugin/update-route.mjs).
const PLUGIN_UPDATE_ROUTE = '/api/w2m/plugin-update';

    /**
     * The locale namespace and its two dictionaries.
     *
     * Registered through `ctx.locale` when the composition provides it, exactly as the shipped
     * permission control beside this one does; the Chinese dictionary is the fallback when it does
     * not, because a missing localisation service is not a reason for an operator to lose the
     * control. Only the *visible* strings are here. A refusal from the host is reported in the
     * host's own words — it is a diagnostic naming a machine, a relay or an HTTP status, and
     * translating it would put a second, drifting copy of that vocabulary in the browser.
     */
    const NS = 'w2m.target';
    const DICT = {
      zh: {
        all: '全部机器',
        machine: '机器',
        local: '本机',
        online: '在线',
        unknownPlatform: '未知平台',
        clientGroup: '客户端',
        webGroup: 'Web端',
        offlineGroup: '离线',
        webFold: '展开',
        webUnfold: '收起',
        noRoster: '无列表',
        empty: '机器列表里没有机器',
        costAll: '本次会话的派发会送到所有在线机器',
        costOne: '本次会话的派发会送到 {name}',
        unconfirmed: '（未确认在线）',
        mentionFailed: '目标已切换，但输入框未能同步 @ 标记；请稍后重新选择该机器',
        targetLabel: '目标机器：{name}',
        unreachable: '无法连接插件',
        routeMissing: '这个 Harness 没有提供插件目标路由',
        fleetUnreadable: '机器列表读取失败',
        relays: 'Relay 节点',
        relayPrimary: '主 relay',
        relayStandby: '备用',
        relayOffline: '离线',
        relayFold: '另有 {count} 个已折叠，点击展开',
        relayUnfold: '收起折叠的 relay',
        relayTemporary: '临时 Relay 节点（回退配置）',
        globalSummary: '全服：{fleetsOnline}/{fleets} 个编队 · {online}/{total} 台在线',
        globalSummaryWithSource: '主 relay（{source}）全服：{fleetsOnline}/{fleets} 个编队 · {online}/{total} 台在线',
        fleetSummary: '本编队：{online}/{total} 台在线',
        globalUnreachable: '主 relay 不可达（{url}）· 全服统计不可用',
        updateButton: '检查插件更新',
        updateChecking: '正在检查 npm…',
        updating: '正在更新…',
        updateCurrent: '已是最新（{version}）',
        updateInstalled: '已更新到 {version}',
        restartHint: '请重启 DSH 以载入最新插件',
        capLabel: 'Node 执行：{state}',
        capDenied: '拒绝',
        capTemporary: '临时 24 小时',
        capPermanent: '永久',
        capWarning: '开启后该机器可执行任意 Node 代码（等效远程代码执行）',
        capMenuLabel: 'Node 代码执行能力',
        capRemaining: '剩余 {hours} 小时',
        capRouteMissing: '这个 Harness 没有提供能力路由',
        capRefused: '能力切换被拒绝：{error}',
        gpwTitle: 'GPW 文件夹策略',
        gpwDisabled: 'GPW 未启用（在插件页开启 dsh-gpw）',
        gpwWhitelist: '白名单（通过）',
        gpwBlacklist: '黑名单（拒绝）',
        gpwAddWhite: '添加白名单文件夹',
        gpwAddBlack: '添加黑名单文件夹',
        gpwRemove: '移除',
        gpwPending: '待审批（C 类：名单外）',
        gpwLauncher: 'GPW 文件夹',
        gpwManual: '手动输入路径',
        gpwManualPlaceholder: '例如 D:\\work\\data（绝对路径）',
        gpwAddManual: '添加',
        gpwRecent: '最近被拦截',
        gpwRecentEmpty: '暂无被拦截记录',
        gpwAddWhiteShort: '加入白名单',
        gpwAddBlackShort: '加入黑名单',
        gpwClose: '关闭',
        gpwBadPath: '路径无效：{error}',
        gpwInputHint: '目录需已存在；添加后立即生效。',
        gpwPendingEmpty: '当前没有待审批调用',
        gpwAllowOnce: '允许本次',
        gpwDenyOnce: '拒绝本次',
        gpwMore: '另有 {count} 个，展开',
        gpwFold: '收起',
        gpwAddWhiteAllow: '加入白名单并允许',
        gpwAddBlackDeny: '加入黑名单并拒绝',
        gpwPendingShort: 'GPW 待审批：{tool}',
        gpwPendingCount: '有 {count} 个调用等待审批',
        gpwOpenPanel: '打开面板',
        gpwTampered: '名单完整性校验失败（{reason}），名单外路径已锁定。',
        gpwReset: '重置名单（清空并重新签名）',
        gpwResetConfirm: '确认重置？将清空白名单和黑名单的全部条目。',
        // v3.4.9 备份&还原面板（与 GPW 同构的 sidebar.panellist + main 对）。键统一用
        // `panel.backup.*` 命名空间；注册仍走同一个 registerDictionaries（NS = w2m.target），
        // 所以这里和 GPW 的扁平键并存，不新增第二个 locale 命名空间。
        'panel.backup.title': '备份&还原',
        'panel.backup.subtitle': '加密的会话备份仓库：立即备份、生成还原计划并还原、打包已归档会话、全量校验。',
        'panel.backup.sidebarTitle': '备份&还原面板',
        'panel.backup.refresh': '刷新',
        'panel.backup.loading': '正在读取备份状态…',
        'panel.backup.notEnabled': '备份子插件未启用：请在插件页启用 dsh-backup 行后刷新。',
        'panel.backup.operations.title': '一键操作',
        'panel.backup.status.title': '状态',
        'panel.backup.status.repo': '仓库目录',
        'panel.backup.status.initialized': '初始化状态',
        'panel.backup.status.snapshots': '快照数',
        'panel.backup.status.cipher': '加密',
        // v3.5.x 保护模式（用户决定：不是绝对保密；不加密是默认）。三态徽标与诚实警告。
        'panel.backup.status.mode': '保护模式',
        'panel.backup.mode.none': '未加密（默认）',
        'panel.backup.mode.sealed': '已加密',
        'panel.backup.mode.noneWarning': '未加密：任何能访问该目录的人都能还原备份',
        'panel.backup.status.next': '下次 {time}',
        'panel.backup.status.lastRun': '上次备份',
        'panel.backup.status.lastError': '上次失败',
        'panel.backup.status.running': '正在备份…',
        'panel.backup.status.idle': '空闲',
        'panel.backup.status.state': '运行状态',
        'panel.backup.status.never': '从未运行',
        'panel.backup.status.schedule': '备份计划',
        'panel.backup.status.recheck': '注册表复查',
        'panel.backup.status.recheckOk': '通过',
        'panel.backup.status.recheckRewrote': '客户端覆盖后已重新写回',
        'panel.backup.status.recheckFailed': '未通过',
        // v3.5.x 宿内注册表修复（G2 的面板路径）：按钮在状态卡里，登记的是勾选会话或扫描到的未登记会话。
        // 监视窗口是有限的，结果行永远附带残余风险说明，不把「修好了」说成「不会再丢」。
        'panel.backup.status.registerFix': '注册表修复',
        'panel.backup.register.none': '无需修复',
        'panel.backup.register.done': '已登记 {registered} · 已存在 {already} · 被覆盖 {clobbered} · 已重放 {reapplied}',
        'panel.backup.register.residual': '监视窗口之后客户端再保存，仍可能把登记覆盖掉；可再次点击或重跑。',
        'panel.backup.status.free': '剩余空间',
        'panel.backup.status.yes': '已初始化',
        'panel.backup.status.no': '未初始化',
        'panel.backup.status.runResult': '快照 {snapshot} · {sessions} 个会话 / {files} 个文件 · 耗时 {duration}',
        'panel.backup.action.run': '立即备份',
        'panel.backup.action.restore': '还原选中',
        'panel.backup.action.confirmRestore': '确认还原（写入磁盘）',
        'panel.backup.action.archive': '归档打包',
        'panel.backup.action.verify': '全量校验',
        'panel.backup.action.verifyRuntime': '立即运行（慢，需要安装 Harness）',
        'panel.backup.action.repairRegister': '修复注册表',
        'panel.backup.action.plan': '生成还原计划',
        'panel.backup.action.unlock': '用本机凭据解锁',
        'panel.backup.action.cancel': '取消',
        'panel.backup.action.runHint': '备份全部会话（含已归档）；内容未变时只复用已有块。',
        'panel.backup.archive.scope': '打包范围',
        'panel.backup.archive.scopeArchived': '已归档会话',
        'panel.backup.archive.scopeAll': '全部会话',
        'panel.backup.archive.done': '归档包已生成：{file} · {sessions} 个会话 · {bytes}（压缩后 {compressed}）',
        'panel.backup.run.done': '备份完成：{snapshot} · {sessions} 个会话 · 新增 {blocksNew} 块 / 复用 {blocksReused} 块 · {duration}',
        'panel.backup.restore.done': '还原完成：{restored} 个会话，跳过 {skipped} 个，写入 {bytes}；还原前快照：{pre}',
        'panel.backup.verify.title': '校验结果',
        'panel.backup.verify.counts': '快照 {snapshots} · 文件 {files} · 块 {blocks} · old {old} · current {current}',
        'panel.backup.verify.futureAppend': '未来追加：检查 {checked}，失败 {failed}',
        'panel.backup.verify.runtime': '用安装的 Harness 终审（慢）',
        'panel.backup.verify.runtimeCounts': '运行时校验：检查 {checked}，失败 {failed}',
        'panel.backup.verify.runtimeHint': '会用本机安装的 Harness 逐条终审每个会话与「追加后日志」，可能耗时数分钟；本机必须已安装 Harness。',
        'panel.backup.verify.problems': '问题（{count}）',
        'panel.backup.verify.problem': '{code} · {file} · {detail}',
        'panel.backup.verify.clean': '没有发现问题。',
        // v3.5.x 缓存终审（G5）：运行时终审很慢，面板先显示上次持久化的结论（含时间、计数、是否过期、证据标签），
        // 「立即运行」按钮才真正同步跑一次。记录是数据不是推断：证据标签永远写 installed-harness。
        'panel.backup.verify.cachedTitle': '缓存的运行时终审',
        'panel.backup.verify.cachedLine': '上次 {time} · 检查 {checked}，失败 {failed} · {snapshots} 个快照 · 证据 {evidence}',
        'panel.backup.verify.cachedNone': '还没有缓存的运行时终审：点「立即运行（慢）」生成一份，之后这里显示最近一次结果。',
        'panel.backup.verify.stale': '已过期（超过 24 小时）',
        'panel.backup.verify.fresh': '24 小时内',
        'panel.backup.plan.title': '还原计划（只读，尚未写入）',
        'panel.backup.plan.empty': '还没有还原计划：点「生成还原计划」读取最新快照。',
        'panel.backup.plan.source': '来源快照',
        'panel.backup.plan.summary': '会话 {sessions} · 新增 {new} · 一致 {identical} · 冲突 {conflicts} · 附件 {attachments}',
        'panel.backup.plan.selected': '已选 {count}/{total}',
        'panel.backup.plan.selectAll': '全选',
        'panel.backup.plan.clear': '清空选择',
        'panel.backup.plan.danger': '还原会覆盖目标会话文件（写入前自动生成还原前快照）。这一步会修改磁盘，请再次点击「确认还原」。',
        'panel.backup.plan.snapshotMissing': '未指定快照时使用仓库中最新的有效快照。',
        'panel.backup.conflict.new': '新增',
        'panel.backup.conflict.identical': '一致',
        'panel.backup.conflict.differs': '冲突',
        'panel.backup.unlock.title': '解锁',
        'panel.backup.unlock.initialized': '仓库已初始化，可读取信封列表。',
        'panel.backup.unlock.notInitialized': '仓库尚未初始化：第一次备份会创建密钥信封。',
        'panel.backup.unlock.envelopes': '信封：{kinds}',
        'panel.backup.unlock.machineAvailable': '本机凭据可用：可用本机 DPAPI 信封直接解锁，无需密码。',
        'panel.backup.unlock.machineUnavailable': '本机凭据不可用（{reason}）：只能走密码路径。',
        'panel.backup.unlock.passwordPath': '密码不经过 HTTP：面板不接受也不发送密码。密码路径请在本机终端运行：w2m-backup unlock --check --password-stdin（密码只从 stdin 读取）。',
        'panel.backup.unlock.noPassword': '这个仓库没有密码信封：换机后无法用密码解锁。',
        // v3.5.x 三态解锁卡（用户决定：便捷优先）。未加密 → 免密直接解锁 + 诚实警告；
        // 账户一致 → 快捷解锁；账户不一致 → 只用终端里的 4-6 位 PIN（面板仍不接收密码）。
        'panel.backup.unlock.none': '仓库未加密：不需要账户或 PIN，直接可以解锁。这是一层“防误操作”的说明，不是保密。',
        'panel.backup.unlock.passwordHint': '账户与原账户不一致：请在本机终端用 4–6 位数字 PIN 解锁（PIN 仍只在终端输入，面板从不接收密码）。',
        'panel.backup.unlock.weakPinHint': '4 位数字 PIN 只是便捷门槛，不是保密强度。',
        'panel.backup.unlock.disableProtectionHint': '“关闭保护”意味着任何能看到仓库目录的人都能免密还原；在终端运行 w2m-backup unlock --disable-protection --confirm disable-protection 即可关闭（会先备份 keys.json）。',
        // v3.5.x 账户 ID 绑定解锁（用户决定：只读取账户唯一识别码做比对，一致就放行，不一致就切换密码模式）。
        // 账户 ID 只在面板里以后 4 位出现；这不是机密性路径（见 docs/BACKUP-DESIGN.md §25）。
        'panel.backup.unlock.accountBound': '原账户绑定：{hint}（只显示后 4 位）',
        'panel.backup.unlock.accountMatched': '本机账户与原账户一致，可直接解锁。',
        'panel.backup.unlock.accountMismatch': '当前账户不是原账户：请使用解锁密码。',
        'panel.backup.unlock.accountUnavailable': '读取不到本机账户 ID（可能未登录，或账户绑定已关闭）：请使用解锁密码。',
        'panel.backup.action.unlockAccount': '用原账户解锁',
        'panel.backup.unlock.done': '解锁成功（{via}）。',
        // v3.5.x 解锁对话框（真正的模态）：卡片里的说明和既有按钮都保留，动作面移到对话框里。
        // 选项 A 只发确认令牌（凭据在宿主）；选项 B 只在终端输入密码，浏览器里没有密码输入框，
        // 命令以可复制的 `<code>` 呈现，密码永远不经过浏览器/HTTP。
        // v3.5.x 密码提示词（`password_hint`）：公开元数据，随仓库保存，选项 B 里原样显示；按用户决定不提供 PIN 轮换。
        'panel.backup.unlock.dialog.open': '解锁…',
        'panel.backup.unlock.dialog.title': '解锁备份仓库',
        'panel.backup.unlock.dialog.subtitle': '解锁只影响本机，不会改动仓库内容。',
        'panel.backup.unlock.dialog.state.none': '当前保护：未加密（默认）',
        'panel.backup.unlock.dialog.state.accountMatched': '当前保护：本机账户与原账户一致',
        'panel.backup.unlock.dialog.state.accountMismatch': '当前保护：当前账户不是原账户',
        'panel.backup.unlock.dialog.state.unbound': '当前保护：本机未绑定原账户',
        'panel.backup.unlock.dialog.state.unknown': '当前保护：未知（还读不到解锁描述）',
        'panel.backup.unlock.dialog.optionA': '用本机/原账户解锁',
        'panel.backup.unlock.dialog.optionAHint': '凭据留在宿主进程：浏览器只发送确认令牌 {"confirm":"unlock"}。',
        'panel.backup.unlock.dialog.localUnavailable': '本机凭据和原账户都不可用：请使用下面的终端密码路径。',
        'panel.backup.unlock.dialog.optionB': '使用解锁密码（在终端输入）',
        'panel.backup.unlock.dialog.optionBHint': '密码不经过浏览器：在本机终端运行下面的命令，密码只从 stdin 读取。',
        'panel.backup.unlock.dialog.hintLabel': '密码提示：{hint}',
        'panel.backup.unlock.dialog.hintNone': '未设置密码：这个仓库还没有 PIN，也没有提示词。',
        // 用户撤销了"不提供 PIN 轮换"的决定：轮换存在，但只能在终端运行（浏览器里永远没有密码输入框）。
        'panel.backup.unlock.dialog.rotation': '轮换需要在终端运行：旧凭据解开 → 去掉旧 PIN → 写新 PIN（旧 PIN 随后失效）',
        'panel.backup.unlock.dialog.rotationCommand': '轮换命令（只复制，不在面板里执行）',
        'panel.backup.unlock.dialog.noPasswordNeeded': '仓库未加密：不需要密码，直接用上面的选项解锁即可。',
        'panel.backup.unlock.dialog.commandCaption': '命令',
        'panel.backup.unlock.dialog.copy': '复制命令',
        'panel.backup.unlock.dialog.copied': '已复制',
        'panel.backup.unlock.dialog.refresh': '我已运行，刷新状态',
        'panel.backup.unlock.dialog.refreshing': '正在刷新…',
        'panel.backup.unlock.dialog.close': '关闭',
        'panel.backup.unlock.dialog.busy': '正在解锁…',
        'panel.backup.unlock.dialog.failed': '解锁失败：{reason}',
        'panel.backup.unlock.dialog.success': '解锁成功（{via}），状态已刷新。',
        'panel.backup.unlock.dialog.passwordNeverInBrowser': '密码永远不会进入浏览器，也不会经过 HTTP；面板不接受也不发送密码。',
        'panel.backup.unlock.dialog.disableProtection': '关闭保护（只复制，不在面板里执行）',
        'panel.backup.log.title': '运行日志（最近 {max} 条）',
        'panel.backup.log.empty': '还没有操作记录。',
        'panel.backup.log.ok': '成功',
        'panel.backup.log.run': '备份',
        'panel.backup.log.plan': '计划',
        'panel.backup.log.restore': '还原',
        'panel.backup.log.archive': '打包',
        'panel.backup.log.verify': '校验',
        'panel.backup.log.unlock': '解锁',
        'panel.backup.error.title': '操作失败',
        'panel.backup.busy.run': '正在备份…',
        'panel.backup.busy.restore': '正在还原…',
        'panel.backup.busy.plan': '正在生成计划…',
        'panel.backup.busy.archive': '正在打包…',
        'panel.backup.busy.verify': '正在校验…',
        'panel.backup.busy.unlock': '正在解锁…',
        'panel.backup.reason.BACKUP_NO_PERMISSION': '没有权限：请用原账户登录，或输入解锁密码',
        'panel.backup.reason.BACKUP_ACCOUNT_MISMATCH': '当前账户不是原账户：已改走解锁密码路径，请用密码解锁',
        'panel.backup.reason.BACKUP_ROUTE_MISSING': '备份子插件未启用：请启用 dsh-backup 行后重试。',
        'panel.backup.reason.BACKUP_UNREACHABLE': '无法连接宿主插件，请稍后重试。',
        'panel.backup.reason.BACKUP_BAD_RESPONSE': '宿主返回了无法解析的响应。',
        'panel.backup.reason.BACKUP_BUSY': '上一次备份还在运行，请稍候。',
        'panel.backup.reason.BACKUP_LOCKED': '另一个进程持有备份仓库锁，请稍后再试。',
        'panel.backup.reason.BACKUP_REPO_NOT_INITIALIZED': '备份仓库尚未初始化：先运行一次「立即备份」。',
        'panel.backup.reason.BACKUP_REPO_SNAPSHOT_MISSING': '仓库里还没有可还原的快照。',
        'panel.backup.reason.BACKUP_KEY_UNWRAP_FAILED': '仓库密钥无法解开：本机凭据不可用，请用密码路径。',
        'panel.backup.reason.BACKUP_SCOPE_INVALID': '备份范围无效。',
        'panel.backup.reason.BACKUP_SCOPED_NOTHING': '选定范围内没有可备份的会话。',
        'panel.backup.reason.BACKUP_WRITE_FAILED': '写入备份仓库失败：请检查磁盘空间与目录权限。',
        'panel.backup.reason.BACKUP_DISK_FULL': '磁盘空间不足，备份未完成。',
        'panel.backup.reason.BACKUP_DIR_DENIED': '备份目录没有写入权限。',
        'panel.backup.reason.BACKUP_SCAN_HOME_MISSING': '找不到 DSH_HOME，无法枚举会话。',
        'panel.backup.reason.BACKUP_RESTORE_NO_SESSION': '快照里没有要还原的会话。',
        'panel.backup.reason.BACKUP_CANDIDATE_INVALID': '待还原会话的校验未通过。',
        'panel.backup.reason.BACKUP_RESTORE_TARGET_CHANGED': '还原目标在计划之后被改动，请重新生成计划。',
        'panel.backup.reason.BACKUP_REGISTRY_WRITE_FAILED': '写入 workspace 注册表失败。',
        'panel.backup.reason.BACKUP_REGISTER_NO_SESSION': '没有指定要登记的会话。',
        'panel.backup.reason.BACKUP_REGISTER_SESSION_MISSING': '磁盘上找不到该会话（登记只让已存在会话可见，不创建会话）。',
        'panel.backup.reason.BACKUP_REGISTER_BACKUP_FAILED': '注册表副本写入失败，未做任何修改。',
        'panel.backup.reason.BACKUP_VERIFY_BUSY': '已有一次运行时终审在运行，请稍候。',
        'panel.backup.reason.BACKUP_ATTACHMENT_CONFLICT': '附件对象冲突，已停止还原。',
        'panel.backup.reason.BACKUP_RESTORE_VERIFY_FAILED': '还原后的回读校验失败。',
        'panel.backup.reason.BACKUP_ARCHIVE_EMPTY': '没有可打包的已归档会话。',
        'panel.backup.reason.BACKUP_ARCHIVE_UNREADABLE': '归档包或仓库内容无法读取。',
        'panel.backup.reason.BACKUP_MANIFEST_DIGEST_MISMATCH': '仓库内容与清单摘要不一致，可能被改动。',
        'panel.backup.reason.BACKUP_OBJECT_MISSING': '仓库缺少对象块。',
        'panel.backup.reason.BACKUP_DECRYPT_AUTH_FAILED': '块解密认证失败，数据可能被篡改。',
        'panel.backup.reason.BACKUP_INDEX_MISMATCH': '索引与磁盘上的快照不一致。',
        'panel.backup.reason.BACKUP_REPO_SNAPSHOT_INVALID': '快照文件无效。',
        'panel.backup.reason.BACKUP_FUTURE_APPEND_FAILED': '未来追加校验失败。',
        'panel.backup.reason.BACKUP_RUNTIME_APPEND_FAILED': '运行时追加校验失败。',
        'panel.backup.reason.BACKUP_RUNTIME_UNAVAILABLE': '本机没有可用的运行时校验环境。',
        'panel.backup.reason.BACKUP_RUNTIME_REJECTED': '运行时拒绝了待还原的会话。',
        'panel.backup.reason.BACKUP_CONFIRM_REQUIRED': '请求缺少确认令牌，已被拒绝。',
        'panel.backup.reason.BACKUP_CONFIG_INVALID': '备份配置无效：保护模式只能是 none（不加密）或 sealed（已加密）。',
        // v3.5.0 整文件副本上限（oldFormat: full）：引擎在写盘前拒绝，仓库零改动；人工「特批」后重跑同一次备份。
        'panel.backup.reason.BACKUP_FULL_COPY_APPROVAL_REQUIRED': '旧版本整文件副本超过 300 MB 上限：本次没有写入任何内容，需要人工特批后才能继续。',
        'panel.backup.approval.open': '查看并特批',
        'panel.backup.approval.pending': '有 {count} 个会话的旧版本副本超过 {cap} MB，需要特批',
        'panel.backup.approval.pendingHint': '定时备份不会等待人工确认：本次运行在写入前已拒绝，仓库没有任何改动。点「查看并特批」可手动批准这一次写入。',
        'panel.backup.approval.dialog.title': '整文件副本超过上限：需要特批',
        'panel.backup.approval.dialog.subtitle': '有 {count} 个会话的旧版本 full 副本超过 {cap} MB。批准只对本次写入生效，旧版本记录会标记 approved_over_cap。',
        'panel.backup.approval.dialog.session': '{id} · {size}（上限 {cap}）',
        'panel.backup.approval.dialog.more': '另有 {count} 个会话未列出',
        'panel.backup.approval.dialog.hint': '不会自动批准：只有点「特批并继续」才会重发这次备份并写入；点「取消」不发送任何请求。',
        'panel.backup.approval.confirm': '特批并继续',
        'panel.backup.approval.cancel': '取消',
        'panel.backup.approval.close': '关闭',
        'panel.backup.approval.busy': '正在特批写入…',
        // v3.5.0 §24.3：old/ 不设总量上限；按「自上次确认以来的增长」提醒，由用户决定是否手动清理。
        // 「知道了」只把确认水位移到当前字节数，绝不删除；「如何清理」展开 gc 指引，面板没有删除按钮。
        'panel.backup.oldUsage.title': '旧版本占用提醒',
        'panel.backup.oldUsage.banner': 'old/ 已占用 {bytes} GB（自上次确认增加 {growth} GB）：建议手动清理',
        'panel.backup.oldUsage.hint': '旧版本目录没有总量上限，这只是提醒：备份不会自动删除任何文件。',
        'panel.backup.oldUsage.ack': '知道了',
        'panel.backup.oldUsage.howTo': '如何清理',
        'panel.backup.oldUsage.guidance': '清理是手动的：先运行 `w2m-backup gc --dry-run` 预览可清理内容；确认后再运行 `w2m-backup gc --max-old-days <n>`（或调低每会话保留份数）。面板不会删除任何文件。',
        'panel.backup.oldUsage.ackDone': '已确认（没有删除任何文件）',
        'panel.backup.busy.oldUsageAck': '正在确认…',
        'panel.backup.log.ackOldUsage': '确认旧版本占用',
        'panel.backup.reason.BACKUP_FAILED': '操作失败。',
        // v3.5.0 面板补全：备份范围入口（选中会话 / 当前活动会话 / 全部）。会话列表来自只读的
        // `GET /api/w2m/backup/scan?detail=1`；面板只是把勾选装进 run 的请求体，自己从不写盘。
        'panel.backup.action.backupSelected': '备份选中会话',
        'panel.backup.action.backupActive': '备份所有当前活动会话',
        'panel.backup.scope.hint': '勾选会话后点「备份选中会话」只备份勾中的；「备份所有当前活动会话」只备份未归档会话；「立即备份」备份全部（含已归档）。',
        'panel.backup.pick.title': '选择要备份的会话',
        'panel.backup.pick.count': '已选 {n}/{m}',
        'panel.backup.pick.selected': '全选',
        'panel.backup.pick.clear': '清空选择',
        'panel.backup.pick.refresh': '刷新会话',
        'panel.backup.pick.loading': '正在读取会话列表…',
        'panel.backup.pick.unavailable': '该宿主未启用备份路由或扫描失败，可点「刷新会话」重试。',
        'panel.backup.pick.empty': '没有可备份的会话。',
        'panel.backup.pick.archivedTag': '已归档',
        'panel.backup.busy.backupSelected': '正在备份选中会话…',
        'panel.backup.busy.backupActive': '正在备份活动会话…',
        'panel.backup.busy.verifyRuntime': '正在运行运行时终审…',
        'panel.backup.busy.repairRegister': '正在修复注册表…',
        'panel.backup.log.backupSelected': '备份选中',
        'panel.backup.log.backupActive': '备份活动',
        'panel.backup.log.verifyRuntime': '运行时终审',
        'panel.backup.log.repairRegister': '修复注册表',
        // v3.5.0 编队版本卡片（操作面板 →「操作入口」页）。读取宿主既有的只读 `versions` 块，
        // 只展示版本漂移，不派发、不写选择。
        'panel.fleet.version.title': '编队版本',
        'panel.fleet.version.supportedMin': '最低支持版本',
        'panel.fleet.version.distribution': '版本分布',
        'panel.fleet.version.outdated': '落后机器',
        'panel.fleet.version.unknown': '版本未知',
        'panel.fleet.version.allCurrent': '全部已达标',
        'panel.fleet.version.refresh': '刷新',
        'panel.fleet.version.copyGuidance': '一键复制升级指引',
        'panel.fleet.version.copied': '已复制',
        'panel.fleet.version.unavailable': '版本信息未知：宿主未提供版本块，或名册读取失败',
        'panel.fleet.version.noOutdated': '没有落后机器',
        'panel.fleet.version.guidanceTitle': '升级到 @twinsearth/w2m-dsh-plugin@{version}',
      },
      en: {
        all: 'All machines',
        machine: 'Machine',
        local: 'This machine',
        online: 'online',
        unknownPlatform: 'unknown platform',
        clientGroup: 'Client',
        webGroup: 'Web',
        offlineGroup: 'Offline',
        webFold: 'show',
        webUnfold: 'hide',
        noRoster: 'no roster',
        empty: 'the fleet lists no machines',
        costAll: 'Work from this session goes to every online machine',
        costOne: 'Work from this session goes to {name}',
        unconfirmed: ' (not confirmed online)',
        mentionFailed: 'the target changed, but the composer could not add the @ handle; pick the machine again in a moment',
        targetLabel: 'target machine: {name}',
        unreachable: 'the plugin could not be reached',
        routeMissing: 'this host does not serve the W2M target route',
        fleetUnreadable: 'the fleet could not be read',
        relays: 'Relay nodes',
        relayPrimary: 'primary',
        relayStandby: 'standby',
        relayOffline: 'offline',
        relayFold: '{count} more folded — expand',
        relayUnfold: 'collapse the folded relays',
        relayTemporary: 'temporary relay nodes (fallback config)',
        globalSummary: 'fleets {fleetsOnline}/{fleets} · machines {online}/{total} online',
        globalSummaryWithSource: 'primary relay ({source}) · fleets {fleetsOnline}/{fleets} · machines {online}/{total}',
        fleetSummary: 'this fleet: {online}/{total} online',
        globalUnreachable: 'primary relay unreachable ({url}) · server totals unavailable',
        updateButton: 'check for plugin update',
        updateChecking: 'checking npm…',
        updating: 'updating…',
        updateCurrent: 'up to date ({version})',
        updateInstalled: 'updated to {version}',
        restartHint: 'restart DSH to load the new plugin',
        capLabel: 'Node exec: {state}',
        capDenied: 'denied',
        capTemporary: 'temporary 24 h',
        capPermanent: 'permanent',
        capWarning: 'once on, this machine runs arbitrary Node code (equivalent to remote code execution)',
        capMenuLabel: 'Node code execution capability',
        capRemaining: '{hours} h left',
        capRouteMissing: 'this host does not serve the capability route',
        capRefused: 'the capability switch was refused: {error}',
        gpwTitle: 'GPW folder policy',
        gpwDisabled: 'GPW is not enabled (turn on dsh-gpw in the Plugins page)',
        gpwWhitelist: 'Whitelist (pass)',
        gpwBlacklist: 'Blacklist (deny)',
        gpwAddWhite: 'Add whitelist folder',
        gpwAddBlack: 'Add blacklist folder',
        gpwRemove: 'Remove',
        gpwPending: 'Pending approval (class C: on neither list)',
        gpwPendingEmpty: 'No calls are waiting for approval',
        gpwAllowOnce: 'Allow this call',
        gpwDenyOnce: 'Deny this call',
        gpwMore: 'Show {count} more',
        gpwFold: 'Show less',
        gpwAddWhiteAllow: 'Always allow (add to whitelist)',
        gpwAddBlackDeny: 'Always deny (add to blacklist)',
        gpwPendingShort: 'GPW pending: {tool}',
        gpwPendingCount: '{count} call(s) waiting for approval',
        gpwOpenPanel: 'Open panel',
        gpwTampered: 'Folder lists failed integrity check ({reason}); non-listed paths are locked.',
        gpwReset: 'Reset lists (clear + re-sign)',
        gpwResetConfirm: 'Reset the lists? Every whitelist and blacklist entry will be cleared.',
        // v3.4.9 backup & restore panel (the sidebar.panellist + main pair, same shape as GPW).
        'panel.backup.title': 'Backup & Restore',
        'panel.backup.subtitle': 'Encrypted session backup repository: run a backup, build and confirm a restore plan, pack archived sessions, verify everything.',
        'panel.backup.sidebarTitle': 'Backup & Restore panel',
        'panel.backup.refresh': 'Refresh',
        'panel.backup.loading': 'Reading backup status…',
        'panel.backup.notEnabled': 'The backup subplugin is not mounted: enable the dsh-backup row on the Plugins page, then refresh.',
        'panel.backup.operations.title': 'One-click operations',
        'panel.backup.status.title': 'Status',
        'panel.backup.status.repo': 'Repository',
        'panel.backup.status.initialized': 'Initialised',
        'panel.backup.status.snapshots': 'Snapshots',
        'panel.backup.status.cipher': 'Cipher',
        'panel.backup.status.mode': 'Protection',
        'panel.backup.mode.none': 'Not encrypted (default)',
        'panel.backup.mode.sealed': 'Encrypted',
        'panel.backup.mode.noneWarning': 'Not encrypted: anyone who can reach this directory can restore the backup',
        'panel.backup.status.next': 'next {time}',
        'panel.backup.status.lastRun': 'Last backup',
        'panel.backup.status.lastError': 'Last failure',
        'panel.backup.status.running': 'backup running…',
        'panel.backup.status.idle': 'idle',
        'panel.backup.status.state': 'Run state',
        'panel.backup.status.never': 'never run',
        'panel.backup.status.schedule': 'Schedule',
        'panel.backup.status.recheck': 'Registry re-check',
        'panel.backup.status.recheckOk': 'passed',
        'panel.backup.status.recheckRewrote': 'rewritten after the client overwrote it',
        'panel.backup.status.recheckFailed': 'failed',
        // v3.5.x in-host register repair (G2's panel path): registers the ticked sessions, or the scanned
        // unregistered ones; the result line always carries the bounded-watch residual risk.
        'panel.backup.status.registerFix': 'Registration repair',
        'panel.backup.register.none': 'nothing to repair',
        'panel.backup.register.done': 'registered {registered} · already {already} · clobbered {clobbered} · re-applied {reapplied}',
        'panel.backup.register.residual': 'a client save after the watch window can still remove it; click again or re-run.',
        'panel.backup.status.free': 'Free space',
        'panel.backup.status.yes': 'initialised',
        'panel.backup.status.no': 'not initialised',
        'panel.backup.status.runResult': 'snapshot {snapshot} · {sessions} sessions / {files} files · {duration}',
        'panel.backup.action.run': 'Run backup now',
        'panel.backup.action.restore': 'Restore selected',
        'panel.backup.action.confirmRestore': 'Confirm restore (write to disk)',
        'panel.backup.action.archive': 'Pack archive',
        'panel.backup.action.verify': 'Verify all',
        'panel.backup.action.verifyRuntime': 'Run now (slow, requires an installed Harness)',
        'panel.backup.action.repairRegister': 'Repair registration',
        'panel.backup.action.plan': 'Build restore plan',
        'panel.backup.action.unlock': 'Unlock with machine credentials',
        'panel.backup.action.cancel': 'Cancel',
        'panel.backup.action.runHint': 'Backs up every session (archived included); unchanged content only reuses existing blocks.',
        'panel.backup.archive.scope': 'Archive scope',
        'panel.backup.archive.scopeArchived': 'Archived sessions',
        'panel.backup.archive.scopeAll': 'All sessions',
        'panel.backup.archive.done': 'Archive written: {file} · {sessions} sessions · {bytes} ({compressed} compressed)',
        'panel.backup.run.done': 'Backup complete: {snapshot} · {sessions} sessions · {blocksNew} new / {blocksReused} reused blocks · {duration}',
        'panel.backup.restore.done': 'Restore complete: {restored} restored, {skipped} skipped, {bytes} written; pre-restore copy: {pre}',
        'panel.backup.verify.title': 'Verification',
        'panel.backup.verify.counts': 'snapshots {snapshots} · files {files} · blocks {blocks} · old {old} · current {current}',
        'panel.backup.verify.futureAppend': 'future append: checked {checked}, failed {failed}',
        'panel.backup.verify.runtime': 'Runtime verdict with the installed Harness (slow)',
        'panel.backup.verify.runtimeCounts': 'runtime validation: checked {checked}, failed {failed}',
        'panel.backup.verify.runtimeHint': 'Validates every session and its appended log with the installed Harness; this can take minutes and requires a Harness installation on this machine.',
        'panel.backup.verify.problems': 'Problems ({count})',
        'panel.backup.verify.problem': '{code} · {file} · {detail}',
        'panel.backup.verify.clean': 'No problems found.',
        // v3.5.x cached runtime verdict (G5): the slow path is shown from the persisted record first; the
        // "run now" button is the only control that spawns it synchronously.
        'panel.backup.verify.cachedTitle': 'Cached runtime verdict',
        'panel.backup.verify.cachedLine': 'last {time} · checked {checked}, failed {failed} · {snapshots} snapshot(s) · evidence {evidence}',
        'panel.backup.verify.cachedNone': 'No cached runtime verdict yet: use "Run now (slow)" to produce one; this block then shows the most recent result.',
        'panel.backup.verify.stale': 'stale (older than 24 h)',
        'panel.backup.verify.fresh': 'within 24 h',
        'panel.backup.plan.title': 'Restore plan (read-only, nothing written yet)',
        'panel.backup.plan.empty': 'No restore plan yet: click "Build restore plan" to read the latest snapshot.',
        'panel.backup.plan.source': 'Source snapshot',
        'panel.backup.plan.summary': 'sessions {sessions} · new {new} · identical {identical} · conflicts {conflicts} · attachments {attachments}',
        'panel.backup.plan.selected': '{count}/{total} selected',
        'panel.backup.plan.selectAll': 'Select all',
        'panel.backup.plan.clear': 'Clear selection',
        'panel.backup.plan.danger': 'Restoring overwrites the target session files (a pre-restore copy is taken first). This writes to disk: click "Confirm restore" again to proceed.',
        'panel.backup.plan.snapshotMissing': 'Without a snapshot id the latest valid snapshot is used.',
        'panel.backup.conflict.new': 'new',
        'panel.backup.conflict.identical': 'identical',
        'panel.backup.conflict.differs': 'differs',
        'panel.backup.unlock.title': 'Unlock',
        'panel.backup.unlock.initialized': 'The repository is initialised; its key envelopes can be read.',
        'panel.backup.unlock.notInitialized': 'The repository is not initialised yet; the first backup creates the key envelopes.',
        'panel.backup.unlock.envelopes': 'Envelopes: {kinds}',
        'panel.backup.unlock.machineAvailable': 'Machine credentials are available: the local DPAPI envelope unlocks without a password.',
        'panel.backup.unlock.machineUnavailable': 'Machine credentials are unavailable ({reason}): only the password path remains.',
        'panel.backup.unlock.passwordPath': 'A password never travels over HTTP: this panel neither accepts nor sends one. Use the password path in a local terminal: w2m-backup unlock --check --password-stdin (the password is read from stdin only).',
        'panel.backup.unlock.noPassword': 'This repository has no password envelope, so another machine cannot unlock it with a password.',
        'panel.backup.unlock.none': 'The repository is unencrypted: it unlocks without an account or a PIN. This is an "avoid mistakes" statement, not confidentiality.',
        'panel.backup.unlock.passwordHint': 'This is not the original account: use the 4-6 digit PIN in a local terminal (a PIN never travels over HTTP; this panel neither accepts nor sends one).',
        'panel.backup.unlock.weakPinHint': 'A 4-digit PIN is only a convenience gate, not confidentiality.',
        'panel.backup.unlock.disableProtectionHint': '"Turn protection off" means anyone who can see the repository directory can restore it without a credential; run w2m-backup unlock --disable-protection --confirm disable-protection in a terminal (keys.json is copied first).',
        // v3.5.x account-id binding (compare-only: allow when the id matches, otherwise the password path).
        'panel.backup.unlock.accountBound': 'Bound original account: {hint} (last four characters only)',
        'panel.backup.unlock.accountMatched': 'This machine\'s account matches the original account, so it can unlock directly.',
        'panel.backup.unlock.accountMismatch': 'This is not the original account: use the unlock password.',
        'panel.backup.unlock.accountUnavailable': 'The host account id is unavailable (not signed in, or account binding is switched off): use the unlock password.',
        'panel.backup.action.unlockAccount': 'Unlock as the original account',
        'panel.backup.unlock.done': 'Unlocked via {via}.',
        // v3.5.x unlock dialog: a real modal; the card keeps its description and old buttons, the dialog is
        // the action surface. Option A sends only the confirm token (the credential stays in the host);
        // option B has no password field -- it shows the copyable terminal command instead.
        'panel.backup.unlock.dialog.open': 'Unlock…',
        'panel.backup.unlock.dialog.title': 'Unlock the backup repository',
        'panel.backup.unlock.dialog.subtitle': 'Unlocking only affects this machine and does not change the repository.',
        'panel.backup.unlock.dialog.state.none': 'Current protection: not encrypted (default)',
        'panel.backup.unlock.dialog.state.accountMatched': 'Current protection: this account matches the original account',
        'panel.backup.unlock.dialog.state.accountMismatch': 'Current protection: this is not the original account',
        'panel.backup.unlock.dialog.state.unbound': 'Current protection: no original account is bound here',
        'panel.backup.unlock.dialog.state.unknown': 'Current protection: unknown (the unlock description is not readable yet)',
        'panel.backup.unlock.dialog.optionA': 'Unlock with this machine / the original account',
        'panel.backup.unlock.dialog.optionAHint': 'The credential stays in the host process: the browser sends only the confirmation token {"confirm":"unlock"}.',
        'panel.backup.unlock.dialog.localUnavailable': 'Neither the machine credential nor the original account is available: use the terminal password path below.',
        'panel.backup.unlock.dialog.optionB': 'Use the unlock password (type it in a terminal)',
        'panel.backup.unlock.dialog.optionBHint': 'A password never travels through the browser: run the command below in a local terminal; the password is read from stdin only.',
        'panel.backup.unlock.dialog.hintLabel': 'Password hint: {hint}',
        'panel.backup.unlock.dialog.hintNone': 'No password is set: this repository has no PIN and no hint yet.',
        // The earlier "no PIN rotation" decision is reversed: rotation exists, but runs in a terminal only (there is
        // still no password input anywhere in the browser).
        'panel.backup.unlock.dialog.rotation': 'Rotation runs in a terminal: open with the old credential → drop the old PIN → write the new PIN (the old PIN stops working).',
        'panel.backup.unlock.dialog.rotationCommand': 'Rotation command (copy only; never executed from this panel)',
        'panel.backup.unlock.dialog.noPasswordNeeded': 'The repository is not encrypted: no password is needed; use the option above.',
        'panel.backup.unlock.dialog.commandCaption': 'Command',
        'panel.backup.unlock.dialog.copy': 'Copy command',
        'panel.backup.unlock.dialog.copied': 'Copied',
        'panel.backup.unlock.dialog.refresh': 'I ran it, refresh the state',
        'panel.backup.unlock.dialog.refreshing': 'Refreshing…',
        'panel.backup.unlock.dialog.close': 'Close',
        'panel.backup.unlock.dialog.busy': 'Unlocking…',
        'panel.backup.unlock.dialog.failed': 'Unlock failed: {reason}',
        'panel.backup.unlock.dialog.success': 'Unlocked via {via}; the state has been refreshed.',
        'panel.backup.unlock.dialog.passwordNeverInBrowser': 'A password never enters the browser and never travels over HTTP; this panel neither accepts nor sends one.',
        'panel.backup.unlock.dialog.disableProtection': 'Turn protection off (copy only; never executed from this panel)',
        'panel.backup.log.title': 'Run log (last {max})',
        'panel.backup.log.empty': 'No operations yet.',
        'panel.backup.log.ok': 'ok',
        'panel.backup.log.run': 'backup',
        'panel.backup.log.plan': 'plan',
        'panel.backup.log.restore': 'restore',
        'panel.backup.log.archive': 'archive',
        'panel.backup.log.verify': 'verify',
        'panel.backup.log.unlock': 'unlock',
        'panel.backup.error.title': 'Operation failed',
        'panel.backup.busy.run': 'running backup…',
        'panel.backup.busy.restore': 'restoring…',
        'panel.backup.busy.plan': 'building the plan…',
        'panel.backup.busy.archive': 'packing…',
        'panel.backup.busy.verify': 'verifying…',
        'panel.backup.busy.unlock': 'unlocking…',
        'panel.backup.reason.BACKUP_NO_PERMISSION': 'No permission: sign in with the original account, or enter the unlock password',
        'panel.backup.reason.BACKUP_ACCOUNT_MISMATCH': 'This is not the original account: the unlock password path is required',
        'panel.backup.reason.BACKUP_ROUTE_MISSING': 'The backup subplugin is not mounted: enable the dsh-backup row and retry.',
        'panel.backup.reason.BACKUP_UNREACHABLE': 'The host plugin could not be reached; retry shortly.',
        'panel.backup.reason.BACKUP_BAD_RESPONSE': 'The host answered with a body that is not JSON.',
        'panel.backup.reason.BACKUP_BUSY': 'A backup is already running; wait for it.',
        'panel.backup.reason.BACKUP_LOCKED': 'Another process holds the repository lock; retry later.',
        'panel.backup.reason.BACKUP_REPO_NOT_INITIALIZED': 'The repository is not initialised: run "Run backup now" once.',
        'panel.backup.reason.BACKUP_REPO_SNAPSHOT_MISSING': 'The repository has no restorable snapshot yet.',
        'panel.backup.reason.BACKUP_KEY_UNWRAP_FAILED': 'The repository key cannot be unwrapped: machine credentials are unavailable; use the password path.',
        'panel.backup.reason.BACKUP_SCOPE_INVALID': 'The backup scope is invalid.',
        'panel.backup.reason.BACKUP_SCOPED_NOTHING': 'No session matched the selected scope.',
        'panel.backup.reason.BACKUP_WRITE_FAILED': 'Writing the repository failed: check free space and directory permissions.',
        'panel.backup.reason.BACKUP_DISK_FULL': 'The disk is full; the backup did not finish.',
        'panel.backup.reason.BACKUP_DIR_DENIED': 'The backup directory is not writable.',
        'panel.backup.reason.BACKUP_SCAN_HOME_MISSING': 'DSH_HOME is missing, so sessions cannot be enumerated.',
        'panel.backup.reason.BACKUP_RESTORE_NO_SESSION': 'The snapshot contains none of the requested sessions.',
        'panel.backup.reason.BACKUP_CANDIDATE_INVALID': 'A candidate session failed validation.',
        'panel.backup.reason.BACKUP_RESTORE_TARGET_CHANGED': 'A restore target changed after planning; build a fresh plan.',
        'panel.backup.reason.BACKUP_REGISTRY_WRITE_FAILED': 'Writing the workspace registry failed.',
        'panel.backup.reason.BACKUP_REGISTER_NO_SESSION': 'No session was named to register.',
        'panel.backup.reason.BACKUP_REGISTER_SESSION_MISSING': 'That session is not on disk (register only makes an existing session visible; it never creates one).',
        'panel.backup.reason.BACKUP_REGISTER_BACKUP_FAILED': 'The registry copy could not be written; nothing was changed.',
        'panel.backup.reason.BACKUP_VERIFY_BUSY': 'A runtime verdict is already running; wait for it.',
        'panel.backup.reason.BACKUP_ATTACHMENT_CONFLICT': 'An attachment object conflicts; the restore stopped.',
        'panel.backup.reason.BACKUP_RESTORE_VERIFY_FAILED': 'The read-back verification after restoring failed.',
        'panel.backup.reason.BACKUP_ARCHIVE_EMPTY': 'There is no archived session to pack.',
        'panel.backup.reason.BACKUP_ARCHIVE_UNREADABLE': 'The archive or repository content is unreadable.',
        'panel.backup.reason.BACKUP_MANIFEST_DIGEST_MISMATCH': 'Repository bytes no longer match the manifest digest; the data may have been changed.',
        'panel.backup.reason.BACKUP_OBJECT_MISSING': 'A repository object block is missing.',
        'panel.backup.reason.BACKUP_DECRYPT_AUTH_FAILED': 'Block authentication failed; the data may have been tampered with.',
        'panel.backup.reason.BACKUP_INDEX_MISMATCH': 'The index disagrees with the snapshots on disk.',
        'panel.backup.reason.BACKUP_REPO_SNAPSHOT_INVALID': 'A snapshot file is invalid.',
        'panel.backup.reason.BACKUP_FUTURE_APPEND_FAILED': 'The future-append check failed.',
        'panel.backup.reason.BACKUP_RUNTIME_APPEND_FAILED': 'The runtime append check failed.',
        'panel.backup.reason.BACKUP_RUNTIME_UNAVAILABLE': 'No runtime validation environment is available here.',
        'panel.backup.reason.BACKUP_RUNTIME_REJECTED': 'The runtime rejected a candidate session.',
        'panel.backup.reason.BACKUP_CONFIRM_REQUIRED': 'The request carried no confirmation token and was refused.',
        'panel.backup.reason.BACKUP_CONFIG_INVALID': 'Invalid backup configuration: the protection mode must be none (unencrypted) or sealed (encrypted).',
        // v3.5.0 full whole-file copy cap: the engine refuses before writing; a human "特批" re-runs the same backup.
        'panel.backup.reason.BACKUP_FULL_COPY_APPROVAL_REQUIRED': 'A whole-file old copy exceeds the 300 MB cap: nothing was written; the run needs an explicit approval to continue.',
        'panel.backup.approval.open': 'Review and approve',
        'panel.backup.approval.pending': '{count} session(s) have old-version copies over {cap} MB and need approval',
        'panel.backup.approval.pendingHint': 'A scheduled backup never waits for a person: this run refused before writing anything, so the repository is untouched. Use "Review and approve" to approve this one write.',
        'panel.backup.approval.dialog.title': 'Whole-file copy over the cap: approval required',
        'panel.backup.approval.dialog.subtitle': '{count} session(s) would get an old-version full copy over {cap} MB. The approval covers this write only; the old-version record is marked approved_over_cap.',
        'panel.backup.approval.dialog.session': '{id} · {size} (cap {cap})',
        'panel.backup.approval.dialog.more': '{count} more session(s) are not listed',
        'panel.backup.approval.dialog.hint': 'Never approved automatically: only "Approve and continue" re-sends this backup and writes; "Cancel" sends no request at all.',
        'panel.backup.approval.confirm': 'Approve and continue',
        'panel.backup.approval.cancel': 'Cancel',
        'panel.backup.approval.close': 'Close',
        'panel.backup.approval.busy': 'writing with the approval…',
        // v3.5.0 §24.3: no total cap on old/; the reminder is per growth since the last acknowledgement and
        // "Got it" only moves the mark. "How to clean up" expands the gc guidance; there is no delete button.
        'panel.backup.oldUsage.title': 'Old-version usage reminder',
        'panel.backup.oldUsage.banner': 'old/ is using {bytes} GB ({growth} GB more since the last acknowledgement): consider cleaning up manually',
        'panel.backup.oldUsage.hint': 'The old-version directory has no total cap; this is only a reminder -- backups never delete files automatically.',
        'panel.backup.oldUsage.ack': 'Got it',
        'panel.backup.oldUsage.howTo': 'How to clean up',
        'panel.backup.oldUsage.guidance': 'Cleanup is manual: run `w2m-backup gc --dry-run` first to preview, then `w2m-backup gc --max-old-days <n>` (or lower the per-session keep count). The panel never deletes any file.',
        'panel.backup.oldUsage.ackDone': 'Acknowledged (nothing was deleted)',
        'panel.backup.busy.oldUsageAck': 'acknowledging…',
        'panel.backup.log.ackOldUsage': 'acknowledge old usage',
        'panel.backup.reason.BACKUP_FAILED': 'The operation failed.',
        // v3.5.0 panel completion: backup-scope entries (selected sessions / currently active sessions / all).
        // The session list comes from the read-only `GET /api/w2m/backup/scan?detail=1`; the panel only puts
        // the selection into the run request body and never writes anything itself.
        'panel.backup.action.backupSelected': 'Back up selected sessions',
        'panel.backup.action.backupActive': 'Back up all active sessions',
        'panel.backup.scope.hint': 'Tick sessions and use "Back up selected sessions" to back up only those; "Back up all active sessions" skips archived sessions; "Run backup now" backs up everything, archived included.',
        'panel.backup.pick.title': 'Sessions to back up',
        'panel.backup.pick.count': '{n}/{m} selected',
        'panel.backup.pick.selected': 'Select all',
        'panel.backup.pick.clear': 'Clear selection',
        'panel.backup.pick.refresh': 'Refresh sessions',
        'panel.backup.pick.loading': 'Reading the session list…',
        'panel.backup.pick.unavailable': 'This host has no backup scan route mounted, or the scan failed. Use "Refresh sessions" to retry.',
        'panel.backup.pick.empty': 'No sessions to back up.',
        'panel.backup.pick.archivedTag': 'archived',
        'panel.backup.busy.backupSelected': 'backing up the selected sessions…',
        'panel.backup.busy.backupActive': 'backing up the active sessions…',
        'panel.backup.busy.verifyRuntime': 'running the runtime verdict…',
        'panel.backup.busy.repairRegister': 'repairing the registration…',
        'panel.backup.log.backupSelected': 'backup selected',
        'panel.backup.log.backupActive': 'backup active',
        'panel.backup.log.verifyRuntime': 'runtime verdict',
        'panel.backup.log.repairRegister': 'repair registration',
        // v3.5.0 fleet version card (operation panel → actions tab): reads the host's read-only
        // `versions` block, displays the drift and dispatches nothing.
        'panel.fleet.version.title': 'Fleet versions',
        'panel.fleet.version.supportedMin': 'Supported minimum',
        'panel.fleet.version.distribution': 'Distribution',
        'panel.fleet.version.outdated': 'Outdated machines',
        'panel.fleet.version.unknown': 'Unknown versions',
        'panel.fleet.version.allCurrent': 'All current',
        'panel.fleet.version.refresh': 'Refresh',
        'panel.fleet.version.copyGuidance': 'Copy upgrade guidance',
        'panel.fleet.version.copied': 'Copied',
        'panel.fleet.version.unavailable': 'Version information unavailable: the host sent no version block, or the roster could not be read',
        'panel.fleet.version.noOutdated': 'No outdated machines',
        'panel.fleet.version.guidanceTitle': 'Upgrade to @twinsearth/w2m-dsh-plugin@{version}',
      },
    };

    /**
     * A translator over {@link DICT}, preferring the shell's locale service.
     *
     * `{name}` substitution is deliberately the only templating: these strings have one variable
     * each, and a message format would be a dependency this package does not have.
     *
     * @param localeOf - the shell's locale service, or a function returning it (read at lookup time).
     *   Passed in rather than read from `ctx` here: the service is optional, and reading an optional
     *   service off the context is the one operation in this file that can kill the page (see
     *   {@link readOptionalService}). A function is accepted because the service may arrive *after*
     *   this entry activates — the shell's `bind()` is live, so a deferred read still localises.
     * @returns {(key: string, values?: object) => string}
     */
    function makeTranslator(localeOf) {
      const resolveLocale = () => (typeof localeOf === 'function' ? localeOf() : localeOf);
      return (key, values) => {
        const locale = resolveLocale();
        const bound = typeof locale?.bind === 'function' ? locale.bind(NS) : null;
        const template = bound === null
          ? (DICT.zh[key] ?? DICT.en[key] ?? key)
          : bound(key, values);
        const text = typeof template === 'string' && template !== '' ? template : (DICT.en[key] ?? key);
        if (values === undefined) return text;
        return text.replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])));
      };
    }

    /**
     * Read a service the composition may or may not provide, without the inject requirement.
     *
     * `ctx.get(name)` is Cordis's inject-free lookup, and it is the only correct way to read an
     * *optional* service from a plugin: `ctx[name]` throws for anything the fiber did not declare as
     * a dependency, and declaring it would make the service *required* — an entry whose declared
     * dependency never arrives never activates either, which is fatal in exactly the same way. So a
     * carrier that must not be able to block the control (`locale`) is read here, and a service the
     * control cannot work without (`slots`) is declared in {@link inject}.
     *
     * @param ctx - the client plugin context.
     * @param name - the service name.
     * @returns the service, or undefined when the composition has none (or this is not a Cordis
     *   context at all, which is how `test/client-bundle.test.mjs` applies this bundle).
     */
    function readOptionalService(ctx, name) {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
    }

    /**
     * Register {@link DICT} with the shell's locale service whenever that service exists.
     *
     * Two paths, one outcome. When the service is already up, the registration is an effect of this
     * entry and goes away with it. When it is not up yet, the registration rides a **child fiber**
     * (`ctx.inject`) that waits for `locale` without holding this entry back: declaring `locale` in
     * {@link inject} instead would make it required, and a composition without a locale service
     * would then report this entry as `pending` — which the shell's audit treats exactly like
     * `failed`, i.e. the page does not boot. A missing localisation service must never cost an
     * operator the control, and must never cost them the app.
     *
     * @param ctx - the client plugin context.
     * @param locale - the shell's locale service, or undefined when the composition has none.
     */
    function registerDictionaries(ctx, locale) {
      if (typeof locale?.register === 'function') {
        ctx.effect(() => locale.register(NS, DICT), 'w2m: composer target control dictionaries');
        return;
      }
      if (typeof ctx?.inject !== 'function') return;
      ctx.inject(['locale'], (localeCtx) => {
        localeCtx.effect(() => localeCtx.locale.register(NS, DICT), 'w2m: composer target control dictionaries');
      });
    }

    /** One JSON call to the host half, folded into a value: a refusal is never an exception here. */
    async function callHost(options) {
      let response;
      try {
        response = await fetch(options.url, options.init);
      } catch (error) {
        return { ok: false, error: `the plugin could not be reached: ${error instanceof Error ? error.message : String(error)}`, status: 0 };
      }
      if (response.status === 404) {
        return { ok: false, status: 404, error: 'this host does not serve the W2M target route' };
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        return { ok: false, status: response.status, error: `the plugin answered HTTP ${response.status} with a body that is not JSON` };
      }
      if (response.ok !== true) {
        return { ok: false, status: response.status, error: typeof body?.error === 'string' ? body.error : `HTTP ${response.status}` };
      }
      return { ok: true, status: response.status, state: body };
    }

    const readState = (sessionId, signal) => callHost({
      url: `${ROUTE}?session_id=${encodeURIComponent(sessionId)}`,
      init: { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, signal },
    });

    const writeSelection = (sessionId, machineId, machineName) => callHost({
      url: ROUTE,
      init: {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ session_id: sessionId, machine_id: machineId, machine_name: machineName }),
      },
    });

    /** One JSON call to the capability route: refusals are values, exactly like the target route. */
    async function callCapability(options) {
      let response;
      try {
        response = await fetch(options.url, options.init);
      } catch (error) {
        return { ok: false, error: 'the plugin could not be reached: ' + (error instanceof Error ? error.message : String(error)) };
      }
      if (response.status === 404) return { ok: false, status: 404, routeMissing: true, error: 'capability route missing' };
      let body = null;
      try { body = await response.json(); } catch { return { ok: false, error: 'the capability route answered HTTP ' + response.status } }
      if (response.ok !== true) return { ok: false, status: response.status, error: typeof body?.error === 'string' ? body.error : 'HTTP ' + response.status };
      return { ok: true, capacity: body?.capability ?? null };
    }
    const readCapability = (signal) => callCapability({ url: CAPABILITY_ROUTE, init: { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, signal } });
    const writeCapability = (state, ttlMs) => callCapability({ url: CAPABILITY_ROUTE, init: { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(ttlMs === undefined ? { state } : { state, ttl_ms: ttlMs }) } });

    const labelOf = (state, t) => state?.selected?.machine_id != null
      ? (state.selected.name ?? state.selected.machine_id)
      : t('all');

    /** The one-line reason the list cannot be trusted, or null when it can. */
    function fleetProblem(state, t) {
      if (state === null || state === undefined) return null;
      if (state.host?.detail_unavailable === true) return t('routeMissing');
      if (state.fleet?.ok === true) return null;
      return state.fleet?.error ?? t('fleetUnreadable');
    }

    // -------------------------------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------------------------------
    //
    // Token colours only: `--dsw-*` is the shell's own theme surface, so the control follows the
    // light/dark switch instead of inventing a palette that is wrong in one of them. The geometry
    // (28px height, `--dsw-radius-sm`, 13px/500 label, 4px gap, 8px leading pad) is copied from the
    // shipped permission trigger in the same row, and the status dot uses the theme's state colours:
    // business blue for this machine, success green for a reachable peer, warn/error for the two
    // states that are not "ready".
    const TAG_ID = '@twinsearth/w2m-dsh-plugin/TargetSelect.css';
    const CSS = [
      '.w2mTarget_trigger{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:220px;min-width:0;',
      'padding:0 4px 0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;',
      'color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px;cursor:pointer;outline:none}',
      '.w2mTarget_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.w2mTarget_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.w2mTarget_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.w2mTarget_dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);',
      'box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
      '.w2mTarget_dot[data-state="local"]{background:var(--dsw-alias-state-business-primary)}',
      '.w2mTarget_dot[data-state="online"]{background:var(--dsw-alias-state-success-primary)}',
      '.w2mTarget_dot[data-state="stale"]{background:transparent;border:1px solid var(--dsw-alias-state-warn-primary)}',
      '.w2mTarget_dot[data-state="none"]{background:transparent;border:1px solid var(--dsw-alias-label-caption)}',
      '.w2mTarget_label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.w2mTarget_chevron{flex:none;display:inline-flex;color:var(--dsw-alias-label-caption);transition:transform .12s}',
      '.w2mTarget_chevron[data-open="true"]{transform:rotate(180deg)}',
      '.w2mTarget_menu{position:fixed;z-index:60;box-sizing:border-box;min-width:200px;max-width:300px;',
      'padding:4px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);',
      'font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.w2mTarget_note{padding:6px 8px;color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.w2mTarget_relayFold{margin-top:2px;padding:4px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.w2mTarget_relayToggle{display:block;width:100%;box-sizing:border-box;padding:4px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;text-align:left;cursor:pointer}',
      '.w2mTarget_relayToggle[data-temporary="true"]{color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '.w2mTarget_relayFold[data-temporary="true"]{border-top-color:var(--dsw-alias-state-error-primary)}',
      '.w2mTarget_relayRow{display:flex;align-items:center;gap:6px;padding:2px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.w2mTarget_relayRole{flex:none;min-width:44px;color:var(--dsw-alias-label-tertiary)}',
      '.w2mTarget_relayUrl{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.w2mTarget_relayRtt{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}',
      '.w2mTarget_relayHint{padding:2px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.w2mTarget_groupHead{padding:6px 8px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary);font-weight:600;letter-spacing:.02em}',
      '.w2mTarget_groupToggle{display:block;width:100%;box-sizing:border-box;margin-top:2px;padding:5px 8px;border:none;border-radius:var(--dsw-radius-sm);border-top:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;text-align:left;cursor:pointer}',
      '.w2mTarget_groupToggle:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.w2mTarget_groupToggle[data-open="true"]{color:var(--dsw-alias-label-primary)}',
      '.w2mTarget_option{display:block;width:100%;box-sizing:border-box;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.w2mTarget_option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.w2mTarget_option:disabled{cursor:default;color:var(--dsw-alias-label-dimmed)}',
      '.w2mTarget_option[data-active="true"]{color:var(--dsw-alias-state-business-primary)}',
      '.w2mTarget_row{display:flex;align-items:center;gap:8px}',
      '.w2mTarget_name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.w2mTarget_detail{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}',
      '.w2mTarget_option:disabled .w2mTarget_detail{color:var(--dsw-alias-label-caption)}',
      '.w2mCap{position:relative;display:inline-flex;align-items:center}',
      '.w2mCap_trigger{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px;cursor:pointer;outline:none}',
      '.w2mCap_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.w2mCap_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.w2mCap_trigger[data-on="true"]{color:var(--dsw-alias-state-warn-primary)}',
      '.w2mCap_dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
      '.w2mCap_dot[data-on="true"]{background:var(--dsw-alias-state-warn-primary)}',
        '.w2mGpw_launcher{position:fixed;right:16px;bottom:96px;z-index:55;padding:6px 10px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}',
        '.w2mGpw_launcher:hover{background:var(--dsw-alias-bg-layer-2)}',
        // v3.3.0: 聊天框只保留「历史对话」按钮；旧控件仍在（路由/探针不变），但不再占用界面。
        '.w2mJqDockChip{display:none!important}',
        '.w2mHistWrap{position:relative;display:inline-flex;align-items:center}',
        '.w2mHistBtn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}',
        '.w2mHistBtn:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.w2mHistWindow{position:absolute;left:0;bottom:calc(100% + 8px);z-index:80;display:flex;flex-direction:column;width:min(460px,calc(100vw - 32px));max-height:min(52vh,460px);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);overflow:hidden}',
        '.w2mHistHead{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-default)}',
        '.w2mHistTitle{flex:1;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.w2mHistHint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mHistClose{height:24px;padding:0 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}',
        '.w2mHistList{display:flex;flex-direction:column;gap:4px;padding:8px;overflow:auto;min-height:0}',
        '.w2mHistItem{display:flex;align-items:flex-start;gap:6px;text-align:left;padding:6px 8px;border-radius:8px;border:.5px solid transparent;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}',
        '.w2mHistItem:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}',
        '.w2mHistTag{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);padding-top:1px}',
        '.w2mHistItemText{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}',
        '.w2mHistMeta{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);padding-top:2px}',
        '.w2mHistEmpty{padding:14px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}',
        '.w2mHistStatus{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);border-top:.5px solid var(--dsw-alias-border-default)}',
        '.w2mOpsPanel{display:flex;flex-direction:column;gap:8px;padding:4px 0}',
        '.w2mOpsNav{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 6px}',
        '.w2mOpsTab{height:28px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
        '.w2mOpsTab[data-active="true"]{border-color:var(--dsw-alias-state-info-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary);font-weight:600}',
        '.w2mOpsBody{display:flex;flex-direction:column;gap:8px;min-height:0}',
        '.w2mOpsSection{display:flex;flex-direction:column;gap:8px}',
        '.w2mOpsRow{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
        '.w2mOpsStat{font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.w2mOpsCard{display:flex;flex-direction:column;gap:4px;padding:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
        '.w2mOpsCardTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.w2mOpsMeta{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
        '.w2mOpsEmpty{font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.w2mOpsBtn{height:26px;padding:0 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
        '.w2mOpsBtnPrimary{border-color:var(--dsw-alias-state-info-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-info-primary,var(--dsw-alias-label-primary));font-weight:600}',
        // v3.5.0: 编队版本卡片。只用宿主主题变量（--dsw-alias-*），窄宽度下整块换行。
        '.w2mVerCard{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.w2mVerHead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}',
        '.w2mVerTitle{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.w2mVerBadge{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
        '.w2mVerBadge[data-tone="ok"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
        '.w2mVerGroup{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.w2mVerMeta{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
        '.w2mVerRows{display:flex;flex-wrap:wrap;gap:2px 10px;min-width:0}',
        '.w2mVerRow{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
        '.w2mVerList{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.w2mVerItem{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
        '.w2mVerItem[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
        '.w2mVerItem[data-tone="unknown"]{color:var(--dsw-alias-label-tertiary)}',
        '.w2mVerNote{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mOpsAdmin{margin-top:10px}',
        '.w2mOpsAdminSummary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.w2mAiPanel{display:flex;flex-direction:column;gap:8px;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
        '.w2mAiSummary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}',
        '.w2mAiTitle{flex:1;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.w2mAiChip{font-size:11px;padding:1px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2)}',
        '.w2mAiChip[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
        '.w2mAiChip[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
        '.w2mAiHint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
        '.w2mAiGrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
        '.w2mAiField{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.w2mAiFieldWide{grid-column:1 / -1}',
        '.w2mAiLabel{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mAiInput{height:28px;padding:0 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;min-width:0}',
        '.w2mAiActions{display:flex;flex-wrap:wrap;gap:6px}',
        '.w2mAiBtn{height:28px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
        '.w2mAiBtnPrimary{border-color:var(--dsw-alias-state-info-primary,var(--dsw-alias-border-l2));font-weight:600}',
        '.w2mAiFeedback{display:flex;align-items:flex-start;gap:6px;font-size:11px;line-height:17px;padding:6px 8px;border-radius:8px;border:.5px solid transparent}',
        '.w2mAiFeedback[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}',
        '.w2mAiFeedback[data-tone="err"]{color:var(--dsw-alias-state-danger-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary) 40%,transparent)}',
        '.w2mAiFeedback[data-tone="info"]{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}',
        '.w2mOpsPanel .w2mTarget_trigger{display:inline-flex!important}',
        '.w2mOpsPanel .w2mCap_trigger{display:inline-flex!important}',
        '.w2mGpw_prompt{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
        '.w2mGpw_promptLabel{font-size:12px;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary))}',
        '.w2mGpw_badge{display:inline-block;min-width:16px;padding:0 5px;margin-left:4px;border-radius:999px;border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:14px;text-align:center}',
        '.w2mGpw_overlay{position:fixed;inset:0;z-index:70;background:color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);display:flex;align-items:flex-end;justify-content:flex-end;padding:16px}',
        '.w2mGpw_card{width:420px;max-width:calc(100vw - 32px);max-height:min(80vh,640px);overflow:auto;box-sizing:border-box;padding:10px 12px;border-radius:var(--dsw-radius-xl);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}',
        '.w2mGpw_head{display:flex;align-items:center;justify-content:space-between}',
        '.w2mGpw_close{width:24px;height:24px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:16px}',
        '.w2mGpw_title{font-size:12px;font-weight:600}',
        '.w2mGpw_block{display:flex;flex-direction:column;gap:4px;margin-top:2px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-default)}',
        '.w2mGpw_row{display:flex;align-items:center;gap:6px;min-width:0}',
        '.w2mGpw_path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.w2mGpw_input{box-sizing:border-box;width:100%;padding:5px 8px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;outline:none}',
        '.w2mGpw_dot{flex:none;display:inline-block;width:8px;height:8px;border-radius:999px;margin-right:4px}',
        '.w2mGpw_dot[data-c="green"]{background:var(--dsw-alias-state-success-primary)}',
        '.w2mGpw_dot[data-c="blue"]{background:var(--dsw-alias-state-business-primary)}',
        '.w2mGpw_dot[data-c="yellow"]{background:var(--dsw-alias-state-warn-primary)}',
        '.w2mGpw_dot[data-c="red"]{background:var(--dsw-alias-state-danger-primary)}',
        '.w2mGpw_legend{display:flex;gap:10px;align-items:center;font-size:12px}',
        '.w2mGpw_legendItem{display:inline-flex;align-items:center;gap:2px}',
        '.w2mGpw_actions{display:flex;flex-wrap:wrap;gap:6px}',
        '.w2mGpw_btn{padding:3px 8px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}',
        '.w2mGpw_btn:disabled{opacity:.5;cursor:default}',
        '.w2mGpw_small{width:22px;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.w2mGpw_recent{border:.5px solid var(--dsw-alias-border-default);border-radius:var(--dsw-radius-md);padding:4px 6px;display:flex;flex-direction:column;gap:3px}',
        '.w2mGpw_tag{flex:none;font-size:11px;padding:0 5px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2)}',
        '.w2mGpw_tag[data-d="deny"]{border-color:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-state-danger-primary)}',
        '.w2mGpw_note{font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.w2mGpw_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mDc_level{display:flex;flex-direction:column;gap:4px}',
        '.w2mDc_ticket{display:flex;flex-direction:column;gap:4px;padding:5px 7px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-default);background:var(--dsw-alias-bg-layer-2)}',
        '.w2mDc_head{display:flex;align-items:center;gap:6px;min-width:0}',
        '.w2mDc_title{flex:1;min-width:0;font-size:12px;line-height:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.w2mDc_meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mDc_context{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:88px;overflow:auto}',
        '.w2mDc_actions{display:flex;flex-wrap:wrap;gap:6px}',
        '.w2mDc_advice{font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 6px;border-left:2px solid var(--dsw-alias-state-business-primary);white-space:pre-wrap}',
        '.w2mDcBadge{position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:58;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;cursor:pointer}',
        '.w2mGpwAi{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-default)}',
        '.w2mGpwAiSummary{cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.w2mGpwAiStatus{font-size:11px;color:var(--dsw-alias-label-secondary)}',
        '.w2mGpwCountdown{font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
        '.w2mGpwAiReason{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
        '.w2mGpwRedOverlay{position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent)}',
        '.w2mGpwRedCard{display:flex;flex-direction:column;gap:6px;width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:14px;border-radius:14px;border:.5px solid var(--dsw-alias-state-danger-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);font-size:13px;line-height:20px}',
        '.w2mGpwRedTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcBadge[data-tone="idle"]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
        '.w2mDcBadge[data-tone="red"]{border-color:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcBadge[data-tone="yellow"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
        '.w2mDcBadge[data-tone="blue"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
        '.w2mDcBadge[data-tone="green"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
        '.w2mDcBadge:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.w2mDcBadge[data-tone="red"]{border-color:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcBadge[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
        '.w2mDcBadgeIcon{font-size:14px;line-height:16px}',
        '.w2mDcBadgeText{letter-spacing:0}',
        '.w2mDcBadgeCount{min-width:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:16px;text-align:center}',
        '.w2mDcBadge[data-tone="red"] .w2mDcBadgeCount{background:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcBadge[data-tone="yellow"] .w2mDcBadgeCount{background:var(--dsw-alias-state-warn-primary)}',
        '.w2mDcBadge[data-tone="blue"] .w2mDcBadgeCount{background:var(--dsw-alias-state-business-primary)}',
        '.w2mDcBadge[data-tone="green"] .w2mDcBadgeCount{background:var(--dsw-alias-state-success-primary)}',
        '.w2mDcOverlay{position:fixed;inset:0;z-index:74;background:color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);display:flex;align-items:center;justify-content:flex-end}',
        '[hidden]{display:none!important}',
        '.w2mDcBadge[hidden],.w2mJqBadge[hidden],.w2mDcBadgeCount[hidden],.w2mDcUnread[hidden],.w2mJqBadgeCount[hidden],.w2mDcError[hidden]{display:none!important}',
        '.w2mDcDrawer{position:relative;display:flex;flex-direction:column;align-self:center;margin-right:14px;width:min(470px,calc(100vw - 28px));height:min(70vh,620px);max-height:70vh;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden}',
        '.w2mDcDrawerHead{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-default)}',
        '.w2mDcDrawerTitle{flex:1;min-width:0;font-size:13px;font-weight:600}',
        '.w2mDcUnread{min-width:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:17px;text-align:center}',
        '.w2mDcFilters,.w2mDcLevels{display:flex;flex-wrap:wrap;gap:6px;padding:6px 12px}',
        '.w2mDcLevels{border-bottom:.5px solid var(--dsw-alias-border-default)}',
        '.w2mDcBody{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;display:flex;flex-direction:column;gap:8px;padding:8px 12px}',
        '.w2mDcBody::-webkit-scrollbar,.w2mJqQueueList::-webkit-scrollbar,.w2mDcContextBody::-webkit-scrollbar{width:8px}',
        '.w2mDcBody::-webkit-scrollbar-thumb,.w2mJqQueueList::-webkit-scrollbar-thumb,.w2mDcContextBody::-webkit-scrollbar-thumb{border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 45%, transparent)}',
        '.w2mDcBody::-webkit-scrollbar-track,.w2mJqQueueList::-webkit-scrollbar-track,.w2mDcContextBody::-webkit-scrollbar-track{background:transparent}',
        '.w2mDcGroup{display:flex;flex-direction:column;gap:6px}',
        '.w2mDcGroupTitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
        '.w2mDcTicket{display:flex;flex-direction:column;gap:6px;padding:8px;border:.5px solid var(--dsw-alias-border-default);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}',
        '.w2mDcTicket[data-level="red"]{border-color:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcTicketHead{display:flex;align-items:center;gap:6px;min-width:0}',
        '.w2mDcDot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-business-primary)}',
        '.w2mDcDot[data-level="red"]{background:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcDot[data-level="yellow"]{background:var(--dsw-alias-state-warn-primary)}',
        '.w2mDcDot[data-level="green"]{background:var(--dsw-alias-state-success-primary)}',
        '.w2mDcDot[data-level="gray"]{background:var(--dsw-alias-label-tertiary)}',
        '.w2mDcTicketTitle{flex:1;min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.w2mDcTag{flex:none;font-size:11px;padding:0 5px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
        '.w2mDcMeta,.w2mDcContext summary{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mDcContextBody{max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dsw-alias-label-secondary);padding-top:2px}',
        '.w2mDcActions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
        '.w2mDcBtn{padding:3px 8px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}',
        '.w2mDcBtn:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.w2mDcBtn:disabled{opacity:.5;cursor:default}',
        '.w2mDcBtnPrimary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-1)}',
        '.w2mDcBtnDanger{color:var(--dsw-alias-state-danger-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-danger-primary) 35%, transparent)}',
        '.w2mDcFilterActive{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-1)}',
        '.w2mDcInput{flex:1;min-width:120px;box-sizing:border-box;padding:3px 8px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;outline:none}',
        '.w2mDcAdvice{padding:4px 6px;border-left:2px solid var(--dsw-alias-state-business-primary);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
        '.w2mDcFooter{flex:0 0 auto;display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-default);font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mDcEmpty,.w2mDcError{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 0}',
        '.w2mDcError{color:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcRedToast{position:fixed;right:16px;top:16px;z-index:90;display:flex;flex-direction:column;gap:6px;max-width:320px;box-sizing:border-box;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-danger-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);font-size:12px;line-height:18px}',
        '.w2mDcRedToastTitle{font-weight:600;color:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcRedToastBody{color:var(--dsw-alias-label-secondary)}',
        '.w2mDcRedToastActions{display:flex;gap:6px}',
        '.w2mDcGpwBtn[data-tone="red"]{color:var(--dsw-alias-state-danger-primary);border-color:var(--dsw-alias-state-danger-primary)}',
        '.w2mJqBadge{position:fixed;right:14px;bottom:52px;z-index:57;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;cursor:pointer}',
        '.w2mJqBadge[data-tone="idle"]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
        '.w2mJqBadge[data-tone="blue"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
        '.w2mJqBadge[data-tone="yellow"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
        '.w2mJqBadge[data-tone="red"]{border-color:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-state-danger-primary)}',
        '.w2mJqBadge:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.w2mJqBadge[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
        '.w2mJqBadgeIcon{font-size:14px;line-height:16px}',
        '.w2mJqBadgeText{letter-spacing:0}',
        '.w2mJqBadgeCount{min-width:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:16px;text-align:center}',
        '.w2mJqBadge[data-tone="blue"] .w2mJqBadgeCount{background:var(--dsw-alias-state-business-primary)}',
        '.w2mJqBadge[data-tone="yellow"] .w2mJqBadgeCount{background:var(--dsw-alias-state-warn-primary)}',
        '.w2mJqBadge[data-tone="red"] .w2mJqBadgeCount{background:var(--dsw-alias-state-danger-primary)}',
        '.w2mJqDrawer{align-self:flex-end;margin-bottom:14px;width:min(470px,calc(100vw - 28px));height:min(60vh,520px);max-height:60vh}',
        '.w2mJqHint{padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-default);font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mJqStatus{padding:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);min-height:16px}',
        '.w2mJqEntry{display:flex;flex-direction:column;gap:6px;padding:8px;border:.5px solid var(--dsw-alias-border-default);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}',
        '.w2mJqEntryHead{display:flex;align-items:center;gap:6px;min-width:0}',
        '.w2mJqEntryKey{flex:1;min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.w2mJqEntryTime{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mJqDraft{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
        '.w2mJqQueueSummary{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mJqQueueList{display:grid;gap:2px;max-height:140px;overflow:auto}',
        '.w2mJqQueueRow{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.w2mJqDockChip{display:inline-flex;align-items:center;gap:6px;margin:2px 0;padding:2px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.w2mJqDockOpen{padding:0 6px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-state-business-primary);font-size:12px;cursor:pointer}',
        '.w2mJqGpwBtn[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
        '.w2mJqSectionHead{margin-top:4px;padding:2px 0;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}',
        '.w2mJqSectionNote{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0}',
        '.w2mJqClientFold{margin-top:8px;border-top:.5px solid var(--dsw-alias-border-default);padding-top:6px}',
        '.w2mJqClientFoldSummary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mJqClientFoldBody{display:flex;flex-direction:column;gap:8px;padding-top:6px;opacity:.85}',
        '.w2mJqOnlyClient{font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 0}',
        '.w2mJqHistoryFold{margin-top:8px;border-top:.5px solid var(--dsw-alias-border-default);padding-top:6px}',
        '.w2mJqHistorySummary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mJqHistoryList{display:flex;flex-direction:column;gap:4px;padding-top:6px}',
        '.w2mJqHistoryRow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px}',
        '.w2mJqHistoryMeta{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary)}',
        '.w2mJqEntryId{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
        '.w2mDcSessionChip{display:flex;align-items:center;gap:6px;padding:4px 12px;border-bottom:.5px solid var(--dsw-alias-border-default);font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.w2mDcSessionText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.w2mDcGroupHead{display:flex;align-items:center;gap:6px}',
        '.w2mDcGroupHead .w2mDcGroupTitle{flex:1}',
        '.w2mDcSelected{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
        '.w2mDcSidePanels{flex:0 0 auto;border-top:.5px solid var(--dsw-alias-border-default);padding:6px 12px;font-size:12px}',
        '.w2mDcSidePanels summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}',
        '.w2mDcSideBody{display:grid;gap:2px;padding-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mDcSideRow{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.w2mDcRelayBtn{position:fixed;right:0;top:calc(50% - 76px);transform:translateY(-50%);z-index:57;display:flex;flex-direction:column;align-items:center;gap:4px;box-sizing:border-box;padding:8px 7px;border:.5px solid var(--dsw-alias-state-warn-primary);border-right:none;border-radius:10px 0 0 10px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:15px;cursor:pointer}',
        '.w2mDcRelayBtn[data-tone="red"]{border-color:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcRelayText{writing-mode:vertical-rl;letter-spacing:2px}',
        '.w2mDcRelayCount{min-width:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-layer-1);font-size:10px;line-height:15px;text-align:center}',
        '.w2mDcRelayBtn[data-tone="red"] .w2mDcRelayCount{background:var(--dsw-alias-state-danger-primary)}',
        '.w2mDcStatusLine{color:var(--dsw-alias-label-secondary)}',
        '.w2mDcBatchResolve,.w2mDcBatchAbandon{font-size:11px;line-height:16px;padding:2px 6px}',
        '.w2mDcPane{display:flex;flex-direction:column;gap:6px;padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
        '.w2mDcPaneHead{display:flex;align-items:center;gap:6px}',
        '.w2mDcPaneTitle{flex:1;min-width:0;font-weight:600;font-size:12px}',
        '.w2mDcPaneEmpty{font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.w2mDcPaneRow{display:flex;align-items:center;gap:6px;min-width:0}',
        '.w2mDcPaneRowTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.w2mGpw{margin-top:6px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-default);display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto}',
        '.w2mGpw_title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.w2mGpw_block{display:flex;flex-direction:column;gap:2px;margin:2px 0 6px}',
        '.w2mGpw_row{display:flex;align-items:center;gap:4px}',
        '.w2mGpw_row .w2mGpw_path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
        '.w2mGpw_path{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
        '.w2mGpw_small{width:20px;padding:0}',
        '.w2mGpw_pending{border:.5px solid var(--dsw-alias-border-default);border-radius:6px;padding:4px 6px;display:flex;flex-direction:column;gap:2px}',
        '.w2mGpw_actions{display:flex;gap:6px}',
      '.w2mCap_menu{position:fixed;z-index:60;box-sizing:border-box;width:280px;padding:4px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.w2mCap_option{display:block;width:100%;box-sizing:border-box;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.w2mCap_option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.w2mCap_option[data-active="true"]{color:var(--dsw-alias-state-business-primary)}',
      '.w2mCap_note{padding:6px 8px;color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.w2mChat{position:relative;display:inline-flex;align-items:center}',
      '.w2mChat_trigger{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px;cursor:pointer;outline:none}',
      '.w2mChat_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.w2mChat_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.w2mChat_panel{position:fixed;right:16px;bottom:88px;z-index:60;display:flex;flex-direction:column;width:340px;max-height:420px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden}',
      '.w2mChat_head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-weight:600}',
      '.w2mChat_usage{margin-left:auto;font-weight:400;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.w2mChat_close{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:16px;padding:0 2px}',
      '.w2mChat_list{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px;min-height:120px}',
      '.w2mChat_empty{color:var(--dsw-alias-label-tertiary)}',
      '.w2mChat_msg{display:flex;flex-direction:column;gap:2px}',
      '.w2mChat_meta{color:var(--dsw-alias-label-tertiary);font-size:11px}',
        '.w2mChat_to{font:inherit;font-size:11px;max-width:120px;border-radius:6px;border:.5px solid var(--dsw-alias-border-default);background:var(--dsw-alias-surface-default);color:var(--dsw-alias-label-primary)}',
        '.w2mChat_reply{display:flex;align-items:center;gap:6px;padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);border-top:.5px solid var(--dsw-alias-border-default)}',
        '.w2mChat_replyCancel{margin-left:auto;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.w2mChat_msg{cursor:pointer}',
        '.w2mChat_thread{margin-left:6px;opacity:.7}',
        '.w2mChat_threadHead{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:4px 10px 0}',
        '.w2mChat_board{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-default)}',
        '.w2mChat_boardTitle{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mChat_boardRow{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,monospace}',
        '.w2mChat_threadHead{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:4px 10px 0}',
        '.w2mChat_unseen{margin-left:6px;min-width:16px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-accent-default);color:var(--dsw-alias-label-on-accent);font-size:10px;line-height:16px;text-align:center}',
        // v1.6.10: the transcript is selectable text; screenshots get a preview and a copy affordance.
        '.w2mChatTab{padding:4px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font:inherit;cursor:pointer}',
  '.w2mChat_panelFull{position:fixed;inset:5vh 8vw;width:auto;max-height:90vh;z-index:70}',
  '.w2mChat_sticker{font-size:16px;line-height:1}',
  '.w2mChat_stickerBig{font-size:28px;line-height:1.1}',
  '.w2mChat_emojiRow{display:flex;gap:4px;padding:4px 8px;flex-wrap:wrap}',
  '.w2mChat_emoji{padding:2px 4px;border:0;background:transparent;font-size:16px;line-height:1;cursor:pointer}',
  '.w2mFleetStatus{display:flex;gap:16px;align-items:center;justify-content:center;width:100%;padding:2px 12px;font-size:11px;opacity:.8;white-space:nowrap}',
  '.w2mFleetStatusItem{white-space:nowrap}',
  '.w2mRelayItem{display:inline-flex;align-items:center;gap:4px}',
  '.w2mRelayDot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dsw-alias-state-idle-primary)}',
  '.w2mRelayDot[data-state="green"]{background:var(--dsw-alias-state-success-primary)}',
  '.w2mRelayDot[data-state="yellow"]{background:var(--dsw-alias-state-warn-primary)}',
  '.w2mRelayDot[data-state="red"]{background:var(--dsw-alias-state-danger-primary)}',
    '.w2mSearchToggle{height:26px;width:26px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:14px;cursor:pointer}',
  '.w2mSearchToggle:hover{background:rgba(127,127,127,.14)}',
  '.w2mSearchBox{display:flex;align-items:center;gap:4px;padding:2px 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-background-secondary)}',
  '.w2mSearchInput{height:24px;min-width:220px;border:0;background:transparent;color:inherit;font:inherit;outline:none}',
  '.w2mSearchCount{font-size:11px;opacity:.75;min-width:34px;text-align:center}',
  '.w2mSearchControls{display:inline-flex;align-items:center;gap:4px}',
  '.w2mScrollFloatWrap{position:fixed;top:120px;right:16px;bottom:auto;left:auto;z-index:20;display:flex;align-items:center;justify-content:center;pointer-events:none}',
  '.w2mScrollFloatBtn{box-sizing:border-box;width:34px;height:34px;padding:0;border:0;border-radius:100px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-floating-fill);box-shadow:0 0 0 .5px var(--dsw-alias-border-l3,rgba(0,0,0,.12)),0 3px 8px 0 rgba(0,0,0,.031),0 0 16px 0 rgba(0,0,0,.02);opacity:1;line-height:1;cursor:pointer;pointer-events:auto;transition:background-color 150ms ease,transform 150ms ease}',
  '.w2mScrollFloatBtn:hover{background:var(--dsw-alias-button-floating-hover)}',
  '.w2mScrollFloatBtn:active{background:var(--dsw-alias-button-ghost-active-fill);transform:scale(.96)}',
  '.w2mScrollFloatBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
  '.w2mScrollFloatBtn svg{display:block;width:16px;height:16px;stroke-width:1.5}',
  '::highlight(w2m-conversation-search){background-color:rgba(255,235,59,.85);color:rgba(11,122,51,1)}',
  '.w2mSearchMark{background-color:rgba(255,235,59,.85);color:rgba(11,122,51,1);border-radius:2px}',
  '.w2mSearchMark[data-active="true"]{background-color:rgba(255,166,0,.95);color:rgba(45,20,0,1);outline:2px solid rgba(255,122,0,.95);outline-offset:1px}',
  '.w2mSearchBtn{height:24px;min-width:24px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer}',
  '.w2mSearchBtn:hover{background:rgba(127,127,127,.14)}',
    '.w2mGpw_admin{padding:24px 32px 48px;box-sizing:border-box;max-width:1400px;margin:0 auto;color:var(--dsw-alias-label-primary);font-size:13px}',
  '.w2mGpw_adminHead{margin-bottom:16px}',
  '.w2mGpw_adminTitle{margin:0 0 6px;font-size:22px;line-height:30px;font-weight:600}',
  '.w2mGpw_adminSub{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}',
  '.w2mGpw_adminNote{margin:0 0 12px;padding:8px 12px;border-radius:6px;border:1px solid rgba(220,120,80,.5);background:rgba(220,120,80,.12);font-size:12px}',
  '.w2mGpw_adminCard{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:14px 16px;margin-bottom:14px;background:var(--dsw-alias-background-secondary)}',
  '.w2mGpw_adminToolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.w2mGpw_adminInput{height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:inherit;font:inherit;min-width:220px}',
  '.w2mGpw_adminBtn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}',
  '.w2mGpw_adminBtn:hover{background:rgba(127,127,127,.12)}',
  '.w2mGpw_adminBtn:disabled{opacity:.5;cursor:default}',
  '.w2mGpw_adminTabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}',
  '.w2mGpw_adminTab{height:26px;padding:0 10px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.75}',
  '.w2mGpw_adminTab.is-active{background:rgba(64,132,255,.18);opacity:1;font-weight:600}',
  '.w2mGpw_adminTable{width:100%;border-collapse:collapse;font-size:13px}',
  '.w2mGpw_adminTable th{text-align:left;font-weight:600;padding:10px 12px;border-bottom:1px solid rgba(127,127,127,.25);white-space:nowrap}',
  '.w2mGpw_adminTable td{padding:10px 12px;border-bottom:1px solid rgba(127,127,127,.12);vertical-align:middle}',
  '.w2mGpw_adminEmpty{opacity:.7;text-align:center !important;padding:22px 12px !important}',
  '.w2mGpw_adminPath{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.w2mGpw_adminBadge{display:inline-block;padding:1px 8px;border-radius:10px;border:1px solid rgba(127,127,127,.35);font-size:12px}',
  '.w2mGpw_adminBadge[data-kind="whitelist"]{border-color:rgba(80,180,120,.55);background:rgba(80,180,120,.12)}',
  '.w2mGpw_adminBadge[data-kind="blacklist"]{border-color:rgba(220,120,80,.55);background:rgba(220,120,80,.12)}',
  '.w2mGpw_sideEntry{justify-content:flex-start;text-align:left;font:inherit}',
    '.w2mGpw_mainWrap{height:100%;min-height:0;overflow-y:auto;padding:24px 16px 48px;box-sizing:border-box}',
  '.w2mGpw_mainWrap .w2mGpw_inline{max-width:960px;margin:0 auto}',
  '.w2mGpw_mainWrap .w2mGpw_card{width:100%;max-width:none;max-height:none;position:static;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-background-secondary)}',
  '.w2mGpw_settingsBody .w2mGpw_inline{max-width:960px;margin:0 auto}',
  '.w2mChat_view{position:static;inset:auto;width:100%;max-height:none;height:100%;border-radius:0}',
  '.w2mChat_view .w2mChat_list{max-height:none;flex:1;min-height:0}',
    '.w2mGpw_fullPage{position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;background:var(--dsw-alias-background-primary)}',
  '.w2mGpw_fullHead{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid rgba(127,127,127,.25)}',
  '.w2mGpw_fullTitle{font-size:14px;font-weight:600}',
  '.w2mGpw_fullBody{flex:1;min-height:0;overflow:auto;padding:16px}',
  '.w2mGpw_inline{display:flex;flex-direction:column;width:100%;max-width:960px;margin:0 auto}',
  '.w2mGpw_settingsBody{width:100%;max-width:960px}',
    '.w2mGpw_sideEntry{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;border-radius:6px}',
  '.w2mGpw_sideEntry:hover{background:rgba(127,127,127,.14)}',
  '.w2mGpw_sideIcon{font-size:15px;line-height:1}',
  '.w2mGpw_sideLabel{font-size:12px;font-weight:600;letter-spacing:.02em}',
  '.w2mUpdateSection{display:flex;flex-direction:column;gap:8px;max-width:640px}',
  '.w2mUpdateStatus{font-size:12px;opacity:.8}',
  '.w2mUpdateRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.w2mUpdateBtn{padding:4px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font:inherit;cursor:pointer}',
  '.w2mUpdateAuto{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.9}',
  
  '.w2mChat_panel,.w2mChat_panel *{user-select:text!important;-webkit-user-select:text!important;cursor:text}',
        '.w2mChat_copy{cursor:pointer!important}',
        '.w2mChat_copy{margin-left:6px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;line-height:14px;padding:0 2px;vertical-align:middle}',
        '.w2mChat_copy:hover{color:var(--dsw-alias-label-primary)}',
        '.w2mChat_shotButton{flex:none;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-default);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-surface-default);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
        '.w2mChat_toast{position:absolute;left:10px;right:10px;top:46px;z-index:6;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-default);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-soft);font-size:11px;color:var(--dsw-alias-label-secondary)}',
        '.w2mChat_toastClose{margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:12px;padding:0 2px}',
      '.w2mChat_text{white-space:pre-wrap;word-break:break-word}',
        '.w2mChat_msg.is-session .w2mChat_text{color:var(--dsw-danger)}',         '.w2mChat_msg.is-chat .w2mChat_text{color:var(--dsw-success)}',         '.w2mChat_msg.is-remote .w2mChat_text{color:var(--dsw-text)}',         '.w2mChat_avatar{display:inline-flex;width:16px;height:16px;margin-right:5px;vertical-align:-3px}',
      '.w2mChat_compose{display:flex;gap:8px;padding:8px 10px;border-top:.5px solid var(--dsw-alias-border-l2);align-items:flex-end}',
      '.w2mChat_input{flex:1;resize:none;box-sizing:border-box;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:6px 8px;outline:none;min-height:38px;max-height:96px}',
      '.w2mChat_send{flex:none;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-text-on-business);font:inherit;font-weight:500;cursor:pointer}',
      '.w2mChat_send:disabled{opacity:.5;cursor:default}',
      '.w2mChat_error{padding:0 10px 8px;color:var(--dsw-alias-state-error-primary);font-size:11px}',
      // v3.4.9 备份&还原面板：只使用宿主的 --dsw-alias-* 主题令牌（不写死颜色），因此浅色/深色由
      // 宿主切换，不需要另写 prefers-color-scheme 覆盖块（本文件既有的 CSS 也没有媒体查询）。
      // 窄宽度下靠 auto-fit 网格与可换行操作行自适应，不设置固定宽度。
      '.w2mBackup_sideEntry{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;border-radius:6px}',
      '.w2mBackup_sideEntry:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.w2mBackup_sideIcon{flex:none;display:block;width:18px;height:18px}',
      '.w2mBackup_sideLabel{font-size:12px;font-weight:600;letter-spacing:.02em}',
      '.w2mBackup_wrap{height:100%;min-height:0;overflow-y:auto;padding:24px 16px 48px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.w2mBackup_inner{display:flex;flex-direction:column;gap:12px;width:100%;max-width:960px;margin:0 auto}',
      '.w2mBackup_head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.w2mBackup_title{margin:0;flex:1 1 auto;font-size:20px;line-height:28px;font-weight:600}',
      '.w2mBackup_sub{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.w2mBackup_card{display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.w2mBackup_cardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.w2mBackup_cardTitle{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600}',
      '.w2mBackup_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 16px}',
      '.w2mBackup_stat{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.w2mBackup_statLabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.w2mBackup_statValue{font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.w2mBackup_row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.w2mBackup_check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.w2mBackup_check input{cursor:pointer}',
      '.w2mBackup_actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.w2mBackup_btn{height:28px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}',
      '.w2mBackup_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.w2mBackup_btn:disabled{opacity:.5;cursor:default}',
      '.w2mBackup_btnPrimary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '.w2mBackup_btnDanger{border-color:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-state-danger-primary);font-weight:600}',
      '.w2mBackup_select{height:28px;padding:0 6px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}',
      '.w2mBackup_hint{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.w2mBackup_empty{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.w2mBackup_notice{display:flex;align-items:center;gap:6px;padding:8px 10px;border:.5px solid var(--dsw-alias-state-warn-primary);border-radius:10px;color:var(--dsw-alias-state-warn-primary);font-size:12px}',
      '.w2mBackup_progress{padding:4px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.w2mBackup_danger{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:.5px solid var(--dsw-alias-state-danger-primary);border-radius:10px;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.w2mBackup_sessions{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow-y:auto;scrollbar-width:thin}',
      '.w2mBackup_session{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 6px;border-radius:6px;cursor:pointer}',
      '.w2mBackup_session:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.w2mBackup_sessionWs{flex:0 1 auto;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.w2mBackup_sessionId{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.w2mBackup_sessionSize{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      // v3.5.0 面板补全：扫描会话的勾选列表复用 `.w2mBackup_log` 的有界滚动模式（max-height + thin
      // scrollbar），只新增三个类；行用 flex-wrap 让窄宽度自动换行，颜色仍只取 --dsw-alias-* 令牌。
      '.w2mBackup_pickList{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;scrollbar-width:thin}',
      '.w2mBackup_pickRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding:4px 6px;border-radius:6px;cursor:pointer}',
      '.w2mBackup_pickRow:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.w2mBackup_pickSuffix{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.w2mBackup_tag{flex:none;font-size:11px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.w2mBackup_tag[data-kind="new"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.w2mBackup_tag[data-kind="identical"]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
      '.w2mBackup_tag[data-kind="differs"]{border-color:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-state-danger-primary)}',
      '.w2mBackup_log{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow-y:auto;scrollbar-width:thin}',
      '.w2mBackup_logRow{display:flex;align-items:baseline;gap:8px;min-width:0;padding:2px 0;font-size:11px;line-height:17px}',
      '.w2mBackup_logTime{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.w2mBackup_logAction{flex:none;color:var(--dsw-alias-label-secondary)}',
      '.w2mBackup_logResult{flex:none;font-weight:600}',
      '.w2mBackup_logResult[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.w2mBackup_logResult[data-tone="err"]{color:var(--dsw-alias-state-danger-primary)}',
      '.w2mBackup_logDetail{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
      '.w2mBackup_result{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.w2mBackup_result[data-tone="ok"]{border-color:var(--dsw-alias-state-success-primary)}',
      '.w2mBackup_result[data-tone="err"]{border-color:var(--dsw-alias-state-danger-primary)}',
      '.w2mBackup_error{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:.5px solid var(--dsw-alias-state-danger-primary);border-radius:10px;font-size:12px}',
      '.w2mBackup_errorTitle{font-weight:600;color:var(--dsw-alias-state-danger-primary)}',
      '.w2mBackup_errorDetail{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
      '.w2mBackup_verifyCounts{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.w2mBackup_problems{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      // v3.5.x 解锁对话框：overlay + 居中面板，配色只用宿主 --dsw-alias-* 令牌（不写死颜色）。
      // z-index 复用本文件既有浮层的层级：Gpw overlay 是 70、历史窗口是 80，对话框取 70（高于备份页、低于宿主模态）。
      // 窄宽度下面板占满可用宽度（calc(100vw - 32px)）并在内部滚动，不锁 body 滚动。
      '.w2mBackup_unlockOverlay{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent)}',
      '.w2mBackup_unlockDialog{display:flex;flex-direction:column;gap:10px;width:min(540px,calc(100vw - 32px));max-height:min(82vh,760px);overflow-y:auto;box-sizing:border-box;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;scrollbar-width:thin;outline:none}',
      '.w2mBackup_unlockHead{display:flex;align-items:flex-start;gap:8px;min-width:0}',
      '.w2mBackup_unlockTitles{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}',
      '.w2mBackup_unlockTitle{font-size:14px;font-weight:600}',
      '.w2mBackup_unlockState{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.w2mBackup_unlockClose{flex:none;height:26px;min-width:26px;padding:0 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:20px}',
      '.w2mBackup_unlockClose:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.w2mBackup_unlockSection{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.w2mBackup_unlockSectionTitle{font-size:12px;font-weight:600}',
      '.w2mBackup_unlockActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.w2mBackup_unlockCommand{display:block;box-sizing:border-box;width:100%;padding:8px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:Consolas,Menlo,monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:all}',
      '.w2mBackup_unlockNotice{display:flex;flex-direction:column;gap:2px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
      '.w2mBackup_unlockInlineCommand{font-family:Consolas,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;user-select:all}',
      '.w2mBackup_unlockResult{padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;font-size:12px;word-break:break-word}',
      '.w2mBackup_unlockResult[data-tone="ok"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.w2mBackup_unlockResult[data-tone="err"]{border-color:var(--dsw-alias-state-danger-primary);color:var(--dsw-alias-state-danger-primary)}',
    ].join('');

    /**
     * Install the stylesheet once per document, and hand back a disposer for the plugin's lifetime.
     *
     * Idempotent by the tag id, not by a module flag: two plugin instances in one page (a reload
     * that did not evict the old one, two compositions) must not produce two stylesheets, and an
     * unload must take exactly the one this call created. When a tag is already present this is a
     * no-op that returns nothing, because removing a tag this call did not add would be a
     * disposer that breaks whichever instance owns it.
     *
     * @returns {(() => void)|null} Disposer, or null when the stylesheet was already installed.
     */
    function injectStyle(hostDocument) {
      if (hostDocument === undefined || hostDocument === null) return null;
      if (hostDocument.querySelector(`style[data-plugin-css="${TAG_ID}"]`) !== null) return null;
      const tag = hostDocument.createElement('style');
      tag.dataset.plugin = '@twinsearth/w2m-dsh-plugin';
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      hostDocument.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    const cls = (name) => `w2mTarget_${name}`;
    const h = React.createElement;

    /** The status dot: the colour is the machine's state, and the title says it in words. */
    function StatusDot({ kind, title }) {
      return h('span', { className: cls('dot'), 'data-state': kind, title, 'aria-hidden': 'true' });
    }

    /**
     * This machine is `local` — the one whose composer this is — and the blue dot marks it; a
     * reachable peer is green; anything else is drawn as an outline in the state's own colour so an
     * offline row can never be mistaken for a live one.
     */
    function dotKind(machine) {
      if (machine.online !== true) return machine.state === 'expired' ? 'none' : 'stale';
      return machine.local === true ? 'local' : 'online';
    }

    /** The label the trigger shows before the host has answered: the configured fleet name. */
    const provisionalLabel = (state) => state?.host?.local_machine_name ?? null;

    /**
     * `locked` is accepted for parity with the seat's other occupants and deliberately unused: the
     * target is a choice about the *next* dispatch, which is legitimate to change while a turn runs.
     * `t` arrives through the entry's inject face (see {@link apply}).
     */

    /**
     * GPW v2 operator panel + launcher (v1.7.5-beta.1).
     *
     * The launcher is a floating button pinned to the lower-right corner (a slot entry cannot choose its own screen
     * position, so it pins itself with CSS). The panel has the three sections the operator asked for -- whitelist,
     * blacklist, recently intercepted -- plus the pending queue for class-C calls. Folders enter a list in one of two
     * ways: typed here and validated by the host, or taken from a recently intercepted call in one click. The lists
     * live in $DSH_HOME/xclient/gpw-folders.json; no profile YAML is edited by this feature.
     */
    // ─── 决策收件箱 UI（v3.2.1，对齐瓮城 dsh-Fang 的两处入口）──────────────────────────
    //
    // 用户可见的两个入口：
    //   1. 右侧居中的悬浮「收件箱」浮标 + 点击从右向左滑出的抽屉（全局，任何时候都在）；
    //   2. GPW 面板头部的「收件箱 N」按钮（设置页与浮标打开的 GPW 面板都有），点开同一个抽屉。
    //
    // 数据来自本包自己的 /api/w2m/decisions*：list + SSE 实时推送（失败回退 4 秒轮询）、
    // resolve（选项/自定义/批量）、abandon、ai/advise、quota、ai 状态。渲染用 DOM 直写而不是
    // React，原因是浮标/抽屉要独立于任何宿主页面存活；GPW 里的按钮是 React，只订阅同一个 store。
    const DC_PREFIX = '/api/w2m/decisions';
    const DC_LEVELS = Object.freeze([
      ['red', '红色 · 需要决策', '#C8102E'],
      ['yellow', '黄色 · 建议决策', '#B45309'],
      ['blue', '蓝色 · 日常建议', '#0A6BE0'],
      ['green', '绿色 · 通知汇报', '#17803D'],
      ['gray', '灰色 · 已归档/过期', '#6B7280'],
    ]);
    /** 每个进入 UI 的 ticket 都可能有本地的 AI 建议/忙碌状态，按 id 挂在 store 上。 */
    const dcEmptyCounts = () => ({ red: 0, yellow: 0, blue: 0, green: 0, gray: 0 });

    async function dcRequest(path, init = {}) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        ...init,
        headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) {
        const error = new Error(body?.error ?? body?.reason ?? 'HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return body ?? {};
    }

    /**
     * 收件箱唯一数据源：浮标未读数、抽屉列表、GPW 按钮共用同一份状态。
     *
     * 监听者只有两类：DOM 抽屉（每次 emit 重绘）和 GPW 里的 React 按钮（setState）。SSE 连不上
     * 就退回轮询——两种方式都只读，写操作永远由用户点击触发。
     */
    function createW2mDecisionStore() {
      const state = {
        items: [],
        counts: dcEmptyCounts(),
        loading: false,
        error: '',
        loadedOnce: false,
        ai: null,
        quota: null,
        advice: {},
        busy: '',
        filter: 'pending',
        levelFilter: 'all',
        open: false,
        lastRedPending: 0,
        mode: 'poll',
        // v3.2.3 parity: per-session filter, keyboard selection, batch status, side panels.
        sessionId: '',
        selected: 0,
        status: '',
        forks: null,
        producers: null,
        producersError: '',
      };
      const listeners = new Set();
      let timer = null;
      let stream = null;
      let started = false;
      let disposed = false;
      const emit = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* ignore */ } } };
      const set = (patch) => { Object.assign(state, patch); emit(); };

      const refresh = async () => {
        if (disposed) return;
        if (state.loading !== true) set({ loading: true });
        try {
          const list = await dcRequest(DC_PREFIX + '?includeArchived=1');
          const items = Array.isArray(list?.items) ? list.items : [];
          const counts = dcEmptyCounts();
          for (const item of items) {
            const key = typeof item?.level === 'string' && counts[item.level] !== undefined ? item.level : 'blue';
            if (item?.status === 'pending' || item?.status === undefined) counts[key] += 1;
          }
          const pending = counts.red + counts.yellow + counts.blue + counts.green;
          const previousRed = state.lastRedPending;
          set({ items, counts, loading: false, error: '', loadedOnce: true, lastRedPending: pending === 0 ? 0 : previousRed });
          if (counts.red > (state.alertedRed ?? 0)) {
            state.alertedRed = counts.red;
            if (state.open !== true) showRedToast(counts.red);
          }
          if (counts.red === 0) state.alertedRed = 0;
        } catch (error) {
          set({ loading: false, error: String(error?.message ?? error), loadedOnce: true });
        }
      };

      const loadSideInfo = async () => {
        const [ai, quota, forks, producers] = await Promise.allSettled([
          dcRequest(DC_PREFIX + '/ai'),
          dcRequest(DC_PREFIX + '/quota'),
          dcRequest(DC_PREFIX + '/forks'),
          dcRequest(DC_PREFIX + '/producers'),
        ]);
        if (ai.status === 'fulfilled') set({ ai: ai.value });
        if (quota.status === 'fulfilled') set({ quota: quota.value });
        if (forks.status === 'fulfilled') set({ forks: forks.value });
        if (producers.status === 'fulfilled') set({ producers: producers.value, producersError: '' });
        else set({ producers: null, producersError: String(producers.reason?.message ?? producers.reason ?? 'unavailable') });
      };

      const start = () => {
        if (started || disposed) return;
        started = true;
        void refresh();
        void loadSideInfo();
        // SSE 优先：/events 推 created/updated 时直接刷新；断线自动回退轮询。
        try {
          if (typeof EventSource === 'function') {
            stream = new EventSource(DC_PREFIX + '/events');
            stream.addEventListener('open', () => set({ mode: 'sse' }));
            const onEvent = () => { void refresh(); };
            stream.addEventListener('created', onEvent);
            stream.addEventListener('updated', onEvent);
            stream.addEventListener('message', onEvent);
            stream.addEventListener('error', () => {
              try { stream.close(); } catch { /* ignore */ }
              stream = null;
              set({ mode: 'poll' });
            });
          }
        } catch { stream = null; }
        timer = setInterval(() => {
          void refresh();
          if (stream === null) void loadSideInfo();
        }, 4000);
      };

      const stop = () => {
        disposed = true;
        if (timer !== null) clearInterval(timer);
        timer = null;
        try { stream?.close?.(); } catch { /* ignore */ }
        stream = null;
      };

      const act = async (label, work) => {
        set({ busy: label, error: '' });
        try {
          const out = await work();
          await refresh();
          return out;
        } catch (error) {
          set({ error: String(error?.message ?? error) });
          return null;
        } finally {
          set({ busy: '' });
        }
      };

      const api = {
        state,
        refresh,
        loadSideInfo,
        start,
        stop,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        snapshot() {
          const pending = state.counts.red + state.counts.yellow + state.counts.blue + state.counts.green;
          const archived = state.items.filter((item) => item?.status !== 'pending' && item?.status !== undefined).length;
          return {
            pending,
            red: state.counts.red,
            yellow: state.counts.yellow ?? 0,
            blue: state.counts.blue ?? 0,
            green: state.counts.green ?? 0,
            total: state.items.length,
            archived,
            mode: state.mode,
            open: state.open,
            error: state.error,
            loading: state.loading,
            aiConfigured: state.ai?.configured === true,
            sessionId: state.sessionId ?? '',
            selected: state.selected ?? 0,
            status: state.status ?? '',
          };
        },
        openDrawer() {
          start();
          set({ open: true });
          return refresh();
        },
        closeDrawer() {
          set({ open: false });
        },
        toggleDrawer() {
          if (state.open) api.closeDrawer();
          else api.openDrawer();
        },
        /** 当前会话（由 conversation.input.left 席位发布）的待处理数量。 */
        pendingForSession(sessionId) {
          const id = String(sessionId ?? '');
          if (id === '') return 0;
          return state.items.filter((item) => (item?.status === undefined || item?.status === 'pending') && String(item?.source?.sessionId ?? '') === id).length;
        },
        setSession(sessionId) {
          set({ sessionId: String(sessionId ?? ''), selected: 0 });
        },
        clearSession() {
          set({ sessionId: '', selected: 0 });
        },
        /** 抽屉当前可见的 ticket（过滤/等级/会话三层），键盘与批量都按这个顺序。 */
        visibleTickets() {
          let items = Array.isArray(state.items) ? state.items : [];
          if (state.filter === 'pending') items = items.filter((item) => item?.status === 'pending' || item?.status === undefined);
          else if (state.filter === 'archived') items = items.filter((item) => item?.status !== 'pending' && item?.status !== undefined);
          if ((state.levelFilter ?? 'all') !== 'all') items = items.filter((item) => (item?.level ?? 'blue') === state.levelFilter);
          if (String(state.sessionId ?? '') !== '') items = items.filter((item) => String(item?.source?.sessionId ?? '') === state.sessionId);
          return items;
        },
        moveSelection(delta) {
          const items = api.visibleTickets();
          if (items.length === 0) return;
          const next = (Number(state.selected) + delta + items.length) % items.length;
          set({ selected: next });
        },
        setSelected(index) {
          set({ selected: Number(index) || 0 });
        },
        async resolveFocusedWithOption(optionIndex) {
          const items = api.visibleTickets();
          const ticket = items[Number(state.selected) || 0];
          if (ticket === undefined) return null;
          const options = Array.isArray(ticket.options) ? ticket.options : [];
          const option = options[optionIndex];
          if (option === undefined) return null;
          return api.resolve(ticket, option.value);
        },
        async resolveBatchLevel(level) {
          return act('batch-resolve:' + level, async () => {
            const ids = state.items.filter((item) => (item?.status === 'pending' || item?.status === undefined) && (item?.level ?? 'blue') === level).map((item) => String(item.id));
            if (ids.length === 0) { set({ status: '该等级没有待处理项' }); return; }
            const out = await dcRequest(DC_PREFIX + '/resolve', { method: 'POST', body: JSON.stringify({ ids, by: 'w2m-ui' }) });
            const results = Array.isArray(out?.results) ? out.results : [];
            const okCount = results.filter((entry) => entry.ok === true).length;
            const refused = results.filter((entry) => entry.ok !== true).map((entry) => String(entry.reason ?? 'refused'));
            set({ status: `批量解决 ${okCount}/${ids.length}` + (refused.length ? `，未处理：${refused.join('、')}` : '') });
            await refresh();
          });
        },
        async abandonBatchLevel(level) {
          return act('batch-abandon:' + level, async () => {
            const ids = state.items.filter((item) => (item?.status === 'pending' || item?.status === undefined) && (item?.level ?? 'blue') === level).map((item) => String(item.id));
            if (ids.length === 0) { set({ status: '该等级没有待处理项' }); return; }
            const out = await dcRequest(DC_PREFIX + '/abandon', { method: 'POST', body: JSON.stringify({ ids, by: 'w2m-ui' }) });
            const results = Array.isArray(out?.results) ? out.results : [];
            const okCount = results.filter((entry) => entry.ok === true).length;
            set({ status: `批量放弃 ${okCount}/${ids.length}` });
            await refresh();
          });
        },
        /** 会话席位发布当前会话时触发一次重绘。 */
        touch() {
          emit();
        },
        setFilter(filter) {
          set({ filter });
        },
        setLevel(level) {
          set({ levelFilter: level });
        },
        async resolve(ticket, option) {
          return act('resolve:' + ticket.id, () => dcRequest(DC_PREFIX + '/resolve', {
            method: 'POST',
            body: JSON.stringify({ id: ticket.id, option: option ?? null, by: 'w2m-ui' }),
          }));
        },
        async resolveCustom(ticket, text) {
          return act('resolve:' + ticket.id, () => dcRequest(DC_PREFIX + '/resolve', {
            method: 'POST',
            body: JSON.stringify({ id: ticket.id, option: null, custom: String(text ?? ''), by: 'w2m-ui' }),
          }));
        },
        async abandon(ticket) {
          return act('abandon:' + ticket.id, () => dcRequest(DC_PREFIX + '/abandon', {
            method: 'POST',
            body: JSON.stringify({ id: ticket.id, by: 'w2m-ui' }),
          }));
        },
        async advise(ticket) {
          return act('advise:' + ticket.id, async () => {
            const out = await dcRequest(DC_PREFIX + '/ai/advise', { method: 'POST', body: JSON.stringify({ id: ticket.id }) });
            const advice = out?.advice ?? out?.result?.advice ?? null;
            const text = typeof advice === 'string' ? advice : (advice?.text ?? advice?.summary ?? out?.text ?? '');
            set({ advice: { ...state.advice, [ticket.id]: text === '' ? '（AI 未返回建议文本）' : String(text) } });
            return out;
          });
        },
      };
      return api;
    }

    let w2mDcStoreInstance = null;
    function w2mDcStore() {
      if (w2mDcStoreInstance === null) w2mDcStoreInstance = createW2mDecisionStore();
      return w2mDcStoreInstance;
    }

    /** 红色 ticket 的顶部提醒：和瓮城一样“红票必须被看见”，但不抢焦点、不自动处理。 */
    let dcRedToast = null;
    function showRedToast(count) {
      if (typeof document === 'undefined' || document.body === undefined) return;
      try { dcRedToast?.remove?.(); } catch { /* ignore */ }
      const toast = document.createElement('div');
      toast.className = 'w2mDcRedToast';
      const title = document.createElement('div');
      title.className = 'w2mDcRedToastTitle';
      title.textContent = '红色决策待处理 · ' + count;
      const body = document.createElement('div');
      body.className = 'w2mDcRedToastBody';
      body.textContent = '打开收件箱处理，或稍后继续手头的事。';
      const actions = document.createElement('div');
      actions.className = 'w2mDcRedToastActions';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'w2mDcBtn';
      open.textContent = '打开收件箱';
      open.addEventListener('click', () => { toast.remove(); w2mDcStore().openDrawer(); });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'w2mDcBtn';
      close.textContent = '稍后';
      close.addEventListener('click', () => toast.remove());
      actions.append(open, close);
      toast.append(title, body, actions);
      document.body.append(toast);
      dcRedToast = toast;
      setTimeout(() => { try { toast.remove(); } catch { /* ignore */ } }, 12000).unref?.();
    }

    /** 极简 DOM 构造器：这不是 React 的 h，props 按 attribute/事件分开处理。 */
    function dcEl(tag, props = null, children = []) {
      const node = document.createElement(tag);
      if (props !== null) {
        for (const [key, value] of Object.entries(props)) {
          if (value === undefined || value === null || value === false) continue;
          if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
          else if (key === 'className') node.className = value;
          else if (key === 'text') node.textContent = value;
          else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
          else node.setAttribute(key, value === true ? '' : String(value));
        }
      }
      for (const child of [].concat(children)) {
        if (child === null || child === undefined) continue;
        node.append(typeof child === 'string' ? document.createTextNode(child) : child);
      }
      return node;
    }

    function dcTime(at) {
      const value = Number(at);
      if (!Number.isFinite(value) || value <= 0) return '';
      try { return new Date(value).toLocaleString(); } catch { return ''; }
    }

    function dcStatusLabel(ticket) {
      const status = ticket?.status ?? 'pending';
      if (status === 'pending') return '待处理';
      if (status === 'resolved') return ticket?.resolvedOption ? '已解决 · ' + String(ticket.resolvedOption) : '已解决';
      if (status === 'abandoned') return '已放弃';
      if (status === 'expired') return '已过期';
      return status;
    }

    /** 抽屉里的单张 ticket 卡片：选项、自定义答复、AI 建议、放弃。 */
    function dcTicketCard(store, ticket) {
      const state = store.state;
      const busy = state.busy !== '';
      const pending = ticket?.status === 'pending' || ticket?.status === undefined;
      const card = dcEl('div', { className: 'w2mDcTicket', 'data-level': ticket?.level ?? 'blue' });
      const head = dcEl('div', { className: 'w2mDcTicketHead' });
      head.append(
        dcEl('span', { className: 'w2mDcDot', 'data-level': ticket?.level ?? 'blue' }),
        dcEl('span', { className: 'w2mDcTicketTitle', title: ticket?.title ?? '' }, [ticket?.title ?? '(未命名)']),
        dcEl('span', { className: 'w2mDcTag' }, [dcStatusLabel(ticket)]),
      );
      card.append(head);
      const metaBits = [];
      if (ticket?.source?.agentRole) metaBits.push(String(ticket.source.agentRole));
      if (ticket?.source?.sessionId) metaBits.push('会话 ' + String(ticket.source.sessionId).slice(0, 18));
      if (ticket?.createdAt) metaBits.push(dcTime(ticket.createdAt));
      if (ticket?.expiresAt) metaBits.push('截止 ' + dcTime(ticket.expiresAt));
      if (metaBits.length > 0) card.append(dcEl('div', { className: 'w2mDcMeta' }, [metaBits.join(' · ')]));
      const contextText = String(ticket?.context ?? '').trim();
      if (contextText !== '') {
        const details = dcEl('details', { className: 'w2mDcContext' });
        details.append(dcEl('summary', null, ['上下文']), dcEl('div', { className: 'w2mDcContextBody' }, [contextText]));
        card.append(details);
      }
      const options = Array.isArray(ticket?.options) ? ticket.options : [];
      if (pending) {
        if (options.length > 0) {
          const optionsRow = dcEl('div', { className: 'w2mDcActions' });
          for (const option of options) {
            const button = dcEl('button', {
              type: 'button',
              className: 'w2mDcBtn ' + (option?.isRecommended === true ? 'w2mDcBtnPrimary' : ''),
              disabled: busy,
              title: option?.label ?? '',
            }, [String(option?.label ?? option?.value ?? '选项')]);
            button.addEventListener('click', () => {
              void (async () => {
                const out = await store.resolve(ticket, option?.value);
                const helper = w2mQueueJournalHelpers;
                if (out?.ok !== false && typeof helper?.writeComposer === 'function') {
                  helper.writeComposer(String(option?.label ?? option?.value ?? ''));
                }
              })();
            });
            optionsRow.append(button);
          }
          card.append(optionsRow);
        }
        const customRow = dcEl('div', { className: 'w2mDcActions' });
        const input = dcEl('input', { className: 'w2mDcInput', type: 'text', placeholder: '自定义答复（回车提交）', disabled: busy });
        const submit = dcEl('button', { type: 'button', className: 'w2mDcBtn', disabled: busy }, ['提交答复']);
        const send = () => {
          const text = String(input.value ?? '').trim();
          if (text === '') return;
          input.value = '';
          void store.resolveCustom(ticket, text);
        };
        submit.addEventListener('click', send);
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
        customRow.append(input, submit);
        card.append(customRow);
        const actions = dcEl('div', { className: 'w2mDcActions' });
        actions.append(
          dcEl('button', { type: 'button', className: 'w2mDcBtn', disabled: busy }, ['AI 建议']),
          dcEl('button', { type: 'button', className: 'w2mDcBtn w2mDcBtnDanger', disabled: busy }, ['放弃']),
        );
        const [aiBtn, abandonBtn] = actions.querySelectorAll('button');
        aiBtn?.addEventListener('click', () => { void store.advise(ticket); });
        abandonBtn?.addEventListener('click', () => { void store.abandon(ticket); });
        card.append(actions);
        if (state.advice[ticket.id]) card.append(dcEl('div', { className: 'w2mDcAdvice' }, [String(state.advice[ticket.id])]));
      } else {
        if (ticket?.resolvedOption !== null && ticket?.resolvedOption !== undefined) {
          card.append(dcEl('div', { className: 'w2mDcMeta' }, ['结果：' + String(ticket.resolvedOption)]));
        }
        const actions = dcEl('div', { className: 'w2mDcActions' });
        actions.append(dcEl('button', { type: 'button', className: 'w2mDcBtn', disabled: busy }, ['AI 建议']));
        actions.querySelector('button')?.addEventListener('click', () => { void store.advise(ticket); });
        card.append(actions);
        if (state.advice[ticket.id]) card.append(dcEl('div', { className: 'w2mDcAdvice' }, [String(state.advice[ticket.id])]));
      }
      return card;
    }

    /**
     * 右侧居中的浮标 + 抽屉。返回 dispose；在 `typeof document === 'undefined'` 的测试环境里
     * apply 会跳过挂载。
     */
    /** 当前会话（由 conversation.input.left 的席位发布），用于「待选」浮钮与会话筛选。 */
    let w2mDcCurrentSession = '';
    function w2mDcSetSession(sessionId) {
      w2mDcCurrentSession = String(sessionId ?? '');
      try { w2mDcStore().touch(); } catch { /* store not built yet */ }
    }

    const CHOICE_SEEN_KEY = 'w2m:choice:seen:v1';

    function choiceHash(text) {
      let hash = 5381;
      const raw = String(text ?? '');
      for (let index = 0; index < raw.length; index += 1) hash = ((hash << 5) + hash + raw.charCodeAt(index)) | 0;
      return (hash >>> 0).toString(36);
    }

    function choiceSeenSet() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(CHOICE_SEEN_KEY) ?? '[]');
        return new Set(Array.isArray(parsed) ? parsed.slice(-80) : []);
      } catch { return new Set(); }
    }

    function choiceSeenAdd(key) {
      try {
        const seen = choiceSeenSet();
        seen.add(key);
        window.localStorage.setItem(CHOICE_SEEN_KEY, JSON.stringify([...seen].slice(-80)));
      } catch { /* storage denied */ }
    }

    /** 从一条 assistant 文本里解析末尾的单选/多选选项（1/2/3/4 或 A/B/C/D，支持 [ ] 多选）。 */
    function parseChoiceOptions(rawText) {
      const text = String(rawText ?? '').replace(/\r/g, '').trim();
      if (text === '') return null;
      const lines = text.split('\n');
      const optionRe = /^\s*(?:[-*•>\s]*)(?:\[[ xX✓✔]\]|☐|☑)?\s*>?\s*(?:[（(]?(\d{1,2})[)）.、:：】\]]|[（(]?([A-Za-z])[)）.、:：】\]])\s*(.+?)\s*$/u;
      let index = lines.length - 1;
      while (index >= 0 && lines[index].trim() === '') index -= 1;
      const run = [];
      let style = null;
      let expectedNumber = null;
      let expectedLetter = null;
      const checkboxRe = /^\s*(?:[-*•]\s*)?(?:\[[ xX✓✔]\]|☐|☑)\s*(.+?)\s*$/u;
      while (index >= 0) {
        const line = lines[index];
        let label = '';
        let styleHere = null;
        let key = null;
        const match = optionRe.exec(line);
        if (match !== null) {
          styleHere = match[1] !== undefined ? 'number' : 'letter';
          if (styleHere === 'number') {
            const value = Number(match[1]);
            if (expectedNumber === null) expectedNumber = value;
            else if (value !== expectedNumber - 1) break;
            key = String(value);
            expectedNumber = value;
          } else {
            const letter = match[2].toUpperCase();
            if (expectedLetter === null) expectedLetter = letter;
            else if (letter.charCodeAt(0) !== expectedLetter.charCodeAt(0) - 1) break;
            key = letter;
            expectedLetter = letter;
          }
          label = match[3].trim();
        } else {
          const checkbox = checkboxRe.exec(line);
          if (checkbox === null) break;
          styleHere = 'checkbox';
          label = checkbox[1].trim();
        }
        if (label === '' || label.length > 300) break;
        if (style === null) style = styleHere;
        if (style !== styleHere) break;
        run.push({ key, label });
        index -= 1;
      }
      run.reverse();
      if (style === 'checkbox') run.forEach((option, position) => { option.key = String.fromCharCode(65 + position); });
      if (run.length < 2) {
        // 单行写法：请选择：1、继续 2、停止 / A. 方案一 B. 方案二
        const tail = lines.slice(-3).join(' ');
        const inlineRe = /^\s*(\d{1,2}|[A-Za-z])[、.）):：]\s*(.+)$/u;
        const found = [];
        for (const chunk of tail.split(/[\s，,；;：:]+(?=(?:\d{1,2}|[A-Za-z])[、.）):：])/u)) {
          const inline = inlineRe.exec(chunk);
          if (inline === null) continue;
          found.push({ key: String(inline[1]).toUpperCase(), label: inline[2].trim() });
        }
        if (found.length < 2) return null;
        const questionLine = lines.slice(-4, -1).map((line) => line.trim()).find((line) => line !== '') ?? '';
        return {
          question: questionLine.replace(/[：:]\s*$/, ''),
          options: found.slice(-8),
          multi: /\[[ xX✓✔]\]|☐|☑/.test(tail),
          excerpt: text.slice(-2000),
        };
      }
      const rawRunLines = lines.slice(index + 1, index + 1 + run.length);
      const multi = style === 'checkbox' || rawRunLines.some((line) => /(?:\[[ xX✓✔]\]|☐|☑)/.test(line));
      let question = '';
      for (let cursor = index; cursor >= Math.max(0, index - 3); cursor -= 1) {
        const line = lines[cursor].trim();
        if (line === '') continue;
        if (/[?？]|请选择|选择|选项|哪一个|是否/u.test(line)) { question = line; break; }
      }
      return { question, options: run, multi, excerpt: text.slice(-2000) };
    }

    /** 轮询当前会话最后一条 assistant 消息；发现选择题就灌进决策中心（黄色待选 ticket）。 */
    function installChoiceWatcher(ctx) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
      let alive = true;
      let busy = false;
      const tick = async () => {
        if (!alive || busy) return;
        const sessionId = String(w2mDcCurrentSession ?? '');
        if (sessionId === '') return;
        const sessions = w2mClientSessions;
        if (sessions === null || typeof sessions.using !== 'function') return;
        busy = true;
        try {
          let latest = '';
          try {
            const log = await sessionLogRequest(sessionId, 5);
            if (log !== null && log.found === true && typeof log.assistant === 'string') latest = log.assistant;
          } catch { /* fall back to the client sessions service */ }
          if (latest.trim() === '') await sessions.using(sessionId, { source: 'w2m-choice-watch' }, (reference) => {
            const binding = reference?.binding;
            const eventSource = binding?.eventSource ?? binding?.session?.eventSource;
            if (eventSource === null || eventSource === undefined || typeof eventSource.getSnapshot !== 'function') return;
            const entries = eventSource.getSnapshot()?.entries ?? [];
            for (const record of entries) {
              const event = record?.event;
              if (event === null || event === undefined || event.type !== 'assistant/message') continue;
              const data = event.data;
              const message = data !== null && typeof data === 'object' && data.message !== undefined ? data.message : data;
              const text = historyTextOfContent(message?.content);
              if (text !== '') latest = text;
            }
          });
          const parsed = parseChoiceOptions(latest);
          if (parsed === null || parsed.options.length < 2) return;
          const dedupeKey = 'dsh-choice:' + choiceHash(sessionId + '|' + parsed.question + '|' + parsed.options.map((option) => option.key + ':' + option.label).join('|'));
          if (choiceSeenSet().has(dedupeKey)) return;
          choiceSeenAdd(dedupeKey);
          const title = (parsed.multi ? '[多选] ' : '') + '本轮待选：' + (parsed.question === '' ? parsed.options.map((option) => option.key).join('/') : parsed.question);
          const response = await fetch('/api/w2m/decisions/ingest', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({
              producer: 'SuperAgent',
              kind: 'superagent-completion',
              level: 'yellow',
              title: title.slice(0, 500),
              context: parsed.excerpt,
              options: parsed.options.map((option) => ({ value: option.key, label: option.key + '. ' + option.label })),
              dedupeKey,
              sessionId,
              sourceRole: 'worker',
              metadata: { origin: 'dsh-choice-watch', multi: parsed.multi },
            }),
          });
          if (response.ok === true) {
            try { await w2mDcStore().refresh(); } catch { /* store may not be mounted */ }
          }
        } catch { /* session unavailable: retry on the next tick */ } finally { busy = false; }
      };
      void tick();
      const timer = setInterval(() => { void tick(); }, 5000);
      timer.unref?.();
      const dispose = () => { alive = false; clearInterval(timer); };
      if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, 'w2m: choice prompt watcher');
      return dispose;
    }

    /**
     * v3.4.4: one floating badge per subplugin. A disabled subplugin row registers no HTTP route,
     * so its badge is hidden until the route answers and disappears again if it stops answering.
     * 404/405 are the missing-route signals; a network error keeps the badge hidden rather than
     * pretending the subplugin is enabled.
     */
    async function subpluginRouteAvailable(route) {
      try {
        const response = await fetch(route, { credentials: 'same-origin', headers: { accept: 'application/json' } });
        return response.status !== 404 && response.status !== 405;
      } catch { return false; }
    }

    function watchSubpluginRoute(route, onChange, intervalMs = 5000) {
      let alive = true;
      const check = async () => {
        const available = await subpluginRouteAvailable(route);
        if (alive) onChange(available);
      };
      void check();
      const timer = setInterval(() => { void check(); }, intervalMs);
      return () => { alive = false; clearInterval(timer); };
    }

    function mountW2mDecisionCenterUI() {
      if (typeof document === 'undefined' || document.body === undefined) return () => {};
      const store = w2mDcStore();
      const badge = dcEl('button', {
        type: 'button',
        hidden: true,
        className: 'w2mDcBadge',
        title: '决策中心 · 待选',
        'aria-label': '决策中心',
      });
      const badgeIcon = dcEl('span', { className: 'w2mDcBadgeIcon' }, ['◈']);
      const badgeText = dcEl('span', { className: 'w2mDcBadgeText' }, ['待选']);
      const badgeCount = dcEl('span', { className: 'w2mDcBadgeCount' }, ['0']);
      badge.append(badgeIcon, badgeText, badgeCount);
      badge.addEventListener('click', () => store.toggleDrawer());

      const overlay = dcEl('div', { className: 'w2mDcOverlay' });
      overlay.style.display = 'none';
      const drawer = dcEl('aside', {
        className: 'w2mDcDrawer',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '决策收件箱',
      });
      drawer.style.display = 'none';
      const header = dcEl('div', { className: 'w2mDcDrawerHead' });
      const title = dcEl('div', { className: 'w2mDcDrawerTitle' }, ['决策收件箱']);
      const unread = dcEl('span', { className: 'w2mDcUnread', hidden: true }, ['0']);
      const headActions = dcEl('div', { className: 'w2mDcActions' });
      const refreshButton = dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['刷新']);
      const closeButton = dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['关闭']);
      refreshButton.addEventListener('click', () => { void store.refresh(); void store.loadSideInfo(); });
      closeButton.addEventListener('click', () => store.closeDrawer());
      headActions.append(refreshButton, closeButton);
      header.append(title, unread, headActions);
      const filters = dcEl('div', { className: 'w2mDcFilters' });
      filters.append(
        dcEl('button', { type: 'button', className: 'w2mDcBtn w2mDcFilterActive' }, ['待处理']),
        dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['全部']),
        dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['已归档']),
      );
      const sessionChip = dcEl('div', { className: 'w2mDcSessionChip', hidden: true });
      const sessionChipText = dcEl('span', { className: 'w2mDcSessionText' }, ['']);
      const sessionChipClear = dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['显示全部会话']);
      sessionChipClear.addEventListener('click', () => store.clearSession());
      sessionChip.append(sessionChipText, sessionChipClear);
      const levels = dcEl('div', { className: 'w2mDcLevels' });
      const levelButtons = [['all', '全部等级'], ...DC_LEVELS.map(([level, label]) => [level, label.split(' · ')[0]])];
      for (const [level, label] of levelButtons) {
        const button = dcEl('button', { type: 'button', className: 'w2mDcBtn', 'data-level': level }, [label]);
        button.addEventListener('click', () => store.setLevel(level));
        levels.append(button);
      }
      const body = dcEl('div', { className: 'w2mDcBody' });
      const footer = dcEl('div', { className: 'w2mDcFooter' });
      const sidePanels = dcEl('details', { className: 'w2mDcSidePanels' });
      sidePanels.append(dcEl('summary', null, ['分叉聚合 / 生产者']));
      const sideBody = dcEl('div', { className: 'w2mDcSideBody' });
      sidePanels.append(sideBody);
      // AI 建议设置：瓮城的收件箱里可以配置 provider/model/endpoint；这里做同一件事的最小形态。
      const aiConfig = dcEl('details', { className: 'w2mDcAiConfig' });
      aiConfig.append(dcEl('summary', null, ['AI 建议设置']));
      const aiBody = dcEl('div', { className: 'w2mDcAiBody' });
      const aiProvider = dcEl('input', { className: 'w2mDcInput', type: 'text', placeholder: 'provider（如 deepseek）' });
      aiProvider.value = 'deepseek';
      const aiModel = dcEl('input', { className: 'w2mDcInput', type: 'text', placeholder: 'model（如 deepseek-flash）' });
      aiModel.value = 'deepseek-flash';
      const aiBaseUrl = dcEl('input', { className: 'w2mDcInput', type: 'text', placeholder: 'baseUrl（可选）' });
      aiBaseUrl.value = 'https://api.deepseek.com/v1';
      const aiKey = dcEl('input', { className: 'w2mDcInput', type: 'password', placeholder: 'apiKey（可选，只存在宿主侧）' });
      const aiSave = dcEl('button', { type: 'button', className: 'w2mDcBtn w2mDcBtnPrimary' }, ['保存']);
      const aiTest = dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['测试连接']);
      const aiStatusLine = dcEl('div', { className: 'w2mDcMeta' }, ['AI 状态未知']);
      /** 空白字段不发送：服务端会用 provider 预设补 model/baseUrl，空字符串反而会打断预设查找。 */
      const aiPayload = () => {
        const payload = {};
        const provider = String(aiProvider.value ?? '').trim();
        const model = String(aiModel.value ?? '').trim();
        const baseUrl = String(aiBaseUrl.value ?? '').trim();
        const apiKey = String(aiKey.value ?? '').trim();
        if (provider !== '') payload.provider = provider;
        if (model !== '') payload.model = model;
        if (baseUrl !== '') payload.baseUrl = baseUrl;
        if (apiKey !== '') payload.apiKey = apiKey;
        return payload;
      };
      aiSave.addEventListener('click', async () => {
        try {
          const out = await dcRequest(DC_PREFIX + '/ai/config', {
            method: 'POST',
            body: JSON.stringify(aiPayload()),
          });
          aiKey.value = '';
          aiStatusLine.textContent = '已保存：' + String(out?.provider ?? '') + (out?.model ? ' / ' + String(out.model) : '');
          await store.loadSideInfo();
        } catch (error) {
          aiStatusLine.textContent = '保存失败：' + String(error?.message ?? error);
        }
      });
      aiTest.addEventListener('click', async () => {
        try {
          const out = await dcRequest(DC_PREFIX + '/ai/test', {
            method: 'POST',
            body: JSON.stringify(aiPayload()),
          });
          aiStatusLine.textContent = out?.ok === true ? '连接正常' : '测试失败：' + String(out?.reason ?? out?.error ?? 'unknown');
        } catch (error) {
          aiStatusLine.textContent = '测试失败：' + String(error?.message ?? error);
        }
      });
      aiBody.append(aiProvider, aiModel, aiBaseUrl, aiKey, dcEl('div', { className: 'w2mDcActions' }, []));
      aiBody.lastChild.append(aiSave, aiTest);
      aiBody.append(aiStatusLine);
      aiConfig.append(aiBody);
      const empty = dcEl('div', { className: 'w2mDcEmpty' }, ['收件箱是空的。Agent 创建的决策 ticket 会出现在这里。']);
      const errorLine = dcEl('div', { className: 'w2mDcError', role: 'alert', hidden: true });
      drawer.append(header, sessionChip, filters, levels, errorLine, body, sidePanels, aiConfig, footer);
      overlay.append(drawer);
      document.body.append(badge, overlay);
      let decisionStarted = false;
      const stopDecisionGate = watchSubpluginRoute('/api/w2m/decisions', (enabled) => {
        badge.hidden = !enabled;
        if (enabled && !decisionStarted) { decisionStarted = true; store.start(); }
        if (!enabled) store.closeDrawer();
      });
      const relay = dcEl('button', { type: 'button', className: 'w2mDcRelayBtn', title: '当前会话的待选决策', 'aria-label': '当前会话的待选决策' });
      relay.style.display = 'none';
      const relayText = dcEl('span', { className: 'w2mDcRelayText' }, ['待选']);
      const relayCount = dcEl('span', { className: 'w2mDcRelayCount' }, ['0']);
      relay.append(relayText, relayCount);
      relay.addEventListener('click', () => { store.setSession(w2mDcCurrentSession); store.openDrawer(); });
      document.body.append(relay);

      overlay.addEventListener('click', (event) => { if (event.target === overlay) store.closeDrawer(); });
      const onKey = (event) => {
        if (event.key === 'Escape' && store.state.open) { store.closeDrawer(); return; }
        if (store.state.open !== true) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); store.moveSelection(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); store.moveSelection(-1); }
        else if (event.key === 'r' || event.key === 'R') { void store.refresh(); }
        else if (/^[1-9]$/.test(event.key)) { void store.resolveFocusedWithOption(Number(event.key) - 1); }
      };
      document.addEventListener('keydown', onKey);

      const snapshotOf = () => store.snapshot();
      const render = () => {
        const state = store.state;
        const snap = snapshotOf();
        badgeCount.textContent = String(snap.pending);
        const pendingTone = snap.pending === 0
          ? 'idle'
          : snap.red > 0
            ? 'red'
            : snap.yellow > 0
              ? 'yellow'
              : snap.blue > 0
                ? 'blue'
                : 'green';
        badge.setAttribute('data-tone', pendingTone);
        unread.hidden = snap.pending === 0;
        unread.textContent = String(snap.pending);
        title.textContent = '决策收件箱' + (snap.pending > 0 ? ' · ' + snap.pending + ' 待处理' : '');
        // 每会话「待选」浮钮：只有当前会话有待处理项时出现。
        const sessionId = String(w2mDcCurrentSession ?? '');
        const sessionPending = store.pendingForSession(sessionId);
        // v3.2.4：右侧待选改由决策中心药丸承担，会话浮钮不再单独显示（会话筛选仍在抽屉里）。
        relay.style.display = 'none';
        relayCount.textContent = String(sessionPending);
        const sessionRed = state.items.some((item) => (item?.status === undefined || item?.status === 'pending') && String(item?.source?.sessionId ?? '') === sessionId && item?.level === 'red');
        relay.setAttribute('data-tone', sessionRed ? 'red' : 'warn');
        overlay.style.display = state.open === true ? 'flex' : 'none';
        drawer.style.display = state.open === true ? 'flex' : 'none';
        overlay.setAttribute('aria-hidden', state.open === true ? 'false' : 'true');
        if (state.open !== true) return;
        sessionChip.hidden = String(state.sessionId ?? '') === '';
        sessionChipText.textContent = '只看会话：' + String(state.sessionId ?? '').slice(0, 18);
        const filterButtons = filters.querySelectorAll('button');
        const filterMode = state.filter ?? 'pending';
        ['pending', 'all', 'archived'].forEach((mode, index) => {
          filterButtons[index]?.classList.toggle('w2mDcFilterActive', filterMode === mode);
          if (filterButtons[index] !== undefined && filterButtons[index].dataset.bound !== '1') {
            filterButtons[index].dataset.bound = '1';
            filterButtons[index].addEventListener('click', () => store.setFilter(mode));
          }
        });
        const levelButtonsAll = levels.querySelectorAll('button');
        levelButtonsAll.forEach((button) => button.classList.toggle('w2mDcFilterActive', (state.levelFilter ?? 'all') === button.dataset.level));
        errorLine.hidden = state.error === '';
        errorLine.textContent = state.error === '' ? '' : '决策中心不可用：' + state.error;
        const items = store.visibleTickets();
        body.replaceChildren();
        if (items.length === 0) {
          body.append(state.loading === false && state.loadedOnce ? empty : dcEl('div', { className: 'w2mDcEmpty' }, ['正在读取收件箱…']));
        } else {
          let index = 0;
          for (const [level, label] of DC_LEVELS) {
            const group = items.filter((item) => (item?.level ?? 'blue') === level);
            if (group.length === 0) continue;
            const groupBox = dcEl('div', { className: 'w2mDcGroup', 'data-level': level });
            const groupHead = dcEl('div', { className: 'w2mDcGroupHead' });
            groupHead.append(dcEl('span', { className: 'w2mDcGroupTitle' }, [label + ' · ' + group.length]));
            const pendingGroup = group.filter((item) => item?.status === undefined || item?.status === 'pending');
            if (pendingGroup.length > 1) {
              const batchResolve = dcEl('button', { type: 'button', className: 'w2mDcBtn w2mDcBatchResolve', disabled: state.busy !== '' || level === 'red' }, ['批量解决']);
              const batchAbandon = dcEl('button', { type: 'button', className: 'w2mDcBtn w2mDcBatchAbandon', disabled: state.busy !== '' || level === 'red' }, ['批量放弃']);
              if (level === 'red') { batchResolve.title = '红色必须逐条处理'; batchAbandon.title = '红色必须逐条处理'; }
              batchResolve.addEventListener('click', () => { void store.resolveBatchLevel(level); });
              batchAbandon.addEventListener('click', () => { void store.abandonBatchLevel(level); });
              groupHead.append(batchResolve, batchAbandon);
            }
            groupBox.append(groupHead);
            for (const ticket of group) {
              const card = dcTicketCard(store, ticket);
              card.setAttribute('data-index', String(index));
              if (Number(state.selected) === index) card.classList.add('w2mDcSelected');
              index += 1;
              groupBox.append(card);
            }
            body.append(groupBox);
          }
        }
        // 分叉聚合 + 生产者面板（宿主不提供时如实说明）。
        sideBody.replaceChildren();
        const forks = state.forks;
        const forkGroups = Array.isArray(forks?.groups) ? forks.groups : Array.isArray(forks?.forks) ? forks.forks : null;
        if (forkGroups === null) sideBody.append(dcEl('div', { className: 'w2mDcMeta' }, ['分叉聚合不可用']));
        else if (forkGroups.length === 0) sideBody.append(dcEl('div', { className: 'w2mDcMeta' }, ['暂无分叉数据']));
        else {
          for (const group of forkGroups.slice(0, 5)) {
            sideBody.append(dcEl('div', { className: 'w2mDcSideRow' }, [String(group?.forkId ?? '?') + ' · 总 ' + (Number(group?.total) || 0) + ' · 待 ' + (Number(group?.pending) || 0) + ' · 红 ' + (Number(group?.red) || 0)]));
          }
        }
        const producers = state.producers;
        const producerList = Array.isArray(producers?.producers) ? producers.producers : Array.isArray(producers?.items) ? producers.items : null;
        if (producerList === null) sideBody.append(dcEl('div', { className: 'w2mDcMeta' }, ['生产者目录不可用：' + String(state.producersError || '宿主未提供 /producers')]));
        else if (producerList.length === 0) sideBody.append(dcEl('div', { className: 'w2mDcMeta' }, ['暂无外部生产者']));
        else {
          for (const producer of producerList.slice(0, 5)) {
            sideBody.append(dcEl('div', { className: 'w2mDcSideRow' }, [String(producer?.name ?? producer?.producer ?? producer?.id ?? '?')]));
          }
        }
        const aiConfigured = state.ai?.configured === true;
        if (document.activeElement !== aiProvider) aiProvider.value = String(state.ai?.provider ?? '');
        if (document.activeElement !== aiModel) aiModel.value = String(state.ai?.model ?? '');
        if (document.activeElement !== aiBaseUrl) aiBaseUrl.value = String(state.ai?.baseUrl ?? '');
        aiStatusLine.textContent = aiConfigured
          ? '当前：' + String(state.ai?.provider ?? '') + (state.ai?.model ? ' / ' + String(state.ai.model) : '') + '（已配置）'
          : 'AI 未配置：填入 provider/model/apiKey 后保存，AI 建议按钮才可用。';
        footer.replaceChildren();
        if (String(state.status ?? '') !== '') footer.append(dcEl('div', { className: 'w2mDcStatusLine' }, ['状态：' + state.status]));
        const quota = state.quota;
        const ai = state.ai;
        const bits = [];
        bits.push('连接：' + (snap.mode === 'sse' ? '实时推送' : '轮询'));
        bits.push('键盘：↑↓ 选择，1-9 按选项处理，r 刷新，Esc 关闭');
        if (quota !== null && typeof quota === 'object') {
          const limit = quota?.limits?.maxTicketsPerSessionPerDay;
          bits.push('今日决策 ' + (Number(quota.total) || 0) + (limit ? ' / 每会话上限 ' + limit : ''));
          if (Array.isArray(quota.sessions) && quota.sessions.length > 0) {
            bits.push('会话：' + quota.sessions.slice(0, 3).map((entry) => String(entry.sessionId).slice(0, 10) + '×' + entry.count).join('，'));
          }
        }
        bits.push('AI 建议：' + (ai?.configured === true ? String(ai.provider ?? '') + '/' + String(ai.model ?? '') : '未配置'));
        for (const bit of bits) footer.append(dcEl('div', { className: 'w2mDcFooterLine' }, [bit]));
      };

      const unsubscribe = store.subscribe(render);
      render();
      return () => {
        stopDecisionGate();
        unsubscribe();
        try { badge.remove(); } catch { /* ignore */ }
        try { overlay.remove(); } catch { /* ignore */ }
        document.removeEventListener('keydown', onKey);
      };
    }

    /**
     * 会话席位：从 conversation.input.left 拿到当前 sessionId，发布给「待选」浮钮与会话筛选。
     * 组件本身不渲染任何东西；会话切换时更新模块变量并触发一次抽屉/浮钮重绘。
     */
    /**
     * 右侧栏「决策收件箱」页签的主体：紧凑列表 + 打开完整抽屉。
     * 由 apply() 在宿主提供 `sidebarRightTabs` 时挂上（见下方 inject 注册）。
     */
    function DecisionRightPaneTab() {
      const store = w2mDcStore();
      const [snap, setSnap] = React.useState(() => store.snapshot());
      React.useEffect(() => {
        store.start();
        const unsubscribe = store.subscribe(() => setSnap(store.snapshot()));
        return unsubscribe;
      }, [store]);
      const pending = store.state.items.filter((item) => item?.status === undefined || item?.status === 'pending');
      return h('div', { className: 'w2mDcPane' }, [
        h('div', { key: 'head', className: 'w2mDcPaneHead' }, [
          h('span', { key: 'title', className: 'w2mDcPaneTitle' }, '决策收件箱' + (snap.pending > 0 ? ' · ' + snap.pending : '')),
          h('button', { key: 'open', type: 'button', className: 'w2mDcBtn', onClick: () => store.openDrawer() }, '打开抽屉'),
        ]),
        pending.length === 0 ? h('div', { key: 'empty', className: 'w2mDcPaneEmpty' }, '暂无待处理决策') : null,
        ...pending.slice(0, 8).map((ticket) => h('div', { key: ticket.id, className: 'w2mDcPaneRow' }, [
          h('span', { key: 'dot', className: 'w2mDcDot', 'data-level': ticket?.level ?? 'blue' }),
          h('span', { key: 'title', className: 'w2mDcPaneRowTitle', title: ticket?.title ?? '' }, ticket?.title ?? '(未命名)'),
          h('span', { key: 'level', className: 'w2mDcTag' }, String(ticket?.level ?? 'blue')),
        ])),
      ]);
    }

    function DecisionSessionSeat({ sessionId }) {
      React.useEffect(() => {
        w2mDcSetSession(sessionId);
        return () => { w2mDcSetSession(''); };
      }, [sessionId]);
      return null;
    }

    /**
     * 红色 GPW 待审批的全局确认弹窗（v3.2.7 收尾）：不依赖 GPW 面板是否打开。
     * 每 2 秒读一次 /api/w2m/gpw/state；出现红色 pending 就浮出「确认允许 / 确认拒绝」，
     * 条目不在了自动收起；只做用户点击后的决定，不自动执行。
     */
    function mountGpwRedAlert() {
      if (typeof document === 'undefined' || document.body === undefined) return () => {};
      const overlay = dcEl('div', { className: 'w2mGpwRedOverlay', style: { display: 'none' } });
      document.body.append(overlay);
      let alive = true;
      let busy = false;
      const hide = () => {
        overlay.style.display = 'none';
        overlay.replaceChildren();
      };
      const decide = async (id, decision) => {
        if (busy) return;
        busy = true;
        try {
          await fetch('/api/w2m/gpw/decide', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ id, decision }),
          });
        } catch { /* 下一轮轮询会重新读取状态 */ }
        busy = false;
        hide();
      };
      const render = (red) => {
        const rows = [
          dcEl('div', { className: 'w2mGpwRedTitle' }, ['红色风险：已暂停，请确认']),
          dcEl('div', { className: 'w2mGpw_note' }, [String(red.tool ?? 'tool') + ' · ' + String(red.reason ?? '')]),
        ];
        if (Array.isArray(red.paths)) {
          for (const path of red.paths.slice(0, 5)) rows.push(dcEl('div', { className: 'w2mGpw_path' }, [String(path)]));
        }
        if (red.ai && red.ai.reason) {
          rows.push(dcEl('div', { className: 'w2mGpwAiReason' }, [
            'AI：' + (red.ai.action === 'deny' ? '建议拒绝' : '建议允许') + ' · ' + String(red.ai.reason),
          ]));
        }
        rows.push(dcEl('div', { className: 'w2mGpw_actions' }, [
          dcEl('button', { type: 'button', className: 'w2mGpw_btn', onClick: () => { void decide(red.id, 'allow'); } }, ['确认允许']),
          dcEl('button', { type: 'button', className: 'w2mGpw_btn', onClick: () => { void decide(red.id, 'deny'); } }, ['确认拒绝']),
        ]));
        overlay.replaceChildren(dcEl('div', { className: 'w2mGpwRedCard' }, rows));
        overlay.style.display = 'flex';
      };
      const poll = async () => {
        if (!alive) return;
        try {
          const response = await fetch('/api/w2m/gpw/state', { credentials: 'same-origin', headers: { accept: 'application/json' } });
          const state = response.ok ? await response.json() : null;
          const red = (Array.isArray(state?.pending) ? state.pending : [])
            .find((item) => String(item?.level ?? item?.color ?? '') === 'red');
          if (red === undefined) { hide(); return; }
          render(red);
        } catch { /* 保持上一次状态 */ }
      };
      void poll();
      const timer = setInterval(() => { void poll(); }, 2000);
      timer.unref?.();
      return () => {
        alive = false;
        clearInterval(timer);
        try { overlay.remove(); } catch { /* ignore */ }
      };
    }

/** GPW 面板头部的收件箱按钮：React 组件，只订阅 store 的未读数。 */
    function DecisionInboxButton({ t: _t }) {
      const store = w2mDcStore();
      const [snap, setSnap] = React.useState(() => store.snapshot());
      React.useEffect(() => {
        store.start();
        const unsubscribe = store.subscribe(() => setSnap(store.snapshot()));
        const timer = setInterval(() => setSnap(store.snapshot()), 4000);
        return () => { unsubscribe(); clearInterval(timer); };
      }, [store]);
      const label = snap.pending > 0 ? '收件箱 ' + snap.pending : '收件箱';
      const title = snap.pending > 0
        ? '决策收件箱：' + snap.pending + ' 条待处理' + (snap.red > 0 ? '，其中 ' + snap.red + ' 条红色' : '')
        : '决策收件箱';
      return h('button', {
        key: 'decision-inbox',
        type: 'button',
        className: 'w2mGpw_btn w2mDcGpwBtn',
        title,
        'data-tone': snap.red > 0 ? 'red' : snap.pending > 0 ? 'warn' : 'idle',
        onClick: () => store.openDrawer(),
      }, h('span', { key: 'dot', className: 'w2mGpw_dot', 'data-c': snap.red > 0 ? 'red' : snap.pending > 0 ? 'yellow' : 'green' }), label);
    }

    // ─── 队列日志 UI（v3.2.2）：常驻 composer chip + 右侧浮标 + 抽屉 + GPW 按钮 ────────────
    //
    // 瓮城的 queue-journal 只在「有草稿/队列快照」时才在 composer 下方渲染一排按钮；没数据时整块
    // 消失，看起来就像“未生效”。W2M 这一版把入口做成常驻的：
    //   * composer dock 永远有一枚「队列日志」chip（点开抽屉）；
    //   * 右侧中部第二枚浮标「队列」（固定可见）；
    //   * GPW 面板头部「队列 N」按钮；
    //   * 抽屉里按时间列出所有会话的草稿/队列快照，可恢复草稿、恢复队列、清除，均需用户点击。
    const JQ_PREFIX = '/api/w2m/composer/journal';

    /** createQueueJournalModule().apply() 时由模块注入；为空说明模块没挂上。 */
    let w2mQueueJournalHelpers = null;

    /** v3.2.10：客户端 sessions 服务——会话标题的唯一来源；拿不到就显示“未知会话”，绝不回退显示 ID。 */
    let w2mClientSessions = null;

    function clientSessionTitles() {
      const list = w2mClientSessions?.list;
      if (list === undefined || typeof list.getSnapshot !== 'function') return {};
      try {
        const byId = list.getSnapshot()?.byId ?? {};
        const titles = {};
        for (const [id, row] of Object.entries(byId)) {
          const title = String(row?.displayTitle ?? row?.title ?? '').trim();
          if (title !== '') titles[id] = title;
        }
        return titles;
      } catch { return {}; }
    }

    /** v3.3.6：宿主直读 DSH 会话日志（人类输入 + 最后一条 assistant 消息）。 */
    async function sessionLogRequest(sessionId, limit = 60) {
      const id = String(sessionId ?? '').trim();
      if (id === '') return null;
      try {
        const response = await fetch('/api/w2m/composer/journal/session-log?sessionId=' + encodeURIComponent(id) + '&limit=' + Math.max(1, Math.min(200, Number(limit) || 60)), { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (response.ok !== true) return null;
        return await response.json();
      } catch { return null; }
    }

    /**
     * v3.3.18: which journal rows are human input. An empty `sessionKey` is not evidence of a
     * machine row: older clients saved `sessionKey: ""` beside a real `session-<uuid>` key, and
     * the nullish fallback kept the empty string, hiding every human row in the machine block.
     */
    function isHumanJournalEntry(entry) {
      return String(entry?.sessionKey || entry?.key || '').startsWith('session-');
    }

    /**
     * v3.4.0: the journal stores `title: ""` until a later save; `??` kept that empty string and
     * skipped the sessions map, so every row rendered 未知会话. Fall back on falsy and try both the
     * `session-<uuid>` and bare `<uuid>` map keys, because the sessions service and the journal differ.
     */
    function sessionTitleForEntry(entry, sessions) {
      const stored = String(entry?.title ?? '').trim();
      if (stored !== '') return stored;
      const raw = String(entry?.sessionKey || entry?.key || '').trim();
      if (raw === '') return '';
      const bare = raw.replace(/^session-/, '');
      for (const key of [bare, raw, 'session-' + bare]) {
        const title = String(sessions?.[key] ?? '').trim();
        if (title !== '') return title;
      }
      return '';
    }

    /** 一条记录只有草稿或排队消息时才值得显示。 */
    function jqHasContent(entry) {
      const draft = String(entry?.draft ?? '').trim();
      const queue = Array.isArray(entry?.queue) ? entry.queue.filter((item) => String(item?.text ?? '').trim() !== '') : [];
      return draft !== '' || queue.length > 0;
    }

    async function jqRequest(path, init = {}) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        ...init,
        headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) {
        const error = new Error(body?.error ?? body?.reason ?? 'HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return body ?? {};
    }

    function createQueueJournalStore() {
      const state = {
        entries: [],
        open: false,
        loading: false,
        loadedOnce: false,
        error: '',
        busy: '',
        status: '',
        sessions: {},
        history: [],
      };
      const listeners = new Set();
      let timer = null;
      let started = false;
      let disposed = false;
      const emit = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* ignore */ } } };
      const set = (patch) => { Object.assign(state, patch); emit(); };

      const refresh = async () => {
        if (disposed) return;
        if (state.loading !== true) set({ loading: true });
        try {
          const [body, sessionsBody, historyBody] = await Promise.all([
            jqRequest(JQ_PREFIX + '?list=1'),
            jqRequest(JQ_PREFIX + '/sessions').catch(() => null),
            jqRequest(JQ_PREFIX + '/history?limit=20').catch(() => null),
          ]);
          const entries = Array.isArray(body?.entries) ? body.entries : [];
          const sessions = {};
          for (const item of Array.isArray(sessionsBody?.items) ? sessionsBody.items : []) {
            const id = String(item?.id ?? '');
            if (id !== '') sessions[id] = String(item?.title ?? '');
          }
          // 客户端 sessions 服务的 displayTitle 优先（宿主路由拿不到标题时这里是真正的来源）。
          const history = Array.isArray(historyBody?.items) ? historyBody.items : [];
          set({ entries, history, sessions: { ...sessions, ...clientSessionTitles() }, loading: false, error: '', loadedOnce: true });
        } catch (error) {
          set({ loading: false, error: String(error?.message ?? error), loadedOnce: true });
        }
      };

      const start = () => {
        if (started || disposed) return;
        started = true;
        void refresh();
        timer = setInterval(() => { void refresh(); }, 8000);
      };

      const stop = () => {
        disposed = true;
        if (timer !== null) clearInterval(timer);
        timer = null;
      };

      const act = async (label, work) => {
        set({ busy: label, status: '' });
        try {
          await work();
        } catch (error) {
          set({ error: String(error?.message ?? error) });
        } finally {
          set({ busy: '' });
        }
      };

      const helpers = () => w2mQueueJournalHelpers;

      const api = {
        state,
        refresh,
        start,
        stop,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        snapshot() {
          const all = state.entries;
          // v3.2.6：「人类输入」= 真实会话键（session-…）；其余都是客户端/页面自身生成的记录，默认折叠。
          const isHuman = (entry) => isHumanJournalEntry(entry);
          const human = all.filter((entry) => isHuman(entry) && jqHasContent(entry));
          const clientAll = all.filter((entry) => !isHuman(entry));
          const queued = human.reduce((sum, entry) => sum + (Array.isArray(entry?.queue) ? entry.queue.length : 0), 0);
          const drafts = human.filter((entry) => String(entry?.draft ?? '').trim() !== '').length;
          return { total: human.length, clientTotal: clientAll.length, queued, drafts, busy: state.busy, error: state.error, open: state.open, loading: state.loading, sessions: state.sessions };
        },
        openDrawer() {
          start();
          set({ open: true });
          return refresh();
        },
        closeDrawer() {
          set({ open: false });
        },
        toggleDrawer() {
          if (state.open) api.closeDrawer();
          else api.openDrawer();
        },
        async restoreDraft(entry) {
          return act('draft', async () => {
            const draftText = String(entry?.draft ?? '');
            if (draftText === '') { set({ status: '这条记录没有草稿' }); return; }
            const helper = helpers();
            const ok = typeof helper?.writeComposer === 'function' ? helper.writeComposer(draftText) : false;
            set({ status: ok ? '草稿已放入输入框' : '未找到输入框，请先打开一个会话来恢复' });
          });
        },
        async restoreQueue(entry) {
          return act('queue', async () => {
            const items = Array.isArray(entry?.queue) ? entry.queue : [];
            if (items.length === 0) { set({ status: '这条记录没有排队消息' }); return; }
            const helper = helpers();
            if (helper === null || typeof helper.queueRestore !== 'function') {
              set({ status: '宿主路由不可用，无法恢复队列' });
              return;
            }
            const sessionId = String(entry?.sessionKey || entry?.key || '');
            const restored = await helper.queueRestore(sessionId, items);
            set({
              status: restored.ok
                ? `已放回 ${restored.queued} 条排队消息${restored.failed ? `（${restored.failed} 条失败）` : ''}`
                : restored.error === 'session-not-live'
                  ? '会话未运行，队列保留待重试'
                  : '队列恢复失败：' + String(restored.error ?? 'unknown'),
            });
          });
        },
        async clearAll() {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function'
            && window.confirm('确定清空全部队列日志？每条记录会先归档到历史快照（可在抽屉下方「历史快照」里恢复）。') !== true) return;
          return act('clear-all', async () => {
            const entries = state.entries.slice();
            for (const entry of entries) {
              const key = String(entry?.key ?? '');
              if (key === '') continue;
              const hasContent = String(entry?.draft ?? '').trim() !== '' || (Array.isArray(entry?.queue) && entry.queue.length > 0);
              try {
                if (hasContent) {
                  await jqRequest(JQ_PREFIX, { method: 'POST', body: JSON.stringify({ key, draft: entry.draft ?? '', queue: entry.queue ?? [], title: entry.title ?? '', path: entry.path ?? '', sessionKey: entry.sessionKey || (isHumanJournalEntry(entry) ? entry.key : '') }) });
                }
                await jqRequest(JQ_PREFIX, { method: 'POST', body: JSON.stringify({ key, draft: '', queue: [] }) });
              } catch { /* keep going */ }
            }
            set({ status: '已清空 ' + entries.length + ' 条记录（已归档到历史快照）' });
            await refresh();
          });
        },
        async clear(entry) {
          return act('clear', async () => {
            await jqRequest(JQ_PREFIX, { method: 'POST', body: JSON.stringify({ key: String(entry?.key ?? ''), draft: '', queue: [] }) });
            set({ status: '已清除这条记录' });
            await refresh();
          });
        },
      };
      return api;
    }

    let w2mJqStoreInstance = null;
    function w2mJqStore() {
      if (w2mJqStoreInstance === null) w2mJqStoreInstance = createQueueJournalStore();
      return w2mJqStoreInstance;
    }

    /** 右侧中部的第二枚浮标（在收件箱浮标下方）+ 队列日志抽屉。 */
    function mountQueueJournalUI() {
      if (typeof document === 'undefined' || document.body === undefined) return () => {};
      const store = w2mJqStore();
      const badge = dcEl('button', {
        type: 'button',
        hidden: true,
        className: 'w2mJqBadge',
        'data-w2m-queue-ui': '1',
        title: '队列日志：未发送的草稿与排队消息',
        'aria-label': '队列日志',
      });
      const badgeIcon = dcEl('span', { className: 'w2mJqBadgeIcon' }, ['☰']);
      const badgeText = dcEl('span', { className: 'w2mJqBadgeText' }, ['队列']);
      const badgeCount = dcEl('span', { className: 'w2mJqBadgeCount' }, ['0']);
      badge.append(badgeIcon, badgeText, badgeCount);
      badge.addEventListener('click', () => store.toggleDrawer());

      const overlay = dcEl('div', { className: 'w2mDcOverlay', 'data-w2m-queue-ui': '1' });
      overlay.style.display = 'none';
      const drawer = dcEl('aside', { className: 'w2mDcDrawer w2mJqDrawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '队列日志', 'data-w2m-queue-ui': '1' });
      drawer.style.display = 'none';
      const header = dcEl('div', { className: 'w2mDcDrawerHead' });
      const title = dcEl('div', { className: 'w2mDcDrawerTitle' }, ['队列日志']);
      const count = dcEl('span', { className: 'w2mDcUnread', hidden: true }, ['0']);
      const headActions = dcEl('div', { className: 'w2mDcActions' });
      const clearAllButton = dcEl('button', { type: 'button', className: 'w2mDcBtn w2mJqClearAll', title: '清空全部队列日志记录' }, ['清空全部']);
      const refreshButton = dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['刷新']);
      const closeButton = dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['关闭']);
      clearAllButton.addEventListener('click', () => { void store.clearAll(); });
      refreshButton.addEventListener('click', () => { void store.refresh(); });
      closeButton.addEventListener('click', () => store.closeDrawer());
      headActions.append(clearAllButton, refreshButton, closeButton);
      header.append(title, count, headActions);
      const hint = dcEl('div', { className: 'w2mJqHint' }, ['只显示真的还有草稿或排队消息的人类会话；没有草稿也没有消息的会话不会出现在这里。不显示任何会话编号。']);
      const statusLine = dcEl('div', { className: 'w2mJqStatus', role: 'status' }, ['']);
      const body = dcEl('div', { className: 'w2mDcBody' });
      const errorLine = dcEl('div', { className: 'w2mDcError', role: 'alert', hidden: true });
      drawer.append(header, hint, errorLine, statusLine, body);
      overlay.append(drawer);
      document.body.append(badge, overlay);
      let queueStarted = false;
      const stopQueueGate = watchSubpluginRoute('/api/w2m/composer/journal?list=1', (enabled) => {
        badge.hidden = !enabled;
        if (enabled && !queueStarted) { queueStarted = true; store.start(); }
        if (!enabled) store.closeDrawer();
      });
      overlay.addEventListener('click', (event) => { if (event.target === overlay) store.closeDrawer(); });
      const onKey = (event) => { if (event.key === 'Escape' && store.state.open) store.closeDrawer(); };
      document.addEventListener('keydown', onKey);

      const entryCard = (entry) => {
        const card = dcEl('div', { className: 'w2mJqEntry' });
        const head = dcEl('div', { className: 'w2mJqEntryHead' });
        const updated = String(entry?.updatedAt ?? '').replace('T', ' ').slice(0, 16);
        // v3.2.10：会话名 = 记录保存时的标题 / 客户端 sessions 服务的 displayTitle / “未知会话”。绝不显示 ID。
        const sessionTitle = sessionTitleForEntry(entry, store.state.sessions);
        const friendlyName = sessionTitle !== '' ? sessionTitle : '未知会话';
        head.append(
          dcEl('span', { className: 'w2mJqEntryKey', title: friendlyName }, [friendlyName]),
          dcEl('span', { className: 'w2mJqEntryTime' }, [updated]),
        );
        card.append(head);
        const draftText = String(entry?.draft ?? '').trim();
        if (draftText !== '') {
          card.append(dcEl('div', { className: 'w2mJqDraft', title: draftText }, ['草稿：' + (draftText.length > 140 ? draftText.slice(0, 137) + '…' : draftText)]));
        }
        const queue = Array.isArray(entry?.queue) ? entry.queue : [];
        if (queue.length > 0) {
          card.append(dcEl('div', { className: 'w2mJqQueueSummary' }, ['排队消息：' + queue.length + ' 条']));
          const list = dcEl('div', { className: 'w2mJqQueueList' });
          for (const [index, item] of queue.slice(0, 8).entries()) {
            const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim();
            list.append(dcEl('div', { className: 'w2mJqQueueRow', title: text }, [String(index + 1) + '. ' + (text.length > 120 ? text.slice(0, 117) + '…' : text)]));
          }
          card.append(list);
        }
        const actions = dcEl('div', { className: 'w2mDcActions' });
        const busy = store.state.busy !== '';
        const draftButton = dcEl('button', { type: 'button', className: 'w2mDcBtn w2mDcBtnPrimary', disabled: busy || draftText === '' }, ['恢复草稿']);
        const queueButton = dcEl('button', { type: 'button', className: 'w2mDcBtn', disabled: busy || queue.length === 0 }, ['恢复队列']);
        const clearButton = dcEl('button', { type: 'button', className: 'w2mDcBtn w2mDcBtnDanger', disabled: busy }, ['清除']);
        draftButton.addEventListener('click', () => { void store.restoreDraft(entry); });
        queueButton.addEventListener('click', () => { void store.restoreQueue(entry); });
        clearButton.addEventListener('click', () => { void store.clear(entry); });
        actions.append(draftButton, queueButton, clearButton);
        card.append(actions);
        return card;
      };

      const render = () => {
        const snap = store.snapshot();
        badgeCount.textContent = String(snap.total);
        const queueTone = snap.total === 0 ? 'idle' : snap.total <= 30 ? 'blue' : snap.total <= 50 ? 'yellow' : 'red';
        badge.setAttribute('data-tone', queueTone);
        count.hidden = snap.total === 0;
        count.textContent = String(snap.total);
        title.textContent = '队列日志' + (snap.total > 0 ? ' · ' + snap.total + ' 条人类输入' : '') + (snap.clientTotal > 0 ? ' · ' + snap.clientTotal + ' 条机器生成记录已折叠' : '');
        overlay.style.display = snap.open === true ? 'flex' : 'none';
        drawer.style.display = snap.open === true ? 'flex' : 'none';
        overlay.setAttribute('aria-hidden', snap.open === true ? 'false' : 'true');
        if (snap.open !== true) return;
        errorLine.hidden = snap.error === '';
        errorLine.textContent = snap.error === '' ? '' : '队列日志不可用：' + snap.error;
        statusLine.textContent = store.state.status;
        body.replaceChildren();
        const isHumanEntry = (entry) => isHumanJournalEntry(entry);
        const humanEntries = store.state.entries.filter((entry) => isHumanEntry(entry) && jqHasContent(entry));
        const clientAll = store.state.entries.filter((entry) => !isHumanEntry(entry));
        const clientEntries = clientAll.filter((entry) => jqHasContent(entry));
        if (humanEntries.length === 0 && clientAll.length === 0) {
          body.append(dcEl('div', { className: 'w2mDcEmpty' }, [snap.loading ? '正在读取队列日志…' : '队列日志是空的：输入框里的草稿与排队消息会自动保存到这里（重启/崩溃后可恢复）。']));
          return;
        }
        // v3.3.14: two explicit blocks — human input first, machine-generated records folded below.
        body.append(dcEl('div', { className: 'w2mJqSectionHead' }, [`人类输入 · ${humanEntries.length} 条`]));
        for (const entry of humanEntries) body.append(entryCard(entry));
        if (humanEntries.length === 0) body.append(dcEl('div', { className: 'w2mJqSectionNote' }, ['当前没有人类输入记录。']));
        if (clientAll.length > 0) {
          const hidden = clientAll.length - clientEntries.length;
          const fold = dcEl('details', { className: 'w2mJqClientFold' });
          fold.append(dcEl('summary', { className: 'w2mJqClientFoldSummary' }, ['机器生成 · ' + clientAll.length + ' 条（默认折叠' + (hidden > 0 ? `，${hidden} 条空记录已隐藏` : '') + '）']));
          const foldBody = dcEl('div', { className: 'w2mJqClientFoldBody' });
          for (const entry of clientEntries) foldBody.append(entryCard(entry));
          if (clientEntries.length === 0) foldBody.append(dcEl('div', { className: 'w2mJqSectionNote' }, ['这些记录没有草稿或排队内容。']));
          fold.append(foldBody);
          body.append(fold);
        }
        const history = Array.isArray(store.state.history) ? store.state.history.slice(0, 12) : [];
        if (history.length > 0) {
          const fold = dcEl('details', { className: 'w2mJqHistoryFold' });
          fold.append(dcEl('summary', { className: 'w2mJqHistorySummary' }, ['历史快照 · ' + history.length + ' 条（可恢复）']));
          const list = dcEl('div', { className: 'w2mJqHistoryList' });
          for (const item of history) {
            const row = dcEl('div', { className: 'w2mJqHistoryRow' });
            const queue = Array.isArray(item?.queue) ? item.queue : [];
            const draft = String(item?.draft ?? '');
            const when = String(item?.updatedAt ?? '').replace('T', ' ').slice(0, 16);
            row.append(dcEl('span', { className: 'w2mJqHistoryMeta' }, [when + ' · 草稿 ' + (draft.trim() === '' ? '无' : '有') + ' · 排队 ' + queue.length]));
            if (draft.trim() !== '') {
              const b = dcEl('button', { type: 'button', className: 'w2mDcBtn', title: '把这份快照的草稿填回输入框' }, ['恢复草稿']);
              b.addEventListener('click', () => { void store.restoreDraft(item); });
              row.append(b);
            }
            if (queue.length > 0) {
              const b = dcEl('button', { type: 'button', className: 'w2mDcBtn', title: '把这份快照的排队消息放回官方队列' }, ['恢复队列']);
              b.addEventListener('click', () => { void store.restoreQueue(item); });
              row.append(b);
            }
            list.append(row);
          }
          fold.append(list);
          body.append(fold);
        }
      };
      const unsubscribe = store.subscribe(render);
      render();
      return () => {
        stopQueueGate();
        unsubscribe();
        try { badge.remove(); } catch { /* ignore */ }
        try { overlay.remove(); } catch { /* ignore */ }
        document.removeEventListener('keydown', onKey);
      };
    }

    /** GPW 面板头部的队列日志按钮。 */
    function QueueJournalGpwButton({ t: _t }) {
      const store = w2mJqStore();
      const [snap, setSnap] = React.useState(() => store.snapshot());
      React.useEffect(() => {
        store.start();
        const unsubscribe = store.subscribe(() => setSnap(store.snapshot()));
        return unsubscribe;
      }, [store]);
      const label = snap.total > 0 ? '队列 ' + snap.total : '队列日志';
      const title = snap.total > 0 ? '队列日志：' + snap.total + ' 条保存的记录' + (snap.queued > 0 ? '，' + snap.queued + ' 条排队消息' : '') : '队列日志';
      return h('button', {
        key: 'queue-journal',
        type: 'button',
        className: 'w2mGpw_btn w2mJqGpwBtn',
        title,
        'data-tone': snap.total > 0 ? 'warn' : 'idle',
        onClick: () => store.openDrawer(),
      }, h('span', { key: 'dot', className: 'w2mGpw_dot', 'data-c': snap.total > 0 ? 'yellow' : 'green' }), label);
    }

    /** v3.2.7：GPW 待审批的倒计时文案（红=已暂停等待确认）。 */
    function gpwCountdownText(item, now = Date.now()) {
      const level = String(item?.level ?? item?.color ?? 'yellow');
      if (level === 'red') return '红色 · 已暂停，等待你确认';
      const deadline = Number(item?.deadline_at) || 0;
      const left = deadline > 0 ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
      const action = item?.ai?.action === 'deny' ? '拒绝' : '放行';
      if (left > 0) return level + ' · ' + left + ' 秒后自动' + (level === 'green' ? '放行' : action);
      return level + ' · 倒计时结束';
    }

    /**
     * v3.3.1：AI Token 设置 & 测试（GPW 智能分级）。
     * 状态用颜色徽标，测试结果按成功/失败着色，并展示模型原始回复片段，便于定位
     * unparseable-classification 这类失败。
     */
    function GpwAiSettings({ call, aiState, onChanged }) {
      const [draft, setDraft] = React.useState({
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
      });
      const [busy, setBusy] = React.useState('');
      const [feedback, setFeedback] = React.useState(null);
      const configured = aiState?.configured === true;
      const payload = () => {
        const out = {};
        const provider = String(draft.provider ?? '').trim();
        const model = String(draft.model ?? '').trim();
        const baseUrl = String(draft.baseUrl ?? '').trim();
        const apiKey = String(draft.apiKey ?? '').trim();
        if (provider !== '') out.provider = provider;
        if (model !== '') out.model = model;
        if (baseUrl !== '') out.baseUrl = baseUrl;
        if (apiKey !== '') out.apiKey = apiKey;
        return out;
      };
      const save = async () => {
        setBusy('save');
        setFeedback(null);
        try {
          const body = payload();
          if (body.apiKey === undefined) body.apiKey = '';
          const result = await call('/api/w2m/gpw/ai/config', { method: 'POST', body: JSON.stringify(body) });
          if (result.ok !== true) {
            setFeedback({ tone: 'err', text: '保存失败：' + String(result.error ?? result.body?.error ?? 'error') });
            return;
          }
          const persisted = result.body?.persisted;
          setFeedback({
            tone: 'ok',
            text: '已保存：' + String(result.body?.provider ?? '') + ' / ' + String(result.body?.model ?? '')
              + (persisted?.ok === false ? '（本次运行有效，未持久化：' + String(persisted.reason ?? '') + '）' : '')
              + (result.body?.source ? ' · 来源 ' + String(result.body.source) : ''),
          });
          setDraft((prev) => ({ ...prev, apiKey: '' }));
          if (typeof onChanged === 'function') await onChanged();
        } finally {
          setBusy('');
        }
      };
      const test = async () => {
        setBusy('test');
        setFeedback({ tone: 'info', text: '正在请求模型（可能需要几秒）…' });
        try {
          const result = await call('/api/w2m/gpw/ai/test', { method: 'POST', body: JSON.stringify(payload()) });
          if (result.ok !== true) {
            const raw = result.body?.raw;
            setFeedback({
              tone: 'err',
              text: '测试失败：' + String(result.error ?? result.body?.error ?? 'error')
                + (typeof raw === 'string' && raw !== '' ? ' · 模型原始返回：' + raw : ''),
            });
            return;
          }
          const body = result.body ?? {};
          setFeedback({
            tone: 'ok',
            level: String(body.level ?? ''),
            text: '测试通过：模型判为 ' + String(body.level ?? '?') + ' · ' + (String(body.action) === 'deny' ? '建议拒绝' : '建议允许')
              + (body.reason ? ' · ' + String(body.reason) : '')
              + (body.elapsed_ms !== undefined ? ' · ' + String(body.elapsed_ms) + 'ms' : '')
              + (body.repaired === true ? '（已自动修复格式）' : ''),
          });
          if (typeof onChanged === 'function') await onChanged();
        } finally {
          setBusy('');
        }
      };
      const input = (key, extra = {}) => h('input', {
        key,
        className: 'w2mAiInput',
        value: draft[key],
        ...extra,
        onChange: (event) => setDraft((prev) => ({ ...prev, [key]: event.target.value })),
      });
      return h('details', { className: 'w2mAiPanel', open: true }, [
        h('summary', { key: 'summary', className: 'w2mAiSummary' }, [
          h('span', { key: 't', className: 'w2mAiTitle' }, 'AI 智能分级（红/黄/蓝/绿）'),
          h('span', { key: 'chip', className: 'w2mAiChip', 'data-tone': configured ? 'ok' : 'warn' }, configured ? '已配置' : '未配置'),
        ]),
        h('div', { key: 'hint', className: 'w2mAiHint' }, configured
          ? '当前：' + String(aiState?.provider ?? '') + ' / ' + String(aiState?.model ?? '') + (aiState?.source ? ' · 来源 ' + String(aiState.source) : '') + ' · Token 只保存在本机'
          : '填入大模型 Token 后，GPW 待审批会按红/黄/蓝/绿分级并倒计时；Token 只保存在本机（DPAPI/钥匙串），默认复用决策中心 Key。'),
        h('div', { key: 'grid', className: 'w2mAiGrid' }, [
          h('label', { key: 'lp', className: 'w2mAiField' }, [h('span', { key: 'l', className: 'w2mAiLabel' }, 'provider'), input('provider', { placeholder: 'deepseek' })]),
          h('label', { key: 'lm', className: 'w2mAiField' }, [h('span', { key: 'l', className: 'w2mAiLabel' }, 'model'), input('model', { placeholder: 'deepseek-flash' })]),
          h('label', { key: 'lb', className: 'w2mAiField w2mAiFieldWide' }, [h('span', { key: 'l', className: 'w2mAiLabel' }, 'baseUrl'), input('baseUrl', { placeholder: 'https://api.deepseek.com/v1' })]),
          h('label', { key: 'lk', className: 'w2mAiField w2mAiFieldWide' }, [h('span', { key: 'l', className: 'w2mAiLabel' }, 'Token（保存后清空显示）'), input('apiKey', { type: 'password', placeholder: configured ? '已保存（重新填写可覆盖）' : '粘贴大模型 API Token' })]),
        ]),
        h('div', { key: 'actions', className: 'w2mAiActions' }, [
          h('button', { key: 'save', type: 'button', className: 'w2mAiBtn w2mAiBtnPrimary', disabled: busy !== '', onClick: () => void save() },
            busy === 'save' ? '保存中…' : '保存 Token'),
          h('button', { key: 'test', type: 'button', className: 'w2mAiBtn', disabled: busy !== '', onClick: () => void test() },
            busy === 'test' ? '测试中…' : '测试分级'),
          h('button', { key: 'refresh', type: 'button', className: 'w2mAiBtn', disabled: busy !== '', onClick: () => { if (typeof onChanged === 'function') void onChanged(); } }, '刷新状态'),
        ]),
        feedback === null ? null : h('div', { key: 'fb', className: 'w2mAiFeedback', 'data-tone': feedback.tone, role: 'status' }, [
          feedback.level ? h('span', { key: 'lv', className: 'w2mGpw_dot', 'data-c': feedback.level }) : null,
          h('span', { key: 'text' }, feedback.text),
        ]),
        h('div', { key: 'legend', className: 'w2mAiHint' }, '红：暂停并人工确认 · 黄：180 秒后执行 AI 推荐 · 蓝：30 秒后执行 AI 推荐 · 绿：3 秒默认放行'),
      ]);
    }

    function GpwPanel({ t, sessionId, onClose, inline }) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [manual, setManual] = React.useState('');
      const [badPath, setBadPath] = React.useState(null);
      const [expanded, setExpanded] = React.useState({});
      // v3.2.6: Esc 关闭浮动面板（设置页内联渲染没有 onClose，不受影响）。
      React.useEffect(() => {
        if (inline === true || typeof onClose !== 'function') return undefined;
        const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [inline, onClose]);
      const call = React.useCallback(async (url, init) => {
        try {
          const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...init });
          let body = null;
          try { body = await response.json(); } catch { body = null; }
          if (response.status === 404) return { ok: false, routeMissing: true, error: 'GPW route missing' };
          if (response.ok !== true || body?.ok === false) return { ok: false, error: body?.error ?? ('HTTP ' + response.status) };
          return { ok: true, body };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }, []);
      const load = React.useCallback(async () => {
        const result = await call('/api/w2m/gpw/state', { method: 'GET' });
        if (result.ok) { setState(result.body); setError(null); } else setError(result.routeMissing ? t('gpwDisabled') : (result.error ?? 'error'));
      }, [call, t]);
      React.useEffect(() => {
        load();
        const timer = setInterval(() => { load(); }, 3000);
        return () => clearInterval(timer);
      }, [load]);
      const addFolder = async (list, path) => {
        setBusy(true);
        try {
          const result = await call('/api/w2m/gpw/folders', { method: 'POST', body: JSON.stringify({ action: 'add', list, path }) });
          if (result.ok !== true) { setBadPath(result.error ?? 'error'); return false; }
          setBadPath(null);
          await load();
          return true;
        } finally { setBusy(false); }
      };
      const addTyped = async (list) => {
        const ok = await addFolder(list, manual);
        if (ok === true) setManual('');
      };
      const removeFolder = async (list, path) => {
        setBusy(true);
        try { await call('/api/w2m/gpw/folders', { method: 'POST', body: JSON.stringify({ action: 'remove', list, path }) }); await load(); } finally { setBusy(false); }
      };
      const decide = async (id, decision) => {
        setBusy(true);
        try { await call('/api/w2m/gpw/decide', { method: 'POST', body: JSON.stringify({ id, decision }) }); await load(); } finally { setBusy(false); }
      };
      const setMode = async (mode) => {
        setBusy(true);
        try { await call('/api/w2m/gpw/folders', { method: 'POST', body: JSON.stringify({ action: 'set-mode', mode }) }); await load(); } finally { setBusy(false); }
      };
      // v3.3.1: AI Token 设置与测试集中在 GpwAiSettings（带颜色状态/测试结果/原始回复提示）。

      /** v1.7.9: after a tamper report the signed lists are locked until the operator resets them. */
      const resetLists = async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(t('gpwResetConfirm')) !== true) return;
        setBusy(true);
        try { await call('/api/w2m/gpw/reset', { method: 'POST', body: JSON.stringify({ confirm: 'reset' }) }); await load(); } finally { setBusy(false); }
      };
      /** v1.7.9: lists show three rows by default; the rest fold behind one toggle. */
      const foldItems = (items, key) => (expanded[key] === true ? items : items.slice(0, 3));
      const foldRow = (items, key) => (items.length <= 3 ? null : h('button', {
        key: 'fold-' + key,
        type: 'button',
        className: 'w2mGpw_btn',
        disabled: busy,
        onClick: () => setExpanded((prev) => ({ ...prev, [key]: prev[key] !== true })),
      }, expanded[key] === true ? t('gpwFold') : t('gpwMore', { count: items.length - 3 })));
      const allowWithFolder = async (item, list) => {
        if (typeof item?.folder !== 'string' || item.folder === '') return;
        const added = await addFolder(list, item.folder);
        if (added === true) await decide(item.id, list === 'whitelist' ? 'allow' : 'deny');
      };
      const folderList = (title, list) => {
        const items = Array.isArray(state?.folders?.[list]) ? state.folders[list] : [];
        return h('div', { key: list, className: 'w2mGpw_block' }, [
          h('div', { key: 'title', className: 'w2mGpw_title' }, title),
          ...foldItems(items, list).map((path) => h('div', { key: path, className: 'w2mGpw_row' }, [
            h('span', { key: 'p', className: 'w2mGpw_path', title: path }, path),
            h('button', { key: 'x', type: 'button', className: 'w2mGpw_small', disabled: busy, onClick: () => removeFolder(list, path) }, '×'),
          ])),
          foldRow(items, list),
        ]);
      };
      const recentAll = Array.isArray(state?.recent) ? state.recent : [];
      const recent = recentAll.filter((item) => item?.folder_in === null || item?.folder_in === undefined);
      const recentInLists = recentAll.filter((item) => item?.folder_in === 'whitelist' || item?.folder_in === 'blacklist');
      const [showRecentInLists, setShowRecentInLists] = React.useState(false);
      const pendingAll = Array.isArray(state?.pending) ? state.pending : [];
      // v1.8.1: an approval belongs to the conversation that raised it; another session must never show it.
      const pending = pendingAll.filter((item) => item?.session_id === null || item?.session_id === undefined || item?.session_id === sessionId);
      const isNovice = state?.mode === 'novice';
      return h('div', {
        className: inline === true ? 'w2mGpw_inline' : 'w2mGpw_overlay',
        role: 'dialog',
        'aria-label': t('gpwTitle'),
        onClick: (event) => {
          // 只有浮动面板有点击外部收起；卡片内部点击不冒泡关闭。
          if (inline !== true && event.target === event.currentTarget && typeof onClose === 'function') onClose();
        },
      }, [
        h('div', { key: 'card', className: 'w2mGpw_card' }, [
          h('div', { key: 'head', className: 'w2mGpw_head' }, [
            h('span', { key: 'title', className: 'w2mGpw_title' }, t('gpwTitle')),
            h(DecisionInboxButton, { key: 'inbox', t }),
            h(QueueJournalGpwButton, { key: 'queue-journal', t }),
            h('button', { key: 'close', type: 'button', className: 'w2mGpw_close', onClick: onClose }, '×'),
          ]),
          error === null ? null : h('div', { key: 'err', className: 'w2mGpw_note' }, error),
          state?.tampered === true ? h('div', { key: 'tampered', className: 'w2mGpw_block' }, [
            h('div', { key: 't', className: 'w2mGpw_note' }, t('gpwTampered', { reason: state?.tampered_reason ?? '' })),
            h('div', { key: 'a', className: 'w2mGpw_actions' }, [
              h('button', { key: 'r', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: resetLists }, t('gpwReset')),
            ]),
          ]) : null,
          h('div', { key: 'colours', className: 'w2mGpw_legend' }, ['green', 'blue', 'yellow', 'red'].map((colour) => h('span', { key: colour, className: 'w2mGpw_legendItem' }, [h('span', { key: 'd', className: 'w2mGpw_dot', 'data-c': colour }), String(state?.counters?.colors?.[colour] ?? 0)]))),
          h('div', { key: 'mode', className: 'w2mGpw_block' }, [
            h('div', { key: 't', className: 'w2mGpw_title' }, '模式'),
            h('div', { key: 'b', className: 'w2mGpw_actions' }, [
              h('button', { key: 'n', type: 'button', className: 'w2mGpw_btn', disabled: busy || isNovice === true, onClick: () => setMode('novice') }, '小白模式（默认：仅黑名单）'),
              h('button', { key: 'a', type: 'button', className: 'w2mGpw_btn', disabled: busy || state?.mode === 'advanced', onClick: () => setMode('advanced') }, '高级模式（黑白名单）'),
            ]),
            h('div', { key: 'h', className: 'w2mGpw_hint' }, isNovice === true ? '黑名单强制拒绝，其余放行；每 3 秒最多自动放行一次路径操作' : '白名单放行、黑名单拒绝、其余等待审批（10 秒无人应答自动放行）'),
          ]),
          h('div', { key: 'manual', className: 'w2mGpw_manual' }, [
            h('div', { key: 'label', className: 'w2mGpw_title' }, t('gpwManual')),
            h('input', {
              key: 'input',
              className: 'w2mGpw_input',
              value: manual,
              placeholder: t('gpwManualPlaceholder'),
              onChange: (event) => { setManual(event.target.value); setBadPath(null); },
              onKeyDown: (event) => { if (event.key === 'Enter' && manual.trim() !== '') addTyped('whitelist'); },
            }),
            h('div', { key: 'buttons', className: 'w2mGpw_actions' }, [
              isNovice === true ? null : h('button', { key: 'w', type: 'button', className: 'w2mGpw_btn', disabled: busy || manual.trim() === '', onClick: () => addTyped('whitelist') }, t('gpwAddWhiteShort')),
              h('button', { key: 'b', type: 'button', className: 'w2mGpw_btn', disabled: busy || manual.trim() === '', onClick: () => addTyped('blacklist') }, t('gpwAddBlackShort')),
            ]),
            badPath === null ? null : h('div', { key: 'bad', className: 'w2mGpw_note' }, t('gpwBadPath', { error: badPath })),
            h('div', { key: 'hint', className: 'w2mGpw_hint' }, t('gpwInputHint')),
          ]),
          isNovice === true ? null : folderList(t('gpwWhitelist'), 'whitelist'),
          isNovice === true ? h('div', { key: 'protected', className: 'w2mGpw_block' }, [
            h('div', { key: 't', className: 'w2mGpw_title' }, '默认保护文件夹（小白模式，强制拒绝）'),
            ...(Array.isArray(state?.protected_folders) ? state.protected_folders : []).map((path) => h('div', { key: path, className: 'w2mGpw_row' }, [h('span', { key: 'p', className: 'w2mGpw_path', title: path }, path)])),
          ]) : null,
          folderList(t('gpwBlacklist'), 'blacklist'),
          h('div', { key: 'recent', className: 'w2mGpw_block' }, [
            h('div', { key: 'title', className: 'w2mGpw_title' }, t('gpwRecent')),
            recent.length === 0 ? h('div', { key: 'none', className: 'w2mGpw_note' }, t('gpwRecentEmpty')) : null,
            ...recent.map((item, index) => h('div', { key: 'r' + index, className: 'w2mGpw_recent' }, [
              h('div', { key: 'r1', className: 'w2mGpw_row' }, [
                h('span', { key: 'd', className: 'w2mGpw_dot', 'data-c': item.color ?? 'green', title: item.decision }),
                h('span', { key: 't', className: 'w2mGpw_path', title: item.paths?.[0] ?? '' }, (item.folder ?? item.paths?.[0] ?? item.tool)),
              ]),
              item.folder === null || item.folder === undefined ? null : h('div', { key: 'r2', className: 'w2mGpw_actions' }, [
                isNovice === true ? null : h('button', { key: 'w', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => addFolder('whitelist', item.folder) }, t('gpwAddWhiteShort')),
                h('button', { key: 'b', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => addFolder('blacklist', item.folder) }, t('gpwAddBlackShort')),
              ]),
            ])),
            foldRow(recent, 'recent'),
          ]),
          recentInLists.length === 0 ? null : h('div', { key: 'recentInLists', className: 'w2mGpw_block' }, [
            h('button', { key: 'toggle', type: 'button', className: 'w2mGpw_btn', 'aria-expanded': showRecentInLists, onClick: () => setShowRecentInLists((value) => !value) }, (showRecentInLists ? '收起' : '展开') + ' · 已在名单中 ' + recentInLists.length + ' 条'),
            ...(showRecentInLists ? recentInLists.map((item, index) => h('div', { key: 'inlist' + index, className: 'w2mGpw_recent' }, [
              h('div', { key: 'r1', className: 'w2mGpw_row' }, [
                h('span', { key: 'd', className: 'w2mGpw_dot', 'data-c': item.color ?? 'green' }),
                h('span', { key: 't', className: 'w2mGpw_path' }, (item.folder ?? '') + ' · 已加入' + (item.folder_in === 'whitelist' ? '白名单' : '黑名单')),
              ]),
            ])) : []),
          ]),
          h(DecisionCenterSection, { key: 'decision-center' }),
          h(GpwAiSettings, { key: 'gpw-ai', call, aiState: state?.ai ?? null, onChanged: load }),
          pending.length === 0 ? null : h('div', { key: 'pending', className: 'w2mGpw_block' }, [
            h('div', { key: 'title', className: 'w2mGpw_title' }, t('gpwPending')),
            ...pending.map((item) => h('div', { key: item.id, className: 'w2mGpw_recent' }, [
              h('div', { key: 'p1', className: 'w2mGpw_path' }, [h('span', { key: 'c', className: 'w2mGpw_dot', 'data-c': item.level ?? item.color ?? 'yellow' }), item.tool + ' · ' + (item.reason ?? '')]),
              h('div', { key: 'pcount', className: 'w2mGpwCountdown' }, gpwCountdownText(item)),
              item.ai?.reason ? h('div', { key: 'pair', className: 'w2mGpwAiReason' }, 'AI：' + (item.ai.action === 'deny' ? '建议拒绝' : '建议允许') + ' · ' + String(item.ai.reason ?? '')) : null,
              ...(Array.isArray(item.paths) ? item.paths.slice(0, 3).map((p, i) => h('div', { key: 'p' + i, className: 'w2mGpw_path' }, p)) : []),
              h('div', { key: 'p2', className: 'w2mGpw_actions' }, [
                h('button', { key: 'a', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => decide(item.id, 'allow') }, t('gpwAllowOnce')),
                h('button', { key: 'd', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => decide(item.id, 'deny') }, t('gpwDenyOnce')),
                item.folder === null || item.folder === undefined ? null : h('button', { key: 'aw', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => allowWithFolder(item, 'whitelist') }, t('gpwAddWhiteAllow')),
                item.folder === null || item.folder === undefined ? null : h('button', { key: 'ab', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => allowWithFolder(item, 'blacklist') }, t('gpwAddBlackDeny')),
              ]),
            ])),
          ]),
        ]),
      ]);
    }

    /**
     * 决策中心（v3.0.0，移植自 dsh-Fang 的决策收件箱）：GPW 设置页与 GPW 浮标渲染同一个面板。
     *
     * 数据面就是本包自己的 `/api/w2m/decisions*`（见 src/decision-center/routes.mjs）：4 秒轮询，
     * 红票置顶、黄/蓝展开、绿/灰默认折叠；解决/放弃/批量都走服务层，UI 不猜状态。
     * AI 建议只做「推荐」，不替人做决定。
     */
    function DecisionCenterSection() {
      const LEVELS = [
        ['red', '紧急决策', '会阻塞 Agent'],
        ['yellow', '建议决策', '影响方向/进度'],
        ['blue', '日常建议', '可按推荐处理'],
        ['green', '通知与汇报', '默认折叠'],
        ['gray', '已归档 / 过期', '只读'],
      ];
      const [state, setState] = React.useState({ status: 'loading', items: [], error: '', busy: '', ai: null, advice: {}, collapsed: { green: true, gray: true }, open: true });
      const load = React.useCallback(async () => {
        try {
          const [listResponse, aiResponse] = await Promise.all([
            fetch('/api/w2m/decisions?includeArchived=1', { credentials: 'same-origin' }),
            fetch('/api/w2m/decisions/ai', { credentials: 'same-origin' }).catch(() => null),
          ]);
          if (!listResponse.ok) {
            setState((prev) => ({ ...prev, status: listResponse.status === 404 ? 'absent' : 'error', error: 'HTTP ' + listResponse.status }));
            return;
          }
          const body = await listResponse.json();
          const aiBody = aiResponse !== null && aiResponse.ok ? await aiResponse.json() : null;
          setState((prev) => ({
            ...prev,
            status: 'ready',
            items: Array.isArray(body?.items) ? body.items : [],
            error: '',
            ai: aiBody,
          }));
        } catch (error) {
          setState((prev) => ({ ...prev, status: 'error', error: String(error?.message ?? error) }));
        }
      }, []);
      React.useEffect(() => {
        let alive = true;
        void load();
        const timer = setInterval(() => { if (alive) void load(); }, 4000);
        return () => { alive = false; clearInterval(timer); };
      }, [load]);
      const post = async (path, body) => {
        const response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? 'HTTP ' + response.status);
        return payload;
      };
      const act = async (kind, ticket, option) => {
        setState((prev) => ({ ...prev, busy: ticket.id, error: '' }));
        try {
          await post('/api/w2m/decisions/' + kind, kind === 'resolve'
            ? { id: ticket.id, option, by: 'w2m-gpw' }
            : { id: ticket.id, by: 'w2m-gpw' });
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }));
        } finally {
          setState((prev) => ({ ...prev, busy: '' }));
          await load();
        }
      };
      const advise = async (ticket) => {
        setState((prev) => ({ ...prev, busy: 'ai:' + ticket.id, error: '' }));
        try {
          const payload = await post('/api/w2m/decisions/ai/advise', { id: ticket.id });
          const text = payload?.advice?.text ?? payload?.advice ?? payload?.ticket?.advice ?? '（无建议文本）';
          setState((prev) => ({ ...prev, advice: { ...prev.advice, [ticket.id]: typeof text === 'string' ? text : JSON.stringify(text) } }));
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }));
        } finally {
          setState((prev) => ({ ...prev, busy: '' }));
        }
      };
      const toggle = (level) => setState((prev) => ({ ...prev, collapsed: { ...prev.collapsed, [level]: !prev.collapsed[level] } }));
      const pending = state.items.filter((item) => item.status === 'pending');
      const title = '决策中心' + (pending.length > 0 ? ' · ' + pending.length + ' 待处理' : '');
      const ticketRow = (ticket) => {
        const options = Array.isArray(ticket.options) ? ticket.options : [];
        return h('div', { key: ticket.id, className: 'w2mDc_ticket' }, [
          h('div', { key: 'head', className: 'w2mDc_head' }, [
            h('span', { key: 'dot', className: 'w2mGpw_dot', 'data-c': ticket.level ?? 'blue' }),
            h('span', { key: 'title', className: 'w2mDc_title', title: ticket.title ?? '' }, ticket.title ?? '(未命名)'),
            h('span', { key: 'meta', className: 'w2mDc_meta' }, (ticket.source?.agentRole ?? ticket.sourceRole ?? '') + (ticket.status !== 'pending' ? ' · ' + ticket.status : '')),
          ]),
          ticket.context ? h('div', { key: 'ctx', className: 'w2mDc_context' }, String(ticket.context)) : null,
          h('div', { key: 'actions', className: 'w2mDc_actions' }, [
            ...options.slice(0, 4).map((option) => h('button', {
              key: 'opt:' + option.value,
              type: 'button',
              className: 'w2mGpw_btn',
              disabled: state.busy !== '' || ticket.status !== 'pending',
              onClick: () => void act('resolve', ticket, option.value),
            }, option.label ?? option.value)),
            ticket.status === 'pending' ? h('button', {
              key: 'ai',
              type: 'button',
              className: 'w2mGpw_btn',
              disabled: state.busy !== '',
              onClick: () => void advise(ticket),
            }, 'AI 建议') : null,
            ticket.status === 'pending' ? h('button', {
              key: 'abandon',
              type: 'button',
              className: 'w2mGpw_btn',
              disabled: state.busy !== '' || options.length > 0,
              onClick: () => void act('abandon', ticket),
            }, '放弃') : null,
          ]),
          state.advice[ticket.id] ? h('div', { key: 'advice', className: 'w2mDc_advice' }, state.advice[ticket.id]) : null,
        ]);
      };
      if (state.status === 'absent') {
        return h('div', { className: 'w2mGpw_block' }, [
          h('div', { key: 't', className: 'w2mGpw_title' }, '决策中心'),
          h('div', { key: 'h', className: 'w2mGpw_hint' }, '决策中心插件未启用：在 profile 的 dsh.profile.bundles 或 patch 中启用 @twinsearth/w2m-dsh-plugin/decision-center'),
        ]);
      }
      return h('div', { className: 'w2mGpw_block' }, [
        h('div', { key: 'head', className: 'w2mGpw_row' }, [
          h('span', { key: 't', className: 'w2mGpw_title' }, title),
          h('button', { key: 'toggle', type: 'button', className: 'w2mGpw_btn', onClick: () => setState((prev) => ({ ...prev, open: !prev.open })) }, state.open ? '收起' : '展开'),
          h('button', { key: 'reload', type: 'button', className: 'w2mGpw_btn', onClick: () => void load() }, '刷新'),
        ]),
        state.error !== '' ? h('div', { key: 'error', className: 'w2mGpw_note' }, '决策中心不可用：' + state.error) : null,
        state.status === 'loading' ? h('div', { key: 'loading', className: 'w2mGpw_hint' }, '正在读取决策队列…') : null,
        state.open ? h('div', { key: 'levels' }, LEVELS.map(([level, label, hint]) => {
          const tickets = state.items.filter((item) => (item.level ?? 'blue') === level && (level === 'gray' ? item.status !== 'pending' : true));
          if (tickets.length === 0) return null;
          const collapsed = state.collapsed[level] === true;
          return h('div', { key: level, className: 'w2mDc_level' }, [
            h('div', { key: 'h', className: 'w2mGpw_row' }, [
              h('span', { key: 'dot', className: 'w2mGpw_dot', 'data-c': level }),
              h('span', { key: 'label', className: 'w2mGpw_title' }, label + ' · ' + tickets.length),
              h('span', { key: 'hint', className: 'w2mGpw_hint' }, hint),
              h('button', { key: 'fold', type: 'button', className: 'w2mGpw_small', onClick: () => toggle(level) }, collapsed ? '＋' : '－'),
            ]),
            collapsed ? null : h('div', { key: 'list', className: 'w2mDc_level' }, tickets.map(ticketRow)),
          ]);
        })) : null,
      ]);
    }

    /**
     * 队列日志（v3.1.0，移植自 @twinsearth/dsh-fang-queue-journal 0.1.5）。
     *
     * 草稿/队列的持久化镜像是宿主服务 `/api/w2m/composer/journal*`（见 src/queue-journal/index.mjs）；
     * 恢复必须由用户显式点击，本模块自身从不发送消息。Fang 的独立模块入口在这里展开成同一个客户端
     * bundle 内的工厂函数，React 与 h 复用外层。
     */
    function createQueueJournalModule() {

    const DEBOUNCE_MS = 250
    const FALLBACK_MS = 15_000

    /** 从 URL 里尝试取会话 id（兼容多种路由形态）。 */
    function sessionKeyFromUrl() {
      const hash = String(location.hash || '').replace(/^#/, '')
      const fromHash = /sessions?\/([^/?#]+)/.exec(hash)
      const fromPath = /sessions?\/([^/?#]+)/.exec(location.pathname)
      const q = new URLSearchParams(location.search).get('session') || new URLSearchParams(location.search).get('sessionId')
      return String(q || fromHash?.[1] || fromPath?.[1] || '').slice(0, 200)
    }

    /** 从 DOM 上找宿主暴露的会话 id（DSH 可能在容器上打 data 属性）。 */
    function sessionKeyFromDom() {
      const selectors = ['[data-session-id]', '[data-sessionid]', '[data-current-session]', '[data-active-session]']
      for (const selector of selectors) {
        const el = document.querySelector(selector)
        const _value = el?.getAttribute(selector.replace(/[[\]]/g, '').split('=')[0]) || ''
        const attr = selector.slice(1, -1)
        const v = el?.getAttribute(attr)
        if (v) return String(v).slice(0, 200)
      }
      return ''
    }

    /** 本页实例键：sessionStorage 里稳定存在，避免多会话挤在同一个 key。 */
    function instanceKey() {
      try {
        const cached = sessionStorage.getItem('fang-queue-journal-instance')
        if (cached) return cached
        const generated = 'page:' + Math.random().toString(36).slice(2, 10) + ':' + Date.now().toString(36)
        sessionStorage.setItem('fang-queue-journal-instance', generated)
        return generated
      } catch { return 'page:unknown' }
    }

    let activeKey = ''
    let activeSessionId = ''
    function resolveKey() {
      // 优先级：slot 给的 SessionId > DOM > URL > 本页实例键（绝不使用 "/"）
      if (activeSessionId) return activeSessionId
      const fromUrl = sessionKeyFromUrl()
      const fromDom = sessionKeyFromDom()
      const key = String(fromDom || fromUrl || instanceKey())
      activeKey = key === '/' || key === '' ? instanceKey() : key
      return activeKey
    }

    /** v3.2.6：只有真实会话键才写入队列日志；page:/空/“/”这类实例键会制造垃圾记录。 */
    function validSessionKey(key) {
      const value = String(key ?? '').trim()
      if (value === '' || value === '/') return false
      if (value.startsWith('page:')) return false
      return true
    }

    async function fangToken() { return 'w2m-same-origin' }

    async function journalRequest(method, entry, keyOverride) {
      const token = await fangToken()
      if (!token) return null
      const key = keyOverride || resolveKey()
      const res = await fetch(method === 'POST' ? '/api/w2m/composer/journal' : '/api/w2m/composer/journal?key=' + encodeURIComponent(key), {
        method,
        headers: { 'content-type': 'application/json', 'x-fang-auth': token },
        body: method === 'POST'
          ? JSON.stringify({ key, sessionId: activeSessionId || undefined, sessionKey: key, path: location.hash || location.pathname, ...entry })
          : undefined,
      })
      if (!res.ok) return null
      try { return await res.json() } catch { return null }
    }

    async function journalHistory(limit = 10) {
      const token = await fangToken()
      if (!token) return []
      try {
        const res = await fetch('/api/w2m/composer/journal/history?limit=' + Number(limit) + '&sessionKey=' + encodeURIComponent(resolveKey()), {
          headers: { accept: 'application/json', 'x-fang-auth': token },
        })
        if (!res.ok) return []
        const body = await res.json()
        return Array.isArray(body?.items) ? body.items : []
      } catch { return [] }
    }

    async function queueRestore(sessionId, items) {
      const token = await fangToken()
      if (!token) return { ok: false, error: 'auth-unavailable' }
      const res = await fetch('/api/w2m/composer/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fang-auth': token },
        body: JSON.stringify({
          sessionId,
          items: items.slice(0, 100).map((item) => ({ text: String(item?.text ?? '').slice(0, 4000) })),
        }),
      })
      let body = null
      try { body = await res.json() } catch { /* non-json */ }
      if (!res.ok) return { ok: false, error: body?.error || 'http-' + res.status, detail: body?.detail || '' }
      return { ok: true, queued: Number(body?.queued) || 0, failed: Number(body?.failed) || 0 }
    }

    function findComposer() {
      const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .filter((el) => {
          if (el.closest?.('[data-fang-entry]')) return false
          const r = el.getBoundingClientRect()
          return r.width > 80 && r.height > 16
        })
      return nodes.sort((a, b) => {
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        return (rb.width * rb.height) - (ra.width * ra.height)
      })[0] || null
    }

    function readComposer(el) {
      if (!el) return ''
      return el.tagName === 'TEXTAREA' ? String(el.value || '') : String(el.innerText || '')
    }

    function writeComposer(text) {
      const el = findComposer()
      if (!el) return false
      el.focus()
      if (el.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        if (setter) setter.call(el, text)
        else el.value = text
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        try {
          document.execCommand('selectAll', false, null)
          document.execCommand('insertText', false, text)
        } catch { /* fall back */ }
        if (!String(el.innerText || '').includes(text.slice(0, 20))) {
          el.textContent = text
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
        }
      }
      el.focus()
      return true
    }

    function setDraftViaApi(props, text) {
      try {
        if (props?.inputActions && typeof props.inputActions.setDraft === 'function') {
          props.inputActions.setDraft(String(text || ''))
          return true
        }
      } catch { /* fall back to the DOM */ }
      return writeComposer(String(text || ''))
    }

    const QUEUE_COUNT_RE = /(\d+)\s*(条排队消息|queued messages|件のキュー済みメッセージ|mensagens na fila|messages en file d'attente|nachrichten in der warteschlange|сообщения в очереди|mensajes en cola|mensagens na fila)/i
    const QUEUE_ACTION_LABELS = /^(插话发送|编辑排队消息|删除排队消息|保存排队消息|取消编辑|发送中…|排队消息图片|queued message image|edit queued message|remove queued message|save queued message|cancel edit|sending…|steer)$/i

    /** 从 QueueDock 行里去掉操作按钮，只留消息正文。 */
    function queueRowText(row) {
      try {
        const clone = row.cloneNode(true)
        for (const node of clone.querySelectorAll('button, [role="button"]')) node.remove()
        const lines = String(clone.innerText || clone.textContent || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !QUEUE_ACTION_LABELS.test(line))
        return lines.join(' ').trim()
      } catch { return '' }
    }

    /**
     * DSH QueueDock 的 CSS 是 hashed class（F07MqG_*），不能靠 class*=queue。
     * 以 header 的“N 条排队消息”文案定位，再通过 aria-controls 找到列表。
     */
    function scanQueueDock() {
      const out = []
      const seen = new Set()
      const pushText = (text) => {
        const value = String(text || '').trim()
        if (!value || value.length > 4000 || seen.has(value)) return
        seen.add(value)
        out.push({ text: value, at: Date.now() })
      }
      const docks = [...document.querySelectorAll('[data-queue-dock]')].filter((dock) => !dock.closest('[data-w2m-queue-ui]'))
      for (const dock of docks) {
        for (const row of dock.querySelectorAll('li')) {
          if (row.closest('[data-w2m-queue-ui]')) continue
          pushText(queueRowText(row))
        }
      }
      if (docks.length > 0) return out

      const headers = [...document.querySelectorAll('button[aria-controls], [role="button"][aria-controls]')]
        .filter((el) => QUEUE_COUNT_RE.test(String(el.textContent || '')))
      for (const header of headers) {
        const listId = header.getAttribute('aria-controls')
        const list = (listId ? document.getElementById(listId) : null) || header.parentElement?.querySelector('ul')
        if (!list) continue
        for (const row of list.querySelectorAll('li')) pushText(queueRowText(row))
      }
      return out
    }

    function scanQueue() {
      const found = scanQueueDock()
      if (found.length > 0) return found.slice(-100)
      // v3.2.6: 只信官方 [data-queue-dock]。以前这里会扫描任何 class/aria 里带 queue/pending 的元素，
      // 把本插件抽屉、对话正文、工具输出的 innerText 当成“排队消息”存进日志。没有官方 dock = 没有队列。
      return []
    }
    /** 回读校验：确认服务端存下来的队列文本与本地一致（并检测 "????" 乱码）。 */
    async function verifySaved(expectedQueue) {
      const body = await journalRequest('GET')
      const saved = Array.isArray(body?.entry?.queue) ? body.entry.queue.map((item) => String(item?.text || '')) : []
      const expected = expectedQueue.map((item) => String(item?.text || ''))
      const sameLength = saved.length === expected.length
      const sameText = sameLength && saved.every((text, index) => text === expected[index])
      const looksMojibake = saved.some((text) => /\?{3,}/.test(text) && !/\?{3,}/.test(expected[saved.indexOf(text)] || ''))
      return { ok: sameText && !looksMojibake, sameLength, sameText, looksMojibake, saved }
    }

    function JournalDock(props) {
      const sessionId = String(props?.sessionId || '')
      const [entry, setEntry] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const [status, setStatus] = React.useState('')
      const [showQueue, setShowQueue] = React.useState(false)
      const [showHistory, setShowHistory] = React.useState(false)

      React.useEffect(() => {
        activeSessionId = sessionId
        setEntry(null)
        setShowQueue(false)
        setShowHistory(false)
        let alive = true
        journalRequest('GET').then(async (body) => {
          if (alive) setEntry(body?.entry ?? null)
        }).catch(() => {})
        journalHistory(10).then((items) => { if (alive) setHistory(items) }).catch(() => {})
        return () => { alive = false }
      }, [sessionId])

      const queue = Array.isArray(entry?.queue) ? entry.queue : []
      const hasEntry = Boolean(entry && (entry.draft || queue.length))

      if (!hasEntry && history.length === 0) {
        return h('div', { 'data-fang-entry': 'queue-journal', className: 'w2mJqDockChip' }, [
          h('span', { key: 'label', className: 'w2mJqDockLabel' }, '队列日志'),
          h('button', { key: 'open', type: 'button', className: 'w2mJqDockOpen', onClick: () => w2mJqStore().openDrawer() }, '打开'),
        ]);
      }

      const restoreItems = async (items, draft) => {
        const draftText = String(draft || '')
        const draftOk = draftText ? setDraftViaApi(props, draftText) : true
        if (!draftOk) { setStatus('未找到输入框，请先打开会话'); return }
        if (items.length === 0) {
          await journalRequest('POST', { draft: '', queue: [] })
          setEntry(null)
          setStatus('草稿已放入官方输入框')
          return
        }
        if (!sessionId) { setStatus('草稿已恢复；队列需要先选中会话'); return }
        const restored = await queueRestore(sessionId, items)
        if (!restored.ok) {
          setStatus(restored.error === 'session-not-live'
            ? '草稿已恢复；会话未运行，队列保留待重试'
            : '草稿已恢复；队列恢复失败：' + restored.error)
          return
        }
        await journalRequest('POST', { draft: '', queue: [] })
        setEntry(null)
        setStatus(`已恢复 ${restored.queued} 条排队消息${restored.failed ? `（${restored.failed} 条失败）` : ''}`)
      }

      const rowText = (item) => {
        const text = String(item?.text || '').replace(/\s+/g, ' ').trim()
        return text.length > 140 ? text.slice(0, 137) + '…' : text
      }

      const snapshotLabel = (snap) => {
        const at = String(snap?.updatedAt || '')
        const count = Array.isArray(snap?.queue) ? snap.queue.length : 0
        return `${at ? at.replace('T', ' ').slice(0, 16) : '?'} · ${count} 条`
      }

      return h('div', {
        'data-fang-entry': 'queue-journal',
        style: {
          display: 'inline-flex', flexDirection: 'column', gap: 6, margin: '2px 0', maxWidth: '100%',
          padding: '3px 6px', border: '1px solid rgba(127,127,127,.3)', borderRadius: 9,
          fontSize: 12, background: 'rgba(127,127,127,.06)',
        },
      },
      h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        hasEntry ? h('button', {
          type: 'button',
          title: `恢复草稿${queue.length ? `，并把这 ${queue.length} 条排队消息放回官方输入队列` : ''}`,
          'aria-label': '恢复全部草稿与队列',
          onClick: () => { void restoreItems(queue, entry?.draft) },
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, queue.length ? `恢复全部 (${queue.length + (entry?.draft ? 1 : 0)})` : '恢复草稿') : null,
        hasEntry && queue.length > 0 ? h('button', {
          type: 'button', title: '展开保存的排队消息列表', 'aria-expanded': showQueue ? 'true' : 'false',
          onClick: () => setShowQueue((value) => !value),
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, `队列 ${queue.length}`) : null,
        history.length > 0 ? h('button', {
          type: 'button', title: '从历史快照中挑选一份恢复（主记录被覆盖时的兜底）',
          'aria-expanded': showHistory ? 'true' : 'false',
          onClick: () => setShowHistory((value) => !value),
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, `历史 ${history.length}`) : null,
        hasEntry ? h('button', {
          type: 'button', title: '清除本地保存的草稿与排队快照', 'aria-label': '清除草稿',
          onClick: async () => { await journalRequest('POST', { draft: '', queue: [] }); setEntry(null); setStatus('已清除记录') },
          style: { height: 26, padding: '0 8px', borderRadius: 7, cursor: 'pointer' },
        }, '清除') : null,
      ),
      showQueue && queue.length > 0 ? h('div', {
        role: 'list', style: { display: 'grid', gap: 4, maxHeight: 180, overflow: 'auto', padding: '2px 0' },
      }, ...queue.map((item, index) => h('div', {
        role: 'listitem', key: `${index}:${item?.at || ''}`, title: String(item?.text || ''),
        style: { padding: '3px 6px', border: '1px solid rgba(127,127,127,.22)', borderRadius: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      }, `${index + 1}. ${rowText(item)}`))) : null,
      showHistory && history.length > 0 ? h('div', {
        role: 'list', style: { display: 'grid', gap: 4, maxHeight: 200, overflow: 'auto', padding: '2px 0' },
      }, ...history.slice(0, 10).map((snap, index) => h('div', {
        role: 'listitem', key: `h${index}:${snap?.updatedAt || ''}`,
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', border: '1px solid rgba(127,127,127,.22)', borderRadius: 6 },
      }, h('span', { style: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, snapshotLabel(snap)),
      h('button', {
        type: 'button', title: '把这份快照里的队列放回官方队列',
        onClick: async () => { await restoreItems(Array.isArray(snap?.queue) ? snap.queue : [], '') },
        style: { height: 22, padding: '0 6px', borderRadius: 6, cursor: 'pointer' },
      }, '恢复')))) : null,
      h('span', {
        role: 'status', 'aria-live': 'polite',
        style: status ? { padding: '1px 2px', opacity: .8 } : { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
      }, status))
    }

    let saveTimer = null
    let lastSignature = ''
    let flushTimer = null

    function commitSave() {
      const text = readComposer(findComposer())
      const queue = scanQueue()
      const key = resolveKey()
      if (!validSessionKey(key)) return
      const title = clientSessionTitles()[key] ?? ''
      const signature = JSON.stringify({ key, text, title, queue: queue.map((item) => item.text) })
      if (signature === lastSignature) return
      lastSignature = signature
      void (async () => {
        const saved = await journalRequest('POST', { draft: text, queue, title })
        if (!saved) return
        const check = await verifySaved(queue)
        if (!check.ok) {
          // 回读不一致（或被截断/乱码）：重试一次，并把诊断留在控制台
          try { window.console?.warn?.('[fang-queue-journal] 回读校验未通过', check) } catch { /* ignore */ }
          const retried = await journalRequest('POST', { draft: text, queue })
          if (retried) await verifySaved(queue)
        }
      })()
    }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => { saveTimer = null; commitSave() }, DEBOUNCE_MS)
    }

    /** 关闭/切页前同步 flush：fetch keepalive 保证请求活着离开页面。 */
    function flushNow() {
      const text = readComposer(findComposer())
      const queue = scanQueue()
      const key = resolveKey()
      if (!validSessionKey(key)) return
      const title = clientSessionTitles()[key] ?? ''
      const signature = JSON.stringify({ key, text, title, queue: queue.map((item) => item.text) })
      if (signature === lastSignature) return
      lastSignature = signature
      void (async () => {
        const token = await fangToken()
        if (!token) return
        try {
          fetch('/api/w2m/composer/journal', {
            method: 'POST',
            keepalive: true,
            headers: { 'content-type': 'application/json', 'x-fang-auth': token },
            body: JSON.stringify({ key, sessionKey: key, sessionId: activeSessionId || undefined, draft: text, queue, title, path: location.hash || location.pathname }),
          })
        } catch { /* ignore */ }
      })()
    }

    return {
      inject: ['slots'],
      __w2mHelpers: { journalRequest, journalHistory, queueRestore, writeComposer, findComposer, resolveKey, JournalDock },
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'w2m-queue-journal',
          order: 90,
        }, HiddenComposerControl))

        // ① 草稿输入：捕获阶段监听，避免被宿主 stopPropagation 吞掉
        document.addEventListener('input', (event) => {
          const target = event.target
          if (!target || (target.tagName !== 'TEXTAREA' && target.getAttribute?.('contenteditable') !== 'true')) return
          scheduleSave()
        }, true)

        // ② 队列变化：只盯 QueueDock（body 全量只用 childList，避免 characterData 风暴）
        try {
          const queueObserver = new MutationObserver(() => scheduleSave())
          queueObserver.observe(document.body, { childList: true, subtree: true })
          // 有 [data-queue-dock] 时再额外盯 characterData（行文本可能原地更新）
          const docksObserver = new MutationObserver(() => scheduleSave())
          for (const dock of document.querySelectorAll('[data-queue-dock]')) {
            docksObserver.observe(dock, { childList: true, subtree: true, characterData: true })
          }
          queueObserver.__docksObserver = docksObserver
        } catch { /* DOM unavailable */ }

        // ③ 15s 兜底（覆盖“宿主重渲染后新 dock 未被观察到”的情况）
        flushTimer = setInterval(() => scheduleSave(), FALLBACK_MS)
        try { flushTimer?.unref?.() } catch { /* browser timer */ }

        // ④ 关闭/切页前 flush
        const onPageHide = () => flushNow()
        const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow() }
        window.addEventListener('pagehide', onPageHide)
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('beforeunload', onPageHide)
      },
    }
    }
    /** v1.9.4: the left sidebar entry: globe + GPW, between Plugins and Automation. */
    function GpwSidebarIcon() {
      return h('button', {
        type: 'button',
        className: 'w2mGpw_sideEntry',
        'data-w2m-gpw-sidebar': 'true',
        title: 'W2M 操作面板：智能分级&审批 / 消息与草稿 / 决策中心 / 操作入口',
        onClick: () => {
          try { window.dispatchEvent(new CustomEvent('w2m-gpw-full')); } catch { /* headless */ }
        },
      }, [
        h('span', { key: 'i', className: 'w2mGpw_sideIcon', 'aria-hidden': 'true' }, '🌐'),
        h('span', { key: 'l', className: 'w2mGpw_sideLabel' }, '操作面板'),
      ]);
    }

    /** v3.3.1：操作面板的「消息与草稿」页：队列日志的人类记录 + 恢复/打开动作。 */
    function OpsQueueSection({ t: _t }) {
      const store = w2mJqStore();
      const [snap, setSnap] = React.useState(() => store.snapshot());
      React.useEffect(() => {
        store.start();
        return store.subscribe(() => setSnap(store.snapshot()));
      }, [store]);
      const hasContent = (entry) => {
        const draft = String(entry?.draft ?? '').trim();
        const queue = Array.isArray(entry?.queue) ? entry.queue : [];
        return draft !== '' || queue.length > 0;
      };
      const entries = (store.state.entries ?? []).filter(hasContent).slice(0, 10);
      return h('div', { className: 'w2mOpsSection' }, [
        h('div', { key: 'head', className: 'w2mOpsRow' }, [
          h('span', { key: 'stat', className: 'w2mOpsStat' }, `${snap.total} 条人类记录 · ${snap.queued} 条排队消息`),
          h('button', { key: 'open', type: 'button', className: 'w2mOpsBtn w2mOpsBtnPrimary', onClick: () => store.openDrawer() }, '打开队列日志窗口'),
          h('button', { key: 'clear', type: 'button', className: 'w2mOpsBtn', onClick: () => void store.clearAll() }, '清空全部'),
        ]),
        entries.length === 0
          ? h('div', { key: 'empty', className: 'w2mOpsEmpty' }, '当前没有草稿或排队消息。')
          : entries.map((entry) => h('div', { key: entry.key, className: 'w2mOpsCard' }, [
            h('div', { key: 'title', className: 'w2mOpsCardTitle' }, String(entry.title || entry.sessionKey || '未知会话')),
            h('div', { key: 'meta', className: 'w2mOpsMeta' }, [
              String(entry.draft ?? '').trim() !== '' ? '草稿：' + String(entry.draft).slice(0, 60) : null,
              Array.isArray(entry.queue) && entry.queue.length > 0 ? '　排队 ' + entry.queue.length + ' 条' : null,
            ].filter(Boolean).join('')),
            h('div', { key: 'actions', className: 'w2mOpsRow' }, [
              String(entry.draft ?? '').trim() !== '' ? h('button', { key: 'd', type: 'button', className: 'w2mOpsBtn', onClick: () => void store.restoreDraft(entry) }, '恢复草稿') : null,
              Array.isArray(entry.queue) && entry.queue.length > 0 ? h('button', { key: 'q', type: 'button', className: 'w2mOpsBtn', onClick: () => void store.restoreQueue(entry) }, '恢复队列') : null,
              h('button', { key: 'x', type: 'button', className: 'w2mOpsBtn', onClick: () => void store.clear(entry) }, '清除'),
            ]),
          ])),
      ]);
    }

    /** v3.3.1：操作面板的「决策中心」页。 */
    function OpsDecisionSection({ t: _t }) {
      const store = w2mDcStore();
      const [snap, setSnap] = React.useState(() => store.snapshot());
      React.useEffect(() => {
        store.start();
        return store.subscribe(() => setSnap(store.snapshot()));
      }, [store]);
      const pending = (store.state.items ?? []).filter((item) => item?.status === 'pending' || item?.status === undefined).slice(0, 8);
      return h('div', { className: 'w2mOpsSection' }, [
        h('div', { key: 'head', className: 'w2mOpsRow' }, [
          h('span', { key: 'stat', className: 'w2mOpsStat' }, `待处理 ${snap.pending ?? 0} · 红 ${snap.red ?? 0} · 黄 ${snap.yellow ?? 0} · 蓝 ${snap.blue ?? 0} · 绿 ${snap.green ?? 0}`),
          h('button', { key: 'open', type: 'button', className: 'w2mOpsBtn w2mOpsBtnPrimary', onClick: () => store.openDrawer() }, '打开决策中心'),
          h('button', { key: 'refresh', type: 'button', className: 'w2mOpsBtn', onClick: () => void store.refresh() }, '刷新'),
        ]),
        pending.length === 0
          ? h('div', { key: 'empty', className: 'w2mOpsEmpty' }, '收件箱没有待处理事项。')
          : pending.map((item) => h('div', { key: item.id, className: 'w2mOpsCard' }, [
            h('div', { key: 'title', className: 'w2mOpsCardTitle' }, [
              h('span', { key: 'dot', className: 'w2mGpw_dot', 'data-c': String(item.level ?? 'yellow') }),
              ' ' + String(item.title ?? item.kind ?? '决策'),
            ]),
            h('div', { key: 'meta', className: 'w2mOpsMeta' }, String(item.summary ?? item.description ?? '').slice(0, 120)),
          ])),
      ]);
    }

    /** v3.3.1：操作面板的「智能分级&审批」页：AI Token 设置 + GPW 待审批队列。 */
    function OpsApprovalSection({ t: _t, sessionId }) {
      const [state, setState] = React.useState(null);
      const call = async (url, init) => {
        try {
          const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...init });
          let body = null;
          try { body = await response.json(); } catch { body = null; }
          if (response.ok !== true || body?.ok === false) return { ok: false, error: body?.error ?? ('HTTP ' + response.status), body };
          return { ok: true, body };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };
      const load = React.useCallback(async () => {
        const result = await call('/api/w2m/gpw/state');
        if (result.ok === true) setState(result.body);
      }, []);
      React.useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(); }, 3000);
        return () => clearInterval(timer);
      }, [load]);
      const pending = (Array.isArray(state?.pending) ? state.pending : []).filter((item) => item?.session_id === null || item?.session_id === undefined || item?.session_id === sessionId);
      return h('div', { className: 'w2mOpsSection' }, [
        h('div', { key: 'head', className: 'w2mOpsRow' }, [
          h('span', { key: 'stat', className: 'w2mOpsStat' }, `GPW 待审批 ${pending.length} 条`),
          h('button', { key: 'panel', type: 'button', className: 'w2mOpsBtn', onClick: () => { try { window.dispatchEvent(new CustomEvent('w2m-gpw-open')); } catch { /* headless */ } } }, '打开 GPW 浮窗'),
          h('button', { key: 'refresh', type: 'button', className: 'w2mOpsBtn', onClick: () => void load() }, '刷新'),
        ]),
        h(GpwAiSettings, { key: 'ai', call, aiState: state?.ai ?? null, onChanged: load }),
        pending.length === 0
          ? h('div', { key: 'empty', className: 'w2mOpsEmpty' }, '没有待审批的 GPW 操作。')
          : pending.map((item) => h('div', { key: item.id, className: 'w2mOpsCard' }, [
            h('div', { key: 'title', className: 'w2mOpsCardTitle' }, [
              h('span', { key: 'dot', className: 'w2mGpw_dot', 'data-c': item.level ?? item.color ?? 'yellow' }),
              ' ' + String(item.tool ?? 'tool') + ' · ' + String(item.reason ?? ''),
            ]),
            h('div', { key: 'meta', className: 'w2mOpsMeta' }, gpwCountdownText(item)),
            item.ai?.reason ? h('div', { key: 'ai', className: 'w2mGpwAiReason' }, 'AI：' + (item.ai.action === 'deny' ? '建议拒绝' : '建议允许') + ' · ' + String(item.ai.reason ?? '')) : null,
            h('div', { key: 'actions', className: 'w2mOpsRow' }, [
              h('button', { key: 'a', type: 'button', className: 'w2mOpsBtn w2mOpsBtnPrimary', onClick: async () => { await call('/api/w2m/gpw/decide', { method: 'POST', body: JSON.stringify({ id: item.id, decision: 'allow' }) }); await load(); } }, '允许'),
              h('button', { key: 'd', type: 'button', className: 'w2mOpsBtn', onClick: async () => { await call('/api/w2m/gpw/decide', { method: 'POST', body: JSON.stringify({ id: item.id, decision: 'deny' }) }); await load(); } }, '拒绝'),
            ]),
          ])),
      ]);
    }

    /** v3.3.1：操作面板的「操作入口」页：目标机器、执行能力与常用入口。 */
    function OpsActionsSection({ t, sessionId }) {
      return h('div', { className: 'w2mOpsSection' }, [
        h('div', { key: 'tips', className: 'w2mOpsEmpty' }, '这些入口以前占满聊天框，现在集中在这里；右下角浮标与底部状态栏保持不变。'),
        h('div', { key: 'target', className: 'w2mOpsCard' }, [
          h('div', { key: 'title', className: 'w2mOpsCardTitle' }, '目标机器'),
          h(TargetSelect, { t, sessionId }),
        ]),
        h('div', { key: 'cap', className: 'w2mOpsCard' }, [
          h('div', { key: 'title', className: 'w2mOpsCardTitle' }, '执行能力'),
          h(ExecCapability, { t }),
        ]),
        // v3.5.0: the drift card reads the same `/api/w2m/target` snapshot the target control above
        // fetches (the host caches that read), so "which machine runs this" and "what version each
        // machine is" sit side by side instead of in two panels that could disagree.
        h(FleetVersionsCard, { key: 'versions', t, sessionId }),
        h('div', { key: 'links', className: 'w2mOpsRow' }, [
          h('button', { key: 'gpw', type: 'button', className: 'w2mOpsBtn', onClick: () => { try { window.dispatchEvent(new CustomEvent('w2m-gpw-open')); } catch { /* headless */ } } }, 'GPW 浮窗'),
          h('button', { key: 'queue', type: 'button', className: 'w2mOpsBtn', onClick: () => w2mJqStore().openDrawer() }, '队列日志'),
          h('button', { key: 'decision', type: 'button', className: 'w2mOpsBtn', onClick: () => w2mDcStore().openDrawer() }, '决策中心'),
        ]),
      ]);
    }

    // -------------------------------------------------------------------------------------------
    // v3.5.0: 「编队版本」 (fleet version drift) card
    // -------------------------------------------------------------------------------------------
    //
    // The data half already ships on the host: `GET /api/w2m/target` carries a `versions` block
    // built by `summarizeVersionDashboard` in `src/plugin/version-gate.mjs`
    // (`{supported_min, distribution, outdated, unknown, all_current}`), and `w2m_devices` returns
    // the same shape. This is the missing UI half, and only that: it reads the block, renders it,
    // and copies an upgrade command. It never dispatches, never writes a selection, and asks the
    // relay for nothing the target control above it did not already ask for (the host's own fleet
    // cache deduplicates the read).
    //
    // Absent or unreadable data is a *state*, not an exception: an older host predates the block,
    // and the card then says "unknown" instead of rendering an empty fleet as "all current".

    /** The package the upgrade command names; taken from package.json, never re-derived. */
    const PLUGIN_PACKAGE_NAME = '@twinsearth/w2m-dsh-plugin';

    /**
     * Normalize the host's `versions` block into what the card renders.
     *
     * Deliberately defensive: the payload may come from an older host (no block), from a host behind
     * a proxy that dropped a field, or from a relay roster with machines that cannot be named.
     * Anything unusable becomes `null` (the card's unavailable state) rather than an exception, and
     * each list keeps only entries that can actually be shown.
     *
     * @param {unknown} snapshot The `GET /api/w2m/target` snapshot.
     * @returns {{supported_min: string, distribution: Array<{version: string, count: number}>,
     *   outdated: Array<{machine_id: string, version: string}>, unknown: Array<{machine_id: string}>,
     *   all_current: boolean}|null}
     */
    function fleetVersionBlock(snapshot) {
      const block = snapshot !== null && typeof snapshot === 'object' ? snapshot.versions : undefined;
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return null;
      const supportedMin = typeof block.supported_min === 'string' && block.supported_min.trim() !== ''
        ? block.supported_min.trim()
        : null;
      // Without the minimum there is nothing to compare a version against, and a card that guessed
      // one would be the drift it exists to surface. Treat the whole block as unavailable instead.
      if (supportedMin === null) return null;
      const distribution = [];
      if (block.distribution !== null && typeof block.distribution === 'object' && !Array.isArray(block.distribution)) {
        for (const [version, count] of Object.entries(block.distribution)) {
          const parsed = Number(count);
          if (version === '' || !Number.isFinite(parsed) || parsed < 0) continue;
          distribution.push({ version, count: Math.floor(parsed) });
        }
      }
      const namedMachines = (list) => (Array.isArray(list) ? list : []).filter((machine) => machine !== null
        && typeof machine === 'object'
        && typeof machine.machine_id === 'string'
        && machine.machine_id !== '');
      const outdated = namedMachines(block.outdated).map((machine) => ({
        machine_id: machine.machine_id,
        version: typeof machine.version === 'string' && machine.version !== '' ? machine.version : '—',
      }));
      const unknown = namedMachines(block.unknown).map((machine) => ({ machine_id: machine.machine_id }));
      return {
        supported_min: supportedMin,
        distribution,
        outdated,
        unknown,
        // The host's own verdict, kept verbatim: `false` after a failed roster read is not evidence
        // of drift, but the card renders that state as "unknown", never as "everything is fine".
        all_current: block.all_current === true,
      };
    }

    /**
     * The guidance string behind 一键复制升级指引.
     *
     * Built from the block the card renders, in the operator's own language where the dictionary has
     * a word for it, so the copied text and the visible card cannot disagree. The npm command is the
     * one line that matters; the lists say which machines need it.
     *
     * @param {object|null} versions A {@link fleetVersionBlock} result, or null.
     * @param {(key: string, values?: object) => string} [t]
     * @returns {string} The text to copy, or '' when there is nothing honest to copy.
     */
    function buildVersionGuidance(versions, t) {
      if (versions === null || typeof versions !== 'object') return '';
      const translate = typeof t === 'function' ? t : makeTranslator(() => undefined);
      const min = typeof versions.supported_min === 'string' ? versions.supported_min : '';
      if (min === '') return '';
      const lines = [
        translate('panel.fleet.version.guidanceTitle', { version: min }),
        `npm i -g ${PLUGIN_PACKAGE_NAME}@${min}`,
      ];
      const outdated = Array.isArray(versions.outdated) ? versions.outdated : [];
      const unknown = Array.isArray(versions.unknown) ? versions.unknown : [];
      if (outdated.length > 0) {
        lines.push(`${translate('panel.fleet.version.outdated')}:`);
        for (const machine of outdated) lines.push(`- ${machine.machine_id} @ ${machine.version}`);
      }
      if (unknown.length > 0) {
        lines.push(`${translate('panel.fleet.version.unknown')}:`);
        for (const machine of unknown) lines.push(`- ${machine.machine_id}`);
      }
      if (outdated.length === 0 && unknown.length === 0) lines.push(translate('panel.fleet.version.noOutdated'));
      return lines.join('\n');
    }

    /**
     * Copy one string through the browser clipboard, with the legacy escape hatch.
     *
     * `navigator.clipboard.writeText` is the modern path; the DSH desktop shell can deny it, so
     * `document.execCommand('copy')` runs as the fallback. Headless (a unit test, a caller with no
     * DOM) has neither, and that is a `false` return, never an exception: the button is a
     * convenience, and a convenience must not be able to break the panel it lives in.
     *
     * @param {unknown} value
     * @returns {Promise<boolean>} Whether the platform accepted the copy.
     */
    async function copyFleetGuidance(value) {
      const text = String(value ?? '');
      if (text === '') return false;
      try {
        if (typeof navigator !== 'undefined' && navigator !== null
          && navigator.clipboard !== undefined && navigator.clipboard !== null
          && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch { /* denied/headless: fall through to the legacy path */ }
      try {
        if (typeof document === 'undefined' || document === null) return false;
        const body = document.body;
        if (body === undefined || body === null || typeof body.appendChild !== 'function'
          || typeof document.createElement !== 'function') return false;
        const area = document.createElement('textarea');
        if (area === null || typeof area !== 'object') return false;
        area.value = text;
        if (area.style !== undefined && area.style !== null) {
          area.style.position = 'fixed';
          area.style.opacity = '0';
        }
        body.appendChild(area);
        try {
          if (typeof area.select === 'function') area.select();
          return typeof document.execCommand === 'function' && document.execCommand('copy') === true;
        } finally {
          if (typeof body.removeChild === 'function') body.removeChild(area);
        }
      } catch {
        return false;
      }
    }

    /**
     * The 「编队版本」 card: supported minimum, stock distribution, and the machines behind it.
     *
     * No polling: the card reads once when it mounts and again when the operator presses 刷新. The
     * host already caches the relay read, and a panel that polled would spend requests on a number
     * that changes when a machine updates, which is not something a page can watch in real time
     * anyway. A session-less mount (the sidebar page) reads the route's `__global__` bucket: the
     * version block is fleet-wide, not session-scoped.
     *
     * @param {{t?: Function, sessionId?: string}} properties
     */
    function FleetVersionsCard({ t, sessionId }) {
      const [status, setStatus] = React.useState('loading');
      const [versions, setVersions] = React.useState(null);
      const [reloadSeq, setReloadSeq] = React.useState(0);
      const [copied, setCopied] = React.useState(false);
      const sessionKey = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '__global__';
      React.useEffect(() => {
        // AbortController is a browser global; a headless caller (unit test) may not provide it,
        // and then the read simply runs without cancellation rather than failing to mount.
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const signal = controller === null ? undefined : controller.signal;
        let live = true;
        readState(sessionKey, signal).then((result) => {
          if (!live || controller?.signal.aborted === true) return;
          if (result.ok === true) {
            // A roster the host could not read must not look like a drift-free fleet: `buildUiState`
            // still sends the (empty) versions block in that case, with `all_current:false`. The
            // snapshot's own `fleet.ok` is checked here, so a failed read renders as "unknown"
            // rather than as "no outdated machines".
            const block = result.state?.fleet?.ok === false ? null : fleetVersionBlock(result.state);
            setVersions(block);
            setStatus(block === null ? 'unavailable' : 'ready');
          } else {
            setVersions(null);
            setStatus('unavailable');
          }
          setCopied(false);
        });
        return () => {
          live = false;
          if (controller !== null) controller.abort();
        };
      }, [sessionKey, reloadSeq]);
      const translate = typeof t === 'function' ? t : makeTranslator(() => undefined);
      const card = status === 'ready' ? versions : null;
      const rows = card === null ? [] : card.distribution.map((row) => h('span', {
        key: row.version,
        className: 'w2mVerRow',
        'data-w2m-version-row': row.version,
      }, `${row.version} × ${row.count}`));
      const body = card === null
        ? [
            // A dash, not a spinner: the read is host-local and normally settles in one frame, so
            // an animated placeholder would be noise. Any non-loading state here is the neutral
            // "unknown", which is also what an older host's missing block renders as.
            h('div', {
              key: 'state',
              className: 'w2mVerNote',
              'data-w2m-version-state': status,
            }, status === 'loading' ? '…' : translate('panel.fleet.version.unavailable')),
          ]
        : [
            h('div', { key: 'min', className: 'w2mVerMeta' },
              `${translate('panel.fleet.version.supportedMin')}: ${card.supported_min}`),
            h('div', { key: 'distribution', className: 'w2mVerGroup' }, [
              h('div', { key: 'label', className: 'w2mVerMeta' }, translate('panel.fleet.version.distribution')),
              rows.length === 0
                ? h('div', { key: 'empty', className: 'w2mVerNote' }, '—')
                : h('div', { key: 'rows', className: 'w2mVerRows' }, rows),
            ]),
            card.all_current === true
              ? null
              : h('div', { key: 'outdated', className: 'w2mVerGroup' }, [
                  h('div', { key: 'label', className: 'w2mVerMeta' }, translate('panel.fleet.version.outdated')),
                  card.outdated.length === 0
                    ? h('div', { key: 'empty', className: 'w2mVerNote', 'data-w2m-version-no-outdated': 'true' }, translate('panel.fleet.version.noOutdated'))
                    : h('div', { key: 'list', className: 'w2mVerList' }, card.outdated.map((machine) => h('div', {
                        key: machine.machine_id,
                        className: 'w2mVerItem',
                        'data-tone': 'warn',
                        'data-w2m-version-outdated': 'true',
                      }, `${machine.machine_id} @ ${machine.version}`))),
                ]),
            card.unknown.length === 0
              ? null
              : h('div', { key: 'unknown', className: 'w2mVerGroup' }, [
                  h('div', { key: 'label', className: 'w2mVerMeta' }, translate('panel.fleet.version.unknown')),
                  h('div', { key: 'list', className: 'w2mVerList' }, card.unknown.map((machine) => h('div', {
                    key: machine.machine_id,
                    className: 'w2mVerItem',
                    'data-tone': 'unknown',
                    'data-w2m-version-unknown': 'true',
                  }, machine.machine_id))),
                ]),
            h('div', { key: 'actions', className: 'w2mOpsRow' }, [
              h('button', {
                key: 'copy',
                type: 'button',
                className: 'w2mOpsBtn w2mOpsBtnPrimary',
                'data-w2m-version-copy': 'true',
                'data-copied': copied ? 'true' : 'false',
                onClick: () => {
                  copyFleetGuidance(buildVersionGuidance(card, translate)).then((ok) => {
                    // A failed copy (no clipboard, headless) leaves the label alone: claiming
                    // "copied" when nothing reached the clipboard is worse than saying nothing.
                    if (ok === true) setCopied(true);
                  });
                },
              }, copied ? translate('panel.fleet.version.copied') : translate('panel.fleet.version.copyGuidance')),
            ]),
          ];
      return h('div', {
        className: 'w2mOpsCard w2mVerCard',
        'data-w2m-fleet-version-card': 'true',
        'data-w2m-version-state': status,
      }, [
        h('div', { key: 'head', className: 'w2mVerHead' }, [
          h('span', { key: 'title', className: 'w2mVerTitle' }, translate('panel.fleet.version.title')),
          card !== null && card.all_current === true
            ? h('span', {
                key: 'current',
                className: 'w2mVerBadge',
                'data-tone': 'ok',
                'data-w2m-version-all-current': 'true',
              }, translate('panel.fleet.version.allCurrent'))
            : null,
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'w2mOpsBtn',
            'data-w2m-version-refresh': 'true',
            disabled: status === 'loading',
            onClick: () => setReloadSeq((seq) => seq + 1),
          }, translate('panel.fleet.version.refresh')),
        ]),
        ...body,
      ]);
    }

    /** v3.3.1：左侧边栏按钮打开的操作面板（分级审批 / 消息草稿 / 决策中心 / 操作入口）。 */
    function W2mOpsPanel({ t, sessionId }) {
      const [tab, setTab] = React.useState('approvals');
      const tabs = [
        ['approvals', '智能分级&审批'],
        ['queue', '消息与草稿'],
        ['decisions', '决策中心'],
        ['actions', '操作入口'],
      ];
      const body = tab === 'queue' ? h(OpsQueueSection, { t })
        : tab === 'decisions' ? h(OpsDecisionSection, { t })
          : tab === 'actions' ? h(OpsActionsSection, { t, sessionId })
            : h(OpsApprovalSection, { t, sessionId });
      return h('div', { className: 'w2mOpsPanel' }, [
        h('div', { key: 'nav', className: 'w2mOpsNav' }, tabs.map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          className: 'w2mOpsTab',
          'data-active': tab === id ? 'true' : 'false',
          onClick: () => setTab(id),
        }, label))),
        h('div', { key: 'body', className: 'w2mOpsBody' }, body),
      ]);
    }

    /** v1.9.4: the full workspace page opened from the sidebar entry. */
    function GpwFullPage({ t, sessionId, onClose }) {
      return h('div', { className: 'w2mGpw_fullPage', role: 'dialog', 'aria-label': t('gpwTitle') }, [
        h('div', { key: 'head', className: 'w2mGpw_fullHead' }, [
          h('span', { key: 't', className: 'w2mGpw_fullTitle' }, '🌐 ' + t('gpwTitle')),
          h('button', { key: 'x', type: 'button', className: 'w2mGpw_close', onClick: onClose }, '×'),
        ]),
        h('div', { key: 'body', className: 'w2mGpw_fullBody' }, h(W2mOpsPanel, { t, sessionId, onClose })),
      ]);
    }

    /** v1.9.6: the GPW page rendered in the main workspace (slot main, key w2m-gpw). */
    function GpwMainPage({ t, sessionId }) {
      return h('div', { className: 'w2mGpw_mainWrap' }, [
        h(W2mOpsPanel, { key: 'ops', t, sessionId }),
        h('details', { key: 'admin', className: 'w2mOpsAdmin' }, [
          h('summary', { key: 's', className: 'w2mOpsAdminSummary' }, 'GPW 管理页（白名单/黑名单/最近拦截）'),
          h(GpwAdminPage, { key: 'page', t }),
        ]),
      ]);
    }

    /**
     * v1.9.7: the GPW management page, drawn as an admin console (title, filter bar, action
     * buttons, table with row actions) rather than the floating popup card. The popup stays for
     * the floating launcher; this page is what the sidebar row and the Settings tab open.
     */
    function GpwAdminPage({ sessionId }) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [tab, setTab] = React.useState('all');
      const [query, setQuery] = React.useState('');
      const [manual, setManual] = React.useState('');
      const [tokenInput, setTokenInput] = React.useState('');
      const [tokenState, setTokenState] = React.useState(null);
      const call = async (url, init) => {
        try {
          const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...init });
          let body = null;
          try { body = await response.json(); } catch { body = null; }
          if (response.status === 404) return { ok: false, routeMissing: true, error: 'GPW route missing' };
          if (response.ok !== true || body?.ok === false) return { ok: false, error: body?.error ?? ('HTTP ' + response.status) };
          return { ok: true, body };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };
      const load = React.useCallback(async () => {
        const result = await call('/api/w2m/gpw/state', { method: 'GET' });
        if (result.ok) { setState(result.body); setError(null); } else setError(result.routeMissing ? 'GPW 未启用（在插件页开启 dsh-gpw）' : (result.error ?? 'error'));
      }, []);
      React.useEffect(() => {
        load();
        const timer = setInterval(load, 3000);
        return () => clearInterval(timer);
      }, [load]);
      const loadToken = React.useCallback(async () => {
        const result = await call('/api/w2m/operator-token', { method: 'GET' });
        if (result.ok) setTokenState(result.body);
      }, []);
      React.useEffect(() => { loadToken(); }, [loadToken]);
      const [sinkKind, setSinkKind] = React.useState('dir');
      const [sinkRoot, setSinkRoot] = React.useState('');
      const [sinkState, setSinkState] = React.useState(null);
      const loadSink = React.useCallback(async () => {
        const result = await call('/api/w2m/dataplane-sink', { method: 'GET' });
        if (result.ok) setSinkState(result.body);
        else if (result.routeMissing !== true) setError(result.error ?? 'sink status failed');
      }, []);
      React.useEffect(() => { loadSink(); }, [loadSink]);
      const [projectRoomId, setProjectRoomId] = React.useState('');
      const [projectEvents, setProjectEvents] = React.useState([]);
      const [projectStreaming, setProjectStreaming] = React.useState(false);
      const projectAbortRef = React.useRef(null);
      const stopProjectStream = () => { projectAbortRef.current?.abort(); projectAbortRef.current = null; setProjectStreaming(false); };
      React.useEffect(() => () => { projectAbortRef.current?.abort(); }, []);
      const startProjectStream = async () => {
        const projectId = projectRoomId.trim();
        if (projectId === '') return;
        stopProjectStream();
        const controller = new AbortController();
        projectAbortRef.current = controller;
        setProjectEvents([]);
        setProjectStreaming(true);
        try {
          const response = await fetch('/api/w2m/project-stream?project_id=' + encodeURIComponent(projectId) + '&since_seq=0', { credentials: 'same-origin', signal: controller.signal });
          if (response.ok !== true || response.body === null) { setError('项目流不可用（HTTP ' + response.status + '）'); return; }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let split = buffer.indexOf('\n\n');
            while (split >= 0) {
              const block = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
              if (dataLine !== undefined) {
                try { setProjectEvents((prev) => [...prev.slice(-99), JSON.parse(dataLine.slice(6))]); } catch { /* ignore malformed frame */ }
              }
              split = buffer.indexOf('\n\n');
            }
          }
        } catch (error) {
          if (error?.name !== 'AbortError') setError('项目流中断');
        } finally {
          if (projectAbortRef.current === controller) { projectAbortRef.current = null; setProjectStreaming(false); }
        }
      };
      const saveSink = async () => {
        if (sinkRoot.trim() === '') return;
        setBusy(true);
        try {
          const payload = sinkKind === 'ssh'
            ? { kind: 'ssh', host: sinkRoot.split(':')[0].trim(), user: (sinkRoot.split(':')[1] ?? '').trim(), dir: (sinkRoot.split(':')[2] ?? '').trim() }
            : { kind: sinkKind, root: sinkRoot.trim() };
          const result = await call('/api/w2m/dataplane-sink', { method: 'POST', body: JSON.stringify(payload) });
          if (result.ok) { setSinkRoot(''); await loadSink(); } else setError(result.error ?? 'sink save failed');
        } finally { setBusy(false); }
      };
      const saveToken = async () => {
        if (tokenInput.trim() === '') return;
        setBusy(true);
        try {
          const result = await call('/api/w2m/operator-token', { method: 'POST', body: JSON.stringify({ token: tokenInput }) });
          if (result.ok) { setTokenInput(''); await loadToken(); } else setError(result.error ?? 'token save failed');
        } finally { setBusy(false); }
      };
      const add = async (list, value) => {
        if (value.trim() === '') return;
        setBusy(true);
        try {
          const result = await call('/api/w2m/gpw/folders', { method: 'POST', body: JSON.stringify({ action: 'add', list, path: value.trim() }) });
          if (result.ok) { setManual(''); await load(); } else setError(result.error ?? 'error');
        } finally { setBusy(false); }
      };
      const remove = async (list, value) => {
        setBusy(true);
        try { await call('/api/w2m/gpw/folders', { method: 'POST', body: JSON.stringify({ action: 'remove', list, path: value }) }); await load(); } finally { setBusy(false); }
      };
      const decide = async (id, decision) => {
        setBusy(true);
        try { await call('/api/w2m/gpw/decide', { method: 'POST', body: JSON.stringify({ id, decision }) }); await load(); } finally { setBusy(false); }
      };
      const folders = state?.folders ?? { whitelist: [], blacklist: [] };
      const pendingAll = Array.isArray(state?.pending) ? state.pending : [];
      const pending = pendingAll.filter((item) => item?.session_id === null || item?.session_id === undefined || item?.session_id === sessionId);
      const rows = [
        ...(Array.isArray(folders.whitelist) ? folders.whitelist : []).map((path) => ({ path, list: 'whitelist' })),
        ...(Array.isArray(folders.blacklist) ? folders.blacklist : []).map((path) => ({ path, list: 'blacklist' })),
      ].filter((row) => (tab === 'all' || tab === row.list) && (query === '' || row.path.toLowerCase().includes(query.toLowerCase())));
      const tabBtn = (key, label) => h('button', {
        key,
        type: 'button',
        className: 'w2mGpw_adminTab' + (tab === key ? ' is-active' : ''),
        onClick: () => setTab(key),
      }, label);
      return h('div', { className: 'w2mGpw_admin' }, [
        h('div', { key: 'head', className: 'w2mGpw_adminHead' }, [
          h('h1', { key: 'h', className: 'w2mGpw_adminTitle' }, 'GPW 文件策略'),
          h('div', { key: 'sub', className: 'w2mGpw_adminSub' }, '白名单放行、黑名单拒绝，名单外的调用进入待审批队列'),
        ]),
        error === null ? null : h('div', { key: 'err', className: 'w2mGpw_adminNote' }, error),
        state?.tampered === true ? h('div', { key: 'tampered', className: 'w2mGpw_adminNote' }, '名单被篡改，已锁定：' + (state?.tampered_reason ?? '')) : null,
        h('div', { key: 'token', className: 'w2mGpw_adminCard' }, [
          h('div', { key: 'row', className: 'w2mGpw_adminToolbar' }, [
            h('input', { key: 'i', className: 'w2mGpw_adminInput', type: 'password', value: tokenInput, placeholder: 'relay operator token（保存后只显示指纹）', onChange: (event) => setTokenInput(event.target.value) }),
            h('button', { key: 's', type: 'button', className: 'w2mGpw_adminBtn w2mGpw_tokenSave', disabled: busy, onClick: saveToken }, '保存 token'),
          ]),
          h('div', { key: 'st', className: 'w2mGpw_adminSub' }, tokenState?.configured === true ? ('已配置 · ' + String(tokenState.source ?? '') + ' · ' + String(tokenState.fingerprint ?? '').slice(0, 12)) : '未配置 operator token（保存后写入 0600 文件，只显示指纹）'),
        ]),
        h('div', { key: 'sink', className: 'w2mGpw_adminCard' }, [
          h('div', { key: 'row', className: 'w2mGpw_adminToolbar' }, [
            h('select', { key: 'k', className: 'w2mGpw_adminInput', value: sinkKind, onChange: (event) => setSinkKind(event.target.value) }, [
              h('option', { key: 'd', value: 'dir' }, '本地目录'),
              h('option', { key: 'g', value: 'lan-git' }, 'git 仓库'),
              h('option', { key: 's', value: 'ssh' }, 'ssh'),
            ]),
            h('input', { key: 'p', className: 'w2mGpw_adminInput', value: sinkRoot, placeholder: sinkKind === 'ssh' ? 'host:user:绝对目录' : (sinkKind === 'lan-git' ? 'git 仓库绝对路径' : '产物目录绝对路径'), onChange: (event) => setSinkRoot(event.target.value) }),
            h('button', { key: 'a', type: 'button', className: 'w2mGpw_adminBtn', disabled: busy, onClick: saveSink }, '授权并保存'),
          ]),
          h('div', { key: 'st', className: 'w2mGpw_adminSub' }, sinkState?.configured === true
            ? ('已授权 · ' + String(sinkState.kind ?? '') + ' · ' + String(sinkState.root ?? sinkState.host ?? '') + ' · 凭据不写入配置')
            : '未配置数据面 sink：产物只保留本地并标记 ARTIFACT_NOT_DELIVERED（工具参数不能完成授权）'),
        ]),
        h('div', { key: 'projectroom', className: 'w2mGpw_adminCard' }, [
          h('div', { key: 'row', className: 'w2mGpw_adminToolbar' }, [
            h('input', { key: 'p', className: 'w2mGpw_adminInput', value: projectRoomId, placeholder: '项目 id（只读订阅项目事件）', onChange: (event) => setProjectRoomId(event.target.value) }),
            h('button', { key: 'start', type: 'button', className: 'w2mGpw_adminBtn', disabled: projectStreaming, onClick: startProjectStream }, '订阅'),
            h('button', { key: 'stop', type: 'button', className: 'w2mGpw_adminBtn', disabled: !projectStreaming, onClick: stopProjectStream }, '停止'),
          ]),
          h('div', { key: 'ev', className: 'w2mGpw_adminSub' }, projectEvents.length === 0
            ? (projectStreaming ? '已连接，等待事件…' : '未订阅（只读；截断时 relay 会先发 PROJECT_REPLAY_TRUNCATED notice）')
            : projectEvents.slice(-8).map((event) => String(event.seq ?? '?') + ' · ' + String(event.type ?? event.code ?? 'event')).join('  |  ')),
        ]),
        h('div', { key: 'toolbar', className: 'w2mGpw_adminCard' }, [
          h('div', { key: 'row', className: 'w2mGpw_adminToolbar' }, [
            h('input', { key: 'q', className: 'w2mGpw_adminInput', value: query, placeholder: '搜索路径', onChange: (event) => setQuery(event.target.value) }),
            h('input', { key: 'm', className: 'w2mGpw_adminInput', value: manual, placeholder: '输入绝对路径', onChange: (event) => setManual(event.target.value) }),
            h('button', { key: 'w', type: 'button', className: 'w2mGpw_adminBtn', disabled: busy, onClick: () => add('whitelist', manual) }, '添加到白名单'),
            h('button', { key: 'b', type: 'button', className: 'w2mGpw_adminBtn', disabled: busy, onClick: () => add('blacklist', manual) }, '添加到黑名单'),
            h('button', { key: 'r', type: 'button', className: 'w2mGpw_adminBtn', disabled: busy, onClick: () => load() }, '刷新'),
          ]),
        ]),
        h('div', { key: 'card', className: 'w2mGpw_adminCard' }, [
          h('div', { key: 'tabs', className: 'w2mGpw_adminTabs' }, [tabBtn('all', '全部'), tabBtn('whitelist', '白名单'), tabBtn('blacklist', '黑名单'), tabBtn('pending', '待审批 (' + pending.length + ')')]),
          tab === 'pending'
            ? h('table', { key: 'ptable', className: 'w2mGpw_adminTable' }, [
                h('thead', { key: 'thead' }, h('tr', null, [h('th', { key: 't' }, '工具'), h('th', { key: 'p' }, '路径'), h('th', { key: 's' }, '会话'), h('th', { key: 'a' }, '操作')])),
                h('tbody', { key: 'tbody' }, pending.length === 0
                  ? h('tr', null, h('td', { colSpan: 4, className: 'w2mGpw_adminEmpty' }, '没有待审批的调用'))
                  : pending.map((item) => h('tr', { key: item.id }, [
                      h('td', { key: 't' }, item.tool ?? 'tool'),
                      h('td', { key: 'p', className: 'w2mGpw_adminPath' }, item.path ?? item.folder ?? '-'),
                      h('td', { key: 's' }, item.session_id ?? '-'),
                      h('td', { key: 'a' }, [
                        h('button', { key: 'ok', type: 'button', className: 'w2mGpw_adminBtn', disabled: busy, onClick: () => decide(item.id, 'allow') }, '允许'),
                        ' ',
                        h('button', { key: 'no', type: 'button', className: 'w2mGpw_adminBtn', disabled: busy, onClick: () => decide(item.id, 'deny') }, '拒绝'),
                      ]),
                    ]))),
              ])
            : h('table', { key: 'table', className: 'w2mGpw_adminTable' }, [
                h('thead', { key: 'thead' }, h('tr', null, [h('th', { key: 'p' }, '文件夹路径'), h('th', { key: 'k' }, '类型'), h('th', { key: 's' }, '状态'), h('th', { key: 'a' }, '操作')])),
                h('tbody', { key: 'tbody' }, rows.length === 0
                  ? h('tr', null, h('td', { colSpan: 4, className: 'w2mGpw_adminEmpty' }, '暂无记录'))
                  : rows.map((row) => h('tr', { key: row.list + ':' + row.path }, [
                      h('td', { key: 'p', className: 'w2mGpw_adminPath', title: row.path }, row.path),
                      h('td', { key: 'k' }, h('span', { className: 'w2mGpw_adminBadge', 'data-kind': row.list }, row.list === 'whitelist' ? '白名单' : '黑名单')),
                      h('td', { key: 's' }, '启用'),
                      h('td', { key: 'a' }, h('button', { key: 'x', type: 'button', className: 'w2mGpw_adminBtn', disabled: busy, onClick: () => remove(row.list, row.path) }, '移除')),
                    ]))),
              ]),
        ]),
      ]);
    }

    /**
     * v1.9.11: in-conversation full-text search with visible yellow highlights.
     *
     * The previous version only called window.find, which the desktop shell does not reliably
     * surface. This walks the rendered conversation text and registers the matches through local
     * `mark` elements (no CSS Custom Highlight dependency, so a match is always visible), then
     * scrolls to the focused match. Matches stay yellow until the query changes or the box closes.
     *
     * v2.2.6: the walk covers the whole rendered conversation, not just the viewport. The old
     * viewport-only rule reported `0` for text that was merely scrolled out of sight, and capped the
     * count at six, which made a matching conversation look unsearchable. The cap now only bounds how
     * many nodes are wrapped (paint cost), never how many matches are counted.
     */
function searchRoots() {
  const roots = [];
  if (typeof document === 'undefined' || !document.body) return roots;
  const region = typeof document.querySelector === 'function'
    ? (document.querySelector('[data-conversation-region]') ?? document.querySelector('[data-conversation-session]'))
    : null;
  const start = region ?? document.body;
  const seen = new Set();
  const visit = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.nodeType === 1 || node.nodeType === 11) {
      if (node.shadowRoot) { roots.push(node.shadowRoot); visit(node.shadowRoot); }
      const kids = node.children ?? [];
      for (let i = 0; i < kids.length; i += 1) visit(kids[i]);
    }
  };
  roots.push(start);
  visit(start);
  return roots;
}
/**
 * All rendered match elements, including ones inside shadow roots.
 *
 * `paintSearchMarks` deliberately walks shadow roots (the shell renders conversation content in
 * them). `document.querySelectorAll` does NOT pierce a shadow root, so the previous arrows found
 * zero marks and returned: the counter advanced but nothing was selected or scrolled. This is the
 * single query every mark operation must use.
 */
function searchMarkElements() {
  const marks = [];
  const seen = new Set();
  const roots = [document, ...searchRoots()];
  for (const root of roots) {
    if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') continue;
    let found = [];
    try { found = root.querySelectorAll('mark.w2mSearchMark'); } catch { continue; }
    for (const mark of found) {
      if (seen.has(mark)) continue;
      seen.add(mark);
      marks.push(mark);
    }
  }
  return marks;
}
function clearSearchMarks() {
  if (typeof document === 'undefined') return;
  const marks = searchMarkElements();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (parent === null) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    if (parent.normalize) parent.normalize();
  }
}
/**
 * Search rules (v2.0.5 UI, revised in v2.2.6): a pure number up to 100 is not a useful query in a
 * conversation full of ids/ports/timestamps, so it is refused outright (no marks, no scroll, no
 * count). Every rendered match is counted; only the first {@link SEARCH_MAX_MARKS} are wrapped, so a
 * long conversation stays responsive without making a match outside the viewport invisible.
 */
const SEARCH_MAX_MARKS = 120;
/** Hard ceiling on counted matches, so a one-letter query in a huge conversation cannot stall the UI. */
const SEARCH_MAX_COUNT = 2000;
function searchQueryAllowed(query) {
  const text = String(query ?? '').trim();
  if (text === '') return false;
  if (/^\d+$/.test(text)) return Number(text) > 100;
  return true;
}
function paintSearchMarks(query) {
  clearSearchMarks();
  if (typeof document === 'undefined' || query === '' || !searchQueryAllowed(query)) return 0;
  const needle = query.toLowerCase();
  const ranges = [];
  outer: for (const root of searchRoots()) {
    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (parent === null) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') return NodeFilter.FILTER_REJECT;
          if (parent.closest && parent.closest('[data-w2m-search]') !== null) return NodeFilter.FILTER_REJECT;
          if (parent.closest && parent.closest('mark.w2mSearchMark') !== null) return NodeFilter.FILTER_REJECT;
          return node.nodeValue && node.nodeValue.trim() !== '' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
    } catch { continue; }
    let node = walker.nextNode();
    while (node !== null) {
      const text = node.nodeValue ?? '';
      const lower = text.toLowerCase();
      let index = lower.indexOf(needle);
      while (index >= 0) {
        try {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + query.length);
          ranges.push(range);
        } catch { /* an unselectable node cannot carry a match */ }
        if (ranges.length >= SEARCH_MAX_COUNT) break outer;
        index = lower.indexOf(needle, index + query.length);
      }
      node = walker.nextNode();
    }
  }
  // Wrap from the end so the offsets of the matches still ahead of us stay valid: wrapping one range
  // splits its text node, and a split above an earlier range cannot move that range.
  const wrapCount = Math.min(ranges.length, SEARCH_MAX_MARKS);
  for (let i = wrapCount - 1; i >= 0; i -= 1) {
    const range = ranges[i];
    try {
      const mark = document.createElement('mark');
      mark.className = 'w2mSearchMark';
      mark.setAttribute('style', 'background-color:rgba(255,235,59,.85);color:rgba(11,122,51,1)');
      range.surroundContents(mark);
    } catch { /* a range that crosses elements cannot be wrapped; it stays counted */ }
  }
  return ranges.length;
}
/**
 * Probe-scroll: assign a tiny scrollTop and see whether the browser keeps it.
 *
 * Overflow styles lie (a shell can scroll an overflow:hidden element), and a virtualised list may
 * report equal scrollHeight and clientHeight until it is scrolled. The original scrollTop is
 * restored immediately.
 */
function isScrollableElement(el) {
  if (el === null || el === undefined || el === document.body || el === document.documentElement) return false;
  if (typeof el.scrollTop !== 'number' || typeof el.scrollHeight !== 'number' || typeof el.clientHeight !== 'number') return false;
  if (el.scrollHeight <= el.clientHeight + 8) return false;
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  if (rect !== null && (rect.width < 200 || rect.height < 120)) return false;
  const before = el.scrollTop;
  try {
    el.scrollTop = before + 1;
    if (el.scrollTop !== before) { el.scrollTop = before; return true; }
    el.scrollTop = Math.max(0, before - 1);
    if (el.scrollTop !== before) { el.scrollTop = before; return true; }
    el.scrollTop = before;
    return false;
  } catch {
    return false;
  }
}
/** Every scrollable ancestor of a node, innermost first, then the shell surface as a fallback. */
function scrollableAncestors(node) {
  const surfaces = [];
  let current = node;
  while (current !== null && current !== undefined) {
    if (isScrollableElement(current)) surfaces.push(current);
    current = current.parentElement ?? (current.parentNode && current.parentNode.host ? current.parentNode.host : null);
  }
  const shell = findScrollSurface();
  if (shell !== null && !surfaces.includes(shell)) surfaces.push(shell);
  return surfaces;
}

/**
 * Center one match in every scrollable ancestor that holds it.
 *
 * `mark.scrollIntoView({block:'center'})` is not enough in the shell: the conversation is
 * virtualised and its scroller is not always the mark's nearest scroll container, so the call
 * either targets the wrong element or is undone by the next render. This sets scrollTop
 * directly (centred) and re-centres once after layout/virtualisation settles.
 */
function centerSearchMark(mark) {
  if (mark === null || mark === undefined) return;
  const surfaces = scrollableAncestors(mark);
  const center = () => {
    for (const surface of surfaces) {
      try {
        const markRect = mark.getBoundingClientRect();
        const surfaceRect = surface.getBoundingClientRect();
        if (surfaceRect.height <= 0) continue;
        const delta = (markRect.top + markRect.height / 2) - (surfaceRect.top + surfaceRect.height / 2);
        if (Math.abs(delta) > 3) surface.scrollTop = Math.max(0, surface.scrollTop + delta);
      } catch { /* a detached node cannot be centred */ }
    }
  };
  center();
  try {
    if (typeof mark.scrollIntoView === 'function') mark.scrollIntoView({ block: 'center', behavior: 'auto' });
  } catch { /* ignore */ }
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => { center(); });
    window.setTimeout(() => { center(); }, 120);
  }
}

/** Put `data-active` on exactly one match and scroll it to the middle. Returns its index or -1. */
function activateSearchMark(index) {
  const marks = searchMarkElements();
  if (marks.length === 0) return -1;
  const at = ((index % marks.length) + marks.length) % marks.length;
  for (let i = 0; i < marks.length; i += 1) {
    if (i === at) marks[i].setAttribute('data-active', 'true');
    else marks[i].removeAttribute('data-active');
  }
  centerSearchMark(marks[at]);
  return at;
}

function findScrollSurface() {
  if (typeof document === 'undefined') return null;
  const found = new Set();
  const addAncestors = (node) => {
    let current = node;
    while (current !== null && current !== undefined) {
      if (isScrollableElement(current)) { found.add(current); return; }
      current = current.parentElement ?? (current.parentNode && current.parentNode.host ? current.parentNode.host : null);
    }
  };
  if (typeof document.elementFromPoint === 'function' && typeof window !== 'undefined') {
    const points = [[window.innerWidth / 2, window.innerHeight / 2], [window.innerWidth / 2, window.innerHeight * 0.7], [window.innerWidth * 0.7, window.innerHeight * 0.4]];
    for (const point of points) {
      try { addAncestors(document.elementFromPoint(point[0], point[1])); } catch { /* ignore */ }
    }
  }
  for (const root of searchRoots()) {
    let all = [];
    try { all = root.querySelectorAll ? [...root.querySelectorAll('*')] : []; } catch { continue; }
    for (const el of all) if (isScrollableElement(el)) found.add(el);
  }
  let best = null;
  let bestArea = 0;
  for (const el of found) {
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const area = rect === null ? 0 : rect.width * rect.height;
    if (best === null || area > bestArea) { best = el; bestArea = area; }
  }
  return best;
}
/**
 * The shell virtualises history: scrolling up stops at the loaded window and only the "load
 * earlier" row fetches more. A scroll control that ignores that row can never reach the top, which
 * is exactly why the previous version looked like a no-op. Find and press it before scrolling.
 */
function findLoadEarlierButton() {
  if (typeof document === 'undefined') return null;
  for (const root of searchRoots()) {
    let nodes = [];
    try { nodes = root.querySelectorAll ? [...root.querySelectorAll('button, [role="button"], a, span, div')] : []; } catch { continue; }
    for (const el of nodes) {
      const text = String(el.textContent ?? '').trim();
      if (text === '' || text.length > 24) continue;
      if (!/加载更早|加载更多|更早|load earlier|load more/i.test(text)) continue;
      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (rect === null || rect.width < 8 || rect.height < 8) continue;
      if (typeof el.click === 'function') return el;
    }
  }
  return null;
}
function clickLoadEarlier() {
  const el = findLoadEarlierButton();
  if (el === null) return false;
  try { el.click(); return true; } catch { return false; }
}
const waitFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/**
 * The history loader shows "加载中..." while a page is in flight. Clicking "加载更早" again in that
 * window is what made the top button look like it was being interrupted/blocked: every loop pressed
 * the row while the previous press was still loading, so nothing advanced.
 */
function isLoadingEarlier() {
  if (typeof document === 'undefined') return false;
  for (const root of searchRoots()) {
    let nodes = [];
    try { nodes = root.querySelectorAll ? [...root.querySelectorAll('button, [role="button"], a, span, div')] : []; } catch { continue; }
    for (const el of nodes) {
      const text = String(el.textContent ?? '').trim();
      if (text === '' || text.length > 24) continue;
      if (/^加载中|^loading|加载中\.\.\./i.test(text)) return true;
    }
  }
  return false;
}
/** Wait for an in-flight "load earlier" page to finish (or time out), then continue. */
async function waitForLoadSettled(timeoutMs = 6000) {
  let waited = 0;
  while (waited < timeoutMs) {
    if (!isLoadingEarlier()) return true;
    await waitFor(100);
    waited += 100;
  }
  return false;
}
async function scrollChatTurns() {
  const surface = findScrollSurface();
  const viewport = typeof window !== 'undefined' ? window.innerHeight : 800;
  const step = Math.round(Math.max(240, (surface !== null ? surface.clientHeight : viewport) * 1.8));
  if (surface !== null && surface.scrollTop <= 8) {
    if (isLoadingEarlier()) await waitForLoadSettled();
    else if (clickLoadEarlier()) await waitForLoadSettled();
  }
  const after = surface ?? findScrollSurface();
  if (after !== null) after.scrollTop = Math.max(0, after.scrollTop - step);
  else if (typeof window !== 'undefined') window.scrollBy({ top: -step, behavior: 'smooth' });
}
async function scrollChatTop() {
  // Load history until the "load earlier" row is gone, but never press it while a page is loading:
  // each press waits for the loader to settle and for the surface to actually grow, and two pages
  // that add nothing end the loop instead of spinning. Only then is the surface pinned to the top.
  let stagnant = 0;
  let lastHeight = -1;
  for (let i = 0; i < 40; i += 1) {
    if (isLoadingEarlier()) {
      await waitForLoadSettled();
      continue;
    }
    const surface = findScrollSurface();
    if (surface !== null) surface.scrollTop = 0;
    const before = surface !== null ? surface.scrollHeight : -1;
    if (!clickLoadEarlier()) break;
    await waitForLoadSettled();
    const after = findScrollSurface() !== null ? findScrollSurface().scrollHeight : -1;
    if (after <= before || after === lastHeight) stagnant += 1; else stagnant = 0;
    lastHeight = after;
    if (stagnant >= 2) break;
  }
  await waitForLoadSettled();
  for (let i = 0; i < 8; i += 1) {
    const surface = findScrollSurface();
    if (surface !== null) surface.scrollTop = 0;
    else if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    await waitFor(70);
  }
}
/** One black circular button, anchored to the conversation column's top-right corner. */
function installFloatingScrollControl() {
  if (typeof document === 'undefined' || document.body === null) return null;
  const wrap = document.createElement('div');
  wrap.className = 'w2mScrollFloatWrap';
  wrap.setAttribute('data-w2m-scroll-float', 'true');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'w2mScrollFloatBtn';
  button.title = '向上滚动 3 轮（连续点击 3 次回到第一轮）';
  button.setAttribute('aria-label', '向上滚动');
  button.setAttribute('aria-description', '单次点击向上滚动三轮，连续点击三次回到第一轮');
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const shaft = document.createElementNS(ns, 'path');
  shaft.setAttribute('d', 'M12 19V5');
  const head = document.createElementNS(ns, 'path');
  head.setAttribute('d', 'M5 12l7-7 7 7');
  svg.appendChild(shaft);
  svg.appendChild(head);
  button.appendChild(svg);
  let clicks = 0;
  let resetTimer = null;
  const reset = () => { if (resetTimer !== null) { clearTimeout(resetTimer); resetTimer = null; } clicks = 0; };
  button.addEventListener('click', () => {
    clicks += 1;
    if (resetTimer !== null) clearTimeout(resetTimer);
    if (clicks >= 3) { reset(); void scrollChatTop(); return; }
    void scrollChatTurns();
    resetTimer = setTimeout(reset, 1200);
  });
  wrap.appendChild(button);
  document.body.appendChild(wrap);
  const place = () => {
    const surface = findScrollSurface();
    if (surface === null) {
      wrap.style.top = '120px';
      wrap.style.right = '16px';
      return;
    }
    const rect = surface.getBoundingClientRect();
    wrap.style.top = Math.max(8, Math.round(rect.top + 8)) + 'px';
    wrap.style.right = Math.max(12, Math.round(window.innerWidth - rect.right)) + 'px';
  };
  place();
  for (const delay of [120, 600, 1500]) setTimeout(place, delay);
  window.addEventListener('resize', place);
  let observer = null;
  let observed = null;
  const observe = () => {
    if (typeof ResizeObserver !== 'function') return;
    const surface = findScrollSurface();
    if (surface === observed) return;
    if (observer !== null) observer.disconnect();
    observed = surface;
    observer = new ResizeObserver(() => place());
    if (surface !== null) observer.observe(surface);
  };
  observe();
  const reObserve = setTimeout(observe, 800);
  const poll = setInterval(place, 1000);
  return () => {
    reset();
    clearTimeout(reObserve);
    clearInterval(poll);
    window.removeEventListener('resize', place);
    if (observer !== null) observer.disconnect();
    wrap.remove();
  };
}
function ConversationSearch() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [count, setCount] = React.useState(0);
  const [cursor, setCursor] = React.useState(-1);
  const [pending, setPending] = React.useState(false);
  const inputRef = React.useRef(null);
  React.useEffect(() => { if (open && inputRef.current && inputRef.current.focus) inputRef.current.focus(); }, [open]);
  // v2.2.6: wait 1s after the last keystroke before walking the conversation (the v2.0.5 delay was
  // 3s, which read as "search does nothing" and was the reported complaint). One pass per settled
  // query is still what keeps typing cheap; the walk now covers the whole conversation and counts
  // every match, so a hit outside the current viewport is no longer reported as zero.
  const appliedRef = React.useRef('');
  const activeRef = React.useRef(-1);
  const paintRef = React.useRef(() => {});
  paintRef.current = (focus = false) => {
    const total = paintSearchMarks(appliedRef.current);
    setCount(total);
    setPending(false);
    if (total > 0) {
      const at = activateSearchMark(0);
      activeRef.current = at;
      setCursor(at);
      if (focus === true && at >= 0) centerSearchMark(searchMarkElements()[at]);
    } else {
      activeRef.current = -1;
      setCursor(-1);
    }
  };
  React.useEffect(() => {
    if (!open) { appliedRef.current = ''; activeRef.current = -1; clearSearchMarks(); setCount(0); setCursor(-1); setPending(false); }
  }, [open]);
  React.useEffect(() => {
    if (!open) return undefined;
    if (!searchQueryAllowed(query)) {
      // Refused query: no marks, no count, no scroll — the input itself stays usable.
      appliedRef.current = '';
      activeRef.current = -1;
      clearSearchMarks();
      setCount(0);
      setCursor(-1);
      setPending(false);
      return undefined;
    }
    setPending(true);
    const timer = setTimeout(() => { appliedRef.current = query; paintRef.current(true); }, 1000);
    return () => clearTimeout(timer);
  }, [open, query]);
  const step = (backwards) => {
    if (appliedRef.current === '') return;
    let marks = searchMarkElements();
    if (marks.length === 0) { paintRef.current(false); marks = searchMarkElements(); }
    if (marks.length === 0) return;
    const base = activeRef.current >= 0 ? activeRef.current : (backwards ? 0 : -1);
    const at = activateSearchMark(base + (backwards ? -1 : 1));
    if (at >= 0) {
      activeRef.current = at;
      setCursor(at);
    }
  };
  if (!open) {
    return h('span', { className: 'w2mSearchControls' }, [
      h('button', {
        key: 'find',
        type: 'button',
        className: 'w2mSearchToggle',
        title: '搜索本对话',
        'aria-label': '搜索本对话',
        onClick: () => setOpen(true),
      }, '🔍'),
    ]);
  }
  return h('div', { className: 'w2mSearchBox', 'data-w2m-search': 'box' }, [
    h('input', {
      key: 'q',
      ref: inputRef,
      className: 'w2mSearchInput',
      value: query,
      placeholder: '搜索本对话全部内容',
      onChange: (event) => setQuery(event.target.value),
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (searchQueryAllowed(query)) { appliedRef.current = query; paintRef.current(true); }
        }
        if (event.key === 'Escape') { setOpen(false); setQuery(''); }
      },
    }),
    h('span', { key: 'count', className: 'w2mSearchCount' }, pending
      ? '…'
      : (count === 0 ? (searchQueryAllowed(query) ? '0' : '') : whenCount(count, cursor))),
    h('button', { key: 'prev', type: 'button', className: 'w2mSearchBtn', title: '上一个', onClick: () => step(true) }, '↑'),
    h('button', { key: 'next', type: 'button', className: 'w2mSearchBtn', title: '下一个', onClick: () => step(false) }, '↓'),
    h('button', { key: 'close', type: 'button', className: 'w2mSearchBtn', title: '关闭搜索', onClick: () => { activeRef.current = -1; setOpen(false); setQuery(''); clearSearchMarks(); } }, '×'),
  ]);
}
function whenCount(total, at) {
      return (at >= 0 ? at + 1 : 0) + '/' + total;
    }

    /** v1.9.4: the GPW tab in Settings, between Models and Plugins. */
    function GpwSettingsPage({ t }) {
      return h('div', { className: 'w2mGpw_settingsBody' }, h(GpwPanel, { t, sessionId: undefined, inline: true, onClose: () => {} }));
    }

    /** The floating launcher: a pending badge, and the panel fixed to the lower-right corner. */
    function GpwLauncher({ t, sessionId }) {
      const [available, setAvailable] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [full, setFull] = React.useState(false);
      const [pendingCount, setPendingCount] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch('/api/w2m/gpw/state', { credentials: 'same-origin', headers: { accept: 'application/json' } });
            if (alive) setAvailable(response.status !== 404);
            const body = response.ok ? await response.json() : null;
            if (alive) setPendingCount(body?.ok === true && Array.isArray(body.pending) ? body.pending.length : 0);
          } catch {
            if (alive) setPendingCount(0);
          }
        };
        load();
        const timer = setInterval(load, 3000);
        const onOpen = () => setOpen(true);
        const onFull = () => setFull(true);
        window.addEventListener('w2m-gpw-open', onOpen);
        window.addEventListener('w2m-gpw-full', onFull);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener('w2m-gpw-open', onOpen);
          window.removeEventListener('w2m-gpw-full', onFull);
        };
      }, []);
      if (available !== true) return null;
      return h(React.Fragment, null, [
        h('button', {
          key: 'launcher',
          type: 'button',
          className: 'w2mGpw_launcher',
          title: pendingCount > 0 ? t('gpwPendingCount', { count: pendingCount }) : t('gpwLauncher'),
          'aria-expanded': open,
          onClick: () => setOpen((wasOpen) => !wasOpen),
        }, [
          t('gpwLauncher'),
          pendingCount > 0 ? h('span', { key: 'badge', className: 'w2mGpw_badge' }, String(pendingCount)) : null,
        ]),
        open ? h(GpwPanel, { key: 'panel', t, sessionId, onClose: () => setOpen(false) }) : null,
        full ? h(GpwFullPage, { key: 'full', t, sessionId, onClose: () => setFull(false) }) : null,
      ]);
    }

    /**
     * v1.7.9: the inline approval prompt -- an interception asks a question in the composer row
     * (allow once / deny once / open the panel) instead of waiting silently for the operator.
     */
    function GpwPrompt({ t, sessionId }) {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch('/api/w2m/gpw/state', { credentials: 'same-origin', headers: { accept: 'application/json' } });
            const body = response.ok ? await response.json() : null;
            if (alive) setState(body);
          } catch {
            if (alive) setState(null);
          }
        };
        load();
        const timer = setInterval(load, 2000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);
      const pendingAll = Array.isArray(state?.pending) ? state.pending : [];
      // v1.8.1: an approval belongs to the conversation that raised it; another session must never show it.
      const pending = pendingAll.filter((item) => item?.session_id === null || item?.session_id === undefined || item?.session_id === sessionId);
      if (pending.length === 0) return null;
      const item = pending[0];
      const decide = async (decision) => {
        setBusy(true);
        try {
          await fetch('/api/w2m/gpw/decide', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ id: item.id, decision }),
          });
        } catch {
          /* the next poll shows the queue again */
        } finally {
          setBusy(false);
        }
      };
      const openPanel = () => {
        try {
          window.dispatchEvent(new CustomEvent('w2m-gpw-open'));
        } catch {
          /* no window in a headless render */
        }
      };
      return h('div', { className: 'w2mGpw_prompt', 'data-w2m-gpw-prompt': 'inline' }, [
        h('span', { key: 'label', className: 'w2mGpw_promptLabel' }, pending.length > 1
          ? t('gpwPendingCount', { count: pending.length })
          : t('gpwPendingShort', { tool: item.tool ?? 'tool' })),
        h('span', { key: 'level', className: 'w2mGpw_dot', 'data-c': item.level ?? item.color ?? 'yellow' }),
        h('span', { key: 'countdown', className: 'w2mGpwCountdown' }, gpwCountdownText(item)),
        item.ai?.reason ? h('span', { key: 'ai', className: 'w2mGpwAiReason' }, 'AI：' + (item.ai.action === 'deny' ? '建议拒绝' : '建议允许') + ' · ' + String(item.ai.reason ?? '')) : null,
        h('button', { key: 'a', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => decide('allow') }, t('gpwAllowOnce')),
        h('button', { key: 'd', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => decide('deny') }, t('gpwDenyOnce')),
        h('button', { key: 'o', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: openPanel }, t('gpwOpenPanel')),
      ]);
    }

    /** v1.6.8: one button beside the relay rows: check npm for a newer plugin, install it, ask for a restart. */
function PluginUpdate({ t }) {
  const [state, setState] = React.useState({ status: 'idle', info: null, error: null });
  const call = async (method, body) => {
    const response = await fetch(PLUGIN_UPDATE_ROUTE, {
      method, credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json = null;
    try { json = await response.json(); } catch { /* keep null */ }
    return { status: response.status, json };
  };
  const onClick = async () => {
    setState({ status: 'checking', info: null, error: null });
    try {
      const checked = await call('GET');
      const info = checked.json ?? {};
      if (info.ok !== true) { setState({ status: 'error', info, error: info.error ?? 'update check failed' }); return; }
      if (info.update_available !== true) { setState({ status: 'current', info, error: null }); return; }
      setState({ status: 'applying', info, error: null });
      const applied = await call('POST', { action: 'apply' });
      const result = applied.json ?? {};
      if (result.ok !== true) { setState({ status: 'error', info: result, error: result.error ?? result.reason ?? 'update failed' }); return; }
      setState({ status: 'installed', info: result, error: null });
    } catch (error) {
      setState({ status: 'error', info: null, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const label = state.status === 'checking' ? t('updateChecking')
    : state.status === 'applying' ? t('updating')
    : state.status === 'current' ? t('updateCurrent', { version: state.info?.current ?? '?' })
    : state.status === 'installed' ? t('updateInstalled', { version: state.info?.to ?? state.info?.latest ?? '?' })
    : t('updateButton');
  const disabled = state.status === 'checking' || state.status === 'applying';
  return h('div', { className: cls('relayHint'), 'data-w2m-update': state.status }, [
    h('button', { key: 'b', type: 'button', className: cls('relayToggle'), disabled, onClick: (event) => { event.stopPropagation(); onClick(); } }, label),
    state.status === 'installed' ? h('div', { key: 'r', className: cls('relayHint') }, t('restartHint')) : null,
    state.status === 'error' ? h('div', { key: 'e', className: cls('relayHint') }, String(state.error ?? 'error')) : null,
  ]);
}
/**
 * v1.9.3: the GPW entry in the LEFT sidebar footer. It is always rendered and carries no close
 * affordance -- the operator asked for a permanent entry in addition to the composer and the
 * floating launcher. The click reuses the launcher's event so there is one panel, not two.
 */
function _GpwSidebarFooter() {
  return h('button', {
    type: 'button',
    className: 'w2mGpw_sideEntry',
    'data-w2m-gpw-sidebar': 'true',
    title: 'GPW 文件夹策略',
    onClick: () => {
      try { window.dispatchEvent(new CustomEvent('w2m-gpw-open')); } catch { /* headless render */ }
    },
  }, [
    h('span', { key: 'i', className: 'w2mGpw_sideIcon', 'aria-hidden': 'true' }, '📁'),
    h('span', { key: 'l', className: 'w2mGpw_sideLabel' }, 'GPW'),
  ]);
}

const AUTO_UPDATE_PREF = 'w2m:plugin-auto-update';

/**
 * v1.9.3: the update section on the plugin settings page.
 *
 * Two operator requests meet here: a check that still says something when the installed build is
 * old (the old button lived inside the composer dropdown and was easy to miss), and an auto-update
 * switch that actually performs the install instead of only remembering a preference.
 */
function UpdateSettingsSection() {
  const [state, setState] = React.useState({ status: 'idle', info: null, error: null });
  const [auto, setAuto] = React.useState(false);
  React.useEffect(() => {
    try { setAuto(globalThis.localStorage?.getItem(AUTO_UPDATE_PREF) === '1'); } catch { /* storage off */ }
  }, []);
  const run = React.useCallback(async ({ install }) => {
    setState({ status: 'checking', info: null, error: null });
    try {
      const checked = await fetch(PLUGIN_UPDATE_ROUTE, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } });
      const info = await checked.json().catch(() => ({}));
      if (info.ok !== true) { setState({ status: 'error', info, error: info.error ?? 'update check failed' }); return; }
      if (install !== true || info.update_available !== true) {
        setState({ status: info.update_available === true ? 'available' : 'current', info, error: null });
        return;
      }
      setState({ status: 'applying', info, error: null });
      const applied = await fetch(PLUGIN_UPDATE_ROUTE, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply' }) });
      const result = await applied.json().catch(() => ({}));
      if (result.ok !== true) { setState({ status: 'error', info: result, error: result.error ?? result.reason ?? 'update failed' }); return; }
      setState({ status: 'installed', info: { ...info, ...result }, error: null });
    } catch (error) {
      setState({ status: 'error', info: null, error: error instanceof Error ? error.message : String(error) });
    }
  }, []);
  const toggleAuto = (event) => {
    const next = event?.target?.checked === true;
    setAuto(next);
    try { globalThis.localStorage?.setItem(AUTO_UPDATE_PREF, next ? '1' : '0'); } catch { /* storage off */ }
    if (next) run({ install: true });
  };
  // v1.9.3: state the update picture as soon as the section opens, so an outdated install is
  // visible without a click; the auto path below only adds the install step.
  React.useEffect(() => { run({ install: false }); }, [run]);
  React.useEffect(() => { if (auto) run({ install: true }); }, [auto, run]);
  // v1.9.4: an installed update becomes live on reload; DSH reloads the client bundle without a reinstall.
  React.useEffect(() => {
    if (state.status !== 'installed') return undefined;
    const timer = setTimeout(() => { try { window.location.reload(); } catch { /* headless */ } }, 1500);
    return () => clearTimeout(timer);
  }, [state.status]);
  const busy = state.status === 'checking' || state.status === 'applying';
  const statusText = state.status === 'checking' ? '正在检测更新…'
    : state.status === 'applying' ? '正在安装更新…'
    : state.status === 'available' ? ('发现新版本 ' + (state.info?.latest ?? '?') + '（当前 ' + (state.info?.current ?? '?') + '）')
    : state.status === 'installed' ? ('已安装 ' + (state.info?.to ?? state.info?.latest ?? '?') + '，重启后生效')
    : state.status === 'current' ? ('已是最新版本 ' + (state.info?.current ?? state.info?.latest ?? '?'))
    : state.status === 'error' ? ('更新失败：' + String(state.error ?? 'unknown'))
    : '检测插件是否有新版本；开启自动更新后每次启动自动安装。';
  return h('div', { className: 'w2mUpdateSection', 'data-w2m-update-section': state.status }, [
    h('div', { key: 's', className: 'w2mUpdateStatus' }, statusText),
    h('div', { key: 'row', className: 'w2mUpdateRow' }, [
      h('button', { key: 'check', type: 'button', className: 'w2mUpdateBtn', disabled: busy, onClick: () => run({ install: false }) }, '检测更新'),
      state.status === 'available'
        ? h('button', { key: 'install', type: 'button', className: 'w2mUpdateBtn', disabled: busy, onClick: () => run({ install: true }) }, '立即更新')
        : null,
      h('label', { key: 'auto', className: 'w2mUpdateAuto' }, [
        h('input', { key: 'c', type: 'checkbox', checked: auto, disabled: state.status === 'applying', onChange: toggleAuto }),
        h('span', { key: 'l' }, '自动更新'),
      ]),
    ]),
  ]);
}

    /**
     * The `@machine` token the target control writes into the composer.
     *
     * This is a *visible handle*, not the dispatch decision: the host-side selection store remains
     * the source of truth, and `w2m_run` reads it from the host process. The token exists so the
     * operator can see which machine the next turn is aimed at after the menu closes.
     *
     * A name that is not a single safe word is quoted, because DSH's own `@` trigger runs to the
     * next whitespace. A name containing a quote cannot be represented safely and yields null:
     * the selection still works, it simply gets no token.
     *
     * @param {string|null|undefined} name The machine's display name.
     * @returns {string|null} `@name`, `@"name with spaces"`, or null.
     */
    function targetTokenForName(name) {
      if (typeof name !== 'string') return null;
      const trimmed = name.trim();
      if (trimmed === '' || /[\r\n"]/.test(trimmed)) return null;
      return /^[A-Za-z0-9_-]+$/.test(trimmed) ? `@${trimmed}` : `@"${trimmed}"`;
    }

    /** Occurrence offsets are clipboard offsets; sort them so both maps walk one order. */
    function sortedOccurrences(occurrences) {
      return (Array.isArray(occurrences) ? occurrences : [])
        .filter((entry) => entry !== null && typeof entry === 'object'
          && Number.isInteger(entry.offset) && Number.isInteger(entry.length) && entry.length > 0)
        .slice()
        .sort((left, right) => left.offset - right.offset);
    }

    /**
     * Clipboard offset → editor (detect) offset.
     *
     * A reference chip is one U+FFFC in the editor but its whole clipboard text in the draft, so
     * the two coordinate spaces diverge after every chip. Positions inside a chip are clamped to
     * its editor position; a token boundary never lands there.
     */
    function clipboardToDetect(offset, occurrences) {
      let shift = 0;
      for (const occurrence of sortedOccurrences(occurrences)) {
        if (offset <= occurrence.offset) break;
        if (offset < occurrence.offset + occurrence.length) return occurrence.offset - shift + 1;
        shift += occurrence.length - 1;
      }
      return offset - shift;
    }

    /** Editor (detect) offset → clipboard offset; the inverse of {@link clipboardToDetect}. */
    function detectToClipboard(offset, occurrences) {
      let shift = 0;
      for (const occurrence of sortedOccurrences(occurrences)) {
        const start = occurrence.offset - shift;
        if (offset <= start) break;
        if (offset < start + 1) return occurrence.offset;
        shift += occurrence.length - 1;
      }
      return offset + shift;
    }

    /** Find a token in the draft, requiring a word boundary on both sides. */
    function targetTokenSpan(draft, token) {
      if (typeof draft !== 'string' || typeof token !== 'string' || token === '') return null;
      let from = 0;
      while (from <= draft.length) {
        const start = draft.indexOf(token, from);
        if (start < 0) return null;
        const before = start === 0 ? '' : draft.charAt(start - 1);
        const after = draft.charAt(start + token.length);
        const beforeOk = start === 0 || /\s/.test(before);
        const afterOk = after === '' || /\s/.test(after) || /[.,;:!?，。；：！？、]/.test(after);
        if (beforeOk && afterOk) return { start, end: start + token.length };
        from = start + 1;
      }
      return null;
    }

    /**
     * The editor span that removes one token without leaving a double word gap.
     *
     * Letting a token go and leaving its separating space turns "@alpha run" into " run", which is
     * visibly not the draft the operator typed. Only one ASCII space is eaten, and a newline is
     * never eaten: the plugin owns the token, not the paragraph around it.
     */
    function targetTokenRemoval(draft, span, occurrences) {
      let clipboardEnd = span.end;
      if (draft.charAt(clipboardEnd) === ' ') clipboardEnd += 1;
      return {
        start: clipboardToDetect(span.start, occurrences),
        end: clipboardToDetect(clipboardEnd, occurrences),
      };
    }

    /**
     * Plan the one editor edit that keeps the visible token in step with a target change.
     *
     * Rules (all deliberately conservative):
     *   · switching A → B replaces the old `@A` instead of leaving two targets in the draft;
     *   · the new token is only inserted when the host accepted the selection;
     *   · clearing the selection removes only the token this plugin inserted;
     *   · an existing `@B` is never duplicated;
     *   · a name that cannot be represented as a token is left alone rather than guessed.
     *
     * @returns {{kind: 'none'|'present'|'remove'|'replace'|'insert', text?: string,
     *   start?: number, end?: number, reason?: string}}
     */
    function planTargetMention(input = {}) {
      const draft = typeof input.draft === 'string' ? input.draft : '';
      const occurrences = sortedOccurrences(input.occurrences);
      const caret = input.caret !== null && typeof input.caret === 'object' ? input.caret : {};
      const nextToken = targetTokenForName(input.nextName);
      const previousToken = targetTokenForName(input.previousName);
      const previousSpan = previousToken === null ? null : targetTokenSpan(draft, previousToken);

      if (nextToken === null) {
        if (previousSpan === null) return { kind: previousToken === null ? 'none' : 'present', reason: 'no-token' };
        return {
          kind: 'remove',
          ...targetTokenRemoval(draft, previousSpan, occurrences),
          draftRev: Number.isInteger(caret.draftRev) ? caret.draftRev : 0,
        };
      }

      const nextSpan = targetTokenSpan(draft, nextToken);
      if (nextSpan !== null) {
        if (previousSpan !== null && previousToken !== nextToken) {
          return {
            kind: 'remove',
            ...targetTokenRemoval(draft, previousSpan, occurrences),
            draftRev: Number.isInteger(caret.draftRev) ? caret.draftRev : 0,
          };
        }
        return { kind: 'present' };
      }

      if (previousSpan !== null) {
        return {
          kind: 'replace',
          text: nextToken,
          start: clipboardToDetect(previousSpan.start, occurrences),
          end: clipboardToDetect(previousSpan.end, occurrences),
          draftRev: Number.isInteger(caret.draftRev) ? caret.draftRev : 0,
        };
      }

      const start = Number.isInteger(caret.start) ? caret.start : 0;
      const end = Number.isInteger(caret.end) ? caret.end : start;
      // Inserting at a non-collapsed selection must not consume what the operator selected:
      // the selection is where their caret is, not text this control owns. Anchor at its end.
      const at = end;
      const clipboardAt = detectToClipboard(at, occurrences);
      const lead = clipboardAt > 0 && !/\s/.test(draft.charAt(clipboardAt - 1)) ? ' ' : '';
      const tail = /\s/.test(draft.charAt(clipboardAt)) ? '' : ' ';
      return {
        kind: 'insert',
        text: lead + nextToken + tail,
        start: at,
        end: at,
        draftRev: Number.isInteger(caret.draftRev) ? caret.draftRev : 0,
      };
    }

    /** Put the caret back in the composer after the menu closes; best effort, never fatal. */
    function focusComposer() {
      if (typeof document === 'undefined') return;
      try {
        const node = document.querySelector('[data-composer-input]');
        if (node !== null && typeof node.focus === 'function') node.focus({ preventScroll: true });
      } catch { /* a detached or re-rendered editor is not an error */ }
    }

    /** A composition without the input seat keeps the control working, minus the token edit. */
    function useNoComposerInput() {
      return null;
    }

    /** Stable selector: the whole input snapshot, never a fresh derived object. */
    function selectComposerInput(snapshot) {
      return snapshot;
    }

    /**
     * v2.2.1: the settings-page fleet pin.
     *
     * The operator pastes an old fleet key, sees the fleet id it derives, compares that with the
     * expected id, and only then saves. The host route writes an independent `fleet-config.json`
     * with a backup; this component never edits `cordis.patch.yml` and never displays the key back.
     */
    function FleetConfigSection() {
      const [state, setState] = React.useState(null);
      const [keyInput, setKeyInput] = React.useState('');
      const [expectedId, setExpectedId] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [confirmed, setConfirmed] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [saved, setSaved] = React.useState(null);

      const call = async (init) => {
        try {
          const response = await fetch('/api/w2m/fleet-config', {
            credentials: 'same-origin',
            headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...init,
          });
          let body = null;
          try { body = await response.json(); } catch { body = null; }
          if (response.status === 404) return { ok: false, routeMissing: true, error: 'this host does not serve the fleet-config route' };
          if (response.ok !== true || body?.ok === false) {
            return { ok: false, error: body?.error ?? body?.code ?? `HTTP ${response.status}`, body };
          }
          return { ok: true, body };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };

      const load = React.useCallback(async () => {
        const result = await call({ method: 'GET' });
        if (result.ok) setState(result.body);
        else setError(result.routeMissing ? '当前 DSH 没有编队绑定路由（插件版本过旧或未挂载）' : (result.error ?? '读取失败'));
      }, []);
      React.useEffect(() => { load(); }, [load]);

      const previewKey = async () => {
        const key = keyInput.trim();
        if (key === '') return;
        setBusy(true);
        setError(null);
        setSaved(null);
        setConfirmed(false);
        try {
          const result = await call({ method: 'POST', body: JSON.stringify({ action: 'preview', fleet_key: key, expected_fleet_id: expectedId.trim() }) });
          if (!result.ok) { setPreview(null); setError(result.error ?? '无法计算 fleet_id'); return; }
          setPreview(result.body);
        } finally { setBusy(false); }
      };

      const save = async () => {
        const key = keyInput.trim();
        if (key === '' || preview === null || confirmed !== true) return;
        setBusy(true);
        setError(null);
        try {
          const result = await call({
            method: 'POST',
            body: JSON.stringify({ action: 'save', fleet_key: key, expected_fleet_id: preview.fleet_id }),
          });
          if (!result.ok) { setError(result.error ?? '保存失败'); return; }
          setSaved(result.body);
          setKeyInput('');
          setPreview(null);
          setConfirmed(false);
          await load();
        } finally { setBusy(false); }
      };

      const expectedMismatch = preview !== null && expectedId.trim() !== ''
        && String(preview.fleet_id).toLowerCase() !== expectedId.trim().toLowerCase();
      const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', wordBreak: 'break-all' };
      return h('div', { className: 'w2mGpw_admin' }, [
        h('div', { key: 'head', className: 'w2mGpw_adminHead' }, [
          h('h1', { key: 'h', className: 'w2mGpw_adminTitle' }, '编队绑定'),
          h('div', { key: 'sub', className: 'w2mGpw_adminSub' },
            '把本机固定到指定编队。保存到独立的 fleet-config.json（0600），不改 cordis.patch.yml；保存后重启 DSH 才生效。'),
        ]),
        error === null ? null : h('div', { key: 'err', className: 'w2mGpw_adminNote' }, error),
        h('div', { key: 'current', className: 'w2mGpw_adminCard' }, [
          h('div', { key: 's', className: 'w2mGpw_adminSub' }, state === null
            ? '读取中…'
            : state.configured === true
              ? `已配置 · policy ${String(state.policy ?? '?')} · 指纹 ${String(state.fingerprint ?? '').slice(0, 12)}`
              : '未配置：当前按 fleetKeyPolicy 的默认策略绑定'),
          state?.fleet_id ? h('div', { key: 'id', style: mono }, 'fleet_id: ' + state.fleet_id) : null,
          state?.path ? h('div', { key: 'p', className: 'w2mGpw_adminSub' }, '文件：' + state.path) : null,
        ]),
        h('div', { key: 'form', className: 'w2mGpw_adminCard' }, [
          h('div', { key: 'row', className: 'w2mGpw_adminToolbar' }, [
            h('input', {
              key: 'k',
              className: 'w2mGpw_adminInput',
              type: 'password',
              value: keyInput,
              placeholder: '旧 fleet key（保存后只显示指纹，不回显）',
              onChange: (event) => { setKeyInput(event.target.value); setPreview(null); setConfirmed(false); },
            }),
            h('button', { key: 'c', type: 'button', className: 'w2mGpw_adminBtn', disabled: busy || keyInput.trim() === '', onClick: previewKey }, '计算 fleet_id'),
          ]),
          h('div', { key: 'row2', className: 'w2mGpw_adminToolbar', style: { marginTop: '8px' } }, [
            h('input', {
              key: 'e',
              className: 'w2mGpw_adminInput',
              value: expectedId,
              placeholder: '期望的 fleet_id（可选，例如 004945ed…）',
              onChange: (event) => { setExpectedId(event.target.value); setConfirmed(false); },
            }),
          ]),
          preview === null ? null : h('div', { key: 'preview', style: { marginTop: '12px' } }, [
            h('div', { key: 'l', className: 'w2mGpw_adminSub' }, '这个 key 算出的 fleet_id：'),
            h('div', { key: 'id', style: { ...mono, margin: '4px 0 8px' } }, String(preview.fleet_id)),
            expectedMismatch
              ? h('div', { key: 'bad', className: 'w2mGpw_adminNote' }, '与期望值不一致，不能保存。请核对 key 或期望值。')
              : h('label', { key: 'ok', className: 'w2mGpw_adminSub', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
                  h('input', {
                    key: 'c',
                    type: 'checkbox',
                    checked: confirmed,
                    disabled: expectedMismatch,
                    onChange: (event) => setConfirmed(event.target.checked),
                  }),
                  h('span', { key: 't' }, '我确认这是目标编队，保存并固定'),
                ]),
            h('button', {
              key: 'save',
              type: 'button',
              className: 'w2mGpw_adminBtn',
              style: { marginTop: '8px' },
              disabled: busy || confirmed !== true || expectedMismatch,
              onClick: save,
            }, '保存并固定到该编队'),
          ]),
          saved === null ? null : h('div', { key: 'saved', className: 'w2mGpw_adminNote' }, [
            h('div', { key: 'a' }, '已保存。重启 DSH 后生效；本页不会自动重启。'),
            h('div', { key: 'b', style: mono }, 'fleet_id: ' + String(saved.fleet_id ?? '')),
            saved.backup ? h('div', { key: 'c' }, '备份：' + saved.backup) : null,
          ]),
        ]),
      ]);
    }

/** v3.3.10: group the roster the way the fleet is operated: clients first, then the web hosts. */
    function targetMachineKindOf(machine) {
      const os = typeof machine?.os === 'string' ? machine.os.trim().toLowerCase() : '';
      const name = typeof machine?.name === 'string' ? machine.name.trim() : '';
      if (name !== '' && /(^|[-_\s])(web|relay)([-_\s]|$)/i.test(name)) return 'web';
      // v3.3.12: only a known desktop platform is a client; unknown/other platforms are Web端.
      // Deliberately derived from os/name rather than trusting a stale host `kind`: the host
      // runtime can be older than this bundle after an in-place update (seen on 2026-11-15:
      // host 3.3.5 + client 3.3.10 kept unknown-platform machines in the client group).
      if (os === 'windows' || os === 'macos' || os === 'darwin' || os === 'win32') return 'client';
      return 'web';
    }

    /**
     * v3.3.15: three buckets for the target menu — online clients, online web hosts, offline machines.
     * Offline machines are not a platform kind, so they get their own group instead of being hidden
     * among the actionable ones.
     */
    function groupTargetMachines(machines) {
      const client = [];
      const web = [];
      const offline = [];
      for (const machine of Array.isArray(machines) ? machines : []) {
        if (machine?.online !== true) { offline.push(machine); continue; }
        (targetMachineKindOf(machine) === 'web' ? web : client).push(machine);
      }
      return { client, web, offline };
    }

    function TargetSelect({ sessionId, locked: _locked, t, inputActions, useInput }) {
      const [open, setOpen] = React.useState(false);
      // v1.5.1: relay folding. The snapshot carries the pool; when it holds more than three nodes
      // the menu shows a summary and this toggle reveals the folded ones.
      const [relayOpen, setRelayOpen] = React.useState(false);
      // v3.3.10: the Web half is folded on every open; clients are what an operator usually targets.
      const [webOpen, setWebOpen] = React.useState(false);
      // v3.3.15: offline machines are folded too; they are visible but not actionable.
      const [offlineOpen, setOfflineOpen] = React.useState(false);
      const [reloadSeq, setReloadSeq] = React.useState(0);
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      // A write/edit refusal is not a fleet-read failure: the menu is closed when it happens, so
      // keeping it beside `error` (which a successful read clears) is what makes it survive the
      // reopen that shows it to the operator.
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const anchorRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const [placement, setPlacement] = React.useState(null);

      // v2.3.0: the target control also writes a visible `@machine` token. `inputActions` and
      // `useInput` are standard session props (dsh-client-ui-conversation provides them to every
      // session slot); a host that does not carry them still gets the selector, just no token.
      const useComposerInput = typeof useInput === 'function' ? useInput : useNoComposerInput;
      const input = useComposerInput(selectComposerInput);
      const inputRef = React.useRef(input);
      inputRef.current = input;
      // Session switches are per mount in the shell, but a write can still land after the prop
      // changed under a reused component. The ref reads the current value at resolve time; the
      // sequence makes the last click win when two writes are in flight.
      const sessionRef = React.useRef(sessionId);
      sessionRef.current = sessionId;
      const writeSeq = React.useRef(0);

      // The host half is the source of truth, so every read replaces the mirror rather than merging
      // into it: a stale "online" must not outlive the answer that disproved it.
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        const controller = new AbortController();
        readState(sessionId, controller.signal).then((result) => {
          if (controller.signal.aborted) return;
          if (result.ok) {
            setState(result.state);
            setError(null);
          } else {
            setError(result.error);
          }
        });
        return () => controller.abort();
      }, [sessionId, reloadSeq]);

      // Opening the menu is a read: the roster and the selection are re-asked for every time, so a
      // machine that went away while the menu was closed cannot be clicked as if it were live. The
      // host caches its own relay read for a few seconds, so this is not a request storm.
      React.useEffect(() => {
        setWebOpen(false);
        setOfflineOpen(false);
        if (open) setReloadSeq((seq) => seq + 1);
      }, [open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const reposition = () => {
          const anchor = anchorRef.current;
          if (anchor === null) return;
          const rect = anchor.getBoundingClientRect();
          const width = Math.min(300, Math.max(200, Math.round(rect.width) + 96));
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
          // Above the composer by default — it is at the bottom of the window — and below it only
          // when the space above is genuinely unusable.
          const roomAbove = rect.top;
          const maxHeight = Math.max(160, Math.min(320, roomAbove > 240 ? roomAbove - 16 : window.innerHeight - rect.bottom - 24));
          setPlacement(roomAbove > 240
            ? { left, width, maxHeight, bottom: window.innerHeight - rect.top + 6, top: 'auto' }
            : { left, width, maxHeight, top: rect.bottom + 6, bottom: 'auto' });
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            anchorRef.current?.focus?.();
          }
        };
        const onPointerDown = (event) => {
          const target = event.target;
          if (anchorRef.current?.contains(target) === true) return;
          if (menuRef.current?.contains(target) === true) return;
          setOpen(false);
        };
        reposition();
        // `capture` matters: the composer's own editor listens on the document too, and Escape has
        // to close this menu before anything else reads it.
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('resize', reposition);
          window.removeEventListener('scroll', reposition, true);
        };
      }, [open]);

      const chosen = state?.selected?.machine_id ?? null;
      const machines = Array.isArray(state?.machines) ? state.machines : [];
      const machineGroups = groupTargetMachines(machines);
      // v1.5.1: the relay pool the host probed, already folded. `null` means a single-relay host.
      const relayFold = state?.relays ?? null;
      const problem = notice ?? error ?? fleetProblem(state, t);
      const disabled = typeof sessionId !== 'string' || sessionId === '';
      const label = state === null ? (provisionalLabel(state) ?? t('machine')) : labelOf(state, t);
      const selectedMachine = machines.find((machine) => machine.machine_id === chosen) ?? null;
      const selectedOnline = state === null
        ? null
        : (selectedMachine !== null ? selectedMachine.online === true : (chosen === null ? null : state?.selected?.online ?? null));
      const dot = chosen === null
        ? 'none'
        : (selectedOnline === true ? (selectedMachine?.local === true ? 'local' : 'online') : 'stale');
      const title = problem ?? (chosen === null
        ? t('costAll')
        : `${t('costOne', { name: label })}${selectedOnline === true ? '' : t('unconfirmed')}`);

      /**
       * Apply the one editor edit that mirrors a target change.
       *
       * Ordering matters: the host write happens first, so a token is never left claiming a target
       * the host refused. The edit is best effort — a composer that is submitting, or a host
       * without `inputActions`, keeps the selection and simply loses the visible handle.
       */
      const applyTargetMention = (nextName, previousName) => {
        if (inputActions === null || typeof inputActions !== 'object'
          || typeof inputActions.insertText !== 'function'
          || typeof inputActions.captureInsertion !== 'function') {
          focusComposer();
          return;
        }
        const capture = inputActions.captureInsertion();
        if (capture === null || typeof capture !== 'object') {
          focusComposer();
          return;
        }
        const current = inputRef.current ?? {};
        // `captureInsertion()` is the editor's current revision; `inputRef.current` is the last
        // published snapshot. If they disagree, the draft these offsets were computed from is not
        // the draft the editor holds, and `draftRev` would let a stale offset through.
        if (Number.isInteger(current.draftRev) && current.draftRev !== capture.draftRev) {
          focusComposer();
          return;
        }
        const plan = planTargetMention({
          draft: typeof current.draft === 'string' ? current.draft : '',
          occurrences: current.occurrences,
          caret: capture,
          nextName,
          previousName,
        });
        if (plan.kind === 'insert' || plan.kind === 'replace' || plan.kind === 'remove') {
          const text = plan.kind === 'remove' ? '' : plan.text;
          const applied = inputActions.insertText(text, {
            start: plan.start,
            end: plan.end,
            draftRev: capture.draftRev,
          });
          if (applied !== true) {
            setNotice(t('mentionFailed'));
            setOpen(true);
          } else {
            setNotice(null);
          }
        } else {
          setNotice(null);
        }
        focusComposer();
      };

      const choose = (machineId, machineName) => {
        setOpen(false);
        const previousName = selectedMachine?.name ?? state?.selected?.name ?? null;
        if (machineId === chosen) {
          // Clicking the current target restores a token the operator deleted, but never turns
          // the click into a destructive "clear" gesture: clearing is the All-machines row.
          setNotice(null);
          applyTargetMention(machineId === null ? null : previousName, null);
          return;
        }
        const seq = (writeSeq.current += 1);
        const at = sessionId;
        setBusy(true);
        writeSelection(sessionId, machineId, machineName).then((result) => {
          if (seq !== writeSeq.current) return; // a later click owns the answer
          if (at !== sessionRef.current) return; // the session changed while the write was in flight
          setBusy(false);
          if (result.ok) {
            setState(result.state);
            setError(null);
            setNotice(null);
            if (machineId === null) {
              applyTargetMention(null, previousName);
              return;
            }
            applyTargetMention(result.state?.selected?.name ?? machineName ?? null, previousName);
            return;
          }
          // The write is refused for a reason the operator can act on (the machine went away, the
          // fleet could not be read). Reopen the menu so `notice` is actually in front of them.
          setNotice(result.error);
          setOpen(true);
          setReloadSeq((reload) => reload + 1);
        });
      };

      const renderMachineOption = (machine) => h('button', {
        key: machine.machine_id ?? machine.name ?? Math.random().toString(36).slice(2),
        type: 'button',
        role: 'option',
        className: cls('option'),
        'data-active': machine.machine_id !== null && machine.machine_id === chosen ? 'true' : 'false',
        'aria-selected': machine.machine_id !== null && machine.machine_id === chosen,
        disabled: machine.online !== true,
        title: machine.online === true
          ? `${machine.name ?? machine.machine_id} — ${machine.local === true ? t('local') : t('online')}`
          : `${machine.name ?? machine.machine_id} — ${machine.state}`,
        onClick: () => choose(machine.machine_id, machine.name),
      }, h('span', { className: cls('row') }, [
        h(StatusDot, { key: 'dot', kind: dotKind(machine), title: machine.state }),
        h('span', { key: 'name', className: cls('name') }, machine.name ?? machine.machine_id ?? 'unnamed'),
        h('span', { key: 'detail', className: cls('detail') }, machine.local === true
          ? t('local')
          : (machine.online === true ? (machine.os ?? t('unknownPlatform')) : machine.state)),
      ]));

      const menu = open && placement !== null
        ? portalNode(h('div', {
            className: cls('menu'),
            role: 'listbox',
            'aria-label': t('targetLabel', { name: label }),
            ref: menuRef,
            style: {
              left: `${placement.left}px`,
              top: placement.top === 'auto' ? 'auto' : `${placement.top}px`,
              bottom: placement.bottom === undefined || placement.bottom === 'auto' ? 'auto' : `${placement.bottom}px`,
              width: `${placement.width}px`,
              maxHeight: `${placement.maxHeight}px`,
              overflowY: 'auto',
            },
          }, [
            h('button', {
              key: '__all__',
              type: 'button',
              role: 'option',
              className: cls('option'),
              'data-active': chosen === null ? 'true' : 'false',
              'aria-selected': chosen === null,
              onClick: () => choose(null, null),
              title: t('costAll'),
            }, h('span', { className: cls('row') }, [
              h(StatusDot, { key: 'dot', kind: 'none', title: t('all') }),
              h('span', { key: 'name', className: cls('name') }, t('all')),
              h('span', { key: 'detail', className: cls('detail') }, state?.fleet?.ok === true ? `${state.fleet.online} ${t('online')}` : '—'),
            ])),
            problem === null ? null : h('div', { key: '__problem__', className: cls('note'), role: 'status' }, problem),
            machines.length === 0
              ? h('div', { key: '__empty__', className: cls('note') }, problem === null ? t('empty') : t('noRoster'))
              : [
                h('div', { key: '__clientGroup__', className: cls('groupHead'), role: 'presentation' }, `${t('clientGroup')} · ${machineGroups.client.length}`),
                ...machineGroups.client.map(renderMachineOption),
                machineGroups.web.length === 0
                  ? null
                  : h('button', {
                      key: '__webToggle__',
                      type: 'button',
                      className: cls('groupToggle'),
                      'aria-expanded': webOpen,
                      'data-open': webOpen ? 'true' : 'false',
                      onClick: (event) => { event.stopPropagation(); setWebOpen((wasOpen) => !wasOpen); },
                      title: `${t('webGroup')} · ${machineGroups.web.length}`,
                    }, `${t('webGroup')} · ${machineGroups.web.length} · ${webOpen ? t('webUnfold') : t('webFold')}`),
                ...(webOpen ? machineGroups.web.map(renderMachineOption) : []),
                machineGroups.offline.length === 0
                  ? null
                  : h('button', {
                      key: '__offlineToggle__',
                      type: 'button',
                      className: cls('groupToggle'),
                      'aria-expanded': offlineOpen,
                      'data-open': offlineOpen ? 'true' : 'false',
                      onClick: (event) => { event.stopPropagation(); setOfflineOpen((wasOpen) => !wasOpen); },
                      title: `${t('offlineGroup')} · ${machineGroups.offline.length}`,
                    }, `${t('offlineGroup')} · ${machineGroups.offline.length} · ${offlineOpen ? t('webUnfold') : t('webFold')}`),
                ...(offlineOpen ? machineGroups.offline.map(renderMachineOption) : []),
              ],
            relayFold === null ? null : h('div', {
              key: '__relays__',
              className: cls('relayFold'),
              role: 'group',
              'aria-label': t('relays'),
              'data-temporary': relayFold.temporary === true ? 'true' : 'false',
            }, [
              h('button', {
                key: 'toggle',
                type: 'button',
                className: cls('relayToggle'),
                'aria-expanded': relayOpen,
                'data-temporary': relayFold.temporary === true ? 'true' : 'false',
                onClick: (event) => { event.stopPropagation(); setRelayOpen((wasOpen) => !wasOpen); },
                title: relayOpen === true ? t('relayUnfold') : t('relayFold', { count: relayFold.hidden_count }),
              }, `${t('relays')}: ${relayFold.online}/${relayFold.total} ${t('online')}${relayFold.temporary === true ? ` · ${t('relayTemporary')}` : ''}`),
              ...(relayOpen === true ? [...relayFold.shown, ...relayFold.hidden] : relayFold.shown).map((item, index) => h('div', {
                key: `relay-${index}`,
                className: cls('relayRow'),
                'data-role': item.role,
              }, [
                h('span', { key: 'role', className: cls('relayRole') }, item.role === 'primary'
                  ? t('relayPrimary')
                  : (item.role === 'standby' ? t('relayStandby') : t('relayOffline'))),
                h('span', { key: 'url', className: cls('relayUrl') }, String(item.url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')),
                h('span', { key: 'rtt', className: cls('relayRtt') }, item.rtt_ms === null || item.rtt_ms === undefined ? '—' : `${item.rtt_ms} ms`),
              ])),
                // v1.7.3: name the relay the totals came from; "whole server" and "this fleet" are different
                // numbers, and the panel used to leave the reader to guess which one it was showing.
                relayFold.server === null || relayFold.server === undefined
                  ? (relayFold.server_reachable === false
                    ? h('div', { key: 'globalUnreachable', className: cls('relayHint') }, t('globalUnreachable', { url: String(relayFold.server_url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '') || '?' }))
                    : null)
                  : h('div', { key: 'global', className: cls('relayHint') }, t('globalSummaryWithSource', {
                      source: String(relayFold.server_url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '') || '?',
                      fleetsOnline: relayFold.server.fleets_online ?? '—',
                      fleets: relayFold.server.fleets_total ?? '—',
                      online: relayFold.server.devices_online ?? '—',
                      total: relayFold.server.devices_total ?? '—',
                    })),
                h('div', { key: 'fleet', className: cls('relayHint') }, t('fleetSummary', { online: state?.fleet?.online ?? '—', total: state?.fleet?.total ?? '—' })),
              h(PluginUpdate, { key: 'update', t }),
              relayFold.hidden_count > 0 && relayOpen === false
                ? h('div', { key: 'hint', className: cls('relayHint') }, t('relayFold', { count: relayFold.hidden_count }))
                : null,
            ]),
          ]))
        : null;

      return h(React.Fragment, null, [
        h('button', {
          key: 'trigger',
          type: 'button',
          ref: anchorRef,
          className: cls('trigger'),
          'aria-label': t('targetLabel', { name: label }),
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-busy': busy,
          title,
          disabled,
          onClick: () => setOpen((wasOpen) => !wasOpen),
        }, [
          h(StatusDot, { key: 'dot', kind: dot, title: title ?? '' }),
          h('span', { key: 'label', className: cls('label') }, label),
          h('span', { key: 'chevron', className: cls('chevron'), 'data-open': open ? 'true' : 'false', 'aria-hidden': 'true' },
            h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none' },
              h('path', {
                d: 'M3 4.5L6 7.5L9 4.5',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }))),
        ]),
        menu,
      ]);
    }

    // -------------------------------------------------------------------------------------------
    // Fleet chat panel (v1.1.18 addition: the missing browser half of `w2m_chat`)
    // -------------------------------------------------------------------------------------------
    //
    // v1.1.17 shipped fleet chat as a tool only — its own CHANGELOG records "no client UI panel
    // beyond the generic tool card". This is that panel: a session-scoped broadcast board the
    // operator and the agent share. Every read and write goes through the host route
    // `/api/w2m/chat` (host-side `fleet-chat-route.mjs`), so the device token stays in the host
    // process and this file never holds a credential.
    const CHAT_ROUTE = '/api/w2m/chat';
    // v1.7.1: host fallbacks for the DSH desktop shell (renderer capture/clipboard are not granted there).
    const CAPTURE_ROUTE = '/api/w2m/capture';
    const CLIPBOARD_ROUTE = '/api/w2m/clipboard';

    /** One JSON call to the host chat route; a refusal is a value, not an exception. */
    async function chatCall(options) {
      let response;
      try {
        response = await fetch(options.url, options.init);
      } catch (error) {
        return { ok: false, error: `the plugin could not be reached: ${error instanceof Error ? error.message : String(error)}` };
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: `the plugin answered HTTP ${response.status} with a body that is not JSON` };
      }
      if (response.status === 404) return { ok: false, error: 'this host does not serve the W2M chat route' };
      if (response.ok !== true || body?.ok === false) {
        return { ok: false, error: typeof body?.error === 'string' ? body.error : `HTTP ${response.status}` };
      }
      return { ok: true, state: body };
    }

    /**
     * The fleet-chat control: opens a panel with the session's messages, a compose box and the
     * relay's current usage. The text stays on the relay; this component keeps only the last view.
     */
    const AVATAR_PALETTE = ['#4c6ef5', '#12b886', '#f59f00', '#e8590c', '#ae3ec9', '#1098ad', '#d6336c', '#5c940d'];

    /** A machine keeps its colour: the index comes from its id, not from the order of the list. */
    function avatarColor(machineId) {
      var h = 0;
      var s = String(machineId == null ? '' : machineId);
      for (var i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
    }

    /** The DeepSeek whale, filled with the machine colour. */
    function WhaleAvatar({ machineId }) {
      return h('span', { className: 'w2mChat_avatar', style: { color: avatarColor(machineId) }, 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16 },
          h('path', { fill: 'currentColor', d: 'M2 13c2.2-3.4 5.4-5 9-5 3.1 0 5.6 1.2 7.2 3.2h2.3l-1.6-2.4 1.6.9L22 6.9l.6 3.4 1.4.8-1.4.8-.6 3.4-1.5-2.8-1.6.9 1.6-2.4h-2.2C16.6 8.9 13.9 7.6 11 7.6 6.6 7.6 3.3 9.6 1 13h1Z' })));
    }

    /** session = this machine typed it into DSH; chat = typed here; remote = another machine. */
    function messageKind(message, localMachineId) {
      if (localMachineId == null || message == null || message.machine_id !== localMachineId) return 'remote';
      return message.origin === 'session' ? 'session' : 'chat';
    }

    /** v1.9.4: the fleet-chat tab in the top bar; opens the full workspace page. */
    function _FleetChatTab() {
      return h('button', {
        type: 'button',
        className: 'w2mChatTab',
        title: '编队聊天',
        onClick: () => { try { window.dispatchEvent(new CustomEvent('w2m-chat-full')); } catch { /* headless */ } },
      }, '编队聊天');
    }

    /** v1.9.4: the bottom bar: fleet and server online/total counts, always visible. */
    function FleetStatusBar() {
      const [snapshot, setSnapshot] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch('/api/w2m/target?session_id=__global__', { credentials: 'same-origin', headers: { accept: 'application/json' } });
            const body = response.ok ? await response.json() : null;
            if (alive) setSnapshot(body?.state ?? body ?? null);
          } catch {
            if (alive) setSnapshot(null);
          }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const fleet = snapshot?.fleet ?? null;
      const relays = snapshot?.relays ?? null;
      const server = relays?.server ?? null;
      // 底部状态栏的两条比例（v3.3.3 修复：之前把“全服机器”当成了“在线编队”，且读不到时整段变 —）：
      //   1) 本编队在线机器数 / 本编队所有机器总数
      //   2) 在线编队数量 / 全服编队总数
      const fleetOnline = Number.isFinite(fleet?.online) ? fleet.online : null;
      const fleetTotal = Number.isFinite(fleet?.total) ? fleet.total : null;
      const fleetText = fleetOnline !== null && fleetTotal !== null ? fleetOnline + '/' + fleetTotal : '—';
      const fleetsOnline = Number.isFinite(server?.fleets_online) ? server.fleets_online : null;
      const fleetsTotal = Number.isFinite(server?.fleets_total) ? server.fleets_total : null;
      const serverText = fleetsOnline !== null && fleetsTotal !== null ? fleetsOnline + '/' + fleetsTotal : '—';
      const devicesOnline = Number.isFinite(server?.devices_online) ? server.devices_online : null;
      const devicesTotal = Number.isFinite(server?.devices_total) ? server.devices_total : null;
      const devicesText = devicesOnline !== null && devicesTotal !== null ? devicesOnline + '/' + devicesTotal : '—';
      const relayItems = Array.isArray(relays?.shown) ? relays.shown.slice(0, 3) : [];
      const relayLabel = (index) => (['主', '备1', '备2'][index] ?? ('备' + index));
      const relayDot = (relay) => {
        if (relay?.ok !== true) return 'red';
        if (Number.isFinite(relay.rtt_ms) && relay.rtt_ms > 500) return 'yellow';
        return 'green';
      };
      const relayTitle = (relay) => {
        if (relay?.ok !== true) return (relay?.url ?? 'relay') + '：离线' + (relay?.error ? '（' + relay.error + '）' : '');
        return (relay?.url ?? 'relay') + '：在线，' + (Number.isFinite(relay?.rtt_ms) ? relay.rtt_ms + 'ms' : '延迟未知');
      };
      return h('div', { className: 'w2mFleetStatus', title: '编队、全服与 Relay 在线状态' }, [
        h('span', { key: 'f', className: 'w2mFleetStatusItem', title: '本编队在线机器 ' + fleetText + ' · 本编队所有机器 ' + (fleetTotal ?? '未知') }, [
          h('span', { key: 'label' }, '本编队在线机器 '),
          h('span', { key: 'value' }, fleetText),
        ]),
        h('span', { key: 's', className: 'w2mFleetStatusItem', title: '在线编队 ' + serverText + ' · 全服编队 ' + (fleetsTotal ?? '未知') + ' · 全服机器 ' + devicesText }, [
          h('span', { key: 'label' }, '在线编队 '),
          h('span', { key: 'value' }, serverText),
        ]),
        h('span', { key: 'r', className: 'w2mFleetStatusItem' }, [
          h('span', { key: 'label' }, '在线Relay '),
          ...(relayItems.length === 0
            ? [h('span', { key: 'none' }, '—')]
            : relayItems.map((relay, index) => h('span', { key: 'relay-' + index, className: 'w2mRelayItem', title: relayTitle(relay) }, [
                h('span', { key: 'dot', className: 'w2mRelayDot', 'data-state': relayDot(relay) }),
                h('span', { key: 'name' }, relayLabel(index)),
              ]))),
        ]),
      ]);
    }

    /* ------------------------------------------------------------------ */
    /* v2.1.0 remote-view skeleton (view-only; media not wired yet)        */
    /* ------------------------------------------------------------------ */

    const REMOTE_VIEW_KEY = 'w2m.remoteView.enabled';
    const REMOTE_CONFIG_URL = '/api/w2m/remote/config';
    const REMOTE_FRAME_URL = '/api/w2m/remote/frame';
    const readLocalFlag = () => {
      try { return window.localStorage.getItem(REMOTE_VIEW_KEY) === '1'; } catch { return false; }
    };
    const cacheFlag = (value) => { try { window.localStorage.setItem(REMOTE_VIEW_KEY, value ? '1' : '0'); } catch { /* denied */ } };
    const announceFlag = () => { try { window.dispatchEvent(new Event('w2m-remote-view-changed')); } catch { /* headless */ } };

    function useRemoteViewFlag() {
      const [enabled, setEnabledState] = React.useState(readLocalFlag);
      const [ready, setReady] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        fetch(REMOTE_CONFIG_URL, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => {
            if (!alive) return;
            const value = body?.enabled === true;
            cacheFlag(value);
            setEnabledState(value);
            setReady(true);
          })
          .catch(() => { if (alive) setReady(true); });
        const sync = () => setEnabledState(readLocalFlag());
        window.addEventListener('w2m-remote-view-changed', sync);
        window.addEventListener('storage', sync);
        return () => {
          alive = false;
          window.removeEventListener('w2m-remote-view-changed', sync);
          window.removeEventListener('storage', sync);
        };
      }, []);
      const setEnabled = (value) => {
        const next = value === true;
        cacheFlag(next);
        setEnabledState(next);
        announceFlag();
        fetch(REMOTE_CONFIG_URL, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        }).catch(() => { /* local flag remains the fallback */ });
      };
      return [enabled, setEnabled, ready];
    }

    function RemoteViewSettings() {
      const [enabled, setEnabled, ready] = useRemoteViewFlag();
      return h('div', { style: { display: 'grid', gap: '10px', padding: '4px 0' } }, [
        h('div', { key: 'title', style: { fontWeight: 600 } }, '远程桌面'),
        h('label', { key: 'toggle', style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer', opacity: ready ? 1 : 0.6 } }, [
          h('input', { key: 'box', type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }),
          h('span', { key: 'text' }, enabled ? '已开启' : '已关闭'),
        ]),
        h('div', { key: 'hint', style: { fontSize: '12px', opacity: 0.75, lineHeight: 1.5 } },
          '开启后可查看其他机器；本机也会允许编队内其他机器查看，仅画面，不发送鼠标/键盘输入。目标帧率为 1 帧/秒；实际帧率取决于目标机性能与网络。媒体优先 P2P，P2P 不通时走加密 relay 帧通道。'),
        h('div', { key: 'status', style: { fontSize: '12px', opacity: 0.6 } }, '要查看某台机器，那台机器也需要开启此开关。选择目标后点「连接」；远端画面每秒刷新一次。'),
      ]);
    }

    function RemoteViewSidebarIcon() {
      const [enabled, , ready] = useRemoteViewFlag();
      if (!ready || !enabled) return null;
      return h('span', { title: '远程桌面', style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, h('svg', {
        width: 20, height: 18, viewBox: '0 0 24 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, [
        h('rect', { key: 'screen', x: 2.5, y: 2, width: 19, height: 12, rx: 1.5 }),
        h('path', { key: 'stand', d: 'M8.5 18h7M12 14.2V18' }),
      ]));
    }

    function RemoteViewMainPage() {
      const [enabled] = useRemoteViewFlag();
      const [machines, setMachines] = React.useState([]);
      const [target, setTarget] = React.useState('');
      const [session, setSession] = React.useState(null);
      const [live, setLive] = React.useState(true);
      const [frame, setFrame] = React.useState(null);
      const [stats, setStats] = React.useState(null);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        fetch('/api/w2m/target?session_id=__global__', { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => { if (!alive) return; const list = Array.isArray(body?.machines) ? body.machines.filter((m) => m.online === true) : []; setMachines(list); if (list.length > 0) setTarget((current) => current || list[0].machine_id); })
          .catch(() => { /* roster unavailable */ });
        return () => { alive = false; };
      }, [enabled]);
      React.useEffect(() => {
        if (!enabled || !live) return undefined;
        let alive = true;
        const tick = async () => {
          try {
            const response = await fetch(REMOTE_FRAME_URL, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } });
            const body = await response.json().catch(() => null);
            if (!alive) return;
            if (body?.ok === true) { setFrame(body); setStats({ capture_ms: body.capture_ms, bytes: body.bytes, at: body.at, encrypted: body.encrypted }); setError(null); }
            else if (body?.code === 'VIEW_WAITING_FOR_FRAME') { setError(null); }
            else { setError(body?.code ?? ('HTTP ' + response.status)); }
          } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : String(failure)); }
        };
        tick();
        const timer = setInterval(tick, 1000);
        return () => { alive = false; clearInterval(timer); };
      }, [enabled, live, session]);
      const connect = async () => {
        setError(null);
        try {
          const response = await fetch('/api/w2m/remote/start', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machine_id: target }) });
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.ok !== true) { setError(body?.code ?? body?.error ?? ('HTTP ' + response.status)); return; }
          setFrame(null); setSession(body);
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
      };
      const disconnect = async () => {
        try { await fetch('/api/w2m/remote/stop', { method: 'POST', credentials: 'same-origin' }); } catch { /* best effort */ }
        setSession(null); setFrame(null); setStats(null);
      };
      const ready = enabled && frame?.data_base64;
      return h('div', { style: { padding: '16px', display: 'grid', gap: '12px', maxWidth: '1100px' } }, [
        h('div', { key: 'title', style: { fontSize: '16px', fontWeight: 600 } }, '远程桌面 · 仅查看'),
        h('div', { key: 'state', style: { fontSize: '13px', opacity: 0.8 } }, enabled ? (session ? ('远程会话：' + (session.machine_id ?? '') + (session.encrypted ? '（加密）' : '（未加密）') + ' · ' + (session.channel === 'relay' ? '加密 relay' : 'P2P')) : '未连接目标') : '插件设置中尚未开启远程桌面。'),
        h('div', { key: 'controls', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
          h('select', { key: 'target', value: target, disabled: !enabled, onChange: (event) => setTarget(event.target.value), style: { minWidth: '180px' } }, machines.length === 0 ? h('option', { value: '' }, '无在线机器') : machines.map((machine) => h('option', { key: machine.machine_id, value: machine.machine_id }, (machine.name ?? machine.machine_id)))),
          h('button', { key: 'connect', type: 'button', disabled: !enabled || target === '' || session !== null, onClick: connect }, '连接'),
          h('button', { key: 'stop', type: 'button', disabled: session === null, onClick: disconnect }, '停止'),
          h('button', { key: 'pause', type: 'button', disabled: !enabled, onClick: () => setLive((value) => !value) }, live ? '暂停' : '继续'),
        ]),
        h('div', { key: 'canvas', style: { minHeight: '320px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--dsw-alias-bg-layer-1)' } }, ready
          ? h('img', { src: 'data:' + (frame.mime ?? 'image/jpeg') + ';base64,' + frame.data_base64, alt: '远程桌面画面', style: { maxWidth: '100%', maxHeight: '70vh', display: 'block' } })
          : h('span', { style: { opacity: 0.6, fontSize: '13px' } }, !enabled ? '尚未开启' : (error ? ('查看失败：' + error) : (session ? '等待远端帧…' : '选择在线目标后点「连接」')))),
        h('div', { key: 'statusline', style: { fontSize: '12px', opacity: 0.7, display: 'flex', gap: '14px', flexWrap: 'wrap' } }, [
          h('span', { key: 'fps' }, '1 fps 上限'),
          h('span', { key: 'channel' }, '通道：' + (session ? (session.channel === 'relay' ? '加密中继' : 'P2P') : '未连接')),
          h('span', { key: 'cap' }, '采集：' + (stats?.capture_ms ?? '—') + 'ms'),
          h('span', { key: 'bytes' }, '帧：' + (stats?.bytes ?? '—') + 'B'),
          h('span', { key: 'age' }, '最近帧：' + (stats?.at ?? '—')),
        ]),
      ]);
    }

    // -------------------------------------------------------------------------------------------
    // 备份&还原面板（v3.4.9）
    // -------------------------------------------------------------------------------------------
    //
    // 面板只调用宿主已有的备份路由：`src/plugin/backup.mjs` 的 run / verify / archive / restore /
    // unlock（这些路由只在 dsh-backup 行挂载时存在），再加上只读状态：v3.4.9 的宿主把
    // `buildStatus` 的结果直接挂在 run 的 GET 上（`status` 字段，省一次往返），更老的宿主没有这个
    // 字段，面板回退到常驻的 `/api/w2m/backup/status`（`src/backup/routes.mjs`，只在插件根挂载）。
    //
    // 三条硬规则写进代码而不是只写注释：① 每个写操作都必须带宿主的确认令牌；② 还原先取计划
    // （不带 apply）并在页面上等用户二次确认，才发 apply:true；③ 密码永远不进 HTTP —— 面板只用
    // 本机信封，密码路径是本机终端里的 `w2m-backup unlock --check --password-stdin`，所以这里
    // 没有也不会有密码输入框。
    const BACKUP_STATUS_ROUTE = '/api/w2m/backup/status';
    const BACKUP_RUN_ROUTE = '/api/w2m/backup/run';
    const BACKUP_VERIFY_ROUTE = '/api/w2m/backup/verify';
    const BACKUP_ARCHIVE_ROUTE = '/api/w2m/backup/archive';
    const BACKUP_RESTORE_ROUTE = '/api/w2m/backup/restore';
    const BACKUP_UNLOCK_ROUTE = '/api/w2m/backup/unlock';
    /** 宿内注册表修复路由（v3.5.x）：POST {confirm:'register', session_ids}，宿主内规划+写入+有界监视。 */
    const BACKUP_REGISTER_ROUTE = '/api/w2m/backup/register';
    /**
     * 旧版本占用提醒的确认路由（v3.5.0 §24.3）：POST {confirm:'ack'}。
     *
     * `old/` 按决定**不设总量上限**；这个路由只把确认水位移到「现在的字节数」并清掉待处理提醒，
     * **不删除任何文件**。面板没有删除按钮，清理只在终端用 `w2m-backup gc`（见「如何清理」指引）。
     */
    const BACKUP_OLD_USAGE_ACK_ROUTE = '/api/w2m/backup/old-usage/ack';
    const BACKUP_OLD_USAGE_ACK_TOKEN = 'ack';
    /**
     * 只读会话扫描路由（插件根常驻，v3.4.6 起存在；与 dsh-backup 子插件行无关）。`detail=1` 才会
     * 带上 `sessions` 明细（不带时只有 totals/registry 汇总），面板的勾选列表要的就是这份明细。
     */
    const BACKUP_SCAN_ROUTE = '/api/w2m/backup/scan';
    const BACKUP_SCAN_QUERY = '?detail=1';
    /** 面板挂载期间的刷新间隔；只在这个页面的生命周期内存在，卸载即 clearInterval。 */
    const BACKUP_POLL_MS = 10_000;
    /** 运行日志只保留最近多少条（内存内，刷新页面即清空，不落盘）。 */
    const BACKUP_MAX_LOG = 50;
    /**
     * 稳定错误码清单 → 文案键。宿主拒绝时给的是 code（见 src/backup/*.mjs 的 *_CODES），面板负责
     * 把它变成可操作的一句话；未知代码原样显示，绝不猜测含义。
     */
    const BACKUP_REASON_CODES = Object.freeze([
      'BACKUP_NO_PERMISSION',
      'BACKUP_ACCOUNT_MISMATCH',
      'BACKUP_ROUTE_MISSING',
      'BACKUP_UNREACHABLE',
      'BACKUP_BAD_RESPONSE',
      'BACKUP_BUSY',
      'BACKUP_LOCKED',
      'BACKUP_REPO_NOT_INITIALIZED',
      'BACKUP_REPO_SNAPSHOT_MISSING',
      'BACKUP_KEY_UNWRAP_FAILED',
      'BACKUP_SCOPE_INVALID',
      'BACKUP_SCOPED_NOTHING',
      'BACKUP_WRITE_FAILED',
      'BACKUP_DISK_FULL',
      'BACKUP_DIR_DENIED',
      'BACKUP_SCAN_HOME_MISSING',
      'BACKUP_RESTORE_NO_SESSION',
      'BACKUP_CANDIDATE_INVALID',
      'BACKUP_RESTORE_TARGET_CHANGED',
      'BACKUP_REGISTRY_WRITE_FAILED',
      'BACKUP_REGISTER_NO_SESSION',
      'BACKUP_REGISTER_SESSION_MISSING',
      'BACKUP_REGISTER_BACKUP_FAILED',
      'BACKUP_VERIFY_BUSY',
      'BACKUP_ATTACHMENT_CONFLICT',
      'BACKUP_RESTORE_VERIFY_FAILED',
      'BACKUP_ARCHIVE_EMPTY',
      'BACKUP_ARCHIVE_UNREADABLE',
      'BACKUP_MANIFEST_DIGEST_MISMATCH',
      'BACKUP_OBJECT_MISSING',
      'BACKUP_DECRYPT_AUTH_FAILED',
      'BACKUP_INDEX_MISMATCH',
      'BACKUP_REPO_SNAPSHOT_INVALID',
      'BACKUP_FUTURE_APPEND_FAILED',
      'BACKUP_RUNTIME_APPEND_FAILED',
      'BACKUP_RUNTIME_UNAVAILABLE',
      'BACKUP_RUNTIME_REJECTED',
      'BACKUP_CONFIRM_REQUIRED',
      'BACKUP_CONFIG_INVALID',
      'BACKUP_FULL_COPY_APPROVAL_REQUIRED',
      'BACKUP_FAILED',
    ]);
    const BACKUP_REASON_KEYS = Object.freeze(Object.fromEntries(
      BACKUP_REASON_CODES.map((code) => [code, 'panel.backup.reason.' + code]),
    ));
    const BACKUP_CONFLICT_KEYS = Object.freeze({
      new: 'panel.backup.conflict.new',
      identical: 'panel.backup.conflict.identical',
      differs: 'panel.backup.conflict.differs',
    });
    const BACKUP_ACTION_KEYS = Object.freeze({
      run: 'panel.backup.log.run',
      plan: 'panel.backup.log.plan',
      restore: 'panel.backup.log.restore',
      archive: 'panel.backup.log.archive',
      verify: 'panel.backup.log.verify',
      unlock: 'panel.backup.log.unlock',
      'backup-selected': 'panel.backup.log.backupSelected',
      'backup-active': 'panel.backup.log.backupActive',
      'verify-runtime': 'panel.backup.log.verifyRuntime',
      'repair-register': 'panel.backup.log.repairRegister',
      'ack-old-usage': 'panel.backup.log.ackOldUsage',
    });
    /**
     * 忙碌态 token → 文案键。两个新范围入口的 token 带连字符，直接拼 `panel.backup.busy.<token>`
     * 会得到没有对应键的名字；旧 token（run/restore/…）继续走同一个拼接规则，所以标签不会说谎。
     */
    const BACKUP_BUSY_KEYS = Object.freeze({
      'backup-selected': 'panel.backup.busy.backupSelected',
      'backup-active': 'panel.backup.busy.backupActive',
      'verify-runtime': 'panel.backup.busy.verifyRuntime',
      'repair-register': 'panel.backup.busy.repairRegister',
      'old-usage-ack': 'panel.backup.busy.oldUsageAck',
    });

    /**
     * 一次备份路由调用，折成一个值：连接失败、HTTP 拒绝和引擎拒绝（200 + `ok:false`）都返回
     * `{ok:false, reason_code, detail}`，从不抛异常。
     *
     * `http` 和 `ok` 分开：只读的 describe 路由（status / unlock GET）即使报告 `ok:false`（仓库未
     * 初始化、盘符不存在）也仍然带一份有用的状态，面板要能渲染它；写操作才用 `ok` 判断成败。
     * 404 单独标记 `routeMissing`，让页面区分“这个宿主没有挂载备份子插件”和“操作被拒绝”。
     */
    async function callBackup(url, init) {
      const request = {
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...init,
      };
      let response;
      try {
        response = await fetch(url, request);
      } catch (error) {
        return { ok: false, http: false, status: 0, reason_code: 'BACKUP_UNREACHABLE', detail: error instanceof Error ? error.message : String(error) };
      }
      if (response.status === 404) {
        return { ok: false, http: false, status: 404, routeMissing: true, reason_code: 'BACKUP_ROUTE_MISSING', detail: null };
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (body === null || typeof body !== 'object') {
        return { ok: false, http: response.ok === true, status: response.status, reason_code: 'BACKUP_BAD_RESPONSE', detail: 'HTTP ' + response.status };
      }
      if (response.ok !== true) {
        return {
          ok: false,
          http: false,
          status: response.status,
          reason_code: body.reason_code ?? 'BACKUP_FAILED',
          detail: body.detail ?? body.error ?? ('HTTP ' + response.status),
          body,
        };
      }
      return {
        ok: body.ok !== false,
        http: true,
        status: response.status,
        body,
        reason_code: body.reason_code ?? null,
        detail: body.detail ?? null,
      };
    }

    /** reason code → 操作者能读懂的一句话；未知代码原样返回（稳定代码比猜出来的句子有用）。 */
    function backupReasonText(code, t) {
      const value = typeof code === 'string' ? code : '';
      if (value === '') return '';
      const key = BACKUP_REASON_KEYS[value];
      if (key === undefined) return value;
      const text = t(key);
      return typeof text === 'string' && text !== '' ? text : value;
    }

    /**
     * `GET /api/w2m/backup/scan?detail=1` → 面板要的三个字段，防御式归一化，从不抛异常。
     *
     * 路由缺失（404）、传输失败、`ok:false`、`sessions` 不是数组都由调用方折成
     * `{available:false}`：面板据此显示中性提示 + 重试，绝不把一次读失败变成异常或空面板。
     * 会话行只保留 `session_id`/`workspace`/`size`/`archived`；`flags` 可能是任意形状。
     *
     * @param {{ok?: boolean, status?: number, http?: boolean, routeMissing?: boolean, body?: object|null}} [result]
     * @returns {{available: boolean, sessions: Array<{session_id: string, workspace: string, size: number|null, archived: boolean, registered: boolean}>, total: number, routeMissing: boolean}}
     */
    function normalizeBackupScan(result) {
      const body = result?.body !== null && typeof result?.body === 'object' ? result.body : null;
      const rows = Array.isArray(body?.sessions) ? body.sessions : null;
      const available = result?.ok === true && body !== null && rows !== null;
      const sessions = available
        ? rows
            .filter((row) => row !== null && typeof row === 'object' && typeof row.session_id === 'string' && row.session_id !== '')
            .map((row) => ({
              session_id: row.session_id,
              workspace: typeof row.workspace === 'string' ? row.workspace : '',
              size: row.size === null || row.size === undefined
                ? null
                : (Number.isFinite(Number(row.size)) ? Number(row.size) : null),
              archived: row?.flags?.archived === true,
              registered: row?.flags?.registered === true,
            }))
        : [];
      const reported = Number(body?.totals?.sessions);
      return {
        available,
        sessions,
        total: available && Number.isFinite(reported) ? reported : sessions.length,
        routeMissing: result?.routeMissing === true,
      };
    }

    /** 忙碌态 token → 译文；未知 token 原样拼键（与旧行为一致）。 */
    function backupBusyText(busy, t) {
      const token = String(busy ?? '');
      if (token === '') return '';
      const key = BACKUP_BUSY_KEYS[token];
      return t(key ?? ('panel.backup.busy.' + token));
    }

    /** 会话 id 的短后缀（列表只显示后缀，完整 id 放在 title 里）；短 id 原样显示。 */
    function backupSessionSuffix(sessionId) {
      const value = String(sessionId ?? '');
      return value.length > 18 ? '…' + value.slice(-16) : value;
    }

    /** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；解析不了的值原样显示，不抛异常。 */
    function backupTimeText(value) {
      if (typeof value !== 'string' || value === '') return '—';
      const at = new Date(value);
      if (Number.isNaN(at.getTime())) return value;
      const pad = (part) => String(part).padStart(2, '0');
      return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes());
    }

    /** 字节数 → 人读的 KiB/MiB/GiB；未知值显示 —。 */
    function backupBytesText(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1024) return Math.round(bytes) + ' B';
      const units = ['KiB', 'MiB', 'GiB', 'TiB'];
      let size = bytes / 1024;
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      return (size >= 10 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[unit];
    }

    /** 毫秒 → `4.8 s` / `320 ms`。 */
    function backupDurationText(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) return '—';
      if (ms < 1000) return Math.round(ms) + ' ms';
      const seconds = ms / 1000;
      return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + ' s';
    }

    /** 一次操作 → 一条日志：时间、动作、结果码、细节。视图倒序渲染。 */
    function backupLogEntry(action, result) {
      const ok = result?.ok === true;
      return {
        at: new Date().toISOString(),
        action: String(action ?? 'run'),
        ok,
        code: ok ? 'OK' : String(result?.reason_code ?? 'BACKUP_FAILED'),
        detail: typeof result?.detail === 'string' && result.detail !== '' ? result.detail : null,
      };
    }

    /** 有界追加：内存日志最多 BACKUP_MAX_LOG 条，页面关掉就没了（不落盘、不上报）。 */
    function appendBackupLog(entries, entry) {
      const list = Array.isArray(entries) ? entries : [];
      if (entry === null || typeof entry !== 'object') return list.slice(-BACKUP_MAX_LOG);
      return [...list, entry].slice(-BACKUP_MAX_LOG);
    }

    /** 冲突分类 → 文案；未知分类原样显示。 */
    function backupConflictText(conflict, t) {
      const key = BACKUP_CONFLICT_KEYS[String(conflict ?? '')];
      return key === undefined ? String(conflict ?? '—') : t(key);
    }

    /** 日志里的动作 → 文案。 */
    function backupActionText(action, t) {
      const key = BACKUP_ACTION_KEYS[String(action ?? '')];
      return key === undefined ? String(action ?? '') : t(key);
    }

    /** 上一次运行结果的摘要（状态条用）：快照 id、会话/文件数、耗时。 */
    function backupResultSummary(result, t) {
      if (result === null || typeof result !== 'object') return '';
      return t('panel.backup.status.runResult', {
        snapshot: String(result.snapshot_id ?? '—'),
        sessions: Number(result.sessions) || 0,
        files: Number(result.files) || 0,
        duration: backupDurationText(result.duration_ms),
      });
    }

    /** 上一次操作的结果卡：成功给摘要，失败给错误码 + detail。 */
    function backupLastActionText(lastAction, t) {
      if (lastAction === null || typeof lastAction !== 'object') return '';
      const result = lastAction.result ?? null;
      if (result?.ok !== true) {
        const reason = backupReasonText(result?.reason_code, t);
        const detail = typeof result?.detail === 'string' && result.detail !== '' ? ' · ' + result.detail : '';
        return t('panel.backup.error.title') + '：' + (reason === '' ? '—' : reason) + detail;
      }
      const body = result.body ?? {};
      // v3.5.0 §24.3: acknowledging is not a cleanup, and the result card says exactly that.
      if (lastAction.action === 'ack-old-usage') return t('panel.backup.oldUsage.ackDone');
      // 两个范围入口共用 run 的结果形状（同一个宿主路由、同一份 engine 结果），所以共用摘要文案。
      if (lastAction.action === 'run' || lastAction.action === 'backup-selected' || lastAction.action === 'backup-active') {
        return t('panel.backup.run.done', {
          snapshot: String(body.snapshot_id ?? '—'),
          sessions: Number(body.sessions) || 0,
          blocksNew: Number(body.blocks_new) || 0,
          blocksReused: Number(body.blocks_reused) || 0,
          duration: backupDurationText(body.duration_ms),
        });
      }
      if (lastAction.action === 'archive') {
        return t('panel.backup.archive.done', {
          file: String(body.file ?? '—'),
          sessions: Number(body.sessions) || 0,
          bytes: backupBytesText(body.bytes),
          compressed: backupBytesText(body.compressed_bytes),
        });
      }
      if (lastAction.action === 'restore') {
        const restored = Array.isArray(body.restored) ? body.restored.length : 0;
        return t('panel.backup.restore.done', {
          restored,
          skipped: Number(body.skipped) || 0,
          bytes: backupBytesText(body.bytes_written),
          pre: String(body.pre_restore_dir ?? '—'),
        });
      }
      if (lastAction.action === 'unlock') return t('panel.backup.unlock.done', { via: String(body.via ?? '—') });
      return '';
    }

    // -----------------------------------------------------------------------------------------
    // v3.5.0 old-format full whole-file copy cap (「特批」 approval)
    // -----------------------------------------------------------------------------------------
    // The engine refuses a `full` run BEFORE writing when a session file that would become an old version is
    // larger than the configured cap (`BACKUP_FULL_COPY_APPROVAL_REQUIRED`). The panel's job is to make that a
    // named *pending* state with an explicit human action: a dialog that lists the sessions and re-posts the SAME
    // run with `allowLargeFullCopy: true`. Nothing here ever approves on its own; a scheduled run (which has no
    // person) only produces this state -- the timer is never blocked waiting for a prompt.
    const BACKUP_FULL_COPY_APPROVAL_CODE = 'BACKUP_FULL_COPY_APPROVAL_REQUIRED';

    /** bytes -> MB text: the default 300 MiB cap reads `300`, a fractional cap keeps two decimals. */
    function backupMbText(bytes) {
      const mb = Number(bytes) / (1024 * 1024);
      if (!Number.isFinite(mb) || mb <= 0) return '0';
      return Number.isInteger(mb) ? String(mb) : mb.toFixed(2).replace(/\.?0+$/, '');
    }

    /** The cap in MB: the engine's bytes when known, then the row's configured MB, then the documented default. */
    function backupApprovalCapText(approval) {
      const capBytes = Number(approval?.cap_bytes);
      if (Number.isFinite(capBytes) && capBytes > 0) return backupMbText(capBytes);
      const configured = Number(approval?.full_copy_max_mb);
      if (Number.isFinite(configured) && configured > 0) return String(configured);
      return '300';
    }

    /** Normalize oversized-session rows for the dialog; unknown values stay null instead of being invented. */
    function backupApprovalSessionRows(list) {
      const rows = Array.isArray(list) ? list : [];
      return rows
        .filter((row) => row !== null && typeof row === 'object')
        .slice(0, 20)
        .map((row, index) => ({
          key: 'approval:' + index,
          session_id: typeof row.session_id === 'string' ? row.session_id : String(row.session_id ?? ''),
          rel: typeof row.rel === 'string' ? row.rel : '',
          size: Number.isFinite(Number(row.size)) ? Number(row.size) : null,
          cap: Number.isFinite(Number(row.cap)) ? Number(row.cap) : null,
        }));
    }

    /**
     * One normalized approval descriptor from either source.
     *
     * Both the engine's refusal body and the host's persisted `state.last_result` carry the same additive fields
     * (`over_cap_count`, `cap_bytes`, `full_copy_oversized`); this is the one place they are folded into the shape
     * the dialog and the pending banner render, so the manual path and the scheduled path cannot disagree.
     */
    function normalizeBackupApproval(source, scope, selected) {
      const rows = backupApprovalSessionRows(source?.full_copy_oversized ?? source?.sessions);
      const overCount = Number(source?.over_cap_count);
      return {
        reason_code: BACKUP_FULL_COPY_APPROVAL_CODE,
        detail: typeof source?.detail === 'string' && source.detail !== '' ? source.detail : null,
        over_cap_count: Number.isFinite(overCount) && overCount >= 0 ? overCount : rows.length,
        cap_bytes: Number.isFinite(Number(source?.cap_bytes)) ? Number(source.cap_bytes) : null,
        full_copy_max_mb: Number.isFinite(Number(source?.full_copy_max_mb)) ? Number(source.full_copy_max_mb) : null,
        sessions: rows,
        scope: scope === 'selected' || scope === 'active' ? scope : 'all',
        selected: Array.isArray(selected) ? selected.map(String) : [],
        source: source?.reason === 'scheduled' ? 'scheduled' : 'pending',
      };
    }

    /** The pending approval a RUN RESPONSE carries, or null when the run was not a full-copy cap refusal. */
    function backupApprovalRequest(payload, scope, selected) {
      const body = payload?.body !== null && typeof payload?.body === 'object' ? payload.body : payload;
      if (body === null || typeof body !== 'object' || body.reason_code !== BACKUP_FULL_COPY_APPROVAL_CODE) return null;
      return normalizeBackupApproval(body, scope, selected);
    }

    /** The pending approval a STATUS payload carries (`state.last_result.full_copy_approval_required`), or null. */
    function backupPendingApproval(payload) {
      const state = payload !== null && typeof payload === 'object' && payload.state !== null && typeof payload.state === 'object'
        ? payload.state
        : payload;
      const last = state !== null && typeof state === 'object' ? state.last_result : null;
      if (last === null || typeof last !== 'object' || last.full_copy_approval_required !== true) return null;
      return normalizeBackupApproval(
        { ...last, full_copy_oversized: Array.isArray(last.full_copy_oversized) ? last.full_copy_oversized : [] },
        typeof last.scope === 'string' ? last.scope : 'all',
        Array.isArray(last.selected) ? last.selected : [],
      );
    }

    // -----------------------------------------------------------------------------------------
    // v3.5.0 §24.3 old/ usage reminder: no total cap, per-growth-since-acknowledgement reminder
    // -----------------------------------------------------------------------------------------
    // `old/` is never capped by this panel or by the engine. The host persists `state.old_usage = {due, bytes,
    // files, ack_bytes, reminder_bytes, at}` after every successful run; the banner below is derived from it. The
    // 「知道了」 action posts the ack route (moving the mark to the bytes measured now) and the panel has NO delete
    // action -- cleanup is the terminal's `w2m-backup gc`, which 「如何清理」 only explains.

    /** bytes -> GB text: `10` for 10 GiB, `10.5` otherwise; an unknown value reads `0` (never NaN). */
    function backupOldUsageGbText(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '0';
      const gib = value / (1024 * 1024 * 1024);
      return Number.isInteger(gib) ? String(gib) : gib.toFixed(1);
    }

    /** A non-negative number, or 0 (the banner must never print NaN because a host field was missing). */
    function backupNonNegative(value) {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : 0;
    }

    /**
     * The pending `old/` usage reminder a describe/status payload carries, or null.
     *
     * `state.old_usage` is the persisted record (preferred); `state.last_result.old_usage` is the engine's report of
     * the last run and is used as a fallback for a host that has not persisted the record yet. Only `due: true`
     * renders the banner -- an acknowledged or below-threshold tree stays quiet. The growth shown is
     * `bytes - ack_bytes`; when the ack field is absent the engine's own `since_last_ack_bytes` is used instead.
     *
     * @param {object|null} payload the run GET / status payload (or its `state` object)
     * @returns {{bytes: number, files: number, ack_bytes: number, reminder_bytes: number, growth_bytes: number,
     *   at: string|null}|null}
     */
    function backupPendingOldUsage(payload) {
      const state = payload !== null && typeof payload === 'object' && payload.state !== null && typeof payload.state === 'object'
        ? payload.state
        : payload;
      if (state === null || typeof state !== 'object') return null;
      const last = state.last_result !== null && typeof state.last_result === 'object' ? state.last_result : null;
      const persisted = state.old_usage !== null && typeof state.old_usage === 'object' ? state.old_usage : null;
      const source = persisted ?? (last !== null && last.old_usage !== null && typeof last.old_usage === 'object' ? last.old_usage : null);
      if (source === null || source.due !== true) return null;
      // A host that says `reminder_bytes: 0` has reminders off; a stale `due: true` next to it is not a reminder.
      if (source.reminder_bytes !== undefined && backupNonNegative(source.reminder_bytes) === 0) return null;
      const bytes = backupNonNegative(source.bytes);
      const hasAck = Number.isFinite(Number(source.ack_bytes));
      const ack = hasAck ? backupNonNegative(source.ack_bytes) : 0;
      return {
        bytes,
        files: backupNonNegative(source.files),
        ack_bytes: ack,
        reminder_bytes: backupNonNegative(source.reminder_bytes),
        growth_bytes: hasAck ? Math.max(0, bytes - ack) : Math.max(0, backupNonNegative(source.since_last_ack_bytes)),
        at: typeof source.at === 'string' ? source.at : null,
      };
    }

    /** v3.5.x 解锁对话框的终端命令：只用于展示/复制，面板从不执行它们（密码/PIN 也永远不进浏览器）。 */
    const BACKUP_UNLOCK_COMMAND = 'w2m-backup unlock --check --password-stdin';
    const BACKUP_DISABLE_PROTECTION_COMMAND = 'w2m-backup unlock --disable-protection --confirm disable-protection';
    /** PIN 轮换命令：用户撤销"不轮换"决定后存在，但只在终端运行；文本里的 pin 提示词由操作者自己替换。 */
    const BACKUP_ROTATE_COMMAND = 'w2m-backup unlock --rotate-password --hint "…"';
    /** 对话框里可聚焦的控件选择器：带 tabindex=-1 的容器不算，disabled 交给下面的循环再过滤一次。 */
    const BACKUP_DIALOG_FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    /**
     * 焦点进入对话框：给第一个可用（未 disabled、aria-disabled 不为 true）的控件；一个都没有时给
     * 对话框容器本身（容器带 tabIndex=-1）。返回是否真的移动了焦点。
     *
     * 不读全局、不抛异常：bundle 测试可以直接拿一个假 panel 验证“第一个可用控件”的语义，真实页面
     * 里由对话框的 effect 用 ref 调它。
     *
     * @param {object|null} panel - 对话框容器（或任何带 querySelectorAll/focus 的对象）。
     * @returns {boolean}
     */
    function focusBackupDialogFirst(panel) {
      if (panel === null || panel === undefined || typeof panel !== 'object') return false;
      let nodes = [];
      try {
        nodes = typeof panel.querySelectorAll === 'function' ? Array.from(panel.querySelectorAll(BACKUP_DIALOG_FOCUSABLE)) : [];
      } catch {
        nodes = [];
      }
      for (const node of nodes) {
        if (node === null || node === undefined || typeof node !== 'object') continue;
        if (node.disabled === true) continue;
        if (typeof node.getAttribute === 'function' && node.getAttribute('aria-disabled') === 'true') continue;
        if (typeof node.focus !== 'function') continue;
        try {
          node.focus();
          return true;
        } catch {
          // 一个拒绝 focus 的控件不能挡住整个对话框，继续找下一个。
        }
      }
      if (typeof panel.focus !== 'function') return false;
      try {
        panel.focus();
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 解锁 describe → 对话框标题下的五态标签。
     *
     * 只有宿主明确说 `encryption` 是 none/sealed 才定性；sealed 下按账户绑定三态分：
     * 未绑 → unbound，一致 → account-matched，不一致 → account-mismatch，读不到 matched → unknown。
     * 读不到 describe（面板还没拿到/路由缺失）同样是 unknown——面板不猜凭据是否可用。
     *
     * @param {object|null} unlock - `GET /api/w2m/backup/unlock` 的 body，或 null。
     * @returns {'none'|'account-matched'|'account-mismatch'|'unbound'|'unknown'}
     */
    function backupUnlockStateKey(unlock) {
      const payload = unlock !== null && typeof unlock === 'object' ? unlock : null;
      if (payload === null) return 'unknown';
      if (payload.encryption === 'none') return 'none';
      if (payload.encryption !== 'sealed') return 'unknown';
      const account = payload.account !== null && typeof payload.account === 'object' ? payload.account : null;
      if (account === null || account.bound !== true) return 'unbound';
      if (account.matched === true) return 'account-matched';
      if (account.matched === false) return 'account-mismatch';
      return 'unknown';
    }

    /** 本机/原账户路径是否可用：未加密、本机信封可用、或账户比对一致；其余情况交给终端密码路径。 */
    function backupUnlockLocalAvailable(unlock) {
      const payload = unlock !== null && typeof unlock === 'object' ? unlock : null;
      if (payload === null) return false;
      if (payload.encryption === 'none') return true;
      if (payload.machine_available === true) return true;
      return payload.account !== null && typeof payload.account === 'object'
        && payload.account.bound === true && payload.account.matched === true;
    }

    /** 五态标签 → 字典后缀（数据属性用连字符，字典键用驼峰，和既有键名风格一致）。 */
    function backupUnlockStateSuffix(state) {
      if (state === 'account-matched') return 'accountMatched';
      if (state === 'account-mismatch') return 'accountMismatch';
      return state;
    }

    /**
     * v3.5.x 解锁对话框：真正的模态，也是卡片的动作面。
     *
     * 卡片保留只读说明与既有按钮（旧行为不变）；这个对话框把两条路径讲清楚：
     *   * 选项 A「用本机/原账户解锁」：只 `POST /unlock {confirm:'unlock'}`，凭据留在宿主；
     *     路径不可用时按钮禁用，失败文案走 {@link backupReasonText}。
     *   * 选项 B「使用解锁密码（在终端输入）」：浏览器里没有密码输入框，只显示可复制的
     *     `w2m-backup unlock --check --password-stdin` 和「我已运行，刷新状态」（重新 GET describe）。
     *   * 选项 B 同时显示公开的"备注提示词"（describe 的 `password_hint`，`data-w2m-backup-unlock-hint`）：
     *     它按设计是仓库里的明文元数据，所以可以显示；PIN 本身永不进入浏览器。没有 PIN 时显示「未设置密码」。
     *   * 用户撤销了"不提供 PIN 轮换"的决定：选项 B 另给一条可复制的轮换命令
     *     （`w2m-backup unlock --rotate-password --hint "…"`，`data-w2m-backup-unlock-rotate-command`）和一句
     *     说明（`data-w2m-backup-unlock-rotation`）：轮换在终端运行（旧凭据解开 → 去掉旧 PIN → 写新 PIN，
     *     旧 PIN 随后失效）。面板仍然没有任何密码输入，也不新增接收密码的 HTTP 端点。
     *
     * 关闭路径：×、Esc、点遮罩。打开时焦点进入第一个可用控件，关闭后回到触发按钮；不锁 body 滚动。
     * 状态全部来自面板已经取到的 describe，点刷新才重新读，不自行推断凭据可用性。
     *
     * @param {object} properties
     */
    function BackupUnlockDialog(properties) {
      const {
        t: providedT,
        open = false,
        unlock = null,
        busy = '',
        runMissing = false,
        triggerRef = null,
        onClose = () => {},
        onConfirm = async () => null,
        onRefresh = async () => {},
      } = properties ?? {};
      const t = typeof providedT === 'function' ? providedT : makeTranslator(() => undefined);
      const panelRef = React.useRef(null);
      const closeRef = React.useRef(onClose);
      // 回调每次渲染都是新函数：放进 ref，Esc effect 才不会因为父组件重渲染而反复挂/摘监听。
      closeRef.current = typeof onClose === 'function' ? onClose : () => {};
      const wasOpenRef = React.useRef(false);
      const previousActiveRef = React.useRef(null);
      const [copied, setCopied] = React.useState(false);
      const [copiedRotate, setCopiedRotate] = React.useState(false);
      const [refreshing, setRefreshing] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const close = () => {
        setResult(null);
        setCopied(false);
        setCopiedRotate(false);
        closeRef.current();
      };
      React.useEffect(() => {
        const doc = typeof document === 'undefined' ? null : document;
        if (open !== true) {
          // 关闭是状态变化而不是卸载，所以焦点恢复放在这里显式做一次（卸载时不做，页面已经走了）。
          if (wasOpenRef.current !== true) return undefined;
          wasOpenRef.current = false;
          const trigger = triggerRef !== null && triggerRef !== undefined ? triggerRef.current : null;
          const fallbackActive = previousActiveRef.current;
          previousActiveRef.current = null;
          const target = trigger !== null && trigger !== undefined && typeof trigger.focus === 'function'
            ? trigger
            : (fallbackActive !== null && fallbackActive !== undefined && typeof fallbackActive.focus === 'function' ? fallbackActive : null);
          if (target === null) return undefined;
          try {
            target.focus();
          } catch {
            // 焦点恢复是便利，不是对话框的成败：触发器已经不在页面上时安静放弃。
          }
          return undefined;
        }
        const firstOpen = wasOpenRef.current !== true;
        wasOpenRef.current = true;
        if (firstOpen) {
          // 从“关”到“开”时清掉上一轮的复制/结果反馈，等价于重新挂载；只在状态真的变化时 setState。
          setCopied(false);
          setCopiedRotate(false);
          setResult(null);
        }
        previousActiveRef.current = doc !== null && typeof doc.activeElement === 'object' ? doc.activeElement : null;
        focusBackupDialogFirst(panelRef.current);
        const onKeyDown = (event) => {
          if (event?.key !== 'Escape') return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          closeRef.current();
        };
        if (doc !== null && typeof doc.addEventListener === 'function') doc.addEventListener('keydown', onKeyDown);
        return () => {
          if (doc !== null && typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKeyDown);
        };
      }, [open, triggerRef]);
      if (open !== true) return null;

      const state = backupUnlockStateKey(unlock);
      const stateSuffix = backupUnlockStateSuffix(state);
      const localAvailable = backupUnlockLocalAvailable(unlock);
      const unencrypted = unlock !== null && typeof unlock === 'object' && unlock.encryption === 'none';
      // 公开的"备注提示词"（`password_hint: {set, text}`，来自 describe）。它按设计就是明文元数据，随仓库
      // keys.json 保存，因此原样显示给操作者；PIN 本身永远不进浏览器，这里显示的只是提示。
      const passwordHint = unlock !== null && typeof unlock === 'object' ? unlock.password_hint : null;
      const hintText = passwordHint !== null && typeof passwordHint === 'object'
        && passwordHint.set === true && typeof passwordHint.text === 'string' && passwordHint.text !== ''
        ? passwordHint.text
        : null;
      const passwordConfigured = unlock !== null && typeof unlock === 'object' && unlock.password_required === true;
      const copyCommand = async () => {
        const written = await copyFleetGuidance(BACKUP_UNLOCK_COMMAND);
        if (written === true) setCopied(true);
      };
      // 轮换命令只复制（命令里的 `…` 是提示词占位符，由操作者在终端替换）；面板从不运行它，也不接收密码。
      const copyRotateCommand = async () => {
        const written = await copyFleetGuidance(BACKUP_ROTATE_COMMAND);
        if (written === true) setCopiedRotate(true);
      };
      const refreshState = async () => {
        if (refreshing === true) return;
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      };
      const confirmLocal = async () => {
        if (busy === 'unlock') return;
        setResult(null);
        let outcome = null;
        try {
          outcome = await onConfirm();
        } catch (error) {
          outcome = { ok: false, reason_code: null, detail: error instanceof Error ? error.message : String(error) };
        }
        if (outcome === null || outcome === undefined) return;
        if (outcome.ok === true) {
          setResult({ ok: true, text: t('panel.backup.unlock.dialog.success', { via: String(outcome.body?.via ?? '—') }) });
          return;
        }
        const reason = backupReasonText(outcome.reason_code, t) || t('panel.backup.reason.BACKUP_FAILED');
        const detail = typeof outcome.detail === 'string' && outcome.detail !== '' ? ' · ' + outcome.detail : '';
        setResult({ ok: false, text: t('panel.backup.unlock.dialog.failed', { reason: reason + detail }) });
      };

      return h('div', {
        className: 'w2mBackup_unlockOverlay',
        'data-w2m-backup-unlock-overlay': 'true',
        onClick: (event) => {
          // 只有点在遮罩本身才关闭；对话框内部的事件会冒泡到这里，但 target !== currentTarget。
          if (event !== null && event !== undefined && event.target === event.currentTarget) close();
        },
      }, h('div', {
        key: 'dialog',
        className: 'w2mBackup_unlockDialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'w2m-backup-unlock-dialog-title',
        'data-w2m-backup-unlock-dialog': 'true',
        'data-w2m-backup-unlock-dialog-state': state,
        tabIndex: -1,
        ref: panelRef,
        onClick: (event) => {
          if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation();
        },
      }, [
        h('div', { key: 'head', className: 'w2mBackup_unlockHead' }, [
          h('div', { key: 'titles', className: 'w2mBackup_unlockTitles' }, [
            h('div', { key: 'title', id: 'w2m-backup-unlock-dialog-title', className: 'w2mBackup_unlockTitle' }, t('panel.backup.unlock.dialog.title')),
            h('div', { key: 'sub', className: 'w2mBackup_hint' }, t('panel.backup.unlock.dialog.subtitle')),
            h('div', {
              key: 'state',
              className: 'w2mBackup_unlockState',
              'data-w2m-backup-unlock-dialog-state-label': state,
            }, t('panel.backup.unlock.dialog.state.' + stateSuffix)),
          ]),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'w2mBackup_unlockClose',
            'data-w2m-backup-unlock-close': 'true',
            'aria-label': t('panel.backup.unlock.dialog.close'),
            title: t('panel.backup.unlock.dialog.close'),
            onClick: () => close(),
          }, '×'),
        ]),
        // 选项 A：本机/原账户路径。按钮只发确认令牌；不可用时禁用而不是假装可点。
        h('div', { key: 'local', className: 'w2mBackup_unlockSection', 'data-w2m-backup-unlock-option': 'local' }, [
          h('div', { key: 'title', className: 'w2mBackup_unlockSectionTitle' }, t('panel.backup.unlock.dialog.optionA')),
          h('div', { key: 'hint', className: 'w2mBackup_hint' }, localAvailable === true
            ? t('panel.backup.unlock.dialog.optionAHint')
            : t('panel.backup.unlock.dialog.localUnavailable')),
          runMissing === true ? h('div', { key: 'missing', className: 'w2mBackup_hint', 'data-w2m-backup-unlock-route-missing': 'true' }, t('panel.backup.notEnabled')) : null,
          h('div', { key: 'actions', className: 'w2mBackup_unlockActions' }, [
            h('button', {
              key: 'go',
              type: 'button',
              className: 'w2mBackup_btn w2mBackup_btnPrimary',
              'data-w2m-backup-unlock-dialog-local': 'true',
              disabled: localAvailable !== true || busy !== '',
              onClick: () => { void confirmLocal(); },
            }, busy === 'unlock' ? t('panel.backup.unlock.dialog.busy') : t('panel.backup.unlock.dialog.optionA')),
          ]),
        ]),
        // 选项 B：密码只在终端输入。浏览器里没有密码输入框，只有命令文本、复制与刷新状态。
        h('div', { key: 'password', className: 'w2mBackup_unlockSection', 'data-w2m-backup-unlock-option': 'password' }, [
          h('div', { key: 'title', className: 'w2mBackup_unlockSectionTitle' }, t('panel.backup.unlock.dialog.optionB')),
          h('div', { key: 'hint', className: 'w2mBackup_hint' }, t('panel.backup.unlock.dialog.optionBHint')),
          // 公开的密码提示词（明文元数据，按设计随仓库保存）；没有提示词时，没有 PIN 的仓库显示「未设置密码」。
          hintText !== null
            ? h('div', {
                key: 'passwordHint',
                className: 'w2mBackup_hint',
                'data-w2m-backup-unlock-hint': 'true',
              }, t('panel.backup.unlock.dialog.hintLabel', { hint: hintText }))
            : (passwordConfigured !== true
                ? h('div', {
                    key: 'hintNone',
                    className: 'w2mBackup_hint',
                    'data-w2m-backup-unlock-hint-none': 'true',
                  }, t('panel.backup.unlock.dialog.hintNone'))
                : null),
          unencrypted === true
            ? h('div', { key: 'none', className: 'w2mBackup_hint', 'data-w2m-backup-unlock-no-password': 'true' }, t('panel.backup.unlock.dialog.noPasswordNeeded'))
            : null,
          h('div', { key: 'caption', className: 'w2mBackup_hint' }, t('panel.backup.unlock.dialog.commandCaption')),
          h('code', { key: 'command', className: 'w2mBackup_unlockCommand', 'data-w2m-backup-unlock-command': 'true' }, BACKUP_UNLOCK_COMMAND),
          h('div', { key: 'actions', className: 'w2mBackup_unlockActions' }, [
            h('button', {
              key: 'copy',
              type: 'button',
              className: 'w2mBackup_btn',
              'data-w2m-backup-unlock-copy': 'true',
              'data-copied': copied ? 'true' : 'false',
              onClick: () => { void copyCommand(); },
            }, copied ? t('panel.backup.unlock.dialog.copied') : t('panel.backup.unlock.dialog.copy')),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'w2mBackup_btn',
              'data-w2m-backup-unlock-refresh': 'true',
              disabled: refreshing === true,
              onClick: () => { void refreshState(); },
            }, refreshing === true ? t('panel.backup.unlock.dialog.refreshing') : t('panel.backup.unlock.dialog.refresh')),
          ]),
          h('div', { key: 'notice', className: 'w2mBackup_unlockNotice', 'data-w2m-backup-unlock-password-notice': 'true' }, t('panel.backup.unlock.dialog.passwordNeverInBrowser')),
          // 用户撤销了"不提供 PIN 轮换"的决定：轮换存在，但只在终端运行（旧凭据解开 → 去掉旧 PIN → 写新 PIN，
          // 旧 PIN 随后失效）。这里只给说明和可复制的命令，不渲染任何密码输入，也不新增接收密码的 HTTP 端点。
          h('div', { key: 'rotation', className: 'w2mBackup_unlockNotice', 'data-w2m-backup-unlock-rotation': 'true' }, t('panel.backup.unlock.dialog.rotation')),
          h('div', { key: 'rotate', className: 'w2mBackup_unlockNotice', 'data-w2m-backup-unlock-rotate': 'true' }, [
            h('div', { key: 'label' }, t('panel.backup.unlock.dialog.rotationCommand')),
            h('code', {
              key: 'command',
              className: 'w2mBackup_unlockInlineCommand',
              'data-w2m-backup-unlock-rotate-command': 'true',
            }, BACKUP_ROTATE_COMMAND),
            h('button', {
              key: 'copy',
              type: 'button',
              className: 'w2mBackup_btn',
              'data-w2m-backup-unlock-rotate-copy': 'true',
              'data-copied': copiedRotate ? 'true' : 'false',
              onClick: () => { void copyRotateCommand(); },
            }, copiedRotate ? t('panel.backup.unlock.dialog.copied') : t('panel.backup.unlock.dialog.copy')),
          ]),
          // 关闭保护只有可复制的文本：面板永远不会用它去改仓库。
          h('div', { key: 'disable', className: 'w2mBackup_unlockNotice' }, [
            h('div', { key: 'label' }, t('panel.backup.unlock.dialog.disableProtection')),
            h('code', {
              key: 'command',
              className: 'w2mBackup_unlockInlineCommand',
              'data-w2m-backup-unlock-disable-command': 'true',
            }, BACKUP_DISABLE_PROTECTION_COMMAND),
          ]),
        ]),
        result === null
          ? null
          : h('div', {
              key: 'result',
              className: 'w2mBackup_unlockResult',
              role: 'status',
              'data-tone': result.ok === true ? 'ok' : 'err',
              'data-w2m-backup-unlock-dialog-result': result.ok === true ? 'ok' : 'err',
            }, result.text),
      ].filter((node) => node !== null)));
    }

    /**
     * The `oldFormat: 'full'` whole-file-copy cap approval dialog (「特批」).
     *
     * It is the ONLY control that re-posts a refused run with `allowLargeFullCopy: true`, and it is a real modal
     * with the same mechanics as {@link BackupUnlockDialog}: overlay, Escape/backdrop close, focus into the first
     * control, and focus restored to the trigger on close. There is no credential or password surface here at all.
     * Each row is a session the engine itself listed; when the engine listed fewer rows than the reported count the
     * dialog says so instead of pretending the list is complete. 「取消」 closes without sending a request --
     * approval is never inferred from a close, a timeout, or a scheduled slot.
     *
     * @param {object} properties `{t, open, approval, busy, triggerRef, onClose, onConfirm}`
     */
    function BackupApprovalDialog(properties) {
      const {
        t: providedT,
        open = false,
        approval = null,
        busy = '',
        triggerRef = null,
        onClose = () => {},
        onConfirm = async () => null,
      } = properties ?? {};
      const t = typeof providedT === 'function' ? providedT : makeTranslator(() => undefined);
      const panelRef = React.useRef(null);
      const closeRef = React.useRef(onClose);
      // The parent re-renders with a new callback each time; the ref keeps the Escape listener from being re-bound.
      closeRef.current = typeof onClose === 'function' ? onClose : () => {};
      const wasOpenRef = React.useRef(false);
      const previousActiveRef = React.useRef(null);
      React.useEffect(() => {
        const doc = typeof document === 'undefined' ? null : document;
        if (open !== true) {
          if (wasOpenRef.current !== true) return undefined;
          wasOpenRef.current = false;
          const trigger = triggerRef !== null && triggerRef !== undefined ? triggerRef.current : null;
          const fallbackActive = previousActiveRef.current;
          previousActiveRef.current = null;
          const target = trigger !== null && trigger !== undefined && typeof trigger.focus === 'function'
            ? trigger
            : (fallbackActive !== null && fallbackActive !== undefined && typeof fallbackActive.focus === 'function' ? fallbackActive : null);
          if (target === null) return undefined;
          try {
            target.focus();
          } catch {
            // Focus restoration is a convenience, never the dialog's outcome.
          }
          return undefined;
        }
        const firstOpen = wasOpenRef.current !== true;
        wasOpenRef.current = true;
        previousActiveRef.current = doc !== null && typeof doc.activeElement === 'object' ? doc.activeElement : null;
        if (firstOpen) focusBackupDialogFirst(panelRef.current);
        const onKeyDown = (event) => {
          if (event?.key !== 'Escape') return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          closeRef.current();
        };
        if (doc !== null && typeof doc.addEventListener === 'function') doc.addEventListener('keydown', onKeyDown);
        return () => {
          if (doc !== null && typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKeyDown);
        };
      }, [open, triggerRef]);
      if (open !== true) return null;

      const count = Number(approval?.over_cap_count) || 0;
      const capText = backupApprovalCapText(approval);
      const rows = Array.isArray(approval?.sessions) ? approval.sessions : [];
      const more = count > rows.length ? t('panel.backup.approval.dialog.more', { count: count - rows.length }) : null;
      const confirm = async () => {
        if (busy !== '') return;
        try {
          await onConfirm();
        } catch {
          // The page records the failure in its error card; a thrown click must not tear the dialog down.
        }
      };
      return h('div', {
        className: 'w2mBackup_unlockOverlay',
        'data-w2m-backup-approval-overlay': 'true',
        onClick: (event) => {
          if (event !== null && event !== undefined && event.target === event.currentTarget) closeRef.current();
        },
      }, h('div', {
        key: 'dialog',
        className: 'w2mBackup_unlockDialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'w2m-backup-approval-dialog-title',
        'data-w2m-backup-approval-dialog': 'true',
        'data-w2m-backup-approval-count': String(count),
        'data-w2m-backup-approval-cap': capText,
        tabIndex: -1,
        ref: panelRef,
        onClick: (event) => {
          if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation();
        },
      }, [
        h('div', { key: 'head', className: 'w2mBackup_unlockHead' }, [
          h('div', { key: 'titles', className: 'w2mBackup_unlockTitles' }, [
            h('div', { key: 'title', id: 'w2m-backup-approval-dialog-title', className: 'w2mBackup_unlockTitle' }, t('panel.backup.approval.dialog.title')),
            h('div', {
              key: 'sub',
              className: 'w2mBackup_hint',
              'data-w2m-backup-approval-subtitle': 'true',
            }, t('panel.backup.approval.dialog.subtitle', { count, cap: capText })),
          ]),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'w2mBackup_unlockClose',
            'data-w2m-backup-approval-close': 'true',
            'aria-label': t('panel.backup.approval.close'),
            title: t('panel.backup.approval.close'),
            onClick: () => closeRef.current(),
          }, '×'),
        ]),
        // One row per oversized session the engine listed (bounded to 20 by the normalizer). The row text carries
        // the size and the cap, so the operator approves a number, not a promise.
        h('div', { key: 'list', className: 'w2mBackup_unlockSection', 'data-w2m-backup-approval-list': 'true' },
          rows.map((row) => h('div', {
            key: row.key,
            className: 'w2mBackup_hint',
            'data-w2m-backup-approval-session': row.session_id,
            title: row.rel !== '' ? row.rel : row.session_id,
          }, t('panel.backup.approval.dialog.session', {
            id: row.session_id,
            size: row.size === null ? '—' : backupBytesText(row.size),
            cap: row.cap === null ? capText : backupMbText(row.cap),
          })))),
        more === null
          ? null
          : h('div', { key: 'more', className: 'w2mBackup_hint', 'data-w2m-backup-approval-more': 'true' }, more),
        h('div', {
          key: 'hint',
          className: 'w2mBackup_unlockNotice',
          'data-w2m-backup-approval-hint': 'true',
        }, t('panel.backup.approval.dialog.hint')),
        h('div', { key: 'actions', className: 'w2mBackup_unlockActions' }, [
          // Cancel first in the tab order: the safe action is the one focus lands on, exactly like the requirement
          // that this dialog can never approve by itself.
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-approval-cancel': 'true',
            disabled: busy === 'run',
            onClick: () => closeRef.current(),
          }, t('panel.backup.approval.cancel')),
          h('button', {
            key: 'confirm',
            type: 'button',
            className: 'w2mBackup_btn w2mBackup_btnPrimary',
            'data-w2m-backup-approval-confirm': 'true',
            disabled: busy === 'run',
            onClick: () => { void confirm(); },
          }, busy === 'run' ? t('panel.backup.approval.busy') : t('panel.backup.approval.confirm')),
        ]),
      ].filter((node) => node !== null)));
    }

    /**
     * 面板的纯视图：一份 props → 一棵 React 元素树，不使用 hooks。
     *
     * 状态和副作用都在 {@link BackupMainPage} 里；视图只负责把状态画出来，所以 bundle 测试可以
     * 直接调用它并检查六个 `data-w2m-backup-action` 标记、解锁双分支与日志区，不需要渲染器。
     */
    function BackupPanelView(properties) {
      const {
        repo = null,
        status = null,
        unlock = null,
        plan = null,
        selected = [],
        busy = '',
        log = [],
        verify = null,
        lastAction = null,
        error = null,
        // 宿内注册表修复的结果（G2 面板路径）：{ok, changed, registered, already_registered, watch} 或 null。
        registerFix = null,
        archiveScope = 'archived',
        restoreArmed = false,
        runMissing = false,
        // 校验卡的勾选框：默认关闭（只跑便宜的静态预筛），勾上才让宿主用安装的 Harness 终审（慢，G5）。
        verifyRuntime = false,
        onRefresh = () => {},
        onRun = () => {},
        onPlan = () => {},
        onRestore = () => {},
        onCancelRestore = () => {},
        onToggleSession = () => {},
        onSelectAll = () => {},
        onClearSelection = () => {},
        onArchiveScope = () => {},
        onArchive = () => {},
        onVerify = () => {},
        onVerifyRuntime = () => {},
        onVerifyRuntimeNow = () => {},
        onRegisterFix = () => {},
        onUnlock = () => {},
        // v3.5.0 备份范围入口：会话来自只读 scan（`scan === null` = 还没读到），勾选状态只在页面内。
        scan = null,
        picked = [],
        onScan = () => {},
        onTogglePick = () => {},
        onPickAll = () => {},
        onPickClear = () => {},
        onBackupSelected = () => {},
        onBackupActive = () => {},
        // v3.5.x 解锁对话框（真正的模态）：卡片保留说明与既有按钮，动作面移到对话框；这些回调由页面提供。
        unlockDialogOpen = false,
        unlockTriggerRef = null,
        onOpenUnlockDialog = () => {},
        onCloseUnlockDialog = () => {},
        onConfirmUnlock = async () => null,
        onRefreshUnlock = async () => {},
        // v3.5.0 full-copy cap approval: the descriptor the modal shows (null = nothing pending), whether it is
        // open, and the callbacks the page wires (re-post with allowLargeFullCopy; cancel only closes).
        approval = null,
        approvalOpen = false,
        approvalTriggerRef = null,
        onOpenApproval = () => {},
        onCloseApproval = () => {},
        onConfirmApproval = async () => null,
        // v3.5.0 §24.3: the `old/` usage reminder (no total cap). 「知道了」 acknowledges the growth through the ack
        // route and deletes nothing; 「如何清理」 expands the gc guidance. The banner renders only while it is due.
        oldUsageHelpOpen = false,
        onAckOldUsage = () => {},
        onToggleOldUsageHelp = () => {},
      } = properties ?? {};
      const t = typeof properties?.t === 'function' ? properties.t : makeTranslator(() => undefined);
      const state = status?.state ?? null;
      // P0/P1: the scopes this row runs with and whether it includes credentials. The warning is loud on purpose:
      // a repository with credentials is an identity, not just data.
      const backupScopes = Array.isArray(status?.scopes) ? status.scopes.filter((name) => typeof name === 'string') : null;
      const backupIncludeSecrets = status?.include_secrets === true;
      // A scheduled run that hit the full-copy cap leaves a named pending state (never a write, never a blocked
      // timer). This banner is that state; the dialog is the only place the pending write can be approved.
      const pendingApproval = backupPendingApproval(status);
      // The old/ usage reminder is the second pending banner: it is derived from the persisted `state.old_usage`
      // (or the engine's last report) and only renders while due. It carries no destructive action at all.
      const pendingOldUsage = backupPendingOldUsage(status);
      const dialogApproval = approval ?? pendingApproval;
      const repository = repo?.repository ?? null;
      const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
      const selectedIds = new Set(Array.isArray(selected) ? selected : []);
      const entries = Array.isArray(log) ? log : [];
      const problems = Array.isArray(verify?.problems) ? verify.problems : [];
      const planSummary = plan?.summary ?? {};
      const disabled = busy !== '';
      // v3.5.x 账户 ID 绑定解锁（用户决定：只读账户唯一识别码做比对，一致就放行，不一致就切密码模式）。
      // 宿主只返回 {bound, matched, id_hint}——id_hint 是原账户 ID 的后 4 位，面板从不接触完整 ID，
      // 也从不把它发回服务器；这不是机密性路径（见 docs/BACKUP-DESIGN.md §25）。
      const unlockAccount = unlock !== null && unlock !== undefined && unlock.account !== null && typeof unlock?.account === 'object'
        ? unlock.account
        : null;
      const accountBound = unlockAccount?.bound === true;
      const accountMatched = unlockAccount?.matched === true;
      const accountMismatch = unlockAccount?.matched === false;
      const accountHint = typeof unlockAccount?.id_hint === 'string' && unlockAccount.id_hint !== '' ? unlockAccount.id_hint : '…';
      // v3.5.x 保护模式：none = 未加密（免密解锁 + 警告），sealed = 账户/机器/PIN 信封。
      // 仓库的真实模式来自宿主（unlock.encryption；状态卡来自 repo.encryption / repository.encryption），
      // 面板只负责把它画成三态徽标/三态解锁卡，从不自行推断凭据是否可用。
      const unlockUnencrypted = unlock?.encryption === 'none';
      const unlockEncryption = unlock?.encryption === 'none' || unlock?.encryption === 'sealed' ? unlock.encryption : null;
      const repoEncryption = (repo?.encryption === 'none' || repo?.encryption === 'sealed')
        ? repo.encryption
        : (repository?.encryption === 'none' || repository?.encryption === 'sealed' ? repository.encryption : null);
      const unlockState = unlockUnencrypted
        ? 'none'
        : (accountMatched ? 'account-matched' : (accountMismatch ? 'account-mismatch' : (unlock?.machine_available === true ? 'machine' : 'password')));
      // v3.5.0 备份范围入口：扫描会话（只读）与勾选状态，与还原计划的 `selected` 刻意分开——两个列表
      // 语义不同，共用一个数组会让「备份选中」把还原勾选也发出去。`scan === null` 表示还没读到。
      const scanSessions = Array.isArray(scan?.sessions) ? scan.sessions : [];
      const scanLoaded = scan !== null && scan !== undefined;
      const scanAvailable = scanLoaded && scan.available === true;
      const pickedIds = new Set(Array.isArray(picked) ? picked : []);
      const pickCount = t('panel.backup.pick.count', { n: pickedIds.size, m: scanSessions.length });
      // 「备份选中」需要 ≥1 个勾选（扫描前/扫描失败/空列表自然都是 0 → 禁用）；「备份活动」不依赖
      // 勾选，但扫描结果回来之前也不亮出来，免得两次读并发时操作者以为列表是空的。
      const backupSelectedDisabled = disabled || runMissing === true || scanLoaded !== true || pickedIds.size === 0;
      const backupActiveDisabled = disabled || runMissing === true || scanLoaded !== true;
      const pickToolsDisabled = disabled || runMissing === true || scanAvailable !== true || scanSessions.length === 0;
      const recheck = state?.last_registry_recheck ?? null;
      const recheckText = recheck === null || typeof recheck !== 'object'
        ? '—'
        : [
            backupTimeText(recheck.at),
            recheck.ok === true ? t('panel.backup.status.recheckOk') : t('panel.backup.status.recheckFailed'),
            recheck.rewritten === true ? t('panel.backup.status.recheckRewrote') : null,
          ].filter((part) => part !== null).join(' · ');
      const lastError = state?.last_error ?? null;
      const stats = [
        ['repo', t('panel.backup.status.repo'), repository?.root ?? status?.backup_dir ?? '—'],
        ['initialized', t('panel.backup.status.initialized'), repository === null || repository === undefined
          ? '—'
          : (repository.initialized === true ? t('panel.backup.status.yes') : t('panel.backup.status.no'))],
        ['snapshots', t('panel.backup.status.snapshots'), repository?.counts?.snapshots ?? repository?.snapshots ?? '—'],
        repository?.cipher ? ['cipher', t('panel.backup.status.cipher'), String(repository.cipher)] : null,
        repoEncryption ? ['mode', t('panel.backup.status.mode'), t('panel.backup.mode.' + repoEncryption)] : null,
        ['free', t('panel.backup.status.free'), repository === null || repository?.free_bytes === null || repository?.free_bytes === undefined
          ? '—'
          : backupBytesText(repository.free_bytes)],
        ['schedule', t('panel.backup.status.schedule'), Array.isArray(status?.schedule?.times) && status.schedule.times.length > 0
          ? status.schedule.times.join(' / ') + ' ' + String(status.schedule.time_zone ?? '')
            + (typeof status.schedule.next_at === 'string' && status.schedule.next_at !== ''
              ? ' · ' + t('panel.backup.status.next', { time: backupTimeText(status.schedule.next_at) })
              : '')
          : '—'],
        ['lastRun', t('panel.backup.status.lastRun'), state?.last_run
          ? backupTimeText(state.last_run) + ' · ' + backupResultSummary(state.last_result, t)
          : t('panel.backup.status.never')],
        ['runState', t('panel.backup.status.state'), state?.running === true ? t('panel.backup.status.running') : t('panel.backup.status.idle')],
        ['recheck', t('panel.backup.status.recheck'), recheckText],
        lastError === null ? null : ['lastError', t('panel.backup.status.lastError'),
          backupTimeText(lastError.at) + ' · ' + backupReasonText(lastError.reason_code, t) + (typeof lastError.detail === 'string' && lastError.detail !== '' ? ' · ' + lastError.detail : '')],
      ].filter((row) => row !== null);

      // v3.5.x 缓存终审（G5）：记录来自 /run 内嵌状态的 state.last_runtime_verify，面板只读它；过期按 24 小时
      // 计算，不因为「页面刚打开」就把旧结论当新鲜。证据标签原样显示（installed-harness），面板不推断结论。
      const cachedRuntimeVerify = state?.last_runtime_verify !== null && typeof state?.last_runtime_verify === 'object'
        ? state.last_runtime_verify
        : null;
      const cachedRuntimeFinishedMs = cachedRuntimeVerify === null ? Number.NaN : Date.parse(String(cachedRuntimeVerify.finished_at ?? ''));
      const cachedRuntimeStale = cachedRuntimeVerify === null
        ? false
        : (!Number.isFinite(cachedRuntimeFinishedMs) || (Date.now() - cachedRuntimeFinishedMs) > 24 * 60 * 60 * 1000);
      // v3.5.x 宿内注册表修复（G2 面板路径）：默认登记勾选的会话；没有勾选就登记扫描到的未登记会话。
      // 两种都为 0 时按钮禁用，而不是发一个空请求。
      const unregisteredIds = scanSessions
        .filter((session) => session?.registered !== true)
        .map((session) => String(session?.session_id ?? ''))
        .filter((sessionId) => sessionId !== '');
      const registerIds = pickedIds.size > 0 ? [...pickedIds] : unregisteredIds;
      const repairRegisterDisabled = disabled || runMissing === true || scanAvailable !== true || registerIds.length === 0;
      const registerFixText = registerFix === null || registerFix === undefined
        ? null
        : (registerFix.ok === true
            // 结果行只报计数；残余风险在下面单独一行，不并入「已完成」。
            ? t('panel.backup.register.done', {
                registered: Array.isArray(registerFix.registered) ? registerFix.registered.length : 0,
                already: Array.isArray(registerFix.already_registered) ? registerFix.already_registered.length : 0,
                clobbered: Number(registerFix.watch?.clobbered) || 0,
                reapplied: Number(registerFix.watch?.reapplied) || 0,
              })
            : backupReasonText(registerFix.reason_code, t) + (typeof registerFix.detail === 'string' && registerFix.detail !== '' ? ' · ' + registerFix.detail : ''));

      const statusCard = h('div', { key: 'status', className: 'w2mBackup_card', 'data-w2m-backup-panel': 'status' }, [
        h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
          h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.status.title')),
          // 保护模式徽标：none 用警告色（differs），sealed 用通过色（new）。这是产品“不是绝对保密”的
          // 最直接表达：未加密不是错误，但必须一眼可见。
          repoEncryption === null
            ? null
            : h('span', {
                key: 'mode',
                className: 'w2mBackup_tag',
                'data-kind': repoEncryption === 'none' ? 'differs' : 'new',
                'data-w2m-backup-mode': repoEncryption,
              }, t('panel.backup.mode.' + repoEncryption)),
          runMissing === true ? h('span', { key: 'missing', className: 'w2mBackup_tag', 'data-kind': 'differs' }, t('panel.backup.notEnabled')) : null,
          // G2 的面板路径：在宿主内（客户端必然在跑）规划 + 写入 + 有界监视，按钮只发 session_ids 与确认令牌。
          h('button', {
            key: 'repairRegister',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-action': 'repair-register',
            disabled: repairRegisterDisabled,
            title: t('panel.backup.action.repairRegister'),
            onClick: onRegisterFix,
          }, busy === 'repair-register' ? t('panel.backup.busy.repairRegister') : t('panel.backup.action.repairRegister')),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-action': 'refresh',
            disabled,
            onClick: onRefresh,
          }, t('panel.backup.refresh')),
        ]),
        h('div', { key: 'grid', className: 'w2mBackup_grid' }, stats.map((row) => h('div', { key: row[0], className: 'w2mBackup_stat' }, [
          h('span', { key: 'label', className: 'w2mBackup_statLabel' }, row[1]),
          h('span', { key: 'value', className: 'w2mBackup_statValue' }, String(row[2])),
        ]))),
        registerFixText === null
          ? null
          : h('div', {
              key: 'registerFix',
              className: 'w2mBackup_hint',
              'data-w2m-backup-register-fix': registerFix?.ok === true ? 'ok' : 'error',
            }, [
              h('span', { key: 'text' }, t('panel.backup.status.registerFix') + '：' + registerFixText),
              // 诚实边界：只有 file-write 路径（宿主没有 workspaceRegistry 服务时）才有文件级残余风险；
              // 宿主服务路径由服务自己持久化并推送给 GUI，没有可被客户端覆盖的文件写入，所以不显示这句。
              registerFix?.ok === true && typeof registerFix.residual_risk === 'string'
                ? h('div', { key: 'residual', className: 'w2mBackup_danger', 'data-w2m-backup-register-residual': 'true' }, t('panel.backup.register.residual'))
                : null,
            ]),
        repoEncryption === 'none'
          ? h('div', { key: 'noneWarning', className: 'w2mBackup_danger', 'data-w2m-backup-none-warning': 'true' }, t('panel.backup.mode.noneWarning'))
          : null,
        backupScopes === null
          ? null
          : h('div', { key: 'scopes', className: 'w2mBackup_hint', 'data-w2m-backup-scopes': backupScopes.join(',') },
              t('panel.backup.scopes', { scopes: backupScopes.join(' · ') })),
        backupIncludeSecrets === true
          ? h('div', { key: 'secrets', className: 'w2mBackup_danger', 'data-w2m-backup-secrets-warning': 'true' }, t('panel.backup.secretsWarning'))
          : null,
      ]);

      // v3.5.0 整文件副本上限的「待特批」状态：定时备份在写盘前被拒绝后，这里显示它并给出显式的人工入口。
      // 这个按钮只打开确认对话框，绝不在渲染时发请求；「特批并继续」是唯一会带上 allowLargeFullCopy 的动作。
      const approvalPendingCard = pendingApproval === null
        ? null
        : h('div', {
            key: 'approvalPending',
            className: 'w2mBackup_card',
            'data-w2m-backup-panel': 'approval-pending',
            'data-w2m-backup-approval-pending': 'true',
          }, [
            h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
              h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.approval.pending', {
                count: pendingApproval.over_cap_count,
                cap: backupApprovalCapText(pendingApproval),
              })),
            ]),
            h('div', { key: 'hint', className: 'w2mBackup_hint' }, t('panel.backup.approval.pendingHint')),
            h('div', { key: 'actions', className: 'w2mBackup_actions' }, [
              h('button', {
                key: 'open',
                type: 'button',
                className: 'w2mBackup_btn w2mBackup_btnPrimary',
                'data-w2m-backup-approval-open': 'true',
                disabled,
                onClick: (event) => onOpenApproval(event !== null && event !== undefined ? event.currentTarget : null),
              }, t('panel.backup.approval.open')),
            ]),
          ]);

      // v3.5.0 §24.3 old/ 占用提醒卡：`old/` 按决定**不设总量上限**，这里只是「自上次确认以来增长」的提醒。
      // 「知道了」只 POST 确认令牌（不删除任何文件）；「如何清理」展开终端 gc 指引。面板没有删除按钮。
      const oldUsageCard = pendingOldUsage === null
        ? null
        : h('div', {
            key: 'oldUsage',
            className: 'w2mBackup_card',
            'data-w2m-backup-panel': 'old-usage',
            'data-w2m-backup-old-usage': 'true',
          }, [
            h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
              h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.oldUsage.title')),
            ]),
            h('div', {
              key: 'text',
              className: 'w2mBackup_hint',
              'data-w2m-backup-old-usage-text': 'true',
            }, t('panel.backup.oldUsage.banner', {
              bytes: backupOldUsageGbText(pendingOldUsage.bytes),
              growth: backupOldUsageGbText(pendingOldUsage.growth_bytes),
            })),
            h('div', { key: 'hint', className: 'w2mBackup_hint' }, t('panel.backup.oldUsage.hint')),
            h('div', { key: 'actions', className: 'w2mBackup_actions' }, [
              h('button', {
                key: 'ack',
                type: 'button',
                className: 'w2mBackup_btn w2mBackup_btnPrimary',
                'data-w2m-backup-old-usage-ack': 'true',
                disabled,
                onClick: () => onAckOldUsage(),
              }, busy === 'old-usage-ack' ? t('panel.backup.busy.oldUsageAck') : t('panel.backup.oldUsage.ack')),
              h('button', {
                key: 'help',
                type: 'button',
                className: 'w2mBackup_btn',
                'data-w2m-backup-old-usage-help': 'true',
                'aria-expanded': oldUsageHelpOpen === true,
                disabled,
                onClick: () => onToggleOldUsageHelp(),
              }, t('panel.backup.oldUsage.howTo')),
            ]),
            // 「如何清理」只在展开时显示终端指引：先 dry-run 预览，再决定；面板本身从不执行删除。
            oldUsageHelpOpen === true
              ? h('div', {
                  key: 'guidance',
                  className: 'w2mBackup_hint',
                  'data-w2m-backup-old-usage-guidance': 'true',
                }, t('panel.backup.oldUsage.guidance'))
              : null,
          ].filter((node) => node !== null));

      const operationsCard = h('div', { key: 'operations', className: 'w2mBackup_card', 'data-w2m-backup-panel': 'operations' }, [
        h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
          h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.operations.title')),
          h('select', {
            key: 'scope',
            className: 'w2mBackup_select',
            value: archiveScope,
            disabled,
            'aria-label': t('panel.backup.archive.scope'),
            'data-w2m-backup-archive-scope': 'true',
            onChange: (event) => onArchiveScope(event.target.value),
          }, [
            h('option', { key: 'archived', value: 'archived' }, t('panel.backup.archive.scopeArchived')),
            h('option', { key: 'all', value: 'all' }, t('panel.backup.archive.scopeAll')),
          ]),
        ]),
        h('div', { key: 'hint', className: 'w2mBackup_hint' }, t('panel.backup.action.runHint')),
        h('div', { key: 'actions', className: 'w2mBackup_actions' }, [
          h('button', {
            key: 'run',
            type: 'button',
            className: 'w2mBackup_btn w2mBackup_btnPrimary',
            'data-w2m-backup-action': 'run',
            disabled: disabled || runMissing === true,
            onClick: onRun,
          }, busy === 'run' ? t('panel.backup.busy.run') : t('panel.backup.action.run')),
          h('button', {
            key: 'restore',
            type: 'button',
            className: restoreArmed ? 'w2mBackup_btn w2mBackup_btnDanger' : 'w2mBackup_btn',
            'data-w2m-backup-action': 'restore',
            'data-armed': restoreArmed ? 'true' : 'false',
            disabled: disabled || runMissing === true,
            onClick: onRestore,
          }, restoreArmed ? t('panel.backup.action.confirmRestore') : t('panel.backup.action.restore')),
          h('button', {
            key: 'archive',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-action': 'archive',
            disabled: disabled || runMissing === true,
            onClick: onArchive,
          }, busy === 'archive' ? t('panel.backup.busy.archive') : t('panel.backup.action.archive')),
          h('button', {
            key: 'verify',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-action': 'verify',
            disabled: disabled || runMissing === true,
            onClick: onVerify,
          }, busy === 'verify' ? t('panel.backup.busy.verify') : t('panel.backup.action.verify')),
          // v3.5.0：两个范围入口。它们和上面四个操作共用宿主同一条 POST /run（确认令牌不变），
          // 只是 scope 不同；各自的 busy token 保证操作期间的标签说的是正在发生的事。
          h('button', {
            key: 'backup-selected',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-action': 'backup-selected',
            disabled: backupSelectedDisabled,
            onClick: onBackupSelected,
          }, busy === 'backup-selected' ? t('panel.backup.busy.backupSelected') : t('panel.backup.action.backupSelected')),
          h('button', {
            key: 'backup-active',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-action': 'backup-active',
            disabled: backupActiveDisabled,
            onClick: onBackupActive,
          }, busy === 'backup-active' ? t('panel.backup.busy.backupActive') : t('panel.backup.action.backupActive')),
        ]),
        busy === '' ? null : h('div', { key: 'progress', className: 'w2mBackup_progress', role: 'status', 'data-w2m-backup-progress': busy }, backupBusyText(busy, t)),
      ]);

      // v3.5.0 备份范围卡：列表来自只读扫描（GET /scan?detail=1），勾选只存在页面内存里；本卡不产生
      // 任何写请求——真正落盘的是点入口后带确认令牌的 POST /run，而且这张卡在扫描失败/404/空列表时
      // 只是给出中性提示与重试，绝不挡住面板其它部分。
      const scanState = scanLoaded !== true
        ? 'loading'
        : scanAvailable !== true
          ? 'unavailable'
          : (scanSessions.length === 0 ? 'empty' : 'ready');
      const scanBody = scanState === 'loading'
        ? h('div', { key: 'loading', className: 'w2mBackup_empty', 'data-w2m-backup-scan-state': 'loading' }, t('panel.backup.pick.loading'))
        : scanState === 'unavailable'
          ? h('div', { key: 'unavailable', className: 'w2mBackup_hint', 'data-w2m-backup-scan-state': 'unavailable', role: 'status' }, t('panel.backup.pick.unavailable'))
          : scanState === 'empty'
            ? h('div', { key: 'empty', className: 'w2mBackup_empty', 'data-w2m-backup-scan-state': 'empty' }, t('panel.backup.pick.empty'))
            : h('div', { key: 'list', className: 'w2mBackup_pickList', 'data-w2m-backup-scan-state': 'ready' }, scanSessions.map((session) => {
                const sessionId = String(session?.session_id ?? '');
                return h('label', { key: 'p:' + sessionId, className: 'w2mBackup_pickRow' }, [
                  h('input', {
                    key: 'box',
                    type: 'checkbox',
                    checked: pickedIds.has(sessionId),
                    disabled: disabled || runMissing === true,
                    'data-w2m-backup-pick': sessionId,
                    onChange: () => onTogglePick(sessionId),
                  }),
                  h('span', { key: 'ws', className: 'w2mBackup_sessionWs', title: String(session?.workspace ?? '—') }, String(session?.workspace ?? '—')),
                  h('span', { key: 'id', className: 'w2mBackup_pickSuffix', title: sessionId }, backupSessionSuffix(sessionId)),
                  h('span', { key: 'size', className: 'w2mBackup_sessionSize' }, backupBytesText(session?.size)),
                  session?.archived === true
                    ? h('span', { key: 'archived', className: 'w2mBackup_tag', 'data-kind': 'archived' }, t('panel.backup.pick.archivedTag'))
                    : null,
                ]);
              }));
      const scopeCard = h('div', { key: 'scope', className: 'w2mBackup_card', 'data-w2m-backup-panel': 'scope' }, [
        h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
          h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.pick.title')),
          h('button', {
            key: 'scan',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-scan-refresh': 'true',
            disabled,
            onClick: onScan,
          }, t('panel.backup.pick.refresh')),
        ]),
        h('div', { key: 'hint', className: 'w2mBackup_hint', 'data-w2m-backup-scope-hint': 'true' }, t('panel.backup.scope.hint')),
        h('div', { key: 'tools', className: 'w2mBackup_row' }, [
          h('button', {
            key: 'all',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-pick-all': 'true',
            disabled: pickToolsDisabled,
            onClick: onPickAll,
          }, t('panel.backup.pick.selected')),
          h('button', {
            key: 'clear',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-pick-clear': 'true',
            disabled,
            onClick: onPickClear,
          }, t('panel.backup.pick.clear')),
          h('span', { key: 'count', className: 'w2mBackup_hint', 'data-w2m-backup-pick-count': 'true' }, pickCount),
        ]),
        scanBody,
      ]);

      const planCard = h('div', { key: 'plan', className: 'w2mBackup_card', 'data-w2m-backup-panel': 'plan' }, [
        h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
          h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.plan.title')),
          h('button', {
            key: 'plan',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-action': 'plan',
            disabled: disabled || runMissing === true,
            onClick: onPlan,
          }, busy === 'plan' ? t('panel.backup.busy.plan') : t('panel.backup.action.plan')),
        ]),
        plan === null || plan === undefined
          ? h('div', { key: 'empty', className: 'w2mBackup_empty' }, t('panel.backup.plan.empty'))
          : h('div', { key: 'body', className: 'w2mBackup_hint' }, [
              h('div', { key: 'source' }, t('panel.backup.plan.source') + '：' + String(plan.snapshot_id ?? '—') + ' · ' + t('panel.backup.plan.summary', {
                sessions: Number(planSummary.sessions) || 0,
                new: Number(planSummary.new) || 0,
                identical: Number(planSummary.identical) || 0,
                conflicts: Number(planSummary.conflicts) || 0,
                attachments: Number(planSummary.attachments) || 0,
              })),
              h('div', { key: 'tools', className: 'w2mBackup_row' }, [
                h('button', { key: 'all', type: 'button', className: 'w2mBackup_btn', 'data-w2m-backup-select': 'all', disabled, onClick: onSelectAll }, t('panel.backup.plan.selectAll')),
                h('button', { key: 'clear', type: 'button', className: 'w2mBackup_btn', 'data-w2m-backup-select': 'none', disabled, onClick: onClearSelection }, t('panel.backup.plan.clear')),
                h('span', { key: 'count', className: 'w2mBackup_hint' }, t('panel.backup.plan.selected', { count: selectedIds.size, total: candidates.length })),
              ]),
              restoreArmed === true ? h('div', { key: 'danger', className: 'w2mBackup_danger', 'data-w2m-backup-confirm': 'restore' }, [
                h('span', { key: 'text' }, t('panel.backup.plan.danger')),
                h('button', { key: 'cancel', type: 'button', className: 'w2mBackup_btn', onClick: onCancelRestore }, t('panel.backup.action.cancel')),
              ]) : null,
              candidates.length === 0 ? null : h('div', { key: 'list', className: 'w2mBackup_sessions' }, candidates.map((candidate) => {
                const sessionId = String(candidate?.session_id ?? '');
                return h('label', { key: 's:' + sessionId, className: 'w2mBackup_session' }, [
                  h('input', {
                    key: 'box',
                    type: 'checkbox',
                    checked: selectedIds.has(sessionId),
                    'data-w2m-backup-session': sessionId,
                    onChange: () => onToggleSession(sessionId),
                  }),
                  h('span', { key: 'ws', className: 'w2mBackup_sessionWs' }, String(candidate?.workspace ?? '—')),
                  h('span', { key: 'id', className: 'w2mBackup_sessionId' }, sessionId),
                  h('span', { key: 'size', className: 'w2mBackup_sessionSize' }, backupBytesText(candidate?.size)),
                  h('span', { key: 'conflict', className: 'w2mBackup_tag', 'data-kind': String(candidate?.conflict ?? 'new') }, backupConflictText(candidate?.conflict, t)),
                ]);
              })),
            ]),
      ]);

      // 校验卡常驻：勾选框必须在点「全量校验」之前就能看到/勾上，所以 verify 为空时只渲染勾选行与提示。
      const verifyReady = verify !== null && verify !== undefined;
      const verifyCard = h('div', { key: 'verify', className: 'w2mBackup_card', 'data-w2m-backup-panel': 'verify' }, [
        h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
          h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.verify.title')),
          verifyReady
            ? h('span', { key: 'state', className: 'w2mBackup_tag', 'data-kind': verify.ok === true ? 'new' : 'differs' },
                verify.ok === true ? t('panel.backup.verify.clean') : t('panel.backup.verify.problems', { count: problems.length }))
            : null,
        ]),
        // 慢路径是显式选择：默认只跑静态预筛，勾上才会让宿主用安装的 Harness 逐条终审（G5 的唯一证据）。
        h('div', { key: 'runtimeRow', className: 'w2mBackup_row' }, [
          h('label', { key: 'toggle', className: 'w2mBackup_check' }, [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: verifyRuntime === true,
              disabled: disabled || runMissing === true,
              'data-w2m-backup-runtime': 'true',
              onChange: (event) => onVerifyRuntime(event.target.checked === true),
            }),
            h('span', { key: 'label' }, t('panel.backup.verify.runtime')),
          ]),
        ]),
        h('div', { key: 'runtimeHint', className: 'w2mBackup_hint', 'data-w2m-backup-runtime-hint': 'true' }, t('panel.backup.verify.runtimeHint')),
        // 缓存终审（G5）：上次持久化记录的只读视图，超过 24 小时标 stale。证据标签原样显示，面板不推断结论。
        h('div', {
          key: 'cached',
          className: 'w2mBackup_verifyCounts',
          'data-w2m-backup-runtime-cached': cachedRuntimeVerify === null ? 'none' : (cachedRuntimeStale ? 'stale' : 'fresh'),
        }, [
          cachedRuntimeVerify === null
            ? h('span', { key: 'none' }, t('panel.backup.verify.cachedNone'))
            : null,
          cachedRuntimeVerify === null
            ? null
            : h('span', { key: 'line' }, t('panel.backup.verify.cachedTitle') + '：' + t('panel.backup.verify.cachedLine', {
                time: backupTimeText(cachedRuntimeVerify.finished_at),
                checked: Number(cachedRuntimeVerify.checked) || 0,
                failed: Number(cachedRuntimeVerify.failed) || 0,
                snapshots: Number(cachedRuntimeVerify.snapshots) || 0,
                evidence: String(cachedRuntimeVerify.evidence ?? '—'),
              })),
          cachedRuntimeVerify === null
            ? null
            : (cachedRuntimeStale
                ? h('span', { key: 'stale', className: 'w2mBackup_tag', 'data-kind': 'differs', 'data-w2m-backup-runtime-stale': 'true' }, t('panel.backup.verify.stale'))
                : h('span', { key: 'fresh', className: 'w2mBackup_tag', 'data-kind': 'new' }, t('panel.backup.verify.fresh'))),
        ].filter((node) => node !== null)),
        // 「立即运行」是唯一同步跑运行时终审的按钮（慢；需要安装 Harness）；忙碌期间禁用并显示进度。
        h('div', { key: 'runRuntimeRow', className: 'w2mBackup_row' }, [
          h('button', {
            key: 'runRuntime',
            type: 'button',
            className: 'w2mBackup_btn',
            'data-w2m-backup-action': 'verify-runtime',
            disabled: disabled || runMissing === true,
            onClick: onVerifyRuntimeNow,
          }, busy === 'verify-runtime' ? t('panel.backup.busy.verifyRuntime') : t('panel.backup.action.verifyRuntime')),
        ]),
        verifyReady ? h('div', { key: 'counts', className: 'w2mBackup_verifyCounts' }, t('panel.backup.verify.counts', {
          snapshots: Number(verify.counts?.snapshots) || 0,
          files: Number(verify.counts?.files) || 0,
          blocks: Number(verify.counts?.blocks) || 0,
          old: Number(verify.counts?.old) || 0,
          current: Number(verify.counts?.current) || 0,
        })) : null,
        verifyReady ? h('div', { key: 'future', className: 'w2mBackup_verifyCounts' }, t('panel.backup.verify.futureAppend', {
          checked: Number(verify.future_append?.checked) || 0,
          failed: Number(verify.future_append?.failed) || 0,
        })) : null,
        verifyReady ? h('div', { key: 'runtime', className: 'w2mBackup_verifyCounts' }, t('panel.backup.verify.runtimeCounts', {
          checked: Number(verify.runtime_verified?.checked) || 0,
          failed: Number(verify.runtime_verified?.failed) || 0,
        })) : null,
        verifyReady && problems.length > 0 ? h('div', { key: 'problems', className: 'w2mBackup_problems' }, problems.map((problem, index) => h('div', { key: 'p' + index }, t('panel.backup.verify.problem', {
          // 已知稳定码翻成可操作的一句话（含 BACKUP_RUNTIME_UNAVAILABLE / BACKUP_RUNTIME_REJECTED），未知码原样显示。
          code: backupReasonText(problem?.code, t) || String(problem?.code ?? '—'),
          file: String(problem?.file ?? '—'),
          detail: String(problem?.detail ?? ''),
        })))) : null,
      ]);

      // v3.5.x 三态解锁卡（用户决定：便捷优先，不是绝对保密）：
      //   * none（默认）→ 免密可直接解锁 + 诚实警告 + “关闭保护”的说明；
      //   * sealed + 账户一致 → 快捷解锁按钮；
      //   * sealed + 账户不一致但有 PIN → 账户按钮禁用，提示只在终端输入 4-6 位 PIN。
      // HTTP 永不接收密码，所以任何一态都没有密码输入框。
      const unlockInitialized = unlock === null || unlock === undefined
        ? null
        : h('div', { key: 'initialized' }, unlock.initialized === true ? t('panel.backup.unlock.initialized') : t('panel.backup.unlock.notInitialized'));
      const unlockEnvelopes = unlock === null || unlock === undefined ||
        !Array.isArray(unlock.envelopes) || unlock.envelopes.length === 0
        ? null
        : h('div', { key: 'envelopes' }, t('panel.backup.unlock.envelopes', { kinds: unlock.envelopes.join(' / ') }));
      const unlockNoneBody = h('div', {
        key: 'body',
        className: 'w2mBackup_hint',
        'data-w2m-backup-unlock-state': 'none',
      }, [
        unlockInitialized,
        unlockEnvelopes,
        h('div', {
          key: 'noneWarning',
          className: 'w2mBackup_danger',
          'data-w2m-backup-unlock-warning': 'true',
        }, t('panel.backup.mode.noneWarning')),
        h('div', { key: 'none' }, t('panel.backup.unlock.none')),
        h('div', { key: 'unlockRow', className: 'w2mBackup_row' }, [
          h('span', { key: 'text' }, t('panel.backup.mode.none')),
          h('button', {
            key: 'unlock',
            type: 'button',
            className: 'w2mBackup_btn w2mBackup_btnPrimary',
            'data-w2m-backup-action': 'unlock',
            disabled,
            onClick: onUnlock,
          }, busy === 'unlock' ? t('panel.backup.busy.unlock') : t('panel.backup.action.unlock')),
        ]),
        h('div', {
          key: 'disableHint',
          className: 'w2mBackup_hint',
          'data-w2m-backup-disable-protection-hint': 'true',
        }, t('panel.backup.unlock.disableProtectionHint')),
      ]);
      const unlockSealedBody = () => h('div', {
        key: 'body',
        className: 'w2mBackup_hint',
        'data-w2m-backup-unlock-state': unlockState,
      }, [
        unlockInitialized,
        unlockEnvelopes,
        // 分支一：本机信封（DPAPI）。可用时给按钮，按钮只发 {"confirm":"unlock"}，不带任何凭据。
        h('div', { key: 'machine', className: 'w2mBackup_row' }, [
          h('span', { key: 'text' }, unlock.machine_available === true
            ? t('panel.backup.unlock.machineAvailable')
            : t('panel.backup.unlock.machineUnavailable', { reason: String(unlock.machine_reason ?? '—') })),
          unlock.machine_available === true
            ? h('button', {
                key: 'unlock',
                type: 'button',
                className: 'w2mBackup_btn w2mBackup_btnPrimary',
                'data-w2m-backup-action': 'unlock',
                disabled,
                onClick: onUnlock,
              }, busy === 'unlock' ? t('panel.backup.busy.unlock') : t('panel.backup.action.unlock'))
            : null,
        ]),
        // 分支二：账户 ID 绑定（v3.5.x 用户决定）。只比较账户唯一识别码：一致 → 账户路径可直接解锁；
        // 不一致/读不到 → 按钮禁用，文案明确要求改用解锁 PIN。账户 ID 只以后 4 位出现。
        accountBound
          ? h('div', {
              key: 'account',
              className: 'w2mBackup_row',
              'data-w2m-backup-unlock-account': accountMatched ? 'matched' : (accountMismatch ? 'mismatch' : 'unknown'),
            }, [
              h('div', { key: 'text', className: 'w2mBackup_hint' }, [
                h('div', { key: 'bound' }, t('panel.backup.unlock.accountBound', { hint: accountHint })),
                h('div', { key: 'state' }, accountMatched
                  ? t('panel.backup.unlock.accountMatched')
                  : (accountMismatch ? t('panel.backup.unlock.accountMismatch') : t('panel.backup.unlock.accountUnavailable'))),
              ]),
              h('button', {
                key: 'unlockAccount',
                type: 'button',
                className: 'w2mBackup_btn w2mBackup_btnPrimary',
                'data-w2m-backup-action': 'unlock-account',
                disabled: accountMatched !== true || disabled || runMissing === true,
                onClick: onUnlock,
              }, busy === 'unlock' ? t('panel.backup.busy.unlock') : t('panel.backup.action.unlockAccount')),
            ])
          : null,
        // 分支三：密码/PIN 路径。HTTP 永远不接收密码，所以这里只有说明和 CLI 命令，没有输入框。
        h('div', { key: 'password' }, unlock.password_required === true ? t('panel.backup.unlock.passwordPath') : t('panel.backup.unlock.noPassword')),
        unlock.password_required === true && accountMismatch
          ? h('div', { key: 'passwordHint', 'data-w2m-backup-unlock-password-hint': 'true' }, t('panel.backup.unlock.passwordHint'))
          : null,
        unlock.password_required === true
          ? h('div', { key: 'weakPin', 'data-w2m-backup-unlock-weak-pin': 'true' }, t('panel.backup.unlock.weakPinHint'))
          : null,
        h('div', {
          key: 'disableHint',
          className: 'w2mBackup_hint',
          'data-w2m-backup-disable-protection-hint': 'true',
        }, t('panel.backup.unlock.disableProtectionHint')),
      ]);
      const unlockCard = h('div', {
        key: 'unlock',
        className: 'w2mBackup_card',
        'data-w2m-backup-panel': 'unlock',
        'data-w2m-backup-unlock-mode': unlockEncryption ?? 'unknown',
      }, [
        h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
          h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.unlock.title')),
          unlockEncryption === null
            ? null
            : h('span', {
                key: 'mode',
                className: 'w2mBackup_tag',
                'data-kind': unlockEncryption === 'none' ? 'differs' : 'new',
                'data-w2m-backup-mode': unlockEncryption,
              }, t('panel.backup.mode.' + unlockEncryption)),
          // v3.5.x：可见的对话框入口。卡片自身不因为 describe 缺失而禁用入口——对话框会显示 unknown
          // 状态和密码路径，这比一个沉默的卡片有用。
          h('button', {
            key: 'openDialog',
            type: 'button',
            className: 'w2mBackup_btn',
            title: t('panel.backup.unlock.dialog.open'),
            'data-w2m-backup-unlock-open': 'true',
            onClick: (event) => onOpenUnlockDialog(event !== null && event !== undefined ? event.currentTarget : null),
          }, t('panel.backup.unlock.dialog.open')),
        ]),
        unlock === null || unlock === undefined
          ? h('div', { key: 'loading', className: 'w2mBackup_empty' }, runMissing === true ? t('panel.backup.notEnabled') : t('panel.backup.loading'))
          : (unlockUnencrypted ? unlockNoneBody : unlockSealedBody()),
      ]);

      const logCard = h('div', { key: 'log', className: 'w2mBackup_card', 'data-w2m-backup-panel': 'log' }, [
        h('div', { key: 'head', className: 'w2mBackup_cardHead' }, [
          h('span', { key: 'title', className: 'w2mBackup_cardTitle' }, t('panel.backup.log.title', { max: BACKUP_MAX_LOG })),
        ]),
        entries.length === 0
          ? h('div', { key: 'empty', className: 'w2mBackup_empty' }, t('panel.backup.log.empty'))
          : h('div', { key: 'rows', className: 'w2mBackup_log' }, entries.slice().reverse().map((entry, index) => h('div', {
              key: 'row:' + index,
              className: 'w2mBackup_logRow',
              'data-w2m-backup-log-row': String(entry?.action ?? ''),
            }, [
              h('span', { key: 'time', className: 'w2mBackup_logTime' }, backupTimeText(entry?.at)),
              h('span', { key: 'action', className: 'w2mBackup_logAction' }, backupActionText(entry?.action, t)),
              h('span', {
                key: 'result',
                className: 'w2mBackup_logResult',
                'data-tone': entry?.ok === true ? 'ok' : 'err',
                // 结果列显示译文；原始稳定代码放在 title 里，排障时仍然拿得到。
                title: entry?.ok === true ? 'OK' : String(entry?.code ?? ''),
              }, entry?.ok === true ? t('panel.backup.log.ok') : backupReasonText(entry?.code, t)),
              entry?.detail === null || entry?.detail === undefined
                ? null
                : h('span', { key: 'detail', className: 'w2mBackup_logDetail', title: String(entry.detail) }, String(entry.detail)),
            ]))),
      ]);

      const errorCard = error === null || error === undefined
        ? null
        : h('div', { key: 'error', className: 'w2mBackup_error', 'data-w2m-backup-panel': 'error', role: 'alert' }, [
            h('div', { key: 'title', className: 'w2mBackup_errorTitle' }, t('panel.backup.error.title') + '：' + backupReasonText(error.code, t)),
            error.detail === null || error.detail === undefined
              ? null
              : h('div', { key: 'detail', className: 'w2mBackup_errorDetail' }, String(error.detail)),
          ]);

      const lastText = backupLastActionText(lastAction, t);
      const resultCard = lastText === ''
        ? null
        : h('div', {
            key: 'result',
            className: 'w2mBackup_card w2mBackup_result',
            'data-w2m-backup-panel': 'result',
            'data-tone': lastAction?.result?.ok === true ? 'ok' : 'err',
          }, lastText);

      return h('div', { className: 'w2mBackup_wrap', 'data-w2m-backup-panel': 'page' }, h('div', { className: 'w2mBackup_inner' }, [
        h('div', { key: 'head', className: 'w2mBackup_head' }, [
          h('h1', { key: 'title', className: 'w2mBackup_title' }, t('panel.backup.title')),
        ]),
        h('p', { key: 'sub', className: 'w2mBackup_sub' }, t('panel.backup.subtitle')),
        errorCard,
        resultCard,
        statusCard,
        oldUsageCard,
        approvalPendingCard,
        operationsCard,
        scopeCard,
        planCard,
        verifyCard,
        unlockCard,
        logCard,
        // v3.5.x: the modal action surface. It renders null while closed, so the page's tree keeps its
        // existing cards; when open it is a real dialog with its own focus/Escape/backdrop handling.
        h(BackupUnlockDialog, {
          key: 'unlockDialog',
          t,
          open: unlockDialogOpen,
          unlock,
          busy,
          runMissing,
          triggerRef: unlockTriggerRef,
          onClose: onCloseUnlockDialog,
          onConfirm: onConfirmUnlock,
          onRefresh: onRefreshUnlock,
        }),
        // v3.5.0: the full-copy cap approval modal. Rendering is inert until opened; the confirm action is the only
        // path that re-posts the refused run with `allowLargeFullCopy: true`.
        h(BackupApprovalDialog, {
          key: 'approvalDialog',
          t,
          open: approvalOpen === true && dialogApproval !== null,
          approval: dialogApproval,
          busy,
          triggerRef: approvalTriggerRef,
          onClose: onCloseApproval,
          onConfirm: onConfirmApproval,
        }),
      ].filter((node) => node !== null && node !== undefined)));
    }

    /**
     * v3.4.9 左侧边栏入口「备份&还原」。
     *
     * 图标是内联 SVG 且用 `currentColor`，所以它在浅色/深色主题下都跟着宿主的文字色走，不需要
     * 外部资源。点击事件只是让已经挂载的面板立即刷新一次（面板自己也按 BACKUP_POLL_MS 轮询）；
     * 切到面板页本身由宿主按 panellist id + main key 完成，与 GPW 同构。
     */
    function BackupSidebarIcon(properties) {
      const t = typeof properties?.t === 'function' ? properties.t : makeTranslator(() => undefined);
      return h('button', {
        type: 'button',
        className: 'w2mBackup_sideEntry',
        'data-w2m-backup-sidebar': 'true',
        title: t('panel.backup.sidebarTitle'),
        onClick: () => {
          try { window.dispatchEvent(new CustomEvent('w2m-backup-open')); } catch { /* headless */ }
        },
      }, [
        h('svg', {
          key: 'icon',
          className: 'w2mBackup_sideIcon',
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        }, [
          h('path', { key: 'box', d: 'M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z' }),
          h('path', { key: 'lid', d: 'M4 7.5 12 12l8-4.5M12 12v9' }),
          h('path', { key: 'arrow', d: 'M9.6 8.4 12 6l2.4 2.4' }),
        ]),
        h('span', { key: 'label', className: 'w2mBackup_sideLabel' }, t('panel.backup.title')),
      ]);
    }

    /**
     * v3.4.9 面板页（main 槽位，key `w2m-backup`）。
     *
     * 状态与副作用都在这里：挂载时读 status/run/unlock 与只读 scan，之后每 BACKUP_POLL_MS（10 秒）
     * 刷新一次便宜的 status/run（unlock 的 GET 会做一次真实的 DPAPI 探针，只在挂载和操作后读；scan
     * 只在挂载、手动「刷新会话」与备份操作后读），卸载时 clearInterval。React 把组件的 effect cleanup
     * 当作 slot 交给页面的 disposer，所以页面离开时定时器一定被清掉；没有 window 的环境（bundle 测试
     * 沙箱）根本不启动轮询。每次操作结束都重读状态；失败只记录并保持按钮可用，再点一次就是重试。
     */
    function BackupMainPage(properties) {
      const t = typeof properties?.t === 'function' ? properties.t : makeTranslator(() => undefined);
      const [repo, setRepo] = React.useState(null);
      const [status, setStatus] = React.useState(null);
      const [unlock, setUnlock] = React.useState(null);
      const [plan, setPlan] = React.useState(null);
      const [selected, setSelected] = React.useState([]);
      const [busy, setBusy] = React.useState('');
      const [restoreArmed, setRestoreArmed] = React.useState(false);
      const [archiveScope, setArchiveScope] = React.useState('archived');
      const [log, setLog] = React.useState([]);
      const [verify, setVerify] = React.useState(null);
      // 慢路径是显式开关：默认 false，只有勾选时 verifyNow 才请求 ?runtime=1（G5 的终审证据）。
      const [verifyRuntime, setVerifyRuntime] = React.useState(false);
      const [lastAction, setLastAction] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [runMissing, setRunMissing] = React.useState(false);
      // v3.5.0 备份范围：scan === null 表示还没读到（不是"没有会话"）；picked 是页面内勾选，刷新扫描时
      // 会剪掉已经不存在的 id，不持久化也不发往除 run 请求体以外的任何地方。
      const [scan, setScan] = React.useState(null);
      const [picked, setPicked] = React.useState([]);
      // 宿内注册表修复的最近一次结果（只在页面内保留；刷新/重开页面即清空，不落盘）。
      const [registerFix, setRegisterFix] = React.useState(null);
      // v3.5.x 解锁对话框：打开状态在页面里，触发按钮的 DOM 节点也记在这里，关闭后焦点回到它。
      const [unlockDialogOpen, setUnlockDialogOpen] = React.useState(false);
      const unlockDialogTriggerRef = React.useRef(null);
      // v3.5.0 整文件副本上限：pending 的「特批请求」（来自本次 run 的拒绝响应，或宿主 state.last_result 的定时拒绝），
      // 对话框开关，以及触发按钮（关闭后焦点回到它）。这里不保存任何自动批准：只有确认按钮会发 allowLargeFullCopy。
      const [approval, setApproval] = React.useState(null);
      const [approvalDialogOpen, setApprovalDialogOpen] = React.useState(false);
      const approvalTriggerRef = React.useRef(null);
      // v3.5.0 §24.3 old/ 占用提醒：「如何清理」的展开状态只在页面内；提醒对象本身来自宿主持久化的 state.old_usage。
      const [oldUsageHelpOpen, setOldUsageHelpOpen] = React.useState(false);
      const aliveRef = React.useRef(true);

      const record = (action, result) => {
        setLastAction({ action, result });
        setLog((entries) => appendBackupLog(entries, backupLogEntry(action, result)));
      };
      const fail = (result) => {
        if (result?.ok === true) return;
        setError({ code: String(result?.reason_code ?? 'BACKUP_FAILED'), detail: typeof result?.detail === 'string' ? result.detail : null });
      };
      /**
       * v3.5.0 整文件副本上限：把一次 run 的拒绝折成「待特批」状态并打开确认对话框。
       *
       * 只认这个具名代码（其它拒绝仍走错误卡）；成功时清掉旧的特批请求——定时路径的待批准状态由
       * `state.last_result` 重新推导，本地不再保留过期结论。这里只记录状态，不发任何请求。
       */
      const noteFullCopyApproval = (result, scope, selected) => {
        if (result?.ok === true) {
          setApproval(null);
          return false;
        }
        const request = backupApprovalRequest(result, scope, selected);
        if (request === null) return false;
        setApproval(request);
        setApprovalDialogOpen(true);
        return true;
      };
      const refresh = async () => {
        // 先读 run 的 GET：它同时给运行状态和（v3.4.9 宿主）内嵌的只读 status。老宿主没有内嵌
        // status 时，再单独读一次常驻的 /status；两种宿主下页面的信息量一致。
        const runRead = await callBackup(BACKUP_RUN_ROUTE, { method: 'GET' });
        if (aliveRef.current !== true) return;
        let repoRead = null;
        if (runRead.http === true) {
          setStatus(runRead.body);
          setRunMissing(false);
          if (runRead.body?.status !== null && runRead.body?.status !== undefined && typeof runRead.body.status === 'object') {
            repoRead = { http: true, body: runRead.body.status };
          }
        } else {
          setStatus(null);
          setRunMissing(runRead.routeMissing === true);
        }
        if (repoRead === null) repoRead = await callBackup(BACKUP_STATUS_ROUTE, { method: 'GET' });
        if (aliveRef.current !== true) return;
        setRepo(repoRead.http === true ? repoRead.body : null);
      };
      /**
       * 只读会话扫描。`?detail=1` 是宿主返回 `sessions` 明细的开关（不带时只有 totals/registry）。
       * 路由缺失（404）、传输失败、坏响应都折成 `{available:false}`：面板显示中性提示 + 重试按钮，
       * 绝不抛异常、也绝不挡住状态卡与四个既有操作。
       */
      const refreshScan = async () => {
        let normalized;
        try {
          const result = await callBackup(BACKUP_SCAN_ROUTE + BACKUP_SCAN_QUERY, { method: 'GET' });
          normalized = normalizeBackupScan(result);
        } catch (error) {
          normalized = {
            available: false,
            sessions: [],
            total: 0,
            routeMissing: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        if (aliveRef.current !== true) return normalized;
        setScan(normalized);
        // 扫描后剪掉已经不存在的勾选：选中集合永远是当前扫描结果的子集（不持久化）。
        setPicked((current) => {
          const ids = new Set(normalized.sessions.map((session) => session.session_id));
          const list = Array.isArray(current) ? current : [];
          const kept = list.filter((id) => ids.has(id));
          return kept.length === list.length ? current : kept;
        });
        return normalized;
      };
      const refreshUnlock = async () => {
        const result = await callBackup(BACKUP_UNLOCK_ROUTE, { method: 'GET' });
        if (aliveRef.current === true && result.http === true) setUnlock(result.body);
      };
      const refreshAll = async () => {
        // 挂载与「刷新」按钮都走这里：状态、解锁描述与只读会话扫描一起重读（扫描失败不影响前两者）。
        await Promise.all([refresh(), refreshUnlock(), refreshScan()]);
      };

      React.useEffect(() => {
        aliveRef.current = true;
        void refreshAll();
        let timer = null;
        if (typeof window !== 'undefined' && typeof setInterval === 'function') {
          timer = setInterval(() => { void refresh(); }, BACKUP_POLL_MS);
          try { timer?.unref?.(); } catch { /* browser timer */ }
        }
        const hostWindow = typeof window === 'undefined' ? null : window;
        const onOpen = () => { void refresh(); };
        try { hostWindow?.addEventListener?.('w2m-backup-open', onOpen); } catch { /* headless */ }
        return () => {
          aliveRef.current = false;
          if (timer !== null && typeof clearInterval === 'function') clearInterval(timer);
          try { hostWindow?.removeEventListener?.('w2m-backup-open', onOpen); } catch { /* headless */ }
        };
      }, []);

      const runNow = async () => {
        if (busy !== '' || runMissing === true) return;
        setBusy('run');
        setError(null);
        try {
          const result = await callBackup(BACKUP_RUN_ROUTE, { method: 'POST', body: JSON.stringify({ confirm: 'run', scope: 'all' }) });
          record('run', result);
          fail(result);
          noteFullCopyApproval(result, 'all', []);
          await refresh();
        } finally {
          setBusy('');
        }
      };
      /**
       * v3.5.0 的两个范围入口：同一个 `POST /run`、同一个确认令牌，只有 `scope`（与 `selected` 列表）
       * 不同。选择来自只读扫描；拒绝（200 + `ok:false`，例如 BACKUP_SCOPED_NOTHING）走既有错误卡把
       * 稳定原因码翻成可操作的句子，不抛异常。成功后重读状态与扫描（勾选可能已被这次备份改变）。
       */
      const runScopeNow = async (scope) => {
        if (busy !== '' || runMissing === true) return;
        const pickedIds = Array.isArray(picked) ? picked.slice() : [];
        if (scope === 'selected' && pickedIds.length === 0) return;
        const token = scope === 'selected' ? 'backup-selected' : 'backup-active';
        setBusy(token);
        setError(null);
        try {
          const body = scope === 'selected'
            ? { confirm: 'run', scope: 'selected', selected: pickedIds }
            : { confirm: 'run', scope: 'active' };
          const result = await callBackup(BACKUP_RUN_ROUTE, { method: 'POST', body: JSON.stringify(body) });
          record(token, result);
          fail(result);
          noteFullCopyApproval(result, scope, pickedIds);
          await Promise.all([refresh(), refreshScan()]);
        } finally {
          setBusy('');
        }
      };
      /**
       * v3.5.0 「特批并继续」：用同一个确认令牌重发同一次 run，只多一个 `allowLargeFullCopy: true`。
       *
       * 这是面板里唯一能批准超限写入的动作；取消/关闭不发请求，定时路径永远不会走到这里。scope 来自被拒绝的
       * 那次 run（定时拒绝则来自 state.last_result 的 scope），selected 只在 scope='selected' 时带上。
       * 失败时保留对话框并显示错误卡，成功则关闭对话框并刷新（旧版本记录上会出现 approved_over_cap）。
       */
      const approveFullCopyNow = async () => {
        if (busy !== '') return null;
        const descriptor = approval ?? backupPendingApproval(status);
        if (descriptor === null) return null;
        const selected = descriptor.scope === 'selected'
          ? (Array.isArray(descriptor.selected) && descriptor.selected.length > 0
              ? descriptor.selected
              : (Array.isArray(picked) ? picked.slice() : []))
          : [];
        setBusy('run');
        setError(null);
        try {
          const body = {
            confirm: 'run',
            scope: descriptor.scope,
            allowLargeFullCopy: true,
            ...(descriptor.scope === 'selected' ? { selected } : {}),
          };
          const result = await callBackup(BACKUP_RUN_ROUTE, { method: 'POST', body: JSON.stringify(body) });
          record('run', result);
          fail(result);
          if (result.ok === true) {
            setApproval(null);
            setApprovalDialogOpen(false);
          }
          await Promise.all([refresh(), refreshScan()]);
          return result;
        } finally {
          setBusy('');
        }
      };
      /**
       * v3.5.0 §24.3「知道了」：只把确认水位移到当前字节数并清掉待处理提醒，**不删除任何文件**。
       *
       * 请求体只有确认令牌（`{confirm:'ack'}`）；成功后重读状态，卡片因为 `state.old_usage.due` 变成 false 而消失。
       * 这是提醒的唯一动作；清理是终端里的 `w2m-backup gc`，面板从不执行。
       */
      const ackOldUsageNow = async () => {
        if (busy !== '' || runMissing === true) return;
        setBusy('old-usage-ack');
        setError(null);
        try {
          const result = await callBackup(BACKUP_OLD_USAGE_ACK_ROUTE, {
            method: 'POST',
            body: JSON.stringify({ confirm: BACKUP_OLD_USAGE_ACK_TOKEN }),
          });
          record('ack-old-usage', result);
          fail(result);
          if (result.ok === true) setOldUsageHelpOpen(false);
          await refresh();
        } finally {
          setBusy('');
        }
      };
      const planRestore = async (sessions, arm) => {
        setBusy('plan');
        setError(null);
        try {
          const result = await callBackup(BACKUP_RESTORE_ROUTE, {
            method: 'POST',
            body: JSON.stringify({ confirm: 'restore', ...(sessions.length > 0 ? { sessions } : {}) }),
          });
          record('plan', result);
          if (result.ok !== true || result.body?.ok !== true) {
            setPlan(null);
            setRestoreArmed(false);
            fail(result);
            return false;
          }
          const candidates = Array.isArray(result.body.candidates) ? result.body.candidates : [];
          setPlan(result.body);
          setSelected((current) => {
            const kept = current.filter((id) => candidates.some((candidate) => candidate.session_id === id));
            return kept.length > 0 ? kept : candidates.map((candidate) => candidate.session_id);
          });
          setRestoreArmed(arm === true);
          return true;
        } finally {
          setBusy('');
        }
      };
      const applySelectedRestore = async () => {
        setBusy('restore');
        setError(null);
        try {
          const sessions = Array.isArray(selected) ? selected : [];
          const result = await callBackup(BACKUP_RESTORE_ROUTE, {
            method: 'POST',
            body: JSON.stringify({ confirm: 'restore', apply: true, ...(sessions.length > 0 ? { sessions } : {}) }),
          });
          record('restore', result);
          fail(result);
          setRestoreArmed(false);
          if (result.ok === true && result.body?.ok === true) setPlan(null);
          await Promise.all([refresh(), refreshUnlock()]);
        } finally {
          setBusy('');
        }
      };
      const archiveNow = async () => {
        setBusy('archive');
        setError(null);
        try {
          const result = await callBackup(BACKUP_ARCHIVE_ROUTE, { method: 'POST', body: JSON.stringify({ confirm: 'archive', scope: archiveScope }) });
          record('archive', result);
          fail(result);
          await refresh();
        } finally {
          setBusy('');
        }
      };
      const verifyNow = async () => {
        setBusy('verify');
        setError(null);
        try {
          // 勾选框决定是否让宿主用安装的 Harness 终审（慢）；默认只跑便宜的那条。
          const url = BACKUP_VERIFY_ROUTE + (verifyRuntime === true ? '?runtime=1' : '');
          const result = await callBackup(url, { method: 'GET' });
          record('verify', result);
          if (result.ok === true) setVerify(result.body);
          else {
            setVerify(null);
            fail(result);
          }
          await refresh();
        } finally {
          setBusy('');
        }
      };
      /**
       * 「立即运行」：同步跑一次运行时终审。这是面板里唯一会 spawn 安装的 Harness 的按钮（慢）；结束后重读
       * 内嵌状态，缓存记录（state.last_runtime_verify）随之更新，缓存块显示的就是刚生成的那一份。
       */
      const verifyRuntimeNow = async () => {
        if (busy !== '' || runMissing === true) return;
        setBusy('verify-runtime');
        setError(null);
        try {
          const result = await callBackup(BACKUP_VERIFY_ROUTE + '?runtime=1', { method: 'GET' });
          record('verify-runtime', result);
          if (result.ok === true) setVerify(result.body);
          else {
            setVerify(null);
            fail(result);
          }
          await refresh();
        } finally {
          setBusy('');
        }
      };
      /**
       * 「修复注册表」：在宿主内规划 + 写入 + 有界监视（G2 的面板路径）。登记勾选会话；没有勾选就登记扫描到的
       * 未登记会话。按钮不发空请求；结果是计数，残余风险由视图单独一行说明。
       */
      const repairRegisterNow = async () => {
        if (busy !== '' || runMissing === true) return;
        const rows = Array.isArray(scan?.sessions) ? scan.sessions : [];
        const pickedList = Array.isArray(picked) ? picked.slice() : [];
        const ids = pickedList.length > 0
          ? pickedList
          : rows
              .filter((session) => session?.registered !== true)
              .map((session) => String(session?.session_id ?? ''))
              .filter((sessionId) => sessionId !== '');
        if (ids.length === 0) return;
        setBusy('repair-register');
        setError(null);
        try {
          const result = await callBackup(BACKUP_REGISTER_ROUTE, {
            method: 'POST',
            body: JSON.stringify({ confirm: 'register', session_ids: ids }),
          });
          record('repair-register', result);
          if (result.http === true && result.body !== null && typeof result.body === 'object') setRegisterFix(result.body);
          fail(result);
          await Promise.all([refresh(), refreshScan()]);
        } finally {
          setBusy('');
        }
      };
      const unlockNow = async () => {
        setBusy('unlock');
        setError(null);
        try {
          // 只发确认令牌：凭据是宿主侧的本机信封，浏览器从不接触密码。
          const result = await callBackup(BACKUP_UNLOCK_ROUTE, { method: 'POST', body: JSON.stringify({ confirm: 'unlock' }) });
          record('unlock', result);
          fail(result);
          await Promise.all([refresh(), refreshUnlock()]);
          // 对话框用这个返回值决定显示成功还是把失败码翻成文案；旧的内联按钮忽略它。
          return result;
        } finally {
          setBusy('');
        }
      };
      const toggleSession = (sessionId) => {
        setSelected((current) => (current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId]));
      };
      /** 备份范围的勾选：与还原计划的 `selected` 是两个独立列表（见视图里注释）。 */
      const togglePick = (sessionId) => {
        setPicked((current) => {
          const list = Array.isArray(current) ? current : [];
          return list.includes(sessionId) ? list.filter((id) => id !== sessionId) : [...list, sessionId];
        });
      };
      const pickAllSessions = () => setPicked(
        (Array.isArray(scan?.sessions) ? scan.sessions : []).map((session) => String(session?.session_id ?? '')),
      );
      const clearPicked = () => setPicked([]);

      return h(BackupPanelView, {
        t,
        repo,
        status,
        unlock,
        plan,
        selected,
        busy,
        log,
        verify,
        lastAction,
        error,
        registerFix,
        archiveScope,
        restoreArmed,
        runMissing,
        verifyRuntime,
        onRefresh: () => { void refreshAll(); },
        onRun: () => { void runNow(); },
        onPlan: () => { void planRestore([], false); },
        onRestore: () => {
          if (restoreArmed) void applySelectedRestore();
          else void planRestore(Array.isArray(selected) ? selected : [], true);
        },
        onCancelRestore: () => setRestoreArmed(false),
        onToggleSession: toggleSession,
        onSelectAll: () => setSelected((Array.isArray(plan?.candidates) ? plan.candidates : []).map((candidate) => String(candidate.session_id ?? ''))),
        onClearSelection: () => setSelected([]),
        // v3.5.0 备份范围入口的视图接线：扫描会话的勾选与两个 run 范围。
        scan,
        picked,
        onScan: () => { void refreshScan(); },
        onTogglePick: togglePick,
        onPickAll: pickAllSessions,
        onPickClear: clearPicked,
        onBackupSelected: () => { void runScopeNow('selected'); },
        onBackupActive: () => { void runScopeNow('active'); },
        onArchiveScope: (value) => setArchiveScope(value === 'all' ? 'all' : 'archived'),
        onArchive: () => { void archiveNow(); },
        onVerify: () => { void verifyNow(); },
        onVerifyRuntime: (next) => setVerifyRuntime(next === true),
        onVerifyRuntimeNow: () => { void verifyRuntimeNow(); },
        onRegisterFix: () => { void repairRegisterNow(); },
        onUnlock: () => { void unlockNow(); },
        // v3.5.x 解锁对话框接线：打开时记住触发按钮；确认复用 unlockNow（同一 POST 体）；刷新重读 describe+状态。
        unlockDialogOpen,
        unlockTriggerRef: unlockDialogTriggerRef,
        onOpenUnlockDialog: (trigger) => {
          unlockDialogTriggerRef.current = trigger ?? null;
          setUnlockDialogOpen(true);
        },
        onCloseUnlockDialog: () => setUnlockDialogOpen(false),
        onConfirmUnlock: () => unlockNow(),
        onRefreshUnlock: async () => { await Promise.all([refresh(), refreshUnlock()]); },
        // v3.5.0 整文件副本上限：待特批状态与确认对话框。打开只记录触发按钮；确认才发 allowLargeFullCopy:true。
        approval,
        approvalOpen: approvalDialogOpen,
        approvalTriggerRef,
        onOpenApproval: (trigger) => {
          approvalTriggerRef.current = trigger ?? null;
          setApprovalDialogOpen(true);
        },
        onCloseApproval: () => setApprovalDialogOpen(false),
        onConfirmApproval: () => approveFullCopyNow(),
        // v3.5.0 §24.3 old/ 占用提醒（提醒不是上限）：「知道了」走 ack 路由且不删除；「如何清理」只展开终端 gc 指引。
        oldUsageHelpOpen,
        onAckOldUsage: () => { void ackOldUsageNow(); },
        onToggleOldUsageHelp: () => setOldUsageHelpOpen((value) => value !== true),
      });
    }

    function FleetChat({ sessionId, viewMode }) {
      // v1.9.18: chat emotes are local slash commands, never image bytes. The relay only sees text.
const CHAT_COMMANDS = ['/微笑', '/火箭', '/烟花'];
// v1.9.18: the sticker pack is local to the plugin. Commands travel as text; rendering never requests bytes.
const CHAT_STICKER_GLYPHS = { '/微笑': '\u{1F60A}', '/火箭': '\u{1F680}', '/烟花': '\u{1F386}' };
const CHAT_STICKER_RE = /(\/微笑|\/火箭|\/烟花)/g;
function renderChatText(text) {
  const raw = String(text ?? '');
  const whole = CHAT_STICKER_GLYPHS[raw.trim()];
  if (whole !== undefined) return h('span', { className: 'w2mChat_stickerBig', 'data-sticker': raw.trim(), title: raw.trim() }, whole);
  const parts = raw.split(CHAT_STICKER_RE);
  if (parts.length === 1) return raw;
  return parts.map((part, index) => (CHAT_STICKER_GLYPHS[part] !== undefined
    ? h('span', { key: 'st' + index, className: 'w2mChat_sticker', 'data-sticker': part, title: part }, CHAT_STICKER_GLYPHS[part])
    : part));
}
const CHAT_EMOJIS = CHAT_COMMANDS;
      const [open, setOpen] = React.useState(false);
      const [messages, setMessages] = React.useState([]);
      const [usage, setUsage] = React.useState(null);
      const [localMachineName, setLocalMachineName] = React.useState(null);
      const [roster, setRoster] = React.useState(null);
      const [toRecipient, setToRecipient] = React.useState('all');
      const [replyTo, setReplyTo] = React.useState(null);
      const [tasks, setTasks] = React.useState([]);
      const [lastSeenMs, setLastSeenMs] = React.useState(() => {
        try {
          const raw = globalThis.localStorage?.getItem('w2m:chat:seen:' + sessionId);
          const parsed = Number.parseInt(raw ?? '', 10);
          return Number.isFinite(parsed) ? parsed : 0;
        } catch {
          return 0;
        }
      });
      const [text, setText] = React.useState('');
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [localMachineId, setLocalMachineId] = React.useState(null);
      // v1.7.2: screenshot state is clipboard-only (no preview); `toast` is the only visible feedback.
      const [shotBusy, setShotBusy] = React.useState(false);
      const [chatFull, setChatFull] = React.useState(false);
      React.useEffect(() => { if (viewMode === true) setOpen(true); }, [viewMode]);
      React.useEffect(() => {
        const onFull = () => { setChatFull(true); setOpen(true); };
        window.addEventListener('w2m-chat-full', onFull);
        return () => window.removeEventListener('w2m-chat-full', onFull);
      }, []);
      const [toast, setToast] = React.useState(null);
      // v1.6.10: screenshot support (button + Ctrl+P). The blob is previewed and copied to the
      // clipboard; the relay's chat payload stays text, so an image cannot be broadcast as a message.

      const load = React.useCallback(async (signal) => {
        if (typeof sessionId !== 'string' || sessionId === '') return;
        const result = await chatCall({
          url: `${CHAT_ROUTE}?session_id=${encodeURIComponent(sessionId)}&limit=50`,
          init: { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, signal },
        });
        if (result.ok) {
          setMessages(Array.isArray(result.state.messages) ? result.state.messages : []);
        setLocalMachineId(typeof result.state.local_machine_id === 'string' ? result.state.local_machine_id : null);
        setLocalMachineName(typeof result.state.local_machine_name === 'string' && result.state.local_machine_name !== '' ? result.state.local_machine_name : null);
          setUsage(result.state.usage ?? null);
          setError(null);
        } else {
          setError(result.error);
        }
      }, [sessionId]);

      React.useEffect(() => {
        if (!open) return undefined;
        const controller = new AbortController();
        load(controller.signal);
        const timer = setInterval(() => load(controller.signal), 3000);
        return () => {
          controller.abort();
          clearInterval(timer);
        };
      }, [open, load]);

      // The chat messages carry a machine id, not a name: the relay stores what a sender proves, and a name is
      // not one of those proofs. The roster the target control already reads is where names live, so the panel
      // borrows it once per open instead of inventing a label from the id.
      React.useEffect(() => {
        if (!open || typeof sessionId !== 'string' || sessionId === '') return undefined;
        const controller = new AbortController();
        readState(sessionId, controller.signal).then((result) => {
          if (controller.signal.aborted) return;
          setRoster(result.ok ? result.state : null);
        });
        return () => controller.abort();
      }, [open, sessionId]);

      // The task board is the relay's own list: the host proxies it so the panel never holds a device token.
      React.useEffect(() => {
        if (!open) return undefined;
        const controller = new AbortController();
        chatCall({ url: '/api/w2m/tasks?limit=20', init: { signal: controller.signal } })
          .then((result) => { if (!controller.signal.aborted) setTasks(result.ok && Array.isArray(result.data?.tasks) ? result.data.tasks : []); })
          .catch(() => { /* the board is an extra; a failed read must not break the chat */ });
        return () => controller.abort();
      }, [open]);

      // Unread is measured against a per-conversation watermark in local storage: the relay stays stateless, and
      // the count answers "is there anything I have not looked at" without claiming which messages a machine read.
      React.useEffect(() => {
        if (!open || messages.length === 0) return undefined;
        const latest = messages.reduce((max, message) => (Number.isFinite(message?.at_ms) ? Math.max(max, message.at_ms) : max), 0);
        if (latest <= 0 || latest <= lastSeenMs) return undefined;
        setLastSeenMs(latest);
        try { globalThis.localStorage?.setItem('w2m:chat:seen:' + sessionId, String(latest)); } catch { /* storage may be unavailable */ }
        return undefined;
      }, [open, messages, sessionId, lastSeenMs]);

      // Consecutive messages that share a thread are shown under one thread head. Grouping only consecutive runs keeps
      // the reading order the relay assigned -- re-sorting by thread would put an answer above the question it answers.
      const groupThreads = (list) => {
        const groups = [];
        for (const message of list ?? []) {
          const threadId = typeof message?.thread_id === 'string' && message.thread_id !== '' ? message.thread_id : null;
          const last = groups[groups.length - 1] ?? null;
          if (last !== null && last.threadId === threadId) { last.messages.push(message); continue; }
          groups.push({ threadId, messages: [message] });
        }
        return groups;
      };

      const send = React.useCallback(async () => {
        const value = text.trim();
        if (value === '' || busy) return undefined;
        setBusy(true);
        const result = await chatCall({
          url: CHAT_ROUTE,
          init: {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              session_id: sessionId,
              text: value,
              ...(toRecipient === 'all' ? {} : { to: toRecipient }),
              ...(replyTo === null ? {} : { reply_to: replyTo.id, ...(replyTo.threadId === null ? {} : { thread_id: replyTo.threadId }) }),
            }),
          },
        });
        setBusy(false);
        if (result.ok) {
          setText('');
          setReplyTo(null);
          await load();
        } else {
          setError(result.error);
        }
        return undefined;
      }, [busy, load, sessionId, text]);
        // v1.6.10: clipboard text with a fallback for hosts where navigator.clipboard is absent.
        // v1.7.1: copy through the renderer when allowed, then through the host clipboard route.
        // The DSH desktop shell rejects navigator.clipboard, which is why v1.7.0's copy button failed there.
        const copyText = React.useCallback((value) => {
          const textValue = String(value ?? '');
          if (textValue === '') return undefined;
          const hostFallback = async () => {
            try {
              const response = await fetch(CLIPBOARD_ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ text: textValue }) });
              const body = await response.json().catch(() => null);
              if (response.ok === true && body?.ok === true) { setToast('已复制（宿主侧）'); return undefined; }
            } catch { /* fall through to the textarea path */ }
            try {
              const area = document.createElement('textarea');
              area.value = textValue; area.style.position = 'fixed'; area.style.opacity = '0';
              document.body.appendChild(area); area.select(); document.execCommand('copy'); document.body.removeChild(area);
              setToast('已复制');
            } catch { setToast('复制失败'); }
            return undefined;
          };
          try {
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(textValue).then(() => setToast('已复制'), () => { hostFallback(); });
              return undefined;
            }
          } catch { /* fall through */ }
          hostFallback();
          return undefined;
        }, []);

        // v1.6.10: capture one frame of a user-picked screen/window, preview it, and copy the PNG to the
        // clipboard. getDisplayMedia needs the gesture the button/keypress provides; every failure is
        // reported in the panel rather than as an unhandled rejection.
        // v1.7.1: screenshot with a host fallback. The renderer path (getDisplayMedia) is tried first;
        // when the host forbids it -- the DSH desktop shell does -- the panel captures on the host and
        // receives JPEG base64, so the button and Ctrl+P work in both places.
        // v1.7.2: capture and COPY only -- no thumbnail in the panel (the chat got too cramped), and no
        // print-dialog shortcut stealing. The renderer path is tried first; the DSH desktop shell denies
        // getDisplayMedia, so the host route captures and copies on the host side instead.
        const captureScreenshot = React.useCallback(async () => {
          if (shotBusy) return undefined;
          setShotBusy(true); setToast(null);
          const copyImage = async (blob) => {
            try {
              if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                return true;
              }
            } catch { /* host fallback below */ }
            return false;
          };
          try {
            if (typeof navigator?.mediaDevices?.getDisplayMedia === 'function') {
              let stream = null;
              try {
                stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
                const video = document.createElement('video');
                video.srcObject = stream;
                await video.play();
                await new Promise((resolve) => { setTimeout(resolve, 180); });
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 1280;
                canvas.height = video.videoHeight || 720;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
                if (blob !== null && await copyImage(blob) === true) {
                  setToast('截图已复制到剪贴板');
                  return undefined;
                }
              } catch { /* the host fallback below is the whole point */ }
              finally { try { stream?.getTracks?.().forEach((track) => track.stop()); } catch { /* gone */ } }
            }
            const response = await fetch(CAPTURE_ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ copy: true }) });
            const body = await response.json().catch(() => null);
            if (response.ok !== true || body?.ok !== true) throw new Error(body?.error ?? ('HTTP ' + response.status));
            if (body.copied === true) setToast('截图已复制到剪贴板（宿主）');
            else setToast('截图已生成，但剪贴板不可用');
          } catch (error) {
            setToast('截图失败：' + (error instanceof Error ? error.message : String(error)));
          } finally {
            setShotBusy(false);
          }
          return undefined;
        }, [shotBusy]);

        // v1.7.2: Ctrl+Shift+P (Cmd+Shift+P) opens the capture while the panel is open. Plain Ctrl+P is left
        // alone: hijacking the browser/app print shortcut surprised testers and printed the page instead.
        React.useEffect(() => {
          if (!open) return undefined;
          const onKeyDown = (event) => {
            if (event.defaultPrevented) return;
            const modifier = event.ctrlKey === true || event.metaKey === true;
            if (modifier && event.shiftKey === true && event.altKey !== true && String(event.key).toLowerCase() === 'p') {
              event.preventDefault();
              captureScreenshot();
            }
          };
          document.addEventListener('keydown', onKeyDown, true);
          return () => document.removeEventListener('keydown', onKeyDown, true);
        }, [open, captureScreenshot]);

        // v1.7.3: screenshot feedback is ephemeral: it fades after 5s and can be closed. It must not
        // sit in the compose row (that squeezed the input) and must not accumulate with more captures.
        React.useEffect(() => {
          if (toast === null) return undefined;
          const timer = setTimeout(() => setToast(null), 5000);
          return () => clearTimeout(timer);
        }, [toast]);

      const unseenCount = messages.reduce((count, message) => (Number.isFinite(message?.at_ms) && message.at_ms > lastSeenMs ? count + 1 : count), 0);
      const disabled = typeof sessionId !== 'string' || sessionId === '';
      const usageText = usage === null ? null : `${Math.round((usage.used_24h_bytes ?? 0) / 1024)} KiB/24h · ${usage.messages ?? 0} 条`;
      const machineLabel = (message) => {
        const id = typeof message?.machine_id === 'string' ? message.machine_id : null;
        if (id === null) return '?';
        const known = Array.isArray(roster?.machines)
          ? roster.machines.find((machine) => machine.machine_id === id) ?? null
          : null;
        const mine = id === localMachineId;
        const name = known?.name ?? message?.machine_name ?? (mine ? localMachineName : null);
        const detail = mine ? '\u672c\u673a' : (known?.os ?? null);
        // A machine with no name yet is shown by a short id, never by a full UUID, and the detail says which of the
        // two it is -- "unknown" next to a UUID is what made the panel look like it was leaking identifiers.
        const shown = name ?? (id.length > 12 ? `${id.slice(0, 8)}…` : id);
        return detail === null ? shown : `${shown} · ${detail}`;
      };
      const timeLabel = (message) => (Number.isFinite(message?.at_ms) ? new Date(message.at_ms).toLocaleTimeString() : '');

      return h('span', { className: 'w2mChat' },
        h('button', {
          type: 'button',
          className: 'w2mChat_trigger',
          title: '编队聊天（本会话广播）',
          'aria-expanded': open,
          disabled,
          onClick: () => setOpen((value) => !value),
        }, '💬', h('span', { className: 'w2mChat_label' }, '编队聊天'), unseenCount > 0 && !open ? h('span', { className: 'w2mChat_unseen' }, String(unseenCount)) : null),
        open
          ? h('div', { className: 'w2mChat_panel' + (chatFull || viewMode === true ? ' w2mChat_panelFull' : '') + (viewMode === true ? ' w2mChat_view' : ''), role: 'dialog', 'aria-label': '编队聊天' },
              h('div', { className: 'w2mChat_head' },
                h('select', {
                  className: 'w2mChat_to',
                  value: toRecipient,
                  title: '收件人',
                  onChange: (event) => setToRecipient(event.target.value),
                }, [
                  h('option', { key: '__all__', value: 'all' }, '全部'),
                  ...(Array.isArray(roster?.machines) ? roster.machines.filter((machine) => machine.online === true && typeof machine.machine_id === 'string').map((machine) => h('option', { key: machine.machine_id, value: machine.machine_id }, machine.name ?? machine.machine_id)) : []),
                ]),
                h('span', null, '编队聊天'),
                usageText === null ? null : h('span', { className: 'w2mChat_usage' }, usageText),
                h('button', { type: 'button', className: 'w2mChat_close', title: '关闭', onClick: () => setOpen(false) }, '×')),
              tasks.length === 0 ? null : h('div', { className: 'w2mChat_board' }, [
                h('div', { key: 'title', className: 'w2mChat_boardTitle' }, '任务看板'),
                h('div', { key: 'counts', className: 'w2mChat_boardCounts' }, (() => { const b = { ready: 0, active: 0, waiting: 0, blocked: 0 }; for (const task of tasks) { const status = String(task?.status ?? ''); if (status === 'done' || status === 'completed') continue; if (status === 'failed' || status === 'cancelled' || status === 'refused') b.blocked += 1; else if (status === 'waiting' || (Array.isArray(task?.waiting_on) && task.waiting_on.length > 0)) b.waiting += 1; else if (status === 'active' || status === 'queued' || status === 'offered' || status === 'running') b.active += 1; else b.ready += 1; } return '准备 ' + b.ready + ' · 进行 ' + b.active + ' · 等待 ' + b.waiting + ' · 阻塞 ' + b.blocked; })()),
                ...tasks.slice(0, 6).map((task) => h('div', { key: String(task?.task_id ?? Math.random()), className: 'w2mChat_boardRow' },
                  `${String(task?.task_id ?? '').slice(0, 8)}  ${task?.mode ?? '?'}  ${task?.status ?? '?'}`)),
              ]),
              h('div', { className: 'w2mChat_list', onMouseDownCapture: (event) => { if (event.button === 0) event.stopPropagation(); }, onCopy: (event) => event.stopPropagation() },
                error !== null ? h('div', { className: 'w2mChat_error' }, error) : null,
                messages.length === 0
                  ? (error === null ? h('div', { className: 'w2mChat_empty' }, '本会话还没有消息') : null)
                  : groupThreads(messages).flatMap((group, groupIndex) => [
                      group.threadId === null ? null : h('div', { key: 'thread:' + group.threadId + ':' + groupIndex, className: 'w2mChat_threadHead' }, '#' + group.threadId),
                      ...group.messages.map((message) => {
                      var kind = messageKind(message, localMachineId);
                      return h('div', { key: message?.message_id ?? `${message?.machine_id}:${message?.at_ms}`, className: 'w2mChat_msg is-' + kind, onClick: () => { const selection = typeof window.getSelection === 'function' ? String(window.getSelection() ?? '') : ''; if (selection !== '') return; setReplyTo({ id: message?.message_id ?? null, threadId: message?.thread_id ?? null, text: typeof message?.text === 'string' ? message.text : '' }); } },
                        h('div', { className: 'w2mChat_meta' }, h(WhaleAvatar, { machineId: message?.machine_id }), `${machineLabel(message)} · ${timeLabel(message)}`, kind === 'session' ? ' · 来自会话' : '', h('button', { key: 'copy', type: 'button', className: 'w2mChat_copy', title: '复制这条消息', onClick: (event) => { event.stopPropagation(); copyText(String(message?.text ?? '')); } }, '⧉'), message?.thread_id ? h('span', { className: 'w2mChat_thread' }, '#' + message.thread_id) : null),
                        h('div', { className: 'w2mChat_text' }, renderChatText(message?.text ?? '')));
                      }),
                    ].filter((node) => node !== null))),


              (chatFull || viewMode === true) ? h('div', { className: 'w2mChat_emojiRow' }, CHAT_EMOJIS.map((emoji) => h('button', { key: emoji, type: 'button', className: 'w2mChat_emoji', onClick: () => setText((prev) => prev + emoji) }, emoji))) : null,
              h('div', { className: 'w2mChat_compose' },
                replyTo === null ? null : h('div', { className: 'w2mChat_reply' }, [
                  h('span', { key: 'label' }, '回复：' + (replyTo.text.length > 40 ? replyTo.text.slice(0, 40) + '…' : replyTo.text)),
                  h('button', { key: 'cancel', type: 'button', className: 'w2mChat_replyCancel', title: '取消回复', onClick: () => setReplyTo(null) }, '×'),
                ]),
                h('textarea', {
                  className: 'w2mChat_input',
                  value: text,
                  rows: 2,
                  placeholder: '说点什么，发给本会话的机器…',
                  disabled: busy,
                  onChange: (event) => setText(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && event.shiftKey !== true) {
                      event.preventDefault();
                      send();
                    }
                  },
                }),
                h('button', { type: 'button', className: 'w2mChat_shotButton', title: '截图并复制（Ctrl+Shift+P）', disabled: shotBusy, onClick: captureScreenshot }, shotBusy ? '截图…' : '📷'),
                  h('button', { type: 'button', className: 'w2mChat_send', disabled: busy || text.trim() === '', onClick: send }, busy ? '发送中…' : '发送')))
          : null);
    }


    /**
     * v1.4.2: the Node-code-execution capability switch.
     *
     * Three explicit decisions, no fourth: deny, temporary (24 h, expiring), permanent. The host owns the file
     * and the agent reads it before every task, so a choice here takes effect on the next dispatch; the control
     * never claims the choice succeeded until the host's own answer says so.
     */
    function ExecCapability({ t }) {
      const [open, setOpen] = React.useState(false);
      const [capability, setCapability] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const anchorRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const [placement, setPlacement] = React.useState(null);

      React.useEffect(() => {
        const controller = new AbortController();
        readCapability(controller.signal).then((result) => {
          if (controller.signal.aborted) return;
          if (result.ok) { setCapability(result.capacity); setError(null); }
          else setError(result.routeMissing ? t('capRouteMissing') : result.error);
        });
        return () => controller.abort();
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const reposition = () => {
          const anchor = anchorRef.current;
          if (anchor === null) return;
          const rect = anchor.getBoundingClientRect();
          const width = Math.min(280, Math.max(240, Math.round(rect.width) + 120));
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
          const top = Math.max(8, rect.top - 220);
          setPlacement({ left, width, top });
        };
        const onKeyDown = (event) => { if (event.key === 'Escape') { setOpen(false); anchorRef.current?.focus?.(); } };
        const onPointerDown = (event) => {
          if (anchorRef.current?.contains(event.target) === true) return;
          if (menuRef.current?.contains(event.target) === true) return;
          setOpen(false);
        };
        reposition();
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [open]);

      const active = capability?.effective === true;
      const stateName = active ? (capability.state === 'temporary' ? t('capTemporary') : t('capPermanent')) : t('capDenied');
      const hours = capability?.remaining_ms === null || capability?.remaining_ms === undefined
        ? null
        : Math.max(0, Math.round(capability.remaining_ms / 3_600_000));
      const title = capability === null
        ? t('capMenuLabel')
        : active ? t('capWarning') : t('capDenied');

      const choose = (state, ttlMs) => {
        setBusy(true);
        writeCapability(state, ttlMs).then((result) => {
          setBusy(false);
          if (result.ok) { setCapability(result.capacity); setError(null); setOpen(false); return; }
          setError(result.routeMissing ? t('capRouteMissing') : result.error);
        });
      };

      const menu = open && placement !== null
        ? portalNode(h('div', {
            className: 'w2mCap_menu',
            role: 'menu',
            'aria-label': t('capMenuLabel'),
            ref: menuRef,
            style: { left: placement.left + 'px', top: placement.top + 'px', width: placement.width + 'px' },
          }, [
            h('div', { key: 'warn', className: 'w2mCap_note', role: 'note' }, t('capWarning')),
            h('button', { key: 'deny', type: 'button', className: 'w2mCap_option', 'data-active': active ? 'false' : 'true', onClick: () => choose('denied') }, t('capDenied')),
            h('button', { key: 'temp', type: 'button', className: 'w2mCap_option', 'data-active': capability?.state === 'temporary' ? 'true' : 'false', onClick: () => choose('temporary', 24 * 60 * 60 * 1000) }, t('capTemporary')),
            h('button', { key: 'perm', type: 'button', className: 'w2mCap_option', 'data-active': capability?.state === 'permanent' ? 'true' : 'false', onClick: () => choose('permanent') }, t('capPermanent')),
            error === null ? null : h('div', { key: 'err', className: 'w2mCap_note', role: 'status' }, error),
          ]))
        : null;

      return h(React.Fragment, null, [
        h('button', {
          key: 'trigger',
          type: 'button',
          ref: anchorRef,
          className: 'w2mCap_trigger',
          'data-on': active ? 'true' : 'false',
          'aria-label': t('capMenuLabel'),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-busy': busy,
          title,
          onClick: () => setOpen((wasOpen) => !wasOpen),
        }, [
          h('span', { key: 'dot', className: 'w2mCap_dot', 'data-on': active ? 'true' : 'false', 'aria-hidden': 'true' }),
          h('span', { key: 'label' }, t('capLabel', { state: stateName }) + (hours === null ? '' : ' · ' + t('capRemaining', { hours }))),
        ]),
        menu,
      ]);
    }

    /**
     * Client plugin body: install the stylesheet, register the dictionaries, take the seat.
     *
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      try {
        mount(ctx);
      } catch (error) {
        // The audit that decides whether the app boots reports the entry's name and the word
        // "failed" and nothing else, so this is where the cause has to be said out loud. The
        // renderer console at error level is the channel the desktop crash log already carries
        // (`--- renderer console (error level, oldest first) ---`), which makes this the one place a
        // browser half can put its own diagnosis next to the failure it caused.
        console.error(
          '@twinsearth/w2m-dsh-plugin: the client entry failed to activate, so this page will not boot: ' +
            `${error instanceof Error ? error.message : String(error)}`,
          error,
        );
        // Deliberately rethrown. A swallowed failure would boot a page that looks healthy with no
        // target control in it — the silent-half-arrival failure this package has already shipped
        // once (v0.5.4) and refuses to ship again.
        throw error;
      }
    }

    /**
     * The body of {@link apply}, wrapped so no failure can escape without a diagnostic.
     *
     * `slots.inject` (not a bare `register`) is what the slot's declaration requires of an entry
     * from a package that does not own the seat: the parent declared `conversation.input.left`, and
     * an entry may only register into a key it has announced. The returned `inject` factory is
     * called per render position with that session's id, and its keys become this component's props
     * — which is how the control knows which session's selection it is showing.
     *
     * The stylesheet is installed here rather than at module scope, so its lifetime is the plugin's:
     * `ctx.effect` disposes it on unload, and nothing a bundle factory does at materialization can
     * outlive the entry that materialized it.
     *
     * @param ctx - the client root context.
     */
    /** v3.3.0：聊天框里不再直接放这些控件；它们保留导出与内部使用，但不再渲染成按钮。 */
    function HiddenComposerControl() {
      return null;
    }

    /** 从消息 content（字符串或 parts 数组）里取纯文本。 */
    function historyTextOfContent(content) {
      if (typeof content === 'string') return content.trim();
      if (!Array.isArray(content)) return '';
      const parts = [];
      for (const part of content) {
        if (typeof part === 'string') parts.push(part);
        else if (part !== null && typeof part === 'object' && (part.type === 'text' || typeof part.text === 'string')) {
          parts.push(String(part.text ?? ''));
        }
      }
      return parts.join('\n').trim();
    }

    function historyTimeText(at) {
      const value = Number(at);
      if (!Number.isFinite(value) || value <= 0) return '';
      try {
        return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch { return ''; }
    }

    /** 从当前会话事件里取"我发过的消息"（只要 user/message，且排除系统/机器注入的 user 消息）。 */
    function historySentMessages(reference) {
      const binding = reference?.binding;
      const eventSource = binding?.eventSource ?? binding?.session?.eventSource;
      if (eventSource === null || eventSource === undefined || typeof eventSource.getSnapshot !== 'function') return [];
      let entries = [];
      try { entries = eventSource.getSnapshot()?.entries ?? []; } catch { return []; }
      const sent = [];
      for (const record of entries) {
        const event = record?.event;
        if (event === null || event === undefined || event.type !== 'user/message') continue;
        const data = event.data;
        const message = data !== null && typeof data === 'object' && data.message !== undefined ? data.message : data;
        if (message === null || typeof message !== 'object') continue;
        if (typeof message.role === 'string' && message.role !== 'user') continue;
        const source = message.source;
        if (source !== null && typeof source === 'object' && typeof source.kind === 'string' && source.kind !== 'user') continue;
        const text = historyTextOfContent(message.content);
        if (text !== '') sent.push({ text, at: Number(event.time) || null });
      }
      sent.reverse();
      return sent;
    }

    /** 读取当前会话的待发送提交（也是人类输入）。 */
    function historyPendingMessages(reference) {
      try {
        const snapshot = reference?.binding?.session?.getSnapshot?.();
        const pending = Array.isArray(snapshot?.pendingSubmissions) ? snapshot.pendingSubmissions : [];
        const out = [];
        for (const item of pending) {
          const text = historyTextOfContent(item?.content) || String(item?.text ?? '').trim();
          if (text !== '') out.push({ text, at: Number(item?.time) || null });
        }
        return out;
      } catch { return []; }
    }

    /**
     * v3.3.0「历史对话」：聊天框唯一的按钮。
     * 展开的窗口只列人类输入（我发过的消息、待发送提交、当前草稿、当前排队消息），
     * 点任意一条会把它填回输入框；机器生成的助手/工具内容不会出现。
     */
    /**
     * v3.3.17: newest first, with the current draft pinned above the time-ordered history.
     * Drafts have no timestamp; a draft shown between two old messages would read as if it
     * belonged to that point in the conversation.
     */
    function sortHistoryItems(items) {
      const list = Array.isArray(items) ? items.slice() : [];
      const draft = list.filter((item) => item?.key === 'draft');
      const timed = list.filter((item) => item?.key !== 'draft' && Number.isFinite(Number(item?.at)) && Number(item.at) > 0);
      const undated = list.filter((item) => item?.key !== 'draft' && !(Number.isFinite(Number(item?.at)) && Number(item.at) > 0));
      timed.sort((left, right) => Number(right.at) - Number(left.at));
      return [...draft, ...timed, ...undated];
    }

    function HistoryPanel({ sessionId }) {
      const [open, setOpen] = React.useState(false);
      const [items, setItems] = React.useState([]);
      const [loading, setLoading] = React.useState(false);
      const [status, setStatus] = React.useState('');

      const load = React.useCallback(async () => {
        setLoading(true);
        setStatus('');
        const next = [];
        const helpers = w2mQueueJournalHelpers;
        // 草稿：直接读当前输入框（人类输入）。
        try {
          const composer = typeof helpers?.findComposer === 'function' ? helpers.findComposer() : null;
          const draft = composer === null ? '' : String(composer.value ?? composer.innerText ?? '').trim();
          if (draft !== '') next.push({ key: 'draft', tag: '草稿', text: draft, at: null });
        } catch { /* keep going */ }
        // 排队消息：队列日志里当前会话保存的官方队列镜像（人类排队输入）。
        try {
          const store = w2mJqStore();
          void store.refresh();
          const entries = Array.isArray(store.state?.entries) ? store.state.entries : [];
          const id = String(sessionId ?? '');
          const match = entries.find((entry) => {
            const raw = String(entry?.sessionKey || entry?.key || '');
            return raw !== '' && (raw === id || raw === 'session-' + id || raw.endsWith(id) || id.endsWith(raw));
          });
          const queue = Array.isArray(match?.queue) ? match.queue : [];
          for (const [index, item] of queue.entries()) {
            const text = String(item?.text ?? '').trim();
            if (text !== '') next.push({ key: 'queue-' + index, tag: '排队', text, at: Number(item?.at) || null });
          }
        } catch { /* queue store may not be mounted */ }
        // v3.3.6: 优先从宿主直接读 DSH 会话日志（与客户端 sessions 服务无关，长会话也可靠）。
        let hostHuman = [];
        try {
          const log = await sessionLogRequest(sessionId, 60);
          if (log !== null && log.found === true) {
            hostHuman = Array.isArray(log.human) ? log.human : [];
            for (const [index, item] of hostHuman.entries()) {
              const text = String(item?.text ?? '').trim();
              if (text !== '') next.push({ key: 'host-' + index, tag: '我说过', text, at: Number(item?.time) || null });
            }
          }
        } catch { /* fall back to the client service below */ }
        // 已发送的人类消息 + 待发送提交：客户端 sessions 服务的事件窗口（宿主路由不可用时的兜底）。
        try {
          const sessions = w2mClientSessions;
          if (hostHuman.length === 0 && sessions !== null && typeof sessions.using === 'function' && String(sessionId ?? '') !== '') {
            await sessions.using(sessionId, { source: 'w2m-history-panel' }, (reference) => {
              const pending = historyPendingMessages(reference);
              pending.forEach((item, index) => next.push({ key: 'pending-' + index, tag: '待发送', text: item.text, at: item.at }));
              const sent = historySentMessages(reference);
              sent.forEach((item, index) => next.push({ key: 'sent-' + index, tag: '我说过', text: item.text, at: item.at }));
            });
          }
        } catch { /* sessions service unavailable: draft/queue still listed */ }
        setItems(sortHistoryItems(next));
        setLoading(false);
      }, [sessionId]);

      React.useEffect(() => {
        if (!open) return undefined;
        void load();
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open, load]);

      const fill = (text) => {
        const helper = w2mQueueJournalHelpers;
        const ok = typeof helper?.writeComposer === 'function' ? helper.writeComposer(text) : false;
        if (ok) { setStatus('已填入输入框'); setOpen(false); }
        else setStatus('未找到输入框，请先打开一个会话');
      };

      return h('span', { className: 'w2mHistWrap' }, [
        h('button', {
          key: 'button',
          type: 'button',
          className: 'w2mHistBtn',
          title: '历史对话：只显示人类输入（我发过的消息/草稿/排队消息），点击条目填入输入框',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        }, '历史对话'),
        open ? h('div', { key: 'window', className: 'w2mHistWindow', role: 'dialog', 'aria-label': '历史对话' }, [
          h('div', { key: 'head', className: 'w2mHistHead' }, [
            h('span', { key: 'title', className: 'w2mHistTitle' }, '历史对话'),
            h('span', { key: 'hint', className: 'w2mHistHint' }, '仅人类输入 · 从新到旧'),
            h('button', { key: 'close', type: 'button', className: 'w2mHistClose', onClick: () => setOpen(false) }, '关闭'),
          ]),
          loading ? h('div', { key: 'loading', className: 'w2mHistEmpty' }, '正在读取…') : null,
          !loading && items.length === 0 ? h('div', { key: 'empty', className: 'w2mHistEmpty' }, '当前没有人类输入记录：我发过的消息、草稿和排队消息都会显示在这里。') : null,
          !loading && items.length > 0 ? h('div', { key: 'list', className: 'w2mHistList' }, items.map((item) => h('button', {
            key: item.key,
            type: 'button',
            className: 'w2mHistItem',
            title: '点击填入输入框',
            onClick: () => fill(item.text),
          }, [
            h('span', { key: 'tag', className: 'w2mHistTag' }, item.tag),
            h('span', { key: 'text', className: 'w2mHistItemText' }, item.text.length > 240 ? item.text.slice(0, 237) + '…' : item.text),
            item.at === null ? null : h('span', { key: 'time', className: 'w2mHistMeta' }, historyTimeText(item.at)),
          ]))) : null,
          status === '' ? null : h('div', { key: 'status', className: 'w2mHistStatus', role: 'status' }, status),
        ]) : null,
      ]);
    }

    function mount(ctx) {
      // `ctx.slots` is legal to read because {@link inject} declares it — and declaring it is also
      // what makes this entry wait for the seat instead of racing it. The shape check is for callers
      // that are not a Cordis fiber at all (`test/client-bundle.test.mjs`): a missing or foreign
      // registry is a control that cannot be mounted, and a control that cannot be mounted must not
      // be allowed to take the whole page down with it.
      const slots = ctx?.slots;
      if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') {
        console.error(
          '@twinsearth/w2m-dsh-plugin: the client half found no slot registry on this context, so the ' +
            'dispatch-target control is not mounted; the rest of the page is unaffected',
        );
        return;
      }
      const styleDisposer = injectStyle(typeof document === 'undefined' ? null : document);
      if (styleDisposer !== null && typeof ctx.effect === 'function') {
        ctx.effect(() => styleDisposer, 'w2m: composer target control styles');
      }
      // Dictionaries as early as the composition allows: a namespace registered after the UI has
      // mounted is still picked up, and the service is optional, so nothing here may block.
      const locale = readOptionalService(ctx, 'locale');
      // v3.2.10：会话标题来自客户端 sessions 服务；服务晚到时再抓一次并刷新队列日志。
      w2mClientSessions = readOptionalService(ctx, 'sessions') ?? null;
      try {
        ctx.inject(['sessions'], (child) => {
          w2mClientSessions = child?.get?.('sessions') ?? w2mClientSessions;
          try { void w2mJqStore().refresh(); } catch { /* queue UI may not be mounted yet */ }
        });
      } catch { /* optional service: keep the null capture */ }
      registerDictionaries(ctx, locale);
      const t = makeTranslator(() => readOptionalService(ctx, 'locale'));
      slots.inject('conversation.input.left', () => slots.register({
        name: 'conversation.input.left',
        id: 'w2m-target',
        // After the shipped permission control and the plan control, which sit earlier in the
        // composer row: the target is a per-session choice like them, and the row reads left to
        // right as "attach, permissions, plan, where it runs".
        order: 40,
        label: 'dispatch target',
        inject: (sessionId) => ({
          sessionId,
          t,
        }),
      }, TargetSelect));        // v1.4.2: the Node-code-execution switch, one seat to the right of the chat panel.
        // v1.7.5-beta.1: the GPW folder panel is a floating button, so it is its own slot entry rather than a
        // row inside the composer; the slot fixes its mount lifetime, the CSS fixes its corner.
        try {
          slots.inject('conversation.input.left', () => slots.register({
            name: 'conversation.input.left',
            id: 'w2m-gpw',
            order: 43,
            label: 'GPW',
            inject: (sessionId) => ({ t, sessionId }),
          }, GpwLauncher));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the GPW folder panel was not mounted; the rest of the page is unaffected', error);
        }
        // v1.9.3: the left-sidebar GPW entry (always visible, no close affordance).
        // A missing seat must not take the page down: this is an extra path to the same panel.
        try {
          slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: 'w2m-gpw',
            order: 4,
            label: () => '',
            inject: () => ({}),
          }, GpwSidebarIcon));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the sidebar GPW entry was not mounted; the composer and launcher still work', error);
        }
        // v1.9.6: the page the sidebar row switches to; the key must match the panellist id.
        try {
          slots.inject('main', () => slots.register({
            name: 'main',
            key: 'w2m-gpw',
            label: () => 'GPW',
            inject: () => ({ t }),
          }, GpwMainPage));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the GPW main page was not mounted', error);
        }
        // v3.4.9: 备份&还原面板。与 GPW 完全同构：左侧边栏条目 + key 相同的 main 页；条目顺序排在
        // GPW（order 4）之后。备份路由只在 dsh-backup 行挂载时存在，面板自己探测 404 并在页面上
        // 说明「子插件未启用」，所以这里不会因为宿主没有该行而失败。
        try {
          slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: 'w2m-backup',
            order: 6,
            // Empty host label, exactly like the GPW entry above: the component below draws the icon *and*
            // the text, so a host-side label would render a second "备份&还原" beside it.
            label: () => '',
            inject: () => ({ t }),
          }, BackupSidebarIcon));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the backup sidebar entry was not mounted; the rest of the page is unaffected', error);
        }
        try {
          slots.inject('main', () => slots.register({
            name: 'main',
            key: 'w2m-backup',
            label: () => t('panel.backup.title'),
            inject: () => ({ t }),
          }, BackupMainPage));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the backup main page was not mounted', error);
        }
        // v1.9.3: check-update + auto-update on the plugin settings page.
        try {
          slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'w2m-gpw',
            order: 12,
            label: () => 'GPW',
            inject: () => ({ t }),
          }, GpwSettingsPage));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the GPW settings tab was not mounted', error);
        }
        // v2.2.1: the supported alternative to editing cordis.patch.yml. The section is its own
        // settings card so an operator can find "where do I put the old fleet key?" without
        // touching a profile file.
        try {
          slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'w2m-fleet',
            order: 11,
            label: () => '编队绑定',
            inject: () => ({ t }),
          }, FleetConfigSection));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the fleet-binding settings section was not mounted', error);
        }
        // v1.9.4: the update controls belong on the plugin's own page (same page as Uninstall),
        // not only in the global settings list.
        try {
          slots.inject('plugins.bundle.config', () => slots.register({
            name: 'plugins.bundle.config',
            key: '@twinsearth/w2m-dsh-plugin',
            label: () => 'W2M 插件更新',
            inject: () => ({}),
          }, UpdateSettingsSection));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the update settings section was not mounted; the composer button still works', error);
        }
        // v3.3.0: 聊天框里只放一个「历史对话」按钮；点开才展开窗口，窗口只列人类输入。
        try {
          slots.inject('conversation.input.left', () => slots.register({
            name: 'conversation.input.left',
            id: 'w2m-history',
            order: 44,
            label: '历史对话',
            inject: (sessionId) => ({ t, sessionId }),
          }, HistoryPanel));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the history panel was not mounted', error);
        }
        try {
          slots.inject('conversation.input.left', () => slots.register({
            name: 'conversation.input.left',
            id: 'w2m-capability',
            order: 42,
            label: 'node code execution',
            inject: () => ({ t }),
          }, ExecCapability));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the capability switch was not mounted; the rest of the page is unaffected', error);
        }



      // v3.1.0: 队列日志（移植自 @twinsearth/dsh-fang-queue-journal）：把草稿与队列镜像存到
      // /api/w2m/composer/journal*，恢复只由用户点击触发。
      try {
        if (typeof document !== 'undefined' && ctx !== null && typeof ctx === 'object' && ctx.slots !== undefined) {
          const queueJournalModule = createQueueJournalModule();
          w2mQueueJournalHelpers = queueJournalModule?.__w2mHelpers ?? null;
          queueJournalModule.apply({ slots: ctx.slots });
        }
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the queue journal was not mounted; the rest of the page is unaffected', error);
      }

      // v1.9.9: in-conversation search, in the session header next to Pin.
      try {
        slots.inject('conversation.session.header.actions', () => slots.register({
          name: 'conversation.session.header.actions',
          id: 'w2m-conversation-search',
          order: 90,
          label: () => '搜索本对话',
          inject: () => ({}),
        }, ConversationSearch));
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the conversation search control was not mounted', error);
      }
      // v1.9.20: floating scroll controls, fixed top-right of the workspace. DOM nodes, not slot
      // entries, so they appear whichever conversation view is active; ctx.effect disposes them.
      try {
        const disposeFloat = installFloatingScrollControl();
        if (typeof disposeFloat === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => disposeFloat, 'w2m: floating scroll buttons');
        }
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the floating scroll controls were not mounted', error);
      }
      // v1.9.6: fleet chat as a real conversation View tab (after Chat and Rules), rendering the
      // full chat page in the main workspace.
      try {
        slots.inject('conversation.view', () => slots.register({
          name: 'conversation.view',
          id: 'w2m-chat',
          order: 2,
          label: () => '编队群组',
          inject: (sessionId) => ({ sessionId, viewMode: true }),
        }, FleetChat));
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the fleet-chat view tab was not mounted', error);
      }
      try {
        slots.inject('shell.bottom', () => slots.register({
          name: 'shell.bottom',
          id: 'w2m-fleet-status',
          label: () => 'W2M 编队状态',
          inject: () => ({}),
        }, FleetStatusBar));
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the fleet status bar was not mounted', error);
      }
      // The fleet-chat panel: the same session-scoped seat, one slot after the target control.
      // Wrapped in its own try/catch on purpose — the target control is the primary half of this
      // bundle, and a chat panel that cannot mount must not take the page (or the app) down with it.
      try {
        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'w2m-chat',
          order: 41,
          label: 'fleet chat',
          inject: (sessionId) => ({ sessionId }),
        }, FleetChat));
      } catch (error) {
        console.error(
          '@twinsearth/w2m-dsh-plugin: the fleet chat panel was not mounted; the rest of the page is unaffected',
          error,
        );
      }
      // v2.1.0: remote-view skeleton — settings toggle, conditional iMac sidebar entry, viewer page.
      try {
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'w2m-remote-view',
          order: 13,
          label: () => '远程桌面',
          inject: () => ({ t }),
        }, RemoteViewSettings));
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the remote-view settings section was not mounted', error);
      }
      try {
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: 'w2m-remote-view',
          order: 5,
          label: () => '远程桌面',
          inject: () => ({}),
        }, RemoteViewSidebarIcon));
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the remote-view sidebar entry was not mounted', error);
      }
      try {
        slots.inject('main', () => slots.register({
          name: 'main',
          key: 'w2m-remote-view',
          label: () => '远程桌面',
          inject: () => ({ t }),
        }, RemoteViewMainPage));
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the remote-view main page was not mounted', error);
      }
      // v3.2.3: 会话席位，仅用于发布当前 sessionId（「待选」浮钮与会话筛选的数据来源）。
      try {
        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'w2m-decision-session',
          order: 62,
          label: 'decision session',
          inject: (sessionId) => ({ sessionId }),
        }, DecisionSessionSeat));
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the decision session seat was not mounted', error);
      }
      // 右侧栏页签：宿主要求先向 sidebarRightTabs 注册 tab 类型，再挂 sidebar.right.pane.tab 主体。
      // 服务是可选的，所以走 ctx.inject；没有该服务的宿主上这里不会执行，也不影响其它入口。
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs'], (child) => {
            try {
              const tabs = child.sidebarRightTabs;
              if (tabs === undefined || typeof tabs.register !== 'function') return;
              const slotsService = child.slots ?? slots;
              const tabId = 'w2m-decision-inbox-tab';
              const definition = {
                id: tabId,
                kind: 'w2m-decision-inbox',
                patterns: ['dsh-resource://w2m-decision-inbox/**'],
                priority: 'builtin',
                canOpen: (address) => String(address ?? '').startsWith('dsh-resource://w2m-decision-inbox/'),
                title: () => '决策收件箱',
              };
              tabs.register(definition);
              slotsService.inject('sidebar.right.pane.tab', () => slotsService.register({
                name: 'sidebar.right.pane.tab',
                key: tabId,
                label: () => '决策收件箱',
                inject: () => ({}),
              }, DecisionRightPaneTab));
              if (typeof document !== 'undefined' && document.body !== undefined) document.body.dataset.w2mDecisionRightTab = '1';
            } catch (error) {
              console.error('@twinsearth/w2m-dsh-plugin: the decision inbox right-pane tab was not mounted', error);
            }
          });
        }
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the decision inbox right-pane tab could not be wired', error);
      }
      // v3.2.1: 决策收件箱的右侧浮标 + 抽屉。DOM 直挂，独立于任何页面、插槽或 GPW 是否打开；
      // 没有 document 的环境（单元测试沙箱）自动跳过。
      try {
        if (typeof document !== 'undefined' && document.body !== undefined) {
          const disposeDecisionInbox = mountW2mDecisionCenterUI();
          if (typeof disposeDecisionInbox === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(() => disposeDecisionInbox, 'w2m: decision inbox');
          }
        }
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the decision inbox was not mounted; the rest of the page is unaffected', error);
      }
      // v3.3.5: 把每轮末尾的 1/2/3/4、A/B/C/D 选择题镜像成决策中心待选 ticket。
      try {
        installChoiceWatcher(ctx);
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the choice prompt watcher was not mounted', error);
      }
      // v3.2.7: 红色 GPW 待审批的全局确认弹窗（GPW 面板关闭时也要可见、可确认）。
      try {
        if (typeof document !== 'undefined' && document.body !== undefined) {
          const disposeGpwRed = mountGpwRedAlert();
          if (typeof disposeGpwRed === 'function' && typeof ctx.effect === 'function') ctx.effect(() => disposeGpwRed, 'w2m: gpw red alert');
        }
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the GPW red alert was not mounted', error);
      }
      // v3.2.2: 队列日志的右侧浮标 + 抽屉（DOM 直挂，与 composer chip 共用数据）。
      try {
        if (typeof document !== 'undefined' && document.body !== undefined) {
          const disposeQueueJournal = mountQueueJournalUI();
          if (typeof disposeQueueJournal === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(() => disposeQueueJournal, 'w2m: queue journal');
          }
        }
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the queue journal UI was not mounted; the rest of the page is unaffected', error);
      }
    }

    /**
     * Cordis services this entry depends on, read by the fiber that mounts this bundle.
     *
     * `slots` is the seat: the control is registered into `conversation.input.left` through the
     * slot registry, and a fiber that cannot see `slots` has nowhere to register. Declaring it is
     * not bookkeeping. Cordis resolves `ctx.<name>` against this list, so reading an undeclared
     * service **throws** (`cannot get property "slots" without inject`) even when the service is
     * provided — measured in production: this bundle shipped with `inject = []` while reading
     * `ctx.locale` and `ctx.slots`, the first read threw, and the app refused to boot.
     *
     * `locale` is deliberately absent, and that is the other half of the same rule: **every**
     * declared name is a required dependency, so an entry that declares a service the composition
     * does not provide never reaches `active` either — the audit then reports it as
     * `pending (waiting for service: locale)`, which is just as fatal. Optional carriers are read
     * with {@link readOptionalService} instead, and waited for by a child fiber when waiting is
     * useful ({@link registerDictionaries}). Keep those two decisions in step with the reads in
     * {@link mount}: `test/client-bundle.test.mjs` mounts this bundle behind a context that throws
     * on any undeclared service read, exactly as Cordis does.
     */
    const inject = ['slots'];

    exports.apply = apply;
    exports.activateSearchMark = activateSearchMark;
    exports.centerSearchMark = centerSearchMark;
    exports.parseChoiceOptions = parseChoiceOptions;
    exports.groupTargetMachines = groupTargetMachines;
    exports.targetMachineKindOf = targetMachineKindOf;
    exports.choiceHash = choiceHash;
    exports.inject = inject;
    exports.TargetSelect = TargetSelect;
    exports.targetTokenForName = targetTokenForName;
    exports.planTargetMention = planTargetMention;
    exports.GpwLauncher = GpwLauncher;
    exports.GpwPrompt = GpwPrompt;
      exports.FleetChat = FleetChat;
    // v3.4.9: the backup & restore panel, exposed so `test/client-bundle.test.mjs` can assert the
    // registrations and render the pure view/reason-code helpers without a browser.
    exports.BackupSidebarIcon = BackupSidebarIcon;
    exports.BackupMainPage = BackupMainPage;
    exports.BackupPanelView = BackupPanelView;
    exports.BACKUP_MAX_LOG = BACKUP_MAX_LOG;
    exports.BACKUP_POLL_MS = BACKUP_POLL_MS;
    exports.BACKUP_REASON_KEYS = BACKUP_REASON_KEYS;
    exports.appendBackupLog = appendBackupLog;
    exports.backupActionText = backupActionText;
    exports.backupConflictText = backupConflictText;
    exports.backupLogEntry = backupLogEntry;
    exports.backupReasonText = backupReasonText;
    // v3.5.x: the unlock dialog and its pure helpers are exposed so `test/client-bundle.test.mjs` can
    // drive the modal (open/close/focus/request bodies) with the fake hook React, and so the wording
    // helpers are pinned without a browser.
    exports.BackupUnlockDialog = BackupUnlockDialog;
    exports.focusBackupDialogFirst = focusBackupDialogFirst;
    exports.backupUnlockStateKey = backupUnlockStateKey;
    exports.backupUnlockLocalAvailable = backupUnlockLocalAvailable;
    exports.BACKUP_UNLOCK_COMMAND = BACKUP_UNLOCK_COMMAND;
    exports.BACKUP_DISABLE_PROTECTION_COMMAND = BACKUP_DISABLE_PROTECTION_COMMAND;
    exports.BACKUP_ROTATE_COMMAND = BACKUP_ROTATE_COMMAND;
    // v3.5.0: the full-copy cap approval modal and its pure normalizers are exposed so the bundle tests can drive
    // the dialog (open/confirm/cancel request bodies) with the fake hook React, without a browser.
    exports.BackupApprovalDialog = BackupApprovalDialog;
    exports.BACKUP_FULL_COPY_APPROVAL_CODE = BACKUP_FULL_COPY_APPROVAL_CODE;
    exports.backupApprovalRequest = backupApprovalRequest;
    exports.backupPendingApproval = backupPendingApproval;
    exports.backupApprovalCapText = backupApprovalCapText;
    exports.backupApprovalSessionRows = backupApprovalSessionRows;
    // v3.5.0 §24.3: the `old/` usage reminder (no total cap) and its acknowledgement route are exposed so the bundle
    // tests can render the banner, drive 「知道了」/「如何清理」 and assert that no delete action exists.
    exports.BACKUP_OLD_USAGE_ACK_ROUTE = BACKUP_OLD_USAGE_ACK_ROUTE;
    exports.BACKUP_OLD_USAGE_ACK_TOKEN = BACKUP_OLD_USAGE_ACK_TOKEN;
    exports.backupPendingOldUsage = backupPendingOldUsage;
    exports.backupOldUsageGbText = backupOldUsageGbText;
    // v3.5.0: the two scope entries read their session list from the read-only scan route; the route and
    // its defensive normalizer are exposed so the bundle tests can pin the contract without a browser.
    exports.BACKUP_SCAN_ROUTE = BACKUP_SCAN_ROUTE;
    exports.normalizeBackupScan = normalizeBackupScan;
    // v3.5.0: the 编队版本 card and its helpers, exposed so `test/client-bundle.test.mjs` can render
    // the card (in its operation-panel section and on its own) and assert the guidance/copy
    // behaviour without a browser.
    exports.FleetVersionsCard = FleetVersionsCard;
    exports.OpsActionsSection = OpsActionsSection;
    exports.fleetVersionBlock = fleetVersionBlock;
    exports.buildVersionGuidance = buildVersionGuidance;
    exports.copyFleetGuidance = copyFleetGuidance;
    exports.injectStyle = injectStyle;
    exports.makeTranslator = makeTranslator;
    exports.portalNode = portalNode;
    return module.exports;
  },
});
