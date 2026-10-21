/**
 * Project locks tests (M5, v1.3.10-beta.15 slice).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectLocks, DEFAULT_LOCK_LIMITS } from '../src/relay/project-locks.mjs';

const holderA = { kind: 'machine', id: 'm-a' };
const holderB = { kind: 'machine', id: 'm-b' };
const owner = { kind: 'operator', id: 'lead' };
const P = 'prj-1';

function setup(options = {}) {
  let t = Date.parse('2026-10-22T00:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; return t; } };
  const events = [];
  const locks = createProjectLocks({ now: clock.now, onEvent: (event) => events.push(event), ...options });
  return { locks, clock, events };
}

describe('project locks', () => {
  it('acquires a branch lock, lists it, and releases it', () => {
    const { locks, events } = setup();
    const acquired = locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'main' }, holder: holderA, reason: 'auth work' });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.lock.kind, 'branch');
    assert.equal(locks.list({ projectId: P }).length, 1);
    assert.equal(events.at(-1).type, 'lock.acquired');
    assert.equal(locks.release({ projectId: P, lockId: acquired.lock.lock_id, holder: holderA }).ok, true);
    assert.equal(locks.list({ projectId: P }).length, 0);
    assert.equal(events.at(-1).type, 'lock.released');
  });

  it('refuses a second holder while the lock is live, naming the holder', () => {
    const { locks } = setup();
    locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'main' }, holder: holderA });
    const denied = locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'main' }, holder: holderB });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'LOCK_HELD');
    assert.deepEqual(denied.holder, holderA);
    assert.match(denied.expires_at, /Z$/);
  });

  it('lets a newcomer take an expired lock and records both events', () => {
    const { locks, clock, events } = setup({ defaultLeaseMs: 60_000 });
    const first = locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'main' }, holder: holderA });
    clock.advance(61_000);
    const second = locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'main' }, holder: holderB });
    assert.equal(second.ok, true);
    assert.equal(events.filter((event) => event.type === 'lock.expired').length, 1);
    assert.equal(locks.expiresAt({ lockId: first.lock.lock_id }) !== null, true);
    assert.equal(locks.list({ projectId: P }).length, 1);
  });

  it('renews only for the holder and refuses to revive an expired lock', () => {
    const { locks, clock } = setup({ defaultLeaseMs: 60_000 });
    const acquired = locks.acquire({ projectId: P, kind: 'file', target: { path: 'src/a.mjs' }, holder: holderA });
    const denied = locks.renew({ projectId: P, lockId: acquired.lock.lock_id, holder: holderB });
    assert.equal(denied.code, 'LOCK_NOT_OWNER');
    clock.advance(30_000);
    const renewed = locks.renew({ projectId: P, lockId: acquired.lock.lock_id, holder: holderA });
    assert.equal(renewed.ok, true);
    clock.advance(61_000);
    const expired = locks.renew({ projectId: P, lockId: acquired.lock.lock_id, holder: holderA });
    assert.equal(expired.code, 'LOCK_EXPIRED');
  });

  it('force release needs the owner role and a reason, and notifies the previous holder', () => {
    const { locks, events } = setup();
    const acquired = locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'dev' }, holder: holderA });
    assert.equal(locks.forceRelease({ projectId: P, lockId: acquired.lock.lock_id, actor: owner, actorRole: 'maintainer', reason: 'x' }).code, 'LOCK_FORCE_DENIED');
    assert.equal(locks.forceRelease({ projectId: P, lockId: acquired.lock.lock_id, actor: owner, actorRole: 'owner', reason: '' }).code, 'LOCK_FORCE_DENIED');
    const forced = locks.forceRelease({ projectId: P, lockId: acquired.lock.lock_id, actor: owner, actorRole: 'owner', reason: 'stale claim' });
    assert.equal(forced.ok, true);
    assert.deepEqual(forced.previous_holder, holderA);
    const event = events.at(-1);
    assert.equal(event.type, 'lock.force_released');
    assert.equal(event.payload.reason, 'stale claim');
    assert.deepEqual(event.payload.holder, holderA);
  });

  it('enforces the per-project and per-holder limits', () => {
    const { locks } = setup({ limits: { perProject: 2, perHolder: 1 } });
    assert.equal(locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'a' }, holder: holderA }).ok, true);
    assert.equal(locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'b' }, holder: holderA }).code, 'LOCK_LIMIT');
    assert.equal(locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'b' }, holder: holderB }).ok, true);
    assert.equal(locks.acquire({ projectId: P, kind: 'file', target: { path: 'x' }, holder: { kind: 'machine', id: 'm-c' } }).code, 'LOCK_LIMIT');
    assert.equal(DEFAULT_LOCK_LIMITS.perProject, 20);
  });

  it('reports merge preflight conflicts for a branch and for overlapping paths', () => {
    const { locks } = setup();
    locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'main' }, holder: holderA });
    locks.acquire({ projectId: P, kind: 'file', target: { path: 'src/a.mjs' }, holder: holderB });
    const conflicts = locks.conflicts({ projectId: P, branch: 'main', paths: ['src/a.mjs', 'src/b.mjs'] });
    assert.equal(conflicts.length, 2);
    assert.deepEqual(conflicts.map((c) => c.kind).sort(), ['branch', 'file']);
    assert.equal(locks.conflicts({ projectId: P, branch: 'other', paths: ['src/c.mjs'] }).length, 0);
  });

  it('validates kind, target and lease instead of storing a malformed lock', () => {
    const { locks } = setup();
    assert.throws(() => locks.acquire({ projectId: P, kind: 'directory', target: { path: 'src' }, holder: holderA }), (error) => error.code === 'INVALID_LOCK_KIND');
    assert.throws(() => locks.acquire({ projectId: P, kind: 'branch', target: {}, holder: holderA }), (error) => error.code === 'INVALID_TARGET');
    assert.throws(() => locks.acquire({ projectId: P, kind: 'branch', target: { branch: 'main' }, holder: holderA, leaseMs: 0 }), (error) => error.code === 'INVALID_LEASE');
    assert.equal(locks.size().held, 0);
  });
});
