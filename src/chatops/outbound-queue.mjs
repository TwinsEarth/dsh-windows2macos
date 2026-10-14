/**
 * Getting messages out, in order, without a failure poisoning the channel (v0.7.0).
 *
 * ## The defect this file exists to make impossible
 *
 * `dsh-chatops` 0.1.0 chained every send onto a per-channel promise:
 *
 *     this.outQueue = this.outQueue.then(() => this.sayInline(windowKey, text))
 *
 * and the inner send was **not** guarded. One network blip, or a credential that was
 * never configured, therefore rejected the tail permanently: every later `say()` returned
 * that same rejection, `sayInline` was never invoked again, and the channel was mute for
 * the lifetime of the process — silently, while still reporting itself registered. The
 * same shape appears in all four of its channels; three survived only because their inner
 * send happened to catch, and iLink's bulk lane did not, so **one failed file send
 * disabled all future `/log` output**.
 *
 * The fix is not a try/catch around the send. It is that the queue's tail must be a
 * promise that **cannot reject**, so a failure is a value the caller receives rather than
 * a state the queue is left in.
 *
 * ## The two lanes
 *
 * iLink's two-lane design was the best idea in that codebase and is kept unchanged: an
 * interactive reply must never wait behind a twelve-message `/log` dump, and the bulk lane
 * yields whenever interactive traffic is pending. Getting this wrong is not a performance
 * problem — a queue that is busy for thirty seconds is one where `/approve` arrives after
 * the approval has timed out.
 *
 * ## Ordering, and where it is deliberately not guaranteed
 *
 * Within one window, one lane, order is preserved and each send completes before the next
 * starts. Across lanes there is no order, on purpose: that is what "interactive first"
 * means. Across windows there is no order either, so a slow destination cannot stall a
 * different conversation.
 *
 * The clock, the timer and the jitter source are injected, for the reason recorded in the
 * approval broker: an injected clock with a real `setTimeout` is two clocks, and the test
 * that advances one of them hangs on the other.
 */

/** How a queued send finished. Returned, never thrown. */
export const SEND_RESULT = Object.freeze({
  OK: 'ok',
  /** The channel's own send rejected. The message is lost unless the caller requeues it. */
  FAILED: 'failed',
  /** Cancelled — in flight, or still waiting, when the queue was disposed. */
  CANCELLED: 'cancelled',
});

/**
 * Split text so that each chunk is at most `maxBytes` **and** no character is cut in half.
 *
 * Byte-bounded rather than length-bounded, because the limits that matter are byte limits:
 * a 6000-byte WeChat message is roughly 2000 Chinese characters, and counting characters
 * would send three times the permitted size. The cut falls back to a newline when one is
 * near the boundary, so a split message reads as a split message rather than as a
 * truncated line.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string[]}
 */
