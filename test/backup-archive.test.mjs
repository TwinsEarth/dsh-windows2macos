/**
 * Archive packs: a self-describing `.tar.zst` whose manifest is checked against the bytes it ships.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { join } from 'node:path';

import { runBackup } from '../src/backup/engine.mjs';
import { buildArchive, extractArchive, readArchive } from '../src/backup/archive.mjs';
import { readTar, writeTar } from '../src/backup/tar.mjs';
import { makeHome, registryDocument, runtimeValidHome, runtimeValidSessionLog, tempDir } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const WORKSPACE = '--E-GPT--';

/** A home with one archived and one active runtime-valid session. */
function twoSessionHome() {
  const home = makeHome({
    sessions: [
      { workspace: WORKSPACE, id: 'session-aaaaaaaa-0001' },
      { workspace: WORKSPACE, id: 'session-bbbbbbbb-0002' },
    ],
    registry: registryDocument({ sessionIds: ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002'], archived: ['session-bbbbbbbb-0002'] }),
  });
  for (const id of ['session-aaaaaaaa-0001', 'session-bbbbbbbb-0002']) {
    fs.writeFileSync(join(home.home, 'sessions', WORKSPACE, id, 'session.v4.jsonl.zstd'), runtimeValidSessionLog(id));
  }
  return home;
}

function repoFor(home) {
  const repo = tempDir('w2m-archive-repo-');
  const run = runBackup({ root: repo.dir, dshHome: home, password: PASSWORD, platform: 'linux', machineKey: false });
  assert.equal(run.ok, true, run.detail);
  return repo;
}

describe('tar: the container itself', () => {
  it('round-trips entries, including an empty file and a path longer than 100 bytes', () => {
    const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.bin`;
    const entries = [
      { name: 'manifest.json', data: '{"a":1}\n', mtimeMs: 1794842804375 },
      { name: 'empty.txt', data: '', mtimeMs: 1794842804375 },
      { name: long, data: Buffer.from([1, 2, 3]), mtimeMs: 1794842804375 },
    ];
    const tar = writeTar(entries);
    assert.equal(tar.length % 512, 0);
    const back = readTar(tar);
    assert.deepEqual(back.map((entry) => entry.name), ['manifest.json', 'empty.txt', long]);
    assert.equal(back[0].data.toString('utf8'), '{"a":1}\n');
    assert.equal(back[1].data.length, 0);
    assert.deepEqual([...back[2].data], [1, 2, 3]);
    assert.equal(back[0].mtimeMs, 1794842804000, 'mtime is stored to the second, as ustar defines');
  });

  it('refuses a path that cannot be expressed in ustar at all', () => {
    assert.throws(() => writeTar([{ name: `${'x'.repeat(200)}/file`, data: '' }]), /too long/u);
  });

  it('refuses a truncated archive instead of returning partial data', () => {
    const tar = writeTar([{ name: 'a.bin', data: Buffer.alloc(2000, 7) }]);
    assert.throws(() => readTar(tar.subarray(0, 700)), /past the end/u);
  });
});

describe('archive: building a pack', () => {
  it('packs only archived sessions by default, verified against the repository bytes', () => {
    const home = twoSessionHome();
    const repo = repoFor(home.home);
    try {
      const result = buildArchive({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.sessions, 1, 'only the archived session belongs in the default pack');
      assert.ok(fs.existsSync(result.file));
      assert.ok(result.compressed_bytes < result.bytes, 'the zstd stream must actually compress');

      const read = readArchive(result.file);
      assert.equal(read.ok, true, read.detail);
      assert.equal(read.manifest.counts.sessions, 1);
      assert.equal(read.manifest.files[0].session_id, 'session-bbbbbbbb-0002');

      const extracted = extractArchive({ file: result.file, destDir: join(repo.dir, 'extract') });
      assert.equal(extracted.ok, true, extracted.detail);
      const log = join(repo.dir, 'extract', 'sessions', WORKSPACE, 'session-bbbbbbbb-0002', 'session.v4.jsonl.zstd');
      assert.ok(fs.readFileSync(log).equals(runtimeValidSessionLog('session-bbbbbbbb-0002')));
      assert.ok(fs.existsSync(join(repo.dir, 'extract', 'manifest.json')));
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('packs every session for scope=all, and keeps the archive inside the repository', () => {
    const home = twoSessionHome();
    const repo = repoFor(home.home);
    try {
      const result = buildArchive({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false, scope: 'all' });
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.sessions, 2);
      assert.ok(result.files >= 2, `the pack carries both sessions plus the expanded-scope entries, got ${result.files}`);
      assert.ok(result.counts.registry >= 1, 'the registry document travels with the pack');
      assert.ok(result.file.startsWith(join(repo.dir, 'archive')), result.file);
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('refuses an empty pack rather than writing a manifest with nothing in it', () => {
    const home = runtimeValidHome(); // one session, not archived
    const repo = repoFor(home.home);
    try {
      const result = buildArchive({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_ARCHIVE_EMPTY');
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('reports a tampered archive as a digest problem, not as usable content', () => {
    const home = twoSessionHome();
    const repo = repoFor(home.home);
    try {
      const result = buildArchive({ root: repo.dir, dshHome: home.home, password: PASSWORD, platform: 'linux', machineKey: false });
      assert.equal(result.ok, true);
      // Rebuild the same tar with one file's bytes changed, then compress it again.
      const entries = readTar(zlib.zstdDecompressSync(fs.readFileSync(result.file)));
      const victim = entries.find((entry) => entry.name.startsWith('sessions/'));
      victim.data = Buffer.from(victim.data.map((byte, index) => (index === 0 ? byte ^ 0xff : byte)));
      const tampered = zlib.zstdCompressSync(writeTar(entries));
      const verdict = readArchive(tampered);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason_code, 'BACKUP_MANIFEST_DIGEST_MISMATCH');
      assert.ok(verdict.problems.some((problem) => problem.rel === victim.name));
    } finally {
      repo.cleanup();
      home.cleanup();
    }
  });

  it('refuses to extract an entry that would land outside the destination', () => {
    const evil = zlib.zstdCompressSync(
      writeTar([
        { name: 'manifest.json', data: JSON.stringify({ format: 'w2m-session-backup/archive', version: 1, files: [] }) },
        { name: '../escape.txt', data: 'x' },
      ]),
    );
    const scratch = tempDir('w2m-archive-evil-');
    try {
      const file = join(scratch.dir, 'evil.tar.zst');
      fs.writeFileSync(file, evil);
      const result = extractArchive({ file, destDir: join(scratch.dir, 'out') });
      assert.equal(result.ok, false);
      assert.match(result.detail, /outside the destination/u);
      assert.equal(fs.existsSync(join(scratch.dir, 'escape.txt')), false);
    } finally {
      scratch.cleanup();
    }
  });
});
