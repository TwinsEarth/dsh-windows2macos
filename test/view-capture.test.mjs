import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { captureScreen, VIEW_CAPTURE_CODE } from '../src/agent/view/capture.mjs';

describe('target screen capture', () => {
  it('names an unsupported platform instead of pretending to capture', () => {
    const result = captureScreen({ platform: 'linux', run: () => ({ code: 0, stdout: '' }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, VIEW_CAPTURE_CODE.UNSUPPORTED);
  });

  it('captures a JPEG on darwin with an injected runner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w2m-view-cap-'));
    const data = Buffer.alloc(4096, 7).toString('base64');
    const fakeRun = (argv) => {
      if (argv.includes('-t')) {
        const file = argv[argv.length - 1];
        writeFileSync(file, Buffer.from(data, 'base64'));
        return { code: 0, stdout: '' };
      }
      if (argv[0] === 'sips') return { code: 0, stdout: 'pixelWidth: 1280\npixelHeight: 720\n' };
      return { code: 0, stdout: '' };
    };
    const result = captureScreen({ platform: 'darwin', run: fakeRun, tempRoot: dir, maxBytes: 96 * 1024 });
    assert.equal(result.ok, true, result.code);
    assert.equal(result.mime, 'image/jpeg');
    assert.equal(result.bytes, 4096);
    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
  });

  it('refuses a frame over the transport budget', () => {
    const fakeRun = () => ({ code: 0, stdout: Buffer.alloc(4096).toString('base64') });
    const result = captureScreen({ platform: 'win32', run: fakeRun, maxBytes: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.code, VIEW_CAPTURE_CODE.TOO_LARGE);
  });
});
