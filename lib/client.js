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
    function GpwPanel({ t, sessionId, onClose }) {
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
      return h('div', { className: 'w2mGpw_overlay', role: 'dialog', 'aria-label': t('gpwTitle') }, [
        h('div', { key: 'card', className: 'w2mGpw_card' }, [
          h('div', { key: 'head', className: 'w2mGpw_head' }, [
            h('span', { key: 'title', className: 'w2mGpw_title' }, t('gpwTitle')),
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
              h('button', { key: 'w', type: 'button', className: 'w2mGpw_btn', disabled: busy || manual.trim() === '', onClick: () => addTyped('whitelist') }, t('gpwAddWhiteShort')),
              h('button', { key: 'b', type: 'button', className: 'w2mGpw_btn', disabled: busy || manual.trim() === '', onClick: () => addTyped('blacklist') }, t('gpwAddBlackShort')),
            ]),
            badPath === null ? null : h('div', { key: 'bad', className: 'w2mGpw_note' }, t('gpwBadPath', { error: badPath })),
            h('div', { key: 'hint', className: 'w2mGpw_hint' }, t('gpwInputHint')),
          ]),
          folderList(t('gpwWhitelist'), 'whitelist'),
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
                h('button', { key: 'w', type: 'button', className: 'w2mGpw_btn', disabled: busy, onClick: () => addFolder('whitelist', item.folder) }, t('gpwAddWhiteShort')),
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

    /** The floating launcher: a pending badge, and the panel fixed to the lower-right corner. */
    function GpwLauncher({ t, sessionId }) {
      const [open, setOpen] = React.useState(false);
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
        window.addEventListener('w2m-gpw-open', onOpen);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener('w2m-gpw-open', onOpen);
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
function TargetSelect({ sessionId, locked: _locked, t }) {
      const [open, setOpen] = React.useState(false);
      // v1.5.1: relay folding. The snapshot carries the pool; when it holds more than three nodes
      // the menu shows a summary and this toggle reveals the folded ones.
      const [relayOpen, setRelayOpen] = React.useState(false);
      const [reloadSeq, setReloadSeq] = React.useState(0);
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const anchorRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const [placement, setPlacement] = React.useState(null);

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
      const problem = error ?? fleetProblem(state, t);
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

      const choose = (machineId, machineName) => {
        setOpen(false);
        if (machineId === chosen) return;
        setBusy(true);
        writeSelection(sessionId, machineId, machineName).then((result) => {
          setBusy(false);
          if (result.ok) {
            setState(result.state);
            setError(null);
            return;
          }
          // The write is refused for a reason the operator can act on (the machine went away, the
          // fleet could not be read), so it is shown where they are looking rather than swallowed.
          setError(result.error);
          setReloadSeq((seq) => seq + 1);
        });
      };

      const menu = open && placement !== null
        ? h('div', {
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
          ])
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

    function FleetChat({ sessionId }) {
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
          ? h('div', { className: 'w2mChat_panel', role: 'dialog', 'aria-label': '编队聊天' },
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
                        h('div', { className: 'w2mChat_text' }, message?.text ?? ''));
                      }),
                    ].filter((node) => node !== null))),


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
        ? h('div', {
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
          ])
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
            label: 'GPW folders',
            inject: (sessionId) => ({ t, sessionId }),
          }, GpwLauncher));
        } catch (error) {
          console.error('@twinsearth/w2m-dsh-plugin: the GPW folder panel was not mounted; the rest of the page is unaffected', error);
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
    exports.GpwLauncher = GpwLauncher;
    exports.GpwPrompt = GpwPrompt;
      exports.FleetChat = FleetChat;
    exports.injectStyle = injectStyle;
    exports.makeTranslator = makeTranslator;
    return module.exports;
  },
});
