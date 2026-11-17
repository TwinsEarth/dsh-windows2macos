/**
 * Backup manifest protocol v1: the field list is frozen here, in the same way `test/claims.test.mjs` freezes
 * version claims. A repository outlives the build that wrote it, so a field that changes meaning later is a
 * silent restore bug; these tests make that change fail loudly at the moment it is introduced.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BLOCK_ALGO,
  BLOCK_KEYS,
  BLOCK_SIZE,
  COUNT_KEYS,
  FILE_KEYS,
  MANIFEST_CIPHER,
  MANIFEST_CODES,
  MANIFEST_FORMAT,
  MANIFEST_KEYS,
  MANIFEST_VERSION,
  REGISTRY_KEYS,
  SESSION_KEYS,
  ManifestError,
  buildManifest,
  canonicalJson,
  describeFile,
  manifestDigest,
  manifestSummary,
  normalizeRelPath,
  readManifest,
  sha256Hex,
  splitBlocks,
  validateManifest,
} from '../src/backup/manifest.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

/** Deep clone via JSON: manifests are plain data by design, and this asserts that too. */
const clone = (value) => JSON.parse(JSON.stringify(value));

/** A small two-session + one-attachment manifest over real files. */
function fixture() {
  const { dir, cleanup } = tempDir('w2m-manifest-');
  const sessionFile = join(dir, 'session.v4.jsonl.zstd');
  const attachmentFile = join(dir, 'object');
  writeFileSync(sessionFile, Buffer.from('session-bytes'.repeat(10)));
  writeFileSync(attachmentFile, Buffer.from('attachment-bytes'));
  const attachmentId = 'ab'.repeat(32);
  const manifest = buildManifest({
    snapshotId: '20261117T000000-abcdef12',
    createdAt: new Date('2026-11-17T00:00:00.000Z'),
    dshHome: 'C:\\Users\\x\\.dsh',
    sessions: [
      {
        rel: 'sessions/--E-GPT--/session-aaaaaaaa-0001/session.v4.jsonl.zstd',
        file: sessionFile,
        session_id: 'session-aaaaaaaa-0001',
        workspace: '--E-GPT--',
        format_version: 4,
        flags: { registered: true, archived: false, pinned: true },
      },
    ],
    attachments: [{ rel: `attachments/v1/objects/${attachmentId.slice(0, 2)}/${attachmentId}`, file: attachmentFile, attachment_id: attachmentId }],
    registry: { workspaces: 1, registered: 1, archived: 0, pinned: 1 },
    exclusions: [{ rel: 'sessions/.event-cache', reason: 'derived' }],
  });
  return { dir, cleanup, manifest, sessionFile, attachmentFile, attachmentId };
}

describe('backup protocol: the frozen shape', () => {
  it('pins the version, block size, algorithm and cipher', () => {
    assert.equal(MANIFEST_FORMAT, 'w2m-session-backup/manifest');
    assert.equal(MANIFEST_VERSION, 1);
    assert.equal(BLOCK_SIZE, 4 * 1024 * 1024);
    assert.equal(BLOCK_ALGO, 'sha256');
    assert.equal(MANIFEST_CIPHER, 'aes-256-gcm');
  });

  it('writes exactly the declared top-level and entry keys', () => {
    const { cleanup, manifest } = fixture();
    try {
      assert.deepEqual(Object.keys(manifest).sort(), [...MANIFEST_KEYS].sort());
      assert.deepEqual(Object.keys(manifest.counts).sort(), [...COUNT_KEYS].sort());
      assert.deepEqual(Object.keys(manifest.registry).sort(), [...REGISTRY_KEYS].sort());
      const session = manifest.files.find((file) => file.kind === 'session');
      const attachment = manifest.files.find((file) => file.kind === 'attachment');
      assert.deepEqual(Object.keys(session).sort(), [...FILE_KEYS, ...SESSION_KEYS].sort());
      assert.deepEqual(Object.keys(attachment).sort(), [...FILE_KEYS, 'attachment_id'].sort());
      assert.deepEqual(Object.keys(session.blocks[0]).sort(), [...BLOCK_KEYS].sort());
      assert.deepEqual(validateManifest(manifest), { ok: true, errors: [], manifest });
    } finally {
      cleanup();
    }
  });

  it('derives counts from the files rather than trusting a caller', () => {
    const { cleanup, manifest } = fixture();
    try {
      assert.equal(manifest.counts.files, 2);
      assert.equal(manifest.counts.sessions, 1);
      assert.equal(manifest.counts.attachments, 1);
      assert.equal(manifest.counts.bytes, manifest.files.reduce((sum, file) => sum + file.size, 0));
      assert.equal(manifest.counts.block_bytes, manifest.counts.bytes);
    } finally {
      cleanup();
    }
  });

  it('is deterministic: same inputs, same digest', () => {
    const { cleanup, manifest } = fixture();
    try {
      const first = manifestDigest(manifest);
      const second = manifestDigest(clone(manifest));
      assert.equal(first, second);
      assert.equal(first, sha256Hex(Buffer.from(canonicalJson(manifest), 'utf8')));
    } finally {
      cleanup();
    }
  });
});

