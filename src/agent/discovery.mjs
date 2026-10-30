/**
 * W3 discovery seam: providers only produce candidate addresses.
 *
 * Current order is relay -> mDNS -> DHT. A candidate is never an authorisation:
 * the dial path still verifies the peer's static key and the task identity.
 * Adding a DHT sidecar later means implementing the same `discover(machineId)`
 * shape; it does not change the transport or the relay.
 */

export const DISCOVERY_SOURCE = Object.freeze({
  RELAY: 'relay',
  MDNS: 'mdns',
  DHT: 'dht',
});

/** Order used only to break duplicate-address ties, not to trust a source. */
const SOURCE_RANK = Object.freeze({
  [DISCOVERY_SOURCE.RELAY]: 0,
  [DISCOVERY_SOURCE.MDNS]: 1,
  [DISCOVERY_SOURCE.DHT]: 2,
});

const usable = (candidate) => candidate !== null
  && typeof candidate === 'object'
  && typeof candidate.address === 'string'
  && candidate.address !== ''
  && candidate.address !== '0.0.0.0'
  && candidate.address !== '::'
  && Number.isInteger(candidate.port)
  && candidate.port > 0
  && candidate.port <= 65535;

/**
 * Merge candidates from every provider, deduplicating by address:port.
 * The first source in rank order wins the label; the address itself is kept
 * once. No provider can inject a non-address payload into this list.
 */
export function mergeCandidates(lists, { limit = 8 } = {}) {
  const merged = [];
  const seen = new Set();
  const sorted = [...lists].sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
  for (const list of sorted) {
    for (const candidate of Array.isArray(list.candidates) ? list.candidates : []) {
      if (!usable(candidate)) continue;
      const key = candidate.address + ':' + candidate.port;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ address: candidate.address, port: candidate.port, source: list.source ?? candidate.source ?? 'unknown' });
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

/** Relay discovery, built on the existing authenticated /v1/peer route. */
export function createRelayDiscovery({ getJson } = {}) {
  if (typeof getJson !== 'function') return { ok: false, code: 'DISCOVERY_NO_GET_JSON' };
  return {
    ok: true,
    source: DISCOVERY_SOURCE.RELAY,
    async discover(machineId) {
      if (typeof machineId !== 'string' || machineId === '') return { ok: false, code: 'DISCOVERY_BAD_MACHINE_ID', candidates: [] };
      const answer = await getJson('/v1/peer/' + encodeURIComponent(machineId));
      if (answer?.ok !== true || answer?.status === 404) return { ok: false, code: 'DISCOVERY_RELAY_MISS', candidates: [] };
      const candidates = Array.isArray(answer?.json?.peer?.candidates) ? answer.json.peer.candidates : [];
      return { ok: true, source: DISCOVERY_SOURCE.RELAY, candidates, staticKey: answer?.json?.peer?.static_key ?? null };
    },
  };
}

/**
 * A provider for tests and for an injected mDNS implementation. It carries no
 * network logic, so the caller decides how candidates were observed.
 */
export function createStaticDiscovery({ source, candidates = [] } = {}) {
  return {
    ok: true,
    source: source ?? 'static',
    async discover() { return { ok: true, source: source ?? 'static', candidates: candidates.slice() }; },
  };
}
