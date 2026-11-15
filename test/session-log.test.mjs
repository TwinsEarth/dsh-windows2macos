/**
 * DSH session-log reader (v3.3.6): incremental zstd-frame reading for the history window and the
 * choice-prompt watcher. The reader must pick up only the newly appended frames on each poll.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

import { findSessionLog, readSessionById, readSessionLog, readSessionTitle, sessionsRoot } from '../src/queue-journal/lib/session-log.mjs';

// Node < 22.15 has no zstd in node:zlib (CI's node 20 lane); those tests skip, the reader degrades.
const ZSTD_READY = typeof zlib.zstdCompressSync === 'function';
const skip = ZSTD_READY ? false : 'this Node has no zstd API (needs >= 22.15)';

const fixtures = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'w2m-sessionlog-'));
  fixtures.push(root);
  return root;
}
test.after(() => {
  for (const root of fixtures) { try { rmSync(root, { recursive: true, force: true }); } catch { /* locked */ } }
});

const event = (value) => `${JSON.stringify(value)}\n`;
function frame(events) {
  return zlib.zstdCompressSync(Buffer.from(events.map(event).join(''), 'utf8'));
}
function makeLog(root, sessionId) {
  const file = join(root, 'workspace-a', sessionId, 'session.v4.jsonl.zstd');
  mkdirSync(join(root, 'workspace-a', sessionId), { recursive: true });
  return file;
}

test('session-log: reads title, human messages and the last assistant reply, excluding machine-injected user messages', { skip }, () => {
  const root = fixture();
  const file = makeLog(root, 'session-abc');
  writeFileSync(file, frame([
    { type: 'session', version: 4, id: 'session-abc' },
    { type: 'session/title', seq: 1, time: 1000, data: { title: 'DSH：房主' } },
    { type: 'user/message', seq: 2, time: 2000, data: { content: [{ type: 'text', text: '第一句人类输入' }], source: { kind: 'user' }, role: 'user' } },
    { type: 'user/message', seq: 3, time: 2100, data: { content: [{ type: 'text', text: '时间上下文（机器）' }], source: { kind: 'time-context' }, role: 'user' } },
    { type: 'assistant/message', seq: 4, time: 3000, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '旧回复' }] } } },
  ]));
  const out = readSessionLog(file);
  assert.equal(out.title, 'DSH：房主');
  assert.equal(out.human.length, 1);
  assert.equal(out.human[0].text, '第一句人类输入');
  assert.equal(out.assistant, '旧回复');
});

test('session-log: appended zstd frames are picked up incrementally without duplicating history', { skip }, () => {
  const root = fixture();
  const file = makeLog(root, 'session-abc');
  writeFileSync(file, frame([
    { type: 'session/title', time: 1000, data: { title: '标题一' } },
    { type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' }, role: 'user' } },
    { type: 'assistant/message', time: 2500, data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复一' }] } } },
  ]));
  const first = readSessionLog(file);
  assert.equal(first.human.length, 1);
  assert.equal(first.assistant, '回复一');
  appendFileSync(file, frame([
    { type: 'session/title', time: 2600, data: { title: '标题二' } },
    { type: 'user/message', time: 2700, data: { content: [{ type: 'text', text: '第二条' }], source: { kind: 'user' }, role: 'user' } },
    { type: 'assistant/message', time: 2800, data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复二' }] } } },
  ]));
  const second = readSessionLog(file);
  assert.equal(second.title, '标题二');
  assert.equal(second.human.length, 2);
  assert.deepEqual(second.human.map((item) => item.text), ['第一条', '第二条']);
  assert.equal(second.assistant, '回复二');
});

test('session-log: resolves session ids with or without the session- prefix and returns null when the log is missing', { skip }, () => {
  const root = fixture();
  const file = makeLog(root, 'session-xyz');
  writeFileSync(file, frame([{ type: 'session/title', time: 1, data: { title: '定位' } }]));
  assert.equal(findSessionLog(root, 'session-xyz')?.file, file);
  assert.equal(findSessionLog(root, 'xyz')?.file, file);
  assert.equal(findSessionLog(root, 'missing'), null);
  assert.equal(readSessionById('xyz', { root })?.title, '定位');
  assert.equal(readSessionById('missing', { root }), null);
});

test('session-log: sessionsRoot honours DSH_HOME', () => {
  assert.equal(sessionsRoot({ DSH_HOME: 'C:/tmp/home-a' }), join('C:/tmp/home-a', 'sessions'));
});

test('session-log: reads the newest title from the log head; null when the log is missing', { skip }, () => {
  const root = fixture();
  const file = makeLog(root, 'session-title-demo');
  writeFileSync(file, frame([
    { type: 'session/title', time: 1000, data: { title: '旧标题' } },
    { type: 'user/message', time: 1100, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user' } },
    { type: 'session/title', time: 2000, data: { title: 'DSH：房主' } },
  ]));
  assert.equal(readSessionTitle('session-title-demo', { root }), 'DSH：房主');
  assert.equal(readSessionTitle('session-title-demo', { root }), 'DSH：房主');
  assert.equal(readSessionTitle('missing', { root }), null);
});
