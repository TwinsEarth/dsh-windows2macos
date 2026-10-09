/**
 * P2P transport suite (v0.3.9): hole punching and the reliable channel.
 *
 * Everything here runs on real UDP sockets between two real processes' worth of
 * state on one host. That proves the protocol -- framing, fragmentation,
 * acknowledgement, retransmission, timeout reporting -- but it does **not** prove
 * traversal of a real NAT, and the file says so where it matters. Traversal needs
 * two hosts behind two different NATs; a punch across loopback has no NAT to cross.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import {
  DEFAULT_MAX_ATTEMPTS,
  KIND,
  MAX_FRAGMENT_PAYLOAD,
  MAX_MESSAGE_BYTES,
  P2PChannel,
  P2P_VERSION,
  connect,
  deriveSession,
  punch,
} from '../src/agent/p2p.mjs';
import { bindUdpSocket } from '../src/agent/stun.mjs';

/** Two bound sockets, closed together. */
async function twoSockets() {
  const a = await bindUdpSocket();
  const b = await bindUdpSocket();
  return { a, b, close: () => { try { a.socket.close(); } catch { /* closed */ } try { b.socket.close(); } catch { /* closed */ } } };
}

/** Address of a bound socket as a peer would dial it (loopback, not 0.0.0.0). */
const loopback = (entry) => ({ address: '127.0.0.1', port: entry.local.port });

describe('p2p: constants', () => {
  it('keeps a fragment inside a conservative MTU', () => {
    // Header is 5 bytes (kind + session) plus 12 bytes of DATA fields.
    assert.ok(MAX_FRAGMENT_PAYLOAD + 5 + 12 <= 1200, 'a frame must fit a 1280-byte IPv6 MTU path');
  });

  it('has a distinct frame kind for PONG', () => {
    // Regression: PING answering with PING makes two peers bounce datagrams forever,
    // and the loop looks exactly like healthy keep-alive traffic.
    assert.notEqual(KIND.PING, KIND.PONG);
    assert.equal(typeof P2P_VERSION, 'number');
  });
});

describe('p2p: session agreement', () => {
  it('derives the same id from the same shared inputs, and different ids otherwise', () => {
    // Both peers compute this independently from data they already share, so the punch
    // needs no extra round trip. Order-independence matters: the two sides must agree
    // without agreeing on who goes first.
    const a = deriveSession('task-01', 'mac-aaa', 'win-bbb');
    const b = deriveSession('task-01', 'mac-aaa', 'win-bbb');
    assert.equal(a, b);
    assert.notEqual(a, deriveSession('task-02', 'mac-aaa', 'win-bbb'));
    assert.notEqual(a, deriveSession('task-01', 'mac-aaa', 'win-ccc'));
    assert.notEqual(a, 0, 'a zero session id would collide with "unset"');
  });

  it('refuses to punch without a session unless adoption is explicit', async () => {
    // Two peers each inventing an id is the silent failure this guards: both send,
    // both discard the other's HELLO, and the punch times out looking like a NAT fault.
    const { a, close } = await twoSockets();
    try {
      await assert.rejects(
        () => punch({ socket: a.socket, remote: [{ address: '127.0.0.1', port: 9 }], timeoutMs: 100 }),
        /session.*required|allowSessionAdoption/,
      );
    } finally {
      close();
    }
  });
});

