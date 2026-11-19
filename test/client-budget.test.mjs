/**
 * Client bundle size budget (P2 workstream C, slice C1; meter corrected by S6/S7).
 *
 * `lib/client.js` is the **shipped** browser bundle — the file header says it is not compiled output and the
 * package has no build step, so its size is source size. It is also the largest single file in the repository
 * (~594 KB / ~10k lines): growth here is a review problem, not a build problem.
 *
 * # What C1 measured, and why the meter now counts function bodies
 *
 * C1 measured "a declaration at column 0, up to the next declaration at column 0". It reported
 * `UpdateSettingsSection` as 3,454 lines and `renderChatText` as 1,131, and the S6/S7 survey found both numbers
 * were formatting accidents rather than function sizes:
 *
 *   - `UpdateSettingsSection` is 63 lines. The 3,391 lines after it are other top-level components
 *     (`FleetConfigSection`, `TargetSelect`, fleet chat, remote view, the backup page, `mount`, …) written at
 *     the file's normal 4-space indentation, which the column-0 pattern cannot see as declarations. The span
 *     really measured "distance to the next unindented `function`", not this function.
 *   - `renderChatText` was a 10-line sticker renderer nested inside `FleetChat`; its 1,131-line span was the
 *     rest of that panel and the whole factory tail.
 *
 * A guard that calls a 63-line function "3,454 lines" cannot say what to refactor, and cannot fail when a
 * function genuinely grows by 100 lines as long as nobody unindents the declaration after it. So the meter
 * below measures the thing the ceiling names: each declaration's **body**, with comments, strings, template
 * literals and regex literals masked out and braces matched. Indentation is irrelevant to it, which is the
 * point: this file is a hand-written bundle whose layout has drifted, not a formatted source tree.
 *
 * # The budget is a ceiling to lower, never a target
 *
 * `BUDGET` is a promise that review can still read this file. Lower it whenever a slice makes a real reduction
 * (S6/S7 lowered the per-function ceiling from 3,600 to 1,200 on the corrected measurement); never raise it
 * without a reviewed reason, and update this file in the same change.
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
  bytes: 610_000, // current 593,540; +~16 KB headroom
  lines: 10_050, // current 9,999
  largestFunctionLines: 1_200, // current largest is 832 (BackupPanelView); rule: max(largest + 100, 1_200)
});

/**
 * Blank out everything that is not code, preserving byte offsets and line breaks.
 *
 * A brace counter that reads raw source is wrong the first time a string contains `{`. Masking first keeps
 * the matcher below small enough to read: comments, quoted strings, template literals (including their
 * `${…}` interpolations, which are code but never contain these declarations) and regex literals all become
 * spaces, while newlines survive so line numbers stay exact. Regex-versus-division is decided the way a
 * reader does: a `/` starts a regex where an operand is expected.
 *
 * @param {string} text
 * @returns {string} the same length as `text`, with non-code masked to spaces.
 */
function maskNonCode(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (out[index] !== '\n') out[index] = ' ';
  };
  const regexPreceders = new Set(['', '(', '=', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '/']);
  const regexKeywords = new Set(['return', 'typeof', 'instanceof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'delete', 'void', 'throw']);
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      const stop = newline === -1 ? text.length : newline;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '"' || character === "'") {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (text[cursor] === character) { cursor += 1; break; }
        if (text[cursor] === '\n') break;
        cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    if (character === '`') {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (text[cursor] === '`') { cursor += 1; break; }
        cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    if (character === '/') {
      let before = index - 1;
      while (before >= 0 && /[ \t]/.test(text[before])) before -= 1;
      let previousCharacter = before < 0 ? '' : text[before];
      let previousWord = '';
      if (/[A-Za-z0-9_$]/.test(previousCharacter)) {
        let wordStart = before;
        while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(text[wordStart])) wordStart -= 1;
        previousWord = text.slice(wordStart + 1, before + 1);
        previousCharacter = '';
      }
      const startsRegex = before < 0
        ? true
        : previousCharacter === '' ? regexKeywords.has(previousWord) : regexPreceders.has(previousCharacter);
      if (startsRegex) {
        let scan = index + 1;
        let inClass = false;
        let closed = false;
        while (scan < text.length) {
          const inner = text[scan];
          if (inner === '\\') { scan += 2; continue; }
          if (inner === '[') inClass = true;
          else if (inner === ']') inClass = false;
          else if (inner === '/' && !inClass) { scan += 1; closed = true; break; }
          else if (inner === '\n') break;
          scan += 1;
        }
        if (closed) {
          while (scan < text.length && /[a-z]/i.test(text[scan])) scan += 1;
          blank(index, scan);
          index = scan;
          continue;
        }
      }
    }
    index += 1;
  }
  return out.join('');
}

