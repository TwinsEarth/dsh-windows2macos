/**
 * Chat replication store (Phase 2A) - unit tests.
 *
 * Covers the on-disk round trip, deterministic ordering, read-mark LWW, deletion tombstones, the retention/hard-cap
 * compaction with its generation bump, byte-offset paging for peers, import dedupe/re-export, and tolerance for the two
 * kinds of damage a real disk produces: a corrupt JSON line and a write torn off before its newline.
 *
 * The clock is injected, so "7 days" is exercised without waiting a week.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createChatStore } from '../src/relay/chat-store.mjs';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'w2m-chat-'));
}

/** A store plus control over its clock and its state directory. */
function harness(overrides = {}) {
  const dir = tempDir();
  let clock = T0;
  const now = () => clock;
  const store = createChatStore({ dir, now, ...overrides });
  return {
    dir,
    store,
    now,
    advance(ms) { clock += ms; },
    setClock(ms) { clock = ms; },
    reopen(extra = {}) { return createChatStore({ dir, now, ...overrides, ...extra }); },
    chatDir() { return join(dir, 'chat'); },
    logFile() { return join(dir, 'chat', 'replication.jsonl'); },
  };
}

/** A full fleet-messages row, so the round trip compares the real shape. */
function message(id, overrides = {}) {
  const text = typeof overrides.text === 'string' ? overrides.text : `hello ${id}`;
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
    at_ms: T0,
    bytes: Buffer.byteLength(text, 'utf8'),
    ...overrides,
  };
}

const peerMessage = (origin, offset, id, overrides = {}) => ({
  v: 1,
  origin,
  offset,
  at_ms: T0,
  kind: 'chat.message',
  data: message(id, overrides),
});

describe('an empty chat directory', () => {
  it('loads as empty state without creating the directory just by reading', () => {
    const dir = join(tempDir(), 'relay-state');
    const store = createChatStore({ dir, now: () => T0 });
    const loaded = store.load();
    assert.deepEqual(loaded.messages, []);
    assert.deepEqual(loaded.readMarks, []);
    assert.deepEqual(loaded.deletedSessions, []);
    assert.deepEqual(loaded.stats, { generation: 1, records: 0, bytes: 0, messages: 0, next_local_offset: 0 });
    assert.deepEqual(store.stats(), loaded.stats);
    assert.equal(existsSync(join(dir, 'chat')), false, 'load() is a read');
  });

  it('refuses to be constructed without a state directory', () => {
    assert.throws(() => createChatStore(), TypeError);
    assert.throws(() => createChatStore({ dir: '' }), TypeError);
  });
});

