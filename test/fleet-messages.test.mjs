/**
 * Session-scoped chat: plain text only, byte budget enforced before write, deletion follows the session.
 *
 * The budgets are injected small, so "100 MB" and the 7-day comparison are exercised at 100 bytes instead of waiting for
 * a real fleet to fill a disk. The rule under test is the formula, not the number.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChatStore } from '../src/relay/chat-store.mjs';
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


describe('mentions and idempotency (v1.2.5)', () => {
  const store = () => createFleetMessages({ now: (() => { let t = 1_000; return () => (t += 10); })() });

  it('stores a validated mention list on the message', () => {
    const m = store();
    const posted = m.post({ session_id: 's1', machine_id: 'a', text: 'hi', mentions: ['b', 'c', 'b'] });
    assert.equal(posted.ok, true);
    assert.deepEqual(posted.message.mentions, ['b', 'c'], 'duplicates collapse');
  });

  it('refuses a malformed mention list instead of ignoring it', () => {
    const m = store();
    for (const mentions of ['b', ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'], ['has space'], [1]]) {
      assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'hi', mentions }).code, 'BAD_MENTIONS', JSON.stringify(mentions));
    }
  });

  it('replays the first message for a repeated idempotency key', () => {
    const m = store();
    const first = m.post({ session_id: 's1', machine_id: 'a', text: 'once', idempotency_key: 'k1' });
    const again = m.post({ session_id: 's1', machine_id: 'a', text: 'once', idempotency_key: 'k1' });
    assert.equal(again.ok, true);
    assert.equal(again.deduped, true);
    assert.equal(again.message.message_id, first.message.message_id);
    assert.equal(m.list({ session_id: 's1' }).count, 1, 'the sentence is stored once');
    const other = m.post({ session_id: 's1', machine_id: 'a', text: 'once', idempotency_key: 'k2' });
    assert.equal(other.deduped, undefined);
    assert.equal(m.list({ session_id: 's1' }).count, 2);
  });
});


describe('end-to-end encrypted messages (v1.2.6)', () => {
  const store = () => createFleetMessages({ now: (() => { let t = 2_000; return () => (t += 10); })() });

  it('stores the ciphertext and its metadata, and returns both on read', () => {
    const m = store();
    const enc = { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn' };
    const posted = m.post({ session_id: 's1', machine_id: 'a', text: 'Y2lwaGVy', enc });
    assert.equal(posted.ok, true);
    assert.deepEqual(posted.message.enc, enc);
    assert.equal(posted.message.text, 'Y2lwaGVy');
    assert.deepEqual(m.list({ session_id: 's1' }).messages[0].enc, enc);
  });

  it('refuses a malformed encryption envelope instead of storing it', () => {
    const m = store();
    for (const enc of [
      { v: 3, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn' },
      { v: 1, alg: 'rot13', iv: 'aXY=', tag: 'dGFn' },
      { v: 1, alg: 'aes-256-gcm', iv: '', tag: 'dGFn' },
      { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'x'.repeat(65) },
    ]) {
      assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'x', enc }).code, 'BAD_ENCRYPTION', JSON.stringify(enc));
    }
  });

  it('keeps plaintext messages plaintext and in the same flow', () => {
    const m = store();
    m.post({ session_id: 's1', machine_id: 'a', text: 'plain' });
    m.post({ session_id: 's1', machine_id: 'b', text: 'Y2lwaGVy', enc: { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn' } });
    const listed = m.list({ session_id: 's1' }).messages;
    assert.equal(listed.length, 2);
    assert.equal(listed[0].enc, undefined, 'a plaintext message keeps the old shape');
    assert.equal(listed[1].enc.alg, 'aes-256-gcm');
  });
});


describe('AEAD v2 messages with AAD (A7)', () => {
  const store = () => createFleetMessages({ now: (() => { let t = 2_500; return () => (t += 10); })() });
  const envelope = (over = {}) => ({ v: 2, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', aad: { session_id: 's1', machine_id: 'a', message_id: 'local-1' }, ...over });

  it('stores and returns a v2 envelope, AAD included', () => {
    const m = store();
    const posted = m.post({ session_id: 's1', machine_id: 'a', text: 'Y2lwaGVy', enc: envelope() });
    assert.equal(posted.ok, true);
    assert.deepEqual(posted.message.enc, envelope());
    assert.deepEqual(m.list({ session_id: 's1' }).messages[0].enc, envelope());
  });

  it('refuses clear AAD naming another session or another machine', () => {
    const m = store();
    assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'x', enc: envelope({ aad: { session_id: 's2', machine_id: 'a', message_id: 'local-1' } }) }).code, 'CHAT_AAD_MISMATCH');
    assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'x', enc: envelope({ aad: { session_id: 's1', machine_id: 'b', message_id: 'local-1' } }) }).code, 'CHAT_AAD_MISMATCH');
  });

  it('refuses a missing AAD, a bad message id, and unknown versions', () => {
    const m = store();
    assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'x', enc: { v: 2, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn' } }).code, 'CHAT_AAD_MISSING');
    assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'x', enc: envelope({ aad: { session_id: 's1', machine_id: 'a', message_id: '' } }) }).code, 'CHAT_AAD_INVALID');
    assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'x', enc: envelope({ v: 4 }) }).code, 'BAD_ENCRYPTION');
  });

  it('keeps v1 readable without AAD (backward compatibility)', () => {
    const m = store();
    const v1 = { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn' };
    assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'Y2lwaGVy', enc: v1 }).ok, true);
  });
});

describe('reply state (v1.2.7)', () => {
  const store = () => createFleetMessages({ now: (() => { let t = 3_000; return () => (t += 10); })() });

  it('stores answered and refused as reply states', () => {
    const m = store();
    const answered = m.post({ session_id: 's1', machine_id: 'a', text: 'yes', reply_state: 'answered' });
    const refused = m.post({ session_id: 's1', machine_id: 'a', text: 'no', reply_state: 'refused' });
    assert.equal(answered.message.reply_state, 'answered');
    assert.equal(refused.message.reply_state, 'refused');
  });

  it('refuses an unknown reply state instead of guessing', () => {
    const m = store();
    assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'x', reply_state: 'maybe' }).code, 'BAD_REPLY_STATE');
    assert.equal(m.post({ session_id: 's1', machine_id: 'a', text: 'x', reply_state: 1 }).code, 'BAD_REPLY_STATE');
  });

  it('leaves ordinary messages without the field', () => {
    const m = store();
    const plain = m.post({ session_id: 's1', machine_id: 'a', text: 'hello' });
    assert.equal('reply_state' in plain.message, false);
  });
});
describe('message id epoch (v1.2.8)', () => {
  const at = () => createFleetMessages({ now: (() => { let t = 4_000; return () => (t += 10); })() });

  it('makes ids unique across a relay restart (same sequence, different process)', () => {
    const first = at();
    const second = at();
    const one = first.post({ session_id: 's1', machine_id: 'a', text: 'before restart' });
    const two = second.post({ session_id: 's1', machine_id: 'a', text: 'after restart' });
    assert.match(one.message.message_id, /^msg-[0-9a-f]{6}-000001$/);
    assert.notEqual(one.message.message_id, two.message.message_id, 'a restarted relay must not reuse an id');
  });

  it('honours an explicit epoch, so a test can name the process', () => {
    const store = createFleetMessages({ now: () => 5_000, epoch: 'abc123' });
    assert.equal(store.post({ session_id: 's1', machine_id: 'a', text: 'x' }).message.message_id, 'msg-abc123-000001');
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Phase 2A: restart recovery, persistence hooks, imported messages and retention pruning      */
/* (chat-store.mjs and cluster sync build on exactly these surfaces)                           */
/* ------------------------------------------------------------------------------------------- */

