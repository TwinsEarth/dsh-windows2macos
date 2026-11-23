/**
 * Shared plugin helpers for the w2m tool surface (P1 refactor, S2/S3).
 *
 * Everything the four tool-domain modules and the `apply()` assembly both need lives here: the
 * refusal types and codes, config parsing, HTTP/relay requests, identity and P2P glue, result
 * shaping and the local-agent stack. This module knows nothing about which tool is being
 * registered; it holds no tool definitions and imports nothing from `../tools.mjs` or the
 * domain modules, so the dependency direction is always tools.mjs -> tools/<domain> -> shared.
 */

import { FAILOVER_DEFAULTS, createRelayFailover, relayPool } from '../relay-failover.mjs';
import { diagnoseFleetBinding, shouldRejoin, selectFleetKey } from '../fleet-binding.mjs';
import { fleetHomePath, getFleetHome, readFleetHome, rememberFleetAccount, rememberFleetHome, shouldPreserveExistingFleet } from '../fleet-home.mjs';
import { fleetConfigPathFor, readFleetConfig } from '../fleet-config.mjs';
import { DEFAULT_BOOTSTRAP_URL, DEFAULT_BOOTSTRAP_OPERATOR_KEY_PEM } from '../bootstrap.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldDegrade } from '../join-degradation.mjs';
import { deriveAccountKeypair } from '../../util/account-identity.mjs';
import { joinByAccount } from '../account-join.mjs';
// The base-address rules live in one place (§2), shared with the agent side. Importing the - rather
// than re-deriving them her - is what stops the plugin and the agent from disagreeing about what
// `https://host/w2m` means, which is the defect §2 exists to fix.
// `src/agent/` does not import `src/plugin/`, so the dependency runs one way and cannot cycle.
import { joinUrl, resolveBaseUrl } from '../../agent/url.mjs';
import { deviceFilePath } from '../../agent/identity.mjs';
import { DEFAULT_P2P_MODE, P2P_MODES, P2PNode, SHARED_SERVER, normalizeP2PMode, normalizeP2PPort, stunServersWithShared } from '../../agent/p2p-node.mjs';
// The punch identity both ends have to agree on (v0.4.x). Imported from the transport that will use
// it, never re-derived here: the session is the only thing that tells one punch's frames from
// another's, so a second implementation of the formula that drifted by one input would make every
// reverse dial time out while both ends insisted they were sending.
import { punchSession } from '../../agent/p2p.mjs';
// v0.33.0: the level is chosen by NAME rather than typed. `resolveConfiguredLevel` also accepts a plain
// integer, because a profile patch written by an earlier version must keep loading.
import { AUTHORITY_CHOICES, resolveConfiguredLevel } from '../../agent/authority-choice.mjs';
// v0.6.0: the device keypair and the offer's key distribution (`docs/P2P-CRYPTO.md` §4). Imported
// rather than reimplemented: the dispatcher and the executor have to derive the *same* keys, and two
// implementations of a handshake are two chances to disagree about it.
import { DeviceKey } from '../../agent/crypto.mjs';
import { loadOrCreateIdentity, saveDeviceToken } from '../../agent/identity.mjs';
import { probeCapsDetailed, detectPlatform } from '../../agent/caps.mjs';
import { resolveStateDir } from '../../util/cli.mjs';
import { parseServer } from '../../agent/stun.mjs';
import { createRelayPeerKeyResolver, createWebRtcTransportPool } from '../../agent/webrtc/pool.mjs';
import { setSharedWebRtcPool } from '../webrtc-pool-registry.mjs';
import { findProfileDir } from '../auto-update.mjs';
import { readOperatorToken } from '../operator-token.mjs';
import { schemaProblems, strayParameterProblems } from '../schema-spec.mjs';
import { loadSharedConfig } from '../shared-config.mjs';
import { DEFAULT_DAILY_TIMES, DEFAULT_TIME_ZONE } from '../schedule.mjs';
/**
 * Register the five W2M tools.
 *
 * @param {object} ctx Cordis context, carrying the `tools` service.
 * @param {object} [config] Entry configuration from the profile patch.
 * @returns {Promise<void>} Resolves once the tools are registered. `apply` is async because
 *          resolving `@deepseek-ai/dsh-tools` is.
 */
import { createPluginCollector } from '../../ops/plugin-adapter.mjs';

/** v1.6.6: last failover snapshot, reported by w2m_status and refreshed by the supervisor interval. */
export let relayFailoverStatus = null;

/**
 * v1.2.6 reliability: two small files beside the plugin's state.
 *
 * `chat-cursor.json` remembers how far each conversation has been read, so "list" continues where the last page ended instead of
 * starting over. `chat-spool.jsonl` holds messages that could not be sent because the Rabbit was unreachable; each carries the
 * idempotency key it will be posted with, so a replay that the relay already received does not post the sentence twice.
 */
export const CHAT_CURSOR_FILE = 'chat-cursor.json';

export const CHAT_SPOOL_FILE = 'chat-spool.jsonl';

/** Line protocol version this plugin speaks. Reported by `w2m_status`, never negotiated here. */
export const PROTOCOL_VERSION = 1;

