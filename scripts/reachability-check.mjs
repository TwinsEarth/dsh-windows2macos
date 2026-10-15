#!/usr/bin/env node
/**
 * Find exports that only a test ever uses — the shape of a mechanism that was built and never wired.
 *
 * ## The defect class this exists for
 *
 * Three modules shipped in this span with **full suites and no caller**: `field-authority.mjs`,
 * `approval-gate.mjs`, and before them `createApprovalIndex`. Each was correct, each was tested, and each was
 * **indistinguishable from a finished feature** by reading either its tests or its source. `test/claims.test.mjs`
 * catches *documentation* drift and cannot catch this, because **the document and the code can agree while
 * neither is reachable.**
 *
 * `docs/1.0.0-ACCEPTANCE.md` §1.5 records that nothing measured it. This measures it.
 *
 * ## The signal, stated narrowly on purpose
 *
 * An export is reported when **the only files that mention it are tests**. That is deliberately not the same
 * as "unused":
 *
 *   * a symbol referenced by neither production nor tests is dead code, and a linter can say so;
 *   * **a symbol referenced only by tests is worse** — it looks maintained. There is a suite proving it works,
 *     so nothing about the repository suggests it does not run.
 *
 * The narrowness is the point. A check that reported every unreferenced export would drown its one useful
 * finding in re-exports, entry-point surfaces and deliberate public API, and would be turned off within a
 * week. **A check nobody keeps is worse than no check**, because it is cited as coverage.
 *
 * ## Why this is a REPORT and not a gate
 *
 * Measured against this repository it names **465 exports**, and **it cannot tell the three kinds apart**:
 *
 *   1. **the defect** — a mechanism built, tested, and never wired (`field-authority.mjs` in 0.29.0);
 *   2. **a deliberate surface** — the plugin's own entry points and the `export` a sibling re-exports;
 *   3. **composition** — a capability reachable only through another module's use of it.
 *
 * Only the first is a finding, and a static name check cannot separate them. So this exits **0** and prints,
 * because **a check that fails on 465 things nobody will fix is a check that gets disabled within a week** —
 * and a disabled check is worse than none, since it is cited as coverage. The tests below pin the one thing it
 * *is* reliable for: **a small synthetic tree where ground truth is known.**
 *
 * ## What it cannot see, said here rather than discovered later
 *
 * It matches imports, not call sites. An export imported by a production file and never called reads as
 * reachable here, which is a real limit and the reason the wording throughout is "referenced by" and never
 * "used by".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Directories whose files are the code under test. */
export const DEFAULT_SOURCE_DIRS = ['src', 'bin', 'scripts'];

/** Directories whose files are evidence about it, not users of it. */
export const DEFAULT_TEST_DIRS = ['test'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.test-fixtures', 'coverage']);

/** Every `.mjs`/`.js` file under the given directories, relative to `root`, with forward slashes. */
export function collectFiles(root, dirs) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js')) continue;
      found.push(relative(root, full).split('\\').join('/'));
    }
  };
  for (const dir of dirs) {
    const full = resolve(root, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(full);
  }
  return found.sort();
}

/**
 * The symbols a file exports.
 *
 * Handles the four declaration forms and `export { a, b as c }`. Deliberately does **not** follow
 * `export ... from` re-exports: a re-export is a statement about a surface, not a definition, and the
 * definition is found where it lives.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function exportedNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  // The capture stops at `}`, so `from` lands OUTSIDE it. The first version looked for ` from ` inside the
  // captured group and therefore never saw it -- `export { X } from './y.mjs'` was reported as a definition,
  // and the re-export test failed rather than the code being right. The `from` is matched after the brace.
  for (const m of text.matchAll(/^export\s*\{([^}]+)\}\s*(?:from\s*['"][^'"]+['"])?/gm)) {
    if (/\bfrom\b/.test(m[0].slice(m[0].indexOf('}')))) continue;
    for (const part of m[1].split(',')) {
      const raw = part.trim();
      if (raw === '') continue;
      const name = raw.split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Whether `text` mentions `name` as a whole word.
 *
 * Word boundaries matter: `cap` must not be satisfied by `capture`, or every short export would look wired.
 */
export function mentions(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text);
}

/**
 * The symbols a file imports from each module it names.
 *
 * ## Why this replaces name-matching, which failed loudly
 *
 * The first version asked "which files mention this name", and reported **378 findings** — almost all false.
 * The clearest was `deepEqual` from `src/relay/state.mjs`, which appeared to be named by **69 test files**:
 * every one of them was calling `assert.deepEqual`. Whole-word matching cannot tell an imported binding from
 * a coincidental name, and the check was unusable for exactly that reason.
 *
 * **An import is a statement about two things at once — a module and a name — so matching on the name alone
 * throws away half of what the source says.** This reads both.
 *
 * @param {string} text
 * @returns {Map<string, Set<string>>} module specifier -> imported names
 */
