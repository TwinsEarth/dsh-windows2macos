/**
 * The offsite mirror: a second copy of the sealed blocks and the metadata that makes it openable.
 *
 * Two properties carry the feature: the copy must be **complete and byte-identical** (a mirror that cannot
 * restore is not a backup), and a repeated sync must be **free** (copying the whole repository every night is a
 * second backup, not a mirror). The refusals matter as much as the copy: a mirror path inside the repository or
 * the home it copies -- lexically *or* through a symlink/junction -- is a way to back up a backup, and it is
 * refused before the primary run writes anything. The mirror also must not trust a file name: an object that is
 * present at the right content address but truncated is repaired on the next sync, while an intact mirror is
 * left untouched (`copied.repaired: 0`, no rewrites).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { MirrorError, resolveMirrorRoot, syncToMirror } from '../src/backup/mirror.mjs';
import { runBackup } from '../src/backup/engine.mjs';
import { openRepo, readIndex, readSnapshot } from '../src/backup/repo.mjs';
import { repoPaths } from '../src/backup/layout.mjs';
import { openRepoKey } from '../src/backup/keystore.mjs';
import { rebuildFile } from '../src/backup/materialize.mjs';
import { sha256Hex } from '../src/backup/manifest.mjs';
import { makeHome, registryDocument, tempDir } from './helpers/backup-fixture.mjs';

const PASSWORD = 'correct horse battery staple';
const PLATFORM = 'linux'; // no OS keystore: the password envelope is the credential, without DPAPI
const SESSION = 'session-aaaaaaaa-0001';

/** A home with one registered session. */
function homeFixture() {
  return makeHome({
    sessions: [{ workspace: '--E-GPT--', id: SESSION }],
    registry: registryDocument({ sessionIds: [SESSION] }),
  });
}

/** A backup run with the fixture credential (the same shape `test/backup-engine.test.mjs` uses). */
function run(input) {
  return runBackup({ password: PASSWORD, platform: PLATFORM, machineKey: false, ...input });
}

/** Absolute path of one sealed block in a repository or mirror. */
function objectFile(root, sha256) {
  return join(repoPaths(root).objects, sha256.slice(0, 2), sha256);
}

/** The object file names present under a repository/mirror, sorted (for counting without caring about order). */
function objectNames(root) {
  const objectsRoot = repoPaths(root).objects;
  const names = [];
  let prefixes = [];
  try {
    prefixes = fs.readdirSync(objectsRoot, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue;
    for (const name of fs.readdirSync(join(objectsRoot, prefix.name))) names.push(name);
  }
  return names.sort();
}

/** Every block digest a snapshot's manifest names, deduplicated. */
function manifestBlocks(snapshot) {
  const out = new Set();
  for (const file of snapshot.manifest.files) for (const block of file.blocks ?? []) out.add(block.sha256);
  return [...out];
}

/**
 * Create a directory junction (on Windows) or a directory symlink (elsewhere), or report why this environment
 * forbids it. A test that needs one skips by name with the returned reason instead of passing vacuously.
 */
function tryJunction(target, link) {
  try {
    fs.symlinkSync(target, link, 'junction');
    return null;
  } catch (error) {
    return error?.code ?? (error instanceof Error ? error.message : String(error));
  }
}

/** Every file under `root` with its byte size and mtime, so "no write happened" is measured, not assumed. */
function fileStamps(root) {
  const stamps = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        stamps[full.slice(root.length)] = `${stat.size}:${stat.mtimeMs}`;
      }
    }
  };
  walk(root);
  return stamps;
}

