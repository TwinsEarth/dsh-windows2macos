/**
 * `cwd_outside_project` has to survive a chain of hand-written field copies, or it means nothing.
 *
 * ## Why this file exists
 *
 * The defect that produced this parameter was not a missing feature. `cwd_rel` **was** accepted by the tool,
 * normalized by the relay, folded into `command_hash`, stored on the task — and then the agent's containment
 * guard **computed its own refusal and discarded it**, running anyway with the unvalidated path. The parameter
 * travelled most of the way and stopped short, and **nothing said so.**
 *
 * So the risk in adding `cwd_outside_project` is not that it fails loudly. It is that it **travels the same
 * distance and stops at the same place** — and the symptom would be a machine refusing a dispatch with
 * `CWD_OUTSIDE_PROJECT` while the caller believes it asked for the escape. **A real dispatch produced exactly
 * that**, which is what this file is written against.
 *
 * The field is copied by hand in three places in the relay, and **each one is a place it can be dropped**:
 *
 *   1. `createTask`'s explicit task object
 *   2. the `task.created` ledger row — so a relay restart does not forget a granted permission
 *   3. the offer handed to a machine
 *
 * The plugin's own copy is asserted in `tools.test.mjs`, where the fetch stub sees the posted body.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RabbitState } from '../src/relay/state.mjs';

const T0 = Date.parse('2026-10-08T00:00:00Z');
const ARGV = ['node', '-e', 'console.log(1)'];
const BASE_TREE = 'a'.repeat(64);
const BASE_COMMIT = 'b'.repeat(40);

/**
 * A relay with one paired machine and a captured ledger.
 *
 * `_persist.append` is the real seam the relay writes through, so capturing there observes the same rows a
 * restart would replay rather than a reimplementation of them. The constructor names it `persistence`.
 */
function harness() {
  const rows = [];
  const state = new RabbitState({
    now: () => T0,
    persistence: { append: (entry) => { rows.push(entry); return true; } },
  });
  state.devices.set('m1', {
    machine_id: 'm1',
    machine_name: 'm1',
    platform: { os: 'darwin', os_version: '27.0', arch: 'arm64', shell: 'zsh', shell_version: null },
    capabilities: { case_sensitive_fs: false, symlinks: true, exec_bit: true, python: null, npm: null, node: 'v24.21.0' },
    index: 0,
  });
  return { state, rows };
}

const create = (state, over = {}) => state.createTask({
  mode: 'replicate',
  command_argv: ARGV,
  base_commit: BASE_COMMIT,
  base_tree: BASE_TREE,
  index_total: 1,
  timeout_ms: 60_000,
  ...over,
});

const taskRow = (rows, taskId) => rows.find((r) => r.type === 'task.created' && r.task?.task_id === taskId);

describe('cwd_outside_project: the task keeps it, so the offer can carry it', () => {
  it('stores the flag on the task when the caller set it', () => {
    const { state } = harness();
    const task = state.getTask(create(state, { cwd_rel: '../repo', cwd_outside_project: true }).task_id);
    assert.equal(task.cwd_outside_project, true, 'createTask copies fields by hand; this is one of the copies');
    assert.equal(task.cwd_rel, '../repo', 'and the relative path is untouched by the flag');
  });

  it('defaults to false rather than undefined, so the task answers the question either way', () => {
    // `undefined` reads as "not applicable" where `false` reads as "not asked for", and the two need different
    // handling the moment anything wants to explain a refusal.
    const { state } = harness();
    assert.equal(state.getTask(create(state).task_id).cwd_outside_project, false);
  });

  it('is exactly true or false, because it arrives over the wire', () => {
    // A truthy-but-not-boolean value must not open the guard. Normalising here makes the agent's own
    // `=== true` check a second line of defence rather than the only one.
    const { state } = harness();
    for (const v of ['true', 1, {}, []]) {
      const task = state.getTask(create(state, { cwd_outside_project: v }).task_id);
      assert.equal(task.cwd_outside_project, false, `value ${JSON.stringify(v)} must not open the guard`);
    }
  });
});

describe('cwd_outside_project: the ledger remembers, because the ledger is what a restart rebuilds from', () => {
  it('writes the flag into the task.created row', () => {
    // The worst available failure: the dispatch runs, the relay restarts, and a permission the operator
    // granted is silently gone — so the same dispatch is refused afterwards with nothing visibly changed.
    const { state, rows } = harness();
    const created = create(state, { cwd_rel: '../repo', cwd_outside_project: true });
    const row = taskRow(rows, created.task_id);
    assert.ok(row, 'a task.created row was written');
    assert.equal(
      row.task.cwd_outside_project,
      true,
      'the ledger row carries the flag, which is the only reason a replay can restore it',
    );
  });

  it('writes false into the row for a caller that did not ask, so absence is never ambiguous', () => {
    const { state, rows } = harness();
    const created = create(state);
    assert.equal(taskRow(rows, created.task_id).task.cwd_outside_project, false);
  });
});
