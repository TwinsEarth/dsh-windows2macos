/**
 * The offer phase: offer intake, the allow-list/gate checks, the lease heartbeat
 * and the serial queue.
 *
 * `handleOffer()` keeps the exact sequence the single closure had:
 *
 *   validate -> mode gate -> spool first -> reverse dial (started, not awaited)
 *   -> lease heartbeat -> capability gate -> anchors -> allow-list/grant ->
 *   cwd containment -> execute phase -> crashed-envelope fallback
 *
 * The queue/pump invariant is also unchanged: one offer is fully finished before
 * the next is taken, so "offer acknowledged before execute" and "delivery
 * finished before the next lease heartbeat" are properties of this ordering.
 *
 * No module-level mutable state: the queue, the claim set, the abort controller
 * and the lease heartbeat all live inside the factory.
 */

import { dirname, join } from 'node:path';

import { matchAllowedCommand } from '../allowed-commands.mjs';
import {
  EXEC_CAPABILITY_WARNING,
  effectiveExecCapabilityPrefixes,
  readExecCapability,
} from '../../util/exec-capability.mjs';
import { authorizeWithGrant } from '../grant-gate.mjs';
import { maintenancePaths } from '../maintenance-ferry.mjs';
import { normalizeRelPath, resolveProjectCwd } from '../git.mjs';
import { removeWorktree } from '../worktree.mjs';
import {
  Heartbeat,
  REFUSAL,
  evaluateGate,
  heartbeatDiagnostics,
  identityKeyFor,
} from './shared.mjs';

/**
 * Upper bound on the stages a single offer may carry (v0.3.3 `pipeline`).
 *
 * Mirrors the relay's `MAX_PIPELINE_STAGES`. Kept as a separate literal rather than imported so the
 * agent's validation does not depend on the relay module: the agent must refuse an oversized chain
 * on its own authority, and a shared import would make "the relay said so" the only reason it does.
 */
const MAX_STAGES = 16;

/**
 * @param {object} deps The composition bag assembled by `createAgent()`.
 */
