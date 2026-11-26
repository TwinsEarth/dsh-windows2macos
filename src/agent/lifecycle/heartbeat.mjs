/**
 * The heartbeat phase: the SSE stream (attach, reconnect/backoff, dispatch), the
 * idle diagnostic heartbeat and the cross-process state-file publishing.
 *
 * This phase owns the event intake both transports feed into: an SSE frame and a
 * JSON frame from a P2P channel reach the *same* `dispatchFrame()`, which is what
 * makes an offer from a channel and an offer from the relay one code path. It
 * forwards offers to the offer phase (`enqueue`) and acknowledgements to the
 * deliver phase, and it reaches into neither of them for state.
 *
 * It is composed after `offer` and `deliver` so those handlers exist by the time
 * a frame can arrive. No module-level mutable state: timers, cursors and the
 * stream abort controller all live inside the factory.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import { createSseWatchdog } from '../sse-watchdog.mjs';
import { shouldAdvanceCursor } from '../sse-cursor.mjs';
import { captureScreen } from '../view/capture.mjs';
import { createViewTarget } from '../view/frame-channel.mjs';
import { startRelayViewTarget } from '../view/relay-target.mjs';
import { viewAllowed } from '../view/consent.mjs';
import { createXferFrameRouter } from '../transfer/router.mjs';
import { joinUrl } from '../url.mjs';
import {
  AGENT_STATE_FILE,
  AGENT_STATE_SCHEMA_VERSION,
  MAX_IMMEDIATE_RESTART_RECONNECTS,
  RECONNECT_DELAY_AFTER_STABLE_MS,
  STABLE_STREAM_MS,
  STATE_RENAME_ATTEMPTS,
  STATE_RENAME_BACKOFF_MS,
  SseParser,
  backoffDelay,
  cursorUsableFor,
  heartbeatDiagnostics,
  parseP2PFrame,
  sleep,
  summarizeRtt,
} from './shared.mjs';

/**
 * Build the viewer warm-up's WebRTC prepare callback.
 *
 * P3 late binding: the production root row mounts before `dsh-p2p-webrtc` publishes its shared
 * pool. Resolving the pool on every viewer request (rather than capturing it when the heartbeat
 * phase starts) is what lets the remote-desktop warm-up use that same pool once it appears. The
 * injected getter is the composition root's only WebRTC knowledge; the agent layer never imports
 * the plugin registry. When no getter is supplied, the legacy fixed `deps.webrtcPool` remains the
 * fallback so isolated agent tests keep their old contract.
 *
 * @param {object} deps
 * @param {() => object|null} [deps.getWebRtcPool]
 * @param {object|null} [deps.webrtcPool]
 * @param {() => {owner?: string|null}|null} [deps.getWebRtcPoolState]
 */
export function createViewWebRtcPrepare(deps = {}) {
  const resolvePool =
    typeof deps.getWebRtcPool === 'function'
      ? deps.getWebRtcPool
      : () => deps.webrtcPool ?? null;
  const resolveOwner =
    typeof deps.getWebRtcPoolState === 'function'
      ? () => deps.getWebRtcPoolState()?.owner ?? null
      : () => null;
  return async (viewerMachineId) => {
    let pool = null;
    try {
      pool = resolvePool();
    } catch (error) {
      return {
        ok: false,
        code: 'WEBRTC_POOL_UNAVAILABLE',
        detail: `WebRTC pool getter failed: ${error instanceof Error ? error.message : String(error)}`,
        pool_owner: null,
      };
    }
    if (pool === null || typeof pool?.prepare !== 'function') {
      return {
        ok: false,
        code: 'WEBRTC_POOL_UNAVAILABLE',
        detail: 'this host has no shared WebRTC pool',
        pool_owner: resolveOwner(),
      };
    }
    try {
      const prepared = await pool.prepare(viewerMachineId);
      if (prepared === null || typeof prepared !== 'object') return prepared;
      return { ...prepared, pool_owner: prepared.pool_owner ?? resolveOwner() };
    } catch (error) {
      return {
        ok: false,
        code: 'WEBRTC_PREPARE_FAILED',
        detail: error instanceof Error ? error.message : String(error),
        pool_owner: resolveOwner(),
      };
    }
  };
}

/**
 * @param {object} deps The composition bag assembled by `createAgent()`.
 */
