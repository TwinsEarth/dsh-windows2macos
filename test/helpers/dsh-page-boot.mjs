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
 * Read the browser's DevTools endpoint file.
 *
 * Every way this comes back empty means "not written yet", never an error for the caller:
 *
 *   - the file is not there (not created yet, or replaced between the listing and the open);
 *   - it cannot be opened: on Windows the browser holds the file without sharing while it writes,
 *     and that arrives as `EBUSY`;
 *   - it is half written: nothing on the first line, or something that is not a port.
 *
 * The last case used to come back as port `NaN`.
 *
 * @param {string} file - the `DevToolsActivePort` file.
 * @param {(file: string) => string} readFile - reads a file as text. Injected so the failures above can be
 *   produced on every platform: Node always opens with full sharing, so a real `EBUSY` cannot be staged
 *   from inside a test process.
 * @returns {{port: number, browserPath: string} | null} `null` until the file holds a port.
 */
function readDevToolsEndpoint(file, readFile) {
  let text;
  try {
    text = readFile(file);
  } catch {
    return null;
  }
  const [port, browserPath] = text.split('\n');
  const trimmed = (port ?? '').trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) return null;
  return { port: Number(trimmed), browserPath: browserPath ?? '/devtools/browser' };
}

/**
 * Wait for the browser's DevTools endpoint file.
 *
 * @param {string} userDataDir - the browser profile directory.
 * @param {number} timeoutMs - how long to wait.
 * @param {(file: string) => string} [readFile] - how the file is read; the default reads it from disk.
 * @returns {Promise<{port: number, browserPath: string}>}
 */
