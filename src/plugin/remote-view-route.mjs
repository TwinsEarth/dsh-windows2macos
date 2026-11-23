/**
 * v2.1.x remote-view host routes.
 *
 * local  : /frame captures this host (P1 fallback, no target selected)
 * remote : /start dials the target and asks its agent for view frames.
 *
 * v3.6.0 makes the shared `webrtc-v1` pool the production default:
 *
 *   1. the viewer posts a warm-up request over the authenticated relay control
 *      plane (`transport: 'webrtc'`, `viewer_machine_id`);
 *   2. the target starts its half of the pair and answers through
 *      `/v1/remote/ack`;
 *   3. the viewer starts its half, sends `view.hello` over the Noise-sealed
 *      DataChannel, and every frame stays on that channel;
 *   4. only `transport: 'auto'` may fall back to the old encrypted-relay blind
 *      forwarding when warm-up or the pair fails. `transport: 'webrtc'` returns
 *      a named 502 and never silently switches paths.
 *
 * The desktop row never owns the pool: it borrows the process-wide pool built
 * by `tools/shared.mjs` and only unsubscribes on stop. `closePeer()` is
 * deliberately not called here, because Teams and task delivery share that
 * transport.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureHostScreen } from './capture-route.mjs';
import { getSharedWebRtcPool } from './webrtc-pool-registry.mjs';
import { createViewSide, openViewFrame } from '../agent/view/session-key.mjs';
import { resolveStateDir } from '../util/cli.mjs';

export const REMOTE_CONFIG_PATH = '/api/w2m/remote/config';
export const REMOTE_FRAME_PATH = '/api/w2m/remote/frame';
export const REMOTE_START_PATH = '/api/w2m/remote/start';
export const REMOTE_STOP_PATH = '/api/w2m/remote/stop';
const NO_STORE = { 'cache-control': 'no-store' };
const RELAY_ACK_PATH = '/v1/remote/ack';

function normalizeTransport(value) {
  if (value === 'webrtc' || value === 'relay' || value === 'auto') return value;
  return 'auto';
}

function readConfig(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { ok: true, enabled: parsed?.enabled === true, transport: normalizeTransport(parsed?.transport) };
  } catch {
    return { ok: true, enabled: false, transport: 'auto' };
  }
}

function writeConfig(file, enabled, transport) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(
    tmp,
    JSON.stringify({ enabled: enabled === true, transport: normalizeTransport(transport), updatedAt: new Date().toISOString() }),
    { encoding: 'utf8', mode: 0o600 },
  );
  renameSync(tmp, file);
}

function payloadJson(payload) {
  try {
    return Buffer.isBuffer(payload) || typeof payload === 'string'
      ? JSON.parse(Buffer.from(payload).toString('utf8'))
      : payload;
  } catch {
    return null;
  }
}

function readDevice(stateDir) {
  try {
    const device = JSON.parse(readFileSync(join(stateDir, 'device.json'), 'utf8').replace(/^\uFEFF/, ''));
    return {
      ok: true,
      machineId: typeof device.machine_id === 'string' ? device.machine_id : '',
      base: String(device.rabbit_url ?? device.rabbitUrl ?? '').replace(/\/+$/, ''),
      token: typeof (device.device_token ?? device.deviceToken) === 'string'
        ? (device.device_token ?? device.deviceToken)
        : '',
    };
  } catch {
    return { ok: false, machineId: '', base: '', token: '' };
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const timeoutSignal = (ms) => (
  typeof AbortSignal === 'object' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined
);

/**
 * @param {object} ctx Cordis context
 * @param {{stateDir:string, p2p?:object, getPool?:()=>object|null, pool?:object|null, capture?:Function,
 *   platform?:string, maxBytes?:number, prepareTimeoutMs?:number, handshakeTimeoutMs?:number,
 *   ackPollMs?:number}} deps
 */
