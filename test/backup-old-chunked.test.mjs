/**
 * `old-restore` against chunked-v2 full copies (P2/O3), and the format's effect on the rest of the old/ tree.
 *
 * `chunked.mjs` (O1) defines the container and `verify.mjs` (O2) reads it; this suite pins the **restore** half:
 *
 *   1. **The format is decided by the magic, never the record field.** A v2 copy restores byte-exactly through the
 *      streaming path (`streamed: true`, `peakChunkBytes` = one record), a v1 copy keeps its old whole-file path
 *      unchanged, and a repo holding both restores either.
 *   2. **It is a restore, not a new write path with new semantics.** The `.bak-<ts>` copy on overwrite, the
 *      target-changed refusal, the atomic target write and the digest read-back are the same as v1's -- the v2
 *      case differs only in that the bytes are streamed into a temporary sibling and renamed.
 *   3. **A damaged v2 copy is named, and nothing is written.** Flipped, truncated and retargeted copies are
 *      `BACKUP_OLD_RESTORE_CORRUPT` with the specific `BACKUP_CHUNKED_*` code in the detail; a copy that changes
 *      between plan and apply is refused by the re-verified stream instead of being written.
 *   4. **Nothing else in the old/ tree needs to know the format.** `gc`'s orphan sweep deletes unreferenced copies
 *      and keeps referenced ones, and the mirror copies every version-tree file byte-identically.
 *
 * The last group is the memory evidence: a 32 MiB copy with 4 MiB chunks is restored in a child process capped at
 * a 64 MiB V8 heap, and the plan reports the reader's peak as exactly one record. The static doctor still
 * materialises the recovered log -- that is the log's own size and is unchanged from v1 -- so the assertion is on
 * the reader's reported peak (the number the format exists to bound), plus the child staying alive under the cap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isChunkedV2, sealChunkedToFile } from '../src/backup/chunked.mjs';
import { OLD_COPY_KIND, sealObject } from '../src/backup/crypto.mjs';
import { collectOrphanFullCopies } from '../src/backup/gc.mjs';
import { ensureLayout } from '../src/backup/layout.mjs';
import { openRepoKey } from '../src/backup/keystore.mjs';
import { syncToMirror } from '../src/backup/mirror.mjs';
import { OLD_RESTORE_CODES, applyOldRestore, planOldRestore } from '../src/backup/old-restore.mjs';
import { runBackup } from '../src/backup/engine.mjs';
import { OLD_FORMAT, FULL_COPY_SUFFIX, fullCopyPathFor } from '../src/backup/rotation.mjs';
import { writeJsonAtomic } from '../src/backup/atomic.mjs';
import { framesFor, header, runtimeValidHome, tempDir } from './helpers/backup-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_RESTORE_MODULE = pathToFileURL(path.join(ROOT, 'src', 'backup', 'old-restore.mjs')).href;
const WORKSPACE = '--E-GPT--';
const SESSION_A = 'session-aaaaaaaa-0001';
const SESSION_B = 'session-bbbbbbbb-0002';

/** The sha256 of a buffer as lowercase hex. */
function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** A deterministic, deliberately *not* a session log payload (for the memory test, where the doctor is forced). */
function patternOf(size) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

/** A valid session log (passes the static doctor) of `events` turns, used as a version's bytes. */
function validLog(sessionId, events = []) {
  const lines = [header(sessionId)];
  let seq = 0;
  for (const _ of events) {
    lines.push({ type: 'turn/start', seq, time: 1794842804375, data: { turn: seq + 1 } });
    seq += 1;
    lines.push({ type: 'turn/end', seq, time: 1794842804376, data: { turn: seq } });
    seq += 1;
  }
  if (events.length === 0) {
    lines.push({ type: 'turn/start', seq: 0, time: 1794842804375, data: { turn: 1 } });
    lines.push({ type: 'turn/end', seq: 1, time: 1794842804376, data: { turn: 1, reason: { kind: 'completed' } } });
  }
  return framesFor(lines);
}

/**
 * An unencrypted repository (the default `none` protection mode, so no credential and no KDF).
 *
 * `openRepoKey` mints the open envelope on first use, which is exactly what `run` does; the fixture needs
 * `backup.json` first, hence `ensureLayout`.
 */
