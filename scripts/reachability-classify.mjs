/**
 * Classify the reachability report's findings, so the one real defect is not buried in 465 lines.
 *
 * ## The problem, stated as it was measured
 *
 * `scripts/reachability-check.mjs` reports exports that only test files import. Against this repository that is
 * **465 findings**, and most are not defects: a plugin's entry points are *supposed* to be imported only by
 * tests, and a capability reached through another module legitimately has no direct importer.
 *
 * **A list of 465 is a list nobody reads**, and the one real defect in it is invisible. Refining the regex
 * cannot fix that — the information is not in the name, it is in the **shape of the import graph**.
 *
 * ## What the shape actually tells you, learned from two known cases
 *
 * `field-authority.mjs` and `approval-gate.mjs` were each built, tested, and never wired. Both had the same
 * shape, and the shape is measurable without reading a single identifier:
 *
 *   * the module exports **exactly one** thing;
 *   * **one** test file imports it, and that file's name is the module's own name plus `.test.mjs`;
 *   * **no other source file** imports anything from that module.
 *
 * That is not a heuristic about naming. It is a statement about the graph: **a module with one export, one
 * importer, and that importer is its own test, exists in a closed loop.** Nothing in the program reaches it.
 * The name is only used to decide whether the loop is *closed*, which is a fact about the files rather than a
 * guess about intent.
 *
 * ## Why the other two classes are named rather than hidden
 *
 * A finding that is not `closed-loop` is still reported, under a class that says **why it is probably fine**
 * — `re-exported`, `same-module`, `unnamed`. Dropping them would make the report look clean while leaving a
 * reader unable to tell whether the check had looked. **The classes are the argument; the reader is meant to
 * disagree with them.**
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { analyse, collectFiles, importedNames, resolveSpecifier } from './reachability-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** What a finding's shape suggests. Only the first is a defect. */
export const CLASS = Object.freeze({
  CLOSED_LOOP: 'closed-loop',
  RE_EXPORTED: 're-exported',
  SAME_MODULE: 'same-module',
  SIBLING_IMPORTED: 'sibling-imported',
  UNNAMED: 'unnamed',
});

/** `src/agent/x.mjs` -> `x`, `y.test.mjs` -> `y`. Used only to ask whether a loop is closed. */
export function moduleStem(file) {
  return basename(file).replace(/\.test\.mjs$/, '').replace(/\.mjs$/, '').replace(/\.js$/, '');
}

/**
 * Classify one finding.
 *
 * @param {{file: string, name: string, test_files: string[]}} finding
 * @param {{importersOfModule: Map<string, string[]>, exportsPerFile: Map<string, number>}} graph
 * @returns {{class: string, detail: string}}
 */
export function classify(finding, graph) {
  const importers = graph.importersOfModule.get(finding.file) ?? [];
  const sourceImporters = importers.filter((f) => !f.startsWith('test/'));

  if (sourceImporters.length > 0) {
    // Somebody in the program imports FROM this module — just not this name. That is composition, and it is
    // the class that makes a name-level check untrustworthy on its own.
    return {
      class: CLASS.SIBLING_IMPORTED,
      detail: `${sourceImporters.length} source file(s) import from this module, so the name is reached through another export rather than directly`,
    };
  }

  const stem = moduleStem(finding.file);
  const namedAfterModule = finding.test_files.filter((t) => moduleStem(t) === stem);
  if (namedAfterModule.length > 0) {
    // A test file named after the module imports it and no source file does. The loop is closed: the suite is
    // the only thing in the repository that reaches this code.
    const others = finding.test_files.filter((t) => moduleStem(t) !== stem);
    return {
      class: CLASS.CLOSED_LOOP,
      detail:
        `the only importer is ${namedAfterModule[0]}, a test named after the module itself` +
        `${others.length > 0 ? `, and ${others.length} other test file(s)` : ''}` +
        `; no source file imports anything from ${finding.file}`,
    };
  }

  if ((graph.exportsPerFile.get(finding.file) ?? 0) > 1) {
    return {
      class: CLASS.SAME_MODULE,
      detail: `the module exports ${graph.exportsPerFile.get(finding.file)} things, so a test importing one may exercise the others through it`,
    };
  }

  return {
    class: CLASS.UNNAMED,
    detail: `${finding.test_files.length} test file(s) import it and none is named after the module, so the loop is not closed and the shape proves nothing`,
  };
}

/**
 * The import graph the classifier needs, plus every finding with its class.
 *
 * @param {{root?: string, sourceDirs?: string[], testDirs?: string[]}} [options]
 */
export function classifyAll(options = {}) {
  const root = options.root ?? ROOT;
  const analysis = analyse({ root, ...options });

  const sourceFiles = collectFiles(root, options.sourceDirs ?? ['src', 'bin', 'scripts']);
  const testFiles = collectFiles(root, options.testDirs ?? ['test']);
  const read = (file) => {
    try {
      return readFileSync(resolve(root, file), 'utf8');
    } catch {
      return '';
    }
  };

  // Which files import FROM each module, regardless of which name they take.
  const importersOfModule = new Map();
  for (const file of [...sourceFiles, ...testFiles]) {
    for (const spec of importedNames(read(file)).keys()) {
      const target = resolveSpecifier(file, spec);
      if (target === null) continue;
      const list = importersOfModule.get(target) ?? [];
      list.push(file);
      importersOfModule.set(target, list);
    }
  }

  const exportsPerFile = new Map();
  for (const e of analysis.exports) exportsPerFile.set(e.file, (exportsPerFile.get(e.file) ?? 0) + 1);

  const graph = { importersOfModule, exportsPerFile };
  const classified = analysis.exports
    .filter((e) => e.used_by_tests_only)
    .map((e) => ({ ...e, ...classify(e, graph) }));

  return { analysis, classified, graph };
}

/** Render the classification, closed loops first because they are the only ones that are findings. */
export function classifyReport(classified) {
  const byClass = new Map();
  for (const f of classified) {
    const list = byClass.get(f.class) ?? [];
    list.push(f);
    byClass.set(f.class, list);
  }
  const lines = [];
  lines.push(`tests-only exports : ${classified.length}`);
  for (const [name, list] of [...byClass].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${String(list.length).padStart(4)}  ${name}`);
  }
  lines.push('');

  const loops = byClass.get(CLASS.CLOSED_LOOP) ?? [];
  if (loops.length === 0) {
    lines.push('no closed loops: every module with a single-export test surface is also imported by source');
  } else {
    lines.push(`${loops.length} CLOSED LOOP(S) -- a module whose only importer is the test named after it:`);
    for (const f of loops) {
      lines.push('');
      lines.push(`  ${f.file}`);
      lines.push(`    ${f.name}  -- ${f.detail}`);
    }
  }
  lines.push('');
  lines.push('A closed loop is the shape this project shipped three times (field-authority, approval-gate,');
  lines.push('createApprovalIndex): built, tested, and reachable by nothing but its own suite. The other');
  lines.push('classes are named so a reader can disagree with them rather than having to trust a count.');
  return lines.join('\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { classified } = classifyAll();
  process.stdout.write(classifyReport(classified) + '\n');
  // Reported, never gated: the classification is an argument about shapes, and a shape can be argued with.
  process.exit(0);
}
