/**
 * Boot the page the Host serves in a real headless browser and report what its client entries did.
 *
 * # Why this exists next to `dsh-client-activation.mjs`
 *
 * That helper mounts the client entries through the real module system and the real Cordis loader
 * with the *platform seeds stubbed* — React, the slot registry, no document. It is the always-on
 * gate, and it is what catches the failure this file was written for. But a stub is exactly the kind
 * of stand-in that has already fooled this project twice: if the shell's seed table or its service
 * names differed from the stub in one place, the helper would keep passing while the app refused to
 * start. Only a browser can settle that, because only a browser runs the shell's own boot — the real
 * frontend bundle, the real seed table, the real services, the real audit that turns one failed
 * entry into `web boot: 1 entry did not activate` and a page that never mounts.
 *
 * So this module drives the throwaway profile's own Web app (never a real one: the caller owns the
 * profile and the port) in a headless Edge/Chrome over the DevTools protocol, and reports:
 *
 *   * `consoleErrors` — the shell's own failure line, when it has one;
 *   * `arrived` — whether this package's stylesheet ended up in the document, which only a completed
 *     `apply` can do, and which needs no session, no click and no composer;
 *   * `bootOverlay` / `bodyText` — whether the boot screen is still up, and what it says.
 *
 * A browser that cannot be found is a *skip*, never a pass: the caller is expected to say so out
 * loud, because an assertion that silently did not run is how the client half shipped broken.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The stylesheet tag this package's `apply` installs; its presence proves the entry activated. */
export const ARRIVAL_SELECTOR = 'style[data-plugin-css="@twinsearth/w2m-dsh-plugin/TargetSelect.css"]';

/** The message the shell throws when any client entry did not activate. */
export const BOOT_FAILURE_PATTERN = /web boot: \d+ entr(?:y|ies) did not activate/u;

/** Candidate browser executables per platform, in probe order. */
const BROWSER_CANDIDATES = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

/**
 * Locate a Chromium-based browser, or explain why there is none.
 *
 * `W2M_DSH_BROWSER` names one explicitly; `W2M_DSH_BROWSER=none` disables the page boot entirely.
 *
 * @returns {{executable: string}|{executable: null, reason: string}}
 */
export function findBrowser() {
  const explicit = process.env.W2M_DSH_BROWSER;
  if (typeof explicit === 'string' && explicit !== '') {
    if (explicit === 'none') return { executable: null, reason: 'W2M_DSH_BROWSER=none' };
    if (!fs.existsSync(explicit)) return { executable: null, reason: `W2M_DSH_BROWSER names a missing file: ${explicit}` };
    return { executable: explicit };
  }
  const candidates = BROWSER_CANDIDATES[process.platform] ?? [];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    return {
      executable: null,
      reason: `no Chromium-based browser found (set W2M_DSH_BROWSER to one); tried: ${candidates.join(', ') || 'no candidates for this platform'}`,
    };
  }
  return { executable: found };
}

/** A minimal DevTools-protocol client over the runtime's global WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error === undefined) resolve(message.result);
        else reject(new Error(message.error.message ?? 'devtools protocol error'));
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  on(listener) {
    this.listeners.push(listener);
  }
}

/**
 * Wait for the browser's DevTools endpoint file.
 *
 * @param {string} userDataDir - the browser profile directory.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<{port: number, browserPath: string}>}
 */
