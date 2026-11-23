/**
 * ICE path accounting for the WebRTC transport.
 *
 * WebRTC's own ICE engine picks the candidate pair; this module does not re-implement ICE. It turns
 * the engine's selected pair into the facts W2M needs to make a *product* decision:
 *
 *   - is this a direct path (host/srflx/prflx) or a TURN relay?
 *   - what is the measured RTT, and is it inside the configured budget?
 *   - has the path failed enough times that the caller should fall back to the existing UDP/relay
 *     transport instead of pretending the WebRTC path is healthy?
 *
 * Keeping this separate from `transport.mjs` means the selection policy is testable without a
 * browser, a native WebRTC build, or a network. The transport feeds it `getStats()` snapshots; the
 * subplugin exposes its verdict.
 */

/** Path classes, as reported by `paths()` and diagnostics. */
export const PATH_KIND = Object.freeze({
  HOST: 'host',
  SRFLX: 'srflx',
  PRFLX: 'prflx',
  RELAY: 'relay',
  UNKNOWN: 'unknown',
});

/** Product-level path verdicts. */
export const PATH_VERDICT = Object.freeze({
  DIRECT: 'direct',
  RELAY: 'relay',
  DEGRADED: 'degraded',
  FALLBACK: 'fallback',
  NONE: 'none',
});

/** Default RTT budget: above this a "direct" path is not better than the fleet's relay. */
export const DEFAULT_MAX_RTT_MS = 350;

/** Consecutive failures before the caller is told to fall back. */
export const DEFAULT_DEGRADE_AFTER_FAILURES = 2;

/**
 * Parse a `candidate:` SDP attribute into its type and transport. Returns `unknown` rather than
 * guessing when the string is absent; a false "direct" verdict is worse than an honest unknown.
 *
 * @param {string} candidate
 * @returns {{type: string, protocol: string, address: string|null, port: number|null, raw: string}|null}
 */
export function parseCandidate(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const raw = candidate.startsWith('candidate:') ? candidate : `candidate:${candidate}`;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 8) return null;
  let type = PATH_KIND.UNKNOWN;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === 'typ') {
      const value = parts[index + 1];
      if (Object.values(PATH_KIND).includes(value)) type = value;
      break;
    }
  }
  // candidate:foundation component protocol priority address port typ type ...
  const protocol = (parts[2] ?? '').toLowerCase();
  const address = parts[4] ?? null;
  const port = Number.parseInt(parts[5] ?? '', 10);
  return {
    type,
    protocol,
    address,
    port: Number.isInteger(port) ? port : null,
    raw,
  };
}

/**
 * Normalize the many shapes a WebRTC stats implementation may use for one candidate.
 *
 * @param {unknown} value
 * @returns {{type: string, protocol: string, address: string|null, port: number|null, raw: string|null}}
 */
