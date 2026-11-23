/**
 * The Localside agent: everything between "Rabbit hands us an offer" and
 * "Rabbit has our envelope".
 *
 * Flow, in the order the contract requires it:
 *
 *   pair -> SSE long-poll -> offer -> **spool first** -> capability gate ->
 *   anchors -> execute -> anchors -> envelope -> spool -> POST -> ack -> delete
 *
 * Notable decisions, all traceable to the protocol:
 *
 *   * `shell_id` is always `direct-exec` (§5.1); a shell is never used.
 *   * The command allow-list is **default-deny**: an empty list refuses
 *     everything, and an offer may only run an argv that *starts with* one of
 *     the configured prefixes.
 *   * Capability mismatches are `refused` with a reason code, never a silent
 *     downgrade (§6.1).
 *   * The lease is renewed by heartbeat only; the agent never decides on its
 *     own that a lease expired (§4.3) -- Rabbit's clock is authoritative.
 *   * Reconnect backoff is exactly 500ms -> 1s -> 2s -> 4s -> 8s -> 10s with
 *     50%-100% jitter, matching DSH's own behaviour so it is predictable.
 *
 * ## P1/S4: this file is the assembly; the lifecycle lives in `./lifecycle/`
 *
 * The one `createAgent()` closure was split into four lifecycle phases, composed
 * here in dependency order:
 *
 *   shared     constants + pure helpers + the HTTP/pairing client       (~1.3k)
 *   deliver    result envelope + relay/P2P result path                  (~1.6k)
 *   execute    argv execution, timeout/cancel, workspace evidence       (~0.7k)
 *   offer      offer intake, gates, allow-list, lease heartbeat, queue   (~0.6k)
 *   heartbeat  SSE stream, frame dispatch, reconnect, state file        (~0.8k)
 *
 * The module's public surface is exactly the old one: the phase modules are
 * re-exported below, so every import site (`bin/`, `src/plugin/tools/*`, tests)
 * is unchanged. The ordering of side effects is preserved deliberately -- the
 * comments that explain the order moved with the code they describe, and the
 * phase seams are commented where the one closure was cut.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultExecCapabilityFile } from '../util/exec-capability.mjs';
import { DEVICE_KEY_FILE, DeviceKey, PeerKeyStore } from './crypto.mjs';
import { createSpool } from './spool.mjs';
import { matchAllowedCommand, parseAllowedCommands } from './allowed-commands.mjs';
import { DEFAULT_P2P_MODE, normalizeP2PMode, normalizeP2PPort } from './p2p-node.mjs';
import { createSigner } from '../signing.mjs';
import { gitVersion } from './git.mjs';
import { resolveBaseUrl } from './url.mjs';

import {
  AGENT_STATE_FILE,
  AGENT_STATE_PUBLISH_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  IDLE_HEARTBEAT_INTERVAL_MS,
  P2P_CHANNEL_LINGER_MS,
  P2P_RESULT_ACK_TIMEOUT_MS,
  createAgentShared,
  isWritableProject,
  summarizeRtt,
} from './lifecycle/shared.mjs';
import { createDeliverPhase } from './lifecycle/deliver.mjs';
import { createExecutePhase } from './lifecycle/execute.mjs';
import { createOfferPhase } from './lifecycle/offer.mjs';
import { createHeartbeatPhase } from './lifecycle/heartbeat.mjs';

// The allow-list matcher lives in its own module because the plugin's
// dispatch-time pre-flight must apply the *same* rule. It is imported above for
// this module's own use and re-exported here so the exports of this module are
// unchanged: the CLI and `test/agent.test.mjs` have always imported these two
// names from the agent.
export { matchAllowedCommand, parseAllowedCommands };

// The constants and pure helpers (plus the two module-level functions that used
// to live at the bottom of this file) are re-exported from the shared phase
// module, so every existing import site keeps working unchanged.
export {
  AGENT_STATE_FILE,
  AGENT_STATE_PUBLISH_INTERVAL_MS,
  AGENT_STATE_SCHEMA_VERSION,
  BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  ENVELOPE_VERSION,
  HEARTBEAT_INTERVAL_MS,
  Heartbeat,
  IDLE_HEARTBEAT_INTERVAL_MS,
  MAX_HEARTBEAT_RTT_MS,
  MAX_IMMEDIATE_RESTART_RECONNECTS,
  P2P_CHANNEL_LINGER_MS,
  P2P_CHANNEL_LIVE,
  P2P_OPENED_BY,
  P2P_RESULT_ACK_TIMEOUT_MS,
  P2P_REVERSE_DIAL_FAILED,
  P2P_REVERSE_DIAL_TIMEOUT,
  PROTOCOL_VERSION,
  RECONNECT_DELAY_AFTER_STABLE_MS,
  REFUSAL,
  REQUIRED_ENVELOPE_FIELDS,
  RTT_WINDOW,
  SHELL_ID,
  STABLE_STREAM_MS,
  STATE_RENAME_ATTEMPTS,
  STATE_RENAME_BACKOFF_MS,
  SseParser,
  TRANSPORT_VALUES,
  backoffDelay,
  buildEnvelope,
  compareVersions,
  cursorUsableFor,
  evaluateGate,
  heartbeatDiagnostics,
  isWritableProject,
  offerTransportOf,
  p2pDeliveryMark,
  parseP2PFrame,
  satisfiesVersion,
  sleep,
  summarizeRtt,
  verifyEnvelope,
} from './lifecycle/shared.mjs';

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AgentOptions
 * @property {string} rabbitUrl Base address; a sub-path is allowed
 *   (`https://host/w2m`), a query string or fragment is rejected. See ./url.mjs.
 * @property {string} project Absolute project root.
 * @property {string} stateDir Directory for spool/state (never the project).
 * @property {object} identity `{machine_id, machine_name, device_token, rabbit_url}`.
 * @property {Record<string, unknown>} caps
 * @property {{os: string, os_version: string, arch: string, shell: string, shell_version: string|null}} platform
 * @property {string[][]} [allowedCommands]
 * @property {boolean} [once]
 * @property {(level: string, message: string, extra?: object) => void} [log]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [heartbeatIntervalMs]
 * @property {number} [maxOutputBytes]
 * @property {'temp'|'project'} [objectMode]
 * @property {string} [tmpDir]
 * @property {number} [onceIdleMs]
 * @property {number} [resultRetries]
 * @property {number} [statePublishIntervalMs] Idle refresh cadence for the
 *   diagnostics file; 0 disables it (task-16).
 * @property {string|null} [operatorToken] Only needed when this host submits
 *   tasks itself (v0.1.2 §5); never sent by the Localside agent.
 * @property {string} [p2pMode] `auto` (default), `direct` or `relay` (v0.4.0). Anything
 *   else is a `TypeError` naming {@link normalizeP2PMode}'s reason: a mode is a wire value,
 *   so a typo must fail at the call site rather than degrade into a silent default.
 * @property {string[]|string} [stunServers] Complete STUN list, in query order, for the
 *   agent's own node. See {@link stunServersWithShared}.
 * @property {number|null} [p2pPort] Local UDP port the punch socket binds, 1..65535; `null`
 *   or omitted means an ephemeral port, which is the default. A machine that must **accept**
 *   a punch needs a stable port: an ephemeral one changes on every restart, so a firewall
 *   rule has to be re-pointed after each start and every dispatch falls back to the relay in
 *   the meantime (`P2P_PUNCH_TIMEOUT` on the dispatcher, `offer_path: relay` in the ledger).
 *   Anything that is not a valid port is reported as a `P2P_PORT_INVALID` start failure, never
 *   thrown -- see {@link normalizeP2PPort} and `startP2P()`, which treats it like every other
 *   P2P error: recorded, and never fatal to the relay path.
 * @property {P2PNode|((options: object) => P2PNode)} [p2pNode] The node to use. An
 *   instance is adopted; a function is called with the derived options. Injectable
 *   because a test needs a real socket and a deterministic discovery answer, and
 *   because `test/outbound-only.test.mjs` counts binds through it.
 * @property {object} [p2pNodeOptions] Extra `P2PNode` constructor options, merged last.
 * @property {number} [p2pAckTimeoutMs] Bounded wait for `result.ack` on the direct
 *   channel; see {@link P2P_RESULT_ACK_TIMEOUT_MS}.
 * @property {(status: object) => void} [onP2PStatus] Called with a snapshot of the agent's
 *   P2P facts whenever they change (the node starting, an announcement, an error). Push,
 *   not poll: the plugin's `w2m_status` must not have to ask repeatedly.
 * @property {object|null} [webrtcPool] The per-peer `webrtc-v1` pool owned by the composition
 *   root. When present, result delivery tries WebRTC first, falls back to the UDP channel, and
 *   always posts the envelope to the relay. The agent borrows it and never stops it.
 * @property {(() => object|null)|null} [getWebRtcPool] Late-bound pool resolver (v3.6.0 P3).
 *   The production profile mounts `dsh-p2p-webrtc` after the root row, so the pool may not exist
 *   when this agent is built. Every WebRTC consumer calls this getter when it needs the pool;
 *   `webrtcPool` above stays as the constructor-time fallback for isolated tests.
 * @property {(() => {owner?: string|null}|null)|null} [getWebRtcPoolState] Optional late-bound
 *   registry state reader, used only to put `pool_owner` in diagnostics and viewer acks.
 */

