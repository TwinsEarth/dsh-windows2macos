/**
 * G5's future-append pre-filter against the shape that produced the 2026-11-20 real-machine finding.
 *
 * The finding: `verify` reported `BACKUP_FUTURE_APPEND_FAILED` for one real session log (twice, once per snapshot)
 * with four codes -- `ZSTD_HEADER_FRAME_INVALID`, `SEQ_GAP`, `PROTECTED_HEAD_MISSING`, `SEQ_REF_DANGLING`. The
 * artifact was re-encoded so that the **first frame carries the header plus the first 5 events**:
 *
 *   frame 0: header, seed events seq 0..N (the protected `system/message` head lives here), one event carrying a
 *            `sourceEventSeqs` / `shadowedSeqs` reference into those seed seqs
 *   frame 1+: the tail events in batches (the shape every real log uses: `393` of `394` logs on this machine batch
 *            event frames; only the header frame rule was broken, by the re-encoding)
 *
 * Two independent questions get confused by such an artifact, and this suite pins them apart:
 *
 *   * **the container** -- the installed Harness's own `assertZstdHeaderFrame` requires exactly one header line in
 *     the first frame, so the client refuses the file before reading an event. That finding is real, and the fixture
 *     reproduces the strict doctor's own four-code report as evidence of the failure mode that was observed;
 *   * **the event graph** -- the rows in that frame ARE events (the runtime validator decodes them exactly like any
 *     other frame's rows), so dropping them manufactures the `SEQ_GAP`/`PROTECTED_HEAD_MISSING`/`SEQ_REF_DANGLING`
 *     trio. The pre-filter now reads every row, derives the appended seq from the true last seq, and reports the
 *     container defect once as a container finding plus a named observation -- never as three append failures.
 *
 * The plain case (header alone, events in their own frames -- `runtimeValidSessionLog`'s shape) must keep passing
 * byte-for-byte, and genuine event-graph damage must keep failing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { runBackup } from '../src/backup/engine.mjs';
import { verifyRepo } from '../src/backup/verify.mjs';
import {
  FUTURE_APPEND_UNSUPPORTED,
  appendLegalEvent,
  countLogRows,
  futureAppendVerdict,
  lastEventSeq,
} from '../src/backup/future-append.mjs';
import { diagnoseSessionBuffer } from '../src/util/session-validate.mjs';
import { compressFrame, decompressFrame } from '../src/fix/zstd.mjs';
import { framesFor, header, makeHome, registryDocument, runtimeValidSessionLog, tempDir } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const SESSION = 'session-aaaaaaaa-0001';
const GOOD_SESSION = 'session-bbbbbbbb-0002';
const WORKSPACE = '--E-GPT--';

/** Compress a batch of rows into ONE frame -- the shape the client writes for events. */
function frameOf(rows) {
  return compressFrame(Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8'));
}

/** The last frame's single row of an appended buffer, parsed. */
function appendedEvent(appended, originalBytes) {
  const text = decompressFrame(appended.subarray(originalBytes));
  const rows = text.split('\n').filter((line) => line.trim() !== '');
  assert.equal(rows.length, 1, 'the simulation appends exactly one row in one frame');
  return JSON.parse(rows[0]);
}

/**
 * The real shape, synthetically: header + seed events in frame 0, tail events in frame 1.
 *
 * Features reproduced from the real artifact: a protected `system/message` head among the seed rows, a late
 * `system/message` in the tail (which is what makes the strict reading report `PROTECTED_HEAD_MISSING`), refs from
 * the tail into the seed rows (`sourceEventSeqs`, `shadowedSeqs`), dense seqs 0..9, and a header frame with 6 rows.
 */
function seedInHeaderFrameLog(sessionId = SESSION) {
  const seeds = [
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 3, time: 4, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'protected head' }] } },
    {
      type: 'user/message',
      seq: 4,
      time: 5,
      surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user' },
    },
  ];
  const tail = [
    { type: 'assistant/message', seq: 5, time: 6, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'tool/call', seq: 6, time: 7, data: { turn: 1, step: 1, callId: 'call-1', name: 'pwsh', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 7,
      time: 8,
      surfaceOp: 'append',
      sourceEventSeqs: [4],
      data: { message: { role: 'tool', content: [{ type: 'text', text: 'done' }] } },
    },
    { type: 'compaction/summary', seq: 8, time: 9, data: { shadowedSeqs: [3], summary: [{ type: 'text', text: 'summary' }] } },
    { type: 'system/message', seq: 9, time: 10, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'late system message' }] } },
  ];
  return Buffer.concat([frameOf([header(sessionId), ...seeds]), frameOf(tail)]);
}