describe('append/load round trip', () => {
  it('persists the message row verbatim and returns messages by at_ms', () => {
    const h = harness();
    const first = h.store.appendMessage({ origin: 'node-a', message: message('msg-1', { at_ms: T0 + 2_000 }) });
    assert.equal(first.v, 1);
    assert.equal(first.origin, 'node-a');
    assert.equal(first.offset, 0);
    assert.equal(first.kind, 'chat.message');
    assert.deepEqual(first.data, message('msg-1', { at_ms: T0 + 2_000 }));

    h.store.appendMessage({ origin: 'node-a', message: message('msg-2', { at_ms: T0 }) });
    const loaded = h.reopen().load();
    assert.deepEqual(loaded.messages.map((m) => m.message_id), ['msg-2', 'msg-1'], 'ascending at_ms');
    assert.deepEqual(loaded.messages[1], message('msg-1', { at_ms: T0 + 2_000 }));
    assert.deepEqual(loaded.stats, { generation: 1, records: 2, bytes: statSync(h.logFile()).size, messages: 2, next_local_offset: 2 });
    assert.deepEqual(h.reopen().load().messages, loaded.messages, 'load is idempotent');
  });

  it('orders equal timestamps by origin then offset, deterministically', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-b', message: message('from-b') });
    h.store.appendMessage({ origin: 'node-a', message: message('from-a') });
    h.store.appendMessage({ origin: 'node-a', message: message('from-a-later') });
    assert.deepEqual(h.reopen().load().messages.map((m) => m.message_id), ['from-a', 'from-a-later', 'from-b']);
  });

  it('stores the E2E envelope and ciphertext verbatim, without interpreting them', () => {
    const h = harness();
    const enc = { v: 2, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', aad: { session_id: 's-1', machine_id: 'm-1', message_id: 'msg-enc' } };
    h.store.appendMessage({ origin: 'node-a', message: message('msg-enc', { text: 'Y2lwaGVy', enc }) });
    const stored = h.reopen().load().messages[0];
    assert.equal(stored.text, 'Y2lwaGVy');
    assert.deepEqual(stored.enc, enc);
  });

  it('keeps only the newest read watermark per (session, machine)', () => {
    const h = harness();
    h.store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-1', at_ms: T0 + 100, message_id: 'msg-1' });
    h.store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-1', at_ms: T0 + 300, message_id: 'msg-3' });
    h.store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-1', at_ms: T0 + 200, message_id: 'msg-2' });
    h.store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-2', at_ms: T0 + 50, message_id: 'msg-1' });
    h.store.appendRead({ origin: 'node-b', session_id: 's-2', machine_id: 'm-1', at_ms: T0 + 400 });

    const marks = h.reopen().load().readMarks;
    assert.equal(marks.length, 3);
    assert.deepEqual(
      marks.find((mark) => mark.session_id === 's-1' && mark.machine_id === 'm-1'),
      { session_id: 's-1', machine_id: 'm-1', at_ms: T0 + 300, message_id: 'msg-3' },
    );
    assert.deepEqual(marks.map((mark) => `${mark.session_id}/${mark.machine_id}`), ['s-1/m-1', 's-1/m-2', 's-2/m-1']);
  });

  it('returns tombstoned session ids, keeping one entry per session', () => {
    const h = harness();
    h.store.appendSessionDeleted({ origin: 'node-a', session_id: 's-1' });
    h.advance(500);
    h.store.appendSessionDeleted({ origin: 'node-b', session_id: 's-1' });
    h.store.appendSessionDeleted({ origin: 'node-a', session_id: 's-2' });
    assert.deepEqual(h.reopen().load().deletedSessions, ['s-1', 's-2']);
  });

  it('filters retention-expired messages and read marks, but never tombstones', () => {
    const h = harness({ retentionDays: 1 });
    h.store.appendSessionDeleted({ origin: 'node-a', session_id: 's-old' });
    h.store.appendMessage({ origin: 'node-a', message: message('old', { at_ms: T0 - 2 * DAY }) });
    h.store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-1', at_ms: T0 - 2 * DAY, message_id: 'old' });
    h.store.appendMessage({ origin: 'node-a', message: message('new', { at_ms: T0 }) });

    const loaded = h.reopen().load();
    assert.deepEqual(loaded.messages.map((m) => m.message_id), ['new']);
    assert.deepEqual(loaded.readMarks, []);
    assert.deepEqual(loaded.deletedSessions, ['s-old']);
    assert.equal(loaded.stats.messages, 1);
    assert.equal(loaded.stats.records, 4, 'retention changes the view, not the log');
  });

  it('refuses malformed local appends instead of writing an unusable row', () => {
    const h = harness();
    assert.throws(() => h.store.appendMessage({ origin: '', message: message('msg-1') }), TypeError);
    assert.throws(() => h.store.appendMessage({ origin: 'node-a', message: {} }), TypeError);
    assert.throws(() => h.store.appendRead({ origin: 'node-a', session_id: '', machine_id: 'm-1' }), TypeError);
    assert.throws(() => h.store.appendSessionDeleted({ origin: 'node-a' }), TypeError);
    assert.equal(h.store.stats().records, 0);
  });
});

