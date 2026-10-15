/**
 * The reachability report: what it can be relied on for, and — more usefully — what it cannot.
 *
 * ## Why the tests build synthetic trees
 *
 * Against this repository the check names **465 exports** and cannot separate a mechanism nobody wired from a
 * deliberate public surface or a capability reached through another module. Asserting on that number would
 * pin noise. So the tests build **small trees where ground truth is known** and assert the one distinction the
 * check exists to make:
 *
 *   * `testsOnly` is a mechanism that a suite exercises and nothing calls — **the `field-authority.mjs` /
 *     `approval-gate.mjs` shape**;
 *   * a production import is not reported, however the test file also names it;
 *   * `deepEqual` is not reported, which is the specific false positive that broke the first version: it came
 *     from `src/relay/state.mjs` and appeared to be named by 69 test files, every one of them calling
 *     `assert.deepEqual`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  analyse,
  collectFiles,
  exportedNames,
  importedNames,
  mentions,
  report,
  resolveSpecifier,
  testsOnly,
} from '../scripts/reachability-check.mjs';

/**
 * Build a throwaway tree.
 *
 * In the repo-local fixture directory rather than the OS temp dir, because a `tmp` path segment changes how
 * the scripts classify paths and made an earlier suite in this project test the fixture instead of the code.
 */