function tempStateDir() {
  return mkdtempSync(join(tmpdir(), 'w2m-chat-wire-'));
}

/** A row shaped like one `createFleetMessages` would have produced, for restore/import tests. */
function storedRow(id, overrides = {}) {
  const text = typeof overrides.text === 'string' ? overrides.text : `restored ${id}`;
  return {
    message_id: id,
    session_id: 's-1',
    fleet_id: null,
    machine_id: 'm-1',
    to: 'all',
    thread_id: null,
    reply_to: null,
    turn: 1,
    text,
    at_ms: 1_700_000_000_000,
    bytes: Buffer.byteLength(text, 'utf8'),
    ...overrides,
  };
}

describe('Phase 2A restart recovery (initialMessages)', () => {
  it('seeds restored rows into their sessions without reordering them', () => {
    const seeded = [
      storedRow('msg-a', { at_ms: 1_000 }),
      storedRow('msg-b', { at_ms: 2_000 }),
      storedRow('msg-c', { session_id: 's-2', at_ms: 1_500 }),
    ];
    const chat = createFleetMessages({ now: () => 3_000, initialMessages: seeded });
    assert.deepEqual(chat.list({ session_id: 's-1' }).messages.map((m) => m.message_id), ['msg-a', 'msg-b']);
    assert.deepEqual(chat.list({ session_id: 's-2' }).messages.map((m) => m.message_id), ['msg-c']);
    assert.deepEqual(chat.getSessionIds().sort(), ['s-1', 's-2']);
    assert.equal(chat.usage().messages, 3, 'restored rows count against the quota again');
    assert.deepEqual(chat.findMessage('msg-b'), storedRow('msg-b', { at_ms: 2_000 }));
    assert.equal(chat.findMessage('nope'), null);
  });

  it('drops duplicate/invalid seeds and keeps message ids unique', () => {
    const chat = createFleetMessages({
      now: () => 3_000,
      initialMessages: [storedRow('msg-a'), storedRow('msg-a'), { message_id: 'bad' }, null, storedRow('msg-b')],
    });
    assert.equal(chat.usage().messages, 2);
    assert.deepEqual(chat.getSessionIds(), ['s-1']);
  });

  it('continues the explicit-epoch sequence past a restored id', () => {
    const chat = createFleetMessages({
      now: () => 3_000,
      epoch: 'abc123',
      initialMessages: [storedRow('msg-abc123-000007')],
    });
    assert.equal(chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'after restart' }).message.message_id, 'msg-abc123-000008');
  });
});