export function createHeartbeatPhase(deps) {
  const {
    log,
    identity,
    caps,
    state,
    stateFilePath,
    project,
    stateDir,
    baseUrl,
    fetchImpl,
    once,
    onceIdleMs,
    statePublishIntervalMs,
    idleHeartbeatIntervalMs,
    allowedCommands,
    p2pMode,
    peerKeys,
  } = deps;
  const { postJson, signingHeaders } = deps.http;
  const {
    closeP2P,
    startP2P,
    p2pStatusSnapshot,
    flushSpool,
    reportInterrupted,
    settleResultAck,
    rememberChannel,
    rememberChannelEncryption,
  } = deps.deliver;
  const { enqueue, cancelTask, abortRun, stopLeaseHeartbeat } = deps.offer;

  const token = () => identity.device_token;

  /**
   * Block the current thread for a few milliseconds.
   *
   * Only for {@link renameStateFile}'s backoff, and only on the failing path: `publishState()` is
   * synchronous by design (an async publish would need a queue to keep two publishes from
   * interleaving), and `Atomics.wait` on a throwaway shared buffer is the one way to wait without
   * either a busy loop or an async boundary. There is no `await` here to yield at, and each wait is
   * a handful of milliseconds.
   *
   * @param {number} ms
   */
  function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  /** Is this rename failure the transient Windows-contention kind, rather than a real one? */
  function isRetryableRenameError(error) {
    const code = error?.code;
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
  }

  /**
   * `renameSync` over the state file, retried briefly while the failure is transient.
   *
   * See {@link STATE_RENAME_ATTEMPTS} for why this exists at all. Only a retryable error is retried
   * and only a bounded number of times, so the caller's "never throws" contract is preserved: the
   * last error is rethrown for a permanent failure, exactly as a bare `renameSync` would have.
   *
   * @param {string} from The temp file this call created.
   * @param {string} to The published path.
   * @returns {number} The 1-based attempt that succeeded (a caller-visible fact for tests).
   */
  function renameStateFile(from, to) {
    /** @type {unknown} */
    let lastError = null;
    for (let attempt = 1; attempt <= STATE_RENAME_ATTEMPTS; attempt += 1) {
      try {
        renameSync(from, to);
        return attempt;
      } catch (error) {
        lastError = error;
        if (attempt === STATE_RENAME_ATTEMPTS || !isRetryableRenameError(error)) throw error;
        sleepSync(STATE_RENAME_BACKOFF_MS * attempt);
      }
    }
    // Unreachable: the loop either returns or throws. Kept so a future edit cannot make this
    // function fall off the end and return `undefined` to a caller that expects a count.
    throw lastError;
  }

  let statePublishWarned = false;

  let streamAbort = null;
/** Set when the current attach attempt parsed the relay's `ready` frame. */
let attemptAttached = false;

  /** Consecutive unstable reconnects; drives the backoff ladder (§8.1). */
  let reconnectAttempt = 0;
  /**
   * Consecutive immediate re-attaches caused by a relay identity change. Capped
   * so a relay that cannot keep a stable identity degrades to plain backoff
   * instead of a hot loop.
   */
  let restartReconnects = 0;
  /**
   * What the current stream was opened with, so `ready` can tell whether the
   * events on it are complete. `seq: null` means no cursor was sent, i.e. this
   * stream starts from the relay's own beginning and is never "tainted".
   *
   * @type {{seq: number|null, attributionRelayId: string|null}}
   */
  let attachInfo = { seq: null, attributionRelayId: null };
  /** @type {NodeJS.Timeout|null} Idle refresh of the diagnostics file. */
  let statePublishTimer = null;
  /** @type {NodeJS.Timeout|null} Idle diagnostic heartbeat (v0.3.0). */
  let idleHeartbeatTimer = null;

  /** P0-a: xfer.* frames arriving on a P2P channel are routed here, not to task dispatch. */
  const xferRouter = createXferFrameRouter();
  let viewTargets = null;
  let viewRelayRunner = null;

  // -- Cross-process diagnostics file (task-16) ----------------------------

  /**
   * Snapshot published to `<stateDir>/agent-state.json`.
   *
   * An allow-list, not a spread of internal state: the plugin reads this
   * cross-process, so the only safe rule is that a field must be named here to
   * exist. No token -- device or operator -- can ever appear, because neither
   * is referenced.
   *
   * @returns {object}
   */
  function agentStateSnapshot() {
    return {
      schema_version: AGENT_STATE_SCHEMA_VERSION,
      machine_id: identity.machine_id,
      machine_name: identity.machine_name ?? null,
      updated_at: new Date().toISOString(),
      connected: state.connected === true,
      relay_id: state.relayId ?? null,
      rttMs: {
        last: state.rttMs.last,
        avg: state.rttMs.avg,
        samples: [...state.rttMs.samples],
      },
      // Named to match the heartbeat field (and to stay distinct from the
      // relay's own `reconnect_attempts`, which answers a different question).
      unstable_reconnects: reconnectAttempt,
      replay_truncated: state.replayTruncated !== null,
      // v0.4.0: the direct path's facts, so a plugin on another host can answer "which path is this
      // machine actually using?" without asking the agent process. A summarised shape on purpose --
      // the candidate list and the reflexive address are available in-process from `agent.p2p`.
      p2p: p2pSummary(),
    };
  }

  /**
   * The published (cross-process) subset of the P2P facts.
   *
   * Deliberately not the whole {@link p2pStatusSnapshot}: this is written to disk and read by a
   * plugin in another process, so it names a fixed set of fields rather than mirroring whatever
   * the node happens to expose.
   *
   * @returns {object}
   */
  function p2pSummary() {
    const snapshot = p2pStatusSnapshot();
    return {
      mode: snapshot.mode,
      enabled: snapshot.enabled,
      running: snapshot.running,
      mapping: snapshot.mapping,
      reflexive: snapshot.reflexive,
      candidates: snapshot.candidates.length,
      announced_at: snapshot.announced_at,
      punches_out: snapshot.punches_out,
      punches_in: snapshot.punches_in,
      dial_failures: snapshot.dial_failures,
      channels: snapshot.channels,
      last_error: snapshot.last_error,
    };
  }

  /**
   * Atomically publish the snapshot: temp file in the same directory, then
   * rename, so a reader never sees half a JSON document.
   *
   * Never throws. A full disk or a state directory that vanished must not take
   * the agent (or a running task) down -- the file is a diagnostic, not a
   * delivery guarantee -- so failure is logged once and otherwise ignored.
   *
   * v0.5.10 adds the two halves of "the temp file is ours to clean up": the rename is retried
   * briefly (see {@link renameStateFile}), and a publish that fails outright unlinks its own temp
   * file. Before that, every failed rename left a `agent-state.json.tmp-*` behind, and a live state
   * directory that could not rename for a few hours had accumulated 266 of them / 187 KB with the
   * agent still warning once and carrying on.
   *
   * @returns {object|null} The snapshot written, or null when the write failed.
   */
  function publishState() {
    const snapshot = agentStateSnapshot();
    /** @type {string|null} The temp file this call created; null once it has been renamed away. */
    let tmp = null;
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      tmp = `${stateFilePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      const attempts = renameStateFile(tmp, stateFilePath);
      // Renamed: the temp name is gone, so the catch below must not be handed it.
      tmp = null;
      if (attempts > 1) {
        // Named, not silent: contention on this path was invisible before v0.5.10, and the only
        // trace of it was a growing pile of temp files. One line per publish that needed a retry
        // is the evidence an operator needs to recognise "something is holding the state file".
        log('info', `published ${AGENT_STATE_FILE} after ${attempts} rename attempts`, {
          path: stateFilePath,
        });
      }
      state.statePublishedAt = snapshot.updated_at;
      statePublishWarned = false;
      return snapshot;
    } catch (error) {
      // A publish that failed is a publish whose temp file must not survive it. The unlink is
      // itself best-effort and never rethrows: this function's contract is "never throws", and the
      // file it is trying to remove is by definition one nobody wants.
      if (tmp !== null) {
        try {
          unlinkSync(tmp);
        } catch {
          /* already gone, or the directory is unwritable -- nothing left to do here */
        }
      }
      if (!statePublishWarned) {
        statePublishWarned = true;
        log('warn', `could not publish ${AGENT_STATE_FILE} (diagnostics only; continuing)`, {
          path: stateFilePath,
          error: error?.message ?? String(error),
        });
      }
      return null;
    }
  }

  /**
   * Fold one heartbeat round trip into the rolling window (§8.2).
   *
   * Exposed as `state.rttMs` for `w2m_status`; deliberately *not* added to the
   * result envelope, which must stay comparable across machines.
   *
   * @param {number} ms
   */
  function recordRtt(ms) {
    state.rttMs = summarizeRtt([...state.rttMs.samples, ms]);
    // Publish on every successful heartbeat: this is the moment the numbers a
    // remote operator cares about actually changed (task-16).
    publishState();
  }

  // -- SSE -----------------------------------------------------------------

  /** Open the event stream and dispatch until it ends or we stop. */
  async function streamOnce() {
    const headers = { accept: 'text/event-stream' };
    if (token()) headers.authorization = `Bearer ${token()}`;
    // Decide *before* connecting whether the cursor may be replayed: sending a
    // stale one is what makes a restarted relay believe we are already caught
    // up (task-18). Built by concatenation so a relay mounted under a sub-path
    // (https://host/w2m) keeps its prefix -- see ./url.mjs.
    const resume = cursorUsableFor({
      seq: state.seq,
      cursorRelayId: state.cursorRelayId,
      relayId: state.relayId,
    });
    const query = new URLSearchParams();
    query.set('machine_id', identity.machine_id);
    if (resume) {
      headers['last-event-id'] = String(state.seq);
      query.set('seq', String(state.seq + 1));
    }
    // Remembered so `ready` can decide whether this stream is trustworthy.
    attachInfo = { seq: resume ? state.seq : null, attributionRelayId: resume ? state.cursorRelayId : null };
    log('info', 'attaching to event stream', {
      from_seq: resume ? state.seq + 1 : null,
      cursor: resume ? state.seq : null,
      cursor_relay_id: resume ? state.cursorRelayId : null,
      relay_id: state.relayId,
      withheld_cursor: !resume && state.seq > 0,
    });
    const streamUrl = joinUrl(baseUrl, `/v1/stream?${query.toString()}`);
    // Signed once, at attach time, over the *API* path including its query: a
    // long-lived GET has no body, so the query (machine_id, and the resume seq
    // when we have a cursor) is the part of the request that must be bound.
    // Signing only the pathname is the classic mistake -- the tests prove such a
    // signature does not verify -- and signing the base-prefixed wire path would
    // break the "proxy strips the prefix" deployment (see signingHeaders).
    Object.assign(headers, signingHeaders('GET', `/v1/stream?${query.toString()}`));

    // Header deadline: a proxy that accepts the socket but never returns headers must not hang the
    // agent forever. Node >= 20.19 has AbortSignal.any, and every other HTTP call in the tree already
    // carries a timeout.
    //
    // The deadline must end when the headers arrive. A signal handed to `fetch` also covers the
    // response *body*, so `AbortSignal.timeout()` in the combined signal would abort a healthy
    // long-lived SSE stream once the deadline passed -- every stream would be torn down mid-body and
    // re-attached, and a frame written in that window would be lost. The body is bounded by the
    // watchdog below and by `stop()` instead, so the timer is cleared as soon as `fetch` settles.
    const headerTimeoutMs = Number(process.env.W2M_SSE_FIRST_FRAME_MS) > 0 ? Number(process.env.W2M_SSE_FIRST_FRAME_MS) : 5000;
    const headerAbort = new AbortController();
    const headerTimer = setTimeout(() => headerAbort.abort(), headerTimeoutMs);
    if (typeof headerTimer.unref === 'function') headerTimer.unref();
    const headerSignal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([streamAbort.signal, headerAbort.signal])
      : streamAbort.signal;
    let response;
    try {
      response = await fetchImpl(streamUrl, { headers, signal: headerSignal });
    } catch (error) {
      if (streamAbort.signal.aborted) throw error;
      const timeout = new Error('SSE_FIRST_FRAME_TIMEOUT');
      timeout.code = 'SSE_FIRST_FRAME_TIMEOUT';
      state.lastRelayError = { at: new Date().toISOString(), http_status: null, code: timeout.code, path: '/v1/stream' };
      publishState();
      throw timeout;
    } finally {
      // Never leave this armed: it is a header deadline, not a stream deadline.
      clearTimeout(headerTimer);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let code = null;
      try {
        code = JSON.parse(body)?.error?.code ?? null;
      } catch {
        code = null;
      }
      const error = new Error(`stream HTTP ${response.status} ${body.slice(0, 200)}`.trim());
      // Preserve the relay's own code (SIGNATURE_REQUIRED, SIGNATURE_EXPIRED,  - 
      // so a signed link can be diagnosed without guessing.
      error.code = code ?? `HTTP_${response.status}`;
      state.lastRelayError = {
        at: new Date().toISOString(),
        http_status: response.status,
        code: error.code,
        path: '/v1/stream',
      };
      throw error;    }
    if (!response.body) throw new Error('stream response had no body');

    // P0-f: two deadlines on the stream this attempt. A half-open connection must not look
    // like a healthy one forever; the relay keepalive is 15 s, so 45 s is three missed beats.
    const envMs = (name) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : undefined);
    let timeoutCode = null;
    let source = null;
    const watchdog = createSseWatchdog({
      firstFrameMs: envMs('W2M_SSE_FIRST_FRAME_MS'),
      idleMs: envMs('W2M_SSE_IDLE_MS'),
      onTimeout: (code) => {
        timeoutCode = code;
        state.lastRelayError = { at: new Date().toISOString(), http_status: null, code, path: '/v1/stream' };
        publishState();
        const error = new Error(code);
        error.code = code;
        try { source?.destroy(error); } catch { /* already gone */ }
      },
    });

    // Both assignments mark the same stream attempt as no longer live: one before the read loop, one
    // after it ends. Only one stream runs at a time, so there is nothing to interleave with.
    // eslint-disable-next-line require-atomic-updates -- one stream attempt at a time
    state.connected = false;
    const decoder = new TextDecoder('utf-8');
    const parser = new SseParser();
    source = Readable.fromWeb(response.body);

    try {
      for await (const chunk of source) {
        if (state.stopped) break;
        watchdog.noteBytes();
        for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
          watchdog.noteFrame();
          handleFrame(frame);
        }
      }
    } catch (error) {
      if (timeoutCode !== null) {
        const timeout = new Error(timeoutCode);
        timeout.code = timeoutCode;
        log('warn', 'event stream watchdog fired; reconnecting', { code: timeoutCode });
        throw timeout;
      }
      throw error;
    } finally {
      watchdog.dispose();
    }
    state.connected = false;
    publishState();
  }

  /**
   * Decode one SSE frame and dispatch it.
   *
   * A thin wrapper on purpose (v0.4.0): the dispatch itself is `dispatchFrame`, so an SSE frame and
   * a JSON frame off a P2P channel reach *the same* handler. The alternative -- a second switch for
   * the direct path -- is how "the offer runs over either transport" quietly becomes "the offer
   * runs over the relay, and something almost like it runs over the channel".
   *
   * @param {{event: string, data: string, id: string|null}} frame
   */
  function handleFrame(frame) {
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      log('warn', 'ignoring unparseable SSE frame', { event: frame.event, data: frame.data.slice(0, 120) });
      return;
    }
    dispatchFrame(payload, { event: frame.event, id: frame.id ?? null, transport: 'relay' });
  }

  /**
   * One message arrived on a P2P channel.
   *
   * The body is a frame, not an offer: the W2M convention is the relay's own frame shape
   * (`{type:'task.offer', ...}`), so it is parsed with {@link parseP2PFrame} and then dispatched
   * exactly like an SSE frame would be.
   *
   * @param {{from: string|null, channel: object, peer: object, session: number, payload: unknown}} event
   */
  function handleP2PMessage(event) {
    const payload = parseP2PFrame(event.payload);
    if (payload !== null && typeof payload.type === 'string' && payload.type.startsWith('xfer.')) {
      xferRouter.handle(payload, { channel: event.channel });
      return;
    }
    if (payload !== null && typeof payload.type === 'string' && payload.type.startsWith('view.')) {
      // A target owns the VK handshake state, so it must outlive one message:
      // hello, request and stop for the same session share one instance.
      viewTargets ??= new Map();
      const key = String(payload.session_id ?? 'default');
      let target = viewTargets.get(key);
      if (target === undefined || payload.type === 'view.hello') {
        target = createViewTarget({
          capture: (options) => captureScreen({ ...(options ?? {}), fast: true }),
          allow: () => viewAllowed(stateDir),
          send: (frame) => { try { event.channel.send(frame); } catch { /* peer gone */ } },
        });
        viewTargets.set(key, target);
      }
      target.handle(payload);
      return;
    }
    if (payload === null) {
      log('warn', 'ignoring non-JSON frame on a P2P channel', {
        peer: event.peer ?? null,
        session: event.session ?? null,
        bytes: Buffer.isBuffer(event.payload) ? event.payload.length : null,
      });
      return;
    }
    dispatchFrame(payload, { event: payload.type, id: null, transport: 'p2p', channel: event.channel });
  }

  /**
   * The one dispatcher both transports feed.
   *
   * `transport` is the only difference between an offer from the relay and an offer from a channel,
   * and it is stamped onto the offer itself (`p2p_transport`) rather than carried alongside: the
   * dedupe path hands offers to `handleOffer` by reference and drops duplicates before they get
   * there, so the fact has to travel *with* the offer or it would be lost exactly when two copies
   * race -- which is the case it exists for.
   *
   * `state.seq` is advanced for relay frames only. A channel frame carries no `seq` (it never went
   * through the relay's event ring), and letting one move the cursor would make the agent tell the
   * relay it had already seen events it had not.
   *
   * @param {object} payload
   * @param {{event: string, id: string|null, transport: 'p2p'|'relay', channel?: object}} source
   */
  function dispatchFrame(payload, source) {
    const type = payload?.type ?? source.event;
    if (source.transport === 'relay' && shouldAdvanceCursor({ type, event: source.event })) {
      // P0-f: ready/notice carry sequence numbers that never entered the replay ring; adopting one
      // would claim events that were never received and a reconnect would skip the real gap.
      if (Number.isInteger(payload?.seq)) state.seq = Math.max(state.seq, payload.seq);
      else if (source.id && /^\d+$/.test(source.id)) state.seq = Math.max(state.seq, Number(source.id));
    }

    switch (type) {
      case 'ready': {
        // A channel frame with this type is not the relay's `ready`: it is a dispatcher pushing a
        // frame it had no business pushing, and treating it as "connected" would mark an agent with
        // no stream as connected.
        if (source.transport !== 'relay') {
          log('info', 'ignoring a `ready` frame that did not come from the relay');
          break;
        }
        // §3.1: nothing counts as connected before `ready` arrives.
        state.connected = true;
        attemptAttached = true;
        const relayId =
          typeof payload.relay_id === 'string' && payload.relay_id !== '' ? payload.relay_id : null;
        const previousRelayId = state.relayId;
        // A stream is only "tainted" when it was opened *with* a cursor that
        // this relay process never issued. Such a stream has already skipped
        // everything the process emitted before `ready` -- including the
        // `task.offer` at seq 1 -- so it must be dropped and re-attached
        // cursor-less (task-18). A stream opened without a cursor has seen
        // everything from the start and is kept: reconnecting there would be
        // pure churn.
        const tainted =
          attachInfo.seq !== null && relayId !== null && attachInfo.attributionRelayId !== relayId;
        if (tainted) {
          state.relayIdChanges += previousRelayId !== null && previousRelayId !== relayId ? 1 : 0;
          state.seq = 0;
          state.cursorRelayId = null;
          state.relayId = relayId;
          state.streamRestartRequested = true;
          log('warn', `relay restarted (relay_id ${previousRelayId ?? '<unknown>'} -> ${relayId}); discarding seq cursor and re-attaching without one`, {
            previous_relay_id: previousRelayId,
            relay_id: relayId,
            discarded_cursor: attachInfo.seq,
          });
          publishState();
          streamAbort?.abort();
          break;
        }
        if (relayId) state.relayId = relayId;
        // The cursor we hold was issued by this relay, so attribute it: that is
        // what lets a later restart be told apart from a plain reconnect.
        state.cursorRelayId = relayId ?? state.cursorRelayId;
        log('info', 'stream ready', {
          seq: payload.seq,
          protocol_version: payload.protocol_version,
          machine_id: payload.machine_id,
          relay_id: relayId,
        });
        // Connection state changed: make it visible to other processes.
        publishState();
        break;
      }
      case 'task.offer': {
        // The transport travels *on* the offer (see this function's note). Any `p2p_transport` a
        // peer tried to put on the wire is overwritten, so a relay frame can never claim the
        // direct path -- the only thing that sets `'p2p'` here is the channel having delivered it.
        const offer = { ...payload, p2p_transport: source.transport };
        // v0.6.0: the block's `static_keys` is the *entire* key-distribution mechanism  - a machine
        // learns the keys of exactly the peers it was asked to talk to, from the offer that asked it,
        // and never from a config file. Learned here, before the offer is queued, because the reverse
        // dial starts inside `handleOffer` and a key merged any later would miss the handshake this
        // offer exists to enable. A malformed entry is skipped rather than fatal (`merge` says so):
        // one broken key must not cost this machine its ability to punch at all.
        if (offer.p2p !== null && typeof offer.p2p === 'object') {
          const learned = peerKeys.merge(offer.p2p.static_keys, source.transport === 'p2p' ? 'offer' : 'relay');
          if (learned > 0) {
            log('info', `learned ${learned} peer static key(s) from the offer for ${offer.task_id ?? '?'}`);
          }
        }
        if (source.transport === 'p2p') {
          if (typeof offer.task_id !== 'string' || offer.task_id === '') {
            log('warn', 'ignoring a direct offer with no task_id');
            break;
          }
          // Remembered before the offer is queued: the result path must exist by the time the
          // result is produced, and a channel lost between the two would leave `result_path` null
          // with no way to tell why.
          rememberChannel(offer.task_id, source.channel);
          // ...and the *encryption* of that channel, remembered with it for the same reason. The
          // envelope is written after the channel may have been released, so "was this task's direct
          // channel sealed" has to be a fact recorded here rather than read off a live object later.
          rememberChannelEncryption(offer.task_id, source.channel);
        }
        enqueue(offer);
        break;
      }
      case 'task.cancel': {
        cancelTask(payload.task_id, payload.reason);
        break;
      }
      case 'result.ack': {
        // Only meaningful on a channel: an ack the relay relays is not evidence about the direct
        // path, and `result_path` must never be set from it.
        if (source.transport !== 'p2p') {
          log('info', `ignoring result.ack for ${payload.task_id} on the relay path`);
          break;
        }
        settleResultAck(payload.task_id);
        break;
      }
      case 'peer.hello':
        log('info', `peer online: ${payload.machine_name ?? payload.machine_id}`);
        break;
      case 'peer.bye':
        log('info', `peer offline: ${payload.machine_id} (${payload.reason ?? ''})`);
        break;
      case 'notice': {
        log(payload.level === 'error' ? 'error' : 'info', `notice ${payload.code ?? ''}: ${payload.message ?? ''}`);
        if (payload.code === 'REPLAY_TRUNCATED') {
          // v0.1.2 §8.4: the relay tells us the oldest seq it still holds, so we
          // can re-align instead of only learning that we missed events. The
          // cursor moves to `oldest_available_seq - 1` because the next connect
          // asks for `cursor + 1`.
          const oldest = payload.oldest_available_seq;
          if (Number.isInteger(oldest) && oldest >= 1) {
            state.replayTruncated = {
              at: new Date().toISOString(),
              oldest_available_seq: oldest,
              previous_seq: state.seq,
            };
            // A plain assignment, not a `max`: after a restart the new process
            // may hold a *smaller* window than the cursor we arrived with, and
            // aligning downward (even to 0) is the whole point. The aligned
            // cursor belongs to the relay that sent this notice.
            state.seq = oldest - 1;
            state.cursorRelayId = state.relayId ?? state.cursorRelayId;
            log('warn', `replay window truncated; seq cursor aligned to ${state.seq} (next connect asks for ${oldest})`, {
              oldest_available_seq: oldest,
              previous_seq: state.replayTruncated.previous_seq,
            });
            publishState();
          } else {
            log('warn', 'REPLAY_TRUNCATED without a usable oldest_available_seq; cursor left unchanged', {
              oldest_available_seq: oldest ?? null,
            });
          }
        }
        break;
      }
      case 'task.result':
        // Two different frames wear this type. From the relay it is the notice that a result
        // reached Rabbit. From a channel it is a *dispatcher* pushing a result at this agent
        // (machine A's result travelling to machine B directly) -- which this agent does not
        // consume in v0.4.0, and says so rather than pretending it was the relay's notice.
        if (source.transport === 'p2p') {
          log('info', `result for ${payload.task_id} arrived over a direct channel (not consumed by the executor)`, {
            status: payload.status,
          });
          break;
        }
        log('info', `result accepted for ${payload.task_id}`, {
          status: payload.status,
          deduped: payload.deduped === true,
        });
        break;
      default:
        log('info', `ignoring unknown event type ${type}`);
    }
  }

  // -- Lifecycle -----------------------------------------------------------

  /**
   * The idle diagnostic heartbeat (v0.3.0): `POST /v1/heartbeat` with
   * `diagnostic: true` and **no** `task_id`.
   *
   * Three properties matter, and each of them is a way this could go wrong:
   *
   *   1. It holds no lease, so nothing in the response may change local state.
   *      The body is deliberately not inspected -- not even `cancel`, which on a
   *      lease heartbeat means "stop the task". (A relay answering `cancel:
   *      true` here must not stop an idle agent.)
   *   2. It is best effort. A pre-v0.3.0 relay answers 404 because it demands a
   *      `task_id`; that is expected, is logged at debug level, and must never
   *      be retried in a storm, affect a task, or end the process.
   *   3. It is skipped while a task holds the lease: the 10s lease heartbeat is
   *      already reporting, and two cadences reporting the same numbers would
   *      just be noise.
   *
   * A successful round trip *is* a real measurement, so it feeds the same
   * rolling window the lease heartbeat uses -- that is what keeps the relay's
   * view fresh while the machine has nothing to do.
   *
   * @returns {Promise<{status: number, ok: boolean}|null>}
   */
  async function sendIdleHeartbeat() {
    if (state.stopped || state.current) return null;
    if (!token()) return null; // nothing to authenticate with; not worth a 401
    const startedHr = process.hrtime.bigint();
    try {
      const response = await postJson('/v1/heartbeat', {
        diagnostic: true,
        machine_id: identity.machine_id,
        ...(caps === null || caps === undefined ? {} : { caps }),
        ...heartbeatDiagnostics({
          rttMs: state.rttMs,
          reconnectAttempts: state.reconnectAttempts,
        }),
      });
      if (response.ok) {
        // Measured on success only, exactly like the lease heartbeat.
        recordRtt(Number(process.hrtime.bigint() - startedHr) / 1e6);
      } else {
        log('debug', `idle heartbeat rejected (HTTP ${response.status}); diagnostics only, continuing`, {
          body: response.json?.error?.code ?? null,
        });
      }
      return response;
    } catch (error) {
      log('debug', `idle heartbeat failed: ${error?.message ?? String(error)}; diagnostics only, continuing`, {});
      return null;
    }
  }

  /**
   * Start the idle diagnostic cadence. Deliberately does **not** fire
   * immediately: the first beat lands one interval in, so booting an agent
   * stays quiet and a short-lived run produces no diagnostic traffic at all.
   */
  function startIdleHeartbeat() {
    if (idleHeartbeatIntervalMs <= 0 || idleHeartbeatTimer) return;
    idleHeartbeatTimer = setInterval(() => {
      void sendIdleHeartbeat();
    }, idleHeartbeatIntervalMs);
    // A diagnostic must never be the reason the process stays alive.
    if (typeof idleHeartbeatTimer.unref === 'function') idleHeartbeatTimer.unref();
  }

  /**
   * Stop the stream, the running command, the heartbeat and the direct path.
   *
   * Returns a promise so a caller can wait for the node's socket to be gone -- `close()` on the node
   * is asynchronous (it waits for the accept loop to end). Callers that do not care still get the
   * old fire-and-forget behaviour by ignoring the value; `w2m-localside` does not, because "the
   * process exited" and "the port was released" are different facts on Windows.
   *
   * @returns {Promise<void>}
   */
  function stop() {
    if (state.stopped) return Promise.resolve();
    state.stopped = true;
    if (statePublishTimer) clearInterval(statePublishTimer);
    statePublishTimer = null;
    if (idleHeartbeatTimer) clearInterval(idleHeartbeatTimer);
    idleHeartbeatTimer = null;
    stopLeaseHeartbeat();
    viewRelayRunner?.stop();
    viewRelayRunner = null;
    for (const target of viewTargets?.values() ?? []) target?.stop?.();
    viewTargets = null;
    abortRun();
    streamAbort?.abort();
    // Final snapshot: a reader must be able to tell "stopped" from "crashed
    // mid-write", and from "still running but not connected".
    state.connected = false;
    publishState();
    // The node is closed last: it is the only part of `stop()` that is asynchronous, and everything
    // above must already be winding down before a channel can deliver a payload into a stopped agent.
    return closeP2P();
  }

  /**
   * Run forever (or until `--once` has handled one task).
   *
   * @returns {Promise<void>}
   */
  async function start() {
    log('info', `localside ${identity.machine_name} (${identity.machine_id})`, {
      rabbit: baseUrl,
      project,
      state: stateDir,
      allowed_commands: allowedCommands.map((prefix) => prefix.join(' ')),
      p2p_mode: p2pMode,
    });
    if (allowedCommands.length === 0) {
      log('warn', 'no --allowed-commands configured: every offer will be refused (default-deny)');
    }

    // v0.4.0: bring the direct path up first, so a channel exists before the first offer can arrive
    // on one. Failures are recorded, never fatal -- see `startP2P`.
    await startP2P();

    // Publish immediately so the file appears with the agent, not only after
    // the first heartbeat: "is an agent running here?" is the first question a
    // remote operator asks (task-16).
    publishState();
    // The poller always runs; the consent file is checked before a request is consumed and before
    // every frame, so enabling remote viewing in the settings page takes effect without an agent
    // restart. A disabled machine never consumes a viewer request.
    viewRelayRunner = startRelayViewTarget({
      rabbitUrl: baseUrl,
      token: () => identity.device_token,
      machineId: identity.machine_id,
      capture: (options) => captureScreen({ ...(options ?? {}), fast: true }),
      allow: () => viewAllowed(stateDir),
      prepareWebRtc: createViewWebRtcPrepare(deps),
      log,
    });
    if (statePublishIntervalMs > 0) {
      statePublishTimer = setInterval(() => publishState(), statePublishIntervalMs);
      // Never keep the process alive just to refresh a diagnostics file.
      if (typeof statePublishTimer.unref === 'function') statePublishTimer.unref();
    }
    // v0.3.0: keep the relay's view of *this* machine fresh even when it has
    // nothing to do. Best effort by construction -- see sendIdleHeartbeat().
    startIdleHeartbeat();

    if (token()) {
      await flushSpool();
      reportInterrupted();
    } else {
      log('warn', 'no device_token yet: run with --pair <CODE> to pair');
    }

    let idleTimer = null;
    if (once && onceIdleMs > 0) {
      idleTimer = setTimeout(() => {
        if (state.handled === 0) {
          log('warn', `--once: no offer within ${onceIdleMs}ms, exiting`);
          stop();
        }
      }, onceIdleMs);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    }

    try {
      while (!state.stopped) {
        streamAbort = new AbortController();
        state.streamRestartRequested = false;
        const openedAt = Date.now();
        attemptAttached = false;
        /** @type {Error|null} */
        let failure = null;
        try {
          await streamOnce();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        if (state.stopped) break;
        state.connected = false;
        publishState();

        const livedMs = Date.now() - openedAt;
        if (state.streamRestartRequested) {
          // The relay changed identity, so the cursor this stream was opened
          // with is void and the stream itself has already skipped the new
          // process's early events. Re-attach at once, without a cursor: any
          // delay here would widen exactly the window this fix closes.
          state.streamRestartRequested = false;
          restartReconnects += 1;
          if (restartReconnects <= MAX_IMMEDIATE_RESTART_RECONNECTS) {
            reconnectAttempt = 0;
            log('warn', `re-attaching after relay change without a cursor (attempt ${restartReconnects})`, {
              lived_ms: livedMs,
            });
            continue;
          }
          // A relay that keeps changing identity would otherwise spin us; fall
          // through to the normal backoff from here on.
          log('warn', 'relay identity keeps changing; falling back to backoff between attaches', {
            restarts: restartReconnects,
          });
        }

        // A stream that never delivered `ready` is not stable however long the socket lived: the
        // watchdog deadlines are seconds, so the old rule reset the backoff to 500 ms forever.
        const stable = attemptAttached && livedMs >= STABLE_STREAM_MS;
        if (stable) {
          reconnectAttempt = 0;
          restartReconnects = 0;
        }
        // A stream that ends immediately is treated as a failure even when the
        // socket closed cleanly; otherwise a flapping tunnel becomes a hot loop.
        const delay = stable ? RECONNECT_DELAY_AFTER_STABLE_MS : backoffDelay(reconnectAttempt);
        reconnectAttempt += 1;
        const reason = failure
          ? `stream error: ${failure.message}`
          : `event stream closed by server after ${livedMs}ms`;
        // Cross-region debugging needs to answer "is it retrying, how often, and
        // how long until the next try" without attaching a debugger (§8.1).
        log('warn', `${reason}; reconnect #${reconnectAttempt} in ${delay}ms`, {
          attempt: reconnectAttempt,
          delay_ms: delay,
          lived_ms: livedMs,
          stable,
        });
        await sleep(delay, undefined);
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      stop();
      log('info', 'localside stopped', { handled: state.handled });
    }
  }

  return {
    publishState,
    recordRtt,
    sendIdleHeartbeat,
    start,
    stop,
    dispatchFrame,
    handleP2PMessage,
    get reconnectAttempt() {
      return reconnectAttempt;
    },
  };
}
