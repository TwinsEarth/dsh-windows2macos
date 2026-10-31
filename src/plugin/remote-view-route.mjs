/**
 * v2.1.x remote-view host routes.
 *
 * local  : /frame captures this host (P1 fallback, no target selected)
 * remote : /start dials the target over P2P and asks its agent for view frames;
 *          /frame serves the newest cached frame; /stop ends the session.
 *
 * Remote frames never traverse the relay. A P2P failure is P2P_UNAVAILABLE,
 * never satisfied by a relay/plaintext media fallback.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureHostScreen } from './capture-route.mjs';
import { createViewSide, openViewFrame } from '../agent/view/session-key.mjs';

export const REMOTE_CONFIG_PATH = '/api/w2m/remote/config';
export const REMOTE_FRAME_PATH = '/api/w2m/remote/frame';
export const REMOTE_START_PATH = '/api/w2m/remote/start';
export const REMOTE_STOP_PATH = '/api/w2m/remote/stop';
const NO_STORE = { 'cache-control': 'no-store' };

function readConfig(file) {
  try { return { ok: true, enabled: JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))?.enabled === true }; }
  catch { return { ok: true, enabled: false }; }
}

function writeConfig(file, enabled) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify({ enabled: enabled === true, updatedAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function payloadJson(payload) {
  try { return Buffer.isBuffer(payload) || typeof payload === 'string' ? JSON.parse(Buffer.from(payload).toString('utf8')) : payload; }
  catch { return null; }
}

/**
 * @param {object} ctx Cordis context
 * @param {{stateDir:string, p2p?:object, capture?:Function, platform?:NodeJS.Platform, maxBytes?:number}} deps
 */