function openFixture(prefix) {
  const { dir, cleanup } = tempDir(prefix);
  const root = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  ensureLayout(root);
  const key = openRepoKey({ root, dshHome: home, platform: 'linux', machineKey: false });
  assert.equal(key.ok, true, key.detail);
  return { dir, root, home, dek: key.dek, cleanup };
}

/** `20261118T100000Z` -> `2026-11-18T10:00:00.000Z` (the record's `recorded_at`). */
function isoFromCompact(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(stamp);
  assert.ok(match, `the fixture stamp must be a compact timestamp, got ${JSON.stringify(stamp)}`);
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
}

/**
 * Write one version record plus its copy in the format the caller names.
 *
 * `stamp` is the compact `20261118T100000Z` form `rotation` puts in file names (a literal ISO stamp contains `:`,
 * which no Windows filename may). The blocks list is empty on purpose: `old-restore` never reads blocks (that is
 * the whole point of the copy), so a fixture repository with no `objects/` at all is the failure mode modelled.
 *
 * @param {{repo: object, sessionId: string, bytes: Buffer, stamp: string, format: 'chunked-v2'|'v1',
 *   chunkBytes?: number}} input
 */
function writeVersion(input) {
  const { repo, sessionId, bytes, stamp, format } = input;
  const sha256 = sha256Hex(bytes);
  const recordName = `${stamp}-${sha256.slice(0, 12)}.json`;
  const recordFile = path.join(repo.root, 'old', WORKSPACE, sessionId, recordName);
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  const copyRel = `old/${WORKSPACE}/${sessionId}/${recordName}${FULL_COPY_SUFFIX}`;
  const record = {
    format: OLD_FORMAT,
    version: 1,
    rel: `sessions/${WORKSPACE}/${sessionId}/session.v4.jsonl.zstd`,
    session_id: sessionId,
    workspace: WORKSPACE,
    sha256,
    size: bytes.length,
    blocks: [],
    snapshot_id: `snapshot-${stamp}`,
    superseded_by: `next-${stamp}`,
    recorded_at: isoFromCompact(stamp),
    full_copy: {
      file: copyRel,
      sha256,
      size: bytes.length,
      ...(format === 'chunked-v2' ? { format: 'chunked-v2' } : {}),
    },
  };
  writeJsonAtomic(recordFile, record);
  const copyFile = fullCopyPathFor(repo.root, record);
  assert.ok(copyFile, 'the fixture must derive an old/ path for its copy');
  if (format === 'chunked-v2') {
    const written = sealChunkedToFile(bytes, {
      dek: repo.dek,
      sha256,
      size: bytes.length,
      chunkBytes: input.chunkBytes ?? 4 * 1024 * 1024,
      writeToFile: copyFile,
    });
    assert.equal(written.ok, true);
  } else {
    fs.writeFileSync(copyFile, sealObject(bytes, repo.dek, { sha256, length: bytes.length, kind: OLD_COPY_KIND }));
  }
  return { recordFile, record, copyFile, sha256 };
}

/** Plan one restore of `version` into a file beside the record (absolute paths; the CLI resolves its own). */
function planFor(repo, version, extra = {}) {
  return planOldRestore({
    root: repo.root,
    dshHome: repo.home,
    recordFile: version.recordFile,
    outFile: path.join(repo.dir, 'restored.log'),
    platform: 'linux',
    machineKey: false,
    now: new Date('2026-11-20T02:00:00.000Z'),
    ...extra,
  });
}

/** Every regular file under `<root>/old`, recursively, sorted. */
function oldFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(path.join(root, 'old'));
  return out.sort();
}

/** The offset just past the newline-terminated header of a v2 file. */
function headerEndOf(sealed) {
  assert.ok(isChunkedV2(sealed), 'the fixture must be a chunked file');
  const found = sealed.indexOf(0x0a, 8);
  assert.ok(found !== -1, 'the fixture must carry a newline-terminated header');
  return found + 1;
}

