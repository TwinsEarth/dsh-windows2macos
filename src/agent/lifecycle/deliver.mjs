/**
 * The deliver phase: result-envelope assembly and the relay/P2P delivery path.
 *
 * Owns the direct-transport bookkeeping (node, channels, peers, reverse dials,
 * result acknowledgements) because every one of those facts exists to decide one
 * question -- how a *result* travels -- and owns `finish()`, the seam every
 * terminal path (refusal, maintenance, execute) calls.
 *
 * It is the bottom layer of the phase graph: it receives nothing from `execute`,
 * `offer` or `heartbeat`, and reaches the last one only through `deps` at call
 * time (the node's `message` listener has to be wired inside `configureP2P`, but
 * the handler itself belongs to the stream phase and is not created yet when this
 * factory runs).
 *
 * No module-level mutable state: everything lives inside the factory.
 */

import { sign as signBytes } from 'node:crypto';

import { EMPTY_SHA256, normalizeOutput, sha256Hex } from '../exec.mjs';
import {
  FINGERPRINT_ALGO,
  WARN_FINGERPRINT_UNAVAILABLE,
  collectPostState,
  commandHash,
  normalizeRelPath,
  pipelineCommandHash,
} from '../git.mjs';
import { MEMORY_FILE, appendMemory, memoryRecord } from '../memory.mjs';
import { redactEnvelope } from '../../util/redact.mjs';
import { canonicalSignedPayload } from '../../util/envelope-signature.mjs';
import { CRYPTO_REASON, deriveSigningKey } from '../crypto.mjs';
import { P2P_DEFAULTS, P2PNode } from '../p2p-node.mjs';
import { punchSession, reverseDialSession } from '../p2p.mjs';
import {
  ENVELOPE_VERSION,
  P2P_CHANNEL_LIVE,
  P2P_OPENED_BY,
  P2P_REVERSE_DIAL_FAILED,
  P2P_REVERSE_DIAL_TIMEOUT,
  SHELL_ID,
  buildEnvelope,
  identityKeyFor,
  offerTransportOf,
  p2pDeliveryMark,
} from './shared.mjs';

/**
 * @param {object} deps The composition bag assembled by `createAgent()`.
 */
