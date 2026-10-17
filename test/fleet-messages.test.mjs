/**
 * Session-scoped chat: plain text only, byte budget enforced before write, deletion follows the session.
 *
 * The budgets are injected small, so "100 MB" and the 7-day comparison are exercised at 100 bytes instead of waiting for
 * a real fleet to fill a disk. The rule under test is the formula, not the number.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFleetMessages } from '../src/relay/fleet-messages.mjs';

function harness(options = {}) {
  let t = 1_700_000_000_000;
  const chat = createFleetMessages({ now: () => t, ...options });
  return { chat, advance: (ms) => { t += ms; } };
}

const msg = (text, extra = {}) => ({ session_id: 's-1', machine_id: 'm-1', text, ...extra });

describe('a fleet chat message is plain text in a session', () => {
  it('accepts text and returns it in the session flow, attributed to the machine', () => {
    const { chat } = harness();
    const posted = chat.post(msg('hello fleet'));
    assert.equal(posted.ok, true);
    const listed = chat.list({ session_id: 's-1' });
    assert.equal(listed.count, 1);
    assert.equal(listed.messages[0].text, 'hello fleet');
    assert.equal(listed.messages[0].machine_id, 'm-1');
  });

  it('refuses empty, non-string, control-character and oversized text instead of storing it', () => {
    const { chat } = harness({ maxMessageBytes: 10 });
    assert.equal(chat.post(msg('   ')).code, 'EMPTY_TEXT');
    assert.equal(chat.post(msg(42)).code, 'NOT_TEXT');
    assert.equal(chat.post(msg('bell\u0007here')).code, 'NOT_TEXT');
    assert.equal(chat.post(msg('x'.repeat(11))).code, 'MESSAGE_TOO_LARGE');
    assert.equal(chat.list({ session_id: 's-1' }).count, 0);
  });

  it('keeps sessions separate and deletes history with the session', () => {
    const { chat } = harness();
    chat.post(msg('one', { session_id: 's-1' }));
    chat.post(msg('two', { session_id: 's-2' }));
    assert.equal(chat.list({ session_id: 's-1' }).count, 1);
    assert.equal(chat.list({ session_id: 's-2' }).count, 1);
    assert.equal(chat.deleteSession('s-1'), true);
    assert.equal(chat.list({ session_id: 's-1' }).count, 0);
  });

  it('returns the newest messages in the order they were said, capped by limit', () => {
    const { chat } = harness();
    for (const word of ['a', 'b', 'c', 'd']) chat.post(msg(word));
    const listed = chat.list({ session_id: 's-1', limit: 2 });
    assert.deepEqual(listed.messages.map((m) => m.text), ['c', 'd']);
  });
});

describe('the byte budget is the operator formula', () => {
  it('refuses a message past the 24h quota and reports the current usage with the refusal', () => {
    const { chat } = harness({ quota24hBytes: 100, hardCapBytes: 200 });
    assert.equal(chat.post(msg('x'.repeat(60))).ok, true);
    const refused = chat.post(msg('y'.repeat(60)));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'FLEET_QUOTA_EXCEEDED');
    assert.equal(refused.detail.used_24h_bytes, 60);
    assert.equal(refused.detail.limit_bytes, 100);
  });

  it('keeps the LARGER of the 24h quota and the 7-day figure, capped by the hard ceiling', () => {
    // 24h quota is tiny, but a week of traffic is larger: the week wins, up to the cap.
    const { chat, advance } = harness({ quota24hBytes: 100, hardCapBytes: 150 });
    assert.equal(chat.post(msg('a'.repeat(100))).ok, true);
    advance(2 * 24 * 60 * 60 * 1000);          // two days later: still inside retention, outside 24h
    assert.equal(chat.post(msg('b'.repeat(40))).ok, true);
    // 7-day usage is 140, 24h usage is 40 -> limit = min(150, max(100, 140)) = 140
    assert.equal(chat.limitBytes(), 140);
    assert.equal(chat.post(msg('c'.repeat(135))).ok, false, 'past the cap');
  });

  it('counts only the last 24 hours against the 24h quota', () => {
    const { chat, advance } = harness({ quota24hBytes: 100, hardCapBytes: 1000, retentionDays: 7 });
    chat.post(msg('a'.repeat(80)));
    advance(25 * 60 * 60 * 1000);
    assert.equal(chat.usage().used_24h_bytes, 0, 'yesterday does not count today');
    assert.equal(chat.post(msg('b'.repeat(80))).ok, true);
  });
});

describe('notifications say nothing about content', () => {
  it('a message that is refused produces no notification at all', () => {
    const chat = createFleetMessages({ quota24hBytes: 10, hardCapBytes: 10 });
    const events = [];
    chat.subscribe('s-1', (e) => events.push(e));
    chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'x'.repeat(20) });
    assert.equal(events.length, 0, 'a refused write is not a new message');
  });
});
