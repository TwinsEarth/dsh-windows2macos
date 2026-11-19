/**
 * Deterministic, seeded fault-injection layer for UDP-shaped datagram sockets.
 *
 * P2P workstream F1 (`docs/REFACTOR-P2-PLAN.md` §1). It exists so the reliable
 * channel in `src/agent/p2p.mjs` and the relay timing in `test/relay-concurrency.test.mjs`
 * can be driven through loss, duplication, reordering, latency and a disappearing
 * peer **without a real network and without monkey-patching anything global**.
 *
 * Two shapes are supported, and both go through the same fault plan:
 *
 *   * **A pair of in-memory endpoints** — `createFaultUdpPair({...})` returns
 *     `{a, b, network}` where `a` and `b` are drop-in `dgram` sockets (`.send(buf, port,
 *     address, cb)`, `.on('message', (buf, rinfo) => ...)`, `.close()`, `.address()`).
 *     They are what a test injects as `new P2PChannel({ socket: a, ... })`.
 *   * **A wrapper around an injected base socket** — `createFaultUdp({ baseSocket })`
 *     applies the faults to the egress path and forwards surviving datagrams to the
 *     base socket's own `send`. Inbound datagrams are forwarded unchanged (faults on
 *     the receive path belong to whoever owns that socket).
 *
 * Determinism is the contract:
 *
 *   * One seeded PRNG (`mulberry32`) drives every random decision, in send order.
 *   * The same seed + the same call sequence ⇒ the same drop/duplicate/reorder plan
 *     and the same delivery order. `test/p2p-fault.test.mjs` pins this.
 *   * Delivery happens only from the schedule queue. The queue is driven by an
 *     injected clock (`now` option, default: a virtual clock starting at 0) and by
 *     `flush()`; `advance(ms)` moves the virtual clock. The queue is bounded by
 *     `maxScheduled`, so a scenario that forgets to flush fails loudly instead of
 *     growing without limit.
 *   * For async suites that `await` a protocol promise, `autopumpMs` starts an
 *     interval that drains due datagrams (ref'd by default — `autopumpRef: false`
 *     opts out — because the channel's own retransmission timers are unref()ed and
 *     something must keep the event loop alive while a send is awaited). The fault
 *     decisions are still seed-deterministic because they are made at `send()` time,
 *     not at delivery time.
 *
 * Explicit, programmatic triggers exist alongside the rates (they are one-shot and
 * keyed by the global send ordinal, 1-based):
 *
 *   network.drop(n)          drop the n-th datagram
 *   network.duplicate(n)     deliver the n-th datagram twice
 *   network.reorder(first, second)  deliver `second` before `first`
 *
 * Every injection is counted: `network.stats()` reports `sent, dropped, duplicated,
 * reordered, delivered, silenced, unroutable`, the explicit counts and `pending`
 * (queued, not yet due). Rates and explicit triggers compose; an explicit trigger
 * for a decision replaces the random decision for that datagram.
 */

import { EventEmitter } from 'node:events';