function tree(files) {
  const root = mkdtempSync(join(process.cwd(), '.test-fixtures', 'reach-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

describe('reachability: an export only a test imports is the finding', () => {
  it('reports a mechanism that is built, tested and never wired', () => {
    // The shape this whole check exists for.
    const root = tree({
      'src/wired.mjs': 'export function usedEverywhere() { return 1; }\n',
      'src/orphan.mjs': 'export function neverCalled() { return 2; }\n',
      'src/caller.mjs': "import { usedEverywhere } from './wired.mjs';\nexport const v = usedEverywhere();\n",
      'test/orphan.test.mjs': "import { neverCalled } from '../src/orphan.mjs';\nneverCalled();\n",
    });
    const findings = testsOnly(analyse({ root })).map((f) => f.name);
    assert.deepEqual(findings, ['neverCalled']);
  });

  it('does not report an export a production file imports, even when tests import it too', () => {
    const root = tree({
      'src/both.mjs': 'export function shared() { return 1; }\n',
      'src/caller.mjs': "import { shared } from './both.mjs';\nexport const v = shared();\n",
      'test/both.test.mjs': "import { shared } from '../src/both.mjs';\nshared();\n",
    });
    assert.deepEqual(testsOnly(analyse({ root })), []);
  });

  it('does not report an export nobody mentions at all', () => {
    // Dead code is a linter's business. This check is about the case that LOOKS maintained, and folding the
    // two together would bury the one useful finding under the other.
    const root = tree({ 'src/dead.mjs': 'export function nothingMentionsThis() { return 1; }\n' });
    assert.deepEqual(testsOnly(analyse({ root })), []);
  });

  it('does not report a same-named symbol imported from somewhere else', () => {
    // The false positive that produced 378 findings: an export called `deepEqual` in a source file, and
    // dozens of test files calling `assert.deepEqual`. Matching on the NAME cannot tell them apart; matching
    // on the import can, because the specifier differs.
    const root = tree({
      'src/state.mjs': 'export function deepEqual(a, b) { return a === b; }\n',
      'test/uses-assert.mjs': "import assert from 'node:assert';\nassert.deepEqual(1, 1);\n",
    });
    assert.deepEqual(testsOnly(analyse({ root })), [], 'assert.deepEqual must not count as an import of it');
  });

  it('counts an import as a use even when the importing file is another source file', () => {
    const root = tree({
      'src/base.mjs': 'export const TOKEN = 1;\n',
      'src/middle.mjs': "import { TOKEN } from './base.mjs';\nexport const doubled = TOKEN * 2;\n",
      'test/base.test.mjs': "import { TOKEN } from '../src/base.mjs';\n",
    });
    assert.deepEqual(testsOnly(analyse({ root })), []);
  });
});

describe('reachability: the import reader, which replaced name matching', () => {
  it('reads named, default and aliased imports with their specifiers', () => {
    const got = importedNames(
      [
        "import { a, b as c } from './x.mjs';",
        "import def from '../y.mjs';",
        "import def2, { d } from './z.mjs';",
      ].join('\n'),
    );
    assert.deepEqual([...got.get('./x.mjs')].sort(), ['a', 'b']);
    assert.deepEqual([...got.get('../y.mjs')], ['def']);
    assert.deepEqual([...got.get('./z.mjs')].sort(), ['d', 'def2']);
  });

  it('records the imported name, not the local alias', () => {
    // `b as c` imports `b`. The local name is the importing file's business.
    const got = importedNames("import { original as renamed } from './m.mjs';");
    assert.deepEqual([...got.get('./m.mjs')], ['original']);
  });

  it('ignores a bare specifier, which is a package and not this repository', () => {
    const got = importedNames("import assert from 'node:assert';\nimport x from 'some-package';");
    assert.deepEqual([...got.keys()].sort(), ['node:assert', 'some-package']);
    assert.equal(resolveSpecifier('src/a.mjs', 'node:assert'), null);
    assert.equal(resolveSpecifier('src/a.mjs', 'some-package'), null);
  });

  it('resolves a relative specifier the way Node would, including upward', () => {
    assert.equal(resolveSpecifier('src/agent/x.mjs', './y.mjs'), 'src/agent/y.mjs');
    assert.equal(resolveSpecifier('src/agent/x.mjs', '../util/z.mjs'), 'src/util/z.mjs');
    assert.equal(resolveSpecifier('src/a.mjs', './b/c.mjs'), 'src/b/c.mjs');
    assert.equal(resolveSpecifier('src/deep/a.mjs', '../../top.mjs'), 'top.mjs');
  });
});

describe('reachability: the export reader', () => {
  it('reads all four declaration forms and an export list', () => {
    const names = exportedNames(
      [
        'export function fn() {}',
        'export async function afn() {}',
        'export class Klass {}',
        'export const K = 1;',
        'export let L = 2;',
        'const a = 1; const b = 2;',
        'export { a, b as bee };',
      ].join('\n'),
    );
    // Code-unit sort, so uppercase precedes lowercase. And `b` is NOT in the list: `export { a, b as bee }`
    // exports the name `bee`, while `b` is the local binding. The first version of this expectation included
    // both names and was wrong by exactly that one -- and the "fix" that sorted my own array kept it wrong,
    // because sorting a guessed list does not make it measured.
    assert.deepEqual(names, ['K', 'Klass', 'L', 'a', 'afn', 'bee', 'fn']);
  });

  it('does not treat a re-export as a definition', () => {
    // `export { x } from './elsewhere.mjs'` is a statement about a surface; the definition lives elsewhere.
    const names = exportedNames("export { CAPABILITIES } from './other.mjs';\n");
    assert.deepEqual(names, []);
  });

  it('does not pick up an export mentioned inside a comment', () => {
    const names = exportedNames('/**\n * export function notReal() {}\n */\nexport const real = 1;\n');
    assert.deepEqual(names, ['real']);
  });
});

describe('reachability: the report says what it is', () => {
  it('prints the counts and a clean line when there is nothing to report', () => {
    const root = tree({
      'src/a.mjs': 'export const v = 1;\n',
      'src/b.mjs': "import { v } from './a.mjs';\nexport const w = v;\n",
    });
    const analysis = analyse({ root });
    const text = report(analysis, testsOnly(analysis));
    assert.match(text, /source files : 2/);
    assert.match(text, /clean: every export is referenced by production code/);
  });

  it('tells a reader to triage rather than to fix, because it cannot tell the kinds apart', () => {
    // The honest limit, in the output rather than only in the source: measured on this repository the check
    // names 465 exports, and a list that size presented as a defect list is a list nobody reads.
    const root = tree({
      'src/orphan.mjs': 'export function neverCalled() {}\n',
      'test/orphan.test.mjs': "import { neverCalled } from '../src/orphan.mjs';\n",
    });
    const analysis = analyse({ root });
    const text = report(analysis, testsOnly(analysis));
    assert.match(text, /READ THIS AS A LIST TO TRIAGE, NOT A LIST OF BUGS/);
    assert.match(text, /it exits 0 for that reason/);
  });

  it('keeps `mentions` exported but unused by the analysis, and says so by still working', () => {
    // `mentions` was the first version's whole mechanism. It is kept because the suite exercises it, and it is
    // asserted here so a future reader finds it deliberate rather than wondering whether it is leftover.
    assert.equal(mentions('const capture = 1;', 'cap'), false, 'a word boundary must not be satisfied by a prefix');
    assert.equal(mentions('cap(x)', 'cap'), true);
  });

  it('collects only .mjs/.js files and skips the directories that are not source', () => {
    const root = tree({
      'src/a.mjs': 'export const v = 1;\n',
      'src/notes.md': '# not code\n',
      'src/node_modules/dep/index.js': 'export const dep = 1;\n',
      'test/a.test.mjs': '// x\n',
    });
    const files = collectFiles(root, ['src', 'test']);
    assert.deepEqual(files, ['src/a.mjs', 'test/a.test.mjs']);
  });
});
