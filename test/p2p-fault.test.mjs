/**
 * P2P workstream F2: the reliable channel under a deterministic fault matrix.
 *
 * `docs/REFACTOR-P2-PLAN.md` §1, slice F2. Every case here runs on the seeded,
 * in-memory datagram layer from `test/helpers/fault-udp.mjs` — **no real socket is
 * bound and no network is touched** — and drives the real `P2PChannel` /
 * `connect()` code from `src/agent/p2p.mjs`.
 *
 * The scenario matrix, and what each row asserts:
 *
 * | scenario                              | assertion                                                        |
 * |---------------------------------------|------------------------------------------------------------------|
 * | 0% loss                               | ordered delivery + ACK per fragment/message                      |
 * | 5% loss                               | every payload eventually delivered exactly once, in send order   |
 * | 20% loss                              | same, with a measured loss/retransmission count                  |
 * | in-flight duplication                 | duplicate DATA inside one assembly is idempotent (one delivery)  |
 * | duplicate after completion            | one delivery; the duplicate is acknowledged, counted and dropped |
 * | duplicate of the final fragment       | one delivery and `incoming` returns to 0 (no stale assembly)     |
 * | sustained duplication (every frag ×3) | one delivery; dedupe counters; bounded completed memory          |
 * | completed-id LRU bound                | an evicted id may be re-assembled; memory stays at the bound     |
 * | stale reassembly TTL                  | abandoned assembly swept; `close()` clears the sweep timer       |
 * | 5% loss + duplication                 | every payload delivered exactly once, in order                   |
 * | reorder window                        | fragments reassembled; application order preserved               |
 * | half-close (peer process gone)        | named `P2P_FRAGMENT_UNACKED` within a bounded time, never a hang |
 * | half-close (BYE delivered)            | peer channel closes by name; later sends refuse `P2P_CHANNEL_CLOSED` |
 * | reopen + retry                        | new session resumes; nothing already delivered is replayed       |
 *
 * ## Receiver-side duplicate suppression (P2 F2 follow-up)
 *
 * `P2PChannel` used to de-duplicate fragments only **within one in-flight assembly** (`incoming`
 * keyed by message id) and forgot a message the moment it was assembled. A duplicate DATA datagram
 * arriving **after** its message completed was therefore treated as the first fragment of a
 * brand-new message: a single-fragment message was delivered twice, and a duplicate of the *last*
 * fragment of a multi-fragment message left a permanently incomplete `incoming` entry (there was no
 * reassembly timeout at all). This suite originally pinned that defect in the skipped `TODO(P2-F)`
 * case; the same hole also blocked the plan's "丢包/乱序/重复下消息最终有序 / 重复包幂等"
 * exactly-once reading under duplication.
 *
 * The fix is receiver-side only (`src/agent/p2p.mjs`; no wire-format, ACK/DONE/BYE or retry change):
 * the channel remembers recently completed message ids in a bounded memory
 * (`recentMessageLimit` / `recentMessageTtlMs`, defaults `DEFAULT_RECENT_MESSAGE_LIMIT` = 1024 ids
 * and `DEFAULT_RECENT_MESSAGE_TTL_MS` = 60 s — small entries, oldest completion evicted first). A
 * fragment for a remembered id is acknowledged — the sender may still be waiting on a lost ACK —
 * and dropped, counted in `channel.stats.duplicateFragmentsDropped` / `messagesDeduped`; it never
 * touches `incoming`. Partial assemblies that stop making progress are swept on activity and by a
 * low-frequency, `unref()`ed timer, counted in `channel.stats.staleAssembliesSwept`, so a
 * fragmented message whose tail never arrives cannot occupy memory forever. The cases below assert
 * the exactly-once reading and the documented bounds — including that an **evicted** completed id is
 * allowed to be re-assembled again: bounded memory is deliberate, unbounded dedupe memory is not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECENT_MESSAGE_LIMIT,
  DEFAULT_RECENT_MESSAGE_TTL_MS,
  KIND,
  MAX_FRAGMENT_PAYLOAD,
  P2PChannel,
  connect,
} from '../src/agent/p2p.mjs';
import { createFaultUdp, createFaultUdpPair } from './helpers/fault-udp.mjs';

/**
 * `RttEstimator` floors the RTO at 100 ms, so `rtoMs: 10` here really means
 * "100 ms first retransmit, 200 ms next, …" — the floor is a product decision, not
 * something this suite may bypass. `maxAttempts` stays small so a disappeared peer
 * is declared dead in well under a second.
 */
const SESSION_OPEN = 0x5eed0101;
const SESSION_REOPEN = 0x5eed0102;
const TUNING = { rtoMs: 10, maxAttempts: 6, window: 8 };
const LOSSY_TUNING = { rtoMs: 10, maxAttempts: 40, window: 8 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic payload of `fragments` fragments with a recognisable tag per byte. */
function payload(fragments, tag) {
  const size = fragments * MAX_FRAGMENT_PAYLOAD + (tag % 97) + 1;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 31 + tag) & 0xff;
  return buf;
}