describe('old-restore: a chunked-v2 copy restores through the stream', () => {
  it('plans and applies the exact bytes, reporting streamed/peakChunkBytes and no whole-log buffer', () => {
    const repo = openFixture('w2m-oldc-v2-');
    try {
      const bytes = validLog(SESSION_A);
      const version = writeVersion({ repo, sessionId: SESSION_A, bytes, stamp: '20261118T100000Z', format: 'chunked-v2', chunkBytes: 64 });
      assert.equal(isChunkedV2(version.copyFile), true);

      const plan = planFor(repo, version);
      assert.equal(plan.ok, true, plan.detail);
      // The plan keys that existed before O3 are unchanged; the format facts are additive.
      assert.equal(plan.record.file, version.recordFile);
      assert.equal(plan.source_sha256, version.sha256);
      assert.deepEqual(Object.keys(plan.recovered).sort(), ['bytes', 'doctor_codes', 'doctor_ok', 'sha256']);
      assert.deepEqual(Object.keys(plan.apply_plan).sort(), ['backs_up_existing', 'bytes', 'mode', 'sha256', 'target']);
      assert.equal(plan.recovered.bytes, bytes.length);
      assert.equal(plan.recovered.sha256, version.sha256);
      assert.equal(plan.recovered.doctor_ok, true, 'the fixture log is valid, so the doctor passes');
      assert.equal(plan.copy_format, 'chunked-v2');
      assert.equal(plan.streamed, true);
      assert.equal(plan.peakChunkBytes, 64 + 28, 'a full 64-byte record: nonce + ciphertext + tag');
      assert.equal('plaintext' in plan, false, 'a v2 plan does not keep the recovered log in memory');
      assert.ok(JSON.stringify(plan).length < 4096, 'the JSON report stays small');
      assert.equal(fs.existsSync(plan.target.path), false, 'planning writes nothing');

      const applied = applyOldRestore({ plan, now: new Date('2026-11-20T02:00:00.000Z') });
      assert.equal(applied.ok, true, applied.detail);
      assert.equal(applied.file, path.join(repo.dir, 'restored.log'));
      assert.equal(applied.backup_file, null);
      assert.equal(applied.bytes, bytes.length);
      assert.equal(applied.sha256, version.sha256);
      assert.deepEqual(fs.readFileSync(applied.file), bytes, 'the restored file is the version byte for byte');
      assert.deepEqual(
        fs.readdirSync(repo.dir).filter((name) => name.includes('restore-tmp')),
        [],
        'the streamed write renamed its temporary sibling and left nothing behind',
      );
    } finally {
      repo.cleanup();
    }
  });

  it('starts from the v1 default only when the file is a v1 object (the record field is not trusted)', () => {
    const repo = openFixture('w2m-oldc-v1-');
    try {
      const bytes = validLog(SESSION_A);
      const version = writeVersion({ repo, sessionId: SESSION_A, bytes, stamp: '20261118T100000Z', format: 'v1' });
      assert.equal(isChunkedV2(version.copyFile), false);
      const plan = planFor(repo, version);
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.copy_format, 'v1');
      assert.equal(plan.streamed, false);
      assert.equal(plan.peakChunkBytes, null);
      assert.equal(plan.recovered.sha256, version.sha256);
      const applied = applyOldRestore({ plan });
      assert.equal(applied.ok, true, applied.detail);
      assert.deepEqual(fs.readFileSync(applied.file), bytes);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps the v1 .bak semantics on an overwrite, and refuses without --overwrite', () => {
    const repo = openFixture('w2m-oldc-bak-');
    try {
      const bytes = validLog(SESSION_A);
      const version = writeVersion({ repo, sessionId: SESSION_A, bytes, stamp: '20261118T100000Z', format: 'chunked-v2' });
      const outFile = path.join(repo.dir, 'restored.log');
      fs.writeFileSync(outFile, 'the bytes that were already there\n');

      const refused = planFor(repo, version);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, OLD_RESTORE_CODES.TARGET_EXISTS);
      assert.equal(applyOldRestore({ plan: refused }).ok, false);
      assert.equal(fs.readFileSync(outFile, 'utf8'), 'the bytes that were already there\n', 'the refusal wrote nothing');

      const plan = planFor(repo, version, { overwrite: true });
      assert.equal(plan.ok, true, plan.detail);
      assert.equal(plan.apply_plan.mode, 'overwrite');
      assert.equal(plan.apply_plan.backs_up_existing, true);
      const applied = applyOldRestore({ plan, now: new Date('2026-11-20T02:00:00.000Z') });
      assert.equal(applied.ok, true, applied.detail);
      assert.match(applied.backup_file, /restored\.log\.bak-\d{8}T\d{6}Z$/u);
      assert.equal(fs.readFileSync(applied.backup_file, 'utf8'), 'the bytes that were already there\n', 'the .bak is the way back');
      assert.deepEqual(fs.readFileSync(outFile), bytes, 'the target now holds the recovered version');
    } finally {
      repo.cleanup();
    }
  });

  it('refuses a target that changed after the plan instead of overwriting it', () => {
    const repo = openFixture('w2m-oldc-changed-');
    try {
      const bytes = validLog(SESSION_A);
      const version = writeVersion({ repo, sessionId: SESSION_A, bytes, stamp: '20261118T100000Z', format: 'chunked-v2' });
      const outFile = path.join(repo.dir, 'restored.log');
      const plan = planFor(repo, version);
      assert.equal(plan.ok, true, plan.detail);
      fs.writeFileSync(outFile, 'a client appended here while the plan sat around\n');
      const applied = applyOldRestore({ plan });
      assert.equal(applied.ok, false);
      assert.equal(applied.reason_code, OLD_RESTORE_CODES.TARGET_CHANGED);
      assert.equal(fs.readFileSync(outFile, 'utf8'), 'a client appended here while the plan sat around\n');
      assert.equal(fs.readdirSync(repo.dir).some((name) => name.startsWith('restored.log.bak-')), false, 'no .bak was written');
    } finally {
      repo.cleanup();
    }
  });

  it('refuses a copy that changed between plan and apply (the stream re-verifies the identity)', () => {
    const repo = openFixture('w2m-oldc-swapped-');
    try {
      const bytes = validLog(SESSION_A);
      const version = writeVersion({ repo, sessionId: SESSION_A, bytes, stamp: '20261118T100000Z', format: 'chunked-v2' });
      const outFile = path.join(repo.dir, 'restored.log');
      const plan = planFor(repo, version);
      assert.equal(plan.ok, true, plan.detail);
      // Replace the copy with a valid v2 file of different bytes: it authenticates, but not as this record.
      const other = validLog(SESSION_A, [1, 2]);
      sealChunkedToFile(other, { dek: repo.dek, writeToFile: version.copyFile });
      const applied = applyOldRestore({ plan });
      assert.equal(applied.ok, false);
      assert.equal(applied.reason_code, OLD_RESTORE_CODES.CORRUPT);
      assert.match(applied.detail, /BACKUP_CHUNKED_/u);
      assert.equal(fs.existsSync(outFile), false, 'nothing was written');
      assert.deepEqual(fs.readdirSync(repo.dir).filter((name) => name.includes('restore-tmp')), []);
    } finally {
      repo.cleanup();
    }
  });
});