/**
 * Build an agent instance.
 *
 * @param {AgentOptions} options
 */

export function createAgent(options) {
  const {
    rabbitUrl,
    project,
    stateDir,
    identity,
    identityPath = null,
    caps,
    platform,
    once = false,
    fetchImpl = globalThis.fetch,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    maxOutputBytes,
    // v1.2.6: filter secrets out of the readable envelope fields. Off is allowed and marked `unredacted: true`.
    redactOutput = true,
    objectMode = 'temp',
    tmpDir,
    onceIdleMs = 0,
    resultRetries = 4,
    operatorToken = null,
    statePublishIntervalMs = AGENT_STATE_PUBLISH_INTERVAL_MS,
    idleHeartbeatIntervalMs = IDLE_HEARTBEAT_INTERVAL_MS,
    onP2PStatus = () => {},
    p2pAckTimeoutMs = P2P_RESULT_ACK_TIMEOUT_MS,
    p2pChannelLingerMs = P2P_CHANNEL_LINGER_MS,
    // v3.5.8: the per-peer WebRTC pool, injected by the composition root that owns it. Null means
    // "this process has no WebRTC data plane"; the UDP and relay paths are unchanged.
    webrtcPool = null,
    getWebRtcPool = null,
    getWebRtcPoolState = null,
  } = options;

  // Normalise here so every caller gets the same contract: the documented
  // `string | string[][]` form is accepted, and a bare string list such as
  // `['node --test']` cannot reach `.map((prefix) => prefix.join(' '))`.
  const allowedCommands = parseAllowedCommands(options.allowedCommands ?? []);
  // v1.4.2: the UI-activated Node-code-execution capability. Read before every task, so turning the switch in the
  // plugin UI takes effect on the next task without restarting the agent; an expired temporary activation denies.
  const execCapabilityFile = options.execCapabilityFile ?? defaultExecCapabilityFile();

  if (!rabbitUrl) throw new TypeError('createAgent: rabbitUrl is required');
  if (!project) throw new TypeError('createAgent: project is required');
  if (!stateDir) throw new TypeError('createAgent: stateDir is required');
  if (!identity?.machine_id) throw new TypeError('createAgent: identity.machine_id is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('createAgent: no fetch implementation available');

  // v0.4.0: the mode is validated at construction, with the same loud helper the node and the
  // CLI use. `normalizeP2PMode` rejects `'AUTO'`, `' auto '` and friends by name; doing that here
  // means an unusable mode can never reach `start()` as a half-started agent.
  const p2pModeInput = options.p2pMode === undefined ? DEFAULT_P2P_MODE : options.p2pMode;
  const normalizedMode = normalizeP2PMode(p2pModeInput);
  if (!normalizedMode.ok) throw new TypeError(`createAgent: ${normalizedMode.reason}`);
  const p2pMode = normalizedMode.mode;

  // The punch port is validated at construction with the same named helper the CLI uses, but an
  // unusable value is *not* thrown: a machine whose P2P settings are wrong must still work over the
  // relay, so it becomes a start failure (`P2P_PORT_INVALID`) reported by `startP2P()` exactly like
  // `P2P_NODE_INVALID` or `P2P_BIND_FAILED`. The error is recorded here and logged where the node
  // would have been built.
  const p2pPortResult = normalizeP2PPort(options.p2pPort);
  const p2pPort = p2pPortResult.ok ? p2pPortResult.port : null;
  const p2pPortError = p2pPortResult.ok ? null : `P2P_PORT_INVALID: ${p2pPortResult.reason}`;

  if (typeof onP2PStatus !== 'function') throw new TypeError('createAgent: onP2PStatus must be a function');
  if (typeof p2pAckTimeoutMs !== 'number' || !Number.isFinite(p2pAckTimeoutMs) || p2pAckTimeoutMs < 0) {
    throw new TypeError('createAgent: p2pAckTimeoutMs must be a non-negative number of milliseconds');
  }
  if (
    webrtcPool !== null &&
    (typeof webrtcPool !== 'object' ||
      typeof webrtcPool.send !== 'function' ||
      typeof webrtcPool.onMessage !== 'function')
  ) {
    throw new TypeError('createAgent: webrtcPool must expose send() and onMessage()');
  }
  if (getWebRtcPool !== null && typeof getWebRtcPool !== 'function') {
    throw new TypeError('createAgent: getWebRtcPool must be a function or null');
  }
  if (getWebRtcPoolState !== null && typeof getWebRtcPoolState !== 'function') {
    throw new TypeError('createAgent: getWebRtcPoolState must be a function or null');
  }

  // Validate + normalise once, at construction: a `rabbitUrl` carrying a query
  // string, a fragment or a non-http scheme must fail loudly here rather than
  // turn into mysterious 404s at request time. Sub-paths are preserved.
  const baseUrl = resolveBaseUrl(rabbitUrl);

  // ---- v0.3.0 request signing ------------------------------------------
  // Absent/`null`/`''` means "signing is not configured", and in that case **not
  // one signing header is added anywhere** -- the wire stays byte-identical to
  // v0.2.3, which is the backward-compatibility gate the tests pin down. The
  // empty string is the explicit "off" spelling (same convention as the relay's
  // `--require-signature` settings), so it disables rather than throws.
  //
  // Any *other* unusable value is an error instead of a silent downgrade: a
  // caller who passes a number, an object or `true` meant to configure signing,
  // and quietly giving them an unsigned link is exactly the silent degradation
  // §0 forbids. `signing.mjs`'s `BAD_SECRET` exists for this distinction.
  const signingSecret = options.signingSecret ?? null;
  if (signingSecret !== null && typeof signingSecret !== 'string') {
    throw new TypeError(
      `createAgent: signingSecret must be a string (got ${typeof signingSecret}); ` +
        "pass '' or omit it to disable signing",
    );
  }
  const signer = signingSecret === null || signingSecret === ''
    ? null
    : createSigner({ secret: signingSecret, ...(options.signerOptions ?? {}) });

  const log = options.log ?? (() => {});
  const spool = createSpool(stateDir);

  // -- v0.6.0: the machine's identity on the direct path --------------------
  //
  // Loaded here, at construction, rather than lazily at `start()`: the key file is also what a
  // *dispatcher* publishes in an offer, and "which key will this machine present" must not depend on
  // whether a particular code path happened to have run yet. `loadOrCreate` is the documented rule
  // ("generated the first time a machine pairs"), and a failure is never fatal  - see `deviceKeyError`.
  const deviceKeyOutcome = loadDeviceKey(options.deviceKey ?? null, stateDir, identity.machine_id, identityPath);
  /** @type {object|null} This machine's static keypair, or null when there is none. */
  const deviceKey = deviceKeyOutcome.key;
  /** @type {string|null} Why there is no key, when there is none. Reported, never thrown. */
  const deviceKeyError = deviceKeyOutcome.error;
  /**
   * A key adopted from the pre-v0.6.2 location (`--state/device.key`). Reported once at startup,
   * because a machine whose key moved is a machine whose public key a peer may have learned under the
   * old file  - silence here would make "my peers stopped talking to me" have no visible cause.
   */
  const deviceKeyMigratedFrom = deviceKeyOutcome.migratedFrom ?? null;
  /**
   * Peer static keys, learned from offers.
   *
   * One store for the whole agent, handed to the node rather than copied: the agent learns a key when
   * an offer arrives (which is the only place it is ever told one) and the node needs it moments later
   * when it dials. Two stores would be two chances to have the key in the wrong one.
   *
   * @type {PeerKeyStore}
   */
  const peerKeys = new PeerKeyStore();

  /**
   * Absolute path of the cross-process diagnostics file (task-16).
   *
   * Deliberately under `stateDir` (the `--state` directory), not next to
   * `device.json`: the spool, the state and this file belong together, and a
   * read-only project must never be written to.
   */
  const stateFilePath = join(stateDir, AGENT_STATE_FILE);

  const state = {
    seq: 0,
    connected: false,
    handled: 0,
    stopped: false,
    /** `relay_id` of the relay we are currently talking to (v0.1.2 §8.3). */
    relayId: null,
    /**
     * `relay_id` that issued `state.seq`, or null when the cursor cannot be
     * attributed to a relay process (pre-v0.1.2 relay, or none yet).
     */
    cursorRelayId: null,
    /**
     * Set when a relay restart makes the *current* stream unusable: it was
     * opened with the previous process's cursor, so it has already skipped the
     * new process's early events and must be replaced.
     */
    streamRestartRequested: false,
    /** How many times a relay restart was detected. */
    relayIdChanges: 0,
    /** Last `REPLAY_TRUNCATED` notice we had to act on (v0.1.2 §8.4). */
    replayTruncated: null,
    /** Rolling heartbeat round-trip times, read by `w2m_status` (§8.2). */
    rttMs: summarizeRtt([]),
    /**
     * Consecutive unstable reconnects: 0 once a stream has stayed up for
     * {@link STABLE_STREAM_MS}, incremented for each reconnect before that.
     *
     * Published as `unstable_reconnects` in both channels (the heartbeat and
     * `agent-state.json`) so they agree by construction. The JavaScript property
     * keeps the shorter historical name because `scripts/probe-restart.mjs`
     * reads it; `unstableReconnects` is the same value under the published name.
     */
    get reconnectAttempts() {
      return deps.heartbeat.reconnectAttempt;
    },
    /** Alias of {@link reconnectAttempts}, spelled like the published field. */
    get unstableReconnects() {
      return deps.heartbeat.reconnectAttempt;
    },
    /** Path of the published diagnostics file. */
    stateFile: stateFilePath,
    /** `updated_at` of the last successful publish, or null. */
    statePublishedAt: null,
    /**
     * Last non-2xx response from the relay, with its own error code preserved
     * (v0.3.0). On a signed link this is what distinguishes "your clock drifted
     * outside the window" from "your secret is wrong".
     */
    lastRelayError: null,
    /**
     * The agent's P2P facts (v0.4.0): mode, whether the node is running, what it announced, how
     * many punches went each way, and the start error when there is one.
     *
     * A getter rather than a field because every read must be a *fresh* plain object: this is
     * published to another process (the plugin's `w2m_status`), and a shared object would let a
     * reader mutate the agent's own view of its transport. The full node status -- including the
     * reflexive address and candidate list -- is available from `agent.p2pNode`.
     */
    get p2p() {
      return deps.deliver.p2pStatusSnapshot();
    },
    /** @type {object|null} */
    current: null,
  };

  /** Detected tool versions, resolved once per process (git needs a spawn). */
  let toolchainCache = null;
  async function toolchainInfo() {
    if (toolchainCache) return toolchainCache;
    let git = null;
    try {
      git = await gitVersion({ cwd: project });
    } catch {
      git = null;
    }
    // Guarded above by `if (toolchainCache) return`, and two concurrent callers would derive the same
    // value from immutable project facts -- the worst case is doing the work twice, not caching
    // something wrong.
    // eslint-disable-next-line require-atomic-updates -- guarded memo; value derived from immutables
    toolchainCache = {
      node: caps.node ?? null,
      python: caps.python ?? null,
      npm: caps.npm ?? null,
      git,
      plugin_version: (() => {
        try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version ?? null; } catch { return null; }
      })(),
      joint_dev: 'v2',
    };
    return toolchainCache;
  }

  // ---- composition --------------------------------------------------------
  //
  // One explicit bag instead of a closure over forty locals. The factories are
  // called in dependency order -- deliver receives nothing from the other
  // phases, execute needs deliver's `finish`, offer needs both, and the
  // heartbeat needs offer's and deliver's frame handlers -- so the phase graph is
  // acyclic and `deps` reads happen at call time.
  const deps = {
    options,
    rabbitUrl,
    baseUrl,
    project,
    stateDir,
    identity,
    caps,
    platform,
    log,
    spool,
    allowedCommands,
    execCapabilityFile,
    signer,
    fetchImpl,
    stateFilePath,
    peerKeys,
    deviceKey,
    deviceKeyError,
    deviceKeyMigratedFrom,
    p2pMode,
    p2pPort,
    p2pPortError,
    onP2PStatus,
    p2pAckTimeoutMs,
    p2pChannelLingerMs,
    webrtcPool,
    getWebRtcPool,
    getWebRtcPoolState,
    heartbeatIntervalMs,
    idleHeartbeatIntervalMs,
    statePublishIntervalMs,
    resultRetries,
    redactOutput,
    objectMode,
    tmpDir,
    maxOutputBytes,
    once,
    onceIdleMs,
    isWritableProject,
    toolchainInfo,
  };

  // The published diagnostics object is built before the phases (the HTTP client
  // records `state.lastRelayError` on every refusal), and its two live getters
  // read through `deps` so they keep answering from the owning phase -- the same
  // values the single closure read from its `let` bindings.
  deps.state = state;

  const http = createAgentShared(deps);
  deps.http = http;
  const deliver = createDeliverPhase(deps);
  deps.deliver = deliver;
  const execute = createExecutePhase(deps);
  deps.execute = execute;
  const offer = createOfferPhase(deps);
  deps.offer = offer;
  const heartbeat = createHeartbeatPhase(deps);
  deps.heartbeat = heartbeat;

  const { handleOffer } = offer;
  const { dispatchFrame } = heartbeat;
  const { p2pStunServers } = deliver;

  return {
    start: heartbeat.start,
    stop: heartbeat.stop,
    pair: http.pair,
    flushSpool: deliver.flushSpool,
    reportInterrupted: deliver.reportInterrupted,
    handleOffer,
    get state() {
      return state;
    },
    spool,
    identity,
    caps,
    platform,
    allowedCommands,
    /** Write the diagnostics file now (also done automatically; task-16). */
    publishState: heartbeat.publishState,
    /** Send one idle diagnostic heartbeat now (v0.3.0). */
    sendIdleHeartbeat: heartbeat.sendIdleHeartbeat,
    /**
     * The direct path, for a caller that needs more than the summary (v0.4.0).
     *
     * Null in `relay` mode forever, and null until `start()` has built one. Exposed rather than
     * hidden because "which port did this machine announce?" is a question an operator asks with
     * `netstat` open, and the answer belongs to the object that owns the socket.
     */
    get p2pNode() {
      return deliver.p2pNode;
    },
    /**
     * The injected per-peer WebRTC pool, or null.
     *
     * Exposed so a dispatcher in the same process can reuse the one pool rather than constructing a
     * second one on the same machine id -- two pools would claim the same signaling role for every
     * pair. The agent does not own the pool's lifetime; the composition root that built it does.
     */
    get webrtcPool() {
      if (typeof getWebRtcPool === 'function') {
        try {
          const current = getWebRtcPool();
          if (current !== null && typeof current === 'object') return current;
        } catch {
          /* fall through to the constructor-time pool */
        }
      }
      return webrtcPool;
    },
    /** A snapshot of the WebRTC data-plane facts, safe to serialise. */
    get webrtcStatus() {
      return deliver.webrtcStatusSnapshot();
    },
    /** The mode this agent was built with, validated at construction. */
    p2pMode,
    /** The STUN list the node queries, in order; null when there is no node. */
    p2pStunServers,
    /** Bring the direct path up on its own (also done by `start()`); never fatal. */
    startP2P: deliver.startP2P,
    /** Close the direct path on its own (also done by `stop()`). */
    closeP2P: deliver.closeP2P,
    /**
     * Feed one already-decoded frame into the dispatcher both transports use (v0.4.0).
     *
     * Exists because "an offer from a channel" and "an offer from the relay" differ in exactly one
     * value, and a caller that needs a specific arrival order -- a test, or a future tool that
     * injects a frame -- should not have to open a socket to express it. `transport` is the only
     * thing it controls; the dedupe, the queue and the result path are the same code either way,
     * which is what makes an injected frame a fair test of the real path.
     *
     * @param {object} payload A frame (`{type:'task.offer', ...}`).
     * @param {{transport?: 'p2p'|'relay', channel?: object}} [origin]
     */
    ingest(payload, origin = {}) {
      dispatchFrame(payload, {
        event: typeof payload?.type === 'string' ? payload.type : 'message',
        id: null,
        transport: origin.transport === 'p2p' ? 'p2p' : 'relay',
        channel: origin.channel,
      });
    },
    /** Whether request signing is configured (v0.3.0). */
    signingEnabled: signer !== null,
    /** Absolute path of the published diagnostics file. */
    stateFile: stateFilePath,
    /** Normalised base address actually used for every request (v0.1.2 §2). */
    baseUrl,
    /**
     * Operator token, when this host also submits tasks (v0.1.2 §5).
     *
     * The Localside agent never POSTs `/v1/task`, so this is carried for local
     * tooling (`w2m_status`, host-side scripts) and is never put on the wire by
     * this process. It is deliberately not persisted to disk either.
     */
    operatorToken: operatorToken ?? null,
  };
}

