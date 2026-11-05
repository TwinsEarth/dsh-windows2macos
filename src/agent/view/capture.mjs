/**
 * Target-side screen capture for remote-view P1.
 *
 * One JPEG per call, bounded by a timeout, injectable `run` so tests never
 * launch PowerShell or screencapture. Errors are named, never "capture failed"
 * without a reason.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const VIEW_CAPTURE_CODE = Object.freeze({
  OK: 'CAPTURE_OK',
  UNSUPPORTED: 'CAPTURE_UNSUPPORTED_PLATFORM',
  DENIED: 'CAPTURE_DENIED',
  BLANK: 'CAPTURE_BLANK',
  FAILED: 'CAPTURE_FAILED',
  TOO_LARGE: 'CAPTURE_TOO_LARGE',
});

export const DEFAULT_MAX_FRAME_BYTES = 96 * 1024;

const defaultRun = (argv, options = {}) => spawnSync(argv[0], argv.slice(1), {
  timeout: options.timeoutMs ?? 15000,
  encoding: options.encoding ?? 'utf8',
  env: options.env ?? process.env,
});

function windowsCaptureScript(maxBytes) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$src=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
    '$g=[System.Drawing.Graphics]::FromImage($src)',
    '$g.CopyFromScreen($b.Left,$b.Top,0,0,$src.Size)',
    '$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
    '$max=' + String(maxBytes),
    '$best=$null',
    'foreach($w in @(1280,1024,800,640)){',
    '  $h=[int]($b.Height*$w/$b.Width)',
    '  $dst=New-Object System.Drawing.Bitmap $w,$h',
    '  $dg=[System.Drawing.Graphics]::FromImage($dst)',
    '  $dg.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '  $dg.DrawImage($src,0,0,$w,$h)',
    '  foreach($q in @(70,55,40)){',
    '    $p=New-Object System.Drawing.Imaging.EncoderParameters(1)',
    '    $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]$q)',
    '    $ms=New-Object System.IO.MemoryStream',
    '    $dst.Save($ms,$codec,$p)',
    '    $bytes=$ms.ToArray()',
    '    if($best -eq $null -or $bytes.Length -lt $best.Length){$best=$bytes}',
    '    if($bytes.Length -le $max){[Convert]::ToBase64String($bytes); exit 0}',
    '  }',
    '}',
    '[Convert]::ToBase64String($best)',
  ].join(';');
}


/**
 * A tiny compiled Windows helper for 1 fps capture.
 *
 * Starting PowerShell costs 1.5-3 s per frame on this host, so a 1 fps stream
 * written as "spawn PowerShell every second" is not 1 fps. The helper is compiled
 * once with the in-box .NET Framework compiler and then invoked like any small
 * executable; the fallback keeps working on machines without that compiler.
 */
const WINDOWS_HELPER_SOURCE = `using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;
class W2MCapture {
  static void Main(string[] args) {
    int max = int.Parse(args[1]);
    var b = Screen.PrimaryScreen.Bounds;
    using (var src = new Bitmap(b.Width, b.Height)) {
      using (var g = Graphics.FromImage(src)) g.CopyFromScreen(b.Left, b.Top, 0, 0, src.Size);
      int[] widths = new int[] { 960, 800, 640 };
      var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
      foreach (int w in widths) {
        int h = Math.Max(1, (int)Math.Round(b.Height * (double)w / b.Width));
        using (var dst = new Bitmap(w, h)) {
          using (var dg = Graphics.FromImage(dst)) {
            dg.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            dg.DrawImage(src, 0, 0, w, h);
          }
          foreach (int q in new int[] { 40, 30 }) {
            using (var ms = new MemoryStream()) {
              var ep = new EncoderParameters(1);
              ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)q);
              dst.Save(ms, codec, ep);
              var bytes = ms.ToArray();
              if (bytes.Length <= max) {
                File.WriteAllBytes(args[0], bytes);
                return;
              }
            }
          }
        }
      }
    }
  }
}`;

let windowsHelperState;

/** Resolve, compiling once, the fast Windows capture helper. */
function windowsFastHelper() {
  if (windowsHelperState !== undefined) return windowsHelperState;
  try {
    const dir = join(tmpdir(), 'w2m-view-fast');
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, 'w2m-capture-v1.exe');
    if (existsSync(exe)) { windowsHelperState = exe; return exe; }
    const source = join(dir, 'w2m-capture-v1.cs');
    writeFileSync(source, WINDOWS_HELPER_SOURCE, 'utf8');
    const cscCandidates = [
      join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ];
    const csc = cscCandidates.find(candidate => existsSync(candidate));
    if (csc !== undefined) {
      spawnSync(csc, [
        '/nologo', '/target:exe', `/out:${exe}`,
        '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', source,
      ], { timeout: 60_000, windowsHide: true, encoding: 'utf8' });
    }
    if (!existsSync(exe)) {
      // Some hosts deny csc.exe while allowing PowerShell. Add-Type compiles the same source
      // once and writes the executable, after which every frame is a small process spawn.
      const psQuote = value => `'${value.replace(/'/g, "''")}'`;
      const command = `Add-Type -Path ${psQuote(source)} -OutputAssembly ${psQuote(exe)} -OutputType ConsoleApplication -ReferencedAssemblies System.Drawing.dll,System.Windows.Forms.dll`;
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        timeout: 60_000, windowsHide: true, encoding: 'utf8',
      });
    }
    windowsHelperState = existsSync(exe) ? exe : null;
    return windowsHelperState;
  } catch {
    windowsHelperState = null;
    return null;
  }
}