export function importedNames(text) {
  const byModule = new Map();
  const add = (spec, clause) => {
    const names = byModule.get(spec) ?? new Set();
    const body = clause.replace(/^\{|\}$/g, '');
    for (const part of body.split(',')) {
      const raw = part.trim();
      if (raw === '') continue;
      // `a as b` imports `a`; the local name is this file's business, not this check's.
      const name = raw.split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
    byModule.set(spec, names);
  };

  for (const m of text.matchAll(/import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2];
    const braced = clause.match(/\{([\s\S]*?)\}/);
    if (braced) add(spec, braced[1]);
    // A default import binds under its own name, which is also an imported name.
    const head = clause.split('{')[0].replace(/,\s*$/, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(head)) add(spec, head);
  }
  return byModule;
}

/**
 * Resolve a relative import specifier to a repo-relative file, the way Node would.
 *
 * Only relative specifiers are resolved: a bare specifier is a package, and this check is about this
 * repository's own files. An unresolvable relative path is returned as `null` and simply will not match.
 *
 * @param {string} fromFile repo-relative, forward slashes
 * @param {string} spec
 * @returns {string|null}
 */
export function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = dirname(fromFile).split('\\').join('/');
  const parts = (base === '.' ? [] : base.split('/')).concat(spec.split('/'));
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Which files import each export, split by whether they are evidence or users.
 *
 * @param {{root?: string, sourceDirs?: string[], testDirs?: string[]}} [options]
 * @returns {{exports: Array<object>, files: {source: number, test: number}}}
 */
export function analyse(options = {}) {
  const root = options.root ?? ROOT;
  const sourceFiles = collectFiles(root, options.sourceDirs ?? DEFAULT_SOURCE_DIRS);
  const testFiles = collectFiles(root, options.testDirs ?? DEFAULT_TEST_DIRS);

  const texts = new Map();
  const read = (file) => {
    if (!texts.has(file)) {
      try {
        texts.set(file, readFileSync(resolve(root, file), 'utf8'));
      } catch {
        texts.set(file, '');
      }
    }
    return texts.get(file);
  };

  // For every file, which (module, name) pairs it imports.
  const importers = new Map();
  for (const file of [...sourceFiles, ...testFiles]) {
    for (const [spec, names] of importedNames(read(file))) {
      const target = resolveSpecifier(file, spec);
      if (target === null) continue;
      for (const name of names) {
        const key = `${target}\u0000${name}`;
        const list = importers.get(key) ?? [];
        list.push(file);
        importers.set(key, list);
      }
    }
  }

  const findings = [];
  for (const file of sourceFiles) {
    for (const name of exportedNames(read(file))) {
      const from = importers.get(`${file}\u0000${name}`) ?? [];
      const inTest = from.filter((f) => testFiles.includes(f));
      const inSource = from.filter((f) => sourceFiles.includes(f));
      findings.push({
        file,
        name,
        imported_by_source: inSource,
        used_by_tests_only: inSource.length === 0 && inTest.length > 0,
        test_files: inTest,
      });
    }
  }
  return { exports: findings, files: { source: sourceFiles.length, test: testFiles.length } };
}

/**
 * The exports whose only mentions are in tests, worst first.
 *
 * Sorted by how much evidence exists about them, descending — an export named by six test files and no
 * production file is the most finished-looking thing that does not run, so it is listed first.
 *
 * @param {{exports: Array<object>}} analysis
 * @returns {Array<object>}
 */
export function testsOnly(analysis) {
  return analysis.exports
    .filter((e) => e.used_by_tests_only)
    .sort((a, b) => b.test_files.length - a.test_files.length || a.name.localeCompare(b.name));
}

/** Render the findings as text. Kept separate from the analysis so the analysis can be asserted on. */
export function report(analysis, findings) {
  const lines = [];
  lines.push(`source files : ${analysis.files.source}`);
  lines.push(`test files   : ${analysis.files.test}`);
  lines.push(`exports      : ${analysis.exports.length}`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('clean: every export is referenced by production code, not only by its tests');
    return lines.join('\n');
  }
  lines.push(`${findings.length} export(s) are referenced ONLY by tests -- built, tested, and never wired:`);
  for (const f of findings) {
    lines.push('');
    lines.push(`  ${f.file}`);
    lines.push(`    ${f.name}  (named in ${f.test_files.length} test file(s): ${f.test_files.slice(0, 3).join(', ')}${f.test_files.length > 3 ? ', …' : ''})`);
  }
  lines.push('');
  lines.push('An export used by nothing is dead code. One used only by its tests is WORSE: it looks maintained,');
  lines.push('and its suite proves it works while nothing shows whether it runs.');
  lines.push('');
  lines.push('READ THIS AS A LIST TO TRIAGE, NOT A LIST OF BUGS. It cannot separate a mechanism nobody wired from');
  lines.push('a deliberate public surface or a capability reachable through another module. Measured on this');
  lines.push('repository it names 465 exports, and it exits 0 for that reason.');
  return lines.join('\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const analysis = analyse();
  const findings = testsOnly(analysis);
  process.stdout.write(report(analysis, findings) + '\n');
  // ALWAYS 0. It cannot tell a defect from a public surface, and a gate that fails on 465 findings is a gate
  // that gets disabled -- after which it is cited as coverage. See the header.
  process.exit(0);
}