/**
 * Load this machine's static keypair, or explain why there is none (v0.6.0).
 *
 * Never throws. A machine whose key file is unreadable is still a working W2M machine  - every task
 * still travels over the relay  - and `agent.state.p2p.encryption.error` names the file that could not
 * be read so an operator can fix it. Refusing to start an agent because a *security upgrade* could not
 * complete is exactly the fleet-losing failure `docs/P2P-CRYPTO.md` §4 forbids.
 *
 * WHERE THE KEY LIVES, AND THE BUG THAT CAME FROM GETTING IT WRONG (v0.6.2)
 *
 * `DeviceKey.load` documents the rule as "`device.key` **beside `device.json`**", and this function
 * used to break it: it loaded from the `--state` directory, justified by a comment claiming that
 * `identity.mjs` puts `device.json` there "when the agent is run with `--state`". That claim is false.
 * `device.json` is fixed at `<DSH_HOME>/xclient/device.json` by the identity contract and `--state`
 * does not move it  - which is why an agent run as `--state ~/.dsh/xclient/localside-mac` had its
 * identity one directory *above* its key.
 *
 * The measured consequence, on one machine running both halves of W2M: the plugin (which loads the key
 * correctly, from `dirname(device.json)`) and the agent each generated a *different* pair, and both
 * announced to the one `/v1/peer/{machine_id}` slot  - the relay's record alternated between the two
 * nodes' ports every few seconds, and the `static_key` a dispatcher read was one node's or the other's.
 * A dispatcher that learns the wrong key cannot arm a handshake, so every direct channel came back
 * `P2P_CRYPTO_PLAINTEXT_PEER`  - reported as "the peer is an older build" when both ends were the same
 * build on the same host.
 *
 * MIGRATION. `DeviceKey.load` warns that "silently generating a replacement key would make every peer
 * that knows the old one refuse this machine". So a key already generated in the old location is
 * adopted rather than abandoned: canonical first, then a copy forward from `--state`, then generate.
 *
 * @param {object|null} injected A `DeviceKey`, or null to load or generate one.
 * @param {string} stateDir The `--state` directory; the key's home only when `deviceFile` is absent.
 * @param {string} machineId
 * @param {string|null} [deviceFile] Absolute path of the `device.json` this agent loaded. The key
 *   belongs beside it; pass the path the caller resolved rather than re-resolving `DSH_HOME` here.
 * @returns {{key: object|null, error: string|null, migratedFrom: string|null}}
 */