const fragmentCount = (buf) => Math.max(1, Math.ceil(buf.length / MAX_FRAGMENT_PAYLOAD));

/** One channel pair over an already-created fault pair. Closed together. */
function channelPair(net, { session = SESSION_OPEN, tuning = TUNING, channelOptions = {} } = {}) {
  const a = new P2PChannel({ socket: net.a, peer: net.peers.b, session, tuning, ...channelOptions });
  const b = new P2PChannel({ socket: net.b, peer: net.peers.a, session, tuning, ...channelOptions });
  return { a, b, close: () => { try { a.close('test-done'); } catch { /* closed */ } try { b.close('test-done'); } catch { /* closed */ } } };
}

/** Collect application deliveries, in order. */
function collect(channel) {
  const seen = [];
  channel.on('message', (buf) => seen.push(Buffer.from(buf)));
  return seen;
}

/** One big-endian u32, for building frames by hand. */
function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}

/**
 * Build one plaintext DATA frame exactly as `P2PChannel.send()` would.
 *
 * The stale-reassembly case needs an assembly that is deliberately left incomplete: replaying a
 * hand-built fragment through the fault layer is the only way to plant one without a send-side
 * channel and without a fault plan that happens to drop a fragment — both of which would make the
 * scenario depend on timing rather than on the TTL.
 */
function dataFrame(session, messageId, index, total, payloadBuf) {
  return Buffer.concat([Buffer.from([KIND.DATA]), u32(session), u32(messageId), u32(index), u32(total), payloadBuf]);
}

/**
 * Decode the frames this endpoint *receives* (before the channel consumes them:
 * EventEmitter delivers to every listener). Plaintext framing only, which is what
 * this suite uses — `session` at bytes 1..4, then the kind-specific body.
 */
function recordFrames(endpoint) {
  const frames = [];
  endpoint.on('message', (buf) => {
    if (buf.length < 5) {
      frames.push({ kind: -1, messageId: null, index: null });
      return;
    }
    frames.push({
      kind: buf.readUInt8(0),
      messageId: buf.length >= 9 ? buf.readUInt32BE(5) : null,
      index: buf.length >= 13 ? buf.readUInt32BE(9) : null,
    });
  });
  return frames;
}

/** Assert `seen` equals `expected` byte-for-byte and in order, naming the first mismatch. */
function assertDeliveredInOrder(seen, expected, context) {
  assert.equal(
    seen.length,
    expected.length,
    `${context}: expected ${expected.length} application deliveries, got ${seen.length} ` +
      `(lengths=${JSON.stringify(seen.map((m) => m.length))})`,
  );
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(
      seen[i].length,
      expected[i].length,
      `${context}: delivery ${i}: expected ${expected[i].length} bytes, got ${seen[i].length}`,
    );
    assert.ok(
      seen[i].equals(expected[i]),
      `${context}: delivery ${i} byte mismatch (expected tag ${(i * 37) % 251}, first diff at ` +
        `${firstDifference(seen[i], expected[i])})`,
    );
  }
}

function firstDifference(left, right) {
  const max = Math.min(left.length, right.length);
  for (let i = 0; i < max; i += 1) if (left[i] !== right[i]) return i;
  return max;
}

const ackMessageIds = (frames) => [...new Set(frames.filter((f) => f.kind === KIND.ACK)
  .map((f) => f.messageId))].sort((left, right) => left - right);

/* ================================================================== */
/* F1: the fault layer itself                                          */
/* ================================================================== */

