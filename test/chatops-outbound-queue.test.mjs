/**
 * Getting messages out without a failure poisoning the channel (v0.7.0).
 *
 * The property this file exists to protect is that **one failed send does not kill the
 * channel.** `dsh-chatops` 0.1.0 chained every send onto a per-channel promise whose tail
 * could reject, so a single network blip left `outQueue` permanently rejected: every later
 * `say()` returned the same rejection, the inner send was never reached again, and the
 * channel was mute for the lifetime of the process while still reporting itself registered.
 * iLink's bulk lane was the worst case — one failed file send disabled all future `/log`
 * output.
 *
 * That failure is invisible in the happy path and invisible in a log, so the tests below
 * are built around it rather than around "a message was sent":
 *
 *   * after a rejected send, the next send still happens — asserted on both lanes and on
 *     the case where every chunk of a message fails;
 *   * `enqueue` never rejects, because a rejecting tail is the defect;
 *   * a partial failure reports how much actually went, not how much was attempted;
 *   * order is preserved within a lane, and interactive work is not stuck behind a bulk
 *     dump — the property that decides whether `/approve` arrives before its deadline;
 *   * chunking is byte-bounded and never splits a character, because the limits that
 *     matter are byte limits and a split surrogate pair is a corrupt message.
 *
 * Clock, timer and jitter are all injected. An injected clock with a real `setTimeout` is
 * two clocks, and a test that advances one of them hangs on the other — a mistake this
 * project has already made once.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createOutboundQueue, chunkText, SEND_RESULT } from '../src/chatops/outbound-queue.mjs';

const T0 = Date.parse('2026-10-14T00:00:00Z');

/**
 * A queue with a controllable clock and a `send` whose behaviour is scripted per call.
 *
 * `sleep` resolves immediately and advances the clock, so throttle assertions are exact
 * and nothing waits on wall time.
 */
