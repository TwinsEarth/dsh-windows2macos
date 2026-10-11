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
