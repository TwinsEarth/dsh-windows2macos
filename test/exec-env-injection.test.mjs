/**
 * P1: a split task's index must reach the command, not just the envelope.
 *
 * runArgv returns hashes, not raw output (the relay carries one exit code and no output), so these assertions read the
 * child's EXIT CODE: the command turns an environment variable into its own status. That is also exactly the operator's
 * acceptance shape -- `process.exit(Number(process.env.W2M_INDEX)+1)` -- without needing four machines.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runArgv } from '../src/agent/exec.mjs';

const exitWith = (expr, env) => runArgv([process.execPath, '-e', 'process.exit(' + expr + ')'], env === undefined ? {} : { env });

describe('the executed command receives the W2M environment', () => {
  it('an injected variable reaches the child (W2M_INDEX=3 -> exit 4)', async () => {
    const ran = await exitWith('Number(process.env.W2M_INDEX) + 1', { W2M_INDEX: '3' });
    assert.equal(ran.exit_code, 4);
  });

  it('keeps the inherited environment: PATH must survive, or no interpreter is found', async () => {
    const ran = await exitWith('(process.env.PATH ?? "").length > 0 ? 0 : 9', { W2M_INDEX: '0' });
    assert.equal(ran.exit_code, 0);
  });

  it('without env the host environment is used unchanged', async () => {
    const ran = await exitWith('process.env.W2M_INDEX === undefined ? 0 : 9');
    assert.equal(ran.exit_code, 0);
  });

  it('a stage index is not the machine index: both travel separately', async () => {
    const ran = await exitWith('process.env.W2M_INDEX === "2" && process.env.W2M_STAGE_INDEX === "0" ? 0 : 9',
      { W2M_INDEX: '2', W2M_STAGE_INDEX: '0' });
    assert.equal(ran.exit_code, 0);
  });
});
