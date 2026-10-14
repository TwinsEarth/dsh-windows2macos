/**
 * Individual-memory suite (v0.9.6): the per-machine record of what this box did.
 *
 * The harness is a local copy rather than a shared import, matching the convention in
 * test/p2p-signaling.test.mjs and test/relay.test.mjs: suites here must not be able to break each other
 * by editing a common helper.
 *
 * What these tests are actually protecting, stated once so a later reader does not have to infer it:
 * the relay keeps hashes and never text, so this file is the only place a command's *meaning* survives.
 * A regression here does not fail a task -- it silently removes the fleet's ability to answer "what did
 * we already try, and what happened?", which is the failure this whole layer exists to end.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_ARGV_LIMIT,
  MEMORY_FILE,
  MEMORY_FILE_PREVIOUS,
  MEMORY_TAIL_BYTES,
  appendMemory,
  memoryRecord,
  readMemory,
} from '../src/agent/memory.mjs';

const cleanup = [];
after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'w2m-memory-'));
  cleanup.push(dir);
  return dir;
}

/** An envelope shaped like the ones `makeEnvelope` produces, with only the fields memory reads. */
function envelope(over = {}) {
  return {
    task_id: 'TASK-1',
    attempt: 1,
    machine_id: 'machine-1',
    machine_name: 'test-box',
    mode: 'replicate',
    exit_code: 0,
    status: 'ok',
    refusal_reason: null,
    transport: 'relay',
    stdout_tail: 'all checks passed',
    stderr_tail: '',
    stdout_sha256: 'a'.repeat(64),
    stdout_bytes: 17,
    ...over,
  };
}

function record(over = {}) {
  return memoryRecord({
    envelope: envelope(over.envelope),
    commandArgv: over.commandArgv ?? ['node', '--test'],
    cwdRel: over.cwdRel ?? '.',
    ms: over.ms ?? 4120,
    now: over.now ?? Date.UTC(2026, 9, 14, 13, 18, 46),
  });
}

describe('individual memory: what a record keeps', () => {
  it('keeps the question a reader actually asks, in one line', () => {
    const r = record();
    assert.equal(r.task_id, 'TASK-1');
    assert.deepEqual(r.argv, ['node', '--test']);
    assert.equal(r.cwd_rel, '.');
    assert.equal(r.exit_code, 0);
    assert.equal(r.status, 'ok');
    assert.equal(r.ms, 4120);
    assert.equal(r.stdout_tail, 'all checks passed');
    assert.equal(r.transport, 'relay');
    assert.equal(r.at, '2026-10-14T13:18:46.000Z');
  });

  it('never invents a conclusion: only w2m_memory may fill that in', () => {
    // The design separates fact from interpretation, and a machine writing the fact is not entitled to
    // the interpretation. If this ever became non-null on the writing side, a later reader could not tell
    // a measured outcome from an asserted meaning.
    const r = record();
    assert.equal(r.conclusion, null);
    assert.deepEqual(r.tags, []);
  });

  it('repeats the envelope hashes, so the readable record ties to the tamper-evident one', () => {
    const r = record();
    assert.equal(r.stdout_sha256, 'a'.repeat(64));
    assert.equal(r.stdout_bytes, 17);
  });
});

describe('individual memory: bounds are enforced, not hoped for', () => {
  it('clamps a tail longer than the cap and says so', () => {
    const r = record({ envelope: { stdout_tail: 'x'.repeat(50_000) } });
    assert.ok(r.stdout_tail.length <= MEMORY_TAIL_BYTES + 80, `tail was ${r.stdout_tail.length}`);
    assert.match(r.stdout_tail, /truncated at/);
  });

  it('clamps the argv and records what it was shortened from', () => {
    const r = record({ commandArgv: Array.from({ length: 100 }, (_, i) => `arg${i}`) });
    assert.equal(r.argv.length, MEMORY_ARGV_LIMIT);
    assert.equal(r.argv_truncated_from, 100);
  });

  it('leaves a short argv untouched, with no truncation marker', () => {
    const r = record({ commandArgv: ['node', '-e', 'x'] });
    assert.deepEqual(r.argv, ['node', '-e', 'x']);
    assert.equal('argv_truncated_from' in r, false);
  });

  it('turns an empty stderr into null rather than an empty string', () => {
    // "produced nothing" and "produced an empty string" are different, and only one of them is worth
    // storing. This is also what keeps a record's shape stable when compared by eye.
    assert.equal(record().stderr_tail, null);
  });
});

