/**
 * P2P/P1.5 view frame channel (view-only).
 *
 * Handshake:
 *   viewer → view.hello      { session_id, public_key }
 *   target → view.hello_ack  { session_id, public_key }
 *   both derive VK (X25519 + HKDF), then:
 *   viewer → view.request    { fps, max_bytes }
 *   target → view.frame      { ct (AES-256-GCM), bytes, seq }
 *
 * A frame without a prior hello is refused; the target defaults to DENY and
 * never accepts input frames.
 */
import { createViewSide, openViewFrame, sealViewFrame } from './session-key.mjs';
import { tierPreset, VIEW_ENVELOPE_BYTES } from './quality.mjs';

export const VIEW_FRAME = Object.freeze({
  HELLO: 'view.hello',
  HELLO_ACK: 'view.hello_ack',
  REQUEST: 'view.request',
  FRAME: 'view.frame',
  STOP: 'view.stop',
  ERROR: 'view.error',
});

export const VIEW_CODE = Object.freeze({
  CONSENT_REQUIRED: 'VIEW_CONSENT_REQUIRED',
  VK_REQUIRED: 'VIEW_VK_REQUIRED',
  VK_BAD: 'VIEW_VK_BAD',
  FRAME_TOO_LARGE: 'VIEW_FRAME_TOO_LARGE',
  BAD_FRAME: 'VIEW_BAD_FRAME',
  CAPTURE_FAILED: 'VIEW_CAPTURE_FAILED',
  INPUT_FORBIDDEN: 'VIEW_INPUT_FORBIDDEN',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInputFrame = (type) => /^(mouse|key|pointer|input)\./.test(type);

function parseAny(payload) {
  try {
    if (Buffer.isBuffer(payload) || typeof payload === 'string') return JSON.parse(Buffer.from(payload).toString('utf8'));
    return payload;
  } catch { return null; }
}

export function parseViewFrame(payload) {
  const frame = parseAny(payload);
  if (!isObject(frame) || typeof frame.type !== 'string' || !frame.type.startsWith('view.')) return null;
  return frame;
}

/** @param {{capture:Function, allow?:boolean|Function, send:Function, maxBytes?:number, fps?:number, intervalMs?:number, maxFrames?:number, tier?: string}} deps */
export function createViewTarget({ capture, allow = false, send, maxBytes = 96 * 1024, fps = 1, intervalMs, maxFrames = 300, tier = 'p2p' } = {}) {
  if (typeof capture !== 'function' || typeof send !== 'function') return { ok: false, code: VIEW_CODE.BAD_FRAME };
  let seq = 0;
  let frames = 0;
  let stopped = false;
  let vk = null;
  let timer = null;
  let sessionId = null;
  // The viewer names the tier on every request, because the transport it got is the viewer's fact,
  // not the target's: the same target may be looked at over WebRTC (720P..4K) or the relay (360P..540P).
  let activeTier = tier;
  let activeMaxBytes = maxBytes;
  const delay = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : Math.max(100, Math.round(1000 / Math.max(1, fps)));
  const allowed = () => (typeof allow === 'function' ? allow() === true : allow === true);
  const reply = (frame) => { try { send(JSON.stringify(frame)); } catch { /* channel gone */ } };
  const stopTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const schedule = (waitMs) => {
    if (stopped || vk === null) return;
    timer = setTimeout(() => { timer = null; tick(); }, Math.max(0, waitMs));
    if (typeof timer.unref === 'function') timer.unref();
  };
  const fail = (code) => {
    stopped = true;
    stopTimer();
    reply({ type: VIEW_FRAME.ERROR, code, session_id: sessionId });
  };
  const tick = () => {
    if (stopped || vk === null || sessionId === null) { stopTimer(); return; }
    if (!allowed()) { fail(VIEW_CODE.CONSENT_REQUIRED); return; }
    if (maxFrames > 0 && frames >= maxFrames) { stopTimer(); return; }
    const started = Date.now();
    const result = capture({ maxBytes: activeMaxBytes, tier: activeTier });
    if (result?.ok !== true) { fail(result?.code ?? VIEW_CODE.CAPTURE_FAILED); return; }
    let ct;
    try { ct = sealViewFrame(vk, result.data ?? Buffer.from(result.base64 ?? '', 'base64')); }
    catch { fail(VIEW_CODE.VK_BAD); return; }
    seq += 1;
    frames += 1;
    reply({ type: VIEW_FRAME.FRAME, session_id: sessionId, seq, ts_ms: Date.now(), mime: result.mime ?? 'image/jpeg', bytes: result.bytes, enc: 'aes-256-gcm', ct });
    if (maxFrames <= 0 || frames < maxFrames) schedule(delay - (Date.now() - started));
  };
  return {
    ok: true,
    handle(payload) {
      const raw = parseAny(payload);
      if (isObject(raw) && typeof raw.type === 'string' && isInputFrame(raw.type)) {
        reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.INPUT_FORBIDDEN, session_id: raw.session_id ?? null });
        return true;
      }
      const frame = parseViewFrame(payload);
      if (frame === null) return false;
      if (frame.type === VIEW_FRAME.STOP) { stopped = true; stopTimer(); return true; }
      if (frame.type === VIEW_FRAME.HELLO) {
        stopTimer();
        stopped = false;
        frames = 0;
        sessionId = typeof frame.session_id === 'string' ? frame.session_id : null;
        if (typeof frame.public_key !== 'string' || frame.public_key === '') { reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.VK_BAD, session_id: sessionId }); return true; }
        try {
          const side = createViewSide();
          vk = side.finish(frame.public_key).key;
          reply({ type: VIEW_FRAME.HELLO_ACK, session_id: sessionId, public_key: side.public_key });
        } catch { reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.VK_BAD, session_id: sessionId }); }
        return true;
      }
      if (frame.type !== VIEW_FRAME.REQUEST) return true;
      if (!allowed()) { fail(VIEW_CODE.CONSENT_REQUIRED); return true; }
      if (stopped) { fail(VIEW_CODE.DISABLED); return true; }
      if (vk === null) { fail(VIEW_CODE.VK_REQUIRED); return true; }
      if (typeof frame.session_id === 'string' && frame.session_id !== '') sessionId = frame.session_id;
      // `tier` is advisory in the sense that an unknown value falls back to `relay` (the tighter
      // ladder); `max_bytes` can only tighten the tier's own cap, never widen it past what the
      // transport was allowed to carry.
      const preset = tierPreset(frame.tier ?? activeTier);
      activeTier = preset.channel;
      const ceiling = preset.channel === 'relay' ? preset.maxBytes - VIEW_ENVELOPE_BYTES : preset.maxBytes;
      activeMaxBytes = Number.isInteger(frame.max_bytes) && frame.max_bytes > 0
        ? Math.min(frame.max_bytes, ceiling)
        : ceiling;
      // A renewal is a fresh viewer request; its budget starts over so an actively polling viewer
      // keeps the stream alive, while a viewer that disappears leaves the target to expire its budget.
      frames = 0;
      stopTimer();
      tick();
      return true;
    },
    stop() { stopped = true; stopTimer(); vk = null; sessionId = null; },
    stats() { return { seq, frames, stopped, allow: allowed(), fps, intervalMs: delay, max_bytes: activeMaxBytes, tier: activeTier, encrypted: vk !== null }; },
  };
}

