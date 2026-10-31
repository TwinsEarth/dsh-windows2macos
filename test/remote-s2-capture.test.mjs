import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { summaryBits } from '../bin/remote-s2-capture.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('remote S2 capture probe', () => {
  it('encodes ffmpeg and capture results into the exit-code summary', () => {
    assert.equal(summaryBits({ ffmpeg: { present: true }, captures: [{ ok: true, bytes: 30000, ms: 200 }, { ok: true, ms: 200 }] }), 63);
    assert.equal(summaryBits({ ffmpeg: { present: false }, captures: [{ ok: false, bytes: 0, ms: 900 }, { ok: false, ms: 900 }] }), 0);
    assert.equal(summaryBits({ ffmpeg: { present: true }, captures: [{ ok: true, bytes: 1000, ms: 600 }] }), 3);
  });

  it('names an unsupported platform instead of pretending to capture', () => {
    if (process.platform !== 'linux') return; // darwin/win32 have real capture paths
    const run = spawnSync(process.execPath, [join(here, '..', 'bin', 'remote-s2-capture.mjs'), '--exit-summary'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 100, run.stderr);
  });
});
