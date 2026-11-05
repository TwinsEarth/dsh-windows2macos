/**
 * P1.5 target-side view polling.
 *
 * The target asks the relay for a pending viewer request (1 s cadence); on one,
 * it derives VK from the viewer's ephemeral public key, captures a JPEG, seals
 * it, and posts opaque ciphertext at ≤1 fps. Nothing is written to disk and the
 * relay never sees plaintext.
 *
 * The poller is deliberately always running: the operator may enable remote
 * viewing after the agent started, and `allow` is consulted before every request
 * and every frame. A disabled machine never consumes a viewer request, so a
 * later enable does not lose the request to an earlier no-op.
 */
import { createViewSide, sealViewFrame } from './session-key.mjs';

export const REMOTE_REQUEST_PATH = '/v1/remote/request';
export const REMOTE_FRAME_PATH = '/v1/remote/frame';

/**
 * @param {{rabbitUrl:string, token:()=>string|null, machineId:string, capture:Function,
 *   allow?:()=>boolean, intervalMs?:number, maxBytes?:number, maxFrames?:number,
 *   fetchImpl?:Function, log?:Function}} deps
 */
export function startRelayViewTarget(deps) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const intervalMs = Number.isInteger(deps.intervalMs) && deps.intervalMs > 0 ? deps.intervalMs : 1000;
  // Stay below the relay broker's 47 KiB ciphertext cap after base64 framing.
  const maxBytes = Number.isInteger(deps.maxBytes) && deps.maxBytes > 0 ? deps.maxBytes : 40 * 1024;
  const maxFrames = Number.isInteger(deps.maxFrames) && deps.maxFrames > 0 ? deps.maxFrames : 60;
  const allow = typeof deps.allow === 'function' ? deps.allow : () => process.env.W2M_VIEW_ALLOW === '1';
  const base = String(deps.rabbitUrl ?? '').replace(/\/+$/, '');
  let stopped = false;
  let pollTimer = null;
  let frameTimer = null;
  let active = null;

  const endStream = () => {
    if (frameTimer !== null) clearTimeout(frameTimer);
    frameTimer = null;
    active = null;
  };
  const scheduleFrame = (waitMs) => {
    if (stopped || active === null) return;
    frameTimer = setTimeout(() => { frameTimer = null; void tick(); }, Math.max(0, waitMs));
    if (typeof frameTimer.unref === 'function') frameTimer.unref();
  };

  const tick = async () => {
    if (stopped || active === null || active.inFlight === true) return;
    if (!allow()) { endStream(); return; }
    if (active.frames >= maxFrames) { endStream(); return; }
    active.inFlight = true;
    const current = active;
    const started = Date.now();
    try {
      const captured = deps.capture({ maxBytes });
      if (captured?.ok !== true) { endStream(); return; }
      let ct;
      try { ct = sealViewFrame(current.vk, captured.data ?? Buffer.from(captured.base64 ?? '', 'base64')); }
      catch { endStream(); return; }
      try {
        const response = await fetchImpl(base + REMOTE_FRAME_PATH, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + deps.token(), 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: current.sessionId, target: deps.machineId, ct, public_key: current.side.public_key }),
        });
        if (response.ok !== true) { endStream(); return; }
        current.frames += 1;
        if (current.frames >= maxFrames) endStream();
        else scheduleFrame(intervalMs - (Date.now() - started));
      } catch {
        // The next poll may establish a fresh session; one transient relay failure
        // ends this stream rather than emitting a burst of stale frames.
        endStream();
      }
    } finally {
      current.inFlight = false;
    }
  };

  const poll = async () => {
    if (stopped || active !== null || !allow()) return;
    const token = deps.token();
    if (typeof token !== 'string' || token === '') return;
    let response;
    try {
      response = await fetchImpl(base + REMOTE_REQUEST_PATH + '?target=' + encodeURIComponent(deps.machineId), {
        headers: { authorization: 'Bearer ' + token },
      });
    } catch { return; }
    if (stopped || !response.ok) return;
    const body = await response.json().catch(() => null);
    if (body?.ok !== true || typeof body.viewer_public_key !== 'string' || typeof body.session_id !== 'string') return;
    const side = createViewSide();
    let vk;
    try { vk = side.finish(body.viewer_public_key).key; } catch { return; }
    active = { sessionId: body.session_id, side, vk, frames: 0, inFlight: false };
    await tick();
  };

  pollTimer = setInterval(() => { void poll(); }, intervalMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  void poll();
  return {
    stop() {
      stopped = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
      endStream();
    },
    stats() {
      return {
        stopped,
        active: active === null ? null : { session_id: active.sessionId, frames: active.frames },
        interval_ms: intervalMs,
        max_bytes: maxBytes,
        max_frames: maxFrames,
      };
    },
  };
}
