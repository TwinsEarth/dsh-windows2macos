/**
 * Dispatch-domain tools: w2m_run, w2m_wait, w2m_report, w2m_history, w2m_tasks, w2m_cancel,
 * w2m_reduce.
 *
 * Each `register<Name>(ctx, deps)` factory is invoked by `apply()` in the same order the tools have
 * always been registered; the body is the same block that used to be inline in `apply()`, with the
 * apply-scope glue it closed over now arriving through `deps`.
 */

import { randomUUID } from 'node:crypto';
// The allow-list matcher is shared with the agent on purpose: this plugin's pre-flight exists so a
// dispatcher does not send work the target machine would refuse, so the two ends must apply the
// same rule, token for token. See `src/agent/allowed-commands.mjs`.
import { matchAllowedCommand, parseAllowedCommands } from '../../agent/allowed-commands.mjs';
import { mintPunchId } from '../../agent/p2p.mjs';
// v0.22.0: the permission gate. Imported rather than reimplemented for the same reason as everything else
// here -- a second copy of the escalation rule is a second chance to disagree with the first about how far
// below a requirement an actor may still ask.
import { gateDispatch, approvalRequestFor, raiseApproval } from '../../agent/permission.mjs';
// The result-deduplication identity the relay mints. Imported rather than re-implemented: the value
// is compared byte for byte by the executor, so a second copy of the formula that drifted by one
// character would turn "delivered twice, executed once" into "executed twice" -- the exact failure
// the dedupe key exists to prevent.
import { SHELL_ID_DIRECT, computeCommandHash, computeDedupeKey } from '../../relay/state.mjs';
import { resolveCurrentVersion } from '../auto-update.mjs';
import { defaultSelectionStore, dispatchSelectionFields, isSelectableDevice, readFleet, sessionKeyFor } from '../fleet-target.mjs';
import { evaluateVersionGate, isVersionGateActive, MIN_SUPPORTED_PLUGIN_VERSION, VERSION_GATE_CODES } from '../version-gate.mjs';
import { buildBoard } from '../task-graph.mjs';
import { verifyEnvelopeSignature } from '../../util/envelope-signature.mjs';
import { buildReducePlan } from '../../util/dataflow.mjs';
import { suggestReduce } from '../../util/reduce-suggestion.mjs';

import { AGGREGATE_STATES, configError, inProcessWebRtcPool, MAX_EXCERPT_BYTES, NON_TERMINAL_AGGREGATE, NON_TERMINAL_OUTCOME, offerP2PFor, PROTOCOL_VERSION, reasonCodeOf, REFUSAL_CODE, request, requestFleetJoin, requireRabbit, resolveGitAnchors, resolveToken, throwIfAborted, W2MError } from './shared.mjs';

/**
 * Upper bound on how many tasks w2m_history will ask the relay for.
 *
 * The relay has its own cap; this one exists so a model asking for a very large page cannot make
 * *this* machine allocate it, and so the number is visible where the tool that uses it lives.
 */
const MAX_HISTORY_LIMIT = 200;

/**
 * Upper bound on `stages` for a pipeline task, mirroring the relay's limit.
 *
 * Declared here rather than imported so the plugin refuses an oversized chain on its own authority:
 * a request that is going to be rejected by the relay anyway should not have to cross the network to
 * find out, and the message the caller sees should name the stage rather than the HTTP status.
 */
const MAX_STAGES = 16;

/** Wall-clock ceiling for one `w2m_wait` call, in milliseconds. */
const MAX_WAIT_MS = 600_000;

/** Wall-clock ceiling for one command handed to the machines, in milliseconds. */
const MAX_TASK_TIMEOUT_MS = 3_600_000;

/** Lower bound, in milliseconds, on the interval between two status polls. */
const MIN_POLL_MS = 25;

/** Largest report body this plugin will read, in bytes. */
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** HTTP statuses worth one more attempt: the request did not reach a decision. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * How long this plugin waited, and whether it needs the Rabbit operator to look.
 *
 * A `timeout` envelope is precisely the case PROTOCOL §4.3 leaves to the Rabbit's clock, so the
 * hint points there rather than pretending the local wait was authoritative.
 *
 * @param {string} taskId
 * @param {string[]} states States still running when we gave up.
 * @returns {object}
 */
function timeoutEnvelope(taskId, states) {
  return {
    ok: true,
    complete: false,
    task_id: taskId,
    state: 'timeout',
    states,
    note:
      'the wait window elapsed before every machine reached a terminal state; this is a local ' +
      'observation only, not a verdict on the machines',
    hint: 'raise wait_ms, or call w2m_wait again to continue from where this left off',
  };
}

/**
 * The `p2p` block a dispatch publishes through the relay, and what it is for.
 *
 * WHAT THE EXECUTOR CANNOT DO WITHOUT IT
 *
 * A dispatcher behind a symmetric NAT (CGNAT, in practice) can send all it likes and still be heard
 * by nobody: its outbound HELLO opens its own mapping, but the peer's filter stays shut until
 * *something of the peer's* has gone the other way. So the executor has to dial first  - and to dial
 * it needs two things the offer itself can carry: where the dispatcher says it is, and which punch
 * to join. Without them the executor has only the relay lookup, which is a second opinion about the
 * same machine that answers 404 for a dispatcher whose announcement has just expired.
 *
 * WHY A PUNCH ID RATHER THAN A SESSION ID
 *
 * The session id cannot be known when this request is written: one dispatch leases one task to
 * several machines, and the relay decides which  - in the same request that mints the task id. A
 * single session shared by those machines would be a defect, not a simplification: on the
 * dispatcher's own node the second machine's HELLO would look like a re-acknowledgement of the
 * first machine's live channel, so one of them would have its result delivered to the other's
 * address. The block therefore publishes a per-dispatch *punch id*, and both ends derive the same
 * per-machine session from it (`punchSession` in `src/agent/p2p.mjs`): the dispatcher from the
 * lease, the executor from the offer plus its own machine id. The pushed frame  - which is addressed
 * to one machine, so the value *is* known  - carries the derived `session` as well.
 *
 * COMPATIBILITY
 *
 * Both keys are additions *inside* an object the relay already treats as opaque (`validateTaskRouting`
 * checks `p2p` is an object with a valid `mode` and copies the rest verbatim), and both a v0.4.x
 * relay and a v0.4.x agent ignore keys they do not read. `relay` mode publishes `{mode}` alone: there
 * is no punch, and saying so is better than publishing a stale one.
 *
 * v0.6.0 adds one more key to the same block, and it is the whole of the key distribution problem:
 *
 *   `static_keys: { [machine_id]: base64(x25519 public key) }`
 *
 * WHY A MAP RATHER THAN ONE KEY
 *
 * The executor needs the *dispatcher's* key before it can dial back, and the dispatcher needs the
 * *executor's* key before it can push  - and at dispatch time the relay has not yet said which
 * machines the task went to (`leases` come back in the same response that creates it). So the block
 * carries this machine's own key, which is known before the request is written, and
 * {@link offerP2PFor} adds the target's once the lease names it. Reading the field is therefore
 * "look up the machine you are about to talk to", never "assume the only entry is the peer"  - a
 * machine that receives an offer for a fleet of three has three entries and uses one.
 *
 * What that buys, in the document's own terms: no `[Peer]` block for anyone to fill in. A machine
 * learns the keys of exactly the peers it has been asked to talk to, from the offer that asked it.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @param {object} runtime The P2P runtime handle from {@link createP2PRuntime}.
 * @returns {{mode: string, punch?: string, candidates?: Array<{address:string, port:number}>,
 *   static_keys?: Record<string, string>}}
 */
function buildP2POfferBlock(cfg, runtime) {
  const block = { mode: cfg.p2pMode };
  if (cfg.p2pMode === 'relay') return block;
  // Minted here, before the task exists, because it has to travel in the request that *creates* the
  // task: the relay republishes the stored block to the executor, and there is no way to amend it
  // afterwards.
  block.punch = mintPunchId();
  // Announced candidates, when the node has already announced. Not waited for: `start()` kicks the
  // first announce off rather than awaiting the STUN sweep, and a dispatch delayed by four STUN
  // servers would trade a fast path for a slower one. Absent means "ask the relay", which is exactly
  // what the executor does when the field is missing.
  const candidates = runtime?.node?.status?.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    block.candidates = candidates.map((candidate) => ({ address: candidate.address, port: candidate.port }));
  }
  // This machine's own static public key. Absent (not null) when there is none, so the wire stays
  // byte-identical to v0.5.x for a machine that has no key  - an additive change has to be absent to
  // be additive.
  const own = runtime?.encryption?.public_key;
  const machineId = runtime?.machineId;
  if (typeof own === 'string' && own !== '' && typeof machineId === 'string' && machineId !== '') {
    block.static_keys = { [machineId]: own };
  }
  return block;
}

/**
 * Mint the offer frame the executor needs, from the lease the relay just issued.
 *
 * WHY THIS IS DERIVED RATHER THAN INVENTED
 *
 * The executor decides whether an offer is a first delivery or a duplicate on `dedupe_key` +
 * `attempt` (§6), and the relay emits its own SSE offer with those exact values. A push that
 * disagreed by one character would make the machine execute the task twice  - once from each path  -  * so the dedupe key is computed with the relay's own {@link computeDedupeKey}/{@link computeCommandHash},
 * from the same `task_id`, `index`, `command_hash` inputs and `base_tree` the task was created with,
 * and `machine_id`/`index`/`attempt` come from the lease rather than from the caller's arguments.
 *
 * The one case that is *not* reproducible is `pipeline`, whose hash covers the relay's normalised
 * stage list rather than the caller's `stages`; there the key is left null and reported as such
 * instead of guessed, because a wrong key is worse than an absent one.
 *
 * @param {object} options
 * @param {string} options.taskId
 * @param {object} options.lease
 * @param {object} options.payload The validated `POST /v1/task` body this plugin sent.
 * @param {string|null} options.originMachineId
 * @param {string|null} [options.peerKey] The target's static public key (v0.6.0), added to the
 *   frame's `p2p.static_keys` under that machine's id.
 * @returns {{frame: object|null, skipped: {reason_code: string, message: string}|null}} `skipped` is
 *   a named refusal, not a sentence: a lease the relay did not address to a machine is a different
 *   fault from one it decided must not run the command.
 */
function buildOfferFrame({ taskId, lease, payload, originMachineId, peerKey = null }) {
  const machineId = typeof lease?.machine_id === 'string' && lease.machine_id !== '' ? lease.machine_id : null;
  if (machineId === null) {
    return {
      frame: null,
      skipped: {
        reason_code: REFUSAL_CODE.P2P_LEASE_NO_MACHINE_ID,
        message: 'the relay returned a lease with no machine_id',
      },
    };
  }

  const index = Number.isInteger(lease?.index) ? lease.index : 0;
  // The relay's first attempt is 1, and a lease that never says otherwise is a first attempt.
  const attempt = Number.isInteger(lease?.attempt) && lease.attempt > 0 ? lease.attempt : 1;
  const indexTotal = Number.isInteger(payload?.index_total) ? payload.index_total : 1;

  let dedupeKey = typeof lease?.dedupe_key === 'string' && lease.dedupe_key !== '' ? lease.dedupe_key : null;
  if (dedupeKey === null && payload?.mode !== 'pipeline' && Array.isArray(payload?.command_argv)) {
    try {
      const commandHash = computeCommandHash(payload.command_argv, SHELL_ID_DIRECT, payload.cwd_rel ?? '.');
      dedupeKey = computeDedupeKey(taskId, index, commandHash, payload.base_tree ?? null);
    } catch {
      dedupeKey = null;
    }
  }

  return {
    frame: {
      type: 'task.offer',
      task_id: taskId,
      machine_id: machineId,
      attempt,
      index,
      index_total: indexTotal,
      dedupe_key: dedupeKey,
      mode: payload.mode,
      ...(Array.isArray(payload.command_argv) ? { command_argv: payload.command_argv } : {}),
      ...(Array.isArray(payload.stages) ? { stages: payload.stages } : {}),
      cwd_rel: payload.cwd_rel,
      write: payload.write,
      timeout_ms: payload.timeout_ms,
      base_commit: payload.base_commit ?? null,
      base_tree: payload.base_tree ?? null,
      requirements: payload.requirements,
      compare_policy: payload.compare_policy,
      origin_machine_id: originMachineId,
      p2p: offerP2PFor(payload.p2p, { taskId, machineId, peerKey }),
    },
    skipped: null,
  };
}

/**
 * Push one offer over the direct path. Best effort by construction: nothing here throws.
 *
 * The session comes from the frame's own `p2p.session`  - minted per machine by
 * {@link offerP2PFor} from the punch id the relay is publishing for this same task. Dialling with a
 * session of the node's own invention would leave the two ends on two sessions, and an executor
 * whose reverse dial happened to arrive first would open a *second* channel beside this one instead of
 * the same one. `reused` in the answer is the honest report of the case where the executor's dial got
 * there first and this push therefore travelled over the channel that dial opened.
 *
 * @param {P2PNode} node
 * @param {object} frame
 * @param {{peerKey?: string|null, peerKeys?: object|null}} [crypto]
 *   `peerKey` is the target's static public key, published in this very frame
 *   (`frame.p2p.static_keys[machine_id]`) so the executor can dial back; it is handed to `dial()` as
 *   well because the *dispatcher* is the initiator here and needs the executor's key to handshake.
 *   `peerKeys` is the node's own store, taught the same key so the accept side can verify the
 *   executor's handshake later without a second relay lookup.
 * @returns {Promise<{ok: boolean, reason_code: string|null, error: string|null, session: number|null,
 *   reused: boolean, encrypted: boolean, encryption_reason: string|null}>} `reason_code` is null on a
 *   delivered push and names the refusal otherwise, so the caller never has to read `error` to branch.
 */