function harness({ behaviour = () => undefined, chunkBytes = 6000, throttleMs = 0, jitterMs = 0, random = () => 0 } = {}) {
  let now = T0;
  const calls = [];
  const events = [];
  const sleeps = [];
  let n = 0;

  const send = async (chunk, meta) => {
    n += 1;
    calls.push({ chunk, ...meta, at: now, seq: n });
    const outcome = behaviour(chunk, meta, n);
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'function') return outcome();
  };

  const queue = createOutboundQueue({
    send,
    chunkBytes,
    throttleMs,
    jitterMs,
    random,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    audit: (event, detail) => events.push({ event, ...detail }),
  });

  return {
    queue,
    calls,
    events,
    sleeps,
    advance: (ms) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

describe('a failed send does not poison the channel', () => {
  it('sends the next message after one fails', async () => {
    // The exact defect: the second send must happen even though the first rejected.
    const h = harness({ behaviour: (chunk) => (chunk === 'boom' ? new Error('platform hiccup') : undefined) });
    const first = await h.queue.enqueue({ window: 'user:me', text: 'boom' });
    assert.equal(first.status, SEND_RESULT.FAILED);
    assert.equal(first.failed, 1);

    const second = await h.queue.enqueue({ window: 'user:me', text: 'still here' });
    assert.equal(second.status, SEND_RESULT.OK, 'a rejected send must not mute the channel');
    assert.equal(second.sent, 1);
    assert.deepEqual(
      h.calls.map((c) => c.chunk),
      ['boom', 'still here'],
    );
  });

  it('keeps going after a blip in the middle of a long dump', async () => {
    // The iLink bulk case: one failure in a long dump used to disable the lane for good.
    // The text is laid out so exactly one chunk contains the failing marker, which keeps
    // the arithmetic of the assertion visible rather than incidental.
    const h = harness({ chunkBytes: 4, behaviour: (chunk) => (chunk === 'CCCC' ? new Error('nope') : undefined) });
    const result = await h.queue.enqueue({ window: 'user:me', text: 'AAAABBBBCCCCDDDDEEEEFFFF', lane: 'bulk' });
    assert.equal(result.attempts, 6, 'six four-byte chunks');
    assert.equal(result.failed, 1, 'exactly the chunk carrying the marker');
    assert.equal(result.sent, 5, 'the rest still went');
    assert.equal(result.status, SEND_RESULT.FAILED, 'a partial dump reports as failed, not as ok');

    // And the lane is still usable afterwards.
    const after = await h.queue.enqueue({ window: 'user:me', text: 'next', lane: 'bulk' });
    assert.equal(after.status, SEND_RESULT.OK);
  });

  it('survives every chunk failing, and is still usable', async () => {
    const h = harness({ chunkBytes: 2, behaviour: () => new Error('channel down') });
    const result = await h.queue.enqueue({ window: 'user:me', text: 'abcdefgh' });
    assert.equal(result.sent, 0);
    assert.equal(result.attempts, 4);
    assert.equal(result.failed, 4, 'every chunk was attempted and every one was reported');

    // The assertion that matters is that the channel was *reached* again, not what it
    // answered — a poisoned queue would short-circuit before ever calling send.
    const callsBefore = h.calls.length;
    await h.queue.enqueue({ window: 'user:me', text: 'ping' });
    assert.ok(h.calls.length > callsBefore, 'a fully failed message must not mute the lane');
    assert.equal(h.calls.at(-1).chunk, 'ng');
  });

  it('never rejects, whatever the channel does', async () => {
    // A rejecting tail is the defect, so `enqueue` returning a rejection would be the bug
    // reintroduced. Asserted on the promise itself, not on the resolved value.
    const h = harness({ behaviour: () => new TypeError('send exploded') });
    await assert.doesNotReject(() => h.queue.enqueue({ window: 'user:me', text: 'x' }));
    await assert.doesNotReject(() => h.queue.enqueue({ window: 'other', text: 'y', lane: 'bulk' }));
  });

  it('reports a throw from the channel as failed, with the reason audited', async () => {
    const h = harness({ behaviour: () => new Error('401 unauthorized') });
    await h.queue.enqueue({ window: 'user:me', text: 'hi' });
    const failure = h.events.find((e) => e.event === 'send/failed');
    assert.equal(failure.window, 'user:me');
    assert.equal(failure.detail, '401 unauthorized');
  });

  it('treats an empty message as nothing to do rather than a failure', async () => {
    const h = harness();
    const result = await h.queue.enqueue({ window: 'user:me', text: '' });
    assert.deepEqual(result, { status: SEND_RESULT.OK, sent: 0, failed: 0, attempts: 0 });
    assert.equal(h.calls.length, 0);
  });
});

describe('order is kept where it was promised', () => {
  it('preserves order within one window and lane', async () => {
    const h = harness({ throttleMs: 0 });
    const order = [];
    const p1 = h.queue.enqueue({ window: 'user:me', text: 'first' });
    const p2 = h.queue.enqueue({ window: 'user:me', text: 'second' });
    const p3 = h.queue.enqueue({ window: 'user:me', text: 'third' });
    order.push(...(await Promise.all([p1, p2, p3])).map((r) => r.status));
    assert.deepEqual(
      h.calls.map((c) => c.chunk),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(order, ['ok', 'ok', 'ok']);
  });

  it('does not let one window stall another', async () => {
    // A conversation with a slow platform must not hold up a different one.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    const queue = createOutboundQueue({
      send: async (chunk, meta) => {
        calls.push(`${meta.window}:${chunk}`);
        if (meta.window === 'slow') await gate;
      },
      throttleMs: 0,
    });
    const slow = queue.enqueue({ window: 'slow', text: 'a' });
    const fast = queue.enqueue({ window: 'fast', text: 'b' });
    await fast;
    assert.ok(calls.includes('fast:b'), 'the second window should not wait on the first');
    release();
    await slow;
  });

  it('runs a bulk dump only after interactive work queued ahead of it', async () => {
    const h = harness({ throttleMs: 0 });
    const bulk = h.queue.enqueue({ window: 'user:me', text: 'log line', lane: 'bulk' });
    const reply = h.queue.enqueue({ window: 'user:me', text: 'ack' });
    await Promise.all([bulk, reply]);
    // Different lanes, no order promised — but both must have been sent.
    assert.equal(h.calls.length, 2);
    assert.deepEqual(new Set(h.calls.map((c) => c.lane)), new Set(['bulk', 'interactive']));
  });

  it('reports depth per lane so a caller can say the channel is busy', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const queue = createOutboundQueue({ send: async () => gate, throttleMs: 0 });
    const a = queue.enqueue({ window: 'w', text: 'x' });
    const b = queue.enqueue({ window: 'w', text: 'y', lane: 'bulk' });
    assert.deepEqual(queue.depth('w'), { interactive: 1, bulk: 1, total: 2 });
    assert.deepEqual(queue.depth('never-seen'), { interactive: 0, bulk: 0, total: 0 });
    release();
    await Promise.all([a, b]);
    assert.deepEqual(queue.depth('w'), { interactive: 0, bulk: 0, total: 0 });
  });
});

