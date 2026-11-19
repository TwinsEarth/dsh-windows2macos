/**
 * DSH: Windows2MacO - the DSH Cordis plugin.
 *
 * # What this exposes
 *
 * Five tools over the W2M line protocol (see `_work/w2m/PROTOCOL.md`, frozen v1):
 *
 *   w2m_devices  read-only   which machines the Rabbit currently holds leases for
 *   w2m_run      control     broadcast one argv command to the online machines
 *   w2m_wait     read-only   wait for terminal results and hand back the aggregate verdict
 *   w2m_report   read-only   the rendered report, markdown or json
 *   w2m_status   read-only   this machine's identity, Rabbit reachability, project base_commit
 *
 * The plugin is a **client of the Rabbit**. It does not execute commands, does not fork
 * processes, and does not decide whether two machines agree - the Rabbit does that and this
 * code only reports what it was told, plus the fields it did not recognise.
 *
 * # Fail-closed choices
 *
 * * A missing configured value is a **typed error naming the setting** (`W2M_CONFIG`), never an
 *   empty success. A missing capability is a typed error naming the capability.
 * * Results are reported with their refusals intact: a non-zero exit, a `refused` machine, a
 *   `divergent` aggregate, and an `unverifiable` aggregate are all *values*, not exceptions. The
 *   only things that throw are "the tool could not run" and "the tool ran and said no".
 * * Arguments travel as an **argv array**, never a shell string (PROTOCOL §0).
 * * Every call is bounded by a wall-clock timeout and an output byte cap, so a wedged Rabbit
 *   cannot hang the session and a chatty one cannot flood it.
 * * Every call honours `exec.signal`; the signal is merged with our own timeout so a cancel
 *   produces a typed abort, not a mystery failure.
 * * This file never reads `.credentials.yaml`, and never hard-codes an endpoint: every URL comes
 *   from `config.rabbitUrl` or from `device.json`'s `rabbit_url`.
 *
 * # The exposure boundary: what an agent-facing tool may not do
 *
 * Everything in this file is callable by a model, against a fleet whose machines run commands under
 * their own allow-lists, and it holds an operator token that authorises dispatch fleet-wide. That
 * makes the *tool surface* a boundary, and this section is the boundary written down as it actually
 * is  - not as it would sound best. `test/tool-cards.test.mjs` asserts the parts of it that can be
 * asserted mechanically, and a change that crosses it is meant to turn that suite red.
 *
 * **No tool parameter names a credential, an allow-list, a key path, or a state directory.** There is
 * no parameter through which a caller can set a token, a secret, `allowedCommands`, `p2pMode`, a
 * `device.key` path, or another machine's identity file. `w2m_run`'s only machine-naming parameter is
 * `executor_machine_id`, and it *narrows* one `broadcast` to a machine the relay already lists; it
 * cannot name a machine the relay does not hold, and it cannot hand that machine anything new.
 *
 * **No tool can widen what a machine will run.** `allowedCommands` is read in `readConfig` from the
 * host config and the shared `.w2m.json` / `machine.json` layers, is never written by anything here,
 * and is applied in one direction only: {@link checkAllowedCommand} returns a refusal or `null`, and
 * there is no path in this file that adds an entry to the list. Each target machine's own agent
 * re-decides the same gate against its own list, so a dispatcher that lost this check would still not
 * widen anything  - the direction the shared matcher exists to keep honest (`src/agent/allowed-commands.mjs`).
 *
 * **No tool can change a machine's `p2pMode`.** The mode is resolved once, in `readConfig` at
 * `apply()` time, from the config object or `W2M_P2P_MODE`, and every dispatch publishes it as a fact
 * (`p2p: {mode}`) rather than accepting one. The *executor's* mode is its own local setting: an agent
 * configured `direct` refuses a relay-delivered offer with `P2P_UNAVAILABLE` rather than accepting the
 * weaker path, which is the one place a dispatcher could otherwise have quietly downgraded a peer.
 *
 * **No tool writes another machine's identity or keys.** `device.json` is read (`readDevice`) and
 * `device.key` is loaded (`DeviceKey.load`)  - neither is ever written here. What a dispatch publishes
 * is this machine's own **public** key inside `p2p.static_keys`, so the executor can authenticate a
 * dial; the private half never leaves `src/agent/crypto.mjs`.
 *
 * **No tool result carries a token or a key.** `w2m_status` reports `paired`,
 * `operatorToken_configured` and `pairingCode_configured` as booleans and never the values. The
 * operator token travels only in the `Authorization` header of `POST /v1/task`  - never in the request
 * body and never in an answer  - and `direct_pushes[].static_key` is the literal marker `'published'`,
 * not the key it describes.
 *
 * What an agent-facing tool *may* do across machines is bounded and stated: ask the machines the relay
 * leased a task to run one argv inside their own allow-lists, in their own copy of the project,
 * read-only unless `write: true` names a `write_scope`, and report what they said  - refusals
 * included, as values.
 *
 * # `@deepseek-ai/dsh-tools` and the offline fallback
 *
 * `defineTool` is imported lazily, at `apply()` time, through {@link loadDefineTool}. When the
 * package is importabl - the real path, inside DS - its `defineTool` is used unchanged. When it
 * is no - this repository has no `node_modules`, so `node --test` cannot resolve i - a minimal
 * **shim** stands in so the unit tests can still drive `apply()` and the registered definitions.
 *
 * The shim validates only the shape this file says it must (name present, `parameters` an object,
 * `execute` a function, no undeclared parameter keys). It does **not** implement argument
 * coercion, `required` enforcement, timeout enforcement, cancellation, permission gating, or
 * output rendering. **The shim is not a production path**; production semantics come from DSH's
 * own `dsh-tools`. Anything the shim accepts may still be rejected or reshaped by the real
 * implementation, and vice versa.
 */

