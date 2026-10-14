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
 * is — not as it would sound best. `test/tool-cards.test.mjs` asserts the parts of it that can be
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
 * widen anything — the direction the shared matcher exists to keep honest (`src/agent/allowed-commands.mjs`).
 *
 * **No tool can change a machine's `p2pMode`.** The mode is resolved once, in `readConfig` at
 * `apply()` time, from the config object or `W2M_P2P_MODE`, and every dispatch publishes it as a fact
 * (`p2p: {mode}`) rather than accepting one. The *executor's* mode is its own local setting: an agent
 * configured `direct` refuses a relay-delivered offer with `P2P_UNAVAILABLE` rather than accepting the
 * weaker path, which is the one place a dispatcher could otherwise have quietly downgraded a peer.
 *
 * **No tool writes another machine's identity or keys.** `device.json` is read (`readDevice`) and
 * `device.key` is loaded (`DeviceKey.load`) — neither is ever written here. What a dispatch publishes
 * is this machine's own **public** key inside `p2p.static_keys`, so the executor can authenticate a
 * dial; the private half never leaves `src/agent/crypto.mjs`.
 *
 * **No tool result carries a token or a key.** `w2m_status` reports `paired`,
 * `operatorToken_configured` and `pairingCode_configured` as booleans and never the values. The
 * operator token travels only in the `Authorization` header of `POST /v1/task` — never in the request
 * body and never in an answer — and `direct_pushes[].static_key` is the literal marker `'published'`,
 * not the key it describes.
 *
 * What an agent-facing tool *may* do across machines is bounded and stated: ask the machines the relay
 * leased a task to run one argv inside their own allow-lists, in their own copy of the project,
 * read-only unless `write: true` names a `write_scope`, and report what they said — refusals
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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The base-address rules live in one place (§2), shared with the agent side. Importing the - rather
// than re-deriving them her - is what stops the plugin and the agent from disagreeing about what
// `https://host/w2m` means, which is the defect §2 exists to fix.
// `src/agent/` does not import `src/plugin/`, so the dependency runs one way and cannot cycle.
import { joinUrl, resolveBaseUrl } from '../agent/url.mjs';
import { deviceFilePath } from '../agent/identity.mjs';
// The allow-list matcher is shared with the agent on purpose: this plugin's pre-flight exists so a
// dispatcher does not send work the target machine would refuse, so the two ends must apply the
// same rule, token for token. See `src/agent/allowed-commands.mjs`.
import { matchAllowedCommand, parseAllowedCommands } from '../agent/allowed-commands.mjs';
import {
  DEFAULT_P2P_MODE,
  P2P_MODES,
  P2PNode,
  SHARED_SERVER,
  normalizeP2PMode,
  stunServersWithShared,
} from '../agent/p2p-node.mjs';
// The punch identity both ends have to agree on (v0.4.x). Imported from the transport that will use
// it, never re-derived here: the session is the only thing that tells one punch's frames from
// another's, so a second implementation of the formula that drifted by one input would make every
// reverse dial time out while both ends insisted they were sending.
import { mintPunchId, punchSession } from '../agent/p2p.mjs';
// v0.6.0: the device keypair and the offer's key distribution (`docs/P2P-CRYPTO.md` §4). Imported
// rather than reimplemented: the dispatcher and the executor have to derive the *same* keys, and two
// implementations of a handshake are two chances to disagree about it.
import { DeviceKey } from '../agent/crypto.mjs';
import { loadOrCreateIdentity, saveDeviceToken } from '../agent/identity.mjs';
import { probeCapsDetailed, detectPlatform } from '../agent/caps.mjs';
import { resolveStateDir } from '../util/cli.mjs';
import { parseServer } from '../agent/stun.mjs';
// The result-deduplication identity the relay mints. Imported rather than re-implemented: the value
// is compared byte for byte by the executor, so a second copy of the formula that drifted by one
// character would turn "delivered twice, executed once" into "executed twice" -- the exact failure
// the dedupe key exists to prevent.
import { SHELL_ID_DIRECT, computeCommandHash, computeDedupeKey } from '../relay/state.mjs';
import { createAutoUpdater, findProfileDir, resolveCurrentVersion } from './auto-update.mjs';
// v0.6.1: the session's chosen target machine, and the two browser routes the composer control
// reads it through. Imported rather than inlined because the control and `w2m_run` must agree on
// what "selected" means, and a second copy of that rule is a second chance to disagree.
import {
  createLocalIdentity,
  defaultSelectionStore,
  dispatchSelectionFields,
  readFleet,
  registerTargetRoutes,
  sessionKeyFor,
  TARGET_ROUTE_PATH,
} from './fleet-target.mjs';
// v0.7.0: the LAN hint layer. Imported here and used in exactly one place (`w2m_devices`); see the
// module header for why a discovered device is a candidate to *ask* and never an authorisation.
import { createDiscoverySource } from './mdns-discover.mjs';
import { loadSharedConfig, describeSharedConfig } from './shared-config.mjs';
import { DEFAULT_DAILY_TIMES, DEFAULT_TIME_ZONE } from './schedule.mjs';

/** Services this plugin needs. The harness refuses to load the plugin without them. */
export const inject = ['tools'];

/** Line protocol version this plugin speaks. Reported by `w2m_status`, never negotiated here. */
const PROTOCOL_VERSION = 1;

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

/**
 * This plugin's own version, baked in at pack time.
 *
 * The updater compares the newest release against this string, so a wrong value here means either a
 * downgrade (worse than a missed update) or a permanent no-op. It is therefore read from
 * `package.json` during `scripts/pack.mjs` rather than hand-maintained, and `W2M_PLUGIN_VERSION`
 * overrides it at runtime for tests and packagers.
 */
const PLUGIN_VERSION = '__W2M_PLUGIN_VERSION__';

/** How long any single HTTP call may take before it is aborted, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** How long `w2m_status`'s reachability probe may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 3_000;

/** Wall-clock ceiling for one `w2m_wait` call, in milliseconds. */
const MAX_WAIT_MS = 600_000;

/** Wall-clock ceiling for one command handed to the machines, in milliseconds. */
const MAX_TASK_TIMEOUT_MS = 3_600_000;

/** Lower bound, in milliseconds, on the interval between two status polls. */
const MIN_POLL_MS = 25;

/** Largest JSON body this plugin will read, in bytes. Keeps a flood out of the session. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Largest report body this plugin will read, in bytes. */
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** Largest `stdout`/`stderr` excerpt returned inline by `w2m_wait`, in bytes per stream. */
const MAX_EXCERPT_BYTES = 4096;

/** HTTP statuses worth one more attempt: the request did not reach a decision. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Every stable code a **gate in this file** refuses with, in one greppable place.
 *
 * The nine aggregate verdicts never reduce an outcome to a boolean; the gates that run *before* any
 * comparison owe a caller the same courtesy, and this table is that debt paid. Each code names what
 * was refused, and every refusal site also carries a `detail` saying what would change it, because a
 * caller that cannot act on a refusal has been told nothing.
 *
 * Two of these are the agent's own vocabulary, deliberately shared rather than re-spelled:
 * `COMMAND_NOT_ALLOWED` (`REFUSAL.COMMAND_NOT_ALLOWED` in `src/agent/agent.mjs`, which is also what
 * `src/agent/allowed-commands.mjs` returns) and the `P2P_FRAME_*` family that already travelled into
 * `w2m_status` as message prefixes.
 *
 * A code is added only when it names a *distinct remedy*. `W2M_CONFIG` still covers a malformed
 * setting at large; the credential gate below has its own code because its remedy — set
 * `operatorToken` — is unlike any other configuration fault's.
 */
export const REFUSAL_CODE = Object.freeze({
  /** The dispatch pre-flight found the command outside this plugin's `allowedCommands`. */
  COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',
  /**
   * The configured `allowedCommands` could not be parsed, so the control could not be evaluated.
   * Distinct from the code above: the remedy is to fix the list, not the command.
   */
  ALLOWED_COMMANDS_UNPARSEABLE: 'ALLOWED_COMMANDS_UNPARSEABLE',
  /** No operator credential is configured, so `POST /v1/task` cannot be authorised at all. */
  OPERATOR_TOKEN_MISSING: 'OPERATOR_TOKEN_MISSING',
  /** No `device.json` exists where this machine's identity was looked for. */
  DEVICE_NOT_PAIRED: 'DEVICE_NOT_PAIRED',
  /** `device.json` exists but could not be read as JSON. */
  DEVICE_UNREADABLE: 'DEVICE_UNREADABLE',
  /** `device.json` parsed but carries no `device_token`, so the device never completed pairing. */
  DEVICE_TOKEN_ABSENT: 'DEVICE_TOKEN_ABSENT',
  /** The relay returned a lease with no `machine_id`, so there is nobody to address an offer to. */
  P2P_LEASE_NO_MACHINE_ID: 'P2P_LEASE_NO_MACHINE_ID',
  /** The lease is not in a runnable state, so the relay never handed this machine the command. */
  P2P_LEASE_NOT_RUNNABLE: 'P2P_LEASE_NOT_RUNNABLE',
  /** A direct dial to a leased machine failed; `direct_pushes[].error` carries the node's own code. */
  P2P_DIAL_FAILED: 'P2P_DIAL_FAILED',
  /** The best-effort offer push threw rather than returning a refusal. */
  P2P_PUSH_THREW: 'P2P_PUSH_THREW',
  /** A frame arrived over a direct channel that is not a JSON document. */
  P2P_FRAME_NOT_JSON: 'P2P_FRAME_NOT_JSON',
  /** A frame arrived that parsed to something other than a JSON object. */
  P2P_FRAME_NOT_AN_OBJECT: 'P2P_FRAME_NOT_AN_OBJECT',
  /** A result frame carried no `task_id`, so it could not be stored or acknowledged. */
  P2P_FRAME_NO_TASK_ID: 'P2P_FRAME_NO_TASK_ID',
  /** A result frame carried no `machine_id`, so two machines' answers could collide on one file. */
  P2P_FRAME_NO_MACHINE_ID: 'P2P_FRAME_NO_MACHINE_ID',
  /** A result arrived with no `stateDir` to write it to. */
  P2P_NO_STATE_DIR: 'P2P_NO_STATE_DIR',
  /** Storing a result frame failed, so the result exists only on the sender. */
  P2P_INBOX_WRITE_FAILED: 'P2P_INBOX_WRITE_FAILED',
  /**
   * The composer's selected target routed this dispatch. Not a refusal — a named *reason*, so the
   * routing decision is greppable in the answer instead of being a bare `applied: true`.
   */
  SELECTION_APPLIED: 'SELECTION_APPLIED',
  /** Nothing is selected for this session, so the dispatch went to the whole fleet. */
  SELECTION_NONE: 'SELECTION_NONE',
  /** A selection exists but names no `machine_id`, so none of it could be applied. */
  SELECTION_UNUSABLE: 'SELECTION_UNUSABLE',
  /** The call named its own `executor_machine_id`, which wins over the session selection. */
  SELECTION_OVERRIDDEN_BY_CALLER: 'SELECTION_OVERRIDDEN_BY_CALLER',
});

/**
 * The leading `CODE:` token of a message one of this project's own modules produced, or `null`.
 *
 * Every coded failure in this tree is written as `'CODE: what happened'`, so the code is already in
 * the string; this lifts it back out for the places that must publish it as a field too. It refuses
 * to invent one: a message with no such prefix returns `null` and the caller supplies its own code.
 *
 * @param {unknown} message
 * @returns {string|null}
 */
function reasonCodeOf(message) {
  if (typeof message !== 'string') return null;
  const match = /^([A-Z][A-Z0-9_]{2,}):/.exec(message);
  return match ? match[1] : null;
}

/**
 * An error a caller can act on, carrying a stable machine-readable code.
 *
 * `code` and `hint` are duplicated into enumerable own properties so that `JSON.stringify(error)`
  - which a tool layer may well d - still shows the caller what was wrong.
 */
class W2MError extends Error {
  /**
   * @param {string} code Stable code, e.g. `W2M_CONFIG`.
   * @param {string} message What went wrong and, when known, how to fix it.
   * @param {{hint?: string, detail?: object, cause?: unknown, reason_code?: string}} [options]
   *   `reason_code` names the *refusal* when `code` only names its class. `W2M_CONFIG` says "a
   *   setting is wrong"; `OPERATOR_TOKEN_MISSING` says which gate refused and, with `hint`, what
   *   would change it. It defaults to `code`, so every existing error keeps one obvious code.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'W2MError';
    this.code = code;
    this.reason_code = options.reason_code ?? code;
    this.hint = options.hint;
    this.detail = options.detail;
  }
}

/**
 * A configured value is missing or unusable.
 *
 * The message carries the setting name, what is wrong with it, and what to set instea - a model
 * reading only the message has to be able to fix the configuration by itself. The hint repeats the
 * remediation for callers that surface hints separately.
 *
 * @param {string} setting Dotted setting name, e.g. `rabbitUrl`.
 * @param {string} why Why the value was refused.
 * @param {string} hint What to set.
 * @param {string} [reasonCode] The refusal's own code, when this is a gate rather than a typo.
 * @returns {W2MError}
 */
function configError(setting, why, hint, reasonCode) {
  return new W2MError('W2M_CONFIG', `W2M_CONFIG: configuration \`${setting}\` ${why}; ${hint}`, {
    hint,
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
  });
}

// ---------------------------------------------------------------------------------------------
// Cooperative cancellation
// ---------------------------------------------------------------------------------------------

/**
 * An `AbortSignal` that fires when either input fires.
 *
 * Hand-rolled rather than `AbortSignal.any` so the plugin keeps working on the Node versions
 * this project supports without a feature probe on the hot path.
 *
 * @param {AbortSignal|undefined} a
 * @param {AbortSignal|undefined} b
 * @returns {{signal: AbortSignal, dispose: () => void}}
 */
function combineSignals(a, b) {
  const controller = new AbortController();
  const forward = (from) => () => controller.abort(from.reason);
  const listeners = [];

  for (const signal of [a, b]) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const handler = forward(signal);
    signal.addEventListener('abort', handler, { once: true });
    listeners.push([signal, handler]);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, handler] of listeners) signal.removeEventListener('abort', handler);
    },
  };
}

/**
 * Stop now when the caller has already cancelled, before doing any work.
 *
 * The abort reason is wrapped, not re-thrown raw: a caller that gets `W2M_ABORTED` back can tell
 * "you cancelled me" apart from "the Rabbit refused", which is the distinction these tools exist
 * to preserve. The original reason is kept as the cause.
 *
 * @param {AbortSignal|undefined} signal
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof W2MError) throw reason;
  throw new W2MError('W2M_ABORTED', `W2M_ABORTED: the call was cancelled${reason instanceof Error && reason.message ? ` (${reason.message})` : ''}`, {
    hint: 'the caller withdrew the request; nothing was sent',
    cause: reason,
  });
}

/**
 * Did this rejection come from an abort rather than from a real failure?
 *
 * @param {unknown} error
 * @param {AbortSignal|undefined} signal
 * @returns {boolean}
 */
function isAbort(error, signal) {
  if (signal?.aborted) return true;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return error instanceof W2MError && error.code === 'W2M_ABORTED';
}

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

// ---------------------------------------------------------------------------------------------
// `defineTool`: real import first, offline shim second
// ---------------------------------------------------------------------------------------------

/** Parameters the shim understands in a definition. Anything else is a typo, and is rejected. */
const ALLOWED_DEF_KEYS = new Set(['name', 'description', 'parameters', 'output', 'execute', 'presentCall']);

/**
 * Validate one parameter declaration and return a normalised copy.
 *
 * @param {string} toolName Owning tool, for messages.
 * @param {string} key Parameter name.
 * @param {unknown} decl Declaration from the definition.
 * @returns {object}
 */
function normaliseParameter(toolName, key, decl) {
  if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
    throw new TypeError(`${toolName}: parameter \`${key}\` must be an object`);
  }
  const { type } = decl;
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'array' && type !== 'object') {
    throw new TypeError(`${toolName}: parameter \`${key}\` needs a type of string|number|boolean|array|object`);
  }
  if (type === 'array' && 'items' in decl) {
    if (decl.items === null || typeof decl.items !== 'object') {
      throw new TypeError(`${toolName}: parameter \`${key}\`.items must be an object`);
    }
  }
  const copy = { ...decl };
  if (copy.required !== undefined && typeof copy.required !== 'boolean') {
    throw new TypeError(`${toolName}: parameter \`${key}\`.required must be a boolean`);
  }
  if (copy.default !== undefined) copy.required = false;
  return copy;
}

/**
 * The offline stand-in for `@deepseek-ai/dsh-tools`' `defineTool`.
 *
 * It normalises and checks shape only; see the file header for the full list of what it
 * deliberately does not do. The real `defineTool`'s own properties are copied onto it so anything
 * else DSH exports alongside it keeps working.
 *
 * @param {object} [real] The genuine `defineTool`, when the package resolved.
 * @returns {{defineTool: (def: object) => object, usedFallback: boolean}}
 */
function createDefineTool(real) {
  const defineTool = (definition) => {
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError('defineTool: definition must be an object');
    }

    const name = definition.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('defineTool: `name` must be a non-empty string');
    }

    for (const key of Object.keys(definition)) {
      if (!ALLOWED_DEF_KEYS.has(key)) {
        throw new TypeError(`defineTool(${name}): unsupported definition key \`${key}\``);
      }
    }

    if (typeof definition.execute !== 'function') {
      throw new TypeError(`defineTool(${name}): \`execute\` must be a function`);
    }

    const declared = definition.parameters ?? {};
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
      throw new TypeError(`defineTool(${name}): \`parameters\` must be an object`);
    }

    const parameters = {};
    for (const [key, decl] of Object.entries(declared)) {
      parameters[key] = normaliseParameter(name, key, decl);
    }

    return { ...definition, parameters };
  };

  if (real && typeof real === 'object') Object.assign(defineTool, real);
  return { defineTool, usedFallback: !real };
}

