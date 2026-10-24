/**
 * v1.7.1 — the host capture/clipboard fallback that makes the chat screenshot button and Ctrl+P work
 * inside the DSH desktop shell, where the renderer's getDisplayMedia/clipboard are unavailable.
 *
 * The route is tested without a screen: `run` is injected, and the platform plans are pure data.
 * The field failure this covers: v1.7.0's browser-only capture produced "截图失败" on the desktop app.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CAPTURE_ROUTE_PATH,
  CLIPBOARD_ROUTE_PATH,
  captureHostScreen,
  capturePlan,
  clipboardPlan,
  registerCaptureRoutes,
} from '../src/plugin/capture-route.mjs';

const JPEG_BASE64 = 'A'.repeat(400);

describe('host capture fallback (v1.7.1)', () => {
  it('captures the Windows screen through PowerShell and returns JPEG base64', () => {
    const calls = [];
    const run = (argv, options) => {
      calls.push({ argv, options });
      return Promise.resolve({ code: 0, stdout: JPEG_BASE64 + '\n', stderr: '' });
    };
    return captureHostScreen({ platform: 'win32', run }).then((result) => {
      assert.equal(result.ok, true);
      assert.equal(result.mime, 'image/jpeg');
      assert.equal(result.data_base64, JPEG_BASE64);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].argv[0], 'powershell.exe');
      assert.ok(calls[0].argv.includes('-STA'), 'the image clipboard needs an STA thread');
    });
  });

  it('reports the PowerShell failure instead of pretending success', async () => {
    const result = await captureHostScreen({ platform: 'win32', run: async () => ({ code: 1, stdout: '', stderr: 'no session' }) });
    assert.equal(result.ok, false);
    assert.match(result.error, /PowerShell capture failed/);
    assert.match(result.error, /no session/);
  });

  it('keeps the platform plans as fixed argv arrays (no shell, no interpolation)', () => {
    assert.equal(capturePlan('win32').argv[0], 'powershell.exe');
    assert.equal(capturePlan('darwin').argv[0], '/usr/sbin/screencapture');
    assert.equal(capturePlan('linux').argv[0], 'gnome-screenshot');
    assert.equal(clipboardPlan('win32', 'hi').at(-1), 'Set-Clipboard -Value $env:W2M_CLIP_TEXT');
    assert.deepEqual(clipboardPlan('darwin', 'hi'), ['pbcopy']);
    assert.deepEqual(clipboardPlan('linux', 'hi'), []);
  });

  it('mounts POST /api/w2m/capture and POST /api/w2m/clipboard', async () => {
    const routes = [];
    const ctx = { inject: (_s, cb) => cb({ connection: { fetch: { register: (route) => routes.push(route) } } }) };
    const mounted = registerCaptureRoutes(ctx, { platform: 'win32', run: async () => ({ code: 0, stdout: JPEG_BASE64 + '\n' }) });
    assert.equal(mounted.mounted, true);
    assert.deepEqual(routes.map((route) => route.path), [CAPTURE_ROUTE_PATH, CLIPBOARD_ROUTE_PATH]);
    assert.deepEqual(routes[0].methods, ['POST']);

    const captured = await routes[0].fetch({ method: 'POST', json: async () => ({ copy: true }) });
    const capturedBody = await captured.json();
    assert.equal(capturedBody.ok, true);
    assert.equal(capturedBody.data_base64, JPEG_BASE64);

    const invalid = await routes[1].fetch({ method: 'POST', json: async () => ({}) });
    assert.equal(invalid.status, 400);
  });
});