describe('exportSlice: pages a peer can resume from', () => {
  it('returns the whole log from offset 0, then an empty EOF page', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-1') });
    h.store.appendMessage({ origin: 'node-a', message: message('msg-2') });
    const size = statSync(h.logFile()).size;
    const page = h.store.exportSlice(0);
    assert.equal(page.generation, 1);
    assert.equal(page.records.length, 2);
    assert.deepEqual(page.records.map((record) => record.offset), [0, 1]);
    assert.equal(page.next_offset, size);
    assert.equal(page.bytes, size);
    assert.equal(page.eof, true);

    const tail = h.store.exportSlice(page.next_offset);
    assert.deepEqual(tail.records, []);
    assert.equal(tail.next_offset, size);
    assert.equal(tail.bytes, 0);
    assert.equal(tail.eof, true);
  });

  it('stops before a line that would overflow the page, never returning half a line', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-1') });
    const firstLineBytes = statSync(h.logFile()).size;
    h.store.appendMessage({ origin: 'node-a', message: message('msg-2') });
    h.store.appendMessage({ origin: 'node-a', message: message('msg-3') });

    const first = h.store.exportSlice(0, firstLineBytes + 5);
    assert.equal(first.records.length, 1);
    assert.equal(first.next_offset, firstLineBytes);
    assert.equal(first.bytes, firstLineBytes);
    assert.equal(first.eof, false);
    assert.deepEqual(first.records[0].data.message_id, 'msg-1');

    const rest = h.store.exportSlice(first.next_offset);
    assert.deepEqual(rest.records.map((record) => record.data.message_id), ['msg-2', 'msg-3']);
    assert.equal(rest.eof, true);
  });

  it('returns a single record larger than the page budget whole', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-big', { text: 'x'.repeat(900) }) });
    const page = h.store.exportSlice(0, 10);
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0].data.message_id, 'msg-big');
    assert.ok(page.bytes > 10, 'the whole line wins over the byte budget');
    assert.equal(page.eof, true);
  });

  it('advances past corrupt and non-conforming lines instead of stalling the cursor', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-1') });
    appendFileSync(h.logFile(), 'this is not JSON\n');
    appendFileSync(h.logFile(), `${JSON.stringify({ v: 1, origin: 'node-b', offset: 0, at_ms: T0, kind: 'chat.unknown', data: {} })}\n`);
    h.store.appendMessage({ origin: 'node-a', message: message('msg-2') });

    const page = h.store.exportSlice(0);
    assert.equal(page.records.length, 2);
    assert.equal(page.next_offset, statSync(h.logFile()).size);
    assert.equal(page.bytes, page.next_offset);
    assert.equal(page.eof, true);
    assert.deepEqual(h.reopen().load().messages.map((m) => m.message_id), ['msg-1', 'msg-2']);
  });

  it('treats a cursor beyond the end of the log as EOF rather than rewinding it', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-1') });
    const size = statSync(h.logFile()).size;
    const page = h.store.exportSlice(size + 1_000);
    assert.deepEqual(page.records, []);
    assert.equal(page.next_offset, size + 1_000);
    assert.equal(page.bytes, 0);
    assert.equal(page.eof, true);
  });
});

