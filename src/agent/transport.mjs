/**
 * W0: P2PTransport contract + the udp-v1 implementation.
 *
 * This is the seam a second stack (iroh-v1) will plug into. It is deliberately
 * thin: it owns no protocol logic, only the shape the scheduler talks to.
 * Nothing wires it into the agent yet, so behaviour of v2.0.8 is unchanged.
 */

export const TRANSPORT = Object.freeze({
  UDP: 'udp-v1',
  IROH: 'iroh-v1',
});

export const TRANSPORT_DEFAULT = Object.freeze(['udp']);

export const TRANSPORT_CODE = Object.freeze({
  OK: 'TRANSPORT_OK',
  UNAVAILABLE: 'TRANSPORT_UNAVAILABLE',
  BAD_SHAPE: 'TRANSPORT_BAD_SHAPE',
  CLOSED: 'TRANSPORT_CLOSED',
  UNKNOWN: 'TRANSPORT_UNKNOWN',
});

/**
 * Validate the pieces a transport must expose. Returns a named refusal instead
 * of throwing so a registry can skip a broken transport without losing the rest.
 */
export function assertTransportShape(transport) {
  if (transport === null || typeof transport !== 'object') return { ok: false, code: TRANSPORT_CODE.BAD_SHAPE, detail: 'transport must be an object' };
  for (const name of ['name', 'start', 'stop', 'send', 'onMessage', 'paths', 'diagnostics']) {
    if (name === 'name' ? typeof transport.name !== 'string' : typeof transport[name] !== 'function') {
      return { ok: false, code: TRANSPORT_CODE.BAD_SHAPE, detail: 'missing ' + name };
    }
  }
  return { ok: true };
}

/**
 * Resolve the configured transport list without ever inventing one.
 * Unknown names are dropped and reported; `udp` is always kept as the fallback.
 */
export function resolveTransports(config = {}) {
  const requested = Array.isArray(config.transports) ? config.transports.filter((name) => typeof name === 'string') : TRANSPORT_DEFAULT;
  const known = new Set(Object.values(TRANSPORT));
  const accepted = [];
  const refused = [];
  for (const name of requested) {
    if (!known.has(name)) { refused.push({ name, code: TRANSPORT_CODE.UNKNOWN }); continue; }
    if (!accepted.includes(name)) accepted.push(name);
  }
  if (!accepted.includes(TRANSPORT.UDP)) accepted.push(TRANSPORT.UDP);
  return { ok: true, transports: accepted, refused };
}

/**
 * Wrap a P2PNode-like object as udp-v1.
 *
 * The node is expected to expose `dial(machineId)` (returns {ok, channel}),
 * `status()` and optionally `close()`. Channels expose `send`, `on`, `close`.
 * This adapter caches one channel per peer so send() is not a dial per frame.
 */
export function createUdpTransport({ node, name = TRANSPORT.UDP } = {}) {
  if (node === null || typeof node !== 'object' || typeof node.dial !== 'function') {
    return { ok: false, code: TRANSPORT_CODE.BAD_SHAPE, detail: 'createUdpTransport needs a node with dial()' };
  }
  const channels = new Map();
  const handlers = new Set();
  let closed = false;

  const attach = (peer, channel) => {
    channel.on?.('message', (payload) => {
      for (const handler of handlers) handler({ peer, payload });
    });
    channel.on?.('close', () => channels.delete(peer));
  };

  const transport = {
    name,
    async start() {
      closed = false;
      return { ok: true, name };
    },
    async stop() {
      closed = true;
      for (const channel of channels.values()) channel.close?.();
      channels.clear();
      node.close?.();
      return { ok: true };
    },
    async send(peer, payload) {
      if (closed) return { ok: false, code: TRANSPORT_CODE.CLOSED };
      let channel = channels.get(peer) ?? null;
      if (channel === null) {
        const dialled = await node.dial(peer);
        if (dialled?.ok !== true) return { ok: false, code: dialled?.code ?? 'UDP_DIAL_FAILED', detail: dialled?.error ?? null };
        channel = dialled.channel;
        channels.set(peer, channel);
        attach(peer, channel);
      }
      await channel.send(payload);
      return { ok: true, peer };
    },
    onMessage(handler) {
      if (typeof handler !== 'function') return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    paths() {
      const status = typeof node.status === 'function' ? node.status() : null;
      return Array.isArray(status?.candidates) ? status.candidates.map((candidate) => ({ ...candidate, transport: name })) : [];
    },
    diagnostics() {
      const status = typeof node.status === 'function' ? node.status() : null;
      return {
        name,
        closed,
        channels: channels.size,
        encryption: status?.encryption ?? null,
        last_error: status?.last_error ?? null,
      };
    },
  };
  return { ok: true, transport };
}

/**
 * Registry: the only object the backend layer will need to talk to later.
 * It keeps a default and can report every registered transport's diagnostics.
 */
export function createTransportRegistry({ transports = [], defaultName = TRANSPORT.UDP } = {}) {
  const byName = new Map();
  const refused = [];
  for (const transport of transports) {
    const shape = assertTransportShape(transport);
    if (shape.ok !== true) { refused.push({ transport: transport?.name ?? null, code: shape.code, detail: shape.detail }); continue; }
    byName.set(transport.name, transport);
  }
  return {
    ok: true,
    refused,
    names: [...byName.keys()],
    get(name) { return byName.get(name) ?? null; },
    defaultTransport() { return byName.get(defaultName) ?? byName.get(TRANSPORT.UDP) ?? null; },
    diagnostics() { return [...byName.values()].map((transport) => transport.diagnostics()); },
  };
}
