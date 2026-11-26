/**
 * `waitForDevTools` (test/helpers/dsh-page-boot.mjs): the poll that waits for the browser's
 * `DevToolsActivePort` file.
 *
 * The poll used to check that the file existed and then read it, with nothing in between. On a real Windows
 * machine (HSD, fleet matrix r2) that read failed with `EBUSY` -- the browser still held the file -- inside the
 * `before` hook of every Loader probe, and the hook took thirteen assertions down with it each time.
 *
 * The violation itself is staged for real where it exists (Windows: a handle that shares nothing, which is
 * what the browser holds while it writes). Node opens every file with full sharing, so the same failure cannot
 * be produced from inside this process; for the remaining cases the read is injected and each failure is
 * produced by hand, on every platform.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForDevTools } from './helpers/dsh-page-boot.mjs';

const COMPLETE = '9333\n/devtools/browser/0123456789abcdef\n';
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** The two ways the read fails on disk, with the codes Node reports for them. */
const busy = () => Object.assign(new Error("EBUSY: resource busy or locked, open 'DevToolsActivePort'"), { code: 'EBUSY' });
const missing = () => Object.assign(new Error("ENOENT: no such file or directory, open 'DevToolsActivePort'"), { code: 'ENOENT' });

/**
 * A reader that answers with `replies[i]` on call `i` and keeps repeating the last one.
 * An `Error` in the list is thrown.
 */
function scriptedRead(...replies) {
  const state = { calls: 0 };
  const readFile = () => {
    const reply = replies[Math.min(state.calls, replies.length - 1)];
    state.calls += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { readFile, state };
}

describe('waitForDevTools', () => {
  it('returns the port and the browser path as soon as the file is complete', async () => {
    const { readFile, state } = scriptedRead(COMPLETE);
    const endpoint = await waitForDevTools('scratch', 5_000, readFile);
    assert.deepEqual(endpoint, { port: 9333, browserPath: '/devtools/browser/0123456789abcdef' });
    assert.equal(state.calls, 1, 'one read is enough once the file is complete');
  });

  it('reads the file from disk when no reader is injected', async (t) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-devtools-port-'));
    t.after(() => {
      rm(userDataDir);
    });
    fs.writeFileSync(path.join(userDataDir, 'DevToolsActivePort'), COMPLETE, 'utf8');
    const endpoint = await waitForDevTools(userDataDir, 5_000);
    assert.deepEqual(endpoint, { port: 9333, browserPath: '/devtools/browser/0123456789abcdef' });
  });

  it('keeps polling through a sharing violation and a file that is not there', async () => {
    const { readFile, state } = scriptedRead(busy(), busy(), missing(), COMPLETE);
    const endpoint = await waitForDevTools('scratch', 5_000, readFile);
    assert.equal(endpoint.port, 9333);
    assert.equal(state.calls, 4, 'one read per poll, and nothing read after the answer');
  });

  for (const [name, text] of [
    ['nothing at all', ''],
    ['no first line', '\n/devtools/browser/0123456789abcdef\n'],
    ['a word where the port goes', 'soon\n/devtools/browser/0123456789abcdef\n'],
    ['port zero', '0\n/devtools/browser/0123456789abcdef\n'],
  ]) {
    it(`treats a half-written file as not ready: ${name}`, async () => {
      const { readFile, state } = scriptedRead(text, COMPLETE);
      const endpoint = await waitForDevTools('scratch', 5_000, readFile);
      assert.equal(endpoint.port, 9333, 'a port that was never written is never returned');
      assert.equal(state.calls, 2);
    });
  }

  it('uses the default browser path when the file holds a port and nothing else', async () => {
    const endpoint = await waitForDevTools('scratch', 5_000, () => '9333');
    assert.deepEqual(endpoint, { port: 9333, browserPath: '/devtools/browser' });
  });

  it('gives up with the named error when nothing usable ever appears', async () => {
    const { readFile } = scriptedRead(busy());
    await assert.rejects(waitForDevTools('scratch', 500, readFile), /the browser wrote no DevToolsActivePort within 500ms/u);
  });
});

describe('a real sharing violation', { skip: process.platform === 'win32' ? false : 'only Windows lets a process hold a file that shares nothing' }, () => {
  it('is waited out: the poll resolves once the browser lets go of the file', async (t) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-devtools-port-'));
    const file = path.join(userDataDir, 'DevToolsActivePort');
    fs.writeFileSync(file, COMPLETE, 'utf8');
    // Windows PowerShell ships with every Windows, and .NET can ask for a handle that shares nothing.
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$handle = [System.IO.File]::Open('${file.replace(/'/gu, "''")}', 'Open', 'ReadWrite', 'None'); `
      + 'Start-Sleep -Milliseconds 3000; $handle.Dispose()'], { stdio: 'ignore' });
    t.after(async () => {
      if (holder.exitCode === null) {
        holder.kill();
        await Promise.race([new Promise((resolve) => {
          holder.once('exit', resolve);
        }), sleep(5_000)]);
      }
      rm(userDataDir);
    });

    let locked = false;
    for (const until = Date.now() + 15_000; Date.now() < until && !locked;) {
      if (holder.exitCode !== null) break;
      try {
        fs.closeSync(fs.openSync(file, 'r+'));
        await sleep(50);
      } catch (error) {
        locked = error.code === 'EBUSY';
      }
    }
    assert.ok(locked, `could not stage a sharing violation on this machine (holder exit ${String(holder.exitCode)})`);
    const lockedAt = Date.now();

    const endpoint = await waitForDevTools(userDataDir, 20_000);

    assert.equal(endpoint.port, 9333, 'the port, once the file can be read again');
    assert.equal(endpoint.browserPath, '/devtools/browser/0123456789abcdef');
    assert.ok(Date.now() - lockedAt >= 1_500, 'the poll must have waited for the holder to let go');
  });
});

function rm(directory) {
  // The holder is gone by now; a handle the operating system is still releasing is not a reason to fail a test.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
