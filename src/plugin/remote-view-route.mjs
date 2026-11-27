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
 *   4. `transport: 'webrtc'` is the default for remote desktop: it only uses the
 *      shared pool and returns a named 502 when the pool or pair is unavailable.
 *      Only an explicit `transport: 'auto'` may fall back to the old
 *      encrypted-relay blind forwarding.
 *
 * The desktop row never owns the pool: it borrows the process-wide pool built
 * by `tools/shared.mjs` and only unsubscribes on stop. `closePeer()` is
 * deliberately not called here, because Teams and task delivery share that
 * transport.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureHostScreen } from './capture-route.mjs';
import { getSharedWebRtcPool, getSharedWebRtcPoolState } from './webrtc-pool-registry.mjs';
import { createViewSide, openViewFrame } from '../agent/view/session-key.mjs';
import { tierPreset, VIEW_ENVELOPE_BYTES } from '../agent/view/quality.mjs';
import { resolveStateDir } from '../util/cli.mjs';

export const REMOTE_CONFIG_PATH = '/api/w2m/remote/config';
export const REMOTE_FRAME_PATH = '/api/w2m/remote/frame';
export const REMOTE_START_PATH = '/api/w2m/remote/start';
export const REMOTE_STOP_PATH = '/api/w2m/remote/stop';
export const REMOTE_DIAGNOSTICS_PATH = '/api/w2m/remote/diagnostics';
const NO_STORE = { 'cache-control': 'no-store' };
const RELAY_ACK_PATH = '/v1/remote/ack';

const DEFAULT_TRANSPORT = 'webrtc';
const DEFAULT_PUNCH_ATTEMPTS = 3;
const DEFAULT_PUNCH_BACKOFF_MS = 700;

function normalizeTransport(value, fallback = DEFAULT_TRANSPORT) {
  if (value === 'webrtc' || value === 'relay' || value === 'auto') return value;
  return fallback;
}

/**
 * A bounded integer knob. Invalid input falls back instead of taking the panel down: these values
 * tune retry pacing, not a security boundary, and a hand-edited JSON file must not make remote
 * desktop unusable. The bounds are low enough that a typo cannot turn one click into an unbounded
 * retry loop.
 */
