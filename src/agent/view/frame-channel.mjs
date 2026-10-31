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

/** @param {{capture:Function, allow?:boolean, send:Function, maxBytes?:number, fps?:number}} deps */
export function createViewTarget({ capture, allow = false, send, maxBytes = 96 * 1024, fps = 1 } = {}) {
  if (typeof capture !== 'function' || typeof send !== 'function') return { ok: false, code: VIEW_CODE.BAD_FRAME };
  let seq = 0;
  let stopped = false;
  let vk = null;
  const reply = (frame) => { try { send(JSON.stringify(frame)); } catch { /* channel gone */ } };
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
      if (frame.type === VIEW_FRAME.STOP) { stopped = true; return true; }
      if (frame.type === VIEW_FRAME.HELLO) {
        if (typeof frame.public_key !== 'string' || frame.public_key === '') { reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.VK_BAD, session_id: frame.session_id ?? null }); return true; }
        try {
          const side = createViewSide();
          vk = side.finish(frame.public_key).key;
          reply({ type: VIEW_FRAME.HELLO_ACK, session_id: frame.session_id ?? null, public_key: side.public_key });
        } catch { reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.VK_BAD, session_id: frame.session_id ?? null }); }
        return true;
      }
      if (frame.type !== VIEW_FRAME.REQUEST) return true;
      if (allow !== true) { reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.CONSENT_REQUIRED, session_id: frame.session_id ?? null }); return true; }
      if (stopped) { reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.DISABLED, session_id: frame.session_id ?? null }); return true; }
      if (vk === null) { reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.VK_REQUIRED, session_id: frame.session_id ?? null }); return true; }
      const result = capture({ maxBytes });
      if (result?.ok !== true) { reply({ type: VIEW_FRAME.ERROR, code: result?.code ?? VIEW_CODE.CAPTURE_FAILED, session_id: frame.session_id ?? null }); return true; }
      let ct;
      try { ct = sealViewFrame(vk, result.data ?? Buffer.from(result.base64 ?? '', 'base64')); }
      catch { reply({ type: VIEW_FRAME.ERROR, code: VIEW_CODE.VK_BAD, session_id: frame.session_id ?? null }); return true; }
      seq += 1;
      reply({ type: VIEW_FRAME.FRAME, session_id: frame.session_id ?? null, seq, ts_ms: Date.now(), mime: result.mime ?? 'image/jpeg', bytes: result.bytes, enc: 'aes-256-gcm', ct });
      return true;
    },
    stats() { return { seq, stopped, allow: allow === true, fps, max_bytes: maxBytes, encrypted: vk !== null }; },
  };
}

/** @param {{send:Function, onFrame:Function, maxBytes?:number}} deps */
export function createViewClient({ send, onFrame, maxBytes = 96 * 1024 } = {}) {
  if (typeof send !== 'function' || typeof onFrame !== 'function') return { ok: false, code: VIEW_CODE.BAD_FRAME };
  let sessionId = null;
  let machineId = null;
  let side = null;
  let vk = null;
  let lastSeq = 0;
  const sendRequest = () => send(JSON.stringify({ type: VIEW_FRAME.REQUEST, session_id: sessionId, machine_id: machineId, fps: 1, max_bytes: maxBytes }));
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
