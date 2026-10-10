/**
 * P2PNode and accept() suite (v0.4.0): modes, announcement, punching out, accepting in.
 *
 * Everything that can use a real socket does: the punches below are real UDP punches
 * between two nodes on the loopback interface, and the payloads are real fragmented
 * messages over the real channel. Honest limit, stated here because the alternative is
 * overclaiming: loopback has no NAT to cross, so "the punch succeeded" says nothing
 * about traversal. What these cases do prove is the node's own contracts — one socket
 * for its whole life, candidates in the documented order, named failures that do not
 * throw, exactly one channel per session, and no socket at all in `relay` mode.
 *
 * Three injections make that deterministic, and each one is deliberate:
 *
 *   * `bindUdpSocket` — counts binds ("`relay` binds nothing") and can report a private
 *     local address, because a default bind answers `0.0.0.0` and the LAN-candidate rule
 *     needs a real private address to exercise.
 *   * `discover` — replaces public STUN with a fixed answer, and can produce the
 *     specific failures this node must survive. There is no network access here.
 *   * `postJson`/`getJson` — an in-memory relay that mirrors the real routes' shapes
 *     (including the named 404), so the node is exercised against the protocol rather
 *     than against a convenient stub.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';

import { P2PChannel, accept, connect, deriveSession, punchSession } from '../src/agent/p2p.mjs';
import { bindUdpSocket } from '../src/agent/stun.mjs';
import {
  DEFAULT_P2P_MODE,
  P2P_DEFAULTS,
  P2P_MODES,
  P2PNode,
  PUBLIC_STUN_SERVERS,
  SHARED_SERVER,
  normalizeP2PMode,
  normalizeP2PPort,
  stunServersWithShared,
} from '../src/agent/p2p-node.mjs';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Wait for one event, without `events.once`.
 *
 * `once()` attaches its own `'error'` listener and turns an `'error'` emit into a
 * rejection of the *unrelated* promise being awaited. These cases want an error to
 * surface where it belongs — in `status.last_error` and the assertions around it.
 *
 * @returns {Promise<any[]>} The event's arguments.
 */
function nextEvent(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

/** Poll a predicate with a deadline. Only used where no event reports the fact. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/** A HELLO frame, built from the framing table in the p2p.mjs header (not its helpers). */
function helloFrame(session) {
  const out = Buffer.alloc(5);
  out.writeUInt8(1, 0); // HELLO
  out.writeUInt32BE(session >>> 0, 1);
  return out;
}

/**
 * Record every datagram a socket sends, without changing what it sends.
 *
 * The node's outbound traffic is otherwise invisible from outside: `dial()` returns a result and the
 * peer either answers or does not. A case that has to prove *this end sent something*, and that the
 * something carried the right session, needs the socket itself — which is exactly what
 * `countingBinder` already hands back.
 *
 * @param {import('node:dgram').Socket} socket
 * @returns {Array<{bytes: Buffer, port: number, address: string}>}
 */
function recordSends(socket) {
  const sent = [];
  const original = socket.send.bind(socket);
  socket.send = (msg, port, address, callback) => {
    sent.push({ bytes: Buffer.from(msg), port, address });
    return original(msg, port, address, callback);
  };
  return sent;
}

/** The frames a recorder saw, decoded from the framing table in the p2p.mjs header. */
function framesOf(sent) {
  return sent
    .filter((entry) => entry.bytes.length >= 5)
    .map((entry) => ({ kind: entry.bytes.readUInt8(0), session: entry.bytes.readUInt32BE(1), to: entry.port }));
}

/** The relay's two P2P routes, in memory, with the real server's response shapes. */
function fakeRelay() {
  const peers = new Map();
  const posts = [];
  const gets = [];
  return {
    peers,
    posts,
    gets,
    /** The transport pair one machine would use. */
    client(machineId) {
      return {
        postJson: async (path, body) => {
          posts.push({ from: machineId, path, body });
          if (path !== '/v1/peer/announce') return { ok: false, status: 404, json: null, error: null };
          peers.set(machineId, { candidates: body.candidates, nat: body.nat, ttl_ms: body.ttl_ms });
          return {
            ok: true,
            status: 200,
            json: { protocol_version: 1, candidates: body.candidates },
            error: null,
          };
        },
        getJson: async (path) => {
          gets.push({ from: machineId, path });
          const match = /^\/v1\/peer\/(.+)$/.exec(path);
          const id = match ? decodeURIComponent(match[1]) : null;
          const entry = peers.get(id);
          if (!entry) {
            // The relay's own 404, detail and all: "not announced yet" is an ordinary
            // state with a named answer, not an empty candidate list.
            return {
              ok: false,
              status: 404,
              json: { error: { code: 'NOT_FOUND', message: `no live P2P announcement for ${id}` } },
              error: null,
            };
          }
          return {
            ok: true,
            status: 200,
            json: { peer: { machine_id: id, candidates: entry.candidates, nat: entry.nat } },
            error: null,
          };
        },
      };
    },
  };
}

/**
 * A counting stand-in for `bindUdpSocket`: a real socket, plus the three facts a test
 * needs (whether a bind happened, what endpoint the node asked for, and what local
 * address the node is told about).
 *
 * Every call's options are recorded verbatim, so "the node binds exactly once" and "the
 * node binds the endpoint it was configured with" are assertions about the arguments
 * rather than about a description of them.
 *
 * `reportRequestedPort` makes the binder answer with the port the *caller* asked for, which
 * is how a pinned `bindPort` is exercised without depending on that port being free on the
 * machine running the suite.
 *
 * @param {{reportedAddress?: string|null, reportRequestedPort?: boolean}} [options]
 */
function countingBinder({ reportedAddress = null, reportRequestedPort = false } = {}) {
  const calls = [];
  const sockets = [];
  return {
    calls,
    sockets,
    bindUdpSocket: async (options = {}) => {
      calls.push({ ...options });
      const bound = await bindUdpSocket();
      sockets.push(bound.socket);
      if (reportedAddress === null && !reportRequestedPort) return bound;
      const pinned = reportRequestedPort && Number.isInteger(options.port) && options.port > 0;
      return {
        socket: bound.socket,
        local: {
          address: reportedAddress ?? bound.local.address,
          port: pinned ? options.port : bound.local.port,
        },
      };
    },
  };
}

/** Discovery that reports the socket's own loopback port: "a peer can reach me here". */
function loopbackDiscovery(seen = null) {
  return async (options) => {
    if (seen !== null) seen.push(options);
    const bound = options.socket.address();
    return {
      ok: true,
      reflexive: { address: '127.0.0.1', port: bound.port },
      mapping: 'none',
      local: { address: bound.address, port: bound.port },
      servers: [],
      error: null,
    };
  };
}

/** Discovery that reports a fixed address on the socket's own port. */
function fixedAddressDiscovery(address) {
  return async (options) => {
    const bound = options.socket.address();
    return {
      ok: true,
      reflexive: { address, port: bound.port },
      mapping: 'none',
      local: { address: bound.address, port: bound.port },
      servers: [],
      error: null,
    };
  };
}

/** Discovery that found nothing, the way `discoverReflexive` reports it. */
function unreachableDiscovery(error = 'STUN_UNREACHABLE: no configured STUN server answered') {
  return async () => ({
    ok: false,
    reflexive: null,
    mapping: 'unknown',
    local: { address: '0.0.0.0', port: 0 },
    servers: [],
    error,
  });
}

/** Test timings: one immediate announce, one accept loop re-arm, fast punches. */
function testTuning(overrides = {}) {
  return { refreshMs: 60_000, punchTimeoutMs: 1500, acceptTimeoutMs: 150, announceTtlMs: 5000, ...overrides };
}

/**
 * A node wired to the fake relay, a real socket and an injected discovery answer.
 *
 * Unless a test injects its own binder, the node's *reported* local address is loopback.
 * That is not decoration: loopback is not a private address, so the local-candidate rule
 * produces nothing and the announced list is exactly the one injected reflexive address.
 * A punch in a test then has one destination with no ordering race between several
 * candidates, which is what keeps these cases free of sleeps and retries.
 */
function makeNode(machineId, relay, options = {}) {
  const client = relay.client(machineId);
  return new P2PNode({
    machineId,
    mode: options.mode ?? 'auto',
    rabbitUrl: options.rabbitUrl ?? 'http://relay.test',
    postJson: options.postJson ?? client.postJson,
    getJson: options.getJson ?? client.getJson,
    discover: options.discover ?? loopbackDiscovery(),
    bindUdpSocket: options.bindUdpSocket ?? countingBinder({ reportedAddress: '127.0.0.1' }).bindUdpSocket,
    ...(options.bindAddress === undefined ? {} : { bindAddress: options.bindAddress }),
    ...(options.bindPort === undefined ? {} : { bindPort: options.bindPort }),
    tuning: options.tuning ?? testTuning(),
    log: options.log ?? (() => {}),
  });
}

/** Start a node and wait for its first announcement. */
async function startAnnounced(node) {
  const announced = nextEvent(node, 'announce');
  const started = await node.start();
  assert.deepEqual(started, { ok: true, enabled: true, error: null });
  await announced;
}

/** The private IPv4 addresses this machine has, computed independently of the module. */
function expectedPrivateAddresses() {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || !entry.address.includes('.')) continue;
      const [a, b] = entry.address.split('.').map(Number);
      const isPrivate =
        a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
      if (isPrivate && !out.includes(entry.address)) out.push(entry.address);
    }
  }
  return out;
}