describe('p2p: punching', () => {
  it('opens a path when both sides punch at the same time', async () => {
    const { a, b, close } = await twoSockets();
    try {
      const session = deriveSession('punch-test', a.local.port, b.local.port);
      const [ra, rb] = await Promise.all([
        punch({ socket: a.socket, remote: [loopback(b)], timeoutMs: 4000, session }),
        punch({ socket: b.socket, remote: [loopback(a)], timeoutMs: 4000, session }),
      ]);
      assert.equal(ra.ok, true, ra.error ?? '');
      assert.equal(rb.ok, true, rb.error ?? '');
      assert.equal(ra.peer.port, b.local.port);
      assert.equal(rb.peer.port, a.local.port);
      assert.equal(ra.session, session);
      assert.equal(rb.session, session);
      assert.ok(ra.attempts >= 1);
    } finally {
      close();
    }
  });

  it('adopts the initiator\'s session when the responder has none of its own', async () => {
    // This is what makes the star topology usable for signalling: the responder does
    // not need to be told anything in advance. It answers a HELLO it never expected,
    // echoing the initiator's id so the initiator accepts the answer.
    const { a, b, close } = await twoSockets();
    try {
      const session = deriveSession('passive-test', 1);
      const passive = punch({
        socket: b.socket,
        remote: [{ address: '127.0.0.1', port: 9 }],
        timeoutMs: 3000,
        allowSessionAdoption: true,
      });
      const active = punch({ socket: a.socket, remote: [loopback(b)], timeoutMs: 3000, session });
      const [ra, rb] = await Promise.all([active, passive]);
      assert.equal(ra.ok, true, ra.error ?? '');
      assert.equal(rb.ok, true, rb.error ?? '');
      assert.equal(rb.peer.port, a.local.port);
      // Both sides must end up on the same id, or the channel that follows would
      // discard every frame.
      assert.equal(rb.session, session);
      assert.equal(ra.session, rb.session);
    } finally {
      close();
    }
  });

  it('reports a timeout with the candidate count instead of hanging', async () => {
    const { a, close } = await twoSockets();
    try {
      const started = Date.now();
      const result = await punch({
        socket: a.socket,
        remote: [{ address: '127.0.0.1', port: 9 }],
        timeoutMs: 600,
        session: 0x0badf00d,
      });
      assert.equal(result.ok, false);
      assert.equal(result.peer, null);
      assert.match(result.error, /P2P_PUNCH_TIMEOUT/);
      assert.ok(result.attempts >= 1);
      assert.ok(Date.now() - started >= 500);
    } finally {
      close();
    }
  });

  it('refuses an empty candidate list by name', async () => {
    const { a, close } = await twoSockets();
    try {
      const result = await punch({ socket: a.socket, remote: [], session: 0x1234 });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'P2P_NO_CANDIDATES');
    } finally {
      close();
    }
  });

  it('ignores a HELLO carrying a different session id', async () => {
    // A stray datagram from an earlier punch must not be mistaken for this one.
    const { a, b, close } = await twoSockets();
    try {
      const foreign = Buffer.alloc(5);
      foreign.writeUInt8(KIND.HELLO, 0);
      foreign.writeUInt32BE(0xdeadbeef, 1);
      b.socket.send(foreign, a.local.port, '127.0.0.1');

      const result = await punch({
        socket: a.socket,
        remote: [{ address: '127.0.0.1', port: 9 }],
        session: 0x12345678,
        timeoutMs: 500,
      });
      assert.equal(result.ok, false, 'a foreign session must not open the path');
    } finally {
      close();
    }
  });
});

