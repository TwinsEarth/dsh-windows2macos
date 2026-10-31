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

  const postRelayRequest = async ({ stateDir, machineId, sessionId, publicKey }) => {
    try {
      const device = JSON.parse(readFileSync(join(stateDir, 'device.json'), 'utf8').replace(/^\uFEFF/, ''));
      const base = String(device.rabbit_url ?? device.rabbitUrl ?? '').replace(/\/+$/, '');
      const token = device.device_token ?? device.deviceToken ?? null;
      if (base === '' || typeof token !== 'string' || token === '') return { ok: false, error: 'device.json has no relay url/token' };
      const response = await fetch(base + '/v1/remote/request', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, target: machineId, viewer_public_key: publicKey }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) return { ok: false, error: body?.error?.code ?? ('HTTP ' + response.status) };
      return { ok: true, ttl_ms: body.ttl_ms ?? null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const fetchRelayFrame = async ({ stateDir, sessionId, machineId }) => {
    try {
      const device = JSON.parse(readFileSync(join(stateDir, 'device.json'), 'utf8').replace(/^\uFEFF/, ''));
      const base = String(device.rabbit_url ?? device.rabbitUrl ?? '').replace(/\/+$/, '');
      const token = device.device_token ?? device.deviceToken ?? null;
      if (base === '' || typeof token !== 'string') return { ok: false };
      const url = base + '/v1/remote/frame?session_id=' + encodeURIComponent(sessionId) + '&target=' + encodeURIComponent(machineId);
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
      if (!response.ok) return { ok: false, waiting: response.status === 404 };
      const body = await response.json().catch(() => null);
      if (body?.ok !== true || typeof body.ct !== 'string') return { ok: false };
      return { ok: true, ct: body.ct, public_key: body.public_key ?? null };
    } catch { return { ok: false }; }
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
        await stopActive();
        const side = createViewSide();
        const sessionId = 'view-' + Date.now().toString(36);
        let dialled = null;
        let p2pError = null;
        if (p2p?.node === null || p2p?.node === undefined) p2pError = 'no P2P node on this host';
        else {
          try { await p2p.node.start?.(); dialled = await p2p.node.dial(machineId, {}); } catch (error) { p2pError = error instanceof Error ? error.message : String(error); }
          if (dialled?.ok !== true) p2pError = dialled?.error ?? 'P2P_DIAL_FAILED';
        }
        if (dialled?.ok === true) {
          active = { mode: 'p2p', machineId, sessionId, channel: dialled.channel, side, vk: null, encrypted: dialled.channel?.encryption?.encrypted === true, latest: null, error: null, startedAt: Date.now() };
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
        }
        // P1.5: P2P failed, so ask the relay to carry an opaque frame later.
        const relayRequest = await postRelayRequest({ stateDir: deps.stateDir, machineId, sessionId, publicKey: side.public_key });
        if (relayRequest.ok !== true) {
          return Response.json({ ok: false, code: 'P2P_UNAVAILABLE', error: p2pError, relay_error: relayRequest.error ?? null }, { status: 502, headers: NO_STORE });
        }
        active = { mode: 'relay', machineId, sessionId, channel: null, side, vk: null, encrypted: true, latest: null, error: null, startedAt: Date.now() };
        return Response.json({ ok: true, machine_id: machineId, session_id: sessionId, encrypted: true, channel: 'relay', relay_ttl_ms: relayRequest.ttl_ms ?? null }, { headers: NO_STORE });
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
          if (active.mode === 'relay' && active.latest === null) {
            const got = await fetchRelayFrame({ stateDir: deps.stateDir, sessionId: active.sessionId, machineId: active.machineId });
            if (got.ok === true) {
              try {
                if (active.vk === null) {
                  if (typeof got.public_key !== 'string') { active.error = 'VIEW_VK_REQUIRED'; return Response.json({ ok: false, code: active.error }, { status: 502, headers: NO_STORE }); }
                  active.vk = active.side.finish(got.public_key).key;
                }
                const plaintext = openViewFrame(active.vk, got.ct);
                if (plaintext.length <= maxBytes) active.latest = { seq: null, mime: 'image/jpeg', bytes: plaintext.length, data_base64: plaintext.toString('base64'), at: new Date().toISOString(), encrypted: true, channel: 'relay' };
              } catch { active.error = 'VIEW_VK_BAD'; }
            }
          }
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