/** One seeded PRNG; identical seed ⇒ identical sequence. */
export function createSeededRandom(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_MAX_SCHEDULED = 50_000;
const DEFAULT_MAX_FLUSH_ROUNDS = 100_000;

const toKey = (peer) => `${peer.address}:${peer.port}`;

/**
 * A dgram-shaped socket whose datagrams pass through one shared fault plan.
 *
 * Constructed by `network.endpoint()`; do not build directly. It is an
 * `EventEmitter` with the subset of the `dgram.Socket` surface the P2P code uses:
 * `send`, `on/once/off/removeListener`, `close`, `address`, `ref/unref`.
 */
class FaultUdpSocket extends EventEmitter {
  constructor(network, { address = '127.0.0.1', port, baseSocket = null } = {}) {
    super();
    if (!Number.isInteger(port) || port <= 0) {
      throw new TypeError(`fault-udp: endpoint port must be a positive integer, got ${JSON.stringify(port)}`);
    }
    this.network = network;
    this.baseSocket = baseSocket;
    this.local = { address, port };
    this.peer = null;
    this.closed = false;
    this.silent = false;
    /** Datagrams handed to the network by this endpoint, for call-site debugging. */
    this.sentCount = 0;
    this._onBaseMessage = (buf, rinfo) => {
      if (this.closed) return;
      this.emit('message', Buffer.from(buf), rinfo);
    };
    if (baseSocket !== null) {
      if (typeof baseSocket.on !== 'function' || typeof baseSocket.send !== 'function') {
        throw new TypeError('fault-udp: baseSocket must provide on() and send()');
      }
      baseSocket.on('message', this._onBaseMessage);
    }
  }

  /** Same shape as `dgram.Socket#address()`. */
  address() {
    return { address: this.local.address, port: this.local.port, family: 'IPv4' };
  }

  // `dgram` sockets are ref'd by default; the P2P node calls these optionally.
  ref() { return this; }

  unref() { return this; }

  /**
   * Send one datagram.
   *
   * Accepts both the project's public shape `send(buf, peer)` and the `dgram` shape
   * `send(buf, port, address, cb)`, so an endpoint can be injected as a socket with
   * no adapter.
   *
   * @param {Buffer|Uint8Array|string} payload
   * @param {{address:string, port:number}|number} peerOrPort
   * @param {string|Function} [addressOrCallback]
   * @param {Function} [callback]
   */
  send(payload, peerOrPort, addressOrCallback, callback) {
    if (this.closed) {
      throw Object.assign(new Error('fault-udp: the socket is closed'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
    }
    const cb = typeof addressOrCallback === 'function' ? addressOrCallback : callback;
    let peer;
    if (peerOrPort !== null && typeof peerOrPort === 'object') {
      peer = { address: peerOrPort.address, port: peerOrPort.port };
    } else {
      peer = { address: addressOrCallback, port: peerOrPort };
    }
    if (typeof peer.address !== 'string' || peer.address === '') {
      throw new TypeError(`fault-udp: send() needs a peer address, got ${JSON.stringify(peer.address)}`);
    }
    if (!Number.isInteger(peer.port) || peer.port <= 0 || peer.port > 65535) {
      throw new TypeError(`fault-udp: send() needs a peer port in 1..65535, got ${JSON.stringify(peer.port)}`);
    }
    let buf;
    if (Buffer.isBuffer(payload)) buf = payload;
    else if (typeof payload === 'string') buf = Buffer.from(payload, 'utf8');
    else if (ArrayBuffer.isView(payload)) buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    else throw new TypeError('fault-udp: send() needs a Buffer, Uint8Array or string payload');

    this.sentCount += 1;
    this.network.stage({ from: this, to: peer, buf, callback: cb });
    return this;
  }

  // ---- explicit, one-shot fault triggers (delegated to the shared plan) ------
  drop(nth) { this.network.drop(nth); return this; }

  duplicate(nth) { this.network.duplicate(nth); return this; }

  reorder(first, second) { this.network.reorder(first, second); return this; }

  /** Make the peer unreachable without handing the far end a BYE (a crashed process). */
  goSilent() { this.silent = true; return this; }

  /** Undo `goSilent()`, e.g. for a reconnect/retry scenario. */
  resume() { this.silent = false; return this; }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.baseSocket !== null) this.baseSocket.removeListener?.('message', this._onBaseMessage);
    this.network._detach(this);
    this.emit('close');
    this.removeAllListeners();
  }
}

/** One shared fault plan + clock + schedule, and the endpoints attached to it. */
class FaultUdpNetwork {
  constructor(options = {}) {
    const {
      seed = 1,
      dropRate = 0,
      duplicateRate = 0,
      reorderWindow = 0,
      reorderRate = 0.5,
      duplicateDelayMs = 2,
      latencyMs = 0,
      now = null,
      autopumpMs = 0,
      autopumpRef = true,
      maxScheduled = DEFAULT_MAX_SCHEDULED,
    } = options;
    for (const [name, value] of [['dropRate', dropRate], ['duplicateRate', duplicateRate], ['reorderRate', reorderRate]]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`fault-udp: ${name} must be a number in [0,1], got ${JSON.stringify(value)}`);
      }
    }
    for (const [name, value] of [['reorderWindow', reorderWindow], ['duplicateDelayMs', duplicateDelayMs], ['latencyMs', latencyMs]]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`fault-udp: ${name} must be a non-negative number, got ${JSON.stringify(value)}`);
      }
    }
    if (!Number.isInteger(maxScheduled) || maxScheduled < 1) {
      throw new TypeError('fault-udp: maxScheduled must be a positive integer');
    }
    this.random = createSeededRandom(seed);
    this.dropRate = dropRate;
    this.duplicateRate = duplicateRate;
    this.reorderWindow = reorderWindow;
    this.reorderRate = reorderWindow > 0 ? reorderRate : 0;
    this.duplicateDelayMs = duplicateDelayMs;
    this.latencyMs = latencyMs;
    this.maxScheduled = maxScheduled;
    this._baseNow = typeof now === 'function' ? now : () => 0;
    this._offset = 0;
    this.endpoints = new Map();
    /** Public, inspectable delivery queue; entries are `{seq, ordinal, dueMs, from, to, buf, kind}`. */
    this.schedule = [];
    this.closed = false;
    this._seq = 0;
    this._byOrdinal = new Map();
    this._explicit = new Map();
    this._reorderPairs = [];
    this._counters = {
      sent: 0,
      dropped: 0,
      duplicated: 0,
      reordered: 0,
      delivered: 0,
      silenced: 0,
      unroutable: 0,
      explicitDropped: 0,
      explicitDuplicated: 0,
      explicitReordered: 0,
    };
    this._autopumpError = null;
    this._pump = null;
    if (autopumpMs > 0) {
      this._pump = setInterval(() => {
        try {
          this.flush();
        } catch (error) {
          // Kept for the test to assert on; an interval callback must not throw.
          this._autopumpError = error;
        }
      }, autopumpMs);
      // Held ref'd by default: a suite that awaits a protocol promise needs *something*
      // keeping the loop alive, because P2PChannel's retransmission timers are unref()ed.
      // `close()` clears it; tests that forget get `--test-force-exit`, as the project's
      // suite command already uses.
      if (autopumpRef === false) this._pump.unref?.();
    }
  }

  /** Register an in-memory endpoint and return the dgram-shaped socket. */
  endpoint(options = {}) {
    const port = options.port ?? (41_000 + this.endpoints.size + 1);
    const endpoint = new FaultUdpSocket(this, { address: options.address ?? '127.0.0.1', port });
    this.endpoints.set(toKey(endpoint.local), endpoint);
    return endpoint;
  }

  /** Link two fresh endpoints into a pair; tests that need more call `endpoint()` directly. */
  pair(options = {}) {
    const a = this.endpoint({ address: options.aAddress, port: options.aPort ?? 41_001 });
    const b = this.endpoint({ address: options.bAddress, port: options.bPort ?? 41_002 });
    a.peer = { ...b.local };
    b.peer = { ...a.local };
    return { a, b };
  }

  /** The effective clock: the caller's `now()` plus whatever `advance()` moved. */
  now() { return this._baseNow() + this._offset; }

  /** Move the scheduling clock forward without delivering anything. */
  advance(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new TypeError('fault-udp: advance(ms) needs a non-negative number');
    }
    this._offset += ms;
    return this.now();
  }

  /** `advance(ms)` followed by a drain; the convenient deterministic tick. */
  tick(ms) {
    this.advance(ms);
    return this.flush();
  }

  /** Datagrams staged but not yet due. */
  pending() { return this.schedule.length; }

  stats() {
    return { ...this._counters, pending: this.schedule.length };
  }

  /** @internal — one datagram arriving from an endpoint. */
  stage({ from, to, buf, callback }) {
    if (this.closed) {
      throw new Error('fault-udp: the network is closed');
    }
    const ordinal = ++this._counters.sent;
    const explicit = this._explicit.get(ordinal) ?? {};
    const drop = explicit.drop === true || (explicit.drop === undefined && this._roll(this.dropRate));
    const duplicate = explicit.duplicate === true
      || (explicit.duplicate === undefined && this._roll(this.duplicateRate));
    const reorder = explicit.reorder === true
      || (explicit.reorder === undefined && this._roll(this.reorderRate));

    this._callback(callback);
    if (drop) {
      this._counters.dropped += 1;
      if (explicit.drop === true) this._counters.explicitDropped += 1;
      this._explicit.delete(ordinal);
      return;
    }

    const baseDue = this.now() + this.latencyMs + (reorder ? this.reorderWindow : 0);
    if (reorder) {
      this._counters.reordered += 1;
      if (explicit.reorder === true) this._counters.explicitReordered += 1;
    }
    const entry = {
      seq: ++this._seq,
      ordinal,
      dueMs: baseDue,
      from,
      to: { ...to },
      buf,
      kind: 'data',
    };
    this._push(entry);
    if (duplicate) {
      this._counters.duplicated += 1;
      if (explicit.duplicate === true) this._counters.explicitDuplicated += 1;
      this._push({ ...entry, seq: ++this._seq, dueMs: baseDue + this.duplicateDelayMs, kind: 'duplicate' });
    }
    this._applyReorderPairs(ordinal);
    this._explicit.delete(ordinal);
  }

  /** @internal — remove one endpoint (called by `FaultUdpSocket#close`). */
  _detach(endpoint) {
    this.endpoints.delete(toKey(endpoint.local));
  }

  _roll(rate) {
    if (rate <= 0) return false;
    if (rate >= 1) return true;
    return this.random() < rate;
  }

  _push(entry) {
    if (this.schedule.length >= this.maxScheduled) {
      throw new Error(
        `FAULT_UDP_QUEUE_OVERFLOW: ${this.schedule.length} datagrams staged and not flushed ` +
          `(maxScheduled=${this.maxScheduled}); call flush()/advance() in the scenario`,
      );
    }
    this.schedule.push(entry);
    if (entry.kind === 'data' && !this._byOrdinal.has(entry.ordinal)) {
      this._byOrdinal.set(entry.ordinal, entry);
    }
  }

  _callback(callback) {
    if (typeof callback !== 'function') return;
    // Real dgram calls back asynchronously; matching that keeps ordering assumptions honest.
    queueMicrotask(() => callback(null));
  }

  // ---- explicit triggers -----------------------------------------------------
  /** Drop the n-th datagram sent after this call (1-based global send ordinal). */
  drop(nth) {
    this._trigger(nth, { drop: true });
    return this;
  }

  /** Deliver the n-th datagram twice (the second copy arrives `duplicateDelayMs` later). */
  duplicate(nth) {
    this._trigger(nth, { duplicate: true });
    return this;
  }

  /** Deliver `second` before `first`, whatever their latency would have been. */
  reorder(first, second) {
    if (!Number.isInteger(first) || !Number.isInteger(second) || first < 1 || second < 1) {
      throw new TypeError('fault-udp: reorder(first, second) needs positive integer send ordinals');
    }
    this._reorderPairs.push({ first, second });
    return this;
  }

  _trigger(nth, patch) {
    if (!Number.isInteger(nth) || nth < 1) {
      throw new TypeError(`fault-udp: a trigger needs a positive integer send ordinal, got ${JSON.stringify(nth)}`);
    }
    this._explicit.set(nth, { ...(this._explicit.get(nth) ?? {}), ...patch });
  }

  _applyReorderPairs(ordinal) {
    for (const pair of this._reorderPairs) {
      if (pair.first === ordinal) pair.firstEntry = this._byOrdinal.get(pair.first) ?? null;
      if (pair.second !== ordinal) continue;
      const first = pair.firstEntry ?? this._byOrdinal.get(pair.first) ?? null;
      const second = this._byOrdinal.get(pair.second) ?? null;
      if (first === null || second === null || first === second) continue;
      if (first.dueMs > second.dueMs) continue; // already delivered later: nothing to inject
      // The later-staged datagram becomes due first; the earlier one is pushed past it.
      // `+ 1` makes the swap effective even when both were scheduled for the same instant,
      // where insertion order (seq) would otherwise restore the original order.
      second.dueMs = Math.min(first.dueMs, second.dueMs);
      first.dueMs = Math.max(second.dueMs, first.dueMs) + 1;
      this._counters.reordered += 1;
      this._counters.explicitReordered += 1;
      pair.applied = true;
    }
  }

  /**
   * Deliver every datagram that is due at the current clock, in `(dueMs, seq)` order.
   *
   * Datagrams staged by a delivery handler are considered by the same flush, which is
   * what makes "send → ACK → send" progress in one deterministic step. Bounded by
   * `maxFlushRounds` so a pathological ping-pong cannot hang a test.
   *
   * @returns {number} datagrams delivered by this call
   */
  flush() {
    let delivered = 0;
    for (let round = 0; ; round += 1) {
      if (round > DEFAULT_MAX_FLUSH_ROUNDS) {
        throw new Error(`FAULT_UDP_FLUSH_RUNAWAY: more than ${DEFAULT_MAX_FLUSH_ROUNDS} rounds with datagrams still due`);
      }
      const now = this.now();
      const due = this.schedule.filter((entry) => entry.dueMs <= now);
      if (due.length === 0) break;
      due.sort((left, right) => (left.dueMs - right.dueMs) || (left.seq - right.seq));
      for (const entry of due) {
        const index = this.schedule.indexOf(entry);
        if (index >= 0) this.schedule.splice(index, 1);
        if (this._byOrdinal.get(entry.ordinal) === entry) this._byOrdinal.delete(entry.ordinal);
        if (this._deliver(entry)) delivered += 1;
      }
    }
    return delivered;
  }

  _deliver(entry) {
    if (this.closed) return false;
    const { from, to, buf } = entry;
    if (from.silent || from.closed) {
      this._counters.silenced += 1;
      return false;
    }
    if (from.baseSocket !== null) {
      // Wrapped real socket: the surviving datagram is what the base socket actually sends.
      from.baseSocket.send(buf, to.port, to.address, () => {});
      this._counters.delivered += 1;
      return true;
    }
    const destination = this.endpoints.get(toKey(to));
    if (destination === undefined || destination.closed || destination.silent) {
      // UDP has no delivery receipt: a datagram to a dead peer is silently lost.
      this._counters.unroutable += 1;
      return false;
    }
    this._counters.delivered += 1;
    destination.emit('message', Buffer.from(buf), {
      address: from.local.address,
      port: from.local.port,
      size: buf.length,
      family: 'IPv4',
    });
    return true;
  }

  /** Thrown inside the autopump interval, if any; `null` when nothing failed. */
  autopumpError() { return this._autopumpError; }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._pump !== null) clearInterval(this._pump);
    this._pump = null;
    this.schedule.length = 0;
    for (const endpoint of this.endpoints.values()) {
      endpoint.closed = true;
    }
    this.endpoints.clear();
  }
}

