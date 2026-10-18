/**
 * Reading a live session transcript: multi-frame zstd, user messages only, and the conversation key the operator chose.
 *
 * The frames are built here with \`zstdCompressSync\` rather than a checked-in fixture, so the test proves the splitter on
 * data it created and stays portable across machines.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import {
  conversationKey, decodeTranscript, extractUserMessages, sessionDirName, splitZstdFrames,
} from '../src/plugin/session-watch.mjs';

const frame = (events) => zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'));

describe('a session transcript is many zstd frames', () => {
  it('splits and decodes every frame, in file order', () => {
    const buf = Buffer.concat([
      frame([{ type: 'meta', cwd: 'E:\\GPT' }]),
      frame([{ role: 'user', content: 'first' }]),
      frame([{ role: 'user', content: 'second' }]),
    ]);
    assert.equal(splitZstdFrames(buf).length, 3, 'one frame per zstd magic block');
    const events = decodeTranscript(buf);
    assert.equal(events.length, 3);
    assert.equal(events[1].content, 'first');
    assert.equal(events[2].content, 'second');
  });

  it('survives a half-written trailing frame instead of losing the history', () => {
    const good = frame([{ role: 'user', content: 'kept' }]);
    const truncated = frame([{ role: 'user', content: 'cut' }]).subarray(0, 12);
    const events = decodeTranscript(Buffer.concat([good, truncated]));
    assert.equal(events.length, 1);
    assert.equal(events[0].content, 'kept');
  });
});

describe('only the user messages are taken', () => {
  it('keeps user and prompt events and drops assistant, tool and empty ones', () => {
    const events = decodeTranscript(Buffer.concat([frame([
      { role: 'user', content: 'please run the tests' },
      { role: 'assistant', content: 'running them' },
      { type: 'user', content: [{ type: 'text', text: 'multi part ' }, { type: 'text', text: 'message' }] },
      { type: 'tool', content: 'ignored' },
      { role: 'user', content: '   ' },
    ])]));
    const messages = extractUserMessages(events);
    assert.deepEqual(messages.map((m) => m.text), ['please run the tests', 'multi part message']);
  });
});

describe('the conversation key is account + project name', () => {
  it('treats the same project on different paths as one conversation', () => {
    const a = conversationKey('fp-1', 'E:\\GPT');
    const b = conversationKey('fp-1', '/Users/fang/GPT/');
    assert.equal(a, b, 'the path differs, the project does not');
  });

  it('separates projects and accounts', () => {
    assert.notEqual(conversationKey('fp-1', 'E:\\GPT'), conversationKey('fp-1', 'E:\\DSH'));
    assert.notEqual(conversationKey('fp-1', 'E:\\GPT'), conversationKey('fp-2', 'E:\\GPT'));
    assert.match(conversationKey('fp-1', 'E:\\GPT'), /^[0-9a-f]{64}$/);
  });

  it('derives the directory name DSH uses, as measured on this machine', () => {
    assert.equal(sessionDirName('E:\\GPT'), '--E-GPT--');
  });
});
