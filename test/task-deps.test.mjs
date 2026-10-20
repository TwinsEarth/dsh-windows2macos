/**
 * Task dependencies: the graph the relay refuses to store when it cannot be satisfied.
 *
 * Each refusal here is a state a worker could never get out of -- an unknown prerequisite can never complete, a cycle has no
 * topological order -- so these are values, not warnings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DEPENDENCIES, TASK_DEPS_REFUSAL, readinessOf, validateTaskDependencies, wouldCycle,
} from '../src/relay/task-deps.mjs';

const tasks = (entries) => new Map(entries.map(([id, extra]) => [id, { task_id: id, status: 'completed', ...extra }]));

describe('validateTaskDependencies', () => {
  it('accepts an absent or empty list', () => {
    assert.deepEqual(validateTaskDependencies({}).ok, true);
    assert.deepEqual(validateTaskDependencies({ depends_on: [] }), { ok: true, depends_on: [] });
  });

  it('refuses a non-array', () => {
    assert.equal(validateTaskDependencies({ depends_on: 'a' }).code, TASK_DEPS_REFUSAL.DEPENDS_ON_NOT_ARRAY);
  });

  it('refuses an unknown prerequisite, by name', () => {
    const refused = validateTaskDependencies({ task_id: 't2', depends_on: ['nope'], tasksById: tasks([['t1']]) });
    assert.equal(refused.code, TASK_DEPS_REFUSAL.DEPENDENCY_UNKNOWN);
    assert.equal(refused.detail.dependency, 'nope');
  });

  it('refuses a self-dependency', () => {
    const refused = validateTaskDependencies({ task_id: 't1', depends_on: ['t1'], tasksById: tasks([['t1']]) });
    assert.equal(refused.code, TASK_DEPS_REFUSAL.DEPENDENCY_SELF);
  });

  it('refuses a duplicate edge', () => {
    const refused = validateTaskDependencies({ task_id: 't2', depends_on: ['t1', 't1'], tasksById: tasks([['t1']]) });
    assert.equal(refused.code, TASK_DEPS_REFUSAL.DEPENDENCY_DUPLICATE);
  });

  it('refuses a cycle through an existing task', () => {
    const byId = tasks([['a', { depends_on: ['b'] }], ['b', { depends_on: [] }]]);
    const refused = validateTaskDependencies({ task_id: 'b', depends_on: ['a'], tasksById: byId });
    assert.equal(refused.code, TASK_DEPS_REFUSAL.DEPENDENCY_CYCLE);
    assert.deepEqual(refused.detail.path, ['b', 'a']);
  });

  it('refuses more prerequisites than the cap', () => {
    const many = Array.from({ length: MAX_DEPENDENCIES + 1 }, (_, i) => 't' + i);
    const byId = new Map(many.map((id) => [id, { task_id: id, status: 'completed' }]));
    assert.equal(validateTaskDependencies({ task_id: 'x', depends_on: many, tasksById: byId }).code, TASK_DEPS_REFUSAL.MAX_DEPENDENCIES);
  });

  it('accepts a sound chain and returns the normalised list', () => {
    const byId = tasks([['a'], ['b', { depends_on: ['a'] }]]);
    assert.deepEqual(validateTaskDependencies({ task_id: 'c', depends_on: ['b'], tasksById: byId }), { ok: true, depends_on: ['b'] });
  });
});

describe('wouldCycle', () => {
  it('finds a path that comes back to the target', () => {
    const byId = tasks([['a', { depends_on: ['b'] }], ['b', { depends_on: ['c'] }], ['c', { depends_on: [] }]]);
    assert.deepEqual(wouldCycle('a', 'c', byId), ['c', 'a']);
    assert.equal(wouldCycle('a', 'x', byId), null);
  });
});

describe('readinessOf', () => {
  it('is ready when every prerequisite completed', () => {
    assert.equal(readinessOf({ depends_on: ['a', 'b'], tasksById: tasks([['a'], ['b']]) }), 'ready');
  });

  it('waits while a prerequisite is running', () => {
    const byId = tasks([['a', { status: 'running' }]]);
    assert.equal(readinessOf({ depends_on: ['a'], tasksById: byId }), 'waiting');
  });

  it('is blocked when a prerequisite failed, was cancelled or refused', () => {
    for (const status of ['failed', 'cancelled', 'refused']) {
      const byId = new Map([['a', { task_id: 'a', status }]]);
      assert.equal(readinessOf({ depends_on: ['a'], tasksById: byId }), 'blocked', status);
    }
  });

  it('treats a missing prerequisite as waiting, not ready', () => {
    assert.equal(readinessOf({ depends_on: ['ghost'], tasksById: new Map() }), 'waiting');
  });
});