import { fleetConfigPathFor } from './fleet-config.mjs';
import { join } from 'node:path';
import os from 'node:os';
import path from 'node:path';
// v0.24.0: the queue an escalation is raised into. Imported from `src/`, never from `scripts/` -- a
// `src/` module reaching above itself breaks the published package (see CHANGELOG 0.23.0).
import { createApprovalIndex } from '../agent/approval-index.mjs';
// v0.31.0: the approval queue's front door. Written in 0.30.0 and given a caller here.
import { createApprovalGate } from '../agent/approval-gate.mjs';
import { createCouncilSessions } from '../agent/council-session.mjs';
import { loadIdentity } from '../agent/identity.mjs';
import { resolveStateDir } from '../util/cli.mjs';
import { createAutoUpdater, resolveCurrentVersion } from './auto-update.mjs';
import { createLocalIdentity, defaultSelectionStore, registerTargetRoutes } from './fleet-target.mjs';
import { MIN_SUPPORTED_PLUGIN_VERSION } from './version-gate.mjs';
// v1.1.17 chat: the host route behind the composer's fleet-chat panel. The relay side and the
// `w2m_chat` tool shipped first; this is the browser-facing half that was still missing.
import { registerChatRoutes } from './fleet-chat-route.mjs';
import { registerExecCapabilityRoutes } from './exec-capability-route.mjs';
import { registerPluginUpdateRoutes } from './update-route.mjs';
import { registerOperatorTokenRoute } from './operator-token-route.mjs';
import { registerFleetConfigRoute } from './fleet-config-route.mjs';
import { registerDataplaneSinkRoute } from './dataplane-sink-route.mjs';
import { registerProjectStreamRoute } from './project-stream-route.mjs';
// v3.4.6: the read-only backup substrate's two GET routes (`status`, `scan`). Nothing behind them writes.
import { registerBackupRoutes } from '../backup/routes.mjs';
import { planProgress } from './joint-dev/progress.mjs';
import { registerJointTools } from './tools-joint.mjs';
import { registerCaptureRoutes } from './capture-route.mjs';
import { registerDesktop } from './desktop.mjs';
import { defaultExecCapabilityFile } from '../util/exec-capability.mjs';
import { createFleetCouncil } from './council-fleet.mjs';
import { createAskStore } from './ask-store.mjs';
// v0.7.0: the LAN hint layer. Imported here and used in exactly one place (`w2m_devices`); see the
// module header for why a discovered device is a candidate to *ask* and never an authorisation.
import { createDiscoverySource } from './mdns-discover.mjs';

