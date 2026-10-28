/**
 * chat-enc-v2 capability gate (A7 wiring).
 *
 * The relay advertises `chat-enc-v2` in `/healthz.features`; when it does not, the plugin must keep
 * sending v1 envelopes (which every 1.x relay accepts) rather than inventing a v2 shape. The answer
 * is cached briefly so a chatty panel does not probe healthz on every message.
 */
const TTL_MS = 60_000;
const cache = new Map();

export function resetChatV2Cache() {
  cache.clear();
}

/**
 * @param {{rabbitUrl?: string|null, fetchImpl?: Function, now?: () => number, signal?: AbortSignal, ttlMs?: number}} input
 * @returns {Promise<boolean>}
 */
export async function chatEncV2Supported(input = {}) {
  const base = typeof input.rabbitUrl === 'string' ? input.rabbitUrl.replace(/\/$/, '') : '';
  if (base === '') return false;
  const now = typeof input.now === 'function' ? input.now() : Date.now();
  const ttl = Number.isInteger(input.ttlMs) ? input.ttlMs : TTL_MS;
  const hit = cache.get(base);
  if (hit !== undefined && now - hit.at < ttl) return hit.supported;
  const fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : globalThis.fetch;
  let supported = false;
  try {
    const response = await fetchImpl(base + '/healthz', { headers: { accept: 'application/json' }, signal: input.signal });
    if (response?.ok === true) {
      const body = await response.json();
      const features = Array.isArray(body?.features) ? body.features : [];
      supported = features.includes('chat-enc-v2');
    }
  } catch {
    supported = false;
  }
  cache.set(base, { at: now, supported });
  return supported;
}