/**
 * Create one fault-injecting datagram layer.
 *
 * @param {object} [options]
 * @param {number} [options.seed=1] PRNG seed; the same scenario + seed is reproducible.
 * @param {number} [options.dropRate=0] Per-datagram loss probability, 0..1.
 * @param {number} [options.duplicateRate=0] Per-datagram duplication probability, 0..1.
 * @param {number} [options.reorderWindow=0] Extra delay applied to selected datagrams (ms).
 * @param {number} [options.reorderRate=0.5] Probability of the reorderWindow delay, when >0.
 * @param {number} [options.duplicateDelayMs=2] Arrival gap between the original and its copy.
 * @param {number} [options.latencyMs=0] Base one-way delay for every datagram.
 * @param {()=>number} [options.now] Clock source; default is a virtual clock at 0.
 * @param {number} [options.autopumpMs=0] When >0, drain the schedule on an unref()ed interval.
 * @param {number} [options.maxScheduled=50000] Queue ceiling; overflow is a loud error.
 * @param {object|null} [options.baseSocket=null] Wrap this real socket's egress instead of
 *   an in-memory peer table. Inbound datagrams are forwarded unchanged.
 * @param {{address:string, port:number}|null} [options.local] Endpoint address when wrapping.
 * @returns {{
 *   send: Function, on: Function, close: Function, address: Function,
 *   network: FaultUdpNetwork, drop: Function, duplicate: Function, reorder: Function,
 *   goSilent: Function, resume: Function, local: {address:string, port:number},
 * }}
 *   The returned object is the dgram-shaped endpoint (see the module comment) and
 *   exposes the shared plan as `.network` (`schedule`, `flush`, `advance`, `stats`).
 */