import { registerCancel, registerHistory, registerReduce, registerReport, registerRun, registerTasks, registerWait } from './tools/dispatch.mjs';
import { registerDevices, registerStats, registerStatus, registerUpdate } from './tools/fleet.mjs';
import { registerApprovals, registerCouncil } from './tools/governance.mjs';
import { registerChat, registerIntent, registerMemory } from './tools/memory.mjs';
import { createP2PRuntime, loadDefineTool, readConfig, readLocalIdentity, request, resolvedFleetKey, resolveProfileDir, resolveToken, startFailoverStack, startOpsTelemetryIfConfigured, W2MError } from './tools/shared.mjs';

export { summarizeFleetVersions } from './tools/fleet.mjs';
export { REFUSAL_CODE, configuredStateDir, resetDefineToolCacheForTests, setCreateAgentForTests } from './tools/shared.mjs';

/** Services this plugin needs. The harness refuses to load the plugin without them. */
export const inject = ['tools'];

/**
 * This plugin's own version, baked in at pack time.
 *
 * The updater compares the newest release against this string, so a wrong value here means either a
 * downgrade (worse than a missed update) or a permanent no-op. It is therefore read from
 * `package.json` during `scripts/pack.mjs` rather than hand-maintained, and `W2M_PLUGIN_VERSION`
 * overrides it at runtime for tests and packagers.
 */
const PLUGIN_VERSION = '__W2M_PLUGIN_VERSION__';

/**
 * v3.5.0: the fleet minimum, re-exported from the module that owns the comparator.
 *
 * One definition, two access points: `version-gate.mjs` is where the rule lives (and where a pure
 * test can import it from), and this file is "the module that owns dispatch" -- a caller reading the
 * dispatch surface should not have to know which helper file the constant moved to. Re-exported
 * rather than redefined on purpose: two copies of a minimum version is two answers to "is this
 * machine too old", which is the defect this milestone is about.
 */
export { MIN_SUPPORTED_PLUGIN_VERSION };