describe('mirror: resolving the location', () => {
  it('accepts a separate directory, including a sibling whose name shares the repository prefix', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-resolve-');
    try {
      const repoRoot = join(dir, 'BackUP');
      const dshHome = join(dir, 'home');
      const valid = resolveMirrorRoot({ repoRoot, dshHome, mirrorRoot: join(dir, 'offsite') });
      assert.equal(valid.ok, true, valid.detail);
      assert.equal(valid.root, join(dir, 'offsite'));
      // `BackUP2` is NOT inside `BackUP`: containment is decided with path.relative, never a string prefix.
      for (const name of ['BackUP2', 'BackUP-old', 'backup-subdir']) {
        assert.equal(resolveMirrorRoot({ repoRoot, dshHome, mirrorRoot: join(dir, name) }).ok, true, name);
      }
    } finally {
      cleanup();
    }
  });

  it('refuses a missing, empty or non-string location, naming the reason', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-resolve-bad-');
    try {
      for (const value of [undefined, '', '   ', 42, null, true]) {
        const verdict = resolveMirrorRoot({ repoRoot: join(dir, 'repo'), mirrorRoot: value });
        assert.equal(verdict.ok, false, String(value));
        assert.equal(verdict.reason_code, 'BACKUP_MIRROR_INVALID');
        assert.match(verdict.detail, /mirrorRoot must be a non-empty path string/u);
      }
    } finally {
      cleanup();
    }
  });

  it('refuses the repository itself, a path inside it, and a path inside the DSH home', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-resolve-inside-');
    try {
      const repoRoot = join(dir, 'repo');
      const dshHome = join(dir, 'home');
      const equalRepo = resolveMirrorRoot({ repoRoot, dshHome, mirrorRoot: repoRoot });
      assert.equal(equalRepo.ok, false);
      assert.match(equalRepo.detail, /is the repository root itself/u);

      const insideRepo = resolveMirrorRoot({ repoRoot, dshHome, mirrorRoot: join(repoRoot, 'mirror') });
      assert.equal(insideRepo.ok, false);
      assert.match(insideRepo.detail, /inside the repository root/u);

      const equalHome = resolveMirrorRoot({ repoRoot, dshHome, mirrorRoot: dshHome });
      assert.equal(equalHome.ok, false);
      assert.match(equalHome.detail, /inside \(or is\) the DSH home/u);

      const insideHome = resolveMirrorRoot({ repoRoot, dshHome, mirrorRoot: join(dshHome, 'mirror') });
      assert.equal(insideHome.ok, false);
      assert.match(insideHome.detail, /inside \(or is\) the DSH home/u);
    } finally {
      cleanup();
    }
  });

  it('refuses an existing file where the mirror directory should be', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-resolve-file-');
    try {
      const file = join(dir, 'a-file');
      fs.writeFileSync(file, 'not a directory');
      const verdict = resolveMirrorRoot({ repoRoot: join(dir, 'repo'), dshHome: join(dir, 'home'), mirrorRoot: file });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason_code, 'BACKUP_MIRROR_INVALID');
      assert.match(verdict.detail, /exists and is a file, not a directory/u);
    } finally {
      cleanup();
    }
  });

  it(
    'treats a path on another drive as outside, without throwing',
    { skip: process.platform === 'win32' ? false : 'drive letters are Windows-only' },
    () => {
      const verdict = resolveMirrorRoot({ repoRoot: 'C:\\w2m-mirror-probe', dshHome: null, mirrorRoot: 'Q:\\w2m-offsite' });
      assert.equal(verdict.ok, true, verdict.detail);
      assert.equal(verdict.root, 'Q:\\w2m-offsite');
    },
  );

  it('refuses a junction whose real target is inside the repository or the DSH home', (t) => {
    const { dir, cleanup } = tempDir('w2m-mirror-resolve-junction-');
    try {
      const repoRoot = join(dir, 'repo');
      const dshHome = join(dir, 'home');
      fs.mkdirSync(join(repoRoot, 'objects'), { recursive: true });
      fs.mkdirSync(join(dshHome, 'sessions'), { recursive: true });

      const repoLink = join(dir, 'repo-link');
      const repoFailure = tryJunction(repoRoot, repoLink);
      if (repoFailure !== null) {
        t.skip(`this environment forbids creating a directory junction/symlink (${repoFailure})`);
        return;
      }
      // The lexical path (`<tmp>/repo-link`) is outside the repository; its real target is the repository root.
      const escaped = resolveMirrorRoot({ repoRoot, dshHome, mirrorRoot: repoLink });
      assert.equal(escaped.ok, false, 'a junction into the repository must be refused');
      assert.equal(escaped.reason_code, 'BACKUP_MIRROR_SYMLINK');
      assert.match(escaped.detail, /real path/iu);
      assert.match(escaped.detail, /repository root/u);

      // The refusal reaches both write paths: the engine before any commit, and syncToMirror with its own code.
      const engineResult = run({ root: repoRoot, dshHome, mirrorRoot: repoLink });
      assert.equal(engineResult.ok, false);
      assert.equal(engineResult.reason_code, 'BACKUP_MIRROR_SYMLINK');
      assert.equal(readIndex(repoRoot).entries.length, 0, 'the repository must have no snapshot after the refusal');
      assert.throws(
        () => syncToMirror({ root: repoRoot, mirrorRoot: repoLink, dshHome, snapshotId: SESSION }),
        (error) => error instanceof MirrorError && error.code === 'BACKUP_MIRROR_SYMLINK',
      );

      const homeLink = join(dir, 'home-link');
      const homeFailure = tryJunction(join(dshHome, 'sessions'), homeLink);
      if (homeFailure === null) {
        const homeEscaped = resolveMirrorRoot({ repoRoot, dshHome, mirrorRoot: homeLink });
        assert.equal(homeEscaped.ok, false, 'a junction into the DSH home must be refused');
        assert.equal(homeEscaped.reason_code, 'BACKUP_MIRROR_SYMLINK');
        assert.match(homeEscaped.detail, /DSH home/u);
      }
    } finally {
      cleanup();
    }
  });

  it('still accepts a mirror path that does not exist yet, however many levels are missing', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-resolve-nested-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'not', 'created', 'yet', 'offsite');
      const verdict = resolveMirrorRoot({ repoRoot: root, dshHome: fixture.home, mirrorRoot });
      assert.equal(verdict.ok, true, verdict.detail);
      assert.equal(verdict.root, mirrorRoot);
      // "Works" is a first sync that creates every missing level, not just a resolver that says yes.
      const backedUp = run({ root, dshHome: fixture.home });
      assert.equal(backedUp.ok, true, backedUp.detail);
      const synced = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.equal(synced.ok, true);
      assert.equal(fs.existsSync(join(mirrorRoot, 'backup.json')), true, 'the first sync must create the missing levels');
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });
});

