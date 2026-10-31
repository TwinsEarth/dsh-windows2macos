/**
 * P1.5 target-side view polling.
 *
 * The target asks the relay for a pending viewer request (1 s cadence); on one,
 * it derives VK from the viewer's ephemeral public key, captures a JPEG, seals
 * it, and posts opaque ciphertext at ≤1 fps. Nothing is written to disk and the
 * relay never sees plaintext.
 */
import { createViewSide, sealViewFrame } from './session-key.mjs';

export const REMOTE_REQUEST_PATH = '/v1/remote/request';
export const REMOTE_FRAME_PATH = '/v1/remote/frame';

/**
 * @param {{rabbitUrl:string, token:()=>string|null, machineId:string, capture:Function,
 *   intervalMs?:number, maxBytes?:number, fetchImpl?:Function, log?:Function, maxFrames?:number}} deps
 */
export function startRelayViewTarget(deps) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const intervalMs = Number.isInteger(deps.intervalMs) ? deps.intervalMs : 1000;
  const maxBytes = Number.isInteger(deps.maxBytes) ? deps.maxBytes : 96 * 1024;
  const maxFrames = Number.isInteger(deps.maxFrames) ? deps.maxFrames : 60;
  const base = String(deps.rabbitUrl ?? '').replace(/\/+$/, '');
  let stopped = false;
  let timer = null;
  let busy = false;

  const stop = () => { stopped = true; if (timer !== null) clearInterval(timer); timer = null; };

  const poll = async () => {
    if (stopped || busy) return;
    const token = deps.token();
    if (typeof token !== 'string' || token === '') return;
    busy = true;
    try {
      const response = await fetchImpl(base + REMOTE_REQUEST_PATH + '?target=' + encodeURIComponent(deps.machineId), {
        headers: { authorization: 'Bearer ' + token },
      });
      if (stopped || !response.ok) { busy = false; return; }
      const body = await response.json().catch(() => null);
      if (body?.ok !== true || typeof body.viewer_public_key !== 'string') { busy = false; return; }
      const side = createViewSide();
      let vk;
      try { vk = side.finish(body.viewer_public_key).key; } catch { busy = false; return; }
      const sessionId = body.session_id;
      let frames = 0;
      const tick = async () => {
        if (stopped || frames >= maxFrames) { busy = false; return; }
        frames += 1;
        const captured = deps.capture({ maxBytes });
        if (captured?.ok !== true) { busy = false; return; }
        let ct;
        try { ct = sealViewFrame(vk, captured.data ?? Buffer.from(captured.base64 ?? '', 'base64')); } catch { busy = false; return; }
        try {
          await fetchImpl(base + REMOTE_FRAME_PATH, {
            method: 'POST',
            headers: { authorization: 'Bearer ' + deps.token(), 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, target: deps.machineId, ct, public_key: side.public_key }),
          });
        } catch { /* relay transient; next tick retries */ }
      };
      await tick();
      timer = setInterval(() => { void tick(); }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    } finally {
      busy = false;
    }
  };

  const pollTimer = setInterval(() => { void poll(); }, intervalMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  void poll();
  return {
    stop() { stopped = true; if (timer !== null) clearInterval(timer); clearInterval(pollTimer); },
    setStop() { stop(); },
  };
}