describe('fault-udp: seeded datagram layer (F1)', () => {
  /**
   * One scripted scenario, run entirely on the virtual clock: 24 datagrams from A to
   * B with 30% loss, 20% duplication and a reorder window. Returns the delivery order
   * as seen by B plus the counters, so two identical seeds can be compared exactly.
   */
  function runScenario(seed) {
    const net = createFaultUdpPair({
      seed,
      dropRate: 0.3,
      duplicateRate: 0.2,
      reorderWindow: 5,
      reorderRate: 0.4,
      latencyMs: 3,
    });
    const delivered = [];
    net.b.on('message', (buf) => delivered.push(buf.readUInt16BE(0)));
    try {
      for (let i = 0; i < 24; i += 1) {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(i, 0);
        net.a.send(buf, net.peers.b);
      }
      // Advance past latency + reorder window + duplicate delay so everything due lands.
      net.tick(30);
      return { delivered, stats: net.stats(), scheduled: net.network.schedule.length };
    } finally {
      net.close();
    }
  }

  it('same seed ⇒ byte-identical delivery order and injection counters', () => {
    const first = runScenario(7);
    const second = runScenario(7);
    assert.deepEqual(
      second.delivered,
      first.delivered,
      `same seed must deliver the same sequence, got ${JSON.stringify(second.delivered)} ` +
        `vs ${JSON.stringify(first.delivered)}`,
    );
    assert.deepEqual(second.stats, first.stats, 'same seed must make the same fault decisions');
    assert.equal(first.scheduled, 0, 'the queue must be empty after a full flush');
    // Guard against a silently inert scenario: this seed must exercise loss and duplication.
    assert.ok(first.stats.dropped > 0, `expected drops for seed 7, got ${JSON.stringify(first.stats)}`);
    assert.ok(first.stats.duplicated > 0, `expected duplicates for seed 7, got ${JSON.stringify(first.stats)}`);
    assert.ok(first.stats.reordered > 0, `expected reorders for seed 7, got ${JSON.stringify(first.stats)}`);
  });

  it('a different seed plans different faults (the seed is load-bearing)', () => {
    const seven = runScenario(7);
    const eight = runScenario(8);
    assert.notDeepEqual(eight.stats, seven.stats, 'seeds 7 and 8 must not produce identical plans');
  });

  it('explicit drop/duplicate/reorder triggers are exact and counted', () => {
    const net = createFaultUdpPair({ seed: 1, maxScheduled: 100 });
    const delivered = [];
    net.b.on('message', (buf) => delivered.push(buf.readUInt8(0)));
    net.network.drop(2);
    net.network.duplicate(3);
    net.network.reorder(4, 5);
    try {
      for (let i = 1; i <= 5; i += 1) net.a.send(Buffer.from([i]), net.peers.b);
      // #2 dropped; #3 has its copy queued too; #4/#5 are both staged (one delayed by reorder()).
      assert.equal(net.pending(), 5, 'four surviving originals plus the duplicate copy must be queued');
      net.flush();
      // #2 dropped; #5 delivered before #4 (reorder pushes #4 one tick later); #3's copy
      // arrives duplicateDelayMs later.
      assert.deepEqual(delivered, [1, 3, 5], 'the dropped and reordered datagrams must be scheduled exactly');
      net.tick(1);
      assert.deepEqual(delivered, [1, 3, 5, 4], 'the reordered datagram must arrive after its partner');
      net.tick(5);
      assert.deepEqual(delivered, [1, 3, 5, 4, 3], 'the duplicate copy must arrive after the original');
      const stats = net.stats();
      assert.equal(stats.sent, 5);
      assert.equal(stats.dropped, 1, 'one explicit drop');
      assert.equal(stats.explicitDropped, 1);
      assert.equal(stats.duplicated, 1, 'one explicit duplicate');
      assert.equal(stats.explicitDuplicated, 1);
      assert.equal(stats.reordered, 1, 'one explicit reorder');
      assert.equal(stats.explicitReordered, 1);
      assert.equal(stats.delivered, 5);
      assert.equal(stats.pending, 0);
    } finally {
      net.close();
    }
  });

  it('delivers only when due, and drains the queue instead of growing it', () => {
    const net = createFaultUdpPair({ seed: 3, latencyMs: 10, maxScheduled: 2000 });
    const delivered = [];
    net.b.on('message', (buf) => delivered.push(buf.readUInt16BE(0)));
    try {
      for (let i = 0; i < 100; i += 1) {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(i, 0);
        net.a.send(buf, net.peers.b);
      }
      assert.equal(net.pending(), 100, 'all 100 datagrams must be waiting for their latency');
      assert.equal(net.flush(), 0, 'nothing is due before latencyMs elapses');
      assert.equal(delivered.length, 0);
      assert.equal(net.advance(10), 10);
      assert.equal(net.flush(), 100);
      assert.deepEqual(delivered, [...Array(100).keys()], 'latency preserves the send order');
      assert.equal(net.pending(), 0, 'the schedule must be empty after the drain');
      assert.equal(net.stats().delivered, 100);
    } finally {
      net.close();
    }
  });

  it('fails loudly instead of queueing without bound', () => {
    const net = createFaultUdpPair({ seed: 5, latencyMs: 1000, maxScheduled: 3 });
    try {
      for (let i = 0; i < 3; i += 1) net.a.send(Buffer.from([i]), net.peers.b);
      assert.throws(
        () => net.a.send(Buffer.from([99]), net.peers.b),
        /FAULT_UDP_QUEUE_OVERFLOW: 3 datagrams staged/,
        'the 4th staged datagram must overflow the bounded queue',
      );
    } finally {
      net.close();
    }
  });

  it('a silent peer loses datagrams immediately rather than holding them', () => {
    const net = createFaultUdpPair({ seed: 6, latencyMs: 0 });
    net.b.goSilent();
    try {
      net.a.send(Buffer.from('gone'), net.peers.b);
      assert.equal(net.flush(), 0, 'a silent peer must not receive anything');
      assert.equal(net.pending(), 0, 'nothing may stay queued for a peer that is not there');
      assert.equal(net.stats().unroutable, 1);
      assert.equal(net.stats().delivered, 0);
      net.b.resume();
      net.a.send(Buffer.from('back'), net.peers.b);
      net.flush();
      assert.equal(net.stats().delivered, 1, 'resume() makes the peer reachable again');
    } finally {
      net.close();
    }
  });

  it('wraps an injected base socket for egress fault injection', () => {
    const baseSent = [];
    const baseSocket = {
      sent: baseSent,
      on() {},
      removeListener() {},
      send(buf, port, address, cb) {
        baseSent.push({ text: buf.toString(), port, address });
        if (typeof cb === 'function') cb(null);
      },
      address: () => ({ address: '127.0.0.1', port: 5100 }),
    };
    const endpoint = createFaultUdp({ baseSocket, seed: 11 });
    try {
      endpoint.drop(1);
      endpoint.send(Buffer.from('first'), { address: '127.0.0.1', port: 5101 });
      endpoint.send(Buffer.from('second'), { address: '127.0.0.1', port: 5101 });
      endpoint.network.flush();
      assert.deepEqual(
        baseSent.map((entry) => entry.text),
        ['second'],
        'the explicit drop must happen before the base socket sees the datagram',
      );
      assert.equal(endpoint.network.stats().delivered, 1);
      assert.equal(endpoint.local.port, 5100, 'the wrapper reports the base socket address');
    } finally {
      endpoint.close();
    }
  });
});

