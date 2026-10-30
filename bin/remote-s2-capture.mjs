#!/usr/bin/env node
/**
 * S2: macOS screen capture probe for the remote-view P1 decision.
 *
 * Runs WITHOUT `node -e` (the agent refuses code-carrying argv under
 * COMMAND_REPARSE), so it can be dispatched as:
 *   node <plugin>/scripts/remote-s2-capture.mjs --json
 *   node <plugin>/scripts/remote-s2-capture.mjs --exit-summary
 *
 * It measures two captures (spaced 1/fps), probes optional ffmpeg, guesses TCC
 * denial/blank from exit status + JPEG size, writes ~/w2m-s2-result.json, and
 * prints the same JSON. --exit-summary encodes the result into the exit code:
 *   100 + bit0 ffmpeg | bit1 first ok | bit2 first >20KiB | bit3 first <500ms
 *       | bit4 second ok | bit5 second <500ms
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const out = { fps: 1, exitSummary: false, json: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fps') { out.fps = Number(argv[i + 1]) === 2 ? 2 : 1; i += 1; }
    else if (arg === '--exit-summary') out.exitSummary = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--keep') out.keep = true;
  }
  return out;
}

export function summaryBits(result) {
  let bits = 0;
  if (result?.ffmpeg?.present === true) bits |= 1;
  const a = result?.captures?.[0];
  const b = result?.captures?.[1];
  if (a?.ok === true) bits |= 2;
  if ((a?.bytes ?? 0) > 20 * 1024) bits |= 4;
  if (Number.isFinite(a?.ms) && a.ms < 500) bits |= 8;
  if (b?.ok === true) bits |= 16;
  if (Number.isFinite(b?.ms) && b.ms < 500) bits |= 32;
  return bits;
}

function capture(file, dimensions = true) {
  const started = Date.now();
  const run = spawnSync('screencapture', ['-x', '-t', 'jpg', file], { timeout: 15000, encoding: 'utf8' });
  const ms = Date.now() - started;
  let bytes = 0;
  if (existsSync(file)) { try { bytes = statSync(file).size; } catch { bytes = 0; } }
  let width = null; let height = null;
  if (dimensions && bytes > 0) {
    const sips = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 5000, encoding: 'utf8' });
    const w = /pixelWidth:\s*(\d+)/.exec(sips.stdout ?? '');
    const h = /pixelHeight:\s*(\d+)/.exec(sips.stdout ?? '');
    width = w === null ? null : Number(w[1]);
    height = h === null ? null : Number(h[1]);
  }
  return {
    ok: run.status === 0 && bytes > 0,
    status: run.status,
    ms,
    bytes,
    width,
    height,
    error: run.status === 0 ? null : (run.stderr || 'screencapture failed').toString().slice(0, 300),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = {
    ok: false,
    at: new Date().toISOString(),
    platform: process.platform,
    fps: opts.fps,
    ffmpeg: { present: false, version: null },
    captures: [],
    tcc_guess: 'unknown',
    code: null,
  };
  if (process.platform !== 'darwin') {
    result.code = 'S2_UNSUPPORTED_PLATFORM';
    finish(result, opts, 2);
    return;
  }
  const ff = spawnSync('ffmpeg', ['-version'], { timeout: 1500, encoding: 'utf8' });
  result.ffmpeg = { present: ff.status === 0, version: ff.status === 0 ? String(ff.stdout).split('\n')[0].slice(0, 120) : null };

  const dir = join(homedir(), 'w2m-s2');
  const fileA = join(dir, 'frame-1.jpg');
  const fileB = join(dir, 'frame-2.jpg');
  try { spawnSync('mkdir', ['-p', dir], { timeout: 5000 }); } catch { /* best effort */ }
  result.captures.push(capture(fileA));
  spawnSync('sleep', [String(opts.fps === 2 ? 0.5 : 1.0)], { timeout: 5000 });
  result.captures.push(capture(fileB));

  const a = result.captures[0];
  result.tcc_guess = a.status === 0 && a.bytes > 5000 ? 'granted-or-desktop-visible' : 'denied-or-blank';
  result.ok = a.ok === true && result.captures[1].ok === true;
  result.code = result.ok ? 'S2_CAPTURE_OK' : 'S2_CAPTURE_FAILED';
  finish(result, opts, result.ok ? 0 : 3);
}

function finish(result, opts, normalCode) {
  const out = join(homedir(), 'w2m-s2-result.json');
  try { writeFileSync(out, JSON.stringify(result, null, 2)); result.result_file = out; } catch { /* stdout only */ }
  if (opts.json || !opts.exitSummary) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (opts.exitSummary) process.exit(100 + summaryBits(result));
  process.exit(normalCode);
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main();
