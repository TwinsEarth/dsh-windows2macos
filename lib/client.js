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
 * host scans for; `src/client/w2m-target.mjs` is the same code laid out for a human reader.
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
    // Mirrors TARGET_ROUTE_PATH in src/plugin/fleet-target.mjs. Plain same-origin `fetch` rather
    // than a Remote method: the route is mounted inside the host's authentication fence, so the
    // page's own cookie is the credential and there is no descriptor to keep in sync.
    const ROUTE = '/w2m/target';

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
      },
    };

    /**
     * A translator over {@link DICT}, preferring the shell's locale service.
     *
     * `{name}` substitution is deliberately the only templating: these strings have one variable
     * each, and a message format would be a dependency this package does not have.
     *
     * @param ctx - the client plugin context.
     * @returns {(key: string, values?: object) => string}
     */
    function makeTranslator(ctx) {
      const bound = typeof ctx?.locale?.bind === 'function' ? ctx.locale.bind(NS) : null;
      return (key, values) => {
        const template = bound === null
          ? (DICT.zh[key] ?? DICT.en[key] ?? key)
          : bound(key, values);
        const text = typeof template === 'string' && template !== '' ? template : (DICT.en[key] ?? key);
        if (values === undefined) return text;
        return text.replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])));
      };
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
      '.w2mTarget_option{display:block;width:100%;box-sizing:border-box;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.w2mTarget_option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.w2mTarget_option:disabled{cursor:default;color:var(--dsw-alias-label-dimmed)}',
      '.w2mTarget_option[data-active="true"]{color:var(--dsw-alias-state-business-primary)}',
      '.w2mTarget_row{display:flex;align-items:center;gap:8px}',
      '.w2mTarget_name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.w2mTarget_detail{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}',
      '.w2mTarget_option:disabled .w2mTarget_detail{color:var(--dsw-alias-label-caption)}',
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
    function TargetSelect({ sessionId, locked: _locked, t }) {
      const [open, setOpen] = React.useState(false);
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

    /**
     * Client plugin body.
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
    function apply(ctx) {
      const styleDisposer = injectStyle(typeof document === 'undefined' ? null : document);
      if (styleDisposer !== null && typeof ctx.effect === 'function') {
        ctx.effect(() => styleDisposer, 'w2m: composer target control styles');
      }
      // Dictionaries first: a namespace registered after the UI has mounted is still picked up.
      if (typeof ctx.locale?.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'w2m: composer target control dictionaries');
      }
      const t = makeTranslator(ctx);
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
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
      }, TargetSelect));
    }

    /** Cordis services this entry needs; `ctx.slots` is read directly, as every client plugin does. */
    const inject = [];

    exports.apply = apply;
    exports.inject = inject;
    exports.TargetSelect = TargetSelect;
    exports.injectStyle = injectStyle;
    exports.makeTranslator = makeTranslator;
    return module.exports;
  },
});