/** @param {{send:Function, onFrame:Function, maxBytes?:number, tier?:string}} deps */
export function createViewClient({ send, onFrame, maxBytes = 2 * 1024 * 1024, tier = 'p2p' } = {}) {
  if (typeof send !== 'function' || typeof onFrame !== 'function') return { ok: false, code: VIEW_CODE.BAD_FRAME };
  let sessionId = null;
  let machineId = null;
  let side = null;
  let vk = null;
  let lastSeq = 0;
  const sendRequest = () => send(JSON.stringify({ type: VIEW_FRAME.REQUEST, session_id: sessionId, machine_id: machineId, fps: 1, max_bytes: maxBytes, tier }));
  return {
    ok: true,
    request({ machineId: machine = null, session } = {}) {
      machineId = machine;
      sessionId = session ?? ('view-' + Date.now());
      side = createViewSide();
      send(JSON.stringify({ type: VIEW_FRAME.HELLO, session_id: sessionId, public_key: side.public_key }));
      return sessionId;
    },
    accept(payload) {
      const frame = parseViewFrame(payload);
      if (frame === null) return false;
      if (frame.type === VIEW_FRAME.ERROR) { onFrame({ ok: false, code: frame.code ?? VIEW_CODE.CAPTURE_FAILED }); return true; }
      if (frame.type === VIEW_FRAME.HELLO_ACK) {
        try { vk = side.finish(frame.public_key).key; sendRequest(); }
        catch { onFrame({ ok: false, code: VIEW_CODE.VK_BAD }); }
        return true;
      }
      if (frame.type !== VIEW_FRAME.FRAME) return true;
      if (sessionId !== null && frame.session_id !== sessionId) return true;
      if (!Number.isInteger(frame.seq) || frame.seq <= lastSeq) return true;
      if (vk === null || typeof frame.ct !== 'string' || frame.ct === '') { onFrame({ ok: false, code: VIEW_CODE.VK_REQUIRED }); return true; }
      let plaintext;
      try { plaintext = openViewFrame(vk, frame.ct); } catch { onFrame({ ok: false, code: VIEW_CODE.VK_BAD }); return true; }
      if (plaintext.length > maxBytes) { onFrame({ ok: false, code: VIEW_CODE.FRAME_TOO_LARGE }); return true; }
      lastSeq = frame.seq;
      onFrame({ ok: true, seq: frame.seq, ts_ms: frame.ts_ms, mime: frame.mime ?? 'image/jpeg', bytes: plaintext.length, data_base64: plaintext.toString('base64'), encrypted: true });
      return true;
    },
    stop() { if (sessionId !== null) send(JSON.stringify({ type: VIEW_FRAME.STOP, session_id: sessionId })); },
    stats() { return { sessionId, lastSeq, encrypted: vk !== null }; },
  };
}