/** The client-normal batched shape: header alone in frame 0, then one frame with several events. */
function batchedLog(sessionId = GOOD_SESSION) {
  const events = [
    { type: 'system/message', seq: 0, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'head' }] } },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user' },
    },
    { type: 'tool/result', seq: 2, time: 3, surfaceOp: 'append', sourceEventSeqs: [1], data: { message: { role: 'tool', content: [] } } },
    { type: 'assistant/message', seq: 3, time: 4, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
  ];
  return Buffer.concat([frameOf([header(sessionId)]), frameOf(events)]);
}

describe('G5 pre-filter: the header-frame shape from the 2026-11-20 real-machine finding', () => {
  it('reproduces the observed failure mode, then reports only the real container finding', () => {
    const log = seedInHeaderFrameLog();

    // The failure mode exactly as the drill saw it: the strict doctor (header frame = header only) reads the same
    // bytes and reports four codes, three of which only exist because the seed rows were dropped from its event list.
    const strict = diagnoseSessionBuffer(log);
    assert.equal(strict.ok, false);
    assert.deepEqual([...strict.codes].sort(), ['PROTECTED_HEAD_MISSING', 'SEQ_GAP', 'SEQ_REF_DANGLING', 'ZSTD_HEADER_FRAME_INVALID']);
    assert.equal(strict.detail.seq_gap_at, 0, 'the gap is an artifact of starting the event list after frame 0');
    assert.equal(strict.detail.events, 5, 'only the tail rows were judged');

    // The fixed reading: every row is an event, so the seq run is dense, the protected head is first, and the refs
    // resolve. What remains is the one finding that is actually true of these bytes -- and a named observation saying
    // that the append probe is not evidence for this artifact (the client refuses it before any append).
    const verdict = futureAppendVerdict(log);
    assert.equal(verdict.ok, false, 'the log is not a readable v4 container, so "still loads after an append" is false');
    assert.deepEqual(verdict.codes, ['ZSTD_HEADER_FRAME_INVALID']);
    assert.deepEqual(verdict.append_codes, [], 'the one appended event introduced nothing');
    assert.deepEqual(verdict.preexisting_codes, ['ZSTD_HEADER_FRAME_INVALID']);
    assert.deepEqual(verdict.container_codes, ['ZSTD_HEADER_FRAME_INVALID']);
    assert.deepEqual(verdict.graph_codes, [], 'the event graph is legal; that is why the three false codes are gone');
    assert.equal(verdict.detail.header_frame_rows, 6);
    assert.equal(verdict.detail.container_legible, false);
    assert.equal(verdict.detail.next_seq, 10, 'the appended event carries the true next seq');
    assert.equal(verdict.evidence, 'static-prefilter');

    assert.notEqual(verdict.observation, null);
    assert.equal(verdict.observation.code, FUTURE_APPEND_UNSUPPORTED);
    assert.match(verdict.observation.reason, /first frame carries 6 row/u);
    assert.match(verdict.observation.reason, /assertZstdHeaderFrame/u);
    assert.match(verdict.observation.reason, /ZSTD_HEADER_FRAME_INVALID/u);
  });

  it('appends one legal event with the true next seq and leaves the original bytes as a prefix', () => {
    const log = seedInHeaderFrameLog();
    assert.equal(lastEventSeq(log), 9);
    const appended = appendLegalEvent(log);
    assert.ok(appended.subarray(0, log.length).equals(log), 'the original bytes are an untouched prefix');
    assert.ok(appended.length > log.length);
    const event = appendedEvent(appended, log.length);
    assert.equal(event.type, 'permission/preset');
    assert.equal(event.seq, 10);
  });

  it('derives the appended seq from the last event, not from a row count', () => {
    // A gap the client would refuse (seq 0 then seq 5): the old rows-1 formula asked for seq 2, which is neither the
    // next dense seq nor free. lastEventSeq is the derivation `src/fix/session.mjs#readSession` uses.
    const gapped = framesFor([
      header(SESSION),
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 5, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    assert.equal(countLogRows(gapped).rows - 1, 2, 'the row count cannot see the gap');
    assert.equal(lastEventSeq(gapped), 5);
    assert.equal(appendedEvent(appendLegalEvent(gapped), gapped.length).seq, 6);

    const verdict = futureAppendVerdict(gapped);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.graph_codes, ['SEQ_GAP']);
    assert.deepEqual(verdict.append_codes, []);
    assert.equal(verdict.observation, null, 'a legible container is judged, not excused');
  });
});

describe('G5 pre-filter: the shapes that must keep passing', () => {
  it('keeps the plain one-row-per-frame log byte-compatible and passing', () => {
    const log = runtimeValidSessionLog(SESSION);
    assert.deepEqual(diagnoseSessionBuffer(log).codes, []);
    const verdict = futureAppendVerdict(log);
    assert.equal(verdict.ok, true, verdict.codes.join(','));
    assert.deepEqual(verdict.codes, []);
    assert.deepEqual(verdict.preexisting_codes, []);
    assert.equal(verdict.observation, null);
    const appended = appendLegalEvent(log);
    assert.ok(appended.subarray(0, log.length).equals(log));
    assert.equal(appendedEvent(appended, log.length).seq, 2);
    assert.ok(verdict.appended_bytes > 0);
  });

  it('passes the client-normal batched shape (header alone, several events in one frame)', () => {
    // 393 of the 394 real logs on this machine look like this; batching event frames is not the defect.
    const log = batchedLog();
    assert.deepEqual(diagnoseSessionBuffer(log).codes, []);
    const verdict = futureAppendVerdict(log);
    assert.equal(verdict.ok, true, verdict.codes.join(','));
    assert.equal(verdict.observation, null);
    assert.deepEqual(verdict.container_codes, []);
    assert.deepEqual(verdict.graph_codes, []);
    assert.equal(appendedEvent(appendLegalEvent(log), log.length).seq, 4);
  });

  it('still fails genuine event-graph damage, and does not downgrade it to an observation', () => {
    const lateSystem = framesFor([
      header(SESSION),
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 2,
        surfaceOp: 'append',
        data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user' },
      },
      { type: 'system/message', seq: 2, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'late' }] } },
    ]);
    const verdict = futureAppendVerdict(lateSystem);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.codes, ['PROTECTED_HEAD_MISSING']);
    assert.deepEqual(verdict.graph_codes, ['PROTECTED_HEAD_MISSING']);
    assert.deepEqual(verdict.append_codes, []);
    assert.equal(verdict.observation, null, 'the container is legible, so the probe is evidence -- and it fails');
  });

  it('still fails a dangling reference that is genuinely dangling', () => {
    const dangling = framesFor([
      header(SESSION),
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'tool/result', seq: 1, time: 2, surfaceOp: 'append', sourceEventSeqs: [7], data: { message: { role: 'tool', content: [] } } },
    ]);
    const verdict = futureAppendVerdict(dangling);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.graph_codes.includes('SEQ_REF_DANGLING'), JSON.stringify(verdict.graph_codes));
    assert.equal(verdict.observation, null);
  });
});