/** Two running, announced nodes with a live channel between them. */
async function connectedPair(session = 0x5eed0001) {
  const relay = fakeRelay();
  const a = makeNode('machine-a', relay);
  const b = makeNode('machine-b', relay);
  await startAnnounced(a);
  await startAnnounced(b);

  const dialled = await a.dial('machine-b', { session });
  assert.equal(dialled.ok, true, dialled.error ?? '');
  // One handshake, so the responder's channel — which the dialler cannot see — is
  // handed back through the documented `'message'` shape instead of a private field.
  const inbound = nextEvent(b, 'message');
  await dialled.channel.send('ready');
  const [welcome] = await inbound;
  return {
    relay,
    a,
    b,
    aChannel: dialled.channel,
    bChannel: welcome.channel,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Modes                                                                       */
/* -------------------------------------------------------------------------- */

describe('p2p-node: mode normalisation', () => {
  it('accepts exactly the three modes', () => {
    assert.deepEqual([...P2P_MODES], ['auto', 'direct', 'relay']);
    assert.equal(Object.isFrozen(P2P_MODES), true);
    assert.equal(DEFAULT_P2P_MODE, 'auto');
    assert.ok(P2P_MODES.includes(DEFAULT_P2P_MODE));
    for (const mode of P2P_MODES) {
      assert.deepEqual(normalizeP2PMode(mode), { ok: true, mode });
    }
  });

  it('names a reason for everything else, and never returns a default', () => {
    const cases = [
      [undefined, 'P2P_MODE_MISSING'],
      [null, 'P2P_MODE_MISSING'],
      ['', 'P2P_MODE_EMPTY'],
      ['AUTO', 'P2P_MODE_NOT_LOWERCASE'],
      ['Relay', 'P2P_MODE_NOT_LOWERCASE'],
      ['Direct', 'P2P_MODE_NOT_LOWERCASE'],
      [' auto', 'P2P_MODE_WHITESPACE'],
      ['direct ', 'P2P_MODE_WHITESPACE'],
      [42, 'P2P_MODE_NOT_A_STRING'],
      [true, 'P2P_MODE_NOT_A_STRING'],
      [{ mode: 'auto' }, 'P2P_MODE_NOT_A_STRING'],
      ['turbo', 'P2P_MODE_UNKNOWN'],
      ['autopilot', 'P2P_MODE_UNKNOWN'],
      ['a u t o', 'P2P_MODE_UNKNOWN'],
    ];
    for (const [value, code] of cases) {
      const result = normalizeP2PMode(value);
      assert.equal(result.ok, false, `${JSON.stringify(value)} must not be accepted`);
      assert.equal('mode' in result, false, 'a rejected input must not come back with a mode');
      assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
      assert.match(result.reason, new RegExp(`^${code}: `), `${JSON.stringify(value)} -> ${result.reason}`);
    }
    // The reason has to name the offending value and the value to write instead, or an
    // operator staring at a config file learns nothing from the failure.
    assert.match(normalizeP2PMode('AUTO').reason, /"AUTO"/);
    assert.match(normalizeP2PMode('AUTO').reason, /"auto"/);
    assert.match(normalizeP2PMode(' auto').reason, /" auto"/);
  });

  it('rejects a case variant loudly, because a mode is a wire value', () => {
    // Not a style preference: the relay compares `p2p.mode` against P2P_MODES with `===`
    // and the mode is copied verbatim into the stored task and the result envelope.
    // Accepting 'AUTO' here would only move the failure to the far end, several layers
    // from the typo that caused it.
    assert.equal(normalizeP2PMode('AUTO').ok, false);
    assert.equal(P2P_MODES.includes('AUTO'), false);
    assert.equal(normalizeP2PMode('auto').ok, true, 'the canonical spelling still works');
  });

  it('is loud in the constructor too', () => {
    assert.throws(() => new P2PNode({ machineId: 'm', mode: 'AUTO' }), /P2P_MODE_NOT_LOWERCASE/);
    assert.throws(() => new P2PNode({ machineId: 'm', mode: '' }), /P2P_MODE_EMPTY/);
    assert.throws(() => new P2PNode({ mode: 'auto' }), /machineId is required/);
    assert.throws(() => new P2PNode({ machineId: 'm', tuning: { refreshMS: 10 } }), /unknown tuning key/);
    assert.throws(() => new P2PNode({ machineId: 'm', tuning: { refreshMs: 0 } }), /positive number/);
    assert.throws(() => new P2PNode({ machineId: 'm', postJson: 'nope' }), /postJson must be a function/);
    assert.throws(() => new P2PNode({ machineId: 'm', stunServers: [] }), /stunServers must be a non-empty/);
    assert.throws(
      () => new P2PNode({ machineId: 'm', bindPort: 65536 }),
      /bindPort must be an integer in 0\.\.65535/,
    );
    assert.throws(
      () => new P2PNode({ machineId: 'm', bindPort: -1 }),
      /bindPort must be an integer in 0\.\.65535/,
    );
    assert.throws(
      () => new P2PNode({ machineId: 'm', bindPort: 1.5 }),
      /bindPort must be an integer in 0\.\.65535/,
    );
    assert.throws(() => new P2PNode({ machineId: 'm', bindAddress: '' }), /bindAddress must be a non-empty/);
    assert.throws(() => new P2PNode({ machineId: 'm', bindAddress: 7 }), /bindAddress must be a non-empty/);
    const defaults = new P2PNode({ machineId: 'm' });
    assert.equal(defaults.status.mode, DEFAULT_P2P_MODE);
    assert.equal(defaults.bindAddress, '0.0.0.0', 'the documented default endpoint');
    assert.equal(defaults.bindPort, 0, '0 means an ephemeral port');
  });
});

describe('p2p-node: punch port normalisation', () => {
  it('accepts a fixed port, a numeric string, and the ephemeral spelling', () => {
    // The default: no port written at all.
    assert.deepEqual(normalizeP2PPort(undefined), { ok: true, port: null });
    assert.deepEqual(normalizeP2PPort(null), { ok: true, port: null });
    // The CLI/env shape, which arrives as a string.
    assert.deepEqual(normalizeP2PPort('41234'), { ok: true, port: 41234 });
    assert.deepEqual(normalizeP2PPort(' 41234 '), { ok: true, port: 41234 });
    assert.deepEqual(normalizeP2PPort(1), { ok: true, port: 1 });
    assert.deepEqual(normalizeP2PPort(65535), { ok: true, port: 65535 });
  });

  it('refuses 0 and everything outside 1..65535, by name, never by coercion', () => {
    const cases = [
      [0, 'P2P_PORT_ZERO'],
      ['0', 'P2P_PORT_ZERO'],
      [65536, 'P2P_PORT_OUT_OF_RANGE'],
      [-1, 'P2P_PORT_OUT_OF_RANGE'],
      ['', 'P2P_PORT_EMPTY'],
      ['abc', 'P2P_PORT_NOT_AN_INTEGER'],
      // `Number()` would turn both of these into a port nobody wrote.
      ['0x10', 'P2P_PORT_NOT_AN_INTEGER'],
      ['1e3', 'P2P_PORT_NOT_AN_INTEGER'],
      [1.5, 'P2P_PORT_NOT_AN_INTEGER'],
      [true, 'P2P_PORT_NOT_AN_INTEGER'],
      [{ port: 41234 }, 'P2P_PORT_NOT_AN_INTEGER'],
    ];
    for (const [value, code] of cases) {
      const result = normalizeP2PPort(value);
      assert.equal(result.ok, false, `${JSON.stringify(value)} must not be accepted`);
      assert.equal('port' in result, false, 'a rejected input must not come back with a port');
      assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
      assert.match(result.reason, new RegExp(`^${code}: `), `${JSON.stringify(value)} -> ${result.reason}`);
    }
    // The zero case has to explain the alternative, because it is the value an operator is most
    // likely to reach for ("let the OS choose") and the one that breaks the firewall rule.
    assert.match(normalizeP2PPort(0).reason, /ephemeral/);
    assert.match(normalizeP2PPort(65536).reason, /1\.\.65535/);
  });
});

describe('p2p-node: shared server and STUN list', () => {
  it('publishes the frozen shared server and the public fallbacks', () => {
    assert.deepEqual(SHARED_SERVER, {
      host: '202.182.123.154',
      rabbitUrl: 'http://202.182.123.154:8787',
      stun: '202.182.123.154:3478',
    });
    assert.equal(Object.isFrozen(SHARED_SERVER), true);
    assert.equal(Object.isFrozen(PUBLIC_STUN_SERVERS), true);
    assert.deepEqual(
      [...PUBLIC_STUN_SERVERS],
      ['stun.cloudflare.com:3478', 'stun.l.google.com:19302', 'stun.nextcloud.com:443'],
    );
  });

  it('puts the shared server first and de-duplicates', () => {
    assert.deepEqual(stunServersWithShared(), [SHARED_SERVER.stun, ...PUBLIC_STUN_SERVERS]);
    assert.deepEqual(stunServersWithShared(['stun.internal:3478', 'stun.l.google.com:19302']), [
      SHARED_SERVER.stun,
      'stun.internal:3478',
      'stun.l.google.com:19302',
      'stun.cloudflare.com:3478',
      'stun.nextcloud.com:443',
    ]);
    // The shared entry arriving from configuration must not be queried twice: the first
    // answer is the one that becomes the reflexive address.
    assert.deepEqual(stunServersWithShared([SHARED_SERVER.stun]), [
      SHARED_SERVER.stun,
      ...PUBLIC_STUN_SERVERS,
    ]);
    // The CLI/env shape.
    assert.deepEqual(stunServersWithShared('a:1, b:2 ,,a:1'), [
      SHARED_SERVER.stun,
      'a:1',
      'b:2',
      ...PUBLIC_STUN_SERVERS,
    ]);
    assert.throws(() => stunServersWithShared(42), TypeError);
  });

  it('freezes the lifetimes the contract quotes', () => {
    assert.deepEqual(P2P_DEFAULTS, {
      announceTtlMs: 60_000,
      refreshMs: 20_000,
      punchTimeoutMs: 5_000,
      acceptTimeoutMs: 5_000,
      // v0.4.x: the window an executor may spend dialling a dispatcher it did not punch first. Part
      // of this frozen object on purpose -- "the relay copy is never held behind it" is a claim about
      // a number, and the number belongs where the contract can quote it.
      reverseDialTimeoutMs: 8_000,
      maxCandidates: 8,
    });
    assert.equal(Object.isFrozen(P2P_DEFAULTS), true);
    assert.ok(
      P2P_DEFAULTS.refreshMs * 2 < P2P_DEFAULTS.announceTtlMs,
      'two missed refreshes must still leave a live announcement on the relay',
    );
    assert.ok(
      P2P_DEFAULTS.reverseDialTimeoutMs > P2P_DEFAULTS.punchTimeoutMs,
      'a reverse dial races the other end\'s own punch, so it needs more room than a punch does',
    );
  });
});

describe('p2p-node: relay mode', () => {
  it('binds no socket at all and reports enabled:false', async () => {
    const bind = countingBinder();
    // No rabbitUrl and no transports on purpose: in relay mode neither is needed, and a
    // node that demanded them would make `p2pMode: 'relay'` a configuration burden.
    const node = new P2PNode({ mode: 'relay', machineId: 'machine-a', bindUdpSocket: bind.bindUdpSocket });

    assert.deepEqual(await node.start(), { ok: true, enabled: false, error: null });
    assert.equal(bind.calls.length, 0, 'relay mode must not create a dgram socket');
    const status = node.status;
    assert.equal(status.local, null, 'no port is held');
    assert.equal(status.running, false);
    assert.equal(status.enabled, false);
    assert.equal(status.mode, 'relay');
    assert.deepEqual(status.candidates, []);

    // The two operations that would need the direct path refuse by name instead of
    // throwing or, worse, silently doing nothing.
    assert.match((await node.announceNow()).error, /^P2P_DISABLED/);
    assert.match((await node.dial('machine-b')).error, /^P2P_DISABLED/);
    assert.equal(bind.calls.length, 0);

    await node.close();
    await node.close(); // idempotent
    assert.equal(node.status.running, false);
  });
});

/* -------------------------------------------------------------------------- */
/* Announcement                                                                */
/* -------------------------------------------------------------------------- */

describe('p2p-node: announcement', () => {
  it('binds exactly one socket in auto, announces through it, and re-announces on the timer', async () => {
    const relay = fakeRelay();
    const bind = countingBinder({ reportedAddress: '192.168.44.7' });
    const seen = [];
    const node = makeNode('machine-a', relay, {
      bindUdpSocket: bind.bindUdpSocket,
      discover: loopbackDiscovery(seen),
      tuning: testTuning({ refreshMs: 60 }),
    });

    const first = nextEvent(node, 'announce');
    assert.deepEqual(await node.start(), { ok: true, enabled: true, error: null });
    const [payload] = await first;

    assert.equal(bind.calls.length, 1, 'one socket for the whole life of the node');
    // The documented endpoint, and the reason a firewall rule has to be re-pointed after every
    // restart unless `bindPort` pins one: the OS chooses, so the port is a different number next
    // time. `{address, port}` is the whole argument, so the default cannot drift unnoticed.
    assert.deepEqual(bind.calls, [{ address: '0.0.0.0', port: 0 }], 'the default bind endpoint');
    assert.equal(node.bindPort, 0);
    assert.equal(node.bindAddress, '0.0.0.0');
    assert.equal(node.status.running, true);
    assert.equal(node.status.local.address, '192.168.44.7');
    assert.ok(node.status.local.port > 0, 'an ephemeral port');

    // Discovery was handed the bound socket and the configured server list, shared
    // server first.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].socket.address().port, node.status.local.port);
    assert.deepEqual(seen[0].servers, stunServersWithShared());

    // The announce body is the relay's contract, and only the relay's contract.
    assert.equal(relay.posts.length, 1);
    assert.equal(relay.posts[0].path, '/v1/peer/announce');
    assert.equal(relay.posts[0].from, 'machine-a');
    assert.deepEqual(Object.keys(relay.posts[0].body).sort(), ['candidates', 'nat', 'ttl_ms']);
    assert.deepEqual(relay.posts[0].body.nat, { mapping: 'none' });
    assert.equal(relay.posts[0].body.ttl_ms, 5000);
    // Reflexive first, then the private local address — the LAN fallback a peer on the
    // same network can use.
    assert.deepEqual(relay.posts[0].body.candidates, [
      { address: '127.0.0.1', port: node.status.local.port },
      { address: '192.168.44.7', port: node.status.local.port },
    ]);

    // The event carries what the status will say, and the status agrees with the relay.
    assert.deepEqual(payload.candidates, relay.posts[0].body.candidates);
    assert.equal(payload.mapping, 'none');
    assert.deepEqual(payload.reflexive, { address: '127.0.0.1', port: node.status.local.port });
    assert.deepEqual(node.status.candidates, relay.posts[0].body.candidates);
    assert.equal(node.status.announce_ok, true);
    assert.equal(node.status.announce_failures, 0);
    assert.equal(node.status.last_announce_error, null);
    assert.equal(typeof node.status.announced_at, 'string');
    assert.equal(Number.isNaN(Date.parse(node.status.announced_at)), false);

    // The refresh timer re-announces, and it does not hold the process open.
    assert.ok(node.refreshTimer !== null, 'the node owns the timer');
    await nextEvent(node, 'announce');
    assert.equal(relay.posts.length, 2, 'the second announcement is the refresh');
    // White-box on purpose: `hasRef()` is the only portable way to observe `unref()`, and
    // "a finished agent can exit" is a property worth asserting rather than describing.
    assert.equal(node.refreshTimer.hasRef(), false);

    await node.close();
    assert.equal(node.refreshTimer, null, 'the timer belongs to the node and dies with it');
    const afterClose = relay.posts.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(relay.posts.length, afterClose, 'a closed node must stop announcing');
  });

  it('binds the port it was configured with, so a firewall rule can outlive a restart', async () => {
    // The defect this pins: the node called the binder with no arguments at all, so a machine that
    // must *accept* a punch got a fresh ephemeral port on every start, `ufw allow <port>/udp` had to
    // be redone each time, and every dispatch fell back to the relay until it was.
    const relay = fakeRelay();
    const bind = countingBinder({ reportedAddress: '192.168.44.7', reportRequestedPort: true });
    const pinned = makeNode('machine-pinned', relay, {
      bindUdpSocket: bind.bindUdpSocket,
      bindPort: 41234,
    });

    await startAnnounced(pinned);
    assert.deepEqual(bind.calls, [{ address: '0.0.0.0', port: 41234 }], 'the pinned port reaches the binder');
    assert.deepEqual(pinned.status.local, { address: '192.168.44.7', port: 41234 });
    assert.equal(pinned.bindPort, 41234);
    // And it is the pinned port that is announced, not whatever the OS would have handed out: a
    // firewall rule is only useful if the peer is told the same port.
    const lanCandidate = pinned.status.candidates.find(
      (candidate) => candidate.address === '192.168.44.7' && candidate.port === 41234,
    );
    assert.ok(
      lanCandidate,
      `the LAN candidate must carry the pinned port: ${JSON.stringify(pinned.status.candidates)}`,
    );

    await pinned.close();
    assert.equal(pinned.status.local, null);
  });

  it('binds the address it was configured with too', async () => {
    const relay = fakeRelay();
    const bind = countingBinder();
    const node = makeNode('machine-bound-address', relay, {
      bindUdpSocket: bind.bindUdpSocket,
      bindAddress: '127.0.0.1',
    });

    await startAnnounced(node);
    assert.deepEqual(bind.calls, [{ address: '127.0.0.1', port: 0 }]);
    await node.close();
  });

  it('de-duplicates the candidate list and caps it at maxCandidates', async () => {
    // A machine with no NAT in front of it sees its own address from STUN, so the
    // reflexive and the local candidate are the same address. Announcing it twice would
    // spend one of eight slots on a duplicate.
    const relay = fakeRelay();
    const node = makeNode('machine-dup', relay, {
      bindUdpSocket: countingBinder({ reportedAddress: '192.168.44.7' }).bindUdpSocket,
      discover: fixedAddressDiscovery('192.168.44.7'),
    });
    const announced = nextEvent(node, 'announce');
    await node.start();
    const [payload] = await announced;
    assert.deepEqual(payload.candidates, [{ address: '192.168.44.7', port: node.status.local.port }]);
    assert.equal(relay.posts[0].body.candidates.length, 1);

    // And the ceiling: with one slot, only the reflexive address is announced even
    // though there is a second, local one to offer.
    const cappedRelay = fakeRelay();
    const capped = makeNode('machine-cap', cappedRelay, {
      bindUdpSocket: countingBinder({ reportedAddress: '192.168.44.7' }).bindUdpSocket,
      discover: fixedAddressDiscovery('203.0.113.9'),
      tuning: testTuning({ maxCandidates: 1 }),
    });
    const cappedAnnounced = nextEvent(capped, 'announce');
    await capped.start();
    const [cappedPayload] = await cappedAnnounced;
    assert.deepEqual(cappedPayload.candidates, [{ address: '203.0.113.9', port: capped.status.local.port }]);

    await node.close();
    await capped.close();
  });

  it('announces the local candidate when STUN is unreachable, and records the error', async () => {
    const relay = fakeRelay();
    const bind = countingBinder({ reportedAddress: '192.168.44.7' });
    const node = makeNode('machine-lan', relay, {
      bindUdpSocket: bind.bindUdpSocket,
      discover: unreachableDiscovery(),
    });

    const announced = nextEvent(node, 'announce');
    await node.start();
    const [payload] = await announced;

    // The announcement still happened. That is the whole point: one unreachable STUN
    // server must not stop a punch between two machines on the same network.
    assert.equal(relay.posts.length, 1);
    assert.deepEqual(relay.posts[0].body.candidates, [
      { address: '192.168.44.7', port: node.status.local.port },
    ]);
    assert.deepEqual(payload.candidates, relay.posts[0].body.candidates);
    assert.equal(payload.reflexive, null);

    // ... but it is not reported as complete.
    assert.equal(node.status.announce_ok, false);
    assert.equal(node.status.announce_failures, 1);
    assert.match(node.status.last_announce_error, /^STUN_UNREACHABLE: /);
    assert.match(node.status.last_error, /^STUN_UNREACHABLE: /);
    assert.equal(node.status.reflexive, null);
    assert.equal(node.status.mapping, 'unknown');
    assert.deepEqual(
      node.status.candidates,
      relay.posts[0].body.candidates,
      'the relay holds the LAN candidate',
    );
    assert.equal(
      typeof node.status.announced_at,
      'string',
      'a degraded announcement is still an announcement',
    );
  });

  it('never announces the wildcard, and uses the interfaces for a LAN punch', async () => {
    // A socket bound to the wildcard reports `0.0.0.0` as its own address, which is not a
    // destination. The contract wants the local address announced so that a dead STUN
    // server cannot stop a LAN punch, and for a wildcard bind the addresses that can
    // carry that punch are the machine's interfaces. This case therefore uses the real
    // binder, not the loopback-reporting one the other cases inject.
    const relay = fakeRelay();
    const expected = expectedPrivateAddresses();
    const client = relay.client('machine-lan');
    const node = new P2PNode({
      machineId: 'machine-lan',
      rabbitUrl: 'http://relay.test',
      postJson: client.postJson,
      getJson: client.getJson,
      discover: unreachableDiscovery(),
      tuning: testTuning(),
    });
    await node.start();
    // `start()` kicks the first announcement off without awaiting it. Wait for that attempt
    // to land — through status, which is the only signal when it fails — rather than
    // calling `announceNow()` and racing a second attempt past the first.
    assert.equal(
      await waitFor(() => node.status.announced_at !== null || node.status.announce_failures >= 1),
      true,
      'the first announcement must complete',
    );
    const candidates = node.status.candidates;

    assert.equal(node.status.local.address, '0.0.0.0', 'the wildcard bind is what is being tested');
    assert.equal(
      candidates.some((candidate) => candidate.address === '0.0.0.0'),
      false,
    );
    assert.ok(candidates.every((candidate) => candidate.port === node.status.local.port));
    if (expected.length === 0) {
      // No private interface at all: refusing loudly beats announcing nothing reachable.
      assert.equal(node.status.announce_ok, false);
      assert.match(node.status.last_announce_error, /^P2P_NO_CANDIDATES: /);
      assert.deepEqual(candidates, []);
      assert.equal(relay.posts.length, 0, 'an empty candidate list is never posted');
    } else {
      assert.deepEqual(
        candidates.map((candidate) => candidate.address),
        expected,
      );
      // The interfaces are announced even though STUN answered nothing: this is the LAN
      // punch the contract refuses to lose.
      assert.equal(relay.posts.length, 1);
      assert.deepEqual(relay.posts[0].body.candidates, candidates);
      assert.equal(node.status.announce_ok, false, 'no reflexive address means it is incomplete');
      assert.match(node.status.last_announce_error, /^STUN_UNREACHABLE/);
      assert.deepEqual(node.status.candidates, candidates, 'the relay holds them');
    }
    await node.close();
  });

  it('records a refused announcement in status instead of throwing when nobody listens', async () => {
    // A relay blip is routine. Node's default for an unhandled 'error' event is to throw,
    // which would take the host process down for one failed HTTP request; the node keeps
    // the error in `status` and emits only when a listener asked for it.
    const relay = fakeRelay();
    const bind = countingBinder({ reportedAddress: '192.168.44.7' });
    const node = makeNode('machine-down', relay, {
      bindUdpSocket: bind.bindUdpSocket,
      postJson: async () => ({
        ok: false,
        status: 503,
        json: { error: { code: 'UNAVAILABLE' } },
        error: null,
      }),
    });

    assert.equal(node.listenerCount('error'), 0);
    await assert.doesNotReject(() => node.start());
    assert.equal(await waitFor(() => node.status.announce_failures === 1), true, 'the attempt must land');
    assert.equal(node.status.announce_ok, false);
    assert.equal(node.status.last_announce_error, 'P2P_ANNOUNCE_FAILED: HTTP 503 UNAVAILABLE');
    assert.equal(node.status.last_error, 'P2P_ANNOUNCE_FAILED: HTTP 503 UNAVAILABLE');
    assert.deepEqual(node.status.candidates, [], 'a refused announcement leaves the relay holding nothing');

    // With a listener, the same error is delivered as an Error.
    const emitted = nextEvent(node, 'error');
    assert.equal(node.listenerCount('error'), 1);
    await node.announceNow();
    const [error] = await emitted;
    assert.ok(error instanceof Error);
    assert.match(error.message, /^P2P_ANNOUNCE_FAILED: HTTP 503 UNAVAILABLE$/);
    assert.equal(node.status.announce_failures, 2);

    await node.close();
  });

  it('shares one attempt between concurrent callers instead of double-posting', async () => {
    const relay = fakeRelay();
    const bind = countingBinder({ reportedAddress: '192.168.44.7' });
    const node = makeNode('machine-a', relay, { bindUdpSocket: bind.bindUdpSocket });
    await startAnnounced(node);
    assert.equal(relay.posts.length, 1);
    const [first, second] = await Promise.all([node.announceNow(), node.announceNow()]);
    assert.equal(relay.posts.length, 2, 'two callers, one attempt');
    assert.deepEqual(first, second);
    await node.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Dialling                                                                    */
/* -------------------------------------------------------------------------- */

describe('p2p-node: dialling over real sockets', () => {
  it('punches a peer on loopback and carries payloads in both directions', async () => {
    const relay = fakeRelay();
    const a = makeNode('machine-a', relay);
    const b = makeNode('machine-b', relay);
    try {
      await startAnnounced(a);
      await startAnnounced(b);
      // The rendezvous is real: the relay holds machine-b's actual ephemeral port.
      assert.deepEqual(relay.peers.get('machine-b').candidates, [
        { address: '127.0.0.1', port: b.status.local.port },
      ]);

      const session = deriveSession('task-1', 'machine-a', 'machine-b');
      const inbound = nextEvent(b, 'message');
      const result = await a.dial('machine-b', { session });

      assert.equal(result.ok, true, result.error ?? '');
      assert.ok(result.channel instanceof P2PChannel);
      assert.equal(result.session, session);
      assert.deepEqual(result.peer, { address: '127.0.0.1', port: b.status.local.port });
      assert.equal(typeof result.rttMs, 'number');
      assert.ok(result.rttMs >= 0);
      assert.ok(result.attempts >= 1);
      assert.equal(result.peersAnnounced, 1);
      assert.equal(result.error, null);

      const offer = JSON.stringify({ type: 'task.offer', task_id: 'task-1', attempt: 1 });
      await result.channel.send(offer);
      const [received] = await inbound;
      assert.equal(received.payload.toString('utf8'), offer);
      assert.equal(received.session, session);
      // A HELLO carries a session, not an identity, so an inbound channel has no `from`.
      assert.equal(received.from, null);
      assert.deepEqual(received.peer, { address: '127.0.0.1', port: a.status.local.port });
      assert.ok(received.channel instanceof P2PChannel);

      // And back the other way: that is what proves the punched path is bidirectional.
      const outbound = nextEvent(a, 'message');
      const replyFrame = JSON.stringify({ type: 'task.result', task_id: 'task-1' });
      await received.channel.send(replyFrame);
      const [reply] = await outbound;
      assert.equal(reply.payload.toString('utf8'), replyFrame);
      assert.equal(reply.from, 'machine-b', 'the dialling side knows which machine it dialled');
      assert.equal(reply.session, session);
      assert.deepEqual(reply.peer, { address: '127.0.0.1', port: b.status.local.port });

      assert.equal(a.status.punches_out, 1);
      assert.equal(a.status.dial_failures, 0);
      assert.equal(b.status.punches_in, 1);
      assert.equal(b.status.dial_failures, 0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('carries two payloads at once, one per direction, byte for byte', async () => {
    const pair = await connectedPair();
    const pattern = (length, seed) => {
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) out[i] = (i * 7 + seed) & 0xff;
      return out;
    };
    try {
      // Six kilobytes each way at the same time: several fragments per message in both
      // directions, which is the case a single-direction test cannot see.
      const fromA = pattern(6000, 3);
      const fromB = pattern(6000, 11);
      const atB = nextEvent(pair.b, 'message');
      const atA = nextEvent(pair.a, 'message');
      await Promise.all([pair.aChannel.send(fromA), pair.bChannel.send(fromB)]);
      const [gotB] = await atB;
      const [gotA] = await atA;
      assert.ok(gotB.payload.equals(fromA), 'A -> B must arrive intact');
      assert.ok(gotA.payload.equals(fromB), 'B -> A must arrive intact');

      // Ordering within one direction, using the channel's documented rule: messages
      // sent one at a time (each awaited) arrive in send order.
      const order = [];
      pair.b.on('message', (event) => order.push(event.payload.toString('utf8')));
      await pair.aChannel.send('first');
      await pair.aChannel.send('second');
      // Three or four entries here would mean a second channel is delivering the same
      // payloads as well.
      while (order.length < 2) await nextEvent(pair.b, 'message');
      assert.deepEqual(order, ['first', 'second']);
    } finally {
      await pair.close();
    }
  });

  it('re-acks a repeated HELLO for a live session without opening a second channel', async () => {
    const pair = await connectedPair(0x5eed0002);
    const session = 0x5eed0002;
    try {
      const deliveries = [];
      pair.b.on('message', (event) => deliveries.push(event.payload.toString('utf8')));
      await pair.aChannel.send('one');
      while (deliveries.length < 1) await nextEvent(pair.b, 'message');
      assert.deepEqual(deliveries, ['one']);

      // A second punch for the SAME session. The responding node already has a live
      // channel for it, so this HELLO must be acknowledged (the initiator is still
      // punching) but must not become another channel: two channels on one session would
      // each assemble and deliver every payload.
      const second = await pair.a.dial('machine-b', { session });
      assert.equal(second.ok, true, `a claimed session must still be acknowledged: ${second.error ?? ''}`);

      await second.channel.send('two');
      while (deliveries.length < 2) await nextEvent(pair.b, 'message');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(deliveries, ['one', 'two'], 'a second channel would have delivered both twice');

      assert.equal(pair.a.status.punches_out, 2);
      assert.equal(pair.b.status.punches_in, 1, 'the repeated HELLO was re-acked, not adopted');
      assert.equal(pair.b.claimed.has(session), true);
      assert.equal(pair.b.channels.size, 1);
    } finally {
      await pair.close();
    }
  });

  it('names a 404 as P2P_NO_CANDIDATES, and never throws', async () => {
    const relay = fakeRelay();
    const node = makeNode('machine-a', relay);
    try {
      await startAnnounced(node);
      const result = await node.dial('machine-ghost', { session: 0x1234 });

      assert.equal(result.ok, false);
      assert.equal(result.channel, null);
      assert.equal(result.peer, null);
      assert.equal(result.error, 'P2P_NO_CANDIDATES: the relay holds no live announcement for machine-ghost');
      assert.equal(result.attempts, 0, 'a punch is not attempted without candidates');
      assert.equal(result.peersAnnounced, 0);
      assert.equal(result.rttMs, null);
      assert.equal(node.status.dial_failures, 1);
      assert.match(node.status.last_error, /^P2P_NO_CANDIDATES/);
      // The relay really was asked. A local shortcut would make this pass without ever
      // exercising the route.
      assert.equal(relay.gets.at(-1).path, '/v1/peer/machine-ghost');

      // A caller bug is refused by name too, and is not counted as a dial failure.
      const bad = await node.dial('');
      assert.equal(bad.ok, false);
      assert.match(bad.error, /^P2P_BAD_MACHINE_ID/);
      assert.equal(node.status.dial_failures, 1);

      const badSession = await node.dial('machine-b', { session: 0 });
      assert.equal(badSession.ok, false);
      assert.match(badSession.error, /^P2P_BAD_SESSION/);
      assert.equal(node.status.dial_failures, 1);
    } finally {
      await node.close();
    }
  });

  it('dials the candidates an offer published, with the session it named, and asks the relay nothing', async () => {
    const relay = fakeRelay();
    const bind = countingBinder({ reportedAddress: '127.0.0.1' });
    const node = makeNode('mac-executor', relay, { bindUdpSocket: bind.bindUdpSocket });
    // The dispatcher, behind a NAT that swallowed its own push: a bare socket that answers HELLOs and
    // records them. Nothing about this end is a `P2PNode`, which is the point -- the reverse dial has
    // to work against a peer that has only ever *been* dialled.
    const dispatcher = await bindUdpSocket();
    const hellos = [];
    dispatcher.socket.on('message', (datagram, rinfo) => {
      if (datagram.length < 5 || datagram.readUInt8(0) !== 1) return; // 1 = HELLO
      hellos.push({ session: datagram.readUInt32BE(1), from: rinfo.port });
      const ack = Buffer.alloc(5);
      ack.writeUInt8(2, 0); // HELLO_ACK
      ack.writeUInt32BE(datagram.readUInt32BE(1), 1);
      dispatcher.socket.send(ack, rinfo.port, rinfo.address, () => {});
    });

    try {
      await startAnnounced(node);
      const sent = recordSends(node.socket);
      // The session the offer named, derived the way both ends derive it from the published punch id.
      const session = punchSession({ punch: 'feedfacefeedface', taskId: 'task-9', machineId: 'mac-executor' });
      const result = await node.dial('win-cgnat', {
        session,
        candidates: [{ address: '127.0.0.1', port: dispatcher.local.port }],
      });

      assert.equal(result.ok, true, result.error ?? '');
      assert.equal(result.session, session);
      assert.equal(result.peersAnnounced, 1, 'the published list is what was punched at');

      // The HELLO really left this socket, addressed at the published candidate, carrying the
      // published session -- not one this node invented.
      const hellosOut = framesOf(sent).filter((frame) => frame.kind === 1);
      assert.ok(hellosOut.length >= 1, 'a reverse dial must send HELLOs');
      assert.equal(hellosOut[0].session, session);
      assert.equal(hellosOut[0].to, dispatcher.local.port);
      assert.ok(hellos.length >= 1, 'and the far end must have received one');
      assert.equal(hellos[0].session, session);

      // The relay was never asked: an offer that carried its own candidate list is the whole point of
      // publishing one, and a lookup here would be a second, slower opinion about the same machine.
      assert.equal(
        relay.gets.some((entry) => entry.path.startsWith('/v1/peer/')),
        false,
        'no relay lookup for a candidate list the offer already carried',
      );
      assert.equal(node.status.punches_out, 1);
      assert.equal(node.status.dial_failures, 0);
    } finally {
      try {
        dispatcher.socket.close();
      } catch {
        /* already closed */
      }
      await node.close();
    }
  });

  it('refuses an unusable candidate an offer published, by name', async () => {
    const relay = fakeRelay();
    const node = makeNode('mac-executor', relay);
    try {
      await startAnnounced(node);
      // An offer is peer-supplied data that ends up as a datagram destination. The wildcard is the
      // case that matters: it is syntactically an address and means "nowhere to send".
      const result = await node.dial('win-cgnat', {
        session: 0x5eed0009,
        candidates: [{ address: '0.0.0.0', port: 1234 }],
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /^P2P_NO_CANDIDATES: /);
      assert.equal(result.peersAnnounced, 1, 'the announced count is what was offered, not what was usable');
      assert.equal(node.status.dial_failures, 1);
    } finally {
      await node.close();
    }
  });

  it('leaves one channel per session when both ends punch at the same time', async () => {
    // The case a two-way punch creates and a one-way one never did: both nodes dial with the SAME
    // session, so each side's accept loop claims it while its own punch is still in flight. Two live
    // channels on one session would each assemble and deliver every payload, and the peer would see
    // each message twice.
    const relay = fakeRelay();
    const a = makeNode('machine-a', relay);
    const b = makeNode('machine-b', relay);
    try {
      await startAnnounced(a);
      await startAnnounced(b);
      const session = deriveSession('simultaneous', 'machine-a', 'machine-b');

      const deliveries = [];
      b.on('message', (event) => deliveries.push(event.payload.toString('utf8')));
      const [fromA, fromB] = await Promise.all([
        a.dial('machine-b', { session }),
        b.dial('machine-a', { session }),
      ]);
      assert.equal(fromA.ok, true, `A -> B must open: ${fromA.error ?? ''}`);
      assert.equal(fromB.ok, true, `B -> A must open: ${fromB.error ?? ''}`);

      assert.equal(a.channels.size, 1, 'A must hold exactly one channel for the session');
      assert.equal(b.channels.size, 1, 'B must hold exactly one channel for the session');
      assert.equal(a.status.punches_in, 1);
      assert.equal(b.status.punches_in, 1);
      assert.equal(a.claimed.has(session), true);
      assert.equal(b.claimed.has(session), true);

      // One send, one delivery: a second channel would have delivered it twice.
      await fromA.channel.send('once');
      while (deliveries.length < 1) await nextEvent(b, 'message');
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(deliveries, ['once']);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('still answers a punch it never dialled for (the passive path, unchanged)', async () => {
    // The regression guard for the two-way work: a node that only ever accepts must behave exactly as
    // it did. The initiator here is a bare socket, so this node's accept loop is the only thing that
    // can open the channel.
    const relay = fakeRelay();
    const node = makeNode('machine-passive', relay);
    const dialler = await bindUdpSocket();
    try {
      await startAnnounced(node);
      const session = deriveSession('passive-regression');
      const inbound = nextEvent(node, 'message');

      const opened = await connect({
        socket: dialler.socket,
        remote: [{ address: '127.0.0.1', port: node.status.local.port }],
        timeoutMs: 3000,
        session,
      });
      assert.equal(opened.ok, true, opened.error ?? '');
      assert.equal(opened.channel.session, session);

      await opened.channel.send('hello from an unknown peer');
      const [received] = await inbound;
      assert.equal(received.payload.toString('utf8'), 'hello from an unknown peer');
      assert.equal(received.from, null, 'a HELLO carries a session, not an identity');
      assert.equal(received.session, session);
      assert.equal(node.status.punches_in, 1);
      assert.equal(node.status.punches_out, 0, 'accepting is not dialling');
      assert.equal(node.channels.size, 1);
      opened.channel.close();
    } finally {
      try {
        dialler.socket.close();
      } catch {
        /* already closed */
      }
      await node.close();
    }
  });

  it('names P2P_PUNCH_TIMEOUT when nobody answers', async () => {
    const relay = fakeRelay();
    // A port that was bound and released: the relay holds a live announcement for it, so
    // the node really does punch, and nothing is there to answer.
    const dead = await bindUdpSocket();
    const deadPort = dead.local.port;
    dead.socket.close();
    relay.peers.set('machine-ghost', {
      candidates: [{ address: '127.0.0.1', port: deadPort }],
      nat: { mapping: null },
    });

    const node = makeNode('machine-a', relay, { tuning: testTuning({ punchTimeoutMs: 300 }) });
    try {
      await startAnnounced(node);
      const startedAt = Date.now();
      const result = await node.dial('machine-ghost', { session: 0x0badf00d });
      const elapsed = Date.now() - startedAt;

      assert.equal(result.ok, false);
      assert.equal(result.channel, null);
      assert.match(result.error, /^P2P_PUNCH_TIMEOUT: /);
      assert.ok(result.attempts >= 1, 'the punch really was attempted');
      assert.equal(result.peersAnnounced, 1);
      assert.equal(result.rttMs, null);
      assert.equal(node.status.dial_failures, 1);
      assert.match(node.status.last_error, /^P2P_PUNCH_TIMEOUT/);
      // It waited for its deadline rather than failing for some other, faster reason.
      assert.ok(elapsed >= 250, `the punch must wait for its timeout, not fail instantly (${elapsed}ms)`);
    } finally {
      await node.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* accept()                                                                    */
/* -------------------------------------------------------------------------- */

describe('p2p: accept()', () => {
  it('answers a HELLO with its own session and returns a channel', async () => {
    const a = await bindUdpSocket();
    const b = await bindUdpSocket();
    try {
      const session = 0x5eed1234;
      const ack = nextEvent(a.socket, 'message');
      const waiting = accept({ socket: b.socket, timeoutMs: 2000 });
      a.socket.send(helloFrame(session), b.local.port, '127.0.0.1');

      const result = await waiting;
      assert.equal(result.ok, true, result.error ?? '');
      assert.ok(result.channel instanceof P2PChannel);
      assert.equal(result.session, session);
      assert.deepEqual(result.peer, { address: '127.0.0.1', port: a.local.port });
      assert.equal(result.error, null);
      // The responder never sent first, so there is no round trip to report. Reporting
      // the wait time here would be a fabricated measurement.
      assert.equal(result.rttMs, null);

      // And the acknowledgement is really on the wire, echoing the initiator's id.
      const [datagram] = await ack;
      assert.equal(datagram.readUInt8(0), 2, 'HELLO_ACK, per the framing table');
      assert.equal(datagram.readUInt32BE(1), session);
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it('re-acks a claimed session, keeps waiting, and returns no channel', async () => {
    const a = await bindUdpSocket();
    const b = await bindUdpSocket();
    try {
      const claimed = new Set([0x1111]);
      const ack = nextEvent(a.socket, 'message');
      const waiting = accept({ socket: b.socket, timeoutMs: 300, claimed });
      a.socket.send(helloFrame(0x1111), b.local.port, '127.0.0.1');

      const [datagram] = await ack;
      assert.equal(datagram.readUInt8(0), 2, 'a claimed session is still acknowledged');
      assert.equal(datagram.readUInt32BE(1), 0x1111);

      const result = await waiting;
      assert.equal(result.ok, false, 'a session with a live channel must not produce a second one');
      assert.equal(result.channel, null);
      assert.equal(result.peer, null);
      assert.match(result.error, /^P2P_ACCEPT_TIMEOUT/);
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it('honours a Map as the claimed set, and accepts a session that is not in it', async () => {
    // A Map is accepted because the agent already keeps session -> task; `has` is the
    // only method used, so neither container is privileged.
    const a = await bindUdpSocket();
    const b = await bindUdpSocket();
    try {
      const claimed = new Map([[0x2222, 'task-x']]);
      const waiting = accept({ socket: b.socket, timeoutMs: 2000, claimed });
      a.socket.send(helloFrame(0x3333), b.local.port, '127.0.0.1');
      const result = await waiting;
      assert.equal(result.ok, true, result.error ?? '');
      assert.equal(result.session, 0x3333);
      assert.equal(claimed.size, 1, 'accept() reads the claim set and never writes it');
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it('bounds re-acks of one session with intervalMs, so a HELLO spray is not echoed 1:1', async () => {
    const a = await bindUdpSocket();
    const b = await bindUdpSocket();
    const session = 0x4444;
    try {
      const acks = [];
      a.socket.on('message', (datagram) => acks.push(datagram));
      let waiting = accept({
        socket: b.socket,
        timeoutMs: 250,
        claimed: new Set([session]),
        intervalMs: 5000,
      });
      for (let i = 0; i < 5; i += 1) a.socket.send(helloFrame(session), b.local.port, '127.0.0.1');
      assert.equal((await waiting).ok, false);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(acks.length, 1, 'five HELLOs in one wait, one acknowledgement');

      // intervalMs: 0 removes the floor: the responder answers every HELLO again, which
      // is what a lost acknowledgement needs.
      acks.length = 0;
      waiting = accept({ socket: b.socket, timeoutMs: 250, claimed: new Set([session]), intervalMs: 0 });
      for (let i = 0; i < 3; i += 1) a.socket.send(helloFrame(session), b.local.port, '127.0.0.1');
      assert.equal((await waiting).ok, false);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(acks.length, 3);
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it('ends its wait when the socket goes away, instead of burning the timeout', async () => {
    const b = await bindUdpSocket();
    const waiting = accept({ socket: b.socket, timeoutMs: 5000 });
    const startedAt = Date.now();
    b.socket.close();
    const result = await waiting;
    assert.equal(result.ok, false);
    assert.match(result.error, /^P2P_SOCKET_CLOSED/);
    assert.ok(Date.now() - startedAt < 4000, 'the wait must end on the close, not on the timeout');
  });

  it('requires a socket', async () => {
    await assert.rejects(() => accept({}), TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle and status                                                        */
/* -------------------------------------------------------------------------- */

describe('p2p-node: lifecycle', () => {
  it('close() is idempotent, closes the socket, and start() works again afterwards', async () => {
    const relay = fakeRelay();
    const bind = countingBinder({ reportedAddress: '192.168.44.7' });
    const node = makeNode('machine-a', relay, { bindUdpSocket: bind.bindUdpSocket });

    await startAnnounced(node);
    assert.equal(bind.calls.length, 1);
    // Starting an already-started node is a no-op, not a second socket.
    assert.deepEqual(await node.start(), { ok: true, enabled: true, error: null });
    assert.equal(bind.calls.length, 1, 'start() is idempotent');
    // Two callers racing into start() share one bind rather than leaking a socket.
    const raced = await Promise.all([node.start(), node.start()]);
    assert.deepEqual(raced, [
      { ok: true, enabled: true, error: null },
      { ok: true, enabled: true, error: null },
    ]);
    assert.equal(bind.calls.length, 1, 'concurrent start() calls must not bind twice');

    const firstSocket = bind.sockets[0];
    await node.close();
    await node.close(); // idempotent: no throw, no double close
    assert.equal(node.status.running, false);
    assert.equal(node.status.local, null);
    assert.equal(node.status.candidates.length, 0);
    // The socket is genuinely closed, not just forgotten.
    let code = null;
    try {
      firstSocket.address();
    } catch (error) {
      code = error.code;
    }
    assert.equal(code, 'ERR_SOCKET_DGRAM_NOT_RUNNING');

    // While closed, the operations that need a socket refuse by name.
    assert.match((await node.announceNow()).error, /^P2P_NODE_NOT_RUNNING/);
    assert.match((await node.dial('machine-b')).error, /^P2P_NODE_NOT_RUNNING/);

    // Restartable by design: a node that reconnects binds a fresh socket on a fresh
    // ephemeral port rather than reusing a port whose NAT mapping is gone.
    await startAnnounced(node);
    assert.equal(bind.calls.length, 2, 'a restarted node binds again');
    assert.notEqual(bind.sockets[1], firstSocket);
    assert.equal(node.status.running, true);
    assert.ok(node.status.local.port > 0);
    assert.ok(node.status.candidates.length >= 1);
    assert.equal(relay.posts.length, 2);
    await node.close();
    assert.equal(node.status.running, false);
  });

  it('closes a socket whose bind lands after close(), instead of leaving it bound', async () => {
    // A `close()` during startup must not leave a port held by a node the caller believes
    // is stopped. The bind here is real and deliberately slow, so the race is the point.
    const relay = fakeRelay();
    const sockets = [];
    let release = null;
    let held = false;
    const bind = {
      bindUdpSocket: async () => {
        const bound = await bindUdpSocket();
        sockets.push(bound.socket);
        // Only the first bind is held open; the restart later in this case must complete.
        if (!held) {
          held = true;
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return bound;
      },
    };
    const node = makeNode('machine-a', relay, { bindUdpSocket: bind.bindUdpSocket });

    const starting = node.start();
    assert.equal(await waitFor(() => sockets.length === 1), true, 'the bind must be in flight');
    const closing = node.close();
    release();

    const started = await starting;
    await closing;
    assert.equal(started.ok, false);
    assert.match(started.error, /^P2P_START_CANCELLED/);
    assert.equal(node.status.running, false);
    assert.equal(node.status.local, null);
    let code = null;
    try {
      sockets[0].address();
    } catch (error) {
      code = error.code;
    }
    assert.equal(code, 'ERR_SOCKET_DGRAM_NOT_RUNNING', 'the late socket must have been closed');

    // And the node is still restartable afterwards.
    await startAnnounced(node);
    assert.equal(node.status.running, true);
    await node.close();
  });

  it('refuses to start without signalling, naming what is missing, and binds nothing', async () => {
    const bind = countingBinder();
    const noUrl = new P2PNode({
      machineId: 'machine-a',
      mode: 'auto',
      postJson: async () => ({ ok: true, status: 200, json: {}, error: null }),
      discover: loopbackDiscovery(),
      bindUdpSocket: bind.bindUdpSocket,
    });
    const noTransport = new P2PNode({
      machineId: 'machine-a',
      mode: 'direct',
      rabbitUrl: 'http://relay.test',
      discover: loopbackDiscovery(),
      bindUdpSocket: bind.bindUdpSocket,
    });

    const first = await noUrl.start();
    assert.deepEqual(first, {
      ok: false,
      enabled: true,
      error: 'P2P_NO_SIGNALLING: rabbitUrl is missing, so mode "auto" could never announce its candidates',
    });
    const second = await noTransport.start();
    assert.match(second.error, /^P2P_NO_SIGNALLING: postJson is missing/);
    assert.equal(bind.calls.length, 0, 'a node that cannot announce must not hold a port');
    assert.equal(noUrl.status.running, false);
    assert.equal(noUrl.status.last_error, first.error);

    await noUrl.close();
    await noTransport.close();
  });

  it('has a status object that matches the contract key for key', async () => {
    const relay = fakeRelay();
    const bind = countingBinder({ reportedAddress: '192.168.44.7' });
    const node = makeNode('machine-status', relay, { bindUdpSocket: bind.bindUdpSocket });
    await startAnnounced(node);

    const status = node.status;
    assert.deepEqual(Object.keys(status).sort(), [
      'announce_failures',
      'announce_ok',
      'announced_at',
      'candidates',
      'dial_failures',
      'enabled',
      'last_announce_error',
      'last_error',
      'local',
      'machine_id',
      'mapping',
      'mode',
      'punches_in',
      'punches_out',
      'rabbit_url',
      'reflexive',
      'running',
    ]);
    // Plain objects, no class instances: the whole thing has to survive JSON.
    assert.equal(Object.getPrototypeOf(status), Object.prototype);
    assert.equal(Object.getPrototypeOf(status.local), Object.prototype);
    assert.equal(Object.getPrototypeOf(status.candidates[0]), Object.prototype);
    assert.deepEqual(Object.keys(status.local).sort(), ['address', 'port']);
    assert.deepEqual(Object.keys(status.candidates[0]).sort(), ['address', 'port']);
    assert.deepEqual(Object.keys(status.reflexive).sort(), ['address', 'port']);
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status);

    // A read hands out copies: a caller cannot damage the node's state by editing it.
    const before = status.candidates.length;
    assert.ok(before >= 1, 'a running node has announced something');
    status.candidates.push({ address: '203.0.113.1', port: 1 });
    status.local.port = 1;
    assert.equal(node.status.candidates.length, before);
    assert.notEqual(node.status.local.port, 1);

    assert.equal(status.mode, 'auto');
    assert.equal(status.enabled, true);
    assert.equal(status.running, true);
    assert.equal(status.machine_id, 'machine-status');
    assert.equal(status.rabbit_url, 'http://relay.test');
    assert.equal(typeof status.announced_at, 'string');
    assert.equal(Number.isNaN(Date.parse(status.announced_at)), false);
    for (const key of ['announce_failures', 'punches_out', 'punches_in', 'dial_failures']) {
      assert.equal(typeof status[key], 'number', `${key} must be a number`);
    }
    assert.equal(status.mapping, 'none');
    await node.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Honest limit                                                                */
/* -------------------------------------------------------------------------- */

describe('p2p-node: loopback is not a NAT traversal test', () => {
  it('documents why the punches above cannot prove traversal', () => {
    // Two nodes on one host share a loopback path with no translator between them, so a
    // successful punch here says nothing about a real NAT — see the same note in
    // test/p2p-transport.test.mjs and the v0.3.9 section of CHANGELOG.md for what is
    // measured and what is explicitly not.
    assert.equal(SHARED_SERVER.stun.endsWith(':3478'), true);
    assert.equal(P2P_DEFAULTS.maxCandidates >= 1, true);
  });
});