/**
 * @param {{platform?: NodeJS.Platform, run?: Function, tempRoot?: string, maxBytes?: number, fast?: boolean}} [options]
 * @returns {{ok: true, code: string, mime: string, data: Buffer, base64: string, bytes: number, capture_ms: number, width: number|null, height: number|null}
 *   | {ok: false, code: string, error: string, capture_ms: number}}
 */
export function captureScreen(options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_FRAME_BYTES;
  const started = Date.now();
  try {
    let base64 = null;
    let width = null;
    let height = null;
    if (platform === 'win32') {
      if (options.fast === true) {
        const helper = windowsFastHelper();
        if (helper !== null) {
          const dir = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'w2m-view-fast-'));
          const file = join(dir, 'frame.jpg');
          try {
            const result = run([helper, file, String(maxBytes)], { timeoutMs: 5000, encoding: 'utf8' });
            if (result.status === 0 && existsSync(file)) {
              const data = readFileSync(file);
              if (data.length >= 1000) base64 = data.toString('base64');
            }
          } catch {
            // Fall through to the PowerShell capture path.
          } finally {
            try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        }
      }
      if (base64 === null) {
        const result = run(['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', windowsCaptureScript(maxBytes)], { timeoutMs: 20000 });
        // `spawnSync` reports the exit code as `status`; `code` is the execFile-shaped field
        // and is undefined here, which made every successful capture look like a denial.
        if (result.status !== 0) return { ok: false, code: VIEW_CAPTURE_CODE.DENIED, error: `PowerShell capture failed (exit ${result.status ?? 'null'}${result.signal ? ', signal ' + result.signal : ''}${result.error?.message ? ', ' + result.error.message : ''})`, capture_ms: Date.now() - started };
        base64 = String(result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
        if (!/^[A-Za-z0-9+/=]{100,}$/.test(base64)) return { ok: false, code: VIEW_CAPTURE_CODE.FAILED, error: 'PowerShell returned no JPEG', capture_ms: Date.now() - started };
      }
    } else if (platform === 'darwin') {
      const dir = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'w2m-view-'));
      const file = join(dir, 'frame.jpg');
      try {
        const result = run(['/usr/sbin/screencapture', '-x', '-t', 'jpg', file], { timeoutMs: 15000 });
        // Same `spawnSync` contract: `status`, never `code`. S2 used the right field, which is
        // why the probe succeeded while the relay view target reported CAPTURE_DENIED.
        if (result.status !== 0) return { ok: false, code: VIEW_CAPTURE_CODE.DENIED, error: `screencapture failed (exit ${result.status})`, capture_ms: Date.now() - started };
        const data = readFileSync(file);
        base64 = data.toString('base64');
        const sips = run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeoutMs: 5000 });
        const w = /pixelWidth:\s*(\d+)/.exec(sips?.stdout ?? '');
        const h = /pixelHeight:\s*(\d+)/.exec(sips?.stdout ?? '');
        width = w === null ? null : Number(w[1]);
        height = h === null ? null : Number(h[1]);
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    } else {
      return { ok: false, code: VIEW_CAPTURE_CODE.UNSUPPORTED, error: `screen capture is not implemented for ${platform}`, capture_ms: Date.now() - started };
    }
    const data = Buffer.from(base64, 'base64');
    if (data.length < 1000) return { ok: false, code: VIEW_CAPTURE_CODE.BLANK, error: 'captured JPEG is too small to be a screen', capture_ms: Date.now() - started };
    if (data.length > maxBytes) return { ok: false, code: VIEW_CAPTURE_CODE.TOO_LARGE, error: `frame ${data.length} > ${maxBytes}`, capture_ms: Date.now() - started };
    return { ok: true, code: VIEW_CAPTURE_CODE.OK, mime: 'image/jpeg', data, base64, bytes: data.length, capture_ms: Date.now() - started, width, height };
  } catch (error) {
    return { ok: false, code: VIEW_CAPTURE_CODE.FAILED, error: error instanceof Error ? error.message : String(error), capture_ms: Date.now() - started };
  }
}

/** Test/util helper: file size without reading the whole image. */
export function frameBytes(file) {
  try { return statSync(file).size; } catch { return 0; }
}
