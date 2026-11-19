/**
 * Client bundle size budget (P2 workstream C, slice C1).
 *
 * `lib/client.js` is the **shipped** browser bundle — the file header says it is not compiled output and the
 * package has no build step, so its size is source size. It is also the largest single file in the repository
 * (~594 KB / ~10k lines) and two functions (`UpdateSettingsSection`, `renderChatText`) account for most of it.
 *
 * The point of this suite is to make growth a test failure rather than a review judgement: a change that adds
 * a large block must either fit the budget or lower it deliberately (and update this file in the same reviewed
 * change). The budget is a ceiling, not a target; the P2 plan's C2/C3 slices are expected to lower it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'lib', 'client.js');

/** Ceilings. Lower them when a slice lands; never raise without a reviewed reason. */
const BUDGET = Object.freeze({
  bytes: 610_000, // current 594,539; +~15 KB headroom
  lines: 10_050, // current 9,965
  largestFunctionLines: 3_600, // current 3,454 (UpdateSettingsSection)
});

/**
 * Top-level function spans, by line. Only column-0 `function` declarations are counted: the giant views in this
 * file are top-level, and nested callbacks are not the unit that makes review hard.
 *
 * @param {string} text
 * @returns {Array<{name: string, lines: number}>}
 */
function topLevelFunctionSpans(text) {
  const lines = text.split('\n');
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?:export )?(?:async )?function\s+([A-Za-z0-9_$]+)/.exec(lines[index]);
    if (match) starts.push({ name: match[1], line: index });
  }
  return starts.map((row, position) => ({
    name: row.name,
    lines: (position + 1 < starts.length ? starts[position + 1].line : lines.length) - row.line,
  }));
}

describe('client bundle budget (P2-C1)', () => {
  it('keeps lib/client.js within its byte and line ceilings', () => {
    const stat = fs.statSync(CLIENT);
    const text = fs.readFileSync(CLIENT, 'utf8');
    const lines = text.split('\n').length;
    assert.ok(stat.size <= BUDGET.bytes, `lib/client.js is ${stat.size} bytes, over the ${BUDGET.bytes}-byte budget`);
    assert.ok(lines <= BUDGET.lines, `lib/client.js is ${lines} lines, over the ${BUDGET.lines}-line budget`);
  });

  it('keeps every top-level function under the per-function ceiling', () => {
    const spans = topLevelFunctionSpans(fs.readFileSync(CLIENT, 'utf8'));
    // A file with no top-level functions would trivially satisfy the ceiling and is not this bundle's shape.
    assert.ok(spans.length >= 5, `expected the shipped bundle to define top-level views, found ${spans.length}`);
    const oversized = spans.filter((span) => span.lines > BUDGET.largestFunctionLines);
    assert.deepEqual(
      oversized,
      [],
      `top-level functions over ${BUDGET.largestFunctionLines} lines: ${oversized.map((span) => `${span.name}(${span.lines})`).join(', ')}`,
    );
  });

  it('is the file package.json actually ships as the client entry', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.exports?.['./client'], './lib/client.js');
    assert.equal(pkg.dsh?.client?.platform, 'web');
  });
});
