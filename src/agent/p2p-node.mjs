/**
 * P2PNode — one UDP socket, its rendezvous, and nothing else.
 *
 * v0.4.0 makes the direct path the default way two machines talk, with the relay kept
 * as the fallback. `src/agent/p2p.mjs` supplies the primitives (punching, the reliable
 * channel) and `src/agent/stun.mjs` supplies reflexive discovery. What was missing is
 * the piece that *owns* them for a whole process lifetime: bind one socket, discover
 * the address a peer can reach us on, publish that address through the relay, punch out
 * on demand, and accept punches that arrive — with every failure named and none of them
 * fatal, because the relay path is always still there.
 *
 * Mode semantics. These are the contract, not an implementation detail, so they are
 * stated here and asserted in `test/p2p-node.test.mjs`:
 *
 * | mode     | dispatcher (plugin)                                                   | executor (Localside)                                                        |
 * | -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
 * | `auto`   | punch and push the offer directly; the relay's offer stays a fallback | accepts an offer from either path; a duplicate `task_id`+`attempt` already seen is never executed twice |
 * | `direct` | same as `auto`, but a failed punch is not hidden                      | refuses an offer that did not arrive over the direct path: `refused` / `P2P_UNAVAILABLE` |
 * | `relay`  | never dials, and no UDP socket is bound at all                        | identical to v0.3.9                                                         |
 *
 * `relay` is a total absence of the direct path, not a degraded version of it: this
 * class is the only thing in the agent that creates a UDP socket, so `start()` on a
 * `relay` node returns before it touches `dgram` and nothing is bound. That is what
 * makes the setting usable as a mechanical check rather than a promise
 * (`test/outbound-only.test.mjs` leans on exactly this).
 *
 * What this node deliberately does **not** do:
 *
 *   * **It does not parse payloads.** A channel carries opaque bytes; the W2M
 *     convention is that the bytes are the relay's own JSON frames (`task.offer`,
 *     `task.result`, `result.ack`), but the node has no opinion about them. The
 *     moment it understood a frame it would need to know about tasks, and the task
 *     layer is where transport and scheduling policy belong.
 *   * **It does not decide.** A failed punch is reported with its named code and the
 *     caller falls back to the relay — explicitly. There is no silent retry over the
 *     relay from inside `dial()`, because "which path won" is a fact the result
 *     envelope has to state (§6 of the v0.4.0 contract).
 *
 * Failures never throw out of `start()`, `announceNow()`, `dial()` or `close()`. The
 * one exception is the constructor, which rejects a mode, a missing `machineId` or a
 * bad tuning key with a `TypeError`: a node configured wrongly is a bug in the caller,
 * and that is worth failing at the call site rather than 20 seconds later.
 */

import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';

import { accept, connect, deriveSession } from './p2p.mjs';
import {
  bindUdpSocket as bindUdpSocketDefault,
  discoverReflexive as discoverReflexiveDefault,
} from './stun.mjs';

/**
 * The three modes, in one place, frozen. The relay validates `p2p.mode` against this
 * same list (§5), and the mode is echoed verbatim into result envelopes, so the
 * strings are wire values rather than local labels.
 */
export const P2P_MODES = Object.freeze(['auto', 'direct', 'relay']);

/** The default is the direct path with the relay kept as the fallback. */
export const DEFAULT_P2P_MODE = 'auto';

/**
 * Validate a mode. Loud and total: anything that is not exactly one of
 * {@link P2P_MODES} is a configuration error with a named reason, never a silent
 * fallback to the default.
 *
 * **Case-insensitive matching is deliberately not allowed.** `auto` and `AUTO` look
 * like the same word, but this value is compared with `===` by the relay's request
 * validator and is copied into the stored task aggregate and the report; accepting a
 * variant here would put a value on the wire that the receiving end refuses, turning a
 * typo into a mysterious `BAD_REQUEST` several layers away. The rejection names the
 * canonical spelling instead.
 *
 * Whitespace is treated the same way and for the same reason — `' auto '` came from a
 * config file or an environment variable, and the surrounding bytes are part of the
 * value whether the caller meant them or not.
 *
 * @param {unknown} value
 * @returns {{ok:true, mode:string}|{ok:false, reason:string}} `reason` always begins
 *   with a `P2P_MODE_*` code followed by `: ` and a message naming the offending value.
 */
export function normalizeP2PMode(value) {
  if (value === undefined || value === null) {
    return { ok: false, reason: `P2P_MODE_MISSING: the mode is required (one of ${P2P_MODES.join(', ')})` };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      reason: `P2P_MODE_NOT_A_STRING: expected one of ${P2P_MODES.join(', ')}, got ${typeof value}`,
    };
  }
  if (value === '') {
    return {
      ok: false,
      reason: `P2P_MODE_EMPTY: the mode is an empty string (one of ${P2P_MODES.join(', ')})`,
    };
  }
  if (P2P_MODES.includes(value)) return { ok: true, mode: value };

  const trimmed = value.trim();
  if (trimmed !== value && P2P_MODES.includes(trimmed)) {
    return {
      ok: false,
      reason: `P2P_MODE_WHITESPACE: ${JSON.stringify(value)} has surrounding whitespace; write ${JSON.stringify(trimmed)}`,
    };
  }
  if (P2P_MODES.includes(trimmed.toLowerCase())) {
    return {
      ok: false,
      reason: `P2P_MODE_NOT_LOWERCASE: ${JSON.stringify(value)} is not lower-case; write ${JSON.stringify(trimmed.toLowerCase())}`,
    };
  }
  return {
    ok: false,
    reason: `P2P_MODE_UNKNOWN: ${JSON.stringify(value)} is not one of ${P2P_MODES.join(', ')}`,
  };
}

/**
 * Validate a **fixed** local UDP port for the punch socket.
 *
 * The node binds an ephemeral port by default, and that is the right default for a machine that
 * only ever *dials*: nothing has to reach it, so nothing has to be predictable. It is the wrong
 * one for a machine that must **accept** a punch through a firewall, because the port changes on
 * every restart and the `ufw allow <port>/udp` rule has to be re-pointed each time; until it is,
 * every dispatch falls back to the relay. This helper is how a caller states a stable port, and
 * both the CLI and the agent go through it so the two cannot disagree about what is legal.
 *
 * `null`/`undefined` means "an ephemeral port" and is the default. A numeric string is accepted
 * (an environment variable arrives as one) but anything non-canonical -- `'0x10'`, `'1e3'`,
 * `'abc'`, `''` -- is refused rather than coerced, because `Number()` would happily turn two of
 * those into a port nobody wrote.
 *
 * `0` is refused on purpose even though {@link P2PNode}'s own `bindPort` accepts it as
 * "ephemeral": an operator who *writes* `0` is asking for a fixed port and would silently get a
 * random one, which is exactly the failure this setting exists to remove.
 *
 * @param {unknown} value
 * @returns {{ok:true, port:number|null}|{ok:false, reason:string}} `reason` always begins with a
 *   `P2P_PORT_*` code followed by `: ` and a message naming the offending value.
 */