async function pushOffer(node, frame, crypto = {}) {
  const session = Number.isInteger(frame?.p2p?.session) && frame.p2p.session > 0 ? frame.p2p.session : undefined;
  const peerKey = typeof crypto.peerKey === 'string' && crypto.peerKey !== '' ? crypto.peerKey : null;
  if (peerKey !== null && crypto.peerKeys !== null && crypto.peerKeys !== undefined) {
    // Recorded before the dial: the executor's handshake answer arrives on the same socket, and the
    // `accept()` loop that has to verify it runs on this node. A key learned only from the relay's
    // answer would be a second lookup racing that datagram.
    crypto.peerKeys.set(frame.machine_id, peerKey, 'relay');
  }
  // The dial's own options, built here rather than inline because the *presence* of `crypto` is the
  // decision: `P2PNode.dial` arms a handshake only when this dispatcher holds a key for that peer, and
  // a peer with no published key is dialled exactly as v0.5.x dialled it  - plaintext, recorded, and
  // never a failure. That is §4's fallback clause applied to the push: a fleet must never lose a
  // machine to a security upgrade. It is not a silent downgrade, because the peer never offered a key
  // to downgrade *from*; a peer whose key we hold and whose handshake fails produces `ok: false` and
  // no channel at all.
  const dialOptions = session === undefined ? {} : { session };
  try {
    let dialled = await node.dial(frame.machine_id, { ...dialOptions, peerKey });
    if (dialled.ok === true
      && dialled.reused === true
      && dialled.channel?.encryption?.encrypted !== true
      && peerKey !== null
      && typeof node.dropChannel === 'function') {
      // A plaintext channel from an earlier reverse dial must not win by reuse: drop it and
      // immediately redial with the peer key, so this offer gets a real handshake.
      node.dropChannel(dialled.session);
      dialled = await node.dial(frame.machine_id, { ...dialOptions, peerKey });
    }
    if (!dialled.ok) {
      return {
        ok: false,
        // The node writes its own refusal as `CODE: sentence`; the code is lifted out so the push
        // reports the *same* code as a field instead of making the reader parse a message.
        reason_code: reasonCodeOf(dialled.error) ?? REFUSAL_CODE.P2P_DIAL_FAILED,
        error: dialled.error ?? 'P2P_DIAL_FAILED',
        session: dialled.session ?? null,
        reused: false,
        encrypted: false,
        encryption_reason: dialled.encryption_reason ?? null,
      };
    }
    const channel = dialled.channel;
    try {
      await channel.send(JSON.stringify(frame));
      return {
        ok: true,
        reason_code: null,
        error: null,
        session: dialled.session ?? null,
        reused: dialled.reused === true,
        encrypted: channel?.encryption?.encrypted === true,
        encryption_reason: channel?.encryption?.reason ?? null,
      };
    } finally {
      // The offer is one frame over a reliable channel: holding the channel open would keep a NAT
      // mapping alive for a conversation that is over, and the result comes back the responder's way.
      channel.close('offer-sent');
    }
  } catch (error) {
    return {
      ok: false,
      reason_code: REFUSAL_CODE.P2P_PUSH_THREW,
      error: `P2P_PUSH_THREW: ${error instanceof Error ? error.message : String(error)}`,
      session: session ?? null,
      reused: false,
      encrypted: false,
      encryption_reason: null,
    };
  }
}

/**
 * Send one offer over the WebRTC data plane.
 *
 * This deliberately sits *before* the UDP dial and never replaces the relay ledger. The task has
 * already been created by `POST /v1/task`; this is only the fast delivery of the same offer the
 * relay also publishes as SSE. A failure here is therefore a fallback signal, not a dispatch
 * failure, and the caller must still try the old path.
 *
 * @param {object|null} pool
 * @param {object} frame
 * @returns {Promise<{ok: boolean, transport: 'webrtc-v1'|null, reason_code: string|null,
 *   error: string|null, code: string|null, encrypted: boolean}>}
 */
export async function pushOfferWebRtc(pool, frame) {
  if (pool === null || pool === undefined || typeof pool.send !== 'function') {
    return {
      ok: false,
      transport: null,
      reason_code: REFUSAL_CODE.P2P_DIAL_FAILED,
      error: 'WEBRTC_POOL_UNAVAILABLE: no WebRTC transport pool is running in this plugin',
      code: 'WEBRTC_POOL_UNAVAILABLE',
      encrypted: false,
    };
  }
  try {
    const sent = await pool.send(frame.machine_id, JSON.stringify(frame));
    if (sent?.ok !== true) {
      return {
        ok: false,
        transport: null,
        reason_code: REFUSAL_CODE.P2P_DIAL_FAILED,
        error: `${sent?.code ?? 'WEBRTC_SEND_FAILED'}: ${sent?.detail ?? 'send failed'}`,
        code: sent?.code ?? 'WEBRTC_SEND_FAILED',
        encrypted: false,
      };
    }
    return {
      ok: true,
      transport: 'webrtc-v1',
      reason_code: null,
      error: null,
      code: null,
      encrypted: true,
    };
  } catch (error) {
    return {
      ok: false,
      transport: null,
      reason_code: REFUSAL_CODE.P2P_PUSH_THREW,
      error: `WEBRTC_PUSH_THREW: ${error instanceof Error ? error.message : String(error)}`,
      code: 'WEBRTC_PUSH_THREW',
      encrypted: false,
    };
  }
}

/**
 * Deliver one offer over WebRTC first and the legacy UDP dial second.
 *
 * The returned `transport` is the stack that actually carried the frame; `fallback_from` records
 * that WebRTC was attempted and refused. `relay_ledger` is not a field here on purpose: the relay's
 * copy is written before this function runs and is never conditional on its result.
 *
 * @param {object|null} node
 * @param {object|null} webrtcPool
 * @param {object} frame
 * @param {{peerKey?: string|null, peerKeys?: object|null}} [crypto]
 * @returns {Promise<{ok: boolean, transport: 'webrtc-v1'|'udp-v1'|'relay', reason_code: string|null,
 *   error: string|null, session: number|null, reused: boolean, encrypted: boolean,
 *   encryption_reason: string|null, fallback_from: 'webrtc-v1'|null, webrtc_error: string|null}>}
 *   `transport` is never null: after both direct attempts fail, the relay's SSE offer is the
 *   delivery that remains, so the value is `relay`.
 */
export async function pushOfferBestPath(node, webrtcPool, frame, crypto = {}) {
  const attemptedWebrtc = webrtcPool !== null && webrtcPool !== undefined && typeof webrtcPool.send === 'function';
  const webrtc = attemptedWebrtc ? await pushOfferWebRtc(webrtcPool, frame) : null;
  if (webrtc !== null && webrtc.ok === true) {
    return {
      ok: true,
      transport: 'webrtc-v1',
      reason_code: null,
      error: null,
      session: null,
      reused: false,
      encrypted: true,
      encryption_reason: null,
      fallback_from: null,
      webrtc_error: null,
    };
  }
  if (node === null || node === undefined) {
    return {
      ok: false,
      // The relay's own SSE offer is the delivery that remains; naming it `relay` is the honest
      // transport for this lease, not a null that hides which path actually carried the offer.
      transport: 'relay',
      reason_code: webrtc?.reason_code ?? REFUSAL_CODE.P2P_DIAL_FAILED,
      error: webrtc?.error ?? 'P2P_UNAVAILABLE: neither a WebRTC pool nor a UDP node is running',
      session: null,
      reused: false,
      encrypted: false,
      encryption_reason: null,
      fallback_from: attemptedWebrtc ? 'webrtc-v1' : null,
      webrtc_error: webrtc?.error ?? null,
    };
  }
  const udp = await pushOffer(node, frame, crypto);
  return {
    ...udp,
    // A failed UDP dial still leaves the relay SSE copy as the delivered offer.
    transport: udp.ok === true ? 'udp-v1' : 'relay',
    fallback_from: attemptedWebrtc ? 'webrtc-v1' : null,
    webrtc_error: webrtc?.error ?? null,
  };
}

/**
 * Push an offer for one task to every machine the relay leased it to.
 *
 * Called after the relay has created the task, so the relay's own SSE offer has already gone out:
 * this is an *additional* delivery over the faster path, and the relay's copy is what makes a failed
 * push harmless. Only leases in a runnable state are pushed  - `refused` and `observing` machines
 * were never handed the command, and sending them an offer would be asking them to run work the
 * relay decided they must not run.
 *
 * v0.6.0: each target's static key is fetched from the relay's peer record before the push, which is
 * the one moment the dispatcher learns the key of a machine it did not already know. It is fetched
 * **here** rather than sourced from the stored `p2p` block because the block is written *before* the
 * relay decides which machines the task goes to  - the offer that carries the key is the one addressed
 * to the machine that key belongs to. A missing key is not an error: the push proceeds and the
 * executor records `P2P_CRYPTO_NO_KEY` for its plaintext channel, which is the documented outcome for
 * a peer that never announced.
 *
 * v3.5.8: WebRTC is tried first. A WebRTC failure falls through to the same UDP dial as before; a
 * null node is legal when only the WebRTC pool is configured. The relay's SSE offer remains the
 * final fallback and the ledger, so this function is never allowed to fail a dispatch.
 *
 * @param {object|null} node
 * @param {object} options
 * @returns {Promise<Array<object>>} One entry per lease considered, in lease order. Every entry
 *   carries `transport: 'webrtc-v1'|'udp-v1'|'relay'` and, when `ok: false`, both `reason_code` and
 *   `failure_code`. A rejected/unrunnable lease is `relay` because the relay ledger decided its
 *   state and its SSE record is the only delivery surface for it.
 */
export async function pushOffers(node, { taskId, leases, payload, originMachineId, getJson = null, webrtcPool = null }) {
  const out = [];
  for (const lease of leases) {
    const machineId = typeof lease?.machine_id === 'string' && lease.machine_id !== '' ? lease.machine_id : null;
    const state = lease?.state;
    if (machineId === null) {
      out.push({
        machine_id: null,
        ok: false,
        transport: 'relay',
        reason_code: REFUSAL_CODE.P2P_LEASE_NO_MACHINE_ID,
        failure_code: REFUSAL_CODE.P2P_LEASE_NO_MACHINE_ID,
        error: 'the relay returned a lease with no machine_id',
        relay_fallback: true,
      });
      continue;
    }
    if (state !== 'queued' && state !== 'offered') {
      out.push({
        machine_id: machineId,
        ok: false,
        transport: 'relay',
        reason_code: REFUSAL_CODE.P2P_LEASE_NOT_RUNNABLE,
        failure_code: REFUSAL_CODE.P2P_LEASE_NOT_RUNNABLE,
        error: `lease state is ${JSON.stringify(state ?? null)}, so this machine was not handed the command`,
        relay_fallback: true,
        // What would change it: nothing the dispatcher can do. The relay decided, and the honest
        // report is that the decision was the relay's rather than a delivery failure.
        detail:
          'only leases in a runnable state (queued, offered) are pushed; this lease is refused or ' +
          'observing, so it was never handed the command and the relay\'s own SSE offer is the only delivery',
      });
      continue;
    }
    const peerKey = await readPeerStaticKey(getJson, machineId);
    const built = buildOfferFrame({ taskId, lease, payload, originMachineId, peerKey });
    if (built.frame === null) {
      out.push({
        machine_id: machineId,
        ok: false,
        transport: 'relay',
        reason_code: built.skipped.reason_code,
        failure_code: built.skipped.reason_code,
        error: built.skipped.message,
        relay_fallback: true,
      });
      continue;
    }
    const result = await pushOfferBestPath(node, webrtcPool, built.frame, { peerKey, peerKeys: node?.peerKeys ?? null });
    const failureCode = result.ok === true ? null : (result.reason_code ?? REFUSAL_CODE.P2P_DIAL_FAILED);
    out.push({
      machine_id: machineId,
      ok: result.ok,
      // One of the three real delivery paths. A failed direct push is `relay`, because the relay's
      // SSE offer is then the copy that actually reaches the machine -- `null` would hide that.
      transport: result.transport ?? 'relay',
      reason_code: failureCode,
      failure_code: failureCode,
      error: result.error,
      relay_fallback: result.ok !== true,
      ...(result.fallback_from === null || result.fallback_from === undefined
        ? {}
        : { fallback_from: result.fallback_from }),
      ...(result.webrtc_error === null || result.webrtc_error === undefined
        ? {}
        : { webrtc_error: result.webrtc_error }),
      dedupe_key: built.frame.dedupe_key === null ? null : 'relay-formula',
      // The session this push and the executor's reverse dial meet on, so a machine's own
      // `p2p.session` in the ledger can be matched to the dispatcher's attempt without reading two
      // logs side by side. `null` when there was nothing to punch over (a v0.4.x-shaped frame).
      session: result.session,
      // True when the executor's dial got there first and this push travelled over the channel that
      // dial opened  - a two-way punch that worked, reported as such rather than as a plain push.
      reused: result.reused === true,
      // v0.6.0: whether the offer actually travelled sealed, and why not when it did not. Reported
      // per machine because it is a per-machine fact: one peer can be encrypted and the next one a
      // v0.5.x build in the same dispatch.
      encrypted: result.encrypted === true,
      ...(result.encryption_reason === null || result.encryption_reason === undefined
        ? {}
        : { encryption_reason: result.encryption_reason }),
      ...(peerKey === null ? {} : { static_key: 'published' }),
    });
  }
  return out;
}

/**
 * Read one machine's static public key from the relay's peer record, or explain why not.
 *
 * Never throws and never fails a dispatch: a relay that answers 404 (the peer never announced, or its
 * announcement expired between the task and the push) leaves this machine unencrypted for that peer
 * and says so, which is precisely §4's "a fleet must never lose a machine because a security upgrade
 * could not complete".
 *
 * @param {((path: string) => Promise<object>)|null} getJson
 * @param {string} machineId
 * @returns {Promise<string|null>}
 */
async function readPeerStaticKey(getJson, machineId) {
  if (typeof getJson !== 'function') return null;
  try {
    const answer = await getJson(`/v1/peer/${encodeURIComponent(machineId)}`);
    const key = answer?.json?.peer?.static_key;
    return typeof key === 'string' && key !== '' ? key : null;
  } catch {
    return null;
  }
}