/* ================================================================== */
/* F2: the reliable channel                                            */
/* ================================================================== */

describe('p2p-fault: zero loss is the ACK path (baseline)', () => {
  it('delivers every message in send order and acknowledges every message id', async () => {
    const net = createFaultUdpPair({ seed: 101, now: () => Date.now(), autopumpMs: 1 });
    const channels = channelPair(net);
    const seen = collect(channels.b);
    const senderFrames = recordFrames(net.a);
    const payloads = [payload(1, 1), payload(3, 2), payload(5, 3)];
    try {
      for (let i = 0; i < payloads.length; i += 1) {
        try {
          await channels.a.send(payloads[i]);
        } catch (error) {
          assert.fail(
            `zero-loss send of message ${i + 1} failed unexpectedly: ${error.message} ` +
              `(frames so far: ${JSON.stringify(senderFrames.map((f) => f.kind))})`,
          );
        }
      }
      assertDeliveredInOrder(seen, payloads, 'zero-loss');
      const acks = ackMessageIds(senderFrames);
      assert.deepEqual(acks, [1, 2, 3], `expected ACK for message ids 1,2,3; got ${JSON.stringify(acks)}`);
      const expectedAcks = payloads.reduce((sum, buf) => sum + fragmentCount(buf), 0);
      assert.ok(
        senderFrames.filter((frame) => frame.kind === KIND.ACK).length >= expectedAcks,
        `expected at least ${expectedAcks} ACK frames (one per fragment), got ` +
          `${senderFrames.filter((frame) => frame.kind === KIND.ACK).length}`,
      );
      const stats = net.stats();
      assert.equal(stats.dropped, 0, 'a zero-loss plan must not drop anything');
      assert.equal(stats.duplicated, 0, 'a zero-loss plan must not duplicate anything');
      assert.equal(stats.delivered, stats.sent, 'every staged datagram must be delivered');
    } finally {
      channels.close();
      net.close();
    }
  });
});

describe('p2p-fault: loss matrix (exactly-once, ordered)', () => {
  async function runLossScenario({ seed, dropRate }) {
    const net = createFaultUdpPair({
      seed,
      dropRate,
      now: () => Date.now(),
      autopumpMs: 1,
    });
    const channels = channelPair(net, { tuning: LOSSY_TUNING });
    const seen = collect(channels.b);
    const payloads = [payload(2, 11), payload(3, 12), payload(1, 13), payload(4, 14)];
    try {
      for (let i = 0; i < payloads.length; i += 1) {
        await channels.a.send(payloads[i]); // resolves only when every fragment is ACKed
      }
      // Late duplicates/retransmissions must not add a delivery after the ACK.
      await sleep(80);
      assertDeliveredInOrder(seen, payloads, `${dropRate * 100}% loss (seed ${seed})`);
      const stats = net.stats();
      assert.ok(stats.dropped > 0, `the ${dropRate * 100}% plan must actually drop (seed ${seed}), got ${JSON.stringify(stats)}`);
      const stagedFragments = payloads.reduce((sum, buf) => sum + fragmentCount(buf), 0);
      assert.ok(
        stats.sent > stagedFragments,
        `a lost fragment must be retransmitted: expected more than ${stagedFragments} datagrams, got ${stats.sent}`,
      );
      assert.equal(stats.sent, stats.dropped + stats.delivered, 'every staged datagram is either lost or delivered');
      return stats;
    } finally {
      channels.close();
      net.close();
    }
  }

  it('5% loss: every payload arrives exactly once and in order', async () => {
    const stats = await runLossScenario({ seed: 101, dropRate: 0.05 });
    assert.ok(stats.delivered > 0, `expected the 5% loss run to deliver datagrams, got ${JSON.stringify(stats)}`);
  });

  it('20% loss: every payload arrives exactly once and in order', async () => {
    const stats = await runLossScenario({ seed: 101, dropRate: 0.2 });
    assert.ok(stats.dropped >= 2, `a 20% plan should lose more than one datagram, got ${stats.dropped}`);
  });
});

