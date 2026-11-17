/**
 * The repository lock: exactly one writer, a stale lock that cannot wedge backups, and a release that cannot
 * steal a newer owner's lock.
 *
 * `wx` creation is the only atomic primitive involved, so the interesting cases are all about what happens after
 * a refusal: a live pid must keep the lock, a dead pid (or an unreadable file) must be reclaimed exactly once,
 * and a release that has been overtaken must do nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_STALE_MS,
  LOCK_FILE,
  acquireRepoLock,
  isPidAlive,
  isStaleLock,
  lockPath,
  withRepoLock,
} from '../src/backup/locks.mjs';
import { ensureLayout, repoPaths } from '../src/backup/layout.mjs';
import { tempDir } from './helpers/backup-fixture.mjs';

/** A repository root plus cleanup. */
function repoFixture() {
  const { dir, cleanup } = tempDir('w2m-locks-');
  const root = join(dir, 'repo');
  ensureLayout(root);
  return { root, cleanup };
}

describe('locks: acquisition', () => {
  it('creates the lock under tmp/ with this process named in it', () => {
    const { root, cleanup } = repoFixture();
    try {
      const lock = withRepoLock({ root, now: () => Date.parse('2026-11-17T14:00:00.000Z') });
      assert.equal(lock.ok, true);
      assert.equal(lockPath(root), join(repoPaths(root).tmp, LOCK_FILE));
      const record = JSON.parse(readFileSync(lock.path, 'utf8'));
      assert.equal(record.pid, process.pid);
      assert.equal(record.started_at, '2026-11-17T14:00:00.000Z');
      assert.equal(record.format, 'w2m-session-backup/lock/1');
      assert.equal(lock.release(), true);
      assert.equal(existsSync(lock.path), false);
    } finally {
      cleanup();
    }
  });

  it('refuses a second writer while a live lock is held', () => {
    const { root, cleanup } = repoFixture();
    try {
      const first = withRepoLock({ root });
      assert.equal(first.ok, true);
      const second = acquireRepoLock({ root });
      assert.equal(second.acquired, false);
      assert.equal(second.holder.pid, process.pid);
      const refused = withRepoLock({ root });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason_code, 'BACKUP_LOCKED');
      assert.match(refused.detail, new RegExp(`pid ${process.pid}`));
      assert.equal(first.release(), true);
    } finally {
      cleanup();
    }
  });

  it('reclaims a lock whose pid is not running', () => {
    const { root, cleanup } = repoFixture();
    try {
      const file = lockPath(root);
      writeFileSync(file, JSON.stringify({ format: 'w2m-session-backup/lock/1', pid: 999_999, host: 'this-host', started_at: new Date().toISOString() }));
      const result = acquireRepoLock({ root, hostname: 'this-host', isAlive: () => false });
      assert.equal(result.acquired, true);
      assert.ok(result.reclaimed !== null);
      assert.equal(result.reclaimed.verdict.reason, 'pid 999999 is not running');
    } finally {
      cleanup();
    }
  });

  it('reclaims an unreadable lock file instead of staying locked forever', () => {
    const { root, cleanup } = repoFixture();
    try {
      writeFileSync(lockPath(root), '{ this is not json');
      const result = acquireRepoLock({ root });
      assert.equal(result.acquired, true);
      assert.equal(result.reclaimed.verdict.reason, 'unreadable lock file');
    } finally {
      cleanup();
    }
  });

  it('treats another machine\'s recent lock as held, and an old one as stale', () => {
    const nowMs = Date.parse('2026-11-17T14:00:00.000Z');
    const recent = { pid: 1, host: 'other-host', started_at: new Date(nowMs - 60_000).toISOString() };
    const old = { pid: 1, host: 'other-host', started_at: new Date(nowMs - DEFAULT_STALE_MS - 60_000).toISOString() };
    assert.equal(isStaleLock(recent, { nowMs, staleMs: DEFAULT_STALE_MS, hostname: 'this-host' }).stale, false);
    assert.equal(isStaleLock(old, { nowMs, staleMs: DEFAULT_STALE_MS, hostname: 'this-host' }).stale, true);
  });
});

describe('locks: release', () => {
  it('does not delete a lock that another writer has since taken', () => {
    const { root, cleanup } = repoFixture();
    try {
      const lock = withRepoLock({ root });
      assert.equal(lock.ok, true);
      // Simulate a stale reclaim followed by a new owner: his pid is in the file now.
      writeFileSync(lock.path, JSON.stringify({ format: 'w2m-session-backup/lock/1', pid: 999_998, host: 'other', started_at: new Date().toISOString() }));
      assert.equal(lock.release(), false);
      assert.equal(existsSync(lock.path), true);
    } finally {
      cleanup();
    }
  });

  it('is idempotent', () => {
    const { root, cleanup } = repoFixture();
    try {
      const lock = withRepoLock({ root });
      assert.equal(lock.release(), true);
      assert.equal(lock.release(), true);
    } finally {
      cleanup();
    }
  });

  it('detects live and dead pids', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(999_999), false);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive('4'), false);
  });
});