describe('backup protocol: relative paths', () => {
  it('normalises separators and refuses anything that could escape the restore target', () => {
    assert.equal(normalizeRelPath('sessions\\--E-GPT--\\x\\session.v4.jsonl.zstd'), 'sessions/--E-GPT--/x/session.v4.jsonl.zstd');
    assert.equal(normalizeRelPath('a/b'), 'a/b');
    for (const bad of ['', ' ', '../etc/passwd', 'a/../b', '/abs/path', 'C:\\abs', '\\\\server\\share\\x', 'a//b', 'a/./b', 'a/b/']) {
      assert.throws(
        () => normalizeRelPath(bad),
        (error) => error instanceof ManifestError && error.code === MANIFEST_CODES.REL_PATH,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });
});

describe('backup protocol: canonical JSON and blocks', () => {
  it('orders keys so a digest never depends on insertion order', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
    assert.equal(canonicalJson({ a: 1 }), '{"a":1}');
    assert.equal(canonicalJson([1, 'x', null, true]), '[1,"x",null,true]');
    assert.throws(() => canonicalJson({ a: Number.NaN }), (error) => error.code === MANIFEST_CODES.TYPE);
    assert.throws(() => canonicalJson({ a: undefined }), (error) => error.code === MANIFEST_CODES.TYPE);
  });

  it('tiles a buffer into contiguous, hashed blocks with a short final block', () => {
    const buffer = Buffer.from('0123456789');
    assert.deepEqual(splitBlocks(buffer, 4), [
      { index: 0, offset: 0, length: 4, sha256: sha256Hex(Buffer.from('0123')) },
      { index: 1, offset: 4, length: 4, sha256: sha256Hex(Buffer.from('4567')) },
      { index: 2, offset: 8, length: 2, sha256: sha256Hex(Buffer.from('89')) },
    ]);
    assert.deepEqual(splitBlocks(Buffer.alloc(0), 4), []);
    assert.equal(splitBlocks(Buffer.alloc(8), 4).length, 2);
    assert.throws(() => splitBlocks('not a buffer'), (error) => error.code === MANIFEST_CODES.TYPE);
    assert.throws(() => splitBlocks(Buffer.alloc(1), 0), (error) => error.code === MANIFEST_CODES.VALUE);
  });

  it('describes a file with one digest and blocks that agree with it', () => {
    const { dir, cleanup } = tempDir('w2m-describe-');
    try {
      const file = join(dir, 'x');
      writeFileSync(file, Buffer.from('abc'));
      const description = describeFile(file, { blockSize: 2 });
      assert.equal(description.size, 3);
      assert.equal(description.sha256, sha256Hex(Buffer.from('abc')));
      assert.equal(description.blocks.reduce((sum, block) => sum + block.length, 0), 3);
      assert.ok(description.mtime_ms > 0);
      assert.throws(() => describeFile(join(dir, 'missing')), (error) => error.code === MANIFEST_CODES.IO);
    } finally {
      cleanup();
    }
  });
});

describe('backup protocol: validation refuses what a restore must not act on', () => {
  const cases = [
    ['an unknown top-level key', (m) => { m.extra = true; }, MANIFEST_CODES.KEY_UNKNOWN, '$.extra'],
    ['a missing top-level key', (m) => { delete m.cipher; }, MANIFEST_CODES.KEY_MISSING, '$.cipher'],
    ['a newer manifest version', (m) => { m.version = 2; }, MANIFEST_CODES.VERSION_UNSUPPORTED, '$.version'],
    ['a foreign format', (m) => { m.format = 'restic/snapshot'; }, MANIFEST_CODES.VALUE, '$.format'],
    ['a non-frozen block size', (m) => { m.block_size = 1024 * 1024; }, MANIFEST_CODES.VALUE, '$.block_size'],
    ['a block index gap', (m) => { m.files[0].blocks[0].index = 1; }, MANIFEST_CODES.BLOCK_GAP, '$.files[0].blocks[0].index'],
    ['a block offset gap', (m) => { m.files[0].blocks[0].offset = 1; }, MANIFEST_CODES.BLOCK_GAP, '$.files[0].blocks[0].offset'],
    ['blocks that do not cover the file', (m) => { m.files[0].size += 1; }, MANIFEST_CODES.SIZE_MISMATCH, '$.files[0].blocks'],
    ['a count that disagrees with the files', (m) => { m.counts.files = 3; }, MANIFEST_CODES.COUNT_MISMATCH, '$.counts.files'],
    ['a file digest that is not sha256 hex', (m) => { m.files[0].sha256 = 'xyz'; }, MANIFEST_CODES.SHA256, '$.files[0].sha256'],
    ['an absolute path', (m) => { m.files[0].rel = 'C:/x'; }, MANIFEST_CODES.REL_PATH, '$.files[0].rel'],
    ['a session log outside sessions/<workspace>/<session>/', (m) => { m.files.find((f) => f.kind === 'session').rel = 'sessions/x/y'; }, MANIFEST_CODES.REL_PATH, null],
    ['an attachment object at the wrong address', (m) => { m.files.find((f) => f.kind === 'attachment').rel = 'attachments/v1/objects/zz/' + 'ab'.repeat(32); }, MANIFEST_CODES.REL_PATH, null],
    ['a non-boolean flag', (m) => { m.files.find((f) => f.kind === 'session').flags.pinned = 'yes'; }, MANIFEST_CODES.TYPE, null],
    ['an unknown file entry key', (m) => { m.files[0].mystery = 1; }, MANIFEST_CODES.KEY_UNKNOWN, null],
    ['a duplicate path (case-insensitively)', (m) => { m.files[1] = { ...m.files[0] }; m.counts.bytes += m.files[0].size; }, MANIFEST_CODES.REL_DUPLICATE, null],
    ['a malformed exclusion', (m) => { m.exclusions = [{ rel: 'x' }]; }, MANIFEST_CODES.TYPE, null],
  ];

  for (const [name, mutate, code, path] of cases) {
    it(`refuses ${name}`, () => {
      const { cleanup, manifest } = fixture();
      try {
        assert.equal(validateManifest(manifest).ok, true, 'the fixture must be valid before it is mutated');
        const broken = clone(manifest);
        mutate(broken);
        const result = validateManifest(broken);
        assert.equal(result.ok, false);
        assert.equal(result.manifest, null);
        const hit = result.errors.find((error) => error.code === code);
        assert.ok(hit, `expected ${code}; got ${result.errors.map((error) => `${error.code}@${error.path}`).join(', ')}`);
        if (path !== null) assert.equal(hit.path, path);
      } finally {
        cleanup();
      }
    });
  }

  it('accepts an empty snapshot, because a home with no sessions is a valid home', () => {
    const empty = buildManifest({ snapshotId: 'empty-1', createdAt: new Date('2026-11-17T00:00:00.000Z'), dshHome: 'C:\\x', registry: {} });
    assert.equal(validateManifest(empty).ok, true);
    assert.deepEqual(empty.counts, { files: 0, bytes: 0, blocks: 0, block_bytes: 0, sessions: 0, attachments: 0 });
  });

  it('readManifest reports malformed JSON as a shape error instead of throwing', () => {
    const result = readManifest('{ not json');
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, MANIFEST_CODES.SHAPE);
    assert.equal(result.manifest, null);
    const good = readManifest(JSON.stringify(fixture().manifest));
    assert.equal(good.ok, true);
  });

  it('manifestSummary reports counts and a digest without the file list', () => {
    const { cleanup, manifest } = fixture();
    try {
      const summary = manifestSummary(manifest);
      assert.equal(summary.snapshot_id, manifest.snapshot_id);
      assert.equal(summary.sessions, 1);
      assert.equal(summary.attachments, 1);
      assert.equal(summary.digest, manifestDigest(manifest));
      assert.equal(typeof summary.files, 'number');
    } finally {
      cleanup();
    }
  });
});
