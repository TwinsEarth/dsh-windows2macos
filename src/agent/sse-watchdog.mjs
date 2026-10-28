/**
 * SSE watchdog (P0-f): the stream must not hang forever on a half-open connection.
 *
 * Two deadlines are enforced:
 *   · first frame  — nothing parsed within 5 s means the stream is not really attached;
 *   · idle         — 45 s without any byte, which is longer than the relay's 15 s keepalive
 *                    interval by design (three missed keepalives before we give up).
 *
 * `noteBytes` sustains the idle deadline (keepalive comments prove the socket is alive) but it does
 * NOT satisfy the first-frame deadline: a stream that connects and sends keepalives without a
 * parseable `ready` is exactly the buffered/half-dead case this watchdog exists to catch.
 */
export const SSE_FIRST_FRAME_MS = 5000;
export const SSE_IDLE_MS = 45000;
export const SSE_FIRST_FRAME_TIMEOUT = 'SSE_FIRST_FRAME_TIMEOUT';
export const SSE_IDLE_TIMEOUT = 'SSE_IDLE_TIMEOUT';

export function createSseWatchdog(input = {}) {
  const firstFrameMs = Number.isInteger(input.firstFrameMs) && input.firstFrameMs > 0 ? input.firstFrameMs : SSE_FIRST_FRAME_MS;
  const idleMs = Number.isInteger(input.idleMs) && input.idleMs > 0 ? input.idleMs : SSE_IDLE_MS;
  const onTimeout = typeof input.onTimeout === 'function' ? input.onTimeout : () => {};
  let disposed = false;
  let firstTimer = null;
  let idleTimer = null;

  const armIdle = () => {
    if (disposed) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (disposed) return;
      disposed = true;
      clearTimers();
      onTimeout(SSE_IDLE_TIMEOUT);
    }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };
  const clearTimers = () => {
    if (firstTimer !== null) { clearTimeout(firstTimer); firstTimer = null; }
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  };

  firstTimer = setTimeout(() => {
    if (disposed) return;
    disposed = true;
    clearTimers();
    onTimeout(SSE_FIRST_FRAME_TIMEOUT);
  }, firstFrameMs);
  if (typeof firstTimer.unref === 'function') firstTimer.unref();
  armIdle();

  return {
    /** Any byte (headers, keepalive comment, frame) proves the socket is alive: it clears the
     *  first-frame deadline and re-arms the idle deadline. */
    noteBytes() {
      if (disposed) return;
      armIdle();
    },
    /** A parsed frame clears the first-frame deadline. */
    noteFrame() {
      if (disposed) return;
      if (firstTimer !== null) { clearTimeout(firstTimer); firstTimer = null; }
      armIdle();
    },
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimers();
    },
  };
}