export function normalizeP2PPort(value) {
  if (value === undefined || value === null) return { ok: true, port: null };

  let candidate = value;
  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (text === '') {
      return {
        ok: false,
        reason: 'P2P_PORT_EMPTY: the port is an empty string (omit the setting for an ephemeral port)',
      };
    }
    if (!/^\d+$/.test(text)) {
      return {
        ok: false,
        reason: `P2P_PORT_NOT_AN_INTEGER: ${JSON.stringify(candidate)} is not an integer in 1..65535 (omit the setting for an ephemeral port)`,
      };
    }
    candidate = Number(text);
  }

  if (typeof candidate !== 'number' || !Number.isInteger(candidate)) {
    return {
      ok: false,
      reason: `P2P_PORT_NOT_AN_INTEGER: ${String(value)} is not an integer in 1..65535 (omit the setting for an ephemeral port)`,
    };
  }
  if (candidate === 0) {
    return {
      ok: false,
      reason:
        'P2P_PORT_ZERO: 0 selects an ephemeral port, which changes on every restart and has to be re-allowed through the firewall; give a fixed port in 1..65535, or omit the setting',
    };
  }
  if (candidate < 1 || candidate > 65535) {
    return { ok: false, reason: `P2P_PORT_OUT_OF_RANGE: ${candidate} is not in 1..65535` };
  }
  return { ok: true, port: candidate };
}

/**
 * The one server every W2M machine can rendezvous through.
 *
 * It hosts the relay, a STUN server and a reverse proxy on the same host, which is why
 * its STUN entry leads {@link PUBLIC_STUN_SERVERS}: a machine that can reach the relay
 * can reach this STUN server, so the reflexive address it reports is measured over the
 * same path the punch will use. The public servers behind it are there for the day the
 * shared host is unreachable.
 */
export const SHARED_SERVER = Object.freeze({
  host: '202.182.123.154',
  rabbitUrl: 'http://202.182.123.154:8787',
  stun: '202.182.123.154:3478',
});

/**
 * Public fallbacks, used only after the shared server.
 *
 * Two different operators on purpose: NAT mapping can only be classified by comparing
 * what *different* destinations see, and two hostnames that resolve to the same anycast
 * address would defeat that comparison.
 */
export const PUBLIC_STUN_SERVERS = Object.freeze([
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302',
  'stun.nextcloud.com:443',
]);

/**
 * Build a STUN server list: the shared server first, then the caller's own entries,
 * then the public fallbacks, de-duplicated while keeping the first occurrence.
 *
 * The shared server is *prepended* rather than replacing the defaults because the
 * ordering is the whole point: `discoverReflexive` queries sequentially and reports the
 * **first** answer as the reflexive address, so the server that shares a path with the
 * relay is asked before three public ones that may be on another continent.
 *
 * @param {string[]|string} [extra] Extra servers, or a comma-separated string (the
 *   shape `W2M_STUN_SERVERS` and `--stun-servers` arrive in).
 * @returns {string[]}
 */
export function stunServersWithShared(extra = []) {
  const list = typeof extra === 'string' ? extra.split(',') : extra;
  if (!Array.isArray(list)) {
    throw new TypeError(
      'stunServersWithShared: extra must be an array of "host:port" strings or a comma-separated string',
    );
  }
  const out = [];
  for (const entry of [SHARED_SERVER.stun, ...list, ...PUBLIC_STUN_SERVERS]) {
    if (entry === undefined || entry === null) continue;
    const spec = String(entry).trim();
    if (spec === '' || out.includes(spec)) continue;
    out.push(spec);
  }
  return out;
}

/**
 * Lifetimes and timeouts, in one frozen place so a caller can quote them and the
 * agent, the plugin and the CLI cannot drift apart.
 *
 * `announceTtlMs`/`refreshMs` are deliberately three refreshes per TTL: two consecutive
 * failures still leave a live announcement on the relay, which is what stops a blip in
 * one HTTP request from making a machine unreachable to its peers.
 */
export const P2P_DEFAULTS = Object.freeze({
  announceTtlMs: 60_000,
  refreshMs: 20_000,
  punchTimeoutMs: 5_000,
  acceptTimeoutMs: 5_000,
  /**
   * How long an executor may spend dialling a dispatcher it did not punch first.
   *
   * Deliberately longer than `punchTimeoutMs`. A punch between two peers that both expected it
   * succeeds in one round trip or not at all; a *reverse* dial is racing the other end's own
   * punch attempt and a NAT filter that only opens once the other side's packet has arrived, so
   * it needs room for several HELLO rounds. 8 s is the window the v0.4.x contract states, and it
   * is bounded on purpose: the relay copy of an offer and of a result is never held behind it.
   */
  reverseDialTimeoutMs: 8_000,
  maxCandidates: 8,
});

/** Mapping behaviours `discoverReflexive` can report, plus `null` for "never measured". */
const MAPPINGS = Object.freeze(['none', 'endpoint-independent', 'endpoint-dependent', 'unknown']);

/** The relay route this node announces on. A path, not a URL: the caller owns the base. */
const ANNOUNCE_PATH = '/v1/peer/announce';

/** Tuning keys a caller may override, so a typo cannot silently do nothing. */
const TUNING_KEYS = Object.freeze(Object.keys(P2P_DEFAULTS));

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Is `value` a dotted-quad IPv4 with no leading zeros?
 *
 * Duplicated from `src/relay/peers.mjs` on purpose: the agent must not import a relay
 * module (the direct path exists to bypass the relay), and the rule is not a local
 * preference — it is the relay's own admission rule for a candidate. Validating here
 * turns "the relay answered 400 and refused the whole announcement" into a local,
 * named decision, which is the difference between a diagnosable candidate list and a
 * punch at an address that was never usable.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
    if (match[i].length > 1 && match[i].startsWith('0')) return false;
  }
  return true;
}

/**
 * Is `address` an address only the local network can reach?
 *
 * RFC 1918 space plus link-local. Loopback and the wildcard are excluded: announcing
 * `127.0.0.1` to a peer tells it to punch itself, and announcing `0.0.0.0` gives it no
 * address at all — both would burn one of eight candidate slots on something that
 * cannot work.
 *
 * @param {string} address
 * @returns {boolean}
 */
