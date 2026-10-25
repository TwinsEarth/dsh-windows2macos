/**
 * v1.7.4 regression guard: never call `agent.identity?.()` again.
 *
 * Field crash 2026-10-25 (DSH desktop host):
 *   dsh: fatal load failure: TypeError: agent.identity is not a function
 * Optional CALL only guards null/undefined; when `identity` exists as a property the call throws, and
 * inside the agent.start().then(...) callback that rejection took the whole desktop host down.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const tools = readFileSync(join(here, '..', 'src', 'plugin', 'tools.mjs'), 'utf8');

describe('agent identity access is type-safe (v1.7.4)', () => {
  it('does not use the optional-call form that crashed the desktop host', () => {
    const codeLines = tools.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    assert.doesNotMatch(codeLines.join('\n'), /agent\.identity\?\.\(\)/, 'agent.identity may be a property, not a function');
  });

  it('reads identity through the type-checked helper', () => {
    assert.match(tools, /function agentIdentityOf\(agent\)/);
    assert.match(tools, /typeof agent\.identity === 'function' \? agent\.identity\(\) : \(agent\.identity \?\? null\)/);
  });
});