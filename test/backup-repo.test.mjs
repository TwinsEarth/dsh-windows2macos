/**
 * Backup repository protocol: snapshot ids, the two files a snapshot owns, and the append-only index.
 *
 * The index is what makes a snapshot *claimable* after a crash, so the tests centre on its failure modes: a torn
 * last line (tolerated and reported), a corrupt middle line (reported, remaining lines still read), and a write
 * that does not read back (refused at commit time). The write path is exercised only in throwaway directories:
 * in v3.4.6 the routes and CLI never commit a snapshot.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  INDEX_FORMAT,
  INDEX_KEYS,
  INDEX_VERSION,
  REPO_CODES,
  SNAPSHOT_ID_RE,
  appendIndex,
  commitSnapshot,
  indexEntry,
  listSnapshots,
  makeSnapshotId,
  openRepo,
  readIndex,
  readSnapshot,
  serializeIndexEntry,
  snapshotPaths,
  validateIndexEntry,
} from '../src/backup/repo.mjs';
import { ensureLayout, repoPaths } from '../src/backup/layout.mjs';
import { buildManifest, manifestDigest } from '../src/backup/manifest.mjs';
import { MIN_SCRYPT, randomDek, wrapDek } from '../src/backup/crypto.mjs';
import { buildStatus } from '../src/backup/routes.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

/** The cheapest scrypt the module will create, so the suite is fast without weakening the format. */
const KDF = { algo: 'scrypt', N: MIN_SCRYPT.N, r: MIN_SCRYPT.r, p: MIN_SCRYPT.p, keylen: 32 };

/** A valid (empty) manifest with a repository-shaped snapshot id. */
function manifestFor(snapshotId, extra = {}) {
  return buildManifest({
    snapshotId,
    createdAt: new Date('2026-11-17T00:00:00.000Z'),
    dshHome: 'C:\\Users\\x\\.dsh',
    registry: { workspaces: 1, registered: 1, archived: 0, pinned: 0 },
    ...extra,
  });
}

/** A valid key file with one password envelope. */
function keysFor() {
  return wrapDek(randomDek(), [{ kind: 'password', secret: 'correct horse battery staple' }], { kdf: KDF, now: new Date('2026-11-17T00:00:00.000Z') });
}

/** A repository root plus cleanup. */
function repoFixture() {
  const { dir, cleanup } = tempDir('w2m-repo-');
  const root = join(dir, 'repo');
  ensureLayout(root);
  return { root, dir, cleanup };
}

