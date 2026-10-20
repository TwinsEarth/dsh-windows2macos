/**
 * The ask store: the two states that are easy to get wrong, and the restart case that made it a file rather than a Map.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_STATE, createAskStore } from '../src/plugin/ask-store.mjs';

const store = () => createAskStore({ now: (() => { let t = 1000; return () => (t += 10); })() });

describe('openAsk', () => {
  it('records who asked what, and when it expires', () => {
    const s = store();
    const opened = s.openAsk({ sessionId: 's1', messageId: 'm1', timeoutMs: 500 });
    assert.equal(opened.ok, true);
    assert.equal(opened.ask.state, 'open');
    assert.equal(opened.ask.session_id, 's1');
    assert.ok(opened.ask.deadline_ms > opened.ask.opened_at_ms);
  });

  it('refuses without a session or a message', () => {
    assert.equal(store().openAsk({}).code, 'ASK_BAD_INPUT');
    assert.equal(store().openAsk({ sessionId: 's1' }).code, 'ASK_BAD_INPUT');
  });
});

describe('settle', () => {
  it('answers an open ask once', () => {
    const s = store();
    const ask = s.openAsk({ sessionId: 's1', messageId: 'm1' }).ask;
    const settled = s.settle(ask.ask_id, 'answered', { messageId: 'r1' });
    assert.equal(settled.settled, true);
    assert.equal(settled.ask.state, 'answered');
    assert.equal(settled.ask.reply_message_id, 'r1');
    // A second reply cannot race into the same slot.
    assert.equal(s.settle(ask.ask_id, 'refused', { messageId: 'r2' }).settled, false);
  });

  it('records a reply that arrived after the deadline as answered_after_timeout, not overwriting the timeout', () => {
    const s = store();
    const ask = s.openAsk({ sessionId: 's1', messageId: 'm1' }).ask;
    assert.equal(s.expire(ask.ask_id).expired, true);
    const late = s.settle(ask.ask_id, 'answered', { messageId: 'late' });
    assert.equal(late.ask.state, 'answered_after_timeout');
    assert.equal(late.ask.reply_message_id, 'late');
  });

  it('refuses an unknown ask and a state it does not have', () => {
    const s = store();
    assert.equal(s.settle('nope', 'answered').code, 'ASK_UNKNOWN');
    const ask = s.openAsk({ sessionId: 's1', messageId: 'm1' }).ask;
    assert.equal(s.settle(ask.ask_id, 'open').code, 'ASK_BAD_STATE');
    assert.equal(s.settle(ask.ask_id, 'sleeping').code, 'ASK_BAD_STATE');
  });
});

describe('expiry and restart', () => {
  it('expires every open ask whose deadline passed, once', () => {
    const s = createAskStore({ now: (() => { let t = 0; return () => (t += 1000); })() });
    const ask = s.openAsk({ sessionId: 's1', messageId: 'm1', timeoutMs: 1 }).ask;
    assert.deepEqual(s.expireDue().expired, [ask.ask_id]);
    assert.deepEqual(s.expireDue().expired, []);
  });

  it('restores records and keeps their state, so an answer can still settle after a restart', () => {
    const first = store();
    const ask = first.openAsk({ sessionId: 's1', messageId: 'm1' }).ask;
    const second = store();
    assert.equal(second.restore(first.exportAll()).restored, 1);
    assert.equal(second.list({ sessionId: 's1' }).asks[0].state, 'open');
    assert.equal(second.settle(ask.ask_id, 'answered', { messageId: 'r1' }).settled, true);
  });

  it('lists by state and session', () => {
    const s = store();
    const a = s.openAsk({ sessionId: 's1', messageId: 'm1' }).ask;
    s.openAsk({ sessionId: 's2', messageId: 'm2' });
    s.expire(a.ask_id);
    assert.equal(s.list({ state: 'timeout' }).asks.length, 1);
    assert.equal(s.list({ sessionId: 's2' }).asks.length, 1);
    assert.ok(ASK_STATE.includes('answered_after_timeout'));
  });
});