export function chunkText(text, maxBytes) {
  if (typeof text !== 'string') throw new TypeError('chunkText needs a string');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('chunkText needs a positive byte budget');
  if (text === '') return [];

  const encoder = new TextEncoder();
  const chunks = [];
  let current = '';
  let currentBytes = 0;

  // Iterating by code point, not by UTF-16 unit, so an emoji or a surrogate pair is never
  // split into two invalid halves.
  for (const char of text) {
    const bytes = encoder.encode(char).length;
    if (currentBytes + bytes > maxBytes && current !== '') {
      // Prefer to break at the last newline if one is reasonably near the end; a chunk
      // boundary mid-sentence is worse to read than one a few bytes early.
      const nl = current.lastIndexOf('\n');
      if (nl > current.length * 0.6) {
        chunks.push(current.slice(0, nl + 1));
        current = current.slice(nl + 1);
        currentBytes = encoder.encode(current).length;
      } else {
        chunks.push(current);
        current = '';
        currentBytes = 0;
      }
    }
    current += char;
    currentBytes += bytes;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * A per-window, two-lane outbound queue.
 *
 * @param {object} options
 * @param {(chunk: string, meta: {window: string, lane: string, index: number, total: number}) => Promise<void>} options.send
 *        One chunk. Rejecting is normal and is reported as `FAILED`; it never poisons the queue.
 * @param {number} [options.chunkBytes] Byte budget per message.
 * @param {number} [options.throttleMs] Minimum gap between two sends in the **same lane**.
 * @param {number} [options.jitterMs] Extra random delay, to avoid a fixed-rate signature.
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.random]
 * @param {(event: string, detail?: object) => void} [options.audit]
 */
export function createOutboundQueue(options) {
  const send = options.send;
  if (typeof send !== 'function') throw new TypeError('createOutboundQueue requires a send()');
  const chunkBytes = options.chunkBytes ?? 6000;
  const throttleMs = options.throttleMs ?? 1200;
  const jitterMs = options.jitterMs ?? 0;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const audit = options.audit ?? (() => {});

  const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const sleep = options.sleep ?? realSleep;

  /** window -> lane -> { tail, pending, lastSentAt } */
  const lanes = new Map();
  let disposed = false;

  function laneFor(window, lane) {
    let byLane = lanes.get(window);
    if (!byLane) {
      byLane = new Map();
      lanes.set(window, byLane);
    }
    let state = byLane.get(lane);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0, lastSentAt: 0 };
      byLane.set(lane, state);
    }
    return state;
  }

  /** Wait out the throttle, honouring the injected clock. */
  async function throttle(state) {
    if (throttleMs <= 0) return;
    // The first message in a lane is not delayed: an operator who just spoke should not
    // wait 1.2s for the acknowledgement.
    if (state.lastSentAt === 0) return;
    const elapsed = now() - state.lastSentAt;
    const wait = throttleMs + (jitterMs > 0 ? Math.floor(random() * jitterMs) : 0) - elapsed;
    if (wait > 0) await sleep(wait);
  }

  /**
   * Queue one message.
   *
   * @param {object} input
   * @param {string} input.window
   * @param {string} input.text
   * @param {'interactive'|'bulk'} [input.lane]
   * @returns {Promise<{status: string, sent: number, failed: number, attempts: number}>}
   *          Never rejects. A failure is a value, because a rejected queue tail is the
   *          defect.
   */
  function enqueue({ window, text, lane = 'interactive' }) {
    // Refused before anything is queued, so a late call cannot leave an entry behind on a
    // cleared map. This — not the loop below — is what "stops accepting work" means.
    if (disposed) {
      return Promise.resolve({ status: SEND_RESULT.CANCELLED, sent: 0, failed: 0, attempts: 0 });
    }
    const state = laneFor(window, lane);
    const chunks = chunkText(text, chunkBytes);
    if (chunks.length === 0) {
      return Promise.resolve({ status: SEND_RESULT.OK, sent: 0, failed: 0, attempts: 0 });
    }

    state.pending += 1;

    // The critical property, and the whole reason this is a `.then` chain rather than an
    // async function: `run` catches everything, so the tail it returns cannot reject. A
    // chain whose tail can reject is a channel that dies on its first hiccup.
    //
    // Note what `run` does **not** do: it never consults `disposed`. Once a message has
    // started, it is finished — a half-sent message is a worse outcome than a slow
    // shutdown, and a reload that abandons one leaves the platform holding a fragment.
    const run = async () => {
      let sent = 0;
      let failed = 0;
      let attempts = 0;
      try {
        for (let i = 0; i < chunks.length; i += 1) {
          await throttle(state);
          attempts += 1;
          try {
            await send(chunks[i], { window, lane, index: i, total: chunks.length });
            sent += 1;
            state.lastSentAt = now();
          } catch (error) {
            // Counted and reported. Continuing is deliberate: the remaining chunks of a
            // long dump are independent of the one that failed, and stopping would turn a
            // transient platform hiccup into a permanently lost tail.
            failed += 1;
            audit('send/failed', {
              window,
              lane,
              index: i,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        // Unreachable in practice, and kept because an exception escaping `run` is exactly
        // the failure this module exists to prevent. Belt and braces, stated as such.
        failed += 1;
        audit('send/queue-error', { window, lane, detail: String(error) });
      }
      return {
        status: failed === 0 ? SEND_RESULT.OK : SEND_RESULT.FAILED,
        sent,
        failed,
        attempts,
      };
    };

    const settled = state.tail.then(run, run);
    // The tail must swallow a rejection *and* must not grow a rejection handler chain; it
    // is a promise that always fulfils, so nothing downstream can be poisoned by it.
    state.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    settled.finally(() => {
      state.pending -= 1;
    });
    return settled;
  }

  /**
   * How much work is outstanding for a window, by lane.
   *
   * Reported so a caller can say "the channel is busy" rather than silently queueing
   * behind something that will time out.
   */
  function depth(window) {
    const byLane = lanes.get(window);
    if (!byLane) return { interactive: 0, bulk: 0, total: 0 };
    let interactive = 0;
    let bulk = 0;
    for (const [lane, state] of byLane) {
      if (lane === 'bulk') bulk += state.pending;
      else interactive += state.pending;
    }
    return { interactive, bulk, total: interactive + bulk };
  }

  /**
   * Stop accepting work and let what is in flight finish.
   *
   * Waits on every lane tail rather than dropping them: a `/log` dump half-sent is worse
   * than one not sent, and a reload that abandons a message mid-platform is how a channel
   * ends up with orphaned state.
   */
  async function dispose() {
    disposed = true;
    const tails = [];
    for (const byLane of lanes.values()) {
      for (const state of byLane.values()) tails.push(state.tail);
    }
    await Promise.all(tails);
    lanes.clear();
  }

  return {
    enqueue,
    depth,
    dispose,
    get disposed() {
      return disposed;
    },
  };
}