describe('individual memory: append and read', () => {
  it('writes one line per task and reads it back', () => {
    const dir = tempDir();
    const write = appendMemory(dir, record());
    assert.equal(write.ok, true);
    assert.equal(write.rotated, false);

    const path = join(dir, MEMORY_FILE);
    assert.equal(existsSync(path), true);
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
    // Append-only: a second task adds a line rather than rewriting the file.
    appendMemory(dir, record({ envelope: { task_id: 'TASK-2' } }));
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2);
  });

  it('returns newest first, by file position rather than by parsing every timestamp', () => {
    const dir = tempDir();
    appendMemory(dir, record({ envelope: { task_id: 'old' } }));
    appendMemory(dir, record({ envelope: { task_id: 'new' } }));
    const { records } = readMemory(dir, { limit: 10 });
    assert.equal(records[0].task_id, 'new');
    assert.equal(records[1].task_id, 'old');
  });

  it('honours the limit and reports that it truncated', () => {
    const dir = tempDir();
    for (let i = 0; i < 5; i += 1) appendMemory(dir, record({ envelope: { task_id: `T${i}` } }));
    const { records, truncated } = readMemory(dir, { limit: 3 });
    assert.equal(records.length, 3);
    assert.equal(truncated, true);
  });

  it('skips a malformed line instead of failing the whole read', () => {
    // A machine losing power mid-append leaves a partial final line. One damaged line must not make the
    // rest unreadable -- the relay's own ledger behaves this way (`ledger_lines_skipped`) for this reason.
    const dir = tempDir();
    appendMemory(dir, record({ envelope: { task_id: 'good-1' } }));
    appendFileSync(join(dir, MEMORY_FILE), '{ not json at all\n');
    appendMemory(dir, record({ envelope: { task_id: 'good-2' } }));

    const { records, skipped } = readMemory(dir, { limit: 10 });
    assert.equal(skipped, 1);
    assert.deepEqual(records.map((r) => r.task_id), ['good-2', 'good-1']);
  });

  it('reads an absent file as empty rather than as an error', () => {
    const { records, skipped } = readMemory(tempDir(), { limit: 10 });
    assert.deepEqual(records, []);
    assert.equal(skipped, 0);
  });
});

describe('individual memory: rotation keeps the file bounded', () => {
  it('rotates at the cap, keeps one previous generation, and starts the live file fresh', () => {
    const dir = tempDir();
    const path = join(dir, MEMORY_FILE);
    const cap = 4096;

    appendMemory(dir, record({ envelope: { task_id: 'fills-the-cap' } }), { maxBytes: cap });
    // Sized past the cap rather than growing to it: this test is about the rotation boundary itself, and
    // reaching it record by record is the other test's job.
    writeFileSync(path, 'x'.repeat(cap + 1));

    const write = appendMemory(dir, record({ envelope: { task_id: 'after-rotation' } }), { maxBytes: cap });
    assert.equal(write.ok, true);
    assert.equal(write.rotated, true);
    assert.equal(existsSync(join(dir, MEMORY_FILE_PREVIOUS)), true);

    // The live file holds exactly the new record, not the old bulk.
    assert.ok(statSync(path).size < 1024, `live file was ${statSync(path).size} bytes`);
    const { records } = readMemory(dir, { limit: 10 });
    assert.equal(records.length, 1);
    assert.equal(records[0].task_id, 'after-rotation');
  });

  it('does not rotate below the cap', () => {
    const dir = tempDir();
    const write = appendMemory(dir, record());
    assert.equal(write.rotated, false);
    assert.equal(existsSync(join(dir, MEMORY_FILE_PREVIOUS)), false);
  });

  it('the previous generation is readable, so the rotation boundary is not a blind spot', () => {
    const dir = tempDir();
    const path = join(dir, MEMORY_FILE);

    // A small cap and *real* records, rather than eight megabytes of filler.
    //
    // The first version of this test wrote `'x'.repeat(MEMORY_MAX_BYTES + 1)` to trip the cap: it rotated,
    // but it could not answer the question being asked, because the previous generation then held one
    // unparseable line -- "is the far side of the rotation readable" cannot be answered by a file that was
    // never readable. The second version padded records to reach the real cap and never got there, which
    // is its own lesson: `memoryRecord` clamps a tail to `MEMORY_TAIL_BYTES`, so a record cannot be made
    // arbitrarily large and the arithmetic I had assumed was simply wrong.
    const cap = 8 * 1024;
    let written = 0;
    const sizeOf = () => (existsSync(path) ? statSync(path).size : 0);
    while (sizeOf() < cap && written < 50) {
      appendMemory(dir, record({ envelope: { task_id: `before-${written}` } }), { maxBytes: cap });
      written += 1;
    }
    assert.ok(written < 50, `the cap should be reached well before 50 records (stopped at ${written})`);

    const write = appendMemory(dir, record({ envelope: { task_id: 'after-rotation' } }), { maxBytes: cap });
    assert.equal(write.rotated, true);

    // The whole point: records on the far side of the rotation are still records.
    const prev = readMemory(dir, { limit: 5, previous: true });
    assert.equal(prev.skipped, 0, 'the previous generation must contain no damaged lines');
    assert.ok(prev.records.length > 0, 'the previous generation must not be empty');
    assert.match(prev.records[0].task_id, /^before-/);
  });
});

describe('individual memory: a note about the work must never fail the work', () => {
  it('appendMemory returns a failure value instead of throwing', () => {
    // The caller in agent.mjs deliberately ignores this result. That is only safe while this function
    // cannot throw, so the property is asserted here rather than assumed there.
    const bad = appendMemory('', record());
    assert.equal(bad.ok, false);
    assert.match(bad.error, /MEMORY_NO_STATE_DIR/);
  });

  it('readMemory returns a failure value instead of throwing', () => {
    const bad = readMemory('');
    assert.deepEqual(bad.records, []);
    assert.match(bad.error, /MEMORY_NO_STATE_DIR/);
  });

  it('creates the state directory when it is missing', () => {
    const dir = join(tempDir(), 'nested', 'state');
    const write = appendMemory(dir, record());
    assert.equal(write.ok, true);
    assert.equal(existsSync(join(dir, MEMORY_FILE)), true);
  });
});