describe('Phase 2A persistence hooks', () => {
  it('calls onAppend once per accepted message and never for a replay or a refusal', () => {
    const persisted = [];
    const chat = createFleetMessages({ now: () => 1_000, onAppend: (message) => persisted.push(message.message_id) });
    const first = chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'once', idempotency_key: 'k1' });
    chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'once', idempotency_key: 'k1' });
    chat.post({ session_id: 's-1', machine_id: 'm-1', text: '   ' });
    assert.deepEqual(persisted, [first.message.message_id]);
  });

  it('a throwing persistence hook cannot change the post result, and deleteSession still reports success', () => {
    const chat = createFleetMessages({
      now: () => 1_000,
      onAppend: () => { throw new Error('disk full'); },
      onDelete: () => { throw new Error('disk full'); },
    });
    const posted = chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'still accepted' });
    assert.equal(posted.ok, true);
    assert.equal(chat.list({ session_id: 's-1' }).count, 1);
    assert.equal(chat.deleteSession('s-1'), true);
    assert.equal(chat.deleteSession('s-1'), false);
  });

  it('calls onDelete only when a session was actually deleted', () => {
    const deleted = [];
    const chat = createFleetMessages({ now: () => 1_000, onDelete: (sessionId) => deleted.push(sessionId) });
    chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'one' });
    chat.deleteSession('s-missing');
    chat.deleteSession('s-1');
    assert.deepEqual(deleted, ['s-1']);
  });
});

describe('Phase 2A imported messages (insertImported)', () => {
  it('inserts a peer row, keeps at_ms order, and notifies without the text', () => {
    const events = [];
    const imported = [];
    const chat = createFleetMessages({ now: () => 5_000, onImported: (message) => imported.push(message.message_id) });
    const local = chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'local' });
    chat.subscribe('s-1', (event) => events.push(event));
    assert.deepEqual(chat.insertImported(storedRow('msg-peer-new', { at_ms: 6_000 })), { ok: true, inserted: true });
    assert.deepEqual(chat.insertImported(storedRow('msg-peer-old', { at_ms: 4_000 })), { ok: true, inserted: true });
    assert.deepEqual(chat.insertImported(storedRow('msg-peer-new', { at_ms: 6_000 })), { ok: true, inserted: false });
    assert.deepEqual(
      chat.list({ session_id: 's-1' }).messages.map((m) => m.message_id),
      ['msg-peer-old', local.message.message_id, 'msg-peer-new'],
      'a page applied out of order still reads as a conversation',
    );
    assert.equal(events.length, 2, 'only the two inserts were new');
    assert.equal('text' in events[0], false, 'the SSE event never carries text');
    assert.equal(events[0].session_id, 's-1');
    assert.deepEqual(imported, ['msg-peer-new', 'msg-peer-old']);
  });

  it('refuses a row without the fields a readable message needs', () => {
    const chat = createFleetMessages({ now: () => 1_000 });
    assert.equal(chat.insertImported(null).ok, false);
    assert.equal(chat.insertImported({ message_id: 'x', session_id: 's', machine_id: 'm', text: 'hi' }).code, 'BAD_AT_MS');
    assert.equal(chat.insertImported({ message_id: '', session_id: 's', machine_id: 'm', text: 'hi', at_ms: 1 }).code, 'BAD_MESSAGE_ID');
    assert.equal(chat.insertImported({ message_id: 'x', session_id: 's', machine_id: 'm', text: 42, at_ms: 1 }).code, 'NOT_TEXT');
    assert.equal(chat.usage().messages, 0);
  });

  it('imports without touching the local quota (design §5.1)', () => {
    const chat = createFleetMessages({ now: () => 5_000, quota24hBytes: 10, hardCapBytes: 10 });
    assert.equal(chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'x'.repeat(20) }).ok, false);
    assert.deepEqual(chat.insertImported(storedRow('msg-peer', { text: 'y'.repeat(200), at_ms: 5_000 })), { ok: true, inserted: true });
    assert.equal(chat.usage().messages, 1);
  });
});