describe('p2p: reliable channel', () => {
  /** Punch two sockets together and hand back a connected channel on each side. */
  async function connectedPair(tuning) {
    const { a, b, close } = await twoSockets();
    const results = await Promise.all([
      punch({ socket: a.socket, remote: [loopback(b)], timeoutMs: 4000, session: 0x5eed0001 }),
      punch({ socket: b.socket, remote: [loopback(a)], timeoutMs: 4000, session: 0x5eed0001 }),
    ]);
    assert.equal(results[0].ok && results[1].ok, true, 'punch must succeed before the channel is exercised');
    const ca = new P2PChannel({ socket: a.socket, peer: results[0].peer, session: results[0].session, tuning });
    const cb = new P2PChannel({ socket: b.socket, peer: results[1].peer, session: results[1].session, tuning });
    return { ca, cb, close: () => { ca.close(); cb.close(); close(); } };
  }

  it('delivers a single small message intact', async () => {
    const { ca, cb, close } = await connectedPair();
    try {
      const received = new Promise((resolve) => cb.once('message', resolve));
      await ca.send('hello from the far side');
      assert.equal((await received).toString('utf8'), 'hello from the far side');
    } finally {
      close();
    }
  });

  it('fragments, reassembles and integrity-checks a payload far larger than one datagram', async () => {
    const { ca, cb, close } = await connectedPair();
    try {
      // 256 KiB: ~227 fragments, which exercises windowing and selective ACK.
      const payload = Buffer.alloc(256 * 1024);
      for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31 + 7) & 0xff;

      const received = new Promise((resolve) => cb.once('message', resolve));
      await ca.send(payload);
      const got = await received;
      assert.equal(got.length, payload.length);
      assert.ok(got.equals(payload), 'reassembled bytes must match exactly');
    } finally {
      close();
    }
  });

  it('delivers several messages in send order when sent one at a time', async () => {
    const { ca, cb, close } = await connectedPair();
    try {
      const seen = [];
      cb.on('message', (m) => seen.push(m.toString('utf8')));
      for (const text of ['one', 'two', 'three']) await ca.send(text);
      // The last send resolved only after its ACK; give the final delivery a tick.
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(seen, ['one', 'two', 'three']);
    } finally {
      close();
    }
  });

  it('survives a lost datagram by retransmitting the missing fragment', async () => {
    // Deterministic loss injection: drop the first DATA fragment of the first message
    // on its way out, and assert the message still arrives.
    const { a, b, close } = await twoSockets();
    const results = await Promise.all([
      punch({ socket: a.socket, remote: [loopback(b)], timeoutMs: 4000, session: 0x5eed0002 }),
      punch({ socket: b.socket, remote: [loopback(a)], timeoutMs: 4000, session: 0x5eed0002 }),
    ]);
    assert.equal(results[0].ok && results[1].ok, true);

    const originalSend = a.socket.send.bind(a.socket);
    let dropped = 0;
    a.socket.send = (msg, ...rest) => {
      const kind = Buffer.isBuffer(msg) && msg.length >= 5 ? msg.readUInt8(0) : -1;
      if (kind === KIND.DATA && dropped === 0) {
        dropped += 1;
        const cb = rest[rest.length - 1];
        if (typeof cb === 'function') cb(null);
        return;
      }
      return originalSend(msg, ...rest);
    };

    const ca = new P2PChannel({ socket: a.socket, peer: results[0].peer, session: results[0].session, tuning: { rtoMs: 80 } });
    const cb = new P2PChannel({ socket: b.socket, peer: results[1].peer, session: results[1].session, tuning: { rtoMs: 80 } });
    try {
      const received = new Promise((resolve) => cb.once('message', resolve));
      await ca.send('this fragment was dropped once and must come back');
      assert.equal((await received).toString('utf8'), 'this fragment was dropped once and must come back');
      assert.equal(dropped, 1, 'the injection must actually have dropped something');
    } finally {
      a.socket.send = originalSend;
      ca.close();
      cb.close();
      close();
    }
  });

  it('rejects a message larger than the ceiling instead of allocating it', async () => {
    const { ca, cb, close } = await connectedPair();
    try {
      await assert.rejects(
        () => ca.send(Buffer.alloc(MAX_MESSAGE_BYTES + 1)),
        /P2P_MESSAGE_TOO_LARGE/,
      );
    } finally {
      close();
    }
  });

  it('gives up on an unreachable peer with the fragment named, rather than retrying forever', async () => {
    const { a, close } = await twoSockets();
    // Peer address points at a socket that exists but never answers ACKs.
    const silent = await bindUdpSocket();
    const channel = new P2PChannel({
      socket: a.socket,
      peer: { address: '127.0.0.1', port: silent.local.port },
      session: 0xaabbccdd,
      tuning: { rtoMs: 40, maxAttempts: 3 },
    });
    try {
      await assert.rejects(() => channel.send('nobody will acknowledge this'), /P2P_FRAGMENT_UNACKED/);
    } finally {
      channel.close();
      silent.socket.close();
      close();
    }
  });

  it('rejects in-flight sends when the channel closes', async () => {
    const { ca, cb, close } = await connectedPair({ rtoMs: 5000, maxAttempts: 50 });
    try {
      const pending = ca.send(Buffer.alloc(64 * 1024, 7));
      ca.close('test-close');
      await assert.rejects(() => pending, /P2P_CHANNEL_CLOSED/);
    } finally {
      close();
    }
  });

  it('stops delivering after close', async () => {
    const { ca, cb, close } = await connectedPair();
    try {
      let count = 0;
      cb.on('message', () => { count += 1; });
      await ca.send('before');
      ca.close();
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(count, 1);
    } finally {
      close();
    }
  });

  it('ignores a DATA frame with an impossible fragment index', async () => {
    const { ca, cb, close } = await connectedPair();
    try {
      let delivered = 0;
      cb.on('message', () => { delivered += 1; });
      // index 5 of total 3 is out of range and must be discarded, not allocated.
      const body = Buffer.alloc(12 + 4);
      body.writeUInt32BE(99, 0);
      body.writeUInt32BE(5, 4);
      body.writeUInt32BE(3, 8);
      const datagram = Buffer.alloc(5 + body.length);
      datagram.writeUInt8(KIND.DATA, 0);
      datagram.writeUInt32BE(ca.session, 1);
      body.copy(datagram, 5);
      ca.socket.send(datagram, ca.peer.port, ca.peer.address);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(delivered, 0);
    } finally {
      close();
    }
  });
});

