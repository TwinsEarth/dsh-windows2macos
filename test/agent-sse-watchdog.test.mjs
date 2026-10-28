/**
 * P0-f: SSE watchdog and cursor rules.
 *
 * Two independent deadlines: the first-frame deadline only clears on a parsed frame (a keepalive
 * proves the socket lives but not that the relay is attached), and the idle deadline clears on any
 * byte. The cursor never advances on `ready`/`notice`, whose sequence numbers never entered the
 * replay ring.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SSE_FIRST_FRAME_TIMEOUT,
  SSE_IDLE_TIMEOUT,
  createSseWatchdog,
} from '../src/agent/sse-watchdog.mjs';
import { NON_REPLAYABLE_EVENTS, shouldAdvanceCursor } from '../src/agent/sse-cursor.mjs';

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('SSE watchdog', () => {
  it('fires a first-frame timeout when the stream stays silent', async () => {
    let fired = null;
    const watchdog = createSseWatchdog({ firstFrameMs: 30, idleMs: 10_000, onTimeout: (code) => { fired = code; } });
    await wait(80);
    watchdog.dispose();
    assert.equal(fired, SSE_FIRST_FRAME_TIMEOUT);
  });

  it('does not let keepalive bytes satisfy the first-frame deadline', async () => {
    let fired = null;
    const watchdog = createSseWatchdog({ firstFrameMs: 40, idleMs: 10_000, onTimeout: (code) => { fired = code; } });
    // A keepalive comment arrives before the first-frame deadline: it sustains idle, not first-frame.
    await wait(10);
    watchdog.noteBytes();
    await wait(80);
    watchdog.dispose();
    assert.equal(fired, SSE_FIRST_FRAME_TIMEOUT, 'only a parsed frame may clear the first-frame deadline');
  });

  it('clears the first-frame deadline on a parsed frame and then fires idle after silence', async () => {
    let fired = null;
    const watchdog = createSseWatchdog({ firstFrameMs: 30, idleMs: 40, onTimeout: (code) => { fired = code; } });
    await wait(10);
    watchdog.noteFrame();
    await wait(20);
    assert.equal(fired, null, 'a parsed frame cleared the first-frame deadline');
    await wait(80);
    watchdog.dispose();
    assert.equal(fired, SSE_IDLE_TIMEOUT);
  });

  it('does not fire after dispose', async () => {
    let fired = null;
    const watchdog = createSseWatchdog({ firstFrameMs: 30, idleMs: 30, onTimeout: (code) => { fired = code; } });
    watchdog.dispose();
    await wait(80);
    assert.equal(fired, null);
  });
});

describe('SSE cursor rule', () => {
  it('never advances on ready/notice but does on replayable content events', () => {
    assert.deepEqual([...NON_REPLAYABLE_EVENTS], ['ready', 'notice']);
    assert.equal(shouldAdvanceCursor({ type: 'ready' }), false);
    assert.equal(shouldAdvanceCursor({ type: 'notice' }), false);
    for (const type of ['task.offer', 'task.cancel', 'task.result', 'result.ack', 'peer.hello', 'peer.bye']) {
      assert.equal(shouldAdvanceCursor({ type }), true, type);
    }
    assert.equal(shouldAdvanceCursor({}), false);
  });
});