describe('importRecord: dedupe and re-export', () => {
  it('applies a peer record once, re-exports it verbatim, and remembers the watermark', () => {
    const h = harness();
    const peer = peerMessage('node-b', 0, 'peer-1', { machine_id: 'm-b' });
    assert.deepEqual(h.store.importRecord(peer), { applied: true, generation: 1 });
    assert.deepEqual(h.store.importRecord(peer), { applied: false, generation: 1 });

    assert.equal(h.store.stats().records, 1, 'the duplicate is not appended twice');
    const exported = h.store.exportSlice(0).records;
    assert.equal(exported.length, 1);
    assert.deepEqual(exported[0], peer, 'origin/offset survive the re-export');
    assert.deepEqual(h.reopen().load().messages, [peer.data]);

    // The watermark is on disk: a fresh process dedupes the same record too.
    const restarted = h.reopen();
    assert.deepEqual(restarted.importRecord(peer), { applied: false, generation: 1 });
    assert.equal(restarted.stats().records, 1);
    const applied = JSON.parse(readFileSync(join(h.chatDir(), 'applied.json'), 'utf8'));
    assert.deepEqual(applied, { v: 1, applied: { 'node-b': 0 } });
  });

  it('uses max-offset dedupe: lower/equal offsets are duplicates, higher offsets are new', () => {
    const h = harness();
    assert.equal(h.store.importRecord(peerMessage('node-b', 5, 'five')).applied, true);
    assert.equal(h.store.importRecord(peerMessage('node-b', 3, 'three')).applied, false);
    assert.equal(h.store.importRecord(peerMessage('node-b', 5, 'five-again')).applied, false);
    assert.equal(h.store.importRecord(peerMessage('node-b', 6, 'six')).applied, true);
    assert.deepEqual(h.reopen().load().messages.map((m) => m.message_id), ['five', 'six']);
    assert.equal(h.store.stats().records, 2);
  });

  it('imports read marks and deletion tombstones as first-class records', () => {
    const h = harness();
    h.store.importRecord({ v: 1, origin: 'node-b', offset: 0, at_ms: T0, kind: 'chat.read', data: { session_id: 's-1', machine_id: 'm-b', at_ms: T0, message_id: 'msg-1' } });
    h.store.importRecord({ v: 1, origin: 'node-b', offset: 1, at_ms: T0, kind: 'chat.session.deleted', data: { session_id: 's-1' } });
    const loaded = h.reopen().load();
    assert.deepEqual(loaded.readMarks, [{ session_id: 's-1', machine_id: 'm-b', at_ms: T0, message_id: 'msg-1' }]);
    assert.deepEqual(loaded.deletedSessions, ['s-1']);
  });

  it('rejects a malformed record instead of writing it', () => {
    const h = harness();
    const broken = [
      null,
      {},
      { v: 1, origin: '', offset: 0, at_ms: T0, kind: 'chat.message', data: message('x') },
      { v: 1, origin: 'node-b', offset: -1, at_ms: T0, kind: 'chat.message', data: message('x') },
      { v: 1, origin: 'node-b', offset: 0, at_ms: T0, kind: 'chat.message', data: { message_id: 'x' } },
      { v: 2, origin: 'node-b', offset: 0, at_ms: T0, kind: 'chat.message', data: message('x') },
    ];
    for (const record of broken) {
      assert.deepEqual(h.store.importRecord(record), { applied: false, generation: 1 }, JSON.stringify(record));
    }
    assert.equal(h.store.stats().records, 0);
    assert.equal(existsSync(h.logFile()), false);
  });

  it('keeps local offsets monotonic and distinct from imported offsets', () => {
    const h = harness();
    assert.equal(h.store.importRecord(peerMessage('node-b', 4, 'peer')).applied, true);
    const one = h.store.appendMessage({ origin: 'node-a', message: message('local-1') });
    const two = h.store.appendMessage({ origin: 'node-a', message: message('local-2') });
    assert.equal(one.offset, 0);
    assert.equal(two.offset, 1);
    assert.deepEqual(h.reopen().exportSlice(0).records.map((record) => `${record.origin}@${record.offset}`), ['node-b@4', 'node-a@0', 'node-a@1']);
  });
});