export async function waitForDevTools(userDataDir, timeoutMs, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = readDevToolsEndpoint(file, readFile);
    if (endpoint !== null) return endpoint;
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
    // v3.5.7: the surface diagnostics and the surfaces themselves. Read on every boot (they are cheap and
    // profile-independent): `__W2M_SURFACES__` says what the six probes answered, every slot entry the bundle
    // registered renders inside a `[data-w2m-surface]` box, and the two DOM-mounted surfaces -- the queue
    // journal's chip/sidebar fallback and the decision inbox badge -- are read by their markers. A disabled
    // row is absent, not greyed. The probe is async, so wait for it (bounded) and give React one render.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await evaluate('window.__W2M_SURFACES__ !== undefined')) === true) break;
      await new Promise((resolve) => { setTimeout(resolve, 300); });
    }
    await new Promise((resolve) => { setTimeout(resolve, 600); });
    const surfacesRead = await evaluate(`JSON.stringify((() => {
      const d = window.__W2M_SURFACES__ ?? null;
      const has = (selector) => document.querySelector(selector) !== null;
      return {
        diag: d === null ? null : { ok: d.ok, fallback: d.fallback, definite: d.definite, probeBlocked: d.probeBlocked, available: d.available, reasons: d.reasons, probedAt: d.probedAt },
        markers: [...document.querySelectorAll('[data-w2m-surface]')].map((node) => node.getAttribute('data-w2m-surface')),
        journalChip: has('[data-w2m-jq-chip]'),
        journalFallback: has('[data-w2m-jq-fallback]'),
        decisionInbox: has('.w2mDcBadge'),
      };
    })())`);
    report.surfaces = typeof surfacesRead === 'string' ? JSON.parse(surfacesRead) : null;
    if (process.env.W2M_SURFACES_PROBE === '1') {
      // The row-enablement direction, driven in the page: `W2M_SURFACES_PROBE=1` makes the caller enable
      // the archive row in its throwaway profile. This reads the panel and, when the archive surface is
      // available, opens its tab and checks the archive view is the page body.
      const read = async (expression) => {
        const value = await evaluate(`JSON.stringify((() => { ${expression} })())`);
        return value === null ? null : JSON.parse(value);
      };
      // v3.5.7: the archive row has no entry of its own, so the backup seat is the door it opens. With the
      // repository row disabled that seat must read 「归档备份」 -- the repository label would promise a
      // backend this profile does not have. Read it before the click switches the main page.
      const seat = await read(`
        const b=document.querySelector('[data-w2m-backup-sidebar]');
        if(b===null)return{found:false};
        const row=b.closest('.w2mBackup_sideEntry') ?? b.parentElement ?? b;
        const text=(row.innerText || row.textContent || '').trim();
        return {found:true, text:text.slice(0,120), archiveLabel:(text.match(/归档备份/g)??[]).length, backupLabel:(text.match(/备份&还原/g)??[]).length};
      `);
      const opened = await read(`const b=document.querySelector('[data-w2m-backup-sidebar]'); if(b===null)return{found:false}; b.click(); return{found:true};`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const panel = await read(`
        const p=document.querySelector('[data-w2m-backup-panel="page"]');
        const archiveTab=document.querySelector('[data-w2m-backup-tab="archive"]');
        return {panel:p!==null, tabs:document.querySelector('[data-w2m-backup-tabs]')!==null, archiveTab:archiveTab!==null, active:archiveTab?.getAttribute('aria-selected')??null};
      `);
      const clicked = await read(`const b=document.querySelector('[data-w2m-backup-tab="archive"]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      // One real archive in the throwaway home, created from the page, then verified from the page: the
      // tab's whole loop, not just its first paint.
      const created = await read(`const b=document.querySelector('[data-w2m-archive-action="create"]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const listed = await read(`
        return {
          rows: document.querySelectorAll('[data-w2m-archive-row]').length,
          verifyButtons: document.querySelectorAll('[data-w2m-archive-action="verify"]').length,
          planButtons: document.querySelectorAll('[data-w2m-archive-action="plan"]').length,
        };
      `);
      const verified = await read(`const b=document.querySelector('[data-w2m-archive-action="verify"]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const verifiedCard = await read(`
        const card=document.querySelector('[data-w2m-archive-verify="true"]');
        return {
          present:card!==null,
          counts:[...document.querySelectorAll('[data-w2m-archive-count]')].map((x)=>x.getAttribute('data-w2m-archive-count')),
          text:(card?.innerText ?? '').slice(0,240),
        };
      `);
      const archive = await read(`
        const status=document.querySelector('[data-w2m-archive-status="true"]');
        return {
          status:status!==null,
          create:document.querySelector('[data-w2m-archive-create="true"]')!==null,
          import:document.querySelector('[data-w2m-archive-import="true"]')!==null,
          repoStatus:document.querySelector('[data-w2m-backup-panel="status"]')!==null,
          markers:[...document.querySelectorAll('[data-w2m-surface]')].map((node)=>node.getAttribute('data-w2m-surface')),
        };
      `);
      report.surfacesProbe = { seat, opened, panel, clicked, created, listed, verified, verifiedCard, archive };
    }
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
      const queueBadge = await read(`const b=document.querySelector('[data-w2m-jq-chip]'); return {found:b!==null, text:(b?.textContent??'').trim(), status:b?.getAttribute('data-w2m-jq-status')??null};`);
      const queueOpened = await read(`const b=document.querySelector('[data-w2m-jq-chip]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const queueDrawer = await read(`
        const d=document.querySelector('[data-w2m-jq-drawer]');
        const fold=d?.querySelector('.w2mJqClientFold') ?? null;
        return {
          found:d!==null,
          hidden:d===null?null:d.hidden,
          status:d?.getAttribute('data-w2m-jq-status') ?? null,
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
      const queueDock = await read(`return {chip:document.querySelector('[data-w2m-jq-chip]')!==null, dock:false};`);
      await evaluate(`fetch('/api/w2m/composer/journal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'probe-ui', draft: '', queue: [] }) })`);
      const queueClosed = await read(`const b=document.querySelector('[data-w2m-jq-close]'); if(b===null)return{closed:false}; b.click(); return{closed:true};`);
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
        const qbadge=document.querySelector('[data-w2m-jq-chip]');
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
          gpwAiSection:document.querySelector('.w2mAiPanel')!==null,
          historyButton:document.querySelector('.w2mHistBtn')!==null,
          targetButton:document.querySelector('.w2mTarget_trigger')!==null,
          chatButton:document.querySelector('.w2mChat_trigger')!==null,
          fleetStatusText:(document.querySelector('.w2mFleetStatus')?.innerText??null),
          queueTone:qbadge?.getAttribute('data-tone')??null,
          queueChipStatus:qbadge?.getAttribute('data-w2m-jq-status')??null,
          queueChipRect:qr?{top:Math.round(qr.top),left:Math.round(qr.left),width:Math.round(qr.width),height:Math.round(qr.height)}:null,
          queueDrawerStatus:document.querySelector('[data-w2m-jq-drawer]')?.getAttribute('data-w2m-jq-status')??null,
          viewport:{w:innerWidth,h:innerHeight},
        };
      `);
      const qOpened = await read(`const b=document.querySelector('[data-w2m-jq-chip]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const jq626 = await read(`
        const clearAll=document.querySelector('.w2mJqClearAll');
        const bodyText=(document.querySelector('.w2mJqDrawer .w2mDcBody')?.innerText ?? '');
        return {
          clearAll: clearAll!==null,
          noSessionIdLabel: !bodyText.includes('Session ID'),
          noRawSessionKey: !/session-[0-9a-f]{8}/.test(bodyText),
          bodySnippet: bodyText.slice(0, 300),
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
      const historyOpened = await read(`const b=document.querySelector('.w2mHistBtn'); if(b===null)return{found:false}; b.click(); return{found:true};`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const historyWindow = await read(`
        const win=document.querySelector('.w2mHistWindow');
        return {open:win!==null, title:(win?.querySelector('.w2mHistTitle')?.textContent??null), hint:(win?.querySelector('.w2mHistHint')?.textContent??null), rows:win===null?0:win.querySelectorAll('.w2mHistItem').length, wrapped:win!==null&&win.parentElement?.classList.contains('w2mHistWrap')===true, position:win===null?null:getComputedStyle(win).position};
      `);
      const historyCloseClicked = await read(`const b=document.querySelector('.w2mHistClose'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const historyClosed = await read(`return {closed:document.querySelector('.w2mHistWindow')===null};`);
      report.historyProbe = { historyOpened, historyWindow, historyCloseClicked, historyClosed };
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
      // v3.7.3: the GPW operations row is opt-in. Measure the whole real-page transition, not just the
      // presence of a button: no row/preference initially, explicit pin mounts one row, and unpin removes it.
      const pinDefault = await read(`return {row:document.querySelector('[data-w2m-gpw-sidebar]')!==null, preference:window.localStorage?.getItem('w2m.gpw.sidebar.pinned') ?? null};`);
      await read(`const l=document.querySelector('.w2mGpw_launcher'); if(l!==null) l.click(); return{opened:l!==null};`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const pinButton = await read(`const b=document.querySelector('[data-w2m-gpw-sidebar-pin]'); return {found:b!==null,state:b?.getAttribute('data-w2m-gpw-sidebar-pin') ?? null,text:(b?.textContent ?? '').trim()};`);
      const pinClicked = await read(`const b=document.querySelector('[data-w2m-gpw-sidebar-pin]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const pinned = await read(`const b=document.querySelector('[data-w2m-gpw-sidebar-pin]'); return {row:document.querySelector('[data-w2m-gpw-sidebar]')!==null,state:b?.getAttribute('data-w2m-gpw-sidebar-pin') ?? null,preference:window.localStorage?.getItem('w2m.gpw.sidebar.pinned') ?? null};`);
      const unpinClicked = await read(`const b=document.querySelector('[data-w2m-gpw-sidebar-pin]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const unpinned = await read(`const b=document.querySelector('[data-w2m-gpw-sidebar-pin]'); return {row:document.querySelector('[data-w2m-gpw-sidebar]')!==null,state:b?.getAttribute('data-w2m-gpw-sidebar-pin') ?? null,preference:window.localStorage?.getItem('w2m.gpw.sidebar.pinned') ?? null};`);
      const repinClicked = await read(`const b=document.querySelector('[data-w2m-gpw-sidebar-pin]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const repinned = await read(`const b=document.querySelector('[data-w2m-gpw-sidebar-pin]'); return {row:document.querySelector('[data-w2m-gpw-sidebar]')!==null,state:b?.getAttribute('data-w2m-gpw-sidebar-pin') ?? null,preference:window.localStorage?.getItem('w2m.gpw.sidebar.pinned') ?? null};`);
      await read(`const l=document.querySelector('.w2mGpw_launcher'); if(l!==null && document.querySelector('.w2mGpw_card')!==null) l.click(); return{closed:true};`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const opsOpened = await read(`const b=document.querySelector('.w2mGpw_sideEntry'); if(b===null)return{found:false}; b.click(); return{found:true};`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const opsPanel = await read(`const p=document.querySelector('.w2mOpsPanel'); return {open:p!==null, tabs:[...document.querySelectorAll('.w2mOpsTab')].map((x)=>x.textContent), active:(document.querySelector('.w2mOpsTab[data-active=true]')?.textContent??null)};`);
      // v3.5.0: the fleet version-drift card lives in the operation panel's action section (「操作入口」 tab), and
      // the profile may have no relay configured, in which case the card must render its neutral "unavailable"
      // state instead of blank. Switch to that tab before reading the card.
      const opsActionsTab = await read(`const tabs=[...document.querySelectorAll('.w2mOpsTab')]; const a=tabs.find((x)=>x.textContent.includes('操作入口')); if(a===undefined)return{clicked:false}; a.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const opsFleetVersion = await read(`
        const card=document.querySelector('[data-w2m-fleet-version-card]');
        const title=card?.querySelector('.w2mVerTitle');
        return {
          present: card!==null,
          state: card?.getAttribute('data-w2m-version-state') ?? null,
          title: (title?.textContent ?? '').trim(),
          copyButton: card===null ? false : (card.querySelector('[data-w2m-version-copy]')!==null),
          allCurrentBadge: card===null ? false : (card.querySelector('[data-w2m-version-all-current]')!==null),
          text: (card?.innerText ?? '').slice(0, 200),
        };
      `);
      const opsQueueTab = await read(`const tabs=[...document.querySelectorAll('.w2mOpsTab')]; const q=tabs.find((x)=>x.textContent.includes('消息与草稿')); if(q===undefined)return{clicked:false}; q.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const opsQueueSection = await read(`return {section:document.querySelector('.w2mOpsSection')!==null, openButton:[...document.querySelectorAll('.w2mOpsBtn')].some((b)=>b.textContent.includes('打开队列日志'))};`);
      const opsClosed = await read(`const b=document.querySelector('.w2mGpw_fullPage .w2mGpw_close'); if(b===null)return{closed:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const opsGone = await read(`return {closed:document.querySelector('.w2mGpw_fullPage')===null};`);
      report.gpwSidebarPin = { pinDefault, pinButton, pinClicked, pinned, unpinClicked, unpinned, repinClicked, repinned };
      report.opsProbe = { opsOpened, opsPanel, opsActionsTab, opsFleetVersion, opsQueueTab, opsQueueSection, opsClosed, opsGone };
      // v3.4.9: the backup entry and the page it switches to. The opt-in probes enable the backup row in the
      // installed copy (see `W2M_DECISION_PROBE` / `W2M_BACKUP_PROBE`), so the panel reads live host state; the
      // four action markers and the log are what this step measures, not the host routes (those have their own
      // suites). The seat must show ONE label: the component draws icon + text, so a host-side label would print
      // the text twice in the same row ("备份&还原 备份&还原"). Read the enclosing row and count.
      const backupSeatText = await read(`
        const b=document.querySelector('[data-w2m-backup-sidebar]');
        if(b===null) return {found:false};
        const row=b.closest('.w2mBackup_sideEntry') ?? b.parentElement ?? b;
        const text=(row.innerText || row.textContent || '').trim();
        const count=(text.match(/备份&还原/g) ?? []).length;
        return {found:true, text:text.slice(0,120), count};
      `);
      const backupOpened = await read(`const b=document.querySelector('[data-w2m-backup-sidebar]'); if(b===null)return{found:false}; b.click(); return{found:true};`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const backupPanel = await read(`
        const p=document.querySelector('[data-w2m-backup-panel]');
        return {
          open: p!==null,
          title: (document.querySelector('.w2mBackup_title')?.textContent ?? null),
          actions: [...document.querySelectorAll('[data-w2m-backup-action]')].map((x) => x.getAttribute('data-w2m-backup-action')),
          cards: p===null?0:p.querySelectorAll('.w2mBackup_card').length,
          hasUnlock: (p?.querySelector('[data-w2m-backup-unlock]') ?? null)!==null,
          text: (p?.innerText ?? '').slice(0, 240),
        };
      `);
      report.backupProbe = { backupOpened, backupPanel };
      // v3.4.9: the four one-click handlers must be wired even when the row is disabled: each click attempts its
      // route, gets the route-missing refusal, and records it in the log area without taking the page down.
      const backupClicks = [];
      for (const action of ['run', 'restore', 'archive', 'verify']) {
        const clicked = await read(`const b=document.querySelector('[data-w2m-backup-action="${action}"]'); if(b===null)return{action:'${action}',clicked:false}; b.click(); return{action:'${action}',clicked:true};`);
        await new Promise((resolve) => setTimeout(resolve, 700));
        backupClicks.push(clicked);
      }
      // v3.5.0/P1: the two scope entries must exist too. `backup-active` works without the session list (the
      // scan route is missing on a disabled row, so its click reaches the run route and logs the refusal);
      // `backup-selected` must be visibly disabled because there is nothing to pick without a scan.
      const scopeActions = await read(`
        const read = (id) => {
          const b = document.querySelector('[data-w2m-backup-action="' + id + '"]');
          return b === null ? null : { disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true', label: b.textContent };
        };
        return { selected: read('backup-selected'), active: read('backup-active'), pickers: document.querySelectorAll('[data-w2m-backup-pick]').length, scanState: document.querySelector('[data-w2m-backup-scan-state]')?.getAttribute('data-w2m-backup-scan-state') ?? null };
      `);
      const activeClick = await read(`const b=document.querySelector('[data-w2m-backup-action="backup-active"]'); if(b===null)return{action:'backup-active',clicked:false}; b.click(); return{action:'backup-active',clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      backupClicks.push(activeClick);
      const backupLog = await read(`
        const rows=[...document.querySelectorAll('.w2mBackup_logRow')];
        return {
          rows: rows.length,
          text: rows.map((row) => row.innerText).join(' | ').slice(0, 400),
          panelStillOpen: document.querySelector('[data-w2m-backup-panel]')!==null,
        };
      `);
      report.backupProbe = { backupOpened, backupPanel, backupClicks, backupLog, scopeActions, backupSeatText };
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
    // v3.6.0: the queue journal's own end-to-end probe. Unlike the decision probe (which posts to the
    // host route directly), this one drives the *slotted* chip: a real draft is typed into the real
    // composer, the chip opens the drawer built from `shell.overlay`, and restore writes the draft back
    // through the slot's `inputActions`. The host file under `$DSH_HOME/xclient/queue-journal` is
    // checked by `dsh-loader-driver.mjs` after this page boot.
    if (process.env.W2M_QUEUE_JOURNAL_PROBE === '1') {
      const read = async (expression) => {
        const value = await evaluate(`JSON.stringify((() => { ${expression} })())`);
        return value === null ? null : JSON.parse(value);
      };
      const readAsync = async (expression) => {
        const value = await evaluate(expression);
        return typeof value === 'string' ? JSON.parse(value) : value;
      };
      let chip = { found: false };
      for (let attempt = 0; attempt < 40; attempt += 1) {
        chip = await read(`const b=document.querySelector('[data-w2m-jq-chip]'); return {found:b!==null, status:b?.getAttribute('data-w2m-jq-status')??null, text:(b?.textContent??'').trim()};`);
        if (chip.found === true) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const diagnostics = await read(`const d=window.__W2M_QUEUE_JOURNAL__; return d===undefined?null:{status:d.status,surface:d.surface,reasons:d.reasons,dshVersion:d.dshVersion,checkedAt:d.checkedAt,slotAttempts:d.slotAttempts};`);
      // A throwaway profile boots with the Host-release modal open (the served page has no matching
      // release). It traps focus, so dismiss it before driving the real composer. Programmatic clicks
      // on the chip would still work under it; typing would not.
      const dismissed = await read(`
        const copy=[...document.querySelectorAll('p, div')].find((node)=>/预览阶段/u.test(String(node.textContent||'')) && node.children.length===0);
        const scope=copy?.closest('[role="dialog"]') ?? copy?.closest('[class*="overlay" i], [class*="modal" i]') ?? copy?.parentElement?.parentElement ?? null;
        const buttons=scope===null?[]:[...scope.querySelectorAll('button')];
        const target=buttons.find((b)=>/稍后|以后|继续|关闭|later|LATER|Later|閉じる/u.test(String(b.textContent||''))) ?? buttons.find((b)=>b.hasAttribute('data-modal-autofocus')) ?? buttons[0] ?? null;
        if(target!==null)target.click();
        return {dismissed:target!==null, text:String(target?.textContent||'').trim(), scoped:scope!==null};
      `);
      // Wait for the modal's focus trap to actually leave the tree: its close animation makes a fixed
      // 450 ms budget flaky, and the retry below must not race the trap.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const modal = await read(`return {open:document.querySelector('[role="dialog"]')!==null};`);
        if (modal === null || modal.open === false) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const composerExpression = `
        const nodes=[...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el)=>{const r=el.getBoundingClientRect(); return r.width>80&&r.height>16;}).sort((a,b)=>{const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect(); return rb.width*rb.height-ra.width*ra.height;});
        const el=nodes[0];
      `;
      const focused = await read(`
        ${composerExpression}
        if(!el)return {found:false};
        const r=el.getBoundingClientRect();
        el.focus();
        if(el.tagName==='TEXTAREA'){const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set; if(setter)setter.call(el,'probe-journal-draft'); else el.value='probe-journal-draft'; el.dispatchEvent(new Event('input',{bubbles:true}));}
        return {found:true, tag:el.tagName, focused:document.activeElement===el, rect:{x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}};
      `);
      // A real pointer press focuses the Lexical editor; `element.click()` produces an untrusted event
      // the editor may ignore, and `Input.insertText` only reaches a focused editing host. The press
      // is retried because the Host-release modal's close animation may keep the focus trap briefly.
      const readTyped = () => read(`
        ${composerExpression}
        const text=String(el?(el.tagName==='TEXTAREA'?el.value:el.innerText||''):'');
        return {typed:text.includes('probe-journal-draft'), tag:el?.tagName??null, text:text.slice(0,80)};
      `);
      let typed = await readTyped();
      if (focused.found === true && focused.tag !== 'TEXTAREA' && focused.rect !== undefined) {
        const { x, y } = focused.rect;
        for (let attempt = 0; attempt < 6 && typed.typed !== true; attempt += 1) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
          await new Promise((resolve) => setTimeout(resolve, 200));
          const active = await read(`${composerExpression} return {focused:el!==undefined&&document.activeElement===el};`);
          if (active !== null && active.focused === true) {
            await cdp.send('Input.insertText', { text: 'probe-journal-draft' }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          typed = await readTyped();
        }
      }
      // Headless runs occasionally lose the CDP editing session right after the Host-release modal
      // closes. The journal pipeline is what this probe asserts, so fall back to the same trusted
      // DOM insertion the compatibility path uses; a real `input` event is still what reaches React.
      if (typed.typed !== true) {
        typed = await read(`
          ${composerExpression}
          if(!el)return {typed:false, tag:null, text:''};
          el.focus();
          try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, 'probe-journal-draft'); } catch { /* reported below */ }
          const text=String(el.tagName==='TEXTAREA'?el.value:el.innerText||'');
          return {typed:text.includes('probe-journal-draft'), tag:el.tagName, text:text.slice(0,80)};
        `);
        // Lexical commits the DOM mutation a tick later; the immediate innerText read races it.
        await new Promise((resolve) => setTimeout(resolve, 400));
        typed = await readTyped();
      }
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      const saved = await readAsync(`
        (async () => {
          const r = await fetch('/api/w2m/composer/journal?list=1');
          const b = await r.json().catch(() => null);
          const entries = Array.isArray(b?.entries) ? b.entries : [];
          const mine = entries.find((e) => String(e?.draft ?? '').includes('probe-journal-draft')) ?? null;
          return JSON.stringify({ status: r.status, found: mine !== null, key: mine?.key ?? null, queue: Array.isArray(mine?.queue) ? mine.queue.length : null });
        })()
      `);
      const opened = await read(`const b=document.querySelector('[data-w2m-jq-chip]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true};`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      // v3.6.1: the host diagnostics route the client uses to explain a failed read.
      const diagnosticsRoute = await readAsync(`
        (async () => {
          const r = await fetch('/api/w2m/composer/journal/diagnostics');
          const b = await r.json().catch(() => null);
          return JSON.stringify({
            status: r.status,
            ok: b?.ok === true,
            dirType: typeof b?.dir,
            dirEndsWith: typeof b?.dir === 'string' ? b.dir.replace(/\\\\/g, '/').endsWith('/queue-journal') : false,
            entries: Number.isInteger(b?.entries),
            writable: typeof b?.writable,
            lastWriteAt: b?.lastWriteAt === null || typeof b?.lastWriteAt === 'string',
            errors: Array.isArray(b?.errors),
          });
        })()
      `);
      const drawer = await read(`
        const d=document.querySelector('[data-w2m-jq-drawer]');
        const body=(d?.querySelector('.w2mDcBody')?.innerText??'');
        return {found:d!==null, marker:d?.getAttribute('data-w2m-jq-drawer')??null, status:d?.getAttribute('data-w2m-jq-status')??null, rows:d===null?0:d.querySelectorAll('[data-w2m-jq-entry]').length, hasDraft:body.includes('probe-journal-draft'), hasRestore:d!==null&&d.querySelector('[data-w2m-jq-restore-draft]')!==null, unverifiedNotice:d!==null&&d.querySelector('.w2mJqNotice')!==null};
      `);
      const clearedFocus = await read(`
        ${composerExpression}
        if(!el)return{found:false};
        el.focus(); return {found:true};
      `);
      if (clearedFocus.found === true) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, sessionId);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, sessionId);
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const cleared = await read(`
        ${composerExpression}
        const text=String(el?(el.tagName==='TEXTAREA'?el.value:el.innerText||''):'');
        return {cleared:true, contains:text.includes('probe-journal-draft')};
      `);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const restored = await read(`const b=document.querySelector('[data-w2m-jq-restore-draft]'); if(b===null)return{clicked:false}; b.click(); return{clicked:true, key:b.getAttribute('data-w2m-jq-restore-draft')};`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const afterRestore = await read(`
        ${composerExpression}
        const text=String(el?(el.tagName==='TEXTAREA'?el.value:el.innerText||''):'');
        return {contains:text.includes('probe-journal-draft'), text:text.slice(0,120)};
      `);
      const closed = await read(`const b=document.querySelector('[data-w2m-jq-close]'); if(b===null)return{closed:false}; b.click(); return{closed:true};`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const closeState = await read(`return {closed:document.querySelector('[data-w2m-jq-drawer]')===null};`);
      report.queueJournalProbe = { chip, diagnostics, diagnosticsRoute, dismissed, focused, typed, saved, opened, drawer, cleared, restored, afterRestore, closed, closeState };
    }
    // v3.5.x: the unlock dialog probe. It is independent of the decision-center probe because the backup
    // panel lives on the session-less left sidebar: its seat and main page are visible on the landing page,
    // while the decision probe's GPW launcher/composer checks need an open conversation.
    if (process.env.W2M_BACKUP_PROBE === '1') {
      const read = async (expression) => {
        const value = await evaluate(`JSON.stringify((() => { ${expression} })())`);
        return value === null ? null : JSON.parse(value);
      };
      const backupOpened = await read(`const b=document.querySelector('[data-w2m-backup-sidebar]'); if(b===null)return{found:false}; b.click(); return{found:true};`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const backupPanel = await read(`
        const p=document.querySelector('[data-w2m-backup-panel="page"]');
        return {
          open: p!==null,
          title: (document.querySelector('.w2mBackup_title')?.textContent ?? null),
          unlockCard: document.querySelector('[data-w2m-backup-panel="unlock"]')!==null,
          trigger: document.querySelector('[data-w2m-backup-unlock-open]')!==null,
          tabs: document.querySelector('[data-w2m-backup-tabs]')!==null,
          archiveTab: document.querySelector('[data-w2m-backup-tab="archive"]')!==null,
        };
      `);
      const unlockOpened = await read(`const b=document.querySelector('[data-w2m-backup-unlock-open]'); if(b===null)return{found:false}; b.click(); return{found:true};`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const unlockDialog = await read(`
        const d=document.querySelector('[data-w2m-backup-unlock-dialog]');
        const o=document.querySelector('[data-w2m-backup-unlock-overlay]');
        return {
          found: d!==null,
          role: d?.getAttribute('role') ?? null,
          ariaModal: d?.getAttribute('aria-modal') ?? null,
          labelledBy: d?.getAttribute('aria-labelledby') ?? null,
          overlay: o!==null,
          optionA: d!==null && d.querySelector('[data-w2m-backup-unlock-dialog-local]')!==null,
          command: (d?.querySelector('[data-w2m-backup-unlock-command]')?.textContent ?? '').trim(),
          copy: d!==null && d.querySelector('[data-w2m-backup-unlock-copy]')!==null,
          refresh: d!==null && d.querySelector('[data-w2m-backup-unlock-refresh]')!==null,
          passwordFields: d===null ? 0 : d.querySelectorAll('input[type="password"], input[type="text"], textarea').length,
        };
      `);
      await read(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return{sent:true};`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const unlockClosed = await read(`return {closed: document.querySelector('[data-w2m-backup-unlock-dialog]')===null, overlayGone: document.querySelector('[data-w2m-backup-unlock-overlay]')===null};`);
      report.backupProbe = { backupOpened, backupPanel, unlockOpened, unlockDialog, unlockClosed };
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