describe('p2p-fault: duplication', () => {
  it('de-duplicates duplicate fragments while the message is still being assembled', async () => {
    const net = createFaultUdpPair({ seed: 201, now: () => Date.now(), autopumpMs: 1 });
    // A one-fragment window spreads 21 fragments over many ACK round trips, so the
    // duplicates (delayed by `duplicateDelayMs`) provably land while the assembly is
    // still incomplete: this is the in-flight case the protocol already de-duplicated.
    const channels = channelPair(net, { tuning: { ...TUNING, window: 1 } });
    const seen = collect(channels.b);
    // With a one-fragment window the first datagrams are #1 DATA fragment 0, #2 its ACK and
    // #3 DATA fragment 1, so ordinals 1 and 3 duplicate DATA while the 21-fragment message is
    // still being assembled.
    net.network.duplicate(1);
    net.network.duplicate(2);
    net.network.duplicate(3);
    const message = payload(20, 21);
    try {
      await channels.a.send(message);
      await sleep(80);
      assertDeliveredInOrder(seen, [message], 'in-flight duplicate');
      assert.ok(net.stats().duplicated >= 3, `expected at least 3 injected duplicates, got ${net.stats().duplicated}`);
      assert.equal(channels.b.incoming.size, 0, 'a duplicate of an already-received fragment must not start a second assembly');
      assert.equal(
        channels.b.stats.duplicateFragmentsDropped,
        0,
        'in-flight duplicates stay handled by the `received` set; they must not be counted as completed-message dedupe',
      );
    } finally {
      channels.close();
      net.close();
    }
  });

  it('a duplicate arriving after assembly must not be re-delivered', async () => {
    // The original `TODO(P2-F)` reproduction, now asserted green:
    //   1. duplicate the first DATA datagram of a single-fragment message;
    //   2. `send()` resolves on the first copy's ACK;
    //   3. the delayed copy arrives after `incoming` was cleared, so before the fix the
    //      receiver assembled it as a NEW message and emitted a second delivery.
    const net = createFaultUdpPair({ seed: 211, now: () => Date.now(), autopumpMs: 1 });
    const channels = channelPair(net);
    const seen = collect(channels.b);
    net.network.duplicate(1);
    try {
      await channels.a.send('only-once');
      await sleep(120);
      assertDeliveredInOrder(seen, [Buffer.from('only-once')], 'duplicate after assembly');
      assert.equal(
        channels.b.recentMessageLimit,
        DEFAULT_RECENT_MESSAGE_LIMIT,
        'the completed-message memory must default to the documented bound',
      );
      assert.equal(
        channels.b.recentMessageTtlMs,
        DEFAULT_RECENT_MESSAGE_TTL_MS,
        'the completed-message TTL must default to the documented value',
      );
      assert.equal(channels.b.incoming.size, 0, 'the duplicate must not leave an assembly behind');
      assert.equal(channels.b.completed.size, 1, 'the completed message id must be remembered');
      assert.equal(channels.b.stats.duplicateFragmentsDropped, 1, 'the duplicate fragment must be counted, not silent');
      assert.equal(channels.b.stats.messagesDeduped, 1, 'the message must be counted once as saved from re-delivery');
    } finally {
      channels.close();
      net.close();
    }
  });

  it('a duplicate of the final fragment is delivered once and leaves no stale assembly', async () => {
    // Repro B from the F-slice report: before the fix a duplicate of the *last* fragment
    // started a new `incoming` entry holding one fragment of three, with no reassembly timeout,
    // so `incoming.size` never returned to 0.
    const net = createFaultUdpPair({ seed: 212, now: () => Date.now(), autopumpMs: 1 });
    // Wide enough that all three DATA datagrams leave in the first pump: ordinals 1, 2, 3 are
    // fragments 0, 1, 2, so duplicating ordinal 3 duplicates exactly the final fragment.
    const channels = channelPair(net, { tuning: { ...TUNING, window: 8 } });
    const seen = collect(channels.b);
    net.network.duplicate(3);
    const message = payload(2, 22); // three fragments
    try {
      assert.equal(fragmentCount(message), 3, 'the scenario needs an exactly three-fragment message');
      await channels.a.send(message);
      await sleep(120);
      assertDeliveredInOrder(seen, [message], 'duplicate of the final fragment');
      assert.equal(
        channels.b.incoming.size,
        0,
        'the duplicate of the final fragment must not leave a permanently incomplete assembly',
      );
      assert.equal(channels.b.stats.duplicateFragmentsDropped, 1);
      assert.equal(channels.b.stats.messagesDeduped, 1);
    } finally {
      channels.close();
      net.close();
    }
  });

  it('still acknowledges a retransmission that arrives after completion, so the send succeeds', async () => {
    // Duplicate suppression must not swallow the ACK: a retransmitted DATA datagram is exactly
    // what a lost ACK produces, and staying silent would make the sender exhaust `maxAttempts`
    // and fail a send the peer actually received. Dropping ordinal 2 (the ACK for the single
    // fragment) forces that retransmission deterministically.
    const net = createFaultUdpPair({ seed: 213, now: () => Date.now(), autopumpMs: 1 });
    const channels = channelPair(net);
    const seen = collect(channels.b);
    net.network.drop(2); // the ACK for DATA fragment 0 is lost
    try {
      await channels.a.send('ack-again');
      await sleep(80);
      assertDeliveredInOrder(seen, [Buffer.from('ack-again')], 'retransmission after completion');
      assert.ok(
        channels.b.stats.duplicateFragmentsDropped >= 1,
        'the retransmission must be recognized as a duplicate of a completed message',
      );
      assert.equal(net.stats().dropped, 1, 'exactly the injected ACK must have been lost');
      assert.equal(channels.b.incoming.size, 0, 'the retransmitted fragment must not start an assembly');
    } finally {
      channels.close();
      net.close();
    }
  });

  it('drops sustained duplicates of every fragment after completion, with bounded memory', async () => {
    const net = createFaultUdpPair({ seed: 214, now: () => Date.now(), autopumpMs: 1 });
    const channels = channelPair(net, { tuning: { ...TUNING, window: 8 } });
    const seen = collect(channels.b);
    // Capture the DATA datagrams the receiver actually got, then replay each of them three times
    // through the fault layer. That is an exact "duplicate every fragment ×3" fault, without
    // relying on a seeded rate to happen to hit every fragment.
    const captured = [];
    let capture = true;
    net.b.on('message', (buf) => {
      if (capture && buf.length > 5 && buf.readUInt8(0) === KIND.DATA) captured.push(Buffer.from(buf));
    });
    const message = payload(4, 23); // five fragments
    try {
      await channels.a.send(message);
      await sleep(60);
      capture = false;
      const dataFrames = captured.slice();
      assert.equal(
        dataFrames.length,
        fragmentCount(message),
        'the send must produce exactly one DATA datagram per fragment before the replay',
      );
      for (let copy = 0; copy < 3; copy += 1) {
        for (const datagram of dataFrames) net.a.send(datagram, net.peers.b);
      }
      net.flush();
      await sleep(120);
      assertDeliveredInOrder(seen, [message], 'sustained duplication');
      assert.equal(
        channels.b.stats.duplicateFragmentsDropped,
        3 * dataFrames.length,
        'every replayed fragment must be acknowledged and dropped',
      );
      assert.equal(channels.b.stats.messagesDeduped, 1, 'one message saved from re-delivery, not one per fragment');
      assert.equal(channels.b.incoming.size, 0, 'replayed fragments must not start a fresh assembly');
      assert.ok(
        channels.b.completed.size <= 1,
        `the completed-message memory must stay bounded, got ${channels.b.completed.size}`,
      );
    } finally {
      channels.close();
      net.close();
    }
  });

  it('with a tiny recentMessageLimit an evicted id may be assembled again; memory stays bounded', async () => {
    // The documented bound, not an oversight: once a completion is evicted, a late duplicate of
    // that id is a new message again. Bounded memory is the trade; unbounded dedupe memory is not.
    const net = createFaultUdpPair({ seed: 215, now: () => Date.now(), autopumpMs: 1, duplicateDelayMs: 250 });
    const channels = channelPair(net, { channelOptions: { recentMessageLimit: 2 } });
    const seen = collect(channels.b);
    net.network.duplicate(1); // the first DATA datagram: m1's only fragment, copied 250 ms later
    try {
      await channels.a.send('m1');
      await channels.a.send('m2');
      await channels.a.send('m3');
      assert.equal(channels.b.completed.size, 2, 'the completed-message memory must obey recentMessageLimit');
      assert.equal(channels.b.recentMessageLimit, 2);
      await sleep(600);
      assert.equal(
        seen.length,
        4,
        'the duplicate of the evicted id must be reassembled (documented bound), and nothing else may be re-delivered',
      );
      assert.ok(seen[3].equals(Buffer.from('m1')), `the fourth delivery must be the evicted duplicate, got ${seen[3]}`);
      assert.equal(
        channels.b.stats.duplicateFragmentsDropped,
        0,
        'an evicted id is not deduplicated — the counter documents the bound instead of hiding it',
      );
      assert.equal(channels.b.completed.size, 2, 're-completing the evicted id must keep the memory at the bound');
      assert.equal(channels.b.incoming.size, 0);
    } finally {
      channels.close();
      net.close();
    }
  });

  it('5% loss + duplication: every payload arrives exactly once and in order', async () => {
    // With both halves of the fix in place, duplicates inside an assembly are idempotent *and*
    // duplicates after assembly are suppressed, so the loss/dup matrix now asserts the plan's
    // exactly-once reading rather than "intact on first delivery".
    const net = createFaultUdpPair({
      seed: 181,
      dropRate: 0.05,
      duplicateRate: 0.1,
      now: () => Date.now(),
      autopumpMs: 1,
    });
    const channels = channelPair(net, { tuning: LOSSY_TUNING });
    const seen = collect(channels.b);
    const payloads = [payload(2, 31), payload(2, 32), payload(3, 33)];
    try {
      for (const message of payloads) await channels.a.send(message);
      await sleep(150);
      assertDeliveredInOrder(seen, payloads, '5% loss + duplication');
      assert.equal(channels.b.incoming.size, 0, 'no duplicate may leave an assembly behind');
      const stats = net.stats();
      assert.ok(stats.dropped > 0, `expected injected loss, got ${JSON.stringify(stats)}`);
      assert.ok(stats.duplicated > 0, `expected injected duplication, got ${JSON.stringify(stats)}`);
    } finally {
      channels.close();
      net.close();
    }
  });
});

