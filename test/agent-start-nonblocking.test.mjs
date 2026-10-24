/**
 * v1.6.9 regression guard — `startLocalStack` must not await `agent.start()`.
 *
 * Field diagnosis 2026-10-24 (macOS, plugin 1.6.8): timestamped stage logs showed
 *
 *   A startLocalStack enter -> C createAgent done -> S before agent.start   (and then nothing)
 *
 * while the machine was online in the fleet. `agent.start()`'s promise never settled, so everything
 * after it — including the failover monitor installed by `startFailoverStack` — never ran. That made
 * automatic relay failover silently impossible on every platform whose agent start behaves the same
 * way, which is exactly the kind of defect a unit test on the *shape* of the code can prevent from
 * coming back: "starting the agent" is a background action, not a mount prerequisite.
 *
 * This test reads the emitted source. It is a guard, not a style rule: it fails only when the
 * function that returns the stack cleanup handle goes back to awaiting the agent's start promise.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const tools = readFileSync(join(here, '..', 'src', 'plugin', 'tools.mjs'), 'utf8');

/** The text of one function: from its `function name(` line to the next `\nasync function` or `\nfunction`. */
function functionBody(name) {
  const start = tools.indexOf('async function ' + name + '(');
  assert.notEqual(start, -1, name + ' must exist in tools.mjs');
  const after = tools.indexOf('\n  async function ', start + 10);
  const fallback = tools.indexOf('\nfunction ', start + 10);
  const candidates = [after, fallback].filter((i) => i > start);
  const end = candidates.length === 0 ? tools.length : Math.min(...candidates);
  return tools.slice(start, end);
}

describe('agent start is not a mount prerequisite (v1.6.9)', () => {
  it('startLocalStack does not await agent.start()', () => {
    const body = functionBody('startLocalStack');
    assert.doesNotMatch(body, /await\s+agent\.start\(\)/, 'startLocalStack must start the agent in the background; awaiting it blocks the failover monitor');
    assert.match(body, /agent\.start\(\)\.then\(/, 'the background start must handle both outcomes');
  });

  it('startFailoverStack installs the monitor after the stack returns', () => {
    const body = functionBody('startFailoverStack');
    assert.match(body, /const timer = setInterval\(/, 'the probe interval is the whole point');
    assert.match(body, /relayPool\(cfg\)/, 'the pool comes from cfg.relayUrls');
  });
});
