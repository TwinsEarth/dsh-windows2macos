/**
 * Task attribution tests (M4, v1.3.10-beta.13 slice).
 *
 * A task now names a project. These tests drive the relay state directly so the contract is pinned without an HTTP client:
 * an unnamed task lands in the implicit default project, a named one must exist, and the project room records the link.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import RabbitState from '../src/relay/state.mjs';

// The relay only offers work to an online machine; these tests are about attribution, so they register one directly.
const withOnlineMachine = (state, machineId = 'm-1') => {
  state.devices.set(machineId, { machine_id: machineId, machine_name: machineId, online: true, streams: 1 });
  return state;
};

const baseTask = (extra = {}) => ({
  mode: 'replicate',
  command_argv: ['node', '--version'],
  cwd_rel: '.',
  index_total: 1,
  timeout_ms: 30_000,
  write: false,
  ...extra,
});

describe('task project attribution', () => {
  it('puts an unnamed task in the implicit default project and records a task.linked event', () => {
    const state = withOnlineMachine(new RabbitState());
    const created = state.createTask(baseTask());
    const task = state.getTask(created.task_id);
    assert.equal(task.project_id, 'default');
    const snapshot = state.projectSnapshot('default');
    assert.equal(snapshot.project.project_id, 'default');
    const events = state.projectEvents('default', { sinceSeq: 0 }).events;
    const linked = events.find((event) => event.type === 'task.linked');
    assert.ok(linked, 'a task.linked event is recorded');
    assert.equal(linked.payload.task_id, created.task_id);
    assert.equal(linked.seq, snapshot.last_event_seq, 'the snapshot is consistent with the latest event');
  });

  it('accepts an explicit project that exists and exposes it on the task summary', () => {
    const state = withOnlineMachine(new RabbitState());
    state.projects.createProject({ projectId: 'demo', name: 'demo', createdBy: { kind: 'operator', id: 'op' } });
    const created = state.createTask(baseTask({ project_id: 'demo' }));
    const summary = state.taskSummary(state.getTask(created.task_id));
    assert.equal(summary.project_id, 'demo');
  });

  it('refuses an unknown explicit project instead of creating one', () => {
    const state = withOnlineMachine(new RabbitState());
    assert.throws(() => state.createTask(baseTask({ project_id: 'missing' })), (error) => error.code === 'BAD_REQUEST');
    assert.equal(state.projects.size().projects, 0, 'no project was created by the refusal');
  });
});