function isPrivateIpv4(address) {
  if (!isIpv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 169 && b === 254;
}

/** @param {unknown} value @returns {{address:string, port:number}|null} */
function usableCandidate(value) {
  if (value === null || typeof value !== 'object') return null;
  const address = value.address;
  const port = value.port;
  // The wildcard is refused even though it is syntactically valid: a peer cannot send
  // to it, and the relay's validator would happily store it.
  if (!isIpv4(address) || address === '0.0.0.0') return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { address, port };
}

/**
 * The private IPv4 addresses of this machine, in interface order.
 *
 * Needed because a socket bound to the wildcard reports `0.0.0.0` for its own address,
 * which is not a destination. A punch that has to fall back to the local network needs
 * the addresses the socket is actually reachable at, and those live on the interfaces.
 *
 * @returns {string[]}
 */
function privateInterfaceAddresses() {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      // `family` is 'IPv4' on modern Node and 4 on ancient ones; both are cheap to accept.
      const family = entry.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (entry.internal || !isPrivateIpv4(entry.address)) continue;
      if (!out.includes(entry.address)) out.push(entry.address);
    }
  }
  return out;
}

/**
 * A node's own P2P lifecycle: one UDP socket, one announcement, one accept loop.
 *
 * Events:
 *
 *   * `'announce'` `{candidates, mapping, reflexive}` — the relay accepted an
 *     announcement. Emitted for the attempt that produced it, so a caller can wait for
 *     it instead of polling `status`, and emitted for a *degraded* announcement too (no
 *     reflexive address, so `reflexive` is null): the LAN candidate did reach the relay,
 *     and `status.announce_ok` is where "complete" is answered.
 *   * `'message'` `{from, channel, peer, session, payload}` — a payload arrived on a
 *     live channel. `from` is the peer's machine id when this node dialled it, and
 *     `null` for a channel that arrived inbound: the HELLO frame carries a session, not
 *     an identity, and the node refuses to guess one from an address.
 *   * `'error'` (Error) — an error was recorded. **Only emitted when a listener is
 *     attached.** Node's default is that an unhandled `'error'` event throws, which
 *     would turn a routine relay outage into a crashed host; every error is in
 *     `status.last_error` regardless, so a listenerless node loses nothing but the
 *     timing.
 *
 * `close()` is idempotent and `start()` may be called again afterwards: a node that
 * reconnects binds a fresh socket rather than keeping one bound to a port the OS may
 * since have handed to someone else. Everything is a returned object — `start()`,
 * `announceNow()`, `dial()` and `close()` never throw.
 */
