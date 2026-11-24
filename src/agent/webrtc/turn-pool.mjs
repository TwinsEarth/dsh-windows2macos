/**
 * Multi-TURN ordering for a WebRTC pool.
 *
 * A TURN deployment has no L4 load balancer: the ICE engine allocates a relay candidate per
 * configured TURN URL, and the pair that wins is decided inside ICE. What a fleet can control is
 * the order and the set of TURN servers offered to each pair. This module makes that choice
 * deterministic and symmetric:
 *
 * - both peers derive the same primary from the unordered machine-id pair, so a pair never
 *   lands on two different primaries and pays for a double relay;
 * - different pairs hash to different primaries, so the deployment is active/active;
 * - every configured TURN server stays in the list as a fallback instead of being hidden by
 *   the primary.
 *
 * It is only an ordering layer. It does not invent credentials, does not perform health checks,
 * and does not change `PathSelector`'s verdict. The actual relay candidate is still reported by
 * ICE stats.
 */

import { createHash } from 'node:crypto';

export const TURN_POOL_CODE = Object.freeze({
  BAD_TURN_SERVERS: 'TURN_POOL_BAD_SERVERS',
  BAD_POLICY: 'TURN_POOL_BAD_POLICY',
});

const TURN_SCHEME = /^(turn|turns):/i;
const URL_SCHEME = /^(stun|stuns|turn|turns):/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asWeight(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function normalizeUrls(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list
    .filter((url) => typeof url === 'string' && url.trim() !== '')
    .map((url) => url.trim());
}

/**
 * Remove the userinfo from a TURN URL. The regex is greedy on purpose: a password may itself
 * contain `@`, and stopping at the first one would leave the tail of the password in the output.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactTurnUrl(value) {
  const text = String(value ?? '');
  return text.replace(/^([a-z][a-z0-9+.-]*:)(\/\/)?[^/]*@/i, '$1$2<redacted>@');
}

/**
 * Normalize a `turnServers` value into the shape the transport already understands.
 *
 * Accepted entries:
 * - `turn:user:pass@host:3479`
 * - `{ urls: 'turn:...', weight: 1 }`
 * - `{ urls: ['turn:...', 'turns:...'], username: '...', credential: '...' }`
 *
 * STUN entries are refused here on purpose: `iceServers` owns STUN. Keeping the two lists
 * separate is what lets an operator add a TURN node without rewriting the STUN row.
 *
 * @param {unknown} value
 * @returns {{ok: true, servers: Array<object>, refused: Array<object>} | {ok: false, code: string, detail: string}}
 */
export function normalizeTurnServers(value) {
  if (value === undefined || value === null) return { ok: true, servers: [], refused: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      code: TURN_POOL_CODE.BAD_TURN_SERVERS,
      detail: 'turnServers must be an array',
    };
  }
  const servers = [];
  const refused = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry === 'string') {
      const url = entry.trim();
      if (!TURN_SCHEME.test(url)) {
        refused.push({ entry: redactTurnUrl(url), reason: 'turnServers accepts only turn:/turns:' });
        continue;
      }
      if (!seen.has(url)) {
        seen.add(url);
        servers.push({ urls: [url], weight: 1 });
      }
      continue;
    }
    if (!isRecord(entry)) {
      refused.push({ entry: String(entry), reason: 'not a string or object' });
      continue;
    }
    const urls = normalizeUrls(entry.urls ?? entry.url);
    const clean = [];
    for (const url of urls) {
      if (!URL_SCHEME.test(url)) {
        refused.push({ entry: redactTurnUrl(url), reason: 'scheme must be stun/stuns/turn/turns' });
        continue;
      }
      if (!TURN_SCHEME.test(url)) {
        refused.push({ entry: redactTurnUrl(url), reason: 'turnServers accepts only turn:/turns:' });
        continue;
      }
      if (!seen.has(url)) {
        seen.add(url);
        clean.push(url);
      }
    }
    if (clean.length === 0) continue;
    const server = { urls: clean, weight: asWeight(entry.weight) };
    if (typeof entry.username === 'string' && entry.username !== '') server.username = entry.username;
    if (typeof entry.credential === 'string' && entry.credential !== '') {
      server.credential = entry.credential;
      if (typeof entry.credentialType === 'string') server.credentialType = entry.credentialType;
    }
    servers.push(server);
  }
  return { ok: true, servers, refused };
}