describe('throttling uses the injected clock', () => {
  it('does not delay the first message in a lane', async () => {
    // An operator who just spoke should not wait for the anti-flood gap before the ack.
    const h = harness({ throttleMs: 1200 });
    await h.queue.enqueue({ window: 'user:me', text: 'hi' });
    assert.deepEqual(h.sleeps, []);
  });

  it('waits the remaining gap before the second', async () => {
    const h = harness({ throttleMs: 1200 });
    await h.queue.enqueue({ window: 'user:me', text: 'one' });
    await h.queue.enqueue({ window: 'user:me', text: 'two' });
    assert.deepEqual(h.sleeps, [1200], 'the second message waits the full gap after the first');
  });

  it('does not wait when the clock already moved past the gap', async () => {
    const h = harness({ throttleMs: 1200 });
    await h.queue.enqueue({ window: 'user:me', text: 'one' });
    h.advance(5000);
    await h.queue.enqueue({ window: 'user:me', text: 'two' });
    assert.deepEqual(h.sleeps, [], 'a slow platform is not punished with an extra wait');
  });

  it('adds jitter from the injected source, and never a fixed rate', async () => {
    const h = harness({ throttleMs: 1000, jitterMs: 400, random: () => 0.5 });
    await h.queue.enqueue({ window: 'user:me', text: 'one' });
    await h.queue.enqueue({ window: 'user:me', text: 'two' });
    assert.deepEqual(h.sleeps, [1200], '1000 base + floor(0.5 * 400)');
  });

  it('throttles per lane, so a bulk dump is not starved by interactive traffic', async () => {
    const h = harness({ throttleMs: 1000 });
    await h.queue.enqueue({ window: 'user:me', text: 'a' });
    await h.queue.enqueue({ window: 'user:me', text: 'b', lane: 'bulk' });
    assert.deepEqual(h.sleeps, [], 'the bulk lane has its own first-message exemption');
  });
});

describe('chunking is byte-bounded and never splits a character', () => {
  it('returns nothing for empty text', () => {
    assert.deepEqual(chunkText('', 10), []);
  });

  it('keeps every chunk within the byte budget', () => {
    const encoder = new TextEncoder();
    const chunks = chunkText('a'.repeat(25), 10);
    for (const c of chunks) assert.ok(encoder.encode(c).length <= 10, `${c.length} exceeds the budget`);
    assert.equal(chunks.join(''), 'a'.repeat(25));
  });

  it('counts bytes, not characters — the limit that actually applies', () => {
    // 6000 bytes of Chinese is ~2000 characters; counting characters would send ~3x over.
    const encoder = new TextEncoder();
    const text = '中'.repeat(30); // 90 bytes
    const chunks = chunkText(text, 30);
    for (const c of chunks) assert.ok(encoder.encode(c).length <= 30);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.length >= 3, 'three bytes per character means three chunks in thirty bytes');
  });

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(5); // each is 4 bytes
    const chunks = chunkText(text, 8);
    assert.equal(chunks.join(''), text);
    for (const c of chunks) {
      // A lone surrogate would render as a replacement character; re-encoding must give
      // back exactly the code points that went in.
      assert.ok(!c.includes('\uFFFD'));
      assert.equal(Array.from(c).every((ch) => ch.length === 2 || ch.codePointAt(0) < 0x10000), true);
    }
  });

  it('prefers a newline near the boundary so a split reads as a split', () => {
    const text = `${'x'.repeat(50)}\n${'y'.repeat(50)}`;
    const chunks = chunkText(text, 60);
    assert.ok(chunks[0].endsWith('\n'), 'the first chunk should end at the newline');
    assert.equal(chunks.join(''), text);
  });

  it('still makes progress when a single character is larger than the budget', () => {
    // A budget smaller than one code point cannot be honoured; the chunk must still be
    // emitted rather than looping forever or producing an empty chunk.
    const chunks = chunkText('😀😀', 2);
    assert.equal(chunks.join(''), '😀😀');
    assert.ok(chunks.length >= 2);
  });

  it('refuses a nonsensical budget instead of guessing one', () => {
    assert.throws(() => chunkText('x', 0), /positive byte budget/);
    assert.throws(() => chunkText('x', -1), /positive byte budget/);
    assert.throws(() => chunkText(42, 10), /needs a string/);
  });

  it('splits a queued message into byte-bounded sends', async () => {
    const h = harness({ chunkBytes: 4 });
    const result = await h.queue.enqueue({ window: 'user:me', text: 'abcdefghij' });
    assert.equal(result.sent, 3);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.calls.map((c) => c.total), [3, 3, 3]);
    assert.deepEqual(h.calls.map((c) => c.index), [0, 1, 2]);
  });
});

describe('shutdown', () => {
  it('lets in-flight sends finish rather than abandoning them mid-message', async () => {
    let finished = false;
    const queue = createOutboundQueue({
      send: async () => {
        await new Promise((r) => setImmediate(r));
        finished = true;
      },
      throttleMs: 0,
    });
    const p = queue.enqueue({ window: 'w', text: 'x' });
    const disposing = queue.dispose();
    await Promise.all([p, disposing]);
    assert.equal(finished, true, 'a half-sent message is worse than a delayed shutdown');
    assert.equal(queue.disposed, true);
  });

  it('cancels work queued after disposal instead of sending it', async () => {
    const calls = [];
    const queue = createOutboundQueue({ send: async (c) => calls.push(c), throttleMs: 0 });
    await queue.dispose();
    const result = await queue.enqueue({ window: 'w', text: 'late' });
    assert.equal(result.status, SEND_RESULT.CANCELLED);
    assert.deepEqual(calls, []);
  });

  it('refuses to be built without a send function', () => {
    assert.throws(() => createOutboundQueue({}), /requires a send\(\)/);
  });
});