export function registerRemoteViewRoutes(ctx, deps = {}) {
  const status = { mounted: false, reason: 'the host has no Connection service', configPath: null };
  if (typeof ctx?.inject !== 'function') return status;
  const stateDir = typeof deps.stateDir === 'string' && deps.stateDir !== ''
    ? deps.stateDir
    : resolveStateDir(null, '');
  const file = join(stateDir, 'remote-view.json');
  const capture = deps.capture ?? captureHostScreen;
  const platform = deps.platform ?? process.platform;
  const p2p = deps.p2p ?? null;
  const getPool = typeof deps.getPool === 'function'
    ? deps.getPool
    : (typeof deps.pool === 'object' && deps.pool !== null ? () => deps.pool : getSharedWebRtcPool);
  const maxBytes = Number.isInteger(deps.maxBytes) ? deps.maxBytes : 96 * 1024;
  const prepareTimeoutMs = Number.isInteger(deps.prepareTimeoutMs) && deps.prepareTimeoutMs > 0
    ? deps.prepareTimeoutMs
    : 8_000;
  const handshakeTimeoutMs = Number.isInteger(deps.handshakeTimeoutMs) && deps.handshakeTimeoutMs > 0
    ? deps.handshakeTimeoutMs
    : 10_000;
  const ackPollMs = Number.isInteger(deps.ackPollMs) && deps.ackPollMs > 0 ? deps.ackPollMs : 300;
  let active = null;

  const stopActive = async () => {
    if (active === null) return;
    const session = active;
    active = null;
    try {
      await session.send?.({ type: 'view.stop', session_id: session.sessionId });
    } catch {
      /* peer gone */
    }
    try {
      session.unsubscribe?.();
    } catch {
      /* already unsubscribed */
    }
    if (session.mode === 'p2p') {
      try { session.channel?.close?.(); } catch { /* already closed */ }
    }
  };

  const postRelayRequest = async ({ machineId, sessionId, publicKey, transport = 'relay', viewerMachineId = null }) => {
    const device = readDevice(stateDir);
    if (device.base === '' || device.token === '') return { ok: false, error: 'device.json has no relay url/token' };
    try {
      const body = {
        session_id: sessionId,
        target: machineId,
        viewer_public_key: publicKey,
        transport: transport === 'webrtc' ? 'webrtc' : 'relay',
      };
      if (typeof viewerMachineId === 'string' && viewerMachineId !== '') body.viewer_machine_id = viewerMachineId;
      const response = await fetch(device.base + '/v1/remote/request', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + device.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutSignal(5_000),
      });
      const answer = await response.json().catch(() => null);
      if (!response.ok || answer?.ok !== true) {
        return { ok: false, error: answer?.error?.code ?? ('HTTP ' + response.status) };
      }
      return { ok: true, ttl_ms: answer.ttl_ms ?? null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * Read the target's one-bit warm-up answer. A 404 with
   * `REMOTE_ACK_NOT_FOUND` means "not yet"; any other 404 means the relay has no
   * ack route (an older build), which is a named fallback rather than a timeout.
   */
  const fetchRelayAck = async ({ machineId, sessionId }) => {
    const device = readDevice(stateDir);
    if (device.base === '' || device.token === '') return { ok: false, code: 'WEBRTC_ACK_UNAVAILABLE' };
    try {
      const url = device.base + RELAY_ACK_PATH
        + '?session_id=' + encodeURIComponent(sessionId)
        + '&target=' + encodeURIComponent(machineId);
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + device.token }, signal: timeoutSignal(3_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.ok === true) return { ok: true, body };
      if (response.status === 404 && body?.error?.code === 'REMOTE_ACK_NOT_FOUND') {
        return { ok: false, pending: true, code: 'REMOTE_ACK_NOT_FOUND' };
      }
      return {
        ok: false,
        code: response.status === 404 ? 'WEBRTC_ACK_UNAVAILABLE' : (body?.error?.code ?? 'WEBRTC_ACK_FAILED'),
      };
    } catch (error) {
      return { ok: false, code: 'WEBRTC_ACK_UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) };
    }
  };

  const waitForAck = async ({ machineId, sessionId, deadline }) => {
    let last = null;
    while (Date.now() < deadline) {
      last = await fetchRelayAck({ machineId, sessionId });
      if (last.ok === true) {
        if (last.body?.prepared === true) return { ok: true, body: last.body };
        return {
          ok: false,
          code: last.body?.reason ?? 'WEBRTC_PREPARE_FAILED',
          body: last.body,
        };
      }
      if (last.pending !== true) return last;
      await sleep(ackPollMs);
    }
    return { ok: false, code: 'WEBRTC_PREPARE_TIMEOUT', detail: `no ack within ${prepareTimeoutMs} ms` };
  };

  const fetchRelayFrame = async ({ sessionId, machineId }) => {
    const device = readDevice(stateDir);
    if (device.base === '' || device.token === '') return { ok: false };
    try {
      const url = device.base + '/v1/remote/frame?session_id=' + encodeURIComponent(sessionId) + '&target=' + encodeURIComponent(machineId);
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + device.token }, signal: timeoutSignal(3_000) });
      if (!response.ok) return { ok: false, waiting: response.status === 404 };
      const body = await response.json().catch(() => null);
      if (body?.ok !== true || typeof body.ct !== 'string') return { ok: false };
      return { ok: true, ct: body.ct, public_key: body.public_key ?? null };
    } catch {
      return { ok: false };
    }
  };

  const makeWebrtcSend = (pool, machineId) => async (frame) => {
    const sent = await pool.send(machineId, JSON.stringify(frame));
    if (sent?.ok !== true) {
      const error = new Error(sent?.detail ?? sent?.code ?? 'WEBRTC_SEND_FAILED');
      error.code = sent?.code ?? 'WEBRTC_SEND_FAILED';
      throw error;
    }
    return sent;
  };

  const connectWebrtc = async ({ pool, machineId, sessionId, side }) => {
    if (pool === null || typeof pool !== 'object' || typeof pool.ensure !== 'function' || typeof pool.send !== 'function') {
      return { ok: false, code: 'WEBRTC_POOL_UNAVAILABLE', detail: 'this host has no shared WebRTC pool' };
    }
    if (typeof pool.onMessage !== 'function') {
      return { ok: false, code: 'WEBRTC_POOL_INVALID', detail: 'the shared pool has no onMessage()' };
    }
    const device = readDevice(stateDir);
    const viewerMachineId = device.machineId !== ''
      ? device.machineId
      : (typeof pool.machineId === 'string' ? pool.machineId : '');
    if (viewerMachineId === '') {
      return { ok: false, code: 'WEBRTC_VIEWER_ID_UNAVAILABLE', detail: 'device.json has no machine_id' };
    }
    const asked = await postRelayRequest({
      machineId,
      sessionId,
      publicKey: side.public_key,
      transport: 'webrtc',
      viewerMachineId,
    });
    if (asked.ok !== true) {
      return { ok: false, code: 'WEBRTC_ACK_UNAVAILABLE', detail: asked.error };
    }

    // The target's `prepare()` and this `ensure()` must be in flight together: each side of the pair
    // waits for the other to join the signaling room before the DataChannel can open. Waiting for the
    // ack first would deadlock -- the target would hold its ack until a peer that this side has not
    // started yet. Start the viewer half now, then wait for the target's one-bit answer.
    const readyPromise = Promise.resolve()
      .then(() => pool.ensure(machineId))
      .catch((error) => ({
        ok: false,
        code: 'WEBRTC_POOL_START_FAILED',
        detail: error instanceof Error ? error.message : String(error),
      }));

    // If this side cannot even start (missing peer key, bad config), do not spend the whole ack
    // timeout waiting for a target that has nothing to answer. A successful ensure stays pending here
    // and the race is decided by the ack.
    const readyFailure = readyPromise.then((result) => {
      if (result?.ok === true) return new Promise(() => {});
      const error = new Error(result?.detail ?? 'viewer pool did not start');
      error.viewResult = result;
      throw error;
    });

    let ack;
    try {
      ack = await Promise.race([
        waitForAck({
          machineId,
          sessionId,
          deadline: Date.now() + prepareTimeoutMs,
        }),
        readyFailure,
      ]);
    } catch (error) {
      return {
        ok: false,
        code: error?.viewResult?.code ?? 'WEBRTC_POOL_START_FAILED',
        detail: error?.viewResult?.detail ?? (error instanceof Error ? error.message : String(error)),
      };
    }
    if (ack.ok !== true) return { ok: false, code: ack.code, detail: ack.detail ?? null, ack: ack.body ?? null };

    const ready = await readyPromise;
    if (ready.ok !== true) {
      return { ok: false, code: ready.code ?? 'WEBRTC_POOL_START_FAILED', detail: ready.detail ?? null, ack: ack.body };
    }

    const send = makeWebrtcSend(pool, machineId);
    const session = {
      mode: 'webrtc',
      machineId,
      sessionId,
      side,
      pool,
      send,
      unsubscribe: null,
      latest: null,
      error: null,
      vk: null,
      encrypted: true,
      renewAt: Date.now() + 10_000,
      handshakeDeadline: Date.now() + handshakeTimeoutMs,
      startedAt: Date.now(),
    };
    session.listener = (event) => {
      if (typeof event?.peer === 'string' && event.peer !== machineId) return;
      const frame = payloadJson(event?.payload);
      if (frame === null || frame?.session_id !== sessionId) return;
      if (frame.type === 'view.hello_ack') {
        try {
          session.vk = session.side.finish(frame.public_key).key;
          session.encrypted = true;
          void send({ type: 'view.request', session_id: sessionId, machine_id: machineId, fps: 1, max_bytes: maxBytes })
            .catch((error) => { session.error = error?.code ?? 'VIEW_WEBRTC_SEND_FAILED'; });
        } catch {
          session.error = 'VIEW_VK_BAD';
        }
        return;
      }
      if (frame.type === 'view.frame') {
        if (session.vk === null) { session.error = 'VIEW_VK_REQUIRED'; return; }
        try {
          const plaintext = openViewFrame(session.vk, frame.ct);
          if (plaintext.length > maxBytes) { session.error = 'VIEW_FRAME_TOO_LARGE'; return; }
          session.latest = {
            seq: frame.seq ?? null,
            mime: frame.mime ?? 'image/jpeg',
            bytes: plaintext.length,
            data_base64: plaintext.toString('base64'),
            at: new Date().toISOString(),
            encrypted: true,
            channel: 'webrtc',
          };
          session.error = null;
        } catch {
          session.error = 'VIEW_VK_BAD';
        }
        return;
      }
      if (frame.type === 'view.error') session.error = frame.code ?? 'VIEW_ERROR';
    };
    session.unsubscribe = pool.onMessage(session.listener);

    try {
      await send({ type: 'view.hello', session_id: sessionId, public_key: side.public_key });
    } catch (error) {
      session.unsubscribe();
      return {
        ok: false,
        code: error?.code ?? 'VIEW_WEBRTC_SEND_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        ack: ack.body,
      };
    }
    return { ok: true, session, channel: 'webrtc', preferred: 'webrtc', fallback_reason: null, ack: ack.body };
  };

  const connectP2P = async ({ machineId, sessionId, side }) => {
    if (p2p?.node === null || p2p?.node === undefined) {
      return { ok: false, code: 'P2P_UNAVAILABLE', detail: 'no P2P node on this host' };
    }
    let dialled = null;
    let dialError = null;
    try {
      await p2p.node.start?.();
      dialled = await p2p.node.dial(machineId, {});
    } catch (error) {
      dialError = error instanceof Error ? error.message : String(error);
    }
    if (dialled?.ok !== true) {
      return { ok: false, code: 'P2P_UNAVAILABLE', detail: dialled?.error ?? dialError ?? 'P2P_DIAL_FAILED' };
    }
    const channel = dialled.channel;
    const session = {
      mode: 'p2p',
      machineId,
      sessionId,
      side,
      channel,
      send: async (frame) => { await channel.send(JSON.stringify(frame)); },
      latest: null,
      error: null,
      vk: null,
      encrypted: channel?.encryption?.encrypted === true,
      renewAt: Date.now() + 10_000,
      startedAt: Date.now(),
    };
    session.listener = (event) => {
      const frame = payloadJson(event?.payload);
      if (frame === null || frame?.session_id !== sessionId) return;
      if (frame.type === 'view.hello_ack') {
        try {
          session.vk = session.side.finish(frame.public_key).key;
          session.encrypted = true;
          void channel.send(JSON.stringify({ type: 'view.request', session_id: sessionId, machine_id: machineId, fps: 1, max_bytes: maxBytes }));
        } catch {
          session.error = 'VIEW_VK_BAD';
        }
        return;
      }
      if (frame.type === 'view.frame') {
        if (session.vk === null) { session.error = 'VIEW_VK_REQUIRED'; return; }
        try {
          const plaintext = openViewFrame(session.vk, frame.ct);
          if (plaintext.length > maxBytes) { session.error = 'VIEW_FRAME_TOO_LARGE'; return; }
          session.latest = {
            seq: frame.seq ?? null,
            mime: frame.mime ?? 'image/jpeg',
            bytes: plaintext.length,
            data_base64: plaintext.toString('base64'),
            at: new Date().toISOString(),
            encrypted: true,
            channel: 'p2p',
          };
        } catch {
          session.error = 'VIEW_VK_BAD';
        }
        return;
      }
      if (frame.type === 'view.error') session.error = frame.code ?? 'VIEW_ERROR';
    };
    p2p.node.on('message', session.listener);
    session.unsubscribe = () => p2p.node.off?.('message', session.listener);
    try {
      await channel.send(JSON.stringify({ type: 'view.hello', session_id: sessionId, public_key: side.public_key }));
    } catch (error) {
      session.unsubscribe();
      return {
        ok: false,
        code: 'P2P_UNAVAILABLE',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return { ok: true, session, channel: 'p2p', preferred: 'p2p', fallback_reason: null };
  };

  const connectRelay = async ({ machineId, sessionId, side, webrtcError }) => {
    const relayRequest = await postRelayRequest({
      machineId,
      sessionId,
      publicKey: side.public_key,
      transport: 'relay',
    });
    if (relayRequest.ok !== true) {
      return {
        ok: false,
        code: 'P2P_UNAVAILABLE',
        error: webrtcError?.detail ?? webrtcError?.code ?? null,
        relay_error: relayRequest.error ?? null,
      };
    }
    const session = {
      mode: 'relay',
      machineId,
      sessionId,
      side,
      channel: null,
      send: null,
      latest: null,
      error: null,
      vk: null,
      encrypted: true,
      lastRelayAt: 0,
      renewAt: Date.now() + 10_000,
      startedAt: Date.now(),
    };
    return {
      ok: true,
      session,
      channel: 'relay',
      preferred: 'webrtc',
      fallback_reason: webrtcError?.code ?? null,
      ttl_ms: relayRequest.ttl_ms ?? null,
    };
  };

  ctx.inject(['connection'], (webCtx) => {
    const registry = webCtx?.connection?.fetch;
    if (registry === undefined || typeof registry.register !== 'function') {
      status.reason = 'the connection service carries no fetch registry';
      return;
    }
    registry.register({
      path: REMOTE_CONFIG_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          const config = readConfig(file);
          return Response.json({
            ok: true,
            enabled: config.enabled,
            transport: config.transport,
            session: active === null
              ? null
              : { machine_id: active.machineId, encrypted: active.encrypted === true, channel: active.mode },
          }, { headers: NO_STORE });
        }
        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        if (body === null || typeof body.enabled !== 'boolean') {
          return Response.json({ ok: false, error: 'a JSON body with {"enabled": true|false} is required' }, { status: 400, headers: NO_STORE });
        }
        let transport = readConfig(file).transport;
        if (body.transport !== undefined) {
          if (body.transport !== 'auto' && body.transport !== 'webrtc' && body.transport !== 'relay') {
            return Response.json({ ok: false, error: 'transport must be auto, webrtc or relay' }, { status: 400, headers: NO_STORE });
          }
          transport = body.transport;
        }
        if (body.enabled === false) await stopActive();
        writeConfig(file, body.enabled, transport);
        return Response.json({ ok: true, enabled: body.enabled, transport }, { headers: NO_STORE });
      },
    });

    registry.register({
      path: REMOTE_START_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const config = readConfig(file);
        if (config.enabled !== true) return Response.json({ ok: false, code: 'VIEW_DISABLED' }, { status: 403, headers: NO_STORE });
        let body = null;
        try { body = await request.json(); } catch { /* refused below */ }
        const machineId = typeof body?.machine_id === 'string' ? body.machine_id : '';
        if (machineId === '') {
          return Response.json({ ok: false, error: 'a JSON body with {"machine_id": "..."} is required' }, { status: 400, headers: NO_STORE });
        }
        await stopActive();
        const side = createViewSide();
        const sessionId = 'view-' + Date.now().toString(36);
        let webrtcError = null;

        if (config.transport !== 'relay') {
          const attempt = await connectWebrtc({
            pool: getPool(),
            machineId,
            sessionId,
            side,
          });
          if (attempt.ok === true) {
            active = attempt.session;
            return Response.json({
              ok: true,
              machine_id: machineId,
              session_id: sessionId,
              encrypted: true,
              channel: 'webrtc',
              preferred: 'webrtc',
              fallback_reason: null,
              websocket_transport: 'webrtc-v1',
            }, { headers: NO_STORE });
          }
          webrtcError = attempt;
          if (config.transport === 'webrtc') {
            return Response.json({
              ok: false,
              code: 'WEBRTC_UNAVAILABLE',
              preferred: 'webrtc',
              detail: { code: attempt.code ?? null, reason: attempt.detail ?? null, ack: attempt.ack ?? null },
            }, { status: 502, headers: NO_STORE });
          }
        }

        if (config.transport === 'auto' && p2p?.node !== null && p2p?.node !== undefined) {
          const p2pAttempt = await connectP2P({ machineId, sessionId, side });
          if (p2pAttempt.ok === true) {
            active = p2pAttempt.session;
            return Response.json({
              ok: true,
              machine_id: machineId,
              session_id: sessionId,
              encrypted: active.encrypted === true,
              channel: 'p2p',
              preferred: 'webrtc',
              fallback_reason: webrtcError?.code ?? null,
            }, { headers: NO_STORE });
          }
          if (webrtcError === null) webrtcError = p2pAttempt;
        }

        if (config.transport === 'webrtc') {
          return Response.json({
            ok: false,
            code: 'WEBRTC_UNAVAILABLE',
            preferred: 'webrtc',
            detail: { code: webrtcError?.code ?? null, reason: webrtcError?.detail ?? null },
          }, { status: 502, headers: NO_STORE });
        }

        const relayAttempt = await connectRelay({ machineId, sessionId, side, webrtcError });
        if (relayAttempt.ok !== true) {
          return Response.json({
            ok: false,
            code: 'P2P_UNAVAILABLE',
            error: webrtcError?.detail ?? webrtcError?.code ?? null,
            relay_error: relayAttempt.relay_error ?? null,
            preferred: 'webrtc',
          }, { status: 502, headers: NO_STORE });
        }
        active = relayAttempt.session;
        return Response.json({
          ok: true,
          machine_id: machineId,
          session_id: sessionId,
          encrypted: true,
          channel: 'relay',
          preferred: 'webrtc',
          fallback_reason: relayAttempt.fallback_reason,
          relay_ttl_ms: relayAttempt.ttl_ms ?? null,
          webrtc_error: webrtcError?.code ?? null,
        }, { headers: NO_STORE });
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
        if (readConfig(file).enabled !== true) {
          return Response.json({ ok: false, code: 'VIEW_DISABLED' }, { status: 403, headers: NO_STORE });
        }
        if (active !== null) {
          if (active.mode === 'webrtc') {
            if (active.vk === null && Date.now() >= active.handshakeDeadline) {
              active.error = 'VIEW_WEBRTC_HANDSHAKE_TIMEOUT';
            }
            if (active.vk !== null && Date.now() >= active.renewAt) {
              active.renewAt = Date.now() + 10_000;
              try {
                await active.send({ type: 'view.request', session_id: active.sessionId, machine_id: active.machineId, fps: 1, max_bytes: maxBytes });
              } catch (error) {
                active.error = error?.code ?? 'VIEW_WEBRTC_SEND_FAILED';
              }
            }
            if (active.latest !== null) return Response.json({ ok: true, ...active.latest, channel: 'webrtc' }, { headers: NO_STORE });
            if (active.error !== null) return Response.json({ ok: false, code: active.error, channel: 'webrtc' }, { status: 502, headers: NO_STORE });
            return Response.json({ ok: false, code: 'VIEW_WAITING_FOR_FRAME', machine_id: active.machineId, channel: 'webrtc' }, { status: 202, headers: NO_STORE });
          }

          if (active.mode === 'p2p') {
            if (Date.now() >= active.renewAt) {
              active.renewAt = Date.now() + 10_000;
              try {
                void active.channel.send(JSON.stringify({ type: 'view.request', session_id: active.sessionId, machine_id: active.machineId, fps: 1, max_bytes: maxBytes }));
              } catch { /* peer gone */ }
            }
            if (active.latest !== null) return Response.json({ ok: true, ...active.latest, channel: 'p2p' }, { headers: NO_STORE });
            if (active.error !== null) return Response.json({ ok: false, code: active.error, channel: 'p2p' }, { status: 502, headers: NO_STORE });
            return Response.json({ ok: false, code: 'VIEW_WAITING_FOR_FRAME', machine_id: active.machineId, channel: 'p2p' }, { status: 202, headers: NO_STORE });
          }

          // Relay media is latest-frame-wins; each poll asks for the next frame instead of
          // serving the first frame forever.
          if (active.latest === null || Date.now() - active.lastRelayAt >= 900) {
            active.lastRelayAt = Date.now();
            if (Date.now() >= active.renewAt) {
              active.renewAt = Date.now() + 10_000;
              void postRelayRequest({
                machineId: active.machineId,
                sessionId: active.sessionId,
                publicKey: active.side.public_key,
                transport: 'relay',
              });
            }
            const got = await fetchRelayFrame({ sessionId: active.sessionId, machineId: active.machineId });
            if (got.ok === true) {
              try {
                if (typeof got.public_key === 'string') active.vk = active.side.finish(got.public_key).key;
                if (active.vk === null) {
                  active.error = 'VIEW_VK_REQUIRED';
                  return Response.json({ ok: false, code: active.error, channel: 'relay' }, { status: 502, headers: NO_STORE });
                }
                const plaintext = openViewFrame(active.vk, got.ct);
                if (plaintext.length <= maxBytes) {
                  active.latest = {
                    seq: null,
                    mime: 'image/jpeg',
                    bytes: plaintext.length,
                    data_base64: plaintext.toString('base64'),
                    at: new Date().toISOString(),
                    encrypted: true,
                    channel: 'relay',
                  };
                  active.error = null;
                }
              } catch {
                active.error = 'VIEW_VK_BAD';
              }
            } else if (got.waiting !== true) {
              active.error = 'VIEW_RELAY_UNAVAILABLE';
            }
          }
          if (active.latest !== null) return Response.json({ ok: true, ...active.latest, channel: 'relay' }, { headers: NO_STORE });
          if (active.error !== null) return Response.json({ ok: false, code: active.error, channel: 'relay' }, { status: 502, headers: NO_STORE });
          return Response.json({ ok: false, code: 'VIEW_WAITING_FOR_FRAME', machine_id: active.machineId, channel: 'relay' }, { status: 202, headers: NO_STORE });
        }

        const started = Date.now();
        const result = await capture({ platform });
        if (result.ok !== true) {
          return Response.json({ ok: false, code: 'CAPTURE_FAILED', error: result.error ?? null }, { status: 502, headers: NO_STORE });
        }
        return Response.json({
          ok: true,
          mime: result.mime ?? 'image/jpeg',
          data_base64: result.data_base64,
          bytes: Math.ceil((result.data_base64?.length ?? 0) * 3 / 4),
          capture_ms: Date.now() - started,
          at: new Date().toISOString(),
        }, { headers: NO_STORE });
      },
    });
    status.mounted = true;
    status.reason = null;
    status.configPath = file;
  });
  return status;
}
