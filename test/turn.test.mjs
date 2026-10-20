/**
 * Turns derived from messages: ordering comes from the relay's number, never from the arrival order of a page.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTurns } from '../src/plugin/turn.mjs';

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