/**
 * Require the operator token, naming the setting when it is absent (PROTOCOL-v0.1.2 §5).
 *
 * `POST /v1/task` is the one endpoint that authorises with the operator token rather than the
 * device token. There is deliberately **no fallback** to the device token: a relay that has the
 * requirement enabled answers such an attempt with `401 OPERATOR_REQUIRED`, and a plugin that
 * quietly tried the device token first would turn a missing setting into a confusing remote
 * refusal. Failing here names the setting the operator has to set.
 *
 * @param {{operatorToken: string|null}} cfg
 * @returns {string}
 */
function requireOperatorToken(cfg) {
  if (cfg.operatorToken) return cfg.operatorToken;
  throw configError(
    'operatorToken',
    'is not set, so this tool cannot dispatch a task - a device token cannot dispatch tasks; ' +
      '`POST /v1/task` requires the operator token',
    'set `operatorToken` in this plugin\'s profile patch (or `W2M_OPERATOR_TOKEN` in the environment) ' +
      'to the value the relay printed at startup, or read it from `<state>/operator-token.txt`',
    // The gate's own code. `W2M_CONFIG` names the class of the fault; this names the refusal, and it
    // is the one credential this plugin holds, so "why was my dispatch refused" must not have to be
    // answered by reading a message.
    REFUSAL_CODE.OPERATOR_TOKEN_MISSING,
  );
}

// ---------------------------------------------------------------------------------------------
// Command policy
// ---------------------------------------------------------------------------------------------

/**
 * Check one argv against the configured allow-list, with the **same rule the agent applies**.
 *
 * Returns `null` when the call may proceed. When `allowedCommands` is unset or empty this plugin
 * does **not** refuse: the execution gate belongs to the machine that runs the command, and the
 * agent enforces its own `allowedCommands`. Refusing here on an empty list would either duplicate
 * that policy badly or hide it behind a silent allow, so the plugin only enforces what it was
 * explicitly told.
 *
 * The matcher is imported rather than re-implemented because this pre-flight exists for one reason:
 * a dispatcher must not send work the target machine would itself refuse. An executable-only
 * comparison (`argv[0]` against each entry) could never match a multi-token entry at all, so the
 * documented config `['node --test','git status --porcelain']` refused `['git','rev-parse','HEAD']`
 * -- stricter than the gate, which is the direction that silently loses work.
 *
 * The argv is handed over **verbatim**, including `argv[0]`. It used to be reduced to a basename
 * first, and that was the plugin half of a defect: the matcher decides executable identity by
 * resolving a path, and a pre-flight that strips the path can only ever compare names, so it would
 * wave `E:\Temp\evil\node.exe` through while the agent refused it. Passing the argv through
 * unchanged is what keeps the two ends one rule. What the shared matcher then resolves, it resolves
 * against **this** process's environment  - the dispatcher's PATH  - which is a real limit of a
 * pre-flight (the executing machine's PATH is the one that will decide), and the reason the refusal
 * that matters is the agent's own.
 *
 * A refusal names itself: `reason_code` is the matcher's own code (so the two ends cannot report one
 * refusal under two spellings) and `detail` says what would change it. The two ways this control
 * refuses are kept apart  - a command outside the list and a list that cannot be parsed have
 * different remedies, and sharing one code would send the reader to the wrong one.
 *
 * @param {string[]} allowedCommands Entries as configured, e.g. `['node --test']`.
 * @param {string[]} argv
 * @returns {{allowed: string[], reason_code: string, message: string, detail: string}|null}
 */
function checkAllowedCommand(allowedCommands, argv) {
  if (allowedCommands.length === 0) return null;
  let prefixes;
  try {
    prefixes = parseAllowedCommands(allowedCommands);
  } catch (error) {
    // Fail closed: an unparseable list is not an empty one, and a control that cannot be evaluated
    // must refuse rather than wave the command through.
    return {
      allowed: [],
      reason_code: REFUSAL_CODE.ALLOWED_COMMANDS_UNPARSEABLE,
      message: `the plugin's allowedCommands could not be parsed (${error?.message ?? String(error)})`,
      detail:
        'the configured list is not a JSON array of command prefixes (entries are split on ' +
        'whitespace, and commas are not separators); fix `allowedCommands` in the profile patch, ' +
        '.w2m.json or machine.json - until it parses, this control cannot be evaluated and every ' +
        'dispatch is refused',
    };
  }
  // Prefixes "as written": the configured entries, whitespace-normalised, in a stable order.
  const allowed = prefixes.map((prefix) => prefix.join(' ')).sort();
  const match = matchAllowedCommand(argv, prefixes);
  if (match.allowed) return null;
  return {
    allowed,
    // The shared matcher's code, not a second copy of it: `COMMAND_NOT_ALLOWED` is the literal the
    // agent writes into its own envelope, so a machine's refusal and this pre-flight's refusal read
    // the same to whoever has to act on them. The matcher's three newer codes travel the same way
    // for the same reason.
    reason_code: match.reason_code ?? REFUSAL_CODE.COMMAND_NOT_ALLOWED,
    message: `\`${argv.join(' ')}\` is not in this plugin's allowedCommands (${allowed.join(', ')})`,
    detail:
      match.detail ??
      `add \`${argv.join(' ')}\` (or a prefix of it) to allowedCommands, or run a command the list already covers`,
  };
}

// ---------------------------------------------------------------------------------------------
// Shapes shared by the tools
// ---------------------------------------------------------------------------------------------

/**
 * Strip bulky fields out of an envelope, keeping the comparable ones and a bounded excerpt.
 *
 * Comparable fields are copied through in full: silently dropping one would turn a `divergent`
 * verdict into a mystery.
 *
 * @param {object} raw
 * @param {Set<string>} comparable
 * @returns {object}
 */
function compactEnvelope(raw, comparable) {
  if (raw === null || typeof raw !== 'object') return { value: raw };

  const compact = {};
  for (const [key, value] of Object.entries(raw)) {
    if (comparable.has(key) || key === 'status' || key === 'refusal_reason') compact[key] = value;
  }
  for (const key of ['stdout_head', 'stdout_tail', 'stderr_head', 'stderr_tail']) {
    if (typeof raw[key] === 'string') compact[key] = excerpt(raw[key]);
  }
  return compact;
}

/**
 * Keep only the first `MAX_EXCERPT_BYTES` bytes of a stream.
 *
 * @param {string} value
 * @returns {string}
 */
function excerpt(value) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= MAX_EXCERPT_BYTES) return value;
  return `${buffer.subarray(0, MAX_EXCERPT_BYTES).toString('utf8')}\n - …[truncated at ${MAX_EXCERPT_BYTES} bytes]`;
}

/**
 * Compare the Rabbit's envelope against the field list this plugin knows, and report what is new.
 *
 * PROTOCOL §5 says unknown fields must be ignored. Ignoring them is not the same as being blind
 * to them: a Rabbit that starts sending a field this plugin does not understand is a protocol
 * drift a reader needs to see, so the names are surfaced rather than dropped.
 *
 * @param {object} body
 * @param {{comparable: Set<string>, optional: Set<string>}} known
 * @returns {string[]}
 */
function collectUnknownFields(body, known) {
  const aggregate = aggregateOf(body);
  const machines = Array.isArray(aggregate?.machines) ? aggregate.machines : [];
  const seen = new Set();
  for (const machine of machines) {
    const envelope = machine?.envelope ?? machine?.result;
    if (envelope === null || typeof envelope !== 'object') continue;
    for (const key of Object.keys(envelope)) {
      if (!known.comparable.has(key) && !known.optional.has(key)) seen.add(key);
    }
  }
  return [...seen].sort();
}

/** Comparable field - mirror of PROTOCOL §5.3. Only these decide consistency. */
const COMPARABLE_FIELDS = new Set([
  'task_id', 'index', 'index_total', 'mode', 'cwd_rel', 'base_commit', 'base_tree',
  'pre_tree_fingerprint', 'fingerprint_algo', 'fingerprint_error', 'head_commit', 'command_hash',
  'shell_id', 'exit_code', 'status', 'refusal_reason', 'stdout_sha256', 'stdout_bytes',
  'stdout_normalized_sha256', 'stderr_sha256', 'artifacts', 'diff_numstat', 'tests',
  'semantic_counts', 'warnings',
]);

/**
 * Optional field - mirror of PROTOCOL §5.2. Carried, but never compared.
 *
 * `artifacts`, `tests`, and `semantic_counts` appear in both §5.2 and §5.3; the union is what
 * matters for the drift report, so they need naming only once, and `COMPARABLE_FIELDS` already
 * names them.
 */
const OPTIONAL_FIELDS = new Set([
  'stdout_head', 'stdout_tail', 'stderr_head', 'stderr_tail', 'untracked', 'toolchain',
  'lockfiles', 'unpinned_deps', 'submodules', 'lfs', 'signal',
  // v0.4.0 §5: how the envelope travelled, and the path facts that came with it. Optional because a
  // v0.3.9 agent sends neither and must keep working unchanged; here rather than in
  // `COMPARABLE_FIELDS` because **a path is not a result**  - two byte-identical runs on two machines
  // must stay `consistent` when one of them punched a hole and the other used the relay.
  'transport', 'p2p',
]);

/**
 * Find the aggregate inside a task response.
 *
 * `GET /v1/tasks/{id}` answers `{protocol_version, rabbit_time, task, leases, aggregate}`, while
 * `GET /v1/tasks/{id}/report?format=json` answers the aggregate itself. Both shapes are accepted so
 * a reader that has either one in hand can use the same normalisation.
 *
 * @param {object} body
 * @returns {object|null}
 */
function aggregateOf(body) {
  if (body === null || typeof body !== 'object') return null;
  if (body.aggregate !== null && typeof body.aggregate === 'object') return body.aggregate;
  if (typeof body.status === 'string') return body;
  return null;
}

/**
 * Normalise the aggregate the Rabbit reported.
 *
 * `known` is false for a status outside {@link AGGREGATE_STATES}: a verdict this plugin does not
 * understand is surfaced rather than trusted. `terminal` is the question the wait loop actually
 * ask - a task with no verdict yet, or with a machine whose lease is still unexpired and has not
 * reported, is not finished, and reporting it as finished would be the worst kind of quiet wrong
 * answer.
 *
 * @param {object} body A task response or a bare aggregate.
 * @returns {{state: string|null, known: boolean, terminal: boolean, states: string[], detail: object|null}}
 */
function readAggregate(body) {
  const aggregate = aggregateOf(body);
  if (aggregate === null) {
    return { state: null, known: false, terminal: false, states: [], detail: null };
  }

  const state = typeof aggregate.status === 'string' ? aggregate.status : null;
  const known = state !== null && AGGREGATE_STATES.has(state);
  const outcomes = Array.isArray(aggregate.machines)
    ? aggregate.machines.map((machine) => machine?.outcome ?? null)
    : [];

  // A status this plugin does not recognise ends the wait rather than extending it: the Rabbit has
  // stopped saying "no verdict yet", so waiting cannot turn an unknown word into a known one.
  // `known: false` is what tells the caller the verdict is unreadable.
  const terminal = state !== null
    && (!known
      || (!NON_TERMINAL_AGGREGATE.has(state) && !outcomes.some((outcome) => NON_TERMINAL_OUTCOME.has(outcome))));

  return { state, known, terminal, states: outcomes, detail: aggregate };
}