describe('prune: retention, hard cap and generations', () => {
  it('drops expired messages and superseded/expired read marks while keeping tombstones', () => {
    const h = harness({ retentionDays: 1 });
    h.store.appendMessage({ origin: 'node-a', message: message('old', { at_ms: T0 - 2 * DAY }) });
    h.store.appendMessage({ origin: 'node-a', message: message('fresh', { at_ms: T0 - 1_000 }) });
    h.store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-1', at_ms: T0 - 2 * DAY, message_id: 'old' });
    h.store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-1', at_ms: T0 - 500, message_id: 'fresh' });
    h.store.appendRead({ origin: 'node-a', session_id: 's-1', machine_id: 'm-2', at_ms: T0 - 100, message_id: 'fresh' });
    h.store.appendSessionDeleted({ origin: 'node-a', session_id: 's-deleted' });

    const pruned = h.store.prune();
    assert.equal(pruned.generation, 2);
    assert.equal(pruned.removed_messages, 1);
    assert.equal(pruned.removed_records, 2, 'expired message + expired read');
    assert.equal(pruned.kept_records, 4, 'fresh message + two read winners + tombstone');
    assert.equal(pruned.bytes, statSync(h.logFile()).size);

    const loaded = h.reopen().load();
    assert.deepEqual(loaded.messages.map((m) => m.message_id), ['fresh']);
    assert.equal(loaded.readMarks.length, 2);
    assert.deepEqual(loaded.deletedSessions, ['s-deleted']);
    assert.equal(loaded.stats.records, 4);
  });

  it('drops the oldest messages until the rewritten log fits the hard cap', () => {
    const dir = tempDir();
    const clock = () => T0;
    const probe = createChatStore({ dir, now: clock });
    probe.appendMessage({ origin: 'node-a', message: message('oldest', { at_ms: T0 + 1_000 }) });
    probe.appendMessage({ origin: 'node-a', message: message('middle', { at_ms: T0 + 2_000 }) });
    probe.appendMessage({ origin: 'node-a', message: message('newest', { at_ms: T0 + 3_000 }) });
    const lines = readFileSync(join(dir, 'chat', 'replication.jsonl'), 'utf8').trim().split('\n');
    const cap = Buffer.byteLength(lines[1], 'utf8') + 1 + Buffer.byteLength(lines[2], 'utf8') + 1;

    const store = createChatStore({ dir, now: clock, hardCapBytes: cap });
    const pruned = store.prune();
    assert.equal(pruned.removed_messages, 1);
    assert.equal(pruned.kept_records, 2);
    assert.ok(pruned.bytes <= cap, `${pruned.bytes} <= ${cap}`);
    assert.deepEqual(store.load().messages.map((m) => m.message_id), ['middle', 'newest']);
  });

  it('never bumps the generation for a no-op prune, so peers are not forced to re-pull', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-1') });
    const before = h.store.stats();
    const pruned = h.store.prune();
    assert.equal(pruned.generation, 1);
    assert.equal(pruned.removed_records, 0);
    assert.equal(pruned.kept_records, 1);
    assert.equal(h.store.stats().generation, 1);
    assert.equal(h.store.exportSlice(0).generation, 1);
    assert.equal(statSync(h.logFile()).size, before.bytes);
  });

  it('bumps the generation, persists it, and keeps next_local_offset monotonic', () => {
    const h = harness({ retentionDays: 0 });
    h.store.appendMessage({ origin: 'node-a', message: message('expired', { at_ms: T0 - 1 }) });
    const pruned = h.store.prune();
    assert.equal(pruned.generation, 2);
    assert.equal(pruned.removed_messages, 1);
    const state = JSON.parse(readFileSync(join(h.chatDir(), 'state.json'), 'utf8'));
    assert.deepEqual(state, { v: 1, generation: 2, next_local_offset: 1 }, 'offsets never rewind');

    const next = h.store.appendMessage({ origin: 'node-a', message: message('after-prune') });
    assert.equal(next.offset, 1);
    assert.equal(h.reopen().stats().next_local_offset, 2);
    const page = h.reopen().exportSlice(0);
    assert.equal(page.generation, 2);
    assert.deepEqual(page.records.map((record) => record.data.message_id), ['after-prune']);
  });
});