describe('old-restore: damaged v2 copies are named, and no bytes are written', () => {
  /** Build one fixture repo with a multi-chunk copy and return what the damage helpers need. */
  function damagedFixture(prefix) {
    const repo = openFixture(prefix);
    const bytes = Buffer.concat([validLog(SESSION_A), Buffer.alloc(200, 0x41)]);
    const version = writeVersion({ repo, sessionId: SESSION_A, bytes, stamp: '20261118T100000Z', format: 'chunked-v2', chunkBytes: 64 });
    return { repo, bytes, version };
  }

  it('names a flipped ciphertext byte as BACKUP_CHUNKED_AUTH_FAILED inside the CORRUPT refusal', () => {
    const { repo, version } = damagedFixture('w2m-oldc-damage-flip-');
    try {
      const sealed = fs.readFileSync(version.copyFile);
      sealed[headerEndOf(sealed) + 12 + 3] ^= 0x01;
      fs.writeFileSync(version.copyFile, sealed);
      const plan = planFor(repo, version);
      assert.equal(plan.ok, false);
      assert.equal(plan.reason_code, OLD_RESTORE_CODES.CORRUPT);
      assert.match(plan.detail, /does not open as the recorded version/u);
      assert.match(plan.detail, /BACKUP_CHUNKED_AUTH_FAILED/u);
      assert.equal(fs.existsSync(path.join(repo.dir, 'restored.log')), false);
      assert.equal(applyOldRestore({ plan }).ok, false);
    } finally {
      repo.cleanup();
    }
  });

  it('names a short file as BACKUP_CHUNKED_TRUNCATED', () => {
    const { repo, version } = damagedFixture('w2m-oldc-damage-truncate-');
    try {
      fs.truncateSync(version.copyFile, fs.statSync(version.copyFile).size - 1);
      const plan = planFor(repo, version);
      assert.equal(plan.ok, false);
      assert.equal(plan.reason_code, OLD_RESTORE_CODES.CORRUPT);
      assert.match(plan.detail, /BACKUP_CHUNKED_TRUNCATED/u);
      assert.equal(fs.existsSync(path.join(repo.dir, 'restored.log')), false);
    } finally {
      repo.cleanup();
    }
  });

  it('names a copy retargeted at another version as a chunked header refusal, not a decryption guess', () => {
    const { repo, version } = damagedFixture('w2m-oldc-damage-retarget-');
    try {
      const sealed = fs.readFileSync(version.copyFile);
      const end = headerEndOf(sealed);
      const parsed = JSON.parse(sealed.subarray(8, end - 1).toString('utf8'));
      const other = (parsed.sha256[0] === 'a' ? 'b' : 'a').repeat(64);
      fs.writeFileSync(
        version.copyFile,
        Buffer.concat([sealed.subarray(0, 8), Buffer.from(`${JSON.stringify({ ...parsed, sha256: other })}\n`, 'utf8'), sealed.subarray(end)]),
      );
      const plan = planFor(repo, version);
      assert.equal(plan.ok, false);
      assert.equal(plan.reason_code, OLD_RESTORE_CODES.CORRUPT);
      assert.match(plan.detail, /BACKUP_CHUNKED_(HEADER_INVALID|AUTH_FAILED)/u);
    } finally {
      repo.cleanup();
    }
  });
});

