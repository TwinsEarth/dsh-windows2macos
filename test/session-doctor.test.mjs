/**
 * session doctor: every rule here comes from a measured failure of the 2026-11-16/17 recovery drill
 * (`session-5faf0ea6…`). The drill produced four distinct corrupt-log signatures, each of which the app
 * refused to load without naming a cause the operator could see in the JSON text. These fixtures rebuild
 * that shape so the doctor cannot regress into "looks valid in an editor".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { CODES, diagnoseRoot, diagnoseSessionFile, formatReport, listSessionLogs, resolveCli } from '../scripts/session-doctor.mjs';

const ZSTD_READY = typeof zlib.zstdCompressSync === 'function';
const SKIP = ZSTD_READY ? false : 'zstd is unavailable in this Node runtime';

const HEADER = { type: 'session', version: 4, id: 'session-doctor-fixture', createdAt: 1794842804375, cwd: 'E:\\GPT', agentPreset: 'standard' };

/** One zstd frame holding the given JSONL text. */
function frame(lines) {
  return Buffer.from(zlib.zstdCompressSync(Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')));
}

/** A correct log: header alone in frame 1, then one frame of events. */
function cleanLog(events = [
  { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } },
  { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  { type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append', stream: { kind: 'final' }, usage: { input: 1, output: 1 }, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
  { type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } },
  { type: 'turn/end', seq: 4, time: 5, data: { turn: 1 } },
]) {
  return Buffer.concat([frame([HEADER]), frame(events)]);
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

test('diagnoses a clean log as OK', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-clean-');
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(file, cleanLog());
    const result = diagnoseSessionFile(file, { expectedSessionId: 'session-doctor-fixture' });
    assert.equal(result.ok, true, result.codes.join(','));
    assert.equal(result.detail.frames, 2);
    assert.equal(result.detail.header_frame_lines, 1);
    assert.equal(result.detail.events, 5);
    assert.equal(result.detail.turns, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flags a header frame that also carries events (the silent-skip cause)', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-headframe-');
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    // The drill compressed header + first events into one frame: the app judged the log corrupt and
    // skipped it without a visible error, so the session "simply never appeared".
    writeFileSync(file, frame([HEADER, { type: 'permission/preset', seq: 0, time: 1, data: {} }, { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }]));
    const result = diagnoseSessionFile(file, { expectedSessionId: 'session-doctor-fixture' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.codes, [CODES.HEADER_FRAME_INVALID]);
    assert.equal(result.detail.header_frame_lines, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flags assistant/message without surfaceOp (the "surfaceOp requires an object" cause)', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-surfaceop-');
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(
      file,
      Buffer.concat([
        frame([HEADER]),
        frame([
          { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hi' }] } },
          { type: 'assistant/message', seq: 1, time: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
        ]),
      ]),
    );
    const result = diagnoseSessionFile(file, { expectedSessionId: 'session-doctor-fixture' });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(CODES.SURFACE_OP_MISSING), result.codes.join(','));
    assert.deepEqual(result.detail.surface_op, { type: 'assistant/message', seq: 1, surface_op: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts the object form of surfaceOp that a compacted checkpoint carries', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-compaction-');
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    // Measured on the real 113 MB session: a compaction checkpoint is a user/message whose surfaceOp
    // is { op: 'replace', startSeq, endSeq } — not the string 'append'.
    writeFileSync(
      file,
      Buffer.concat([
        frame([HEADER]),
        frame([
          { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hi' }] } },
          { type: 'user/message', seq: 1, time: 2, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0], data: { content: [{ type: 'text', text: 'checkpoint' }] } },
          { type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append', stream: { kind: 'final' }, usage: { input: 1, output: 1 }, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
        ]),
      ]),
    );
    const result = diagnoseSessionFile(file, { expectedSessionId: 'session-doctor-fixture' });
    assert.equal(result.ok, true, result.codes.join(','));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flags a malformed surfaceOp object (replace without seq bounds)', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-surfaceop-object-');
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(
      file,
      Buffer.concat([
        frame([HEADER]),
        frame([
          { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hi' }] } },
          { type: 'user/message', seq: 1, time: 2, surfaceOp: { op: 'replace' }, data: { content: [{ type: 'text', text: 'bad' }] } },
        ]),
      ]),
    );
    const result = diagnoseSessionFile(file, { expectedSessionId: 'session-doctor-fixture' });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(CODES.SURFACE_OP_MISSING), result.codes.join(','));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flags a system/message that is not the first surface event (protected head)', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-protected-');
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(
      file,
      Buffer.concat([
        frame([HEADER]),
        frame([
          { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hi' }] } },
          { type: 'system/message', seq: 1, time: 2, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'runtime context' }] } },
        ]),
      ]),
    );
    const result = diagnoseSessionFile(file, { expectedSessionId: 'session-doctor-fixture' });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(CODES.PROTECTED_HEAD_MISSING), result.codes.join(','));
    assert.equal(result.detail.protected_head.offending_index, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flags a seq gap and a dangling seq reference (the renumbering trap)', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-seq-');
  try {
    const file = join(dir, 'session.v4.jsonl.zstd');
    writeFileSync(
      file,
      Buffer.concat([
        frame([HEADER]),
        frame([
          { type: 'tool/call', seq: 0, time: 1, data: { name: 'pwsh' } },
          { type: 'tool/result', seq: 2, time: 2, data: { sourceEventSeqs: [0, 99] } },
        ]),
      ]),
    );
    const result = diagnoseSessionFile(file, { expectedSessionId: 'session-doctor-fixture' });
    assert.equal(result.ok, false);
    assert.ok(result.codes.includes(CODES.SEQ_GAP), result.codes.join(','));
    assert.ok(result.codes.includes(CODES.DANGLE_REF), result.codes.join(','));
    assert.equal(result.detail.seq_gap_at, 1);
    assert.equal(result.detail.dangling_refs[0].seq, 99);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flags a session log that exists on disk but is not registered in workspace.json', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-registry-');
  try {
    const sessionsRoot = join(dir, 'sessions', '--E-GPT--');
    const logDir = join(sessionsRoot, 'session-doctor-fixture');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'session.v4.jsonl.zstd'), cleanLog());
    mkdirSync(join(dir, 'storages'), { recursive: true });
    writeFileSync(
      join(dir, 'storages', 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
        tables: { workspaces: { w1: { path: 'E:\\GPT', title: 'GPT', sessionIds: [] } } },
      }),
      'utf8',
    );
    const report = diagnoseRoot({ root: dir });
    assert.equal(report.sessions.length, 1);
    assert.ok(report.findings.some((finding) => finding.code === CODES.NOT_REGISTERED), JSON.stringify(report.findings));
    assert.match(formatReport(report), /SESSION_NOT_REGISTERED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a registered, valid log produces no findings', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-registered-');
  try {
    const sessionsRoot = join(dir, 'sessions', '--E-GPT--');
    const logDir = join(sessionsRoot, 'session-doctor-fixture');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'session.v4.jsonl.zstd'), cleanLog());
    mkdirSync(join(dir, 'storages'), { recursive: true });
    writeFileSync(
      join(dir, 'storages', 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
        tables: { workspaces: { w1: { path: 'E:\\GPT', title: 'GPT', sessionIds: ['session-doctor-fixture'] } } },
      }),
      'utf8',
    );
    const report = diagnoseRoot({ root: dir });
    assert.deepEqual(report.findings, []);
    assert.equal(report.sessions[0].ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lists only session directories that carry a v4 log', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-list-');
  try {
    const sessionsRoot = join(dir, 'sessions');
    mkdirSync(join(sessionsRoot, '--E-GPT--', 'session-with-log'), { recursive: true });
    mkdirSync(join(sessionsRoot, '--E-GPT--', 'session-without-log'), { recursive: true });
    writeFileSync(join(sessionsRoot, '--E-GPT--', 'session-with-log', 'session.v4.jsonl.zstd'), cleanLog());
    const logs = listSessionLogs(sessionsRoot);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].sessionId, 'session-with-log');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exit code is 0 for a valid log and 1 for a corrupt one', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-cli-');
  try {
    const good = join(dir, 'good.v4.jsonl.zstd');
    writeFileSync(good, cleanLog());
    const bad = join(dir, 'bad.v4.jsonl.zstd');
    writeFileSync(bad, frame([HEADER, { type: 'turn/start', seq: 0, time: 1, data: {} }]));
    const doctor = fileURLToPath(new URL('../scripts/session-doctor.mjs', import.meta.url));
    const run = (file) => {
      try {
        execFileSync(process.execPath, [doctor, '--file', file, '--session-id', 'session-doctor-fixture'], { stdio: 'pipe' });
        return 0;
      } catch (error) {
        return error.status ?? 1;
      }
    };
    assert.equal(run(good), 0, 'a valid log must exit 0');
    assert.equal(run(bad), 1, 'a corrupt log must exit 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bare invocation resolves --root from $DSH_HOME (npm run doctor must not need shell expansion)', () => {
  // `npm run` on Windows runs cmd.exe, which passes "$DSH_HOME" through as literal text. The npm script is
  // therefore bare, and the default has to come from the environment inside the process.
  assert.deepEqual(resolveCli([], { DSH_HOME: 'C:\\Users\\x\\.dsh' }), {
    json: false,
    file: null,
    sessionId: null,
    root: 'C:\\Users\\x\\.dsh',
  });
  // An explicit --root still wins.
  assert.equal(resolveCli(['--root', 'D:\\home'], { DSH_HOME: 'C:\\Users\\x\\.dsh' }).root, 'D:\\home');
  // --file is a single-log mode: no registry root is inferred, even when DSH_HOME is set.
  assert.deepEqual(resolveCli(['--file', 'x.zstd', '--json'], { DSH_HOME: 'C:\\Users\\x\\.dsh' }), {
    json: true,
    file: 'x.zstd',
    sessionId: null,
    root: null,
  });
  // No argument, no environment variable: the caller must say where to look instead of guessing ~/.dsh.
  assert.equal(resolveCli([], {}).root, null);
});

test('CLI with no arguments scans $DSH_HOME and exits 0 when that home is clean', { skip: SKIP }, () => {
  const dir = tempDir('w2m-doctor-env-root-');
  try {
    const logDir = join(dir, 'sessions', '--E-GPT--', 'session-doctor-fixture');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'session.v4.jsonl.zstd'), cleanLog());
    mkdirSync(join(dir, 'storages'), { recursive: true });
    writeFileSync(
      join(dir, 'storages', 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
        tables: { workspaces: { w1: { path: 'E:\\GPT', title: 'GPT', sessionIds: ['session-doctor-fixture'] } } },
      }),
      'utf8',
    );
    const doctor = fileURLToPath(new URL('../scripts/session-doctor.mjs', import.meta.url));
    const env = { ...process.env, DSH_HOME: dir };
    const out = execFileSync(process.execPath, [doctor], { stdio: 'pipe', env, encoding: 'utf8' });
    assert.match(out, /logs: 1 · findings: 0/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