/** Cached so `apply()` can be called more than once without re-importing. */
let defineToolModule;

/**
 * Forget the resolved `defineTool`, so the next `loadDefineTool()` resolves again.
 *
 * Exists for the unit tests, which need to exercise both the real-import path and the offline
 * shim in the same process. It is not part of the plugin's runtime contract.
 */
export function resetDefineToolCacheForTests() {
  defineToolModule = undefined;
}

/**
 * Resolve `@deepseek-ai/dsh-tools` at runtime, falling back to the offline shim.
 *
 * @returns {Promise<{defineTool: Function, usedFallback: boolean, reason: string|null}>}
 */
async function loadDefineTool() {
  if (!defineToolModule) {
    defineToolModule = (async () => {
      try {
        const mod = await import('@deepseek-ai/dsh-tools');
        if (typeof mod?.defineTool !== 'function') {
          return { ...createDefineTool(undefined), reason: 'the package resolved but exports no `defineTool`' };
        }
        return { defineTool: mod.defineTool, usedFallback: false, reason: null };
      } catch (error) {
        return { ...createDefineTool(undefined), reason: error instanceof Error ? error.message : String(error) };
      }
    })();
  }
  return defineToolModule;
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/**
 * Read and validate the plugin configuration.
 *
 * Only `rabbitUrl` is required, and only for the tools that talk to the Rabbit: `w2m_status` is
 * the diagnostic you reach for *when* the setup is broken, so it must still run without it.
 *
 * @param {object} config Entry configuration from the profile patch.
 * @returns {{rabbitUrl: string|null, rabbitSource: string|null, rabbitUrlOverride: string|null,
 *            stateDir: string|null, projectDir: string, machineName: string|null,
 *            autoStartAgent: boolean, allowedCommands: string[], pairingCode: string|null,
 *            p2pMode: string, stunServers: string[]}}
 */
function readConfig(config = {}) {
  const cwd = process.cwd();

  /**
   * §7: where the relay address came from.
   *
   * The order is `rabbitUrl` → `W2M_RABBIT_URL` → the shared server, and the *source* is carried out
   * of here rather than re-derived at report time, because "which of the three won" is exactly the
   * question a cross-network deployment gets wrong: a machine that silently talked to the shared
   * server instead of the operator's own relay looks identical to a working one until it dispatches
   * work nobody receives. `rabbitUrlOverride` is what was suppressed (the device's own `rabbit_url`
   * in `device.json`, which v0.3.9 used as a fallback) so `w2m_status` can say it out loud.
   */
  let rabbitUrl = null;
  let rabbitSource = null;
  let rabbitUrlOverride = null;
  if (typeof config.rabbitUrl === 'string' && config.rabbitUrl.trim() !== '') {
    rabbitUrl = checkedRabbitBase(config.rabbitUrl);
    rabbitSource = 'config';
  } else if (typeof process.env.W2M_RABBIT_URL === 'string' && process.env.W2M_RABBIT_URL.trim() !== '') {
    try {
      rabbitUrl = checkedRabbitBase(process.env.W2M_RABBIT_URL);
    } catch (reason) {
      // Re-thrown with the environment variable named: `W2M_RABBIT_URL` is set and wrong, and a
      // message about `rabbitUrl` would send the operator to edit the wrong place.
      throw configError(
        'W2M_RABBIT_URL',
        `is set but not usable as a base address (${reason instanceof Error ? reason.message : String(reason)})`,
        'set it to the relay base address, for example http://127.0.0.1:8787 or https://w2m.example.com/w2m, or unset it to use the shared server',
      );
    }
    rabbitSource = 'env';
  } else {
    rabbitUrl = checkedRabbitBase(SHARED_SERVER.rabbitUrl);
    rabbitSource = 'shared-default';
    rabbitUrlOverride = 'device.rabbit_url';
  }

  const stateDir = typeof config.stateDir === 'string' && config.stateDir.trim() !== ''
    ? path.resolve(config.stateDir.trim())
    : null;

  // §7: both of these are validated here, at `apply()` time, so a typo is a startup error that names
  // the setting rather than a status field nobody reads. See the two resolvers for why there is no
  // silent default when a value *is* supplied.
  const p2p = resolveP2PMode(config);
  const p2pMode = p2p.mode;
  const stun = resolveStunServers(config);
  const stunList = stun.servers;

  /**
   * v0.3.3 shared config: `.w2m.json` in the project, overridden by `~/.w2m/machine.json`, overridden
   * by the host's own config object.
   *
   * `allowedCommands` and the timeout participate here so that a fleet shares one allow-list instead
   * of one per machine -- the machine whose copy drifted is the one nobody looks at until it refuses
   * a command. The host layer is `config` itself, so an explicit setting always wins and nothing that
   * used to work stops working.
   *
   * A broken file throws. Running on defaults while the operator believes their settings apply is the
   * silently-wrong outcome this project refuses everywhere else, and a config file is no exception.
   */
  const shared = loadSharedConfig({
    projectDir: typeof config.projectDir === 'string' && config.projectDir.trim() !== ''
      ? path.resolve(config.projectDir.trim())
      : cwd,
    machineDir: typeof config.machineDir === 'string' && config.machineDir.trim() !== ''
      ? path.resolve(config.machineDir.trim())
      : undefined,
    explicit: {
      ...(Array.isArray(config.allowedCommands) ? { allowedCommands: config.allowedCommands } : {}),
      ...(Number.isInteger(config.defaultTimeoutMs) ? { defaultTimeoutMs: config.defaultTimeoutMs } : {}),
      ...(Number.isInteger(config.maxOutputBytes) ? { maxOutputBytes: config.maxOutputBytes } : {}),
      ...(Array.isArray(config.writeScope) ? { writeScope: config.writeScope } : {}),
    },
  });

  return {
    stateDir,
    projectDir: typeof config.projectDir === 'string' && config.projectDir.trim() !== ''
      ? path.resolve(config.projectDir.trim())
      : cwd,
    machineName: typeof config.machineName === 'string' && config.machineName.trim() !== ''
      ? config.machineName.trim()
      : os.hostname(),
    autoStartAgent: config.autoStartAgent === true,
      /**
       * v0.8.3: the account-derived key this machine joins its fleet with.
       *
       * Supplied by the host, which is the only layer that can read the signed-in account -- a
       * standalone agent cannot derive it, which is why it must be handed down rather than
       * computed where it is used. `W2M_FLEET_KEY` is accepted too, so a machine can be pointed at
       * a fleet without editing a profile.
       */
      fleetKey: typeof config.fleetKey === 'string' && config.fleetKey.trim() !== ''
        ? config.fleetKey.trim()
        : (typeof process.env.W2M_FLEET_KEY === 'string' && process.env.W2M_FLEET_KEY.trim() !== ''
          ? process.env.W2M_FLEET_KEY.trim()
          : null),
    // From the merged layers, not from `config` alone: this is the value the fleet shares.
    allowedCommands: shared.values.allowedCommands
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
    defaultTimeoutMs: shared.values.defaultTimeoutMs,
    sharedConfig: shared,
    pairingCode: typeof config.pairingCode === 'string' && config.pairingCode.trim() !== ''
      ? config.pairingCode.trim()
      : (typeof process.env.W2M_PAIRING_CODE === 'string' && process.env.W2M_PAIRING_CODE.trim() !== ''
        ? process.env.W2M_PAIRING_CODE.trim()
        : null),
    // §5: the operator credential. Only `w2m_run` uses it.
    operatorToken: typeof config.operatorToken === 'string' && config.operatorToken.trim() !== ''
      ? config.operatorToken.trim()
      : (typeof process.env.W2M_OPERATOR_TOKEN === 'string' && process.env.W2M_OPERATOR_TOKEN.trim() !== ''
        ? process.env.W2M_OPERATOR_TOKEN.trim()
        : null),
    // ---------------------------------------------------------------------------------------------
    // v0.2.3: daily self-update
    // ---------------------------------------------------------------------------------------------
    // These belong to this plugin's own maintenance, not to the W2M line protocol, which is why
    // they are read here rather than from the profile's Rabbit settings.
    update: readUpdateConfig(config, stateDir),
    // Carried through so the updater can find the profile it must install into. Resolved here
    // rather than at use time so `w2m_status` can report the same path the installer will use.
    profileDir: resolveProfileDir(config),
    // ---------------------------------------------------------------------------------------------
    // v0.4.0: the direct path
    // ---------------------------------------------------------------------------------------------
    rabbitUrl,
    rabbitSource,
    rabbitUrlOverride,
    p2pMode,
    stunServers: stunList,
  };
}

/**
 * Resolve `p2pMode` from the config object, then `W2M_P2P_MODE`, then the default — loudly.
 *
 * A value that is present and wrong is a `W2M_CONFIG` error naming the setting: falling back to
 * `auto` would dispatch work over a path the operator explicitly asked not to use, and falling back
 * to `relay` would silently disable the release's headline feature. Neither is a default; both are
 * decisions the operator has to make.
 *
 * "Present" is decided by the *key*, not by truthiness. A profile patch that writes `p2pMode:` with
 * nothing after it hands this function `null`, and that is a value somebody typed — collapsing it
 * into "the key is absent" is exactly the silent default this function exists to refuse. An unset key
 * and a blank `W2M_P2P_MODE` are the only two shapes that mean "nobody chose", and only the second is
 * treated as absent because an unset environment variable is indistinguishable from an empty one.
 *
 * @param {Record<string, unknown>} config - Raw plugin config.
 * @returns {{mode: string, source: 'config'|'env'|'default'}}
 */
function resolveP2PMode(config) {
  const hasConfig = Object.prototype.hasOwnProperty.call(config, 'p2pMode') && config.p2pMode !== undefined;
  const fromEnv = process.env.W2M_P2P_MODE;
  const hasEnv = typeof fromEnv === 'string' && fromEnv !== '';
  const raw = hasConfig ? config.p2pMode : hasEnv ? fromEnv : DEFAULT_P2P_MODE;
  const source = hasConfig ? 'config' : hasEnv ? 'env' : 'default';

  const normalized = normalizeP2PMode(raw);
  if (!normalized.ok) {
    const setting = source === 'env' ? 'W2M_P2P_MODE' : 'p2pMode';
    // The normalizer's own `P2P_MODE_*` code is kept: it is the reason, and dropping it here would
    // leave a caller who has both messages unable to tell which check refused the value.
    throw configError(
      setting,
      `is not a usable P2P mode (${normalized.reason})`,
      `set it to one of ${P2P_MODES.join(', ')}: "auto" punches and keeps the relay as the fallback, ` +
        '"direct" punches without hiding a failure, "relay" never opens a UDP socket at all',
    );
  }
  return { mode: normalized.mode, source };
}

/**
 * Resolve `stunServers` from the config object, then `W2M_STUN_SERVERS`, then the shared list.
 *
 * Every entry is validated here, before the node is built, because the alternative is a tick several
 * seconds later inside the node's announce loop: an unusable STUN entry is a configuration mistake,
 * and this project reports those at the call site rather than as a degraded status field. The rule
 * itself is `parseServer` from `src/agent/stun.mjs` — the same function the query path will use, so
 * "valid here" and "usable there" cannot drift.
 *
 * An **empty list is the default**, not an error. `stunServers: []` is what the bundled
 * `cordis.patch.yml` carries (a key that documents itself and names no server), and a profile that
 * starts from that file must not fail to load. `null` entries are dropped for the same reason — a
 * YAML list with a blank item is the same statement as a blank item in a profile patch. A list whose
 * entries are *wrong* is still refused: there is a difference between "nothing named" and "the wrong
 * thing named", and only the second is a mistake.
 *
 * @param {Record<string, unknown>} config - Raw plugin config.
 * @returns {{servers: string[], source: 'config'|'env'|'default'}}
 */
function resolveStunServers(config) {
  const fromConfig = Array.isArray(config.stunServers)
    ? config.stunServers.filter((entry) => entry !== null && entry !== undefined)
    : config.stunServers;
  const fromEnv = process.env.W2M_STUN_SERVERS;
  const configNamesNothing = Array.isArray(fromConfig) && fromConfig.length === 0;
  const hasConfig = fromConfig !== undefined && fromConfig !== null && !configNamesNothing;
  const hasEnv = typeof fromEnv === 'string' && fromEnv.trim() !== '';

  if (!hasConfig && !hasEnv) {
    return { servers: stunServersWithShared(), source: 'default' };
  }

  const setting = hasConfig ? 'stunServers' : 'W2M_STUN_SERVERS';
  const raw = hasConfig ? fromConfig : fromEnv;
  const entries = typeof raw === 'string' ? raw.split(',') : raw;
  if (!Array.isArray(entries)) {
    throw configError(
      setting,
      `must be an array of "host:port" strings or a comma-separated string, got ${typeof raw}`,
      `give the STUN servers as a list, for example ["${SHARED_SERVER.stun}"], or omit the setting to use the shared server followed by the public fallbacks`,
    );
  }

  const servers = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw configError(
        setting,
        `must contain only "host:port" strings, got ${JSON.stringify(entry)} (${typeof entry})`,
        `write every STUN server as a "host:port" string, for example "${SHARED_SERVER.stun}"`,
      );
    }
    const spec = entry.trim();
    if (spec === '') {
      throw configError(
        setting,
        'contains an empty entry',
        `remove the empty entry, or omit the setting to use ${SHARED_SERVER.stun} followed by the public fallbacks`,
      );
    }
    let parsed;
    try {
      parsed = parseServer(spec);
    } catch (reason) {
      throw configError(
        setting,
        `contains ${JSON.stringify(entry)}, which is not "host:port" (${reason instanceof Error ? reason.message : String(reason)})`,
        `write every STUN server as a "host:port" string, for example "${SHARED_SERVER.stun}"`,
      );
    }
    if (parsed.host === '') {
      throw configError(
        setting,
        `contains ${JSON.stringify(entry)}, which names no host`,
        `write the host as well as the port, for example "${SHARED_SERVER.stun}"`,
      );
    }
    if (!servers.includes(spec)) servers.push(spec);
  }
  if (servers.length === 0) {
    throw configError(
      setting,
      'is an empty list, so no STUN server could be queried',
      `omit the setting to use ${SHARED_SERVER.stun} followed by the public fallbacks, or name at least one "host:port"`,
    );
  }
  return { servers, source: hasConfig ? 'config' : 'env' };
}

/**
 * Read the self-update settings.
 *
 * Split out from `readConfig` because a malformed time or zone here must be a **loud startup error**
 * naming the setting, not a silently-substituted default: a typo in `autoUpdateTimes` would
 * otherwise move the check to an hour the user never chose, and nothing would say so.
 *
 * @param {Record<string, unknown>} config - Raw plugin config.
 * @param {string|null} stateDir - Resolved state directory, if any.
 * @returns {object} Normalized update settings.
 */
function readUpdateConfig(config, stateDir) {
  const env = process.env;

  const boolFromEnv = (name) => {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const v = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return null;
  };

  // Off unless asked for. An updater that replaces the installed plugin on its own is not
  // something to switch on behind an operator's back.
  const enabledRaw = config.autoUpdate ?? boolFromEnv('W2M_AUTO_UPDATE');
  const enabled = enabledRaw === true;

  const timesRaw = Array.isArray(config.autoUpdateTimes) && config.autoUpdateTimes.length > 0
    ? config.autoUpdateTimes
    : (typeof env.W2M_AUTO_UPDATE_TIMES === 'string' && env.W2M_AUTO_UPDATE_TIMES.trim() !== ''
      ? env.W2M_AUTO_UPDATE_TIMES.split(',')
      : DEFAULT_DAILY_TIMES);

  let times;
  try {
    times = normalizeUpdateTimes(timesRaw);
  } catch (error) {
    throw configError(
      'autoUpdateTimes',
      error instanceof Error ? error.message : String(error),
      'use 24-hour "HH:mm:ss" values in the configured zone, for example ["00:00:00","03:00:00","05:00:00"]',
    );
  }

  const timeZone = typeof config.autoUpdateTimeZone === 'string' && config.autoUpdateTimeZone.trim() !== ''
    ? config.autoUpdateTimeZone.trim()
    : (typeof env.W2M_AUTO_UPDATE_TZ === 'string' && env.W2M_AUTO_UPDATE_TZ.trim() !== ''
      ? env.W2M_AUTO_UPDATE_TZ.trim()
      : DEFAULT_TIME_ZONE);

  // Validate the zone now, so a typo fails at load rather than at 03:00 in a log nobody reads.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw configError(
      'autoUpdateTimeZone',
      `is not a time zone this runtime knows: ${JSON.stringify(timeZone)}`,
      'use an IANA zone name such as Asia/Shanghai',
    );
  }

  const repoRaw = typeof config.updateRepo === 'string' && config.updateRepo.trim() !== ''
    ? config.updateRepo.trim()
    : (typeof env.W2M_UPDATE_REPO === 'string' && env.W2M_UPDATE_REPO.trim() !== ''
      ? env.W2M_UPDATE_REPO.trim()
      : 'TwinsEarth/dsh-windows2macos');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoRaw)) {
    throw configError(
      'updateRepo',
      `must look like "owner/name", got ${JSON.stringify(repoRaw)}`,
      'for example TwinsEarth/dsh-windows2macos',
    );
  }

  /** @param {unknown} value @param {number} fallback */
  const positive = (value, fallback) => (Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback);

  return {
    enabled,
    times,
    timeZone,
    repo: repoRaw,
    // Catch-up window: how late a missed slot may be and still run. Kept well under a day so a
    // process that starts at 14:00 does not invent a check at an hour nobody asked for.
    catchUpMs: positive(config.autoUpdateCatchUpMs, 90 * 60_000),
    dryRun: config.autoUpdateDryRun === true,
    allowPrerelease: config.autoUpdateAllowPrerelease === true,
    timeoutMs: positive(config.autoUpdateTimeoutMs, 30_000),
    // Read from the environment only: a repository token in a tracked config file is a token in git.
    token: typeof env.W2M_UPDATE_TOKEN === 'string' && env.W2M_UPDATE_TOKEN.trim() !== ''
      ? env.W2M_UPDATE_TOKEN.trim()
      : null,
    restartCommand: typeof config.autoUpdateRestartCommand === 'string' && config.autoUpdateRestartCommand.trim() !== ''
      ? config.autoUpdateRestartCommand.trim()
      : null,
    stateDir,
  };
}