describe('p2p-fault: stale reassembly TTL', () => {
  it('sweeps an assembly that stops progressing, and close() clears the sweep timer', async () => {
    const TTL_MS = 150;
    const net = createFaultUdpPair({ seed: 216, now: () => Date.now(), autopumpMs: 1 });
    const channels = channelPair(net, { channelOptions: { recentMessageTtlMs: TTL_MS } });
    try {
      // Plant an incomplete three-fragment assembly by delivering only fragment 0: no send-side
      // channel can produce "a fragment that never completes" without depending on fault timing.
      net.a.send(dataFrame(SESSION_OPEN, 0, 0, 3, Buffer.from('stalled-0')), net.peers.b);
      net.flush();
      await sleep(20);
      assert.equal(channels.b.incoming.size, 1, 'the partial assembly must be tracked first');
      assert.equal(
        channels.b.sweepTimer.hasRef(),
        false,
        'the low-frequency sweep timer must be unref()ed so a quiet receiver cannot hold the process open',
      );

      // Nothing sends another fragment, so only the timer can clean up: the assembly is abandoned
      // once it has gone a full TTL without progress.
      await sleep(TTL_MS + 200);
      assert.equal(channels.b.incoming.size, 0, 'a stale assembly must be swept once it is past the TTL');
      assert.ok(
        channels.b.stats.staleAssembliesSwept >= 1,
        `the sweep must be counted, got ${channels.b.stats.staleAssembliesSwept}`,
      );

      // A late fragment may start a *fresh* assembly (the message never completed, so its id is not
      // in the completed memory), but the swept fragments must not be resurrected.
      net.a.send(dataFrame(SESSION_OPEN, 0, 1, 3, Buffer.from('stalled-1')), net.peers.b);
      net.flush();
      await sleep(20);
      const fresh = channels.b.incoming.get(0);
      assert.ok(fresh !== undefined, 'a late fragment must be able to start a fresh assembly');
      assert.deepEqual(
        [...fresh.received],
        [1],
        'only the late fragment may be present: the swept fragment 0 must not come back',
      );
    } finally {
      channels.close();
      assert.equal(channels.b.sweepTimer, null, 'close() must clear the stale-assembly sweep timer');
      assert.equal(channels.a.sweepTimer, null, 'close() must clear the sweep timer on both ends');
      net.close();
    }
  });
});

