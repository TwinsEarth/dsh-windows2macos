/**
 * The task board's graph arithmetic: classification and order, over plain data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_GRAPH_REFUSAL, buildBoard, buildGraph, classifyTask, topoOrder } from '../src/plugin/task-graph.mjs';

describe('scheduler states (v1.2.7)', () => {
  it('reads the relay waiting and active states literally', () => {
    assert.equal(classifyTask({ task_id: 'b', status: 'waiting' }), 'waiting');
    assert.equal(classifyTask({ task_id: 'c', status: 'active' }), 'active');
    assert.equal(classifyTask({ task_id: 'd', status: 'done' }), 'done');
  });
});

describe('buildGraph', () => {
  it('keeps each task and its dependencies', () => {
    const built = buildGraph({ nodes: [{ task_id: 'a', depends_on: ['b'] }, { task_id: 'b' }] });
    assert.equal(built.ok, true);
    assert.deepEqual(built.nodes.get('a'), ['b']);
  });

  it('refuses a node without an id', () => {
    assert.equal(buildGraph({ nodes: [{ depends_on: [] }] }).code, TASK_GRAPH_REFUSAL.BAD_NODE);
  });
});

describe('topoOrder', () => {
  it('orders prerequisites first, with ties broken by id', () => {
    const built = buildGraph({ nodes: [{ task_id: 'c', depends_on: ['b'] }, { task_id: 'a' }, { task_id: 'b' }] });
    assert.deepEqual(topoOrder(built.nodes).order, ['a', 'b', 'c']);
  });

  it('reports the cycle instead of an order', () => {
    const built = buildGraph({ nodes: [{ task_id: 'a', depends_on: ['b'] }, { task_id: 'b', depends_on: ['a'] }] });
    const ordered = topoOrder(built.nodes);
    assert.equal(ordered.code, TASK_GRAPH_REFUSAL.CYCLE);
    assert.deepEqual(ordered.detail.cycle.sort(), ['a', 'b']);
  });
});

describe('classifyTask', () => {
  const statuses = new Map([['ok', 'completed'], ['bad', 'failed'], ['run', 'running']]);
  it('is done when the task itself finished', () => {
    assert.equal(classifyTask({ task_id: 'ok', status: 'completed', statuses }), 'done');
  });
  it('is blocked when a prerequisite failed', () => {
    assert.equal(classifyTask({ task_id: 'x', depends_on: ['bad'], statuses }), 'blocked');
  });
  it('is waiting while a prerequisite runs', () => {
    assert.equal(classifyTask({ task_id: 'x', depends_on: ['run'], statuses }), 'waiting');
  });
  it('is active when the task itself is in flight', () => {
    assert.equal(classifyTask({ task_id: 'run', status: 'running', statuses }), 'active');
  });

  it('is ready when nothing stands in the way', () => {
    assert.equal(classifyTask({ task_id: 'x', depends_on: ['ok'], statuses }), 'ready');
    assert.equal(classifyTask({ task_id: 'x', statuses }), 'ready');
  });
  it('treats a prerequisite missing from the visible list as waiting', () => {
    assert.equal(classifyTask({ task_id: 'x', depends_on: ['ghost'], statuses }), 'waiting');
  });
});

describe('buildBoard', () => {
  it('buckets every visible task and gives the order', () => {
    const board = buildBoard({ tasks: [
      { task_id: 'root', status: 'completed' },
      { task_id: 'mid', depends_on: ['root'], status: 'running' },
      { task_id: 'tail', depends_on: ['mid'], status: 'queued' },
      { task_id: 'dead', depends_on: ['root'], status: 'pending' },
      { task_id: 'bad', depends_on: ['ghost'], status: 'queued' },
    ] });
    assert.equal(board.ok, true);
    assert.deepEqual(board.ready, ['dead']);
    assert.deepEqual(board.active, ['mid'], 'a task already in flight is not offered as ready');
    assert.deepEqual(board.waiting, ['bad', 'tail']);
    assert.deepEqual(board.done, ['root']);
    assert.ok(board.order.indexOf('root') < board.order.indexOf('mid'));
  });
});