/**
 * Normalize the update slot list, rejecting anything that is not `HH:mm:ss`.
 *
 * @param {unknown[]} times - Raw entries.
 * @returns {string[]} Ascending unique `HH:mm:ss` values.
 */
function normalizeUpdateTimes(times) {
  const out = [];
  for (const entry of times) {
    const value = typeof entry === 'string' ? entry.trim() : '';
    if (!/^\d{2}:\d{2}:\d{2}$/.test(value)) {
      throw new Error(`invalid time ${JSON.stringify(entry)}: expected HH:mm:ss`);
    }
    const [h, m, s] = value.split(':').map(Number);
    if (h > 23 || m > 59 || s > 59) {
      throw new Error(`invalid time ${JSON.stringify(entry)}: out of range`);
    }
    out.push(value);
  }
  const unique = [...new Set(out)].sort((a, b) => a.localeCompare(b));
  if (unique.length === 0) throw new Error('at least one time is required');
  return unique;
}

/**
 * Locate the DSH profile directory that contains this plugin.
 *
 * The updater installs into the profile, so it has to name it. Two facts make this reliable: the
 * plugin is loaded from `<profile>/node_modules/@twinsearth/w2m-dsh-plugin`, and the profile root is
 * the directory holding that `node_modules` plus a `package.json`. We walk up and verify rather than
 * string-slicing a fixed depth, because a pnpm layout can add a `.pnpm` segment.
 *
 * Returns `null` when no ancestor looks like a profile -- a checkout run directly from a clone has
 * none. The caller must treat that as "cannot self-update here" and say so, not guess a path and
 * write into it.
 *
 * @param {Record<string, unknown>} config - Raw plugin config; `profileDir` wins when set.
 * @returns {string|null} Absolute profile directory, or null.
 */
function resolveProfileDir(config) {
  return findProfileDir({
    explicit: config.profileDir,
    moduleUrl: import.meta.url,
  });
}

/**
 * Require the Rabbit URL, naming the setting when it is absent.
 *
 * With §7's shared-server default this can no longer be reached by "the operator set nothing" — an
 * unset `rabbitUrl` resolves to {@link SHARED_SERVER}. It stays as the last-resort guard so that a
 * future edit which clears the field fails with a sentence naming it instead of an `Invalid URL`
 * from somewhere deep in `fetch`.
 *
 * @param {{rabbitUrl: string|null}} cfg
 * @returns {string}
 */
function requireRabbit(cfg) {
  if (!cfg.rabbitUrl) {
    throw configError(
      'rabbitUrl',
      'resolved to nothing, so this tool has no Rabbit to talk to',
      'set `rabbitUrl` (or `W2M_RABBIT_URL`) to the Rabbit base URL, for example http://127.0.0.1:8787',
    );
  }
  return cfg.rabbitUrl;
}

// ---------------------------------------------------------------------------------------------
// v0.4.0: the direct path (P2P node, result inbox, direct offer push)
// ---------------------------------------------------------------------------------------------

/** Directory, under `stateDir`, where result frames that arrived over a direct channel are kept. */
const P2P_INBOX_DIR = 'p2p-inbox';

/** Upper bound on a file-name component taken from the wire. Long enough for a uuid, short enough. */
const P2P_INBOX_NAME_MAX = 128;

/**
 * Resolve the path of `device.json` the way both `w2m_run`'s origin identity and the direct path
 * need it.
 *
 * Two sources, in the order the rest of the plugin already uses: an explicit `stateDir` is the
 * operator pointing at a pairing, and `DSH_HOME` (via `deviceFilePath`) is the layout the agent
 * writes by default. Nothing is created and nothing is guessed: a machine that has never paired has
 * no identity, and that is a legal configuration in which the plugin simply dispatches over the
 * relay.
 *
 * @param {{stateDir: string|null}} cfg
 * @returns {string|null}
 */
function devicePathFor(cfg) {
  if (cfg.stateDir) return path.join(cfg.stateDir, 'device.json');
  try {
    return deviceFilePath({});
  } catch {
    // `DSH_HOME` is unset *and* the home directory cannot be resolved. There is no identity to find;
    // that is a fact about this process, not a fault worth failing a dispatch over.
    return null;
  }
}
/**
 * Read the local machine identity for the paths that need it, without ever throwing.
 *
 * {@link readDevice} answers from a `stateDir` and is the tool-facing reader; this one adds the
 * `DSH_HOME` fallback (an unset `stateDir` is the documented default layout, not an error) and turns
 * every failure into a `machine_id` of null plus an `error` — a machine whose identity cannot be read
 * must still be able to dispatch, because the relay path does not need an identity at all.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {Promise<{machine_id: string|null, machine_name: string|null, path: string|null, error: string|null}>}
 */
async function readLocalIdentity(cfg) {
  const file = devicePathFor(cfg);
  if (file === null) return { machine_id: null, machine_name: null, path: null, error: null };
  const device = await readDevice({ stateDir: path.dirname(file) });
  return {
    machine_id: device.machine_id,
    machine_name: device.machine_name,
    path: file,
    error: device.error,
  };
}

/**
 * Turn a wire value into one safe path component.
 *
 * `task_id` and `machine_id` arrive over a channel from another machine, and they are used to build
 * a *path*. `../` in either would be an arbitrary-file-write primitive handed to a peer, so anything
 * outside `[A-Za-z0-9._-]` is replaced, and the result is capped. Nothing is lost by that: the inbox
 * is read as a directory, never by reversing a file name, and the `task_id` inside the file is the
 * authoritative copy.
 *
 * @param {string} value
 * @returns {string}
 */
function safeFilePart(value) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, P2P_INBOX_NAME_MAX) || '_';
}

/**
 * Canonical JSON with sorted keys, so the digest of a frame is stable.
 *
 * Deliberately *not* the relay's own `jcs` (that would make this file depend on relay internals for
 * a two-line need). The digest here is only an integrity check of what this process stored, so the
 * rule is local by definition; the value that has to match another process byte for byte — the
 * dedupe key — is the one imported from the relay instead.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Does `frame` name both halves of the inbox key?
 *
 * A frame without a `task_id` or without a `machine_id` cannot be stored or acknowledged — the
 * acknowledgement is keyed by `task_id`, and two machines answering the same task must not overwrite
 * each other — so it is refused by name instead of being written somewhere surprising.
 *
 * Both halves of the refusal are returned: `reason` is the `CODE: sentence` string this has always
 * produced (it is what `w2m_status` shows), `reason_code` is the same code as a field, so a reader
 * that wants to branch on the refusal does not have to split a message.
 *
 * @param {object} frame
 * @returns {{reason_code: string, reason: string}|null} The reason it is unusable, or null.
 */
function inboxKeyProblem(frame) {
  const taskId = frame?.task_id;
  const machineId = frame?.machine_id;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    return {
      reason_code: REFUSAL_CODE.P2P_FRAME_NO_TASK_ID,
      reason: 'P2P_FRAME_NO_TASK_ID: `task_id` is missing or empty',
    };
  }
  if (typeof machineId !== 'string' || machineId.trim() === '') {
    return {
      reason_code: REFUSAL_CODE.P2P_FRAME_NO_MACHINE_ID,
      reason: 'P2P_FRAME_NO_MACHINE_ID: `machine_id` is missing or empty',
    };
  }
  return null;
}

/**
 * Write one file atomically, with 0600 where the platform honours it.
 *
 * A temporary file in the same directory plus a rename: a reader never sees a half-written result,
 * and a crash leaves the old file (or no file) rather than a truncated JSON document. The mode is
 * passed to `writeFile` rather than applied afterwards so the bytes are never readable to anyone
 * else even for an instant; on Windows/NTFS the bits are ignored and the `chmod` is skipped, which
 * is reported honestly by `mode_honoured` in `w2m_status` rather than pretended.
 *
 * @param {string} dir
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeFileAtomic(dir, file, text) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  if (process.platform !== 'win32') await fs.chmod(file, 0o600).catch(() => {});
}

/**
 * Count the stored result frames.
 *
 * Depth is read from the directory rather than tracked in memory, so it answers the question that
 * actually matters — "is there anything here I have not consumed" — across a plugin reload. A
 * missing directory is depth 0, not an error: the inbox exists only once something has arrived.
 *
 * @param {string|null} dir
 * @returns {Promise<number>}
 */