export function createDeliverPhase(deps) {
  const {
    log,
    identity,
    platform,
    caps,
    state,
    spool,
    stateDir,
    project,
    baseUrl,
    options,
    p2pMode,
    deviceKey,
    deviceKeyError,
    deviceKeyMigratedFrom,
    peerKeys,
    onP2PStatus,
    p2pPort,
    p2pPortError,
    p2pAckTimeoutMs,
    p2pChannelLingerMs,
    redactOutput,
    tmpDir,
    objectMode,
    toolchainInfo,
  } = deps;
  const { postJson, postJsonWithRetry, relayErrorCode, getJson } = deps.http;

  // -- P2P transport (v0.4.0) ----------------------------------------------
  //
  // Everything the direct path owns lives in these few bindings, and the shape is deliberate:
  // the agent does not *have* a P2P stack, it *borrows* one node and treats every failure as a
  // reportable fact. `p2pMode: 'relay'` leaves the whole block inert -- `configureP2P()` never
  // constructs a node, so no UDP socket exists and no STUN server is ever queried, which is what
  // makes the setting a mechanical statement ("this machine is exactly v0.3.9") rather than a
  // promise about behaviour.

  /** @type {P2PNode|null} The node, once one exists. Null in `relay` mode, forever. */
  let p2pNode = null;
  /** @type {Promise<object>|null} In-flight start, so `stop()` can await it. */
  let p2pStarting = null;
  /** @type {object|null} Start outcome, so the status can report *why* the node is not running. */
  let p2pStartResult = null;
  /** @type {object|null} Last snapshot handed to `onP2PStatus`, so a no-op change is not pushed. */
  let lastP2PStatusJson = null;


  /**
   * What each task's direct channel actually was, for the result envelope.
   *
   * Keyed by `task_id`, alongside the channel map rather than on the channel itself, because the
   * envelope is built *after* `planDirectDelivery` may have released the channel  - and
   * `p2p.encrypted` has to describe the channel that carried this attempt, not whichever channel
   * happens to be live when the envelope is written.
   *
   * @type {Map<string, {encrypted: boolean, reason: string|null, session: number|null, epoch: number}>}
   */
  const p2pEncryption = new Map();

  /**
   * Result envelopes awaiting a `result.ack` over a direct channel.
   *
   * Keyed by `task_id` (one result per task and attempt is the whole point of the dedupe work), so
   * a late ack for a re-delivered attempt resolves the live waiter rather than a stale one.
   *
   * @type {Map<string, {settle: (acked: boolean, error: string|null) => void}>}
   */
  const p2pResultWaiters = new Map();

  // -- WebRTC result path (v3.5.8) -----------------------------------------
  //
  // The pool is injected by the composition root, because one process must have exactly one pool
  // per machine: two pools on the same machine id would claim the same `host`/`client` room slot and
  // fight over every pair. `planDirectDelivery` therefore *borrows* it exactly as the UDP path
  // borrows its node.
  //
  // The result notice is a small control frame, not the envelope. The envelope is still posted to the
  // relay unconditionally; WebRTC is the preferred *data plane* for the direct copy, and the relay
  // remains the ledger. That distinction is why a WebRTC failure can never lose a result and why the
  // 33-attempt cap below never turns into "the result was dropped".
  const webrtcPool = options.webrtcPool ?? null;
  const webrtcDataMaxAttempts =
    Number.isInteger(options.webrtcDataMaxAttempts) && options.webrtcDataMaxAttempts > 0
      ? options.webrtcDataMaxAttempts
      : 33;
  const webrtcAckTimeoutMs =
    Number.isFinite(options.webrtcAckTimeoutMs) && options.webrtcAckTimeoutMs > 0
      ? options.webrtcAckTimeoutMs
      : 500;
  const webrtcRetryDelayMs =
    Number.isFinite(options.webrtcRetryDelayMs) && options.webrtcRetryDelayMs >= 0
      ? options.webrtcRetryDelayMs
      : 100;
  const webrtcResultBudgetMs =
    Number.isFinite(options.webrtcResultBudgetMs) && options.webrtcResultBudgetMs > 0
      ? options.webrtcResultBudgetMs
      : 5_000;
  const webrtcStats = {
    enabled: webrtcPool !== null,
    attempts: 0,
    delivered: 0,
    failed: 0,
    last_error: null,
    last_at: null,
  };
  /** @type {(() => void)|null} */
  let webrtcUnsubscribe = null;
  /**
   * Per-task channel adapters for offers that arrived over WebRTC.
   *
   * The heartbeat and the result path both speak the UDP channel contract (`send`, `on('close')`,
   * `encryption`). An adapter that forwards `send` to the pool lets those paths stay unchanged while
   * the facts in the envelope (`offer_path`, `encrypted`) describe what actually happened.
   *
   * @type {Map<string, object>}
   */
  const webrtcChannels = new Map();

  /**
   * Live channels per `task_id`, for the direct result copy *and* for knowing which tasks the
   * dispatcher can already reach us about. Populated only from a `task.offer` that arrived on a
   * channel: a channel that was opened but never used for an offer has no task to be the result of.
   *
   * `onClose` is the listener attached to the channel, kept here so a channel replaced for the
   * same task can have its old listener removed instead of leaking one per re-punch.
   *
   * @type {Map<string, {channel: object, onClose: () => void}>}
   */
  const p2pChannels = new Map();

  /**
   * The dispatcher address a task's channel actually travels to, remembered past the channel.
   *
   * This is the *observed* address for a channel that arrived inbound (`accept()` answers to the
   * `rinfo` of the HELLO it received, never to the address that peer announced) and the punched
   * address for one this agent opened. It outlives the channel on purpose: when the dispatcher
   * closes the channel it pushed the offer over -- which it does, right after the offer -- the
   * result still has somewhere to go, and the observed address is the one address a symmetric NAT
   * on the dispatcher's side is still holding a mapping for. Retyping the announced candidate
   * instead is the punch that already failed.
   *
   * @type {Map<string, {address: string, port: number}>}
   */
  const p2pPeers = new Map();

  /**
   * One reverse-dial attempt per `task_id`  - the executor's own half of a two-way punch.
   *
   * A record exists for every offer this agent takes on, including the ones it decides *not* to
   * dial for, and that is deliberate: "we did not try, because a channel was already live" and "we
   * tried and it timed out" must be distinguishable at result time, and a missing record must not
   * silently mean a second attempt. `promise` settles when the dial is over; it is awaited by the
   * result path (bounded by the same tuning window), never by the offer path.
   *
   * @type {Map<string, {task_id: string, attempted: boolean, ok: boolean, code: string|null,
   *   reason: string|null, stage: 'offer'|'result', session: number|null, candidates: number,
   *   channel: object|null, promise: Promise<object>|null, ms: number|null}>}
   */
  const p2pReverseDials = new Map();

  /**
   * How long this agent may spend dialling a dispatcher, from the node's own tuning.
   *
   * Read from the node rather than fixed here so the number lives beside `punchTimeoutMs` and
   * `acceptTimeoutMs`: an operator tuning a slow path tunes one object, and a test that cannot wait
   * eight seconds injects one.
   */
  function reverseDialTimeoutMs() {
    const configured = p2pNode?.tuning?.reverseDialTimeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : P2P_DEFAULTS.reverseDialTimeoutMs;
  }

  /** The agent's WebRTC pool facts, always a fresh plain object. */
  function webrtcStatusSnapshot() {
    const diagnostics = typeof webrtcPool?.diagnostics === 'function' ? webrtcPool.diagnostics() : null;
    return {
      enabled: webrtcPool !== null,
      available: diagnostics?.ok === true,
      signal_url: diagnostics?.signal_url ?? null,
      peer_count: diagnostics?.peer_count ?? 0,
      peers: diagnostics?.peers ?? [],
      stats: { ...webrtcStats, ...(diagnostics?.stats ?? {}) },
      policy: {
        role: 'preferred-direct-result',
        relay: 'ledger-always',
        data_max_attempts: webrtcDataMaxAttempts,
        ack_timeout_ms: webrtcAckTimeoutMs,
        result_budget_ms: webrtcResultBudgetMs,
      },
      last_error: webrtcStats.last_error ?? null,
    };
  }

  /** The agent's P2P facts, always a fresh plain object. */
  function p2pStatusSnapshot() {
    const nodeStatus = p2pNode?.status ?? null;
    const startError = p2pStartResult?.ok === false ? p2pStartResult.error ?? null : null;
    return {
      mode: p2pMode,
      enabled: p2pMode !== 'relay',
      running: nodeStatus?.running === true,
      machine_id: identity.machine_id,
      rabbit_url: baseUrl,
      local: nodeStatus?.local ?? null,
      reflexive: nodeStatus?.reflexive ?? null,
      mapping: nodeStatus?.mapping ?? null,
      candidates: nodeStatus?.candidates ?? [],
      announced_at: nodeStatus?.announced_at ?? null,
      announce_ok: nodeStatus?.announce_ok === true,
      announce_failures: nodeStatus?.announce_failures ?? 0,
      last_announce_error: nodeStatus?.last_announce_error ?? null,
      punches_out: nodeStatus?.punches_out ?? 0,
      punches_in: nodeStatus?.punches_in ?? 0,
      dial_failures: nodeStatus?.dial_failures ?? 0,
      encryption: {
        enabled: deviceKey !== null,
        public_key: deviceKey === null ? null : deviceKey.publicKeyBase64,
        error: deviceKeyError,
        peers_known: peerKeys.size,
        encrypted_channels: nodeStatus?.encryption?.encrypted_channels ?? 0,
        plaintext_channels: nodeStatus?.encryption?.plaintext_channels ?? 0,
        handshakes: nodeStatus?.encryption?.handshakes ?? 0,
        refused: nodeStatus?.encryption?.refused ?? 0,
        refusals: nodeStatus?.encryption?.refusals ?? [],
      },
      channels: p2pChannels.size,
      webrtc: webrtcStatusSnapshot(),
      start_error: startError,
      last_error: startError ?? nodeStatus?.last_error ?? null,
    };
  }

  /**
   * Push the current facts to `onP2PStatus`, but only when they actually changed.
   *
   * Deduplicated on the serialised snapshot: `publishState()` runs on every heartbeat and an
   * unconditional push would turn a 10s cadence into a stream of identical callbacks. The
   * comparison is on JSON, not on object identity, because every read builds a new object by
   * design (no caller may hold a reference into the agent's state).
   */
  function refreshP2PStatus() {
    const snapshot = p2pStatusSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === lastP2PStatusJson) return snapshot;
    lastP2PStatusJson = json;
    try {
      onP2PStatus(snapshot);
    } catch (error) {
      // A diagnostic consumer that throws must not cost the agent anything: the callback belongs
      // to a *reader* (the plugin), and "the reporter is broken" is not a transport failure.
      log('warn', 'onP2PStatus threw; P2P status is still in state.p2p', {
        error: error?.message ?? String(error),
      });
    }
    return snapshot;
  }

  /**
   * Build (but do not start) the node, unless the mode says there is no direct path.
   *
   * A node the caller injected is adopted as-is -- including its mode, which is why an injected
   * node and `p2pMode` disagreeing is logged rather than silently resolved: the injected node is
   * the one that would actually bind a socket, so it is the one that decides, and a caller
   * comparing the two configuration surfaces deserves to know they are not the same thing.
   */
  function configureP2P() {    if (p2pMode === 'relay') return;
    if (p2pNode !== null) return;
    if (p2pPortError !== null) {
      // Loud, and before anything is built. `relay` mode above is deliberately checked first: an
      // operator who asked for no direct path at all should not be told about a port that would
      // never be bound.
      p2pStartResult = { ok: false, enabled: true, error: p2pPortError };
      log('error', 'refusing to build the P2P node with an unusable p2pPort; the relay path is unaffected', {
        error: p2pPortError,
      });
      return;
    }

    const injected = options.p2pNode ?? null;
    const extra = options.p2pNodeOptions ?? {};
    const derived = {
      mode: p2pMode,
      rabbitUrl: baseUrl,
      machineId: identity.machine_id,
      postJson: (path, body) => postJson(path, body),
      getJson: (path) => getJson(path),
      ...(options.stunServers === undefined ? {} : { stunServers: options.stunServers }),
      log: (line) => log('info', line, {}),
      ...extra,
      // After `extra`, so the *validated* named option is the one that decides: `p2pNodeOptions` is
      // an escape hatch for the node's other constructor options, and letting an unvalidated
      // `bindPort` there silently win would route around the check above.
      ...(p2pPort === null ? {} : { bindPort: p2pPort }),
      // Also after `extra`, and for the same reason: the device key and the peer-key store are this
      // agent's identity and its view of its peers, and an escape hatch that could substitute either
      // one would be a way to run an agent that cannot be authenticated by the machine that dialled
      // it. Omitted entirely when there is no key, so the node is exactly a v0.5.x node.
      ...(deviceKey === null ? {} : { deviceKey }),
      peerKeys,
    };

    try {
      if (typeof injected === 'function') {
        p2pNode = injected(derived);
      } else if (injected !== null && typeof injected === 'object') {
        p2pNode = injected;
        if (p2pNode.mode !== p2pMode) {
          log('warn', 'injected p2pNode mode differs from p2pMode; the node decides', {
            p2pMode,
            node_mode: p2pNode.mode,
          });
        }
      } else {
        p2pNode = new P2PNode(derived);
      }
    } catch (error) {
      // Never fatal, for the same reason as a failed start: a machine whose P2P configuration is
      // wrong must still work over the relay.
      p2pStartResult = {
        ok: false,
        enabled: p2pMode !== 'relay',
        error: `P2P_NODE_INVALID: ${error?.message ?? String(error)}`,
      };
      log('error', 'could not build the P2P node; the relay path is unaffected', {
        error: p2pStartResult.error,
      });
      return;
    }

    p2pNode.on('message', (event) => deps.heartbeat.handleP2PMessage(event));
    // `'announce'` is the only event that changes the facts a reader cares about between
    // heartbeats, so it is what refreshes the published status.
    p2pNode.on('announce', () => refreshP2PStatus());
    // Deliberately after `configureP2P`: a node so broken it binds twice is the *only* thing this
    // catches, and it is a bug in the node rather than anything the agent can recover from.
    p2pNode.on('error', (error) => {
      log('warn', `p2p: ${error?.message ?? String(error)}`, {});
    });
  }

  /**
   * Bring the direct path up. Failures are recorded, never thrown.
   *
   * The guard is the whole point: a machine that cannot punch (no UDP egress, a symmetric NAT, an
   * unreachable relay route from `POST /v1/peer/announce`) is still a working W2M machine, because
   * the relay is always still there. An agent that refused to start because a *fast path* was
   * unavailable would have turned an optimisation into a new failure mode.
   *
   * @returns {Promise<{ok: boolean, enabled: boolean, error: string|null}>}
   */
  async function startP2P() {
    // WebRTC is its own data plane: attach even in `relay` mode, because a Teams data plane or a
    // WebRTC result path does not depend on the UDP socket being enabled.
    attachWebRtc();
    if (p2pMode === 'relay') return { ok: true, enabled: false, error: null };
    configureP2P();
    if (p2pNode === null) return p2pStartResult ?? { ok: false, enabled: true, error: 'P2P_NODE_INVALID' };
    if (p2pStarting !== null) return p2pStarting;

    const started = (async () => {
      let result;
      try {
        result = await p2pNode.start();
      } catch (error) {
        result = { ok: false, enabled: true, error: `P2P_START_THREW: ${error?.message ?? String(error)}` };
      }
      p2pStartResult = result;
      log(result.ok ? 'info' : 'warn', `p2p ${p2pMode}: ${result.ok ? 'node started' : 'node did not start'}`, {
        error: result.error ?? null,
      });
      // v0.6.2: a key adopted from the pre-fix location. Said out loud because the public key is what
      // a peer authenticates this machine by, and a silent move would look like a peer going deaf.
      if (deviceKeyMigratedFrom !== null) {
        log('warn', 'p2p: adopting a device key from the old --state location', {
          from: deviceKeyMigratedFrom,
          public_key: deviceKey === null ? null : deviceKey.publicKeyBase64,
          note: 'v0.6.2 moved device.key beside device.json; delete the old file once every peer has seen the new announcement',
        });
      }
      refreshP2PStatus();
      return result;
    })();
    p2pStarting = started;

    try {
      return await started;
    } finally {
      // Only the caller that owns the in-flight start clears it. Clearing unconditionally would be
      // safe today (the promise is shared and idempotent) but would break the moment a second start
      // could begin while the first was still running.
      if (p2pStarting === started) p2pStarting = null;
    }
  }

  /** Stop the node and let go of every channel. Idempotent and awaitable. */
  async function closeP2P() {
    if (webrtcUnsubscribe !== null) {
      try {
        webrtcUnsubscribe();
      } catch {
        /* unsubscribe must not be the reason stop fails */
      }
      webrtcUnsubscribe = null;
    }
    webrtcChannels.clear();
    // Await a start that is still in flight first: closing a node that is halfway through binding
    // would race the bind and could leave a socket nobody references.
    if (p2pStarting !== null) await p2pStarting.catch(() => null);
    const node = p2pNode;
    if (node === null) return;
    try {
      await node.close();
    } catch (error) {
      log('warn', 'p2p: closing the node failed', { error: error?.message ?? String(error) });
    }
    p2pChannels.clear();
    refreshP2PStatus();
  }

  /** Remember which channel a task's result should travel back over, and release it on close. */
  function rememberChannel(taskId, channel) {
    const peer = channel?.peer;
    if (
      peer !== null &&
      typeof peer?.address === 'string' &&
      peer.address !== '' &&
      Number.isInteger(peer?.port) &&
      peer.port > 0
    ) {
      // Kept even though this channel may be replaced or closed below: see `p2pPeers`.
      p2pPeers.set(taskId, { address: peer.address, port: peer.port });
    }
    const previous = p2pChannels.get(taskId);
    if (previous?.channel === channel) return;
    if (previous) previous.channel.removeListener('close', previous.onClose);
    const onClose = () => {
      if (p2pChannels.get(taskId)?.channel === channel) p2pChannels.delete(taskId);
    };
    p2pChannels.set(taskId, { channel, onClose });
    channel.on('close', onClose);
    // v0.6.0: the encryption facts go with the channel, recorded here so every caller that wires a
    // channel into a task records them without having to remember to.
    rememberChannelEncryption(taskId, channel);
  }

  /** The channel a task's result can be acknowledged over, or null when there is none. */
  const channelFor = (taskId) => p2pChannels.get(taskId)?.channel ?? null;

  /**
   * Remember what a task's direct channel was, encryption included (v0.6.0).
   *
   * `encrypted` is read from the channel itself, never from configuration: a machine with a keypair
   * still creates plaintext channels for peers it has no key for, and the ledger's job is to say what
   * happened rather than what was possible. `reason` is the named code from that same channel, so
   * `p2p.encrypted: false` always arrives with a *why*.
   *
   * It is called from both places a channel becomes a task's channel  - the offer that arrived on one
   * and the dial that opened one  - and the most recent call wins, which is right: a task's result
   * travels over the channel that is live *now*.
   *
   * @param {string} taskId
   * @param {object|null} channel
   */
  function rememberChannelEncryption(taskId, channel) {
    if (typeof taskId !== 'string' || taskId === '') return;
    const encryption = channel?.encryption ?? null;
    if (encryption === null) return;
    p2pEncryption.set(taskId, {
      encrypted: encryption.encrypted === true,
      reason: encryption.encrypted === true ? null : (encryption.reason ?? CRYPTO_REASON.PLAINTEXT_PEER),
      session: Number.isInteger(channel?.session) ? channel.session : null,
      epoch: Number.isInteger(encryption.epoch) ? encryption.epoch : 0,
    });
  }

  /**
   * The encryption facts of one task, or null when no channel ever existed for it.
   *
   * @param {string} taskId
   * @returns {object|null}
   */
  function encryptionFor(taskId) {
    const record = p2pEncryption.get(taskId);
    return record === undefined ? null : { ...record };
  }

  /**
   * Record that a task had no direct channel at all, and why (v0.6.0).
   *
   * Without this, a task executed entirely over the relay reports `encrypted: false` with no
   * explanation, and a reader cannot tell "this machine has no crypto" from "no direct channel was the
   * answer for this task"  - entirely different operational facts. The reason is the *same* string
   * `offerTransportOf` puts in `p2p.reason`, deliberately: one sentence, decided in one place.
   *
   * It never overwrites a channel's own record: once a channel carried something for this task, which
   * channel it was and whether it was sealed is the more specific answer.
   *
   * @param {string} taskId
   * @param {string|null} reason
   */
  function rememberNoChannel(taskId, reason) {
    if (typeof taskId !== 'string' || taskId === '') return;
    if (p2pEncryption.has(taskId)) return;
    p2pEncryption.set(taskId, {
      encrypted: false,
      reason: typeof reason === 'string' && reason !== '' ? reason : CRYPTO_REASON.PLAINTEXT_PEER,
      session: null,
      epoch: 0,
    });
  }

  /**
   * What a reverse dial would need, or the named reason there is nothing to dial.
   *
   * WHY THE EXECUTOR DIALS AT ALL
   *
   * The dispatcher pushes first, and if it is behind a symmetric NAT (CGNAT, in practice) its HELLOs
   * are addressed from a mapped port that nobody was told about, so they reach nothing. Its own
   * outbound packet still opened a mapping *towards this machine*, though -- and that is half a path.
   * The other half is a packet from here, addressed at the dispatcher: the moment this machine sends
   * one, its own NAT lets the dispatcher's HELLO through and the second packet lands on a path that is
   * already open. Neither end can do it alone, which is why a peer that only ever accepted cannot
   * rescue a CGNAT initiator.
   *
   * WHERE THE ADDRESSES COME FROM
   *
   * The offer's own `p2p.candidates` when the dispatcher published them (it knows its own announced
   * addresses better than a relay lookup that may already have expired), with the address this task's
   * channel actually reached first when there was one, and the relay's `/v1/peer/{id}` answer as the
   * node's own fallback when neither is available.
   *
   * @param {object} offer
   * @returns {{ok:true, machineId:string, session:number, candidates:Array<object>, from:string}
   *   |{ok:false, code:string, reason:string}}
   */
  function reverseDialPlan(offer) {
    const taskId = typeof offer?.task_id === 'string' && offer.task_id !== '' ? offer.task_id : null;
    if (taskId === null) {
      return { ok: false, code: 'P2P_NO_TASK_ID', reason: 'P2P_NO_TASK_ID: the offer names no task to dial for' };
    }
    if (p2pMode === 'relay') {
      return {
        ok: false,
        code: 'P2P_DISABLED',
        reason: 'P2P_DISABLED: p2pMode is "relay", so this machine never dials (the relay path is the only path)',
      };
    }
    if (p2pNode === null || p2pNode.status.running !== true) {
      return {
        ok: false,
        code: 'P2P_UNREACHABLE',
        reason: 'P2P_UNREACHABLE: the P2P node is not running, so no direct path can be dialled',
      };
    }
    if (channelFor(taskId) !== null) {
      return {
        ok: false,
        code: P2P_CHANNEL_LIVE,
        reason: `P2P_CHANNEL_LIVE: a direct channel for ${taskId} is already open, so there is nothing to dial`,
      };
    }

    const block = offer?.p2p;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      return {
        ok: false,
        code: 'P2P_NO_SESSION',
        reason: 'P2P_NO_SESSION: the offer published no `p2p` block, so there is no session to join',
      };
    }
    const dispatcher =
      typeof offer?.origin_machine_id === 'string' && offer.origin_machine_id !== ''
        ? offer.origin_machine_id
        : null;
    if (dispatcher === null) {
      return {
        ok: false,
        code: 'P2P_NO_ORIGIN',
        reason: 'P2P_NO_ORIGIN: the offer does not name the machine that dispatched it, so there is nothing to dial',
      };
    }

    const machineId = identity.machine_id;
    const published = Array.isArray(block.candidates) ? block.candidates : [];
    let session = Number.isInteger(block.session) && block.session > 0 ? block.session : null;
    let from = 'offer session';
    if (session === null) {
      session = punchSession({ punch: block.punch, taskId, machineId });
      from = 'offer punch';
    }
    if (session === null && published.length > 0) {
      // A dispatcher that published where to dial but not which session: this end picks one and the
      // far end's `accept()` adopts it -- that asymmetry is what `allowSessionAdoption` exists for.
      session = reverseDialSession({ originMachineId: dispatcher, taskId, machineId });
      from = 'derived session';
    }
    if (session === null) {
      // A v0.4.x dispatcher: it published no punch, so there is no session to join and no address it
      // asked to be reached at. Dialling anyway would be a punch this end invented against a machine
      // that never said a two-way punch was in play, so the offer is treated exactly as it was before
      // this change -- the relay carries the result, and the reason says why.
      return {
        ok: false,
        code: 'P2P_NO_SESSION',
        reason:
          'P2P_NO_SESSION: the offer published no session or candidates, so there is nothing to dial ' +
          '(a v0.4.x dispatcher, whose relay copy is the delivery)',
      };
    }

    const observed = p2pPeers.get(taskId) ?? null;
    return {
      ok: true,
      machineId: dispatcher,
      session,
      candidates: observed === null ? [...published] : [observed, ...published],
      from: observed === null ? from : `${from} + observed peer`,
    };
  }

  /**
   * Start (or reuse) this task's one reverse-dial attempt. Never awaited by the offer path.
   *
   * @param {object} offer
   * @param {{stage?: 'offer'|'result', afterLiveChannel?: boolean}} [options]
   * @returns {object|null} The record; `promise` settles when the dial is over.
   */
  function startReverseDial(offer, options = {}) {
    const taskId = typeof offer?.task_id === 'string' && offer.task_id !== '' ? offer.task_id : null;
    if (taskId === null) return null;
    const stage = options.stage === 'result' ? 'result' : 'offer';

    const existing = p2pReverseDials.get(taskId) ?? null;
    if (existing !== null) {
      // One attempt per task, with exactly one exception: a decision that said "a channel is already
      // live" is re-planned at result time, because that channel may be gone by then and the result
      // is what the dial exists for. Everything else -- attempted, disabled, unreachable, no session
      // -- is final, so a result never pays for a second eight-second wait.
      const rePlannable = existing.attempted !== true && existing.code === P2P_CHANNEL_LIVE;
      if (!(options.afterLiveChannel === true && rePlannable)) return existing;
    }

    const plan = reverseDialPlan(offer);
    /** @type {object} */
    const record = {
      task_id: taskId,
      attempted: plan.ok === true,
      ok: false,
      code: plan.ok === true ? null : plan.code,
      reason: plan.ok === true ? null : plan.reason,
      stage,
      session: plan.ok === true ? plan.session : null,
      candidates: plan.ok === true ? plan.candidates.length : 0,
      from: plan.ok === true ? plan.from : null,
      channel: null,
      promise: null,
      ms: null,
    };
    p2pReverseDials.set(taskId, record);

    if (!plan.ok) {
      record.promise = Promise.resolve(record);
      if (plan.code !== P2P_CHANNEL_LIVE) {
        log('info', `not dialling back for ${taskId}: ${plan.reason}`);
      }
      return record;
    }

    const timeoutMs = reverseDialTimeoutMs();
    const startedAt = process.hrtime.bigint();
    record.promise = (async () => {
      let dialled;
      try {
        dialled = await p2pNode.dial(plan.machineId, {
          session: plan.session,
          candidates: plan.candidates,
          timeoutMs,
        });
      } catch (error) {
        // `dial()` documents that it never throws; caught anyway, because this runs detached from
        // every caller and an unhandled rejection is the one failure that could take the process down.
        dialled = { ok: false, error: `P2P_REVERSE_DIAL_FAILED: ${error?.message ?? String(error)}` };
      }
      record.ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
      if (dialled?.ok === true) {
        record.ok = true;
        record.channel = dialled.channel;
        record.reused = dialled.reused === true;
        rememberChannel(taskId, dialled.channel);
        log('info', `reverse dial to ${plan.machineId} opened a channel for ${taskId}`, {
          session: dialled.session,
          ms: record.ms,
          reused: record.reused,
          candidates: plan.candidates.length,
        });
        return record;
      }
      const text = typeof dialled?.error === 'string' && dialled.error !== '' ? dialled.error : 'the dial reported no reason';
      record.reason = text.startsWith('P2P_PUNCH_TIMEOUT')
        ? `${P2P_REVERSE_DIAL_TIMEOUT}: ${text}`
        : `${P2P_REVERSE_DIAL_FAILED}: ${text}`;
      // A distinct code from the reason: the full message names the candidates and the window, and
      // this is what a reader or a metric can match on without parsing prose.
      record.code = record.reason.slice(0, record.reason.indexOf(':'));
      log('warn', `reverse dial for ${taskId} did not open a channel; the relay path is unaffected`, {
        reason: record.reason,
        ms: record.ms,
      });
      return record;
    })();

    return record;
  }

  /**
   * The reverse-dial facts one result envelope reports, or null when there was no record.
   *
   * @param {string} taskId
   * @returns {object|null}
   */
  function reverseDialSummary(taskId) {
    const record = p2pReverseDials.get(taskId) ?? null;
    if (record === null) return null;
    return {
      attempted: record.attempted === true,
      ok: record.ok === true,
      code: record.code,
      reason: record.reason,
      stage: record.stage,
      session: record.session,
      candidates: record.candidates,
      ms: record.ms,
      channel: record.channel ?? null,
    };
  }

  /** Release the channel a task used, once the attempt is over.
   *
   * A channel exists for one attempt: the offer arrives on it and the result notice is acknowledged
   * on it, and nothing else is expected. Without this, an agent accumulated one live session per task
   * it ever handled -- and a session whose peer has gone away is invisible in every status surface
   * except the channel count, which is exactly how a leak becomes a mystery months later. Closing is
   * cheap: the mapping is re-punchable, and a duplicate offer that arrives afterwards simply has no
   * channel to answer on (the relay copy is the durable one).
   */
  function releaseChannel(taskId) {
    p2pReverseDials.delete(taskId);
    p2pPeers.delete(taskId);
    p2pEncryption.delete(taskId);
    const entry = p2pChannels.get(taskId);
    if (!entry) return;
    p2pChannels.delete(taskId);
    entry.channel.removeListener('close', entry.onClose);
    clearTimeout(entry.lingerTimer);
    try {
      entry.channel.close('attempt-complete');
    } catch {
      /* the path is already gone; that is the state this function produces */
    }
  }

  /**
   * Release a task's channel after a bounded linger.
   *
   * The linger is the difference between "no leak" and "a duplicate cannot be answered": a
   * re-delivery of a finished attempt (the relay replaying an offer, or a dispatcher retrying a push)
   * is answered over the channel, and that is only possible while the channel exists. 30 seconds is
   * long enough to cover a retry and short enough that a long-lived agent does not accumulate one
   * session per task it has ever run.
   *
   * Scheduled even when there is no channel: the timer is also what releases this task's remembered
   * peer address, and a task whose dial timed out has exactly that and no channel.
   */
  function scheduleChannelRelease(taskId) {
    const entry = p2pChannels.get(taskId);
    if (entry) clearTimeout(entry.lingerTimer);
    const timer = setTimeout(() => releaseChannel(taskId), p2pChannelLingerMs);
    timer.unref?.();
    if (entry) entry.lingerTimer = timer;
  }

  /**
   * Let go of one task's dial record, once its envelope has been built.
   *
   * That envelope is the record's last reader: the record exists to decide `result_path` and to name
   * the mechanism that opened the channel, and both are inside the envelope by the time this runs. A
   * re-attempt of the same task (`attempt + 1`) is a new decision and starts a fresh dial, which is
   * why this is not left to the linger timer -- that one waits 30 s, and a retry can arrive sooner.
   *
   * @param {string} taskId
   */
  function releaseDialRecord(taskId) {
    p2pReverseDials.delete(taskId);
  }

  /** The STUN list the node is actually querying, for a status surface that can be quoted. */
  const p2pStunServers = () => p2pNode?.stunServers ?? null;

  /**
   * Recently delivered envelopes, keyed by `dedupe_key#attempt`.
   *
   * Rabbit's idempotency triple is `(machine_id, dedupe_key, attempt)`, so:
   *
   *   * a **transport** re-delivery of the same attempt is answered from this
   *     cache (or the spool) instead of being executed twice;
   *   * a **new attempt** for the same `dedupe_key` is a genuine retry and must
   *     run again -- §4.4 keeps `attempt` out of `dedupe_key` for exactly that
   *     reason, and replaying the old envelope would leave the new lease
   *     without a result of its own.
   *
   * Bounded and memory-only: after a restart Rabbit's own accounting is the
   * backstop.
   *
   * @type {Map<string, object>}
   */
  const completed = new Map();
  const COMPLETED_CACHE_LIMIT = 64;

  /**
   * Remember a delivered envelope, bounded.
   *
   * The key is {@link identityKeyFor}'s, not a second spelling of the same idea: a cache keyed
   * differently from the dedupe check would be a cache that never hits.
   *
   * @param {string|null} key
   * @param {object} envelope
   */
  function rememberCompleted(key, envelope) {
    if (!key) return;
    completed.delete(key);
    completed.set(key, envelope);
    while (completed.size > COMPLETED_CACHE_LIMIT) {
      const oldest = completed.keys().next().value;
      completed.delete(oldest);
    }
  }

  // -- Spool flushing ------------------------------------------------------

  /** Resend envelopes that were written but never acknowledged. */
  async function flushSpool() {
    const pending = spool.pendingResults();
    if (pending.length === 0) return 0;
    log('info', `resending ${pending.length} spooled result(s)`);
    let sent = 0;
    for (const record of pending) {
      if (state.stopped) break;
      const response = await postJson('/v1/result', record.envelope);
      if (response.ok) {
        spool.ack({ task_id: record.task_id, attempt: record.attempt });
        sent += 1;
      } else {
        log('warn', `spooled result ${record.task_id} still undelivered`, {
          status: response.status,
          // The relay's own code, not a paraphrase: SIGNATURE_EXPIRED and
          // SIGNATURE_REQUIRED need different fixes.
          code: relayErrorCode(response),
        });
      }
    }
    return sent;
  }

  /** Warn about entries that were claimed but never finished (a crash). */
  function reportInterrupted() {
    const interrupted = spool.interruptedTasks();
    for (const record of interrupted) {
      log('warn', `interrupted task left in spool (not replayed automatically)`, {
        task_id: record.task_id,
        attempt: record.attempt,
      });
    }
    return interrupted.length;
  }

  // -- Envelope assembly ---------------------------------------------------

  /**
   * The `p2p` block of a result envelope (v0.4.0 §6).
   *
   * It is built **before** `envelope_sha256` is computed, because the hash covers the whole
   * envelope: attaching these fields afterwards would leave a hash that does not cover the bytes
   * it claims to cover, and `verifyEnvelope` would fail on an envelope nobody tampered with. That
   * is also why the direct copy uses the very same object -- one envelope, two deliveries.
   *
   * Every field answers a question a reader of a *stored* result actually asks:
   *
   *   * `mode`      -- this agent's configured mode, or the dispatcher's when it stated one. The
   *                   dispatcher's value is used when present because a task dispatched by an
   *                   `auto` machine may be executed by a `direct` one, and "why did this path
   *                   win" is a question about the dispatcher's intent.
   *   * `offer_path`-- how the offer got here, as this agent observed it (never as claimed on the
   *                   wire: only the channel path can set it).
   *   * `result_path`-- `'p2p'` **only** when the envelope was acknowledged over the direct
   *                   channel. Absent means "no direct result", which is not the same fact as
   *                   `'relay'` and must not be spelled as one.
   *   * `reason`    -- why the direct path was not the answer, or null when it was.
   *   * `rtt_ms`    -- the punch's measured round trip, or null. Null rather than 0: a round trip
   *                   that was never measured is not an instantaneous one.
   *   * `peer`      -- the peer's address as seen by this agent, or null for an inbound channel
   *                   (a HELLO carries a session, not an identity).
   *   * `session`   -- the punch's session id, which is what correlates two agents' logs.
   *   * `mapping`   -- the NAT mapping this agent's announcement measured.
   *
   * v0.4.x adds three more, because "the result came back over the relay" and "the result came back
   * over the relay *after this machine spent eight seconds dialling*" are different operational
   * facts and the v0.4.0 block could not tell them apart:
   *
   *   * `opened_by` -- which mechanism opened the channel, named rather than inferred:
   *                   `dispatcher-punch` (the dispatcher's outbound HELLO landed), `simultaneous-punch`
   *                   (this machine dialled as the offer arrived, and that is what opened both
   *                   filters), `result-reverse-dial` (this machine dialled once the result was
   *                   ready). Absent when no channel carried anything.
   *   * `reverse_dial` -- `'p2p'` when this machine's own dial opened a channel, `'relay'` when it was
   *                   attempted and did not. Absent when it was never attempted, which is not a
   *                   failure and must not be spelled as one.
   *   * `reverse_dial_reason` -- the named code when the dial did not open a channel
   *                   (`P2P_REVERSE_DIAL_TIMEOUT`, `P2P_REVERSE_DIAL_FAILED`), or null.
   *   * `reverse_dial_ms` -- what the dial cost, in milliseconds. The window is a bound the contract
   *                   states, and a bound nobody measures is a claim: this is the number that says
   *                   whether the result path really stayed inside it.
   *   * `result_error` -- why the direct copy of *this result* did not land, when one was attempted
   *                   and not acknowledged (`P2P_ACK_TIMEOUT:  - ). Null otherwise; this is the
   *                   `delivery.error` that `p2pDeliveryMark` has always carried and the envelope
   *                   never reported.
   *
   * @param {object} context
   * @returns {object}
   */
  function envelopeP2P(context) {
    const offer = context.offer ?? {};
    const transport = context.p2pTransport ?? offerTransportOf(offer, p2pStatusSnapshot());
    const delivery = context.p2pDelivery ?? p2pDeliveryMark();
    const record = context.p2pRecord ?? null;
    const reverse = context.p2pReverse ?? null;
    const dispatcherMode = offer?.p2p?.mode;
    /**
     * Was this task's direct channel sealed?
     *
     * Read from what the agent *recorded* when it held the channel, not from a live object: by the
     * time the envelope is built the channel may have been released, and `p2p.encrypted` has to
     * describe the channel that carried this attempt. `null` means no channel was ever involved  -      * a task executed entirely over the relay  - which reports `encrypted: false` because that is the
     * truth about this task's data plane, whatever this machine's keypair could have done.
     */
    const encryption = encryptionFor(offer?.task_id);

    /**
     * Which mechanism opened the channel that carried the offer or the result.
     *
     * Identity, not timing: the record keeps the channel object its dial opened, so "the reverse dial
     * is what carried this result" is a comparison of two references rather than a guess from the
     * order things happened in. A channel that arrived on its own can only be the dispatcher's punch.
     */
    const usedChannel = channelFor(offer?.task_id);
    let openedBy = null;
    if (delivery.path === 'p2p') {
      if (delivery.transport === 'webrtc-v1') {
        openedBy = P2P_OPENED_BY.WEBRTC_DATA_CHANNEL;
      } else if (reverse?.ok === true && reverse.channel !== null && reverse.channel === usedChannel) {
        openedBy = reverse.stage === 'result'
          ? P2P_OPENED_BY.RESULT_REVERSE_DIAL
          : P2P_OPENED_BY.SIMULTANEOUS_PUNCH;
      } else {
        openedBy = P2P_OPENED_BY.DISPATCHER_PUNCH;
      }
    } else if (transport.offer_path === 'p2p') {
      openedBy = P2P_OPENED_BY.DISPATCHER_PUNCH;
    }

    return {
      mode: typeof dispatcherMode === 'string' && dispatcherMode !== '' ? dispatcherMode : p2pMode,
      offer_path: transport.offer_path,
      // v0.6.0, and it is the field the whole of stage 1 exists to be believed about: `true` only
      // when a handshake completed and the frames on this task's direct channel were sealed. There is
      // deliberately no "probably": a machine with a keypair that could not complete a handshake with
      // this peer records `false` *and* the named reason, so "the relay carried it" and "the relay
      // carried it because the crypto did not land" are different, readable facts.
      //
      // `encrypted` is always present, like `mode`, because a reader has to be able to tell "no
      // encryption" from "this build does not say" without comparing two machines' envelopes.
      encrypted: encryption?.encrypted === true,
      ...(encryption === null || encryption.encrypted === true ? {} : { encryption_reason: encryption.reason }),
      ...(encryption === null || encryption.session === null ? {} : { encryption_session: encryption.session }),
      ...(delivery.path === null ? {} : { result_path: delivery.path }),
      ...(delivery.transport === null ? {} : { result_transport: delivery.transport }),
      ...(delivery.attempts > 0 ? { result_attempts: delivery.attempts } : {}),
      ...(delivery.fallback_from === null ? {} : { result_fallback_from: delivery.fallback_from }),
      ...(openedBy === null ? {} : { opened_by: openedBy }),
      ...(reverse === null || reverse.attempted !== true
        ? {}
        : { reverse_dial: reverse.ok === true ? 'p2p' : 'relay' }),
      ...(reverse !== null && typeof reverse.reason === 'string' && reverse.reason !== ''
        ? { reverse_dial_reason: reverse.reason }
        : {}),
      ...(typeof reverse?.ms === 'number' ? { reverse_dial_ms: reverse.ms } : {}),
      // The key is OMITTED when there is nothing to explain, and that is not the same as setting it
      // to `undefined`: `JSON.stringify` would drop that, but the envelope hash is computed with JCS,
      // whose implementation (rightly) refuses a non-JSON value. Measured -- `reason: undefined`
      // here made every direct-path result fail to build its envelope with
      // `jcs: property reason is undefined`, so the task executed and then vanished from the ledger.
      ...(typeof transport.reason === 'string' && transport.reason !== '' ? { reason: transport.reason } : {}),
      rtt_ms: delivery.rtt_ms ?? record?.rtt_ms ?? null,
      // The peer address and session of whichever channel this machine holds for the task: the one
      // that carried the offer, or the one its own dial opened. For an inbound channel `peer` stays
      // null (a HELLO carries a session, not an identity) -- but a channel *this* machine dialled has
      // a peer address it chose, and reporting "no peer" there would hide the one address the punch
      // actually used.
      peer: record?.peer ?? (reverse?.ok === true && reverse.channel !== null ? { ...reverse.channel.peer } : null),
      session: record?.session ?? reverse?.session ?? null,
      mapping: p2pNode?.status.mapping ?? null,
      ...(delivery.asked === true && delivery.path === null && typeof delivery.error === 'string' && delivery.error !== ''
        ? { result_error: delivery.error }
        : {}),
    };
  }

  /**
   * Turn a finished (or refused) run into a complete §5.1 envelope.
   *
   * @param {object} context
   */
  function makeEnvelope(context) {
    const {
      offer,
      cwdRel,
      commandArgv,
      anchorsBefore,
      anchorsAfter,
      execution,
      blobSha256 = null,
      status,
      refusalReason,
      warnings,
      startedAt,
      endedAt,
      toolchain,
      comparePolicy,
      pipeline,
      protocolViolations,
      authorization = null,
      workspace = null,
    } = context;

    const stdout = execution?.stdout ?? Buffer.alloc(0);
    const normalized = normalizeOutput(stdout, comparePolicy ?? {});

    /**
     * The stage descriptors the pipeline hash is taken over, or null for a single command.
     *
     * Normalized exactly as the relay normalizes them (`cwd_rel` defaults to the task cwd,
     * `continue_on_failure` to false), because the two sides must hash the same shape or every
     * pipeline anchors as `unverifiable`.
     */
    const pipelineHashMaterial = pipeline && Array.isArray(pipeline.stages) && pipeline.total_stages > 1
      ? pipeline.stages.map((s) => ({
        command_argv: s.command_argv,
        cwd_rel: s.cwd_rel ?? cwdRel,
        continue_on_failure: s.continue_on_failure === true,
      }))
      : null;

    const envelope = {
      envelope_version: ENVELOPE_VERSION,
      // v1.3.12-beta.3: how this execution was authorised -- 'grant' (operator, one execution), 'allow-list' (standing machine
      // decision) or 'maintenance' (signed maintenance request). A reader can answer "who allowed this" without the ledger.
      authorization: authorization ?? null,
      // v1.3.13-beta.2: the copy this task ran on, and the patch it produced (evidence, not a promise).
      workspace: workspace ?? null,
      task_id: offer.task_id,
      attempt: Number(offer.attempt) || 1,
      dedupe_key: offer.dedupe_key ?? '',
      machine_id: identity.machine_id,
      machine_name: identity.machine_name,
      platform,
      caps,
      index: Number.isInteger(offer.index) ? offer.index : 0,
      index_total: Number.isInteger(offer.index_total) ? offer.index_total : 1,
      mode: offer.mode ?? 'replicate',
      cwd_rel: normalizeRelPath(cwdRel),
      base_commit: offer.base_commit ?? anchorsBefore?.head_commit ?? '',
      base_tree: offer.base_tree ?? null,
      pre_tree_fingerprint: anchorsBefore?.pre_tree_fingerprint ?? null,
      post_tree_fingerprint: anchorsAfter?.post_tree_fingerprint ?? null,
      fingerprint_algo: FINGERPRINT_ALGO,
      fingerprint_error: anchorsBefore?.fingerprint_error ?? null,
      head_commit: anchorsAfter?.head_commit ?? anchorsBefore?.head_commit ?? null,
      dirty_before: anchorsBefore?.dirty_before === true,
      command_argv: commandArgv,
      // A pipeline's hash covers the whole chain, matching the relay's `computePipelineCommandHash`.
      // Hashing only stage 0 would make every pipeline `unverifiable` at the anchor -- the machine ran
      // exactly what it was asked and the relay still could not confirm it.
      command_hash: pipelineHashMaterial === null
        ? commandHash(commandArgv, SHELL_ID, cwdRel)
        : pipelineCommandHash(pipelineHashMaterial, SHELL_ID),
      // The material the pipeline hash was taken over. Kept in the envelope so a mismatch can be
      // diagnosed from the result itself rather than by re-running with instrumentation -- which is
      // what was needed to find the relay/agent disagreement this field now prevents. Present only for
      // a chain, so a single-command envelope is byte-unchanged.
      ...(pipelineHashMaterial === null ? {} : { pipeline_hash_material: pipelineHashMaterial }),
      shell_id: SHELL_ID,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: execution?.duration_ms ?? 0,
      exit_code: execution ? execution.exit_code : null,
      status,
      refusal_reason: refusalReason ?? null,
      stdout_sha256: execution ? execution.stdout_sha256 : EMPTY_SHA256,
      stdout_bytes: execution ? execution.stdout_bytes : 0,
      ...(blobSha256 === null ? {} : { blob_sha256: blobSha256, output_mode: 'blob' }),
      stderr_sha256: execution ? execution.stderr_sha256 : EMPTY_SHA256,
      stderr_bytes: execution ? execution.stderr_bytes : 0,
      warnings,
      // Optional fields (§5.2): present on both machines for the same task, so
      // they stay comparable; head/tail are informational only.
      stdout_normalized_sha256: sha256Hex(normalized),
      // v1.2.4: when the stage's output became a blob, the envelope names it and does NOT also inline the first/last 4 KiB --
      // carrying both would make two readers disagree about which one is authoritative.
      stdout_head: blobSha256 === null ? (execution?.stdout_head ?? '') : '',
      stdout_tail: blobSha256 === null ? (execution?.stdout_tail ?? '') : '',
      stderr_head: execution?.stderr_head ?? '',
      stderr_tail: execution?.stderr_tail ?? '',
      untracked: anchorsAfter?.untracked ?? anchorsBefore?.untracked ?? [],
      diff_numstat: anchorsAfter?.diff_numstat ?? [],
      toolchain: toolchain ?? null,
    };
    if (execution?.signal) envelope.signal = execution.signal;

    /**
     * v1.2.6: secrets a command printed are replaced before the envelope leaves this machine. The hashes above stay the
     * evidence of the raw bytes; only the readable heads/tails are filtered. `redactOutput: false` disables it and marks the
     * envelope `unredacted: true`, because a silent no-op would be worse than no redaction.
     */
    if (redactOutput !== false) {
      const filtered = redactEnvelope(envelope, { enabled: true });
      Object.assign(envelope, filtered.envelope);
    } else {
      envelope.unredacted = true;
    }
    if (offer.write === true) envelope.write = true;

    // v0.3.3 `pipeline` (§5.2 optional). Present only for a chain, so a single-command envelope is
    // byte-identical to before -- which is what keeps a v0.2.3 relay able to verify this one.
    //
    // The per-stage record is the point: a final exit code cannot distinguish "stage 3 failed" from
    // "stages 3..5 never ran", and those need different responses from a reader.
    if (pipeline && typeof pipeline === 'object') {
      envelope.pipeline = pipeline;
    }
    if (Array.isArray(protocolViolations) && protocolViolations.length > 0) {
      envelope.protocol_violations = protocolViolations;
    }

    // v0.4.0 §6. Always present, like the relay's own offer fields and for the same reason: a
    // v0.3.9 machine and an `auto` one are then distinguishable from the stored envelope alone,
    // instead of `transport` being absent both when the direct path was never tried and when it
    // was tried and lost.
    //
    // v0.4.x widens what `transport` answers, without moving either of the two facts it is read for.
    // It is "did the direct path carry anything for this machine" -- `p2p` when the offer arrived over
    // a channel *or* when the result was acknowledged over one, `relay` when the relay carried both.
    // `p2p.offer_path` and `p2p.result_path` remain the halves, so a reader that needs "which way did
    // the offer come" still has it verbatim; what changed is that a machine whose *result* found its
    // own way back no longer looks like a machine that fell all the way to the relay. That is the
    // reading the relay's own report already documents ("how this machine's envelope travelled"), and
    // the one a deployment-level question like "is P2P working here" needs answered.
    const transport = context.p2pTransport ?? offerTransportOf(offer, p2pStatusSnapshot());
    const directResult = (context.p2pDelivery ?? p2pDeliveryMark()).path === 'p2p';
    envelope.transport = transport.offer_path === 'p2p' || directResult ? 'p2p' : transport.offer_path;
    envelope.p2p = envelopeP2P({ ...context, p2pTransport: transport });

    /**
     * v0.9.6 individual memory: write what this machine just did, where the text still exists.
     *
     * This is the last point at which the output is available to anything that will keep it. The relay
     * is sent `stdout_sha256` and `stdout_bytes` and never the text -- deliberately, so that a relay
     * compromise discloses no command text and the ledger stays a consistency record rather than a
     * transcript. The consequence is that a question like "what did we already try on this machine, and
     * what happened?" had no answer anywhere in the fleet, and the same facts were rediscovered from
     * scratch repeatedly at the cost of a dozen dispatches in one session.
     *
     * The write happens **after** the envelope is complete, so the record it stores is the same one the
     * relay will judge -- not a second, independently assembled opinion about what happened.
     *
     * `appendMemory` never throws and its result never changes the verdict: the task is the work and
     * this is a note about it, so a full disk or an unwritable directory must not turn a successful
     * command into a failed task. A memory that can fail work is worse than no memory.
     *
     * v0.9.8: its *outcome* is nonetheless reported, as `memory` on the envelope. Leaving it entirely
     * silent was the right call for the control flow and the wrong one for the reader -- a machine whose
     * memory is not being written is indistinguishable from one that has nothing to remember, which is
     * exactly the class of invisible failure this layer exists to end. One optional field, no verdict
     * moved: it is not a comparable field, so two machines cannot disagree over it.
     */
    const memoryWrite = appendMemory(stateDir, memoryRecord({
      envelope,
      commandArgv,
      cwdRel,
      ms: (Date.parse(endedAt) - Date.parse(startedAt)) || 0,
    }));
    envelope.memory = memoryWrite.ok === true
      ? { written: true, file: MEMORY_FILE, rotated: memoryWrite.rotated === true }
      : { written: false, reason_code: memoryWrite.error };

    /**
     * v1.2.6: sign the four facts that identify THE COMMAND. The signature covers the tuple only, because everything else in
     * the envelope is a report about the run rather than a claim about which command ran. `unsigned` is a fact a reader can
     * see (an older build, or no device key); it is not silently claimed as signed.
     */
    const signingKey = deviceKey === null ? null : deriveSigningKey(deviceKey);
    if (signingKey !== null) {
      const payload = canonicalSignedPayload({
        task_id: envelope.task_id,
        argv_hash: envelope.command_hash,
        machine_id: envelope.machine_id,
        ts: endedAt,
      });
      try {
        envelope.signature = {
          alg: 'ed25519',
          value: signBytes(null, Buffer.from(payload, 'utf8'), signingKey.privateKey).toString('base64'),
          public_key: signingKey.publicKeyBase64,
          ts: endedAt,
        };
      } catch {
        // The failure is reported by the envelope arriving unsigned; a key that cannot sign must not fail the run.
        // A key that cannot sign must not fail the run: the envelope simply arrives unsigned, which readers report.
      }
    }

    return buildEnvelope(envelope);
  }

  /** Post-run state, converted the same way. */
  async function safePostState(offer, warnings) {
    try {
      return await collectPostState({
        cwd: project,
        base: offer.base_commit ?? undefined,
        tmpDir,
        objectMode,
      });
    } catch (error) {
      warnings.push(WARN_FINGERPRINT_UNAVAILABLE);
      log('warn', 'could not collect post-state', { error: error?.message ?? String(error) });
      return {
        head_commit: null,
        post_tree_fingerprint: null,
        fingerprint_error: 'ANCHOR_COLLECTION_FAILED',
        untracked: [],
        diff_numstat: [],
      };
    }
  }

  /**
   * Subscribe to the injected WebRTC pool once. Idempotent.
   *
   * The pool is the only object here that owns sockets and engine processes; the agent only consumes
   * its frames. Subscribing at `startP2P()` time (including in `relay` mode) is deliberate: WebRTC is
   * its own data plane and does not depend on the UDP node being enabled, so a machine configured
   * `p2pMode: relay` can still use WebRTC for a Teams data plane.
   */
  function attachWebRtc() {
    if (webrtcPool === null || webrtcUnsubscribe !== null) return;
    if (typeof webrtcPool.onMessage !== 'function') {
      webrtcStats.last_error = 'WEBRTC_POOL_INVALID: the injected pool has no onMessage()';
      return;
    }
    webrtcUnsubscribe = webrtcPool.onMessage((event) => {
      try {
        handleWebRtcFrame(event);
      } catch (error) {
        webrtcStats.last_error = `WEBRTC_FRAME_HANDLER_FAILED: ${error?.message ?? String(error)}`;
        log('warn', 'webrtc: frame handler failed', { error: webrtcStats.last_error });
      }
    });
  }

  /**
   * Feed one WebRTC frame into the same dispatcher the UDP channel uses.
   *
   * `handleP2PMessage` already accepts a `{payload, channel, peer, session}` event and does the
   * `result.ack` / `task.offer` / `xfer.*` / `view.*` routing. The adapter below is what makes a
   * WebRTC pair look like a channel to that code without pretending it is a UDP channel: its
   * `transport` field names the real stack, and `send` forwards to the pool.
   */
  function handleWebRtcFrame(event) {
    const peer = typeof event?.peer === 'string' && event.peer !== '' ? event.peer : null;
    if (peer === null || event?.payload === undefined || event?.payload === null) return;
    const raw = Buffer.isBuffer(event.payload) ? event.payload : Buffer.from(String(event.payload), 'utf8');
    let frame = null;
    try {
      frame = JSON.parse(raw.toString('utf8'));
    } catch {
      log('warn', 'webrtc: ignoring a non-JSON frame', { peer, bytes: raw.length });
      return;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return;
    const taskId = typeof frame.task_id === 'string' && frame.task_id !== '' ? frame.task_id : null;
    const channel = webrtcChannelFor(peer, taskId);
    webrtcStats.last_at = new Date().toISOString();
    deps.heartbeat.handleP2PMessage({
      from: peer,
      channel,
      peer: { machine_id: peer },
      session: null,
      payload: raw,
    });
  }

  /**
   * A channel-shaped adapter over one WebRTC peer.
   *
   * The adapter is per peer, not per pool, so `rememberChannel` can attach its `close` listener and
   * `envelopeP2P` can read `encryption` from the same object. `send` forwards every frame through
   * the pool's Noise-sealed DataChannel; a failure is thrown because the UDP channel contract is
   * promise-based and `sendResultDirect` already catches it.
   */
  function webrtcChannelFor(peer, taskId) {
    const existing = taskId === null ? null : webrtcChannels.get(taskId);
    if (existing !== null && existing !== undefined && existing.peer?.machine_id === peer) return existing;
    const adapter = {
      peer: { machine_id: peer },
      session: null,
      // The shared dispatcher keys on `transport === 'p2p'` to decide that an ack is evidence about
      // the direct path; the exact stack is named separately so the scheduler can still tell a
      // WebRTC adapter from a UDP channel.
      transport: 'p2p',
      stack: 'webrtc-v1',
      // The Noise handshake is a precondition of a started transport, so a frame that arrives here
      // travelled sealed. There is no plaintext mode in `webrtc-v1`.
      encryption: { encrypted: true, reason: null, epoch: 0 },
      send: async (payload) => {
        const result = await webrtcPool.send(peer, payload);
        if (result?.ok !== true) {
          const error = new Error(result?.detail ?? result?.code ?? 'WEBRTC_SEND_FAILED');
          error.code = result?.code ?? 'WEBRTC_SEND_FAILED';
          throw error;
        }
        return result;
      },
      on: () => adapter,
      removeListener: () => adapter,
      close: () => {},
    };
    if (taskId !== null) {
      webrtcChannels.set(taskId, adapter);
      // A frame that arrived over WebRTC is also the direct channel for this task. Register it in
      // the shared map only when there is no UDP channel already, so a result.ack sent back on the
      // same path is found by `channelFor` without displacing a real UDP channel.
      if (channelFor(taskId) === null) rememberChannel(taskId, adapter);
    }
    return adapter;
  }

  /** Whether a pool failure is worth another attempt inside the result budget. */
  function webrtcRetryable(code) {
    return !(
      code === 'WEBRTC_POOL_PEER_KEY_MISSING' ||
      code === 'WEBRTC_POOL_SELF_PEER' ||
      code === 'WEBRTC_POOL_BAD_CONFIG' ||
      code === 'WEBRTC_POOL_CLOSED' ||
      code === 'WEBRTC_PROVIDER_UNAVAILABLE' ||
      code === 'WEBRTC_DEVICE_KEY_REQUIRED' ||
      code === 'WEBRTC_PEER_KEY_REQUIRED'
    );
  }

  /** Sleep without keeping the process alive. */
  function webrtcSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /**
   * Register one `result.ack` waiter for a single attempt.
   *
   * The shared `p2pResultWaiters` map is reused so both transports settle the same fact, and a late
   * ack from a slow attempt cannot resolve a newer attempt: `settle` removes itself and a second
   * attempt installs a fresh registration.
   */
  function registerWebRtcAck(taskId, timeoutMs) {
    let lastAckError = null;
    let settled = false;
    let registration = null;
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (p2pResultWaiters.get(taskId) === registration) p2pResultWaiters.delete(taskId);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      registration = {
        settle: (value, reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (p2pResultWaiters.get(taskId) === registration) p2pResultWaiters.delete(taskId);
          if (value === false && typeof reason === 'string' && reason !== '') lastAckError = reason;
          resolve(value);
        },
      };
      p2pResultWaiters.set(taskId, registration);
    });
    return { promise, error: () => lastAckError, settle: (value, reason) => registration.settle(value, reason) };
  }

  /**
   * Try the WebRTC result path first, bounded by both an attempt count and a wall-clock budget.
   *
   * The attempt count is the Teams data-plane contract (33); the budget is what keeps a dispatcher
   * that is simply offline from delaying the relay ledger by 33 connect windows. A retryable pool
   * failure is retried until either bound; a deterministic refusal (missing key, no provider) stops
   * immediately because 33 identical refusals are not a better answer.
   *
   * @param {string} taskId
   * @param {string} peerMachineId The dispatcher that handed this task over.
   * @returns {Promise<{delivered:boolean, attempts:number, rtt_ms:number|null, error:string|null}>}
   */
  async function sendResultWebRtc(taskId, peerMachineId) {
    if (webrtcPool === null) return { delivered: false, attempts: 0, rtt_ms: null, error: null };
    if (typeof peerMachineId !== 'string' || peerMachineId === '') {
      return { delivered: false, attempts: 0, rtt_ms: null, error: null };
    }
    const deadline = Date.now() + webrtcResultBudgetMs;
    let attempts = 0;
    let lastError = null;
    for (let index = 0; index < webrtcDataMaxAttempts; index += 1) {
      if (Date.now() >= deadline) break;
      if (index > 0 && webrtcRetryDelayMs > 0) await webrtcSleep(webrtcRetryDelayMs);
      attempts += 1;
      webrtcStats.attempts += 1;
      const startedAt = process.hrtime.bigint();
      const waiter = registerWebRtcAck(taskId, Math.max(1, Math.min(webrtcAckTimeoutMs, deadline - Date.now())));
      const sent = await webrtcPool.send(peerMachineId, JSON.stringify({
        type: 'task.result',
        task_id: taskId,
        machine_id: identity.machine_id,
        transport: 'webrtc-v1',
      }));
      if (sent?.ok !== true) {
        lastError = `${sent?.code ?? 'WEBRTC_SEND_FAILED'}: ${sent?.detail ?? 'send failed'}`;
        webrtcStats.last_error = lastError;
        waiter.settle(false, lastError);
        if (!webrtcRetryable(sent?.code)) break;
        continue;
      }
      const acked = await waiter.promise;
      const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (acked === true) {
        webrtcStats.delivered += 1;
        webrtcStats.last_at = new Date().toISOString();
        // The envelope's `p2p.encrypted` describes the channel that carried this attempt; a result
        // that arrived over the relay but left over WebRTC must still say it was sealed.
        rememberChannelEncryption(taskId, webrtcChannelFor(peerMachineId, taskId));
        return {
          delivered: true,
          attempts,
          rtt_ms: Math.round(elapsed * 100) / 100,
          error: null,
        };
      }
      lastError = waiter.error() ?? `WEBRTC_ACK_TIMEOUT: no result.ack within ${webrtcAckTimeoutMs}ms`;
      webrtcStats.last_error = lastError;
    }
    webrtcStats.failed += 1;
    return { delivered: false, attempts, rtt_ms: null, error: lastError };
  }

  /**
   * Try the direct path for one attempt, before the envelope exists.
   *
   * WHY THIS RUNS FIRST, AND WHY THE FRAME IS NOT THE ENVELOPE
   *
   * `result_path` is `'p2p'` only when the envelope was *actually acknowledged* over the channel,
   * and `envelope_sha256` covers the whole envelope -- so the fact has to be known before the
   * envelope is built, or the hash would not cover the bytes it claims to cover. The obvious way
   * out would be to send the finished envelope and stamp `result_path` afterwards, which is
   * precisely the mutation that would break `verifyEnvelope`. So the order is inverted instead:
   * announce the result on the channel (`{type:'task.result', task_id}`), wait for the dispatcher's
   * `{type:'result.ack', task_id}`, and only then build the one envelope that describes what
   * happened.
   *
   * The direct frame therefore carries the frame *type* and the task identity rather than the whole
   * envelope. That is a deliberate narrowing, and it is worth stating plainly: the fast path
   * currently saves the dispatcher the wait for the relay's copy, not the bytes. Carrying the full
   * envelope on the channel would need the envelope before the acknowledgement that decides one of
   * its fields -- see the note in the v0.4.0 report and `PROTOCOL-v0.4.0.md`'s open question.
   *
   * A channel is no longer a precondition (v0.4.x): when there is none, this dials the dispatcher
   * first (see `reverseDialPlan`) and uses the channel that opens. What has *not* changed is the
   * bound and the order -- the relay copy still goes out after this returns, whatever it decided, and
   * the whole function still costs at most one dial window plus one ack window.
   *
   * @param {object} offer
   * @param {string|null} [status] The outcome this envelope is about to report. A `refused` attempt
   *   has no direct result worth dialling for: nothing ran, the envelope that says so travels over
   *   the relay exactly as it does today, and paying the dial window for it would delay a refusal
   *   for no gain. The value matters only when no decision was recorded at offer time (the refusal
   *   path returns before the offer-time dial is started).
   * @returns {Promise<ReturnType<typeof p2pDeliveryMark>>}
   */
  async function planDirectDelivery(offer, status = null) {
    const taskId = typeof offer?.task_id === 'string' && offer.task_id !== '' ? offer.task_id : null;
    const dispatcherId =
      typeof offer?.origin_machine_id === 'string' && offer.origin_machine_id !== ''
        ? offer.origin_machine_id
        : null;

    /**
     * WebRTC first (v3.5.8). It is the preferred *data plane*, not the ledger: the relay copy is
     * still posted unconditionally by `deliver()`, so a WebRTC failure changes latency and the
     * `result_path` fact, never whether the result exists.
     */
    let webrtcAttempt = null;
    if (taskId !== null && status !== 'refused' && webrtcPool !== null && dispatcherId !== null) {
      webrtcAttempt = await sendResultWebRtc(taskId, dispatcherId);
      if (webrtcAttempt.delivered === true) {
        log('info', `result acknowledged over WebRTC for ${taskId}`, {
          rtt_ms: webrtcAttempt.rtt_ms,
          attempts: webrtcAttempt.attempts,
        });
        return p2pDeliveryMark({
          path: 'p2p',
          asked: true,
          rtt_ms: webrtcAttempt.rtt_ms,
          transport: 'webrtc-v1',
          attempts: webrtcAttempt.attempts,
        });
      }
      log('warn', `WebRTC result delivery failed for ${taskId}; trying the UDP direct path`, {
        attempts: webrtcAttempt.attempts,
        error: webrtcAttempt.error,
      });
    }

    if (taskId !== null && channelFor(taskId) === null) {
      // ---- the result-path reverse dial (v0.4.x) ---------------------------
      // No channel: the offer came over the relay, or it came over a channel the dispatcher has since
      // closed (it closes the one it pushed the offer over, immediately after the push). Before the
      // relay carries the result -- which it still does, unchanged, in every failure case -- this
      // machine tries once, bounded, to dial the dispatcher itself. The attempt is *reused* when the
      // offer-time dial is still running or already finished, so a task pays for one window at most,
      // never two.
      if (!(status === 'refused' && p2pReverseDials.get(taskId) === undefined)) {
        const record = startReverseDial(offer, { stage: 'result', afterLiveChannel: true });
        if (record !== null && record.attempted === true && record.promise !== null) {
          // Bounded by construction: `dial()` resolves at the tuning window or on the first answer.
          await record.promise;
        }
      }
    }

    const channel = channelFor(offer?.task_id);
    if (channel === null) {
      // No channel at all, so nothing about this task's data plane was ever sealed  - and the reason
      // recorded here is the one `offerTransportOf` already decided for `p2p.reason`.
      rememberNoChannel(offer?.task_id, offerTransportOf(offer, p2pStatusSnapshot()).reason);
      return p2pDeliveryMark({
        asked: webrtcAttempt !== null,
        error: webrtcAttempt?.error ?? null,
        attempts: webrtcAttempt?.attempts ?? 0,
        fallback_from: webrtcAttempt !== null ? 'webrtc-v1' : null,
      });
    }
    if (channel.stack === 'webrtc-v1') {
      // The only direct channel this task has is the WebRTC adapter; retrying it through the UDP
      // path would be a second attempt against the same stack, not the required UDP fallback.
      log('warn', `WebRTC result delivery failed for ${offer.task_id}; no UDP channel exists for this task`, {
        error: webrtcAttempt?.error ?? null,
      });
      return p2pDeliveryMark({
        asked: true,
        error: webrtcAttempt?.error ?? 'WEBRTC_RESULT_FAILED',
        attempts: webrtcAttempt?.attempts ?? 0,
      });
    }
    const direct = await sendResultDirect(offer.task_id);
    if (direct.delivered) {
      log('info', `result acknowledged over the direct channel for ${offer.task_id}`, {
        rtt_ms: direct.rtt_ms,
        fallback_from: webrtcAttempt !== null ? 'webrtc-v1' : null,
      });
      return p2pDeliveryMark({
        path: 'p2p',
        asked: true,
        rtt_ms: direct.rtt_ms,
        transport: 'udp-v1',
        attempts: 1,
        fallback_from: webrtcAttempt !== null ? 'webrtc-v1' : null,
      });
    }
    // A timeout is a reported failure; "no channel at all" is not, and `asked` keeps the two
    // apart for anything reading the agent's own diagnostics.
    log('warn', `direct result delivery failed for ${offer.task_id}; the relay copy is unaffected`, {
      error: direct.error,
    });
    return p2pDeliveryMark({
      asked: true,
      error: direct.error ?? webrtcAttempt?.error ?? null,
      attempts: 1,
      fallback_from: webrtcAttempt !== null ? 'webrtc-v1' : null,
    });
  }

  /**
   * Announce one result on its direct channel and wait for the acknowledgement, bounded.
   *
   * This is the fast path, and it is deliberately *only* a fast path: the relay copy is posted by
   * the caller whatever happens here, so nothing in this function can lose a result. The wait is
   * bounded by {@link P2P_ACK_TIMEOUT_MS} for the same reason -- a dispatcher that stops answering
   * must cost the ledger a bounded delay, never a hang.
   *
   * It is deliberately **not** retried. `P2PChannel.send` already retransmits every fragment until
   * the peer acknowledges it; a retry on top would be a second retransmission protocol layered on
   * the first, and "the dispatcher is gone" is not a condition that improves by asking again.
   *
   * @param {string} taskId
   * @returns {Promise<{delivered: boolean, rtt_ms: number|null, error: string|null}>}
   */
  async function sendResultDirect(taskId) {
    const channel = channelFor(taskId);
    if (channel === null) return { delivered: false, rtt_ms: null, error: null };

    /** Why the wait ended without an ack, when the channel itself said so. */
    let lastAckError = null;
    let registration = null;
    const acked = new Promise((resolve) => {
      const timer = setTimeout(() => {
        p2pResultWaiters.delete(taskId);
        resolve(false);
      }, p2pAckTimeoutMs);
      // Never keep the process alive for an acknowledgement.
      timer.unref?.();
      registration = {
        settle: (value, reason) => {
          clearTimeout(timer);
          if (p2pResultWaiters.get(taskId) === registration) p2pResultWaiters.delete(taskId);
          if (value === false && typeof reason === 'string' && reason !== '') lastAckError = reason;
          resolve(value);
        },
      };
      p2pResultWaiters.set(taskId, registration);
    });

    const startedAt = process.hrtime.bigint();
    // `machine_id` travels with the notice because the dispatcher has to be able to say *which*
    // machine finished without waiting for the relay's copy  - the plugin names its direct-result
    // inbox file after it. The frame still carries no envelope: `result_path` is decided by the
    // acknowledgement this frame is waiting for, and `envelope_sha256` covers `result_path`, so
    // sending the envelope first and stamping it afterwards would break the hash it is signed with.
    const frame = JSON.stringify({ type: 'task.result', task_id: taskId, machine_id: identity.machine_id });
    try {
      await channel.send(frame);
    } catch (error) {
      registration.settle(false, `P2P_SEND_FAILED: ${error?.message ?? String(error)}`);
    }

    const delivered = await acked;
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (delivered) return { delivered: true, rtt_ms: Math.round(elapsed * 100) / 100, error: null };
    return {
      delivered: false,
      rtt_ms: null,
      error: lastAckError ?? `P2P_ACK_TIMEOUT: no result.ack within ${p2pAckTimeoutMs}ms`,
    };
  }

  /** Build, spool, send and acknowledge one envelope. */
  async function finish(context) {
    const anchorsAfter = context.anchorsAfter ?? (await safePostState(context.offer, context.warnings));
    const toolchain = await toolchainInfo();
    // The bounded wait happens *before* the envelope is built, because `result_path` has to be
    // inside the envelope when `envelope_sha256` is taken; see `sendResultDirect`.
    const p2pDelivery = context.p2pDelivery ?? (await planDirectDelivery(context.offer, context.status));
    // Read once, here, and handed to `makeEnvelope`: the envelope has to describe the dial that
    // decided its `result_path`, and the record is released with the channel a moment later.
    const p2pReverse = context.p2pReverse ?? reverseDialSummary(context.offer?.task_id);
    const envelope = makeEnvelope({
      ...context,
      anchorsAfter,
      toolchain,
      comparePolicy: context.offer.compare_policy,
      p2pDelivery,
      p2pReverse,
    });
    await deliver(envelope);
    // The attempt is over. The channel lingers (bounded) so a duplicate of this attempt can still be
    // answered on it, and is released afterwards; the dial's own bookkeeping is consumed by the
    // envelope above and released with it, so a long-lived agent keeps one record per *live* task.
    releaseDialRecord(envelope.task_id);
    scheduleChannelRelease(envelope.task_id);



    return envelope;
  }

  /**
   * Spool -> POST to the relay -> ack.
   *
   * The spool is written first, so a crash anywhere later leaves a replayable envelope; the relay
   * copy is posted **unconditionally**, because the relay is the ledger and the only writer allowed
   * to store a machine's result. The direct copy has already been attempted and boundedly awaited
   * by the time this runs (`planDirectDelivery`), and a failure there changes nothing here -- which
   * is the property `test/p2p-agent.test.mjs` pins down with a dispatcher that stops answering.
   */
  async function deliver(envelope) {
    spool.saveEnvelope({
      task_id: envelope.task_id,
      attempt: envelope.attempt,
      dedupe_key: envelope.dedupe_key,
      envelope,
    });
    const response = await postJsonWithRetry('/v1/result', envelope);
    if (response?.ok) {
      spool.ack({ task_id: envelope.task_id, attempt: envelope.attempt });
      // Keep the delivered envelope around (bounded) so a transport re-delivery
      // of this same attempt is answered instead of executed again.
      rememberCompleted(identityKeyFor(envelope), envelope);
      log('info', `result delivered for ${envelope.task_id}`, {
        status: envelope.status,
        transport: envelope.transport,
        result_path: envelope.p2p?.result_path ?? 'relay',
      });
      return true;
    }
    log('warn', `result kept in spool for ${envelope.task_id}`, {
      status: response?.status ?? null,
      code: relayErrorCode(response),
    });
    return false;
  }

  /** Resolve the waiter for one result acknowledgement, if there is one. */
  function settleResultAck(taskId) {
    if (typeof taskId !== 'string' || taskId === '') return;
    const waiter = p2pResultWaiters.get(taskId);
    if (!waiter) {
      // An ack for an already-settled wait is ordinary: the direct copy is sent once, and a
      // dispatcher that re-acks a frame it processed twice must not resurrect anything.
      log('info', `result.ack for ${taskId} with no wait in flight`);
      return;
    }
    waiter.settle(true, null);
  }

  /** The delivered envelope for a dedupe key, for `enqueue`'s cache branch. */
  const cachedResult = (key) => completed.get(key);

  return {
    p2pStatusSnapshot,
    refreshP2PStatus,
    configureP2P,
    startP2P,
    closeP2P,
    rememberChannel,
    channelFor,
    rememberChannelEncryption,
    encryptionFor,
    rememberNoChannel,
    startReverseDial,
    reverseDialSummary,
    releaseChannel,
    scheduleChannelRelease,
    releaseDialRecord,
    p2pStunServers,
    envelopeP2P,
    makeEnvelope,
    planDirectDelivery,
    sendResultDirect,
    sendResultWebRtc,
    attachWebRtc,
    webrtcStatusSnapshot,
    finish,
    deliver,
    settleResultAck,
    flushSpool,
    reportInterrupted,
    cachedResult,
    get p2pNode() {
      return p2pNode;
    },
  };
}
