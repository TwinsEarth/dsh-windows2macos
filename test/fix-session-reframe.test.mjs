/**
 * `session-reframe` (`src/fix/session-reframe.mjs`) and its CLI (`w2m-fix session-reframe`).
 *
 * The shape under test is the one measured on a real log on 2026-11-21: the first zstd frame
 * carries the header AND the first N events, which the installed client refuses
 * ("corrupt Zstandard session log: first frame is not exactly one header line"). The repair moves
 * those events into their own frame without re-serialising one byte of the row stream.
 *
 * What these protect, said once: the repaired bytes must decode to the SAME row stream (sha256),
 * keep every tail frame byte-identical, satisfy the client's transcribed first-frame rule, pass
 * the static doctor and the future-append simulation, and refuse rather than guess on a torn tail,
 * a missing header, a junk first frame, an unverifiable row, a gate rejection, a source that moved,
 * or a write destination that was not deliberately chosen. The runtime gate is exercised through
 * its documented seam so the branch is deterministic on a machine with or without an installation.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  REFRAME_CODES,
  applySessionReframe,
  assertZstdHeaderFrame,
  planSessionReframe,
} from '../src/fix/session-reframe.mjs';
import { compressFrame, scanFrames } from '../src/fix/zstd.mjs';
import { futureAppendVerdict } from '../src/backup/future-append.mjs';
import { diagnoseSessionBuffer } from '../src/util/session-validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'bin', 'w2m-fix.mjs');

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

/** A throwaway directory, remembered for cleanup. */
function tempDir(prefix = 'w2m-reframe-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  CLEANUPS.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The installed client's first-frame rule, transcribed independently of the module under test. */
function clientHeaderRule(plaintext) {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  if (bytes.length === 0 || bytes.indexOf(0x0a) !== bytes.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line');
  }
}

const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-reframe-fixture',
  cwd: 'E:\\GPT',
  createdAt: 1794842804375,
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
};