function boundedInt(value, min, max, fallback) {
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function punchDefaults(defaults = {}) {
  return {
    punch_attempts: boundedInt(defaults.punchAttempts, 1, 10, DEFAULT_PUNCH_ATTEMPTS),
    punch_backoff_ms: boundedInt(defaults.punchBackoffMs, 100, 10_000, DEFAULT_PUNCH_BACKOFF_MS),
    punch_source: defaults.punchSource === 'row' ? 'row' : 'default',
  };
}

function readConfig(file, defaults = {}) {
  const defaultTransport = normalizeTransport(defaults.transport);
  const defaultSource = defaults.transportSource === 'row' ? 'row' : 'default';
  const punch = punchDefaults(defaults);
  if (!existsSync(file)) {
    return {
      ok: true,
      enabled: false,
      transport: defaultTransport,
      transport_source: defaultSource,
      ...punch,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const fileTransport = parsed?.transport;
    const hasTransport = fileTransport === 'webrtc' || fileTransport === 'relay' || fileTransport === 'auto';
    const hasPunchAttempts = Number.isInteger(parsed?.punch_attempts);
    const hasPunchBackoff = Number.isInteger(parsed?.punch_backoff_ms);
    return {
      ok: true,
      enabled: parsed?.enabled === true,
      transport: hasTransport ? fileTransport : defaultTransport,
      transport_source: hasTransport ? 'json' : defaultSource,
      punch_attempts: boundedInt(parsed?.punch_attempts, 1, 10, punch.punch_attempts),
      punch_backoff_ms: boundedInt(parsed?.punch_backoff_ms, 100, 10_000, punch.punch_backoff_ms),
      punch_source: hasPunchAttempts || hasPunchBackoff ? 'json' : punch.punch_source,
    };
  } catch {
    // The file exists but is not usable. Do not silently resurrect a row default: enabled stays
    // false, so /start refuses, and the caller can see that the JSON itself is broken.
    return {
      ok: false,
      enabled: false,
      transport: defaultTransport,
      transport_source: 'json',
      ...punch,
      error: 'REMOTE_CONFIG_INVALID',
    };
  }
}

function writeConfig(file, enabled, transport, punch = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(
    tmp,
    JSON.stringify({
      enabled: enabled === true,
      transport: normalizeTransport(transport),
      punch_attempts: boundedInt(punch.punch_attempts, 1, 10, DEFAULT_PUNCH_ATTEMPTS),
      punch_backoff_ms: boundedInt(punch.punch_backoff_ms, 100, 10_000, DEFAULT_PUNCH_BACKOFF_MS),
      updatedAt: new Date().toISOString(),
    }),
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
 * @param {{stateDir:string, p2p?:object, getPool?:()=>object|null, getPoolState?:()=>object|null,
 *   pool?:object|null, capture?:Function, platform?:string, maxBytes?:number,
 *   prepareTimeoutMs?:number, handshakeTimeoutMs?:number, ackPollMs?:number,
 *   punchAttempts?:number, punchBackoffMs?:number,
 *   transport?:'auto'|'webrtc'|'relay', allowLegacyP2P?:boolean}} deps
 *   `transport` and `allowLegacyP2P` are row defaults: they apply until
 *   `remote-view.json` supplies its own `transport`. The built-in default is
 *   `webrtc`, so a fresh install never silently falls back to relay.
 *   `allowLegacyP2P` defaults to false, so `auto` never dials the old UDP path
 *   unless a row explicitly opts in.
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
  const hasExplicitPool = typeof deps.getPool === 'function'
    || (typeof deps.pool === 'object' && deps.pool !== null);
  const getPool = typeof deps.getPool === 'function'
    ? deps.getPool
    : (typeof deps.pool === 'object' && deps.pool !== null ? () => deps.pool : getSharedWebRtcPool);
  // Owner/ready only make sense for the registry-backed pool. A test-injected pool has no registry
  // record, so it reports no state rather than borrowing the process-wide owner by accident.
  const getPoolState = typeof deps.getPoolState === 'function'
    ? deps.getPoolState
    : (hasExplicitPool ? () => null : getSharedWebRtcPoolState);
  const rowTransportSpecified = Object.hasOwn(deps, 'transport');
  const rowTransportValid = deps.transport === 'auto' || deps.transport === 'webrtc' || deps.transport === 'relay';
  const defaultTransport = rowTransportSpecified ? normalizeTransport(deps.transport) : DEFAULT_TRANSPORT;
  const defaultTransportSource = rowTransportSpecified ? 'row' : 'default';
  const transportWarning = rowTransportSpecified && !rowTransportValid
    ? {
      code: 'W2M_DESKTOP_TRANSPORT_INVALID',
      configured: typeof deps.transport === 'string' ? deps.transport : String(deps.transport),
      fallback: defaultTransport,
      message: 'desktop transport must be auto, webrtc or relay; the row value was ignored and webrtc is in use',
    }
    : null;
  const allowLegacyP2P = deps.allowLegacyP2P === true;
  // Two caps, because the two paths are different products: a DataChannel may carry 720P..4K, while
  // the relay's own broker refuses anything above 100 KiB of ciphertext. The viewer checks each
  // decoded frame against the cap of the channel it arrived on — the relay's check is stricter than
  // the p2p one, never the other way round.
  const p2pTier = tierPreset('p2p');
  const relayTier = tierPreset('relay');
  const maxBytes = Number.isInteger(deps.maxBytes) && deps.maxBytes > 0
    ? Math.min(deps.maxBytes, p2pTier.maxBytes)
    : p2pTier.maxBytes;
  const relayMaxBytes = relayTier.maxBytes - VIEW_ENVELOPE_BYTES;
  const prepareTimeoutMs = Number.isInteger(deps.prepareTimeoutMs) && deps.prepareTimeoutMs > 0
    ? deps.prepareTimeoutMs
    : 15_000;
  const handshakeTimeoutMs = Number.isInteger(deps.handshakeTimeoutMs) && deps.handshakeTimeoutMs > 0
    ? deps.handshakeTimeoutMs
    : 10_000;
  const ackPollMs = Number.isInteger(deps.ackPollMs) && deps.ackPollMs > 0 ? deps.ackPollMs : 300;
  const rowPunchAttempts = Number.isInteger(deps.punchAttempts) && deps.punchAttempts > 0
    ? Math.min(10, Math.max(1, deps.punchAttempts))
    : null;
  const rowPunchBackoffMs = Number.isInteger(deps.punchBackoffMs) && deps.punchBackoffMs > 0
    ? Math.min(10_000, Math.max(100, deps.punchBackoffMs))
    : null;
  let active = null;
  // The disposer for the row lifetime. Registered only when a session exists: an effect that owns
  // nothing is a disposer that releases nothing, and every other row on this host would see an
  // extra entry in `ctx.effect` for a view that never started. It is released when the session ends
  // and re-armed by the next start.
  let sessionDisposer = null;
  // P5 read-only diagnostics. Counters are process-local and never persisted: they describe this
  // viewer's current host lifetime, not a fleet-wide metric. `last_error` keeps the most recent named
  // failure so a diagnostics read after a failed attempt still explains what happened.
  const counters = {
    ack_polls: 0,
    ack_count: 0,
    last_ack_code: null,
    last_ack_at: null,
    relay_frame_calls: 0,
    relay_frames: 0,
    last_relay_frame_at: null,
    last_error: null,
    last_start_at: null,
    last_stop_at: null,
    started_at: new Date().toISOString(),
  };
  const noteError = (code, detail = null) => {
    if (typeof code !== 'string' || code === '') return;
    counters.last_error = {
      code,
      detail: detail === null || detail === undefined ? null : String(detail).slice(0, 300),
      at: new Date().toISOString(),
    };
  };
  const setActiveError = (code) => {
    if (active !== null) active.error = code;
    noteError(code);
  };

  const releaseSessionDisposer = () => {
    const dispose = sessionDisposer;
    sessionDisposer = null;
    if (typeof dispose === 'function') {
      try {
        dispose();
      } catch {
        /* the host is already tearing the row down */
      }
    }
  };

  const stopActive = async () => {
    counters.last_stop_at = new Date().toISOString();
    if (active === null) {
      releaseSessionDisposer();
      return;
    }
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
    releaseSessionDisposer();
  };

  /**
   * Own the live session for the rest of the row's lifetime.
   *
   * Registered at the moment the session becomes active, not at route-registration time: a row that
   * never opens a view must leave the host's effect list exactly as it found it. The disposer nulls
   * its own handle first, because `stopActive` calls `releaseSessionDisposer` on every path and must
   * not re-enter the effect it is being disposed by.
   */
  const ownActiveSession = () => {
    if (active === null || sessionDisposer !== null || typeof ctx.effect !== 'function') return;
    try {
      sessionDisposer = ctx.effect(() => () => {
        sessionDisposer = null;
        void stopActive();
      }, 'w2m: remote view session');
    } catch {
      // A host that refuses an effect this late still has the /stop route; the session is usable.
      sessionDisposer = null;
    }
  };

  const setActive = (session) => {
    active = session;
    ownActiveSession();
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
    counters.ack_polls += 1;
    const device = readDevice(stateDir);
    if (device.base === '' || device.token === '') return { ok: false, code: 'WEBRTC_ACK_UNAVAILABLE' };
    try {
      const url = device.base + RELAY_ACK_PATH
        + '?session_id=' + encodeURIComponent(sessionId)
        + '&target=' + encodeURIComponent(machineId);
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + device.token }, signal: timeoutSignal(3_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.ok === true) {
        counters.ack_count += 1;
        counters.last_ack_code = typeof body?.code === 'string'
          ? body.code
          : (body?.prepared === true ? 'WEBRTC_PREPARED' : 'WEBRTC_PREPARE_FAILED');
        counters.last_ack_at = new Date().toISOString();
        return { ok: true, body };
      }
      if (response.status === 404 && body?.error?.code === 'REMOTE_ACK_NOT_FOUND') {
        return { ok: false, pending: true, code: 'REMOTE_ACK_NOT_FOUND' };
      }
      const code = response.status === 404 ? 'WEBRTC_ACK_UNAVAILABLE' : (body?.error?.code ?? 'WEBRTC_ACK_FAILED');
      noteError(code, body?.error?.detail ?? null);
      return { ok: false, code };
    } catch (error) {
      noteError('WEBRTC_ACK_UNAVAILABLE', error instanceof Error ? error.message : String(error));
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
    counters.relay_frame_calls += 1;
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

  const connectWebrtc = async ({ pool, poolState, machineId, sessionId, side }) => {
    const startedAt = Date.now();
    const state = poolState !== null && typeof poolState === 'object' ? poolState : null;
    const poolMachineId = typeof pool?.machineId === 'string' && pool.machineId !== ''
      ? pool.machineId
      : (typeof state?.machine_id === 'string' ? state.machine_id : null);
    // `pool_owner` is this viewer's pool owner (the process that published the transport), not the
    // target's. The target's owner travels back in the ack and is surfaced as `ack_pool_owner`, so a
    // reader can tell which side of the pair is borrowed.
    const finish = (result) => {
      const ackBody = result.ack !== null && typeof result.ack === 'object' ? result.ack : null;
      return {
        ...result,
        pool_owner: state?.owner ?? null,
        pool_machine_id: poolMachineId,
        prepare_ms: Date.now() - startedAt,
        ack_code: result.ack_code ?? ackBody?.code ?? (result.ok === true ? 'WEBRTC_PREPARED' : null),
        ack_pool_owner: result.ack_pool_owner ?? ackBody?.pool_owner ?? null,
      };
    };
    if (pool === null || typeof pool !== 'object' || typeof pool.ensure !== 'function' || typeof pool.send !== 'function') {
      return finish({ ok: false, code: 'WEBRTC_POOL_UNAVAILABLE', detail: 'this host has no shared WebRTC pool' });
    }
    if (typeof pool.onMessage !== 'function') {
      return finish({ ok: false, code: 'WEBRTC_POOL_INVALID', detail: 'the shared pool has no onMessage()' });
    }
    const device = readDevice(stateDir);
    const viewerMachineId = device.machineId !== ''
      ? device.machineId
      : (typeof pool.machineId === 'string' ? pool.machineId : '');
    if (viewerMachineId === '') {
      return finish({ ok: false, code: 'WEBRTC_VIEWER_ID_UNAVAILABLE', detail: 'device.json has no machine_id' });
    }
    const asked = await postRelayRequest({
      machineId,
      sessionId,
      publicKey: side.public_key,
      transport: 'webrtc',
      viewerMachineId,
    });
    if (asked.ok !== true) {
      return finish({ ok: false, code: 'WEBRTC_ACK_UNAVAILABLE', detail: asked.error });
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
      return finish({
        ok: false,
        code: error?.viewResult?.code ?? 'WEBRTC_POOL_START_FAILED',
        detail: error?.viewResult?.detail ?? (error instanceof Error ? error.message : String(error)),
      });
    }
    if (ack.ok !== true) {
      return finish({ ok: false, code: ack.code, detail: ack.detail ?? null, ack: ack.body ?? null });
    }

    const ready = await readyPromise;
    if (ready.ok !== true) {
      return finish({
        ok: false,
        code: ready.code ?? 'WEBRTC_POOL_START_FAILED',
        detail: ready.detail ?? null,
        ack: ack.body,
      });
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
          void send({ type: 'view.request', session_id: sessionId, machine_id: machineId, fps: 1, max_bytes: maxBytes, tier: 'p2p' })
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
      return finish({
        ok: false,
        code: error?.code ?? 'VIEW_WEBRTC_SEND_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        ack: ack.body,
      });
    }
    return finish({
      ok: true,
      session,
      channel: 'webrtc',
      preferred: 'webrtc',
      fallback_reason: null,
      ack: ack.body,
    });
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
          void channel.send(JSON.stringify({ type: 'view.request', session_id: sessionId, machine_id: machineId, fps: 1, max_bytes: maxBytes, tier: 'p2p' }));
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

  const readCurrentConfig = () => readConfig(file, {
    transport: defaultTransport,
    transportSource: defaultTransportSource,
    ...(rowPunchAttempts === null ? {} : { punchAttempts: rowPunchAttempts, punchSource: 'row' }),
    ...(rowPunchBackoffMs === null ? {} : { punchBackoffMs: rowPunchBackoffMs, punchSource: 'row' }),
  });
  // `preferred` is the product policy, not the mode the caller forced: WebRTC stays the preferred
  // path even when `transport:'relay'` explicitly bypasses it.
  const preferredFor = () => 'webrtc';
  const currentPoolState = () => {
    try {
      const state = getPoolState();
      return state !== null && typeof state === 'object' ? state : null;
    } catch {
      return null;
    }
  };
  const webrtcFacts = (attempt) => {
    if (attempt === null) {
      return {
        attempted: false,
        ok: false,
        code: null,
        detail: null,
        pool_owner: null,
        pool_machine_id: null,
        prepare_ms: null,
        ack_code: null,
        ack_pool_owner: null,
      };
    }
    return {
      attempted: true,
      ok: attempt.ok === true,
      code: attempt.code ?? null,
      detail: attempt.detail ?? null,
      pool_owner: attempt.pool_owner ?? null,
      pool_machine_id: attempt.pool_machine_id ?? null,
      prepare_ms: attempt.prepare_ms ?? null,
      ack_code: attempt.ack_code ?? null,
      ack_pool_owner: attempt.ack_pool_owner ?? null,
    };
  };
  // Every /start response carries these five fields whether it succeeded, failed strictly, or fell
  // back. Callers should not have to infer "did we use relay?" from the presence of `relay_ttl_ms`.
  const startFacts = ({ channel = null, preferred, fallbackReason = null, attempt = null, relayUsed = false }) => ({
    channel,
    preferred,
    fallback_reason: fallbackReason ?? null,
    webrtc: webrtcFacts(attempt),
    relay_used: relayUsed === true,
  });

  // Diagnostics must be safe to read from a browser: no token, no private key, no full signaling
  // URL. `last_error.detail` is the one free-form field, so URLs and bearer material are redacted.
  const redactDiagnosticText = (value) => String(value)
    .replace(/(?:wss?|https?):\/\/[^\s]+/gi, '<signaling-url>')
    .replace(/bearer\s+[^\s]+/gi, 'Bearer <redacted>')
    .replace(/(token=)[^&\s]+/gi, '$1<redacted>');
  const peerDiagnostic = (entry) => ({
    peer: entry?.peer ?? null,
    role: entry?.role ?? null,
    state: entry?.state ?? null,
    path: entry?.path ?? null,
    path_reason: entry?.path_reason === null || entry?.path_reason === undefined
      ? null
      : redactDiagnosticText(entry.path_reason),
    rtt_ms: entry?.rtt_ms ?? null,
    secure: entry?.secure ?? null,
    provider_ready: entry?.provider_ready ?? null,
    started_at: entry?.started_at ?? null,
    last_used_at: entry?.last_used_at ?? null,
    starts: entry?.starts ?? 0,
    sends: entry?.sends ?? 0,
    bytes_sent: entry?.bytes_sent ?? 0,
    last_error: entry?.last_error === null || entry?.last_error === undefined
      ? null
      : (typeof entry.last_error === 'string'
        ? { code: null, detail: redactDiagnosticText(entry.last_error) }
        : {
          code: entry.last_error.code ?? null,
          detail: entry.last_error.detail === null || entry.last_error.detail === undefined
            ? null
            : redactDiagnosticText(entry.last_error.detail),
        }),
  });
  const poolDiagnostic = () => {
    const pool = getPool();
    const state = currentPoolState();
    const available = pool !== null && typeof pool === 'object' && state?.ready !== false;
    let snapshot = null;
    if (available && typeof pool.diagnostics === 'function') {
      try { snapshot = pool.diagnostics(); } catch { snapshot = null; }
    }
    const peers = Array.isArray(snapshot?.peers)
      ? snapshot.peers.map(peerDiagnostic).filter((entry) => entry.peer !== null)
      : [];
    return {
      available,
      owner: state?.owner ?? null,
      ready: state?.ready ?? null,
      epoch: state?.epoch ?? null,
      machine_id: typeof pool?.machineId === 'string' ? pool.machineId : (snapshot?.machine_id ?? null),
      peer_count: peers.length,
      peers,
      stats: snapshot?.stats === undefined || snapshot.stats === null
        ? null
        : {
          sends: snapshot.stats.sends ?? 0,
          send_failures: snapshot.stats.send_failures ?? 0,
          start_failures: snapshot.stats.start_failures ?? 0,
          bytes_sent: snapshot.stats.bytes_sent ?? 0,
        },
    };
  };
  const diagnosticsBody = () => {
    const config = readCurrentConfig();
    const pool = poolDiagnostic();
    const peer = active === null
      ? null
      : pool.peers.find((entry) => entry.peer === active.machineId) ?? null;
    const direct = active === null
      ? null
      : active.mode === 'relay'
        ? false
        : active.mode === 'p2p'
          ? true
          : (peer?.path === 'direct' ? true : (peer?.path === null || peer?.path === undefined ? null : false));
    return {
      ok: true,
      at: new Date().toISOString(),
      uptime_ms: Date.now() - Date.parse(counters.started_at),
      pool_available: pool.available,
      pool_owner: pool.owner,
      transport_source: config.transport_source,
      transport_warning: transportWarning,
      legacy_p2p: allowLegacyP2P,
      config: {
        enabled: config.enabled,
        transport: config.transport,
        transport_source: config.transport_source,
        transport_warning: transportWarning,
        punch_attempts: config.punch_attempts,
        punch_backoff_ms: config.punch_backoff_ms,
        punch_source: config.punch_source,
        legacy_p2p: allowLegacyP2P,
      },
      pool,
      session: active === null
        ? null
        : {
          machine_id: active.machineId,
          channel: active.mode,
          encrypted: active.encrypted === true,
          direct,
          error: active.error ?? null,
          started_at: active.startedAt ?? null,
          last_frame_at: active.latest?.at ?? null,
        },
      counters: {
        ack_polls: counters.ack_polls,
        ack_count: counters.ack_count,
        last_ack_code: counters.last_ack_code,
        last_ack_at: counters.last_ack_at,
        relay_frame_calls: counters.relay_frame_calls,
        relay_frames: counters.relay_frames,
        last_relay_frame_at: counters.last_relay_frame_at,
      },
      last_error: counters.last_error === null
        ? (active?.error === null || active?.error === undefined
          ? null
          : { code: active.error, detail: null, at: null })
        : {
          code: counters.last_error.code,
          detail: counters.last_error.detail === null ? null : redactDiagnosticText(counters.last_error.detail),
          at: counters.last_error.at,
        },
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
          const config = readCurrentConfig();
          const pool = getPool();
          const poolState = currentPoolState();
          return Response.json({
            ok: true,
            enabled: config.enabled,
            transport: config.transport,
            transport_source: config.transport_source,
            transport_warning: transportWarning,
            punch_attempts: config.punch_attempts,
            punch_backoff_ms: config.punch_backoff_ms,
            punch_source: config.punch_source,
            pool_available: pool !== null && typeof pool === 'object' && poolState?.ready !== false,
            pool_owner: poolState?.owner ?? null,
            legacy_p2p: allowLegacyP2P,
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
        const current = readCurrentConfig();
        let transport = current.transport;
        let transportChanged = false;
        let punchAttempts = current.punch_attempts;
        let punchBackoffMs = current.punch_backoff_ms;
        if (body.transport !== undefined) {
          if (body.transport !== 'auto' && body.transport !== 'webrtc' && body.transport !== 'relay') {
            return Response.json({ ok: false, error: 'transport must be auto, webrtc or relay' }, { status: 400, headers: NO_STORE });
          }
          transport = body.transport;
          transportChanged = transport !== current.transport;
        }
        if (body.punch_attempts !== undefined) {
          if (!Number.isInteger(body.punch_attempts) || body.punch_attempts < 1 || body.punch_attempts > 10) {
            return Response.json({ ok: false, error: 'punch_attempts must be an integer from 1 to 10' }, { status: 400, headers: NO_STORE });
          }
          punchAttempts = body.punch_attempts;
        }
        if (body.punch_backoff_ms !== undefined) {
          if (!Number.isInteger(body.punch_backoff_ms) || body.punch_backoff_ms < 100 || body.punch_backoff_ms > 10_000) {
            return Response.json({ ok: false, error: 'punch_backoff_ms must be an integer from 100 to 10000' }, { status: 400, headers: NO_STORE });
          }
          punchBackoffMs = body.punch_backoff_ms;
        }
        // A transport switch must not keep the old channel alive underneath the new setting: the
        // panel labels the current mode from `/config`, while the session object still describes
        // WebRTC/relay. Stop first, then persist, so the next `/start` uses the new transport.
        const enabled = body.enabled === true;
        if (enabled === false || transportChanged) await stopActive();
        writeConfig(file, enabled, transport, { punch_attempts: punchAttempts, punch_backoff_ms: punchBackoffMs });
        return Response.json({
          ok: true,
          enabled,
          transport,
          punch_attempts: punchAttempts,
          punch_backoff_ms: punchBackoffMs,
        }, { headers: NO_STORE });
      },
    });

    // Read-only and deliberately on the same authenticated Connection.fetch registry as the rest of
    // the remote-view routes: the host's connection layer owns auth, this route only shapes state.
    registry.register({
      path: REMOTE_DIAGNOSTICS_PATH,
      methods: ['GET'],
      fetch: async () => Response.json(diagnosticsBody(), { headers: NO_STORE }),
    });

    registry.register({
      path: REMOTE_START_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const config = readCurrentConfig();
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
        counters.last_start_at = new Date().toISOString();
        const preferred = preferredFor();
        let webrtcError = null;

        if (config.transport !== 'relay') {
          const attempt = await connectWebrtc({
            pool: getPool(),
            poolState: currentPoolState(),
            machineId,
            sessionId,
            side,
          });
          if (attempt.ok === true) {
            setActive(attempt.session);
            return Response.json({
              ok: true,
              machine_id: machineId,
              session_id: sessionId,
              encrypted: true,
              ...startFacts({ channel: 'webrtc', preferred, attempt }),
              websocket_transport: 'webrtc-v1',
            }, { headers: NO_STORE });
          }
          webrtcError = attempt;
          noteError(attempt.code ?? 'WEBRTC_UNAVAILABLE', attempt.detail ?? null);
          if (config.transport === 'webrtc') {
            return Response.json({
              ok: false,
              code: 'WEBRTC_UNAVAILABLE',
              ...startFacts({ channel: null, preferred, attempt }),
              detail: { code: attempt.code ?? null, reason: attempt.detail ?? null, ack: attempt.ack ?? null },
            }, { status: 502, headers: NO_STORE });
          }
        }

        // `auto` used to dial the old UDP path whenever a node happened to exist, which made the
        // production default implicitly legacy. P4 removes that: only an explicit opt-in may try it.
        if (config.transport === 'auto' && allowLegacyP2P && p2p?.node !== null && p2p?.node !== undefined) {
          const p2pAttempt = await connectP2P({ machineId, sessionId, side });
          if (p2pAttempt.ok === true) {
            setActive(p2pAttempt.session);
            return Response.json({
              ok: true,
              machine_id: machineId,
              session_id: sessionId,
              encrypted: active.encrypted === true,
              ...startFacts({
                channel: 'p2p',
                preferred,
                fallbackReason: webrtcError?.code ?? null,
                attempt: webrtcError,
              }),
            }, { headers: NO_STORE });
          }
          if (webrtcError === null) webrtcError = p2pAttempt;
          noteError(p2pAttempt.code ?? 'P2P_UNAVAILABLE', p2pAttempt.detail ?? null);
        }

        const relayAttempt = await connectRelay({ machineId, sessionId, side, webrtcError });
        if (relayAttempt.ok !== true) {
          noteError(relayAttempt.code ?? 'P2P_UNAVAILABLE', relayAttempt.relay_error ?? null);
          return Response.json({
            ok: false,
            code: 'P2P_UNAVAILABLE',
            ...startFacts({
              channel: null,
              preferred,
              fallbackReason: webrtcError?.code ?? null,
              attempt: webrtcError,
            }),
            error: webrtcError?.detail ?? webrtcError?.code ?? null,
            relay_error: relayAttempt.relay_error ?? null,
          }, { status: 502, headers: NO_STORE });
        }
        setActive(relayAttempt.session);
        return Response.json({
          ok: true,
          machine_id: machineId,
          session_id: sessionId,
          encrypted: true,
          ...startFacts({
            channel: 'relay',
            preferred,
            fallbackReason: relayAttempt.fallback_reason,
            attempt: webrtcError,
            relayUsed: true,
          }),
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
        if (readCurrentConfig().enabled !== true) {
          return Response.json({ ok: false, code: 'VIEW_DISABLED' }, { status: 403, headers: NO_STORE });
        }
        if (active !== null) {
          if (active.mode === 'webrtc') {
            if (active.vk === null && Date.now() >= active.handshakeDeadline) {
              setActiveError('VIEW_WEBRTC_HANDSHAKE_TIMEOUT');
            }
            if (active.vk !== null && Date.now() >= active.renewAt) {
              active.renewAt = Date.now() + 10_000;
              try {
                await active.send({ type: 'view.request', session_id: active.sessionId, machine_id: active.machineId, fps: 1, max_bytes: maxBytes, tier: 'p2p' });
              } catch (error) {
                setActiveError(error?.code ?? 'VIEW_WEBRTC_SEND_FAILED');
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
                void active.channel.send(JSON.stringify({ type: 'view.request', session_id: active.sessionId, machine_id: active.machineId, fps: 1, max_bytes: maxBytes, tier: 'p2p' }));
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
                  setActiveError('VIEW_VK_REQUIRED');
                  return Response.json({ ok: false, code: active.error, channel: 'relay' }, { status: 502, headers: NO_STORE });
                }
                const plaintext = openViewFrame(active.vk, got.ct);
                if (plaintext.length <= relayMaxBytes) {
                  active.latest = {
                    seq: null,
                    mime: 'image/jpeg',
                    bytes: plaintext.length,
                    data_base64: plaintext.toString('base64'),
                    at: new Date().toISOString(),
                    encrypted: true,
                    channel: 'relay',
                  };
                  counters.relay_frames += 1;
                  counters.last_relay_frame_at = active.latest.at;
                  active.error = null;
                }
              } catch {
                setActiveError('VIEW_VK_BAD');
              }
            } else if (got.waiting !== true) {
              setActiveError('VIEW_RELAY_UNAVAILABLE');
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
