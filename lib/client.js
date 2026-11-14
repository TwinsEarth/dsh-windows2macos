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
      },
      en: {
        all: 'All machines',
        machine: 'Machine',
        local: 'This machine',
        online: 'online',
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
        '.w2mDcBadgeCount[hidden],.w2mDcUnread[hidden],.w2mJqBadgeCount[hidden],.w2mDcError[hidden]{display:none!important}',
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
        '.w2mJqClientFold{margin-top:8px;border-top:.5px solid var(--dsw-alias-border-default);padding-top:6px}',
        '.w2mJqClientFoldSummary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
        '.w2mJqClientFoldBody{display:flex;flex-direction:column;gap:8px;padding-top:6px;opacity:.85}',
        '.w2mJqOnlyClient{font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 0}',
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
            button.addEventListener('click', () => { void store.resolve(ticket, option?.value); });
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

    function mountW2mDecisionCenterUI() {
      if (typeof document === 'undefined' || document.body === undefined) return () => {};
      const store = w2mDcStore();
      store.start();
      const badge = dcEl('button', {
        type: 'button',
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
        unsubscribe();
        try { badge.remove(); } catch { /* ignore */ }
        try { overlay.remove(); } catch { /* ignore */ }
        document.removeEventListener('keydown', onKey);
      };
    }

    /** 左侧栏的收件箱入口：图标 + 未读红点，点击打开右侧抽屉（对齐瓮城的侧栏入口）。 */
    function DecisionInboxSidebar() {
      const store = w2mDcStore();
      const [snap, setSnap] = React.useState(() => store.snapshot());
      React.useEffect(() => {
        store.start();
        const unsubscribe = store.subscribe(() => setSnap(store.snapshot()));
        return unsubscribe;
      }, [store]);
      const title = snap.pending > 0 ? `决策中心：${snap.pending} 条待处理` : '决策中心：暂无待处理';
      return h('button', {
        type: 'button',
        className: 'w2mDcSidebarBtn',
        title,
        'aria-label': title,
        'data-tone': snap.red > 0 ? 'red' : snap.pending > 0 ? 'warn' : 'idle',
        onClick: () => store.openDrawer(),
      }, [
        h('span', { key: 'icon', className: 'w2mDcSidebarIcon' }, '▣'),
        h('span', { key: 'label', className: 'w2mDcSidebarLabel' }, '决策中心'),
        snap.pending > 0 ? h('span', { key: 'count', className: 'w2mGpw_badge' }, String(snap.pending)) : null,
      ]);
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
        showIds: false,
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
          const [body, sessionsBody] = await Promise.all([
            jqRequest(JQ_PREFIX + '?list=1'),
            jqRequest(JQ_PREFIX + '/sessions').catch(() => null),
          ]);
          const entries = Array.isArray(body?.entries) ? body.entries : [];
          const sessions = {};
          for (const item of Array.isArray(sessionsBody?.items) ? sessionsBody.items : []) {
            const id = String(item?.id ?? '');
            if (id !== '') sessions[id] = String(item?.title ?? '');
          }
          set({ entries, sessions, loading: false, error: '', loadedOnce: true });
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
          const isHuman = (entry) => String(entry?.sessionKey ?? entry?.key ?? '').startsWith('session-');
          const human = all.filter(isHuman);
          const client = all.filter((entry) => !isHuman(entry));
          const queued = human.reduce((sum, entry) => sum + (Array.isArray(entry?.queue) ? entry.queue.length : 0), 0);
          const drafts = human.filter((entry) => String(entry?.draft ?? '').trim() !== '').length;
          return { total: human.length, clientTotal: client.length, queued, drafts, busy: state.busy, error: state.error, open: state.open, loading: state.loading, showIds: state.showIds === true, sessions: state.sessions };
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
            const sessionId = String(entry?.sessionKey ?? entry?.key ?? '');
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
        toggleIds() {
          set({ showIds: state.showIds !== true });
        },
        async clearAll() {
          return act('clear-all', async () => {
            const keys = state.entries.map((entry) => String(entry?.key ?? '')).filter((key) => key !== '');
            for (const key of keys) {
              try { await jqRequest(JQ_PREFIX, { method: 'POST', body: JSON.stringify({ key, draft: '', queue: [] }) }); } catch { /* keep going */ }
            }
            set({ status: '已清空 ' + keys.length + ' 条记录' });
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
      store.start();
      const badge = dcEl('button', {
        type: 'button',
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
      const eyeButton = dcEl('button', { type: 'button', className: 'w2mDcBtn w2mJqEye', title: '显示 / 隐藏 Session ID', 'aria-pressed': 'false' }, ['👁']);
      const clearAllButton = dcEl('button', { type: 'button', className: 'w2mDcBtn w2mJqClearAll', title: '清空全部队列日志记录' }, ['清空全部']);
      const refreshButton = dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['刷新']);
      const closeButton = dcEl('button', { type: 'button', className: 'w2mDcBtn' }, ['关闭']);
      eyeButton.addEventListener('click', () => store.toggleIds());
      clearAllButton.addEventListener('click', () => { void store.clearAll(); });
      refreshButton.addEventListener('click', () => { void store.refresh(); });
      closeButton.addEventListener('click', () => store.closeDrawer());
      headActions.append(eyeButton, clearAllButton, refreshButton, closeButton);
      header.append(title, count, headActions);
      const hint = dcEl('div', { className: 'w2mJqHint' }, ['默认只显示人类输入（真实会话）的草稿与排队消息；客户端自己生成的记录折叠在最下方。恢复只在你点击时发生，插件从不自动发送消息。Session ID 默认隐藏，点 👁 显示。']);
      const statusLine = dcEl('div', { className: 'w2mJqStatus', role: 'status' }, ['']);
      const body = dcEl('div', { className: 'w2mDcBody' });
      const errorLine = dcEl('div', { className: 'w2mDcError', role: 'alert', hidden: true });
      drawer.append(header, hint, errorLine, statusLine, body);
      overlay.append(drawer);
      document.body.append(badge, overlay);
      overlay.addEventListener('click', (event) => { if (event.target === overlay) store.closeDrawer(); });
      const onKey = (event) => { if (event.key === 'Escape' && store.state.open) store.closeDrawer(); };
      document.addEventListener('keydown', onKey);

      const entryCard = (entry) => {
        const card = dcEl('div', { className: 'w2mJqEntry' });
        const head = dcEl('div', { className: 'w2mJqEntryHead' });
        const updated = String(entry?.updatedAt ?? '').replace('T', ' ').slice(0, 16);
        const rawKey = String(entry?.sessionKey || entry?.key || '');
        // 会话名优先：来自宿主会话服务；拿不到时退化为短 ID，Session ID 默认不可见。
        const sessionTitle = String(store.state.sessions?.[rawKey] ?? '').trim();
        const shortKey = rawKey.startsWith('session-') ? rawKey.slice(8, 16) : rawKey.slice(0, 14);
        const friendlyName = sessionTitle !== '' ? sessionTitle : '会话 ' + (shortKey === '' ? '未知' : shortKey);
        head.append(
          dcEl('span', { className: 'w2mJqEntryKey', title: friendlyName }, [friendlyName]),
          dcEl('span', { className: 'w2mJqEntryTime' }, [updated]),
        );
        card.append(head);
        if (store.state.showIds === true) card.append(dcEl('div', { className: 'w2mJqEntryId' }, ['Session ID：' + rawKey]));
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
        title.textContent = '队列日志' + (snap.total > 0 ? ' · ' + snap.total + ' 条人类输入' : '') + (snap.clientTotal > 0 ? ' · ' + snap.clientTotal + ' 条客户端记录已折叠' : '');
        overlay.style.display = snap.open === true ? 'flex' : 'none';
        drawer.style.display = snap.open === true ? 'flex' : 'none';
        overlay.setAttribute('aria-hidden', snap.open === true ? 'false' : 'true');
        if (snap.open !== true) return;
        errorLine.hidden = snap.error === '';
        errorLine.textContent = snap.error === '' ? '' : '队列日志不可用：' + snap.error;
        statusLine.textContent = store.state.status;
        body.replaceChildren();
        eyeButton.setAttribute('aria-pressed', snap.showIds === true ? 'true' : 'false');
        const isHumanEntry = (entry) => String(entry?.sessionKey ?? entry?.key ?? '').startsWith('session-');
        const humanEntries = store.state.entries.filter(isHumanEntry);
        const clientEntries = store.state.entries.filter((entry) => !isHumanEntry(entry));
        if (humanEntries.length === 0 && clientEntries.length === 0) {
          body.append(dcEl('div', { className: 'w2mDcEmpty' }, [snap.loading ? '正在读取队列日志…' : '队列日志是空的：输入框里的草稿与排队消息会自动保存到这里（重启/崩溃后可恢复）。']));
          return;
        }
        for (const entry of humanEntries) body.append(entryCard(entry));
        if (humanEntries.length === 0) {
          body.prepend(dcEl('div', { className: 'w2mJqOnlyClient' }, ['当前没有人类输入记录；客户端自己生成的 ' + clientEntries.length + ' 条记录已折叠在下方。']));
        }
        if (clientEntries.length > 0) {
          const fold = dcEl('details', { className: 'w2mJqClientFold' });
          fold.append(dcEl('summary', { className: 'w2mJqClientFoldSummary' }, ['客户端生成的记录 · ' + clientEntries.length + ' 条（默认折叠，仅排错用）']));
          const foldBody = dcEl('div', { className: 'w2mJqClientFoldBody' });
          for (const entry of clientEntries) foldBody.append(entryCard(entry));
          fold.append(foldBody);
          body.append(fold);
        }
      };
      const unsubscribe = store.subscribe(render);
      render();
      return () => {
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

    function GpwPanel({ t, sessionId, onClose, inline }) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [manual, setManual] = React.useState('');
      const [badPath, setBadPath] = React.useState(null);
      const [expanded, setExpanded] = React.useState({});
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
      return h('div', { className: inline === true ? 'w2mGpw_inline' : 'w2mGpw_overlay', role: 'dialog', 'aria-label': t('gpwTitle') }, [
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
          pending.length === 0 ? null : h('div', { key: 'pending', className: 'w2mGpw_block' }, [
            h('div', { key: 'title', className: 'w2mGpw_title' }, t('gpwPending')),
            ...pending.map((item) => h('div', { key: item.id, className: 'w2mGpw_recent' }, [
              h('div', { key: 'p1', className: 'w2mGpw_path' }, [h('span', { key: 'c', className: 'w2mGpw_dot', 'data-c': item.color ?? 'yellow' }), item.tool + ' · ' + (item.reason ?? '')]),
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
      const signature = JSON.stringify({ key, text, queue: queue.map((item) => item.text) })
      if (signature === lastSignature) return
      lastSignature = signature
      void (async () => {
        const saved = await journalRequest('POST', { draft: text, queue })
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
      const signature = JSON.stringify({ key, text, queue: queue.map((item) => item.text) })
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
            body: JSON.stringify({ key: resolveKey(), sessionKey: resolveKey(), sessionId: activeSessionId || undefined, draft: text, queue, path: location.hash || location.pathname }),
          })
        } catch { /* ignore */ }
      })()
    }

    return {
      inject: ['slots'],
      __w2mHelpers: { journalRequest, journalHistory, queueRestore, writeComposer, findComposer, resolveKey },
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'w2m-queue-journal',
          order: 90,
        }, JournalDock))

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
        title: 'GPW 文件夹策略',
        onClick: () => {
          try { window.dispatchEvent(new CustomEvent('w2m-gpw-full')); } catch { /* headless */ }
        },
      }, [
        h('span', { key: 'i', className: 'w2mGpw_sideIcon', 'aria-hidden': 'true' }, '🌐'),
        h('span', { key: 'l', className: 'w2mGpw_sideLabel' }, 'GPW'),
      ]);
    }

    /** v1.9.4: the full workspace page opened from the sidebar entry. */
    function GpwFullPage({ t, sessionId, onClose }) {
      return h('div', { className: 'w2mGpw_fullPage', role: 'dialog', 'aria-label': t('gpwTitle') }, [
        h('div', { key: 'head', className: 'w2mGpw_fullHead' }, [
          h('span', { key: 't', className: 'w2mGpw_fullTitle' }, '🌐 ' + t('gpwTitle')),
          h('button', { key: 'x', type: 'button', className: 'w2mGpw_close', onClick: onClose }, '×'),
        ]),
        h('div', { key: 'body', className: 'w2mGpw_fullBody' }, h(GpwPanel, { t, sessionId, inline: true, onClose })),
      ]);
    }

    /** v1.9.6: the GPW page rendered in the main workspace (slot main, key w2m-gpw). */
    function GpwMainPage({ t }) {
      return h('div', { className: 'w2mGpw_mainWrap' }, h(GpwAdminPage, { t }));
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
function clearSearchMarks() {
  if (typeof document === 'undefined') return;
  const marks = document.querySelectorAll('mark.w2mSearchMark');
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
  const paintRef = React.useRef(() => {});
  paintRef.current = (focus = false) => {
    const total = paintSearchMarks(appliedRef.current);
    setCount(total);
    setCursor(total > 0 ? 0 : -1);
    setPending(false);
    if (focus === true) {
      const first = document.querySelector('mark.w2mSearchMark');
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };
  React.useEffect(() => {
    if (!open) { appliedRef.current = ''; clearSearchMarks(); setCount(0); setCursor(-1); setPending(false); }
  }, [open]);
  React.useEffect(() => {
    if (!open) return undefined;
    if (!searchQueryAllowed(query)) {
      // Refused query: no marks, no count, no scroll — the input itself stays usable.
      appliedRef.current = '';
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
    let marks = [...document.querySelectorAll('mark.w2mSearchMark')];
    if (marks.length === 0) { paintRef.current(false); marks = [...document.querySelectorAll('mark.w2mSearchMark')]; }
    if (marks.length === 0) return;
    const next = (cursor + (backwards ? -1 : 1) + marks.length) % marks.length;
    setCursor(next);
    if (marks[next] && marks[next].scrollIntoView) marks[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    h('button', { key: 'close', type: 'button', className: 'w2mSearchBtn', title: '关闭搜索', onClick: () => { setOpen(false); setQuery(''); clearSearchMarks(); } }, '×'),
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
      const [open, setOpen] = React.useState(false);
      const [full, setFull] = React.useState(false);
      const [pendingCount, setPendingCount] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch('/api/w2m/gpw/state', { credentials: 'same-origin', headers: { accept: 'application/json' } });
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

    function TargetSelect({ sessionId, locked: _locked, t, inputActions, useInput }) {
      const [open, setOpen] = React.useState(false);
      // v1.5.1: relay folding. The snapshot carries the pool; when it holds more than three nodes
      // the menu shows a summary and this toggle reveals the folded ones.
      const [relayOpen, setRelayOpen] = React.useState(false);
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
              : machines.map((machine) => h('button', {
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
                    : (machine.online === true ? (machine.os ?? t('online')) : machine.state)),
                ]))),
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
      const fleetText = fleet && Number.isFinite(fleet.online) && Number.isFinite(fleet.total) ? fleet.online + '/' + fleet.total : '—';
      const serverText = server && Number.isFinite(server.devices_online) && Number.isFinite(server.devices_total) ? server.devices_online + '/' + server.devices_total : '—';
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
        h('span', { key: 'f', className: 'w2mFleetStatusItem' }, '本编队在线 ' + fleetText),
        h('span', { key: 's', className: 'w2mFleetStatusItem' }, '全服机器在线 ' + serverText),
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
        // v1.7.9: the inline pending prompt, mounted in the same composer row so an interception
        // asks allow/deny immediately instead of waiting silently in the panel.
        try {
          slots.inject('conversation.input.left', () => slots.register({
            name: 'conversation.input.left',
            id: 'w2m-gpw-prompt',
            order: 44,
            label: 'GPW pending prompt',
            inject: () => ({ t }),
          }, GpwPrompt));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the GPW approval prompt was not mounted; the panel still works', error);
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
      // v3.2.1: 决策收件箱的侧栏入口（对齐瓮城的收件箱席位）；点开与浮标同一个抽屉。
      try {
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: 'w2m-decision-inbox',
          order: 6,
          label: () => '决策中心',
          inject: () => ({}),
        }, DecisionInboxSidebar));
      } catch (error) {
        console.error('@twinsearth/w2m-dsh-plugin: the decision inbox sidebar entry was not mounted', error);
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
    exports.inject = inject;
    exports.TargetSelect = TargetSelect;
    exports.targetTokenForName = targetTokenForName;
    exports.planTargetMention = planTargetMention;
    exports.GpwLauncher = GpwLauncher;
    exports.GpwPrompt = GpwPrompt;
      exports.FleetChat = FleetChat;
    exports.injectStyle = injectStyle;
    exports.makeTranslator = makeTranslator;
    exports.portalNode = portalNode;
    return module.exports;
  },
});