export function normalizeCandidate(value) {
  if (value === null || value === undefined) {
    return { type: PATH_KIND.UNKNOWN, protocol: '', address: null, port: null, raw: null };
  }
  if (typeof value === 'string') {
    const parsed = parseCandidate(value);
    return parsed ?? { type: PATH_KIND.UNKNOWN, protocol: '', address: null, port: null, raw: value };
  }
  if (typeof value !== 'object') {
    return { type: PATH_KIND.UNKNOWN, protocol: '', address: null, port: null, raw: String(value) };
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const typeValue = record.type ?? record.candidateType ?? record.kind;
  const type =
    typeof typeValue === 'string' && Object.values(PATH_KIND).includes(typeValue)
      ? typeValue
      : PATH_KIND.UNKNOWN;
  const protocolValue = record.protocol ?? record.transport ?? '';
  const addressValue = record.address ?? record.ip ?? record.host ?? record.addressValue ?? null;
  const portValue = record.port ?? record.portValue ?? null;
  const rawValue = record.candidate ?? record.raw ?? null;
  if (type === PATH_KIND.UNKNOWN && typeof rawValue === 'string') {
    const parsed = parseCandidate(rawValue);
    if (parsed !== null) return parsed;
  }
  return {
    type,
    protocol: typeof protocolValue === 'string' ? protocolValue.toLowerCase() : '',
    address: typeof addressValue === 'string' ? addressValue : null,
    port: Number.isInteger(Number(portValue)) ? Number(portValue) : null,
    raw: typeof rawValue === 'string' ? rawValue : null,
  };
}

/** @param {{type: string}} candidate */
export function isRelayCandidate(candidate) {
  return normalizeCandidate(candidate).type === PATH_KIND.RELAY;
}

/**
 * Redact ICE server credentials for a tool response. Usernames are kept (they identify a TURN
 * account) but the credential itself is replaced, because a status tool is often pasted into chat.
 *
 * @param {Array<object>|object} servers
 * @returns {Array<object>}
 */
export function describeIceServers(servers) {
  const list = Array.isArray(servers) ? servers : servers ? [servers] : [];
  return list.map((server) => {
    if (server === null || typeof server !== 'object') return { urls: String(server) };
    const record = /** @type {Record<string, unknown>} */ (server);
    const urls = record.urls ?? record.url ?? [];
    return {
      urls: Array.isArray(urls) ? urls.map(String) : [String(urls)],
      username: typeof record.username === 'string' ? record.username : null,
      credential: record.credential === undefined ? null : '<redacted>',
      credential_type: typeof record.credentialType === 'string' ? record.credentialType : null,
    };
  });
}

/**
 * Validate and normalize an ICE server list without inventing defaults.
 *
 * @param {unknown} value
 * @returns {{ok: true, servers: Array<object>, refused: Array<object>} | {ok: false, code: string, detail: string}}
 */
export function normalizeIceServers(value) {
  if (value === undefined || value === null) return { ok: true, servers: [], refused: [] };
  if (!Array.isArray(value)) {
    return { ok: false, code: 'WEBRTC_BAD_ICE_SERVERS', detail: 'iceServers must be an array' };
  }
  const servers = [];
  const refused = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') {
      refused.push({ entry: String(entry), reason: 'not an object' });
      continue;
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    const urls = record.urls ?? record.url;
    const list = Array.isArray(urls) ? urls : typeof urls === 'string' ? [urls] : [];
    const clean = [];
    for (const raw of list) {
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      const url = raw.trim();
      if (!/^(stun|stuns|turn|turns):/i.test(url)) {
        refused.push({ entry: url, reason: 'scheme must be stun/stuns/turn/turns' });
        continue;
      }
      // `turn:` over UDP is the normal WebRTC TURN deployment. The provider carries long-term
      // credentials inside the URL (`turn:user:pass@host`), which is the only shape
      // node-datachannel accepts. Refusing every public `turn:` made a configured TURN server
      // unusable, so the scheme is allowed here; `turns:` remains the TLS option. The DTLS/SCTP
      // payload stays encrypted end to end even when TURN itself is cleartext.
      clean.push(url);
    }
    if (clean.length === 0) continue;
    const server = { urls: clean };
    if (typeof record.username === 'string' && record.username !== '') server.username = record.username;
    if (typeof record.credential === 'string' && record.credential !== '') {
      server.credential = record.credential;
      if (typeof record.credentialType === 'string') server.credentialType = record.credentialType;
    }
    servers.push(server);
  }
  return { ok: true, servers, refused };
}

/**
 * Track one transport's selected ICE pair and decide direct vs relay vs fallback.
 *
 * This is a *record*, not a controller: `transport.mjs` calls `recordStats` on every stats snapshot
 * and reads `verdict()` when reporting. Nothing here changes the ICE engine's choice.
 */
export class PathSelector {
  /**
   * @param {{iceServers?: Array<object>, preferP2p?: boolean, allowRelay?: boolean,
   *   maxRttMs?: number, degradeAfterFailures?: number}} [options]
   */
  constructor({
    iceServers = [],
    preferP2p = true,
    allowRelay = true,
    maxRttMs = DEFAULT_MAX_RTT_MS,
    degradeAfterFailures = DEFAULT_DEGRADE_AFTER_FAILURES,
  } = {}) {
    this.iceServers = iceServers;
    this.preferP2p = preferP2p;
    this.allowRelay = allowRelay;
    this.maxRttMs = Number.isFinite(maxRttMs) && maxRttMs > 0 ? maxRttMs : DEFAULT_MAX_RTT_MS;
    this.degradeAfterFailures =
      Number.isInteger(degradeAfterFailures) && degradeAfterFailures > 0
        ? degradeAfterFailures
        : DEFAULT_DEGRADE_AFTER_FAILURES;
    this.selected = null;
    this.local = null;
    this.remote = null;
    this.rttMs = null;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.failures = 0;
    this.lastFailure = null;
    this.updates = 0;
  }