/** A minimal event graph the doctor accepts: protected head, surface ops, dense seq. */
const EVENTS = [
  { type: 'system/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'head' }] } },
  { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
  { type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
  { type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } },
  { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
];

/** One JSONL row as bytes. */
function line(row) {
  return Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
}

/** One frame holding the given rows (a `Buffer` payload is written verbatim). */
function frameOf(rows) {
  return compressFrame(Buffer.concat(rows.map((row) => (Buffer.isBuffer(row) ? row : line(row)))));
}

/** The defect: frame 0 = header + the first three events, then the rest in their own frames. */
function illegalLog() {
  return Buffer.concat([
    frameOf([HEADER, ...EVENTS.slice(0, 3)]),
    frameOf([EVENTS[3]]),
    frameOf([EVENTS[4]]),
  ]);
}

/** The shape the client requires: header alone, then one event-batch frame, then the rest. */
function legalLog() {
  return Buffer.concat([
    frameOf([HEADER]),
    frameOf(EVENTS.slice(0, 3)),
    frameOf([EVENTS[3]]),
    frameOf([EVENTS[4]]),
  ]);
}

/** Write a fixture into its own temp directory. */
function fixture(buffer, name = 'session.v4.jsonl.zstd') {
  const dir = tempDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return { dir, file };
}

/** The decompressed row stream's sha256, computed independently of the module under test. */
function rowStreamSha(buffer) {
  const hash = crypto.createHash('sha256');
  for (const frame of scanFrames(buffer).frames) {
    hash.update(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
  }
  return hash.digest('hex');
}

/** The raw bytes of frames `[from..]`, concatenated (the tail-copy proof). */
function tailBytes(buffer, from) {
  const { frames } = scanFrames(buffer);
  return Buffer.concat(frames.slice(from).map((frame) => buffer.subarray(frame.start, frame.end)));
}

/** The decompressed plaintext of frame `index`. */
function framePlain(buffer, index) {
  const frame = scanFrames(buffer).frames[index];
  return zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end));
}

/** Names in a directory (temp files must not survive an apply). */
function listing(dir) {
  return fs.readdirSync(dir).sort();
}

/** Static-only planning options: deterministic, no Harness spawn. */
const STATIC_ONLY = { allowStatic: true, harness: null };

describe('session-reframe: the legal repair', () => {
  it('plans the repair and reports the row stream unchanged', () => {
    const { dir, file } = fixture(illegalLog());
    const out = path.join(dir, 'out.v4.jsonl.zstd');
    const plan = planSessionReframe({ file, out, ...STATIC_ONLY });

    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.refused, false);
    assert.equal(plan.code, null);
    assert.equal(plan.noop, false);
    assert.equal(plan.frames, 3);
    assert.equal(plan.framesAfter, 4);
    assert.equal(plan.rows, 6);
    assert.equal(plan.events, 5);
    assert.equal(plan.lastSeq, 4);
    assert.equal(plan.nextSeq, 5);
    assert.equal(plan.headerFrameRows, 4);
    assert.equal(plan.tailFrames, 2);
    assert.equal(plan.fileBytes, illegalLog().length);
    assert.equal(plan.outPath, out);
    assert.ok(plan.headerBytes > 0);
    assert.ok(plan.eventBytes > 0);
    assert.equal(plan.headerBytes + plan.eventBytes, framePlain(illegalLog(), 0).length);
    assert.equal(plan.sha256Before, rowStreamSha(illegalLog()));
    assert.equal(plan.sha256After, plan.sha256Before, 'the row stream must be byte-identical');
    assert.equal(plan.fileSha256Before, crypto.createHash('sha256').update(illegalLog()).digest('hex'));
    assert.equal(Buffer.isBuffer(plan.newBytes), true);
    assert.equal(plan.validation.static.ok, true);
    assert.equal(plan.validation.static.codes.length, 0);
    assert.equal(plan.validation.future_append.ok, true);
    assert.equal(plan.validation.future_append.next_seq, 5);
    assert.equal(plan.validation.runtime_verified, false);
    assert.equal(plan.validation.runtime_required, false);
    assert.equal(plan.validation.container_gate, 'transcribed');
    assert.ok(plan.peakRssMb > 0);
  });

  it('writes a repaired copy the gates accept (row stream, tail bytes, first-frame rule)', () => {
    const { dir, file } = fixture(illegalLog());
    const out = path.join(dir, 'out.v4.jsonl.zstd');
    const plan = planSessionReframe({ file, out, ...STATIC_ONLY });
    const applied = applySessionReframe(plan);

    assert.equal(applied.ok, true, applied.detail);
    assert.equal(applied.wrote, true);
    assert.equal(applied.bytes, plan.fileBytesAfter);
    assert.equal(applied.sha256, plan.fileSha256After);
    assert.equal(applied.verified.ok, true);
    assert.equal(applied.verified.sha256, plan.sha256After);
    assert.deepEqual(listing(dir), ['out.v4.jsonl.zstd', 'session.v4.jsonl.zstd'], 'no temp file may survive the atomic write');

    const repaired = fs.readFileSync(out);
    const original = fs.readFileSync(file);

    // (a) the installed client's rule, as a local transcription and through the module's export.
    assert.throws(() => clientHeaderRule(framePlain(original, 0)), /first frame is not exactly one header line/);
    assert.doesNotThrow(() => clientHeaderRule(framePlain(repaired, 0)));
    assert.doesNotThrow(() => assertZstdHeaderFrame(framePlain(repaired, 0)));
    assert.throws(() => assertZstdHeaderFrame(framePlain(original, 0)));
    assert.equal(scanFrames(repaired).frames.length, 4);
    assert.equal(framePlain(repaired, 0).toString('utf8'), `${JSON.stringify(HEADER)}\n`, 'frame 0 is the header row, unchanged');

    // (b) the row stream is the same bytes.
    assert.equal(rowStreamSha(repaired), rowStreamSha(original));

    // (c) the tail frames are byte-identical (repaired frames 2.. vs original frames 1..).
    assert.equal(tailBytes(repaired, 2).equals(tailBytes(original, 1)), true);

    // (d) the static doctor and the future-append simulation accept the result.
    const doctor = diagnoseSessionBuffer(repaired);
    assert.equal(doctor.ok, true, doctor.codes.join(','));
    assert.deepEqual(doctor.codes, []);
    const future = futureAppendVerdict(repaired);
    assert.equal(future.ok, true);
    assert.equal(future.observation, null);
    assert.deepEqual(future.codes, []);
    assert.equal(future.detail.next_seq, 5);

    // (e) the source is untouched.
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'), plan.fileSha256Before);
    assert.equal(rowStreamSha(original), plan.sha256Before);
  });

  it('a dry run writes nothing at all', () => {
    const { dir, file } = fixture(illegalLog());
    const out = path.join(dir, 'out.v4.jsonl.zstd');
    const plan = planSessionReframe({ file, out, dryRun: true, ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.dryRun, true);
    const applied = applySessionReframe(plan);
    assert.equal(applied.ok, true);
    assert.equal(applied.wrote, false);
    assert.equal(applied.dry_run, true);
    assert.deepEqual(listing(dir), ['session.v4.jsonl.zstd']);
  });

  it('refuses an existing --out without --force, and overwrites it with --force', () => {
    const { dir, file } = fixture(illegalLog());
    const out = path.join(dir, 'out.v4.jsonl.zstd');
    fs.writeFileSync(out, 'previous run');
    const refused = planSessionReframe({ file, out, ...STATIC_ONLY });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, REFRAME_CODES.BUSY);
    assert.match(refused.detail, /already exists/);

    const forced = planSessionReframe({ file, out, force: true, ...STATIC_ONLY });
    assert.equal(forced.ok, true, forced.detail);
    const applied = applySessionReframe(forced);
    assert.equal(applied.ok, true, applied.detail);
    assert.equal(fs.readFileSync(out).equals(forced.newBytes), true);
  });

  it('reports NOOP_ALREADY_LEGAL on an already-legal log and writes nothing', () => {
    const { dir, file } = fixture(legalLog());
    const out = path.join(dir, 'out.v4.jsonl.zstd');
    const plan = planSessionReframe({ file, out, ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.noop, true);
    assert.equal(plan.code, REFRAME_CODES.NOOP);
    assert.equal(plan.refused, false);
    assert.equal(plan.frames, 4);
    assert.equal(plan.framesAfter, 4);
    assert.equal(plan.rows, 6);
    assert.equal(plan.events, 5);
    assert.equal(plan.headerBytes, Buffer.byteLength(`${JSON.stringify(HEADER)}\n`));
    assert.equal(plan.sha256Before, plan.sha256After);
    const applied = applySessionReframe(plan);
    assert.equal(applied.ok, true);
    assert.equal(applied.wrote, false);
    assert.equal(applied.code, REFRAME_CODES.NOOP);
    assert.deepEqual(listing(dir), ['session.v4.jsonl.zstd'], 'a no-op must not write, not even the copy');
  });

  it('in-place needs --force (and a stopped client), then keeps a verified backup', () => {
    const { dir, file } = fixture(illegalLog());
    const original = fs.readFileSync(file);

    const withoutForce = planSessionReframe({ file, inPlace: true, ...STATIC_ONLY, dshRunning: false });
    assert.equal(withoutForce.ok, false);
    assert.equal(withoutForce.code, REFRAME_CODES.BUSY);
    assert.match(withoutForce.detail, /--force/);

    const whileRunning = planSessionReframe({ file, inPlace: true, force: true, ...STATIC_ONLY, dshRunning: true });
    assert.equal(whileRunning.ok, false);
    assert.equal(whileRunning.code, REFRAME_CODES.BUSY);
    assert.match(whileRunning.detail, /running/);

    const plan = planSessionReframe({ file, inPlace: true, force: true, ...STATIC_ONLY, dshRunning: false });
    assert.equal(plan.ok, true, plan.detail);
    assert.equal(plan.inPlace, true);
    assert.equal(plan.outPath, file);
    const applied = applySessionReframe(plan);
    assert.equal(applied.ok, true, applied.detail);
    assert.equal(applied.wrote, true);
    assert.ok(applied.backupPath, 'an in-place repair must leave the way back');
    assert.equal(fs.readFileSync(applied.backupPath).equals(original), true, 'the backup is the original bytes');
    assert.equal(rowStreamSha(fs.readFileSync(file)), plan.sha256Before);
    assert.doesNotThrow(() => clientHeaderRule(framePlain(fs.readFileSync(file), 0)));
    assert.equal(listing(dir).filter((name) => name.includes('.tmp-')).length, 0, 'no temp file may survive');
  });

  it('refuses to move the source under the plan', () => {
    const { dir, file } = fixture(illegalLog());
    const out = path.join(dir, 'out.v4.jsonl.zstd');
    const plan = planSessionReframe({ file, out, ...STATIC_ONLY });
    assert.equal(plan.ok, true, plan.detail);
    fs.appendFileSync(file, Buffer.from('x'));
    const applied = applySessionReframe(plan);
    assert.equal(applied.ok, false);
    assert.equal(applied.code, REFRAME_CODES.BUSY);
    assert.match(applied.detail, /changed after the plan/);
    assert.deepEqual(listing(dir), ['session.v4.jsonl.zstd'], 'nothing may be written when the source moved');
  });

  it('refuses --out naming the source itself, and --out together with --in-place', () => {
    const { file } = fixture(illegalLog());
    const same = planSessionReframe({ file, out: file, ...STATIC_ONLY });
    assert.equal(same.ok, false);
    assert.equal(same.code, REFRAME_CODES.BUSY);
    assert.match(same.detail, /--in-place/);

    const both = planSessionReframe({ file, out: `${file}.copy`, inPlace: true, force: true, ...STATIC_ONLY });
    assert.equal(both.ok, false);
    assert.equal(both.code, REFRAME_CODES.BUSY);
    assert.match(both.detail, /mutually exclusive/);
  });
});

describe('session-reframe: refusals are named and write nothing', () => {
  it('FIX_REFUSED_TORN_TAIL for a partial trailing frame', () => {
    const torndir = tempDir();
    const file = path.join(torndir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, Buffer.concat([illegalLog(), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]));
    const plan = planSessionReframe({ file, out: path.join(torndir, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(plan.ok, false);
    assert.equal(plan.refused, true);
    assert.equal(plan.code, REFRAME_CODES.TORN_TAIL);
    assert.match(plan.detail, /partial zstd frame/);
    assert.deepEqual(listing(torndir), ['session.v4.jsonl.zstd']);
  });

  it('FIX_REFUSED_HEADER when frame 0 starts with an event instead of the header', () => {
    const { dir, file } = fixture(Buffer.concat([frameOf([EVENTS[0], EVENTS[1]]), frameOf([EVENTS[2]])]));
    const plan = planSessionReframe({ file, out: path.join(dir, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, REFRAME_CODES.HEADER);
    assert.match(plan.detail, /not the session header/);
  });

  it('FIX_REFUSED_HEADER for a first junk frame and for a frame 0 with no newline', () => {
    const junk = fixture(frameOf([Buffer.from('this is not json\n', 'utf8'), line(EVENTS[0])]));
    const junkPlan = planSessionReframe({ file: junk.file, out: path.join(junk.dir, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(junkPlan.code, REFRAME_CODES.HEADER);
    assert.match(junkPlan.detail, /not JSON/);

    const single = tempDir();
    const singleFile = path.join(single, 'session.v4.jsonl.zstd');
    fs.writeFileSync(singleFile, compressFrame(Buffer.from(JSON.stringify(HEADER), 'utf8')));
    const noNewline = planSessionReframe({ file: singleFile, out: path.join(single, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(noNewline.code, REFRAME_CODES.HEADER);
    assert.match(noNewline.detail, /no newline/);
  });

  it('FIX_REFUSED_CONTAINER for an empty file, junk bytes and a corrupted frame', () => {
    const dir = tempDir();
    const empty = path.join(dir, 'empty.v4.jsonl.zstd');
    fs.writeFileSync(empty, '');
    assert.equal(planSessionReframe({ file: empty, out: path.join(dir, 'a.zstd'), ...STATIC_ONLY }).code, REFRAME_CODES.CONTAINER);

    const junk = path.join(dir, 'junk.v4.jsonl.zstd');
    fs.writeFileSync(junk, 'definitely not a zstd frame stream');
    assert.equal(planSessionReframe({ file: junk, out: path.join(dir, 'b.zstd'), ...STATIC_ONLY }).code, REFRAME_CODES.CONTAINER);

    // Flip the trailing checksum of the last frame: the frame scans, the decompressor refuses it.
    const bytes = illegalLog();
    const { frames } = scanFrames(bytes);
    const last = frames[frames.length - 1];
    bytes[last.end - 1] ^= 0xff;
    const corruptDir = tempDir();
    const corrupt = path.join(corruptDir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(corrupt, bytes);
    const corruptPlan = planSessionReframe({ file: corrupt, out: path.join(corruptDir, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(corruptPlan.code, REFRAME_CODES.CONTAINER);
    assert.match(corruptPlan.detail, /could not be decompressed/);
  });

  it('FIX_REFUSED_ROW for a seq gap, a non-JSON row and a frame that ends mid-row', () => {
    const gap = fixture(
      Buffer.concat([
        frameOf([HEADER, EVENTS[0], { type: 'turn/start', seq: 2, time: 9, data: { turn: 1 } }]),
        frameOf([{ type: 'turn/end', seq: 3, time: 10, data: { turn: 1 } }]),
      ]),
    );
    const gapPlan = planSessionReframe({ file: gap.file, out: path.join(gap.dir, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(gapPlan.code, REFRAME_CODES.ROW);
    assert.match(gapPlan.detail, /seq run is not dense from 0/);

    const nonJson = fixture(
      Buffer.concat([
        frameOf([HEADER, ...EVENTS.slice(0, 3)]),
        compressFrame(Buffer.from('{"type":"turn/start","seq":3,"time":4,"data":{}}\nnot json at all\n', 'utf8')),
      ]),
    );
    const nonJsonPlan = planSessionReframe({ file: nonJson.file, out: path.join(nonJson.dir, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(nonJsonPlan.code, REFRAME_CODES.ROW);
    assert.match(nonJsonPlan.detail, /is not JSON/);

    const midRow = fixture(
      Buffer.concat([frameOf([HEADER, ...EVENTS.slice(0, 3)]), compressFrame(Buffer.from('{"type":"turn/start","seq":3}', 'utf8'))]),
    );
    const midRowPlan = planSessionReframe({ file: midRow.file, out: path.join(midRow.dir, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(midRowPlan.code, REFRAME_CODES.ROW);
    assert.match(midRowPlan.detail, /not newline-terminated/);
  });

  it('FIX_REFUSED_ROW_MISMATCH when the rebuilt log still fails the static doctor', () => {
    // The seq run is dense (so the row scanner accepts it) but a surface message carries no
    // surfaceOp: the defect is in the event graph, which this command must not hide.
    const broken = {
      ...EVENTS[1],
      surfaceOp: undefined,
    };
    const dir = tempDir();
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, Buffer.concat([frameOf([HEADER, EVENTS[0], broken, EVENTS[2]]), frameOf([EVENTS[3]]), frameOf([EVENTS[4]])]));
    const plan = planSessionReframe({ file, out: path.join(dir, 'out.zstd'), ...STATIC_ONLY });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, REFRAME_CODES.ROW_MISMATCH);
    assert.equal(plan.stage, 'static-doctor');
    assert.ok(plan.codes.includes('SURFACE_OP_MISSING'), JSON.stringify(plan.codes));
    assert.deepEqual(listing(dir), ['session.v4.jsonl.zstd']);
  });

  it('FIX_REFUSED_NO_RUNTIME when the runtime gate is required and absent', () => {
    const { dir, file } = fixture(illegalLog());
    const plan = planSessionReframe({ file, out: path.join(dir, 'out.zstd'), harness: null });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, REFRAME_CODES.NO_RUNTIME);
    assert.match(plan.detail, /--allow-static/);
    assert.equal(plan.validation.runtime_required, true);
  });

  it('runs the runtime gate through its seam: accept, reject and unavailable', () => {
    const { dir, file } = fixture(illegalLog());
    const accepted = planSessionReframe({
      file,
      out: path.join(dir, 'a.zstd'),
      harness: {},
      runtimeGate: () => ({ available: true, ok: true, detail: 'validated by the installed Harness', events: 5 }),
    });
    assert.equal(accepted.ok, true, accepted.detail);
    assert.equal(accepted.validation.runtime_verified, true);
    assert.equal(accepted.validation.runtime.events, 5);

    const rejected = planSessionReframe({
      file,
      out: path.join(dir, 'b.zstd'),
      harness: {},
      runtimeGate: () => ({ available: true, ok: false, detail: 'SessionPersistenceCorruptionError: nope', events: 0 }),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, REFRAME_CODES.ROW_MISMATCH);
    assert.equal(rejected.stage, 'runtime');
    assert.match(rejected.detail, /refused the rebuilt log/);

    const short = planSessionReframe({
      file,
      out: path.join(dir, 'c.zstd'),
      harness: {},
      runtimeGate: () => ({ available: true, ok: true, detail: 'accepted', events: 4 }),
    });
    assert.equal(short.code, REFRAME_CODES.ROW_MISMATCH);
    assert.match(short.detail, /fewer events/);

    const unavailable = planSessionReframe({
      file,
      out: path.join(dir, 'd.zstd'),
      harness: {},
      runtimeGate: () => ({ available: false, ok: false, detail: 'no verdict', events: 0 }),
    });
    assert.equal(unavailable.code, REFRAME_CODES.NO_RUNTIME);
  });

  it('never writes on a refusal, even when --out was given', () => {
    const dir = tempDir();
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, 'junk');
    const out = path.join(dir, 'out.zstd');
    const plan = planSessionReframe({ file, out, ...STATIC_ONLY });
    assert.equal(plan.ok, false);
    const applied = applySessionReframe(plan);
    assert.equal(applied.ok, false);
    assert.equal(applied.wrote, false);
    assert.deepEqual(listing(dir), ['session.v4.jsonl.zstd']);
  });
});

describe('session-reframe: the CLI', () => {
  /** Run the CLI and return its status plus parsed JSON (when --json was used). */
  function cli(args) {
    const result = spawnSync(process.execPath, [CLI, 'session-reframe', ...args], { encoding: 'utf8', windowsHide: true });
    let json = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = null;
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
  }

  it('exits 0 for a dry run and reports the plan numbers', () => {
    const { file } = fixture(illegalLog());
    const run = cli(['--file', file, '--dry-run', '--json', '--allow-static']);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.json, run.stdout);
    assert.equal(run.json.command, 'session-reframe');
    assert.equal(run.json.ok, true);
    assert.equal(run.json.dry_run, true);
    assert.equal(run.json.applied, null);
    assert.equal(run.json.plan.frames, 3);
    assert.equal(run.json.plan.frames_after, 4);
    assert.equal(run.json.plan.rows, 6);
    assert.equal(run.json.plan.next_seq, 5);
    assert.equal(run.json.plan.sha256_before, run.json.plan.sha256_after);
    assert.equal(run.json.plan.validation.static.ok, true);
  });

  it('writes the copy at --out and leaves no temp file behind', () => {
    const { dir, file } = fixture(illegalLog());
    const out = path.join(dir, 'out.v4.jsonl.zstd');
    const run = cli(['--file', file, '--out', out, '--json', '--allow-static']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.json.ok, true);
    assert.equal(run.json.applied.wrote, true);
    assert.equal(run.json.applied.outPath, out);
    assert.deepEqual(listing(dir), ['out.v4.jsonl.zstd', 'session.v4.jsonl.zstd']);
  });

  it('exits 1 for a named refusal and still prints machine-readable JSON', () => {
    const dir = tempDir();
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, Buffer.concat([illegalLog(), Buffer.from([0x28, 0xb5])]));
    const run = cli(['--file', file, '--dry-run', '--json', '--allow-static']);
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.json.ok, false);
    assert.equal(run.json.plan.code, REFRAME_CODES.TORN_TAIL);
    assert.equal(run.json.plan.refused, true);
  });

  it('exits 2 on a usage error (no write target, --in-place without --force)', () => {
    const { file } = fixture(illegalLog());
    const noTarget = cli(['--file', file, '--allow-static']);
    assert.equal(noTarget.status, 2, noTarget.stderr);
    assert.match(noTarget.stderr, /--out/);

    const inPlace = cli(['--file', file, '--in-place', '--allow-static']);
    assert.equal(inPlace.status, 2, inPlace.stderr);
    assert.match(inPlace.stderr, /--force/);

    const missingFile = cli(['--dry-run']);
    assert.equal(missingFile.status, 2, missingFile.stderr);
  });

  it('exits 3 for a write precondition (an existing --out without --force)', () => {
    const { dir, file } = fixture(illegalLog());
    const out = path.join(dir, 'out.v4.jsonl.zstd');
    fs.writeFileSync(out, 'previous run');
    const run = cli(['--file', file, '--out', out, '--json', '--allow-static']);
    assert.equal(run.status, 3, run.stderr);
    assert.equal(run.json.ok, false);
    assert.equal(run.json.plan.code, REFRAME_CODES.BUSY);
    assert.equal(run.json.applied, null);
    assert.equal(fs.readFileSync(out, 'utf8'), 'previous run', 'the refused write must not touch the destination');
  });

  it('documents the command in --help', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /session-reframe --file <log>/);
    assert.match(result.stdout, /FIX_REFUSED_TORN_TAIL/);
  });
});