describe('old-restore: a repository holding both formats', () => {
  it('restores a v1 record and a v2 record from the same old/ tree (mixed repository)', () => {
    const repo = openFixture('w2m-oldc-mixed-');
    try {
      const bytesA = validLog(SESSION_A);
      const bytesB = validLog(SESSION_B, [1, 2]);
      const versionA = writeVersion({ repo, sessionId: SESSION_A, bytes: bytesA, stamp: '20261118T090000Z', format: 'v1' });
      const versionB = writeVersion({ repo, sessionId: SESSION_B, bytes: bytesB, stamp: '20261118T100000Z', format: 'chunked-v2', chunkBytes: 256 });
      assert.equal(isChunkedV2(versionA.copyFile), false);
      assert.equal(isChunkedV2(versionB.copyFile), true);
      assert.equal(oldFiles(repo.root).filter((file) => file.endsWith('.json')).length, 2);
      assert.equal(oldFiles(repo.root).filter((file) => file.endsWith('.json.enc')).length, 2);

      const planA = planFor(repo, versionA, { outFile: path.join(repo.dir, 'a.log') });
      assert.equal(planA.ok, true, planA.detail);
      assert.equal(planA.copy_format, 'v1');
      assert.equal(applyOldRestore({ plan: planA }).ok, true);
      assert.deepEqual(fs.readFileSync(path.join(repo.dir, 'a.log')), bytesA);

      const planB = planFor(repo, versionB, { outFile: path.join(repo.dir, 'b.log') });
      assert.equal(planB.ok, true, planB.detail);
      assert.equal(planB.copy_format, 'chunked-v2');
      assert.equal(planB.streamed, true);
      const appliedB = applyOldRestore({ plan: planB });
      assert.equal(appliedB.ok, true, appliedB.detail);
      assert.deepEqual(fs.readFileSync(path.join(repo.dir, 'b.log')), bytesB);

      // The gc orphan sweep is format-agnostic: both copies are referenced, so it removes neither.
      const sweep = collectOrphanFullCopies({ root: repo.root, dryRun: true });
      assert.equal(sweep.scanned, 2);
      assert.equal(sweep.removed, 0);
    } finally {
      repo.cleanup();
    }
  });
});