  /**
   * Ingest a provider stats object. Tolerates the shapes used by node-datachannel, werift and
   * browser `RTCIceCandidatePairStats`; an unrecognized shape leaves the previous selection intact.
   *
   * @param {object|null} stats
   * @returns {object} this, for chaining
   */
  recordStats(stats) {
    if (stats === null || typeof stats !== 'object') return this;
    this.updates += 1;
    const record = /** @type {Record<string, unknown>} */ (stats);
    const pair = record.selectedPair ?? record.selectedCandidatePair ?? record.selected_pair ?? null;
    if (pair !== null && typeof pair === 'object') {
      const pairRecord = /** @type {Record<string, unknown>} */ (pair);
      this.local = normalizeCandidate(pairRecord.localCandidate ?? pairRecord.local ?? null);
      this.remote = normalizeCandidate(pairRecord.remoteCandidate ?? pairRecord.remote ?? null);
      this.selected = {
        local: this.local,
        remote: this.remote,
        state: typeof pairRecord.state === 'string' ? pairRecord.state : null,
        nominated: pairRecord.nominated === true,
      };
    } else if (typeof pair === 'string') {
      const parsed = parseCandidate(pair);
      if (parsed !== null) {
        this.selected = { local: parsed, remote: null, state: null, nominated: true };
        this.local = parsed;
        this.remote = null;
      }
    }
    const rtt = record.currentRoundTripTimeMs ?? record.currentRttMs ?? record.rttMs ?? record.rtt;
    if (Number.isFinite(Number(rtt)) && Number(rtt) >= 0) this.rttMs = Number(rtt);
    const sent = record.bytesSent ?? record.bytes_sent;
    const received = record.bytesReceived ?? record.bytes_received;
    if (Number.isFinite(Number(sent))) this.bytesSent = Math.max(this.bytesSent, Number(sent));
    if (Number.isFinite(Number(received)))
      this.bytesReceived = Math.max(this.bytesReceived, Number(received));
    return this;
  }

  /** A selected pair that is not a relay. */
  isDirect() {
    if (this.selected === null) return false;
    const localType = this.local?.type ?? PATH_KIND.UNKNOWN;
    const remoteType = this.remote?.type ?? PATH_KIND.UNKNOWN;
    return localType !== PATH_KIND.RELAY && remoteType !== PATH_KIND.RELAY;
  }

  /** A selected pair whose local or remote candidate is a TURN relay. */
  isRelay() {
    if (this.selected === null) return false;
    return (
      (this.local?.type ?? PATH_KIND.UNKNOWN) === PATH_KIND.RELAY ||
      (this.remote?.type ?? PATH_KIND.UNKNOWN) === PATH_KIND.RELAY
    );
  }

  /** Record a failed connection attempt or a stats failure. */
  recordFailure(code = 'WEBRTC_PATH_FAILED') {
    this.failures += 1;
    this.lastFailure = { code, at: Date.now() };
    return this;
  }

  /** A successful data-plane event resets the failure streak; one flaky sample is not a dead path. */
  recordSuccess() {
    this.failures = 0;
    return this;
  }

  /** @returns {string} One of `PATH_VERDICT`. */
  verdict() {
    if (this.selected === null) return PATH_VERDICT.NONE;
    if (!this.allowRelay && this.isRelay()) return PATH_VERDICT.FALLBACK;
    if (this.failures >= this.degradeAfterFailures) return PATH_VERDICT.FALLBACK;
    if (this.isRelay()) {
      // A relay path is usable but is never called "direct"; when the product prefers P2P and a
      // direct path has not been found, the caller should keep trying or fall back rather than
      // silently paying relay bandwidth forever.
      return this.preferP2p ? PATH_VERDICT.RELAY : PATH_VERDICT.DEGRADED;
    }
    if (this.rttMs !== null && this.rttMs > this.maxRttMs) return PATH_VERDICT.DEGRADED;
    return PATH_VERDICT.DIRECT;
  }

  /** @returns {Array<object>} Path records suitable for `transport.paths()`. */
  paths() {
    if (this.selected === null) {
      return this.iceServers.map((server) => ({
        kind: 'ice-server',
        transport: 'webrtc-v1',
        urls: server.urls,
        selected: false,
      }));
    }
    return [
      {
        kind: 'ice-pair',
        transport: 'webrtc-v1',
        selected: true,
        local: { ...this.local },
        remote: { ...this.remote },
        relay: this.isRelay(),
        rtt_ms: this.rttMs,
        verdict: this.verdict(),
      },
    ];
  }

  /** @returns {object} */
  diagnostics() {
    return {
      prefer_p2p: this.preferP2p,
      allow_relay: this.allowRelay,
      max_rtt_ms: this.maxRttMs,
      degrade_after_failures: this.degradeAfterFailures,
      verdict: this.verdict(),
      selected: this.selected,
      relay: this.isRelay(),
      direct: this.isDirect(),
      rtt_ms: this.rttMs,
      bytes_sent: this.bytesSent,
      bytes_received: this.bytesReceived,
      failures: this.failures,
      last_failure: this.lastFailure,
      ice_servers: describeIceServers(this.iceServers),
      updates: this.updates,
    };
  }
}
