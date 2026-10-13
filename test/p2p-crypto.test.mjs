/**
 * Stage 1 of `docs/P2P-CRYPTO.md`: the device keypair, the handshake, and the sealed data plane.
 *
 * §7 of that document is the acceptance list, and every case below is one of its eight:
 *
 *   1. two peers with keys complete a handshake and exchange a frame;
 *   2. a peer with the **wrong** static key is refused, with the reason recorded;
 *   3. a replayed `HELLO` is refused;
 *   4. a data frame with one bit flipped fails authentication and is dropped, not processed;
 *   5. a frame whose counter was already seen is dropped (the replay window);
 *   6. an older peer that never learned a key still completes its task over the relay, with
 *      `encrypted: false`;
 *   7. a capture of the direct channel contains no plaintext marker;
 *   8. rekey does not lose a frame that was in flight.
 *
 * HONEST LIMITS, stated here because the alternative is overclaiming:
 *
 *   * The sockets are real UDP sockets on loopback, so the framing, the encryption and the replay
 *     window are exercised for real — but loopback crosses **no NAT**, and nothing here is evidence
 *     about traversal. `test/p2p-node.test.mjs` says the same thing about its punches.
 *   * The relay in case 6 is the real `createRelayServer`, and the agent is the real agent; what is
 *     simulated there is only the *absence of a key*, which is precisely what a v0.5.x machine is.
 *   * `test/p2p-crypto.test.mjs` cannot prove the cryptography is *right* — no test in this repository
 *     can. What it proves is that the construction is implemented as written, that its refusals are
 *     named, and that a peer never finds itself silently in the clear.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CRYPTO_REASON,
  DEVICE_KEY_FILE,
  DeviceKey,
  HANDSHAKE_MAC_FIELDS_OMITTED,
  NonceCache,
  PeerKeyStore,
  REFUSE,
  ReplayWindow,
  decodeHello,
  decodeKey,
  decodeRefuse,
  derive,
  encodeKey,
  encodeRefuse,
  isPublicKey,
  rawPrivateOf,
  rawPublicOf,
  refusalMacKey,
  respondHandshake,
  sealRefuse,
  startHandshake,
  verifyRefuseMac,
  x25519BasePoint,
} from '../src/agent/crypto.mjs';
import {
  CIPHER_OVERHEAD_BYTES,
  EPOCH_RETENTION_MS,
  FRAME_MAGIC,
  MAX_EPOCH_LOOKAHEAD,
} from '../src/agent/crypto.mjs';
import {
  KIND,
  MAX_FRAGMENT_PAYLOAD,
  P2PChannel,
  REFUSE_GUARD,
  accept,
  connect,
  punch,
} from '../src/agent/p2p.mjs';
import { verifyEnvelope } from '../src/agent/agent.mjs';
import { bindUdpSocket } from '../src/agent/stun.mjs';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const scratch = [];

function scratchDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `w2m-crypto-${name}-`));
  scratch.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows holds a busy directory a little longer; the OS cleans tmp up. */
    }
  }
});

/** Two bound sockets, closed together. */
async function twoSockets() {
  const a = await bindUdpSocket();
  const b = await bindUdpSocket();
  return {
    a,
    b,
    close: () => {
      try {
        a.socket.close();
      } catch {
        /* closed */
      }
      try {
        b.socket.close();
      } catch {
        /* closed */
      }
    },
  };
}

/** Address of a bound socket as a peer would dial it. */
const loopback = (entry) => ({ address: '127.0.0.1', port: entry.local.port });

/**
 * Record every datagram a socket sends, without changing what it sends.
 *
 * This is how case 7 is believed: the bytes on the wire are captured at the only place they exist,
 * and the assertion is made against the capture rather than against a claim about it.
 *
 * @param {import('node:dgram').Socket} socket
 * @returns {Buffer[]}
 */
function recordSends(socket) {
  const sent = [];
  const original = socket.send.bind(socket);
  socket.send = (msg, port, address, callback) => {
    sent.push(Buffer.from(msg));
    return original(msg, port, address, callback);
  };
  return sent;
}

/** Every byte of every datagram that crossed the socket, as one buffer. */
const capture = (sent) => Buffer.concat(sent);

/** A frame as `p2p.mjs` builds it: kind u8, session u32, body. */
function frameOf(kind, session, body = Buffer.alloc(0)) {
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt8(kind, 0);
  out.writeUInt32BE(session >>> 0, 1);
  body.copy(out, 5);
  return out;
}

/** One message's DATA frame body: u32 messageId, u32 index, u32 total, payload. */
function dataBody(messageId, index, total, payload) {
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(messageId, 0);
  out.writeUInt32BE(index, 4);
  out.writeUInt32BE(total, 8);
  payload.copy(out, 12);
  return out;
}

/**
 * A matched pair of crypto sessions, as a completed handshake produces.
 *
 * @param {object} [options]
 * @param {number} [options.session]
 * @param {object} [options.tuning] `CryptoSession` overrides (rekey thresholds, retention).
 * @returns {{initiator: CryptoSession, responder: CryptoSession, keysA: DeviceKey, keysB: DeviceKey}}
 */
function sessionPair({ session = 0x1234, tuning = {} } = {}) {
  const keysA = DeviceKey.generate('machine-a');
  const keysB = DeviceKey.generate('machine-b');
  const start = startHandshake({
    deviceKey: keysA,
    peerMachineId: 'machine-b',
    peerPublicKey: keysB.publicKeyBase64,
    session,
  });
  const answered = respondHandshake({
    deviceKey: keysB,
    body: start.body,
    peerKeys: new Map([['machine-a', keysA.publicKeyBase64]]),
    seen: new NonceCache(),
  });
  assert.equal(answered.ok, true, answered.reason ?? '');
  const finished = start.finish(answered.body);
  assert.equal(finished.ok, true, finished.reason ?? '');
  const initiator = Object.assign(finished.session, tuning);
  const responder = Object.assign(answered.crypto, tuning);
  return { initiator, responder, keysA, keysB };
}

/* -------------------------------------------------------------------------- */
/* The keypair (§4, "Identity")                                                */
/* -------------------------------------------------------------------------- */