export async function apply(ctx, config = {}) {
  try {
    startOpsTelemetryIfConfigured(ctx, config);
  } catch {
    /* telemetry must never break the plugin */
  }
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    throw new W2MError('W2M_NO_TOOLS', 'this plugin needs the `tools` service, and ctx.tools.register is missing', {
      hint: 'load the plugin in a profile that injects the `tools` service',
    });
  }

  const cfg = readConfig(config);
  const { defineTool, usedFallback, reason } = await loadDefineTool();
  if (usedFallback) {
    ctx.logger?.warn?.(
      `w2m: @deepseek-ai/dsh-tools did not resolve (${reason}); using the offline shim. ` +
        'Argument validation, timeouts, cancellation, and rendering will come from DSH in production.',
    );
  }

  // §7: the direct path, owned by this plugin for the plugin's whole lifetime.
  //
  // Composed here, next to the updater's own `ctx.effect`, and for the same reason: a socket and a
  // refresh timer have to be released when the plugin is unloaded, and an effect disposer is the
  // only mechanism Cordis gives for that. Creating it never throws  - a machine that cannot punch
  // still has to dispatch, and `w2m_status` is where the failure is reported.
  const p2p = createP2PRuntime(ctx, cfg, config.p2pBlock);

  /**
   * This machine's fleet identity, read once per successful resolution.
   *
   * The memoization rule lives in {@link createLocalIdentity} so the route half and the tool half
   * cannot disagree about when a missing identity becomes a stale one.
   */
  const localIdentity = createLocalIdentity(async () => {
    // readLocalIdentity knows the <DSH_HOME>/xclient/device.json fallback; readDevice() returns empty when
    // `stateDir` is unset, which is the documented default layout -- and that made every consumer of this helper
    // answer "no identity" on a paired machine (the fleet-chat panel said so verbatim).
    const identity = await readLocalIdentity(cfg);
    return { machine_id: identity.machine_id, machine_name: identity.machine_name, machineName: cfg.machineName };
  });

  /**
   * v0.24.0: the approval queue, one per plugin lifetime.
   *
   * ## Why it lives here and not inside the dispatch
   *
   * A queue constructed at the call site would be **empty every time**, so a request raised by one dispatch
   * could never be found by the decision that answers it — the queue would look wired and behave as if it were
   * not. This is the same reasoning as `p2p` above: something that has to outlive a single call belongs to the
   * plugin, not to the call.
   *
   * Lazy, because a machine that never trips the permission gate should not pay for a queue, and built through
   * the effect system so a decision still pending at unload does not keep the plugin alive.
   */
  let approvals = null;
  const approvalQueue = () => {
    if (approvals === null) {
      approvals = createApprovalIndex({
        audit: (event, detail) => ctx.logger?.debug?.(`w2m: ${event} ${JSON.stringify(detail ?? {})}`),
      });
    }
    return approvals;
  };

  /**
   * v0.31.0: the rate limiter that is the approval queue's front door.
   *
   * ## Why this took a round to arrive
   *
   * `approval-gate.mjs` was written in 0.30.0 with a full suite and **no caller** — which is precisely the
   * defect that same release had just finished documenting in `ROADMAP.md` twice. Building the mechanism and
   * wiring it are separate acts, and a mechanism with no caller is the thing a reader cannot tell from a
   * finished feature.
   *
   * It guards **raising only**. Reading the queue and settling a request are deliberately unmetered: limiting
   * the view would limit knowing what is waiting, and limiting the answer would punish the supervisor
   * clearing the backlog. The threat is queue flooding by a runaway retry loop, and that is a threat against
   * the raise path.
   */
  const approvalGate = createApprovalGate(
    // Configurable so a host can tighten or loosen it, and so a test can reach the refusal without raising
    // thirty requests first. Omitted entirely when unset, which leaves the gate's own default in charge --
    // passing `undefined` through would be the same thing with more ways to be wrong.
    Number.isInteger(config.approvalRaiseLimitPerMinute) ? { limit: config.approvalRaiseLimitPerMinute } : {},
  );

  /**
   * v0.37.0: the council, reached at last.
   *
   * `src/agent/council.mjs` shipped in 0.11.0 as v4.10.0's committee governance — 275 lines with three
   * falsifying tests asserted by name — and **nothing imported it.** `scripts/reachability-classify.mjs`
   * reported it as a closed loop in 0.36.0, and that is what this fixes.
   *
   * `createCouncilSessions` holds the state, because a council runs through **seven phases across many
   * calls**: one that lived inside a single invocation could never finish. That is the same lesson the
   * approval queue and the P2P runtime taught, applied a third time.
   */
  const councilSessions = createCouncilSessions();

  /** v1.2.2: the machine-wide council. Ballots arrive as chat messages, so this is state + arithmetic; the transport is
   * the fleet chat itself (thread `council-<id>`), which already carries `to` / `thread_id` / `reply_to` since 1.2.1. */
  const fleetCouncil = createFleetCouncil({});
  /** v1.2.4: open questions survive a restart, because an answer that arrives after one is still an answer. */
  const askStore = createAskStore({ stateDir: cfg.stateDir ?? null });

  // v0.6.1: the two browser routes behind the composer's target control. Additive and optional: a
  // host without `connection.fetch` still gets every tool, and `w2m_status` reports the absence  -   // which is the honest place for it, since a host that has no Connection at all is simply not a web
  // composition and does not need a warning on every headless run.
  //
  // Nothing here reads the service: `registerTargetRoutes` declares the optional dependency with
  // `ctx.inject` and attaches from that callback (the comment there records why a plain
  // `ctx.connection` read fails the whole entry, and why the read cannot be synchronous anyway). The
  // one mismatch worth a log line  - a Connection that carries no fetch registry  - is logged where it
  // is observed, inside that callback, so this call returns a status object that stays live.
  const targetRoutes = registerTargetRoutes(ctx, {
    cfg: () => cfg,
    store: defaultSelectionStore,
    localIdentity,
    request,
    resolveToken,
  });

  // The composer's fleet-chat panel: `GET/POST /api/w2m/chat`, proxied to the relay's device-gated
  // `/v1/fleet/messages`. Optional like the target routes — a host without Connection keeps every
  // tool and the panel is simply not mounted.
  // v1.4.2: the UI-activated Node-code-execution capability (`GET/POST /api/w2m/capability`). The composer
  // control reads and writes it, the agent reads the same file before every task, so an activation takes effect
  // on the next task without a restart. Optional like the other browser routes.
  const capabilityRoutes = registerExecCapabilityRoutes(ctx, {
    capabilityFile: () => defaultExecCapabilityFile(),
  });
  // v1.6.8: the plugin panel's "更新" button: GET checks npm latest, POST installs through the
  // verified updater (SHA-256 checked, old package backed up, restart required afterwards).
  const _updateRoutes = registerPluginUpdateRoutes(ctx, { profileDir: () => cfg.profileDir });
    const _operatorTokenRoute = registerOperatorTokenRoute(ctx, { configuredToken: () => cfg.operatorToken });
  // v2.2.1: the settings page writes an independent fleet pin. It never edits cordis.patch.yml.
  const _fleetConfigRoute = registerFleetConfigRoute(ctx, { file: () => fleetConfigPathFor(cfg.stateDir) });
  // A3/S4: local-user authorization of the artifact sink. Not reachable from any tool schema.
  const _dataplaneSinkRoute = registerDataplaneSinkRoute(ctx, { stateDir: () => resolveStateDir(cfg.stateDir, 'joint-dev') });
  // A6: read-only project SSE proxy (device token stays in the host process).
  const _projectStreamRoute = registerProjectStreamRoute(ctx, { relayUrl: () => cfg.rabbitUrl, deviceToken: () => resolveToken(cfg) });
  // v3.4.6: the backup panel's read-only half (`GET /api/w2m/backup/status` and `/scan`). Mounted from the
  // plugin root rather than a disable-by-default subplugin row, because both routes only read: a status card
  // that was absent until somebody edited `cordis.patch.yml` would report "not enabled" for a feature that has
  // nothing to enable yet. The `dsh-backup` subplugin row arrives with the engine (v3.4.7), where enabling it
  // starts meaning "a timer may write".
  const _backupRoutes = registerBackupRoutes(ctx, {
    dshHome: () => (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(os.homedir(), '.dsh')),
    backupDir: () => cfg.backupDir ?? null,
  });

  // v1.7.1: host-side screenshot + clipboard fallbacks. The DSH desktop shell does not grant the
  // renderer getDisplayMedia/navigator.clipboard, so the chat panel needs a host route that does not
  // depend on those permissions.
  registerCaptureRoutes(ctx);
  const remoteViewRoutes = registerDesktop(ctx, { stateDir: cfg.stateDir ?? '', p2p });
  if (remoteViewRoutes.mounted !== true) {
    ctx.logger?.info?.('w2m: remote-view routes inactive — ' + remoteViewRoutes.reason);
  }
  if (capabilityRoutes.mounted !== true) {
    ctx.logger?.warn?.('w2m: the execution-capability control is inactive — ' + capabilityRoutes.reason);
  }

  const chatRoutes = registerChatRoutes(ctx, {
    cfg: () => cfg,
    request,
    resolveToken: () => resolveToken(cfg),
    // v1.1.20: the panel needs to know WHICH machine is speaking, and which conversation the session belongs to.
    // Both are already resolved in this scope for the target control; passing them here is what lets the route key
    // messages by account+project instead of by a per-machine session id no other machine can compute.
    localIdentity,
    // The account material is the fleet key the local stack resolved (config first, then the account join). NOT the
    // account code: that is written to logs, and a conversation key derivable from a printed value would let anyone in.
    // Null until the join lands; the route then keeps the conversation scoped to this machine instead of refusing.
    accountMaterial: () => resolvedFleetKey.value,
  });
  if (chatRoutes.mounted !== true) {
    // Named rather than silent: a composition without the fetch registry loses the chat panel while every tool still
    // works, and "the panel is missing" with no line anywhere is the shape this project keeps paying for.
    ctx.logger?.warn?.('w2m: the fleet-chat composer route is not mounted (' + (chatRoutes.reason ?? 'unknown reason') + ')');
  }

  // The LAN discovery source (v0.7.0). Constructing it binds nothing: a socket is opened only when a
  // scan is asked for, and only `w2m_devices` asks. A network where multicast is unavailable produces
  // one log line and an `available: false` block in the answer - never a failure of the tool.
  const discovery = createDiscoverySource({ logger: ctx.logger });

  /** Text output: rendered as JSON, because every one of these tools answers with a structure. */
  const jsonOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  };

  // -------------------------------------------------------------------------------------------
  // 1. w2m_device - read-only
  // -------------------------------------------------------------------------------------------
  registerJointTools(ctx, {
    defineTool,
    stateDir: resolveStateDir(cfg.stateDir, 'joint-dev'),
    machineName: cfg.machineName,
    output: jsonOutput,
    progress: async ({ planSha }) => {
      try {
        const token = await resolveToken(cfg);
        return await planProgress({ stateDir: resolveStateDir(cfg.stateDir, 'joint-dev'), planSha, relayUrl: cfg.rabbitUrl, deviceToken: token });
      } catch {
        return { ok: false, code: 'PROGRESS_UNAVAILABLE' };
      }
    },
  });

  registerDevices(ctx, { cfg, defineTool, discovery, jsonOutput, localIdentity, pluginVersion: PLUGIN_VERSION });

  registerRun(ctx, { approvalGate, approvalQueue, cfg, defineTool, jsonOutput, p2p, pluginVersion: PLUGIN_VERSION });

  registerWait(ctx, { cfg, defineTool, jsonOutput });

  registerReport(ctx, { cfg, defineTool, jsonOutput });

  registerStatus(ctx, { currentApprovals: () => approvals, cfg, config, defineTool, jsonOutput, p2p, targetRoutes });

  // -------------------------------------------------------------------------------------------
  // Optional: bring up relay + agent in this process
  // -------------------------------------------------------------------------------------------
  if (cfg.autoStartAgent) {
    // v1.5.3: a failed auto-start must not surface as an unhandled rejection. The bundled patch now
  // starts the agent by default, and a host whose plugin wiring forbids that (a restricted test
  // harness, a missing relay module) would otherwise reject where nothing can catch it.
  ctx.effect?.(() => startFailoverStack(ctx, cfg).catch((error) => {
    ctx.logger?.warn?.('w2m: auto-start did not complete: ' + (error instanceof Error ? error.message : String(error)));
  }));
  } else {
    /**
     * v0.8.5: **say it out loud.**
     *
     * This branch is the whole reason a machine can run v0.8.4 with the account-derived fleet key,
     * hold a valid signed-in account, reach the relay over HTTP 200, and still be in no fleet  -      * with nothing anywhere reporting a problem. The eight tools register, the plugin looks
     * healthy, and the join sequence simply never runs.
     *
     * A silent no-op that looks like success is the worst failure mode this plugin has had. One
     * line at warn level turns *"why is this machine not in my fleet"* from an investigation into a
     * log search.
     *
     * ## v1.0.3: the line was accurate and still left the operator stuck
     *
     * "Set `autoStartAgent: true` to join" names **one** of the two things required and does not say where to set
     * it. **Both omissions were measured on a real machine**: installed, activated, no error anywhere, and
     * `device_token: null` with `autoStartAgent: false`. The operator's own summary was *"it installed but the
     * machine is not in the fleet"* -- exactly what this warning predicts, and nothing in it resolves that.
     *
     * So the guidance is now **a procedure, and the procedure is ordered**:
     *
     *   1. Pairing needs a **one-time code the operator obtains**. It cannot be self-issued, and that is design
     *      rather than oversight -- the relay's own header says *"the pairing code is the only credential that
     *      grants admission"*, and a plugin able to join unattended would be one that lets any machine holding
     *      the package into the fleet.
     *   2. `autoStartAgent: true` goes on **the `w2m` row that already exists**, matched by `id` -- **not** as an
     *      `insert:`, which appends a second row with the same `id` and stops the client from opening.
     *
     * **The warning also states the current pairing state, because the two cases need different first steps.**
     * An unpaired machine must fetch a code; a paired one only has to turn the switch on, and sending *that*
     * machine after a code would send it somewhere it has no business.
     */
    let paired = false;
    /**
     * Read the pairing state, **read-only**, and only when a state directory is configured.
     *
     * ## Two defects this line caused before it was right, both measured
     *
     * **First it called `loadOrCreateIdentity({ dir: cfg.stateDir ?? undefined })`.**
     *
     *   * With `stateDir` unset -- the default -- that `undefined` falls back to `~/.dsh/xclient/device.json`,
     *     **the operator's real file**, and `loadOrCreateIdentity` **creates it when absent**. A message about
     *     the machine's state must not be able to change it. Four tests in `test/update-wiring.test.mjs` failed
     *     because the plugin read the real home instead of the profile they supplied.
     *   * Guarding on `stateDir` fixed those, **and broke a different one**: `test/tools.test.mjs:593` sets an
     *     empty `stateDir` and asserts `reason_code: DEVICE_NOT_PAIRED` for an **absent** `device.json`.
     *     `loadOrCreateIdentity` **created that file**, so the very next read found it present-but-unpaired and
     *     reported `DEVICE_TOKEN_ABSENT` instead. Isolated both ways: `tools.mjs` at 1.0.2 gives `115 pass,
     *     0 fail`; the version with this call gave `114 pass, 1 fail`.
     *
     * **`loadIdentity` is the read-only one** -- `ENOENT` returns `exists: false` and creates nothing -- which is
     * the only behaviour a diagnostic is entitled to.
     *
     * With nothing configured there is no location to consult, so the state is reported as unknown rather than
     * guessed at, which is what `w2m_status` already says for the same reason (`"stateDir is not set, so no agent
     * state could be located"`).
     */
    let stateDirConfigured = false;
    try {
      stateDirConfigured = typeof cfg.stateDir === 'string' && cfg.stateDir.trim() !== '';
      if (stateDirConfigured) {
        const { identity } = loadIdentity({ dir: cfg.stateDir });
        paired = typeof identity?.device_token === 'string' && identity.device_token !== '';
      }
    } catch {
      // An unreadable identity is `w2m_status`' business; this line is about joining, so it stays quiet.
      stateDirConfigured = false;
    }
    ctx.logger?.warn?.(
      'w2m: no agent is running on this machine, so it is in no fleet, will receive no work, and no dispatch '
      + 'will ever reach it.\n'
      + `      ${stateDirConfigured
        ? (paired
          ? 'This machine IS paired, so step 1 is already done -- only the switch is missing.'
          : 'This machine is NOT paired yet, so both steps below are required.')
        : 'No stateDir is configured, so this machine\'s pairing state could not be read; assume it is not '
          + 'paired and treat both steps below as required.'}\n`
      + '      To join, two things are needed:\n'
      + '        1. a one-time pairing code. `w2m-rabbit` prints it once, in its startup banner:\n'
      + '             [w2m-rabbit] listening on <url>  pairing code: PAIR-XXXXXXXX\n'
      + '           It lives in memory only and is never written to the state directory, so it is read from\n'
      + '           the relay\'s console. There is no flag that prints an existing code; starting the relay\n'
      + '           with `--pairing-code <c>` chooses a KNOWN code instead of a generated one, which is the\n'
      + '           supported way to make pairing repeatable.\n'
      + '        2. `autoStartAgent: true` plus that code, on the `w2m` row that ALREADY EXISTS in the\n'
      + '           profile\'s cordis.patch.yml, matched by id:\n'
      + '               - id: w2m\n'
      + '                 config:\n'
      + '                   autoStartAgent: true\n'
      + '                   pairingCode: PAIR-XXXXXXXX\n'
      + '           Do NOT add an `insert:` for it. An insert appends a SECOND entry with the same id, and the\n'
      + '           client then refuses to open -- measured on this project, not theorised.\n'
      + '      Or pair without touching this profile at all: run\n'
      + '          w2m-localside --rabbit <url> --pair <CODE>\n'
      + '      `w2m_status` reports both facts this line is about -- `identity.paired` and\n'
      + '      `config.autoStartAgent` -- and is the first thing to read when it appears.',
    );
  }

  // ---------------------------------------------------------------------------------------------
  // v0.2.3: daily self-update check
  // ---------------------------------------------------------------------------------------------
  // Compiled-in version, overridable via W2M_PLUGIN_VERSION. When it is unknown the updater
  // refuses to act rather than assuming it is old, which is why this may legitimately be null.
  const currentVersion = resolveCurrentVersion(PLUGIN_VERSION, process.env);
  const updater = createAutoUpdater({
    profileDir: cfg.profileDir,
    currentVersion,
    repo: cfg.update.repo,
    times: cfg.update.times,
    timeZone: cfg.update.timeZone,
    catchUpMs: cfg.update.catchUpMs,
    enabled: cfg.update.enabled,
    dryRun: cfg.update.dryRun,
    allowPrerelease: cfg.update.allowPrerelease,
    timeoutMs: cfg.update.timeoutMs,
    token: cfg.update.token,
    restartCommand: cfg.update.restartCommand,
    stateDir: cfg.update.stateDir,
    log: (message) => ctx.logger?.info?.(`w2m update: ${message}`),
    // A failing check is a normal Tuesday, not a crash: the scheduler keeps its slot.
    onError: (error) => ctx.logger?.warn?.(`w2m update: ${error.message}`),
  });

  // Reversible side effect. `ctx.effect` is provided by Cordis 4 (verified against 4.0.4). When the
  // feature is on and the host cannot track the effect, we fail loudly: a silently skipped effect
  // means a timer that is never released, a daily job leaking across every reload. When the feature
  // is off there is no timer to own, so the missing service must not take the tool set down with it.
  if (cfg.update.enabled) {
    if (typeof ctx.effect !== 'function') {
      throw new W2MError(
        'W2M_NO_EFFECT',
        'autoUpdate is enabled, so this plugin needs `ctx.effect` to own its scheduled job, and the context does not provide it',
        { hint: 'load the plugin in a Cordis 4 host, where ctx.effect tracks reversible side effects' },
      );
    }
    ctx.effect(() => {
      updater.start();
      return () => updater.stop();
    });
  } else {
    // Still resolvable and inspectable through `w2m_update`; just never scheduled.
    updater.start();
  }

  registerUpdate(ctx, { defineTool, jsonOutput, updater });

  registerHistory(ctx, { cfg, defineTool, jsonOutput });

  registerStats(ctx, { cfg, defineTool, jsonOutput });

  /**
   * v0.9.6 — the individual memory layer.
   *
   * The relay keeps `command_hash`, `stdout_sha256` and `stdout_bytes` and never the text, deliberately:
   * the ledger is a tamper-evident consistency record, and a relay compromise discloses no command text.
   * The price is that nothing in the fleet could answer *"what did we already try on this machine, and
   * what happened?"* -- and that price was paid repeatedly, with the same facts rediscovered from scratch
   * across a dozen dispatches in one session.
   *
   * This tool is the read side of the fix. The write side is `appendMemory`, called by the agent as each
   * task finishes, in that machine's own state directory.
   *
   * ## What this first version does and does not reach
   *
   * It reaches **this machine's** memory directly: the file is local, so the read is a file read. It does
   * **not** yet read another machine's memory, and the reason is structural rather than an omission --
   * the relay carries no such file, an agent executes a dispatched command inside a sandbox whose writes
   * are scoped, and pretending otherwise would mean shipping a tool that silently returns nothing for
   * every machine but one.
   *
   * So a query for another machine says exactly that, names where to look instead, and stays useful: the
   * fleet's roster still comes from the relay, so the answer distinguishes "no such machine" from "that
   * machine keeps its own memory and this build cannot fetch it".
   */
  /**
   * The collective layer's filename, beside the profile that mounted this plugin.
   *
   * §3.2 of the design puts curated fleet knowledge on the archive host. This is the read half of it, and
   * it deliberately reads a *markdown document* rather than a store: the design's own argument is that a
   * memory which is merely a log is one nobody reads, so the collective layer is written for a person and
   * this tool returns it as text rather than pretending to have parsed it into facts. A parser over
   * hand-written prose would silently drop whatever it did not recognise, and the dropped part would be
   * exactly the part a human thought was worth writing down.
   */
  const COLLECTIVE_FILE = 'fleet-memory.md';
  /**
   * The collective document's path, or `null` when there is no profile to resolve it against.
   *
   * `resolveProfileDir` legitimately returns `null` -- a bare test context, or a host whose layout it
   * cannot read -- and the first version of this passed that straight into `path.join`, which threw
   * `ERR_INVALID_ARG_TYPE`. A read tool that crashes on a missing directory is worse than one that says
   * the directory is missing: the caller was asking a question, and an exception is not an answer.
   */
  const collectivePath = () => {
    const dir = resolveProfileDir(cfg);
    return typeof dir === 'string' && dir !== '' ? path.join(dir, COLLECTIVE_FILE) : null;
  };

  registerMemory(ctx, { cfg, collectivePath, defineTool, jsonOutput });

  registerApprovals(ctx, { approvalQueue, cfg, defineTool, jsonOutput });

  registerChat(ctx, { askStore, cfg, defineTool, jsonOutput });

  registerIntent(ctx, { cfg, defineTool, jsonOutput });


  registerCouncil(ctx, { cfg, councilSessions, defineTool, fleetCouncil, jsonOutput });

  registerCancel(ctx, { cfg, defineTool, jsonOutput });


  registerReduce(ctx, { cfg, defineTool, jsonOutput });

  registerTasks(ctx, { cfg, defineTool, jsonOutput });
}
