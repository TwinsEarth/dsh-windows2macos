/**
 * Gate G4: the seq renumber tool (`src/backup/renumber.mjs`) and its CLI (`w2m-fix renumber`).
 *
 * What these protect, said once: deleting or inserting an event is only legal through one path that renumbers
 * `seq` densely, rewrites every `*Seq` reference, refuses a reference to a deleted event, recomputes the inherited
 * event count, and validates the RESULT with the static doctor + future-append simulation + the installed Harness
 * before any byte is written. Every successful apply leaves a `.bak-<timestamp>` copy.
 *
 * Most cases run in static-only mode (`allowStaticValidation: true` + an injected `harness: null`) so they are
 * deterministic and do not spawn a runtime. The one case that MUST use the installed Harness (a log the doctor
 * accepts and the app refuses) skips by name on a machine without an installation; the "no installation" branch is
 * forced deterministically in a sibling case.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RENUMBER_CODES, applyRenumber, DEFAULT_KEEP_RENUMBER_BACKUPS, listRenumberBackups, planRenumber, pruneRenumberBackups, renumberBuffer } from '../src/backup/renumber.mjs';
import { findHarnessInstallation, runtimeValidate } from '../src/backup/runtime-validate.mjs';
import { sha256Hex } from '../src/backup/manifest.mjs';
import { decompressFrame, scanFrames } from '../src/fix/zstd.mjs';
import { diagnoseSessionBuffer } from '../src/util/session-validate.mjs';
import { framesFor, header, put, runtimeValidSessionLog, sessionLog, tempDir } from './helpers/backup-fixture.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'w2m-fix.mjs');

/** The installed Harness is the only evidence path; read its presence ONCE so the skip decision is stable. */
const harness = findHarnessInstallation();

/** Static-only validation: deterministic, no `Harness` spawn, and the plan says `runtime_verified: false`. */
const STATIC_ONLY = { allowStaticValidation: true, harness: null };

const CLEANUPS = [];
after(() => {
  for (const cleanup of CLEANUPS) {
    try {
      cleanup();
    } catch {
      // A leftover temp directory must not turn a green suite red.
    }
  }
});

/** A throwaway directory containing one log file, remembered for cleanup. */
function fixtureFile(buffer, name = 'session.v4.jsonl.zstd') {
  const { dir, cleanup } = tempDir('w2m-renumber-');
  CLEANUPS.push(cleanup);
  const file = put(path.join(dir, name), buffer);
  return { dir, file };
}

/** Decode a log into its rows and frame offsets, the way the runtime sees it. */
function decodeLog(buffer) {
  const { frames, tornStart } = scanFrames(buffer);
  const rows = [];
  const linesPerFrame = [];
  for (const frame of frames) {
    const text = decompressFrame(buffer.subarray(frame.start, frame.end));
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    linesPerFrame.push(lines.length);
    for (const line of lines) rows.push(JSON.parse(line));
  }
  return { frames, linesPerFrame, rows, tornStart };
}