export class P2PNode extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.mode] One of {@link P2P_MODES}; anything else throws.
   * @param {string|null} [options.rabbitUrl] Base URL of the relay. `null` means no
   *   signalling at all, which is legal only in `relay` mode: an `auto`/`direct` node
   *   that cannot announce would be silently unreachable, so `start()` refuses it by
   *   name instead.
   * @param {string} options.machineId This machine's id, from `device.json`.
   * @param {(path:string, body:object)=>Promise<object>} [options.postJson] Injected
   *   transport (`{ok, status, json, error}`). Required by `auto`/`direct`.
   * @param {(path:string)=>Promise<object>} [options.getJson] Same, for reads.
   * @param {string[]|string} [options.stunServers] The complete server list, in query
   *   order; a comma-separated string is accepted. Not merged with the shared server —
   *   a caller who names servers means those servers.
   * @param {Partial<typeof P2P_DEFAULTS>} [options.tuning] Overrides. Unknown keys
   *   throw rather than being ignored.
   * @param {(line:string)=>void} [options.log] Informational lines (no `console`).
   * @param {()=>number} [options.nowMs] Clock, so a caller can make time deterministic.
   * @param {(options:object)=>Promise<object>} [options.discover] Reflexive discovery;
   *   defaults to `discoverReflexive` from `./stun.mjs`. Injectable because a test
   *   needs a deterministic answer and a *specific* failure (see the STUN-unreachable
   *   case) without a network.
   * @param {(options?:object)=>Promise<{socket:object, local:{address:string,port:number}}>} [options.bindUdpSocket]
   *   Socket binder; defaults to `bindUdpSocket` from `./stun.mjs`. Injectable so a
   *   test can count binds — the assertion behind "`relay` binds no socket at all".
   *   It is called with `{address, port}` taken from `bindAddress` and `bindPort`
   *   below, so a caller can state the exact local endpoint.
   * @param {string} [options.bindAddress] Local address the punch socket binds,
   *   default `'0.0.0.0'` (every interface). A machine that must accept a punch from a
   *   peer on one network can narrow this, and the wildcard default is what makes the
   *   socket reachable on whichever interface the punch arrives at.
   * @param {number} [options.bindPort] Local UDP port the punch socket binds,
   *   `0` (default) meaning an ephemeral port. A **stable** port is what lets a
   *   firewall rule survive a restart: with an ephemeral port the operator has to
   *   re-allow the new port after every start, and until that is done every dispatch
   *   falls back to the relay. Must be an integer in `0..65535`; `0` is the only
   *   spelling that means "let the OS choose". Note that a port already in use makes
   *   `start()` return a `P2P_BIND_FAILED`, which is reported and never fatal.
   */
  constructor(options = {}) {
    super();
    const {
      mode = DEFAULT_P2P_MODE,
      rabbitUrl = null,
      machineId,
      postJson = null,
      getJson = null,
      stunServers = stunServersWithShared(),
      tuning = {},
      log = () => {},
      nowMs = () => Date.now(),
      discover = discoverReflexiveDefault,
      bindUdpSocket = bindUdpSocketDefault,
      bindAddress = '0.0.0.0',
      bindPort = 0,
    } = options;

    const normalized = normalizeP2PMode(mode);
    if (!normalized.ok) throw new TypeError(`P2PNode: ${normalized.reason}`);
    this.mode = normalized.mode;

    if (typeof machineId !== 'string' || machineId === '') {
      throw new TypeError('P2PNode: machineId is required (the machine id from device.json)');
    }
    this.machineId = machineId;
    this.rabbitUrl = rabbitUrl;

    for (const [name, value] of [
      ['postJson', postJson],
      ['getJson', getJson],
      ['log', log],
      ['nowMs', nowMs],
      ['discover', discover],
      ['bindUdpSocket', bindUdpSocket],
    ]) {
      if (value !== null && typeof value !== 'function') {
        throw new TypeError(`P2PNode: ${name} must be a function`);
      }
    }
    this.postJson = postJson;
    this.getJson = getJson;
    this.log = log;
    this.nowMs = nowMs;
    this.discover = discover;
    this.bindUdpSocket = bindUdpSocket;

    // The local endpoint is validated here rather than left to `dgram`, for the same reason the
    // mode is: a caller that wrote a nonsense address or a port outside the range has a bug at the
    // call site, and `socket.bind()` would report it as an opaque `EINVAL` twenty seconds later.
    if (typeof bindAddress !== 'string' || bindAddress.trim() === '') {
      throw new TypeError('P2PNode: bindAddress must be a non-empty local address string');
    }
    if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
      throw new TypeError(
        `P2PNode: bindPort must be an integer in 0..65535 (0 means an ephemeral port), got ${JSON.stringify(bindPort)}`,
      );
    }
    /** @type {string} Local address passed to the binder. */
    this.bindAddress = bindAddress;
    /** @type {number} Local port passed to the binder; 0 means an ephemeral one. */
    this.bindPort = bindPort;

    const unknownTuning = Object.keys(tuning).filter((key) => !TUNING_KEYS.includes(key));
    if (unknownTuning.length > 0) {
      throw new TypeError(
        `P2PNode: unknown tuning key(s) ${unknownTuning.join(', ')}; known keys are ${TUNING_KEYS.join(', ')}`,
      );
    }
    this.tuning = {};
    for (const key of TUNING_KEYS) {
      const value = tuning[key] ?? P2P_DEFAULTS[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`P2PNode: tuning.${key} must be a positive number, got ${JSON.stringify(value)}`);
      }
      this.tuning[key] = value;
    }

    const servers = typeof stunServers === 'string' ? stunServers.split(',') : stunServers;
    const serverList = Array.isArray(servers)
      ? servers.map((spec) => String(spec).trim()).filter((spec) => spec !== '')
      : [];
    if (serverList.length === 0) {
      throw new TypeError('P2PNode: stunServers must be a non-empty list of "host:port" strings');
    }
    this.stunServers = serverList;

    /** @type {import('node:dgram').Socket|null} Bound in start(), closed in close(). */
    this.socket = null;
    /** @type {{address:string, port:number}|null} */
    this.local = null;
    /** @type {{address:string, port:number}|null} */
    this.reflexive = null;
    /** @type {string|null} */
    this.mapping = null;
    /** @type {Array<{address:string, port:number}>} What the relay currently holds for us. */
    this.candidates = [];
    /** @type {string|null} */
    this.announcedAt = null;
    this.announceOk = false;
    this.announceFailures = 0;
    /** @type {string|null} */
    this.lastAnnounceError = null;
    this.punchesOut = 0;
    this.punchesIn = 0;
    this.dialFailures = 0;
    /** @type {string|null} */
    this.lastError = null;

    /** @type {Map<number, import('./p2p.mjs').P2PChannel>} Live channels, by session. */
    this.channels = new Map();
    /**
     * Sessions with a live channel. Handed to `accept()` so a repeated HELLO for a
     * session that is already open is re-acknowledged instead of being turned into a
     * second channel for the same session — two channels on one session would each
     * deliver every payload, and the peer would see every message twice.
     */
    this.claimed = new Set();

    this.started = false;
    /** @type {Promise<object>|null} In-flight start, so two callers cannot bind two sockets. */
    this.starting = null;
    /** @type {number} The generation `starting` belongs to; a stale one is not shared. */
    this.startingGeneration = -1;
    /** @type {object|null} In-flight announce, shared by concurrent callers. */
    this.announcing = null;
    /** @type {NodeJS.Timeout|null} */
    this.refreshTimer = null;
    /** @type {symbol|null} Identifies the current run; a stale loop/announce is ignored. */
    this.runToken = null;
    /** @type {Promise<void>|null} */
    this.acceptLoop = null;
    /**
     * Bumped by every `close()`. A `start()` that was mid-bind when the node closed
     * compares it afterwards, so a bind that lands late is closed instead of coming up
     * behind the caller's back — a socket and a timer no one owns is exactly the leak
     * `relay` mode exists to avoid.
     */
    this.generation = 0;
  }

  /** Is the direct path enabled at all? `relay` is the only mode where it is not. */
  isEnabled() {
    return this.mode !== 'relay';
  }

  /**
   * The node's public state. A plain object, rebuilt on every read: no caller can hold a
   * reference into the node's internals and mutate them.
   *
   * @returns {{mode:string, enabled:boolean, running:boolean, machine_id:string,
   *   rabbit_url:string|null, local:{address:string,port:number}|null,
   *   reflexive:{address:string,port:number}|null, mapping:string|null,
   *   candidates:Array<{address:string,port:number}>, announced_at:string|null,
   *   announce_ok:boolean, announce_failures:number, last_announce_error:string|null,
   *   punches_out:number, punches_in:number, dial_failures:number, last_error:string|null}}
   */
  get status() {
    return {
      mode: this.mode,
      enabled: this.isEnabled(),
      running: this.started,
      machine_id: this.machineId,
      rabbit_url: this.rabbitUrl,
      local: this.local === null ? null : { ...this.local },
      reflexive: this.reflexive === null ? null : { ...this.reflexive },
      mapping: this.mapping,
      candidates: this.candidates.map((candidate) => ({ ...candidate })),
      announced_at: this.announcedAt,
      announce_ok: this.announceOk,
      announce_failures: this.announceFailures,
      last_announce_error: this.lastAnnounceError,
      punches_out: this.punchesOut,
      punches_in: this.punchesIn,
      dial_failures: this.dialFailures,
      last_error: this.lastError,
    };
  }

  /**
   * Record an error: `status.last_error` always, the `'error'` event only if somebody
   * is listening. See the class comment for why the emit is guarded.
   *
   * @param {string} message A named code and a reason.
   */
  reportError(message) {
    this.lastError = message;
    this.log(`p2p: ${message}`);
    if (this.listenerCount('error') > 0) this.emit('error', new Error(message));
  }

  /**
   * Bring the node up: bind the socket, start the accept loop, and start announcing.
   *
   * The first announcement is *kicked off*, not awaited. Awaiting it would make every
   * caller pay for the STUN sweep — four servers, each with its own timeout when the
   * network drops UDP — before the agent could connect its stream, and nothing about
   * binding a socket depends on the answer. A caller that needs the announcement has
   * two honest ways to wait for it: the `'announce'` event, or `status.announced_at`.
   *
   * @returns {Promise<{ok:boolean, enabled:boolean, error:string|null}>} `enabled` is
   *   false only for `relay`; a failure here is reported, never thrown.
   */
  async start() {
    if (!this.isEnabled()) {
      // No socket, no loop, no timer. Not "started with the direct path off" — off.
      return { ok: true, enabled: false, error: null };
    }
    if (this.started) return { ok: true, enabled: true, error: null };
    const generation = this.generation;
    if (this.starting !== null && this.startingGeneration === generation) return this.starting;

    const attempt = this.performStart();
    const shared = attempt.finally(() => {
      // Only the start that is still current clears the slot, or a `close()`/restart
      // landing in between would cancel a newer start's sharing.
      if (this.starting === shared) this.starting = null;
    });
    this.starting = shared;
    this.startingGeneration = generation;
    return shared;
  }

  /** @returns {Promise<{ok:boolean, enabled:boolean, error:string|null}>} */
  async performStart() {
    if (typeof this.rabbitUrl !== 'string' || this.rabbitUrl === '' || typeof this.postJson !== 'function') {
      // Loud, and before binding anything: a socket that can never be announced is a
      // half-functioning node, and half-functioning is the failure mode this codebase
      // refuses everywhere else.
      const missing = typeof this.postJson !== 'function' ? 'postJson' : 'rabbitUrl';
      const error = `P2P_NO_SIGNALLING: ${missing} is missing, so mode "${this.mode}" could never announce its candidates`;
      this.reportError(error);
      return { ok: false, enabled: true, error };
    }

    const generation = this.generation;
    let bound;
    try {
      // The documented endpoint: `{address: '0.0.0.0', port: 0}` unless the caller stated a port
      // (and/or an address), which is what lets a firewall rule outlive a restart.
      bound = await this.bindUdpSocket({ address: this.bindAddress, port: this.bindPort });
    } catch (error) {
      const reason = `P2P_BIND_FAILED: ${messageOf(error)}`;
      this.reportError(reason);
      return { ok: false, enabled: true, error: reason };
    }

    const socket = bound.socket;
    const local = { address: bound.local.address, port: bound.local.port };
    if (this.generation !== generation) {
      // `close()` ran while the bind was in flight. The socket is real and unowned, so it
      // is closed here rather than left holding a port behind a node the caller believes
      // is stopped.
      try {
        socket.close();
      } catch {
        /* the bind failed after all */
      }
      const error = 'P2P_START_CANCELLED: the node was closed while its socket was being bound';
      this.log(`p2p: ${error}`);
      return { ok: false, enabled: true, error };
    }
    // A socket-level error (ICMP port unreachable after a punch at a dead port is the
    // usual one on Windows) is delivered on the socket itself. Without a listener it
    // would be an unhandled 'error' event, i.e. a thrown exception inside the runtime's
    // own emit — so it is listened for, recorded, and otherwise ignored: a transient
    // ICMP error does not make the socket unusable.
    socket.on('error', (error) => {
      this.reportError(`P2P_SOCKET_ERROR: ${messageOf(error)}`);
    });

    this.socket = socket;
    this.local = local;
    this.started = true;
    this.runToken = Symbol('p2p-run');

    this.refreshTimer = setInterval(() => {
      // `announceNow()` is written not to reject; the catch is here so a future edit
      // cannot turn a timer callback into an uncaught exception.
      this.announceNow().catch((error) => this.reportError(`P2P_ANNOUNCE_THREW: ${messageOf(error)}`));
    }, this.tuning.refreshMs);
    // Never keep a process alive: an agent that has finished its work must be able to
    // exit without waiting for the next refresh.
    this.refreshTimer.unref?.();

    this.acceptLoop = this.runAcceptLoop(this.runToken);
    this.announceNow().catch((error) => this.reportError(`P2P_ANNOUNCE_THREW: ${messageOf(error)}`));

    this.log(
      `p2p: ${this.mode} node on ${local.address}:${local.port}, announcing through ${this.rabbitUrl}`,
    );
    return { ok: true, enabled: true, error: null };
  }

  /**
   * Discover this machine's reachable addresses and publish them through the relay.
   *
   * STUN failing is **not** fatal. One unreachable STUN server must not stop a LAN
   * punch: when there is no reflexive address the local candidate is announced alone,
   * and the degradation is reported rather than hidden — `ok:false`, `announce_ok:false`
   * and the STUN error in `error`/`status.last_announce_error`, while the announcement
   * itself did reach the relay. Only a set with *no* usable address at all is refused,
   * because the relay rejects an empty candidate list and a machine that announced
   * nothing is worse than one that says it cannot.
   *
   * @returns {Promise<{ok:boolean, candidates:Array<{address:string,port:number}>,
   *   mapping:string|null, reflexive:{address:string,port:number}|null, error:string|null}>}
   *   `ok` means "this announcement is complete and live": the relay accepted it *and*
   *   a reflexive address was measured. It always equals `status.announce_ok`.
   */
  async announceNow() {
    const socket = this.socket;
    if (!this.isEnabled()) {
      return {
        ok: false,
        candidates: [],
        mapping: null,
        reflexive: null,
        error: 'P2P_DISABLED: mode "relay" never announces (the relay path is the only path)',
      };
    }
    if (socket === null || !this.started) {
      return {
        ok: false,
        candidates: [],
        mapping: null,
        reflexive: null,
        error: 'P2P_NODE_NOT_RUNNING: call start() before announcing',
      };
    }
    // Concurrent announces (a manual refresh landing on a timer tick) share one attempt
    // rather than racing: two POSTs would double the relay's load and let the older
    // answer overwrite the newer status.
    if (this.announcing !== null) return this.announcing;
    const run = this.runToken;
    const attempt = this.performAnnounce(socket, run);
    const shared = attempt.finally(() => {
      // Only the attempt that is still current clears the slot: a `close()` (or a restart)
      // may already have replaced it, and nulling the newer one would let a third caller
      // start a duplicate request.
      if (this.announcing === shared) this.announcing = null;
    });
    this.announcing = shared;
    return shared;
  }

  /**
   * @param {import('node:dgram').Socket} socket
   * @param {symbol|null} run
   * @returns {Promise<{ok:boolean, candidates:Array<{address:string,port:number}>,
   *   mapping:string|null, reflexive:{address:string,port:number}|null, error:string|null}>}
   */
  async performAnnounce(socket, run) {
    let discovery = null;
    try {
      discovery = await this.discover({ socket, servers: [...this.stunServers] });
    } catch (error) {
      discovery = {
        ok: false,
        reflexive: null,
        mapping: null,
        error: `STUN_DISCOVERY_THREW: ${messageOf(error)}`,
      };
    }

    const reflexive = usableCandidate(discovery?.reflexive);
    const discoveryOk = discovery?.ok === true && reflexive !== null;
    const discoveryError = discoveryOk
      ? null
      : typeof discovery?.error === 'string' && discovery.error !== ''
        ? discovery.error
        : 'STUN_NO_REFLEXIVE_ADDRESS: no discovery answer carried a usable address';
    const mapping = MAPPINGS.includes(discovery?.mapping)
      ? discovery.mapping
      : discoveryOk
        ? 'unknown'
        : null;

    const candidates = this.usableCandidates(reflexive);

    if (candidates.length === 0) {
      const error = `P2P_NO_CANDIDATES: nothing usable to announce (${discoveryError})`;
      this.publishAnnouncement({
        run,
        socket,
        candidates: [],
        mapping,
        reflexive,
        ok: false,
        error,
        posted: false,
      });
      return { ok: false, candidates: [], mapping, reflexive, error };
    }

    const body = {
      candidates: candidates.map((candidate) => ({ ...candidate })),
      nat: { mapping },
      ttl_ms: this.tuning.announceTtlMs,
    };

    let response = null;
    let postError = null;
    try {
      response = await this.postJson(ANNOUNCE_PATH, body);
    } catch (error) {
      postError = `P2P_ANNOUNCE_FAILED: ${messageOf(error)}`;
    }
    const posted = response?.ok === true;
    if (!posted && postError === null) postError = describeAnnounceFailure(response);

    // A POST failure is the headline when there is one: the announcement is not live at
    // all. Otherwise a discovery failure is what makes this announcement incomplete.
    const error = !posted ? postError : discoveryOk ? null : discoveryError;
    const ok = posted && discoveryOk;

    this.publishAnnouncement({ run, socket, candidates, mapping, reflexive, ok, error, posted });
    return {
      ok,
      candidates: candidates.map((candidate) => ({ ...candidate })),
      mapping,
      reflexive: reflexive === null ? null : { ...reflexive },
      error,
    };
  }

  /**
   * Write one finished attempt into the node's state.
   *
   * Skipped when the run has already ended (a `close()` or a restart happened while the
   * request was in flight): the caller still gets the result, but a closed node must not
   * claim a live announcement or hold a candidate list whose NAT mapping is gone.
   *
   * @param {object} attempt
   */
  publishAnnouncement(attempt) {
    // The attempt's outcome is decided, so the shared slot is released *before* anything is
    // published: a caller woken by the `'announce'` event must start a fresh attempt rather
    // than join a finished one. (The promise-level guard in `announceNow()` only stops a
    // stale attempt from clearing a newer one; this is what makes "the event fired" mean
    // "the attempt is over".)
    this.announcing = null;
    if (this.socket !== attempt.socket || this.runToken !== attempt.run) return;

    this.reflexive = attempt.reflexive;
    this.mapping = attempt.mapping;
    if (attempt.posted) {
      // What the relay holds for us, not what we measured: a failed POST leaves the
      // previous announcement live until its TTL expires.
      this.candidates = attempt.candidates;
      this.announcedAt = new Date(this.nowMs()).toISOString();
      // Emitted whenever the relay accepted the announcement — a degraded one (no
      // reflexive address, `reflexive: null`) included, because the LAN candidate is
      // live and a caller waiting for "we are announced" is right to proceed.
      this.emit('announce', {
        candidates: attempt.candidates.map((candidate) => ({ ...candidate })),
        mapping: attempt.mapping,
        reflexive: attempt.reflexive === null ? null : { ...attempt.reflexive },
      });
    }
    this.announceOk = attempt.ok;
    if (attempt.ok) {
      this.lastAnnounceError = null;
      return;
    }
    this.announceFailures += 1;
    this.lastAnnounceError = attempt.error;
    if (attempt.posted) {
      // Degraded, not broken: the LAN candidate is live, the reflexive address is not.
      // Recorded in `status`, deliberately not emitted as an `'error'`: the node is
      // working, and only the caller knows whether a missing public address matters.
      this.lastError = attempt.error;
      this.log(`p2p: announced without a reflexive address (${attempt.error})`);
      return;
    }
    this.reportError(attempt.error);
  }

  /**
   * The addresses to announce: the reflexive one first, then the local network ones,
   * de-duplicated and capped.
   *
   * @param {{address:string, port:number}|null} reflexive
   * @returns {Array<{address:string, port:number}>}
   */
  usableCandidates(reflexive) {
    const out = [];
    const seen = new Set();
    const push = (candidate) => {
      if (candidate === null || out.length >= this.tuning.maxCandidates) return;
      const key = `${candidate.address}:${candidate.port}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(candidate);
    };
    push(reflexive);
    for (const candidate of this.localCandidates()) push(candidate);
    return out;
  }

  /**
   * The socket's own address when it is a private IPv4, or — for the usual wildcard
   * bind, whose reported address is `0.0.0.0` and therefore not a destination — this
   * machine's private interface addresses, all on the socket's port.
   *
   * @returns {Array<{address:string, port:number}>}
   */
  localCandidates() {
    const local = this.local;
    if (local === null || !Number.isInteger(local.port) || local.port <= 0) return [];
    const addresses = [];
    if (isPrivateIpv4(local.address)) addresses.push(local.address);
    else if (local.address === '0.0.0.0') addresses.push(...privateInterfaceAddresses());
    return addresses.map((address) => ({ address, port: local.port }));
  }

  /**
   * Punch to a peer and return a channel on the opened path.
   *
   * Every failure is a returned `{ok:false, error}` with a named code; nothing throws,
   * including for a machine that has never announced (404 → `P2P_NO_CANDIDATES`) or one
   * that has announced an address nothing answers at (`P2P_PUNCH_TIMEOUT`).
   *
   * @param {string} machineId The peer's machine id.
   * @param {object} [options]
   * @param {number} [options.session] Agreed session id. Derived from the two machine
   *   ids when omitted — the responder adopts whatever the HELLO carries, so only the
   *   initiator has to pick one, and a caller with a task id should pass one derived
   *   from it so two concurrent tasks do not share a session.
   * @param {number} [options.timeoutMs] Punch deadline; default `tuning.punchTimeoutMs`.
   * @param {Array<{address:string, port:number}>} [options.candidates] Addresses to punch
   *   at, used **instead of** asking the relay. This is how an executor dials a dispatcher
   *   whose candidates travelled inside the offer (`p2p.candidates`): the offer is evidence
   *   the dispatcher itself produced moments ago, and a relay lookup would be a second,
   *   slower opinion about the same machine — one that answers 404 for a dispatcher whose
   *   announcement has already expired. The list is validated here exactly like the relay's
   *   answer is, so an offer cannot smuggle in a wildcard address or a zero port.
   * @param {number} [options.acceptTimeoutMs] Accepted for interface symmetry with
   *   {@link accept} and unused here: the initiator waits for the HELLO_ACK, which is
   *   the punch itself, and never waits to be accepted.
   * @returns {Promise<{ok:boolean, channel:import('./p2p.mjs').P2PChannel|null,
   *   peer:{address:string,port:number}|null, session:number, error:string|null,
   *   attempts:number, rttMs:number|null, peersAnnounced:number, reused:boolean}>}
   *   `peersAnnounced` is how many candidate addresses the caller (or the relay) held for
   *   that machine; `reused` says the session already had a live channel and no punch was
   *   needed, which is what keeps a simultaneous punch from producing two channels for one
   *   session — and therefore two deliveries of every message.
   */
  async dial(machineId, options = {}) {
    const empty = {
      ok: false,
      channel: null,
      peer: null,
      session: 0,
      error: null,
      attempts: 0,
      rttMs: null,
      peersAnnounced: 0,
      reused: false,
    };

    if (!this.isEnabled()) {
      return { ...empty, error: 'P2P_DISABLED: mode "relay" never dials (the relay path is the only path)' };
    }
    if (this.socket === null || !this.started) {
      return { ...empty, error: 'P2P_NODE_NOT_RUNNING: call start() before dial()' };
    }
    if (typeof machineId !== 'string' || machineId === '') {
      return { ...empty, error: "P2P_BAD_MACHINE_ID: dial() needs the peer's machine id" };
    }

    let session = options.session;
    if (session === undefined) {
      // Sorted so the value would still be identical if the other end ever derived it
      // too; only this end needs to, because the responder adopts the HELLO's id.
      session = deriveSession('p2p-dial', ...[this.machineId, machineId].sort());
    } else if (!Number.isInteger(session) || session < 1 || session > 0xffffffff) {
      return {
        ...empty,
        error: `P2P_BAD_SESSION: ${JSON.stringify(options.session)} is not an integer in 1..4294967295`,
      };
    }

    const socket = this.socket;
    const fail = (error, extra = {}) => {
      this.dialFailures += 1;
      this.reportError(error);
      return { ...empty, session, error, ...extra };
    };

    // "One session, one channel" is enforced where a simultaneous punch actually collides: after the
    // punch resolves, against whatever the accept loop claimed while it was in flight (see
    // `claimedMeanwhile` below and `adoptChannel`). There is deliberately no cheap pre-check here: a
    // caller that dials a session this node already holds is still punching, the far end
    // re-acknowledges it, and that contract is what the re-ack case in `test/p2p-node.test.mjs` pins
    // down. Suppressing the punch would change it to save one datagram.

    // `options.candidates` present and non-empty means "punch at these" -- an empty array is the same
    // statement as the field being absent ("nobody told me where"), and falls through to the relay.
    const fromOffer = Array.isArray(options.candidates) && options.candidates.length > 0;

    let announced = [];
    if (fromOffer) {
      announced = options.candidates;
    } else {
      if (typeof this.getJson !== 'function') {
        return { ...empty, error: "P2P_NO_GET_JSON: dial() needs getJson to read the peer's candidates" };
      }
      let lookup = null;
      try {
        lookup = await this.getJson(`/v1/peer/${encodeURIComponent(machineId)}`);
      } catch (error) {
        return fail(`P2P_LOOKUP_FAILED: ${messageOf(error)}`);
      }
      if (this.socket !== socket || !this.started) {
        return { ...empty, session, error: 'P2P_NODE_NOT_RUNNING: the node closed while dialling' };
      }
      if (lookup?.ok !== true) {
        if (lookup?.status === 404) {
          // A 404 is the relay saying "this machine has not announced" — an ordinary state
          // (the peer may be relay-only, or between refreshes), and it has its own code.
          return fail(`P2P_NO_CANDIDATES: the relay holds no live announcement for ${machineId}`);
        }
        return fail(`P2P_LOOKUP_FAILED: ${describeLookupFailure(lookup)}`);
      }
      announced = Array.isArray(lookup.json?.peer?.candidates) ? lookup.json.peer.candidates : [];
    }

    const remote = [];
    for (const candidate of announced) {
      const usable = usableCandidate(candidate);
      if (usable === null) continue;
      if (remote.some((entry) => entry.address === usable.address && entry.port === usable.port)) continue;
      remote.push(usable);
      if (remote.length >= this.tuning.maxCandidates) break;
    }
    if (remote.length === 0) {
      // `peersAnnounced` still counts what was offered, not what survived validation: a caller
      // reading "the punch failed" needs to see that there *was* a list, and that every entry in it
      // was unusable -- a wildcard address, a zero port -- rather than that nobody had an address.
      return fail(
        fromOffer
          ? `P2P_NO_CANDIDATES: the offer's candidate list for ${machineId} held no usable address`
          : `P2P_NO_CANDIDATES: ${machineId} announced no usable address`,
        { peersAnnounced: announced.length },
      );
    }

    let outcome = null;
    try {
      outcome = await connect({
        socket,
        remote,
        session,
        timeoutMs: options.timeoutMs ?? this.tuning.punchTimeoutMs,
      });
    } catch (error) {
      // `punch()` sends synchronously, and `dgram` throws from `send()` on a socket that
      // was closed underneath it — a close() racing a dial, in practice. dial() promises
      // never to throw, so that one is caught here and named like every other failure.
      return fail(`P2P_PUNCH_FAILED: ${messageOf(error)}`, {
        attempts: 0,
        rttMs: null,
        peersAnnounced: announced.length,
      });
    }
    if (!outcome.ok) {
      return fail(outcome.error ?? 'P2P_PUNCH_FAILED', {
        attempts: outcome.punch?.attempts ?? 0,
        rttMs: outcome.punch?.rttMs ?? null,
        peersAnnounced: announced.length,
      });
    }

    this.punchesOut += 1;
    // The accept loop may have claimed this session while the punch was in flight — the far end
    // dialled us at the same moment we dialled it, which is the whole point of a simultaneous
    // punch. Its channel is the better one: its peer is the address the far end's packet actually
    // came from, while ours is the address that end merely *announced*. Keep the observed one.
    const claimedMeanwhile = this.channels.get(session);
    if (claimedMeanwhile !== undefined && claimedMeanwhile !== outcome.channel) {
      try {
        // Silent: this is a duplicate local view of a live session, not the end of one. A BYE here
        // would close the peer's channel for the session the survivor is about to use.
        outcome.channel.close('session-claimed', { silent: true });
      } catch {
        /* the path is already gone */
      }
      return {
        ok: true,
        channel: claimedMeanwhile,
        peer: { ...claimedMeanwhile.peer },
        session,
        error: null,
        attempts: outcome.punch.attempts,
        rttMs: outcome.punch.rttMs,
        peersAnnounced: announced.length,
        reused: true,
      };
    }
    this.adoptChannel(outcome.channel, { from: machineId, session: outcome.channel.session });
    return {
      ok: true,
      channel: outcome.channel,
      peer: { ...outcome.channel.peer },
      session: outcome.channel.session,
      error: null,
      attempts: outcome.punch.attempts,
      rttMs: outcome.punch.rttMs,
      peersAnnounced: announced.length,
      reused: false,
    };
  }

  /**
   * Wire one channel into the node: deliver its payloads as `'message'` events, claim
   * its session, and drop the claim when it closes.
   *
   * **One session, one channel — enforced here, not assumed.** The map is keyed by session and a
   * second channel for a session already in it is *closed*, because `P2PChannel` filters incoming
   * datagrams by session alone: two live channels on one session would each assemble and deliver
   * every message of that session, so the caller would see each payload twice and `result_path`
   * would be decided by whichever listener was registered last. A simultaneous punch makes that
   * the normal case rather than a corner case, since both ends' HELLOs arrive while both are still
   * dialling. See `dial()`, which returns the surviving channel rather than the one it just opened.
   *
   * The claim is released on close on purpose. `claimed` means "this session has a live
   * channel"; a broken path has to be re-punchable with the same session, and holding
   * the claim after the channel is gone would silently refuse the peer's retry.
   *
   * @param {import('./p2p.mjs').P2PChannel} channel
   * @param {{from:string|null, session:number}} details
   */
  adoptChannel(channel, details) {
    const previous = this.channels.get(details.session);
    if (previous !== undefined && previous !== channel) {
      // Closed *before* the claim is taken: the old channel's own `'close'` handler deletes the
      // session from `claimed`, and running it after the new claim would drop a claim that is
      // still live -- which is the state that lets a peer open a second channel on this session.
      this.channels.delete(details.session);
      try {
        // Silent, for the same reason as the duplicate in `dial()`: the session is not over, it is
        // being represented by a better channel, and a BYE would close the peer's view of it.
        previous.close('session-replaced', { silent: true });
      } catch {
        /* the path is already gone; that is the state this replacement produces */
      }
    }
    this.channels.set(details.session, channel);
    this.claimed.add(details.session);
    channel.on('message', (payload) => {
      this.emit('message', {
        from: details.from,
        channel,
        peer: { ...channel.peer },
        session: details.session,
        payload,
      });
    });
    channel.on('close', () => {
      if (this.channels.get(details.session) === channel) this.channels.delete(details.session);
      // The claim belongs to whichever channel currently holds the session, so a *replaced*
      // channel's close must not drop a claim its replacement depends on.
      if (this.channels.get(details.session) === undefined) this.claimed.delete(details.session);
    });
    // P2PChannel documents an `'error'` event. Listening is not optional bookkeeping:
    // an unhandled `'error'` emit would throw, and the whole point of this node is that
    // a transport problem is a recorded fact rather than a crashing process.
    channel.on('error', (error) => {
      this.reportError(`P2P_CHANNEL_ERROR: ${messageOf(error)}`);
    });
  }

  /**
   * Wait for inbound HELLOs, forever, one `accept()` at a time.
   *
   * `accept()` resolves on a HELLO or on its own timeout; a timeout is the ordinary way
   * this loop spends its life. The loop ends when the node is closed (the token stops
   * matching) or restarted (the socket is closed under it, which ends the wait
   * immediately instead of leaving a timer behind).
   *
   * @param {symbol} token
   * @returns {Promise<void>}
   */
  async runAcceptLoop(token) {
    while (this.started && this.runToken === token && this.socket !== null) {
      let result = null;
      try {
        result = await accept({
          socket: this.socket,
          timeoutMs: this.tuning.acceptTimeoutMs,
          claimed: this.claimed,
        });
      } catch (error) {
        // `accept()` throws only for a socket it was not given, which the loop condition
        // already rules out. Caught anyway: a bug here would otherwise become an
        // unhandled rejection from an endless loop, which is the worst of both worlds.
        this.reportError(`P2P_ACCEPT_THREW: ${messageOf(error)}`);
        return;
      }
      if (!result.ok) {
        if (result.error?.startsWith('P2P_SOCKET_CLOSED')) return;
        continue;
      }
      if (!this.started || this.runToken !== token) {
        // The node was closed while the HELLO was in flight. The channel is real but it
        // has no owner, so it is closed rather than leaked.
        result.channel.close('node-closed');
        return;
      }
      this.punchesIn += 1;
      // `from` is null: a HELLO carries a session, not a machine id, and inventing an
      // identity from a source address would be exactly the kind of unverified claim
      // this transport refuses elsewhere. The caller correlates by session if it needs to.
      this.adoptChannel(result.channel, { from: null, session: result.session });
    }
  }

  /**
   * Stop the node. Idempotent, and `start()` may be called again afterwards.
   *
   * Restartability is a choice, not an accident: the alternative (a permanent tombstone)
   * would force a caller that wants to reconnect to build a second node and re-wire
   * every listener, and would leave `start()` failing for a reason the caller cannot
   * act on. A restarted node binds a *new* socket — on a new ephemeral port, unless `bindPort`
   * pinned one — and the old mapping is gone with the old socket, which is why the announcement is
   * reset too rather than left to look live.
   *
   * @returns {Promise<void>}
   */
  async close() {
    // Invalidate the run first: anything already in flight (an announce, an accept
    // wait) will see a different token and stop instead of publishing into a dead node.
    const socket = this.socket;
    this.runToken = null;
    this.started = false;
    this.socket = null;
    // A bind that is still in flight belongs to the previous generation and closes itself.
    this.generation += 1;
    // An announce that is still in flight is dropped from the shared slot: its result is
    // already discarded by the token check above, and a later `start()` must not join it.
    this.announcing = null;

    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    for (const channel of [...this.channels.values()]) {
      try {
        channel.close('node-closed');
      } catch {
        /* the path is already gone */
      }
    }
    this.channels.clear();
    this.claimed.clear();

    if (socket !== null) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    // `accept()` finishes on the socket's `close` event, so this is a real barrier and
    // not a wait for the accept timeout.
    await this.acceptLoop?.catch(() => {});
    this.acceptLoop = null;

    this.local = null;
    this.reflexive = null;
    this.mapping = null;
    this.candidates = [];
    this.announcedAt = null;
    this.announceOk = false;
    this.lastAnnounceError = null;
  }
}

/**
 * The relay's answer when it refused an announcement, as one named line.
 *
 * @param {object|null} response
 * @returns {string}
 */
function describeAnnounceFailure(response) {
  const code = response?.json?.error?.code;
  if (typeof response?.error === 'string' && response.error !== '') {
    return `P2P_ANNOUNCE_FAILED: ${response.error}`;
  }
  if (Number.isInteger(response?.status) && response.status > 0) {
    return `P2P_ANNOUNCE_FAILED: HTTP ${response.status}${typeof code === 'string' ? ` ${code}` : ''}`;
  }
  return `P2P_ANNOUNCE_FAILED: the relay did not accept the announcement${typeof code === 'string' ? ` (${code})` : ''}`;
}

/**
 * The relay's answer when it refused a candidate lookup.
 *
 * @param {object|null} response
 * @returns {string}
 */
function describeLookupFailure(response) {
  const code = response?.json?.error?.code;
  if (typeof response?.error === 'string' && response.error !== '') return response.error;
  if (Number.isInteger(response?.status) && response.status > 0) {
    return `HTTP ${response.status}${typeof code === 'string' ? ` ${code}` : ''}`;
  }
  return `no usable answer from the relay${typeof code === 'string' ? ` (${code})` : ''}`;
}