describe('verify: one finding per distinct session, however many snapshots hold it', () => {
  it('reports the header-frame session once for two snapshots, with one named observation', () => {
    const home = makeHome({
      sessions: [
        { workspace: WORKSPACE, id: SESSION },
        { workspace: WORKSPACE, id: GOOD_SESSION },
      ],
      registry: registryDocument({ sessionIds: [SESSION, GOOD_SESSION] }),
    });
    const repo = tempDir('w2m-future-append-repo-');
    try {
      fs.writeFileSync(home.files[SESSION], seedInHeaderFrameLog());
      fs.writeFileSync(home.files[GOOD_SESSION], runtimeValidSessionLog(GOOD_SESSION));

      // Two snapshots with identical bytes: the same session appears twice, so the finding must not be reported twice.
      const first = runBackup({
        root: repo.dir,
        dshHome: home.home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        now: new Date('2026-11-21T00:00:00.000Z'),
      });
      assert.equal(first.ok, true, first.detail);
      const second = runBackup({
        root: repo.dir,
        dshHome: home.home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        now: new Date('2026-11-21T01:00:00.000Z'),
      });
      assert.equal(second.ok, true, second.detail);
      assert.notEqual(first.snapshot_id, second.snapshot_id);

      const result = verifyRepo({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(result.counts.snapshots, 2);
      assert.equal(result.ok, false, 'a genuinely unreadable session log is still a problem');

      const reported = result.problems.filter((problem) => problem.code === 'BACKUP_FUTURE_APPEND_FAILED');
      assert.equal(reported.length, 1, `one problem per session, got ${JSON.stringify(reported)}`);
      assert.equal(reported[0].file, `sessions/${WORKSPACE}/${SESSION}/session.v4.jsonl.zstd`);
      assert.equal(reported[0].occurrences, 2, 'the same bytes were checked in both snapshots');
      assert.deepEqual([...reported[0].snapshot_ids].sort(), [first.snapshot_id, second.snapshot_id].sort());
      assert.equal(reported[0].sha256s.length, 1, 'identical bytes are one version');
      assert.match(reported[0].detail, /not a readable v4 container/u);
      assert.match(reported[0].detail, /first frame carries 6 row/u);
      assert.match(reported[0].detail, /the appended event itself adds nothing/u);

      // The counts stay occurrence-based where they describe work done, and distinct where they describe sessions.
      assert.equal(result.future_append.checked, 4, '2 sessions x 2 snapshots');
      assert.equal(result.future_append.failed, 2);
      assert.equal(result.future_append.failed_sessions.length, 1);
      const failedSession = result.future_append.failed_sessions[0];
      assert.equal(failedSession.versions.length, 1, 'one distinct content, held by both snapshots');
      assert.match(failedSession.versions[0].sha256, /^[0-9a-f]{64}$/u);
      assert.equal(failedSession.versions[0].snapshot_ids.length, 2);
      assert.deepEqual(failedSession.container_codes, ['ZSTD_HEADER_FRAME_INVALID']);
      assert.deepEqual(failedSession.graph_codes, []);
      assert.deepEqual(failedSession.append_codes, []);

      // The named observation is surfaced once, for the same distinct session, not once per snapshot.
      assert.equal(result.future_append.unsupported, 1);
      assert.equal(result.future_append.observations.length, 1);
      const observation = result.future_append.observations[0];
      assert.equal(observation.code, FUTURE_APPEND_UNSUPPORTED);
      assert.equal(observation.session, SESSION);
      assert.equal(observation.file, `sessions/${WORKSPACE}/${SESSION}/session.v4.jsonl.zstd`);
      assert.equal(observation.snapshot_ids.length, 2);
      assert.equal(observation.versions.length, 1);
      assert.match(observation.reason, /assertZstdHeaderFrame/u);

      // Both snapshots are marked as holding a bad session, even though the global list deduplicated the report.
      assert.equal(result.snapshots.length, 2);
      assert.deepEqual(result.snapshots.map((snapshot) => snapshot.ok), [false, false]);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('still reports one problem and one observation when the same session grew between snapshots', () => {
    // The real-world case behind the dedupe: an active session is backed up twice, and the client appended in
    // between, so the two snapshots hold different bytes of the SAME session. "Once per distinct session" must not
    // mean "once per distinct content" -- that would still be N problems for one session.
    const home = makeHome({
      sessions: [{ workspace: WORKSPACE, id: SESSION }],
      registry: registryDocument({ sessionIds: [SESSION] }),
    });
    const repo = tempDir('w2m-future-append-versions-');
    try {
      const before = seedInHeaderFrameLog();
      fs.writeFileSync(home.files[SESSION], before);
      const first = runBackup({
        root: repo.dir,
        dshHome: home.home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        now: new Date('2026-11-21T00:00:00.000Z'),
      });
      assert.equal(first.ok, true, first.detail);

      const after = appendLegalEvent(before); // one more durable event: same session, different sha256
      assert.notEqual(after.length, before.length);
      fs.writeFileSync(home.files[SESSION], after);
      const second = runBackup({
        root: repo.dir,
        dshHome: home.home,
        password: PASSWORD,
        platform: 'linux',
        machineKey: false,
        now: new Date('2026-11-21T01:00:00.000Z'),
      });
      assert.equal(second.ok, true, second.detail);

      const result = verifyRepo({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      const reported = result.problems.filter((problem) => problem.code === 'BACKUP_FUTURE_APPEND_FAILED');
      assert.equal(reported.length, 1, `one problem per session even across versions, got ${JSON.stringify(reported)}`);
      assert.equal(reported[0].occurrences, 2);
      assert.deepEqual([...reported[0].snapshot_ids].sort(), [first.snapshot_id, second.snapshot_id].sort());
      assert.equal(reported[0].sha256s.length, 2, 'both versions are named as evidence');
      assert.match(reported[0].detail, /2 different version\(s\) of this session failed across 2 snapshot\(s\)/u);

      const failedSession = result.future_append.failed_sessions[0];
      assert.equal(result.future_append.failed_sessions.length, 1);
      assert.equal(failedSession.versions.length, 2);
      assert.deepEqual(failedSession.versions.map((version) => version.snapshot_ids.length), [1, 1]);
      assert.deepEqual(failedSession.container_codes, ['ZSTD_HEADER_FRAME_INVALID']);

      assert.equal(result.future_append.unsupported, 1);
      assert.equal(result.future_append.observations.length, 1);
      assert.equal(result.future_append.observations[0].versions.length, 2);
      assert.equal(result.future_append.observations[0].snapshot_ids.length, 2);
      assert.equal(result.future_append.checked, 2);
      assert.equal(result.future_append.failed, 2);
      assert.equal(result.ok, false);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('keeps a graph-damaged session as a problem with no observation, once per session', () => {
    const home = makeHome({
      sessions: [{ workspace: WORKSPACE, id: SESSION }],
      registry: registryDocument({ sessionIds: [SESSION] }),
    });
    const repo = tempDir('w2m-future-append-graph-');
    try {
      const lateSystem = framesFor([
        header(SESSION),
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'user/message',
          seq: 1,
          time: 2,
          surfaceOp: 'append',
          data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user' },
        },
        { type: 'system/message', seq: 2, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'late' }] } },
      ]);
      fs.writeFileSync(home.files[SESSION], lateSystem);
      const run = runBackup({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(run.ok, true, run.detail);
      assert.equal(run.future_append.failed, 1, 'the engine still reports the pre-filter result for the bytes it stored');

      const result = verifyRepo({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      const reported = result.problems.filter((problem) => problem.code === 'BACKUP_FUTURE_APPEND_FAILED');
      assert.equal(reported.length, 1);
      assert.match(reported[0].detail, /event graph is already invalid before the append: PROTECTED_HEAD_MISSING/u);
      assert.equal(result.future_append.failed_sessions.length, 1);
      assert.deepEqual(result.future_append.failed_sessions[0].graph_codes, ['PROTECTED_HEAD_MISSING']);
      assert.equal(result.future_append.observations.length, 0, 'a legible container produces no observation');
      assert.equal(result.future_append.unsupported, 0);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });
});