function loadDeviceKey(injected, stateDir, machineId, deviceFile = undefined) {
  if (injected !== null && injected !== undefined) {
    if (typeof injected.sharedSecret !== 'function' || typeof injected.publicKeyBase64 !== 'string') {
      return { key: null, error: 'P2P_CRYPTO_NO_KEY: the injected deviceKey is not a DeviceKey', migratedFrom: null };
    }
    return { key: injected, error: null, migratedFrom: null };
  }

  // Beside `device.json`  - the documented rule. `identityPath` is the path the caller actually
  // loaded, never a fresh global resolution: resolving `DSH_HOME` here would make a test (or any
  // caller with an injected identity) read and *create* a key in the real user's home.
  let canonicalDir = null;
  if (typeof deviceFile === 'string' && deviceFile !== '') canonicalDir = dirname(deviceFile);

  const legacyPath = join(stateDir, DEVICE_KEY_FILE);

  /**
   * Candidates in order. `mayCreate` is the whole subtlety: only a location that is *the* documented
   * home may mint a key. A legacy directory is consulted to adopt a key that is already there, never
   * to create one  - `DeviceKey.load` warns that generating a replacement "would make every peer that
   * knows the old one refuse this machine", so an upgrade must not silently change this machine's
   * public key.
   *
   * With no `identityPath` the caller injected its own identity and there is no canonical home, so
   * `--state` keeps the pre-v0.6.2 behaviour of being able to create. That is what stops a test or an
   * embedder from reading and writing the real user's `~/.dsh/xclient`.
   */
  const candidates =
    canonicalDir === null
      ? [{ dir: stateDir, mayCreate: true, from: null }]
      : [
        { dir: canonicalDir, mayCreate: true, from: null },
        ...(existsSync(legacyPath) ? [{ dir: stateDir, mayCreate: false, from: legacyPath }] : []),
      ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const loaded = DeviceKey.load({ dir: candidate.dir, machineId });
      if (candidate.mayCreate === false && loaded.created) continue;
      return { key: loaded.key, error: null, migratedFrom: candidate.from };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError !== null) {
    return {
      key: null,
      error: `P2P_CRYPTO_KEY_UNREADABLE: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      migratedFrom: null,
    };
  }
  return { key: null, error: null, migratedFrom: null };
}
