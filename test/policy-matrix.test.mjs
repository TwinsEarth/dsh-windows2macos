/**
 * The permission matrix: every action for every role, and the refusal carrying enough facts to act on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_MIN_LEVEL, FLEET_ACTIONS, ROLE_LEVEL, can, matrixFor, roleForLevel } from '../src/util/policy-matrix.mjs';

describe('can()', () => {
  it('lets every role read, and observers nothing else', () => {
    assert.equal(can({ role: 'observer', action: 'read_private' }).ok, true);
    for (const action of ['vote', 'join', 'dispatch', 'approve', 'manage_members']) {
      assert.equal(can({ role: 'observer', action }).code, 'FORBIDDEN_ACTION', action);
    }
  });

  it('lets workers act but not govern', () => {
    for (const action of ['read_private', 'vote', 'join', 'dispatch']) {
      assert.equal(can({ role: 'worker', action }).ok, true, action);
    }
    for (const action of ['approve', 'manage_members']) {
      assert.equal(can({ role: 'worker', action }).ok, false, action);
    }
  });

  it('lets the owner do everything in the table', () => {
    for (const action of FLEET_ACTIONS) assert.equal(can({ role: 'owner', action }).ok, true, action);
  });

  it('treats an unknown or missing role as worker, never as owner', () => {
    assert.equal(can({ role: null, action: 'dispatch' }).ok, true);
    assert.equal(can({ role: 'admin', action: 'approve' }).ok, false);
    assert.equal(can({ role: 'admin', action: 'approve' }).current_role, 'worker');
  });

  it('names the action, the level required and the level held in a refusal', () => {
    const refused = can({ role: 'worker', action: 'approve' });
    assert.equal(refused.code, 'FORBIDDEN_ACTION');
    assert.equal(refused.action, 'approve');
    assert.equal(refused.required_level, 2);
    assert.equal(refused.current_level, 1);
    assert.equal(refused.required_role, 'owner');
    assert.equal(refused.current_role, 'worker');
  });

  it('refuses an action it does not know instead of guessing', () => {
    assert.equal(can({ role: 'owner', action: 'fly' }).code, 'FORBIDDEN_ACTION');
  });
});

describe('the table itself', () => {
  it('orders roles and gives every action a level', () => {
    assert.deepEqual(ROLE_LEVEL, { observer: 0, worker: 1, owner: 2 });
    for (const action of FLEET_ACTIONS) assert.ok(Number.isInteger(ACTION_MIN_LEVEL[action]), action);
  });

  it('maps levels back to roles for the refusal message', () => {
    assert.equal(roleForLevel(0), 'observer');
    assert.equal(roleForLevel(1), 'worker');
    assert.equal(roleForLevel(2), 'owner');
    assert.equal(roleForLevel(9), null);
  });

  it('renders one row per action for a role', () => {
    const rows = matrixFor('observer');
    assert.equal(rows.length, FLEET_ACTIONS.length);
    assert.equal(rows.filter((row) => row.ok).length, 1);
  });
});