/**
 * Wait, but stop waiting the moment the caller cancels.
 *
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    const fail = (reason) => {
      if (reason instanceof W2MError) reject(reason);
      else {
        reject(new W2MError('W2M_ABORTED', `W2M_ABORTED: the wait was cancelled${reason instanceof Error && reason.message ? ` (${reason.message})` : ''}`, {
          cause: reason,
        }));
      }
    };

    if (signal?.aborted) {
      fail(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      fail(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

  // -------------------------------------------------------------------------------------------
  // 2. w2m_ru - broadcast
  // -------------------------------------------------------------------------------------------
export function registerRun(ctx, deps) {
  const { approvalGate, approvalQueue, cfg, defineTool, jsonOutput, p2p, pluginVersion: PLUGIN_VERSION } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_run',
    description:
      'Broadcast one command, as an argv array, to every online machine and return the task_id ' +
      'with its per-machine leases. The command runs on each machine in its own copy of the ' +
      'project; nothing is written unless `write` is true. Read the result with w2m_wait. ' +
      'Anchors (base_commit, base_tree) are computed here from this machine\'s working tree so ' +
      'the peers can be checked against them. Under the default p2pMode the offer is also pushed ' +
      'over the direct path, best effort: `direct_pushes` names every attempt, and the relay\'s ' +
      'own offer remains the delivery when a push fails. ' +
      'A machine selected in the composer for this session narrows the dispatch to that machine; ' +
      'an explicit `executor_machine_id` always wins over it, and the answer\'s `selection` says ' +
      'which of the two routed the task.',
    parameters: {
      command_argv: {
        type: 'array',
        items: { type: 'string' },
        // Not `required`: a pipeline states its commands in `stages`, and the relay derives
        // `command_argv` from stage 0. Marking it required would make a pipeline task impossible to
        // express, so the check below is conditional instead.
        description: 'The command as an argv array, for example ["node","--test"]. Never a shell string. Omit under mode=pipeline.',
      },
      mode: {
        type: 'string',
        enum: ['replicate', 'split', 'broadcast', 'pipeline', 'mapreduce'],
        description:
          'replicate: every machine runs the whole command. split: each machine takes its share by index. ' +
          'broadcast: one machine runs it and every other machine is told the outcome without running anything ' +
          '(pair with executor_machine_id to choose which). pipeline: every machine runs the whole chain from ' +
          '`stages`, in order, stopping at the first stage that fails. Defaults to replicate.',
        default: 'replicate',
      },
      stages: {
        type: 'array',
        // Array of strings, matching `command_argv`'s existing convention: the tool shim can check
        // that shape, and an array of objects would be declared as `object` items that nothing
        // validates. A stage that needs its own cwd is not supported through this tool; the chain
        // inherits the task's `cwd_rel`, and per-stage cwd stays available to the relay API.
        items: { type: 'string' },
        description:
          'mode=pipeline only: the chain, in order, one argv per stage with elements separated by spaces ' +
          '(for example ["node --test", "node scripts/pack.mjs"]). At most 16. Every machine runs the entire ' +
          'chain, so there is no cross-machine data flow and nothing can be dropped in transit. The timeout ' +
          'covers the whole chain, not each stage. A stage containing a space inside one argument cannot be ' +
          'expressed here; use the relay API for that.',
      },
      executor_machine_id: {
        type: 'string',
        description:
          'mode=broadcast only: which machine runs the command. Defaults to the first machine the relay lists, ' +
          'chosen deterministically so the same task record describes the same execution twice. Every other ' +
          'machine is recorded as an observer and is never counted as having verified the result.',
      },
      index_total: {
        type: 'number',
        description: 'Number of slices for mode=split. Defaults to 1, which is the only value replicate and mapreduce accept.',
        default: 1,
      },
      reduce_argv: {
        type: 'array',
        items: { type: 'string' },
        description: 'mode=mapreduce only: the reduce command as an argv array. Required there and refused under every other mode.',
      },
      reducer_machine_id: {
        type: 'string',
        description: 'mode=mapreduce only: which machine is expected to run the reduce task. Recorded on the task so w2m_wait can build the reduce plan.',
      },
      include_offline: {
        type: 'boolean',
        // v1.1.2. The relay now leases only devices that are online and not silent by default; this asks it to include
        // the machines that are down as well, which is what an operator wants when queueing work for a machine that
        // is currently switched off. Default false, because a stale lease is what kept every aggregate at `partial`.
        description:
          'Default false: the relay leases only the machines that are online and have not gone silent. Set true to ' +
          'include machines that are currently down (their lease will simply expire if they do not come back).',
        default: false,
      },
      allowOutdated: {
        type: 'boolean',
        // v3.5.0: the minimum-version gate. Deliberately a per-dispatch, default-false override: the
        // safe answer to "one machine is old" is to refuse and name it, and an operator who has read
        // the refusal can override once, explicitly.
        description:
          'Default false: a dispatch whose online target machines include one below the fleet minimum plugin ' +
          `version (${MIN_SUPPORTED_PLUGIN_VERSION}) or one that cannot report its version is refused whole with ` +
          'MACHINE_VERSION_UNSUPPORTED, naming every affected machine. Set true to dispatch anyway: the override is ' +
          'audited (an `audit` record in the result and a warning line) and the machines waved through are listed ' +
          'in `outdated_allowed`.',
        default: false,
      },
      cwd_rel: {
        type: 'string',
        description: 'Working directory relative to the project root, with forward slashes. Defaults to ".".',
        default: '.',
      },
      cwd_outside_project: {
        type: 'boolean',
        default: false,
        description:
          'v0.43.0. Let `cwd_rel` resolve OUTSIDE the target machine\'s project root. OFF by default, and ' +
          'that guard exists for a reason: a machine should not be pointed at a directory the operator ' +
          'never designated. It is needed because a localside started without `--project` takes its own ' +
          'working directory as the root -- so a machine launched from its state directory can otherwise ' +
          'run ONLY inside that directory, and a dispatch that asks for anywhere else fails as ' +
          '`PATH_INVALID` with nothing in the answer saying why. Turning this on does not widen what may ' +
          'be RUN (the command allow-list and the executable path check still apply); it changes WHERE. ' +
          'The resolved directory is reported back so a result says when it happened.',
      },
      timeout_ms: {
        type: 'number',
        // No `default` here on purpose. If the schema carried one, DSH would fill it in before
        // `execute` ran, so a timeout set in the shared config would be silently overridden by the
        // schema on every call -- and the operator would see their setting have no effect. Leaving it
        // unset lets `execute` fall back to the merged config, and an explicit per-call value still wins.
        description:
          'How long each machine may spend on the command, in milliseconds. Defaults to the shared config ' +
          `(defaultTimeoutMs, itself 300000 unless set), capped at ${MAX_TASK_TIMEOUT_MS}.`,
      },
      write: {
        type: 'boolean',
        description: 'Allow the machines to write inside write_scope. Defaults to false, which makes the whole run read-only.',
        default: false,
      },
      write_scope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Project-relative path prefixes the machines may write, for example ["src/"]. Required in spirit when write is true.',
      },
      require_exclusive_write: {
        type: 'boolean',
        description: 'Ask the Rabbit to grant at most one writing lease at a time. Defaults to false.',
        default: false,
      },
      halt: {
        type: 'string',
        description: 'never: a machine that stops reporting is only recorded. now: other machines may take over its work. Defaults to never.',
        default: 'never',
      },
      max_attempts: {
        type: 'number',
        description: 'Total attempts this task may take, 1..5. Defaults to 1 (at-most-once). Only meaningful with retry_on.',
        default: 1,
      },
      retry_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Which terminal conditions justify another attempt: expired, failed, partial, timeout. Omit to never retry.',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task waits for. The relay will not dispatch it until every dependency has settled; then it is offered automatically.',
      },
      assignee: {
        type: 'string',
        description: 'Machine id that must execute this task. An assignee is a restriction: no other machine is offered the work, and an unknown id is refused by name.',
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      // v0.8.12: dispatching is the clearest moment to finish joining -- see `requestFleetJoin`.
      await requestFleetJoin();
      const base = requireRabbit(cfg);

      // `required` is enforced by DSH's schema layer in production, and by the shim offline; this
      // check is here so a caller that bypassed both still gets a named reason instead of a
      // confusing failure several layers down.
      const mode0 = args?.mode ?? 'replicate';
      const argv = args?.command_argv;
      const argvUsable = Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === 'string' && part !== '');
      // Under `pipeline` the commands live in `stages` and the relay derives stage 0 into
      // `command_argv`; every other mode needs it here.
      if (!argvUsable && mode0 !== 'pipeline') {
        throw new W2MError('W2M_INVALID_ARGV', '`command_argv` must be a non-empty array of non-empty strings', {
          hint: 'pass the command as separate array elements, for example ["node","--test"]',
        });
      }
      if (!argvUsable && mode0 === 'pipeline' && !Array.isArray(args?.stages)) {
        // Only when `stages` is absent outright. An empty array is caught by the pipeline check
        // below, which names the real problem ("pipeline needs a chain") instead of talking about
        // `command_argv` -- and the argv guard must not pre-empt that message.
        throw new W2MError(
          'W2M_INVALID_ARGV',
          '`command_argv` is missing and `mode` is `pipeline` without `stages`, so there is no command to run',
          { hint: 'pass stages: ["node --test", ...] for a pipeline, or command_argv for a single command' },
        );
      }

      const mode = args?.mode ?? 'replicate';
      if (mode !== 'replicate' && mode !== 'split' && mode !== 'broadcast' && mode !== 'pipeline' && mode !== 'mapreduce') {
        throw new W2MError(
          'W2M_BAD_MODE',
          `W2M_BAD_MODE: \`mode\` must be \`replicate\`, \`split\`, \`broadcast\` or \`pipeline\`, not \`${mode}\`; ` +
            'replicate runs the whole command on every machine, split hands each machine a slice by index, ' +
            'broadcast runs it on one machine and tells the rest, pipeline runs a chain on every machine',
        );
      }

      // v0.3.3 `pipeline`: validated here as well as at the relay, because a malformed chain would
      // otherwise be rejected only after the request crossed the network -- and the caller would get a
      // relay error instead of a sentence naming the stage that is wrong.
      const stageStrings = Array.isArray(args?.stages) ? args.stages : null;
      /**
       * The chain as the relay wants it: `{ command_argv }` per stage.
       *
       * Each tool-level stage is one string whose elements are space-separated. That is a deliberate
       * narrowing of what the relay accepts (which takes a full argv per stage): the tool schema can
       * only declare an array of strings, and an array of objects would validate as "whatever". An
       * argument containing a space therefore cannot be expressed through this tool, which the
       * parameter description says outright rather than failing obscurely later.
       */
      const stagesPayload = stageStrings === null
        ? null
        : stageStrings.map((s) => ({ command_argv: String(s).split(' ').filter((part) => part !== '') }));
      if (mode === 'pipeline') {
        if (stagesPayload === null || stagesPayload.length === 0) {
          throw new W2MError(
            'W2M_BAD_STAGES',
            'W2M_BAD_STAGES: `mode` is `pipeline` but `stages` is missing or empty; pipeline runs a chain, so ' +
              'give at least one stage as an array of argvs, for example ["node --test", "node scripts/pack.mjs"]',
            { hint: 'pass stages: ["node --test", ...], or use mode=replicate for a single command' },
          );
        }
        if (stagesPayload.length > MAX_STAGES) {
          throw new W2MError(
            'W2M_BAD_STAGES',
            `W2M_BAD_STAGES: \`stages\` has ${stagesPayload.length} entries but at most ${MAX_STAGES} are allowed; ` +
              'each stage is another command run on every machine, so the count is bounded deliberately',
          );
        }
        stagesPayload.forEach((stage, i) => {
          if (stage.command_argv.length === 0) {
            throw new W2MError(
              'W2M_BAD_STAGES',
              `W2M_BAD_STAGES: \`stages[${i}]\` is empty or whitespace; every stage must name a command`,
            );
          }
        });
      } else if (mode === 'mapreduce') {
        /**
         * The map half is ordinary dispatch; the reduce half is described, never launched. A relay that launched it would be
         * deciding on a partial fleet and reporting one task id for two executions -- so the caller runs it as a second
         * task, after w2m_wait says the shards are all there.
         */
        if (stagesPayload !== null) {
          throw new W2MError('W2M_BAD_STAGES', 'W2M_BAD_STAGES: stages is not part of mapreduce; the map command is command_argv and the reduce command is reduce_argv');
        }
        if (!Array.isArray(args?.reduce_argv) || args.reduce_argv.length === 0 || args.reduce_argv.some((part) => typeof part !== 'string' || part === '')) {
          throw new W2MError('W2M_BAD_REDUCE', 'W2M_BAD_REDUCE: mode=mapreduce requires reduce_argv as a non-empty string[]', {
            hint: 'pass reduce_argv: ["node","scripts/reduce.mjs"]',
          });
        }
        if (Number.isInteger(args?.index_total) && args.index_total !== 1) {
          throw new W2MError('W2M_BAD_INDEX', 'W2M_BAD_INDEX: mode=mapreduce maps the whole input on each machine, so index_total must be 1');
        }
      } else if (args?.reduce_argv !== undefined || args?.reducer_machine_id !== undefined) {
        // Refused rather than ignored: a caller that names a reduce command under another mode believes it will run.
        throw new W2MError('W2M_BAD_REDUCE', 'W2M_BAD_REDUCE: reduce_argv and reducer_machine_id are only valid with mode=mapreduce', { mode });
      } else if (stagesPayload !== null) {
        // Refused rather than ignored: the caller described a chain, and running only stage 0 would
        // silently drop every later stage while reporting success.
        throw new W2MError(
          'W2M_BAD_STAGES',
          `W2M_BAD_STAGES: \`stages\` only applies to mode=pipeline, but \`mode\` is \`${mode}\`; ` +
            'under the other modes the relay runs `command_argv`, so every stage after the first would be dropped without a word',
          { hint: 'use mode=pipeline with stages, or drop stages and pass command_argv' },
        );
      }

      const indexTotal = Number.isInteger(args?.index_total) ? args.index_total : 1;
      if (indexTotal < 1) {
        throw new W2MError(
          'W2M_BAD_INDEX',
          `W2M_BAD_INDEX: \`index_total\` is \`${args?.index_total}\` but must be an integer of at least 1 (number of slices)`,
        );
      }
      if (mode === 'replicate' && indexTotal !== 1) {
        throw new W2MError(
          'W2M_BAD_INDEX',
          `W2M_BAD_INDEX: mode=replicate means every machine runs the whole command, so \`index_total\` must be 1, not \`${indexTotal}\`; use mode=split with index_total>1 to hand each machine a slice`,
          { hint: 'use mode=split with index_total>1 to hand each machine a slice' },
        );
      }

      // `broadcast` runs the command on exactly one machine. Accepting a multi-shard index_total here
      // would record a split task while executing a single shard, and the report would then describe
      // work that never happened -- so it is refused rather than quietly coerced.
      if (mode === 'broadcast' && indexTotal !== 1) {
        throw new W2MError(
          'W2M_BAD_INDEX',
          `W2M_BAD_INDEX: mode=broadcast runs the command on one machine, so \`index_total\` must be 1, not \`${indexTotal}\`; use mode=split to hand each machine a slice`,
          { hint: 'use mode=broadcast with index_total=1, or mode=split to distribute slices' },
        );
      }

      // A pipeline is a sequence, not a sharded sequence: sharding it would mean each machine ran its
      // own slice's chain, which is a different feature and not what was asked for.
      if (mode === 'pipeline' && indexTotal !== 1) {
        throw new W2MError(
          'W2M_BAD_INDEX',
          `W2M_BAD_INDEX: mode=pipeline runs the whole chain on each machine, so \`index_total\` must be 1, not \`${indexTotal}\``,
          { hint: 'use mode=pipeline with index_total=1, or mode=split for independent slices' },
        );
      }

      const executorMachineId =
        typeof args?.executor_machine_id === 'string' && args.executor_machine_id !== ''
          ? args.executor_machine_id
          : null;
      if (executorMachineId !== null && mode !== 'broadcast') {
        // The relay only reads this field for broadcast, so accepting it elsewhere would promise a
        // restriction that nothing enforces: the command would still run everywhere.
        throw new W2MError(
          'W2M_BAD_EXECUTOR',
          `W2M_BAD_EXECUTOR: \`executor_machine_id\` only applies to mode=broadcast, but \`mode\` is \`${mode}\`; ` +
            'under replicate and split the relay decides the targets, so passing this would look like a restriction that is not applied',
          { hint: 'use mode=broadcast with executor_machine_id, or drop executor_machine_id' },
        );
      }

      // -------------------------------------------------------------------------------------------
      // v0.6.1: the session's chosen target, when the caller named no machine of its own.
      // -------------------------------------------------------------------------------------------
      //
      // The composer control writes a selection into this process, keyed by session; here is where
      // it becomes real. Read before the payload literal so the routing facts and the answer agree.
      //
      // The precedence rule is the whole contract, and it is one line: **the caller's own fields
      // always win**. `executor_machine_id` is checked below, and `target_machines` is never a tool
      // argument  - so a caller that named a machine (which, for this tool, means
      // `executor_machine_id` under broadcast) is untouched, and a caller that named none inherits
      // the selection. Nothing already published changes meaning: the selection only fills fields
      // that were absent, and the relay has accepted both of them since v0.3.3/v0.4.1.
      const sessionKey = sessionKeyFor(exec);
      const selection = defaultSelectionStore.get(sessionKey);
      const routedBy = dispatchSelectionFields(selection, mode);
      // broadcast reads the executor field; everything else reads `target_machines`. The relay
      // ignores the field a mode does not read, and the two are never both set by a selection.
      const selectionFields = mode === 'broadcast' && executorMachineId !== null
        ? { fields: {}, applied_as: null }
        : routedBy.fields;
      // Whether the selection actually routed THIS task. Reported in the answer, because it is the
      // one thing an operator cannot recover afterwards: the payload is not in the transcript, and
      // the same command run twice can legitimately take two different routes.
      const selectionAppliedAs = mode === 'broadcast' && executorMachineId !== null
        ? null
        : routedBy.applied_as;

      /**
       * *Why* the selection did or did not route this task, as a code rather than a bare boolean.
       *
       * `applied` alone conflates three different situations an operator has to tell apart: nothing
       * was selected, the selection was overridden by the call's own `executor_machine_id`, or a
       * selection exists that names no machine at all and therefore routed nothing. The last one is
       * the one that used to be invisible  - a stored selection with no `machine_id` produces
       * `applied: false` and nothing else, which looks exactly like "the whole fleet ran it".
       */
      const selectionReason = selection === null
        ? {
            reason_code: REFUSAL_CODE.SELECTION_NONE,
            detail: 'no machine is selected for this session, so this dispatch was not narrowed to one',
          }
        : selectionAppliedAs !== null
          ? {
              reason_code: REFUSAL_CODE.SELECTION_APPLIED,
              detail: `the composer's selected machine routed this dispatch, sent as ${selectionAppliedAs}=${selection.machine_id}`,
            }
          : mode === 'broadcast' && executorMachineId !== null
            ? {
                reason_code: REFUSAL_CODE.SELECTION_OVERRIDDEN_BY_CALLER,
                detail: `this call named executor_machine_id=${executorMachineId}, which wins over the session selection and was sent instead`,
              }
            : {
                reason_code: REFUSAL_CODE.SELECTION_UNUSABLE,
                detail:
                  'a machine is selected for this session but the selection names no machine_id, so ' +
                  'nothing could be applied and the dispatch was not narrowed; pick a machine in the ' +
                  'composer again, or clear the selection',
              };

      // Plugin-side allow-list check: only when one is configured. See checkAllowedCommand.
      //
      // **Every** stage is checked, not just the first. Checking only `command_argv` would let a
      // pipeline smuggle a disallowed command in stage 2 while stage 1 satisfied the list -- the
      // allow-list is a default-deny control, and a chain is not an exemption from it.
      const commandsToCheck = mode === 'pipeline' && stagesPayload !== null
        ? stagesPayload.map((s) => s.command_argv)
        : [argv];
      for (const [stageIndex, stageArgv] of commandsToCheck.entries()) {
        const refused = checkAllowedCommand(cfg.allowedCommands, stageArgv);
        if (refused) {
          // The refusal is a *value*, like every other verdict this project reports, and it carries
          // the code twice on purpose: `refusal_reason` is the field a caller and a report already
          // read, `reason_code` is the same code under the name the rest of the gates now use, and
          // `detail` is what would change it. No request is made, so this result is the only trace
          // of the decision the caller gets.
          return JSON.stringify(
            {
              ok: false,
              state: 'refused',
              refusal_reason: refused.reason_code,
              reason_code: refused.reason_code,
              message: commandsToCheck.length > 1
                ? `stage ${stageIndex}: ${refused.message}`
                : refused.message,
              detail: refused.detail,
              stage_index: commandsToCheck.length > 1 ? stageIndex : null,
              allowed: refused.allowed,
            },
            null,
            2,
          );
        }
      }

      // The default comes from the merged shared config, so a fleet that agrees on a timeout gets it
      // from one committed file instead of every machine's own settings. The per-call argument still
      // wins, and MAX_TASK_TIMEOUT_MS still bounds the result.
      const timeoutMs = Math.min(
        Math.max(1, Number.isFinite(args?.timeout_ms) ? Number(args.timeout_ms) : cfg.defaultTimeoutMs),
        MAX_TASK_TIMEOUT_MS,
      );
      const write = args?.write === true;
      const writeScope = Array.isArray(args?.write_scope)
        ? args.write_scope.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        : [];
      if (write && writeScope.length === 0) {
        throw new W2MError(
          'W2M_WRITE_SCOPE',
          'W2M_WRITE_SCOPE: `write` is true but `write_scope` is empty; name the project-relative prefixes the machines may write, for example ["src/"], or set write to false',
          { hint: 'name the project-relative prefixes the machines may write, for example ["src/"], or leave write false' },
        );
      }

      /**
       * v0.22.0: the permission gate, placed AFTER the write-scope check so the thing being graded is
       * already known to be well-formed.
       *
       * It grades the dispatch from its own facts rather than from a capability the caller names, and with
       * no configured level it reports `enforced: false` and changes nothing -- which is why adding it
       * cannot alter the behaviour of any machine that has not opted in.
       */
      const gate = gateDispatch({ write, write_scope: writeScope }, cfg.actorAuthorityLevel);
      if (gate.enforced) {
        if (gate.decision.verdict === 'deny') {
          throw new W2MError(
            'W2M_PERMISSION_DENIED',
            'W2M_PERMISSION_DENIED: ' + gate.decision.detail,
            { hint: "raise this machine's actorAuthorityLevel, or use a capability its level reaches" },
          );
        }
        if (gate.decision.verdict === 'needs_approval') {
          // v0.24.0: the request is QUEUED now, not merely refused with a description of a queue. The
          // dispatch still does not run -- an escalation is a request to be allowed, not a permission --
          // but the request is a real entry an approver can find and settle, and its id comes back so the
          // caller can name what it is waiting on.
          const request = approvalRequestFor(gate.decision, {
            taskId: null,
            machineId: null,
            requestedBy: cfg.machineName,
          });
          // v0.31.0: the raise path passes the front door BEFORE a request exists. A flood of raises is
          // what the limiter is for, so a refused raise must not have already created the request it was
          // refused for.
          const permission = approvalGate.mayRaise({ id: cfg.machineName, level: cfg.actorAuthorityLevel });
          if (!permission.allowed) {
            throw new W2MError(
              'W2M_PERMISSION_APPROVAL_RATE_LIMITED',
              'W2M_PERMISSION_APPROVAL_RATE_LIMITED: ' + permission.detail,
              {
                hint: 'wait for the window to pass and dispatch again; the queue was not cleared and existing requests are still answerable',
                detail: {
                  reason_code: permission.reason_code,
                  retry_after_seconds: permission.retry_after_seconds,
                  budget: approvalGate.budgetFor({ id: cfg.machineName, level: cfg.actorAuthorityLevel }),
                },
              },
            );
          }
          const approvalId = randomUUID();
          const raised = raiseApproval(approvalQueue(), request, { approvalId, toolName: 'w2m_run' });
          if (!raised.ok) {
            // The queue refused it, which is a different failure from needing approval and must not be
            // reported as one: a caller told "await approval" for a request that was never stored would wait
            // forever for a decision nobody can make.
            throw new W2MError(
              'W2M_PERMISSION_APPROVAL_NOT_RAISED',
              'W2M_PERMISSION_APPROVAL_NOT_RAISED: ' + raised.reason_code + ': ' + raised.detail,
              { hint: 'the approval request could not be queued, so this dispatch is refused rather than left waiting', request },
            );
          }
          throw new W2MError(
            'W2M_PERMISSION_NEEDS_APPROVAL',
            'W2M_PERMISSION_NEEDS_APPROVAL: ' + gate.decision.detail,
            {
              hint: 'this dispatch is queued awaiting an approver; approve or reject it with w2m_approvals, then dispatch again',
              // Carried in `detail`, not as top-level options: `W2MError` accepts only code, message, hint,
              // detail, cause and reason_code, so anything else passed here is DROPPED SILENTLY. The first
              // version of this passed `approval_id` at the top level and the test caught it by finding
              // nothing -- which is exactly the kind of omission that would otherwise have reached a user as
              // "await approval" with no way to name what they are waiting for.
              detail: { approval_id: raised.approval_id, request },
            },
          );
        }
      }

      // §5: dispatching a task is the operator's privilege, not the device's. The operator token is
      // required and there is no device-token fallbac - see requireOperatorToken.
      const token = requireOperatorToken(cfg);
      const anchors = await resolveGitAnchors({ projectDir: cfg.projectDir, timeoutMs: Math.min(15_000, timeoutMs) });

      // §7: the two routing facts the offer carries to the machine that has to run the command.
      //
      // `origin_machine_id` is *this* machine's id from `device.json`  - where the work was typed, not
      // where it runs  - and it is omitted entirely (not sent as null) when this machine has no
      // identity, because the relay's own validation refuses an empty string and "unknown origin" is
      // what a missing field already means on the wire.
      //
      // The identity comes from the runtime, which resolves it off the dispatch path; a dispatch that
      // arrives before that one small read has finished waits for it rather than racing it. The wait
      // is bounded by the identity read itself and can never reject  - see `createP2PRuntime`. This is
      // also the first use of the direct path, so it is where the node is started.
      await p2p.ensureStarted();
      const originMachineId =
        typeof p2p.machineId === 'string' && p2p.machineId !== '' ? p2p.machineId : null;


      /**
       * v0.4.x: the punch this dispatch will use, published with the task so the executor can join
       * the same session instead of waiting to be reached. See {@link buildP2POfferBlock} for why the
       * block carries a punch id rather than the session itself, and why `relay` mode publishes
       * `{mode}` alone.
       */
      const p2pOffer = buildP2POfferBlock(cfg, p2p);

      const payload = {
        mode,
        // Under pipeline the relay derives this from stage 0; sending the caller's value when there is
        // none would put `undefined` on the wire, which JSON drops -- so it is omitted explicitly and
        // the relay's normalization is the single source of that field.
        ...(argvUsable ? { command_argv: argv } : {}),
        cwd_rel: typeof args?.cwd_rel === 'string' && args.cwd_rel !== '' ? args.cwd_rel : '.',
        // Sent only when the caller asked, so every existing dispatch produces the same bytes on the wire.
        ...(args?.cwd_outside_project === true ? { cwd_outside_project: true } : {}),
        index_total: indexTotal,
        timeout_ms: timeoutMs,
        write,
        write_scope: writeScope,
        require_exclusive_write: args?.require_exclusive_write === true,
        base_commit: anchors.base_commit,
        base_tree: anchors.base_tree,
        requirements: { toolchain: {}, platform: [] },
        compare_policy: { strip_ansi: true, normalize_crlf: true, strip_trailing_blank_lines: true, redact: [] },
        halt: args?.halt === 'now' ? 'now' : 'never',
        // v1.2.4 mapreduce: sent only under that mode, so every other dispatch stays byte-identical.
        ...(mode === 'mapreduce'
          ? {
              reduce_argv: [...args.reduce_argv],
              ...(typeof args?.reducer_machine_id === 'string' && args.reducer_machine_id !== ''
                ? { reducer_machine_id: args.reducer_machine_id }
                : {}),
            }
          : {}),
        // v1.2.4: the retry policy travels only when the caller asked for one, so a default dispatch stays byte-identical.
        ...(Number.isInteger(args?.max_attempts) && args.max_attempts > 1 ? { max_attempts: args.max_attempts } : {}),
        ...(Array.isArray(args?.retry_on) && args.retry_on.length > 0 ? { retry_on: args.retry_on } : {}),
        // v1.2.7: graph edges and assignment travel only when declared, so a default dispatch stays byte-identical.
        ...(Array.isArray(args?.depends_on) && args.depends_on.filter((id) => typeof id === 'string' && id !== '').length > 0
          ? { depends_on: args.depends_on.filter((id) => typeof id === 'string' && id !== '') }
          : {}),
        ...(typeof args?.assignee === 'string' && args.assignee.trim() !== '' ? { assignee: args.assignee.trim() } : {}),
        created_by: cfg.machineName,
        // Only sent for broadcast; the relay ignores it otherwise, and the validation above already
        // refused the combination, so this cannot silently mean nothing.
        ...(executorMachineId !== null ? { executor_machine_id: executorMachineId } : {}),
        // v0.6.1: the elected machine, when the caller did not name one and a mode that reads it is
        // in play. Spread after the caller's own field above so the caller always wins even if a
        // future edit makes both possible.
        ...selectionFields,
        // Named on the wire only when asked, so a default dispatch sends the same bytes as it always did.
        ...(args?.include_offline === true ? { include_offline: true } : {}),
        // Only for pipeline. The relay ignores `stages` under the other modes and the validation
        // above refuses the combination, so this can never silently mean nothing.
        ...(mode === 'pipeline' && stagesPayload !== null ? { stages: stagesPayload } : {}),
        // v0.4.0: stated on every task, so `w2m_wait`'s `transport` and a machine's report can say
        // which path the dispatcher expected to use  - and so the executor in `direct` mode knows it
        // must refuse an offer that did not arrive over the direct path.
        ...(originMachineId !== null ? { origin_machine_id: originMachineId } : {}),
        p2p: p2pOffer,
      };

            // v2/S1: a narrowed dispatch is revalidated against the relay roster immediately before the
      // POST, so a machine that went away after the composer selection is a named refusal rather
      // than a task that expires with no executor.
      const narrowedTo = selectionAppliedAs === 'executor_machine_id' || selectionAppliedAs === 'target_machines'
        ? (selection?.machine_id ?? null)
        : (executorMachineId ?? null);
      // v3.5.0: a named `assignee` is a target restriction too. It is kept apart from the
      // composer-selection contract above (the relay owns `assignee`) so nothing about selection
      // behaviour changes; it only tells the version gate which machines this task can run on.
      const assignedTo =
        typeof args?.assignee === 'string' && args.assignee.trim() !== '' ? args.assignee.trim() : null;
      const gateTargetIds = narrowedTo !== null || assignedTo !== null
        ? [...new Set([narrowedTo, assignedTo].filter((id) => id !== null))]
        : null;

      const runningVersion = resolveCurrentVersion(PLUGIN_VERSION, process.env);
      const versionGateActive = isVersionGateActive(runningVersion, MIN_SUPPORTED_PLUGIN_VERSION);

      /**
       * One roster read for both the narrowed-target revalidation and the version gate.
       *
       * Best-effort by design: the relay remains the authority on whether a dispatch is allowed, so
       * a transient `GET /v1/devices` failure must not become a dispatch refusal. The version gate
       * reports the gap (`version_gate.checked: false`) instead of silently treating an unreadable
       * roster as "everything is current" -- an unreadable roster is not evidence of anything.
       */
      let roster = null;
      if (narrowedTo !== null || versionGateActive) {
        try {
          roster = await readFleet({ rabbitUrl: base, token, localMachineId: null, signal: exec?.signal, request });
        } catch { roster = null; }
      }

      if (narrowedTo !== null && roster?.ok === true) {
        // `readFleet` projects the roster into `machines`, where `online` is the same liveness rule
        // the composer renders. (This check used to read a `devices` field `readFleet` never
        // returned, which refused every narrowed dispatch whenever the roster read succeeded; the
        // projection is the fix, and the version gate below reads the same snapshot.)
        const listed = (roster.machines ?? []).find((machine) => machine?.machine_id === narrowedTo);
        if (listed === undefined || listed.online !== true) {
          throw new W2MError(
            'TARGET_UNAVAILABLE',
            `TARGET_UNAVAILABLE: the target machine ${narrowedTo} is not online on the relay right now; nothing was dispatched and no other machine was chosen`,
            { hint: 'pick another machine in the composer, or clear the selection to dispatch to the whole fleet' },
          );
        }
      }

      /**
       * v3.5.0: the fleet minimum-version gate.
       *
       * Only machines this dispatch would actually use are graded: every online machine for a
       * dispatch the relay may route anywhere, exactly the named machine(s) for a narrowed dispatch,
       * a named executor or a named assignee. An old machine that will not run this command does not
       * block it -- it is refused on the dispatch that would use it.
       *
       * Offline machines are not graded (they are gated on the dispatch that brings them back), but
       * an online machine whose version cannot be read is `unknown`, and unknown is refused for the
       * same reason as outdated: the gate must not pass what it could not check.
       */
      let versionGate = null;
      let outdatedAllowed = [];
      if (versionGateActive) {
        if (roster?.ok === true) {
          const online = (roster.records ?? []).filter((record) => isSelectableDevice(record));
          const decision = evaluateVersionGate({
            machines: online.map((record) => ({
              machine_id: record?.machine_id ?? null,
              name: record?.machine_name ?? record?.name ?? null,
              version: record?.caps?.plugin_version,
            })),
            targetIds: gateTargetIds,
            supportedMin: MIN_SUPPORTED_PLUGIN_VERSION,
            runningVersion,
            allowOutdated: args?.allowOutdated === true,
          });
          if (decision.ok !== true) {
            throw new W2MError(
              VERSION_GATE_CODES.MACHINE_VERSION_UNSUPPORTED,
              `MACHINE_VERSION_UNSUPPORTED: refusing to dispatch: ${decision.detail.summary}; the fleet ` +
                `minimum is ${MIN_SUPPORTED_PLUGIN_VERSION}. Upgrade the named machine(s), or pass ` +
                'allowOutdated: true to dispatch anyway (an explicit, audited override)',
              {
                hint: `upgrade the named machine(s) to ${MIN_SUPPORTED_PLUGIN_VERSION} or newer, or re-run with allowOutdated: true after accepting that the old machine may not implement this protocol`,
                detail: decision.detail,
              },
            );
          }
          const audit = decision.allow_outdated
            ? {
                event: 'dispatch.outdated_allowed',
                at: new Date().toISOString(),
                supported_min: MIN_SUPPORTED_PLUGIN_VERSION,
                machines: decision.outdated_allowed,
                note:
                  'allowOutdated: true was supplied, so these machines were dispatched to even though the fleet ' +
                  `minimum is ${MIN_SUPPORTED_PLUGIN_VERSION}; the override is recorded here and in the host log`,
              }
            : null;
          if (audit !== null) {
            outdatedAllowed = decision.outdated_allowed;
            // Best-effort durable trace: the dispatch result names the machines, and this line is
            // what a host log grep finds. Never fatal.
            ctx.logger?.warn?.(
              'w2m: MACHINE_VERSION_UNSUPPORTED override allowed for ' +
                decision.outdated_allowed
                  .map((machine) => `${machine.machine_id}=${machine.version ?? 'unknown'}`)
                  .join(', ') +
                ` (fleet minimum ${MIN_SUPPORTED_PLUGIN_VERSION})`,
            );
          }
          versionGate = {
            active: true,
            checked: decision.checked,
            supported_min: MIN_SUPPORTED_PLUGIN_VERSION,
            allow_outdated: decision.allow_outdated,
            ...(audit === null ? {} : { audit }),
          };
        } else {
          versionGate = {
            active: true,
            checked: false,
            supported_min: MIN_SUPPORTED_PLUGIN_VERSION,
            reason_code: 'VERSION_GATE_UNVERIFIABLE',
            detail:
              'the fleet roster could not be read, so no machine version was checked; the relay remains the ' +
              'authority on whether the dispatch is allowed',
          };
        }
      }