async function countInbox(dir) {
  if (dir === null) return 0;
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/**
 * Build a `P2PNode`'s transport out of this plugin's one HTTP path.
 *
 * The direct path must not grow a second way to talk to the relay: bearer-token resolution, the
 * base-URL joining that preserves a deployment sub-path, the timeout and the byte cap all live in
 * {@link request}, and these two adapters are the whole of the P2P node's transport. The token is
 * resolved per call rather than captured at startup, because a machine may pair *after* the plugin
 * was loaded and a captured `null` would leave the node permanently unauthenticated.
 *
 * Both adapters resolve for every HTTP status, which is the shape `P2PNode` expects: a refusal is an
 * answer (`{ok: false, status, json, error}`), and only a call that could not be made at all is an
 * `{ok: false, error}` from the catch.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {{postJson: Function, getJson: Function}}
 */
function createP2PTransport(cfg) {
  const call = async (method, pathname, body) => {
    let token = null;
    try {
      token = await resolveToken(cfg);
    } catch {
      // An unreadable device.json is reported by `w2m_status`, where the operator is looking for it.
      // Here it must not stop the rendezvous: the relay answers an unauthenticated announce with a
      // named 401, which the node records in `status.last_announce_error`.
      token = null;
    }
    try {
      const result = await request({
        rabbitUrl: requireRabbit(cfg),
        token,
        method,
        pathname,
        body,
        // Short: this is background signalling, and a hung announce must not outlive the node's own
        // refresh interval, which would stack announcements on top of each other.
        timeoutMs: 5_000,
        maxBytes: 64 * 1024,
      });
      return { ok: result.ok, status: result.status, json: result.json, error: result.error ?? null };
    } catch (error) {
      return { ok: false, status: null, json: null, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    postJson: (pathname, body) => call('POST', pathname, body),
    getJson: (pathname) => call('GET', pathname, undefined),
  };
}

/**
 * The `p2p` block a dispatch publishes through the relay, and what it is for.
 *
 * WHAT THE EXECUTOR CANNOT DO WITHOUT IT
 *
 * A dispatcher behind a symmetric NAT (CGNAT, in practice) can send all it likes and still be heard
 * by nobody: its outbound HELLO opens its own mapping, but the peer's filter stays shut until
 * *something of the peer's* has gone the other way. So the executor has to dial first — and to dial
 * it needs two things the offer itself can carry: where the dispatcher says it is, and which punch
 * to join. Without them the executor has only the relay lookup, which is a second opinion about the
 * same machine that answers 404 for a dispatcher whose announcement has just expired.
 *
 * WHY A PUNCH ID RATHER THAN A SESSION ID
 *
 * The session id cannot be known when this request is written: one dispatch leases one task to
 * several machines, and the relay decides which — in the same request that mints the task id. A
 * single session shared by those machines would be a defect, not a simplification: on the
 * dispatcher's own node the second machine's HELLO would look like a re-acknowledgement of the
 * first machine's live channel, so one of them would have its result delivered to the other's
 * address. The block therefore publishes a per-dispatch *punch id*, and both ends derive the same
 * per-machine session from it (`punchSession` in `src/agent/p2p.mjs`): the dispatcher from the
 * lease, the executor from the offer plus its own machine id. The pushed frame — which is addressed
 * to one machine, so the value *is* known — carries the derived `session` as well.
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
 * *executor's* key before it can push — and at dispatch time the relay has not yet said which
 * machines the task went to (`leases` come back in the same response that creates it). So the block
 * carries this machine's own key, which is known before the request is written, and
 * {@link offerP2PFor} adds the target's once the lease names it. Reading the field is therefore
 * "look up the machine you are about to talk to", never "assume the only entry is the peer" — a
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
  // byte-identical to v0.5.x for a machine that has no key — an additive change has to be absent to
  // be additive.
  const own = runtime?.encryption?.public_key;
  const machineId = runtime?.machineId;
  if (typeof own === 'string' && own !== '' && typeof machineId === 'string' && machineId !== '') {
    block.static_keys = { [machineId]: own };
  }
  return block;
}

/**
 * One machine's copy of the `p2p` block: everything published, plus the session for *this* machine.
 *
 * The added `session` is what makes the push and a reverse dial one punch rather than two: an
 * executor that received the offer over a channel may still have to dial back (the dispatcher closes
 * the channel it pushed over, immediately after the push), and a dial carrying a session the
 * dispatcher is not filtering for would be answered by its `accept()` at best — a second session,
 * a second channel, and two live sessions for one task where one would do.
 *
 * v0.6.0 adds the *target's* key to `static_keys` when the caller supplies one, which is the half of
 * the distribution the published block could not carry: the dispatcher learns the executor's key from
 * the relay's peer record and hands it over in the frame addressed to that machine.
 *
 * @param {unknown} published The block from {@link buildP2POfferBlock}, or whatever the caller sent.
 * @param {{taskId: string, machineId: string, peerKey?: string|null}} identity
 * @returns {object|null}
 */
function offerP2PFor(published, { taskId, machineId, peerKey = null }) {
  if (published === null || published === undefined) return null;
  if (typeof published !== 'object' || Array.isArray(published)) return null;
  const block = { ...published };
  const session = punchSession({ punch: block.punch, taskId, machineId });
  if (session !== null) block.session = session;
  if (typeof peerKey === 'string' && peerKey !== '') {
    const keys = block.static_keys !== null && typeof block.static_keys === 'object' ? { ...block.static_keys } : {};
    keys[machineId] = peerKey;
    block.static_keys = keys;
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
 * disagreed by one character would make the machine execute the task twice — once from each path —
 * so the dedupe key is computed with the relay's own {@link computeDedupeKey}/{@link computeCommandHash},
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
 * The session comes from the frame's own `p2p.session` — minted per machine by
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
  // a peer with no published key is dialled exactly as v0.5.x dialled it — plaintext, recorded, and
  // never a failure. That is §4's fallback clause applied to the push: a fleet must never lose a
  // machine to a security upgrade. It is not a silent downgrade, because the peer never offered a key
  // to downgrade *from*; a peer whose key we hold and whose handshake fails produces `ok: false` and
  // no channel at all.
  const dialOptions = session === undefined ? {} : { session };
  try {
    const dialled = await node.dial(frame.machine_id, dialOptions);
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
 * Push an offer for one task to every machine the relay leased it to.
 *
 * Called after the relay has created the task, so the relay's own SSE offer has already gone out:
 * this is an *additional* delivery over the faster path, and the relay's copy is what makes a failed
 * push harmless. Only leases in a runnable state are pushed — `refused` and `observing` machines
 * were never handed the command, and sending them an offer would be asking them to run work the
 * relay decided they must not run.
 *
 * v0.6.0: each target's static key is fetched from the relay's peer record before the push, which is
 * the one moment the dispatcher learns the key of a machine it did not already know. It is fetched
 * **here** rather than sourced from the stored `p2p` block because the block is written *before* the
 * relay decides which machines the task goes to — the offer that carries the key is the one addressed
 * to the machine that key belongs to. A missing key is not an error: the push proceeds and the
 * executor records `P2P_CRYPTO_NO_KEY` for its plaintext channel, which is the documented outcome for
 * a peer that never announced.
 *
 * @param {P2PNode} node
 * @param {object} options
 * @returns {Promise<Array<object>>} One entry per lease considered, in lease order. A machine that was
 *   not pushed to carries `ok: false` **and** a `reason_code` naming which gate refused it — this
 *   block is a tool result, so a bare boolean here would be exactly the reduction the verdicts refuse.
 */
async function pushOffers(node, { taskId, leases, payload, originMachineId, getJson = null }) {
  const out = [];
  for (const lease of leases) {
    const machineId = typeof lease?.machine_id === 'string' && lease.machine_id !== '' ? lease.machine_id : null;
    const state = lease?.state;
    if (machineId === null) {
      out.push({
        machine_id: null,
        ok: false,
        reason_code: REFUSAL_CODE.P2P_LEASE_NO_MACHINE_ID,
        error: 'the relay returned a lease with no machine_id',
      });
      continue;
    }
    if (state !== 'queued' && state !== 'offered') {
      out.push({
        machine_id: machineId,
        ok: false,
        reason_code: REFUSAL_CODE.P2P_LEASE_NOT_RUNNABLE,
        error: `lease state is ${JSON.stringify(state ?? null)}, so this machine was not handed the command`,
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
        reason_code: built.skipped.reason_code,
        error: built.skipped.message,
      });
      continue;
    }
    const result = await pushOffer(node, built.frame, { peerKey, peerKeys: node?.peerKeys ?? null });
    out.push({
      machine_id: machineId,
      ok: result.ok,
      reason_code: result.ok ? null : (result.reason_code ?? REFUSAL_CODE.P2P_DIAL_FAILED),
      error: result.error,
      dedupe_key: built.frame.dedupe_key === null ? null : 'relay-formula',
      // The session this push and the executor's reverse dial meet on, so a machine's own
      // `p2p.session` in the ledger can be matched to the dispatcher's attempt without reading two
      // logs side by side. `null` when there was nothing to punch over (a v0.4.x-shaped frame).
      session: result.session,
      // True when the executor's dial got there first and this push travelled over the channel that
      // dial opened — a two-way punch that worked, reported as such rather than as a plain push.
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
 * Build the object the tools reach the direct path through, and register its effect disposer.
 *
 * WHEN THE NODE STARTS, AND WHY IT IS NOT `apply()`
 *
 * The v0.4.0 contract says the node is "started in `apply()`". It is not, and this is the one place
 * this file departs from the contract's letter rather than its intent — reported as a deviation, not
 * settled quietly here. What *is* kept is everything the sentence is about: the direct path is owned
 * for the plugin's whole lifetime, it is disposed by a `ctx.effect` disposer, and a failure to start
 * is a field in `w2m_status` rather than an exception at load.
 *
 * The reason for the change is what "start" costs. Starting this node binds a UDP socket and kicks
 * off a STUN sweep against four servers — network traffic with a multi-second tail — for a machine
 * that may never dispatch a task in that session. `apply()` runs on every session in a host that
 * mounts this plugin, so an unconditional start is a rendezvous per session, and it puts traffic
 * into every test and every host whose runtime is deterministic about what it sends. `ensureStarted()`
 * therefore does the work the first time a tool actually needs the direct path: a dispatch
 * (`w2m_run`) or a question about it (`w2m_status`). A machine that never dispatches never punches,
 * which is also the more honest reading of §1 — "never dials" is the property that matters, and this
 * is closer to it than an announce nobody asked for.
 *
 * @param {object|null} ctx Cordis context; `ctx.effect` is used when present.
 * @param {ReturnType<typeof readConfig>} cfg
 * @param {object} [block] Test seam, and only that: `{ P2PNode?, bindUdpSocket?, discover?, tuning?,
 *   onNode? }`. The plugin's own composition is exercised end to end against a real relay by
 *   `test/p2p-plugin.test.mjs`, but two things a test cannot observe from outside are whether a
 *   *socket* was bound and the node's own event stream. Injecting the binder makes the first a
 *   measurement, and `onNode` hands the test the same object the tools use, so a `'message'` event is
 *   driven through the production handler rather than a re-implementation of it. Nothing in
 *   production reaches any of this.
 * @returns {object} The runtime handle; see the field comments in the body.
 */
function createP2PRuntime(ctx, cfg, block = {}) {
  const inboxDir = cfg.stateDir === null ? null : path.join(cfg.stateDir, P2P_INBOX_DIR);
  const runtime = {
    node: null,
    starting: null,
    start: null,
    error: null,
    reason: null,
    mode: cfg.p2pMode,
    machineId: null,
    devicePath: devicePathFor(cfg),
    identityError: null,
    inboxDir,
    events: {
      frames: 0,
      results: 0,
      refused: [],
      last_error: null,
      last_at: null,
      inbox_path: null,
      /** Whether the result files were created with 0600. Windows/NTFS ignores the bits. */
      mode_honoured: process.platform !== 'win32',
    },
    /** The most recent `w2m_run`'s direct pushes, or null when none has run in this process. */
    directPushes: null,
    /**
     * Start the node once, on first use, and hand every later caller the same promise.
     *
     * Assigned before the relay-mode early return so the tools can call it unconditionally: a caller
     * asks "is the direct path ready" and gets an answer either way, instead of having to know which
     * mode it is in — the defect this shape fixes was a `relay`-mode dispatch calling a method that did
     * not exist, which is a crash in the mode that is supposed to be the safe one.
     *
     * @type {() => Promise<object>}
     */
    ensureStarted: async () => ({ ok: true, enabled: false, error: null }),
  };

  if (cfg.p2pMode === 'relay') {
    runtime.reason = 'p2pMode is "relay", so no UDP socket is bound and the relay is the only path';
    return runtime;
  }

  /**
   * Start the node once, on first use, and return the same promise for every later caller.
   *
   * Idempotent by construction: `starting` is assigned before the first `await` inside it, so two
   * concurrent callers share one bind (the same rule `P2PNode.start()` itself follows, one level up).
   *
   * @returns {Promise<object>} The node's own `start()` result, or the reason there is no node.
   */
  runtime.ensureStarted = () => {
    if (runtime.starting !== null) return runtime.starting;
    runtime.starting = initP2P(ctx, cfg, runtime, block).catch((error) => {
      // The `P2PNode` constructor is the one thing in it that throws (a bad mode or tuning key is a
      // caller bug), so a failure here is a composition error in this file and is reported like any
      // other: `w2m_status` shows it, the relay path keeps working.
      runtime.error = error instanceof Error ? error.message : String(error);
      runtime.start = { ok: false, enabled: true, error: runtime.error };
      return runtime.start;
    });
    return runtime.starting;
  };

  return runtime;
}

/**
 * Read the dispatcher's own static keypair, or explain why there is none (v0.6.0).
 *
 * The key lives beside `device.json`, which is the one directory this plugin already knows how to
 * find (§ the note on `readDevice`): a `stateDir` when the operator set one, otherwise the
 * `DSH_HOME/xclient` default. Generating it here is the same "generated the first time a machine
 * pairs" rule the agent follows, and the two processes read the *same file*, so a machine that both
 * dispatches and executes has one identity on the direct path rather than two.
 *
 * Never throws. A caller cannot fix an unreadable key file from a tool call, and a dispatch that
 * refused because a *security upgrade* could not complete would be exactly the fleet-losing failure
 * §4 forbids — so the failure becomes a reason string, the node runs without a key, and every offer
 * this machine publishes is plainly labelled as having none.
 *
 * @param {object|null} injected Test seam: a `DeviceKey`, or null to use the file.
 * @param {string|null} deviceFile Absolute path of `device.json`, or null when unknown.
 * @returns {{key: object|null, error: string|null}}
 */
function loadDeviceKey(injected, deviceFile) {
  if (injected !== null && injected !== undefined) return { key: injected, error: null };
  if (typeof deviceFile !== 'string' || deviceFile === '') {
    return { key: null, error: 'P2P_CRYPTO_NO_KEY: device.json was not located, so device.key has no directory' };
  }
  try {
    const loaded = DeviceKey.load({ dir: path.dirname(deviceFile) });
    return { key: loaded.key, error: null };
  } catch (error) {
    return {
      key: null,
      error: `P2P_CRYPTO_KEY_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Read the identity, build the node, and start it.
 *
 * Split out of {@link createP2PRuntime} so the ownership and the work are two readable pieces: this
 * one is allowed to await, and its caller records whatever it throws.
 *
 * @param {object|null} ctx
 * @param {ReturnType<typeof readConfig>} cfg
 * @param {object} runtime
 * @param {object} block Test seam; see {@link createP2PRuntime}.
 * @returns {Promise<object>} The node's own `start()` result.
 */
async function initP2P(ctx, cfg, runtime, block) {
  const identity = await readLocalIdentity(cfg);
  runtime.machineId = identity.machine_id;
  runtime.identityError = identity.error;

  if (identity.machine_id === null) {
    runtime.reason = identity.path === null
      ? 'no stateDir is set and DSH_HOME could not be resolved, so device.json cannot be located'
      : `no readable device identity at ${identity.path}, so this machine has no id to announce or dial with`;
    runtime.start = { ok: false, enabled: true, error: `P2P_NO_IDENTITY: ${runtime.reason}` };
    return runtime.start;
  }

  // v0.6.0: the dispatcher's own static keypair, beside device.json. A failure here is *not* fatal
  // and must not stop the node: a machine with an unreadable key file is still a working W2M machine
  // whose tasks travel over the relay, which is the same rule every other crypto failure follows.
  // What it must not do is pretend: the key stays null, `runtime.encryption.reason` names the
  // failure, and every offer this machine publishes says no keys.
  const keyLoad = loadDeviceKey(block.deviceKey ?? null, identity.path);
  runtime.deviceKey = keyLoad.key;
  runtime.encryption = {
    enabled: keyLoad.key !== null,
    public_key: keyLoad.key === null ? null : keyLoad.key.publicKeyBase64,
    error: keyLoad.error,
  };

  const transport = createP2PTransport(cfg);
  // `ctx.effect` owns the node when the host provides it, and the fallback is the same ownership
  // with a shorter lifetime: a host that provides no effect (an older Cordis, or a bare test
  // context) gets the node and no disposer rather than no node.
  runtime.node = new (block.P2PNode ?? P2PNode)({
    mode: cfg.p2pMode,
    rabbitUrl: cfg.rabbitUrl,
    machineId: identity.machine_id,
    postJson: transport.postJson,
    getJson: transport.getJson,
    stunServers: cfg.stunServers,
    log: (line) => ctx?.logger?.info?.(`w2m ${line}`),
    ...(keyLoad.key === null ? {} : { deviceKey: keyLoad.key }),
    ...block,
  });

  // Attached before `start()`: `P2PNode.reportError` only emits when somebody is listening, and an
  // unlistened `'error'` event throws inside the runtime's own emit. A transport problem must stay a
  // recorded fact.
  runtime.node.on('error', (error) => {
    runtime.events.last_error = error instanceof Error ? error.message : String(error);
  });
  runtime.node.on('message', (event) => {
    void handleP2PMessage(runtime, event).catch((error) => {
      runtime.events.last_error = error instanceof Error ? error.message : String(error);
    });
  });
  // See the `block` note above: a test needs the node itself to drive a `'message'` event through
  // the handler above. Guarded so a malformed seam cannot take the node's start down with it.
  if (typeof block.onNode === 'function') {
    try {
      block.onNode(runtime.node);
    } catch {
      /* a test seam must never be why a node fails */
    }
  }

  /**
   * Ownership: one node, one effect, one disposer.
   *
   * Registered *here*, after the node exists, rather than in `createP2PRuntime` — an effect that owns
   * nothing is a disposer that releases nothing, and `relay` mode and a machine with no identity must
   * leave the host's effect list exactly as they found it. A host that provides no `ctx.effect` (an
   * older Cordis, or a bare test context) still gets a working node: the node itself is asked not to
   * hold the process open (`node.unref()`, below), so it cannot keep the process alive, and refusing
   * to start the direct path because the host cannot track a disposer would break the release's own
   * default.
   *
   * v0.5.10: `node.unref()` is a real call, not a description. Until it was added this comment
   * claimed an `unref()` that existed nowhere in the plugin or the node — the socket went on holding
   * the event loop, so a host without `ctx.effect` that started a node never exited (found by an
   * independent verifier against the `w2m_status` test's bare context).
   */
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      // `close()` is documented not to throw and to return a promise, but the whole point of this
      // disposer is that it runs on the way out of a plugin that may be half-built: a node whose bind
      // failed has no socket to close. Both the call and the promise are optional so a teardown can
      // never itself become the failure.
      runtime.node?.close?.()?.catch((error) => {
        runtime.events.last_error = error instanceof Error ? error.message : String(error);
      });
    });
  } else {
    // No disposer will ever be called by the host, so the node must not be the reason the process
    // stays up. Called before `start()`: the node remembers it and unrefs the socket it binds, which
    // is the only ordering that leaves no window where the loop is held open.
    runtime.node?.unref?.();
  }

  // eslint-disable-next-line require-atomic-updates -- single-entry: `ensureStarted` assigns `starting` before this runs
  runtime.start = await runtime.node.start();
  if (runtime.start.ok !== true) runtime.error = runtime.start.error ?? 'P2P_START_FAILED';
  return runtime.start;
}

/**
 * Store one JSON frame that arrived over a direct channel, and acknowledge it.
 *
 * The writer is deliberately strict. A frame that is not a JSON object, or that names no
 * `task_id`/`machine_id`, is refused and **nothing** is written — an inbox file is the only durable
 * trace of a peer's result, and a file whose name does not identify its contents is worse than no
 * file, because the next reader cannot tell a partial result from a complete one.
 *
 * `task.result` is the frame this exists for; `result.ack` and anything else a peer might send are
 * counted and ignored rather than treated as faults. The acknowledgement goes back on the same
 * channel the frame arrived on, and a failed acknowledgement is recorded — the sender retries (the
 * channel is reliable) and the file is already on disk, so a lost ack must not lose the result.
 *
 * @param {object} runtime
 * @param {{payload: Buffer|string, channel: object|null, peer: object|null, session: number}} event
 * @returns {Promise<void>}
 */
async function handleP2PMessage(runtime, event) {
  runtime.events.frames += 1;
  runtime.events.last_at = new Date().toISOString();

  const raw = Buffer.isBuffer(event?.payload) ? event.payload.toString('utf8') : String(event?.payload ?? '');
  let frame = null;
  try {
    frame = JSON.parse(raw);
  } catch {
    runtime.events.refused.push({
      reason_code: REFUSAL_CODE.P2P_FRAME_NOT_JSON,
      reason: 'P2P_FRAME_NOT_JSON: the payload is not a JSON document',
      bytes: raw.length,
    });
    return;
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    runtime.events.refused.push({
      reason_code: REFUSAL_CODE.P2P_FRAME_NOT_AN_OBJECT,
      reason: 'P2P_FRAME_NOT_AN_OBJECT: expected a JSON object',
      type: typeof frame,
    });
    return;
  }
  if (frame.type !== 'task.result') {
    // Not an error: a peer's `result.ack` for an offer *this* plugin pushed arrives the same way, and
    // the channel is the transport, not a promise about the only frame that will ever cross it.
    return;
  }

  const problem = inboxKeyProblem(frame);
  if (problem !== null) {
    // `reason_code` travels beside `reason` so `w2m_status`'s inbox block is greppable by code rather
    // than by string prefix; this is a refusal at a boundary a user reads.
    runtime.events.refused.push({ reason_code: problem.reason_code, reason: problem.reason, type: 'task.result' });
    return;
  }
  if (runtime.inboxDir === null) {
    runtime.events.refused.push({
      reason_code: REFUSAL_CODE.P2P_NO_STATE_DIR,
      reason: 'P2P_NO_STATE_DIR: stateDir is not set, so a received result has nowhere to be written',
      type: 'task.result',
      task_id: frame.task_id,
    });
    return;
  }

  const stored = {
    received_at: new Date().toISOString(),
    transport: 'p2p',
    from_machine_id: frame.machine_id,
    task_id: frame.task_id,
    frame,
    // A digest of the stored copy, so a reader can tell "the file changed under me" from "the peer
    // sent something else". Not a signature — the channel is not authenticated at this layer.
    frame_sha256: createHash('sha256').update(canonicalJson(frame)).digest('hex'),
  };
  const file = path.join(
    runtime.inboxDir,
    `${safeFilePart(frame.task_id)}__${safeFilePart(frame.machine_id)}.json`,
  );

  try {
    await writeFileAtomic(runtime.inboxDir, file, `${JSON.stringify(stored, null, 2)}\n`);
  } catch (error) {
    // eslint-disable-next-line require-atomic-updates -- one message at a time; the write is the only await
    runtime.events.last_error = `P2P_INBOX_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`;
    runtime.events.refused.push({
      reason_code: REFUSAL_CODE.P2P_INBOX_WRITE_FAILED,
      reason: runtime.events.last_error,
      type: 'task.result',
      task_id: frame.task_id,
    });
    return;
  }
  runtime.events.results += 1;
  runtime.events.inbox_path = file;

  const channel = event?.channel ?? null;
  if (channel && typeof channel.send === 'function') {
    try {
      await channel.send(JSON.stringify({ type: 'result.ack', task_id: frame.task_id }));
    } catch (error) {
      // eslint-disable-next-line require-atomic-updates -- the channel is per-frame and the ack is the last await
      runtime.events.last_error = `P2P_ACK_FAILED: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/**
 * The `p2p` block `w2m_status` reports.
 *
 * Every field is present on every call, including when the direct path is off: a reader must be able
 * to tell "relay mode" from "p2p was requested and could not start" without comparing two calls.
 * `null` is used for "never measured", never 0 — the same rule the rest of this file follows for RTT.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @param {object} runtime
 * @param {number|null} peersAnnounced Live announcements the relay holds, read from the `/healthz`
 *   answer this tool already fetched. Passed in rather than probed here: a second probe of the same
 *   endpoint for one line of a diagnostic block would double the tool's traffic and could report a
 *   different number than the block above it.
 * @returns {Promise<object>}
 */
async function readP2PStatus(cfg, runtime, peersAnnounced = null) {
  const status = runtime.node === null ? null : runtime.node.status;
  const inboxDepth = runtime.inboxDir === null ? 0 : await countInbox(runtime.inboxDir);

  return {
    mode: status?.mode ?? cfg.p2pMode,
    // "Requested and possible": the mode is not `relay` and a node exists to be asked about.
    enabled: status !== null,
    running: status?.running === true,
    machine_id: runtime.machineId,
    device_json: runtime.devicePath,
    device_error: runtime.identityError,
    local: status?.local ?? null,
    rabbit_url: status?.rabbit_url ?? cfg.rabbitUrl,
    // How many machines the relay holds a live announcement for. `w2m_devices` says which machines
    // paired; this says which of them can be punched at, and the two differ constantly.
    peers_announced: peersAnnounced,
    mapping: status?.mapping ?? null,
    reflexive: status?.reflexive ?? null,
    candidates: Array.isArray(status?.candidates) ? status.candidates : [],
    candidate_count: Array.isArray(status?.candidates) ? status.candidates.length : 0,
    announced_at: status?.announced_at ?? null,
    announce_ok: status?.announce_ok ?? false,
    announce_failures: status?.announce_failures ?? 0,
    last_announce_error: status?.last_announce_error ?? null,
    punches_out: status?.punches_out ?? 0,
    punches_in: status?.punches_in ?? 0,
    dial_failures: status?.dial_failures ?? 0,
    transport: p2pTransportFacts(runtime.node),
    // v0.6.0: the crypto facts, named one by one rather than mirrored wholesale. `enabled` is about
    // *this* machine's key; `encrypted_channels` and `plaintext_channels` are about the channels it
    // has actually made, and they can both be non-zero on a mixed fleet. `error` is the reason there
    // is no key when there is none — a reader has to be able to tell "this build has no crypto" from
    // "the key file is unreadable" without reading a log.
    encryption: {
      enabled: runtime.encryption?.enabled === true,
      public_key: runtime.encryption?.public_key ?? null,
      error: runtime.encryption?.error ?? null,
      peers_known: status?.encryption?.peers_known ?? 0,
      handshakes: status?.encryption?.handshakes ?? 0,
      encrypted_channels: status?.encryption?.encrypted_channels ?? 0,
      plaintext_channels: status?.encryption?.plaintext_channels ?? 0,
      refused: status?.encryption?.refused ?? 0,
      refusals: Array.isArray(status?.encryption?.refusals) ? status.encryption.refusals : [],
    },
    inbox: {
      dir: runtime.inboxDir,
      depth: inboxDepth,
      received: runtime.events.results,
      frames: runtime.events.frames,
      refused: runtime.events.refused.slice(-8),
      last_at: runtime.events.last_at ?? null,
      last_path: runtime.events.inbox_path,
      mode_honoured: runtime.events.mode_honoured,
    },
    last_error: runtime.error ?? runtime.events.last_error ?? status?.last_error ?? null,
    reason: runtime.reason,
    // Whether the node has been started in this process yet. `running` alone cannot say: a node that
    // has not been asked to start and a node that failed to start both report `false`.
    started: runtime.start !== null,
  };
}

/**
 * Type facts about the direct path: whether the UDP socket is actually held.
 *
 * Stated as a fact rather than inferred from `running`, because binding a socket and *keeping* one
 * are different claims: this reads the live socket object, so "no socket" cannot be reported as
 * "fine, no UDP port was taken" by accident.
 *
 * @param {P2PNode|null} node
 * @returns {object}
 */
function p2pTransportFacts(node) {
  const socket = node?.socket ?? null;
  if (socket === null) return { socket_bound: false, family: null, address: null };
  let bound = null;
  try {
    bound = socket.address();
  } catch {
    bound = null;
  }
  return {
    socket_bound: true,
    family: bound?.family ?? null,
    address: bound === null ? null : { address: bound.address, port: bound.port },
  };
}

/**
 * Require the state directory, naming the setting when it is absent.
 *
 * Used by the paths that genuinely cannot work without a `device.json - see {@link resolveToken},
 * which is the only caller, and which explains why an unset `stateDir` is not an error there.
 *
 * @param {{stateDir: string|null}} cfg
 * @returns {string}
 */
function requireStateDir(cfg) {
  if (!cfg.stateDir) {
    throw configError(
      'stateDir',
      'is not set, so device.json cannot be located',
      'set `stateDir` to the directory holding device.json (the agent writes it there after pairing)',
    );
  }
  return cfg.stateDir;
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
// Base URL and endpoint joining (PROTOCOL-v0.1.2 §2)
// ---------------------------------------------------------------------------------------------

/**
 * Validate a `rabbitUrl` and reduce it to a base address, as a plugin-shaped error.
 *
 * The rule itself lives in `../agent/url.mjs` (imported above) so both sides cannot drift. This
 * wrapper exists only to translate its `TypeError` into the `W2M_CONFIG` error every other
 * configuration fault in this file uses, whose message names the setting **and** what to d - the
 * caller is a model reading tool output, not a developer reading a stack trace.
 *
 * @param {unknown} raw
 * @returns {string} Base with every trailing slash removed.
 */
function checkedRabbitBase(raw) {
  try {
    return resolveBaseUrl(String(raw ?? ''));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The shared validator reports a bad scheme as "got ftp://"; naming a "scheme" is friendlier to
    // whoever has to act on it, so the plugin-shaped message says the word.
    const scheme = /got\s+([a-z][a-z0-9+.-]*:)/i.exec(reason);
    const why = scheme
      ? `uses scheme \`${scheme[1]}\`, which is not supported (only http and https are)`
      : `is not usable as a base addres - ${reason}`;
    throw configError(
      'rabbitUrl',
      why,
      'set `rabbitUrl` to the relay base address, for example http://127.0.0.1:8787, ' +
        'http://100.64.0.5:8787, or https://w2m.example.com/w2m (a deployment sub-path is allowed; ' +
        'a query string or fragment is not)',
    );
  }
}

/**
 * Build a `URL` from a joined string, for `fetch`.
 *
 * The joining already produced an absolute URL; this only gives `fetch` the object it prefers, and
 * turns "not absolute after all" into a named configuration error instead of `Invalid URL`.
 *
 * @param {string} url
 * @returns {URL}
 */
function toRequestUrl(url) {
  try {
    return new URL(url);
  } catch (error) {
    throw new W2MError('W2M_CONFIG', `W2M_CONFIG: the joined endpoint \`${url}\` is not an absolute URL (${error instanceof Error ? error.message : String(error)})`, {
      hint: 'set `rabbitUrl` to an absolute base such as https://w2m.example.com/w2m',
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Agent RTT (PROTOCOL-v0.1.2 §8.2)
// ---------------------------------------------------------------------------------------------

/**
 * A status getter reachable from this process, when the plugin started relay+agent itself.
 *
 * Set by {@link startLocalStack}. Null in the normal case, where the agent runs as its own process
 * and its state is not reachable from here at al - see {@link readRtt}.
 *
 * @type {(() => object)|null}
 */
let inProcessAgentStatus = null;

/**
 * File names an agent may publish its state under, most specific first.
 *
 * The `localside/` entry is not decoration: `stateDir` here is documented as the
 * directory holding `device.json`, and `w2m-localside` keeps its own state one
 * level below it (`<DSH_HOME>/xclient/localside`, see `resolveStateDir(_, 'localside')`).
 * Without this entry the default CLI layout could never be read, and RTT would
 * silently stay unavailable in exactly the cross-region deployment it is for.
 */
const AGENT_STATE_FILES = ['agent-state.json', 'agent.json', 'localside-state.json', path.join('localside', 'agent-state.json')];

/**
 * Normalise whatever the agent published into `{last, avg, samples}`.
 *
 * Tolerant on purpose: this is a cross-process, cross-version boundary, and a reader that demanded
 * one exact spelling would report "no RTT" for a perfectly healthy agent. Field aliases cover the
 * obvious spellings; an array is read as the rolling samples; a bare number is read as the last.
 *
 * @param {unknown} rtt
 * @returns {{last: number|null, avg: number|null, samples: number[]}|null}
 */
function normaliseRtt(rtt) {
  if (rtt === null || rtt === undefined) return null;

  if (typeof rtt === 'number' && Number.isFinite(rtt)) {
    return { last: rtt, avg: rtt, samples: [rtt] };
  }

  if (Array.isArray(rtt)) {
    const samples = rtt.filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (samples.length === 0) return null;
    return { last: samples[samples.length - 1], avg: round(samples.reduce((a, b) => a + b, 0) / samples.length), samples };
  }

  if (typeof rtt !== 'object') return null;

  const pick = (...keys) => {
    for (const key of keys) {
      const value = rtt[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };
  const rawSamples = Array.isArray(rtt.samples)
    ? rtt.samples.filter((value) => typeof value === 'number' && Number.isFinite(value))
    : [];

  const last = pick('last', 'lastMs', 'last_ms', 'current');
  const avg = pick('avg', 'average', 'mean');
  if (last === null && avg === null && rawSamples.length === 0) return null;

  const samples = rawSamples.length > 0 ? rawSamples : [last ?? avg];
  return { last: last ?? samples[samples.length - 1], avg: avg ?? round(samples.reduce((a, b) => a + b, 0) / samples.length), samples };
}

/**
 * Round to one decimal: RTT is a diagnostic, and false precision invites false conclusions.
 *
 * @param {number} value
 * @returns {number}
 */
function round(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Read the local agent's round-trip time, or explain why it is unavailable (§8.2).
 *
 * §8.2 puts `rttMs` on the agent's in-memory state. When the plugin started the agent inside this
 * process, that state is reachable directly. When the agent is its own proces - the normal
 * deploymen - it is not, so this also looks for a state file under `stateDir`. Neither source
 * being present is reported as `available: false` with a reason, never as an error: cross-region
 * diagnosis fails loudly, but this tool must still answer when the agent has not been started.
 *
 * @param {{stateDir: string|null}} cfg
 * @returns {Promise<{available: boolean, source: string|null, last: number|null, avg: number|null,
 *                    samples: number[], ms: number|null, reason: string|null, path: string|null}>}
 */
async function readRtt(cfg) {
  const empty = {
    available: false,
    source: null,
    last: null,
    avg: null,
    samples: [],
    ms: null,
    reason: null,
    path: null,
  };

  if (inProcessAgentStatus) {
    try {
      const status = inProcessAgentStatus();
      const rtt = normaliseRtt(status?.rttMs ?? status?.rtt ?? null);
      if (rtt) return { ...empty, ...rtt, available: true, source: 'in-process-agent' };
      return { ...empty, source: 'in-process-agent', reason: 'the in-process agent has not recorded a round trip yet' };
    } catch (error) {
      return {
        ...empty,
        source: 'in-process-agent',
        reason: `the in-process agent status getter threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!cfg.stateDir) {
    return { ...empty, reason: 'stateDir is not set, so no agent state could be located' };
  }

  for (const name of AGENT_STATE_FILES) {
    const file = path.join(cfg.stateDir, name);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      const rtt = normaliseRtt(parsed?.rttMs ?? parsed?.rtt ?? null);
      if (rtt) return { ...empty, ...rtt, available: true, source: 'state-file', path: file };
    } catch {
      continue;
    }
  }

  return {
    ...empty,
    reason:
      'no agent round-trip time is available: the agent is not running in this process and no ' +
      `agent state file was found under ${cfg.stateDir}`,
  };
}


/**
 * Read a response body, refusing to buffer more than `maxBytes`.
 *
 * A body with no stream falls back to `arrayBuffer()`, which keeps the function usable with bare
 * response-like stubs.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new W2MError('W2M_TOO_LARGE', `W2M_TOO_LARGE: the Rabbit answered with ${declared} bytes, above the ${maxBytes}-byte cap`, {
      hint: 'ask for a narrower range (for example a smaller `limit` or `format: json`), or read the report from the Rabbit directly',
    });
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new W2MError('W2M_TOO_LARGE', `W2M_TOO_LARGE: the Rabbit answered with ${buffer.byteLength} bytes, above the ${maxBytes}-byte cap`);
    }
    return buffer.toString('utf8');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        size += value.byteLength;
        if (size > maxBytes) {
          throw new W2MError('W2M_TOO_LARGE', `W2M_TOO_LARGE: the Rabbit's answer passed the ${maxBytes}-byte cap and was stopped`, {
            hint: 'ask for a narrower range, or read the report from the Rabbit directly',
          });
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A reader that cannot be cancelled is not a reason to lose the result we already have.
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse the protocol's error shape: `{ error: { code, message, detail } }` (PROTOCOL §7).
 *
 * @param {string} text
 * @returns {{code: string, message: string, detail: unknown}|null}
 */
function parseErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      return { code: error.code, message: String(error.message ?? ''), detail: error.detail };
    }
  } catch {
    // Not JSON, or not our shape; fall through to the generic message.
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/**
 * Perform one request against the Rabbit.
 *
 * Resolves for every HTTP status, including 4xx and 5xx: the Rabbit's refusals are answers, and
 * the code table in PROTOCOL §7 is part of the protocol, not an exceptional path. Rejects only
 * when the call could not be made at all (transport, abort, size cap).
 *
 * @param {{rabbitUrl: string, token?: string|null, signal?: AbortSignal, timeoutMs?: number,
 *          method?: string, pathname: string, query?: object, body?: unknown,
 *          maxBytes?: number, accept?: string}} options
 * @returns {Promise<{status: number, ok: boolean, text: string, json: object|null, error: object|null}>}
 */
async function request(options) {
  const {
    rabbitUrl,
    token = null,
    signal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    method = 'GET',
    pathname,
    query,
    body,
    maxBytes = MAX_RESPONSE_BYTES,
    accept = 'application/json',
  } = options;

  throwIfAborted(signal);

  // Named here rather than left to `new URL`, whose failure would say only "Invalid URL" and send
  // the reader looking in the wrong place.
  if (typeof rabbitUrl !== 'string' || rabbitUrl === '') {
    throw new W2MError('W2M_CONFIG', 'W2M_CONFIG: no Rabbit URL was available for this call', {
      hint: 'set `rabbitUrl` in this plugin\'s profile patch, for example http://127.0.0.1:8787',
    });
  }

  // §2: base + path, joined by hand. `new URL(pathname, base)` would resolve against the origin
  // and drop a deployment sub-path (`https://h/w2m` + `/v1/task` 鈫?`https://h/v1/task` 鈫?404).
  const target = toRequestUrl(joinUrl(rabbitUrl, pathname));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }

  const headers = { accept };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error('timeout')), timeoutMs);
  const combined = combineSignals(signal, timeoutController.signal);

  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined.signal,
    });
  } catch (error) {
    const aborted = isAbort(error, combined.signal);
    throw new W2MError(
      aborted ? 'W2M_ABORTED' : 'W2M_UNREACHABLE',
      aborted
        ? `W2M_ABORTED: the call to ${endpointOf(target)} was cancelled after ${timeoutMs} ms or by the caller`
        : `W2M_UNREACHABLE: could not reach the Rabbit at ${endpointOf(target)}: ${error instanceof Error ? error.message : String(error)}`,
      {
        hint: 'check that the Rabbit is running and that `rabbitUrl` points at it (w2m_status probes it)',
        cause: error,
      },
    );
  } finally {
    clearTimeout(timer);
    combined.dispose();
  }

  const text = await readBody(response, maxBytes);
  const contentType = response.headers?.get?.('content-type') ?? '';
  let json = null;
  if (text.trim() !== '' && (contentType.includes('json') || /^[[{]/.test(text.trim()))) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  const error = response.ok ? null : parseErrorBody(text);
  if (!error && !response.ok) {
    return {
      status: response.status,
      ok: false,
      text,
      json,
      error: { code: 'HTTP_ERROR', message: text.trim().slice(0, 400) || `HTTP ${response.status}`, detail: null },
    };
  }

  return { status: response.status, ok: response.ok, text, json, error };
}

/**
 * Render a URL for a message, without its query string, so nothing sensitive is echoed back.
 *
 * @param {URL} target
 * @returns {string}
 */
function endpointOf(target) {
  return `${target.origin}${target.pathname}`;
}

/**
 * Resolve the bearer token for the Rabbit calls.
 *
 * Two sources, and the distinction is the point. An explicit `stateDir` is the operator pointing at
 * a pairing, so a missing or unreadable `device.json` there is **named as the fault** rather than
 * being turned into a mystery `401`. With no `stateDir`, this machine's own identity lives where the
 * agent writes it by default — `$DSH_HOME/xclient/device.json`, the same file {@link readLocalIdentity}
 * reads — and the calls go out with it. v0.4.0 made that fallback load-bearing rather than optional:
 * every P2P announcement is authenticated as the announcing device, so a machine whose identity was
 * only reachable through `DSH_HOME` would have had a permanently unauthenticated rendezvous and a
 * direct path that never worked, while the relay path kept working and hid the reason.
 *
 * A machine with no identity at all still answers `null`: the calls go out unauthenticated, a `401`
 * is reported as a refusal, and that is the accurate account of what happened.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {Promise<string|null>}
 */
async function resolveToken(cfg) {
  if (cfg.stateDir) return requireToken(await readDevice({ stateDir: requireStateDir(cfg) }));
  const file = devicePathFor(cfg);
  if (file === null) return null;
  const device = await readDevice({ stateDir: path.dirname(file) });
  return device.present ? requireToken(device) : null;
}

// ---------------------------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------------------------

/**
 * Read `device.json` from the state directory (PROTOCOL §2.1).
 *
 * @param {{stateDir: string|null}} cfg
 * @returns {Promise<{machine_id: string|null, machine_name: string|null, device_token: string|null,
 *                    rabbit_url: string|null, path: string|null, present: boolean, error: string|null}>}
 */
async function readDevice(cfg) {
  const empty = {
    machine_id: null,
    machine_name: null,
    device_token: null,
    rabbit_url: null,
    path: null,
    present: false,
    error: null,
  };
  if (!cfg.stateDir) return empty;

  const file = path.join(cfg.stateDir, 'device.json');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ...empty, path: file };
    return { ...empty, path: file, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      machine_id: typeof parsed?.machine_id === 'string' ? parsed.machine_id : null,
      machine_name: typeof parsed?.machine_name === 'string' ? parsed.machine_name : null,
      device_token: typeof parsed?.device_token === 'string' && parsed.device_token !== '' ? parsed.device_token : null,
      rabbit_url: typeof parsed?.rabbit_url === 'string' ? parsed.rabbit_url : null,
      path: file,
      present: true,
      error: null,
    };
  } catch (error) {
    return { ...empty, path: file, present: true, error: `device.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Require a `device_token`, naming where it was looked for when it is absent.
 *
 * The `code` stays `W2M_NO_TOKEN` for every case — one class, "this machine cannot authenticate" —
 * while `reason_code` names which of the three it is, because the three have different remedies: pair
 * the agent, repair the file, or finish a pairing that never completed.
 *
 * @param {{machine_id: string|null, device_token: string|null, path: string|null, present: boolean, error: string|null}} device
 * @returns {string}
 */
function requireToken(device) {
  if (device.device_token) return device.device_token;
  if (!device.present) {
    throw new W2MError(
      'W2M_NO_TOKEN',
      `W2M_NO_TOKEN: no paired device at \`${device.path ?? 'device.json'}\` - the file does not exist; ` +
        'start the agent once so it can pair, or set `stateDir` to the directory holding an already-paired device.json',
      {
        hint: 'start the agent once so it can pair, or set `stateDir` to the directory holding an already-paired device.json',
        reason_code: REFUSAL_CODE.DEVICE_NOT_PAIRED,
      },
    );
  }
  if (device.error) {
    throw new W2MError(
      'W2M_NO_TOKEN',
      `W2M_NO_TOKEN: could not read a device token from \`${device.path}\` - ${device.error}; repair or delete the file and pair again`,
      { hint: 'repair or delete the file and pair again', reason_code: REFUSAL_CODE.DEVICE_UNREADABLE },
    );
  }
  throw new W2MError(
    'W2M_NO_TOKEN',
    `W2M_NO_TOKEN: \`${device.path}\` has no \`device_token\` - the device has not completed POST /v1/pair yet; run the agent once to pair it`,
    { hint: 'the device has not completed POST /v1/pair yet; run the agent once to pair it', reason_code: REFUSAL_CODE.DEVICE_TOKEN_ABSENT },
  );
}

// ---------------------------------------------------------------------------------------------
// git anchors
// ---------------------------------------------------------------------------------------------

/**
 * Run `git` and return its exit code and output, never throwing for a non-zero exit.
 *
 * @param {string[]} argv Arguments after the executable.
 * @param {{cwd?: string, env?: object, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runGit(argv, options = {}) {
  const { cwd, env, timeoutMs = 10_000 } = options;
  return new Promise((resolve) => {
    execFile(
      process.env.W2M_GIT || 'git',
      argv,
      { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? (error && error.message ? error.message : ''),
        });
      },
    );
  });
}

/**
 * Resolve the project's three anchors' worth of git state.
 *
 * `base_commit` is `HEAD`. `base_tree` is the tree of the **working tree as it stands**, which is
 * what a peer's `pre_tree_fingerprint` can actually be equal t - the tree of `HEAD` would report
 * every uncommitted change as an anchor mismatch. It is computed the way PROTOCOL §5.1 names the
 * algorithm, `git-temp-index-tree/v1`, so this machine's answer and a peer's are comparable.
 *
 * @param {{projectDir: string, timeoutMs?: number}} options
 * @returns {Promise<{base_commit: string|null, base_tree: string|null, dirty: boolean|null,
 *                    branch: string|null, head_commit: string|null, error: string|null}>}
 */
async function resolveGitAnchors(options) {
  const { projectDir, timeoutMs = 10_000 } = options;
  const result = { base_commit: null, base_tree: null, dirty: null, branch: null, head_commit: null, error: null };

  const inRepo = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, timeoutMs });
  if (inRepo.code !== 0 || inRepo.stdout.trim() !== 'true') {
    result.error = inRepo.code !== 0
      ? `\`${projectDir}\` is not a git work tree (${(inRepo.stderr.trim() || 'no diagnostic').slice(0, 200)})`
      : 'not a git work tree';
    return result;
  }

  const head = await runGit(['rev-parse', 'HEAD'], { cwd: projectDir, timeoutMs });
  if (head.code === 0) {
    result.base_commit = head.stdout.trim();
    result.head_commit = result.base_commit;
  } else {
    result.error = (head.stderr.trim() || 'HEAD could not be resolved').slice(0, 200);
  }

  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir, timeoutMs });
  if (branch.code === 0) result.branch = branch.stdout.trim();

  const status = await runGit(['status', '--porcelain'], { cwd: projectDir, timeoutMs });
  if (status.code === 0) result.dirty = status.stdout.trim() !== '';

  const tree = await resolveTreeFingerprint(projectDir, timeoutMs);
  result.base_tree = tree.value;
  if (!tree.value && !result.error) result.error = tree.error;

  return result;
}

/**
 * `git-temp-index-tree/v1`: hash the working tree through a throwaway index.
 *
 * A temporary `GIT_INDEX_FILE` means the real index is never touched, so asking for the anchor
 * cannot itself dirty the repository we are about to measure.
 *
 * @param {string} projectDir
 * @param {number} timeoutMs
 * @returns {Promise<{value: string|null, error: string|null}>}
 */
async function resolveTreeFingerprint(projectDir, timeoutMs) {
  // mkdtemp rather than a name in the project: nothing is left behind if we are killed.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-index-'));
  const indexPath = path.join(scratch, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    const added = await runGit(['add', '-A', '--', '.'], { cwd: projectDir, env, timeoutMs });
    if (added.code !== 0) {
      return { value: null, error: `git add for the tree fingerprint failed: ${(added.stderr.trim() || 'no diagnostic').slice(0, 200)}` };
    }
    const written = await runGit(['write-tree'], { cwd: projectDir, env, timeoutMs });
    if (written.code !== 0) {
      return { value: null, error: `git write-tree failed: ${(written.stderr.trim() || 'no diagnostic').slice(0, 200)}` };
    }
    return { value: written.stdout.trim() || null, error: null };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
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
 * against **this** process's environment — the dispatcher's PATH — which is a real limit of a
 * pre-flight (the executing machine's PATH is the one that will decide), and the reason the refusal
 * that matters is the agent's own.
 *
 * A refusal names itself: `reason_code` is the matcher's own code (so the two ends cannot report one
 * refusal under two spellings) and `detail` says what would change it. The two ways this control
 * refuses are kept apart — a command outside the list and a list that cannot be parsed have
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
  return `${buffer.subarray(0, MAX_EXCERPT_BYTES).toString('utf8')}\n - truncated at ${MAX_EXCERPT_BYTES} bytes]`;
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
  // `COMPARABLE_FIELDS` because **a path is not a result** — two byte-identical runs on two machines
  // must stay `consistent` when one of them punched a hole and the other used the relay.
  'transport', 'p2p',
]);

/**
 * Every aggregate status this plugin will accept as a verdict.
 *
 * The first six are §6.3's states. `pending` and `refused` are not verdicts on consistency, but the
 * Rabbit emits them for a task that has no verdict yet and for a task every machine refused, so
 * they are recognise - otherwise the one state that means "keep waiting" would be reported as an
 * unknown.
 *
 * `timeout`, `cancelled` and `degraded` are v0.3.0's additions, and each replaces a case that used
 * to be reported as something less true:
 *
 *   timeout    previously `pending` forever, so a task nobody was ever going to answer looked
 *              identical to one still in flight.
 *   cancelled  previously indistinguishable from `failed`, which reports a deliberate stop as a
 *              malfunction.
 *   degraded   previously `partial`, which also means "machines are still out".
 */
const AGGREGATE_STATES = new Set([
  'consistent', 'divergent', 'divergent-platform', 'partial', 'failed', 'unverifiable',
  'timeout', 'cancelled', 'degraded',
  'pending', 'refused',
]);

/**
 * Aggregate statuses that are not a verdict: the task may still move.
 *
 * `refused` is deliberately absent. It reads like "still deciding", but every machine has answered
 * and none will run the work, so waiting cannot change i - treating it as non-terminal made
 * `w2m_wait` poll a finished task until its window elapsed.
 */
const NON_TERMINAL_AGGREGATE = new Set(['pending']);

/** Per-machine `outcome` values that mean the machine is still working. */
const NON_TERMINAL_OUTCOME = new Set(['pending', null, undefined]);

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

// ---------------------------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------------------------

/**
 * Build the short cross-region hints `w2m_status` returns alongside its data.
 *
 * These are the three questions §4 says an operator asks firs - is the relay there, has it
 * restarted, do I have the credential it want - answered in one place so a model does not have to
 * compare fields itself. v0.4.0 adds the fourth: **which** relay this machine is talking to, and
 * which path it expects a task to take.
 *
 * @param {object} relay The relay block built by `w2m_status`.
 * @param {object} rtt The block from {@link readRtt}.
 * @param {ReturnType<typeof readConfig>} cfg
 * @param {object} p2p The block from {@link readP2PStatus}.
 * @returns {string[]}
 */
function statusNotes(relay, rtt, cfg, p2p) {
  const notes = [];

  /**
   * §7's one-line note, and the reason it exists at all: the shared server is a *default*, and a
   * default that an operator cannot see is a machine quietly talking to somebody else's host. The
   * note names the address in use, where it came from and the exact way to override it.
   */
  if (cfg.rabbitSource === 'shared-default') {
    notes.push(
      `\`rabbitUrl\` is not set, so this machine is using the shared W2M server at ${SHARED_SERVER.rabbitUrl} ` +
        '(rabbit_source: "shared-default"); set `rabbitUrl` in this plugin\'s profile patch, or `W2M_RABBIT_URL` ' +
        'in the environment, to point at your own relay',
    );
  } else if (cfg.rabbitSource === 'env') {
    notes.push(`\`rabbitUrl\` came from the environment (\`W2M_RABBIT_URL\`), not from the profile patch, so a profile setting would be ignored`);
  } else if (cfg.rabbitUrlOverride !== null && cfg.rabbitSource === 'config') {
    notes.push(
      '`rabbitUrl` is set in the profile patch, so it wins over `device.json`\'s own `rabbit_url` ' +
        '(the v0.3.9 fallback, which is no longer consulted)',
    );
  }

  if (p2p.mode === 'relay') {
    notes.push('p2pMode is "relay": no UDP socket is bound on this machine and every task travels through the relay, exactly as in v0.3.9');
  } else if (p2p.running) {
    notes.push(
      `p2pMode is "${p2p.mode}" and the direct path is up on ${p2p.local ? `${p2p.local.address}:${p2p.local.port}` : '(unknown local address)'}` +
        `; ${p2p.reflexive ? `reflexive ${p2p.reflexive.address}:${p2p.reflexive.port}, NAT mapping ${p2p.mapping ?? 'unknown'}` : 'no reflexive address was measured (a LAN punch still works; a punch across the internet will fall back to the relay)'}` +
        '. A punch between two machines on this same host proves the code path, not NAT traversal.',
    );
  } else if (p2p.enabled) {
    notes.push(
      `p2pMode is "${p2p.mode}" but the direct path is not running (${p2p.last_error ?? p2p.reason ?? 'no reason recorded'}), ` +
        'so every task is dispatched over the relay; the relay\'s offer path is unaffected',
    );
  }

  if (p2p.enabled && p2p.inbox.depth > 0) {
    notes.push(
      `${p2p.inbox.depth} result(s) received over a direct channel are waiting in ${p2p.inbox.dir}; ` +
        'the relay\'s copy of each result is the ledger, these are the fast-path copies',
    );
  }

  if (relay.reachable === true && relay.relay_id) {
    notes.push(
      `relay_id \`${relay.relay_id}\` has been up ${Math.round((relay.uptime_ms ?? 0) / 1000)} - ` +
        'record this id: a different one on a later call means the relay restarted and every machine reconnected to a new process',
    );
  } else if (relay.reachable === true && relay.relay_id === null) {
    notes.push('the relay answered /healthz but sent no relay_id, so it predates v0.1.2 and a restart cannot be detected from here');
  }

  if (relay.reachable === true && relay.base_path !== null && cfg.rabbitUrl) {
    notes.push(`the relay reports base_path \`${relay.base_path}\`; \`rabbitUrl\` in use is \`${cfg.rabbitUrl}\``);
  }

  if (relay.operator_token_required === true && cfg.operatorToken === null) {
    notes.push(
      'this relay requires an operator token for POST /v1/task and none is configured, so w2m_run will refuse before sending anythin - set `operatorToken` or `W2M_OPERATOR_TOKEN`',
    );
  } else if (relay.operator_token_required === false) {
    notes.push('this relay does not require an operator token (an explicit escape hatch, not the default), so an unauthenticated dispatch can succeed');
  }

  if (rtt.available) {
    notes.push(`round trip to the relay: last ${rtt.last} ms, average ${rtt.avg} ms over ${rtt.samples.length} sample(s) (source: ${rtt.source})`);
  } else if (rtt.reason) {
    notes.push(`round-trip time unavailable - ${rtt.reason}`);
  }

  return notes;
}

/**
 * Register the five W2M tools.
 *
 * @param {object} ctx Cordis context, carrying the `tools` service.
 * @param {object} [config] Entry configuration from the profile patch.
 * @returns {Promise<void>} Resolves once the tools are registered. `apply` is async because
 *          resolving `@deepseek-ai/dsh-tools` is.
 */
export async function apply(ctx, config = {}) {
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
  // only mechanism Cordis gives for that. Creating it never throws — a machine that cannot punch
  // still has to dispatch, and `w2m_status` is where the failure is reported.
  const p2p = createP2PRuntime(ctx, cfg, config.p2pBlock);

  /**
   * This machine's fleet identity, read once per successful resolution.
   *
   * The memoization rule lives in {@link createLocalIdentity} so the route half and the tool half
   * cannot disagree about when a missing identity becomes a stale one.
   */
  const localIdentity = createLocalIdentity(async () => {
    const device = await readDevice({ stateDir: cfg.stateDir });
    return { machine_id: device.machine_id, machine_name: device.machine_name, machineName: cfg.machineName };
  });

  // v0.6.1: the two browser routes behind the composer's target control. Additive and optional: a
  // host without `connection.fetch` still gets every tool, and `w2m_status` reports the absence —
  // which is the honest place for it, since a host that has no Connection at all is simply not a web
  // composition and does not need a warning on every headless run.
  //
  // Nothing here reads the service: `registerTargetRoutes` declares the optional dependency with
  // `ctx.inject` and attaches from that callback (the comment there records why a plain
  // `ctx.connection` read fails the whole entry, and why the read cannot be synchronous anyway). The
  // one mismatch worth a log line — a Connection that carries no fetch registry — is logged where it
  // is observed, inside that callback, so this call returns a status object that stays live.
  const targetRoutes = registerTargetRoutes(ctx, {
    cfg: () => cfg,
    store: defaultSelectionStore,
    localIdentity,
    request,
    resolveToken,
  });

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
  ctx.tools.register(defineTool({
    name: 'w2m_devices',
    description:
      'List the machines the Rabbit currently holds leases for: machine_id, name, platform, ' +
      'capabilities, and when each was last seen. Read-only. Answers "who is online" without ' +
      'running anything; a machine that is listed may still refuse the next command for a reason ' +
      'the capability gate will report. With include_discovered it also reports what mDNS sees on ' +
      'the LAN in `discovery.candidates` - unverified hints, each marked with whether the relay ' +
      'lists it, and never a dispatch target on their own.',
    parameters: {
      include_stale: {
        type: 'boolean',
        description: 'Include machines whose lease looks expired rather than only the live ones. Defaults to false.',
      },
      include_discovered: {
        type: 'boolean',
        default: false,
        description:
          'Also scan the LAN over mDNS for about 1.5 s and report discovered candidates under ' +
          '`discovery`. Each candidate is marked unverified and carries `known_to_relay`; only a ' +
          'candidate the relay also lists (by machine_id) may be dispatched to. Defaults to false.',
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);
      const token = await resolveToken(cfg);

      // The read itself, the liveness rule, and "this machine has no identity yet" all come from
      // the same helper the composer control uses, so the list a model reads and the list an
      // operator clicks can never disagree about who is online.
      const identity = await localIdentity();
      const fleet = await readFleet({
        rabbitUrl: base,
        token,
        localMachineId: identity.machine_id,
        signal: exec?.signal,
        request,
      });
      if (!fleet.ok) {
        // The typed error is rebuilt here, from the helper's report, so the code, message and hint a
        // caller sees are the same three it saw before this read moved into `fleet-target.mjs`: the
        // remediation travels in `hint`, never in the message.
        const unauthorized = fleet.status === 401;
        throw new W2MError(
          unauthorized ? 'W2M_RABBIT_REFUSED' : 'W2M_UNREACHABLE',
          fleet.status === 0
            ? `${fleet.error}`
            : `${fleet.error}; ${unauthorized ? 'this machine is not paired, or its device_token is stale - pair the agent again' : 'check the Rabbit log for the reason it gave'}`,
          {
            hint: fleet.hint ?? (unauthorized
              ? 'this machine is not paired, or its device_token is stale; pair the agent again'
              : 'check the Rabbit log for the reason it gave'),
          },
        );
      }

      // `GET /v1/devices` answers `{protocol_version, rabbit_time, devices:[...]}`. Each entry is a
      // device recor - the Rabbit's own lease bookkeeping is on the task, not her - so a device
      // is described by identity and capabilities, and the relay's own `state` is the honest
      // default for a device it still lists.
      const includeStale = args?.include_stale === true;
      const listed = fleet.records.filter((machine) => includeStale || String(machine?.state ?? 'online') !== 'expired');

      // The LAN hint layer. `include_discovered` runs one bounded scan; without it the block reports
      // the *last* scan's candidates against this call's roster, so a model that already paid for a
      // scan does not have to pay for it twice. Either way the candidates are described by
      // `mdns-discover.mjs`, which is where "discovered but not relay-listed is not a target" lives.
      const discoveryRequested = args?.include_discovered === true;
      const discoveryBlock = discoveryRequested
        ? await discovery.scan({
            signal: exec?.signal,
            relayRecords: fleet.records,
            localMachineId: identity.machine_id,
          })
        : discovery.describe({ relayRecords: fleet.records, localMachineId: identity.machine_id });
      // A cancel during the scan window is a cancel, not a partial answer: the signal is our caller's
      // withdrawal, and the same typed abort every other wait in this file produces is owed to them.
      if (discoveryRequested) throwIfAborted(exec?.signal);

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          rabbit_time: fleet.rabbit_time,
          count: listed.length,
          devices: listed.map((machine) => ({
            machine_id: machine?.machine_id ?? null,
            name: machine?.machine_name ?? machine?.name ?? null,
            os: machine?.platform?.os ?? machine?.os ?? null,
            os_version: machine?.platform?.os_version ?? machine?.os_version ?? null,
            arch: machine?.platform?.arch ?? machine?.arch ?? null,
            shell: machine?.platform?.shell ?? machine?.shell ?? null,
            caps: machine?.caps ?? null,
            last_seen: machine?.last_seen ?? machine?.last_seen_at ?? null,
            state: machine?.state ?? 'online',
          })),
          excluded_stale: includeStale ? 0 : fleet.records.length - listed.length,
          discovery: discoveryBlock,
          note:
            'a listed device has paired and is being tracked; it can still refuse the next command ' +
            'at the capability gate, which w2m_wait reports per machine as `refused`',
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m devices', kind: 'read', rawInput: {} }),
  }));

  // -------------------------------------------------------------------------------------------
  // 2. w2m_ru - broadcast
  // -------------------------------------------------------------------------------------------
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
        enum: ['replicate', 'split', 'broadcast', 'pipeline'],
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
        description: 'Number of slices for mode=split. Defaults to 1, which is the only value replicate accepts.',
        default: 1,
      },
      cwd_rel: {
        type: 'string',
        description: 'Working directory relative to the project root, with forward slashes. Defaults to ".".',
        default: '.',
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
    },
    output: jsonOutput,
    async execute(args, exec) {
      throwIfAborted(exec?.signal);
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
      if (mode !== 'replicate' && mode !== 'split' && mode !== 'broadcast' && mode !== 'pipeline') {
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
      // argument — so a caller that named a machine (which, for this tool, means
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
       * the one that used to be invisible — a stored selection with no `machine_id` produces
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

      // §5: dispatching a task is the operator's privilege, not the device's. The operator token is
      // required and there is no device-token fallbac - see requireOperatorToken.
      const token = requireOperatorToken(cfg);
      const anchors = await resolveGitAnchors({ projectDir: cfg.projectDir, timeoutMs: Math.min(15_000, timeoutMs) });

      // §7: the two routing facts the offer carries to the machine that has to run the command.
      //
      // `origin_machine_id` is *this* machine's id from `device.json` — where the work was typed, not
      // where it runs — and it is omitted entirely (not sent as null) when this machine has no
      // identity, because the relay's own validation refuses an empty string and "unknown origin" is
      // what a missing field already means on the wire.
      //
      // The identity comes from the runtime, which resolves it off the dispatch path; a dispatch that
      // arrives before that one small read has finished waits for it rather than racing it. The wait
      // is bounded by the identity read itself and can never reject — see `createP2PRuntime`. This is
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
        created_by: cfg.machineName,
        // Only sent for broadcast; the relay ignores it otherwise, and the validation above already
        // refused the combination, so this cannot silently mean nothing.
        ...(executorMachineId !== null ? { executor_machine_id: executorMachineId } : {}),
        // v0.6.1: the elected machine, when the caller did not name one and a mode that reads it is
        // in play. Spread after the caller's own field above so the caller always wins even if a
        // future edit makes both possible.
        ...selectionFields,
        // Only for pipeline. The relay ignores `stages` under the other modes and the validation
        // above refuses the combination, so this can never silently mean nothing.
        ...(mode === 'pipeline' && stagesPayload !== null ? { stages: stagesPayload } : {}),
        // v0.4.0: stated on every task, so `w2m_wait`'s `transport` and a machine's report can say
        // which path the dispatcher expected to use — and so the executor in `direct` mode knows it
        // must refuse an offer that did not arrive over the direct path.
        ...(originMachineId !== null ? { origin_machine_id: originMachineId } : {}),
        p2p: p2pOffer,
      };

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

      /**
       * v0.4.0 §7: best-effort direct pushes, after the relay has the task.
       *
       * Order matters and is deliberate. The task exists on the relay *before* anything is punched,
       * so a push that fails, a peer that never announced and a socket that was never bound all leave
       * exactly the same outcome: the relay's own SSE offer is the delivery, and the machine's
       * `transport` says which path won. A failed push is therefore **not** an error and never fails
       * this tool — but it is not hidden either, because `direct_pushes` names every attempt and the
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
      };
      if (cfg.p2pMode !== 'relay' && p2p.node !== null && p2p.start?.ok === true) {
        try {
          const pushes = await pushOffers(p2p.node, {
            taskId: result.json?.task_id ?? null,
            leases: Array.isArray(result.json?.leases) ? result.json.leases : [],
            payload,
            originMachineId,
            // v0.6.0: where each target's static public key is read from, so the offer addressed to a
            // machine can carry the key that machine needs to authenticate the dispatcher's handshake.
            getJson: p2p.node?.getJson ?? null,
          });
          directPushes = {
            ...directPushes,
            attempted: pushes.length,
            delivered: pushes.filter((entry) => entry.ok).length,
            failed: pushes.filter((entry) => !entry.ok).length,
            pushes,
            // How many of the machines that were reached were reached over a channel *this* machine
            // did not open — the executor dialled first, and the push landed on that path. Zero on a
            // fleet where only the dispatcher initiates, which is what makes the two-way punch
            // visible in one dispatch's own answer instead of only in the ledger.
            reused_channels: pushes.filter((entry) => entry.reused === true).length,
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
          note: anchors.base_tree === null
            ? 'this machine\'s working tree could not be fingerprinted, so peers have no anchor to match and the aggregate will be unverifiable'
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

  // -------------------------------------------------------------------------------------------
  // 3. w2m_wait
  // -------------------------------------------------------------------------------------------
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
               * entry as well). `null` means the machine did not say — which is exactly what a
               * v0.3.9 agent sends, so a missing value must not be dressed up as `'relay'`.
               */
              transport: envelope?.transport ?? machine?.transport ?? null,
              p2p: envelope?.p2p ?? machine?.p2p ?? null,
              reasons: machine?.reasons ?? [],
              envelope: compactEnvelope(envelope, COMPARABLE_FIELDS),
            };
          })
        : [];

      return JSON.stringify(
        {
          ok: true,
          complete: true,
          task_id: taskId,
          state: aggregate.state,
          state_known: aggregate.known,
          states: aggregate.states,
          machines,
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

  // -------------------------------------------------------------------------------------------
  // 4. w2m_report
  // -------------------------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------------------------
  // 5. w2m_statu - read-only, and the only tool that works without rabbitUrl
  // -------------------------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'w2m_status',
    description:
      'Report this plugin\'s view of itself: the machine identity on disk, which relay it is ' +
      'talking to and where that address came from (rabbit_source; "shared-default" means nobody ' +
      'configured one), whether the Rabbit answers, the paired token presence, the relay\'s ' +
      'cross-region diagnostics (relay_id, uptime, deployment base_path, effective_scheme, whether ' +
      'it demands an operator token), the direct P2P path (mode, whether a UDP socket is bound, ' +
      'the measured reflexive address and NAT mapping, punches in and out, and how many results ' +
      'are waiting in the local inbox), this machine\'s round-trip time to the relay, and the ' +
      'project\'s base_commit/base_tree. Read-only, degrades field by field, and deliberately ' +
      'usable while the configuration is still broken, because it is the tool you reach for when ' +
      'w2m_devices says rabbitUrl is unset.',
    parameters: {},
    output: jsonOutput,
    async execute(_args, exec) {
      throwIfAborted(exec?.signal);
      // Read, not required: this tool exists to describe a half-configured machine, so an absent or
      // unpaired device.json is part of the answer rather than a reason to refuse. `/healthz` needs
      // no bearer token, so nothing here depends on the token being present.
      const device = await readDevice(cfg);

      // A cheap reachability probe of a documented endpoint. Without a configured URL there is
      // nothing to probe, and that is reported rather than guessed at.
      let relay = {
        configured_url: cfg.rabbitUrl,
        probed_url: null,
        reachable: null,
        http_status: null,
        protocol_version: null,
        error: null,
        // §4 cross-region diagnostics. Null until `/healthz` answers, and individually null when a
        // relay predates v0.1.2: a missing field is reported as missing, never invented.
        relay_id: null,
        uptime_ms: null,
        started_at: null,
        base_path: null,
        effective_scheme: null,
        operator_token_required: null,
        pair_rate_limit: null,
        persistence: null,
      };
      const probeBase = cfg.rabbitUrl ?? device.rabbit_url ?? null;
      if (probeBase) {
        const target = `${probeBase.replace(/\/+$/, '')}`;
        try {
          const probe = await request({
            rabbitUrl: target,
            signal: exec?.signal,
            pathname: '/healthz',
            timeoutMs: PROBE_TIMEOUT_MS,
            maxBytes: 64 * 1024,
          });
          const health = probe.json ?? {};
          relay = {
            configured_url: cfg.rabbitUrl,
            probed_url: target,
            reachable: probe.ok,
            http_status: probe.status,
            protocol_version: health.protocol_version ?? null,
            error: probe.ok ? null : (probe.error?.code ?? `HTTP ${probe.status}`),
            relay_id: health.relay_id ?? null,
            uptime_ms: typeof health.uptime_ms === 'number' ? health.uptime_ms : null,
            started_at: health.started_at ?? null,
            base_path: health.base_path ?? null,
            effective_scheme: health.effective_scheme ?? null,
            operator_token_required:
              typeof health.operator_token_required === 'boolean' ? health.operator_token_required : null,
            pair_rate_limit: typeof health.pair_rate_limit === 'number' ? health.pair_rate_limit : null,
            persistence: health.persistence ?? null,
            // Which of the §4 fields this relay actually sent. A v1 relay sends none of them, and a
            // reader should be able to tell "field absent" from "field false".
            diagnostics_present: ['relay_id', 'uptime_ms', 'base_path', 'effective_scheme', 'operator_token_required']
              .filter((key) => health[key] !== undefined && health[key] !== null),
          };
        } catch (error) {
          relay = {
            ...relay,
            configured_url: cfg.rabbitUrl,
            probed_url: target,
            reachable: false,
            http_status: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const anchors = await resolveGitAnchors({ projectDir: cfg.projectDir });
      const rtt = await readRtt(cfg);
      // §7: this tool is one of the two places the direct path is asked about, so it is one of the
      // two places the node is started. Never throws, and reports `enabled: false`/`running: false`
      // rather than omitting itself — a reader has to be able to tell "relay mode" from "p2p was
      // requested and did not start".
      await p2p.ensureStarted();
      const p2pStatus = await readP2PStatus(cfg, p2p, Number.isInteger(relay.peers_announced) ? relay.peers_announced : null);

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          identity: {
            machine_id: device.machine_id,
            machine_name: cfg.machineName,
            device_json: device.path,
            device_json_present: device.present,
            paired: device.device_token !== null,
            device_error: device.error,
          },
          relay: { ...relay, healthz: '/healthz' },
          /**
           * §7: which relay this machine is actually talking to, and where that address came from.
           *
           * `rabbit_source` is the field an operator needs when two machines disagree about the
           * fleet, and `'shared-default'` is the one value that means "nobody chose this endpoint".
           * It is repeated at the top level rather than only under `config` because it is the answer
           * to a question asked about the *relay*, not about this plugin's settings.
           */
          rabbit_source: cfg.rabbitSource,
          rabbit_url: cfg.rabbitUrl,
          p2p: p2pStatus,
          rtt,
          config: {
            rabbitUrl: cfg.rabbitUrl,
            rabbit_source: cfg.rabbitSource,
            rabbit_url_override_ignored: cfg.rabbitUrlOverride,
            stateDir: cfg.stateDir,
            projectDir: cfg.projectDir,
            autoStartAgent: cfg.autoStartAgent,
            allowedCommands: cfg.allowedCommands,
            pairingCode_configured: cfg.pairingCode !== null,
            p2pMode: cfg.p2pMode,
            // The resolved list, shared server first, exactly as the node will query it.
            stunServers: cfg.stunServers,
            // §5: `validated` reports presence only. The plugin cannot tell a correct token from a
            // wrong one without spending a dispatch, and `required_by_relay` is what makes the two
            // halves of the mismatch (client has none / relay demands one) visible side by side.
            operatorToken_configured: cfg.operatorToken !== null,
            operatorToken_source: cfg.operatorToken !== null
              ? (typeof config?.operatorToken === 'string' && config.operatorToken.trim() !== ''
                ? 'config'
                : 'environment')
              : null,
            operatorToken_required_by_relay: relay.operator_token_required ?? null,
          },
          /**
           * v0.3.3 shared config, with the source of every value.
           *
           * The sources are the point, not decoration: "the setting is there but something overrides
           * it" is the characteristic failure of layered configuration, and it must be answerable from
           * one call rather than by editing files and observing what changes.
           */
          shared_config: {
            files: cfg.sharedConfig.files,
            values: cfg.sharedConfig.values,
            sources: cfg.sharedConfig.sources,
            // Pre-rendered too, because the human reading this in a terminal is usually the one who
            // has to decide which file to edit.
            summary: describeSharedConfig(cfg.sharedConfig),
          },
          project: {
            base_commit: anchors.base_commit,
            base_tree: anchors.base_tree,
            head_commit: anchors.head_commit,
            branch: anchors.branch,
            dirty: anchors.dirty,
            fingerprint_algo: 'git-temp-index-tree/v1',
            error: anchors.error,
          },
          /**
           * v0.6.1: the composer's target control and the selections it holds.
           *
           * Reported here because "the control is not in my composer" has exactly two causes — the
           * host has no fetch-route registry, or the browser half is not loaded — and this is the
           * one call that can tell them apart from the host side. The selections themselves are
           * counts, not contents: which session picked which machine is the operator's business and
           * nothing the model needs.
           */
          target_selection: {
            route: TARGET_ROUTE_PATH,
            attached: targetRoutes.mounted,
            detail: targetRoutes.mounted
              ? 'the composer control reads and writes its selection through this route'
              : targetRoutes.reason,
            sessions_with_a_target: defaultSelectionStore.list().length,
          },
          notes: statusNotes(relay, rtt, cfg, p2pStatus),
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m status', kind: 'read', rawInput: {} }),
  }));

  // -------------------------------------------------------------------------------------------
  // Optional: bring up relay + agent in this process
  // -------------------------------------------------------------------------------------------
  if (cfg.autoStartAgent) {
    ctx.effect?.(() => startLocalStack(ctx, cfg));
  } else {
    /**
     * v0.8.5: **say it out loud.**
     *
     * This branch is the whole reason a machine can run v0.8.4 with the account-derived fleet key,
     * hold a valid signed-in account, reach the relay over HTTP 200, and still be in no fleet —
     * with nothing anywhere reporting a problem. The eight tools register, the plugin looks
     * healthy, and the join sequence simply never runs.
     *
     * A silent no-op that looks like success is the worst failure mode this plugin has had. One
     * line at warn level turns *"why is this machine not in my fleet"* from an investigation into a
     * log search.
     */
    ctx.logger?.warn?.(
      'w2m: no agent is running on this machine, so it is in no fleet and will receive no work. '
      + 'Set autoStartAgent: true to join (the fleet key is derived from the signed-in account), '
      + 'or run w2m-localside yourself and point it at the relay.',
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

  // ---------------------------------------------------------------------------------------------
  // 6. w2m_update -- read-only unless asked to act
  // ---------------------------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'w2m_update',
    description:
      'Inspect and drive this plugin\'s own updater. It checks the project\'s GitHub releases at ' +
      '00:00, 03:00 and 05:00 Beijing time by default and installs a newer release only after ' +
      'verifying the hash published with it. Action "status" reports the schedule, the installed ' +
      'version, the last check and whether a restart is still pending; "check" runs one ' +
      'check-and-install cycle now and does not throw -- a network failure comes back as a recorded ' +
      'error, which is exactly how it differs from "already up to date". A new version is installed ' +
      'for the *next* start: this tool never restarts the Harness and never hot-swaps running code.',
    parameters: {
      action: {
        type: 'string',
        description:
          'status (default) reports the updater; check runs one check-and-install cycle now and ' +
          'records the outcome. One of: status, check.',
      },
    },
    output: jsonOutput,
    execute: async (args) => {
      const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'status';
      // A STRING, like every other tool here. Measured: the first version returned the plain object
      // and the host rejected the call outright -- `tool "w2m_update" returned invalid output:
      // "value" must be a string` -- so this tool could never be used at all, in v0.4.0 or v0.4.1.
      // `jsonOutput` is a renderer, not a serialiser; the tool still owns turning its value into
      // text.
      if (action === 'status') {
        return JSON.stringify({ ok: true, action, update: updater.describe() }, null, 2);
      }
      const result = await updater.check('manual');
      // `ok:false` inside `result` means "the check could not complete", never "the tool failed".
      return JSON.stringify({ ok: true, action, result, update: updater.describe() }, null, 2);
    },
    // `kind: 'other'` for the actions that can install, never `'read'`. This tool mutates the profile
    // it runs in, and labelling that a read is a false claim in exactly the place a user looks to
    // decide whether a call is safe. `'other'` is the value the built-in plugin-manager tool in this
    // same runtime uses for its mutating actions (`dsh-plugin-manager/lib/types/tools.js`), so it is
    // the one vocabulary item here with a reference implementation behind it rather than a guess.
    presentCall: (args) => ({
      card: 'generic',
      title: 'w2m update',
      kind: args?.action === 'check' ? 'other' : 'read',
      rawInput: args ?? {},
    }),
  }));

  // -------------------------------------------------------------------------------------------
  // 7. w2m_history -- what this fleet has been asked to do
  // -------------------------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------------------------
  // 8. w2m_stats -- the fleet at a glance, without reading any task
  // -------------------------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'w2m_stats',
    description:
      'Summarise the fleet in one read-only call: how many machines the relay holds, how many are ' +
      'online, the round-trip time it has measured for each (null means never measured, which is ' +
      'not the same as 0ms), task and result counts, and whether the relay restarted since your ' +
      'last look. Cheaper than w2m_devices plus w2m_history when you only need the shape of things.',
    parameters: {},
    output: jsonOutput,
    async execute(_args, exec) {
      throwIfAborted(exec?.signal);
      const base = requireRabbit(cfg);

      // Two reads rather than one: `/healthz` is the only place the relay reports the aggregate RTT
      // view, and `/v1/devices` is the only place it reports per-machine state. Neither requires a
      // device token, so a machine that is not paired can still report on the fleet.
      const health = await request({ rabbitUrl: base, signal: exec?.signal, pathname: '/healthz' });
      if (!health.ok) {
        throw new W2MError(
          'W2M_RABBIT_REFUSED',
          `W2M_RABBIT_REFUSED: the Rabbit refused GET /healthz with HTTP ${health.status}; ` +
            'the relay is the only source of fleet state, so there is nothing to summarise',
          { hint: 'check the relay is running and rabbitUrl points at it' },
        );
      }

      let devices = null;
      try {
        const token = await resolveToken(cfg);
        const res = await request({ rabbitUrl: base, token, signal: exec?.signal, pathname: '/v1/devices' });
        devices = res.ok ? res.json : null;
      } catch {
        // A machine that is not paired can still report the fleet from /healthz. Dropping the
        // per-machine half is better than failing a summary.
        devices = null;
      }

      const h = health.json ?? {};
      const rtt = h.rtt ?? null;
      const list = Array.isArray(devices?.devices) ? devices.devices : [];
      const online = list.filter((d) => d?.online === true).length;

      return JSON.stringify(
        {
          ok: true,
          protocol_version: PROTOCOL_VERSION,
          rabbit_time: h.rabbit_time ?? null,
          relay: {
            relay_id: h.relay_id ?? null,
            uptime_ms: h.uptime_ms ?? null,
            started_at: h.started_at ?? null,
            effective_scheme: h.effective_scheme ?? null,
            base_path: h.base_path ?? null,
            operator_token_required: h.operator_token_required ?? null,
          },
          counts: {
            devices: h.devices ?? list.length,
            online: devices === null ? null : online,
            tasks: h.tasks ?? null,
            results: h.results ?? null,
            pairing_codes: h.pairing_codes ?? null,
          },
          // `null` throughout means "the relay did not report it", never "zero". Collapsing those
          // two is how a broken relay reads as an idle one.
          rtt: rtt === null
            ? null
            : {
                machines_reporting: rtt.machines_reporting ?? null,
                min_ms: rtt.min_ms ?? null,
                max_ms: rtt.max_ms ?? null,
                avg_ms: rtt.avg_ms ?? null,
                machines_stale: rtt.machines_stale ?? null,
                machines_unknown: rtt.machines_unknown ?? null,
              },
          machines: devices === null
            ? null
            : list.map((d) => ({
                machine_id: d?.machine_id ?? null,
                machine_name: d?.machine_name ?? null,
                online: d?.online === true,
                rtt_ms: d?.rtt_ms ?? null,
                rtt_stale: d?.rtt_stale ?? null,
                last_heartbeat_at: d?.last_heartbeat_at ?? null,
              })),
          notes: devices === null
            ? ['per-machine detail is unavailable (this machine could not read /v1/devices); the fleet totals above still come from the relay']
            : [],
        },
        null,
        2,
      );
    },
    presentCall: () => ({ card: 'generic', title: 'w2m stats', kind: 'read', rawInput: {} }),
  }));
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

/**
 * Start the relay, then pair an agent against it, inside this process.
 *
 * Both modules are imported dynamically: this repository is written by several people at once, and
 * a plugin that refuses to load because a sibling module is not on disk yet would be useless to
 * the other four tools. A missing module is reported as a typed error naming the path and what
 * that means.
 *
 * @param {object} ctx
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {Promise<() => Promise<void>>} A disposer that stops the agent and closes the relay.
 */
async function startLocalStack(ctx, cfg) {
  const relayUrl = new URL('../relay/server.mjs', import.meta.url);
  const agentUrl = new URL('../agent/agent.mjs', import.meta.url);

  let createRelay;
  let createAgent;
  try {
    ({ createRelay } = await import(relayUrl.href));
  } catch (error) {
    throw new W2MError('W2M_MODULE_MISSING', `autoStartAgent is on but ${relayUrl.pathname} could not be imported: ${error instanceof Error ? error.message : String(error)}`, {
      hint: 'run the relay yourself and set rabbitUrl, or make sure src/relay/server.mjs is present',
    });
  }
  try {
    ({ createAgent } = await import(agentUrl.href));
  } catch (error) {
    throw new W2MError('W2M_MODULE_MISSING', `autoStartAgent is on but ${agentUrl.pathname} could not be imported: ${error instanceof Error ? error.message : String(error)}`, {
      hint: 'run the agent yourself and set rabbitUrl, or make sure src/agent/agent.mjs is present',
    });
  }

    /**
     * v0.8.3: this block was dead code, and the reason is worth recording.
     *
     * It called `createAgent` with `projectDir` and without `identity`, and passed a
     * `pairingCode` that `createAgent` does not accept. `createAgent` requires `project` and an
     * `identity.machine_id`, so **`autoStartAgent: true` threw on its first call** — the code path
     * that was supposed to bring an agent up had never run. That is why the fleet-join wire appeared
     * to be missing: the place it was meant to live could not be reached at all.
     *
     * Two more things were wrong with the shape:
     *
     *   * it created a **local relay** unconditionally. For a machine joining a shared fleet that
     *     is the opposite of what is wanted — the machine must connect to the relay that already
     *     exists, not mint another one, and with `rabbitUrl` pointing at a remote host it would
     *     have tried to bind a relay on that hostname;
     *   * nothing paired the agent, so even a started agent could fetch no offers.
     *
     * So: pair by the **account fleet key** when one is available, fall back to a pairing code, and
     * only stand up a local relay when the configured URL actually is local.
     */
    /**
     * v0.8.5: a usable state directory, because an empty one THROWS.
     *
     * `createAgent` rejects a falsy `stateDir` (`createAgent: stateDir is required`), and the
     * plugin's resolved default is the empty string. So `autoStartAgent: true` with `stateDir`
     * unset threw as well -- a SECOND gate behind the first, and the two together meant the
     * join sequence could not run even when someone flipped the switch.
     *
     * Resolved here rather than left to the caller because `w2m_status` reports `cfg.stateDir`
     * verbatim: showing the resolved path is what makes "where did it write device.json"
     * answerable instead of a guess.
     */
    const resolvedStateDir =
      typeof cfg.stateDir === 'string' && cfg.stateDir.trim() !== ''
        ? cfg.stateDir.trim()
        : resolveStateDir(null, 'localside');
    if (cfg.stateDir !== resolvedStateDir) {
      ctx.logger?.info?.(`w2m: stateDir was unset; using ${resolvedStateDir}`);

    const target = cfg.rabbitUrl ? new URL(cfg.rabbitUrl) : null;
    const isLocalRelay =
      target === null || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname);

    let relay = null;
    if (isLocalRelay) {
      relay = await createRelay({
        host: target?.hostname ?? '127.0.0.1',
        port: target?.port ? Number(target.port) : 8787,
        stateDir: resolvedStateDir,
        pairingCode: cfg.pairingCode ?? undefined,
      });
      ctx.logger?.info?.(`w2m: relay listening at ${relay.url ?? '(unknown url)'}`);
    } else {
      // Joining an existing relay: nothing to start, and minting a second one would put this
      // machine in a fleet of its own.
      ctx.logger?.info?.(`w2m: joining the relay at ${cfg.rabbitUrl}`);
    }

    }

    /**
     * v0.8.6: the identity, and the options needed to WRITE IT BACK.
     *
     * loadOrCreateIdentity is read-only. The token it gains at pairing lives only in memory
     * unless something calls saveDeviceToken -- and nothing in this path did, so a machine could
     * pair successfully, appear in the relay's device table, and then answer 401 to every
     * authenticated request after the next restart, because device.json still said device_token:
     * null.
     *
     * The CLI has always done this (in/w2m-localside.mjs: saveDeviceToken(paired.device_token)).
     * The in-process path was written without it, which is why the symptom looked like a permission
     * fault rather than a missing line.
     */
    const identityOptions = { name: cfg.machineName, rabbitUrl: cfg.rabbitUrl ?? undefined };
    const loaded = loadOrCreateIdentity(identityOptions);

    /**
     * v0.8.8: report what this machine IS, not just that it exists.
     *
     * `createAgent` accepts `platform` and `caps`, and the CLI has always supplied them. This path
     * did not, so a machine that joined through the plugin appeared in the relay complete and
     * correct except for `os: null` and `caps: {}` -- and the capability gate then had nothing to
     * filter on, which decides what work the machine is offered.
     *
     * The same shape as the other defects in this series: the record was created, and the part
     * that makes it USEFUL was not filled in.
     */
    const [{ caps, detail: capDetail }, platform] = await Promise.all([
      probeCapsDetailed({}),
      detectPlatform({}),
    ]);
    if (capDetail?.notes?.length) {
      ctx.logger?.info?.(`w2m: capability probe notes: ${capDetail.notes.join('; ')}`);
    }

    const agent = await createAgent({
      rabbitUrl: relay?.url ?? cfg.rabbitUrl,
      // `project`, not `projectDir`: the option `createAgent` documents, and the one it requires.
      project: cfg.projectDir,
      stateDir: resolvedStateDir,
      // The identity the agent announces itself under. Loaded from the same file the CLI uses, so
      // a machine has ONE identity whether the agent runs in-process or as its own process --
      // otherwise each would mint its own keypair and overwrite the other's announcement under a
      // shared machine_id (the v0.6.2 defect, in a new place).
      // The identity options are kept in a variable because the SAME options must be used to write
      // the device token back. Reading with one set and writing with another is how the plugin and
      // the CLI ended up each minting a keypair under one machine_id (the v0.6.2 defect).
      identity: identityOptions.identity,
      identityPath: loaded.path,
      caps,
      platform,
      allowedCommands: cfg.allowedCommands,
    });
    /**
     * v0.8.9: derive the fleet key, RETRYING until the account actually answers.
     *
     * The account profile is LAZILY loaded: `getPlatformSession().userId` is null until a
     * successful `getProfile` has happened, and this runs at mount -- before any model call has
     * touched the profile. So a single read at startup returns "signed out" on a machine that is
     * signed in, and the fleet key is never derived.
     *
     * That also explains an earlier confusing result: v0.8.4 DID pair once, because the profile
     * happened to be cached by then. A timing-dependent success is the worst kind to debug,
     * because the code is right and the outcome still varies.
     *
     * v0.8.7 made it worse without meaning to: "already paired -> do not pair again" turned an
     * intermittent miss into a PERMANENT one, since a machine that missed at startup never
     * retried. Re-pairing was the only thing that had been rescuing it.
     *
     * So: back off and retry until a real key appears or the budget runs out, and REPORT EVERY
     * OUTCOME -- including the one that used to say nothing at all. `resolve()` on the stored-SN
     * path returns ok:true with a null fleetKey, which the old code checked for neither truthy
     * nor falsy, so that shape produced no log line anywhere. A silent branch in the exact place
     * that was failing is how this took several rounds to find.
     */
    let fleetKey = cfg.fleetKey ?? null;
    let fleetKeySource = fleetKey === null ? null : 'config';
    if (fleetKey === null) {
      const ATTEMPTS = 6;
      let last = null;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
          const { createAccountIdentity } = await import('../chatops/account.mjs');
          last = await createAccountIdentity({ ctx, platform: process.platform }).resolve();
        } catch (error) {
          last = { ok: false, reason: 'threw', detail: error instanceof Error ? error.message : String(error) };
        }
        const key = last && last.ok === true ? last.fleetKey : null;
        if (typeof key === 'string' && key !== '') {
          fleetKey = key;
          fleetKeySource = 'account';
          ctx.logger?.info?.(`w2m: fleet key derived from the signed-in account on attempt ${attempt} (fleet ${last.accountCode})`);
          break;
        }
        if (attempt < ATTEMPTS) {
          const waitMs = Math.min(2000 * 2 ** (attempt - 1), 30000);
          ctx.logger?.info?.(`w2m: no fleet key yet (${describeIdentityFailure(last)}); retrying in ${waitMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
      if (fleetKey === null) {
        // Loud, and it names which failure it was: a machine in no fleet must never be quiet.
        ctx.logger?.warn?.(
          `w2m: could not derive a fleet key after ${ATTEMPTS} attempts (${describeIdentityFailure(last)}) -- `
          + 'this machine is in NO fleet and will receive no work', 
        );
      }
    }

    /**
     * Name what actually went wrong, including the shapes that used to say nothing.
     *
     * `ok: true` with a null key was invisible before: the old code only logged when `ok === false`,
     * so the one branch that was firing had no output.
     *
     * ## v0.8.11: read `fleetKeyReason`, and stop guessing
     *
     * v0.8.10 taught `resolve()` to return *why* the derivation failed -- and **nothing consumed
     * it**, so the reason was written into a value and never printed. A fix that adds a field no
     * caller reads is not a fix; it is a field.
     *
     * The `ok: true` wording also guessed *"the profile may not be loaded yet"*, which was true
     * when this ran once at mount. After v0.8.9's retries that reading is usually **wrong** --
     * sixty seconds of backoff have passed -- and a confident wrong explanation is worse than
     * none, because it sends the reader to check timing when the cause is elsewhere. The real
     * reason travels in `fleetKeyReason`, so report that instead of a guess.
     */
    function describeIdentityFailure(identity) {
      if (!identity) return 'no result';
      if (identity.ok === true) {
        if (typeof identity.fleetKeyReason === 'string' && identity.fleetKeyReason !== '') {
          return identity.fleetKeyReason;
        }
        return 'signed in, but the account produced no fleet key and gave no reason';
      }
      return `${identity.reason}${identity.detail ? `: ${identity.detail}` : ''}`;
    }

    /**
     * v0.8.7: **pair only when there is no token**, because the relay rate-limits pairing.
     *
     * The previous version paired on EVERY start: the fleet key is derived unconditionally, so
     * `pairBy` was never null and the branch always ran. The relay allows
     * `pair_rate_limit: 5` per minute, so five restarts inside a minute would hit the limit --
     * and a rate-limit refusal reads as a pairing failure, which reads as a fleet problem.
     * A machine that already holds a token has nothing to gain from pairing again: the relay
     * would re-issue one and invalidate the old, for no reason.
     *
     * So the condition is the token: absent -> pair once and persist; present -> leave it alone.
     * That is also what makes the persisted token load-bearing rather than an optimisation --
     * without it every start is a fresh pairing, which is why the missing write in v0.8.5 and
     * the unconditional pairing here were the same defect seen from two sides.
     */
    const existingToken = loaded.identity.device_token;
    const alreadyPaired = typeof existingToken === 'string' && existingToken !== '';

    const pairBy = fleetKey !== null ? `fleet key (${fleetKeySource})` : cfg.pairingCode ? 'pairing code' : null;
    if (alreadyPaired) {
      ctx.logger?.info?.(`w2m: already paired (token in ${loaded.path}); not pairing again`);
    } else if (pairBy !== null) {
      try {
        const paired = await agent.pair(cfg.pairingCode ?? null, undefined, fleetKey);
        /**
         * v0.8.6: **persist the token.** Without this the pairing is thrown away.
         *
         * `agent.pair` sets `identity.device_token` on its in-memory object only. Nothing in this
         * path wrote it back, so the observable behaviour was: the relay registers the device, the
         * machine appears in `w2m_devices`, and then every authenticated call answers
         * `401 UNAUTHORIZED` -- `w2m_devices`, the P2P announce, all of it -- because `device.json`
         * still said `device_token: null`. It reads as a permission failure and is a missing write.
         *
         * The CLI has always done this; the in-process path was written without it.
         * `saveDeviceToken` throws on an empty token rather than storing one, which is the right
         * shape: a silent null here is exactly the state this line removes.
         */
        try {
          saveDeviceToken(paired?.device_token, identityOptions);
          ctx.logger?.info?.(`w2m: device token persisted to ${loaded.path}`);
        } catch (error) {
          // Named rather than silent: a machine that paired but cannot authenticate is the exact
          // failure this release exists to remove, and it must not be quiet a second time.
          ctx.logger?.warn?.(
            'w2m: paired but the device token could NOT be persisted ('
            + `${error instanceof Error ? error.message : String(error)}) -- this machine will answer `
            + '401 to every authenticated call until that is fixed',
          );
        }
        ctx.logger?.info?.(`w2m: paired by ${pairBy}`);
      } catch (error) {
        // Named rather than swallowed: an agent that failed to pair runs and does nothing, which
        // looks identical to a fleet with no work.
        ctx.logger?.warn?.(`w2m: pairing by ${pairBy} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      ctx.logger?.warn?.('w2m: no fleetKey and no pairingCode, so this machine cannot join a fleet');
    }

    await agent.start();
    ctx.logger?.info?.(`w2m: agent started as ${JSON.stringify(agent.identity?.() ?? null)}`);

    // Â§8.2: when the agent runs inside this process its `rttMs` is reachable directly, so `w2m_status`
    // can report it without a file. When the agent is its own process this stays null and the tool
    // says so instead of guessing.
    const statusGetter = agent.status ?? agent.state ?? null;

  return async () => {
    inProcessAgentStatus = null;
    await agent.stop();
    await relay.close();
  };
}