/** Sibling copies the renumber tool writes. */
function backupSiblings(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-`;
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
}

/**
 * A statically healthy log with all the reference shapes the drill measured, carried by events that SURVIVE the
 * delete: an array reference (`sourceEventSeqs`), a nested array reference (`nested.anchorSeqs`), an
 * object-surface reference (`surfaceOp.{startSeq,endSeq}`) and a plain `messageSeqs` array. Seq 2 is the event the
 * delete tests remove, and it carries no references of its own (a reference inside the deleted event disappears
 * with it, which would make the rewrite count prove nothing).
 */
function referenceLog(sessionId = 'session-aaaaaaaa-0001') {
  return framesFor([
    header(sessionId),
    { type: 'system/message', seq: 0, time: 1000, data: { content: [{ type: 'text', text: 'hello' }] } },
    {
      type: 'user/message',
      seq: 1,
      time: 1001,
      surfaceOp: 'append',
      data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, refs: { sourceEventSeqs: [0, 3], nested: { anchorSeqs: [1, 3] } } },
    },
    { type: 'tool/call', seq: 2, time: 1002, data: { callId: 'gone' } },
    { type: 'tool/result', seq: 3, time: 1003, data: { callId: 'c1', ok: true } },
    {
      type: 'assistant/message',
      seq: 4,
      time: 1004,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 4 },
      data: { messageSeqs: [0, 3, 4] },
    },
  ]);
}

/** A log whose `tool/call` at seq 1 references the event at seq 2 (the dangling-reference fixture). */
function referencedTailLog(sessionId = 'session-cccccccc-0003') {
  return framesFor([
    header(sessionId),
    { type: 'turn/start', seq: 0, time: 3000, data: { turn: 1 } },
    { type: 'tool/call', seq: 1, time: 3001, data: { callId: 'c3', refs: { sourceEventSeqs: [2] } } },
    { type: 'turn/end', seq: 2, time: 3002, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
}

/** A log with references at several depths, used by the insert tests. */
function insertLog(sessionId = 'session-bbbbbbbb-0002') {
  return framesFor([
    header(sessionId),
    { type: 'turn/start', seq: 0, time: 2000, data: { turn: 1 } },
    {
      type: 'tool/call',
      seq: 1,
      time: 2001,
      data: { callId: 'c9', refs: { sourceEventSeqs: [0, 1], parentSeq: 1, deep: { anchorSeqs: [2] } } },
    },
    { type: 'tool/result', seq: 2, time: 2002, data: { callId: 'c9' } },
    { type: 'turn/end', seq: 3, time: 2003, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
}

const LEGAL_APPEND_EVENT = { type: 'permission/preset', time: 2005, data: { preset: 'workspace-write' } };

describe('renumber: deleting an event renumbers densely and rewrites every reference', () => {
  const sessionId = 'session-aaaaaaaa-0001';

  it('builds the fixture as a statically healthy log (the precondition the tool relies on)', () => {
    const verdict = diagnoseSessionBuffer(referenceLog(sessionId), { expectedSessionId: sessionId });
    assert.equal(verdict.ok, true, verdict.codes.join(', '));
    assert.equal(verdict.events, 5);
  });

  it('deletes a middle event: dense seqs, recursive reference rewrite, inherited count, header preserved', () => {
    const original = referenceLog(sessionId);
    const result = renumberBuffer(original, { deleteSeqs: [2] });

    assert.equal(result.ok, true, JSON.stringify(result.detail));
    assert.equal(result.changed, true);
    assert.equal(result.events_before, 5);
    assert.equal(result.events_after, 4);
    assert.equal(result.session_id, sessionId);
    assert.equal(result.inherited_event_count, 0);
    assert.deepEqual(result.mapping, { 3: 2, 4: 3 });
    assert.equal(result.rewritten_references, 5, 'sourceEventSeqs 3->2, anchorSeqs 3->2, messageSeqs 3->2 and 4->3, endSeq 4->3');
    assert.equal(result.codes.length, 0);

    const { rows, linesPerFrame } = decodeLog(result.buffer);
    assert.equal(rows.length, 5, 'header + 4 events');
    assert.deepEqual(linesPerFrame, [1, 1, 1, 1, 1], 'header alone in frame 1, then one frame per event');
    assert.deepEqual(rows[0], header(sessionId), 'the header is preserved verbatim');
    assert.deepEqual(rows.slice(1).map((event) => event.seq), [0, 1, 2, 3], 'seq is the dense index');

    const user = rows.find((event) => event.type === 'user/message');
    assert.deepEqual(user.data.refs.sourceEventSeqs, [0, 2], 'the deleted event was removed from the reference list');
    assert.deepEqual(user.data.refs.nested.anchorSeqs, [1, 2], 'nested *Seqs arrays obey the same rule');
    assert.equal(user.data.message.content[0].text, 'hi', 'unrelated fields are untouched');

    const assistant = rows.find((event) => event.type === 'assistant/message');
    assert.deepEqual(assistant.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 3 }, 'surfaceOp.{startSeq,endSeq} are rewritten');
    assert.deepEqual(assistant.data.messageSeqs, [0, 2, 3], 'messageSeqs are rewritten');
    assert.equal(rows.some((event) => event.type === 'tool/call' && event.data.callId === 'gone'), false, 'the deleted event is gone');
    assert.equal(rows.find((event) => event.type === 'tool/result').data.callId, 'c1', 'the event after the deleted one survived');

    const verdict = diagnoseSessionBuffer(result.buffer, { expectedSessionId: sessionId });
    assert.equal(verdict.ok, true, verdict.codes.join(', '));
    assert.equal(verdict.events, 4);
  });

  it('plans against the same fixture with static-only evidence (no write, doctor labels the pre-filter)', () => {
    const { file } = fixtureFile(referenceLog(sessionId));
    const plan = planRenumber({ file, deleteSeqs: [2], ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.changed, true);
    assert.deepEqual(plan.mapping, { 3: 2, 4: 3 });
    assert.equal(plan.validation.static.ok, true);
    assert.equal(plan.validation.runtime_verified, false);
    assert.match(plan.backup_file, /\.bak-\d{8}T\d{6}Z$/);
    assert.equal(plan.detail.includes('static-only'), true, plan.detail);
  });
});

describe('renumber: inserting an event shifts references (and appending is the atSeq === length case)', () => {
  const sessionId = 'session-bbbbbbbb-0002';

  it('inserts before atSeq and shifts every existing reference plus the inserted event\'s own reference', () => {
    const inserted = { ...LEGAL_APPEND_EVENT, data: { preset: 'workspace-write', expectedSeqs: [2] } };
    const result = renumberBuffer(insertLog(sessionId), { insert: [{ atSeq: 1, event: inserted }] });

    assert.equal(result.ok, true, JSON.stringify(result.detail));
    assert.equal(result.changed, true);
    assert.equal(result.events_before, 4);
    assert.equal(result.events_after, 5);
    assert.deepEqual(result.mapping, { 1: 2, 2: 3, 3: 4 });
    assert.equal(result.rewritten_references, 4, 'sourceEventSeqs 1->2, parentSeq 1->2, anchorSeqs 2->3, expectedSeqs 2->3');

    const { rows } = decodeLog(result.buffer);
    assert.deepEqual(rows.slice(1).map((event) => event.seq), [0, 1, 2, 3, 4]);
    const placed = rows[2]; // rows[0] is the header, rows[1] is old event 0, so the inserted event is rows[2]
    assert.equal(placed.type, 'permission/preset');
    assert.deepEqual(placed.data.expectedSeqs, [3], 'references carried by an inserted event are mapped against PRE-edit seqs');

    const call = rows.find((event) => event.type === 'tool/call');
    assert.deepEqual(call.data.refs.sourceEventSeqs, [0, 2]);
    assert.equal(call.data.refs.parentSeq, 2);
    assert.deepEqual(call.data.refs.deep.anchorSeqs, [3]);
    assert.equal(rows[rows.length - 1].type, 'turn/end');
    assert.equal(rows[rows.length - 1].seq, 4);

    const verdict = diagnoseSessionBuffer(result.buffer, { expectedSessionId: sessionId });
    assert.equal(verdict.ok, true, verdict.codes.join(', '));
  });

  it('appends when atSeq === events.length, with no seq remapping at all', () => {
    const original = insertLog(sessionId);
    const result = renumberBuffer(original, { insert: [{ atSeq: 4, event: { ...LEGAL_APPEND_EVENT } }] });

    assert.equal(result.ok, true, JSON.stringify(result.detail));
    assert.equal(result.events_after, 5);
    assert.deepEqual(result.mapping, {});
    assert.equal(result.rewritten_references, 0);
    const { rows } = decodeLog(result.buffer);
    assert.equal(rows[rows.length - 1].type, 'permission/preset');
    assert.equal(rows[rows.length - 1].seq, 4);
    assert.equal(rows[rows.length - 1].data.preset, 'workspace-write');
    assert.equal(diagnoseSessionBuffer(result.buffer, { expectedSessionId: sessionId }).ok, true);
  });
});

describe('renumber: refusals are named and write nothing', () => {
  it('refuses a reference to a deleted event instead of guessing a replacement', () => {
    const { file } = fixtureFile(referencedTailLog('session-cccccccc-0003'));
    const before = fs.readFileSync(file);

    const direct = renumberBuffer(before, { deleteSeqs: [2] });
    assert.equal(direct.ok, false);
    assert.deepEqual(direct.codes, [RENUMBER_CODES.DANGLING_REFERENCE]);
    assert.equal(direct.detail.references[0].event_type, 'tool/call');
    assert.equal(direct.detail.references[0].key, 'sourceEventSeqs');
    assert.equal(direct.detail.references[0].seq, 2);
    assert.equal(direct.detail.references[0].deleted, true);

    const plan = planRenumber({ file, deleteSeqs: [2], ...STATIC_ONLY });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason_code, RENUMBER_CODES.DANGLING_REFERENCE);
    assert.match(plan.detail, /seq 2/);
    assert.equal(plan.new_bytes, null, 'a refusal carries no bytes to write');

    const applied = applyRenumber({ plan });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason_code, RENUMBER_CODES.DANGLING_REFERENCE);
    assert.equal(fs.readFileSync(file).equals(before), true, 'the file is byte-identical');
    assert.deepEqual(backupSiblings(file), [], 'no backup is written for a refusal');
  });

  it('refuses a torn log (partial trailing frame) and leaves the file untouched', () => {
    const valid = sessionLog('session-dddddddd-0004');
    const torn = Buffer.concat([valid, Buffer.from([0x28, 0xb5, 0x2f, 0xfd])]);
    assert.notEqual(scanFrames(torn).tornStart, undefined);

    const direct = renumberBuffer(torn, {});
    assert.equal(direct.ok, false);
    assert.deepEqual(direct.codes, [RENUMBER_CODES.TORN_INPUT]);

    const { file } = fixtureFile(torn);
    const before = fs.readFileSync(file);
    const plan = planRenumber({ file, ...STATIC_ONLY });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason_code, RENUMBER_CODES.TORN_INPUT);
    applyRenumber({ plan });
    assert.equal(fs.readFileSync(file).equals(before), true);
    assert.deepEqual(backupSiblings(file), []);
  });

  it('refuses a log that is already gapped (edit addresses would be ambiguous)', () => {
    const gapped = framesFor([
      header('session-eeeeeeee-0005'),
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 3, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    const result = renumberBuffer(gapped, { deleteSeqs: [1] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.codes, [RENUMBER_CODES.INPUT_INVALID]);
    assert.match(result.detail.message, /dense zero-based seq/);
  });

  it('refuses out-of-range edits and an inserted session header event', () => {
    const buffer = sessionLog('session-eeeeeeee-0005');
    assert.deepEqual(renumberBuffer(buffer, { deleteSeqs: [2] }).codes, [RENUMBER_CODES.INPUT_INVALID]);
    assert.deepEqual(renumberBuffer(buffer, { insert: [{ atSeq: 3, event: LEGAL_APPEND_EVENT }] }).codes, [RENUMBER_CODES.INPUT_INVALID]);
    assert.deepEqual(renumberBuffer(buffer, { insert: [{ atSeq: 1, event: { type: 'session' } }] }).codes, [RENUMBER_CODES.INPUT_INVALID]);
  });
});

describe('renumber: a dense log with no edits is a no-op', () => {
  it('returns the caller\'s bytes unchanged and applies nothing', () => {
    const sessionId = 'session-ffffffff-0006';
    const buffer = sessionLog(sessionId);
    const core = renumberBuffer(buffer, {});
    assert.equal(core.ok, true);
    assert.equal(core.changed, false);
    assert.equal(core.buffer, buffer, 'an unchanged log is handed back, not re-encoded');
    assert.deepEqual(core.mapping, {});
    assert.equal(core.events_before, 2);
    assert.equal(core.events_after, 2);

    const { file } = fixtureFile(buffer);
    const before = fs.readFileSync(file);
    const plan = planRenumber({ file, ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.changed, false);
    assert.equal(plan.backup_file, null);

    const applied = applyRenumber({ plan });
    assert.equal(applied.ok, true);
    assert.equal(applied.changed, false);
    assert.equal(applied.bytes, 0);
    assert.equal(applied.backup_file, null);
    assert.equal(fs.readFileSync(file).equals(before), true);
    assert.deepEqual(backupSiblings(file), []);
  });

  it('is idempotent: a second plan on the written log reports changed:false', () => {
    const { file } = fixtureFile(referenceLog('session-aaaaaaaa-0001'));
    const plan = planRenumber({ file, deleteSeqs: [2], ...STATIC_ONLY });
    const applied = applyRenumber({ plan });
    assert.equal(applied.ok, true, applied.detail);
    const written = fs.readFileSync(file);

    const again = planRenumber({ file, ...STATIC_ONLY });
    assert.equal(again.ok, true, again.detail);
    assert.equal(again.changed, false, 'the written log is already dense');
    const secondApply = applyRenumber({ plan: again });
    assert.equal(secondApply.ok, true);
    assert.equal(secondApply.bytes, 0);
    assert.equal(fs.readFileSync(file).equals(written), true, 're-planning cannot touch the file');
  });
});

describe('renumber: the runtime verdict is the gate (G5)', () => {
  const sessionId = 'session-hhhhhhhh-0007';

  it('REFUSES a statically-valid log the installed Harness rejects', { skip: harness === null ? 'no DeepSeek Harness installation on this machine' : false }, () => {
    // Prove the fixture really is the shape this case needs BEFORE asserting on the plan: static ok, runtime not.
    const buffer = sessionLog(sessionId);
    const staticVerdict = diagnoseSessionBuffer(buffer, { expectedSessionId: sessionId });
    assert.equal(staticVerdict.ok, true, 'the fixture must pass the pre-filter, or this case tests the wrong thing');
    const runtimeVerdict = runtimeValidate({ buffer, harness });
    assert.equal(runtimeVerdict.ok, false, 'the fixture must be one the installed Harness refuses');
    assert.equal(runtimeVerdict.available, true);

    const { file } = fixtureFile(buffer);
    const before = fs.readFileSync(file);
    const plan = planRenumber({ file, insert: [{ atSeq: 1, event: { ...LEGAL_APPEND_EVENT } }] });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason_code, RENUMBER_CODES.RUNTIME_REJECTED, plan.detail);
    assert.equal(plan.validation.static.ok, true, 'the refusal is the runtime verdict, not the pre-filter');
    assert.equal(plan.validation.runtime_verified, false);
    assert.equal(plan.new_bytes, null);
    applyRenumber({ plan });
    assert.equal(fs.readFileSync(file).equals(before), true);
    assert.deepEqual(backupSiblings(file), []);
  });

  it('refuses with RUNTIME_UNAVAILABLE when no Harness can be found and static-only was not requested', () => {
    const { file } = fixtureFile(sessionLog(sessionId));
    const before = fs.readFileSync(file);
    const plan = planRenumber({ file, deleteSeqs: [1], harness: null, allowStaticValidation: false });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason_code, RENUMBER_CODES.RUNTIME_UNAVAILABLE);
    assert.match(plan.detail, /allow-static-validation/);
    assert.equal(plan.new_bytes, null);
    applyRenumber({ plan });
    assert.equal(fs.readFileSync(file).equals(before), true);
    assert.deepEqual(backupSiblings(file), []);
  });

  it('accepts static-only evidence only when asked, and says runtime_verified:false', () => {
    const { file } = fixtureFile(sessionLog(sessionId));
    const plan = planRenumber({ file, ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.validation.runtime_verified, false);
    assert.equal(plan.validation.static.ok, true);
    assert.equal(plan.validation.future_append_evidence, 'static-prefilter');
    assert.match(plan.detail, /static-only/);
  });
});

describe('renumber: apply writes a .bak copy first and verifies the result', () => {
  it('preserves the original bytes in <file>.bak-<timestamp> and writes exactly the planned bytes', () => {
    const { file } = fixtureFile(referenceLog('session-aaaaaaaa-0001'));
    const original = fs.readFileSync(file);
    const plan = planRenumber({ file, deleteSeqs: [2], ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.original_sha256, sha256Hex(original));

    const applied = applyRenumber({ plan });
    assert.equal(applied.ok, true, applied.detail);
    assert.equal(applied.dry_run, false);
    assert.equal(applied.changed, true);
    assert.equal(applied.bytes, plan.new_bytes.length);
    assert.equal(applied.mapping_changes, 2);
    assert.equal(applied.rewritten_references, plan.rewritten_references);
    assert.equal(applied.sha256, plan.new_sha256);
    assert.equal(typeof applied.duration_ms, 'number');

    assert.match(applied.backup_file, /\.bak-\d{8}T\d{6}Z$/);
    assert.equal(backupSiblings(file).length, 1);
    assert.equal(fs.readFileSync(applied.backup_file).equals(original), true, 'the .bak holds the exact original bytes');

    const written = fs.readFileSync(file);
    assert.equal(written.equals(plan.new_bytes), true);
    assert.equal(sha256Hex(written), plan.new_sha256);
    assert.equal(written.length, plan.new_size);
    const verdict = diagnoseSessionBuffer(written, { expectedSessionId: plan.session_id });
    assert.equal(verdict.ok, true, verdict.codes.join(', '));
  });

  it('refuses when the file changed between plan and apply (the live client appended)', () => {
    const { file } = fixtureFile(sessionLog('session-iiiiiiii-0008'));
    const plan = planRenumber({ file, deleteSeqs: [1], ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);

    // Simulate the client appending: the bytes on disk are no longer the bytes the plan saw.
    const appended = Buffer.concat([fs.readFileSync(file), framesFor([{ type: 'session/title', seq: 2, time: 9, data: { title: 'x' } }])]);
    put(file, appended);
    const applied = applyRenumber({ plan });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason_code, RENUMBER_CODES.TARGET_CHANGED);
    assert.equal(fs.readFileSync(file).equals(appended), true, 'the moved file is not overwritten');
    assert.deepEqual(backupSiblings(file), []);
  });
});

describe('renumber: --dry-run / dryRun plans without writing', () => {
  it('reports what would happen and writes nothing, not even the backup', () => {
    const { file } = fixtureFile(referenceLog('session-aaaaaaaa-0001'));
    const before = fs.readFileSync(file);
    const plan = planRenumber({ file, deleteSeqs: [2], ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);

    const applied = applyRenumber({ plan, dryRun: true });
    assert.equal(applied.ok, true);
    assert.equal(applied.dry_run, true);
    assert.equal(applied.bytes, 0);
    assert.equal(applied.changed, true);
    assert.equal(applied.backup_file, plan.backup_file, 'the planned backup path is reported, not created');
    assert.equal(fs.existsSync(applied.backup_file), false);
    assert.equal(fs.readFileSync(file).equals(before), true);
    assert.deepEqual(backupSiblings(file), []);
  });
});

describe('renumber: the CLI', () => {
  it('documents the command in --help, including the renumber options', () => {
    const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.match(help, /Usage/);
    assert.match(help, /renumber/);
    assert.match(help, /--delete-seq/);
    assert.match(help, /--insert-file/);
    const commandHelp = execFileSync(process.execPath, [CLI, 'renumber', '--help'], { encoding: 'utf8' });
    assert.match(commandHelp, /renumber/);
  });

  it('exits 2 on a usage error (missing --file, non-integer --delete-seq)', () => {
    const missing = spawnSync(process.execPath, [CLI, 'renumber'], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--file/);

    const bad = spawnSync(process.execPath, [CLI, 'renumber', '--file', 'x', '--delete-seq', 'abc'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--delete-seq/);

    const unknown = spawnSync(process.execPath, [CLI, 'renumber', '--file', 'x', '--wat'], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);
  });

  it('exits 1 on a refusal and prints the reason code (torn log, --json)', () => {
    const torn = Buffer.concat([sessionLog('session-dddddddd-0004'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd])]);
    const { file } = fixtureFile(torn);
    const before = fs.readFileSync(file);
    const run = spawnSync(process.execPath, [CLI, 'renumber', '--file', file, '--dry-run', '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.plan.reason_code, RENUMBER_CODES.TORN_INPUT);
    assert.equal(fs.readFileSync(file).equals(before), true);
    assert.deepEqual(backupSiblings(file), []);
  });

  it('appends through the real entry point, keeps a backup, and prints the evidence', () => {
    const sessionId = 'session-jjjjjjjj-0009';
    const { dir, file } = fixtureFile(runtimeValidSessionLog(sessionId));
    const insertFile = put(
      path.join(dir, 'insert.json'),
      JSON.stringify([{ atSeq: 2, event: { type: 'permission/preset', time: 1794842804377, data: { preset: 'workspace-write' } } }]),
    );
    const original = fs.readFileSync(file);
    const run = spawnSync(
      process.execPath,
      [CLI, 'renumber', '--file', file, '--insert-file', insertFile, '--allow-static-validation'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, /w2m-fix renumber/);
    assert.match(run.stdout, /wrote \d+ byte/);
    assert.match(run.stdout, /backup\s+: .*\.bak-/);
    assert.match(run.stdout, /runtime\s+:/);

    const written = fs.readFileSync(file);
    assert.equal(written.equals(original), false);
    const { rows } = decodeLog(written);
    assert.equal(rows.length, 4, 'header + turn/start + turn/end + the appended event');
    assert.deepEqual(rows.slice(1).map((event) => event.seq), [0, 1, 2]);
    assert.equal(rows[3].type, 'permission/preset');
    assert.equal(diagnoseSessionBuffer(written, { expectedSessionId: sessionId }).ok, true);
    const siblings = backupSiblings(file);
    assert.equal(siblings.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, siblings[0])).equals(original), true);
  });
});

describe('renumber: sibling backup retention (G4)', () => {
  const sessionId = 'session-kkkkkkkk-0010';

  /** A log fixture plus pre-existing sibling copies named exactly the way the tool names them. */
  function withBackups(stamps) {
    const { dir, file } = fixtureFile(referenceLog(sessionId));
    const original = fs.readFileSync(file);
    for (const stamp of stamps) put(path.join(dir, `${path.basename(file)}.bak-${stamp}`), original);
    return { dir, file, original };
  }

  it('keeps the newest N copies and prunes the oldest', () => {
    const { file } = withBackups(['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']);
    const result = pruneRenumberBackups({ file, keep: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.scanned, 3);
    assert.equal(result.removed_count, 1);
    assert.deepEqual(result.removed, ['session.v4.jsonl.zstd.bak-20260101T000000Z']);
    assert.deepEqual(listRenumberBackups(file).map((row) => row.stamp), ['20260103T000000Z', '20260102T000000Z']);
    assert.deepEqual(backupSiblings(file).sort(), ['session.v4.jsonl.zstd.bak-20260102T000000Z', 'session.v4.jsonl.zstd.bak-20260103T000000Z']);
  });

  it('a dry run reports the prune and deletes nothing', () => {
    const { dir, file } = withBackups(['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']);
    const before = fs.readdirSync(dir).sort();
    const result = pruneRenumberBackups({ file, keep: 1, dryRun: true });
    assert.equal(result.dry_run, true);
    assert.equal(result.removed_count, 2);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'a dry run is read-only');
  });

  it("never deletes the copy the current run wrote, even when an older clock put others ahead of it", () => {
    const { dir, file } = fixtureFile(referenceLog(sessionId));
    const original = fs.readFileSync(file);
    for (const stamp of ['20990101T000000Z', '20990102T000000Z']) put(path.join(dir, `${path.basename(file)}.bak-${stamp}`), original);
    const plan = planRenumber({ file, deleteSeqs: [2], ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    const applied = applyRenumber({ plan, keepBackups: 1 });
    assert.equal(applied.ok, true, applied.detail);
    assert.equal(fs.existsSync(applied.backup_file), true, 'the way back of this run survives its own retention pass');
    assert.equal(applied.pruned_backups.protected, applied.backup_file);
    assert.equal(applied.pruned_backups.removed_count, 1, 'the older future-stamped copy is the one pruned');
    assert.equal(backupSiblings(file).filter((name) => name.includes('2099')).length, 1);
  });

  it('keep=0 disables pruning entirely', () => {
    const { file } = withBackups(['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']);
    const plan = planRenumber({ file, deleteSeqs: [2], ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    const applied = applyRenumber({ plan, keepBackups: 0 });
    assert.equal(applied.ok, true, applied.detail);
    assert.equal(applied.pruned_backups.keep, 0);
    assert.equal(applied.pruned_backups.removed_count, 0);
    assert.equal(backupSiblings(file).length, 4, 'three pre-existing copies plus this run\'s');
    assert.equal(DEFAULT_KEEP_RENUMBER_BACKUPS, 5);
  });

  it('apply defaults to keeping 5 copies (including the one it just wrote)', () => {
    const { file } = withBackups(['20260101T000000Z', '20260102T000000Z', '20260103T000000Z', '20260104T000000Z', '20260105T000000Z', '20260106T000000Z']);
    const plan = planRenumber({ file, deleteSeqs: [2], ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    const applied = applyRenumber({ plan });
    assert.equal(applied.ok, true, applied.detail);
    assert.equal(applied.pruned_backups.keep, DEFAULT_KEEP_RENUMBER_BACKUPS);
    assert.equal(applied.pruned_backups.removed_count, 2);
    assert.equal(backupSiblings(file).length, DEFAULT_KEEP_RENUMBER_BACKUPS);
    assert.equal(fs.existsSync(applied.backup_file), true);
  });

  it('exposes --keep-backups on the CLI (help, default apply, and a usage error for a bad value)', () => {
    const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.match(help, /--keep-backups/u);

    const bad = spawnSync(process.execPath, [CLI, 'renumber', '--file', 'x', '--keep-backups', 'abc'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--keep-backups/u);

    // The fixture must be one the installed Harness accepts: this CLI call is validated for real when one is
    // installed, and this case is about retention, not about the runtime gate.
    const { dir, file } = fixtureFile(runtimeValidSessionLog(sessionId));
    const original = fs.readFileSync(file);
    for (const stamp of ['20260101T000000Z', '20260102T000000Z']) put(path.join(dir, `${path.basename(file)}.bak-${stamp}`), original);
    const insertFile = put(
      path.join(dir, 'insert.json'),
      JSON.stringify([{ atSeq: 2, event: { type: 'permission/preset', time: 1794842804377, data: { preset: 'workspace-write' } } }]),
    );
    const run = spawnSync(
      process.execPath,
      [CLI, 'renumber', '--file', file, '--insert-file', insertFile, '--allow-static-validation', '--keep-backups', '1'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, /backups kept\s+: 1 of 3/u);
    assert.equal(backupSiblings(file).length, 1, 'keep=1 leaves this run\'s copy and prunes the two older ones');
    assert.equal(fs.readFileSync(file).equals(original), false);
  });
});