export function createOfferPhase(deps) {
  const {
    log,
    identity,
    platform,
    caps,
    state,
    spool,
    project,
    allowedCommands,
    execCapabilityFile,
    p2pMode,
    heartbeatIntervalMs,
    once,
    isWritableProject,
    toolchainInfo,
  } = deps;
  const { postJson } = deps.http;
  const { safeAnchors, runTask } = deps.execute;
  const {
    finish,
    deliver,
    makeEnvelope,
    startReverseDial,
    channelFor,
    sendResultDirect,
    releaseChannel,
    cachedResult,
  } = deps.deliver;

  // The heartbeat phase is composed after this one (it needs `enqueue` and
  // `cancelTask` to dispatch frames); these two thin forwards keep the moved
  // bodies verbatim while resolving the target at call time.
  const stop = () => deps.heartbeat.stop();
  const recordRtt = (ms) => deps.heartbeat.recordRtt(ms);

  /** @type {object[]} */
  const queue = [];
  /**
   * Offers whose attempt is already queued or running, keyed by {@link identityKeyFor}.
   *
   * This is v0.4.0's exactly-once guard, and it is deliberately *synchronous*: `enqueue` checks it
   * and writes to it without an `await` anywhere between, so two copies of one offer -- one over
   * the relay, one over a channel, in either order -- cannot both reach the queue. `completed` and
   * the spool cannot do this job on their own: neither knows anything until an envelope exists,
   * which is exactly the window a duplicate arrives in.
   *
   * Released in `pump`'s `finally`, once the attempt has delivered (or failed to). It is not
   * released in `handleOffer` so an offer that throws is still retryable.
   *
   * @type {Set<string>}
   */
  const claimed = new Set();

  let pumping = false;
  let runAbort = null;
  /** @type {Heartbeat|null} */
  let heartbeat = null;

  // -- Task handling -------------------------------------------------------

  /** @param {object} offer */
  function validateOffer(offer) {    if (!offer || typeof offer !== 'object') return 'NOT_AN_OBJECT';
    if (typeof offer.task_id !== 'string' || offer.task_id === '') return 'MISSING_TASK_ID';
    if (!Array.isArray(offer.command_argv) || offer.command_argv.length === 0) return 'MISSING_COMMAND_ARGV';
    if (!offer.command_argv.every((part) => typeof part === 'string')) return 'COMMAND_ARGV_NOT_STRINGS';
    if (offer.index !== undefined && !Number.isInteger(offer.index)) return 'INDEX_NOT_INTEGER';
    // v0.3.3: a pipeline carries its chain in `stages`. Validated here rather than trusted, because
    // a malformed chain would otherwise run partially and report a result for work it never did.
    if (offer.stages !== undefined) {
      if (offer.mode !== 'pipeline') return 'STAGES_WITHOUT_PIPELINE_MODE';
      if (!Array.isArray(offer.stages) || offer.stages.length === 0) return 'STAGES_NOT_NON_EMPTY_ARRAY';
      if (offer.stages.length > MAX_STAGES) return 'TOO_MANY_STAGES';
      for (const stage of offer.stages) {
        if (!Array.isArray(stage?.command_argv) || stage.command_argv.length === 0) return 'STAGE_COMMAND_ARGV_MISSING';
        if (!stage.command_argv.every((part) => typeof part === 'string')) return 'STAGE_COMMAND_ARGV_NOT_STRINGS';
      }
    }
    return null;
  }

  /**
   * Does this agent's mode allow the offer to run at all (v0.4.0 §1)?
   *
   * `direct` is the one mode where the *transport* is a gate rather than a preference, and it is
   * deliberately total: any offer that did not arrive over a channel is refused, including one
   * that arrived over the relay while a punch for the same task was still being attempted. The
   * alternative -- accepting the relay's copy when a channel happens to exist -- would make the
   * mode's meaning depend on a race, which is exactly the ambiguity `direct` exists to remove
   * ("a failed punch is not hidden").
   *
   * @param {object} offer
   * @returns {{reason: string, detail: string}|null}
   */
  function p2pRefusal(offer) {
    if (p2pMode !== 'direct') return null;
    if (offer.p2p_transport === 'p2p') return null;
    return {
      reason: REFUSAL.P2P_UNAVAILABLE,
      detail: 'p2pMode is "direct" and this offer arrived over the relay',
    };
  }

  /**
   * The full lifecycle of one offer.
   *
   * @param {object} offer
   */
  async function handleOffer(offer) {
    const problem = validateOffer(offer);
    if (problem) {
      log('error', `ignoring malformed offer: ${problem}`, { offer });
      state.handled += 1;
      return;
    }

    const commandArgv = [...offer.command_argv];
    const cwdOutcome = resolveProjectCwd(project, offer.cwd_rel ?? '.');
    const cwdRel = cwdOutcome.ok ? cwdOutcome.cwd_rel : normalizeRelPath(offer.cwd_rel ?? '.');
    const controller = new AbortController();
    runAbort = controller;
    state.current = {
      task_id: offer.task_id,
      attempt: Number(offer.attempt) || 1,
      controller,
      key: identityKeyFor(offer),
    };

    // ---- 0. mode gate (v0.4.0 §1) ----------------------------------------
    // Checked before the spool: a refusal is not a run. Spooling it would leave a `claimed` entry
    // whose envelope is written by `deliver`, which would in turn claim a task that never executed
    // -- so the refusal is answered and the attempt is done.
    const refusal = p2pRefusal(offer);
    if (refusal) {
      log('warn', `refused ${offer.task_id}: ${refusal.reason}`, { detail: refusal.detail });
      runAbort = null;
      state.current = null;
      state.handled += 1;
      await finish({
        offer,
        cwdRel,
        commandArgv,
        anchorsBefore: null,
        anchorsAfter: null,
        execution: null,
        status: 'refused',
        refusalReason: refusal.reason,
        warnings: [`P2P_UNAVAILABLE: ${refusal.detail}`],
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });
      return;
    }

    // ---- 1. spool before anything else (§0) ------------------------------
    // Fail closed: if the durable copy cannot be written, running the command
    // would produce a result we could never replay, so the offer is dropped
    // with an explicit reason instead of executing unspooled. This also keeps
    // `state.current` from being left pointing at a task that never started.
    try {
      spool.saveTask({
        task_id: offer.task_id,
        attempt: offer.attempt,
        dedupe_key: offer.dedupe_key,
        offer,
      });
    } catch (error) {
      log('error', `could not spool ${offer.task_id}; not running it (spool-first, §0)`, {
        error: error?.message ?? String(error),
      });
      runAbort = null;
      state.current = null;
      state.handled += 1;
      return;
    }
    log('info', `offer ${offer.task_id} attempt ${offer.attempt ?? 1}`, {
      argv: commandArgv,
      cwd_rel: cwdRel,
      write: offer.write === true,
    });

    // ---- 1b. the two-way punch (v0.4.x) ----------------------------------
    // Started here, and *started* rather than awaited: the dispatcher may be behind a symmetric NAT
    // that swallowed its push, and a packet from this machine is the only thing that can open the
    // other half of that path. Everything the relay does today happens exactly as it did -- the
    // lease heartbeat, the gates, the command, the relay copy of the result -- while this runs
    // beside it for a bounded window. Nothing below waits for it; the result path is the one place
    // that reads its outcome, and even there only to decide `result_path`.
    startReverseDial(offer);

    // ---- 2. lease heartbeat ---------------------------------------------
    heartbeat = new Heartbeat({
      send: (body) => postJson('/v1/heartbeat', body).then((response) => response.json),
      taskId: offer.task_id,
      machineId: identity.machine_id,
      attempt: Number(offer.attempt) || 1,
      intervalMs: heartbeatIntervalMs,
      onError: (error) => log('warn', 'heartbeat failed', { error: error.message }),
      onRtt: recordRtt,
      // v0.3.0: the same numbers the local file carries, sent to the relay so a
      // plugin on another machine can see them.
      diagnostics: () =>
        heartbeatDiagnostics({
          rttMs: state.rttMs,
          reconnectAttempts: state.reconnectAttempts,
        }),
      onCancel: () => {
        log('warn', `Rabbit cancelled ${offer.task_id} via heartbeat`);
        controller.abort();
      },
    }).start();

    const startedAt = new Date().toISOString();
    const startedHr = process.hrtime.bigint();
    /** @type {string[]} */
    const warnings = [];

    // Hoisted so the catch below can clean up a worktree even when the failure happened after creation.
    const executionState = { workspaceState: null };

    try {
      // ---- 3. capability gate (§6.1) -------------------------------------
      const writable = offer.write === true ? await isWritableProject(project) : true;
      const gate = evaluateGate(offer, { caps, platform, writable, toolchain: await toolchainInfo() });

      // ---- 4. anchors ------------------------------------------------------
      const anchorsBefore = await safeAnchors(warnings);

      if (!gate.ok) {
        log('warn', `refused ${offer.task_id}: ${gate.refusal_reason}`, { detail: gate.detail });
        await finish({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore,
          anchorsAfter: null,
          execution: null,
          status: 'refused',
          refusalReason: gate.refusal_reason,
          warnings,
          startedAt,
          endedAt: new Date().toISOString(),
        });
        return;
      }

      // ---- 5. allow-list (default-deny) -----------------------------------
      //
      // `commandArgv` is the offer's own command line, which for a `pipeline` the relay sets to
      // `stages[0].command_argv` -- so this check covers the first stage and nothing else. Every
      // stage is checked below, before any of them runs; see the note there for why the second check
      // has to exist even though the plugin's pre-flight also checks every stage.
      /**
       * v1.3.10-beta.3: the allow-list is a standing decision; a grant is a decision made now for exactly this argv.
       * Ask the grant gate before falling through to the allow-list refusal, and never the other way round.
       */
      let allowed = matchAllowedCommand(commandArgv, allowedCommands);
      let grantAuthorized = false;
      let capabilityAuthorized = false;
      let grantAttempted = false;
      const capabilityStatus = readExecCapability(execCapabilityFile);
      if (allowed.allowed !== true && offer && typeof offer.grant === 'object' && offer.grant !== null) {
        grantAttempted = true;
        const gatePaths = maintenancePaths();
        const gate = await authorizeWithGrant({
          offer,
          machineId: String(offer.machine_id ?? identity.machine_id ?? ''),
          pinFile: gatePaths.pinFile,
          usedFile: join(dirname(gatePaths.pinFile), 'grant-uses.json'),
        });
        if (gate.ok === true) { allowed = { allowed: true, ok: true, grant_id: gate.grantId }; grantAuthorized = true; }
        else allowed = { ok: false, reason_code: gate.code ?? 'GRANT_REJECTED', detail: gate.message };
      }
      // A capability is a machine-local standing authorization, so it may rescue an allow-list miss -- but never an
      // explicit grant refusal (replay, expiry, wrong machine). Masking GRANT_REPLAY with a capability would execute a
      // token the operator already spent, and the envelope would report a reason that names neither decision.
      if (allowed.allowed !== true && grantAttempted !== true && capabilityStatus.effective === true) {
        allowed = matchAllowedCommand(commandArgv, effectiveExecCapabilityPrefixes(execCapabilityFile));
        if (allowed.allowed === true) { capabilityAuthorized = true; warnings.push('EXEC_CAPABILITY: ' + EXEC_CAPABILITY_WARNING); }
      }
      // One decision, two audiences: the gate decides whether to run, and the envelope records which decision it was.
      const authorization = grantAuthorized
        ? { provenance: 'grant', capability_id: allowed.grant_id ?? null, grant_id: allowed.grant_id ?? null }
        : capabilityAuthorized
          ? { provenance: 'exec-capability', capability_id: 'node-code-exec', grant_id: null }
          : { provenance: 'allow-list' };
      if (!allowed.allowed) {
        log('warn', `refused ${offer.task_id}: ${allowed.reason_code ?? REFUSAL.COMMAND_NOT_ALLOWED}`, { argv: commandArgv });
        await finish({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore,
          anchorsAfter: null,
          execution: null,
          status: 'refused',
          // The matcher's own code, not a second spelling of it: the plugin's dispatch pre-flight
          // reports the same literal for the same argv, and `COMMAND_REPARSING_ARGUMENT` and the two
          // executable-identity codes have to travel the same way or the two ends would disagree
          // about *why* one command was refused.
          refusalReason: allowed.reason_code ?? REFUSAL.COMMAND_NOT_ALLOWED,
          warnings,
          startedAt,
          endedAt: new Date().toISOString(),
        });
        return;
      }

      if (!cwdOutcome.ok) {
        log('warn', `refused ${offer.task_id}: ${cwdOutcome.reason}`, { cwd_rel: offer.cwd_rel });
        await finish({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore,
          anchorsAfter: null,
          execution: null,
          status: 'refused',
          refusalReason: cwdOutcome.reason,
          warnings,
          startedAt,
          endedAt: new Date().toISOString(),
        });
        return;
      }

      // ---- 6. execute ------------------------------------------------------
      //
      // The argv loop, the workspace evidence and the result envelope belong to
      // the execute phase. It is handed the state this function owns (the lease
      // heartbeat, the abort controller and the workspace handle) rather than
      // re-deriving any of it, so the catch below still cleans up a worktree the
      // executor created before it threw -- exactly as the single closure did.
      await runTask({
        offer,
        cwdRel,
        commandArgv,
        controller,
        anchorsBefore,
        warnings,
        startedAt,
        heartbeat,
        authorization,
        grantAuthorized,
        capabilityAuthorized,
        executionState,
      });

    } catch (error) {
      // Never leave a claimed task unspooled: emit a crashed envelope so the
      // relay can account for it instead of waiting for a lease to expire.
      log('error', `error while handling ${offer.task_id}`, { error: error?.message ?? String(error) });
      if (executionState.workspaceState !== null) { try { await removeWorktree({ repoDir: project, worktreeDir: executionState.workspaceState.worktreeDir }); } catch { /* best effort */ } }
      try {
        const envelope = makeEnvelope({
          offer,
          cwdRel,
          commandArgv,
          anchorsBefore: null,
          anchorsAfter: null,
          execution: null,
          status: 'crashed',
          refusalReason: null,
          // The error text travels with the envelope. Without it, a crashed pipeline is visible only as
          // `status: crashed` on the wire and the cause has to be reproduced to be seen -- which is
          // exactly the situation this field was added to end.
          warnings: [...warnings, 'AGENT_ERROR', `AGENT_ERROR_DETAIL: ${error?.message ?? String(error)}`],
          startedAt,
          endedAt: new Date().toISOString(),
        });
        await deliver(envelope);
      } catch (nested) {
        log('error', 'could not even build a crashed envelope', {
          error: nested?.message ?? String(nested),
        });
      }
    } finally {
      heartbeat?.stop();
      heartbeat = null;
      runAbort = null;
      state.current = null;
      state.handled += 1;
      log('success', `task ${offer.task_id} complete`, {
        duration_ms: Math.round(Number(process.hrtime.bigint() - startedHr) / 1e6),
      });
    }
  }

  /** Drop a queued task and abort a running one (§3.4). Shared by both transports. */
  function cancelTask(taskId, reason) {
    const index = queue.findIndex((item) => item.task_id === taskId);
    if (index !== -1) {
      queue.splice(index, 1);
      // A task cancelled before it ran never reaches `finish`, which is where a task's direct-path
      // bookkeeping is normally released: the channel its offer arrived on (or the one its own dial
      // opened) and the dial record. Nothing will ever be answered on that channel now, so it is let
      // go here rather than left holding a mapping until the node closes.
      releaseChannel(taskId);
      log('info', `task.cancel for queued ${taskId}: dropped before it ran`);
      return;
    }
    if (state.current && state.current.task_id === taskId) {
      log('warn', `task.cancel for running ${taskId}: ${reason ?? ''}`);
      state.current.controller.abort();
    } else {
      log('info', `task.cancel for idle ${taskId}`);
    }
  }

  /**
   * Queue an offer, unless we already have it -- over either transport.
   *
   * Dedupe by the lease's identity (§4.4 plus v0.4.0's two-transport rule): a re-delivery of a task
   * we already finished is answered from the cache or the spool instead of being executed a second
   * time, which matters for `write: true` offers.
   *
   * The three checks are in the order that keeps the promise above true:
   *
   *   1. **already claimed** -- queued, running, or already executed. Answered without touching the
   *      queue. This is the branch the direct-path duplicate hits while the first copy is still
   *      running: the second copy is recorded (its channel, if it came over one) and dropped.
   *   2. **cached envelope** -- the attempt finished and the relay accepted it. The envelope is
   *      re-delivered, which is v0.3.9's behaviour and is safe because the relay dedupes it.
   *   3. **spooled envelope** -- the attempt finished but the relay has not confirmed it yet.
   *
   * A copy that arrives *while* the first is running therefore never re-executes and never produces
   * a second result. `pump` is single-entry and `claimed` is written synchronously, so there is no
   * interleaving between the check and the write.
   *
   * @param {object} offer
   */
  function enqueue(offer) {
    const attempt = Number(offer?.attempt) || 1;
    const key = identityKeyFor(offer);

    if (key !== null && claimed.has(key)) {
      // The claim covers exactly the window in which a second copy must not start a second run:
      // from here until `handleOffer` has delivered its envelope. The channel (if this copy came
      // over one) was already remembered by `dispatchFrame`, so the result will reach it.
      log('info', `ignoring duplicate offer ${offer.task_id} attempt ${attempt} (already claimed, arrived over ${offer.p2p_transport ?? 'relay'})`);
      return;
    }

    if (key !== null) {
      const cached = cachedResult(key);
      if (cached) {
        log('info', `dedupe hit: resending cached result for ${offer.task_id} attempt ${attempt}`);
        void deliver(cached);
        // If this copy arrived over a channel, the dispatcher is waiting for an answer on it. The
        // relay copy above is the durable one; this notice is what stops the dispatcher's bounded
        // wait from expiring on a task that is already finished. Fire-and-forget: the answer is a
        // courtesy, and failing to give it must never affect the spooled envelope.
        if (offer.p2p_transport === 'p2p' && channelFor(offer.task_id) !== null) {
          void sendResultDirect(offer.task_id).catch(() => {});
        }
        return;
      }
      const spooled = spool.pendingResults().find((record) => {
        if (!record.envelope) return false;
        return identityKeyFor({
          task_id: record.task_id,
          dedupe_key: record.dedupe_key ?? record.envelope.dedupe_key,
          attempt: record.attempt,
        }) === key;
      });
      if (spooled) {
        log('info', `dedupe hit: resending spooled result for ${offer.task_id} attempt ${attempt}`);
        void deliver(spooled.envelope);
        return;
      }
      claimed.add(key);
    }
    queue.push({ offer, key });
    void pump();
  }

  /** Serial worker: one task at a time, in arrival order. */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0 && !state.stopped) {
        const item = queue.shift();
        const offer = item.offer;
        try {
          await handleOffer(offer);
        } catch (error) {
          // A throw here must not kill the stream loop or wedge the queue.
          log('error', `unhandled failure in ${offer?.task_id ?? 'offer'}`, {
            error: error?.message ?? String(error),
          });
        } finally {
          // Released here, not in `handleOffer`: an offer that threw before delivering must still
          // become runnable again, or a bug would turn into a task that can never be retried.
          if (item.key !== null) claimed.delete(item.key);
        }
        if (once) {
          stop();
          break;
        }
      }
    } finally {
    // The pump is single-entry: `pumping` is set before the first await and cleared here, so a second
    // pump cannot be running to observe a stale value.
    // eslint-disable-next-line require-atomic-updates -- single-entry pump
    pumping = false;
    }
  }

  return {
    handleOffer,
    enqueue,
    cancelTask,
    abortRun: () => runAbort?.abort(),
    stopLeaseHeartbeat: () => heartbeat?.stop(),
  };
}