const result = await request({
        rabbitUrl: base,
        token,
        signal: exec?.signal,
        method: 'POST',
        pathname: '/v1/task',
        body: payload,
      });

      if (!result.ok) {
        // OPERATOR_REQUIRED gets its own guidance: it is the one refusal whose fix is a client-side
        // setting rather than something on the relay.
        const operatorRequired = result.error?.code === 'OPERATOR_REQUIRED' || result.status === 401;
        // v0.6.1: when a task was elected to one machine, NO_ONLINE_DEVICE is the *machine* being
        // unreachable, not the fleet being empty -- and the two have different fixes. Saying so is
        // the difference between "start an agent" and "the machine you picked went away".
        const selectedName = selection?.machine_name ?? selection?.machine_id ?? null;
        const selectedMissing = result.error?.code === 'NO_ONLINE_DEVICE' && selectionAppliedAs !== null;
        throw new W2MError(
          'W2M_RABBIT_REFUSED',
          `W2M_RABBIT_REFUSED: the Rabbit refused POST /v1/task with HTTP ${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}; ${operatorRequired ? 'this relay requires the operator token to dispatch tasks and the one sent was not accepted - set `operatorToken` (or `W2M_OPERATOR_TOKEN`) to the value the relay printed at startup; a device token cannot dispatch tasks' : selectedMissing ? `this session's selected machine (${selectedName}) is not among the machines the relay currently holds, so a task narrowed to it has no target - pick another machine in the composer, or clear the selection` : result.error?.code === 'NO_ONLINE_DEVICE' ? 'no machine is currently streaming - start the agent on each machine, then w2m_devices shows who is online' : 'check the Rabbit log for the reason it gave'}`,
          {
            hint: operatorRequired
              ? 'set `operatorToken` (or `W2M_OPERATOR_TOKEN`) to the value the relay printed at startup, or read it from `<state>/operator-token.txt`'
              : selectedMissing
                ? `the selected target was sent as ${selectionAppliedAs}=${selection?.machine_id ?? ''}; clear the composer selection to dispatch to the whole fleet again`
                : result.error?.code === 'NO_ONLINE_DEVICE'
                  ? 'no machine is currently streaming; start the agent on each machine (w2m_devices shows who is online)'
                  : 'check the Rabbit log for the reason it gave',
          },
        );
      }

      // v2/S1: the relay's own lease list is the proof that the narrowing was honoured. A lease on a
      // machine that was not named means the dispatch widened (old relay ignoring the field, or a
      // routing bug): cancel and refuse rather than let the wrong machines run.
      if (narrowedTo !== null) {
        const leases = Array.isArray(result.json?.leases) ? result.json.leases : [];
        const executing = leases.filter((lease) => lease?.state !== 'observing');
        const foreign = executing.filter((lease) => lease?.machine_id !== narrowedTo);
        if (foreign.length > 0) {
          const taskId = result.json?.task_id ?? null;
          if (taskId !== null) {
            try {
              await request({ rabbitUrl: base, token, signal: exec?.signal, method: 'POST', pathname: '/v1/tasks/' + encodeURIComponent(taskId) + '/cancel', body: { reason: 'SELECTION_NOT_HONOURED' } });
            } catch { /* the refusal below is still the answer */ }
          }
          throw new W2MError(
            'SELECTION_NOT_HONOURED',
            'SELECTION_NOT_HONOURED: this dispatch named ' + narrowedTo + ', but the relay leased ' + (foreign.map((lease) => lease.machine_id).join(', ') || 'no machine') + '; the task was cancelled',
            { hint: 'upgrade the relay to a version that honours target_machines/executor_machine_id, or clear the selection' },
          );
        }
      }