/**
 * The body span of every outermost `function` declaration, by line.
 *
 * "Outermost" is why this replaces C1's column-0 scan: a declaration nested in another function is part of
 * that function's body, so only the outer one is reported here and the outer size already includes it. The
 * span runs from the `function` keyword's line to the line holding its closing brace, so a long block between
 * two functions (a comment, an unrelated `const` table) is never billed to either of them.
 *
 * @param {string} source
 * @returns {Array<{name: string, startLine: number, endLine: number, lines: number}>}
 */
function functionBodySpans(source) {
  const masked = maskNonCode(source);
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === '\n') lineStarts.push(index + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const spans = [];
  const declaration = /\bfunction[ \t]+([A-Za-z0-9_$]+)[ \t]*\(/g;
  let match = declaration.exec(masked);
  while (match !== null) {
    let cursor = declaration.lastIndex - 1;
    let parens = 0;
    let afterParameters = -1;
    for (; cursor < masked.length; cursor += 1) {
      if (masked[cursor] === '(') parens += 1;
      else if (masked[cursor] === ')') {
        parens -= 1;
        if (parens === 0) { afterParameters = cursor + 1; break; }
      }
    }
    let bodyStart = afterParameters;
    while (bodyStart >= 0 && bodyStart < masked.length && /\s/.test(masked[bodyStart])) bodyStart += 1;
    if (afterParameters < 0 || masked[bodyStart] !== '{') {
      match = declaration.exec(masked);
      continue;
    }
    let braces = 0;
    let bodyEnd = -1;
    for (let scan = bodyStart; scan < masked.length; scan += 1) {
      if (masked[scan] === '{') braces += 1;
      else if (masked[scan] === '}') {
        braces -= 1;
        if (braces === 0) { bodyEnd = scan; break; }
      }
    }
    if (bodyEnd === -1) {
      match = declaration.exec(masked);
      continue;
    }
    const startLine = lineOf(match.index);
    const endLine = lineOf(bodyEnd);
    spans.push({ name: match[1], startLine, endLine, lines: endLine - startLine + 1 });
    // Skip the body: a nested declaration is part of this function's size, not a sibling of it.
    declaration.lastIndex = bodyEnd + 1;
    match = declaration.exec(masked);
  }
  return spans;
}

describe('client bundle budget (P2-C1)', () => {
  it('keeps lib/client.js within its byte and line ceilings', () => {
    const stat = fs.statSync(CLIENT);
    const text = fs.readFileSync(CLIENT, 'utf8');
    const lines = text.split('\n').length;
    assert.ok(stat.size <= BUDGET.bytes, `lib/client.js is ${stat.size} bytes, over the ${BUDGET.bytes}-byte budget`);
    assert.ok(lines <= BUDGET.lines, `lib/client.js is ${lines} lines, over the ${BUDGET.lines}-line budget`);
  });

  it('keeps every function body under the per-function ceiling', () => {
    const spans = functionBodySpans(fs.readFileSync(CLIENT, 'utf8'));
    // A file with no functions would trivially satisfy the ceiling and is not this bundle's shape.
    assert.ok(spans.length >= 140, `expected the shipped bundle to define its views and helpers, found ${spans.length}`);
    // A meter that stopped matching would find only tiny bodies and pass this suite vacuously; the largest
    // real component is the backup panel page, so a bundle of 50-line functions means the matcher broke.
    const largest = spans.reduce((left, right) => (right.lines > left.lines ? right : left));
    assert.ok(largest.lines >= 400, `the largest measured body is ${largest.lines} lines (${largest.name}); the meter is no longer finding real functions`);
    const oversized = spans.filter((span) => span.lines > BUDGET.largestFunctionLines);
    assert.deepEqual(
      oversized,
      [],
      `functions over ${BUDGET.largestFunctionLines} lines: ${oversized.map((span) => `${span.name}(${span.lines})`).join(', ')}`,
    );
  });

  it('measures a function body, not the stretch of file until the next unindented declaration', () => {
    // The two names C1 reported as the giants. Pinning their real sizes is the regression guard for the
    // meter itself: the old scan reported 3,454 and 1,131 for these same two functions.
    const spans = functionBodySpans(fs.readFileSync(CLIENT, 'utf8'));
    const byName = new Map(spans.map((span) => [span.name, span]));
    const settings = byName.get('UpdateSettingsSection');
    assert.ok(settings !== undefined, 'UpdateSettingsSection is still a top-level function of the bundle');
    assert.ok(
      settings.lines <= 120,
      `UpdateSettingsSection measured ${settings.lines} lines; its body renders one update block, and the components after it are indented`,
    );
    const sticker = byName.get('renderChatText');
    assert.ok(sticker !== undefined, 'renderChatText is module scope (S6 moved it out of FleetChat)');
    assert.ok(
      sticker.lines <= 60,
      `renderChatText measured ${sticker.lines} lines; it replaces three sticker commands and does not render markdown`,
    );
  });

  it('is the file package.json actually ships as the client entry', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.exports?.['./client'], './lib/client.js');
    assert.equal(pkg.dsh?.client?.platform, 'web');
  });
});
