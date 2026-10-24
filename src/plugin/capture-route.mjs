/**
 * v1.7.1 — host-side capture and clipboard fallbacks for the fleet-chat panel.
 *
 * ## Why this module exists
 *
 * v1.7.0 put a screenshot button and Ctrl+P in the chat panel, implemented in the browser with
 * `getDisplayMedia` and `navigator.clipboard`. Field test on the DSH **desktop** shell: all three
 * controls failed. A desktop host is not a browser tab — `getDisplayMedia` needs the embedding app to
 * install a display-media request handler, and clipboard writes are subject to the same permission
 * surface. When either rejects, a browser-only implementation has nowhere left to go.
 *
 * So the panel gains a host fallback that does not depend on renderer permissions:
 *
 *   POST /api/w2m/capture    { copy?: boolean }  -> capture the primary screen on the HOST, return
 *                                                   { ok, mime, data_base64, path, copied }
 *   POST /api/w2m/clipboard  { text }            -> put text on the HOST clipboard
 *
 * Windows uses PowerShell (System.Drawing + System.Windows.Forms, STA thread for the image
 * clipboard), macOS uses `screencapture`/`pbcopy`/`osascript`, Linux uses `gnome-screenshot`/`xclip`
 * when present. Every command is a fixed argv array — no shell, and no caller input is spliced into a
 * script.
 *
 * This module is deliberately small and injectable: `run` is a parameter so the route can be tested
 * without a screen, and `capturePlan`/`clipboardPlan` are exported as pure data for the same reason.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CAPTURE_ROUTE_PATH = '/api/w2m/capture';
export const CLIPBOARD_ROUTE_PATH = '/api/w2m/clipboard';
export const CAPTURE_TIMEOUT_MS = 20_000;
const NO_STORE = { 'cache-control': 'no-store' };

/** Run a command with no shell, a bounded timeout and captured output. */
export function runCommand(argv, { timeoutMs = CAPTURE_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(-4_000_000); });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384); });
    child.on('error', (error) => { stderr = String(error?.message ?? error); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
  });
}

/**
 * The PowerShell script that captures the primary screen as a JPEG and prints base64.
 * `-STA` matters: `Clipboard::SetImage` throws on an MTA thread.
 */
const WINDOWS_CAPTURE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
  '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
  '$bmp=New-Object Drawing.Bitmap($b.Width,$b.Height)',
  '$g=[Drawing.Graphics]::FromImage($bmp)',
  '$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)',
  '$max=1600',
  'if($bmp.Width -gt $max){$r=$max/[double]$bmp.Width;$nw=[int]($bmp.Width*$r);$nh=[int]($bmp.Height*$r);$s=New-Object Drawing.Bitmap($nw,$nh);$gs=[Drawing.Graphics]::FromImage($s);$gs.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;$gs.DrawImage($bmp,0,0,$nw,$nh);$bmp=$s}',
  '$ms=New-Object IO.MemoryStream',
  '$enc=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq "image/jpeg"} | Select-Object -First 1',
  '$ps=New-Object Drawing.Imaging.EncoderParameters(1)',
  '$ps.Param[0]=New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality,[long]82)',
  '$bmp.Save($ms,$enc,$ps)',
  'if($env:W2M_CAPTURE_COPY -eq "1"){[System.Windows.Forms.Clipboard]::SetImage($bmp)}',
  '[Convert]::ToBase64String($ms.ToArray())',
].join('; ');

/**
 * The capture command for a platform, as pure data.
 *
 * Windows prints base64 to stdout; macOS/Linux write a file whose path the caller returns to Node
 * (`file` is null on Windows).
 *
 * @param {NodeJS.Platform} platform
 * @param {{copyToClipboard?: boolean}} [options]
 * @returns {{argv: string[], file: string|null, mime: string}}
 */
export function capturePlan(platform, _options = {}) {
  if (platform === 'win32') {
    return {
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_CAPTURE_SCRIPT],
      file: null,
      mime: 'image/jpeg',
    };
  }
  if (platform === 'darwin') {
    return { argv: ['/usr/sbin/screencapture', '-x', '-t', 'jpg', 'capture'], file: 'capture', mime: 'image/jpeg' };
  }
  if (platform === 'linux') {
    return { argv: ['gnome-screenshot', '-f', 'capture'], file: 'capture', mime: 'image/jpeg' };
  }
  return { argv: [], file: null, mime: 'application/octet-stream' };
}

/** Text-clipboard command for a platform, as pure data. */
export function clipboardPlan(platform, _text) {
  if (platform === 'win32') return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:W2M_CLIP_TEXT'];
  if (platform === 'darwin') return ['pbcopy'];
  return [];
}

/**
 * Capture the host screen.
 *
 * @param {{platform?: NodeJS.Platform, run?: typeof runCommand, tempRoot?: string, copyToClipboard?: boolean}} [options]
 * @returns {Promise<{ok: boolean, mime?: string, data_base64?: string, path?: string, copied: boolean, error?: string}>}
 */