describe('p2p: connect()', () => {
  it('returns a usable channel on success', async () => {
    const { a, b, close } = await twoSockets();
    try {
      const [ra, rb] = await Promise.all([
        connect({ socket: a.socket, remote: [loopback(b)], timeoutMs: 4000, session: 0x5eed0003 }),
        connect({ socket: b.socket, remote: [loopback(a)], timeoutMs: 4000, session: 0x5eed0003 }),
      ]);
      assert.equal(ra.ok, true, ra.error ?? '');
      assert.equal(rb.ok, true, rb.error ?? '');
      const received = new Promise((resolve) => rb.channel.once('message', resolve));
      await ra.channel.send('over the punched path');
      assert.equal((await received).toString('utf8'), 'over the punched path');
      ra.channel.close();
      rb.channel.close();
    } finally {
      close();
    }
  });

  it('returns ok:false and no channel when the punch fails', async () => {
    const { a, close } = await twoSockets();
    try {
      const result = await connect({
        socket: a.socket,
        remote: [{ address: '127.0.0.1', port: 9 }],
        timeoutMs: 400,
        session: deriveSession('unreachable-connect'),
      });
      assert.equal(result.ok, false);
      assert.equal(result.channel, null);
      assert.match(result.error, /P2P_PUNCH_TIMEOUT/);
    } finally {
      close();
    }
  });
});

describe('p2p: loopback is not a NAT traversal test', () => {
  it('documents why the punch cases above cannot prove traversal', () => {
    // Stated as an executable note so nobody reads the suite above as NAT evidence:
    // two sockets on one host share a loopback path with no translator between them,
    // so "the punch succeeded" says nothing about a real NAT. A traversal test needs
    // two hosts behind two different NATs and an external STUN server -- see
    // run/TAILNET-RUNBOOK.md and the v0.3.9 section of CHANGELOG.md for what is
    // measured and what is explicitly not.
    const loopbackHasNoTranslator = true;
    assert.equal(loopbackHasNoTranslator, true);
    assert.equal(DEFAULT_MAX_ATTEMPTS > 0, true);
    assert.equal(typeof dgram.createSocket, 'function');
  });
});