describe('mirror: copying a snapshot', () => {
  it('copies every block and the snapshot metadata, then copies nothing on a second sync', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-copy-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const backedUp = run({ root, dshHome: fixture.home });
      assert.equal(backedUp.ok, true, backedUp.detail);
      const snapshot = readSnapshot({ root, snapshotId: backedUp.snapshot_id });

      const first = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.equal(first.ok, true);
      assert.equal(first.root, mirrorRoot);
      assert.equal(first.index_appended, true);
      assert.equal(first.descriptor_copied, true);
      assert.ok(first.copied.files > 0);
      assert.ok(first.copied.bytes > 0);
      assert.equal(first.copied.repaired, 0, 'a fresh mirror has nothing to repair');

      for (const sha256 of manifestBlocks(snapshot)) {
        assert.equal(fs.existsSync(objectFile(mirrorRoot, sha256)), true, `the mirror is missing block ${sha256}`);
      }
      for (const name of ['manifest.json', 'keys.json']) {
        assert.equal(fs.existsSync(join(mirrorRoot, 'snapshots', backedUp.snapshot_id, name)), true, `missing snapshot ${name}`);
        assert.deepEqual(
          fs.readFileSync(join(mirrorRoot, 'snapshots', backedUp.snapshot_id, name)),
          fs.readFileSync(join(repoPaths(root).snapshots, backedUp.snapshot_id, name)),
          `the mirrored ${name} must be byte-identical to the primary`,
        );
      }
      assert.equal(fs.existsSync(join(mirrorRoot, 'backup.json')), true, 'backup.json is what makes openRepo(mirror) report initialized');
      assert.equal(fs.existsSync(join(mirrorRoot, 'keys.json')), true, 'the root keys.json holds the wrapped DEK envelopes');
      const [sampleBlock] = manifestBlocks(snapshot);
      assert.deepEqual(fs.readFileSync(objectFile(mirrorRoot, sampleBlock)), fs.readFileSync(objectFile(root, sampleBlock)));
      assert.equal(readIndex(mirrorRoot).entries.filter((entry) => entry.snapshot_id === backedUp.snapshot_id).length, 1);

      const stampsBeforeResync = fileStamps(mirrorRoot);
      const second = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.equal(second.ok, true);
      assert.deepEqual(second.copied, { files: 0, bytes: 0, repaired: 0 }, 'a re-sync of the same snapshot copies nothing');
      assert.deepEqual(fileStamps(mirrorRoot), stampsBeforeResync, 'an intact mirror is not rewritten at all (size and mtime unchanged)');
      assert.equal(second.index_appended, false);
      assert.equal(second.descriptor_copied, false);
      assert.ok(second.skipped.files > 0);
      assert.equal(
        readIndex(mirrorRoot).entries.filter((entry) => entry.snapshot_id === backedUp.snapshot_id).length,
        1,
        'the index line must not be duplicated',
      );
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('repairs a missing object without rewriting the objects already present', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-repair-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const backedUp = run({ root, dshHome: fixture.home });
      assert.equal(backedUp.ok, true, backedUp.detail);
      const snapshot = readSnapshot({ root, snapshotId: backedUp.snapshot_id });
      syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });

      const [missing] = manifestBlocks(snapshot);
      fs.rmSync(objectFile(mirrorRoot, missing));
      const repaired = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.equal(repaired.ok, true);
      assert.equal(repaired.copied.files, 1, 'only the missing object is copied again');
      assert.equal(repaired.copied.repaired, 0, 'a missing object is a copy, not a repair');
      assert.equal(fs.existsSync(objectFile(mirrorRoot, missing)), true);
      assert.equal(repaired.index_appended, false);
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('repairs a truncated mirror object on the next sync, then reports the intact mirror as untouched', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-corrupt-object-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const backedUp = run({ root, dshHome: fixture.home });
      assert.equal(backedUp.ok, true, backedUp.detail);
      const snapshot = readSnapshot({ root, snapshotId: backedUp.snapshot_id });
      syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });

      const [sha256] = manifestBlocks(snapshot);
      const sourceBytes = fs.readFileSync(objectFile(root, sha256));
      const mirrorObject = objectFile(mirrorRoot, sha256);
      fs.writeFileSync(mirrorObject, sourceBytes.subarray(0, sourceBytes.length - 1));
      assert.notEqual(fs.statSync(mirrorObject).size, sourceBytes.length, 'the fixture must actually be truncated');

      const repaired = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.equal(repaired.ok, true);
      assert.ok(repaired.copied.repaired >= 1, 'a truncated object must be reported as repaired');
      assert.deepEqual(fs.readFileSync(mirrorObject), sourceBytes, 'the repaired object is byte-identical to the source');
      assert.equal(repaired.index_appended, false);

      const stampsAfterRepair = fileStamps(mirrorRoot);
      const again = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.deepEqual(again.copied, { files: 0, bytes: 0, repaired: 0 }, 'the repaired mirror is idempotent again');
      assert.deepEqual(fileStamps(mirrorRoot), stampsAfterRepair, 'the second sync writes nothing');
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('rewrites mirror metadata that no longer matches the primary', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-corrupt-metadata-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const backedUp = run({ root, dshHome: fixture.home });
      assert.equal(backedUp.ok, true, backedUp.detail);
      syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });

      const snapshotManifest = join(mirrorRoot, 'snapshots', backedUp.snapshot_id, 'manifest.json');
      const primaryManifest = join(repoPaths(root).snapshots, backedUp.snapshot_id, 'manifest.json');
      fs.writeFileSync(join(mirrorRoot, 'backup.json'), '{"format":');
      fs.writeFileSync(snapshotManifest, '{"format":');

      const repaired = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.equal(repaired.ok, true);
      assert.equal(repaired.copied.repaired, 2, 'the damaged descriptor and snapshot manifest are both rewritten');
      assert.deepEqual(fs.readFileSync(join(mirrorRoot, 'backup.json')), fs.readFileSync(repoPaths(root).descriptor));
      assert.deepEqual(fs.readFileSync(snapshotManifest), fs.readFileSync(primaryManifest));
      assert.equal(repaired.descriptor_copied, true, 'a repaired descriptor is still reported as copied');
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('does not duplicate a snapshot id when its own index line was left torn', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-torn-self-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const backedUp = run({ root, dshHome: fixture.home });
      assert.equal(backedUp.ok, true, backedUp.detail);
      syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });

      // A crash mid-append of this snapshot's line: the index now holds a partial line without its newline, so
      // `readIndex` honestly reports no entry for the snapshot (the mirror may never have recorded the commit).
      const indexFile = join(mirrorRoot, 'index.jsonl');
      const complete = fs.readFileSync(indexFile, 'utf8');
      fs.writeFileSync(indexFile, complete.slice(0, complete.length - 8));
      const torn = readIndex(mirrorRoot);
      assert.equal(torn.entries.length, 0, 'a torn line is not an entry');
      assert.equal(torn.torn_tail, true);

      const synced = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.equal(synced.ok, true);
      assert.equal(synced.index_appended, true, 'completing the snapshot line is the only way to record it');
      const index = readIndex(mirrorRoot);
      assert.deepEqual(index.entries.map((entry) => entry.snapshot_id), [backedUp.snapshot_id], 'the snapshot id must appear exactly once');
      assert.ok(index.problems.length >= 1, 'the torn fragment stays reported as a problem');
      const lines = fs.readFileSync(indexFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
      const lastLine = lines[lines.length - 1];
      assert.equal(JSON.parse(lastLine).snapshot_id, backedUp.snapshot_id, 'the appended line is complete JSON');

      const again = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: backedUp.snapshot_id });
      assert.equal(again.index_appended, false, 'a further sync sees the completed line and appends nothing');
      assert.equal(readIndex(mirrorRoot).entries.filter((entry) => entry.snapshot_id === backedUp.snapshot_id).length, 1);
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('appends a new snapshot after a torn index tail without duplicating the earlier line', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-torn-tail-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const firstRun = run({ root, dshHome: fixture.home });
      assert.equal(firstRun.ok, true, firstRun.detail);
      syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: firstRun.snapshot_id });

      const secondRun = run({ root, dshHome: fixture.home });
      assert.equal(secondRun.ok, true, secondRun.detail);
      assert.notEqual(secondRun.snapshot_id, firstRun.snapshot_id);
      // A crash mid-append leaves a final line without its newline; the next append must not glue the two lines.
      fs.appendFileSync(join(mirrorRoot, 'index.jsonl'), '{"torn"');
      const synced = syncToMirror({ root, mirrorRoot, dshHome: fixture.home, snapshotId: secondRun.snapshot_id });
      assert.equal(synced.ok, true);
      assert.equal(synced.index_appended, true);
      const index = readIndex(mirrorRoot);
      assert.deepEqual(index.entries.map((entry) => entry.snapshot_id), [firstRun.snapshot_id, secondRun.snapshot_id]);
      assert.ok(index.problems.length >= 1, 'the torn line is reported honestly rather than silently repaired');
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('refuses an unusable location with the named code, before reading the snapshot', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-direct-refuse-');
    try {
      const root = join(dir, 'repo');
      assert.throws(
        () => syncToMirror({ root, mirrorRoot: join(root, 'inner'), dshHome: join(dir, 'home'), snapshotId: 'x' }),
        (error) => error instanceof MirrorError && error.code === 'BACKUP_MIRROR_INVALID',
      );
      assert.equal(fs.existsSync(join(root, 'inner')), false);
    } finally {
      cleanup();
    }
  });
});