/** A repository holding one rotated `full` version, built through the engine (the real writer path). */
function engineRepoWithCopy(homeDir) {
  const { dir, cleanup } = tempDir('w2m-oldc-engine-');
  const root = path.join(dir, 'repo');
  const first = runBackup({ root, dshHome: homeDir, platform: 'linux', machineKey: false });
  assert.equal(first.ok, true, first.detail);
  const log = path.join(homeDir, 'sessions', WORKSPACE, SESSION_A, 'session.v4.jsonl.zstd');
  fs.writeFileSync(log, framesFor([header(SESSION_A), { type: 'turn/start', seq: 0, time: 1794842804375, data: { turn: 1 } }]));
  const second = runBackup({ root, dshHome: homeDir, platform: 'linux', machineKey: false, oldFormat: 'full' });
  assert.equal(second.ok, true, second.detail);
  assert.equal(second.rotated, 1);
  const key = openRepoKey({ root, dshHome: homeDir, platform: 'linux', machineKey: false });
  assert.equal(key.ok, true, key.detail);
  return { dir, root, home: homeDir, dek: key.dek, snapshotId: second.snapshot_id, cleanup };
}

describe('gc and mirror with chunked-v2 copies (the rest of the old/ tree is format-agnostic)', () => {
  it('gc removes an unreferenced v2 copy and keeps a referenced one', () => {
    const repo = openFixture('w2m-oldc-gc-');
    try {
      const kept = writeVersion({ repo, sessionId: SESSION_A, bytes: validLog(SESSION_A), stamp: '20261118T090000Z', format: 'chunked-v2' });
      const orphaned = writeVersion({ repo, sessionId: SESSION_B, bytes: validLog(SESSION_B), stamp: '20261118T100000Z', format: 'chunked-v2' });
      assert.equal(isChunkedV2(orphaned.copyFile), true);
      // Drop the record: its copy is now an orphan, exactly the crash window rotation's failure order leaves.
      fs.rmSync(orphaned.recordFile);

      const dry = collectOrphanFullCopies({ root: repo.root, dryRun: true });
      assert.equal(dry.scanned, 2);
      assert.deepEqual(dry.files, [orphaned.copyFile]);
      assert.equal(fs.existsSync(orphaned.copyFile), true, 'a dry run deletes nothing');

      const sweep = collectOrphanFullCopies({ root: repo.root });
      assert.equal(sweep.removed, 1);
      assert.equal(fs.existsSync(orphaned.copyFile), false, 'the unreferenced v2 copy is removed');
      assert.equal(fs.existsSync(kept.copyFile), true, 'a referenced v2 copy is never removed');
      assert.equal(fs.existsSync(kept.recordFile), true);
      assert.deepEqual(collectOrphanFullCopies({ root: repo.root }).removed, 0, 'a second sweep has nothing left');
    } finally {
      repo.cleanup();
    }
  });

  it('mirrors a v2 record and its copy byte-identically, then re-syncs for free', () => {
    const home = runtimeValidHome();
    const repo = engineRepoWithCopy(home.home);
    try {
      // Add a v1 record beside the engine-written v2 one: the mirror must carry both kinds unchanged.
      const v1Bytes = validLog(SESSION_B, [1]);
      const v1 = writeVersion({
        repo,
        sessionId: SESSION_B,
        bytes: v1Bytes,
        stamp: '20261118T080000Z',
        format: 'v1',
      });
      const primaryOld = oldFiles(repo.root);
      const enc = primaryOld.filter((file) => file.endsWith('.json.enc'));
      assert.equal(enc.length, 2, 'one engine-written v2 copy and one v1 copy');
      assert.equal(enc.some((file) => isChunkedV2(file)), true);
      assert.equal(enc.some((file) => !isChunkedV2(file)), true);
      assert.equal(isChunkedV2(v1.copyFile), false);

      const mirrorRoot = path.join(repo.dir, 'mirror');
      const first = syncToMirror({ root: repo.root, mirrorRoot, dshHome: home.home, snapshotId: repo.snapshotId });
      assert.equal(first.ok, true, first.detail);
      for (const file of primaryOld) {
        const rel = path.relative(path.join(repo.root, 'old'), file);
        const mirrored = path.join(mirrorRoot, 'old', rel);
        assert.equal(fs.existsSync(mirrored), true, `the mirror is missing old/${rel}`);
        assert.deepEqual(fs.readFileSync(mirrored), fs.readFileSync(file), `old/${rel} must be byte-identical`);
      }
      const second = syncToMirror({ root: repo.root, mirrorRoot, dshHome: home.home, snapshotId: repo.snapshotId });
      assert.equal(second.ok, true, second.detail);
      assert.deepEqual(second.copied, { files: 0, bytes: 0, repaired: 0, old_files: 0, old_bytes: 0 });
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });
});

describe('old-restore: a 32 MiB v2 copy restores under a 64 MiB heap', () => {
  it('streams 8 records of 4 MiB, reporting a one-record peak', () => {
    const repo = openFixture('w2m-oldc-memory-');
    try {
      const totalBytes = 32 * 1024 * 1024;
      const chunkBytes = 4 * 1024 * 1024;
      const version = writeVersion({
        repo,
        sessionId: SESSION_A,
        bytes: patternOf(totalBytes),
        stamp: '20261118T100000Z',
        format: 'chunked-v2',
        chunkBytes,
      });
      const outFile = path.join(repo.dir, 'restored.bin');
      const script = path.join(repo.dir, 'restore-child.mjs');
      fs.writeFileSync(
        script,
        [
          `import fs from 'node:fs';`,
          `import { createHash } from 'node:crypto';`,
          `import { planOldRestore, applyOldRestore } from ${JSON.stringify(OLD_RESTORE_MODULE)};`,
          'const [root, dshHome, recordFile, outFile] = process.argv.slice(2);',
          "const plan = planOldRestore({ root, dshHome, recordFile, outFile, forceInvalid: true, platform: 'linux', machineKey: false });",
          'const applied = plan.ok === true ? applyOldRestore({ plan }) : null;',
          'const digest = applied !== null && applied.ok === true ? createHash("sha256").update(fs.readFileSync(outFile)).digest("hex") : null;',
          'process.stdout.write(JSON.stringify({',
          '  plan_ok: plan.ok === true,',
          '  reason_code: plan.reason_code ?? null,',
          '  streamed: plan.streamed === true,',
          '  copy_format: plan.copy_format ?? null,',
          '  peak: plan.peakChunkBytes ?? null,',
          '  recovered_bytes: plan.recovered?.bytes ?? null,',
          '  doctor_ok: plan.recovered?.doctor_ok ?? null,',
          '  applied_ok: applied?.ok === true,',
          '  applied_bytes: applied?.bytes ?? null,',
          '  digest,',
          '  heap_used: process.memoryUsage().heapUsed,',
          '}) + "\\n");',
        ].join('\n'),
      );
      const child = spawnSync(
        process.execPath,
        ['--max-old-space-size=64', script, repo.root, repo.home, version.recordFile, outFile],
        { encoding: 'utf8', timeout: 180_000 },
      );
      assert.equal(child.status, 0, `the child died instead of streaming: ${child.stderr}`);
      const report = JSON.parse(child.stdout.trim().split('\n').pop());
      assert.equal(report.plan_ok, true, `${report.reason_code}: the plan must succeed with --force-invalid under the cap`);
      assert.equal(report.streamed, true);
      assert.equal(report.copy_format, 'chunked-v2');
      assert.equal(report.recovered_bytes, totalBytes);
      assert.equal(report.peak, chunkBytes + 28, `the reader held ${report.peak} bytes, not one ${chunkBytes}-byte record`);
      assert.equal(report.applied_ok, true, 'the streamed write completed');
      assert.equal(report.applied_bytes, totalBytes);
      assert.equal(report.digest, sha256Hex(patternOf(totalBytes)), 'the restored bytes are the plaintext');
      assert.ok(report.heap_used < 64 * 1024 * 1024, `the child heap stayed under its cap (${report.heap_used} bytes)`);
      assert.deepEqual(fs.readdirSync(repo.dir).filter((name) => name.includes('restore-tmp')), []);
    } finally {
      repo.cleanup();
    }
  });
});