describe('p2p-fault: reordering', () => {
  it('reassembles a reordered message and preserves application order', async () => {
    const net = createFaultUdpPair({
      seed: 301,
      latencyMs: 2,
      reorderWindow: 25,
      reorderRate: 0.5,
      now: () => Date.now(),
      autopumpMs: 1,
    });
    const channels = channelPair(net);
    const seen = collect(channels.b);
    // Force the first message's fragments 1 and 2 out of order too, deterministically;
    // the rest are reordered by the seeded plan.
    net.network.reorder(1, 2);
    const payloads = [payload(4, 41), payload(3, 42), payload(2, 43)];
    try {
      for (const message of payloads) await channels.a.send(message);
      await sleep(150);
      assertDeliveredInOrder(seen, payloads, 'reorder window');
      assert.ok(
        net.stats().reordered > 0,
        `the reorder scenario must inject reordering, got ${JSON.stringify(net.stats())}`,
      );
    } finally {
      channels.close();
      net.close();
    }
  });
});

describe('p2p-fault: half-close and disappearance', () => {
  it('a peer that vanishes fails by name within a bounded time instead of hanging', async () => {
    const net = createFaultUdpPair({ seed: 401, now: () => Date.now(), autopumpMs: 1 });
    const channels = channelPair(net, { tuning: { rtoMs: 10, maxAttempts: 2, window: 8 } });
    const message = Buffer.from('nobody-home'); // one fragment: the refusal names fragment 0/1
    net.b.goSilent();
    const started = Date.now();
    try {
      await assert.rejects(
        () => channels.a.send(message),
        (error) => {
          assert.match(
            error.message,
            /^P2P_FRAGMENT_UNACKED: fragment 0\/1 of message 1 after 2 attempts$/,
            `expected the refusal to name fragment 0/1 of message 1, got: ${error.message}`,
          );
          return true;
        },
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 4000, `a vanished peer must be declared dead well under 4s; took ${elapsed}ms`);
      assert.equal(net.pending(), 0, 'no datagram may be left queued after the refusal');
    } finally {
      channels.close();
      net.close();
    }
  });

  it('a delivered BYE closes the peer channel and later sends refuse by name', async () => {
    const net = createFaultUdpPair({ seed: 402, now: () => Date.now(), autopumpMs: 1 });
    const channels = channelPair(net);
    const seen = collect(channels.b);
    try {
      await channels.a.send('before-the-bye');
      const closed = new Promise((resolve) => channels.b.once('close', resolve));
      channels.a.close('attempt-complete');
      const reason = await Promise.race([
        closed,
        sleep(3000).then(() => 'TIMEOUT'),
      ]);
      assert.equal(reason, 'peer-closed', 'the peer must learn the session is over from the BYE, not time out');
      assert.equal(channels.b.closed, true);
      assertDeliveredInOrder(seen, [Buffer.from('before-the-bye')], 'before BYE');
      await assert.rejects(
        () => channels.b.send('after-the-bye'),
        (error) => {
          assert.match(error.message, /^P2P_CHANNEL_CLOSED/, `expected P2P_CHANNEL_CLOSED, got: ${error.message}`);
          return true;
        },
      );
    } finally {
      channels.close();
      net.close();
    }
  });
});