/** Every file under `root` with size and mtime, for the read-only assertion. */
function treeState(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = statSync(full);
        out.set(relative(root, full).split('\\').join('/'), `${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

describe('repo: snapshot ids', () => {
  it('mints sortable ids of the frozen shape', () => {
    const early = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
    const late = makeSnapshotId(new Date('2026-11-17T00:00:01.000Z'), '00000001');
    assert.match(early, SNAPSHOT_ID_RE);
    assert.equal(early, '20261117T000000Z-deadbeef');
    assert.ok(early < late, 'lexicographic order must be chronological order');
    assert.notEqual(makeSnapshotId(new Date('2026-11-17T00:00:00.000Z')), makeSnapshotId(new Date('2026-11-17T00:00:00.000Z')));
  });

  it('refuses entropy that would break the frozen shape', () => {
    assert.throws(() => makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'NOT-HEX!!'), (error) => error.code === REPO_CODES.ID_INVALID);
    assert.throws(() => makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'abc'), (error) => error.code === REPO_CODES.ID_INVALID);
  });

  it('derives the two files a snapshot owns, and refuses a foreign directory name', () => {
    const paths = repoPaths('D:\\BackUP');
    const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
    const snapshot = snapshotPaths(paths, id);
    assert.equal(snapshot.dir, join(paths.snapshots, id));
    assert.equal(snapshot.manifest, join(snapshot.dir, 'manifest.json'));
    assert.equal(snapshot.keys, join(snapshot.dir, 'keys.json'));
    assert.throws(() => snapshotPaths(paths, '../escape'), (error) => error.code === REPO_CODES.ID_INVALID);
  });
});

describe('repo: the index line', () => {
  it('freezes the line shape and carries counts only', () => {
    const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
    const manifest = manifestFor(id);
    const entry = indexEntry(manifest);
    assert.deepEqual(Object.keys(entry).sort(), [...INDEX_KEYS].sort());
    assert.equal(entry.format, INDEX_FORMAT);
    assert.equal(entry.version, INDEX_VERSION);
    assert.equal(entry.snapshot_id, id);
    assert.equal(entry.digest, manifestDigest(manifest));
    assert.equal(entry.files, manifest.counts.files);
    assert.equal(entry.bytes, manifest.counts.bytes);
    assert.equal(validateIndexEntry(entry).ok, true);
    const text = JSON.stringify(entry);
    assert.ok(!text.includes('sessions/'), 'the index must not carry a path');
    assert.ok(!text.includes('--E-GPT--'), 'the index must not carry a workspace name');
  });

  it('refuses a line with an unknown key or a bad digest', () => {
    const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
    const entry = indexEntry(manifestFor(id));
    assert.equal(validateIndexEntry({ ...entry, extra: 1 }).ok, false);
    assert.equal(validateIndexEntry({ ...entry, digest: 'nope' }).ok, false);
    assert.equal(validateIndexEntry({ ...entry, snapshot_id: 'snapshot-x' }).ok, false);
    assert.equal(validateIndexEntry(null).ok, false);
  });

  it('serialises canonically with the trailing newline the append format requires', () => {
    const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
    const entry = indexEntry(manifestFor(id));
    const line = serializeIndexEntry(entry);
    assert.ok(line.endsWith('\n'));
    assert.equal(line.slice(0, -1), serializeIndexEntry({ ...entry }).slice(0, -1));
    assert.throws(() => serializeIndexEntry({ ...entry, version: 9 }), (error) => error.code === REPO_CODES.INDEX_LINE_INVALID);
  });
});

describe('repo: reading and appending the index', () => {
  it('reports an absent index as an empty, healthy one', () => {
    const { root, cleanup } = repoFixture();
    try {
      const index = readIndex(root);
      assert.equal(index.exists, false);
      assert.deepEqual(index.entries, []);
      assert.equal(index.ok, true);
    } finally {
      cleanup();
    }
  });

  it('reads valid lines, tolerates a torn tail, and reports a corrupt middle line without throwing', () => {
    const { root, cleanup } = repoFixture();
    try {
      const paths = repoPaths(root);
      const first = indexEntry(manifestFor(makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'aaaaaaaa')));
      const second = indexEntry(manifestFor(makeSnapshotId(new Date('2026-11-17T00:01:00.000Z'), 'bbbbbbbb')));
      const third = indexEntry(manifestFor(makeSnapshotId(new Date('2026-11-17T00:02:00.000Z'), 'cccccccc')));

      writeFileSync(paths.index, `${serializeIndexEntry(first)}{ not json\n${serializeIndexEntry(second)}`);
      const parsed = readIndex(root);
      assert.equal(parsed.entries.length, 2, 'the two valid lines must still be read');
      assert.equal(parsed.problems.length, 1);
      assert.equal(parsed.problems[0].line, 2);
      assert.equal(parsed.ok, false);

      // A torn final line is a crash during append, not corruption: report it, do not invent the entry.
      writeFileSync(paths.index, `${serializeIndexEntry(first)}${serializeIndexEntry(second)}${JSON.stringify(third).slice(0, 40)}`);
      const torn = readIndex(root);
      assert.equal(torn.torn_tail, true);
      assert.equal(torn.entries.length, 2);
      assert.equal(torn.problems.length, 0);
      assert.equal(torn.ok, true);
    } finally {
      cleanup();
    }
  });

  it('appends an entry and reads it back, refusing a line it cannot reproduce', () => {
    const { root, cleanup } = repoFixture();
    try {
      const entry = indexEntry(manifestFor(makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef')));
      const result = appendIndex({ root, entry });
      assert.equal(result.appended, true);
      const index = readIndex(root);
      assert.equal(index.entries.length, 1);
      assert.equal(index.entries[0].snapshot_id, entry.snapshot_id);
      assert.equal(index.torn_tail, false);
    } finally {
      cleanup();
    }
  });
});

describe('repo: committing a snapshot', () => {
  it('stages both files, renames the directory into place, and records one index line', () => {
    const { root, cleanup } = repoFixture();
    try {
      const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
      const manifest = manifestFor(id);
      const keys = keysFor();
      const committed = commitSnapshot({ root, manifest, keys });
      assert.equal(committed.snapshot_id, id);
      assert.equal(committed.digest, manifestDigest(manifest));
      const paths = repoPaths(root);
      assert.deepEqual(existsSync(join(paths.snapshots, id, 'manifest.json')), true);
      assert.deepEqual(existsSync(join(paths.snapshots, id, 'keys.json')), true);
      assert.deepEqual(readdirSync(paths.tmp), [], 'staging must be cleaned up');
      assert.equal(readIndex(root).entries.length, 1);

      const snapshot = readSnapshot({ root, snapshotId: id });
      assert.equal(snapshot.manifest.snapshot_id, id);
      assert.equal(snapshot.keys.format, 'w2m-session-backup/keys');
      assert.equal(snapshot.digest, committed.digest);
    } finally {
      cleanup();
    }
  });

  it('refuses to overwrite an existing snapshot id', () => {
    const { root, cleanup } = repoFixture();
    try {
      const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
      commitSnapshot({ root, manifest: manifestFor(id), keys: keysFor() });
      assert.throws(
        () => commitSnapshot({ root, manifest: manifestFor(id), keys: keysFor() }),
        (error) => error.code === REPO_CODES.SNAPSHOT_EXISTS,
      );
      assert.equal(readIndex(root).entries.length, 1, 'a refused retry must not append');
    } finally {
      cleanup();
    }
  });

  it('refuses to commit into a directory that is not an initialised repository', () => {
    const { dir, cleanup } = tempDir('w2m-repo-uninit-');
    try {
      const root = join(dir, 'empty');
      mkdirSync(root, { recursive: true });
      const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
      assert.throws(
        () => commitSnapshot({ root, manifest: manifestFor(id), keys: keysFor() }),
        (error) => error.code === REPO_CODES.NOT_INITIALIZED,
      );
      assert.deepEqual(readdirSync(root), [], 'a refused commit must not create anything');
    } finally {
      cleanup();
    }
  });

  it('refuses an invalid manifest or key file before writing anything', () => {
    const { root, cleanup } = repoFixture();
    try {
      const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
      assert.throws(
        () => commitSnapshot({ root, manifest: { ...manifestFor(id), version: 9 }, keys: keysFor() }),
        (error) => error.code === REPO_CODES.SNAPSHOT_INVALID,
      );
      assert.throws(
        () => commitSnapshot({ root, manifest: manifestFor(id), keys: { format: 'nope' } }),
        (error) => error.code === REPO_CODES.SNAPSHOT_INVALID,
      );
      assert.deepEqual(readdirSync(repoPaths(root).snapshots), [], 'nothing may be written for an invalid snapshot');
    } finally {
      cleanup();
    }
  });

  it('reports a missing or tampered snapshot instead of returning half of it', () => {
    const { root, cleanup } = repoFixture();
    try {
      const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
      commitSnapshot({ root, manifest: manifestFor(id), keys: keysFor() });
      assert.throws(() => readSnapshot({ root, snapshotId: makeSnapshotId(new Date('2026-11-17T01:00:00.000Z'), 'aaaaaaaa') }), (error) => error.code === REPO_CODES.SNAPSHOT_MISSING);

      const snapshotFile = snapshotPaths(repoPaths(root), id).manifest;
      writeFileSync(snapshotFile, JSON.stringify({ ...manifestFor(id), version: 9 }));
      assert.throws(() => readSnapshot({ root, snapshotId: id }), (error) => error.code === REPO_CODES.SNAPSHOT_INVALID);

      writeFileSync(snapshotFile, JSON.stringify({ ...manifestFor(id), snapshot_id: makeSnapshotId(new Date('2026-11-17T02:00:00.000Z'), 'ffffffff') }));
      assert.throws(() => readSnapshot({ root, snapshotId: id }), (error) => error.code === REPO_CODES.SNAPSHOT_INVALID);
    } finally {
      cleanup();
    }
  });
});

describe('repo: opening a repository read-only', () => {
  it('reports an absent directory as a state and creates nothing', () => {
    const { dir, cleanup } = tempDir('w2m-repo-absent-');
    try {
      const root = join(dir, 'missing');
      const state = openRepo({ root });
      assert.equal(state.ok, true);
      assert.equal(state.initialized, false);
      assert.deepEqual(state.snapshots, []);
      assert.equal(state.latest, null);
      assert.equal(existsSync(root), false, 'openRepo must not create the repository');
    } finally {
      cleanup();
    }
  });

  it('reports an initialised repository with its snapshots, latest digest and index health', () => {
    const { root, cleanup } = repoFixture();
    try {
      const first = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'aaaaaaaa');
      const second = makeSnapshotId(new Date('2026-11-17T00:01:00.000Z'), 'bbbbbbbb');
      commitSnapshot({ root, manifest: manifestFor(first), keys: keysFor() });
      commitSnapshot({ root, manifest: manifestFor(second), keys: keysFor() });
      const state = openRepo({ root });
      assert.equal(state.ok, true);
      assert.equal(state.initialized, true);
      assert.equal(state.snapshots.length, 2);
      assert.deepEqual(state.snapshots.map((row) => row.snapshot_id), [second, first], 'newest first');
      assert.equal(state.latest.snapshot_id, second);
      assert.match(state.latest.digest, /^[0-9a-f]{64}$/u);
      assert.equal(state.index.entries, 2);
      assert.equal(state.index.problems, 0);
      assert.equal(state.index.latest_digest, state.latest.digest);
    } finally {
      cleanup();
    }
  });

  it('is read-only: opening twice leaves every file and mtime identical', () => {
    const { root, cleanup } = repoFixture();
    try {
      commitSnapshot({ root, manifest: manifestFor(makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef')), keys: keysFor() });
      const before = treeState(root);
      openRepo({ root, full: true });
      openRepo({ root, full: true });
      assert.deepEqual(treeState(root), before);
    } finally {
      cleanup();
    }
  });

  it('surfaces a corrupt index line as a refusal while still listing the snapshots', () => {
    const { root, cleanup } = repoFixture();
    try {
      const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
      commitSnapshot({ root, manifest: manifestFor(id), keys: keysFor() });
      const paths = repoPaths(root);
      writeFileSync(paths.index, `${readFileSync(paths.index, 'utf8')}{ broken\n`);
      const state = openRepo({ root });
      assert.equal(state.ok, false);
      assert.equal(state.error.code, REPO_CODES.INDEX_LINE_INVALID);
      assert.equal(state.index.problems, 1);
      assert.equal(state.snapshots.length, 1, 'the snapshot is still on disk and still listable');
    } finally {
      cleanup();
    }
  });

  it('reports a repository written by a newer version instead of opening it', () => {
    const { root, cleanup } = repoFixture();
    try {
      writeFileSync(repoPaths(root).descriptor, JSON.stringify({ format: 'w2m-session-backup', version: 99 }));
      const state = openRepo({ root });
      assert.equal(state.ok, false);
      assert.equal(state.initialized, false);
      assert.equal(state.error.code, 'BACKUP_REPO_VERSION_UNSUPPORTED');
    } finally {
      cleanup();
    }
  });

  it('lists the oldest snapshots unvalidated unless full is asked for', () => {
    const { root, cleanup } = repoFixture();
    try {
      const first = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'aaaaaaaa');
      const second = makeSnapshotId(new Date('2026-11-17T00:01:00.000Z'), 'bbbbbbbb');
      commitSnapshot({ root, manifest: manifestFor(first), keys: keysFor() });
      commitSnapshot({ root, manifest: manifestFor(second), keys: keysFor() });
      const cheap = listSnapshots(root);
      assert.equal(cheap[0].valid, true, 'the newest snapshot is validated even in the cheap listing');
      assert.equal(cheap[1].valid, null, 'the older one is not read on the status path');
      const full = listSnapshots(root, { full: true });
      assert.ok(full.every((row) => row.valid === true));
    } finally {
      cleanup();
    }
  });
});

describe('repo: status surface', () => {
  it('buildStatus adds snapshots, latest digest and index health to the repository report', () => {
    const { root, cleanup } = repoFixture();
    try {
      const id = makeSnapshotId(new Date('2026-11-17T00:00:00.000Z'), 'deadbeef');
      const committed = commitSnapshot({ root, manifest: manifestFor(id), keys: keysFor() });
      const payload = buildStatus({ backupDir: root, dshHome: 'C:\\Users\\x\\.dsh', env: {} });
      assert.equal(payload.ok, true);
      assert.equal(payload.repository.initialized, true);
      assert.equal(payload.repository.snapshots, 1);
      assert.equal(payload.repository.latest.snapshot_id, id);
      assert.equal(payload.repository.latest.digest, committed.digest);
      assert.equal(payload.repository.index.entries, 1);
    } finally {
      cleanup();
    }
  });
});
