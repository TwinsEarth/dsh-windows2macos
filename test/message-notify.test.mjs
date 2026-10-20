/**
 * The notification carries an id, never the text.
 *
 * That is the whole security shape of this feature: the stream is a hint, and the text is fetched through the endpoint
 * that authenticates the reader. A test that only asserted "an event arrives" would pass for a broadcast that leaked
 * every message to every listener.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFleetMessages } from '../src/relay/fleet-messages.mjs';

const post = (chat, text, session = 's-1', machine = 'm-1') => chat.post({ session_id: session, machine_id: machine, text });

describe('new-message notifications', () => {
  it('a subscriber received one event per message, with the id and WITHOUT the text', () => {
    const chat = createFleetMessages();
    const events = [];
    const unsubscribe = chat.subscribe('s-1', (event) => events.push(event));
    post(chat, 'secret words');
    unsubscribe();
    assert.equal(events.length, 1);
    assert.match(events[0].message_id, /^msg-[0-9a-f]{6}-000001$/, 'v1.2.8: ids carry the relay epoch');
    assert.equal(events[0].session_id, 's-1');
    assert.equal(events[0].machine_id, 'm-1');
    assert.equal(events[0].text, undefined, 'the event must not carry the text');
    assert.equal(JSON.stringify(events[0]).includes('secret'), false);
  });

  it('a session-scoped subscriber hears only its own session; a global one hears all', () => {
    const chat = createFleetMessages();
    const scoped = [];
    const all = [];
    chat.subscribe('s-1', (e) => scoped.push(e));
    chat.subscribe(null, (e) => all.push(e));
    post(chat, 'one', 's-1');
    post(chat, 'two', 's-2');
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].session_id, 's-1');
    assert.equal(all.length, 2);
  });

  it('a listener that throws does not break the write, and unsubscribing stops delivery', () => {
    const chat = createFleetMessages();
    const seen = [];
    const off = chat.subscribe('s-1', () => { throw new Error('dead client'); });
    chat.subscribe('s-1', (e) => seen.push(e));
    assert.equal(post(chat, 'still written').ok, true);
    assert.equal(seen.length, 1);
    off();
    post(chat, 'after off');
    assert.equal(seen.length, 2, 'the other subscriber keeps receiving');
  });
});
