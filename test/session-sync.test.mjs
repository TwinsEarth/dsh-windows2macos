/**
 * The two rules that a smoke test cannot see: publish only what is new, and never show our own broadcast as remote.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { avatarColorIndex, createSessionSync, displayKind, isRemoteBroadcast } from '../src/plugin/session-sync.mjs';

const sync = () => createSessionSync({ conversationKey: 'ck-1', machineId: 'm-1', machineName: 'win-desktop' });
const msg = (text, at = 1) => ({ at_ms: at, text });

describe('only new prompts are published', () => {
  it('publishes the first read, then only the messages that appeared after it', () => {
    const s = sync();
    assert.deepEqual(s.pending([msg('one'), msg('two', 2)]).map((m) => m.text), ['one', 'two']);
    assert.deepEqual(s.pending([msg('one'), msg('two', 2)]), [], 'a re-read must not republish the history');
    assert.deepEqual(s.pending([msg('one'), msg('two', 2), msg('three', 3)]).map((m) => m.text), ['three']);
  });

  it('carries the conversation key, the machine name and the session origin', () => {
    const [first] = sync().pending([msg('hello')]);
    assert.deepEqual(
      { ck: first.conversation_key, m: first.machine_id, n: first.machine_name, o: first.origin },
      { ck: 'ck-1', m: 'm-1', n: 'win-desktop', o: 'session' },
    );
  });

  it('skips blank text and publishes a non-blank message once', () => {
    const s = sync();
    // One read: a blank prompt is dropped, the real one is published. (The high-water mark counts positions, so a
    // second call with a SHORTER array would legitimately see nothing new -- which is what the first version of this
    // test got wrong.)
    const published = s.pending([msg('   '), msg('only once', 5)]);
    assert.deepEqual(published.map((m) => m.text), ['only once']);
    assert.deepEqual(s.pending([msg('   '), msg('only once', 5)]), [], 'the same read again publishes nothing');
  });
});

describe('a message this machine published is not shown as remote', () => {
  it('classifies own session prompts, own chat, and other machines', () => {
    assert.equal(displayKind({ machine_id: 'm-1', origin: 'session' }, 'm-1'), 'session');
    assert.equal(displayKind({ machine_id: 'm-1', origin: 'chat' }, 'm-1'), 'chat');
    assert.equal(displayKind({ machine_id: 'm-2', origin: 'session' }, 'm-1'), 'remote');
    assert.equal(isRemoteBroadcast({ machine_id: 'm-1' }, 'm-1'), false);
    assert.equal(isRemoteBroadcast({ machine_id: 'm-9' }, 'm-1'), true);
    assert.equal(isRemoteBroadcast(null, 'm-1'), false);
  });

  it('gives one machine a stable palette index', () => {
    const a = avatarColorIndex('m-1', 8);
    assert.equal(a, avatarColorIndex('m-1', 8), 'the colour must not move between renders');
    assert.ok(a >= 0 && a < 8);
    assert.notEqual(avatarColorIndex('m-1', 8), avatarColorIndex('m-2', 8));
  });
});