/** Stable identity of one TURN server, independent of its position in the list. */
export function turnServerKey(server) {
  if (!isRecord(server)) return '';
  const urls = Array.isArray(server.urls) ? server.urls : [];
  const first = typeof urls[0] === 'string' ? urls[0] : '';
  return first === '' ? '' : first.replace(/^(turn|turns):.*@/i, '$1:');
}

/** Both peers must build the same pair key; sorting the ids is what makes that true. */
export function turnPairKey(localId, peerId) {
  return [String(localId ?? ''), String(peerId ?? '')].sort().join('|');
}

function scoreFor(server, pairKey) {
  const key = turnServerKey(server);
  const digest = createHash('sha256').update(`${pairKey}\u0000${key}`).digest();
  // Efraimidis-Spirakis weighted sampling: u^(1/w), larger wins. A weight of 1 is uniform.
  const u = (digest.readUInt32BE(0) + 1) / 0x1_0000_0000;
  return Math.pow(u, 1 / asWeight(server.weight));
}

/**
 * Order TURN servers for one pair. The returned list is a new array; input is untouched.
 *
 * @param {Array<object>} servers
 * @param {{localId?: string, peerId?: string}} [ids]
 * @returns {Array<object>}
 */
export function orderTurnServersForPair(servers = [], { localId = '', peerId = '' } = {}) {
  const list = Array.isArray(servers) ? servers.filter(isRecord) : [];
  const pairKey = turnPairKey(localId, peerId);
  return list
    .map((server, index) => ({ server, index, score: scoreFor(server, pairKey) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.server);
}

/**
 * A STUN-only view of the existing `iceServers` row, so a TURN entry cannot be duplicated.
 *
 * `iceServers` historically allowed TURN entries with embedded credentials. When a dedicated
 * `turnServers` list exists it owns TURN: keeping the legacy TURN entry would bypass `primary`
 * pinning and allocate a second relay. Without a dedicated list the original row is returned
 * untouched, so legacy configurations keep working.
 */
function baseIceServers(iceServers, { dropTurn = false } = {}) {
  const list = Array.isArray(iceServers) ? iceServers : [];
  return list.flatMap((server) => {
    if (!isRecord(server)) return [];
    const urls = Array.isArray(server.urls) ? server.urls : typeof server.url === 'string' ? [server.url] : [];
    if (urls.length === 0) return [];
    if (!dropTurn) {
      return urls.some((url) => typeof url === 'string' && !TURN_SCHEME.test(url)) ? [server] : [];
    }
    const stun = urls.filter((url) => typeof url === 'string' && !TURN_SCHEME.test(url));
    return stun.length === 0 ? [] : [{ urls: stun }];
  });
}

/**
 * Build the per-peer `iceServers` list.
 *
 * The primary is first and every other TURN server follows as a fallback. Both peers compute the
 * same order, which is required for a single-relay path. `policy: 'primary'` drops the fallbacks
 * for deployments that want a hard pin; `'balanced'` is the default.
 *
 * @param {{turnServers?: Array<object>, iceServers?: Array<object>, localId?: string,
 *   peerId?: string, policy?: string}} [options]
 */
export function buildIceServersForPeer({
  turnServers = [],
  iceServers = [],
  localId = '',
  peerId = '',
  policy = 'balanced',
} = {}) {
  const ordered = orderTurnServersForPair(turnServers, { localId, peerId });
  const selected = policy === 'primary' ? ordered.slice(0, 1) : ordered;
  return [...selected, ...baseIceServers(iceServers, { dropTurn: ordered.length > 0 })];
}

/** Redacted description for status output; credentials never leave the process. */
export function describeTurnServers(servers = []) {
  return (Array.isArray(servers) ? servers : []).map((server) => {
    const urls = Array.isArray(server.urls) ? server.urls.map((url) => redactTurnUrl(url)) : [];
    const embeddedCredentials = (Array.isArray(server.urls) ? server.urls : []).some((url) =>
      /^(turn|turns):.*@/i.test(String(url ?? '')),
    );
    return {
      urls,
      weight: asWeight(server.weight),
      has_credentials:
        (typeof server.username === 'string' && typeof server.credential === 'string') ||
        embeddedCredentials,
    };
  });
}