export function createFaultUdp(options = {}) {
  const { baseSocket = null, local = null, ...plan } = options;
  const network = new FaultUdpNetwork(plan);
  let endpoint;
  if (baseSocket !== null) {
    const address = local?.address ?? baseSocket.address?.()?.address ?? '127.0.0.1';
    const port = local?.port ?? baseSocket.address?.()?.port;
    endpoint = new FaultUdpSocket(network, { address, port, baseSocket });
  } else {
    const address = local?.address ?? '127.0.0.1';
    const port = local?.port ?? 41_001;
    endpoint = new FaultUdpSocket(network, { address, port });
    network.endpoints.set(toKey(endpoint.local), endpoint);
  }
  endpoint.network = network;
  return endpoint;
}

/**
 * Create a linked pair of in-memory endpoints sharing one fault plan.
 *
 * This is the shape the P2P matrix uses: each side is a dgram socket, no real socket
 * is ever bound, and both directions draw faults from the same seeded plan.
 *
 * @param {object} [options] Same as {@link createFaultUdp}, plus `aAddress/aPort/bAddress/bPort`.
 * @returns {{
 *   a: object, b: object, network: FaultUdpNetwork,
 *   peers: {a:{address:string,port:number}, b:{address:string,port:number}},
 *   flush: ()=>number, advance: (ms:number)=>number, tick: (ms:number)=>number,
 *   pending: ()=>number, stats: ()=>object, close: ()=>void,
 * }}
 */
export function createFaultUdpPair(options = {}) {
  const network = new FaultUdpNetwork(options);
  const a = network.endpoint({ address: options.aAddress ?? '127.0.0.1', port: options.aPort ?? 41_001 });
  const b = network.endpoint({ address: options.bAddress ?? '127.0.0.1', port: options.bPort ?? 41_002 });
  a.peer = { ...b.local };
  b.peer = { ...a.local };
  return {
    a,
    b,
    network,
    peers: { a: { ...a.local }, b: { ...b.local } },
    flush: () => network.flush(),
    advance: (ms) => network.advance(ms),
    tick: (ms) => network.tick(ms),
    pending: () => network.pending(),
    stats: () => network.stats(),
    close: () => network.close(),
  };
}

export default createFaultUdp;