describe('Phase 2A retention pruning (pruneBefore)', () => {
  it('removes messages older than the cutoff and empties the session', () => {
    const chat = createFleetMessages({ now: () => 5_000, initialMessages: [
      storedRow('msg-old', { at_ms: 1_000 }),
      storedRow('msg-new', { at_ms: 4_000 }),
    ] });
    assert.deepEqual(chat.pruneBefore(3_000), { removed: 1 });
    assert.deepEqual(chat.list({ session_id: 's-1' }).messages.map((m) => m.message_id), ['msg-new']);
    assert.equal(chat.findMessage('msg-old'), null);
    assert.equal(chat.findMessage('msg-new').message_id, 'msg-new');
  });

  it('drops the oldest live messages until the byte budget fits', () => {
    const chat = createFleetMessages({ now: () => 5_000, initialMessages: [
      storedRow('msg-a', { at_ms: 1_000, text: 'a'.repeat(10) }),
      storedRow('msg-b', { at_ms: 2_000, text: 'b'.repeat(10) }),
      storedRow('msg-c', { at_ms: 3_000, text: 'c'.repeat(10) }),
    ] });
    assert.deepEqual(chat.pruneBefore(0, { maxBytes: 20 }), { removed: 1 });
    assert.deepEqual(chat.list({ session_id: 's-1' }).messages.map((m) => m.message_id), ['msg-b', 'msg-c']);
  });
});

describe('Phase 2A: chat-store and fleet messages wire together', () => {
  it('persists posts/deletes, then restores messages, read marks and tombstones after a restart', () => {
    const dir = tempStateDir();
    const t = 1_700_000_000_000;
    const store = createChatStore({ dir, now: () => t });
    const chat = createFleetMessages({
      now: () => t,
      initialMessages: store.load().messages,
      onAppend: (message) => store.appendMessage({ origin: 'node-a', message }),
      onDelete: (sessionId) => store.appendSessionDeleted({ origin: 'node-a', session_id: sessionId }),
      onImported: (message) => store.appendMessage({ origin: 'node-a', message }),
    });
    const posted = chat.post({ session_id: 's-1', machine_id: 'm-1', text: 'before restart' });
    store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-1', at_ms: t + 1, message_id: posted.message.message_id });
    chat.post({ session_id: 's-2', machine_id: 'm-2', text: 'other session' });
    chat.deleteSession('s-2');

    // "restart": a fresh store and a fresh in-memory chat, both rebuilt from disk only.
    const restartedStore = createChatStore({ dir, now: () => t });
    const restored = restartedStore.load();
    const restartedChat = createFleetMessages({
      now: () => t,
      initialMessages: restored.messages,
      onAppend: (message) => restartedStore.appendMessage({ origin: 'node-a', message }),
      onDelete: (sessionId) => restartedStore.appendSessionDeleted({ origin: 'node-a', session_id: sessionId }),
      onImported: (message) => restartedStore.appendMessage({ origin: 'node-a', message }),
    });
    assert.deepEqual(restartedChat.list({ session_id: 's-1' }).messages.map((m) => m.message_id), [posted.message.message_id]);
    assert.deepEqual(restored.readMarks, [{ session_id: 's-1', machine_id: 'm-1', at_ms: t + 1, message_id: posted.message.message_id }]);
    assert.deepEqual(restored.deletedSessions, ['s-2']);

    // A message that arrived from a peer is served by the same read path and persisted by the import hook.
    const peer = storedRow('msg-peer', { at_ms: t + 2, machine_id: 'm-b' });
    assert.deepEqual(restartedChat.insertImported(peer), { ok: true, inserted: true });
    assert.equal(restartedStore.load().messages.some((m) => m.message_id === 'msg-peer'), true);
    assert.equal(restartedChat.list({ session_id: 's-1' }).messages.length, 2);
  });
});