/** How long any single HTTP call may take before it is aborted, in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Largest JSON body this plugin will read, in bytes. Keeps a flood out of the session. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Largest `stdout`/`stderr` excerpt returned inline by `w2m_wait`, in bytes per stream. */
export const MAX_EXCERPT_BYTES = 4096;

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
 * setting at large; the credential gate below has its own code because its remedy  - set
 * `operatorToken`  - is unlike any other configuration fault's.
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
   * The composer's selected target routed this dispatch. Not a refusal  - a named *reason*, so the
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
export function reasonCodeOf(message) {
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
export class W2MError extends Error {
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
export function configError(setting, why, hint, reasonCode) {
  return new W2MError('W2M_CONFIG', `W2M_CONFIG: configuration \`${setting}\` ${why}; ${hint}`, {
    hint,
    ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
  });
}

/**
 * Read `fleetKeyPolicy` without silently accepting a typo.
 *
 * The three values are materially different: `home` returns to the machine's previous fleet for
 * this account, `account` follows the signed-in account and may create/join a new fleet, and
 * `config` pins one operator-supplied key. A typo that defaulted to any one of them would be a
 * silent fleet move, so it is a startup error naming the setting.
 */
function resolveFleetKeyPolicy(config, env) {
  const fromConfig = typeof config?.fleetKeyPolicy === 'string' ? config.fleetKeyPolicy.trim() : '';
  const fromEnv = typeof env?.W2M_FLEET_KEY_POLICY === 'string' ? env.W2M_FLEET_KEY_POLICY.trim() : '';
  const value = fromConfig !== '' ? fromConfig : (fromEnv !== '' ? fromEnv : 'home');
  if (value === 'home' || value === 'account' || value === 'config') return value;
  const setting = fromConfig !== '' ? 'fleetKeyPolicy' : 'W2M_FLEET_KEY_POLICY';
  throw configError(
    setting,
    `must be one of "home", "account" or "config" (got "${value}")`,
    'set fleetKeyPolicy to home (return to the previous fleet for this account), account (follow the signed-in account) or config (pin the configured key)',
  );
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
export function throwIfAborted(signal) {
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

    // v1.2.3: DSH refuses an object parameter that does not state additionalProperties explicitly, and it
    // refuses it at MOUNT time -- in the profile of whoever installed the build. That is the failure the packed
    // artifact hit in a real host while this repository tests were green, so the rule is enforced here, where
    // every tool already passes through.
    const schemaProblemsFound = [
      ...schemaProblems({ type: 'object', properties: parameters, additionalProperties: false }, name),
      ...strayParameterProblems(parameters, name),
    ];
    if (schemaProblemsFound.length > 0) {
      throw new TypeError(schemaProblemsFound.map((problem) => problem.path + ': ' + problem.why).join('; '));
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
export async function loadDefineTool() {
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
/**
 * The state directory the plugin must use when the profile does not set one.
 *
 * The documented layout is `$DSH_HOME/xclient` (or `~/.dsh/xclient`); the CLI already resolves it
 * through `resolveStateDir`, but the host plugin used to keep an unset value as null. That silently
 * disabled the local memory file, the RTT state file and the P2P inbox on every machine whose
 * profile did not repeat the path. v3.3.16 makes the default explicit and testable.
 */
export function configuredStateDir(config = {}, env = process.env) {
  const explicit = typeof config?.stateDir === 'string' ? config.stateDir.trim() : '';
  if (explicit !== '') return path.resolve(explicit);
  const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'xclient');
}

/**
 * Normalize the optional WebRTC data-plane block.
 *
 * The block is nested (`config.webrtc`) so a profile that only wants the relay does not grow ten
 * unrelated top-level keys. A missing `signalUrl` does NOT disable silently: `enabled` stays true
 * and the pool is simply not built, with `reason` naming the missing setting. That is what lets
 * `w2m_status` say "WebRTC is configured but has no signaling server" instead of pretending the
 * feature does not exist.
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string,string|undefined>} [env]
 * @returns {object}
 */
export function normalizeWebRtcConfig(config = {}, env = process.env) {
  const raw = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const int = (value, fallback, min = 0) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= min ? number : fallback;
  };
  const string = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);
  const fromEnv = (name, fallback = '') => string(env?.[name], fallback);
  const enabled = raw.enabled !== false && fromEnv('W2M_WEBRTC_ENABLED', '1') !== '0';
  const signalUrl = string(raw.signalUrl, fromEnv('W2M_WEBRTC_SIGNAL_URL', ''));
  const signalToken = string(raw.signalToken, fromEnv('W2M_WEBRTC_SIGNAL_TOKEN', ''));
  const providerCommand = string(raw.providerCommand, fromEnv('W2M_WEBRTC_PROVIDER_COMMAND', ''));
  const providerArgs = Array.isArray(raw.providerArgs)
    ? raw.providerArgs.map(String)
    : (() => {
        const encoded = fromEnv('W2M_WEBRTC_PROVIDER_ARGS', '');
        if (encoded === '') return [];
        try {
          const parsed = JSON.parse(encoded);
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          return [];
        }
      })();
  const providerCwd = string(raw.providerCwd, fromEnv('W2M_WEBRTC_PROVIDER_CWD', ''));
  const iceServers = Array.isArray(raw.iceServers) ? raw.iceServers : [];
  return {
    enabled,
    signal_url: signalUrl,
    signal_token: signalToken,
    provider_command: providerCommand,
    provider_args: providerArgs,
    provider_cwd: providerCwd,
    ice_servers: iceServers,
    prefer_p2p: raw.preferP2p !== false,
    allow_relay: raw.allowRelay !== false,
    max_rtt_ms: int(raw.maxRttMs, 350, 1),
    connect_timeout_ms: int(raw.connectTimeoutMs, 30_000, 1),
    handshake_timeout_ms: int(raw.handshakeTimeoutMs, 15_000, 1),
    peer_timeout_ms: int(raw.peerTimeoutMs, 20_000, 1),
    stats_poll_ms: int(raw.statsPollMs, 2_000, 0),
    max_fragment_bytes: int(raw.maxFragmentBytes, 16 * 1024, 64),
    data_max_attempts: int(raw.dataMaxAttempts, 33, 1),
    ack_timeout_ms: int(raw.ackTimeoutMs, 500, 1),
    retry_delay_ms: int(raw.retryDelayMs, 100, 0),
    result_budget_ms: int(raw.resultBudgetMs, 5_000, 1),
    // `true` only when the pool can actually be constructed. `reason` explains why not.
    buildable: enabled && signalUrl !== '' && providerCommand !== '',
    reason: !enabled
      ? 'WebRTC data plane is disabled in config (webrtc.enabled: false)'
      : signalUrl === ''
        ? 'webrtc.signalUrl (or W2M_WEBRTC_SIGNAL_URL) is not set, so no signaling room can be joined'
        : providerCommand === ''
          ? 'webrtc.providerCommand (or W2M_WEBRTC_PROVIDER_COMMAND) is not set, so no WebRTC engine can be spawned'
          : null,
  };
}

export function readConfig(config = {}) {
  let operatorTokenSource = null;
  const cwd = process.cwd();

  /**
   * §7: where the relay address came from.
   *
   * The order is `rabbitUrl` 鈫?`W2M_RABBIT_URL` 鈫?the shared server, and the *source* is carried out
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

  // v3.3.16: an unset stateDir is the documented default layout, not "no state": without this
  // fallback every machine without an explicit profile value lost local memory and RTT.
  const stateDirExplicit = typeof config.stateDir === 'string' && config.stateDir.trim() !== '';
  const stateDir = configuredStateDir(config);
  /**
   * The settings-page pin. This is the supported alternative to editing `cordis.patch.yml`: the
   * route writes it atomically and the plugin reads it here with higher precedence than the profile
   * fields. A corrupt pin fails startup with the path named rather than silently using the account
   * key and moving the machine.
   */
  const fleetConfigFile = fleetConfigPathFor(stateDir);
  const fleetConfigRead = fleetConfigFile === null ? { ok: true, config: null } : readFleetConfig(fleetConfigFile);
  if (fleetConfigRead.ok !== true) {
    throw configError(
      'fleet-config.json',
      `is unreadable (${fleetConfigRead.code}: ${fleetConfigRead.error})`,
      `repair or remove ${fleetConfigRead.path ?? fleetConfigFile ?? 'fleet-config.json'}; the settings page writes it atomically`,
    );
  }
  const fleetPin = fleetConfigRead.config;

  // §7: both of these are validated here, at `apply()` time, so a typo is a startup error that names
  // the setting rather than a status field nobody reads. See the two resolvers for why there is no
  // silent default when a value *is* supplied.
  const p2p = resolveP2PMode(config);
  const p2pMode = p2p.mode;
  const p2pPortResult = normalizeP2PPort(config.p2pPort);
  const p2pPublicPortResult = normalizeP2PPort(config.p2pPublicPort);
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
    stateDirExplicit,
    projectDir: typeof config.projectDir === 'string' && config.projectDir.trim() !== ''
      ? path.resolve(config.projectDir.trim())
      : cwd,
    machineName: typeof config.machineName === 'string' && config.machineName.trim() !== ''
      ? config.machineName.trim()
      : os.hostname(),
    // v1.1.6: joining is on by default; `false` is the only way off.
    autoStartAgent: config.autoStartAgent !== false,
      /**
       * v0.8.3: the account-derived key this machine joins its fleet with.
       *
       * Supplied by the host, which is the only layer that can read the signed-in account -- a
       * standalone agent cannot derive it, which is why it must be handed down rather than
       * computed where it is used. `W2M_FLEET_KEY` is accepted too, so a machine can be pointed at
       * a fleet without editing a profile.
       */
      fleetKey: fleetPin?.fleetKey ?? (typeof config.fleetKey === 'string' && config.fleetKey.trim() !== ''
        ? config.fleetKey.trim()
        : (typeof process.env.W2M_FLEET_KEY === 'string' && process.env.W2M_FLEET_KEY.trim() !== ''
          ? process.env.W2M_FLEET_KEY.trim()
          : null)),
    /**
     * v2.2.1: which key wins when a configured key, the account-derived key and this machine's
     * previous fleet for that account disagree.
     *
     * `home` (default) returns to the last fleet used for the signed-in account; `account` is the
     * v2.2.0 opt-in that always follows the account; `config` is the explicit operator pin. A pin
     * written from the settings page is authoritative and carries its own policy.
     */
    fleetKeyPolicy: fleetPin?.policy ?? resolveFleetKeyPolicy(config, process.env),
    fleetConfigFile,
    // From the merged layers, not from `config` alone: this is the value the fleet shares.
    allowedCommands: shared.values.allowedCommands
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
    /**
     * v0.22.0: the authority level this machine dispatches AS, or null when nobody configured one.
     *
     * Not part of the shared config, deliberately: this is a local statement about who is typing, and a
     * fleet-wide value would let one machine's level speak for another's operator. `W2M_ACTOR_AUTHORITY`
     * is accepted so a machine can be pointed at a level without editing a profile.
     *
     * null is not 0. An unset level means there is no actor to judge, and the gate reports that as
     * unenforced rather than refusing every writing dispatch on a machine that never opted in.
     */
    /**
     * v0.33.0: the level, chosen by NAME or configured as a number.
     *
     * The plugin config takes either, through {@link resolveConfiguredLevel} — a name because nobody should
     * have to remember what 70 means, and a number because a profile patch written by an earlier version
     * must keep loading. `W2M_ACTOR_AUTHORITY` takes a name too, so a machine can be pointed at a band
     * without editing a profile.
     *
     * `actorAuthorityChoice` carries the resolution — including WHY it failed, when it did — so `w2m_status`
     * can report a level it refused instead of silently dispatching unenforced. A misconfigured level that
     * degrades to `null` in silence is the failure this pair exists to prevent.
     */
    ...(() => {
      const fromEnv = typeof process.env.W2M_ACTOR_AUTHORITY === 'string' && process.env.W2M_ACTOR_AUTHORITY.trim() !== ''
        ? process.env.W2M_ACTOR_AUTHORITY.trim()
        : undefined;
      const resolved = resolveConfiguredLevel(fromEnv !== undefined ? fromEnv : config.actorAuthorityLevel);

      /**
       * v0.34.0: the policy that makes 分权限 real, and why it is a policy rather than a default.
       *
       * `docs/1.0.0-ACCEPTANCE.md` §3.11 records the gap plainly: the gate is **off unless configured**, so a
       * default install dispatches exactly as it did before the permission model existed, and **"off unless
       * configured" cannot be part of a 1.0.0 that claims 分权限.**
       *
       * `requireAuthorityLevel: true` closes it: with the policy on, a machine that has not chosen a level
       * **refuses to start** rather than dispatching unenforced. `W2M_REQUIRE_AUTHORITY_LEVEL` supplies the
       * same policy from the environment, so a fleet can require it without editing every profile.
       *
       * ## Why it is opt-in, which is a deliberate limit
       *
       * Refusing unconditionally would be the honest reading of "a permission system that is off is
       * untested" — and it would also **stop every machine running an earlier version the moment it
       * upgraded**, since none of them has a level. That trades one silent failure for a loud outage, and an
       * outage is not a security property.
       *
       * So the policy is per-machine and explicit. **The gap is narrowed, not closed**: a fleet that does not
       * turn this on is exactly as unenforced as before, and this comment says so rather than letting the
       * existence of the flag imply otherwise.
       */
      const required = config.requireAuthorityLevel === true
        || (typeof process.env.W2M_REQUIRE_AUTHORITY_LEVEL === 'string' && process.env.W2M_REQUIRE_AUTHORITY_LEVEL.trim() !== '' && process.env.W2M_REQUIRE_AUTHORITY_LEVEL.trim() !== '0');
      if (required && !resolved.ok) {
        throw configError(
          'actorAuthorityLevel',
          `is required on this machine (requireAuthorityLevel is set) and ${resolved.ok ? '' : resolved.detail}`,
          `choose one of ${AUTHORITY_CHOICES.map((c) => c.value).join(', ')} as \`actorAuthorityLevel\`, or as \`W2M_ACTOR_AUTHORITY\`; to dispatch without a level, unset requireAuthorityLevel`,
          resolved.code ?? 'W2M_AUTHORITY_LEVEL_REQUIRED',
        );
      }

      return {
        actorAuthorityLevel: resolved.ok ? resolved.level : null,
        actorAuthorityChoice: {
          ok: resolved.ok,
          level: resolved.level,
          source: resolved.source,
          reason_code: resolved.code,
          detail: resolved.detail,
          required,
        },
      };
    })(),
    defaultTimeoutMs: shared.values.defaultTimeoutMs,
    sharedConfig: shared,
    pairingCode: typeof config.pairingCode === 'string' && config.pairingCode.trim() !== ''
      ? config.pairingCode.trim()
      : (typeof process.env.W2M_PAIRING_CODE === 'string' && process.env.W2M_PAIRING_CODE.trim() !== ''
        ? process.env.W2M_PAIRING_CODE.trim()
        : null),
    // §5: the operator credential. Only `w2m_run` uses it.
    // v2 G0-1: the token file (0600) is the recommended source; profile config stays for legacy,
    // env last. The value never reaches a status output - only the source and a fingerprint do.
    operatorToken: (() => {
      const fromConfig = typeof config.operatorToken === 'string' && config.operatorToken.trim() !== ''
        ? config.operatorToken.trim()
        : null;
      if (fromConfig !== null) { operatorTokenSource = 'config'; return fromConfig; }
      const secure = readOperatorToken();
      if (secure.configured === true) { operatorTokenSource = 'file'; return secure.token; }
      const fromEnv = typeof process.env.W2M_OPERATOR_TOKEN === 'string' && process.env.W2M_OPERATOR_TOKEN.trim() !== ''
        ? process.env.W2M_OPERATOR_TOKEN.trim()
        : null;
      if (fromEnv !== null) { operatorTokenSource = 'env'; return fromEnv; }
      operatorTokenSource = null;
      return null;
    })(),
    operatorTokenSource,
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
    // v1.5.2: the relay pool and the bootstrap inputs. `relayUrls` is what `w2m-bootstrap` writes;
    // `relayTemporary` marks a fallback list so the fleet panel can say "临时 Relay 节点" out loud
    // instead of presenting a stranded machine's fallback as a settled configuration.
    relayUrls: Array.isArray(config.relayUrls)
      ? config.relayUrls.filter((url) => typeof url === 'string' && url.trim() !== '').map((url) => url.trim().replace(/\/+$/, ''))
      : [],
    relayTemporary: config.relayTemporary === true,
    // v1.5.3: the operator endpoint and its public pin ship with the package, so a machine whose only
    // capability is upgrading the plugin still finds its fleet. Explicit config/env still wins.
    bootstrapUrl: typeof config.bootstrapUrl === 'string' && config.bootstrapUrl.trim() !== ''
      ? config.bootstrapUrl.trim()
      : (typeof process.env.W2M_BOOTSTRAP_URL === 'string' && process.env.W2M_BOOTSTRAP_URL.trim() !== '' ? process.env.W2M_BOOTSTRAP_URL.trim() : DEFAULT_BOOTSTRAP_URL),
    bootstrapOperatorKeyPem: typeof config.bootstrapOperatorKey === 'string' && config.bootstrapOperatorKey.trim() !== ''
      ? config.bootstrapOperatorKey
      : (typeof process.env.W2M_BOOTSTRAP_OPERATOR_KEY === 'string' && process.env.W2M_BOOTSTRAP_OPERATOR_KEY.trim() !== '' ? process.env.W2M_BOOTSTRAP_OPERATOR_KEY : DEFAULT_BOOTSTRAP_OPERATOR_KEY_PEM),
    p2pMode,
    p2pPort: p2pPortResult.ok ? p2pPortResult.port : null,
    p2pPortError: p2pPortResult.ok ? null : `P2P_PORT_INVALID: ${p2pPortResult.reason}`,
    p2pPublicPort: p2pPublicPortResult.ok ? p2pPublicPortResult.port : null,
    stunServers: stunList,
    // v3.5.8: the WebRTC data plane. Nested so the relay-only profile stays short; `buildable` is
    // the one bit `startLocalStack` uses, and `reason` is what status prints when it is false.
    webrtc: normalizeWebRtcConfig(config.webrtc),
  };
}

/**
 * Resolve `p2pMode` from the config object, then `W2M_P2P_MODE`, then the default  - loudly.
 *
 * A value that is present and wrong is a `W2M_CONFIG` error naming the setting: falling back to
 * `auto` would dispatch work over a path the operator explicitly asked not to use, and falling back
 * to `relay` would silently disable the release's headline feature. Neither is a default; both are
 * decisions the operator has to make.
 *
 * "Present" is decided by the *key*, not by truthiness. A profile patch that writes `p2pMode:` with
 * nothing after it hands this function `null`, and that is a value somebody typed  - collapsing it
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
 * itself is `parseServer` from `src/agent/stun.mjs`  - the same function the query path will use, so
 * "valid here" and "usable there" cannot drift.
 *
 * An **empty list is the default**, not an error. `stunServers: []` is what the bundled
 * `cordis.patch.yml` carries (a key that documents itself and names no server), and a profile that
 * starts from that file must not fail to load. `null` entries are dropped for the same reason  - a
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
export function resolveProfileDir(config) {
  return findProfileDir({
    explicit: config.profileDir,
    moduleUrl: import.meta.url,
  });
}

/**
 * Require the Rabbit URL, naming the setting when it is absent.
 *
 * With §7's shared-server default this can no longer be reached by "the operator set nothing"  - an
 * unset `rabbitUrl` resolves to {@link SHARED_SERVER}. It stays as the last-resort guard so that a
 * future edit which clears the field fails with a sentence naming it instead of an `Invalid URL`
 * from somewhere deep in `fetch`.
 *
 * @param {{rabbitUrl: string|null}} cfg
 * @returns {string}
 */
export function requireRabbit(cfg) {
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
export function devicePathFor(cfg) {
  const explicitFile = typeof process.env.DSH_DEVICE_FILE === 'string' ? process.env.DSH_DEVICE_FILE.trim() : '';
  if (explicitFile !== '') return path.resolve(explicitFile);
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
 * every failure into a `machine_id` of null plus an `error`  - a machine whose identity cannot be read
 * must still be able to dispatch, because the relay path does not need an identity at all.
 *
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {Promise<{machine_id: string|null, machine_name: string|null, path: string|null, error: string|null}>}
 */
export async function readLocalIdentity(cfg) {
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
 * rule is local by definition; the value that has to match another process byte for byte  - the
 * dedupe key  - is the one imported from the relay instead.
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
 * A frame without a `task_id` or without a `machine_id` cannot be stored or acknowledged  - the
 * acknowledgement is keyed by `task_id`, and two machines answering the same task must not overwrite
 * each other  - so it is refused by name instead of being written somewhere surprising.
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
 * One machine's copy of the `p2p` block: everything published, plus the session for *this* machine.
 *
 * The added `session` is what makes the push and a reverse dial one punch rather than two: an
 * executor that received the offer over a channel may still have to dial back (the dispatcher closes
 * the channel it pushed over, immediately after the push), and a dial carrying a session the
 * dispatcher is not filtering for would be answered by its `accept()` at best  - a second session,
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
export function offerP2PFor(published, { taskId, machineId, peerKey = null }) {
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
 * Build the object the tools reach the direct path through, and register its effect disposer.
 *
 * WHEN THE NODE STARTS, AND WHY IT IS NOT `apply()`
 *
 * The v0.4.0 contract says the node is "started in `apply()`". It is not, and this is the one place
 * this file departs from the contract's letter rather than its intent  - reported as a deviation, not
 * settled quietly here. What *is* kept is everything the sentence is about: the direct path is owned
 * for the plugin's whole lifetime, it is disposed by a `ctx.effect` disposer, and a failure to start
 * is a field in `w2m_status` rather than an exception at load.
 *
 * The reason for the change is what "start" costs. Starting this node binds a UDP socket and kicks
 * off a STUN sweep against four servers  - network traffic with a multi-second tail  - for a machine
 * that may never dispatch a task in that session. `apply()` runs on every session in a host that
 * mounts this plugin, so an unconditional start is a rendezvous per session, and it puts traffic
 * into every test and every host whose runtime is deterministic about what it sends. `ensureStarted()`
 * therefore does the work the first time a tool actually needs the direct path: a dispatch
 * (`w2m_run`) or a question about it (`w2m_status`). A machine that never dispatches never punches,
 * which is also the more honest reading of §1  - "never dials" is the property that matters, and this
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
export function createP2PRuntime(ctx, cfg, block = {}) {
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
     * mode it is in  - the defect this shape fixes was a `relay`-mode dispatch calling a method that did
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
 * §4 forbids  - so the failure becomes a reason string, the node runs without a key, and every offer
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
    ...(Number.isInteger(cfg.p2pPort) ? { bindPort: cfg.p2pPort } : {}),
    ...(Number.isInteger(cfg.p2pPublicPort) ? { publicPort: cfg.p2pPublicPort } : {}),
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
   * Registered *here*, after the node exists, rather than in `createP2PRuntime`  - an effect that owns
   * nothing is a disposer that releases nothing, and `relay` mode and a machine with no identity must
   * leave the host's effect list exactly as they found it. A host that provides no `ctx.effect` (an
   * older Cordis, or a bare test context) still gets a working node: the node itself is asked not to
   * hold the process open (`node.unref()`, below), so it cannot keep the process alive, and refusing
   * to start the direct path because the host cannot track a disposer would break the release's own
   * default.
   *
   * v0.5.10: `node.unref()` is a real call, not a description. Until it was added this comment
   * claimed an `unref()` that existed nowhere in the plugin or the node  - the socket went on holding
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
 * `task_id`/`machine_id`, is refused and **nothing** is written  - an inbox file is the only durable
 * trace of a peer's result, and a file whose name does not identify its contents is worse than no
 * file, because the next reader cannot tell a partial result from a complete one.
 *
 * `task.result` is the frame this exists for; `result.ack` and anything else a peer might send are
 * counted and ignored rather than treated as faults. The acknowledgement goes back on the same
 * channel the frame arrived on, and a failed acknowledgement is recorded  - the sender retries (the
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
    // sent something else". Not a signature  - the channel is not authenticated at this layer.
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
export let inProcessAgentStatus = null;

/**
 * The WebRTC pool owned by this process, when `startLocalStack` built one.
 *
 * The dispatcher half (`w2m_run`) reuses it rather than constructing a second pool on the same
 * machine id: a signaling room has exactly one `host` and one `client`, and two pools for one
 * machine would claim the same slot and make every pair flap. Null when this process does not
 * own an agent (the agent may be a separate process) or when no signaling URL is configured.
 *
 * @type {object|null}
 */
export let inProcessWebRtcPool = null;

/**
 * A way back into the fleet-join sequence, when the plugin started the agent itself.
 *
 * Set by {@link startLocalStack} and cleared by its disposer. Null in the normal case, where the
 * agent runs as its own process and this process has nothing to pair.
 *
 * ## Why the tools need this (v0.8.12)
 *
 * The join used to be a one-shot prologue of `startLocalStack`: derive, pair, persist, and never
 * look again. On this host the account profile is a *lazy cache* -- `getPlatformSession().userId` is
 * null until a successful `getProfile` has happened -- and the mount path runs before anything has
 * asked for the profile. So the one window closed empty and the machine stayed in no fleet for the
 * life of the process, even though the account answered correctly minutes later.
 *
 * A tool call is the natural place to notice, because a tool call is **after** the profile exists:
 * the session cannot answer a model request without it. So the unpaired tools call this, and a
 * machine that is used at all becomes a machine that joins.
 *
 * @type {(() => Promise<{paired: boolean, by: string|null}>)|null}
 */
let ensureFleetJoin = null;

/**
 * The agent factory `startLocalStack` uses -- the real `createAgent`, unless a test replaces it.
 *
 * ## Why this seam exists
 *
 * The join sequence is two steps: **pair** (derive the fleet key, `POST /v1/pair`, persist the
 * token) and **run** (`await agent.start()`, which opens an SSE stream and binds a UDP socket and
 * talks to a real relay for as long as the process lives). Only the first step is what a unit test
 * of "does a late account still join" can meaningfully assert.
 *
 * Without a seam the test has to start the real agent, which means reaching the public relay: slow,
 * non-hermetic, and it never returns. A test that can only be written by talking to production is a
 * test that will not be written -- and this series has already lost two rounds to a join path that
 * nothing exercised.
 *
 * @type {(options: object) => Promise<object>}
 */
let createAgentImpl = null;

/**
 * Replace the agent factory. Test-only: `resetDefineToolCacheForTests`' sibling.
 *
 * @param {((options: object) => Promise<object>)|null} impl
 */
export function setCreateAgentForTests(impl) {
  createAgentImpl = impl;
}

/**
 * Ask the in-process agent to finish joining, if it has not already.
 *
 * Deliberately total: every failure is reported as a value. A tool that refused to run because the
 * fleet join had not completed would turn "not paired yet" into "this tool is broken", and the whole
 * point of `w2m_status` is to describe a half-configured machine rather than fail on one.
 *
 * @returns {Promise<{paired: boolean, by: string|null}|null>} Null when this process owns no agent.
 */
export async function requestFleetJoin() {
  if (ensureFleetJoin === null) return null;
  try {
    return await ensureFleetJoin();
  } catch (error) {
    // Named to the caller's log context is not available here, so it travels as a value; the
    // retry loop inside `startLocalStack` owns the durable reporting.
    return { paired: false, by: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * File names an agent may publish its state under, most specific first.
 *
 * The `localside/` entry is not decoration: `stateDir` here is documented as the
 * directory holding `device.json`, and `w2m-localside` keeps its own state one
 * level below it (`<DSH_HOME>/xclient/localside`, see `resolveStateDir(_, 'localside')`).
 * Without this entry the default CLI layout could never be read, and RTT would
 * silently stay unavailable in exactly the cross-region deployment it is for.
 */
export const AGENT_STATE_FILES = ['agent-state.json', 'agent.json', 'localside-state.json', path.join('localside', 'agent-state.json')];

/**
 * Round to one decimal: RTT is a diagnostic, and false precision invites false conclusions.
 *
 * @param {number} value
 * @returns {number}
 */
export function round(value) {
  return Math.round(value * 10) / 10;
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
export async function request(options) {
  const {
    rabbitUrl,
    token = null,
    signal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    method = 'GET',
    pathname,
    query,
    body,
    /**
     * v1.0.7: raw bytes to send instead of a JSON body.
     *
     * Added for the blob channel (#1), which PUTs a memory document's exact octets. **Added here rather than as a
     * second `fetch` in the caller**, because `tools.mjs:1283` already states the rule: the direct path must not grow
     * a second way to talk to the relay -- bearer-token resolution, base-path joining, timeouts and abort handling
     * all live in this one function, and a duplicate would be a duplicate of all four.
     *
     * `body` and `rawBody` are mutually exclusive: passing both is a caller bug, not a merge to guess at.
     */
    rawBody,
    maxBytes = MAX_RESPONSE_BYTES,
    accept = 'application/json',
  } = options;

  if (rawBody !== undefined && body !== undefined) {
    throw new W2MError('W2M_CONFIG', 'W2M_CONFIG: `body` and `rawBody` are mutually exclusive', {
      hint: 'pass `rawBody` for octets, `body` for JSON -- not both',
    });
  }

  throwIfAborted(signal);

  // Named here rather than left to `new URL`, whose failure would say only "Invalid URL" and send
  // the reader looking in the wrong place.
  if (typeof rabbitUrl !== 'string' || rabbitUrl === '') {
    throw new W2MError('W2M_CONFIG', 'W2M_CONFIG: no Rabbit URL was available for this call', {
      hint: 'set `rabbitUrl` in this plugin\'s profile patch, for example http://127.0.0.1:8787',
    });
  }

  // §2: base + path, joined by hand. `new URL(pathname, base)` would resolve against the origin
  // and drop a deployment sub-path (`https://h/w2m` + `/v1/task` —?`https://h/v1/task` —?404).
  const target = toRequestUrl(joinUrl(rabbitUrl, pathname));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }

  const headers = { accept };
  if (token) headers.authorization = `Bearer ${token}`;
  // v1.0.7: octets keep their own content type. JSON-stringifying them would corrupt the bytes and, because the
  // relay verifies `sha256(body) === key`, corrupting them here would surface as a 422 blamed on the caller.
  if (rawBody !== undefined) headers['content-type'] = 'application/octet-stream';
  else if (body !== undefined) headers['content-type'] = 'application/json';

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error('timeout')), timeoutMs);
  const combined = combineSignals(signal, timeoutController.signal);

  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
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
 * agent writes it by default  - `$DSH_HOME/xclient/device.json`, the same file {@link readLocalIdentity}
 * reads  - and the calls go out with it. v0.4.0 made that fallback load-bearing rather than optional:
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
export async function resolveToken(cfg) {
  const file = devicePathFor(cfg);
  if (file === null) return null;
  const device = await readDevice({ stateDir: path.dirname(file) });
  if (!device.present) {
    // An explicit stateDir is the operator pointing at a pairing; an unpaired one is a loud
    // error. The default stateDir (v3.3.16) is just a layout, and a machine that has never
    // paired still dispatches over the relay with the operator token.
    if (cfg.stateDirExplicit === true) return requireToken(device);
    return null;
  }
  return requireToken(device);
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
export async function readDevice(cfg) {
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
 * The `code` stays `W2M_NO_TOKEN` for every case  - one class, "this machine cannot authenticate"  -  * while `reason_code` names which of the three it is, because the three have different remedies: pair
 * the agent, repair the file, or finish a pairing that never completed.
 *
 * @param {{machine_id: string|null, device_token: string|null, path: string|null, present: boolean, error: string|null}} device
 * @returns {string}
 */
export function requireToken(device) {
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
export async function resolveGitAnchors(options) {
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
export const AGGREGATE_STATES = new Set([
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
export const NON_TERMINAL_AGGREGATE = new Set(['pending']);

/** Per-machine `outcome` values that mean the machine is still working. */
export const NON_TERMINAL_OUTCOME = new Set(['pending', null, undefined]);

/** Internal telemetry adapter. Inactive unless the environment supplies the relay/token contract. */
export function startOpsTelemetryIfConfigured(ctx, config = {}) {
  const relaysJson = process.env.W2M_OPS_RELAYS;
  const token = process.env.W2M_OPS_DEVICE_TOKEN;
  if (typeof relaysJson !== 'string' || relaysJson === '' || typeof token !== 'string' || token === '') return null;
  let relays = null;
  try {
    relays = JSON.parse(relaysJson);
  } catch {
    return null;
  }
  if (!Array.isArray(relays) || relays.length < 3) return null;
  const explicit = Number(process.env.W2M_OPS_FLEET_SIZE);
  const rabbitUrl = (typeof config?.rabbitUrl === 'string' && config.rabbitUrl !== '' ? config.rabbitUrl : '') || process.env.W2M_RABBIT_URL || '';
  const devicesToken = process.env.W2M_DEVICE_TOKEN || '';
  const fetchFleetSize = async () => {
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (rabbitUrl === '' || devicesToken === '') return null; // adapter keeps the 2,026 fallback
    try {
      const response = await fetch(rabbitUrl.replace(/\/+$/, '') + '/v1/devices', { headers: { authorization: 'Bearer ' + devicesToken }, signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const body = await response.json();
      const devices = Array.isArray(body?.devices) ? body.devices : [];
      return devices.filter((device) => device && device.online !== false).length;
    } catch {
      return null;
    }
  };
  const machineId = (typeof config?.machineName === 'string' && config.machineName !== '' ? config.machineName : '') || process.env.W2M_MACHINE_NAME || 'w2m';
  const collector = createPluginCollector({
    machineId,
    teamId: process.env.W2M_OPS_TEAM ?? null,
    osInfo: process.env.W2M_OPS_OS ?? process.platform,
    pluginVersion: '1.9.0',
    relays: relays.map((relay, index) => ({ relayIndex: Number.isInteger(relay.relayIndex) ? relay.relayIndex : index, url: String(relay.url), token })),
    fleetSize: Number.isFinite(explicit) && explicit > 0 ? explicit : undefined,
    fetchFleetSize,
  });
  const handle = collector.start({ sessionSalt: String(Date.now()) });
  if (typeof ctx?.effect === 'function') ctx.effect(() => () => handle.stop(), 'w2m-ops: telemetry');
  return handle;
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
/**
 * The account material the local stack resolved, readable from the rest of the plugin.
 *
 * The fleet key is derived inside startLocalStack (it needs the account join), but the composer's chat route is
 * registered in apply(), one scope above: without this hand-off the route can only see `cfg.fleetKey`, which is null on
 * a machine that joined by account -- and the panel then refused every request with "no fleet-chat identity yet".
 * A holder rather than a parameter because the route is mounted before the stack starts, and reads lazily.
 */
export const resolvedFleetKey = { value: null, source: null, at: 0, homeFile: null, accountCode: null };

/** Probe one relay /healthz; any failure is `false` (a timeout must not throw into the interval). */
async function probeRelayHealth(url, timeoutMs) {
  try {
    const response = await fetch(url + '/healthz', {
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (response.ok !== true) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * v1.6.6: keep the in-process stack on a reachable relay.
 *
 * The primary relay can disappear entirely (2026-10-24: its host was down, so 8787 and SSH were both
 * unreachable). The stack is restartable: stop it, point cfg.rabbitUrl at the next healthy relay in
 * the pool, start it again. A switch is a re-join, not just a reconnect -- device tokens are relay-
 * specific, so startLocalStack pairs again through the account fleet key.
 *
 * The decision itself (3 failed probes to leave, 5 healthy ones to come home) lives in
 * relay-failover.mjs and is unit-tested there; this function only supplies health and performs the
 * restart.
 */
/** Append one line to the failover diagnostics log; failures are swallowed (diagnostics must not break the switch). */
async function appendFailoverLog(cfg, line) {
  try {
    const { appendFileSync, mkdirSync, statSync, writeFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { homedir } = await import('node:os');
    const dir = cfg.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'xclient');
    const file = join(dir, 'relay-failover.log');
    mkdirSync(dirname(file), { recursive: true });
    try { if (statSync(file).size > 256 * 1024) writeFileSync(file, ''); } catch { /* absent is fine */ }
    appendFileSync(file, new Date().toISOString() + ' ' + line + '\n');
  } catch { /* diagnostics only */ }
}

export async function startFailoverStack(ctx, cfg) {
  let stop = await startLocalStack(ctx, cfg);
  const pool = relayPool(cfg);
  if (pool.length < 2) {
    relayFailoverStatus = null;
    return stop;
  }
  const failover = createRelayFailover({ pool });
  relayFailoverStatus = failover.snapshot();
  let switching = false;
  const timer = setInterval(async () => {
    if (switching) return;
    const health = {};
    await Promise.all(pool.map(async (url) => { health[url] = await probeRelayHealth(url, FAILOVER_DEFAULTS.probeTimeoutMs); }));
    const decision = failover.assess(health);
    await appendFailoverLog(cfg, 'probe ' + JSON.stringify(health) + ' -> ' + decision.action + (decision.target ? ' ' + decision.target : ''));
    relayFailoverStatus = failover.snapshot();
    if (decision.action !== 'switch') return;
    switching = true;
    try {
      ctx.logger?.warn?.('w2m: relay failover ' + decision.active + ' (' + decision.reason + ')');
      await stop();
      cfg.rabbitUrl = decision.target;
      cfg.relaySource = 'failover';
      stop = await startLocalStack(ctx, cfg);
      ctx.logger?.info?.('w2m: relay failover stack restarted on ' + decision.target);
    } catch (error) {
      ctx.logger?.warn?.('w2m: relay failover restart failed: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      switching = false;
    }
  }, FAILOVER_DEFAULTS.probeIntervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    relayFailoverStatus = null;
    await stop();
  };
}

/**
 * Read an agent's identity without assuming `identity` is a method.
 *
 * v1.7.4: calling the optional method form on agent.identity crashed the DESKTOP host with
 *   dsh: fatal load failure: TypeError: agent.identity is not a function
 * because the desktop host's agent exposes `identity` as a property while the in-process agent
 * exposes it as a function. Optional CALL only guards null/undefined; a present non-function still
 * throws, and inside a promise callback that became an unhandled rejection that took the host down.
 * Reading the value with a type check covers both shapes.
 */
function agentIdentityOf(agent) {
  try {
    if (agent === null || agent === undefined) return null;
    return typeof agent.identity === 'function' ? agent.identity() : (agent.identity ?? null);
  } catch {
    return null;
  }
}

async function startLocalStack(ctx, cfg) {
  /**
   * The per-account history of this machine's fleets. It lives beside `device.json`, which is the
   * one state directory the plugin already resolves consistently. Without a directory there is no
   * safe place to remember a home, so `home` policy degrades to the account key and says so.
   */
  const fleetHomeFile = fleetHomePath(devicePathFor(cfg));
  resolvedFleetKey.homeFile = fleetHomeFile;
  if (fleetHomeFile === null && cfg.fleetKeyPolicy === 'home') {
    ctx.logger?.warn?.('w2m: no state directory is known, so fleet homes cannot be recorded; falling back to the account key');
  }

  /**
   * v1.5.2: bootstrap relay assignment. A fresh install has no relay list; without this it falls
   * back to the compiled shared default, which is how a machine ends up looking connected on somebody
   * else side. The answer is used only when it verified against the pinned operator key and is for
   * this machine fleet; every failure leaves the configured relay untouched and is recorded in
   * status, because a bootstrap that silently failed is indistinguishable from one never configured.
   */
  if ((Array.isArray(cfg.relayUrls) ? cfg.relayUrls.length : 0) === 0
    && typeof cfg.bootstrapUrl === 'string' && typeof cfg.bootstrapOperatorKeyPem === 'string') {
    try {
      const { resolveBootstrap } = await import(new URL('../bootstrap.mjs', import.meta.url).href);
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const cacheFile = join(cfg.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'xclient'), 'bootstrap.json');
      const outcome = await resolveBootstrap({
        url: cfg.bootstrapUrl,
        fleetKey: cfg.fleetKey ?? null,
        operatorPublicKeyPem: cfg.bootstrapOperatorKeyPem,
        cacheFile,
        log: (line) => ctx.logger?.info?.(line),
      });
      if (outcome.ok === true) {
        cfg.relayUrls = outcome.relays;
          const previousRelay = cfg.rabbitUrl; // v1.5.4: capture what a stale profile pinned
        // v1.5.4: a verified bootstrap answer WINS over a stale explicit rabbitUrl. A field machine
          // still named 127.0.0.1:8787 (a local relay that is not running), so v1.5.3 adopted the pool but
          // kept dialing loopback and reported W2M_UNREACHABLE. To pin a relay instead, set relayUrls.
          cfg.rabbitUrl = outcome.relays[0];
          cfg.rabbitSource = 'bootstrap';
          if (typeof previousRelay === 'string' && previousRelay !== outcome.relays[0]) {
            ctx.logger?.warn?.('w2m: bootstrap replaced the configured relay ' + previousRelay + ' with ' + outcome.relays[0]);
          }
        cfg.bootstrap = { configured: true, url: cfg.bootstrapUrl, source: outcome.source, relays: outcome.relays, expires_at: outcome.expires_at, last_error: null };
        ctx.logger?.info?.('w2m: bootstrap assigned relays (' + outcome.relays.join(', ') + ')');
      } else {
        cfg.bootstrap = { configured: true, url: cfg.bootstrapUrl, source: null, relays: [], expires_at: null, last_error: { reason_code: outcome.reason_code, detail: outcome.detail } };
        ctx.logger?.warn?.('w2m: bootstrap kept the configured relay (' + outcome.reason_code + ': ' + outcome.detail + ')');
      }
    } catch (error) {
      cfg.bootstrap = { configured: true, url: cfg.bootstrapUrl, source: null, relays: [], expires_at: null, last_error: { reason_code: 'BOOTSTRAP_ERROR', detail: error instanceof Error ? error.message : String(error) } };
      ctx.logger?.warn?.('w2m: bootstrap failed (' + (error instanceof Error ? error.message : String(error)) + ')');
    }
  } else if (cfg.bootstrap === undefined) {
    cfg.bootstrap = { configured: typeof cfg.bootstrapUrl === 'string', url: cfg.bootstrapUrl ?? null, source: null, relays: [], expires_at: null, last_error: null };
  }

  const relayUrl = new URL('../../relay/server.mjs', import.meta.url);
  const agentUrl = new URL('../../agent/agent.mjs', import.meta.url);

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
     * `identity.machine_id`, so **`autoStartAgent: true` threw on its first call**  - the code path
     * that was supposed to bring an agent up had never run. That is why the fleet-join wire appeared
     * to be missing: the place it was meant to live could not be reached at all.
     *
     * Two more things were wrong with the shape:
     *
     *   * it created a **local relay** unconditionally. For a machine joining a shared fleet that
     *     is the opposite of what is wanted  - the machine must connect to the relay that already
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
    }

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
     * v0.8.12: **carry the loaded identity back onto the options.**
     *
     * `loadOrCreateIdentity()` returns `{ identity, path, created }` and does not mutate the options
     * it was given, but the `createAgent` call below reads `identityOptions.identity` -- so it was
     * passing `undefined`. `createAgent` rejects that by contract
     * (`agent.mjs`: `if (!identity?.machine_id) throw new TypeError(...)`), which means **the
     * in-process join path threw on every single start**: after `loadOrCreateIdentity` had already
     * created `device.json`, and before anything could possibly pair.
     *
     * That single line accounts for the whole observed symptom, and every earlier explanation was
     * reading the wreckage: `device.json` exists with `device_token: null` because the file is
     * created one line above the throw; nothing ever pairs because there is no agent to pair with;
     * and every authenticated call answers 401 because no token was ever obtained. The mtime that
     * never moved was not a missing write on the pairing path -- execution never reached it.
     *
     * The identity is carried on this object rather than passed alongside because the v0.8.6 rule is
     * that the *same* options must be used to write the token back.
     */
    identityOptions.identity = loaded.identity;

    /**
     * v3.5.8: build the one WebRTC pool this process owns, before the agent is created.
     *
     * The agent borrows it through the `webrtcPool` option; the dispatcher half reaches it through
     * `inProcessWebRtcPool`. A machine that also runs a separate agent process must not build this
     * pool here -- two pools on one machine id claim the same signaling role -- so `buildable` is
     * decided from explicit configuration and `inProcessWebRtcPool` stays null when the agent is not
     * started in-process.
     */
    let webrtcPool = null;
    if (cfg.webrtc?.buildable === true) {
      const keyLoad = loadDeviceKey(null, loaded.path);
      const relayTransport = createP2PTransport(cfg);
      const built = createWebRtcTransportPool({
        machineId: loaded.identity.machine_id,
        signalUrl: cfg.webrtc.signal_url,
        signalToken: cfg.webrtc.signal_token,
        deviceKey: keyLoad.key,
        deviceKeyDir: path.dirname(loaded.path),
        allowCreateDeviceKey: false,
        resolvePeerKey: createRelayPeerKeyResolver({ getJson: relayTransport.getJson }),
        providerCommand: cfg.webrtc.provider_command,
        providerArgs: cfg.webrtc.provider_args,
        providerCwd: cfg.webrtc.provider_cwd,
        iceServers: cfg.webrtc.ice_servers,
        preferP2p: cfg.webrtc.prefer_p2p,
        allowRelay: cfg.webrtc.allow_relay,
        maxRttMs: cfg.webrtc.max_rtt_ms,
        connectTimeoutMs: cfg.webrtc.connect_timeout_ms,
        handshakeTimeoutMs: cfg.webrtc.handshake_timeout_ms,
        peerTimeoutMs: cfg.webrtc.peer_timeout_ms,
        statsPollMs: cfg.webrtc.stats_poll_ms,
        maxFragmentBytes: cfg.webrtc.max_fragment_bytes,
      });
      if (built.ok === true) {
        webrtcPool = built.pool;
        inProcessWebRtcPool = built.pool;
        setSharedWebRtcPool(built.pool);
        ctx.logger?.info?.(`w2m: WebRTC pool ready (${cfg.webrtc.signal_url.replace(/token=[^&]*/, 'token=<redacted>')})`);
      } else {
        cfg.webrtc.reason = `WEBRTC_POOL_BAD_CONFIG: ${built.detail}`;
        ctx.logger?.warn?.(`w2m: WebRTC pool not built (${built.code}: ${built.detail})`);
      }
    } else if (cfg.webrtc?.reason) {
      ctx.logger?.info?.(`w2m: WebRTC data plane inactive: ${cfg.webrtc.reason}`);
    }

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

    // The seam exists so a test can assert the *join* half without starting a real agent; in
    // production `createAgentImpl` is null and this is exactly `createAgent` (see its declaration).
    const agent = await (createAgentImpl ?? createAgent)({
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
      // v1.2.6: on by default; a profile may turn it off for debugging, and the envelope then says `unredacted: true`.
      redactOutput: cfg.redactOutput !== false,
      // v3.5.8: WebRTC is the preferred direct result path; `deliver.mjs` falls back to UDP and
      // always posts the envelope to the relay. Null when this process built no pool.
      webrtcPool,
      webrtcDataMaxAttempts: cfg.webrtc?.data_max_attempts,
      webrtcAckTimeoutMs: cfg.webrtc?.ack_timeout_ms,
      webrtcRetryDelayMs: cfg.webrtc?.retry_delay_ms,
      webrtcResultBudgetMs: cfg.webrtc?.result_budget_ms,
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
    /**
     * The configured key, if any. Kept separate from the derived one because the two have different
     * lifetimes: a configured key is an operator decision that never changes, while a derived key is
     * something we keep trying to obtain.
     */
    const fleetKeyFromConfig = cfg.fleetKey ?? null;

    /**
     * The home for one account, or the reason it cannot be read.
     *
     * A missing file is an empty history. A corrupt file is **not**: under `home` policy it must
     * stop the derivation rather than silently mint a new account fleet.
     */
    const homeFor = (accountCode) => {
      if (fleetHomeFile === null) return { ok: true, entry: null, lastAccount: null };
      const read = readFleetHome(fleetHomeFile);
      if (read.ok !== true) return { ok: false, error: read };
      return { ok: true, entry: getFleetHome(read.homes, accountCode), lastAccount: read.lastAccount };
    };

    /** Record the fleet this account is actually using; never overwrite a different remembered one. */
    const rememberHome = (accountCode, fleetKey) => {
      if (fleetHomeFile === null || typeof accountCode !== 'string' || accountCode === '') return;
      const written = rememberFleetHome(fleetHomeFile, { accountCode, fleetKey, lastAccount: accountCode });
      if (written.ok !== true) {
        ctx.logger?.warn?.(`w2m: could not record the fleet home (${written.code}: ${written.error})`);
      }
    };

    /** Record only the account, for the case where a guard kept the fleet unchanged. */
    const rememberAccount = (accountCode) => {
      if (fleetHomeFile === null || typeof accountCode !== 'string' || accountCode === '') return;
      const written = rememberFleetAccount(fleetHomeFile, accountCode);
      if (written.ok !== true) {
        ctx.logger?.warn?.(`w2m: could not record the last account (${written.code}: ${written.error})`);
      }
    };

    /**
     * How many derivation tries the **mount path** may spend.
     *
     * Two, not the six of v0.8.9: `agent.start()` waits behind this, and a tool that asks to join
     * waits behind it too. The patient retrying belongs in the background loop, where nothing is
     * blocked by it -- see {@link deriveFleetKeyOnce}.
     */
    const FAST_DERIVE_ATTEMPTS = 2;

    /**
     * One derivation attempt, with a bounded in-line retry.
     *
     * ## v0.8.12: fast at mount, patient in the background
     *
     * v0.8.9 gave the derivation six attempts and a 2 s -> 30 s backoff, which is right for a profile
     * that is a few seconds behind. It is **not** right for this host, and not only because the budget
     * expired: measured on DSH, the profile was still cold when those ~62 s ran out, so every attempt
     * answered `signed-out` on a machine that was demonstrably signed in (its model calls run through
     * the account). The window was spent before the thing it waited for had happened.
     *
     * It was also spent **in the mount path**, which `agent.start()` waits behind -- so the machine
     * had no agent for the first minute of its life, and any tool that tried to join would have waited
     * that long too.
     *
     * So the patience moves out of the critical path and into the retry loop beside the running
     * agent: `attempts` is small here (2 fast tries, ~2 s) and generous there (where nobody is
     * waiting). A tool call is never blocked by more than a couple of seconds, and a machine that
     * outlives the mount window still joins.
     *
     * @param {number} attempts How many tries to make before giving up and letting the caller retry.
     * @returns {Promise<{fleetKey: string|null, fleetKeySource: string|null, last: object|null}>}
     */
    async function deriveFleetKeyOnce(attempts = FAST_DERIVE_ATTEMPTS) {
      const configured = fleetKeyFromConfig;
      const hasExistingToken = typeof loaded?.identity?.device_token === 'string' && loaded.identity.device_token !== '';
      /**
       * v2.2.0: the configured key is a **fallback** unless the operator pins it.
       *
       * Before this, a key in the profile returned immediately and the account was never read.
       * That is why a machine with an old key stayed in the previous account's fleet even after
       * v2.1.10/v2.1.11 taught the binding code to compare and re-pair: it never got a new key to
       * compare with. The default policy now reads the account first; `fleetKeyPolicy: 'config'`
       * restores the explicit pin for fleets that outlive the signed-in account.
       */
      if (cfg.fleetKeyPolicy === 'config' && configured !== null) {
        return { fleetKey: configured, fleetKeySource: 'config', last: null };
      }

      // A configured key is a usable fallback, so do not spend the full retry budget before
      // using it. One account read is enough at mount; the watcher retries if the profile is cold.
      const effectiveAttempts = configured !== null ? 1 : attempts;
      let last = null;
      for (let attempt = 1; attempt <= effectiveAttempts; attempt += 1) {
        try {
          const { createAccountIdentity } = await import('../../chatops/account.mjs');
          last = await createAccountIdentity({ ctx, platform: process.platform }).resolve();
        } catch (error) {
          last = { ok: false, reason: 'threw', detail: error instanceof Error ? error.message : String(error) };
        }
        /**
         * The key is the question, not `ok`.
         *
         * `ok: false` with a key present is a real shape: a machine whose hardware fingerprint is
         * unreadable has no SN (so `resolve()` reports `no_hardware_source`), yet it still belongs to
         * its account's fleet and can still join it. Gating on `ok` here is what would have thrown
         * that key away a second time.
         */
        const derived = last && typeof last.fleetKey === 'string' && last.fleetKey !== '' ? last.fleetKey : null;
        if (derived !== null) {
          const remembered = homeFor(last.accountCode);
          if (remembered.ok !== true && cfg.fleetKeyPolicy === 'home') {
            ctx.logger?.warn?.(`w2m: fleet home is unreadable (${remembered.error.code}: ${remembered.error.error}); not deriving a replacement fleet`);
            return {
              fleetKey: null,
              fleetKeySource: null,
              fleetKeyReason: `fleet_home_unreadable: ${remembered.error.code}`,
              last,
            };
          }
          if (remembered.ok !== true) {
            ctx.logger?.warn?.(`w2m: fleet home is unreadable (${remembered.error.code}); continuing with the account key because policy is ${cfg.fleetKeyPolicy}`);
          }
          if (cfg.fleetKeyPolicy === 'home' && remembered.ok === true && remembered.entry === null) {
            const accountChanged = remembered.lastAccount !== null && remembered.lastAccount !== last.accountCode;
            if (configured !== null) {
              // A legacy explicit key is the only evidence of the fleet this machine was already in.
              // Seed the home with it rather than deriving an account fleet and moving the machine.
              rememberHome(last.accountCode, configured);
              ctx.logger?.info?.(`w2m: first home for account ${last.accountCode} seeded from the configured fleet key`);
              return { fleetKey: configured, fleetKeySource: 'config', last };
            }
            if (shouldPreserveExistingFleet({
              policy: cfg.fleetKeyPolicy,
              hasHome: false,
              hasConfiguredKey: false,
              hasToken: hasExistingToken,
              accountChanged,
            })) {
              rememberAccount(last.accountCode);
              ctx.logger?.warn?.(
                'w2m: this machine is paired but has no fleet home for this account, so it will stay in its current fleet; '
                + 'set the old fleetKey to seed a home (do not derive a new account fleet)',
              );
              return {
                fleetKey: null,
                fleetKeySource: null,
                fleetKeyReason: 'home_missing_existing_token',
                last,
              };
            }
          }
          const picked = selectFleetKey({
            configured,
            account: derived,
            home: remembered.ok === true ? remembered.entry?.fleet_key ?? null : null,
            policy: cfg.fleetKeyPolicy,
          });
          if (picked.fleetKey !== null) {
            if (picked.source === 'home') {
              rememberAccount(last.accountCode);
              ctx.logger?.info?.(`w2m: returning to the fleet home for account ${last.accountCode}`);
            } else {
              if (configured !== null && configured !== derived) {
                ctx.logger?.warn?.('w2m: the signed-in account derives a different fleet than the configured fleetKey; following the account (set fleetKeyPolicy: config to pin the configured key, or home to return to this account’s previous fleet)');
              }
              ctx.logger?.info?.(
                `w2m: fleet key derived from the signed-in account on attempt ${attempt} (fleet ${last.accountCode})`
                + (last.ok === true ? '' : `; no serial number: ${last.reason ?? 'unknown reason'}`),
              );
              // First time this account is seen (or policy is explicitly account): remember the
              // fleet it actually joins. An existing home is never overwritten while policy is
              // account, so an opt-in to account following cannot destroy the history.
              if (remembered.ok === true && remembered.entry === null) rememberHome(last.accountCode, picked.fleetKey);
              else rememberAccount(last.accountCode);
            }
            return { fleetKey: picked.fleetKey, fleetKeySource: picked.source, last };
          }
        }
        if (attempt < effectiveAttempts) {
          const waitMs = Math.min(2000 * 2 ** (attempt - 1), 30000);
          ctx.logger?.info?.(`w2m: no fleet key yet (${describeIdentityFailure(last)}); retrying in ${waitMs}ms`);
          await new Promise((resolve) => { setTimeout(resolve, waitMs); });
        }
      }
      // Account unavailable: the configured key, if any, is the documented fallback.
      const fallback = selectFleetKey({ configured, account: null, policy: cfg.fleetKeyPolicy });
      if (fallback.fleetKey !== null) {
        ctx.logger?.warn?.('w2m: the signed-in account produced no fleet key; falling back to the configured fleetKey (mark it fleetKeyPolicy: config to make that choice explicit)');
      }
      // Not fatal: the caller may pair by code, and a later attempt may still succeed.
      return { fleetKey: fallback.fleetKey, fleetKeySource: fallback.source, last };
    }

    let { fleetKey, fleetKeySource, last: fleetKeyIdentity } = await deriveFleetKeyOnce();
    resolvedFleetKey.value = fleetKey;
    resolvedFleetKey.source = fleetKeySource;
    resolvedFleetKey.at = Date.now();
    resolvedFleetKey.accountCode = fleetKeyIdentity?.accountCode ?? null;

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
    let alreadyPaired = typeof existingToken === 'string' && existingToken !== '';

    /**
     * v1.7.4: a stored token is only "paired" for the relay that issued it.
     *
     * Moving the fleet to a new primary relay reuses device.json. The stored token belongs to the OLD
     * relay, the new one answers `401 UNAUTHORIZED: missing or invalid device_token`, and because the
     * startup path saw a token it skipped pairing entirely: every machine showed "the Rabbit refused
     * GET /v1/devices with HTTP 401 ... 无列表" and joined no fleet.
     *
     * Probe the configured relay with the stored token. An explicit 401/403 means the token is stale
     * FOR THIS RELAY, so drop it and pair again through the fleet key. Any other outcome (200, network
     * error, unexpected status) keeps the token -- a transient outage must not trigger a re-pair.
     */
    if (alreadyPaired) {
      const relayForToken = relay?.url ?? cfg.rabbitUrl;
      if (typeof relayForToken === 'string' && relayForToken !== '') {
        try {
          const probe = await fetch(relayForToken.replace(/\/+$/, '') + '/v1/devices', {
            headers: { authorization: 'Bearer ' + existingToken, accept: 'application/json' },
            signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(4000) : undefined,
          });
          if (probe.status === 401 || probe.status === 403) {
            alreadyPaired = false;
            loaded.identity.device_token = null;
            if (identityOptions.identity !== undefined && identityOptions.identity !== null) identityOptions.identity.device_token = null;
            ctx.logger?.warn?.('w2m: stored device token was rejected by ' + relayForToken + ' (HTTP ' + probe.status + '); pairing again with the fleet key');
          }
          /**
           * Compare the relay's binding with the fleet the **current** key derives.
           *
           * The old check ran only for a configured `fleetKey`, so the account-derived key
           * (the normal case) was never compared. That is the account-switch defect: the
           * stored token stays valid for the account that minted it, and the machine keeps
           * heartbeating into the previous account's fleet. `fleetId=null` was the only
           * rejoin trigger, so a non-null mismatch looked perfectly healthy.
           */
          const effectiveFleetKey = fleetKey ?? fleetKeyFromConfig;
          if (alreadyPaired && effectiveFleetKey !== null) {
            let expectedFleetId = null;
            try {
              const { planJoin } = await import('../../chatops/fleet-join.mjs');
              const plan = planJoin({ fleetKeyEncoded: effectiveFleetKey });
              if (plan.ok === true) expectedFleetId = plan.fleetId;
            } catch { /* malformed key: binding cannot be compared, keep the token */ }
            const binding = await diagnoseFleetBinding({
              relayUrl: relayForToken,
              token: existingToken,
              machineId: loaded.identity.machine_id,
              fleetKey: effectiveFleetKey,
              expectedFleetId,
            });
            if (shouldRejoin({ token: existingToken, fleetId: binding.fleet_id, fleetKey: effectiveFleetKey, expectedFleetId })) {
              alreadyPaired = false;
              loaded.identity.device_token = null;
              if (identityOptions.identity !== undefined && identityOptions.identity !== null) identityOptions.identity.device_token = null;
              ctx.logger?.warn?.(
                `w2m: fleet binding changed (relay=${binding.fleet_id ?? 'none'}, account=${expectedFleetId ?? 'unknown'}); `
                + `re-admitting with the ${fleetKeySource === 'config' ? 'configured' : 'account-derived'} fleet key`,
              );
            }
          }
        } catch { /* network error: keep the token, do not force a re-pair */ }
      }
    }

    /**
     * Pair with the key that is in hand, and **persist the token**.
     *
     * Split out of the mount path so a later attempt can run the same code. The v0.8.6 note still
     * applies verbatim: `agent.pair` sets `device_token` on its in-memory object only, and without
     * the write below the observable behaviour is a machine the relay has registered, that then
     * answers `401` to every authenticated call because `device.json` still says `null`.
     *
     * @param {string|null} key - Derived or configured fleet key, when one is available.
     * @returns {Promise<{paired: boolean, by: string|null}>}
     */
    async function pairNow(key) {
      const by = key !== null ? `fleet key (${key === fleetKeyFromConfig ? 'config' : 'account'})`
        : cfg.pairingCode ? 'pairing code' : null;
      if (by === null) return { paired: false, by: null };
      try {
        const paired = await agent.pair(cfg.pairingCode ?? null, undefined, key);
        try {
          saveDeviceToken(paired?.device_token, identityOptions);
          ctx.logger?.info?.(`w2m: device token persisted to ${loaded.path}`);
        } catch (error) {
          // Named rather than silent: a machine that paired but cannot authenticate is the exact
          // failure v0.8.6 exists to remove, and it must not be quiet a second time.
          ctx.logger?.warn?.(
            'w2m: paired but the device token could NOT be persisted ('
            + `${error instanceof Error ? error.message : String(error)}) -- this machine will answer `
            + '401 to every authenticated call until that is fixed',
          );
          return { paired: false, by };
        }
        ctx.logger?.info?.(`w2m: paired by ${by}`);
        return { paired: true, by };
      } catch (error) {
        /**
         * The failure is classified here, where the reason still exists.
         *
         * v1.1.6 adds a second joining path (account fingerprint + member approval) that may only take over when the
         * FIRST path cannot work -- an invalid pairing code, an unreachable relay, a timeout. Anything else (a config
         * error, a permission refusal) needs a human, and moving the machine between mechanisms would hide that. The
         * classifier owns that rule; this only has to stop discarding the error before it can be read.
         */
        const reason = error?.reason_code ?? error?.code ?? null;
        const degrade = shouldDegrade(reason);
        if (degrade === true && key !== null) {
          /**
           * v1.1.15: the fallback path, finally called.
           *
           * Two invariants are load-bearing here:
           *
           * 1. the seed is the FLEET KEY, never the account code -- the account code is written to the log two
           *    hundred lines above, and deriving a signing key from a value anyone can read would hand out the
           *    account's identity;
           * 2. the machine id comes from the agent object that is already in this scope, not from device.json --
           *    this machine never paired, so it has no device.json, which is the entire situation.
           *
           * A failure here does not change the outcome of the old attempt: the caller still sees
           * `{paired: false, degrade: true}` and can retry later. It must not throw out of this catch block.
           */
          try {
            const localMachineId = typeof agent?.runtime?.machineId === 'string' ? agent.runtime.machineId
              : (typeof agent?.machineId === 'string' ? agent.machineId : '');
            if (localMachineId !== '') {
              const joined = await joinByAccount({
                request,
                identity: deriveAccountKeypair(key),
                machine: { machine_id: localMachineId, machine_name: cfg.machineName ?? null },
                maxPolls: 10,
              });
              if (joined.ok === true && typeof joined.device_token === 'string') {
                saveDeviceToken(joined.device_token, identityOptions);
                ctx.logger?.info?.('w2m: joined by account admission (' + joined.state + ')');
                return { paired: true, by: 'account-admission' };
              }
              ctx.logger?.warn?.('w2m: account admission did not admit this machine (' + joined.state + (joined.code ? '/' + joined.code : '') + ')');
            } else {
              ctx.logger?.warn?.('w2m: no local machine id, so the account-admission fallback cannot ask to join');
            }
          } catch (fallbackError) {
            ctx.logger?.warn?.('w2m: account-admission fallback failed: ' + (fallbackError instanceof Error ? fallbackError.message : String(fallbackError)));
          }
        }
        ctx.logger?.warn?.(`w2m: pairing by ${by} failed${reason === null ? '' : ' (' + String(reason) + ')'}: ${error instanceof Error ? error.message : String(error)}`);
        return { paired: false, by, reason_code: reason, degrade };
      }
    }

    /**
     * v0.8.12: **join the fleet, once, however late it becomes possible -- but do not remember a
     * failure as if it were an answer.**
     *
     * ## The two halves, and why both are needed
     *
     * A **successful** join is memoised for the life of the process: a machine that holds a token has
     * nothing to gain from pairing again, and the relay allows five pairings a minute. That is the
     * v0.8.7 rule, kept.
     *
     * A **failed** join must NOT be memoised, because that is precisely the defect this replaces.
     * v0.8.9's attempt ran once and nothing remembered to retry; memoising a failure would reproduce
     * the same trap with better bookkeeping -- the machine would hold a rejected promise for ever and
     * never ask again, which is the "intermittent miss becomes permanent" failure v0.8.7 introduced
     * by accident.
     *
     * The rate limit is honoured by a **cooldown** rather than by permanence, and the cooldown applies
     * only when a pairing was actually **attempted**. "There is no fleet key yet" means the account
     * profile was not readable; nothing was sent, so there is nothing for `pair_rate_limit` to have an
     * opinion about, and making the next caller wait ten seconds for it costs the honest case -- the
     * tool call immediately after the account becomes readable is exactly the caller this release
     * exists to serve. Measured while writing this: with the keyless case cooled down too, the mount
     * attempt failed on a cold account and the very next tool call silently did nothing, which is the
     * reported symptom reproduced by its own fix.
     */
    const JOIN_COOLDOWN_MS = 10000;
    let joinPromise = null;
    let joinPromiseAt = 0;
    /** True when the last attempt failed without sending anything to the relay. */
    let joinLastWasKeyless = false;
    let joinSucceeded = false;
    let joinLastError = null;
    async function joinFleet() {
      if (joinSucceeded) return { paired: true, by: 'existing token' };
      const coolingDown = joinPromise !== null
        && !joinLastWasKeyless
        && Date.now() - joinPromiseAt < JOIN_COOLDOWN_MS;
      if (coolingDown) return joinPromise;
      joinPromiseAt = Date.now();
      joinPromise = (async () => {
        if (alreadyPaired) {
          joinSucceeded = true;
          ctx.logger?.info?.(`w2m: already paired (token in ${loaded.path}); not pairing again`);
          return { paired: true, by: 'existing token' };
        }
        // A missing key is re-derived here rather than only at mount: the account is a lazy cache,
        // so "not yet" is the normal first answer and time is the input that changes it.
        let key = fleetKey;
        let source = fleetKeySource;
        if (key === null) {
          const retry = await deriveFleetKeyOnce();
          key = retry.fleetKey;
          source = retry.fleetKeySource;
          if (key !== null) {
            fleetKey = key;
            fleetKeySource = source;
          } else {
            joinLastError = describeIdentityFailure(retry.last);
          }
        }
        if (key === null) {
          // Nothing was sent, so nothing is rate-limited: the next caller may try again at once.
          joinLastWasKeyless = true;
          joinSucceeded = false;
          joinLastError = joinLastError ?? 'no fleet key';
          return { paired: false, by: null };
        }
        joinLastWasKeyless = false;
        const outcome = await pairNow(key);
        if (outcome.paired) {
          joinSucceeded = true;
        } else {
          joinSucceeded = false;
          if (joinLastError === null) {
            joinLastError = key === null ? (joinLastError ?? 'no fleet key') : 'pairing refused';
          }
        }
        return outcome;
      })();
      return joinPromise;
    }

    /**
     * The tool layer's way back in: called when a tool finds the machine unpaired.
     *
     * A no-op when the account cannot be read is correct -- a machine that genuinely has no account
     * must not be handed a fleet, and `joinLastError` records why.
     */
    ensureFleetJoin = () => joinFleet();

    /**
     * Watch for an account switch while the process stays alive.
     *
     * The mount check repairs a switch that happened before start-up. This one covers the same
     * event without a restart: a different DeepSeek account signs in, the account service starts
     * returning a different user id, and the derived fleet key changes. The stored token is still
     * valid for the *previous* account, so without this the machine keeps heartbeating into the
     * old fleet -- the reported symptom. Re-pairing rotates the token and moves the machine.
     *
     * The account service is read on an interval rather than per request: it can touch the host's
     * profile store, and a switch is a human-paced event, not a per-dispatch one. An operator-set
     * `fleetKey` is not watched -- that is an explicit decision and must not be overwritten by
     * whichever account happens to be signed in.
     */
    const ACCOUNT_WATCH_MS = 60_000;
    let accountWatch = null;
    let accountWatchBusy = false;
    async function recheckAccountBinding() {
      if (accountWatchBusy || cfg.fleetKeyPolicy === 'config') return;
      accountWatchBusy = true;
      try {
        const { createAccountIdentity } = await import('../../chatops/account.mjs');
        const identity = await createAccountIdentity({ ctx, platform: process.platform }).resolve();
        const derived = typeof identity?.fleetKey === 'string' && identity.fleetKey !== '' ? identity.fleetKey : null;
        if (derived === null) return;
        const remembered = homeFor(identity.accountCode);
        if (remembered.ok !== true && cfg.fleetKeyPolicy === 'home') {
          ctx.logger?.warn?.(`w2m: account changed but the fleet home is unreadable (${remembered.error.code}); not switching fleets`);
          return;
        }
        if (remembered.ok !== true) {
          ctx.logger?.warn?.(`w2m: fleet home is unreadable (${remembered.error.code}); continuing with the account key because policy is ${cfg.fleetKeyPolicy}`);
        }
        const hasExistingToken = typeof loaded?.identity?.device_token === 'string' && loaded.identity.device_token !== '';
        const accountChanged = remembered.ok === true
          && remembered.lastAccount !== null
          && identity.accountCode !== remembered.lastAccount;
        if (shouldPreserveExistingFleet({
          policy: cfg.fleetKeyPolicy,
          hasHome: remembered.ok === true && remembered.entry !== null,
          hasConfiguredKey: fleetKeyFromConfig !== null,
          hasToken: hasExistingToken,
          accountChanged,
        })) {
          // Upgrading a paired machine with no home must not move it. A real account switch is
          // different: rule 1 says the first appearance of account B may join B's fleet.
          if (remembered.lastAccount === null) rememberAccount(identity.accountCode);
          ctx.logger?.warn?.('w2m: this machine has no fleet home and the account did not change; staying in its current fleet');
          return;
        }
        const picked = selectFleetKey({
          configured: fleetKeyFromConfig,
          account: derived,
          home: remembered.ok === true ? remembered.entry?.fleet_key ?? null : null,
          policy: cfg.fleetKeyPolicy,
        });
        if (picked.fleetKey === null || picked.fleetKey === fleetKey) return;
        if (picked.source === 'home') {
          rememberAccount(identity.accountCode);
          ctx.logger?.warn?.(`w2m: the signed-in account changed; returning to this account’s fleet home (${identity.accountCode})`);
        } else {
          ctx.logger?.warn?.('w2m: the signed-in account changed; first time for this account, joining its fleet (other machines are not moved)');
          if (remembered.ok === true && remembered.entry === null) rememberHome(identity.accountCode, picked.fleetKey);
          else rememberAccount(identity.accountCode);
        }
        fleetKey = picked.fleetKey;
        fleetKeySource = picked.source;
        resolvedFleetKey.value = picked.fleetKey;
        resolvedFleetKey.source = picked.source;
        resolvedFleetKey.at = Date.now();
        resolvedFleetKey.accountCode = identity.accountCode ?? resolvedFleetKey.accountCode;
        alreadyPaired = false;
        joinSucceeded = false;
        joinPromise = null;
        joinLastError = null;
        joinLastWasKeyless = false;
        loaded.identity.device_token = null;
        if (identityOptions.identity !== undefined && identityOptions.identity !== null) identityOptions.identity.device_token = null;
        const outcome = await joinFleet();
        if (outcome.paired !== true) scheduleJoinRetry();
      } catch (error) {
        ctx.logger?.warn?.('w2m: account re-check failed: ' + (error instanceof Error ? error.message : String(error)));
      } finally {
        accountWatchBusy = false;
      }
    }
    accountWatch = setInterval(() => { void recheckAccountBinding(); }, ACCOUNT_WATCH_MS);
    accountWatch.unref?.();

    if (alreadyPaired) {
      joinSucceeded = true;
      joinPromise = Promise.resolve({ paired: true, by: 'existing token' });
      ctx.logger?.info?.(`w2m: already paired (token in ${loaded.path}); not pairing again`);
    } else {
      await joinFleet();
      if (fleetKey === null && fleetKeyFromConfig === null && cfg.pairingCode == null) {
        // The state the whole series has been about: signed in, reachable, and in no fleet. One line
        // that says so -- and says it once. The retry loop below, and any tool call, will try again;
        // this line exists so the moment of failure is not silent.
        ctx.logger?.warn?.(
          `w2m: not in a fleet yet (${joinLastError ?? 'no fleet key'}) -- the account profile is `
          + 'read on demand and may still be loading; this machine will join as soon as it answers',
        );
      }
    }

    // v1.6.9: the agent DOES come up, but on macOS its `start()` promise was observed to stay
    // pending forever (stage log: "before agent.start" was the last line written). Awaiting it blocked
    // everything after this point — including the failover monitor installed by startFailoverStack,
    // which is why automatic relay failover never engaged: the monitor was never created.
    //
    // The mount does not need to OBSERVE the start to be complete: the agent announces itself through
    // the relay, and the value startFailoverStack needs from this function is the cleanup handle. So
    // start it in the background and record a failure instead of hanging the whole stack.
    agent.start().then(
      () => ctx.logger?.info?.('w2m: agent started as ' + JSON.stringify(agentIdentityOf(agent))),
      (error) => ctx.logger?.warn?.('w2m: agent start failed: ' + (error instanceof Error ? error.message : String(error))),
    );

    /**
     * v0.8.12: **keep trying to join after mount.**
     *
     * The mount path runs before this host has read the account profile, and the profile read is on
     * demand, so a single window -- however generously retried inside it -- is a bet on a timing
     * nobody controls. Measured here: 0.8.9's ~62 s budget expired while the profile was still cold,
     * and because nothing re-attempted afterwards the machine stayed in no fleet for the rest of the
     * process's life. The account answered minutes later; there was simply nobody left asking.
     *
     * So the retry moves out of the mount window and beside the running agent, at a cadence that
     * cannot annoy the relay: `joinFleet` is memoised, so a successful join ends this loop, and one
     * attempt per escalation is all it can ever produce. It stops after `joinRetryLimit` tries rather
     * than polling forever -- a machine with no account is a state to report, not to hammer.
     */
    const joinRetryLimit = 30;
    let joinRetryTimer = null;
    let joinRetryCount = 0;
    let joinRetryDelayMs = 15000;
    function clearJoinRetry() {
      if (joinRetryTimer !== null) {
        clearTimeout(joinRetryTimer);
        joinRetryTimer = null;
      }
    }
    function scheduleJoinRetry() {
      clearJoinRetry();
      if (joinRetryCount >= joinRetryLimit) {
        ctx.logger?.warn?.(
          `w2m: gave up trying to join after ${joinRetryCount} attempts (${joinLastError ?? 'no reason recorded'}); `
          + 'this machine is in NO fleet and will receive no work',
        );
        return;
      }
      joinRetryCount += 1;
      const delay = joinRetryDelayMs;
      joinRetryDelayMs = Math.min(Math.round(joinRetryDelayMs * 1.5), 120000);
      joinRetryTimer = setTimeout(() => {
        joinRetryTimer = null;
        // `joinFleet` resolves rather than throws for every outcome it can name, but a retry loop is
        // exactly the place an unforeseen throw would become an unhandled rejection and take the
        // process down -- so it is caught here as well.
        joinFleet().then((outcome) => {
          if (!outcome.paired) scheduleJoinRetry();
        }).catch((error) => {
          joinLastError = error instanceof Error ? error.message : String(error);
          scheduleJoinRetry();
        });
      }, delay);
      joinRetryTimer.unref?.();
    }
    if (!alreadyPaired) scheduleJoinRetry();

    // §8.2: when the agent runs inside this process its `rttMs` is reachable directly, so `w2m_status`
    // can report it without a file. When the agent is its own process this stays null and the tool
    // says so instead of guessing.
    //
    // v0.9.0: **this assignment is the whole feature, and it was missing.**
    //
    // The getter was built and then dropped on the floor, so `inProcessAgentStatus` stayed `null` for
    // the life of the process. `readRtt` opens with `if (inProcessAgentStatus)` and skips the entire
    // in-process branch when it is null -- so it fell through to reading a state file, and reported
    //
    //   no agent round-trip time is available: the agent is not running in this process and no agent
    //   state file was found under <stateDir>
    //
    // on a machine whose agent *was* in that process and *was* publishing that file. The wording is
    // wrong twice over, and it is wrong in the direction that costs the most: it tells the reader to
    // doubt the agent, on the one call they make to find out what is actually happening.
    //
    // This is the defect shape the release notes keep recording -- *the record was created and the
    // part that makes it useful was not filled in* -- and it is the same shape as the identity line
    // fixed above. ESLint's `no-unused-vars` is what surfaced it: the variable was read nowhere
    // because nothing was ever assigned to the thing it was meant to feed.
    const statusGetter = agent.status ?? agent.state ?? null;
    if (typeof statusGetter === 'function') inProcessAgentStatus = statusGetter;

  return async () => {
    clearJoinRetry();
    if (accountWatch !== null) {
      clearInterval(accountWatch);
      accountWatch = null;
    }
    ensureFleetJoin = null;
    inProcessAgentStatus = null;
    inProcessWebRtcPool = null;
    setSharedWebRtcPool(null);
    await agent.stop();
    if (webrtcPool !== null) {
      try {
        await webrtcPool.stop();
      } catch (error) {
        ctx.logger?.warn?.('w2m: WebRTC pool close failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    // v1.6.7: `relay` is only a real relay object when THIS stack started a local relay; a remote-
    // relay stack has null here. The unconditional close() threw, which is what made the first
    // failover attempt stop the stack and never restart it.
    if (relay !== null && typeof relay.close === 'function') {
      try { await relay.close(); } catch (error) {
        ctx.logger?.warn?.('w2m: local relay close failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  };
}