describe('p2p-fault: reopen and retry', () => {
  it('reopening on a fresh session never replays an already delivered message', async () => {
    const net = createFaultUdpPair({ seed: 501, now: () => Date.now(), autopumpMs: 1 });
    const first = channelPair(net, { session: SESSION_OPEN, tuning: { rtoMs: 10, maxAttempts: 3, window: 8 } });
    const firstSeen = collect(first.b);
    try {
      await first.a.send('m1');
      await first.a.send('m2');
      assertDeliveredInOrder(firstSeen, [Buffer.from('m1'), Buffer.from('m2')], 'first session');

      first.a.close('attempt-complete');
      first.b.close('attempt-complete');
      // Let the BYE cross the fault layer before the new session's channels exist: a stale
      // BYE must not be able to tear down a live reopened channel.
      await sleep(100);

      const reopened = channelPair(net, { session: SESSION_REOPEN, tuning: { rtoMs: 10, maxAttempts: 3, window: 8 } });
      const reopenedSeen = collect(reopened.b);
      try {
        await reopened.a.send('m3');
        await sleep(80);
        assertDeliveredInOrder(reopenedSeen, [Buffer.from('m3')], 'reopened session');
        assert.equal(firstSeen.length, 2, 'the old session must not re-deliver anything after reopen');
      } finally {
        reopened.close();
      }
    } finally {
      first.close();
      net.close();
    }
  });

  it('retrying after a transient disappearance delivers the payload exactly once', async () => {
    const net = createFaultUdpPair({ seed: 502, now: () => Date.now(), autopumpMs: 1 });
    const channels = channelPair(net, { tuning: { rtoMs: 10, maxAttempts: 2, window: 8 } });
    const seen = collect(channels.b);
    try {
      await channels.a.send('first');
      net.b.goSilent();
      await assert.rejects(
        () => channels.a.send('retry-me'),
        /P2P_FRAGMENT_UNACKED/,
        'the transient outage must fail the send by name before the retry',
      );
      net.b.resume();
      await channels.a.send('retry-me');
      await sleep(80);
      assertDeliveredInOrder(seen, [Buffer.from('first'), Buffer.from('retry-me')], 'retry after resume');
    } finally {
      channels.close();
      net.close();
    }
  });
});

describe('p2p-fault: connect() over the fault layer', () => {
  it('punches and carries a message with no real socket bound', async () => {
    const net = createFaultUdpPair({ seed: 601, now: () => Date.now(), autopumpMs: 1 });
    try {
      const [left, right] = await Promise.all([
        connect({ socket: net.a, remote: [net.peers.b], timeoutMs: 5000, session: 0x5eed0601 }),
        connect({ socket: net.b, remote: [net.peers.a], timeoutMs: 5000, session: 0x5eed0601 }),
      ]);
      assert.equal(left.ok, true, `left punch failed: ${left.error ?? ''}`);
      assert.equal(right.ok, true, `right punch failed: ${right.error ?? ''}`);
      assert.ok(left.channel !== null, `left connect() must return a channel, got ok=${left.ok} error=${left.error ?? ''}`);
      assert.ok(right.channel !== null, `right connect() must return a channel, got ok=${right.ok} error=${right.error ?? ''}`);
      try {
        const received = new Promise((resolve) => right.channel.once('message', resolve));
        await left.channel.send('over the injected path');
        assert.equal((await received).toString('utf8'), 'over the injected path');
      } finally {
        left.channel.close('test-done');
        right.channel.close('test-done');
      }
    } finally {
      net.close();
    }
  });
});