export function registerRemoteViewRoutes(ctx, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service', configPath: null };
  if (typeof ctx?.inject !== 'function') return status;
  if (typeof deps.stateDir !== 'string' || deps.stateDir === '') { status.reason = 'stateDir is not configured'; return status; }
  const file = join(deps.stateDir, 'remote-view.json');
  const capture = deps.capture ?? captureHostScreen;
  const platform = deps.platform ?? process.platform;
  const p2p = deps.p2p ?? null;
  const maxBytes = Number.isInteger(deps.maxBytes) ? deps.maxBytes : 96 * 1024;
  let active = null;
  let listener = null;

  const stopActive = async () => {
    if (active === null) return;
    try { await active.channel?.send?.(JSON.stringify({ type: 'view.stop', session_id: active.sessionId })); } catch { /* peer gone */ }
    try { active.channel?.close?.(); } catch { /* already closed */ }
    if (p2p?.node && typeof p2p.node.off === 'function' && listener !== null) p2p.node.off('message', listener);
    active = null;
    listener = null;
  };

  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') { status.reason = 'the connection service carries no fetch registry'; return; }
    registry.register({
      path: REMOTE_CONFIG_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') return Response.json({ ok: true, ...readConfig(file), session: active === null ? null : { machine_id: active.machineId, encrypted: active.encrypted === true } }, { headers: NO_STORE });
        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        if (body === null || typeof body.enabled !== 'boolean') return Response.json({ ok: false, error: 'a JSON body with {"enabled": true|false} is required' }, { status: 400, headers: NO_STORE });
        if (body.enabled === false) await stopActive();
        writeConfig(file, body.enabled);
        return Response.json({ ok: true, enabled: body.enabled }, { headers: NO_STORE });
      },
    });

    registry.register({
      path: REMOTE_START_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (readConfig(file).enabled !== true) return Response.json({ ok: false, code: 'VIEW_DISABLED' }, { status: 403, headers: NO_STORE });
        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        const machineId = typeof body?.machine_id === 'string' ? body.machine_id : '';
        if (machineId === '') return Response.json({ ok: false, error: 'a JSON body with {"machine_id": "..."} is required' }, { status: 400, headers: NO_STORE });
        if (p2p?.node === null || p2p?.node === undefined) return Response.json({ ok: false, code: 'P2P_UNAVAILABLE', error: 'no P2P node on this host' }, { status: 503, headers: NO_STORE });
        await stopActive();
        try { await p2p.node.start?.(); } catch (error) {
          return Response.json({ ok: false, code: 'P2P_UNAVAILABLE', error: error instanceof Error ? error.message : String(error) }, { status: 503, headers: NO_STORE });
        }
        const dialled = await p2p.node.dial(machineId, {});
        if (dialled?.ok !== true) return Response.json({ ok: false, code: 'P2P_UNAVAILABLE', error: dialled?.error ?? 'P2P_DIAL_FAILED' }, { status: 502, headers: NO_STORE });
        const sessionId = 'view-' + Date.now().toString(36);
        active = { machineId, sessionId, channel: dialled.channel, side: createViewSide(), vk: null, encrypted: dialled.channel?.encryption?.encrypted === true, latest: null, error: null, startedAt: Date.now() };
        listener = (event) => {
          const frame = payloadJson(event?.payload);
          if (frame === null || frame?.session_id !== sessionId) return;
          if (frame.type === 'view.hello_ack') {
            try {
              active.vk = active.side.finish(frame.public_key).key;
              active.encrypted = true;
              void active.channel.send(JSON.stringify({ type: 'view.request', session_id: sessionId, machine_id: machineId, fps: 1, max_bytes: maxBytes }));
            } catch { active.error = 'VIEW_VK_BAD'; }
            return;
          }
          if (frame.type === 'view.frame') {
            if (active.vk === null) { active.error = 'VIEW_VK_REQUIRED'; return; }
            let plaintext;
            try { plaintext = openViewFrame(active.vk, frame.ct); } catch { active.error = 'VIEW_VK_BAD'; return; }
            if (plaintext.length > maxBytes) { active.error = 'VIEW_FRAME_TOO_LARGE'; return; }
            active.latest = { seq: frame.seq ?? null, mime: frame.mime ?? 'image/jpeg', bytes: plaintext.length, data_base64: plaintext.toString('base64'), at: new Date().toISOString(), encrypted: true };
          } else if (frame.type === 'view.error') {
            active.error = frame.code ?? 'VIEW_ERROR';
          }
        };
        p2p.node.on('message', listener);
        await dialled.channel.send(JSON.stringify({ type: 'view.hello', session_id: sessionId, public_key: active.side.public_key }));
        return Response.json({ ok: true, machine_id: machineId, session_id: sessionId, encrypted: active.encrypted, channel: 'p2p' }, { headers: NO_STORE });
      },
    });

    registry.register({
      path: REMOTE_STOP_PATH,
      methods: ['POST'],
      fetch: async () => { await stopActive(); return Response.json({ ok: true }, { headers: NO_STORE }); },
    });

    registry.register({
      path: REMOTE_FRAME_PATH,
      methods: ['POST'],
      fetch: async () => {
        if (readConfig(file).enabled !== true) return Response.json({ ok: false, code: 'VIEW_DISABLED' }, { status: 403, headers: NO_STORE });
        if (active !== null) {
          if (active.latest !== null) return Response.json({ ok: true, ...active.latest }, { headers: NO_STORE });
          if (active.error !== null) return Response.json({ ok: false, code: active.error }, { status: 502, headers: NO_STORE });
          return Response.json({ ok: false, code: 'VIEW_WAITING_FOR_FRAME', machine_id: active.machineId }, { status: 202, headers: NO_STORE });
        }
        const started = Date.now();
        const result = await capture({ platform });
        if (result.ok !== true) return Response.json({ ok: false, code: 'CAPTURE_FAILED', error: result.error ?? null }, { status: 502, headers: NO_STORE });
        return Response.json({ ok: true, mime: result.mime ?? 'image/jpeg', data_base64: result.data_base64, bytes: Math.ceil((result.data_base64?.length ?? 0) * 3 / 4), capture_ms: Date.now() - started, at: new Date().toISOString() }, { headers: NO_STORE });
      },
    });
    status.mounted = true;
    status.reason = null;
    status.configPath = file;
  });
  return status;
}