async function waitForDevTools(userDataDir, timeoutMs) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const [port, browserPath] = fs.readFileSync(file, 'utf8').split('\n');
      if (port !== undefined && port !== '') return { port: Number(port), browserPath: browserPath ?? '/devtools/browser' };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the browser wrote no DevToolsActivePort within ${String(timeoutMs)}ms`);
}

/**
 * Boot `url` in a headless browser and report the page's own verdict on its client entries.
 *
 * @param {object} options
 * @param {string} options.url - the authenticated Web URL the profile is serving.
 * @param {string} options.executable - the browser binary.
 * @param {number} [options.settleMs] - how long to wait for the boot to finish or fail.
 * @returns {Promise<object>} the report.
 */
export async function bootPage({ url, executable, settleMs = 45_000 }) {
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'w2m-page-boot-'));
  const browser = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let browserStderr = '';
  browser.stderr.setEncoding('utf8');
  browser.stderr.on('data', (chunk) => {
    browserStderr += chunk;
  });
  browser.on('error', (error) => {
    browserStderr += `\nspawn failed: ${String(error?.message ?? error)}`;
  });

  const report = {
    url,
    executable,
    arrived: false,
    arrivedSelector: ARRIVAL_SELECTOR,
    bootFailure: null,
    bootOverlay: null,
    bootOverlayGone: false,
    bodyText: null,
    w2mControl: false,
    composer: 0,
    consoleErrors: [],
    exceptions: [],
    settledAfterMs: null,
  };

  try {
    const { port, browserPath } = await waitForDevTools(userDataDir, 30_000);
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${browserPath}`);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('the DevTools websocket did not open')), { once: true });
    });
    const cdp = new Cdp(socket);
    cdp.on((message) => {
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        report.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '));
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        report.exceptions.push(details.exception?.description ?? details.text);
      }
    });

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails !== undefined) return null;
      return result.result?.value ?? null;
    };

    const startedAt = Date.now();
    const deadline = startedAt + settleMs;
    let state = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const raw = await evaluate(`JSON.stringify({
        arrived: document.querySelector(${JSON.stringify(ARRIVAL_SELECTOR)}) !== null,
        bootOverlay: document.querySelector('[data-dsh-boot]') !== null,
        bodyText: (document.body?.innerText ?? '').slice(0, 600),
        w2mControl: document.querySelector('.w2mTarget_trigger') !== null,
        composer: document.querySelectorAll('[contenteditable="true"]').length
      })`);
      if (raw === null) continue;
      state = JSON.parse(raw);
      // Two decisive signals end the wait: the boot gave up (its own error line), or the boot
      // finished — this package's `apply` ran (its stylesheet is in the document) *and* the shell
      // took its boot surface down, which happens only after every entry activated and the UI
      // mounted. "Our code ran" alone would not be enough: a *different* entry could still fail
      // afterwards, and the page would show the failure card instead of the app.
      const failed = report.consoleErrors.some((line) => BOOT_FAILURE_PATTERN.test(line));
      if (failed || (state.arrived && state.bootOverlay === false)) break;
    }
    report.settledAfterMs = Date.now() - startedAt;
    if (state !== null) {
      report.arrived = state.arrived;
      report.bootOverlay = state.bootOverlay;
      report.bootOverlayGone = state.bootOverlay === false;
      report.bodyText = state.bodyText;
      report.w2mControl = state.w2mControl;
      report.composer = state.composer;
    }
    report.bootFailure = report.consoleErrors.find((line) => BOOT_FAILURE_PATTERN.test(line)) ?? null;
    if (process.env.W2M_CAPABILITY_PROBE === '1') {
      const read = async (expression) => {
        const value = await evaluate(`JSON.stringify((() => { ${expression} })())`);
        return value === null ? null : JSON.parse(value);
      };
      let opened = { found: false };
      for (let attempt = 0; attempt < 25; attempt += 1) {
        opened = await read(`const t=document.querySelector('.w2mCap_trigger'); if(t===null)return {found:false}; t.click(); return {found:true};`);
        if (opened.found === true) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const menu = await read(`
        const trigger=document.querySelector('.w2mCap_trigger');
        const menu=document.querySelector('.w2mCap_menu');
        const options=[...document.querySelectorAll('.w2mCap_option')].map((button)=>({text:button.textContent}));
        return {expanded: trigger?.getAttribute('aria-expanded') ?? null, menu: menu !== null, options};
      `);
      const temp = await read(`const b=document.querySelectorAll('.w2mCap_option')[1] ?? null; if(b===null)return {clicked:false}; b.click(); return {clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await read(`
        const trigger=document.querySelector('.w2mCap_trigger');
        const error=[...document.querySelectorAll('.w2mCap_note')].map((n)=>n.textContent).filter((t)=>t!=='');
        return {label: trigger?.textContent ?? null, on: trigger?.getAttribute('data-on') ?? null, expanded: trigger?.getAttribute('aria-expanded') ?? null, menu: document.querySelector('.w2mCap_menu') !== null, error};
      `);
      report.capabilityProbe = { opened, menu, temp, after };
    }
    if (process.env.W2M_DECISION_PROBE === '1') {
      const read = async (expression) => {
        const value = await evaluate(`JSON.stringify((() => { ${expression} })())`);
        return value === null ? null : JSON.parse(value);
      };
      const badge = await read(`
        const b=document.querySelector('.w2mDcBadge');
        return {found:b!==null, tone:b?.getAttribute('data-tone') ?? null, text:(b?.textContent ?? '').trim()};
      `);
      const opened = await read(`
        const b=document.querySelector('.w2mDcBadge');
        if(b===null)return{clicked:false};
        b.click();
        return{clicked:true};
      `);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const drawer = await read(`
        const d=document.querySelector('.w2mDcDrawer');
        return {found:d!==null, hidden:d===null?null:d.hidden, title:document.querySelector('.w2mDcDrawerTitle')?.textContent ?? null, body:(document.querySelector('.w2mDcBody')?.innerText ?? '').slice(0,300)};
      `);
      const closed = await read(`
        const b=[...document.querySelectorAll('.w2mDcDrawer .w2mDcBtn')].find((x)=>x.textContent==='关闭');
        if(b===undefined)return{found:false};
        b.click();
        return{found:true};
      `);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const closedVisibility = await read(`
        const d=document.querySelector('.w2mDcDrawer'), o=document.querySelector('.w2mDcOverlay');
        const disp=(el)=>el===null?null:getComputedStyle(el).display;
        const hit=document.elementFromPoint(24, Math.floor(innerHeight/2));
        return {drawer:disp(d), overlay:disp(o), hitBlocked:hit!==null&&typeof hit.closest==='function'&&hit.closest('.w2mDcOverlay')!==null};
      `);
      const afterClose = await read(`
        const d=document.querySelector('.w2mDcDrawer');
        return{hidden:d===null?null:d.hidden, display:d===null?null:getComputedStyle(d).display};
      `);
      const gpwClicked = await read(`
        const launcher=document.querySelector('.w2mGpw_launcher');
        if(launcher!==null)launcher.click();
        return {launcher:launcher!==null};
      `);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const gpwPanel = await read(`
        return {panel:document.querySelector('.w2mGpw_card')!==null, inboxButton:document.querySelector('.w2mDcGpwBtn')!==null, inboxText:(document.querySelector('.w2mDcGpwBtn')?.textContent ?? '').trim()};
      `);
      const gpwButton = { ...gpwClicked, ...gpwPanel };
      const sidebar = await read(`
        const b=document.querySelector('.w2mDcSidebarBtn');
        return {found:b!==null, text:(b?.textContent ?? '').trim(), tone:b?.getAttribute('data-tone') ?? null};
      `);
      report.decisionProbe = { badge, sidebar, opened, drawer, closed, afterClose, closedVisibility, gpwButton };
      const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
      const postJournal = parse(await evaluate(`
        (async () => {
          const r = await fetch('/api/w2m/composer/journal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'probe-ui', sessionKey: 'probe-ui', draft: 'probe draft text', queue: [{ text: 'queued probe', at: Date.now() }] }) });
          const b = await r.json().catch(() => null);
          return JSON.stringify({ status: r.status, ok: b?.ok === true });
        })()
      `));
      const postHuman = parse(await evaluate(`
        (async () => {
          const r = await fetch('/api/w2m/composer/journal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'session-probe-ui', sessionKey: 'session-probe-ui', draft: 'human draft text', queue: [{ text: 'human queued message', at: Date.now() }] }) });
          const b = await r.json().catch(() => null);
          return JSON.stringify({ status: r.status, ok: b?.ok === true });
        })()
      `));
      const listApi = parse(await evaluate(`
        (async () => {
          const r = await fetch('/api/w2m/composer/journal?list=1');
          const b = await r.json().catch(() => null);
          return JSON.stringify({ status: r.status, ok: b?.ok === true, entries: Array.isArray(b?.entries) ? b.entries.length : null });
        })()
      `));
      const queueBadge = await read(`const b=document.querySelector('.w2mJqBadge'); return {found:b!==null, text:(b?.textContent??'').trim()};`);
      const queueOpened = await read(`const b=document.querySelector('.w2mJqBadge'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const queueDrawer = await read(`
        const d=document.querySelector('.w2mJqDrawer');
        const fold=d?.querySelector('.w2mJqClientFold') ?? null;
        return {
          found:d!==null,
          hidden:d===null?null:d.hidden,
          title:(d?.querySelector('.w2mDcDrawerTitle')?.textContent ?? null),
          body:((d?.querySelector('.w2mDcBody')?.innerText ?? '')).slice(0,600),
          foldExists:fold!==null,
          foldOpen:fold===null?null:fold.open===true,
        };
      `);
      const foldOpened = await read(`
        const fold=document.querySelector('.w2mJqClientFold');
        if(fold===null)return{opened:false,text:''};
        fold.open=true;
        return {opened:true, text:((document.querySelector('.w2mJqClientFoldBody')?.innerText ?? '')).slice(0,400)};
      `);
      const queueGpw = await read(`return {button:document.querySelector('.w2mJqGpwBtn')!==null};`);
      const queueDock = await read(`return {chip:document.querySelector('.w2mJqDockChip')!==null, dock:document.querySelector('[data-fang-entry="queue-journal"]')!==null};`);
      await evaluate(`fetch('/api/w2m/composer/journal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'probe-ui', draft: '', queue: [] }) })`);
      const queueClosed = await read(`const b=[...document.querySelectorAll('.w2mJqDrawer .w2mDcBtn')].find((x)=>x.textContent==='关闭'); if(b===undefined)return{closed:false}; b.click(); return{closed:true};`);
      await new Promise((resolve) => setTimeout(resolve, 350));
      report.queueProbe = { postJournal, postHuman, listApi, queueBadge, queueOpened, queueDrawer, foldOpened, queueGpw, queueDock, queueClosed };
      const parseP = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
      const ingest = parseP(await evaluate(`
        (async () => {
          const ids = [];
          let ok = true;
          for (const title of ['probe-batch-1', 'probe-batch-2']) {
            const r = await fetch('/api/w2m/decisions/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ producer: 'probe', level: 'blue', title, context: 'parity probe', options: [{ value: 'ok', label: 'OK' }] }) });
            const b = await r.json().catch(() => null);
            if (b?.ok === true) ids.push(b?.ticket?.id ?? null); else ok = false;
          }
          return JSON.stringify({ ok, ids });
        })()
      `));
      const openInbox = await read(`const b=document.querySelector('.w2mDcBadge'); if(b===null)return{found:false}; b.click(); return{found:true};`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const batch = await read(`
        const d=document.querySelector('.w2mDcDrawer');
        const sp=document.querySelector('.w2mDcSidePanels'); if(sp!==null) sp.open=true;
        const badgeEl=document.querySelector('.w2mDcBadge');
        const sideEl=document.querySelector('.w2mDcSidebarBtn');
        return {open:d!==null&&d.style.display!=='none', resolveButton:document.querySelector('.w2mDcBatchResolve')!==null, abandonButton:document.querySelector('.w2mDcBatchAbandon')!==null, sidePanels:sp!==null, sideText:(document.querySelector('.w2mDcSideBody')?.innerText ?? '').slice(0,200), badgeTone:badgeEl?.getAttribute('data-tone')??null, badgeText:(badgeEl?.textContent??'').trim(), sidebarText:(sideEl?.textContent??'').trim()};
      `);
      const keyboard = await read(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return {selected:document.querySelector('.w2mDcSelected')!==null};`);
      const clickedBatch = await read(`const b=document.querySelector('.w2mDcBatchResolve'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const afterBatch = parseP(await evaluate(`
        (async () => {
          const r = await fetch('/api/w2m/decisions?includeArchived=1');
          const b = await r.json().catch(() => null);
          const items = Array.isArray(b?.items) ? b.items : [];
          const mine = items.find((item) => String(item?.title ?? '').startsWith('probe-batch')) ?? null;
          return JSON.stringify({ found: mine !== null, status: mine?.status ?? null, pendingMine: items.some((item) => String(item?.title ?? '').startsWith('probe-batch') && (item?.status === 'pending' || item?.status === undefined)) });
        })()
      `));
      const relay = await read(`const b=document.querySelector('.w2mDcRelayBtn'); return {found:b!==null, display:b===null?null:getComputedStyle(b).display};`);
      const ui324 = await read(`
        const badge=document.querySelector('.w2mDcBadge');
        const count=document.querySelector('.w2mDcBadgeCount');
        const drawer=document.querySelector('.w2mDcDrawer');
        const bodyEl=document.querySelector('.w2mDcDrawer .w2mDcBody');
        const side=document.querySelector('.w2mDcSidebarBtn');
        const qbadge=document.querySelector('.w2mJqBadge');
        const rect=(el)=>el===null?null:el.getBoundingClientRect();
        const br=rect(badge), dr=rect(drawer), qr=rect(qbadge);
        return {
          badgeText:(badge?.textContent??'').trim(),
          badgeTone:badge?.getAttribute('data-tone')??null,
          badgeCount:(count?.textContent??'').trim(),
          badgeRect:br?{top:Math.round(br.top),left:Math.round(br.left),width:Math.round(br.width),height:Math.round(br.height)}:null,
          drawerOpen:drawer!==null&&drawer.style.display!=='none',
          drawerHeight:dr===null?null:Math.round(dr.height),
          drawerTop:dr===null?null:Math.round(dr.top),
          drawerRightGap:dr===null?null:Math.round(innerWidth-dr.right),
          bodyOverflow:bodyEl===null?null:getComputedStyle(bodyEl).overflowY,
          sidebarText:(side?.textContent??'').trim(),
          gpwAiSection:document.querySelector('.w2mGpwAi')!==null,
          queueTone:qbadge?.getAttribute('data-tone')??null,
          queueBottomGap:qr===null?null:Math.round(innerHeight-qr.bottom),
          queueRightGap:qr===null?null:Math.round(innerWidth-qr.right),
          viewport:{w:innerWidth,h:innerHeight},
        };
      `);
      const qOpened = await read(`const b=document.querySelector('.w2mJqBadge'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const jq626 = await read(`
        const sessionsApi=document.querySelector('.w2mJqDrawer');
        const eye=document.querySelector('.w2mJqEye');
        const clearAll=document.querySelector('.w2mJqClearAll');
        const bodyText=(document.querySelector('.w2mJqDrawer .w2mDcBody')?.innerText ?? '');
        if(eye!==null) eye.click();
        const bodyAfter=(document.querySelector('.w2mJqDrawer .w2mDcBody')?.innerText ?? '');
        if(eye!==null) eye.click();
        return {
          eye: eye!==null,
          clearAll: clearAll!==null,
          idHiddenByDefault: !bodyText.includes('Session ID：'),
          idShownAfterEye: bodyAfter.includes('Session ID：'),
          beforeSnippet: bodyText.slice(0, 160),
          afterSnippet: bodyAfter.slice(0, 300),
        };
      `);
      const sessionsApi = parseP(await evaluate(`
        (async () => {
          const r = await fetch('/api/w2m/composer/journal/sessions');
          const b = await r.json().catch(() => null);
          return JSON.stringify({ status: r.status, ok: b?.ok === true, items: Array.isArray(b?.items) ? b.items.length : null });
        })()
      `));
      report.jq626 = { jq626, sessionsApi };
      const qGeom = await read(`const d=document.querySelector('.w2mJqDrawer'); const b=document.querySelector('.w2mJqDrawer .w2mDcBody'); const r=d===null?null:d.getBoundingClientRect(); return {open:d!==null&&d.style.display!=='none', height:r===null?null:Math.round(r.height), bottomGap:r===null?null:Math.round(innerHeight-r.bottom), rightGap:r===null?null:Math.round(innerWidth-r.right), overflow:b===null?null:getComputedStyle(b).overflowY, viewportH:innerHeight};`);
      await read(`const b=[...document.querySelectorAll('.w2mJqDrawer .w2mDcBtn')].find((x)=>x.textContent==='关闭'); if(b!==undefined)b.click(); return{closed:true};`);
      report.ui324 = { ui324, qOpened, qGeom };
      const ensureClosed = await read(`const l=document.querySelector('.w2mGpw_launcher'); if(l===null)return{launcher:false}; if(document.querySelector('.w2mGpw_card')!==null) l.click(); return{launcher:true};`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await read(`const l=document.querySelector('.w2mGpw_launcher'); if(l!==null) l.click(); return{opened:true};`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const gpwOpen = await read(`return {open:document.querySelector('.w2mGpw_card')!==null, overlay:document.querySelector('.w2mGpw_overlay')!==null};`);
      const outsideClick = await read(`const o=document.querySelector('.w2mGpw_overlay'); if(o===null)return{clicked:false}; o.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const outsideClosed = await read(`return {closed:document.querySelector('.w2mGpw_card')===null};`);
      await read(`const l=document.querySelector('.w2mGpw_launcher'); if(l!==null) l.click(); return{opened:true};`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const reopened = await read(`return {open:document.querySelector('.w2mGpw_card')!==null};`);
      await read(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return{sent:true};`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const escClosed = await read(`return {closed:document.querySelector('.w2mGpw_card')===null};`);
      report.gpwClose = { ensureClosed, gpwOpen, outsideClick, outsideClosed, reopened, escClosed };
      await evaluate(`
        (async () => {
          const r = await fetch('/api/w2m/decisions?includeArchived=1');
          const b = await r.json().catch(() => null);
          const ids = (Array.isArray(b?.items) ? b.items : []).filter((item) => String(item?.title ?? '').startsWith('probe-batch') && (item?.status === 'pending' || item?.status === undefined)).map((item) => item.id);
          if (ids.length > 0) await fetch('/api/w2m/decisions/abandon', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
          const close = document.querySelector('.w2mDcDrawer .w2mDcBtn');
          return null;
        })()
      `);
      const rightTab = parseP(await evaluate(`JSON.stringify({ marker: document.body?.dataset?.w2mDecisionRightTab ?? null })`));
      report.parityProbe = { ingest, openInbox, batch, keyboard, clickedBatch, afterBatch, relay, rightTab };
      await evaluate(`fetch('/api/w2m/composer/journal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'probe-ui', draft: '', queue: [] }) })`);
      await evaluate(`fetch('/api/w2m/composer/journal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'session-probe-ui', draft: '', queue: [] }) })`);
    }
    socket.close();
    return report;
  } finally {
    report.browserStderr = browserStderr.slice(0, 2_000);
    browser.kill();
    // Windows keeps handles on a browser profile for a moment after the process is killed, so the
    // removal retries instead of leaving a directory behind on every run.
    await fsp
      .rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      .catch(() => {});
  }
}