describe('damaged/partial files are tolerated', () => {
  it('skips corrupt JSON lines and torn trailing bytes, and terminates a torn line before appending', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-1') });
    const logPath = h.logFile();
    appendFileSync(logPath, 'not json at all\n');
    appendFileSync(logPath, '{"v":1,"origin":"node-b","offset":0,'); // torn: no newline

    const loaded = h.reopen().load();
    assert.deepEqual(loaded.messages.map((m) => m.message_id), ['msg-1']);
    assert.equal(loaded.stats.records, 1);

    // A later append must not glue itself onto the torn line.
    h.reopen().appendMessage({ origin: 'node-a', message: message('msg-2') });
    const after = h.reopen().load();
    assert.deepEqual(after.messages.map((m) => m.message_id), ['msg-1', 'msg-2']);
    assert.equal(after.stats.records, 2);
    const page = h.reopen().exportSlice(0);
    assert.equal(page.records.length, 2);
    assert.equal(page.eof, true);
  });

  it('recovers a lost state.json from the log instead of reusing an offset', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-1') });
    assert.equal(h.store.stats().next_local_offset, 1);
    rmSync(join(h.chatDir(), 'state.json'));

    const record = h.reopen().appendMessage({ origin: 'node-a', message: message('msg-2') });
    assert.equal(record.offset, 1, 'the log already proves node-a used offset 0');
    assert.equal(h.reopen().stats().next_local_offset, 2);
  });

  it('keeps the documents on disk to their contract shape and file modes (POSIX)', { skip: process.platform === 'win32' }, () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-1') });
    h.store.importRecord(peerMessage('node-b', 0, 'peer-1'));
    h.store.appendSessionDeleted({ origin: 'node-a', session_id: 's-1' });

    assert.equal(statSync(h.chatDir()).mode & 0o777, 0o700);
    for (const name of ['replication.jsonl', 'state.json', 'applied.json']) {
      assert.equal(statSync(join(h.chatDir(), name)).mode & 0o777, 0o600, name);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(h.chatDir(), 'state.json'), 'utf8')), { v: 1, generation: 1, next_local_offset: 2 });
  });
});

/**
 * Phase 2 condition 4: deletion has to close. `load()` used to return the tombstoned session ids but keep the
 * messages, so a restart (or a fresh node that pulled the whole log) re-seeded a conversation the operator had
 * deleted. These are the three readings that make "deleted" mean deleted: the loader filters, a late import is
 * filtered too, and compaction drops the dead rows while keeping the tombstone that stops resurrection.
 */
describe('deletion semantics: a tombstone wins over any message', () => {
  it('load() hides a tombstoned session, including a message imported after the deletion', () => {
    const h = harness();
    h.store.appendMessage({ origin: 'node-a', message: message('msg-before', { at_ms: T0 - 5_000 }) });
    h.store.appendSessionDeleted({ origin: 'node-a', session_id: 's-1' });
    // A peer that had not seen the deletion yet ships an older message back in.
    const imported = h.store.importRecord(peerMessage('node-b', 3, 'msg-late', { at_ms: T0 + 60_000 }));
    assert.equal(imported.applied, true);

    const loaded = h.reopen().load();
    assert.deepEqual(loaded.messages, [], 'a deleted conversation does not come back on restart');
    assert.deepEqual(loaded.deletedSessions, ['s-1']);
    assert.equal(loaded.stats.messages, 0);
    assert.equal(loaded.stats.records, 3, 'the raw log keeps the rows until prune; the view does not');
  });

  it('only the tombstoned session is hidden; another session in the same log still loads', () => {
    const h = harness();
    h.store.appendSessionDeleted({ origin: 'node-a', session_id: 's-deleted' });
    h.store.appendMessage({ origin: 'node-a', message: message('alive', { session_id: 's-kept' }) });
    const loaded = h.reopen().load();
    assert.deepEqual(loaded.messages.map((m) => m.message_id), ['alive']);
    assert.deepEqual(loaded.deletedSessions, ['s-deleted']);
  });

  it('prune() drops the tombstoned rows, keeps the tombstone, and bumps the generation', () => {
    const h = harness();
    h.store.appendSessionDeleted({ origin: 'node-a', session_id: 's-1' });
    h.store.appendMessage({ origin: 'node-a', message: message('dead') });
    h.store.appendMessage({ origin: 'node-a', message: message('alive', { session_id: 's-2' }) });

    const pruned = h.store.prune();
    assert.equal(pruned.removed_messages, 1);
    assert.equal(pruned.removed_records, 1);
    assert.equal(pruned.kept_records, 2, 'tombstone + the live message');
    assert.equal(pruned.generation, 2);

    const loaded = h.reopen().load();
    assert.deepEqual(loaded.messages.map((m) => m.message_id), ['alive']);
    assert.deepEqual(loaded.deletedSessions, ['s-1'], 'the tombstone is retained forever');
    assert.equal(loaded.stats.records, 2);
  });
});