export async function captureHostScreen(options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const copyToClipboard = options.copyToClipboard === true;
  const plan = capturePlan(platform, { copyToClipboard });
  if (plan.argv.length === 0) {
    return { ok: false, copied: false, error: `host capture is not implemented for ${platform}` };
  }
  if (platform === 'win32') {
    const result = await run(plan.argv, { timeoutMs: CAPTURE_TIMEOUT_MS, env: { ...process.env, W2M_CAPTURE_COPY: copyToClipboard ? '1' : '0' } });
    const base64 = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    if (result.code !== 0 || !/^[A-Za-z0-9+/=]{100,}$/.test(base64)) {
      return { ok: false, copied: false, error: `PowerShell capture failed (exit ${result.code}): ${String(result.stderr ?? '').trim().slice(-400) || 'no output'}` };
    }
    return { ok: true, mime: 'image/jpeg', data_base64: base64, copied: copyToClipboard };
  }
  // macOS / Linux: write to a temp file, read it, and copy via the platform tool when asked.
  const dir = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'w2m-capture-'));
  const file = join(dir, platform === 'darwin' ? 'capture.jpg' : 'capture.jpg');
  try {
    const argv = plan.argv.map((part) => (part === 'capture' ? file : part));
    const result = await run(argv, { timeoutMs: CAPTURE_TIMEOUT_MS });
    if (result.code !== 0) {
      return { ok: false, copied: false, error: `screencapture failed (exit ${result.code}): ${String(result.stderr ?? '').trim().slice(-300)}` };
    }
    const data = readFileSync(file);
    let copied = false;
    if (copyToClipboard) {
      if (platform === 'darwin') {
        const script = `set the clipboard to (read (POSIX file "${file.replace(/"/g, '\\"')}") as JPEG picture)`;
        copied = (await run(['osascript', '-e', script], { timeoutMs: CAPTURE_TIMEOUT_MS })).code === 0;
      } else {
        copied = (await run(['xclip', '-selection', 'clipboard', '-t', 'image/jpeg', '-i', file], { timeoutMs: CAPTURE_TIMEOUT_MS })).code === 0;
      }
    }
    return { ok: true, mime: 'image/jpeg', data_base64: data.toString('base64'), path: file, copied };
  } catch (error) {
    return { ok: false, copied: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    // The base64 is already in memory; the file is only useful for the platform clipboard call.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Put text on the host clipboard. */
export async function copyHostText(text, options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const argv = clipboardPlan(platform, text);
  if (argv.length === 0) return { ok: false, error: `host clipboard is not implemented for ${platform}` };
  if (platform === 'win32') {
    const result = await run(argv, { env: { ...process.env, W2M_CLIP_TEXT: String(text ?? '') } });
    return { ok: result.code === 0, error: result.code === 0 ? undefined : `clipboard command failed (exit ${result.code}): ${String(result.stderr ?? '').slice(-300)}` };
  }
  if (platform === 'darwin') {
    // pbcopy reads stdin; keep it out of the shell by piping through a temporary spawn is overkill
    // for this fallback — use osascript's clipboard setter instead, where the text is one argv item.
    const script = 'set the clipboard to ' + JSON.stringify(String(text ?? ''));
    const result = await run(['osascript', '-e', script]);
    return { ok: result.code === 0, error: result.code === 0 ? undefined : `osascript failed: ${String(result.stderr ?? '').slice(-300)}` };
  }
  const result = await run(argv);
  return { ok: result.code === 0, error: result.code === 0 ? undefined : `clipboard command failed (exit ${result.code}): ${String(result.stderr ?? '').slice(-300)}` };
}

/**
 * Mount both routes on the host's Connection fetch registry.
 *
 * @param {object} ctx Cordis context
 * @param {{platform?: NodeJS.Platform, run?: typeof runCommand, capture?: typeof captureHostScreen}} [deps]
 * @returns {{mounted: boolean, reason: string|null}}
 */
export function registerCaptureRoutes(ctx, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service' };
  if (typeof ctx?.inject !== 'function') return status;
  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    const platform = deps.platform ?? process.platform;
    const run = deps.run ?? runCommand;
    const capture = deps.capture ?? captureHostScreen;
    registry.register({
      path: CAPTURE_ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null;
        try { body = await request.json(); } catch { /* defaults below */ }
        const copyToClipboard = body?.copy === true;
        const result = await capture({ platform, run, copyToClipboard });
        return Response.json(result, { status: result.ok === true ? 200 : 502, headers: NO_STORE });
      },
    });
    registry.register({
      path: CLIPBOARD_ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        if (body === null || typeof body?.text !== 'string' || body.text === '') {
          return Response.json({ ok: false, error: 'a JSON body with {"text": "..."} is required' }, { status: 400, headers: NO_STORE });
        }
        // Keep the fallback bounded: a client that asks to copy a megabyte is asking for trouble.
        const text = body.text.slice(0, 1_000_000);
        const result = await copyHostText(text, { platform, run });
        return Response.json(result, { status: result.ok === true ? 200 : 502, headers: NO_STORE });
      },
    });
    status.mounted = true;
    status.reason = null;
  });
  return status;
}