describe('mirror: the run integration', () => {
  it('copies through runBackup, reports the copy, and appends one line per new snapshot', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-run-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const first = run({ root, dshHome: fixture.home, mirrorRoot });
      assert.equal(first.ok, true, first.detail);
      assert.equal(first.mirror?.ok, true, first.mirror?.reason);
      assert.equal(first.mirror.root, mirrorRoot);
      assert.equal(first.mirror.index_appended, true);
      assert.equal(first.mirror.descriptor_copied, true);
      assert.equal(first.warnings, undefined);
      const firstSnapshot = readSnapshot({ root, snapshotId: first.snapshot_id });
      for (const sha256 of manifestBlocks(firstSnapshot)) assert.equal(fs.existsSync(objectFile(mirrorRoot, sha256)), true);
      assert.equal(openRepo({ root: mirrorRoot, dshHome: fixture.home }).initialized, true);

      const objectsAfterFirst = objectNames(mirrorRoot);
      const second = run({ root, dshHome: fixture.home, mirrorRoot });
      assert.equal(second.ok, true, second.detail);
      assert.equal(second.mirror?.ok, true, second.mirror?.reason);
      assert.equal(second.mirror.index_appended, true);
      assert.equal(second.mirror.descriptor_copied, false, 'the descriptor is only copied when missing');
      assert.deepEqual(objectNames(mirrorRoot), objectsAfterFirst, 'the second snapshot reuses the mirrored objects');
      assert.deepEqual(readIndex(mirrorRoot).entries.map((entry) => entry.snapshot_id), [first.snapshot_id, second.snapshot_id]);
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('refuses a mirror inside the repository before writing any snapshot', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-refuse-repo-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const result = run({ root, dshHome: fixture.home, mirrorRoot: join(root, 'mirror') });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_MIRROR_INVALID');
      assert.match(result.detail, /inside the repository root/u);
      assert.equal(fs.existsSync(root), false, 'nothing may be created before the mirror refusal');
      assert.equal(readIndex(root).entries.length, 0);
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('refuses a mirror that is the repository root itself', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-refuse-equal-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const result = run({ root, dshHome: fixture.home, mirrorRoot: root });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_MIRROR_INVALID');
      assert.match(result.detail, /repository root itself/u);
      assert.equal(fs.existsSync(root), false);
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('refuses a mirror inside the DSH home being backed up', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-refuse-home-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const result = run({ root, dshHome: fixture.home, mirrorRoot: join(fixture.home, 'mirror') });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_MIRROR_INVALID');
      assert.match(result.detail, /inside \(or is\) the DSH home/u);
      assert.equal(fs.existsSync(root), false);
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('refuses a mirror path that is an existing file', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-refuse-file-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorFile = join(dir, 'mirror-file');
      fs.writeFileSync(mirrorFile, 'not a directory');
      const result = run({ root, dshHome: fixture.home, mirrorRoot: mirrorFile });
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'BACKUP_MIRROR_INVALID');
      assert.match(result.detail, /file, not a directory/u);
      assert.equal(fs.existsSync(root), false);
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it('reports a runtime mirror failure as a warning on a committed backup, never as a failed backup', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-fail-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const first = run({ root, dshHome: fixture.home, mirrorRoot });
      assert.equal(first.ok, true, first.detail);
      assert.equal(first.mirror?.ok, true);

      // The mirror root still resolves as a directory, but the object store inside it cannot be created.
      fs.rmSync(join(mirrorRoot, 'objects'), { recursive: true, force: true });
      fs.writeFileSync(join(mirrorRoot, 'objects'), 'not a directory');

      const second = run({ root, dshHome: fixture.home, mirrorRoot });
      assert.equal(second.ok, true, 'the primary backup must not fail because its offsite copy failed');
      assert.notEqual(second.snapshot_id, first.snapshot_id);
      assert.equal(second.mirror?.ok, false);
      assert.equal(second.mirror.reason_code, 'BACKUP_MIRROR_FAILED');
      assert.equal(typeof second.mirror.reason, 'string');
      assert.deepEqual(second.mirror.copied, { files: 0, bytes: 0, repaired: 0 });
      assert.equal(second.warnings.length, 1);
      assert.match(second.warnings[0], /BACKUP_MIRROR_FAILED/u);

      // The primary snapshot is committed and readable: the copy's failure is not the backup's.
      const committed = readSnapshot({ root, snapshotId: second.snapshot_id });
      assert.ok(committed.manifest.counts.files > 0);
      assert.equal(readIndex(root).entries.length, 2);
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });
});

describe('mirror: the copy is restorable', () => {
  it('opens as a repository and rebuilds a session file from the mirrored sealed blocks', () => {
    const { dir, cleanup } = tempDir('w2m-mirror-restore-');
    const fixture = homeFixture();
    try {
      const root = join(dir, 'repo');
      const mirrorRoot = join(dir, 'mirror');
      const backedUp = run({ root, dshHome: fixture.home, mirrorRoot });
      assert.equal(backedUp.ok, true, backedUp.detail);
      const snapshot = readSnapshot({ root, snapshotId: backedUp.snapshot_id });
      const entry = snapshot.manifest.files.find((row) => row.kind === 'session');
      assert.ok(entry, 'the snapshot must hold the session file');

      const state = openRepo({ root: mirrorRoot, dshHome: fixture.home });
      assert.equal(state.initialized, true, 'the mirror must open as a repository, not just hold files');
      assert.equal(state.index.entries, 1);

      // The DEK is unwrapped from the mirror's own root keys.json copy, not from the primary repository.
      const opened = openRepoKey({ root: mirrorRoot, dshHome: fixture.home, password: PASSWORD, platform: PLATFORM, machineKey: false });
      assert.equal(opened.ok, true, opened.detail);
      const rebuilt = rebuildFile({ root: mirrorRoot, entry, dek: opened.dek });
      assert.equal(rebuilt.ok, true, rebuilt.detail);
      assert.equal(sha256Hex(rebuilt.buffer), entry.sha256, 'the mirror must reproduce the manifest digest');

      const primaryOpened = openRepoKey({ root, dshHome: fixture.home, password: PASSWORD, platform: PLATFORM, machineKey: false });
      const primaryRebuilt = rebuildFile({ root, entry, dek: primaryOpened.dek });
      assert.equal(primaryRebuilt.ok, true, primaryRebuilt.detail);
      assert.deepEqual(rebuilt.buffer, primaryRebuilt.buffer, 'mirror bytes must equal primary bytes');
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });
});
