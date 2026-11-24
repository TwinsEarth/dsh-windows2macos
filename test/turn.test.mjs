/**
 * Turns derived from messages: ordering comes from the relay's number, never from the arrival order of a page.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTurns } from '../src/plugin/turn.mjs';
import {
  buildIceServersForPeer,
  describeTurnServers,
  normalizeTurnServers,
  orderTurnServersForPair,
  redactTurnUrl,
  turnPairKey,
} from '../src/agent/webrtc/turn-pool.mjs';

describe('deriveTurns', () => {
  it('groups messages by thread and then by turn', () => {
    const derived = deriveTurns([
      { message_id: 'a', thread_id: 't1', turn: 1 },
      { message_id: 'b', thread_id: 't1', turn: 2 },
      { message_id: 'c', thread_id: 't1', turn: 2 },
    ]);
    assert.equal(derived.threads.length, 1);
    assert.deepEqual(derived.threads[0].turns.map((turn) => turn.turn), [1, 2]);
    assert.equal(derived.threads[0].turns[1].messages.length, 2);
  });

  it('keeps ungrouped messages in their own thread', () => {
    const derived = deriveTurns([{ message_id: 'a' }, { message_id: 'b', thread_id: 't1', turn: 1 }]);
    const ids = derived.threads.map((thread) => thread.thread_id);
    assert.deepEqual(ids.sort(), [null, 't1'].sort());
  });

  it('orders turns by the relay number even when the page arrives out of order', () => {
    const derived = deriveTurns([
      { message_id: 'b', thread_id: 't1', turn: 2 },
      { message_id: 'a', thread_id: 't1', turn: 1 },
    ]);
    assert.deepEqual(derived.threads[0].turns.map((turn) => turn.message_id ?? turn.messages[0].message_id), ['a', 'b']);
  });

  it('gives a message without a turn the previous turn, and counts that it guessed', () => {
    const derived = deriveTurns([
      { message_id: 'a', thread_id: 't1', turn: 3 },
      { message_id: 'b', thread_id: 't1' },
      { message_id: 'c', thread_id: 't2' },
    ]);
    assert.equal(derived.inferred_turns, 2);
    assert.equal(derived.threads.find((thread) => thread.thread_id === 't1').turns.length, 1);
    assert.equal(derived.threads.find((thread) => thread.thread_id === 't2').turns[0].turn, 1);
  });

  it('handles an empty page', () => {
    assert.deepEqual(deriveTurns([]).threads, []);
    assert.deepEqual(deriveTurns({}).threads, []);
  });
});


describe('multi-TURN ordering', () => {
  const A = { urls: ['turn:w2m:secret@turn-a.example:3479'], weight: 1 };
  const B = { urls: ['turn:w2m:secret@turn-b.example:3479'], weight: 1 };

  it('normalizes only TURN entries and keeps credentials out of status', () => {
    const result = normalizeTurnServers([
      A,
      'turn:w2m:secret@turn-c.example:3479',
      'stun:stun.example:19302',
      { urls: ['stun:stun.example:19302', 'turn:w2m:secret@turn-d.example:3479'] },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.servers.length, 3);
    assert.equal(result.refused.length, 2);
    assert.equal(result.servers[0].urls[0].includes('secret'), true);
  });

  it('redacts credentials in a refused non-TURN URL', () => {
    const result = normalizeTurnServers([{ urls: ['http://user:refused-secret@host'] }]);
    assert.equal(result.ok, true);
    assert.equal(result.refused.length, 1);
    assert.equal(JSON.stringify(result.refused).includes('refused-secret'), false);
    assert.equal(result.refused[0].entry.includes('<redacted>@'), true);
  });

  it('orders the same way from either side of a pair', () => {
    const fromA = orderTurnServersForPair([A, B], { localId: 'machine-a', peerId: 'machine-b' });
    const fromB = orderTurnServersForPair([B, A], { localId: 'machine-b', peerId: 'machine-a' });
    assert.equal(turnPairKey('machine-a', 'machine-b'), turnPairKey('machine-b', 'machine-a'));
    assert.deepEqual(fromA.map((server) => server.urls[0]), fromB.map((server) => server.urls[0]));
  });

  it('spreads pair primaries across both TURN servers', () => {
    const counts = new Map();
    for (let index = 0; index < 80; index += 1) {
      const first = orderTurnServersForPair([A, B], { localId: 'node', peerId: `peer-${index}` })[0];
      counts.set(first.urls[0], (counts.get(first.urls[0]) ?? 0) + 1);
    }
    assert.equal(counts.size, 2);
    for (const count of counts.values()) assert.ok(count >= 20, `imbalanced: ${count}`);
  });

  it('puts the pair primary first and keeps the other TURN server as a fallback', () => {
    const ice = buildIceServersForPeer({
      turnServers: [A, B],
      iceServers: [{ urls: ['stun:stun.example:19302'] }],
      localId: 'machine-a',
      peerId: 'machine-b',
    });
    assert.equal(ice.length, 3);
    assert.equal(ice[0].urls[0].includes('turn-'), true);
    assert.equal(ice[1].urls[0].includes('turn-'), true);
    assert.deepEqual(ice[2], { urls: ['stun:stun.example:19302'] });
  });

  it('honours the primary-only policy', () => {
    const ice = buildIceServersForPeer({
      turnServers: [A, B],
      localId: 'machine-a',
      peerId: 'machine-b',
      policy: 'primary',
    });
    assert.equal(ice.length, 1);
  });

  it('redacts embedded credentials, including an @ inside the password', () => {
    const described = describeTurnServers([
      { urls: ['turn:user:p@ss@turn.example:3479'], weight: 1 },
      { urls: ['turn:user:secret@turn-b.example:3479'], username: 'user', credential: 'secret' },
    ]);
    const serialized = JSON.stringify(described);
    assert.equal(serialized.includes('p@ss'), false);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(described[0].urls[0], 'turn:<redacted>@turn.example:3479');
    assert.equal(described[0].has_credentials, true);
    assert.equal(described[1].has_credentials, true);
    assert.equal(redactTurnUrl('turn:user:p@ss@turn.example:3479'), 'turn:<redacted>@turn.example:3479');
  });

  it('does not keep a legacy TURN entry when a dedicated TURN list owns the relay', () => {
    const ice = buildIceServersForPeer({
      turnServers: [A],
      iceServers: [
        {
          urls: ['stun:stun.example:19302', 'turn:w2m:legacy-secret@legacy.example:3479'],
          username: 'w2m',
          credential: 'legacy-secret',
        },
      ],
      localId: 'machine-a',
      peerId: 'machine-b',
      policy: 'primary',
    });
    assert.deepEqual(ice, [
      { urls: ['turn:w2m:secret@turn-a.example:3479'], weight: 1 },
      { urls: ['stun:stun.example:19302'] },
    ]);
    assert.equal(JSON.stringify(ice).includes('legacy-secret'), false);
  });

  it('leaves the legacy TURN entry untouched when no dedicated TURN list exists', () => {
    const legacy = [{ urls: ['stun:stun.example:19302', 'turn:w2m:legacy@legacy.example:3479'] }];
    assert.deepEqual(buildIceServersForPeer({ iceServers: legacy }), legacy);
  });
});