/**
       * v0.4.0 §7: best-effort direct pushes, after the relay has the task.
       *
       * Order matters and is deliberate. The task exists on the relay *before* anything is punched,
       * so a push that fails, a peer that never announced and a socket that was never bound all leave
       * exactly the same outcome: the relay's own SSE offer is the delivery, and the machine's
       * `transport` says which path won. A failed push is therefore **not** an error and never fails
       * this tool  - but it is not hidden either, because `direct_pushes` names every attempt and the
       * reason it did not land.
       *
       * `relay` mode and a machine with no direct path both report `attempted: 0`, which is the
       * honest answer ("there was nothing to push over") rather than an empty object.
       */
      let directPushes = {
        mode: cfg.p2pMode,
        // The punch this dispatch published and dialled with. Repeated here so one dispatch's answer
        // is self-contained: an operator correlating it with a machine's `p2p.session` or with the
        // machine's own log has the value in hand without a second call.
        punch: p2pOffer.punch ?? null,
        attempted: 0,
        delivered: 0,
        failed: 0,
        pushes: [],
        data_plane: {
          preferred: 'webrtc-v1',
          fallback: 'udp-v1',
          relay_ledger: 'always',
          webrtc_pushes: 0,
          udp_fallbacks: 0,
          failed_without_direct: 0,
        },
      };
      const webrtcPool = inProcessWebRtcPool;
      if ((webrtcPool !== null && typeof webrtcPool.send === 'function') || (cfg.p2pMode !== 'relay' && p2p.node !== null && p2p.start?.ok === true)) {
        try {
          const pushes = await pushOffers(p2p.node, {
            taskId: result.json?.task_id ?? null,
            leases: Array.isArray(result.json?.leases) ? result.json.leases : [],
            payload,
            originMachineId,
            // v0.6.0: where each target's static public key is read from, so the offer addressed to a
            // machine can carry the key that machine needs to authenticate the dispatcher's handshake.
            getJson: p2p.node?.getJson ?? null,
            // v3.5.8: the shared pool built by `startLocalStack`; the dispatcher and its own agent
            // deliberately share one machine identity and one signaling role.
            webrtcPool,
          });
          directPushes = {
            ...directPushes,
            attempted: pushes.length,
            delivered: pushes.filter((entry) => entry.ok).length,
            failed: pushes.filter((entry) => !entry.ok).length,
            pushes,
            // How many of the machines that were reached were reached over a channel *this* machine
            // did not open  - the executor dialled first, and the push landed on that path. Zero on a
            // fleet where only the dispatcher initiates, which is what makes the two-way punch
            // visible in one dispatch's own answer instead of only in the ledger.
            reused_channels: pushes.filter((entry) => entry.reused === true).length,
            // v3.5.8: the data-plane split, stated per dispatch so "the result came back over
            // WebRTC" cannot be confused with "the ledger did not go through the relay".
            data_plane: {
              preferred: 'webrtc-v1',
              fallback: 'udp-v1',
              relay_ledger: 'always',
              webrtc_pushes: pushes.filter((entry) => entry.transport === 'webrtc-v1').length,
              udp_fallbacks: pushes.filter((entry) => entry.transport === 'udp-v1' && entry.fallback_from === 'webrtc-v1').length,
              failed_without_direct: pushes.filter((entry) => entry.ok !== true && entry.transport === 'relay').length,
            },
          };
        } catch (error) {
          // `pushOffers` is written not to throw; this is here so a future edit cannot turn a
          // best-effort optimisation into a failed dispatch.
          directPushes = {
            ...directPushes,
            error: `P2P_PUSH_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      } else if (cfg.p2pMode !== 'relay') {
        directPushes.error = p2p.error ?? 'the direct path is not running, so nothing was pushed';
      }
      // eslint-disable-next-line require-atomic-updates -- each dispatch writes its own summary; the last one wins by design
      p2p.directPushes = directPushes;

      return JSON.stringify(
        {
          ok: true,
          task_id: result.json?.task_id ?? null,
          seq: result.json?.seq ?? null,
          leases: result.json?.leases ?? [],
          anchors: {
            base_commit: anchors.base_commit,
            base_tree: anchors.base_tree,
            dirty: anchors.dirty,
            branch: anchors.branch,
            fingerprint_algo: 'git-temp-index-tree/v1',
            error: anchors.error,
          },
          // v0.4.0: what the direct path tried, per machine. `mode` is repeated here rather than left
          // to `w2m_status` so one dispatch's answer is self-contained.
          direct_pushes: directPushes,
          // v0.6.1: whether this dispatch was narrowed to the composer's selected machine, and to
          // which one. Published because a dispatch that ran somewhere other than where the operator
          // pointed is the one failure this feature could hide, and a caller that cannot see the
          // routing cannot report it. `applied` is kept as the boolean it has always been; the code
          // and detail beside it say which of the four situations produced it.
          selection: selection === null
            ? { applied: false, field: null, machine_id: null, machine_name: null, session: sessionKey, ...selectionReason }
            : {
                applied: selectionAppliedAs !== null,
                field: selectionAppliedAs,
                machine_id: selection.machine_id,
                machine_name: selection.machine_name,
                session: sessionKey,
                ...selectionReason,
              },
          /**
           * v3.5.0: what the minimum-version gate decided. Present only when the gate is active for
           * this build (a 3.5.0+ dispatcher); a pre-3.5.0 build does not pretend it checked anything.
           * `checked: false` means the roster could not be read -- an unverifiable dispatch is
           * reported as such rather than as "all machines are current".
           */
          ...(versionGate === null ? {} : { version_gate: versionGate }),
          // v3.5.0: the machines an explicit `allowOutdated: true` waved through, named with their
          // own reason codes. Only present when the override actually changed the outcome, so a
          // normal dispatch's result stays byte-shape-compatible.
          ...(outdatedAllowed.length === 0 ? {} : { outdated_allowed: outdatedAllowed }),
          /**
           * The note has to match what the relay will actually do.
           *
           * It used to end by promising that the aggregate would be unverifiable, which was true when
           * the relay compared an absent anchor against the literal `null`: every machine with a real
           * commit violated it, so an unanchored dispatch could never aggregate. v0.9.3 made the relay
           * skip a check nobody declared (`base_commit` now behaves like `base_tree` always did), so the
           * same dispatch reaches a real verdict -- and the old wording would have told an operator to
           * doubt an `ok` result that is correct. The sentence is deliberately not reproduced here: a
           * verbatim copy of retired output is indistinguishable from live output to anything that
           * searches rather than reads, including the check that verified this change.
           *
           * What is still true, and is the thing worth saying: without an anchor there is no answer to
           * "did these machines run the same tree", so consistency here is agreement between machines.
           */
          note: anchors.base_tree === null
            ? 'this machine\'s working tree could not be fingerprinted, so no anchor was declared: peers are compared with each other, not against a named tree'
            : 'peers are checked against base_commit + base_tree + command_hash',
        },
        null,
        2,
      );
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `w2m run ${Array.isArray(args?.command_argv) ? args.command_argv.join(' ') : ''}`.trim(),
      kind: args?.write === true ? 'write' : 'read',
      rawInput: args,
    }),
  }));
}

  // -------------------------------------------------------------------------------------------
  // 3. w2m_wait
  // -------------------------------------------------------------------------------------------
export function registerWait(ctx, deps) {
  const { cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_wait',
    description:
      'Wait for a task to reach a terminal state and return the aggregate verdict with a ' +
      'per-machine summary. The verdicts are consistent, divergent, divergent-platform, failed, ' +
      'partial, unverifiable, timeout, cancelled and degraded. A non-zero exit, a refusal, and a ' +
      'divergence are all reported as values, not as tool failures. If the wait window elapses ' +
      'first, says so and leaves the task runnabl - call again to keep waiting.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by w2m_run.' },
      wait_ms: {
        type: 'number',
        description: `How long to wait before giving up, in milliseconds. Defaults to 120000, capped at ${MAX_WAIT_MS}.`,
        default: 120_000,
      },
      poll_ms: {
        type: 'number',
        description: `Interval between status polls, in milliseconds. Defaults to 750. Raise it to be gentler on the Rabbit; it is capped below by ${MIN_POLL_MS}.`,
        default: 750,
      },
      reducer_machine_id: {
        type: 'string',
        description: 'For a task whose machines produced blobs: which machine runs the reduce step. Without it a blob result is reported as degraded (REDUCER_MISSING) rather than silently treated as complete.',
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : '';
      if (taskId === '') {
        throw new W2MError('W2M_BAD_TASK_ID', '`task_id` must be a non-empty string');
      }

      const waitMs = Math.min(Math.max(1, Number.isFinite(args?.wait_ms) ? Number(args.wait_ms) : 120_000), MAX_WAIT_MS);
      const pollMs = Math.min(Math.max(MIN_POLL_MS, Number.isFinite(args?.poll_ms) ? Number(args.poll_ms) : 750), 30_000);
      const token = await resolveToken(cfg);

      const deadline = Date.now() + waitMs;

      let body = null;
      let attempts = 0;
      let lastFailure = null;

      for (;;) {
        throwIfAborted(exec?.signal);
        const result = await request({
          rabbitUrl: base,
          token,
          signal: exec?.signal,
          pathname: `/v1/tasks/${encodeURIComponent(taskId)}`,
        });
        attempts += 1;

        if (!result.ok && !RETRYABLE_STATUS.has(result.status)) {
          throw new W2MError(
            'W2M_RABBIT_REFUSED',
            `W2M_RABBIT_REFUSED: the Rabbit refused GET /v1/tasks/${taskId} with HTTP ${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}; ${result.error?.code === 'NOT_FOUND' ? `check the task_id returned by w2m_ru - the Rabbit does not know \`${taskId}\`` : 'check the Rabbit log for the reason it gave'}`,
            { hint: result.error?.code === 'NOT_FOUND' ? 'check the task_id returned by w2m_run' : 'check the Rabbit log' },
          );
        }

        // A retryable failure leaves us with no state to read: keep whatever the last good answer
        // said, and remember that the latest attempt did not land.
        if (result.ok) {
          body = result.json;
          lastFailure = null;
          const current = readAggregate(body);
          if (current.terminal) break;
        } else {
          lastFailure = `HTTP ${result.status}${result.error ? ` (${result.error.code})` : ''}`;
        }

        if (Date.now() >= deadline) {
          const states = readAggregate(body).states;
          const envelope = timeoutEnvelope(taskId, states.length > 0 ? states.map(String) : ['unknown']);
          // Both facts matter when nothing was ever read: how far we got, and why. Reporting only
          // the first would hide a Rabbit that answered every time with a retryable error.
          const note = body === null
            ? `no status has been read from the Rabbit yet; the task may or may not exist${lastFailure ? ` - the most recent poll did not land (${lastFailure})` : ''}`
            : (lastFailure
              ? `${envelope.note}; the most recent poll did not land (${lastFailure})`
              : envelope.note);
          return JSON.stringify(
            {
              ...envelope,
              // After the spread, so the local verdict is not overwritten by what was last seen.
              state: 'timeout',
              last_state: readAggregate(body).state,
              note,
              polls: attempts,
              ...(lastFailure ? { last_error: lastFailure } : {}),
            },
            null,
            2,
          );
        }

        const remaining = deadline - Date.now();
        await sleepWithSignal(Math.min(pollMs, Math.max(1, remaining)), exec?.signal);
      }

      const aggregate = readAggregate(body);
      const machines = Array.isArray(aggregate.detail?.machines)
        ? aggregate.detail.machines.map((machine) => {
            const envelope = machine?.envelope ?? machine?.result ?? null;
            // v1.2.6: the signature covers the command tuple; a reader is told which of the three states it is in.
            const relayVerdict = typeof machine?.signature_status === 'string' && machine.signature_status !== '' ? machine.signature_status : null;
          const signatureStatus = relayVerdict ?? verifyEnvelopeSignature({
              signature: envelope?.signature ?? null,
              task_id: envelope?.task_id ?? taskId,
              argv_hash: envelope?.command_hash,
              machine_id: envelope?.machine_id ?? machine?.machine_id,
            });
            return {
              machine_id: machine?.machine_id ?? null,
              machine_name: machine?.machine_name ?? null,
              index: machine?.index ?? null,
              lease_state: machine?.lease_state ?? null,
              outcome: machine?.outcome ?? null,
              status: machine?.status ?? null,
              refusal_reason: machine?.refusal_reason ?? null,
              exit_code: machine?.exit_code ?? null,
              /**
               * v0.4.0 §5: which path this machine's result travelled, and the path facts that came
               * with it. Read from the envelope because that is where the agent writes them, with the
               * per-machine record as the fallback (`GET /v1/tasks/{id}` copies both onto the machine
               * entry as well). `null` means the machine did not say  - which is exactly what a
               * v0.3.9 agent sends, so a missing value must not be dressed up as `'relay'`.
               */
              transport: envelope?.transport ?? machine?.transport ?? null,
              signature_status: signatureStatus,
              p2p: envelope?.p2p ?? machine?.p2p ?? null,
              reasons: machine?.reasons ?? [],
              envelope: compactEnvelope(envelope, COMPARABLE_FIELDS),
            };
          })
        : [];

      // v1.2.6: a signature state is never silently flattened into success.
      const signatureCounts = machines.reduce((counts, machine) => {
        const key = machine.signature_status ?? 'unsigned';
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {});
      const unsigned = signatureCounts.unsigned ?? 0;
      const badSignature = signatureCounts.bad_signature ?? 0;

      // v1.2.4: a task whose machines produced blobs is only complete when EVERY map result names one and a reducer was
      // declared. The plan is built from the RAW envelopes: the comparable copy intentionally drops the fields this needs,
      // and a reduce over a partial fleet that reports itself complete is the failure this guards.
      const reducerMachineId = typeof args?.reducer_machine_id === 'string' && args.reducer_machine_id.trim() !== ''
        ? args.reducer_machine_id.trim()
        : null;
      // v1.2.9: the task's own shard count is the completeness contract, used by both the plan and the suggestion.
      const expectedIndexTotal = Number.isInteger(body?.task?.index_total) ? body.task.index_total : null;
      // v1.2.7: the relay publishes machine facts directly on the aggregate; `detail.machines` is a test/report shape that the
      // real /v1/tasks response does not carry. Reading only the latter made the reduce plan silently unreachable in production.
      const rawMachines = Array.isArray(aggregate.detail?.machines)
        ? aggregate.detail.machines
        : (Array.isArray(aggregate.machines) ? aggregate.machines : []);
      // v1.2.7: only a machine that actually reported can claim a shard. An expired lease still carries an index, and counting
      // it as "produced" would make a partial run look complete -- the exact failure the expected-index check exists to prevent.
      const reportedMachines = rawMachines.filter((machine) => (machine?.envelope ?? machine?.result ?? null) !== null || typeof machine?.blob_sha256 === 'string' || typeof machine?.stdout_head === 'string' || Number.isFinite(machine?.stdout_bytes) || (typeof machine?.status === 'string' && machine.status !== '' && Number.isFinite(machine?.exit_code)));
      const mapResults = reportedMachines.map((machine) => {
        const envelope = machine?.envelope ?? machine?.result ?? null;
        const blobSha = typeof envelope?.blob_sha256 === 'string' ? envelope.blob_sha256
          : (typeof machine?.blob_sha256 === 'string' ? machine.blob_sha256 : null);
        const inline = typeof envelope?.stdout_head === 'string' && envelope.stdout_head !== '' ? envelope.stdout_head
          : (typeof machine?.stdout_head === 'string' && machine.stdout_head !== '' ? machine.stdout_head : null);
        return {
          machine_id: machine?.machine_id ?? null,
          // v1.2.7: the shard this result belongs to, so the reduce plan can tell "complete" from "the rest never reported".
          index: Number.isInteger(machine?.index) ? machine.index : (Number.isInteger(envelope?.index) ? envelope.index : null),
          mode: blobSha === null ? 'inline' : 'blob',
          ...(inline === null ? {} : { stdout: inline }),
          ...(blobSha === null ? {} : { blob_sha256: blobSha }),
        };
      });
      const anyBlob = mapResults.some((entry) => entry.mode === 'blob');
      const reduce = anyBlob && reducerMachineId !== null
        ? buildReducePlan({
            results: mapResults,
            reducerMachineId,
            // v1.2.7: the task's own shard count is the completeness contract; absent it, the old "just what arrived" plan stands.
            expectedIndexTotal,
          })
        : null;
      const dataflowDegraded = reduce !== null && reduce.ok !== true;

      return JSON.stringify(
        {
          ok: true,
          complete: true,
          task_id: taskId,
          state: dataflowDegraded ? 'degraded' : aggregate.state,
          state_known: aggregate.known,
          states: aggregate.states,
          machines,
          signatures: signatureCounts,
          ...(badSignature > 0 ? { signature_warning: 'bad_signature' } : {}),
          ...(badSignature === 0 && unsigned > 0 ? { signature_warning: 'unsigned' } : {}),
          ...(reduce === null ? {} : { reduce }),
          /**
           * v1.2.9: complete-or-not, the candidate reducers, and the literal next step. This is a SUGGESTION: the tool does not
           * dispatch the reduce, because choosing a machine to run a command is the caller's decision everywhere else in the fleet.
           */
          reduce_suggestion: suggestReduce({ machines: rawMachines, reducerMachineId, expectedIndexTotal }),
          ...(dataflowDegraded ? { dataflow_degraded: true } : {}),
          counts: aggregate.detail?.counts ?? null,
          differences: aggregate.detail?.differences ?? [],
          notes: aggregate.detail?.notes ?? [],
          unknown_fields: collectUnknownFields(body, { comparable: COMPARABLE_FIELDS, optional: OPTIONAL_FIELDS }),
          polls: attempts,
        },
        null,
        2,
      );
    },
    presentCall: (args) => ({ card: 'generic', title: `w2m wait ${args?.task_id ?? ''}`, kind: 'read', rawInput: args }),
  }));
}

  // -------------------------------------------------------------------------------------------
  // 4. w2m_report
  // -------------------------------------------------------------------------------------------
export function registerReport(ctx, deps) {
  const { cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_report',
    description:
      'Fetch the rendered report for a finished task, as markdown or json. Markdown is the ' +
      'human summary; json is the same aggregate shape w2m_wait returns. Read-only, and does ' +
      'not start, resume, or cancel anything.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by w2m_run.' },
      format: { type: 'string', description: 'md for the rendered report, json for the aggregate. Defaults to md.', default: 'md' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : '';
      if (taskId === '') {
        throw new W2MError('W2M_BAD_TASK_ID', '`task_id` must be a non-empty string');
      }
      const format = args?.format === 'json' ? 'json' : 'md';
      const token = await resolveToken(cfg);

      const result = await request({
        rabbitUrl: base,
        token,
        signal: exec?.signal,
        pathname: `/v1/tasks/${encodeURIComponent(taskId)}/report`,
        query: { format },
        maxBytes: MAX_REPORT_BYTES,
        accept: format === 'json' ? 'application/json' : 'text/markdown, text/plain',
      });

      if (!result.ok) {
        throw new W2MError(
          'W2M_RABBIT_REFUSED',
          `W2M_RABBIT_REFUSED: the Rabbit refused GET /v1/tasks/${taskId}/report with HTTP ${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}; ${result.error?.code === 'NOT_FOUND' ? 'the task may still be runnin - w2m_wait first, or check the task_id returned by w2m_run' : 'check the Rabbit log for the reason it gave'}`,
          { hint: result.error?.code === 'NOT_FOUND' ? 'the task may still be running; w2m_wait first' : 'check the Rabbit log' },
        );
      }

      if (format === 'json') {
        return JSON.stringify(
          { ok: true, task_id: taskId, format, report: result.json ?? result.text },
          null,
          2,
        );
      }

      return JSON.stringify(
        {
          ok: true,
          task_id: taskId,
          format,
          bytes: Buffer.byteLength(result.text, 'utf8'),
          report: result.text,
        },
        null,
        2,
      );
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `w2m report ${args?.task_id ?? ''}`,
      kind: 'read',
      rawInput: args,
    }),
  }));
}

  // -------------------------------------------------------------------------------------------
  // 7. w2m_history -- what this fleet has been asked to do
  // -------------------------------------------------------------------------------------------
export function registerHistory(ctx, deps) {
  const { cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_history',
    description:
      'List recent tasks the Rabbit still remembers, newest first: task id, mode, how many shards, ' +
      'which machines hold leases, and whether it was cancelled. Read-only, and deliberately ' +
      'narrower than w2m_status or w2m_wait: it answers "what has been run lately" without fetching ' +
      'any result envelope. The relay keeps a bounded history, so an empty list can mean "nothing ' +
      'recent" rather than "nothing ever" -- the count of what the relay holds is reported alongside.',
    parameters: {
      limit: {
        type: 'number',
        description: `How many tasks to return, newest first. Defaults to 20, and the relay caps it at ${MAX_HISTORY_LIMIT}.`,
        default: 20,
      },
      mode: {
        type: 'string',
        description: 'Only tasks whose mode matches this, for example "replicate" or "split". Omit for all modes.',
      },
      include_cancelled: {
        type: 'boolean',
        description: 'Include tasks an operator cancelled. Defaults to true, because a cancel is part of the history.',
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const token = await resolveToken(cfg);

      const requested = typeof args?.limit === 'number' && Number.isFinite(args.limit)
        ? Math.floor(args.limit)
        : 20;
      // Clamp locally as well as at the relay: asking for a million rows from a machine you cannot
      // see is how a status call turns into a memory problem on someone else's relay.
      const limit = Math.min(Math.max(requested, 1), MAX_HISTORY_LIMIT);

      const result = await request({
        rabbitUrl: base,
        token,
        signal: exec?.signal,
        pathname: `/v1/tasks?limit=${limit}`,
      });
      if (!result.ok) {
        throw new W2MError(
          'W2M_RABBIT_REFUSED',
          `W2M_RABBIT_REFUSED: the Rabbit refused GET /v1/tasks with HTTP ${result.status}` +
            `${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}; ` +
            (result.status === 401
              ? 'this machine is not paired, or its device_token is stale - pair the agent again'
              : 'check the Rabbit log for the reason it gave'),
          {
            hint: result.status === 401
              ? 'this machine is not paired, or its device_token is stale; pair the agent again'
              : 'check the Rabbit log for the reason it gave',
          },
        );
      }

      // `GET /v1/tasks` answers `{protocol_version, rabbit_time, tasks:[...]}`. Filtering happens
      // here rather than at the relay because the endpoint takes only a limit: a relay-side filter
      // would be a protocol change for a display concern.
      const all = Array.isArray(result.json?.tasks) ? result.json.tasks : [];
      const wantedMode = typeof args?.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : null;
      const includeCancelled = args?.include_cancelled !== false;
      const tasks = all.filter((t) => {
        if (!includeCancelled && t?.cancelled === true) return false;
        if (wantedMode !== null && t?.mode !== wantedMode) return false;
        return true;
      });

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          rabbit_time: result.json?.rabbit_time ?? null,
          // Both numbers, because they answer different questions: `returned` is what the caller
          // sees, `held` is what the relay has. A filter that hides everything must not look
          // identical to an empty relay.
          returned: tasks.length,
          held: all.length,
          limit,
          filters: { mode: wantedMode, include_cancelled: includeCancelled },
          tasks: tasks.map((t) => ({
            task_id: t?.task_id ?? null,
            mode: t?.mode ?? null,
            created_at: t?.created_at ?? null,
            created_by: t?.created_by ?? null,
            index_total: t?.index_total ?? null,
            cancelled: t?.cancelled === true,
            degraded: t?.degraded ?? null,
            machines: Array.isArray(t?.leases) ? t.leases : [],
            lease_states: t?.lease_states ?? {},
          })),
          notes: tasks.length === 0 && all.length > 0
            ? ['every task the relay holds was filtered out; widen the filters to see them']
            : [],
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m history', kind: 'read', rawInput: {} }),
  }));
}

export function registerCancel(ctx, deps) {
  const { cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_cancel',
    description:
      'Cancel a fleet task: every active lease on it becomes cancelled, and the task ledger records why. The relay emits ' +
      'task.cancel, so an agent holding a lease learns from its heartbeat rather than from a second request. Requires the ' +
      'operator token -- the same credential dispatch requires, because cancelling fleet work is an operator act.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by w2m_run.' },
      reason: { type: 'string', description: 'Why it is being cancelled. Stored on the task and reported in task.cancel events.' },
    },
    output: jsonOutput,
    presentCall: () => ({ card: 'generic', title: 'w2m cancel', kind: 'write', rawInput: {} }),
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : '';
      if (taskId === '') throw new W2MError('W2M_BAD_TASK_ID', '`task_id` must be a non-empty string');
      const token = requireOperatorToken(cfg);
      const cancelled = await request({
        rabbitUrl: base,
        token,
        method: 'POST',
        pathname: '/v1/tasks/' + encodeURIComponent(taskId) + '/cancel',
        body: typeof args?.reason === 'string' && args.reason.trim() !== '' ? { reason: args.reason.trim() } : {},
        signal: exec?.signal,
      });
      if (cancelled?.ok !== true) {
        throw new W2MError('W2M_CANCEL_REFUSED', 'W2M_CANCEL_REFUSED: the Rabbit refused the cancel with HTTP ' + String(cancelled?.status ?? 0), {
          hint: 'the task id must exist and the caller must hold the operator token',
          http_status: cancelled?.status ?? 0,
        });
      }
      return JSON.stringify({ ok: true, action: 'cancel', task_id: taskId, cancelled: cancelled.json?.task?.cancelled === true, cancel_reason: cancelled.json?.task?.cancel_reason ?? null });
    },
  }));
}

export function registerReduce(ctx, deps) {
  const { cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_reduce',
    description:
      'Dispatch a reduce task for a finished map task. Refuses unless every declared shard reported as a blob and the named reducer is a machine that reported: the relay never picks a reducer, and this tool never invents one.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The map task whose results are being reduced.' },
      reducer_machine_id: { type: 'string', required: true, description: 'The machine that must run the reduce; it must have reported a shard.' },
      reduce_argv: { type: 'array', items: { type: 'string' }, required: true, description: 'The reduce command as argv, run with W2M_REDUCE_MANIFEST set.' },
      timeout_ms: { type: 'number', description: 'Wall-clock budget for the reduce task (default 300000, cap 3600000).' },
      cwd_rel: { type: 'string', description: 'Working directory relative to the project (default ".").' },
    },
    output: jsonOutput,
    presentCall: (args) => ({ card: 'generic', title: 'w2m reduce ' + (typeof args?.task_id === 'string' ? args.task_id : ''), kind: 'write', rawInput: {} }),
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : '';
      const reducerMachineId = typeof args?.reducer_machine_id === 'string' ? args.reducer_machine_id.trim() : '';
      const reduceArgv = Array.isArray(args?.reduce_argv) ? args.reduce_argv.filter((part) => typeof part === 'string' && part !== '') : [];
      if (taskId === '') throw new W2MError('W2M_REDUCE_TASK', 'W2M_REDUCE_TASK: task_id is required');
      if (reducerMachineId === '') throw new W2MError('W2M_REDUCE_REDUCER', 'W2M_REDUCE_REDUCER: reducer_machine_id is required');
      if (reduceArgv.length === 0) throw new W2MError('W2M_REDUCE_ARGV', 'W2M_REDUCE_ARGV: reduce_argv must be a non-empty string array');
      const deviceToken = await resolveToken(cfg);
      const operatorToken = requireOperatorToken(cfg);
      const viewed = await request({ rabbitUrl: base, token: deviceToken, signal: exec?.signal, method: 'GET', pathname: '/v1/tasks/' + encodeURIComponent(taskId) });
      if (viewed?.ok !== true) throw new W2MError('W2M_REDUCE_READ', 'W2M_REDUCE_READ: the relay refused the task read');
      const body = viewed.json ?? {};
      const aggregate = body.aggregate ?? {};
      const machines = Array.isArray(aggregate.machines) ? aggregate.machines : (Array.isArray(aggregate.detail?.machines) ? aggregate.detail.machines : []);
      const expectedIndexTotal = Number.isInteger(body?.task?.index_total) ? body.task.index_total : null;
      const suggestion = suggestReduce({ machines, reducerMachineId, expectedIndexTotal });
      if (suggestion.ready !== true) {
        const code = suggestion?.plan?.code ?? 'NOT_READY';
        throw new W2MError('W2M_REDUCE_NOT_READY', 'W2M_REDUCE_NOT_READY: ' + code + ' -- refusing to reduce over incomplete data', {
          reason_code: code, detail: suggestion?.plan?.detail ?? null, missing: suggestion?.missing ?? [],
        });
      }
      const inputs = suggestion.plan.inputs.filter((entry) => entry.mode === 'blob').map((entry) => ({ machine_id: entry.machine_id, sha256: entry.sha256 }));
      if (inputs.length !== suggestion.plan.inputs.length) throw new W2MError('W2M_REDUCE_INLINE_INPUT', 'W2M_REDUCE_INLINE_INPUT: an inline result cannot be carried to another machine');
      const timeoutMs = Math.min(Math.max(Number.isFinite(args?.timeout_ms) ? Math.floor(args.timeout_ms) : 300_000, 1_000), 3_600_000);
      const dispatched = await request({
        rabbitUrl: base, token: operatorToken, signal: exec?.signal, method: 'POST', pathname: '/v1/task',
        body: {
          mode: 'broadcast', executor_machine_id: reducerMachineId, command_argv: reduceArgv,
          cwd_rel: typeof args?.cwd_rel === 'string' && args.cwd_rel !== '' ? args.cwd_rel : '.',
          index_total: 1, timeout_ms: timeoutMs, write: false,
          requirements: { toolchain: {}, platform: [] },
          compare_policy: { strip_ansi: true, normalize_crlf: true, strip_trailing_blank_lines: true, redact: [] },
          reduce_of: taskId, reduce_inputs: inputs,
        },
      });
      if (dispatched?.ok !== true) {
        const code = dispatched?.json?.error?.code ?? dispatched?.error?.code ?? 'W2M_REDUCE_DISPATCH';
        throw new W2MError('W2M_REDUCE_DISPATCH', 'W2M_REDUCE_DISPATCH: ' + code + ': the reduce was refused', { reason_code: code });
      }
      return JSON.stringify({ ok: true, action: 'reduce', reduce_task_id: dispatched.json?.task_id ?? null, reduce_of: taskId, reducer_machine_id: reducerMachineId, inputs: inputs.length });
    },
  }));
}

export function registerTasks(ctx, deps) {
  const { cfg, defineTool, jsonOutput } = deps;
  ctx.tools.register(defineTool({
    name: 'w2m_tasks',
    description:
      'The task board: what the Rabbit is holding, newest first, with each task status and the machines that hold ' +
      'leases. Read-only, and deliberately narrower than w2m_wait: it answers "what is queued or running right now" ' +
      'without fetching any result envelope.',
    parameters: {
      limit: {
        type: 'number',
        description: 'How many rows to return, newest first. Defaults to 20; the relay caps it at 50.',
        default: 20,
      },
      status: {
        type: 'string',
        description: 'Only tasks in this state, for example "running" or "queued". Omit for all states.',
      },
    },
    presentCall: () => ({ card: 'generic', title: 'w2m tasks', kind: 'read', rawInput: {} }),
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const token = await resolveToken(cfg);
      const requested = typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.floor(args.limit)
        : 20;
      const limit = Math.min(Math.max(requested, 1), 50);
      const listed = await request({
        rabbitUrl: base, token, signal: exec?.signal, pathname: `/v1/tasks?limit=${limit}`,
      });
      const rows = Array.isArray(listed?.json?.tasks) ? listed.json.tasks : [];
      const wanted = typeof args?.status === "string" && args.status.trim() !== "" ? args.status.trim() : null;
      const tasks = rows
        .filter((row) => wanted === null || row?.status === wanted)
        .map((row) => ({
          task_id: row?.task_id ?? null,
          mode: row?.mode ?? null,
          status: row?.status ?? null,
          cancelled: row?.cancelled === true,
          // v1.2.7: graph facts travel with each row so the board and the scheduler cannot disagree.
          depends_on: Array.isArray(row?.depends_on) ? row.depends_on : [],
          assignee: row?.assignee ?? null,
          waiting_on: Array.isArray(row?.waiting_on) ? row.waiting_on : [],
          lease_states: row?.lease_states ?? {},
          machines: Array.isArray(row?.leases)
            ? row.leases.map((lease) => lease?.machine_id ?? null).filter((id) => typeof id === "string")
            : [],
        }));
      // v1.2.4: the board classifies each visible task against the others' states, so "what can start now" is a read rather
      // than something the caller re-derives. A prerequisite outside this page is treated as waiting, never as absent.
      const board = buildBoard({ tasks: rows });
      return JSON.stringify({
        ok: listed?.ok === true,
        action: 'list',
        count: tasks.length,
        limit,
        status: wanted,
        tasks,
        ...(board.ok === true
          ? {
              board: {
                ready: board.ready,
                active: board.active,
                waiting: board.waiting,
                blocked: board.blocked,
                done: board.done,
                order: board.order,
              },
            }
          : { board_refusal: board.code }),
      });
    },
  }));
}