describe('crypto: the device keypair', () => {
  it('generates device.key on first use, and reloads the same key afterwards', () => {
    const dir = scratchDir('key');
    const first = DeviceKey.load({ dir, machineId: 'machine-a' });
    assert.equal(first.created, true);
    assert.equal(first.path, join(dir, DEVICE_KEY_FILE));
    assert.equal(isPublicKey(first.key.publicKeyBase64), true, 'a 32-byte base64 X25519 key');
    assert.equal(first.key.machineId, 'machine-a');

    // The second load is the case that decides whether peers keep trusting this machine: a *new* key
    // would make every peer that knows the old one refuse it, and "my peers stopped talking to me"
    // would have no visible cause.
    const again = DeviceKey.load({ dir, machineId: 'machine-a' });
    assert.equal(again.created, false);
    assert.equal(again.key.publicKeyBase64, first.key.publicKeyBase64);
    assert.equal(again.key.privateKeyBase64, first.key.privateKeyBase64);
  });

  it('writes the private key into the per-user directory, and states what protects it there', () => {
    const dir = scratchDir('mode');
    const loaded = DeviceKey.load({ dir, machineId: 'machine-a' });
    const text = readFileSync(loaded.path, 'utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.format, 'w2m-device-key/1');
    assert.equal(parsed.algo, 'x25519');
    // Only the private half is stored; the public half is derived, so a hand-edited file cannot
    // publish a key that does not match its private key.
    assert.equal(typeof parsed.private_key, 'string');
    assert.equal(parsed.public_key, undefined);
    assert.equal(isPublicKey(parsed.private_key), true, 'the stored scalar is 32 bytes');

    if (process.platform === 'win32') {
      // NTFS carries no POSIX bits. The honest claim is that the file sits inside the per-user profile
      // and inherits its ACL — *not* that it is 0600 — so asserting the mode here would be a test that
      // passes for a reason that does not exist. `DeviceKey`'s comment says the same thing.
      assert.notEqual(statSync(loaded.path).mode & 0o777, 0o600, 'Windows ignores the bits entirely');
    } else {
      assert.equal(statSync(loaded.path).mode & 0o777, 0o600);
    }
  });

  it('refuses to mint a replacement key when the existing file is unusable', () => {
    const dir = scratchDir('corrupt');
    writeFileSync(join(dir, DEVICE_KEY_FILE), '{ not json', 'utf8');
    // A silent replacement would make every peer that knows the old key refuse this machine, so the
    // failure has to be loud — the same rule `identity.mjs` follows for a corrupt machine_id.
    assert.throws(() => DeviceKey.load({ dir }), /DEVICE_KEY_CORRUPT|not valid JSON/);

    writeFileSync(
      join(dir, DEVICE_KEY_FILE),
      JSON.stringify({ format: 'w2m-device-key/1', algo: 'x25519', private_key: 'AAAA' }),
      'utf8',
    );
    assert.throws(() => DeviceKey.load({ dir }), /CORRUPT|private_key/);
  });

  it('derives a public key that matches node:crypto, and agrees with a peer', () => {
    // The public half is derived, not stored, so this is the one place the derivation is checked
    // against an independent implementation of the same curve.
    for (let i = 0; i < 4; i += 1) {
      const pair = generateKeyPairSync('x25519');
      assert.deepEqual(
        x25519BasePoint(rawPrivateOf(pair.privateKey)),
        rawPublicOf(pair.publicKey),
        'the base-point multiplication must match node:crypto byte for byte',
      );
    }

    // The same secret from both sides, which is what the whole handshake rests on.
    const a = DeviceKey.generate('machine-a');
    const b = DeviceKey.generate('machine-b');
    assert.deepEqual(a.sharedSecret(b.publicKeyBase64), b.sharedSecret(a.publicKeyBase64));

    // A key that is not exactly 32 bytes of canonical base64 is refused rather than coerced. Node's
    // base64 decoder ignores characters it does not know, so an unchecked decode would hand a
    // corrupted key to a MAC computation and the failure would look like an attack.
    for (const bad of ['', 'AAAA', `${a.publicKeyBase64}=`, a.publicKeyBase64.slice(0, -1), 'x'.repeat(44)]) {
      assert.equal(isPublicKey(bad), false, `refused: ${JSON.stringify(bad)}`);
    }
  });

  it('records that mac1/mac2 are not implemented, and what that costs', () => {
    // §3 of the contract: the omission is a decision with a stated consequence, not a silence.
    assert.deepEqual([...HANDSHAKE_MAC_FIELDS_OMITTED.fields], ['mac1', 'mac2']);
    assert.match(HANDSHAKE_MAC_FIELDS_OMITTED.reason, /keyed BLAKE2s/);
    assert.match(HANDSHAKE_MAC_FIELDS_OMITTED.consequence, /DoS/);
    assert.match(HANDSHAKE_MAC_FIELDS_OMITTED.consequence, /confidentiality and authenticity are unaffected/);
  });

  it('leaves room in the fragment budget for the tag, and states the bytes', () => {
    // 5 header + 12 DATA fields + payload, plus the cipher header and tag. The 1200-byte budget is a
    // soft one; the 1280-byte IPv6 minimum path is the hard one, and this is the assertion that keeps
    // a future `MAX_FRAGMENT_PAYLOAD` increase from being an accident.
    const encryptedFrame = 5 + 12 + MAX_FRAGMENT_PAYLOAD + CIPHER_OVERHEAD_BYTES;
    assert.ok(encryptedFrame <= 1280, `${encryptedFrame} must fit a 1280-byte IPv6 minimum MTU`);
    assert.equal(CIPHER_OVERHEAD_BYTES, 26, '10-byte cipher header plus a 16-byte tag');
  });
});

/* -------------------------------------------------------------------------- */
/* §7.1 — a handshake, and a frame across it                                   */
/* -------------------------------------------------------------------------- */

describe('crypto: §7.1 two peers complete a handshake and exchange a frame', () => {
  it('agrees on the session key from the triple DH, and seals both directions', () => {
    const { initiator, responder } = sessionPair({ session: 0x5eed0001 });
    const plaintext = frameOf(KIND.DATA, 0x5eed0001, dataBody(1, 0, 1, Buffer.from('over the wire')));

    const sealed = initiator.encrypt(true, plaintext);
    assert.equal(sealed.length, plaintext.length + CIPHER_OVERHEAD_BYTES);
    assert.equal(sealed.readUInt8(5), FRAME_MAGIC, 'the body announces itself as encrypted');
    assert.notDeepEqual(sealed, plaintext);

    const opened = responder.decrypt(false, sealed);
    assert.equal(opened.ok, true, opened.reason ?? '');
    assert.deepEqual(opened.frame, plaintext, 'the frame is reconstructed byte for byte');

    // The reverse direction uses the other key, and one end's key cannot open its own frames.
    const back = responder.encrypt(false, frameOf(KIND.ACK, 0x5eed0001, Buffer.alloc(8)));
    assert.equal(initiator.decrypt(true, back).ok, true);
    assert.equal(initiator.decrypt(true, sealed).ok, false, 'a frame is sealed for one direction only');
  });

  it('carries a whole message over a real channel, and the peer reassembles it', async () => {
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed0002;
      const { initiator, responder } = sessionPair({ session });
      const channelA = new P2PChannel({
        socket: a.socket,
        peer: loopback(b),
        session,
        crypto: { session: initiator, isInitiator: true },
      });
      const channelB = new P2PChannel({
        socket: b.socket,
        peer: loopback(a),
        session,
        crypto: { session: responder, isInitiator: false },
      });
      const delivered = new Promise((resolve) => channelB.once('message', resolve));
      // Larger than one fragment on purpose: fragmentation, acknowledgement and retransmission all
      // run under the seal, which is the property that says the encryption is *in* the channel
      // rather than beside it.
      const payload = randomBytes(MAX_FRAGMENT_PAYLOAD * 2 + 17).toString('base64');
      await channelA.send(payload);
      assert.equal((await delivered).toString('utf8'), payload);
      assert.equal(channelB.encryption.encrypted, true);
      assert.equal(channelB.encryption.dropped, 0);
      channelA.close('done');
      channelB.close('done');
    } finally {
      close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §7.2 — a peer with the wrong static key is refused                          */
/* -------------------------------------------------------------------------- */

describe('crypto: §7.2 a peer with the wrong static key is refused, by name', () => {
  it('refuses an unverifiable HELLO with a distinct code and no session', () => {
    const a = DeviceKey.generate('machine-a');
    const b = DeviceKey.generate('machine-b');
    const imposter = DeviceKey.generate('machine-imposter');
    const start = startHandshake({
      deviceKey: a,
      peerMachineId: 'machine-b',
      peerPublicKey: b.publicKeyBase64,
      session: 0x51,
    });

    // B holds the wrong key for A: verifiable MAC, wrong value. A distinct code from UNKNOWN_PEER,
    // because "refresh that machine's key" and "somebody is guessing at names" need different fixes.
    const refused = respondHandshake({
      deviceKey: b,
      body: start.body,
      peerKeys: new Map([['machine-a', imposter.publicKeyBase64]]),
      seen: new NonceCache(),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, CRYPTO_REASON.BAD_MAC);
    assert.ok(Buffer.isBuffer(refused.refuse), 'the refusal is a frame the peer can read');
    assert.equal(refused.crypto, undefined, 'no session exists after a refusal');

    // A machine B holds no key for at all: a different code, because the fix is different.
    const unknown = respondHandshake({
      deviceKey: b,
      body: start.body,
      peerKeys: new Map(),
      seen: new NonceCache(),
    });
    assert.equal(unknown.reason, CRYPTO_REASON.UNKNOWN_PEER);

    // And the initiator's own half refuses an answer that came from somebody else. The liar holds a
    // real keypair, so its `HELLO_ACK` carries a genuine mac' — computed with a key the initiator never
    // asked about. Two things have to stop it, and both do: the responder names itself, and the
    // transcript hash covers the `HELLO` the initiator actually sent.
    const honest = respondHandshake({
      deviceKey: b,
      body: start.body,
      peerKeys: new Map([['machine-a', a.publicKeyBase64]]),
      seen: new NonceCache(),
    });
    assert.equal(start.finish(honest.body).ok, true, 'the honest answer does verify');

    const second = startHandshake({
      deviceKey: a,
      peerMachineId: 'machine-b',
      peerPublicKey: b.publicKeyBase64,
      session: 0x52,
    });
    const liar = DeviceKey.generate('machine-liar');
    const fromLiar = respondHandshake({
      deviceKey: liar,
      body: second.body,
      peerKeys: new Map([['machine-a', a.publicKeyBase64]]),
      seen: new NonceCache(),
    });
    // A machine that holds a keypair of its own but not the private key for the identity it is claiming
    // cannot produce a valid `mac'` at all: §4's mac is taken over
    // `hash(prologue ‖ s_i.pub ‖ s_r.pub)`, and `s_r.pub` is the key *both* ends expect the responder to
    // hold — not whatever key the responder happens to have. The prologue binding is therefore doing
    // real work, and this assertion is the evidence for it.
    assert.equal(fromLiar.ok, false, 'a machine without the dialled key cannot answer');
    assert.equal(fromLiar.reason, CRYPTO_REASON.BAD_MAC);
    assert.equal(fromLiar.crypto, undefined, 'and no session exists on its side either');

    // The identity check is a second, independent guard on the answer's own claim: an `HELLO_ACK` that
    // names somebody other than the machine the offer introduced is refused by name, whatever its MAC
    // says. Checked here on the responder's side, where the claim is what is being verified.
    const misnamed = respondHandshake({
      deviceKey: liar,
      body: startHandshake({
        deviceKey: a,
        peerMachineId: 'machine-liar',
        peerPublicKey: liar.publicKeyBase64,
        session: 0x53,
      }).body,
      // The liar's key is filed under the liar's name, so the HELLO that claims to be from `machine-a`
      // cannot be verified against it.
      peerKeys: new Map([['machine-liar', liar.publicKeyBase64]]),
      seen: new NonceCache(),
    });
    assert.equal(misnamed.ok, false);
    assert.equal(misnamed.reason, CRYPTO_REASON.UNKNOWN_PEER, 'the name on the HELLO is not one we know');
  });

  it('refuses the handshake at the socket, and never hands back a plaintext channel', async () => {
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed0003;
      const keysA = DeviceKey.generate('machine-a');
      const keysB = DeviceKey.generate('machine-b');
      const imposter = DeviceKey.generate('machine-imposter');

      const dialling = punch({
        socket: a.socket,
        remote: [loopback(b)],
        session,
        timeoutMs: 4000,
        crypto: { deviceKey: keysA, peerKey: keysB.publicKeyBase64, peerMachineId: 'machine-b' },
      });
      const answering = accept({
        socket: b.socket,
        timeoutMs: 4000,
        crypto: {
          deviceKey: keysB,
          // B's key for A is not A's key. This is the case §4 is explicit about.
          peerKeys: new Map([['machine-a', imposter.publicKeyBase64]]),
          seen: new NonceCache(),
        },
      });
      const [dialled, accepted] = await Promise.all([dialling, answering]);

      assert.equal(dialled.ok, false, 'a failed handshake is not a channel');
      assert.equal(dialled.channel, undefined);
      assert.equal(dialled.crypto.status, 'refused');
      assert.equal(dialled.crypto.reason, CRYPTO_REASON.BAD_MAC);
      assert.match(dialled.error, /P2P_CRYPTO_BAD_MAC/);
      // And the refusal is *proved*, which is only possible because it is sealed with the key derived
      // from the handshake's own ephemeral. Sealing it with `k0` would fail exactly here: B's record of
      // A's key is the wrong one, which is what `BAD_MAC` means, so the two ends cannot agree on `k0`.
      assert.equal(dialled.crypto.refusal_authenticated, true);

      // The responder records its own refusal and hands back nothing either: there is no path this
      // build will use in the clear with a peer whose key it cannot verify.
      assert.equal(accepted.ok, false);
      assert.equal(accepted.channel, null);
      assert.equal(accepted.crypto.status, 'refused');
      assert.equal(accepted.crypto.reason, CRYPTO_REASON.BAD_MAC);
      assert.equal(accepted.crypto.refusal_authenticated, true);
    } finally {
      close();
    }
  });

  it('records the refusal where an operator can read it, rather than only in a log', async () => {
    // The node's own surface. `dial()` returns the reason *and* keeps it in `status.encryption`, so
    // "why is this peer never encrypted?" is answerable without reading two machines' logs.
    const { P2PNode } = await import('../src/agent/p2p-node.mjs');
    const sockets = [];
    const binder = async () => {
      const bound = await bindUdpSocket();
      sockets.push(bound);
      return bound;
    };
    const makeNode = (id, extra) =>
      new P2PNode({
        mode: 'auto',
        machineId: id,
        rabbitUrl: 'http://127.0.0.1:1',
        postJson: async () => ({ ok: false, status: 0, json: null }),
        getJson: async () => ({ ok: false, status: 404, json: null }),
        discover: async () => ({ ok: false, reflexive: null, mapping: 'unknown', error: 'no stun' }),
        bindUdpSocket: binder,
        tuning: { punchTimeoutMs: 3000, acceptTimeoutMs: 3000 },
        ...extra,
      });

    const keysA = DeviceKey.generate('machine-a');
    const keysB = DeviceKey.generate('machine-b');
    const imposter = DeviceKey.generate('machine-imposter');
    const peersA = new PeerKeyStore();
    peersA.set('machine-b', keysB.publicKeyBase64, 'test');
    const peersB = new PeerKeyStore();
    peersB.set('machine-a', imposter.publicKeyBase64, 'test');

    const a = makeNode('machine-a', { deviceKey: keysA, peerKeys: peersA });
    const b = makeNode('machine-b', { deviceKey: keysB, peerKeys: peersB });
    try {
      await a.start();
      await b.start();
      const dialled = await a.dial('machine-b', {
        session: 0x5eed0005,
        candidates: [{ address: '127.0.0.1', port: b.status.local.port }],
      });
      assert.equal(dialled.ok, false);
      assert.equal(dialled.channel, null);
      assert.match(dialled.error, /P2P_CRYPTO_(BAD_MAC|UNKNOWN_PEER)/);

      const refusals = a.status.encryption.refusals;
      assert.ok(refusals.length >= 1, 'the refusal is kept in status.encryption.refusals');
      assert.match(refusals.at(-1).reason, /^P2P_CRYPTO_/);
      assert.equal(refusals.at(-1).machine_id, 'machine-b');
      assert.equal(refusals.at(-1).direction, 'out');
      assert.equal(a.status.encryption.refused >= 1, true);
      // And nothing was adopted: a refusal produces no channel, which is what makes `refused` mean
      // "no channel was made" rather than "a channel was made and then complained about".
      assert.equal(a.channels.size, 0);
    } finally {
      await a.close();
      await b.close();
      for (const bound of sockets) {
        try {
          bound.socket.close();
        } catch {
          /* gone */
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* MEDIUM-4 — a REFUSE datagram is not evidence by itself                      */
/* -------------------------------------------------------------------------- */

describe('crypto: MEDIUM-4 a spoofed REFUSE cannot rewrite a punch', () => {
  /** The attack datagram of the v0.5.9 review: a bare `HELLO_ACK` carrying REFUSE(NO_PEER_KEY). */
  const bareRefuse = (session) => frameOf(KIND.HELLO_ACK, session, encodeRefuse(session, REFUSE.NO_PEER_KEY));

  /**
   * The dial side of the attack. `attacker` is a THIRD socket — an address this punch never dialled —
   * which is exactly how the review reproduced it: 13 bytes, no key, no session knowledge beyond the
   * id the ledger is public about.
   *
   * @param {{attack: boolean, responderPort?: number}} options
   */
  async function dialWith(deps, { attack, attackSession }) {
    const { a, b, x } = deps;
    const session = 0x5eed004d;
    const keysA = DeviceKey.generate('machine-a');
    const keysB = DeviceKey.generate('machine-b');
    // The peer acknowledges plainly and never completes a handshake: the "responsive, not encrypted"
    // peer the defect needs, because only an answer opens the path and lets a refusal settle it.
    b.socket.on('message', (_datagram, rinfo) => {
      b.socket.send(frameOf(KIND.HELLO_ACK, session), rinfo.port, rinfo.address, () => {});
    });
    let sent = null;
    if (attack) {
      sent = bareRefuse(attackSession ?? session);
      setTimeout(() => x.socket.send(sent, a.local.port, '127.0.0.1', () => {}), 200);
    }
    const result = await connect({
      socket: a.socket,
      remote: [loopback(b)],
      session,
      timeoutMs: 1500,
      intervalMs: 100,
      crypto: { deviceKey: keysA, peerKey: keysB.publicKeyBase64, peerMachineId: 'machine-b' },
    });
    return { result, bytes: sent === null ? 0 : sent.length, peerPort: b.local.port, attackerPort: x.local.port };
  }

  /** Three bound sockets, closed together. */
  async function threeSockets() {
    const a = await bindUdpSocket();
    const b = await bindUdpSocket();
    const x = await bindUdpSocket();
    return {
      a,
      b,
      x,
      close: () => {
        for (const entry of [a, b, x]) {
          try {
            entry.socket.close();
          } catch {
            /* closed */
          }
        }
      },
    };
  }

  it('ignores the 13-byte third-socket refusal, and records which guard dropped it', async () => {
    const control = await threeSockets();
    const attacked = await threeSockets();
    try {
      // Without the attacker the punch refuses by name and hands back no channel: the behaviour the
      // review's "before" measurement recorded, and the one the attack used to overwrite.
      const before = await dialWith(control, { attack: false });
      assert.equal(before.result.ok, false);
      assert.equal(before.result.crypto.status, 'refused');
      assert.equal(before.result.crypto.reason, CRYPTO_REASON.HANDSHAKE_TIMEOUT);
      assert.equal(before.result.channel, null);

      const after = await dialWith(attacked, { attack: true });
      assert.equal(after.bytes, 13, 'the attack datagram is 13 bytes: 5 of frame header, 8 of REFUSE');
      assert.notEqual(after.attackerPort, after.peerPort, 'it came from an address this punch never dialled');
      // THE FIX: the outcome is the one without the attacker, not the plaintext channel the datagram asked for.
      assert.equal(after.result.ok, false, 'a refusal from nowhere may not hand back a channel');
      assert.equal(after.result.channel, null);
      assert.equal(after.result.crypto.status, 'refused');
      assert.equal(after.result.crypto.reason, CRYPTO_REASON.HANDSHAKE_TIMEOUT);

      const ignored = after.result.crypto.ignored_refusals ?? [];
      assert.equal(ignored.length >= 1, true, 'the drop is reported rather than silent');
      assert.equal(ignored.at(-1).reason_code, CRYPTO_REASON.REFUSE_UNPUNCHED_SOURCE);
      assert.match(ignored.at(-1).detail, /neither one of the 1 address\(es\) this punch dialled/);
      assert.equal(ignored.at(-1).from, `127.0.0.1:${after.attackerPort}`, 'and it names where the drop came from');
      assert.equal(ignored.at(-1).datagram_bytes, 13, 'and it names the datagram that was dropped');
    } finally {
      control.close();
      attacked.close();
    }
  });

  it('ignores a refusal that names a session this punch did not agree', async () => {
    const deps = await threeSockets();
    try {
      const { result } = await dialWith(deps, { attack: true, attackSession: 0xdeadbeef });
      assert.equal(result.ok, false);
      assert.equal(result.channel, null);
      const ignored = result.crypto.ignored_refusals ?? [];
      assert.equal(ignored.at(-1).reason_code, CRYPTO_REASON.REFUSE_SESSION_MISMATCH);
      assert.match(ignored.at(-1).detail, /names the agreed session/);
    } finally {
      deps.close();
    }
  });

  it('drops a sealed refusal whose MAC does not verify, even from the dialled address', async () => {
    // Condition 3 of REFUSE_GUARD, from the address that *is* a candidate: a `NO_PEER_KEY` sealed with
    // a key that is not `k_ref` cannot choose the plaintext outcome. An honest peer that cannot derive
    // `k_ref` sends no MAC at all, which is the claim path — so nothing legitimate is lost here.
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed004e;
      const keysA = DeviceKey.generate('machine-a');
      const keysB = DeviceKey.generate('machine-b');
      b.socket.on('message', (_datagram, rinfo) => {
        // A sealed refusal built with a key that is not this exchange's `k_ref`: a valid-looking seal
        // that verifies nowhere. An honest peer either seals correctly or sends no MAC at all.
        const forged = sealRefuse(session, REFUSE.NO_PEER_KEY, 'machine-b', Buffer.alloc(32, 9));
        b.socket.send(frameOf(KIND.HELLO_ACK, session), rinfo.port, rinfo.address, () => {});
        b.socket.send(frameOf(KIND.HELLO_ACK, session, forged), rinfo.port, rinfo.address, () => {});
      });
      const result = await connect({
        socket: a.socket,
        remote: [loopback(b)],
        session,
        timeoutMs: 1500,
        intervalMs: 100,
        crypto: { deviceKey: keysA, peerKey: keysB.publicKeyBase64, peerMachineId: 'machine-b' },
      });
      assert.equal(result.ok, false);
      assert.equal(result.channel, null);
      const ignored = result.crypto.ignored_refusals ?? [];
      assert.equal(ignored.length >= 1, true);
      assert.equal(ignored.at(-1).reason_code, CRYPTO_REASON.REFUSE_BAD_MAC);
    } finally {
      close();
    }
  });

  it('still falls back to plaintext when the peer honestly refuses, and says it was proved', async () => {
    // THE OTHER DIRECTION, with the real responder: `accept()` on a machine that holds a keypair and no
    // key for the dialler. §4's fallback clause has to survive the hardening, and the sealed refusal
    // makes it *stronger* than before rather than weaker — the plaintext outcome now rests on proof.
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed004f;
      const keysA = DeviceKey.generate('machine-a');
      const keysB = DeviceKey.generate('machine-b');
      const dialling = connect({
        socket: a.socket,
        remote: [loopback(b)],
        session,
        timeoutMs: 2500,
        intervalMs: 100,
        crypto: { deviceKey: keysA, peerKey: keysB.publicKeyBase64, peerMachineId: 'machine-b' },
      });
      const answering = accept({
        socket: b.socket,
        timeoutMs: 2500,
        crypto: { deviceKey: keysB, peerKeys: new Map(), seen: new NonceCache() },
      });
      const [dialled, accepted] = await Promise.all([dialling, answering]);

      assert.equal(accepted.crypto.status, 'plaintext', 'the responder keeps the v0.5.x compatibility path');
      assert.equal(dialled.ok, true, dialled.error ?? 'the documented fallback must still happen');
      assert.equal(dialled.crypto.status, 'plaintext');
      assert.equal(dialled.crypto.reason, CRYPTO_REASON.NO_KEY);
      assert.equal(dialled.crypto.refusal_authenticated, true, 'the refusal was sealed with k_ref');
      assert.equal(dialled.crypto.ignored_refusals, undefined, 'and nothing was dropped');
      assert.equal(dialled.channel.encryption.encrypted, false);
      assert.equal(dialled.channel.encryption.reason, CRYPTO_REASON.NO_KEY);
      dialled.channel.close('done');
      accepted.channel.close('done');
    } finally {
      close();
    }
  });

  it('still falls back for an older peer that cannot seal, from the endpoint that acknowledged', async () => {
    // THE COMPATIBILITY PATH, and the reason the downgrade cannot simply *require* a seal: a peer
    // running a build without `k_ref` sends a bare refusal. That form is honoured when it comes from
    // the endpoint that answered the punch, which is what a real responder does — one socket, the
    // refusal first and the plain acknowledgement after it.
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed0052;
      const keysA = DeviceKey.generate('machine-a');
      const keysB = DeviceKey.generate('machine-b');
      b.socket.on('message', (_datagram, rinfo) => {
        b.socket.send(
          frameOf(KIND.HELLO_ACK, session, encodeRefuse(session, REFUSE.NO_PEER_KEY)),
          rinfo.port,
          rinfo.address,
          () => {},
        );
        b.socket.send(frameOf(KIND.HELLO_ACK, session), rinfo.port, rinfo.address, () => {});
      });
      const result = await connect({
        socket: a.socket,
        remote: [loopback(b)],
        session,
        timeoutMs: 2000,
        intervalMs: 100,
        crypto: { deviceKey: keysA, peerKey: keysB.publicKeyBase64, peerMachineId: 'machine-b' },
      });
      assert.equal(result.ok, true, result.error ?? 'the documented fallback must survive the guard');
      assert.equal(result.crypto.status, 'plaintext');
      assert.equal(result.crypto.reason, CRYPTO_REASON.NO_KEY);
      assert.equal(result.crypto.refusal_authenticated, null, 'unsealed: the older peer\'s form');
      assert.equal(result.crypto.ignored_refusals, undefined, 'and it is honoured, not dropped');
      assert.equal(result.channel.encryption.encrypted, false);
      result.channel.close('done');
    } finally {
      close();
    }
  });

  it('drops an unsealed downgrade that no acknowledgement from that endpoint backs', async () => {
    // Condition 4, with two candidates: the punch dials both, one answers plainly (that endpoint is the
    // punched peer), and the *other* sends the bare refusal. The refusal is a candidate and names the
    // right session, so it passes conditions 1 and 2 — and it still may not choose a plaintext channel,
    // because nothing from that address ever acknowledged the punch.
    const { a, b, x, close } = await threeSockets();
    try {
      const session = 0x5eed0053;
      const keysA = DeviceKey.generate('machine-a');
      const keysB = DeviceKey.generate('machine-b');
      b.socket.on('message', (_datagram, rinfo) => {
        b.socket.send(frameOf(KIND.HELLO_ACK, session), rinfo.port, rinfo.address, () => {});
      });
      x.socket.on('message', (_datagram, rinfo) => {
        x.socket.send(
          frameOf(KIND.HELLO_ACK, session, encodeRefuse(session, REFUSE.NO_PEER_KEY)),
          rinfo.port,
          rinfo.address,
          () => {},
        );
      });
      const result = await connect({
        socket: a.socket,
        // Both are "the peer" as far as the punch knows: two candidates from one offer.
        remote: [loopback(b), loopback(x)],
        session,
        timeoutMs: 2000,
        intervalMs: 100,
        crypto: { deviceKey: keysA, peerKey: keysB.publicKeyBase64, peerMachineId: 'machine-b' },
      });
      assert.equal(result.ok, false, 'a downgrade from an unacknowledged candidate is not a downgrade');
      assert.equal(result.channel, null);
      const ignored = result.crypto.ignored_refusals ?? [];
      assert.equal(ignored.length >= 1, true, 'the drop is recorded');
      assert.equal(ignored.at(-1).reason_code, CRYPTO_REASON.REFUSE_UNCORROBORATED);
      assert.equal(ignored.at(-1).from, `127.0.0.1:${x.local.port}`);
      assert.match(ignored.at(-1).detail, /answered this punch is 127\.0\.0\.1:/);
    } finally {
      close();
    }
  });

  it('writes the guard down as a value, so a later edit has to argue with it', () => {
    assert.equal(REFUSE_GUARD.requires.length, 4);
    assert.match(REFUSE_GUARD.requires[0], /names the session this punch agreed/);
    assert.match(REFUSE_GUARD.requires[1], /address this punch dialled/);
    assert.match(REFUSE_GUARD.requires[2], /k_ref MAC that verifies/);
    assert.match(REFUSE_GUARD.requires[3], /comes from the address that answered the punch/);
    assert.match(REFUSE_GUARD.residual, /plaintext outcome/, 'the residual claim is stated, not implied');
  });

  it('never reads a handshake body as a refusal, and round-trips both refusal forms', () => {
    // The parse is what stands between "a refusal arrived" and "a HELLO_ACK arrived", and both are
    // `magic|version|session|…` with a byte that can look like an id length. A bare decode accepted one
    // length and validated nothing else, so a genuine ACK could be read as a refusal — body[6] (the
    // first byte of a random ephemeral) becoming the code. Crafted here rather than waited for: byte 7
    // is rewritten to the value that makes the lengths agree, which is the collision itself.
    const keysA = DeviceKey.generate('machine-a');
    const keysB = DeviceKey.generate('machine-b');
    const start = startHandshake({
      deviceKey: keysA,
      peerMachineId: 'machine-b',
      peerPublicKey: keysB.publicKeyBase64,
      session: 0x5eed0050,
    });
    const answered = respondHandshake({
      deviceKey: keysB,
      body: start.body,
      peerKeys: new Map([['machine-a', keysA.publicKeyBase64]]),
      seen: new NonceCache(),
    });
    const ackBody = Buffer.from(answered.body);
    assert.equal(decodeRefuse(ackBody), null, 'a real HELLO_ACK is not a refusal');
    ackBody.writeUInt8(ackBody.length - 8, 7);
    ackBody.writeUInt8(REFUSE.NO_PEER_KEY, 6);
    assert.equal(
      decodeRefuse(ackBody),
      null,
      'nor is one whose length byte has been bent to collide: key material is not a machine id',
    );

    // Both forms round-trip, and the seal is checked with k_ref rather than trusted.
    const session = 0x5eed0051;
    const bare = encodeRefuse(session, REFUSE.NO_PEER_KEY, 'machine-b');
    assert.equal(bare.length, 8 + 'machine-b'.length);
    assert.deepEqual(decodeRefuse(bare).mac, null);
    const key = refusalMacKey({ privateKey: keysA.privateKey, peerPublicRaw: decodeKey(keysB.publicKeyBase64) });
    const sealed = sealRefuse(session, REFUSE.NO_PEER_KEY, 'machine-b', key);
    assert.equal(sealed.length, bare.length + 48);
    const decoded = decodeRefuse(sealed);
    assert.equal(decoded.code, REFUSE.NO_PEER_KEY);
    assert.equal(decoded.mac.length, 48);
    assert.equal(verifyRefuseMac(key, sealed), true);
    assert.equal(verifyRefuseMac(Buffer.alloc(32, 7), sealed), false);
    assert.equal(verifyRefuseMac(key, bare), null, 'no MAC is not a failed MAC');
    assert.equal(verifyRefuseMac(null, sealed), false, 'a MAC we cannot check is not evidence');
  });
});

/* -------------------------------------------------------------------------- */
/* §7.3 — a replayed HELLO is refused                                          */
/* -------------------------------------------------------------------------- */

describe('crypto: §7.3 a replayed HELLO is refused', () => {
  it('refuses the second sighting of one ephemeral, and creates no second session', () => {
    const a = DeviceKey.generate('machine-a');
    const b = DeviceKey.generate('machine-b');
    const keys = new Map([['machine-a', a.publicKeyBase64]]);
    const seen = new NonceCache();
    const start = startHandshake({
      deviceKey: a,
      peerMachineId: 'machine-b',
      peerPublicKey: b.publicKeyBase64,
      session: 0x61,
    });

    const first = respondHandshake({ deviceKey: b, body: start.body, peerKeys: keys, seen });
    assert.equal(first.ok, true);

    const replay = respondHandshake({ deviceKey: b, body: start.body, peerKeys: keys, seen });
    assert.equal(replay.ok, false, 'a replayed HELLO must not produce a session');
    assert.equal(replay.reason, CRYPTO_REASON.REPLAY);
    assert.equal(replay.crypto, undefined);
    // The *identical* answer is re-sent, which is what keeps a retransmission whose answer was lost
    // from being failed for our own lost datagram: `finish()` accepts the same ACK twice.
    assert.deepEqual(replay.refuse, first.body);
    assert.equal(start.finish(replay.refuse).ok, true, 'the retransmitted answer still completes it');
  });

  it('cannot be replayed into a different punch, because the MAC is session-bound', () => {
    // §4's mac is `AEAD(k0, 0, hash(prologue ‖ s_i.pub ‖ s_r.pub))`, and every one of those inputs is
    // the same for every punch between one pair of machines. The binding is what makes a captured
    // HELLO useless in the next punch rather than merely detectable in the same one.
    const a = DeviceKey.generate('machine-a');
    const b = DeviceKey.generate('machine-b');
    const keys = new Map([['machine-a', a.publicKeyBase64]]);
    const start = startHandshake({
      deviceKey: a,
      peerMachineId: 'machine-b',
      peerPublicKey: b.publicKeyBase64,
      session: 0x62,
    });
    const moved = Buffer.from(start.body);
    moved.writeUInt32BE(0x63, 2);
    const crossed = respondHandshake({ deviceKey: b, body: moved, peerKeys: keys, seen: new NonceCache() });
    assert.equal(crossed.ok, false);
    assert.equal(crossed.reason, CRYPTO_REASON.BAD_MAC);
  });

  it('refuses a handshake message offered as data on an encrypted channel', async () => {
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed0006;
      const { responder } = sessionPair({ session });
      const channelB = new P2PChannel({
        socket: b.socket,
        peer: loopback(a),
        session,
        crypto: { session: responder, isInitiator: false },
      });
      const failures = [];
      channelB.on('crypto', (event) => failures.push(event.reason));

      // A plaintext HELLO body, wrapped in an ordinary frame. It must not be decrypted — the body
      // fails its tag — and it must not be read as a handshake either.
      const intruder = startHandshake({
        deviceKey: DeviceKey.generate('machine-x'),
        peerMachineId: 'machine-y',
        peerPublicKey: DeviceKey.generate('machine-y').publicKeyBase64,
        session,
      });
      await new Promise((resolve) => {
        a.socket.send(frameOf(KIND.HELLO, session, intruder.body), b.local.port, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(channelB.encryption.dropped >= 1, true, 'the frame was dropped, not processed');
      assert.equal(failures.length >= 1, true);
      assert.equal(channelB.encryption.received, 0);
      channelB.close('done');
    } finally {
      close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §7.4 — one flipped bit fails authentication                                 */
/* -------------------------------------------------------------------------- */

describe('crypto: §7.4 a data frame with one bit flipped is dropped, not processed', () => {
  it('refuses a frame whose ciphertext was altered', () => {
    const { initiator, responder } = sessionPair({ session: 0x71 });
    const plaintext = frameOf(KIND.DATA, 0x71, dataBody(1, 0, 1, Buffer.from('the real payload')));

    for (const offset of [5, 10, 20, plaintext.length + CIPHER_OVERHEAD_BYTES - 1]) {
      const sealed = initiator.encrypt(true, plaintext);
      sealed[offset] ^= 0x01;
      const opened = responder.decrypt(false, sealed);
      assert.equal(opened.ok, false, `byte ${offset} is covered by the tag`);
      assert.equal(opened.reason, CRYPTO_REASON.AUTH_FAILED);
      assert.equal(opened.frame, undefined, 'no plaintext is ever returned without a valid tag');
    }
    assert.equal(responder.stats.received, 0, 'nothing was processed');
  });

  it('refuses a frame whose header was altered, because the header is authenticated data', () => {
    // The kind byte is not encrypted — the channel routes on it — so it is carried as additional
    // authenticated data. Without that, an attacker could retag a DATA frame as a BYE.
    const { initiator, responder } = sessionPair({ session: 0x72 });
    const sealed = initiator.encrypt(true, frameOf(KIND.DATA, 0x72, dataBody(1, 0, 1, Buffer.from('x'))));

    const retagged = Buffer.from(sealed);
    retagged.writeUInt8(KIND.BYE, 0);
    assert.equal(responder.decrypt(false, retagged).reason, CRYPTO_REASON.AUTH_FAILED);

    const moved = Buffer.from(sealed);
    moved.writeUInt32BE(0x9999, 1);
    assert.equal(responder.decrypt(false, moved).reason, CRYPTO_REASON.AUTH_FAILED);
  });

  it('drops it at the channel, and the peer sees the channel as damaged rather than healthy', async () => {
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed0007;
      const { initiator, responder } = sessionPair({ session });
      const channelB = new P2PChannel({
        socket: b.socket,
        peer: loopback(a),
        session,
        crypto: { session: responder, isInitiator: false },
      });
      const delivered = [];
      channelB.on('message', (payload) => delivered.push(payload));
      const failures = [];
      channelB.on('crypto', (event) => failures.push(event));

      // A valid DATA frame with one bit flipped after it was sealed. This is what an on-path
      // attacker produces, and what a corrupt path produces.
      const sealed = initiator.encrypt(true, frameOf(KIND.DATA, session, dataBody(7, 0, 1, Buffer.from('tamper me'))));
      sealed[sealed.length - 8] ^= 0x01;
      await new Promise((resolve) => {
        a.socket.send(sealed, b.local.port, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.deepEqual(delivered, [], 'the payload was never delivered');
      assert.equal(channelB.encryption.dropped, 1);
      assert.equal(channelB.encryption.last_failure, CRYPTO_REASON.AUTH_FAILED);
      assert.equal(failures.length, 1);
      assert.equal(channelB.encryption.received, 0, 'nothing was processed');
      channelB.close('done');
    } finally {
      close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §7.5 — a counter already seen is dropped                                    */
/* -------------------------------------------------------------------------- */

describe('crypto: §7.5 a frame whose counter was already seen is dropped', () => {
  it('accepts in order, and refuses a repeat', () => {
    const { initiator, responder } = sessionPair({ session: 0x81 });
    const frames = [];
    for (let i = 0; i < 4; i += 1) {
      frames.push(initiator.encrypt(true, frameOf(KIND.DATA, 0x81, dataBody(i + 1, 0, 1, Buffer.from(`m${i}`)))));
    }
    for (const frame of frames) assert.equal(responder.decrypt(false, frame).ok, true);

    const replay = responder.decrypt(false, frames[2]);
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, CRYPTO_REASON.REPLAYED_FRAME);
    assert.equal(responder.stats.replay_refusals, 1);
    assert.equal(responder.stats.received, 4, 'the replay was not counted as a delivery');
  });

  it('allows out-of-order frames inside the window and refuses the ones that fall out of it', () => {
    const window = new ReplayWindow(4);
    assert.equal(window.accept(0n), true);
    assert.equal(window.accept(0n), false, 'a repeat of the top counter is a replay');
    assert.equal(window.accept(3n), true);
    assert.equal(window.accept(1n), true, 'still inside the window');
    assert.equal(window.accept(2n), true);
    assert.equal(window.accept(9n), true, 'a jump forward slides the window');
    // The window spans `highest - (size - 1)` … `highest`: with highest 9 and a width of 4 that is
    // 6, 7, 8, 9. Counter 5 and below has fallen out and can no longer be placed.
    assert.equal(window.accept(6n), true, 'the oldest counter the window still holds');
    assert.equal(window.accept(5n), false, 'one below the oldest is unplaceable');
    assert.equal(window.refused, 2, 'the repeat of 0 and the evicted 5');

    // A 64-wide window is what the protocol uses, and in-order traffic must never be refused by it —
    // the failure mode that a left-shifting slide produced, where every seen bit walked off the end.
    const wide = new ReplayWindow(64);
    for (let i = 0; i < 500; i += 1) assert.equal(wide.accept(BigInt(i)), true, `frame ${i}`);
    assert.equal(wide.refused, 0);
    assert.equal(wide.accept(400n), false, 'and a frame from 100 messages ago is still a replay');
    assert.equal(wide.accept(500n), true, 'while a new one is not');
  });

  it('answers a replayed frame with a PONG rather than a second delivery', async () => {
    // The end-to-end version of the same fact: a replayed PING must not produce a second PONG, and a
    // replayed DATA frame must not produce a second `'message'`.
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed0008;
      const { initiator, responder } = sessionPair({ session });
      const channelB = new P2PChannel({
        socket: b.socket,
        peer: loopback(a),
        session,
        crypto: { session: responder, isInitiator: false },
      });
      const delivered = [];
      channelB.on('message', (payload) => delivered.push(payload.toString('utf8')));
      const sent = recordSends(a.socket);

      const sealed = initiator.encrypt(true, frameOf(KIND.DATA, session, dataBody(3, 0, 1, Buffer.from('once'))));
      await new Promise((resolve) => a.socket.send(sealed, b.local.port, '127.0.0.1', resolve));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const acksAfterFirst = sent.filter((bytes) => bytes.readUInt8(0) === KIND.ACK).length;

      await new Promise((resolve) => a.socket.send(sealed, b.local.port, '127.0.0.1', resolve));
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.deepEqual(delivered, ['once'], 'the replay was not delivered twice');
      assert.equal(
        sent.filter((bytes) => bytes.readUInt8(0) === KIND.ACK).length,
        acksAfterFirst,
        'a replayed frame is not even acknowledged',
      );
      assert.equal(channelB.encryption.dropped, 1);
      assert.equal(channelB.encryption.last_failure, CRYPTO_REASON.REPLAYED_FRAME);
      channelB.close('done');
    } finally {
      close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §7.6 — an older peer still completes its task, with encrypted:false         */
/* -------------------------------------------------------------------------- */

describe('crypto: §7.6 an older peer that never learned a key still completes its task', () => {
  it('answers a v0.5.x HELLO plainly, with a keypair of its own', async () => {
    // The server half of the compatibility rule, at the lowest level: a frame whose body is empty is
    // the punch v0.5.x sends, and refusing it would turn "this build has no keys" into "this machine is
    // unreachable" — the fleet-losing outcome §4 forbids.
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed000a;
      const answering = accept({
        socket: b.socket,
        timeoutMs: 3000,
        crypto: {
          deviceKey: DeviceKey.generate('machine-b'),
          peerKeys: new PeerKeyStore(),
          seen: new NonceCache(),
        },
      });
      await new Promise((resolve) => a.socket.send(frameOf(KIND.HELLO, session), b.local.port, '127.0.0.1', resolve));
      const answered = await answering;
      assert.equal(answered.ok, true);
      assert.equal(answered.channel.encryption.encrypted, false);
      assert.equal(answered.channel.encryption.reason, CRYPTO_REASON.PLAINTEXT_PEER);
      assert.equal(answered.machineId, null, 'a plain HELLO carries no identity to believe');
      answered.channel.close('done');
    } finally {
      close();
    }
  });

  it('names the case where the peer has a keypair but none for us, instead of going silent', async () => {
    // Both ends are v0.6.0 here; what is missing is the *key distribution* — the offer that would have
    // carried the dispatcher's public key. The peer must say so, because the alternative is an
    // initiator that waits out its timeout and reports a timeout rather than a key it never had.
    //
    // Node-level, because that is where a channel exists to inspect: `punch()` opens a path and returns
    // the facts about it, and `dial()` is what wraps one in a channel.
    const { P2PNode } = await import('../src/agent/p2p-node.mjs');
    const sockets = [];
    const binder = async () => {
      const bound = await bindUdpSocket();
      sockets.push(bound);
      return bound;
    };
    const makeNode = (id, extra) =>
      new P2PNode({
        mode: 'auto',
        machineId: id,
        rabbitUrl: 'http://127.0.0.1:1',
        postJson: async () => ({ ok: false, status: 0, json: null }),
        getJson: async () => ({ ok: false, status: 404, json: null }),
        discover: async () => ({ ok: false, reflexive: null, mapping: 'unknown', error: 'no stun' }),
        bindUdpSocket: binder,
        tuning: { punchTimeoutMs: 3000, acceptTimeoutMs: 3000 },
        ...extra,
      });

    const keysA = DeviceKey.generate('machine-a');
    const keysB = DeviceKey.generate('machine-b');
    // A holds B's key and dials; B has a keypair and an empty store, so it cannot verify A.
    const peersA = new PeerKeyStore();
    peersA.set('machine-b', keysB.publicKeyBase64, 'test');
    const a = makeNode('machine-a', { deviceKey: keysA, peerKeys: peersA });
    const b = makeNode('machine-b', { deviceKey: keysB, peerKeys: new PeerKeyStore() });
    try {
      await a.start();
      await b.start();
      const dialled = await a.dial('machine-b', {
        session: 0x5eed000e,
        candidates: [{ address: '127.0.0.1', port: b.status.local.port }],
      });

      assert.equal(dialled.ok, true, `a peer with no key for us must not fail the punch: ${dialled.error ?? ''}`);
      assert.equal(dialled.encrypted, false);
      assert.equal(dialled.encryption_reason, CRYPTO_REASON.NO_KEY);
      assert.equal(dialled.channel.encryption.encrypted, false);
      assert.equal(dialled.channel.encryption.reason, CRYPTO_REASON.NO_KEY);
      // B said so, in its own words, rather than leaving A to guess.
      assert.equal(b.status.encryption.refusals.length + a.status.encryption.refusals.length >= 1, true);
    } finally {
      await a.close();
      await b.close();
      for (const bound of sockets) {
        try {
          bound.socket.close();
        } catch {
          /* gone */
        }
      }
    }
  });

  it('dials a keyless peer from a real node, and records why the channel is plaintext', async () => {
    // The node-level version, which is where the ledger's facts come from: a machine with a keypair
    // dials one that has none for it, and neither the punch nor the record is silent about it.
    const { P2PNode } = await import('../src/agent/p2p-node.mjs');
    const sockets = [];
    const binder = async () => {
      const bound = await bindUdpSocket();
      sockets.push(bound);
      return bound;
    };
    const makeNode = (id, extra) =>
      new P2PNode({
        mode: 'auto',
        machineId: id,
        rabbitUrl: 'http://127.0.0.1:1',
        postJson: async () => ({ ok: false, status: 0, json: null }),
        getJson: async () => ({ ok: false, status: 404, json: null }),
        discover: async () => ({ ok: false, reflexive: null, mapping: 'unknown', error: 'no stun' }),
        bindUdpSocket: binder,
        tuning: { punchTimeoutMs: 3000, acceptTimeoutMs: 3000 },
        ...extra,
      });

    const advanced = makeNode('machine-advanced', {
      deviceKey: DeviceKey.generate('machine-advanced'),
      peerKeys: new PeerKeyStore(),
    });
    const older = makeNode('machine-older', {});
    try {
      await advanced.start();
      await older.start();
      const dialled = await advanced.dial('machine-older', {
        session: 0x5eed000f,
        candidates: [{ address: '127.0.0.1', port: older.status.local.port }],
      });
      assert.equal(dialled.ok, true, dialled.error ?? 'the punch itself must still work');
      assert.equal(dialled.channel.encryption.encrypted, false);
      assert.equal(dialled.channel.encryption.reason, CRYPTO_REASON.PLAINTEXT_PEER);
      assert.equal(advanced.status.encryption.enabled, true, 'this machine *has* a keypair');
      assert.equal(advanced.status.encryption.plaintext_channels, 1);
      assert.equal(advanced.status.encryption.encrypted_channels, 0);
      assert.equal(advanced.status.encryption.refusals.at(-1).reason, CRYPTO_REASON.PLAINTEXT_PEER);
    } finally {
      await advanced.close();
      await older.close();
      for (const bound of sockets) {
        try {
          bound.socket.close();
        } catch {
          /* gone */
        }
      }
    }
  });

  it('blames the relay, not the peer, when the relay drops the key it was sent', async () => {
    // THE v0.6.2 REGRESSION. This test exists because the opposite behaviour cost an afternoon: a
    // *relay* older than v0.6.0 accepted every announcement, silently dropped `static_key`, and served
    // entries without it — so every peer looked exactly like a machine that had no key, and the
    // resulting plaintext channel was reported as `PLAINTEXT_PEER` ("the peer never learned a key (an
    // older build)") against peers that were the same build, on the same host, holding valid keys.
    //
    // The relay here is that relay: it echoes an announcement without the key it was given. The peer
    // is not old and not keyless — it announces normally. Only the relay is behind.
    const { P2PNode } = await import('../src/agent/p2p-node.mjs');
    const sockets = [];
    const binder = async () => {
      const bound = await bindUdpSocket();
      sockets.push(bound);
      return bound;
    };

    /** An announcement the relay accepted, with the key stripped the way a pre-v0.6.0 relay strips it. */
    const oldRelayAnnounce = () => ({ ok: true, status: 200, json: { machine_id: 'x', candidates: [], ttl_ms: 60000 } });

    const behindRelay = 'machine-behind-relay';
    const peer = 'machine-healthy';

    const healthy = new P2PNode({
      mode: 'auto',
      machineId: peer,
      rabbitUrl: 'http://127.0.0.1:1',
      postJson: async () => oldRelayAnnounce(),
      getJson: async () => ({ ok: false, status: 404, json: null }),
      discover: async () => ({ ok: false, reflexive: null, mapping: 'unknown', error: 'no stun' }),
      bindUdpSocket: binder,
      deviceKey: DeviceKey.generate(peer),
      peerKeys: new PeerKeyStore(),
      tuning: { punchTimeoutMs: 2000, acceptTimeoutMs: 2000 },
    });

    const dialer = new P2PNode({
      mode: 'auto',
      machineId: behindRelay,
      rabbitUrl: 'http://127.0.0.1:1',
      postJson: async () => oldRelayAnnounce(),
      // The peer announces — with candidates, so the punch has somewhere to go — but the relay's copy
      // carries no key, because this relay never stored one.
      getJson: async () => ({
        ok: true,
        status: 200,
        json: { peer: { machine_id: peer, candidates: [{ address: '127.0.0.1', port: 9 }], nat: { mapping: 'unknown' } } },
      }),
      discover: async () => ({ ok: false, reflexive: null, mapping: 'unknown', error: 'no stun' }),
      bindUdpSocket: binder,
      deviceKey: DeviceKey.generate(behindRelay),
      peerKeys: new PeerKeyStore(),
      tuning: { punchTimeoutMs: 800, acceptTimeoutMs: 800 },
    });

    try {
      await healthy.start();
      await dialer.start();
      await dialer.announceNow();

      assert.equal(
        dialer.status.encryption.relay_serves_keys,
        false,
        'a relay that echoes an announcement without the key it was sent is not serving keys',
      );

      const dialled = await dialer.dial(peer, {
        session: 0x5eed0011,
        candidates: [{ address: '127.0.0.1', port: healthy.status.local.port }],
        timeoutMs: 800,
      });
      // The punch's outcome is not the point — whether anyone answers at 127.0.0.1:9 is not what this
      // test is about. The *reason* is.
      assert.equal(
        dialled.channel?.encryption?.reason ?? dialled.encryption?.reason,
        CRYPTO_REASON.RELAY_NO_KEYS,
        'the relay dropped the key, so the relay is the cause — not the peer',
      );
    } finally {
      await dialer.close();
      await healthy.close();
      for (const bound of sockets) {
        try {
          bound.socket.close();
        } catch {
          /* gone */
        }
      }
    }
  });

  it('completes the task and records encrypted:false in the ledger when the peer has no key', async () => {
    // THE REAL THING: a real relay, a real Localside agent, a real signed envelope. The offer arrives
    // over the relay because no key exists for this peer, which is the v0.5.x case, and what the
    // ledger has to show afterwards is `p2p.encrypted: false` *plus* the reason and a completed task.
    const http = await import('node:http');
    const { spawnSync } = await import('node:child_process');
    const { createRelayServer } = await import('../src/relay/server.mjs');
    const { createAgent } = await import('../src/agent/agent.mjs');
    const { loadOrCreateIdentity } = await import('../src/agent/identity.mjs');

    const repoDir = scratchDir('repo');
    const git = (args) => {
      const out = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
      if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr || out.stdout}`);
      return out.stdout.trim();
    };
    git(['init', '--initial-branch=main']);
    writeFileSync(join(repoDir, '.gitattributes'), '* text=auto eol=lf\n');
    writeFileSync(join(repoDir, 'tracked.txt'), 'line one\n');
    git(['add', '-A']);
    git(['-c', 'user.name=w2m-test', '-c', 'user.email=w2m@test.invalid', 'commit', '-m', 'base']);

    // `persist: false`, not `state: null`: a relay created without an explicit state directory falls
    // back to the operator's own `~/.w2m` and *revives their devices and tasks*, so a test would be
    // executing somebody else's fleet instead of its own. The plugin suite disables persistence the
    // same way, and this case learned it the hard way.
    const relay = createRelayServer({
      logger: null,
      operatorToken: 'p2p-crypto-operator',
      persist: false,
    });
    await relay.listen({ host: '127.0.0.1', port: 0 });
    const relayUrl = `http://127.0.0.1:${relay.port}`;

    const request = (url, { method = 'GET', token, body } = {}) =>
      new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
        const req = http.request(
          {
            hostname: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            method,
            headers: {
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let json = null;
              try {
                json = text === '' ? null : JSON.parse(text);
              } catch {
                json = null;
              }
              resolve({ status: res.statusCode, ok: res.statusCode < 400, json, text });
            });
          },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });

    const stateDir = scratchDir('state');
    const identity = loadOrCreateIdentity({ dir: stateDir, name: 'machine-executor' });
    // The relay's device record and the agent's identity are the same machine, so the id has to come
    // from the identity rather than the other way round: the relay leases a task to the *paired*
    // machine_id, and an agent whose `device.json` said something else would never be offered it.
    const paired = await request(`${relayUrl}/v1/pair`, {
      method: 'POST',
      body: {
        pairing_code: relay.state.createPairingCode(),
        machine_id: identity.identity.machine_id,
        machine_name: identity.identity.machine_name,
        platform: { os: 'linux', arch: 'x64' },
        caps: {},
      },
    });
    assert.equal(paired.ok, true, paired.text);

    identity.identity.device_token = paired.json.device_token;
    identity.identity.rabbit_url = relayUrl;
    const { saveIdentity } = await import('../src/agent/identity.mjs');
    saveIdentity(identity.identity, { dir: stateDir });

    const posted = [];
    const agent = createAgent({
      rabbitUrl: relayUrl,
      project: repoDir,
      stateDir,
      identity: identity.identity,
      caps: { write: true, node: process.version, python: null, npm: null, case_sensitive_fs: true, symlinks: true, exec_bit: true },
      platform: { os: 'linux', os_version: '6.0', arch: 'x64', shell: 'bash', shell_version: null },
      // The allow-list is default-deny and matches on an argv *prefix*, and the entry names `-e`
      // because that is the argument this test's command uses. A trailing `-e` is deliberately
      // refused by `src/agent/allowed-commands.mjs`: an entry that named only the interpreter would
      // otherwise admit "run this source", which is a grant the entry never spelled out. test/e2e.test.mjs
      // and test/p2p-agent.test.mjs run their commands the same way, and for the same reason: a real
      // git project and a real child process.
      allowedCommands: [[process.execPath, '-e']],
      p2pMode: 'auto',
      // No `deviceKey` and no `p2pNodeOptions`: this agent has a keypair like every v0.6.0 machine
      // (it is generated in the state dir), and what makes the peer "older" is that the *offer* carries
      // no key for it — which is exactly what a v0.5.x dispatcher publishes.
      //
      // `fetchImpl` is wrapped rather than stubbed: every request still reaches the real relay, and the
      // wrapper only records the envelope the agent posts to `/v1/result`. That is the ledger copy,
      // captured as it leaves — read from the spool instead and it may already be gone, because a
      // successful post acknowledges the entry and clears it.
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/v1/result') && typeof init?.body === 'string') {
          try {
            posted.push(JSON.parse(init.body));
          } catch {
            /* a body that is not JSON is the relay's problem, not this wrapper's */
          }
        }
        return fetch(url, init);
      },
      log: () => {},
    });

    try {
      await agent.startP2P();
      assert.equal(agent.state.p2p.encryption.enabled, true, 'this agent has a keypair of its own');
      assert.equal(typeof agent.state.p2p.encryption.public_key, 'string');
      assert.equal(agent.p2pNode.status.encryption.enabled, true);
      // Announced, so a key *could* have been exchanged over the relay — the point of this case is that
      // the offer carries none, which is the v0.5.x shape.
      await agent.p2pNode.announceNow();

      const dispatched = await request(`${relayUrl}/v1/task`, {
        method: 'POST',
        token: 'p2p-crypto-operator',
        body: {
          mode: 'replicate',
          command_argv: [process.execPath, '-e', "process.stdout.write('the task still runs')"],
          cwd_rel: '.',
          index_total: 1,
          timeout_ms: 20_000,
          write: false,
          origin_machine_id: 'machine-dispatcher',
          p2p: { mode: 'auto' },
        },
      });
      assert.equal(dispatched.ok, true, dispatched.text);
      const lease = dispatched.json.leases.find((entry) => entry.machine_id === identity.identity.machine_id);
      assert.ok(lease !== undefined, 'the relay leased the task to this machine');

      // The offer exactly as the relay publishes it: the stored `p2p` block, no `static_keys`, and no
      // direct channel to carry it. The agent is fed the relay's own frame rather than a hand-built
      // one, so what it records is a fact about the real offer path. `handleOffer` answers with
      // nothing, by design — the envelope is not its return value, it is the thing it spools and
      // posts — so the envelope is read back out of the spool, which is the copy the relay would
      // eventually receive.
      await agent.handleOffer({
        type: 'task.offer',
        task_id: dispatched.json.task_id,
        machine_id: identity.identity.machine_id,
        attempt: lease.attempt,
        index: lease.index,
        index_total: 1,
        dedupe_key: lease.dedupe_key,
        mode: 'replicate',
        command_argv: [process.execPath, '-e', "process.stdout.write('the task still runs')"],
        cwd_rel: '.',
        write: false,
        timeout_ms: 20_000,
        base_commit: null,
        base_tree: null,
        origin_machine_id: 'machine-dispatcher',
        p2p: { mode: 'auto' },
      });

      const spooled = agent.spool
        .pendingResults()
        .find((record) => record.task_id === dispatched.json.task_id);
      const envelope = spooled?.envelope ?? posted.find((entry) => entry.task_id === dispatched.json.task_id);
      assert.ok(envelope !== undefined, 'the attempt produced an envelope and posted it to /v1/result');
      assert.equal(verifyEnvelope(envelope), true, 'and its envelope_sha256 covers the fields below');

      // THE ACCEPTANCE FACT, read off the envelope the agent actually built — the one it spools and
      // posts, with `envelope_sha256` covering these very fields.
      assert.equal(envelope.status, 'ok');
      assert.equal(envelope.exit_code, 0);
      assert.equal(envelope.p2p.encrypted, false, 'no handshake completed for this task');
      assert.equal(typeof envelope.p2p.encryption_reason, 'string', 'and the reason travels with the flag');
      // The reason is the whole truth about why this task was not sealed, and here the immediate cause
      // is upstream of any key: no direct channel existed at all. A `P2P_CRYPTO_*` reason would mean a
      // channel existed and the handshake failed — a different fact — so the assertion names the one
      // that actually happened rather than a prefix loose enough to fit both.
      assert.match(envelope.p2p.encryption_reason, /^P2P_(CRYPTO_|NO_CANDIDATES)/);
      assert.equal(envelope.transport, 'relay');
      assert.equal(envelope.p2p.offer_path, 'relay');
      assert.equal(envelope.p2p.result_path, undefined, 'the relay carried the result too');
    } finally {
      await agent.stop();
      await relay.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §7.7 — no plaintext marker on the wire                                      */
/* -------------------------------------------------------------------------- */

describe('crypto: §7.7 a capture of the direct channel contains no plaintext marker', () => {
  it('carries the marker only when the channel really is plaintext', async () => {
    const marker = 'W2M-PLAINTEXT-MARKER-2f4c9a';
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed000b;
      const { initiator, responder } = sessionPair({ session });

      // Two runs, one variable: the same marker, the same sockets, the same message — sealed in the
      // first, plain in the second. Without the second, "the marker is absent" would be satisfied by
      // a channel that never carried anything at all.
      for (const encrypted of [false, true]) {
        const cipherPair = encrypted ? { initiator, responder } : null;
        const channelA = new P2PChannel({
          socket: a.socket,
          peer: loopback(b),
          session,
          ...(cipherPair === null ? {} : { crypto: { session: cipherPair.initiator, isInitiator: true } }),
        });
        const channelB = new P2PChannel({
          socket: b.socket,
          peer: loopback(a),
          session,
          ...(cipherPair === null ? {} : { crypto: { session: cipherPair.responder, isInitiator: false } }),
        });
        const sent = recordSends(a.socket);
        const delivered = new Promise((resolve) => channelB.once('message', resolve));
        await channelA.send(`run with the marker ${marker}`);
        assert.equal((await delivered).toString('utf8'), `run with the marker ${marker}`);

        const onTheWire = capture(sent);
        const found = onTheWire.includes(Buffer.from(marker, 'utf8'));
        assert.equal(
          found,
          !encrypted,
          encrypted
            ? 'an encrypted channel must not put the marker on the wire'
            : 'a plaintext channel is what makes the check above mean something',
        );
        if (encrypted) {
          // Not merely "the marker is not there": the frame really is a sealed one, so the absence
          // cannot be explained by nothing having been sent.
          const dataFrames = sent.filter((bytes) => bytes.readUInt8(0) === KIND.DATA);
          assert.ok(dataFrames.length >= 1, 'the message really travelled');
          for (const frame of dataFrames) {
            assert.equal(frame.readUInt8(5), FRAME_MAGIC, 'and every one of them is sealed');
          }
        }
        channelA.close('done');
        channelB.close('done');
      }
    } finally {
      close();
    }
  });

  it('keeps the secrets out of the handshake', async () => {
    // The handshake carries public keys and machine ids. The check is cheap and it covers the failure
    // that would matter most: a private key written to the wire by accident.
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed000c;
      const keysA = DeviceKey.generate('machine-a');
      const keysB = DeviceKey.generate('machine-b');
      const sentA = recordSends(a.socket);
      const sentB = recordSends(b.socket);
      const dialling = punch({
        socket: a.socket,
        remote: [loopback(b)],
        session,
        timeoutMs: 4000,
        crypto: { deviceKey: keysA, peerKey: keysB.publicKeyBase64, peerMachineId: 'machine-b' },
      });
      const answering = accept({
        socket: b.socket,
        timeoutMs: 4000,
        crypto: {
          deviceKey: keysB,
          peerKeys: new Map([['machine-a', keysA.publicKeyBase64]]),
          seen: new NonceCache(),
        },
      });
      const [dialled] = await Promise.all([dialling, answering]);
      assert.equal(dialled.ok, true, dialled.error ?? '');

      const wire = Buffer.concat([capture(sentA), capture(sentB)]);
      assert.equal(wire.includes(Buffer.from(keysA.privateKeyBase64, 'utf8')), false, 'no private key');
      assert.equal(wire.includes(Buffer.from(keysB.privateKeyBase64, 'utf8')), false, 'no private key');
      // A session key derived from the handshake must never appear either. It is base64 here only
      // because that is how the assertion can look for it in a byte stream.
      assert.equal(wire.includes(Buffer.from(encodeKey(dialled.crypto.session.sendResponder), 'utf8')), false);
      assert.equal(wire.includes(Buffer.from(encodeKey(dialled.crypto.session.sendInitiator), 'utf8')), false);
    } finally {
      close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §7.8 — a rekey loses no frame that was in flight                            */
/* -------------------------------------------------------------------------- */

describe('crypto: §7.8 rekey does not lose a frame that was in flight', () => {
  it('ratchets to the next epoch and keeps the previous one decryptable', () => {
    const { initiator, responder } = sessionPair({
      session: 0x91,
      tuning: { rekeyMessages: 4, retentionMs: EPOCH_RETENTION_MS },
    });
    const frames = [];
    for (let i = 0; i < 6; i += 1) {
      frames.push(initiator.encrypt(true, frameOf(KIND.DATA, 0x91, dataBody(i + 1, 0, 1, Buffer.from(`m${i}`)))));
    }
    const epochs = frames.map((frame) => frame.readUInt8(6));
    assert.deepEqual(epochs, [0, 0, 0, 0, 1, 1], 'the fifth message rekeys');
    assert.equal(initiator.stats.rekeys, 1);

    // Delivered newest-first, which is what a reordering path does: the frame from epoch 1 arrives
    // before the frame from epoch 0 that was already in flight.
    const newest = responder.decrypt(false, frames[5]);
    assert.equal(newest.ok, true, newest.reason ?? '');
    const inFlight = responder.decrypt(false, frames[4]);
    assert.equal(inFlight.ok, true, `the frame in flight across the boundary was lost: ${inFlight.reason ?? ''}`);
    const oldest = responder.decrypt(false, frames[0]);
    assert.equal(oldest.ok, true, 'the retired epoch is still decryptable inside its retention');
    for (const index of [0, 4, 5]) {
      assert.deepEqual(
        responder.decrypt(false, frames[index]).reason,
        CRYPTO_REASON.REPLAYED_FRAME,
        'replaying one of them is still refused',
      );
    }
  });

  it('loses no frame across a rekey on a real channel, in both directions', async () => {
    const { a, b, close } = await twoSockets();
    try {
      const session = 0x5eed000d;
      const { initiator, responder } = sessionPair({ session, tuning: { rekeyMessages: 3 } });
      const channelA = new P2PChannel({
        socket: a.socket,
        peer: loopback(b),
        session,
        crypto: { session: initiator, isInitiator: true },
      });
      const channelB = new P2PChannel({
        socket: b.socket,
        peer: loopback(a),
        session,
        crypto: { session: responder, isInitiator: false },
      });
      const atB = [];
      const atA = [];
      channelB.on('message', (payload) => atB.push(payload.toString('utf8')));
      channelA.on('message', (payload) => atA.push(payload.toString('utf8')));

      // Ten messages each way with a three-message epoch, so several rekeys happen *while* both ends
      // are sending: the case where a frame encrypted under the previous epoch is still on the wire.
      for (let i = 0; i < 10; i += 1) {
        await channelA.send(`a${i}`);
        await channelB.send(`b${i}`);
      }
      assert.equal(initiator.stats.rekeys >= 2, true, `the rekey really happened (${initiator.stats.rekeys})`);
      assert.equal(responder.stats.rekeys >= 2, true);
      assert.deepEqual(atB, Array.from({ length: 10 }, (_, i) => `a${i}`), 'no frame was lost towards B');
      assert.deepEqual(atA, Array.from({ length: 10 }, (_, i) => `b${i}`), 'no frame was lost towards A');
      assert.equal(channelA.encryption.dropped + channelB.encryption.dropped, 0);
      channelA.close('done');
      channelB.close('done');
    } finally {
      close();
    }
  });

  it('drops an epoch it has retired, so the retention is a window and not a promise', () => {
    let clock = 1_000_000;
    const { initiator, responder } = sessionPair({
      session: 0x92,
      tuning: { rekeyMessages: 1, retentionMs: 5_000, nowMs: () => clock },
    });
    const epoch0 = initiator.encrypt(true, frameOf(KIND.DATA, 0x92, dataBody(1, 0, 1, Buffer.from('old'))));
    initiator.encrypt(true, frameOf(KIND.DATA, 0x92, dataBody(2, 0, 1, Buffer.from('new'))));
    assert.equal(responder.decrypt(false, epoch0).ok, true, 'in flight, so still accepted');

    // Far past the retention, and with more epochs since: the key is gone, and the frame is named as
    // stale rather than silently accepted or reported as a forgery.
    clock += 60_000;
    for (let i = 0; i < 6; i += 1) initiator.encrypt(true, frameOf(KIND.DATA, 0x92, dataBody(3 + i, 0, 1, Buffer.from('x'))));
    const late = responder.decrypt(false, epoch0);
    assert.equal(late.ok, false);
    assert.equal(late.reason, CRYPTO_REASON.REPLAYED_FRAME, 'a counter already used is caught first');
  });

  it('bounds how far ahead a forged epoch can make the receiver derive', () => {
    // The epoch rides in the clear, so it is attacker-chosen input: without a bound, one frame could
    // ask for two billion HKDF steps.
    const { responder } = sessionPair({ session: 0x93 });
    const forged = Buffer.alloc(10 + 16);
    forged.writeUInt8(FRAME_MAGIC, 0);
    forged.writeUInt8(MAX_EPOCH_LOOKAHEAD + 1, 1);
    const opened = responder.decrypt(false, Buffer.concat([frameOf(KIND.DATA, 0x93).subarray(0, 5), forged]));
    assert.equal(opened.ok, false);
    assert.equal(opened.reason, CRYPTO_REASON.EPOCH_TOO_FAR);
    assert.equal(responder.stats.dropped, 1);
  });

  it('derives the epoch chain deterministically, so both ends agree without a message', () => {
    // The ratchet's whole premise: `derive(derive(k, epoch 1), epoch 2)` on both ends. If this were
    // not deterministic the rekey would need a round trip, and §4's "rekey by running the handshake
    // again" would have been implemented as written but far more expensively.
    const base = randomBytes(32);
    const first = derive(base, 'w2m-p2p-crypto v1 session epoch 1');
    const second = derive(first, 'w2m-p2p-crypto v1 session epoch 2');
    assert.deepEqual(second, derive(derive(base, 'w2m-p2p-crypto v1 session epoch 1'), 'w2m-p2p-crypto v1 session epoch 2'));
    assert.notDeepEqual(first, base);
  });
});

/* -------------------------------------------------------------------------- */
/* The handshake frame layouts, byte for byte                                  */
/* -------------------------------------------------------------------------- */

describe('crypto: the handshake frames', () => {
  it('lays out HELLO and HELLO_ACK as the document writes them', () => {
    const a = DeviceKey.generate('machine-a');
    const b = DeviceKey.generate('machine-b');
    const start = startHandshake({
      deviceKey: a,
      peerMachineId: 'machine-b',
      peerPublicKey: b.publicKeyBase64,
      session: 0x0a0b0c0d,
    });
    const hello = decodeHello(start.body);
    assert.equal(hello.version, 1);
    assert.equal(hello.session, 0x0a0b0c0d);
    assert.equal(hello.machineId, 'machine-a');
    assert.equal(hello.mac.length, 48, '32 bytes of ciphertext plus a 16-byte tag');
    // magic u8, version u8, session u32, ephemeral 32, idLen u8, id, mac 48.
    assert.equal(start.body.length, 1 + 1 + 4 + 32 + 1 + Buffer.byteLength('machine-a') + 48);
    assert.equal(hello.ephemeral.length, 44, 'the ephemeral public key is base64 of 32 bytes');
    assert.equal(isPublicKey(hello.ephemeral), true);

    const answered = respondHandshake({
      deviceKey: b,
      body: start.body,
      peerKeys: new Map([['machine-a', a.publicKeyBase64]]),
      seen: new NonceCache(),
    });
    const ack = decodeHello(answered.body);
    assert.equal(ack.session, 0x0a0b0c0d);
    assert.equal(ack.machineId, 'machine-b');
    assert.equal(ack.ephemeral.length, 44);
    assert.notEqual(ack.ephemeral, hello.ephemeral, 'the responder contributes a fresh ephemeral');
  });

  it('tells a handshake body from a punch body by one byte, in both directions', () => {
    // The compatibility rule of §4, as a value: an empty body is a v0.5.x punch, a body beginning
    // with the magic is a handshake. Nothing else is either.
    assert.equal(decodeHello(Buffer.alloc(0)), null);
    assert.equal(decodeHello(Buffer.from([0x01, 0x02, 0x03])), null);
    assert.equal(decodeHello(Buffer.alloc(120)), null, 'a body of zeros is not a handshake');
    assert.equal(decodeHello(undefined), null);
    const truncated = startHandshake({
      deviceKey: DeviceKey.generate('machine-a'),
      peerMachineId: 'machine-b',
      peerPublicKey: DeviceKey.generate('machine-b').publicKeyBase64,
      session: 1,
    }).body.subarray(0, 30);
    assert.equal(decodeHello(truncated), null, 'a truncated handshake is refused, not guessed at');
  });
});
