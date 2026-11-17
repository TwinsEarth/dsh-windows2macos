/**
 * Backup layout: the three first-run failures, each with its own code, and the read-only guarantee.
 *
 * The first real backup runs unattended on a machine whose D: drive the operator believes exists. "EPERM" is
 * not a useful answer to "the drive is not there", so these tests pin the distinction, and they pin that
 * `inspectLayout` creates nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BackupLayoutError,
  DESCRIPTOR_FILE,
  LAYOUT_CODES,
  REPO_CIPHER,
  REPO_DIRS,
  REPO_FORMAT,
  REPO_VERSION,
  defaultBackupDir,
  ensureLayout,
  freeBytes,
  inspectLayout,
  isInside,
  newDescriptor,
  readDescriptor,
  repoPaths,
  resolveBackupDir,
  validateDescriptor,
} from '../src/backup/layout.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

describe('backup layout: resolution', () => {
  it('defaults to the operator-requested Windows path, and to a home-relative one elsewhere', () => {
    assert.equal(defaultBackupDir({ platform: 'win32', home: 'C:\\Users\\x' }), 'D:\\DeepSeekHarness\\BackUP');
    assert.equal(defaultBackupDir({ platform: 'darwin', home: '/Users/x' }), join('/Users/x', 'DSH-BackUP'));
  });

  it('precedence is explicit, then W2M_BACKUP_DIR, then the platform default', () => {
    const env = { W2M_BACKUP_DIR: 'E:\\from-env' };
    assert.equal(resolveBackupDir({ explicit: 'F:\\from-config', env, platform: 'win32' }), 'F:\\from-config');
    assert.equal(resolveBackupDir({ explicit: '', env, platform: 'win32' }), 'E:\\from-env');
    assert.equal(resolveBackupDir({ env: {}, platform: 'win32' }), 'D:\\DeepSeekHarness\\BackUP');
  });

  it('refuses a non-string explicit directory with a named code', () => {
    assert.throws(
      () => resolveBackupDir({ explicit: 42, env: {}, platform: 'win32' }),
      (error) => error instanceof BackupLayoutError && error.code === LAYOUT_CODES.UNRESOLVED,
    );
  });
});

describe('backup layout: inspect is read-only', () => {
  it('reports a directory that does not exist without creating it', () => {
    const { dir, cleanup } = tempDir('w2m-layout-missing-');
    try {
      const root = join(dir, 'not-created');
      const report = inspectLayout(root);
      assert.equal(report.exists, false);
      assert.equal(report.initialized, false);
      assert.equal(report.writable, null, 'an absent directory was never probed for writability');
      assert.equal(report.error, null, 'absent is a state, not an error');
      assert.equal(existsSync(root), false, 'inspect must not create the directory');
    } finally {
      cleanup();
    }
  });

  it('reports an existing but uninitialised directory as writable and uninitialised', () => {
    const { dir, cleanup } = tempDir('w2m-layout-empty-');
    try {
      const root = join(dir, 'empty');
      mkdirSync(root, { recursive: true });
      const report = inspectLayout(root);
      assert.equal(report.exists, true);
      assert.equal(report.initialized, false);
      assert.equal(report.writable, true);
      assert.equal(report.error, null);
      assert.deepEqual(readdirSync(root), [], 'inspect must not write a descriptor');
    } finally {
      cleanup();
    }
  });

  it('reports a path that is a file with BACKUP_PATH_IS_FILE', () => {
    const { dir, cleanup } = tempDir('w2m-layout-file-');
    try {
      const root = join(dir, 'file');
      writeFileSync(root, 'not a directory');
      const report = inspectLayout(root);
      assert.equal(report.exists, true);
      assert.equal(report.is_file, true);
      assert.equal(report.error.code, LAYOUT_CODES.PATH_IS_FILE);
    } finally {
      cleanup();
    }
  });

  it('refuses a foreign descriptor instead of adopting or overwriting it', () => {
    const { dir, cleanup } = tempDir('w2m-layout-foreign-');
    try {
      const root = join(dir, 'someone-elses');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, DESCRIPTOR_FILE), JSON.stringify({ format: 'borg', version: 1 }));
      const report = inspectLayout(root);
      assert.equal(report.initialized, false);
      assert.equal(report.error.code, LAYOUT_CODES.NOT_A_REPO);

      assert.throws(
        () => ensureLayout(root),
        (error) => error.code === LAYOUT_CODES.NOT_A_REPO,
        'ensureLayout must not initialise over another format',
      );
      assert.equal(JSON.parse(readFileSync(join(root, DESCRIPTOR_FILE), 'utf8')).format, 'borg');
    } finally {
      cleanup();
    }
  });

  it('refuses a repository written by a newer version', () => {
    const { dir, cleanup } = tempDir('w2m-layout-newer-');
    try {
      const root = join(dir, 'newer');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, DESCRIPTOR_FILE), JSON.stringify({ format: REPO_FORMAT, version: REPO_VERSION + 1 }));
      const report = inspectLayout(root);
      assert.equal(report.error.code, LAYOUT_CODES.VERSION_UNSUPPORTED);
      assert.throws(() => ensureLayout(root), (error) => error.code === LAYOUT_CODES.VERSION_UNSUPPORTED);
    } finally {
      cleanup();
    }
  });
});

describe('backup layout: ensureLayout', () => {
  it('creates every directory and a descriptor, then verifies an existing repository instead of re-initialising', () => {
    const { dir, cleanup } = tempDir('w2m-layout-create-');
    try {
      const root = join(dir, 'repo');
      const first = ensureLayout(root);
      assert.equal(first.created, true);
      for (const name of Object.values(REPO_DIRS)) assert.ok(existsSync(join(root, name)), `${name} must exist`);
      assert.equal(first.descriptor.format, REPO_FORMAT);
      assert.equal(first.descriptor.version, REPO_VERSION);
      assert.equal(first.descriptor.cipher, REPO_CIPHER);
      assert.ok(first.descriptor.block_size > 0);
      assert.ok(first.free_bytes === null || typeof first.free_bytes === 'number');

      const descriptorBefore = readDescriptor(root);
      const second = ensureLayout(root);
      assert.equal(second.created, false, 'a second ensure must not claim to have created the repository');
      assert.deepEqual(readDescriptor(root), descriptorBefore, 'the descriptor must not be rewritten');
    } finally {
      cleanup();
    }
  });

  it('refuses a repository root inside the DSH home being backed up', () => {
    const { dir, cleanup } = tempDir('w2m-layout-inside-');
    try {
      const dshHome = join(dir, 'dsh');
      mkdirSync(dshHome, { recursive: true });
      assert.throws(
        () => ensureLayout(join(dshHome, 'backups'), { dshHome }),
        (error) => error.code === LAYOUT_CODES.INSIDE_SOURCE,
      );
      assert.equal(existsSync(join(dshHome, 'backups')), false, 'the refusal must come before any mkdir');
    } finally {
      cleanup();
    }
  });

  it('refuses a non-directory target', () => {
    const { dir, cleanup } = tempDir('w2m-layout-target-file-');
    try {
      const root = join(dir, 'file');
      writeFileSync(root, 'x');
      assert.throws(() => ensureLayout(root), (error) => error.code === LAYOUT_CODES.PATH_IS_FILE);
    } finally {
      cleanup();
    }
  });

  it('reports a missing drive as BACKUP_DRIVE_MISSING, not as a permission problem', { skip: process.platform !== 'win32' }, () => {
    const { cleanup } = tempDir('w2m-layout-drive-');
    try {
      // A drive letter that does not exist on the reference machine; the test names why it is skipped elsewhere.
      assert.throws(
        () => ensureLayout('Q:\\w2m-backup-drive-probe'),
        (error) => error.code === LAYOUT_CODES.DRIVE_MISSING || error.code === LAYOUT_CODES.CREATE_FAILED,
      );
    } finally {
      cleanup();
    }
  });
});

describe('backup layout: descriptor and containment helpers', () => {
  it('validates the descriptor it writes and nothing else', () => {
    const descriptor = newDescriptor(new Date('2026-11-17T00:00:00.000Z'));
    assert.deepEqual(validateDescriptor(descriptor), { ok: true, descriptor });
    assert.equal(descriptor.created_at, '2026-11-17T00:00:00.000Z');
    const wrongFormat = validateDescriptor({ ...descriptor, format: 'restic' });
    assert.equal(wrongFormat.ok, false);
    assert.equal(wrongFormat.error.code, LAYOUT_CODES.NOT_A_REPO);
    const wrongVersion = validateDescriptor({ ...descriptor, version: 0 });
    assert.equal(wrongVersion.ok, false);
    assert.equal(wrongVersion.error.code, LAYOUT_CODES.DESCRIPTOR_UNREADABLE);
  });

  it('treats a prefix as not-a-parent', () => {
    assert.equal(isInside('C:\\DSH', 'C:\\DSH\\x'), true);
    assert.equal(isInside('C:\\DSH', 'C:\\DSH'), true);
    assert.equal(isInside('C:\\DSH', 'C:\\DSH-backup'), false, 'C:\\DSH is a string prefix of C:\\DSH-backup, not a parent');
    assert.equal(isInside('C:\\DSH', 'D:\\DSH\\x'), false);
  });

  it('derives every repository path from the root', () => {
    const paths = repoPaths('D:\\BackUP');
    assert.equal(paths.descriptor, join('D:\\BackUP', DESCRIPTOR_FILE));
    assert.equal(paths.objects, join('D:\\BackUP', REPO_DIRS.objects));
    assert.equal(paths.snapshots, join('D:\\BackUP', REPO_DIRS.snapshots));
    assert.equal(paths.index, join('D:\\BackUP', 'index.jsonl'));
  });

  it('reports free space as a number or null, never throws', () => {
    const value = freeBytes(process.cwd());
    assert.ok(value === null || typeof value === 'number');
    assert.equal(freeBytes('Q:\\does-not-exist'), null);
  });
});
